import { Router } from 'express';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  deadlineFor,
  livePlayerIds,
  playerOnline,
  probeClock,
  sendToPlayer,
} from './players.js';
import { registry } from './registry.js';

export const triggerRouter = Router();

// Hardware triggers (ESP32 buttons, door sensors, show control). The device
// POSTs /api/triggers/:id; EVERYTHING else — mapping, debounce, cooldown,
// retrigger policy — is decided here in data/triggers.json, never in the
// device firmware (spec 5.1):
//
//   {
//     "door-left": {
//       "action": "arm" | "go" | "sync" | "restart",
//       "players": ["hw-…"],            // default: all connected
//       "cooldown_ms": 30000,           // ignore repeat fires inside this
//       "retrigger": "ignore" | "restart" | "queue",
//       "lead_ms": 500                  // sync release lead
//     }
//   }
//
// retrigger policy while the trigger's show is already running:
//   ignore  — drop the fire (default, kiosk-safe)
//   restart — arm+go again immediately
//   queue   — run again when the current release finishes its cooldown

const FILE = join(process.cwd(), 'data', 'triggers.json');
let map = {};
try { map = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* no map yet */ }

function saveMap() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(map, null, 2));
}

const fired = new Map();      // trigger_id -> last fire epoch ms
const queued = new Map();     // trigger_id -> true while a run is in flight

triggerRouter.get('/', (_req, res) => {
  res.json({ triggers: map });
});

triggerRouter.put('/:trigger_id', (req, res) => {
  const t = req.body ?? {};
  if (!['arm', 'go', 'sync', 'restart'].includes(t.action)) {
    return res.status(400).json({ error: 'action must be arm|go|sync|restart' });
  }
  map[req.params.trigger_id] = {
    action: t.action,
    ...(Array.isArray(t.players) ? { players: t.players } : {}),
    cooldown_ms: Math.max(Number(t.cooldown_ms) || 0, 0),
    retrigger: ['ignore', 'restart', 'queue'].includes(t.retrigger)
      ? t.retrigger : 'ignore',
    lead_ms: Math.min(Math.max(Number(t.lead_ms) || 500, 0), 30_000),
  };
  saveMap();
  res.json({ ok: true, trigger: map[req.params.trigger_id] });
});

triggerRouter.delete('/:trigger_id', (req, res) => {
  if (!delete map[req.params.trigger_id]) {
    return res.status(404).json({ error: 'unknown trigger' });
  }
  saveMap();
  res.json({ ok: true });
});

async function runTrigger(id, def) {
  const targets = Array.isArray(def.players)
    ? def.players.filter((p) => livePlayerIds().includes(p))
    : livePlayerIds();
  if (!targets.length) return { delivered: 0, note: 'no players online' };

  if (def.action === 'restart') {
    targets.forEach((p) => sendToPlayer(p, { type: 'command', cmd: 'restart' }));
    return { delivered: targets.length };
  }
  if (def.action === 'arm') {
    await Promise.allSettled(targets.map((p) => probeClock(p)));
    targets.forEach((p) => sendToPlayer(p, { type: 'command', cmd: 'arm' }));
    return { delivered: targets.length, staged: true };
  }
  // go / sync — synchronized release on one deadline in every display's own
  // clock domain. 'go' alone releases an existing arm; 'sync' arms first.
  await Promise.allSettled(targets.map((p) => probeClock(p)));
  if (def.action === 'sync') {
    targets.forEach((p) => sendToPlayer(p, { type: 'command', cmd: 'arm' }));
    await new Promise((r) => setTimeout(r, 1500)); // let displays stage
  }
  const results = {};
  for (const p of targets) {
    const armed = registry.players.get(p)?.status?.armed;
    if (!playerOnline(p) || (def.action === 'go' && !armed)) {
      results[p] = { released: false, reason: armed ? 'offline' : 'not armed' };
      continue;
    }
    const at = deadlineFor(p, def.lead_ms);
    results[p] = at === null
      ? { released: false, reason: 'no clock sample' }
      : { released: sendToPlayer(p, { type: 'command', cmd: 'go', at_mono: at }) };
  }
  return { delivered: Object.values(results).filter((r) => r.released).length, results };
}

triggerRouter.post('/:trigger_id', (req, res) => {
  const id = req.params.trigger_id;
  const def = map[id];
  if (!def) return res.status(404).json({ error: 'unmapped trigger' });

  const now = Date.now();
  const last = fired.get(id) ?? 0;
  if (def.cooldown_ms && now - last < def.cooldown_ms) {
    // Debounce + retrigger policy: inside the cooldown a fire is dropped,
    // unless the trigger is configured to queue one run for later.
    if (def.retrigger === 'queue' && !queued.get(id)) {
      queued.set(id, true);
      setTimeout(async () => {
        queued.delete(id);
        fired.set(id, Date.now());
        await runTrigger(id, def);
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
