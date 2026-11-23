import { randomBytes } from 'node:crypto';
import { tokenEquals } from './auth.js';
import { hardwareKey } from './pairing.js';
import { registry } from './registry.js';
import { adminPasswordHash } from './auth.js';

// Performer WebSocket endpoint (/ws/player). Displays dial OUT to the server
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
const pendingPing = new Map(); // nonce  -> { resolve, timer, t0, performerId }
const clock = new Map();       // player_id -> { mono, rtt, at } best sample
let onPushProgress = () => {}; // set by uploads.js

export function setPushProgressHandler(fn) {
  onPushProgress = fn;
}

// The server address as the display sees it — PUBLIC_URL when set (reverse
// proxies), else the Host the display dialed for its WebSocket upgrade, so
// pull_file URLs survive Docker port mapping and NAT.
export function performerBaseUrl(id) {
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

function reject(ws, performerId, remote, why) {
  ws.send(
    JSON.stringify({ type: 'hello_ack', player_id: null, error: 'unauthorized' }),
  );
  try { ws.close(); } catch { /* already gone */ }
  console.log(`performer rejected (${why}): ${performerId || '?'} (${remote})`);
}

export function handlePerformerConnection(ws, req) {
  const remote = req.socket.remoteAddress;
  let performerId = null;

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
        (hw && registry.performers.has(hw) && hw) ||
        (msg.pairing_id && registry.performers.has(String(msg.pairing_id))
          ? String(msg.pairing_id)
          : null);
      const known = candidate ? registry.performers.get(candidate) : null;
      if (!known) return reject(ws, hw, remote, 'not paired');
      if (!known.token || !tokenEquals(msg.token, known.token)) {
        return reject(ws, candidate, remote, 'bad token');
      }
      performerId = candidate;
      ws.baseUrl = baseUrlOf(req);
      // One socket per display — a re-hello replaces the stale binding.
      const prevWs = live.get(performerId);
      if (prevWs && prevWs !== ws) {
        try { prevWs.close(); } catch { /* already gone */ }
      }
      live.set(performerId, ws);
      registry.upsert(performerId, {
        name: String(msg.name || '').slice(0, 100),
        client_version: String(msg.version || '').slice(0, 20),
        online: true,
        last_seen: new Date().toISOString(),
      });
      // Every admitted display gets the admin verifier — the socket only
      // reaches here after product + registry + per-device token checks,
      // so the hash can never travel to an unauthenticated endpoint.
      ws.send(JSON.stringify({
        type: 'hello_ack',
        player_id: performerId,
        auth_hash: adminPasswordHash(),
      }));
      console.log(`performer online: ${performerId} (${msg.name || remote})`);
      // Settings queued while the display was offline — push now that
      // the link is up; cleared when the display acks settings_saved.
      const pend = registry.performers.get(performerId)?.pending_settings;
      if (pend && Object.keys(pend).length) {
        requestFromPerformer(performerId, {
          type: 'set_setting',
          settings: pend,
        })
          .then(() =>
            registry.upsert(performerId, { pending_settings: {} }),
          )
          .catch(() => {
            /* stays queued — retried on the next connect */
          });
      }
      return;
    }
    if (!performerId) return; // must hello first

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
      onPushProgress(performerId, msg);
      return;
    }
    if (msg.type === 'clock_pong' && pendingPing.has(msg.nonce)) {
      const p = pendingPing.get(msg.nonce);
      pendingPing.delete(msg.nonce);
      clearTimeout(p.timer);
      const rtt = Date.now() - p.t0;
      // Keep the lowest-RTT sample — asymmetric latency only ever inflates
      // it, so the fastest round trip is the best estimate of the display's
      // monotonic clock at receive time.
      const prev = clock.get(performerId);
      if (!prev || rtt <= prev.rtt) {
        clock.set(performerId, { mono: msg.mono, rtt, at: Date.now() });
      }
      p.resolve({ mono: msg.mono, rtt });
      return;
    }

    registry.touch(performerId, {
      online: true,
      last_seen: new Date().toISOString(),
      ...(msg.type === 'status' && msg.status && typeof msg.status === 'object'
        ? {
            status: msg.status,
            // Renames propagate via status — no reconnect needed.
            ...(msg.status.name ? { name: String(msg.status.name).slice(0, 100) } : {}),
          }
        : {}),
    });
  });

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('close', () => {
    if (!performerId) return;
    if (live.get(performerId) === ws) {
      live.delete(performerId);
      registry.touch(performerId, { online: false });
    }
    console.log(`performer offline: ${performerId}`);
  });
}

// Heartbeat — terminate sockets that missed a ping so dead displays stop
// showing as online (TCP alone can take hours to notice).
export function startHeartbeat(wss, everyMs = 30_000) {
  // Baseline so the first beat doesn't re-push what hello_ack just sent.
  let lastAuthHash = adminPasswordHash();
  const t = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
    // A changed admin password re-pushes the verifier to live displays
    // so the degraded-mode gate accepts the new credential right away —
    // a display offline during the change picks it up from its next
    // hello_ack instead. A null hash (admin account deleted) clears the
    // stored copy too.
    const h = adminPasswordHash();
    if (h !== lastAuthHash) {
      lastAuthHash = h;
      const msg = JSON.stringify({ type: 'auth_update', auth_hash: h });
      for (const ws of live.values()) {
        try { ws.send(msg); } catch { /* gone */ }
      }
    }
  }, everyMs);
  t.unref?.();
  wss.on('close', () => clearInterval(t));
}

// Drop a display's live socket (used when it's removed from the registry).
export function disconnectPerformer(id) {
  const ws = live.get(id);
  if (ws) { live.delete(id); try { ws.close(); } catch { /* gone */ } }
}

export function performerOnline(id) {
  return live.has(id);
}

export function livePerformerIds() {
  return [...live.keys()];
}

// Fire-and-forget message to a connected display.
export function sendToPerformer(id, obj) {
  const ws = live.get(id);
  if (!ws) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

// Request/response — resolves with the display's reply message (matched
// by its echoed id) or rejects on timeout/offline.
export function requestFromPerformer(id, obj, timeoutMs = 8000) {
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

// NTP-lite: ask a display for its monotonic clock. Repeating and keeping the
// lowest-RTT sample squeezes out jitter; `samples` is small on purpose since
// probing adds socket traffic to every arm.
export function probeClock(id, samples = 3, timeoutMs = 2000) {
  const ws = live.get(id);
  if (!ws) return Promise.reject(new Error('display offline'));
  return new Promise((resolve, reject) => {
    let sent = 0;
    const fire = () => {
      sent += 1;
      const nonce = randomBytes(6).toString('hex');
      const timer = setTimeout(() => {
        pendingPing.delete(nonce);
        if (clock.has(id)) resolve(clock.get(id));
        else reject(new Error('clock probe timed out'));
      }, timeoutMs);
      pendingPing.set(nonce, {
        performerId: id,
        t0: Date.now(),
        timer,
        resolve: (r) => {
          if (sent < samples) fire();
          else resolve(r);
        },
      });
      ws.send(JSON.stringify({ type: 'clock_probe', nonce }));
    };
    fire();
  });
}

// Estimated display monotonic ms right now, from the best probe sample.
export function monoNow(id) {
  const c = clock.get(id);
  return c ? c.mono + c.rtt / 2 + (Date.now() - c.at) : null;
}

// Convert "release N ms from now" into the display's own monotonic domain so
// every display fires on the same instant regardless of when its `go` lands.
export function deadlineFor(id, leadMs) {
  const m = monoNow(id);
  return m === null ? null : m + leadMs;
}

export function clockInfo(id) {
  const c = clock.get(id);
  return c ? { rtt: c.rtt, age_ms: Date.now() - c.at } : null;
}
