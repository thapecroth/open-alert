// Regression for bug-hunt report #ec86fd41: amove resume, harvester hold,
// bot lifecycle, sell-power, place-on-units, spawn stacking.
import { wsconn, send, lastSnap, sleep } from "./wsconn.mjs";
const ROOM = "bf" + Date.now().toString(36);
const URL = `ws://localhost:8787/parties/game-room/${ROOM}`;
let pass = 0, fail = 0;
const ok = (c, l) => { c ? (pass++, console.log("ok:", l)) : (fail++, console.log("FAIL:", l)); };

function conn(name, token, room = ROOM) {
  return wsconn(`ws://localhost:8787/parties/game-room/${room}`, name, token, {
    onmsg: (m, st) => {
      if (m.t === "lobby") st.lobby = m;
    },
  });
}
const ent = (s, id) => lastSnap(s)?.ents.find((e) => e.id === id);
const mine = (s, k) => (lastSnap(s)?.ents ?? []).filter((e) => e.o === s.slot && (!k || e.k === k));
// poll a condition instead of fixed sleeps — round-trips and sim progress are
// load-dependent on this shared machine; the sim never runs faster than nominal
const until = async (pred, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(60);
  }
  return !!pred();
};

const a = conn("Alice", "bf-A");
for (let i = 0; i < 40 && !a.lobby; i++) await sleep(100);
send(a, { t: "addbot" });
await until(() => a.lobby?.players.length === 2, 4000);
send(a, { t: "start" });
await until(() => (lastSnap(a)?.ents?.length ?? 0) > 0, 8000);

// --- #4/#5: disconnect all humans → playing room holds 30s reconnect grace (PR #31) ---
const roomUrl = `http://localhost:8787/parties/game-room/${ROOM}`;
a.ws.close();
await sleep(800);
const st1 = await (await fetch(roomUrl)).json();
ok(st1.phase === "playing", `bot room holds reconnect grace when humans leave (${JSON.stringify(st1)})`);

// fresh room for sim checks — under the 30s reconnect grace Alice's room stays
// "playing", so Bob/Carl must use a different room or they'd join as spectators.
// gameSpeed 2 doubles the sim clock (server-supported lobby config): every
// tick-domain window below halves in wall-clock without changing any mechanic.
const ROOM2 = ROOM + "x";
const b = conn("Bob", "bf-B", ROOM2);
// join ordering is a socket race — Bob MUST be in before Carl connects or Carl
// can land slot0/host and every host-only command below is silently meaningless
await until(() => b.lobby?.players.length === 1, 5000);
const c = conn("Carl", "bf-C", ROOM2);
await until(() => b.lobby?.players.length === 2, 5000);
send(b, { t: "setConfig", config: { gameSpeed: 2 } });
send(c, { t: "ready", ready: true });
await until(() => b.lobby?.players.find((p) => p.name === "Carl")?.ready === true, 4000);
// start can race the ready broadcast under load — retry while no snap arrives
for (let tries = 0; tries < 6 && !(lastSnap(b)?.ents?.length > 0); tries++) {
  send(b, { t: "start" });
  await until(() => lastSnap(b)?.ents?.length > 0, 2500);
}
ok(
  lastSnap(b)?.ents?.length > 0,
  `game with 2 humans started (snaps=${b.snaps.length} msgs=${b.msgs.map((m) => m.t).join(",")} denies=${b.msgs.filter((m) => m.t === "deny").map((m) => m.msg).join("|") || "none"} lobby=${JSON.stringify(b.lobby?.players?.map((p) => [p.name, p.slot, p.ready, p.connected]))})`
);

// --- #9: place building on a unit must be denied ---
send(b, { t: "build", kind: "power" });
// power is 50 buildTicks = 2.5s at 20Hz nominal — poll instead of fixed sleep:
// the alarm-driven sim only ever runs slower than nominal under load
await until(() => lastSnap(b)?.players?.[b.slot]?.awaiting?.includes("power"), 12000);
ok(lastSnap(b)?.players?.[b.slot]?.awaiting?.includes("power"), "power awaiting");
const tank = mine(b, "tank")[0];
send(b, { t: "place", tx: Math.floor(tank.x), ty: Math.floor(tank.y) });
await until(() => b.msgs.some((m) => m.t === "deny" && /units in the way/i.test(m.msg)), 4000);
const denied = b.msgs.filter((m) => m.t === "deny").map((m) => m.msg);
ok(denied.some((d) => /units in the way/i.test(d)), `place on unit denied (${denied.at(-1)})`);
ok(lastSnap(b)?.players?.[b.slot]?.awaiting?.includes("power"), "awaiting preserved after deny");
// place legally next to conyard
const cy = mine(b, "conyard")[0];
send(b, { t: "place", tx: Math.round(cy.x + 3), ty: Math.round(cy.y - 1) });
await until(() => mine(b, "power").length > 0, 4000);
const pw = mine(b, "power")[0];
ok(!!pw, "legal place works");

// --- #7: sell power → pwrHave must drop immediately ---
if (pw) {
  const before = lastSnap(b).players[b.slot];
  send(b, { t: "sell", id: pw.id });
  await until(() => lastSnap(b)?.players?.[b.slot]?.pwrHave < before.pwrHave, 4000);
  const after = lastSnap(b)?.players?.[b.slot];
  ok(after?.pwrHave < before.pwrHave, `power recomputed on sell (${before.pwrHave} -> ${after?.pwrHave})`);
}

// wait until a queued building is ready to place (buildTicks at 10Hz)
async function waitAwaiting(st, kind, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (lastSnap(st)?.players?.[st.slot]?.awaiting?.includes(kind)) return true;
    await sleep(250);
  }
  return false;
}

// helper: try a ring of placements until one succeeds
async function placeNear(st, kind, cx, cy) {
  for (const [tx, ty] of [[cx + 4, cy - 1], [cx - 5, cy + 1], [cx + 4, cy + 3], [cx - 1, cy - 5], [cx - 5, cy - 2], [cx + 1, cy + 5]])
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        send(st, { t: "place", tx: Math.round(tx + dx), ty: Math.round(ty + dy) });
        await sleep(150);
        const found = mine(st, kind)[0];
        if (found) return found;
      }
  return null;
}

// --- #2/#3: harvester with cargo obeys move + stop ---
// build refinery to get a harvester
send(b, { t: "build", kind: "refinery" });
ok(await waitAwaiting(b, "refinery"), "refinery ready to place");
const ref = await placeNear(b, "refinery", cy.x, cy.y);
await sleep(800);
const harv = mine(b, "harvester")[0];
ok(!!harv, "harvester spawned");
if (harv) {
  // order it onto the nearest real ore cell from the init payload
  const ore = (b.msgs.find((m) => m.t === "init")?.ore ?? []).map(([x, y]) => ({ x, y }));
  let cargoT0 = Date.now();
  if (ore.length) {
    ore.sort((p, q) => Math.hypot(p.x - harv.x, p.y - harv.y) - Math.hypot(q.x - harv.x, q.y - harv.y));
    send(b, { t: "order", ids: [harv.id], kind: "harvest", x: ore[0].x, y: ore[0].y });
  }
  let h;
  while (Date.now() - cargoT0 < 25000) {
    await sleep(1000);
    h = ent(b, harv.id);
    if ((h?.cargo ?? 0) > 0) break;
  }
  ok((h?.cargo ?? 0) > 0, `harvester loaded cargo (${h?.cargo})`);
  if (h) {
  const pos = { x: h.x, y: h.y };
  // move to the farthest ore cell — guaranteed passable, unlike building tiles
  const far = ore.reduce((f, p) => (Math.hypot(p.x - h.x, p.y - h.y) > Math.hypot(f.x - h.x, f.y - h.y) ? p : f), ore[0]);
  send(b, { t: "order", ids: [harv.id], kind: "move", x: far.x, y: far.y });
  // displacement, not arrival — poll until the move shows (load-independent)
  await until(() => {
    const hh = ent(b, harv.id);
    return hh && Math.hypot(hh.x - pos.x, hh.y - pos.y) > 1.5;
  }, 9000);
  const h2 = ent(b, harv.id);
  const moved = h2 ? Math.hypot(h2.x - pos.x, h2.y - pos.y) : 0;
  ok(moved > 1.5, `loaded harvester obeys move order (moved ${moved.toFixed(1)})`);
  const pos2 = h2 ? { x: h2.x, y: h2.y } : pos;
  send(b, { t: "stop", ids: [harv.id] });
  // negative drift check inherently needs a timed window: 2s at 20Hz is ~4.4
  // tiles of would-be travel for an unstopped harvester — far beyond the 1.0 gate
  await sleep(2000);
  const h3 = ent(b, harv.id);
  const moved2 = h3 ? Math.hypot(h3.x - pos2.x, h3.y - pos2.y) : Infinity;
  ok(moved2 < 1.0, `stop holds harvester (drift ${moved2.toFixed(2)})`);
  }
}

// --- #10: production units don't stack ---
// NOTE: Bob sold his only power plant above → lowPower → production at half rate
send(b, { t: "build", kind: "barracks" });
await waitAwaiting(b, "barracks");
await placeNear(b, "barracks", cy.x, cy.y);
await sleep(800);
for (let i = 0; i < 4; i++) send(b, { t: "train", unit: "infantry" });
let inf = [];
for (let t0 = Date.now(); Date.now() - t0 < 40000; ) {
  await sleep(1000);
  inf = mine(b, "infantry");
  if (inf.length >= 7) break; // 3 starting + 4 trained
}
const distinctTiles = new Set(inf.map((e) => `${Math.floor(e.x)},${Math.floor(e.y)}`));
ok(inf.length >= 6 && distinctTiles.size === inf.length, `spawned units spread (${inf.length} inf on ${distinctTiles.size} tiles)`);

// --- #1: amove resumes destination after kill ---
const enemy = lastSnap(b)?.ents.find((e) => e.o !== b.slot && e.o >= 0);
const tanks = mine(b, "tank");
if (enemy && tanks.length) {
  const dest = { x: tanks[0].x + 15, y: tanks[0].y };
  send(b, { t: "order", ids: tanks.map((t) => t.id), kind: "amove", x: dest.x, y: dest.y });
  // 15 tiles at 0.16/tick is ~94 ticks of pure walk — 4.7s at 20Hz nominal but
  // the sim only ever runs slower under load, so poll instead of a fixed 6s
  // sleep that was marginal even at a perfect tick rate
  const arrived = await until(() => {
    const t = ent(b, tanks[0].id);
    return t && Math.hypot(dest.x - t.x, dest.y - t.y) < 8;
  }, 25000);
  const t2 = ent(b, tanks[0].id);
  if (t2) {
    const remain = Math.hypot(dest.x - t2.x, dest.y - t2.y);
    ok(arrived && remain < 8, `amove progresses to destination (dist ${remain.toFixed(1)} remaining)`);
  } else ok(false, "amove progresses to destination (tank gone)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
