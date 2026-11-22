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
  | "airfield"
  | "shipyard"
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
  | "harvester"
  // Air Force
  | "interceptor"
  | "chopper"
  | "bomber"
  | "zeppelin"
  // Navy
  | "gunboat"
  | "destroyer"
  | "sub"
  | "dreadnought";

export type EntKind = BuildingKind | UnitKind;
export type UnitDomain = "land" | "air" | "sea";
export type ProdCat = "barracks" | "factory" | "airfield" | "shipyard";

export type MapId =
  | "crossroads"
  | "canyon"
  | "basin"
  | "tundra"
  | "fortress"
  | "jungle"
  | "islands"
  | "oasis"
  | "archipelago"
  | "coastline";

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
  canHitAir?: boolean; // defense can engage flying aircraft
  requires?: BuildingKind[]; // tech prerequisites — all must exist before cmdBuild
  noBuild?: true; // exists in the world but can't be queued (upgrade/neutral structures)
  limit?: number; // max count per player
  waterOnly?: true; // must be placed on water tiles (Naval Shipyard)
}

export const BUILDINGS: Record<BuildingKind, BuildingDef> = {
  conyard: { w: 3, h: 3, cost: 0, hp: 1000, power: 40, buildTicks: 0 },
  power: { w: 2, h: 2, cost: 300, hp: 400, power: 100, buildTicks: 50 },
  refinery: { w: 3, h: 2, cost: 600, hp: 700, power: -35, buildTicks: 80 },
  barracks: { w: 2, h: 2, cost: 500, hp: 500, power: -20, buildTicks: 70 },
  radar: { w: 2, h: 2, cost: 700, hp: 500, power: -45, buildTicks: 80, requires: ["barracks"] },
  factory: { w: 3, h: 3, cost: 1000, hp: 900, power: -30, buildTicks: 110 },
  factory2: { w: 3, h: 3, cost: 0, hp: 1300, power: -40, buildTicks: 0, noBuild: true },
  airfield: { w: 3, h: 2, cost: 1000, hp: 750, power: -40, buildTicks: 95, requires: ["radar"] },
  shipyard: { w: 3, h: 3, cost: 1000, hp: 950, power: -35, buildTicks: 100, requires: ["power"], waterOnly: true },
  techlab: { w: 3, h: 3, cost: 1800, hp: 800, power: -60, buildTicks: 130, requires: ["radar", "factory"] },
  turret: { w: 1, h: 1, cost: 500, hp: 400, power: -25, buildTicks: 60, range: 6.5, dmg: 15, rof: 14, canHitAir: true },
  arc: { w: 1, h: 1, cost: 800, hp: 550, power: -40, buildTicks: 70, range: 7.5, dmg: 30, rof: 24, requires: ["radar"], canHitAir: true },
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
  "airfield",
  "shipyard",
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
  trainsAt: ProdCat;
  domain: UnitDomain;
  canHitAir?: boolean;
  canHitGround?: boolean; // default true if omitted
  requires?: BuildingKind; // extra prerequisite building
  capacity?: number; // harvester cargo units
}

export const UNITS: Record<UnitKind, UnitDef> = {
  // Land Infantry
  infantry: { hp: 90, speed: 0.1, range: 4, dmg: 6, rof: 15, cost: 100, buildTicks: 30, trainsAt: "barracks", domain: "land", canHitAir: true },
  engineer: { hp: 70, speed: 0.1, range: 0, dmg: 0, rof: 0, cost: 500, buildTicks: 40, trainsAt: "barracks", domain: "land" },
  rocket: { hp: 80, speed: 0.11, range: 6.5, dmg: 11, rof: 18, cost: 300, buildTicks: 35, trainsAt: "barracks", domain: "land", requires: "radar", canHitAir: true },
  // Land Vehicles
  tank: { hp: 340, speed: 0.16, range: 5, dmg: 22, rof: 22, cost: 700, buildTicks: 70, trainsAt: "factory", domain: "land" },
  arty: { hp: 140, speed: 0.1, range: 9, dmg: 42, rof: 42, cost: 1100, buildTicks: 90, trainsAt: "factory", domain: "land", requires: "radar" },
  heavy: { hp: 560, speed: 0.12, range: 5, dmg: 36, rof: 24, cost: 1100, buildTicks: 95, trainsAt: "factory", domain: "land", requires: "factory2" },
  spider: { hp: 90, speed: 0.26, range: 1.4, dmg: 9, rof: 9, cost: 500, buildTicks: 45, trainsAt: "factory", domain: "land", requires: "factory2" },
  harvester: { hp: 620, speed: 0.11, range: 0, dmg: 0, rof: 0, cost: 1400, buildTicks: 100, trainsAt: "factory", domain: "land", requires: "refinery", capacity: 40 },
  // Air Force
  interceptor: { hp: 190, speed: 0.34, range: 6.5, dmg: 26, rof: 18, cost: 900, buildTicks: 65, trainsAt: "airfield", domain: "air", canHitAir: true },
  chopper: { hp: 310, speed: 0.22, range: 6, dmg: 22, rof: 14, cost: 1100, buildTicks: 75, trainsAt: "airfield", domain: "air", canHitAir: true },
  bomber: { hp: 420, speed: 0.18, range: 5.5, dmg: 80, rof: 46, cost: 1600, buildTicks: 95, trainsAt: "airfield", domain: "air", requires: "techlab" },
  zeppelin: { hp: 1400, speed: 0.085, range: 3.6, dmg: 135, rof: 38, cost: 2200, buildTicks: 120, trainsAt: "airfield", domain: "air", requires: "techlab" },
  // Navy
  gunboat: { hp: 240, speed: 0.24, range: 6.5, dmg: 16, rof: 14, cost: 600, buildTicks: 55, trainsAt: "shipyard", domain: "sea", canHitAir: true },
  destroyer: { hp: 580, speed: 0.14, range: 7.5, dmg: 32, rof: 22, cost: 1100, buildTicks: 80, trainsAt: "shipyard", domain: "sea", canHitAir: true },
  sub: { hp: 460, speed: 0.15, range: 7, dmg: 52, rof: 30, cost: 1200, buildTicks: 85, trainsAt: "shipyard", domain: "sea", requires: "radar" },
  dreadnought: { hp: 1150, speed: 0.09, range: 13, dmg: 92, rof: 46, cost: 2200, buildTicks: 115, trainsAt: "shipyard", domain: "sea", requires: "techlab" },
};

export const TRAIN_ORDER: { unit: UnitKind; label: string; group: "land" | "air" | "sea" }[] = [
  { unit: "infantry", label: "Rifleman", group: "land" },
  { unit: "engineer", label: "Sapper", group: "land" },
  { unit: "rocket", label: "Rocket Trooper", group: "land" },
  { unit: "tank", label: "Battle Tank", group: "land" },
  { unit: "arty", label: "Siege Launcher", group: "land" },
  { unit: "heavy", label: "Mastodon Tank", group: "land" },
  { unit: "spider", label: "Spider Drone", group: "land" },
  { unit: "harvester", label: "Ore Harvester", group: "land" },
  // Air Force
  { unit: "interceptor", label: "Valkyrie Jet", group: "air" },
  { unit: "chopper", label: "Hornet Gunship", group: "air" },
  { unit: "bomber", label: "Tempest Bomber", group: "air" },
  { unit: "zeppelin", label: "Leviathan Airship", group: "air" },
  // Navy
  { unit: "gunboat", label: "Viper Hydrofoil", group: "sea" },
  { unit: "destroyer", label: "Aegis Destroyer", group: "sea" },
  { unit: "sub", label: "Kraken Sub", group: "sea" },
  { unit: "dreadnought", label: "Poseidon Dreadnought", group: "sea" },
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
  airfield: "Air Command",
  shipyard: "Naval Shipyard",
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
export const SHIPYARD_BUILD_DIST = 9; // max gap from own base to place Naval Shipyard on water

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
  bomber: 2.5,
  zeppelin: 2.9,
  dreadnought: 2.8,
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

// ---------- Deterministic Handcrafted Maps (10 Biomes & Tactical Layouts, incl. Naval Theaters) ----------
export const MAP_LIST: { id: MapId; name: string; biome: string; naval?: boolean; desc: string }[] = [
  { id: "crossroads", name: "Twin Crossroads", biome: "Steppe", desc: "Balanced flank mesas & twin contested Oil Derricks" },
  { id: "canyon", name: "Iron Canyon", biome: "Canyon", desc: "Twin sandstone canyon walls channeling fights across 3 lanes" },
  { id: "basin", name: "Shattered Basin", biome: "Alpine", desc: "Open volcanic ore basin ringed by 4 captureable Oil Derricks" },
  { id: "tundra", name: "Frostbite Pass", biome: "Arctic", desc: "Frozen glacial divide with wide north/south bypasses & rich center ice field" },
  { id: "fortress", name: "Citadel Bastion", biome: "Desert", desc: "Walled central citadel with 4 gates guarding a mega ore cache" },
  { id: "jungle", name: "Emerald Valley", biome: "Jungle", desc: "Diagonal ridge corridors built for ambushes & flanking raids" },
  { id: "islands", name: "Bridgehead Crossing", biome: "Riverland", naval: true, desc: "Navigable river channels & bridges — full Land, Air & Sea theater" },
  { id: "oasis", name: "Scorched Oasis", biome: "Sahara", desc: "Golden dune ring with fast open flank tank lanes & twin oasis passes" },
  { id: "archipelago", name: "Pacific Atoll", biome: "Ocean", naval: true, desc: "4 corner islands & a central volcanic atoll — naval & air supremacy" },
  { id: "coastline", name: "Storm Coast", biome: "Coastal", naval: true, desc: "Wide ocean straits with island Oil Derricks & dreadnought bombardment lanes" },
];

export interface MapLayout {
  cliffs: [number, number][]; // impassable elevated rocky/glacial tiles (aircraft fly over!)
  water: [number, number][]; // navigable ocean/river tiles (ships sail on, aircraft fly over!)
  derricks: [number, number][]; // top-left 2x2 tile of neutral Oil Derricks
  extraOre?: [number, number, number][]; // optional [cx, cy, radius] bonus ore blobs
}

const mapCache = new Map<MapId, MapLayout>();

export function getMapLayout(id: MapId = "crossroads"): MapLayout {
  const cached = mapCache.get(id);
  if (cached) return cached;
  const cliffSet = new Set<number>();
  const waterSet = new Set<number>();
  const addRect = (set: Set<number>, x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) set.add(y * MAP_W + x);
      }
    }
  };
  const clearRect = (set: Set<number>, x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) set.delete(y * MAP_W + x);
      }
    }
  };
  let derricks: [number, number][] = [];
  let extraOre: [number, number, number][] | undefined;

  if (id === "crossroads") {
    addRect(cliffSet, 22, 16, 4, 3);
    addRect(cliffSet, 38, 16, 4, 3);
    addRect(cliffSet, 22, 45, 4, 3);
    addRect(cliffSet, 38, 45, 4, 3);
    addRect(cliffSet, 15, 29, 3, 6);
    addRect(cliffSet, 46, 29, 3, 6);
    derricks = [
      [31, 10],
      [31, 52],
    ];
  } else if (id === "canyon") {
    addRect(cliffSet, 29, 10, 4, 15);
    addRect(cliffSet, 29, 39, 4, 15);
    addRect(cliffSet, 18, 28, 3, 8);
    addRect(cliffSet, 43, 28, 3, 8);
    derricks = [
      [12, 31],
      [50, 31],
    ];
  } else if (id === "basin") {
    addRect(cliffSet, 21, 20, 3, 3);
    addRect(cliffSet, 40, 20, 3, 3);
    addRect(cliffSet, 21, 41, 3, 3);
    addRect(cliffSet, 40, 41, 3, 3);
    derricks = [
      [31, 8],
      [31, 54],
      [8, 31],
      [54, 31],
    ];
  } else if (id === "tundra") {
    addRect(cliffSet, 17, 29, 10, 4);
    addRect(cliffSet, 37, 29, 10, 4);
    addRect(cliffSet, 29, 14, 6, 4);
    addRect(cliffSet, 29, 46, 6, 4);
    derricks = [
      [11, 31],
      [51, 31],
    ];
    extraOre = [
      [32, 22, 3],
      [32, 42, 3],
    ];
  } else if (id === "fortress") {
    addRect(cliffSet, 22, 22, 7, 2);
    addRect(cliffSet, 35, 22, 7, 2);
    addRect(cliffSet, 22, 40, 7, 2);
    addRect(cliffSet, 35, 40, 7, 2);
    addRect(cliffSet, 22, 24, 2, 5);
    addRect(cliffSet, 22, 35, 2, 5);
    addRect(cliffSet, 40, 24, 2, 5);
    addRect(cliffSet, 40, 35, 2, 5);
    derricks = [
      [31, 9],
      [31, 53],
      [9, 31],
      [53, 31],
    ];
    extraOre = [[32, 32, 5]];
  } else if (id === "jungle") {
    addRect(cliffSet, 18, 17, 6, 3);
    addRect(cliffSet, 22, 20, 4, 3);
    addRect(cliffSet, 40, 44, 6, 3);
    addRect(cliffSet, 38, 41, 4, 3);
    addRect(cliffSet, 40, 17, 6, 3);
    addRect(cliffSet, 38, 20, 4, 3);
    addRect(cliffSet, 18, 44, 6, 3);
    addRect(cliffSet, 22, 41, 4, 3);
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
    // Navigable wide river channels forming a coastal cross + 4 wide land bridges + corner coves for Shipyards!
    addRect(waterSet, 26, 0, 12, 12);
    addRect(waterSet, 26, 17, 12, 9);
    addRect(waterSet, 26, 38, 12, 9);
    addRect(waterSet, 26, 52, 12, 12);
    addRect(waterSet, 0, 26, 12, 12);
    addRect(waterSet, 17, 26, 9, 12);
    addRect(waterSet, 38, 26, 9, 12);
    addRect(waterSet, 52, 26, 12, 12);
    // Coastal coves reaching within 7 tiles of each spawn so Shipyards can be deployed easily
    addRect(waterSet, 13, 0, 13, 6);
    addRect(waterSet, 38, 0, 13, 6);
    addRect(waterSet, 13, 58, 13, 6);
    addRect(waterSet, 38, 58, 13, 6);
    derricks = [
      [21, 21],
      [41, 41],
      [41, 21],
      [21, 41],
    ];
    extraOre = [
      [14, 21, 2],
      [48, 42, 2],
    ];
  } else if (id === "archipelago") {
    // Pacific Atoll: Open ocean surrounding 4 generous corner islands + central volcanic ore atoll + narrow causeways
    addRect(waterSet, 0, 0, MAP_W, MAP_H);
    // 4 generous corner base islands (18x18 each)
    clearRect(waterSet, 0, 0, 18, 18);
    clearRect(waterSet, 46, 0, 18, 18);
    clearRect(waterSet, 0, 46, 18, 18);
    clearRect(waterSet, 46, 46, 18, 18);
    // Central volcanic ore atoll (14x14)
    clearRect(waterSet, 25, 25, 14, 14);
    // 4 shallow coastal sandbar bridges so land forces can still contest center
    clearRect(waterSet, 30, 14, 4, 12);
    clearRect(waterSet, 30, 38, 4, 12);
    clearRect(waterSet, 14, 30, 12, 4);
    clearRect(waterSet, 38, 30, 12, 4);
    // 4 small flanking derrick islets
    clearRect(waterSet, 29, 7, 6, 7);
    clearRect(waterSet, 29, 50, 6, 7);
    clearRect(waterSet, 7, 29, 7, 6);
    clearRect(waterSet, 50, 29, 7, 6);
    // Volcanic rocks framing the central atoll
    addRect(cliffSet, 26, 26, 2, 2);
    addRect(cliffSet, 36, 26, 2, 2);
    addRect(cliffSet, 26, 36, 2, 2);
    addRect(cliffSet, 36, 36, 2, 2);
    derricks = [
      [31, 9],
      [31, 53],
      [9, 31],
      [53, 31],
    ];
    extraOre = [[32, 32, 4]];
  } else if (id === "coastline") {
    // Storm Coast: Wide open ocean channels along the top, bottom & mid-strait with 2 wide coastal continents
    addRect(waterSet, 23, 0, 18, MAP_H);
    // Wide north, center, and south land bridges across the strait
    clearRect(waterSet, 23, 12, 18, 5);
    clearRect(waterSet, 23, 29, 18, 6);
    clearRect(waterSet, 23, 47, 18, 5);
    // Coastal harbors reaching toward all 4 spawns
    addRect(waterSet, 14, 0, 9, 8);
    addRect(waterSet, 41, 0, 9, 8);
    addRect(waterSet, 14, 56, 9, 8);
    addRect(waterSet, 41, 56, 9, 8);
    // Coastal cliffs guarding the approaches
    addRect(cliffSet, 18, 22, 3, 5);
    addRect(cliffSet, 43, 22, 3, 5);
    addRect(cliffSet, 18, 37, 3, 5);
    addRect(cliffSet, 43, 37, 3, 5);
    derricks = [
      [31, 13],
      [31, 48],
    ];
    extraOre = [
      [15, 32, 3],
      [48, 32, 3],
    ];
  } else {
    // oasis
    addRect(cliffSet, 24, 15, 16, 2);
    addRect(cliffSet, 24, 47, 16, 2);
    addRect(cliffSet, 15, 24, 2, 16);
    addRect(cliffSet, 47, 24, 2, 16);
    derricks = [
      [31, 7],
      [31, 55],
    ];
    extraOre = [
      [22, 32, 3],
      [42, 32, 3],
    ];
  }

  // Ensure cliffs and water never overlap
  for (const k of cliffSet) waterSet.delete(k);

  const cliffs: [number, number][] = [];
  for (const k of cliffSet) cliffs.push([k % MAP_W, (k / MAP_W) | 0]);
  const water: [number, number][] = [];
  for (const k of waterSet) water.push([k % MAP_W, (k / MAP_W) | 0]);
  const layout: MapLayout = { cliffs, water, derricks, extraOre };
  mapCache.set(id, layout);
  return layout;
}
