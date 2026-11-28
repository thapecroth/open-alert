#!/usr/bin/env node
// Bot idle-unit re-tasking harness — in-process, no sockets.
// Evolves a 4-bot FFA and samples, every 50 ticks, how many ARMED combat units
// per bot are truly idle (no order, empty queue, not held). Passivity shows up
// as idle samples accumulating in the mid/late game; a bot that re-tasks its
// units keeps the count low outside the pre-first-wave massing phase.
//
//   node test/botidle.mjs [--ticks 6000] [--seed 7] [--quiet]
//
// Exits nonzero if the post-first-wave idle mean exceeds the (generous) gate.

import { registerHooks, createRequire } from "node:module";

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
const { UNITS, BUILDINGS } = await import("../src/shared/gamedefs.ts");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const MAXTICKS = Number(arg("ticks", "6000")) || 6000;
const SEED = Number(arg("seed", "7")) || 7;
const QUIET = process.argv.includes("--quiet");

// deterministic Math.random (mulberry32) so before/after runs evolve comparable games
{
  let s = SEED >>> 0;
  Math.random = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slots = [0, 1, 2, 3];
const teams = {};
for (const s of slots) teams[s] = 0; // FFA
const world = new World(slots, {
  map: "fulda_gap",
  teams,
  config: { startCredits: 12000, gameSpeed: 1, superweapons: true, crates: true, derricks: true, fog: true, logistics: true },
});
const diffs = ["normal", "brutal", "normal", "brutal"];
const profiles = ["balanced", "rusher", "turtle", "tech"];
const bots = slots.map((s, i) => new AIBot(`bot-${s}`, { diff: diffs[i], profile: profiles[i % 4] }));

const isArmed = (k) => !(k in BUILDINGS) && (UNITS[k]?.dmg ?? 0) > 0;

// per-slot accumulators
const stats = slots.map(() => ({
  samples: 0,
  idleSum: 0, // idle armed-unit count summed over samples (post warm-up)
  armySum: 0,
  worst: 0, // worst single-sample idle count post warm-up
  streak: 0, // current consecutive samples with >=3 idle armed units
  worstStreak: 0,
}));
const WARMUP = 1500; // massing phase before the first waves is legitimate — don't count it
const STEP = 50;

const t0 = performance.now();
let lastLine = "";
for (let t = 0; t < MAXTICKS && world.winner === null; t++) {
  for (let b = 0; b < slots.length; b++) {
    try {
      bots[b].tick(world, slots[b]);
    } catch {
      /* noise */
    }
  }
  world.step();
  if (world.tick % 2 === 0) world.snapshot(); // drain events like production does

  if (world.tick % STEP === 0) {
    for (let i = 0; i < slots.length; i++) {
      const st = stats[i];
      // mirror the bot's reservedTransport(): the lowest-id transport chopper is
      // intentional airlift standby, not passivity — exclude it from the idle count
      let taxi = -1;
      for (const e of world.ents.values()) {
        if (e.o !== slots[i] || e.k in BUILDINGS) continue;
        if ((UNITS[e.k]?.transportCap ?? 0) > 0 && (taxi < 0 || e.id < taxi)) taxi = e.id;
      }
      let idle = 0,
        army = 0;
      for (const e of world.ents.values()) {
        if (e.o !== slots[i] || e.k in BUILDINGS) continue;
        if (!isArmed(e.k)) continue;
        army++;
        if (!e.order && e.orderQueue.length === 0 && !e.hold && e.id !== taxi) idle++;
      }
      if (world.tick >= WARMUP) {
        st.samples++;
        st.idleSum += idle;
        st.armySum += army;
        if (idle > st.worst) st.worst = idle;
        if (idle >= 3) {
          st.streak++;
          if (st.streak > st.worstStreak) st.worstStreak = st.streak;
        } else st.streak = 0;
      }
    }
  }
  if (!QUIET && world.tick % 1000 === 0) {
    lastLine = `t=${world.tick} ents=${world.ents.size}`;
    console.log(`[botidle] ${lastLine}`);
  }
}
const wall = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\n[botidle] done tick=${world.tick} winner=${world.winner} wall=${wall}s`);
console.log(`[botidle] (post-warmup t>=${WARMUP}, sampled every ${STEP}t — idle = armed, no order, empty queue)`);

let worstMean = 0,
  worstRatio = 0,
  worstStreakAll = 0;
for (let i = 0; i < slots.length; i++) {
  const st = stats[i];
  if (!st.samples) {
    console.log(`  slot${i} (${diffs[i]}/${profiles[i]}): no samples (eliminated early?)`);
    continue;
  }
  const meanIdle = st.idleSum / st.samples;
  const meanArmy = st.armySum / st.samples;
  const ratio = meanArmy > 0.5 ? meanIdle / meanArmy : 0;
  worstMean = Math.max(worstMean, meanIdle);
  worstRatio = Math.max(worstRatio, ratio);
  worstStreakAll = Math.max(worstStreakAll, st.worstStreak);
  console.log(
    `  slot${i} (${diffs[i]}/${profiles[i]}): meanIdle=${meanIdle.toFixed(2)} meanArmy=${meanArmy.toFixed(1)} idleFrac=${(ratio * 100).toFixed(0)}% worst=${st.worst} worstStreak(>=3idle)=${st.worstStreak} samples=${st.samples}`,
  );
}
console.log(`[botidle] worstMeanIdle=${worstMean.toFixed(2)} worstIdleFrac=${(worstRatio * 100).toFixed(0)}% worstStreak=${worstStreakAll}`);

// Generous gates — calibrated against the fixed implementation with margin, so
// map/gameplay entropy has room without false failures. The pre-retask baseline
// sits far above these (see commit message).
const GATE_MEAN = 4.0;
const GATE_FRAC = 0.55;
let fail = 0;
if (worstMean > GATE_MEAN) {
  console.log(`FAIL: worst mean idle ${worstMean.toFixed(2)} > ${GATE_MEAN}`);
  fail++;
}
if (worstRatio > GATE_FRAC) {
  console.log(`FAIL: worst idle fraction ${(worstRatio * 100).toFixed(0)}% > ${GATE_FRAC * 100}%`);
  fail++;
}
if (!fail) console.log("PASS: idle combat units stay low after warm-up");
process.exit(fail ? 1 : 0);
