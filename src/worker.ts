import { routePartykitRequest, Server } from "partyserver";
import type { Connection } from "partyserver";
import { World } from "./server/world";
import { AIBot } from "./server/bot";
import type { C2S, S2C, LobbyPlayer } from "./shared/protocol";
import { MAX_PLAYERS, TICK_MS, SNAP_EVERY, MAP_W, MAP_H, PLAYER_COLORS } from "./shared/gamedefs";

interface Env {
  GameRoom: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface PlayerRec {
  id: string;
  connId: string | null;
  name: string;
  slot: number;
  ready: boolean;
  spectator: boolean;
  connected: boolean;
  bot?: boolean;
}

const send = (conn: Connection, msg: S2C) => conn.send(JSON.stringify(msg));
const ORDER_KINDS = new Set(["move", "amove", "attack", "harvest"]);
const validIds = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => Number.isFinite(n)) : [];

export class GameRoom extends Server<Env> {
  phase: "lobby" | "playing" | "ended" = "lobby";
  players = new Map<string, PlayerRec>(); // by player id (client token)
  connPlayer = new Map<string, string>(); // conn id -> player id
  world: World | null = null;
  timer: ReturnType<typeof setInterval> | null = null;
  endSent = false;
  bots = new Map<string, AIBot>(); // player id -> AI brain, ticked once per game tick

  onClose(conn: Connection) {
    const pid = this.connPlayer.get(conn.id);
    this.connPlayer.delete(conn.id);
    if (!pid) return;
    const p = this.players.get(pid);
    if (!p) return;
    if (p.connId !== conn.id) return; // a newer connection already owns this record
    if (this.phase === "lobby" || p.spectator) {
      this.players.delete(pid); // free the slot / drop stale spectator recs
    } else {
      p.connected = false;
      p.connId = null;
    }
    if ([...this.players.values()].every((x) => x.bot || !x.connected)) this.resetRoom();
    else this.broadcastLobby();
  }

  onMessage(conn: Connection, raw: string | ArrayBuffer) {
    let m: C2S;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!m || typeof m !== "object" || typeof (m as { t?: unknown }).t !== "string") return;
    try {
      this.dispatch(conn, m);
    } catch {
      // never let a malformed command take down the connection or the room
    }
  }

  private dispatch(conn: Connection, m: C2S) {
    const pid = this.connPlayer.get(conn.id);
    const me = pid ? this.players.get(pid) : null;

    switch (m.t) {
      case "join":
        return this.handleJoin(conn, m.name, m.token);
      case "ready":
        if (me && this.phase === "lobby") {
          me.ready = !!m.ready;
          this.broadcastLobby();
        }
        return;
      case "start":
        if (me && this.isHost(me) && this.phase !== "playing") {
          const actives = [...this.players.values()].filter((p) => p.connected && !p.spectator && p.slot >= 0);
          if (actives.length < 2) return send(conn, { t: "deny", msg: "need at least 2 players — add a bot!" });
          const unready = actives.filter((p) => !p.bot && p.id !== me.id && !p.ready);
          if (unready.length) return send(conn, { t: "deny", msg: `${unready[0].name} is not ready` });
          this.startGame();
        }
        return;
      case "addbot":
        if (me && this.isHost(me) && this.phase === "lobby") this.addBot();
        return;
      case "chat":
        if (me && typeof m.text === "string" && m.text.trim()) {
          const color = me.slot >= 0 ? PLAYER_COLORS[me.slot] : "#8a97a5";
          const text = m.text.slice(0, 120).replace(/[<>&]/g, "");
          this.broadcast(JSON.stringify({ t: "chat", name: me.name, color, text } satisfies S2C));
        }
        return;
      case "ping":
        if (me && Number.isFinite(m.x) && Number.isFinite(m.y) && m.x >= 0 && m.y >= 0 && m.x < MAP_W && m.y < MAP_H) {
          this.broadcast(JSON.stringify({ t: "ping", x: m.x, y: m.y, slot: me.slot } satisfies S2C));
        }
        return;
      case "rematch":
        if (me && this.phase === "ended") {
          this.phase = "lobby";
          this.world = null;
          this.endSent = false;
          // spectators who joined mid-game get real slots so they can play next
          // round — but only while a slot is free; a full room keeps them spectating
          const used = new Set([...this.players.values()].filter((p) => !p.spectator).map((p) => p.slot));
          for (const p of this.players.values()) {
            p.ready = !!p.bot;
            if (p.spectator) {
              for (let s = 0; s < MAX_PLAYERS; s++)
                if (!used.has(s)) {
                  used.add(s);
                  p.slot = s;
                  p.spectator = false;
                  break;
                }
            }
          }
          this.broadcastLobby();
        }
        return;
    }

    // in-game commands
    if (!me || me.spectator || !this.world || this.phase !== "playing") return;
    const slot = me.slot;
    let err: string | null = null;
    switch (m.t) {
      case "order":
        if (typeof m.kind !== "string" || !ORDER_KINDS.has(m.kind) || !Number.isFinite(m.x) || !Number.isFinite(m.y)) {
          err = "bad order";
          break;
        }
        err = this.world.cmdOrder(slot, validIds(m.ids), m.kind, m.x, m.y, Number.isFinite(m.target) ? m.target : undefined);
        break;
      case "stop":
        this.world.cmdStop(slot, validIds(m.ids));
        break;
      case "build":
        err = typeof m.kind === "string" ? this.world.cmdBuild(slot, m.kind) : "bad kind";
        break;
      case "buildCancel":
        this.world.cmdBuildCancel(slot);
        break;
      case "place":
        err = Number.isFinite(m.tx) && Number.isFinite(m.ty) ? this.world.cmdPlace(slot, Math.floor(m.tx), Math.floor(m.ty)) : "bad coords";
        break;
      case "train":
        err = typeof m.unit === "string" ? this.world.cmdTrain(slot, m.unit) : "bad unit";
        break;
      case "trainCancel":
        if (typeof m.unit === "string") this.world.cmdTrainCancel(slot, m.unit);
        break;
      case "sell":
        err = Number.isFinite(m.id) ? this.world.cmdSell(slot, m.id) : "bad id";
        break;
      case "repair":
        err = Number.isFinite(m.id) ? this.world.cmdRepair(slot, m.id) : "bad id";
        break;
      case "upgrade":
        err = Number.isFinite(m.id) ? this.world.cmdUpgrade(slot, m.id) : "bad id";
        break;
      case "resign":
        this.world.cmdResign(slot);
        break;
    }
    if (err) send(conn, { t: "deny", msg: err });
  }

  private handleJoin(conn: Connection, name: string, token?: string) {
    const clean = String(name || "Commander").slice(0, 16).trim() || "Commander";
    const tok = typeof token === "string" && token.length > 0 && token.length <= 64 ? token : undefined;

    // rejoin with a known token (reconnect / refresh / second tab)
    if (tok) {
      const p = this.players.get(tok);
      if (p) {
        if (p.connId && p.connId !== conn.id) {
          for (const c of this.getConnections()) if (c.id === p.connId) c.close(4000, "replaced");
          this.connPlayer.delete(p.connId);
        }
        p.connId = conn.id;
        p.connected = true;
        p.name = clean;
        if (this.phase === "playing") {
          const wp = this.world?.players.get(p.slot);
          p.spectator = !wp || wp.eliminated;
        }
        this.connPlayer.set(conn.id, tok);
        this.sendInit(conn, p);
        this.broadcastLobby();
        return;
      }
    }

    const id = tok || crypto.randomUUID();
    if (this.phase === "playing") {
      // join mid-game as spectator
      const p: PlayerRec = { id, connId: conn.id, name: clean, slot: -1, ready: true, spectator: true, connected: true };
      this.players.set(id, p);
      this.connPlayer.set(conn.id, id);
      this.sendInit(conn, p);
      this.broadcastLobby();
      return;
    }

    const used = new Set([...this.players.values()].map((p) => p.slot));
    let slot = -1;
    for (let s = 0; s < MAX_PLAYERS; s++)
      if (!used.has(s)) {
        slot = s;
        break;
      }
    if (slot < 0) {
      send(conn, { t: "deny", msg: "room is full" });
      conn.close(4000, "room full");
      return;
    }
    const p: PlayerRec = { id, connId: conn.id, name: clean, slot, ready: false, spectator: false, connected: true };
    this.players.set(id, p);
    this.connPlayer.set(conn.id, id);
    this.broadcastLobby();
  }

  private isHost(p: PlayerRec) {
    // host is always a connected human — a bot must never hold the start button
    const humans = [...this.players.values()].filter((x) => x.connected && !x.spectator && !x.bot);
    if (!humans.length) return false;
    humans.sort((a, b) => a.slot - b.slot);
    return humans[0].id === p.id;
  }

  private lobbyList(): LobbyPlayer[] {
    const connected = [...this.players.values()].filter((x) => x.connected && !x.spectator && !x.bot);
    const hostId = connected.sort((a, b) => a.slot - b.slot)[0]?.id;
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      slot: p.slot,
      ready: p.ready,
      host: p.id === hostId,
      connected: p.connected,
      spectator: p.spectator,
      eliminated: this.world?.players.get(p.slot)?.eliminated,
    }));
  }

  private broadcastLobby() {
    const players = this.lobbyList();
    for (const conn of this.getConnections()) {
      const pid = this.connPlayer.get(conn.id);
      if (pid) send(conn, { t: "lobby", players, you: pid, room: this.name });
    }
  }

  private sendInit(conn: Connection, p: PlayerRec) {
    if (!this.world) return;
    send(conn, {
      t: "init",
      you: p.id,
      slot: p.spectator ? -1 : p.slot,
      w: MAP_W,
      h: MAP_H,
      ore: this.world.oreSnapshot(),
      players: [...this.players.values()]
        .filter((x) => !x.spectator)
        .map((x) => ({ id: x.id, slot: x.slot, name: x.name })),
    });
  }

  private addBot() {
    const used = new Set([...this.players.values()].filter((p) => p.slot >= 0).map((p) => p.slot));
    let slot = -1;
    for (let s = 0; s < MAX_PLAYERS; s++)
      if (!used.has(s)) {
        slot = s;
        break;
      }
    if (slot < 0) return;
    const id = `bot-${crypto.randomUUID().slice(0, 8)}`;
    const p: PlayerRec = {
      id,
      connId: null,
      name: `CABAL-${slot + 1}`,
      slot,
      ready: true,
      spectator: false,
      connected: true,
      bot: true,
    };
    this.players.set(id, p);
    this.bots.set(id, new AIBot(id));
    this.broadcastLobby();
  }

  private startGame() {
    const slots = [...this.players.values()]
      .filter((p) => p.connected && !p.spectator && p.slot >= 0)
      .map((p) => p.slot)
      .sort((a, b) => a - b);
    if (!slots.length) return;
    this.world = new World(slots);
    this.phase = "playing";
    this.endSent = false;
    for (const conn of this.getConnections()) {
      const pid = this.connPlayer.get(conn.id);
      const p = pid ? this.players.get(pid) : null;
      if (p) this.sendInit(conn, p);
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.gameTick(), TICK_MS);
  }

  private gameTick() {
    const w = this.world;
    if (!w) return;
    for (const [pid, bot] of this.bots) {
      const p = this.players.get(pid);
      if (p && p.slot >= 0) bot.tick(w, p.slot);
    }
    w.step();
    if (w.tick % SNAP_EVERY === 0) {
      const snap = w.snapshot();
      this.broadcast(JSON.stringify({ t: "snap", tick: w.tick, ...snap } satisfies S2C));
    }
    if (w.winner !== null && !this.endSent) {
      this.endSent = true;
      const wp = [...this.players.values()].find((p) => p.slot === w.winner);
      this.broadcast(
        JSON.stringify({
          t: "end",
          winner: w.winner,
          reason: wp ? `${wp.name} wins!` : "draw",
        } satisfies S2C),
      );
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.phase = "ended";
    }
  }

  private resetRoom() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.world = null;
    this.phase = "lobby";
    this.endSent = false;
    this.players.clear();
    this.bots.clear();
  }

  onRequest() {
    return Response.json({
      phase: this.phase,
      players: this.players.size,
      tick: this.world?.tick ?? 0,
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routePartykitRequest(request, env)) || env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
