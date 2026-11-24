// OpenAI-gym-style RL environment wrapping a single authoritative World.
// The agent controls one slot; a built-in opponent controls the other.
// Self-contained: the scripted opponent below is intentionally inlined —
// the dedicated networked bot lives elsewhere (test/bot.mjs / src/server/bot.ts
// is owned by another agent) and must NOT be imported here.
//
//   const env = new GymEnv({ opponent: "scripted", maxTicks: 6000 });
//   let obs = env.reset();                                    // structured state
//   const { obs, reward, done, info } = env.step({ build: "power" }, 10);
//   const planes = env.featureMaps();                         // 6x64x64 channels
//   const pixels = env.rgbFrame(3);                           // 192x192x3 RGB image

import { World } from "./world";
import { BUILDINGS, UNITS, ORE_CELL_MAX, PLAYER_COLORS, SHIPYARD_BUILD_DIST } from "../shared/gamedefs";
import type { BuildingKind, BuildCategory, UnitKind, EntKind, ProdCat } from "../shared/gamedefs";
import type { OrderKind, PlayerState, ProdItem } from "../shared/protocol";

const hasOwn = (o: object, k: unknown): boolean =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
const isB = (k: EntKind): k is BuildingKind => k in BUILDINGS;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
// Mirrors worker.ts ORDER_KINDS.
const ORDER_KINDS = new Set<string>(["move", "amove", "attack", "harvest", "patrol"]);
const UPGRADED_OF: Partial<Record<BuildingKind, BuildingKind>> = {
  barracks: "barracks2",
  factory: "factory2",
  airfield: "airfield2",
  shipyard: "shipyard2",
};

export interface GymObs {
  tick: number;
  you: {
    slot: number;
    credits: number;
    pwrHave: number;
    pwrUse: number;
    lowPower: boolean;
    eliminated: boolean;
    bq: PlayerState["bq"];
    awaiting: BuildingKind[];
    dq?: PlayerState["dq"];
    awaitingDef?: BuildingKind[];
    queues: PlayerState["queues"];
  };
  ents: {
    id: number;
    o: number;
    k: string;
    x: number;
    y: number;
    hp: number;
    mhp: number;
    cargo?: number;
  }[];
  ore: [number, number, number][];
}

export interface GymAction {
  build?: string | null;
  place?: { tx: number; ty: number; cat?: BuildCategory } | null;
  train?: string | null;
  cancelTrain?: string | null;
  order?: { ids: number[]; kind: string; x: number; y: number; target?: number } | null;
  stop?: number[] | null;
  upgrade?: number | null;
  superweapon?: { x: number; y: number } | null;
}

export interface GymStepResult {
  obs: GymObs;
  reward: number;
  done: boolean;
  info: Record<string, unknown>;
}

/**
 * Worker/Node-safe Uint8Array -> base64 encoder (uses chunked `btoa`, zero Node `Buffer` dependency).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    let part = "";
    for (let j = i; j < end; j++) part += String.fromCharCode(bytes[j]);
    bin += part;
  }
  return btoa(bin);
}

/**
 * Structured RL Gym action schema shared between GymEnv and MCP `get_gym_schema`.
 */
export function getGymActionSchema(): Record<string, unknown> {
  return {
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
            "start constructing a structure or defense in parallel queues (needs conyard + credits); finish with `place` once `you.awaiting` or `you.awaitingDef` is set",
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
                cat: { type: "string", enum: ["structure", "defense"] },
              },
            },
            { type: "null" },
          ],
          description: "top-left tile for the awaiting structure or defense; optional `cat` selects queue ('structure'|'defense')",
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
                ids: { type: "array", items: { type: "integer" }, description: "your mobile unit ids (filtered to owned units)" },
                kind: { type: "string", enum: [...ORDER_KINDS] },
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
          description:
            "upgrade a production building ent id to MKII (barracks→barracks2, factory→factory2, airfield→airfield2, shipyard→shipyard2)",
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
  };
}

/**
 * Pure structured RL Gym observation extractor shared 1:1 between GymEnv and live MCP matches.
 */
export function extractGymObs(w: World, slot: number): GymObs {
  const p = w.players.get(slot);
  const ents: GymObs["ents"] = [];
  for (const e of w.ents.values()) {
    const s: GymObs["ents"][number] = {
      id: e.id,
      o: e.o,
      k: e.k,
      x: Math.round(e.x * 100) / 100,
      y: Math.round(e.y * 100) / 100,
      hp: Math.max(0, Math.round(e.hp)),
      mhp: e.mhp,
    };
    if (e.k === "harvester") s.cargo = e.cargo;
    ents.push(s);
  }
  const queues: Partial<Record<ProdCat, ProdItem[]>> = {};
  if (p) {
    for (const cat of ["barracks", "factory", "airfield", "shipyard"] as const) {
      if (p.queues[cat]?.length) queues[cat] = p.queues[cat]!.map((i) => ({ ...i }));
    }
  }
  return {
    tick: w.tick,
    you: {
      slot,
      credits: p ? Math.floor(p.credits) : 0,
      pwrHave: p ? p.pwrHave : 0,
      pwrUse: p ? p.pwrUse : 0,
      lowPower: p ? p.lowPower : false,
      eliminated: p ? p.eliminated : true,
      bq: p ? p.bq.map((i) => ({ ...i })) : [],
      awaiting: p ? [...p.awaiting] : [],
      dq: p ? p.dq.map((i) => ({ ...i })) : [],
      awaitingDef: p ? [...p.awaitingDef] : [],
      queues,
    },
    ents,
    ore: w.oreSnapshot(),
  };
}

/**
 * pysc2-style feature planes, 6 channels of w.w*w.h each:
 *   [0] ore density 0..1   [1] own units (hp frac)   [2] own buildings (1)
 *   [3] foe units (hp frac)[4] foe buildings (1)     [5] all-ent hp frac
 */
export function extractGymFeatureMaps(w: World, slot: number): { w: number; h: number; c: number; data: Float32Array } {
  const mw = w.w,
    mh = w.h;
  const S = mw * mh;
  const out = new Float32Array(6 * S);
  for (const [x, y, amt] of w.oreSnapshot()) out[y * mw + x] = Math.min(1, amt / ORE_CELL_MAX);
  for (const e of w.ents.values()) {
    const mine = e.o === slot;
    const foe = e.o >= 0 && !mine;
    const frac = Math.max(0, Math.min(1, e.hp / e.mhp));
    if (isB(e.k)) {
      if (mine || foe) {
        const d = BUILDINGS[e.k];
        const ch = mine ? 2 : 4;
        const x0 = Math.round(e.x - d.w / 2), y0 = Math.round(e.y - d.h / 2);
        for (let dy = 0; dy < d.h; dy++)
          for (let dx = 0; dx < d.w; dx++) {
            const x = x0 + dx, y = y0 + dy;
            if (x >= 0 && x < mw && y >= 0 && y < mh) out[ch * S + y * mw + x] = 1;
          }
      }
    } else if (mine || foe) {
      const ch = mine ? 1 : 3;
      const x = Math.round(e.x), y = Math.round(e.y);
      if (x >= 0 && x < mw && y >= 0 && y < mh)
        out[ch * S + y * mw + x] = Math.max(out[ch * S + y * mw + x], frac);
    }
    const x = Math.round(e.x), y = Math.round(e.y);
    if (x >= 0 && x < mw && y >= 0 && y < mh)
      out[5 * S + y * mw + x] = Math.max(out[5 * S + y * mw + x], frac);
  }
  return { w: mw, h: mh, c: 6, data: out };
}

/**
 * Minimap-style RGB rasterization of the world — Uint8Array of w*h*3 bytes,
 * `scale` pixels per tile (default 3 => 192x192 on 64x64). Terrain is dark noise,
 * ore is amber by density, ents are slot-colored (dim = low hp).
 */
export function extractGymRgbFrame(w: World, slot: number, scale = 3): { w: number; h: number; data: Uint8Array } {
  void slot;
  const mw = w.w,
    mh = w.h;
  const W = mw * scale, H = mh * scale;
  const img = new Uint8Array(W * H * 3);
  const put = (px: number, py: number, r: number, g: number, b: number) => {
    const i = (py * W + px) * 3;
    img[i] = r; img[i + 1] = g; img[i + 2] = b;
  };
  // terrain: dark slate (or ocean blue for water tiles) with a deterministic per-tile hash for texture
  for (let y = 0; y < mh; y++)
    for (let x = 0; x < mw; x++) {
      const v = 12 + (((x * 73856093) ^ (y * 19349663)) >>> 0) % 10;
      const isW = w.isWater(x, y);
      const r = isW ? 8 : v,
        g = isW ? 28 + (v % 6) : v + 3,
        b = isW ? 58 + (v % 10) : v + 2;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(x * scale + dx, y * scale + dy, r, g, b);
    }
  // ore: amber, brightness by density
  for (const [x, y, amt] of w.oreSnapshot()) {
    const f = 0.45 + 0.55 * Math.min(1, amt / ORE_CELL_MAX);
    for (let dy = 0; dy < scale; dy++)
      for (let dx = 0; dx < scale; dx++) put(x * scale + dx, y * scale + dy, Math.round(255 * f), Math.round(170 * f), Math.round(50 * f));
  }
  const slotRgb = (o: number): [number, number, number] => {
    if (o < 0 || o >= PLAYER_COLORS.length) return [140, 140, 140];
    const h = PLAYER_COLORS[o];
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  };
  // buildings: dimmed slot color across the footprint
  for (const e of w.ents.values()) {
    if (!isB(e.k)) continue;
    const [r, g, b] = slotRgb(e.o);
    const f = 0.35 + 0.35 * Math.max(0, Math.min(1, e.hp / e.mhp));
    const d = BUILDINGS[e.k];
    const x0 = Math.round(e.x - d.w / 2), y0 = Math.round(e.y - d.h / 2);
    for (let dy = 0; dy < d.h; dy++)
      for (let dx = 0; dx < d.w; dx++) {
        const x = x0 + dx, y = y0 + dy;
        if (x < 0 || x >= mw || y < 0 || y >= mh) continue;
        for (let py = 0; py < scale; py++)
          for (let px = 0; px < scale; px++) put(x * scale + px, y * scale + py, Math.round(r * f), Math.round(g * f), Math.round(b * f));
      }
  }
  // units: bright slot color square at position
  for (const e of w.ents.values()) {
    if (isB(e.k)) continue;
    const x = Math.round(e.x), y = Math.round(e.y);
    if (x < 0 || x >= mw || y < 0 || y >= mh) continue;
    const [r, g, b] = slotRgb(e.o);
    const f = 0.55 + 0.45 * Math.max(0, Math.min(1, e.hp / e.mhp));
    const inset = scale >= 3 ? 1 : 0;
    for (let py = inset; py < scale - inset + 1; py++)
      for (let px = inset; px < scale - inset + 1; px++) put(x * scale + px, y * scale + py, Math.round(r * f), Math.round(g * f), Math.round(b * f));
  }
  return { w: W, h: H, data: img };
}

type OpponentKind = "scripted" | "idle" | "mirror";

// Reward shaping constants.
const R_CREDIT = 0.001; // per credit gained during the stepped sim ticks
const R_KILL = 0.05; // per enemy ent (unit or building) destroyed
const R_LOSS = 0.05; // per own ent lost
const R_WIN = 1;
const R_LOSE = -1; // loss, draw, or timeout
const R_INVALID = -0.01; // malformed action penalty

export class GymEnv {
  private w: World;
  private slot: number;
  private opp: number;
  private maxTicks: number;
  private opponent: OpponentKind;
  private finished = false;
  // scripted-opponent state
  private oppLastAssault = -100000;

  constructor(opts: { opponent?: OpponentKind; slot?: number; maxTicks?: number } = {}) {
    this.slot = opts.slot ?? 0;
    this.opp = this.slot === 0 ? 1 : 0;
    this.opponent = opts.opponent ?? "scripted";
    this.maxTicks = opts.maxTicks ?? 6000;
    this.w = this.freshWorld();
  }

  private freshWorld(): World {
    const w = new World([0, 1]);
    this.finished = false;
    this.oppLastAssault = -100000;
    return w;
  }

  reset(): GymObs {
    this.w = this.freshWorld();
    return this.obs();
  }

  /** Underlying world — exposed read-only-ish for tooling/hosted endpoints. */
  get world(): World {
    return this.w;
  }

  actionSchema(): Record<string, unknown> {
    return getGymActionSchema();
  }

  step(action: GymAction, ticks = 10): GymStepResult {
    if (this.finished) {
      return {
        obs: this.obs(),
        reward: 0,
        done: true,
        info: { tick: this.w.tick, winner: this.w.winner, note: "episode already finished" },
      };
    }
    const info: Record<string, unknown> = { opponent: this.opponent };
    const n = num(ticks) ? Math.max(1, Math.min(500, Math.floor(ticks))) : 10;
    const denied: string[] = [];
    const creditsAtStart = this.me().credits;
    let invalid = false;

    const check = this.validate(action);
    if (!check.ok) {
      invalid = true;
      info.invalid = true;
      info.invalidReason = check.reason;
    } else {
      const a = action;
      if (a.build != null) {
        const e = this.w.cmdBuild(this.slot, a.build as BuildingKind);
        if (e) denied.push(`build: ${e}`);
      }
      if (a.place != null) {
        const cat = a.place.cat === "structure" || a.place.cat === "defense" ? a.place.cat : undefined;
        const e = this.w.cmdPlace(this.slot, Math.floor(a.place.tx), Math.floor(a.place.ty), cat);
        if (e) denied.push(`place: ${e}`);
      }
      if (a.train != null) {
        const e = this.w.cmdTrain(this.slot, a.train as UnitKind);
        if (e) denied.push(`train: ${e}`);
      }
      if (a.cancelTrain != null) this.w.cmdTrainCancel(this.slot, a.cancelTrain as UnitKind);
      if (a.order != null) {
        const ids = this.ownUnitIds(a.order.ids);
        const e = this.w.cmdOrder(
          this.slot,
          ids,
          a.order.kind as OrderKind,
          a.order.x,
          a.order.y,
          num(a.order.target) ? a.order.target : undefined,
        );
        if (e) denied.push(`order: ${e}`);
      }
      if (a.stop != null) this.w.cmdStop(this.slot, this.ownUnitIds(a.stop));
      if (a.upgrade != null) {
        const e = this.w.cmdUpgrade(this.slot, a.upgrade);
        if (e) denied.push(`upgrade: ${e}`);
      }
      if (a.superweapon != null) {
        const e = this.w.cmdSuperweapon(this.slot, a.superweapon.x, a.superweapon.y);
        if (e) denied.push(`superweapon: ${e}`);
      }
      if (this.opponent === "mirror") this.mirrorAction(a);
    }
    if (denied.length) info.denied = denied;

    // Ent-id sets for kill/loss counting over this step's sim window.
    const ownBefore = this.idsOf(this.slot);
    const foeBefore = this.idsOf(this.opp);
    const creditsBeforeTicks = this.me().credits;

    for (let i = 0; i < n; i++) {
      if (this.opponent === "scripted") this.scriptedOpp();
      else if (this.opponent === "mirror") this.mirrorHousekeeping();
      this.w.step();
      if (this.w.winner !== null) break;
    }

    // drain events so they can't accumulate across a long episode; surface elims
    const elims: number[] = [];
    for (const ev of this.w.events) if (ev.e === "elim") elims.push(ev.slot);
    this.w.events = [];
    if (elims.length) info.eliminations = elims;

    const ownAfter = this.idsOf(this.slot);
    const foeAfter = this.idsOf(this.opp);
    let kills = 0,
      losses = 0;
    for (const id of foeBefore) if (!foeAfter.has(id)) kills++;
    for (const id of ownBefore) if (!ownAfter.has(id)) losses++;

    const me = this.me();
    const dCredits = me.credits - creditsBeforeTicks;
    const timeout = this.w.winner === null && this.w.tick > this.maxTicks;
    const done = this.w.winner !== null || timeout;
    let terminal = 0;
    if (done) terminal = this.w.winner === this.slot ? R_WIN : R_LOSE;
    let reward = R_CREDIT * dCredits + R_KILL * kills - R_LOSS * losses + terminal;
    if (invalid) reward += R_INVALID;
    this.finished = done;

    info.tick = this.w.tick;
    info.ticks = n;
    info.winner = this.w.winner;
    info.timeout = timeout;
    info.rew = {
      dCredits: Math.round(dCredits),
      spent: Math.round(creditsBeforeTicks - creditsAtStart),
      kills,
      losses,
      terminal,
      invalidPenalty: invalid ? R_INVALID : 0,
      total: Math.round(reward * 10000) / 10000,
    };
    return { obs: this.obs(), reward, done, info };
  }

  // ---------- observation ----------

  private me() {
    return this.w.players.get(this.slot)!;
  }

  private obs(): GymObs {
    return extractGymObs(this.w, this.slot);
  }

  // ---------- visual observations (for pixel/state-hybrid agents) ----------

  /**
   * pysc2-style feature planes, 6 channels of MAP_W*MAP_H each:
   *   [0] ore density 0..1   [1] own units (hp frac)   [2] own buildings (1)
   *   [3] foe units (hp frac)[4] foe buildings (1)     [5] all-ent hp frac
   */
  featureMaps(): { w: number; h: number; c: number; data: Float32Array } {
    return extractGymFeatureMaps(this.w, this.slot);
  }

  /**
   * Minimap-style RGB rasterization of the world — Uint8Array of w*h*3 bytes,
   * `scale` pixels per tile (default 3 => 192x192). Terrain is dark noise,
   * ore is amber by density, ents are slot-colored (dim = low hp).
   */
  rgbFrame(scale = 3): { w: number; h: number; data: Uint8Array } {
    return extractGymRgbFrame(this.w, this.slot, scale);
  }

  private idsOf(slot: number): Set<number> {
    const out = new Set<number>();
    for (const e of this.w.ents.values()) if (e.o === slot) out.add(e.id);
    return out;
  }

  // ---------- validation (mirrors worker.ts dispatch checks) ----------

  private validate(a: GymAction): { ok: boolean; reason?: string } {
    if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, reason: "action must be an object" };
    if (a.build != null && !hasOwn(BUILDINGS, a.build)) return { ok: false, reason: "bad build kind" };
    if (a.train != null && !hasOwn(UNITS, a.train)) return { ok: false, reason: "bad train unit" };
    if (a.cancelTrain != null && !hasOwn(UNITS, a.cancelTrain)) return { ok: false, reason: "bad cancelTrain unit" };
    if (a.place != null) {
      const p = a.place;
      if (!p || typeof p !== "object" || !num(p.tx) || !num(p.ty)) return { ok: false, reason: "bad place coords" };
      if (p.cat != null && p.cat !== "structure" && p.cat !== "defense") return { ok: false, reason: "bad place cat" };
    }
    if (a.order != null) {
      const o = a.order;
      if (!o || typeof o !== "object") return { ok: false, reason: "bad order" };
      if (typeof o.kind !== "string" || !ORDER_KINDS.has(o.kind)) return { ok: false, reason: "bad order kind" };
      if (!num(o.x) || !num(o.y)) return { ok: false, reason: "bad order coords" };
      if (o.target != null && !num(o.target)) return { ok: false, reason: "bad order target" };
    }
    if (a.stop != null && !Array.isArray(a.stop)) return { ok: false, reason: "bad stop ids" };
    if (a.upgrade != null && !num(a.upgrade)) return { ok: false, reason: "bad upgrade id" };
    if (a.superweapon != null) {
      const sw = a.superweapon;
      if (!sw || typeof sw !== "object" || !num(sw.x) || !num(sw.y)) return { ok: false, reason: "bad superweapon coords" };
    }
    return { ok: true };
  }

  /** Finite ids that exist and belong to `slot` as mobile units (never buildings). */
  private ownUnitIds(v: unknown, slot = this.slot): number[] {
    if (!Array.isArray(v)) return [];
    const out: number[] = [];
    for (const id of v) {
      if (!num(id)) continue;
      const e = this.w.ents.get(id);
      if (e && e.o === slot && !isB(e.k)) out.push(id);
    }
    return out;
  }

  // ---------- opponents ----------

  /** Nearest valid placement tile around own buildings, ring search like the client bot. */
  private findSpot(slot: number, kind: BuildingKind): { tx: number; ty: number } | null {
    const d = BUILDINGS[kind];
    const maxR = d.waterOnly ? SHIPYARD_BUILD_DIST + 2 : 4;
    for (const b of this.w.ents.values()) {
      if (b.o !== slot || !isB(b.k)) continue;
      const bd = BUILDINGS[b.k];
      const bx = Math.round(b.x - bd.w / 2),
        by = Math.round(b.y - bd.h / 2);
      for (let r = 1; r <= maxR; r++)
        for (let y = by - r - d.h + 1; y < by + bd.h + r; y++)
          for (let x = bx - r - d.w + 1; x < bx + bd.w + r; x++)
            if (this.w.canPlace(slot, kind, x, y) === null) return { tx: x, ty: y };
    }
    return null;
  }

  private has(slot: number, k: EntKind): boolean {
    const upg = isB(k) ? UPGRADED_OF[k] : undefined;
    for (const e of this.w.ents.values()) {
      if (e.o === slot && (e.k === k || (upg !== undefined && e.k === upg))) return true;
    }
    return false;
  }

  /**
   * Compact scripted baseline: power → refinery → barracks → factory, keep unit
   * queues warm, assault the enemy base once the army is big enough, re-attack
   * periodically. Runs inside the sim loop, throttled to every 4 ticks.
   */
  private scriptedOpp() {
    const w = this.w,
      s = this.opp;
    if (w.tick % 4 !== 0) return;
    const p = w.players.get(s);
    if (!p || p.eliminated) return;

    if (p.awaitingDef.length) {
      const spot = this.findSpot(s, p.awaitingDef[0]);
      if (spot) w.cmdPlace(s, spot.tx, spot.ty, "defense");
    }
    if (p.awaiting.length) {
      const spot = this.findSpot(s, p.awaiting[0]);
      if (spot) w.cmdPlace(s, spot.tx, spot.ty, "structure");
      return;
    }
    if (!p.bq.length) {
      let want: BuildingKind | null = null;
      if (!this.has(s, "power")) want = "power";
      else if (!this.has(s, "refinery")) want = "refinery";
      else if (!this.has(s, "barracks")) want = "barracks";
      else if (!this.has(s, "factory")) want = "factory";
      else if (p.lowPower) want = "power";
      if (want && p.credits >= BUILDINGS[want].cost) w.cmdBuild(s, want);
    }
    if (!p.dq.length && !p.awaitingDef.length && this.has(s, "factory") && !this.has(s, "turret") && p.credits > 2500) {
      w.cmdBuild(s, "turret");
    }
    if (this.has(s, "barracks")) {
      const q = p.queues.barracks;
      if ((q?.length ?? 0) < 4 && p.credits > 400) w.cmdTrain(s, "infantry");
    }
    if (this.has(s, "factory")) {
      const q = p.queues.factory;
      let harv = 0;
      for (const e of w.ents.values()) if (e.o === s && e.k === "harvester") harv++;
      if (harv < 2 && !(q?.length ?? 0) && p.credits > 1600) w.cmdTrain(s, "harvester");
      else if ((q?.length ?? 0) < 4 && p.credits > 900) w.cmdTrain(s, "tank");
    }

    const army = [...w.ents.values()].filter((e) => e.o === s && !isB(e.k) && e.k !== "harvester");
    const cooled = w.tick - this.oppLastAssault > 250;
    if (army.length && cooled && (army.length >= 8 || (army.length >= 4 && w.tick - this.oppLastAssault > 800 && w.tick > 1200))) {
      this.oppLastAssault = w.tick;
      let tgt: { x: number; y: number } | null = null;
      for (const e of w.ents.values())
        if (e.o === this.slot && isB(e.k)) {
          tgt = e;
          break;
        }
      if (!tgt) for (const e of w.ents.values()) if (e.o === this.slot) {
        tgt = e;
        break;
      }
      if (tgt) w.cmdOrder(s, army.map((e) => e.id), "amove", tgt.x, tgt.y);
    }
  }

  /** Mirror: copy the agent's action onto the opponent's side (coords reflected through map center). */
  private mirrorAction(a: GymAction) {
    const w = this.w,
      s = this.opp;
    const p = w.players.get(s);
    if (!p || p.eliminated) return;
    if (a.build != null) w.cmdBuild(s, a.build as BuildingKind);
    if (a.train != null) w.cmdTrain(s, a.train as UnitKind);
    if (a.cancelTrain != null) w.cmdTrainCancel(s, a.cancelTrain as UnitKind);
    if (a.place != null) {
      const cat = a.place.cat;
      const kind =
        cat === "defense" ? p.awaitingDef?.[0] : cat === "structure" ? p.awaiting[0] : (p.awaiting[0] ?? p.awaitingDef?.[0]);
      if (kind) {
        const spot = this.findSpot(s, kind);
        if (spot) w.cmdPlace(s, spot.tx, spot.ty, cat);
      }
    }
    if (a.order != null) {
      const harvest = a.order.kind === "harvest";
      const ids = [...w.ents.values()]
        .filter((e) => e.o === s && !isB(e.k) && (harvest ? e.k === "harvester" : e.k !== "harvester"))
        .map((e) => e.id);
      if (ids.length) w.cmdOrder(s, ids, a.order.kind as OrderKind, w.w - a.order.x, w.h - a.order.y);
    }
    if (a.stop != null) w.cmdStop(s, this.ownUnitIds(a.stop, s));
    if (a.superweapon != null) w.cmdSuperweapon(s, w.w - a.superweapon.x, w.h - a.superweapon.y);
  }

  /** Mirror housekeeping each tick: never leave a finished building or defense unplaced. */
  private mirrorHousekeeping() {
    const w = this.w,
      s = this.opp;
    const p = w.players.get(s);
    if (!p || p.eliminated || w.tick % 4 !== 0) return;
    if (p.awaiting.length) {
      const spot = this.findSpot(s, p.awaiting[0]);
      if (spot) w.cmdPlace(s, spot.tx, spot.ty, "structure");
    }
    if (p.awaitingDef?.length) {
      const spot = this.findSpot(s, p.awaitingDef[0]);
      if (spot) w.cmdPlace(s, spot.tx, spot.ty, "defense");
    }
  }
}
