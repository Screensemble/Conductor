import { getCollection } from './collections.js';
import {
  deadlineFor,
  performerOnline,
  probeClock,
  sendToPerformer,
} from './performers.js';
import { registry } from './registry.js';

// Wait-loop barriers — an orchestrated ensemble with `wait_loop` set
// loops round-for-round together, not just start-for-start. Each member
// re-arms at its pass boundary and reports `round_done`; once the
// readiness policy is met the conductor releases the whole set on a
// fresh shared deadline. At `loop_target` rounds the members are
// cancelled back to ambient playback and the barrier dissolves.
//
// Barriers are runtime state only — a conductor restart leaves staged
// members parked (harmless: an admin cancel or re-sync unsticks them).

const barriers = new Map(); // collection_id -> barrier

export function listWaitLoops() {
  return [...barriers.values()].map((b) => ({
    collection: b.collection,
    round: b.round,
    target: b.target,
    released: b.released,
    waiting: [...b.members].filter((id) => !b.done.has(id)),
    done: [...b.done],
  }));
}

// Collections in a raw target list (pre-resolution: collection ids and
// performer ids can mix) that run a wait loop.
export function waitLoopTargets(rawIds) {
  const out = [];
  for (const id of rawIds ?? []) {
    const col = getCollection(String(id));
    if (col?.orchestrated && col?.wait_loop) out.push(col);
  }
  return out;
}

// Arm after a synchronized release on a wait-loop collection. `members`
// should be the released subset only — each member's reported
// round_done is recorded as its baseline so a stale counter from an
// earlier session can't fake readiness.
export function armWaitLoop(collectionId, members, opts = {}) {
  const col = getCollection(collectionId);
  if (!col?.orchestrated || !col?.wait_loop) return null;
  const ids = [...new Set(members)].filter((id) => col.members.includes(id));
  if (!ids.length) return null;
  const barrier = {
    collection: collectionId,
    round: 1,
    target: col.loop_target || 0,
    lead_ms: Number(opts.lead_ms) || 800,
    policy: opts.policy ?? 'all',
    min_ready: Number(opts.min_ready) || 0,
    members: new Set(ids),
    baseline: new Map(
      ids.map((id) => [
        id,
        Number(registry.performers.get(id)?.status?.round_done) || 0,
      ]),
    ),
    done: new Set(),
    released: false, // the barrier itself sent this round's perform
    releasedAt: 0,
    releasing: false,
    catching: new Set(),
  };
  barriers.set(collectionId, barrier);
  console.log(
    `wait-loop armed: ${collectionId} (${ids.length} members, ` +
      `target=${barrier.target || 'forever'})`,
  );
  return barrier;
}

// End a barrier without releasing its members — they stay parked at
// their boundary until a cancel/restart lands (the conductor cancel
// route sends one).
export function disarmWaitLoop(collectionId = null) {
  if (collectionId === null) {
    const n = barriers.size;
    barriers.clear();
    return n;
  }
  return barriers.delete(collectionId) ? 1 : 0;
}

// Called for every performer status message (registered via
// performers.setStatusHook). A member whose round_done reached the
// expectation for the current round is ready.
export function onPerformerStatus(id, status) {
  const rd = Number(status?.round_done);
  if (!Number.isFinite(rd)) return;
  for (const b of barriers.values()) {
    if (!b.members.has(id) || b.done.has(id)) continue;
    const expect = (b.baseline.get(id) ?? 0) + b.round;
    if (rd >= expect) {
      b.done.add(id);
      void maybeRelease(b);
      continue;
    }
    // A member exactly one release behind and still parked at its
    // boundary well past the release window (e.g. it was offline when
    // this round's perform went out) gets an individual catch-up
    // release. The grace matters: a member holding a scheduled
    // release looks identical until its deadline fires, and a
    // catch-up perform triggers a status push — without the gate the
    // pair feedback-loops forever.
    if (
      b.released &&
      rd === expect - 1 &&
      status?.waiting &&
      Date.now() - b.releasedAt >
        Math.max(5000, b.lead_ms * 2) &&
      !b.catching.has(id)
    ) {
      b.catching.add(id);
      void catchUp(id, b).finally(() => b.catching.delete(id));
    }
  }
}

function needed(b) {
  if (b.policy === 'any') return 1;
  if (b.policy === 'min') {
    return Math.max(1, Math.min(b.members.size, b.min_ready || 1));
  }
  return b.members.size; // 'all'
}

async function catchUp(id, b) {
  await probeClock(id).catch(() => {});
  const at = deadlineFor(id, b.lead_ms);
  if (at !== null) {
    sendToPerformer(id, {
      type: 'command',
      cmd: 'perform',
      at_mono: at,
      loop_wait: true,
    });
    console.log(`wait-loop ${b.collection}: catch-up release to ${id}`);
  }
}

async function maybeRelease(b) {
  if (b.releasing || b.done.size < needed(b)) return;
  b.releasing = true; // status bursts could re-enter mid-probe
  try {
    if (b.target && b.round >= b.target) {
      // Final round complete — hand members back to ambient playback.
      for (const id of b.members) {
        sendToPerformer(id, { type: 'command', cmd: 'cancel' });
      }
      barriers.delete(b.collection);
      console.log(
        `wait-loop ${b.collection}: ${b.round} round(s) done — released`,
      );
      return;
    }
    const next = b.round + 1;
    // Re-probe before each release — clocks drift between rounds.
    await Promise.allSettled([...b.members].map((id) => probeClock(id)));
    const released = [];
    for (const id of b.members) {
      if (!performerOnline(id)) continue;
      const at = deadlineFor(id, b.lead_ms);
      if (
        at !== null &&
        sendToPerformer(id, {
          type: 'command',
          cmd: 'perform',
          at_mono: at,
          loop_wait: true,
        })
      ) {
        released.push(id);
      }
    }
    b.round = next;
    b.done.clear();
    b.released = true;
    b.releasedAt = Date.now();
    console.log(
      `wait-loop ${b.collection}: released round ${next} ` +
        `(${released.length}/${b.members.size})`,
    );
  } finally {
    b.releasing = false;
  }
}
