import { MAP_W, MAP_H } from "../shared/gamedefs";

// A* over the tile grid. passable(x,y) must exclude building tiles.
// Returns a list of waypoints in tile coords (excluding start, including goal),
// or null if unreachable. Units add their own separation steering on top.

// Reused A* scratch — grown to the largest map seen; avoids 3×W·H allocs/search.
// g/closed values are qualified by per-search stamps, so searches after the first
// don't pay an O(W·H) clearing pass. parent[] is only followed through nodes
// written by the current search and needs no stamp.
let SC_G: Float32Array | null = null;
let SC_PARENT: Int32Array | null = null;
let SC_GSTAMP: Uint32Array | null = null;
let SC_CLOSEDSTAMP: Uint32Array | null = null;
let SC_SEARCH_ID = 0;
function getScratch(n: number): { g: Float32Array; parent: Int32Array; gstamp: Uint32Array; cstamp: Uint32Array; stamp: number } {
  if (!SC_G || SC_G.length < n) {
    SC_G = new Float32Array(n);
    SC_PARENT = new Int32Array(n);
    SC_GSTAMP = new Uint32Array(n);
    SC_CLOSEDSTAMP = new Uint32Array(n);
    SC_SEARCH_ID = 0;
  }
  SC_SEARCH_ID = (SC_SEARCH_ID + 1) >>> 0;
  if (SC_SEARCH_ID === 0) {
    // exceedingly rare wraparound: zero stamps once rather than colliding with them
    SC_GSTAMP!.fill(0);
    SC_CLOSEDSTAMP!.fill(0);
    SC_SEARCH_ID = 1;
  }
  return { g: SC_G, parent: SC_PARENT!, gstamp: SC_GSTAMP!, cstamp: SC_CLOSEDSTAMP!, stamp: SC_SEARCH_ID };
}

// Reused binary-heap backing store for synchronous findPath — findPath is
// non-reentrant (one synchronous search at a time), so module-level grow-only
// typed arrays kill the 2 array allocations (plus their log-n regrowth garbage)
// every search used to make. The heap is always fully drained before return.
let HP_F = new Float64Array(1024);
let HP_I = new Int32Array(1024);
function heapCap(n: number) {
  if (HP_F.length >= n) return;
  let cap = HP_F.length;
  while (cap < n) cap *= 2;
  const nf = new Float64Array(cap);
  nf.set(HP_F);
  HP_F = nf;
  const ni = new Int32Array(cap);
  ni.set(HP_I);
  HP_I = ni;
}

const SQRT2 = Math.SQRT2;
const DIRS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

// Lightweight always-on profiling counters — a few integer increments per
// search, used by test/perfserv.mjs to attribute per-tick A* cost.
export const PATH_STATS = {
  calls: 0, // searches started
  ok: 0, // searches that found a path
  failed: 0, // searches that exhausted the open set or hit the expand cap
  expanded: 0, // total node expansions (the cost driver)
  capped: 0, // searches stopped by maxExpand rather than exhaustion/success
  ms: 0, // wall time inside findPath
  reset() {
    this.calls = 0;
    this.ok = 0;
    this.failed = 0;
    this.expanded = 0;
    this.capped = 0;
    this.ms = 0;
  },
};

export function findPath(
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  passable: (x: number, y: number) => boolean,
  maxExpand = 6000,
  W = MAP_W,
  H = MAP_H,
): { x: number; y: number }[] | null {
  sx |= 0;
  sy |= 0;
  gx |= 0;
  gy |= 0;
  if (sx === gx && sy === gy) return [];
  if (sx < 0 || sy < 0 || sx >= W || sy >= H || gx < 0 || gy < 0 || gx >= W || gy >= H) return null;
  const t0 = performance.now();
  PATH_STATS.calls++;

  // scratch buffers shared across calls — findPath is non-reentrant (single
  // synchronous A*), so module-level arrays kill the 3×W·H per-call allocation
  const { g, parent, gstamp, cstamp, stamp } = getScratch(W * H);

  // Simple binary heap over the shared typed-array store
  let heapLen = 0;
  const push = (f: number, i: number) => {
    heapCap(heapLen + 1);
    let c = heapLen++;
    HP_F[c] = f;
    HP_I[c] = i;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (HP_F[p] <= HP_F[c]) break;
      const tf = HP_F[p];
      HP_F[p] = HP_F[c];
      HP_F[c] = tf;
      const ti = HP_I[p];
      HP_I[p] = HP_I[c];
      HP_I[c] = ti;
      c = p;
    }
  };
  const pop = () => {
    const top = HP_I[0];
    heapLen--;
    const lastF = HP_F[heapLen];
    const lastI = HP_I[heapLen];
    if (heapLen) {
      HP_F[0] = lastF;
      HP_I[0] = lastI;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1,
          r = l + 1;
        let m = c;
        if (l < heapLen && HP_F[l] < HP_F[m]) m = l;
        if (r < heapLen && HP_F[r] < HP_F[m]) m = r;
        if (m === c) break;
        const tf = HP_F[m];
        HP_F[m] = HP_F[c];
        HP_F[c] = tf;
        const ti = HP_I[m];
        HP_I[m] = HP_I[c];
        HP_I[c] = ti;
        c = m;
      }
    }
    return top;
  };

  const h = (x: number, y: number) => {
    const dx = Math.abs(x - gx),
      dy = Math.abs(y - gy);
    return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
  };

  const sIdx = sy * W + sx;
  g[sIdx] = 0;
  gstamp[sIdx] = stamp;
  push(h(sx, sy), sIdx);
  let expanded = 0;

  while (heapLen && expanded++ < maxExpand) {
    const cur = pop();
    if (cstamp[cur] === stamp) continue;
    cstamp[cur] = stamp;
    const cx = cur % W,
      cy = (cur / W) | 0;
    if (cx === gx && cy === gy) {
      const path: { x: number; y: number }[] = [];
      let i = cur;
      while (i !== sIdx && i !== -1) {
        path.push({ x: i % W, y: (i / W) | 0 });
        i = parent[i];
      }
      path.reverse();
      PATH_STATS.ok++;
      PATH_STATS.expanded += expanded;
      PATH_STATS.ms += performance.now() - t0;
      return path;
    }
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx,
        ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (!passable(nx, ny)) continue;
      // prevent diagonal corner cutting through blocked tiles
      if (dx !== 0 && dy !== 0 && (!passable(cx + dx, cy) || !passable(cx, cy + dy))) continue;
      const ni = ny * W + nx;
      if (cstamp[ni] === stamp) continue;
      const ng = g[cur] + cost;
      if (ng < (gstamp[ni] === stamp ? g[ni] : Infinity)) {
        g[ni] = ng;
        gstamp[ni] = stamp;
        parent[ni] = cur;
        push(ng + h(nx, ny), ni);
      }
    }
  }
  PATH_STATS.failed++;
  PATH_STATS.expanded += expanded;
  if (expanded > maxExpand) PATH_STATS.capped++;
  PATH_STATS.ms += performance.now() - t0;
  return null;
}

// ---------------------------------------------------------------------------
// Incremental (resumable) A* engine — one instance per World.
//
// Searches on big maps can legitimately need tens of thousands of expansions
// (a single transcontinental path on a 256×256 map measured up to ~43k
// expansions / ~15ms). Run atomically inside one server tick, a handful of
// those searches blow the entire tick budget. The engine therefore expands a
// search incrementally: step(budget) consumes up to `budget` node expansions
// and either finishes (done=true) or pauses with all state intact, resuming
// exactly where it left off on a later call.
//
// Correctness hinges on strict serialization: at most one search is ever
// active in an engine instance. A paused search owns the scratch arrays and
// the heap storage until it completes or is abandoned — no other search may
// start in the same engine meanwhile (start() implicitly abandons it). This
// is also why the scratch is per-engine rather than module-level: two worlds
// in the same process step interleaved, and a paused search must survive
// other worlds' searches untouched.
// ---------------------------------------------------------------------------
export class AstarEngine {
  private g: Float32Array | null = null;
  private parent: Int32Array | null = null;
  private gstamp: Uint32Array | null = null;
  private cstamp: Uint32Array | null = null;
  private stamp = 0;
  private heapF = new Float64Array(512);
  private heapI = new Int32Array(512);
  private heapLen = 0;

  // active-search state — valid while active===true
  active = false;
  done = false; // search settled (result holds the outcome)
  result: { x: number; y: number }[] | null = null; // path on success, null on unreachable/capped
  expanded = 0; // expansions consumed by the current search so far

  private gx = 0;
  private gy = 0;
  private W = 0;
  private H = 0;
  private pass: ((x: number, y: number) => boolean) | null = null;
  private maxExpand = 0;
  private sIdx = 0;

  private growHeap(n: number) {
    if (this.heapF.length >= n) return;
    let cap = this.heapF.length;
    while (cap < n) cap *= 2;
    const nf = new Float64Array(cap);
    nf.set(this.heapF.subarray(0, this.heapLen));
    this.heapF = nf;
    const ni = new Int32Array(cap);
    ni.set(this.heapI.subarray(0, this.heapLen));
    this.heapI = ni;
  }

  private hpPush(f: number, i: number) {
    this.growHeap(this.heapLen + 1);
    let c = this.heapLen++;
    const F = this.heapF,
      I = this.heapI;
    F[c] = f;
    I[c] = i;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (F[p] <= F[c]) break;
      const tf = F[p];
      F[p] = F[c];
      F[c] = tf;
      const ti = I[p];
      I[p] = I[c];
      I[c] = ti;
      c = p;
    }
  }

  private hpPop(): number {
    const F = this.heapF,
      I = this.heapI;
    const top = I[0];
    const heapLen = --this.heapLen;
    const lastF = F[heapLen];
    const lastI = I[heapLen];
    if (heapLen) {
      F[0] = lastF;
      I[0] = lastI;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1,
          r = l + 1;
        let m = c;
        if (l < heapLen && F[l] < F[m]) m = l;
        if (r < heapLen && F[r] < F[m]) m = r;
        if (m === c) break;
        const tf = F[m];
        F[m] = F[c];
        F[c] = tf;
        const ti = I[m];
        I[m] = I[c];
        I[c] = ti;
        c = m;
      }
    }
    return top;
  }

  // Begin a new search. Any previously paused search is implicitly abandoned
  // (the stamp bump orphans its scratch nodes; its heap is discarded with the
  // length reset). Handles the trivial terminal cases synchronously:
  // start==goal → done with an empty path; out-of-bounds → done with null.
  start(
    sx: number,
    sy: number,
    gx: number,
    gy: number,
    pass: (x: number, y: number) => boolean,
    maxExpand: number,
    W: number,
    H: number,
  ): void {
    sx |= 0;
    sy |= 0;
    gx |= 0;
    gy |= 0;
    const n = W * H;
    if (!this.g || this.g.length < n) {
      this.g = new Float32Array(n);
      this.parent = new Int32Array(n);
      this.gstamp = new Uint32Array(n);
      this.cstamp = new Uint32Array(n);
      this.stamp = 0;
    }
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.gstamp!.fill(0);
      this.cstamp!.fill(0);
      this.stamp = 1;
    }
    this.active = false;
    this.done = false;
    this.result = null;
    this.expanded = 0;
    this.heapLen = 0;
    if (sx === gx && sy === gy) {
      this.done = true;
      this.result = [];
      return;
    }
    if (sx < 0 || sy < 0 || sx >= W || sy >= H || gx < 0 || gy < 0 || gx >= W || gy >= H) {
      this.done = true;
      this.result = null;
      return;
    }
    const sIdx = sy * W + sx;
    PATH_STATS.calls++;
    this.g![sIdx] = 0;
    this.gstamp![sIdx] = this.stamp;
    this.gx = gx;
    this.gy = gy;
    this.W = W;
    this.H = H;
    this.pass = pass;
    this.maxExpand = maxExpand;
    this.sIdx = sIdx;
    const hdx = Math.abs(sx - gx),
      hdy = Math.abs(sy - gy);
    this.hpPush(Math.max(hdx, hdy) + (SQRT2 - 1) * Math.min(hdx, hdy), sIdx);
    this.active = true;
  }

  // Expand up to `budget` nodes. Returns the number of expansions actually
  // consumed (0 when inactive). On completion sets done=true and result to
  // the path (or null). Otherwise the search stays active with every piece
  // of state intact for a later resume.
  step(budget: number): number {
    if (!this.active) return 0;
    const t0 = performance.now();
    const g = this.g!,
      parent = this.parent!,
      gstamp = this.gstamp!,
      cstamp = this.cstamp!,
      pass = this.pass!;
    const stamp = this.stamp,
      W = this.W,
      H = this.H,
      gx = this.gx,
      gy = this.gy,
      maxExpand = this.maxExpand;
    let expanded = this.expanded;
    let used = 0;
    let out: { x: number; y: number }[] | null | undefined;

    outer: while (this.heapLen > 0) {
      if (used >= budget) break;
      if (expanded >= maxExpand) {
        expanded++; // mirror findPath's post-increment cap accounting
        break;
      }
      expanded++;
      used++;
      const cur = this.hpPop();
      if (cstamp[cur] === stamp) continue;
      cstamp[cur] = stamp;
      const cx = cur % W,
        cy = (cur / W) | 0;
      if (cx === gx && cy === gy) {
        const path: { x: number; y: number }[] = [];
        let i = cur;
        while (i !== this.sIdx && i !== -1) {
          path.push({ x: i % W, y: (i / W) | 0 });
          i = parent[i];
        }
        path.reverse();
        out = path;
        break outer;
      }
      for (const [dx, dy, cost] of DIRS) {
        const nx = cx + dx,
          ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (!pass(nx, ny)) continue;
        // prevent diagonal corner cutting through blocked tiles
        if (dx !== 0 && dy !== 0 && (!pass(cx + dx, cy) || !pass(cx, cy + dy))) continue;
        const ni = ny * W + nx;
        if (cstamp[ni] === stamp) continue;
        const ng = g[cur] + cost;
        if (ng < (gstamp[ni] === stamp ? g[ni] : Infinity)) {
          g[ni] = ng;
          gstamp[ni] = stamp;
          parent[ni] = cur;
          const hdx = Math.abs(nx - gx),
            hdy = Math.abs(ny - gy);
          this.hpPush(ng + Math.max(hdx, hdy) + (SQRT2 - 1) * Math.min(hdx, hdy), ni);
        }
      }
    }

    this.expanded = expanded;
    PATH_STATS.expanded += used;
    PATH_STATS.ms += performance.now() - t0;
    if (out !== undefined) {
      this.active = false;
      this.done = true;
      this.result = out;
      this.heapLen = 0;
      PATH_STATS.ok++;
    } else if (this.heapLen === 0 || expanded > maxExpand) {
      // open set exhausted (unreachable) or expansion cap hit — the search is
      // settled WITHOUT a path. Crucially this is a *capacity* answer, never a
      // budget artifact: budget pauses simply leave the search active.
      this.active = false;
      this.done = true;
      this.result = null;
      this.heapLen = 0;
      PATH_STATS.failed++;
      if (expanded > maxExpand) PATH_STATS.capped++;
    }
    return used;
  }

  // Abandon the active search (if any) without a result — used when the unit
  // retargets/dies mid-search. Scratch nodes are orphaned via the next start's
  // stamp bump, so no clearing pass is needed.
  abandon() {
    this.active = false;
    this.done = false;
    this.result = null;
    this.heapLen = 0;
  }
}

// Nearest passable tile to (x,y) within radius r, BFS ring search.
export function nearestPassable(
  x: number,
  y: number,
  passable: (x: number, y: number) => boolean,
  r = 8,
  W = MAP_W,
  H = MAP_H,
): { x: number; y: number } | null {
  x |= 0;
  y |= 0;
  if (x >= 0 && y >= 0 && x < W && y < H && passable(x, y)) return { x, y };
  for (let d = 1; d <= r; d++) {
    for (let dy = -d; dy <= d; dy++) {
      for (let dx = -d; dx <= d; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (passable(nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  return null;
}
