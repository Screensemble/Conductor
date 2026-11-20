import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Boot-time restore: a staged backup (data/restore-pending/, written by
// POST /api/backup/restore) is swapped into place BEFORE any module opens
// its data files. This module is imported first in index.js precisely so
// the swap happens before registry/auth/library read their state.
const DATA = join(process.cwd(), 'data');
const PENDING = join(DATA, 'restore-pending');
const OLD = join(DATA, 'restore-old');

if (existsSync(PENDING)) {
  try {
    // Move current data aside (kept as restore-old/ for one boot), then
    // move the staged restore into place.
    rmSync(OLD, { recursive: true, force: true });
    mkdirSync(OLD, { recursive: true });
    const entries = readdirSync(DATA).filter(
      (e) => e !== 'restore-pending' && e !== 'restore-old',
    );
    for (const e of entries) renameSync(join(DATA, e), join(OLD, e));
    for (const e of readdirSync(PENDING)) {
      renameSync(join(PENDING, e), join(DATA, e));
    }
    rmSync(PENDING, { recursive: true, force: true });
    console.log(`restore applied — previous data kept at ${OLD}`);
  } catch (e) {
    console.error(`restore swap failed: ${e.message}`);
  }
}
