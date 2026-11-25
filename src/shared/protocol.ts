import type { BuildingKind, BuildCategory, UnitKind, EntKind, MapId, BotDiff, BotProfile, CrateKind, GameConfig, ProdCat } from "./gamedefs";

// ---------- client -> server ----------
export type C2S =
  | { t: "join"; name: string; token?: string; spectate?: boolean; v?: number } // v: 2 = delta-stream capable
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
      alt?: number; // -1..1 climb/dive input (aircraft pitch-to-climb)
      sprint?: boolean; // sprint/flank/boost throttle — faster, burns extra fuel
      wpn?: number; // selected weapon slot 0..2 on multi-weapon platforms (AC-130)
      lock?: number; // persistent missile/guided lock-on target entity id (0/undefined = none)
    } // direct first-person WASD + aim/fire control
  | { t: "driveExit"; id: number } // exit first-person control
  | { t: "recon"; x: number; y: number } // fire Radar Uplink Recon Scan (reveals fog)
  | { t: "build"; kind: BuildingKind } // start building or defense production (parallel queues!)
  | { t: "buildCancel"; cat?: BuildCategory; index?: number; awaiting?: boolean; kind?: BuildingKind } // cancel queued (index/kind) or ready-pile (awaiting) item
  | { t: "place"; tx: number; ty: number; cat?: BuildCategory; kind?: BuildingKind } // place finished structure or defense
  | { t: "train"; unit: UnitKind } // queue one unit
  | { t: "trainCancel"; unit?: UnitKind; cat?: ProdCat; index?: number } // dequeue one (by kind, or by cat+index)
  | { t: "bridge"; id: number; tx: number; ty: number } // engineer lays a pontoon bridge toward (tx,ty)
  | { t: "sell"; id: number } // sell own building for 50% refund
  | { t: "repair"; id: number } // repair own building to full (25% cost)
  | { t: "upgrade"; id: number } // upgrade factory -> factory2 (needs techlab)
  | { t: "rally"; id: number; x: number; y: number } // set production building rally point
  | { t: "superweapon"; x: number; y: number } // fire Orbital Ion Cannon
  | { t: "resign" } // self-destruct everything you own
  | { t: "pause"; paused: boolean } // freeze sim — only honored when you're the sole human (solo / vs-bots)
  | { t: "chat"; text: string }
  | { t: "ping"; x: number; y: number } // minimap ping for allies
  | { t: "addbot"; diff?: BotDiff; profile?: BotProfile } // host: add an AI player to the lobby
  | { t: "setBotConfig"; id: string; diff?: BotDiff; profile?: BotProfile } // host: tweak bot difficulty/profile
  | { t: "kickbot"; id: string } // host: remove an AI player in lobby
  | { t: "transferHost"; id: string } // host: transfer host to another player
  | { t: "setMap"; map: MapId } // host: pick map in lobby
  | { t: "setConfig"; config: Partial<GameConfig> } // host: adjust match rules in lobby
  | { t: "setTeam"; team: number; id?: string } // 0 = FFA, 1..4 = Team (host may pass bot id)
  | { t: "setName"; name: string } // change callsign in lobby
  | { t: "rematch" }
  | { t: "hb" }; // lightweight keepalive heartbeat

export type OrderKind = "move" | "amove" | "attack" | "harvest" | "patrol" | "bridge";
export type WeaponFx =
  | "bullet"
  | "cannon"
  | "rocket"
  | "arty"
  | "arc"
  | "melee"
  | "missile"
  | "torpedo"
  | "bomb"
  | "laser"
  | "railgun"
  | "brrrt"
  | "intercept";

// ---------- server -> client ----------
export interface RoomSummary {
  room: string;
  phase: "lobby" | "playing" | "ended";
  map: MapId;
  players: number;
  humans: number;
  bots: number;
  spectators: number;
  tick: number;
  ents: number;
  names: string[];
  updatedAt: number;
}

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
  fl?: number; // fuel 0..100 (omitted when 100 or logistics off)
  am?: number; // ammo 0..100 (omitted when 100 or logistics off)
  vet?: number; // 0..3 veterancy rank
  hold?: boolean; // unit holding position (fires in range, will not chase)
  sub?: boolean; // submarine currently submerged (stealth)
  alt?: number; // normalized altitude 0..1 for player-driven aircraft (0.6 = cruise)
  rally?: [number, number]; // rally point on production buildings
  wp?: [number, number, OrderKind][]; // active + queued waypoints
  disg?: EntKind; // real kind when this ent is disguised (spy shows k:"infantry")
}

export interface CrateSnap {
  id: number;
  x: number;
  y: number;
  kind: CrateKind;
}

// Sparse per-entity delta: id always present, changed fields carry their new
// value, and null means "this optional field is no longer present" (JSON has
// no undefined, so deletion needs an explicit sentinel).
export type EntDelta = { id: number } & {
  [K in keyof Omit<EntSnap, "id">]?: EntSnap[K] | null;
};

export interface ProdItem {
  unit: UnitKind;
  left: number;
  total: number;
}

export interface PlayerState {
  slot: number;
  credits: number;
  pwrHave: number;
  pwrUse: number;
  lowPower: boolean;
  eliminated: boolean;
  awaiting: BuildingKind[]; // finished structures stacked for placement
  bq: { kind: BuildingKind; left: number; total: number }[]; // head builds, rest queued
  awaitingDef?: BuildingKind[]; // defense finished (parallel queue!), waiting for placement
  dq?: { kind: BuildingKind; left: number; total: number }[];
  queues: Partial<Record<ProdCat, ProdItem[]>>;
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
  | { e: "nukeIntercept"; fx: number; fy: number; tx: number; ty: number; slot: number }
  | { e: "recon"; x: number; y: number; slot: number; r: number }
  | { e: "intercept"; fx: number; fy: number; tx: number; ty: number; slot: number }
  | { e: "ewjam"; fx: number; fy: number; tx: number; ty: number; slot: number }
  | { e: "promote"; id: number; vet: number; x: number; y: number; slot: number }
  | { e: "crate"; x: number; y: number; kind: CrateKind; slot: number; text: string }
  | { e: "income"; x: number; y: number; amt: number; slot: number }
  | { e: "hit"; id: number }
  // kill confirm — src = killer entity id (only emitted when a unit shooter is known, e.g. 1P direct fire)
  | { e: "kill"; src: number; id: number; x: number; y: number }
  // spy infiltrated an enemy building — kind = sabotaged building, slot = spy owner, vslot = victim
  | { e: "sabotage"; x: number; y: number; slot: number; vslot: number; kind: EntKind };

export type S2C =
  | { t: "lobby"; players: LobbyPlayer[]; you: string; room: string; map: MapId; phase?: "lobby" | "playing" | "ended"; config?: GameConfig }
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
      // seq/key are present on delta-stream (v2) keyframes; absent from legacy/in-process snapshots.
      // A "snap" message always carries FULL state — it is both the legacy frame and the v2 keyframe.
      seq?: number;
      key?: true;
      tick: number;
      ents: EntSnap[];
      crates?: CrateSnap[];
      bridges?: number[]; // pontoon-bridge tile indices (land+sea passable)
      players: Record<number, PlayerState>; // keyed by slot
      events: GameEvent[];
    }
  | {
      t: "snapd"; // v2 delta frame — apply onto the state of the preceding seq (see src/shared/snapdelta.ts)
      seq: number;
      tick: number;
      ents: EntDelta[]; // sparse per-ent partials (only changed fields; null deletes an optional field)
      gone?: number[]; // removed entity ids
      crates?: CrateSnap[]; // present only when changed (full replacement)
      bridges?: number[]; // present only when changed (full replacement)
      players?: Record<number, PlayerState>; // only slots whose state changed (full per-slot replacement)
      events: GameEvent[]; // transient — always complete for this frame
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
  | { t: "paused"; paused: boolean }
  | { t: "deny"; msg: string };

export const partyName = "game-room";
