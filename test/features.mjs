// Feature test: addbot, sell, repair, chat, resign, ready-gate.
import { wsconn, send, lastSnap, sleep } from "./wsconn.mjs";
const ROOM = "feat" + Date.now().toString(36);
const URL = `ws://localhost:8787/parties/game-room/${ROOM}`;
let pass = 0, fail = 0;
const ok = (c, l) => { c ? (pass++, console.log("ok:", l)) : (fail++, console.log("FAIL:", l)); };

function conn(name, token) {
  return wsconn(URL, name, token, {
    onmsg: (m, st) => {
      if (m.t === "lobby") st.lobby = m;
    },
  });
}
const me = (s) => lastSnap(s)?.players?.[s.slot];
const denies = (s) => s.msgs.filter((m) => m.t === "deny").map((m) => m.msg);

const a = conn("Alice", "tok-A");
await sleep(700);
send(a, { t: "start" });
await sleep(200);
ok(denies(a).some((d) => /at least 2/i.test(d)), "solo start denied");

send(a, { t: "addbot" });
await sleep(400);
ok(a.lobby?.players.length === 2 && a.lobby.players.some((p) => p.name.startsWith("CABAL")), "bot joined lobby");
send(a, { t: "addbot" });
await sleep(300);
ok(a.lobby?.players.length === 3, "second bot joined");

send(a, { t: "chat", text: "hello <b>world</b>" });
await sleep(300);
const chat = a.msgs.find((m) => m.t === "chat");
ok(chat && !/[<>]/.test(chat.text) && chat.name === "Alice", `chat broadcast sanitized (${chat?.text})`);

send(a, { t: "ping", x: 30, y: 30 });
await sleep(200);
ok(a.msgs.some((m) => m.t === "ping" && m.x === 30), "ping broadcast");
send(a, { t: "ping", x: 999, y: 0 });
await sleep(200);
ok(a.msgs.filter((m) => m.t === "ping").length === 1, "out-of-bounds ping rejected");

send(a, { t: "start" });
await sleep(1200);
ok(lastSnap(a)?.ents?.length > 0, "game started vs 2 bots");
const bots = a.lobby?.players.filter((p) => p.name.startsWith("CABAL"));
ok(bots?.length === 2 && bots.every((b) => b.slot >= 0), `bots have slots ${bots?.map((b) => b.slot)}`);

// let the sim run — bots should start building
await sleep(6000);
const botEnts = lastSnap(a).ents.filter((e) => e.o === 1 || e.o === 2);
ok(botEnts.length >= 7, `bots produced buildings/units (${botEnts.length} ents)`);

// sell own conyard-free test: build power, place, sell
send(a, { t: "build", kind: "power" });
await sleep(5600); // power buildTicks ~50*... wait for awaiting
const awaiting = me(a)?.awaiting;
ok(awaiting?.includes("power"), `power plant ready to place (${awaiting})`);
// find a legal spot next to our conyard (conyard is 3x3 at spawn)
const cy = lastSnap(a).ents.find((e) => e.o === a.slot && e.k === "conyard");
let pw = null;
if (cy) {
  outer: for (const [tx, ty] of [[cy.x + 3, cy.y - 1], [cy.x - 4, cy.y], [cy.x + 3, cy.y + 2], [cy.x, cy.y + 4], [cy.x - 4, cy.y + 2], [cy.x + 2, cy.y - 4]])
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        send(a, { t: "place", tx: Math.round(tx + dx), ty: Math.round(ty + dy) });
        await sleep(120);
        pw = lastSnap(a).ents.find((e) => e.o === a.slot && e.k === "power");
        if (pw) break outer;
      }
}
const crBefore = me(a)?.credits;
ok(!!pw, `power plant placed (denies: ${denies(a).slice(-3).join(";") || "none"})`);
if (pw) {
  // repair on full hp → deny
  send(a, { t: "repair", id: pw.id });
  await sleep(300);
  ok(denies(a).some((d) => /full health/i.test(d)), "repair denied at full hp");
  send(a, { t: "sell", id: pw.id });
  await sleep(400);
  const crAfter = me(a)?.credits;
  ok(crAfter > crBefore, `sell refunded credits (${crBefore} -> ${crAfter})`);
  ok(!lastSnap(a).ents.some((e) => e.id === pw.id), "sold building removed");
}
// sell foreign building → deny
const foe = lastSnap(a).ents.find((e) => e.o !== a.slot && e.o >= 0);
if (foe) {
  send(a, { t: "sell", id: foe.id });
  await sleep(300);
  ok(denies(a).some((d) => /can't sell/i.test(d)), "can't sell enemy building");
}

// resign → elimination
send(a, { t: "resign" });
await sleep(800);
const endMsg = a.msgs.find((m) => m.t === "end");
ok(me(a)?.eliminated === true || !!endMsg, `resign eliminated player (end=${endMsg?.reason ?? "pending"})`);

// rematch → restart: the v2 stream must resync keyframe-first even though seq
// continues monotonically (world-keyed diff baseline forces a fresh keyframe).
// Fresh room with a single bot: resign ends the game instantly (bot wins).
a.ws.close();
const ROOM2 = ROOM + "r";
const r = wsconn(`ws://localhost:8787/parties/game-room/${ROOM2}`, "Rex", "tok-R");
await sleep(700);
send(r, { t: "addbot" });
await sleep(400);
send(r, { t: "start" });
await sleep(1200);
ok((lastSnap(r)?.ents?.length ?? 0) > 0, "rematch-test game started");
send(r, { t: "resign" });
await sleep(1500);
ok(r.msgs.some((m) => m.t === "end"), "game ended after resign");
send(r, { t: "rematch" });
await sleep(500);
send(r, { t: "start" });
await sleep(1800);
const initIdxs = r.msgs.map((m, i) => (m.t === "init" ? i : -1)).filter((i) => i >= 0);
const lastInitIdx = initIdxs[initIdxs.length - 1];
const firstFrame = r.msgs.slice(lastInitIdx + 1).find((m) => m.t === "snap" || m.t === "snapd");
ok(initIdxs.length >= 2 && firstFrame?.key === true, `rematch restart resyncs keyframe-first (inits=${initIdxs.length}, first=${firstFrame?.t} key=${firstFrame?.key})`);
ok((lastSnap(r)?.ents?.length ?? 0) > 0, `rematch game live (${lastSnap(r)?.ents?.length} ents)`);
ok(r.proto.droppedDelta === 0, `no dropped deltas across rematch (dropped=${r.proto.droppedDelta})`);
r.ws.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
