import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Persistent performer registry — displays that completed pairing. JSON
// file so the registry survives restarts. performers.json is the live
// file; a legacy players.json is migrated on first load.
const FILE = join(process.cwd(), 'data', 'performers.json');
const LEGACY = join(process.cwd(), 'data', 'players.json');

function load() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch { /* not there */ }
  try {
    const legacy = JSON.parse(readFileSync(LEGACY, 'utf8'));
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(legacy, null, 2));
    renameSync(LEGACY, LEGACY + '.migrated');
    console.log('migrated players.json -> performers.json');
    return legacy;
  } catch {
    return {};
  }
}

function save(map) {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(map), null, 2));
  renameSync(tmp, FILE);
}

let timer = null;

export const registry = {
  performers: new Map(Object.entries(load())),

  upsert(id, info) {
    const performer = { ...(this.performers.get(id) || {}), ...info, id };
    this.performers.set(id, performer);
    if (timer) clearTimeout(timer);
    timer = null;
    save(this.performers);
    return performer;
  },

  // High-frequency updates (status, last_seen) — persisted on a short
  // debounce instead of rewriting performers.json on every message.
  touch(id, info) {
    const cur = this.performers.get(id);
    if (!cur) return null;
    const performer = { ...cur, ...info, id };
    this.performers.set(id, performer);
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        save(this.performers);
      }, 5000);
      timer.unref?.();
    }
    return performer;
  },

  flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    save(this.performers);
  },

  remove(id) {
    const gone = this.performers.delete(id);
    if (gone) save(this.performers);
    return gone;
  },

  list() {
    return [...this.performers.values()];
  },
};
