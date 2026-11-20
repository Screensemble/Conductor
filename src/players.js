import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { registry } from './registry.js';

// Player WebSocket endpoint (/ws/player). Displays dial OUT to the server
// and hold one persistent socket — enrollment, status reports, commands
// and request/response all travel over it, so managed displays work from
// anywhere without inbound connectivity (spec sections 2 and 4).
//
// Inbound messages:
//   hello           { product, version, name, pairing_id?, token? }
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

// The server address as the display sees it — derived from the socket's
// local interface, so pull_file URLs work on whichever address the
// display originally dialed.
export function playerBaseUrl(id) {
  const addr = live.get(id)?._socket?.localAddress;
  return addr ? `http://${addr}:${config.port}` : null;
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
      // Hardware-anchored identity wins — a reinstalled/reset display
      // always rebinds to the same registry entry instead of minting a
      // new one per connect.
      const hw = typeof msg.hardware_id === 'string' && msg.hardware_id
        ? `hw-${msg.hardware_id.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`
        : null;
      playerId =
        hw ||
        (msg.pairing_id && registry.players.has(msg.pairing_id)
          ? msg.pairing_id
          : randomBytes(4).toString('hex'));
      // A pairing-created entry migrates to the hardware-keyed id,
      // carrying labels/pairing metadata with it.
      if (hw && msg.pairing_id && msg.pairing_id !== playerId) {
        const prev = registry.players.get(msg.pairing_id);
        if (prev) {
          const carry = {};
          for (const k of [
            'name', 'labels', 'paired_at', 'client_url', 'token',
          ]) {
            if (prev[k] !== undefined) carry[k] = prev[k];
          }
          registry.upsert(playerId, carry);
          registry.remove(msg.pairing_id);
        }
      }
      // Per-device auth (TOFU): pairing already required a human confirm
      // on the TV, so the first token a display presents binds to its
      // registry entry and must match on every later hello. Entries
      // predating auth get bound on their next connect the same way.
      const known = registry.players.get(playerId);
      if (known?.token && msg.token !== known.token) {
        ws.send(
          JSON.stringify({
            type: 'hello_ack',
            player_id: null,
            error: 'unauthorized',
          }),
        );
        try { ws.close(); } catch { /* already gone */ }
        console.log(`player auth rejected: ${playerId} (${remote})`);
        return;
      }
      // One socket per display — a re-hello replaces the stale binding.
      const prevWs = live.get(playerId);
      if (prevWs && prevWs !== ws) {
        try { prevWs.close(); } catch { /* already gone */ }
      }
      live.set(playerId, ws);
      registry.upsert(playerId, {
        name: msg.name || '',
        client_version: msg.version || '',
        hardware_id: hw || msg.hardware_id || '',
        online: true,
        last_seen: new Date().toISOString(),
        ...(known?.token ? {} : msg.token ? { token: msg.token } : {}),
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

    registry.upsert(playerId, {
      online: true,
      last_seen: new Date().toISOString(),
    });
    if (msg.type === 'status') {
      registry.upsert(playerId, { status: msg.status });
    }
  });

  ws.on('close', () => {
    if (!playerId) return;
    if (live.get(playerId) === ws) {
      live.delete(playerId);
      registry.upsert(playerId, { online: false });
    }
    console.log(`player offline: ${playerId}`);
  });
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
