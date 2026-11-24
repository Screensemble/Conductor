import './restore.js'; // boot-time restore swap — must precede data modules
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFileSync as readFile } from 'node:fs';
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
  passwordOk,
  PASSWORD_RULE,
  cueTokenOk,
} from './auth.js';
import { config } from './config.js';
import { cueRouter } from './cues.js';
import { automationsRouter, hooksRouter, startScheduler } from './automations.js';
import { battonDeviceRouter, battonsPublicRouter, battonsRouter } from './battons.js';
import { pairingPublicRouter, pairingRouter } from './pairing.js';
import {
  clockInfo,
  deadlineFor,
  disconnectPerformer,
  handlePerformerConnection,
  livePerformerIds,
  performerBaseUrl,
  performerOnline,
  probeClock,
  pushAuthHash,
  requestFromPerformer,
  sendToPerformer,
  setStatusHook,
  startHeartbeat,
} from './performers.js';
import {
  armWaitLoop,
  disarmWaitLoop,
  listWaitLoops,
  onPerformerStatus,
  waitLoopTargets,
} from './waitloop.js';
import { registry } from './registry.js';
import { stageRestore, streamBackup } from './backup.js';
import { extractFrame } from './frames.js';
import { repoZip, serveRepoFile } from './repo.js';
import {
  jobList,
  pushLibraryItem,
  serveStaged,
} from './uploads.js';
import {
  deleteItem,
  hasItem,
  itemMeta,
  itemPath,
  itemSha256,
  listItems,
  saveStream,
  serveItem,
  setItemMeta,
  validName,
} from './library.js';
import {
  deletePlaylist,
  listPlaylists,
  putPlaylist,
  syncPlaylist,
} from './playlists.js';
import {
  deleteCollection,
  getCollection,
  listCollections,
  putCollection,
  resolveTargets,
} from './collections.js';
import { statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = express();
app.disable('x-powered-by');

// Wait-loop barriers observe every performer status message.
setStatusHook(onPerformerStatus);

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 4096) * 1024 * 1024;
const UPLOAD_PATH = /^\/api\/(library|(?:players|performers)\/[^/]+\/upload|backup\/restore)$/;

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
  res.json({
    status: 'ok',
    role: config.serverRole,
    // Schedule automations fire on this clock — the UI shows it so
    // "18:00" is unambiguous when the conductor's TZ differs from a
    // viewer's (e.g. an unset container TZ reading UTC).
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
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

// Battons offer themselves for pairing + poll for approval with a
// one-time pair id; automations' webhooks are fired by external systems
// with their unguessable key as the only credential.
app.use('/api/battons', battonsPublicRouter);
app.use('/api/hooks', hooksRouter);

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


// Legacy route aliases — older firmware and integrations keep working.
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/players')) {
    req.url = req.url.replace('/api/players', '/api/performers');
  } else if (req.path.startsWith('/api/triggers')) {
    req.url = req.url.replace('/api/triggers', '/api/cues');
  }
  next();
});

// Cue devices authenticate POSTs with a bearer performer token /
// CUE_TOKEN (legacy TRIGGER_TOKEN honored) — firing is all a device can
// do. Map management (GET/PUT/DELETE) always needs a Control Room
// session.
app.use('/api/cues', async (req, res, next) => {
  if (req.method === 'POST' && cueTokenOk(req)) return next();
  if (await sessionOf(req)) return next();
  res.status(401).json({ error: 'cue authentication required' });
});
app.use('/api/cues', cueRouter);

// Batton device endpoints — each re-checks the per-batton bearer token.
// Management routes mount later, behind the session guard.
app.use('/api/battons', battonDeviceRouter);

// On-server addon repository — token-gated file pulls + a per-display
// repository.screensemble installer so displays update with no internet.
app.get(['/repo', '/repo/:file'], serveRepoFile);
app.get('/api/performers/:id/repo.zip', (req, res) => {
  const zip = repoZip(req.params.id);
  if (!zip) return res.status(404).json({ error: 'display offline or unknown' });
  res.type('application/zip');
  res.setHeader('content-disposition',
    'attachment; filename="repository.screensemble-1.0.0.zip"');
  res.send(zip);
});

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
app.use('/api/battons', battonsRouter);          // management — session-gated
app.use('/api/automations', automationsRouter); // IFTTT editor — session-gated

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
  if (!passwordOk(new_password)) {
    return res.status(400).json({ error: `password must have ${PASSWORD_RULE}` });
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
  // Push the new verifier to live displays immediately — the heartbeat
  // would catch it within a tick, but a rotated password should reach
  // a display before anyone drops the conductor for a fallback test.
  pushAuthHash();
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
    const out = await auth.api.listUsers({
      headers: fromNodeHeaders(req.headers),
      query: {},
    });
    const admins = (out?.users ?? out ?? []).filter((u) => u.role === 'admin');
    const target = admins.find((u) => u.id === req.params.id);
    if (target && admins.length === 1) {
      return res.status(400).json({ error: 'cannot delete the last admin' });
    }
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
const publicPerformer = ({ token, ...p }) => ({ ...p, online: performerOnline(p.id) });

app.get('/api/performers', (_req, res) => {
  const list = registry.list().map(publicPerformer);
  res.json({ performers: list, players: list });
});

// Single display detail — registry record + live status + online flag.
app.get('/api/performers/:id', (req, res) => {
  const p = registry.performers.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown performer' });
  res.json(publicPerformer(p));
});

app.post('/api/performers/:id/labels', (req, res) => {
  const p = registry.performers.get(req.params.id);
  const labels = req.body?.labels;
  if (!p) return res.status(404).json({ error: 'unknown performer' });
  if (!Array.isArray(labels)) {
    return res.status(400).json({ error: 'labels must be an array' });
  }
  const performer = registry.upsert(p.id, {
    labels: labels.slice(0, 20).map((l) => String(l).slice(0, 40)),
  });
  res.json({ performer: publicPerformer(performer) });
});

app.post('/api/performers/:id/command', async (req, res) => {
  const p = registry.performers.get(req.params.id);
  const cmd = req.body?.cmd;
  if (!p) return res.status(404).json({ error: 'unknown performer' });
  if (!cmd) return res.status(400).json({ error: 'no command' });
  try {
    const reply = await requestFromPerformer(req.params.id, {
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
app.get('/api/performers/:id/media', async (req, res) => {
  const p = registry.performers.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown performer' });
  try {
    const reply = await requestFromPerformer(req.params.id, {
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
app.post('/api/performers/:id/media/:op', async (req, res) => {
  const p = registry.performers.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown performer' });
  try {
    const reply = await requestFromPerformer(req.params.id, {
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
app.get('/api/performers/:id/settings', async (req, res) => {
  const p = registry.performers.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown performer' });
  if (!performerOnline(req.params.id)) {
    // Offline — serve the queued values so the form shows what will sync.
    return res.json({ ...(p.pending_settings || {}), _offline: true });
  }
  try {
    const reply = await requestFromPerformer(req.params.id, {
      type: 'get_settings',
    });
    res.json(reply.settings || {});
  } catch (e) {
    res.status(502).json({ error: `display unreachable: ${e.message}` });
  }
});

app.post('/api/performers/:id/settings', async (req, res) => {
  const p = registry.performers.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown performer' });
  // Offline display — queue the change on the registry; it is pushed to
  // the display the next time its link comes up (see performers.js).
  if (!performerOnline(req.params.id)) {
    registry.upsert(req.params.id, {
      pending_settings: {
        ...(p.pending_settings || {}),
        ...(req.body || {}),
      },
    });
    return res.json({ pending: true });
  }
  try {
    const reply = await requestFromPerformer(req.params.id, {
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
app.get('/api/performers/:id/file/:name', async (req, res) => {
  const p = registry.performers.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown performer' });
  try {
    const reply = await requestFromPerformer(
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

app.post('/api/performers/:id/upload', async (req, res) => {
  const p = registry.performers.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown performer' });
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

// Per-asset metadata — the default image duration travels with the file
// on pushes and playlist syncs. Edits also write straight through to
// online displays (seconds:0 pops the display's stored value) so
// clearing the field doesn't leave a stale default behind.
app.put('/api/library/:name', async (req, res) => {
  const name = validName(req.params.name);
  if (!hasItem(name)) return res.status(404).json({ error: 'not found' });
  const d = req.body?.duration;
  if (d != null && (!Number.isFinite(+d) || +d <= 0 || +d > 86400)) {
    return res.status(400).json({ error: 'duration must be 1-86400 seconds' });
  }
  const meta = setItemMeta(name, { duration: d == null ? null : +d });
  // Fan out in parallel and only to displays whose catalog lists the
  // file — a blanket duration op would leave an orphan state entry on
  // displays that never received it.
  const settled = await Promise.allSettled(
    livePerformerIds().map(async (pid) => {
      const media = await requestFromPerformer(
        String(pid), { type: 'get_media' }, 5000);
      if ((media.items || []).some((i) => i.name === name)) {
        await requestFromPerformer(String(pid), {
          type: 'media_op', op: 'duration', name,
          seconds: meta.duration || 0,
        }, 5000);
        return true;
      }
      return false;
    }),
  );
  const applied = settled.filter((s) => s.value === true).length;
  res.json({ ok: true, meta, applied });
});

app.delete('/api/library/:name', (req, res) => {
  const name = validName(req.params.name);
  if (!hasItem(name)) return res.status(404).json({ error: 'not found' });
  deleteItem(name);
  res.json({ ok: true });
});



// Frozen-frame extraction (server-side only — displays never decode a
// still). GET previews a frame without touching the library; POST saves
// the frame as a library image that flows through the normal push path.
app.get('/api/library/:name/frame', async (req, res) => {
  try {
    const { buf, mime } = await extractFrame(req.params.name, req.query.t);
    res.type(mime).send(buf);
  } catch (e) {
    res.status(e.message === 'not a video' || e.message === 'invalid name'
      ? 400 : 502).json({ error: e.message });
  }
});

app.post('/api/library/:name/frame', async (req, res) => {
  try {
    const { buf } = await extractFrame(req.params.name, req.body?.t);
    const base = req.params.name.replace(/\.[^.]+$/, '');
    const out = validName(
      `${base}@${
        String(Math.max(Number(req.body?.t) || 0, 0)).replace('.', '_')
      }s.jpg`,
    );
    writeFileSync(itemPath(out), buf);
    res.json({ ok: true, name: out });
  } catch (e) {
    res.status(e.message === 'not a video' || e.message === 'invalid name'
      ? 400 : 502).json({ error: e.message });
  }
});

// Copy a library item to one or more displays.
app.post('/api/library/:name/push', async (req, res) => {
  const name = validName(req.params.name);
  if (!hasItem(name)) return res.status(404).json({ error: 'not found' });
  const ids = Array.isArray(req.body?.performers ?? req.body?.players)
    ? (req.body.performers ?? req.body.players) : [];
  const size = statSync(itemPath(name)).size;
  const jobs = ids.map((pid) => pushLibraryItem(String(pid), name, size));
  // Carry the asset's default duration — the media_op writes the state
  // entry even if the file hasn't landed yet, so it applies on arrival.
  const dur = itemMeta(name).duration;
  if (dur) {
    for (const pid of ids) {
      try {
        await requestFromPerformer(String(pid), {
          type: 'media_op', op: 'duration', name, seconds: dur,
        }, 5000);
      } catch { /* offline display — duration applies on next sync */ }
    }
  }
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
  const results = (pl.performers ?? pl.players).length ? await syncPlaylist(name) : {};
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

// -- Collections (groups & ensembles) --------------------------------------
// A group is an administrative collection (targeting/organization, optional
// content/settings replication when mirrored). An ensemble is the conducted
// unit. `orchestrated` marks an ensemble; `mirrored` makes members act as
// one — one configuration for a group, one synchronized display for an
// ensemble. See design spec section 6.

app.get('/api/collections', (_req, res) => {
  res.json({ collections: listCollections() });
});

app.post(['/api/collections', '/api/collections/:id'], (req, res) => {
  const body = { ...(req.body || {}) };
  if (req.params.id) body.id = req.params.id;
  res.json({ collection: putCollection(body) });
});

app.delete('/api/collections/:id', (req, res) => {
  if (!deleteCollection(req.params.id)) {
    return res.status(404).json({ error: 'unknown collection' });
  }
  res.json({ ok: true });
});

// -- Ensemble hold + idle image --------------------------------------------
// `ensemble_hold` is an ordinary performer setting — it rides the
// set_setting wire (and the offline queue) like every other setting.
async function setEnsembleOn(ids, held) {
  const results = {};
  await Promise.all(
    ids.map(async (pid) => {
      try {
        const reply = await requestFromPerformer(pid, {
          type: 'set_setting',
          settings: { ensemble_hold: Boolean(held) },
        });
        results[pid] = { ok: true, saved: reply.saved };
      } catch (e) {
        results[pid] = { ok: false, error: e.message };
      }
    }),
  );
  return results;
}

app.post('/api/performers/:id/ensemble', async (req, res) => {
  res.json(await setEnsembleOn([req.params.id], req.body?.held));
});

// The idle image lives outside the playlist — the display pulls it into its
// profile and shows it as the standby/armed surface (spec 6.x).
async function pushIdleTo(ids, name, slot) {
  const results = {};
  await Promise.all(
    ids.map(async (pid) => {
      const base = performerBaseUrl(pid);
      const token = registry.performers.get(pid)?.token;
      if (!base) {
        results[pid] = { ok: false, error: 'display offline' };
        return;
      }
      try {
        const reply = await requestFromPerformer(pid, {
          type: 'set_idle',
          name,
          slot: slot === 'off' ? 'off' : 'idle',
          url:
            `${base}/api/library/file/${encodeURIComponent(name)}` +
            (token ? `?token=${encodeURIComponent(token)}` : ''),
          sha256: itemSha256(name),
        }, 60_000);
        results[pid] = { ok: reply.ok !== false, error: reply.error };
      } catch (e) {
        results[pid] = { ok: false, error: e.message };
      }
    }),
  );
  return results;
}

app.post('/api/performers/:id/idle', async (req, res) => {
  const name = validName(req.body?.name);
  if (!name || !hasItem(name)) {
    return res.status(404).json({ error: 'unknown library item' });
  }
  res.json(await pushIdleTo([req.params.id], name, req.body?.slot));
});

app.post('/api/performers/:id/idle/clear', async (req, res) => {
  try {
    const reply = await requestFromPerformer(req.params.id, {
      type: 'clear_idle',
      slot: req.body?.slot === 'off' ? 'off' : 'idle',
    });
    res.json({ ok: reply.ok !== false });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Collection fan-out — members resolved through resolveTargets, deduped.
app.post('/api/collections/:id/ensemble', async (req, res) => {
  const col = getCollection(req.params.id);
  if (!col) return res.status(404).json({ error: 'unknown collection' });
  res.json(await setEnsembleOn(resolveTargets([col.id]), req.body?.held));
});

app.post('/api/collections/:id/idle', async (req, res) => {
  const col = getCollection(req.params.id);
  if (!col) return res.status(404).json({ error: 'unknown collection' });
  const name = validName(req.body?.name);
  if (!name || !hasItem(name)) {
    return res.status(404).json({ error: 'unknown library item' });
  }
  res.json(await pushIdleTo(resolveTargets([col.id]), name, req.body?.slot));
});

// Conductor — synchronized multi-display arm/go. Arm probes each display's
// monotonic clock and stages item 0 (videos paused on frame one, images
// shown statically); go converts one release instant into every display's
// own clock domain so they all start together regardless of socket jitter.
//
// POST /api/conductor/prepare { performers?: [id] }  stage + probe clocks
// POST /api/conductor/perform { lead_ms?, policy?,   release the staged set
//                               min_ready? }         policy: all|min|any
// POST /api/conductor/cancel                         cancel a staged session
// GET  /api/conductor                                session + readiness
// Legacy verbs arm/go/disarm map onto the same handlers.
const conductor = {
  prepared: false,
  performers: new Set(),   // ids staged by the last prepare
  prepared_at: null,
};

// Clocks drift — refresh samples while a session stays prepared so a long
// hold doesn't skew the release deadline. Probe traffic is trivial vs. skew.
setInterval(() => {
  if (!conductor.prepared) return;
  for (const id of conductor.performers) {
    probeClock(id).catch(() => {});
  }
}, 30_000).unref();

function conductorReadiness() {
  const rows = [...conductor.performers].map((id) => ({
    performer_id: id,
    online: performerOnline(id),
    prepared: Boolean(
      registry.performers.get(id)?.status?.prepared ??
      registry.performers.get(id)?.status?.armed   // legacy performers
    ),
    clock: clockInfo(id),
  }));
  return {
    prepared: conductor.prepared,
    prepared_at: conductor.prepared_at,
    performers: rows,
    ready: rows.filter((r) => r.online && r.prepared).length,
    total: rows.length,
  };
}

app.get('/api/conductor', (_req, res) => {
  res.json({ ...conductorReadiness(), wait_loops: listWaitLoops() });
});

app.post('/api/conductor/:cmd', async (req, res) => {
  // Legacy verb aliases: arm->prepare, go->perform, disarm->cancel.
  const cmd = { arm: 'prepare', go: 'perform', disarm: 'cancel' }[
    req.params.cmd
  ] ?? req.params.cmd;
  const rawTargets = req.body?.performers ?? req.body?.players;
  const targets = Array.isArray(rawTargets)
    ? resolveTargets(rawTargets).filter((id) =>
        livePerformerIds().includes(id))
    : livePerformerIds();
  // Wait-loop ensembles among the named collections — their members get
  // the loop_wait flag so each pass end re-arms for the next release.
  const waitMembers = new Set(
    (Array.isArray(rawTargets) ? waitLoopTargets(rawTargets) : []).flatMap(
      (c) => c.members,
    ),
  );

  if (cmd === 'prepare') {
    conductor.performers = new Set(targets);
    conductor.prepared = true;
    conductor.prepared_at = new Date().toISOString();
    // Probe before staging so the clock sample exists by the time
    // perform fires.
    await Promise.allSettled(targets.map((id) => probeClock(id)));
    const sent = targets.filter((id) =>
      sendToPerformer(id, {
        type: 'command',
        cmd: 'prepare',
        loop_wait: waitMembers.has(id),
      })
    );
    return res.json({ ok: true, cmd, delivered: sent.length, performers: sent });
  }

  if (cmd === 'perform') {
    if (!conductor.prepared) {
      return res.status(409).json({ error: 'nothing prepared — POST /api/conductor/prepare first' });
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
    for (const id of conductor.performers) {
      const st = registry.performers.get(id)?.status;
      const prepared = st?.prepared ?? st?.armed;
      if (!performerOnline(id) || !prepared) {
        results[id] = { released: false, reason: 'not prepared' };
        continue;
      }
      const at = deadlineFor(id, leadMs);
      results[id] = at === null
        ? { released: false, reason: 'no clock sample' }
        : { released: sendToPerformer(id, {
            type: 'command',
            cmd: 'perform',
            at_mono: at,
            loop_wait: waitMembers.has(id),
          }), at_mono: at };
    }
    conductor.prepared = false;
    conductor.performers = new Set();
    // Arm a wait-loop barrier for each wait-loop ensemble named in the
    // targets — only members that actually released join the round.
    if (Array.isArray(rawTargets)) {
      for (const col of waitLoopTargets(rawTargets)) {
        const released = col.members.filter((m) => results[m]?.released);
        if (released.length) {
          armWaitLoop(col.id, released, {
            lead_ms: leadMs,
            policy,
            min_ready: minReady,
          });
        }
      }
    }
    return res.json({ ok: true, cmd, lead_ms: leadMs, results });
  }

  if (cmd === 'cancel') {
    // Cancel a staged session — 'cancel' clears the armed state on the
    // display synchronously, so an immediate re-prepare can't be wiped
    // by a deferred ambient restart. 'restart' follows for builds that
    // predate the cancel command (it's a no-op-ish requeue on new ones).
    const cancelTargets = Array.isArray(rawTargets)
      ? new Set(targets)
      : new Set(conductor.performers);
    const sent = [...cancelTargets].filter((id) =>
      sendToPerformer(id, { type: 'command', cmd: 'cancel' })
    );
    for (const id of cancelTargets) {
      sendToPerformer(id, { type: 'command', cmd: 'restart' });
    }
    // Drop any wait-loop barrier the cancel touches — named collections
    // directly, or a barrier whose members are all in the cancel set.
    let disarmed = 0;
    if (Array.isArray(rawTargets)) {
      for (const col of waitLoopTargets(rawTargets)) {
        disarmed += disarmWaitLoop(col.id);
      }
    }
    for (const wl of listWaitLoops()) {
      if (wl.waiting.concat(wl.done).every((id) => cancelTargets.has(id))) {
        disarmed += disarmWaitLoop(wl.collection);
      }
    }
    conductor.prepared = false;
    conductor.performers = new Set();
    return res.json({ ok: true, cmd, delivered: sent.length, ...(disarmed ? { wait_loops_disarmed: disarmed } : {}) });
  }

  res.status(400).json({ error: 'prepare|perform|cancel only' });
});

// Backup — GET streams a tar.gz of the whole data volume (registry,
// playlists, library, triggers, auth). Restore stages the upload under
// data/restore-pending/; it applies on the next boot (see restore.js).
app.get('/api/backup', async (_req, res) => {
  try {
    await streamBackup(res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.post('/api/backup/restore', async (req, res) => {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: 'backup too large' });
    }
    chunks.push(c);
  }
  try {
    const files = await stageRestore(Buffer.concat(chunks));
    res.json({ ok: true, files, note: 'restore applies on restart' });
  } catch (e) {
    res.status(400).json({ error: `invalid backup: ${e.message}` });
  }
});

app.delete('/api/performers/:id', (req, res) => {
  if (!registry.remove(req.params.id)) {
    return res.status(404).json({ error: 'unknown performer' });
  }
  disconnectPerformer(req.params.id);
  res.json({ ok: true });
});

// TLS is opt-in: set TLS_CERT + TLS_KEY and both HTTP and the performer
// socket become https/wss. Displays just dial wss://; set the display's
// tls_insecure for self-signed LAN certs.
const server = process.env.TLS_CERT && process.env.TLS_KEY
  ? createSecureServer(
      {
        cert: readFile(process.env.TLS_CERT),
        key: readFile(process.env.TLS_KEY),
      },
      app,
    )
  : createServer(app);
// 16 MB covers the largest display reply (8 MB thumbnail proxy, base64).
const wss = new WebSocketServer({
  server,
  path: '/ws/player',
  maxPayload: 16 * 1024 * 1024,
});
wss.on('connection', handlePerformerConnection);
startHeartbeat(wss);
startScheduler();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    registry.flush();
    process.exit(0);
  });
}

await seedDefaultUser();

server.listen(config.port, config.host, () => {
  console.log(
    `Screensemble Conductor listening on ${config.host}:${config.port} (role: ${config.serverRole})`,
  );
});
