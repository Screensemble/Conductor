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

export const cueRouter = Router();

// Hardware cues (ESP32 buttons, door sensors, show control). The device
// POSTs /api/cues/:id; EVERYTHING else — mapping, debounce, cooldown,
// retrigger policy — is decided here in data/cues.json, never in the
// device firmware (spec 5.1):
//
//   {
//     "gallery-door": {
//       "action": "prepare" | "perform" | "sync" | "restart",
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
  if (!['prepare', 'perform', 'sync', 'restart'].includes(action)) {
    return res.status(400).json({ error: 'action must be prepare|perform|sync|restart' });
  }
  map[req.params.cue_id] = {
    action,
    ...(Array.isArray(t.performers ?? t.players)
      ? { performers: t.performers ?? t.players } : {}),
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

async function runCue(id, def) {
  const action = { arm: 'prepare', go: 'perform' }[def.action] ?? def.action;
  const targets = Array.isArray(def.performers ?? def.players)
    ? (def.performers ?? def.players).filter((p) => livePerformerIds().includes(p))
    : livePerformerIds();
  if (!targets.length) return { delivered: 0, note: 'no performers online' };

  if (action === 'restart') {
    targets.forEach((p) => sendToPerformer(p, { type: 'command', cmd: 'restart' }));
    return { delivered: targets.length };
  }
  if (action === 'prepare') {
    await Promise.allSettled(targets.map((p) => probeClock(p)));
    targets.forEach((p) => sendToPerformer(p, { type: 'command', cmd: 'prepare' }));
    return { delivered: targets.length, staged: true };
  }
  // perform / sync — synchronized release on one deadline in every
  // display's own clock domain. 'perform' alone releases a prepared set;
  // 'sync' prepares first.
  await Promise.allSettled(targets.map((p) => probeClock(p)));
  if (action === 'sync') {
    targets.forEach((p) => sendToPerformer(p, { type: 'command', cmd: 'prepare' }));
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
      : { released: sendToPerformer(p, { type: 'command', cmd: 'perform', at_mono: at }) };
  }
  return { delivered: Object.values(results).filter((r) => r.released).length, results };
}

cueRouter.post('/:cue_id', (req, res) => {
  const id = req.params.cue_id;
  const def = map[id];
  if (!def) return res.status(404).json({ error: 'unmapped cue' });

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
      return res.status(202).json({ accepted: true, queued: true });
    }
    return res.status(429).json({
      accepted: false,
      reason: 'cooldown',
      retry_in_ms: def.cooldown_ms - (now - last),
    });
  }
  fired.set(id, now);
  runTrigger(id, def)
    .then((r) => res.status(202).json({ accepted: true, ...r }))
    .catch((e) => res.status(500).json({ error: e.message }));
});
