import { routePartykitRequest, Server } from "partyserver";
import type { Connection } from "partyserver";
import { World } from "./server/world";
import { AIBot } from "./server/bot";
import type { C2S, S2C, LobbyPlayer } from "./shared/protocol";
import { MAX_PLAYERS, TICK_MS, SNAP_EVERY, MAP_W, MAP_H, PLAYER_COLORS, DEFAULT_CONFIG } from "./shared/gamedefs";
import type { MapId, BotDiff, BotProfile, GameConfig } from "./shared/gamedefs";

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
  team: number;
  bot?: boolean;
  diff?: BotDiff;
  profile?: BotProfile;
}

const send = (conn: Connection, msg: S2C) => conn.send(JSON.stringify(msg));
const ORDER_KINDS = new Set(["move", "amove", "attack", "harvest"]);
const VALID_MAPS = new Set<MapId>(["crossroads", "canyon", "basin"]);
const VALID_DIFFS = new Set<BotDiff>(["easy", "normal", "brutal"]);
const VALID_PROFILES = new Set<BotProfile>(["balanced", "rusher", "turtle", "tech"]);
const VALID_CREDITS = new Set([3000, 5000, 10000, 20000]);
const VALID_SPEEDS = new Set([0.75, 1, 1.5, 2]);
const validIds = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => Number.isFinite(n)) : [];

export class GameRoom extends Server<Env> {
  phase: "lobby" | "playing" | "ended" = "lobby";
  map: MapId = "crossroads";
  config: GameConfig = { ...DEFAULT_CONFIG };
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
          const firstTeam = actives[0].team;
          if (firstTeam > 0 && actives.every((p) => p.team === firstTeam)) {
            return send(conn, { t: "deny", msg: "need opponents on another team" });
          }
          this.startGame();
        }
        return;
      case "addbot":
        if (me && this.isHost(me) && this.phase === "lobby") {
          const diff: BotDiff = typeof m.diff === "string" && VALID_DIFFS.has(m.diff) ? m.diff : "normal";
          const profile: BotProfile =
            typeof m.profile === "string" && VALID_PROFILES.has(m.profile) ? m.profile : "balanced";
          this.addBot(diff, profile);
        }
        return;
      case "setBotConfig":
        if (me && this.isHost(me) && this.phase === "lobby" && typeof m.id === "string") {
          const target = this.players.get(m.id);
          if (target && target.bot) {
            if (typeof m.diff === "string" && VALID_DIFFS.has(m.diff)) target.diff = m.diff;
            if (typeof m.profile === "string" && VALID_PROFILES.has(m.profile)) target.profile = m.profile;
            this.bots.set(m.id, new AIBot(m.id, { diff: target.diff ?? "normal", profile: target.profile ?? "balanced" }));
            this.broadcastLobby();
          }
        }
        return;
      case "kickbot":
        if (me && this.isHost(me) && this.phase === "lobby" && typeof m.id === "string") {
          const target = this.players.get(m.id);
          if (target && target.bot) {
            this.players.delete(m.id);
            this.bots.delete(m.id);
            this.broadcastLobby();
          }
        }
        return;
      case "setMap":
        if (me && this.isHost(me) && this.phase === "lobby" && typeof m.map === "string" && VALID_MAPS.has(m.map)) {
          this.map = m.map;
          this.broadcastLobby();
        }
        return;
      case "setConfig":
        if (me && this.isHost(me) && this.phase === "lobby" && m.config && typeof m.config === "object") {
          const c = m.config;
          if (typeof c.startCredits === "number" && VALID_CREDITS.has(c.startCredits))
            this.config.startCredits = c.startCredits;
          if (typeof c.gameSpeed === "number" && VALID_SPEEDS.has(c.gameSpeed)) this.config.gameSpeed = c.gameSpeed;
          if (typeof c.superweapons === "boolean") this.config.superweapons = c.superweapons;
          if (typeof c.crates === "boolean") this.config.crates = c.crates;
          if (typeof c.derricks === "boolean") this.config.derricks = c.derricks;
          if (typeof c.fog === "boolean") this.config.fog = c.fog;
          this.broadcastLobby();
        }
        return;
      case "setTeam":
        if (me && !me.spectator && this.phase === "lobby" && Number.isInteger(m.team) && m.team >= 0 && m.team <= 4) {
          if (typeof m.id === "string" && m.id !== me.id) {
            if (this.isHost(me)) {
              const target = this.players.get(m.id);
              if (target && target.bot) {
                target.team = m.team;
                this.broadcastLobby();
              }
            }
          } else {
            me.team = m.team;
            this.broadcastLobby();
          }
        }
        return;
      case "setName":
        if (me && this.phase === "lobby" && typeof m.name === "string") {
          const clean = m.name.slice(0, 16).trim();
          if (clean) {
            me.name = clean;
            this.broadcastLobby();
          }
        }
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
        err = this.world.cmdOrder(
          slot,
          validIds(m.ids),
          m.kind,
          m.x,
          m.y,
          Number.isFinite(m.target) ? m.target : undefined,
          !!m.queue,
        );
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
      case "rally":
        err =
          Number.isFinite(m.id) && Number.isFinite(m.x) && Number.isFinite(m.y)
            ? this.world.cmdRally(slot, m.id, m.x, m.y)
            : "bad coords";
        break;
      case "superweapon":
        err =
          Number.isFinite(m.x) && Number.isFinite(m.y)
            ? this.world.cmdSuperweapon(slot, m.x, m.y)
            : "bad coords";
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
      const p: PlayerRec = { id, connId: conn.id, name: clean, slot: -1, ready: true, spectator: true, connected: true, team: 0 };
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
    const p: PlayerRec = { id, connId: conn.id, name: clean, slot, ready: false, spectator: false, connected: true, team: 0 };
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
      team: p.team,
      ...(p.bot ? { bot: true, diff: p.diff, profile: p.profile } : {}),
      eliminated: this.world?.players.get(p.slot)?.eliminated,
    }));
  }

  private broadcastLobby() {
    const players = this.lobbyList();
    for (const conn of this.getConnections()) {
      const pid = this.connPlayer.get(conn.id);
      if (pid) send(conn, { t: "lobby", players, you: pid, room: this.name, map: this.map, config: this.config });
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
      map: this.map,
      config: this.config,
      ore: this.world.oreSnapshot(),
      players: [...this.players.values()]
        .filter((x) => !x.spectator)
        .map((x) => ({ id: x.id, slot: x.slot, name: x.name, team: x.team })),
    });
  }

  private addBot(diff: BotDiff = "normal", profile: BotProfile = "balanced") {
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
      team: 0,
      bot: true,
      diff,
      profile,
    };
    this.players.set(id, p);
    this.bots.set(id, new AIBot(id, { diff, profile }));
    this.broadcastLobby();
  }

  private startGame() {
    const actives = [...this.players.values()].filter((p) => p.connected && !p.spectator && p.slot >= 0);
    const slots = actives.map((p) => p.slot).sort((a, b) => a - b);
    if (!slots.length) return;
    const teams: Record<number, number> = {};
    const names: Record<number, string> = {};
    for (const p of actives) {
      teams[p.slot] = p.team;
      names[p.slot] = p.name;
    }
    this.world = new World(slots, { map: this.map, teams, names, config: this.config });
    this.phase = "playing";
    this.endSent = false;
    for (const conn of this.getConnections()) {
      const pid = this.connPlayer.get(conn.id);
      const p = pid ? this.players.get(pid) : null;
      if (p) this.sendInit(conn, p);
    }
    if (this.timer) clearInterval(this.timer);
    const tickMs = Math.max(40, Math.round(TICK_MS / (this.config.gameSpeed || 1)));
    this.timer = setInterval(() => this.gameTick(), tickMs);
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
      const names: Record<number, string> = {};
      for (const p of this.players.values()) if (!p.spectator && p.slot >= 0) names[p.slot] = p.name;
      const wp = [...this.players.values()].find((p) => p.slot === w.winner);
      const reason =
        w.winnerTeam && w.winnerTeam > 0
          ? `Team ${w.winnerTeam} wins!`
          : wp
            ? `${wp.name} wins!`
            : "draw";
      this.broadcast(
        JSON.stringify({
          t: "end",
          winner: w.winner,
          winnerTeam: w.winnerTeam,
          reason,
          durationSec: Math.round((w.tick * TICK_MS) / 1000),
          stats: w.getStats(names),
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
    this.map = "crossroads";
    this.config = { ...DEFAULT_CONFIG };
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
