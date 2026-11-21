// OpenAI-gym-style RL environment wrapping a single authoritative World.
// The agent controls one slot; a built-in opponent controls the other.
// Self-contained: the scripted opponent below is intentionally inlined —
// the dedicated networked bot lives elsewhere (test/bot.mjs / src/server/bot.ts
// is owned by another agent) and must NOT be imported here.
//
//   const env = new GymEnv({ opponent: "scripted", maxTicks: 6000 });
//   let obs = env.reset();
//   const { obs, reward, done, info } = env.step({ build: "power" }, 10);

import { World } from "./world";
import { MAP_W, MAP_H, BUILDINGS, UNITS } from "../shared/gamedefs";
import type { BuildingKind, UnitKind, EntKind } from "../shared/gamedefs";
import type { OrderKind, PlayerState } from "../shared/protocol";

const hasOwn = (o: object, k: unknown): boolean =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
const isB = (k: EntKind): k is BuildingKind => k in BUILDINGS;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
// Mirrors worker.ts ORDER_KINDS.
const ORDER_KINDS = new Set<string>(["move", "amove", "attack", "harvest"]);

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
    awaiting: BuildingKind | null;
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
  place?: { tx: number; ty: number } | null;
  train?: string | null;
  cancelTrain?: string | null;
  order?: { ids: number[]; kind: string; x: number; y: number; target?: number } | null;
  stop?: number[] | null;
}

export interface GymStepResult {
  obs: GymObs;
  reward: number;
  done: boolean;
  info: Record<string, unknown>;
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

  actionSchema(): object {
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
            description: "start constructing a building (needs conyard + credits); finish with `place` once `you.awaiting` is set",
          },
          place: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["tx", "ty"],
                properties: { tx: { type: "integer" }, ty: { type: "integer" } },
              },
              { type: "null" },
            ],
            description: "top-left tile for the awaiting building; must sit within 2 tiles of your buildings on clear non-ore ground",
          },
          train: {
            anyOf: [{ type: "string", enum: Object.keys(UNITS) }, { type: "null" }],
            description: "queue one unit: infantry→barracks, tank→factory, harvester→factory(+refinery)",
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
        },
      },
    };
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
        const e = this.w.cmdPlace(this.slot, Math.floor(a.place.tx), Math.floor(a.place.ty));
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
    const p = this.me();
    const ents: GymObs["ents"] = [];
    for (const e of this.w.ents.values()) {
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
    return {
      tick: this.w.tick,
      you: {
        slot: this.slot,
        credits: Math.floor(p.credits),
        pwrHave: p.pwrHave,
        pwrUse: p.pwrUse,
        lowPower: p.lowPower,
        eliminated: p.eliminated,
        bq: p.bq ? { ...p.bq } : null,
        awaiting: p.awaiting,
        queues: { ...p.queues },
      },
      ents,
      ore: this.w.oreSnapshot(),
    };
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
    }
    if (a.order != null) {
      const o = a.order;
      if (!o || typeof o !== "object") return { ok: false, reason: "bad order" };
      if (typeof o.kind !== "string" || !ORDER_KINDS.has(o.kind)) return { ok: false, reason: "bad order kind" };
      if (!num(o.x) || !num(o.y)) return { ok: false, reason: "bad order coords" };
      if (o.target != null && !num(o.target)) return { ok: false, reason: "bad order target" };
    }
    if (a.stop != null && !Array.isArray(a.stop)) return { ok: false, reason: "bad stop ids" };
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
    for (const b of this.w.ents.values()) {
      if (b.o !== slot || !isB(b.k)) continue;
      const bd = BUILDINGS[b.k];
      const bx = Math.round(b.x - bd.w / 2),
        by = Math.round(b.y - bd.h / 2);
      for (let r = 1; r <= 4; r++)
        for (let y = by - r - d.h + 1; y < by + bd.h + r; y++)
          for (let x = bx - r - d.w + 1; x < bx + bd.w + r; x++)
            if (this.w.canPlace(slot, kind, x, y) === null) return { tx: x, ty: y };
    }
    return null;
  }

  private has(slot: number, k: EntKind): boolean {
    for (const e of this.w.ents.values()) if (e.o === slot && e.k === k) return true;
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

    if (p.awaiting) {
      const spot = this.findSpot(s, p.awaiting);
      if (spot) w.cmdPlace(s, spot.tx, spot.ty);
      return;
    }
    if (!p.bq) {
      let want: BuildingKind | null = null;
      if (!this.has(s, "power")) want = "power";
      else if (!this.has(s, "refinery")) want = "refinery";
      else if (!this.has(s, "barracks")) want = "barracks";
      else if (!this.has(s, "factory")) want = "factory";
      else if (p.lowPower) want = "power";
      else if (!this.has(s, "turret") && p.credits > 2500) want = "turret";
      if (want && p.credits >= BUILDINGS[want].cost) w.cmdBuild(s, want);
    }
    if (this.has(s, "barracks")) {
      const q = p.queues.barracks;
      if ((q?.count ?? 0) < 4 && p.credits > 400) w.cmdTrain(s, "infantry");
    }
    if (this.has(s, "factory")) {
      const q = p.queues.factory;
      let harv = 0;
      for (const e of w.ents.values()) if (e.o === s && e.k === "harvester") harv++;
      if (harv < 2 && !(q?.count ?? 0) && p.credits > 1600) w.cmdTrain(s, "harvester");
      else if ((q?.count ?? 0) < 4 && p.credits > 900) w.cmdTrain(s, "tank");
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
    if (a.place != null && p.awaiting) {
      const spot = this.findSpot(s, p.awaiting);
      if (spot) w.cmdPlace(s, spot.tx, spot.ty);
    }
    if (a.order != null) {
      const harvest = a.order.kind === "harvest";
      const ids = [...w.ents.values()]
        .filter((e) => e.o === s && !isB(e.k) && (harvest ? e.k === "harvester" : e.k !== "harvester"))
        .map((e) => e.id);
      if (ids.length) w.cmdOrder(s, ids, a.order.kind as OrderKind, MAP_W - a.order.x, MAP_H - a.order.y);
    }
    if (a.stop != null) w.cmdStop(s, this.ownUnitIds(a.stop, s));
  }

  /** Mirror housekeeping each tick: never leave a finished building unplaced. */
  private mirrorHousekeeping() {
    const w = this.w,
      s = this.opp;
    const p = w.players.get(s);
    if (!p || p.eliminated || !p.awaiting || w.tick % 4 !== 0) return;
    const spot = this.findSpot(s, p.awaiting);
    if (spot) w.cmdPlace(s, spot.tx, spot.ty);
  }
}
