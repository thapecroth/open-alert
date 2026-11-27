// Web Worker entry hosting the browser-local single-player/spectate sim:
// the authoritative World + RtsBot brains + command dispatch + tick timer all
// run here, off the render thread. The main thread holds only a thin proxy
// (src/client/localnet.ts) that shuttles messages back and forth:
//
//   main -> worker:  SimIn control envelopes (init/c2s/spectate)
//   worker -> main:  the exact same S2C wire messages LocalSimHost emits
//                    in-process (init/snap/lobby/end/chat/ping/paused/deny)
//
// Everything crossing the boundary is plain JSON-ish data (see
// src/shared/protocol.ts), so structured cloning is lossless — snapshot
// objects were already immutable-by-convention fresh allocations per frame
// (renderers retain them for interpolation), so cloning is also semantically
// transparent.
//
// This module must stay free of DOM/window references: it is evaluated inside
// a DedicatedWorkerGlobalScope. globalThis is cast to the two worker-global
// members we use because the client tsconfig compiles with DOM lib types
// (where `self` is typed as Window) rather than the conflicting WebWorker lib.

import type { C2S, S2C } from "../shared/protocol";
import type { MapId } from "../shared/gamedefs";
import { LocalSimHost } from "./sim-host";

// Control envelopes posted by the LocalRoom proxy into the worker.
//   init     — first message, carries the room name for lobby broadcasts
//   c2s      — a client->server wire message for the host (same as in-process)
//   spectate — enter AI-spectate mode (the host API that is not a C2S message)
//   dbgExec  — test-only debug escape hatch: src is a function body run once
//              against the host (see LocalSimHost.debugExec); the outcome is
//              posted back as a DbgOut carrying the same id
export type SimIn =
  | { k: "init"; room: string }
  | { k: "c2s"; m: C2S }
  | { k: "spectate"; map?: MapId; botCount?: number }
  | { k: "dbgExec"; id: number; src: string };

// Debug-channel reply. Deliberately NOT part of the S2C union (`t: "dbg"`
// cannot collide with any game message): the LocalRoom proxy intercepts it
// and matches it to the pending debugExec() promise instead of forwarding it
// to the game client's onMsg, which would choke on the unknown type.
export interface DbgOut {
  t: "dbg";
  id: number;
  result?: unknown;
  error?: string;
}

interface WorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}
const scope = globalThis as unknown as WorkerScope;

let host: LocalSimHost | null = null;

scope.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as SimIn;
  try {
    if (!msg || typeof msg !== "object") return;
    if (msg.k === "init") {
      host = new LocalSimHost(String(msg.room ?? "local"));
      host.onMsg = (m: S2C) => scope.postMessage(m);
      return;
    }
    if (!host) return;
    if (msg.k === "c2s") host.send(msg.m);
    else if (msg.k === "spectate") host.startAiSpectate(msg.map, msg.botCount);
    else if (msg.k === "dbgExec") {
      const out = host.debugExec(msg.src);
      try {
        scope.postMessage({ t: "dbg", id: msg.id, ...out } satisfies DbgOut);
      } catch {
        // The body returned live sim objects or other uncloneable values —
        // report that as a normal error instead of vanishing silently
        // (nothing was queued: postMessage clone failure is atomic).
        scope.postMessage({ t: "dbg", id: msg.id, error: "dbgExec result is not structured-cloneable" } satisfies DbgOut);
      }
    }
  } catch (err) {
    // Contained to this one message — the interval timer and later messages
    // are independent tasks, so one bad command must not wedge the sim.
    console.error("sim-worker message error:", err);
  }
};
