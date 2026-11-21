// Server-side AI opponent ("bot player"). The worker constructs one RtsBot per
// bot-controlled slot and calls think() once per world tick (10 Hz).
//
// The bot plays through the same public command API a real client uses
// (cmdBuild/cmdPlace/cmdTrain/cmdOrder/cmdStop) and reads only public state
// (ents, players, canPlace, oreSnapshot, passable). No private fields, no
// freebies — it pays for everything and can be denied like a human.
//
// Strategy: scripted build order (power -> refinery -> barracks -> factory)
// -> tech climb (radar -> techlab -> factory upgrade) -> two-harvester
// economy -> continuous infantry/vehicle production -> grouped assault waves
// at the nearest enemy base, plus reactive defense of its own buildings and
// harvesters, and repairs when it can afford them.
//
// Cost discipline: think() runs every tick, so heavy work is throttled —
//   every tick   : place a finished building (build queue stalls otherwise)
//   every 8 tks  : threat scan + defense orders
//   every ~45 tks: economy/production/rally/assault decisions + ore rescan

import type { Ent, P, World } from "./world";
import { BUILDINGS, MAP_H, MAP_W, SPAWNS, UNITS, UPGRADE_COST } from "../shared/gamedefs";
import type { BuildingKind, EntKind, UnitKind } from "../shared/gamedefs";

const isB = (k: EntKind): k is BuildingKind => k in BUILDINGS;
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const DEF_RADIUS = 15; // enemy this close to our stuff = threat
const GUARD_RADIUS = 26; // only units this close to home get defensive orders
const HOME_RADIUS = 30; // "away" = further than this from base center

// Game phase — derived from tech progression, not wall-clock. early: no war
// factory yet (economy + scout). mid: factory online, expand + raid enemy eco.
// late: sustained assault on their base with bigger, more frequent waves.
type Phase = "early" | "mid" | "late";

export interface RtsBotOpts {
  aggressive?: boolean; // earlier waves, bigger queues, extra turret
}

export class RtsBot {
  // introspection for tests/logging — read-only diagnostics
  denies = 0; // unexpected cmd* denials seen
  lastDeny = ""; // message of the most recent unexpected denial
  waves = 0; // assault waves launched
  errors: string[] = []; // swallowed exceptions (should stay empty)

  private aggro: boolean;
  private nextCheap = 0;
  private nextSlow = 30;
  private nextPlaceTry = 0;
  private awaitingSince = -1; // tick we first saw current `awaiting`
  private deniedTiles = new Set<string>(); // "kind:tx,ty" that cmdPlace refused
  private oreCache: [number, number, number][] = [];
  private oreAt = -1e9;
  private lastAssault = -1e9;
  private firstWaveAt: number;
  private assaultEvery: number;
  private waveMin: number;
  private lastDefend = -1e9;
  private threatAt = -1e9;
  private lastScout = -1e9;
  private phase: Phase = "early";
  private rocketNext = false; // alternates what a fresh barracks queue starts with
  private infCap: number;
  private tankCap: number;
  private turretCap: number;

  constructor(
    private world: World,
    private slot: number,
    opts?: RtsBotOpts,
  ) {
    this.aggro = opts?.aggressive ?? false;
    // jittered so identical bots on different slots don't move in lockstep
    this.firstWaveAt = (this.aggro ? 620 : 1050) + ((Math.random() * 140) | 0) + slot * 53;
    this.assaultEvery = this.aggro ? 330 : 480;
    this.waveMin = this.aggro ? 6 : 8;
    this.infCap = this.aggro ? 6 : 4;
    this.tankCap = this.aggro ? 4 : 3;
    this.turretCap = this.aggro ? 3 : 2;
  }

  think(): void {
    try {
      this.inner();
    } catch (e) {
      if (this.errors.length < 25) this.errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
  }

  private inner() {
    const w = this.world;
    if (w.winner !== null) return;
    const me = w.players.get(this.slot);
    if (!me || me.eliminated) return;
    const t = w.tick;

    // A finished building sits in `awaiting` and blocks the build queue —
    // placing it is the most time-sensitive thing the bot does.
    if (me.awaiting) {
      if (this.awaitingSince < 0) this.awaitingSince = t;
      if (t >= this.nextPlaceTry) {
        this.nextPlaceTry = t + 4;
        this.place(me.awaiting, t);
      }
    } else this.awaitingSince = -1;

    if (t >= this.nextCheap) {
      this.nextCheap = t + 8;
      this.defend(t);
    }
    if (t >= this.nextSlow) {
      this.nextSlow = t + 38 + ((Math.random() * 14) | 0);
      this.slow(me, t);
    }
  }

  // ---------- shared scans ----------

  private baseCenter(): { x: number; y: number } | null {
    let sx = 0,
      sy = 0,
      n = 0;
    for (const e of this.world.ents.values()) {
      if (e.o !== this.slot || !isB(e.k)) continue;
      sx += e.x;
      sy += e.y;
      n++;
    }
    if (!n) {
      // no buildings left: the army is the base
      for (const e of this.world.ents.values()) {
        if (e.o !== this.slot) continue;
        sx += e.x;
        sy += e.y;
        n++;
      }
    }
    if (!n) {
      const s = SPAWNS[this.slot];
      return s ? { x: s.x + 1.5, y: s.y + 1.5 } : null;
    }
    return { x: sx / n, y: sy / n };
  }

  private buildingCounts(): Map<BuildingKind, number> {
    const m = new Map<BuildingKind, number>();
    for (const e of this.world.ents.values()) {
      if (e.o !== this.slot || !isB(e.k)) continue;
      m.set(e.k, (m.get(e.k) ?? 0) + 1);
    }
    return m;
  }

  // factory2 satisfies "factory" for bot logic too — the upgraded ent
  // replaces the original rather than sitting alongside it.
  private hasBuilding(bc: Map<BuildingKind, number>, k: BuildingKind): boolean {
    return (bc.get(k) ?? 0) > 0 || (k === "factory" && (bc.get("factory2") ?? 0) > 0);
  }

  // nearest enemy building to `ref` — the assault target
  private enemyBasePt(ref: { x: number; y: number }): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null,
      bd = Infinity;
    for (const e of this.world.ents.values()) {
      if (e.o === this.slot || e.o < 0 || !isB(e.k)) continue;
      if (this.world.players.get(e.o)?.eliminated) continue;
      const d = dist(ref.x, ref.y, e.x, e.y);
      if (d < bd) {
        bd = d;
        best = { x: e.x, y: e.y };
      }
    }
    return best;
  }

  private nearestEnemyEnt(ref: { x: number; y: number }): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null,
      bd = Infinity;
    for (const e of this.world.ents.values()) {
      if (e.o === this.slot || e.o < 0) continue;
      if (this.world.players.get(e.o)?.eliminated) continue;
      const d = dist(ref.x, ref.y, e.x, e.y);
      if (d < bd) {
        bd = d;
        best = { x: e.x, y: e.y };
      }
    }
    return best;
  }

  private oreNear(ref: { x: number; y: number }): { x: number; y: number } | null {
    if (!this.oreCache.length) return null;
    let best: { x: number; y: number } | null = null,
      bd = Infinity;
    for (const [x, y] of this.oreCache) {
      const d = dist(ref.x, ref.y, x + 0.5, y + 0.5);
      if (d < bd) {
        bd = d;
        best = { x: x + 0.5, y: y + 0.5 };
      }
    }
    return best;
  }

  // ---------- construction ----------

  // Where a building "wants" to be: refinery hugs the ore field, turret sits
  // on the enemy-facing edge, everything else stays compact near the core.
  private placeGoal(kind: BuildingKind, base: { x: number; y: number }): { x: number; y: number } {
    if (kind === "refinery") {
      const o = this.oreNear(base);
      if (o) return o;
    }
    if (kind === "turret" || kind === "arc") {
      const foe = this.enemyBasePt(base);
      const dir = foe ?? { x: MAP_W / 2, y: MAP_H / 2 };
      const dx = dir.x - base.x,
        dy = dir.y - base.y,
        l = Math.hypot(dx, dy) || 1;
      return { x: base.x + (dx / l) * 8, y: base.y + (dy / l) * 8 };
    }
    return base;
  }

  // Scan candidate top-left tiles in the adjacency band (gap <= 2) around each
  // owned building; validate every candidate with the world's own canPlace.
  private findSpot(kind: BuildingKind): { tx: number; ty: number } | null {
    const w = this.world,
      d = BUILDINGS[kind];
    const base = this.baseCenter();
    if (!base) return null;
    const goal = this.placeGoal(kind, base);
    let best: { tx: number; ty: number } | null = null,
      bs = Infinity;
    for (const b of w.ents.values()) {
      if (b.o !== this.slot || !isB(b.k)) continue;
      const bd = BUILDINGS[b.k];
      const bx = Math.round(b.x - bd.w / 2),
        by = Math.round(b.y - bd.h / 2);
      for (let ty = by - d.h - 2; ty <= by + bd.h + 2; ty++) {
        for (let tx = bx - d.w - 2; tx <= bx + bd.w + 2; tx++) {
          if (this.deniedTiles.has(`${kind}:${tx},${ty}`)) continue;
          if (w.canPlace(this.slot, kind, tx, ty) !== null) continue;
          const s = dist(tx + d.w / 2, ty + d.h / 2, goal.x, goal.y);
          if (s < bs) {
            bs = s;
            best = { tx, ty };
          }
        }
      }
    }
    return best;
  }

  private place(kind: BuildingKind, t: number) {
    const spot = this.findSpot(kind);
    if (!spot) {
      // boxed in — refund rather than stall the queue forever
      if (t - this.awaitingSince > 400) this.world.cmdBuildCancel(this.slot);
      return;
    }
    const err = this.world.cmdPlace(this.slot, spot.tx, spot.ty);
    if (err) {
      this.denies++;
      this.lastDeny = err;
      this.deniedTiles.add(`${kind}:${spot.tx},${spot.ty}`);
    }
  }

  // next building the bot wants, or null. Phase-aware: early is a strict
  // build order; mid climbs the tech tree (radar -> techlab) and layers in
  // defense + a second refinery; late adds the purifier and keeps replacing
  // losses. The ordering doubles as prereq sequencing, so a "need a radar"
  // denial just means the prereq hasn't landed yet — next slow tick retries.
  private wantBuilding(me: P, bc: Map<BuildingKind, number>): BuildingKind | null {
    const has = (k: BuildingKind) => this.hasBuilding(bc, k);
    if (!has("conyard")) return null; // nothing to build with
    // early: the classic opener, nothing else competes for the queue
    if (!has("power")) return "power";
    if (!has("refinery")) return "refinery";
    if (!has("barracks")) return "barracks";
    if (!has("factory")) return "factory";
    // brownout always wins — production halves at low power
    if (me.lowPower) return "power";
    if (me.pwrHave - me.pwrUse < 20 && (bc.get("power") ?? 0) < 3) return "power";
    // tech wants (a factory exists by here): radar unlocks arc/rocket/arty,
    // techlab the factory upgrade + purifier. Each draws a lot of power, so
    // if placing it would brown us out, grow the grid first instead.
    if (!has("radar")) {
      if (me.pwrHave - me.pwrUse < 45 && (bc.get("power") ?? 0) < 3) return "power";
      return "radar";
    }
    if (!has("techlab") && me.credits > 1400) {
      if (me.pwrHave - me.pwrUse < 60 && (bc.get("power") ?? 0) < 3) return "power";
      return "techlab";
    }
    // defense: arc coils replace turrets once radar is up and they're
    // affordable; the count stays a shared turret+arc total
    const defense = (bc.get("turret") ?? 0) + (bc.get("arc") ?? 0);
    const turretGoal = this.phase === "early" ? 1 : this.phase === "mid" ? Math.min(2, this.turretCap) : this.turretCap;
    const pickDef = (): BuildingKind => (has("radar") && me.credits > 900 ? "arc" : "turret");
    if (defense < turretGoal) return pickDef();
    // mid: second refinery once the first economy is humming
    const refs = bc.get("refinery") ?? 0;
    if (this.phase !== "early" && me.credits > 3000 && refs < 2) return "refinery";
    if (me.credits > 3200 && !has("depot")) return "depot"; // keeps the armor column repaired
    if (me.credits > 3200 && defense < this.turretCap) return pickDef();
    // late: the purifier pays for itself; keep expanding economy/power when flush
    if (this.phase === "late" && has("techlab") && !has("purifier") && me.credits > 2400) return "purifier";
    if (this.phase === "late" && me.credits > 4200 && refs < 3) return "refinery";
    if (me.credits > 4000 && (bc.get("power") ?? 0) < 3) return "power";
    return null;
  }

  // ---------- production ----------

  private produce(me: P, bc: Map<BuildingKind, number>, want: BuildingKind | null) {
    const w = this.world;
    // credits we're saving for the next building — early saves harder for the
    // opener, late spends freely since the base is done
    const reserve = want ? Math.min(BUILDINGS[want].cost, this.phase === "early" ? 650 : 450) : this.phase === "late" ? 200 : 150;
    const radar = this.hasBuilding(bc, "radar");
    const f2 = this.hasBuilding(bc, "factory2");
    let harv = 0,
      army = 0,
      engi = 0,
      artys = 0,
      heavies = 0,
      spiders = 0;
    for (const e of w.ents.values()) {
      if (e.o !== this.slot) continue;
      if (e.k === "harvester") harv++;
      else if (!isB(e.k)) {
        army++;
        if (e.k === "engineer") engi++;
        else if (e.k === "arty") artys++;
        else if (e.k === "heavy") heavies++;
        else if (e.k === "spider") spiders++;
      }
    }

    // barracks: infantry scaled by phase, rocket troopers alternating in once
    // radar is up, and exactly one engineer kept on retainer for late pushes
    const infGoal = this.phase === "early" ? Math.min(2, this.infCap) : this.phase === "mid" ? this.infCap : this.infCap + 2;
    if ((bc.get("barracks") ?? 0) > 0 && army < 45) {
      const q = me.queues.barracks;
      if (!q && !engi && me.credits > 800) {
        this.trycmd(() => w.cmdTrain(this.slot, "engineer"));
      } else {
        // a fresh queue alternates what it starts with, so rockets mix in
        const unit: UnitKind = radar && this.rocketNext ? "rocket" : "infantry";
        if ((!q || q.unit === unit) && (q?.count ?? 0) < infGoal && me.credits >= UNITS[unit].cost + reserve) {
          this.trycmd(() => w.cmdTrain(this.slot, unit));
          if (!q) this.rocketNext = !this.rocketNext;
        }
      }
    }

    if (this.hasBuilding(bc, "factory")) {
      const q = me.queues.factory;
      // harvesters scale with phase: 2 early, 3 mid, 4 when flush late
      const harvGoal = this.phase === "early" ? 2 : me.credits > 3000 ? 4 : 3;
      const tankGoal = this.phase === "late" ? this.tankCap + 3 : this.tankCap;
      if (!q) {
        // fresh queue: harvester first, then ~2 arty for siege support, then
        // the f2 heavy/spider mix (~4 each), else plain tanks
        let unit: UnitKind | null = null;
        if (harv < harvGoal) unit = "harvester";
        else if (this.phase !== "early") {
          if (radar && artys < 2) unit = "arty";
          else if (f2 && heavies < 4 && heavies <= spiders) unit = "heavy";
          else if (f2 && spiders < 4) unit = "spider";
          else if (f2 && heavies < 4) unit = "heavy";
          else unit = "tank";
        }
        if (unit && (unit === "harvester" || army < 45) && me.credits >= UNITS[unit].cost + reserve) {
          this.trycmd(() => w.cmdTrain(this.slot, unit));
        }
      } else {
        // one shared queue — stack more of what's already in it (queued units
        // count toward the caps) instead of fighting a different queue unit
        const u = q.unit;
        const cap = u === "tank" ? tankGoal : u === "arty" ? 2 : u === "heavy" || u === "spider" ? 4 : 0;
        const fielded = u === "arty" ? artys : u === "heavy" ? heavies : u === "spider" ? spiders : 0;
        if (cap > 0 && fielded + q.count < cap && army < 45 && me.credits >= UNITS[u].cost + reserve) {
          this.trycmd(() => w.cmdTrain(this.slot, u));
        }
        // a queued harvester is left to finish rather than cancelled
      }
    }
  }

  private trycmd(fn: () => string | null) {
    const err = fn();
    // routine denials (saving up / shared queue / prereqs still teching) are
    // expected; anything else suggests a bot bug worth surfacing in diagnostics
    if (err && err !== "insufficient funds" && err !== "queue busy" && err !== "queue full" && err !== "construction in progress" && !err.startsWith("need a ")) {
      this.denies++;
      this.lastDeny = err;
    }
  }

  // Patch up the most-damaged building (cmdRepair: 25% of build cost -> full
  // hp). Feature-detected: if the World build lacks cmdRepair, skip quietly.
  private repairs(me: P, reserve: number) {
    const w = this.world;
    let worst: Ent | null = null,
      worstK: BuildingKind = "conyard",
      worstPct = 0.6; // ignore cosmetic damage
    for (const e of w.ents.values()) {
      if (e.o !== this.slot || !isB(e.k)) continue;
      const pct = e.hp / e.mhp;
      if (pct < worstPct) {
        worstPct = pct;
        worst = e;
        worstK = e.k;
      }
    }
    if (!worst) return;
    const repair = (w as unknown as { cmdRepair?: (slot: number, id: number) => string | null }).cmdRepair;
    if (!repair) return;
    const cost = Math.ceil(BUILDINGS[worstK].cost * 0.25);
    if (me.credits >= cost + (worstK === "conyard" ? 0 : reserve)) {
      this.trycmd(() => repair.call(w, this.slot, (worst as Ent).id));
    }
  }

  // Late game: with a tech lab up and credits to spare, upgrade the war
  // factory (factory -> factory2) to unlock heavies + spiders.
  private upgrade(me: P, bc: Map<BuildingKind, number>) {
    if (this.phase !== "late") return;
    if (!this.hasBuilding(bc, "techlab") || !this.hasBuilding(bc, "factory") || this.hasBuilding(bc, "factory2")) return;
    if (me.credits <= UPGRADE_COST + 900) return;
    for (const e of this.world.ents.values()) {
      if (e.o === this.slot && e.k === "factory") {
        this.trycmd(() => this.world.cmdUpgrade(this.slot, e.id));
        return;
      }
    }
  }

  // Idle harvesters normally restart on their own (auto-start scans r=10), but
  // one stranded far from ore gets an explicit harvest order to a known cell.
  private wakeHarvesters() {
    if (!this.oreCache.length) return;
    const w = this.world;
    for (const e of w.ents.values()) {
      if (e.o !== this.slot || e.k !== "harvester" || e.order || e.hstate) continue;
      const o = this.oreNear(e);
      if (o) this.trycmd(() => w.cmdOrder(this.slot, [e.id], "harvest", o.x, o.y));
    }
  }

  // ---------- military ----------

  // Early game: send a lone infantry toward the enemy spawn to scout — cheap
  // map intel, and occasionally draws out their defense early.
  private scout(t: number) {
    if (this.phase !== "early" || t - this.lastScout < 600) return;
    const w = this.world;
    const base = this.baseCenter();
    if (!base) return;
    let scout: Ent | null = null;
    for (const e of w.ents.values()) {
      if (e.o !== this.slot || e.k !== "infantry" || e.order) continue;
      scout = e;
      break;
    }
    if (!scout) return;
    // attack-move toward the enemy's spawn, via map middle — sees plenty en route
    const foe = this.enemyBasePt(base);
    const tgt = foe ?? { x: MAP_W - base.x, y: MAP_H - base.y };
    const mid = { x: (base.x + tgt.x) / 2, y: (base.y + tgt.y) / 2 };
    this.trycmd(() => w.cmdOrder(this.slot, [scout!.id], "amove", mid.x, mid.y));
    this.lastScout = t;
  }

  // Raid target for mid-game waves: enemy harvesters/refineries — hitting
  // their economy instead of their turret line (the classic RA2 harassment).
  private ecoRaidTarget(base: { x: number; y: number }): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null,
      bd = Infinity;
    for (const e of this.world.ents.values()) {
      if (e.o === this.slot || e.o < 0) continue;
      if (this.world.players.get(e.o)?.eliminated) continue;
      if (e.k !== "harvester" && e.k !== "refinery") continue;
      const d = dist(base.x, base.y, e.x, e.y);
      if (d < bd) {
        bd = d;
        best = { x: e.x, y: e.y };
      }
    }
    return best;
  }

  // Group idle combat units at a muster point on the enemy-facing edge of the
  // base. Only home-guard units (near base, no order) are touched — troops
  // already fighting at the enemy base keep their orders.
  private rally() {
    const w = this.world;
    const base = this.baseCenter();
    if (!base) return;
    const foe = this.enemyBasePt(base) ?? { x: MAP_W / 2, y: MAP_H / 2 };
    const dx = foe.x - base.x,
      dy = foe.y - base.y,
      l = Math.hypot(dx, dy) || 1;
    // early holds a tight ring; later phases stage further out toward the enemy
    const musterD = this.phase === "early" ? 5 : this.phase === "mid" ? 8 : 11;
    const mx = clamp(base.x + (dx / l) * musterD, 1, MAP_W - 2),
      my = clamp(base.y + (dy / l) * musterD, 1, MAP_H - 2);
    const ids: number[] = [];
    for (const e of w.ents.values()) {
      if (e.o !== this.slot || isB(e.k) || e.k === "harvester" || e.order) continue;
      if (dist(e.x, e.y, base.x, base.y) > HOME_RADIUS) continue;
      if (dist(e.x, e.y, mx, my) <= 4.5) continue;
      ids.push(e.id);
    }
    if (ids.length) this.trycmd(() => w.cmdOrder(this.slot, ids, "move", mx, my));
  }

  // cheap loop (~8 ticks): enemies near our buildings/harvesters get a
  // response from home-guard units. Far-away wave troops are NOT recalled.
  private defend(t: number) {
    const w = this.world;
    const base = this.baseCenter();
    if (!base) return;
    const mine: Ent[] = [];
    for (const m of w.ents.values()) {
      if (m.o === this.slot && (isB(m.k) || m.k === "harvester")) mine.push(m);
    }
    // nearest enemy ent to any of our buildings or harvesters
    let threat: Ent | null = null,
      bd = DEF_RADIUS * DEF_RADIUS;
    for (const e of w.ents.values()) {
      if (e.o === this.slot || e.o < 0) continue;
      const p = w.players.get(e.o);
      if (p && p.eliminated) continue;
      for (const m of mine) {
        const d2 = (e.x - m.x) * (e.x - m.x) + (e.y - m.y) * (e.y - m.y);
        if (d2 < bd) {
          bd = d2;
          threat = e;
        }
      }
    }
    if (!threat) return;
    this.threatAt = t;
    if (t - this.lastDefend < 15) return; // don't thrash orders every scan
    this.lastDefend = t;
    const ids: number[] = [];
    for (const e of w.ents.values()) {
      if (e.o !== this.slot || isB(e.k) || e.k === "harvester") continue;
      if (dist(e.x, e.y, base.x, base.y) > GUARD_RADIUS) continue;
      ids.push(e.id);
    }
    if (ids.length) this.trycmd(() => w.cmdOrder(this.slot, ids, "amove", threat.x, threat.y));
  }

  // slow loop: launch waves at the nearest enemy base; keep far-away troops
  // grinding on whatever enemy structure is nearest to them.
  private assault(t: number) {
    const w = this.world;
    const base = this.baseCenter();
    if (!base) return;
    const army: Ent[] = [],
      awayIdle: Ent[] = [];
    for (const e of w.ents.values()) {
      if (e.o !== this.slot || isB(e.k) || e.k === "harvester") continue;
      army.push(e);
      if (!e.order && dist(e.x, e.y, base.x, base.y) > HOME_RADIUS) awayIdle.push(e);
    }
    if (!army.length) return;

    const tgt = this.enemyBasePt(base) ?? this.nearestEnemyEnt(base);

    // stranded attackers: re-engage the nearest enemy structure/unit to THEM,
    // or come home if the field is clear
    if (awayIdle.length) {
      let ax = 0,
        ay = 0;
      for (const u of awayIdle) {
        ax += u.x;
        ay += u.y;
      }
      const c = { x: ax / awayIdle.length, y: ay / awayIdle.length };
      const local = this.enemyBasePt(c) ?? this.nearestEnemyEnt(c);
      const ids = awayIdle.map((u) => u.id);
      if (local) this.trycmd(() => w.cmdOrder(this.slot, ids, "amove", local.x, local.y));
      else this.trycmd(() => w.cmdOrder(this.slot, ids, "move", base.x, base.y));
    }

    // phase-aware assault: early holds (economy first), mid raids their
    // economy, late pushes the base with bigger, more frequent waves
    if (this.phase === "early") return;
    const waveMin = this.phase === "late" ? this.waveMin + 3 : this.waveMin;
    const interval = this.phase === "late" ? Math.round(this.assaultEvery * 0.6) : this.assaultEvery;
    const raid = this.phase === "mid" ? this.ecoRaidTarget(base) : null;
    const goal = raid ?? tgt;
    if (!goal) return;
    const recentThreat = t - this.threatAt < 50;
    const due = this.lastAssault < 0 ? t >= this.firstWaveAt : t - this.lastAssault >= interval;
    // an oversized force attacks early, but not more often than ~12s
    const big = army.length >= waveMin * 2 && t - this.lastAssault >= 120;
    // late game presses the advantage even without a full wave if it's big enough
    const press = this.phase === "late" && army.length >= waveMin + 5 && t - this.lastAssault >= interval / 2;
    if (army.length >= waveMin && (due || big || press) && !recentThreat) {
      // the lone engineer rides along only on big late pushes — it's the
      // capture threat, and feeding it into a small skirmish just wastes it
      const takeEngi = this.phase !== "late" || army.length >= waveMin * 1.5;
      const ids = army.filter((e) => e.k !== "engineer" || takeEngi).map((e) => e.id);
      const err = w.cmdOrder(this.slot, ids, "amove", goal.x, goal.y);
      if (err) {
        this.denies++;
        this.lastDeny = err;
        return;
      }
      this.lastAssault = t;
      this.waves++;
    }
  }

  // ---------- slow strategy tick ----------

  // Phase follows tech, not the clock: early until the war factory is up,
  // mid while the economy/army are still small, late once the war machine
  // is self-sustaining (second refinery up or a real army fielded).
  private phaseOf(me: P, bc: Map<BuildingKind, number>, army: number, t: number): Phase {
    if (!this.hasBuilding(bc, "factory")) return "early"; // factory2 counts — post-upgrade is not "early"
    const refs = bc.get("refinery") ?? 0;
    if (army >= 16 || (refs >= 2 && army >= 10) || t > 2600) return "late";
    return "mid";
  }

  private slow(me: P, t: number) {
    const w = this.world;
    if (t - this.oreAt > 120) {
      this.oreCache = w.oreSnapshot();
      this.oreAt = t;
    }
    const bc = this.buildingCounts();
    let army = 0;
    for (const e of w.ents.values()) {
      if (e.o === this.slot && !isB(e.k) && e.k !== "harvester") army++;
    }
    this.phase = this.phaseOf(me, bc, army, t);
    const want = this.wantBuilding(me, bc);
    if (want && !me.bq && !me.awaiting && me.credits >= BUILDINGS[want].cost) {
      this.trycmd(() => w.cmdBuild(this.slot, want));
    }
    this.produce(me, bc, want);
    this.repairs(me, want ? Math.min(BUILDINGS[want].cost, 500) : 150);
    this.upgrade(me, bc);
    this.wakeHarvesters();
    this.scout(t);
    this.rally();
    this.assault(t);
  }
}

// Compatibility shim for worker.ts, which manages bots as
//   const bots = new Map<string, AIBot>(); // player id -> brain
//   new AIBot(id);                          // lobby add-bot
//   bot.tick(world, slot);                  // once per sim tick
// The world isn't known until the game starts, so the RtsBot is created lazily
// on first tick (and re-created if the world instance changes, e.g. rematch).
export class AIBot {
  private impl: RtsBot | null = null;
  private w: World | null = null;
  private s = -1;

  constructor(
    public readonly id: string,
    private opts?: RtsBotOpts,
  ) {}

  tick(world: World, slot: number) {
    if (!this.impl || this.w !== world || this.s !== slot) {
      this.impl = new RtsBot(world, slot, this.opts ?? { aggressive: true });
      this.w = world;
      this.s = slot;
    }
    this.impl.think();
  }
}
