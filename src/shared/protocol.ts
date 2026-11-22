import type { BuildingKind, UnitKind, EntKind, MapId, BotDiff, BotProfile, CrateKind, GameConfig, ProdCat } from "./gamedefs";

// ---------- client -> server ----------
export type C2S =
  | { t: "join"; name: string; token?: string }
  | { t: "ready"; ready: boolean }
  | { t: "start" }
  | { t: "order"; ids: number[]; kind: OrderKind; x: number; y: number; target?: number; queue?: boolean }
  | { t: "stop"; ids: number[] }
  | { t: "hold"; ids: number[] } // toggle Hold Position stance on selected units
  | {
      t: "drive";
      id: number;
      fwd: number; // -1..1 forward/back input
      strafe: number; // -1..1 strafe/turn input
      yaw: number; // facing angle in radians (server map coords)
      fire: boolean;
      aimX?: number;
      aimY?: number;
      aimTarget?: number;
    } // direct first-person WASD + aim/fire control
  | { t: "driveExit"; id: number } // exit first-person control
  | { t: "recon"; x: number; y: number } // fire Radar Uplink Recon Scan (reveals fog)
  | { t: "build"; kind: BuildingKind } // start building production
  | { t: "buildCancel" }
  | { t: "place"; tx: number; ty: number } // place the finished (awaiting) building
  | { t: "train"; unit: UnitKind } // queue one unit
  | { t: "trainCancel"; unit: UnitKind } // dequeue one
  | { t: "sell"; id: number } // sell own building for 50% refund
  | { t: "repair"; id: number } // repair own building to full (25% cost)
  | { t: "upgrade"; id: number } // upgrade factory -> factory2 (needs techlab)
  | { t: "rally"; id: number; x: number; y: number } // set production building rally point
  | { t: "superweapon"; x: number; y: number } // fire Orbital Ion Cannon
  | { t: "resign" } // self-destruct everything you own
  | { t: "chat"; text: string }
  | { t: "ping"; x: number; y: number } // minimap ping for allies
  | { t: "addbot"; diff?: BotDiff; profile?: BotProfile } // host: add an AI player to the lobby
  | { t: "setBotConfig"; id: string; diff?: BotDiff; profile?: BotProfile } // host: tweak bot difficulty/profile
  | { t: "kickbot"; id: string } // host: remove an AI player in lobby
  | { t: "setMap"; map: MapId } // host: pick map in lobby
  | { t: "setConfig"; config: Partial<GameConfig> } // host: adjust match rules in lobby
  | { t: "setTeam"; team: number; id?: string } // 0 = FFA, 1..4 = Team (host may pass bot id)
  | { t: "setName"; name: string } // change callsign in lobby
  | { t: "rematch" };

export type OrderKind = "move" | "amove" | "attack" | "harvest" | "patrol";
export type WeaponFx = "bullet" | "cannon" | "rocket" | "arty" | "arc" | "melee" | "missile" | "torpedo" | "bomb";

// ---------- server -> client ----------
export interface LobbyPlayer {
  id: string;
  name: string;
  slot: number;
  ready: boolean;
  host: boolean;
  connected: boolean;
  spectator: boolean;
  team: number; // 0 = FFA, 1..4 = Team
  bot?: boolean;
  diff?: BotDiff;
  profile?: BotProfile;
  eliminated?: boolean;
}

export interface EntSnap {
  id: number;
  o: number; // owner slot, -1 = neutral
  k: EntKind;
  x: number;
  y: number;
  hp: number;
  mhp: number;
  d: number; // facing, radians * 10 quantized
  cargo?: number;
  vet?: number; // 0..3 veterancy rank
  hold?: boolean; // unit holding position (fires in range, will not chase)
  sub?: boolean; // submarine currently submerged (stealth)
  rally?: [number, number]; // rally point on production buildings
  wp?: [number, number, OrderKind][]; // active + queued waypoints
}

export interface CrateSnap {
  id: number;
  x: number;
  y: number;
  kind: CrateKind;
}

export interface ProdQueue {
  unit: UnitKind;
  left: number;
  total: number;
  count: number;
}

export interface PlayerState {
  slot: number;
  credits: number;
  pwrHave: number;
  pwrUse: number;
  lowPower: boolean;
  eliminated: boolean;
  awaiting: BuildingKind | null; // building finished, waiting for placement
  bq: { kind: BuildingKind; left: number; total: number } | null;
  queues: Partial<Record<ProdCat, ProdQueue>>;
  team?: number;
  swReady?: boolean;
  swLeft?: number; // ticks remaining on Ion Uplink
  swTotal?: number;
  reconReady?: boolean;
  reconLeft?: number; // ticks remaining on Radar Recon Scan
  reconTotal?: number;
  prodBoost?: Partial<Record<ProdCat, number>>; // speed multiplier (1.0 .. 2.0)
}

export interface MatchStats {
  slot: number;
  name: string;
  team: number;
  unitsBuilt: number;
  unitsLost: number;
  bldDestroyed: number;
  creditsEarned: number;
}

export type GameEvent =
  | { e: "shot"; fx: number; fy: number; tx: number; ty: number; w?: WeaponFx; src?: number; vet?: number }
  | { e: "boom"; x: number; y: number; r: number }
  | { e: "spawn"; id: number }
  | { e: "ore"; cells: [number, number, number][] } // [x,y,amountLeft]
  | { e: "alert"; slot: number; x: number; y: number } // under-attack warning for `slot`
  | { e: "cap"; x: number; y: number; slot: number } // building captured, slot = new owner
  | { e: "elim"; slot: number }
  | { e: "superweapon"; x: number; y: number; slot: number }
  | { e: "recon"; x: number; y: number; slot: number; r: number }
  | { e: "promote"; id: number; vet: number; x: number; y: number; slot: number }
  | { e: "crate"; x: number; y: number; kind: CrateKind; slot: number; text: string }
  | { e: "income"; x: number; y: number; amt: number; slot: number }
  | { e: "hit"; id: number };

export type S2C =
  | { t: "lobby"; players: LobbyPlayer[]; you: string; room: string; map: MapId; config?: GameConfig }
  | {
      t: "init";
      you: string;
      slot: number;
      w: number;
      h: number;
      map: MapId;
      config?: GameConfig;
      ore: [number, number, number][];
      players: { id: string; slot: number; name: string; team: number }[];
    }
  | {
      t: "snap";
      tick: number;
      ents: EntSnap[];
      crates?: CrateSnap[];
      players: Record<number, PlayerState>; // keyed by slot
      events: GameEvent[];
    }
  | {
      t: "end";
      winner: number | null;
      winnerTeam?: number | null;
      reason: string;
      durationSec?: number;
      stats?: MatchStats[];
    }
  | { t: "chat"; name: string; color: string; text: string }
  | { t: "ping"; x: number; y: number; slot: number }
  | { t: "deny"; msg: string };

export const partyName = "game-room";
