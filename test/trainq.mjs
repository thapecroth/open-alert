import { registerHooks, createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
registerHooks({
  resolve(s, c, n) { try { return n(s, c); } catch (e) { if ((s.startsWith("./")||s.startsWith("../")) && !/\.[a-z0-9]+$/i.test(s)) return n(s+".ts", c); throw e; } },
  load(u, c, n) { const r = n(u, c); if (u.endsWith(".ts")) { const o = ts.transpileModule(String(r.source), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: u }); return { format: "module", source: o.outputText, shortCircuit: true }; } return r; },
});
const { World } = await import("../src/server/world.ts");
const { UNITS, BUILDINGS } = await import("../src/shared/gamedefs.ts");

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FAIL", n); } };

const newWorld = () => new World([0, 1], { map: "basin", teams: { 0: 1, 1: 2 } });
const placeBuilding = (w, slot, kind, tx, ty) => w["placeBuilding"](slot, kind, tx, ty);
const destroyEnt = (w, e) => w["destroy"](e);
const recomputePower = (w, slot) => w["recomputePower"](slot);
const expectedTicks = (baseTicks, speed) => Math.ceil(baseTicks / speed - 1e-9);
const ownEnt = (w, slot, kind) => [...w.ents.values()].find((e) => e.o === slot && e.k === kind);
const ticksUntil = (w, done, cap = 300) => {
  let t = 0;
  while (!done() && t < cap) {
    w.step();
    t++;
  }
  return t;
};
const findSpot = (w, slot, kind) => {
  const d = BUILDINGS[kind];
  for (let ty = 0; ty <= w.h - d.h; ty++)
    for (let tx = 0; tx <= w.w - d.w; tx++)
      if (w.canPlace(slot, kind, tx, ty) === null) return { tx, ty };
  return null;
};

// ---------- mixed FIFO queue + cap ----------
const w = newWorld();
const p = w.players.get(0);
p.credits = 50000;

const has = w["hasBuilding"](0, "barracks");
console.log("  has barracks:", has);
if (!has) placeBuilding(w, 0, "barracks", 10, 4);

// MIXED queue — was impossible before ("queue busy")
ok(w.cmdTrain(0, "infantry") === null, "queue infantry");
ok(w.cmdTrain(0, "engineer") === null, "queue engineer (different kind — was rejected before)");
ok(w.cmdTrain(0, "infantry") === null, "queue infantry again");
const arr = p.queues.barracks;
ok(arr?.length === 3, `queue holds 3 items: ${arr?.map(i=>i.unit).join(",")}`);
ok(arr[0].unit === "infantry" && arr[1].unit === "engineer" && arr[2].unit === "infantry", "FIFO order preserved");

// head ticks down, completes, next unit auto-starts
const before = w.ents.size;
for (let i = 0; i < UNITS.infantry.buildTicks + 30; i++) w.step();
ok(p.queues.barracks?.[0]?.unit === "engineer", `infantry done → engineer now head: ${p.queues.barracks?.map(i=>i.unit)}`);
ok(w.ents.size > before, "infantry actually spawned");

// cancel by cat+index — remove the trailing infantry
const credits = p.credits;
w.cmdTrainCancel(0, undefined, "barracks", 1);
ok(p.queues.barracks?.length === 1, `index-cancel dropped tail: ${p.queues.barracks?.map(i=>i.unit)}`);
ok(p.credits > credits, `refunded ${p.credits - credits}`);

// cancel by unit kind (lastIndexOf) — engineer gone → queue empties
w.cmdTrainCancel(0, "engineer");
ok(!p.queues.barracks?.length, "kind-cancel emptied queue");

// queue cap: 30 accepted, further commands denied
for (let i = 0; i < 34; i++) w.cmdTrain(0, "infantry");
ok(p.queues.barracks?.length === 30, `cap at 30: ${p.queues.barracks?.length}`);
const creditsAtCap = p.credits;
ok(w.cmdTrain(0, "infantry") === "queue full" && p.credits === creditsAtCap, "31st train denied without charging");

// serialize round-trip preserves deep mixed queue
const d = w.serialize();
const w2 = World.deserialize(d);
const arr2 = w2.players.get(0).queues.barracks;
ok(arr2?.length === 30 && arr2[0].unit === "infantry", "serialize keeps 30-deep queue");

// snapshot emits arrays
const snap = w.snapshot();
ok(Array.isArray(snap.players[0].queues.barracks), "snapshot queues are arrays");

// ---------- duplicate producers speed unit training ----------
function trainTicks(barracksCount) {
  const wt = newWorld();
  const pt = wt.players.get(0);
  pt.credits = 50000;
  placeBuilding(wt, 0, "power", 10, 7); // keep the timing measurement out of low-power half-rate
  for (let i = 0; i < barracksCount; i++) placeBuilding(wt, 0, "barracks", 10 + i * 3, 4);
  recomputePower(wt, 0);
  ok(wt.cmdTrain(0, "infantry") === null, `train timing setup (${barracksCount} barracks)`);
  return ticksUntil(wt, () => !pt.queues.barracks?.length, 200);
}
const oneBarracksTicks = trainTicks(1);
const twoBarracksTicks = trainTicks(2);
const fiveBarracksTicks = trainTicks(5);
ok(oneBarracksTicks === UNITS.infantry.buildTicks, `1 barracks trains infantry in base ${oneBarracksTicks} ticks`);
ok(twoBarracksTicks === expectedTicks(UNITS.infantry.buildTicks, 1.25) && twoBarracksTicks < oneBarracksTicks, `2 barracks train faster: ${oneBarracksTicks} → ${twoBarracksTicks} ticks`);
ok(fiveBarracksTicks === expectedTicks(UNITS.infantry.buildTicks, 2), `5 barracks hit the ×2 cap: ${oneBarracksTicks} → ${fiveBarracksTicks} ticks`);

// ---------- Forward Supply Hub is the backup construction yard ----------
{
  const dead = newWorld();
  const dp = dead.players.get(0);
  dp.credits = 50000;
  destroyEnt(dead, ownEnt(dead, 0, "conyard"));
  const err = dead.cmdBuild(0, "power");
  ok(typeof err === "string" && /construction yard|supply hub/i.test(err), `no conyard + no hub still blocks construction (${err})`);
}

const fw = newWorld();
let fp = fw.players.get(0);
fp.credits = 50000;
placeBuilding(fw, 0, "supplyhub", 10, 4);
// A lone hub consumes power; give the fallback base a power plant so this test
// isolates construction speed rather than the intentional low-power half-rate.
placeBuilding(fw, 0, "power", 13, 4);
destroyEnt(fw, ownEnt(fw, 0, "conyard"));
// construction capability is derived from live buildings, so it must survive a save/load round-trip
const fwr = World.deserialize(fw.serialize());
fp = fwr.players.get(0);
fp.credits = 50000;
ok(fwr.cmdBuild(0, "power") === null, "conyard destroyed + forward hub still starts construction (after save/load)");
const fallbackTicks = ticksUntil(fwr, () => fp.awaiting.includes("power"), 120);
ok(fallbackTicks === BUILDINGS.power.buildTicks, `one forward hub keeps baseline build speed (${fallbackTicks} ticks)`);
const spot = findSpot(fwr, 0, "power");
ok(!!spot, `legal placement exists near forward hub ${spot ? `at ${spot.tx},${spot.ty}` : ""}`);
ok(!!spot && fwr.cmdPlace(0, spot.tx, spot.ty, "structure", "power") === null, "power places through forward-base build radius rules");
ok([...fwr.ents.values()].some((e) => e.o === 0 && e.k === "power"), "fallback-placed power plant exists");

// ---------- duplicate forward hubs speed building construction ----------
function constructionTicks(hubCount) {
  const wb = newWorld();
  const pb = wb.players.get(0);
  pb.credits = 50000;
  placeBuilding(wb, 0, "power", 10, 7); // keep the timing measurement out of low-power half-rate
  for (let i = 0; i < hubCount; i++) placeBuilding(wb, 0, "supplyhub", 10 + i * 3, 4);
  recomputePower(wb, 0);
  const err = wb.cmdBuild(0, "power");
  return { err, ticks: ticksUntil(wb, () => pb.awaiting.includes("power"), 200) };
}
const oneHub = constructionTicks(1);
const twoHubs = constructionTicks(2);
const fiveHubs = constructionTicks(5);
ok(oneHub.err === null && oneHub.ticks === BUILDINGS.power.buildTicks, `1 forward hub builds power in base ${oneHub.ticks} ticks`);
ok(twoHubs.err === null && twoHubs.ticks === expectedTicks(BUILDINGS.power.buildTicks, 1.25) && twoHubs.ticks < oneHub.ticks, `2 forward hubs build faster: ${oneHub.ticks} → ${twoHubs.ticks} ticks`);
ok(fiveHubs.err === null && fiveHubs.ticks === expectedTicks(BUILDINGS.power.buildTicks, 2), `5 forward hubs hit the ×2 cap: ${oneHub.ticks} → ${fiveHubs.ticks} ticks`);

// Structure and defense fabrication are parallel queues; both consume the same hub multiplier.
{
  const both = newWorld();
  const pb = both.players.get(0);
  pb.credits = 50000;
  placeBuilding(both, 0, "power", 10, 7);
  placeBuilding(both, 0, "supplyhub", 10, 4);
  placeBuilding(both, 0, "supplyhub", 13, 4);
  recomputePower(both, 0);
  ok(both.cmdBuild(0, "power") === null && both.cmdBuild(0, "turret") === null, "structure + defense queues start in parallel");
  const turretTicks = expectedTicks(BUILDINGS.turret.buildTicks, 1.25);
  const powerTicks = expectedTicks(BUILDINGS.power.buildTicks, 1.25);
  for (let i = 0; i < turretTicks; i++) both.step();
  ok(pb.awaitingDef.includes("turret") && !pb.awaiting.includes("power"), `defense queue also gets ×1.25 (turret done at ${turretTicks}/${BUILDINGS.turret.buildTicks} ticks)`);
  for (let i = 0; i < powerTicks - turretTicks; i++) both.step();
  ok(pb.awaiting.includes("power"), `structure queue completes on the same ×1.25 curve (power at ${powerTicks}/${BUILDINGS.power.buildTicks} ticks)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
