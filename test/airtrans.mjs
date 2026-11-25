import { registerHooks, createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
registerHooks({
  resolve(s, c, n) { try { return n(s, c); } catch (e) { if ((s.startsWith("./")||s.startsWith("../")) && !/\.[a-z0-9]+$/i.test(s)) return n(s+".ts", c); throw e; } },
  load(u, c, n) { const r = n(u, c); if (u.endsWith(".ts")) { const o = ts.transpileModule(String(r.source), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: u }); return { format: "module", source: o.outputText, shortCircuit: true }; } return r; },
});
const { World } = await import("../src/server/world.ts");
const { transportCapOf } = await import("../src/shared/gamedefs.ts");

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FAIL", n); } };

// logistics disabled so the airframe doesn't run dry mid-test — fuel is orthogonal to troop transport
const mk = () => new World([0, 1], { map: "crossroads", teams: { 0: 1, 1: 2 }, config: { logistics: false } });

// find a passable land tile with some open room around it
function openLand(w) {
  for (let y = 2; y < w.h - 2; y++)
    for (let x = 2; x < w.w - 2; x++)
      if (w.passable(x, y) && w.passable(x + 1, y) && w.passable(x, y + 1) && w.passable(x - 1, y) && w.passable(x, y - 1))
        return { x, y };
  throw new Error("no open land");
}

const stepUntil = (w, cond, guardMax = 3000) => {
  let g = 0;
  while (!cond() && g++ < guardMax) w.step();
  return g;
};

// ---------- 1. boarding: infantry embark, leave the world entity set ----------
{
  const w = mk();
  const spot = openLand(w);
  const chop = w["spawnUnit"](0, "chopper", spot.x, spot.y);
  const inf = w["spawnUnit"](0, "infantry", spot.x + 2, spot.y);
  const cntBefore = w.slotCnt[0];
  const err = w.cmdOrder(0, [inf.id], "board", chop.x, chop.y, chop.id);
  ok(err === null, `board order accepted (${err})`);
  ok(inf.order?.kind === "board" && inf.order?.target === chop.id, "infantry got target-encoded board order");
  const g = stepUntil(w, () => !w.ents.has(inf.id));
  ok(!w.ents.has(inf.id), `infantry embarked after ${g} ticks — gone from world ents`);
  ok((chop.passengers?.length ?? 0) === 1, "chopper carries 1 passenger");
  ok(chop.passengers?.[0]?.id === inf.id, "passenger keeps its entity id");
  ok(w.slotCnt[0] === cntBefore - 1, "slotCnt drops for embarked infantry (out of elimination headcount)");
  ok(!w.ents.has(inf.id) && chop.passengers[0].hp === inf.mhp, "passenger hp/identity preserved");
}

// ---------- 2. capacity: 4 seats, the 5th squad member is left behind ----------
{
  const w = mk();
  const spot = openLand(w);
  const chop = w["spawnUnit"](0, "chopper", spot.x, spot.y);
  ok(transportCapOf("chopper") === 4, "chopper transportCap is 4");
  const squad = [];
  for (let i = 0; i < 5; i++) squad.push(w["spawnUnit"](0, "infantry", spot.x + 2, spot.y + (i % 2)));
  w.cmdOrder(0, squad.map((s) => s.id), "board", chop.x, chop.y, chop.id);
  stepUntil(w, () => (chop.passengers?.length ?? 0) >= 4);
  ok((chop.passengers?.length ?? 0) === 4, "exactly 4 passengers aboard");
  stepUntil(w, () => squad.filter((s) => w.ents.has(s.id) && !s.order).length >= 1, 600);
  const leftBehind = squad.filter((s) => w.ents.has(s.id));
  ok(leftBehind.length === 1, `5th infantry stays behind in the world (${leftBehind.length} left)`);
  ok(leftBehind[0] && leftBehind[0].order?.kind !== "board", "left-behind infantry is not stuck on a board order");
}

// ---------- 3. passengers ride along — position mirrors the transport in flight ----------
{
  const w = mk();
  const spot = openLand(w);
  const chop = w["spawnUnit"](0, "chopper", spot.x, spot.y);
  const inf = w["spawnUnit"](0, "infantry", spot.x + 2, spot.y);
  w.cmdOrder(0, [inf.id], "board", chop.x, chop.y, chop.id);
  stepUntil(w, () => !w.ents.has(inf.id));
  // fly the transport far away
  const fx = Math.min(w.w - 3, spot.x + 15), fy = Math.min(w.h - 3, spot.y + 10);
  w.cmdOrder(0, [chop.id], "move", fx, fy);
  stepUntil(w, () => !chop.order, 3000);
  ok(Math.abs(chop.passengers[0].x - chop.x) < 0.01 && Math.abs(chop.passengers[0].y - chop.y) < 0.01,
    "passenger position mirrors the transport mid-flight");
}

// ---------- 4. unload: passengers disembark onto passable land at the drop zone ----------
{
  const w = mk();
  const spot = openLand(w);
  const chop = w["spawnUnit"](0, "chopper", spot.x, spot.y);
  const squad = [];
  for (let i = 0; i < 3; i++) squad.push(w["spawnUnit"](0, "infantry", spot.x + 2, spot.y + (i % 2)));
  w.cmdOrder(0, squad.map((s) => s.id), "board", chop.x, chop.y, chop.id);
  stepUntil(w, () => (chop.passengers?.length ?? 0) >= 3);
  const cntBefore = w.slotCnt[0];
  // drop zone: open land a short flight away
  const dz = { x: Math.min(w.w - 3, spot.x + 10), y: spot.y };
  while (!w.passable(dz.x, dz.y) && dz.x > 2) dz.x--;
  ok(w.passable(dz.x, dz.y), `drop zone ${dz.x},${dz.y} is passable land`);
  const err = w.cmdOrder(0, [chop.id], "unload", dz.x + 0.5, dz.y + 0.5);
  ok(err === null && chop.order?.kind === "unload", `unload order accepted (${err})`);
  stepUntil(w, () => !chop.passengers?.length && !chop.order, 3000);
  ok(!chop.passengers?.length, "all passengers disembarked");
  ok(!chop.order, "unload order completes");
  const back = squad.filter((s) => w.ents.has(s.id));
  ok(back.length === 3, `all 3 infantry back in the world entity set (${back.length})`);
  ok(w.slotCnt[0] === cntBefore + 3, "slotCnt restored on disembark");
  const near = back.every((s) => Math.abs(s.x - dz.x - 0.5) <= 8.5 && Math.abs(s.y - dz.y - 0.5) <= 8.5);
  ok(near, "passengers land near the drop zone");
  ok(back.every((s) => w.passable(Math.floor(s.x), Math.floor(s.y))), "every passenger on a passable tile");
  ok(back.every((s, i) => squad[i] && s.hp > 0), "passengers alive with hp intact");
}

// ---------- 5. empty transport treats unload as a plain move ----------
{
  const w = mk();
  const spot = openLand(w);
  const chop = w["spawnUnit"](0, "chopper", spot.x, spot.y);
  w.cmdOrder(0, [chop.id], "unload", spot.x + 6.5, spot.y + 0.5);
  const g = stepUntil(w, () => !chop.order, 2000);
  ok(!chop.order, `empty transport unload completes as a move after ${g} ticks`);
  ok(Math.abs(chop.x - (spot.x + 6.5)) < 1.6, "transport actually flew to the drop zone");
}

// ---------- 6. passengers die with the transport ----------
{
  const w = mk();
  const spot = openLand(w);
  const chop = w["spawnUnit"](0, "chopper", spot.x, spot.y);
  const squad = [];
  for (let i = 0; i < 2; i++) squad.push(w["spawnUnit"](0, "infantry", spot.x + 2, spot.y + i));
  w.cmdOrder(0, squad.map((s) => s.id), "board", chop.x, chop.y, chop.id);
  stepUntil(w, () => (chop.passengers?.length ?? 0) >= 2);
  const p0 = w.players.get(0);
  const lostBefore = p0.unitsLost;
  w["destroy"](chop, 1);
  ok(!w.ents.has(chop.id), "transport destroyed");
  ok(p0.unitsLost === lostBefore + 3, `unitsLost counts transport + 2 passengers (+${p0.unitsLost - lostBefore})`);
  ok(squad.every((s) => !w.ents.has(s.id)), "passengers never re-enter the world");
  stepUntil(w, () => false, 30); // let the sim tick — passengers must not pop back
  for (let i = 0; i < 30; i++) w.step();
  ok(squad.every((s) => !w.ents.has(s.id)), "passengers stay dead after further ticks");
}

// ---------- 7. serialize round-trip mid-flight preserves passengers ----------
{
  const w = mk();
  const spot = openLand(w);
  const chop = w["spawnUnit"](0, "chopper", spot.x, spot.y);
  const inf = w["spawnUnit"](0, "infantry", spot.x + 2, spot.y);
  w.cmdOrder(0, [inf.id], "board", chop.x, chop.y, chop.id);
  stepUntil(w, () => !w.ents.has(inf.id));
  inf.hp = Math.max(1, inf.hp - 20); // wound the passenger — hp must survive the save
  const d = w.serialize();
  const w2 = World.deserialize(d);
  const chop2 = [...w2.ents.values()].find((e) => e.k === "chopper" && e.o === 0);
  ok(!!chop2, "transport present after load");
  ok((chop2?.passengers?.length ?? 0) === 1, "passenger count survives serialize round-trip");
  ok(chop2?.passengers?.[0]?.id === inf.id, "passenger id survives round-trip");
  ok(chop2?.passengers?.[0]?.hp === inf.hp, "passenger hp survives round-trip");
  ok(!w2.ents.has(inf.id), "passenger still outside world ents after load");
  // and the unloaded passenger re-enters the world correctly in the restored game
  const dz = { x: Math.min(w2.w - 3, spot.x + 6), y: spot.y };
  w2.cmdOrder(0, [chop2.id], "unload", dz.x + 0.5, dz.y + 0.5);
  stepUntil(w2, () => !chop2.passengers?.length && !chop2.order, 3000);
  ok(w2.ents.has(inf.id), "passenger disembarks correctly in the restored world");
}

// ---------- 8. validation & degradation rules ----------
{
  const w = mk();
  const spot = openLand(w);
  const chop = w["spawnUnit"](0, "chopper", spot.x, spot.y);
  const enemyChop = w["spawnUnit"](1, "chopper", spot.x + 4, spot.y);
  const tank = w["spawnUnit"](0, "tank", spot.x + 2, spot.y);
  const inf = w["spawnUnit"](0, "infantry", spot.x + 2, spot.y + 1);

  // non-infantry board degrades to move
  w.cmdOrder(0, [tank.id], "board", chop.x, chop.y, chop.id);
  ok(tank.order?.kind === "move", "tank board order degrades to plain move");

  // boarding an ENEMY transport degrades to move (only own rides accepted)
  w.cmdOrder(0, [inf.id], "board", enemyChop.x, enemyChop.y, enemyChop.id);
  ok(inf.order?.kind === "move", "board on enemy transport degrades to move");

  // unload order on a non-transport is skipped entirely
  w.cmdOrder(0, [inf.id], "unload", spot.x + 5.5, spot.y + 0.5);
  ok(inf.order?.kind !== "unload", "non-transport cannot take unload orders");
  w.cmdOrder(0, [chop.id], "unload", spot.x + 5.5, spot.y + 0.5);
  ok(chop.order?.kind === "unload", "transport takes the unload order");

  // bogus kinds are still rejected
  ok(w.cmdOrder(0, [inf.id], "flyto", spot.x, spot.y) !== null, "unknown order kind rejected");
}

// ---------- 9. snapshot wire format: cargo = passenger count for transports ----------
{
  const w = mk();
  const spot = openLand(w);
  const chop = w["spawnUnit"](0, "chopper", spot.x, spot.y);
  const inf = w["spawnUnit"](0, "infantry", spot.x + 2, spot.y);
  w.cmdOrder(0, [inf.id], "board", chop.x, chop.y, chop.id);
  stepUntil(w, () => !w.ents.has(inf.id));
  const snap = w.snapshot();
  const cs = snap.ents.find((s) => s.id === chop.id);
  ok(cs?.cargo === 1, `snapshot cargo = 1 passenger aboard (got ${cs?.cargo})`);
  ok(!snap.ents.some((s) => s.id === inf.id), "embarked passenger absent from snapshot");
  // empty transport still emits cargo 0 (kind-dependent scalar, mirrors ore/supply reuse)
  const empty = snap.ents.find((s) => s.id === chop.id);
  w["destroy"](chop, 1);
  ok(empty?.cargo === 1, "cargo scalar present pre-destruction");
}

// ---------- 10. edge cases: shift-queued board, retask, transport death mid-board ----------
{
  const w = mk();
  const spot = openLand(w);
  const chop = w["spawnUnit"](0, "chopper", spot.x, spot.y);
  const inf = w["spawnUnit"](0, "infantry", spot.x + 8, spot.y);
  // queue: walk a move waypoint first, THEN board — the shift-queue chain must hold
  w.cmdOrder(0, [inf.id], "move", spot.x + 2.5, spot.y + 0.5);
  w.cmdOrder(0, [inf.id], "board", chop.x, chop.y, chop.id, true);
  ok(inf.order?.kind === "move" && inf.orderQueue[0]?.kind === "board", "board order queues behind the move waypoint");
  const g = stepUntil(w, () => !w.ents.has(inf.id));
  ok(!w.ents.has(inf.id) && chop.passengers?.length === 1, `queued board embarks after the waypoint chain (${g} ticks)`);

  // retasking a walking boarder with a move order cancels the boarding run
  const inf2 = w["spawnUnit"](0, "infantry", spot.x + 8, spot.y + 1);
  w.cmdOrder(0, [inf2.id], "board", chop.x, chop.y, chop.id);
  w.cmdOrder(0, [inf2.id], "move", spot.x + 8.5, spot.y + 3.5);
  ok(inf2.order?.kind === "move", "retask with move cancels the board order");

  // transport destroyed while a boarder is en route — the infantry stands down, never freezes
  const inf3 = w["spawnUnit"](0, "infantry", spot.x + 9, spot.y + 2);
  w.cmdOrder(0, [inf3.id], "board", chop.x, chop.y, chop.id);
  w["destroy"](chop, 1);
  for (let i = 0; i < 40; i++) w.step();
  ok(inf3.order?.kind !== "board", "board order clears when the ride dies en route (no freeze)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
