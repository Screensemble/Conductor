import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Persistent player registry — displays that completed pairing. JSON file
// so the registry survives server restarts.
const FILE = join(process.cwd(), 'data', 'players.json');

function load() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
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

export const registry = {
  players: new Map(Object.entries(load())),

  upsert(id, info) {
    const player = { ...(this.players.get(id) || {}), ...info, id };
    this.players.set(id, player);
    save(this.players);
    return player;
  },

  remove(id) {
    const gone = this.players.delete(id);
    if (gone) save(this.players);
    return gone;
  },

  list() {
    return [...this.players.values()];
  },
};
