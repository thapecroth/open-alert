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
 *
 * Capture architecture (rewritten after the empty-gif QA postmortem — see
 * .tmp/gifcheck/verdicts.md for the failure evidence):
 *
 *  1. ALL engagement triggering, camera framing and recording happens INSIDE
 *     the spectator page, driven off window.__oa.state — the exact data the
 *     renderer draws. The harness websocket is an independent stream that can
 *     skew seconds behind under load, and every puppeteer round-trip costs
 *     100-500ms on a swiftshader box; a kamikaze drone crosses its entire
 *     trigger-to-impact window (~1.1-1.7s) inside that latency chain. In-page
 *     the trigger poll is ~5ms of JS and the recorder starts in the same task.
 *  2. Kamikaze captures are event-driven: the tape rolls at a proximity
 *     trigger and stops a fixed tail AFTER the impact is observed (star entity
 *     gone / target hp drop), so the explosion can never fall outside the clip
 *     no matter how much the sim slow-motions under load.
 *  3. Timeouts that measure game progress use SIM TICKS (state.tick), not wall
 *     clock — the sim runs slower than real-time under load and wall-clock
 *     timeouts were firing mid-approach.
 *  4. Attack orders are verified: the snapshot serializes each unit's order
 *     queue as wp waypoints, so the supervisor loop re-issues the order (with
 *     fresh target selection) whenever the server silently dropped it
 *     (world.ts drops attack orders when canAttack fails at order time).
 *  5. ffmpeg encoding never blocks the capture loop: encodes run through an
 *     async serial queue overlapping the next capture's travel time.
 */

import puppeteer from "puppeteer-core";
import { execFile, execFileSync } from "node:child_process";
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
const JOBS = Math.max(1, Math.min(5, Number(optVal("jobs") || 1)));

const VW = 900;
const VH = 650;
const CROP_W = 640;
const CROP_H = 400;
const GIF_W = 560;
const MAX_GIF_BYTES = 600 * 1024;

const fmtBytes = (n) => `${(n / 1024).toFixed(0)}KB`;
const nowId = () => Date.now().toString(36).slice(-6);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const DEBUG = !!process.env.CAPTURE_DEBUG;

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
function simTickOf(h, side = "a") {
  return snapOf(h, side)?.tick ?? 0;
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

// Sim-time aware wait: the sim slow-motions under load, so a wall-clock budget
// silently measures less game progress than intended. The primary budget is in
// sim ticks read off the snapshot stream; wall clock is only a backstop for a
// truly wedged room (ticks frozen entirely).
async function waitForSim(h, fn, ticks, label, pollMs = 200, wallBackstopMs = 240000) {
  const startTick = simTickOf(h);
  const startWall = Date.now();
  let last;
  while (Date.now() - startWall < wallBackstopMs) {
    if (simTickOf(h) - startTick > ticks) break;
    try {
      last = await fn();
      if (last) return last;
    } catch {
      // keep polling
    }
    await sleep(pollMs);
  }
  // Diagnostic dump on timeout: construction stalls are otherwise invisible.
  try {
    for (const side of ["a", "b"]) {
      const me = meOf(h, side);
      if (me) console.error(`[waitForSim-timeout] side ${side}: credits=${me.credits} pwr=${me.pwrHave}/${me.pwrUse} lowPower=${me.lowPower} awaiting=${JSON.stringify(me.awaiting)} queue=${JSON.stringify(me.queue ?? me.production ?? null)}`);
    }
    console.error(`[waitForSim-timeout] tick=${simTickOf(h)} label=${label}`);
  } catch {}
  throw new Error(`timeout waiting for ${label} (sim)`);
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
  await waitFor(() => inLobby(a, tokenA) && inLobby(b, tokenB), 45000, "both harness players to join lobby");
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
  const startDeadline = Date.now() + 30000;
  while (Date.now() < startDeadline) {
    send(a, { t: "start" });
    await sleep(550);
    if (a.slot !== null && b.slot !== null) break;
  }
  await waitFor(() => a.slot !== null && b.slot !== null, 25000, "match init slots");
  await waitFor(() => (snapOf({ conns: { a, b } }, "a")?.ents?.length ?? 0) > 0, 30000, "first world snapshot");
  return { session, room, tokenA, tokenB, conns: { a, b }, browser: null, page: null, pageErrors: [], encodes: [] };
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
  await waitForSim(h, () => meOf(h, side)?.awaiting?.includes(kind), 2600, `${kind} ready to place`);
  await mcpCall(h.room, "place_structure", { token, cat: "structure" });
  return waitFor(() => ownedBuildings(h, side, kind)[0], 15000, `${kind} placed`);
}

async function upgradeFirst(h, side, fromKind, toKind) {
  const token = side === "a" ? h.tokenA : h.tokenB;
  const bld = ownedBuildings(h, side, fromKind)[0];
  if (!bld) throw new Error(`cannot upgrade missing ${fromKind}`);
  await mcpCall(h.room, "special_action", { token, action: "upgrade", id: bld.id });
  return waitFor(() => ownedBuildings(h, side, toKind)[0], 12000, `${fromKind} upgrade`);
}

async function buildTech(h, side, tech) {
  // Duplicate kinds in the list mean multiples (power plants, mostly): buildOne
  // early-returns on the first existing building, so repeated kinds are
  // deferred to a single buildCounted call at their last occurrence.
  const totals = {};
  for (const kind of tech.buildings) totals[kind] = (totals[kind] ?? 0) + 1;
  const seen = {};
  for (const kind of tech.buildings) {
    seen[kind] = (seen[kind] ?? 0) + 1;
    if (totals[kind] > 1) {
      if (seen[kind] === totals[kind]) await buildCounted(h, side, kind, totals[kind]);
    } else {
      await buildOne(h, side, kind);
    }
  }
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
    await waitForSim(h, () => meOf(h, side)?.awaiting?.includes(kind), 3200, `${kind} #${i + 1} ready to place`);
    await mcpCall(h.room, "place_structure", { token, cat: "structure" });
    await waitFor(() => ownedBuildings(h, side, kind).length > i, 20000, `${kind} #${i + 1} placed`);
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
    const deadline = Date.now() + 120000;
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

async function waitSpawned(h, side, kind, seen, timeoutMs = 150000) {
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
    // The in-page capture primitive is a single page.evaluate whose promise
    // stays pending for the whole approach+engagement — easily minutes when the
    // sim slow-motions. The default 180s protocol timeout would kill it
    // mid-approach, so CDP calls get a ten-minute budget instead.
    protocolTimeout: 600000,
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
  // Bloom is a per-capture decision (see setBloom): muzzle flashes and kill
  // explosions at point blank inflate into frame-eating white blobs with bloom
  // on, while mid-camera tracer fire reads as sparkle. The default-on state is
  // set here; individual captures toggle it live through the graphics bridge.
  const bloom = true;
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
  await page.waitForFunction(() => window.__oa && window.__oa.phase === "playing", { timeout: 30000 });
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent = "body>*:not(#game){display:none!important} #game{display:block!important;width:100vw!important;height:100vh!important;cursor:none!important}";
    document.head.append(st);
  });
  h.page = page;
  return page;
}

// Live bloom toggle through the client's own graphics bridge — the setting
// propagates through the official onChange path into the composer's bloom pass.
// The AC-130 close-up is the standing lesson: its gun flashes at point-blank
// camera range bloom into a whiteout that hides the star for the whole clip.
async function setBloom(h, on) {
  if (!h.page) return;
  await h.page
    .evaluate((v) => {
      try {
        window.__oa?.gs?.graphics?.setOption?.("bloom", v);
      } catch {}
    }, on)
    .catch(() => {});
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

// ---------- async ffmpeg encoding pipeline ----------
//
// execFileSync inside the capture loop blocks the whole node event loop for
// seconds per encode — websocket messages, puppeteer round-trips and order
// supervision all freeze behind it, which is exactly how harness-side entity
// positions appeared "frozen for minutes" in the skew postmortem. Encoding is
// pure CPU work with no ordering dependency on the captures, so it runs
// through a serial async queue that overlaps the next unit's travel time.

function ff(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { stdio: "pipe", maxBuffer: 4 * 1024 * 1024 }, (err, so, se) => {
      if (err) reject(new Error(`ffmpeg: ${err.message} ${se?.slice(-300) ?? ""}`));
      else resolve();
    });
  });
}
function ffprobeDuration(webm) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", webm]).toString().trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

async function ffmpegEncodeAsync(webm, out, width = GIF_W, colors = 112, maxDur = 0, anchor = "head", tapeDur = 0, trim = null) {
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
  // Window selection, in priority order:
  //  1. explicit impact-relative trim — the action window is known exactly
  //  2. tail-anchored truncation — kamikaze tapes are impact-last, so cutting
  //     the tail would amputate the explosion; shave the approach instead
  //  3. head-anchored truncation — action-early timed clips shave the tail
  let seek = [];
  let dur = [];
  if (trim && trim.ss != null) {
    seek = trim.ss > 0.05 ? ["-ss", trim.ss.toFixed(2)] : [];
    dur = trim.dur > 0 ? ["-t", trim.dur.toFixed(2)] : [];
  } else {
    if (maxDur > 0 && tapeDur > maxDur + 0.05 && anchor === "tail") {
      seek = ["-ss", (tapeDur - maxDur).toFixed(2)];
    }
    dur = maxDur > 0 ? ["-t", String(maxDur)] : [];
  }
  await ff(["-hide_banner", "-y", "-v", "error", ...seek, "-i", webm, ...dur, "-vf", `${crop},fps=12,scale=${width}:-2:flags=lanczos,palettegen=max_colors=${colors}`, pal]);
  await ff([
    "-hide_banner", "-y", "-v", "error", ...seek, "-i", webm, "-i", pal, ...dur,
    "-lavfi", `${crop},fps=12,scale=${width}:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a`,
    "-loop", "0", out,
  ]);
  rmSync(pal, { force: true });
}

// Size ladder — noisy combat footage (muzzle flashes, explosions, lots of motion)
// blows past the web-delivery budget at full quality, so step down width/palette
// first and only then shave the clip. Visual quality stays legible far longer
// than raw byte size suggests because GIF delta compression is what actually
// hurts here.
const QUALITY_TIERS = [
  { width: GIF_W, colors: 112, dur: 0, label: "112c/560w" },
  { width: 520, colors: 88, dur: 0, label: "88c/520w" },
  { width: 480, colors: 64, dur: 0, label: "64c/480w" },
  { width: 480, colors: 64, dur: 3.6, label: "64c/480w/3.6s" },
  { width: 420, colors: 48, dur: 3.2, label: "48c/420w/3.2s" },
];

// Serial encode queue: one ffmpeg pipeline at a time. Jobs are registered by
// the capture flow and awaited at session end; capture code itself never waits
// on an encode before moving on to the next unit.
// Impact-relative clip window: given the tape's impact offset, choose the gif
// window — a couple of seconds of inbound action, the impact itself, and a
// beat of aftermath. Tapes whose impact was never observed fall back to plain
// anchoring inside the quality ladder.
function impactTrim(rec, leadSec, tailKeepSec, maxDurSec = 4.6) {
  if (rec?.impactT == null) return null;
  const impactSec = rec.impactT / 1000;
  const ss = Math.max(0, impactSec - leadSec);
  const end = Math.min(rec.tapeMs / 1000, impactSec + tailKeepSec);
  const dur = Math.min(maxDurSec, Math.max(1.2, end - ss));
  return { ss, dur };
}

function enqueueEncode(h, job) {
  const run = async () => {
    const tapeDur = ffprobeDuration(job.webm);
    let size = 0;
    let quality = "";
    for (const tier of QUALITY_TIERS) {
      await ffmpegEncodeAsync(job.webm, job.out, tier.width, tier.colors, tier.dur, job.anchor ?? "head", tapeDur, job.trim ?? null);
      size = statSync(job.out).size;
      quality = tier.label;
      if (size <= MAX_GIF_BYTES) break;
    }
    rmSync(job.webm, { force: true });
    return { out: job.out, size, quality, durationMs: job.durationMs ?? 0 };
  };
  const p = (h.encodeChain ?? Promise.resolve()).then(run, run);
  h.encodeChain = p.catch(() => {});
  const entry = { kind: job.kind, promise: p };
  h.encodes.push(entry);
  p.then(
    (r) => console.log(`  [enc] ${job.kind}: ${fmtBytes(r.size)} ${r.quality}`),
    (err) => console.log(`  [enc] ${job.kind} FAILED: ${err?.message || err}`),
  );
  return entry;
}

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

// ---------------------------------------------------------------------------
// In-page engagement capture — the heart of the pipeline.
//
// Everything latency-critical happens inside the spectator page: watching the
// approach on spectator-side state (the same data the renderer draws), framing
// the camera at trigger time, starting the MediaRecorder in the same task, and
// — for kamikaze units — stopping the tape a fixed tail AFTER the impact is
// observed. The node side only supervises orders while the tape rolls.
//
// spec = {
//   starId, enemySlot,
//   fodderKinds?: string[]         — target = nearest living enemy of these kinds
//   targetId?: number              — or a fixed target entity (buildings: spy)
//   triggerDist: number            — center-distance that starts the camera+recorder
//   mode: "timed" | "impact"       — timed: fixed window; impact: stop tailMs after kill
//   durationMs?, tailMs?, maxRecMs — record-phase bounds
//   maxWaitTicks, maxWaitMs        — trigger-wait bounds (sim ticks + wall backstop)
//   cameraHeight                   — fixed height, or starting point for autoFrame
//   minH/maxH/marginPx, autoFrame  — dynamic fit of star+target inside the crop
//   attackerWeight                 — camera aim blend toward the star (0..1)
//   preRollMs                      — settle time between camera set and rec start
//   cropFx/cropFy                  — crop fractions of the viewport
// }
// ---------------------------------------------------------------------------
async function pageCaptureEngagement(h, spec) {
  const page = await ensureBrowser(h);
  const promise = page.evaluate(async (spec) => {
    const oa = window.__oa;
    if (!oa || !oa.renderer?.tracked) return { error: "client renderer unavailable" };
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    // Spectator-side entity state: renderer.tracked values carry `.last` — the
    // exact EntSnap the renderer draws (positions, hp, kind, disguise), updated
    // every snapshot and deleted promptly when an entity dies. This is the same
    // data the render shows by definition, so triggers measured here cannot
    // skew away from what the tape records.
    const trackedEnts = () => {
      const out = [];
      for (const t of oa.renderer.tracked.values()) if (t.last) out.push(t.last);
      return out;
    };
    const ents = trackedEnts;
    // Sim-time measurement: the HUD game clock renders floor(tick/10) as mm:ss.
    // Parsed back it yields game-seconds — coarse (10-tick granularity) but
    // correct under slow-motion, which is all the trigger timeout needs.
    const tick = () => {
      const txt = document.getElementById("game-clock")?.textContent ?? "0:00";
      const parts = txt.split(":").map(Number);
      return ((parts[0] || 0) * 60 + (parts[1] || 0)) * 10;
    };
    const findStar = () => oa.renderer.tracked.get(spec.starId)?.last ?? null;
    const kindOf = (e) => e.disg ?? e.k;
    const progress = (obj) => {
      try {
        window.__oaCap = { ...(window.__oaCap ?? {}), ...obj, at: performance.now() };
      } catch {}
    };
    const targetOf = (star) => {
      if (spec.targetId != null) {
        const t = ents().find((e) => Number(e.id) === spec.targetId);
        return t ? { ent: t, d: Math.hypot(t.x - star.x, t.y - star.y) } : null;
      }
      let best = null;
      let bd = Infinity;
      for (const e of ents()) {
        if (e.o !== spec.enemySlot) continue;
        if (!spec.fodderKinds.includes(kindOf(e))) continue;
        if (e.hp !== undefined && e.hp <= 0) continue;
        const d = Math.hypot(e.x - star.x, e.y - star.y);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      return best ? { ent: best, d: bd } : null;
    };

    // ---- phase 1: wait for the approach trigger, in sim ticks ----
    const startTick = tick();
    const t0 = performance.now();
    let trig = null;
    let lastD = null;
    while (true) {
      const star = findStar();
      if (!star) return { error: "star died before trigger" };
      const tgt = targetOf(star);
      if (tgt) lastD = tgt.d;
      progress({ phase: "approach", d: lastD, tick: tick() - startTick });
      if (tick() - startTick > spec.maxWaitTicks) return { error: `trigger timeout (${spec.maxWaitTicks} ticks)`, lastD };
      if (performance.now() - t0 > spec.maxWaitMs) return { error: "trigger timeout (wall)", lastD };
      if (tgt && tgt.d <= spec.triggerDist) {
        trig = {
          star: { x: star.x, y: star.y },
          tgt: { x: tgt.ent.x, y: tgt.ent.y, id: Number(tgt.ent.id), hp: tgt.ent.hp },
          d: tgt.d,
        };
        break;
      }
      await sleepMs(70);
    }
    progress({ phase: "triggered", d: trig.d });

    // ---- phase 2: frame the camera — optionally fitting both parties in crop ----
    const gs = oa.gs;
    const canvas = document.getElementById("game");
    const w = spec.attackerWeight;
    const aimX = trig.star.x * w + trig.tgt.x * (1 - w);
    const aimY = trig.star.y * w + trig.tgt.y * (1 - w);
    const setCam = (x, y, h) => {
      gs.camTarget.x = x;
      gs.camTarget.z = y;
      gs.camHeight = h;
      gs.updateCamera();
      gs.camera.updateMatrixWorld(true);
    };
    let camH = spec.cameraHeight;
    if (spec.autoFrame) {
      // Perspective view: raising the camera zooms out. Pick the LOWEST height
      // where both parties project inside the crop rectangle (with margin) —
      // maximum zoom that still keeps the star and the impact zone on screen.
      const vw = canvas.clientWidth || 900;
      const vh = canvas.clientHeight || 650;
      const cw = vw * spec.cropFx;
      const chh = vh * spec.cropFy;
      const x0 = (vw - cw) / 2 + spec.marginPx;
      const x1 = (vw + cw) / 2 - spec.marginPx;
      const y0 = (vh - chh) / 2 + spec.marginPx;
      const y1 = (vh + chh) / 2 - spec.marginPx;
      const inside = (px) => px.x > x0 && px.x < x1 && px.y > y0 && px.y < y1;
      let chosen = null;
      for (let hh = spec.minH; hh <= spec.maxH + 0.01; hh += 0.5) {
        setCam(aimX, aimY, hh);
        const pa = oa.projectTile(trig.star.x - 0.5, trig.star.y - 0.5);
        const pb = oa.projectTile(trig.tgt.x - 0.5, trig.tgt.y - 0.5);
        if (inside(pa) && inside(pb)) {
          chosen = hh;
          break;
        }
      }
      camH = chosen ?? spec.maxH;
    }
    setCam(aimX, aimY, camH);
    await sleepMs(spec.preRollMs);

    // ---- phase 3: roll tape ----
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
    const recT = performance.now();
    progress({ phase: "recording" });

    let impactT = null;
    let impactKind = null;
    let firstHitT = null;
    let prevTgtHp = trig.tgt.hp;
    const deadline = recT + spec.maxRecMs;
    while (true) {
      await sleepMs(80);
      const now = performance.now();
      const star = findStar();
      // First-hit tracking runs in EVERY mode: server-side damage lands the
      // same tick the shot fires, so the target's first hp drop timestamps the
      // first volley within one snapshot interval. Timed artillery clips use
      // it post-hoc to place the encode window on the launch.
      const tgtNow = ents().find((e) => Number(e.id) === trig.tgt.id);
      if (tgtNow && typeof tgtNow.hp === "number") {
        if (typeof prevTgtHp === "number" && tgtNow.hp < prevTgtHp && firstHitT == null) {
          firstHitT = now - recT;
          progress({ phase: "first-hit" });
        }
        prevTgtHp = tgtNow.hp;
      }
      if (spec.mode === "impact") {
        if (!star && impactT == null) {
          impactT = now;
          impactKind = "star-gone";
          progress({ phase: "impact", kind: impactKind });
        }
        if (firstHitT != null && impactT == null) {
          impactT = now;
          impactKind = "hp-drop";
          progress({ phase: "impact", kind: impactKind });
        }
        if (!tgtNow && impactT == null) {
          impactT = now;
          impactKind = "target-gone";
          progress({ phase: "impact", kind: impactKind });
        }
        if (impactT != null && now >= impactT + spec.tailMs) break;
        if (now >= deadline) break;
      } else {
        if (now >= recT + spec.durationMs) break;
      }
    }
    const tapeMs = performance.now() - recT;
    await new Promise((r) => {
      rec.onstop = r;
      rec.stop();
    });
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: mime });
    return {
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      size: blob.size,
      mime,
      tapeMs,
      trig,
      camH,
      aim: { x: aimX, y: aimY },
      impactT: impactT == null ? null : impactT - recT,
      impactKind,
      firstHitT,
    };
  }, spec);
  return { promise, page };
}

// Order supervision: the server silently drops attack orders when canAttack
// fails at order time (world.ts) and never tells the client. The snapshot
// serializes each unit's live order queue as wp waypoints ([x, y, kind]), so
// acceptance is observable: within a couple of seconds the star must carry an
// attack waypoint. While the in-page capture waits for its trigger, this loop
// re-issues the order with fresh target selection whenever it is missing, and
// freezes land fodder near the star so artillery doesn't chase instead of fire.
async function superviseOrders(h, unit, starId, opts, done) {
  const domain = opts.domain ?? targetDomainFor(unit);
  let reissues = 0;
  let lastOrderAt = 0;
  let froze = false;
  while (!done()) {
    await sleep(750);
    if (done()) break;
    try {
      const star = getEnt(h, starId);
      if (!star) break; // dead — impact or failure, the in-page side knows
      const wp = star.wp;
      const attacking = Array.isArray(wp) && wp.length > 0 && wp[0][2] === "attack";
      if (!attacking && Date.now() - lastOrderAt > 1600) {
        const target = chooseTarget(h, { targetKind: opts.targetKind, attackerKind: unit, origin: star });
        if (target) {
          order(h, "a", [starId], "attack", target.x, target.y, target.id);
          lastOrderAt = Date.now();
          reissues++;
          if (DEBUG) console.log(`  [dbg] ${unit}: (re)issued attack on #${target.id} (${reissues})`);
        }
      } else if (attacking && !froze && opts.freezeFodder) {
        // Artillery chase fix: fodder drifting away from the stage makes the
        // star pursue instead of firing — its range only closes when the
        // target holds still. Unarmed land fodder is harmless standing still,
        // so freeze everything near the star once the attack is on. Sea
        // fodder is armed and must keep shuffling (moving units never fire).
        const starT = chooseTarget(h, { targetKind: opts.targetKind, attackerKind: unit, origin: star });
        if (starT && dist(star, starT) <= UNITS[unit].range + 6) {
          const flock = ownedUnits(h, "b").filter((e) => e.k === TARGET_TRAINER[domain] && Math.hypot(e.x - star.x, e.y - star.y) < 14);
          if (flock.length) {
            stop(h, "b", flock.map((e) => e.id));
            froze = true;
            if (DEBUG) console.log(`  [dbg] ${unit}: froze ${flock.length} fodder near star`);
          }
        }
      }
    } catch {}
  }
  return { reissues };
}

async function captureCombat(h, unit, opts = {}) {
  const seen = h.seenUnits;
  h.prequeued ??= new Set();
  if (h.prequeued.has(unit)) h.prequeued.delete(unit);
  else await train(h, "a", unit, 1);
  const ent = await waitSpawned(h, "a", unit, seen, opts.trainTimeoutMs ?? 150000);
  seen.add(ent.id);

  // Start the next unit cooking while this one is moving into firing position.
  if (opts.nextUnit && !h.prequeued.has(opts.nextUnit)) {
    h.prequeued.add(opts.nextUnit);
    train(h, "a", opts.nextUnit, 1).catch(() => h.prequeued.delete(opts.nextUnit));
  }

  const domain = targetDomainFor(unit);
  await ensureTargets(h, domain, 2);
  const target = await waitForSim(
    h,
    () => chooseTarget(h, { targetKind: opts.targetKind, attackerKind: unit, origin: ent }),
    900,
    `target for ${unit}`,
  );

  // Per-unit capture shaping. Kamikaze/strike classes use impact-mode tapes;
  // sustained-fire units use timed tapes with auto-framing.
  const spec = {
    starId: ent.id,
    enemySlot: h.conns.b.slot,
    fodderKinds: [TARGET_TRAINER[domain]],
    triggerDist: opts.triggerDist ?? UNITS[unit].range + (opts.rangePad ?? 2.6),
    mode: opts.mode ?? "timed",
    durationMs: opts.durationMs ?? 4400,
    tailMs: opts.tailMs ?? 1800,
    maxRecMs: opts.maxRecMs ?? 40000,
    maxWaitTicks: opts.maxWaitTicks ?? 1100,
    maxWaitMs: opts.maxWaitMs ?? 170000,
    cameraHeight: opts.cameraHeight ?? (UNITS[unit].domain === "air" ? 14 : 13),
    minH: opts.minH ?? 10.5,
    maxH: opts.maxH ?? 17,
    marginPx: opts.marginPx ?? 26,
    autoFrame: opts.autoFrame ?? false,
    attackerWeight: opts.attackerWeight ?? 0.45,
    preRollMs: opts.preRollMs ?? 240,
    cropFx: CROP_W / VW,
    cropFy: CROP_H / VH,
  };

  if (opts.bloom === false) await setBloom(h, false);
  const { promise, page } = await pageCaptureEngagement(h, spec);

  // Attack order goes out immediately after the in-page watcher is live —
  // ordering before would waste trigger distance on the spawn-to-field walk.
  order(h, "a", [ent.id], "attack", target.x, target.y, target.id);
  let finished = false;
  const supervise = superviseOrders(h, unit, ent.id, { ...opts, domain }, () => finished).catch(() => ({}));

  const rec = await promise;
  finished = true;
  await supervise;
  if (opts.bloom === false) await setBloom(h, true).catch(() => {});
  if (rec.error) throw new Error(`${unit} capture: ${rec.error}${rec.lastD != null ? ` lastD=${rec.lastD?.toFixed(1)}` : ""}`);
  if (!rec.bytes?.length) throw new Error(`${unit} capture: empty tape`);
  if (DEBUG) {
    await page.screenshot({ path: join(TMP_DIR, `${h.session.id}-${unit}-post.png`) }).catch(() => {});
    console.log(
      `  [dbg] ${unit}: tape=${(rec.tapeMs / 1000).toFixed(1)}s trigD=${rec.trig.d.toFixed(1)} camH=${rec.camH} aim=(${rec.aim.x.toFixed(1)},${rec.aim.y.toFixed(1)}) impact=${rec.impactKind ?? "none"}@${rec.impactT == null ? "-" : (rec.impactT / 1000).toFixed(1)}s`,
    );
  }
  const webm = join(TMP_DIR, `${h.session.id}-${unit}.webm`);
  writeFileSync(webm, Buffer.from(rec.bytes));
  const out = join(OUT_DIR, `${unit}.gif`);
  // Window placement. Impact-mode tapes trim around the impact. Timed tapes
  // trim around the FIRST HIT when one was observed: server damage lands the
  // tick the shot fires, so the window [hit - lead, hit + tail] always carries
  // the launch, the flight and the impact — even when sim slow-mo stretched
  // the approach across most of the tape (the ballistic truncate-the-launch
  // failure). Without an observed hit the ladder's head anchoring is the
  // fallback and the frame review catches the miss.
  let trim = null;
  if (spec.mode === "impact") {
    trim = impactTrim(rec, opts.trimLeadSec ?? 2.3, opts.trimTailSec ?? 1.9);
  } else if (rec.firstHitT != null) {
    const hitSec = rec.firstHitT / 1000;
    const ss = Math.max(0, hitSec - (opts.hitLeadSec ?? 1.0));
    const end = Math.min(rec.tapeMs / 1000, hitSec + (opts.hitTailSec ?? 3.2));
    trim = { ss, dur: Math.min(4.6, Math.max(1.2, end - ss)) };
  }
  const entry = enqueueEncode(h, { webm, out, kind: unit, anchor: spec.mode === "impact" ? "tail" : "head", durationMs: rec.tapeMs, trim });

  // Pull the star off-stage after its close-up. Left in place it keeps
  // auto-firing through every following train cycle and deprives the remaining
  // units of anything to shoot at — and parked AT the base it would still be in
  // range of fodder passing to the stage, so it goes to the far parking lot
  // with the starting squad. (Kamikaze stars are already dead — harmless no-op.)
  const park = parkPointFor(h, "a");
  if (getEnt(h, ent.id)) order(h, "a", [ent.id], "move", park.x, park.y);

  const enc = await entry.promise;
  return { ...enc, tape: rec };
}

async function closeHarness(h) {
  if (h.browser) await h.browser.close().catch(() => {});
  for (const c of Object.values(h.conns)) {
    try {
      c.ws.close();
    } catch {}
  }
}

// ---------- legacy fixed-camera clip recorder (defenses & utility units) ----------
//
// The defense lineup films STATIC buildings whose fodder choreography is fully
// node-driven, so it keeps the original fixed-camera recorder — the engagement
// timing there is controlled by the flush choreography, not a unit approach.
async function recordClip(h, kind, entId, durationMs, height = 13, focus = null) {
  const page = await ensureBrowser(h);
  const webm = join(TMP_DIR, `${h.session.id}-${kind}.webm`);
  const out = join(OUT_DIR, `${kind}.gif`);
  const first = getEnt(h, entId);
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
  const rec = await page.evaluate(async (durationMs) => {
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
  if (rec.error) throw new Error(rec.error);
  writeFileSync(webm, Buffer.from(rec.bytes));
  const entry = enqueueEncode(h, { webm, out, kind, anchor: "head", durationMs });
  return entry.promise;
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

  const techA = (async () => {
    await buildCounted(h, "a", "power", 3);
    for (const k of ["barracks", "radar", "factory", "techlab"]) await buildOne(h, "a", k);
  })();
  const techB = (async () => {
    await buildCounted(h, "b", "power", 1);
    for (const k of ["barracks", "radar", "airfield"]) await buildOne(h, "b", k);
  })();

  ensureBrowser(h).catch(() => {});

  const anchor = defenseAnchor(h);
  const anchorPt = { x: anchor.home.x + anchor.ux * 11, y: anchor.home.y + anchor.uy * 11 };
  let goal = { ...anchorPt };
  let stopStream = null;

  await techB;
  train(h, "b", "ewdrone", 5).catch(() => {});
  stopStream = startDroneStream(h, () => goal);

  try {
    await techA;

    const warmPage = await ensureBrowser(h);
    await waitFor(
      () => warmPage.evaluate(() => (window.__oa?.renderer?.tracked?.size ?? 0) > 10).catch(() => false),
      40000,
      "spectator world warmup",
      300,
    );

    await mcpCall(h.room, "build_structure", { token: h.tokenA, kind: "satlink" });
    await waitForSim(h, () => meOf(h, "a")?.awaiting?.includes("satlink"), 4000, "satlink construction");
    await placeNear(h, "a", "satlink", anchorPt.x, anchorPt.y, "structure");
    const satEnt = await waitFor(() => ownedBuildings(h, "a", "satlink")[0], 10000, "satlink placed");
    goal = { x: satEnt.x, y: satEnt.y };

    const queueOrder = DEFENSE_CAPTURE_ORDER.filter((k) => k !== "satlink" && wanted.includes(k));
    for (const k of queueOrder) {
      try {
        await mcpCall(h.room, "build_structure", { token: h.tokenA, kind: k });
      } catch (err) {
        console.log(`  [def] queue ${k} failed: ${err?.message || err}`);
      }
    }
    if (!wanted.includes("satlink")) await sellBuilding(h, "a", satEnt.id);

    for (const kind of wanted) {
      const cfg = DEFENSE_CAM[kind] ?? { height: 13.5, dur: 3800 };
      let ent = null;
      try {
        if (kind === "satlink") {
          ent = satEnt;
        } else {
          await waitForSim(h, () => meOf(h, "a")?.awaitingDef?.[0] === kind, 4000, `${kind} construction`);
          await placeNear(h, "a", kind, goal.x, goal.y, "defense");
          ent = await waitFor(() => ownedBuildings(h, "a", kind)[0], 10000, `${kind} placed`);
          goal = { x: ent.x, y: ent.y };
        }
        if (meOf(h, "a")?.lowPower) console.log(`  [def] WARNING low power during ${kind} — defenses offline`);

        const range = gd.BUILDINGS[kind].range ?? 8;
        const dronesAlive = () => ownedUnits(h, "b").filter((e) => e.k === "ewdrone" && (e.hp === undefined || e.hp > 0));
        const stage = { x: ent.x + anchor.ux * (range + 4.5), y: ent.y + anchor.uy * (range + 4.5) };
        goal = { ...stage };
        await waitForSim(
          h,
          () => {
            const near = dronesAlive().filter((d) => Math.hypot(d.x - stage.x, d.y - stage.y) <= 7).length;
            return near >= 4 ? { near } : null;
          },
          2400,
          `${kind} fodder flock staging`,
          300,
        );
        goal = { x: ent.x + anchor.ux * 2.8, y: ent.y + anchor.uy * 2.8 };
        await sleep(2400);
        await waitForSim(
          h,
          () => {
            let bd = Infinity;
            for (const d of dronesAlive()) bd = Math.min(bd, Math.hypot(d.x - ent.x, d.y - ent.y));
            return bd <= range * 0.75 ? { bd } : null;
          },
          600,
          `${kind} flush closing`,
          200,
        );
        const savedGoal = goal;
        goal = null;
        await sleep(900);
        let cap;
        try {
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
  const ent = await waitSpawned(h, "a", "harvester", h.seenUnits, 150000);
  h.seenUnits.add(ent.id);
  order(h, "a", [ent.id], "harvest", ent.x + 4, ent.y + 4);
  await sleep(2600);
  return recordClip(h, "harvester", ent.id, 4300, 13);
}

async function captureSupplyTruck(h) {
  await train(h, "a", "supplytruck", 1);
  const ent = await waitSpawned(h, "a", "supplytruck", h.seenUnits, 150000);
  h.seenUnits.add(ent.id);
  const armor = ownedUnits(h, "a").find((e) => e.k === "tank") ?? ent;
  order(h, "a", [ent.id], "move", armor.x + 2, armor.y + 2);
  await sleep(2300);
  return recordClip(h, "supplytruck", ent.id, 3800, 13);
}

async function captureEngineer(h) {
  await train(h, "a", "engineer", 1);
  const ent = await waitSpawned(h, "a", "engineer", h.seenUnits, 150000);
  h.seenUnits.add(ent.id);
  const neutrals = entList(h).filter((e) => (e.k === "derrick" || e.k === "coalmine") && e.o < 0);
  const neutral = neutrals.length ? nearestTo(neutrals, ent) : null;
  const enemyBld = ownedBuildings(h, "b")[0];
  const target = neutral ?? enemyBld;
  if (!target) throw new Error("engineer: no capturable target");
  order(h, "a", [ent.id], "attack", target.x, target.y, target.id);

  // In-page trigger + recording: the capture IS the clip — engineer walks in,
  // vanishes, the building converts. Harness-side proximity triggers fired
  // minutes-stale in the skew sessions and filmed the aftermath.
  const spec = {
    starId: ent.id,
    enemySlot: h.conns.b.slot,
    targetId: target.id,
    triggerDist: 7.5,
    mode: "timed",
    durationMs: 4000,
    maxRecMs: 8000,
    maxWaitTicks: 1500,
    maxWaitMs: 200000,
    cameraHeight: 12,
    autoFrame: true,
    minH: 10,
    maxH: 13.5,
    marginPx: 24,
    attackerWeight: 0.35,
    preRollMs: 200,
    cropFx: CROP_W / VW,
    cropFy: CROP_H / VH,
  };
  const { promise } = await pageCaptureEngagement(h, spec);
  const rec = await promise;
  if (rec.error) throw new Error(`engineer capture: ${rec.error}`);
  const webm = join(TMP_DIR, `${h.session.id}-engineer.webm`);
  writeFileSync(webm, Buffer.from(rec.bytes));
  const entry = enqueueEncode(h, { webm, out: join(OUT_DIR, "engineer.gif"), kind: "engineer", anchor: "head", durationMs: rec.tapeMs });
  return entry.promise;
}

// Spy infiltration — a dedicated-session capture. The only legal sabotage
// targets are enemy buildings across the map, and the spy is CONSUMED the
// instant it touches one (edge distance 0.9 vs a conyard half-width of 1.5 —
// center-distance ~2.4). The old harness-side trigger at 5.5 center-dist left
// a 2-3s window that the skewed stream burned entirely; the in-page trigger at
// 8.5 tiles starts the tape with the spy still visibly walking in, covers the
// consume and the cash-popup aftermath, and can't go stale because it reads
// the same state the renderer draws.
async function captureSpy(h) {
  await train(h, "a", "spy", 1);
  const ent = await waitSpawned(h, "a", "spy", h.seenUnits, 150000);
  h.seenUnits.add(ent.id);
  // Victim geometry is destiny: SPY_CAPTURE_RANGE is 0.9 edge-distance, but
  // nearestPassable's spiral hits a corner-diagonal tile first for ODD-square
  // footprints (probe-verified: the spy stalls at edge 0.96 outside a conyard
  // FOREVER — arrival slop 0.35 on top of the corner tile's 0.707 edge
  // distance). Even 2x2 footprints scan-hit a flat-adjacent tile first (edge
  // 0.5 at the waypoint, consume certain). supplyhub is the ideal victim:
  // 2x2, and the default-case cash steal renders the green income popup.
  const blds = ownedBuildings(h, "b");
  const even2 = blds.filter((e) => {
    const d = gd.BUILDINGS[e.k];
    return d && d.w === 2 && d.h === 2;
  });
  const target =
    even2.find((e) => e.k === "supplyhub") ??
    even2.find((e) => e.k === "radar") ??
    even2[0] ??
    blds.find((e) => e.k === "conyard") ??
    blds[0];
  if (!target) throw new Error("spy: no enemy building");
  const spec = {
    starId: ent.id,
    enemySlot: h.conns.b.slot,
    targetId: target.id,
    triggerDist: 8,
    // Event-driven like the kamikazes: the consume IS the money shot — the spy
    // vanishes into the building and the cash popup plays. A fixed-length tape
    // gambles on pathing+sim speed and lost that bet in the first take (spy
    // corner-stuck adjacent to the conyard, tape ended before the entry).
    mode: "impact",
    tailMs: 2400,
    maxRecMs: 30000,
    maxWaitTicks: 2200,
    maxWaitMs: 240000,
    cameraHeight: 12,
    autoFrame: true,
    minH: 9.5,
    maxH: 13,
    marginPx: 24,
    attackerWeight: 0.4,
    preRollMs: 220,
    cropFx: CROP_W / VW,
    cropFy: CROP_H / VH,
  };
  const { promise } = await pageCaptureEngagement(h, spec);
  order(h, "a", [ent.id], "attack", target.x, target.y, target.id);
  let finished = false;
  const supervise = (async () => {
    // Same silent-drop workaround as combat captures: spies are dmg-0 units
    // whose attack orders ride the same canAttack path (buildings only).
    while (!finished) {
      await sleep(800);
      if (finished) break;
      const star = getEnt(h, ent.id);
      if (!star) break;
      const wp = star.wp;
      const attacking = Array.isArray(wp) && wp.length > 0 && wp[0][2] === "attack";
      if (!attacking) {
        const tgt = getEnt(h, target.id);
        if (tgt) order(h, "a", [ent.id], "attack", tgt.x, tgt.y, tgt.id);
      }
    }
  })().catch(() => {});
  const rec = await promise;
  finished = true;
  await supervise;
  if (rec.error) throw new Error(`spy capture: ${rec.error}${rec.lastD != null ? ` lastD=${rec.lastD?.toFixed(1)}` : ""}`);
  if (!rec.bytes?.length) throw new Error("spy capture: empty tape");
  if (DEBUG) {
    console.log(
      `  [dbg] spy: tape=${(rec.tapeMs / 1000).toFixed(1)}s trigD=${rec.trig.d.toFixed(1)} camH=${rec.camH} impact=${rec.impactKind ?? "none"}@${rec.impactT == null ? "-" : (rec.impactT / 1000).toFixed(1)}s`,
    );
  }
  const webm = join(TMP_DIR, `${h.session.id}-spy.webm`);
  writeFileSync(webm, Buffer.from(rec.bytes));
  // Sabotage window: the final walk-in beat, the vanish, and the cash popup.
  const trim = impactTrim(rec, 2.8, 2.0);
  const entry = enqueueEncode(h, { webm, out: join(OUT_DIR, "spy.gif"), kind: "spy", anchor: "tail", durationMs: rec.tapeMs, trim });
  return entry.promise;
}

async function captureEwDrone(h) {
  await train(h, "a", "ewdrone", 1);
  const ent = await waitSpawned(h, "a", "ewdrone", h.seenUnits, 150000);
  h.seenUnits.add(ent.id);
  const st = stageFor(h, "a");
  order(h, "a", [ent.id], "move", st.x, st.y);
  await sleep(2400);
  return recordClip(h, "ewdrone", ent.id, 3900, 14);
}

// Minimal per-session tech trees. Every list carries exactly what the session's
// stars and fodder need — full-tech sessions cost minutes of build time each
// and the QA postmortem showed most of that time is pure waste (the spy needs
// a barracks+radar, not an airfield).
const TECH = {
  spy: { buildings: ["power", "barracks", "radar"] },
  // Victim base: the supplyhub is the sabotage target (2x2 — flat-adjacent
  // consume geometry, cash-steal popup), radar blows the spy's cover so the
  // true spy model renders on the final approach.
  spyVictim: { buildings: ["power", "barracks", "refinery", "radar", "supplyhub"] },
  armor: { buildings: ["power", "power", "barracks", "radar", "factory", "techlab"], upgrades: [["factory", "factory2"]] },
  air: { buildings: ["power", "power", "barracks", "radar", "factory", "techlab", "airfield"], upgrades: [["airfield", "airfield2"]] },
  naval: { buildings: ["power", "shipyard"] },
  fodderLand: { buildings: ["power", "refinery", "factory"] },
  fodderSea: { buildings: ["power", "shipyard"] },
  landeco: { buildings: ["power", "refinery", "barracks", "radar", "factory"] },
  airfull: { buildings: ["power", "refinery", "barracks", "radar", "factory", "techlab", "airfield"], upgrades: [["airfield", "airfield2"]] },
  navalfull: { buildings: ["power", "refinery", "barracks", "radar", "factory", "techlab", "shipyard"], upgrades: [["shipyard", "shipyard2"]] },
};

const SESSIONS = [
  {
    id: "field",
    map: "crossroads",
    derricks: true,
    tech: TECH.landeco,
    enemyTech: true,
    units: ["engineer", "infantry", "rocket", "fpvdrone", "harvester", "supplytruck"],
  },
  {
    id: "spyop",
    map: "crossroads",
    tech: TECH.spy,
    enemyTechTree: TECH.spyVictim,
    fodder: null,
    units: ["spy"],
  },
  {
    id: "armor",
    map: "crossroads",
    tech: TECH.armor,
    enemyTechTree: TECH.fodderLand,
    units: ["tank", "himars", "railtank", "ballistic"],
  },
  {
    id: "air",
    map: "crossroads",
    tech: TECH.air,
    enemyTechTree: TECH.fodderLand,
    units: ["uav", "shahed", "ewdrone", "interceptor", "chopper", "a10", "ac130", "hypersonic"],
  },
  {
    id: "stealth",
    map: "crossroads",
    tech: TECH.air,
    enemyTechTree: TECH.fodderLand,
    units: ["stealthbomber"],
  },
  {
    id: "naval",
    map: "islands",
    tech: TECH.naval,
    enemyTechTree: TECH.fodderSea,
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
  // spyop shadows field for the spy: it is the lean dedicated session.
  if (unit === "spy") return "spyop";
  for (const s of SESSIONS) if (s.units.includes(unit) && s.id !== "spyop") return s.id;
  return null;
}

// Per-unit capture shaping for the in-page engagement recorder.
function combatOptsFor(unit) {
  const o = {};
  if (unit === "shahed" || unit === "fpvdrone") {
    // Kamikaze: impact-event tape. Trigger distance is computed from closing
    // speed — 0.28 tiles/tick at 20 ticks/s = 5.6 tiles/s nominal, so ~11
    // tiles buys ~1.7s of inbound dive before the boom even at full sim speed.
    o.mode = "impact";
    o.triggerDist = 11;
    o.tailMs = 1900;
    o.attackerWeight = 0.3;
    o.cameraHeight = 13;
  }
  if (unit === "usv") {
    o.mode = "impact";
    o.triggerDist = 12;
    o.tailMs = 1900;
    o.attackerWeight = 0.3;
    o.cameraHeight = 13;
  }
  if (unit === "hypersonic") {
    // Mach-9: 1.25 tiles/tick = 25 tiles/s nominal. Even 26 tiles of trigger
    // distance is barely a second of inbound — the strike flash IS the clip.
    o.mode = "impact";
    o.triggerDist = 27;
    o.tailMs = 2000;
    o.attackerWeight = 0.15;
    o.cameraHeight = 14;
  }
  if (unit === "stealthbomber") {
    o.durationMs = 4800;
    o.cameraHeight = 13;
    o.autoFrame = true;
    o.minH = 11;
    o.maxH = 15.5;
    o.attackerWeight = 0.5;
    o.trainTimeoutMs = 200000;
    o.freezeFodder = true;
  }
  if (unit === "ac130") {
    o.durationMs = 4600;
    o.autoFrame = true;
    o.minH = 11;
    o.maxH = 15;
    o.attackerWeight = 0.5;
    // The gunship's own muzzle flashes at point-blank range bloom into a
    // whiteout that hid the star for the entire first capture — bloom off.
    o.bloom = false;
    o.freezeFodder = true;
  }
  if (unit === "himars" || unit === "ballistic") {
    // Long tapes + first-hit windowing: the sim slow-motions under load and a
    // 5s wall-clock tape can end before the first volley even leaves the tube.
    // The trim window is placed on the observed hp drop post-hoc, so length
    // here is pure insurance — the gif itself is cut tight around the launch.
    o.durationMs = unit === "ballistic" ? 8000 : 7000;
    o.maxRecMs = 12000;
    o.autoFrame = true;
    o.minH = 10.5;
    o.maxH = 17.5;
    o.marginPx = 44;
    o.attackerWeight = 0.5;
    o.freezeFodder = true;
    o.cameraHeight = unit === "ballistic" ? 15 : 13.5;
  }
  if (unit === "dreadnought" || unit === "carrier") o.cameraHeight = 15;
  return o;
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
    const enemyTree = session.enemyTechTree ?? (session.enemyTech ? session.tech : null);
    if (enemyTree) builds.push(buildTech(h, "b", enemyTree));
    await Promise.all(builds);
    if (session.naval) stopSeaShuffle = startSeaShuffle(h);
    // Open the spectator browser NOW, not lazily at the first capture: the
    // client needs its keyframe, mesh warmup and a few rendered frames before
    // the canvas is worth sampling, and the first capture of a session must
    // not pay that price inside its own window.
    ensureBrowser(h).catch(() => {});

    // Warm up target flocks for every domain this session will need, floating
    // in the background — the first capture's just-in-time ensureTargets call
    // then finds them already trained or well on the way.
    const neededDomains = [...new Set(wantedUnits.filter((u) => u in UNITS && UNITS[u].dmg > 0).map((u) => targetDomainFor(u)))];
    for (const dom of neededDomains) ensureTargets(h, dom, 2).catch(() => {});

    for (let i = 0; i < wantedUnits.length; i++) {
      const unit = wantedUnits[i];
      const nextUnit = wantedUnits[i + 1];
      try {
        let cap;
        if (unit === "spy") cap = await captureSpy(h);
        else if (unit === "harvester") cap = await captureHarvester(h);
        else if (unit === "supplytruck") cap = await captureSupplyTruck(h);
        else if (unit === "engineer") cap = await captureEngineer(h);
        else if (unit === "ewdrone") cap = await captureEwDrone(h);
        else {
          cap = await captureCombat(h, unit, { ...combatOptsFor(unit), nextUnit });
        }
        result.captured[unit] = { ...cap, stage: st };
        console.log(`PASS ${unit} (${fmtBytes(cap.size)}, ${cap.quality}) room=${h.room}`);
      } catch (err) {
        result.ok = false;
        result.errors[unit] = err?.message || String(err);
        console.log(`FAIL ${unit}: ${result.errors[unit]}`);
      }
    }
    result.pageErrors = h.pageErrors;
  } catch (err) {
    result.ok = false;
    result.errors.session = err?.message || String(err);
    console.log(`FAIL session ${session.id}: ${result.errors.session}`);
  } finally {
    // Drain pending encodes before tearing down — gifs must be complete on disk.
    try {
      await h.encodeChain;
    } catch {}
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
