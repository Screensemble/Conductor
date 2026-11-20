import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { itemSha256 } from './library.js';
import {
  playerBaseUrl,
  sendToPlayer,
  setPushProgressHandler,
} from './players.js';

// Upload queue — browsers POST files to the server; each job stages the
// file under data/uploads/ and tells the display to pull it back over
// plain HTTP (still outbound-only from the display's perspective). The
// display streams push_progress frames as it downloads; the dashboard
// toast polls /api/uploads and aggregates every in-flight job.
const DIR = join(process.cwd(), 'data', 'uploads');
const jobs = new Map();   // job id -> job record
const files = new Map();  // file id -> { path, name, size }
const KEEP_DONE_MS = 30_000;

function sweep() {
  const cutoff = Date.now() - KEEP_DONE_MS;
  for (const [id, j] of jobs) {
    if (j.state !== 'queued' && j.state !== 'sending' && j.ts < cutoff) {
      jobs.delete(id);
    }
  }
}

// Display → server progress frames land here via players.js.
setPushProgressHandler((playerId, msg) => {
  const job = jobs.get(msg.job);
  if (!job || job.player !== playerId) return;
  job.received = msg.received ?? job.received;
  job.total = msg.total || job.total;
  job.ts = Date.now();
  if (msg.state === 'done') job.state = 'done';
  else if (msg.state === 'error') {
    job.state = 'error';
    job.error = msg.error || 'transfer failed';
  } else job.state = 'sending';
});

// Queue one pull_file for a display — the job tracks progress frames and
// shows up in the /api/uploads feed the toast aggregates.
function queuePush(playerId, name, url, total, sha256) {
  const job = {
    id: randomBytes(6).toString('hex'),
    player: playerId,
    name,
    total: total || 0,
    received: 0,
    state: 'queued',
    ts: Date.now(),
  };
  jobs.set(job.id, job);
  const sent =
    url &&
    sendToPlayer(playerId, {
      type: 'pull_file',
      id: job.id,
      name,
      url,
      sha256: sha256 || null,
    });
  if (!sent) {
    job.state = 'error';
    job.error = url ? 'display offline' : 'no server url';
  } else {
    job.state = 'sending';
  }
  return job;
}

export function pushToPlayer(playerId, name, buffer) {
  mkdirSync(DIR, { recursive: true });
  const fileId = randomBytes(8).toString('hex');
  const path = join(DIR, fileId);
  writeFileSync(path, buffer);
  files.set(fileId, { path, name, size: buffer.length });

  const base = playerBaseUrl(playerId);
  return queuePush(
    playerId,
    name,
    base && `${base}/api/uploads/file/${fileId}`,
    buffer.length,
    createHash('sha256').update(buffer).digest('hex'),
  );
}

// Push a library file — the library URL is permanent, so copies to other
// displays reuse it directly (no staging copy needed).
export function pushLibraryItem(playerId, name, size) {
  const base = playerBaseUrl(playerId);
  return queuePush(
    playerId,
    name,
    base && `${base}/api/library/file/${encodeURIComponent(name)}`,
    size,
    itemSha256(name),
  );
}

export function jobList() {
  sweep();
  return [...jobs.values()].sort((a, b) => b.ts - a.ts);
}

// Display-side GET target for pull_file.
export function serveStaged(fileId, res) {
  const f = files.get(fileId);
  if (!f || !existsSync(f.path)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', statSync(f.path).size);
  createReadStream(f.path).pipe(res);
}
