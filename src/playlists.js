import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { requestFromPlayer } from './players.js';
import { pushLibraryItem } from './uploads.js';
import { hasItem, itemPath } from './library.js';

// Shared playlists — named ordered lists of library items assigned to
// displays. Syncing a playlist pushes any files the display is missing
// (tracked as upload jobs), applies the play order, and optionally
// removes items that aren't in the list.
const FILE = join(process.cwd(), 'data', 'playlists.json');
let playlists = {};
try {
  playlists = JSON.parse(readFileSync(FILE, 'utf8'));
} catch {
  playlists = {};
}

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(playlists, null, 2));
}

export function listPlaylists() {
  return playlists;
}

export function putPlaylist(name, data) {
  playlists[name] = {
    items: (data.items || []).map(String),
    players: (data.players || []).map(String),
    updated: Date.now(),
  };
  save();
  return playlists[name];
}

export function deletePlaylist(name) {
  delete playlists[name];
  save();
}

export async function syncPlaylist(name, { prune = false } = {}) {
  const pl = playlists[name];
  if (!pl) return { error: 'unknown playlist' };
  const results = {};
  for (const pid of pl.players) {
    const r = { ok: true, pushed: [], pruned: [], missing: [] };
    results[pid] = r;
    try {
      const media = await requestFromPlayer(
        pid,
        { type: 'get_media' },
        10000,
      );
      const items = media.items || [];
      const have = new Set(items.map((i) => i.name));
      for (const n of pl.items) {
        if (!hasItem(n)) {
          r.missing.push(n);
          continue;
        }
        if (!have.has(n)) {
          pushLibraryItem(pid, n, statSync(itemPath(n)).size);
          r.pushed.push(n);
        }
      }
      // The order op is name-keyed — each arriving file rescans and the
      // stored order re-applies, so it's safe to set before pushes land.
      await requestFromPlayer(pid, {
        type: 'media_op',
        op: 'order',
        order: pl.items,
      });
      if (prune) {
        for (const i of items) {
          if (!pl.items.includes(i.name) && !i.remote) {
            await requestFromPlayer(pid, {
              type: 'media_op',
              op: 'delete',
              name: i.name,
            });
            r.pruned.push(i.name);
          }
        }
      }
      // 'update' defers to the next item boundary — pushes still in
      // flight re-queue the flag themselves once the batch settles.
      await requestFromPlayer(pid, { type: 'command', cmd: 'update' });
    } catch (e) {
      r.ok = false;
      r.error = e.message;
    }
  }
  return results;
}
