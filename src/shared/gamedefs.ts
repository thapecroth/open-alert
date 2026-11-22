// Shared game constants & definitions (must stay lib-agnostic: no DOM, no workerd types)

export const MAP_W = 64;
export const MAP_H = 64;
export const TICK_MS = 100; // sim runs at 10 Hz
export const SNAP_EVERY = 2; // broadcast every 2 ticks => 5 Hz
export const MAX_PLAYERS = 4;
export const START_CREDITS = 5000;
export const ORE_VALUE = 25; // credits per unit of cargo

export type BuildingKind =
  | "conyard"
  | "power"
  | "refinery"
  | "barracks"
  | "radar"
  | "factory"
  | "factory2"
  | "techlab"
  | "turret"
  | "arc"
  | "purifier"
  | "depot"
  | "superweapon"
  | "derrick";
export type UnitKind =
  | "infantry"
  | "engineer"
  | "rocket"
  | "tank"
  | "arty"
  | "heavy"
  | "spider"
  | "harvester";
export type EntKind = BuildingKind | UnitKind;
export type MapId =
  | "crossroads"
  | "canyon"
  | "basin"
  | "tundra"
  | "fortress"
  | "jungle"
  | "islands"
  | "oasis";
export type BotDiff = "easy" | "normal" | "brutal";
export type BotProfile = "balanced" | "rusher" | "turtle" | "tech";
export type CrateKind = "cash" | "vet" | "heal" | "unit";

export interface GameConfig {
  startCredits: number; // 3000 | 5000 | 10000 | 20000
  gameSpeed: number; // 0.75 | 1 | 1.5 | 2
  superweapons: boolean;
  crates: boolean;
  derricks: boolean;
  fog: boolean;
}

export const DEFAULT_CONFIG: GameConfig = {
  startCredits: START_CREDITS,
  gameSpeed: 1,
  superweapons: true,
  crates: true,
  derricks: true,
  fog: true,
};

export const BOT_PROFILES: { id: BotProfile; label: string; desc: string }[] = [
  { id: "balanced", label: "Balanced", desc: "Adaptive economy, mixed army & steady pressure" },
  { id: "rusher", label: "Rusher", desc: "Early aggressive raids & fast infantry/tank waves" },
  { id: "turtle", label: "Turtle", desc: "Heavy turret/arc defenses & massive late counter-push" },
  { id: "tech", label: "Tech Boom", desc: "Greedy dual harvesters, fast Tech Lab, Mastodons & Ion Cannon" },
];

export interface BuildingDef {
  w: number; // footprint in tiles
  h: number;
  cost: number;
  hp: number;
  power: number; // + provides, - consumes
  buildTicks: number;
  range?: number;
  dmg?: number;
  rof?: number; // ticks between shots
  requires?: BuildingKind[]; // tech prerequisites — all must exist before cmdBuild
  noBuild?: true; // exists in the world but can't be queued (upgrade/neutral structures)
  limit?: number; // max count per player
}
export const BUILDINGS: Record<BuildingKind, BuildingDef> = {
  conyard: { w: 3, h: 3, cost: 0, hp: 1000, power: 40, buildTicks: 0 },
  power: { w: 2, h: 2, cost: 300, hp: 400, power: 100, buildTicks: 50 },
  refinery: { w: 3, h: 2, cost: 600, hp: 700, power: -35, buildTicks: 80 },
  barracks: { w: 2, h: 2, cost: 500, hp: 500, power: -20, buildTicks: 70 },
  radar: { w: 2, h: 2, cost: 700, hp: 500, power: -45, buildTicks: 80, requires: ["barracks"] },
  factory: { w: 3, h: 3, cost: 1000, hp: 900, power: -30, buildTicks: 110 },
  factory2: { w: 3, h: 3, cost: 0, hp: 1300, power: -40, buildTicks: 0, noBuild: true },
  techlab: { w: 3, h: 3, cost: 1800, hp: 800, power: -60, buildTicks: 130, requires: ["radar", "factory"] },
  turret: { w: 1, h: 1, cost: 500, hp: 400, power: -25, buildTicks: 60, range: 6, dmg: 15, rof: 14 },
  arc: { w: 1, h: 1, cost: 800, hp: 550, power: -40, buildTicks: 70, range: 7, dmg: 30, rof: 24, requires: ["radar"] },
  purifier: { w: 2, h: 2, cost: 900, hp: 500, power: -25, buildTicks: 90, requires: ["techlab"] },
  depot: { w: 3, h: 2, cost: 800, hp: 700, power: -30, buildTicks: 90, requires: ["factory"] },
  superweapon: { w: 3, h: 3, cost: 2500, hp: 1100, power: -100, buildTicks: 150, requires: ["techlab"], limit: 1 },
  derrick: { w: 2, h: 2, cost: 0, hp: 850, power: 0, buildTicks: 0, noBuild: true },
};
export const BUILD_ORDER: BuildingKind[] = [
  "power",
  "refinery",
  "barracks",
  "radar",
  "factory",
  "turret",
  "arc",
  "depot",
  "techlab",
  "purifier",
  "superweapon",
];

export interface UnitDef {
  hp: number;
  speed: number; // tiles per tick
  range: number; // 0 = unarmed
  dmg: number;
  rof: number;
  cost: number;
  buildTicks: number;
  trainsAt: "barracks" | "factory";
  requires?: BuildingKind; // extra prerequisite building
  capacity?: number; // harvester cargo units
}
export const UNITS: Record<UnitKind, UnitDef> = {
  infantry: { hp: 90, speed: 0.1, range: 4, dmg: 6, rof: 15, cost: 100, buildTicks: 30, trainsAt: "barracks" },
  engineer: { hp: 70, speed: 0.1, range: 0, dmg: 0, rof: 0, cost: 500, buildTicks: 40, trainsAt: "barracks" },
  rocket: { hp: 80, speed: 0.11, range: 6, dmg: 11, rof: 18, cost: 300, buildTicks: 35, trainsAt: "barracks", requires: "radar" },
  tank: { hp: 340, speed: 0.16, range: 5, dmg: 22, rof: 22, cost: 700, buildTicks: 70, trainsAt: "factory" },
  arty: { hp: 140, speed: 0.1, range: 9, dmg: 42, rof: 42, cost: 1100, buildTicks: 90, trainsAt: "factory", requires: "radar" },
  heavy: { hp: 560, speed: 0.12, range: 5, dmg: 36, rof: 24, cost: 1100, buildTicks: 95, trainsAt: "factory", requires: "factory2" },
  spider: { hp: 90, speed: 0.26, range: 1.4, dmg: 9, rof: 9, cost: 500, buildTicks: 45, trainsAt: "factory", requires: "factory2" },
  harvester: { hp: 620, speed: 0.11, range: 0, dmg: 0, rof: 0, cost: 1400, buildTicks: 100, trainsAt: "factory", requires: "refinery", capacity: 40 },
};
export const TRAIN_ORDER: { unit: UnitKind; label: string }[] = [
  { unit: "infantry", label: "Rifleman" },
  { unit: "engineer", label: "Sapper" },
  { unit: "rocket", label: "Rocket Trooper" },
  { unit: "tank", label: "Battle Tank" },
  { unit: "arty", label: "Siege Launcher" },
  { unit: "heavy", label: "Mastodon Tank" },
  { unit: "spider", label: "Spider Drone" },
  { unit: "harvester", label: "Ore Harvester" },
];

// display names for buildings (sidebar/tooltips)
export const BUILDING_NAMES: Record<BuildingKind, string> = {
  conyard: "Construction Yard",
  power: "Reactor Plant",
  refinery: "Ore Refinery",
  barracks: "Barracks",
  radar: "Radar Uplink",
  factory: "War Factory",
  factory2: "War Factory II",
  techlab: "Tech Lab",
  turret: "Sentry Turret",
  arc: "Arc Coil",
  purifier: "Ore Purifier",
  depot: "Service Depot",
  superweapon: "Ion Uplink",
  derrick: "Oil Derrick",
};

// ---------- tech & special mechanics ----------
export const UPGRADE_COST = 1500; // factory -> factory2, requires a techlab
export const PURIFIER_BONUS = 0.25; // +25% credits per harvester deposit
export const DEPOT_RANGE = 6; // service depot heal aura radius (tiles)
export const DEPOT_HEAL = 4; // hp restored per vehicle per second
export const CAPTURE_RANGE = 1.9; // engineer must be this close to capture

// Veterancy (0=Rookie, 1=Veteran ★, 2=Elite ★★, 3=Heroic ★★★)
export const VET_XP = [0, 260, 750, 1600] as const;
export const VET_DMG = [1, 1.2, 1.4, 1.65] as const;
export const VET_HP = [1, 1.15, 1.3, 1.5] as const;
export const VET_HEAL = [0, 0, 2, 5] as const; // HP/sec regen at Elite & Heroic

// Superweapon (Orbital Ion Cannon) & Radar Recon Support Power
export const SW_CHARGE_TICKS = 900; // 90s full power
export const SW_RADIUS = 5.5;
export const SW_DAMAGE = 950;
export const RECON_CHARGE_TICKS = 450; // 45s cooldown on Radar Uplink
export const RECON_DURATION_TICKS = 100; // 10s fog reveal
export const RECON_RADIUS = 12;

// Neutral Oil Derricks & Battlefield Supply Crates
export const DERRICK_CAPTURE_BONUS = 500;
export const DERRICK_INCOME = 25; // credits per second (every 10 ticks)
export const CRATE_INTERVAL_TICKS = 350; // drop every 35s
export const CRATE_MAX = 3;
export const CRATE_CASH = 1000;

// Splash damage radii
export const SPLASH_RADIUS: Partial<Record<EntKind, number>> = {
  arty: 2.3,
  heavy: 1.15,
};

export const HARVEST_TICKS_PER_UNIT = 4; // 1 cargo per 4 ticks => ~16s to fill (RA2-like)
export const ORE_REGEN_TICKS = 50; // ore field regrowth pulse every 5s
export const ORE_CELL_MAX = 60; // max ore units per tile
export const ORE_SPREAD_CHANCE = 0.05; // chance a depleted tile next to live ore regrows
export const AGGRO_RANGE = 5; // idle units fire at enemies within this radius (no pursuit)

export const PLAYER_COLORS = ["#e03030", "#3390ff", "#f0c020", "#40c060"];
export const PLAYER_COLOR_NAMES = ["Red", "Blue", "Gold", "Green"];

// Corner spawn positions (top-left tile of the conyard footprint)
export const SPAWNS: { x: number; y: number }[] = [
  { x: 5, y: 5 },
  { x: MAP_W - 8, y: MAP_H - 8 },
  { x: MAP_W - 8, y: 5 },
  { x: 5, y: MAP_H - 8 },
];

// ---------- Deterministic Handcrafted Maps (8 Biomes & Tactical Layouts) ----------
export const MAP_LIST: { id: MapId; name: string; biome: string; desc: string }[] = [
  { id: "crossroads", name: "Twin Crossroads", biome: "Steppe", desc: "Balanced flank mesas & twin contested Oil Derricks" },
  { id: "canyon", name: "Iron Canyon", biome: "Canyon", desc: "Twin sandstone canyon walls channeling fights across 3 lanes" },
  { id: "basin", name: "Shattered Basin", biome: "Alpine", desc: "Open volcanic ore basin ringed by 4 captureable Oil Derricks" },
  { id: "tundra", name: "Frostbite Pass", biome: "Arctic", desc: "Frozen glacial divide with wide north/south bypasses & rich center ice field" },
  { id: "fortress", name: "Citadel Bastion", biome: "Desert", desc: "Walled central citadel with 4 gates guarding a mega ore cache" },
  { id: "jungle", name: "Emerald Valley", biome: "Jungle", desc: "Diagonal ridge corridors built for ambushes & flanking raids" },
  { id: "islands", name: "Bridgehead Crossing", biome: "Riverland", desc: "Four quadrants linked by tight chokepoint bridges — artillery heaven" },
  { id: "oasis", name: "Scorched Oasis", biome: "Sahara", desc: "Golden dune ring with fast open flank tank lanes & twin oasis passes" },
];

export interface MapLayout {
  cliffs: [number, number][]; // impassable elevated rocky/glacial/chasm tiles
  derricks: [number, number][]; // top-left 2x2 tile of neutral Oil Derricks
  extraOre?: [number, number, number][]; // optional [cx, cy, radius] bonus ore blobs
}

const mapCache = new Map<MapId, MapLayout>();

export function getMapLayout(id: MapId = "crossroads"): MapLayout {
  const cached = mapCache.get(id);
  if (cached) return cached;
  const cliffSet = new Set<number>();
  const addRect = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) cliffSet.add(y * MAP_W + x);
      }
    }
  };
  let derricks: [number, number][] = [];
  let extraOre: [number, number, number][] | undefined;

  if (id === "crossroads") {
    addRect(22, 16, 4, 3);
    addRect(38, 16, 4, 3);
    addRect(22, 45, 4, 3);
    addRect(38, 45, 4, 3);
    addRect(15, 29, 3, 6);
    addRect(46, 29, 3, 6);
    derricks = [
      [31, 10],
      [31, 52],
    ];
  } else if (id === "canyon") {
    addRect(29, 10, 4, 15);
    addRect(29, 39, 4, 15);
    addRect(18, 28, 3, 8);
    addRect(43, 28, 3, 8);
    derricks = [
      [12, 31],
      [50, 31],
    ];
  } else if (id === "basin") {
    addRect(21, 20, 3, 3);
    addRect(40, 20, 3, 3);
    addRect(21, 41, 3, 3);
    addRect(40, 41, 3, 3);
    derricks = [
      [31, 8],
      [31, 54],
      [8, 31],
      [54, 31],
    ];
  } else if (id === "tundra") {
    // Glacial divide across center-left & center-right with twin north/south passes
    addRect(17, 29, 10, 4);
    addRect(37, 29, 10, 4);
    addRect(29, 14, 6, 4);
    addRect(29, 46, 6, 4);
    derricks = [
      [11, 31],
      [51, 31],
    ];
    extraOre = [
      [32, 22, 3],
      [32, 42, 3],
    ];
  } else if (id === "fortress") {
    // Central walled citadel with 4 wide gate openings (N/S/E/W)
    addRect(22, 22, 7, 2);
    addRect(35, 22, 7, 2);
    addRect(22, 40, 7, 2);
    addRect(35, 40, 7, 2);
    addRect(22, 24, 2, 5);
    addRect(22, 35, 2, 5);
    addRect(40, 24, 2, 5);
    addRect(40, 35, 2, 5);
    derricks = [
      [31, 9],
      [31, 53],
      [9, 31],
      [53, 31],
    ];
    extraOre = [[32, 32, 5]];
  } else if (id === "jungle") {
    // Diagonal ridge corridors creating ambush lanes
    addRect(18, 17, 6, 3);
    addRect(22, 20, 4, 3);
    addRect(40, 44, 6, 3);
    addRect(38, 41, 4, 3);
    addRect(40, 17, 6, 3);
    addRect(38, 20, 4, 3);
    addRect(18, 44, 6, 3);
    addRect(22, 41, 4, 3);
    derricks = [
      [31, 12],
      [31, 50],
      [14, 31],
      [48, 31],
    ];
    extraOre = [
      [20, 32, 3],
      [44, 32, 3],
    ];
  } else if (id === "islands") {
    // Four quadrants separated by impassable canyon-river cross with 4 wide bridges + center island
    addRect(30, 0, 4, 11);
    addRect(30, 18, 4, 8);
    addRect(30, 38, 4, 8);
    addRect(30, 53, 4, 11);
    addRect(0, 30, 11, 4);
    addRect(18, 30, 8, 4);
    addRect(38, 30, 8, 4);
    addRect(53, 30, 11, 4);
    derricks = [
      [23, 23],
      [39, 39],
      [39, 23],
      [23, 39],
    ];
    extraOre = [
      [14, 24, 2],
      [49, 39, 2],
    ];
  } else {
    // oasis: curved desert rock spurs around a fast central arena + flanking ore oases
    addRect(24, 15, 16, 2);
    addRect(24, 47, 16, 2);
    addRect(15, 24, 2, 16);
    addRect(47, 24, 2, 16);
    derricks = [
      [31, 7],
      [31, 55],
    ];
    extraOre = [
      [22, 32, 3],
      [42, 32, 3],
    ];
  }

  const cliffs: [number, number][] = [];
  for (const k of cliffSet) cliffs.push([k % MAP_W, (k / MAP_W) | 0]);
  const layout: MapLayout = { cliffs, derricks, extraOre };
  mapCache.set(id, layout);
  return layout;
}
