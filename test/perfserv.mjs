#!/usr/bin/env node
// Server-tick profiling harness — in-process, no sockets.
// Scripts a heavy late-game evolution (8 bots FFA on a big map) measuring EVERY
// tick, then analyzes the 400-tick window with the highest mean entity count
// (the real late-game load) for per-tick wall distribution + per-subsystem
// attribution, replicating the production broadcast path (snapshot+diff+JSON).
//
//   node test/perfserv.mjs [--map fulda_gap] [--ticks 6000] [--win 400]
//                          [--players 8] [--csv .tmp/perfserv-before.json]
//   node --cpu-prof --cpu-prof-dir=.tmp/prof test/perfserv.mjs
//
// Machine may be loaded (game running) — absolute ms drift, but relative
// subsystem attribution stays meaningful; rerun flakes before concluding.

import { registerHooks, createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z0-9]+$/i.test(specifier)) {
        return next(specifier + ".ts", context);
      }
      throw err;
    }
  },
  load(url, context, next) {
    const res = next(url, context);
    if (url.endsWith(".ts")) {
      const out = ts.transpileModule(String(res.source), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: url,
      });
      return { format: "module", source: out.outputText, shortCircuit: true };
    }
    return res;
  },
});

const { World } = await import("../src/server/world.ts");
const { AIBot } = await import("../src/server/bot.ts");
const { diffSnaps } = await import("../src/shared/snapdelta.ts");
const { PATH_STATS } = await import("../src/server/path.ts");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const MAP = arg("map", "fulda_gap");
const MAXTICKS = Number(arg("ticks", "6000")) || 6000;
const WIN = Number(arg("win", "400")) || 400;
const CSV = arg("csv", "");
const PLAYERS = Number(arg("players", "8")) || 8;
const START_CREDITS = Number(arg("credits", "20000")) || 20000;

// ---------- scenario ----------
const slots = Array.from({ length: PLAYERS }, (_, i) => i);
const teams = {};
for (const s of slots) teams[s] = 0; // FFA — maximum target-scan pressure
const world = new World(slots, {
  map: MAP,
  teams,
  config: { startCredits: START_CREDITS, gameSpeed: 1, superweapons: true, crates: true, derricks: true, fog: true, logistics: true },
});
const profiles = ["balanced", "rusher", "turtle", "tech"];
const bots = slots.map((s, i) => new AIBot(`bot-${s}`, { diff: i < 4 ? "brutal" : "normal", profile: profiles[i % 4] }));

// ---------- subsystem instrumentation ----------
const proto = World.prototype;
const subs = Object.create(null);
const SUBSTEP = [
  "tickProduction",
  "rebuildSpatialGrid",
  "tickEnt",
  "separate",
  "tickEwJamming",
  "tickCrates",
  "tickDepots",
  "tickDerricks",
  "tickVetRegen",
  "tickLogistics",
  "regenOre",
  "checkEnd",
];
const INSIDE = ["nearestEnemy", "stepAlong", "pathNear", "tryFire", "tickHarvester", "tickDirect"];
for (const name of [...SUBSTEP, ...INSIDE]) {
  const orig = proto[name];
  if (typeof orig !== "function") throw new Error(`no such method: ${name}`);
  proto[name] = function (...args) {
    const t0 = performance.now();
    try {
      return orig.apply(this, args);
    } finally {
      subs[name] = (subs[name] ?? 0) + (performance.now() - t0);
    }
  };
}

// ---------- measured evolution ----------
const series = []; // per-tick records
let snapBase = null;
let snapCount = 0;
const t0All = performance.now();
for (let t = 0; t < MAXTICKS && world.winner === null; t++) {
  for (const k of Object.keys(subs)) subs[k] = 0;
  PATH_STATS.reset();
  const tTick0 = performance.now();
  const tb0 = performance.now();
  for (let b = 0; b < slots.length; b++) {
    try {
      bots[b].tick(world, slots[b]);
    } catch {
      /* noise */
    }
  }
  const botMs = performance.now() - tb0;
  world.step();
  // production replica: broadcastSnap every 2 ticks
  let snapMs = 0,
    diffMs = 0,
    jsonMs = 0,
    wireBytes = 0;
  if (world.tick % 2 === 0) {
    let ts0 = performance.now();
    const snap = world.snapshot();
    snapMs = performance.now() - ts0;
    const isKey = !snapBase || snapCount % 20 === 0;
    ts0 = performance.now();
    if (!isKey) {
      const diff = diffSnaps(snapBase.snap, snap);
      diffMs = performance.now() - ts0;
      ts0 = performance.now();
      wireBytes = JSON.stringify({
        t: "snapd", seq: snapCount, tick: world.tick, ents: diff.ents, gone: diff.gone,
        crates: diff.crates, bridges: diff.bridges, players: diff.players, events: snap.events,
      }).length;
    } else {
      wireBytes = JSON.stringify({
        t: "snap", seq: snapCount, key: true, tick: world.tick, ents: snap.ents,
        crates: snap.crates, bridges: snap.bridges, players: snap.players, events: snap.events,
      }).length;
    }
    jsonMs = performance.now() - ts0;
    snapBase = { snap };
    snapCount++;
  }
  const tickMs = performance.now() - tTick0;
  const rec = { tick: world.tick, ents: world.ents.size, ms: tickMs, botMs, snapMs, diffMs, jsonMs, wireBytes, astarMs: PATH_STATS.ms, astarCalls: PATH_STATS.calls, astarExp: PATH_STATS.expanded, astarFail: PATH_STATS.failed, astarCapped: PATH_STATS.capped };
  for (const k of SUBSTEP) rec["s_" + k] = subs[k] ?? 0;
  for (const k of INSIDE) rec["i_" + k] = subs[k] ?? 0;
  series.push(rec);
}
console.log(`[perfserv] map=${MAP} ${world.w}x${world.h} evolved ${series.length} ticks in ${(performance.now() - t0All).toFixed(0)}ms, peak ents=${Math.max(...series.map((r) => r.ents))}`);

// ---------- heavy-window analysis ----------
let bestStart = 0,
  bestMean = -1;
for (let i = 0; i + WIN <= series.length; i++) {
  let sum = 0;
  for (let j = i; j < i + WIN; j++) sum += series[j].ents;
  const mean = sum / WIN;
  if (mean > bestMean) {
    bestMean = mean;
    bestStart = i;
  }
}
const win = series.slice(bestStart, bestStart + WIN);
const n = win.length || 1;
const avg = (f) => win.reduce((a, r) => a + f(r), 0) / n;
const tickMsArr = win.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => tickMsArr[Math.min(n - 1, Math.floor((p / 100) * n))] ?? 0;

console.log(`\n[perfserv] heavy window: ticks ${win[0]?.tick}..${win[win.length - 1]?.tick} mean ents=${bestMean.toFixed(0)}`);
console.log(`tick wall ms: mean=${avg((r) => r.ms).toFixed(2)} p50=${pct(50).toFixed(2)} p95=${pct(95).toFixed(2)} p99=${pct(99).toFixed(2)} max=${tickMsArr[n - 1]?.toFixed(2)}`);
console.log(`(alarm invocation = 2 ticks; 1.0x budget 200ms — overruns = slow-motion sim)\n`);

const rows = [];
const add = (label, perTick, note = "") => rows.push({ label, perTick, note });
add("bots(all)", avg((r) => r.botMs), `${bots.length} brains`);
add("tickEnt (all ents)", avg((r) => r.s_tickEnt), "inclusive");
add("  stepAlong", avg((r) => r.i_stepAlong), "in tickEnt");
add("  pathNear", avg((r) => r.i_pathNear), "in tickEnt");
add("  nearestEnemy", avg((r) => r.i_nearestEnemy), "in tickEnt");
add("  tryFire", avg((r) => r.i_tryFire), "in tickEnt");
add("  tickHarvester", avg((r) => r.i_tickHarvester), "in tickEnt");
add("  tickDirect", avg((r) => r.i_tickDirect), "in tickEnt");
add("A* findPath", avg((r) => r.astarMs), `${avg((r) => r.astarCalls).toFixed(1)} calls/tick ${avg((r) => r.astarExp).toFixed(0)} exp/tick fail%=${((win.reduce((a, r) => a + r.astarFail, 0) / Math.max(1, win.reduce((a, r) => a + r.astarCalls, 0))) * 100).toFixed(0)} capped=${win.reduce((a, r) => a + r.astarCapped, 0)}`);
add("rebuildSpatialGrid", avg((r) => r.s_rebuildSpatialGrid));
add("separate", avg((r) => r.s_separate));
add("tickProduction", avg((r) => r.s_tickProduction));
add("snapshot()", avg((r) => r.snapMs), "amortized/tick");
add("diffSnaps", avg((r) => r.diffMs), "amortized/tick");
add("JSON encode", avg((r) => r.jsonMs), `wire avg ${(avg((r) => r.wireBytes) / 1024).toFixed(1)}KB/frame`);
add("tickEwJamming", avg((r) => r.s_tickEwJamming));
add("tickCrates", avg((r) => r.s_tickCrates));
add("tickLogistics", avg((r) => r.s_tickLogistics));
add("tickDepots+Derricks+Vet", avg((r) => (r.s_tickDepots ?? 0) + (r.s_tickDerricks ?? 0) + (r.s_tickVetRegen ?? 0)));
add("regenOre", avg((r) => r.s_regenOre));
add("checkEnd", avg((r) => r.s_checkEnd));
rows.sort((a, b) => b.perTick - a.perTick);
console.log("subsystem                    ms/tick   note");
console.log("---------------------------  -------  -----");
for (const r of rows) console.log(`${r.label.padEnd(27)} ${r.perTick.toFixed(3).padStart(7)}  ${r.note}`);

// overruns: ticks costing more than 25/50/100ms
for (const th of [10, 25, 50, 100]) {
  const c = win.filter((r) => r.ms > th).length;
  console.log(`ticks > ${th}ms: ${c}/${n} (${((c / n) * 100).toFixed(1)}%)`);
}

if (CSV) {
  const out = {
    map: MAP,
    window: { start: win[0]?.tick, end: win[win.length - 1]?.tick, meanEnts: bestMean },
    tickMs: { mean: avg((r) => r.ms), p50: pct(50), p95: pct(95), p99: pct(99), max: tickMsArr[n - 1] },
    subsystems: Object.fromEntries(rows.map((r) => [r.label.trim(), { msPerTick: r.perTick, note: r.note }])),
    astar: {
      msPerTick: avg((r) => r.astarMs),
      callsPerTick: avg((r) => r.astarCalls),
      expPerTick: avg((r) => r.astarExp),
      fails: win.reduce((a, r) => a + r.astarFail, 0),
      calls: win.reduce((a, r) => a + r.astarCalls, 0),
      capped: win.reduce((a, r) => a + r.astarCapped, 0),
    },
  };
  writeFileSync(CSV, JSON.stringify(out, null, 1));
  console.log(`[perfserv] wrote ${CSV}`);
}
