import PartySocket from "partysocket";
import type { C2S, S2C } from "../shared/protocol";
import { partyName } from "../shared/protocol";

export class Net {
  socket: PartySocket;
  onMsg: (m: S2C) => void = () => {};
  onStatus: (s: string) => void = () => {};

  constructor(room: string) {
    const dev = location.port === "5173";
    this.socket = new PartySocket({
      host: dev ? "localhost:8787" : location.host,
      party: partyName,
      room,
    });
    this.socket.addEventListener("message", (ev) => {
      try {
        this.onMsg(JSON.parse(ev.data as string));
      } catch {
        /* ignore malformed */
      }
    });
    this.socket.addEventListener("open", () => this.onStatus(""));
    this.socket.addEventListener("close", () => this.onStatus("reconnecting…"));
    this.socket.addEventListener("error", () => this.onStatus("connection error"));
  }

  send(m: C2S) {
    this.socket.send(JSON.stringify(m));
  }
}
