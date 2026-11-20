import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';

// Server-side media library — every upload lands here permanently so
// content can be re-pushed to other displays or composed into shared
// playlists. Displays pull files back over plain HTTP, so the library
// file URL doubles as the pull target.
const DIR = join(process.cwd(), 'data', 'library');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.mpg', '.mpeg',
]);

export function cleanName(name) {
  return basename(String(name || '')).trim();
}

export function listItems() {
  mkdirSync(DIR, { recursive: true });
  const items = [];
  for (const name of readdirSync(DIR)) {
    const ext = extname(name).toLowerCase();
    const kind = IMAGE_EXTS.has(ext)
      ? 'image'
      : VIDEO_EXTS.has(ext)
        ? 'video'
        : null;
    if (!kind) continue;
    const st = statSync(join(DIR, name));
    items.push({ name, kind, size: st.size, mtime: st.mtimeMs });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export function itemPath(name) {
  return join(DIR, cleanName(name));
}

export function hasItem(name) {
  return existsSync(itemPath(name));
}

export function saveItem(name, buffer) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(itemPath(name), buffer);
}

export function deleteItem(name) {
  const p = itemPath(name);
  if (existsSync(p)) unlinkSync(p);
  HASHES.delete(cleanName(name));
}

// Content hashes for pull verification — cached by mtime so a big file
// isn't re-hashed on every push to every display.
const HASHES = new Map();   // cleanName -> { mtime, size, sha }

export function itemSha256(name) {
  const p = itemPath(name);
  const st = statSync(p);
  const key = cleanName(name);
  const cached = HASHES.get(key);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
    return cached.sha;
  }
  const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
  HASHES.set(key, { mtime: st.mtimeMs, size: st.size, sha });
  return sha;
}

export function serveItem(name, res) {
  const p = itemPath(name);
  if (!existsSync(p)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const ext = extname(p).slice(1).toLowerCase();
  res.setHeader('Content-Type', {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
    mp4: 'video/mp4', webm: 'video/webm', m4v: 'video/mp4',
    mov: 'video/quicktime', mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
  }[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', statSync(p).size);
  createReadStream(p).pipe(res);
}
