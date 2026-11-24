import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Collections — the Group/Ensemble registry (design spec section 6).
//
// A *group* (orchestrated=false) is an administrative collection: targeting,
// organization, and optional content/settings replication. An *ensemble*
// (orchestrated=true) is the conducted unit — it stages and releases as one
// instrument. `mirrored` is an adjective on both: a mirrored group presents
// as one configuration; a mirrored ensemble as one synchronized display.
const FILE = join(process.cwd(), 'data', 'collections.json');
let collections = Object.create(null);
try {
  Object.assign(collections, JSON.parse(readFileSync(FILE, 'utf8')));
} catch {
  /* first run */
}

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(collections, null, 2));
}

export function listCollections() {
  return Object.values(collections);
}

export function getCollection(id) {
  return collections[id] ?? null;
}

export function putCollection(data) {
  const id = data.id ? String(data.id) : `col_${randomBytes(6).toString('hex')}`;
  const prev = collections[id] ?? {};
  collections[id] = {
    id,
    name: String(data.name ?? prev.name ?? '').trim().slice(0, 100),
    orchestrated: Boolean(data.orchestrated ?? prev.orchestrated),
    mirrored: Boolean(data.mirrored ?? prev.mirrored),
    // Wait-loop (orchestrated ensembles only): members re-arm at each
    // pass boundary and hold for the conductor's next synchronized
    // release, so the whole ensemble loops round-for-round together.
    // loop_target = synchronized rounds before releasing members back
    // to ambient playback (0 = loop together forever).
    wait_loop: Boolean(data.wait_loop ?? prev.wait_loop),
    loop_target: Math.max(
      0,
      Math.min(10000, Number(data.loop_target ?? prev.loop_target) || 0),
    ),
    members: [...new Set(
      (Array.isArray(data.members) ? data.members : prev.members ?? [])
        .map(String),
    )],
    updated: Date.now(),
  };
  save();
  return collections[id];
}

export function deleteCollection(id) {
  if (!collections[id]) return false;
  delete collections[id];
  save();
  return true;
}

// Resolve a mixed list of collection ids and performer ids into a deduped
// performer-id set — a display reachable through two collections (or named
// directly and via a collection) is targeted once.
export function resolveTargets(ids) {
  const out = new Set();
  for (const id of ids ?? []) {
    const col = collections[String(id)];
    if (col) for (const m of col.members) out.add(m);
    else out.add(String(id));
  }
  return [...out];
}
