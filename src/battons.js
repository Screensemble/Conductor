import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fireBattonEvent } from './automations.js';
import { passwordChangePending } from './auth.js';

export const battonsPublicRouter = Router();  // offer/poll — pre-credentials
export const battonDeviceRouter = Router();   // heartbeat/event — bearer token
export const battonsRouter = Router();        // management — session-gated

// Screensemble Batton registry — data/battons.json. A batton is an ESP32
// cue device: it offers itself for pairing, an operator approves it in
// the dashboard, and from then on it heartbeats in and POSTs pin events.
// Pin→action mapping lives in automations.json, never on the device.
//
//   "btn-…": {
//     "name": "Lobby panel",
//     "hardware_id": "aa:bb:cc:dd:ee:ff",
//     "token": "btk-…",
//     "inputs": [{ "id": "door", "pin": 13, "edge": "low" }],
//     "version": "0.1.0", "client_url": "http://192.168.0.50",
//     "paired_at": …, "last_seen": …
//   }

const FILE = join(process.cwd(), 'data', 'battons.json');
const ONLINE_MS = 150_000; // heartbeat cadence is 60s — 2.5× grace
let map = {};
try { map = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* none yet */ }

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(map, null, 2));
}

export const battons = {
  get: (id) => map[id],
  list: () => Object.values(map).map(publicBatton),
};

function publicBatton({ token, ...b }) {
  return { ...b, online: b.last_seen && Date.now() - Date.parse(b.last_seen) < ONLINE_MS };
}

// Offers awaiting a dashboard decision. Keyed by a random pair id the
// batton polls with — never the hardware id (spoofable).
const pending = new Map();
const PENDING_TTL = 10 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - PENDING_TTL;
  for (const [id, o] of pending) if (o.at < cutoff) pending.delete(id);
}, 60_000).unref();

function normalizeInputs(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 16).map((i) => ({
    id: String(i.id || `pin-${i.pin}`).slice(0, 40),
    pin: Number(i.pin) || 0,
    edge: i.edge === 'high' ? 'high' : 'low',
  })).filter((i) => i.pin > 0);
}

function battonTokenOk(req, id) {
  const b = map[id];
  if (!b) return false;
  return req.headers.authorization === `Bearer ${b.token}`;
}

// -- Pairing (open; a batton holds no credentials yet) ---------------------

battonsPublicRouter.post('/offer', (req, res) => {
  if (passwordChangePending()) {
    return res.status(428).json({
      error: 'conductor setup incomplete — change the admin password first',
    });
  }
  const { name, hardware_id, inputs, version, client_url } = req.body ?? {};
  if (!hardware_id) return res.status(400).json({ error: 'hardware_id required' });
  // A re-offer from an already-paired device rebinds to its record —
  // same hardware, no duplicate (mirrors performer pairing).
  const existing = Object.entries(map).find(([, b]) => b.hardware_id === hardware_id);
  if (existing) {
    const [id, b] = existing;
    return res.status(200).json({ pair_id: `rebind:${id}`, batton_id: id });
  }
  const pairId = `bpr-${randomBytes(8).toString('hex')}`;
  pending.set(pairId, {
    name: String(name || 'Batton').slice(0, 100),
    hardware_id: String(hardware_id).slice(0, 40),
    inputs: normalizeInputs(inputs),
    version: String(version || '').slice(0, 20),
    client_url: String(client_url || '').slice(0, 200),
    at: Date.now(),
  });
  console.log(`batton pair offer: ${name || hardware_id}`);
  res.status(202).json({ pair_id: pairId });
});

// The batton polls with its pair id until the dashboard decides.
battonsPublicRouter.get('/poll', (req, res) => {
  const pid = String(req.query.pair_id || '');
  if (pid.startsWith('rebind:')) {
    const b = map[pid.slice(7)];
    return b
      ? res.json({ status: 'approved', batton_id: b.id, token: b.token })
      : res.status(404).json({ status: 'unknown' });
  }
  const o = pending.get(pid);
  if (!o) return res.json({ status: 'expired' });
  if (o.denied) { pending.delete(pid); return res.json({ status: 'denied' }); }
  if (!o.approved) return res.json({ status: 'pending' });
  pending.delete(pid);
  res.json({ status: 'approved', batton_id: o.approved, token: map[o.approved]?.token });
});

// -- Device endpoints (bearer token, checked per-batton) -------------------

battonDeviceRouter.post('/:id/heartbeat', (req, res) => {
  const b = map[req.params.id];
  if (!b) return res.status(404).json({ error: 'unknown batton' });
  if (!battonTokenOk(req, b.id)) {
    return res.status(401).json({ error: 'batton authentication required' });
  }
  if (Array.isArray(req.body?.inputs)) b.inputs = normalizeInputs(req.body.inputs);
  if (req.body?.version) b.version = String(req.body.version).slice(0, 20);
  if (req.body?.client_url) b.client_url = String(req.body.client_url).slice(0, 200);
  b.last_seen = new Date().toISOString();
  b.ip = req.ip;
  save();
  res.json({ ok: true });
});

// A pin went active — route it to the automations bound to this input.
battonDeviceRouter.post('/:id/event', async (req, res) => {
  const b = map[req.params.id];
  if (!b) return res.status(404).json({ error: 'unknown batton' });
  if (!battonTokenOk(req, b.id)) {
    return res.status(401).json({ error: 'batton authentication required' });
  }
  const input = String(req.body?.input || '').slice(0, 40);
  if (!input) return res.status(400).json({ error: 'input required' });
  b.last_seen = new Date().toISOString();
  save();
  try {
    const results = await fireBattonEvent(b.id, input);
    res.status(202).json({ accepted: true, input, fired: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -- Management (session-gated) --------------------------------------------

battonsRouter.get('/', (_req, res) => {
  res.json({
    battons: Object.values(map).map(publicBatton),
    pending: [...pending.entries()].map(([id, o]) => ({ pair_id: id, ...o })),
  });
});

battonsRouter.post('/pending/:pair_id/approve', (req, res) => {
  const o = pending.get(req.params.pair_id);
  if (!o) return res.status(404).json({ error: 'unknown or expired offer' });
  const id = `btn-${randomBytes(5).toString('hex')}`;
  map[id] = {
    id,
    name: String(req.body?.name || o.name).slice(0, 100),
    hardware_id: o.hardware_id,
    token: `btk-${randomBytes(16).toString('hex')}`,
    inputs: o.inputs,
    version: o.version,
    client_url: o.client_url,
    paired_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    ip: null,
  };
  o.approved = id;
  save();
  console.log(`batton paired: ${o.name || id} (${id})`);
  res.json({ ok: true, batton: publicBatton(map[id]) });
});

battonsRouter.post('/pending/:pair_id/deny', (req, res) => {
  const o = pending.get(req.params.pair_id);
  if (!o) return res.status(404).json({ error: 'unknown or expired offer' });
  o.denied = true;
  res.json({ ok: true });
});

battonsRouter.post('/:id/rename', (req, res) => {
  const b = map[req.params.id];
  if (!b) return res.status(404).json({ error: 'unknown batton' });
  const name = String(req.body?.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'name required' });
  b.name = name;
  save();
  res.json({ ok: true, batton: publicBatton(b) });
});

battonsRouter.delete('/:id', (req, res) => {
  if (!delete map[req.params.id]) {
    return res.status(404).json({ error: 'unknown batton' });
  }
  save();
  res.json({ ok: true });
});
