// Shared game constants & definitions (must stay lib-agnostic: no DOM, no workerd types)

import type { OrderKind, WeaponFx } from "./protocol";

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

// Runtime-valid order commands. "bridge" is an internal OrderKind with its own command message.
export const ORDER_KINDS: readonly Exclude<OrderKind, "bridge">[] = ["move", "amove", "attack", "harvest", "patrol"];

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
  | "arctic_front"
  // Colossal real-world theaters (192-256 class)
  | "english_channel"
  | "persian_gulf"
  | "panama"
  | "fulda_gap";

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
  conyard: { w: 3, h: 3, cost: 0, hp: 1000, power: 40, buildTicks: 0, noBuild: true },
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
  turret: { w: 1, h: 1, cost: 400, hp: 490, power: -20, buildTicks: 45, category: "defense", range: 6.9, dmg: 17, rof: 13, canHitAir: true },
  sam: { w: 2, h: 2, cost: 420, hp: 590, power: -30, buildTicks: 45, category: "defense", range: 12, dmg: 42, rof: 17, canHitAir: true, canHitGround: false, requires: ["radar"] },
  arc: { w: 1, h: 1, cost: 700, hp: 620, power: -40, buildTicks: 60, category: "defense", range: 7.9, dmg: 37, rof: 22, canHitAir: true, requires: ["radar"] },
  irondome: { w: 2, h: 2, cost: 850, hp: 820, power: -45, buildTicks: 60, category: "defense", range: 11, dmg: 30, rof: 13, canHitAir: true, canHitGround: false, requires: ["radar", "techlab"], limit: 3 },
  lasertower: { w: 2, h: 2, cost: 1350, hp: 940, power: -65, buildTicks: 80, category: "defense", range: 10, dmg: 79, rof: 26, canHitAir: true, requires: ["techlab"] },
  thaad: { w: 2, h: 2, cost: 1150, hp: 890, power: -55, buildTicks: 75, category: "defense", range: 14.5, dmg: 63, rof: 22, canHitAir: true, canHitGround: false, requires: ["satlink"], limit: 2 },

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

// Production MKII buildings satisfy their base building's prerequisites/queues.
export const UPGRADED_OF: Partial<Record<BuildingKind, BuildingKind>> = {
  barracks: "barracks2",
  factory: "factory2",
  airfield: "airfield2",
  shipyard: "shipyard2",
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
  interceptor: { hp: 230, speed: 0.38, range: 8, dmg: 30, rof: 14, cost: 750, buildTicks: 55, trainsAt: "airfield", domain: "air", canHitAir: true },
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

// ---------- combat classification & weapon data ----------
export type ArmorTargetClass = "air" | "infantry" | "heavyArmor" | "vehicle" | "building" | "seaShip" | "lightUnit";

const INFANTRY_KINDS = new Set<UnitKind>(["infantry", "rocket", "engineer", "spy"]);
const HEAVY_ARMOR_KINDS = new Set<UnitKind>(["tank", "heavy", "harvester", "railtank"]);
const LIGHT_UNIT_KINDS = new Set<UnitKind>(["spider", "uav", "gunboat"]);
// Separation keeps the pre-refactor footprint list exactly; the broader armor
// "vehicle" class below is derived from land domain and intentionally includes spider/ballistic.
const SEPARATION_VEHICLE_KINDS = new Set<UnitKind>(["tank", "heavy", "arty", "harvester", "supplytruck", "himars", "railtank"]);

export const isInfantryKind = (k: EntKind): boolean => INFANTRY_KINDS.has(k as UnitKind);
export const isHeavyArmorKind = (k: EntKind): boolean => HEAVY_ARMOR_KINDS.has(k as UnitKind);
export const isVehicleKind = (k: EntKind): boolean =>
  !(k in BUILDINGS) && UNITS[k as UnitKind].domain === "land" && !isInfantryKind(k);
export const isSeaShipKind = (k: EntKind): boolean => !(k in BUILDINGS) && UNITS[k as UnitKind].domain === "sea";
export const isLightUnitKind = (k: EntKind): boolean => isInfantryKind(k) || LIGHT_UNIT_KINDS.has(k as UnitKind);
export const usesVehicleSeparation = (k: EntKind): boolean => SEPARATION_VEHICLE_KINDS.has(k as UnitKind);

export function matchesArmorClass(cls: ArmorTargetClass, k: EntKind): boolean {
  switch (cls) {
    case "air":
      return !(k in BUILDINGS) && UNITS[k as UnitKind].domain === "air";
    case "infantry":
      return isInfantryKind(k);
    case "heavyArmor":
      return isHeavyArmorKind(k);
    case "vehicle":
      return isVehicleKind(k);
    case "building":
      return k in BUILDINGS;
    case "seaShip":
      return isSeaShipKind(k);
    case "lightUnit":
      return isLightUnitKind(k);
  }
}

export interface ArmorMultRule {
  mult: number;
  kinds?: readonly EntKind[];
  classes?: readonly ArmorTargetClass[];
}

const ANTI_ARMOR_TARGETS: readonly EntKind[] = ["tank", "himars", "railtank", "harvester", "supplytruck", "heavy", "arty"];

// First matching rule per attacker wins; omission means 1x damage.
export const ARMOR_MULTS: Partial<Record<EntKind, readonly ArmorMultRule[]>> = {
  infantry: [
    { classes: ["air"], mult: 0.6 },
    { classes: ["infantry"], mult: 1.35 },
    { classes: ["heavyArmor"], mult: 0.7 },
  ],
  rocket: [
    { classes: ["air"], mult: 1.35 },
    { classes: ["vehicle"], mult: 1.4 },
    { classes: ["infantry"], mult: 0.75 },
  ],
  arty: [{ classes: ["building"], mult: 1.35 }],
  railtank: [{ classes: ["vehicle", "building"], mult: 1.35 }],
  lasertower: [{ classes: ["vehicle", "seaShip"], mult: 1.4 }],
  sam: [{ classes: ["air"], mult: 1.5 }],
  thaad: [{ kinds: ["stealthbomber", "ac130", "hypersonic", "a10", "interceptor"], mult: 1.5 }],
  uav: [{ classes: ["lightUnit"], mult: 1.25 }],
  sub: [{ classes: ["seaShip"], mult: 1.45 }],
  interceptor: [{ classes: ["air"], mult: 1.5 }],
  bomber: [{ classes: ["building"], mult: 1.3 }],
  stealthbomber: [{ classes: ["building"], mult: 1.3 }],
  himars: [{ classes: ["building"], mult: 1.3 }],
  zeppelin: [{ classes: ["building"], mult: 1.3 }],
  dreadnought: [{ classes: ["building"], mult: 1.3 }],
  hypersonic: [{ classes: ["building", "seaShip"], mult: 1.5 }],
  ballistic: [{ classes: ["building", "seaShip"], mult: 1.4 }],
  a10: [{ kinds: ANTI_ARMOR_TARGETS, mult: 1.5 }, { classes: ["air"], mult: 0.5 }],
  ac130: [{ classes: ["infantry", "vehicle", "building"], mult: 1.3 }],
  gunboat: [{ classes: ["air"], mult: 1.35 }],
  destroyer: [{ classes: ["air"], mult: 1.35 }],
  fpvdrone: [{ kinds: ANTI_ARMOR_TARGETS, mult: 1.45 }],
  shahed: [{ classes: ["building"], mult: 1.4 }],
  usv: [{ kinds: ["destroyer", "dreadnought", "carrier", "gunboat", "sub", "shipyard", "shipyard2"], mult: 1.5 }],
};

export const WEAPON_FX_OF: Partial<Record<EntKind, WeaponFx>> = {
  lasertower: "laser",
  satlink: "laser",
  railtank: "railgun",
  a10: "brrrt",
  tank: "cannon",
  heavy: "cannon",
  destroyer: "cannon",
  rocket: "rocket",
  interceptor: "rocket",
  sam: "rocket",
  irondome: "rocket",
  uav: "rocket",
  arty: "arty",
  ac130: "arty",
  arc: "arc",
  spider: "melee",
  dreadnought: "missile",
  himars: "missile",
  hypersonic: "missile",
  carrier: "missile",
  thaad: "missile",
  ballistic: "missile",
  sub: "torpedo",
  bomber: "bomb",
  stealthbomber: "bomb",
  zeppelin: "bomb",
};

export const AMMO_COST_OF: Partial<Record<EntKind, number>> = {
  a10: 2,
  ac130: 6,
  himars: 12,
  arty: 12,
  dreadnought: 12,
  bomber: 12,
  stealthbomber: 12,
  zeppelin: 12,
  ballistic: 12,
  tank: 7,
  heavy: 7,
  railtank: 7,
  destroyer: 7,
  sub: 7,
  carrier: 7,
  chopper: 7,
  interceptor: 7,
};

export const KAMIKAZE_FUEL_BURN = 0.18;
export const FUEL_BURN_OF: Partial<Record<EntKind, number>> = { hypersonic: 0.04 };
export const DOMAIN_FUEL_BURN: Record<UnitDomain, number> = { air: 0.55, sea: 0.25, land: 0.35 };

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
  { id: "english_channel", name: "English Channel (256×192 · 8P)", biome: "Grand Theater", w: 256, h: 192, maxPlayers: 8, naval: true, desc: "Colossal cross-channel invasion theater — Britain vs France across a true blue-water channel. Dover chokepoint causeways & open North Sea lanes!" },
  { id: "persian_gulf", name: "Persian Gulf (224×224 · 8P)", biome: "Grand Theater", w: 224, h: 224, maxPlayers: 8, naval: true, desc: "Colossal gulf theater — Iran vs Arabia across wide open water, tanker lanes & the Hormuz chokepoint. True blue-water naval warfare!" },
  { id: "panama", name: "Panama Isthmus (224×192 · 8P)", biome: "Grand Theater", w: 224, h: 192, maxPlayers: 8, naval: true, desc: "Colossal two-ocean theater — the canal cut links Atlantic & Pacific through the contested isthmus crossing!" },
  { id: "fulda_gap", name: "Fulda Gap (192×192 · 8P)", biome: "Grand Theater", w: 192, h: 192, maxPlayers: 8, naval: false, desc: "Colossal armored land war — ridge corridors, pass chokepoints & rolling open ground. The Cold War tank battlefield at grand scale!" },
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

// Dev/test hook: skip the sea-connectivity canal pass (canal carving is adversarial
// with authored causeways — this lets map tooling inspect raw authored topology).
export const MAP_DEBUG = { noCanalPass: false };

// The huge theaters (96x96 & 128x128) plus every oceanic rework are painted natively
// at their listed size. The remaining classic land maps are authored on the 64x64
// design grid and get upscaled uniformly to their real dimensions (s = W/64 → 1.5 for 96x96).
const NATIVE_LAYOUT = new Set<MapId>([
  "bering",
  "europa",
  "pacific_theatre",
  "arctic_front",
  "megacontinent",
  "islands",
  "archipelago",
  "coastline",
  "atlantis",
  "shipwreck",
  "volcano",
  "oilrig",
  "hormuz",
  "delta",
  "english_channel",
  "persian_gulf",
  "panama",
  "fulda_gap",
]);

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

  // ---------- procedural coastline helpers (REAL map coords, deterministic across server & client) ----------
  // Seeded PRNG (mulberry32) — layout generation must be bit-identical in every
  // process because the client renders terrain straight from getMapLayout().
  const seededRng = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  // Even-odd scanline polygon fill. `pts` is a closed ring in real coords.
  const paintPoly = (set: Set<number>, pts: readonly (readonly [number, number])[], fill: boolean) => {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const x0 = Math.max(0, Math.floor(minX)),
      x1 = Math.min(W - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY)),
      y1 = Math.min(H - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      // gather edge crossings for this row's tile-center scanline
      const py = y + 0.5;
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [ax, ay] = pts[j],
          [bx, by] = pts[i];
        if (ay <= py === by <= py) continue;
        xs.push(ax + ((py - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(x0, Math.floor(xs[k])),
          xb = Math.min(x1, Math.ceil(xs[k + 1]) - 1);
        for (let x = xa; x <= xb; x++) {
          if (x + 0.5 < xs[k] || x + 0.5 > xs[k + 1]) continue;
          if (fill) set.add(y * W + x);
          else set.delete(y * W + x);
        }
      }
    }
  };
  // Chaikin corner-cutting — smooths a coarse ring/open polyline into organic coastline.
  const chaikin = (pts: readonly (readonly [number, number])[], closed: boolean, iterations = 2): [number, number][] => {
    let cur: [number, number][] = pts.map(([x, y]) => [x, y]);
    for (let it = 0; it < iterations; it++) {
      const next: [number, number][] = [];
      const n = cur.length;
      const seg = closed ? n : n - 1;
      if (!closed) next.push(cur[0]);
      for (let i = 0; i < seg; i++) {
        const [ax, ay] = cur[i],
          [bx, by] = cur[(i + 1) % n];
        next.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
        next.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
      }
      if (!closed) next.push(cur[n - 1]);
      cur = next;
    }
    return cur;
  };
  // Organic island/continent outline: ellipse ring modulated by seeded low-frequency
  // harmonics (harmonics 2-5, so the mass stays centered), then Chaikin-smoothed.
  const noiseRing = (cx0: number, cy0: number, rx: number, ry: number, seed: number, rough = 0.22, n = 26): [number, number][] => {
    const rnd = seededRng(seed);
    const harmonics: { h: number; a: number; p: number }[] = [];
    for (const h of [2, 3, 4, 5]) harmonics.push({ h, a: (rnd() - 0.35) * (rough / (h - 1)), p: rnd() * Math.PI * 2 });
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      let m = 1;
      for (const { h, a, p } of harmonics) m += a * Math.sin(t * h + p);
      pts.push([cx0 + Math.cos(t) * rx * m, cy0 + Math.sin(t) * ry * m]);
    }
    return chaikin(pts, true, 1);
  };
  // Stamp a wide soft-edged stroke along a polyline (causeways, rivers, canals).
  const paintLine = (set: Set<number>, pts: readonly (readonly [number, number])[], width: number, fill: boolean) => {
    const r = width / 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i],
        [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(len * 2));
      for (let s = 0; s <= steps; s++) {
        const cx0 = ax + ((bx - ax) * s) / steps,
          cy0 = ay + ((by - ay) * s) / steps;
        const ri = Math.ceil(r);
        for (let dy = -ri; dy <= ri; dy++)
          for (let dx = -ri; dx <= ri; dx++) {
            if (Math.hypot(dx, dy) > r) continue;
            const x = Math.round(cx0 + dx),
              y = Math.round(cy0 + dy);
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            if (fill) set.add(y * W + x);
            else set.delete(y * W + x);
          }
      }
    }
  };
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
    // Bridgehead Crossing (native 96x96): four riverland continents in open water,
    // parted by wide navigable channels that wrap every coastline. Narrow stone
    // causeways link the quadrants; offshore islets beg for engineer pontoon bridges.
    addRectRaw(waterSet, 0, 0, W, H);
    const quads: [number, number, number, number, number][] = [
      [22, 22, 19, 17, 701], // NW continent (spawns 0 + parts of 4/6)
      [74, 74, 19, 17, 702], // SE continent (spawn 1)
      [74, 22, 18, 16, 703], // NE continent (spawn 2)
      [22, 74, 18, 16, 704], // SW continent (spawn 3)
    ];
    for (const [qx, qy, rx, ry, seed] of quads) paintPoly(waterSet, noiseRing(qx, qy, rx, ry, seed, 0.16), false);
    // mid-edge shelf islands for the N/S/E/W perimeter spawns
    paintPoly(waterSet, noiseRing(48, 11, 11, 8, 705, 0.15), false);
    paintPoly(waterSet, noiseRing(48, 85, 11, 8, 706, 0.15), false);
    paintPoly(waterSet, noiseRing(11, 48, 8, 11, 707, 0.15), false);
    paintPoly(waterSet, noiseRing(85, 48, 8, 11, 708, 0.15), false);
    // stone causeways linking shelves to their neighboring continents (tree, no loops)
    paintLine(waterSet, chaikin([[41, 12], [44, 14], [46, 16]], false, 1), 3.4, false); // NW-N shelf
    paintLine(waterSet, chaikin([[57, 14], [60, 15], [63, 17]], false, 1), 3.4, false); // N shelf-NE
    paintLine(waterSet, chaikin([[14, 41], [16, 44], [17, 47]], false, 1), 3.4, false); // NW-W shelf
    paintLine(waterSet, chaikin([[15, 57], [16, 60], [18, 63]], false, 1), 3.4, false); // W shelf-SW
    paintLine(waterSet, chaikin([[82, 41], [81, 44], [80, 47]], false, 1), 3.4, false); // NE-E shelf
    paintLine(waterSet, chaikin([[81, 57], [80, 60], [78, 63]], false, 1), 3.4, false); // E shelf-SE
    paintLine(waterSet, chaikin([[41, 84], [44, 82], [46, 79]], false, 1), 3.4, false); // SW-S shelf
    paintLine(waterSet, chaikin([[57, 82], [60, 81], [63, 79]], false, 1), 3.4, false); // S shelf-SE
    // grand central crossings — the two bridgehead isthmuses the map is named for
    paintLine(waterSet, chaikin([[38, 42], [44, 46], [52, 50], [58, 54]], false, 2), 4, false); // NW-SE diagonal
    paintLine(waterSet, chaikin([[58, 42], [52, 46], [44, 50], [38, 54]], false, 2), 4, false); // NE-SW diagonal
    addRectRaw(waterSet, 20, 44, 10, 8);
    addRectRaw(waterSet, 66, 44, 10, 8);
    addRectRaw(waterSet, 42, 0, 12, 8);
    addRectRaw(waterSet, 42, 88, 12, 8);
    addRectRaw(waterSet, 0, 42, 8, 12);
    addRectRaw(waterSet, 88, 42, 8, 12);
    // widen the sea lanes: deep channel cuts through the cross strait
    paintLine(waterSet, chaikin([[48, 20], [48, 40], [48, 60], [48, 78]], false, 2), 7, true);
    paintLine(waterSet, chaikin([[16, 48], [36, 47], [60, 49], [82, 48]], false, 2), 6.5, true);
    // small offshore bridgeable islets (contested ore & forward posts)
    paintPoly(waterSet, noiseRing(48, 48, 5, 4.5, 709, 0.14), false);
    paintPoly(waterSet, noiseRing(25, 48, 3.5, 3, 710, 0.14), false);
    paintPoly(waterSet, noiseRing(71, 48, 3.5, 3, 711, 0.14), false);
    derricks = [
      [48, 30],
      [48, 64],
      [24, 24],
      [70, 70],
    ];
    coalmines = [
      [30, 48],
      [64, 48],
    ];
    extraOre = [
      [48, 48, 3],
      [24, 72, 3],
      [72, 24, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 47, y: 12, scale: 1.0 },
      { kind: "lighthouse", x: 47, y: 84, scale: 1.0 },
      { kind: "buoy", x: 48, y: 40 },
      { kind: "buoy", x: 48, y: 58 },
      { kind: "buoy", x: 30, y: 48 },
      { kind: "buoy", x: 66, y: 48 },
      { kind: "seastack", x: 64, y: 14, scale: 1.1 },
      { kind: "seastack", x: 32, y: 82, scale: 1.1 },
    ];
  } else if (id === "archipelago") {
    // Pacific Atoll (native 96x96): a genuine ocean — 8 volcanic spawn islands rising
    // from open water, linked by a ring of narrow coral causeways around a central
    // lagoon atoll. Wide blue-water lanes dominate the middle of the map.
    addRectRaw(waterSet, 0, 0, W, H);
    // 8 organic spawn islands — INTERIOR (narrow navigable channels run along every
    // map edge, so the sea is one continuous body wrapping the whole theater)
    const isleCenters: [number, number, number][] = [
      [10.5, 10.5, 8.5], // NW corner spawn 0
      [85.5, 85.5, 8.5], // SE corner spawn 1
      [85.5, 10.5, 8.5], // NE corner spawn 2
      [10.5, 85.5, 8.5], // SW corner spawn 3
      [48, 10.5, 9], // N mid spawn 4
      [48, 85.5, 9], // S mid spawn 5
      [10.5, 48, 9], // W mid spawn 6
      [85.5, 48, 9], // E mid spawn 7
    ];
    isleCenters.forEach(([ix, iy, r], i) => {
      paintPoly(waterSet, noiseRing(ix, iy, r + 1, r, 101 + i * 37, 0.16), false);
    });
    // Central volcanic atoll — ring island with a lagoon open to the sea on the NW
    paintPoly(waterSet, noiseRing(48, 48, 13, 12, 501, 0.16), false);
    paintPoly(waterSet, noiseRing(48, 48, 6.5, 6, 502, 0.1), true);
    paintLine(waterSet, chaikin([[33, 35], [39, 40], [44, 44], [49, 47]], false, 2), 7, true); // lagoon mouth reaches open sea
    // contested resource islets out in the blue water
    paintPoly(waterSet, noiseRing(25, 25, 5.5, 5, 601, 0.18), false);
    paintPoly(waterSet, noiseRing(71, 71, 5.5, 5, 602, 0.18), false);
    paintPoly(waterSet, noiseRing(25, 71, 4.5, 4, 603, 0.18), false);
    paintPoly(waterSet, noiseRing(71, 25, 4.5, 4, 604, 0.18), false);
    // Coral causeway chain hopping the perimeter islands NW-N-NE-E-SE-S-SW-W — an
    // UNCLOSED chain floating in the interior: a tree never encloses the sea, so land
    // armies and battle fleets both stay fully connected. One spoke ties the central
    // atoll into the chain as the contested king-of-the-hill.
    const chain: [number, number][][] = [
      [[18, 10], [30, 9], [40, 10]], // NW -> N
      [[56, 10], [70, 9], [78, 10]], // N -> NE
      [[86, 18], [87, 30], [86, 40]], // NE -> E
      [[86, 56], [87, 70], [86, 78]], // E -> SE
      [[78, 86], [66, 87], [56, 86]], // SE -> S
      [[40, 86], [28, 87], [18, 86]], // S -> SW
      [[10, 78], [9, 66], [10, 56]], // SW -> W
      [[48, 19], [48, 28], [48, 38]], // N -> atoll hub (single spoke)
    ];
    for (const leg of chain) paintLine(waterSet, chaikin(leg, false, 2), 3.2, false);
    // Volcanic cliff peaks on the atoll rim
    addRectRaw(cliffSet, 41, 40, 2, 2);
    addRectRaw(cliffSet, 54, 40, 2, 2);
    addRectRaw(cliffSet, 41, 54, 2, 2);
    addRectRaw(cliffSet, 54, 54, 2, 2);
    derricks = [
      [47, 41],
      [47, 53],
      [24, 24],
      [70, 70],
    ];
    coalmines = [
      [41, 47],
      [54, 47],
    ];
    extraOre = [
      [48, 48, 4],
      [24, 72, 3],
      [72, 24, 3],
    ];
    artifacts = [
      { kind: "seastack", x: 30, y: 30, scale: 1.2 },
      { kind: "seastack", x: 66, y: 66, scale: 1.2 },
      { kind: "shipwreck", x: 66, y: 22, rot: 0.7, scale: 1.0 },
      { kind: "shipwreck", x: 30, y: 74, rot: -2.2, scale: 1.0 },
      { kind: "lighthouse", x: 15, y: 15, scale: 0.95 },
      { kind: "lighthouse", x: 81, y: 81, scale: 0.95 },
      { kind: "buoy", x: 48, y: 30 },
      { kind: "buoy", x: 48, y: 66 },
      { kind: "buoy", x: 30, y: 48 },
      { kind: "buoy", x: 66, y: 48 },
    ];
  } else if (id === "coastline") {
    // Storm Coast (native 96x96): twin continents on the west & east seaboards with a
    // wide open strait between — the sea wraps the northern cape while a narrow
    // causeway crosses at the southern chokepoint. Classic contested-shore naval war.
    addRectRaw(waterSet, 0, 0, W, H);
    paintPoly(waterSet, noiseRing(20, 48, 15, 43, 801, 0.12), false); // west continent (spawns 0,3,6)
    paintPoly(waterSet, noiseRing(76, 48, 15, 43, 802, 0.12), false); // east continent (spawns 1,2,7)
    paintPoly(waterSet, noiseRing(48, 12, 13, 9, 803, 0.15), false); // north cape isle (spawn 4)
    paintPoly(waterSet, noiseRing(48, 84, 13, 9, 804, 0.15), false); // south cape isle (spawn 5)
    addRectRaw(waterSet, 34, 20, 28, 8);
    addRectRaw(waterSet, 34, 68, 28, 8);
    addRectRaw(waterSet, 38, 42, 20, 12);
    // causeways: capes into the continents + the southern chokepoint crossing
    paintLine(waterSet, chaikin([[38, 16], [33, 22], [29, 28]], false, 1), 3.4, false);
    paintLine(waterSet, chaikin([[58, 16], [63, 22], [67, 28]], false, 1), 3.4, false);
    paintLine(waterSet, chaikin([[38, 80], [33, 74], [29, 68]], false, 1), 3.4, false);
    paintLine(waterSet, chaikin([[58, 80], [63, 74], [67, 68]], false, 1), 3.4, false);
    paintLine(waterSet, chaikin([[33, 86], [41, 85], [55, 85], [63, 86]], false, 2), 3.6, false); // south strait crossing
    // cliffs on both headlands
    addRectRaw(cliffSet, 22, 40, 3, 5);
    addRectRaw(cliffSet, 71, 52, 3, 5);
    derricks = [
      [47, 12],
      [47, 82],
    ];
    coalmines = [
      [18, 22],
      [76, 72],
    ];
    extraOre = [
      [22, 56, 3],
      [74, 40, 3],
      [48, 48, 2],
    ];
    artifacts = [
      { kind: "lighthouse", x: 35, y: 14, scale: 1.05 },
      { kind: "lighthouse", x: 61, y: 82, scale: 1.05 },
      { kind: "shipwreck", x: 48, y: 30, rot: 0.35, scale: 1.1 },
      { kind: "shipwreck", x: 48, y: 64, rot: -2.6, scale: 1.1 },
      { kind: "buoy", x: 44, y: 22 },
      { kind: "buoy", x: 52, y: 74 },
    ];

  } else if (id === "atlantis") {
    // Sunken Atlantis (native 96x96): a drowned kingdom — golden causeway lattice over
    // deep mythic waters, crystal obelisks on interior isles, one connected shining sea.
    addRectRaw(waterSet, 0, 0, W, H);
    const ailes: [number, number, number][] = [
      [11, 11, 9.5], [85, 85, 9.5], [85, 11, 9.5], [11, 85, 9.5],
      [48, 11, 10], [48, 85, 10], [11, 48, 10], [85, 48, 10],
    ];
    ailes.forEach(([ix, iy, r], i) => paintPoly(waterSet, noiseRing(ix, iy, r, r - 1, 811 + i * 13, 0.14), false));
    // central sunken citadel
    paintPoly(waterSet, noiseRing(48, 48, 11, 10, 819, 0.12), false);
    // golden causeways: grand diagonal avenues + cardinal boulevards (tree+spokes, sea flows free)
    const aves: [number, number][][] = [
      [[16, 16], [28, 28], [40, 40]],
      [[80, 80], [68, 68], [56, 56]],
      [[80, 16], [68, 28], [56, 40]],
      [[16, 80], [28, 68], [40, 56]],
      [[48, 17], [48, 28], [48, 37]],
      [[48, 79], [48, 68], [48, 59]],
      [[17, 48], [28, 48], [36, 48]],
      [[79, 48], [68, 48], [60, 48]],
    ];
    for (const a of aves) paintLine(waterSet, chaikin(a, false, 2), 3.4, false);
    addRectRaw(cliffSet, 44, 44, 2, 2);
    addRectRaw(cliffSet, 51, 44, 2, 2);
    addRectRaw(cliffSet, 44, 51, 2, 2);
    addRectRaw(cliffSet, 51, 51, 2, 2);
    derricks = [
      [46, 46],
      [24, 24],
      [70, 70],
    ];
    coalmines = [
      [24, 70],
      [70, 24],
    ];
    extraOre = [
      [48, 48, 3],
      [48, 24, 2],
      [48, 72, 2],
    ];
    artifacts = [
      { kind: "seagate", x: 48, y: 24, rot: 0, scale: 1.35 },
      { kind: "seagate", x: 48, y: 72, rot: 0, scale: 1.35 },
      { kind: "seagate", x: 24, y: 48, rot: Math.PI / 2, scale: 1.25 },
      { kind: "seagate", x: 72, y: 48, rot: Math.PI / 2, scale: 1.25 },
      { kind: "obelisk", x: 44, y: 42, scale: 1.2 },
      { kind: "obelisk", x: 52, y: 54, scale: 1.2 },
      { kind: "obelisk", x: 30, y: 30, scale: 1.0 },
      { kind: "obelisk", x: 66, y: 66, scale: 1.0 },
    ];

  } else if (id === "shipwreck") {
    // Titan Graveyard (native 96x96): open abyssal water littered with colossal wrecks,
    // interior spawn isles chained by coral shoals around the central graveyard reef.
    addRectRaw(waterSet, 0, 0, W, H);
    const siles: [number, number, number][] = [
      [11, 11, 9], [85, 85, 9], [85, 11, 9], [11, 85, 9],
      [48, 11, 9.5], [48, 85, 9.5], [11, 48, 9.5], [85, 48, 9.5],
    ];
    siles.forEach(([ix, iy, r], i) => paintPoly(waterSet, noiseRing(ix, iy, r + 0.5, r, 821 + i * 17, 0.17), false));
    // central graveyard shoal
    paintPoly(waterSet, noiseRing(48, 48, 12, 11, 829, 0.15), false);
    // shoal causeway chain (unclosed) + single spoke into the graveyard
    const schain: [number, number][][] = [
      [[18, 12], [30, 10], [39, 11]],
      [[57, 11], [68, 10], [77, 12]],
      [[85, 18], [86, 30], [86, 39]],
      [[86, 57], [86, 68], [85, 77]],
      [[78, 85], [66, 86], [57, 85]],
      [[39, 85], [28, 86], [18, 84]],
      [[11, 77], [10, 66], [11, 57]],
      [[48, 20], [48, 30], [48, 37]],
    ];
    for (const leg of schain) paintLine(waterSet, chaikin(leg, false, 2), 3.2, false);
    addRectRaw(cliffSet, 43, 42, 3, 2);
    addRectRaw(cliffSet, 52, 53, 3, 2);
    derricks = [
      [45, 43],
      [45, 53],
      [24, 24],
      [70, 70],
    ];
    coalmines = [
      [42, 48],
      [54, 48],
    ];
    extraOre = [
      [48, 48, 3],
      [25, 70, 2],
      [71, 26, 2],
    ];
    artifacts = [
      { kind: "shipwreck", x: 44, y: 44, rot: 0.4, scale: 1.6 },
      { kind: "shipwreck", x: 53, y: 52, rot: -2.7, scale: 1.6 },
      { kind: "shipwreck", x: 24, y: 60, rot: -0.6, scale: 1.4 },
      { kind: "shipwreck", x: 72, y: 36, rot: 2.5, scale: 1.4 },
      { kind: "shipwreck", x: 30, y: 16, rot: 1.45, scale: 1.3 },
      { kind: "shipwreck", x: 66, y: 82, rot: -1.65, scale: 1.3 },
      { kind: "seastack", x: 30, y: 48, scale: 1.1 },
      { kind: "seastack", x: 66, y: 48, scale: 1.1 },
      { kind: "buoy", x: 48, y: 24 },
      { kind: "buoy", x: 48, y: 72 },
    ];

  } else if (id === "volcano") {
    // Caldera Forge (native 96x96): a molten caldera isle rising from a steaming ring
    // sea — the perimeter rim is one continuous coast, the ocean lane circles inside it.
    addRectRaw(waterSet, 0, 0, W, H);
    // central volcanic massif
    paintPoly(waterSet, noiseRing(48, 48, 20, 18, 831, 0.13), false);
    // interior spawn capes pushing into the rim shallows
    const vcapes: [number, number, number][] = [
      [12, 12, 9], [84, 84, 9], [84, 12, 9], [12, 84, 9],
      [48, 9, 9.5], [48, 87, 9.5], [9, 48, 9.5], [87, 48, 9.5],
    ];
    vcapes.forEach(([ix, iy, r], i) => paintPoly(waterSet, noiseRing(ix, iy, r, r - 1, 841 + i * 11, 0.15), false));
    // obsidian causeways chaining the capes along the rim (unclosed) + one caldera bridge
    const vchain: [number, number][][] = [
      [[18, 12], [30, 10], [39, 10]],
      [[57, 10], [68, 10], [77, 12]],
      [[85, 18], [86, 30], [86, 39]],
      [[86, 57], [86, 68], [85, 77]],
      [[77, 84], [66, 86], [57, 86]],
      [[39, 86], [28, 86], [18, 84]],
      [[11, 77], [10, 66], [11, 57]],
      [[48, 18], [48, 26], [48, 31]], // single bridge onto the caldera massif
    ];
    for (const leg of vchain) paintLine(waterSet, chaikin(leg, false, 2), 3.2, false);
    addRectRaw(cliffSet, 40, 36, 6, 3);
    addRectRaw(cliffSet, 52, 36, 6, 3);
    addRectRaw(cliffSet, 40, 57, 6, 3);
    addRectRaw(cliffSet, 52, 57, 6, 3);
    addRectRaw(cliffSet, 36, 42, 3, 4);
    addRectRaw(cliffSet, 58, 50, 3, 4);
    derricks = [
      [47, 42],
      [47, 53],
    ];
    coalmines = [
      [40, 48],
      [55, 48],
    ];
    extraOre = [[48, 48, 4]];
    artifacts = [
      { kind: "lava_vent", x: 42, y: 38, scale: 1.2 },
      { kind: "lava_vent", x: 54, y: 38, scale: 1.2 },
      { kind: "lava_vent", x: 42, y: 58, scale: 1.2 },
      { kind: "lava_vent", x: 54, y: 58, scale: 1.2 },
      { kind: "seastack", x: 30, y: 22, scale: 1.1 },
      { kind: "seastack", x: 66, y: 74, scale: 1.1 },
    ];

  } else if (id === "oilrig") {
    // Offshore Megarig (native 96x96): deep open ocean — small interior platform isles
    // linked by pontoon causeways converging on the giant central rig superstructure.
    addRectRaw(waterSet, 0, 0, W, H);
    const oiles: [number, number, number][] = [
      [11, 11, 8.5], [85, 85, 8.5], [85, 11, 8.5], [11, 85, 8.5],
      [48, 10.5, 9], [48, 85.5, 9], [10.5, 48, 9], [85.5, 48, 9],
    ];
    oiles.forEach(([ix, iy, r], i) => paintPoly(waterSet, noiseRing(ix, iy, r, r - 0.5, 851 + i * 19, 0.14), false));
    // central megastructure platform — broad enough for the rig forest & contested war
    paintPoly(waterSet, noiseRing(48, 48, 14, 13, 859, 0.1), false);
    // pontoon causeways: perimeter chain (unclosed) + twin rig access decks
    const ochain: [number, number][][] = [
      [[17, 13], [29, 10], [39, 11]],
      [[57, 11], [68, 10], [78, 13]],
      [[86, 17], [87, 29], [86, 39]],
      [[86, 57], [87, 68], [85, 78]],
      [[78, 84], [67, 86], [57, 86]],
      [[39, 86], [28, 86], [17, 84]],
      [[10, 77], [9, 66], [10, 57]],
      [[48, 19], [48, 28], [48, 35]], // north deck
      [[84, 48], [73, 48], [62, 48]], // east deck
    ];
    for (const leg of ochain) paintLine(waterSet, chaikin(leg, false, 2), 3.2, false);
    derricks = [
      [42, 42],
      [54, 42],
      [42, 54],
      [54, 54],
    ];
    extraOre = [[48, 48, 3]];
    artifacts = [
      { kind: "oilrig_tower", x: 44, y: 44, scale: 1.2 },
      { kind: "oilrig_tower", x: 53, y: 53, scale: 1.2 },
      { kind: "lighthouse", x: 13, y: 13, scale: 0.9 },
      { kind: "lighthouse", x: 83, y: 83, scale: 0.9 },
      { kind: "buoy", x: 30, y: 24 },
      { kind: "buoy", x: 66, y: 24 },
      { kind: "buoy", x: 30, y: 72 },
      { kind: "buoy", x: 66, y: 72 },
      { kind: "shipwreck", x: 24, y: 66, rot: 0.2, scale: 1.1 },
      { kind: "shipwreck", x: 72, y: 30, rot: -2.9, scale: 1.1 },
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
    // Strait of Hormuz (native 96x96): Iran's northern coast faces Arabia's southern
    // shore across a true blue-water strait. Tanker lanes wrap the open western gulf;
    // the only land crossing is the contested eastern chokepoint causeway.
    addRectRaw(waterSet, 0, 0, W, H);
    paintPoly(waterSet, noiseRing(48, 10, 46, 10, 901, 0.08), false); // northern coast (Iran)
    paintPoly(waterSet, noiseRing(48, 86, 46, 10, 902, 0.08), false); // southern coast (Arabia)
    // mid-strait island chain (the real Abu Musa / Tunbs of the chokepoint)
    paintPoly(waterSet, noiseRing(74, 44, 5.5, 5, 903, 0.16), false);
    paintPoly(waterSet, noiseRing(83, 52, 4.5, 4, 904, 0.16), false);
    paintPoly(waterSet, noiseRing(24, 52, 5, 4.5, 905, 0.16), false);
    // eastern chokepoint causeway chaining shore -> islets -> far shore
    paintLine(waterSet, chaikin([[78, 24], [77, 33], [75, 41]], false, 1), 3.6, false);
    paintLine(waterSet, chaikin([[74, 49], [77, 55], [80, 62], [81, 71]], false, 1), 3.6, false);
    paintLine(waterSet, chaikin([[83, 56], [85, 63], [86, 71]], false, 1), 3.2, false);
    // coastal bluffs guarding the shore approaches
    addRectRaw(cliffSet, 20, 20, 4, 3);
    addRectRaw(cliffSet, 70, 19, 4, 3);
    addRectRaw(cliffSet, 22, 74, 4, 3);
    addRectRaw(cliffSet, 66, 75, 4, 3);
    derricks = [
      [74, 43],
      [23, 51],
      [15, 11],
      [80, 83],
    ];
    coalmines = [
      [12, 22],
      [84, 74],
    ];
    extraOre = [
      [48, 12, 3],
      [48, 84, 3],
    ];
    artifacts = [
      { kind: "oilrig_tower", x: 48, y: 48, scale: 1.35 },
      { kind: "lighthouse", x: 75, y: 42, scale: 1.0 },
      { kind: "lighthouse", x: 24, y: 53, scale: 1.0 },
      { kind: "shipwreck", x: 60, y: 40, rot: -0.5, scale: 1.2 },
      { kind: "buoy", x: 40, y: 38 },
      { kind: "buoy", x: 56, y: 58 },
      { kind: "buoy", x: 30, y: 44 },
      { kind: "buoy", x: 66, y: 50 },
    ];

  } else if (id === "delta") {
    // Mekong Delta (native 96x96): braided jungle rivers fan out of the north into a
    // wide open bay — brown-water navy rules the channels while fords & causeways
    // stitch the mangrove paddies together.
    addRectRaw(waterSet, 0, 0, W, H);
    // three jungle continental fingers reaching down from the north edge
    paintPoly(waterSet, noiseRing(16, 20, 15, 22, 911, 0.13), false); // west finger (spawn 0/6)
    paintPoly(waterSet, noiseRing(48, 16, 14, 18, 912, 0.13), false); // central finger (spawn 4/2?)
    paintPoly(waterSet, noiseRing(82, 20, 15, 22, 913, 0.13), false); // east finger (spawn 2/7)
    // southern bay islands
    paintPoly(waterSet, noiseRing(15, 82, 12, 9, 914, 0.15), false); // SW isle (spawn 3)
    paintPoly(waterSet, noiseRing(81, 82, 12, 9, 915, 0.15), false); // SE isle (spawn 1)
    paintPoly(waterSet, noiseRing(48, 86, 8, 7, 916, 0.15), false); // S isle (spawn 5)
    // causeway fords chaining continent fingers and southern isles (unclosed tree)
    paintLine(waterSet, chaikin([[28, 36], [34, 40], [40, 42]], false, 1), 3.4, false); // west-central ford
    paintLine(waterSet, chaikin([[60, 42], [66, 40], [72, 36]], false, 1), 3.4, false); // central-east ford
    paintLine(waterSet, chaikin([[26, 58], [25, 65], [24, 71]], false, 1), 3.4, false); // SW isle link
    paintLine(waterSet, chaikin([[70, 71], [71, 65], [72, 58]], false, 1), 3.4, false); // SE isle link
    paintLine(waterSet, chaikin([[48, 60], [48, 68], [48, 78]], false, 1), 3.4, false); // S isle causeway
    paintLine(waterSet, chaikin([[20, 42], [21, 48], [22, 54]], false, 1), 3.2, false); // west bank chain
    paintLine(waterSet, chaikin([[78, 54], [79, 48], [80, 42]], false, 1), 3.2, false); // east bank chain
    // mangrove high ground
    addRectRaw(cliffSet, 44, 34, 4, 3);
    addRectRaw(cliffSet, 52, 40, 3, 3);
    derricks = [
      [47, 44],
      [23, 77],
      [71, 77],
    ];
    coalmines = [
      [10, 24],
      [84, 24],
    ];
    extraOre = [
      [48, 24, 3],
      [48, 56, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 47, y: 85, scale: 0.95 },
      { kind: "seastack", x: 36, y: 72, scale: 1.1 },
      { kind: "shipwreck", x: 62, y: 68, rot: 2.3, scale: 1.0 },
      { kind: "buoy", x: 32, y: 52 },
      { kind: "buoy", x: 64, y: 52 },
      { kind: "buoy", x: 48, y: 68 },
    ];

  } else if (id === "bering") {
    // Bering Strait (native 96x96): Asia west, America east — a broad icy strait between
    // them wrapping the open northern end, with the Diomede stepping-stone isles and a
    // narrow causeway chain across the southern chokepoint.
    addRectRaw(waterSet, 0, 0, W, H);
    paintPoly(waterSet, noiseRing(21, 48, 15, 42, 921, 0.11), false); // Asia continent (spawns 0,3,6)
    paintPoly(waterSet, noiseRing(75, 48, 15, 42, 922, 0.11), false); // America continent (spawns 1,2,7)
    addRectRaw(waterSet, 36, 4, 24, 10);
    addRectRaw(waterSet, 38, 30, 20, 8);
    // Diomede stepping stones mid-strait
    paintPoly(waterSet, noiseRing(48, 62, 5, 4.5, 923, 0.15), false);
    paintPoly(waterSet, noiseRing(51, 74, 4.5, 4, 924, 0.15), false);
    // north & south mid-edge ice capes for spawns 4/5
    paintPoly(waterSet, noiseRing(48, 12, 12, 8, 925, 0.14), false);
    paintPoly(waterSet, noiseRing(48, 88, 10, 7, 926, 0.14), false);
    // cape links + Diomede causeway chain across the southern strait chokepoint
    paintLine(waterSet, chaikin([[37, 14], [34, 20], [31, 27]], false, 1), 3.4, false);
    paintLine(waterSet, chaikin([[59, 14], [62, 20], [65, 27]], false, 1), 3.4, false);
    paintLine(waterSet, chaikin([[36, 68], [41, 65], [45, 63]], false, 1), 3.4, false);
    paintLine(waterSet, chaikin([[51, 60], [57, 58], [62, 55]], false, 1), 3.4, false);
    paintLine(waterSet, chaikin([[49, 79], [48, 83]], false, 1), 3.2, false);
    paintLine(waterSet, chaikin([[45, 87], [41, 84], [36, 80]], false, 1), 3.2, false);
    paintLine(waterSet, chaikin([[55, 87], [60, 84], [64, 79]], false, 1), 3.2, false);
    // ice floes & continental ridges
    addRectRaw(cliffSet, 40, 30, 2, 3);
    addRectRaw(cliffSet, 56, 24, 2, 3);
    addRectRaw(cliffSet, 44, 18, 2, 2);
    addRectRaw(cliffSet, 52, 44, 2, 2);
    addRectRaw(cliffSet, 18, 30, 5, 3);
    addRectRaw(cliffSet, 74, 64, 5, 3);
    addRectRaw(cliffSet, 18, 82, 4, 3);
    addRectRaw(cliffSet, 74, 14, 4, 3);
    derricks = [
      [47, 61],
      [30, 48],
      [64, 44],
      [20, 20],
    ];
    coalmines = [
      [14, 60],
      [82, 30],
    ];
    extraOre = [
      [26, 72, 4],
      [70, 24, 4],
      [48, 30, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 47, y: 61, scale: 1.05 },
      { kind: "seastack", x: 44, y: 38, scale: 1.25 },
      { kind: "seastack", x: 52, y: 82, scale: 1.25 },
      { kind: "shipwreck", x: 50, y: 46, rot: 0.9, scale: 1.3 },
      { kind: "buoy", x: 44, y: 52 },
      { kind: "buoy", x: 54, y: 68 },
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
    // Coral Sea Theatre (native 96x96, 8-player grand ocean): full blue-water theater —
    // 8 interior island bases chained by coral causeways around the central carrier
    // atoll, with wide open carrier lanes everywhere.
    addRectRaw(waterSet, 0, 0, W, H);
    const piles: [number, number, number][] = [
      [10.5, 10.5, 9], [85.5, 85.5, 9], [85.5, 10.5, 9], [10.5, 85.5, 9],
      [48, 10.5, 10], [48, 85.5, 10], [10.5, 48, 10], [85.5, 48, 10],
    ];
    piles.forEach(([ix, iy, r], i) => paintPoly(waterSet, noiseRing(ix, iy, r + 1, r, 941 + i * 23, 0.15), false));
    // central carrier atoll
    paintPoly(waterSet, noiseRing(48, 48, 13, 12, 949, 0.13), false);
    paintPoly(waterSet, noiseRing(48, 48, 6, 5.5, 950, 0.08), true);
    paintLine(waterSet, chaikin([[34, 36], [41, 42], [47, 45]], false, 2), 6.5, true);
    // perimeter causeway chain (unclosed) + single spoke to the atoll
    const pchain: [number, number][][] = [
      [[18, 11], [30, 10], [39, 11]],
      [[57, 11], [68, 10], [78, 12]],
      [[86, 18], [87, 30], [86, 39]],
      [[86, 57], [87, 68], [86, 78]],
      [[78, 86], [66, 87], [57, 86]],
      [[39, 86], [28, 87], [18, 85]],
      [[11, 78], [10, 66], [11, 57]],
      [[48, 20], [48, 29], [48, 36]],
    ];
    for (const leg of pchain) paintLine(waterSet, chaikin(leg, false, 2), 3.2, false);
    // resource islets in the blue water
    paintPoly(waterSet, noiseRing(25, 25, 5, 4.5, 951, 0.16), false);
    paintPoly(waterSet, noiseRing(71, 71, 5, 4.5, 952, 0.16), false);
    paintPoly(waterSet, noiseRing(71, 25, 4.5, 4, 953, 0.16), false);
    paintPoly(waterSet, noiseRing(25, 71, 4.5, 4, 954, 0.16), false);
    addRectRaw(cliffSet, 42, 42, 3, 3);
    addRectRaw(cliffSet, 53, 53, 3, 3);
    derricks = [
      [47, 41],
      [47, 54],
      [24, 24],
      [70, 70],
    ];
    coalmines = [
      [24, 70],
      [70, 24],
    ];
    extraOre = [
      [48, 48, 4],
      [25, 25, 3],
      [71, 71, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 42, y: 40, scale: 1.1 },
      { kind: "lighthouse", x: 55, y: 56, scale: 1.1 },
      { kind: "shipwreck", x: 30, y: 60, rot: 0.5, scale: 1.4 },
      { kind: "shipwreck", x: 66, y: 36, rot: -2.6, scale: 1.4 },
      { kind: "seastack", x: 24, y: 48, scale: 1.3 },
      { kind: "seastack", x: 72, y: 48, scale: 1.3 },
      { kind: "buoy", x: 36, y: 48 },
      { kind: "buoy", x: 60, y: 48 },
    ];

  } else if (id === "arctic_front") {
    // Polar Sea Front (native 96x96): a frozen ocean — interior ice-sheet spawn shelves
    // chained by icebreaker causeways around the contested central polar fortress,
    // wide dark-water channels for wolfpacks & carriers.
    addRectRaw(waterSet, 0, 0, W, H);
    const xiles: [number, number, number][] = [
      [11, 11, 9], [85, 85, 9], [85, 11, 9], [11, 85, 9],
      [48, 10.5, 10], [48, 85.5, 10], [10.5, 48, 10], [85.5, 48, 10],
    ];
    xiles.forEach(([ix, iy, r], i) => paintPoly(waterSet, noiseRing(ix, iy, r + 0.5, r, 961 + i * 29, 0.17), false));
    // central polar fortress ice mass
    paintPoly(waterSet, noiseRing(48, 48, 12, 11, 969, 0.12), false);
    // icebreaker causeway chain (unclosed) + one polar spoke
    const xchain: [number, number][][] = [
      [[18, 12], [30, 10], [39, 11]],
      [[57, 11], [68, 10], [77, 12]],
      [[85, 18], [86, 30], [86, 39]],
      [[86, 57], [86, 68], [85, 77]],
      [[78, 85], [66, 86], [57, 86]],
      [[39, 86], [28, 86], [18, 84]],
      [[11, 77], [10, 66], [11, 57]],
      [[48, 20], [48, 29], [48, 37]],
    ];
    for (const leg of xchain) paintLine(waterSet, chaikin(leg, false, 2), 3.4, false);
    // scattered ice floes (sea hazards)
    addRectRaw(cliffSet, 30, 34, 2, 2);
    addRectRaw(cliffSet, 66, 62, 2, 2);
    addRectRaw(cliffSet, 34, 66, 2, 2);
    addRectRaw(cliffSet, 62, 30, 2, 2);
    addRectRaw(cliffSet, 44, 44, 3, 3);
    addRectRaw(cliffSet, 52, 52, 3, 3);
    derricks = [
      [46, 43],
      [46, 53],
      [24, 24],
      [70, 70],
    ];
    coalmines = [
      [42, 48],
      [54, 48],
    ];
    extraOre = [
      [48, 48, 4],
      [25, 71, 3],
      [71, 25, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 40, y: 40, scale: 1.05 },
      { kind: "lighthouse", x: 57, y: 57, scale: 1.05 },
      { kind: "shipwreck", x: 48, y: 24, rot: 0.2, scale: 1.3 },
      { kind: "shipwreck", x: 48, y: 72, rot: -2.9, scale: 1.3 },
      { kind: "seastack", x: 24, y: 48, scale: 1.2 },
      { kind: "seastack", x: 72, y: 48, scale: 1.2 },
      { kind: "buoy", x: 36, y: 30 },
      { kind: "buoy", x: 60, y: 66 },
    ];

  } else if (id === "megacontinent") {
    // Eurasia Supertheater (128x128): twin colossal continents west & east, a true
    // central sea between them wrapping the open northern end — the southern causeway
    // highways are the only land crossings of the strait.
    addRectRaw(waterSet, 0, 0, W, H);
    paintPoly(waterSet, noiseRing(28, 64, 24, 61, 971, 0.08), false); // west continent (Europe)
    paintPoly(waterSet, noiseRing(100, 64, 24, 61, 972, 0.08), false); // east continent (Asia)
    // mid-edge peninsula capes for N/S spawns
    paintPoly(waterSet, noiseRing(64, 13, 14, 10, 973, 0.13), false);
    paintPoly(waterSet, noiseRing(64, 115, 14, 10, 974, 0.13), false);
    addRectRaw(waterSet, 56, 4, 18, 120);
    paintPoly(waterSet, noiseRing(44, 28, 17, 14, 968, 0.06), true); // european gulf
    paintPoly(waterSet, noiseRing(86, 100, 17, 14, 967, 0.06), true); // asian gulf
    paintPoly(waterSet, noiseRing(65, 64, 15, 22, 970, 0.1), true);
    // stepping-stone islets in the strait
    paintPoly(waterSet, noiseRing(64, 48, 6, 5, 975, 0.15), false);
    paintPoly(waterSet, noiseRing(63, 82, 5.5, 5, 976, 0.15), false);
    // cape links into the continents
    paintLine(waterSet, chaikin([[52, 16], [47, 22], [43, 30]], false, 1), 3.6, false);
    paintLine(waterSet, chaikin([[76, 16], [81, 22], [85, 30]], false, 1), 3.6, false);
    paintLine(waterSet, chaikin([[52, 112], [47, 106], [43, 98]], false, 1), 3.6, false);
    paintLine(waterSet, chaikin([[76, 112], [81, 106], [85, 98]], false, 1), 3.6, false);
    // two grand southern causeway highways shore -> islet -> shore
    paintLine(waterSet, chaikin([[48, 52], [54, 50], [59, 49]], false, 1), 4, false);
    paintLine(waterSet, chaikin([[69, 47], [75, 45], [81, 42]], false, 1), 4, false);
    paintLine(waterSet, chaikin([[49, 86], [55, 84], [59, 83]], false, 1), 4, false);
    paintLine(waterSet, chaikin([[68, 81], [75, 79], [82, 76]], false, 1), 4, false);
    // continental mountain ranges
    addRectRaw(cliffSet, 24, 48, 6, 14);
    addRectRaw(cliffSet, 98, 66, 6, 14);
    addRectRaw(cliffSet, 24, 96, 6, 12);
    addRectRaw(cliffSet, 98, 18, 6, 12);
    addRectRaw(cliffSet, 40, 64, 7, 5);
    addRectRaw(cliffSet, 82, 60, 7, 5);
    derricks = [
      [63, 47],
      [62, 81],
      [26, 64],
      [100, 60],
    ];
    coalmines = [
      [30, 40],
      [96, 88],
      [30, 104],
      [96, 30],
    ];
    extraOre = [
      [64, 64, 5],
      [30, 64, 4],
      [98, 60, 4],
      [34, 34, 3],
      [94, 94, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 62, y: 46, scale: 1.2 },
      { kind: "lighthouse", x: 65, y: 84, scale: 1.2 },
      { kind: "shipwreck", x: 64, y: 32, rot: 0.4, scale: 1.6 },
      { kind: "shipwreck", x: 64, y: 98, rot: -2.7, scale: 1.6 },
      { kind: "oilrig_tower", x: 64, y: 14, scale: 1.25 },
      { kind: "oilrig_tower", x: 64, y: 114, scale: 1.25 },
      { kind: "buoy", x: 58, y: 64 },
      { kind: "buoy", x: 70, y: 64 },
    ];

  } else if (id === "english_channel") {
    // English Channel (native 256x192): Britain holds the north, France the south, with
    // a true blue-water channel between — wrapping the open North Sea gap in the NE.
    // The Dover chokepoint causeway chain is the only land crossing.
    addRectRaw(waterSet, 0, 0, W, H);
    paintPoly(waterSet, noiseRing(126, 25, 120, 23, 1201, 0.07), false); // Britain (spawns 0,4,2-ish north)
    paintPoly(waterSet, noiseRing(126, 168, 118, 22, 1202, 0.07), false); // France (spawns 1,5,3 south)
    // mid-channel Isle-of-Wight-style stepping islets + the Dover chain
    paintPoly(waterSet, noiseRing(22, 95, 21, 24, 1207, 0.1), false); // Ireland — west-mid spawn landmass
    paintPoly(waterSet, noiseRing(238, 120, 17, 30, 1208, 0.1), false); // Low Countries — east-mid, chained to France
    paintLine(waterSet, chaikin([[24, 74], [22, 60], [20, 50]], false, 1), 3.6, false); // irish sea crossing to Britain
    paintPoly(waterSet, noiseRing(200, 78, 7, 6, 1203, 0.15), false);
    paintPoly(waterSet, noiseRing(214, 100, 6, 5.5, 1204, 0.15), false);
    paintPoly(waterSet, noiseRing(88, 110, 6, 5, 1205, 0.15), false);
    paintPoly(waterSet, noiseRing(52, 92, 5, 4.5, 1206, 0.15), false);
    // Dover causeway chain: Britain -> islet -> islet -> France
    paintLine(waterSet, chaikin([[196, 48], [198, 62], [200, 72]], false, 1), 4, false);
    paintLine(waterSet, chaikin([[202, 84], [208, 92], [213, 97]], false, 1), 4, false);
    paintLine(waterSet, chaikin([[216, 106], [218, 122], [218, 146]], false, 1), 4, false);
    // western chain spur toward the mid isles (unclosed — sea flows free)
    paintLine(waterSet, chaikin([[84, 50], [86, 68], [88, 104]], false, 1), 3.6, false);
    // coastal cliffs — Dover white cliffs & Normandy bluffs
    addRectRaw(cliffSet, 180, 34, 8, 4);
    addRectRaw(cliffSet, 196, 148, 8, 4);
    addRectRaw(cliffSet, 60, 30, 8, 4);
    addRectRaw(cliffSet, 70, 152, 8, 4);
    derricks = [
      [198, 77],
      [212, 99],
      [86, 108],
      [50, 91],
    ];
    coalmines = [
      [60, 24],
      [180, 24],
      [70, 166],
      [190, 166],
    ];
    extraOre = [
      [120, 24, 4],
      [124, 166, 4],
      [88, 110, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 199, y: 76, scale: 1.2 },
      { kind: "lighthouse", x: 87, y: 109, scale: 1.1 },
      { kind: "shipwreck", x: 150, y: 100, rot: 0.5, scale: 1.6 },
      { kind: "shipwreck", x: 100, y: 70, rot: -2.4, scale: 1.4 },
      { kind: "buoy", x: 160, y: 80 },
      { kind: "buoy", x: 120, y: 120 },
      { kind: "seastack", x: 52, y: 130, scale: 1.2 },
    ];
  } else if (id === "persian_gulf") {
    // Persian Gulf (native 224x224): Iran's mountainous NE shore faces the Arabian
    // peninsula SW across a wide open gulf. The Hormuz chokepoint chain guards the
    // narrow SE outlet; the rest is true blue water.
    addRectRaw(waterSet, 0, 0, W, H);
    // Iran — NE arc
    paintPoly(waterSet, noiseRing(112, 18, 104, 16, 1211, 0.09), false);
    paintPoly(waterSet, noiseRing(200, 60, 22, 40, 1212, 0.09), false);
    // Arabia — SW arc
    paintPoly(waterSet, noiseRing(112, 206, 104, 16, 1213, 0.09), false);
    paintPoly(waterSet, noiseRing(24, 150, 22, 40, 1214, 0.09), false);
    // gulf island chain (Qeshm/Abu Musa analogs) + Hormuz chokepoint causeways
    paintPoly(waterSet, noiseRing(170, 150, 7, 6, 1215, 0.15), false);
    paintPoly(waterSet, noiseRing(184, 168, 6, 5, 1216, 0.15), false);
    paintPoly(waterSet, noiseRing(60, 100, 6, 5, 1217, 0.15), false);
    paintLine(waterSet, chaikin([[196, 100], [188, 124], [176, 144]], false, 1), 4, false);
    paintLine(waterSet, chaikin([[166, 156], [172, 162], [180, 166]], false, 1), 4, false);
    paintLine(waterSet, chaikin([[186, 174], [192, 186], [196, 196]], false, 1), 4, false);
    // Zagros mountain cliffs along the Iranian shore
    addRectRaw(cliffSet, 60, 22, 8, 4);
    addRectRaw(cliffSet, 130, 20, 8, 4);
    addRectRaw(cliffSet, 196, 48, 4, 8);
    derricks = [
      [168, 148],
      [58, 98],
      [182, 166],
      [130, 40],
    ];
    coalmines = [
      [112, 26],
      [112, 196],
      [196, 60],
      [28, 156],
    ];
    extraOre = [
      [112, 26, 4],
      [112, 198, 4],
      [184, 168, 3],
    ];
    artifacts = [
      { kind: "oilrig_tower", x: 110, y: 112, scale: 1.5 },
      { kind: "oilrig_tower", x: 140, y: 90, scale: 1.3 },
      { kind: "lighthouse", x: 169, y: 149, scale: 1.1 },
      { kind: "shipwreck", x: 90, y: 140, rot: 0.9, scale: 1.4 },
      { kind: "buoy", x: 120, y: 120 },
      { kind: "buoy", x: 150, y: 170 },
      { kind: "buoy", x: 80, y: 80 },
    ];
  } else if (id === "panama") {
    // Panama Isthmus (native 224x192): North America anchors the NW, South America the
    // SE — oceans dominate the NE (Caribbean) & SW (Pacific). The isthmus land bridge
    // crosses the center, cut by the canal channel that keeps both oceans one sea.
    addRectRaw(waterSet, 0, 0, W, H);
    // North America — NW continental mass
    paintPoly(waterSet, noiseRing(86, 26, 84, 25, 1221, 0.06), false);
    // South America — SE continental mass
    paintPoly(waterSet, noiseRing(138, 166, 84, 25, 1222, 0.06), false);
    // the isthmus land bridge connecting the continents (interior, unclosed)
    paintLine(waterSet, chaikin([[86, 64], [104, 84], [120, 104], [136, 122]], false, 2), 12, false);
    // THE CANAL: water cut straight through the isthmus — narrow but ship-passable
    paintLine(waterSet, chaikin([[104, 82], [112, 94], [120, 104], [128, 114]], false, 1), 5, true);
    // pearl-island stepping stones in the pacific gulf
    paintPoly(waterSet, noiseRing(208, 16, 26, 15, 1227, 0.08), false); // NE cape (spawn 2)
    paintPoly(waterSet, noiseRing(16, 176, 25, 15, 1228, 0.08), false); // SW cape (spawn 3)
    paintLine(waterSet, chaikin([[186, 18], [160, 22], [138, 24]], false, 1), 4, false); // NE cape chain to N.America
    paintLine(waterSet, chaikin([[36, 174], [60, 170], [84, 168]], false, 1), 4, false); // SW cape chain to S.America
    paintPoly(waterSet, noiseRing(206, 95, 16, 13, 1225, 0.12), false); // Cuba — east-mid spawn isle
    paintPoly(waterSet, noiseRing(16, 95, 15, 12, 1226, 0.12), false); // Cocos — west-mid spawn isle
    paintLine(waterSet, chaikin([[192, 90], [176, 84], [150, 72], [128, 66]], false, 2), 3.6, false); // cuba-caribbean chain to the mainland
    paintPoly(waterSet, noiseRing(120, 150, 6, 5, 1223, 0.15), false);
    paintPoly(waterSet, noiseRing(100, 120, 5, 4.5, 1224, 0.15), false);
    // continental divide cliffs along the isthmus spine
    addRectRaw(cliffSet, 96, 74, 4, 5);
    addRectRaw(cliffSet, 130, 112, 4, 5);
    addRectRaw(cliffSet, 40, 20, 6, 4);
    addRectRaw(cliffSet, 180, 160, 6, 4);
    derricks = [
      [118, 148],
      [98, 118],
      [60, 34],
      [164, 146],
    ];
    coalmines = [
      [30, 24],
      [196, 168],
    ];
    extraOre = [
      [60, 40, 4],
      [164, 150, 4],
      [112, 92, 3],
    ];
    artifacts = [
      { kind: "lighthouse", x: 119, y: 149, scale: 1.15 },
      { kind: "lighthouse", x: 99, y: 119, scale: 1.05 },
      { kind: "shipwreck", x: 150, y: 60, rot: -0.4, scale: 1.5 },
      { kind: "buoy", x: 112, y: 96 },
      { kind: "buoy", x: 170, y: 100 },
      { kind: "buoy", x: 60, y: 110 },
      { kind: "seastack", x: 80, y: 160, scale: 1.2 },
    ];
  } else if (id === "fulda_gap") {
    // Fulda Gap (native 192x192, pure land): rolling german hill country — two great
    // north-south ridge lines split the theater into three armored corridors, with
    // pass chokepoints cut through each ridge. No water: a pure mechanized land war.
    const ridge1: [number, number][] = [[70, 8], [74, 50], [68, 96], [74, 140], [70, 184]];
    const ridge2: [number, number][] = [[124, 8], [120, 50], [126, 96], [120, 140], [124, 184]];
    for (const [rx, ry] of ridge1) paintPoly(cliffSet, noiseRing(rx, ry, 7, 16, 1231 + ry, 0.2), false);
    for (const [rx, ry] of ridge2) paintPoly(cliffSet, noiseRing(rx, ry, 7, 16, 1241 + ry, 0.2), false);
    // carve the pass chokepoints through both ridges (the gaps the war is fought over)
    paintLine(cliffSet, chaikin([[72, 48], [72, 54], [72, 60]], false, 1), 9, true);
    paintLine(cliffSet, chaikin([[70, 128], [71, 134], [72, 140]], false, 1), 9, true);
    paintLine(cliffSet, chaikin([[123, 86], [123, 92], [123, 98]], false, 1), 9, true);
    paintLine(cliffSet, chaikin([[122, 150], [122, 156], [122, 162]], false, 1), 9, true);
    // scattered hill country & forests (cliff mesas)
    addRectRaw(cliffSet, 30, 90, 5, 4);
    addRectRaw(cliffSet, 100, 30, 5, 4);
    addRectRaw(cliffSet, 98, 160, 5, 4);
    addRectRaw(cliffSet, 160, 90, 5, 4);
    addRectRaw(cliffSet, 30, 150, 4, 4);
    addRectRaw(cliffSet, 160, 30, 4, 4);
    derricks = [
      [96, 96],
      [48, 48],
      [144, 144],
      [48, 144],
    ];
    coalmines = [
      [96, 30],
      [96, 162],
      [30, 96],
      [162, 96],
    ];
    extraOre = [
      [96, 96, 4],
      [48, 96, 3],
      [144, 96, 3],
      [96, 60, 3],
      [96, 132, 3],
    ];
    artifacts = [];
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

  // Ensure all 8 perimeter spawns on every map sit on solid dry land. Then, for any
  // spawn NOT already land-connected to the largest landmass, lay a narrow causeway
  // across the SHORTEST water crossing to the mainland — but only when that crossing
  // is narrow: genuine open-ocean separation is an intentional feature of oceanic
  // naval maps (crossed in-game by engineer pontoon bridges, never by auto-carved
  // land strips), so crossings longer than the cap are never paved at all.
  // (this pass works in REAL map coordinates — hence the Raw rect ops, not the design-grid scaled ones)
  for (const sp of getSpawns(W, H)) {
    clearRectRaw(cliffSet, sp.x - 1, sp.y - 1, 5, 5);
    clearRectRaw(waterSet, sp.x - 2, sp.y - 2, 7, 7);
  }
  if (waterSet.size > 0) {
    const landCompOf = () => {
      // 4-connected land components; comp id per tile (-1 = water/cliff)
      const comp = new Int32Array(W * H).fill(-1);
      let nc = 0;
      const sizes: number[] = [];
      for (let s = 0; s < W * H; s++) {
        if (comp[s] !== -1 || waterSet.has(s) || cliffSet.has(s)) continue;
        const q = [s];
        comp[s] = nc;
        let size = 0;
        while (q.length) {
          const t = q.pop()!;
          size++;
          const x = t % W,
            y = (t / W) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx,
              ny = y + dy,
              ni = ny * W + nx;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (comp[ni] !== -1 || waterSet.has(ni) || cliffSet.has(ni)) continue;
            comp[ni] = nc;
            q.push(ni);
          }
        }
        sizes.push(size);
        nc++;
      }
      return { comp, sizes };
    };
    // longest water crossing the pass may auto-bridge — narrow channels/fords only.
    // (engineer pontoon bridges reach much further in-game: maxSpan is W/4 in world.ts)
    const cap = Math.max(9, Math.round(Math.min(W, H) / 10));
    const spawnList = getSpawns(W, H);
    for (let round = 0; round < 4; round++) {
      const { comp, sizes } = landCompOf();
      let ref = 0;
      for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[ref]) ref = i;
      let anyCarved = false;
      for (const sp of spawnList) {
        const startComp = comp[sp.y * W + sp.x];
        if (startComp === ref || startComp < 0) continue; // already on the mainland
        // multi-source BFS from every land tile of the spawn's component, stepping
        // over water only, depth-capped — finds the narrowest crossing to ANY larger
        // or equal landmass. Wide open ocean simply yields no path within the cap.
        const prev = new Int32Array(W * H).fill(-2); // -2 unvisited, -1 source
        const depth = new Int32Array(W * H).fill(-1);
        const q: number[] = [];
        for (let t = 0; t < W * H; t++) {
          if (comp[t] === startComp) {
            prev[t] = -1;
            depth[t] = 0;
            q.push(t);
          }
        }
        let goal = -1;
        for (let qi = 0; qi < q.length && goal < 0; qi++) {
          const t = q[qi];
          if (depth[t] > cap) break; // BFS order — nothing narrower beyond
          const x = t % W,
            y = (t / W) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx,
              ny = y + dy,
              ni = ny * W + nx;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H || prev[ni] !== -2) continue;
            if (comp[ni] === startComp) continue;
            if (!waterSet.has(ni) && !cliffSet.has(ni)) {
              if (comp[ni] >= 0 && comp[ni] !== startComp && sizes[comp[ni]] >= sizes[startComp]) {
                goal = t; // water tile adjacent to a bigger/equal landmass
                prev[ni] = t;
                break;
              }
              continue;
            }
            if (cliffSet.has(ni)) continue; // can't bridge through rock
            prev[ni] = t;
            depth[ni] = depth[t] + 1;
            q.push(ni);
          }
        }
        if (goal < 0) continue; // oceanic separation — intended, leave isolated
        // backtrack & lay a 3-wide causeway along the crossing
        for (let t = goal; t >= 0; t = prev[t]) {
          const x = t % W,
            y = (t / W) | 0;
          for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
            const nx = x + ox,
              ny = y + oy,
              ni = ny * W + nx;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (waterSet.has(ni)) {
              waterSet.delete(ni);
              anyCarved = true;
            }
          }
        }
      }
      if (!anyCarved) break;
    }
  }

  // Cliffs trump water everywhere — resolve overlap BEFORE connectivity so the pass
  // doesn't route "through" tiles that are about to become non-water.
  for (const k of cliffSet) waterSet.delete(k);

  // Water connectivity pass: bridges, fords, islands & artifacts often pinch seas into
  // disconnected bodies — trapped ships make naval play useless. Flood-fill components,
  // keep the largest as "the sea", then Dijkstra-carve a narrow canal from every stray
  // body back to the sea (spawn zones are high-cost so canals skirt bases).
  if (waterSet.size > 0 && !MAP_DEBUG.noCanalPass) {
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

  // Organic coastlines jitter deterministically but unpredictably — snap every neutral
  // resource site to the nearest dry 2x2 footing within a short spiral search so no
  // derrick/coalmine ever ends up swimming or perched on rock.
  const dryFooting = (x: number, y: number): boolean => {
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const tx = x + dx,
          ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
        const k = ty * W + tx;
        if (waterSet.has(k) || cliffSet.has(k)) return false;
      }
    return true;
  };
  const snapSite = ([x, y]: [number, number]): [number, number] => {
    if (dryFooting(x, y)) return [x, y];
    for (let r = 1; r <= 12; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (dryFooting(x + dx, y + dy)) return [x + dx, y + dy];
        }
    return [x, y];
  };
  derricks = derricks.map(snapSite);
  if (coalmines) coalmines = coalmines.map(snapSite);

  const cliffs: [number, number][] = [];
  for (const k of cliffSet) cliffs.push([k % W, (k / W) | 0]);
  const water: [number, number][] = [];
  for (const k of waterSet) water.push([k % W, (k / W) | 0]);
  const layout: MapLayout = { w: W, h: H, cliffs, water, derricks, coalmines, extraOre, artifacts };
  mapCache.set(id, layout);
  return layout;
}
