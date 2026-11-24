import { registerHooks, createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
registerHooks({
  resolve(s, c, n) { try { return n(s, c); } catch (e) { if ((s.startsWith("./")||s.startsWith("../")) && !/\.[a-z0-9]+$/i.test(s)) return n(s+".ts", c); throw e; } },
  load(u, c, n) { const r = n(u, c); if (u.endsWith(".ts")) { const o = ts.transpileModule(String(r.source), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: u }); return { format: "module", source: o.outputText, shortCircuit: true }; } return r; },
});
const { World } = await import("../src/server/world.ts");
const { UNITS } = await import("../src/shared/gamedefs.ts");

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FAIL", n); } };

const w = new World([0, 1], { map: "basin", teams: { 0: 1, 1: 2 } });
const p = w.players.get(0);
p.credits = 50000;

// player 0 starts with a barracks in gym worlds? spawn one directly
w["spawnBuilding"] ? null : null;
// find existing barracks or build via cmdPlace after instant queue? use buildingsOf check
const has = w.hasBuilding(0, "barracks");
console.log("  has barracks:", has);
if (!has) { console.log("  (no barracks — placing one via placeBuilding)"); w["placeBuilding"](0, "barracks", 4, 4); }

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
w.cmdTrainCancel(0, undefined, "barracks", 1); // index 1 = trailing infantry? no: [rocket, infantry] → idx1 = infantry
ok(p.queues.barracks?.length === 1, `index-cancel dropped tail: ${p.queues.barracks?.map(i=>i.unit)}`);
ok(p.credits > credits, `refunded ${p.credits - credits}`);

// cancel by unit kind (lastIndexOf) — rocket gone → queue empties
w.cmdTrainCancel(0, "engineer");
ok(!p.queues.barracks?.length, "kind-cancel emptied queue");

// queue cap
for (let i = 0; i < 14; i++) w.cmdTrain(0, "infantry");
ok(p.queues.barracks?.length === 12, `cap at 12: ${p.queues.barracks?.length}`);

// serialize round-trip preserves mixed queue
const d = w.serialize();
const w2 = World.deserialize(d);
const arr2 = w2.players.get(0).queues.barracks;
ok(arr2?.length === 12 && arr2[0].unit === "infantry", "serialize keeps queue");

// snapshot emits arrays
const snap = w.snapshot();
ok(Array.isArray(snap.players[0].queues.barracks), "snapshot queues are arrays");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
