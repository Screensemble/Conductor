import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createGzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const DATA = join(process.cwd(), 'data');
const STAGING = join(DATA, 'restore-pending');

// Minimal ustar writer/reader — backup and restore without native deps so
// the Docker image stays small and the file format stays standard (any
// `tar` can unpack what we write and we can unpack what `tar` writes).

function header(name, size, mtime, isDir) {
  const buf = Buffer.alloc(512);
  const write = (s, off, len) => buf.write(String(s).slice(0, len), off, 'utf8');
  // ustar split for names over 100 chars: /prefix/name.
  if (name.length <= 100) {
    write(name, 0, 100);
  } else {
    const cut = name.lastIndexOf('/', 155);
    if (cut === -1 || name.length - cut - 1 > 100) {
      throw new Error(`path too long for tar: ${name}`);
    }
    write(name.slice(cut + 1), 0, 100);
    write(name.slice(0, cut), 345, 155);
  }
  write('000644', 100, 8);                    // mode
  write('000000', 108, 8); write('000000', 116, 8); // uid/gid
  write(size.toString(8).padStart(11, '0'), 124, 12);
  write(Math.floor(mtime / 1000).toString(8).padStart(11, '0'), 136, 12);
  buf.fill(0x20, 148, 156);                   // checksum field = spaces
  buf.write(isDir ? '5' : '0', 156);          // typeflag
  buf.write('ustar', 257);                    // magic
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + ' ', 148, 8);
  return buf;
}

async function* walk(dir, base = dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(base, p).split(sep).join('/');
    if (rel === 'restore-pending' || rel.startsWith('restore-pending/')) continue;
    if (e.isDirectory()) yield* walk(p, base);
    else if (e.isFile()) yield { path: p, rel };
  }
}

// Streams a tar of data/ (minus any restore staging area).
export async function* tarData() {
  for await (const f of walk(DATA)) {
    const st = await fs.stat(f.path);
    yield header(f.rel, st.size, st.mtimeMs, false);
    yield* createReadStream(f.path);
    const pad = (512 - (st.size % 512)) % 512;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(1024); // end-of-archive marker
}

// GET /api/backup — tar.gz of the whole data volume.
export function streamBackup(res) {
  res.setHeader('content-type', 'application/gzip');
  res.setHeader('content-disposition',
    `attachment; filename="screensemble-backup-${new Date().toISOString().slice(0, 10)}.tar.gz"`);
  return pipeline(Readable.from(tarData()), createGzip(), res);
}

// Parse the smallest useful subset of ustar: file entries. Everything else
// (dirs, links, pax) is skipped — our own backups only contain files.
export async function untarTo(buf, dest) {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  let off = 0, count = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString().replaceAll('\0', '');
    const prefix = h.subarray(345, 500).toString().replaceAll('\0', '');
    const size = parseInt(h.subarray(124, 136).toString().trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    off += 512;
    if (type === '0' || type === '\0' || type === '') {
      const rel = prefix ? `${prefix}/${name}` : name;
      // Path-safety: refuse anything escaping the staging dir.
      if (!rel || rel.startsWith('..') || rel.includes('/../') || rel.startsWith('/')) {
        off += Math.ceil(size / 512) * 512;
        continue;
      }
      const out = join(dest, rel);
      await fs.mkdir(dirname(out), { recursive: true });
      await fs.writeFile(out, buf.subarray(off, off + size));
      count += 1;
    }
    off += Math.ceil(size / 512) * 512;
  }
  return count;
}

// POST /api/backup/restore — gunzip + untar into data/restore-pending/.
// index.js's restore swap applies it on next boot (restore.js runs before
// any module opens data files).
export async function stageRestore(raw) {
  const buf = raw.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))
    ? gunzipSync(raw) : raw;
  const files = await untarTo(buf, STAGING);
  if (!files) {
    await fs.rm(STAGING, { recursive: true, force: true });
    throw new Error('no files in archive');
  }
  return files;
}
