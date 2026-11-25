import { Router } from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import { config } from './config.js';
import { registry } from './registry.js';
import { passwordChangePending } from './auth.js';

// Pairing handshake (spec: enrollment). Only displays paired through this
// flow can connect; there is no first-come enrollment.
//   1. A signed-in user opens the dashboard Pair page, which mints a
//      single-use pairing code (POST /api/pair/invite, session-gated).
//   2. The page (or the display's phone setup page) hands the code to the
//      display, which posts POST /api/pair/request with it.
//   3. The human confirms on the TV; the display posts /accept (or
//      /decline) with the pairing_id and receives its per-device token.
export const pairingRouter = Router();        // session-gated
export const pairingPublicRouter = Router();  // reached by displays
export const players = registry.performers;

const pending = new Map();   // pairing_id -> offer awaiting TV confirm
const invites = new Map();   // code -> { at, by }
const PAIR_TTL = 10 * 60 * 1000;
const MAX_PENDING = 50;
const MAX_INVITES = 50;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Failed-code throttle, per client address: the request endpoint is public,
// so bound guessing without letting one prober lock out every display.
const FAIL_WINDOW = 60 * 1000;
const MAX_FAILS = 20;
const fails = new Map();

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
  for (const [id, p] of pending) if (now - p.at > PAIR_TTL) pending.delete(id);
  for (const [c, i] of invites) if (now - i.at > PAIR_TTL) invites.delete(c);
  for (const [ip, ts] of fails) {
    const live = ts.filter((t) => now - t < FAIL_WINDOW);
    if (live.length) fails.set(ip, live); else fails.delete(ip);
  }
}

function newCode() {
  let c = '';
  for (let i = 0; i < 8; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return c;
}

function normCode(c) {
  return String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hardwareKey(hardwareId) {
  const clean = String(hardwareId ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 16);
  return clean ? `hw-${clean}` : null;
}

pairingPublicRouter.post('/request', (req, res) => {
  sweep();
  if (passwordChangePending()) {
    return res.status(428).json({
      accepted: false,
      reason: 'conductor setup incomplete — change the admin password first',
    });
  }
  const { product, version, name, client_url, hardware_id, code } = req.body ?? {};
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
  const ip = req.ip || req.socket?.remoteAddress || '?';
  if ((fails.get(ip)?.length ?? 0) >= MAX_FAILS) {
    return res
      .status(429)
      .json({ accepted: false, reason: 'too many attempts — wait a minute' });
  }
  const c = normCode(code);
  if (!c || !invites.has(c)) {
    fails.set(ip, [...(fails.get(ip) ?? []), Date.now()]);
    return res.status(403).json({
      accepted: false,
      reason: code
        ? 'pairing code is invalid or expired — get a new one from the server\'s Pair page'
        : 'pairing code required — get one from the server\'s Pair page (update the display addon if it has no code field)',
    });
  }
  if (!hardwareKey(hardware_id)) {
    return res
      .status(400)
      .json({ accepted: false, reason: 'missing hardware_id' });
  }
  if (pending.size >= MAX_PENDING) {
    return res
      .status(429)
      .json({ accepted: false, reason: 'too many pending pairings' });
  }
  invites.delete(c);
  const id = randomBytes(16).toString('hex');
  pending.set(id, {
    id,
    client_url: String(client_url ?? '').slice(0, 200),
    name: String(name ?? '').slice(0, 100),
    version: String(version ?? '').slice(0, 20),
    hardware_id: String(hardware_id),
    at: Date.now(),
  });
  console.log(`pair offer: ${name || client_url || id} v${version}`);
  res.json({
    accepted: true,
    pairing_id: id,
    server_version: config.version,
    min_client_version: config.minClientVersion,
  });
});

// Called by the display after the human pressed Pair on the TV. Possession
// of the 128-bit pairing_id (only ever sent to the display) authorizes it.
pairingPublicRouter.post('/accept', (req, res) => {
  sweep();
  const { pairing_id } = req.body ?? {};
  const offer = pending.get(String(pairing_id ?? ''));
  if (!offer) {
    return res
      .status(404)
      .json({ ok: false, reason: 'no pending pairing (expired?)' });
  }
  pending.delete(offer.id);
  const playerId = hardwareKey(offer.hardware_id);
  const token = randomBytes(24).toString('hex');
  const prev = registry.performers.get(playerId);
  registry.upsert(playerId, {
    client_url: offer.client_url,
    name: offer.name,
    client_version: offer.version,
    hardware_id: playerId,
    token,
    labels: prev?.labels ?? [],
    paired_at: new Date().toISOString(),
  });
  console.log(`performer paired: ${offer.name || playerId}`);
  res.json({ ok: true, player_id: playerId, token });
});

pairingPublicRouter.post('/decline', (req, res) => {
  pending.delete(String(req.body?.pairing_id ?? ''));
  res.json({ ok: true });
});

pairingRouter.post('/invite', (req, res) => {
  sweep();
  if (invites.size >= MAX_INVITES) {
    const oldest = invites.keys().next().value;
    invites.delete(oldest);
  }
  const code = newCode();
  invites.set(code, { at: Date.now(), by: req.user?.id });
  res.json({ code, expires_in: PAIR_TTL / 1000 });
});

pairingRouter.get('/pending', (_req, res) => {
  sweep();
  res.json({
    pending: [...pending.values()].map(
      ({ name, client_url, version, at, hardware_id }) => ({
        name, client_url, version, at,
        // Registry form — callers compare against performers[].id.
        hardware_id: hardwareKey(hardware_id),
      }),
    ),
  });
});
