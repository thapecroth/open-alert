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
  | "depot";
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
  noBuild?: true; // exists in the world but can't be queued (upgrade results)
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
};

// ---------- tech & special mechanics ----------
export const UPGRADE_COST = 1500; // factory -> factory2, requires a techlab
export const PURIFIER_BONUS = 0.25; // +25% credits per harvester deposit
export const DEPOT_RANGE = 6; // service depot heal aura radius (tiles)
export const DEPOT_HEAL = 4; // hp restored per vehicle per second
export const CAPTURE_RANGE = 1.9; // engineer must be this close to capture

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
