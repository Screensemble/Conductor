import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import {
  auth,
  clearChange,
  fileAllowed,
  flagChange,
  mustChange,
  seedDefaultUser,
  sessionOf,
  triggerTokenOk,
} from './auth.js';
import { config } from './config.js';
import { triggerRouter } from './triggers.js';
import { pairingPublicRouter, pairingRouter } from './pairing.js';
import {
  clockInfo,
  deadlineFor,
  disconnectPlayer,
  handlePlayerConnection,
  livePlayerIds,
  playerOnline,
  probeClock,
  requestFromPlayer,
  sendToPlayer,
  startHeartbeat,
} from './players.js';
import { registry } from './registry.js';
import {
  jobList,
  pushLibraryItem,
  serveStaged,
} from './uploads.js';
import {
  deleteItem,
  hasItem,
  itemPath,
  listItems,
  saveStream,
  serveItem,
  validName,
} from './library.js';
import {
  deletePlaylist,
  listPlaylists,
  putPlaylist,
  syncPlaylist,
} from './playlists.js';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = express();
app.disable('x-powered-by');

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 4096) * 1024 * 1024;
const UPLOAD_PATH = /^\/api\/(library|players\/[^/]+\/upload)$/;

// Better Auth owns /api/auth/* — mounted before express.json() so it can
// read request bodies itself.
app.all('/api/auth/*', toNodeHandler(auth));

// Upload routes stream the raw body to disk themselves — keep the JSON
// parser off them regardless of the client's Content-Type.
const jsonBody = express.json({ limit: '1mb' });
app.use((req, res, next) =>
  req.method === 'POST' && UPLOAD_PATH.test(req.path)
    ? next()
    : jsonBody(req, res, next),
);

// -- Open endpoints (no session) -------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', role: config.serverRole });
});

// Identity for pairing: displays REQUIRE this endpoint before showing the
// on-TV "allow this server?" confirmation — product/version gate the pair.
app.get('/api/info', (_req, res) => {
  res.json({
    product: 'screensemble-server',
    version: config.version,
    min_client_version: config.minClientVersion,
    name: config.serverName,
    owner: config.serverOwner,
    info: config.serverInfo,
    role: config.serverRole,
  });
});

// Displays post here before they hold credentials — the only open mutation.
app.use('/api/pair', pairingPublicRouter);

// Display file pulls carry the per-device pairing token in the URL; logged-in
// users may also fetch (thumbnails). See fileAllowed().
app.get('/api/library/file/:name', async (req, res) => {
  if (!(await fileAllowed(req))) {
    return res.status(401).json({ error: 'authentication required' });
  }
  serveItem(validName(req.params.name), res);
});

app.get('/api/uploads/file/:fileId', async (req, res) => {
  if (!(await fileAllowed(req))) {
    return res.status(401).json({ error: 'authentication required' });
  }
  serveStaged(req.params.fileId, res);
});

// Hardware triggers authenticate POSTs with a bearer player token /
// TRIGGER_TOKEN — firing is all a device can do. Map management
// (GET/PUT/DELETE) always needs a dashboard session.
app.use('/api/triggers', async (req, res, next) => {
  if (req.method === 'POST' && triggerTokenOk(req)) return next();
  if (await sessionOf(req)) return next();
  res.status(401).json({ error: 'trigger authentication required' });
});
app.use('/api/triggers', triggerRouter);

// -- Session guard ----------------------------------------------------------
// Everything below requires a logged-in user. Assets the login and
// change-password pages need stay open.
const OPEN_PATHS = new Set([
  '/login.html',
  '/change-password.html',
  '/favicon.ico',
  '/logo.png',
  '/wordmark.png',
  '/upload-toast.js',
]);

app.use(async (req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  const user = await sessionOf(req);
  if (!user) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'authentication required' });
    }
    return res.redirect(
      `/login.html?next=${encodeURIComponent(req.originalUrl || '/')}`,
    );
  }
  req.user = user;
  // Forced first-login (or admin-reset) password change — everything is
  // locked to the change-password page until it's done.
  if (
    mustChange(user.id) &&
    req.path !== '/change-password.html' &&
    !req.path.startsWith('/api/me')
  ) {
    if (req.path.startsWith('/api/')) {
      return res.status(428).json({ error: 'password change required' });
    }
    return res.redirect(
      `/change-password.html?next=${encodeURIComponent(req.originalUrl || '/')}`,
    );
  }
  next();
});

// Resolved from the module, not the cwd — data/ is cwd-relative, pages aren't.
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.use('/api/pair', pairingRouter); // invite/pending — session-gated

// -- Account ---------------------------------------------------------------
app.get('/api/me', (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username ?? req.user.name,
    name: req.user.name,
    role: req.user.role ?? 'user',
    must_change_password: mustChange(req.user.id),
  });
});

// Atomic password change — the forced-change flag only clears after a
// successful change, so a failed attempt can't unlock the session.
app.post('/api/me/set-password', async (req, res) => {
  const { current_password, new_password } = req.body ?? {};
  if (!current_password || !new_password) {
    return res
      .status(400)
      .json({ error: 'current and new password required' });
  }
  try {
    await auth.api.changePassword({
      headers: fromNodeHeaders(req.headers),
      body: {
        currentPassword: current_password,
        newPassword: new_password,
        revokeOtherSessions: true,
      },
    });
  } catch (e) {
    return res
      .status(400)
      .json({ error: e?.body?.message || e.message || 'password change failed' });
  }
  clearChange(req.user.id);
  res.json({ ok: true });
});

// -- User management (admin only) -------------------------------------------
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin required' });
  }
  next();
}

app.get('/api/users', requireAdmin, async (req, res) => {
  const out = await auth.api.listUsers({
    headers: fromNodeHeaders(req.headers),
    query: {},
  });
  const users = (out?.users ?? out ?? []).map((u) => ({
    id: u.id,
    username: u.username ?? '',
    name: u.name ?? '',
    email: u.email ?? '',
    role: u.role ?? 'user',
    must_change_password: mustChange(u.id),
    created_at: u.createdAt,
  }));
  res.json({ users });
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username: un, password, role } = req.body ?? {};
  if (!un || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  try {
    const r = await auth.api.createUser({
      headers: fromNodeHeaders(req.headers),
      body: {
        email: `${un}@screensemble.local`,
        password,
        name: un,
        role: role === 'admin' ? 'admin' : 'user',
        data: { username: un, displayUsername: un },
      },
    });
    const id = r?.user?.id;
    if (id) flagChange(id); // new users set their own password at first login
    res.status(201).json({ ok: true, id });
  } catch (e) {
    res.status(400).json({ error: e?.body?.message || e.message });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'cannot delete your own account' });
  }
  try {
    await auth.api.removeUser({
      headers: fromNodeHeaders(req.headers),
      body: { userId: req.params.id },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e?.body?.message || e.message });
  }
});

// Admin password reset — user must change it again at next login.
app.post('/api/users/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body ?? {};
  if (!password) return res.status(400).json({ error: 'password required' });
  try {
    await auth.api.setUserPassword({
      headers: fromNodeHeaders(req.headers),
      body: { userId: req.params.id, newPassword: password },
    });
    flagChange(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e?.body?.message || e.message });
  }
});

// -- Fleet view ----------------------------------------------------------
// Displays hold a persistent WebSocket to /ws/player — "online" is simply
// whether that socket is live; status arrives pushed every few seconds.
// Device tokens never leave the server through the dashboard API.
const publicPlayer = ({ token, ...p }) => ({ ...p, online: playerOnline(p.id) });

app.get('/api/players', (_req, res) => {
  res.json({ players: registry.list().map(publicPlayer) });
});

// Single display detail — registry record + live status + online flag.
app.get('/api/players/:id', (req, res) => {
  const p = registry.players.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown player' });
  res.json(publicPlayer(p));
});

app.post('/api/players/:id/labels', (req, res) => {
  const p = registry.players.get(req.params.id);
  const labels = req.body?.labels;
  if (!p) return res.status(404).json({ error: 'unknown player' });
  if (!Array.isArray(labels)) {
    return res.status(400).json({ error: 'labels must be an array' });
  }
  const player = registry.upsert(p.id, {
    labels: labels.slice(0, 20).map((l) => String(l).slice(0, 40)),
  });
  res.json({ player: publicPlayer(player) });
});

app.post('/api/players/:id/command', async (req, res) => {
  const p = registry.players.get(req.params.id);
  const cmd = req.body?.cmd;
  if (!p) return res.status(404).json({ error: 'unknown player' });
  if (!cmd) return res.status(400).json({ error: 'no command' });
  try {
    const reply = await requestFromPlayer(req.params.id, {
      type: 'command',
      cmd,
      name: req.body?.name,
    });
    res.status(reply.ok ? 200 : 400).json(reply);
  } catch (e) {
    res.status(502).json({ error: `display unreachable: ${e.message}` });
  }
});

// A display's current playlist, fetched live over its socket.
app.get('/api/players/:id/media', async (req, res) => {
  const p = registry.players.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown player' });
  try {
    const reply = await requestFromPlayer(req.params.id, {
      type: 'get_media',
    });
    res.json({ items: reply.items || [] });
  } catch (e) {
    res.status(502).json({ error: `display unreachable: ${e.message}` });
  }
});

// Playlist mutations — mirrors the display's local admin API, proxied
// over the socket so the per-display server UI can edit anything the
// local one can.
app.post('/api/players/:id/media/:op', async (req, res) => {
  const p = registry.players.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown player' });
  try {
    const reply = await requestFromPlayer(req.params.id, {
      ...(req.body || {}),
      type: 'media_op',
      op: req.params.op,
    });
    res.status(reply.ok ? 200 : 400).json(reply);
  } catch (e) {
    res.status(502).json({ error: `display unreachable: ${e.message}` });
  }
});

// Editable display settings, proxied over the socket.
app.get('/api/players/:id/settings', async (req, res) => {
  const p = registry.players.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown player' });
  try {
    const reply = await requestFromPlayer(req.params.id, {
      type: 'get_settings',
    });
    res.json(reply.settings || {});
  } catch (e) {
    res.status(502).json({ error: `display unreachable: ${e.message}` });
  }
});

app.post('/api/players/:id/settings', async (req, res) => {
  const p = registry.players.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown player' });
  try {
    const reply = await requestFromPlayer(req.params.id, {
      type: 'set_setting',
      settings: req.body || {},
    });
    res.json({ saved: reply.saved || {} });
  } catch (e) {
    res.status(502).json({ error: `display unreachable: ${e.message}` });
  }
});

// Media file proxy — thumbnails/previews pulled back over the socket
// (base64). Enough for images; videos intentionally refuse.
app.get('/api/players/:id/file/:name', async (req, res) => {
  const p = registry.players.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown player' });
  try {
    const reply = await requestFromPlayer(
      req.params.id,
      { type: 'get_file', name: req.params.name },
      15000,
    );
    if (reply.error || !reply.data) {
      return res.status(404).json({ error: reply.error || 'no data' });
    }
    const buf = Buffer.from(reply.data, 'base64');
    const ext = req.params.name.split('.').pop().toLowerCase();
    res.setHeader(
      'Content-Type',
      {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
      }[ext] || 'application/octet-stream',
    );
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: `display unreachable: ${e.message}` });
  }
});

// Content push — the browser uploads to the server, the file is stored
// in the library, and the display pulls it back over HTTP. Progress
// lands in the job queue below.
async function receiveUpload(req, res) {
  const name = validName(req.query.name);
  if (!name) {
    res.status(400).json({ error: 'unsupported file name or type' });
    return null;
  }
  try {
    const { size } = await saveStream(name, req, MAX_UPLOAD_BYTES);
    return { name, size };
  } catch (e) {
    if (!res.headersSent) {
      res.status(e.status || 500).json({ error: e.message || 'upload failed' });
    }
    return null;
  }
}

app.post('/api/players/:id/upload', async (req, res) => {
  const p = registry.players.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown player' });
  const got = await receiveUpload(req, res);
  if (!got) return;
  const job = pushLibraryItem(req.params.id, got.name, got.size);
  res.status(job.state === 'error' ? 502 : 202).json({ job });
});

// -- Media library ---------------------------------------------------------
// Permanent server-side store shared across displays and playlists.

app.get('/api/library', (_req, res) => {
  res.json({ items: listItems() });
});

app.post('/api/library', async (req, res) => {
  const got = await receiveUpload(req, res);
  if (got) res.status(201).json({ ok: true, name: got.name });
});

app.delete('/api/library/:name', (req, res) => {
  const name = validName(req.params.name);
  if (!hasItem(name)) return res.status(404).json({ error: 'not found' });
  deleteItem(name);
  res.json({ ok: true });
});



// Copy a library item to one or more displays.
app.post('/api/library/:name/push', (req, res) => {
  const name = validName(req.params.name);
  if (!hasItem(name)) return res.status(404).json({ error: 'not found' });
  const players = Array.isArray(req.body?.players) ? req.body.players : [];
  const size = statSync(itemPath(name)).size;
  const jobs = players.map((pid) => pushLibraryItem(String(pid), name, size));
  res.json({ jobs });
});

// -- Shared playlists ------------------------------------------------------
// Named ordered lists of library items, assignable to displays.

app.get('/api/playlists', (_req, res) => {
  res.json({ playlists: listPlaylists() });
});

app.post('/api/playlists/:name', async (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!name || name.length > 100) {
    return res.status(400).json({ error: 'name required (max 100 chars)' });
  }
  const pl = putPlaylist(name, req.body || {});
  const results = pl.players.length ? await syncPlaylist(name) : {};
  res.json({ playlist: pl, sync: results });
});

app.delete('/api/playlists/:name', (req, res) => {
  deletePlaylist(String(req.params.name || '').trim());
  res.json({ ok: true });
});

app.post('/api/playlists/:name/sync', async (req, res) => {
  const results = await syncPlaylist(req.params.name, {
    prune: req.body?.prune === true || req.query.prune === '1',
  });
  res.json(results);
});

app.get('/api/uploads', (_req, res) => {
  res.json({ jobs: jobList() });
});

// Conductor — synchronized multi-display arm/go. Arm probes each display's
// monotonic clock and stages item 0 (videos paused on frame one, images
// shown statically); go converts one release instant into every display's
// own clock domain so they all start together regardless of socket jitter.
//
// POST /api/conductor/arm { players?: [id] }        stage + probe clocks
// POST /api/conductor/go  { lead_ms?, policy?,      release the staged set
//                           min_ready? }            policy: all|min|any
// GET  /api/conductor                               session + readiness
const conductor = {
  armed: false,
  players: new Set(),   // ids staged by the last arm
  armed_at: null,
};

// Clocks drift — refresh samples while a session stays armed so a long hold
// doesn't skew the release deadline. Probe traffic is trivial vs. skew.
setInterval(() => {
  if (!conductor.armed) return;
  for (const id of conductor.players) {
    probeClock(id).catch(() => {});
  }
}, 30_000).unref();

function conductorReadiness() {
  const rows = [...conductor.players].map((id) => ({
    player_id: id,
    online: playerOnline(id),
    armed: Boolean(registry.players.get(id)?.status?.armed),
    clock: clockInfo(id),
  }));
  return {
    armed: conductor.armed,
    armed_at: conductor.armed_at,
    players: rows,
    ready: rows.filter((r) => r.online && r.armed).length,
    total: rows.length,
  };
}

app.get('/api/conductor', (_req, res) => {
  res.json(conductorReadiness());
});

app.post('/api/conductor/:cmd', async (req, res) => {
  const cmd = req.params.cmd;
  const targets = Array.isArray(req.body?.players)
    ? req.body.players.filter((id) => livePlayerIds().includes(id))
    : livePlayerIds();

  if (cmd === 'arm') {
    conductor.players = new Set(targets);
    conductor.armed = true;
    conductor.armed_at = new Date().toISOString();
    // Probe before arming so the clock sample exists by the time go fires.
    await Promise.allSettled(targets.map((id) => probeClock(id)));
    const sent = targets.filter((id) =>
      sendToPlayer(id, { type: 'command', cmd: 'arm' })
    );
    return res.json({ ok: true, cmd, delivered: sent.length, players: sent });
  }

  if (cmd === 'go') {
    if (!conductor.armed) {
      return res.status(409).json({ error: 'nothing armed — POST /api/conductor/arm first' });
    }
    const ready = conductorReadiness();
    const policy = req.body?.policy ?? 'all';
    const minReady = Number(req.body?.min_ready) || 0;
    if (policy === 'all' && ready.ready < ready.total) {
      return res.status(409).json({ error: `only ${ready.ready}/${ready.total} staged`, readiness: ready });
    }
    if (policy === 'min' && ready.ready < minReady) {
      return res.status(409).json({ error: `${ready.ready} staged, need ${minReady}`, readiness: ready });
    }
    // policy 'any' (or satisfied all/min) — release whoever is staged.
    const leadMs = Math.min(Math.max(Number(req.body?.lead_ms) || 500, 0), 30_000);
    const results = {};
    for (const id of conductor.players) {
      const r = registry.players.get(id);
      if (!playerOnline(id) || !r?.status?.armed) {
        results[id] = { released: false, reason: 'not armed' };
        continue;
      }
      const at = deadlineFor(id, leadMs);
      results[id] = at === null
        ? { released: false, reason: 'no clock sample' }
        : { released: sendToPlayer(id, { type: 'command', cmd: 'go', at_mono: at }), at_mono: at };
    }
    conductor.armed = false;
    conductor.players = new Set();
    return res.json({ ok: true, cmd, lead_ms: leadMs, results });
  }

  res.status(400).json({ error: 'arm|go only' });
});

app.delete('/api/players/:id', (req, res) => {
  if (!registry.remove(req.params.id)) {
    return res.status(404).json({ error: 'unknown player' });
  }
  disconnectPlayer(req.params.id);
  res.json({ ok: true });
});

const server = createServer(app);
// 16 MB covers the largest display reply (8 MB thumbnail proxy, base64).
const wss = new WebSocketServer({
  server,
  path: '/ws/player',
  maxPayload: 16 * 1024 * 1024,
});
wss.on('connection', handlePlayerConnection);
startHeartbeat(wss);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    registry.flush();
    process.exit(0);
  });
}

await seedDefaultUser();

server.listen(config.port, config.host, () => {
  console.log(
    `screensemble-server listening on ${config.host}:${config.port} (role: ${config.serverRole})`,
  );
});
