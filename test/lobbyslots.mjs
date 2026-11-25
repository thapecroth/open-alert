// Lobby spawn/color slot regression test: empty-slot moves, bot swaps,
// human-swap authorization, host-forced arbitrary swaps, host stability,
// validation denials, and slot/team preservation into game start.
import { wsconn, send, lastSnap, sleep } from "./wsconn.mjs";

const ROOM = "slots" + Date.now().toString(36);
const URL = `ws://localhost:8787/parties/game-room/${ROOM}`;
let pass = 0,
  fail = 0;
const ok = (c, l, evidence = "") => {
  if (c) {
    pass++;
    console.log("ok:", l);
  } else {
    fail++;
    console.log("FAIL:", l, evidence);
  }
};
const until = async (pred, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(50);
  }
  return false;
};
const conn = (name, token) =>
  wsconn(URL, name, token, {
    onmsg: (m, st) => {
      if (m.t === "lobby") st.lobby = m;
    },
  });
const waitLobby = (s, pred, ms = 5000) => until(() => !!s.lobby && pred(s.lobby), ms);
const player = (s, name) => s.lobby?.players.find((p) => p.name === name);
const slotOf = (s, name) => player(s, name)?.slot;
const denies = (s) => s.msgs.filter((m) => m.t === "deny").map((m) => m.msg);

const a = conn("SlotA", "tok-slot-a");
let b = null;
let c = null;

try {
  ok(await waitLobby(a, (l) => l.players.some((p) => p.name === "SlotA")), "A joins slot lobby");
  b = conn("SlotB", "tok-slot-b");
  ok(await waitLobby(a, (l) => l.players.length === 2), "B joins slot lobby");
  ok(slotOf(a, "SlotA") === 0 && slotOf(a, "SlotB") === 1, "initial join order allocates slots 0/1");
  ok(player(a, "SlotA")?.host === true, "A starts as host");

  const aId = player(a, "SlotA")?.id;
  const bId = player(a, "SlotB")?.id;
  ok(!!aId && !!bId, "captured A/B player ids");

  let denyCount = denies(a).length;
  send(a, { t: "setSlot", slot: 8 });
  ok(await until(() => denies(a).length > denyCount), "invalid slot 8 is denied", denies(a).join("|"));
  ok(denies(a).at(-1)?.includes("invalid spawn slot"), "invalid-slot denial explains valid range");

  denyCount = denies(a).length;
  send(a, { t: "setSlot", slot: 1 });
  ok(await until(() => denies(a).length > denyCount), "move into occupied slot is denied");
  ok(denies(a).at(-1)?.includes("occupied"), "occupied move denial suggests swap");

  send(a, { t: "setSlot", slot: 4 });
  ok(await waitLobby(a, (l) => slotOf(a, "SlotA") === 4), "host moves self to empty slot 4");

  send(a, { t: "addbot", diff: "easy" });
  ok(await waitLobby(a, (l) => l.players.some((p) => p.bot)), "host adds bot");
  const bot = a.lobby.players.find((p) => p.bot);
  ok(bot?.slot === 0, "bot backfills lowest free slot 0", JSON.stringify(bot));

  send(b, { t: "swapSlot", id: bot.id });
  ok(
    await waitLobby(a, (l) => slotOf(a, "SlotB") === 0 && l.players.find((p) => p.id === bot.id)?.slot === 1),
    "non-host may swap with bot",
  );

  denyCount = denies(b).length;
  send(b, { t: "swapSlot", id: aId });
  ok(await until(() => denies(b).length > denyCount), "non-host human-on-human swap is denied");
  ok(denies(b).at(-1)?.includes("only the host"), "human-swap denial names host rule");
  ok(slotOf(a, "SlotB") === 0 && slotOf(a, "SlotA") === 4, "denied human swap changes no slots");

  c = conn("SlotC", "tok-slot-c");
  ok(await waitLobby(a, (l) => l.players.some((p) => p.name === "SlotC")), "C joins");
  const cId = player(a, "SlotC")?.id;
  ok(slotOf(a, "SlotC") === 2, "C backfills slot 2", `slot=${slotOf(a, "SlotC")}`);

  denyCount = denies(b).length;
  send(b, { t: "swapSlot", id: aId, id2: cId });
  ok(await until(() => denies(b).length > denyCount), "non-host arbitrary id↔id2 swap is denied");
  ok(denies(b).at(-1)?.includes("only the host"), "arbitrary-swap denial names host rule");

  send(a, { t: "swapSlot", id: bId, id2: cId });
  ok(
    await waitLobby(a, (l) => slotOf(a, "SlotB") === 2 && slotOf(a, "SlotC") === 0),
    "host atomically swaps two other humans",
  );
  ok(slotOf(a, "SlotA") === 4, "host arbitrary swap does not move host");
  ok(player(a, "SlotA")?.host === true, "host flag survives slot rearrangement");

  send(a, { t: "setSlot", slot: 3, id: bot.id });
  ok(await waitLobby(a, (l) => l.players.find((p) => p.id === bot.id)?.slot === 3), "host moves bot to empty slot 3");

  // Mixed teams exercise team-keyed-by-slot preservation: C0=T2, B2=T1, bot3=T1, A4=FFA.
  send(b, { t: "setTeam", team: 1 });
  send(c, { t: "setTeam", team: 2 });
  send(a, { t: "setTeam", team: 1, id: bot.id });
  ok(
    await waitLobby(
      a,
      (l) =>
        l.players.find((p) => p.name === "SlotB")?.team === 1 &&
        l.players.find((p) => p.name === "SlotC")?.team === 2 &&
        l.players.find((p) => p.id === bot.id)?.team === 1,
    ),
    "teams assigned before start",
  );

  send(b, { t: "ready", ready: true });
  send(c, { t: "ready", ready: true });
  await waitLobby(a, (l) => l.players.filter((p) => !p.bot && !p.host && !p.spectator).every((p) => p.ready));
  send(a, { t: "start" });
  ok(await until(() => !!lastSnap(a)?.players, 7000), "game starts after slot rearrangement");
  const snap = lastSnap(a);
  const keys = Object.keys(snap?.players ?? {}).sort();
  ok(JSON.stringify(keys) === JSON.stringify(["0", "2", "3", "4"]), "world players keyed by rearranged slots", keys.join(","));
  ok(
    snap?.players?.[0]?.team === 2 &&
      snap?.players?.[2]?.team === 1 &&
      snap?.players?.[3]?.team === 1 &&
      snap?.players?.[4]?.team === 0,
    "teams remain keyed to the rearranged slots in-game",
    JSON.stringify({ 0: snap?.players?.[0]?.team, 2: snap?.players?.[2]?.team, 3: snap?.players?.[3]?.team, 4: snap?.players?.[4]?.team }),
  );
  const conyardOwners = new Set((snap?.ents ?? []).filter((e) => e.k === "conyard").map((e) => e.o));
  ok([0, 2, 3, 4].every((s) => conyardOwners.has(s)), "each rearranged slot receives its conyard spawn", JSON.stringify([...conyardOwners]));
} catch (err) {
  fail++;
  console.log("FAIL: unexpected test error:", err?.message ?? err);
} finally {
  for (const s of [a, b, c]) {
    try {
      s?.ws.close();
    } catch {}
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
