import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { triggerRouter } from './triggers.js';
import { pairingRouter } from './pairing.js';
import {
  handlePlayerConnection,
  livePlayerIds,
  playerOnline,
  requestFromPlayer,
  sendToPlayer,
} from './players.js';
import { registry } from './registry.js';
import {
  jobList,
  pushLibraryItem,
  pushToPlayer,
  serveStaged,
} from './uploads.js';
import {
  cleanName,
  deleteItem,
  hasItem,
  itemPath,
  listItems,
  saveItem,
  serveItem,
} from './library.js';
import {
  deletePlaylist,
  listPlaylists,
  putPlaylist,
  syncPlaylist,
} from './playlists.js';
import { statSync } from 'node:fs';

const app = express();
app.use(express.json());
app.use(express.static('public'));

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

app.use('/api/triggers', triggerRouter);
app.use('/api/pair', pairingRouter);

// -- Fleet view ----------------------------------------------------------
// Displays hold a persistent WebSocket to /ws/player — "online" is simply
// whether that socket is live; status arrives pushed every few seconds.
app.get('/api/players', (_req, res) => {
  res.json({
    players: registry
      .list()
      .map((p) => ({ ...p, online: playerOnline(p.id) })),
  });
});

// Single display detail — registry record + live status + online flag.
app.get('/api/players/:id', (req, res) => {
  const p = registry.players.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unknown player' });
  res.json({ ...p, online: playerOnline(p.id) });
});

app.post('/api/players/:id/labels', (req, res) => {
  const p = registry.players.get(req.params.id);
  const labels = req.body?.labels;
  if (!p) return res.status(404).json({ error: 'unknown player' });
  if (!Array.isArray(labels)) {
    return res.status(400).json({ error: 'labels must be an array' });
  }
  res.json({ player: registry.upsert(p.id, { labels: labels.map(String) }) });
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
      type: 'media_op',
      op: req.params.op,
      ...(req.body || {}),
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
app.post(
  '/api/players/:id/upload',
  express.raw({ type: () => true, limit: '4gb' }),
  (req, res) => {
    const p = registry.players.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'unknown player' });
    const name = cleanName(req.query.name || 'file.bin');
    saveItem(name, req.body);   // the library keeps a copy for re-push
    const job = pushLibraryItem(req.params.id, name, req.body.length);
    res.status(job.state === 'error' ? 502 : 202).json({ job });
  },
);

// -- Media library ---------------------------------------------------------
// Permanent server-side store shared across displays and playlists.

app.get('/api/library', (_req, res) => {
  res.json({ items: listItems() });
});

app.post(
  '/api/library',
  express.raw({ type: () => true, limit: '4gb' }),
  (req, res) => {
    const name = cleanName(req.query.name || 'file.bin');
    saveItem(name, req.body);
    res.status(201).json({ ok: true, name });
  },
);

app.delete('/api/library/:name', (req, res) => {
  const name = cleanName(req.params.name);
  if (!hasItem(name)) return res.status(404).json({ error: 'not found' });
  deleteItem(name);
  res.json({ ok: true });
});

// The display's pull target — also serves browser thumbnails.
app.get('/api/library/file/:name', (req, res) => {
  serveItem(req.params.name, res);
});

// Copy a library item to one or more displays.
app.post('/api/library/:name/push', (req, res) => {
  const name = cleanName(req.params.name);
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
  if (!name) return res.status(400).json({ error: 'name required' });
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

// The display's pull target for staged uploads.
app.get('/api/uploads/file/:fileId', (req, res) => {
  serveStaged(req.params.fileId, res);
});

// Conductor — broadcast arm/go to every connected display. Arm stages

// Conductor — broadcast arm/go to every connected display. Arm stages
// item 0 (videos paused on frame one, images shown); go releases all of
// them at once for synchronized starts.
app.post('/api/conductor/:cmd', (req, res) => {
  const cmd = req.params.cmd;
  if (cmd !== 'arm' && cmd !== 'go') {
    return res.status(400).json({ error: 'arm|go only' });
  }
  const sent = livePlayerIds().filter((id) =>
    sendToPlayer(id, { type: 'command', cmd })
  );
  res.json({ ok: true, cmd, delivered: sent.length, players: sent });
});

app.delete('/api/players/:id', (req, res) => {
  if (!registry.remove(req.params.id)) {
    return res.status(404).json({ error: 'unknown player' });
  }
  res.json({ ok: true });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/player' });
wss.on('connection', handlePlayerConnection);

server.listen(config.port, config.host, () => {
  console.log(
    `screensemble-server listening on ${config.host}:${config.port} (role: ${config.serverRole})`,
  );
});
