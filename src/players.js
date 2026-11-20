import { randomBytes } from 'node:crypto';
import { tokenEquals } from './auth.js';
import { hardwareKey } from './pairing.js';
import { registry } from './registry.js';

// Player WebSocket endpoint (/ws/player). Displays dial OUT to the server
// and hold one persistent socket — enrollment, status reports, commands
// and request/response all travel over it, so managed displays work from
// anywhere without inbound connectivity (spec sections 2 and 4).
//
// Inbound messages:
//   hello           { product, version, name, hardware_id, pairing_id?, token }
//   status          { status: {...} }
//   command_result  { id, ok, error? }
//   media           { id, items: [...] }
// Outbound:
//   hello_ack       { player_id }
//   command         { id, cmd, name? }
//   get_media       { id }

const live = new Map();        // player_id -> ws
const pendingReq = new Map();  // req_id -> { resolve, timer }
let onPushProgress = () => {}; // set by uploads.js

export function setPushProgressHandler(fn) {
  onPushProgress = fn;
}

// The server address as the display sees it — PUBLIC_URL when set (reverse
// proxies), else the Host the display dialed for its WebSocket upgrade, so
// pull_file URLs survive Docker port mapping and NAT.
export function playerBaseUrl(id) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  return live.get(id)?.baseUrl ?? null;
}

function baseUrlOf(req) {
  const host = req.headers.host;
  if (!host || !/^[a-z0-9.\-:[\]]+$/i.test(host)) return null;
  const https =
    req.socket.encrypted ||
    String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  return `${https ? 'https' : 'http'}://${host}`;
}

function reject(ws, playerId, remote, why) {
  ws.send(
    JSON.stringify({ type: 'hello_ack', player_id: null, error: 'unauthorized' }),
  );
  try { ws.close(); } catch { /* already gone */ }
  console.log(`player rejected (${why}): ${playerId || '?'} (${remote})`);
}

export function handlePlayerConnection(ws, req) {
  const remote = req.socket.remoteAddress;
  let playerId = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'hello') {
      if (msg.product !== 'screensemble-client') {
        ws.close();
        return;
      }
      // Only displays paired through the QR flow are admitted: the entry
      // must exist (keyed by hardware id, or a legacy pairing id) and the
      // hello must carry the token issued at pairing.
      const hw = hardwareKey(msg.hardware_id);
      const candidate =
        (hw && registry.players.has(hw) && hw) ||
        (msg.pairing_id && registry.players.has(String(msg.pairing_id))
          ? String(msg.pairing_id)
          : null);
      const known = candidate ? registry.players.get(candidate) : null;
      if (!known) return reject(ws, hw, remote, 'not paired');
      if (!known.token || !tokenEquals(msg.token, known.token)) {
        return reject(ws, candidate, remote, 'bad token');
      }
      playerId = candidate;
      ws.baseUrl = baseUrlOf(req);
      // One socket per display — a re-hello replaces the stale binding.
      const prevWs = live.get(playerId);
      if (prevWs && prevWs !== ws) {
        try { prevWs.close(); } catch { /* already gone */ }
      }
      live.set(playerId, ws);
      registry.upsert(playerId, {
        name: String(msg.name || '').slice(0, 100),
        client_version: String(msg.version || '').slice(0, 20),
        online: true,
        last_seen: new Date().toISOString(),
      });
      ws.send(JSON.stringify({ type: 'hello_ack', player_id: playerId }));
      console.log(`player online: ${playerId} (${msg.name || remote})`);
      return;
    }
    if (!playerId) return; // must hello first

    // Any reply carrying a request id resolves its waiter — covers
    // command_result, media, settings, media_op_result, file, …
    if (msg.id && pendingReq.has(msg.id)) {
      const p = pendingReq.get(msg.id);
      pendingReq.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
      return;
    }
    if (msg.type === 'push_progress') {
      onPushProgress(playerId, msg);
      return;
    }

    registry.touch(playerId, {
      online: true,
      last_seen: new Date().toISOString(),
      ...(msg.type === 'status' && msg.status && typeof msg.status === 'object'
        ? { status: msg.status }
        : {}),
    });
  });

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('close', () => {
    if (!playerId) return;
    if (live.get(playerId) === ws) {
      live.delete(playerId);
      registry.touch(playerId, { online: false });
    }
    console.log(`player offline: ${playerId}`);
  });
}

// Heartbeat — terminate sockets that missed a ping so dead displays stop
// showing as online (TCP alone can take hours to notice).
export function startHeartbeat(wss, everyMs = 30_000) {
  const t = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, everyMs);
  t.unref?.();
  wss.on('close', () => clearInterval(t));
}

// Drop a display's live socket (used when it's removed from the registry).
export function disconnectPlayer(id) {
  const ws = live.get(id);
  if (ws) { live.delete(id); try { ws.close(); } catch { /* gone */ } }
}

export function playerOnline(id) {
  return live.has(id);
}

export function livePlayerIds() {
  return [...live.keys()];
}

// Fire-and-forget message to a connected display.
export function sendToPlayer(id, obj) {
  const ws = live.get(id);
  if (!ws) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

// Request/response — resolves with the display's reply message (matched
// by its echoed id) or rejects on timeout/offline.
export function requestFromPlayer(id, obj, timeoutMs = 8000) {
  const ws = live.get(id);
  if (!ws) return Promise.reject(new Error('display offline'));
  const reqId = randomBytes(6).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReq.delete(reqId);
      reject(new Error('display timed out'));
    }, timeoutMs);
    pendingReq.set(reqId, { resolve, timer });
    ws.send(JSON.stringify({ ...obj, id: reqId }));
  });
}
