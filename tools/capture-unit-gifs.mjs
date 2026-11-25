#!/usr/bin/env node
/**
 * Capture real Open Alert gameplay GIFs for the units encyclopedia.
 *
 * This is intentionally a reusable harness, not a one-off collection of browser
 * macros. It creates disposable multiplayer rooms, drives both commanders over
 * the real v2 WebSocket protocol, builds the real tech tree, trains real units,
 * records the real Babylon.js client with Chrome MediaRecorder, and encodes the
 * result with ffmpeg's two-pass GIF palette pipeline.
 *
 * Usage:
 *   node tools/capture-unit-gifs.mjs                 # capture missing GIFs
 *   node tools/capture-unit-gifs.mjs --force         # recapture everything
 *   node tools/capture-unit-gifs.mjs --units=tank,himars
 *   node tools/capture-unit-gifs.mjs --sessions=armor,air --jobs=2
 *
 * Environment:
 *   OA_HTTP=http://localhost:8787  game server base URL
 *   OA_CHROME=/usr/bin/google-chrome
 */

import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { wsconn, send, lastSnap, sleep } from "../test/wsconn.mjs";

// Importing wsconn installs the repo's TypeScript transpile hook as a side effect.
const gd = await import("../src/shared/gamedefs.ts");
const { UNITS, TRAIN_ORDER, getMapLayout, getSpawns } = gd;

const HTTP = (process.env.OA_HTTP || "http://localhost:8787").replace(/\/+$/, "");
const WS = HTTP.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
const CHROME = process.env.OA_CHROME || "/usr/bin/google-chrome";
const OUT_DIR = "src/client/public/units";
const TMP_DIR = ".tmp/unit-capture";
const REPORT = join(TMP_DIR, "capture-report.json");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const optVal = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? null;
const unitsFilter = optVal("units")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const sessionsFilter = optVal("sessions")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const JOBS = Math.max(1, Math.min(5, Number(optVal("jobs") || 3)));

const VW = 900;
const VH = 650;
const CROP_W = 640;
const CROP_H = 400;
const GIF_W = 560;
const MAX_GIF_BYTES = 600 * 1024;

const fmtBytes = (n) => `${(n / 1024).toFixed(0)}KB`;
const nowId = () => Date.now().toString(36).slice(-6);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function assertTool(name) {
  try {
    execFileSync(name, ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error(`${name} is required but was not found in PATH`);
  }
}
assertTool("ffmpeg");

function snapOf(h, side) {
  return lastSnap(h.conns[side]);
}
function meOf(h, side) {
  const s = snapOf(h, side);
  return s?.players?.[h.conns[side].slot];
}
function entsOf(h, side = "a") {
  return snapOf(h, side)?.ents ?? [];
}
function entList(h, side = "a") {
  return entsOf(h, side).map((e) => ({ ...e, id: Number(e.id) }));
}
function getEnt(h, id, side = "a") {
  return entsOf(h, side).find((e) => Number(e.id) === Number(id)) ?? null;
}
function isBuildingKind(k) {
  return Object.prototype.hasOwnProperty.call(gd.BUILDINGS, k);
}
async function waitFor(fn, timeoutMs, label, pollMs = 180) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      // keep polling — snapshots arrive asynchronously
    }
    await sleep(pollMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function mcpCall(room, tool, toolArgs) {
  const res = await fetch(`${HTTP}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e9),
      method: "tools/call",
      params: { name: tool, arguments: { room, ...toolArgs } },
    }),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status} for ${tool}`);
  const rpc = await res.json();
  if (rpc.error) throw new Error(`MCP ${tool}: ${rpc.error.message}`);
  const text = rpc.result?.content?.[0]?.text;
  if (!text) throw new Error(`MCP ${tool}: empty result`);
  const data = JSON.parse(text);
  if (data.ok === false) throw new Error(`MCP ${tool}: ${data.error || "failed"}`);
  return data;
}

async function openHarness(session) {
  const suffix = Math.random().toString(36).slice(2, 6);
  const room = `ug${nowId()}${suffix}`.slice(0, 30);
  const url = `${WS}/parties/game-room/${room}`;
  const tokenA = `cap-a-${suffix}`;
  const tokenB = `cap-b-${suffix}`;
  const a = wsconn(url, "CaptureA", tokenA);
  const b = wsconn(url, "CaptureB", tokenB);
  const inLobby = (st, token) => {
    for (let i = st.msgs.length - 1; i >= 0; i--) {
      const m = st.msgs[i];
      if (m.t === "lobby") return m.players?.some((p) => p.id === token && p.slot >= 0) ?? false;
    }
    return false;
  };
  await waitFor(() => inLobby(a, tokenA) && inLobby(b, tokenB), 30000, "both harness players to join lobby");
  send(a, { t: "setMap", map: session.map });
  send(a, {
    t: "setConfig",
    config: {
      startCredits: 20000, // VALID_CREDITS caps at 20000 — higher values are silently rejected and the room falls back to default funds
      gameSpeed: 2,
      superweapons: true,
      crates: false,
      derricks: session.derricks === true,
      fog: false,
      logistics: false,
    },
  });
  await sleep(180);
  send(a, { t: "ready", ready: true });
  send(b, { t: "ready", ready: true });
  await sleep(120);
  // The host can legitimately race the second player's ready broadcast when several
  // harness rooms are created in parallel. Retry START instead of treating the first
  // "not ready" deny as fatal.
  const startDeadline = Date.now() + 24000;
  while (Date.now() < startDeadline) {
    send(a, { t: "start" });
    await sleep(550);
    if (a.slot !== null && b.slot !== null) break;
  }
  await waitFor(() => a.slot !== null && b.slot !== null, 20000, "match init slots");
  await waitFor(() => (snapOf({ conns: { a, b } }, "a")?.ents?.length ?? 0) > 0, 25000, "first world snapshot");
  return { session, room, tokenA, tokenB, conns: { a, b }, browser: null, page: null, pageErrors: [] };
}

function ownedUnits(h, side, kind = null) {
  const slot = h.conns[side].slot;
  // Match on the entity's REAL kind: a disguised spy serializes as k:"infantry"
  // with disg:"spy" for every viewer including its owner, so naive k-matching
  // never finds a spy in the field (and mis-files it as infantry).
  return entList(h, side).filter((e) => e.o === slot && !isBuildingKind(e.k) && (!kind || (e.disg ?? e.k) === kind));
}
function ownedBuildings(h, side, kind = null) {
  const slot = h.conns[side].slot;
  return entList(h, side).filter((e) => e.o === slot && isBuildingKind(e.k) && (!kind || e.k === kind));
}

async function buildOne(h, side, kind) {
  const token = side === "a" ? h.tokenA : h.tokenB;
  const already = ownedBuildings(h, side, kind)[0];
  if (already) return already;
  const data = await mcpCall(h.room, "build_structure", { token, kind });
  if (!data.ok) throw new Error(`build ${kind}: ${data.error}`);
  await waitFor(() => meOf(h, side)?.awaiting?.includes(kind), 45000, `${kind} ready to place`);
  await mcpCall(h.room, "place_structure", { token, cat: "structure" });
  return waitFor(() => ownedBuildings(h, side, kind)[0], 12000, `${kind} placed`);
}

async function upgradeFirst(h, side, fromKind, toKind) {
  const token = side === "a" ? h.tokenA : h.tokenB;
  const bld = ownedBuildings(h, side, fromKind)[0];
  if (!bld) throw new Error(`cannot upgrade missing ${fromKind}`);
  await mcpCall(h.room, "special_action", { token, action: "upgrade", id: bld.id });
  return waitFor(() => ownedBuildings(h, side, toKind)[0], 10000, `${fromKind} upgrade`);
}

async function buildTech(h, side, tech) {
  for (const kind of tech.buildings) await buildOne(h, side, kind);
  for (const [from, to] of tech.upgrades ?? []) await upgradeFirst(h, side, from, to);
}

async function train(h, side, unit, count = 1) {
  const token = side === "a" ? h.tokenA : h.tokenB;
  return mcpCall(h.room, "train_unit", { token, unit, count });
}

// ---------- base-defense capture machinery ----------
//
// The unit pipeline trains a mobile star and walks it into fodder. Defenses
// invert that choreography: the star is a static building placed through the
// real build/place flow, and the fodder must come to IT. Every turret in the
// defense line can engage aircraft (turret/arc/lasertower/satlink hit ground
// too), so a single unarmed fodder type — the Jammer Drone — covers the whole
// lineup. It never shoots back, so the star always survives its own close-up.

// Capture order doubles as defense-queue order: awaitingDef is FIFO, so the
// kinds must come off the queue in exactly the order they are filmed. satlink
// goes first because it is a STRUCTURE-queue hybrid that the thaad tech chain
// requires at queue time only — it is sold immediately after its own close-up.
const DEFENSE_CAPTURE_ORDER = ["satlink", "turret", "arc", "lasertower", "sam", "irondome", "thaad"];
const DEFENSE_CAM = {
  satlink: { height: 12.5, dur: 4000 },
  turret: { height: 10, dur: 3800 },
  arc: { height: 10.5, dur: 3800 },
  lasertower: { height: 11.5, dur: 3800 },
  sam: { height: 12, dur: 3800 },
  irondome: { height: 11.5, dur: 3800 },
  thaad: { height: 13, dur: 4200 },
};

// buildOne early-returns when one of the kind is already owned, which makes it
// useless for power plants — the defense line is power-hungry and the session
// needs several of them before the tech tree even starts.
async function buildCounted(h, side, kind, count) {
  const token = side === "a" ? h.tokenA : h.tokenB;
  for (let i = ownedBuildings(h, side, kind).length; i < count; i++) {
    const data = await mcpCall(h.room, "build_structure", { token, kind });
    if (!data.ok) throw new Error(`build ${kind} #${i + 1}: ${data.error}`);
    await waitFor(() => meOf(h, side)?.awaiting?.includes(kind), 90000, `${kind} #${i + 1} ready to place`);
    await mcpCall(h.room, "place_structure", { token, cat: "structure" });
    await waitFor(() => ownedBuildings(h, side, kind).length > i, 15000, `${kind} #${i + 1} placed`);
  }
}

// Place a finished building at explicit coordinates near (cx, cy). The game
// rules only allow construction chained within 2 tiles of the existing base,
// so the exact ideal tile is often illegal — spiral outward trying candidates
// and let the server's own canPlace validation decide. Failed attempts cost
// one cheap HTTP call and do not consume the awaiting entry.
async function placeNear(h, side, kind, cx, cy, cat) {
  const token = side === "a" ? h.tokenA : h.tokenB;
  const d = gd.BUILDINGS[kind];
  const bx = Math.round(cx - d.w / 2);
  const by = Math.round(cy - d.h / 2);
  for (let r = 0; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        try {
          const res = await mcpCall(h.room, "place_structure", { token, tx: bx + dx, ty: by + dy, cat });
          if (res.ok) return { tx: bx + dx, ty: by + dy, auto: false };
        } catch {
          // illegal tile — keep spiraling
        }
      }
    }
  }
  // Fallback: let the server pick any legal spot rather than failing the capture.
  const res = await mcpCall(h.room, "place_structure", { token, cat });
  return { tx: res.tx, ty: res.ty, auto: true };
}

// Ray from side A's conyard toward the enemy spawn — the defense line belongs
// on the enemy-ward edge of the base, both because that is where real players
// put it and because fodder then approaches across open ground instead of
// overflying the whole base before the first shot.
function defenseAnchor(h) {
  const layout = getMapLayout(h.session.map);
  const spawns = getSpawns(layout.w, layout.h);
  const home = ownedBuildings(h, "a", "conyard")[0] ?? spawns[h.conns.a.slot];
  const enemy = spawns[h.conns.b.slot];
  const dx = enemy.x - home.x;
  const dy = enemy.y - home.y;
  const len = Math.hypot(dx, dy) || 1;
  return { home, ux: dx / len, uy: dy / len };
}

// Continuous fodder pipeline. The map diagonal is long enough that every
// drone spends most of a minute in transit, so the stream is primed the moment
// the airfield exists and kept saturated to a fixed total budget — waiting for
// the alive-count to dip before training replacements would starve the mid
// session, because replacement travel time dwarfs the time they spend dying.
function startDroneStream(h, getGoal, budget = 34) {
  let stopped = false;
  let trained = 0;
  let lastTrain = 0;
  (async () => {
    while (!stopped) {
      try {
        // Replenish on ALIVE count, not total trained: the population should
        // hold steady at a handful of drones — enough for a lively ring around
        // each defense, few enough that the star is never buried under a
        // dogpile (26+ trained with zero attrition dogpiled the first takes).
        const aliveNow = ownedUnits(h, "b").filter((e) => e.k === "ewdrone" && (e.hp === undefined || e.hp > 0)).length;
        if (trained < budget && aliveNow < 6 && Date.now() - lastTrain > 7000) {
          lastTrain = Date.now();
          const batch = Math.min(2, budget - trained);
          const res = await train(h, "b", "ewdrone", batch).catch(() => null);
          if (res && res.queued) trained += res.queued;
        }
        const goal = getGoal();
        if (goal) {
          const drones = ownedUnits(h, "b").filter((e) => e.k === "ewdrone" && (e.hp === undefined || e.hp > 0));
          for (const e of drones) {
            // Golden-angle jitter keeps the flock spread around the goal instead
            // of stacking on one tile — both better footage and fewer multi-kills.
            const ang = ((e.id * 2.399963) % 6.2832) + 0.35;
            const r = 1.4 + (e.id % 4) * 0.9;
            order(h, "b", [e.id], "move", goal.x + Math.cos(ang) * r, goal.y + Math.sin(ang) * r);
          }
        }
      } catch {}
      await sleep(2200);
    }
  })().catch(() => {});
  return () => {
    stopped = true;
  };
}

async function sellBuilding(h, side, id) {
  const token = side === "a" ? h.tokenA : h.tokenB;
  await mcpCall(h.room, "special_action", { token, action: "sell", id }).catch(() => {});
}

function order(h, side, ids, kind, x, y, target) {
  send(h.conns[side], { t: "order", ids, kind, x, y, ...(target != null ? { target } : {}) });
}
function stop(h, side, ids) {
  send(h.conns[side], { t: "stop", ids });
}

function stageFor(h, actorSide = "a") {
  const layout = getMapLayout(h.session.map);
  const spawns = getSpawns(layout.w, layout.h);
  const a = spawns[h.conns[actorSide].slot];
  const enemySide = actorSide === "a" ? "b" : "a";
  const b = spawns[h.conns[enemySide].slot];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const d = Math.min(17, len * 0.24);
  return {
    x: Math.max(4, Math.min(layout.w - 4, a.x + (dx / len) * d)),
    y: Math.max(4, Math.min(layout.h - 4, a.y + (dy / len) * d)),
  };
}

// Point a few tiles BEHIND a side's spawn, away from the enemy — the parking lot
// for every armed unit that is not the current star. Starting squads (2 tanks +
// 3 infantry per side) auto-fire at anything hostile in range: left at home they
// shred fodder walking to the stage and gun down stars mid-clip. Nothing hostile
// ever comes within weapon range of the park point, so parked units are inert.
function parkPointFor(h, side) {
  const layout = getMapLayout(h.session.map);
  const spawns = getSpawns(layout.w, layout.h);
  const s = spawns[h.conns[side].slot];
  const enemy = spawns[h.conns[side === "a" ? "b" : "a"].slot];
  const dx = enemy.x - s.x;
  const dy = enemy.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: Math.max(2, Math.min(layout.w - 3, s.x - (dx / len) * 6)),
    y: Math.max(2, Math.min(layout.h - 3, s.y - (dy / len) * 6)),
  };
}

function parkStarters(h) {
  const st = stageFor(h, "a");
  for (const side of ["a", "b"]) {
    const ids = ownedUnits(h, side).map((e) => e.id);
    if (!ids.length) continue;
    const pt = parkPointFor(h, side);
    order(h, side, ids, "move", pt.x + (Math.random() * 2 - 1), pt.y + (Math.random() * 2 - 1));
  }
  return st;
}

function nearestTo(list, pos) {
  let best = null;
  let bd = Infinity;
  for (const e of list) {
    const d = Math.hypot(e.x - pos.x, e.y - pos.y);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

// Mirror of the server's canAttack rule for unit-vs-unit engagements: an
// attacker without canHitAir can never engage an air target, and vice versa —
// ordering otherwise produces a chase that never fires, which is exactly how
// the shahed/uav-target pairing deadlocked earlier sessions.
function canHitTarget(attackerKind, targetEnt) {
  const def = UNITS[attackerKind];
  if (!def || def.dmg <= 0 || def.range <= 0) return false;
  const tDef = UNITS[targetEnt.k];
  if (!tDef) return false;
  if (tDef.domain === "air") return def.canHitAir === true;
  return def.canHitGround !== false;
}

const FODDER_KINDS = new Set(["supplytruck", "ewdrone", "gunboat"]);

function chooseTarget(h, opts = {}) {
  // Only purpose-trained fodder kinds are valid targets — side b never trains
  // anything else, so kind-matching cleanly excludes the armed starting squads
  // that killed stars mid-clip in the empty-gif sessions (one infantry ordered
  // onto a starting tank is dead before the recorder even spins up).
  let candidates = ownedUnits(h, "b").filter((e) => FODDER_KINDS.has(e.k) && (e.hp === undefined || e.hp > 0));
  if (opts.attackerKind) candidates = candidates.filter((e) => canHitTarget(opts.attackerKind, e));
  if (opts.targetKind) candidates = candidates.filter((e) => e.k === opts.targetKind);
  if (!candidates.length) return null;
  const origin = opts.origin ?? stageFor(h, "a");
  return nearestTo(candidates, origin);
}

// Cannon-fodder targets per domain. Hard lesson from the empty-clip sessions:
// fodder MUST be unarmed — a single infantry star (90 hp) ordered onto an armed
// target dies before the recorder even spins up, and the camera then films
// empty grass. supplytruck/ewdrone have zero damage output yet enough hp to
// soak a volley, so the star always survives its own close-up. The sea domain
// has no unarmed hull, so gunboat fodder is kept under perpetual move orders —
// units executing a move order never auto-fire (server tickEnt early-returns),
// which makes even an armed hull harmless while it shuffles inside weapon range.
const TARGET_TRAINER = { land: "supplytruck", air: "ewdrone", sea: "gunboat" };

function targetDomainFor(unit) {
  if (unit === "interceptor") return "air";
  if (UNITS[unit].domain === "sea") return "sea";
  return "land";
}

function nearestWaterTile(h, x, y) {
  const layout = getMapLayout(h.session.map);
  let best = null;
  let bd = Infinity;
  for (const [wx, wy] of layout.water) {
    const d = Math.hypot(wx + 0.5 - x, wy + 0.5 - y);
    if (d < bd) {
      bd = d;
      best = { x: wx + 0.5, y: wy + 0.5 };
    }
  }
  return best;
}

// Where replacement targets should congregate: land/air at the usual stage
// point, sea at open water between the two shipyards (a land coordinate would
// beach the fleet — ships literally cannot path there).
function steerPoint(h, domain) {
  if (domain === "sea") {
    const aShip = ownedBuildings(h, "a", "shipyard2")[0] ?? ownedBuildings(h, "a", "shipyard")[0];
    const bShip = ownedBuildings(h, "b", "shipyard2")[0] ?? ownedBuildings(h, "b", "shipyard")[0];
    if (aShip && bShip) {
      const mid = { x: (aShip.x + bShip.x) / 2, y: (aShip.y + bShip.y) / 2 };
      return nearestWaterTile(h, mid.x, mid.y) ?? mid;
    }
    return nearestWaterTile(h, 48, 48) ?? stageFor(h, "a");
  }
  return stageFor(h, "a");
}

// Keep a minimum flock of attackable enemy units in play. Targets get shredded
// in droves because every prior attacker keeps auto-firing after its own clip
// ends — that is exactly what starved the railtank capture of targets. Top-ups
// are trained for side b (which now techs alongside side a in every session)
// and steered toward the stage; captures almost never have to wait on them
// because the batch overlaps the previous unit's train+travel time.
async function ensureTargets(h, domain, min = 2) {
  const kind = TARGET_TRAINER[domain];
  if (!kind) return;
  h.seenTargets ??= new Set();
  h.targetJobs ??= {};
  // Dedupe concurrent top-ups for the same domain — the warmup at session start
  // and the just-in-time call inside the first capture often overlap.
  if (h.targetJobs[domain]) {
    try {
      await h.targetJobs[domain];
    } catch {}
  }
  // Count only the domain's fodder kind — the starting squads share domains but
  // are armed and parked far away, and must neither satisfy the quota nor get
  // steered back into the action.
  const alive = () => ownedUnits(h, "b").filter((e) => e.k === kind && (e.hp === undefined || e.hp > 0));
  if (alive().length >= min) return;
  const job = (async () => {
    const batch = Math.max(2, min + 2 - alive().length);
    for (let i = 0; i < batch; i++) {
      const res = await train(h, "b", kind, 1).catch(() => null);
      if (!res) break;
    }
    const pt = steerPoint(h, domain);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      for (const e of alive()) {
        if (h.seenTargets.has(e.id)) continue;
        h.seenTargets.add(e.id);
        order(h, "b", [e.id], "move", pt.x + (Math.random() * 6 - 3), pt.y + (Math.random() * 6 - 3));
      }
      if (alive().length >= min) return;
      await sleep(550);
    }
    // Not fatal: the engagement wait re-issues orders and has its own timeout.
  })();
  h.targetJobs[domain] = job;
  try {
    await job;
  } finally {
    delete h.targetJobs[domain];
  }
}

// Sea fodder is armed (no unarmed hull exists in the roster), so it must never
// go idle: a unit executing a move order never auto-fires — the server's mover
// early-returns before the combat scan. Shuffling gunboats inside a tight
// radius around the water stage keeps them harmless yet constantly inside any
// attacker's weapon range, so even a slow dreadnought never has to chase.
function startSeaShuffle(h) {
  let stopped = false;
  let flip = false;
  (async () => {
    while (!stopped) {
      flip = !flip;
      try {
        const pt = steerPoint(h, "sea");
        const boats = ownedUnits(h, "b").filter((e) => e.k === "gunboat" && (e.hp === undefined || e.hp > 0));
        boats.forEach((e, i) => {
          const dx = ((i % 3) - 1) * 2.1 + (flip ? 1.5 : -1.5);
          const dy = (((i / 3) | 0) % 3 - 1) * 2.1 + (flip ? -1.5 : 1.5);
          order(h, "b", [e.id], "move", pt.x + dx, pt.y + dy);
        });
      } catch {}
      await sleep(2100);
    }
  })().catch(() => {});
  return () => {
    stopped = true;
  };
}

async function waitSpawned(h, side, kind, seen, timeoutMs = 95000) {
  return waitFor(
    () => ownedUnits(h, side, kind).filter((e) => !seen.has(e.id)).sort((x, y) => x.id - y.id)[0] ?? null,
    timeoutMs,
    `${kind} to finish training`,
    220,
  );
}

async function ensureBrowser(h) {
  if (h.page) return h.page;
  h.browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-sandbox",
      "--enable-unsafe-swiftshader",
      "--autoplay-policy=no-user-gesture-required",
      `--window-size=${VW},${VH}`,
    ],
    defaultViewport: { width: VW, height: VH },
  });
  const page = await h.browser.newPage();
  page.on("pageerror", (e) => h.pageErrors.push(`${h.room}: ${e.message}`));
  // Bloom is a per-session decision: mobile-unit clips are mostly tracer fire
  // at mid camera, where bloom reads as sparkle. Defense close-ups are muzzle
  // flashes and kill explosions at point blank, and bloom inflates every flash
  // into a frame-eating white blob (observed: the vulcan close-up hid behind
  // its own bloom halo for the entire clip).
  const bloom = h.session.id === "defenses" ? false : true;
  await page.evaluateOnNewDocument((bloomOn) => {
    try {
      localStorage.setItem("oa-wasd", "0");
      localStorage.setItem("oa-mute", "1");
      // Pin quality: no dynamic resolution scaling and no auto tier drops — the
      // capture crop region and the sharpness of the gif both depend on a stable
      // canvas backing size, which a loaded swiftshader box otherwise shrinks
      // mid-clip (observed 900x650 collapsing to 585x422).
      localStorage.setItem(
        "oa-gfx-v1",
        JSON.stringify({ preset: "medium", raytracing: false, contactShadows: true, bloom: bloomOn, dynamicRes: false, autoQuality: false }),
      );
    } catch {}
  }, bloom);
  await page.goto(`${HTTP}/?room=${h.room}&spectate=1&name=UnitCam`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.__oa && window.__oa.phase === "playing", { timeout: 25000 });
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent = "body>*:not(#game){display:none!important} #game{display:block!important;width:100vw!important;height:100vh!important;cursor:none!important}";
    document.head.append(st);
  });
  h.page = page;
  return page;
}

async function setCamera(h, x, y, height = 13) {
  const page = await ensureBrowser(h);
  await page.evaluate(
    ([x, y, height]) => {
      const gs = window.__oa.gs;
      gs.camTarget.x = x;
      gs.camTarget.z = y;
      gs.camHeight = height;
      gs.updateCamera();
    },
    [x, y, height],
  );
}

function ffmpegEncode(webm, out, width = GIF_W, colors = 112, maxDur = 0) {
  const pal = webm.replace(/\.webm$/, `-pal-${width}-${colors}.png`);
  // The canvas backing size is NOT guaranteed: swiftshader on a loaded box can
  // drop the dynamic-resolution scaler well below 900x650 (observed 585x422),
  // and a fixed 640x400 crop then either fails outright or frames the wrong
  // region. Probe the real size and crop the same center fraction instead.
  let iw = VW;
  let ih = VH;
  try {
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", webm]).toString());
    iw = probe.streams?.[0]?.width || VW;
    ih = probe.streams?.[0]?.height || VH;
  } catch {}
  const cw = Math.max(2, Math.floor((iw * (CROP_W / VW)) / 2) * 2);
  const ch = Math.max(2, Math.floor((ih * (CROP_H / VH)) / 2) * 2);
  const crop = `crop=${cw}:${ch}:(iw-${cw})/2:(ih-${ch})/2`;
  const dur = maxDur > 0 ? ["-t", String(maxDur)] : [];
  execFileSync("ffmpeg", ["-hide_banner", "-y", "-v", "error", "-i", webm, ...dur, "-vf", `${crop},fps=12,scale=${width}:-2:flags=lanczos,palettegen=max_colors=${colors}`, pal], { stdio: "pipe" });
  execFileSync(
    "ffmpeg",
    ["-hide_banner", "-y", "-v", "error", "-i", webm, "-i", pal, ...dur, "-lavfi", `${crop},fps=12,scale=${width}:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a`, "-loop", "0", out],
    { stdio: "pipe" },
  );
  rmSync(pal, { force: true });
}

// Size ladder — noisy combat footage (muzzle flashes, explosions, lots of motion)
// blows past the web-delivery budget at full quality, so step down width/palette
// first and only then shave the tail of the clip. Visual quality stays legible
// far longer than raw byte size suggests because GIF delta compression is what
// actually hurts here.
const QUALITY_TIERS = [
  { width: GIF_W, colors: 112, dur: 0, label: "112c/560w" },
  { width: 520, colors: 88, dur: 0, label: "88c/520w" },
  { width: 480, colors: 64, dur: 0, label: "64c/480w" },
  { width: 480, colors: 64, dur: 3.0, label: "64c/480w/3.0s" },
  { width: 420, colors: 48, dur: 2.6, label: "48c/420w/2.6s" },
];

// Position of an entity as seen by the SPECTATOR client itself. The harness
// websocket and the spectator browser are independent streams, and under load
// they can skew by seconds — aiming the spectator's camera with harness-side
// coordinates is exactly how the empty-gif framing happened. The render shows
// what the spectator sees, so the camera must aim with spectator-side data.
async function specPos(page, entId) {
  return page
    .evaluate((id) => {
      const t = window.__oa.renderer?.tracked?.get(id);
      return t ? { x: t.last.x, y: t.last.y } : null;
    }, entId)
    .catch(() => null);
}

async function recordClip(h, kind, entId, durationMs, height = 13, focus = null) {
  const page = await ensureBrowser(h);
  const webm = join(TMP_DIR, `${h.session.id}-${kind}.webm`);
  const out = join(OUT_DIR, `${kind}.gif`);
  const first = getEnt(h, entId);
  // Camera aim: explicit focus point if given (e.g. attacker/target midpoint so
  // the impact zone stays framed even when the attacker keeps closing in),
  // otherwise the unit's own position at record start. When the focus carries a
  // targetId it is a LIVE blend — recomputed from spectator-side positions right
  // here at record start, never frozen minutes-stale harness coordinates.
  let aim = null;
  if (focus && focus.targetId != null) {
    const sp = await specPos(page, entId);
    const tp = await specPos(page, focus.targetId);
    const w = focus.attackerWeight ?? 0.45;
    if (sp && tp) aim = { x: sp.x * w + tp.x * (1 - w), y: sp.y * w + tp.y * (1 - w) };
    else if (sp) aim = { x: sp.x, y: sp.y };
    else if (tp) aim = { x: tp.x, y: tp.y };
  } else if (focus) {
    aim = focus;
  }
  if (!aim) {
    const sp = await specPos(page, entId);
    if (sp) aim = sp;
    else if (first) aim = { x: first.x, y: first.y };
  }
  if (aim) await setCamera(h, aim.x, aim.y, height);
  // Diagnostic frame + telemetry: when a clip comes back empty or wrong, this is
  // what tells camera-pointing mistakes from encoding mistakes — the png shows
  // exactly what the spectator saw the moment recording began.
  const camProbe = await page.evaluate((entId) => {
    const gs = window.__oa.gs;
    const c = document.getElementById("game");
    const st = window.__oa.state;
    const ents = st?.ents ?? [];
    const star = ents.find((e) => Number(e.id) === Number(entId));
    const near = ents.filter((e) => Math.abs(e.x - gs.camTarget.x) < 8 && Math.abs(e.y - gs.camTarget.z) < 8).length;
    return {
      tx: gs.camTarget.x, tz: gs.camTarget.z, h: gs.camHeight, cw: c?.width, ch: c?.height, dpr: window.devicePixelRatio,
      specEnts: ents.length, specStar: star ? `${star.k}@${star.x.toFixed(1)},${star.y.toFixed(1)}` : "none", specNear: near,
      tick: st?.tick, phase: window.__oa.phase,
    };
  }, entId);
  if (process.env.CAPTURE_DEBUG) {
    await page.screenshot({ path: join(TMP_DIR, `${h.session.id}-${kind}-start.png`) }).catch(() => {});
    console.log(`  [dbg] ${kind}: aim=(${aim?.x?.toFixed(1)},${aim?.y?.toFixed(1)}) ent=${first ? `${first.x.toFixed(1)},${first.y.toFixed(1)}` : "GONE"} cam=${JSON.stringify(camProbe)}`);
  }
  const recPromise = page.evaluate(async (durationMs) => {
    const canvas = document.getElementById("game");
    if (!canvas || !canvas.captureStream) return { error: "canvas.captureStream unavailable" };
    const stream = canvas.captureStream(15);
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return { error: "no supported webm MediaRecorder mime type" };
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1800000 });
    const chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.start(250);
    await new Promise((r) => setTimeout(r, durationMs));
    await new Promise((r) => {
      rec.onstop = r;
      rec.stop();
    });
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: mime });
    return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), size: blob.size, mime };
  }, durationMs);

  // Keep the camera fixed during the clip. This is cinematic enough for short
  // engagement shots and, just as importantly, keeps the background stable so the
  // GIF delta compression stays small enough for web delivery.
  if (process.env.CAPTURE_DEBUG) {
    (async () => {
      for (let s = 0; s < 4; s++) {
        await sleep(1000);
        const star = getEnt(h, entId);
        const spec = await page
          .evaluate((id) => {
            const t = window.__oa.renderer?.tracked?.get(id);
            const arr = window.__oa.renderer?.tracked ? [...window.__oa.renderer.tracked.values()] : [];
            return { x: t ? t.last.x : null, y: t ? t.last.y : null, n: arr.length };
          }, entId)
          .catch(() => null);
        console.log(
          `  [dbg] ${kind} clip+${s + 1}s: harness-star=${star ? `${star.x.toFixed(1)},${star.y.toFixed(1)}` : "DEAD"} spec-star=${spec?.x != null ? `${spec.x.toFixed(1)},${spec.y.toFixed(1)}` : "?"} specEnts=${spec?.n}`,
        );
      }
    })().catch(() => {});
  }
  const rec = await recPromise;
  if (rec.error) throw new Error(rec.error);
  writeFileSync(webm, Buffer.from(rec.bytes));
  let size = 0;
  let quality = "";
  for (const tier of QUALITY_TIERS) {
    ffmpegEncode(webm, out, tier.width, tier.colors, tier.dur);
    size = statSync(out).size;
    quality = tier.label;
    if (size <= MAX_GIF_BYTES) break;
  }
  rmSync(webm, { force: true });
  return { out, size, quality, durationMs };
}

async function closeHarness(h) {
  if (h.browser) await h.browser.close().catch(() => {});
  for (const c of Object.values(h.conns)) {
    try {
      c.ws.close();
    } catch {}
  }
}

function queueDistanceOk(h, ent, target, rangePad = 1.2) {
  if (!ent || !target) return false;
  const def = UNITS[ent.k];
  return dist(ent, target) <= Math.max(2, def.range + rangePad);
}

async function captureCombat(h, unit, opts = {}) {
  const seen = h.seenUnits;
  h.prequeued ??= new Set();
  if (h.prequeued.has(unit)) h.prequeued.delete(unit);
  else await train(h, "a", unit, 1);
  const ent = await waitSpawned(h, "a", unit, seen, opts.trainTimeoutMs ?? 100000);
  seen.add(ent.id);

  // Start the next unit cooking while this one is moving into firing position.
  if (opts.nextUnit && !h.prequeued.has(opts.nextUnit)) {
    h.prequeued.add(opts.nextUnit);
    train(h, "a", opts.nextUnit, 1).catch(() => h.prequeued.delete(opts.nextUnit));
  }

  // Make sure something attackable actually exists before sending the star out —
  // earlier sessions starved here because preceding units slaughtered the whole
  // starting squad while their own clips were still cooling down.
  await ensureTargets(h, targetDomainFor(unit), 2);
  let target = await waitFor(
    () => chooseTarget(h, { targetKind: opts.targetKind, attackerKind: unit, origin: ent }),
    opts.targetWaitMs ?? 65000,
    `target for ${unit}`,
  );
  order(h, "a", [ent.id], "attack", target.x, target.y, target.id);

  // The engagement trigger reads SPECTATOR-side positions: they are what the
  // render shows by definition, so a proximity measured there is a proximity the
  // clip will actually contain. Harness-side positions can skew seconds behind
  // under load — proven by the empty infantry clips where the trigger "fired" at
  // a range the star had never truly reached yet.
  const page = await ensureBrowser(h);
  const specDist = async () => {
    const sp = await specPos(page, ent.id);
    const tp = await specPos(page, target.id);
    return { sp, tp, d: sp && tp ? dist(sp, tp) : null };
  };
  let engTicks = 0;
  const engaged = await waitFor(
    async () => {
      const { sp, tp, d } = await specDist();
      if (process.env.CAPTURE_DEBUG && ++engTicks % 20 === 0) {
        const hb = getEnt(h, ent.id);
        const hbT = target ? getEnt(h, target.id) : null;
        console.log(
          `  [dbg] ${unit} poll: harness-star=${hb ? `${hb.x.toFixed(1)},${hb.y.toFixed(1)} ord=${hb.order?.kind ?? "none"}` : "DEAD"} spec-star=${sp ? `${sp.x.toFixed(1)},${sp.y.toFixed(1)}` : "?"} tgt#${target?.id}=${tp ? `${tp.x.toFixed(1)},${tp.y.toFixed(1)}` : "?"} harness-tgt=${hbT ? `${hbT.x.toFixed(1)},${hbT.y.toFixed(1)} hp=${hbT.hp}` : "DEAD/?"} d=${d == null ? "?" : d.toFixed(1)}`,
        );
      }
      if (!sp || !tp) {
        // target dead or not yet tracked — re-pick and re-order harness-side
        const hbCur = getEnt(h, ent.id);
        const repl = chooseTarget(h, { targetKind: opts.targetKind, attackerKind: unit, origin: hbCur ?? ent });
        if (!repl) return null;
        target = repl;
        if (hbCur) order(h, "a", [ent.id], "attack", repl.x, repl.y, repl.id);
        return null;
      }
      if (d != null && d <= Math.max(2, UNITS[unit].range + (opts.rangePad ?? 2.8))) return { cur: sp, tgt: { ...tp, id: target.id } };
      // Re-issue against a moving/replacement target occasionally.
      if (Math.random() < 0.18) order(h, "a", [ent.id], "attack", tp.x, tp.y, target.id);
      return null;
    },
    opts.engageTimeoutMs ?? 75000,
    `${unit} to engage`,
    240,
  );
  await sleep(opts.preRollMs ?? 240);
  // Frame attacker and target together: the impact zone is the interesting half
  // of the shot. The blend is computed LIVE inside recordClip from spectator-side
  // positions — the harness stream can skew seconds behind what the spectator
  // renders, and frozen trigger-time coordinates are how the empty frames happened.
  if (process.env.CAPTURE_DEBUG) {
    console.log(`  [dbg] ${unit}: trigger cur=(${engaged.cur.x.toFixed(1)},${engaged.cur.y.toFixed(1)}) tgt#${engaged.tgt.id}=${engaged.tgt.k}@${engaged.tgt.hp ?? "?"}hp (${engaged.tgt.x.toFixed(1)},${engaged.tgt.y.toFixed(1)}) d=${dist(engaged.cur, engaged.tgt).toFixed(1)}`);
  }
  const focus = { targetId: engaged.tgt.id, attackerWeight: opts.attackerWeight ?? 0.45 };
  // Small infantry-class units fill too little of the crop at the default
  // height — drop the camera a touch so the star reads as more than a few pixels.
  const smallUnit = ["infantry", "rocket", "spy", "engineer"].includes(unit);
  const defaultHeight = UNITS[unit].domain === "air" ? 14 : smallUnit ? 11.5 : 13;
  const cap = await recordClip(h, unit, ent.id, opts.durationMs ?? 3600, opts.cameraHeight ?? defaultHeight, focus);
  // Pull the star off-stage after its close-up. Left in place it keeps
  // auto-firing through every following train cycle and deprives the remaining
  // units of anything to shoot at — and parked AT the base it would still be in
  // range of fodder passing to the stage, so it goes to the far parking lot
  // with the starting squad.
  const park = parkPointFor(h, "a");
  if (getEnt(h, ent.id)) order(h, "a", [ent.id], "move", park.x, park.y);
  return cap;
}

// The defense-line capture: a single crossroads session films every turret in
// the lineup. Side A builds the full tech tree (power-heavy — powered defenses
// go silent when the grid browns out), places each structure on the enemy-ward
// edge of its base through the real build/place flow, and side B streams
// unarmed Jammer Drones across the map into its range. Each star is sold right
// after its close-up so the next capture never has a second battery firing
// into frame or stealing the fodder.
async function runDefenseFlow(h, session, wanted, result) {
  const st = parkStarters(h);

  // Tech races in parallel on both sides. Side B needs nothing but power,
  // barracks, radar, and an airfield — the entire defense line can engage air,
  // so one unarmed fodder type covers every capture. Side A skips its refinery
  // (nothing in the defense tech chain needs it) but still needs the factory
  // for the tech lab.
  const techA = (async () => {
    await buildCounted(h, "a", "power", 3);
    for (const k of ["barracks", "radar", "factory", "techlab"]) await buildOne(h, "a", k);
  })();
  const techB = (async () => {
    await buildCounted(h, "b", "power", 1);
    for (const k of ["barracks", "radar", "airfield"]) await buildOne(h, "b", k);
  })();

  // Spectator warmup overlaps construction — the first recordClip must not pay
  // the keyframe/mesh-warmup cost inside its own window.
  ensureBrowser(h).catch(() => {});

  const anchor = defenseAnchor(h);
  const anchorPt = { x: anchor.home.x + anchor.ux * 11, y: anchor.home.y + anchor.uy * 11 };
  let goal = { ...anchorPt };
  let stopStream = null;

  await techB;
  // Prime the drone pipeline the moment the airfield exists — transit across
  // the map diagonal dominates the session timeline, never training-time. One
  // batch of five is plenty: the ewdrone models are large, and past a half
  // dozen simultaneous bodies the star disappears under the swarm.
  train(h, "b", "ewdrone", 5).catch(() => {});
  stopStream = startDroneStream(h, () => goal);

  try {
    await techA;

    // The spectator keyframe can lag the page load by a long stretch on a
    // loaded box — recordClip must never open on an empty renderer world.
    const warmPage = await ensureBrowser(h);
    await waitFor(
      () => warmPage.evaluate(() => (window.__oa?.renderer?.tracked?.size ?? 0) > 10).catch(() => false),
      30000,
      "spectator world warmup",
      300,
    );

    // Satlink first: it is the only defense-line star on the STRUCTURE queue,
    // and thaad needs it to exist at queue time (only). Queue everything before
    // selling anything.
    await mcpCall(h.room, "build_structure", { token: h.tokenA, kind: "satlink" });
    await waitFor(() => meOf(h, "a")?.awaiting?.includes("satlink"), 150000, "satlink construction");
    await placeNear(h, "a", "satlink", anchorPt.x, anchorPt.y, "structure");
    const satEnt = await waitFor(() => ownedBuildings(h, "a", "satlink")[0], 10000, "satlink placed");
    goal = { x: satEnt.x, y: satEnt.y };

    // Queue every wanted defense in capture order. Requires-checks happen only
    // at queue time, so the satlink sale afterwards cannot cancel anything.
    const queueOrder = DEFENSE_CAPTURE_ORDER.filter((k) => k !== "satlink" && wanted.includes(k));
    for (const k of queueOrder) {
      try {
        await mcpCall(h.room, "build_structure", { token: h.tokenA, kind: k });
      } catch (err) {
        console.log(`  [def] queue ${k} failed: ${err?.message || err}`);
      }
    }
    // Partial runs that skip the satlink card must still not leave it standing:
    // its 15-range beam would steal the fodder stream from every other star.
    if (!wanted.includes("satlink")) await sellBuilding(h, "a", satEnt.id);

    for (const kind of wanted) {
      const cfg = DEFENSE_CAM[kind] ?? { height: 13.5, dur: 3800 };
      let ent = null;
      try {
        if (kind === "satlink") {
          ent = satEnt;
        } else {
          // FIFO defense queue: the next capture must be the head of awaitingDef.
          await waitFor(() => meOf(h, "a")?.awaitingDef?.[0] === kind, 150000, `${kind} construction`);
          await placeNear(h, "a", kind, goal.x, goal.y, "defense");
          ent = await waitFor(() => ownedBuildings(h, "a", kind)[0], 10000, `${kind} placed`);
          goal = { x: ent.x, y: ent.y };
        }
        if (meOf(h, "a")?.lowPower) console.log(`  [def] WARNING low power during ${kind} — defenses offline`);

        // Staging/flush choreography: defenses shred fodder faster than the
        // map-wide stream replaces it, so a drip-feed engagement reads as an
        // empty field with an occasional off-screen beam. Instead the flock
        // first congregates at a staging point just OUTSIDE weapon range on
        // the enemyward side, then the goal snaps onto the defense itself and
        // the whole flock descends at once — dense, visible, continuous fire
        // for the full clip.
        const range = gd.BUILDINGS[kind].range ?? 8;
        const dronesAlive = () => ownedUnits(h, "b").filter((e) => e.k === "ewdrone" && (e.hp === undefined || e.hp > 0));
        const stage = { x: ent.x + anchor.ux * (range + 4.5), y: ent.y + anchor.uy * (range + 4.5) };
        goal = { ...stage };
        await waitFor(
          () => {
            const near = dronesAlive().filter((d) => Math.hypot(d.x - stage.x, d.y - stage.y) <= 7).length;
            return near >= 4 ? { near } : null;
          },
          120000,
          `${kind} fodder flock staging`,
          300,
        );
        // Flush! The flock turns in as a group. The goal lands a few tiles
        // ENEMYWARD of the structure rather than on top of it: fodder hovering
        // directly over the star hides it under a dogpile of dark drone bodies
        // (observed in the first lasertower/irondome takes), while a ring
        // holding just off the muzzle keeps both parties in the same frame.
        goal = { x: ent.x + anchor.ux * 2.8, y: ent.y + anchor.uy * 2.8 };
        // Give the stream a full ordering cycle before trusting the trigger.
        // Consecutive captures share the same patch of ground, so the closest
        // drone is often ALREADY inside the envelope when the flush starts —
        // arming the trigger immediately freezes the flock mid-transit toward
        // the staging point and the clip films empty grass (observed: arc, sam,
        // thaad all starved this way in the first full run).
        await sleep(2400);
        await waitFor(
          () => {
            let bd = Infinity;
            for (const d of dronesAlive()) bd = Math.min(bd, Math.hypot(d.x - ent.x, d.y - ent.y));
            return bd <= range * 0.75 ? { bd } : null;
          },
          20000,
          `${kind} flush closing`,
          200,
        );
        // Freeze fodder orders the moment the flush closes: the stream's
        // constant re-ordering keeps every drone in motion, and moving aircraft
        // drag contrail puffs every 26ms — a tight orbiting flock whiteouts the
        // whole frame. Frozen waypoints let the flock settle onto the defense
        // and give the contrails a beat to dissipate before the tape rolls.
        const savedGoal = goal;
        goal = null;
        await sleep(900);
        let cap;
        try {
          // Frame a touch enemyward of the footprint — the frozen flock holds
          // off the muzzle on that side, so the engagement sits center-frame.
          cap = await recordClip(h, kind, ent.id, cfg.dur, cfg.height, { x: ent.x + anchor.ux * 1.3, y: ent.y + anchor.uy * 1.3 });
        } finally {
          goal = savedGoal;
        }
        result.captured[kind] = { ...cap, stage: st };
        console.log(`PASS ${kind} (${fmtBytes(cap.size)}, ${cap.quality}) room=${h.room}`);
      } catch (err) {
        result.ok = false;
        result.errors[kind] = err?.message || String(err);
        console.log(`FAIL ${kind}: ${result.errors[kind]}`);
      } finally {
        // Sell the star whether or not the capture worked: a battery left
        // standing contaminates every following clip with crossfire and kills
        // fodder meant for the next structure.
        const leftover = ent ?? ownedBuildings(h, "a", kind)[0];
        if (leftover && getEnt(h, leftover.id)) await sellBuilding(h, "a", leftover.id);
      }
    }
  } finally {
    if (stopStream) stopStream();
  }
}

async function captureHarvester(h) {
  await train(h, "a", "harvester", 1);
  const ent = await waitSpawned(h, "a", "harvester", h.seenUnits, 100000);
  h.seenUnits.add(ent.id);
  // Harvest orders are intrinsic once a refinery exists, but issue a harvest order toward
  // the richest visible nearby ore/signpost so the clip shows purposeful work.
  order(h, "a", [ent.id], "harvest", ent.x + 4, ent.y + 4);
  await sleep(2600);
  return recordClip(h, "harvester", ent.id, 4300, 13);
}

async function captureSupplyTruck(h) {
  await train(h, "a", "supplytruck", 1);
  const ent = await waitSpawned(h, "a", "supplytruck", h.seenUnits, 100000);
  h.seenUnits.add(ent.id);
  const armor = ownedUnits(h, "a").find((e) => e.k === "tank") ?? ent;
  order(h, "a", [ent.id], "move", armor.x + 2, armor.y + 2);
  await sleep(2300);
  return recordClip(h, "supplytruck", ent.id, 3800, 13);
}

async function captureEngineer(h) {
  await train(h, "a", "engineer", 1);
  const ent = await waitSpawned(h, "a", "engineer", h.seenUnits, 100000);
  h.seenUnits.add(ent.id);
  // Nearest capturable, not first-in-list: derricks pepper the whole map and the
  // engineer crawls at infantry speed — picking arbitrarily added half a minute
  // of dead walking to the session.
  const neutrals = entList(h).filter((e) => (e.k === "derrick" || e.k === "coalmine") && e.o < 0);
  const neutral = neutrals.length ? nearestTo(neutrals, ent) : null;
  const enemyBld = ownedBuildings(h, "b")[0];
  const target = neutral ?? enemyBld;
  if (!target) throw new Error("engineer: no capturable target");
  order(h, "a", [ent.id], "attack", target.x, target.y, target.id);
  // Trigger early: the capture IS the clip — engineer walks in, vanishes, the
  // building converts. Starting the recorder at close range meant the star was
  // already consumed before the first frame, which is exactly the empty-aftermath
  // engineer.gif the first full run produced.
  await waitFor(
    () => {
      const cur = getEnt(h, ent.id);
      const tgt = getEnt(h, target.id);
      if (!cur || !tgt) return null;
      return dist(cur, tgt) < 7 ? { cur, tgt } : null;
    },
    100000,
    "engineer near capture target",
    260,
  );
  // Aim at the building, not the engineer: the star is consumed mid-clip and a
  // dead entity leaves the camera with nothing to track — the conversion flash
  // on the structure is the money shot.
  return recordClip(h, "engineer", ent.id, 3900, 12, { x: target.x, y: target.y });
}

// Spy capture runs in two phases because the math is brutal: the only legal
// sabotage targets are enemy buildings — all the way across a 96×96 map — and
// the spy is CONSUMED the instant it touches one. Training it first and letting
// it walk while every other field unit films means it arrives long before the
// camera is ready and the infiltration happens off-screen. So phase one walks
// the spy to a staging point a few tiles off the target with a plain move order
// (no attack — nothing can go wrong, auto-defenses ignore disguised spies), and
// phase two — run after the rest of the session — issues the attack only once
// the camera is ready to roll.
async function launchSpyInfiltration(h) {
  await train(h, "a", "spy", 1);
  const ent = await waitSpawned(h, "a", "spy", h.seenUnits, 110000);
  h.seenUnits.add(ent.id);
  const target = ownedBuildings(h, "b").find((e) => e.k === "conyard") ?? ownedBuildings(h, "b")[0];
  if (!target) throw new Error("spy: no enemy building");
  const home = ownedBuildings(h, "a", "conyard")[0] ?? ent;
  const dx = target.x - home.x;
  const dy = target.y - home.y;
  const len = Math.hypot(dx, dy) || 1;
  const staging = { x: target.x - (dx / len) * 9, y: target.y - (dy / len) * 9 };
  order(h, "a", [ent.id], "move", staging.x, staging.y);
  return { entId: ent.id, targetId: target.id, staging };
}

async function finishSpyCapture(h, job) {
  const { entId, targetId, staging } = job;
  // Wait for the walk to finish — either arrival at staging or already close
  // enough to the target that the final approach is short.
  await waitFor(
    () => {
      const cur = getEnt(h, entId);
      const tgt = getEnt(h, targetId);
      if (!cur || !tgt) return null;
      return dist(cur, staging) < 3.5 || dist(cur, tgt) < 14 ? { cur, tgt } : null;
    },
    150000,
    "spy to reach infiltration staging",
    400,
  );
  const cur = getEnt(h, entId);
  const tgt = getEnt(h, targetId);
  if (!cur || !tgt) throw new Error("spy or target vanished before the attack run");
  order(h, "a", [entId], "attack", tgt.x, tgt.y, tgt.id);
  await waitFor(
    () => {
      const c = getEnt(h, entId);
      const t = getEnt(h, targetId);
      if (!c || !t) return null;
      return dist(c, t) < 5.5 ? { cur: c, tgt: t } : null;
    },
    60000,
    "spy on final sabotage approach",
    260,
  );
  return recordClip(h, "spy", entId, 4300, 12);
}

async function captureEwDrone(h) {
  await train(h, "a", "ewdrone", 1);
  const ent = await waitSpawned(h, "a", "ewdrone", h.seenUnits, 100000);
  h.seenUnits.add(ent.id);
  const st = stageFor(h, "a");
  order(h, "a", [ent.id], "move", st.x, st.y);
  await sleep(2400);
  return recordClip(h, "ewdrone", ent.id, 3900, 14);
}

// Every list carries refinery+factory because fodder supplytrucks require both —
// even sessions whose stars never touch the factory still need side b churning
// out cannon fodder.
const TECH = {
  landeco: { buildings: ["power", "refinery", "barracks", "radar", "factory"] },
  armor: { buildings: ["power", "refinery", "barracks", "radar", "factory", "techlab"], upgrades: [["factory", "factory2"]] },
  air: { buildings: ["power", "refinery", "barracks", "radar", "factory", "techlab", "airfield"], upgrades: [["airfield", "airfield2"]] },
  naval: { buildings: ["power", "refinery", "barracks", "radar", "factory", "techlab", "shipyard"], upgrades: [["shipyard", "shipyard2"]] },
};

const SESSIONS = [
  {
    id: "field",
    map: "crossroads",
    derricks: true,
    tech: TECH.landeco,
    enemyTech: true,
    units: ["spy", "engineer", "infantry", "rocket", "fpvdrone", "harvester", "supplytruck"],
  },
  {
    id: "armor",
    map: "crossroads",
    tech: TECH.armor,
    enemyTech: true,
    units: ["tank", "himars", "railtank", "ballistic"],
  },
  {
    id: "air",
    map: "crossroads",
    tech: TECH.air,
    enemyTech: true,
    enemyAirTargets: true,
    units: ["uav", "shahed", "ewdrone", "interceptor", "chopper", "a10", "ac130", "hypersonic"],
  },
  {
    id: "stealth",
    map: "crossroads",
    tech: TECH.air,
    enemyTech: true,
    units: ["stealthbomber"],
  },
  {
    id: "naval",
    map: "islands",
    tech: TECH.naval,
    enemyTech: true,
    naval: true,
    units: ["usv", "gunboat", "destroyer", "sub", "dreadnought", "carrier"],
  },
  {
    id: "defenses",
    map: "crossroads",
    defenseLineup: true,
    units: DEFENSE_CAPTURE_ORDER,
  },
];

function unitSession(unit) {
  for (const s of SESSIONS) if (s.units.includes(unit)) return s.id;
  return null;
}

async function runSession(session, wantedUnits) {
  const started = Date.now();
  const result = { session: session.id, room: null, ok: true, captured: {}, errors: {}, skipped: [], pageErrors: [] };
  let h;
  try {
    h = await openHarness(session);
  } catch (err) {
    result.ok = false;
    result.errors.session = err?.message || String(err);
    console.log(`FAIL session ${session.id}: ${result.errors.session}`);
    result.seconds = Math.round((Date.now() - started) / 1000);
    return result;
  }
  // Seed seenUnits with every unit already on the field: waitSpawned picks the
  // lowest-id unseen unit of a kind, and the starting squads carry the lowest
  // ids of all — unmasked, the "star" of the infantry/rocket captures would be a
  // parked starter walking in from behind the base instead of the freshly
  // trained unit at the barracks, which is exactly the unit mix-up behind the
  // mismatched camera framing in the empty-gif sessions.
  h.seenUnits = new Set(ownedUnits(h, "a").map((e) => e.id));
  result.room = h.room;
  let stopSeaShuffle = null;
  try {
    if (session.defenseLineup) {
      // Building stars, not unit stars: entirely different choreography (real
      // build/place flow + fodder streaming to the static defense). Returns
      // early — the finally below still closes the harness cleanly.
      await runDefenseFlow(h, session, wantedUnits, result);
      result.pageErrors = h.pageErrors;
      return result;
    }
    const st = parkStarters(h);
    const builds = [buildTech(h, "a", session.tech)];
    if (session.enemyTech) builds.push(buildTech(h, "b", session.tech));
    await Promise.all(builds);
    if (session.naval) stopSeaShuffle = startSeaShuffle(h);
    // Open the spectator browser NOW, not lazily at the first recordClip: the
    // client needs its keyframe, mesh warmup and a few rendered frames before the
    // canvas is worth sampling, and the first capture of a session must not pay
    // that price inside its own 3.6 s window.
    ensureBrowser(h).catch(() => {});

    // The spy walks first and films last: launched immediately so the long cross-map
    // hike overlaps every other capture, then finished once the camera is free —
    // see launchSpyInfiltration for why it must not attack on its own.
    let spyJob = null;
    let spyLaunchError = null;
    const wantSpy = wantedUnits.includes("spy");
    if (wantSpy) {
      spyJob = launchSpyInfiltration(h).catch((err) => {
        spyLaunchError = err?.message || String(err);
        return null;
      });
    }

    // Warm up target flocks for every domain this session will need, floating in
    // the background — the first capture's just-in-time ensureTargets call then
    // finds them already trained or well on the way.
    const neededDomains = [...new Set(wantedUnits.filter((u) => u in UNITS && UNITS[u].dmg > 0).map((u) => targetDomainFor(u)))];
    for (const dom of neededDomains) ensureTargets(h, dom, 2).catch(() => {});

    for (let i = 0; i < wantedUnits.length; i++) {
      const unit = wantedUnits[i];
      const nextUnit = wantedUnits[i + 1];
      if (unit === "spy") continue; // handled around the main loop — see above
      try {
        let cap;
        if (unit === "harvester") cap = await captureHarvester(h);
        else if (unit === "supplytruck") cap = await captureSupplyTruck(h);
        else if (unit === "engineer") cap = await captureEngineer(h);
        else if (unit === "ewdrone") cap = await captureEwDrone(h);
        else {
          const special = {};
          if (unit === "shahed" || unit === "fpvdrone" || unit === "usv") {
            special.durationMs = 4300;
            // Kamikaze units die on impact: the proximity trigger must fire while
            // the dive is still well short of the target, or the poll never catches
            // the sub-second in-range window and the star is dead before recording.
            special.rangePad = 10;
            // The impact point is the action — weight the frame toward the target,
            // not the inbound attacker.
            special.attackerWeight = 0.3;
          }
          if (unit === "hypersonic") {
            special.durationMs = 4000;
            // Mach-9: the strike closes ~20 tiles per real second at gameSpeed 2,
            // so the pad must be deep or the impact flash eats the whole clip
            // before the screencast pipeline is even warm.
            special.rangePad = 30;
            special.attackerWeight = 0.2;
          }
          if (unit === "ballistic" || unit === "dreadnought" || unit === "carrier") special.cameraHeight = 15;
          if (unit === "stealthbomber") {
            special.cameraHeight = 14;
            special.durationMs = 4300;
            special.trainTimeoutMs = 130000;
          }
          cap = await captureCombat(h, unit, { ...special, nextUnit });
        }
        result.captured[unit] = { ...cap, stage: st };
        console.log(`PASS ${unit} (${fmtBytes(cap.size)}, ${cap.quality}) room=${h.room}`);
      } catch (err) {
        result.ok = false;
        result.errors[unit] = err?.message || String(err);
        console.log(`FAIL ${unit}: ${result.errors[unit]}`);
      }
    }

    if (wantSpy) {
      try {
        const job = await spyJob;
        if (!job) throw new Error(spyLaunchError ?? "spy infiltration launch failed");
        const cap = await finishSpyCapture(h, job);
        result.captured.spy = { ...cap, stage: st };
        console.log(`PASS spy (${fmtBytes(cap.size)}, ${cap.quality}) room=${h.room}`);
      } catch (err) {
        result.ok = false;
        result.errors.spy = err?.message || String(err);
        console.log(`FAIL spy: ${result.errors.spy}`);
      }
    }
    result.pageErrors = h.pageErrors;
  } catch (err) {
    result.ok = false;
    result.errors.session = err?.message || String(err);
    console.log(`FAIL session ${session.id}: ${result.errors.session}`);
  } finally {
    result.seconds = Math.round((Date.now() - started) / 1000);
    if (stopSeaShuffle) stopSeaShuffle();
    await closeHarness(h);
  }
  return result;
}

function neededUnitsFor(session) {
  return session.units.filter((u) => {
    if (unitsFilter && !unitsFilter.includes(u)) return false;
    if (!FORCE && existsSync(join(OUT_DIR, `${u}.gif`))) return false;
    // Defense-lineup sessions list BUILDING kinds, not trainable units.
    if (!TRAIN_ORDER.some((row) => row.unit === u) && !isBuildingKind(u)) return false;
    return true;
  });
}

// Orphaned capture chromes are the single most destructive leak in this pipeline:
// when the node process dies without browser.close(), the headless instance keeps
// rendering the match loop on swiftshader at several hundred percent CPU FOREVER
// (two zombies once pinned 22 cores and strangled every concurrent room handshake
// on the box). They are trivially safe to identify — puppeteer profile dir, the
// swiftshader flag nobody else uses, and a dead parent — so reap them at startup.
function reapOrphanChromes() {
  let pids;
  try {
    pids = execFileSync("sh", ["-c", "ls /proc | grep -E '^[0-9]+$'"], { encoding: "utf8" }).trim().split("\n");
  } catch {
    return;
  }
  let reaped = 0;
  for (const pid of pids) {
    try {
      const cmd = execFileSync("sh", ["-c", `tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null`], { encoding: "utf8" });
      if (!cmd.includes("puppeteer_dev_chrome_profile") || !cmd.includes("enable-unsafe-swiftshader")) continue;
      if (!cmd.includes("--headless")) continue;
      // only root browser processes carry about:blank; children inherit death automatically
      const ppid = execFileSync("sh", ["-c", `awk '{print $4}' /proc/${pid}/stat 2>/dev/null`], { encoding: "utf8" }).trim();
      if (ppid !== "1") continue; // still has a living parent — not an orphan
      process.kill(Number(pid), 9);
      reaped++;
    } catch {}
  }
  if (reaped) console.log(`reaped ${reaped} orphaned capture chrome(s)`);
}

async function main() {
  reapOrphanChromes();
  const sessions = SESSIONS.filter((s) => !sessionsFilter || sessionsFilter.includes(s.id))
    .map((s) => ({ def: s, units: neededUnitsFor(s) }))
    .filter((s) => s.units.length > 0);

  if (unitsFilter) {
    const unknown = unitsFilter.filter((u) => !unitSession(u));
    if (unknown.length) throw new Error(`unknown or retired unit(s): ${unknown.join(", ")}`);
  }
  if (!sessions.length) {
    console.log("All requested GIFs already exist — nothing to do. Use --force to recapture.");
    return;
  }

  console.log(`capture plan: ${sessions.map((s) => `${s.def.id}[${s.units.join(",")}]`).join(" ")} jobs=${JOBS}`);
  const queue = [...sessions];
  const reports = [];
  async function worker(workerIdx) {
    while (queue.length) {
      const item = queue.shift();
      if (!item) return;
      console.log(`START session=${item.def.id} worker=${workerIdx} units=${item.units.join(",")}`);
      reports.push(await runSession(item.def, item.units));
      writeFileSync(REPORT, JSON.stringify(reports, null, 2));
    }
  }
  // Stagger worker starts: simultaneous room creation + lobby join + match start
  // across all workers is exactly what tripped the startup timeouts on a loaded
  // box — a few seconds apart the handshakes sail through.
  await Promise.all(
    Array.from({ length: Math.min(JOBS, sessions.length) }, (_, i) =>
      (async () => {
        await sleep(i * 6000);
        await worker(i + 1);
      })(),
    ),
  );

  writeFileSync(REPORT, JSON.stringify(reports, null, 2));
  const failures = reports.flatMap((r) => Object.entries(r.errors).map(([u, e]) => `${r.session}/${u}: ${e}`));
  const total = reports.reduce((n, r) => n + Object.keys(r.captured).length, 0);
  const bytes = reports.reduce((n, r) => n + Object.values(r.captured).reduce((x, c) => x + c.size, 0), 0);
  console.log(`DONE captured=${total} bytes=${fmtBytes(bytes)} report=${REPORT}`);
  if (failures.length) {
    console.log(`FAILURES:\n${failures.join("\n")}`);
    process.exitCode = 2;
  }
}

main()
  .then(() => setTimeout(() => process.exit(process.exitCode ?? 0), 200))
  .catch((err) => {
    console.error(err?.stack || err);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 200);
  });
