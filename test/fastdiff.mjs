#!/usr/bin/env node
// End-to-end wire equivalence: the snapDelta fast path (worker.ts broadcastSnap
// fast path) must reassemble into client state IDENTICAL to the classic
// standalone diffSnaps stream. Evolves a heavy bot battle, then for each frame
// diffs the snapshot both ways, feeds two parallel SnapReassemblers through the
// exact JSON wire encoding, and deep-compares the reassembled states.
//
//   node test/fastdiff.mjs [--ticks 3600] [--frames 150]

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
const { diffSnaps, SnapReassembler } = await import("../src/shared/snapdelta.ts");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const EVOLVE = Number(arg("ticks", "3600")) || 3600;
const FRAMES = Number(arg("frames", "150")) || 150;
const KEYFRAME_EVERY = 20;

const slots = Array.from({ length: 8 }, (_, i) => i);
const teams = {};
for (const s of slots) teams[s] = 0;
const world = new World(slots, {
  map: "fulda_gap",
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

for (let t = 0; t < EVOLVE && world.winner === null; t++) {
  stepOnce();
  if (world.tick % 2 === 0) world.snapshot();
}
console.log(`[fastdiff] evolved to tick ${world.tick} — ents=${world.ents.size} winner=${world.winner}`);

// two parallel client streams: A = classic standalone diffSnaps (old behavior),
// B = snapDelta fast path (new broadcastSnap behavior)
const rxA = new SnapReassembler();
const rxB = new SnapReassembler();
let prevSnap = null; // classic baseline: {ents, crates, bridges, players} slice of previous frame
let prevRaw = null; // fast-path baseline: the previous raw snapshot() return object
let seq = 0;
let frames = 0;
let fastHits = 0;
let mismatches = 0;
let firstMismatch = null;

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (let f = 0; f < FRAMES && world.winner === null; f++) {
  stepOnce();
  stepOnce();
  const raw = world.snapshot();
  seq++;
  const isKey = !prevSnap || seq % KEYFRAME_EVERY === 0;
  frames++;

  if (isKey) {
    const wire = JSON.parse(JSON.stringify({ t: "snap", seq, key: true, tick: world.tick, ...raw }));
    rxA.keyframe(wire);
    rxB.keyframe(JSON.parse(JSON.stringify(wire)));
  } else {
    const classic = diffSnaps(prevSnap, raw);
    const meta = world.snapDelta;
    const fast = meta && prevRaw === meta.from ? meta.diff : null;
    if (fast) fastHits++;
    const wireA = JSON.parse(JSON.stringify({ t: "snapd", seq, tick: world.tick, ...classic, events: raw.events }));
    const wireB = JSON.parse(JSON.stringify({ t: "snapd", seq, tick: world.tick, ...(fast ?? classic), events: raw.events }));
    const fullA = rxA.delta(wireA);
    const fullB = rxB.delta(wireB);
    if (!fullA || !fullB) {
      mismatches++;
      firstMismatch ??= `frame ${f}: reassembler returned null (A=${!!fullA} B=${!!fullB})`;
    } else {
      // compare client-visible state: ents (order-independent), players, crates, bridges
      const mapOf = (full) => {
        const m = new Map();
        for (const e of full.ents) m.set(e.id, e);
        return m;
      };
      const ma = mapOf(fullA);
      const mb = mapOf(fullB);
      let bad = null;
      if (ma.size !== mb.size) bad = `ent count ${ma.size} vs ${mb.size}`;
      if (!bad) {
        for (const [id, ea] of ma) {
          const eb = mb.get(id);
          if (!eb) { bad = `ent ${id} missing in B`; break; }
          if (!deepEq(ea, eb)) { bad = `ent ${id} differs: A=${JSON.stringify(ea)} B=${JSON.stringify(eb)}`; break; }
        }
      }
      if (!bad && !deepEq(fullA.players, fullB.players)) bad = "players differ";
      if (!bad && !deepEq(fullA.crates ?? [], fullB.crates ?? [])) bad = "crates differ";
      if (!bad && !deepEq(fullA.bridges ?? [], fullB.bridges ?? [])) bad = "bridges differ";
      if (bad) {
        mismatches++;
        firstMismatch ??= `frame ${f} (seq ${seq}): ${bad}`;
      }
    }
  }
  prevSnap = { ents: raw.ents, crates: raw.crates, bridges: raw.bridges, players: raw.players };
  prevRaw = raw;
}

console.log(`[fastdiff] ${frames} frames — fast-path hits: ${fastHits}/${Math.max(1, frames - Math.ceil(frames / KEYFRAME_EVERY))} delta frames`);
if (firstMismatch) console.log(`[fastdiff] FIRST MISMATCH: ${firstMismatch}`);
console.log(`[fastdiff] ${mismatches === 0 ? "PASS" : "FAIL"} — reassembled states ${mismatches === 0 ? "identical" : `diverge on ${mismatches} frames`}`);
process.exit(mismatches === 0 ? 0 : 1);
