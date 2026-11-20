import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { registry } from './registry.js';

// Pairing handshake (spec: enrollment). The display pushes its identity here
// during a QR pair offer; the server gates it BEFORE the TV is ever asked.
// Flow: POST /request (client info) -> on-TV confirm -> POST /accept or
// /decline. Pending offers expire after PAIR_TTL.
export const pairingRouter = Router();
export const players = registry.players;  // registered players (persisted)
const pending = new Map();                // pairing_id -> offer awaiting TV confirm
const PAIR_TTL = 10 * 60 * 1000;

function vtuple(v) {
  return String(v ?? '')
    .split('.')
    .map((p) => parseInt(p, 10) || 0);
}

function versionAtLeast(have, need) {
  const h = vtuple(have);
  const n = vtuple(need);
  const len = Math.max(h.length, n.length);
  for (let i = 0; i < len; i++) {
    const a = h[i] ?? 0;
    const b = n[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function sweep() {
  const now = Date.now();
  for (const [id, p] of pending) {
    if (now - p.at > PAIR_TTL) pending.delete(id);
  }
}

pairingRouter.post('/request', (req, res) => {
  sweep();
  const { product, version, name, client_url, token } = req.body ?? {};
  if (product !== 'screensemble-client') {
    return res
      .status(400)
      .json({ accepted: false, reason: 'not a Screensemble client' });
  }
  if (!versionAtLeast(version, config.minClientVersion)) {
    return res.status(403).json({
      accepted: false,
      reason: `client v${version || '?'} is below required v${config.minClientVersion}`,
    });
  }
  if (!client_url) {
    return res
      .status(400)
      .json({ accepted: false, reason: 'missing client_url' });
  }
  const id = randomBytes(4).toString('hex');
  pending.set(id, { id, client_url, name: name ?? '', version, token, at: Date.now() });
  console.log(`pair offer: ${name || client_url} v${version} (id ${id})`);
  res.json({
    accepted: true,
    pairing_id: id,
    server_version: config.version,
    min_client_version: config.minClientVersion,
  });
});

pairingRouter.post('/accept', (req, res) => {
  const { pairing_id } = req.body ?? {};
  const offer = pending.get(pairing_id);
  if (!offer) {
    return res
      .status(404)
      .json({ ok: false, reason: 'no pending pairing (expired?)' });
  }
  pending.delete(pairing_id);
  const player = registry.upsert(pairing_id, {
    client_url: offer.client_url,
    name: offer.name,
    client_version: offer.version,
    token: offer.token || '',
    labels: [],
    paired_at: new Date().toISOString(),
  });
  console.log(`player paired: ${player.name || player.client_url}`);
  res.json({ ok: true, player });
});

pairingRouter.post('/decline', (req, res) => {
  const { pairing_id } = req.body ?? {};
  pending.delete(pairing_id);
  res.json({ ok: true });
});

// Pending/registered listings for a future dashboard.
pairingRouter.get('/pending', (_req, res) => {
  sweep();
  res.json({ pending: [...pending.values()] });
});
pairingRouter.get('/players', (_req, res) => {
  res.json({ players: [...players.values()] });
});
