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
  | "coastline"
  | "atlantis"
  | "shipwreck"
  | "volcano"
  | "oilrig"
  | "cybergrid";

export type ArtifactKind =
  | "shipwreck"
  | "lighthouse"
  | "buoy"
  | "obelisk"
  | "seagate"
  | "oilrig_tower"
  | "lava_vent"
  | "monolith"
  | "seastack";

export interface MapArtifact {
  kind: ArtifactKind;
  x: number;
  y: number;
  rot?: number;
  scale?: number;
}

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
export const SHIPYARD_BUILD_DIST = 13; // max gap from own base to place Naval Shipyard on water

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

// ---------- Deterministic Handcrafted Maps (15 Biomes & Creative Ocean/Artifact Theaters) ----------
export const MAP_LIST: { id: MapId; name: string; biome: string; naval?: boolean; desc: string }[] = [
  { id: "crossroads", name: "Twin Crossroads", biome: "Steppe", desc: "Balanced flank mesas & twin contested Oil Derricks" },
  { id: "canyon", name: "Iron Canyon", biome: "Canyon", desc: "Twin sandstone canyon walls channeling fights across 3 lanes" },
  { id: "basin", name: "Shattered Basin", biome: "Alpine", desc: "Open volcanic ore basin ringed by 4 captureable Oil Derricks" },
  { id: "tundra", name: "Frostbite Pass", biome: "Arctic", desc: "Frozen glacial divide with wide north/south bypasses & rich center ice field" },
  { id: "fortress", name: "Citadel Bastion", biome: "Desert", desc: "Walled central citadel with 4 gates guarding a mega ore cache" },
  { id: "jungle", name: "Emerald Valley", biome: "Jungle", desc: "Diagonal ridge corridors built for ambushes & flanking raids" },
  { id: "islands", name: "Bridgehead Crossing", biome: "Riverland", naval: true, desc: "Navigable river channels, lighthouses & bridges — Land, Air & Sea" },
  { id: "oasis", name: "Scorched Oasis", biome: "Sahara", desc: "Golden dune ring with fast open flank tank lanes & twin oasis passes" },
  { id: "archipelago", name: "Pacific Atoll", biome: "Ocean", naval: true, desc: "4 corner islands & volcanic atoll with sea-stacks & blinking buoys" },
  { id: "coastline", name: "Storm Coast", biome: "Coastal", naval: true, desc: "Stormy North Sea straits with coastal lighthouses & dreadnought lanes" },
  { id: "atlantis", name: "Sunken Atlantis", biome: "Mythic Sea", naval: true, desc: "Ancient submerged crystal obelisks, glowing sea-gates & golden causeways" },
  { id: "shipwreck", name: "Titan Graveyard", biome: "Abyssal", naval: true, desc: "Colossal sunken dreadnought wrecks, reefs & salvage ore shoals" },
  { id: "volcano", name: "Caldera Forge", biome: "Volcanic", naval: true, desc: "Steaming coastal sea ringing a glowing molten caldera & obsidian bridges" },
  { id: "oilrig", name: "Offshore Megarig", biome: "Deep Sea", naval: true, desc: "Open-ocean platform bridges converging on a giant central oil megastructure" },
  { id: "cybergrid", name: "Neon Megastructure", biome: "Orbital", desc: "High-tech titanium battle deck with floating crystal monoliths & energy trenches" },
];

export interface MapLayout {
  cliffs: [number, number][]; // impassable elevated rocky/glacial/lava/monolith tiles (aircraft fly over!)
  water: [number, number][]; // navigable ocean/river tiles (ships sail on, aircraft fly over!)
  derricks: [number, number][]; // top-left 2x2 tile of neutral Oil Derricks
  extraOre?: [number, number, number][]; // optional [cx, cy, radius] bonus ore blobs
  artifacts?: MapArtifact[]; // 3D visual landmarks & ocean artifacts
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
  let artifacts: MapArtifact[] | undefined;

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
    // Navigable wide river channels forming a coastal cross + 4 outer bridges + 4 center bridges + corner coves
    addRect(waterSet, 26, 0, 12, 12);
    addRect(waterSet, 26, 17, 12, 9);
    addRect(waterSet, 26, 38, 12, 9);
    addRect(waterSet, 26, 52, 12, 12);
    addRect(waterSet, 0, 26, 12, 12);
    addRect(waterSet, 17, 26, 9, 12);
    addRect(waterSet, 38, 26, 9, 12);
    addRect(waterSet, 52, 26, 12, 12);
    // 4 land causeways connecting the outer quadrants straight into the central ore island
    clearRect(waterSet, 30, 17, 4, 9);
    clearRect(waterSet, 30, 38, 4, 9);
    clearRect(waterSet, 17, 30, 9, 4);
    clearRect(waterSet, 38, 30, 9, 4);
    // Coastal coves reaching within range of each spawn so Shipyards can be deployed easily
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
    artifacts = [
      { kind: "lighthouse", x: 25, y: 12, scale: 1.0 },
      { kind: "lighthouse", x: 39, y: 52, scale: 1.0 },
      { kind: "buoy", x: 32, y: 6 },
      { kind: "buoy", x: 32, y: 58 },
      { kind: "buoy", x: 6, y: 32 },
      { kind: "buoy", x: 58, y: 32 },
    ];
  } else if (id === "archipelago") {
    // Pacific Atoll: Open ocean surrounding 4 generous corner islands + central volcanic ore atoll + narrow causeways
    addRect(waterSet, 0, 0, MAP_W, MAP_H);
    clearRect(waterSet, 0, 0, 18, 18);
    clearRect(waterSet, 46, 0, 18, 18);
    clearRect(waterSet, 0, 46, 18, 18);
    clearRect(waterSet, 46, 46, 18, 18);
    clearRect(waterSet, 25, 25, 14, 14);
    // 4 shallow coastal sandbar bridges linking the 4 corner islands & central volcanic atoll
    clearRect(waterSet, 30, 14, 4, 12);
    clearRect(waterSet, 30, 38, 4, 12);
    clearRect(waterSet, 14, 30, 12, 4);
    clearRect(waterSet, 38, 30, 12, 4);
    clearRect(waterSet, 13, 17, 4, 14);
    clearRect(waterSet, 47, 17, 4, 14);
    clearRect(waterSet, 13, 33, 4, 14);
    clearRect(waterSet, 47, 33, 4, 14);
    clearRect(waterSet, 29, 7, 6, 7);
    clearRect(waterSet, 29, 50, 6, 7);
    clearRect(waterSet, 7, 29, 7, 6);
    clearRect(waterSet, 50, 29, 7, 6);
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
    artifacts = [
      { kind: "seastack", x: 22, y: 12, scale: 1.2 },
      { kind: "seastack", x: 42, y: 52, scale: 1.2 },
      { kind: "shipwreck", x: 42, y: 14, rot: 0.7, scale: 1.0 },
      { kind: "shipwreck", x: 22, y: 50, rot: -2.2, scale: 1.0 },
      { kind: "lighthouse", x: 17, y: 17, scale: 0.95 },
      { kind: "lighthouse", x: 47, y: 47, scale: 0.95 },
      { kind: "buoy", x: 24, y: 20 },
      { kind: "buoy", x: 40, y: 44 },
    ];
  } else if (id === "coastline") {
    // Storm Coast: Wide open ocean channels along the top, bottom & mid-strait with 2 wide coastal continents
    addRect(waterSet, 23, 0, 18, MAP_H);
    clearRect(waterSet, 23, 12, 18, 5);
    clearRect(waterSet, 23, 29, 18, 6);
    clearRect(waterSet, 23, 47, 18, 5);
    addRect(waterSet, 14, 0, 9, 8);
    addRect(waterSet, 41, 0, 9, 8);
    addRect(waterSet, 14, 56, 9, 8);
    addRect(waterSet, 41, 56, 9, 8);
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
    artifacts = [
      { kind: "lighthouse", x: 22, y: 12, scale: 1.05 },
      { kind: "lighthouse", x: 42, y: 52, scale: 1.05 },
      { kind: "shipwreck", x: 32, y: 22, rot: 0.35, scale: 1.1 },
      { kind: "shipwreck", x: 32, y: 41, rot: -2.6, scale: 1.1 },
      { kind: "buoy", x: 28, y: 5 },
      { kind: "buoy", x: 36, y: 59 },
    ];
  } else if (id === "atlantis") {
    // Sunken Atlantis: Turquoise ocean with sunken crystal obelisks, glowing sea-gates & golden causeways
    addRect(waterSet, 0, 0, MAP_W, MAP_H);
    clearRect(waterSet, 0, 0, 19, 19);
    clearRect(waterSet, 45, 0, 19, 19);
    clearRect(waterSet, 0, 45, 19, 19);
    clearRect(waterSet, 45, 45, 19, 19);
    // Central sunken temple plaza + 4 diagonal/cardinal golden causeways
    clearRect(waterSet, 24, 24, 16, 16);
    clearRect(waterSet, 19, 29, 6, 6);
    clearRect(waterSet, 39, 29, 6, 6);
    clearRect(waterSet, 29, 19, 6, 6);
    clearRect(waterSet, 29, 39, 6, 6);
    clearRect(waterSet, 14, 19, 5, 12);
    clearRect(waterSet, 45, 33, 5, 12);
    clearRect(waterSet, 45, 19, 5, 12);
    clearRect(waterSet, 14, 33, 5, 12);
    // Ancient temple pylons (impassable cliff blocks anchoring obelisks)
    addRect(cliffSet, 25, 25, 2, 2);
    addRect(cliffSet, 37, 25, 2, 2);
    addRect(cliffSet, 25, 37, 2, 2);
    addRect(cliffSet, 37, 37, 2, 2);
    derricks = [
      [28, 28],
      [34, 34],
      [21, 31],
      [41, 31],
    ];
    extraOre = [
      [32, 32, 3],
      [32, 21, 2],
      [32, 43, 2],
    ];
    artifacts = [
      { kind: "seagate", x: 32, y: 10, rot: 0, scale: 1.35 },
      { kind: "seagate", x: 32, y: 54, rot: 0, scale: 1.35 },
      { kind: "seagate", x: 7, y: 32, rot: Math.PI / 2, scale: 1.25 },
      { kind: "seagate", x: 57, y: 32, rot: Math.PI / 2, scale: 1.25 },
      { kind: "obelisk", x: 26, y: 26, scale: 1.2 },
      { kind: "obelisk", x: 38, y: 26, scale: 1.2 },
      { kind: "obelisk", x: 26, y: 38, scale: 1.2 },
      { kind: "obelisk", x: 38, y: 38, scale: 1.2 },
      { kind: "obelisk", x: 22, y: 12, scale: 1.0 },
      { kind: "obelisk", x: 42, y: 52, scale: 1.0 },
    ];
  } else if (id === "shipwreck") {
    // Titan Graveyard: Stormy abyssal sea littered with colossal sunken dreadnought wrecks & salvage shoals
    addRect(waterSet, 0, 0, MAP_W, MAP_H);
    clearRect(waterSet, 0, 0, 18, 18);
    clearRect(waterSet, 46, 0, 18, 18);
    clearRect(waterSet, 0, 46, 18, 18);
    clearRect(waterSet, 46, 46, 18, 18);
    // Salvage sandbar cross & central wreck shoal + corner connectors
    clearRect(waterSet, 25, 25, 14, 14);
    clearRect(waterSet, 15, 29, 34, 6);
    clearRect(waterSet, 29, 15, 6, 34);
    clearRect(waterSet, 14, 17, 4, 14);
    clearRect(waterSet, 46, 17, 4, 14);
    clearRect(waterSet, 14, 33, 4, 14);
    clearRect(waterSet, 46, 33, 4, 14);
    // Reef rocks beside wrecks
    addRect(cliffSet, 22, 20, 3, 2);
    addRect(cliffSet, 39, 42, 3, 2);
    addRect(cliffSet, 39, 20, 3, 2);
    addRect(cliffSet, 22, 42, 3, 2);
    derricks = [
      [18, 31],
      [44, 31],
      [31, 18],
      [31, 44],
    ];
    extraOre = [
      [32, 32, 4],
      [21, 32, 2],
      [43, 32, 2],
    ];
    artifacts = [
      { kind: "shipwreck", x: 22, y: 10, rot: 0.4, scale: 1.5 },
      { kind: "shipwreck", x: 42, y: 54, rot: -2.7, scale: 1.5 },
      { kind: "shipwreck", x: 43, y: 11, rot: -0.6, scale: 1.4 },
      { kind: "shipwreck", x: 21, y: 53, rot: 2.5, scale: 1.4 },
      { kind: "shipwreck", x: 10, y: 32, rot: 1.45, scale: 1.3 },
      { kind: "shipwreck", x: 54, y: 32, rot: -1.65, scale: 1.3 },
      { kind: "seastack", x: 23, y: 21, scale: 1.1 },
      { kind: "seastack", x: 40, y: 43, scale: 1.1 },
      { kind: "buoy", x: 32, y: 8 },
      { kind: "buoy", x: 32, y: 56 },
    ];
  } else if (id === "volcano") {
    // Caldera Forge: Steaming sea border + glowing volcanic caldera crater ring with obsidian bridges
    addRect(waterSet, 0, 0, MAP_W, 5);
    addRect(waterSet, 0, 59, MAP_W, 5);
    addRect(waterSet, 0, 0, 5, MAP_H);
    addRect(waterSet, 59, 0, 5, MAP_H);
    // Keep 4 corner spawn harbors clean while giving easy Shipyard access!
    clearRect(waterSet, 0, 0, 14, 14);
    clearRect(waterSet, 50, 0, 14, 14);
    clearRect(waterSet, 0, 50, 14, 14);
    clearRect(waterSet, 50, 50, 14, 14);
    addRect(waterSet, 15, 0, 14, 7);
    addRect(waterSet, 35, 0, 14, 7);
    addRect(waterSet, 15, 57, 14, 7);
    addRect(waterSet, 35, 57, 14, 7);
    // Central volcanic caldera ridge ring with 4 wide molten-rock breaches
    addRect(cliffSet, 24, 22, 6, 3);
    addRect(cliffSet, 34, 22, 6, 3);
    addRect(cliffSet, 24, 39, 6, 3);
    addRect(cliffSet, 34, 39, 6, 3);
    addRect(cliffSet, 22, 25, 3, 5);
    addRect(cliffSet, 22, 34, 3, 5);
    addRect(cliffSet, 39, 25, 3, 5);
    addRect(cliffSet, 39, 34, 3, 5);
    derricks = [
      [31, 12],
      [31, 50],
      [12, 31],
      [50, 31],
    ];
    extraOre = [[32, 32, 4]];
    artifacts = [
      { kind: "lava_vent", x: 26, y: 23.5, scale: 1.2 },
      { kind: "lava_vent", x: 38, y: 23.5, scale: 1.2 },
      { kind: "lava_vent", x: 26, y: 40.5, scale: 1.2 },
      { kind: "lava_vent", x: 38, y: 40.5, scale: 1.2 },
      { kind: "seastack", x: 20, y: 3, scale: 1.1 },
      { kind: "seastack", x: 44, y: 61, scale: 1.1 },
    ];
  } else if (id === "oilrig") {
    // Offshore Megarig: Deep open ocean with 4 corner launch platforms + steel sea-bridges to a giant central oil platform!
    addRect(waterSet, 0, 0, MAP_W, MAP_H);
    clearRect(waterSet, 0, 0, 17, 17);
    clearRect(waterSet, 47, 0, 17, 17);
    clearRect(waterSet, 0, 47, 17, 17);
    clearRect(waterSet, 47, 47, 17, 17);
    // Giant central offshore platform deck + 4 cardinal highway bridges
    clearRect(waterSet, 23, 23, 18, 18);
    clearRect(waterSet, 16, 29, 8, 6);
    clearRect(waterSet, 40, 29, 8, 6);
    clearRect(waterSet, 29, 16, 6, 8);
    clearRect(waterSet, 29, 40, 6, 8);
    // Connector bridges to the 4 corner pads
    clearRect(waterSet, 12, 16, 5, 16);
    clearRect(waterSet, 47, 16, 5, 16);
    clearRect(waterSet, 12, 32, 5, 16);
    clearRect(waterSet, 47, 32, 5, 16);
    derricks = [
      [25, 25],
      [37, 25],
      [25, 37],
      [37, 37],
    ];
    extraOre = [[32, 32, 3]];
    artifacts = [
      { kind: "oilrig_tower", x: 32, y: 24, scale: 1.2 },
      { kind: "oilrig_tower", x: 32, y: 40, scale: 1.2 },
      { kind: "lighthouse", x: 17, y: 17, scale: 0.9 },
      { kind: "lighthouse", x: 47, y: 47, scale: 0.9 },
      { kind: "buoy", x: 24, y: 10 },
      { kind: "buoy", x: 40, y: 10 },
      { kind: "buoy", x: 24, y: 54 },
      { kind: "buoy", x: 40, y: 54 },
      { kind: "shipwreck", x: 5, y: 32, rot: 0.2, scale: 1.1 },
      { kind: "shipwreck", x: 59, y: 32, rot: -2.9, scale: 1.1 },
    ];
  } else if (id === "cybergrid") {
    // Neon Megastructure: High-tech orbital titanium battle deck with crystalline monolith barriers
    addRect(cliffSet, 20, 20, 4, 2);
    addRect(cliffSet, 40, 20, 4, 2);
    addRect(cliffSet, 20, 42, 4, 2);
    addRect(cliffSet, 40, 42, 4, 2);
    addRect(cliffSet, 30, 12, 4, 5);
    addRect(cliffSet, 30, 47, 4, 5);
    addRect(cliffSet, 12, 30, 5, 4);
    addRect(cliffSet, 47, 30, 5, 4);
    derricks = [
      [31, 21],
      [31, 41],
      [21, 31],
      [41, 31],
    ];
    extraOre = [
      [32, 32, 4],
      [20, 32, 2],
      [44, 32, 2],
    ];
    artifacts = [
      { kind: "monolith", x: 32, y: 14.5, scale: 1.3 },
      { kind: "monolith", x: 32, y: 49.5, scale: 1.3 },
      { kind: "monolith", x: 14.5, y: 32, scale: 1.3 },
      { kind: "monolith", x: 49.5, y: 32, scale: 1.3 },
      { kind: "monolith", x: 22, y: 21, scale: 0.95 },
      { kind: "monolith", x: 42, y: 21, scale: 0.95 },
      { kind: "monolith", x: 22, y: 43, scale: 0.95 },
      { kind: "monolith", x: 42, y: 43, scale: 0.95 },
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
  const layout: MapLayout = { cliffs, water, derricks, extraOre, artifacts };
  mapCache.set(id, layout);
  return layout;
}
