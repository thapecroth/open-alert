import type { BuildingKind, UnitKind, EntKind } from "./gamedefs";

// ---------- client -> server ----------
export type C2S =
  | { t: "join"; name: string; token?: string }
  | { t: "ready"; ready: boolean }
  | { t: "start" }
  | { t: "order"; ids: number[]; kind: OrderKind; x: number; y: number; target?: number }
  | { t: "stop"; ids: number[] }
  | { t: "build"; kind: BuildingKind } // start building production
  | { t: "buildCancel" }
  | { t: "place"; tx: number; ty: number } // place the finished (awaiting) building
  | { t: "train"; unit: UnitKind } // queue one unit
  | { t: "trainCancel"; unit: UnitKind } // dequeue one
  | { t: "sell"; id: number } // sell own building for 50% refund
  | { t: "repair"; id: number } // repair own building to full (25% cost)
  | { t: "upgrade"; id: number } // upgrade factory -> factory2 (needs techlab)
  | { t: "resign" } // self-destruct everything you own
  | { t: "chat"; text: string }
  | { t: "ping"; x: number; y: number } // minimap ping for allies
  | { t: "addbot" } // host: add an AI player to the lobby
  | { t: "rematch" };

export type OrderKind = "move" | "amove" | "attack" | "harvest";

// ---------- server -> client ----------
export interface LobbyPlayer {
  id: string;
  name: string;
  slot: number;
  ready: boolean;
  host: boolean;
  connected: boolean;
  spectator: boolean;
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
  queues: Partial<Record<"barracks" | "factory", ProdQueue>>;
}

export type GameEvent =
  | { e: "shot"; fx: number; fy: number; tx: number; ty: number }
  | { e: "boom"; x: number; y: number; r: number }
  | { e: "spawn"; id: number }
  | { e: "ore"; cells: [number, number, number][] } // [x,y,amountLeft]
  | { e: "alert"; slot: number; x: number; y: number } // under-attack warning for `slot`
  | { e: "cap"; x: number; y: number; slot: number } // building captured, slot = new owner
  | { e: "elim"; slot: number };

export type S2C =
  | { t: "lobby"; players: LobbyPlayer[]; you: string; room: string }
  | {
      t: "init";
      you: string;
      slot: number;
      w: number;
      h: number;
      ore: [number, number, number][];
      players: { id: string; slot: number; name: string }[];
    }
  | {
      t: "snap";
      tick: number;
      ents: EntSnap[];
      players: Record<number, PlayerState>; // keyed by slot
      events: GameEvent[];
    }
  | { t: "end"; winner: number | null; reason: string }
  | { t: "chat"; name: string; color: string; text: string }
  | { t: "ping"; x: number; y: number; slot: number }
  | { t: "deny"; msg: string };

export const partyName = "game-room";
