import PartySocket from "partysocket";
import type { C2S, S2C } from "../shared/protocol";
import { partyName } from "../shared/protocol";

export class Net {
  socket: PartySocket;
  onMsg: (m: S2C) => void = () => {};
  onStatus: (s: string) => void = () => {};
  lastRecvAt = Date.now();
  private hbTimer: ReturnType<typeof setInterval>;

  constructor(room: string) {
    const dev = location.port === "5173";
    this.socket = new PartySocket({
      host: dev ? "localhost:8787" : location.host,
      party: partyName,
      room,
    });
    this.socket.addEventListener("message", (ev) => {
      this.lastRecvAt = Date.now();
      try {
        this.onMsg(JSON.parse(ev.data as string));
      } catch (err) {
        console.error("ws message handler error:", err);
      }
    });
    this.socket.addEventListener("open", () => {
      this.lastRecvAt = Date.now();
      this.onStatus("");
    });
    this.socket.addEventListener("close", () => this.onStatus("reconnecting…"));
    this.socket.addEventListener("error", () => this.onStatus("connection error"));
    // Keep NAT / Cloudflare edge WebSocket idle timers alive during passive spectating/watching
    this.hbTimer = setInterval(() => {
      try {
        if (this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ t: "hb" } satisfies C2S));
        }
      } catch {
        /* ignore transient heartbeat errors */
      }
    }, 15000);
  }

  send(m: C2S) {
    try {
      this.socket.send(JSON.stringify(m));
    } catch {
      /* PartySocket queues or reconnects */
    }
  }

  reconnect() {
    this.lastRecvAt = Date.now();
    this.onStatus("reconnecting…");
    try {
      this.socket.reconnect();
    } catch {
      /* ignore */
    }
  }

  close() {
    clearInterval(this.hbTimer);
    this.socket.close();
  }
}
