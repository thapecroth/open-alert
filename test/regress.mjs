// Regression test for fuzz findings: NaN credits, socket kills, token dedup.
const ROOM = "reg" + Date.now().toString(36);
const URL = `ws://localhost:8787/parties/game-room/${ROOM}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

function conn(name, token) {
  const ws = new WebSocket(URL);
  const st = { ws, msgs: [], slot: null, you: null, snaps: [], closed: false };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    st.msgs.push(m);
    if (m.t === "init") {
      st.you = m.you;
      st.slot = m.slot;
    }
    if (m.t === "snap") st.snaps.push(m);
    if (m.t === "lobby") st.lobby = m;
  };
  ws.onclose = (e) => {
    st.closed = true;
    console.log(`[${name}] closed ${e.code} ${e.reason}`);
  };
  ws.onerror = () => console.log(`[${name}] error`);
  ws.onopen = () => ws.send(JSON.stringify({ t: "join", name, token }));
  return st;
}
const send = (st, m) => st.ws.send(JSON.stringify(m));
const lastSnap = (st) => st.snaps[st.snaps.length - 1];
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

a2.ws.close();
b.ws.close();
c.ws.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
