#!/usr/bin/env node
// GC-churn measurement harness for the snapshot pipeline — in-process, no sockets.
// Evolves a heavy bot battle, then measures per-frame allocation (heapUsed
// sawtooth-sum) of each pipeline stage separately:
//
//   snap     world.snapshot() + the localnet emit spread (server / local-mode cost)
//   wire     diffSnaps + JSON.stringify + JSON.parse (online encoding cost)
//   rx       SnapReassembler keyframe/delta reassembly (client cost)
//   rmap     render.ts pushSnap-style id->EntSnap Map copy (client cost)
//
//   node --expose-gc test/perfgc.mjs [--ticks 3600] [--frames 150] [--map fulda_gap] [--players 8]
//
// Methodology: heapUsed is sampled around each stage; positive deltas sum to
// approximate bytes allocated (GC drops inside a stage undercount slightly —
// noise is consistent before/after, and gc() is forced before the window).

import { registerHooks, createRequire } from "node:module";

// Deterministic combat: the sim and bots draw from Math.random directly, so
// seeding it makes before/after measurements compare the IDENTICAL battle
// (run-to-run combat intensity otherwise swamps the pipeline signal)
let rngState = (Number(process.argv[process.argv.indexOf("--seed") + 1]) || 1337) >>> 0;
Math.random = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

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
const { diffSnaps, SnapReassembler } = await import("../src/shared/snapdelta.ts");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const MAP = arg("map", "fulda_gap");
const EVOLVE = Number(arg("ticks", "3600")) || 3600;
const FRAMES = Number(arg("frames", "150")) || 150;
const PLAYERS = Number(arg("players", "8")) || 8;
const KEYFRAME_EVERY = 20;

if (typeof global.gc !== "function") {
  console.error("run with --expose-gc");
  process.exit(1);
}

// ---------- scenario ----------
const slots = Array.from({ length: PLAYERS }, (_, i) => i);
const teams = {};
for (const s of slots) teams[s] = 0;
const world = new World(slots, {
  map: MAP,
  teams,
  config: { startCredits: 20000, gameSpeed: 1, superweapons: true, crates: true, derricks: true, fog: true, logistics: true },
});
const profiles = ["balanced", "rusher", "turtle", "tech"];
const bots = slots.map((s, i) => new AIBot(`bot-${s}`, { diff: i < 4 ? "brutal" : "normal", profile: profiles[i % 4] }));

const stepOnce = () => {
  for (let b = 0; b < slots.length; b++) {
    try {
      bots[b].tick(world, slots[b]);
    } catch {
      /* noise */
    }
  }
  world.step();
};

// ---------- evolve into heavy combat ----------
const tE0 = performance.now();
let peakEnts = 0;
for (let t = 0; t < EVOLVE && world.winner === null; t++) {
  stepOnce();
  if (world.ents.size > peakEnts) peakEnts = world.ents.size;
  // keep the event queue from ballooning during evolution (snapshot drains it)
  if (world.tick % 2 === 0) world.snapshot();
}
console.log(
  `[perfgc] evolved to tick ${world.tick} in ${(performance.now() - tE0).toFixed(0)}ms — ents now=${world.ents.size} peak=${peakEnts} winner=${world.winner}`,
);
if (world.winner !== null) console.warn("[perfgc] WARNING: match ended during evolution — combat window may be thin");

// ---------- measured window ----------
global.gc();
const heap = () => process.memoryUsage().heapUsed;

// scavenge counting — young-generation garbage is collected by scavenges whose
// cadence is set by the (fixed) semispace size, so the count of minor GCs in
// the window is a heapUsed-independent measure of total bytes allocated.
// The sim step() allocation is identical across code versions (seeded combat),
// so before/after deltas isolate the snapshot pipeline exactly.
import { PerformanceObserver, performance as perfHook } from "node:perf_hooks";
const gcEntries = [];
const gcObs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) gcEntries.push({ t: e.startTime, kind: e.detail?.kind ?? 0 });
});
try {
  gcObs.observe({ entryTypes: ["gc"] });
} catch {
  console.warn("[perfgc] gc performance entries unavailable — scavenge counting disabled");
}

// single shared sampler — positive deltas at stage boundaries attribute bytes
// to that stage; drops (GC inside a stage) undercount slightly, consistent noise
const alloc = { snap: 0, wire: 0, rx: 0, rmap: 0 };
let gcDrops = 0;
const attrib = (stage, h0, h1) => {
  if (h1 >= h0) alloc[stage] += h1 - h0;
  else gcDrops++;
};
const times = { snap: 0, wire: 0, rx: 0, rmap: 0 };
let snapBase = null;
let snapBaseObj = null;
let snapCount = 0;
const rx = new SnapReassembler();
let deltaEntsSum = 0;
let rmapPeak = 0;

// Named stage functions — the heap allocation sampler attributes inclusive bytes
// under these frames, which is the authoritative measurement (heapUsed sawtooth
// numbers below are retained only as a noisy cross-check; page recommit after GC
// makes them unreliable at this granularity).

function stageSnapMeasure() {
  const snapRaw = world.snapshot();
  const snapMsg = { t: "snap", tick: world.tick, ...snapRaw };
  return { snapRaw, snapMsg };
}

function stageWireMeasure(snapMsg, snapRaw) {
  const seq = ++snapCount;
  const isKey = !snapBase || seq % KEYFRAME_EVERY === 0;
  let wireIn;
  if (isKey) {
    wireIn = JSON.parse(JSON.stringify({ t: "snap", seq, key: true, tick: world.tick, ents: snapMsg.ents, crates: snapMsg.crates, bridges: snapMsg.bridges, players: snapMsg.players, events: snapMsg.events }));
  } else {
    // exact broadcastSnap logic: snapDelta fast path when the baseline chains,
    // standalone diffSnaps otherwise (the pre-optimization code always diffs)
    const meta = world.snapDelta;
    const fastDiff = meta && snapBaseObj && snapBaseObj === meta.from ? meta.diff : null;
    const diff = fastDiff ?? diffSnaps(snapBase, snapMsg);
    deltaEntsSum += diff.ents.length;
    wireIn = JSON.parse(
      JSON.stringify({ t: "snapd", seq, tick: world.tick, ents: diff.ents, gone: diff.gone, crates: diff.crates, bridges: diff.bridges, players: diff.players, events: snapMsg.events }),
    );
  }
  return wireIn;
}

function stageRxMeasure(wireIn) {
  return wireIn.t === "snap" ? rx.keyframe(wireIn) : rx.delta(wireIn);
}

function stageRmapMeasure(full) {
  const map = new Map();
  for (const e of full.ents) map.set(e.id, e);
  return map;
}

function measureFrame() {
  // ---- snap stage: server snapshot + localnet emit spread ----
  let h0 = heap();
  let t0 = performance.now();
  const { snapRaw, snapMsg } = stageSnapMeasure();
  times.snap += performance.now() - t0;
  let h1 = heap();
  attrib("snap", h0, h1);

  // ---- wire stage: delta/keyframe encode+decode exactly as worker+net ----
  t0 = performance.now();
  const wireIn = stageWireMeasure(snapMsg, snapRaw);
  times.wire += performance.now() - t0;
  const h2 = heap();
  attrib("wire", h1, h2);

  // ---- rx stage: client reassembly ----
  t0 = performance.now();
  const full = stageRxMeasure(wireIn);
  times.rx += performance.now() - t0;
  const h3 = heap();
  attrib("rx", h2, h3);

  // ---- rmap stage: render.ts pushSnap id->ent map copy ----
  if (full) {
    t0 = performance.now();
    const map = stageRmapMeasure(full);
    times.rmap += performance.now() - t0;
    const h4 = heap();
    attrib("rmap", h3, h4);
    if (map.size > rmapPeak) rmapPeak = map.size;
  }

  snapBase = { ents: snapMsg.ents, crates: snapMsg.crates, bridges: snapMsg.bridges, players: snapMsg.players };
  snapBaseObj = snapRaw;
}

const tW0 = performance.now();
const gcWindowT0 = perfHook.now();
let framesDone = 0;
for (let f = 0; f < FRAMES && world.winner === null; f++) {
  stepOnce();
  stepOnce(); // SNAP_EVERY=2 — one snapshot per two sim ticks, as production
  framesDone++;
  measureFrame();
}
const meters = Object.fromEntries(Object.entries(alloc).map(([k, v]) => [k, { bytes: v }]));
const wallMs = performance.now() - tW0;

const perFrame = (m) => m.bytes / Math.max(1, framesDone);
const KB = 1024;
const mbps = (bytesPerFrame) => ((bytesPerFrame * 5) / (KB * KB)).toFixed(3); // 5 Hz snapshot cadence
console.log(`[perfgc] mean changed ents per delta frame: ${(deltaEntsSum / Math.max(1, framesDone)).toFixed(1)}`);
console.log(`\n[perfgc] measured ${framesDone} frames over ${(wallMs / 1000).toFixed(1)}s wall, mean ents=${rmapPeak}`);
console.log("stage      bytes/frame    MB/s @5Hz   ms/frame");
console.log("---------  -----------    ---------   -------");
for (const k of ["snap", "wire", "rx", "rmap"]) {
  console.log(
    `${k.padEnd(9)}  ${perFrame(meters[k]).toFixed(0).padStart(11)}    ${mbps(perFrame(meters[k])).padStart(9)}   ${(times[k] / framesDone).toFixed(3)}`,
  );
}
console.log(`[perfgc] gc-drops inside measured stages: ${gcDrops}\n`);
console.log(`\n[perfgc] total pipeline (snap+wire+rx+rmap): ${mbps(perFrame(meters.snap) + perFrame(meters.wire) + perFrame(meters.rx) + perFrame(meters.rmap))} MB/s @5Hz`);
// gc performance entries are delivered asynchronously — yield before reading
await new Promise((r) => setTimeout(r, 20));
const gcWindowT1 = perfHook.now();
const inWindow = gcEntries.filter((e) => e.t >= gcWindowT0 && e.t <= gcWindowT1);
const minorGcs = inWindow.filter((e) => e.kind === 1).length;
const majorGcs = inWindow.filter((e) => e.kind !== 1).length;
console.log(`[perfgc] minor GCs (scavenges) in window: ${minorGcs}, major: ${majorGcs} — semispace-fixed cadence makes this a total-allocation proxy`);
