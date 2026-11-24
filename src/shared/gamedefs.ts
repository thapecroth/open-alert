// Shared game constants & definitions (must stay lib-agnostic: no DOM, no workerd types)

export const MAP_W = 64; // default standard map width (individual maps may be 64, 96, or 128)
export const MAP_H = 64; // default standard map height
export const TICK_MS = 100; // sim runs at 10 Hz
export const SNAP_EVERY = 2; // broadcast every 2 ticks => 5 Hz
export const MAX_PLAYERS = 8;
export const START_CREDITS = 5000;
export const ORE_VALUE = 25; // credits per unit of cargo

export type BuildingKind =
  | "conyard"
  | "power"
  | "coalplant"
  | "fusion"
  | "refinery"
  | "supplyhub"
  | "barracks"
  | "barracks2"
  | "radar"
  | "factory"
  | "factory2"
  | "airfield"
  | "airfield2"
  | "shipyard"
  | "shipyard2"
  | "techlab"
  | "satlink"
  | "purifier"
  | "depot"
  | "superweapon"
  // Dedicated parallel Defense category
  | "turret"
  | "sam"
  | "arc"
  | "irondome"
  | "lasertower"
  | "thaad"
  // Neutral captureable resource structures
  | "derrick"
  | "coalmine";

export type BuildCategory = "structure" | "defense";

export type UnitKind =
  // Land Infantry & Field Drones
  | "infantry"
  | "engineer"
  | "rocket"
  | "fpvdrone"
  | "spy"
  // Land Vehicles
  | "tank"
  | "arty"
  | "heavy"
  | "spider"
  | "himars"
  | "railtank"
  | "ballistic"
  | "supplytruck"
  | "harvester"
  // Air Force & Modern Drones
  | "uav"
  | "shahed"
  | "ewdrone"
  | "interceptor"
  | "chopper"
  | "a10"
  | "ac130"
  | "bomber"
  | "stealthbomber"
  | "hypersonic"
  | "zeppelin"
  // Navy & Unmanned Drone Boats
  | "usv"
  | "gunboat"
  | "destroyer"
  | "sub"
  | "dreadnought"
  | "carrier";

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
  | "cybergrid"
  // Real-world naval theaters
  | "hormuz"
  | "delta"
  | "bering"
  // Huge 8-Player Grand Theater Maps (96x96 & 128x128)
  | "europa"
  | "pacific_theatre"
  | "megacontinent"
  | "arctic_front";

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
  logistics?: boolean; // real-world Fuel & Ammo logistics (default true)
}

export const DEFAULT_CONFIG: GameConfig = {
  startCredits: START_CREDITS,
  gameSpeed: 1,
  superweapons: true,
  crates: true,
  derricks: true,
  fog: true,
  logistics: true,
};

export const BOT_PROFILES: { id: BotProfile; label: string; desc: string }[] = [
  { id: "balanced", label: "Balanced", desc: "Adaptive economy, mixed army & steady pressure" },
  { id: "rusher", label: "Rusher", desc: "Early aggressive raids & fast infantry/tank waves" },
  { id: "turtle", label: "Turtle", desc: "Heavy Iron Dome/SAM/laser defenses & massive late counter-push" },
  { id: "tech", label: "Tech Boom", desc: "Greedy economy, fast Tech Lab, Orbital Sat, Railguns & Stealth Bombers" },
];

export interface BuildingDef {
  w: number; // footprint in tiles
  h: number;
  cost: number;
  hp: number;
  power: number; // + provides, - consumes
  buildTicks: number;
  category?: BuildCategory; // "defense" builds in parallel with "structure" (default "structure")
  range?: number;
  dmg?: number;
  rof?: number; // ticks between shots
  canHitAir?: boolean; // defense can engage flying aircraft
  canHitGround?: boolean; // default true unless explicitly false (dedicated SAM)
  requires?: BuildingKind[]; // tech prerequisites — all must exist before cmdBuild
  noBuild?: true; // exists in the world but can't be queued (upgrade/neutral structures)
  limit?: number; // max count per player
  waterOnly?: true; // must be placed on water tiles (Naval Shipyard)
  forwardRange?: number; // extended build distance for Forward Supply Hubs
}

export const BUILDINGS: Record<BuildingKind, BuildingDef> = {
  // Core & Economy Structures
  conyard: { w: 3, h: 3, cost: 0, hp: 1000, power: 40, buildTicks: 0 },
  power: { w: 2, h: 2, cost: 300, hp: 400, power: 100, buildTicks: 50 },
  coalplant: { w: 2, h: 2, cost: 0, hp: 580, power: 200, buildTicks: 0, noBuild: true },
  fusion: { w: 2, h: 2, cost: 0, hp: 900, power: 420, buildTicks: 0, noBuild: true },
  refinery: { w: 3, h: 2, cost: 600, hp: 700, power: -35, buildTicks: 80 },
  supplyhub: { w: 2, h: 2, cost: 650, hp: 580, power: -15, buildTicks: 60, requires: ["refinery"], forwardRange: 26 },
  barracks: { w: 2, h: 2, cost: 500, hp: 500, power: -20, buildTicks: 70 },
  barracks2: { w: 2, h: 2, cost: 0, hp: 750, power: -30, buildTicks: 0, noBuild: true },
  radar: { w: 2, h: 2, cost: 550, hp: 500, power: -40, buildTicks: 60, requires: ["barracks"] },
  factory: { w: 3, h: 3, cost: 1000, hp: 900, power: -30, buildTicks: 110 },
  factory2: { w: 3, h: 3, cost: 0, hp: 1300, power: -40, buildTicks: 0, noBuild: true },
  airfield: { w: 3, h: 2, cost: 1000, hp: 750, power: -40, buildTicks: 95, requires: ["radar"] },
  airfield2: { w: 3, h: 2, cost: 0, hp: 1100, power: -55, buildTicks: 0, noBuild: true },
  shipyard: { w: 3, h: 3, cost: 1000, hp: 950, power: -35, buildTicks: 100, requires: ["power"], waterOnly: true },
  shipyard2: { w: 3, h: 3, cost: 0, hp: 1350, power: -50, buildTicks: 0, noBuild: true, waterOnly: true },
  depot: { w: 3, h: 2, cost: 800, hp: 700, power: -30, buildTicks: 90, requires: ["factory"] },
  techlab: { w: 3, h: 3, cost: 1800, hp: 800, power: -60, buildTicks: 130, requires: ["radar", "factory"] },
  purifier: { w: 2, h: 2, cost: 900, hp: 500, power: -25, buildTicks: 90, requires: ["techlab"] },
  satlink: { w: 3, h: 3, cost: 2000, hp: 950, power: -80, buildTicks: 135, requires: ["techlab"], limit: 1, range: 15, dmg: 38, rof: 28, canHitAir: true },
  superweapon: { w: 3, h: 3, cost: 2500, hp: 1100, power: -100, buildTicks: 150, requires: ["satlink"], limit: 1 },

  // Dedicated Parallel Defense Category (cost-efficient modern defense-tech stack!)
  turret: { w: 1, h: 1, cost: 400, hp: 420, power: -20, buildTicks: 45, category: "defense", range: 6.5, dmg: 15, rof: 14, canHitAir: true },
  sam: { w: 2, h: 2, cost: 420, hp: 520, power: -30, buildTicks: 45, category: "defense", range: 11.5, dmg: 36, rof: 18, canHitAir: true, canHitGround: false, requires: ["radar"] },
  arc: { w: 1, h: 1, cost: 700, hp: 550, power: -40, buildTicks: 60, category: "defense", range: 7.5, dmg: 32, rof: 24, canHitAir: true, requires: ["radar"] },
  irondome: { w: 2, h: 2, cost: 850, hp: 720, power: -45, buildTicks: 60, category: "defense", range: 10.5, dmg: 26, rof: 14, canHitAir: true, canHitGround: false, requires: ["radar", "techlab"], limit: 3 },
  lasertower: { w: 2, h: 2, cost: 1350, hp: 820, power: -65, buildTicks: 80, category: "defense", range: 9.5, dmg: 68, rof: 28, canHitAir: true, requires: ["techlab"] },
  thaad: { w: 2, h: 2, cost: 1150, hp: 780, power: -55, buildTicks: 75, category: "defense", range: 14, dmg: 54, rof: 24, canHitAir: true, canHitGround: false, requires: ["satlink"], limit: 2 },

  // Neutral Captureable Resource Landmarks
  derrick: { w: 2, h: 2, cost: 0, hp: 850, power: 0, buildTicks: 0, noBuild: true },
  coalmine: { w: 2, h: 2, cost: 0, hp: 900, power: 60, buildTicks: 0, noBuild: true },
};

export function buildCategoryOf(kind: BuildingKind): BuildCategory {
  return BUILDINGS[kind].category === "defense" ? "defense" : "structure";
}

export const BUILD_ORDER: BuildingKind[] = [
  "power",
  "refinery",
  "supplyhub",
  "barracks",
  "radar",
  "factory",
  "airfield",
  "shipyard",
  "depot",
  "techlab",
  "purifier",
  "satlink",
  "superweapon",
];

export const DEFENSE_ORDER: BuildingKind[] = [
  "turret",
  "sam",
  "arc",
  "irondome",
  "lasertower",
  "thaad",
];

// Upgrade paths for production buildings (deep tech tree!)
export interface UpgradePath {
  from: BuildingKind;
  to: BuildingKind;
  cost: number;
  requires: BuildingKind;
  desc: string;
}

export const UPGRADE_PATHS: Record<string, UpgradePath> = {
  power: {
    from: "power",
    to: "coalplant",
    cost: 300,
    requires: "refinery",
    desc: "Upgrade Power Plant to Thermal Coal Plant (+200⚡ power, 580 HP).",
  },
  coalplant: {
    from: "coalplant",
    to: "fusion",
    cost: 800,
    requires: "techlab",
    desc: "Upgrade Thermal Coal Plant to Tokamak Fusion Reactor (+420⚡ clean power, 900 HP).",
  },
  barracks: {
    from: "barracks",
    to: "barracks2",
    cost: 900,
    requires: "radar",
    desc: "Upgrade Barracks to Elite Command — trains Veteran ★ infantry + faster deployment.",
  },
  factory: {
    from: "factory",
    to: "factory2",
    cost: 1500,
    requires: "techlab",
    desc: "Upgrade War Factory to MKII — unlocks Aegis Railgun MBT + faster armored production.",
  },
  airfield: {
    from: "airfield",
    to: "airfield2",
    cost: 1400,
    requires: "techlab",
    desc: "Upgrade Air Command to Stealth Wing — unlocks B-21 Stealth Bomber & Mach-9 Hypersonic + Veteran ★ air.",
  },
  shipyard: {
    from: "shipyard",
    to: "shipyard2",
    cost: 1400,
    requires: "techlab",
    desc: "Upgrade Naval Shipyard to Fleet Dock — unlocks Nimitz Drone Carrier & Poseidon Dreadnought + Veteran ★ ships.",
  },
};

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
  stealth?: boolean; // cloaked until firing or detected (Kraken Sub / B-21 Stealth Bomber / Sea-Baby USV)
  kamikaze?: true; // self-detonates on strike for high splash damage (FPV Drone / Delta Drone / Sea-Baby USV)
  ewJamRadius?: number; // electronic warfare jamming radius vs enemy drones
  retired?: true; // legacy RA2-era unit hidden from modern roster (kept for test/script compatibility)
  vision?: number; // optional custom vision radius (default 9)
  requires?: BuildingKind; // extra prerequisite building
  capacity?: number; // harvester / supplytruck cargo units
}

export const UNITS: Record<UnitKind, UnitDef> = {
  // Land Infantry & Field Drones
  infantry: { hp: 90, speed: 0.1, range: 4, dmg: 6, rof: 15, cost: 100, buildTicks: 30, trainsAt: "barracks", domain: "land", canHitAir: true },
  engineer: { hp: 70, speed: 0.1, range: 0, dmg: 0, rof: 0, cost: 500, buildTicks: 40, trainsAt: "barracks", domain: "land" },
  rocket: { hp: 80, speed: 0.11, range: 6.5, dmg: 11, rof: 18, cost: 300, buildTicks: 35, trainsAt: "barracks", domain: "land", requires: "radar", canHitAir: true },
  fpvdrone: { hp: 48, speed: 0.36, range: 1.45, dmg: 135, rof: 10, cost: 45, buildTicks: 14, trainsAt: "barracks", domain: "air", kamikaze: true, vision: 10 },
  spy: { hp: 90, speed: 0.14, range: 0, dmg: 0, rof: 0, cost: 700, buildTicks: 50, trainsAt: "barracks", domain: "land", requires: "radar" },
  // Modern Armor & Logistics
  tank: { hp: 340, speed: 0.16, range: 5, dmg: 22, rof: 22, cost: 700, buildTicks: 70, trainsAt: "factory", domain: "land" },
  himars: { hp: 220, speed: 0.13, range: 12.5, dmg: 68, rof: 44, cost: 1100, buildTicks: 85, trainsAt: "factory", domain: "land", requires: "radar" },
  railtank: { hp: 720, speed: 0.13, range: 7.5, dmg: 62, rof: 26, cost: 1650, buildTicks: 105, trainsAt: "factory", domain: "land", requires: "factory2", canHitAir: true },
  ballistic: { hp: 320, speed: 0.115, range: 17, dmg: 300, rof: 110, cost: 1600, buildTicks: 110, trainsAt: "factory", domain: "land", requires: "factory2" },
  supplytruck: { hp: 320, speed: 0.17, range: 0, dmg: 0, rof: 0, cost: 420, buildTicks: 45, trainsAt: "factory", domain: "land", requires: "refinery", capacity: 500 },
  harvester: { hp: 620, speed: 0.11, range: 0, dmg: 0, rof: 0, cost: 1400, buildTicks: 100, trainsAt: "factory", domain: "land", requires: "refinery", capacity: 45 },
  // Retired legacy land units (hidden from modern UI roster)
  arty: { hp: 140, speed: 0.1, range: 9, dmg: 42, rof: 42, cost: 1100, buildTicks: 90, trainsAt: "factory", domain: "land", requires: "radar", retired: true },
  heavy: { hp: 560, speed: 0.12, range: 5, dmg: 36, rof: 24, cost: 1100, buildTicks: 95, trainsAt: "factory", domain: "land", requires: "factory2", retired: true },
  spider: { hp: 90, speed: 0.26, range: 1.4, dmg: 9, rof: 9, cost: 500, buildTicks: 45, trainsAt: "factory", domain: "land", requires: "factory2", retired: true },
  // Modern Air Force & Real-World Proportionate Drone Warfare (Anduril / Attritable Tech!)
  uav: { hp: 130, speed: 0.30, range: 6.5, dmg: 18, rof: 16, cost: 550, buildTicks: 50, trainsAt: "airfield", domain: "air", canHitAir: true, vision: 13 },
  shahed: { hp: 95, speed: 0.28, range: 1.65, dmg: 210, rof: 10, cost: 110, buildTicks: 24, trainsAt: "airfield", domain: "air", kamikaze: true, vision: 9 },
  ewdrone: { hp: 185, speed: 0.24, range: 0, dmg: 0, rof: 0, cost: 280, buildTicks: 40, trainsAt: "airfield", domain: "air", ewJamRadius: 8.5, vision: 12, requires: "radar" },
  interceptor: { hp: 190, speed: 0.34, range: 6.5, dmg: 26, rof: 18, cost: 750, buildTicks: 55, trainsAt: "airfield", domain: "air", canHitAir: true },
  chopper: { hp: 310, speed: 0.22, range: 6, dmg: 22, rof: 14, cost: 1000, buildTicks: 70, trainsAt: "airfield", domain: "air", canHitAir: true },
  a10: { hp: 460, speed: 0.27, range: 6.8, dmg: 22, rof: 6, cost: 950, buildTicks: 70, trainsAt: "airfield", domain: "air", canHitAir: true, requires: "radar" },
  ac130: { hp: 980, speed: 0.14, range: 8.8, dmg: 74, rof: 20, cost: 2100, buildTicks: 110, trainsAt: "airfield", domain: "air", vision: 13, requires: "airfield2" },
  stealthbomber: { hp: 480, speed: 0.23, range: 6.5, dmg: 850, rof: 200, cost: 13000, buildTicks: 160, trainsAt: "airfield", domain: "air", stealth: true, requires: "airfield2" },
  hypersonic: { hp: 180, speed: 1.25, range: 2.2, dmg: 520, rof: 10, cost: 750, buildTicks: 55, trainsAt: "airfield", domain: "air", kamikaze: true, vision: 10, requires: "airfield2" },
  // Retired legacy air units (hidden from modern UI roster)
  bomber: { hp: 420, speed: 0.18, range: 5.5, dmg: 80, rof: 46, cost: 1600, buildTicks: 95, trainsAt: "airfield", domain: "air", requires: "techlab", retired: true },
  zeppelin: { hp: 1400, speed: 0.085, range: 3.6, dmg: 135, rof: 38, cost: 2200, buildTicks: 120, trainsAt: "airfield", domain: "air", requires: "techlab", retired: true },
  // Modern Navy & Unmanned Autonomous Vessels
  usv: { hp: 115, speed: 0.30, range: 1.75, dmg: 260, rof: 10, cost: 190, buildTicks: 30, trainsAt: "shipyard", domain: "sea", kamikaze: true, stealth: true, vision: 9 },
  gunboat: { hp: 240, speed: 0.24, range: 6.5, dmg: 16, rof: 14, cost: 600, buildTicks: 50, trainsAt: "shipyard", domain: "sea", canHitAir: true },
  destroyer: { hp: 580, speed: 0.14, range: 7.5, dmg: 32, rof: 22, cost: 1250, buildTicks: 80, trainsAt: "shipyard", domain: "sea", canHitAir: true },
  sub: { hp: 460, speed: 0.15, range: 7, dmg: 52, rof: 30, cost: 950, buildTicks: 68, trainsAt: "shipyard", domain: "sea", stealth: true, requires: "radar" },
  dreadnought: { hp: 1150, speed: 0.09, range: 13, dmg: 92, rof: 46, cost: 2400, buildTicks: 115, trainsAt: "shipyard", domain: "sea", requires: "shipyard2" },
  carrier: { hp: 1350, speed: 0.10, range: 12, dmg: 64, rof: 26, cost: 2700, buildTicks: 125, trainsAt: "shipyard", domain: "sea", canHitAir: true, vision: 13, requires: "shipyard2" },
};

export const TRAIN_ORDER: { unit: UnitKind; label: string; group: "land" | "air" | "sea" }[] = [
  // Modern Land Infantry, Field Drones, Armor & Logistics
  { unit: "infantry", label: "Rifleman", group: "land" },
  { unit: "engineer", label: "Combat Engineer", group: "land" },
  { unit: "rocket", label: "AT / MANPADS", group: "land" },
  { unit: "fpvdrone", label: "FPV Suicide Drone", group: "land" },
  { unit: "spy", label: "Spy", group: "land" },
  { unit: "tank", label: "Main Battle Tank", group: "land" },
  { unit: "himars", label: "HIMARS Launcher", group: "land" },
  { unit: "railtank", label: "Aegis Railgun MBT", group: "land" },
  { unit: "ballistic", label: "Ballistic Missile", group: "land" },
  { unit: "supplytruck", label: "Supply Convoy", group: "land" },
  { unit: "harvester", label: "Ore Harvester", group: "land" },
  // Modern Air Force & Autonomous Defense-Tech Drones
  { unit: "uav", label: "Reaper UCAV", group: "air" },
  { unit: "shahed", label: "Delta Kamikaze", group: "air" },
  { unit: "ewdrone", label: "Jammer Drone", group: "air" },
  { unit: "interceptor", label: "Interceptor", group: "air" },
  { unit: "chopper", label: "Hornet Gunship", group: "air" },
  { unit: "a10", label: "A-10 Warthog", group: "air" },
  { unit: "ac130", label: "AC-130 Gunship", group: "air" },
  { unit: "stealthbomber", label: "B-21 Stealth Bomber", group: "air" },
  { unit: "hypersonic", label: "Mach-9 Missile", group: "air" },
  // Modern Navy & Unmanned Autonomous Vessels
  { unit: "usv", label: "Sea-Baby USV Drone", group: "sea" },
  { unit: "gunboat", label: "Viper Hydrofoil", group: "sea" },
  { unit: "destroyer", label: "Aegis Destroyer", group: "sea" },
  { unit: "sub", label: "Submarine", group: "sea" },
  { unit: "dreadnought", label: "Poseidon Cruiser", group: "sea" },
  { unit: "carrier", label: "Nimitz Drone Carrier", group: "sea" },
];

// display names for buildings (sidebar/tooltips)
export const BUILDING_NAMES: Record<BuildingKind, string> = {
  conyard: "Construction Yard",
  power: "Power Plant",
  coalplant: "Thermal Coal Plant",
  fusion: "Fusion Reactor",
  refinery: "Ore Refinery",
  supplyhub: "Forward Supply Hub",
  barracks: "Barracks",
  barracks2: "Barracks II",
  radar: "Radar Tower",
  factory: "War Factory",
  factory2: "War Factory II",
  airfield: "Air Command",
  airfield2: "Air Command II",
  shipyard: "Naval Shipyard",
  shipyard2: "Naval Shipyard II",
  depot: "Service Depot",
  techlab: "Tech Lab",
  purifier: "Ore Purifier",
  satlink: "Defense Satellite",
  superweapon: "Nuclear Silo",
  // Cost-Efficient Defense-Tech Stack
  turret: "Vulcan Turret",
  sam: "Anti-Air Turret",
  arc: "Arc Spire",
  irondome: "Iron Dome",
  lasertower: "Helios Laser",
  thaad: "Anti-Nuke",
  // Resource landmarks
  derrick: "Oil Derrick",
  coalmine: "Coal Mine",
};

// ---------- tech & special mechanics ----------
export const UPGRADE_COST = 1500; // factory -> factory2 (kept for backward-compat imports)
export const PURIFIER_BONUS = 0.25; // +25% credits per harvester deposit
export const DEPOT_RANGE = 6; // service depot heal aura radius (tiles)
export const DEPOT_HEAL = 4; // hp restored per vehicle per second
export const CAPTURE_RANGE = 1.9; // engineer must be this close to capture
export const SHIPYARD_BUILD_DIST = 13; // max gap from own base to place Naval Shipyard on water
export const IRONDOME_RADIUS = 9.5; // active projectile interception radius
export const IRONDOME_COOLDOWN = 22; // ticks between missile/shell intercepts per Iron Dome
export const THAAD_NUKE_RADIUS = 18; // exo-atmospheric Nuclear ICBM interception radius
export const THAAD_NUKE_CD = 450; // 45s reload after intercepting a nuclear missile
export const SUPPLY_HUB_RADIUS = 12; // Forward Supply Hub fuel/ammo/repair aura radius
export const SUPPLY_TRUCK_RADIUS = 5.5; // Mobile Logistics Supply Truck aura radius
export const BASE_SUPPLY_RADIUS = 8.5; // Base buildings (conyard/refinery/depot/airfield/shipyard/carrier) resupply radius

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

// Spy / Infiltrator sabotage mechanics
export const SPY_REVEAL_TICKS = 150; // blown cover lasts 15s once a powered Radar-tier sensor spots the spy
export const SPY_POWERCUT_TICKS = 300; // infiltrating a power plant blacks out the grid for 30s
export const SPY_DISABLE_TICKS = 450; // infiltrating a defense battery disables it for 45s
export const SPY_RADAR_SCRAMBLE_TICKS = 300; // infiltrating a radar/satellite blinds enemy sensors for 30s
export const SPY_CAPTURE_RANGE = 0.9;

// Neutral Oil Derricks, Coal Mines & Battlefield Supply Crates
export const DERRICK_CAPTURE_BONUS = 500;
export const DERRICK_INCOME = 25; // credits per second (every 10 ticks)
export const COALMINE_CAPTURE_BONUS = 400;
export const COALMINE_INCOME = 20; // credits per second + 60⚡ bonus power!
export const CRATE_INTERVAL_TICKS = 350; // drop every 35s
export const CRATE_MAX = 3;
export const CRATE_CASH = 1000;

// Splash damage radii
export const SPLASH_RADIUS: Partial<Record<EntKind, number>> = {
  arty: 2.3,
  heavy: 1.15,
  himars: 2.8,
  ballistic: 3.4,
  fpvdrone: 1.9,
  shahed: 2.6,
  usv: 2.4,
  bomber: 2.5,
  stealthbomber: 6.0,
  hypersonic: 3.6,
  ac130: 2.6,
  zeppelin: 2.9,
  dreadnought: 2.8,
  carrier: 1.8,
};

// Rich, long-lasting resource economy (3.5x longer ore lifetime!)
export const HARVEST_TICKS_PER_UNIT = 4; // 1 cargo per 4 ticks
export const ORE_REGEN_TICKS = 35; // ore regrowth pulse every 3.5s
export const ORE_CELL_MAX = 180; // 3x deeper ore cells (survives epic late-game wars!)
export const ORE_SPREAD_CHANCE = 0.08; // healthy regrowth around active fields
export const AGGRO_RANGE = 5; // idle units fire at enemies within this radius (no pursuit)

export const PLAYER_COLORS = [
  "#e03030", // 0 Red
  "#3390ff", // 1 Blue
  "#f0c020", // 2 Gold
  "#40c060", // 3 Green
  "#b84dff", // 4 Violet
  "#ff7a20", // 5 Orange
  "#22d4d4", // 6 Cyan
  "#ff4da6", // 7 Crimson
];
export const PLAYER_COLOR_NAMES = ["Red", "Blue", "Gold", "Green", "Violet", "Orange", "Cyan", "Crimson"];

// Dynamic 8-player perimeter spawns for any map dimensions (slots 0..3 stay exact corners!)
export function getSpawns(w = MAP_W, h = MAP_H): { x: number; y: number }[] {
  const mx = Math.floor(w / 2) - 1;
  const my = Math.floor(h / 2) - 1;
  return [
    { x: 5, y: 5 }, // 0 NW
    { x: w - 8, y: h - 8 }, // 1 SE
    { x: w - 8, y: 5 }, // 2 NE
    { x: 5, y: h - 8 }, // 3 SW
    { x: mx, y: 5 }, // 4 N
    { x: mx, y: h - 8 }, // 5 S
    { x: 5, y: my }, // 6 W
    { x: w - 8, y: my }, // 7 E
  ];
}

// Legacy 64x64 spawns array kept for backward compatibility
export const SPAWNS: { x: number; y: number }[] = getSpawns(MAP_W, MAP_H);

// ---------- Deterministic Handcrafted Maps (19 Biomes incl. Huge 96x96 & 128x128 8-Player Theaters) ----------
export const MAP_LIST: {
  id: MapId;
  name: string;
  biome: string;
  w?: number;
  h?: number;
  maxPlayers?: number;
  naval?: boolean;
  desc: string;
}[] = [
  { id: "crossroads", name: "Twin Crossroads", biome: "Steppe", w: 96, h: 96, maxPlayers: 8, desc: "Balanced flank mesas, twin Oil Derricks & Coal Mines" },
  { id: "canyon", name: "Iron Canyon", biome: "Canyon", w: 96, h: 96, maxPlayers: 8, desc: "Twin sandstone canyon walls channeling fights across 3 lanes" },
  { id: "basin", name: "Shattered Basin", biome: "Alpine", w: 96, h: 96, maxPlayers: 8, desc: "Open volcanic ore basin ringed by captureable Oil Derricks & Coal" },
  { id: "tundra", name: "Frostbite Pass", biome: "Arctic", w: 96, h: 96, maxPlayers: 8, desc: "Frozen glacial divide with wide north/south bypasses & rich center ice field" },
  { id: "fortress", name: "Citadel Bastion", biome: "Desert", w: 96, h: 96, maxPlayers: 8, desc: "Walled central citadel with 4 gates guarding a mega ore cache" },
  { id: "jungle", name: "Emerald Valley", biome: "Jungle", w: 96, h: 96, maxPlayers: 8, desc: "Diagonal ridge corridors built for ambushes & flanking raids" },
  { id: "islands", name: "Bridgehead Crossing", biome: "Riverland", w: 96, h: 96, maxPlayers: 8, naval: true, desc: "Navigable river channels, lighthouses & bridges — Land, Air & Sea" },
  { id: "oasis", name: "Scorched Oasis", biome: "Sahara", w: 96, h: 96, maxPlayers: 8, desc: "Golden dune ring with fast open flank tank lanes & twin oasis passes" },
  { id: "archipelago", name: "Pacific Atoll", biome: "Ocean", w: 96, h: 96, maxPlayers: 8, naval: true, desc: "4 corner islands & volcanic atoll with sea-stacks & blinking buoys" },
  { id: "coastline", name: "Storm Coast", biome: "Coastal", w: 96, h: 96, maxPlayers: 8, naval: true, desc: "Stormy North Sea straits with coastal lighthouses & dreadnought lanes" },
  { id: "atlantis", name: "Sunken Atlantis", biome: "Mythic Sea", w: 96, h: 96, maxPlayers: 8, naval: true, desc: "Ancient submerged crystal obelisks, glowing sea-gates & golden causeways" },
  { id: "shipwreck", name: "Titan Graveyard", biome: "Abyssal", w: 96, h: 96, maxPlayers: 8, naval: true, desc: "Colossal sunken dreadnought wrecks, reefs & salvage ore shoals" },
  { id: "volcano", name: "Caldera Forge", biome: "Volcanic", w: 96, h: 96, maxPlayers: 8, naval: true, desc: "Steaming coastal sea ringing a glowing molten caldera & obsidian bridges" },
  { id: "oilrig", name: "Offshore Megarig", biome: "Deep Sea", w: 96, h: 96, maxPlayers: 8, naval: true, desc: "Open-ocean platform bridges converging on a giant central oil megastructure" },
  { id: "cybergrid", name: "Neon Megastructure", biome: "Orbital", w: 96, h: 96, maxPlayers: 8, desc: "High-tech titanium battle deck with floating crystal monoliths & energy trenches" },
  { id: "hormuz", name: "Strait of Hormuz", biome: "Gulf Strait", w: 96, h: 96, maxPlayers: 8, naval: true, desc: "Persian Gulf chokepoint — twin tanker channels, mid-strait oil islets & contested shore crossings" },
  { id: "delta", name: "Mekong Delta", biome: "River Delta", w: 96, h: 96, maxPlayers: 8, naval: true, desc: "Braided jungle rivers fanning into a wide bay — ford crossings, mangrove islets & brown-water navy fights" },
  { id: "bering", name: "Bering Strait (96×96 · 8P)", biome: "Polar Strait", w: 96, h: 96, maxPlayers: 8, naval: true, desc: "Two continents split by an icy strait — Diomede stepping-stone isles, ice floes & carrier-lane dominance" },
  // HUGE 8-Player Grand Strategy Theaters (96x96 & 128x128 — built for 4v4 / 8P FFA & Real Logistics!)
  { id: "europa", name: "Iron Frontier (96×96 · 8P)", biome: "Continental", w: 96, h: 96, maxPlayers: 8, desc: "Huge 96×96 European theater — mountain ridges, long supply lines, 4 Oil & 4 Coal" },
  { id: "pacific_theatre", name: "Coral Sea Theatre (96×96 · 8P)", biome: "Grand Ocean", w: 96, h: 96, maxPlayers: 8, naval: true, desc: "Massive 96×96 8-player naval archipelago with central carrier atoll & sea lanes" },
  { id: "arctic_front", name: "Polar Sea Front (96×96 · 8P)", biome: "Polar War", w: 96, h: 96, maxPlayers: 8, naval: true, desc: "Huge 96×96 frozen sea channels, icebreaker passages & contested polar fuel hubs" },
  { id: "megacontinent", name: "Eurasia Supertheater (128×128 · 8P)", biome: "Grand Theater", w: 128, h: 128, maxPlayers: 8, naval: true, desc: "Colossal 128×128 (4× area) 8-player super-map — twin continents, sea strait & real supply logistics!" },
];

export interface MapLayout {
  w: number;
  h: number;
  cliffs: [number, number][]; // impassable elevated rocky/glacial/lava/monolith tiles (aircraft fly over!)
  water: [number, number][]; // navigable ocean/river tiles (ships sail on, aircraft fly over!)
  derricks: [number, number][]; // top-left 2x2 tile of neutral Oil Derricks (+$25/s)
  coalmines?: [number, number][]; // top-left 2x2 tile of neutral Coal Mines (+$20/s & +60⚡)
  extraOre?: [number, number, number][]; // optional [cx, cy, radius] bonus ore blobs
  artifacts?: MapArtifact[]; // 3D visual landmarks & ocean artifacts
}

const mapCache = new Map<MapId, MapLayout>();

// The huge theaters (96x96 & 128x128) are painted natively at their listed size.
// Every other map branch below is authored on the classic 64x64 design grid and
// gets upscaled uniformly to its real dimensions (s = W/64 → 1.5 for 96x96).
const NATIVE_LAYOUT = new Set<MapId>(["bering", "europa", "pacific_theatre", "arctic_front", "megacontinent"]);

export function getMapLayout(id: MapId = "crossroads"): MapLayout {
  const cached = mapCache.get(id);
  if (cached) return cached;
  const meta = MAP_LIST.find((m) => m.id === id);
  const W = meta?.w ?? MAP_W;
  const H = meta?.h ?? MAP_H;
  // Design-grid → real-map scale. s = 1 keeps authored-at-native-size maps untouched.
  const sx = NATIVE_LAYOUT.has(id) ? 1 : W / MAP_W;
  const sy = NATIVE_LAYOUT.has(id) ? 1 : H / MAP_H;
  const cliffSet = new Set<number>();
  const waterSet = new Set<number>();
  // Raw map-space rect ops — used by the post-paint passes (spawn clearing,
  // water connectivity) which already work in real coordinates.
  const addRectRaw = (set: Set<number>, x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x >= 0 && y >= 0 && x < W && y < H) set.add(y * W + x);
      }
    }
  };
  const clearRectRaw = (set: Set<number>, x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x >= 0 && y >= 0 && x < W && y < H) set.delete(y * W + x);
      }
    }
  };
  // Painters feed DESIGN-grid coords; the transform scales origins & sizes so
  // relative gaps/channels/walls preserve topology at any map size.
  const addRect = (set: Set<number>, x0: number, y0: number, w: number, h: number) =>
    addRectRaw(set, Math.round(x0 * sx), Math.round(y0 * sy), Math.max(1, Math.round(w * sx)), Math.max(1, Math.round(h * sy)));
  const clearRect = (set: Set<number>, x0: number, y0: number, w: number, h: number) =>
    clearRectRaw(set, Math.round(x0 * sx), Math.round(y0 * sy), Math.max(1, Math.round(w * sx)), Math.max(1, Math.round(h * sy)));
  let derricks: [number, number][] = [];
  let coalmines: [number, number][] | undefined;
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
    coalmines = [
      [10, 31],
      [52, 31],
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
    coalmines = [
      [23, 12],
      [39, 50],
    ];
  } else if (id === "basin") {
    addRect(cliffSet, 21, 20, 3, 3);
    addRect(cliffSet, 40, 20, 3, 3);
    addRect(cliffSet, 21, 41, 3, 3);
    addRect(cliffSet, 40, 41, 3, 3);
    derricks = [
      [31, 8],
      [31, 54],
    ];
    coalmines = [
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
    coalmines = [
      [31, 8],
      [31, 54],
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
    ];
    coalmines = [
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
    ];
    coalmines = [
      [14, 31],
      [48, 31],
    ];
    extraOre = [
      [20, 32, 3],
      [44, 32, 3],
    ];
  } else if (id === "islands") {
    addRect(waterSet, 26, 0, 12, 12);
    addRect(waterSet, 26, 17, 12, 9);
    addRect(waterSet, 26, 38, 12, 9);
    addRect(waterSet, 26, 52, 12, 12);
    addRect(waterSet, 0, 26, 12, 12);
    addRect(waterSet, 17, 26, 9, 12);
    addRect(waterSet, 38, 26, 9, 12);
    addRect(waterSet, 52, 26, 12, 12);
    clearRect(waterSet, 30, 17, 4, 9);
    clearRect(waterSet, 30, 38, 4, 9);
    clearRect(waterSet, 17, 30, 9, 4);
    clearRect(waterSet, 38, 30, 9, 4);
    addRect(waterSet, 13, 0, 13, 6);
    addRect(waterSet, 38, 0, 13, 6);
    addRect(waterSet, 13, 58, 13, 6);
    addRect(waterSet, 38, 58, 13, 6);
    derricks = [
      [21, 21],
      [41, 41],
    ];
    coalmines = [
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
    addRect(waterSet, 0, 0, MAP_W, MAP_H);
    clearRect(waterSet, 0, 0, 18, 18);
    clearRect(waterSet, 46, 0, 18, 18);
    clearRect(waterSet, 0, 46, 18, 18);
    clearRect(waterSet, 46, 46, 18, 18);
    clearRect(waterSet, 25, 25, 14, 14);
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
    ];
    coalmines = [
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
    coalmines = [
      [10, 31],
      [52, 31],
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
    addRect(waterSet, 0, 0, MAP_W, MAP_H);
    clearRect(waterSet, 0, 0, 19, 19);
    clearRect(waterSet, 45, 0, 19, 19);
    clearRect(waterSet, 0, 45, 19, 19);
    clearRect(waterSet, 45, 45, 19, 19);
    clearRect(waterSet, 24, 24, 16, 16);
    clearRect(waterSet, 19, 29, 6, 6);
    clearRect(waterSet, 39, 29, 6, 6);
    clearRect(waterSet, 29, 19, 6, 6);
    clearRect(waterSet, 29, 39, 6, 6);
    clearRect(waterSet, 14, 19, 5, 12);
    clearRect(waterSet, 45, 33, 5, 12);
    clearRect(waterSet, 45, 19, 5, 12);
    clearRect(waterSet, 14, 33, 5, 12);
    addRect(cliffSet, 25, 25, 2, 2);
    addRect(cliffSet, 37, 25, 2, 2);
    addRect(cliffSet, 25, 37, 2, 2);
    addRect(cliffSet, 37, 37, 2, 2);
    derricks = [
      [28, 28],
      [34, 34],
    ];
    coalmines = [
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
    addRect(waterSet, 0, 0, MAP_W, MAP_H);
    clearRect(waterSet, 0, 0, 18, 18);
    clearRect(waterSet, 46, 0, 18, 18);
    clearRect(waterSet, 0, 46, 18, 18);
    clearRect(waterSet, 46, 46, 18, 18);
    clearRect(waterSet, 25, 25, 14, 14);
    clearRect(waterSet, 15, 29, 34, 6);
    clearRect(waterSet, 29, 15, 6, 34);
    clearRect(waterSet, 14, 17, 4, 14);
    clearRect(waterSet, 46, 17, 4, 14);
    clearRect(waterSet, 14, 33, 4, 14);
    clearRect(waterSet, 46, 33, 4, 14);
    addRect(cliffSet, 22, 20, 3, 2);
    addRect(cliffSet, 39, 42, 3, 2);
    addRect(cliffSet, 39, 20, 3, 2);
    addRect(cliffSet, 22, 42, 3, 2);
    derricks = [
      [18, 31],
      [44, 31],
    ];
    coalmines = [
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
    addRect(waterSet, 0, 0, MAP_W, 5);
    addRect(waterSet, 0, 59, MAP_W, 5);
    addRect(waterSet, 0, 0, 5, MAP_H);
    addRect(waterSet, 59, 0, 5, MAP_H);
    clearRect(waterSet, 0, 0, 14, 14);
    clearRect(waterSet, 50, 0, 14, 14);
    clearRect(waterSet, 0, 50, 14, 14);
    clearRect(waterSet, 50, 50, 14, 14);
    addRect(waterSet, 15, 0, 14, 7);
    addRect(waterSet, 35, 0, 14, 7);
    addRect(waterSet, 15, 57, 14, 7);
    addRect(waterSet, 35, 57, 14, 7);
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
    ];
    coalmines = [
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
    addRect(waterSet, 0, 0, MAP_W, MAP_H);
    clearRect(waterSet, 0, 0, 17, 17);
    clearRect(waterSet, 47, 0, 17, 17);
    clearRect(waterSet, 0, 47, 17, 17);
    clearRect(waterSet, 47, 47, 17, 17);
    clearRect(waterSet, 23, 23, 18, 18);
    clearRect(waterSet, 16, 29, 8, 6);
    clearRect(waterSet, 40, 29, 8, 6);
    clearRect(waterSet, 29, 16, 6, 8);
    clearRect(waterSet, 29, 40, 6, 8);
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
    ];
    coalmines = [
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
  } else if (id === "hormuz") {
    // Strait of Hormuz (design 64x64): two coasts split by a wide shipping strait with twin channels
    addRect(waterSet, 0, 25, MAP_W, 14);
    // Contested land bridges hugging the far west & east edges
    clearRect(waterSet, 0, 25, 9, 14);
    clearRect(waterSet, 55, 25, 9, 14);
    // Mid-strait island chain splitting the strait into twin tanker channels
    clearRect(waterSet, 22, 29, 5, 5);
    clearRect(waterSet, 31, 30, 4, 4);
    clearRect(waterSet, 39, 29, 5, 5);
    // Coastal bluffs guarding the shore approaches
    addRect(cliffSet, 16, 20, 4, 3);
    addRect(cliffSet, 44, 20, 4, 3);
    addRect(cliffSet, 16, 41, 4, 3);
    addRect(cliffSet, 44, 41, 4, 3);
    derricks = [
      [24, 30],
      [41, 30],
      [15, 10],
      [48, 52],
    ];
    coalmines = [
      [10, 20],
      [52, 42],
    ];
    extraOre = [
      [32, 14, 3],
      [32, 50, 3],
    ];
    artifacts = [
      { kind: "oilrig_tower", x: 30, y: 32, scale: 1.35 },
      { kind: "lighthouse", x: 24, y: 30, scale: 1.0 },
      { kind: "lighthouse", x: 40, y: 30, scale: 1.0 },
      { kind: "shipwreck", x: 50, y: 34, rot: -0.5, scale: 1.2 },
      { kind: "buoy", x: 18, y: 27 },
      { kind: "buoy", x: 47, y: 36 },
      { kind: "buoy", x: 28, y: 36 },
      { kind: "buoy", x: 36, y: 27 },
    ];
  } else if (id === "delta") {
    // Mekong Delta (design 64x64): braided jungle rivers fanning into a wide southern bay
    addRect(waterSet, 14, 0, 7, 52); // west river joins the bay
    addRect(waterSet, 45, 0, 7, 52); // east river joins the bay
    addRect(waterSet, 0, 52, MAP_W, 12); // wide open sea bay along the south edge
    // River-mouth fans & a mid-map distributary channel between the rivers
    addRect(waterSet, 10, 47, 15, 5);
    addRect(waterSet, 39, 47, 15, 5);
    addRect(waterSet, 14, 31, 38, 4);
    // Narrow land fords across each river (chokepoint crossings)
    clearRect(waterSet, 14, 11, 7, 3);
    clearRect(waterSet, 14, 38, 7, 3);
    clearRect(waterSet, 45, 18, 7, 3);
    clearRect(waterSet, 45, 40, 7, 3);
    // Islets in the bay
    clearRect(waterSet, 20, 55, 6, 6);
    clearRect(waterSet, 38, 56, 5, 5);
    // Mangrove high ground in the center paddies
    addRect(cliffSet, 30, 20, 4, 3);
    addRect(cliffSet, 36, 44, 3, 3);
    derricks = [
      [31, 40],
      [8, 45],
      [39, 57],
    ];
    coalmines = [
      [6, 20],
      [56, 20],
    ];
    extraOre = [
      [32, 12, 3],
      [32, 24, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 39, y: 57, scale: 0.95 },
      { kind: "seastack", x: 27, y: 58, scale: 1.1 },
      { kind: "shipwreck", x: 50, y: 58, rot: 2.3, scale: 1.0 },
      { kind: "buoy", x: 17, y: 6 },
      { kind: "buoy", x: 48, y: 44 },
      { kind: "buoy", x: 32, y: 33 },
    ];
  } else if (id === "bering") {
    // Bering Strait (96x96): two continents split by an icy north-south strait
    addRect(waterSet, 40, 0, 16, H);
    // Diomede stepping-stone islands mid-strait
    clearRect(waterSet, 44, 43, 5, 5);
    clearRect(waterSet, 49, 49, 5, 6);
    // Ice floes clogging strait edges & approaches (impassable to ships AND walkers)
    addRect(cliffSet, 38, 12, 3, 3);
    addRect(cliffSet, 58, 20, 3, 3);
    addRect(cliffSet, 37, 60, 2, 3);
    addRect(cliffSet, 59, 74, 3, 2);
    addRect(cliffSet, 44, 28, 2, 2);
    addRect(cliffSet, 52, 34, 2, 2);
    addRect(cliffSet, 43, 68, 2, 2);
    addRect(cliffSet, 53, 82, 2, 2);
    // Continental ridge lines
    addRect(cliffSet, 18, 10, 5, 3);
    addRect(cliffSet, 72, 14, 5, 3);
    addRect(cliffSet, 18, 80, 4, 3);
    addRect(cliffSet, 74, 78, 4, 3);
    derricks = [
      [30, 48],
      [64, 48],
      [20, 20],
      [76, 76],
    ];
    coalmines = [
      [12, 46],
      [82, 46],
      [45, 44],
    ];
    extraOre = [
      [24, 64, 4],
      [72, 32, 4],
      [30, 30, 3],
      [66, 66, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 46, y: 44, scale: 1.05 },
      { kind: "seastack", x: 44, y: 18, scale: 1.25 },
      { kind: "seastack", x: 51, y: 72, scale: 1.25 },
      { kind: "shipwreck", x: 47, y: 36, rot: 0.9, scale: 1.3 },
      { kind: "buoy", x: 43, y: 30 },
      { kind: "buoy", x: 52, y: 60 },
    ];
  } else if (id === "europa") {
    // Iron Frontier (96x96, 8-player continental theater): mountain ridges, 4 regional hubs, 4 Oil & 4 Coal
    addRect(cliffSet, 24, 24, 10, 4);
    addRect(cliffSet, 62, 24, 10, 4);
    addRect(cliffSet, 24, 68, 10, 4);
    addRect(cliffSet, 62, 68, 10, 4);
    addRect(cliffSet, 24, 42, 4, 12);
    addRect(cliffSet, 68, 42, 4, 12);
    addRect(cliffSet, 42, 24, 12, 4);
    addRect(cliffSet, 42, 68, 12, 4);
    derricks = [
      [47, 17],
      [47, 77],
      [17, 47],
      [77, 47],
    ];
    coalmines = [
      [29, 31],
      [65, 31],
      [29, 63],
      [65, 63],
    ];
    extraOre = [
      [48, 48, 6],
      [24, 48, 3],
      [72, 48, 3],
      [48, 24, 3],
      [48, 72, 3],
    ];
  } else if (id === "pacific_theatre") {
    // Coral Sea Theatre (96x96, 8-player grand ocean): 8 perimeter islands + central Carrier Atoll + causeways
    addRect(waterSet, 0, 0, W, H);
    // 8 generous 18x18 perimeter spawn islands
    for (const sp of getSpawns(W, H)) {
      clearRect(waterSet, Math.max(0, sp.x - 6), Math.max(0, sp.y - 6), 17, 17);
    }
    // Central Carrier Atoll (20x20) + ring causeways linking all 8 islands & center
    clearRect(waterSet, 38, 38, 20, 20);
    clearRect(waterSet, 12, 46, 72, 4);
    clearRect(waterSet, 46, 12, 4, 72);
    clearRect(waterSet, 12, 14, 72, 4);
    clearRect(waterSet, 12, 78, 72, 4);
    clearRect(waterSet, 14, 12, 4, 72);
    clearRect(waterSet, 78, 12, 4, 72);
    // 4 coal mine resource islets
    clearRect(waterSet, 23, 23, 6, 6);
    clearRect(waterSet, 67, 23, 6, 6);
    clearRect(waterSet, 23, 67, 6, 6);
    clearRect(waterSet, 67, 67, 6, 6);
    addRect(cliffSet, 40, 40, 3, 3);
    addRect(cliffSet, 53, 40, 3, 3);
    addRect(cliffSet, 40, 53, 3, 3);
    addRect(cliffSet, 53, 53, 3, 3);
    derricks = [
      [47, 25],
      [47, 69],
      [25, 47],
      [69, 47],
    ];
    coalmines = [
      [25, 25],
      [69, 25],
      [25, 69],
      [69, 69],
    ];
    extraOre = [
      [48, 48, 5],
      [30, 30, 3],
      [66, 66, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 38, y: 38, scale: 1.1 },
      { kind: "lighthouse", x: 58, y: 58, scale: 1.1 },
      { kind: "shipwreck", x: 31, y: 20, rot: 0.5, scale: 1.4 },
      { kind: "shipwreck", x: 65, y: 76, rot: -2.6, scale: 1.4 },
      { kind: "seastack", x: 24, y: 60, scale: 1.3 },
      { kind: "seastack", x: 72, y: 36, scale: 1.3 },
      { kind: "buoy", x: 32, y: 34 },
      { kind: "buoy", x: 64, y: 62 },
    ];
  } else if (id === "arctic_front") {
    // Polar Sea Front (96x96, 8-player arctic ocean & glacier lanes)
    addRect(waterSet, 36, 0, 24, H);
    addRect(waterSet, 0, 36, W, 24);
    for (const sp of getSpawns(W, H)) {
      clearRect(waterSet, Math.max(0, sp.x - 6), Math.max(0, sp.y - 6), 16, 16);
    }
    // Ice bridges & central polar fortress
    clearRect(waterSet, 38, 38, 20, 20);
    clearRect(waterSet, 12, 46, 72, 4);
    clearRect(waterSet, 46, 12, 4, 72);
    clearRect(waterSet, 20, 34, 6, 28);
    clearRect(waterSet, 70, 34, 6, 28);
    clearRect(waterSet, 34, 20, 28, 6);
    clearRect(waterSet, 34, 70, 28, 6);
    addRect(cliffSet, 28, 28, 5, 4);
    addRect(cliffSet, 63, 28, 5, 4);
    addRect(cliffSet, 28, 64, 5, 4);
    addRect(cliffSet, 63, 64, 5, 4);
    derricks = [
      [47, 22],
      [47, 72],
      [22, 47],
      [72, 47],
    ];
    coalmines = [
      [41, 41],
      [53, 53],
    ];
    extraOre = [
      [48, 48, 5],
      [25, 25, 3],
      [71, 71, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 38, y: 22, scale: 1.05 },
      { kind: "lighthouse", x: 58, y: 74, scale: 1.05 },
      { kind: "shipwreck", x: 48, y: 8, rot: 0.2, scale: 1.3 },
      { kind: "shipwreck", x: 48, y: 88, rot: -2.9, scale: 1.3 },
      { kind: "buoy", x: 37, y: 12 },
      { kind: "buoy", x: 59, y: 84 },
    ];
  } else if (id === "megacontinent") {
    // Eurasia Supertheater (128x128 — 4x area! 8-player twin continents + central navigable sea strait + supply highways!)
    addRect(waterSet, 52, 0, 24, H);
    // Keep north/south mid-spawns (slots 4, 5) on fortified bridgehead peninsulas!
    for (const sp of getSpawns(W, H)) {
      clearRect(waterSet, Math.max(0, sp.x - 7), Math.max(0, sp.y - 7), 18, 18);
    }
    // 4 wide strategic land highways across the grand central sea strait
    clearRect(waterSet, 50, 22, 28, 6);
    clearRect(waterSet, 50, 61, 28, 6);
    clearRect(waterSet, 50, 100, 28, 6);
    // Coastal harbors near west/east spawns for Naval Shipyards
    addRect(waterSet, 16, 0, 16, 12);
    addRect(waterSet, 96, 0, 16, 12);
    addRect(waterSet, 16, 116, 16, 12);
    addRect(waterSet, 96, 116, 16, 12);
    // Continental mountain ranges
    addRect(cliffSet, 28, 32, 6, 16);
    addRect(cliffSet, 94, 32, 6, 16);
    addRect(cliffSet, 28, 80, 6, 16);
    addRect(cliffSet, 94, 80, 6, 16);
    addRect(cliffSet, 36, 61, 8, 6);
    addRect(cliffSet, 84, 61, 8, 6);
    derricks = [
      [63, 24],
      [56, 63],
      [63, 102],
      [22, 63],
      [104, 63],
    ];
    coalmines = [
      [38, 28],
      [88, 28],
      [38, 98],
      [88, 98],
    ];
    extraOre = [
      [64, 64, 5],
      [30, 64, 4],
      [98, 64, 4],
      [34, 34, 3],
      [94, 94, 3],
      [94, 34, 3],
      [34, 94, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 51, y: 22, scale: 1.2 },
      { kind: "lighthouse", x: 77, y: 106, scale: 1.2 },
      { kind: "shipwreck", x: 64, y: 42, rot: 0.4, scale: 1.6 },
      { kind: "shipwreck", x: 64, y: 84, rot: -2.7, scale: 1.6 },
      { kind: "oilrig_tower", x: 64, y: 12, scale: 1.25 },
      { kind: "oilrig_tower", x: 64, y: 116, scale: 1.25 },
      { kind: "buoy", x: 58, y: 36 },
      { kind: "buoy", x: 70, y: 92 },
    ];
  } else {
    addRect(cliffSet, 24, 15, 16, 2);
    addRect(cliffSet, 24, 47, 16, 2);
    addRect(cliffSet, 15, 24, 2, 16);
    addRect(cliffSet, 47, 24, 2, 16);
    derricks = [
      [31, 7],
      [31, 55],
    ];
    coalmines = [
      [9, 31],
      [53, 31],
    ];
    extraOre = [
      [22, 32, 3],
      [42, 32, 3],
    ];
  }

  // Ensure all 8 perimeter spawns on every map sit on solid dry land and bridge cleanly across any adjacent water channel
  // (this pass works in REAL map coordinates — hence the Raw rect ops, not the design-grid scaled ones)
  const cx = Math.floor(W / 2),
    cy = Math.floor(H / 2);
  for (const sp of getSpawns(W, H)) {
    clearRectRaw(cliffSet, sp.x - 1, sp.y - 1, 5, 5);
    clearRectRaw(waterSet, sp.x - 2, sp.y - 2, 7, 7);
    let tx = sp.x + 1,
      ty = sp.y + 1;
    let enteredWater = false;
    let steps = 0;
    while ((tx !== cx || ty !== cy) && steps++ < Math.max(W, H)) {
      const dx = tx < cx ? 1 : tx > cx ? -1 : 0;
      const dy = ty < cy ? 1 : ty > cy ? -1 : 0;
      tx += dx;
      ty += dy;
      const k = ty * W + tx;
      if (waterSet.has(k)) {
        enteredWater = true;
        // Clear perpendicular 3-tile bridge width WITHOUT clearing ahead along (dx, dy)
        if (dx === 0) clearRectRaw(waterSet, tx - 1, ty, 3, 1);
        else if (dy === 0) clearRectRaw(waterSet, tx, ty - 1, 1, 3);
        else {
          clearRectRaw(waterSet, tx - 1, ty, 3, 1);
          clearRectRaw(waterSet, tx, ty - 1, 1, 3);
        }
      } else if (enteredWater && !cliffSet.has(k)) {
        break; // reached mainland on far side of channel
      }
    }
  }

  // Cliffs trump water everywhere — resolve overlap BEFORE connectivity so the pass
  // doesn't route "through" tiles that are about to become non-water.
  for (const k of cliffSet) waterSet.delete(k);

  // Water connectivity pass: bridges, fords, islands & artifacts often pinch seas into
  // disconnected bodies — trapped ships make naval play useless. Flood-fill components,
  // keep the largest as "the sea", then Dijkstra-carve a narrow canal from every stray
  // body back to the sea (spawn zones are high-cost so canals skirt bases).
  if (waterSet.size > 0) {
    const spawns = getSpawns(W, H);
    const nearSpawn = new Uint8Array(W * H);
    for (const sp of spawns) {
      for (let y = sp.y - 4; y <= sp.y + 4; y++)
        for (let x = sp.x - 4; x <= sp.x + 4; x++)
          if (x >= 0 && y >= 0 && x < W && y < H) nearSpawn[y * W + x] = 1;
    }
    const comp = new Int32Array(W * H).fill(-1);
    const comps: number[][] = [];
    for (const s of waterSet) {
      if (comp[s] >= 0) continue;
      const id0 = comps.length;
      const members: number[] = [];
      const q = [s];
      comp[s] = id0;
      while (q.length) {
        const c = q.pop()!;
        members.push(c);
        const x = c % W, y = (c / W) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy, ni = ny * W + nx;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && comp[ni] < 0 && waterSet.has(ni)) {
            comp[ni] = id0;
            q.push(ni);
          }
        }
      }
      comps.push(members);
    }
    let SEA = 0;
    for (let i = 1; i < comps.length; i++) if (comps[i].length > comps[SEA].length) SEA = i;
    for (let guard = 0; guard < comps.length + 2; guard++) {
      // Dijkstra over land from all sea tiles; stop at the first foreign component
      const dist = new Int32Array(W * H).fill(-1);
      const prev = new Int32Array(W * H).fill(-1);
      const heap: number[] = []; // packed cost*AREA+tile — plain-number binary heap
      const AREA = W * H;
      const push = (cost: number, t: number) => {
        heap.push(cost * AREA + t);
        let i = heap.length - 1;
        while (i > 0) { const p = (i - 1) >> 1; if (heap[p] <= heap[i]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
      };
      const pop = () => {
        const top = heap[0], last = heap.pop()!;
        if (heap.length) {
          heap[0] = last;
          let i = 0;
          for (;;) { let m = i; const l = 2 * i + 1, r = l + 1;
            if (l < heap.length && heap[l] < heap[m]) m = l;
            if (r < heap.length && heap[r] < heap[m]) m = r;
            if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; }
        }
        return top;
      };
      for (const t of comps[SEA]) { dist[t] = 0; push(0, t); }
      let hit = -1;
      while (heap.length) {
        const cur = pop();
        const cost = Math.floor(cur / AREA), t = cur % AREA;
        if (dist[t] >= 0 && cost > dist[t]) continue;
        if (comp[t] >= 0 && comp[t] !== SEA) { hit = t; break; }
        const x = t % W, y = (t / W) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy, ni = ny * W + nx;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (comp[ni] === SEA) continue;
          const step = comp[ni] >= 0 ? 0 : nearSpawn[ni] ? 8 : 1;
          const nd = cost + step;
          if (dist[ni] < 0 || nd < dist[ni]) { dist[ni] = nd; prev[ni] = t; push(nd, ni); }
        }
      }
      if (hit < 0) break; // nothing left to connect
      // carve a 2-wide canal along the backtracked land path. NB: carved tiles must
      // NOT be relabeled SEA mid-walk — the widening offsets would then make a later
      // path tile look like "sea reached" and the loop would exit one tile short.
      const carved: number[] = [];
      for (let t = hit; t >= 0 && comp[t] !== SEA; t = prev[t]) {
        const x = t % W, y = (t / W) | 0;
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1]]) {
          const nx = Math.min(W - 1, x + ox), ny = Math.min(H - 1, y + oy), ni = ny * W + nx;
          if (comp[ni] < 0) { waterSet.add(ni); carved.push(ni); cliffSet.delete(ni); }
        }
        cliffSet.delete(t);
      }
      for (const t of carved) { comp[t] = SEA; comps[SEA].push(t); }
      const hc = comp[hit];
      for (const t of comps[hc]) { comp[t] = SEA; comps[SEA].push(t); }
      comps[hc] = [];
    }
  }

  // Upscale feature coords for 64-grid-authored maps (identity when s = 1).
  // Sites keep a 2x2 footprint — only positions & ore-blob radii scale.
  if (sx !== 1 || sy !== 1) {
    const px = (v: number) => Math.round(v * sx);
    const py = (v: number) => Math.round(v * sy);
    const pr = (v: number) => Math.max(1, Math.round(v * Math.min(sx, sy)));
    derricks = derricks.map(([x, y]): [number, number] => [px(x), py(y)]);
    if (coalmines) coalmines = coalmines.map(([x, y]): [number, number] => [px(x), py(y)]);
    if (extraOre) extraOre = extraOre.map(([x, y, r]): [number, number, number] => [px(x), py(y), pr(r)]);
    if (artifacts) artifacts = artifacts.map((a) => ({ ...a, x: a.x * sx, y: a.y * sy }));
  }

  const cliffs: [number, number][] = [];
  for (const k of cliffSet) cliffs.push([k % W, (k / W) | 0]);
  const water: [number, number][] = [];
  for (const k of waterSet) water.push([k % W, (k / W) | 0]);
  const layout: MapLayout = { w: W, h: H, cliffs, water, derricks, coalmines, extraOre, artifacts };
  mapCache.set(id, layout);
  return layout;
}
