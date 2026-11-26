// Browser-local single-player room — thin proxy for the sim running inside a
// dedicated Web Worker (src/client/sim-worker.ts), so the authoritative World +
// RtsBot simulation and its 10-15 Hz tick no longer compete with
// requestAnimationFrame on the render thread.
//
// The public interface is unchanged: constructor(room), onMsg, send(),
// startAiSpectate(), isSpectate(), close(). Internally:
//   - C2S wire messages are posted into the worker, which runs a LocalSimHost
//     (src/client/sim-host.ts — the exact room engine that used to execute
//     in-process here) and posts back the same S2C messages it used to emit
//     synchronously. Ordering is preserved: postMessage is FIFO in both
//     directions, and worker-side message tasks interleave with the interval
//     ticks exactly the way synchronous sends interleaved with ticks before.
//   - When module workers are unavailable (very old browsers, or non-browser
//     runtimes such as the Node test harnesses) the same LocalSimHost runs
//     in-process as a fallback — behavior is then literally the pre-worker
//     synchronous implementation.

import type { C2S, S2C } from "../shared/protocol";
import type { MapId } from "../shared/gamedefs";
import { LocalSimHost } from "./sim-host";
import type { SimIn } from "./sim-worker";

export class LocalRoom {
  onMsg: (m: S2C) => void = () => {};
  private spectateOnly = false;
  private worker: Worker | null = null;
  private host: LocalSimHost | null = null;

  constructor(room: string) {
    let w: Worker | null = null;
    // typeof window guard keeps non-browser runtimes (Node test harnesses load
    // this module directly) on the in-process path even if a global Worker
    // shim exists — Node's worker_threads Worker could not execute the
    // TypeScript worker entry anyway.
    if (typeof window !== "undefined" && typeof Worker === "function") {
      try {
        w = new Worker(new URL("./sim-worker.ts", import.meta.url), { type: "module" });
      } catch {
        w = null; // worker construction blocked — fall back to in-process sim
      }
    }
    if (w) {
      this.worker = w;
      w.onmessage = (ev: MessageEvent) => {
        this.onMsg(ev.data as S2C);
      };
      w.onerror = (ev: ErrorEvent) => {
        console.error("sim-worker error:", ev.message ?? ev);
      };
      // Messages posted before the worker script finishes evaluating are
      // queued by the platform and delivered in order once it starts, so the
      // init handshake cannot be lost and always arrives first.
      this.post({ k: "init", room });
    } else {
      const host = new LocalSimHost(room);
      host.onMsg = (m) => this.onMsg(m);
      this.host = host;
    }
  }

  private post(msg: SimIn) {
    try {
      this.worker?.postMessage(msg);
    } catch (err) {
      console.error("sim-worker post error:", err);
    }
  }

  isSpectate(): boolean {
    // spectate-only is a lifetime invariant of a room instance (net.ts builds a
    // fresh LocalRoom when switching modes), so this proxy-side flag is exact
    // even though the real state lives in the worker.
    return this.spectateOnly;
  }

  startAiSpectate(map: MapId = "archipelago", botCount?: number) {
    this.spectateOnly = true;
    if (this.worker) this.post({ k: "spectate", map, botCount });
    else this.host?.startAiSpectate(map, botCount);
  }

  send(m: C2S) {
    if (this.worker) this.post({ k: "c2s", m });
    else this.host?.send(m);
  }

  close() {
    if (this.worker) {
      // terminate() kills the worker thread outright — the tick interval and
      // all sim state die with it, so no timer can leak past mode switches
      // or page teardown.
      this.worker.terminate();
      this.worker = null;
    }
    if (this.host) {
      this.host.close();
      this.host = null;
    }
  }
}
