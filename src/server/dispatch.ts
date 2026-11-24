// Shared in-game command validation + application, used 1:1 by the authoritative
// multiplayer worker (src/worker.ts) and the in-process single-player room
// (src/client/localnet.ts). Both transports receive the same C2S wire messages
// and must apply them with identical sanitization — extracting it here keeps
// the two from drifting apart.
//
// Deliberately NOT shared (documented for the integration review):
//  - lobby lifecycle (join/ready/start/addbot/setTeam/setConfig/rematch...):
//    the worker is authoritative multiplayer (slots, host migration, teams,
//    persistence, spectators) while localnet is a single-human in-process room
//    with no connection management at all — the logic only superficially
//    resembles each other.
//  - pause: same flag, different side effects (multiplayer sole-human gate +
//    broadcast vs local emit).
//  - chat/ping: different fan-out (room broadcast vs single-client echo).
//

import type { World } from "./world";
import type { C2S } from "../shared/protocol";
import { ORDER_KINDS } from "../shared/gamedefs";
import type { BuildingKind, BuildCategory } from "../shared/gamedefs";

const ORDER_KIND_SET: ReadonlySet<string> = new Set(ORDER_KINDS);

export const validIds = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => Number.isFinite(n)) : [];

// Applies one in-game command message for `slot` against the world.
// Returns:
//   undefined — not an in-game command (caller handles it: pause/chat/ping/lobby)
//   null      — command handled, no error
//   string    — command rejected; the string is the client-facing deny reason
export function applyGameCommand(w: World, slot: number, m: C2S): string | null | undefined {
  switch (m.t) {
    case "order":
      if (typeof m.kind !== "string" || !ORDER_KIND_SET.has(m.kind) || !Number.isFinite(m.x) || !Number.isFinite(m.y)) {
        return "bad order";
      }
      return w.cmdOrder(
        slot,
        validIds(m.ids),
        m.kind,
        m.x,
        m.y,
        Number.isFinite(m.target) ? m.target : undefined,
        !!m.queue,
      );
    case "stop":
      w.cmdStop(slot, validIds(m.ids));
      return null;
    case "hold":
      w.cmdHold(slot, validIds(m.ids));
      return null;
    case "drive":
      if (Number.isFinite(m.id) && Number.isFinite(m.fwd) && Number.isFinite(m.strafe) && Number.isFinite(m.yaw)) {
        w.cmdDrive(
          slot,
          m.id,
          m.fwd,
          m.strafe,
          m.yaw,
          !!m.fire,
          Number.isFinite(m.aimX) ? m.aimX : undefined,
          Number.isFinite(m.aimY) ? m.aimY : undefined,
          Number.isFinite(m.aimTarget) ? m.aimTarget : undefined,
          Number.isFinite(m.alt) ? m.alt : undefined,
          !!m.sprint,
          Number.isFinite(m.wpn) ? m.wpn : undefined,
          Number.isFinite(m.lock) ? m.lock : undefined,
        );
      }
      return null;
    case "driveExit":
      if (Number.isFinite(m.id)) w.cmdDriveExit(slot, m.id);
      return null;
    case "recon":
      return Number.isFinite(m.x) && Number.isFinite(m.y) ? w.cmdRecon(slot, m.x, m.y) : "bad coords";
    case "build":
      return typeof m.kind === "string" ? w.cmdBuild(slot, m.kind) : "bad kind";
    case "buildCancel": {
      const cat: BuildCategory | undefined = m.cat === "structure" || m.cat === "defense" ? m.cat : undefined;
      w.cmdBuildCancel(
        slot,
        cat,
        Number.isFinite(m.index) ? m.index : 0,
        m.awaiting === true,
        typeof m.kind === "string" ? (m.kind as BuildingKind) : undefined,
      );
      return null;
    }
    case "place": {
      const cat: BuildCategory | undefined = m.cat === "structure" || m.cat === "defense" ? m.cat : undefined;
      const kind = typeof m.kind === "string" ? (m.kind as BuildingKind) : undefined;
      return Number.isFinite(m.tx) && Number.isFinite(m.ty)
        ? w.cmdPlace(slot, Math.floor(m.tx), Math.floor(m.ty), cat, kind)
        : "bad coords";
    }
    case "bridge":
      return Number.isFinite(m.id) && Number.isFinite(m.tx) && Number.isFinite(m.ty)
        ? w.cmdBridge(slot, Math.floor(m.id), Math.floor(m.tx), Math.floor(m.ty))
        : "bad bridge order";
    case "train":
      return typeof m.unit === "string" ? w.cmdTrain(slot, m.unit) : "bad unit";
    case "trainCancel":
      w.cmdTrainCancel(
        slot,
        typeof m.unit === "string" ? m.unit : undefined,
        m.cat === "barracks" || m.cat === "factory" || m.cat === "airfield" || m.cat === "shipyard" ? m.cat : undefined,
        Number.isFinite(m.index) ? m.index : undefined,
      );
      return null;
    case "sell":
      return Number.isFinite(m.id) ? w.cmdSell(slot, m.id) : "bad id";
    case "repair":
      return Number.isFinite(m.id) ? w.cmdRepair(slot, m.id) : "bad id";
    case "upgrade":
      return Number.isFinite(m.id) ? w.cmdUpgrade(slot, m.id) : "bad id";
    case "rally":
      return Number.isFinite(m.id) && Number.isFinite(m.x) && Number.isFinite(m.y)
        ? w.cmdRally(slot, m.id, m.x, m.y)
        : "bad coords";
    case "superweapon":
      return Number.isFinite(m.x) && Number.isFinite(m.y) ? w.cmdSuperweapon(slot, m.x, m.y) : "bad coords";
    case "resign":
      w.cmdResign(slot);
      return null;
    default:
      return undefined;
  }
}
