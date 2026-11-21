// Feature test: addbot, sell, repair, chat, resign, ready-gate.
const ROOM = "feat" + Date.now().toString(36);
const URL = `ws://localhost:8787/parties/game-room/${ROOM}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, l) => { c ? (pass++, console.log("ok:", l)) : (fail++, console.log("FAIL:", l)); };

function conn(name, token) {
  const ws = new WebSocket(URL);
  const st = { ws, msgs: [], slot: null, you: null, snaps: [], lobby: null };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    st.msgs.push(m);
    if (m.t === "init") { st.you = m.you; st.slot = m.slot; }
    if (m.t === "snap") st.snaps.push(m);
    if (m.t === "lobby") st.lobby = m;
  };
  ws.onopen = () => ws.send(JSON.stringify({ t: "join", name, token }));
  return st;
}
const send = (s, m) => s.ws.send(JSON.stringify(m));
const lastSnap = (s) => s.snaps[s.snaps.length - 1];
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
ok(awaiting === "power", `power plant ready to place (${awaiting})`);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
