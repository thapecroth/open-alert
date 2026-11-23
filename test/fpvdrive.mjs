#!/usr/bin/env node
// Grey-box suite for 1P drive mechanics on the authoritative World sim:
// sprint speed+fuel, aircraft altitude, lock persistence, AC-130 weapon
// select, and kill-confirm events. Mirrors the real client by re-sending
// cmdDrive every 10 ticks (drive expiry is 14 ticks) and draining events
// through snapshot() each step.
//   node test/fpvdrive.mjs

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
const { UNITS } = await import("../src/shared/gamedefs.ts");

let passN = 0, failN = 0;
const fails = [];
const ok = (cond, name, ev = "") => {
  if (cond) { passN++; console.log(`ok: ${name}`); }
  else { failN++; fails.push(name); console.log(`FAIL: ${name} ${ev}`); }
};

function makeWorld() {
  return new World(
    [
      { id: "p0", name: "A" },
      { id: "p1", name: "B" },
    ],
    { map: "crossroads", config: { logistics: true } },
  );
}

function spawn(w, slot, kind, x, y) {
  const e = w["spawnUnit"](slot, kind, x, y);
  return e;
}

// Drive `n` steps, re-sending cmdDrive every 10 ticks with `args` = (fwd,strafe,yaw,fire,aimX,aimY,aimTarget,alt,sprint,wpn,lock)
function drive(w, id, args, n, collect = null) {
  const evs = [];
  for (let i = 0; i < n; i++) {
    if (i % 10 === 0) w.cmdDrive(0, id, ...args);
    w.step();
    const snap = w.snapshot();
    if (collect) evs.push(...snap.events);
  }
  return evs;
}

// ---------- 1. Sprint: speed x1.4 + extra fuel burn ----------
{
  // Isolated runs (same start spot, own world) so separation physics can't skew distance
  const runDist = (sprint) => {
    const w = makeWorld();
    const t = spawn(w, 0, "tank", 10, 40);
    const x0 = t.x;
    drive(w, t.id, [1, 0, 0, false, undefined, undefined, undefined, undefined, sprint], 20);
    return t.x - x0;
  };
  const dNormal = runDist(false), dSprint = runDist(true);
  ok(dNormal > 1, `normal drive moved (${dNormal.toFixed(2)} tiles)`);
  ok(Math.abs(dSprint / dNormal - 1.4) < 0.05, `sprint is 1.4x distance (${dNormal.toFixed(2)} vs ${dSprint.toFixed(2)})`);

  const w = makeWorld();
  const t1 = spawn(w, 0, "tank", 10, 40);
  const t2 = spawn(w, 0, "tank", 40, 40);
  drive(w, t1.id, [1, 0, 0, false], 20);
  drive(w, t2.id, [1, 0, 0, false, undefined, undefined, undefined, undefined, true], 20);
  const f1 = 100 - t1.fuel, f2 = 100 - t2.fuel;
  ok(f2 > f1 * 1.4, `sprint burns >1.4x fuel (${f1.toFixed(2)} vs ${f2.toFixed(2)})`);
}

// ---------- 2. Aircraft altitude ----------
{
  const w = makeWorld();
  const jet = spawn(w, 0, "a10", 20, 20);
  ok(jet.fpvAlt === undefined, "aircraft has no fpvAlt before takeover");
  drive(w, jet.id, [0, 0, 0, false, undefined, undefined, undefined, 1], 20); // climb
  ok(jet.fpvAlt !== undefined && jet.fpvAlt > 0.6, `alt+1 climbs (${jet.fpvAlt?.toFixed(2)})`);
  drive(w, jet.id, [0, 0, 0, false, undefined, undefined, undefined, -1], 40); // dive
  ok(jet.fpvAlt < 0.6, `alt-1 dives (${jet.fpvAlt?.toFixed(2)})`);
  // snapshot carries alt while driven — keep direct alive with a re-send
  w.cmdDrive(0, jet.id, 0, 0, 0, false, undefined, undefined, undefined, 0);
  w.step();
  const snap = w.snapshot();
  const sentAlt = snap.ents.find((s) => s.id === jet.id)?.alt;
  ok(sentAlt !== undefined, `snapshot emits alt=${sentAlt}`);
  // let direct expire (14 ticks idle)
  for (let i = 0; i < 20; i++) { w.step(); w.snapshot(); }
  ok(jet.fpvAlt === undefined, "fpvAlt cleared after direct timeout");
  ok(w.snapshot().ents.find((s) => s.id === jet.id)?.alt === undefined, "alt omitted after clear");
}

// ---------- 3. Lock persistence + kill-confirm events ----------
{
  const w = makeWorld();
  const me = spawn(w, 0, "tank", 10, 10);
  const foe = spawn(w, 1, "infantry", 13, 10);
  foe.hp = 30;
  const evs = drive(w, me.id, [0, 0, 0, true, foe.x, foe.y, undefined, undefined, false, undefined, foe.id], 300, true);
  const kill = evs.find((ev) => ev.e === "kill" && ev.src === me.id && ev.id === foe.id);
  ok(!!kill, "kill-confirm event emitted with src=driver id");
  ok(!w.ents.has(foe.id) || foe.hp <= 0, "locked target destroyed");
}

// ---------- 4. AC-130 weapon select ----------
{
  const w = makeWorld();
  const ac = spawn(w, 0, "ac130", 20, 20);
  const foe = spawn(w, 1, "tank", 24, 20);
  foe.hp = 9999; foe.mhp = 9999; // keep it alive to count shots
  const evs25 = drive(w, ac.id, [0, 0, 0, true, foe.x, foe.y, foe.id, undefined, false, 2], 60, true);
  const shots25 = evs25.filter((e) => e.e === "shot" && e.src === ac.id && e.w === "brrrt").length;
  ok(shots25 >= 8, `25MM slot fires brrrt rapidly (${shots25} shots/60t)`);
  const evs105 = drive(w, ac.id, [0, 0, 0, true, foe.x, foe.y, foe.id, undefined, false, 0], 60, true);
  const shots105 = evs105.filter((e) => e.e === "shot" && e.src === ac.id && e.w === "cannon").length;
  ok(shots105 >= 1 && shots105 <= 2, `105MM slot is slow heavy cannon (${shots105} shots/60t)`);
  const dmg25 = evs25.filter((e) => e.e === "hit" && e.id === foe.id).length;
  ok(dmg25 >= 8, `25MM hits register (${dmg25} hit events)`);
}

console.log(`\n${passN} passed, ${failN} failed`);
if (failN > 0) { console.log("failures:", fails.join(", ")); process.exit(1); }
