#!/usr/bin/env node
// Scripted opponent for Open Alert. Plays a real game over WebSocket:
// build order -> economy -> production -> timed assaults.
// Usage: node test/bot.mjs <room> <name> [--host] [--aggressive]
import {
  BUILDINGS,
  UNITS,
  MAP_W,
  MAP_H,
  SPAWNS,
  START_CREDITS,
} from "../src/shared/gamedefs.ts";

const room = process.argv[2];
const name = process.argv[3] ?? "bot";
const isHost = process.argv.includes("--host");
const aggressive = process.argv.includes("--aggressive");
const base = process.env.OA_WS ?? "ws://localhost:8787";
const url = `${base}/parties/game-room/${room}`;

const ws = new WebSocket(url);
const S = {
  slot: -1,
  you: "",
  players: [],
  ore: new Set(),
  ents: new Map(),
  me: null,
  tick: 0,
  placeIdx: 0,
  armySent: false,
  started: 0,
  denies: [],
};

const B = Object.keys(BUILDINGS);
const isB = (k) => B.includes(k);
const send = (m) => ws.send(JSON.stringify(m));
const idx = (x, y) => y * MAP_W + x;

ws.onopen = () => send({ t: "join", name, token: "bot-" + name });
ws.onerror = (e) => console.log(`[${name}] ws error`, e.message ?? "");
ws.onclose = (e) => console.log(`[${name}] closed ${e.code} ${e.reason}`);

const BUILD_ORDER = ["power", "refinery", "barracks", "factory", "turret"];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.t === "lobby") {
    S.players = m.players;
    if (!S.readied) {
      S.readied = true;
      send({ t: "ready", ready: true });
    }
    if (isHost && !S.sentStart) {
      const nonSpec = m.players.filter((p) => !p.spectator);
      if (nonSpec.length >= 2) {
        S.sentStart = true;
        setTimeout(() => send({ t: "start" }), 300);
      }
    }
  } else if (m.t === "init") {
    S.slot = m.slot;
    S.you = m.you;
    S.started = Date.now();
    for (const [x, y, a] of m.ore) if (a > 0) S.ore.add(idx(x, y));
    console.log(`[${name}] init slot=${S.slot}`);
  } else if (m.t === "snap") {
    S.tick = m.tick;
    for (const e of m.ents) S.ents.set(e.id, e);
    for (const id of [...S.ents.keys()]) if (!m.ents.find((e) => e.id === id)) S.ents.delete(id);
    for (const ev of m.events) {
      if (ev.e === "ore") for (const [x, y, a] of ev.cells) a <= 0 && S.ore.delete(idx(x, y));
      if (ev.e === "elim") console.log(`[${name}] elim slot ${ev.slot}`);
    }
    S.me = m.players[S.slot] ?? null;
    think();
  } else if (m.t === "end") {
    console.log(`[${name}] END winner=${m.winner} (${m.reason})`);
    process.exit(m.winner === S.slot ? 0 : 2);
  } else if (m.t === "deny") {
    S.denies.push(m.msg);
  }
};

function myEnts() {
  return [...S.ents.values()].filter((e) => e.o === S.slot);
}
function enemyEnts() {
  return [...S.ents.values()].filter((e) => e.o >= 0 && e.o !== S.slot);
}
function has(k) {
  return myEnts().some((e) => e.k === k);
}
function footprints() {
  const occ = new Set();
  for (const e of S.ents.values())
    if (isB(e.k)) {
      const d = BUILDINGS[e.k];
      const bx = Math.round(e.x - d.w / 2),
        by = Math.round(e.y - d.h / 2);
      for (let y = by; y < by + d.h; y++) for (let x = bx; x < bx + d.w; x++) occ.add(idx(x, y));
    }
  return occ;
}
function canPlace(kind, tx, ty, occ) {
  const d = BUILDINGS[kind];
  if (tx < 0 || ty < 0 || tx + d.w > MAP_W || ty + d.h > MAP_H) return false;
  for (let y = ty; y < ty + d.h; y++)
    for (let x = tx; x < tx + d.w; x++) if (occ.has(idx(x, y)) || S.ore.has(idx(x, y))) return false;
  for (const e of S.ents.values()) {
    if (e.o !== S.slot || !isB(e.k)) continue;
    const bd = BUILDINGS[e.k];
    const bx = Math.round(e.x - bd.w / 2),
      by = Math.round(e.y - bd.h / 2);
    const gapX = Math.max(bx - (tx + d.w), tx - (bx + bd.w));
    const gapY = Math.max(by - (ty + d.h), ty - (by + d.h));
    if (Math.max(gapX, gapY) <= 2) return true;
  }
  return false;
}
function findSpot(kind) {
  const occ = footprints();
  const mine = myEnts().filter((e) => isB(e.k));
  for (const b of mine) {
    const bd = BUILDINGS[b.k];
    const bx = Math.round(b.x - bd.w / 2),
      by = Math.round(b.y - bd.h / 2);
    const d = BUILDINGS[kind];
    for (let r = 1; r <= 3; r++)
      for (let y = by - r - d.h + 1; y < by + bd.h + r; y++)
        for (let x = bx - r - d.w + 1; x < bx + bd.w + r; x++) {
          if (canPlace(kind, x, y, occ)) return { tx: x, ty: y };
        }
  }
  return null;
}

let lastThink = 0;
function think() {
  if (S.slot < 0 || !S.me || S.me.eliminated) return;
  const now = Date.now();
  if (now - lastThink < 400) return;
  lastThink = now;
  const me = S.me;

  // placement
  if (me.awaiting) {
    const spot = findSpot(me.awaiting);
    if (spot) send({ t: "place", tx: spot.tx, ty: spot.ty });
    return;
  }

  // build order: next needed building
  if (!me.bq && !me.awaiting) {
    let want = null;
    if (!has("power")) want = "power";
    else if (!has("refinery")) want = "refinery";
    else if (!has("barracks")) want = "barracks";
    else if (!has("factory")) want = "factory";
    else if (me.lowPower) want = "power";
    else if (aggressive && !has("turret")) want = "turret";
    if (want && me.credits >= BUILDINGS[want].cost) send({ t: "build", kind: want });
  }

  // production
  if (has("barracks")) {
    const q = S.me.queues.barracks;
    const n = q?.count ?? 0;
    if (n < (aggressive ? 6 : 3) && me.credits > 400) send({ t: "train", unit: "infantry" });
  }
  if (has("factory")) {
    const q = S.me.queues.factory;
    const n = q?.count ?? 0;
    const harvCount = myEnts().filter((e) => e.k === "harvester").length;
    if (harvCount < 2 && !n && me.credits > 1600) send({ t: "train", unit: "harvester" });
    else if (n < (aggressive ? 6 : 3) && me.credits > 900) send({ t: "train", unit: "tank" });
  }

  // harvest orders for idle harvesters without cargo moving nowhere? server auto-harvests.

  // assault: at T seconds or army threshold
  const army = myEnts().filter((e) => !isB(e.k) && e.k !== "harvester");
  const elapsed = (now - S.started) / 1000;
  const threshold = aggressive ? 6 : 9;
  const timer = aggressive ? 75 : 120;
  if (!S.armySent && (army.length >= threshold || elapsed > timer)) {
    S.armySent = true;
    assault(army);
  } else if (S.armySent && elapsed % 45 < 1) {
    assault(army); // periodic re-attack with rebuilt forces
  }
}

function assault(army) {
  const foes = enemyEnts().filter((e) => isB(e.k));
  const tgt = foes[0] ?? enemyEnts()[0];
  if (!tgt || !army.length) return;
  const ids = army.map((e) => e.id);
  console.log(`[${name}] ASSAULT ${ids.length} units -> (${tgt.x},${tgt.y})`);
  send({ t: "order", ids, kind: "amove", x: tgt.x, y: tgt.y });
}

setInterval(() => {
  if (S.slot < 0) return;
  const mine = myEnts();
  const sum = {};
  for (const e of mine) sum[e.k] = (sum[e.k] ?? 0) + 1;
  console.log(
    `[${name}] t=${S.tick} cr=${S.me?.credits} pw=${(S.me?.pwrHave ?? 0) - (S.me?.pwrUse ?? 0)} ents=${JSON.stringify(sum)} foes=${enemyEnts().length} denies=${S.denies.length}${S.denies.length ? " (" + S.denies.slice(-2).join(";") + ")" : ""}`,
  );
}, 8000);
