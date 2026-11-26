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
import { BUILDINGS, getSpawns, isInfantryKind, SHIPYARD_BUILD_DIST, transportCapOf, UNITS, UPGRADE_PATHS, UPGRADED_OF } from "../shared/gamedefs";
import type { BotDiff, BotProfile, BuildCategory, BuildingKind, EntKind, UnitKind } from "../shared/gamedefs";

const isB = (k: EntKind): k is BuildingKind => k in BUILDINGS;
const isSea = (k: EntKind) => !isB(k) && UNITS[k].domain === "sea";
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const DEF_RADIUS = 15; // enemy this close to our stuff = threat
const GUARD_RADIUS = 26; // only units this close to home get defensive orders
const HOME_RADIUS = 30; // "away" = further than this from base center

// Game phase — derived from tech progression, not wall-clock. early: no war
// factory yet (economy + scout). mid: factory online, expand + raid enemy eco.
// late: sustained assault on their base with bigger, more frequent waves.
type Phase = "early" | "mid" | "late";

// One helicopter troop-transport mission. Ground forces can't cross water, so
// when the bot's expansion or assault target sits in a different land-connectivity
// region (world.landRegion — the same flood fill that gates A*), up to 4
// infantry-class troops ride a chopper instead of walking into the sea.
//
// Safety contract (what keeps this non-stupid):
//  - at most ONE mission at a time, and only while no recent base threat
//  - mission units are excluded from rally/assault/defend/crate/scout sweeps so
//    nothing retasks them mid-flight (the wave launch skips them, they still
//    count as army strength — they ARE attacking, just by air)
//  - every state has a timeout and a self-cleaning abort: troops with dangling
//    board orders are stopped, a chopper still carrying passengers is ordered to
//    unload back home — nothing is ever pinned inside the mission forever
interface Airlift {
  kind: "expand" | "raid";
  chopper: number; // transport ent id
  troops: number[]; // assigned infantry-class ent ids (shrinks to actual passengers at liftoff)
  goal: { x: number; y: number }; // drop zone (near the landmark / enemy base)
  targetId?: number; // expand: landmark the engineer should capture after landing
  state: "load" | "fly";
  since: number; // tick the current state was entered
  born: number; // tick the mission started (global failsafe)
}

const AIRLIFT_LOAD_TIMEOUT = 380; // troops walk to the chopper — generous for base-radius distances
const AIRLIFT_FLY_TIMEOUT = 2100; // big-map cross-flight at cruise speed with margin
const AIRLIFT_MISSION_TIMEOUT = 2600; // absolute failsafe regardless of state
const AIRLIFT_RESTART_GAP = 300; // minimum ticks between missions — no churn
const AIRLIFT_HOME_RADIUS = 45; // chopper/troops must start this close to base
const AIRLIFT_DROP_RADIUS = 14; // post-drop "did they land near the goal" check

// One categorized view of the entity map per think(). All category arrays retain
// the world Map's insertion order within that category, matching the filtered
// full-map scans they replace. Entity objects are live references: order/hp/kind
// mutations made by the bot remain visible, while entities created mid-think are
// a documented snapshot boundary.
interface BotScan {
  mine: Ent[];
  myBuildings: Ent[];
  myUnits: Ent[];
  enemyAll: Ent[];
  enemyBuildings: Ent[];
  landmarks: Ent[]; // derricks/coalmines of any owner
  assetCells: Map<number, Ent[]>; // own buildings/harvesters in 8-tile buckets for exact threat nearest-distance queries
  myBuildingCounts: Map<BuildingKind, number>;
  myUnitCounts: Map<EntKind, number>;
  myArmyCount: number; // owned non-buildings except harvesters/supply trucks
  neutralLandmarks: number;
}

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
  airlifts = 0; // completed troop-transport missions (troops actually dropped)
  airliftBlock = ""; // why the last airlift evaluation bailed (empty = mission active or fired)
  airliftLog: string[] = []; // ring of recent mission outcomes for post-game analysis
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
  // numeric tile keys (ty*4096+tx) per kind — the probes run hundreds of times
  // per findSpot scan, and template-string keys were pure allocation churn
  private deniedTiles = new Map<BuildingKind, Set<number>>(); // tiles cmdPlace refused
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
  private barracksCycle = 0; // rotates infantry / FPV suicide drones / AT-MANPADS rockets
  private infCap: number;
  private tankCap: number;
  private turretCap: number;
  private armyCap: number;
  private scanCache: BotScan | null = null;
  private airlift: Airlift | null = null; // active transport mission (at most one)
  private missionIds = new Set<number>(); // chopper + troop ids of the active mission — sweep exclusion list
  private lastAirliftEnd = -1e9; // tick the last mission ended (restart throttle)

  // Lazily built at most once per think: cheap idle ticks stay O(1), while
  // placement/defense/slow ticks share one fused pass instead of 8-12 scans.
  private get scan(): BotScan {
    return (this.scanCache ??= this.scanWorld());
  }

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
      this.slowStep = 130;
    } else if (this.diff === "brutal") {
      this.firstWaveAt = 850 + jitter;
      this.assaultEvery = 380;
      this.waveMin = 6;
      this.infCap = 6;
      this.tankCap = 5;
      this.turretCap = 3;
      this.armyCap = 48;
      this.slowStep = 55;
    } else {
      this.firstWaveAt = 1550 + jitter;
      this.assaultEvery = 680;
      this.waveMin = 6;
      this.infCap = 3;
      this.tankCap = 3;
      this.turretCap = 2;
      this.armyCap = 28;
      this.slowStep = 90;
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
    this.scanCache = null;

    // Finished structures (`awaiting`) and defenses (`awaitingDef`) place in parallel —
    // paced to human APM: ~2-4s between placements with jitter, not metronomic ticks.
    const placeStep = this.diff === "easy" ? 34 : this.diff === "brutal" ? 12 : 24;
    const placeJit = ((Math.random() * placeStep) | 0) >> 1;
    if (me.awaiting.length) {
      if (this.awaitingSince < 0) {
        this.awaitingSince = t;
        this.nextPlaceTry = t + placeStep;
      }
      if (t >= this.nextPlaceTry) {
        this.nextPlaceTry = t + placeStep + placeJit;
        this.place(me.awaiting[0], t, "structure");
      }
    } else this.awaitingSince = -1;

    if (me.awaitingDef.length) {
      if (this.awaitingDefSince < 0) {
        this.awaitingDefSince = t;
        this.nextDefPlaceTry = t + placeStep;
      }
      if (t >= this.nextDefPlaceTry) {
        this.nextDefPlaceTry = t + placeStep + placeJit;
        this.place(me.awaitingDef[0], t, "defense");
      }
    } else this.awaitingDefSince = -1;

    if (t >= this.nextCheap) {
      this.nextCheap = t + (this.diff === "easy" ? 45 : this.diff === "brutal" ? 16 : 28) + ((Math.random() * 12) | 0);
      this.defend(t);
    }
    if (t >= this.nextSlow) {
      this.nextSlow = t + this.slowStep + ((Math.random() * 14) | 0);
      this.slow(me, t);
    }
  }

  private scanWorld(): BotScan {
    const scan: BotScan = {
      mine: [],
      myBuildings: [],
      myUnits: [],
      enemyAll: [],
      enemyBuildings: [],
      landmarks: [],
      assetCells: new Map(),
      myBuildingCounts: new Map(),
      myUnitCounts: new Map(),
      myArmyCount: 0,
      neutralLandmarks: 0,
    };
    for (const e of this.world.ents.values()) this.scanEnt(scan, e);
    return scan;
  }

  private scanEnt(scan: BotScan, e: Ent) {
    const bld = isB(e.k);
    if (e.k === "derrick" || e.k === "coalmine") {
      scan.landmarks.push(e);
      if (e.o === -1) scan.neutralLandmarks++;
    }
    if (e.o === this.slot) {
      scan.mine.push(e);
      if (bld || e.k === "harvester") {
        const cx = Math.floor(e.x) >> 3,
          cy = Math.floor(e.y) >> 3;
        const key = cy * 1024 + cx;
        let cell = scan.assetCells.get(key);
        if (!cell) scan.assetCells.set(key, (cell = []));
        cell.push(e);
      }
      if (bld) {
        scan.myBuildings.push(e);
        scan.myBuildingCounts.set(e.k as BuildingKind, (scan.myBuildingCounts.get(e.k as BuildingKind) ?? 0) + 1);
      } else {
        scan.myUnits.push(e);
        scan.myUnitCounts.set(e.k, (scan.myUnitCounts.get(e.k) ?? 0) + 1);
        if (e.k !== "harvester" && e.k !== "supplytruck") scan.myArmyCount++;
      }
    } else if (e.o >= 0 && !this.world.isAlly(this.slot, e.o)) {
      scan.enemyAll.push(e);
      if (bld) scan.enemyBuildings.push(e);
    }
  }

  // ---------- shared scans ----------

  private baseCenter(): { x: number; y: number } | null {
    let sx = 0,
      sy = 0,
      n = 0;
    for (const e of this.scan.myBuildings) {
      sx += e.x;
      sy += e.y;
      n++;
    }
    if (!n) {
      // no buildings left: the army is the base
      for (const e of this.scan.myUnits) {
        sx += e.x;
        sy += e.y;
        n++;
      }
    }
    if (!n) {
      const s = getSpawns(this.world.w, this.world.h)[this.slot];
      return s ? { x: s.x + 1.5, y: s.y + 1.5 } : null;
    }
    return { x: sx / n, y: sy / n };
  }

  private buildingCounts(): Map<BuildingKind, number> {
    return this.scan.myBuildingCounts;
  }

  // Upgraded buildings (barracks2/factory2/airfield2/shipyard2) satisfy their base prereq.
  private hasBuilding(bc: Map<BuildingKind, number>, k: BuildingKind): boolean {
    const upg = UPGRADED_OF[k];
    return (bc.get(k) ?? 0) > 0 || (upg !== undefined && (bc.get(upg) ?? 0) > 0);
  }

  // Forward Supply Hubs take over construction when the ConYard is destroyed.
  private hasConstruction(bc: Map<BuildingKind, number>): boolean {
    return this.hasBuilding(bc, "conyard") || this.hasBuilding(bc, "supplyhub");
  }

  // nearest enemy building to `ref` — the assault target
  private enemyBasePt(ref: { x: number; y: number }): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null,
      bd = Infinity;
    for (const e of this.scan.enemyBuildings) {
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
    for (const e of this.scan.enemyAll) {
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

  // Where a building "wants" to be: refinery hugs the ore field, forward supply hub
  // projects toward center/enemy, defenses sit on the enemy-facing edge (Iron Dome closer to base core).
  private placeGoal(kind: BuildingKind, base: { x: number; y: number }): { x: number; y: number } {
    const w = this.world;
    if (kind === "refinery") {
      const o = this.oreNear(base);
      if (o) return o;
    }
    if (kind === "supplyhub") {
      const foe = this.enemyBasePt(base);
      const dir = foe ?? { x: w.w / 2, y: w.h / 2 };
      const dx = dir.x - base.x,
        dy = dir.y - base.y,
        l = Math.hypot(dx, dy) || 1;
      const offset = Math.min(20, l * 0.45);
      return {
        x: clamp(base.x + (dx / l) * offset, 3, w.w - 4),
        y: clamp(base.y + (dy / l) * offset, 3, w.h - 4),
      };
    }
    if (
      kind === "turret" ||
      kind === "arc" ||
      kind === "sam" ||
      kind === "lasertower" ||
      kind === "irondome" ||
      kind === "thaad"
    ) {
      const foe = this.enemyBasePt(base);
      const dir = foe ?? { x: w.w / 2, y: w.h / 2 };
      const dx = dir.x - base.x,
        dy = dir.y - base.y,
        l = Math.hypot(dx, dy) || 1;
      const offset = kind === "irondome" || kind === "thaad" ? 3 : 8;
      return { x: base.x + (dx / l) * offset, y: base.y + (dy / l) * offset };
    }
    return base;
  }

  private deniedHas(kind: BuildingKind, tx: number, ty: number): boolean {
    return this.deniedTiles.get(kind)?.has(ty * 4096 + tx) ?? false;
  }

  private deniedAdd(kind: BuildingKind, tx: number, ty: number) {
    let s = this.deniedTiles.get(kind);
    if (!s) this.deniedTiles.set(kind, (s = new Set()));
    s.add(ty * 4096 + tx);
  }

  // Scan candidate top-left tiles in the adjacency band (gap <= 2, SHIPYARD_BUILD_DIST
  // for waterOnly, or expanding ring around goal for forwardRange); validate with world.canPlace.
  private findSpot(kind: BuildingKind): { tx: number; ty: number } | null {
    const w = this.world,
      d = BUILDINGS[kind];
    const base = this.baseCenter();
    if (!base) return null;
    const goal = this.placeGoal(kind, base);
    if (d.forwardRange) {
      const gx = Math.round(goal.x - d.w / 2);
      const gy = Math.round(goal.y - d.h / 2);
      for (let r = 0; r <= 18; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const tx = gx + dx,
              ty = gy + dy;
            if (tx < 0 || ty < 0 || tx + d.w > w.w || ty + d.h > w.h) continue;
            if (this.deniedHas(kind, tx, ty)) continue;
            if (w.canPlace(this.slot, kind, tx, ty) === null) return { tx, ty };
          }
        }
      }
      return null;
    }
    const maxGap = d.waterOnly ? SHIPYARD_BUILD_DIST : 2;
    const seen = new Set<number>();
    let best: { tx: number; ty: number } | null = null,
      bs = Infinity;
    for (const b of this.scan.myBuildings) {
      const bd = BUILDINGS[b.k as BuildingKind];
      const bx = Math.round(b.x - bd.w / 2),
        by = Math.round(b.y - bd.h / 2);
      const y0 = Math.max(0, by - d.h - maxGap);
      const y1 = Math.min(w.h - d.h, by + bd.h + maxGap);
      const x0 = Math.max(0, bx - d.w - maxGap);
      const x1 = Math.min(w.w - d.w, bx + bd.w + maxGap);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const k = ty * w.w + tx;
          if (seen.has(k)) continue;
          seen.add(k);
          if (d.waterOnly && !w.isWater(tx, ty)) continue;
          if (this.deniedHas(kind, tx, ty)) continue;
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
      // boxed in — refund the stuck READY item (awaiting pile), not the building head
      if (t - since > 400) this.world.cmdBuildCancel(this.slot, cat, 0, true);
      return;
    }
    const scan = this.scan;
    const created: Ent[] = [];
    const err = this.world.cmdPlace(this.slot, spot.tx, spot.ty, cat, undefined, created);
    if (err) {
      this.denies++;
      this.lastDeny = err;
      this.deniedAdd(kind, spot.tx, spot.ty);
    } else {
      // Placement is the only bot command that creates entities mid-think; fold
      // them into the existing snapshot instead of rescanning the world.
      for (const e of created) this.scanEnt(scan, e);
    }
  }

  private pickPower(_me: P, _bc: Map<BuildingKind, number>): BuildingKind {
    // Power Plants are built as Tier-1 `power` and upgraded in-place to `coalplant` -> `fusion`!
    return "power";
  }

  // Next structure for the Structure queue (defenses construct in parallel via wantDefense!).
  private wantBuilding(me: P, bc: Map<BuildingKind, number>): BuildingKind | null {
    const has = (k: BuildingKind) => this.hasBuilding(bc, k);
    if (!this.hasConstruction(bc)) return null; // nothing to build with
    const pwrCount = (bc.get("power") ?? 0) + (bc.get("coalplant") ?? 0) + (bc.get("fusion") ?? 0);
    // early: the classic opener, nothing else competes for the structure queue
    if (pwrCount === 0) return "power";
    if (!has("refinery")) return "refinery";
    if (!has("barracks")) return "barracks";
    if (!has("factory")) return "factory";
    // brownout always wins — production halves at low power
    if (me.lowPower) return this.pickPower(me, bc);
    if (me.pwrHave - me.pwrUse < 25 && pwrCount < 8) return this.pickPower(me, bc);
    // Huge maps: establish a Forward Supply Hub toward center to sustain long supply lines
    if (
      this.world.w >= 96 &&
      this.world.config.logistics !== false &&
      !has("supplyhub") &&
      has("refinery") &&
      me.credits >= BUILDINGS.supplyhub.cost + 150 &&
      this.findSpot("supplyhub")
    ) {
      if (me.pwrHave - me.pwrUse < 15 && pwrCount < 8) return this.pickPower(me, bc);
      return "supplyhub";
    }
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
    if (!this.hasConstruction(bc)) return null;
    if (!has("factory") && !(this.profile === "turtle" && has("barracks"))) return null;
    if (me.lowPower || me.pwrHave - me.pwrUse < 45) return null;
    const turrets = bc.get("turret") ?? 0;
    const sams = bc.get("sam") ?? 0;
    const arcs = bc.get("arc") ?? 0;
    const domes = bc.get("irondome") ?? 0;
    const lasers = bc.get("lasertower") ?? 0;
    const thaads = bc.get("thaad") ?? 0;
    const totalDef = turrets + sams + arcs + domes + lasers + thaads;
    const defGoal =
      this.phase === "early"
        ? Math.min(1, this.turretCap)
        : this.phase === "mid"
          ? Math.min(3, this.turretCap + 1)
          : this.turretCap + (this.profile === "turtle" ? 3 : 1);
    if (this.diff !== "easy") {
      const thaadCap = this.profile === "turtle" || this.diff === "brutal" ? 2 : 1;
      if (has("satlink") && thaads < thaadCap && me.credits >= BUILDINGS.thaad.cost + 200) {
        return "thaad";
      }
    }
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
    const f2 = this.hasBuilding(bc, "factory2");
    const a2 = this.hasBuilding(bc, "airfield2");
    const s2 = this.hasBuilding(bc, "shipyard2");
    const unitCounts = this.scan.myUnitCounts;
    const count = (k: UnitKind) => unitCounts.get(k) ?? 0;
    const harv = count("harvester"),
      supplytrucks = count("supplytruck"),
      engi = count("engineer"),
      spies = count("spy"),
      ballistics = count("ballistic"),
      fpvdrones = count("fpvdrone"),
      himars = count("himars"),
      railtanks = count("railtank"),
      uavs = count("uav"),
      shaheds = count("shahed"),
      ewdrones = count("ewdrone"),
      interceptors = count("interceptor"),
      choppers = count("chopper"),
      a10s = count("a10"),
      ac130s = count("ac130"),
      stealthbombers = count("stealthbomber"),
      hypersonics = count("hypersonic"),
      usvs = count("usv"),
      gunboats = count("gunboat"),
      destroyers = count("destroyer"),
      subs = count("sub"),
      dreadnoughts = count("dreadnought"),
      carriers = count("carrier");
    const army = this.scan.myArmyCount,
      neutralLandmarks = this.scan.neutralLandmarks;

    // barracks: infantry, FPV suicide drones, AT/MANPADS rockets once radar is up,
    // and an engineer for neutral Oil Derricks / Coal Mines / late pushes (Normal/Brutal)
    const infGoal =
      this.phase === "early"
        ? Math.min(2, this.infCap)
        : this.phase === "mid" || this.diff === "easy"
          ? this.infCap
          : this.infCap + 2;
    const fpvCap = this.diff === "easy" ? 2 : this.diff === "brutal" ? 6 : 4;
    if (this.hasBuilding(bc, "barracks") && army < this.armyCap) {
      const q = me.queues.barracks;
      const wantLandmarkEngi = this.diff !== "easy" && neutralLandmarks > 0 && me.credits >= UNITS.engineer.cost + 200;
      if (this.diff !== "easy" && !q?.length && !engi && (wantLandmarkEngi || me.credits > 800)) {
        this.trycmd(() => w.cmdTrain(this.slot, "engineer"));
      } else if (!q?.length) {
        const step = this.barracksCycle % 4;
        let unit: UnitKind = "infantry";
        if (step === 1 && fpvdrones < fpvCap && (this.phase !== "early" || this.profile === "rusher")) {
          unit = "fpvdrone";
        } else if (step === 2 && radar) {
          unit = "rocket";
        } else if (step === 3 && radar && spies < 1 && this.diff !== "easy" && this.phase !== "early") {
          unit = "spy";
        }
        if (me.credits >= UNITS[unit].cost + reserve) {
          this.trycmd(() => w.cmdTrain(this.slot, unit));
          this.barracksCycle++;
        }
      } else if (q[0]?.unit !== "engineer") {
        const u = q[0].unit;
        const cap = u === "fpvdrone" ? Math.min(infGoal, Math.max(1, fpvCap - fpvdrones)) : infGoal;
        if (q.length < cap && me.credits >= UNITS[u].cost + reserve) {
          this.trycmd(() => w.cmdTrain(this.slot, u));
        }
      }
    }

    // Factory harvesters always take priority over combat units so economy never stalls
    if (this.hasBuilding(bc, "factory")) {
      const q = me.queues.factory;
      const harvGoal = this.diff === "easy" ? 2 : this.phase === "early" ? 2 : me.credits > 3000 ? 4 : 3;
      if (!q?.length && harv < harvGoal && me.credits >= UNITS.harvester.cost + reserve) {
        this.trycmd(() => w.cmdTrain(this.slot, "harvester"));
      }
      // Huge maps: train 1-2 Supply Convoys to sustain forward forces with fuel & ammo
      const truckGoal = w.w >= 96 && w.config.logistics !== false ? (this.diff === "easy" ? 1 : 2) : 0;
      if (
        truckGoal > 0 &&
        !me.queues.factory &&
        supplytrucks < truckGoal &&
        this.hasBuilding(bc, "refinery") &&
        me.credits >= UNITS.supplytruck.cost + reserve
      ) {
        this.trycmd(() => w.cmdTrain(this.slot, "supplytruck"));
      }
    }

    // Air Command: Reaper UAVs, EW Jammer Drones, Delta Kamikaze Drones, Valkyrie Jets, A-10 Warthogs, AC-130 Gunships, B-21 Stealth & Mach-9 Hypersonic
    if (this.hasBuilding(bc, "airfield")) {
      const q = me.queues.airfield;
      const airCount = uavs + ewdrones + shaheds + interceptors + choppers + a10s + ac130s + stealthbombers + hypersonics;
      const airGoal = (this.diff === "easy" ? 2 : this.diff === "brutal" ? 13 : 7) + (a2 ? 3 : 0);
      const ewCap = this.diff === "easy" ? 0 : this.diff === "brutal" || this.profile === "turtle" ? 2 : 1;
      const shahedCap = this.diff === "easy" ? 2 : this.diff === "brutal" ? 5 : 3;
      const a10Cap = this.diff === "easy" ? 0 : this.diff === "brutal" ? 3 : 2;
      const ac130Cap = this.diff === "easy" ? 0 : this.diff === "brutal" ? 2 : 1;
      if (!q?.length) {
        let unit: UnitKind | null = null;
        if (uavs < 1) unit = "uav";
        else if (radar && ewCap > 0 && ewdrones < ewCap) unit = "ewdrone";
        else if (a2 && ac130Cap > 0 && ac130s < ac130Cap && ac130s <= hypersonics && interceptors + a10s + choppers >= 1) unit = "ac130";
        else if (a2 && hypersonics < 2 && hypersonics <= stealthbombers && interceptors + a10s + choppers >= 1) unit = "hypersonic";
        else if (a2 && stealthbombers < 2 && interceptors + a10s + choppers >= 1) unit = "stealthbomber";
        else if (a2 && hypersonics < 2 && interceptors + a10s + choppers >= 1) unit = "hypersonic";
        else if (radar && a10Cap > 0 && a10s < a10Cap && a10s <= interceptors && a10s <= choppers) unit = "a10";
        // the Hornet is the bot's only way to project infantry across water — guarantee
        // one airframe before the shahed grinder eats every production slot (the reserved
        // transport below survives, so this fires at most once per loss)
        else if (this.diff !== "easy" && choppers < 1) unit = "chopper";
        else if (shaheds < shahedCap && (shaheds <= interceptors + choppers + a10s || this.profile === "rusher")) unit = "shahed";
        else if (interceptors <= choppers) unit = "interceptor";
        else unit = "chopper";
        if (unit && airCount < airGoal && army < this.armyCap + 8 && me.credits >= UNITS[unit].cost + reserve) {
          this.trycmd(() => w.cmdTrain(this.slot, unit));
        }
      } else {
        const u = q[0].unit;
        const cap =
          u === "ewdrone"
            ? ewCap
            : u === "shahed"
              ? shahedCap
              : u === "a10"
                ? a10Cap
                : u === "ac130"
                  ? ac130Cap
                  : u === "stealthbomber" || u === "hypersonic" || u === "uav"
                    ? 2
                    : 3;
        const fielded =
          u === "uav"
            ? uavs
            : u === "ewdrone"
              ? ewdrones
              : u === "shahed"
                ? shaheds
                : u === "interceptor"
                  ? interceptors
                  : u === "chopper"
                    ? choppers
                    : u === "a10"
                      ? a10s
                      : u === "ac130"
                        ? ac130s
                        : u === "stealthbomber"
                          ? stealthbombers
                          : hypersonics;
        if (
          fielded + q.length < cap &&
          airCount + q.length < airGoal &&
          army < this.armyCap + 8 &&
          me.credits >= UNITS[u].cost + reserve
        ) {
          this.trycmd(() => w.cmdTrain(this.slot, u));
        }
      }
    }

    // Naval Shipyard: Sea-Baby USV Drone Boats, Viper Hydrofoils, Aegis Destroyers, Kraken Subs, Poseidon Cruisers & Nimitz Carriers
    if (this.hasBuilding(bc, "shipyard")) {
      const q = me.queues.shipyard;
      const seaCount = usvs + gunboats + destroyers + subs + dreadnoughts + carriers;
      const seaGoal = this.diff === "easy" ? 3 : this.diff === "brutal" ? 11 : 6;
      const usvCap = this.diff === "easy" ? 2 : this.diff === "brutal" ? 4 : 3;
      if (!q?.length) {
        let unit: UnitKind | null = null;
        if (s2 && carriers < 2 && gunboats + destroyers >= 2) unit = "carrier";
        else if (s2 && dreadnoughts < 2 && gunboats + destroyers >= 2) unit = "dreadnought";
        else if (usvs < usvCap && (gunboats + destroyers >= 1 || usvs < 1)) unit = "usv";
        else if (radar && subs < 2 && gunboats >= 1) unit = "sub";
        else if (destroyers < 3 && gunboats >= 1) unit = "destroyer";
        else unit = "gunboat";
        if (unit && seaCount < seaGoal && army < this.armyCap + 8 && me.credits >= UNITS[unit].cost + reserve) {
          this.trycmd(() => w.cmdTrain(this.slot, unit));
        }
      } else {
        const u = q[0].unit;
        const cap = u === "usv" ? usvCap : u === "dreadnought" || u === "carrier" || u === "sub" ? 2 : 3;
        const fielded =
          u === "usv"
            ? usvs
            : u === "gunboat"
              ? gunboats
              : u === "destroyer"
                ? destroyers
                : u === "sub"
                  ? subs
                  : u === "carrier"
                    ? carriers
                    : dreadnoughts;
        if (
          fielded + q.length < cap &&
          seaCount + q.length < seaGoal &&
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
      const himarsCap = this.diff === "easy" ? 1 : this.diff === "brutal" ? 3 : 2;
      const railCap = this.diff === "brutal" || this.profile === "tech" ? 5 : 4;
      const ballisticCap = this.diff === "easy" ? 0 : this.diff === "brutal" ? 2 : 1;
      if (!q?.length) {
        // fresh queue: Aegis Railgun MBTs (factory2), HIMARS rocket artillery (radar), Ballistic TELs, else Main Battle Tanks
        let unit: UnitKind | null = null;
        if (this.phase !== "early") {
          if (f2 && railtanks < railCap && railtanks <= himars + 2) unit = "railtank";
          else if (radar && himars < himarsCap) unit = "himars";
          else if (f2 && ballistics < ballisticCap && this.phase === "late") unit = "ballistic";
          else if (f2 && railtanks < railCap) unit = "railtank";
          else unit = "tank";
        }
        // high-tier units bypass the base army cap slightly so tech booms stay impactful
        const eliteUnit = (f2 && unit === "railtank") || (radar && unit === "himars" && this.phase === "late");
        if (unit && (army < this.armyCap || eliteUnit) && me.credits >= UNITS[unit].cost + reserve) {
          this.trycmd(() => w.cmdTrain(this.slot, unit));
        }
      } else {
        // one shared queue — stack more of what's already in it (queued units
        // count toward the caps) instead of fighting a different queue unit
        const u = q[0].unit;
        const cap =
          u === "tank"
            ? tankGoal
            : u === "himars"
              ? himarsCap
              : u === "ballistic"
                ? ballisticCap
                : u === "railtank"
                  ? railCap
                  : 0;
        const fielded =
          u === "himars" ? himars : u === "ballistic" ? ballistics : u === "railtank" ? railtanks : 0;
        const eliteU = (f2 && u === "railtank") || (radar && u === "himars" && this.phase === "late");
        if (cap > 0 && fielded + q.length < cap && (army < this.armyCap || eliteU) && me.credits >= UNITS[u].cost + reserve) {
          this.trycmd(() => w.cmdTrain(this.slot, u));
        }
        // a queued harvester or supplytruck is left to finish rather than cancelled
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
    for (const e of this.scan.myBuildings) {
      const pct = e.hp / e.mhp;
      if (pct < worstPct) {
        worstPct = pct;
        worst = e;
        worstK = e.k as BuildingKind;
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

  // Upgrade power plants (power -> coalplant -> fusion) & production buildings along UPGRADE_PATHS.
  private upgrade(me: P, bc: Map<BuildingKind, number>) {
    if (this.diff === "easy") return;
    // Upgrade existing Power Plants in-place when power is tight or in mid/late game!
    const needPower = me.lowPower || me.pwrHave - me.pwrUse < 65;
    if (needPower || this.phase === "late") {
      for (const from of ["coalplant", "power"] as const) {
        const path = UPGRADE_PATHS[from];
        if (!path || (bc.get(from) ?? 0) === 0 || !this.hasBuilding(bc, path.requires)) continue;
        if (me.credits < path.cost + (needPower ? 100 : 600)) continue;
        for (const e of this.scan.myBuildings) {
          if (e.k === from) {
            this.trycmd(() => this.world.cmdUpgrade(this.slot, e.id));
            return;
          }
        }
      }
    }
    if (this.phase === "early") return;
    const order: BuildingKind[] = ["factory", "barracks", "airfield", "shipyard"];
    for (const from of order) {
      const path = UPGRADE_PATHS[from];
      if (!path) continue;
      if ((bc.get(from) ?? 0) === 0 || (bc.get(path.to) ?? 0) > 0) continue;
      if (!this.hasBuilding(bc, path.requires)) continue;
      if (this.phase !== "late" && from !== "barracks" && this.profile !== "tech") continue;
      if (me.credits <= path.cost + 750) continue;
      for (const e of this.scan.myBuildings) {
        if (e.k === from) {
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
    for (const e of this.scan.myUnits) {
      if (e.k !== "harvester" || e.order || e.hstate) continue;
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
    for (const e of this.scan.myUnits) {
      if (e.k !== "infantry" || e.order || this.missionIds.has(e.id)) continue;
      scout = e;
      break;
    }
    if (!scout) return;
    // attack-move toward the enemy's spawn, via map middle — sees plenty en route
    const foe = this.enemyBasePt(base);
    const tgt = foe ?? { x: w.w - base.x, y: w.h - base.y };
    const mid = { x: (base.x + tgt.x) / 2, y: (base.y + tgt.y) / 2 };
    this.trycmd(() => w.cmdOrder(this.slot, [scout!.id], "amove", mid.x, mid.y));
    this.lastScout = t;
  }

  // Raid target for mid-game waves: enemy harvesters/refineries — hitting
  // their economy instead of their turret line (the classic RA2 harassment).
  private ecoRaidTarget(base: { x: number; y: number }): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null,
      bd = Infinity;
    for (const e of this.scan.enemyAll) {
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

  // ---------- helicopter troop transport ("airlift") ----------

  // Nonzero land-connectivity region near a point. Buildings sit on blocked
  // tiles, so probe a small spiral around the target for the region its
  // surroundings belong to; 0 = nothing walkable within reach (not even a
  // valid drop zone — skip such targets entirely).
  private regionNear(x: number, y: number): number {
    const w = this.world;
    const cx = Math.floor(x),
      cy = Math.floor(y);
    for (let r = 0; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const reg = w.landRegion(cx + dx, cy + dy);
          if (reg > 0) return reg;
        }
      }
    }
    return 0;
  }

  // Idle (orderless), healthy, empty transport close enough to home to matter.
  private idleChopperNear(base: { x: number; y: number }): Ent | null {
    let best: Ent | null = null,
      bd = Infinity;
    for (const e of this.scan.myUnits) {
      if (transportCapOf(e.k) <= 0 || e.order || (e.passengers?.length ?? 0) > 0) continue;
      const d = dist(e.x, e.y, base.x, base.y);
      if (d > AIRLIFT_HOME_RADIUS || d >= bd) continue;
      bd = d;
      best = e;
    }
    return best;
  }

  // The dedicated transport: the longest-lived (lowest-id) chopper is reserved from
  // assault waves so the airlift always has an airframe — everything else the airfield
  // fields remains wave fodder. Re-resolves each scan, so a loss passes the torch.
  private reservedTransport(): number {
    let best = -1;
    for (const e of this.scan.myUnits) {
      if (transportCapOf(e.k) <= 0) continue;
      if (best < 0 || e.id < best) best = e.id;
    }
    return best;
  }

  // Idle infantry-class troops near home, closest-first. `kinds` restricts the mix.
  // Candidates must share the base's land region — a rifleman on the wrong side of
  // the bay can never reach the chopper, however close he looks on the ruler.
  private idleInfantryNear(base: { x: number; y: number }, kinds: readonly EntKind[], cap: number, baseRegion: number): Ent[] {
    const out: Ent[] = [];
    for (const e of this.scan.myUnits) {
      if (!kinds.includes(e.k) || e.order) continue;
      if (dist(e.x, e.y, base.x, base.y) > AIRLIFT_HOME_RADIUS) continue;
      if (this.regionNear(e.x, e.y) !== baseRegion) continue;
      out.push(e);
    }
    out.sort((a, b) => dist(a.x, a.y, base.x, base.y) - dist(b.x, b.y, base.x, base.y));
    return out.slice(0, cap);
  }

  private manageAirlift(me: P, t: number) {
    const w = this.world;
    if (this.diff === "easy") return;
    const m = this.airlift;
    if (!m) {
      this.maybeStartAirlift(me, t);
      return;
    }

    // ---- validation & failsafes: nothing may stay pinned inside a mission ----
    const chop = w.ents.get(m.chopper);
    if (!chop || chop.o !== this.slot) {
      this.endAirlift(t, true, "chopper-dead"); // ride dead — board orders auto-clear, landed troops rejoin the pool
      return;
    }
    if (t - m.born > AIRLIFT_MISSION_TIMEOUT) {
      this.endAirlift(t, true, "mission-timeout");
      return;
    }

    if (m.state === "load") {
      // shrink the troop list to the living: aboard (passenger records) or still walking
      const aboard = new Set((chop.passengers ?? []).map((p) => p.id));
      m.troops = m.troops.filter((id) => aboard.has(id) || w.ents.has(id));
      if (!m.troops.length) {
        this.endAirlift(t, true, "troops-dead");
        return;
      }
      const walking = m.troops.filter((id) => w.ents.has(id));
      const liftoff = walking.length === 0 || (t - m.since > AIRLIFT_LOAD_TIMEOUT && aboard.size >= 1);
      if (liftoff) {
        if (aboard.size === 0) {
          this.endAirlift(t, true, "no-boarders"); // nobody made it aboard — cut losses
          return;
        }
        // stragglers forfeit the ride: cancel the chase so they rejoin the pool instead
        // of pursuing the chopper across the map (and into the sea they can't cross)
        if (walking.length) w.cmdStop(this.slot, walking); // void — cannot be denied
        m.troops = m.troops.filter((id) => aboard.has(id));
        this.missionIds = new Set([m.chopper, ...m.troops]); // forfeited stragglers rejoin the pool NOW
        const err = w.cmdOrder(this.slot, [m.chopper], "unload", m.goal.x, m.goal.y);
        if (err) {
          this.endAirlift(t, true, "unload-denied:" + err.slice(0, 24));
          return;
        }
        m.state = "fly";
        m.since = t;
      } else if (t - m.since > AIRLIFT_LOAD_TIMEOUT) {
        this.endAirlift(t, true, "load-timeout"); // timeout with nobody aboard
      }
      return;
    }

    // state "fly" — the unload order carries the chopper to the drop zone and drips
    // passengers out; completion is the order going away.
    if (!chop.order) {
      const landed = m.troops.filter((id) => {
        const e = w.ents.get(id);
        return e && dist(e.x, e.y, m.goal.x, m.goal.y) <= AIRLIFT_DROP_RADIUS;
      });
      if (landed.length) {
        this.finishAirlift(m, landed, chop, t);
      } else {
        // drop aborted (no valid landing) or troops died on the beach — either way the
        // mission is over; a chopper still carrying passengers ferries them home first
        this.endAirlift(t, true, "no-dropzone");
      }
      return;
    }
    if (t - m.since > AIRLIFT_FLY_TIMEOUT) this.endAirlift(t, true, "fly-timeout");
  }

  // Mission success: troops are on the ground at the far shore. Hand them their
  // real orders, send the chopper home, free everything back into the pool.
  private finishAirlift(m: Airlift, landed: number[], chop: Ent, t: number) {
    const w = this.world;
    const base = this.baseCenter();
    if (m.kind === "expand") {
      const lm = m.targetId != null ? w.ents.get(m.targetId) : null;
      // capture orders only while the landmark is still there for the taking —
      // if we already own it the job is done, if it died there is nothing to take
      const stillValid = lm && lm.o !== this.slot;
      for (const id of landed) {
        const e = w.ents.get(id);
        if (!e || e.k !== "engineer" || !stillValid || !lm) continue;
        this.trycmd(() => w.cmdOrder(this.slot, [id], "attack", lm.x, lm.y, lm.id));
      }
      // escorts hold the beachhead — idle infantry auto-fire in range
    } else {
      this.trycmd(() => w.cmdOrder(this.slot, landed, "amove", m.goal.x, m.goal.y));
    }
    if (base) this.trycmd(() => w.cmdOrder(this.slot, [chop.id], "move", base.x, base.y));
    this.airlifts++;
    this.endAirlift(t, false);
  }

  // Release every mission unit back into the general pool. Self-cleaning by
  // contract: dangling boarders are stopped, a loaded chopper ferries its
  // passengers home before rejoining the airforce — nothing is pinned forever.
  private endAirlift(t: number, abort: boolean, why = "") {
    const w = this.world;
    const m = this.airlift;
    if (m && this.airliftLog.push(`${abort ? "abort" : "done"}:${m.kind}${why ? ":" + why : ""}@t${t}`) > 8) this.airliftLog.shift();
    if (m && abort) {
      const chop = w.ents.get(m.chopper);
      if (chop && chop.o === this.slot) {
        const base = this.baseCenter();
        if ((chop.passengers?.length ?? 0) > 0 && base) {
          this.trycmd(() => w.cmdOrder(this.slot, [chop.id], "unload", base.x, base.y));
        }
      }
      const chasing = m.troops.filter((id) => {
        const e = w.ents.get(id);
        return e && e.order?.kind === "board";
      });
      if (chasing.length) w.cmdStop(this.slot, chasing); // void — cannot be denied
    }
    this.airlift = null;
    this.missionIds.clear();
    this.lastAirliftEnd = t;
  }

  // Evaluate expansion/raid triggers and commit one mission. Expansion (a neutral
  // derrick/mine across the water) outranks raids — economy first, and it is the
  // lowest-risk sortie: one engineer plus a couple of escorts.
  private maybeStartAirlift(me: P, t: number) {
    const w = this.world;
    if (t - this.lastAirliftEnd < AIRLIFT_RESTART_GAP) { this.airliftBlock = "restart-gap"; return; }
    if (t - this.threatAt < 120) { this.airliftBlock = "threat"; return; } // base under pressure — every rifle stays home
    const base = this.baseCenter();
    if (!base) { this.airliftBlock = "no-base"; return; }
    const baseRegion = this.regionNear(base.x, base.y);
    if (!baseRegion) { this.airliftBlock = "base-region-0"; return; }
    const chop = this.idleChopperNear(base);
    if (!chop) { this.airliftBlock = "no-idle-chopper"; return; }

    // ---- expansion: neutral landmark unreachable on foot ----
    if (w.config.derricks) {
      // the engineer must be able to walk to the chopper: same region as the base,
      // close to home — a stranded engineer on a far shore is captureDerricks' problem
      const engi = this.scan.myUnits.find(
        (e) => e.k === "engineer" && !e.order && dist(e.x, e.y, base.x, base.y) <= AIRLIFT_HOME_RADIUS && this.regionNear(e.x, e.y) === baseRegion,
      );
      if (engi) {
        let bestLm: Ent | null = null,
          bd = Infinity;
        for (const lm of this.scan.landmarks) {
          if (lm.o !== -1) continue;
          const lmRegion = this.regionNear(lm.x, lm.y);
          if (!lmRegion || lmRegion === baseRegion) continue; // walkable ones belong to captureDerricks
          const d = dist(base.x, base.y, lm.x, lm.y);
          if (d < bd) {
            bd = d;
            bestLm = lm;
          }
        }
        if (bestLm) {
          const escorts = this.idleInfantryNear(base, ["infantry", "rocket"], 2, baseRegion).map((e) => e.id);
          this.airliftBlock = "";
          this.beginAirlift(t, "expand", chop, [engi.id, ...escorts], { x: bestLm.x, y: bestLm.y }, bestLm.id);
          return;
        }
        this.airliftBlock = "no-xregion-landmark";
      }
    }

    // ---- raid: the assault goal is across the water — infantry can't walk there ----
    if (this.phase === "early") { this.airliftBlock = "phase-early"; return; }
    const goal = this.enemyBasePt(base) ?? this.nearestEnemyEnt(base);
    if (!goal) { this.airliftBlock = "no-goal"; return; }
    const goalRegion = this.regionNear(goal.x, goal.y);
    if (!goalRegion) { this.airliftBlock = "goal-unlandable"; return; }
    if (goalRegion === baseRegion) { this.airliftBlock = "goal-walkable"; return; }
    const troops = this.idleInfantryNear(base, ["infantry", "rocket"], 4, baseRegion);
    if (troops.length < 3) { this.airliftBlock = `troops-${troops.length}`; return; } // a smaller sortie isn't worth pinning the transport
    this.airliftBlock = "";
    this.beginAirlift(t, "raid", chop, troops.map((e) => e.id), { x: goal.x, y: goal.y });
  }

  private beginAirlift(t: number, kind: Airlift["kind"], chop: Ent, troops: number[], goal: { x: number; y: number }, targetId?: number) {
    const w = this.world;
    const m: Airlift = { kind, chopper: chop.id, troops: [...troops], goal, targetId, state: "load", since: t, born: t };
    // staging: the chopper hovers to the squad so boarding is a short walk, not a chase
    let cx = 0,
      cy = 0,
      n = 0;
    for (const id of troops) {
      const e = w.ents.get(id);
      if (e) {
        cx += e.x;
        cy += e.y;
        n++;
      }
    }
    if (!n) return;
    cx /= n;
    cy /= n;
    // staging is best-effort: if the hop order is refused the troops simply walk
    // to the chopper's parking spot instead — boarding chases a moving ride fine
    w.cmdOrder(this.slot, [chop.id], "move", cx, cy);
    const boardErr = w.cmdOrder(this.slot, troops, "board", chop.x, chop.y, chop.id);
    if (boardErr) {
      // boarding refused outright — never mind (nothing is pinned yet: no mission state)
      this.denies++;
      this.lastDeny = boardErr;
      return;
    }
    this.airlift = m;
    this.missionIds = new Set([chop.id, ...troops]);
  }

  // Normal & brutal bots send idle Sappers (engineers) to capture nearby neutral Oil Derricks & Coal Mines.
  // Reachability is per-engineer land-connectivity: landmarks across the water are NOT
  // walkable — those belong to the airlift — while an engineer already stranded on a
  // far shore absolutely should capture the derrick next to it.
  private captureDerricks() {
    if (this.diff === "easy") return;
    const w = this.world;
    const base = this.baseCenter();
    if (!base) return;
    const maxDist = this.diff === "brutal" ? 999 : Math.max(42, Math.floor(w.w * 0.65));
    for (const e of this.scan.myUnits) {
      if (e.k !== "engineer" || e.order || this.missionIds.has(e.id)) continue;
      const engiRegion = this.regionNear(e.x, e.y);
      if (!engiRegion) continue;
      const targets: Ent[] = [];
      for (const lm of this.scan.landmarks) {
        if (!(lm.o === -1 || (this.diff === "brutal" && !w.isAlly(this.slot, lm.o)))) continue;
        if (this.regionNear(lm.x, lm.y) !== engiRegion) continue; // unreachable on foot — the airlift's job
        if (dist(e.x, e.y, lm.x, lm.y) > maxDist) continue;
        targets.push(lm);
      }
      if (!targets.length) continue;
      // Prefer neutral landmarks first, then closest to the engineer
      targets.sort((a, b) => {
        if ((a.o === -1) !== (b.o === -1)) return a.o === -1 ? -1 : 1;
        return dist(e.x, e.y, a.x, a.y) - dist(e.x, e.y, b.x, b.y);
      });
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
      const taxi = this.reservedTransport();
      for (const u of this.scan.myUnits) {
        if (u.k === "harvester" || u.k === "supplytruck" || u.k === "engineer" || isSea(u.k)) continue;
        if (u.order || assigned.has(u.id) || this.missionIds.has(u.id) || u.id === taxi) continue;
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

  // Fire charged Nuclear Silo ICBM at the highest-value enemy structure.
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
      thaad: 86,
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
    for (const e of this.scan.enemyAll) {
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
    const foe = this.enemyBasePt(base) ?? { x: w.w / 2, y: w.h / 2 };
    const dx = foe.x - base.x,
      dy = foe.y - base.y,
      l = Math.hypot(dx, dy) || 1;
    // early holds a tight ring; later phases stage further out toward the enemy
    const musterD = this.phase === "early" ? 5 : this.phase === "mid" ? 8 : 11;
    const mx = clamp(base.x + (dx / l) * musterD, 1, w.w - 2),
      my = clamp(base.y + (dy / l) * musterD, 1, w.h - 2);
    const ids: number[] = [];
    for (const e of this.scan.myUnits) {
      if (e.k === "harvester" || e.k === "supplytruck" || isSea(e.k) || e.order) continue;
      if (this.missionIds.has(e.id)) continue; // airlift crews muster with their chopper, not the rally point
      if (dist(e.x, e.y, base.x, base.y) > HOME_RADIUS) continue;
      if (dist(e.x, e.y, mx, my) <= 4.5) continue;
      ids.push(e.id);
    }
    if (ids.length) this.trycmd(() => w.cmdOrder(this.slot, ids, "move", mx, my));
  }

  // Keep mobile Supply Convoys escorting the active army and returning to hubs/base to refill when low.
  private manageSupplyTrucks() {
    const w = this.world;
    const base = this.baseCenter();
    if (!base) return;
    const trucks: Ent[] = [];
    const landArmy: Ent[] = [];
    const refillPts: Ent[] = [];
    for (const e of this.scan.mine) {
      if (e.k === "supplytruck") trucks.push(e);
      else if (e.k === "supplyhub" || e.k === "refinery" || e.k === "conyard") refillPts.push(e);
      else if (!isB(e.k) && e.k !== "harvester" && e.k !== "engineer" && UNITS[e.k].domain === "land") {
        landArmy.push(e);
      }
    }
    if (!trucks.length) return;

    // Pick army escort point: centroid of forward-most land units (or all land units)
    let escortPt: { x: number; y: number } | null = null;
    if (landArmy.length) {
      let sx = 0,
        sy = 0;
      for (const u of landArmy) {
        sx += u.x;
        sy += u.y;
      }
      escortPt = { x: clamp(sx / landArmy.length, 1, w.w - 2), y: clamp(sy / landArmy.length, 1, w.h - 2) };
    }

    for (const tr of trucks) {
      if (tr.cargo < 80 && refillPts.length) {
        let best = refillPts[0],
          bd = dist(tr.x, tr.y, best.x, best.y);
        for (let i = 1; i < refillPts.length; i++) {
          const d = dist(tr.x, tr.y, refillPts[i].x, refillPts[i].y);
          if (d < bd) {
            bd = d;
            best = refillPts[i];
          }
        }
        if (bd > 4) this.trycmd(() => w.cmdOrder(this.slot, [tr.id], "move", best.x, best.y));
      } else if (escortPt && dist(tr.x, tr.y, escortPt.x, escortPt.y) > 4.5) {
        this.trycmd(() => w.cmdOrder(this.slot, [tr.id], "move", escortPt!.x, escortPt!.y));
      }
    }
  }

  // Exact nearest own building/harvester distance within DEF_RADIUS, using the
  // snapshot asset buckets instead of enemy × asset nested scans.
  private assetDist2(e: Ent): number {
    let best = DEF_RADIUS * DEF_RADIUS;
    const x0 = Math.floor((e.x - DEF_RADIUS) / 8),
      x1 = Math.floor((e.x + DEF_RADIUS) / 8);
    const y0 = Math.floor((e.y - DEF_RADIUS) / 8),
      y1 = Math.floor((e.y + DEF_RADIUS) / 8);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = this.scan.assetCells.get(cy * 1024 + cx);
        if (!cell) continue;
        for (const m of cell) {
          const d2 = (e.x - m.x) * (e.x - m.x) + (e.y - m.y) * (e.y - m.y);
          if (d2 < best) best = d2;
        }
      }
    }
    return best;
  }

  // cheap loop (~8 ticks): enemies near our buildings/harvesters get a
  // response from home-guard units. Far-away wave troops are NOT recalled.
  private defend(t: number) {
    const w = this.world;
    const base = this.baseCenter();
    if (!base) return;
    // nearest visible enemy ent to any of our buildings or harvesters
    let threat: Ent | null = null,
      bd = DEF_RADIUS * DEF_RADIUS;
    for (const e of this.scan.enemyAll) {
      const p = w.players.get(e.o);
      if (p && p.eliminated) continue;
      if (w.isStealthed(e) && !w.isStealthDetected(e, this.slot)) continue;
      const d2 = this.assetDist2(e);
      if (d2 < bd) {
        bd = d2;
        threat = e;
      }
    }
    if (!threat) return;
    this.threatAt = t;
    const defendCooldown = this.diff === "easy" ? 40 : this.diff === "brutal" ? 15 : 25;
    if (t - this.lastDefend < defendCooldown) return; // human-paced defensive reaction
    this.lastDefend = t;
    const ids: number[] = [];
    const isDroneThreat = threat.k === "fpvdrone" || threat.k === "shahed" || threat.k === "usv" || threat.k === "uav";
    for (const e of this.scan.myUnits) {
      if (e.k === "harvester" || e.k === "engineer" || e.k === "supplytruck") continue;
      if (this.missionIds.has(e.id)) continue; // the rest of the army holds the line — the sortie is not recalled
      if (e.id === this.reservedTransport()) continue; // the taxi is a logistics asset, not a defender
      if (!w.canAttack(e, threat) && !(e.k === "ewdrone" && isDroneThreat)) continue;
      if (dist(e.x, e.y, base.x, base.y) > GUARD_RADIUS) continue;
      ids.push(e.id);
    }
    if (ids.length) this.trycmd(() => w.cmdOrder(this.slot, ids, "amove", threat.x, threat.y));
  }

  // Preferred target for naval units: enemy shipyard / ships first, else nearest enemy building.
  private navalTarget(ref: { x: number; y: number }): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null,
      bd = Infinity;
    for (const e of this.scan.enemyAll) {
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
    const taxiAway = this.reservedTransport();
    for (const e of this.scan.myUnits) {
      if (e.k === "harvester" || e.k === "supplytruck") continue;
      army.push(e);
      if (!e.order && e.id !== taxiAway && dist(e.x, e.y, base.x, base.y) > HOME_RADIUS) {
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
      const taxi = this.reservedTransport(); // the dedicated transport stays out of the grinder
      const landAirIds: number[] = [];
      const seaIds: number[] = [];
      for (const e of army) {
        if (this.missionIds.has(e.id)) continue; // airlift crews attack by air on their own schedule
        if (e.id === taxi) continue;
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
      // Escort the assault wave with any loaded Supply Convoys
      const convoyIds: number[] = [];
      for (const e of this.scan.myUnits) {
        if (e.k === "supplytruck" && e.cargo >= 100) convoyIds.push(e.id);
      }
      if (convoyIds.length && landAirIds.length) {
        const cx = clamp(base.x + (goal.x - base.x) * 0.78, 1, w.w - 2);
        const cy = clamp(base.y + (goal.y - base.y) * 0.78, 1, w.h - 2);
        this.trycmd(() => w.cmdOrder(this.slot, convoyIds, "move", cx, cy));
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
    const army = this.scan.myArmyCount;
    this.phase = this.phaseOf(me, bc, army, t);
    const want = this.wantBuilding(me, bc);
    if (want && !me.bq.length && !me.awaiting.length && me.credits >= BUILDINGS[want].cost) {
      this.trycmd(() => w.cmdBuild(this.slot, want));
    }
    const wantDef = this.wantDefense(me, bc);
    const structReserve = want && !me.bq.length && !me.awaiting.length ? Math.min(BUILDINGS[want].cost, 600) : 0;
    if (wantDef && !me.dq.length && !me.awaitingDef.length && me.credits >= BUILDINGS[wantDef].cost + structReserve) {
      this.trycmd(() => w.cmdBuild(this.slot, wantDef));
    }
    this.produce(me, bc, want);
    this.repairs(me, want ? Math.min(BUILDINGS[want].cost, 500) : 150, t);
    this.upgrade(me, bc);
    this.wakeHarvesters();
    if (w.config.superweapons) this.fireSuperweapon(me, bc);
    if (w.config.derricks) this.captureDerricks();
    // airlift progress must run before the sweeps so freshly freed units are
    // pool-visible in the same tick and active crews stay excluded throughout
    this.manageAirlift(me, t);
    if (w.config.crates) this.grabCrates();
    this.scout(t);
    this.rally();
    this.manageSupplyTrucks();
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
