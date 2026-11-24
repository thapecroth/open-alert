import PartySocket from "partysocket";
import type { MapId } from "../shared/gamedefs";
import type { C2S, S2C } from "../shared/protocol";
import { partyName } from "../shared/protocol";
import { SnapReassembler } from "../shared/snapdelta";
import { LocalRoom } from "./localnet";

export class Net {
  socket: PartySocket;
  onMsg: (m: S2C) => void = () => {};
  onStatus: (s: string) => void = () => {};
  onLocalFallback?: (reason: string) => void;
  lastRecvAt = Date.now();
  localMode = false;
  quotaExceeded = false;
  private room: string;
  private local: LocalRoom | null = null;
  private hbTimer: ReturnType<typeof setInterval>;
  private snaprx = new SnapReassembler();
  private everConnected = false;
  private failCount = 0;
  private joinName = "Commander";
  private joinToken = "";

  private ingest(m: S2C): S2C | null {
    if (m.t === "snap") return this.snaprx.keyframe(m);
    if (m.t === "snapd") return this.snaprx.delta(m);
    if (m.t === "init") this.snaprx.reset(); // new match/rejoin — ent ids restart, server resends a keyframe
    return m;
  }

  setIdentity(name: string, token: string) {
    this.joinName = name;
    this.joinToken = token;
  }

  constructor(room: string) {
    this.room = room;
    const dev = location.port === "5173";
    this.socket = new PartySocket({
      host: dev ? "localhost:8787" : location.host,
      party: partyName,
      room,
    });
    this.socket.addEventListener("message", (ev) => {
      if (this.localMode) return;
      this.everConnected = true;
      this.failCount = 0;
      this.lastRecvAt = Date.now();
      try {
        const m = this.ingest(JSON.parse(ev.data as string));
        if (m) this.onMsg(m);
      } catch (err) {
        console.error("ws message handler error:", err);
      }
    });
    this.socket.addEventListener("open", () => {
      if (this.localMode) return;
      this.everConnected = true;
      this.failCount = 0;
      this.lastRecvAt = Date.now();
      this.onStatus("");
    });
    this.socket.addEventListener("close", () => {
      if (this.localMode) return;
      this.onStatus("reconnecting…");
    });
    this.socket.addEventListener("error", () => {
      if (this.localMode) return;
      this.failCount++;
      this.onStatus("connection error");
      // If initial Cloudflare Durable Object handshake fails twice (e.g. free-tier daily quota reached),
      // seamlessly fall back to Local Solo Skirmish so the player can play immediately at 0ms ping!
      if (!this.everConnected && this.failCount >= 2) {
        this.quotaExceeded = true;
        this.switchToLocal("Cloudflare free-tier room quota reached — switched to Local Solo mode (0ms ping)");
      }
    });
    // Keep NAT / Cloudflare edge WebSocket idle timers alive during passive spectating/watching
    this.hbTimer = setInterval(() => {
      if (this.localMode) return;
      try {
        if (this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ t: "hb" } satisfies C2S));
        }
      } catch {
        /* ignore transient heartbeat errors */
      }
    }, 15000);
  }

  switchToLocal(reason = "Switched to Local Solo Skirmish (0ms ping, zero server quota)") {
    if (/quota/i.test(reason)) this.quotaExceeded = true;
    if (this.localMode && this.local && !this.local.isSpectate()) return;
    this.localMode = true;
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
    if (this.local) {
      this.local.close();
    }
    this.local = new LocalRoom(this.room);
    this.local.onMsg = (m) => {
      this.lastRecvAt = Date.now();
      try {
        const ingested = this.ingest(m);
        if (ingested) this.onMsg(ingested);
      } catch (err) {
        console.error("local message handler error:", err);
      }
    };
    this.onStatus("LOCAL SOLO");
    this.onLocalFallback?.(reason);
    this.local.send({ t: "join", name: this.joinName, token: this.joinToken });
  }

  startAiSpectate(map: MapId = "archipelago", botCount = 3) {
    if (!this.localMode) {
      this.localMode = true;
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
    }
    if (this.local) {
      this.local.close();
    }
    this.local = new LocalRoom(this.room);
    this.local.onMsg = (m) => {
      this.lastRecvAt = Date.now();
      try {
        const ingested = this.ingest(m);
        if (ingested) this.onMsg(ingested);
      } catch (err) {
        console.error("local message handler error:", err);
      }
    };
    this.onStatus("AI SPECTATE");
    this.local.startAiSpectate(map, botCount);
  }

  retryOnline() {
    location.reload();
  }

  send(m: C2S) {
    if (m.t === "join") m = { ...m, v: 2 };
    if (this.localMode && this.local) {
      this.local.send(m);
      return;
    }
    try {
      this.socket.send(JSON.stringify(m));
    } catch {
      /* PartySocket queues or reconnects */
    }
  }

  reconnect() {
    if (this.localMode) return;
    this.onStatus("reconnecting…");
    try {
      this.socket.reconnect();
    } catch {
      /* ignore */
    }
  }

  close() {
    clearInterval(this.hbTimer);
    if (this.local) this.local.close();
    this.socket.close();
  }
}
