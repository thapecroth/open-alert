// Regression test: half-open/zombie lobby connections must not block game start.
//
// Root cause being pinned: a client whose network dies silently (NAT drop,
// laptop sleep, network switch) never fires onClose server-side — the TCP
// socket is half-open. Before the fix such a zombie player stayed
// connected:true forever and, since it could never ready up, the host's start
// click was denied with "X is not ready" for the rest of eternity. Meanwhile
// the zombie saw a frozen lobby with zero error until a manual refresh.
//
// Fix under test: the server heartbeats back hbok and reaps lobby-phase
// connections silent for >30s (healthy clients hb every 15s), which runs the
// normal onClose cleanup — the zombie's slot is freed and start unblocks.
//
// Scenario: five humans join; P5 goes completely silent right after joining
// (never readies, never heartbeats — exactly what a half-open conn looks like
// server-side). The rest ready up and keep heartbeating like real clients.
//  1. an early start click must be denied ("P5 is not ready") — control;
//  2. after the reap window, the zombie is swept and start must succeed —
//     this FAILS before the fix (deny forever) and passes after.
import { wsconn, send, sleep } from "./wsconn.mjs";

const ROOM = "zomb" + Date.now().toString(36);
const URL = `ws://localhost:8787/parties/game-room/${ROOM}`;
let pass = 0,
  fail = 0;
const ok = (c, l) => {
  c ? (pass++, console.log("ok:", l)) : (fail++, console.log("FAIL:", l));
};

function conn(name, token) {
  return wsconn(URL, name, token, {
    onmsg: (m, st) => {
      if (m.t === "lobby") st.lobby = m;
    },
  });
}
const until = async (pred, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(100);
  }
  return false;
};
const waitLobby = (s, pred, ms = 3000) => until(() => s.lobby && pred(s.lobby), ms);
const denies = (s) => s.msgs.filter((m) => m.t === "deny").map((m) => m.msg);

// P5 joins FIRST so its silence clock starts earliest; the host is named "v"
// so host resolution is deterministic.
const p5 = conn("P5", "tok-z5");
await waitLobby(p5, (l) => l.players.length === 1);
const host = conn("v", "tok-zh");
const p2 = conn("P2", "tok-z2");
const p3 = conn("P3", "tok-z3");
const p4 = conn("P4", "tok-z4");
ok(await waitLobby(host, (l) => l.players.length === 5, 4000), "five players joined the lobby");

ok(await until(() => [p2, p3, p4].every((s) => s.ws.readyState === 1), 3000), "client sockets open before sending");
for (const s of [p2, p3, p4]) send(s, { t: "ready", ready: true });
ok(await waitLobby(host, (l) => l.players.filter((p) => p.ready).length === 3, 3000), "P2-P4 readied up");

// healthy clients heartbeat every 2s (faster than the browser's 15s — keeps
// the reaper's scan ticking and proves legit quiet-but-heartbeating conns live);
// P5 never sends anything again: the zombie.
const hbTimer = setInterval(() => {
  for (const s of [host, p2, p3, p4]) {
    try {
      send(s, { t: "hb" });
    } catch {
      /* ignore */
    }
  }
}, 2000);

// control: with P5 present-but-unready, start is denied — same before/after fix
send(host, { t: "start" });
await sleep(700);
ok(
  denies(host).some((d) => /P5 is not ready/.test(d)),
  "control: early start denied while zombie is still a connected unready player",
);

// hbok liveness replies reach heartbeating clients
ok(
  await until(() => host.msgs.some((m) => m.t === "hbok"), 3500),
  "server replies hbok to heartbeats (client watchdog liveness signal)",
);

// now wait out the reap window: P5 went silent at join time, so ~30s from its
// join the sweeper deletes it. Start must then succeed — before the fix this
// remaind denied forever.
const t0 = Date.now();
let started = false;
let deniesAfter35s = [];
while (Date.now() - t0 < 48_000) {
  await sleep(1500);
  send(host, { t: "start" });
  await sleep(700);
  if (host.msgs.some((m) => m.t === "init") || (host.lobby && host.lobby.phase === "playing")) {
    started = true;
    break;
  }
  if (Date.now() - t0 > 35_000) deniesAfter35s = denies(host);
}
clearInterval(hbTimer);

const zombieGone = await until(() => p5.closed, 3000);
ok(zombieGone, "zombie connection was closed server-side after the idle window");
ok(started, `start succeeds once the zombie is reaped (post-35s denies: ${JSON.stringify(deniesAfter35s)})`);

for (const s of [host, p2, p3, p4, p5]) {
  try {
    s.ws.close();
  } catch {
    /* ignore */
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
