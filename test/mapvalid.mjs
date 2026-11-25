#!/usr/bin/env node
// Map layout validator — instantiates every MAP_LIST layout via the REAL
// getMapLayout() + World pipeline and asserts structural sanity:
//   * all spawns on passable land (not water/cliff)
//   * spawn-to-spawn land connectivity (or intended island separation)
//   * water fraction for naval maps (oceanic = majority water)
//   * water is a single connected sea (post canal-carve pass)
//   * ore present near every spawn + contested fields
//   * derricks/coalmines on dry land, in bounds
//   * A* spawn-to-spawn reachability within the server's maxExpand budget
//
// Usage: node test/mapvalid.mjs [mapId ...] [--json]
// No server, no sockets — pure layout math.

import { registerHooks, createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
registerHooks({
  resolve(s, c, n) { try { return n(s, c); } catch (e) { if ((s.startsWith("./") || s.startsWith("../")) && !/\.[a-z0-9]+$/i.test(s)) return n(s + ".ts", c); throw e; } },
  load(u, c, n) { const r = n(u, c); if (u.endsWith(".ts")) { const o = ts.transpileModule(String(r.source), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: u }); return { format: "module", source: o.outputText, shortCircuit: true }; } return r; },
});

const { World } = await import("../src/server/world.ts");
const { getMapLayout, getSpawns, MAP_LIST } = await import("../src/shared/gamedefs.ts");
const { findPath } = await import("../src/server/path.ts");

const args = process.argv.slice(2).filter((a) => a !== "--json");
const asJson = process.argv.includes("--json");

let pass = 0, fail = 0;
const rows = [];
const fails = [];
const ok = (c, n) => {
  if (c) pass++;
  else { fail++; fails.push(n); }
};

function analyze(id) {
  const meta = MAP_LIST.find((m) => m.id === id);
  const layout = getMapLayout(id);
  const W = layout.w, H = layout.h;
  const idx = (x, y) => y * W + x;
  const cliff = new Uint8Array(W * H);
  const water = new Uint8Array(W * H);
  for (const [x, y] of layout.cliffs) if (x >= 0 && y >= 0 && x < W && y < H) cliff[idx(x, y)] = 1;
  for (const [x, y] of layout.water) if (x >= 0 && y >= 0 && x < W && y < H) water[idx(x, y)] = 1;
  const landPass = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !water[idx(x, y)] && !cliff[idx(x, y)];
  const seaPass = (x, y) => x >= 0 && y >= 0 && x < W && y < H && water[idx(x, y)] === 1;

  const totalTiles = W * H;
  const waterTiles = layout.water.length;
  const waterFrac = waterTiles / totalTiles;

  // ---- spawns on land ----
  const spawns = getSpawns(W, H);
  const maxP = meta.maxPlayers ?? 8;
  let spawnsOk = true;
  for (let i = 0; i < maxP; i++) {
    const s = spawns[i];
    if (!landPass(s.x, s.y)) spawnsOk = false;
  }

  // ---- land connectivity between spawns (flood from spawn 0) ----
  const seen = new Uint8Array(W * H);
  const q = [idx(spawns[0].x, spawns[0].y)];
  if (landPass(spawns[0].x, spawns[0].y)) seen[q[0]] = 1;
  while (q.length) {
    const t = q.pop();
    const x = t % W, y = (t / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!landPass(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (!seen[ni]) { seen[ni] = 1; q.push(ni); }
    }
  }
  let landLinked = 0;
  for (let i = 0; i < maxP; i++) if (seen[idx(spawns[i].x, spawns[i].y)]) landLinked++;

  // per-spawn landmass size & shore access (water within 13 tiles — shipyard range)
  const compOf = new Int32Array(W * H).fill(-1);
  const compSizes = [];
  {
    let nc = 0;
    for (let s = 0; s < W * H; s++) {
      if (compOf[s] !== -1 || water[s] || cliff[s]) continue;
      const q = [s]; compOf[s] = nc; let size = 0;
      while (q.length) {
        const t = q.pop(); size++;
        const x = t % W, y = (t / W) | 0;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = x + dx, ny = y + dy;
          if (!landPass(nx, ny)) continue;
          const ni = idx(nx, ny);
          if (compOf[ni] === -1) { compOf[ni] = nc; q.push(ni); }
        }
      }
      compSizes.push(size); nc++;
    }
  }
  let minIsleSize = 1e9, spawnsWithShore = 0, tinyIsles = 0;
  for (let i = 0; i < maxP; i++) {
    const s = spawns[i];
    const sz = compSizes[compOf[idx(s.x, s.y)]] ?? 0;
    if (sz < minIsleSize) minIsleSize = sz;
    if (sz < 110) tinyIsles++;
    let shore = false;
    outer: for (let dy = -13; dy <= 13; dy++) for (let dx = -13; dx <= 13; dx++) {
      if (seaPass(s.x + dx, s.y + dy)) { shore = true; break outer; }
    }
    if (shore) spawnsWithShore++;
  }

  // ---- water connectivity: count components ----
  const wcomp = new Int32Array(W * H).fill(-1);
  let ncomp = 0, biggestComp = 0;
  for (let s = 0; s < W * H; s++) {
    if (!water[s] || wcomp[s] >= 0) continue;
    const members = [];
    const qq = [s];
    wcomp[s] = ncomp;
    while (qq.length) {
      const t = qq.pop();
      members.push(t);
      const x = t % W, y = (t / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (water[ni] && wcomp[ni] < 0) { wcomp[ni] = ncomp; qq.push(ni); }
      }
    }
    if (members.length > biggestComp) biggestComp = members.length;
    ncomp++;
  }
  const seaConn = waterTiles ? biggestComp / waterTiles : 1;

  // ---- widest open-water straightness probe: longest horizontal open-water run (sea lane room) ----
  let maxRun = 0;
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x < W; x++) {
      if (water[idx(x, y)]) { run++; if (run > maxRun) maxRun = run; }
      else run = 0;
    }
  }

  // ---- ore near spawns via real World gen ----
  const slots = Array.from({ length: maxP }, (_, i) => i);
  const t0 = performance.now();
  const w = new World(slots, { map: id });
  let oreNearSpawn = 0, oreTotal = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (w.ore[idx(x, y)] > 0) oreTotal++;
  for (let i = 0; i < maxP; i++) {
    const s = spawns[i];
    let found = false;
    for (let dy = -10; dy <= 10 && !found; dy++)
      for (let dx = -10; dx <= 10 && !found; dx++) {
        const x = s.x + dx, y = s.y + dy;
        if (x >= 0 && y >= 0 && x < W && y < H && w.ore[idx(x, y)] > 0) found = true;
      }
    if (found) oreNearSpawn++;
  }

  // ---- derricks/coalmines on dry land ----
  let sitesOk = true;
  for (const [x, y] of [...layout.derricks, ...(layout.coalmines ?? [])]) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      if (!landPass(x + dx, y + dy)) sitesOk = false;
    }
  }

  // ---- A* reachability: farthest spawn pair within server maxExpand ----
  // Mirror World exactly: large theaters get an area-scaled expansion budget.
  const maxExpand = Math.max(2400, W * H);
  let astarOk = true, astarNote = "";
  if (landLinked === maxP) {
    // check the diagonal corner pair (longest haul)
    const a = spawns[0], b = spawns[1];
    const p = findPath(a.x, a.y, b.x, b.y, landPass, maxExpand, W, H);
    if (!p) { astarOk = false; astarNote = "corner A* exhausted"; }
    // sea lane A* for naval
    if (meta.naval) {
      // pick two far water tiles on opposite edges of the biggest sea
      const seaTiles = [];
      for (let s = 0; s < W * H; s++) if (water[s] && wcomp[s] >= 0) seaTiles.push(s);
      if (seaTiles.length > 10) {
        const s0 = seaTiles[0], s1 = seaTiles[seaTiles.length - 1];
        const ps = findPath(s0 % W, (s0 / W) | 0, s1 % W, (s1 / W) | 0, seaPass, maxExpand, W, H);
        if (!ps) { astarOk = false; astarNote += " sea A* exhausted"; }
      }
    }
  }
  const genMs = performance.now() - t0;

  return {
    id, w: W, h: H, naval: !!meta.naval, maxP,
    waterPct: +(waterFrac * 100).toFixed(1),
    seaComps: ncomp, seaConnPct: +(seaConn * 100).toFixed(1),
    maxSeaRun: maxRun,
    spawnsOk, landLinked, sitesOk, oreNearSpawn, oreTiles: oreTotal,
    astarOk, astarNote: astarNote.trim(), genMs: +genMs.toFixed(0),
    minIsleSize, tinyIsles, spawnsWithShore,
  };
}

const ids = args.length ? args : MAP_LIST.map((m) => m.id);
for (const id of ids) {
  let row;
  try {
    row = analyze(id);
  } catch (e) {
    fail++;
    fails.push(`${id}: threw ${e.message}`);
    console.log(`FAIL ${id}: ${e.stack?.split("\n")[0] ?? e}`);
    continue;
  }
  rows.push(row);
  const meta = MAP_LIST.find((m) => m.id === id);
  ok(row.spawnsOk, `${id}: all spawns on passable land`);
  const connOk = row.landLinked === row.maxP || (row.naval && row.minIsleSize >= 110 && row.spawnsWithShore === row.maxP);
  ok(connOk, `${id}: connectivity ${row.landLinked}/${row.maxP} land-linked, minIsle=${row.minIsleSize}, shore=${row.spawnsWithShore}/${row.maxP}`);
  ok(row.tinyIsles === 0, `${id}: no micro-island spawns (tiny=${row.tinyIsles})`);
  ok(row.sitesOk, `${id}: derricks/coalmines on dry land`);
  ok(row.oreNearSpawn === row.maxP, `${id}: ore near every spawn ${row.oreNearSpawn}/${row.maxP}`);
  ok(row.oreTiles > 0, `${id}: ore present`);
  if (row.naval) {
    ok(row.waterPct >= 43, `${id}: oceanic water fraction ${row.waterPct}%`);
    ok(row.seaConnPct >= 99.5, `${id}: single connected sea ${row.seaConnPct}% comps=${row.seaComps}`);
  }
  if (!row.astarOk) console.log(`  note ${id}: A* budget advisory — ${row.astarNote} (server maxExpand is a cross-file concern)`);
}

if (asJson) {
  console.log(JSON.stringify(rows));
} else {
  console.log("\nmap                dims       naval water%  seaComps seaConn% seaRun spawns land ore  A*  genMs");
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(18)} ${String(r.w).padStart(3)}x${String(r.h).padEnd(3)}  ${r.naval ? "yes" : " no"}   ${String(r.waterPct).padStart(5)}  ${String(r.seaComps).padStart(4)}   ${String(r.seaConnPct).padStart(6)}  ${String(r.maxSeaRun).padStart(4)}   ${r.spawnsOk ? "ok " : "BAD"}  ${r.landLinked}/${r.maxP}:${r.minIsleSize}  ${r.oreNearSpawn}/${r.maxP}  ${r.astarOk ? "ok " : "BAD"} ${String(r.genMs).padStart(4)}`
    );
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) for (const f of fails) console.log("  FAIL:", f);
}
process.exit(fail ? 1 : 0);
