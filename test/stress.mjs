#!/usr/bin/env node
// In-process server-sim stress harness — no sockets, no worker, no dev server.
// Builds deterministic heavy mixed-army scenarios directly in World, then measures
// production-shaped per-tick cost: world.step() plus the every-other-tick
// snapshot/diff/JSON broadcast path used by the authoritative worker.
//
//   node test/stress.mjs
//   node --expose-gc test/stress.mjs --json .tmp/stress-results.json
//   node test/stress.mjs --maps megacontinent --counts 1000 --breakdown
//   node --cpu-prof --cpu-prof-dir=.tmp/prof test/stress.mjs --maps terra --counts 1000
//
// Useful knobs:
//   --maps crossroads,english_channel,terra,megacontinent
//   --counts 800,1000       --ticks 480       --warmup 60
//   --players 8             --seed 1337       --budget 40
//   --breakdown             (monkey-patches World methods; attribution-only overhead)
//
// The scenario intentionally uses direct private-method access at runtime
// (spawnUnit/placeBuilding/recomputeRegions) as test scaffolding. It does not
// modify src/, and the measured sim path is the production World implementation.

import { registerHooks, createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { PerformanceObserver, constants as PERF_CONSTANTS } from "node:perf_hooks";

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
const { diffSnaps } = await import("../src/shared/snapdelta.ts");
const { PATH_STATS, nearestPassable } = await import("../src/server/path.ts");
const { BUILDINGS, UNITS, getSpawns } = await import("../src/shared/gamedefs.ts");

// ---------- args ----------
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);
const listArg = (name, fallback) => String(arg(name, fallback)).split(",").map((s) => s.trim()).filter(Boolean);

const MAPS = listArg("maps", "crossroads,english_channel,terra,megacontinent");
const COUNTS = listArg("counts", "800,1000").map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
const TICKS = Math.max(100, Number(arg("ticks", "480")) || 480);
const WARMUP = Math.max(0, Number(arg("warmup", "60")) || 0);
const PLAYERS = Math.max(2, Math.min(8, Number(arg("players", "8")) || 8));
const SEED = Number(arg("seed", "1337")) || 1337;
const BUDGET = Number(arg("budget", "40")) || 40;
const BREAKDOWN = hasFlag("breakdown");
const NO_REINFORCE = hasFlag("no-reinforce");
const KEEP_RECORDS = hasFlag("keep-records");
const JSON_OUT = arg("json", "");
const SNAP_KEYFRAME_EVERY = 20;

// ---------- deterministic-ish randomness ----------
// World uses Math.random for crates/ore spreading/interception. Keep the scenario
// script fixed and make those residual random inputs reproducible per scenario.
let rngState = 1 >>> 0;
const originalRandom = Math.random;
Math.random = () => {
  rngState |= 0;
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const reseed = (seed) => {
  rngState = seed >>> 0 || 1;
};
const hashString = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

// ---------- GC observation (attributed retroactively by PerformanceEntry.startTime) ----------
const gcEntries = [];
try {
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gcEntries.push({ startTime: e.startTime, duration: e.duration, kind: e.detail?.kind ?? 0 });
    }
  });
  obs.observe({ entryTypes: ["gc"] });
} catch {
  // Older Node: memory trend still works, GC counters are simply absent.
}
const flushPerfEntries = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};
const gcKindName = (k) =>
  k === PERF_CONSTANTS.NODE_PERFORMANCE_GC_MAJOR
    ? "major"
    : k === PERF_CONSTANTS.NODE_PERFORMANCE_GC_MINOR
      ? "minor"
      : k === PERF_CONSTANTS.NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP
        ? "minor-ms"
        : k === PERF_CONSTANTS.NODE_PERFORMANCE_GC_INCREMENTAL
          ? "incremental"
          : `kind${k}`;

// ---------- scenario theaters ----------
// Coordinates are real map tiles. Each pair is a two-sided attack-move front:
// team 1 stages at a, team 2 at b, and both sides are ordered into the other.
// Naval fronts are separate blue-water lanes; aircraft reuse the land endpoints
// and therefore cross the full theater rather than merely orbiting a base.
const THEATERS = {
  crossroads: {
    land: [
      [[68, 96], [124, 96]],
      [[96, 68], [96, 124]],
      [[40, 40], [152, 152]],
    ],
    sea: [],
  },
  english_channel: {
    land: [
      [[70, 28], [180, 28]], // Britain, long east-west army movement
      [[70, 166], [180, 166]], // France, long east-west army movement
    ],
    sea: [
      [[40, 104], [220, 95]], // long channel crossing
      [[100, 95], [160, 95]], // close mid-channel fleet fight
    ],
  },
  terra: {
    land: [
      [[20, 35], [75, 70]], // North America
      [[145, 30], [230, 45]], // Eurasia
      [[150, 80], [190, 110]], // Africa
    ],
    sea: [
      [[35, 120], [120, 90]], // Pacific/Atlantic long lane
      [[100, 90], [140, 90]], // central Atlantic fleet fight
    ],
  },
  megacontinent: {
    land: [
      [[50, 80], [205, 80]], // transcontinental northern war
      [[96, 168], [162, 168]], // southern causeway fight
      [[55, 150], [200, 150]], // transcontinental southern war
    ],
    sea: [
      [[100, 128], [155, 128]], // central strait close fight
      [[128, 20], [128, 240]], // extreme north-south sea lane
    ],
  },
};

// Weighted modern mixed army. Weights sum to 100 including navy; on pure-land
// maps the naval share is simply renormalized into land/air.
const COMPOSITION = [
  ["tank", 23],
  ["infantry", 14],
  ["rocket", 8],
  ["himars", 5],
  ["railtank", 5],
  ["spider", 2],
  ["ballistic", 2],
  ["harvester", 6],
  ["supplytruck", 2],
  ["fpvdrone", 6],
  ["uav", 5],
  ["a10", 4],
  ["interceptor", 3],
  ["ewdrone", 1],
  ["shahed", 3],
  ["chopper", 1],
  ["gunboat", 2],
  ["destroyer", 2],
  ["sub", 2],
  ["usv", 3],
  ["dreadnought", 1],
];

// Reinforcement waves are combat-oriented; harvesters are part of the initial
// economy and generally survive at home, so replacement waves do not add more.
const REINFORCEMENT_SEQUENCE = [
  "tank", "infantry", "fpvdrone", "tank", "rocket", "uav", "infantry", "tank",
  "himars", "infantry", "a10", "tank", "rocket", "gunboat", "infantry", "tank",
  "railtank", "uav", "infantry", "tank", "destroyer", "rocket", "fpvdrone", "tank",
  "infantry", "sub", "spider", "uav", "tank", "rocket", "usv", "infantry", "tank",
  "a10", "ballistic", "interceptor", "shahed", "supplytruck",
];

const TEAM_A_SLOTS = new Set([0, 3, 4, 6]); // west/north-ish half of the perimeter
const teamOf = (slot) => (TEAM_A_SLOTS.has(slot) ? 1 : 2);
const isB = (k) => k in BUILDINGS;
const keyOf = (w, x, y) => y * w.w + x;
const clampInt = (v) => v | 0;
const fmt = (n, d = 2) => Number.isFinite(n) ? n.toFixed(d) : "—";
const mib = (bytes) => bytes / 1048576;

function compositionFor(count, naval) {
  const entries = COMPOSITION
    .map(([kind, weight], order) => ({ kind, weight, order }))
    .filter((e) => naval || UNITS[e.kind].domain !== "sea");
  const totalWeight = entries.reduce((a, e) => a + e.weight, 0);
  const quotas = entries.map((e) => ({ ...e, exact: (e.weight / totalWeight) * count }));
  for (const q of quotas) q.n = Math.floor(q.exact);
  let left = count - quotas.reduce((a, q) => a + q.n, 0);
  const byFrac = [...quotas].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.order - b.order);
  for (let i = 0; left > 0; i = (i + 1) % byFrac.length) {
    byFrac[i].n++;
    left--;
  }
  // Round-robin emission keeps unit kinds interleaved, so wave/front assignment
  // does not accidentally become "all tanks in wave 0, all air in wave 2".
  const out = [];
  const remaining = new Map(quotas.filter((q) => q.n > 0).map((q) => [q.kind, q.n]));
  while (out.length < count) {
    let emitted = false;
    for (const q of quotas) {
      const rem = remaining.get(q.kind) ?? 0;
      if (rem > 0 && out.length < count) {
        out.push(q.kind);
        remaining.set(q.kind, rem - 1);
        emitted = true;
      }
    }
    if (!emitted) break;
  }
  if (out.length !== count) throw new Error(`composition underfilled: ${out.length}/${count}`);
  return out;
}

// ---------- optional attribution instrumentation ----------
const subTimes = Object.create(null);
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
const INSIDE = [
  "nearestEnemy",
  "stepAlong",
  "pathNear",
  "tryFire",
  "tickHarvester",
  "tickDirect",
  "nearestOre",
  "entsInRange",
  "tryIntercept",
  "recomputeRegions",
];
if (BREAKDOWN) {
  for (const name of [...SUBSTEP, ...INSIDE]) {
    const orig = World.prototype[name];
    if (typeof orig !== "function") throw new Error(`World.prototype.${name} is not instrumentable`);
    World.prototype[name] = function (...args) {
      const t0 = performance.now();
      try {
        return orig.apply(this, args);
      } finally {
        subTimes[name] = (subTimes[name] ?? 0) + (performance.now() - t0);
      }
    };
  }
}

// ---------- world/scenario construction helpers ----------
function recomputeRegionsNow(world) {
  // TS private is runtime-visible. This is setup-only; the sim itself lazily does
  // exactly the same call on the first path query after terrain/building mutation.
  world.recomputeRegions();
}

function footprintFree(world, kind, tx, ty) {
  const d = BUILDINGS[kind];
  if (tx < 0 || ty < 0 || tx + d.w > world.w || ty + d.h > world.h) return false;
  for (let y = ty; y < ty + d.h; y++) {
    for (let x = tx; x < tx + d.w; x++) {
      const i = world.idx(x, y);
      if (!world.passable(x, y) || world.ore[i] > 0) return false;
    }
  }
  for (const e of world.ents.values()) {
    if (isB(e.k)) continue;
    const ux = Math.floor(e.x), uy = Math.floor(e.y);
    if (ux >= tx && ux < tx + d.w && uy >= ty && uy < ty + d.h) return false;
  }
  return true;
}

function findFreeFootprint(world, kind, cx, cy, radius = 28) {
  for (let r = 0; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = cx + dx, ty = cy + dy;
        if (footprintFree(world, kind, tx, ty)) return { tx, ty };
      }
    }
  }
  return null;
}

function placeEconomyBase(world, slots) {
  const spawns = getSpawns(world.w, world.h);
  const placed = [];
  const failed = [];
  for (const slot of slots) {
    const s = spawns[slot];
    // Refinery first: the conyard's 40 power covers its 35 power drain, so this is
    // enough for continuous harvester cycling even on small offshore spawn islands.
    const spot = findFreeFootprint(world, "refinery", s.x + 1, s.y + 4, 32);
    if (spot) {
      const b = world.placeBuilding(slot, "refinery", spot.tx, spot.ty);
      world.recomputePower(slot);
      placed.push({ slot, kind: "refinery", x: b.x, y: b.y });
    } else {
      failed.push({ slot, kind: "refinery" });
    }
  }
  return { placed, failed };
}

function prepareFronts(world, pairs, domain) {
  const pass = domain === "sea" ? world.passableSea : world.passable;
  const regions = domain === "sea" ? world.regionSea : world.regionLand;
  const searchR = domain === "sea" ? 48 : 28;
  const out = [];
  for (const [aa, bb] of pairs) {
    const an = nearestPassable(aa[0], aa[1], pass, searchR, world.w, world.h);
    const bn = nearestPassable(bb[0], bb[1], pass, searchR, world.w, world.h);
    if (!an || !bn) {
      out.push({ invalid: `no passable endpoint near ${aa} or ${bb}` });
      continue;
    }
    const ar = regions[world.idx(an.x, an.y)] ?? 0;
    const br = regions[world.idx(bn.x, bn.y)] ?? 0;
    out.push({
      a: { x: an.x, y: an.y },
      b: { x: bn.x, y: bn.y },
      aRegion: ar,
      bRegion: br,
      connected: ar > 0 && ar === br,
      shift: Math.max(Math.hypot(an.x - aa[0], an.y - aa[1]), Math.hypot(bn.x - bb[0], bn.y - bb[1])),
    });
  }
  return out;
}

function prepareTheater(world, map) {
  const spec = THEATERS[map];
  if (!spec) throw new Error(`no stress theater defined for map ${map}`);
  recomputeRegionsNow(world);
  const land = prepareFronts(world, spec.land, "land").filter((f) => f.a && f.b);
  const sea = prepareFronts(world, spec.sea, "sea").filter((f) => f.a && f.b);
  if (!land.length) throw new Error(`${map}: no usable land fronts`);
  return { land, sea, naval: sea.length > 0 && world.hasWater() };
}

function resetOccupancy(world, used) {
  for (const domain of ["land", "air", "sea"]) used[domain].clear();
  for (const e of world.ents.values()) {
    if (isB(e.k)) continue;
    const d = UNITS[e.k]?.domain;
    if (!d) continue;
    used[d].add(keyOf(world, Math.floor(e.x), Math.floor(e.y)));
  }
}

function findOpenTile(world, cx, cy, domain, usedSet, region = 0, maxR = 48) {
  const x0 = clampInt(cx), y0 = clampInt(cy);
  const regionArr = domain === "sea" ? world.regionSea : world.regionLand;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = x0 + dx, y = y0 + dy;
        if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
        const key = keyOf(world, x, y);
        if (usedSet.has(key)) continue;
        if (domain === "land") {
          if (!world.passable(x, y)) continue;
          if (region > 0 && regionArr[key] !== region) continue;
        } else if (domain === "sea") {
          if (!world.passableSea(x, y)) continue;
          if (region > 0 && regionArr[key] !== region) continue;
        }
        return { x, y };
      }
    }
  }
  return null;
}

function spawnAt(world, used, slot, kind, cx, cy, domain, region = 0, maxR = 48) {
  const spot = findOpenTile(world, cx, cy, domain, used[domain], region, maxR);
  if (!spot) return null;
  used[domain].add(keyOf(world, spot.x, spot.y));
  return world.spawnUnit(slot, kind, spot.x, spot.y);
}

function spawnInitialArmies(world, slots, target, theater, used) {
  const mobileNeed = target - world.ents.size;
  if (mobileNeed < slots.length * 20) throw new Error(`target ${target} too small for base state ${world.ents.size}`);
  const base = Math.floor(mobileNeed / slots.length);
  const rem = mobileNeed % slots.length;
  const spawnPts = getSpawns(world.w, world.h);
  const army = [];
  const harvesters = [];
  const compCounts = Object.create(null);

  for (const [si, slot] of slots.entries()) {
    const count = base + (si < rem ? 1 : 0);
    const comp = compositionFor(count, theater.naval);
    for (const [i, kind] of comp.entries()) {
      compCounts[kind] = (compCounts[kind] ?? 0) + 1;
      const domain = UNITS[kind].domain;
      let e = null;
      if (kind === "harvester") {
        const s = spawnPts[slot];
        const home = nearestPassable(s.x, s.y, world.passable, 20, world.w, world.h) ?? s;
        const homeRegion = world.regionLand[world.idx(home.x, home.y)] ?? 0;
        e = spawnAt(world, used, slot, kind, home.x + 1, home.y + 4, "land", homeRegion, 56);
        if (e) {
          harvesters.push(e.id);
          continue;
        }
      }

      const fronts = domain === "sea" ? theater.sea : theater.land;
      if (!fronts.length) throw new Error(`no ${domain} front available for ${kind}`);
      const fi = (i + si) % fronts.length;
      const front = fronts[fi];
      const side = teamOf(slot) === 1 ? "a" : "b";
      const other = side === "a" ? "b" : "a";
      const center = front[side];
      const region = domain === "air" ? 0 : front[`${side}Region`];
      e = spawnAt(world, used, slot, kind, center.x, center.y, domain, region, 56);
      if (!e) {
        // Last-resort fallback keeps the entity target exact even if one narrow
        // theater is crowded; validation output still exposes any such fallback.
        const s = spawnPts[slot];
        e = spawnAt(world, used, slot, kind, s.x + 1, s.y + 4, domain, 0, 80);
      }
      if (!e) throw new Error(`could not spawn ${kind} for slot ${slot} near front ${fi}`);
      const wave = (i + si) % 3;
      army.push({
        id: e.id,
        slot,
        kind,
        domain,
        wave,
        frontIndex: fi,
        frontDomain: domain === "sea" ? "sea" : "land",
        side,
        dest: { x: front[other].x, y: front[other].y },
        activated: false,
        reinforcement: false,
      });
    }
  }
  return { army, harvesters, compCounts, mobileNeed };
}

function activateWave(world, army, wave) {
  const groups = new Map();
  let newly = 0;
  for (const m of army) {
    if (m.wave !== wave || m.activated) continue;
    m.activated = true;
    newly++;
    const key = `${m.slot}|${m.frontDomain}|${m.frontIndex}|${m.side}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { slot: m.slot, dest: m.dest, ids: [] }));
    g.ids.push(m.id);
  }
  let ordered = 0, denied = 0;
  for (const g of groups.values()) {
    const err = world.cmdOrder(g.slot, g.ids, "amove", g.dest.x, g.dest.y);
    if (err) denied++;
    else ordered += g.ids.length;
  }
  return { newly, groups: groups.size, ordered, denied };
}

function reinforcementSequence(naval) {
  const seq = REINFORCEMENT_SEQUENCE.filter((k) => naval || UNITS[k].domain !== "sea");
  if (!seq.length) throw new Error("empty reinforcement sequence");
  return seq;
}

function reinforce(world, slots, target, theater, used, state) {
  const deficit = target - world.ents.size;
  if (deficit < Math.max(2, Math.round(target * 0.005))) return { spawned: 0, ordered: 0, deficit, failed: 0 };
  const n = Math.min(deficit, Math.ceil(target * 0.06)); // bounded wave, not a teleport spike back to full strength
  resetOccupancy(world, used);
  const byTeam = [1, 2].map((team) => slots.filter((s) => teamOf(s) === team));
  const spawned = [];
  let failed = 0;
  for (let j = 0; j < n; j++) {
    const kind = state.reinfSeq[state.reinfSeqCursor++ % state.reinfSeq.length];
    const team = (state.reinfTeamFlip++ & 1) === 0 ? 1 : 2;
    const teamSlots = byTeam[team - 1];
    const slot = teamSlots[state.reinfSlotCursor++ % teamSlots.length];
    const domain = UNITS[kind].domain;
    const fronts = domain === "sea" ? theater.sea : theater.land;
    const fi = (state.reinfFrontCursor++ + j) % fronts.length;
    const front = fronts[fi];
    const side = team === 1 ? "a" : "b";
    const other = side === "a" ? "b" : "a";
    const center = front[side];
    const region = domain === "air" ? 0 : front[`${side}Region`];
    const e = spawnAt(world, used, slot, kind, center.x, center.y, domain, region, 72);
    if (!e) {
      failed++;
      continue;
    }
    spawned.push({
      id: e.id,
      slot,
      kind,
      domain,
      frontIndex: fi,
      frontDomain: domain === "sea" ? "sea" : "land",
      side,
      dest: { x: front[other].x, y: front[other].y },
    });
  }
  // Group reinforcement orders by owner/front so cmdOrder gets the same formation
  // destination spreading as ordinary player-issued group orders.
  const groups = new Map();
  for (const m of spawned) {
    const key = `${m.slot}|${m.frontDomain}|${m.frontIndex}|${m.side}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { slot: m.slot, dest: m.dest, ids: [] }));
    g.ids.push(m.id);
  }
  let ordered = 0;
  for (const g of groups.values()) {
    if (!world.cmdOrder(g.slot, g.ids, "amove", g.dest.x, g.dest.y)) ordered += g.ids.length;
  }
  state.reinforcements += spawned.length;
  return { spawned: spawned.length, ordered, deficit, failed };
}

// ---------- measurement helpers ----------
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}
function statsOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, v) => a + v, 0) / Math.max(1, values.length);
  return {
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}
function memUsage() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers };
}

async function runScenario(map, target) {
  reseed((SEED + hashString(map) + target * 7919) >>> 0);
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    globalThis.gc();
    await flushPerfEntries();
  }

  const slots = Array.from({ length: PLAYERS }, (_, i) => i);
  const teams = Object.fromEntries(slots.map((s) => [s, teamOf(s)]));
  const world = new World(slots, {
    map,
    teams,
    names: Object.fromEntries(slots.map((s) => [s, `stress-${s}`])),
    config: {
      startCredits: 20000,
      gameSpeed: 1,
      superweapons: true,
      crates: true,
      derricks: true,
      fog: true, // production default; server-side sim cost is unaffected by fog
      logistics: true,
    },
  });

  const baseInfo = placeEconomyBase(world, slots);
  const theater = prepareTheater(world, map);
  const used = { land: new Set(), air: new Set(), sea: new Set() };
  resetOccupancy(world, used);
  const initial = spawnInitialArmies(world, slots, target, theater, used);
  if (world.ents.size !== target) throw new Error(`${map}/${target}: constructed entity count ${world.ents.size}, expected ${target}`);

  const state = {
    reinfSeq: reinforcementSequence(theater.naval),
    reinfSeqCursor: (hashString(map) + target) % 17,
    reinfSlotCursor: 0,
    reinfFrontCursor: 0,
    reinfTeamFlip: 0,
    reinforcements: 0,
  };
  const waveTicks = [0, 80, 170];
  const waveResults = [];
  const reinforceResults = [];
  let orderMsTotal = 0;
  let orderMsMax = 0;
  const eventCounts = Object.create(null);
  const records = [];
  const entCounts = [];
  const memSamples = [];
  let snapBase = null;
  let snapSeq = 0;
  let wireTotalMeas = 0;
  let keyframesMeas = 0;
  let snapshotsMeas = 0;

  const runSchedule = () => {
    const t0 = performance.now();
    for (const [wave, at] of waveTicks.entries()) {
      if (world.tick >= at && initial.army.some((m) => m.wave === wave && !m.activated)) {
        waveResults.push({ wave, tick: world.tick, ...activateWave(world, initial.army, wave) });
      }
    }
    if (!NO_REINFORCE && world.tick >= 150 && (world.tick - 150) % 24 === 0) {
      reinforceResults.push({ tick: world.tick, ...reinforce(world, slots, target, theater, used, state) });
    }
    const ms = performance.now() - t0;
    orderMsTotal += ms;
    orderMsMax = Math.max(orderMsMax, ms);
  };

  const simAndBroadcastTick = (recording) => {
    runSchedule();
    for (const k of Object.keys(subTimes)) subTimes[k] = 0;
    PATH_STATS.reset();
    const t0 = performance.now();
    world.step();
    const simMs = performance.now() - t0;

    let snapMs = 0, diffMs = 0, jsonMs = 0, wireBytes = 0, keyframe = false;
    if (world.tick % 2 === 0) {
      let ts0 = performance.now();
      const snap = world.snapshot();
      snapMs = performance.now() - ts0;
      snapSeq++;
      const isKey = !snapBase || snapSeq % SNAP_KEYFRAME_EVERY === 0;
      keyframe = isKey;
      ts0 = performance.now();
      if (isKey) {
        wireBytes = JSON.stringify({ t: "snap", seq: snapSeq, key: true, tick: world.tick, ...snap }).length;
      } else {
        const diff = diffSnaps(snapBase.snap, snap);
        diffMs = performance.now() - ts0;
        ts0 = performance.now();
        wireBytes = JSON.stringify({ t: "snapd", seq: snapSeq, tick: world.tick, ...diff, events: snap.events }).length;
      }
      jsonMs = performance.now() - ts0;
      snapBase = { snap };
      if (recording) {
        wireTotalMeas += wireBytes;
        snapshotsMeas++;
        if (isKey) keyframesMeas++;
        for (const ev of snap.events) eventCounts[ev.e] = (eventCounts[ev.e] ?? 0) + 1;
      }
    }
    const totalMs = performance.now() - t0;
    if (!recording) return;

    const rec = {
      tick: world.tick,
      ents: world.ents.size,
      ms: totalMs,
      simMs,
      snapMs,
      diffMs,
      jsonMs,
      broadcastMs: snapMs + diffMs + jsonMs,
      wireBytes,
      keyframe,
      astarMs: PATH_STATS.ms,
      astarCalls: PATH_STATS.calls,
      astarExp: PATH_STATS.expanded,
      astarFail: PATH_STATS.failed,
      astarCapped: PATH_STATS.capped,
    };
    if (BREAKDOWN) {
      for (const k of SUBSTEP) rec[`s_${k}`] = subTimes[k] ?? 0;
      for (const k of INSIDE) rec[`i_${k}`] = subTimes[k] ?? 0;
    }
    records.push(rec);
    entCounts.push(world.ents.size);
    memSamples.push({ tick: world.tick, ...memUsage() });
  };

  // When available, discard setup-only allocation noise before the warm-up, then
  // leave the process alone: the measurement itself must show natural GC pressure.
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    await flushPerfEntries();
  }
  // Warmup is real simulation (wave 0 paths and moves), but is excluded from the
  // distribution so one-process JIT/shape warmup does not masquerade as sim cost.
  for (let i = 0; i < WARMUP; i++) simAndBroadcastTick(false);
  const measPerfStart = performance.now();
  const memStart = memUsage();
  for (let i = 0; i < TICKS && world.winner === null; i++) simAndBroadcastTick(true);
  const measPerfEnd = performance.now();
  const memEnd = memUsage();
  await flushPerfEntries();

  const totalStats = statsOf(records.map((r) => r.ms));
  const simStats = statsOf(records.map((r) => r.simMs));
  const broadcastStats = statsOf(records.map((r) => r.broadcastMs));
  const snapStats = statsOf(records.map((r) => r.snapMs));
  const jsonStats = statsOf(records.map((r) => r.jsonMs));
  const astarStats = statsOf(records.map((r) => r.astarMs));
  const over35 = records.filter((r) => r.ms > 35).length;
  const over40 = records.filter((r) => r.ms > 40).length;
  const over80pair = records.filter((r) => r.ms > 80).length;
  const meanEnts = entCounts.reduce((a, v) => a + v, 0) / Math.max(1, entCounts.length);
  const heapValues = memSamples.map((m) => m.heapUsed);
  const rssValues = memSamples.map((m) => m.rss);
  const gcInWindow = gcEntries.filter((e) => e.startTime >= measPerfStart && e.startTime <= measPerfEnd);
  const gcByKind = Object.create(null);
  let gcDuration = 0, gcMax = 0;
  for (const e of gcInWindow) {
    const k = gcKindName(e.kind);
    gcByKind[k] = (gcByKind[k] ?? 0) + 1;
    gcDuration += e.duration;
    gcMax = Math.max(gcMax, e.duration);
  }

  const breakdown = [];
  if (BREAKDOWN) {
    const avg = (f) => records.reduce((a, r) => a + f(r), 0) / Math.max(1, records.length);
    const add = (label, perTick, note = "") => breakdown.push({ label, perTick, note });
    add("tickEnt (all ents)", avg((r) => r.s_tickEnt ?? 0), "inclusive");
    add("  stepAlong", avg((r) => r.i_stepAlong ?? 0), "inside tickEnt/harvester");
    add("  nearestEnemy", avg((r) => r.i_nearestEnemy ?? 0), "inside tickEnt");
    add("  tryFire", avg((r) => r.i_tryFire ?? 0), "inside tickEnt");
    add("  tickHarvester", avg((r) => r.i_tickHarvester ?? 0), "inside tickEnt");
    add("  pathNear", avg((r) => r.i_pathNear ?? 0), "inside tickEnt");
    add("  entsInRange", avg((r) => r.i_entsInRange ?? 0), "nested in fire/crates/direct");
    add("  nearestOre", avg((r) => r.i_nearestOre ?? 0), "inside harvester");
    add("  recomputeRegions", avg((r) => r.i_recomputeRegions ?? 0), "lazy connectivity rebuild");
    add("A* findPath", avg((r) => r.astarMs), `${avg((r) => r.astarCalls).toFixed(1)} calls/tick, ${avg((r) => r.astarExp).toFixed(0)} expansions/tick`);
    add("rebuildSpatialGrid", avg((r) => r.s_rebuildSpatialGrid ?? 0));
    add("separate", avg((r) => r.s_separate ?? 0));
    add("snapshot+diff+JSON", avg((r) => r.broadcastMs), "amortized over every tick");
    add("tickProduction", avg((r) => r.s_tickProduction ?? 0));
    add("tickEwJamming", avg((r) => r.s_tickEwJamming ?? 0));
    add("tickCrates", avg((r) => r.s_tickCrates ?? 0));
    add("tickLogistics", avg((r) => r.s_tickLogistics ?? 0));
    add("tickDepots+Derricks+Vet", avg((r) => (r.s_tickDepots ?? 0) + (r.s_tickDerricks ?? 0) + (r.s_tickVetRegen ?? 0)));
    add("regenOre", avg((r) => r.s_regenOre ?? 0));
    add("checkEnd", avg((r) => r.s_checkEnd ?? 0));
    breakdown.sort((a, b) => b.perTick - a.perTick);
  }

  const disconnected = [
    ...theater.land.filter((f) => !f.connected).map((f, i) => `land${i}`),
    ...theater.sea.filter((f) => !f.connected).map((f, i) => `sea${i}`),
  ];
  const result = {
    map,
    target,
    dims: `${world.w}x${world.h}`,
    ticks: records.length,
    warmup: WARMUP,
    finalTick: world.tick,
    entity: {
      start: target,
      mean: meanEnts,
      min: Math.min(...entCounts),
      max: Math.max(...entCounts),
      end: world.ents.size,
    },
    tickMs: totalStats,
    simMs: simStats,
    broadcastMs: broadcastStats,
    snapMs: snapStats,
    jsonMs: jsonStats,
    astar: {
      ms: astarStats,
      callsPerTick: records.reduce((a, r) => a + r.astarCalls, 0) / Math.max(1, records.length),
      expansionsPerTick: records.reduce((a, r) => a + r.astarExp, 0) / Math.max(1, records.length),
      failed: records.reduce((a, r) => a + r.astarFail, 0),
      capped: records.reduce((a, r) => a + r.astarCapped, 0),
    },
    over35,
    over40,
    over80pair,
    wire: {
      bytesPerSnapshot: wireTotalMeas / Math.max(1, snapshotsMeas),
      keyframes: keyframesMeas,
      snapshots: snapshotsMeas,
    },
    memory: {
      heapStart: memStart.heapUsed,
      heapEnd: memEnd.heapUsed,
      heapPeak: Math.max(...heapValues, memEnd.heapUsed),
      heapDelta: memEnd.heapUsed - memStart.heapUsed,
      heapTotalEnd: memEnd.heapTotal,
      rssStart: memStart.rss,
      rssEnd: memEnd.rss,
      rssPeak: Math.max(...rssValues, memEnd.rss),
      externalEnd: memEnd.external,
      arrayBuffersEnd: memEnd.arrayBuffers,
      gcByKind,
      gcCount: gcInWindow.length,
      gcDuration,
      gcMax,
    },
    orders: {
      waves: waveResults,
      reinforcements: reinforceResults,
      reinforcementTotal: state.reinforcements,
      orderMsTotal,
      orderMsMax,
    },
    activity: { ...eventCounts },
    composition: initial.compCounts,
    economy: {
      refineriesPlaced: baseInfo.placed.length,
      refineryFailures: baseInfo.failed,
      harvesters: initial.harvesters.length,
    },
    theater: {
      landFronts: theater.land,
      seaFronts: theater.sea,
      disconnected,
    },
    breakdown,
    records: KEEP_RECORDS ? records : undefined,
  };
  return result;
}

function verdictFor(r) {
  if (r.tickMs.mean > BUDGET || r.tickMs.p95 > BUDGET) return "OVER";
  if (r.tickMs.p99 > BUDGET || r.tickMs.mean > BUDGET * 0.75) return "MARGINAL";
  return "OK";
}

function printMainTable(results) {
  console.log(`\nServer stress results — production-shaped tick = world.step() + snapshot/diff/JSON amortized at 5 Hz`);
  console.log(`scenario: ${PLAYERS} players, fixed 4v4 teams, mixed land/air${MAPS.some((m) => m !== "crossroads") ? "/sea" : ""} armies, harvest/economy, fog=true, logistics=true, waves at t=0/80/170 + casualty replacement`);
  console.log(`budget reference: ${BUDGET}ms/tick; measurement excludes the first ${WARMUP} warm-up ticks and excludes order-injection time (reported separately).`);
  console.log("");
  console.log("map                 target  ents mean/min-max    prod mean  p50   p99   max | sim mean  p99 | bcast mean | >40ms  verdict");
  console.log("------------------  ------  ------------------  ---------  ----  ----  ---- | --------  --- | ---------- | -----  --------");
  for (const r of results) {
    const ents = `${r.entity.mean.toFixed(0)}/${r.entity.min}-${r.entity.max}`;
    console.log(
      `${r.map.padEnd(18)} ${String(r.target).padStart(6)}  ${ents.padEnd(18)}  ${fmt(r.tickMs.mean).padStart(9)}  ${fmt(r.tickMs.p50).padStart(4)}  ${fmt(r.tickMs.p99).padStart(4)}  ${fmt(r.tickMs.max).padStart(4)} | ${fmt(r.simMs.mean).padStart(8)}  ${fmt(r.simMs.p99).padStart(3)} | ${fmt(r.broadcastMs.mean).padStart(10)} | ${String(r.over40).padStart(5)}  ${verdictFor(r).padEnd(8)}`,
    );
  }
}

function printDetails(results) {
  for (const r of results) {
    console.log(`\n[detail] ${r.map} target=${r.target} dims=${r.dims} ticks=${r.ticks} endTick=${r.finalTick}`);
    console.log(
      `  ents mean=${r.entity.mean.toFixed(1)} min=${r.entity.min} max=${r.entity.max} end=${r.entity.end} | ` +
      `sim mean/p99/max=${fmt(r.simMs.mean)}/${fmt(r.simMs.p99)}/${fmt(r.simMs.max)}ms | ` +
      `A* mean=${fmt(r.astar.ms.mean)}ms/tick calls=${r.astar.callsPerTick.toFixed(1)}/tick exp=${r.astar.expansionsPerTick.toFixed(0)}/tick fail=${r.astar.failed} capped=${r.astar.capped}`,
    );
    console.log(
      `  activity shots=${r.activity.shot ?? 0} hits=${r.activity.hit ?? 0} kills=${r.activity.kill ?? 0} booms=${r.activity.boom ?? 0} ` +
      `oreEvents=${r.activity.ore ?? 0} income=${r.activity.income ?? 0} spawns=${r.activity.spawn ?? 0} | ` +
      `reinforcements=${r.orders.reinforcementTotal} orderInject max=${fmt(r.orders.orderMsMax)}ms`,
    );
    console.log(
      `  memory heap ${mib(r.memory.heapStart).toFixed(1)}→${mib(r.memory.heapEnd).toFixed(1)}MiB peak=${mib(r.memory.heapPeak).toFixed(1)} delta=${mib(r.memory.heapDelta).toFixed(1)} | ` +
      `rss ${mib(r.memory.rssStart).toFixed(1)}→${mib(r.memory.rssEnd).toFixed(1)}MiB peak=${mib(r.memory.rssPeak).toFixed(1)} | ` +
      `gc count=${r.memory.gcCount} (${Object.entries(r.memory.gcByKind).map(([k, v]) => `${k}:${v}`).join(" ") || "none"}) total=${fmt(r.memory.gcDuration)}ms max=${fmt(r.memory.gcMax)}ms`,
    );
    console.log(
      `  economy refineries=${r.economy.refineriesPlaced}/${PLAYERS} harvesters=${r.economy.harvesters} ` +
      `${r.economy.refineryFailures.length ? "failures=" + JSON.stringify(r.economy.refineryFailures) : "no refinery failures"} | ` +
      `wire avg=${(r.wire.bytesPerSnapshot / 1024).toFixed(1)}KiB/snapshot keyframes=${r.wire.keyframes}`,
    );
    if (r.theater.disconnected.length) console.log(`  warning: disconnected theater endpoints: ${r.theater.disconnected.join(",")}`);
    if (r.breakdown.length) {
      console.log("  attribution (instrumented, inclusive/nested; overhead inflates absolute ms):");
      console.log("    subsystem                     ms/tick  note");
      console.log("    ---------------------------   -------  -----");
      for (const b of r.breakdown.slice(0, 14)) console.log(`    ${b.label.padEnd(29)} ${b.perTick.toFixed(3).padStart(7)}  ${b.note}`);
    }
  }
}

// ---------- main ----------
mkdirSync(".tmp", { recursive: true });
const results = [];
for (const map of MAPS) {
  for (const count of COUNTS) {
    const t0 = performance.now();
    console.error(`[stress] running ${map} target=${count} warmup=${WARMUP} ticks=${TICKS}${BREAKDOWN ? " breakdown" : ""}...`);
    const r = await runScenario(map, count);
    results.push(r);
    console.error(`[stress] done ${map}/${count}: mean=${r.tickMs.mean.toFixed(2)}ms p99=${r.tickMs.p99.toFixed(2)}ms wall=${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }
}

printMainTable(results);
printDetails(results);

if (JSON_OUT) {
  const out = results.map((r) => ({ ...r }));
  writeFileSync(JSON_OUT, JSON.stringify({ created: new Date().toISOString(), args: { MAPS, COUNTS, TICKS, WARMUP, PLAYERS, SEED, BUDGET, BREAKDOWN }, results: out }, null, 1));
  console.log(`\n[stress] wrote ${JSON_OUT}`);
}

Math.random = originalRandom;
