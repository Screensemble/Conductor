import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ACTIONS, fireCue } from './cues.js';

export const automationsRouter = Router();
export const hooksRouter = Router();

// IFTTT-style bindings: WHEN a trigger source fires, THEN run a cue-style
// action on displays. Stored in data/automations.json:
//
//   "auto-…": {
//     "name": "Door opens the show",
//     "enabled": true,
//     "when": { "type": "batton", "batton_id": "btn-…", "input": "door" }
//           | { "type": "webhook", "key": "whk-…" }
//           | { "type": "schedule", "time": "09:00",
//               "date": "2026-11-27"?, "days": [0,1,2]? },
//     "then": { "action": "sync", "performers": ["hw-…"], "item": "…" },
//     "cooldown_ms": 30000, "retrigger": "ignore" | "restart" | "queue",
//     "lead_ms": 500
//   }
//
// Webhook automations are fired by POST /api/hooks/<key> — the key is a
// random URL credential (unguessable), so no session is needed. That is
// the only credential a webhook caller gets; keep keys out of responses
// where possible (the UI is session-gated anyway).
//
// Batton automations fire from batton pin events routed through
// /api/battons/:id/event — see battons.js.

const FILE = join(process.cwd(), 'data', 'automations.json');
let map = {};
try { map = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* none yet */ }

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(map, null, 2));
}

function validateWhen(w) {
  if (!w || typeof w !== 'object') return null;
  if (w.type === 'batton') {
    if (!w.batton_id || !w.input) return null;
    return {
      type: 'batton',
      batton_id: String(w.batton_id).slice(0, 60),
      input: String(w.input).slice(0, 60),
    };
  }
  if (w.type === 'webhook') {
    return { type: 'webhook', key: w.key || `whk-${randomBytes(12).toString('hex')}` };
  }
  if (w.type === 'schedule') {
    // { time: "HH:MM" } required; { date: "YYYY-MM-DD" } = one-shot on
    // that day (auto-disables after firing); { days: [0..6] } (0=Mon) =
    // weekly recurring; neither = daily.
    const time = String(w.time || '');
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) return null;
    const out = { type: 'schedule', time };
    if (w.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(w.date))) return null;
      out.date = String(w.date);
    }
    if (Array.isArray(w.days)) {
      out.days = w.days
        .map(Number)
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    }
    return out;
  }
  return null;
}

function validateThen(t) {
  const action = { arm: 'prepare', go: 'perform' }[t?.action] ?? t?.action;
  if (!ACTIONS.includes(action)) return null;
  const out = { action };
  if (Array.isArray(t?.performers ?? t?.players)) {
    out.performers = (t.performers ?? t.players).map(String).slice(0, 50);
  }
  if (t?.item) out.item = String(t.item).slice(0, 200);
  return out;
}

function normalize(id, body) {
  const when = validateWhen(body?.when);
  const then = validateThen(body?.then);
  if (!when || !then) return null;
  return {
    name: String(body?.name || id).slice(0, 100),
    enabled: body?.enabled !== false,
    when,
    then,
    cooldown_ms: Math.max(Number(body?.cooldown_ms) || 0, 0),
    retrigger: ['ignore', 'restart', 'queue'].includes(body?.retrigger)
      ? body.retrigger : 'ignore',
    lead_ms: Math.min(Math.max(Number(body?.lead_ms) || 500, 0), 30_000),
  };
}

// -- Fire entry points ----------------------------------------------------

async function fireAutomation(id, auto) {
  if (auto.enabled === false) return { id, accepted: false, reason: 'disabled' };
  const def = { ...auto.then, cooldown_ms: auto.cooldown_ms, retrigger: auto.retrigger, lead_ms: auto.lead_ms };
  const r = await fireCue(`auto:${id}`, def);
  return { id, ...r };
}

// A batton pin went active — fire every automation bound to that input.
export async function fireBattonEvent(battonId, inputId) {
  const results = [];
  for (const [id, auto] of Object.entries(map)) {
    const w = auto.when;
    if (w?.type === 'batton' && w.batton_id === battonId &&
        (w.input === inputId || w.input === '*')) {
      results.push(await fireAutomation(id, auto));
    }
  }
  return results;
}

// -- Webhook endpoint (public; key IS the credential) ---------------------

// -- Schedule triggers ------------------------------------------------------
// A 30s tick compares each schedule automation's date/days/time against
// the local clock and fires once per matching minute. One-shot `date`
// automations disable themselves after firing so they can't re-run next
// year; `days` (or bare daily) ones fire every matching day.

const firedSlots = new Map(); // auto id -> last fired "YYYY-MM-DD HH:MM"

function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function scheduleDue(w, now) {
  const stamp = localStamp(now);
  const [dateStr, hm] = stamp.split(' ');
  if (w.date && w.date !== dateStr) return false;
  if (w.days && w.days.length && !w.days.includes((now.getDay() + 6) % 7)) {
    return false;
  }
  return hm === w.time;
}

export function startScheduler(everyMs = 30_000) {
  const t = setInterval(async () => {
    const now = new Date();
    for (const [id, auto] of Object.entries(map)) {
      const w = auto.when;
      if (w?.type !== 'schedule' || auto.enabled === false) continue;
      if (!scheduleDue(w, now)) continue;
      const stamp = localStamp(now);
      if (firedSlots.get(id) === stamp) continue;
      firedSlots.set(id, stamp);
      console.log(`schedule fire: ${id} (${auto.name}) at ${stamp}`);
      try {
        await fireAutomation(id, auto);
      } catch (e) {
        console.log(`schedule fire failed ${id}: ${e.message}`);
      }
      if (w.date) {
        auto.enabled = false;
        save();
      }
    }
  }, everyMs);
  t.unref?.();
  return t;
}

hooksRouter.post('/:key', async (req, res) => {
  const results = [];
  let found = false;
  for (const [id, auto] of Object.entries(map)) {
    if (auto.when?.type === 'webhook' && auto.when.key === req.params.key) {
      found = true;
      results.push(await fireAutomation(id, auto));
    }
  }
  if (!found) return res.status(404).json({ error: 'unknown hook' });
  res.status(202).json({ accepted: true, results });
});

// -- Management (session-gated; mounted after the guard) ------------------

automationsRouter.get('/', (_req, res) => {
  res.json({ automations: map });
});

automationsRouter.post('/', (req, res) => {
  const id = `auto-${randomBytes(6).toString('hex')}`;
  const auto = normalize(id, req.body ?? {});
  if (!auto) return res.status(400).json({ error: 'invalid when/then' });
  // No two automations share a webhook key.
  if (auto.when.type === 'webhook') {
    for (const other of Object.values(map)) {
      if (other.when?.key === auto.when.key) {
        auto.when.key = `whk-${randomBytes(12).toString('hex')}`;
        break;
      }
    }
  }
  map[id] = auto;
  save();
  res.status(201).json({ id, automation: auto });
});

automationsRouter.put('/:id', (req, res) => {
  if (!map[req.params.id]) return res.status(404).json({ error: 'unknown automation' });
  const auto = normalize(req.params.id, req.body ?? {});
  if (!auto) return res.status(400).json({ error: 'invalid when/then' });
  // Preserve an existing webhook key unless the caller rotates it.
  if (auto.when.type === 'webhook' && !req.body?.when?.key) {
    const prev = map[req.params.id].when?.key;
    if (prev) auto.when.key = prev;
  }
  map[req.params.id] = auto;
  save();
  res.json({ ok: true, automation: auto });
});

automationsRouter.delete('/:id', (req, res) => {
  if (!delete map[req.params.id]) {
    return res.status(404).json({ error: 'unknown automation' });
  }
  save();
  res.json({ ok: true });
});

// Test-fire an automation from the editor.
automationsRouter.post('/:id/fire', async (req, res) => {
  const auto = map[req.params.id];
  if (!auto) return res.status(404).json({ error: 'unknown automation' });
  try {
    res.json(await fireAutomation(req.params.id, auto));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
