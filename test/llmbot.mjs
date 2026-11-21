#!/usr/bin/env node
// LLM-driven Open Alert opponent. Plays a REAL networked game over WebSocket:
// joins a room, and every ~3s asks a local LLM proxy for a JSON action plan,
// validates it like the gym does, and sends the commands as C2S messages.
//
//   node test/llmbot.mjs <room> [name]
//   OA_WS=ws://localhost:8787 OA_LLM_MODEL=gpt-6.2-sol OA_LLM_MS=3000 node test/llmbot.mjs llmtest LLMGuy
//
// LLM endpoint: POST $OA_LLM_URL (default http://127.0.0.1:8317/v1/chat/completions)
// with `Authorization: Bearer <token>` — token = stdout of
// ~/.local/libexec/codex2-cliproxy-token (run once, cached), or $OA_LLM_TOKEN.

import { BUILDINGS, UNITS, MAP_W, MAP_H } from "../src/shared/gamedefs.ts";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const room = process.argv[2];
const name = process.argv[3] ?? "LLMGuy";
if (!room) {
  console.log("usage: node test/llmbot.mjs <room> [name]");
  process.exit(1);
}
const base = process.env.OA_WS ?? "ws://localhost:8787";
const MODEL = process.env.OA_LLM_MODEL ?? "gpt-6.2-sol";
const LLM_URL = process.env.OA_LLM_URL ?? "http://127.0.0.1:8317/v1/chat/completions";
const THINK_MS = Math.max(1500, Number(process.env.OA_LLM_MS) || 3000);
const url = `${base}/parties/game-room/${room}`;

const B = Object.keys(BUILDINGS);
const U = Object.keys(UNITS);
const isB = (k) => k in BUILDINGS;
const idx = (x, y) => y * MAP_W + x;
const ORDER_KINDS = new Set(["move", "amove", "attack", "harvest"]);

// ---------- LLM auth ----------
function getToken() {
  if (process.env.OA_LLM_TOKEN) return process.env.OA_LLM_TOKEN;
  try {
    return execFileSync(join(homedir(), ".local/libexec/codex2-cliproxy-token"), {
      encoding: "utf8",
      timeout: 15000,
    }).trim();
  } catch (e) {
    console.log(`[${name}] token helper failed: ${e.message}`);
    return null;
  }
}
const TOKEN = getToken();
if (!TOKEN) console.log(`[${name}] WARNING: no LLM token — will keep retrying each cycle`);

// ---------- game state ----------
const S = {
  slot: -1,
  you: "",
  host: false,
  readied: false,
  sentStart: false,
  players: [],
  ore: new Set(), // live ore tile set (idx); depleted removed via events
  ents: new Map(),
  me: null,
  tick: 0,
  denies: [],
  lastDeny: null,
  ended: false,
};

const ws = new WebSocket(url);
const send = (m) => ws.send(JSON.stringify(m));
ws.onopen = () => {
  console.log(`[${name}] connected ${url}`);
  send({ t: "join", name, token: "llm-" + name });
};
ws.onerror = (e) => console.log(`[${name}] ws error`, e.message ?? "");
ws.onclose = (e) => {
  console.log(`[${name}] closed ${e.code} ${e.reason}`);
  process.exit(0);
};

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.t === "lobby") {
    S.players = m.players;
    const me = m.players.find((p) => p.id === m.you);
    S.host = !!me?.host;
    if (!S.readied) {
      S.readied = true;
      send({ t: "ready", ready: true });
    }
    // if we are host (joined first), start once a second real player arrives
    if (S.host && !S.sentStart && m.players.filter((p) => !p.spectator).length >= 2) {
      S.sentStart = true;
      setTimeout(() => send({ t: "start" }), 300);
    }
  } else if (m.t === "init") {
    S.slot = m.slot;
    S.you = m.you;
    for (const [x, y, a] of m.ore) if (a > 0) S.ore.add(idx(x, y));
    console.log(`[${name}] init slot=${S.slot} ore=${S.ore.size} players=${m.players.map((p) => `${p.slot}:${p.name}`).join(",")}`);
  } else if (m.t === "snap") {
    S.tick = m.tick;
    for (const e of m.ents) S.ents.set(e.id, e);
    const live = new Set(m.ents.map((e) => e.id));
    for (const id of [...S.ents.keys()]) if (!live.has(id)) S.ents.delete(id);
    for (const e of m.events) {
      if (e.e === "ore") for (const [x, y, a] of e.cells) a <= 0 ? S.ore.delete(idx(x, y)) : S.ore.add(idx(x, y));
      if (e.e === "elim") console.log(`[${name}] elim slot ${e.slot}`);
    }
    S.me = m.players[S.slot] ?? null;
  } else if (m.t === "end") {
    S.ended = true;
    console.log(`[${name}] END winner=${m.winner} (${m.reason}) ${m.winner === S.slot ? "— we won" : ""}`);
    process.exit(m.winner === S.slot ? 0 : 2);
  } else if (m.t === "deny") {
    S.denies.push(m.msg);
    S.lastDeny = m.msg;
  }
};

// ---------- client-side placement replica (same rules as world.canPlace) ----------
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
    const gapY = Math.max(by - (ty + d.h), ty - (by + bd.h));
    if (Math.max(gapX, gapY) <= 2) return true;
  }
  return false;
}
function findSpot(kind) {
  const occ = footprints();
  const d = BUILDINGS[kind];
  for (const b of S.ents.values()) {
    if (b.o !== S.slot || !isB(b.k)) continue;
    const bd = BUILDINGS[b.k];
    const bx = Math.round(b.x - bd.w / 2),
      by = Math.round(b.y - bd.h / 2);
    for (let r = 1; r <= 4; r++)
      for (let y = by - r - d.h + 1; y < by + bd.h + r; y++)
        for (let x = bx - r - d.w + 1; x < bx + bd.w + r; x++) if (canPlace(kind, x, y, occ)) return { tx: x, ty: y };
  }
  return null;
}

// ---------- compact observation for the LLM ----------
const tl = (e) => {
  const d = BUILDINGS[e.k];
  return [Math.round(e.x - d.w / 2), Math.round(e.y - d.h / 2)];
};
function myEnts() {
  return [...S.ents.values()].filter((e) => e.o === S.slot);
}
function enemyEnts() {
  return [...S.ents.values()].filter((e) => e.o >= 0 && e.o !== S.slot);
}

function buildObs() {
  const me = S.me;
  const mine = myEnts();
  const foes = enemyEnts();
  const myB = mine.filter((e) => isB(e.k));
  const units = {};
  for (const e of mine)
    if (!isB(e.k)) (units[e.k] ??= []).push([e.id, Math.round(e.x), Math.round(e.y)]);
  const foeB = foes.filter((e) => isB(e.k)).map((e) => ({ id: e.id, k: e.k, tl: tl(e), hp: e.hp }));
  const foeU = foes
    .filter((e) => !isB(e.k))
    .slice(0, 25)
    .map((e) => [e.id, e.k, Math.round(e.x), Math.round(e.y)]);

  // nearest ore to our conyard for harvest orders
  const cy = myB.find((e) => e.k === "conyard") ?? myB[0];
  const oreNear = [];
  if (cy) {
    for (const i of S.ore) {
      const x = i % MAP_W,
        y = (i / MAP_W) | 0;
      oreNear.push([Math.hypot(x - cy.x, y - cy.y), x, y]);
    }
    oreNear.sort((a, b) => a[0] - b[0]);
  }

  const obs = {
    tick: S.tick,
    credits: me.credits,
    power: `${me.pwrHave - me.pwrUse}${me.lowPower ? " LOW" : ""}`,
    awaiting: me.awaiting,
    building: me.bq ? `${me.bq.kind} ${Math.round(me.bq.left)}/${me.bq.total}` : null,
    queues: Object.fromEntries(Object.entries(me.queues ?? {}).map(([k, q]) => [k, `${q.unit}x${q.count}`])),
    myBldgs: myB.map((e) => ({ k: e.k, tl: tl(e), hp: e.hp })),
    myUnits: units, // {kind: [[id,x,y],...]}
    foeBldgs: foeB,
    foeUnits: foeU,
    oreNear: oreNear.slice(0, 8).map(([, x, y]) => [x, y]),
    hint: {},
  };
  const want = me.awaiting ?? nextBuild(me, myB);
  if (want) {
    const spot = findSpot(want);
    if (spot) obs.hint.place = { kind: want, ...spot };
  }
  const army = (units.infantry?.length ?? 0) + (units.tank?.length ?? 0);
  const foeCy = foeB.find((e) => e.k === "conyard") ?? foeB[0];
  if (army >= 6 && foeCy) obs.hint.attackNow = { at: foeCy.tl, target: foeCy.id };
  if (S.lastDeny) obs.hint.lastDeny = S.lastDeny;
  return obs;
}

function nextBuild(me, myB) {
  const has = (k) => myB.some((e) => e.k === k);
  if (!has("power")) return "power";
  if (!has("refinery")) return "refinery";
  if (!has("barracks")) return "barracks";
  if (!has("factory")) return "factory";
  if (me.lowPower) return "power";
  if (!has("turret")) return "turret";
  return null;
}

// ---------- LLM ----------
const SYS = `You are playing an RA2-style RTS on a 64x64 tile map. Reply ONLY with a JSON object of actions.
Action vocabulary (every key may be null or omitted):
{"build":"power|refinery|barracks|radar|factory|turret|arc|depot|techlab|purifier"|null,
 "place":{"tx":n,"ty":n}|null,
 "train":"infantry|engineer|rocket|tank|arty|heavy|spider|harvester"|null,
 "upgrade":<your factory ent id>|null,
 "order":{"ids":[int,...],"kind":"move|amove|attack|harvest","x":n,"y":n,"target":id|null},
 "stop":[ids]|null,
 "notes":"short"}
Rules: conyard is prebuilt. Costs: power 300, refinery 600, barracks 500, radar 700 (needs barracks), factory 1000, turret 500, arc 800 (needs radar), depot 800 (needs factory), techlab 1800 (needs radar+factory), purifier 900 (needs techlab); infantry 100, engineer 500 (captures enemy buildings — attack-order them), rocket 300 (needs radar), tank 700, arty 1100 (needs radar), heavy 1100 + spider 500 (need factory MKII), harvester 1400 (needs factory+refinery). "upgrade" turns a factory into MKII for $1500 once you have a techlab — unlocks heavy/spider. Recommended order: power, refinery, barracks, factory, radar, extra power when power LOW, turret for defense, techlab then upgrade for heavies.
"build" starts construction; when the obs shows "awaiting" you MUST "place" it: tx,ty is the footprint TOP-LEFT, must be within 2 tiles of your buildings on tiles free of ore and buildings — use hint.place when provided.
Refinery placement spawns a free harvester; harvesters auto-mine nearby ore (send kind "harvest" to oreNear tiles only to redirect).
Combat: group your combat units (myUnits.infantry + myUnits.tank ids) and send ONE "amove" order at an enemy building (foeBldgs tl coords, prefer conyard) when you have 6+; use kind "attack" with target=<enemy ent id> to focus-fire. Retreat badly hurt armies home.
Economy: keep 3-5 units queued while credits allow, protect harvesters.
Respond with the JSON object only — no prose, no markdown fences.`;

let inFlight = false;
async function think() {
  if (S.slot < 0 || !S.me || S.ended || inFlight) return;
  if (S.me.eliminated) return;
  inFlight = true;
  const t0 = Date.now();
  try {
    const obs = buildObs();
    const body = {
      model: MODEL,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `Game state:\n${JSON.stringify(obs)}` },
      ],
      temperature: 0.2,
    };
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000), // reasoning models can take 10-30s
    });
    if (!res.ok) {
      console.log(`[${name}] LLM http ${res.status} ${(await res.text()).slice(0, 120)}`);
      return;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    const plan = parsePlan(text);
    if (!plan) {
      console.log(`[${name}] LLM unparseable (${Date.now() - t0}ms): ${text.slice(0, 140).replace(/\n/g, " ")}`);
      return;
    }
    const sent = applyPlan(plan);
    const ms = Date.now() - t0;
    console.log(
      `[${name}] t=${S.tick} LLM(${ms}ms): ${sent.length ? sent.join(" | ") : "(no-op)"}${plan.notes ? " notes=" + JSON.stringify(plan.notes).slice(0, 110) : ""}`,
    );
  } catch (e) {
    console.log(`[${name}] LLM call failed: ${e.message}`);
  } finally {
    inFlight = false;
  }
}

/** Extract the first balanced {...} from model output (fences/prose tolerant). */
function parsePlan(text) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          const o = JSON.parse(s.slice(start, i + 1));
          return o && typeof o === "object" && !Array.isArray(o) ? o : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---------- plan validation + dispatch (same rules as the gym / worker) ----------
const num = (v) => typeof v === "number" && Number.isFinite(v);
const hasOwn = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);

/** ids filtered to own mobile units (never buildings) */
function ownMobileIds(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const id of v) {
    if (!num(id)) continue;
    const e = S.ents.get(id);
    if (e && e.o === S.slot && !isB(e.k)) out.push(id);
  }
  return out;
}

function applyPlan(raw) {
  // normalize: some models wrap actions as {"actions":[{"type":"build","kind":"power"},...]}
  const p = { ...raw };
  if (Array.isArray(p.actions)) {
    for (const a of p.actions) {
      if (!a || typeof a !== "object") continue;
      const t = a.type ?? a.t;
      if (t === "build" && p.build == null) p.build = a.kind ?? a.build;
      else if (t === "place" && p.place == null) p.place = { tx: a.tx, ty: a.ty };
      else if ((t === "train" || t === "unit") && p.train == null) p.train = a.unit ?? a.train;
      else if (t === "order" && p.order == null) p.order = { ids: a.ids, kind: a.kind, x: a.x, y: a.y, target: a.target };
      else if (t === "stop" && p.stop == null) p.stop = a.ids;
    }
    delete p.actions;
  }
  const sent = [];
  if (p.build != null) {
    if (hasOwn(BUILDINGS, p.build)) {
      send({ t: "build", kind: p.build });
      sent.push(`build ${p.build}`);
    } else sent.push(`!bad-build ${JSON.stringify(p.build)}`);
  }
  if (p.place != null) {
    const pl = p.place;
    if (pl && typeof pl === "object" && num(pl.tx) && num(pl.ty)) {
      send({ t: "place", tx: Math.floor(pl.tx), ty: Math.floor(pl.ty) });
      sent.push(`place ${pl.tx | 0},${pl.ty | 0}`);
    } else sent.push("!bad-place");
  }
  if (p.train != null) {
    if (hasOwn(UNITS, p.train)) {
      send({ t: "train", unit: p.train });
      sent.push(`train ${p.train}`);
    } else sent.push(`!bad-train ${JSON.stringify(p.train)}`);
  }
  if (p.upgrade != null && num(p.upgrade)) {
    const e = S.ents.get(p.upgrade);
    if (e && e.o === S.slot) {
      send({ t: "upgrade", id: p.upgrade });
      sent.push(`upgrade ${p.upgrade}`);
    } else sent.push(`!bad-upgrade ${p.upgrade}`);
  }
  if (p.order != null) {
    const o = p.order;
    if (o && typeof o === "object" && typeof o.kind === "string" && ORDER_KINDS.has(o.kind) && num(o.x) && num(o.y)) {
      const ids = ownMobileIds(o.ids);
      if (ids.length) {
        let kind = o.kind,
          target;
        if (kind === "attack") {
          const tgt = num(o.target) ? S.ents.get(o.target) : null;
          if (tgt && tgt.o >= 0 && tgt.o !== S.slot) target = tgt.id;
          else kind = "amove"; // bad/absent target: degrade to attack-move at coords
        }
        if (kind === "harvest") for (const id of [...ids]) if (S.ents.get(id)?.k !== "harvester") ids.splice(ids.indexOf(id), 1);
        if (ids.length) {
          const msg = { t: "order", ids, kind, x: o.x, y: o.y };
          if (target != null) msg.target = target;
          send(msg);
          sent.push(`order ${kind} ${ids.length}u -> ${o.x},${o.y}${target != null ? " #" + target : ""}`);
        } else sent.push("!order-ids-empty");
      } else sent.push("!order-ids-not-mine");
    } else sent.push(`!bad-order ${o?.kind ?? ""}`);
  }
  if (p.stop != null) {
    const ids = ownMobileIds(p.stop);
    if (ids.length) {
      send({ t: "stop", ids });
      sent.push(`stop ${ids.length}u`);
    }
  }
  return sent;
}

setInterval(think, THINK_MS);

// periodic status line
setInterval(() => {
  if (S.slot < 0 || !S.me) return;
  const mine = myEnts();
  const sum = {};
  for (const e of mine) sum[e.k] = (sum[e.k] ?? 0) + 1;
  console.log(
    `[${name}] t=${S.tick} cr=${S.me.credits} pw=${S.me.pwrHave - S.me.pwrUse} ents=${JSON.stringify(sum)} foes=${enemyEnts().length} denies=${S.denies.length}${S.denies.length ? " last=" + S.lastDeny : ""}`,
  );
}, 12000);

console.log(`[${name}] LLM bot — model=${MODEL} think=${THINK_MS}ms room=${room}`);
