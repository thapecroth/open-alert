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
const { AIBot, RtsBot } = await import("../src/server/bot.ts");
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
const SEED = arg("seed", "");
const FINGERPRINT = process.argv.includes("--fingerprint");

// --seed N: deterministic Math.random (mulberry32) so before/after optimization
// runs evolve the identical game — enables exact behavioral-equivalence checking
// via --fingerprint (rolling hash of entity state, outside the timed region).
if (SEED) {
  let s = (Number(SEED) || 1) >>> 0;
  Math.random = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  "processPathQueue",
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
const INSIDE = ["nearestEnemy", "stepAlong", "pathNear", "tryFire", "tickHarvester", "tickDirect", "recomputeRegions", "nearestOre", "oreSnapshot", "spawnNearBuilding"];
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

// bot internals — same wrapping, recorded under b_* keys (TS-private compiles to plain methods)
const BOTSUB = ["scanWorld", "place", "findSpot", "defend", "slow", "assault", "manageSupplyTrucks", "scout", "rally", "produce", "repairs", "manageAirlift", "grabCrates", "captureDerricks", "wakeHarvesters", "fireSuperweapon", "upgrade"];
for (const name of BOTSUB) {
  const orig = RtsBot.prototype[name];
  if (typeof orig !== "function") continue;
  RtsBot.prototype[name] = function (...args) {
    const t0 = performance.now();
    try {
      return orig.apply(this, args);
    } finally {
      subs["b_" + name] = (subs["b_" + name] ?? 0) + (performance.now() - t0);
    }
  };
}

// ---------- measured evolution ----------
const series = []; // per-tick records
let fpTick = 0;
const fpSeries = [];
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
  for (const k of BOTSUB) rec["b_" + k] = subs["b_" + k] ?? 0;
  series.push(rec);
  if (FINGERPRINT) {
    // rolling gameplay-state hash — map iteration order is insertion-stable, and
    // identical sim logic yields bit-identical floats, so any behavioral drift
    // shows up as a digest divergence at exactly the first diverging tick
    let h = fpTick;
    h = (h * 33 + world.ents.size) >>> 0;
    for (const e of world.ents.values()) {
      h = (h * 33 + e.id) >>> 0;
      h = (h * 33 + Math.round(e.x * 64)) >>> 0;
      h = (h * 33 + Math.round(e.y * 64)) >>> 0;
      h = (h * 33 + Math.round(e.hp)) >>> 0;
    }
    fpTick = h;
    fpSeries.push(h);
  }
}
if (FINGERPRINT) {
  console.log(`[fingerprint] final=${fpTick.toString(16)} ticks=${fpSeries.length} (compare across builds; identical games match exactly)`);
  writeFileSyncSafe(`/tmp/fp-${MAP}-${SEED || "rand"}.txt`, fpSeries.map((h, i) => `${i + 1} ${h.toString(16)}`).join("\n"));
}
function writeFileSyncSafe(path, data) {
  try {
    writeFileSync(path, data);
  } catch {
    /* best effort */
  }
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

// ---------- worst-tick spike attribution ----------
// The mean table hides what makes the p99/max ticks bad. Print the top-8
// worst ticks in the heavy window with their per-subsystem breakdown, plus a
// global-series scan (spikes can land outside the heaviest-entity window).
const SPIKE_KEYS = [
  ["bots", (r) => r.botMs],
  ["  b.scanWorld", (r) => r.b_scanWorld],
  ["  b.place", (r) => r.b_place],
  ["  b.findSpot", (r) => r.b_findSpot],
  ["  b.defend", (r) => r.b_defend],
  ["  b.slow", (r) => r.b_slow],
  ["  b.produce", (r) => r.b_produce],
  ["  b.airlift", (r) => r.b_manageAirlift],
  ["  b.crates", (r) => r.b_grabCrates],
  ["  b.scout", (r) => r.b_scout],
  ["  oreSnapshot", (r) => r.i_oreSnapshot],
  ["  spawnNearBld", (r) => r.i_spawnNearBuilding],
  ["  b.assault", (r) => r.b_assault],
  ["  b.supplyTrucks", (r) => r.b_manageSupplyTrucks],
  ["processPathQueue", (r) => r.s_processPathQueue],
  ["tickEnt", (r) => r.s_tickEnt],
  ["  stepAlong", (r) => r.i_stepAlong],
  ["  nearestEnemy", (r) => r.i_nearestEnemy],
  ["  tickHarvester", (r) => r.i_tickHarvester],
  ["  recomputeRegions", (r) => r.i_recomputeRegions],
  ["  nearestOre", (r) => r.i_nearestOre],
  ["separate", (r) => r.s_separate],
  ["rebuildSpatialGrid", (r) => r.s_rebuildSpatialGrid],
  ["tickProduction", (r) => r.s_tickProduction],
  ["tickEwJamming", (r) => r.s_tickEwJamming],
  ["tickCrates", (r) => r.s_tickCrates],
  ["tickLogistics", (r) => r.s_tickLogistics],
  ["depots+derr+vet", (r) => (r.s_tickDepots ?? 0) + (r.s_tickDerricks ?? 0) + (r.s_tickVetRegen ?? 0)],
  ["regenOre", (r) => r.s_regenOre],
  ["checkEnd", (r) => r.s_checkEnd],
  ["snap+diff+json", (r) => (r.snapMs ?? 0) + (r.diffMs ?? 0) + (r.jsonMs ?? 0)],
  ["A*(incl. atomic)", (r) => r.astarMs],
];
const dumpSpikes = (label, arr) => {
  const worst = [...arr].sort((a, b) => b.ms - a.ms).slice(0, 8);
  console.log(`\n[spikes ${label}] top worst ticks:`);
  for (const r of worst) {
    const parts = SPIKE_KEYS.map(([k, f]) => [k, f(r) ?? 0])
      .filter(([, v]) => v > 0.15)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
      .join(" ");
    console.log(`  tick ${r.tick} ms=${r.ms.toFixed(2)} ents=${r.ents} astarExp=${r.astarExp} astarCalls=${r.astarCalls} :: ${parts}`);
  }
};
dumpSpikes("heavy window", win);
dumpSpikes("ALL ticks", series);

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
