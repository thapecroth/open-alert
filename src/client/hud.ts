import type { LobbyPlayer, PlayerState, EntSnap, CrateSnap, MatchStats, RoomSummary } from "../shared/protocol";
import {
  BUILDINGS,
  UNITS,
  BUILD_ORDER,
  DEFENSE_ORDER,
  TRAIN_ORDER,
  BUILDING_NAMES,
  UPGRADE_PATHS,
  buildCategoryOf,
  CAPTURE_RANGE,
  PLAYER_COLORS,
  getSpawns,
  SW_CHARGE_TICKS,
  RECON_CHARGE_TICKS,
  MAP_LIST,
  BOT_PROFILES,
  DEFAULT_CONFIG,
  getMapLayout,
  BuildingKind,
  BuildCategory,
  UnitKind,
  EntKind,
  MapId,
  BotDiff,
  BotProfile,
  GameConfig,
  ProdCat,
  MAP_W,
  MAP_H,
} from "../shared/gamedefs";
import { el, fmtCost, isBuildingKind } from "./util";
import { Renderer } from "./render";
import type { FpvTelemetry } from "./fpv";
import { fpvStreakName, type FpvStoryState } from "./story";

// Mirrors the authoritative sim constants in src/server/world.ts. Kept local
// because the client bundle must not import the server simulation.
const TRAIN_QUEUE_MAX = 30;
const PROD_BOOST_PER_EXTRA = 0.25;
const PROD_BOOST_CAP = 2.0;
const multiProducerBoost = (count: number): number =>
  Math.min(PROD_BOOST_CAP, 1 + Math.max(0, count - 1) * PROD_BOOST_PER_EXTRA);

const TOOLTIPS: Record<string, string> = {
  conyard: "Construction Yard — the heart of your base.",
  power: "Power Plant — generates +100⚡ power. Click to upgrade in-place → Thermal Coal Plant (+200⚡) → Fusion Reactor (+420⚡).",
  coalplant: "Thermal Coal Plant (Tier II) — generates +200⚡ power. Click to upgrade in-place → Fusion Reactor (+420⚡) once Tech Lab is built.",
  fusion: "Fusion Reactor (Tier III) — apex clean-energy Tokamak generating +420⚡ power.",
  refinery: "Ore Refinery — unlocks harvesters; deploys one free.",
  supplyhub: "Forward Supply Hub — backup construction yard if your ConYard dies; extends build zone (26 tiles), refills Fuel/Ammo + light repair in 12-tile aura. Each extra hub speeds building construction.",
  barracks: "Barracks — trains Riflemen, Combat Engineers, AT / MANPADS & FPV Suicide Drones. Upgrade to MKII for Veteran ★ troops.",
  barracks2: "Barracks II — elite infantry command; trains Veteran ★ troops faster.",
  radar: "Radar Tower — reveals the minimap & detects cloaked B-21 Stealth Bombers. Unlocks Anti-Air Turret, Jammer Drone & HIMARS.",
  factory: "War Factory — builds Main Battle Tanks, HIMARS & logistics vehicles. Upgrade to MKII for Aegis Railgun MBT.",
  factory2: "War Factory II — heavy armor works; unlocks Aegis Railgun MBT + faster armored production.",
  airfield: "Air Command — deploys attritable drones & aircraft (Reaper, Delta Kamikaze, Jammer Drone, Interceptor, Hornet, A-10). Upgrade for Stealth Wing.",
  airfield2: "Air Command II — Stealth Wing; unlocks AC-130 Gunship, B-21 Stealth Bomber & Mach-9 Missile + Veteran ★ aircraft.",
  shipyard: "Naval Shipyard — builds Sea-Baby USVs, Submarines & warships on water. Upgrade to MKII for Fleet Dock.",
  shipyard2: "Naval Shipyard II — Fleet Dock; unlocks Poseidon Cruiser, Nimitz Drone Carrier & Veteran ★ ships.",
  techlab: "Tech Lab — unlocks Fusion Reactor, Ore Purifier, Iron Dome, Helios Laser, Defense Satellite & MKII upgrades.",
  satlink: "Defense Satellite — long-range orbital laser defense & telemetry hub; unlocks Nuclear Silo & Anti-Nuke. Limit 1.",
  turret: "Vulcan Turret — rapid-fire ground & anti-air (AA) base defense. Needs power.",
  sam: "Anti-Air Turret — cost-efficient kinetic counter-drone & anti-air defense. Needs power + Radar Tower.",
  arc: "Arc Spire — heavy ground & anti-air (AA) lightning defense in every direction. Needs power + Radar Tower.",
  irondome: "Iron Dome — reusable interceptor battery; stops artillery shells, drones & missiles (33% vs Mach-9) + AA. Limit 3.",
  lasertower: "Helios Laser — high-energy beam tower that melts heavy armor & aircraft. Needs power + Tech Lab.",
  thaad: "Anti-Nuke — heavy missile shield stopping Nuclear ICBMs (18 tiles) & Mach-9 Missiles (16 tiles) at 80% chance + detects B-21 Stealth (limit 2).",
  purifier: "Ore Purifier — +25% on every harvester deposit.",
  depot: "Service Depot — repairs nearby vehicles automatically.",
  superweapon: "Nuclear Silo — launches a devastating thermonuclear ICBM anywhere on the map (80% interceptable by enemy Anti-Nuke!)",
  derrick: "Oil Derrick — capture with a Combat Engineer for +$500 bonus & +$25/s income.",
  coalmine: "Coal Mine — capture with a Combat Engineer for +$400 bonus, +$20/s income & +60⚡ power.",
  infantry: "Rifleman — cheap, fast, anti-infantry & light AA.",
  engineer: "Combat Engineer — captures enemy buildings, Oil Derricks & Coal Mines on contact. Unarmed.",
  rocket: "AT / MANPADS — long-range anti-armor & anti-air (AA) missile team. Needs Radar.",
  fpvdrone: "FPV Suicide Drone — ultra-fast low-altitude kamikaze quadcopter; self-detonates for heavy anti-armor splash.",
  tank: "Main Battle Tank — armored frontline punch. Crushes infantry.",
  arty: "Siege Launcher — long-range splash artillery. Fragile. Needs Radar.",
  heavy: "Mastodon Tank — twin-cannon monster. Needs War Factory II.",
  spider: "Spider Drone — fast melee scout. Needs War Factory II.",
  himars: "HIMARS Launcher — ultra-long-range precision rocket artillery with heavy splash. Needs Radar.",
  spy: "Spy — disguised infiltration infantry. Auto-defenses ignore it; only powered Radar-tier sensors blow its cover for 15s. Walk into enemy buildings to SABOTAGE: power plants black out 30s, defenses disable 45s, Radar scrambles 30s, production queues wipe, refineries & HQs get looted. Needs Radar Tower.",
  ballistic: "Ballistic Missile TEL — mobile truck launching a long-range single-shot ballistic missile with massive splash. ONLY Anti-Nuke batteries can intercept it (80%, 18 tiles). Needs War Factory II.",
  railtank: "Aegis Railgun MBT — hyper-velocity electromagnetic main battle tank (Ground + AA). Needs War Factory II.",
  supplytruck: "Supply Convoy — mobile 500-pt Fuel & Ammo resupply truck for frontline armies",
  harvester: "Ore Harvester — collects ore; a full load is worth $1,125.",
  uav: "Reaper UCAV — reusable MALE hunter-killer recon & strike drone ($30M real-world class, 13-tile vision, Air + Ground).",
  shahed: "Delta Kamikaze — attritable $35K-class one-way attack drone; cheap mass saturation swarms vs bases.",
  ewdrone: "Jammer Drone — electronic warfare drone with an 85m counter-drone jamming aura & wide recon optics. Needs Radar Tower.",
  interceptor: "Interceptor — autonomous loyal-wingman fighter jet (1/3 the cost of crewed jets, Air + Ground, AA).",
  chopper: "Hornet Gunship — agile Air Force gunship (Air + Ground, AA).",
  a10: "A-10 Warthog — cost-effective armored CAS jet with GAU-8 30mm rotary cannon (BRRRT! 1.5× vs tanks & AA).",
  ac130: "AC-130 Gunship — heavy 4-turboprop flying artillery raining 105mm splash shells from high altitude.",
  bomber: "Tempest Bomber — heavy Air Force splash strike bomber vs ground & ships. Needs Tech Lab.",
  stealthbomber: "B-21 Stealth Bomber — apex strategic bomber: drops one MASSIVE gravity bomb per run, then a long rearm. Completely invisible unless the enemy has powered Radar or missile defenses. Needs Air Command II.",
  hypersonic: "Mach-9 Missile — one-way hypersonic glide missile that can cross the whole map (520 splash; Anti-Nuke 80% / Iron Dome 33% intercept!).",
  zeppelin: "Leviathan Airship — armored Air Force flying dreadnought with massive splash bombs. Needs Tech Lab.",
  usv: "Sea-Baby USV Drone — $250K-class stealth explosive drone boat; skims waves unseen to ram warships & docks.",
  gunboat: "Viper Hydrofoil — fast Navy patrol & anti-air (AA) picket craft.",
  destroyer: "Aegis Destroyer — versatile Navy warship with heavy cannons & anti-air (AA) defense.",
  sub: "Submarine — stealth torpedo boat; invisible until firing or spotted. Needs Radar Tower.",
  dreadnought: "Poseidon Cruiser — long-range Navy bombardment cruiser with splash cruise missiles. Needs Naval Shipyard II.",
  carrier: "Nimitz Drone Carrier — fleet flagship launching long-range drone strikes (Air + Ground, wide vision). Needs Naval Shipyard II.",
};

const MAP_PREVIEW_PALETTES: Record<
  MapId,
  { bg: string; grid: string; cliff: string; cliffEdge: string; water?: string; waterGlint?: string; accentGrid?: string }
> = {
  crossroads: { bg: "#2b3926", grid: "rgba(180,210,160,0.08)", cliff: "#5a6257", cliffEdge: "#768072" },
  fulda_gap: { bg: "#2b3926", grid: "rgba(180,210,160,0.08)", cliff: "#5a6257", cliffEdge: "#768072" }, // Steppe (olive)
  canyon: { bg: "#4a2c20", grid: "rgba(235,175,140,0.08)", cliff: "#82523c", cliffEdge: "#a16a50" }, // Canyon (rust)
  basin: { bg: "#28323c", grid: "rgba(170,200,225,0.08)", cliff: "#576574", cliffEdge: "#748494" }, // Alpine (slate)
  tundra: { bg: "#2e4656", grid: "rgba(210,240,255,0.1)", cliff: "#88b3ca", cliffEdge: "#b0d5e8" }, // Arctic (icy)
  fortress: { bg: "#4d3f2a", grid: "rgba(235,210,160,0.08)", cliff: "#85704f", cliffEdge: "#a38d68" }, // Desert (sandy)
  jungle: { bg: "#1c3828", grid: "rgba(150,225,175,0.08)", cliff: "#3e5e47", cliffEdge: "#567d61" }, // Jungle (emerald)
  islands: {
    bg: "#2b4a3e",
    grid: "rgba(165,225,205,0.08)",
    cliff: "#4a5c58",
    cliffEdge: "#68807b",
    water: "#1a5c7a",
    waterGlint: "rgba(130, 222, 255, 0.3)",
  }, // Riverland (emerald/water)
  oasis: { bg: "#574323", grid: "rgba(250,215,145,0.09)", cliff: "#947542", cliffEdge: "#b39259" }, // Sahara (golden)
  archipelago: {
    bg: "#3a5c36",
    grid: "rgba(185,235,195,0.08)",
    cliff: "#524942",
    cliffEdge: "#756a60",
    water: "#145d82",
    waterGlint: "rgba(138, 232, 255, 0.34)",
  }, // Pacific tropical ocean/atoll
  coastline: {
    bg: "#33424a",
    grid: "rgba(175,215,235,0.08)",
    cliff: "#4d5c66",
    cliffEdge: "#6c7f8c",
    water: "#154159",
    waterGlint: "rgba(145, 206, 230, 0.28)",
  }, // Stormy slate ocean/shore
  atlantis: {
    bg: "#b89652",
    grid: "rgba(255, 236, 178, 0.16)",
    cliff: "#2b7f92",
    cliffEdge: "#6bf2ff",
    water: "#0f8c9e",
    waterGlint: "rgba(136, 255, 248, 0.44)",
  }, // Mythic turquoise sea + golden-sand temple plaza
  shipwreck: {
    bg: "#343b3a",
    grid: "rgba(160, 190, 192, 0.08)",
    cliff: "#4f4640",
    cliffEdge: "#7d6858",
    water: "#13323e",
    waterGlint: "rgba(116, 178, 196, 0.25)",
  }, // Deep stormy slate-teal abyss + salvage sandbars
  volcano: {
    bg: "#211d20",
    grid: "rgba(255, 134, 62, 0.11)",
    cliff: "#7a2c16",
    cliffEdge: "#ff6e24",
    water: "#183847",
    waterGlint: "rgba(210, 232, 242, 0.34)",
  }, // Obsidian ash + fiery molten caldera rim + steaming sea border
  oilrig: {
    bg: "#4a5662",
    grid: "rgba(218, 234, 248, 0.14)",
    cliff: "#6a7885",
    cliffEdge: "#95a8ba",
    water: "#0f3764",
    waterGlint: "rgba(114, 190, 255, 0.3)",
  }, // Deep sapphire ocean + metallic steel platform decks
  cybergrid: {
    bg: "#101722",
    grid: "rgba(64, 230, 255, 0.28)",
    cliff: "#1d3145",
    cliffEdge: "#44e2ff",
    accentGrid: "rgba(64, 230, 255, 0.1)",
  }, // Sleek dark carbon orbital deck + glowing cyan circuits
  hormuz: {
    bg: "#8a6f46",
    grid: "rgba(255, 226, 170, 0.09)",
    cliff: "#7a684a",
    cliffEdge: "#a08a5e",
    water: "#0e5a76",
    waterGlint: "rgba(150, 226, 250, 0.3)",
  }, // Gulf Strait golden coasts + teal shipping channels
  delta: {
    bg: "#2e5a30",
    grid: "rgba(180, 240, 190, 0.08)",
    cliff: "#3c5c40",
    cliffEdge: "#5a7a56",
    water: "#1a6a50",
    waterGlint: "rgba(140, 235, 200, 0.3)",
  }, // Mekong Delta jungle greens + muddy braided rivers
  bering: {
    bg: "#6d8296",
    grid: "rgba(220, 240, 255, 0.1)",
    cliff: "#8cb4d0",
    cliffEdge: "#d2e8f8",
    water: "#155272",
    waterGlint: "rgba(160, 215, 245, 0.3)",
  }, // Polar Strait ice fields + steel-blue arctic water
  europa: {
    bg: "#2d4029",
    grid: "rgba(186, 220, 174, 0.08)",
    cliff: "#5e685f",
    cliffEdge: "#829184",
  }, // Iron Frontier (96x96 continental theater)
  pacific_theatre: {
    bg: "#345937",
    grid: "rgba(180, 238, 204, 0.08)",
    cliff: "#4e4740",
    cliffEdge: "#766c61",
    water: "#11668a",
    waterGlint: "rgba(130, 238, 255, 0.36)",
  },
  panama: {
    bg: "#345937",
    grid: "rgba(180, 238, 204, 0.08)",
    cliff: "#4e4740",
    cliffEdge: "#766c61",
    water: "#11668a",
    waterGlint: "rgba(130, 238, 255, 0.36)",
  },
  english_channel: {
    bg: "#345937",
    grid: "rgba(180, 238, 204, 0.08)",
    cliff: "#4e4740",
    cliffEdge: "#766c61",
    water: "#11668a",
    waterGlint: "rgba(130, 238, 255, 0.36)",
  }, // Coral Sea Theatre (96x96 grand ocean)
  arctic_front: {
    bg: "#334d5e",
    grid: "rgba(215, 242, 255, 0.11)",
    cliff: "#8db9d1",
    cliffEdge: "#c4e4f5",
    water: "#12344d",
    waterGlint: "rgba(176, 228, 255, 0.34)",
  }, // Polar Sea Front (96x96 arctic sea channels)
  megacontinent: {
    bg: "#314232",
    grid: "rgba(195, 224, 184, 0.08)",
    cliff: "#5c6158",
    cliffEdge: "#878f82",
    water: "#144b6d",
    waterGlint: "rgba(136, 212, 246, 0.3)",
  },
  persian_gulf: {
    bg: "#314232",
    grid: "rgba(195, 224, 184, 0.08)",
    cliff: "#5c6158",
    cliffEdge: "#878f82",
    water: "#144b6d",
    waterGlint: "rgba(136, 212, 246, 0.3)",
  }, // Eurasia Supertheater (128x128 twin continents & sea strait)
};

export type QualityPreset = "low" | "medium" | "high" | "ultra";

export interface GraphicsSettings {
  preset: QualityPreset;
  raytracing: boolean;
  contactShadows: boolean;
  bloom: boolean;
  dynamicRes: boolean;
  autoQuality: boolean;
}

export interface GpuInfo {
  backend: "WebGL2" | "WebGL";
  webgpuAvailable: boolean;
  webgpuAdapter: string;
  rendererName: string;
  vendor: string;
  maxTextureSize: number;
  cores: number;
  recommended: QualityPreset;
  appleSilicon?: boolean;
  isMac?: boolean;
}

export interface GraphicsStats {
  fps: number;
  frameMs: number;
  calls: number;
  triangles: number;
  dpr: number;
}

export interface GraphicsBridge {
  settings: GraphicsSettings;
  gpu: GpuInfo;
  stats: GraphicsStats;
  autoTier: number;
  applyPreset(p: QualityPreset): void;
  setOption(k: "raytracing" | "contactShadows" | "bloom" | "dynamicRes" | "autoQuality", v: boolean): void;
}

const GFX_PRESET_DESCS: Record<QualityPreset, string> = {
  low: "Laptop Fast — direct GPU render with zero post-FX for maximum battery & frame rate.",
  medium: "Balanced — HDR bloom, contact shadows & adaptive 60fps resolution scaling.",
  high: "Dedicated GPU — 2048px shadows & Screen-Space Raytracing (SSR) reflections.",
  ultra: "Full GPU Raytraced Reflections + Contact Shadows & AO + HDR Bloom at max render scale.",
};

function fmtPresetName(p: QualityPreset): string {
  return p === "ultra" ? "ULTRA RT" : p.toUpperCase();
}

function fmtTris(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "--";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return String(Math.round(n));
}

function fmtBoost(mult: number): string {
  return `×${Number(mult.toFixed(2))}`;
}

// Production items store remaining *work* in base ticks; the sim consumes that
// work at the current speed multiplier. Convert work back to whole sim ticks
// before displaying seconds, otherwise boosted/underpowered queues overstate
// or understate their real remaining time.
function fmtSimSeconds(ticks: number): string {
  return `${Number((ticks / 10).toFixed(1))}s`;
}

function fmtWorkTime(workTicks: number, speed = 1): string {
  const simTicks = Math.ceil(Math.max(0, workTicks) / speed - 1e-9);
  return fmtSimSeconds(simTicks);
}

const SHORT_BUILDING_NAMES: Record<BuildingKind, string> = {
  conyard: "ConYard",
  power: "Reactor",
  coalplant: "Coal Plant",
  fusion: "Fusion",
  refinery: "Refinery",
  supplyhub: "Supply Hub",
  barracks: "Barracks",
  barracks2: "Barracks II",
  radar: "Radar Tower",
  factory: "War Factory",
  factory2: "Factory II",
  airfield: "Air Command",
  airfield2: "Air Cmd II",
  shipyard: "Shipyard",
  shipyard2: "Shipyard II",
  techlab: "Tech Lab",
  satlink: "Def Satellite",
  turret: "Vulcan",
  sam: "Anti-Air",
  arc: "Arc Spire",
  irondome: "Iron Dome",
  lasertower: "Helios Laser",
  thaad: "Anti-Nuke",
  purifier: "Purifier",
  depot: "Depot",
  superweapon: "Nuke Silo",
  derrick: "Oil Derrick",
  coalmine: "Coal Mine",
};

const COMPACT_BUILDING_NAMES: Record<BuildingKind, string> = {
  conyard: "ConYard",
  power: "Reactor",
  coalplant: "Coal",
  fusion: "Fusion",
  refinery: "Refinery",
  supplyhub: "Supply",
  barracks: "Barracks",
  barracks2: "Bks II",
  radar: "Radar",
  factory: "Factory",
  factory2: "Factory II",
  airfield: "Air Cmd",
  airfield2: "Air II",
  shipyard: "Shipyard",
  shipyard2: "Ship II",
  techlab: "Tech Lab",
  satlink: "Def Sat",
  turret: "Vulcan",
  sam: "Anti-Air",
  arc: "Arc Spire",
  irondome: "Iron Dome",
  lasertower: "Laser",
  thaad: "Anti-Nuke",
  purifier: "Purifier",
  depot: "Depot",
  superweapon: "Nuke Silo",
  derrick: "Derrick",
  coalmine: "Coal Mine",
};

const UPGRADE_TARGET_TO_PATH = new Map(Object.values(UPGRADE_PATHS).map((p) => [p.to, p]));

function prereqsOf(k: BuildingKind): BuildingKind[] {
  if (k === "barracks2") return ["barracks", "radar"];
  if (k === "factory2") return ["techlab", "factory"];
  if (k === "airfield2") return ["airfield", "techlab"];
  if (k === "shipyard2") return ["shipyard", "techlab"];
  if (k === "satlink") return ["techlab"];
  return BUILDINGS[k]?.requires ?? [];
}

/**
 * Resolves the exact ordered list of missing buildings you must construct FIRST
 * (topological order, dependencies before dependents) to satisfy `reqs`.
 */
export function missingPrereqChain(reqs: BuildingKind[], has: (k: string) => boolean): BuildingKind[] {
  const out: BuildingKind[] = [];
  const seen = new Set<BuildingKind>();
  const visit = (k: BuildingKind) => {
    if (seen.has(k) || has(k)) return;
    seen.add(k);
    for (const dep of prereqsOf(k)) visit(dep);
    out.push(k);
  };
  for (const r of reqs) visit(r);
  return out;
}

function formatShortNeed(missing: BuildingKind[]): string {
  if (missing.length === 1) return `Need ${SHORT_BUILDING_NAMES[missing[0]]}`;
  return `Need ${missing.map((k) => COMPACT_BUILDING_NAMES[k]).join(" + ")}`;
}

function formatChainSteps(chain: BuildingKind[]): string[] {
  return chain.map((k) => {
    const up = UPGRADE_TARGET_TO_PATH.get(k);
    if (up) return `Upgrade ${BUILDING_NAMES[up.from]} → MKII`;
    return BUILDING_NAMES[k];
  });
}

const MCP_CONNECT_CMD = "claude mcp add --transport http open-alert https://open-alert.thapecroth.workers.dev/mcp";
const MCP_ARENA_PROMPT =
  "Use create_ai_arena on the open-alert MCP server to launch an AI-vs-AI match, give me the watch_url so I can spectate in 3D, and play using gym_obs & feature_maps!";
const MCP_JSON_CONFIG =
  '{ "mcpServers": { "open-alert": { "type": "http", "url": "https://open-alert.thapecroth.workers.dev/mcp" } } }';

function fmtClock(tick: number): string {
  const sec = Math.max(0, Math.floor(tick / 10));
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export class Hud {
  onReady: (r: boolean) => void = () => {};
  onStart: () => void = () => {};
  onRematch: () => void = () => {};
  onAddBot: (diff: BotDiff, profile: BotProfile) => void = () => {};
  onSetBotConfig: (id: string, diff?: BotDiff, profile?: BotProfile) => void = () => {};
  onKickBot: (id: string) => void = () => {};
  onTransferHost: (id: string) => void = () => {};
  onSetMap: (map: MapId) => void = () => {};
  onSetConfig: (cfg: Partial<GameConfig>) => void = () => {};
  onSetTeam: (team: number, id?: string) => void = () => {};
  onSetName: (name: string) => void = () => {};
  onResign: () => void = () => {};
  onChat: (text: string) => void = () => {};
  onBuild: (k: BuildingKind) => void = () => {};
  onBuildCancel: (cat?: BuildCategory, kind?: BuildingKind, awaiting?: boolean, index?: number) => void = () => {};
  onPlaceMode: (k: BuildingKind) => void = () => {};
  onTrain: (u: UnitKind) => void = () => {};
  onTrainCancel: (u?: UnitKind, cat?: ProdCat, index?: number) => void = () => {};
  onBuildBlocked?: (msg: string) => void;
  onMinimapNav: (x: number, y: number) => void = () => {};
  onMinimapPing: (x: number, y: number) => void = () => {};
  onMinimapOrder?: (x: number, y: number, shift: boolean) => boolean;
  onSuperweaponClick: () => void = () => {};
  onReconClick: () => void = () => {};
  onVerb: (v: "amove" | "patrol" | "hold" | "stop" | "sell" | "repair" | "bridge") => void = () => {};
  onUpgrade?: (id: number) => void;
  onEnterFpv?: (id: number) => void;
  onExitFpv?: () => void;
  onFilterSelection?: (kind: string) => void;
  onGroupClick?: (n: number, dbl: boolean) => void;
  onToggleWasd?: () => void;
  onTogglePause?: () => void;
  private pauseBtn: HTMLElement | null = null;
  private paused = false;
  onToggleMute?: () => void;
  onToggleMusic?: () => void;
  onSwitchLocal?: () => void;
  onRetryOnline?: () => void;
  onWatchAiBattle?: (map: MapId) => void;
  onToggleAutoCam?: () => void;
  onFocusCommander?: (slot: number) => void;
  onQuotaDetected?: () => void;

  private ready = false;
  private playing = false;
  private quotaExceeded = false;
  private currentRoomCode = "----";
  private watchPollTimer: ReturnType<typeof setInterval> | null = null;
  private watchFetching = false;
  private specCmdrSig = "";
  private icons = new Map<string, string>();
  private buildBtns = new Map<BuildingKind, HTMLButtonElement>();
  private trainBtns = new Map<UnitKind, HTMLButtonElement>();
  private trainGroupHeaders = new Map<"land" | "air" | "sea", HTMLElement>();
  private hoveredBtn: HTMLButtonElement | null = null;
  private lastBlockedToast = { msg: "", t: 0 };
  private minimap = el<HTMLCanvasElement>("minimap");
  private bridgeSet = new Set<number>();
  setBridges(tiles?: number[]) {
    this.bridgeSet = new Set(tiles ?? []);
  }
  private mmCtx = this.minimap.getContext("2d")!;
  private mmLast = 0;
  private mmW = MAP_W;
  private mmH = MAP_H;
  // static terrain layer cache — water/cliff/ore/bridge only re-raster when content changes
  private mmStatic: HTMLCanvasElement | null = null;
  private mmStaticSig = "";
  private pinged: { x: number; y: number; t: number } | null = null;
  private chatLines: string[] = [];
  private selSig = "";
  private groupSig = "";
  private lastGroupClick = { n: -1, t: 0 };
  private lastSubmittedName = "";
  private displayCredits = 0;
  private targetCredits = 0;
  private creditsInit = false;
  private spectating = false;
  private fpvMode = false;
  private fpvLastKind = "";
  private readyAwaiting: BuildingKind | null = null;
  private readyAwaitingDef: BuildingKind | null = null;
  private resignConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  private gfx: GraphicsBridge | null = null;
  private gfxLastMs = 0;

  constructor() {
    el("ready-btn").addEventListener("click", () => {
      this.ready = !this.ready;
      el("ready-btn").textContent = this.ready ? "UNREADY" : "READY";
      el("ready-btn").classList.toggle("on", this.ready);
      this.onReady(this.ready);
    });
    el("start-btn").addEventListener("click", () => this.onStart());
    el("rematch-btn").addEventListener("click", () => this.onRematch());
    el("addbot-btn")?.addEventListener("click", () => {
      const diff = ((document.getElementById("bot-diff") as HTMLSelectElement | null)?.value as BotDiff) ?? "normal";
      const profile =
        ((document.getElementById("bot-profile") as HTMLSelectElement | null)?.value as BotProfile) ?? "balanced";
      this.onAddBot(diff, profile);
    });
    (document.getElementById("cfg-credits") as HTMLSelectElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ startCredits: Number((e.target as HTMLSelectElement).value) });
    });
    (document.getElementById("cfg-speed") as HTMLSelectElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ gameSpeed: Number((e.target as HTMLSelectElement).value) });
    });
    (document.getElementById("cfg-sw") as HTMLInputElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ superweapons: (e.target as HTMLInputElement).checked });
    });
    (document.getElementById("cfg-crates") as HTMLInputElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ crates: (e.target as HTMLInputElement).checked });
    });
    (document.getElementById("cfg-derricks") as HTMLInputElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ derricks: (e.target as HTMLInputElement).checked });
    });
    (document.getElementById("cfg-fog") as HTMLInputElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ fog: (e.target as HTMLInputElement).checked });
    });
    (document.getElementById("cfg-logistics") as HTMLInputElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ logistics: (e.target as HTMLInputElement).checked });
    });
    const resignBtn = document.getElementById("resign-btn");
    resignBtn?.addEventListener("click", () => {
      if (!resignBtn.classList.contains("confirm")) {
        resignBtn.classList.add("confirm");
        resignBtn.textContent = "CONFIRM?";
        if (this.resignConfirmTimer) clearTimeout(this.resignConfirmTimer);
        this.resignConfirmTimer = setTimeout(() => {
          resignBtn.classList.remove("confirm");
          resignBtn.textContent = "RESIGN";
          this.resignConfirmTimer = null;
        }, 3500);
        return;
      }
      if (this.resignConfirmTimer) {
        clearTimeout(this.resignConfirmTimer);
        this.resignConfirmTimer = null;
      }
      resignBtn.classList.remove("confirm");
      resignBtn.textContent = "RESIGN";
      this.onResign();
    });
    this.pauseBtn = document.getElementById("pause-btn");
    this.pauseBtn?.addEventListener("click", () => this.onTogglePause?.());
    const copy = (e: Event) => {
      navigator.clipboard?.writeText(location.href).catch(() => {});
      this.toast("invite link copied", true);
      const btn = e.currentTarget as HTMLElement | null;
      if (btn && !btn.dataset.origLabel) {
        btn.dataset.origLabel = btn.textContent ?? "COPY LINK";
        btn.textContent = "COPIED ✓";
        setTimeout(() => {
          if (btn.dataset.origLabel) {
            btn.textContent = btn.dataset.origLabel;
            delete btn.dataset.origLabel;
          }
        }, 1800);
      }
    };
    el("copy-link").addEventListener("click", copy);
    el("copy-link2").addEventListener("click", copy);
    document.getElementById("ready-pill")?.addEventListener("click", () => {
      if (this.readyAwaiting) this.onPlaceMode(this.readyAwaiting);
    });
    document.getElementById("ready-pill")?.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.readyAwaiting) this.onBuildCancel("structure", this.readyAwaiting, true);
    });
    document.getElementById("ready-def-pill")?.addEventListener("click", () => {
      if (this.readyAwaitingDef) this.onPlaceMode(this.readyAwaitingDef);
    });
    document.getElementById("ready-def-pill")?.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.readyAwaitingDef) this.onBuildCancel("defense", this.readyAwaitingDef, true);
    });
    el("help-btn")?.addEventListener("click", () => el("help").classList.toggle("hidden"));
    el("help-close")?.addEventListener("click", () => el("help").classList.add("hidden"));
    document.getElementById("gfx-btn")?.addEventListener("click", () => this.toggleGraphicsPanel());
    document.getElementById("lobby-gfx-btn")?.addEventListener("click", () => this.openGraphicsPanel());
    document.getElementById("solo-local-btn")?.addEventListener("click", () => this.onSwitchLocal?.());
    document.getElementById("quota-retry-btn")?.addEventListener("click", () => this.onRetryOnline?.());
    document.getElementById("lobby-watch-btn")?.addEventListener("click", () => this.openWatchPanel());
    document.getElementById("topbar-watch-btn")?.addEventListener("click", () => this.openWatchPanel());
    document.getElementById("spec-watch-btn")?.addEventListener("click", () => this.openWatchPanel());
    document.getElementById("watch-close")?.addEventListener("click", () => this.closeWatchPanel());
    document.getElementById("watch-refresh")?.addEventListener("click", () => this.refreshWatchRooms(true));
    document.getElementById("watch-panel")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) this.closeWatchPanel();
    });
    document.getElementById("spec-autocam")?.addEventListener("click", () => this.onToggleAutoCam?.());
    const watchAiMap = document.getElementById("watch-ai-map") as HTMLSelectElement | null;
    if (watchAiMap) {
      watchAiMap.innerHTML = "";
      for (const m of MAP_LIST) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `${m.name} · ${m.biome}${m.naval ? " ⚓" : ""}`;
        watchAiMap.appendChild(opt);
      }
    }
    document.getElementById("watch-ai-btn")?.addEventListener("click", () => {
      const map = ((document.getElementById("watch-ai-map") as HTMLSelectElement | null)?.value as MapId) ?? "crossroads";
      this.onWatchAiBattle?.(map);
    });
    document.getElementById("copy-mcp-btn")?.addEventListener("click", (e) => {
      this.copyWithFeedback(e.currentTarget as HTMLElement | null, MCP_CONNECT_CMD, "Claude Code MCP command copied");
    });
    document.getElementById("lobby-mcp-btn")?.addEventListener("click", () => this.openMcpPanel());
    document.getElementById("topbar-mcp-btn")?.addEventListener("click", () => this.openMcpPanel());
    document.getElementById("mcp-close")?.addEventListener("click", () => this.closeMcpPanel());
    document.getElementById("mcp-panel")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) this.closeMcpPanel();
    });
    document.getElementById("mcp-copy-cli")?.addEventListener("click", (e) => {
      this.copyWithFeedback(e.currentTarget as HTMLElement | null, MCP_CONNECT_CMD, "Claude Code MCP command copied");
    });
    document.getElementById("mcp-copy-room")?.addEventListener("click", (e) => {
      this.copyWithFeedback(e.currentTarget as HTMLElement | null, this.getMcpRoomPrompt(), "Room AI prompt copied");
    });
    document.getElementById("mcp-copy-arena")?.addEventListener("click", (e) => {
      this.copyWithFeedback(e.currentTarget as HTMLElement | null, MCP_ARENA_PROMPT, "AI Arena prompt copied");
    });
    document.getElementById("mcp-copy-json")?.addEventListener("click", (e) => {
      this.copyWithFeedback(e.currentTarget as HTMLElement | null, MCP_JSON_CONFIG, "MCP JSON config copied");
    });
    document.getElementById("mcp-open-watch")?.addEventListener("click", () => {
      this.closeMcpPanel();
      this.openWatchPanel();
    });
    document.getElementById("gfx-close")?.addEventListener("click", () => this.closeGraphicsPanel());
    document.getElementById("gfx-panel")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) this.closeGraphicsPanel();
    });
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.code !== "Escape") return;
        const mcpPanel = document.getElementById("mcp-panel");
        if (mcpPanel && !mcpPanel.classList.contains("hidden")) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.closeMcpPanel();
          return;
        }
        const watchPanel = document.getElementById("watch-panel");
        if (watchPanel && !watchPanel.classList.contains("hidden")) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.closeWatchPanel();
          return;
        }
        const panel = document.getElementById("gfx-panel");
        if (panel && !panel.classList.contains("hidden")) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.closeGraphicsPanel();
        }
      },
      true,
    );
    for (const btn of document.querySelectorAll<HTMLButtonElement>(".gfx-preset[data-preset]")) {
      btn.addEventListener("click", () => {
        const preset = btn.dataset.preset as QualityPreset | undefined;
        if (!preset || !this.gfx) return;
        this.gfx.applyPreset(preset);
        this.syncGraphicsControls();
        this.updateGraphicsTelemetry(true);
      });
    }
    const wireGfxOpt = (id: string, key: "raytracing" | "contactShadows" | "bloom" | "dynamicRes" | "autoQuality") => {
      const inp = document.getElementById(id) as HTMLInputElement | null;
      inp?.addEventListener("change", () => {
        if (!this.gfx) return;
        this.gfx.setOption(key, inp.checked);
        this.syncGraphicsControls();
        this.updateGraphicsTelemetry(true);
      });
    };
    wireGfxOpt("gfx-rt", "raytracing");
    wireGfxOpt("gfx-ao", "contactShadows");
    wireGfxOpt("gfx-bloom", "bloom");
    wireGfxOpt("gfx-dyn", "dynamicRes");
    wireGfxOpt("gfx-auto", "autoQuality");
    el("wasd-btn")?.addEventListener("click", () => this.onToggleWasd?.());
    document.getElementById("mute-btn")?.addEventListener("click", () => this.onToggleMute?.());
    document.getElementById("music-btn")?.addEventListener("click", () => this.onToggleMusic?.());
    document.getElementById("sw-hud")?.addEventListener("click", () => this.onSuperweaponClick());
    document.getElementById("recon-hud")?.addEventListener("click", () => this.onReconClick());
    document.getElementById("fpv-exit")?.addEventListener("click", () => this.onExitFpv?.());

    // Lobby callsign input
    const nameInput = document.getElementById("name-input") as HTMLInputElement | null;
    if (nameInput) {
      const commitName = () => {
        const clean = nameInput.value.trim().slice(0, 20);
        if (!clean) {
          nameInput.value = this.lastSubmittedName;
          return;
        }
        nameInput.value = clean;
        if (clean !== this.lastSubmittedName) {
          this.lastSubmittedName = clean;
          localStorage.setItem("oa-name", clean);
          this.onSetName(clean);
        }
      };
      nameInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          commitName();
          nameInput.blur();
        } else if (e.key === "Escape") {
          nameInput.value = this.lastSubmittedName;
          nameInput.blur();
        }
      });
      nameInput.addEventListener("blur", commitName);
    }

    // Lobby map selector populated from MAP_LIST
    const mapSelect = document.getElementById("map-select") as HTMLSelectElement | null;
    if (mapSelect) {
      mapSelect.innerHTML = "";
      for (const m of MAP_LIST) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `${m.name} · ${m.biome}${m.naval ? " ⚓" : ""}`;
        mapSelect.appendChild(opt);
      }
      mapSelect.addEventListener("change", () => {
        const map = mapSelect.value as MapId;
        this.updateMapDesc(map);
        this.onSetMap(map);
      });
      this.updateMapDesc(MAP_LIST[0].id);
    }

    for (const v of ["amove", "patrol", "hold", "stop", "sell", "repair", "bridge"] as const) {
      el(`verb-${v}`)?.addEventListener("click", () => this.onVerb(v));
    }

    // Chat input
    const chatInput = el<HTMLInputElement>("chat-input");
    chatInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        if (chatInput.value.trim()) {
          this.onChat(chatInput.value.trim().slice(0, 120));
          chatInput.value = "";
        }
        chatInput.blur();
      } else if (e.key === "Escape") {
        chatInput.blur();
      }
    });
    el("chat-box").addEventListener("click", () => chatInput.focus());

    // Build sidebar buttons once (parallel Structures + Defenses lists)
    const addBuildBtn = (container: HTMLElement, kind: BuildingKind) => {
      const d = BUILDINGS[kind];
      const cat = buildCategoryOf(kind);
      const b = document.createElement("button");
      b.className = "sbtn";
      b.dataset.kind = kind;
      b.dataset.cat = cat;
      b.title = this.buildTooltip(kind);
      b.innerHTML = `<span class="icon" data-kind="${kind}"></span><span class="slabel"><span class="sname">${BUILDING_NAMES[kind]}</span><span class="req-tag"></span></span><span class="cost">$${d.cost}</span><span class="btime">${d.buildTicks / 10}s</span><span class="prog"></span><span class="qcount hidden"></span><span class="qpos hidden"></span><span class="owncount hidden"></span>`;
      b.addEventListener("click", () => this.clickBuild(kind));
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (b.classList.contains("ready")) this.onBuildCancel(cat, kind, true);
        else if (b.dataset.busy === "1") this.onBuildCancel(cat, kind);
      });
      container.appendChild(b);
      this.buildBtns.set(kind, b);
    };
    const bl = el("build-list");
    for (const kind of BUILD_ORDER) addBuildBtn(bl, kind);
    const dl = document.getElementById("defense-list");
    if (dl) {
      for (const kind of DEFENSE_ORDER) addBuildBtn(dl, kind);
    }

    const tl = el("train-list");
    const groupLabels: Record<"land" | "air" | "sea", string> = {
      land: "LAND",
      air: "AIR FORCE",
      sea: "NAVY",
    };
    let curGroup: "land" | "air" | "sea" | null = null;
    for (const { unit, label: l, group } of TRAIN_ORDER) {
      if (group !== curGroup) {
        curGroup = group;
        const sep = document.createElement("div");
        sep.className = "sub-title";
        sep.dataset.group = group;
        sep.textContent = groupLabels[group];
        tl.appendChild(sep);
        this.trainGroupHeaders.set(group, sep);
      }
      const d = UNITS[unit];
      const b = document.createElement("button");
      b.className = "sbtn";
      b.dataset.unit = unit;
      b.title = `${TOOLTIPS[unit] ?? l} · ${d.buildTicks / 10}s to train · Shift+click = ×5`;
      b.innerHTML = `<span class="icon" data-kind="${unit}"></span><span class="slabel"><span class="sname">${l}</span><span class="req-tag"></span></span><span class="cost">$${d.cost}</span><span class="btime">${d.buildTicks / 10}s</span><span class="prog"></span><span class="qcount hidden"></span><span class="qpos hidden"></span>`;
      b.addEventListener("click", (e) => {
        const count = e.shiftKey ? 5 : 1;
        for (let i = 0; i < count; i++) this.onTrain(unit);
      });
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.onTrainCancel(unit);
      });
      tl.appendChild(b);
      this.trainBtns.set(unit, b);
    }

    // Sidebar tech-chain inspector + click-on-locked feedback (works on disabled buttons too!)
    const sidebar = el("sidebar");
    const inSideInfo = (x: number, y: number) => {
      const info = document.getElementById("side-info");
      if (!info || info.classList.contains("hidden")) return false;
      const ir = info.getBoundingClientRect();
      return x >= ir.left && x <= ir.right && y >= ir.top && y <= ir.bottom;
    };
    sidebar.addEventListener("pointermove", (e) => {
      if (inSideInfo(e.clientX, e.clientY)) return;
      const btn = this.findSidebarBtnAt(e.clientX, e.clientY);
      if (btn) this.showSideInfo(btn);
      else this.hideSideInfo();
    });
    sidebar.addEventListener("pointerleave", () => this.hideSideInfo());
    sidebar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || inSideInfo(e.clientX, e.clientY)) return;
      const btn = this.findSidebarBtnAt(e.clientX, e.clientY);
      if (!btn || !btn.disabled) return;
      this.showSideInfo(btn);
      const reason = btn.dataset.reason;
      if (!reason) return;
      const now = performance.now();
      if (this.lastBlockedToast.msg !== reason || now - this.lastBlockedToast.t > 280) {
        this.lastBlockedToast = { msg: reason, t: now };
        this.toast(reason);
        this.onBuildBlocked?.(reason);
      }
    });

    // Minimap navigation, orders & pings
    const nav = (e: PointerEvent) => {
      const r = this.minimap.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * this.mmW;
      const y = ((e.clientY - r.top) / r.height) * this.mmH;
      this.onMinimapNav(x, y);
    };
    let mmDrag = false;
    this.minimap.addEventListener("pointerdown", (e) => {
      if (e.button === 2) {
        const r = this.minimap.getBoundingClientRect();
        const x = Math.max(0.5, Math.min(this.mmW - 0.5, ((e.clientX - r.left) / r.width) * this.mmW));
        const y = Math.max(0.5, Math.min(this.mmH - 0.5, ((e.clientY - r.top) / r.height) * this.mmH));
        if (!e.altKey && this.onMinimapOrder?.(x, y, e.shiftKey)) return;
        this.onMinimapPing(x, y);
        return;
      }
      mmDrag = true;
      nav(e);
    });
    this.minimap.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("pointermove", (e) => mmDrag && nav(e));
    window.addEventListener("pointerup", () => (mmDrag = false));
  }

  setMapSize(w: number, h: number) {
    this.mmW = w > 0 ? w : MAP_W;
    this.mmH = h > 0 ? h : MAP_H;
  }

  private updateMapDesc(mapId: MapId) {
    const d = document.getElementById("map-desc");
    if (d) {
      const info = MAP_LIST.find((m) => m.id === mapId);
      d.textContent = info ? info.desc : "";
    }
    this.drawMapPreview(mapId);
  }

  drawMapPreview(mapId: MapId) {
    const canvas = document.getElementById("map-preview") as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const pal = MAP_PREVIEW_PALETTES[mapId] ?? MAP_PREVIEW_PALETTES.crossroads;
    const layout = getMapLayout(mapId);
    const mw = layout.w || MAP_W;
    const mh = layout.h || MAP_H;
    const sx = w / mw;
    const sy = h / mh;
    const s = Math.min(sx, sy);

    // Biome-tinted terrain background
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);

    // Navigable ocean / river water tiles with subtle wave glints
    const cw = Math.max(1, Math.ceil(sx));
    const ch = Math.max(1, Math.ceil(sy));
    if (layout.water.length) {
      ctx.fillStyle = pal.water ?? "#19587a";
      for (let i = 0; i < layout.water.length; i++) {
        const [wx, wy] = layout.water[i];
        ctx.fillRect(wx * sx, wy * sy, cw, ch);
      }
      ctx.fillStyle = pal.waterGlint ?? "rgba(130, 222, 255, 0.3)";
      for (let i = 0; i < layout.water.length; i++) {
        const [wx, wy] = layout.water[i];
        if (((wx * 13 + wy * 29) & 15) === 0) {
          ctx.fillRect(wx * sx, wy * sy, Math.max(1.5, sx * 1.15), Math.max(1, sy * 0.45));
        }
      }
    }

    // Optional fine circuit sub-grid (e.g. Cybergrid orbital deck)
    const qStepX = Math.max(16, Math.round(mw / 4));
    const qStepY = Math.max(16, Math.round(mh / 4));
    if (pal.accentGrid) {
      ctx.strokeStyle = pal.accentGrid;
      ctx.lineWidth = 1;
      for (let t = 8; t < mw; t += 8) {
        if (t % qStepX === 0) continue;
        const p = Math.round(t * sx) + 0.5;
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, h);
        ctx.stroke();
      }
      for (let t = 8; t < mh; t += 8) {
        if (t % qStepY === 0) continue;
        const p = Math.round(t * sy) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, p);
        ctx.lineTo(w, p);
        ctx.stroke();
      }
    }

    // Subtle quadrant tactical grid
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1;
    for (let t = qStepX; t < mw; t += qStepX) {
      const p = Math.round(t * sx) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, h);
      ctx.stroke();
    }
    for (let t = qStepY; t < mh; t += qStepY) {
      const p = Math.round(t * sy) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(w, p);
      ctx.stroke();
    }

    // Center gold ore blob + bonus extraOre zones
    const drawOreBlob = (cx: number, cy: number, rTiles: number) => {
      const px = cx * sx;
      const py = cy * sy;
      const pr = Math.max(2.4, rTiles * s);
      ctx.fillStyle = "rgba(255, 196, 61, 0.28)";
      ctx.beginPath();
      ctx.arc(px, py, pr * 1.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e0ae34";
      ctx.beginPath();
      ctx.arc(px, py, pr * 0.88, 0, Math.PI * 2);
      ctx.fill();
    };
    drawOreBlob(mw / 2, mh / 2, mw >= 96 ? 4.4 : 3.6);
    if (layout.extraOre) {
      for (const [ox, oy, or] of layout.extraOre) {
        drawOreBlob(ox, oy, or);
      }
    }

    // Impassable cliff mesas / rock outcrops
    ctx.fillStyle = pal.cliff;
    for (let i = 0; i < layout.cliffs.length; i++) {
      const [cx, cy] = layout.cliffs[i];
      ctx.fillRect(cx * sx, cy * sy, cw, ch);
    }
    ctx.fillStyle = pal.cliffEdge;
    for (let i = 0; i < layout.cliffs.length; i++) {
      const [cx, cy] = layout.cliffs[i];
      ctx.fillRect(cx * sx, cy * sy, cw, Math.max(1, sy * 0.4));
    }

    // Creative map landmarks & ocean artifacts
    if (layout.artifacts?.length) {
      for (const art of layout.artifacts) {
        const ax = art.x * sx;
        const ay = art.y * sy;
        const sc = art.scale ?? 1;
        if (art.kind === "shipwreck") {
          ctx.save();
          ctx.translate(ax, ay);
          ctx.rotate(art.rot ?? 0);
          const len = Math.max(5.5, 4.6 * sc);
          const wid = Math.max(2.2, 1.9 * sc);
          ctx.beginPath();
          ctx.moveTo(len * 0.6, 0);
          ctx.lineTo(-len * 0.45, -wid * 0.55);
          ctx.lineTo(-len * 0.55, 0);
          ctx.lineTo(-len * 0.45, wid * 0.55);
          ctx.closePath();
          ctx.fillStyle = "#7c4732";
          ctx.fill();
          ctx.strokeStyle = "#b56945";
          ctx.lineWidth = 0.8;
          ctx.stroke();
          ctx.restore();
        } else if (art.kind === "obelisk") {
          const r = 2.6 * Math.min(1.3, sc);
          ctx.beginPath();
          ctx.moveTo(ax, ay - r);
          ctx.lineTo(ax + r * 0.85, ay);
          ctx.lineTo(ax, ay + r);
          ctx.lineTo(ax - r * 0.85, ay);
          ctx.closePath();
          ctx.fillStyle = "#48f4ff";
          ctx.fill();
          ctx.strokeStyle = "#08242e";
          ctx.lineWidth = 0.9;
          ctx.stroke();
        } else if (art.kind === "seagate") {
          ctx.save();
          ctx.translate(ax, ay);
          ctx.rotate(art.rot ?? 0);
          const span = 4.2 * Math.min(1.35, sc);
          ctx.strokeStyle = "#3ceeff";
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(-span, 0);
          ctx.lineTo(span, 0);
          ctx.stroke();
          ctx.fillStyle = "#c8ffff";
          ctx.fillRect(-span - 1, -1.2, 2.2, 2.4);
          ctx.fillRect(span - 1.2, -1.2, 2.2, 2.4);
          ctx.restore();
        } else if (art.kind === "lava_vent") {
          const r = 3.2 * Math.min(1.25, sc);
          ctx.fillStyle = "rgba(255, 92, 24, 0.45)";
          ctx.beginPath();
          ctx.arc(ax, ay, r * 1.45, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#ff7a1f";
          ctx.beginPath();
          ctx.arc(ax, ay, r * 0.85, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#ffe680";
          ctx.beginPath();
          ctx.arc(ax, ay, Math.max(1.1, r * 0.4), 0, Math.PI * 2);
          ctx.fill();
        } else if (art.kind === "oilrig_tower") {
          const sz = Math.max(4.4, 3.8 * sc);
          ctx.fillStyle = "#ffc933";
          ctx.fillRect(ax - sz / 2, ay - sz / 2, sz, sz);
          ctx.strokeStyle = "#121a22";
          ctx.lineWidth = 1;
          ctx.strokeRect(ax - sz / 2, ay - sz / 2, sz, sz);
          ctx.fillStyle = "#121a22";
          ctx.fillRect(ax - 0.8, ay - 0.8, 1.6, 1.6);
        } else if (art.kind === "lighthouse") {
          ctx.fillStyle = "rgba(255, 228, 102, 0.36)";
          ctx.beginPath();
          ctx.arc(ax, ay, 3.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#ffe570";
          ctx.beginPath();
          ctx.arc(ax, ay, 2.0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(ax, ay, 0.9, 0, Math.PI * 2);
          ctx.fill();
        } else if (art.kind === "monolith") {
          const r = 3.0 * Math.min(1.25, sc);
          ctx.fillStyle = "rgba(64, 232, 255, 0.28)";
          ctx.beginPath();
          ctx.arc(ax, ay, r * 1.35, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(ax, ay - r);
          ctx.lineTo(ax + r, ay);
          ctx.lineTo(ax, ay + r);
          ctx.lineTo(ax - r, ay);
          ctx.closePath();
          ctx.fillStyle = "#42ecff";
          ctx.fill();
          ctx.strokeStyle = "#081420";
          ctx.lineWidth = 0.9;
          ctx.stroke();
        } else if (art.kind === "seastack") {
          const r = 2.4 * Math.min(1.3, sc);
          ctx.fillStyle = "#364047";
          ctx.beginPath();
          ctx.arc(ax, ay, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#697982";
          ctx.beginPath();
          ctx.arc(ax - 0.5, ay - 0.5, r * 0.5, 0, Math.PI * 2);
          ctx.fill();
        } else if (art.kind === "buoy") {
          ctx.fillStyle = "#ff6844";
          ctx.beginPath();
          ctx.arc(ax, ay, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Neutral Oil Derricks (amber diamond markers)
    const dRad = mw >= 96 ? 3.4 : 4;
    for (const [dx, dy] of layout.derricks) {
      const mx = (dx + 1) * sx;
      const my = (dy + 1) * sy;
      ctx.beginPath();
      ctx.moveTo(mx, my - dRad);
      ctx.lineTo(mx + dRad, my);
      ctx.lineTo(mx, my + dRad);
      ctx.lineTo(mx - dRad, my);
      ctx.closePath();
      ctx.fillStyle = "#ffc43d";
      ctx.fill();
      ctx.strokeStyle = "#0b1118";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Neutral Coal Mines (slate-gold diamond markers)
    if (layout.coalmines?.length) {
      for (const [cx, cy] of layout.coalmines) {
        const mx = (cx + 1) * sx;
        const my = (cy + 1) * sy;
        ctx.beginPath();
        ctx.moveTo(mx, my - dRad);
        ctx.lineTo(mx + dRad, my);
        ctx.lineTo(mx, my + dRad);
        ctx.lineTo(mx - dRad, my);
        ctx.closePath();
        ctx.fillStyle = "#525e68";
        ctx.fill();
        ctx.strokeStyle = "#e6b84c";
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }

    // All 8 perimeter player spawn dots (proportional to layout.w x layout.h)
    const spawns = getSpawns(mw, mh);
    const spR = mw >= 96 ? 3.1 : 3.4;
    for (let i = 0; i < spawns.length; i++) {
      const sp = spawns[i];
      const px = (sp.x + 1.5) * sx;
      const py = (sp.y + 1.5) * sy;
      ctx.beginPath();
      ctx.arc(px, py, spR, 0, Math.PI * 2);
      ctx.fillStyle = PLAYER_COLORS[i] ?? "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#0b1118";
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }

    // Subtle inset tactical frame
    ctx.strokeStyle = "rgba(180, 220, 240, 0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  setInitialName(name: string) {
    this.lastSubmittedName = name;
    const inp = document.getElementById("name-input") as HTMLInputElement | null;
    if (inp && document.activeElement !== inp) inp.value = name;
  }

  setAudioState(muted: boolean, musicOn: boolean) {
    const mb = document.getElementById("mute-btn");
    if (mb) {
      mb.textContent = muted ? "SFX: OFF" : "SFX";
      mb.classList.toggle("on", !muted);
    }
    const bgm = document.getElementById("music-btn");
    if (bgm) {
      bgm.textContent = musicOn ? "BGM" : "BGM: OFF";
      bgm.classList.toggle("on", musicOn && !muted);
    }
  }

  resetMatch() {
    this.creditsInit = false;
    this.displayCredits = 0;
    this.targetCredits = 0;
    this.spectating = false;
    this.playing = false;
    this.fpvMode = false;
    this.groupSig = "";
    this.specCmdrSig = "";
    this.readyAwaiting = null;
    this.readyAwaitingDef = null;
    document.getElementById("ready-pill")?.classList.add("hidden");
    document.getElementById("ready-def-pill")?.classList.add("hidden");
    document.getElementById("spec-controls")?.classList.add("hidden");
    this.fpvLastKind = "";
    this.selSig = "";
    this.updateClock(0);
    this.hideHoverTip();
    this.hideSideInfo();
    document.getElementById("fpv-hud")?.classList.add("hidden");
    const sw = document.getElementById("sw-hud");
    if (sw) sw.classList.add("hidden");
    const recon = document.getElementById("recon-hud");
    if (recon) recon.classList.add("hidden");
    const boost = document.getElementById("prod-boost");
    if (boost) boost.classList.add("hidden");
  }

  setQuotaExceeded(exceeded: boolean) {
    this.quotaExceeded = exceeded;
    document.getElementById("quota-banner")?.classList.toggle("hidden", !exceeded);
    document.getElementById("watch-quota-pill")?.classList.toggle("hidden", !exceeded);
  }

  openWatchPanel() {
    const panel = document.getElementById("watch-panel");
    if (!panel) return;
    panel.classList.remove("hidden");
    document.getElementById("watch-quota-pill")?.classList.toggle("hidden", !this.quotaExceeded);
    void this.refreshWatchRooms(true);
    if (this.watchPollTimer) clearInterval(this.watchPollTimer);
    this.watchPollTimer = setInterval(() => {
      void this.refreshWatchRooms(false);
    }, 5000);
  }

  closeWatchPanel() {
    document.getElementById("watch-panel")?.classList.add("hidden");
    if (this.watchPollTimer) {
      clearInterval(this.watchPollTimer);
      this.watchPollTimer = null;
    }
  }

  private getMcpRoomPrompt(): string {
    return `Join Open Alert room "${this.currentRoomCode}" as "Claude" using the open-alert MCP tools (get_game_state returns the exact RL Gym gym_obs), build a base and army, and play to win!`;
  }

  private syncMcpRoomPrompt() {
    const promptEl = document.getElementById("mcp-room-prompt");
    if (promptEl) promptEl.textContent = this.getMcpRoomPrompt();
    const badgeEl = document.getElementById("mcp-room-badge");
    if (badgeEl) badgeEl.textContent = `ROOM ${this.currentRoomCode}`;
  }

  private copyWithFeedback(btn: HTMLElement | null, text: string, toastMsg: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
    this.toast(toastMsg, true);
    if (btn && !btn.dataset.origLabel) {
      btn.dataset.origLabel = btn.textContent ?? "COPY";
      btn.textContent = "COPIED ✓";
      setTimeout(() => {
        if (btn.dataset.origLabel) {
          btn.textContent = btn.dataset.origLabel;
          delete btn.dataset.origLabel;
        }
      }, 1800);
    }
  }

  openMcpPanel() {
    const panel = document.getElementById("mcp-panel");
    if (!panel) return;
    this.syncMcpRoomPrompt();
    panel.classList.remove("hidden");
  }

  closeMcpPanel() {
    document.getElementById("mcp-panel")?.classList.add("hidden");
  }

  async refreshWatchRooms(manual = false) {
    if (this.watchFetching) return;
    const panel = document.getElementById("watch-panel");
    if (!panel || panel.classList.contains("hidden")) return;
    this.watchFetching = true;
    const refreshBtn = document.getElementById("watch-refresh") as HTMLButtonElement | null;
    if (manual && refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "SYNCING…";
    }
    try {
      const apiBase = location.port === "5173" ? "http://localhost:8787" : "";
      const res = await fetch(`${apiBase}/api/rooms`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { rooms?: RoomSummary[]; quotaExceeded?: boolean };
      if (data.quotaExceeded) {
        this.setQuotaExceeded(true);
        this.onQuotaDetected?.();
      }
      this.renderWatchRooms(Array.isArray(data.rooms) ? data.rooms : []);
    } catch {
      const list = document.getElementById("watch-list");
      if (list && !list.children.length) {
        this.renderWatchRooms([]);
      }
    } finally {
      this.watchFetching = false;
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "REFRESH";
      }
    }
  }

  private renderWatchRooms(rooms: RoomSummary[]) {
    const summary = document.getElementById("watch-summary");
    const list = document.getElementById("watch-list");
    const liveCount = rooms.filter((r) => r.phase === "playing").length;
    const totalPlayers = rooms.reduce((sum, r) => sum + Math.max(0, r.players || 0), 0);
    const totalUnits = rooms.reduce((sum, r) => sum + Math.max(0, r.ents || 0), 0);
    if (summary) {
      summary.textContent = `${liveCount} Live · ${totalPlayers} ${totalPlayers === 1 ? "Player" : "Players"} · ${totalUnits} ${totalUnits === 1 ? "Unit" : "Units"}`;
    }
    if (!list) return;
    list.innerHTML = "";
    if (!rooms.length) {
      const empty = document.createElement("div");
      empty.className = "watch-empty";
      empty.textContent =
        "No live online matches right now — start a match or click WATCH LIVE AI BATTLE above to spectate a 3-way AI war!";
      list.appendChild(empty);
      return;
    }

    const phaseOrder: Record<RoomSummary["phase"], number> = { playing: 0, lobby: 1, ended: 2 };
    const sorted = [...rooms].sort((a, b) => {
      const po = (phaseOrder[a.phase] ?? 3) - (phaseOrder[b.phase] ?? 3);
      if (po !== 0) return po;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });

    for (const r of sorted) {
      const card = document.createElement("div");
      const isLive = r.phase === "playing";
      const isLobby = r.phase === "lobby";
      card.className = `watch-room-card${isLive ? " live" : ""}`;

      const top = document.createElement("div");
      top.className = "wr-top";
      const status = document.createElement("span");
      status.className = `wr-status ${isLive ? "live" : isLobby ? "lobby" : "ended"}`;
      status.innerHTML = isLive
        ? '<span class="wr-dot">●</span> LIVE'
        : isLobby
          ? "○ LOBBY"
          : "■ ENDED";
      const code = document.createElement("span");
      code.className = "wr-code";
      code.textContent = `ROOM ${r.room}`;
      const clock = document.createElement("span");
      clock.className = "wr-clock";
      clock.textContent = fmtClock(r.tick ?? 0);
      top.append(status, code, clock);

      const mapInfo = MAP_LIST.find((m) => m.id === r.map);
      const mapEl = document.createElement("div");
      mapEl.className = "wr-map";
      mapEl.textContent = mapInfo
        ? `${mapInfo.name} · ${mapInfo.biome}${mapInfo.naval ? " ⚓" : ""}`
        : String(r.map);

      const cmdrs = document.createElement("div");
      cmdrs.className = "wr-cmdrs";
      const namesText = r.names?.length ? r.names.join(", ") : `${r.players} ${r.players === 1 ? "player" : "players"}`;
      cmdrs.textContent = namesText;
      cmdrs.title = namesText;

      const foot = document.createElement("div");
      foot.className = "wr-foot";
      const meta = document.createElement("span");
      meta.className = "wr-meta";
      const unitCount = Math.max(0, r.ents ?? 0);
      const specPart = (r.spectators ?? 0) > 0 ? ` · ${r.spectators} watching` : "";
      meta.textContent = `${unitCount} ${unitCount === 1 ? "unit" : "units"}${specPart}`;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wr-join";
      btn.textContent = "SPECTATE LIVE";
      btn.addEventListener("click", () => {
        location.href = `/?room=${encodeURIComponent(r.room)}&spectate=1`;
      });
      foot.append(meta, btn);

      card.append(top, mapEl, cmdrs, foot);
      list.appendChild(card);
    }
  }

  setAutoCamState(on: boolean) {
    const btn = document.getElementById("spec-autocam");
    if (!btn) return;
    btn.textContent = on ? "AUTO-CAM: ON" : "AUTO-CAM: OFF";
    btn.classList.toggle("on", on);
  }

  updateSpecCommanders(players: { slot: number; name: string }[], states?: Record<number, PlayerState>) {
    const row = document.getElementById("spec-focus-row");
    if (!row) return;
    const sorted = [...players].filter((p) => p.slot >= 0).sort((a, b) => a.slot - b.slot);
    const sig = sorted.map((p) => `${p.slot}:${p.name}:${states?.[p.slot]?.eliminated ? 1 : 0}`).join("|");
    if (sig === this.specCmdrSig) return;
    this.specCmdrSig = sig;
    row.innerHTML = "";
    for (const p of sorted) {
      const elim = !!states?.[p.slot]?.eliminated;
      const b = document.createElement("button");
      b.type = "button";
      b.className = `spec-cmdr-btn${elim ? " elim" : ""}`;
      b.dataset.slot = String(p.slot);
      b.title = `Focus camera on ${p.name}`;
      const col = PLAYER_COLORS[p.slot] ?? "#8a97a5";
      b.innerHTML = `<span class="cdot" style="background:${col}"></span><span>${esc(p.name)}</span>`;
      b.addEventListener("click", () => this.onFocusCommander?.(p.slot));
      row.appendChild(b);
    }
  }

  private syncSpecBar() {
    const bar = document.getElementById("spec-controls");
    if (!bar) return;
    const show = this.playing && this.spectating && !this.fpvMode;
    bar.classList.toggle("hidden", !show);
  }

  updateClock(tick: number) {
    const clock = document.getElementById("game-clock");
    if (!clock) return;
    clock.textContent = fmtClock(tick);
  }

  bindGraphics(gfx: GraphicsBridge) {
    this.gfx = gfx;
    this.syncGraphicsControls();
    this.updateGraphicsTelemetry(true);
  }

  openGraphicsPanel() {
    const panel = document.getElementById("gfx-panel");
    if (!panel) return;
    panel.classList.remove("hidden");
    this.syncGraphicsControls();
    this.updateGraphicsTelemetry(true);
  }

  closeGraphicsPanel() {
    document.getElementById("gfx-panel")?.classList.add("hidden");
  }

  toggleGraphicsPanel() {
    const panel = document.getElementById("gfx-panel");
    if (!panel) return;
    if (panel.classList.contains("hidden")) this.openGraphicsPanel();
    else this.closeGraphicsPanel();
  }

  private syncGraphicsControls() {
    if (!this.gfx) return;
    const { settings, gpu } = this.gfx;

    // Topbar GFX button label & highlight
    const btn = document.getElementById("gfx-btn");
    if (btn) {
      if (settings.raytracing) {
        btn.textContent = "GFX: RT";
        btn.classList.add("on");
      } else if (settings.preset === "low") {
        btn.textContent = "GFX: LOW";
        btn.classList.remove("on");
      } else {
        btn.textContent = "GFX";
        btn.classList.toggle("on", settings.preset === "high" || settings.preset === "ultra");
      }
      btn.title = `Graphics: ${fmtPresetName(settings.preset)}${settings.raytracing ? " · SSR Raytracing ON" : ""} (click to configure)`;
    }

    // Segmented preset buttons
    for (const pbtn of document.querySelectorAll<HTMLButtonElement>(".gfx-preset[data-preset]")) {
      pbtn.classList.toggle("active", pbtn.dataset.preset === settings.preset);
    }
    const desc = document.getElementById("gfx-preset-desc");
    if (desc) desc.textContent = this.gfxDescText(settings);
    const rec = document.getElementById("gfx-rec-note");
    if (rec && gpu?.recommended) {
      rec.textContent = `Recommended: ${fmtPresetName(gpu.recommended)}`;
    }

    // Individual pipeline checkboxes
    const syncChk = (id: string, val: boolean) => {
      const inp = document.getElementById(id) as HTMLInputElement | null;
      if (inp) inp.checked = val;
    };
    syncChk("gfx-rt", settings.raytracing);
    syncChk("gfx-ao", settings.contactShadows);
    syncChk("gfx-bloom", settings.bloom);
    syncChk("gfx-dyn", settings.dynamicRes);
    syncChk("gfx-auto", settings.autoQuality);
  }

  updateGraphicsTelemetry(force = false) {
    if (!this.gfx) return;
    const now = performance.now();
    if (!force && now - this.gfxLastMs < 300) return;
    this.gfxLastMs = now;

    const { gpu, stats, settings } = this.gfx;
    const fps = Math.round(stats.fps);

    // Compact live topbar FPS pill
    const pill = document.getElementById("fps-pill");
    if (pill) {
      pill.textContent = fps > 0 ? `${fps} FPS` : "-- FPS";
      pill.classList.toggle("warn", fps > 0 && fps < 35 && fps >= 20);
      pill.classList.toggle("low", fps > 0 && fps < 20);
      pill.title = `${fps > 0 ? fps : "--"} FPS · ${stats.frameMs.toFixed(1)} ms · ${stats.dpr.toFixed(2)}× DPR`;
    }

    // Keep GFX button indicator synced if settings changed externally
    const gfxBtn = document.getElementById("gfx-btn");
    if (gfxBtn) {
      const tier = settings.autoQuality ? this.gfx.autoTier : 0;
      const desired =
        tier > 0 ? `GFX: L${tier}` : settings.raytracing ? "GFX: RT" : settings.preset === "low" ? "GFX: LOW" : "GFX";
      if (gfxBtn.textContent !== desired) {
        gfxBtn.textContent = desired;
        gfxBtn.classList.toggle("on", settings.raytracing || settings.preset === "high" || settings.preset === "ultra");
      }
      if (tier > 0) gfxBtn.title = `Auto Quality: shed to tier ${tier} to hold 60 FPS (click to configure)`;
    }

    const panel = document.getElementById("gfx-panel");
    if (!panel || panel.classList.contains("hidden")) return;

    // Hardware telemetry header (refreshed while open in case WebGPU adapter resolves async)
    const gpuEl = document.getElementById("gfx-gpu-name");
    if (gpuEl) {
      const name = gpu.rendererName || gpu.webgpuAdapter || "Hardware GPU";
      gpuEl.textContent = name;
      gpuEl.title = gpu.vendor ? `${name} (${gpu.vendor})` : name;
    }
    const glBadge = document.getElementById("gfx-badge-gl");
    if (glBadge) {
      glBadge.textContent = gpu.appleSilicon ? "APPLE SILICON · METAL" : `${gpu.backend || "WebGL2"} GPU`;
      glBadge.classList.add("acc");
    }
    const wgpuBadge = document.getElementById("gfx-badge-wgpu");
    if (wgpuBadge) {
      wgpuBadge.textContent = gpu.webgpuAvailable ? "WebGPU READY" : "WebGL2 Only";
      wgpuBadge.classList.toggle("ok", gpu.webgpuAvailable);
      wgpuBadge.title = gpu.webgpuAvailable
        ? gpu.webgpuAdapter
          ? `WebGPU Adapter: ${gpu.webgpuAdapter}`
          : "WebGPU hardware adapter available"
        : "Browser running WebGL2 hardware path";
    }
    const coresBadge = document.getElementById("gfx-badge-cores");
    if (coresBadge) {
      coresBadge.textContent = `${Math.max(1, gpu.cores || 1)}T`;
      coresBadge.title = `${gpu.cores || 1} logical CPU threads · Max texture ${gpu.maxTextureSize || 0}px`;
    }
    const dgpuTip = document.getElementById("gfx-dgpu-tip");
    if (dgpuTip) {
      const isIntelOrIgpu = /\b(Intel|UHD|Iris|HD\s+Graphics)\b/i.test(gpu.rendererName || "");
      if (isIntelOrIgpu && !gpu.appleSilicon) {
        dgpuTip.classList.remove("hidden");
        dgpuTip.textContent =
          "Have an NVIDIA/AMD laptop GPU? Browsers default to Intel iGPU — in Windows Settings → System → Display → Graphics, set Chrome/Edge to High Performance (NVIDIA), then restart browser.";
      } else {
        dgpuTip.classList.add("hidden");
      }
    }

    // Live 300ms metrics row
    const mFps = document.getElementById("gfx-m-fps");
    if (mFps) {
      mFps.textContent = fps > 0 ? String(fps) : "--";
      mFps.classList.toggle("ok", fps >= 50);
      mFps.classList.toggle("warn", fps >= 25 && fps < 50);
      mFps.classList.toggle("low", fps > 0 && fps < 25);
    }
    const mMs = document.getElementById("gfx-m-ms");
    if (mMs) mMs.textContent = stats.frameMs > 0 ? `${stats.frameMs.toFixed(1)}ms` : "--";
    const mCalls = document.getElementById("gfx-m-calls");
    if (mCalls) mCalls.textContent = Number.isFinite(stats.calls) ? String(Math.round(stats.calls)) : "--";
    const mTris = document.getElementById("gfx-m-tris");
    if (mTris) mTris.textContent = fmtTris(stats.triangles);
    const mDpr = document.getElementById("gfx-m-dpr");
    if (mDpr) mDpr.textContent = stats.dpr > 0 ? `${stats.dpr.toFixed(2)}×` : "--";

    // Live adaptive-governor status on the preset description line
    const desc = document.getElementById("gfx-preset-desc");
    if (desc) desc.textContent = this.gfxDescText(settings);
  }

  private gfxDescText(settings: GraphicsSettings): string {
    const tier = settings.autoQuality ? (this.gfx?.autoTier ?? 0) : 0;
    const autoNote = !settings.autoQuality
      ? ""
      : tier > 0
        ? ` · AUTO governor: shed to tier ${tier} to hold 60 FPS`
        : " · AUTO governor armed";
    return (GFX_PRESET_DESCS[settings.preset] ?? "") + autoNote;
  }

  tick(dt: number) {
    this.updateGraphicsTelemetry(false);
    if (this.spectating || !this.creditsInit) return;
    const diff = this.targetCredits - this.displayCredits;
    if (Math.abs(diff) > 0.5) {
      this.displayCredits = Math.abs(diff) < 2 ? this.targetCredits : this.displayCredits + diff * Math.min(1, dt * 11);
      el("credits").textContent = fmtCost(Math.round(this.displayCredits));
    } else if (this.displayCredits !== this.targetCredits) {
      this.displayCredits = this.targetCredits;
      el("credits").textContent = fmtCost(Math.round(this.displayCredits));
    }
  }

  private buildTooltip(kind: BuildingKind, missing?: BuildingKind[], constructionBoost = 1, powerRate = 1) {
    const d = BUILDINGS[kind];
    const pwr = d.power !== 0 ? `${d.power > 0 ? "+" : ""}${d.power}⚡ · ` : "";
    const baseSecs = d.buildTicks / 10;
    const effective = constructionBoost * powerRate;
    const notes: string[] = [];
    if (constructionBoost > 1.01) notes.push(`${fmtBoost(constructionBoost)} hub construction`);
    if (powerRate < 0.99) notes.push(`low power ${fmtBoost(powerRate)}`);
    const timeText = notes.length
      ? `${fmtWorkTime(d.buildTicks, effective)} (base ${baseSecs}s, ${notes.join(", ")})`
      : `${baseSecs}s`;
    const base = `${TOOLTIPS[kind] ?? BUILDING_NAMES[kind]} · ${pwr}${timeText} to build`;
    if (missing?.length) return `${base} · Requires: ${missing.map((m) => BUILDING_NAMES[m]).join(", ")}`;
    return base;
  }

  focusChat() {
    el<HTMLInputElement>("chat-input").focus();
  }

  setWasdLabel(on: boolean) {
    const b = document.getElementById("wasd-btn");
    if (b) {
      b.textContent = on ? "KEYS: WASD" : "KEYS: RTS";
      b.classList.toggle("on", on);
      b.title = on
        ? "WASD pans camera · F = Attack-Move · X = Stop (click to switch to Classic RTS)"
        : "Arrows pan camera · A = Attack-Move · S = Stop · X = Scatter (click to switch to WASD pan)";
    }
    const va = document.querySelector("#verb-amove kbd");
    const vs = document.querySelector("#verb-stop kbd");
    if (va) va.textContent = on ? "F" : "A";
    if (vs) vs.textContent = on ? "X" : "S";
  }

  setIcons(icons: Map<string, string>) {
    this.icons = icons;
    for (const [k, url] of icons) {
      for (const span of document.querySelectorAll<HTMLElement>(`.icon[data-kind="${k}"]`)) {
        span.style.backgroundImage = `url(${url})`;
        span.classList.add("has-icon");
      }
    }
    this.selSig = ""; // refresh selection icons if already open
  }

  private iconFor(kind: string) {
    return this.icons.get(kind);
  }

  private clickBuild(kind: BuildingKind) {
    const b = this.buildBtns.get(kind)!;
    if (b.classList.contains("ready")) this.onPlaceMode(kind);
    else if (!b.disabled) this.onBuild(kind); // always enqueue — the queue absorbs it
  }

  setRoom(code: string) {
    this.currentRoomCode = code;
    el("room-code").textContent = "ROOM " + code;
    el("lobby-room").textContent = code;
    this.syncMcpRoomPrompt();
  }

  setStatus(s: string) {
    el("conn-status").textContent = s;
  }

  showLobby(players: LobbyPlayer[], you: string, mapId: MapId = "crossroads", config: GameConfig = DEFAULT_CONFIG) {
    this.playing = false;
    this.fpvMode = false;
    this.syncSpecBar();
    document.getElementById("fpv-hud")?.classList.add("hidden");
    this.hideHoverTip();
    this.hideSideInfo();
    el("lobby").classList.remove("hidden");
    el("endscreen").classList.add("hidden");
    const me = players.find((p) => p.id === you);
    this.ready = !!me?.ready;
    el("ready-btn").textContent = this.ready ? "UNREADY" : "READY";
    el("ready-btn").classList.toggle("on", this.ready);
    const isHost = !!me?.host;

    if (me) this.setInitialName(me.name);
    const mapSelect = document.getElementById("map-select") as HTMLSelectElement | null;
    if (mapSelect) {
      mapSelect.value = mapId;
      mapSelect.disabled = !isHost;
    }
    const cfgCr = document.getElementById("cfg-credits") as HTMLSelectElement | null;
    if (cfgCr) {
      cfgCr.value = String(config.startCredits);
      cfgCr.disabled = !isHost;
    }
    const cfgSp = document.getElementById("cfg-speed") as HTMLSelectElement | null;
    if (cfgSp) {
      cfgSp.value = String(config.gameSpeed);
      cfgSp.disabled = !isHost;
    }
    const syncChk = (id: string, val: boolean) => {
      const inp = document.getElementById(id) as HTMLInputElement | null;
      if (inp) {
        inp.checked = val;
        inp.disabled = !isHost;
      }
    };
    syncChk("cfg-sw", config.superweapons);
    syncChk("cfg-crates", config.crates);
    syncChk("cfg-derricks", config.derricks);
    syncChk("cfg-fog", config.fog);
    syncChk("cfg-logistics", config.logistics !== false);
    this.updateMapDesc(mapId);

    const list = el("player-list");
    list.innerHTML = "";
    for (const p of players) {
      const li = document.createElement("li");
      if (p.eliminated) li.classList.add("dead");
      const color = p.slot >= 0 ? PLAYER_COLORS[p.slot] : "#8a97a5";

      const dot = document.createElement("span");
      dot.className = "cdot";
      dot.style.background = color;
      li.appendChild(dot);

      const pname = document.createElement("span");
      pname.className = "pname";
      pname.style.color = color;
      pname.textContent = `${p.name}${p.id === you ? " (you)" : ""}`;
      li.appendChild(pname);

      if (!p.spectator) {
        const team = p.team ?? 0;
        const tLabel = team === 0 ? "FFA" : `T${team}`;
        const tClass = `tbadge ${team >= 1 && team <= 4 ? `t${team}` : "ffa"}`;
        if (p.id === you || (isHost && p.bot)) {
          const tb = document.createElement("button");
          tb.type = "button";
          tb.className = tClass + " own";
          tb.textContent = tLabel;
          tb.title = "Click to cycle team (FFA / T1 / T2 / T3 / T4)";
          tb.addEventListener("click", () => {
            const next = (team + 1) % 5;
            this.onSetTeam(next, p.id === you ? undefined : p.id);
          });
          li.appendChild(tb);
        } else {
          const ts = document.createElement("span");
          ts.className = tClass;
          ts.textContent = tLabel;
          li.appendChild(ts);
        }
      }

      if (isHost && p.bot) {
        const dSel = document.createElement("select");
        dSel.className = "bot-inline";
        dSel.title = "Bot difficulty";
        for (const dv of ["easy", "normal", "brutal"] as BotDiff[]) {
          const o = document.createElement("option");
          o.value = dv;
          o.textContent = dv[0].toUpperCase() + dv.slice(1);
          o.selected = (p.diff ?? "normal") === dv;
          dSel.appendChild(o);
        }
        dSel.addEventListener("change", () => this.onSetBotConfig(p.id, dSel.value as BotDiff, undefined));
        li.appendChild(dSel);

        const pSel = document.createElement("select");
        pSel.className = "bot-inline";
        pSel.title = "Bot playstyle profile";
        for (const bp of BOT_PROFILES) {
          const o = document.createElement("option");
          o.value = bp.id;
          o.textContent = bp.label;
          o.selected = (p.profile ?? "balanced") === bp.id;
          pSel.appendChild(o);
        }
        pSel.addEventListener("change", () => this.onSetBotConfig(p.id, undefined, pSel.value as BotProfile));
        li.appendChild(pSel);
      } else {
        const meta = document.createElement("span");
        meta.className = "meta";
        const profLabel = BOT_PROFILES.find((bp) => bp.id === (p.profile ?? "balanced"))?.label ?? "Balanced";
        const role = p.spectator
          ? "spectating"
          : p.bot
            ? `AI · ${p.diff ?? "normal"} · ${profLabel}`
            : p.host
              ? "◆ host"
              : "";
        const conn = p.connected ? (p.ready ? "· ready" : "") : "· offline";
        const out = p.eliminated ? " · out" : "";
        meta.textContent = `${role} ${conn}${out}`.trim();
        li.appendChild(meta);
      }

      if (isHost && p.connected && !p.spectator && !p.bot && p.id !== you) {
        const hostBtn = document.createElement("button");
        hostBtn.type = "button";
        hostBtn.className = "host-btn";
        hostBtn.title = `Make ${p.name} host`;
        hostBtn.textContent = "⇑";
        hostBtn.addEventListener("click", () => this.onTransferHost(p.id));
        li.appendChild(hostBtn);
      }

      if (isHost && p.bot) {
        const kick = document.createElement("button");
        kick.type = "button";
        kick.className = "kick-btn";
        kick.title = `Remove ${p.name}`;
        kick.textContent = "×";
        kick.addEventListener("click", () => this.onKickBot(p.id));
        li.appendChild(kick);
      }

      list.appendChild(li);
    }

    el("start-btn").classList.toggle("hidden", !isHost);
    el("addbot-btn")?.classList.toggle("hidden", !isHost);
    document.getElementById("bot-diff")?.classList.toggle("hidden", !isHost);
    document.getElementById("bot-profile")?.classList.toggle("hidden", !isHost);
    el("lobby-hint").textContent = isHost
      ? "you are host — configure match rules, bot difficulty & playstyles, then start (2-8 players)"
      : "waiting for host to start… (click your team badge to switch teams)";
  }

  hideLobby(spectating = false) {
    this.playing = true;
    el("lobby").classList.add("hidden");
    for (const id of ["topbar", "minimap", "selinfo", "chat-box"]) {
      document.getElementById(id)?.classList.remove("hidden");
    }
    this.setSpectatorMode(spectating);
  }

  setSpectatorMode(spectating: boolean) {
    this.spectating = spectating;
    for (const id of ["sidebar", "verbbar", "resign-btn", "groupbar"]) {
      document.getElementById(id)?.classList.toggle("hidden", spectating || this.fpvMode);
    }
    if (spectating) {
      this.hideSideInfo();
      document.getElementById("sw-hud")?.classList.add("hidden");
      document.getElementById("recon-hud")?.classList.add("hidden");
    }
    this.syncSpecBar();
  }

  setFpvMode(active: boolean, spectating = this.spectating) {
    this.fpvMode = active;
    const fpvHud = document.getElementById("fpv-hud");
    if (active) {
      this.fpvLastKind = "";
      this.closeGraphicsPanel();
      this.closeWatchPanel();
      this.closeMcpPanel();
      this.hideHoverTip();
      this.hideSideInfo();
      for (const id of [
        "sidebar",
        "verbbar",
        "selinfo",
        "spec-controls",
        "groupbar",
        "placement-hint",
        "hover-tip",
        "order-label",
        "chat-box",
        "recon-hud",
        "sw-hud",
      ]) {
        document.getElementById(id)?.classList.add("hidden");
      }
      fpvHud?.classList.remove("hidden");
    } else {
      fpvHud?.classList.add("hidden");
      this.clearFpvStory();
      document.getElementById("selinfo")?.classList.remove("hidden");
      document.getElementById("chat-box")?.classList.remove("hidden");
      this.setSpectatorMode(spectating);
    }
  }

  updateFpv(tel: FpvTelemetry | null) {
    if (!this.fpvMode || !tel) return;
    const udef = !isBuildingKind(tel.kind) ? UNITS[tel.kind as UnitKind] : null;
    const domain = tel.domain ?? udef?.domain ?? "land";
    const isInf = domain === "land" && udef?.trainsAt === "barracks";

    // Top-center banner (pointer lock state)
    const banner = document.getElementById("fpv-banner");
    if (banner) {
      const locked = tel.pointerLocked || document.pointerLockElement != null;
      banner.textContent = locked
        ? "FIRST-PERSON POV · WASD MOVE · MOUSE AIM · LMB FIRE · E / ESC EXIT"
        : "FIRST-PERSON POV · CLICK TO LOCK MOUSE · E / ESC TO EXIT";
    }

    // Center tactical reticle domain style + lock-on state
    const reticle = document.getElementById("fpv-reticle");
    if (reticle) {
      const domCls = isInf ? "fpv-inf" : domain === "air" ? "fpv-air" : domain === "sea" ? "fpv-sea" : "fpv-land";
      reticle.classList.remove("fpv-inf", "fpv-land", "fpv-air", "fpv-sea");
      reticle.classList.add(domCls);
      const tgt = tel.target;
      reticle.classList.toggle("locked", Boolean(tgt && tgt.enemy && tgt.inRange));

      const tgtEl = document.getElementById("fpv-target");
      if (tgtEl) {
        if (tgt) {
          const tgtName = label(tgt.kind).toUpperCase();
          const tHp = Math.max(0, Math.round(tgt.hp));
          const tMhp = Math.max(1, Math.round(tgt.mhp));
          const distM = Math.round(tgt.dist * 10);
          tgtEl.classList.remove("range-only");
          if (tgt.enemy) {
            const rangeTag = tgt.inRange ? "IN RANGE" : "OUT OF RANGE";
            tgtEl.textContent = `TARGET: ${tgtName} · HP ${tHp}/${tMhp} · ${distM}m · ${rangeTag}`;
            tgtEl.classList.toggle("out-of-range", !tgt.inRange);
          } else {
            tgtEl.textContent = `${tgtName} · HP ${tHp}/${tMhp} · ${distM}m`;
            tgtEl.classList.remove("out-of-range");
          }
          tgtEl.classList.remove("hidden");
        } else if (tel.aimDist > 0) {
          tgtEl.textContent = `${Math.round(tel.aimDist * 10)}m`;
          tgtEl.classList.remove("out-of-range");
          tgtEl.classList.add("range-only");
          tgtEl.classList.remove("hidden");
        } else {
          tgtEl.classList.add("hidden");
          tgtEl.classList.remove("out-of-range", "range-only");
        }
      }
    }

    // Bottom-left unit telemetry card
    if (tel.kind !== this.fpvLastKind) {
      this.fpvLastKind = tel.kind;
      const nameEl = document.getElementById("fpv-unit-name");
      if (nameEl) nameEl.textContent = label(tel.kind).toUpperCase();
      const iconEl = document.getElementById("fpv-unit-icon");
      if (iconEl) {
        const ic = this.iconFor(tel.kind);
        iconEl.style.backgroundImage = ic ? `url(${ic})` : "";
        iconEl.classList.toggle("has-icon", Boolean(ic));
      }
      const domBadge = document.getElementById("fpv-domain-badge");
      if (domBadge) {
        domBadge.textContent = isInf
          ? "INFANTRY"
          : udef?.kamikaze
            ? "KAMIKAZE"
            : udef?.ewJamRadius
              ? "EW DRONE"
              : domain === "air"
                ? "AIRCRAFT"
                : domain === "sea"
                  ? "NAVAL"
                  : "ARMOR";
      }
    }

    const vetEl = document.getElementById("fpv-unit-vet");
    if (vetEl) {
      const vet = Math.max(0, Math.min(3, Math.floor(tel.vet)));
      vetEl.textContent = vet > 0 ? "★".repeat(vet) : "";
    }

    const subBadge = document.getElementById("fpv-sub-badge");
    if (subBadge) {
      subBadge.classList.toggle("hidden", !tel.submerged);
    }

    const hp = Math.max(0, tel.hp);
    const mhp = Math.max(1, tel.mhp);
    const hpPct = Math.max(0, Math.min(100, (hp / mhp) * 100));
    const hpFill = document.getElementById("fpv-hp-fill");
    if (hpFill) {
      hpFill.style.width = `${hpPct.toFixed(1)}%`;
      hpFill.classList.toggle("warn", hpPct < 55 && hpPct >= 28);
      hpFill.classList.toggle("crit", hpPct < 28);
    }
    const hpText = document.getElementById("fpv-hp-text");
    if (hpText) hpText.textContent = `HP ${Math.round(hp)} / ${Math.round(mhp)}`;

    const spdEl = document.getElementById("fpv-spd");
    if (spdEl) {
      const s = Math.abs(tel.speed);
      if (domain === "air") spdEl.textContent = `SPD ${Math.round(s * 85)} kt`;
      else if (domain === "sea") spdEl.textContent = `SPD ${Math.round(s * 14)} kt`;
      else if (isInf) spdEl.textContent = `SPD ${(s * 4.5).toFixed(1)} m/s`;
      else spdEl.textContent = `SPD ${Math.round(s * 24)} km/h`;
    }

    const hdgEl = document.getElementById("fpv-hdg");
    if (hdgEl) {
      const deg = ((Math.round(tel.headingDeg) % 360) + 360) % 360;
      hdgEl.textContent = `HDG ${String(deg).padStart(3, "0")}°`;
    }

    const altEl = document.getElementById("fpv-alt");
    if (altEl) {
      if (domain === "air") {
        altEl.textContent = `ALT ${Math.round(tel.altitude)}m`;
        altEl.classList.remove("hidden");
      } else {
        altEl.classList.add("hidden");
      }
    }

    const fuelEl = document.getElementById("fpv-fuel");
    if (fuelEl) {
      if (tel.fuel !== undefined) {
        const fv = Math.max(0, Math.round(tel.fuel));
        fuelEl.textContent = `FUEL ${fv}%`;
        fuelEl.classList.toggle("warn", fv < 35 && fv >= 15);
        fuelEl.classList.toggle("crit", fv < 15);
        fuelEl.classList.remove("hidden");
      } else {
        fuelEl.classList.add("hidden");
        fuelEl.classList.remove("warn", "crit");
      }
    }

    const ammoEl = document.getElementById("fpv-ammo");
    if (ammoEl) {
      if (tel.ammo !== undefined) {
        const av = Math.max(0, Math.round(tel.ammo));
        ammoEl.textContent = `AMMO ${av}%`;
        ammoEl.classList.toggle("warn", av < 35 && av >= 15);
        ammoEl.classList.toggle("crit", av < 15);
        ammoEl.classList.remove("hidden");
      } else {
        ammoEl.classList.add("hidden");
        ammoEl.classList.remove("warn", "crit");
      }
    }

    // Bottom-right weapon & reload panel
    const wpnStatus = document.getElementById("fpv-wpn-status");
    const wpnRange = document.getElementById("fpv-wpn-range");
    const reloadFill = document.getElementById("fpv-reload-fill");
    if (wpnStatus && reloadFill) {
      if (tel.kind === "engineer") {
        wpnStatus.textContent = "CAPTURE RANGE — CLICK BUILDING";
        wpnStatus.className = "utility";
        reloadFill.style.width = "100%";
        reloadFill.className = "utility";
        if (wpnRange) wpnRange.textContent = `RNG ${Math.round(CAPTURE_RANGE * 10)}m`;
      } else if (tel.kind === "harvester") {
        wpnStatus.textContent = "MINING MODE";
        wpnStatus.className = "utility";
        reloadFill.style.width = "100%";
        reloadFill.className = "utility";
        if (wpnRange) wpnRange.textContent = "ORE RIG";
      } else if (tel.kind === "supplytruck") {
        wpnStatus.textContent = "LOGISTICS RESUPPLY AURA";
        wpnStatus.className = "utility";
        reloadFill.style.width = "100%";
        reloadFill.className = "utility";
        if (wpnRange) wpnRange.textContent = "RESUPPLY 55m";
      } else if (udef?.kamikaze) {
        wpnStatus.textContent = "ARMED — CLICK / SPACE TO DETONATE";
        wpnStatus.className = "";
        reloadFill.style.width = "100%";
        reloadFill.className = "";
        if (wpnRange) {
          const rngM = udef.range > 0 ? Math.round(udef.range * 10) : 0;
          wpnRange.textContent = rngM > 0 ? `RNG ${rngM}m` : "WARHEAD";
        }
      } else if (udef?.ewJamRadius) {
        const jamM = Math.round(udef.ewJamRadius * 10);
        wpnStatus.textContent = `EW JAMMER ACTIVE — ${jamM}m ANTI-DRONE AURA`;
        wpnStatus.className = "utility";
        reloadFill.style.width = "100%";
        reloadFill.className = "utility";
        if (wpnRange) wpnRange.textContent = `JAM ${jamM}m`;
      } else {
        const readyFrac = Math.max(0, Math.min(1, 1 - tel.reloading));
        const ready = tel.reloading <= 0.01;
        wpnStatus.textContent = ready ? "WEAPON READY" : "RELOADING...";
        wpnStatus.className = ready ? "" : "reloading";
        reloadFill.style.width = `${(readyFrac * 100).toFixed(1)}%`;
        reloadFill.className = ready ? "" : "reloading";
        if (wpnRange) {
          const rngM = udef && udef.range > 0 ? Math.round(udef.range * 10) : 0;
          wpnRange.textContent = rngM > 0 ? `RNG ${rngM}m` : "";
        }
      }
    }

    // Selected weapon-system name (multi-weapon platforms like the AC-130)
    const wpnEl = document.getElementById("fpv-wpn");
    if (wpnEl) {
      if (tel.wpnName) {
        wpnEl.textContent = tel.wpnName.toUpperCase();
        wpnEl.classList.remove("hidden");
      } else {
        wpnEl.classList.add("hidden");
      }
    }

    // Right-edge altitude tape (driven aircraft only)
    const altape = document.getElementById("fpv-altape");
    if (altape) {
      if (domain === "air") {
        altape.classList.remove("hidden");
        const tapeFill = document.getElementById("fpv-altape-fill");
        if (tapeFill) {
          tapeFill.style.height = `${(Math.max(0, Math.min(1, tel.alt)) * 100).toFixed(1)}%`;
        }
        const tapeText = document.getElementById("fpv-altape-text");
        if (tapeText) tapeText.textContent = `ALT ${Math.round(tel.altitude)}m`;
      } else {
        altape.classList.add("hidden");
      }
    }

    // Telemetry chip row — sprint / crouch / submerged flags
    const chips = document.getElementById("fpv-chips");
    if (chips) {
      const chip = (id: string, on: boolean) => document.getElementById(id)?.classList.toggle("hidden", !on);
      chip("fpv-chip-sprint", tel.sprint);
      chip("fpv-chip-crouch", tel.crouch);
      chip("fpv-chip-sub", tel.submerged);
      chips.classList.toggle("hidden", !(tel.sprint || tel.crouch || tel.submerged));
    }
  }

  /** Render the story director's state — feed, objective, streaks, hitmarker & lock UI. */
  updateFpvStory(s: FpvStoryState | null) {
    if (!s || !this.fpvMode) {
      this.clearFpvStory();
      return;
    }

    // Kill feed (bottom-left): reconcile 1 div per line, fade by age
    const feedEl = document.getElementById("fpv-feed");
    if (feedEl) {
      while (feedEl.children.length < s.feed.length) {
        feedEl.appendChild(document.createElement("div"));
      }
      while (feedEl.children.length > s.feed.length) {
        feedEl.removeChild(feedEl.firstChild as Node);
      }
      for (let i = 0; i < s.feed.length; i++) {
        const line = s.feed[i];
        const d = feedEl.children[i] as HTMLElement;
        if (d.textContent !== line.text) d.textContent = line.text;
        const cls = `fl fl-${line.tone}`;
        if (d.className !== cls) d.className = cls;
        const op = Math.max(0, Math.min(1, (5 - line.age) / 1.2)).toFixed(2);
        if (d.style.opacity !== op) d.style.opacity = op;
      }
    }

    // Objective card (top-center)
    const objEl = document.getElementById("fpv-objective");
    if (objEl) {
      if (s.objective) {
        objEl.classList.remove("hidden");
        objEl.classList.toggle("done", s.objective.done);
        const titleEl = document.getElementById("fpv-obj-title");
        if (titleEl && titleEl.textContent !== s.objective.text) titleEl.textContent = s.objective.text;
        const progEl = document.getElementById("fpv-obj-prog");
        const progTxt = s.objective.done ? "★" : `${s.objective.prog}/${s.objective.total}`;
        if (progEl && progEl.textContent !== progTxt) progEl.textContent = progTxt;
        const fillEl = document.getElementById("fpv-obj-fill");
        if (fillEl) {
          const pct = s.objective.total > 0 ? (s.objective.prog / s.objective.total) * 100 : 0;
          fillEl.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(0)}%`;
        }
      } else {
        objEl.classList.add("hidden");
      }
    }

    // Kill counter + streak callout (top-right)
    const streakEl = document.getElementById("fpv-streak");
    if (streakEl) {
      streakEl.classList.toggle("hidden", s.kills <= 0);
      const killsEl = document.getElementById("fpv-kills");
      const killsTxt = `☠ ${s.kills}`;
      if (killsEl && killsEl.textContent !== killsTxt) killsEl.textContent = killsTxt;
      const spreeEl = document.getElementById("fpv-spree");
      const spreeTxt = s.streak >= 2 ? `${fpvStreakName(s.streak)} ×${s.streak}` : "";
      if (spreeEl && spreeEl.textContent !== spreeTxt) spreeEl.textContent = spreeTxt;
      streakEl.classList.toggle("hot", s.streak >= 2);
    }

    // Center hitmarker flash
    const hitEl = document.getElementById("fpv-hitmark") as HTMLElement | null;
    if (hitEl) {
      const hm = Math.max(0, Math.min(1, s.hitmark));
      hitEl.style.opacity = hm.toFixed(2);
      hitEl.style.transform = `translate(-50%, -50%) scale(${(0.85 + hm * 0.45).toFixed(3)})`;
    }

    // Missile lock readout under the reticle + reticle ring state.
    // "locked" stays an OR with updateFpv's target-in-range state (that class is
    // re-evaluated by updateFpv every frame), "locking" is owned here exclusively.
    const locked = s.lockMsg === "◈ LOCKED";
    const locking = s.lockMsg !== "" && !locked;
    const reticle = document.getElementById("fpv-reticle");
    if (reticle) {
      reticle.classList.toggle("locking", locking);
      if (locked) reticle.classList.add("locked");
    }
    const lockEl = document.getElementById("fpv-lock");
    if (lockEl) {
      if (lockEl.textContent !== s.lockMsg) lockEl.textContent = s.lockMsg;
      lockEl.classList.toggle("hidden", s.lockMsg === "");
      lockEl.classList.toggle("on", locked);
    }
  }

  /** Wipe all story-layer HUD elements (called on FPV exit / match end). */
  private clearFpvStory() {
    const feedEl = document.getElementById("fpv-feed");
    if (feedEl) feedEl.innerHTML = "";
    for (const id of ["fpv-objective", "fpv-streak", "fpv-lock", "fpv-wpn", "fpv-altape", "fpv-chips"]) {
      document.getElementById(id)?.classList.add("hidden");
    }
    const hitEl = document.getElementById("fpv-hitmark") as HTMLElement | null;
    if (hitEl) hitEl.style.opacity = "0";
    document.getElementById("fpv-reticle")?.classList.remove("locking");
    for (const id of ["fpv-chip-sprint", "fpv-chip-crouch", "fpv-chip-sub"]) {
      document.getElementById(id)?.classList.add("hidden");
    }
  }

  clearChat() {
    this.chatLines = [];
    const box = document.getElementById("chat-lines");
    if (box) box.innerHTML = "";
  }

  showEnd(text: string, reason = "", stats?: MatchStats[], durationSec?: number) {
    this.playing = false;
    this.fpvMode = false;
    this.syncSpecBar();
    document.getElementById("fpv-hud")?.classList.add("hidden");
    this.hideHoverTip();
    this.hideSideInfo();
    el("end-text").textContent = text;
    const r = document.getElementById("end-reason");
    if (r) r.textContent = reason;

    const dur = document.getElementById("end-duration");
    if (dur) {
      if (durationSec !== undefined && Number.isFinite(durationSec)) {
        const s = Math.max(0, Math.floor(durationSec));
        const mm = String(Math.floor(s / 60)).padStart(2, "0");
        const ss = String(s % 60).padStart(2, "0");
        dur.textContent = `MATCH DURATION ${mm}:${ss}`;
        dur.classList.remove("hidden");
      } else {
        dur.textContent = "";
        dur.classList.add("hidden");
      }
    }

    const box = document.getElementById("end-stats");
    if (box) {
      if (stats?.length) {
        const rows = [...stats]
          .sort((a, b) => a.slot - b.slot)
          .map((st) => {
            const color = st.slot >= 0 ? PLAYER_COLORS[st.slot] ?? "#8a97a5" : "#8a97a5";
            const tLabel = st.team > 0 ? `T${st.team}` : "FFA";
            const tCls = st.team >= 1 && st.team <= 4 ? `t${st.team}` : "ffa";
            return `<tr>
              <td><span class="stats-cmdr"><span class="cdot" style="background:${color}"></span><span style="color:${color}">${esc(st.name)}</span></span></td>
              <td><span class="tbadge ${tCls}">${tLabel}</span></td>
              <td class="stats-cr">${fmtCost(Math.round(st.creditsEarned))}</td>
              <td>${st.unitsBuilt}</td>
              <td>${st.unitsLost}</td>
              <td>${st.bldDestroyed}</td>
            </tr>`;
          })
          .join("");
        box.innerHTML = `<table class="stats-table">
          <thead><tr><th>COMMANDER</th><th>TEAM</th><th>CREDITS</th><th>BUILT</th><th>LOST</th><th>RAZED</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      } else {
        box.innerHTML = "";
      }
    }

    el("endscreen").classList.remove("hidden");
  }

  hideEnd() {
    el("endscreen").classList.add("hidden");
  }

  setPaused(p: boolean) {
    this.paused = p;
    el("paused-overlay")?.classList.toggle("hidden", !p);
    if (this.pauseBtn) this.pauseBtn.textContent = p ? "▶ RESUME" : "⏸ PAUSE";
  }

  setPauseVisible(v: boolean) {
    this.pauseBtn?.classList.toggle("hidden", !v);
    if (!v) this.setPaused(false);
  }

  isPaused() {
    return this.paused;
  }

  toast(msg: string, info = false) {
    const box = el("toasts");
    while (box.children.length >= 4) box.firstChild?.remove();
    const t = document.createElement("div");
    t.className = "toast" + (info ? " info" : "");
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  chat(name: string, color: string, text: string) {
    this.chatLines.push(`${name}: ${text}`);
    if (this.chatLines.length > 30) this.chatLines.splice(0, this.chatLines.length - 30);
    const box = el("chat-lines");
    const d = document.createElement("div");
    d.innerHTML = `<b style="color:${color}">${esc(name)}</b> ${esc(text)}`;
    box.appendChild(d);
    while (box.children.length > 6) box.firstChild?.remove();
    box.classList.add("flash");
    setTimeout(() => box.classList.remove("flash"), 300);
  }

  ping(x: number, y: number) {
    this.pinged = { x, y, t: performance.now() };
  }

  updateTop(state: PlayerState | null, spectatorStates?: Record<number, PlayerState>) {
    const cr = el("credits");
    const pw = el("power");
    const wrap = el("spec-board");
    if (spectatorStates) {
      this.spectating = true;
      cr.textContent = "";
      pw.innerHTML = "";
      pw.title = "";
      pw.classList.remove("low", "warn");
      wrap.innerHTML = Object.entries(spectatorStates)
        .map(
          ([s, p]) =>
            `<span class="${p.eliminated ? "elim" : ""}" style="color:${PLAYER_COLORS[+s] ?? "#888"}">${fmtCost(p.credits)}</span>`,
        )
        .join(" · ");
      return;
    }
    this.spectating = false;
    wrap.innerHTML = "";
    if (!state) return;
    if (!this.creditsInit) {
      this.creditsInit = true;
      this.displayCredits = state.credits;
      this.targetCredits = state.credits;
      cr.textContent = fmtCost(state.credits);
    } else {
      this.targetCredits = state.credits;
    }
    const net = state.pwrHave - state.pwrUse;
    const rawReserve = state.pwrHave > 0 ? net / state.pwrHave : 0;
    const fillPct = state.lowPower
      ? 100
      : state.pwrHave === 0
        ? 0
        : Math.round(Math.max(0.12, Math.min(1, rawReserve)) * 100);
    const warn = !state.lowPower && state.pwrHave > 0 && rawReserve < 0.25;
    pw.title = `Power output: ${state.pwrHave} ⚡ · Drain: ${state.pwrUse} ⚡ · Net: ${net >= 0 ? "+" : ""}${net}`;
    pw.innerHTML = `PWR <b>${net >= 0 ? "+" : ""}${net}</b>${state.lowPower ? ' <span class="pwr-tag">(LOW)</span>' : ""}<span class="pwr-track"><span class="pwr-fill" style="width:${fillPct}%"></span></span>`;
    pw.classList.toggle("low", state.lowPower);
    pw.classList.toggle("warn", warn);
  }

  updateRecon(state: PlayerState | null, reconArmed = false) {
    const btn = document.getElementById("recon-hud") as HTMLButtonElement | null;
    if (!btn) return;
    if (this.fpvMode || !state || this.spectating || state.reconLeft === undefined || state.reconLeft < 0) {
      btn.classList.add("hidden");
      btn.classList.remove("ready", "armed", "offline");
      return;
    }
    btn.classList.remove("hidden");
    const prog = btn.querySelector<HTMLElement>(".recon-prog");
    const txt = btn.querySelector<HTMLElement>(".recon-txt");
    const total = state.reconTotal && state.reconTotal > 0 ? state.reconTotal : RECON_CHARGE_TICKS;
    if (state.lowPower) {
      btn.disabled = true;
      btn.classList.remove("ready", "armed");
      btn.classList.add("offline");
      const pct = Math.max(0, Math.min(100, (1 - state.reconLeft / total) * 100));
      if (prog) prog.style.width = `${pct.toFixed(1)}%`;
      if (txt) txt.textContent = "RECON OFFLINE (LOW PWR)";
    } else if (state.reconReady) {
      btn.disabled = false;
      btn.classList.remove("offline");
      btn.classList.add("ready");
      btn.classList.toggle("armed", reconArmed);
      if (prog) prog.style.width = "100%";
      if (txt) txt.textContent = reconArmed ? "RECON SCAN — CLICK MAP" : "◎ RECON SCAN READY";
    } else {
      btn.disabled = true;
      btn.classList.remove("ready", "armed", "offline");
      const sec = Math.max(0, Math.ceil(state.reconLeft / 10));
      const m = Math.floor(sec / 60);
      const s = String(sec % 60).padStart(2, "0");
      const pct = Math.max(0, Math.min(100, (1 - state.reconLeft / total) * 100));
      if (prog) prog.style.width = `${pct.toFixed(1)}%`;
      if (txt) txt.textContent = `RECON SCAN ${m}:${s}`;
    }
  }

  updateSuperweapon(state: PlayerState | null, swArmed = false) {
    const btn = document.getElementById("sw-hud") as HTMLButtonElement | null;
    if (!btn) return;
    if (this.fpvMode || !state || this.spectating || state.swLeft === undefined || state.swLeft < 0) {
      btn.classList.add("hidden");
      btn.classList.remove("ready", "armed", "offline");
      return;
    }
    btn.classList.remove("hidden");
    const prog = btn.querySelector<HTMLElement>(".sw-prog");
    const txt = btn.querySelector<HTMLElement>(".sw-txt");
    const total = state.swTotal && state.swTotal > 0 ? state.swTotal : SW_CHARGE_TICKS;
    if (state.lowPower) {
      btn.disabled = true;
      btn.classList.remove("ready", "armed");
      btn.classList.add("offline");
      const pct = Math.max(0, Math.min(100, (1 - state.swLeft / total) * 100));
      if (prog) prog.style.width = `${pct.toFixed(1)}%`;
      if (txt) txt.textContent = "☢ NUKE OFFLINE (LOW PWR)";
    } else if (state.swReady) {
      btn.disabled = false;
      btn.classList.remove("offline");
      btn.classList.add("ready");
      btn.classList.toggle("armed", swArmed);
      if (prog) prog.style.width = "100%";
      if (txt) txt.textContent = swArmed ? "☢ NUKE ARMED — CLICK TARGET" : "☢ NUCLEAR STRIKE READY";
    } else {
      btn.disabled = true;
      btn.classList.remove("ready", "armed", "offline");
      const sec = Math.max(0, Math.ceil(state.swLeft / 10));
      const m = Math.floor(sec / 60);
      const s = String(sec % 60).padStart(2, "0");
      const pct = Math.max(0, Math.min(100, (1 - state.swLeft / total) * 100));
      if (prog) prog.style.width = `${pct.toFixed(1)}%`;
      if (txt) txt.textContent = `☢ NUKE ${m}:${s}`;
    }
  }

  private findSidebarBtnAt(x: number, y: number): HTMLButtonElement | null {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar || sidebar.classList.contains("hidden")) return null;
    const sr = sidebar.getBoundingClientRect();
    if (x < sr.left || x > sr.right || y < sr.top || y > sr.bottom) return null;
    if (typeof document.elementsFromPoint === "function") {
      for (const node of document.elementsFromPoint(x, y)) {
        if (node instanceof HTMLButtonElement && node.classList.contains("sbtn") && sidebar.contains(node)) {
          return node;
        }
        const parent = node instanceof Element ? node.closest<HTMLButtonElement>("#sidebar .sbtn") : null;
        if (parent) return parent;
      }
    }
    for (const b of this.buildBtns.values()) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return b;
    }
    for (const b of this.trainBtns.values()) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return b;
    }
    return null;
  }

  private showSideInfo(btn: HTMLButtonElement) {
    const box = document.getElementById("side-info");
    if (!box) return;
    if (this.hoveredBtn && this.hoveredBtn !== btn) {
      this.hoveredBtn.classList.remove("inspected");
    }
    this.hoveredBtn = btn;
    btn.classList.add("inspected");

    const kind = btn.dataset.kind as BuildingKind | undefined;
    const unit = btn.dataset.unit as UnitKind | undefined;
    const reason = btn.dataset.reason ?? "";
    const reasonKind = btn.dataset.reasonKind ?? "";
    const status = btn.dataset.status ?? "";
    const statusText = btn.dataset.statusText ?? "";

    let title = "";
    let chipsHtml = "";
    let desc = "";

    if (kind) {
      const d = BUILDINGS[kind];
      title = BUILDING_NAMES[kind];
      const pwrHtml =
        d.power !== 0
          ? `<span class="${d.power > 0 ? "si-pwr-pos" : "si-pwr-neg"}">${d.power > 0 ? "+" : ""}${d.power}⚡</span>`
          : "";
      const baseTime = `${d.buildTicks / 10}s`;
      const shownTime = btn.querySelector<HTMLElement>(".btime")?.textContent ?? "";
      const timeLabel = /^\d+(?:\.\d+)?s$/.test(shownTime) ? shownTime : baseTime;
      chipsHtml = `<span class="si-cost">${fmtCost(d.cost)}</span><span class="si-time">${timeLabel}</span>${pwrHtml}`;
      desc = TOOLTIPS[kind] ?? title;
    } else if (unit) {
      const d = UNITS[unit];
      title = label(unit);
      const bt = btn.querySelector<HTMLElement>(".btime")?.textContent ?? `${d.buildTicks / 10}s`;
      const timeLabel = bt === "NO SEA" ? `${d.buildTicks / 10}s` : bt;
      const roleChip = d.kamikaze
        ? `<span class="si-pwr-neg">KAMIKAZE</span>`
        : d.ewJamRadius
          ? `<span class="si-pwr-pos">EW JAM ${Math.round(d.ewJamRadius * 10)}m</span>`
          : "";
      chipsHtml = `<span class="si-cost">${fmtCost(d.cost)}</span><span class="si-time">${timeLabel}</span><span class="si-time">${SHORT_BUILDING_NAMES[d.trainsAt]}</span>${roleChip}`;
      desc = TOOLTIPS[unit] ?? title;
    } else {
      box.classList.add("hidden");
      return;
    }

    let calloutCls = "si-callout";
    let calloutText = "";
    if (reason) {
      calloutCls += " blocked" + (reasonKind === "funds" || reasonKind === "busy" ? " funds" : "");
      calloutText = reason;
    } else if (status === "building" || status === "training") {
      calloutCls += " busy";
      calloutText = statusText;
    } else {
      calloutCls += " ready";
      calloutText = statusText || (kind ? "Ready to build — click to start." : "Click to train · Shift+click ×5.");
    }

    box.innerHTML =
      `<div class="si-head"><span class="si-name">${esc(title)}</span></div>` +
      `<div class="si-chips">${chipsHtml}</div>` +
      `<div class="si-desc">${esc(desc)}</div>` +
      `<div class="${calloutCls}">${esc(calloutText)}</div>`;
    box.classList.remove("hidden");
  }

  hideSideInfo() {
    if (this.hoveredBtn) {
      this.hoveredBtn.classList.remove("inspected");
      this.hoveredBtn = null;
    }
    document.getElementById("side-info")?.classList.add("hidden");
  }

  updateSidebar(
    state: PlayerState | null,
    has: (k: string) => boolean,
    countOf?: (k: BuildingKind) => number,
    config: GameConfig = DEFAULT_CONFIG,
    hasWater = true,
  ) {
    const applyReason = (
      b: HTMLButtonElement,
      shortReason: string,
      detail: string,
      reasonKind: "" | "lock" | "funds" | "busy" | "limit",
      status: "ready" | "building" | "training" | "avail" | "blocked",
      statusText = "",
    ) => {
      const tag = b.querySelector<HTMLElement>(".req-tag");
      if (tag) tag.textContent = shortReason;
      if (detail) b.dataset.reason = detail;
      else delete b.dataset.reason;
      if (reasonKind) b.dataset.reasonKind = reasonKind;
      else delete b.dataset.reasonKind;
      b.dataset.status = status;
      if (statusText) b.dataset.statusText = statusText;
      else delete b.dataset.statusText;
    };

    // Forward Supply Hubs are visible own entities, so the client can predict
    // the deterministic construction-speed multiplier exactly without another
    // snapshot field. The server remains authoritative for the actual tick rate.
    const constructionBoost = multiProducerBoost(countOf?.("supplyhub") ?? 0);
    const powerRate = state?.lowPower ? 0.5 : 1;
    const buildSpeed = constructionBoost * powerRate;
    const buildTimeText = (ticks: number) => fmtWorkTime(ticks, buildSpeed);
    const buildTip = (kind: BuildingKind, missing?: BuildingKind[]) =>
      this.buildTooltip(kind, missing, constructionBoost, powerRate);
    const canConstruct = has("conyard") || has("supplyhub");

    for (const [kind, b] of this.buildBtns) {
      const d = BUILDINGS[kind];
      const cat = buildCategoryOf(kind);
      const isDef = cat === "defense";
      const readyArr = isDef ? (state?.awaitingDef ?? []) : (state?.awaiting ?? []);
      const queueArr = isDef ? (state?.dq ?? []) : (state?.bq ?? []);
      const readyCount = readyArr.filter((k2) => k2 === kind).length;
      const queueIdx = queueArr.findIndex((i) => i.kind === kind);
      const queueCount = queueArr.filter((i) => i.kind === kind).length;
      const qBadge = b.querySelector<HTMLElement>(".qcount");
      const totalQueued = readyCount + queueCount;
      if (qBadge) {
        qBadge.textContent = totalQueued > 0 ? `×${totalQueued}` : "";
        qBadge.classList.toggle("hidden", totalQueued === 0);
      }
      const qpos = b.querySelector<HTMLElement>(".qpos");
      if (qpos) {
        qpos.textContent = queueIdx >= 0 ? `#${queueIdx + 1}` : "";
        qpos.classList.toggle("hidden", queueIdx < 0);
        qpos.classList.toggle("head", queueIdx === 0);
      }
      // Owned-count chip — how many of this building you ALREADY have on the
      // field, so nobody queues an accidental duplicate. Upgraded tiers count
      // toward their base kind (a Fusion Reactor is still a power plant you
      // own); in-production / awaiting-placement items append as "+N" since the
      // queue is exactly the accidental-duplicate path. Hidden when you own
      // none (zero is the default state — no visual noise) or when spectating.
      const ownBadge = b.querySelector<HTMLElement>(".owncount");
      if (ownBadge) {
        let owned = 0;
        if (state && countOf) {
          let cur: BuildingKind | undefined = kind;
          const seen = new Set<BuildingKind>();
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            owned += countOf(cur);
            cur = UPGRADE_PATHS[cur]?.to;
          }
        }
        const show = state != null && owned > 0;
        ownBadge.textContent = show ? `${owned}${totalQueued > 0 ? `+${totalQueued}` : ""}` : "";
        ownBadge.classList.toggle("hidden", !show);
        ownBadge.title = show
          ? `You own ${owned} ${BUILDING_NAMES[kind]}${owned > 1 ? "s" : ""}${totalQueued > 0 ? ` (+${totalQueued} in production)` : ""}`
          : "";
      }
      b.classList.remove("ready", "locked");
      delete b.dataset.busy;
      b.disabled = false;
      const prog = b.querySelector<HTMLElement>(".prog")!;
      const bt = b.querySelector<HTMLElement>(".btime")!;
      prog.style.width = "0%";
      bt.textContent = buildTimeText(d.buildTicks);
      if (kind === "superweapon" && !config.superweapons) {
        b.classList.add("locked");
        b.disabled = true;
        bt.textContent = "OFF";
        const detail = "Superweapons are disabled in match settings.";
        b.title = detail;
        applyReason(b, "Disabled", detail, "limit", "blocked");
        continue;
      }
      if (d.waterOnly && !hasWater) {
        b.classList.add("locked");
        b.disabled = true;
        bt.textContent = "NO WATER";
        const detail =
          "Naval Shipyard requires navigable water — pick a naval map marked with ⚓ (Bridgehead Crossing, Pacific Atoll, Storm Coast, Sunken Atlantis, Titan Graveyard, Caldera Forge, Offshore Megarig, Coral Sea Theatre, Polar Sea Front, Eurasia Supertheater).";
        b.title = `${buildTip(kind)} · ${detail}`;
        applyReason(b, "No water", detail, "lock", "blocked");
        continue;
      }
      if (!state) {
        b.disabled = true;
        b.title = buildTip(kind);
        applyReason(b, "", "", "", "blocked");
        continue;
      }
      if (!canConstruct) {
        b.classList.add("locked");
        b.disabled = true;
        const detail = isDef
          ? "Lost Construction Yard and no Forward Supply Hub — cannot build defenses."
          : "Lost Construction Yard and no Forward Supply Hub — cannot build structures.";
        b.title = `${buildTip(kind)} · ${detail}`;
        applyReason(b, "Need ConYard/Hub", detail, "busy", "blocked");
        continue;
      }
      if (readyCount > 0) {
        b.classList.add("ready");
        bt.textContent = "READY";
        b.title = buildTip(kind);
        applyReason(
          b,
          "Click to place",
          `Finished (×${readyCount}) — click (or press B) to place · right-click here to cancel & refund.`,
          "",
          "ready",
          "Finished — click (or press B) to place · right-click to cancel & refund.",
        );
        continue;
      }
      if (queueIdx >= 0) {
        b.dataset.busy = "1";
        const head = queueArr[queueIdx];
        if (queueIdx === 0) {
          prog.style.width = `${(1 - head.left / head.total) * 100}%`;
          bt.textContent = fmtWorkTime(head.left, buildSpeed);
          applyReason(b, "", "", "", "building", `Constructing (×${queueCount} queued) — right-click to cancel & refund.`);
        } else {
          bt.textContent = ""; // position now shown by .qpos badge
          applyReason(b, "", "", "", "building", `Queued #${queueIdx + 1} — right-click to cancel & refund.`);
        }
        b.title = buildTip(kind);
        continue;
      }
      if (d.limit !== undefined && countOf && countOf(kind) + totalQueued >= d.limit) {
        b.disabled = true;
        bt.textContent = "MAX";
        const detail = `Limit reached — you can only have ${d.limit} ${BUILDING_NAMES[kind]} at a time.`;
        b.title = `${buildTip(kind)} · ${detail}`;
        applyReason(b, `Max ${d.limit} built`, detail, "limit", "blocked");
        continue;
      }
      const missing = d.requires?.filter((r) => !has(r)) ?? [];
      b.title = buildTip(kind, missing);
      if (missing.length) {
        const chain = missingPrereqChain(d.requires ?? [], has);
        const detail = `Locked — Build first: ${formatChainSteps(chain).join(" → ")}.`;
        b.classList.add("locked");
        b.disabled = true;
        applyReason(b, formatShortNeed(missing), detail, "lock", "blocked");
        continue;
      }
      if (state.credits < d.cost) {
        b.disabled = true;
        const detail = `Insufficient funds — need ${fmtCost(d.cost)} (have ${fmtCost(Math.floor(state.credits))}). Build Refineries/Harvesters or capture Oil Derricks & Coal Mines.`;
        applyReason(b, `Need ${fmtCost(d.cost)}`, detail, "funds", "blocked");
        continue;
      }
      applyReason(b, "", "", "", "avail", "Ready to build — click to start.");
    }

    // Sticky ready-to-place banners at top of sidebar (both Structure & Defense can sit ready simultaneously!)
    const readyList = state?.awaiting ?? [];
    this.readyAwaiting = readyList[0] ?? null;
    const readyPill = document.getElementById("ready-pill");
    if (readyPill) {
      if (this.readyAwaiting && !this.spectating && !this.fpvMode) {
        readyPill.classList.remove("hidden");
        readyPill.textContent = `▶ READY: ${BUILDING_NAMES[this.readyAwaiting].toUpperCase()}${readyList.length > 1 ? ` ×${readyList.length}` : ""} [B]`;
      } else {
        readyPill.classList.add("hidden");
      }
    }

    const readyDefList = state?.awaitingDef ?? [];
    this.readyAwaitingDef = readyDefList[0] ?? null;
    const readyDefPill = document.getElementById("ready-def-pill");
    if (readyDefPill) {
      if (this.readyAwaitingDef && !this.spectating && !this.fpvMode) {
        readyDefPill.classList.remove("hidden");
        readyDefPill.textContent = `▶ DEFENSE: ${BUILDING_NAMES[this.readyAwaitingDef].toUpperCase()}${readyDefList.length > 1 ? ` ×${readyDefList.length}` : ""} [B]`;
      } else {
        readyDefPill.classList.add("hidden");
      }
    }

    // Multi-producer speed badge on ARMY header (construction + all 4 unit categories)
    const boostEl = document.getElementById("prod-boost");
    const bBoost = state?.prodBoost?.barracks ?? 1;
    const fBoost = state?.prodBoost?.factory ?? 1;
    const aBoost = state?.prodBoost?.airfield ?? 1;
    const sBoost = state?.prodBoost?.shipyard ?? 1;
    if (boostEl) {
      const active: { short: string; key: string; name: string; mult: number }[] = [];
      if (constructionBoost > 1.01) {
        active.push({ short: "BLD", key: "C", name: "Forward Supply Hub construction", mult: constructionBoost });
      }
      if (bBoost > 1.01) active.push({ short: "INF", key: "B", name: "Barracks", mult: bBoost });
      if (fBoost > 1.01) active.push({ short: "VEH", key: "F", name: "War Factory", mult: fBoost });
      if (aBoost > 1.01) active.push({ short: "AIR", key: "A", name: "Air Command", mult: aBoost });
      if (sBoost > 1.01) active.push({ short: "SEA", key: "S", name: "Naval Shipyard", mult: sBoost });
      if (active.length) {
        const allEqual = active.every((x) => Math.abs(x.mult - active[0].mult) < 0.01);
        if (active.length === 1) {
          boostEl.textContent = `${active[0].short} ${fmtBoost(active[0].mult)}`;
        } else if (allEqual) {
          boostEl.textContent = fmtBoost(active[0].mult);
        } else if (active.length === 2) {
          boostEl.textContent = active.map((x) => `${x.key} ${fmtBoost(x.mult)}`).join(" · ");
        } else {
          const maxMult = Math.max(...active.map((x) => x.mult));
          boostEl.textContent = `${active.length}× ${fmtBoost(maxMult)}`;
        }
        boostEl.title = `Multi-structure speed bonus: ${active.map((x) => `${x.name} ${fmtBoost(x.mult)}`).join(", ")}`;
        boostEl.classList.remove("hidden");
      } else {
        boostEl.classList.add("hidden");
      }
    }

    const seaHdr = this.trainGroupHeaders.get("sea");
    if (seaHdr) {
      seaHdr.classList.toggle("no-water", !hasWater);
      seaHdr.textContent = hasWater ? "NAVY" : "NAVY · NO WATER";
    }

    for (const [unit, b] of this.trainBtns) {
      const d = UNITS[unit];
      const prog = b.querySelector<HTMLElement>(".prog")!;
      const bt = b.querySelector<HTMLElement>(".btime")!;
      const cat = d.trainsAt;
      const mult = state?.prodBoost?.[cat] ?? 1;
      const qBadge = b.querySelector<HTMLElement>(".qcount");
      const qpos = b.querySelector<HTMLElement>(".qpos");
      prog.style.width = "0%";
      // Badges persist across frames now — reset them up-front so early exits
      // (locked / no state) don't leave stale ×N / #N chips on the button.
      if (qBadge) {
        qBadge.textContent = "";
        qBadge.classList.add("hidden");
      }
      if (qpos) {
        qpos.textContent = "";
        qpos.classList.add("hidden");
        qpos.classList.remove("head");
      }
      b.classList.remove("locked");
      b.disabled = true;
      if (d.domain === "sea" && !hasWater) {
        b.classList.add("locked");
        bt.textContent = "NO SEA";
        const detail = "Navy units require a Naval Shipyard on a naval map.";
        b.title = `${TOOLTIPS[unit] ?? label(unit)} · ${detail}`;
        applyReason(b, "No water", detail, "lock", "blocked");
        continue;
      }
      const trainSpeed = mult * powerRate;
      const trainNotes: string[] = [];
      if (mult > 1.01) trainNotes.push(`${fmtBoost(mult)} production`);
      if (powerRate < 0.99) trainNotes.push(`low power ${fmtBoost(powerRate)}`);
      const baseTrainSecs = d.buildTicks / 10;
      const trainTimeText = trainNotes.length
        ? `${fmtWorkTime(d.buildTicks, trainSpeed)} (base ${baseTrainSecs}s, ${trainNotes.join(", ")})`
        : `${baseTrainSecs}s`;
      const baseTitle = `${TOOLTIPS[unit] ?? label(unit)} · ${trainTimeText} to train · Shift+click = ×5`;
      b.title = baseTitle;
      bt.textContent = fmtWorkTime(d.buildTicks, trainSpeed);
      if (!state) {
        applyReason(b, "", "", "", "blocked");
        continue;
      }
      if (!has(cat) || (d.requires && !has(d.requires))) {
        b.classList.add("locked");
        const upPathForCat = d.requires && UPGRADE_PATHS[cat]?.to === d.requires ? UPGRADE_PATHS[cat] : undefined;
        const directReqs: BuildingKind[] = upPathForCat
          ? [upPathForCat.to]
          : d.requires
            ? [cat, d.requires]
            : [cat];
        const directMissing = directReqs.filter((r) => !has(r));
        const chain = missingPrereqChain(directReqs, has);
        let detail: string;
        if (upPathForCat && chain.includes(upPathForCat.to)) {
          const beforeUpgrade = chain.filter((k) => k !== upPathForCat.to);
          const fromName = BUILDING_NAMES[upPathForCat.from];
          const toName = BUILDING_NAMES[upPathForCat.to].toUpperCase();
          detail = beforeUpgrade.length
            ? `Locked — Build first: ${formatChainSteps(beforeUpgrade).join(" → ")} → then select ${fromName} and click UPGRADE → ${toName} (${fmtCost(upPathForCat.cost)}).`
            : `Locked — Select your ${fromName} and click UPGRADE → ${toName} (${fmtCost(upPathForCat.cost)}).`;
        } else {
          detail = `Locked — Build first: ${formatChainSteps(chain).join(" → ")}.`;
        }
        b.title = `${baseTitle} · Requires: ${directMissing.map((m) => BUILDING_NAMES[m]).join(", ")}`;
        applyReason(b, formatShortNeed(directMissing), detail, "lock", "blocked");
        continue;
      }
      const arr = state.queues[cat];
      const myIdx = arr ? arr.findIndex((i) => i.unit === unit) : -1;
      const myCount = arr ? arr.filter((i) => i.unit === unit).length : 0;
      if (qBadge) {
        qBadge.textContent = myCount > 0 ? `×${myCount}` : "";
        qBadge.classList.toggle("hidden", myCount === 0);
      }
      if (qpos) {
        qpos.textContent = myIdx >= 0 ? `#${myIdx + 1}` : "";
        qpos.classList.toggle("hidden", myIdx < 0);
        qpos.classList.toggle("head", myIdx === 0);
      }
      if (arr?.length && myIdx >= 0) {
        const head = arr[0];
        if (myIdx === 0) {
          prog.style.width = `${(1 - head.left / head.total) * 100}%`;
          bt.textContent = fmtWorkTime(head.left, trainSpeed);
        } else {
          bt.textContent = ""; // position now shown by .qpos badge
        }
        if (arr.length >= TRAIN_QUEUE_MAX) {
          applyReason(b, "Queue full", `Production queue full (max ${TRAIN_QUEUE_MAX}).`, "busy", "blocked");
          continue;
        }
        if (state.credits < d.cost) {
          const detail = `Insufficient funds — need ${fmtCost(d.cost)} (have ${fmtCost(Math.floor(state.credits))}).`;
          applyReason(b, `Need ${fmtCost(d.cost)}`, detail, "funds", "blocked");
          continue;
        }
        b.disabled = false;
        applyReason(
          b,
          "",
          "",
          "",
          "training",
          `Training (×${myCount}, queue ${arr.length}/${TRAIN_QUEUE_MAX}) — click to queue more · Shift+click ×5 · Right-click to cancel.`,
        );
        continue;
      }
      if (arr?.length && arr.length >= TRAIN_QUEUE_MAX) {
        applyReason(b, "Queue full", `Production queue full (max ${TRAIN_QUEUE_MAX}).`, "busy", "blocked");
        continue;
      }
      if (state.credits < d.cost) {
        const detail = `Insufficient funds — need ${fmtCost(d.cost)} (have ${fmtCost(Math.floor(state.credits))}).`;
        applyReason(b, `Need ${fmtCost(d.cost)}`, detail, "funds", "blocked");
        continue;
      }
      b.disabled = false;
      applyReason(b, "", "", "", "avail", "Click to train · Shift+click ×5.");
    }

    if (this.hoveredBtn && this.hoveredBtn.isConnected) {
      this.showSideInfo(this.hoveredBtn);
    }
  }

  updateGroups(groups: Map<number, Set<number>>, tracked: Renderer["tracked"], mySlot: number) {
    const bar = document.getElementById("groupbar");
    if (!bar) return;
    const nums = [...groups.keys()].sort((a, b) => a - b);
    const entries: [number, number][] = [];
    for (const n of nums) {
      const ids = groups.get(n)!;
      let count = 0;
      for (const id of ids) if (tracked.get(id)?.last.o === mySlot) count++;
      if (count) entries.push([n, count]);
    }
    const sig = entries.map(([n, c]) => `${n}:${c}`).join(",");
    if (sig === this.groupSig) return;
    this.groupSig = sig;
    bar.innerHTML = "";
    for (const [n, count] of entries) {
      const b = document.createElement("button");
      b.className = "gbtn";
      b.title = `Group ${n} (${count}) — click to select, double-click to center`;
      b.innerHTML = `<kbd>${n}</kbd><span>${count}</span>`;
      b.addEventListener("click", () => {
        const now = performance.now();
        const dbl = this.lastGroupClick.n === n && now - this.lastGroupClick.t < 420;
        this.lastGroupClick = { n, t: now };
        this.onGroupClick?.(n, dbl);
      });
      bar.appendChild(b);
    }
  }

  updateSelInfo(
    sel: Set<number>,
    tracked: Renderer["tracked"],
    mySlot: number,
    state?: PlayerState | null,
    has?: (k: string) => boolean,
  ) {
    const box = el("selinfo");
    if (!sel.size) {
      if (this.selSig !== "") {
        this.selSig = "";
        box.innerHTML = "";
      }
      return;
    }
    const counts = new Map<string, number>();
    let hpSum = 0,
      hpMax = 0,
      maxVet = 0,
      anyHold = false,
      anyKamikaze = false,
      anyEwJam = false;
    let minFuel: number | null = null;
    let minAmmo: number | null = null;
    let singleId: number | null = null;
    let singleKind: EntKind | null = null;
    for (const id of sel) {
      const t = tracked.get(id);
      if (!t) continue;
      // Owner sees their disguised spy's real kind; enemies still see the rifleman cover
      const effK = t.last.disg && t.last.o === mySlot ? t.last.disg : t.last.k;
      counts.set(effK, (counts.get(effK) ?? 0) + 1);
      hpSum += t.last.hp;
      hpMax += t.last.mhp;
      if ((t.last.vet ?? 0) > maxVet) maxVet = t.last.vet ?? 0;
      if (t.last.hold) anyHold = true;
      if (!isBuildingKind(t.last.k)) {
        const ud = UNITS[t.last.k as UnitKind];
        if (ud?.kamikaze) anyKamikaze = true;
        if (ud?.ewJamRadius) anyEwJam = true;
      }
      if (t.last.fl !== undefined && t.last.fl < 100) {
        const v = Math.max(0, Math.round(t.last.fl));
        if (minFuel === null || v < minFuel) minFuel = v;
      }
      if (t.last.am !== undefined && t.last.am < 100) {
        const v = Math.max(0, Math.round(t.last.am));
        if (minAmmo === null || v < minAmmo) minAmmo = v;
      }
      if (sel.size === 1 && t.last.o === mySlot) {
        singleId = id;
        singleKind = effK;
      }
    }
    if (!hpMax) {
      if (this.selSig !== "") {
        this.selSig = "";
        box.innerHTML = "";
      }
      return;
    }

    const upPath = singleKind ? UPGRADE_PATHS[singleKind] : undefined;
    const hasReq = upPath ? (has ? has(upPath.requires) : true) : true;
    const canAfford = upPath && state ? state.credits >= upPath.cost : true;
    const reqChain = upPath && !hasReq && has ? missingPrereqChain([upPath.requires], has) : [];
    const sig =
      [...counts].map(([k, n]) => `${k}:${n}`).join(",") +
      `|${singleId ?? ""}|${singleKind ?? ""}|${hasReq ? 1 : 0}|${canAfford ? 1 : 0}|${reqChain.join(">")}|v${maxVet}|h${anyHold ? 1 : 0}|k${anyKamikaze ? 1 : 0}|e${anyEwJam ? 1 : 0}`;

    // Only rebuild DOM structure when selection or upgrade readiness actually changes
    // (prevents 5Hz innerHTML destruction from eating clicks on the UPGRADE button)
    if (sig !== this.selSig) {
      this.selSig = sig;
      const multiTypes = counts.size > 1;
      const parts = [...counts]
        .map(([k, n]) => {
          const ic = this.iconFor(k);
          const img = ic ? `<img class="si-icon" src="${ic}">` : "";
          const cls = multiTypes ? ` class="si-filter" data-filter-kind="${k}" title="Click to select only ${label(k as BuildingKind | UnitKind as never)}"` : "";
          return `<span${cls}>${img}${n}× ${label(k as BuildingKind | UnitKind as never)}</span>`;
        })
        .join("");
      const vetBadge =
        maxVet > 0
          ? `<span class="si-vet" title="Veterancy rank ${maxVet}">${"★".repeat(Math.min(3, maxVet))}</span>`
          : "";
      const holdBadge = anyHold
        ? `<span class="si-hold" title="Holding position — fires in range without chasing">[HOLD]</span>`
        : "";
      const kamikazeBadge = anyKamikaze
        ? `<span class="si-logi-chip crit" title="Kamikaze drone — self-detonates on strike for heavy splash damage">[KAMIKAZE]</span>`
        : "";
      const ewJamBadge = anyEwJam
        ? `<span class="si-hold" title="Electronic Warfare jammer — disrupts enemy drones within 85m">[EW JAM]</span>`
        : "";
      box.innerHTML = `<div class="si-row">${parts}${vetBadge}${holdBadge}${kamikazeBadge}${ewJamBadge}</div><div class="si-hp"><i></i><span></span></div><div class="si-logi hidden"></div>`;
      if (multiTypes) {
        for (const chip of box.querySelectorAll<HTMLElement>(".si-filter[data-filter-kind]")) {
          chip.addEventListener("click", () => {
            const k = chip.dataset.filterKind;
            if (k) this.onFilterSelection?.(k);
          });
        }
      }

      const isMk2 =
        singleKind === "barracks2" ||
        singleKind === "factory2" ||
        singleKind === "airfield2" ||
        singleKind === "shipyard2";
      if (singleId !== null && upPath) {
        const b = document.createElement("button");
        b.className = "sbtn si-upgrade";
        b.disabled = !hasReq || !canAfford;
        const reqName = BUILDING_NAMES[upPath.requires];
        const toName = BUILDING_NAMES[upPath.to].toUpperCase();
        b.textContent = !hasReq
          ? `UPGRADE → ${toName} (NEEDS ${reqName.toUpperCase()})`
          : `UPGRADE → ${toName} (${fmtCost(upPath.cost)})`;
        b.title = !hasReq
          ? reqChain.length
            ? `Locked — Build first: ${formatChainSteps(reqChain).join(" → ")}.`
            : `Locked — Build a ${reqName} first.`
          : !canAfford
            ? `Insufficient funds — need ${fmtCost(upPath.cost)} (have ${fmtCost(Math.floor(state?.credits ?? 0))}).`
            : upPath.desc;
        b.addEventListener("click", () => this.onUpgrade?.(singleId!));
        box.appendChild(b);
      } else if (singleId !== null && isMk2) {
        const d = document.createElement("div");
        d.className = "si-mk2";
        d.textContent = "★ MKII";
        box.appendChild(d);
      } else if (singleId !== null && singleKind !== null && !isBuildingKind(singleKind)) {
        const uk = singleKind as UnitKind;
        const udef = UNITS[uk];
        const b = document.createElement("button");
        b.id = "fpv-btn";
        b.type = "button";
        b.className = "sbtn si-fpv";
        b.textContent =
          udef?.domain === "air"
            ? udef.kamikaze || udef.ewJamRadius || uk === "uav"
              ? "▶ PILOT DRONE [E]"
              : "▶ PILOT AIRCRAFT [E]"
            : udef?.domain === "sea"
              ? udef.kamikaze
                ? "▶ PILOT USV DRONE [E]"
                : "▶ COMMAND VESSEL [E]"
              : udef?.trainsAt === "barracks"
                ? "▶ FIRST-PERSON FPS [E]"
                : "▶ DRIVE VEHICLE [E]";
        b.title = "Enter First-Person POV (E) — WASD move, Mouse aim, Left-Click fire, E/Esc exit";
        b.addEventListener("click", () => this.onEnterFpv?.(singleId!));
        box.appendChild(b);
      }
    }

    // Always update HP bar & logistics Fuel/Ammo indicators smoothly in place
    const bar = box.querySelector<HTMLElement>(".si-hp i");
    const txt = box.querySelector<HTMLElement>(".si-hp span");
    if (bar) bar.style.width = `${Math.round((hpSum / hpMax) * 100)}%`;
    if (txt) txt.textContent = `HP ${Math.round(hpSum)} / ${hpMax}`;
    const logi = box.querySelector<HTMLElement>(".si-logi");
    if (logi) {
      const chips: string[] = [];
      if (minFuel !== null) {
        const cls = minFuel < 15 ? " crit" : minFuel < 35 ? " warn" : "";
        chips.push(
          `<span class="si-logi-chip${cls}" title="Fuel level — resupply near Forward Supply Hub, Supply Convoy, or base">FUEL ${minFuel}%</span>`,
        );
      }
      if (minAmmo !== null) {
        const cls = minAmmo < 15 ? " crit" : minAmmo < 35 ? " warn" : "";
        chips.push(
          `<span class="si-logi-chip${cls}" title="Ammo level — resupply near Forward Supply Hub, Supply Convoy, or base">AMMO ${minAmmo}%</span>`,
        );
      }
      if (chips.length) {
        logi.innerHTML = chips.join("");
        logi.classList.remove("hidden");
      } else {
        logi.innerHTML = "";
        logi.classList.add("hidden");
      }
    }
  }

  showHoverTip(ent: EntSnap | null, crate: CrateSnap | null, x: number, y: number) {
    const tip = document.getElementById("hover-tip");
    if (!tip) return;
    if (!ent && !crate) {
      tip.classList.add("hidden");
      return;
    }
    if (ent) {
      if (ent.o === -1 && ent.k === "derrick") {
        tip.innerHTML = `<span class="ht-dot" style="background:#ffc43d"></span><span>Oil Derrick — Capture with Combat Engineer (+$25/s)</span>`;
      } else if (ent.o === -1 && ent.k === "coalmine") {
        tip.innerHTML = `<span class="ht-dot" style="background:#e6b84c"></span><span>Coal Mine — Capture with Combat Engineer (+$20/s &amp; +60⚡)</span>`;
      } else {
        const col = ent.o >= 0 ? PLAYER_COLORS[ent.o] ?? "#8a97a5" : "#8a97a5";
        const name = esc(label(ent.k));
        const udef = !isBuildingKind(ent.k) ? UNITS[ent.k as UnitKind] : null;
        const vet = (ent.vet ?? 0) > 0 ? `<span class="ht-vet">${"★".repeat(Math.min(3, ent.vet!))}</span>` : "";
        const hold = ent.hold ? `<span class="ht-hold">[HOLD]</span>` : "";
        const sub = ent.sub ? `<span class="ht-hold">[SUB]</span>` : "";
        const kamikaze = udef?.kamikaze ? `<span class="ht-logi crit">[KAMIKAZE]</span>` : "";
        const ewJam = udef?.ewJamRadius ? `<span class="ht-hold">[EW JAM]</span>` : "";
        const fuelVal = ent.fl !== undefined && ent.fl < 100 ? Math.max(0, Math.round(ent.fl)) : null;
        const ammoVal = ent.am !== undefined && ent.am < 100 ? Math.max(0, Math.round(ent.am)) : null;
        const fuelSpan =
          fuelVal !== null
            ? `<span class="ht-logi${fuelVal < 15 ? " crit" : fuelVal < 35 ? " warn" : ""}">⛽ ${fuelVal}%</span>`
            : "";
        const ammoSpan =
          ammoVal !== null
            ? `<span class="ht-logi${ammoVal < 15 ? " crit" : ammoVal < 35 ? " warn" : ""}">AMMO ${ammoVal}%</span>`
            : "";
        tip.innerHTML = `<span class="ht-dot" style="background:${col}"></span><span>${name}</span>${vet}${hold}${sub}${kamikaze}${ewJam}<span class="ht-meta">· HP ${Math.round(ent.hp)}/${ent.mhp}</span>${fuelSpan}${ammoSpan}`;
      }
    } else if (crate) {
      tip.innerHTML = `<span class="ht-dot" style="background:#ffc43d"></span><span>Supply Crate — Walk unit over to collect</span>`;
    }
    tip.classList.remove("hidden");
    const w = tip.offsetWidth || 180;
    const h = tip.offsetHeight || 26;
    const lx = Math.max(10, Math.min(window.innerWidth - w - 10, x + 14));
    const ly = y + 18 + h > window.innerHeight - 10 ? Math.max(46, y - h - 10) : Math.max(46, y + 18);
    tip.style.left = `${lx}px`;
    tip.style.top = `${ly}px`;
  }

  hideHoverTip() {
    document.getElementById("hover-tip")?.classList.add("hidden");
  }

  drawMinimap(
    r: Renderer,
    oreCells: Set<number>,
    camX: number,
    camY: number,
    camH: number,
    mySlot: number,
    hasRadar: boolean,
    mapId: MapId = "crossroads",
    lowPower = false,
  ) {
    const now = performance.now();
    if (now - this.mmLast < 160) return;
    this.mmLast = now;
    const ctx = this.mmCtx;
    const layout = getMapLayout(mapId);
    const mw = layout.w || MAP_W;
    const mh = layout.h || MAP_H;
    this.mmW = mw;
    this.mmH = mh;
    const sx = this.minimap.width / mw;
    const sy = this.minimap.height / mh;
    const s = Math.min(sx, sy);
    ctx.fillStyle = "#080e14";
    ctx.fillRect(0, 0, this.minimap.width, this.minimap.height);
    if (mySlot >= 0 && !hasRadar) {
      ctx.fillStyle = "#6e8699";
      ctx.font = '700 11px "Rajdhani", monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("NO RADAR UPLINK", 80, 80);
      return;
    }
    if (mySlot >= 0 && hasRadar && lowPower) {
      // Subtle outage scanlines + amber/red warning instead of live radar dots
      ctx.fillStyle = "rgba(255, 196, 61, 0.045)";
      const shift = Math.floor((now / 90) % 8);
      for (let y = shift; y < 160; y += 8) {
        ctx.fillRect(0, y, 160, 2);
      }
      ctx.strokeStyle = "rgba(255, 84, 84, 0.45)";
      ctx.lineWidth = 1;
      ctx.strokeRect(4.5, 4.5, 151, 151);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = '700 12px "Rajdhani", monospace';
      ctx.fillStyle = "#ffc43d";
      ctx.fillText("LOW POWER —", 80, 71);
      ctx.fillStyle = "#ff5454";
      ctx.fillText("RADAR OFFLINE", 80, 89);
      return;
    }
    const pal = MAP_PREVIEW_PALETTES[mapId] ?? MAP_PREVIEW_PALETTES.crossroads;
    const cw = Math.max(1, Math.ceil(sx));
    const ch = Math.max(1, Math.ceil(sy));
    // Static terrain layers raster once into an offscreen canvas — ore/bridge
    // content hashes invalidate it. Saves ~3-6k fillRects every 160ms tick.
    let oreHash = 0;
    for (const k of oreCells) oreHash = (oreHash * 31 + k) | 0;
    let bridgeHash = this.bridgeSet.size;
    for (const k of this.bridgeSet) bridgeHash = (bridgeHash * 31 + k) | 0;
    const sig = `${mapId}|${mw}x${mh}|${this.minimap.width}|${oreHash}|${bridgeHash}`;
    if (!this.mmStatic || this.mmStaticSig !== sig) {
      if (!this.mmStatic) this.mmStatic = document.createElement("canvas");
      this.mmStatic.width = this.minimap.width;
      this.mmStatic.height = this.minimap.height;
      const sctx = this.mmStatic.getContext("2d")!;
      // Navigable ocean / river water channels
      if (layout.water.length) {
        sctx.fillStyle = pal.water ?? "#19587a";
        for (let i = 0; i < layout.water.length; i++) {
          sctx.fillRect(layout.water[i][0] * sx, layout.water[i][1] * sy, cw, ch);
        }
      }
      // Impassable rocky cliff plateaus
      const cliffs = layout.cliffs;
      sctx.fillStyle = mapId === "volcano" ? "#6b2b18" : mapId === "cybergrid" ? "#1d354a" : "#2a343d";
      for (let i = 0; i < cliffs.length; i++) {
        sctx.fillRect(cliffs[i][0] * sx, cliffs[i][1] * sy, cw, ch);
      }
      // Ore veins
      sctx.fillStyle = "#b58b2e";
      for (const key of oreCells.keys()) {
        sctx.fillRect((key % mw) * sx, ((key / mw) | 0) * sy, Math.max(1.4, sx), Math.max(1.4, sy));
      }
      // Pontoon bridges (tan planks over water)
      if (this.bridgeSet.size) {
        sctx.fillStyle = "#c8a05e";
        for (const key of this.bridgeSet) {
          sctx.fillRect((key % mw) * sx, ((key / mw) | 0) * sy, cw, ch);
        }
      }
      this.mmStaticSig = sig;
    }
    ctx.drawImage(this.mmStatic, 0, 0);
    // Supply crates (pulsing bright white/gold dots)
    if (r.crates && r.crates.size) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.008);
      for (const c of r.crates.values()) {
        ctx.fillStyle = pulse > 0.5 ? "#fff7cc" : "#ffc43d";
        ctx.beginPath();
        ctx.arc(c.x * sx, c.y * sy, 2.2 + pulse * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const t of r.tracked.values()) {
      const e: EntSnap = t.last;
      if (e.o !== mySlot && mySlot >= 0 && !r.isVisible(e.id)) continue;
      if (e.o === -1 && (e.k === "derrick" || e.k === "coalmine")) {
        const mx = e.x * sx;
        const my = e.y * sy;
        const rr = 3.2;
        ctx.beginPath();
        ctx.moveTo(mx, my - rr);
        ctx.lineTo(mx + rr, my);
        ctx.lineTo(mx, my + rr);
        ctx.lineTo(mx - rr, my);
        ctx.closePath();
        ctx.fillStyle = e.k === "derrick" ? "#ffc43d" : "#525e68";
        ctx.fill();
        ctx.strokeStyle = e.k === "derrick" ? "#0b1118" : "#e6b84c";
        ctx.lineWidth = 1.1;
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = e.o >= 0 ? PLAYER_COLORS[e.o] : "#5a6a77";
      const sz = isBuildingKind(e.k) ? Math.max(2.6, BUILDINGS[e.k].w * s) : 2.4;
      ctx.fillRect(e.x * sx - sz / 2, e.y * sy - sz / 2, sz, sz);
    }
    if (this.pinged) {
      const age = now - this.pinged.t;
      if (age < 2400) {
        const rr = 4 + (age % 600) / 45;
        ctx.strokeStyle = `rgba(255,70,60,${1 - age / 2400})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(this.pinged.x * sx, this.pinged.y * sy, rr, 0, Math.PI * 2);
        ctx.stroke();
      } else this.pinged = null;
    }
    const vw = camH * 1.4,
      vh = camH * 1.1;
    ctx.strokeStyle = "rgba(140,220,255,0.65)";
    ctx.lineWidth = 1;
    ctx.strokeRect((camX - vw / 2) * sx, (camY - vh / 2) * sy, vw * sx, vh * sy);
  }
}

function label(k: BuildingKind | UnitKind): string {
  if (isBuildingKind(k)) return BUILDING_NAMES[k];
  return TRAIN_ORDER.find((u) => u.unit === k)?.label ?? k;
}
export { label };

function esc(s: string) {
  return s.replace(/[<>&"]/g, "");
}
