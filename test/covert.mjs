#!/usr/bin/env node
// Grey-box suite for covert ops + pause mechanics on the authoritative sim:
// spy snapshot disguise, auto-target exclusion, radar reveal, sabotage
// effects, THAAD-only ballistic interception, and localnet pause freeze.
//   node test/covert.mjs

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
const { LocalRoom } = await import("../src/client/localnet.ts");

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function makeWorld(map = "basin") {
  return new World([0, 1], { map, teams: { 0: 1, 1: 2 }, names: { 0: "A", 1: "B" } });
}
function spawn(w, slot, kind, x, y) {
  return w["spawnUnit"](slot, kind, x, y);
}
function spawnBuilding(w, slot, kind, tx, ty) {
  return w["placeBuilding"](slot, kind, tx, ty);
}
function run(w, n, collect) {
  const evs = [];
  for (let i = 0; i < n; i++) {
    w.step();
    const snap = w.snapshot();
    if (collect) evs.push(...snap.events);
  }
  return evs;
}
function ent(w, id) {
  return w["ents"].get(id);
}

// ---------- 1. Spy snapshot disguise ----------
{
  const w = makeWorld();
  const spy = spawn(w, 0, "spy", 10, 10);
  const snap = w.snapshot();
  const s = snap.ents.find((e) => e.id === spy.id);
  ok(s && s.k === "infantry", "spy snapshot disguised as infantry");
  ok(s && s.disg === "spy", "snapshot carries disg: spy");
}

// ---------- 2. Auto-target exclusion + manual attack allowed ----------
{
  const w = makeWorld();
  const enemy = spawn(w, 1, "spy", 11, 10); // hostile spy next to our tank
  const tank = spawn(w, 0, "tank", 10, 10);
  run(w, 40); // let auto-acquisition happen
  const t = ent(w, tank.id);
  ok(t && t.aimTarget !== enemy.id, "auto-acquire ignores disguised spy");
  // Manual attack order should still hit it
  w.cmdOrder(0, [tank.id], "attack", enemy.x, enemy.y, enemy.id);
  run(w, 200);
  ok(!ent(w, enemy.id) || ent(w, enemy.id).hp <= 0, "manual attack kills spy");
}

// ---------- 3. Radar reveal ----------
{
  const w = makeWorld();
  const spy = spawn(w, 1, "spy", 12, 10);
  spawnBuilding(w, 0, "radar", 8, 8);
  const p0 = w["players"].get(0);
  p0.pwrHave = 500; p0.pwrUse = 0; // ensure radar powered
  run(w, 30);
  const s = ent(w, spy.id);
  ok(s && s.spottedUntil > w["tick"], "powered radar blows spy cover");
  const snap = w.snapshot();
  const ds = snap.ents.find((e) => e.id === spy.id);
  ok(ds && ds.k === "spy", "revealed spy snapshot shows real kind");
}

// ---------- 4. Sabotage: power cut ----------
{
  const w = makeWorld();
  const pp = spawnBuilding(w, 1, "power", 12, 12);
  const spy = spawn(w, 0, "spy", 10, 12);
  const p1 = w["players"].get(1);
  p1.credits = 5000;
  w.cmdOrder(0, [spy.id], "attack", pp.x, pp.y, pp.id); // spy sabotages the plant it attacks
  const evs = run(w, 120, true);
  ok(p1.powerCutUntil > 0, "power sabotage sets blackout timer");
  ok(evs.some((e) => e.e === "sabotage" && e.slot === 0 && e.vslot === 1), "sabotage event emitted with owner+victim");
  ok(!ent(w, spy.id) || ent(w, spy.id).hp <= 0, "spy consumed by sabotage");
}

// ---------- 5. THAAD-only ballistic interception ----------
{
  const w = makeWorld();
  const tel = spawn(w, 1, "ballistic", 30, 30); // enemy TEL = attacker
  const thaad = spawnBuilding(w, 0, "thaad", 10, 10);
  spawnBuilding(w, 0, "turret", 20, 10); // non-THAAD battery present but must not engage
  const p0 = w["players"].get(0);
  p0.pwrHave = 500; p0.pwrUse = 0;
  let intercepted = 0;
  for (let i = 0; i < 50; i++) {
    thaad.interceptCd = 0;
    if (w["tryIntercept"](tel, 10, 10)) intercepted++;
  }
  ok(intercepted > 25 && intercepted < 50, `THAAD intercepts ~80% of ballistic shots (got ${intercepted}/50)`);
  const inf = spawn(w, 1, "infantry", 30, 32);
  ok(w["tryIntercept"](inf, 10, 10) === false, "non-interceptable shooter unaffected by THAAD");
}

// ---------- 6. Pause freezes local sim ----------
{
  const room = new LocalRoom();
  const msgs = [];
  room.onMsg = (m) => msgs.push(m);
  room.send({ t: "join", name: "Tester", token: "tt1" });
  room.send({ t: "addbot", diff: "easy" });
  room.send({ t: "start" });
  clearInterval(room["timer"]); // drive ticks synchronously
  const tickOf = () => room["world"]["tick"];
  const t0 = tickOf();
  room.send({ t: "pause", paused: true });
  for (let i = 0; i < 30; i++) room["tick"]();
  ok(tickOf() === t0, "paused local world does not step");
  ok(msgs.some((m) => m.t === "paused" && m.paused === true), "paused broadcast received");
  room.send({ t: "pause", paused: false });
  for (let i = 0; i < 30; i++) room["tick"]();
  ok(tickOf() > t0, "unpaused local world resumes stepping");
}

console.log(`\ncovert: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
