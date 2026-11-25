#!/usr/bin/env node
/**
 * Open Alert — Standalone Stdio MCP Server for Claude Code & MCP Clients
 *
 * Zero external npm dependencies at runtime (requires Node.js >= 22 with built-in
 * WebSocket & fetch; Node >= 24 recommended). Speaks MCP JSON-RPC 2.0 (protocol
 * 2024-11-05) over line-delimited stdio. Connects directly to any Open Alert
 * server over PartyKit WebSocket so Claude Code gets real-time snapshots and
 * zero-latency RTS orders.
 *
 * GAME DEFINITIONS ARE SINGLE-SOURCED: at startup the REAL defs are loaded straight
 * from src/shared/gamedefs.ts — never mirrored by hand. Loader cascade:
 *   1. native Node type-stripping import of the .ts file (Node >= 23.6, zero deps)
 *   2. esbuild bundle at startup (transitive dep of vite/wrangler in node_modules)
 *   3. typescript transpileModule fallback (typescript is a devDependency)
 * If gamedefs.ts gains new units/buildings/maps/constants, this server picks them
 * up on the next restart — no drift possible.
 *
 * Environment variables:
 *   OA_URL   Base HTTP(S) URL of the Open Alert server
 *            (default: https://open-alert.thapecroth.workers.dev)
 *            Examples: http://localhost:8787
 */

import readline from "node:readline";
import crypto from "node:crypto";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "open-alert-mcp", version: "1.1.0" };
const BASE_URL = (process.env.OA_URL || "https://open-alert.thapecroth.workers.dev").replace(/\/+$/, "");
const WS_BASE_URL = BASE_URL.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");

const PARTY_NAME = "game-room";

const log = (...args) => {
  process.stderr.write(`[open-alert-mcp] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
};

// ---------- Game Definitions (single-sourced from src/shared/gamedefs.ts) ----------

async function loadGameDefs() {
  const defsUrl = new URL("../src/shared/gamedefs.ts", import.meta.url);
  const errors = [];
  const valid = (mod) => mod && mod.BUILDINGS && mod.UNITS && mod.MAP_LIST && typeof mod.getMapLayout === "function";

  // 1) Native type-stripping import (Node >= 23.6; zero dependencies — same
  //    pattern the repo's own test/*.mjs files use). Handles additive changes
  //    with zero startup cost. Fails fast on older Node or non-erasable TS
  //    syntax (enums/namespaces), in which case we fall through.
  try {
    const mod = await import(defsUrl.href);
    if (valid(mod)) return { mod, via: "native-strip-types" };
    errors.push("native import: gamedefs module missing expected exports");
  } catch (err) {
    errors.push(`native import: ${err?.message || err}`);
  }

  // 2) esbuild bundle — handles ALL TypeScript syntax and any future internal
  //    imports gamedefs.ts may gain. esbuild ships as a transitive dep of
  //    vite/wrangler in this repo's node_modules.
  try {
    const esbuild = await import("esbuild");
    const { fileURLToPath } = await import("node:url");
    const result = esbuild.buildSync({
      entryPoints: [fileURLToPath(defsUrl)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      logLevel: "silent",
    });
    const code = result.outputFiles[0].text;
    const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`);
    if (valid(mod)) return { mod, via: "esbuild-bundle" };
    errors.push("esbuild bundle: gamedefs module missing expected exports");
  } catch (err) {
    errors.push(`esbuild: ${err?.message || err}`);
  }

  // 3) typescript transpileModule — typescript is a direct devDependency.
  try {
    const tsMod = await import("typescript");
    const ts = tsMod.default ?? tsMod;
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(defsUrl), "utf8");
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(out.outputText)}`);
    if (valid(mod)) return { mod, via: "typescript-transpile" };
    errors.push("typescript transpile: gamedefs module missing expected exports");
  } catch (err) {
    errors.push(`typescript: ${err?.message || err}`);
  }

  throw new Error(
    "Could not load game definitions from src/shared/gamedefs.ts.\n" +
      errors.map((e) => `  - ${e}`).join("\n") +
      "\nFix: use Node >= 24, or run `npm install` in the open-alert repo so esbuild/typescript are available.",
  );
}

const { mod: gd, via: defsVia } = await loadGameDefs();

const BUILDINGS = gd.BUILDINGS;
const UNITS = gd.UNITS;
const MAP_LIST = gd.MAP_LIST;
const UPGRADE_PATHS = gd.UPGRADE_PATHS ?? {};
const TICK_MS = gd.TICK_MS ?? 100;
const SHIPYARD_BUILD_DIST = gd.SHIPYARD_BUILD_DIST ?? 13;
const DEFAULT_MAP_W = gd.MAP_W ?? 64; // design-grid default — real per-map dims come from MAP_LIST / live init
const DEFAULT_MAP_H = gd.MAP_H ?? 64;

const BUILDABLE_KINDS = Object.entries(BUILDINGS)
  .filter(([, d]) => !d.noBuild)
  .map(([k]) => k);

const UNIT_KINDS = Object.keys(UNITS);
const MAP_IDS = MAP_LIST.map((m) => m.id);
const MAX_PLAYERS = gd.MAX_PLAYERS ?? 8;
const MAP_META = new Map(MAP_LIST.map((m) => [m.id, m]));
const NAVAL_MAPS = MAP_LIST.filter((m) => m.naval).map((m) => m.id);
// Largest dimension across all maps — used only as a loose upper bound in tool
// schemas (the server validates authoritative per-map bounds).
const MAX_MAP_DIM = Math.max(DEFAULT_MAP_W, ...MAP_LIST.map((m) => Math.max(m.w ?? 0, m.h ?? 0)));
// Human-readable summary of actual map dimensions, e.g. "96x96/128x128" — generated
// from MAP_LIST so it can never go stale when maps are added or resized.
const MAP_DIM_SUMMARY = [...new Set(MAP_LIST.map((m) => `${m.w ?? DEFAULT_MAP_W}x${m.h ?? DEFAULT_MAP_H}`))].join("/") || `${DEFAULT_MAP_W}x${DEFAULT_MAP_H}`;

// Inverse upgrade map for tech-prerequisite satisfaction, mirroring world.ts
// hasBuilding(): owning the upgraded (MKII) form of a prerequisite satisfies it.
// Prefer the canonical table from gamedefs when present; otherwise derive it
// single-step from UPGRADE_PATHS (same shape: base kind -> upgraded kind).
const UPGRADED_OF =
  gd.UPGRADED_OF && typeof gd.UPGRADED_OF === "object"
    ? gd.UPGRADED_OF
    : Object.fromEntries(Object.values(UPGRADE_PATHS).map((p) => [p.from, p.to]));

function ownsOrUpgraded(ownedKinds, kind) {
  if (ownedKinds.has(kind)) return true;
  const up = UPGRADED_OF[kind];
  if (up && ownedKinds.has(up)) return true;
  // world.ts power-lineage rule: upgraded power plants (coal/fusion) count as a Power Plant
  if (kind === "power" && (ownedKinds.has("coalplant") || ownedKinds.has("fusion"))) return true;
  return false;
}

const isBuilding = (k) => Object.prototype.hasOwnProperty.call(BUILDINGS, k);
const r1 = (n) => Math.round(n * 10) / 10;

function mapDims(mapId) {
  const meta = MAP_META.get(mapId);
  return { w: meta?.w ?? DEFAULT_MAP_W, h: meta?.h ?? DEFAULT_MAP_H };
}

// ---------- Terrain Geometry (exact server geometry via real getMapLayout) ----------

const terrainCache = new Map();

function getTerrainSets(mapId = "crossroads") {
  const cached = terrainCache.get(mapId);
  if (cached) return cached;

  let res;
  try {
    const layout = gd.getMapLayout(mapId);
    const cliff = new Set();
    const water = new Set();
    for (const [x, y] of layout.cliffs) cliff.add(y * layout.w + x);
    for (const [x, y] of layout.water) water.add(y * layout.w + x);
    res = { cliff, water, w: layout.w, h: layout.h };
  } catch {
    // Unknown/newer map — degrade to empty terrain rather than wrong terrain.
    const { w, h } = mapDims(mapId);
    res = { cliff: new Set(), water: new Set(), w, h };
  }
  terrainCache.set(mapId, res);
  return res;
}

// ---------- Description generators (tool schemas stay accurate forever) ----------

function fmtCost(def) {
  return `$${def.cost}`;
}

function buildingBlurb(kind) {
  const d = BUILDINGS[kind];
  const parts = [`${kind} ${fmtCost(d)} ${d.w}x${d.h} ${d.power >= 0 ? "+" : ""}${d.power}pwr`];
  if (d.requires?.length) parts.push(`req ${d.requires.join("+")}`);
  if (d.waterOnly) parts.push("water-only");
  if (d.forwardRange) parts.push(`forward-range ${d.forwardRange}`);
  if (d.category === "defense") parts.push("defense-queue");
  if (d.limit) parts.push(`limit ${d.limit}`);
  if (d.range) parts.push(`rng ${d.range}`);
  if (d.dmg) parts.push(`dmg ${d.dmg}`);
  return parts.join(" ");
}

function unitBlurb(kind) {
  const d = UNITS[kind];
  const parts = [`${kind} ${fmtCost(d)}`];
  if (d.dmg) parts.push(`dmg ${d.dmg}`);
  if (d.range) parts.push(`rng ${d.range}`);
  parts.push(d.domain);
  if (d.requires) parts.push(`req ${d.requires}`);
  if (d.kamikaze) parts.push("kamikaze");
  if (d.stealth) parts.push("stealth");
  if (d.retired) parts.push("RETIRED-legacy");
  return parts.join(" ");
}

function buildingsDescription() {
  return "Building types (cost size power prerequisites): " + BUILDABLE_KINDS.map(buildingBlurb).join("; ");
}

function unitsDescription() {
  const byCat = {};
  for (const k of UNIT_KINDS) {
    const cat = UNITS[k].trainsAt;
    (byCat[cat] ??= []).push(unitBlurb(k));
  }
  return (
    "Unit types by production building: " +
    Object.entries(byCat)
      .map(([cat, list]) => `${cat}→ ${list.join(", ")}`)
      .join(" | ")
  );
}

function upgradeDescription() {
  const paths = Object.values(UPGRADE_PATHS)
    .map((p) => `${p.from}→${p.to} ${fmtCost(p)} req ${p.requires}`)
    .join("; ");
  return `upgrade a production/power building along its tech path (${paths}). Auto-selects your War Factory (or first upgradeable building) when 'id' omitted.`;
}

function placeRulesDescription() {
  const maxForward = Math.max(2, ...Object.values(BUILDINGS).map((d) => d.forwardRange ?? 0));
  return (
    `Place a finished building currently waiting in 'awaiting' (structures) or 'awaitingDef' (defenses) at integer top-left tile coordinates. ` +
    `Must be within 2 tiles of an existing own building (${SHIPYARD_BUILD_DIST} tiles on water for Naval Shipyard, up to ${maxForward} for a Forward Supply Hub) ` +
    `and clear of cliffs, water (for land buildings), ore, and same-domain units. ` +
    `Map dimensions vary per map (${MAP_DIM_SUMMARY}) — read map_size from get_game_state rather than assuming.`
  );
}

// ---------- Helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitizeRoom(room) {
  const r = String(room || "").trim();
  if (!/^[a-z0-9-]{2,32}$/i.test(r)) {
    throw new Error(`Invalid room ID "${room}": use 2-32 alphanumeric characters or hyphens.`);
  }
  return r;
}

function roomUrls(room) {
  const enc = encodeURIComponent(room);
  return {
    watch_url: `${BASE_URL}/?room=${enc}&spectate=1`,
    play_url: `${BASE_URL}/?room=${enc}`,
    dashboard_url: `${BASE_URL}/?watch=1`,
  };
}

// Normalize the finished-placement piles across server versions: current servers
// send awaiting/awaitingDef as BuildingKind[] arrays; older ones sent a scalar.
function asKindList(v) {
  if (Array.isArray(v)) return v.filter((k) => typeof k === "string");
  return typeof v === "string" ? [v] : [];
}

// ---------- Live Room WebSocket Session Manager ----------

class RoomSession {
  constructor(room, name = "Claude", spectate = false, token = null) {
    this.room = room;
    this.name = String(name || "Claude").slice(0, 16).trim() || "Claude";
    this.spectate = !!spectate;
    this.token =
      typeof token === "string" && token.length > 0 && token.length <= 64
        ? token
        : `mcp-${crypto.randomUUID().slice(0, 10)}`;

    this.ws = null;
    this.hbTimer = null;
    this.connected = false;

    this.phase = "lobby";
    this.map = "crossroads";
    this.config = null;
    const dims = mapDims(this.map);
    this.w = dims.w;
    this.h = dims.h;

    this.you = "";
    this.slot = -1;
    this.host = false;
    this.spectator = this.spectate;

    this.lobbyPlayers = [];
    this.playersMeta = new Map(); // slot -> { id, slot, name, team }
    this.tick = 0;
    this.ents = new Map(); // id -> EntSnap
    this.crates = [];
    this.playerStates = {}; // slot -> PlayerState
    this.ore = new Map(); // tileIdx (keyed by this.w) -> amount
    this.recentEvents = []; // rolling log
    this.denies = []; // { at, tick, msg }
    this.endInfo = null;
    this.lastSnapAt = 0;

    this._waiters = []; // { pred, resolve, reject, timer }
  }

  // Tile index in the LIVE map dimensions — never a hardcoded constant.
  idx(x, y) {
    return y * this.w + x;
  }

  // Update w/h from the static map meta (lobby phase, before init arrives with
  // the authoritative server-side dimensions).
  noteMap(mapId) {
    if (typeof mapId === "string" && mapId) {
      this.map = mapId;
      const dims = mapDims(mapId);
      this.w = dims.w;
      this.h = dims.h;
    }
  }

  wsUrl() {
    return `${WS_BASE_URL}/parties/${PARTY_NAME}/${encodeURIComponent(this.room)}`;
  }

  isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(timeoutMs = 8000) {
    if (this.isOpen()) return;
    this.closeSocketOnly();

    const url = this.wsUrl();
    log(`Connecting to ${url} as ${this.name} (spectate=${this.spectate})`);

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch {}
          reject(new Error(`WebSocket connect timeout (${timeoutMs}ms) to ${url}`));
        }
      }, timeoutMs);

      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        this.startHeartbeat();
        this.send({
          t: "join",
          name: this.name,
          token: this.token,
          ...(this.spectate ? { spectate: true } : {}),
        });
        resolve();
      });

      ws.addEventListener("message", (ev) => {
        try {
          const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
          const msg = JSON.parse(raw);
          this.handleMessage(msg);
        } catch (err) {
          log("Failed to parse server message:", err.message);
        }
      });

      ws.addEventListener("error", (ev) => {
        const errMsg = ev?.message || "WebSocket connection error";
        log(`WS error (${this.room}): ${errMsg}`);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket error connecting to ${url}: ${errMsg}`));
        }
      });

      ws.addEventListener("close", (ev) => {
        log(`WS closed (${this.room}): code=${ev.code} reason=${ev.reason || ""}`);
        this.connected = false;
        this.stopHeartbeat();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket closed before opening (code=${ev.code} ${ev.reason || ""})`));
        }
      });
    });

    // Wait for initial lobby or init message from the server
    await this.waitFor((m) => m.t === "lobby" || m.t === "init" || m.t === "deny", 6000).catch(() => null);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.hbTimer = setInterval(() => {
      if (this.isOpen()) {
        try {
          this.ws.send(JSON.stringify({ t: "hb" }));
        } catch {
          // ignore
        }
      }
    }, 15000);
    if (typeof this.hbTimer.unref === "function") this.hbTimer.unref();
  }

  stopHeartbeat() {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  closeSocketOnly() {
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close(1000, "mcp shutdown");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
  }

  send(msg) {
    if (!this.isOpen()) {
      throw new Error(`Not connected to room "${this.room}". Call join_game first.`);
    }
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(pred, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const entry = {
        pred,
        resolve: (m) => {
          clearTimeout(entry.timer);
          resolve(m);
        },
        reject: (err) => {
          clearTimeout(entry.timer);
          reject(err);
        },
        timer: setTimeout(() => {
          const i = this._waiters.indexOf(entry);
          if (i >= 0) this._waiters.splice(i, 1);
          reject(new Error("timeout"));
        }, timeoutMs),
      };
      if (typeof entry.timer.unref === "function") entry.timer.unref();
      this._waiters.push(entry);
    });
  }

  pushEvent(ev) {
    this.recentEvents.push({ tick: this.tick, ...ev });
    if (this.recentEvents.length > 30) {
      this.recentEvents.splice(0, this.recentEvents.length - 30);
    }
  }

  handleMessage(m) {
    if (!m || typeof m !== "object") return;

    if (m.t === "lobby") {
      this.lobbyPlayers = Array.isArray(m.players) ? m.players : [];
      this.you = m.you || this.you;
      if (m.map) this.noteMap(m.map);
      if (m.phase) this.phase = m.phase;
      if (m.config) this.config = m.config;
      const me = this.lobbyPlayers.find((p) => p.id === this.you);
      if (me) {
        this.slot = me.slot;
        this.host = !!me.host;
        this.spectator = !!me.spectator;
      }
      for (const p of this.lobbyPlayers) {
        if (p.slot >= 0) {
          this.playersMeta.set(p.slot, { id: p.id, slot: p.slot, name: p.name, team: p.team ?? 0, bot: !!p.bot });
        }
      }
    } else if (m.t === "init") {
      this.phase = "playing";
      this.endInfo = null;
      this.you = m.you || this.you;
      this.slot = typeof m.slot === "number" ? m.slot : this.slot;
      this.spectator = this.slot < 0;
      // Authoritative live map dimensions from the server — correct for 64/96/128 maps.
      if (typeof m.w === "number" && m.w > 0) this.w = m.w;
      if (typeof m.h === "number" && m.h > 0) this.h = m.h;
      if (m.map) {
        this.map = m.map;
        if (!m.w || !m.h) {
          const dims = mapDims(m.map);
          if (!m.w) this.w = dims.w;
          if (!m.h) this.h = dims.h;
        }
      }
      this.ore.clear();
      if (Array.isArray(m.ore)) {
        for (const [x, y, amt] of m.ore) {
          if (amt > 0) this.ore.set(this.idx(x, y), amt);
        }
      }
      if (Array.isArray(m.players)) {
        this.playersMeta.clear();
        for (const p of m.players) {
          this.playersMeta.set(p.slot, { id: p.id, slot: p.slot, name: p.name, team: p.team ?? 0 });
        }
      }
      this.ents.clear();
      this.crates = [];
      this.recentEvents = [];
    } else if (m.t === "snap") {
      this.phase = "playing";
      this.tick = m.tick ?? this.tick;
      this.lastSnapAt = Date.now();
      this.ents.clear();
      if (Array.isArray(m.ents)) {
        for (const e of m.ents) this.ents.set(e.id, e);
      }
      this.crates = Array.isArray(m.crates) ? m.crates : [];
      if (m.players && typeof m.players === "object") {
        this.playerStates = m.players;
      }
      if (Array.isArray(m.events)) {
        for (const ev of m.events) {
          if (ev.e === "ore" && Array.isArray(ev.cells)) {
            for (const [x, y, amt] of ev.cells) {
              if (amt <= 0) this.ore.delete(this.idx(x, y));
              else this.ore.set(this.idx(x, y), amt);
            }
          } else if (
            ev.e === "alert" ||
            ev.e === "cap" ||
            ev.e === "elim" ||
            ev.e === "superweapon" ||
            ev.e === "recon" ||
            ev.e === "promote" ||
            ev.e === "crate"
          ) {
            this.pushEvent(ev);
          }
        }
      }
    } else if (m.t === "end") {
      this.phase = "ended";
      this.endInfo = {
        winner: m.winner,
        winnerTeam: m.winnerTeam ?? null,
        reason: m.reason,
        durationSec: m.durationSec ?? null,
        stats: m.stats ?? [],
      };
      this.pushEvent({ e: "end", winner: m.winner, reason: m.reason });
    } else if (m.t === "chat") {
      this.pushEvent({ e: "chat", name: m.name, text: m.text });
    } else if (m.t === "ping") {
      this.pushEvent({ e: "ping", slot: m.slot, x: r1(m.x), y: r1(m.y) });
    } else if (m.t === "deny") {
      const rec = { at: Date.now(), tick: this.tick, msg: m.msg };
      this.denies.push(rec);
      if (this.denies.length > 20) this.denies.shift();
      this.pushEvent({ e: "deny", msg: m.msg });
    }

    // Wake any waiters matching this message
    if (this._waiters.length) {
      const remaining = [];
      for (const w of this._waiters) {
        if (w.pred(m)) {
          w.resolve(m);
        } else {
          remaining.push(w);
        }
      }
      this._waiters = remaining;
    }
  }

  myPlayerState() {
    if (this.slot < 0) return null;
    return this.playerStates[this.slot] ?? this.playerStates[String(this.slot)] ?? null;
  }

  myTeam() {
    const meta = this.playersMeta.get(this.slot);
    if (meta && typeof meta.team === "number") return meta.team;
    const ps = this.myPlayerState();
    return ps?.team ?? 0;
  }

  isEnemySlot(otherSlot) {
    if (otherSlot < 0) return false; // neutral
    if (this.slot < 0) return true; // spectator sees all players
    if (otherSlot === this.slot) return false;
    const myT = this.myTeam();
    const otherMeta = this.playersMeta.get(otherSlot);
    const otherT = otherMeta?.team ?? (this.playerStates[otherSlot]?.team ?? 0);
    if (myT > 0 && otherT === myT) return false;
    return true;
  }

  /**
   * Compute valid top-left placement tiles [tx, ty] for `kind`, mirroring
   * src/server/world.ts canPlace(): footprint clear of cliffs/ore/units, waterOnly
   * hulls fully on water, adjacency gap <= 2 (SHIPYARD_BUILD_DIST on water,
   * forwardRange for Forward Supply Hubs). Uses exact terrain geometry from the
   * real getMapLayout() and the session's live map dimensions.
   */
  findValidBuildSpots(kind, limit = 6) {
    const def = BUILDINGS[kind];
    if (!def || this.slot < 0) return [];
    const W = this.w;
    const H = this.h;
    const ownBuildings = [];
    const occupied = new Set();
    const unitTiles = new Set();
    const bDomain = def.waterOnly ? "sea" : "land";

    for (const e of this.ents.values()) {
      if (isBuilding(e.k)) {
        const bd = BUILDINGS[e.k];
        const bx = Math.round(e.x - bd.w / 2);
        const by = Math.round(e.y - bd.h / 2);
        for (let y = by; y < by + bd.h; y++) {
          for (let x = bx; x < bx + bd.w; x++) {
            if (x >= 0 && y >= 0 && x < W && y < H) occupied.add(this.idx(x, y));
          }
        }
        if (e.o === this.slot) ownBuildings.push({ bx, by, w: bd.w, h: bd.h, cx: e.x, cy: e.y });
      } else {
        const ud = UNITS[e.k];
        if (ud && ud.domain === bDomain) {
          unitTiles.add(this.idx(Math.floor(e.x), Math.floor(e.y)));
        }
      }
    }
    if (!ownBuildings.length) return [];

    const terr = getTerrainSets(this.map);
    // Terrain sets are keyed by the layout's own width — identical to the live
    // session width whenever the defs and server agree on the map (always, in
    // practice, since both read the same gamedefs).
    const tIdx = (x, y) => y * terr.w + x;
    const maxGap = def.waterOnly ? SHIPYARD_BUILD_DIST : (def.forwardRange ?? 2);
    const baseCx = ownBuildings[0].cx;
    const baseCy = ownBuildings[0].cy;

    // Bounding box around own buildings
    let minX = W, minY = H, maxX = 0, maxY = 0;
    for (const b of ownBuildings) {
      minX = Math.min(minX, b.bx - maxGap - def.w);
      minY = Math.min(minY, b.by - maxGap - def.h);
      maxX = Math.max(maxX, b.bx + b.w + maxGap);
      maxY = Math.max(maxY, b.by + b.h + maxGap);
    }
    minX = Math.max(0, minX);
    minY = Math.max(0, minY);
    maxX = Math.min(W - def.w, maxX);
    maxY = Math.min(H - def.h, maxY);

    const candidates = [];
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        // Check adjacency first (fast)
        let adj = false;
        for (const b of ownBuildings) {
          const gapX = Math.max(b.bx - (tx + def.w), tx - (b.bx + b.w));
          const gapY = Math.max(b.by - (ty + def.h), ty - (b.by + b.h));
          if (Math.max(gapX, gapY) <= maxGap) {
            adj = true;
            break;
          }
        }
        if (!adj) continue;

        let ok = true;
        for (let y = ty; y < ty + def.h && ok; y++) {
          for (let x = tx; x < tx + def.w && ok; x++) {
            const idx = this.idx(x, y);
            const t = tIdx(x, y);
            if (terr.cliff.has(t) || occupied.has(idx) || unitTiles.has(idx)) {
              ok = false;
            } else if (def.waterOnly) {
              if (!terr.water.has(t)) ok = false;
            } else {
              if (terr.water.has(t) || this.ore.has(idx)) ok = false;
            }
          }
        }
        if (ok) {
          const dist = Math.hypot(tx + def.w / 2 - baseCx, ty + def.h / 2 - baseCy);
          candidates.push({ tx, ty, dist });
        }
      }
    }

    candidates.sort((a, b) => a.dist - b.dist);
    // Pick well-spaced top candidates
    const chosen = [];
    for (const c of candidates) {
      if (chosen.length >= limit) break;
      if (chosen.every((p) => Math.hypot(p.tx - c.tx, p.ty - c.ty) >= 2)) {
        chosen.push({ tx: c.tx, ty: c.ty });
      }
    }
    return chosen.length ? chosen : candidates.slice(0, limit).map(({ tx, ty }) => ({ tx, ty }));
  }

  nearestOreHints(anchorX, anchorY, limit = 3) {
    if (!this.ore.size) return [];
    // Bucket ore tiles into 8x8 sectors so we return crisp cluster centroids
    const sectors = new Map();
    for (const [k, amt] of this.ore.entries()) {
      const x = k % this.w;
      const y = (k / this.w) | 0;
      const sk = `${x >> 3},${y >> 3}`;
      let s = sectors.get(sk);
      if (!s) {
        s = { sumX: 0, sumY: 0, tiles: 0, totalOre: 0 };
        sectors.set(sk, s);
      }
      s.sumX += x + 0.5;
      s.sumY += y + 0.5;
      s.tiles++;
      s.totalOre += amt;
    }
    const clusters = [];
    for (const s of sectors.values()) {
      const cx = s.sumX / s.tiles;
      const cy = s.sumY / s.tiles;
      clusters.push({
        x: r1(cx),
        y: r1(cy),
        tiles: s.tiles,
        dist: r1(Math.hypot(cx - anchorX, cy - anchorY)),
      });
    }
    clusters.sort((a, b) => a.dist - b.dist);
    return clusters.slice(0, limit);
  }

  /**
   * Reconstruct the exact RL Gym `GymObs` struct from the live WebSocket snapshot
   * (1:1 schema parity with `src/server/gym.ts` `extractGymObs`).
   */
  buildGymObs() {
    const me = this.myPlayerState();
    const ents = [];
    for (const e of this.ents.values()) {
      const item = {
        id: e.id,
        o: e.o,
        k: e.k,
        x: Math.round(e.x * 100) / 100,
        y: Math.round(e.y * 100) / 100,
        hp: Math.max(0, Math.round(e.hp)),
        mhp: e.mhp,
      };
      if (e.k === "harvester") item.cargo = e.cargo ?? 0;
      ents.push(item);
    }
    const queues = {};
    if (me?.queues) {
      for (const cat of ["barracks", "factory", "airfield", "shipyard"]) {
        if (me.queues[cat]) queues[cat] = Array.isArray(me.queues[cat]) ? me.queues[cat].map((i) => ({ ...i })) : { ...me.queues[cat] };
      }
    }
    const ore = [];
    for (const [k, amt] of this.ore.entries()) {
      if (amt > 0) ore.push([k % this.w, (k / this.w) | 0, amt]);
    }
    const copyQueue = (q) => (Array.isArray(q) ? q.map((i) => ({ ...i })) : q ?? []);
    return {
      tick: this.tick,
      you: {
        slot: this.slot,
        credits: me ? Math.floor(me.credits) : 0,
        pwrHave: me ? me.pwrHave : 0,
        pwrUse: me ? me.pwrUse : 0,
        lowPower: me ? !!me.lowPower : false,
        eliminated: me ? !!me.eliminated : false,
        bq: copyQueue(me?.bq),
        awaiting: asKindList(me?.awaiting),
        dq: copyQueue(me?.dq),
        awaitingDef: asKindList(me?.awaitingDef),
        queues,
      },
      ents,
      ore,
    };
  }

  buildSummary() {
    const urls = roomUrls(this.room);
    const gymObs = this.buildGymObs();
    const base = {
      room: this.room,
      phase: this.phase,
      map: this.map,
      map_size: { w: this.w, h: this.h },
      tick: this.tick,
      elapsed_sec: r1((this.tick * TICK_MS) / 1000),
      slot: this.slot,
      done: this.phase === "ended",
      winner: this.endInfo?.winner ?? null,
      spectator: this.spectator,
      connected: this.isOpen(),
      ...urls,
    };

    if (this.phase === "lobby") {
      return {
        ...base,
        host: this.host,
        config: this.config,
        lobby_players: this.lobbyPlayers,
        recent_denies: this.denies.slice(-5),
        gym_obs: gymObs,
      };
    }

    const me = this.myPlayerState();
    const ownBuildings = [];
    const ownUnits = [];
    const ownUnitCounts = {};
    const ownBuildingKinds = new Set();
    const enemyBuildings = [];
    const enemyUnits = [];
    const enemyByOwner = {};
    const neutralDerricks = [];
    const neutralResources = [];

    for (const e of this.ents.values()) {
      if (e.o === -1) {
        if (isBuilding(e.k)) {
          const rec = { id: e.id, kind: e.k, x: r1(e.x), y: r1(e.y), hp: e.hp, mhp: e.mhp };
          neutralResources.push(rec);
          if (e.k === "derrick") neutralDerricks.push(rec);
        }
        continue;
      }
      const bld = isBuilding(e.k);
      if (this.slot >= 0 && e.o === this.slot) {
        if (bld) {
          ownBuildingKinds.add(e.k);
          ownBuildings.push({
            id: e.id,
            kind: e.k,
            x: r1(e.x),
            y: r1(e.y),
            hp: e.hp,
            mhp: e.mhp,
            ...(e.rally ? { rally: [r1(e.rally[0]), r1(e.rally[1])] } : {}),
          });
        } else {
          ownUnitCounts[e.k] = (ownUnitCounts[e.k] || 0) + 1;
          ownUnits.push({
            id: e.id,
            kind: e.k,
            domain: UNITS[e.k]?.domain ?? "land",
            x: r1(e.x),
            y: r1(e.y),
            hp: e.hp,
            mhp: e.mhp,
            ...(e.cargo ? { cargo: e.cargo } : {}),
            ...(e.vet ? { vet: e.vet } : {}),
            ...(e.hold ? { hold: true } : {}),
            ...(e.sub ? { sub: true } : {}),
          });
        }
      } else if (this.isEnemySlot(e.o)) {
        const ownerName = this.playersMeta.get(e.o)?.name ?? `Slot-${e.o}`;
        if (!enemyByOwner[e.o]) {
          enemyByOwner[e.o] = { slot: e.o, name: ownerName, buildings: 0, units: 0 };
        }
        if (bld) {
          enemyByOwner[e.o].buildings++;
          enemyBuildings.push({ id: e.id, owner: e.o, kind: e.k, x: r1(e.x), y: r1(e.y), hp: e.hp, mhp: e.mhp });
        } else {
          enemyByOwner[e.o].units++;
          enemyUnits.push({
            id: e.id,
            owner: e.o,
            kind: e.k,
            domain: UNITS[e.k]?.domain ?? "land",
            x: r1(e.x),
            y: r1(e.y),
            hp: e.hp,
            mhp: e.mhp,
            ...(e.vet ? { vet: e.vet } : {}),
          });
        }
      }
    }

    // Determine buildable hints — prerequisites satisfied (owning the upgraded
    // form of a prerequisite counts, mirroring world.ts hasBuilding) + affordable.
    const canBuildNow = [];
    if (me && !me.eliminated && ownBuildingKinds.has("conyard")) {
      const awaitingAll = [...asKindList(me.awaiting), ...asKindList(me.awaitingDef)];
      const queuedKinds = [...(Array.isArray(me.bq) ? me.bq : []), ...(Array.isArray(me.dq) ? me.dq : [])].map((i) => i?.kind);
      for (const kind of BUILDABLE_KINDS) {
        const def = BUILDINGS[kind];
        if (def.limit) {
          const count =
            ownBuildings.filter((b) => b.kind === kind).length +
            awaitingAll.filter((k) => k === kind).length +
            queuedKinds.filter((k) => k === kind).length;
          if (count >= def.limit) continue;
        }
        const reqsOk = (def.requires || []).every((req) => ownsOrUpgraded(ownBuildingKinds, req));
        if (reqsOk && me.credits >= def.cost) {
          canBuildNow.push({
            kind,
            cost: def.cost,
            size: `${def.w}x${def.h}`,
            power: def.power,
            build_ticks: def.buildTicks,
            ...(def.requires?.length ? { requires: def.requires } : {}),
            ...(def.category === "defense" ? { category: "defense" } : {}),
          });
        }
      }
    }

    const anchor = ownBuildings.find((b) => b.kind === "conyard") || ownBuildings[0] || { x: this.w / 2, y: this.h / 2 };
    const awaitingStruct = asKindList(me?.awaiting);
    const awaitingDef = asKindList(me?.awaitingDef);
    // Mirror server cmdPlace default: structures pile first, then defenses.
    const placeKind = awaitingStruct[0] ?? awaitingDef[0] ?? null;
    const buildHints = {
      awaiting_placement: placeKind,
      awaiting_structures: awaitingStruct,
      awaiting_defenses: awaitingDef,
      valid_spots: placeKind
        ? this.findValidBuildSpots(placeKind, 6)
        : ownBuildings.length
          ? {
              "2x2_land": this.findValidBuildSpots("power", 4),
              "3x3_land": this.findValidBuildSpots("factory", 4),
              ...(ownsOrUpgraded(ownBuildingKinds, "power")
                ? { "3x3_shipyard_water": this.findValidBuildSpots("shipyard", 3) }
                : {}),
            }
          : [],
      affordable_buildings_now: canBuildNow,
    };

    const economy = me
      ? {
          credits: me.credits,
          power: {
            have: me.pwrHave,
            use: me.pwrUse,
            net: me.pwrHave - me.pwrUse,
            low_power: me.lowPower,
          },
          eliminated: me.eliminated,
          awaiting: awaitingStruct,
          awaiting_defenses: awaitingDef,
          building_queue: me.bq,
          defense_queue: me.dq ?? null,
          unit_queues: me.queues,
          superweapon: me.swTotal
            ? { ready: !!me.swReady, left_ticks: me.swLeft ?? 0, total_ticks: me.swTotal }
            : null,
          recon: me.reconTotal
            ? { ready: !!me.reconReady, left_ticks: me.reconLeft ?? 0, total_ticks: me.reconTotal }
            : null,
        }
      : null;

    // For spectators, include overview of all players' economies
    const allPlayersEconomy = this.spectator
      ? Object.values(this.playerStates).map((ps) => ({
          slot: ps.slot,
          name: this.playersMeta.get(ps.slot)?.name ?? `Slot-${ps.slot}`,
          credits: ps.credits,
          power: `${ps.pwrHave}/${ps.pwrUse}`,
          low_power: ps.lowPower,
          eliminated: ps.eliminated,
        }))
      : undefined;

    return {
      ...base,
      ...(this.endInfo ? { end: this.endInfo } : {}),
      gym_obs: gymObs,
      players: [...this.playersMeta.values()],
      economy,
      ...(allPlayersEconomy ? { all_players_economy: allPlayersEconomy } : {}),
      own_buildings: ownBuildings,
      own_units: {
        total: ownUnits.length,
        counts: ownUnitCounts,
        list: ownUnits,
      },
      visible_enemies: {
        by_owner: Object.values(enemyByOwner),
        buildings: enemyBuildings,
        units: enemyUnits,
      },
      neutral_derricks: neutralDerricks,
      neutral_resources: neutralResources,
      crates: this.crates.map((c) => ({ id: c.id, kind: c.kind, x: r1(c.x), y: r1(c.y) })),
      nearest_ore: this.nearestOreHints(anchor.x, anchor.y, 3),
      recent_events: this.recentEvents.slice(-15),
      build_hints: buildHints,
    };
  }
}

const sessions = new Map(); // room -> RoomSession

function getSession(room) {
  const r = sanitizeRoom(room);
  const s = sessions.get(r);
  if (!s) {
    throw new Error(`No active session for room "${r}". Call join_game(room="${r}") first.`);
  }
  return s;
}

async function ensureSessionConnected(room) {
  const s = getSession(room);
  if (!s.isOpen()) {
    await s.connect();
  }
  return s;
}

async function sendAndCheckDeny(session, msg, waitMs = 220) {
  const beforeCount = session.denies.length;
  session.send(msg);
  await session.waitFor((m) => m.t === "deny", waitMs).catch(() => null);
  const newDenies = session.denies.slice(beforeCount).map((d) => d.msg);
  return newDenies;
}

// ---------- Tool Definitions (MCP JSON Schema) ----------

const TOOLS = [
  {
    name: "list_live_games",
    description:
      "Discover live Open Alert matches and lobby rooms from the server (/api/rooms), plus any rooms this MCP server is currently connected to. Returns room IDs, map, players, phase, and spectator watch_url / play_url links.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "join_game",
    description:
      "Connect to an Open Alert room over real-time WebSocket, join as a Commander (or spectator), optionally configure map & AI bot opponent, and start the match. Returns live watch_url (spectator link) and play_url.",
    inputSchema: {
      type: "object",
      properties: {
        room: {
          type: "string",
          description: "Room ID (2-32 alphanumeric characters or hyphens, e.g. 'claude-arena').",
        },
        name: {
          type: "string",
          description: "Your commander callsign (max 16 chars, default 'Claude').",
        },
        map: {
          type: "string",
          enum: MAP_IDS,
          description: `Optional map ID to set in lobby (when host). Naval maps: ${NAVAL_MAPS.join(", ")}. Map dimensions vary (${MAP_DIM_SUMMARY}) — never assume a fixed grid.`,
        },
        add_bot: {
          type: "boolean",
          description: "If true and you are lobby host, adds a CABAL AI bot opponent.",
        },
        diff: {
          type: "string",
          enum: ["easy", "normal", "brutal"],
          description: "AI bot difficulty when add_bot is true (default 'normal').",
        },
        profile: {
          type: "string",
          enum: ["balanced", "rusher", "turtle", "tech"],
          description: "Optional AI bot playstyle profile when add_bot is true (default 'balanced').",
        },
        start: {
          type: "boolean",
          description: "If true, ready up and start the match immediately (requires >= 2 players in lobby).",
        },
        spectate: {
          type: "boolean",
          description: "If true, join as a read-only spectator instead of taking a player slot.",
        },
        token: {
          type: "string",
          description: "Optional commander token (e.g. from create_ai_arena or a previous session) to attach/reconnect.",
        },
      },
      required: ["room"],
    },
  },
  {
    name: "transfer_host",
    description:
      "Transfer lobby host powers to another connected non-spectator human player (host only). Use the target player id from join_game/get_game_state players. The stored transfer also carries into post-game rematch lobbies.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room ID you joined via join_game." },
        id: { type: "string", description: "Target player id to make host." },
      },
      required: ["room", "id"],
    },
  },
  {
    name: "set_slot",
    description:
      "Lobby only: move yourself to an EMPTY spawn/color slot (0-based). Slots determine both player color and home-base spawn position; the server validates the current map's slot count. Hosts may pass another player's id to move that player to an empty slot.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room ID you joined via join_game." },
        slot: { type: "integer", minimum: 0, maximum: MAX_PLAYERS - 1, description: "Empty destination slot index (0-based; shown as S1..Sn in the lobby UI)." },
        id: { type: "string", description: "Optional target player id (host only). Omit to move yourself." },
      },
      required: ["room", "slot"],
    },
  },
  {
    name: "swap_slot",
    description:
      "Lobby only: swap your spawn/color slot with another player. Anyone may swap with an AI bot; swaps with another human are host-only. Hosts may pass id2 to atomically swap any two players. Slots determine color and home-base spawn position.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room ID you joined via join_game." },
        id: { type: "string", description: "Target player id to swap slots with." },
        id2: { type: "string", description: "Optional second player id (host only): swap id↔id2 instead of yourself↔id." },
      },
      required: ["room", "id"],
    },
  },
  {
    name: "get_game_state",
    description:
      "Get full RL Gym parity state (`gym_obs`) plus a real-time LLM-optimized tactical summary of the match: tick, done, winner, credits, power, awaiting placement, production queues, own buildings & units, visible enemy buildings & units, neutral Oil Derricks & Coal Mines, supply crates, nearest ore clusters, recent combat/alert events, and valid build placement coordinates. Includes map_size — dimensions vary per map.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room ID you joined via join_game." },
      },
      required: ["room"],
    },
  },
  {
    name: "build_structure",
    description:
      "Start constructing a building at your Construction Yard. Structures and defenses build in PARALLEL queues. Once construction completes, the kind appears in 'awaiting'/'awaitingDef' in get_game_state — then call place_structure(room, tx, ty) to deploy it. " +
      buildingsDescription(),
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room ID." },
        kind: {
          type: "string",
          enum: BUILDABLE_KINDS,
          description: buildingsDescription(),
        },
      },
      required: ["room", "kind"],
    },
  },
  {
    name: "place_structure",
    description: placeRulesDescription(),
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room ID." },
        tx: { type: "integer", minimum: 0, maximum: MAX_MAP_DIM - 1, description: `Top-left tile X coordinate (0..map_width-1; maps are 96 or 128 wide, legacy 64).` },
        ty: { type: "integer", minimum: 0, maximum: MAX_MAP_DIM - 1, description: `Top-left tile Y coordinate (0..map_height-1; maps are 96 or 128 tall, legacy 64).` },
        cat: {
          type: "string",
          enum: ["structure", "defense"],
          description: "Optional: which finished pile to place from. Defaults to structures first, then defenses (same as server).",
        },
        kind: {
          type: "string",
          enum: BUILDABLE_KINDS,
          description: "Optional: place a specific finished kind from the awaiting piles (when several are ready).",
        },
      },
      required: ["room", "tx", "ty"],
    },
  },
  {
    name: "train_unit",
    description: "Queue one or more units at your production buildings (barracks, war factory, airfield, or naval shipyard). " + unitsDescription(),
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room ID." },
        unit: {
          type: "string",
          enum: UNIT_KINDS,
          description: unitsDescription(),
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Number of units to queue (default 1, max 10).",
        },
      },
      required: ["room", "unit"],
    },
  },
  {
    name: "command_units",
    description:
      `Issue tactical orders to specific unit IDs or a unit group ('all_combat', 'infantry', 'tanks', 'air', 'sea', 'harvesters'). Supports move, amove (attack-move), attack, harvest, patrol, stop, and hold. Coordinates are in tiles of the live map — read map_size from get_game_state (map dimensions vary: ${MAP_DIM_SUMMARY}).`,
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room ID." },
        kind: {
          type: "string",
          enum: ["move", "amove", "attack", "harvest", "patrol", "stop", "hold"],
          description: "Order type. Use 'amove' for combat pushes, 'attack' with target ID for focus fire / engineer capture.",
        },
        x: { type: "number", minimum: 0, maximum: MAX_MAP_DIM - 0.1, description: "Destination X coordinate in tiles (0..map_width-1). Optional if 'target' is given or kind is stop/hold." },
        y: { type: "number", minimum: 0, maximum: MAX_MAP_DIM - 0.1, description: "Destination Y coordinate in tiles (0..map_height-1). Optional if 'target' is given or kind is stop/hold." },
        target: { type: "integer", description: "Optional target entity ID (enemy unit/building, or neutral Oil Derrick / Coal Mine for engineer capture)." },
        ids: {
          type: "array",
          items: { type: "integer" },
          description: "Explicit list of own unit IDs to command. Overrides 'group' if provided.",
        },
        group: {
          type: "string",
          enum: ["all_combat", "infantry", "tanks", "air", "sea", "harvesters"],
          description: "Select a group of own units automatically if 'ids' is omitted (defaults to 'all_combat', or 'harvesters' for harvest orders).",
        },
      },
      required: ["room", "kind"],
    },
  },
  {
    name: "special_action",
    description:
      `Execute special commander actions: fire Orbital Ion Cannon ('superweapon'), Radar Recon Scan ('recon'), ${upgradeDescription()}, 'sell' or 'repair' a building, set production 'rally' point, send 'chat', or 'resign'.`,
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room ID." },
        action: {
          type: "string",
          enum: ["superweapon", "recon", "upgrade", "sell", "repair", "rally", "chat", "resign"],
          description: "Special action to execute.",
        },
        x: { type: "number", minimum: 0, maximum: MAX_MAP_DIM - 0.1, description: "Target X coordinate in tiles of the live map (for superweapon, recon, rally)." },
        y: { type: "number", minimum: 0, maximum: MAX_MAP_DIM - 0.1, description: "Target Y coordinate in tiles of the live map (for superweapon, recon, rally)." },
        id: { type: "integer", description: "Target own building ID (for upgrade, sell, repair, rally). For 'upgrade', auto-selects your War Factory or first upgradeable building if omitted." },
        text: { type: "string", description: "Chat message text (for action='chat', max 120 chars)." },
      },
      required: ["room", "action"],
    },
  },
  {
    name: "create_ai_arena",
    description:
      "Create a live AI-vs-AI arena match with two external MCP commander seats (agent_a in slot 0, agent_b in slot 1). Registers live on the Spectator Dashboard (/?watch=1) so humans can watch AI models compete in 3D, and returns both commander tokens plus watch_url and dashboard_url.",
    inputSchema: {
      type: "object",
      properties: {
        room: {
          type: "string",
          description: "Room ID (2-32 lowercase alphanumeric/hyphen chars). Auto-generated if omitted.",
        },
        map: {
          type: "string",
          enum: MAP_IDS,
          description: "Map ID (default 'crossroads').",
        },
        agent_a: {
          type: "string",
          description: "Commander callsign for slot 0 (max 16 chars, default 'Agent-A').",
        },
        agent_b: {
          type: "string",
          description: "Commander callsign for slot 1 (max 16 chars, default 'Agent-B').",
        },
        start: {
          type: "boolean",
          description: "Start the match immediately (default true).",
        },
        start_credits: {
          type: "integer",
          enum: [3000, 5000, 10000, 20000],
          description: "Starting credits per agent (default 5000).",
        },
        game_speed: {
          type: "number",
          enum: [0.75, 1, 1.5, 2],
          description: "Simulation speed multiplier (default 1).",
        },
      },
    },
  },
  {
    name: "get_gym_schema",
    description:
      "Return the exact RL Gym observation contract (gym_obs), 6xHxW float32 feature_maps contract (H/W = live map dimensions), HxWx3 uint8 rgb_frame contract, and rts_action JSON schema shared 1:1 between src/server/gym.ts and live MCP matches for training & finetuning models.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

// ---------- Tool Handlers ----------

async function handleListLiveGames() {
  const url = `${BASE_URL}/api/rooms`;
  let remoteRooms = [];
  let remoteError = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    if (typeof timer.unref === "function") timer.unref();
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      remoteError = `HTTP ${res.status} ${res.statusText} from ${url}`;
    } else {
      const data = await res.json();
      const arr = Array.isArray(data) ? data : Array.isArray(data?.rooms) ? data.rooms : [];
      remoteRooms = arr.map((r) => ({
        ...r,
        ...roomUrls(r.room),
      }));
    }
  } catch (err) {
    remoteError = `Failed to reach ${url}: ${err.message}`;
  }

  const localSessions = [...sessions.values()].map((s) => ({
    room: s.room,
    phase: s.phase,
    map: s.map,
    slot: s.slot,
    spectator: s.spectator,
    tick: s.tick,
    connected: s.isOpen(),
    ...roomUrls(s.room),
  }));

  return {
    server: BASE_URL,
    dashboard_url: `${BASE_URL}/?watch=1`,
    live_rooms: remoteRooms,
    ...(remoteError ? { remote_note: remoteError } : {}),
    connected_mcp_sessions: localSessions,
  };
}

async function handleJoinGame(args) {
  const room = sanitizeRoom(args.room);
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 16) : "Claude";
  const spectate = !!args.spectate;
  const reqToken =
    typeof args.token === "string" && args.token.length > 0 && args.token.length <= 64 ? args.token : null;

  let session = sessions.get(room);
  if (session && (session.spectate !== spectate || (reqToken && session.token !== reqToken))) {
    session.closeSocketOnly();
    sessions.delete(room);
    session = null;
  }
  if (!session) {
    session = new RoomSession(room, name, spectate, reqToken);
    sessions.set(room, session);
  } else {
    session.name = name;
  }

  const denyBefore = session.denies.length;
  await session.connect();

  if (session.phase === "lobby" && !session.spectator) {
    session.send({ t: "ready", ready: true });

    if (session.host) {
      if (typeof args.map === "string" && MAP_IDS.includes(args.map)) {
        session.send({ t: "setMap", map: args.map });
        await session.waitFor((m) => m.t === "lobby" && m.map === args.map, 1000).catch(() => null);
      }

      const botCount =
        typeof args.add_bot === "number"
          ? Math.max(0, Math.min(3, Math.floor(args.add_bot)))
          : args.add_bot
            ? 1
            : 0;
      const diff = ["easy", "normal", "brutal"].includes(args.diff) ? args.diff : "normal";
      const profile = ["balanced", "rusher", "turtle", "tech"].includes(args.profile) ? args.profile : "balanced";

      for (let i = 0; i < botCount; i++) {
        session.send({ t: "addbot", diff, profile });
        await session.waitFor((m) => m.t === "lobby", 1000).catch(() => null);
      }

      if (args.start) {
        await sleep(120);
        session.send({ t: "start" });
        await session.waitFor((m) => m.t === "snap" || m.t === "deny", 3500).catch(() => null);
      }
    } else if (args.start) {
      // Non-host already sent ready=true; wait briefly in case host starts
      await session.waitFor((m) => m.t === "snap", 1500).catch(() => null);
    }
  } else if (session.phase === "playing" && session.ents.size === 0) {
    await session.waitFor((m) => m.t === "snap", 2000).catch(() => null);
  }

  const newDenies = session.denies.slice(denyBefore).map((d) => d.msg);
  return {
    ok: newDenies.length === 0,
    room: session.room,
    phase: session.phase,
    map: session.map,
    map_size: { w: session.w, h: session.h },
    you: session.you,
    name: session.name,
    slot: session.slot,
    host: session.host,
    spectator: session.spectator,
    tick: session.tick,
    players: session.lobbyPlayers.length ? session.lobbyPlayers : [...session.playersMeta.values()],
    ...roomUrls(session.room),
    ...(newDenies.length ? { denies: newDenies } : {}),
    tip:
      session.phase === "playing"
        ? "Match is LIVE! Call get_game_state to inspect your base, credits, and valid build coordinates."
        : "Connected in lobby. Call join_game with add_bot=true and start=true (if host) or wait for opponents.",
  };
}

async function handleTransferHost(args) {
  const session = await ensureSessionConnected(args.room);
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) throw new Error("transfer_host requires a non-empty target player 'id'.");
  if (!session.host) {
    return { ok: false, room: session.room, error: "you are not host", players: session.lobbyPlayers };
  }
  const target = session.lobbyPlayers.find((p) => p.id === id);
  if (!target || target.id === session.you || !target.connected || target.spectator || target.bot) {
    return {
      ok: false,
      room: session.room,
      error: "target must be another connected non-spectator human player",
      players: session.lobbyPlayers,
    };
  }
  session.send({ t: "transferHost", id });
  const updated = await session.waitFor((m) => m.t === "lobby", 700).catch(() => null);
  const host = session.lobbyPlayers.find((p) => p.host);
  if (!updated) {
    return {
      ok: false,
      room: session.room,
      error: "transfer was not acknowledged by the server",
      host: host ? { id: host.id, name: host.name } : null,
      players: session.lobbyPlayers,
    };
  }
  return {
    ok: true,
    room: session.room,
    transferred_to: { id: target.id, name: target.name },
    host: host ? { id: host.id, name: host.name } : null,
    players: session.lobbyPlayers,
  };
}

async function handleSetSlot(args) {
  const session = await ensureSessionConnected(args.room);
  const slot = Number(args.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PLAYERS) {
    throw new Error(`set_slot requires integer slot 0..${MAX_PLAYERS - 1}`);
  }
  const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : null;
  const targetId = id ?? session.you;
  const targetBefore = session.lobbyPlayers.find((p) => p.id === targetId);
  if (targetBefore?.slot === slot) {
    return {
      ok: true,
      room: session.room,
      phase: session.phase,
      requested_slot: slot,
      player: { id: targetBefore.id, name: targetBefore.name, slot: targetBefore.slot },
      players: session.lobbyPlayers,
    };
  }
  const denyBefore = session.denies.length;
  session.send({ t: "setSlot", slot, ...(id ? { id } : {}) });
  await session
    .waitFor(
      (m) => m.t === "deny" || (m.t === "lobby" && m.players?.some((p) => p.id === targetId && p.slot === slot)),
      900,
    )
    .catch(() => null);
  const denies = session.denies.slice(denyBefore).map((d) => d.msg);
  const target = session.lobbyPlayers.find((p) => p.id === targetId);
  const ok = denies.length === 0 && target?.slot === slot;
  return {
    ok,
    room: session.room,
    phase: session.phase,
    requested_slot: slot,
    player: target ? { id: target.id, name: target.name, slot: target.slot } : null,
    players: session.lobbyPlayers,
    ...(ok ? {} : { error: denies.join("; ") || "slot move was not acknowledged by the server" }),
  };
}

async function handleSwapSlot(args) {
  const session = await ensureSessionConnected(args.room);
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) throw new Error("swap_slot requires a non-empty target player 'id'.");
  const id2 = typeof args.id2 === "string" && args.id2.trim() ? args.id2.trim() : null;
  const firstBefore = session.lobbyPlayers.find((p) => p.id === id);
  const secondBefore = session.lobbyPlayers.find((p) => p.id === (id2 ?? session.you));
  if (!firstBefore || !secondBefore) {
    return { ok: false, room: session.room, error: "target player not found in lobby", players: session.lobbyPlayers };
  }
  const denyBefore = session.denies.length;
  session.send({ t: "swapSlot", id, ...(id2 ? { id2 } : {}) });
  await session
    .waitFor(
      (m) =>
        m.t === "deny" ||
        (m.t === "lobby" &&
          m.players?.some((p) => p.id === firstBefore.id && p.slot === secondBefore.slot) &&
          m.players?.some((p) => p.id === secondBefore.id && p.slot === firstBefore.slot)),
      900,
    )
    .catch(() => null);
  const denies = session.denies.slice(denyBefore).map((d) => d.msg);
  const firstAfter = session.lobbyPlayers.find((p) => p.id === firstBefore.id);
  const secondAfter = session.lobbyPlayers.find((p) => p.id === secondBefore.id);
  const ok = denies.length === 0 && firstAfter?.slot === secondBefore.slot && secondAfter?.slot === firstBefore.slot;
  return {
    ok,
    room: session.room,
    phase: session.phase,
    swapped: ok
      ? [
          { id: firstBefore.id, name: firstBefore.name, slot: firstAfter?.slot },
          { id: secondBefore.id, name: secondBefore.name, slot: secondAfter?.slot },
        ]
      : null,
    players: session.lobbyPlayers,
    ...(ok ? {} : { error: denies.join("; ") || "slot swap was not acknowledged by the server" }),
  };
}

async function handleGetGameState(args) {
  const session = await ensureSessionConnected(args.room);
  if (session.phase === "playing" && Date.now() - session.lastSnapAt > 1500) {
    await session.waitFor((m) => m.t === "snap", 1200).catch(() => null);
  }
  return session.buildSummary();
}

async function handleBuildStructure(args) {
  const session = await ensureSessionConnected(args.room);
  const kind = String(args.kind || "");
  if (!BUILDABLE_KINDS.includes(kind)) {
    throw new Error(`Invalid building kind "${kind}". Valid kinds: ${BUILDABLE_KINDS.join(", ")}`);
  }

  const denies = await sendAndCheckDeny(session, { t: "build", kind }, 240);
  await session.waitFor((m) => m.t === "snap", 450).catch(() => null);
  const me = session.myPlayerState();
  return {
    ok: denies.length === 0,
    room: session.room,
    kind,
    ...(denies.length ? { deny: denies[denies.length - 1] } : {}),
    credits: me?.credits ?? null,
    building_queue: me?.bq ?? null,
    defense_queue: me?.dq ?? null,
    awaiting: asKindList(me?.awaiting),
    awaiting_defenses: asKindList(me?.awaitingDef),
  };
}

async function handlePlaceStructure(args) {
  const session = await ensureSessionConnected(args.room);
  const tx = Math.floor(Number(args.tx));
  const ty = Math.floor(Number(args.ty));
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    throw new Error(`tx and ty must be finite integers (0..map_size-1 — this map is ${session.w}x${session.h}).`);
  }

  const msg = { t: "place", tx, ty };
  if (args.cat === "structure" || args.cat === "defense") msg.cat = args.cat;
  if (typeof args.kind === "string" && BUILDABLE_KINDS.includes(args.kind)) msg.kind = args.kind;

  // Predict which kind the server will pop, mirroring world.ts cmdPlace pile selection:
  // explicit kind wins; else the requested cat pile head; else structures head, then defenses head.
  const meBefore = session.myPlayerState();
  const structsBefore = asKindList(meBefore?.awaiting);
  const defsBefore = asKindList(meBefore?.awaitingDef);
  const wasAwaiting =
    typeof msg.kind === "string"
      ? msg.kind
      : msg.cat === "defense"
        ? (defsBefore[0] ?? null)
        : msg.cat === "structure"
          ? (structsBefore[0] ?? null)
          : (structsBefore[0] ?? defsBefore[0] ?? null);
  const denies = await sendAndCheckDeny(session, msg, 260);
  await session.waitFor((m) => m.t === "snap", 450).catch(() => null);
  const me = session.myPlayerState();
  const res = {
    ok: denies.length === 0,
    room: session.room,
    placed: denies.length === 0 ? (typeof msg.kind === "string" ? msg.kind : wasAwaiting) : null,
    tx,
    ty,
    awaiting: asKindList(me?.awaiting),
    awaiting_defenses: asKindList(me?.awaitingDef),
    ...(denies.length ? { deny: denies[denies.length - 1] } : {}),
  };
  const remaining = asKindList(me?.awaiting)[0] ?? asKindList(me?.awaitingDef)[0] ?? null;
  if (denies.length && remaining) {
    res.valid_spots = session.findValidBuildSpots(remaining, 6);
  }
  return res;
}

async function handleTrainUnit(args) {
  const session = await ensureSessionConnected(args.room);
  const unit = String(args.unit || "");
  if (!UNIT_KINDS.includes(unit)) {
    throw new Error(`Invalid unit "${unit}". Valid units: ${UNIT_KINDS.join(", ")}`);
  }
  const count = Math.max(1, Math.min(10, Math.floor(Number(args.count ?? 1) || 1)));
  const denies = [];
  let sent = 0;

  for (let i = 0; i < count; i++) {
    const d = await sendAndCheckDeny(session, { t: "train", unit }, i === count - 1 ? 220 : 120);
    sent++;
    if (d.length) {
      denies.push(...d);
      break;
    }
  }
  await session.waitFor((m) => m.t === "snap", 450).catch(() => null);
  const me = session.myPlayerState();
  return {
    ok: denies.length === 0,
    room: session.room,
    unit,
    requested: count,
    sent,
    ...(denies.length ? { denies } : {}),
    credits: me?.credits ?? null,
    queues: me?.queues ?? {},
  };
}

function resolveUnitIds(session, ids, group, kind) {
  if (Array.isArray(ids) && ids.length > 0) {
    return ids.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  }
  const effectiveGroup = group || (kind === "harvest" ? "harvesters" : "all_combat");
  const matched = [];
  for (const e of session.ents.values()) {
    if (e.o !== session.slot || isBuilding(e.k)) continue;
    const u = UNITS[e.k];
    if (!u) continue;
    if (effectiveGroup === "all_combat") {
      if (u.dmg > 0) matched.push(e.id);
    } else if (effectiveGroup === "infantry") {
      // Barracks-trained ground units (infantry/engineer/rocket/spy — future-proof)
      if (u.domain === "land" && u.trainsAt === "barracks") matched.push(e.id);
    } else if (effectiveGroup === "tanks") {
      // Armed factory-trained vehicles (tank/himars/railtank/ballistic — excludes harvester & supply truck)
      if (u.domain === "land" && u.trainsAt === "factory" && u.dmg > 0) matched.push(e.id);
    } else if (effectiveGroup === "air") {
      if (u.domain === "air") matched.push(e.id);
    } else if (effectiveGroup === "sea") {
      if (u.domain === "sea") matched.push(e.id);
    } else if (effectiveGroup === "harvesters") {
      if (e.k === "harvester") matched.push(e.id);
    } else {
      matched.push(e.id);
    }
  }
  return matched;
}

async function handleCommandUnits(args) {
  const session = await ensureSessionConnected(args.room);
  const kind = String(args.kind || "");
  const validKinds = ["move", "amove", "attack", "harvest", "patrol", "stop", "hold"];
  if (!validKinds.includes(kind)) {
    throw new Error(`Invalid order kind "${kind}". Valid kinds: ${validKinds.join(", ")}`);
  }

  const unitIds = resolveUnitIds(session, args.ids, args.group, kind);
  if (unitIds.length === 0) {
    return {
      ok: false,
      room: session.room,
      kind,
      unit_count: 0,
      note: "No matching own units found for the specified ids/group.",
    };
  }

  if (kind === "stop" || kind === "hold") {
    const denies = await sendAndCheckDeny(session, { t: kind, ids: unitIds }, 180);
    return {
      ok: denies.length === 0,
      room: session.room,
      kind,
      unit_count: unitIds.length,
      ids: unitIds,
      ...(denies.length ? { deny: denies[denies.length - 1] } : {}),
    };
  }

  let x = Number(args.x);
  let y = Number(args.y);
  const target = args.target !== undefined && args.target !== null ? Number(args.target) : undefined;

  if ((!Number.isFinite(x) || !Number.isFinite(y)) && Number.isFinite(target)) {
    const ent = session.ents.get(target);
    if (ent) {
      x = ent.x;
      y = ent.y;
    }
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Order "${kind}" requires finite x and y coordinates (or a visible target entity id).`);
  }

  const msg = {
    t: "order",
    ids: unitIds,
    kind,
    x: Math.max(0.5, Math.min(session.w - 0.5, x)),
    y: Math.max(0.5, Math.min(session.h - 0.5, y)),
    ...(Number.isFinite(target) ? { target } : {}),
  };
  const denies = await sendAndCheckDeny(session, msg, 200);
  return {
    ok: denies.length === 0,
    room: session.room,
    kind,
    unit_count: unitIds.length,
    ids: unitIds,
    x: r1(msg.x),
    y: r1(msg.y),
    ...(Number.isFinite(target) ? { target } : {}),
    ...(denies.length ? { deny: denies[denies.length - 1] } : {}),
  };
}

async function handleSpecialAction(args) {
  const session = await ensureSessionConnected(args.room);
  const action = String(args.action || "");
  let msg;

  if (action === "superweapon" || action === "recon") {
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Action "${action}" requires finite x and y coordinates in tiles of the live map (${session.w}x${session.h}).`);
    }
    msg = { t: action, x, y };
  } else if (action === "upgrade") {
    let id = Number(args.id);
    if (!Number.isFinite(id)) {
      // Auto-select own War Factory first, then any building with an upgrade path
      let fallbackId = NaN;
      for (const e of session.ents.values()) {
        if (e.o !== session.slot) continue;
        if (e.k === "factory") {
          id = e.id;
          break;
        }
        if (!Number.isFinite(fallbackId) && Object.prototype.hasOwnProperty.call(UPGRADE_PATHS, e.k)) {
          fallbackId = e.id;
        }
      }
      if (!Number.isFinite(id)) id = fallbackId;
    }
    if (!Number.isFinite(id)) {
      const upgradeable = Object.keys(UPGRADE_PATHS).join(", ");
      throw new Error(`No own upgradeable building found (upgradeable kinds: ${upgradeable}). Build one plus its tech prerequisite first, or pass 'id'.`);
    }
    msg = { t: "upgrade", id };
  } else if (action === "sell" || action === "repair") {
    const id = Number(args.id);
    if (!Number.isFinite(id)) throw new Error(`Action "${action}" requires a numeric building 'id'.`);
    msg = { t: action, id };
  } else if (action === "rally") {
    const id = Number(args.id);
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(id) || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("Action 'rally' requires numeric building 'id' plus coordinates 'x' and 'y'.");
    }
    msg = { t: "rally", id, x, y };
  } else if (action === "chat") {
    const text = String(args.text || "").trim().slice(0, 120);
    if (!text) throw new Error("Action 'chat' requires non-empty 'text'.");
    msg = { t: "chat", text };
  } else if (action === "resign") {
    msg = { t: "resign" };
  } else {
    throw new Error(`Unknown special action "${action}". Valid: superweapon, recon, upgrade, sell, repair, rally, chat, resign.`);
  }

  const denies = await sendAndCheckDeny(session, msg, 240);
  return {
    ok: denies.length === 0,
    room: session.room,
    action,
    sent: msg,
    ...(denies.length ? { deny: denies[denies.length - 1] } : {}),
  };
}

function handleGetGymSchema() {
  const upgradePathsText = Object.values(UPGRADE_PATHS)
    .map((p) => `${p.from}→${p.to} ($${p.cost}, needs ${p.requires})`)
    .join("; ");
  return {
    gym_obs_contract: {
      description:
        "Exact structured RL Gym observation contract shared 1:1 between src/server/gym.ts (GymEnv / extractGymObs) and MCP get_game_state.gym_obs.",
      fields: {
        tick: "integer — authoritative simulation tick (10 ticks = 1s at 1x speed)",
        you: {
          slot: "integer — your player slot index (0..7)",
          credits: "integer — current floored credits",
          pwrHave: "integer — total power generated",
          pwrUse: "integer — total power consumed",
          lowPower: "boolean — true when pwrUse > pwrHave (halves production & disables defenses)",
          eliminated: "boolean — true if your faction has been eliminated",
          bq: "Array<{ kind: BuildingKind, left: number, total: number }> — structure construction queue (head builds first)",
          awaiting: "BuildingKind[] — finished structures stacked for placement",
          dq: "Array<{ kind: BuildingKind, left: number, total: number }> — defense construction queue (parallel with structures!)",
          awaitingDef: "BuildingKind[] — finished defenses waiting for placement",
          queues:
            "Partial<Record<'barracks'|'factory'|'airfield'|'shipyard', Array<{ unit: UnitKind, left: number, total: number }>>>",
        },
        ents: "Array<{ id: number, o: number, k: EntKind, x: number, y: number, hp: number, mhp: number, cargo?: number }>",
        ore: "Array<[x: number, y: number, amount: number]>",
      },
    },
    feature_maps_contract: {
      shape: [6, "H", "W"],
      dtype: "float32",
      note: `W/H are the LIVE map dimensions (e.g. 96x96 standard theaters, 128x128 megacontinent, ${DEFAULT_MAP_W}x${DEFAULT_MAP_H} legacy) — never assume a fixed size.`,
      channels: ["ore", "own_units", "own_buildings", "foe_units", "foe_buildings", "all_hp"],
      encoding: "base64 (little-endian IEEE-754 Float32Array, C-contiguous [channel, y, x])",
    },
    rgb_frame_contract: {
      w: "W (live map width)",
      h: "H (live map height)",
      c: 3,
      dtype: "uint8",
      encoding: "base64 (row-major RGB Uint8Array of w*h*3 bytes, `scale` pixels per tile, default 3)",
    },
    action_schema: {
      name: "rts_action",
      description:
        "One bundle of commands applied to your faction, then the sim advances `ticks` ticks (10 ticks = 1s). Every field is optional; omit or set null to skip. Malformed fields invalidate the whole action.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          build: {
            anyOf: [{ type: "string", enum: Object.keys(BUILDINGS) }, { type: "null" }],
            description:
              "start constructing a building (needs conyard + credits); finish with `place` once it lands in `you.awaiting`/`you.awaitingDef`. Structures & defenses build in parallel queues.",
          },
          place: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["tx", "ty"],
                properties: {
                  tx: { type: "integer" },
                  ty: { type: "integer" },
                  cat: { type: ["string", "null"], enum: ["structure", "defense", null] },
                  kind: { type: ["string", "null"], enum: [...Object.keys(BUILDINGS), null] },
                },
              },
              { type: "null" },
            ],
            description:
              `top-left tile for a finished building; must sit within 2 tiles of your buildings (${SHIPYARD_BUILD_DIST} on water for shipyards) on clear non-ore ground. Coordinates are in tiles of the live map (W×H).`,
          },
          train: {
            anyOf: [{ type: "string", enum: Object.keys(UNITS) }, { type: "null" }],
            description: "queue one unit: land→barracks/factory, air→airfield, sea→shipyard",
          },
          cancelTrain: {
            anyOf: [{ type: "string", enum: Object.keys(UNITS) }, { type: "null" }],
            description: "refund one queued unit of this kind",
          },
          order: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["ids", "kind", "x", "y"],
                properties: {
                  ids: {
                    type: "array",
                    items: { type: "integer" },
                    description: "your mobile unit ids (filtered to owned units)",
                  },
                  kind: { type: "string", enum: ["move", "amove", "attack", "harvest", "patrol"] },
                  x: { type: "number" },
                  y: { type: "number" },
                  target: { type: ["integer", "null"], description: "enemy ent id, only for kind=attack" },
                },
              },
              { type: "null" },
            ],
            description: "amove = attack-move; harvest targets an ore tile (harvesters also auto-mine when idle)",
          },
          stop: {
            anyOf: [{ type: "array", items: { type: "integer" } }, { type: "null" }],
            description: "clear orders on these own unit ids",
          },
          upgrade: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: `upgrade a building ent id along its tech path (${upgradePathsText})`,
          },
          superweapon: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["x", "y"],
                properties: { x: { type: "number" }, y: { type: "number" } },
              },
              { type: "null" },
            ],
            description: "fire charged Orbital Ion Cannon at map coords (needs superweapon building + full charge)",
          },
        },
      },
    },
  };
}

async function handleCreateAiArena(args = {}) {
  // Primary path: proxy directly to the server's HTTP /mcp create_ai_arena tool
  const mcpUrl = `${BASE_URL}/mcp`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    if (typeof timer.unref === "function") timer.unref();
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `arena-${crypto.randomUUID().slice(0, 8)}`,
        method: "tools/call",
        params: { name: "create_ai_arena", arguments: args },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const rpc = await res.json();
      const text = rpc?.result?.content?.[0]?.text;
      if (typeof text === "string") {
        const parsed = JSON.parse(text);
        if (rpc?.result?.isError || parsed?.ok === false) {
          throw new Error(parsed?.error || "create_ai_arena failed on remote server");
        }
        return parsed;
      }
      if (rpc?.error?.message) {
        throw new Error(rpc.error.message);
      }
    }
  } catch (err) {
    // If remote explicitly rejected with a room/validation error, surface it; otherwise fall back to local WS setup
    if (err instanceof Error && /already has an active match|room must be/i.test(err.message)) {
      throw err;
    }
    log(`HTTP /mcp create_ai_arena fallback (${err instanceof Error ? err.message : String(err)})`);
  }

  // Fallback path: open 2 WebSocket sessions directly so local/older servers still support AI-vs-AI arenas
  const room =
    typeof args.room === "string" && args.room.trim()
      ? sanitizeRoom(args.room.trim().toLowerCase())
      : `arena-${crypto.randomUUID().slice(0, 6)}`;
  const nameA = typeof args.agent_a === "string" && args.agent_a.trim() ? args.agent_a.trim().slice(0, 16) : "Agent-A";
  const nameB = typeof args.agent_b === "string" && args.agent_b.trim() ? args.agent_b.trim().slice(0, 16) : "Agent-B";

  const sessA = new RoomSession(room, nameA, false);
  const sessB = new RoomSession(room, nameB, false);
  await sessA.connect();
  await sessB.connect();

  if (typeof args.map === "string" && MAP_IDS.includes(args.map)) {
    sessA.send({ t: "setMap", map: args.map });
    await sessA.waitFor((m) => m.t === "lobby" && m.map === args.map, 1000).catch(() => null);
  }
  const cfgPatch = {};
  if ([3000, 5000, 10000, 20000].includes(args.start_credits)) cfgPatch.startCredits = args.start_credits;
  if ([0.75, 1, 1.5, 2].includes(args.game_speed)) cfgPatch.gameSpeed = args.game_speed;
  if (Object.keys(cfgPatch).length) {
    sessA.send({ t: "setConfig", config: cfgPatch });
    await sessA.waitFor((m) => m.t === "lobby", 1000).catch(() => null);
  }

  sessA.send({ t: "ready", ready: true });
  sessB.send({ t: "ready", ready: true });
  await sleep(120);

  if (args.start !== false) {
    sessA.send({ t: "start" });
    await sessA.waitFor((m) => m.t === "snap" || m.t === "init", 3500).catch(() => null);
  }

  // Keep slot 0 session tracked under room so get_game_state works immediately if desired
  sessions.set(room, sessA);
  sessions.set(`${room}#slot1`, sessB);

  const urls = roomUrls(room);
  return {
    ok: true,
    room,
    map: sessA.map,
    phase: sessA.phase,
    config: sessA.config,
    agent_a: { name: nameA, slot: sessA.slot >= 0 ? sessA.slot : 0, token: sessA.token },
    agent_b: { name: nameB, slot: sessB.slot >= 0 ? sessB.slot : 1, token: sessB.token },
    watch_url: urls.watch_url,
    dashboard_url: urls.dashboard_url,
  };
}

async function dispatchTool(name, args = {}) {
  switch (name) {
    case "list_live_games":
      return handleListLiveGames(args);
    case "join_game":
      return handleJoinGame(args);
    case "transfer_host":
      return handleTransferHost(args);
    case "set_slot":
      return handleSetSlot(args);
    case "swap_slot":
      return handleSwapSlot(args);
    case "create_ai_arena":
      return handleCreateAiArena(args);
    case "get_gym_schema":
      return handleGetGymSchema();
    case "get_game_state":
      return handleGetGameState(args);
    case "build_structure":
      return handleBuildStructure(args);
    case "place_structure":
      return handlePlaceStructure(args);
    case "train_unit":
      return handleTrainUnit(args);
    case "command_units":
      return handleCommandUnits(args);
    case "special_action":
      return handleSpecialAction(args);
    default:
      throw new Error(`Unknown tool "${name}"`);
  }
}

// ---------- Stdio MCP JSON-RPC 2.0 Server ----------

function writeJsonRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResult(id, result) {
  writeJsonRpc({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  writeJsonRpc({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

async function handleRequest(req) {
  const hasId = req && Object.prototype.hasOwnProperty.call(req, "id") && req.id !== undefined;
  const id = hasId ? req.id : null;

  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    if (hasId) sendError(id, -32600, "Invalid Request");
    return;
  }

  const { method, params } = req;

  // Notifications (no id) require no response
  if (!hasId) {
    if (method === "notifications/initialized") {
      log("Client initialized");
    }
    return;
  }

  try {
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions:
          `Open Alert RTS Commander MCP server (connected target: ${BASE_URL}). ` +
          `Start with list_live_games or join_game(room, name, map, add_bot=true, start=true), ` +
          `then loop get_game_state -> build_structure/place_structure/train_unit/command_units/special_action. ` +
          `Map dimensions vary per map — read map_size from get_game_state, never assume a fixed grid. ` +
          `Share watch_url with the user so they can spectate live in 3D!`,
      });
      return;
    }

    if (method === "ping") {
      sendResult(id, {});
      return;
    }

    if (method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      if (typeof toolName !== "string") {
        sendError(id, -32602, "Invalid params: 'name' must be a string");
        return;
      }
      try {
        const result = await dispatchTool(toolName, toolArgs);
        sendResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        });
      } catch (err) {
        sendResult(id, {
          content: [{ type: "text", text: JSON.stringify({ error: err.message || String(err) }, null, 2) }],
          isError: true,
        });
      }
      return;
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    log("Unhandled RPC error:", err.stack || err.message);
    sendError(id, -32603, err.message || "Internal error");
  }
}

function cleanupAndExit(code = 0) {
  for (const s of sessions.values()) {
    s.closeSocketOnly();
  }
  sessions.clear();
  process.exit(code);
}

process.on("SIGINT", () => cleanupAndExit(0));
process.on("SIGTERM", () => cleanupAndExit(0));

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const pending = new Set();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    sendError(null, -32700, "Parse error", err.message);
    return;
  }
  const p = handleRequest(parsed).finally(() => pending.delete(p));
  pending.add(p);
});

rl.on("close", async () => {
  if (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
  cleanupAndExit(0);
});

log(`Ready on stdio (target=${BASE_URL}, defs=${defsVia}, buildings=${Object.keys(BUILDINGS).length}, units=${UNIT_KINDS.length}, maps=${MAP_IDS.length})`);
