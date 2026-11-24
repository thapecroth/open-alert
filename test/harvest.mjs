#!/usr/bin/env node
// Harvester anti-jam regression: multiple harvesters on one ore patch must
// claim DIFFERENT tiles (no pileup on a single center) and must not get
// frozen/parked forever.   node test/harvest.mjs

import { registerHooks, createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (err) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z0-9]+$/i.test(specifier))
        return next(specifier + ".ts", context);
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

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// basin has open land; drop a refinery + a dense ore patch + 3 harvesters
const w = new World([0, 1], { map: "basin", teams: { 0: 1, 1: 2 }, names: { 0: "A", 1: "B" } });
const p0 = w["players"].get(0);
p0.credits = 20000;

// clear a work area & lay ore tiles near (20,20)
const ore = w["ore"];
const idx = (x, y) => y * w["w"] + x;
for (let y = 24; y < 30; y++) for (let x = 20; x < 26; x++) ore[idx(x, y)] = 100;
// a small second patch further out for spreading
for (let y = 30; y < 34; y++) for (let x = 24; x < 28; x++) ore[idx(x, y)] = 100;

const ref = w["placeBuilding"](0, "refinery", 14, 24);
ok(!!ref, "refinery placed");

const hvs = [];
for (let i = 0; i < 3; i++) hvs.push(w["spawnUnit"](0, "harvester", 18 + i, 21));
ok(hvs.every((h) => h && h.k === "harvester"), "3 harvesters spawned");

// run 400 ticks of auto-harvest
for (let i = 0; i < 400; i++) w.step();

const working = hvs.filter((h) => w["ents"].has(h.id));
const tiles = working.map((h) => h.oreIdx).filter((t) => t >= 0);
const uniqueTiles = new Set(tiles);
ok(
  uniqueTiles.size === tiles.length || tiles.length === 0,
  `harvesters claim distinct ore tiles (tiles=${tiles.join(",")})`,
);
const mining = working.filter((h) => h.hstate === "mining" || h.hstate === "toOre" || h.hstate === "toRef");
ok(mining.length >= 2, `at least 2 harvesters actively cycling (states=${working.map((h) => h.hstate).join(",")})`);

// nobody should sit perfectly still with work available — measure drift over 60 ticks
const before = working.map((h) => [h.x, h.y]);
for (let i = 0; i < 60; i++) w.step();
const moved = working.filter((h, i) => Math.abs(h.x - before[i][0]) + Math.abs(h.y - before[i][1]) > 0.01 || h.hstate === "mining");
ok(moved.length === working.length, `no harvester frozen while ore remains (${moved.length}/${working.length} moving/mining)`);

// pileup check: two harvesters should not occupy the same tile center
let overlapped = false;
for (let i = 0; i < working.length; i++)
  for (let j = i + 1; j < working.length; j++) {
    const a = working[i], b = working[j];
    if (Math.abs(a.x - b.x) < 0.4 && Math.abs(a.y - b.y) < 0.4) overlapped = true;
  }
ok(!overlapped, "no two harvesters stacked on the same spot");

// income actually flowed
const earned = w["players"].get(0).creditsEarned;
ok(earned > 0, `ore income earned (${earned})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
