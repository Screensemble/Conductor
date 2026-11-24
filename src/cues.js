import { Router } from 'express';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  deadlineFor,
  livePerformerIds,
  performerOnline,
  probeClock,
  sendToPerformer,
} from './performers.js';
import { registry } from './registry.js';
import { resolveTargets } from './collections.js';
import { syncPlaylist } from './playlists.js';
import { armWaitLoop, waitLoopTargets } from './waitloop.js';

export const cueRouter = Router();

// Hardware cues (ESP32 buttons, door sensors, show control). The device
// POSTs /api/cues/:id; EVERYTHING else — mapping, debounce, cooldown,
// retrigger policy — is decided here in data/cues.json, never in the
// device firmware (spec 5.1):
//
//   {
//     "gallery-door": {
//       "action": "prepare" | "perform" | "sync" | "play_item" | "stop"
//               | "pause" | "resume" | "next" | "prev" | "exit_ui"
//               | "restart" | "reboot",
//       "item": "promo.mp4",            // required for play_item
//       "performers": ["hw-…"],         // default: all connected ("players" accepted)
//       "cooldown_ms": 30000,           // ignore repeat fires inside this
//       "retrigger": "ignore" | "restart" | "queue",  // re-fire policy
//       "lead_ms": 500                  // sync release lead
//     }
//   }
//
// retrigger policy while the cue's show is already running:
//   ignore  — drop the fire (default, kiosk-safe)
//   restart — prepare+perform again immediately
//   queue   — run again when the current release finishes its cooldown

const FILE = join(process.cwd(), 'data', 'cues.json');
const LEGACY = join(process.cwd(), 'data', 'triggers.json');
let map = {};
try { map = JSON.parse(readFileSync(FILE, 'utf8')); } catch {
  try {
    map = JSON.parse(readFileSync(LEGACY, 'utf8'));
    saveMap();
    console.log('migrated triggers.json -> cues.json');
  } catch { /* no map yet */ }
}

function saveMap() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(map, null, 2));
}

const fired = new Map();      // cue_id -> last fire epoch ms
const queued = new Map();     // cue_id -> true while a run is in flight

cueRouter.get('/', (_req, res) => {
  res.json({ cues: map });
});

cueRouter.put('/:cue_id', (req, res) => {
  const t = req.body ?? {};
  // Legacy config keys are normalized: arm->prepare, go->perform,
  // players->performers — stored form is always the new vocabulary.
  const action = { arm: 'prepare', go: 'perform' }[t.action] ?? t.action;
  if (!ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action must be ${ACTIONS.join('|')}` });
  }
  map[req.params.cue_id] = {
    action,
    ...(Array.isArray(t.performers ?? t.players)
      ? { performers: t.performers ?? t.players } : {}),
    ...(t.item ? { item: String(t.item).slice(0, 200) } : {}),
    cooldown_ms: Math.max(Number(t.cooldown_ms) || 0, 0),
    retrigger: ['ignore', 'restart', 'queue'].includes(t.retrigger)
      ? t.retrigger : 'ignore',
    lead_ms: Math.min(Math.max(Number(t.lead_ms) || 500, 0), 30_000),
  };
  saveMap();
  res.json({ ok: true, cue: map[req.params.cue_id] });
});

cueRouter.delete('/:cue_id', (req, res) => {
  if (!delete map[req.params.cue_id]) {
    return res.status(404).json({ error: 'unknown cue' });
  }
  saveMap();
  res.json({ ok: true });
});

// Shared by /api/cues and the automations engine — everything a trigger
// can make displays do, orchestrated or not.
export const ACTIONS = [
  'prepare', 'perform', 'sync',           // orchestrated release
  'play_item', 'stop', 'pause',           // direct playback control
  'resume', 'next', 'prev', 'exit_ui',
  'restart', 'reboot',                    // playlist reload / box reboot
  'playlist',                             // apply a named playlist
];

async function runCue(id, def) {
  const action = { arm: 'prepare', go: 'perform' }[def.action] ?? def.action;
  // Target ids may name collections as well as displays — resolveTargets
  // expands members and dedupes a display reachable through two paths.
  const targets = Array.isArray(def.performers ?? def.players)
    ? resolveTargets(def.performers ?? def.players)
      .filter((p) => livePerformerIds().includes(p))
    : livePerformerIds();
  // Wait-loop ensembles among the named collections — their members get
  // the loop_wait flag so each pass end re-arms for the next release.
  const waitCols = Array.isArray(def.performers ?? def.players)
    ? waitLoopTargets(def.performers ?? def.players)
    : [];
  const waitMembers = new Set(waitCols.flatMap((c) => c.members));

  // Playlist apply — push + reorder via syncPlaylist. An explicit target
  // list overrides the playlist's own members; empty falls back to them.
  if (action === 'playlist') {
    if (!def.item) return { delivered: 0, note: 'playlist needs a playlist name' };
    const explicit = Array.isArray(def.performers ?? def.players)
      && (def.performers ?? def.players).length
      ? resolveTargets(def.performers ?? def.players)
      : null;
    const r = await syncPlaylist(def.item, { targets: explicit });
    return {
      delivered: r.error ? 0 : Object.keys(r).length,
      ...(r.error ? { error: r.error } : { results: r }),
    };
  }
  if (!targets.length) return { delivered: 0, note: 'no performers online' };

  // Direct (non-orchestrated) commands — no clock work needed.
  if (['stop', 'resume', 'restart', 'reboot', 'play_item',
       'pause', 'next', 'prev', 'exit_ui'].includes(action)) {
    const cmd = { type: 'command', cmd: action };
    if (action === 'play_item') {
      if (!def.item) return { delivered: 0, note: 'play_item needs an item name' };
      cmd.name = def.item;
    }
    targets.forEach((p) => sendToPerformer(p, cmd));
    return { delivered: targets.length };
  }
  if (action === 'prepare') {
    await Promise.allSettled(targets.map((p) => probeClock(p)));
    targets.forEach((p) => sendToPerformer(p, {
      type: 'command',
      cmd: 'prepare',
      loop_wait: waitMembers.has(p),
    }));
    return { delivered: targets.length, staged: true };
  }
  // perform / sync — synchronized release on one deadline in every
  // display's own clock domain. 'perform' alone releases a prepared set;
  // 'sync' prepares first.
  await Promise.allSettled(targets.map((p) => probeClock(p)));
  if (action === 'sync') {
    targets.forEach((p) => sendToPerformer(p, {
      type: 'command',
      cmd: 'prepare',
      loop_wait: waitMembers.has(p),
    }));
    await new Promise((r) => setTimeout(r, 1500)); // let displays stage
  }
  const results = {};
  for (const p of targets) {
    const st = registry.performers.get(p)?.status;
    const prepared = st?.prepared ?? st?.armed;
    if (!performerOnline(p) || (action === 'perform' && !prepared)) {
      results[p] = { released: false, reason: prepared ? 'offline' : 'not prepared' };
      continue;
    }
    const at = deadlineFor(p, def.lead_ms);
    results[p] = at === null
      ? { released: false, reason: 'no clock sample' }
      : { released: sendToPerformer(p, {
          type: 'command',
          cmd: 'perform',
          at_mono: at,
          loop_wait: waitMembers.has(p),
        }) };
  }
  // Arm a wait-loop barrier for each wait-loop ensemble named in the
  // targets — only members that actually released join the round.
  for (const col of waitCols) {
    const released = col.members.filter((m) => results[m]?.released);
    if (released.length) {
      armWaitLoop(col.id, released, {
        lead_ms: def.lead_ms,
        policy: def.policy,
        min_ready: def.min_ready,
      });
    }
  }
  return { delivered: Object.values(results).filter((r) => r.released).length, results };
}

// Shared fire path — cooldown + retrigger policy, then the action. Used
// by the cue route and by every automation trigger source. Returns a
// result object; callers translate it to HTTP status if they have one.
export function fireCue(id, def) {
  const now = Date.now();
  const last = fired.get(id) ?? 0;
  if (def.cooldown_ms && now - last < def.cooldown_ms) {
    // Debounce + retrigger policy: inside the cooldown a fire is dropped,
    // unless the cue is configured to queue one run for later.
    if (def.retrigger === 'queue' && !queued.get(id)) {
      queued.set(id, true);
      setTimeout(async () => {
        queued.delete(id);
        fired.set(id, Date.now());
        await runCue(id, def);
      }, def.cooldown_ms - (now - last));
      return { accepted: true, queued: true };
    }
    return {
      accepted: false,
      reason: 'cooldown',
      retry_in_ms: def.cooldown_ms - (now - last),
    };
  }
  fired.set(id, now);
  return runCue(id, def).then((r) => ({ accepted: true, ...r }));
}

cueRouter.post('/:cue_id', (req, res) => {
  const id = req.params.cue_id;
  const def = map[id];
  if (!def) return res.status(404).json({ error: 'unmapped cue' });
  Promise.resolve(fireCue(id, def))
    .then((r) =>
      res.status(r.accepted ? 202 : 429).json(r),
    )
    .catch((e) => res.status(500).json({ error: e.message }));
});
