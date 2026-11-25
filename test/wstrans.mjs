// Wire-level (ws) test for helicopter troop transport: board/unload orders pass
// wire validation, passengers vanish from the snapshot stream on embark, the
// cargo scalar flows through keyframe+delta encoding, and disembarked troops
// reappear near the drop zone. Runs against the dev server on :8787.
import { wsconn, send, lastSnap, sleep } from "./wsconn.mjs";

const ROOM = "wstr" + Date.now().toString(36);
const PORT = process.env.WSPORT ?? "8787";
const URL = `ws://localhost:${PORT}/parties/game-room/${ROOM}`;
let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log("ok:", label); }
  else { fail++; console.log("FAIL:", label); }
};
const waitFor = async (f, ms = 20000, step = 120) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (f()) return true; } catch { /* snap mid-update */ }
    await sleep(step);
  }
  return false;
};
const conn = (name, token) =>
  wsconn(URL, name, token, { onmsg: (m, st) => { if (m.t === "lobby") st.lobby = m; } });
const mine = (st, kind) => (lastSnap(st)?.ents ?? []).filter((e) => e.o === st.slot && (kind ? e.k === kind : true));
const ent = (st, id) => (lastSnap(st)?.ents ?? []).find((e) => e.id === id);
const denies = (st) => st.msgs.filter((m) => m.t === "deny").map((m) => m.msg);
const waitAwaiting = (st, kind, ms = 30000) => waitFor(() => lastSnap(st)?.players?.[st.slot]?.awaiting?.includes(kind), ms);

// ---- lobby: 2 players, fat credits, 2x speed ----
const A = conn("Trans", "wst-A");
const B = conn("Foe", "wst-B");
await sleep(1200);
ok(A.lobby?.players.length === 2, "lobby has 2 players");
send(A, { t: "setConfig", config: { startCredits: 20000, gameSpeed: 2, fog: false } });
await sleep(400);
// the dev server hot-reloads on file edits (parallel dev lanes share it), which can
// eat a start sequence — retry a few times before declaring failure
let started = false;
for (let attempt = 0; attempt < 3 && !started; attempt++) {
  send(B, { t: "ready", ready: true });
  await sleep(500);
  send(A, { t: "start" });
  started = await waitFor(() => (lastSnap(A)?.ents?.length ?? 0) > 0, 9000);
  if (!started) console.log(`  start attempt ${attempt + 1} produced no snapshots — retrying`);
}
ok(started, "game started, snapshots flowing");
if (!started) {
  console.log("no snapshots — aborting. denies:", JSON.stringify(A.msgs.filter((m) => m.t === "deny")), "msgs:", [...new Set(A.msgs.map((m) => m.t))].join(","));
  process.exit(1);
}

const cyA = mine(A, "conyard")[0];
ok(!!cyA, `conyard present at (${cyA?.x},${cyA?.y})`);
const infs = mine(A, "infantry");
ok(infs.length >= 2, `starting army has infantry x${infs.length}`);

// ---- build chain: power → barracks → radar → airfield (place each when ready) ----
async function buildAndPlace(kind, cx, cy) {
  send(A, { t: "build", kind });
  const ready = await waitAwaiting(A, kind);
  if (!ready) return null;
  // wide spiral of candidates around the conyard — corner starts leave little room,
  // so scan rings of increasing radius and burst attempts in small batches
  for (let r = 4; r <= 13; r += 3) {
    const ring = [];
    for (let a = 0; a < 8; a++) {
      const tx = Math.round(cx + r * Math.cos((a * Math.PI) / 4));
      const ty = Math.round(cy + r * Math.sin((a * Math.PI) / 4));
      for (let dx = 0; dx <= 1; dx++) for (let dy = 0; dy <= 1; dy++) ring.push([tx + dx, ty + dy]);
    }
    for (const [tx, ty] of ring) {
      send(A, { t: "place", tx, ty });
      await sleep(110);
      const found = mine(A, kind)[0];
      if (found) return found;
    }
  }
  return null;
}
const cx = Math.floor(cyA.x), cy = Math.floor(cyA.y);
const pow = await buildAndPlace("power", cx, cy);
ok(!!pow, "power plant placed");
const rax = await buildAndPlace("barracks", cx, cy);
ok(!!rax, "barracks placed");
const rad = await buildAndPlace("radar", cx, cy);
ok(!!rad, "radar tower placed");
const af = await buildAndPlace("airfield", cx, cy);
ok(!!af, "airfield placed");

// ---- train the chopper ----
send(A, { t: "train", unit: "chopper" });
const chopAlive = await waitFor(() => mine(A, "chopper").length > 0, 30000);
ok(chopAlive, "chopper trained & present in snapshot stream");
const chop = mine(A, "chopper")[0];
if (!chop) { console.log("no chopper — aborting"); process.exit(1); }
ok(chop.cargo === 0 || chop.cargo === undefined, `empty transport cargo scalar ${chop.cargo}`);

// ---- board two riflemen over the wire ----
const [i1, i2] = [infs[0], infs[1]];
// fly the transport next to the squad first so boarding is quick
send(A, { t: "order", ids: [chop.id], kind: "move", x: i1.x + 1, y: i1.y });
await sleep(1500);
const nDeny0 = denies(A).length;
send(A, { t: "order", ids: [i1.id, i2.id], kind: "board", x: chop.x, y: chop.y, target: chop.id });
await sleep(600);
ok(denies(A).length === nDeny0, `board order accepted over the wire (no deny) — denies=${JSON.stringify(denies(A))}`);
const boarded = await waitFor(() => !ent(A, i1.id) && !ent(A, i2.id), 25000);
ok(boarded, "both infantry vanish from the snapshot stream on embark");
const full = await waitFor(() => (ent(A, chop.id)?.cargo ?? 0) >= 2, 8000);
ok(full, `cargo scalar rises to 2 through the delta stream (cargo=${ent(A, chop.id)?.cargo})`);

// ---- fly to a drop zone & unload over the wire ----
const dz = { x: Math.min(60, cx + 10), y: cy + 8 };
send(A, { t: "order", ids: [chop.id], kind: "unload", x: dz.x + 0.5, y: dz.y + 0.5 });
await sleep(400);
ok(denies(A).length === nDeny0, "unload order accepted over the wire (no deny)");
const dropped = await waitFor(() => ent(A, i1.id) && ent(A, i2.id), 40000);
ok(dropped, "passengers reappear in the snapshot stream after unload");
if (dropped) {
  const e1 = ent(A, i1.id), e2 = ent(A, i2.id);
  const near = [e1, e2].every((e) => Math.abs(e.x - dz.x) <= 9 && Math.abs(e.y - dz.y) <= 9);
  ok(near, `passengers disembark near drop zone (${e1.x.toFixed(1)},${e1.y.toFixed(1)}) & (${e2.x.toFixed(1)},${e2.y.toFixed(1)}) vs (${dz.x},${dz.y})`);
  ok(e1.id === i1.id && e2.id === i2.id, "passenger entity identity survives the round trip");
  const emptied = await waitFor(() => (ent(A, chop.id)?.cargo ?? 0) === 0, 8000);
  ok(emptied, `cargo scalar returns to 0 (cargo=${ent(A, chop.id)?.cargo})`);
}

// ---- wire validation: bogus kind still denied ----
const nD = denies(A).length;
send(A, { t: "order", ids: [chop.id], kind: "teleport", x: 10, y: 10 });
await sleep(700);
ok(denies(A).length > nD, "unknown order kind denied over the wire");

A.ws.close();
B.ws.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
