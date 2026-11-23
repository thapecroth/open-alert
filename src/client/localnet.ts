// Browser-local single-player room engine running the exact same World + RtsBot simulation
// at 0ms latency with zero Cloudflare Durable Objects quota usage.

import {
  DEFAULT_CONFIG,
  MAP_LIST,
  MAX_PLAYERS,
  PLAYER_COLORS,
  SNAP_EVERY,
  TICK_MS,
  type BotDiff,
  type BotProfile,
  type GameConfig,
  type MapId,
} from "../shared/gamedefs";
import type { C2S, LobbyPlayer, S2C } from "../shared/protocol";
import { World } from "../server/world";
import { RtsBot } from "../server/bot";

const VALID_MAPS = new Set<MapId>(MAP_LIST.map((m) => m.id));
const VALID_DIFFS = new Set<BotDiff>(["easy", "normal", "brutal"]);
const VALID_PROFILES = new Set<BotProfile>(["balanced", "rusher", "turtle", "tech"]);

interface LocalRec {
  id: string;
  name: string;
  slot: number;
  ready: boolean;
  team: number;
  bot?: boolean;
  diff?: BotDiff;
  profile?: BotProfile;
}

export class LocalRoom {
  onMsg: (m: S2C) => void = () => {};
  private room: string;
  private phase: "lobby" | "playing" | "ended" = "lobby";
  private map: MapId = "crossroads";
  private config: GameConfig = { ...DEFAULT_CONFIG };
  private players = new Map<string, LocalRec>();
  private bots = new Map<string, RtsBot>();
  private world: World | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private endSent = false;
  private myId = "local-host";
  private spectateOnly = false;
  private aiBotCount = 3;

  constructor(room: string) {
    this.room = room;
  }

  isSpectate(): boolean {
    return this.spectateOnly;
  }

  startAiSpectate(map: MapId = "archipelago", botCount?: number) {
    const chosenMap: MapId = VALID_MAPS.has(map) ? map : "archipelago";
    const meta = MAP_LIST.find((m) => m.id === chosenMap);
    const defaultBots = (meta?.w ?? 64) >= 96 ? 6 : 4;
    const count = Math.max(2, Math.min(MAX_PLAYERS, Math.floor(botCount ?? defaultBots)));
    this.stopTimer();
    this.players.clear();
    this.bots.clear();
    this.spectateOnly = true;
    this.aiBotCount = count;
    this.map = chosenMap;
    this.config = { ...DEFAULT_CONFIG, gameSpeed: 1.5 };

    const profiles: BotProfile[] = ["rusher", "balanced", "tech", "turtle"];
    const diffs: BotDiff[] = ["brutal", "normal", "brutal", "normal"];
    const callsigns = [
      "CABAL-ALPHA",
      "CABAL-OMEGA",
      "CABAL-PRIME",
      "CABAL-APEX",
      "CABAL-VORTEX",
      "CABAL-TITAN",
      "CABAL-NEXUS",
      "CABAL-ZERO",
    ];

    for (let s = 0; s < count; s++) {
      const id = `bot-${s}`;
      this.players.set(id, {
        id,
        name: callsigns[s] ?? `CABAL-${s + 1}`,
        slot: s,
        ready: true,
        team: 0,
        bot: true,
        diff: diffs[s % diffs.length],
        profile: profiles[s % profiles.length],
      });
    }

    const actives = [...this.players.values()];
    const slots = actives.map((p) => p.slot).sort((a, b) => a - b);
    const teams: Record<number, number> = {};
    const names: Record<number, string> = {};
    for (const p of actives) {
      teams[p.slot] = p.team;
      names[p.slot] = p.name;
    }

    const w = new World(slots, { map: this.map, teams, names, config: this.config });
    this.world = w;
    for (const p of actives) {
      this.bots.set(p.id, new RtsBot(w, p.slot, { diff: p.diff ?? "normal", profile: p.profile ?? "balanced" }));
    }
    this.phase = "playing";
    this.endSent = false;

    this.emit({
      t: "init",
      you: "local-spectator",
      slot: -1,
      w: w.w,
      h: w.h,
      map: this.map,
      config: this.config,
      players: actives.map((p) => ({
        id: p.id,
        name: p.name,
        slot: p.slot,
        team: p.team,
      })),
      ore: w.oreSnapshot(),
    });

    const tickMs = Math.max(40, Math.round(TICK_MS / (this.config.gameSpeed || 1.5)));
    this.timer = setInterval(() => this.tick(), tickMs);
  }

  private emit(m: S2C) {
    this.onMsg(m);
  }

  private broadcastLobby() {
    const players: LobbyPlayer[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      slot: p.slot,
      ready: p.ready,
      connected: true,
      spectator: false,
      host: p.id === this.myId,
      bot: p.bot,
      diff: p.diff,
      profile: p.profile,
      team: p.team,
      eliminated: this.world?.players.get(p.slot)?.eliminated,
    }));
    this.emit({
      t: "lobby",
      players,
      you: this.myId,
      room: this.room + " (LOCAL)",
      map: this.map,
      phase: this.phase,
      config: this.config,
    });
  }

  private freeSlot(): number {
    const used = new Set([...this.players.values()].map((p) => p.slot));
    for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
    return -1;
  }

  send(m: C2S) {
    if (m.t === "hb") return;
    if (this.spectateOnly) {
      if (m.t === "rematch" && this.phase === "ended") {
        this.startAiSpectate(this.map, this.aiBotCount);
        return;
      }
      if (m.t === "chat") {
        this.emit({
          t: "chat",
          name: "Spectator",
          color: "#45d6ff",
          text: String(m.text || "").slice(0, 200),
        });
      } else if (m.t === "ping") {
        this.emit({ t: "ping", x: m.x, y: m.y, slot: -1 });
      }
      return;
    }
    if (m.t === "join") {
      const clean = String(m.name || "Commander").slice(0, 16).trim() || "Commander";
      if (!this.players.has(this.myId)) {
        this.players.set(this.myId, {
          id: this.myId,
          name: clean,
          slot: 0,
          ready: true,
          team: 0,
        });
      } else {
        this.players.get(this.myId)!.name = clean;
      }
      this.broadcastLobby();
      return;
    }

    const me = this.players.get(this.myId);
    if (!me) return;

    if (this.phase === "lobby") {
      switch (m.t) {
        case "ready":
          me.ready = !!m.ready;
          this.broadcastLobby();
          return;
        case "setName":
          me.name = String(m.name || "Commander").slice(0, 16).trim() || "Commander";
          this.broadcastLobby();
          return;
        case "setMap":
          if (VALID_MAPS.has(m.map)) {
            this.map = m.map;
            this.broadcastLobby();
          }
          return;
        case "setConfig": {
          const c = m.config ?? {};
          if (typeof c.startCredits === "number" && [3000, 5000, 10000, 20000].includes(c.startCredits))
            this.config.startCredits = c.startCredits;
          if (typeof c.gameSpeed === "number" && [0.75, 1, 1.5, 2].includes(c.gameSpeed))
            this.config.gameSpeed = c.gameSpeed;
          if (typeof c.superweapons === "boolean") this.config.superweapons = c.superweapons;
          if (typeof c.crates === "boolean") this.config.crates = c.crates;
          if (typeof c.derricks === "boolean") this.config.derricks = c.derricks;
          if (typeof c.fog === "boolean") this.config.fog = c.fog;
          if (typeof c.logistics === "boolean") this.config.logistics = c.logistics;
          this.broadcastLobby();
          return;
        }
        case "addbot": {
          const slot = this.freeSlot();
          if (slot < 0) return this.emit({ t: "deny", msg: `room is full (${MAX_PLAYERS} players)` });
          const diff: BotDiff = m.diff && VALID_DIFFS.has(m.diff) ? m.diff : "normal";
          const profile: BotProfile = m.profile && VALID_PROFILES.has(m.profile) ? m.profile : "balanced";
          const id = `bot-${slot}-${Date.now().toString(36)}`;
          this.players.set(id, {
            id,
            name: `CABAL-${slot + 1}`,
            slot,
            ready: true,
            team: 0,
            bot: true,
            diff,
            profile,
          });
          this.broadcastLobby();
          return;
        }
        case "setBotConfig": {
          const b = this.players.get(m.id);
          if (b && b.bot) {
            if (m.diff && VALID_DIFFS.has(m.diff)) b.diff = m.diff;
            if (m.profile && VALID_PROFILES.has(m.profile)) b.profile = m.profile;
            this.broadcastLobby();
          }
          return;
        }
        case "kickbot":
          if (this.players.get(m.id)?.bot) {
            this.players.delete(m.id);
            this.broadcastLobby();
          }
          return;
        case "setTeam": {
          const target = m.id ? this.players.get(m.id) : me;
          if (target) {
            target.team = Math.max(0, Math.min(4, m.team | 0));
            this.broadcastLobby();
          }
          return;
        }
        case "start": {
          if (this.players.size < 2) {
            this.emit({ t: "deny", msg: "need at least 2 players — add a bot!" });
            return;
          }
          this.startGame();
          return;
        }
      }
      return;
    }

    if (m.t === "rematch" && this.phase === "ended") {
      this.stopTimer();
      this.world = null;
      this.bots.clear();
      this.phase = "lobby";
      this.endSent = false;
      this.broadcastLobby();
      return;
    }

    const w = this.world;
    if (!w || this.phase !== "playing") return;
    const slot = me.slot;
    let err: string | null = null;
    switch (m.t) {
      case "order":
        err = w.cmdOrder(slot, m.ids, m.kind, m.x, m.y, m.target, m.queue);
        break;
      case "stop":
        w.cmdStop(slot, m.ids);
        break;
      case "hold":
        w.cmdHold(slot, m.ids);
        break;
      case "drive":
        w.cmdDrive(slot, m.id, m.fwd, m.strafe, m.yaw, m.fire, m.aimX, m.aimY, m.aimTarget, m.alt, m.sprint, m.wpn, m.lock);
        break;
      case "driveExit":
        w.cmdDriveExit(slot, m.id);
        break;
      case "build":
        err = w.cmdBuild(slot, m.kind);
        break;
      case "buildCancel":
        w.cmdBuildCancel(slot, m.cat);
        break;
      case "place":
        err = w.cmdPlace(slot, m.tx, m.ty, m.cat);
        break;
      case "train":
        err = w.cmdTrain(slot, m.unit);
        break;
      case "trainCancel":
        w.cmdTrainCancel(slot, m.unit);
        break;
      case "sell":
        err = w.cmdSell(slot, m.id);
        break;
      case "repair":
        err = w.cmdRepair(slot, m.id);
        break;
      case "upgrade":
        err = w.cmdUpgrade(slot, m.id);
        break;
      case "rally":
        err = w.cmdRally(slot, m.id, m.x, m.y);
        break;
      case "superweapon":
        err = w.cmdSuperweapon(slot, m.x, m.y);
        break;
      case "recon":
        err = w.cmdRecon(slot, m.x, m.y);
        break;
      case "resign":
        w.cmdResign(slot);
        break;
      case "chat":
        this.emit({
          t: "chat",
          name: me.name,
          color: PLAYER_COLORS[slot] ?? "#45d6ff",
          text: String(m.text || "").slice(0, 200),
        });
        break;
      case "ping":
        this.emit({ t: "ping", x: m.x, y: m.y, slot });
        break;
    }
    if (err) this.emit({ t: "deny", msg: err });
  }

  private startGame() {
    const actives = [...this.players.values()];
    const slots = actives.map((p) => p.slot).sort((a, b) => a - b);
    const teams: Record<number, number> = {};
    const names: Record<number, string> = {};
    for (const p of actives) {
      teams[p.slot] = p.team;
      names[p.slot] = p.name;
    }
    const w = new World(slots, { map: this.map, teams, names, config: this.config });
    this.world = w;
    this.bots.clear();
    for (const p of actives) {
      if (p.bot) this.bots.set(p.id, new RtsBot(w, p.slot, { diff: p.diff ?? "normal", profile: p.profile ?? "balanced" }));
    }
    this.phase = "playing";
    this.endSent = false;
    this.emit({
      t: "init",
      you: this.myId,
      slot: 0,
      w: w.w,
      h: w.h,
      map: this.map,
      config: this.config,
      players: actives.map((p) => ({
        id: p.id,
        name: p.name,
        slot: p.slot,
        team: p.team,
      })),
      ore: w.oreSnapshot(),
    });
    this.stopTimer();
    const tickMs = Math.max(40, Math.round(TICK_MS / (this.config.gameSpeed || 1)));
    this.timer = setInterval(() => this.tick(), tickMs);
  }

  private tick() {
    const w = this.world;
    if (!w) return;
    for (const bot of this.bots.values()) {
      try {
        bot.think();
      } catch {
        /* isolate bot error */
      }
    }
    w.step();
    if (w.tick % SNAP_EVERY === 0) {
      this.emit({ t: "snap", tick: w.tick, ...w.snapshot() });
    }
    if (w.winner !== null && !this.endSent) {
      this.endSent = true;
      const names: Record<number, string> = {};
      for (const p of this.players.values()) names[p.slot] = p.name;
      const wp = [...this.players.values()].find((p) => p.slot === w.winner);
      const reason =
        w.winnerTeam && w.winnerTeam > 0 ? `Team ${w.winnerTeam} wins!` : wp ? `${wp.name} wins!` : "draw";
      this.emit({
        t: "end",
        winner: w.winner,
        winnerTeam: w.winnerTeam,
        reason,
        durationSec: Math.round((w.tick * TICK_MS) / 1000),
        stats: w.getStats(names),
      });
      this.stopTimer();
      this.phase = "ended";
    }
  }

  private stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  close() {
    this.stopTimer();
    this.world = null;
  }
}
