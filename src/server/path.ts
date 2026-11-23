import { MAP_W, MAP_H } from "../shared/gamedefs";

// A* over the tile grid. passable(x,y) must exclude building tiles.
// Returns a list of waypoints in tile coords (excluding start, including goal),
// or null if unreachable. Units add their own separation steering on top.

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

  const g = new Float32Array(W * H).fill(Infinity);
  const parent = new Int32Array(W * H).fill(-1);
  const closed = new Uint8Array(W * H);

  // Simple binary heap of [f, idx]
  const heapF: number[] = [];
  const heapI: number[] = [];
  const push = (f: number, i: number) => {
    heapF.push(f);
    heapI.push(i);
    let c = heapF.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heapF[p] <= heapF[c]) break;
      [heapF[p], heapF[c]] = [heapF[c], heapF[p]];
      [heapI[p], heapI[c]] = [heapI[c], heapI[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heapI[0];
    const lastF = heapF.pop()!;
    const lastI = heapI.pop()!;
    if (heapF.length) {
      heapF[0] = lastF;
      heapI[0] = lastI;
      let c = 0;
      for (;;) {
        let l = c * 2 + 1,
          r = l + 1,
          m = c;
        if (l < heapF.length && heapF[l] < heapF[m]) m = l;
        if (r < heapF.length && heapF[r] < heapF[m]) m = r;
        if (m === c) break;
        [heapF[m], heapF[c]] = [heapF[c], heapF[m]];
        [heapI[m], heapI[c]] = [heapI[c], heapI[m]];
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
  push(h(sx, sy), sIdx);
  let expanded = 0;

  while (heapF.length && expanded++ < maxExpand) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
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
      if (closed[ni]) continue;
      const ng = g[cur] + cost;
      if (ng < g[ni]) {
        g[ni] = ng;
        parent[ni] = cur;
        push(ng + h(nx, ny), ni);
      }
    }
  }
  return null;
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
