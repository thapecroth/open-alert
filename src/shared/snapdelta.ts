// Keyframe+delta snapshot compression, shared 1:1 between the authoritative
// server (src/worker.ts diffing side) and clients (src/client/net.ts plus the
// ws test harness reassembly side). Pure functions + a small state machine —
// no runtime imports so Node test harnesses can transpile-load it directly.

import type { EntSnap, EntDelta, CrateSnap, PlayerState, GameEvent } from "./protocol";

// The state-bearing core of a snapshot (events are transient per-frame and
// never diffed — they ride along in full on every frame).
export interface SnapCore {
  ents: EntSnap[];
  crates?: CrateSnap[];
  bridges?: number[];
  players: Record<number, PlayerState>;
}

export interface SnapDiff {
  ents: EntDelta[];
  gone?: number[];
  crates?: CrateSnap[];
  bridges?: number[];
  players?: Record<number, PlayerState>;
}

// scalar fields compared with !== ; rally/wp need element-wise compare because
// a rebuilt object may carry fresh array instances even when logically identical
const SCALARS = ["o", "k", "x", "y", "hp", "mhp", "d", "cargo", "fl", "am", "vet", "hold", "sub", "alt", "disg"] as const;

const arrEq = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (!arrEq(x as unknown[], y as unknown[])) return false;
    } else if (x !== y) return false;
  }
  return true;
};

// null when nothing changed; otherwise a partial carrying only changed fields
// (null value = field vanished). A brand-new ent diff is the ent itself.
export function diffEnts(prev: EntSnap, next: EntSnap): EntDelta | null {
  // snapshot() memoizes per-entity objects, so an unchanged ent rides both
  // frames as the SAME reference — immutable contents make that a proof of
  // no-change and the whole scalar loop can be skipped (the common case)
  if (prev === next) return null;
  let out: EntDelta | null = null;
  for (const f of SCALARS) {
    const a = prev[f] as unknown;
    const b = next[f] as unknown;
    if (a !== b) {
      if (!out) out = { id: next.id };
      (out as Record<string, unknown>)[f] = b === undefined ? null : b;
    }
  }
  if (!arrEq(prev.rally, next.rally)) {
    if (!out) out = { id: next.id };
    out.rally = next.rally ?? null;
  }
  if (!arrEq(prev.wp, next.wp)) {
    if (!out) out = { id: next.id };
    out.wp = next.wp ?? null;
  }
  return out;
}

// Diff two full snapshots. `next` objects are immutable in practice (snapshot()
// memoizes and copy-on-write rebuilds them), so unchanged slices are reused by
// reference and new ents ride the delta as their full object — no copying anywhere.
export function diffSnaps(prev: SnapCore, next: SnapCore): SnapDiff {
  const prevById = new Map<number, EntSnap>();
  for (const e of prev.ents) prevById.set(e.id, e);
  const ents: EntDelta[] = [];
  for (const e of next.ents) {
    const p = prevById.get(e.id);
    // consume the match — whatever remains in prevById at the end is the gone
    // set, so no parallel nextIds Set (and its per-entry garbage) is needed
    prevById.delete(e.id);
    if (!p) {
      ents.push(e);
      continue;
    }
    const d = diffEnts(p, e);
    if (d) ents.push(d);
  }
  const diff: SnapDiff = { ents };
  if (prevById.size) diff.gone = [...prevById.keys()];
  // players/crates/bridges change rarely-enough that a serialized compare is
  // the cheapest correct check (construction order in world.ts is deterministic).
  // Memoized snapshot() output makes identical references the common case, and
  // reference equality on immutable data is a proof of no-change — the string
  // compare (and its per-frame string garbage) only runs after a real rebuild.
  const nextCrates = next.crates ?? [];
  const prevCrates = prev.crates ?? [];
  if (nextCrates !== prevCrates && JSON.stringify(nextCrates) !== JSON.stringify(prevCrates)) diff.crates = nextCrates;
  const nextBridges = next.bridges ?? [];
  const prevBridges = prev.bridges ?? [];
  if (nextBridges !== prevBridges && JSON.stringify(nextBridges) !== JSON.stringify(prevBridges)) diff.bridges = nextBridges;
  let players: Record<number, PlayerState> | undefined;
  for (const k in next.players) {
    const slot = k as unknown as number;
    const ps = next.players[slot];
    const prevPs = prev.players[slot];
    if (!prevPs || (ps !== prevPs && JSON.stringify(ps) !== JSON.stringify(prevPs))) (players ??= {})[slot] = ps;
  }
  if (players) diff.players = players;
  return diff;
}

// Merge a sparse ent partial onto the current ent state. Null-valued keys
// delete the field; absent keys keep the current value. Copy-on-write: the
// input objects are never mutated (renderers retain them for interpolation).
export function applyEntDelta(cur: EntSnap | undefined, d: EntDelta): EntSnap {
  const out: Record<string, unknown> = cur ? { ...cur } : {};
  for (const k of Object.keys(d)) {
    if (k === "id") continue;
    const v = (d as unknown as Record<string, unknown>)[k];
    if (v === null) delete out[k];
    else out[k] = v;
  }
  out.id = d.id;
  return out as unknown as EntSnap;
}

// The reassembled full-snapshot shape consumers have always received.
export interface SnapFull {
  t: "snap";
  seq?: number;
  key?: true;
  tick: number;
  ents: EntSnap[];
  crates?: CrateSnap[];
  bridges?: number[];
  players: Record<number, PlayerState>;
  events: GameEvent[];
}

// Client-side stream state machine. Keyframes replace all state; deltas apply
// onto the preceding seq. Unchanged entity/player objects are reused by
// reference across frames — renderers holding onto them see stable identity,
// while changed ents copy-on-write into fresh objects.
export class SnapReassembler {
  private ents = new Map<number, EntSnap>();
  private players: Record<number, PlayerState> = {};
  private crates: CrateSnap[] | undefined;
  private bridges: number[] | undefined;
  private seq = -1;
  private synced = false;
  // Copy-on-write emission cache: emitted ents arrays / players records are
  // NEVER mutated after emission (test harnesses retain reassembled frames and
  // the client reads them synchronously). When a frame changes nothing in them,
  // the previous emission is reference-reused; any change allocates a fresh copy.
  private entsOut: EntSnap[] = [];
  private entsOutValid = false;
  private playersOut: Record<number, PlayerState> = {};
  private playersOutValid = false;

  reset() {
    this.ents.clear();
    this.players = {};
    this.crates = undefined;
    this.bridges = undefined;
    this.seq = -1;
    this.synced = false;
    this.entsOutValid = false;
    this.playersOutValid = false;
  }

  // Any full-state "snap" message is a keyframe — including legacy server
  // frames (no seq) and in-process localnet frames. Passed through as-is.
  keyframe(k: SnapFull): SnapFull {
    this.ents.clear();
    for (const e of k.ents) this.ents.set(e.id, e);
    const players: Record<number, PlayerState> = {};
    for (const key in k.players) players[key as unknown as number] = k.players[key as unknown as number];
    this.players = players;
    this.crates = k.crates;
    this.bridges = k.bridges;
    this.seq = typeof k.seq === "number" ? k.seq : -1;
    this.synced = true;
    // the keyframe itself is emitted as-is, so the first delta after it must
    // rebuild both emission structures from the freshly replaced state
    this.entsOutValid = false;
    this.playersOutValid = false;
    return k;
  }

  // Returns the reassembled full snapshot, or null when the delta cannot be
  // applied (unsynced or a seq gap — wait for the next keyframe).
  delta(d: {
    seq: number;
    tick: number;
    ents: EntDelta[];
    gone?: number[];
    crates?: CrateSnap[];
    bridges?: number[];
    players?: Record<number, PlayerState>;
    events: GameEvent[];
  }): SnapFull | null {
    // unsequenced streams (localnet) never carry deltas, so a strict +1 check
    // is correct everywhere; a gap means we missed a frame and must resync
    if (!this.synced || d.seq !== this.seq + 1) {
      this.synced = false;
      return null;
    }
    this.seq = d.seq;
    let entsDirty = !this.entsOutValid;
    for (const ed of d.ents) {
      if (!ed || typeof ed.id !== "number") continue;
      this.ents.set(ed.id, applyEntDelta(this.ents.get(ed.id), ed));
      entsDirty = true;
    }
    if (d.gone) {
      for (const id of d.gone) {
        if (this.ents.delete(id)) entsDirty = true;
      }
    }
    if (d.players) {
      for (const k in d.players) this.players[k as unknown as number] = d.players[k as unknown as number];
      this.playersOutValid = false;
    }
    if (d.crates !== undefined) this.crates = d.crates;
    if (d.bridges !== undefined) this.bridges = d.bridges;
    if (entsDirty) {
      this.entsOut = [...this.ents.values()];
      this.entsOutValid = true;
    }
    if (!this.playersOutValid) {
      const players: Record<number, PlayerState> = {};
      for (const k in this.players) players[k as unknown as number] = this.players[k as unknown as number];
      this.playersOut = players;
      this.playersOutValid = true;
    }
    return {
      t: "snap",
      seq: d.seq,
      tick: d.tick,
      ents: this.entsOut,
      crates: this.crates,
      bridges: this.bridges,
      players: this.playersOut,
      events: d.events,
    };
  }
}
