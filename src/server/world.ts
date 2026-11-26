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
  UPGRADED_OF,
  ARMOR_MULTS,
  matchesArmorClass,
  isInfantryKind,
  isSeaShipKind,
  transportCapOf,
  usesVehicleSeparation,
  WEAPON_FX_OF,
  AMMO_COST_OF,
  KAMIKAZE_FUEL_BURN,
  FUEL_BURN_OF,
  DOMAIN_FUEL_BURN,
  getSpawns,
  getMapLayout,
} from "../shared/gamedefs";
import type {
  OrderKind,
  EntSnap,
  CrateSnap,
  PlayerState,
  ProdItem,
  GameEvent,
  WeaponFx,
  MatchStats,
} from "../shared/protocol";
import { findPath, nearestPassable, AstarEngine, PATH_STATS } from "./path";

const MAX_WAYPOINTS = 16;
// Production tuning lives here rather than shared/gamedefs.ts: these are sim
// pacing constants, not unit/building definitions. The unit queue cap is
// mirrored by the client sidebar (display-only); cmdTrain remains authoritative.
const MAX_TRAIN_QUEUE = 30;
const PROD_BOOST_PER_EXTRA = 0.25; // duplicate producer speed gain (+25% per extra)
const PROD_BOOST_CAP = 2.0;
const CRATE_KINDS: readonly CrateKind[] = ["cash", "vet", "heal", "unit"];
// Troop transport tuning: helicopters hover (there is no landed state in this sim —
// aircraft are always airborne), so they load/unload anywhere they can hover.
const BOARD_RANGE = 2.0; // infantry within this distance of the transport embarks
const UNLOAD_EVERY = 3; // ticks between passenger drops once the transport arrives
const UNLOAD_SEARCH_R = 8; // passable-tile search radius around the landing point

const hasOwn = (o: object, k: unknown): boolean =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
const multiProducerBoost = (count: number): number =>
  Math.min(PROD_BOOST_CAP, 1 + Math.max(0, count - 1) * PROD_BOOST_PER_EXTRA);

// Per-tick A* expansion budget. Searches are budgeted by work done, not count:
// a single legitimate transcontinental search on a 256×256 map can need ~43k
// expansions (~15ms), so a per-search-count budget cannot bound tick cost —
// but incremental (resumable) search plus an expansion budget can. At the
// measured ~0.3µs/expansion this caps worst-case pathfinding at ~2.5ms/tick;
// the median tick needs only tens of expansions, so deferred work drains
// quickly after spike waves.
const ASTAR_TICK_EXPANSIONS = 8000;
// Attack-move/patrol target acquisition scans are phased across this many
// ticks (unit scans when (tick + id) % N === 0). Worst-case added acquisition
// latency is N-1 ticks (~100ms) — invisible next to weapon cooldowns — while
// the per-tick scan cost drops ~N-fold. Tracking validation of an already
// acquired target still runs every tick (it is cheap).
const SCAN_PHASE_TICKS = 3;
// Slice of the expansion budget reserved for economy-critical short searches
// (harvester/bridge, pri=true) whenever any are waiting. Without the reserve,
// a saturated transcontinental backlog consumes the entire budget in the head
// search every tick and economy jobs — though only a few hundred expansions
// each — never get a slice (measured: megacontinent ore income falls to ~0 at
// high unit counts even though the jobs themselves are tiny).
const ASTAR_PRI_RESERVE = 3000;
// Per-search expansion cap for the short atomic harvester/bridge searches —
// ~1.8ms worst case each, vs up to ~20ms for a full-map search. Targets are
// close by design (nearest ore/refinery), so this rarely binds.
const ASTAR_ATOMIC_CAP = 6000;

// A deferred path request. Strictly FIFO: the queue is drained in request
// order each tick, and at most one job is ever loaded in the incremental
// engine (necessarily the head) because the scratch is serial-only.
interface PathJob {
  e: Ent;
  ord: Order | null; // order object at request time — staleness validation
  kind: "move" | "chase";
  pri: boolean; // economy-critical short hop (harvester/bridge) — jumps the FIFO
  sea: boolean;
  targetId: number; // chase only: resolve the goal from the live target at load time
  gx: number; // requested goal tile (move) or diagnostic target tile (chase)
  gy: number;
  searchR: number; // nearestPassable adjustment radius around the goal
  maxExpand: number;
  loaded: boolean; // engine state loaded (only ever true for the queue head)
  cancelled: boolean; // lazy deletion — physically dropped when it reaches the head
}

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
  bTiles?: number[]; // engineer: pending pontoon-bridge tiles to lay (ordered near→far)
  bT?: number; // ticks until next bridge tile completes
  bFail?: number; // consecutive failed pathfinds to the bridge approach
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
  // set while a player-piloted transport is rappelling passengers beneath itself
  // (FPV unload): the pilot is the navigation, so no positional order exists — the
  // flag simply drips one passenger every few ticks wherever the transport hovers.
  fpvDrop?: boolean;
  // troop transport cargo: embarked infantry, stored as FULL ent records (ids never recycle,
  // so a passenger re-enters the world with its identity/veterancy intact on unload).
  // Passengers are NOT in the world ents map while embarked — invisible, untargetable,
  // unticked; their position mirrors the transport. They die with it (classic RTS rule).
  passengers?: Ent[];
}

export interface P {
  slot: number;
  team: number; // 0 = FFA, 1..4 = allied team
  credits: number;
  awaiting: BuildingKind[]; // finished structures stacked for placement
  bq: { kind: BuildingKind; left: number; total: number }[]; // head builds, rest queued
  awaitingDef: BuildingKind[]; // defense has a parallel queue
  dq: { kind: BuildingKind; left: number; total: number }[];
  queues: Partial<Record<ProdCat, ProdItem[]>>;
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
  ore?: Int16Array; // stored under a separate DO key at a slower cadence
  bridges?: number[];
  lastAlert: [number, number][];
}

const EMPTY_ENTS: Ent[] = [];
const DIRS4: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const PROD_CATS: readonly ProdCat[] = ["barracks", "factory", "airfield", "shipyard"];
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
const usesFuel = (k: EntKind): boolean =>
  !isBuilding(k) && !isInfantryKind(k) && k !== "supplytruck" && k !== "harvester";
const fuelBurnOf = (k: EntKind, dom: UnitDomain): number =>
  FUEL_BURN_OF[k] ?? (isKamikaze(k) ? KAMIKAZE_FUEL_BURN : DOMAIN_FUEL_BURN[dom]);
const ammoCostOf = (k: EntKind): number => (isKamikaze(k) ? 0 : AMMO_COST_OF[k] ?? 4);

const armorMult = (attacker: EntKind, target: EntKind): number => {
  for (const rule of ARMOR_MULTS[attacker] ?? []) {
    if (rule.kinds?.includes(target) || rule.classes?.some((cls) => matchesArmorClass(cls, target))) return rule.mult;
  }
  return 1;
};

const pointDistToEnt = (px: number, py: number, t: Ent) => {
  if (!isBuilding(t.k)) return dist(px, py, t.x, t.y);
  const bd = BUILDINGS[t.k];
  return Math.hypot(
    Math.max(0, Math.abs(px - t.x) - bd.w / 2),
    Math.max(0, Math.abs(py - t.y) - bd.h / 2),
  );
};
const entityDist = (a: Ent, b: Ent) => pointDistToEnt(a.x, a.y, b);
const weaponFxOf = (k: EntKind): WeaponFx => WEAPON_FX_OF[k] ?? "bullet";
const MAX_BUILDING_EDGE_PAD = Math.max(...Object.values(BUILDINGS).map((d) => Math.hypot(d.w / 2, d.h / 2)));
const GRID_POS_PAD = 4;
// weapon stats are pure functions of kind — cache to keep the per-ent-per-tick path alloc-free
const wpnCache = new Map<string, { range: number; dmg: number; rof: number }>();
const weaponOf = (e: Ent) => {
  let w = wpnCache.get(e.k);
  if (!w) {
    w = isBuilding(e.k)
      ? { range: BUILDINGS[e.k].range ?? 0, dmg: BUILDINGS[e.k].dmg ?? 0, rof: BUILDINGS[e.k].rof ?? 0 }
      : { range: UNITS[e.k as UnitKind].range, dmg: UNITS[e.k as UnitKind].dmg, rof: UNITS[e.k as UnitKind].rof };
    wpnCache.set(e.k, w);
  }
  return w;
};

// AC-130 gunship selectable guns — chosen by drive msg `wpn` slot while player-driven only.
// The UNITS.ac130 base def stays the AI/auto-attack profile; ammo cost unchanged (ammoCostOf).
const AC130_GUNS: readonly { name: string; dmg: number; rof: number; splash: number; fx: WeaponFx }[] = [
  { name: "105MM", dmg: 55, rof: 90, splash: 2.6, fx: "cannon" },
  { name: "40MM", dmg: 22, rof: 30, splash: 1.2, fx: "cannon" },
  { name: "25MM", dmg: 7, rof: 4, splash: 0.35, fx: "brrrt" },
];

const copyOrder = (o: Order): Order => ({
  ...o,
  patrolFrom: o.patrolFrom ? [o.patrolFrom[0], o.patrolFrom[1]] : o.patrolFrom,
});
const copyEnt = (e: Ent): Ent => ({
  ...e,
  order: e.order ? copyOrder(e.order) : null,
  orderQueue: e.orderQueue.map(copyOrder),
  path: e.path ? e.path.map((p) => ({ ...p })) : null,
  bTiles: e.bTiles ? [...e.bTiles] : e.bTiles,
  rally: e.rally ? [e.rally[0], e.rally[1]] : e.rally,
  direct: e.direct ? { ...e.direct } : e.direct,
  passengers: e.passengers ? e.passengers.map(copyEnt) : e.passengers,
});
const copyPlayer = (p: P): P => {
  const queues: P["queues"] = {};
  for (const cat of PROD_CATS) {
    const q = p.queues[cat];
    if (q) queues[cat] = q.map((item) => ({ ...item }));
  }
  return {
    ...p,
    awaiting: [...p.awaiting],
    bq: p.bq.map((item) => ({ ...item })),
    awaitingDef: [...p.awaitingDef],
    dq: p.dq.map((item) => ({ ...item })),
    queues,
  };
};

export class World {
  readonly w: number;
  readonly h: number;
  tick!: number;
  map: MapId;
  config: GameConfig;
  winner!: number | null;
  winnerTeam!: number | null;
  ents!: Map<number, Ent>;
  players!: Map<number, P>; // keyed by slot
  crates!: Map<number, CrateSnap>;
  events!: GameEvent[];

  private block!: Uint8Array; // 1 = building footprint
  private cliff!: Uint8Array; // 1 = impassable rocky cliff
  private water!: Uint8Array; // 1 = navigable water
  bridges!: Set<number>; // pontoon-bridge tiles — land+sea passable, still water underneath
  private bridgeMask!: Uint8Array; // hot-path mirror of `bridges` — passable() runs millions of tile checks per second of heavy pathing, Set.has is far pricier than a typed-array load
  private waterCount!: number;
  // connectivity labels per tile for land/sea passability — an A* whose goal
  // sits in a different region than the start is PROVABLY hopeless, so it
  // fails in O(1) instead of expanding the entire reachable region (the
  // dominant tick cost on naval maps: 93% of searches were unreachable-goal
  // scans). Rebuilt lazily on the first path query after block/bridge mutation.
  private regionLand!: Int32Array;
  private regionSea!: Int32Array;
  private regionQ!: Int32Array; // flood-fill scratch
  private regionDirty!: boolean;
  private regionLandSizes!: number[]; // tiles per land-region id — rebuilt with the grids
  private regionSeaSizes!: number[];
  // Baked per-tile passability for the A* expansion loops (1 = passable).
  // Derived from block/cliff/water/bridgeMask and maintained INCREMENTALLY at
  // every mutation point (building place/destroy footprint, bridge tile), so
  // the masks are bit-exact mirrors of the passable()/passableSea() closures
  // at all times — including mid-step mutations, which a paused incremental
  // search must observe on resume exactly like the old live closure reads.
  private passLand!: Uint8Array;
  private passSea!: Uint8Array;
  private bld!: Int32Array; // ent id per tile
  private ore!: Int16Array; // remaining per tile
  private nextId!: number;
  private nextCrateId!: number;
  // Incremental A* service: per-tick expansion budget + FIFO queue of deferred
  // searches. Small searches still complete synchronously inline (zero latency)
  // whenever nothing is queued; big ones spread across ticks instead of spiking.
  private astarEngine!: AstarEngine;
  private astarExpandLeft!: number; // expansions remaining this tick
  // count budget for short ATOMIC harvester/bridge searches. These are hard to
  // defer correctly (their state machines consume the result synchronously,
  // and congestion experiments showed FIFO/queued variants starving the
  // economy on huge maps), so they run inline like the pre-refactor code —
  // but each is capped well below the map-size expansion cap, bounding the
  // worst-case atomic cost per tick. harvester/bridge targets are inherently
  // near (nearest ore/refinery/shore), so the cap rarely binds; when it does
  // the existing backoff logic treats it as unreachable, exactly like the
  // pre-refactor maxExpand cap.
  private astarAtomicLeft!: number;
  private pathQ!: PathJob[];
  private pathQHead!: number;
  private pathQMap!: Map<number, PathJob>; // ent id -> pending job (dedup/matching)
  private pathQPri!: number; // live pri jobs waiting (drives the reserve)
  private lastAlert!: Map<number, number>; // slot -> tick of last under-attack alert
  private gridCols!: number;
  private gridRows!: number;
  private grid!: Ent[][]; // dynamic 8x8 tile spatial buckets
  // dedicated fine (2x2 tile) grid for separation pairs — separation radii
  // (0.72–1.35 tiles) are far smaller than the coarse 8x8 buckets, so the coarse
  // neighborhood produced ~16x false-positive pair candidates in dense combat
  private sepCols!: number;
  private sepRows!: number;
  private sepGrid!: Ent[][];
  private sepUsed!: number[]; // indices of non-empty cells — avoids clearing 16k arrays/tick
  private subDetMask!: Map<number, number>; // sub ent id -> bitmask of slots that detect it this tick
  private gridTick!: number;
  // canPlace unit-occupancy cache: bit0 = land-domain unit on tile, bit1 = sea.
  // Entity positions only mutate inside step() (commands merely set orders), so
  // within one tick every canPlace call observes the same occupancy — scan ents
  // once instead of once per candidate tile (bot placement probes hundreds of
  // candidates per think, making the old O(ents)-per-candidate scan the worst
  // single-tick server cost). entsMut covers command-time entity mutations
  // (sell/superweapon) within the same tick.
  private occMask!: Uint8Array | null;
  private occTick!: number;
  private occMut!: number;
  private entsMut!: number;
  private oreSnapCache!: [number, number, number][] | null; // per-tick oreSnapshot memo
  private oreSnapTick!: number;
  private names: Record<number, string>;

  private idx(x: number, y: number): number {
    return y * this.w + x;
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  private initRuntimeState() {
    this.tick = 0;
    this.winner = null;
    this.winnerTeam = null;
    this.ents = new Map();
    this.players = new Map();
    this.crates = new Map();
    this.events = [];
    this.bridges = new Set();
    this.nextId = 1;
    this.nextCrateId = 1;
    this.astarEngine = new AstarEngine();
    this.astarExpandLeft = 0;
    this.astarAtomicLeft = 0;
    this.pathQ = [];
    this.pathQHead = 0;
    this.pathQMap = new Map();
    this.pathQPri = 0;
    this.lastAlert = new Map();
    this.subDetMask = new Map();
    this.gridTick = -1;
    this.teamArr = new Int8Array(16);
    this.teamSize = -1;
    this.slotCnt = new Int16Array(16);
    this.oreTakenMap = null;
    this.oreTiles = null;
    this.occMask = null;
    this.occTick = -1;
    this.occMut = -1;
    this.entsMut = 0;
    this.oreSnapCache = null;
    this.oreSnapTick = -1;
    this.bldIdx = new Map();
    this.bldAll = [];
    this.domeIdx = [];
    this.ecoIdx = [];
    this.bldDirty = true;
    this.regionDirty = true;
    this.passable = (x: number, y: number) =>
      this.inBounds(x, y) &&
      this.block[this.idx(x, y)] === 0 &&
      this.cliff[this.idx(x, y)] === 0 &&
      (this.water[this.idx(x, y)] === 0 || this.bridgeMask[this.idx(x, y)] === 1);
    this.passableSea = (x: number, y: number) =>
      this.inBounds(x, y) && this.block[this.idx(x, y)] === 0 && this.cliff[this.idx(x, y)] === 0 && this.water[this.idx(x, y)] === 1;
  }

  private initMapState(layout: ReturnType<typeof getMapLayout>): number {
    const area = this.w * this.h;
    this.block = new Uint8Array(area);
    this.cliff = new Uint8Array(area);
    this.water = new Uint8Array(area);
    this.bld = new Int32Array(area).fill(-1);
    this.ore = new Int16Array(area);
    this.bridgeMask = new Uint8Array(area);
    this.passLand = new Uint8Array(area);
    this.passSea = new Uint8Array(area);
    this.gridCols = Math.ceil(this.w / 8);
    this.gridRows = Math.ceil(this.h / 8);
    this.grid = Array.from({ length: this.gridCols * this.gridRows }, () => []);
    this.sepCols = Math.ceil(this.w / 2);
    this.sepRows = Math.ceil(this.h / 2);
    this.sepGrid = Array.from({ length: this.sepCols * this.sepRows }, () => []);
    this.sepUsed = [];
    this.waterCount = 0;
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
    for (let i = 0; i < area; i++) this.bakePassAt(i);
    return area;
  }

  // Re-bake the A* passability masks at tile i from the source arrays. Must be
  // called at every block/bridgeMask mutation so passLand/passSea stay exact
  // mirrors of the passable()/passableSea() closures for in-bounds tiles.
  private bakePassAt(i: number) {
    const blocked = this.block[i] !== 0 || this.cliff[i] !== 0;
    const isWater = this.water[i] === 1;
    this.passLand[i] = !blocked && (!isWater || this.bridgeMask[i] === 1) ? 1 : 0;
    this.passSea[i] = !blocked && isWater ? 1 : 0;
  }

  constructor(slots: number[], opts?: WorldOpts) {
    this.map = opts?.map ?? "crossroads";
    this.config = { ...DEFAULT_CONFIG, ...(opts?.config ?? {}) };
    this.names = opts?.names ? { ...opts.names } : {};
    const layout = getMapLayout(this.map);
    this.w = layout.w;
    this.h = layout.h;
    this.initRuntimeState();
    this.initMapState(layout);

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
        awaiting: [],
        bq: [],
        awaitingDef: [],
        dq: [],
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
      config: { ...this.config },
      tick: this.tick,
      winner: this.winner,
      winnerTeam: this.winnerTeam,
      nextId: this.nextId,
      nextCrateId: this.nextCrateId,
      names: { ...this.names },
      ents: [...this.ents.values()].map(copyEnt),
      players: [...this.players.values()].map(copyPlayer),
      crates: [...this.crates.values()].map((c) => ({ ...c })),
      ore: this.ore.slice(),
      bridges: [...this.bridges],
      lastAlert: [...this.lastAlert.entries()].map(([slot, tick]): [number, number] => [slot, tick]),
    };
  }

  static deserialize(d: WorldSave): World {
    const w = Object.create(World.prototype) as World;
    const layout = getMapLayout(d.map);
    w.map = d.map;
    w.config = { ...DEFAULT_CONFIG, ...d.config };
    (w as { w: number }).w = layout.w;
    (w as { h: number }).h = layout.h;
    w.initRuntimeState();
    const area = w.initMapState(layout);
    w.bridges = new Set(d.bridges ?? []);
    for (const b of w.bridges) if (b >= 0 && b < area) w.bridgeMask[b] = 1;
    if (d.ore && d.ore.length === area) w.ore = new Int16Array(d.ore);
    else w.genOre((d.players ?? []).map((p) => p.slot));
    w.tick = d.tick;
    w.winner = d.winner;
    w.winnerTeam = d.winnerTeam;
    w.nextCrateId = d.nextCrateId;
    w.names = { ...d.names };
    // fill fields older saves may lack — a missing field otherwise produces
    // NaN-propagation or a per-tick crash (the zombie-match failure mode)
    const ENT_DEFAULTS: Partial<Ent> = {
      order: null, orderQueue: [], path: null, cd: 0, cargo: 0, fuel: 100, ammo: 100,
      hstate: null, oreIdx: -1, repath: 0, agro: null, hold: false, holdUntil: 0,
      xp: 0, vet: 0, subSurfaceUntil: 0, interceptCd: 0, spottedUntil: 0, sabUntil: 0,
    };
    w.ents = new Map(
      (d.ents ?? []).map((e) => {
        const r = e as unknown as Record<string, unknown>;
        for (const k in ENT_DEFAULTS) if (r[k] === undefined) r[k] = (ENT_DEFAULTS as Record<string, unknown>)[k];
        // transport cargo hardening: passengers are nested full ent records — they need the
        // same default-fill, and anything malformed is dropped rather than crashing a later tick
        if (r.passengers !== undefined) {
          if (Array.isArray(r.passengers)) {
            r.passengers = r.passengers.filter((p2) => {
              if (!p2 || typeof p2 !== "object") return false;
              const pr = p2 as Record<string, unknown>;
              if (!Number.isFinite(pr.id) || typeof pr.k !== "string") return false;
              for (const k in ENT_DEFAULTS) if (pr[k] === undefined) pr[k] = (ENT_DEFAULTS as Record<string, unknown>)[k];
              delete pr.passengers; // no nesting — only infantry (never transports) can board
              return true;
            });
            if ((r.passengers as unknown[]).length === 0) delete r.passengers;
          } else {
            delete r.passengers;
          }
        }
        return [e.id, e];
      }),
    );
    // normalize pre-queue saves: singletons → arrays
    for (const p of d.players ?? []) {
      if (!Array.isArray(p.awaiting)) p.awaiting = p.awaiting ? [p.awaiting] : [];
      if (!Array.isArray(p.bq)) p.bq = p.bq ? [p.bq] : [];
      if (!Array.isArray(p.awaitingDef)) p.awaitingDef = p.awaitingDef ? [p.awaitingDef] : [];
      if (!Array.isArray(p.dq)) p.dq = p.dq ? [p.dq] : [];
      p.queues ??= {};
      p.swLeft ??= -1;
      p.reconLeft ??= -1;
      // pre-FIFO saves: {unit,left,total,count} → expanded array
      for (const c of PROD_CATS) {
        const q = p.queues?.[c] as unknown;
        if (q && !Array.isArray(q)) {
          const old = q as { unit: UnitKind; left: number; total: number; count: number };
          p.queues[c] = [{ unit: old.unit, left: old.left, total: old.total }];
          for (let i = 1; i < (old.count ?? 1); i++) p.queues[c]!.push({ unit: old.unit, left: old.total, total: old.total });
        }
      }
    }
    w.players = new Map((d.players ?? []).map((p) => [p.slot, p]));
    w.crates = new Map((d.crates ?? []).map((c) => [c.id, c]));
    w.lastAlert = new Map(d.lastAlert ?? []);
    for (const e of w.ents.values()) if (e.o >= 0) w.slotCnt[e.o]++;
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
    return w;
  }

  // flat slot→team lookup for isAlly — rebuilt when players change (rare)
  private teamArr!: Int8Array;
  private teamSize!: number;
  // per-slot live entity counts for O(1) elimination checks
  private slotCnt!: Int16Array;
  isAlly(slotA: number, slotB: number): boolean {
    if (slotA < 0 || slotB < 0) return false; // neutral is nobody's ally, not even neutral's
    if (slotA === slotB) return true;
    if (this.teamSize !== this.players.size) {
      this.teamArr.fill(0);
      for (const p of this.players.values()) this.teamArr[p.slot] = p.team;
      this.teamSize = this.players.size;
    }
    return this.teamArr[slotA] > 0 && this.teamArr[slotA] === this.teamArr[slotB];
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
    // Starter ore must land on a real tile: the blob center always paints (d = 0),
    // so snap it to the nearest ore-able tile ≤10 from the spawn. Island/naval
    // spawns can otherwise put the fixed offset into the sea and start ore-starved.
    const oreable = (x: number, y: number) => {
      if (!this.inBounds(x, y)) return false;
      const i = this.idx(x, y);
      return !this.cliff[i] && !this.block[i] && !this.water[i];
    };
    for (const slot of slots) {
      const s = spawns[slot];
      if (!s) continue;
      let cx = s.x < this.w / 2 ? s.x + 8 : s.x - 6;
      let cy = s.y < this.h / 2 ? s.y + 9 : s.y - 7;
      if (!oreable(cx, cy)) {
        const cheb = (x: number, y: number) => Math.max(Math.abs(x - s.x), Math.abs(y - s.y));
        const p =
          nearestPassable(cx, cy, (x, y) => oreable(x, y) && cheb(x, y) <= 10, 14, this.w, this.h) ??
          nearestPassable(s.x, s.y, (x, y) => oreable(x, y) && cheb(x, y) >= 4, 10, this.w, this.h) ??
          nearestPassable(s.x, s.y, oreable, 10, this.w, this.h);
        if (p) {
          cx = p.x;
          cy = p.y;
        }
      }
      blob(cx, cy, 3);
    }
    blob(Math.floor(this.w / 2), Math.floor(this.h / 2), 4); // contested center field
    for (const [cx, cy, r] of getMapLayout(this.map).extraOre ?? []) {
      blob(cx, cy, r);
    }
  }

  oreSnapshot(): [number, number, number][] {
    // Ore only mutates inside step() (harvesting, regen), so every caller in the
    // same inter-step window sees identical state — build the scan once per tick.
    // Consumers (bot oreCache) treat the result as read-only, so the array itself
    // is shared rather than copied — thousands of tuple allocations per aligned
    // bot-scan tick otherwise.
    if (this.oreSnapCache && this.oreSnapTick === this.tick) return this.oreSnapCache;
    const out: [number, number, number][] = [];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) if (this.ore[this.idx(x, y)] > 0) out.push([x, y, this.ore[this.idx(x, y)]]);
    this.oreSnapCache = out;
    this.oreSnapTick = this.tick;
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

  // Land connectivity region id for a tile — 0 when impassable for ground units
  // (water without a bridge, cliff, or inside a building footprint). Two tiles in
  // different regions are mutually unreachable for land units: the same lazy flood
  // fill that gates A* (regionDirty-aware), exposed so bots can tell "across the
  // water" apart from "a long walk" and commit transports instead of futile orders.
  landRegion(x: number, y: number): number {
    if (this.regionDirty) this.recomputeRegions();
    const ix = Math.floor(x),
      iy = Math.floor(y);
    if (!this.inBounds(ix, iy)) return 0;
    return this.regionLand[iy * this.w + ix];
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
      return isSeaShipKind(detectorKind) || detectorKind === "radar" || detectorKind === "uav" ? 9 : 5.5;
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
      this.gridInsert(e);
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

  passable!: (x: number, y: number) => boolean;
  passableSea!: (x: number, y: number) => boolean;

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
    this.gridInsert(e);
    this.bldDirty = true;
    this.regionDirty = true;
    if (e.o >= 0) this.slotCnt[e.o]++;
    for (let y = ty; y < ty + d.h; y++)
      for (let x = tx; x < tx + d.w; x++)
        if (this.inBounds(x, y)) {
          const i = this.idx(x, y);
          this.block[i] = 1;
          this.bld[i] = e.id;
          this.bakePassAt(i);
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
    this.gridInsert(e);
    this.entsMut++;
    if (e.o >= 0) this.slotCnt[e.o]++;
    this.events.push({ e: "spawn", id: e.id });
    return e;
  }

  // Bounded flood of the passable region containing a seed point. Returns null when
  // the region is unbounded (cap hit) — connectivity checks only matter on islands/ponds.
  private regionAround(x0: number, y0: number, pass: (x: number, y: number) => boolean, cap = 2048): Set<number> | null {
    const start = nearestPassable(x0, y0, pass, 10, this.w, this.h);
    if (!start) return new Set();
    // O(1) cap answer: the BFS below explores exactly the passable-connected region
    // of the seed tile, so it returns null iff that region holds >= cap tiles. The
    // region grids measure the same connectivity (block/cliff/water/bridge tests are
    // identical to the passable closures), so a big enough region can never yield a
    // set — answer null without the doomed 2048-tile flood. Recomputing dirty regions
    // here is bookkeeping only and keeps the grid bit-aligned with live passability.
    if (pass === this.passable || pass === this.passableSea) {
      if (this.regionDirty) this.recomputeRegions();
      const grid = pass === this.passableSea ? this.regionSea : this.regionLand;
      const sizes = pass === this.passableSea ? this.regionSeaSizes : this.regionLandSizes;
      if (this.inBounds(start.x, start.y)) {
        const rid = grid[this.idx(start.x, start.y)];
        if (rid > 0 && sizes[rid] >= cap) return null;
      }
    }
    const s0 = this.idx(start.x, start.y);
    const seen = new Set<number>([s0]);
    const q = [s0];
    for (let qi = 0; qi < q.length && seen.size < cap; qi++) {
      const t = q[qi];
      const lx = t % this.w,
        ly = (t / this.w) | 0;
      for (const [dx, dy] of DIRS4) {
        const nx = lx + dx,
          ny = ly + dy;
        if (!this.inBounds(nx, ny)) continue;
        const n = this.idx(nx, ny);
        if (!seen.has(n) && pass(nx, ny)) {
          seen.add(n);
          q.push(n);
        }
      }
    }
    return seen.size >= cap ? null : seen;
  }

  private spawnNearBuilding(slot: number, kind: UnitKind, b: Ent) {
    const def = BUILDINGS[b.k as BuildingKind];
    const bx = b.x - def.w / 2,
      by = b.y - def.h / 2;
    const uDomain = UNITS[kind].domain;
    // Occupied tiles of the same domain, from the shared per-tick mask — the old
    // per-call scan was O(ents) for every unit produced. idx() is injective per
    // coordinate pair, so dropping out-of-bounds units (the mask is bounded)
    // cannot change any in-bounds lookup below. spawnUnit bumps entsMut, so a
    // second spawn in the same tick rebuilds the mask and sees the first unit.
    const occMask = this.unitOccupancy();
    const obit = uDomain === "sea" ? 2 : uDomain === "air" ? 4 : 1;
    const occ = { has: (i: number) => (occMask[i] & obit) !== 0 };
    if (uDomain === "air") {
      // Air units spawn right over or around the airfield (ignoring buildings/cliffs/water)
      const cx = Math.floor(b.x),
        cy = Math.floor(b.y);
      if (this.inBounds(cx, cy) && !occ.has(this.idx(cx, cy))) return this.spawnUnit(slot, kind, cx, cy);
      for (let r = 1; r <= 6; r++) {
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = cx + dx,
              y = cy + dy;
            if (this.inBounds(x, y) && !occ.has(this.idx(x, y))) return this.spawnUnit(slot, kind, x, y);
          }
      }
      return this.spawnUnit(slot, kind, Math.max(0, Math.min(this.w - 1, cx)), Math.max(0, Math.min(this.h - 1, cy)));
    }
    if (uDomain === "sea") {
      // Sea units spawn on navigable water CONNECTED to the shipyard's channel —
      // otherwise a ship can materialize in an enclosed pond and be stranded forever
      const cx = Math.floor(b.x),
        cy = Math.floor(b.y);
      const reach = this.regionAround(cx, cy, this.passableSea);
      const seaOk = (x: number, y: number) =>
        this.passableSea(x, y) && !occ.has(this.idx(x, y)) && (!reach || reach.has(this.idx(x, y)));
      for (let r = 1; r <= 8; r++) {
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = cx + dx,
              y = cy + dy;
            if (seaOk(x, y)) return this.spawnUnit(slot, kind, x, y);
          }
      }
      const spot = nearestPassable(cx, cy, seaOk, 14, this.w, this.h);
      if (spot) return this.spawnUnit(slot, kind, spot.x, spot.y);
      return null;
    }
    // Land: first empty passable tile on an expanding ring below the building,
    // restricted to the building's own landmass (no stranded spawns across water)
    const reach = this.regionAround(bx + (def.w >> 1), by + def.h, this.passable);
    const landOk = (x: number, y: number) =>
      this.passable(x, y) && !occ.has(this.idx(x, y)) && (!reach || reach.has(this.idx(x, y)));
    for (let r = 1; r <= 6; r++) {
      for (let dy = -1; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const x = bx + (def.w >> 1) + dx,
            y = by + def.h + dy;
          if (landOk(x, y)) return this.spawnUnit(slot, kind, x, y);
        }
    }
    const spot = nearestPassable(bx + (def.w >> 1), by + def.h + 1, landOk, 12, this.w, this.h);
    if (spot) return this.spawnUnit(slot, kind, spot.x, spot.y);
    return null;
  }

  // ---------- commands ----------

  // Lazily (re)built per-tile occupancy bitmask for canPlace/spawnNearBuilding —
  // bit0 land-domain unit present, bit1 sea, bit2 air. Rebuilt at most once per
  // (tick, entsMut) pair and only when a placement query actually happens, so
  // ticks without construction scanning pay nothing.
  private unitOccupancy(): Uint8Array {
    if (this.occMask && this.occTick === this.tick && this.occMut === this.entsMut) return this.occMask;
    if (!this.occMask || this.occMask.length !== this.w * this.h) this.occMask = new Uint8Array(this.w * this.h);
    else this.occMask.fill(0);
    for (const u of this.ents.values()) {
      if (isBuilding(u.k)) continue;
      const dom = domainOf(u.k);
      const ux = Math.floor(u.x),
        uy = Math.floor(u.y);
      if (ux < 0 || uy < 0 || ux >= this.w || uy >= this.h) continue;
      this.occMask[uy * this.w + ux] |= dom === "sea" ? 2 : dom === "air" ? 4 : 1;
    }
    this.occTick = this.tick;
    this.occMut = this.entsMut;
    return this.occMask;
  }

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
          if (this.bridges.has(i)) return "blocked by bridge";
        } else {
          if (this.water[i]) return "can't build on water";
          if (this.ore[i] > 0) return "can't build on ore";
        }
      }
    // no same-domain units standing inside the footprint (aircraft overhead don't block construction).
    // Occupancy is keyed by (tick, entsMut): positions only change inside step(), so the
    // per-tick mask is exactly the live scan the loop below replaces.
    const bDomain: UnitDomain = d.waterOnly ? "sea" : "land";
    const occ = this.unitOccupancy();
    const obit = bDomain === "sea" ? 2 : 1;
    for (let y = ty; y < ty + d.h; y++)
      for (let x = tx; x < tx + d.w; x++) {
        if (occ[this.idx(x, y)] & obit) return "units in the way";
      }
    // adjacency: own building within gap <= 2 (or SHIPYARD_BUILD_DIST for waterOnly, or forwardRange for Forward Supply Hubs)
    const maxGap = d.waterOnly ? SHIPYARD_BUILD_DIST : (d.forwardRange ?? 2);
    for (const b of this.bldsOf(slot)) {
      const bd = BUILDINGS[b.k as BuildingKind];
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
    if (
      kind !== "move" &&
      kind !== "amove" &&
      kind !== "attack" &&
      kind !== "harvest" &&
      kind !== "patrol" &&
      kind !== "board" &&
      kind !== "unload"
    )
      return "bad order";
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
      const ox = kind === "attack" || kind === "harvest" || kind === "board" ? 0 : ((i % cols) - (cols - 1) / 2) * 1.15;
      const oy = kind === "attack" || kind === "harvest" || kind === "board" ? 0 : (Math.floor(i / cols) - (rows - 1) / 2) * 1.15;
      const gx = Math.max(0.5, Math.min(this.w - 0.5, x + ox));
      const gy = Math.max(0.5, Math.min(this.h - 0.5, y + oy));

      let ord: Order | null = null;
      let hstate: Ent["hstate"] = null;
      let oreIdx = -1;

      if (kind === "board") {
        // troop transport boarding: only infantry-class units can embark, and only into their
        // OWN transport (allied rides are out of scope). Anything else in a mixed selection —
        // or a board order whose target is no longer a valid ride — degrades to a plain move,
        // mirroring the harvest-escort fallback and classic right-click-on-friendly semantics.
        const tgt = Number.isFinite(target) ? this.ents.get(target as number) : null;
        if (isInfantryKind(e.k) && tgt && tgt.o === slot && transportCapOf(tgt.k) > 0) {
          ord = { kind, x: tgt.x, y: tgt.y, target };
        } else {
          ord = { kind: "move", x: gx, y: gy };
        }
      } else if (kind === "unload") {
        // only transports can disembark passengers — other units in the selection are skipped
        if (transportCapOf(e.k) <= 0) continue;
        // FPV-driven transport: drive packets wipe positional orders every ~55ms and
        // tickDirect never runs the order state machine, so a queued unload could
        // never execute. It doesn't need to — the pilot flies the drop zone in
        // person, so the order collapses to its only meaningful part: rappel the
        // passengers out beneath the transport. Toggles so a second press cancels.
        if (e.direct) {
          if (e.fpvDrop) delete e.fpvDrop;
          else e.fpvDrop = true;
          n++;
          continue;
        }
        ord = { kind, x: gx, y: gy };
      } else if (kind === "harvest" && e.k !== "harvester") {
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
      e.bTiles = undefined;
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

  // Engineer lays a pontoon bridge: walks to the shore approach, then converts water tiles
  // near→far along a water path to a DIFFERENT landmass ($40 & 18 ticks per tile).
  // Max span scales with map width: 16@64, 24@96, 32@128 — the limit exists to keep
  // rivers channel-crossable, and wider maps simply have wider channels.
  // Bridges stay water — ships pass under, land units cross on top.
  cmdBridge(slot: number, id: number, tx: number, ty: number): string | null {
    const e = this.ents.get(id);
    if (!e || e.o !== slot || e.k !== "engineer") return "need an engineer";
    const maxSpan = Math.max(16, Math.round(this.w / 4));
    tx |= 0;
    ty |= 0;
    if (!this.inBounds(tx, ty)) return "off map";
    const x0 = Math.floor(e.x),
      y0 = Math.floor(e.y);
    // Bresenham engineer→click: entry = first water tile on the line
    const line: [number, number][] = [];
    {
      let cx = x0,
        cy = y0;
      const dx = Math.abs(tx - x0),
        dy = Math.abs(ty - y0);
      const sx = x0 < tx ? 1 : -1,
        sy = y0 < ty ? 1 : -1;
      let err = dx - dy;
      for (let guard = 0; guard < this.w + this.h + 4; guard++) {
        line.push([cx, cy]);
        if (cx === tx && cy === ty) break;
        const e2 = err * 2;
        if (e2 > -dy) {
          err -= dy;
          cx += sx;
        }
        if (e2 < dx) {
          err += dx;
          cy += sy;
        }
      }
    }
    let start = -1;
    for (let i = 0; i < line.length; i++)
      if (this.water[this.idx(line[i][0], line[i][1])]) {
        start = i;
        break;
      }
    if (start < 0) return "no water to bridge";
    const [ax, ay] = start > 0 ? line[start - 1] : [x0, y0];
    if (!this.passable(ax, ay)) return "no shore access";
    const entry = this.idx(line[start][0], line[start][1]);
    const approach = this.idx(ax, ay);
    // landmass the engineer stands on (bounded flood) — the bridge must reach a DIFFERENT one
    const landSet = new Set<number>([approach]);
    {
      const q = [approach];
      while (q.length && landSet.size < this.w * this.h) {
        const t = q.pop()!;
        const lx = t % this.w,
          ly = (t / this.w) | 0;
        for (const [dx, dy] of DIRS4) {
          const nx = lx + dx,
            ny = ly + dy;
          if (!this.inBounds(nx, ny)) continue;
          const n = this.idx(nx, ny);
          if (!landSet.has(n) && this.water[n] === 0 && this.cliff[n] === 0 && this.block[n] === 0) {
            landSet.add(n);
            q.push(n);
          }
        }
      }
    }
    // BFS over water from entry; goal = water tile with a land neighbor OUTSIDE landSet
    const prev = new Map<number, number>([[entry, -1]]);
    const q = [entry];
    let goal = -1;
    for (let qi = 0; qi < q.length; qi++) {
      const t = q[qi];
      const lx = t % this.w,
        ly = (t / this.w) | 0;
      // count water-steps so far
      let depth = 0;
      for (let p2 = prev.get(t)!; p2 !== -1; p2 = prev.get(p2)!) depth++;
      if (depth > maxSpan) continue;
      let goalHit = false;
      for (const [dx, dy] of DIRS4) {
        const nx = lx + dx,
          ny = ly + dy;
        if (!this.inBounds(nx, ny)) continue;
        const n = this.idx(nx, ny);
        if (this.water[n] === 1) {
          if (!prev.has(n) && !this.bridges.has(n)) {
            prev.set(n, t);
            q.push(n);
          }
        } else if (this.cliff[n] === 0 && this.block[n] === 0 && !landSet.has(n)) {
          goalHit = true;
        }
      }
      if (goalHit) {
        goal = t;
        break;
      }
    }
    if (goal < 0) return `no far shore within ${maxSpan} tiles`;
    // backtrack → ordered tile list near→far (exclude goal-adjacent land; include all water steps)
    const tiles: number[] = [];
    for (let t = goal; t !== -1; t = prev.get(t)!) {
      if (!this.bridges.has(t)) tiles.push(t);
    }
    tiles.reverse();
    if (!tiles.length) return "already bridged";
    if (tiles.length > maxSpan) return `span too long (max ${maxSpan} tiles)`;
    // verify the engineer can actually reach the approach — otherwise the order stalls forever
    if (
      (Math.floor(e.x) !== ax || Math.floor(e.y) !== ay) &&
      !this.pathfind(Math.floor(e.x), Math.floor(e.y), ax, ay, false, Math.max(2400, this.w * this.h))
    )
      return "can't reach the shore";
    e.bTiles = tiles;
    e.bT = 0;
    e.hold = false;
    e.agro = null;
    e.orderQueue = [];
    e.order = { kind: "bridge", x: ax + 0.5, y: ay + 0.5 };
    e.path = null;
    e.repath = 0;
    return null;
  }

  private advanceOrder(e: Ent) {
    e.order = null;
    e.path = null;
    e.repath = 0;
    e.agro = null;
    e.bTiles = undefined;
    while (e.orderQueue.length) {
      const next = e.orderQueue.shift()!;
      if (next.kind === "attack" && next.target != null) {
        const tgt = this.ents.get(next.target);
        if (!tgt || !this.canAttack(e, tgt)) continue;
      }
      if (next.kind === "board") {
        // queued board orders re-validate at shift time: the transport may have died or
        // been captured away while the infantry walked its earlier waypoints — skip rather
        // than chase a ghost (transports are never buildings, so ownership can't flip, but
        // the target existence check must not regress)
        const tgt = next.target != null ? this.ents.get(next.target) : null;
        if (!tgt || tgt.o !== e.o || transportCapOf(tgt.k) <= 0) continue;
      }
      if (next.kind === "unload" && transportCapOf(e.k) <= 0) continue;
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
      delete e.fpvDrop; // manual rappel stops when the pilot leaves the cockpit
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
    if (kind === "superweapon" && !this.config.superweapons) return "superweapons disabled";
    if (d.waterOnly && !this.hasWater()) return "no water on this map";
    if (d.requires) for (const r of d.requires) if (!this.hasBuilding(slot, r)) return `need a ${r}`;
    if (d.limit != null) {
      let count = 0;
      for (const e of this.bldsOf(slot)) if (e.k === kind) count++;
      for (const k2 of p.awaiting) if (k2 === kind) count++;
      for (const k2 of p.awaitingDef) if (k2 === kind) count++;
      for (const i of p.bq) if (i.kind === kind) count++;
      for (const i of p.dq) if (i.kind === kind) count++;
      if (count >= d.limit) return "limit reached";
    }
    if (p.credits < d.cost) return "insufficient funds";
    if (!this.hasConstructionCapability(slot)) return "need a construction yard or forward supply hub";
    p.credits -= d.cost;
    if (cat === "defense") p.dq.push({ kind, left: d.buildTicks, total: d.buildTicks });
    else p.bq.push({ kind, left: d.buildTicks, total: d.buildTicks });
    return null;
  }

  cmdBuildCancel(slot: number, cat?: BuildCategory, index = 0, awaiting = false, kind?: BuildingKind) {
    const p = this.players.get(slot);
    if (!p) return;
    const drop = (queue: typeof p.bq, ready: BuildingKind[]) => {
      if (awaiting) {
        const i = kind != null ? ready.lastIndexOf(kind) : index;
        if (i >= 0 && i < ready.length) {
          p.credits += BUILDINGS[ready[i]].cost;
          ready.splice(i, 1);
        }
      } else {
        const i = kind != null ? queue.map((q) => q.kind).lastIndexOf(kind) : index;
        if (i >= 0 && i < queue.length) {
          p.credits += BUILDINGS[queue[i].kind].cost;
          queue.splice(i, 1);
        }
      }
    };
    if (cat === "defense") return drop(p.dq, p.awaitingDef);
    if (cat === "structure") return drop(p.bq, p.awaiting);
    // legacy no-cat: cancel the first item found, old priority order
    if (p.bq.length) {
      p.credits += BUILDINGS[p.bq[0].kind].cost;
      p.bq.shift();
    } else if (p.awaiting.length) {
      p.credits += BUILDINGS[p.awaiting[0]].cost;
      p.awaiting.shift();
    } else if (p.dq.length) {
      p.credits += BUILDINGS[p.dq[0].kind].cost;
      p.dq.shift();
    } else if (p.awaitingDef.length) {
      p.credits += BUILDINGS[p.awaitingDef[0]].cost;
      p.awaitingDef.shift();
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
    if (this.bldDirty) this.bldsOf(-1);
    for (const e of this.domeIdx) {
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
    for (const e of this.entsInRange(x, y, SW_RADIUS + MAX_BUILDING_EDGE_PAD + GRID_POS_PAD)) {
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

  cmdPlace(slot: number, tx: number, ty: number, cat?: BuildCategory, kind?: BuildingKind, created?: Ent[]): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "nothing to place";
    const list =
      kind != null
        ? buildCategoryOf(kind) === "defense"
          ? p.awaitingDef
          : p.awaiting
        : cat === "defense"
          ? p.awaitingDef
          : cat === "structure"
            ? p.awaiting
            : p.awaiting.length
              ? p.awaiting
              : p.awaitingDef;
    const i = kind != null ? list.indexOf(kind) : 0;
    if (i < 0 || !list.length) return "nothing to place";
    const k = list[i];
    const err = this.canPlace(slot, k, tx, ty);
    if (err) return err;
    list.splice(i, 1);
    const b = this.placeBuilding(slot, k, tx, ty);
    this.recomputePower(slot);
    created?.push(b);
    if (k === "refinery") {
      const spawned = this.spawnNearBuilding(slot, "harvester", b);
      if (spawned) {
        p.unitsBuilt++;
        created?.push(spawned);
      }
    } else if (k === "superweapon" && p.swLeft < 0) {
      p.swLeft = SW_CHARGE_TICKS;
    } else if (k === "radar" && p.reconLeft < 0) {
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
    const arr = (p.queues[d.trainsAt] ??= []);
    if (arr.length >= MAX_TRAIN_QUEUE) return "queue full";
    p.credits -= d.cost;
    arr.push({ unit, left: d.buildTicks, total: d.buildTicks });
    return null;
  }

  cmdTrainCancel(slot: number, unit?: UnitKind, cat?: ProdCat, index?: number): void {
    const p = this.players.get(slot);
    if (!p) return;
    const cancelAt = (c: ProdCat, i: number) => {
      const arr = p.queues[c];
      if (!arr || i < 0 || i >= arr.length) return;
      p.credits += UNITS[arr[i].unit].cost;
      arr.splice(i, 1);
      if (!arr.length) delete p.queues[c];
    };
    if (cat != null && index != null) return cancelAt(cat, index);
    if (unit != null && hasOwn(UNITS, unit)) {
      const d = UNITS[unit];
      const arr = p.queues[d.trainsAt];
      if (!arr) return;
      return cancelAt(d.trainsAt, arr.map((q) => q.unit).lastIndexOf(unit));
    }
    // no args: cancel tail of the first nonempty queue
    for (const c of PROD_CATS) if (p.queues[c]?.length) return cancelAt(c, p.queues[c]!.length - 1);
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
    delete tgt.rally; // don't send our fresh units to the old owner's rally point
    this.bldDirty = true;
    if (prev >= 0) this.slotCnt[prev]--;
    if (e.o >= 0) this.slotCnt[e.o]++;
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
        // Corrupt the production line — wipe the infiltrated building's unit queue (refunded)
        if (vp) {
          const cat: ProdCat = tgt.k === "barracks" || tgt.k === "barracks2" ? "barracks"
            : tgt.k === "factory" || tgt.k === "factory2" ? "factory"
            : tgt.k === "airfield" || tgt.k === "airfield2" ? "airfield" : "shipyard";
          const arr = vp.queues[cat];
          if (arr?.length) {
            for (const it of arr) vp.credits += UNITS[it.unit].cost;
            delete vp.queues[cat];
          }
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

  // per-slot building index — invalidated on spawn/capture/destroy; saves O(n) Map scans
  private bldIdx!: Map<number, Ent[]>;
  private bldAll!: Ent[];
  private domeIdx!: Ent[]; // thaad + irondome (intercept scans)
  private ecoIdx!: Ent[]; // derrick + coalmine (income ticks)
  private bldDirty!: boolean;
  private bldsOf(slot: number): Ent[] {
    if (this.bldDirty) {
      this.bldIdx.clear();
      this.bldAll.length = 0;
      this.domeIdx.length = 0;
      this.ecoIdx.length = 0;
      for (const e of this.ents.values()) {
        if (!isBuilding(e.k)) continue;
        this.bldAll.push(e);
        let l = this.bldIdx.get(e.o);
        if (!l) this.bldIdx.set(e.o, (l = []));
        l.push(e);
        if (e.k === "thaad" || e.k === "irondome") this.domeIdx.push(e);
        else if (e.k === "derrick" || e.k === "coalmine") this.ecoIdx.push(e);
      }
      this.bldDirty = false;
    }
    return this.bldIdx.get(slot) ?? EMPTY_ENTS;
  }

  // spatial-grid range query over the start-of-tick grid
  private forEachInRange(x: number, y: number, r: number, cb: (e: Ent) => void) {
    const x0 = Math.max(0, ((x - r) | 0) >> 3),
      x1 = Math.min(this.gridCols - 1, ((x + r) | 0) >> 3);
    const y0 = Math.max(0, ((y - r) | 0) >> 3),
      y1 = Math.min(this.gridRows - 1, ((y + r) | 0) >> 3);
    for (let gy = y0; gy <= y1; gy++)
      for (let gx = x0; gx <= x1; gx++) {
        const cell = this.grid[gy * this.gridCols + gx];
        for (let i = 0; i < cell.length; i++) cb(cell[i]);
      }
  }

  private gridInsert(e: Ent) {
    const gx = Math.max(0, Math.min(this.gridCols - 1, (e.x | 0) >> 3));
    const gy = Math.max(0, Math.min(this.gridRows - 1, (e.y | 0) >> 3));
    this.grid[gy * this.gridCols + gx].push(e);
  }

  // Candidates in insertion order (id order), with live positions on the ent references.
  private entsInRange(x: number, y: number, r: number): Ent[] {
    if (this.gridTick !== this.tick) return [...this.ents.values()];
    const out: Ent[] = [];
    this.forEachInRange(x, y, r, (e) => {
      if (this.ents.has(e.id)) out.push(e);
    });
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  private hasBuilding(slot: number, kind: BuildingKind) {
    const upg = UPGRADED_OF[kind];
    for (const e of this.bldsOf(slot)) {
      if (e.k === kind || (upg !== undefined && e.k === upg)) return true;
      if (kind === "power" && (e.k === "coalplant" || e.k === "fusion")) return true;
    }
    return false;
  }

  private buildingsOf(slot: number, kind: BuildingKind) {
    const upg = UPGRADED_OF[kind];
    const out: Ent[] = [];
    for (const e of this.bldsOf(slot))
      if (e.k === kind || (upg !== undefined && e.k === upg)) out.push(e);
    return out;
  }

  private prodBoostOf(slot: number, cat: ProdCat): number {
    return multiProducerBoost(this.buildingsOf(slot, cat).length);
  }

  // Forward Supply Hubs are the buildable backup construction crews: one can
  // keep construction unlocked after the ConYard dies, while duplicate hubs
  // parallelize building fabrication with the same diminishing boost curve as
  // unit-production structures. The ConYard itself is the baseline 1× producer
  // and intentionally does not count toward the forward-hub duplicate bonus.
  private constructionBoostOf(slot: number): number {
    return multiProducerBoost(this.buildingsOf(slot, "supplyhub").length);
  }

  private hasConstructionCapability(slot: number): boolean {
    return this.hasBuilding(slot, "conyard") || this.hasBuilding(slot, "supplyhub");
  }

  private recomputePower(slot: number) {
    const p = this.players.get(slot);
    if (!p) return;
    let have = 0,
      use = 0;
    for (const e of this.bldsOf(slot)) {
      const pw = BUILDINGS[e.k as BuildingKind].power;
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
    this.astarExpandLeft = ASTAR_TICK_EXPANSIONS;
    this.astarAtomicLeft = 2;
    // Drain deferred path requests in FIFO order BEFORE the ent loop, so
    // completions land in e.path in time for the unit's own tick.
    this.processPathQueue();
    this.oreTakenMap = null;
    this.oreTiles = null;
    this.tickProduction();
    // Positions mutate in the tickEnt loop below; any occupancy mask built during
    // production (same tick, same entsMut) would be stale for post-step queries.
    this.occTick = -1;
    this.rebuildSpatialGrid();
    for (const e of [...this.ents.values()]) {
      if (this.ents.has(e.id)) this.tickEnt(e);
    }
    // one grid rebuild per step — separate() works on start-of-tick positions (sub-tile error)
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
    if (this.bldDirty) this.bldsOf(-1); // force index build
    for (const list of this.bldIdx.values())
      for (const d of list) {
        if (d.k !== "depot" || d.o < 0) continue;
        if (this.players.get(d.o)?.lowPower) continue;
        const r2 = DEPOT_RANGE * DEPOT_RANGE;
        this.forEachInRange(d.x, d.y, DEPOT_RANGE + 1, (e) => {
          const dx = e.x - d.x,
            dy = e.y - d.y;
          if (this.isAlly(d.o, e.o) && !isBuilding(e.k) && e.hp < e.mhp && dx * dx + dy * dy <= r2)
            e.hp = Math.min(e.mhp, e.hp + DEPOT_HEAL);
        });
      }
  }

  private tickDerricks() {
    const emitPopup = this.tick % 40 === 0;
    if (this.bldDirty) this.bldsOf(-1); // force index build
    for (const d of this.ecoIdx) {
      if (d.o < 0) continue;
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
      for (const u of this.entsInRange(crate.x, crate.y, 1.2 + GRID_POS_PAD)) {
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
        for (const u of this.entsInRange(collector.x, collector.y, 8 + GRID_POS_PAD)) {
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
        if (this.bld[t] >= 0 || !this.passable(x, y) || this.water[t]) continue;
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
      if (p.eliminated) continue;
      // Unlatch spy power-cut once it expires — recomputePower is event-driven only
      if (p.powerCutUntil && this.tick >= p.powerCutUntil) {
        p.powerCutUntil = 0;
        this.recomputePower(p.slot);
      }
      const rate = p.lowPower ? 0.5 : 1;
      const bh = p.bq[0];
      const dh = p.dq[0];
      const buildRate = bh || dh ? rate * this.constructionBoostOf(p.slot) : rate;
      if (bh) {
        bh.left -= buildRate;
        if (bh.left <= 0) {
          p.awaiting.push(bh.kind);
          p.bq.shift();
        }
      }
      if (dh) {
        dh.left -= buildRate;
        if (dh.left <= 0) {
          p.awaitingDef.push(dh.kind);
          p.dq.shift();
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
        const arr = p.queues[cat];
        if (!arr?.length) continue;
        const head = arr[0];
        const blds = this.buildingsOf(p.slot, cat);
        const boost = multiProducerBoost(blds.length);
        head.left -= rate * boost;
        if (head.left <= 0) {
          // losing the tech prerequisite mid-queue halts production with a refund
          const ud = UNITS[head.unit];
          if (ud.requires && !this.hasBuilding(p.slot, ud.requires)) {
            for (const it of arr) p.credits += UNITS[it.unit].cost;
            delete p.queues[cat];
            continue;
          }
          const upgKind = UPGRADED_OF[cat];
          const b = (upgKind ? blds.find((x) => x.k === upgKind) : undefined) ?? blds[0];
          const spawned = b ? this.spawnNearBuilding(p.slot, head.unit, b) : null;
          if (!spawned) {
            // nowhere to deploy — refund instead of eating the unit
            p.credits += UNITS[head.unit].cost;
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
          arr.shift();
          if (!arr.length) delete p.queues[cat];
        }
      }
    }
  }

  private tickEnt(e: Ent) {
    if (e.cd > 0) e.cd--;
    if (e.interceptCd > 0) e.interceptCd--;
    // embarked passengers ride along — position mirrors the transport every tick
    // (they are outside the world ents map: unticked, untargetable, unrendered)
    if (e.passengers?.length) {
      for (const p of e.passengers) {
        p.x = e.x;
        p.y = e.y;
      }
    }
    if (e.direct) {
      if (this.tick > e.direct.until) {
        delete e.direct;
        delete e.fpvAlt;
        delete e.fpvDrop; // drive session lapsed — manual rappel stops with it
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
    if (o?.kind === "bridge") {
      if (!e.bTiles?.length) {
        this.advanceOrder(e);
      } else {
        const dx = o.x - e.x,
          dy = o.y - e.y;
        if (dx * dx + dy * dy > 0.64) {
          // walk to the shore approach tile first
          if (e.repath-- <= 0) {
            e.repath = 12;
            if (this.astarAtomicLeft > 0) {
              this.astarAtomicLeft--;
              e.path =
                this.pathfind(Math.floor(e.x), Math.floor(e.y), Math.floor(o.x), Math.floor(o.y), false, ASTAR_ATOMIC_CAP) ?? [];
              // unreachable approach — don't burn an A* every 12 ticks forever
              if (!e.path.length) {
                if ((e.bFail = (e.bFail ?? 0) + 1) >= 3) {
                  e.bTiles = undefined;
                  e.bFail = 0;
                  this.advanceOrder(e);
                }
              } else {
                e.bFail = 0;
              }
            } else {
              e.repath = 1;
            }
          }
          this.stepAlong(e);
        } else {
          e.path = null;
          e.bFail = 0;
          const t = e.bTiles[0];
          const p = this.players.get(e.o);
          this.face(e, (t % this.w) + 0.5, ((t / this.w) | 0) + 0.5);
          if ((e.bT = (e.bT ?? 0) - 1) <= 0) {
            if (this.bridges.has(t)) {
              // another engineer already laid this tile — free skip
              e.bTiles.shift();
              e.bT = 18;
              if (!e.bTiles.length) this.advanceOrder(e);
            } else if (this.block[t]) {
              // something built on the span mid-lay — a gap breaks the bridge, stop here
              e.bTiles = undefined;
              this.advanceOrder(e);
            } else if (!p || p.credits < 40) {
              e.bTiles = undefined;
              this.advanceOrder(e);
            } else {
              p.credits -= 40;
              this.bridges.add(t);
              this.bridgeMask[t] = 1;
              this.bakePassAt(t);
              this.regionDirty = true;
              e.bTiles.shift();
              e.bT = 18;
              if (!e.bTiles.length) this.advanceOrder(e);
            }
          }
        }
      }
    } else if (o?.kind === "board") {
      // Troop transport boarding — the infantry chases its ride like an attack target
      // (transports can keep moving) and embarks once adjacent. Helicopters in this sim
      // are always airborne hoverers, so they load anywhere they can hover; the only
      // requirement is physical adjacency.
      const tgt = o.target != null ? this.ents.get(o.target) : null;
      if (!tgt || tgt.o !== e.o || transportCapOf(tgt.k) <= 0) {
        this.advanceOrder(e); // ride destroyed or otherwise invalid — stand down
      } else if (dist(e.x, e.y, tgt.x, tgt.y) <= BOARD_RANGE) {
        if ((tgt.passengers?.length ?? 0) < transportCapOf(tgt.k)) {
          this.embark(e, tgt);
        } else {
          this.advanceOrder(e); // full — the squad waits beside the transport
        }
      } else {
        if (e.repath-- <= 0) {
          e.repath = 12;
          if (this.repathDue(e, tgt.x, tgt.y)) this.pathNear(e, tgt);
        }
        this.stepAlong(e);
      }
    } else if (o?.kind === "attack" && o.target != null) {
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
            if (this.repathDue(e, tgt.x, tgt.y)) this.pathNear(e, tgt);
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
            if (this.repathDue(e, tgt.x, tgt.y)) this.pathNear(e, tgt);
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
      // Acquisition scans are phased over SCAN_PHASE_TICKS ticks — the unit keeps
      // its tracked target between scans (validated cheaply every tick), and a
      // lost target is only re-scanned on the unit's phase. Worst-case added
      // acquisition latency is SCAN_PHASE_TICKS-1 ticks.
      const scanDue = (this.tick + e.id) % SCAN_PHASE_TICKS === 0;
      const tracked = e.agro != null ? this.ents.get(e.agro) : null;
      const enemy =
        tracked && this.canAttack(e, tracked) && entityDist(e, tracked) <= scanR + 2
          ? tracked
          : scanDue
            ? this.nearestEnemy(e, scanR)
            : null;
      if (enemy) {
        if ((e.k === "engineer" || e.k === "spy") && isBuilding(enemy.k)) {
          // attack-moving engineers & spies capture / sabotage buildings they reach
          if (!(e.k === "spy" ? this.trySabotage(e, enemy) : this.tryCapture(e, enemy))) {
            e.agro = enemy.id;
            if (e.repath-- <= 0) {
              e.repath = 12;
              if (this.repathDue(e, enemy.x, enemy.y)) this.pathNear(e, enemy);
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
              if (this.repathDue(e, enemy.x, enemy.y)) this.pathNear(e, enemy);
            }
            this.stepAlong(e);
          }
        }
      } else {
        // no enemy this tick — but only conclude the chase is over on a scan tick:
        // between scans the unit simply keeps marching along its current path
        // (avoids clear-then-reacquire path churn within the phasing window)
        if (e.agro != null && scanDue) {
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
    } else if (o?.kind === "unload") {
      // fly to the drop zone, then hover & disembark one passenger every few ticks.
      // A transport with empty cargo treats this as a plain move (order completes on
      // arrival); if no passable landing tile exists nearby the unload aborts and the
      // remaining passengers stay aboard — they are never dropped into impassable terrain.
      if (this.stepAlong(e)) {
        if (!e.passengers?.length) {
          this.advanceOrder(e);
        } else if (this.tick % UNLOAD_EVERY === 0) {
          if (!this.disembarkOne(e, o.x, o.y) || !e.passengers?.length) this.advanceOrder(e);
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
      if (this.bldDirty) this.bldsOf(-1);
      for (const b of this.bldAll) {
        if (this.isAlly(e.o, b.o)) continue;
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

    // FPV troop-transport unload: while fpvDrop is set, passengers rappel out
    // beneath the transport at the same cadence as a positional unload order.
    // Tiles are validated per drop exactly like disembark-at-order — a passenger
    // never lands on water/cliff/footprint; if there is no valid landing below
    // right now they simply stay aboard and the pilot can slide over solid
    // ground (or press U again to cancel). Flag clears when the bay is empty.
    if (e.fpvDrop) {
      if (!e.passengers?.length || transportCapOf(e.k) <= 0) {
        delete e.fpvDrop;
      } else if (this.tick % UNLOAD_EVERY === 0) {
        this.disembarkOne(e, e.x, e.y);
      }
    }

    // Direct-Aim Firing
    const wb = weaponOf(e);
    if (!dir.fire || e.cd > 0 || wb.range <= 0) return;

    // AC-130 gunship weapon select — wpn slot overrides the gun only while player-driven
    const gun = e.k === "ac130" ? AC130_GUNS[dir.wpn ?? 0] : null;
    const w = gun ? { ...wb, dmg: gun.dmg, rof: gun.rof } : wb;

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
    for (const t of this.entsInRange(dir.aimX, dir.aimY, 1.8 + MAX_BUILDING_EDGE_PAD + GRID_POS_PAD)) {
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
      for (const other of this.entsInRange(tx, ty, splashR + MAX_BUILDING_EDGE_PAD + GRID_POS_PAD)) {
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
            e.order = { kind: "harvest", x: e.oreIdx % this.w, y: (e.oreIdx / this.w) | 0 };
            if (this.astarAtomicLeft > 0) {
              this.astarAtomicLeft--;
              e.path = this.pathfind(
                e.x | 0,
                e.y | 0,
                e.oreIdx % this.w,
                (e.oreIdx / this.w) | 0,
                false,
                ASTAR_ATOMIC_CAP,
              );
            } else {
              e.repath = 1; // budgeted retry next tick
            }
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
            } else {
              e.hstate = e.cargo > 0 ? "toRef" : null;
              if (!e.hstate) e.order = null; // stale "harvest" order would wedge the unit
            }
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
        } else {
          e.hstate = e.cargo > 0 ? "toRef" : null;
          if (!e.hstate) e.order = null;
        }
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
      if (this.astarAtomicLeft <= 0) return;
      this.astarAtomicLeft--;
      e.path = this.pathfind(e.x | 0, e.y | 0, g.x, g.y, false, ASTAR_ATOMIC_CAP);
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
      if (this.astarAtomicLeft <= 0) return;
      this.astarAtomicLeft--;
      const spot = nearestPassable(ref.x | 0, ref.y | 0, this.passable, 10, this.w, this.h);
      e.path = spot ? (this.pathfind(e.x | 0, e.y | 0, spot.x, spot.y, false, ASTAR_ATOMIC_CAP) ?? []) : [];
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
    for (const b of this.bldsOf(e.o)) {
      if (b.k !== "refinery") continue;
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
  private oreTakenMap!: Map<number, number> | null;
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

  // ore tile list — rebuilt lazily once per step (ore mutates only via mining)
  private oreTiles!: number[] | null;
  private nearestOre(x: number, y: number, maxR = 999, self?: Ent) {
    if (!this.oreTiles) {
      const list: number[] = [];
      for (let i = 0; i < this.ore.length; i++) if (this.ore[i] > 0) list.push(i);
      this.oreTiles = list;
    }
    let best = -1,
      bd = Infinity,
      bestT = -1,
      bdT = Infinity;
    const r2 = maxR * maxR;
    const w = this.w;
    for (let k = 0; k < this.oreTiles.length; k++) {
      const i = this.oreTiles[k];
      if (this.ore[i] <= 0) continue; // mined out mid-step — list rebuilds next step
      const dx = (i % w) - x,
        dy = ((i / w) | 0) - y;
      const d = dx * dx + dy * dy;
      if (d > r2) continue;
      // free tiles win; taken tiles are kept as fallback (sharing beats idling)
      if (self && this.oreTaken(i, self.id)) {
        if (d < bdT) {
          bdT = d;
          bestT = i;
        }
      } else if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const pick = best >= 0 ? best : bestT;
    // commit immediately so a second harvester picking this same tick sees it —
    // but only for free tiles: claiming a taken fallback would steal the live claim
    if (self && best >= 0) {
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
      if (this.bldDirty) this.bldsOf(-1);
      for (const dome of this.domeIdx) {
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
      if (this.bldDirty) this.bldsOf(-1);
      for (const dome of this.domeIdx) {
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
    if (this.bldDirty) this.bldsOf(-1);
    for (const dome of this.domeIdx) {
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
    const wb = weaponOf(e);
    if (wb.range <= 0) return;
    if (isBuilding(e.k) && this.players.get(e.o)?.lowPower) return; // powered defenses offline
    if (this.tick < e.sabUntil) return; // defense battery disabled by spy sabotage
    if (!this.canAttack(e, tgt)) return;
    const kamikaze = isKamikaze(e.k);
    const unitShooter = !isBuilding(e.k); // kill-confirm credit goes to unit shooters only
    // 1P-driven AC-130 selected gun — overrides dmg/rof; ammo cost unchanged
    const w = gun ? { ...wb, dmg: gun.dmg, rof: gun.rof } : wb;
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
      for (const other of this.entsInRange(tx, ty, splashR + GRID_POS_PAD)) {
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

  // Infantry steps into the transport: removed from the world entity set (so it is
  // untargetable, unticked, unrendered, and dropped from the elimination headcount)
  // but kept as a full record on the transport — identity/veterancy/hp survive the ride.
  private embark(e: Ent, tgt: Ent) {
    if (!this.ents.has(e.id)) return;
    this.ents.delete(e.id);
    this.entsMut++;
    if (e.o >= 0) this.slotCnt[e.o]--;
    e.order = null;
    e.orderQueue = [];
    e.path = null;
    e.repath = 0;
    e.agro = null;
    e.hstate = null;
    e.bTiles = undefined;
    delete e.direct; // an embarked unit is never player-driven
    delete e.fpvAlt;
    e.x = tgt.x;
    e.y = tgt.y;
    (tgt.passengers ??= []).push(e);
  }

  // One passenger steps out onto the nearest passable land tile to the drop point.
  // Returns false when nobody can disembark there (no passable tile in range) — the
  // passenger stays aboard and the caller aborts the unload order.
  private disembarkOne(transport: Ent, x: number, y: number): boolean {
    const p = transport.passengers?.[0];
    if (!p) return false;
    const spot = nearestPassable(Math.floor(x), Math.floor(y), this.passable, UNLOAD_SEARCH_R, this.w, this.h);
    if (!spot) return false;
    transport.passengers!.shift();
    if (transport.passengers!.length === 0) delete transport.passengers;
    p.x = spot.x + 0.5;
    p.y = spot.y + 0.5;
    p.order = null;
    p.orderQueue = [];
    p.path = null;
    p.repath = 0;
    p.agro = null;
    this.ents.set(p.id, p);
    this.entsMut++;
    if (p.o >= 0) this.slotCnt[p.o]++;
    return true;
  }

  private destroy(e: Ent, killerSlot?: number) {
    if (!this.ents.has(e.id)) return;
    const wasBuilding = isBuilding(e.k);
    if (wasBuilding) {
      const d = BUILDINGS[e.k as BuildingKind];
      const bx = Math.round(e.x - d.w / 2),
        by = Math.round(e.y - d.h / 2);
      for (let y = by; y < by + d.h; y++)
        for (let x = bx; x < bx + d.w; x++)
          if (this.inBounds(x, y)) {
            const i = this.idx(x, y);
            this.block[i] = 0;
            this.bld[i] = -1;
            this.bakePassAt(i);
          }
    }
    this.ents.delete(e.id);
    this.entsMut++;
    if (e.o >= 0) this.slotCnt[e.o]--;
    if (wasBuilding) {
      this.bldDirty = true;
      this.regionDirty = true;
      this.recomputePower(e.o); // after removal so the corpse doesn't count
      if (killerSlot != null && killerSlot >= 0 && !this.isAlly(killerSlot, e.o)) {
        const kp = this.players.get(killerSlot);
        if (kp) kp.bldDestroyed++;
      }
    } else if (e.o >= 0) {
      const op = this.players.get(e.o);
      if (op) op.unitsLost++;
    }
    // classic transport rule: everyone aboard dies with the vehicle. Passengers are
    // already outside the world entity set (no slotCnt bookkeeping, no separate death
    // events) — they simply cease to exist and count toward the owner's losses.
    if (e.passengers?.length) {
      const op = this.players.get(e.o);
      if (op) op.unitsLost += e.passengers.length;
      delete e.passengers;
    }
    const size = wasBuilding ? Math.max(BUILDINGS[e.k as BuildingKind].w, BUILDINGS[e.k as BuildingKind].h) : 1;
    this.events.push({ e: "boom", x: e.x, y: e.y, r: size });
  }

  // One-scan multi-source flood: every passable tile gets its connectivity
  // label; impassable tiles stay 0. O(area) with zero allocation (typed-array
  // ring buffer) — runs rarely (lazily, after construction/bridge mutations),
  // amortizing to nothing next to the full-area A* failures it eliminates.
  private recomputeRegions() {
    const W = this.w,
      H = this.h,
      area = W * H;
    if (!this.regionLand || this.regionLand.length !== area) {
      this.regionLand = new Int32Array(area);
      this.regionSea = new Int32Array(area);
      this.regionQ = new Int32Array(area);
    }
    const land = this.regionLand,
      sea = this.regionSea,
      q = this.regionQ,
      block = this.block,
      cliff = this.cliff,
      water = this.water,
      bmask = this.bridgeMask;
    land.fill(0);
    sea.fill(0);
    // Region sizes fall out of the flood for free (qt resets per region) and let
    // regionAround answer its cap question in O(1) — see regionAround.
    const landSizes: number[] = [0],
      seaSizes: number[] = [0];
    let nextLand = 0,
      nextSea = 0;
    for (let i = 0; i < area; i++) {
      if (block[i] !== 0 || cliff[i] !== 0) continue;
      const isWater = water[i] === 1;
      // land flood: dry tiles + pontoon bridges
      if ((!isWater || bmask[i] === 1) && land[i] === 0) {
        const id = ++nextLand;
        let qh = 0,
          qt = 0;
        land[i] = id;
        q[qt++] = i;
        while (qh < qt) {
          const t = q[qh++];
          const tx = t % W,
            ty = (t / W) | 0;
          if (tx + 1 < W) {
            const n = t + 1;
            if (land[n] === 0 && block[n] === 0 && cliff[n] === 0 && (water[n] === 0 || bmask[n] === 1)) {
              land[n] = id;
              q[qt++] = n;
            }
          }
          if (tx > 0) {
            const n = t - 1;
            if (land[n] === 0 && block[n] === 0 && cliff[n] === 0 && (water[n] === 0 || bmask[n] === 1)) {
              land[n] = id;
              q[qt++] = n;
            }
          }
          if (ty + 1 < H) {
            const n = t + W;
            if (land[n] === 0 && block[n] === 0 && cliff[n] === 0 && (water[n] === 0 || bmask[n] === 1)) {
              land[n] = id;
              q[qt++] = n;
            }
          }
          if (ty > 0) {
            const n = t - W;
            if (land[n] === 0 && block[n] === 0 && cliff[n] === 0 && (water[n] === 0 || bmask[n] === 1)) {
              land[n] = id;
              q[qt++] = n;
            }
          }
        }
        landSizes[id] = qt;
      }
      // sea flood: navigable water (bridges stay water underneath)
      if (isWater && sea[i] === 0) {
        const id = ++nextSea;
        let qh = 0,
          qt = 0;
        sea[i] = id;
        q[qt++] = i;
        while (qh < qt) {
          const t = q[qh++];
          const tx = t % W,
            ty = (t / W) | 0;
          if (tx + 1 < W) {
            const n = t + 1;
            if (sea[n] === 0 && block[n] === 0 && cliff[n] === 0 && water[n] === 1) {
              sea[n] = id;
              q[qt++] = n;
            }
          }
          if (tx > 0) {
            const n = t - 1;
            if (sea[n] === 0 && block[n] === 0 && cliff[n] === 0 && water[n] === 1) {
              sea[n] = id;
              q[qt++] = n;
            }
          }
          if (ty + 1 < H) {
            const n = t + W;
            if (sea[n] === 0 && block[n] === 0 && cliff[n] === 0 && water[n] === 1) {
              sea[n] = id;
              q[qt++] = n;
            }
          }
          if (ty > 0) {
            const n = t - W;
            if (sea[n] === 0 && block[n] === 0 && cliff[n] === 0 && water[n] === 1) {
              sea[n] = id;
              q[qt++] = n;
            }
          }
        }
        seaSizes[id] = qt;
      }
    }
    this.regionLandSizes = landSizes;
    this.regionSeaSizes = seaSizes;
    this.regionDirty = false;
  }

  // Repath throttle: a unit only needs a fresh path when it has none (or the
  // path is nearly exhausted) or the chase target has meaningfully moved from
  // where the current path leads. Siege against static buildings previously
  // re-ran a full A* per unit every 12 ticks forever — pure waste.
  private repathDue(e: Ent, tx: number, ty: number): boolean {
    if (!e.path || e.path.length <= 2) return true;
    const last = e.path[e.path.length - 1];
    return Math.abs(last.x + 0.5 - tx) + Math.abs(last.y + 0.5 - ty) > 6;
  }

  // Region-gated A*: identical semantics to findPath, except searches whose
  // endpoints are provably disconnected fail in O(1). When either endpoint is
  // itself impassable (region 0 — e.g. the goal is inside a building footprint
  // before nearestPassable adjustment) we cannot prove hopelessness and run
  // the real search, preserving prior behavior exactly.
  private pathfind(
    sx: number,
    sy: number,
    gx: number,
    gy: number,
    sea: boolean,
    maxExpand: number,
  ): { x: number; y: number }[] | null {
    if (this.regionDirty) this.recomputeRegions();
    const region = sea ? this.regionSea : this.regionLand;
    if (sx >= 0 && sy >= 0 && sx < this.w && sy < this.h && gx >= 0 && gy >= 0 && gx < this.w && gy < this.h) {
      const rs = region[sy * this.w + sx];
      const rg = region[gy * this.w + gx];
      if (rs > 0 && rg > 0 && rs !== rg) return null;
    }
    // Atomic synchronous search — used by command-time validation and the
    // short harvester/bridge searches. These still consume the shared per-tick
    // expansion budget (small overdraw allowed: they are short in practice),
    // but they use findPath's own scratch, so they never corrupt a paused
    // incremental search. They are rare enough to not need queue fairness.
    const e0 = PATH_STATS.expanded;
    const r = findPath(sx, sy, gx, gy, sea ? this.passSea : this.passLand, maxExpand, this.w, this.h);
    this.astarExpandLeft -= PATH_STATS.expanded - e0;
    return r;
  }

  private pathNear(e: Ent, tgt: Ent, r = 0) {
    const dom = domainOf(e.k);
    if (dom === "air") return; // aircraft fly directly in stepAlong
    const sea = dom === "sea";
    const searchR = sea ? 24 : 10;
    const res = this.requestPath("chase", e, e.order, tgt.x | 0, tgt.y | 0, sea, searchR, tgt.id);
    if (res === null) {
      // deferred — re-evaluate next tick; the unit keeps its current path/behavior meanwhile
      e.repath = 1;
      return;
    }
    e.path = res;
  }

  // ---------- incremental A* service ----------
  //
  // Every budgeted path request flows through requestPath. Small searches
  // complete synchronously inline (identical to the old behavior) whenever the
  // queue is empty and budget remains; big ones are parked in a strict FIFO
  // queue and expanded incrementally across ticks — a budget-capped search is
  // NEVER treated as an unreachable failure, it simply resumes next tick. A
  // unit waiting on the queue keeps its current behavior: follows its existing
  // path, or idles in place if it has none (exactly the old "out of budget"
  // deferral). Starvation is impossible by construction: the head of the queue
  // always makes progress once per tick, and every entry eventually reaches it.

  private enqueuePathJob(job: PathJob) {
    if (job.pri) {
      // Economy-critical searches (harvester/bridge) are short and infrequent,
      // so letting them jump ahead of the long strategic searches costs those
      // little and prevents economy starvation when transcontinental demand
      // saturates the budget (observed: megacontinent income fell to ~0 under
      // strict FIFO — the backlog of 20k+-expansion searches never drained).
      // The loaded head is never displaced: it owns the engine state, and
      // anti-starvation for big searches is preserved because the head always
      // keeps expanding every tick regardless of what arrives behind it.
      let pos = this.pathQHead;
      if (pos < this.pathQ.length && this.pathQ[pos].loaded) pos++;
      while (pos < this.pathQ.length && this.pathQ[pos].pri) pos++;
      this.pathQ.splice(pos, 0, job);
    } else {
      this.pathQ.push(job);
    }
    this.pathQMap.set(job.e.id, job);
    if (job.pri) this.pathQPri++;
  }

  private dequeuePathHead() {
    const job = this.pathQ[this.pathQHead];
    this.pathQHead++;
    if (job.pri) this.pathQPri--;
    if (this.pathQMap.get(job.e.id) === job) this.pathQMap.delete(job.e.id);
    if (this.pathQHead >= this.pathQ.length) {
      this.pathQ.length = 0;
      this.pathQHead = 0;
    }
  }

  private cancelPathJob(job: PathJob) {
    if (!job.cancelled && job.pri) this.pathQPri--;
    job.cancelled = true;
    if (this.pathQMap.get(job.e.id) === job) this.pathQMap.delete(job.e.id);
    // a loaded job owns the engine — abandoning orphans its scratch safely
    if (job.loaded) this.astarEngine.abandon();
  }

  // Is this request still worth spending expansions on? Re-validated every
  // time the job reaches the head, and again at writeback.
  private pathJobAlive(job: PathJob): boolean {
    if (job.cancelled) return false;
    const e = job.e;
    if (!this.ents.has(e.id)) return false;
    if (e.order !== job.ord) return false;
    if (job.kind === "chase" && !this.ents.has(job.targetId)) return false;
    return true;
  }

  // Resolve the goal and start the engine. Returns false when the goal is
  // unresolvable right now (no passable tile near it / provably disconnected /
  // dead chase target) — a genuine failure answer, identical to what the old
  // synchronous code produced.
  private loadPathJob(job: PathJob): boolean {
    const e = job.e;
    const pass = job.sea ? this.passSea : this.passLand;
    const passFn = job.sea ? this.passableSea : this.passable;
    let gx = job.gx,
      gy = job.gy;
    if (job.kind === "chase") {
      const tgt = this.ents.get(job.targetId);
      if (!tgt) return false;
      gx = tgt.x | 0;
      gy = tgt.y | 0;
    }
    const spot = nearestPassable(gx, gy, passFn, job.searchR, this.w, this.h);
    if (!spot) return false;
    // region gate — identical to pathfind(): endpoints in different connected
    // regions are provably unreachable, fail in O(1)
    if (this.regionDirty) this.recomputeRegions();
    const region = job.sea ? this.regionSea : this.regionLand;
    const sx = e.x | 0,
      sy = e.y | 0;
    if (sx >= 0 && sy >= 0 && sx < this.w && sy < this.h) {
      const rs = region[sy * this.w + sx];
      const rg = region[spot.y * this.w + spot.x];
      if (rs > 0 && rg > 0 && rs !== rg) return false;
    }
    this.astarEngine.start(sx, sy, spot.x, spot.y, pass, job.maxExpand, this.w, this.h);
    job.loaded = true;
    return true;
  }

  // Complete a job: drop it from the queue and write the result back — but only
  // if the request is still relevant. A stale write must NEVER overwrite the
  // unit's state: orders are compared by reference (any retask/stop/advance
  // replaces the object), chase targets must still exist.
  private finishPathJob(job: PathJob, result: { x: number; y: number }[] | null) {
    this.dequeuePathHead();
    const e = job.e;
    if (!this.ents.has(e.id)) return;
    if (e.order !== job.ord) return;
    if (job.kind === "chase" && !this.ents.has(job.targetId)) return;
    e.path = result ?? [];
  }

  // FIFO drain at the top of every tick. Expands the head job up to the
  // remaining expansion budget; a job that doesn't finish stays loaded at the
  // head and resumes next tick — strict ordering means the biggest search in
  // the wave can't be starved out by newcomers, and small searches behind it
  // wait at most a few ticks (they would not have completed this tick anyway).
  private processPathQueue() {
    while (this.astarExpandLeft > 0 && this.pathQHead < this.pathQ.length) {
      const job = this.pathQ[this.pathQHead];
      if (!this.pathJobAlive(job)) {
        if (job.loaded) this.astarEngine.abandon();
        this.dequeuePathHead();
        continue;
      }
      if (!job.loaded && !this.loadPathJob(job)) {
        // genuine failure (unreachable/unresolvable) — same answer the
        // synchronous search would have produced
        this.finishPathJob(job, null);
        continue;
      }
      if (!this.astarEngine.done) {
        // a non-pri head leaves ASTAR_PRI_RESERVE expansions untouched while
        // economy jobs wait behind it — they complete in a fraction of that
        // slice, so this costs big searches almost nothing and guarantees the
        // economy a minimum service rate no matter how saturated the queue is
        const reserve = !job.pri && this.pathQPri > 0 ? ASTAR_PRI_RESERVE : 0;
        const avail = Math.max(0, this.astarExpandLeft - reserve);
        const used = this.astarEngine.step(avail);
        this.astarExpandLeft -= used;
      }
      if (this.astarEngine.done) {
        this.finishPathJob(job, this.astarEngine.result);
        continue;
      }
      break; // budget exhausted mid-search — resume at the head next tick
    }
  }

  // Entry point for budgeted path requests. Returns the finished path
  // (possibly empty = gave up, exactly the old `?? []` normalization) when the
  // search completes synchronously, or null when the request was deferred —
  // either because it is already pending, the queue is busy, or the search
  // did not finish within this tick's remaining budget.
  private requestPath(
    kind: "move" | "chase",
    e: Ent,
    ord: Order | null,
    gx: number,
    gy: number,
    sea: boolean,
    searchR: number,
    targetId = 0,
    pri = false,
  ): { x: number; y: number }[] | null {
    const existing = this.pathQMap.get(e.id);
    if (existing) {
      if (
        !existing.cancelled &&
        existing.kind === kind &&
        existing.ord === ord &&
        (kind === "chase" ? existing.targetId === targetId : existing.gx === gx && existing.gy === gy)
      ) {
        return null; // already pending — keep waiting (never re-enqueue duplicates)
      }
      // the need changed since the request was parked — drop the stale work
      this.cancelPathJob(existing);
    }
    const job: PathJob = {
      e,
      ord,
      kind,
      pri,
      sea,
      targetId,
      gx,
      gy,
      searchR,
      maxExpand: Math.max(2400, this.w * this.h),
      loaded: false,
      cancelled: false,
    };
    // fast path: nothing queued, no paused search — try to finish inline
    if (this.astarExpandLeft > 0 && this.pathQHead >= this.pathQ.length && !this.astarEngine.active) {
      if (!this.loadPathJob(job)) return []; // genuine failure — synchronous gave-up
      if (!this.astarEngine.done) {
        const used = this.astarEngine.step(this.astarExpandLeft);
        this.astarExpandLeft -= used;
      }
      if (this.astarEngine.done) return this.astarEngine.result ?? [];
      // big search, budget exhausted — park it (queue is empty, so it lands at the head)
    }
    this.enqueuePathJob(job);
    return null;
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
    const sea = dom === "sea";
    const pass = sea ? this.passableSea : this.passable;
    const searchR = sea ? 24 : 12;
    if (e.path === null) {
      const o = e.order;
      if (!o) {
        e.path = [];
        return true;
      }
      const res = this.requestPath("move", e, o, Math.floor(o.x), Math.floor(o.y), sea, searchR);
      if (res === null) return false; // deferred — idle-in-place/keep behavior, retry next tick
      e.path = res;
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
      // path invalidated by new construction — repath once (budgeted like first-run paths)
      const o = e.order;
      if (!o) return true;
      const res = this.requestPath("move", e, o, Math.floor(o.x), Math.floor(o.y), sea, searchR);
      if (res === null) return false; // deferred — retry next tick instead of dropping the order
      e.path = res;
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
    const isCrusher = (k: EntKind) => k === "tank" || k === "heavy" || k === "railtank";
    const crushable = (k: EntKind) => k === "infantry" || k === "rocket" || k === "engineer";
    // Rebuild the dedicated fine grid on live positions. Max interaction radius
    // is 1.35 tiles and cells are 2 tiles wide, so a ±1 cell neighborhood covers
    // every interacting pair with ~16x less candidate area than the coarse 8x8
    // grid — the dominant dense-combat cost was almost entirely false-positive
    // pair tests. Built here (not in rebuildSpatialGrid) so positions are exact.
    const cols = this.sepCols,
      rows = this.sepRows,
      grid = this.sepGrid,
      used = this.sepUsed;
    for (let i = 0; i < used.length; i++) grid[used[i]].length = 0;
    used.length = 0;
    for (const e of this.ents.values()) {
      if (isBuilding(e.k)) continue;
      const gx = Math.max(0, Math.min(cols - 1, (e.x | 0) >> 1));
      const gy = Math.max(0, Math.min(rows - 1, (e.y | 0) >> 1));
      const ci = gy * cols + gx;
      if (grid[ci].length === 0) used.push(ci);
      grid[ci].push(e);
    }
    for (let ui = 0; ui < used.length; ui++) {
      const ca = used[ui];
      const cy = (ca / cols) | 0,
        cx = ca % cols;
      const cellA = grid[ca];
      for (let i = 0; i < cellA.length; i++) {
        const a = cellA[i];
        if (!this.ents.has(a.id)) continue;
        const aDom = domainOf(a.k);
        const ny0 = Math.max(0, cy - 1),
          ny1 = Math.min(rows - 1, cy + 1);
        const nx0 = Math.max(0, cx - 1),
          nx1 = Math.min(cols - 1, cx + 1);
        let aDead = false;
        for (let ny = ny0; ny <= ny1 && !aDead; ny++) {
          for (let nx = nx0; nx <= nx1 && !aDead; nx++) {
            const cellB = grid[ny * cols + nx];
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
                minSep =
                  usesVehicleSeparation(a.k) && usesVehicleSeparation(b.k)
                    ? 1.05
                    : usesVehicleSeparation(a.k) || usesVehicleSeparation(b.k)
                      ? 0.85
                      : 0.72;
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

  private checkEnd() {
    if (this.winner !== null) return;
    if (this.players.size < 2) return; // solo games run until a rematch
    for (const p of this.players.values()) {
      if (p.eliminated) continue;
      if (this.slotCnt[p.slot] <= 0) {
        p.eliminated = true;
        this.events.push({ e: "elim", slot: p.slot });
      }
    }
    const alivePlayers = [...this.players.values()].filter((p) => !p.eliminated);
    if (alivePlayers.length === 0) {
      // mutual annihilation — end as a draw (worker maps unknown winner slot → "draw")
      this.winner = -1;
      return;
    }
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

  snapshot(): { ents: EntSnap[]; crates: CrateSnap[]; bridges: number[]; players: Record<number, PlayerState>; events: GameEvent[] } {
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
      // troop transports reuse the same wire scalar: cargo = passengers aboard
      // (interpretation stays kind-dependent, exactly like ore load vs supply load)
      else if (transportCapOf(e.k) > 0) s.cargo = e.passengers?.length ?? 0;
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
          if ((ord.kind === "attack" || ord.kind === "board") && ord.target != null) {
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
      const qCopy: Partial<Record<ProdCat, ProdItem[]>> = {};
      for (const cat of PROD_CATS) if (p.queues[cat]?.length) qCopy[cat] = p.queues[cat]!.map((i) => ({ ...i }));
      const ps: PlayerState = {
        slot: p.slot,
        credits: Math.floor(p.credits),
        pwrHave: p.pwrHave,
        pwrUse: p.pwrUse,
        lowPower: p.lowPower,
        eliminated: p.eliminated,
        awaiting: [...p.awaiting],
        bq: p.bq.map((i) => ({ ...i })),
        awaitingDef: [...p.awaitingDef],
        dq: p.dq.map((i) => ({ ...i })),
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
    return { ents, crates: [...this.crates.values()], bridges: [...this.bridges], players, events };
  }
}
