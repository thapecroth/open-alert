// Feature test: host transfer, addbot, sell, repair, chat, resign, ready-gate.
import { wsconn, send, lastSnap, sleep } from "./wsconn.mjs";
const ROOM = "feat" + Date.now().toString(36);
const URL = `ws://localhost:8787/parties/game-room/${ROOM}`;
let pass = 0, fail = 0;
const ok = (c, l) => { c ? (pass++, console.log("ok:", l)) : (fail++, console.log("FAIL:", l)); };

function conn(name, token, url = URL, opts = {}) {
  return wsconn(url, name, token, {
    ...opts,
    onmsg: (m, st) => {
      if (m.t === "lobby") st.lobby = m;
      opts.onmsg?.(m, st);
    },
  });
}
const me = (s) => lastSnap(s)?.players?.[s.slot];
const denies = (s) => s.msgs.filter((m) => m.t === "deny").map((m) => m.msg);
const roomUrl = (room) => `ws://localhost:8787/parties/game-room/${room}`;
const hostPlayer = (s) => s.lobby?.players.find((p) => p.host);
const isHostId = (lobby, id) => lobby?.players.find((p) => p.id === id)?.host === true;
const lobbyCount = (s) => s.msgs.filter((m) => m.t === "lobby").length;
const until = async (pred, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(50);
  }
  return false;
};
const waitLobby = (s, pred, ms = 2000) => until(() => s.lobby && pred(s.lobby), ms);

// ---- host transfer + precedence ----
{
  const url = roomUrl(ROOM + "hp");
  const ha = conn("HostA", "tok-ha", url);
  await waitLobby(ha, (l) => l.players.length === 1);
  const hb = conn("HostB", "tok-hb", url);
  ok(await waitLobby(ha, (l) => l.players.length === 2, 2500), "host-transfer test players joined");
  const pa = ha.lobby?.players.find((p) => p.name === "HostA");
  const pb = ha.lobby?.players.find((p) => p.name === "HostB");
  ok(pa?.host === true && pb?.host === false, "first joiner starts as host");
  if (pb) send(ha, { t: "transferHost", id: pb.id });
  ok(!!pb && (await waitLobby(ha, (l) => isHostId(l, pb.id))), "transferHost moves host flag to target");
  ok(!!pb && (await waitLobby(hb, (l) => isHostId(l, pb.id))), "host flag moves on target client too");

  const denyCount = denies(ha).length;
  send(ha, { t: "setMap", map: "canyon" });
  send(ha, { t: "setConfig", config: { startCredits: 10000 } });
  await sleep(400);
  ok(ha.lobby?.map === "crossroads" && ha.lobby?.config?.startCredits !== 10000, "old host map/config changes ignored");
  ok(denies(ha).length === denyCount, "old host map/config changes are silent");
  send(hb, { t: "setMap", map: "canyon" });
  ok(await waitLobby(ha, (l) => l.map === "canyon"), "new host can set map");
  send(hb, { t: "setConfig", config: { startCredits: 10000 } });
  ok(await waitLobby(ha, (l) => l.config?.startCredits === 10000), "new host can set config");

  send(ha, { t: "ready", ready: true });
  send(hb, { t: "ready", ready: true });
  await waitLobby(ha, (l) => l.players.filter((p) => !p.spectator).every((p) => p.ready));
  const startDenies = denies(ha).length;
  send(ha, { t: "start" });
  await sleep(450);
  ok(!ha.msgs.some((m) => m.t === "init") && ha.snaps.length === 0 && denies(ha).length === startDenies, "old host start silently ignored");
  send(hb, { t: "start" });
  await sleep(1500);
  ok((lastSnap(ha)?.ents?.length ?? 0) > 0 || ha.msgs.some((m) => m.t === "init"), "new host start permission works");
  if (pa) send(hb, { t: "transferHost", id: pa.id });
  ok(!!pa && (await waitLobby(ha, (l) => isHostId(l, pa.id), 5000)), "mid-game transfer is accepted");
  send(ha, { t: "resign" });
  ok(await until(() => ha.msgs.some((m) => m.t === "end"), 6000), "transfer-carry test game ended");
  send(ha, { t: "rematch" });
  ok(!!pa && (await waitLobby(ha, (l) => l.phase === "lobby" && isHostId(l, pa.id), 6000)), "mid-game transfer carries into rematch lobby");
  ha.ws.close();
  hb.ws.close();
}

{
  const url = roomUrl(ROOM + "hi");
  const ia = conn("InvA", "tok-ia", url);
  await waitLobby(ia, (l) => l.players.length === 1);
  const ib = conn("InvB", "tok-ib", url);
  await waitLobby(ia, (l) => l.players.length === 2);
  send(ia, { t: "addbot" });
  await waitLobby(ia, (l) => l.players.some((p) => p.bot));
  const is = conn("InvSpec", "tok-is", url, { spectate: true });
  await waitLobby(ia, (l) => l.players.some((p) => p.spectator));
  const bot = ia.lobby?.players.find((p) => p.bot);
  const spec = ia.lobby?.players.find((p) => p.spectator);
  const beforeHost = hostPlayer(ia)?.id;
  ok(!!bot && !!spec && !!beforeHost, "invalid-transfer lobby setup complete");
  const denyCount = denies(ia).length;
  for (const id of [bot?.id, spec?.id, beforeHost, "missing-id"]) {
    if (id) send(ia, { t: "transferHost", id });
  }
  await sleep(500);
  ok(hostPlayer(ia)?.id === beforeHost, "transfer to bot/spectator/self/missing id is a no-op");
  if (beforeHost) send(ib, { t: "transferHost", id: beforeHost });
  await sleep(300);
  ok(hostPlayer(ia)?.id === beforeHost && denies(ia).length === denyCount, "non-host transfer is silently ignored");
  ia.ws.close();
  ib.ws.close();
  is.ws.close();
}

{
  const url = roomUrl(ROOM + "hd");
  const fa = conn("FallA", "tok-fa", url);
  await waitLobby(fa, (l) => l.players.length === 1);
  const fb = conn("FallB", "tok-fb", url);
  await waitLobby(fa, (l) => l.players.length === 2);
  const fc = conn("FallC", "tok-fc", url);
  await waitLobby(fa, (l) => l.players.length === 3);
  const fd = conn("FallD", "tok-fd", url);
  ok(await waitLobby(fa, (l) => l.players.length === 4, 2500), "disconnect-fallback test players joined");
  const pb = fa.lobby?.players.find((p) => p.name === "FallB");
  const pc = fa.lobby?.players.find((p) => p.name === "FallC");
  if (pc) send(fa, { t: "transferHost", id: pc.id });
  ok(!!pc && (await waitLobby(fa, (l) => isHostId(l, pc.id))), "explicit assignee becomes host before disconnect test");
  fa.ws.close();
  ok(!!pc && (await waitLobby(fb, (l) => l.players.length === 3 && isHostId(l, pc.id), 2500)), "explicit host survives original host disconnect");
  fc.ws.close();
  ok(!!pb && (await waitLobby(fb, (l) => l.players.length === 2 && isHostId(l, pb.id), 2500)), "assignee disconnect falls back to lowest-slot connected human");
  fb.ws.close();
  fd.ws.close();
}

{
  const url = roomUrl(ROOM + "hv");
  const va = conn("PrecedenceA", "tok-va", url);
  await waitLobby(va, (l) => l.players.length === 1);
  const vaId = va.lobby?.players[0]?.id;
  const v1 = conn("v", "tok-v1", url);
  await waitLobby(va, (l) => l.players.length === 2);
  const v1p = va.lobby?.players.find((p) => p.name === "v");
  ok(!!v1p && isHostId(va.lobby, v1p.id), "v joining second becomes host immediately");
  v1.ws.close();
  ok(!!vaId && (await waitLobby(va, (l) => l.players.length === 1 && isHostId(l, vaId), 2500)), "host returns after v leaves");

  const vb = conn("PrecedenceB", "tok-vb", url);
  await waitLobby(va, (l) => l.players.length === 2);
  const vbp = va.lobby?.players.find((p) => p.name === "PrecedenceB");
  if (vbp) send(va, { t: "transferHost", id: vbp.id });
  ok(!!vbp && (await waitLobby(va, (l) => isHostId(l, vbp.id))), "explicit transfer before v join works");
  const v2 = conn("v", "tok-v2", url);
  await waitLobby(va, (l) => l.players.length === 3);
  const v2p = va.lobby?.players.find((p) => p.name === "v");
  ok(!!vbp && isHostId(va.lobby, vbp.id), "explicit transfer survives v joining");
  if (vbp && v2p) send(vb, { t: "transferHost", id: v2p.id });
  ok(!!v2p && (await waitLobby(va, (l) => isHostId(l, v2p.id))), "host can transfer to v explicitly");
  if (vaId) send(v2, { t: "transferHost", id: vaId });
  ok(!!vaId && (await waitLobby(va, (l) => isHostId(l, vaId))), "v can deliberately give host away while present");
  v2.ws.close();
  ok(!!vaId && (await waitLobby(va, (l) => isHostId(l, vaId), 2500)), "explicit transfer persists after v leaves");
  va.ws.close();
  vb.ws.close();
}

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
