import {
  BUILDINGS,
  UNITS,
  BuildingKind,
  BuildCategory,
  buildCategoryOf,
  UPGRADE_PATHS,
  UnitKind,
  EntKind,
  UnitDomain,
  ProdCat,
  MapId,
  CrateKind,
  GameConfig,
  DEFAULT_CONFIG,
  ORE_VALUE,
  HARVEST_TICKS_PER_UNIT,
  ORE_REGEN_TICKS,
  ORE_CELL_MAX,
  ORE_SPREAD_CHANCE,
  PURIFIER_BONUS,
  DEPOT_RANGE,
  DEPOT_HEAL,
  CAPTURE_RANGE,
  SHIPYARD_BUILD_DIST,
  IRONDOME_RADIUS,
  IRONDOME_COOLDOWN,
  THAAD_NUKE_RADIUS,
  THAAD_NUKE_CD,
  SPY_REVEAL_TICKS,
  SPY_POWERCUT_TICKS,
  SPY_DISABLE_TICKS,
  SPY_RADAR_SCRAMBLE_TICKS,
  SPY_CAPTURE_RANGE,
  SUPPLY_HUB_RADIUS,
  SUPPLY_TRUCK_RADIUS,
  BASE_SUPPLY_RADIUS,
  VET_XP,
  VET_DMG,
  VET_HP,
  VET_HEAL,
  SW_CHARGE_TICKS,
  SW_RADIUS,
  SW_DAMAGE,
  RECON_CHARGE_TICKS,
  RECON_RADIUS,
  DERRICK_CAPTURE_BONUS,
  DERRICK_INCOME,
  COALMINE_CAPTURE_BONUS,
  COALMINE_INCOME,
  CRATE_INTERVAL_TICKS,
  CRATE_MAX,
  CRATE_CASH,
  SPLASH_RADIUS,
  getSpawns,
  getMapLayout,
} from "../shared/gamedefs";
import type {
  OrderKind,
  EntSnap,
  CrateSnap,
  PlayerState,
  ProdQueue,
  GameEvent,
  WeaponFx,
  MatchStats,
} from "../shared/protocol";
import { findPath, nearestPassable } from "./path";

const MAX_WAYPOINTS = 16;
const CRATE_KINDS: readonly CrateKind[] = ["cash", "vet", "heal", "unit"];

const hasOwn = (o: object, k: unknown): boolean =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);

interface Order {
  kind: OrderKind;
  x: number;
  y: number;
  target?: number;
  patrolFrom?: [number, number];
}

export interface Ent {
  id: number;
  o: number; // owner slot, -1 = neutral
  k: EntKind;
  x: number;
  y: number;
  hp: number;
  mhp: number;
  d: number; // facing radians
  order: Order | null;
  orderQueue: Order[];
  path: { x: number; y: number }[] | null;
  cd: number;
  cargo: number;
  fuel: number; // 0..100 military logistics fuel reserve
  ammo: number; // 0..100 military logistics ammunition reserve
  hstate: "toOre" | "mining" | "toRef" | null;
  oreIdx: number;
  repath: number;
  agro: number | null; // enemy id an amove unit is currently chasing (for resume-after-kill)
  hold: boolean; // unit holding position (fires in range, will not chase)
  holdUntil: number; // suppress harvester auto-resume until this tick (stop/explicit orders)
  xp: number;
  vet: number; // 0..3 veterancy rank
  subSurfaceUntil: number; // stealth reveal timer (cloaked when tick >= subSurfaceUntil)
  interceptCd: number; // Iron Dome active projectile interception cooldown
  spottedUntil: number; // spy: cover blown until this tick (auto-targetable + shown as real kind)
  sabUntil: number; // defense battery disabled by enemy spy sabotage until this tick
  rally?: [number, number]; // rally point on production buildings
  direct?: {
    until: number;
    fwd: number;
    strafe: number;
    yaw: number;
    fire: boolean;
    aimX: number;
    aimY: number;
    aimTarget?: number;
    alt?: number; // -1..1 climb/dive input (aircraft)
    sprint?: boolean; // sprint/flank/boost throttle
    wpn?: number; // selected weapon slot 0..2 (multi-weapon platforms)
    lock?: number; // persistent lock-on target id
  };
  fpvAlt?: number; // normalized altitude 0..1 while player-driven (air only)
}

export interface P {
  slot: number;
  team: number; // 0 = FFA, 1..4 = allied team
  credits: number;
  awaiting: BuildingKind | null;
  bq: { kind: BuildingKind; left: number; total: number } | null;
  awaitingDef: BuildingKind | null;
  dq: { kind: BuildingKind; left: number; total: number } | null;
  queues: Partial<Record<ProdCat, ProdQueue>>;
  eliminated: boolean;
  pwrHave: number;
  pwrUse: number;
  lowPower: boolean;
  swLeft: number; // -1 if no superweapon, else 0..SW_CHARGE_TICKS
  reconLeft: number; // -1 if no radar, else 0..RECON_CHARGE_TICKS
  powerCutUntil: number; // spy sabotage: grid blacked out until this tick
  radarScrambleUntil: number; // spy sabotage: Radar-tier sensors blinded until this tick
  unitsBuilt: number;
  unitsLost: number;
  bldDestroyed: number;
  creditsEarned: number;
}

export interface WorldOpts {
  map?: MapId;
  teams?: Record<number, number>;
  names?: Record<number, string>;
  config?: Partial<GameConfig>;
}

// Serializable form of a live match for Durable Object storage — everything
// not re-derivable from the map layout. Structured-clone safe.
export interface WorldSave {
  v: 1;
  map: MapId;
  config: GameConfig;
  tick: number;
  winner: number | null;
  winnerTeam: number | null;
  nextId: number;
  nextCrateId: number;
  names: Record<number, string>;
  ents: Ent[];
  players: P[];
  crates: CrateSnap[];
  ore: Int16Array;
  lastAlert: [number, number][];
}

const PROD_CATS: readonly ProdCat[] = ["barracks", "factory", "airfield", "shipyard"];
const UPGRADED_OF: Partial<Record<BuildingKind, BuildingKind>> = {
  barracks: "barracks2",
  factory: "factory2",
  airfield: "airfield2",
  shipyard: "shipyard2",
};
const INTERCEPTABLE = new Set<EntKind>([
  "arty",
  "himars",
  "dreadnought",
  "bomber",
  "stealthbomber",
  "hypersonic",
  "zeppelin",
  "fpvdrone",
  "shahed",
  "ballistic",
]);
const JAMMABLE_DRONES = new Set<EntKind>(["fpvdrone", "shahed", "usv", "uav"]);
const STEALTH_AIR_DETECTORS = new Set<EntKind>([
  "radar",
  "sam",
  "irondome",
  "satlink",
  "thaad",
]);
const BASE_SUPPLY_PROVIDERS = new Set<EntKind>([
  "conyard",
  "refinery",
  "depot",
  "airfield",
  "airfield2",
  "shipyard",
  "shipyard2",
  "carrier",
]);
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const isBuilding = (k: EntKind): k is BuildingKind => k in BUILDINGS;
const isKamikaze = (k: EntKind): boolean => !isBuilding(k) && Boolean(UNITS[k].kamikaze);
const domainOf = (k: EntKind): UnitDomain =>
  isBuilding(k) ? (BUILDINGS[k].waterOnly ? "sea" : "land") : UNITS[k].domain;
const canHitAirOf = (k: EntKind): boolean => (isBuilding(k) ? !!BUILDINGS[k].canHitAir : !!UNITS[k].canHitAir);
const canHitGroundOf = (k: EntKind): boolean =>
  isBuilding(k)
    ? (BUILDINGS[k].dmg ?? 0) > 0 && BUILDINGS[k].canHitGround !== false
    : UNITS[k].canHitGround !== false && UNITS[k].dmg > 0;
const isInfantry = (k: EntKind) => k === "infantry" || k === "rocket" || k === "engineer" || k === "spy";
const usesFuel = (k: EntKind): boolean =>
  !isBuilding(k) && !isInfantry(k) && k !== "supplytruck" && k !== "harvester";
const fuelBurnOf = (k: EntKind, dom: UnitDomain): number => {
  if (k === "hypersonic") return 0.04;
  if (isKamikaze(k)) return 0.18;
  return dom === "air" ? 0.55 : dom === "sea" ? 0.25 : 0.35;
};
const ammoCostOf = (k: EntKind): number => {
  if (isKamikaze(k)) return 0;
  if (k === "a10") return 2;
  if (k === "ac130") return 6;
  if (
    k === "himars" ||
    k === "arty" ||
    k === "dreadnought" ||
    k === "bomber" ||
    k === "stealthbomber" ||
    k === "zeppelin" ||
    k === "ballistic"
  ) {
    return 12;
  }
  if (
    k === "tank" ||
    k === "heavy" ||
    k === "railtank" ||
    k === "destroyer" ||
    k === "sub" ||
    k === "carrier" ||
    k === "chopper" ||
    k === "interceptor"
  ) {
    return 7;
  }
  return 4;
};
const isHeavyArmor = (k: EntKind) => k === "tank" || k === "heavy" || k === "harvester" || k === "railtank";
const isVehicle = (k: EntKind) =>
  k === "tank" ||
  k === "heavy" ||
  k === "arty" ||
  k === "harvester" ||
  k === "supplytruck" ||
  k === "spider" ||
  k === "himars" ||
  k === "railtank" ||
  k === "ballistic";
const isLightUnit = (k: EntKind) =>
  isInfantry(k) || k === "spider" || k === "uav" || k === "gunboat";
const isSeaShip = (k: EntKind) => !isBuilding(k) && UNITS[k].domain === "sea";

const armorMult = (attacker: EntKind, target: EntKind): number => {
  const tDom = domainOf(target);
  if (attacker === "infantry") {
    if (tDom === "air") return 0.6;
    if (isInfantry(target)) return 1.35;
    if (isHeavyArmor(target)) return 0.7;
  } else if (attacker === "rocket") {
    if (tDom === "air") return 1.35;
    if (isVehicle(target)) return 1.4;
    if (isInfantry(target)) return 0.75;
  } else if (attacker === "arty") {
    if (isBuilding(target)) return 1.35;
  } else if (attacker === "railtank") {
    if (isVehicle(target) || isBuilding(target)) return 1.35;
  } else if (attacker === "lasertower") {
    if (isVehicle(target) || isSeaShip(target)) return 1.4;
  } else if (attacker === "sam") {
    if (tDom === "air") return 1.5;
  } else if (attacker === "thaad") {
    if (
      target === "stealthbomber" ||
      target === "ac130" ||
      target === "hypersonic" ||
      target === "a10" ||
      target === "interceptor"
    ) {
      return 1.5;
    }
  } else if (attacker === "uav") {
    if (isLightUnit(target)) return 1.25;
  } else if (attacker === "sub") {
    if (isSeaShip(target)) return 1.45;
  } else if (attacker === "interceptor") {
    if (tDom === "air") return 1.4;
  } else if (
    attacker === "bomber" ||
    attacker === "stealthbomber" ||
    attacker === "himars" ||
    attacker === "zeppelin" ||
    attacker === "dreadnought"
  ) {
    if (isBuilding(target)) return 1.3;
  } else if (attacker === "hypersonic") {
    if (isBuilding(target) || isSeaShip(target)) return 1.5;
  } else if (attacker === "ballistic") {
    if (isBuilding(target) || isSeaShip(target)) return 1.4;
  } else if (attacker === "a10") {
    if (
      target === "tank" ||
      target === "himars" ||
      target === "railtank" ||
      target === "harvester" ||
      target === "supplytruck" ||
      target === "heavy" ||
      target === "arty"
    ) {
      return 1.5;
    }
  } else if (attacker === "ac130") {
    if (isInfantry(target) || isVehicle(target) || isBuilding(target)) return 1.3;
  } else if (attacker === "gunboat" || attacker === "destroyer") {
    if (tDom === "air") return 1.35;
  } else if (attacker === "fpvdrone") {
    if (
      target === "tank" ||
      target === "himars" ||
      target === "railtank" ||
      target === "harvester" ||
      target === "supplytruck" ||
      target === "heavy" ||
      target === "arty"
    ) {
      return 1.45;
    }
  } else if (attacker === "shahed") {
    if (isBuilding(target)) return 1.4;
  } else if (attacker === "usv") {
    if (
      target === "destroyer" ||
      target === "dreadnought" ||
      target === "carrier" ||
      target === "gunboat" ||
      target === "sub" ||
      target === "shipyard" ||
      target === "shipyard2"
    ) {
      return 1.5;
    }
  }
  return 1;
};

const entityDist = (a: Ent, b: Ent) => {
  if (!isBuilding(b.k)) return dist(a.x, a.y, b.x, b.y);
  const bd = BUILDINGS[b.k];
  return Math.hypot(
    Math.max(0, Math.abs(a.x - b.x) - bd.w / 2),
    Math.max(0, Math.abs(a.y - b.y) - bd.h / 2),
  );
};
const weaponFxOf = (k: EntKind): WeaponFx => {
  if (k === "lasertower" || k === "satlink") return "laser";
  if (k === "railtank") return "railgun";
  if (k === "a10") return "brrrt";
  if (k === "tank" || k === "heavy" || k === "destroyer") return "cannon";
  if (k === "rocket" || k === "interceptor" || k === "sam" || k === "irondome" || k === "uav") return "rocket";
  if (k === "arty" || k === "ac130") return "arty";
  if (k === "arc") return "arc";
  if (k === "spider") return "melee";
  if (k === "dreadnought" || k === "himars" || k === "hypersonic" || k === "carrier" || k === "thaad" || k === "ballistic") return "missile";
  if (k === "sub") return "torpedo";
  if (k === "bomber" || k === "stealthbomber" || k === "zeppelin") return "bomb";
  return "bullet";
};
const weaponOf = (e: Ent) =>
  isBuilding(e.k)
    ? { range: BUILDINGS[e.k].range ?? 0, dmg: BUILDINGS[e.k].dmg ?? 0, rof: BUILDINGS[e.k].rof ?? 0 }
    : { range: UNITS[e.k as UnitKind].range, dmg: UNITS[e.k as UnitKind].dmg, rof: UNITS[e.k as UnitKind].rof };

// AC-130 gunship selectable guns — chosen by drive msg `wpn` slot while player-driven only.
// The UNITS.ac130 base def stays the AI/auto-attack profile; ammo cost unchanged (ammoCostOf).
const AC130_GUNS: readonly { name: string; dmg: number; rof: number; splash: number; fx: WeaponFx }[] = [
  { name: "105MM", dmg: 55, rof: 90, splash: 2.6, fx: "cannon" },
  { name: "40MM", dmg: 22, rof: 30, splash: 1.2, fx: "cannon" },
  { name: "25MM", dmg: 7, rof: 4, splash: 0.35, fx: "brrrt" },
];

export class World {
  readonly w: number;
  readonly h: number;
  tick = 0;
  map: MapId;
  config: GameConfig;
  winner: number | null = null;
  winnerTeam: number | null = null;
  ents = new Map<number, Ent>();
  players = new Map<number, P>(); // keyed by slot
  crates = new Map<number, CrateSnap>();
  events: GameEvent[] = [];

  private block: Uint8Array; // 1 = building footprint
  private cliff: Uint8Array; // 1 = impassable rocky cliff
  private water: Uint8Array; // 1 = navigable water
  private waterCount = 0;
  private bld: Int32Array; // ent id per tile
  private ore: Int16Array; // remaining per tile
  private nextId = 1;
  private nextCrateId = 1;
  private astarBudget = 12; // per-tick A* path budget to prevent Durable Object CPU exhaustion
  private lastAlert = new Map<number, number>(); // slot -> tick of last under-attack alert
  private gridCols: number;
  private gridRows: number;
  private grid: Ent[][]; // dynamic 8x8 tile spatial buckets
  private subDetMask = new Map<number, number>(); // sub ent id -> bitmask of slots that detect it this tick
  private gridTick = -1;
  private names: Record<number, string>;

  private idx(x: number, y: number): number {
    return y * this.w + x;
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  constructor(slots: number[], opts?: WorldOpts) {
    this.map = opts?.map ?? "crossroads";
    this.config = { ...DEFAULT_CONFIG, ...(opts?.config ?? {}) };
    this.names = opts?.names ? { ...opts.names } : {};
    const layout = getMapLayout(this.map);
    this.w = layout.w;
    this.h = layout.h;
    const area = this.w * this.h;
    this.block = new Uint8Array(area);
    this.cliff = new Uint8Array(area);
    this.water = new Uint8Array(area);
    this.bld = new Int32Array(area).fill(-1);
    this.ore = new Int16Array(area);
    this.gridCols = Math.ceil(this.w / 8);
    this.gridRows = Math.ceil(this.h / 8);
    this.grid = Array.from({ length: this.gridCols * this.gridRows }, () => []);

    for (const [cx, cy] of layout.cliffs) {
      if (this.inBounds(cx, cy)) this.cliff[this.idx(cx, cy)] = 1;
    }
    for (const [wx, wy] of layout.water) {
      if (this.inBounds(wx, wy)) {
        const i = this.idx(wx, wy);
        if (!this.cliff[i] && !this.water[i]) {
          this.water[i] = 1;
          this.waterCount++;
        }
      }
    }

    this.genOre(slots);

    const spawns = getSpawns(this.w, this.h);
    for (const slot of slots) {
      const s = spawns[slot];
      if (!s) continue;
      const rawTeam = opts?.teams?.[slot] ?? 0;
      const team = Number.isInteger(rawTeam) && rawTeam >= 1 && rawTeam <= 4 ? rawTeam : 0;
      this.players.set(slot, {
        slot,
        team,
        credits: this.config.startCredits,
        awaiting: null,
        bq: null,
        awaitingDef: null,
        dq: null,
        queues: {},
        eliminated: false,
        pwrHave: 0,
        pwrUse: 0,
        lowPower: false,
        swLeft: -1,
        reconLeft: -1,
        powerCutUntil: 0,
        radarScrambleUntil: 0,
        unitsBuilt: 0,
        unitsLost: 0,
        bldDestroyed: 0,
        creditsEarned: 0,
      });
      this.placeBuilding(slot, "conyard", s.x, s.y);
      // starting squad
      const spot = (dx: number, dy: number) =>
        nearestPassable(s.x + 1 + dx, s.y + 3 + dy, (x, y) => this.passable(x, y), 10, this.w, this.h) ?? {
          x: Math.max(0, Math.min(this.w - 1, s.x)),
          y: Math.max(0, Math.min(this.h - 1, s.y + 4)),
        };
      const t1 = spot(0, 0);
      const t2 = spot(2, 0);
      this.spawnUnit(slot, "tank", t1.x, t1.y);
      this.spawnUnit(slot, "tank", t2.x, t2.y);
      for (let i = 0; i < 3; i++) {
        const p = spot(i, 2);
        this.spawnUnit(slot, "infantry", p.x, p.y);
      }
      this.recomputePower(slot);
    }

    // Spawn neutral Oil Derricks & Coal Mines from map layout if enabled (clear any ore underneath)
    if (this.config.derricks) {
      for (const [dx, dy] of layout.derricks) {
        const dd = BUILDINGS.derrick;
        for (let y = dy; y < dy + dd.h; y++)
          for (let x = dx; x < dx + dd.w; x++) if (this.inBounds(x, y)) this.ore[this.idx(x, y)] = 0;
        this.placeBuilding(-1, "derrick", dx, dy);
      }
      for (const [cx, cy] of layout.coalmines ?? []) {
        const cd = BUILDINGS.coalmine;
        for (let y = cy; y < cy + cd.h; y++)
          for (let x = cx; x < cx + cd.w; x++) if (this.inBounds(x, y)) this.ore[this.idx(x, y)] = 0;
        this.placeBuilding(-1, "coalmine", cx, cy);
      }
    }
  }

  // ---------- persistence (DO restart survival) ----------

  // Plain structured-clone DTO of everything that can't be re-derived from the
  // map layout — ents/players are pure-data interfaces, ore is a typed array.
  serialize(): WorldSave {
    return {
      v: 1,
      map: this.map,
      config: this.config,
      tick: this.tick,
      winner: this.winner,
      winnerTeam: this.winnerTeam,
      nextId: this.nextId,
      nextCrateId: this.nextCrateId,
      names: { ...this.names },
      ents: [...this.ents.values()],
      players: [...this.players.values()],
      crates: [...this.crates.values()],
      ore: this.ore,
      lastAlert: [...this.lastAlert.entries()],
    };
  }

  static deserialize(d: WorldSave): World {
    const w = Object.create(World.prototype) as World;
    const layout = getMapLayout(d.map);
    w.map = d.map;
    w.config = d.config;
    (w as { w: number }).w = layout.w;
    (w as { h: number }).h = layout.h;
    const area = w.w * w.h;
    w.block = new Uint8Array(area);
    w.cliff = new Uint8Array(area);
    w.water = new Uint8Array(area);
    w.bld = new Int32Array(area).fill(-1);
    w.ore = d.ore;
    w.gridCols = Math.ceil(w.w / 8);
    w.gridRows = Math.ceil(w.h / 8);
    w.grid = Array.from({ length: w.gridCols * w.gridRows }, () => []);
    w.waterCount = 0;
    for (const [cx, cy] of layout.cliffs) {
      if (w.inBounds(cx, cy)) w.cliff[w.idx(cx, cy)] = 1;
    }
    for (const [wx, wy] of layout.water) {
      if (w.inBounds(wx, wy)) {
        const i = w.idx(wx, wy);
        if (!w.cliff[i] && !w.water[i]) {
          w.water[i] = 1;
          w.waterCount++;
        }
      }
    }
    w.tick = d.tick;
    w.winner = d.winner;
    w.winnerTeam = d.winnerTeam;
    w.nextCrateId = d.nextCrateId;
    w.names = { ...d.names };
    w.ents = new Map(d.ents.map((e) => [e.id, e]));
    w.players = new Map(d.players.map((p) => [p.slot, p]));
    w.crates = new Map(d.crates.map((c) => [c.id, c]));
    w.events = [];
    w.lastAlert = new Map(d.lastAlert);
    w.subDetMask = new Map();
    w.gridTick = -1;
    w.astarBudget = 12;
    w.oreTakenMap = null;
    let maxId = 0;
    for (const e of w.ents.values()) {
      if (e.id > maxId) maxId = e.id;
      // re-mark building footprints (block/bld) from live entities —
      // building e.x/e.y stores the footprint CENTER, so invert it
      if (isBuilding(e.k)) {
        const bd = BUILDINGS[e.k];
        const tx = Math.round(e.x - bd.w / 2),
          ty = Math.round(e.y - bd.h / 2);
        for (let y = ty; y < ty + bd.h; y++)
          for (let x = tx; x < tx + bd.w; x++)
            if (w.inBounds(x, y)) {
              const i = w.idx(x, y);
              w.block[i] = 1;
              w.bld[i] = e.id;
            }
      }
    }
    w.nextId = Math.max(d.nextId, maxId + 1);
    // arrow-function fields aren't prototype members — rebind them
    w.passable = (x: number, y: number) =>
      w.inBounds(x, y) && w.block[w.idx(x, y)] === 0 && w.cliff[w.idx(x, y)] === 0 && w.water[w.idx(x, y)] === 0;
    w.passableSea = (x: number, y: number) =>
      w.inBounds(x, y) && w.block[w.idx(x, y)] === 0 && w.cliff[w.idx(x, y)] === 0 && w.water[w.idx(x, y)] === 1;
    return w;
  }

  isAlly(slotA: number, slotB: number): boolean {
    if (slotA === slotB) return true;
    if (slotA < 0 || slotB < 0) return false;
    const a = this.players.get(slotA);
    const b = this.players.get(slotB);
    return !!(a && b && a.team > 0 && a.team === b.team);
  }

  getStats(names: Record<number, string> = {}): MatchStats[] {
    const out: MatchStats[] = [];
    for (const p of this.players.values()) {
      out.push({
        slot: p.slot,
        name: names[p.slot] ?? this.names[p.slot] ?? `Player ${p.slot + 1}`,
        team: p.team,
        unitsBuilt: p.unitsBuilt,
        unitsLost: p.unitsLost,
        bldDestroyed: p.bldDestroyed,
        creditsEarned: Math.floor(p.creditsEarned),
      });
    }
    out.sort((a, b) => a.slot - b.slot);
    return out;
  }

  private genOre(slots: number[]) {
    const spawns = getSpawns(this.w, this.h);
    const blob = (cx: number, cy: number, r: number) => {
      for (let y = Math.max(0, cy - r); y <= Math.min(this.h - 1, cy + r); y++)
        for (let x = Math.max(0, cx - r); x <= Math.min(this.w - 1, cx + r); x++) {
          const i = this.idx(x, y);
          if (this.cliff[i] || this.block[i] || this.water[i]) continue;
          const d = dist(x, y, cx, cy);
          if (d <= r && Math.random() > d / (r + 1)) {
            this.ore[i] = Math.min(ORE_CELL_MAX, 85 + ((Math.random() * 75) | 0));
          }
        }
    };
    for (const slot of slots) {
      const s = spawns[slot];
      if (!s) continue;
      const cx = s.x < this.w / 2 ? s.x + 8 : s.x - 6;
      const cy = s.y < this.h / 2 ? s.y + 9 : s.y - 7;
      blob(cx, cy, 3);
    }
    blob(Math.floor(this.w / 2), Math.floor(this.h / 2), 4); // contested center field
    for (const [cx, cy, r] of getMapLayout(this.map).extraOre ?? []) {
      blob(cx, cy, r);
    }
  }

  oreSnapshot(): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) if (this.ore[this.idx(x, y)] > 0) out.push([x, y, this.ore[this.idx(x, y)]]);
    return out;
  }

  hasWater(): boolean {
    return this.waterCount > 0;
  }

  isWater(x: number, y: number): boolean {
    const ix = Math.floor(x),
      iy = Math.floor(y);
    return this.inBounds(ix, iy) && this.water[this.idx(ix, iy)] === 1;
  }

  isStealthed(e: Ent): boolean {
    return (e.k === "sub" || e.k === "stealthbomber" || e.k === "usv") && this.tick >= e.subSurfaceUntil;
  }

  isSubmerged(e: Ent): boolean {
    return this.isStealthed(e);
  }

  private stealthDetectRadius(targetKind: EntKind, detectorKind: EntKind): number {
    if (targetKind === "stealthbomber") {
      // Without powered Radar-tier sensors, B-21 Phantom is completely invisible & untargetable
      if (detectorKind === "satlink") return 18;
      if (detectorKind === "thaad") return 15;
      return STEALTH_AIR_DETECTORS.has(detectorKind) ? 12 : 0;
    }
    if (targetKind === "usv") {
      return isSeaShip(detectorKind) || detectorKind === "radar" || detectorKind === "uav" ? 9 : 5.5;
    }
    if (targetKind === "spy") {
      // Disguised spy only blown by powered, unscrambled Radar-tier sensors
      return STEALTH_AIR_DETECTORS.has(detectorKind) ? 10 : 0;
    }
    return detectorKind === "gunboat" ||
      detectorKind === "destroyer" ||
      detectorKind === "sub" ||
      detectorKind === "carrier"
      ? 9
      : 5.5;
  }

  private rebuildSpatialGrid() {
    for (let i = 0; i < this.grid.length; i++) this.grid[i].length = 0;
    const stealthed: Ent[] = [];
    const spies: Ent[] = [];
    for (const e of this.ents.values()) {
      const gx = Math.max(0, Math.min(this.gridCols - 1, (e.x | 0) >> 3));
      const gy = Math.max(0, Math.min(this.gridRows - 1, (e.y | 0) >> 3));
      this.grid[gy * this.gridCols + gx].push(e);
      if (this.isStealthed(e)) stealthed.push(e);
      if (e.k === "spy" && this.tick >= e.spottedUntil) spies.push(e);
    }
    this.subDetMask.clear();
    // Precompute stealth detection bitmasks once per tick using spatial grid (eliminates O(N^3) rescans)
    for (const st of stealthed) {
      let mask = 0;
      const scanR = st.k === "stealthbomber" ? 18.5 : 9.5;
      const x0 = Math.max(0, ((st.x - scanR) | 0) >> 3);
      const x1 = Math.min(this.gridCols - 1, ((st.x + scanR) | 0) >> 3);
      const y0 = Math.max(0, ((st.y - scanR) | 0) >> 3);
      const y1 = Math.min(this.gridRows - 1, ((st.y + scanR) | 0) >> 3);
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const cell = this.grid[gy * this.gridCols + gx];
          for (let i = 0; i < cell.length; i++) {
            const u = cell[i];
            if (u.o < 0 || u.id === st.id) continue;
            const detectR = this.stealthDetectRadius(st.k, u.k);
            if (detectR <= 0) continue;
            if (STEALTH_AIR_DETECTORS.has(u.k)) {
              // Radar-tier sensors need power and are blinded while radar-scrambled
              const dp = this.players.get(u.o);
              if (dp && (dp.lowPower || this.tick < dp.radarScrambleUntil)) continue;
            }
            const dx = st.x - u.x,
              dy = st.y - u.y;
            if (dx * dx + dy * dy <= detectR * detectR) {
              // Mark u.o and all of u.o's allies as detecting this stealthed unit
              for (const p of this.players.values()) {
                if (this.isAlly(p.slot, u.o)) mask |= 1 << p.slot;
              }
            }
          }
        }
      }
      this.subDetMask.set(st.id, mask);
    }
    // Spy reveal scan: powered, unscrambled enemy Radar-tier sensors blow a disguised spy's cover
    for (const spy of spies) {
      const x0 = Math.max(0, ((spy.x - 10.5) | 0) >> 3);
      const x1 = Math.min(this.gridCols - 1, ((spy.x + 10.5) | 0) >> 3);
      const y0 = Math.max(0, ((spy.y - 10.5) | 0) >> 3);
      const y1 = Math.min(this.gridRows - 1, ((spy.y + 10.5) | 0) >> 3);
      let blown = false;
      outer: for (let gy = y0; gy <= y1 && !blown; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const cell = this.grid[gy * this.gridCols + gx];
          for (let i = 0; i < cell.length; i++) {
            const u = cell[i];
            if (u.o < 0 || !STEALTH_AIR_DETECTORS.has(u.k) || this.isAlly(spy.o, u.o)) continue;
            const dp = this.players.get(u.o);
            if (dp && (dp.lowPower || this.tick < dp.radarScrambleUntil)) continue;
            const dx = spy.x - u.x,
              dy = spy.y - u.y;
            if (dx * dx + dy * dy <= 100) {
              spy.spottedUntil = this.tick + SPY_REVEAL_TICKS;
              blown = true;
              break outer;
            }
          }
        }
      }
    }
    this.gridTick = this.tick;
  }

  isStealthDetected(target: Ent, viewerSlot: number): boolean {
    if (!this.isStealthed(target)) return true;
    if (this.gridTick === this.tick) {
      const mask = this.subDetMask.get(target.id);
      if (mask !== undefined) return (mask & (1 << viewerSlot)) !== 0;
    }
    for (const u of this.ents.values()) {
      if (u.o < 0 || !this.isAlly(viewerSlot, u.o)) continue;
      const detectR = this.stealthDetectRadius(target.k, u.k);
      if (detectR <= 0) continue;
      if (STEALTH_AIR_DETECTORS.has(u.k)) {
        const dp = this.players.get(u.o);
        if (dp && (dp.lowPower || this.tick < dp.radarScrambleUntil)) continue;
      }
      if (dist(target.x, target.y, u.x, u.y) <= detectR) return true;
    }
    return false;
  }

  isSubDetected(sub: Ent, viewerSlot: number): boolean {
    return this.isStealthDetected(sub, viewerSlot);
  }

  canAttack(attacker: Ent, target: Ent): boolean {
    if (this.isAlly(attacker.o, target.o)) return false;
    if (attacker.k === "engineer" || attacker.k === "spy") {
      return isBuilding(target.k);
    }
    const w = weaponOf(attacker);
    if (w.dmg <= 0 || w.range <= 0) return false;
    const tDom = domainOf(target.k);
    if (tDom === "air") {
      if (!canHitAirOf(attacker.k)) return false;
    } else {
      if (!canHitGroundOf(attacker.k)) return false;
    }
    if (this.isStealthed(target)) {
      if (!this.isStealthDetected(target, attacker.o)) return false;
    }
    return true;
  }

  passable = (x: number, y: number) =>
    this.inBounds(x, y) &&
    this.block[this.idx(x, y)] === 0 &&
    this.cliff[this.idx(x, y)] === 0 &&
    this.water[this.idx(x, y)] === 0;

  passableSea = (x: number, y: number) =>
    this.inBounds(x, y) &&
    this.block[this.idx(x, y)] === 0 &&
    this.cliff[this.idx(x, y)] === 0 &&
    this.water[this.idx(x, y)] === 1;

  footprint(kind: BuildingKind, tx: number, ty: number) {
    const d = BUILDINGS[kind];
    return { tx, ty, w: d.w, h: d.h };
  }
  footprintCenter(kind: BuildingKind, tx: number, ty: number) {
    const d = BUILDINGS[kind];
    return { x: tx + d.w / 2, y: ty + d.h / 2 };
  }

  private placeBuilding(slot: number, kind: BuildingKind, tx: number, ty: number) {
    const d = BUILDINGS[kind];
    const c = this.footprintCenter(kind, tx, ty);
    const e: Ent = {
      id: this.nextId++,
      o: slot,
      k: kind,
      x: c.x,
      y: c.y,
      hp: d.hp,
      mhp: d.hp,
      d: Math.PI / 2,
      order: null,
      orderQueue: [],
      path: null,
      cd: 0,
      cargo: 0,
      fuel: 100,
      ammo: 100,
      hstate: null,
      oreIdx: -1,
      repath: 0,
      agro: null,
      hold: false,
      holdUntil: 0,
      xp: 0,
      vet: 0,
      subSurfaceUntil: 0,
      interceptCd: 0,
      spottedUntil: 0,
      sabUntil: 0,
    };
    this.ents.set(e.id, e);
    for (let y = ty; y < ty + d.h; y++)
      for (let x = tx; x < tx + d.w; x++) {
        this.block[this.idx(x, y)] = 1;
        this.bld[this.idx(x, y)] = e.id;
      }
    return e;
  }

  private spawnUnit(slot: number, kind: UnitKind, x: number, y: number) {
    const d = UNITS[kind];
    const e: Ent = {
      id: this.nextId++,
      o: slot,
      k: kind,
      x: x + 0.5,
      y: y + 0.5,
      hp: d.hp,
      mhp: d.hp,
      d: Math.PI / 2,
      order: null,
      orderQueue: [],
      path: null,
      cd: 0,
      cargo: kind === "supplytruck" ? (d.capacity ?? 500) : 0,
      fuel: 100,
      ammo: 100,
      hstate: null,
      oreIdx: -1,
      repath: 0,
      agro: null,
      hold: false,
      holdUntil: 0,
      xp: 0,
      vet: 0,
      subSurfaceUntil: 0,
      interceptCd: 0,
      spottedUntil: 0,
      sabUntil: 0,
    };
    this.ents.set(e.id, e);
    this.events.push({ e: "spawn", id: e.id });
    return e;
  }

  private spawnNearBuilding(slot: number, kind: UnitKind, b: Ent) {
    const def = BUILDINGS[b.k as BuildingKind];
    const bx = b.x - def.w / 2,
      by = b.y - def.h / 2;
    const uDomain = UNITS[kind].domain;
    const occupied = (x: number, y: number) => {
      for (const u of this.ents.values())
        if (!isBuilding(u.k) && domainOf(u.k) === uDomain && Math.floor(u.x) === x && Math.floor(u.y) === y) return true;
      return false;
    };
    if (uDomain === "air") {
      // Air units spawn right over or around the airfield (ignoring buildings/cliffs/water)
      const cx = Math.floor(b.x),
        cy = Math.floor(b.y);
      for (let r = 0; r <= 6; r++) {
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = cx + dx,
              y = cy + dy;
            if (this.inBounds(x, y) && !occupied(x, y)) return this.spawnUnit(slot, kind, x, y);
          }
      }
      return this.spawnUnit(slot, kind, Math.max(0, Math.min(this.w - 1, cx)), Math.max(0, Math.min(this.h - 1, cy)));
    }
    if (uDomain === "sea") {
      // Sea units spawn on the nearest navigable water tile around the shipyard
      const cx = Math.floor(b.x),
        cy = Math.floor(b.y);
      for (let r = 1; r <= 8; r++) {
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = cx + dx,
              y = cy + dy;
            if (this.passableSea(x, y) && !occupied(x, y)) return this.spawnUnit(slot, kind, x, y);
          }
      }
      const spot = nearestPassable(cx, cy, (x, y) => this.passableSea(x, y) && !occupied(x, y), 14, this.w, this.h);
      if (spot) return this.spawnUnit(slot, kind, spot.x, spot.y);
      return null;
    }
    // Land: first empty passable tile on an expanding ring below the building
    for (let r = 1; r <= 6; r++) {
      for (let dy = -1; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const x = bx + (def.w >> 1) + dx,
            y = by + def.h + dy;
          if (this.passable(x, y) && !occupied(x, y)) return this.spawnUnit(slot, kind, x, y);
        }
    }
    const spot = nearestPassable(
      bx + (def.w >> 1),
      by + def.h + 1,
      (x, y) => this.passable(x, y) && !occupied(x, y),
      12,
      this.w,
      this.h,
    );
    if (spot) return this.spawnUnit(slot, kind, spot.x, spot.y);
    return null;
  }

  // ---------- commands ----------

  canPlace(slot: number, kind: BuildingKind, tx: number, ty: number): string | null {
    const d = BUILDINGS[kind];
    if (tx < 0 || ty < 0 || tx + d.w > this.w || ty + d.h > this.h) return "off map";
    for (let y = ty; y < ty + d.h; y++)
      for (let x = tx; x < tx + d.w; x++) {
        const i = this.idx(x, y);
        if (this.cliff[i]) return "blocked by terrain";
        if (this.block[i]) return "blocked";
        if (d.waterOnly) {
          if (!this.water[i]) return "must build on water";
        } else {
          if (this.water[i]) return "can't build on water";
          if (this.ore[i] > 0) return "can't build on ore";
        }
      }
    // no same-domain units standing inside the footprint (aircraft overhead don't block construction)
    const bDomain: UnitDomain = d.waterOnly ? "sea" : "land";
    for (const u of this.ents.values()) {
      if (isBuilding(u.k)) continue;
      if (domainOf(u.k) !== bDomain) continue;
      const ux = Math.floor(u.x),
        uy = Math.floor(u.y);
      if (ux >= tx && ux < tx + d.w && uy >= ty && uy < ty + d.h) return "units in the way";
    }
    // adjacency: own building within gap <= 2 (or SHIPYARD_BUILD_DIST for waterOnly, or forwardRange for Forward Supply Hubs)
    const maxGap = d.waterOnly ? SHIPYARD_BUILD_DIST : (d.forwardRange ?? 2);
    for (const b of this.ents.values()) {
      if (b.o !== slot || !isBuilding(b.k)) continue;
      const bd = BUILDINGS[b.k];
      const bx = b.x - bd.w / 2,
        by = b.y - bd.h / 2;
      const gapX = Math.max(bx - (tx + d.w), tx - (bx + bd.w));
      const gapY = Math.max(by - (ty + d.h), ty - (by + bd.h));
      if (Math.max(gapX, gapY) <= maxGap) return null;
    }
    return d.waterOnly || d.forwardRange ? "too far from base" : "must build next to your base";
  }

  cmdOrder(slot: number, ids: number[], kind: OrderKind, x: number, y: number, target?: number, queue = false): string | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return "bad order";
    if (kind !== "move" && kind !== "amove" && kind !== "attack" && kind !== "harvest" && kind !== "patrol") return "bad order";
    if (!this.inBounds(Math.floor(x), Math.floor(y))) return "off map";
    const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
    const rows = Math.max(1, Math.ceil(ids.length / cols));
    let n = 0;
    for (const [i, id] of ids.entries()) {
      const e = this.ents.get(id);
      if (!e || e.o !== slot || isBuilding(e.k)) continue;
      // unarmed units can't take attack orders; harvesters also ignore amove/patrol, while ewdrone & supplytruck can move/amove/patrol smoothly
      const isSupportMover = e.k === "ewdrone" || e.k === "supplytruck";
      if (kind === "attack" && weaponOf(e).dmg <= 0 && e.k !== "engineer" && e.k !== "spy") continue;
      if ((kind === "amove" || kind === "patrol") && weaponOf(e).dmg <= 0 && e.k !== "engineer" && e.k !== "spy" && !isSupportMover) continue;
      // spread group destinations on a dynamic grid so large groups don't stack on one tile
      const ox = kind === "attack" || kind === "harvest" ? 0 : ((i % cols) - (cols - 1) / 2) * 1.15;
      const oy = kind === "attack" || kind === "harvest" ? 0 : (Math.floor(i / cols) - (rows - 1) / 2) * 1.15;
      const gx = Math.max(0.5, Math.min(this.w - 0.5, x + ox));
      const gy = Math.max(0.5, Math.min(this.h - 0.5, y + oy));

      let ord: Order | null = null;
      let hstate: Ent["hstate"] = null;
      let oreIdx = -1;

      if (kind === "harvest" && e.k !== "harvester") {
        // escorting units in a mixed group follow along as a plain move
        ord = { kind: "move", x: gx, y: gy };
      } else if (kind === "attack") {
        const tgt = Number.isFinite(target) ? this.ents.get(target as number) : null;
        if (!tgt || !this.canAttack(e, tgt)) continue;
        ord = { kind, x: tgt.x, y: tgt.y, target };
      } else if (kind === "harvest") {
        const t = this.idx(Math.floor(x), Math.floor(y));
        if (this.ore[t] > 0) {
          ord = { kind, x, y };
          hstate = "toOre";
          oreIdx = t;
        } else {
          // right-clicked own refinery with cargo
          const bid = this.bld[t];
          const b = bid >= 0 ? this.ents.get(bid) : null;
          if (!b || b.o !== slot || b.k !== "refinery") continue;
          ord = { kind, x, y };
          hstate = "toRef";
        }
      } else if (kind === "patrol") {
        ord = { kind, x: gx, y: gy, patrolFrom: [e.x, e.y] };
      } else {
        ord = { kind, x: gx, y: gy };
      }

      if (!ord) continue;
      e.hold = false;
      if (queue && e.order) {
        if (e.orderQueue.length < MAX_WAYPOINTS) e.orderQueue.push(ord);
        n++;
        continue;
      }
      e.orderQueue = [];
      e.order = ord;
      e.agro = null;
      if (e.k === "harvester") {
        if (ord.kind === "harvest") {
          e.hstate = hstate;
          if (oreIdx >= 0) e.oreIdx = oreIdx;
        } else {
          // explicit order beats hauling — pause auto-harvest so the move is honored
          e.hstate = null;
          e.holdUntil = this.tick + 150;
        }
      }
      e.path = null;
      e.repath = 0;
      n++;
    }
    return n ? null : "nothing to order";
  }

  private advanceOrder(e: Ent) {
    e.order = null;
    e.path = null;
    e.repath = 0;
    e.agro = null;
    while (e.orderQueue.length) {
      const next = e.orderQueue.shift()!;
      if (next.kind === "attack" && next.target != null) {
        const tgt = this.ents.get(next.target);
        if (!tgt || !this.canAttack(e, tgt)) continue;
      }
      if (next.kind === "harvest" && e.k === "harvester") {
        const t = this.idx(Math.floor(next.x), Math.floor(next.y));
        if (this.ore[t] > 0) {
          e.hstate = "toOre";
          e.oreIdx = t;
        } else {
          const bid = this.bld[t];
          const b = bid >= 0 ? this.ents.get(bid) : null;
          if (!b || b.o !== e.o || b.k !== "refinery") continue;
          e.hstate = "toRef";
        }
      } else if (e.k === "harvester") {
        e.hstate = null;
        e.holdUntil = this.tick + 150;
      }
      e.order = next;
      return;
    }
  }

  cmdStop(slot: number, ids: number[]) {
    for (const id of ids) {
      const e = this.ents.get(id);
      if (!e || e.o !== slot || isBuilding(e.k)) continue;
      e.order = null;
      e.orderQueue = [];
      e.path = null;
      e.hstate = null;
      e.agro = null;
      e.holdUntil = this.tick + 150; // don't auto-resume hauling right after a stop
    }
  }

  cmdHold(slot: number, ids: number[]) {
    const valid: Ent[] = [];
    for (const id of ids) {
      const e = this.ents.get(id);
      if (!e || e.o !== slot || isBuilding(e.k)) continue;
      valid.push(e);
    }
    if (!valid.length) return;
    const enable = valid.some((e) => !e.hold);
    for (const e of valid) {
      e.hold = enable;
      if (enable) {
        e.order = null;
        e.orderQueue = [];
        e.path = null;
        e.agro = null;
        if (e.k === "harvester") {
          e.hstate = null;
          e.holdUntil = this.tick + 150;
        }
      }
    }
  }

  cmdDrive(
    slot: number,
    id: number,
    fwd: number,
    strafe: number,
    yaw: number,
    fire: boolean,
    aimX?: number,
    aimY?: number,
    aimTarget?: number,
    alt?: number,
    sprint?: boolean,
    wpn?: number,
    lock?: number,
  ): string | null {
    if (!Number.isFinite(id) || !Number.isFinite(fwd) || !Number.isFinite(strafe) || !Number.isFinite(yaw)) {
      return "bad drive";
    }
    const e = this.ents.get(id);
    if (!e || e.o !== slot || isBuilding(e.k)) return "can't drive that";
    const cfwd = Math.max(-1, Math.min(1, fwd));
    const cstrafe = Math.max(-1, Math.min(1, strafe));
    e.order = null;
    e.orderQueue = [];
    e.path = null;
    e.hold = false;
    e.agro = null;
    e.hstate = null;
    e.holdUntil = this.tick + 120;
    e.direct = {
      until: this.tick + 14,
      fwd: cfwd,
      strafe: cstrafe,
      yaw,
      fire: !!fire,
      aimX: Number.isFinite(aimX) ? aimX! : e.x + Math.cos(yaw) * 6,
      aimY: Number.isFinite(aimY) ? aimY! : e.y + Math.sin(yaw) * 6,
      aimTarget: Number.isFinite(aimTarget) ? aimTarget : undefined,
      alt: Number.isFinite(alt) ? Math.max(-1, Math.min(1, alt!)) : undefined,
      sprint: !!sprint,
      wpn: Number.isFinite(wpn) ? Math.max(0, Math.min(2, Math.round(wpn!))) : undefined,
      lock: Number.isFinite(lock) ? lock : undefined,
    };
    if (domainOf(e.k) === "air" && e.fpvAlt === undefined) e.fpvAlt = 0.6; // lazy cruise alt on first takeover
    return null;
  }

  cmdDriveExit(slot: number, id: number): void {
    const e = this.ents.get(id);
    if (e && e.o === slot) {
      delete e.direct;
      delete e.fpvAlt;
    }
  }

  private buildingCostBasis(k: BuildingKind): number {
    for (const path of Object.values(UPGRADE_PATHS)) {
      if (path.to === k) return this.buildingCostBasis(path.from) + path.cost;
    }
    return BUILDINGS[k].cost;
  }

  cmdBuild(slot: number, kind: BuildingKind): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    if (!hasOwn(BUILDINGS, kind)) return "unknown building";
    const d = BUILDINGS[kind];
    if (d.noBuild) return "can't build that";
    const cat = buildCategoryOf(kind);
    if (cat === "defense") {
      if (p.dq || p.awaitingDef) return "construction in progress";
    } else {
      if (p.bq || p.awaiting) return "construction in progress";
    }
    if (kind === "superweapon" && !this.config.superweapons) return "superweapons disabled";
    if (d.waterOnly && !this.hasWater()) return "no water on this map";
    if (d.requires) for (const r of d.requires) if (!this.hasBuilding(slot, r)) return `need a ${r}`;
    if (d.limit != null) {
      let count = 0;
      for (const e of this.ents.values()) if (e.o === slot && e.k === kind) count++;
      if (count >= d.limit) return "limit reached";
    }
    if (p.credits < d.cost) return "insufficient funds";
    if (!this.hasBuilding(slot, "conyard")) return "need a construction yard";
    p.credits -= d.cost;
    if (cat === "defense") {
      p.dq = { kind, left: d.buildTicks, total: d.buildTicks };
    } else {
      p.bq = { kind, left: d.buildTicks, total: d.buildTicks };
    }
    return null;
  }

  cmdBuildCancel(slot: number, cat?: BuildCategory) {
    const p = this.players.get(slot);
    if (!p) return;
    if (cat === "defense") {
      if (p.dq) {
        p.credits += BUILDINGS[p.dq.kind].cost;
        p.dq = null;
      } else if (p.awaitingDef) {
        p.credits += BUILDINGS[p.awaitingDef].cost;
        p.awaitingDef = null;
      }
      return;
    }
    if (cat === "structure") {
      if (p.bq) {
        p.credits += BUILDINGS[p.bq.kind].cost;
        p.bq = null;
      } else if (p.awaiting) {
        p.credits += BUILDINGS[p.awaiting].cost;
        p.awaiting = null;
      }
      return;
    }
    if (p.bq) {
      p.credits += BUILDINGS[p.bq.kind].cost;
      p.bq = null;
    } else if (p.awaiting) {
      p.credits += BUILDINGS[p.awaiting].cost;
      p.awaiting = null;
    } else if (p.dq) {
      p.credits += BUILDINGS[p.dq.kind].cost;
      p.dq = null;
    } else if (p.awaitingDef) {
      p.credits += BUILDINGS[p.awaitingDef].cost;
      p.awaitingDef = null;
    }
  }

  cmdSell(slot: number, id: number): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    const e = this.ents.get(id);
    if (!e || e.o !== slot || !isBuilding(e.k)) return "can't sell that";
    const basis = this.buildingCostBasis(e.k);
    p.credits += Math.floor(basis * 0.5);
    this.destroy(e);
    return null;
  }

  cmdRepair(slot: number, id: number): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    const e = this.ents.get(id);
    if (!e || e.o !== slot || !isBuilding(e.k)) return "can't repair that";
    if (e.hp >= e.mhp) return "already at full health";
    const basis = this.buildingCostBasis(e.k);
    const cost = Math.ceil(basis * 0.25);
    if (p.credits < cost) return "insufficient funds";
    p.credits -= cost;
    e.hp = e.mhp;
    if (BUILDINGS[e.k].power > 0) this.recomputePower(slot);
    return null;
  }

  cmdUpgrade(slot: number, id: number): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    const e = this.ents.get(id);
    if (!e || e.o !== slot || !isBuilding(e.k)) return "can't upgrade that";
    const path = hasOwn(UPGRADE_PATHS, e.k) ? UPGRADE_PATHS[e.k] : null;
    if (!path) return "can't upgrade that";
    if (p.credits < path.cost) return "insufficient funds";
    if (!this.hasBuilding(slot, path.requires)) return `need a ${path.requires}`;
    p.credits -= path.cost;
    const oldMhp = e.mhp;
    e.k = path.to;
    e.mhp = BUILDINGS[path.to].hp;
    e.hp = Math.min(e.mhp, e.hp + Math.max(250, e.mhp - oldMhp));
    this.recomputePower(slot);
    return null;
  }

  cmdRally(slot: number, id: number, x: number, y: number): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    if (!Number.isFinite(x) || !Number.isFinite(y)) return "bad coords";
    if (!this.inBounds(Math.floor(x), Math.floor(y))) return "off map";
    const e = this.ents.get(id);
    if (
      !e ||
      e.o !== slot ||
      (e.k !== "barracks" &&
        e.k !== "barracks2" &&
        e.k !== "factory" &&
        e.k !== "factory2" &&
        e.k !== "airfield" &&
        e.k !== "airfield2" &&
        e.k !== "shipyard" &&
        e.k !== "shipyard2")
    ) {
      return "can't set rally";
    }
    e.rally = [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
    return null;
  }

  cmdSuperweapon(slot: number, x: number, y: number): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    if (!Number.isFinite(x) || !Number.isFinite(y)) return "bad coords";
    if (!this.inBounds(Math.floor(x), Math.floor(y))) return "off map";
    if (!this.hasBuilding(slot, "superweapon")) return "need a superweapon";
    if (p.lowPower) return "low power";
    if (p.swLeft > 0 || p.swLeft < 0) return "superweapon charging";
    p.swLeft = SW_CHARGE_TICKS;
    // Exo-atmospheric THAAD Nuclear ICBM interception scan (80% stop chance per ready THAAD in range!)
    const readyThaads: { ent: Ent; d: number }[] = [];
    for (const e of this.ents.values()) {
      if (e.k !== "thaad" || e.o < 0 || e.hp <= 0 || e.interceptCd > 0) continue;
      if (this.isAlly(slot, e.o)) continue;
      const owner = this.players.get(e.o);
      if (!owner || owner.eliminated || owner.lowPower) continue;
      const d = dist(e.x, e.y, x, y);
      if (d <= THAAD_NUKE_RADIUS) readyThaads.push({ ent: e, d });
    }
    readyThaads.sort((a, b) => a.d - b.d);
    for (const { ent: thaad } of readyThaads) {
      thaad.interceptCd = THAAD_NUKE_CD;
      this.face(thaad, x, y);
      if (Math.random() < 0.8) {
        this.events.push({ e: "nukeIntercept", fx: thaad.x, fy: thaad.y, tx: x, ty: y, slot: thaad.o });
        return null;
      }
    }
    for (const e of [...this.ents.values()]) {
      if (!this.ents.has(e.id)) continue;
      if (this.isAlly(slot, e.o)) continue;
      const d = dist(x, y, e.x, e.y);
      if (d > SW_RADIUS) continue;
      const falloff = Math.max(0.25, 1 - (d / SW_RADIUS) * 0.75);
      e.hp -= SW_DAMAGE * falloff;
      this.events.push({ e: "hit", id: e.id });
      if (e.o >= 0) this.alertVictim(e.o, e.x, e.y);
      if (e.hp <= 0) this.destroy(e, slot);
      else if (isBuilding(e.k) && BUILDINGS[e.k].power > 0) this.recomputePower(e.o);
    }
    this.events.push({ e: "superweapon", x, y, slot });
    this.events.push({ e: "boom", x, y, r: SW_RADIUS });
    return null;
  }

  cmdRecon(slot: number, x: number, y: number): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    if (!Number.isFinite(x) || !Number.isFinite(y)) return "bad coords";
    if (!this.inBounds(Math.floor(x), Math.floor(y))) return "off map";
    if (!this.hasBuilding(slot, "radar")) return "need a radar";
    if (p.lowPower) return "low power";
    if (p.reconLeft > 0 || p.reconLeft < 0) return "recon charging";
    p.reconLeft = RECON_CHARGE_TICKS;
    this.events.push({ e: "recon", x, y, slot, r: RECON_RADIUS });
    return null;
  }

  cmdResign(slot: number) {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return;
    for (const e of [...this.ents.values()]) if (e.o === slot) this.destroy(e);
    // checkEnd picks up the elimination next tick
  }

  cmdPlace(slot: number, tx: number, ty: number, cat?: BuildCategory): string | null {
    const p = this.players.get(slot);
    if (!p) return "nothing to place";
    const useDef = cat === "defense" ? true : cat === "structure" ? false : !p.awaiting && !!p.awaitingDef;
    const kind = useDef ? p.awaitingDef : p.awaiting;
    if (!kind) return "nothing to place";
    const err = this.canPlace(slot, kind, tx, ty);
    if (err) return err;
    if (useDef) p.awaitingDef = null;
    else p.awaiting = null;
    const b = this.placeBuilding(slot, kind, tx, ty);
    this.recomputePower(slot);
    if (kind === "refinery") {
      if (this.spawnNearBuilding(slot, "harvester", b)) p.unitsBuilt++;
    } else if (kind === "superweapon" && p.swLeft < 0) {
      p.swLeft = SW_CHARGE_TICKS;
    } else if (kind === "radar" && p.reconLeft < 0) {
      p.reconLeft = 150;
    }
    return null;
  }

  cmdTrain(slot: number, unit: UnitKind): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    if (!hasOwn(UNITS, unit)) return "unknown unit";
    const d = UNITS[unit];
    if (!this.hasBuilding(slot, d.trainsAt)) return `need a ${d.trainsAt}`;
    if (d.requires && !this.hasBuilding(slot, d.requires)) return `need a ${d.requires}`;
    if (p.credits < d.cost) return "insufficient funds";
    const q = p.queues[d.trainsAt];
    if (q && q.unit !== unit) return "queue busy";
    if (q && q.count >= 9) return "queue full";
    p.credits -= d.cost;
    if (q) q.count++;
    else p.queues[d.trainsAt] = { unit, left: d.buildTicks, total: d.buildTicks, count: 1 };
    return null;
  }

  cmdTrainCancel(slot: number, unit: UnitKind): void {
    const p = this.players.get(slot);
    if (!p || !hasOwn(UNITS, unit)) return;
    const d = UNITS[unit];
    const q = p.queues[d.trainsAt];
    if (!q || q.unit !== unit) return;
    p.credits += d.cost;
    if (--q.count === 0) delete p.queues[d.trainsAt];
  }

  // engineer takes over an enemy building or neutral Oil Derrick once it reaches the footprint edge.
  // distance is measured to the edge, not the center, or 3x3 buildings
  // (conyard/factory/techlab) would stay unreachable.
  private tryCapture(e: Ent, tgt: Ent, maxRange = CAPTURE_RANGE): boolean {
    if (e.k !== "engineer" || !isBuilding(tgt.k) || this.isAlly(e.o, tgt.o)) return false;
    const bd = BUILDINGS[tgt.k];
    const edgeDist = Math.hypot(
      Math.max(0, Math.abs(e.x - tgt.x) - bd.w / 2),
      Math.max(0, Math.abs(e.y - tgt.y) - bd.h / 2)
    );
    if (edgeDist > maxRange) return false;
    const prev = tgt.o;
    tgt.o = e.o;
    this.recomputePower(prev);
    this.recomputePower(e.o);
    if (tgt.k === "derrick") {
      const p = this.players.get(e.o);
      if (p) {
        p.credits += DERRICK_CAPTURE_BONUS;
        p.creditsEarned += DERRICK_CAPTURE_BONUS;
      }
      this.events.push({ e: "income", x: tgt.x, y: tgt.y, amt: DERRICK_CAPTURE_BONUS, slot: e.o });
    } else if (tgt.k === "coalmine") {
      const p = this.players.get(e.o);
      if (p) {
        p.credits += COALMINE_CAPTURE_BONUS;
        p.creditsEarned += COALMINE_CAPTURE_BONUS;
      }
      this.events.push({ e: "income", x: tgt.x, y: tgt.y, amt: COALMINE_CAPTURE_BONUS, slot: e.o });
    }
    this.events.push({ e: "cap", x: tgt.x, y: tgt.y, slot: e.o });
    this.destroy(e);
    return true;
  }

  private trySabotage(e: Ent, tgt: Ent, maxRange = SPY_CAPTURE_RANGE): boolean {
    if (e.k !== "spy" || !isBuilding(tgt.k) || this.isAlly(e.o, tgt.o)) return false;
    const bd = BUILDINGS[tgt.k];
    const edgeDist = Math.hypot(
      Math.max(0, Math.abs(e.x - tgt.x) - bd.w / 2),
      Math.max(0, Math.abs(e.y - tgt.y) - bd.h / 2)
    );
    if (edgeDist > maxRange) return false;
    const vp = this.players.get(tgt.o);
    const sp = this.players.get(e.o);
    const steal = (amt: number) => {
      if (!vp || !sp) return;
      const s = Math.min(vp.credits, amt);
      vp.credits -= s;
      sp.credits += s;
      sp.creditsEarned += s;
      if (s > 0) this.events.push({ e: "income", x: tgt.x, y: tgt.y, amt: s, slot: e.o });
    };
    switch (tgt.k) {
      case "power":
      case "coalplant":
      case "fusion":
        // Black out the enemy grid for 30 seconds
        if (vp) {
          vp.powerCutUntil = this.tick + SPY_POWERCUT_TICKS;
          this.recomputePower(tgt.o);
        }
        break;
      case "turret":
      case "sam":
      case "arc":
      case "irondome":
      case "lasertower":
      case "thaad":
        // Sabotage the battery — it cannot fire or intercept for 45 seconds
        tgt.sabUntil = this.tick + SPY_DISABLE_TICKS;
        break;
      case "radar":
      case "satlink":
        // Scramble enemy sensors — Radar-tier stealth detection blinded for 30 seconds
        if (vp) vp.radarScrambleUntil = this.tick + SPY_RADAR_SCRAMBLE_TICKS;
        break;
      case "superweapon":
        // Plant a virus — restart their superweapon charge from zero
        if (vp && vp.swLeft >= 0) vp.swLeft = SW_CHARGE_TICKS;
        break;
      case "barracks":
      case "barracks2":
      case "factory":
      case "factory2":
      case "airfield":
      case "airfield2":
      case "shipyard":
      case "shipyard2":
        // Corrupt the production line — wipe active build queues
        if (vp) {
          vp.bq = null;
          vp.dq = null;
        }
        break;
      case "refinery":
      case "purifier":
        steal(Math.round(Math.max(500, (vp?.credits ?? 0) * 0.4)));
        break;
      case "techlab":
        steal(1200);
        break;
      case "conyard":
        steal(2000);
        break;
      default:
        steal(800);
        break;
    }
    this.events.push({ e: "sabotage", x: tgt.x, y: tgt.y, slot: e.o, vslot: tgt.o, kind: tgt.k });
    this.destroy(e);
    return true;
  }

  private hasBuilding(slot: number, kind: BuildingKind) {
    const upg = UPGRADED_OF[kind];
    for (const e of this.ents.values()) {
      if (e.o !== slot) continue;
      if (e.k === kind || (upg !== undefined && e.k === upg)) return true;
      if (kind === "power" && (e.k === "coalplant" || e.k === "fusion")) return true;
    }
    return false;
  }

  private buildingsOf(slot: number, kind: BuildingKind) {
    const upg = UPGRADED_OF[kind];
    const out: Ent[] = [];
    for (const e of this.ents.values())
      if (e.o === slot && (e.k === kind || (upg !== undefined && e.k === upg))) out.push(e);
    return out;
  }

  private prodBoostOf(slot: number, cat: ProdCat): number {
    const cnt = this.buildingsOf(slot, cat).length;
    return Math.min(2.0, 1 + Math.max(0, cnt - 1) * 0.25);
  }

  private recomputePower(slot: number) {
    const p = this.players.get(slot);
    if (!p) return;
    let have = 0,
      use = 0;
    for (const e of this.ents.values()) {
      if (e.o !== slot || !isBuilding(e.k)) continue;
      const pw = BUILDINGS[e.k].power;
      if (pw > 0) {
        have += e.hp < e.mhp ? Math.round(pw * (0.35 + 0.65 * Math.max(0, e.hp / e.mhp))) : pw;
      } else {
        use -= pw;
      }
    }
    if (this.tick < p.powerCutUntil) have = 0; // spy sabotage blackout
    p.pwrHave = have;
    p.pwrUse = use;
    p.lowPower = use > have;
  }

  // ---------- tick ----------

  step() {
    this.tick++;
    this.astarBudget = 12;
    this.oreTakenMap = null;
    this.tickProduction();
    this.rebuildSpatialGrid();
    for (const e of [...this.ents.values()]) {
      if (this.ents.has(e.id)) this.tickEnt(e);
    }
    this.rebuildSpatialGrid();
    this.separate();
    if (this.tick % 5 === 0) this.tickEwJamming();
    this.tickCrates();
    if (this.tick % 10 === 0) {
      this.tickDepots();
      this.tickDerricks();
      this.tickVetRegen();
      this.tickLogistics();
    }
    if (this.tick % ORE_REGEN_TICKS === 0) this.regenOre();
    this.checkEnd();
  }

  private tickEwJamming() {
    for (const e of [...this.ents.values()]) {
      if (isBuilding(e.k) || e.o < 0 || !this.ents.has(e.id)) continue;
      const jamR = UNITS[e.k].ewJamRadius;
      if (!jamR || jamR <= 0) continue;
      const r2 = jamR * jamR;
      const pad = jamR + 1;
      const x0 = Math.max(0, Math.floor(e.x - pad) >> 3);
      const x1 = Math.min(this.gridCols - 1, Math.floor(e.x + pad) >> 3);
      const y0 = Math.max(0, Math.floor(e.y - pad) >> 3);
      const y1 = Math.min(this.gridRows - 1, Math.floor(e.y + pad) >> 3);

      const candidates: { ent: Ent; d2: number }[] = [];
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const cell = this.grid[gy * this.gridCols + gx];
          for (let i = 0; i < cell.length; i++) {
            const t = cell[i];
            if (t.o < 0 || this.isAlly(e.o, t.o) || !this.ents.has(t.id)) continue;
            if (!JAMMABLE_DRONES.has(t.k)) continue;
            const tp = this.players.get(t.o);
            if (!tp || tp.eliminated) continue;
            const dx = t.x - e.x,
              dy = t.y - e.y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= r2) candidates.push({ ent: t, d2 });
          }
        }
      }
      if (!candidates.length) continue;
      candidates.sort((a, b) => a.d2 - b.d2);
      const maxTargets = Math.min(2, candidates.length);
      for (let i = 0; i < maxTargets; i++) {
        const t = candidates[i].ent;
        if (!this.ents.has(t.id)) continue;
        t.hp -= 65;
        this.events.push({ e: "ewjam", fx: e.x, fy: e.y, tx: t.x, ty: t.y, slot: e.o });
        this.events.push({ e: "hit", id: t.id });
        this.alertVictim(t.o, t.x, t.y);
        if (t.hp <= 0) {
          this.grantXp(e, t.mhp * 0.8);
          this.events.push({ e: "kill", src: e.id, id: t.id, x: t.x, y: t.y });
          this.destroy(t, e.o);
        } else {
          this.grantXp(e, 32);
        }
      }
    }
  }

  private tickLogistics() {
    if (this.config.logistics === false) return;
    const hubsAndBases: Ent[] = [];
    const trucks: Ent[] = [];
    for (const e of this.ents.values()) {
      if (e.o < 0) continue;
      if (e.k === "supplyhub" || BASE_SUPPLY_PROVIDERS.has(e.k)) hubsAndBases.push(e);
      else if (e.k === "supplytruck" && e.cargo > 0) trucks.push(e);
    }

    const truckCap = UNITS.supplytruck.capacity ?? 500;
    // Pass 1: Forward Supply Hubs & Base Structures/Carriers refill fuel, ammo, truck cargo (+ hub repair aura)
    for (const src of hubsAndBases) {
      const isHub = src.k === "supplyhub";
      const r = isHub ? SUPPLY_HUB_RADIUS : BASE_SUPPLY_RADIUS;
      const r2 = r * r;
      const pad = r + 1;
      const x0 = Math.max(0, Math.floor(src.x - pad) >> 3);
      const x1 = Math.min(this.gridCols - 1, Math.floor(src.x + pad) >> 3);
      const y0 = Math.max(0, Math.floor(src.y - pad) >> 3);
      const y1 = Math.min(this.gridRows - 1, Math.floor(src.y + pad) >> 3);
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const cell = this.grid[gy * this.gridCols + gx];
          for (let i = 0; i < cell.length; i++) {
            const u = cell[i];
            if (isBuilding(u.k) || !this.isAlly(src.o, u.o)) continue;
            const dx = src.x - u.x,
              dy = src.y - u.y;
            if (dx * dx + dy * dy > r2) continue;
            if (u.fuel < 100) u.fuel = Math.min(100, u.fuel + 22);
            if (u.ammo < 100) u.ammo = Math.min(100, u.ammo + 26);
            if (u.k === "supplytruck" && u.cargo < truckCap) {
              u.cargo = Math.min(truckCap, u.cargo + 120);
            }
            if (isHub && u.hp < u.mhp) {
              u.hp = Math.min(u.mhp, u.hp + 2);
            }
          }
        }
      }
    }

    // Pass 2: Mobile Logistics Supply Convoys refill nearby friendly units from onboard cargo
    const trR2 = SUPPLY_TRUCK_RADIUS * SUPPLY_TRUCK_RADIUS;
    const trPad = SUPPLY_TRUCK_RADIUS + 1;
    for (const tr of trucks) {
      if (tr.cargo <= 0) continue;
      const x0 = Math.max(0, Math.floor(tr.x - trPad) >> 3);
      const x1 = Math.min(this.gridCols - 1, Math.floor(tr.x + trPad) >> 3);
      const y0 = Math.max(0, Math.floor(tr.y - trPad) >> 3);
      const y1 = Math.min(this.gridRows - 1, Math.floor(tr.y + trPad) >> 3);
      for (let gy = y0; gy <= y1 && tr.cargo > 0; gy++) {
        for (let gx = x0; gx <= x1 && tr.cargo > 0; gx++) {
          const cell = this.grid[gy * this.gridCols + gx];
          for (let i = 0; i < cell.length && tr.cargo > 0; i++) {
            const u = cell[i];
            if (u.id === tr.id || isBuilding(u.k) || u.k === "supplytruck" || !this.isAlly(tr.o, u.o)) continue;
            const dx = tr.x - u.x,
              dy = tr.y - u.y;
            if (dx * dx + dy * dy > trR2) continue;
            if (u.fuel < 100 && tr.cargo > 0) {
              const give = Math.min(18, 100 - u.fuel, tr.cargo);
              if (give > 0) {
                u.fuel += give;
                tr.cargo -= give;
              }
            }
            if (u.ammo < 100 && tr.cargo > 0) {
              const give = Math.min(22, 100 - u.ammo, tr.cargo);
              if (give > 0) {
                u.ammo += give;
                tr.cargo -= give;
              }
            }
          }
        }
      }
    }
  }

  private tickDepots() {
    for (const d of this.ents.values()) {
      if (d.k !== "depot" || d.o < 0) continue;
      if (this.players.get(d.o)?.lowPower) continue;
      for (const e of this.ents.values())
        if (this.isAlly(d.o, e.o) && !isBuilding(e.k) && e.hp < e.mhp && dist(e.x, e.y, d.x, d.y) <= DEPOT_RANGE)
          e.hp = Math.min(e.mhp, e.hp + DEPOT_HEAL);
    }
  }

  private tickDerricks() {
    const emitPopup = this.tick % 40 === 0;
    for (const d of this.ents.values()) {
      if ((d.k !== "derrick" && d.k !== "coalmine") || d.o < 0) continue;
      const p = this.players.get(d.o);
      if (!p || p.eliminated) continue;
      const inc = d.k === "coalmine" ? COALMINE_INCOME : DERRICK_INCOME;
      p.credits += inc;
      p.creditsEarned += inc;
      if (emitPopup) {
        this.events.push({ e: "income", x: d.x, y: d.y, amt: inc * 4, slot: d.o });
      }
    }
  }

  private tickVetRegen() {
    for (const e of this.ents.values()) {
      if (e.vet >= 2 && !isBuilding(e.k) && e.hp < e.mhp) {
        e.hp = Math.min(e.mhp, e.hp + VET_HEAL[e.vet]);
      }
    }
  }

  private tickCrates() {
    if (!this.config.crates) return;
    // Periodic spawn in contested mid-map [14..50, 14..50]
    if (
      this.tick >= 250 &&
      (this.tick === 250 || (this.tick - 250) % CRATE_INTERVAL_TICKS === 0) &&
      this.crates.size < CRATE_MAX
    ) {
      for (let tries = 0; tries < 30; tries++) {
        const tx = 14 + Math.floor(Math.random() * Math.max(1, this.w - 27));
        const ty = 14 + Math.floor(Math.random() * Math.max(1, this.h - 27));
        if (!this.passable(tx, ty) || this.ore[this.idx(tx, ty)] > 0) continue;
        const cx = tx + 0.5,
          cy = ty + 0.5;
        let tooClose = false;
        for (const c of this.crates.values()) {
          if (dist(cx, cy, c.x, c.y) < 3) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
        const kind = CRATE_KINDS[Math.floor(Math.random() * CRATE_KINDS.length)];
        const crate: CrateSnap = { id: this.nextCrateId++, x: cx, y: cy, kind };
        this.crates.set(crate.id, crate);
        break;
      }
    }

    if (!this.crates.size) return;

    // Collection check
    for (const [cid, crate] of [...this.crates.entries()]) {
      let collector: Ent | null = null;
      for (const u of this.ents.values()) {
        if (isBuilding(u.k) || u.o < 0) continue;
        if (dist(u.x, u.y, crate.x, crate.y) <= 1.2) {
          collector = u;
          break;
        }
      }
      if (!collector) continue;
      this.crates.delete(cid);
      const p = this.players.get(collector.o);
      let text = "";
      if (crate.kind === "cash") {
        if (p) {
          p.credits += CRATE_CASH;
          p.creditsEarned += CRATE_CASH;
        }
        text = "+$1,000 CRATE";
      } else if (crate.kind === "vet") {
        if (collector.vet < 3 && collector.k !== "harvester" && collector.k !== "engineer") {
          this.promoteUnit(collector, collector.vet + 1);
          text = "★ PROMOTED!";
        } else {
          if (p) {
            p.credits += 500;
            p.creditsEarned += 500;
          }
          text = "★ PROMOTED!";
        }
      } else if (crate.kind === "heal") {
        collector.hp = collector.mhp;
        for (const u of this.ents.values()) {
          if (!isBuilding(u.k) && this.isAlly(collector.o, u.o) && dist(collector.x, collector.y, u.x, u.y) <= 8) {
            u.hp = u.mhp;
          }
        }
        text = "SQUAD REPAIRED!";
      } else if (crate.kind === "unit") {
        const bonusKind: UnitKind = this.hasBuilding(collector.o, "factory2")
          ? "railtank"
          : this.hasBuilding(collector.o, "radar")
            ? "himars"
            : "tank";
        const spot = nearestPassable(Math.floor(collector.x), Math.floor(collector.y), this.passable, 6, this.w, this.h);
        if (spot) {
          this.spawnUnit(collector.o, bonusKind, spot.x, spot.y);
          if (p) p.unitsBuilt++;
        }
        text = "BONUS REINFORCEMENT!";
      }
      this.events.push({ e: "crate", x: crate.x, y: crate.y, kind: crate.kind, slot: collector.o, text });
    }
  }

  private promoteUnit(e: Ent, newVet: number) {
    const clamped = Math.min(3, Math.max(0, newVet));
    if (clamped <= e.vet || isBuilding(e.k) || e.k === "harvester" || e.k === "engineer") return;
    const oldMhp = e.mhp;
    e.vet = clamped;
    e.xp = Math.max(e.xp, VET_XP[clamped]);
    e.mhp = Math.round(UNITS[e.k].hp * VET_HP[clamped]);
    const gain = e.mhp - oldMhp;
    e.hp = Math.min(e.mhp, e.hp + gain + Math.round(e.mhp * 0.25));
    this.events.push({ e: "promote", id: e.id, vet: e.vet, x: e.x, y: e.y, slot: e.o });
  }

  private grantXp(e: Ent, amount: number) {
    if (amount <= 0 || isBuilding(e.k) || e.k === "harvester" || e.k === "engineer" || e.vet >= 3) return;
    e.xp += amount;
    let targetVet = e.vet;
    while (targetVet < 3 && e.xp >= VET_XP[targetVet + 1]) targetVet++;
    if (targetVet > e.vet) this.promoteUnit(e, targetVet);
  }

  private alertVictim(slot: number, x: number, y: number) {
    if (slot < 0) return;
    const last = this.lastAlert.get(slot) ?? -999;
    if (this.tick - last >= 80) {
      this.lastAlert.set(slot, this.tick);
      this.events.push({ e: "alert", slot, x, y });
    }
  }

  // ore fields slowly regrow and creep outward, like the real game
  private regenOre() {
    const changed: [number, number, number][] = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const t = this.idx(x, y);
        const amt = this.ore[t];
        if (amt > 0) {
          if (amt < ORE_CELL_MAX) {
            const nextAmt = Math.min(ORE_CELL_MAX, amt + 2);
            this.ore[t] = nextAmt;
            changed.push([x, y, nextAmt]);
          }
          continue;
        }
        if (this.bld[t] >= 0 || !this.passable(x, y)) continue;
        let adj = 0;
        if (x + 1 < this.w && this.ore[t + 1] > 0) adj++;
        if (x > 0 && this.ore[t - 1] > 0) adj++;
        if (y + 1 < this.h && this.ore[t + this.w] > 0) adj++;
        if (y > 0 && this.ore[t - this.w] > 0) adj++;
        if (adj >= 2 && Math.random() < ORE_SPREAD_CHANCE) {
          this.ore[t] = 2;
          changed.push([x, y, 2]);
        }
      }
    }
    if (changed.length) this.events.push({ e: "ore", cells: changed });
  }

  private tickProduction() {
    for (const p of this.players.values()) {
      const rate = p.lowPower ? 0.5 : 1;
      if (p.bq) {
        p.bq.left -= rate;
        if (p.bq.left <= 0) {
          p.awaiting = p.bq.kind;
          p.bq = null;
        }
      }
      if (p.dq) {
        p.dq.left -= rate;
        if (p.dq.left <= 0) {
          p.awaitingDef = p.dq.kind;
          p.dq = null;
        }
      }
      if (this.hasBuilding(p.slot, "superweapon")) {
        if (p.swLeft < 0) p.swLeft = SW_CHARGE_TICKS;
        else if (p.swLeft > 0 && !p.lowPower) p.swLeft = Math.max(0, p.swLeft - rate);
      } else {
        p.swLeft = -1;
      }
      if (this.hasBuilding(p.slot, "radar")) {
        if (p.reconLeft < 0) p.reconLeft = 150;
        else if (p.reconLeft > 0 && !p.lowPower) p.reconLeft = Math.max(0, p.reconLeft - rate);
      } else {
        p.reconLeft = -1;
      }
      for (const cat of PROD_CATS) {
        const q = p.queues[cat];
        if (!q) continue;
        const blds = this.buildingsOf(p.slot, cat);
        const boost = Math.min(2.0, 1 + Math.max(0, blds.length - 1) * 0.25);
        q.left -= rate * boost;
        if (q.left <= 0) {
          // losing the tech prerequisite mid-queue halts production with a refund
          const ud = UNITS[q.unit];
          if (ud.requires && !this.hasBuilding(p.slot, ud.requires)) {
            p.credits += ud.cost * q.count;
            delete p.queues[cat];
            continue;
          }
          const upgKind = UPGRADED_OF[cat];
          const b = (upgKind ? blds.find((x) => x.k === upgKind) : undefined) ?? blds[0];
          const spawned = b ? this.spawnNearBuilding(p.slot, q.unit, b) : null;
          if (!spawned) {
            // nowhere to deploy — refund instead of eating the unit
            p.credits += UNITS[q.unit].cost;
          } else {
            p.unitsBuilt++;
            // Veteran ★ graduation from upgraded production facilities
            if (b && (b.k === "barracks2" || b.k === "airfield2" || b.k === "shipyard2")) {
              this.promoteUnit(spawned, 1);
            }
            if (b && b.rally) {
              const rk: OrderKind = spawned.k === "engineer" || spawned.k === "harvester" ? "move" : "amove";
              this.cmdOrder(p.slot, [spawned.id], rk, b.rally[0], b.rally[1]);
            }
          }
          if (--q.count <= 0) delete p.queues[cat];
          else q.left = q.total;
        }
      }
    }
  }

  private tickEnt(e: Ent) {
    if (e.cd > 0) e.cd--;
    if (e.interceptCd > 0) e.interceptCd--;
    if (e.direct) {
      if (this.tick > e.direct.until) {
        delete e.direct;
        delete e.fpvAlt;
      } else {
        this.tickDirect(e);
        return;
      }
    }
    if (e.k === "harvester") {
      this.tickHarvester(e);
      return;
    }
    const w = weaponOf(e);
    const o = e.order;
    if (o?.kind === "attack" && o.target != null) {
      const tgt = this.ents.get(o.target);
      if (!tgt || !this.canAttack(e, tgt)) {
        // Aggressive Attack Mode: when primary target dies (and no queued waypoint), immediately pursue nearest nearby enemy!
        const nextEnemy = e.orderQueue.length === 0 ? this.nearestEnemy(e, Math.max(w.range + 6, 11)) : null;
        if (nextEnemy) {
          e.order = { kind: "attack", x: nextEnemy.x, y: nextEnemy.y, target: nextEnemy.id };
          e.repath = 0;
        } else {
          this.advanceOrder(e);
        }
      } else if ((e.k === "engineer" || e.k === "spy") && isBuilding(tgt.k)) {
        // engineers & spies don't shoot — they walk in and take / sabotage the building
        if (!(e.k === "spy" ? this.trySabotage(e, tgt) : this.tryCapture(e, tgt))) {
          if (e.repath-- <= 0) {
            e.repath = 12;
            this.pathNear(e, tgt);
          }
          this.stepAlong(e);
        }
      } else {
        const d = entityDist(e, tgt);
        if (d <= w.range) {
          this.face(e, tgt.x, tgt.y);
          this.tryFire(e, tgt);
        } else {
          if (e.repath-- <= 0) {
            e.repath = 12;
            this.pathNear(e, tgt);
          }
          this.stepAlong(e);
        }
      }
    } else if (o?.kind === "amove" || o?.kind === "patrol") {
      // Aggressive Attack-Move: wide acquisition radius actively hunts & closes in on enemies along the advance
      const scanR =
        o.kind === "patrol"
          ? Math.max(w.range + 5, 10)
          : Math.max(w.range + 7, e.k === "engineer" || e.k === "spy" ? 8 : 12);
      const tracked = e.agro != null ? this.ents.get(e.agro) : null;
      const enemy =
        tracked && this.canAttack(e, tracked) && entityDist(e, tracked) <= scanR + 2
          ? tracked
          : this.nearestEnemy(e, scanR);
      if (enemy) {
        if ((e.k === "engineer" || e.k === "spy") && isBuilding(enemy.k)) {
          // attack-moving engineers & spies capture / sabotage buildings they reach
          if (!(e.k === "spy" ? this.trySabotage(e, enemy) : this.tryCapture(e, enemy))) {
            e.agro = enemy.id;
            if (e.repath-- <= 0) {
              e.repath = 12;
              this.pathNear(e, enemy);
            }
            this.stepAlong(e);
          }
        } else {
          const d = entityDist(e, enemy);
          if (d <= w.range) {
            this.face(e, enemy.x, enemy.y);
            this.tryFire(e, enemy);
          } else {
            e.agro = enemy.id;
            if (e.repath-- <= 0) {
              e.repath = 12;
              this.pathNear(e, enemy);
            }
            this.stepAlong(e);
          }
        }
      } else {
        if (e.agro != null) {
          // the enemy we were chasing died — resume marching to the real destination
          e.agro = null;
          e.path = null;
        }
        if (this.stepAlong(e)) {
          if (
            o.kind === "patrol" &&
            e.orderQueue.length === 0 &&
            o.patrolFrom &&
            dist(o.x, o.y, o.patrolFrom[0], o.patrolFrom[1]) >= 0.5
          ) {
            const [fx, fy] = o.patrolFrom;
            o.patrolFrom = [o.x, o.y];
            o.x = fx;
            o.y = fy;
            e.path = null;
          } else {
            this.advanceOrder(e);
          }
        }
      }
    } else if (o?.kind === "move") {
      if (this.stepAlong(e)) this.advanceOrder(e);
    } else if (w.range > 0) {
      // idle: hold position, auto-fire within weapon range (no pursuit)
      if (!isBuilding(e.k) || ((BUILDINGS[e.k].range ?? 0) > 0 && !this.players.get(e.o)?.lowPower)) {
        const enemy = this.nearestEnemy(e, w.range);
        if (enemy) {
          this.face(e, enemy.x, enemy.y);
          this.tryFire(e, enemy);
        }
      }
    }
  }

  private tickDirect(e: Ent) {
    const dir = e.direct;
    if (!dir) return;
    e.d = dir.yaw;

    // 1P altitude: air units climb/dive with dir.alt while driven (field cleared when drive ends)
    if (domainOf(e.k) === "air") {
      e.fpvAlt = Math.max(0.12, Math.min(1, (e.fpvAlt ?? 0.6) + (dir.alt ?? 0) * 0.025));
    }

    // Movement vector in map (x, y) coords:
    // Forward = (cos(yaw), sin(yaw)), Right (strafe) = (-sin(yaw), cos(yaw))
    let vx = Math.cos(dir.yaw) * dir.fwd - Math.sin(dir.yaw) * dir.strafe;
    let vy = Math.sin(dir.yaw) * dir.fwd + Math.cos(dir.yaw) * dir.strafe;
    const len = Math.hypot(vx, vy);
    if (len > 1) {
      vx /= len;
      vy /= len;
    }
    if (len > 0.001) {
      const logisticsOn = this.config.logistics !== false;
      const fuelMult = logisticsOn && usesFuel(e.k) && e.fuel <= 0 ? 0.38 : 1;
      const speed = UNITS[e.k as UnitKind].speed * 1.15 * fuelMult * (dir.sprint ? 1.4 : 1);
      const dx = vx * speed;
      const dy = vy * speed;
      const dom = domainOf(e.k);
      const canEnter = (nx: number, ny: number): boolean => {
        if (!this.inBounds(nx, ny)) return false;
        if (dom === "air") return true;
        const ix = Math.floor(nx),
          iy = Math.floor(ny);
        return dom === "sea" ? this.passableSea(ix, iy) : this.passable(ix, iy);
      };
      const prevX = e.x,
        prevY = e.y;
      const tx = Math.max(0.5, Math.min(this.w - 0.5, e.x + dx));
      const ty = Math.max(0.5, Math.min(this.h - 0.5, e.y + dy));
      if (canEnter(tx, ty)) {
        e.x = tx;
        e.y = ty;
      } else if (Math.abs(dx) > 1e-6 && canEnter(tx, e.y)) {
        e.x = tx;
      } else if (Math.abs(dy) > 1e-6 && canEnter(e.x, ty)) {
        e.y = ty;
      }
      e.x = Math.max(0.5, Math.min(this.w - 0.5, e.x));
      e.y = Math.max(0.5, Math.min(this.h - 0.5, e.y));
      if (logisticsOn && usesFuel(e.k)) {
        const moved = Math.hypot(e.x - prevX, e.y - prevY);
        if (moved > 0) {
          e.fuel = Math.max(0, e.fuel - moved * fuelBurnOf(e.k, dom) * (dir.sprint ? 1.6 : 1));
        }
      }
    }

    // Sapper (engineer) & Spy FPV Capture / Sabotage
    if (e.k === "engineer" || e.k === "spy") {
      const capRange = dir.fire ? CAPTURE_RANGE + 0.5 : CAPTURE_RANGE;
      for (const b of [...this.ents.values()]) {
        if (!isBuilding(b.k) || this.isAlly(e.o, b.o)) continue;
        const done = e.k === "spy" ? this.trySabotage(e, b, capRange) : this.tryCapture(e, b, capRange);
        if (done) return;
      }
    }

    // Harvester FPV Mining & Depositing
    if (e.k === "harvester") {
      const cap = UNITS.harvester.capacity ?? 40;
      const ox = Math.floor(e.x),
        oy = Math.floor(e.y);
      if (this.inBounds(ox, oy)) {
        const t = this.idx(ox, oy);
        if (this.ore[t] > 0 && e.cargo < cap && this.tick % HARVEST_TICKS_PER_UNIT === 0) {
          this.ore[t]--;
          e.cargo++;
          this.events.push({ e: "ore", cells: [[ox, oy, this.ore[t]]] });
        }
      }
      if (e.cargo > 0) {
        const ref = this.nearestRefinery(e);
        if (ref) {
          const dockR = Math.max(BUILDINGS.refinery.w, BUILDINGS.refinery.h) / 2 + 0.9;
          if (dist(e.x, e.y, ref.x, ref.y) <= dockR) {
            const p = this.players.get(e.o);
            const deposit = Math.floor(
              e.cargo * ORE_VALUE * (this.hasBuilding(e.o, "purifier") ? 1 + PURIFIER_BONUS : 1),
            );
            if (p && deposit > 0) {
              p.credits += deposit;
              p.creditsEarned += deposit;
              this.events.push({ e: "income", x: ref.x, y: ref.y, amt: deposit, slot: e.o });
            }
            e.cargo = 0;
          }
        }
      }
    }

    // Direct-Aim Firing
    const w = weaponOf(e);
    if (!dir.fire || e.cd > 0 || w.range <= 0) return;

    // AC-130 gunship weapon select — wpn slot overrides the gun only while player-driven
    const gun = e.k === "ac130" ? AC130_GUNS[dir.wpn ?? 0] : null;
    if (gun) {
      w.dmg = gun.dmg;
      w.rof = gun.rof;
    }

    const pointDistToEnt = (px: number, py: number, t: Ent) => {
      if (!isBuilding(t.k)) return dist(px, py, t.x, t.y);
      const bd = BUILDINGS[t.k];
      return Math.hypot(
        Math.max(0, Math.abs(px - t.x) - bd.w / 2),
        Math.max(0, Math.abs(py - t.y) - bd.h / 2),
      );
    };

    // Priority 1: Explicit aimTarget / persistent lock-on (dir.lock sticks across drive msgs;
    // locked guided weapons track with a slightly wider slack)
    const lockId = dir.lock ?? dir.aimTarget;
    if (lockId != null) {
      const tgt = this.ents.get(lockId);
      if (
        tgt &&
        !this.isAlly(e.o, tgt.o) &&
        this.canAttack(e, tgt) &&
        entityDist(e, tgt) <= w.range + (dir.lock != null ? 3 : 1.5)
      ) {
        this.tryFire(e, tgt, gun);
        return;
      }
    }

    // Priority 2: Closest non-ally attackable entity within 1.8 tiles of (aimX, aimY) and in weapon range
    let best: Ent | null = null;
    let bestD = 1.8;
    for (const t of this.ents.values()) {
      if (this.isAlly(e.o, t.o)) continue;
      if (!this.canAttack(e, t)) continue;
      if (entityDist(e, t) > w.range + 1.5) continue;
      const ad = pointDistToEnt(dir.aimX, dir.aimY, t);
      if (ad <= bestD) {
        bestD = ad;
        best = t;
      }
    }
    if (best) {
      this.tryFire(e, best, gun);
      return;
    }

    // Priority 3: Free-Fire Shot!
    let tx = dir.aimX;
    let ty = dir.aimY;
    const dx = tx - e.x;
    const dy = ty - e.y;
    const d = Math.hypot(dx, dy);
    if (d > w.range) {
      tx = e.x + (dx / d) * w.range;
      ty = e.y + (dy / d) * w.range;
    } else if (d < 0.01) {
      tx = e.x + Math.cos(dir.yaw) * Math.min(w.range, 1);
      ty = e.y + Math.sin(dir.yaw) * Math.min(w.range, 1);
    }
    tx = Math.max(0.1, Math.min(this.w - 0.1, tx));
    ty = Math.max(0.1, Math.min(this.h - 0.1, ty));

    const kamikaze = isKamikaze(e.k);
    if (this.config.logistics !== false && !isBuilding(e.k) && !kamikaze) {
      e.ammo = Math.max(0, e.ammo - ammoCostOf(e.k));
      e.cd = e.ammo <= 0 ? Math.round(w.rof * 3.0) : w.rof;
    } else {
      e.cd = w.rof;
    }
    if (e.k === "sub" || e.k === "stealthbomber" || e.k === "usv") e.subSurfaceUntil = this.tick + 45;
    if (!kamikaze) {
      this.events.push({
        e: "shot",
        fx: e.x,
        fy: e.y,
        tx,
        ty,
        w: gun ? gun.fx : weaponFxOf(e.k),
        src: e.id,
        ...(e.vet > 0 ? { vet: e.vet } : {}),
      });
    }

    if (this.tryIntercept(e, tx, ty)) {
      if (kamikaze) this.destroy(e, -1);
      return;
    }

    const splashR = gun ? gun.splash : SPLASH_RADIUS[e.k];
    if (splashR) {
      const baseDmg = w.dmg * VET_DMG[e.vet];
      const hitAir = canHitAirOf(e.k);
      for (const other of [...this.ents.values()]) {
        if (!this.ents.has(other.id)) continue;
        if (this.isAlly(e.o, other.o)) continue;
        if (!hitAir && domainOf(other.k) === "air") continue;
        const sd = pointDistToEnt(tx, ty, other);
        if (sd > splashR) continue;
        const falloff = kamikaze ? Math.max(0.35, 1 - sd / splashR) : 1 - sd / splashR;
        const sdmg = baseDmg * (kamikaze ? 1 : 0.65) * falloff * armorMult(e.k, other.k);
        if (sdmg <= 0) continue;
        other.hp -= sdmg;
        this.events.push({ e: "hit", id: other.id });
        if (!kamikaze) this.grantXp(e, sdmg * 0.5);
        this.alertVictim(other.o, other.x, other.y);
        if (other.hp <= 0) {
          if (!kamikaze) this.grantXp(e, other.mhp * 0.8);
          this.events.push({ e: "kill", src: e.id, id: other.id, x: other.x, y: other.y });
          this.destroy(other, e.o);
        } else if (isBuilding(other.k) && BUILDINGS[other.k].power > 0) {
          this.recomputePower(other.o);
        }
      }
    }
    if (kamikaze) {
      this.events.push({ e: "boom", x: tx, y: ty, r: splashR ?? 2.0 });
      this.destroy(e, -1);
    } else if (e.k === "stealthbomber" || e.k === "bomber" || e.k === "zeppelin") {
      // gravity-bomb delivery: render the big impact blast + crater, not just a hit flash
      this.events.push({ e: "boom", x: tx, y: ty, r: splashR ?? 2.5 });
    }
  }

  private tickHarvester(e: Ent) {
    if (e.direct) {
      if (this.tick > e.direct.until) {
        delete e.direct;
        delete e.fpvAlt;
      } else {
        this.tickDirect(e);
        return;
      }
    }
    const o = e.order;
    // explicit move orders run through the generic mover — tickEnt returns
    // early for harvesters, so this is the only place they get stepped
    if (o?.kind === "move") {
      if (this.stepAlong(e)) this.advanceOrder(e);
      return;
    }
    if (o?.kind === "harvest" && e.hstate) {
      if (e.hstate === "toOre") {
        // adjacent reach counts as "at" the tile — a strict arriveR is
        // unreachable when another unit hugs the ore face (perma-jam)
        const ox = e.oreIdx % this.w, oy = (e.oreIdx / this.w) | 0;
        const arrived = this.stepAlong(e, 0.45) || dist(e.x, e.y, ox + 0.5, oy + 0.5) <= 0.85;
        if (arrived) e.hstate = "mining";
      } else if (e.hstate === "toRef") {
        const ref = this.nearestRefinery(e);
        if (!ref) {
          e.order = null;
          e.hstate = null;
          return;
        }
        const dockR = Math.max(BUILDINGS.refinery.w, BUILDINGS.refinery.h) / 2 + 0.9;
        const arrived = this.stepAlong(e, 0.4) || dist(e.x, e.y, ref.x, ref.y) <= dockR;
        if (arrived) {
          const p = this.players.get(e.o);
          const deposit = Math.floor(e.cargo * ORE_VALUE * (this.hasBuilding(e.o, "purifier") ? 1 + PURIFIER_BONUS : 1));
          if (p && deposit > 0) {
            p.credits += deposit;
            p.creditsEarned += deposit;
            this.events.push({ e: "income", x: ref.x, y: ref.y, amt: deposit, slot: e.o });
          }
          e.cargo = 0;
          e.hstate = "toOre";
          e.order = null;
          // resume at last ore tile — unless another harvester claimed it meanwhile
          if (e.oreIdx >= 0 && this.ore[e.oreIdx] > 0 && !this.oreTaken(e.oreIdx, e.id)) {
            const maxExpand = this.w >= 96 ? 4500 : 2400;
            e.path = findPath(
              e.x | 0,
              e.y | 0,
              e.oreIdx % this.w,
              (e.oreIdx / this.w) | 0,
              this.passable,
              maxExpand,
              this.w,
              this.h,
            );
            e.order = { kind: "harvest", x: e.oreIdx % this.w, y: (e.oreIdx / this.w) | 0 };
          }
        }
      }
    }

    if (e.hstate === "mining") {
      const ox = e.oreIdx % this.w,
        oy = (e.oreIdx / this.w) | 0;
      const cap = UNITS.harvester.capacity!;
      if (Math.abs(e.x - (ox + 0.5)) > 1.0 || Math.abs(e.y - (oy + 0.5)) > 1.0) {
        // drifted off the ore face — drive back to it
        e.hstate = "toOre";
        e.order = { kind: "harvest", x: ox, y: oy };
        e.path = null;
        return;
      }
      const t = e.oreIdx;
      if (this.ore[t] > 0 && e.cargo < cap) {
        if (this.tick % HARVEST_TICKS_PER_UNIT === 0) {
          this.ore[t]--;
          e.cargo++;
          this.events.push({ e: "ore", cells: [[ox, oy, this.ore[t]]] });
          if (this.ore[t] === 0) {
            const next = this.nearestOre(e.x | 0, e.y | 0, 999, e);
            if (next >= 0) {
              e.oreIdx = next;
              e.hstate = "toOre";
              e.order = { kind: "harvest", x: next % this.w, y: (next / this.w) | 0 };
              e.path = null;
            } else e.hstate = e.cargo > 0 ? "toRef" : null;
          }
          if (e.cargo >= cap) {
            e.hstate = "toRef";
            e.order = { kind: "harvest", x: e.x, y: e.y };
          }
        }
      } else if (e.cargo >= cap) {
        e.hstate = "toRef";
      } else {
        const next = this.nearestOre(e.x | 0, e.y | 0, 999, e);
        if (next >= 0) {
          e.oreIdx = next;
          e.hstate = "toOre";
          e.order = { kind: "harvest", x: next % this.w, y: (next / this.w) | 0 };
          e.path = null;
        } else e.hstate = e.cargo > 0 ? "toRef" : null;
      }
      return;
    }

    // toOre without a path yet
    if (e.hstate === "toOre" && !e.path?.length) {
      const goal =
        e.oreIdx >= 0 && this.ore[e.oreIdx] > 0 && !this.oreTaken(e.oreIdx, e.id)
          ? { x: e.oreIdx % this.w, y: (e.oreIdx / this.w) | 0 }
          : null;
      if (!goal) {
        const n = this.nearestOre(e.x | 0, e.y | 0, 999, e);
        if (n < 0) {
          e.hstate = e.cargo > 0 ? "toRef" : null;
          e.order = null;
          return;
        }
        e.oreIdx = n;
        e.order = { kind: "harvest", x: n % this.w, y: (n / this.w) | 0 };
      }
      const g = goal ?? { x: e.oreIdx % this.w, y: (e.oreIdx / this.w) | 0 };
      if (this.astarBudget <= 0) return;
      this.astarBudget--;
      const maxExpand = this.w >= 96 ? 4500 : 2400;
      e.path = findPath(e.x | 0, e.y | 0, g.x, g.y, this.passable, maxExpand, this.w, this.h);
      e.order = { kind: "harvest", x: g.x, y: g.y };
      if (!e.path) {
        // Back off for 5s so an unreachable island ore tile never spins A* every tick
        e.hstate = null;
        e.order = null;
        e.holdUntil = this.tick + 50;
      }
      return;
    }

    if (e.hstate === "toRef" && !e.path?.length) {
      const ref = this.nearestRefinery(e);
      if (!ref) {
        e.hstate = null;
        e.order = null;
        return;
      }
      if (this.astarBudget <= 0) return;
      this.pathNear(e, ref, Math.max(BUILDINGS.refinery.w, BUILDINGS.refinery.h) / 2 + 0.5);
      if (!e.path?.length) {
        e.hstate = null;
        e.order = null;
        e.holdUntil = this.tick + 50;
        return;
      }
      e.order = { kind: "harvest", x: ref.x, y: ref.y };
      return;
    }

    // idle harvester: auto-start harvesting nearby ore, or return cargo —
    // but stay put while hold or holdUntil suppresses auto-resume (stop/explicit orders)
    if (!e.order && !e.hstate && !e.hold && this.tick >= e.holdUntil) {
      if (e.cargo > 0) {
        if (this.nearestRefinery(e)) e.hstate = "toRef"; // no refinery → wait with cargo
      } else {
        const n = this.nearestOre(e.x | 0, e.y | 0, 999, e);
        if (n >= 0) {
          e.oreIdx = n;
          e.hstate = "toOre";
          e.order = { kind: "harvest", x: n % this.w, y: (n / this.w) | 0 };
        }
      }
    }
  }

  private nearestRefinery(e: Ent) {
    let best: Ent | null = null,
      bd = Infinity;
    for (const b of this.ents.values()) {
      if (b.o !== e.o || b.k !== "refinery") continue;
      const d = dist(e.x, e.y, b.x, b.y);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  // oreIdx -> harvester id working that tile — rebuilt lazily once per tick.
  // Claims are soft: held for the whole toOre→mining→toRef cycle so a hauler
  // keeps its spot, and freed automatically on death/retask/hold.
  private oreTakenMap: Map<number, number> | null = null;
  private oreTaken(t: number, selfId: number): boolean {
    if (!this.oreTakenMap) {
      const m = new Map<number, number>();
      for (const e of this.ents.values())
        if (e.k === "harvester" && e.oreIdx >= 0 && e.hstate !== null)
          m.set(e.oreIdx, e.id);
      this.oreTakenMap = m;
    }
    const h = this.oreTakenMap.get(t);
    return h !== undefined && h !== selfId;
  }

  private nearestOre(x: number, y: number, maxR = 999, self?: Ent) {
    let best = -1,
      bd = Infinity,
      bestT = -1,
      bdT = Infinity,
      seenOre = false,
      oreRings = 0;
    // scan outward rings — cheaper than full scan. Free tiles win immediately in
    // ring order; taken tiles are kept as fallback (sharing beats idling).
    for (let r = 0; r < Math.min(maxR, Math.max(this.w, this.h)); r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x + dx,
            ny = y + dy;
          if (!this.inBounds(nx, ny)) continue;
          const i = this.idx(nx, ny);
          if (this.ore[i] <= 0) continue;
          const d = dx * dx + dy * dy;
          if (self && this.oreTaken(i, self.id)) {
            if (d < bdT) {
              bdT = d;
              bestT = i;
            }
          } else if (d < bd) {
            bd = d;
            best = i;
          }
          seenOre = true;
        }
      if (best >= 0) {
        // commit immediately so a second harvester picking this same tick sees it
        if (self) {
          if (!this.oreTakenMap) this.oreTakenMap = new Map();
          this.oreTakenMap.set(best, self.id);
        }
        return best;
      }
      if (seenOre && ++oreRings > 18) break; // don't wander the whole map for a free tile
    }
    const pick = best >= 0 ? best : bestT;
    if (self && pick >= 0) {
      if (!this.oreTakenMap) this.oreTakenMap = new Map();
      this.oreTakenMap.set(pick, self.id);
    }
    return pick;
  }

  private nearestEnemy(e: Ent, range: number) {
    let best: Ent | null = null,
      bd = range;
    const pad = range + 2.5;
    const x0 = Math.max(0, Math.floor(e.x - pad) >> 3);
    const x1 = Math.min(this.gridCols - 1, Math.floor(e.x + pad) >> 3);
    const y0 = Math.max(0, Math.floor(e.y - pad) >> 3);
    const y1 = Math.min(this.gridRows - 1, Math.floor(e.y + pad) >> 3);
    if (this.gridTick === this.tick) {
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const cell = this.grid[gy * this.gridCols + gx];
          for (let i = 0; i < cell.length; i++) {
            const t = cell[i];
            if (t.o < 0 || this.isAlly(e.o, t.o) || !this.ents.has(t.id)) continue;
            const tp = this.players.get(t.o);
            if (!tp || tp.eliminated) continue;
            if (t.k === "spy" && this.tick >= t.spottedUntil) continue; // disguised spy: no auto-acquire
            // Fast bounding-box reject before canAttack/sqrt
            const dx = Math.abs(e.x - t.x);
            const dy = Math.abs(e.y - t.y);
            if (dx > bd + 2 || dy > bd + 2) continue;
            if (!this.canAttack(e, t)) continue;
            const d = entityDist(e, t);
            if (d <= bd) {
              bd = d;
              best = t;
            }
          }
        }
      }
      return best;
    }
    for (const t of this.ents.values()) {
      if (t.o < 0 || this.isAlly(e.o, t.o)) continue;
      const tp = this.players.get(t.o);
      if (!tp || tp.eliminated) continue;
      if (t.k === "spy" && this.tick >= t.spottedUntil) continue; // disguised spy: no auto-acquire
      if (!this.canAttack(e, t)) continue;
      const d = entityDist(e, t);
      if (d <= bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  private face(e: Ent, x: number, y: number) {
    e.d = Math.atan2(y - e.y, x - e.x);
  }

  private tryIntercept(attacker: Ent, tx: number, ty: number, defenderSlot?: number): boolean {
    if (!INTERCEPTABLE.has(attacker.k)) return false;
    // Ballistic Missile TEL SRBM: ONLY Anti-Nuke (THAAD) batteries can attempt interception — 80% each within 18 tiles
    if (attacker.k === "ballistic") {
      const batteries: { ent: Ent; d: number }[] = [];
      for (const dome of this.ents.values()) {
        if (dome.k !== "thaad" || dome.o < 0 || dome.interceptCd > 0) continue;
        if (this.tick < dome.sabUntil) continue;
        if (this.players.get(dome.o)?.lowPower) continue;
        if (defenderSlot !== undefined && defenderSlot >= 0) {
          if (!this.isAlly(defenderSlot, dome.o)) continue;
        } else {
          if (this.isAlly(attacker.o, dome.o)) continue;
        }
        const d = dist(dome.x, dome.y, tx, ty);
        if (d <= THAAD_NUKE_RADIUS) batteries.push({ ent: dome, d });
      }
      batteries.sort((a, b) => a.d - b.d);
      for (const { ent: tower } of batteries) {
        tower.interceptCd = THAAD_NUKE_CD;
        this.face(tower, tx, ty);
        if (Math.random() < 0.8) {
          this.events.push({ e: "intercept", fx: tower.x, fy: tower.y, tx, ty, slot: tower.o });
          return true;
        }
      }
      return false;
    }
    // Mach-9 Kamikaze hypersonic glide missile: THAAD stops at 80% (16 tiles), Iron Dome at 33% (9.5 tiles)!
    if (attacker.k === "hypersonic") {
      const candidates: { ent: Ent; d: number; chance: number; priority: number }[] = [];
      for (const dome of this.ents.values()) {
        const isThaad = dome.k === "thaad";
        const isDome = dome.k === "irondome";
        if ((!isThaad && !isDome) || dome.o < 0 || dome.interceptCd > 0) continue;
        if (this.tick < dome.sabUntil) continue;
        if (this.players.get(dome.o)?.lowPower) continue;
        if (defenderSlot !== undefined && defenderSlot >= 0) {
          if (!this.isAlly(defenderSlot, dome.o)) continue;
        } else {
          if (this.isAlly(attacker.o, dome.o)) continue;
        }
        const maxR = isThaad ? 16 : IRONDOME_RADIUS;
        const d = dist(dome.x, dome.y, tx, ty);
        if (d <= maxR) candidates.push({ ent: dome, d, chance: isThaad ? 0.8 : 1 / 3, priority: isThaad ? 0 : 1 });
      }
      candidates.sort((a, b) => a.priority - b.priority || a.d - b.d);
      for (const { ent: tower, chance } of candidates) {
        tower.interceptCd = IRONDOME_COOLDOWN;
        this.face(tower, tx, ty);
        if (Math.random() < chance) {
          this.events.push({ e: "intercept", fx: tower.x, fy: tower.y, tx, ty, slot: tower.o });
          return true;
        }
      }
      return false;
    }
    const thaadCanIntercept = attacker.k === "dreadnought";
    let bestDome: Ent | null = null;
    let bestD = Infinity;
    for (const dome of this.ents.values()) {
      const isDome = dome.k === "irondome";
      const isThaad = thaadCanIntercept && dome.k === "thaad";
      if ((!isDome && !isThaad) || dome.o < 0 || dome.interceptCd > 0) continue;
      if (this.tick < dome.sabUntil) continue;
      if (this.players.get(dome.o)?.lowPower) continue;
      if (defenderSlot !== undefined && defenderSlot >= 0) {
        if (!this.isAlly(defenderSlot, dome.o)) continue;
      } else {
        if (this.isAlly(attacker.o, dome.o)) continue;
      }
      const maxR = isThaad ? 14 : IRONDOME_RADIUS;
      const d = dist(dome.x, dome.y, tx, ty);
      if (d <= maxR && d < bestD) {
        bestD = d;
        bestDome = dome;
      }
    }
    if (!bestDome) return false;
    bestDome.interceptCd = IRONDOME_COOLDOWN;
    this.face(bestDome, tx, ty);
    this.events.push({ e: "intercept", fx: bestDome.x, fy: bestDome.y, tx, ty, slot: bestDome.o });
    return true;
  }

  private tryFire(e: Ent, tgt: Ent, gun: (typeof AC130_GUNS)[number] | null = null) {
    if (e.cd > 0) return;
    const w = weaponOf(e);
    if (w.range <= 0) return;
    if (isBuilding(e.k) && this.players.get(e.o)?.lowPower) return; // powered defenses offline
    if (this.tick < e.sabUntil) return; // defense battery disabled by spy sabotage
    if (!this.canAttack(e, tgt)) return;
    const kamikaze = isKamikaze(e.k);
    const unitShooter = !isBuilding(e.k); // kill-confirm credit goes to unit shooters only
    if (gun) {
      // 1P-driven AC-130 selected gun — overrides dmg/rof; ammo cost unchanged
      w.dmg = gun.dmg;
      w.rof = gun.rof;
    }
    if (this.config.logistics !== false && unitShooter && !kamikaze) {
      e.ammo = Math.max(0, e.ammo - ammoCostOf(e.k));
      e.cd = e.ammo <= 0 ? Math.round(w.rof * 3.0) : w.rof;
    } else {
      e.cd = w.rof;
    }
    if (e.k === "sub" || e.k === "stealthbomber" || e.k === "usv") e.subSurfaceUntil = this.tick + 45; // reveals for 4.5s while firing
    const baseDmg = w.dmg * VET_DMG[e.vet];
    const directDmg = baseDmg * armorMult(e.k, tgt.k);
    const tx = tgt.x,
      ty = tgt.y;
    if (!kamikaze) {
      this.events.push({
        e: "shot",
        fx: e.x,
        fy: e.y,
        tx,
        ty,
        w: gun ? gun.fx : weaponFxOf(e.k),
        src: e.id,
        ...(e.vet > 0 ? { vet: e.vet } : {}),
      });
    }
    if (this.tryIntercept(e, tx, ty, tgt.o)) {
      if (kamikaze) this.destroy(e, -1);
      return;
    }
    tgt.hp -= directDmg;
    this.events.push({ e: "hit", id: tgt.id });
    if (!kamikaze) this.grantXp(e, directDmg * 0.5);
    this.alertVictim(tgt.o, tx, ty);

    // Splash damage to non-ally targets within SPLASH_RADIUS (ground-only splash skips air targets)
    const splashR = gun ? gun.splash : SPLASH_RADIUS[e.k];
    if (splashR) {
      const hitAir = canHitAirOf(e.k);
      for (const other of [...this.ents.values()]) {
        if (other.id === tgt.id || other.id === e.id || !this.ents.has(other.id)) continue;
        if (this.isAlly(e.o, other.o)) continue;
        if (!hitAir && domainOf(other.k) === "air") continue;
        const d = dist(tx, ty, other.x, other.y);
        if (d > splashR) continue;
        const falloff = 1 - d / splashR;
        const sdmg = baseDmg * 0.65 * falloff * armorMult(e.k, other.k);
        if (sdmg <= 0) continue;
        other.hp -= sdmg;
        this.events.push({ e: "hit", id: other.id });
        if (!kamikaze) this.grantXp(e, sdmg * 0.5);
        this.alertVictim(other.o, other.x, other.y);
        if (other.hp <= 0) {
          if (!kamikaze) this.grantXp(e, other.mhp * 0.8);
          if (unitShooter) this.events.push({ e: "kill", src: e.id, id: other.id, x: other.x, y: other.y });
          this.destroy(other, e.o);
        } else if (isBuilding(other.k) && BUILDINGS[other.k].power > 0) {
          this.recomputePower(other.o);
        }
      }
    }

    if (tgt.hp <= 0 && this.ents.has(tgt.id)) {
      if (!kamikaze) this.grantXp(e, tgt.mhp * 0.8);
      if (unitShooter) this.events.push({ e: "kill", src: e.id, id: tgt.id, x: tgt.x, y: tgt.y });
      this.destroy(tgt, e.o);
    } else if (this.ents.has(tgt.id) && isBuilding(tgt.k) && BUILDINGS[tgt.k].power > 0) {
      this.recomputePower(tgt.o);
    }

    if (kamikaze) {
      this.events.push({ e: "boom", x: tx, y: ty, r: splashR ?? 2.0 });
      this.destroy(e, -1);
    } else if (e.k === "stealthbomber" || e.k === "bomber" || e.k === "zeppelin") {
      // gravity-bomb delivery: render the big impact blast + crater, not just a hit flash
      this.events.push({ e: "boom", x: tx, y: ty, r: splashR ?? 2.5 });
    }
  }

  private destroy(e: Ent, killerSlot?: number) {
    if (!this.ents.has(e.id)) return;
    const wasBuilding = isBuilding(e.k);
    if (wasBuilding) {
      const d = BUILDINGS[e.k as BuildingKind];
      const bx = Math.round(e.x - d.w / 2),
        by = Math.round(e.y - d.h / 2);
      for (let y = by; y < by + d.h; y++)
        for (let x = bx; x < bx + d.w; x++) {
          this.block[this.idx(x, y)] = 0;
          this.bld[this.idx(x, y)] = -1;
        }
    }
    this.ents.delete(e.id);
    if (wasBuilding) {
      this.recomputePower(e.o); // after removal so the corpse doesn't count
      if (killerSlot != null && killerSlot >= 0 && !this.isAlly(killerSlot, e.o)) {
        const kp = this.players.get(killerSlot);
        if (kp) kp.bldDestroyed++;
      }
    } else if (e.o >= 0) {
      const op = this.players.get(e.o);
      if (op) op.unitsLost++;
    }
    const size = wasBuilding ? Math.max(BUILDINGS[e.k as BuildingKind].w, BUILDINGS[e.k as BuildingKind].h) : 1;
    this.events.push({ e: "boom", x: e.x, y: e.y, r: size });
  }

  private pathNear(e: Ent, tgt: Ent, r = 0) {
    const dom = domainOf(e.k);
    if (dom === "air") return; // aircraft fly directly in stepAlong
    const pass = dom === "sea" ? this.passableSea : this.passable;
    const gx = tgt.x | 0,
      gy = tgt.y | 0;
    const searchR = dom === "sea" ? 24 : 10;
    const spot = nearestPassable(gx, gy, pass, searchR, this.w, this.h);
    if (!spot) {
      e.path = [];
      return;
    }
    if (this.astarBudget <= 0) {
      e.repath = 1;
      return;
    }
    this.astarBudget--;
    const maxExpand = this.w >= 96 ? 4500 : 2400;
    e.path = findPath(e.x | 0, e.y | 0, spot.x, spot.y, pass, maxExpand, this.w, this.h);
    if (!e.path?.length && r > 0) e.path = [];
  }

  // advance along path; returns true when arrived (within `arriveR` of final goal).
  // null path = "needs compute"; empty path = "gave up" (avoids re-running A* every tick)
  private stepAlong(e: Ent, arriveR = 0.35): boolean {
    const dom = domainOf(e.k);
    const logisticsOn = this.config.logistics !== false;
    const fuelMult = logisticsOn && usesFuel(e.k) && e.fuel <= 0 ? 0.38 : 1;
    if (dom === "air") {
      // Air units fly in a smooth straight line ignoring cliffs, buildings, and water
      const o = e.order;
      if (!o) return true;
      let gx = o.x,
        gy = o.y;
      if (o.kind === "attack" && o.target != null) {
        const tgt = this.ents.get(o.target);
        if (tgt) {
          gx = tgt.x;
          gy = tgt.y;
        }
      } else if (e.agro != null) {
        const tgt = this.ents.get(e.agro);
        if (tgt) {
          gx = tgt.x;
          gy = tgt.y;
        }
      }
      gx = Math.max(0.5, Math.min(this.w - 0.5, gx));
      gy = Math.max(0.5, Math.min(this.h - 0.5, gy));
      const d = dist(e.x, e.y, gx, gy);
      if (d <= arriveR) return true;
      const speed = UNITS[e.k as UnitKind].speed * fuelMult;
      const step = Math.min(speed, d);
      e.x += ((gx - e.x) / d) * step;
      e.y += ((gy - e.y) / d) * step;
      if (logisticsOn && usesFuel(e.k)) {
        e.fuel = Math.max(0, e.fuel - step * fuelBurnOf(e.k, dom));
      }
      e.d = Math.atan2(gy - e.y, gx - e.x);
      return false;
    }
    const pass = dom === "sea" ? this.passableSea : this.passable;
    const searchR = dom === "sea" ? 24 : 12;
    const maxExpand = this.w >= 96 ? 4500 : 2400;
    if (e.path === null) {
      const o = e.order;
      if (!o) {
        e.path = [];
        return true;
      }
      if (this.astarBudget <= 0) return false;
      this.astarBudget--;
      const goal = nearestPassable(Math.floor(o.x), Math.floor(o.y), pass, searchR, this.w, this.h);
      e.path = goal ? (findPath(e.x | 0, e.y | 0, goal.x, goal.y, pass, maxExpand, this.w, this.h) ?? []) : [];
    }
    if (!e.path.length) return true;
    const wp = e.path[0];
    const wx = wp.x + 0.5,
      wy = wp.y + 0.5;
    const speed = UNITS[e.k as UnitKind].speed * fuelMult;
    const d = dist(e.x, e.y, wx, wy);
    const last = e.path.length === 1;
    if (d <= (last ? arriveR : 0.25)) {
      e.path.shift();
      return e.path.length === 0;
    }
    if (!pass(wp.x, wp.y)) {
      // path invalidated by new construction — repath once
      const o = e.order;
      if (!o) return true;
      const goal = nearestPassable(Math.floor(o.x), Math.floor(o.y), pass, searchR, this.w, this.h);
      e.path = goal ? (findPath(e.x | 0, e.y | 0, goal.x, goal.y, pass, maxExpand, this.w, this.h) ?? []) : [];
      return e.path.length === 0;
    }
    const step = Math.min(speed, d);
    e.x += ((wx - e.x) / d) * step;
    e.y += ((wy - e.y) / d) * step;
    if (logisticsOn && usesFuel(e.k)) {
      e.fuel = Math.max(0, e.fuel - step * fuelBurnOf(e.k, dom));
    }
    e.d = Math.atan2(wy - e.y, wx - e.x);
    return false;
  }

  private separate() {
    // soft separation between units in the SAME domain (spatial 3x3 cell neighborhood); tanks crush enemy infantry
    const isVeh = (k: EntKind) =>
      k === "tank" ||
      k === "heavy" ||
      k === "arty" ||
      k === "harvester" ||
      k === "supplytruck" ||
      k === "himars" ||
      k === "railtank";
    const isCrusher = (k: EntKind) => k === "tank" || k === "heavy" || k === "railtank";
    const crushable = (k: EntKind) => k === "infantry" || k === "rocket" || k === "engineer";
    for (let cy = 0; cy < this.gridRows; cy++) {
      for (let cx = 0; cx < this.gridCols; cx++) {
        const cellA = this.grid[cy * this.gridCols + cx];
        for (let i = 0; i < cellA.length; i++) {
          const a = cellA[i];
          if (isBuilding(a.k) || !this.ents.has(a.id)) continue;
          const aDom = domainOf(a.k);
          const ny0 = Math.max(0, cy - 1),
            ny1 = Math.min(this.gridRows - 1, cy + 1);
          const nx0 = Math.max(0, cx - 1),
            nx1 = Math.min(this.gridCols - 1, cx + 1);
          let aDead = false;
          for (let ny = ny0; ny <= ny1 && !aDead; ny++) {
            for (let nx = nx0; nx <= nx1 && !aDead; nx++) {
              const cellB = this.grid[ny * this.gridCols + nx];
              for (let j = 0; j < cellB.length; j++) {
                const b = cellB[j];
                if (b.id <= a.id || isBuilding(b.k) || !this.ents.has(b.id)) continue;
                if (domainOf(b.k) !== aDom) continue;
                let dx = b.x - a.x,
                  dy = b.y - a.y;
                let d2 = dx * dx + dy * dy;
                if (d2 === 0) {
                  // perfectly stacked — push apart on a deterministic per-pair angle
                  const ang = ((a.id * 7 + b.id * 13) % 8) * (Math.PI / 4);
                  dx = Math.cos(ang) * 0.01;
                  dy = Math.sin(ang) * 0.01;
                  d2 = dx * dx + dy * dy;
                }
                let minSep: number;
                if (aDom === "sea") {
                  minSep =
                    a.k === "dreadnought" || b.k === "dreadnought" || a.k === "carrier" || b.k === "carrier"
                      ? 1.35
                      : 1.1;
                } else if (aDom === "air") {
                  minSep = a.k === "zeppelin" || b.k === "zeppelin" ? 1.25 : 0.9;
                } else {
                  minSep = isVeh(a.k) && isVeh(b.k) ? 1.05 : isVeh(a.k) || isVeh(b.k) ? 0.85 : 0.72;
                }
                if (d2 > minSep * minSep) continue;
                if (aDom === "land") {
                  if (isCrusher(a.k) && crushable(b.k) && !this.isAlly(a.o, b.o)) {
                    this.grantXp(a, b.mhp * 0.8);
                    this.events.push({ e: "kill", src: a.id, id: b.id, x: b.x, y: b.y });
                    this.destroy(b, a.o);
                    continue;
                  }
                  if (isCrusher(b.k) && crushable(a.k) && !this.isAlly(a.o, b.o)) {
                    this.grantXp(b, a.mhp * 0.8);
                    this.events.push({ e: "kill", src: b.id, id: a.id, x: a.x, y: a.y });
                    this.destroy(a, b.o);
                    aDead = true;
                    break;
                  }
                }
                const d = Math.sqrt(d2) || 0.01;
                const push = ((minSep - d) / d) * 0.5 * 0.35;
                const px = dx * push,
                  py = dy * push;
                // anchored units resist being shoved — held ground & mining harvesters
                // (a bounced miner otherwise re-approaches forever = visible pileup)
                const anchored = (u: Ent) => u.hold || (u.k === "harvester" && u.hstate === "mining");
                const aMult = anchored(a) ? 0.15 : 1;
                const bMult = anchored(b) ? 0.15 : 1;
                if (aDom === "air") {
                  a.x = Math.max(0.5, Math.min(this.w - 0.5, a.x - px * aMult));
                  a.y = Math.max(0.5, Math.min(this.h - 0.5, a.y - py * aMult));
                  b.x = Math.max(0.5, Math.min(this.w - 0.5, b.x + px * bMult));
                  b.y = Math.max(0.5, Math.min(this.h - 0.5, b.y + py * bMult));
                } else {
                  const pass = aDom === "sea" ? this.passableSea : this.passable;
                  if (pass((a.x - px * aMult) | 0, (a.y - py * aMult) | 0)) {
                    a.x -= px * aMult;
                    a.y -= py * aMult;
                  }
                  if (pass((b.x + px * bMult) | 0, (b.y + py * bMult) | 0)) {
                    b.x += px * bMult;
                    b.y += py * bMult;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  private checkEnd() {
    if (this.winner !== null) return;
    if (this.players.size < 2) return; // solo games run until a rematch
    for (const p of this.players.values()) {
      if (p.eliminated) continue;
      let alive = false;
      for (const e of this.ents.values())
        if (e.o === p.slot) {
          alive = true;
          break;
        }
      if (!alive) {
        p.eliminated = true;
        this.events.push({ e: "elim", slot: p.slot });
      }
    }
    const alivePlayers = [...this.players.values()].filter((p) => !p.eliminated);
    if (alivePlayers.length === 0) return;
    if (alivePlayers.length === 1) {
      this.winner = alivePlayers[0].slot;
      this.winnerTeam = alivePlayers[0].team > 0 ? alivePlayers[0].team : null;
      return;
    }
    const firstTeam = alivePlayers[0].team;
    if (firstTeam > 0 && alivePlayers.every((p) => p.team === firstTeam)) {
      this.winner = alivePlayers[0].slot;
      this.winnerTeam = firstTeam;
    }
  }

  snapshot(): { ents: EntSnap[]; crates: CrateSnap[]; players: Record<number, PlayerState>; events: GameEvent[] } {
    const ents: EntSnap[] = [];
    for (const e of this.ents.values()) {
      const s: EntSnap = {
        id: e.id,
        o: e.o,
        k: e.k === "spy" && this.tick >= e.spottedUntil ? "infantry" : e.k,
        x: Math.round(e.x * 100) / 100,
        y: Math.round(e.y * 100) / 100,
        hp: Math.max(0, Math.round(e.hp)),
        mhp: e.mhp,
        d: Math.round(e.d * 10),
      };
      if (e.k === "harvester" || e.k === "supplytruck") s.cargo = Math.round(e.cargo);
      if (this.config.logistics !== false && !isBuilding(e.k)) {
        const fl = Math.round(e.fuel);
        const am = Math.round(e.ammo);
        if (fl < 100) s.fl = fl;
        if (am < 100) s.am = am;
      }
      if (e.vet > 0) s.vet = e.vet;
      if (e.hold) s.hold = true;
      if (this.isStealthed(e)) s.sub = true;
      if (e.k === "spy" && this.tick >= e.spottedUntil) s.disg = "spy";
      if (e.fpvAlt !== undefined) s.alt = Math.round(e.fpvAlt * 100) / 100;
      if (e.rally) s.rally = [e.rally[0], e.rally[1]];
      if (!isBuilding(e.k) && (e.order || e.orderQueue.length)) {
        const wp: [number, number, OrderKind][] = [];
        const pushOrd = (ord: Order) => {
          let ox = ord.x,
            oy = ord.y;
          if (ord.kind === "attack" && ord.target != null) {
            const t = this.ents.get(ord.target);
            if (t) {
              ox = t.x;
              oy = t.y;
            }
          }
          wp.push([Math.round(ox * 10) / 10, Math.round(oy * 10) / 10, ord.kind]);
        };
        if (e.order) pushOrd(e.order);
        for (const q of e.orderQueue) pushOrd(q);
        if (wp.length) s.wp = wp;
      }
      ents.push(s);
    }
    const players: Record<number, PlayerState> = {};
    for (const p of this.players.values()) {
      const qCopy: Partial<Record<ProdCat, ProdQueue>> = {};
      for (const cat of PROD_CATS) if (p.queues[cat]) qCopy[cat] = { ...p.queues[cat]! };
      const ps: PlayerState = {
        slot: p.slot,
        credits: Math.floor(p.credits),
        pwrHave: p.pwrHave,
        pwrUse: p.pwrUse,
        lowPower: p.lowPower,
        eliminated: p.eliminated,
        awaiting: p.awaiting,
        bq: p.bq ? { ...p.bq } : null,
        awaitingDef: p.awaitingDef,
        dq: p.dq ? { ...p.dq } : null,
        queues: qCopy,
        team: p.team,
      };
      if (p.swLeft >= 0) {
        ps.swReady = p.swLeft <= 0 && !p.lowPower;
        ps.swLeft = Math.ceil(p.swLeft);
        ps.swTotal = SW_CHARGE_TICKS;
      }
      if (p.reconLeft >= 0) {
        ps.reconReady = p.reconLeft <= 0 && !p.lowPower;
        ps.reconLeft = Math.ceil(p.reconLeft);
        ps.reconTotal = RECON_CHARGE_TICKS;
      }
      ps.prodBoost = {
        barracks: this.prodBoostOf(p.slot, "barracks"),
        factory: this.prodBoostOf(p.slot, "factory"),
        airfield: this.prodBoostOf(p.slot, "airfield"),
        shipyard: this.prodBoostOf(p.slot, "shipyard"),
      };
      players[p.slot] = ps;
    }
    const events = this.events;
    this.events = [];
    return { ents, crates: [...this.crates.values()], players, events };
  }
}
