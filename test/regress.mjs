// Regression test for fuzz findings: NaN credits, socket kills, token dedup.
// Also covers the v2 keyframe+delta wire protocol: delta stream follows keyframes,
// reassembled state matches the legacy full-snapshot stream, mid-game join syncs instantly.
import { wsconn, send, lastSnap, sleep } from "./wsconn.mjs";
const ROOM = "reg" + Date.now().toString(36);
const URL = `ws://localhost:8787/parties/game-room/${ROOM}`;
let pass = 0,
  fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log("ok:", label);
  } else {
    fail++;
    console.log("FAIL:", label);
  }
};

// recursive key-sorted JSON — reassembled objects legitimately differ in key
// insertion order from freshly-encoded ones, so compare semantically
const canon = (v) => {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
};

function conn(name, token, opts = {}) {
  return wsconn(URL, name, token, {
    ...opts,
    onmsg: (m, st) => {
      if (m.t === "lobby") st.lobby = m;
      opts.onmsg?.(m, st);
    },
    onclose: (e) => console.log(`[${name}] closed ${e.code} ${e.reason}`),
    onerror: () => console.log(`[${name}] error`),
  });
}
const credits = (st) => lastSnap(st)?.players?.[st.slot]?.credits;
const denies = (st) => st.msgs.filter((m) => m.t === "deny").map((m) => m.msg);

// ---- game with 2 players ----
const a = conn("Alice", "tok-A");
const b = conn("Bob", "tok-B");
await sleep(800);
ok(a.lobby?.players.length === 2, "lobby has 2 players");
send(a, { t: "start" });
await sleep(300);
ok(denies(a).some((d) => /not ready/i.test(d)), "start denied while guest unready");
send(b, { t: "ready", ready: true });
await sleep(200);
send(a, { t: "start" });
await sleep(800);
ok(lastSnap(a)?.ents?.length > 0, "game started, entities present");
const creditsBefore = credits(a);
ok(Number.isFinite(creditsBefore), `credits finite (${creditsBefore})`);

// ---- HIGH: proto-key build must not corrupt credits ----
for (const kind of ["toString", "constructor", "__proto__", "hasOwnProperty", "bogus", 5, null, ["x"], { y: 1 }]) {
  send(a, { t: "build", kind });
  await sleep(80);
}
await sleep(400);
const creditsAfter = credits(a);
ok(Number.isFinite(creditsAfter) && creditsAfter === creditsBefore, `credits unchanged (${creditsAfter})`);
ok(denies(a).includes("unknown building"), "proto-key build denied 'unknown building'");
ok(!a.closed, "player A socket still alive after build fuzz");

// ---- proto-key train ----
send(a, { t: "train", unit: "hasOwnProperty" });
send(a, { t: "train", unit: "bogus" });
send(a, { t: "trainCancel", unit: "bogus" });
await sleep(300);
ok(denies(a).includes("unknown unit"), "unknown unit denied");
ok(!a.closed, "socket alive after train fuzz");

// ---- socket-killing inputs: null msg, bad ids, bad order ----
const c = conn("Carl", "tok-C");
await sleep(300);
c.ws.send("null");
send(c, { t: "order", ids: 5, kind: "move", x: 5, y: 5 });
send(c, { t: "order", ids: {}, kind: "move", x: 5, y: 5 });
send(c, { t: "order", ids: [1], kind: "nuke", x: 5, y: 5 });
send(c, { t: "order", ids: [1], kind: "move", x: NaN, y: 5 });
send(c, { t: "order", ids: [1], kind: "move", x: "10", y: 5 });
await sleep(500);
ok(!c.closed, "Carl socket alive after kill-attempts (null msg, bad ids, nuke, NaN, string-x)");
ok(c.slot === -1, `Carl is spectator (slot ${c.slot}) — join mid-game`);

// player A (in-game) sends the kill-attempts on its own conn
send(a, { t: "order", ids: 5, kind: "move", x: 5, y: 5 });
send(a, { t: "order", ids: [999999], kind: "move", x: 5, y: 5 });
send(a, { t: "order", ids: [1], kind: "nuke", x: 5, y: 5 });
send(a, { t: "place", tx: "abc", ty: 0 });
send(a, { t: "place", tx: null, ty: undefined });
send(a, { t: "train", unit: 5 });
send(a, { t: "bogus-type" });
await sleep(400);
ok(!a.closed, "player A socket alive after all fuzz");
ok(denies(a).includes("bad order"), "nuke order denied 'bad order'");
ok(denies(a).includes("bad coords"), "non-finite place denied 'bad coords'");
ok(denies(a).includes("bad unit"), "numeric unit denied 'bad unit'");

// ---- token dedup: same token on a 2nd conn kicks the 1st, doesn't break player ----
const a2 = conn("Alice2", "tok-A");
await sleep(700);
ok(a.closed, "old Alice conn closed when same-token conn joined");
ok(!a2.closed, "replacement conn alive");
ok(a2.slot === 0, `replacement got slot ${a2.slot}`);
// old conn close must NOT have marked player disconnected — A2 should still order units
const tank = lastSnap(a2).ents.find((e) => e.o === 0 && e.k === "tank");
const before = { x: tank.x, y: tank.y };
send(a2, { t: "order", ids: [tank.id], kind: "move", x: before.x + 5, y: before.y });
await sleep(2500);
const tank2 = lastSnap(a2).ents.find((e) => e.id === tank.id);
const moved = Math.hypot(tank2.x - before.x, tank2.y - before.y);
ok(moved > 1, `rejoined player controls units (moved ${moved.toFixed(2)})`);
ok(lastSnap(a2).players?.[0], "player state still tracked after conn swap");

// ---- lobby player list should show Alice2 connected ----
ok(a2.lobby?.players.find((p) => p.slot === 0)?.connected !== false, "slot 0 still connected in lobby");

// ---- server still healthy ----
const health = await fetch(`http://localhost:8787/parties/game-room/${ROOM}`).then((r) => r.json());
ok(health.phase === "playing", `room still playing (phase=${health.phase}, tick=${health.tick})`);

// ---- v2 wire protocol: keyframe+delta stream ----
ok(a2.proto.key >= 1, `v2 client saw keyframe(s) (${a2.proto.key})`);
ok(a2.proto.delta > 5, `v2 client saw delta frames (${a2.proto.delta})`);
ok(a2.proto.droppedDelta === 0, `no dropped deltas on a clean stream (${a2.proto.droppedDelta})`);
const avgKey = a2.proto.keyBytes / Math.max(1, a2.proto.key);
const avgDelta = a2.proto.deltaBytes / Math.max(1, a2.proto.delta);
ok(avgDelta < avgKey * 0.6, `delta frames much smaller than keyframes (avg ${avgDelta.toFixed(0)}B vs ${avgKey.toFixed(0)}B)`);

// mid-game joiner (Carl, spectator) must get an individual keyframe right after init —
// the first snap frame following his init in socket order carries key:true
{
  const initIdx = c.msgs.findIndex((m) => m.t === "init");
  const firstSnap = c.msgs.slice(initIdx + 1).find((m) => m.t === "snap" || m.t === "snapd");
  ok(firstSnap?.key === true, `mid-game joiner syncs instantly via join keyframe (key=${firstSnap?.key})`);
}

// ---- cross-validation: legacy v1 client vs reassembled v2 state ----
// Len joins WITHOUT v:2 — the server must keep him on legacy full snapshots
// every frame, and the v2 reassembly must reproduce identical state.
const len = wsconn(URL, "Len", "tok-len", { v: 1 });
len.ws.onclose = () => {};
await sleep(1200);
ok(len.proto.delta === 0, `legacy client receives zero delta frames (${len.proto.delta})`);
ok(len.proto.fullLegacy > 0, `legacy client receives full snapshots every frame (${len.proto.fullLegacy})`);
ok(!len.msgs.some((m) => m.t === "snapd"), "legacy client never sees a snapd message");
{
  // find a tick present in both streams and compare full game state semantically
  const lenByTick = new Map(len.snaps.map((s) => [s.tick, s]));
  const a2ByTick = new Map(a2.snaps.map((s) => [s.tick, s]));
  const common = [...lenByTick.keys()].filter((t) => a2ByTick.has(t)).sort((x, y) => x - y);
  const tick = common[common.length - 1];
  ok(tick !== undefined, `v1/v2 streams share a tick (${tick})`);
  if (tick !== undefined) {
    const norm = (s) => ({
      ents: [...s.ents].sort((x, y) => x.id - y.id),
      crates: s.crates ?? [],
      bridges: s.bridges ?? [],
      players: s.players,
    });
    const lj = canon(norm(lenByTick.get(tick)));
    const aj = canon(norm(a2ByTick.get(tick)));
    ok(lj === aj, `delta-reassembled state matches legacy full state at tick ${tick} (${lj.length}B canon)`);
    // explicit keyframe->delta chain: the v2 stream must have applied at least one
    // delta AFTER its most recent keyframe for this comparison to mean anything
    const lastKeyIdx = a2.msgs.map((m, i) => (m.key ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
    const deltaAfterKey = a2.msgs.slice(lastKeyIdx + 1).some((m) => m.t === "snapd");
    ok(deltaAfterKey, "observed a delta following a keyframe in the v2 stream");
  }
}
len.ws.close();

a2.ws.close();
b.ws.close();
c.ws.close();

// ---- snapdelta codec unit checks (same module the client/worker share) ----
// hooks were registered by wsconn.mjs, so the TS module imports directly
const { SnapReassembler, diffSnaps, applyEntDelta } = await import("../src/shared/snapdelta.ts");
{
  // field deletion: fuel/ammo/waypoints vanish — null must delete, not overwrite
  const cur = { id: 1, o: 0, k: "tank", x: 5, y: 5, hp: 100, mhp: 100, d: 0, fl: 62, wp: [[9, 9, "move"]] };
  const merged = applyEntDelta(cur, { id: 1, x: 6, fl: null, wp: null });
  ok(merged.x === 6 && merged.y === 5, "applyEntDelta merges changed scalars");
  ok(!("fl" in merged) && !("wp" in merged), "null deletes vanished optional fields");
  ok(cur.fl === 62 && cur.x === 5, "applyEntDelta never mutates the retained baseline object");
}
{
  // full diff->apply chain: two synthetic frames, reassembly must equal the source
  const f1 = {
    ents: [
      { id: 1, o: 0, k: "tank", x: 5, y: 5, hp: 100, mhp: 100, d: 0 },
      { id: 2, o: 0, k: "harvester", x: 8, y: 8, hp: 80, mhp: 80, d: 0, cargo: 10, wp: [[3, 3, "harvest"]] },
    ],
    crates: [],
    bridges: [],
    players: { 0: { slot: 0, credits: 100, pwrHave: 1, pwrUse: 0, lowPower: false, eliminated: false, awaiting: [], bq: [], queues: {} } },
  };
  const f2 = {
    ents: [
      { id: 1, o: 0, k: "tank", x: 6, y: 5, hp: 97, mhp: 100, d: 15 }, // moved + damaged + turned
      // id 2 gone
      { id: 3, o: 1, k: "infantry", x: 20, y: 20, hp: 50, mhp: 50, d: 0 }, // spawned
    ],
    crates: [{ id: 9, x: 4, y: 4, kind: "money" }],
    bridges: [11, 12],
    players: { 0: { slot: 0, credits: 250, pwrHave: 1, pwrUse: 0, lowPower: false, eliminated: false, awaiting: [], bq: [], queues: {} } },
  };
  const d = diffSnaps(f1, f2);
  ok(d.ents.length === 2 && d.gone?.length === 1 && d.gone[0] === 2, `diff isolates changed+gone ents (${JSON.stringify(d)})`);
  const tankDelta = d.ents.find((e) => e.id === 1);
  ok(tankDelta && !("o" in tankDelta) && !("k" in tankDelta) && !("mhp" in tankDelta), "unchanged ent fields omitted from delta");
  ok(tankDelta.x === 6 && tankDelta.hp === 97 && tankDelta.d === 15, "changed ent fields present in delta");
  const spawnDelta = d.ents.find((e) => e.id === 3);
  ok(spawnDelta?.k === "infantry" && spawnDelta?.mhp === 50, "new ents ride the delta as complete objects");
  ok(d.players?.[0]?.credits === 250, "changed player slot included");
  ok(d.crates?.length === 1 && d.bridges?.length === 2, "crates/bridges replacement included on change");

  const rx = new SnapReassembler();
  rx.keyframe({ t: "snap", seq: 1, tick: 2, ...f1, events: [] });
  const out = rx.delta({ t: "snapd", seq: 2, tick: 4, ...d, events: [] });
  ok(out !== null, "delta applies after keyframe");
  const t1 = out.ents.find((e) => e.id === 1);
  ok(t1.x === 6 && t1.hp === 97 && t1.d === 15 && t1.k === "tank" && t1.mhp === 100, "reassembled ent carries merged state");
  ok(!out.ents.some((e) => e.id === 2), "gone ent removed from reassembly");
  ok(out.ents.find((e) => e.id === 3)?.k === "infantry", "spawned ent appears in reassembly");
  ok(out.players[0].credits === 250 && out.crates.length === 1 && out.bridges.length === 2, "players/crates/bridges reassembled");
  // seq gap must drop, then a keyframe resyncs
  const dropped = rx.delta({ t: "snapd", seq: 9, tick: 18, ents: [], events: [] });
  ok(dropped === null, "seq gap drops the delta (resync pending)");
  const key = rx.keyframe({ t: "snap", seq: 10, key: true, tick: 20, ...f2, events: [] });
  ok(key.ents.length === 2 && rx.delta({ t: "snapd", seq: 11, tick: 22, ents: [{ id: 1, x: 7 }], events: [] })?.ents.find((e) => e.id === 1)?.x === 7, "keyframe resyncs after a gap");
}
{
  // identical frames produce an empty diff (no ent traffic at all)
  const same = { ents: [{ id: 1, o: 0, k: "tank", x: 5, y: 5, hp: 100, mhp: 100, d: 0, wp: [[9, 9, "move"]] }], crates: [], bridges: [], players: { 0: { slot: 0, credits: 1, pwrHave: 0, pwrUse: 0, lowPower: false, eliminated: false, awaiting: [], bq: [], queues: {} } } };
  const clone = JSON.parse(JSON.stringify(same)); // fresh objects, same content (snapshot() reallocates like this)
  const d = diffSnaps(same, clone);
  ok(d.ents.length === 0 && !d.gone && !d.players && !d.crates && !d.bridges, `identical frame diffs to nothing (${JSON.stringify(d)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
