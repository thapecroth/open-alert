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
//   every 4-16 tks: place a finished building (scaled by difficulty)
//   every 8-20 tks: threat scan + defense orders (scaled by difficulty)
//   every 36-95 tks: economy/production/rally/assault decisions + ore rescan

import type { Ent, P, World } from "./world";
import { BUILDINGS, MAP_H, MAP_W, SHIPYARD_BUILD_DIST, SPAWNS, UNITS, UPGRADE_PATHS } from "../shared/gamedefs";
import type { BotDiff, BotProfile, BuildCategory, BuildingKind, EntKind, UnitKind } from "../shared/gamedefs";

const isB = (k: EntKind): k is BuildingKind => k in BUILDINGS;
const isSea = (k: EntKind) => !isB(k) && UNITS[k].domain === "sea";
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const UPGRADED_OF: Partial<Record<BuildingKind, BuildingKind>> = {
  barracks: "barracks2",
  factory: "factory2",
  airfield: "airfield2",
  shipyard: "shipyard2",
};

const DEF_RADIUS = 15; // enemy this close to our stuff = threat
const GUARD_RADIUS = 26; // only units this close to home get defensive orders
const HOME_RADIUS = 30; // "away" = further than this from base center

// Game phase — derived from tech progression, not wall-clock. early: no war
// factory yet (economy + scout). mid: factory online, expand + raid enemy eco.
// late: sustained assault on their base with bigger, more frequent waves.
type Phase = "early" | "mid" | "late";

export interface RtsBotOpts {
  aggressive?: boolean; // earlier waves, bigger queues, extra turret
  diff?: BotDiff; // easy | normal | brutal
  profile?: BotProfile; // balanced | rusher | turtle | tech
}

export class RtsBot {
  // introspection for tests/logging — read-only diagnostics
  denies = 0; // unexpected cmd* denials seen
  lastDeny = ""; // message of the most recent unexpected denial
  waves = 0; // assault waves launched
  errors: string[] = []; // swallowed exceptions (should stay empty)

  private diff: BotDiff;
  private profile: BotProfile;
  private nextCheap = 0;
  private nextSlow = 30;
  private slowStep: number;
  private nextPlaceTry = 0;
  private awaitingSince = -1; // tick we first saw current `awaiting`
  private nextDefPlaceTry = 0;
  private awaitingDefSince = -1; // tick we first saw current `awaitingDef`
  private deniedTiles = new Set<string>(); // "kind:tx,ty" that cmdPlace refused
  private oreCache: [number, number, number][] = [];
  private oreAt = -1e9;
  private lastAssault = -1e9;
  private firstWaveAt: number;
  private assaultEvery: number;
  private waveMin: number;
  private lastDefend = -1e9;
  private lastRepair = -1e9;
  private threatAt = -1e9;
  private lastScout = -1e9;
  private phase: Phase = "early";
  private rocketNext = false; // alternates what a fresh barracks queue starts with
  private infCap: number;
  private tankCap: number;
  private turretCap: number;
  private armyCap: number;

  constructor(
    private world: World,
    private slot: number,
    opts?: RtsBotOpts,
  ) {
    this.diff = opts?.diff ?? (opts?.aggressive ? "brutal" : "normal");
    this.profile = opts?.profile ?? "balanced";
    const jitter = ((Math.random() * 140) | 0) + slot * 53;
    if (this.diff === "easy") {
      this.firstWaveAt = 2400 + jitter;
      this.assaultEvery = 950;
      this.waveMin = 5;
      this.infCap = 2;
      this.tankCap = 1;
      this.turretCap = 1;
      this.armyCap = 14;
      this.slowStep = 95;
    } else if (this.diff === "brutal") {
      this.firstWaveAt = 850 + jitter;
      this.assaultEvery = 380;
      this.waveMin = 6;
      this.infCap = 6;
      this.tankCap = 5;
      this.turretCap = 3;
      this.armyCap = 48;
      this.slowStep = 36;
    } else {
      this.firstWaveAt = 1550 + jitter;
      this.assaultEvery = 680;
      this.waveMin = 6;
      this.infCap = 3;
      this.tankCap = 3;
      this.turretCap = 2;
      this.armyCap = 28;
      this.slowStep = 64;
    }
    // Personality profile modifiers (rusher = fast early raids, turtle = heavy defense & slow push, tech = boom to MKII/Ion)
    if (this.profile === "rusher") {
      const minFirst = this.diff === "easy" ? 900 : 450;
      this.firstWaveAt = Math.max(minFirst, Math.round(this.firstWaveAt * 0.55));
      this.assaultEvery = Math.max(220, Math.round(this.assaultEvery * 0.68));
      this.waveMin = Math.max(3, this.waveMin - 2);
      this.infCap += this.diff === "easy" ? 1 : 2;
      this.turretCap = Math.max(0, this.turretCap - 1);
    } else if (this.profile === "turtle") {
      this.firstWaveAt = Math.round(this.firstWaveAt * 1.65);
      this.assaultEvery = Math.round(this.assaultEvery * 1.4);
      this.waveMin += 4;
      this.turretCap += 3;
    } else if (this.profile === "tech") {
      this.firstWaveAt = Math.round(this.firstWaveAt * 1.35);
      this.assaultEvery = Math.round(this.assaultEvery * 1.15);
      this.waveMin += 2;
      this.tankCap += this.diff === "easy" ? 1 : 2;
    }
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

    // Finished structures (`awaiting`) and defenses (`awaitingDef`) place in parallel —
    // pace placement by difficulty so Easy/Normal feel human rather than instant.
    const placeStep = this.diff === "easy" ? 16 : this.diff === "brutal" ? 4 : 10;
    if (me.awaiting) {
      if (this.awaitingSince < 0) {
        this.awaitingSince = t;
        this.nextPlaceTry = t + placeStep;
      }
      if (t >= this.nextPlaceTry) {
        this.nextPlaceTry = t + placeStep;
        this.place(me.awaiting, t, "structure");
      }
    } else this.awaitingSince = -1;

    if (me.awaitingDef) {
      if (this.awaitingDefSince < 0) {
        this.awaitingDefSince = t;
        this.nextDefPlaceTry = t + placeStep;
      }
      if (t >= this.nextDefPlaceTry) {
        this.nextDefPlaceTry = t + placeStep;
        this.place(me.awaitingDef, t, "defense");
      }
    } else this.awaitingDefSince = -1;

    if (t >= this.nextCheap) {
      this.nextCheap = t + (this.diff === "easy" ? 20 : this.diff === "brutal" ? 8 : 14);
      this.defend(t);
    }
    if (t >= this.nextSlow) {
      this.nextSlow = t + this.slowStep + ((Math.random() * 14) | 0);
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

  // Upgraded buildings (barracks2/factory2/airfield2/shipyard2) satisfy their base prereq.
  private hasBuilding(bc: Map<BuildingKind, number>, k: BuildingKind): boolean {
    const upg = UPGRADED_OF[k];
    return (bc.get(k) ?? 0) > 0 || (upg !== undefined && (bc.get(upg) ?? 0) > 0);
  }

  // nearest enemy building to `ref` — the assault target
  private enemyBasePt(ref: { x: number; y: number }): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null,
      bd = Infinity;
    for (const e of this.world.ents.values()) {
      if (e.o < 0 || this.world.isAlly(this.slot, e.o) || !isB(e.k)) continue;
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
      if (e.o < 0 || this.world.isAlly(this.slot, e.o)) continue;
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

  // Where a building "wants" to be: refinery hugs the ore field, defenses sit
  // on the enemy-facing edge (Iron Dome closer to base core), everything else stays compact.
  private placeGoal(kind: BuildingKind, base: { x: number; y: number }): { x: number; y: number } {
    if (kind === "refinery") {
      const o = this.oreNear(base);
      if (o) return o;
    }
    if (kind === "turret" || kind === "arc" || kind === "sam" || kind === "lasertower" || kind === "irondome") {
      const foe = this.enemyBasePt(base);
      const dir = foe ?? { x: MAP_W / 2, y: MAP_H / 2 };
      const dx = dir.x - base.x,
        dy = dir.y - base.y,
        l = Math.hypot(dx, dy) || 1;
      const offset = kind === "irondome" ? 3 : 8;
      return { x: base.x + (dx / l) * offset, y: base.y + (dy / l) * offset };
    }
    return base;
  }

  // Scan candidate top-left tiles in the adjacency band (gap <= 2, or SHIPYARD_BUILD_DIST
  // for waterOnly buildings) around each owned building; validate with world.canPlace.
  private findSpot(kind: BuildingKind): { tx: number; ty: number } | null {
    const w = this.world,
      d = BUILDINGS[kind];
    const base = this.baseCenter();
    if (!base) return null;
    const goal = this.placeGoal(kind, base);
    const maxGap = d.waterOnly ? SHIPYARD_BUILD_DIST : 2;
    const seen = new Set<number>();
    let best: { tx: number; ty: number } | null = null,
      bs = Infinity;
    for (const b of w.ents.values()) {
      if (b.o !== this.slot || !isB(b.k)) continue;
      const bd = BUILDINGS[b.k];
      const bx = Math.round(b.x - bd.w / 2),
        by = Math.round(b.y - bd.h / 2);
      const y0 = Math.max(0, by - d.h - maxGap);
      const y1 = Math.min(MAP_H - d.h, by + bd.h + maxGap);
      const x0 = Math.max(0, bx - d.w - maxGap);
      const x1 = Math.min(MAP_W - d.w, bx + bd.w + maxGap);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const k = ty * MAP_W + tx;
          if (seen.has(k)) continue;
          seen.add(k);
          if (d.waterOnly && !w.isWater(tx, ty)) continue;
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

  private place(kind: BuildingKind, t: number, cat: BuildCategory) {
    const spot = this.findSpot(kind);
    const since = cat === "defense" ? this.awaitingDefSince : this.awaitingSince;
    if (!spot) {
      // boxed in — refund rather than stall the queue forever
      if (t - since > 400) this.world.cmdBuildCancel(this.slot, cat);
      return;
    }
    const err = this.world.cmdPlace(this.slot, spot.tx, spot.ty, cat);
    if (err) {
      this.denies++;
      this.lastDeny = err;
      this.deniedTiles.add(`${kind}:${spot.tx},${spot.ty}`);
    }
  }

  private pickPower(me: P, bc: Map<BuildingKind, number>): BuildingKind {
    if (this.diff !== "easy" && this.hasBuilding(bc, "techlab") && me.credits >= BUILDINGS.fusion.cost + 150) {
      return "fusion";
    }
    if (this.hasBuilding(bc, "refinery") && me.credits >= BUILDINGS.coalplant.cost + 80) {
      return "coalplant";
    }
    return "power";
  }

  // Next structure for the Structure queue (defenses construct in parallel via wantDefense!).
  private wantBuilding(me: P, bc: Map<BuildingKind, number>): BuildingKind | null {
    const has = (k: BuildingKind) => this.hasBuilding(bc, k);
    if (!has("conyard")) return null; // nothing to build with
    const pwrCount = (bc.get("power") ?? 0) + (bc.get("coalplant") ?? 0) + (bc.get("fusion") ?? 0);
    // early: the classic opener, nothing else competes for the structure queue
    if (pwrCount === 0) return "power";
    if (!has("refinery")) return "refinery";
    if (!has("barracks")) return "barracks";
    if (!has("factory")) return "factory";
    // brownout always wins — production halves at low power
    if (me.lowPower) return this.pickPower(me, bc);
    if (me.pwrHave - me.pwrUse < 25 && pwrCount < 8) return this.pickPower(me, bc);
    // tech climb: radar -> shipyard (water) / airfield -> techlab -> satlink -> superweapon
    if (!has("radar")) {
      if (me.pwrHave - me.pwrUse < 45 && pwrCount < 8) return this.pickPower(me, bc);
      return "radar";
    }
    // Naval maps: build Naval Shipyard once Radar + Factory are online (Normal/Brutal only)
    if (this.diff !== "easy" && this.world.hasWater() && !has("shipyard") && me.credits > 1050 && this.findSpot("shipyard")) {
      if (me.pwrHave - me.pwrUse < 35 && pwrCount < 8) return this.pickPower(me, bc);
      return "shipyard";
    }
    // Air Command: build once Radar + Factory are up (Normal/Brutal only)
    if (this.diff !== "easy" && !has("airfield") && me.credits > 1050) {
      if (me.pwrHave - me.pwrUse < 40 && pwrCount < 8) return this.pickPower(me, bc);
      return "airfield";
    }
    if (this.diff !== "easy" && !has("techlab") && me.credits > 1400) {
      if (me.pwrHave - me.pwrUse < 60 && pwrCount < 8) return this.pickPower(me, bc);
      return "techlab";
    }
    // mid: second refinery once the first economy is humming
    const refs = bc.get("refinery") ?? 0;
    if (this.phase !== "early" && me.credits > 2800 && refs < 2) return "refinery";
    if (this.diff !== "easy" && me.credits > 2200 && !has("depot") && has("factory")) return "depot";
    // late: Ore Purifier & Defense Satellite (unlocks HIMARS, Railgun MBT & Ion Uplink)
    if (this.diff !== "easy" && this.phase === "late" && has("techlab") && !has("purifier") && me.credits > 2200) return "purifier";
    if (
      this.diff !== "easy" &&
      has("techlab") &&
      !has("satlink") &&
      (this.phase === "late" || this.profile === "tech" || this.diff === "brutal")
    ) {
      if (me.pwrHave - me.pwrUse < 80 && pwrCount < 8) return this.pickPower(me, bc);
      if (me.credits >= BUILDINGS.satlink.cost + 200) return "satlink";
    }
    if (
      this.world.config.superweapons &&
      this.diff !== "easy" &&
      this.profile !== "rusher" &&
      has("satlink") &&
      !has("superweapon") &&
      (this.phase === "late" || this.diff === "brutal" || this.profile === "tech")
    ) {
      if (me.pwrHave - me.pwrUse < 100 && pwrCount < 8) return this.pickPower(me, bc);
      const swThresh = this.profile === "tech" || this.diff === "brutal" ? 2550 : 3200;
      if (me.credits >= swThresh) return "superweapon";
    }
    if (this.diff !== "easy" && this.phase === "late" && me.credits > 4000 && refs < 3) return "refinery";
    if (me.credits > 4000 && pwrCount < 4) return this.pickPower(me, bc);
    return null;
  }

  // Next defense for the parallel Defense queue (builds simultaneously with Structures!).
  private wantDefense(me: P, bc: Map<BuildingKind, number>): BuildingKind | null {
    const has = (k: BuildingKind) => this.hasBuilding(bc, k);
    if (!has("conyard")) return null;
    if (!has("factory") && !(this.profile === "turtle" && has("barracks"))) return null;
    if (me.lowPower || me.pwrHave - me.pwrUse < 45) return null;
    const turrets = bc.get("turret") ?? 0;
    const sams = bc.get("sam") ?? 0;
    const arcs = bc.get("arc") ?? 0;
    const domes = bc.get("irondome") ?? 0;
    const lasers = bc.get("lasertower") ?? 0;
    const totalDef = turrets + sams + arcs + domes + lasers;
    const defGoal =
      this.phase === "early"
        ? Math.min(1, this.turretCap)
        : this.phase === "mid"
          ? Math.min(3, this.turretCap + 1)
          : this.turretCap + (this.profile === "turtle" ? 3 : 1);
    if (totalDef >= defGoal) return null;
    if (this.diff === "easy") return "turret";
    const domeCap = this.profile === "turtle" ? 2 : 1;
    if (has("radar") && has("techlab") && domes < domeCap && me.credits >= BUILDINGS.irondome.cost + 200) {
      return "irondome";
    }
    const laserCap = this.profile === "turtle" ? 3 : 2;
    if (has("techlab") && lasers < laserCap && me.credits >= BUILDINGS.lasertower.cost + 200) {
      return "lasertower";
    }
    const samCap = this.profile === "turtle" ? 2 : 1;
    if (has("radar") && sams < samCap && me.credits >= BUILDINGS.sam.cost + 150) {
      return "sam";
    }
    if (has("radar") && me.credits >= BUILDINGS.arc.cost + 150) return "arc";
    return "turret";
  }

  // ---------- production ----------

  private produce(me: P, bc: Map<BuildingKind, number>, want: BuildingKind | null) {
    const w = this.world;
    // credits we're saving for the next building — early saves harder for the
    // opener, late spends freely since the base is done
    const reserve = want ? Math.min(BUILDINGS[want].cost, this.phase === "early" ? 650 : 450) : this.phase === "late" ? 200 : 150;
    const radar = this.hasBuilding(bc, "radar");
    const techlab = this.hasBuilding(bc, "techlab");
    const satlink = this.hasBuilding(bc, "satlink");
    const f2 = this.hasBuilding(bc, "factory2");
    const a2 = this.hasBuilding(bc, "airfield2");
    const s2 = this.hasBuilding(bc, "shipyard2");
    let harv = 0,
      army = 0,
      engi = 0,
      artys = 0,
      heavies = 0,
      spiders = 0,
      himars = 0,
      railtanks = 0,
      uavs = 0,
      interceptors = 0,
      choppers = 0,
      bombers = 0,
      stealthbombers = 0,
      hypersonics = 0,
      zeppelins = 0,
      gunboats = 0,
      destroyers = 0,
      subs = 0,
      dreadnoughts = 0,
      carriers = 0,
      neutralLandmarks = 0;
    for (const e of w.ents.values()) {
      if (e.o === -1 && (e.k === "derrick" || e.k === "coalmine")) {
        neutralLandmarks++;
        continue;
      }
      if (e.o !== this.slot) continue;
      if (e.k === "harvester") harv++;
      else if (!isB(e.k)) {
        army++;
        if (e.k === "engineer") engi++;
        else if (e.k === "arty") artys++;
        else if (e.k === "heavy") heavies++;
        else if (e.k === "spider") spiders++;
        else if (e.k === "himars") himars++;
        else if (e.k === "railtank") railtanks++;
        else if (e.k === "uav") uavs++;
        else if (e.k === "interceptor") interceptors++;
        else if (e.k === "chopper") choppers++;
        else if (e.k === "bomber") bombers++;
        else if (e.k === "stealthbomber") stealthbombers++;
        else if (e.k === "hypersonic") hypersonics++;
        else if (e.k === "zeppelin") zeppelins++;
        else if (e.k === "gunboat") gunboats++;
        else if (e.k === "destroyer") destroyers++;
        else if (e.k === "sub") subs++;
        else if (e.k === "dreadnought") dreadnoughts++;
        else if (e.k === "carrier") carriers++;
      }
    }

    // barracks: infantry scaled by phase, rocket troopers alternating in once
    // radar is up, and an engineer for neutral Oil Derricks / Coal Mines / late pushes (Normal/Brutal)
    const infGoal =
      this.phase === "early"
        ? Math.min(2, this.infCap)
        : this.phase === "mid" || this.diff === "easy"
          ? this.infCap
          : this.infCap + 2;
    if (this.hasBuilding(bc, "barracks") && army < this.armyCap) {
      const q = me.queues.barracks;
      const wantLandmarkEngi = this.diff !== "easy" && neutralLandmarks > 0 && me.credits >= UNITS.engineer.cost + 200;
      if (this.diff !== "easy" && !q && !engi && (wantLandmarkEngi || me.credits > 800)) {
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

    // Factory harvesters always take priority over combat units so economy never stalls
    if (this.hasBuilding(bc, "factory")) {
      const q = me.queues.factory;
      const harvGoal = this.diff === "easy" ? 2 : this.phase === "early" ? 2 : me.credits > 3000 ? 4 : 3;
      if (!q && harv < harvGoal && me.credits >= UNITS.harvester.cost + reserve) {
        this.trycmd(() => w.cmdTrain(this.slot, "harvester"));
      }
    }

    // Air Command: Reaper Drones, Valkyrie Jets, Hornet Gunships, Tempest Bombers, B-21 Phantoms, Mach-9 & Leviathan
    if (this.hasBuilding(bc, "airfield")) {
      const q = me.queues.airfield;
      const airCount = uavs + interceptors + choppers + bombers + stealthbombers + hypersonics + zeppelins;
      const airGoal = this.diff === "easy" ? 2 : this.diff === "brutal" ? 9 : 4;
      if (!q) {
        let unit: UnitKind | null = null;
        if (uavs < 1) unit = "uav";
        else if (a2 && stealthbombers < 2 && interceptors + choppers >= 1) unit = "stealthbomber";
        else if (a2 && hypersonics < 2 && interceptors >= 1) unit = "hypersonic";
        else if (techlab && zeppelins < 2 && interceptors + choppers >= 2) unit = "zeppelin";
        else if (techlab && bombers < 2 && interceptors >= 1) unit = "bomber";
        else if (interceptors <= choppers) unit = "interceptor";
        else unit = "chopper";
        if (unit && airCount < airGoal && army < this.armyCap + 8 && me.credits >= UNITS[unit].cost + reserve) {
          this.trycmd(() => w.cmdTrain(this.slot, unit));
        }
      } else {
        const u = q.unit;
        const cap =
          u === "zeppelin" || u === "bomber" || u === "stealthbomber" || u === "hypersonic" || u === "uav" ? 2 : 3;
        const fielded =
          u === "uav"
            ? uavs
            : u === "interceptor"
              ? interceptors
              : u === "chopper"
                ? choppers
                : u === "bomber"
                  ? bombers
                  : u === "stealthbomber"
                    ? stealthbombers
                    : u === "hypersonic"
                      ? hypersonics
                      : zeppelins;
        if (
          fielded + q.count < cap &&
          airCount + q.count < airGoal &&
          army < this.armyCap + 8 &&
          me.credits >= UNITS[u].cost + reserve
        ) {
          this.trycmd(() => w.cmdTrain(this.slot, u));
        }
      }
    }

    // Naval Shipyard: Viper Hydrofoils, Aegis Destroyers, Kraken Subs, Poseidon Dreadnoughts & Nimitz Carriers
    if (this.hasBuilding(bc, "shipyard")) {
      const q = me.queues.shipyard;
      const seaCount = gunboats + destroyers + subs + dreadnoughts + carriers;
      const seaGoal = this.diff === "easy" ? 2 : this.diff === "brutal" ? 9 : 4;
      if (!q) {
        let unit: UnitKind | null = null;
        if (s2 && carriers < 2 && gunboats + destroyers >= 2) unit = "carrier";
        else if (s2 && dreadnoughts < 2 && gunboats + destroyers >= 2) unit = "dreadnought";
        else if (radar && subs < 2 && gunboats >= 1) unit = "sub";
        else if (destroyers < 3 && gunboats >= 1) unit = "destroyer";
        else unit = "gunboat";
        if (unit && seaCount < seaGoal && army < this.armyCap + 8 && me.credits >= UNITS[unit].cost + reserve) {
          this.trycmd(() => w.cmdTrain(this.slot, unit));
        }
      } else {
        const u = q.unit;
        const cap = u === "dreadnought" || u === "carrier" || u === "sub" ? 2 : 3;
        const fielded =
          u === "gunboat"
            ? gunboats
            : u === "destroyer"
              ? destroyers
              : u === "sub"
                ? subs
                : u === "carrier"
                  ? carriers
                  : dreadnoughts;
        if (
          fielded + q.count < cap &&
          seaCount + q.count < seaGoal &&
          army < this.armyCap + 8 &&
          me.credits >= UNITS[u].cost + reserve
        ) {
          this.trycmd(() => w.cmdTrain(this.slot, u));
        }
      }
    }

    if (this.hasBuilding(bc, "factory")) {
      const q = me.queues.factory;
      const tankGoal =
        this.phase === "late" ? this.tankCap + (this.diff === "easy" ? 1 : this.diff === "normal" ? 2 : 3) : this.tankCap;
      if (!q) {
        // fresh queue: arty/HIMARS siege support, Railgun MBTs, MKII heavies/spiders, else Battle Tanks
        let unit: UnitKind | null = null;
        const artyCap = this.diff === "easy" ? 1 : 2;
        if (this.phase !== "early") {
          if (satlink && railtanks < 4 && railtanks <= himars + 1) unit = "railtank";
          else if (satlink && himars < 2) unit = "himars";
          else if (radar && artys < artyCap && !satlink) unit = "arty";
          else if (f2 && heavies < 4 && heavies <= spiders) unit = "heavy";
          else if (f2 && spiders < 4) unit = "spider";
          else if (f2 && heavies < 4) unit = "heavy";
          else unit = "tank";
        }
        // high-tier units bypass the base army cap slightly so tech booms stay impactful
        const eliteUnit = (f2 && (unit === "heavy" || unit === "spider")) || (satlink && (unit === "railtank" || unit === "himars"));
        if (unit && (army < this.armyCap || eliteUnit) && me.credits >= UNITS[unit].cost + reserve) {
          this.trycmd(() => w.cmdTrain(this.slot, unit));
        }
      } else {
        // one shared queue — stack more of what's already in it (queued units
        // count toward the caps) instead of fighting a different queue unit
        const u = q.unit;
        const artyCap = this.diff === "easy" ? 1 : 2;
        const cap =
          u === "tank"
            ? tankGoal
            : u === "arty"
              ? artyCap
              : u === "himars"
                ? 2
                : u === "heavy" || u === "spider" || u === "railtank"
                  ? 4
                  : 0;
        const fielded =
          u === "arty"
            ? artys
            : u === "heavy"
              ? heavies
              : u === "spider"
                ? spiders
                : u === "himars"
                  ? himars
                  : u === "railtank"
                    ? railtanks
                    : 0;
        const eliteU = (f2 && (u === "heavy" || u === "spider")) || (satlink && (u === "railtank" || u === "himars"));
        if (cap > 0 && fielded + q.count < cap && (army < this.armyCap || eliteU) && me.credits >= UNITS[u].cost + reserve) {
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
  // hp). Throttled on Easy/Normal so repairs feel human-paced.
  // Feature-detected: if the World build lacks cmdRepair, skip quietly.
  private repairs(me: P, reserve: number, t: number) {
    const repairCooldown = this.diff === "easy" ? 220 : this.diff === "brutal" ? 50 : 120;
    if (t - this.lastRepair < repairCooldown) return;
    const w = this.world;
    let worst: Ent | null = null,
      worstK: BuildingKind = "conyard",
      worstPct = this.diff === "easy" ? 0.45 : this.diff === "brutal" ? 0.65 : 0.55; // ignore cosmetic damage
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
    let basis = BUILDINGS[worstK].cost;
    for (const path of Object.values(UPGRADE_PATHS)) {
      if (path.to === worstK) {
        basis = BUILDINGS[path.from].cost + path.cost;
        break;
      }
    }
    const cost = Math.ceil(basis * 0.25);
    if (me.credits >= cost + (worstK === "conyard" ? 0 : reserve)) {
      this.trycmd(() => repair.call(w, this.slot, (worst as Ent).id));
      this.lastRepair = t;
    }
  }

  // Upgrade production buildings along all 4 UPGRADE_PATHS (factory, barracks, airfield, shipyard).
  private upgrade(me: P, bc: Map<BuildingKind, number>) {
    if (this.diff === "easy") return;
    if (this.phase === "early") return;
    const order: BuildingKind[] = ["factory", "barracks", "airfield", "shipyard"];
    for (const from of order) {
      const path = UPGRADE_PATHS[from];
      if (!path) continue;
      if ((bc.get(from) ?? 0) === 0 || (bc.get(path.to) ?? 0) > 0) continue;
      if (!this.hasBuilding(bc, path.requires)) continue;
      if (this.phase !== "late" && from !== "barracks" && this.profile !== "tech") continue;
      if (me.credits <= path.cost + 750) continue;
      for (const e of this.world.ents.values()) {
        if (e.o === this.slot && e.k === from) {
          this.trycmd(() => this.world.cmdUpgrade(this.slot, e.id));
          return;
        }
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
  // map intel, and occasionally draws out their defense early (Normal/Brutal only).
  private scout(t: number) {
    if (this.diff === "easy" || this.phase !== "early" || t - this.lastScout < 600) return;
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
      if (e.o < 0 || this.world.isAlly(this.slot, e.o)) continue;
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

  // Normal & brutal bots send idle Sappers (engineers) to capture nearby neutral Oil Derricks & Coal Mines.
  private captureDerricks() {
    if (this.diff === "easy") return;
    const w = this.world;
    const base = this.baseCenter();
    if (!base) return;
    const maxDist = this.diff === "brutal" ? 999 : 42;
    const targets: Ent[] = [];
    for (const e of w.ents.values()) {
      if (e.k !== "derrick" && e.k !== "coalmine") continue;
      if (e.o === -1 || (this.diff === "brutal" && !w.isAlly(this.slot, e.o))) {
        if (dist(base.x, base.y, e.x, e.y) <= maxDist) targets.push(e);
      }
    }
    if (!targets.length) return;
    // Prefer neutral landmarks first, then closest to base
    targets.sort((a, b) => {
      if ((a.o === -1) !== (b.o === -1)) return a.o === -1 ? -1 : 1;
      return dist(base.x, base.y, a.x, a.y) - dist(base.x, base.y, b.x, b.y);
    });
    for (const e of w.ents.values()) {
      if (e.o !== this.slot || e.k !== "engineer" || e.order) continue;
      const d = targets[0];
      this.trycmd(() => w.cmdOrder(this.slot, [e.id], "attack", d.x, d.y, d.id));
      return;
    }
  }

  // Brutal (and close-range Normal) bots grab nearby supply crates with idle combat units.
  private grabCrates() {
    if (this.diff === "easy" || !this.world.crates.size) return;
    const w = this.world;
    const maxRange = this.diff === "brutal" ? 28 : 12;
    const assigned = new Set<number>();
    for (const crate of w.crates.values()) {
      let best: Ent | null = null,
        bd = maxRange;
      for (const u of w.ents.values()) {
        if (u.o !== this.slot || isB(u.k) || u.k === "harvester" || u.k === "engineer" || isSea(u.k)) continue;
        if (u.order || assigned.has(u.id)) continue;
        const d = dist(u.x, u.y, crate.x, crate.y);
        if (d < bd) {
          bd = d;
          best = u;
        }
      }
      if (best) {
        assigned.add(best.id);
        this.trycmd(() => w.cmdOrder(this.slot, [best.id], "move", crate.x, crate.y));
      }
    }
  }

  // Fire charged Orbital Ion Cannon at the highest-value enemy structure.
  private fireSuperweapon(me: P, bc: Map<BuildingKind, number>) {
    if (this.diff === "easy") return;
    if (me.lowPower || me.swLeft !== 0 || !this.hasBuilding(bc, "superweapon")) return;
    const w = this.world;
    const priority: Partial<Record<EntKind, number>> = {
      conyard: 100,
      superweapon: 95,
      satlink: 92,
      factory2: 90,
      airfield2: 88,
      shipyard2: 88,
      factory: 85,
      techlab: 82,
      fusion: 78,
      irondome: 76,
      lasertower: 75,
      airfield: 74,
      shipyard: 74,
      refinery: 70,
      barracks2: 65,
      barracks: 60,
      radar: 55,
      coalplant: 48,
      power: 45,
    };
    let best: Ent | null = null,
      bestScore = -1;
    for (const e of w.ents.values()) {
      if (e.o < 0 || w.isAlly(this.slot, e.o)) continue;
      if (w.players.get(e.o)?.eliminated) continue;
      const score = (priority[e.k] ?? (isB(e.k) ? 40 : 10)) + e.hp * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (best) {
      this.trycmd(() => w.cmdSuperweapon(this.slot, best!.x, best!.y));
    }
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
      if (e.o !== this.slot || isB(e.k) || e.k === "harvester" || isSea(e.k) || e.order) continue;
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
    // nearest visible enemy ent to any of our buildings or harvesters
    let threat: Ent | null = null,
      bd = DEF_RADIUS * DEF_RADIUS;
    for (const e of w.ents.values()) {
      if (e.o < 0 || w.isAlly(this.slot, e.o)) continue;
      const p = w.players.get(e.o);
      if (p && p.eliminated) continue;
      if (w.isStealthed(e) && !w.isStealthDetected(e, this.slot)) continue;
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
    const defendCooldown = this.diff === "easy" ? 40 : this.diff === "brutal" ? 15 : 25;
    if (t - this.lastDefend < defendCooldown) return; // human-paced defensive reaction
    this.lastDefend = t;
    const ids: number[] = [];
    for (const e of w.ents.values()) {
      if (e.o !== this.slot || isB(e.k) || e.k === "harvester" || e.k === "engineer") continue;
      if (!w.canAttack(e, threat)) continue;
      if (dist(e.x, e.y, base.x, base.y) > GUARD_RADIUS) continue;
      ids.push(e.id);
    }
    if (ids.length) this.trycmd(() => w.cmdOrder(this.slot, ids, "amove", threat.x, threat.y));
  }

  // Preferred target for naval units: enemy shipyard / ships first, else nearest enemy building.
  private navalTarget(ref: { x: number; y: number }): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null,
      bd = Infinity;
    for (const e of this.world.ents.values()) {
      if (e.o < 0 || this.world.isAlly(this.slot, e.o)) continue;
      if (this.world.players.get(e.o)?.eliminated) continue;
      if (this.world.isStealthed(e) && !this.world.isStealthDetected(e, this.slot)) continue;
      if (e.k !== "shipyard" && e.k !== "shipyard2" && !isSea(e.k)) continue;
      const d = dist(ref.x, ref.y, e.x, e.y);
      if (d < bd) {
        bd = d;
        best = { x: e.x, y: e.y };
      }
    }
    return best ?? this.enemyBasePt(ref) ?? this.nearestEnemyEnt(ref);
  }

  // slow loop: launch waves at the nearest enemy base; keep far-away troops
  // grinding on whatever enemy structure is nearest to them.
  private assault(t: number) {
    const w = this.world;
    const base = this.baseCenter();
    if (!base) return;
    const army: Ent[] = [],
      awayLandAir: Ent[] = [],
      awaySea: Ent[] = [];
    for (const e of w.ents.values()) {
      if (e.o !== this.slot || isB(e.k) || e.k === "harvester") continue;
      army.push(e);
      if (!e.order && dist(e.x, e.y, base.x, base.y) > HOME_RADIUS) {
        if (isSea(e.k)) awaySea.push(e);
        else awayLandAir.push(e);
      }
    }
    if (!army.length) return;

    const tgt = this.enemyBasePt(base) ?? this.nearestEnemyEnt(base);

    // stranded attackers: re-engage the nearest enemy structure/unit to THEM,
    // or come home if the field is clear
    if (awayLandAir.length) {
      let ax = 0,
        ay = 0;
      for (const u of awayLandAir) {
        ax += u.x;
        ay += u.y;
      }
      const c = { x: ax / awayLandAir.length, y: ay / awayLandAir.length };
      const local = this.enemyBasePt(c) ?? this.nearestEnemyEnt(c);
      const ids = awayLandAir.map((u) => u.id);
      if (local) this.trycmd(() => w.cmdOrder(this.slot, ids, "amove", local.x, local.y));
      else this.trycmd(() => w.cmdOrder(this.slot, ids, "move", base.x, base.y));
    }
    if (awaySea.length) {
      let ax = 0,
        ay = 0;
      for (const u of awaySea) {
        ax += u.x;
        ay += u.y;
      }
      const c = { x: ax / awaySea.length, y: ay / awaySea.length };
      const local = this.navalTarget(c);
      const ids = awaySea.map((u) => u.id);
      if (local) this.trycmd(() => w.cmdOrder(this.slot, ids, "amove", local.x, local.y));
    }

    // phase-aware assault: early holds (economy first), mid raids their
    // economy (brutal or non-easy rusher only), late pushes the base
    if (this.phase === "early") return;
    const waveMin = Math.min(this.armyCap - 2, this.phase === "late" ? this.waveMin + 3 : this.waveMin);
    const lateMult = this.diff === "easy" ? 0.85 : this.diff === "normal" ? 0.72 : 0.6;
    const interval = this.phase === "late" ? Math.round(this.assaultEvery * lateMult) : this.assaultEvery;
    const canEcoRaid = this.diff === "brutal" || (this.profile === "rusher" && this.diff !== "easy");
    const raid = this.phase === "mid" && canEcoRaid ? this.ecoRaidTarget(base) : null;
    const goal = raid ?? tgt;
    if (!goal) return;
    const recentThreat = t - this.threatAt < 50;
    const due = this.lastAssault < 0 ? t >= this.firstWaveAt : t - this.lastAssault >= interval;
    // After the first wave has launched, an oversized force on Normal/Brutal can attack ahead of schedule
    const big =
      this.diff !== "easy" &&
      this.lastAssault >= 0 &&
      army.length >= waveMin * 2 &&
      t - this.lastAssault >= Math.max(180, Math.round(interval * 0.5));
    // late game presses the advantage even without a full wave if it's big enough (Normal/Brutal, after first wave)
    const press =
      this.diff !== "easy" &&
      this.lastAssault >= 0 &&
      this.phase === "late" &&
      army.length >= waveMin + 5 &&
      t - this.lastAssault >= interval / 2;
    if (army.length >= waveMin && (due || big || press) && !recentThreat) {
      // the lone engineer rides along only on big late pushes if idle —
      // don't pull one that is already en route to a neutral Oil Derrick
      const takeEngi = this.phase !== "late" || army.length >= waveMin * 1.5;
      const landAirIds: number[] = [];
      const seaIds: number[] = [];
      for (const e of army) {
        if (e.k === "engineer" && !(takeEngi && !e.order)) continue;
        if (isSea(e.k)) seaIds.push(e.id);
        else landAirIds.push(e.id);
      }
      if (!landAirIds.length && !seaIds.length) return;
      let sent = false;
      if (landAirIds.length) {
        const err = w.cmdOrder(this.slot, landAirIds, "amove", goal.x, goal.y);
        if (err) {
          this.denies++;
          this.lastDeny = err;
        } else sent = true;
      }
      if (seaIds.length) {
        const seaGoal = this.navalTarget(base) ?? goal;
        const err = w.cmdOrder(this.slot, seaIds, "amove", seaGoal.x, seaGoal.y);
        if (err) {
          this.denies++;
          this.lastDeny = err;
        } else sent = true;
      }
      if (!sent) return;
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
    const wantDef = this.wantDefense(me, bc);
    const structReserve = want && !me.bq && !me.awaiting ? Math.min(BUILDINGS[want].cost, 600) : 0;
    if (wantDef && !me.dq && !me.awaitingDef && me.credits >= BUILDINGS[wantDef].cost + structReserve) {
      this.trycmd(() => w.cmdBuild(this.slot, wantDef));
    }
    this.produce(me, bc, want);
    this.repairs(me, want ? Math.min(BUILDINGS[want].cost, 500) : 150, t);
    this.upgrade(me, bc);
    this.wakeHarvesters();
    if (w.config.superweapons) this.fireSuperweapon(me, bc);
    if (w.config.derricks) this.captureDerricks();
    if (w.config.crates) this.grabCrates();
    this.scout(t);
    this.rally();
    this.assault(t);
  }
}

// Compatibility shim for worker.ts, which manages bots as
//   const bots = new Map<string, AIBot>(); // player id -> brain
//   new AIBot(id, diff);                    // lobby add-bot
//   bot.tick(world, slot);                  // once per sim tick
// The world isn't known until the game starts, so the RtsBot is created lazily
// on first tick (and re-created if the world instance changes, e.g. rematch).
export class AIBot {
  private impl: RtsBot | null = null;
  private w: World | null = null;
  private s = -1;
  private opts: RtsBotOpts;

  constructor(
    public readonly id: string,
    opts?: BotDiff | RtsBotOpts,
  ) {
    if (typeof opts === "string") this.opts = { diff: opts };
    else this.opts = opts ?? { diff: "normal" };
  }

  tick(world: World, slot: number) {
    if (!this.impl || this.w !== world || this.s !== slot) {
      this.impl = new RtsBot(world, slot, this.opts);
      this.w = world;
      this.s = slot;
    }
    this.impl.think();
  }
}
