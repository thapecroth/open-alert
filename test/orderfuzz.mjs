// test/orderfuzz.mjs — order/move edge-case fuzz against the live sim.
// Two humans in one room: "Fuzz" (slot 0, top-left spawn) drives all orders;
// "Idle" (slot 1, bottom-right spawn) issues no unit orders, so its starting
// squad is a deterministic static target. ~3min runtime.
//
// Run: node test/orderfuzz.mjs   (expects `wrangler dev` on :8787)
//
import { wsconn } from "./wsconn.mjs";
// Semantics relied on (src/server/world.ts):
//  - cmdOrder: denies "off map" (x,y floor-checked even for attack),
//    "bad order" (unknown kind), "nothing to order" (all ids skipped:
//    foreign/bldg ids, unarmed attack/amove, bad target, non-ore non-own-ref
//    harvest). Skipped ids keep their previous order.
//  - stepAlong: unreachable destinations resolve via nearestPassable(r=12),
//    so the unit marches to the closest reachable tile and completes.
//  - cmdStop: clears order/hstate/agro, sets holdUntil=+150t which suppresses
//    harvester auto-resume (~15s).
//  - engineer: exempt from the unarmed-order skip; attack on enemy building
//    walks in and captures (tryCapture, edge-dist <= CAPTURE_RANGE).
const ROOM = "ofz" + Date.now().toString(36);
const URL = `ws://localhost:8787/parties/game-room/${ROOM}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, skip = 0;
const results = [];
const check = (name, c, ev = "") => {
  if (c === null || c === undefined) {
    skip++;
    results.push({ name, ok: null, ev });
    console.log(`SKIP: ${name} — ${ev}`);
    return;
  }
  c ? pass++ : fail++;
  results.push({ name, ok: !!c, ev });
  console.log(`${c ? "PASS" : "FAIL"}: ${name}${ev ? " — " + ev : ""}`);
};
const notes = [];
const note = (s) => { notes.push(s); console.log(`note: ${s}`); };

function conn(name, token) {
  const st = wsconn(URL, name, token, {
    onmsg: (m, st) => {
      if (m.t === "lobby") st.lobby = m;
      if (m.t === "init") {
        st.mapW = m.w;
        st.mapH = m.h;
      }
      if (m.t === "snap") {
        st.events.push(...(m.events ?? []));
        const cur = new Set(m.ents.map((x) => x.id));
        for (const id of st.prevIds) if (!cur.has(id)) st.deadIds.add(id);
        st.prevIds = cur;
        if (st.snaps.length > 400) st.snaps.shift();
      }
    },
  });
  st.events = [];
  st.deadIds = new Set();
  st.prevIds = new Set();
  return st;
}
const send = (s, m) => s.ws.send(JSON.stringify(m));
const lastSnap = (s) => s.snaps[s.snaps.length - 1];
const ent = (s, id) => lastSnap(s)?.ents.find((e) => e.id === id);
const mine = (s, k) => (lastSnap(s)?.ents ?? []).filter((e) => e.o === s.slot && (!k || e.k === k));
const theirs = (s, slot, k) => (lastSnap(s)?.ents ?? []).filter((e) => e.o === slot && (!k || e.k === k));
const D = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const dEnt = (a, b) => (a && b ? D(a.x, a.y, b.x, b.y) : Infinity);
const deniesSince = (s, n) => s.msgs.slice(n).filter((m) => m.t === "deny").map((m) => m.msg);

async function waitFor(fn, ms, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(step);
  }
  return !!fn();
}
const waitTicks = (s, n, ms = 20000) => {
  const t0 = lastSnap(s)?.tick ?? 0;
  return waitFor(() => (lastSnap(s)?.tick ?? 0) - t0 >= n, ms);
};
// issue `f`; resolve with first deny msg produced by it (or null on timeout)
async function denyProbe(s, f, ms = 800) {
  const n0 = s.msgs.length;
  f();
  await waitFor(() => s.msgs.slice(n0).some((m) => m.t === "deny"), ms, 60);
  return deniesSince(s, n0)[0] ?? null;
}
const waitAwaiting = (st, kind, ms = 25000) => waitFor(() => lastSnap(st)?.players?.[st.slot]?.awaiting?.includes(kind), ms);
// ring of candidate placements until `kind` ent exists for st's slot
async function placeNear(st, kind, cx, cy) {
  for (const [tx, ty] of [[cx + 4, cy - 1], [cx - 5, cy + 1], [cx + 4, cy + 3], [cx - 1, cy - 5], [cx - 5, cy - 2], [cx + 1, cy + 5], [cx - 5, cy - 4], [cx + 5, cy - 3]])
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        send(st, { t: "place", tx: Math.round(tx + dx), ty: Math.round(ty + dy) });
        await sleep(160);
        const found = mine(st, kind)[0];
        if (found) return found;
      }
  return null;
}
// sample ent position for `ms`; returns displacement + end-of-window stability
async function moveWatch(s, id, p0, ms) {
  const pos = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const e = ent(s, id);
    if (!e) return { dead: true, maxD: Math.max(0, ...pos.map((p) => D(p.x, p.y, p0.x, p0.y))), end: pos.at(-1), pos };
    pos.push({ x: e.x, y: e.y });
    await sleep(400);
  }
  const maxD = Math.max(0, ...pos.map((p) => D(p.x, p.y, p0.x, p0.y)));
  const tail = pos.slice(-3);
  const tailDrift = tail.length >= 2 ? Math.max(...tail.slice(1).map((p) => D(p.x, p.y, tail[0].x, tail[0].y))) : 0;
  return { maxD, tailDrift, end: pos.at(-1), pos, dead: false };
}
const fmt = (p) => (p ? `(${p.x.toFixed(1)},${p.y.toFixed(1)})` : "∅");

// ============================ setup ============================
// Every valid map is now 192x192+ — corner spawns sit ~253 tiles apart, so a
// tank needs ~160s of pure walk to reach the enemy and an engineer ~250s,
// hopeless inside combat-evidence windows written for 96/128 maps. No small
// valid map exists to pin, so the harness uses two server-supported levers:
//  - setSlot in the lobby puts Idle on the adjacent north-edge spawn (~90 tiles
//    away along open ground) — order/combat semantics don't care about big-map
//    dynamics, and windows below still scale from the MEASURED spawn distance
//  - gameSpeed 2 doubles the sim clock — tick-domain mechanics are identical,
//    only wall-clock compresses (the sim never runs faster than nominal, so
//    every timed window keeps its worst-case direction under load)
const A = conn("Fuzz", "ofz-A");
// join ordering is a socket race — Fuzz must be in before Idle connects or Idle
// can land slot0/host and the host-only start/config below silently no-op
await waitFor(() => A.lobby?.players.length === 1, 5000);
const B = conn("Idle", "ofz-B");
await waitFor(() => A.lobby?.players.length === 2, 6000);

// pre-game order should be dropped without a deny or a crash
const nPre = A.msgs.length;
send(A, { t: "order", ids: [1, 2], kind: "move", x: 30, y: 30 });
await sleep(500);
check("0 order before game start ignored (no deny, no crash)", deniesSince(A, nPre).length === 0, `denies=${JSON.stringify(deniesSince(A, nPre))}`);

send(B, { t: "setSlot", slot: 4 });
await waitFor(() => A.lobby?.players.find((p) => p.name === "Idle")?.slot === 4, 5000);
send(A, { t: "setConfig", config: { gameSpeed: 2 } });
send(B, { t: "ready", ready: true });
await waitFor(() => A.lobby?.players.find((p) => p.name === "Idle")?.ready === true, 5000);
// start can race the ready broadcast under load — retry while no snapshot arrives
for (let tries = 0; tries < 6 && !((lastSnap(A)?.ents?.length ?? 0) > 0); tries++) {
  send(A, { t: "start" });
  await waitFor(() => (lastSnap(A)?.ents?.length ?? 0) > 0 && (lastSnap(B)?.ents?.length ?? 0) > 0, 3000, 150);
}
const started = (lastSnap(A)?.ents?.length ?? 0) > 0 && (lastSnap(B)?.ents?.length ?? 0) > 0;
check("0 2-human game started", started, `ents=${lastSnap(A)?.ents?.length ?? 0}`);
if (!started) {
  console.log("cannot proceed — no snapshots");
  process.exit(1);
}

const cyA = mine(A, "conyard")[0];
const cyB = theirs(A, B.slot, "conyard")[0];
const [tankA, tankB] = mine(A, "tank");
const [inf1, inf2, inf3] = mine(A, "infantry");
const enemyTank0 = theirs(A, B.slot, "tank")[0];
const enemyInf0 = theirs(A, B.slot, "infantry")[0];
const enemyCount0 = theirs(A, B.slot).length;
const oreCells = (A.msgs.find((m) => m.t === "init")?.ore ?? []).map(([x, y, amt]) => ({ x, y, amt }));
const spawnDist = cyA && cyB ? D(cyA.x, cyA.y, cyB.x, cyB.y) : 90;
note(`setup: A slot=${A.slot} cy=${fmt(cyA)} units=${mine(A).length} | B slot=${B.slot} cy=${fmt(cyB)} ents=${enemyCount0} oreCells=${oreCells.length} map=${A.mapW}x${A.mapH} spawnDist=${spawnDist.toFixed(0)}`);
// windows that must cover a cross-map walk scale with the measured spawn
// distance: nominal tiles/sec at gameSpeed 2 (20Hz), padded for the sim only
// ever running slower than nominal under load. Event-driven waitFors return
// early when satisfied — the padding is only paid on failure.
const SPEED2 = { tank: 0.16 * 20, inf: 0.1 * 20 }; // tiles/sec at 20Hz nominal
const walkMs = (tiles, speed) => (tiles / speed) * 1000 * 2.2 + 15000;

// kick off refinery builds on both sides (harvester + enemy-refinery-tile test)
send(A, { t: "build", kind: "refinery" });
send(B, { t: "build", kind: "refinery" });

// ============================ [8] spoofed enemy ids ============================
{
  const p0 = { x: enemyTank0.x, y: enemyTank0.y };
  const n0 = A.msgs.length;
  send(A, { t: "order", ids: [enemyTank0.id], kind: "move", x: 10, y: 40 });
  send(A, { t: "order", ids: [enemyTank0.id], kind: "attack", x: 20, y: 20, target: inf3.id });
  send(A, { t: "stop", ids: [enemyTank0.id] });
  send(B, { t: "stop", ids: [enemyTank0.id] }); // Bob stopping his own tank = legal no-op baseline
  await sleep(800);
  const d8 = deniesSince(A, n0);
  check("8a orders carrying enemy ids denied", d8.length >= 2 && d8.every((d) => /nothing to order/.test(d)), `denies=${JSON.stringify(d8)}`);
  await sleep(1800);
  const e2 = ent(A, enemyTank0.id);
  const drift = e2 ? D(p0.x, p0.y, e2.x, e2.y) : Infinity;
  check("8b enemy unit unaffected by spoofed orders", e2 && drift < 0.25, `drift=${drift.toFixed?.(2)} alive=${!!e2}`);
}

// ============================ [7a] stop on a moving tank ============================
{
  // far destination + poll for real displacement: at gameSpeed 2 the tank covers
  // ~4 tiles in the old fixed 1.3s and could arrive before the stop, making the
  // check vacuous — the stop must land while the tank is verifiably mid-walk
  const p0 = { x: tankB.x, y: tankB.y };
  send(A, { t: "order", ids: [tankB.id], kind: "move", x: tankB.x + 12, y: tankB.y + 16 });
  await waitFor(() => {
    const e = ent(A, tankB.id);
    return e && D(p0.x, p0.y, e.x, e.y) > 1.2;
  }, 6000);
  const cur = ent(A, tankB.id);
  const pStop = cur ? { x: cur.x, y: cur.y } : p0;
  send(A, { t: "stop", ids: [tankB.id] });
  // negative drift check needs a timed window: 2.4s at 20Hz is ~7.7 tiles of
  // would-be travel for an unstopped tank — far beyond the 0.4 gate
  await sleep(2400);
  const e = ent(A, tankB.id);
  const drift = e ? D(pStop.x, pStop.y, e.x, e.y) : Infinity;
  const midwalk = D(p0.x, p0.y, pStop.x, pStop.y);
  // midwalk>1.0 keeps the check honest: without verified motion beforehand a
  // vacuous "stop" of an already-idle tank proves nothing
  check("7a stop halts moving tank", e && drift < 0.4 && midwalk > 1.0, `drift=${drift.toFixed?.(2)} midwalk=${midwalk.toFixed(1)}`);
}

// ============================ battle kickoff (walk ~40-70s, assert later) ============================
const dA0 = dEnt(tankA, enemyInf0);
const dB0 = dEnt(tankB, cyB);
send(A, { t: "order", ids: [tankA.id], kind: "attack", x: enemyInf0.x, y: enemyInf0.y, target: enemyInf0.id });
send(A, { t: "order", ids: [tankB.id], kind: "attack", x: cyB.x, y: cyB.y, target: cyB.id });
note(`battle: tankA(${tankA.id})→enemyInf(${enemyInf0.id}) d0=${dA0.toFixed(1)} | tankB(${tankB.id})→enemyCy(${cyB.id}) d0=${dB0.toFixed(1)}`);

// ============================ [1] move to unreachable tiles ============================
{
  // (a) inside own conyard footprint -> must resolve to nearest reachable & settle
  const p0 = { x: inf1.x, y: inf1.y };
  send(A, { t: "order", ids: [inf1.id], kind: "move", x: Math.floor(cyA.x), y: Math.floor(cyA.y) });
  const w = await moveWatch(A, inf1.id, p0, 11000);
  const endDist = w.end ? D(w.end.x, w.end.y, cyA.x, cyA.y) : Infinity;
  check("1a move onto own conyard footprint → nearest reachable, no freeze",
    !w.dead && w.maxD > 2.0 && w.tailDrift < 0.06 && endDist < 3.6,
    `maxD=${w.maxD.toFixed(2)} endDistToCyCenter=${endDist.toFixed(2)} tailDrift=${w.tailDrift?.toFixed(3)} dead=${!!w.dead}`);

  // (b) off-map orders denied outright
  const dOff1 = await denyProbe(A, () => send(A, { t: "order", ids: [inf1.id], kind: "move", x: -3, y: 50 }));
  const dOff2 = await denyProbe(A, () => send(A, { t: "order", ids: [inf1.id], kind: "move", x: 999, y: 10 }));
  check("1b off-map move orders denied", dOff1 === "off map" && dOff2 === "off map", `denies=${JSON.stringify([dOff1, dOff2])}`);

  // (c) onto another building (enemy conyard tile is also unreachable-ish, but
  // own power plant isn't built — enemy conyard center is the honest case for
  // "on a building"; pathing to its edge is what should happen)
  const p0c = { x: inf1.x, y: inf1.y };
  send(A, { t: "order", ids: [inf1.id], kind: "move", x: cyB.x, y: cyB.y });
  const w2 = await moveWatch(A, inf1.id, p0c, 5000);
  const dToEnemy = w2.end ? D(w2.end.x, w2.end.y, cyB.x, cyB.y) : Infinity;
  check("1c move onto enemy building marches toward it (paths exist)", !w2.dead && (dToEnemy < dEnt(p0c, cyB) - 1 || w2.maxD > 1.5),
    `moved=${w2.maxD.toFixed(2)} distToTarget=${dToEnemy.toFixed(1)}`);
}

// ============================ [2] move spam ============================
{
  const i2 = ent(A, inf2.id);
  const PA = { x: Math.max(1, i2.x - 5), y: i2.y + 4 };
  const PB = { x: i2.x + 5, y: i2.y + 4 };
  for (let i = 0; i < 5; i++) {
    const p = i % 2 ? PB : PA;
    send(A, { t: "order", ids: [inf2.id], kind: "move", x: p.x, y: p.y });
    await sleep(70);
  }
  const last = PA; // i=4 -> PA
  const ok2 = await waitFor(() => {
    const e = ent(A, inf2.id);
    return e && D(e.x, e.y, last.x, last.y) < 2.4;
  }, 12000);
  const e = ent(A, inf2.id);
  check("2 move spam x5 → converges to LAST issued point", ok2, `endDist=${e ? D(e.x, e.y, last.x, last.y).toFixed(2) : "dead"}`);
}

// infantry pair now marches amove deep into enemy territory (engage evidence later).
// destination is DERIVED, not hardcoded: 8 tiles beyond the enemy conyard along
// the cyA→cyB axis, so the march crosses the enemy base on any map/geometry
// (the old fixed (62,62) was midfield-open-ground on a 192 map — the wave never
// passed through anything)
const axisLen = Math.max(1, dEnt(cyA, cyB));
const ux = (cyB.x - cyA.x) / axisLen,
  uy = (cyB.y - cyA.y) / axisLen;
const mw = A.mapW ?? 192,
  mh = A.mapH ?? 192;
const amoveDest = {
  x: Math.round(Math.min(mw - 2, Math.max(1, cyB.x + ux * 8))),
  y: Math.round(Math.min(mh - 2, Math.max(1, cyB.y + uy * 8))),
};
send(A, { t: "order", ids: [inf1.id, inf2.id].filter((id) => ent(A, id)), kind: "amove", x: amoveDest.x, y: amoveDest.y });
note(`amove wave: inf [${inf1.id},${inf2.id}] -> (${amoveDest.x},${amoveDest.y})`);

// ============================ [9] buildings in order ids ============================
{
  // mixed [unit, ownBuilding] -> unit ordered, building skipped silently
  const dest = { x: inf3.x + 4, y: inf3.y + 5 };
  send(A, { t: "order", ids: [inf3.id, cyA.id], kind: "move", x: dest.x, y: dest.y });
  const arrived = await waitFor(() => { const e = ent(A, inf3.id); return e && D(e.x, e.y, dest.x, dest.y) < 3.0; }, 9000);
  check("9a own-building id in mixed order list ignored, unit ordered", arrived && !!ent(A, cyA.id), `inf3 end=${fmt(ent(A, inf3.id))} cyAlive=${!!ent(A, cyA.id)}`);
  // building ids alone -> nothing to order
  const d9 = await denyProbe(A, () => send(A, { t: "order", ids: [cyA.id], kind: "move", x: 20, y: 20 }));
  const d9b = await denyProbe(A, () => send(A, { t: "order", ids: [cyA.id], kind: "amove", x: 20, y: 20 }));
  check("9b building-only order lists denied", /nothing to order/.test(d9 ?? "") && /nothing to order/.test(d9b ?? ""), `denies=${JSON.stringify([d9, d9b])}`);
}

// ============================ [3c/3e] attack own building + bad targets ============================
{
  // while-moving: denied attack must NOT clear the existing move order
  const dest = { x: inf3.x + 3, y: inf3.y + 4 };
  send(A, { t: "order", ids: [inf3.id], kind: "move", x: dest.x, y: dest.y });
  const dOwn = await denyProbe(A, () => send(A, { t: "order", ids: [inf3.id], kind: "attack", x: cyA.x, y: cyA.y, target: cyA.id }));
  check("3c attack own building denied", /nothing to order/.test(dOwn ?? ""), `deny=${dOwn}`);
  const cont = await waitFor(() => { const e = ent(A, inf3.id); return e && D(e.x, e.y, dest.x, dest.y) < 3.0; }, 8000);
  check("3c2 denied attack keeps previous move running", cont, `end=${fmt(ent(A, inf3.id))} dest=${fmt(dest)}`);

  const d99 = await denyProbe(A, () => send(A, { t: "order", ids: [inf3.id], kind: "attack", x: 30, y: 30, target: 99999 }));
  check("3e attack nonexistent target 99999 denied", /nothing to order/.test(d99 ?? ""), `deny=${d99}`);

  // attack with no target field at all
  const dNt = await denyProbe(A, () => send(A, { t: "order", ids: [inf3.id], kind: "attack", x: 30, y: 30 }));
  check("3f attack without target denied", /nothing to order|bad order/.test(dNt ?? ""), `deny=${dNt}`);

  // attack with off-map coords: bounds check fires before target resolution
  const dOffA = await denyProbe(A, () => send(A, { t: "order", ids: [inf3.id], kind: "attack", x: -10, y: -10, target: enemyTank0.id }));
  check("3g attack with off-map coords denied", dOffA === "off map", `deny=${dOffA}`);

  // garbage id shapes
  const dEmpty = await denyProbe(A, () => send(A, { t: "order", ids: [], kind: "move", x: 20, y: 20 }));
  const p0 = { x: inf3.x, y: inf3.y };
  send(A, { t: "order", ids: [null, "foo", inf3.id], kind: "move", x: inf3.x + 2, y: inf3.y + 1 });
  await sleep(1200);
  const movedGarbage = (ent(A, inf3.id) ? D(p0.x, p0.y, ent(A, inf3.id).x, ent(A, inf3.id).y) : 0) > 0.5;
  check("3h empty ids denied; garbage ids filtered to valid unit", /nothing to order/.test(dEmpty ?? "") && movedGarbage,
    `emptyDeny=${dEmpty} moved=${movedGarbage}`);
}

// ============================ [10] interleave: orders during production ============================
let refA = null, refB = null;
{
  // refinery build is ticking — orders must still work
  const p0 = { x: inf3.x, y: inf3.y };
  send(A, { t: "order", ids: [inf3.id], kind: "move", x: inf3.x - 2, y: inf3.y - 3 });
  await sleep(1200);
  const movedDuringBq = (ent(A, inf3.id) ? D(p0.x, p0.y, ent(A, inf3.id).x, ent(A, inf3.id).y) : 0) > 0.5;
  check("10a orders work while building queued", movedDuringBq, `moved=${movedDuringBq}`);

  const okAwaitA = await waitAwaiting(A, "refinery", 30000);
  const okAwaitB = await waitAwaiting(B, "refinery", 30000);
  check("10b both refineries finished construction", okAwaitA && okAwaitB, `A=${okAwaitA} B=${okAwaitB}`);

  // while placement pending: a second build now QUEUES (parallel FIFO), orders still work
  const dBld = await denyProbe(A, () => send(A, { t: "build", kind: "barracks" }));
  const bqHasBarracks = await waitFor(
    () => lastSnap(A)?.players?.[A.slot]?.bq?.some((i) => i.kind === "barracks") ?? false, 6000);
  check("10c second build queues while placement pending", dBld == null && bqHasBarracks, `deny=${dBld} bq=${JSON.stringify(lastSnap(A)?.players?.[A.slot]?.bq)}`);
  // cancel it so the queue drains for the consistency check below
  send(A, { t: "buildCancel", cat: "structure", index: 0 });
  const p1 = { x: inf3.x, y: inf3.y };
  send(A, { t: "order", ids: [inf3.id], kind: "move", x: inf3.x + 2, y: inf3.y - 2 });
  await sleep(1200);
  const movedDuringAwait = (ent(A, inf3.id) ? D(p1.x, p1.y, ent(A, inf3.id).x, ent(A, inf3.id).y) : 0) > 0.5;
  check("10d orders work while placement pending", movedDuringAwait, `moved=${movedDuringAwait}`);

  refA = await placeNear(A, "refinery", cyA.x, cyA.y);
  refB = await placeNear(B, "refinery", cyB.x, cyB.y);
  check("10e both refineries placed", !!refA && !!refB, `A=${fmt(refA)} B=${fmt(refB)}`);

  const sane = (s) => {
    const p = lastSnap(s)?.players?.[s.slot];
    return p && Number.isFinite(p.credits) && p.credits >= 0 && !p.awaiting?.length && !p.bq?.length;
  };
  check("10f player state consistent after build+place cycle", sane(A) && sane(B),
    `A.credits=${lastSnap(A)?.players?.[A.slot]?.credits} B.credits=${lastSnap(B)?.players?.[B.slot]?.credits}`);
}

// barracks -> engineers (production interleaves with everything below)
send(A, { t: "build", kind: "barracks" });
const barOk = await waitAwaiting(A, "barracks", 35000);
const bar = barOk ? await placeNear(A, "barracks", cyA.x, cyA.y) : null;
check("10g barracks built+placed (order traffic concurrent)", !!bar, `awaiting=${barOk} placed=${!!bar}`);
if (bar) {
  send(A, { t: "train", unit: "engineer" });
  send(A, { t: "train", unit: "engineer" });
  // orders while unit queue is running — queue must still drain
  send(A, { t: "order", ids: [inf3.id], kind: "move", x: inf3.x + 1, y: inf3.y + 3 });
  const engSpawned = await waitFor(() => mine(A, "engineer").length >= 2, 45000);
  check("10h unit queue drains while orders flow", engSpawned, `engineers=${mine(A, "engineer").length}`);
} else {
  check("10h unit queue drains while orders flow", null, "no barracks — skipped");
}

// ============================ [5] harvest orders ============================
{
  const harv = await waitFor(() => mine(A, "harvester")[0], 15000) ? mine(A, "harvester")[0] : null;
  check("5p harvester exists (refinery spawn)", !!harv);
  if (harv && oreCells.length) {
    // (a) real ore
    const ore = [...oreCells].sort((p, q) => D(p.x, p.y, harv.x, harv.y) - D(q.x, q.y, harv.x, harv.y))[0];
    send(A, { t: "order", ids: [harv.id], kind: "harvest", x: ore.x, y: ore.y });
    const loaded = await waitFor(() => (ent(A, harv.id)?.cargo ?? 0) > 0, 30000);
    check("5a harvest on real ore loads cargo", loaded, `cargo=${ent(A, harv.id)?.cargo} ore=(${ore.x},${ore.y})`);

    // [7b] stop on loaded harvester: hstate cleared, no auto-resume inside hold window
    send(A, { t: "stop", ids: [harv.id] });
    await sleep(400);
    const hp0 = { x: ent(A, harv.id).x, y: ent(A, harv.id).y };
    const cg0 = ent(A, harv.id).cargo;
    const wH = await moveWatch(A, harv.id, hp0, 5000);
    check("7b loaded harvester stays stopped (no auto-resume in hold window)", !wH.dead && wH.maxD < 0.5, `drift5s=${wH.maxD.toFixed(2)} cargo=${cg0}`);

    // (b) empty ground — denied, stays put (still inside a fresh hold window)
    send(A, { t: "stop", ids: [harv.id] });
    await sleep(300);
    const he = { x: ent(A, harv.id).x, y: ent(A, harv.id).y };
    const dE = await denyProbe(A, () => send(A, { t: "order", ids: [harv.id], kind: "harvest", x: 2, y: 30 }));
    await sleep(1800);
    const he2 = ent(A, harv.id);
    check("5b harvest on empty ground denied + stays", /nothing to order/.test(dE ?? "") && he2 && D(he.x, he.y, he2.x, he2.y) < 0.4,
      `deny=${dE} drift=${he2 ? D(he.x, he.y, he2.x, he2.y).toFixed(2) : "dead"}`);

    // (c) enemy refinery tiles — denied
    if (refB) {
      send(A, { t: "stop", ids: [harv.id] });
      await sleep(300);
      const dER = await denyProbe(A, () => send(A, { t: "order", ids: [harv.id], kind: "harvest", x: Math.floor(refB.x), y: Math.floor(refB.y) }));
      const hes = { x: ent(A, harv.id).x, y: ent(A, harv.id).y };
      await sleep(1500);
      const hes2 = ent(A, harv.id);
      check("5c harvest on enemy refinery tile denied", /nothing to order/.test(dER ?? "") && hes2 && D(hes.x, hes.y, hes2.x, hes2.y) < 0.4,
        `deny=${dER} drift=${hes2 ? D(hes.x, hes.y, hes2.x, hes2.y).toFixed(2) : "dead"}`);
    } else check("5c harvest on enemy refinery tile denied", null, "enemy refinery was never placed");

    // (d) mixed selection: harvester + escort onto ore — escort must MOVE (new fix)
    const esc = ent(A, inf3.id);
    const e0 = { x: esc.x, y: esc.y };
    const ore2 = [...oreCells].sort((p, q) => D(p.x, p.y, harv.x, harv.y) - D(q.x, q.y, harv.x, harv.y))[0];
    send(A, { t: "order", ids: [harv.id, inf3.id], kind: "harvest", x: ore2.x, y: ore2.y });
    await sleep(3500);
    const esc2 = ent(A, inf3.id);
    const escMoved = esc2 ? D(e0.x, e0.y, esc2.x, esc2.y) : 0;
    const harvMoved = ent(A, harv.id) ? D(he.x, he.y, ent(A, harv.id).x, ent(A, harv.id).y) : 0;
    check("5d mixed harvest group: escort unit moves with harvester", escMoved > 1.0,
      `escMoved=${escMoved.toFixed(2)} harvMoved=${harvMoved.toFixed(2)}`);

    // unarmed harvester can't take combat orders
    const dHv = await denyProbe(A, () => send(A, { t: "order", ids: [harv.id], kind: "amove", x: 30, y: 30 }));
    const dHa = await denyProbe(A, () => send(A, { t: "order", ids: [harv.id], kind: "attack", x: enemyTank0.x, y: enemyTank0.y, target: enemyTank0.id }));
    check("5e unarmed harvester attack/amove denied", /nothing to order/.test(dHv ?? "") && /nothing to order/.test(dHa ?? ""), `denies=${JSON.stringify([dHv, dHa])}`);

    // (e) harvest onto OWN refinery = "go unload" — credits must bump
    await waitFor(() => (ent(A, harv.id)?.cargo ?? 0) >= 4, 30000);
    const cred0 = lastSnap(A).players[A.slot].credits;
    send(A, { t: "order", ids: [harv.id], kind: "harvest", x: Math.floor(refA.x), y: Math.floor(refA.y) });
    const paid = await waitFor(() => lastSnap(A).players[A.slot].credits > cred0, 40000);
    check("5f harvest on own refinery docks + deposits cargo", paid,
      `credits ${cred0}→${lastSnap(A).players[A.slot].credits} cargo=${ent(A, harv.id)?.cargo}`);
  } else {
    check("5 harvest suite", null, "no harvester or no ore — skipped");
  }
}

// ============================ [6] engineer orders ============================
let engIds = [];
let capTargetEnt = null;
{
  const engs = mine(A, "engineer");
  engIds = engs.map((e) => e.id);
  if (engs.length) {
    const eng = engs[0];
    // move
    const p0 = { x: eng.x, y: eng.y };
    send(A, { t: "order", ids: [eng.id], kind: "move", x: eng.x + 3, y: eng.y + 3 });
    await sleep(1500);
    const e1 = ent(A, eng.id);
    check("6a engineer obeys move", e1 && D(p0.x, p0.y, e1.x, e1.y) > 0.8, `moved=${e1 ? D(p0.x, p0.y, e1.x, e1.y).toFixed(2) : "dead"}`);

    // [7c] stop mid-walk
    send(A, { t: "order", ids: [eng.id], kind: "move", x: eng.x + 5, y: eng.y });
    await sleep(1000);
    const sp = { x: ent(A, eng.id).x, y: ent(A, eng.id).y };
    send(A, { t: "stop", ids: [eng.id] });
    await sleep(1800);
    const e2 = ent(A, eng.id);
    const drift = e2 ? D(sp.x, sp.y, e2.x, e2.y) : Infinity;
    check("7c stop halts engineer mid-walk", e2 && drift < 0.4, `drift=${drift.toFixed?.(2)}`);

    // amove (engineer exempt from unarmed-skip)
    const pA = { x: eng.x, y: eng.y };
    send(A, { t: "order", ids: [eng.id], kind: "amove", x: eng.x + 4, y: eng.y - 2 });
    await sleep(1800);
    const e3 = ent(A, eng.id);
    check("6b engineer accepts amove", e3 && D(pA.x, pA.y, e3.x, e3.y) > 0.8, `moved=${e3 ? D(pA.x, pA.y, e3.x, e3.y).toFixed(2) : "dead"}`);

    // attack own building -> denied no-op
    const dEng = await denyProbe(A, () => send(A, { t: "order", ids: [eng.id], kind: "attack", x: cyA.x, y: cyA.y, target: cyA.id }));
    check("6c engineer attack own building denied", /nothing to order/.test(dEng ?? ""), `deny=${dEng}`);

    // capture march — assert it paths toward the target; capture may follow.
    // The window scales with the measured walk (engineers are the slowest unit).
    // Target must be a LIVE capturable building — the enemy conyard is NOT one:
    // tankB has been ordered onto it since the battle kickoff and it is rubble
    // long before the barracks trains a single engineer (observed: cyB destroyed
    // ~49s in vs this order ~64s in — an attack order on the dead id then comes
    // back "nothing to order" and the engineers never march at all). Neutral
    // derricks/coalmines are never auto-attacked (nearestEnemy skips owner -1)
    // and nothing in this test targets them, so the nearest one to the enemy
    // base is the honest live capture target: same tryCapture edge-dist
    // walk-in path, same geometry as the original conyard march.
    capTargetEnt = (lastSnap(A)?.ents ?? [])
      .filter((x) => x.o === -1 && (x.k === "derrick" || x.k === "coalmine"))
      .sort((p, q) => dEnt(p, cyB) - dEnt(q, cyB))[0] ?? null;
    if (!capTargetEnt) {
      check("6d engineer capture-march paths toward live target", null, "no neutral capturable building on map — skipped");
    } else {
      const engLive = engIds.map((id) => ent(A, id)).filter(Boolean);
      const dCap0 = Math.min(...engLive.map((e) => dEnt(e, capTargetEnt)));
      const n6d = A.msgs.length;
      send(A, { t: "order", ids: engIds.filter((id) => ent(A, id)), kind: "attack", x: capTargetEnt.x, y: capTargetEnt.y, target: capTargetEnt.id });
      const approached = await waitFor(() => {
        const alive = engIds.map((id) => ent(A, id)).filter(Boolean);
        return !alive.length || Math.min(...alive.map((e) => dEnt(e, capTargetEnt))) < dCap0 - 15;
      }, walkMs(Math.max(10, dCap0 - 15), SPEED2.inf));
      const closest = Math.min(...engIds.map((id) => dEnt(ent(A, id), capTargetEnt)));
      const cap = A.events.some((e) => e.e === "cap" && e.slot === A.slot);
      const deadAll = engIds.every((id) => !ent(A, id));
      const denied = deniesSince(A, n6d);
      check("6d engineer capture-march paths toward live target", (approached || cap) && denied.length === 0,
        `d0=${dCap0.toFixed(1)} closest=${closest.toFixed(1)} capEvent=${cap} allDead=${deadAll} tgt=${capTargetEnt.k}#${capTargetEnt.id} denies=${JSON.stringify(denied)}`);
      if (cap) note(`engineer captured the neutral ${capTargetEnt.k}`);
      else if (deadAll) note("engineer(s) died approaching (enemy idle units defend)");
    }
  } else {
    check("6 engineer suite", null, "no engineers spawned — skipped");
  }
}

// ============================ [3a/3b] attack verdicts ============================
{
  // windows scale with the measured kickoff distances: a tank must close
  // d0-(range+2) tiles at 3.2 tiles/sec nominal (20Hz, gameSpeed 2). The old
  // fixed 70/90s were written for ~117-tile diagonal spawns on 96/128 maps —
  // hopeless for 253 tiles on 192x192 corner spawns. waitFors are event-driven
  // and return the moment evidence exists; the scale only bounds the failure case
  const tA = ent(A, tankA.id), tgtInf = ent(A, enemyInf0.id);
  const winA = walkMs(Math.max(10, dA0 - 7), SPEED2.tank);
  const approachedA = await waitFor(() => !ent(A, enemyInf0.id) || !ent(A, tankA.id) || dEnt(ent(A, tankA.id), ent(A, enemyInf0.id)) < dA0 - 15, Math.min(winA, 60000));
  check("3a attack enemy unit → homes in", approachedA, `d0=${dA0.toFixed(1)} dNow=${dEnt(ent(A, tankA.id), ent(A, enemyInf0.id)).toFixed(1)}`);
  const engagedA = await waitFor(() => !ent(A, enemyInf0.id) || ent(A, enemyInf0.id).hp < enemyInf0.mhp || !ent(A, tankA.id) || ent(A, tankA.id).hp < tankA.mhp, winA);
  check("3a2 attack enemy unit → combat evidence", engagedA,
    `tgt=${tgtInf ? `hp ${tgtInf.hp}/${tgtInf.mhp}` : "KILLED"} atk=${ent(A, tankA.id) ? `hp ${ent(A, tankA.id).hp}` : "dead"} win=${(winA / 1000).toFixed(0)}s`);

  const winB = walkMs(Math.max(10, dB0 - 7), SPEED2.tank);
  // a DESTROYED target building is approach evidence too — same mirror as 3a/3b2:
  // cyB is typically rubble long before this verdict runs (tankB is fast, the
  // verdict waits for the whole engineer/harvest act), ent()?.hp < mhp is false
  // for a destroyed building and the distance to it is Infinity, so without the
  // !ent(cyB) term this check was a coin-flip on whether tankB happened to die
  const approachedB = await waitFor(() => !ent(A, tankB.id) || !ent(A, cyB.id) || ent(A, cyB.id)?.hp < cyB.mhp || dEnt(ent(A, tankB.id), ent(A, cyB.id)) < dB0 - 15, Math.min(winB, 60000));
  check("3b attack enemy building → homes in", approachedB, `dNow=${dEnt(ent(A, tankB.id), ent(A, cyB.id)).toFixed(1)}`);
  // a dead target building IS combat evidence (mirrors the unit check above):
  // ent()?.hp < mhp evaluates false for a destroyed building, which used to be
  // a latent false-negative once attackers could actually finish the walk
  const engagedB = await waitFor(() => !ent(A, cyB.id) || !ent(A, tankB.id) || ent(A, cyB.id)?.hp < cyB.mhp || ent(A, tankB.id).hp < tankB.mhp, winB);
  check("3b2 attack enemy building → combat evidence", engagedB,
    `cyHp=${ent(A, cyB.id)?.hp ?? "DESTROYED"}/${cyB.mhp} atkAlive=${!!ent(A, tankB.id)} win=${(winB / 1000).toFixed(0)}s`);
}

// ============================ [3d] attack a dead ent ============================
{
  const sawDead = await waitFor(() => A.deadIds.size > 0, 150000, 500);
  if (sawDead) {
    const did = [...A.deadIds][0];
    const dDead = await denyProbe(A, () => send(A, { t: "order", ids: [inf3.id], kind: "attack", x: 30, y: 30, target: did }));
    check("3d attack dead ent id denied", /nothing to order/.test(dDead ?? ""), `deadId=${did} deny=${dDead} deadIds=${A.deadIds.size}`);
  } else check("3d attack dead ent id denied", null, "no ent died during the window");
}

// ============================ [4] amove engage + resume ============================
{
  // send surviving tanks along too — they're already in enemy territory
  const survivors = [tankA.id, tankB.id, inf1.id, inf2.id].filter((id) => ent(A, id));
  send(A, { t: "order", ids: survivors, kind: "amove", x: amoveDest.x, y: amoveDest.y });
  const kills0 = A.deadIds.size;

  const engaged = await waitFor(() => A.deadIds.size > kills0 || theirs(A, B.slot).length < enemyCount0, walkMs(spawnDist, SPEED2.inf), 500);
  check("4a amove through enemy territory engages", engaged, `enemyEnts ${enemyCount0}→${theirs(A, B.slot).length} deadIds=${A.deadIds.size}`);

  // resume: after engagement, some amover must make progress to dest (or arrive)
  const destD0 = Math.min(...survivors.map((id) => dEnt(ent(A, id), amoveDest)));
  let resumed = false, stillFighting = false;
  const t0 = Date.now();
  const resumeMs = walkMs(Math.max(20, isFinite(destD0) ? destD0 : spawnDist), SPEED2.inf);
  while (Date.now() - t0 < resumeMs) {
    const alive = survivors.map((id) => ent(A, id)).filter(Boolean);
    if (!alive.length) break;
    const nearest = Math.min(...alive.map((e) => dEnt(e, amoveDest)));
    const enemies = theirs(A, B.slot).filter((en) => alive.some((e) => dEnt(e, en) < 8));
    if (nearest < 8) { resumed = true; break; }
    if (!enemies.length && nearest < destD0 - 4) { resumed = true; break; }
    if (!enemies.length && nearest >= destD0 - 1) { /* disengaged but not progressing */ }
    if (enemies.length) stillFighting = true;
    await sleep(1000);
  }
  const aliveNow = survivors.filter((id) => ent(A, id));
  const nearestNow = Math.min(...aliveNow.map((id) => dEnt(ent(A, id), amoveDest)));
  if (!aliveNow.length) check("4b amover resumes toward destination after kills", null, "no amovers survived — engagement verified, resume untestable");
  else if (stillFighting && !resumed) check("4b amover resumes toward destination after kills", null, `still engaged at end (nearest=${nearestNow.toFixed(1)} to dest)`);
  else check("4b amover resumes toward destination after kills", resumed, `nearest=${nearestNow.toFixed(1)} dest=(${amoveDest.x},${amoveDest.y}) alive=${aliveNow.length}`);
}

// ============================ capture verdict (late, informational) ============================
{
  const cap = A.events.some((e) => e.e === "cap" && e.slot === A.slot);
  const engAlive = engIds.some((id) => ent(A, id));
  note(`capture outcome: cap=${cap} engAlive=${engAlive} tgt.owner=${capTargetEnt ? ent(A, capTargetEnt.id)?.o : "n/a"} tgt.hp=${capTargetEnt ? ent(A, capTargetEnt.id)?.hp : "n/a"}`);
}

// ============================ [11] rapid alternating orders ============================
{
  const victim = ent(A, inf3.id) ?? mine(A)[0];
  if (victim) {
    const tick0 = lastSnap(A).tick;
    for (let i = 0; i < 20; i++) {
      if (i % 2) send(A, { t: "order", ids: [victim.id], kind: "attack", x: cyB.x, y: cyB.y, target: cyB.id });
      else send(A, { t: "order", ids: [victim.id], kind: "move", x: 10 + (i % 4), y: 30 + (i % 3) });
      await sleep(55);
    }
    const advanced = await waitTicks(A, 15, 6000);
    const aliveAfter = mine(A).length;
    check("11a sim keeps ticking through 20x rapid order spam", advanced, `tick ${tick0}→${lastSnap(A).tick}`);
    check("11b ents alive after spam", aliveAfter > 0, `myEnts=${aliveAfter} tick=${lastSnap(A).tick}`);
  } else check("11 rapid spam", null, "no unit left to spam");
}

// ============================ report ============================
console.log("\n=== ORDER FUZZ RESULTS ===");
for (const r of results) console.log(`${r.ok === null ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.ev}`);
if (notes.length) { console.log("\nobservations:"); for (const n of notes) console.log(`  - ${n}`); }
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
