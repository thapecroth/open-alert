import { routePartykitRequest, Server } from "partyserver";
import type { Connection } from "partyserver";
import { World } from "./server/world";
import { AIBot } from "./server/bot";
import {
  extractGymObs,
  extractGymFeatureMaps,
  extractGymRgbFrame,
  bytesToBase64,
} from "./server/gym";
import { MCP_TOOLS, FEATURE_MAP_CHANNELS, buildGymSchemaResponse } from "./mcp-schema";
import { applyGameCommand, validIds } from "./server/dispatch";
import { diffSnaps } from "./shared/snapdelta";
import type { C2S, S2C, LobbyPlayer, RoomSummary, OrderKind } from "./shared/protocol";
import {
  MAX_PLAYERS,
  TICK_MS,
  SNAP_EVERY,
  MAP_W,
  MAP_H,
  PLAYER_COLORS,
  DEFAULT_CONFIG,
  MAP_LIST,
  BUILDINGS,
  UNITS,
  getSpawns,
  SHIPYARD_BUILD_DIST,
  UPGRADE_PATHS,
} from "./shared/gamedefs";
import type { MapId, BotDiff, BotProfile, GameConfig, BuildingKind, BuildCategory, UnitKind } from "./shared/gamedefs";

interface Env {
  GameRoom: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface PersistedMatch {
  savedAt: number;
  // gzip(JSON.stringify({ phase, map, config, players, world-sans-ore })) —
  // repetitive Ent field names compress ~4-6x, keeping DO write units low
  gz: ArrayBuffer;
}

interface PersistedOre {
  at: number;
  map?: MapId; // paired game — an ore blob from a DIFFERENT match must not restore
  ore: ArrayBuffer; // Int16Array buffer — changes slowly (mining), written rarely
}

interface PersistedCore {
  phase: "playing";
  map: MapId;
  config: GameConfig;
  players: PlayerRec[];
  hostId?: string | null;
  world: Omit<ReturnType<World["serialize"]>, "ore">;
}

const PERSIST_LIVE_MS = 3000; // checkpoint every ~3s while simulating
const PERSIST_PAUSED_MS = 60_000; // slower heartbeat while solo-paused
const PERSIST_ORE_MS = 30_000; // ore field drifts slowly; 30s is plenty
const MATCH_STALE_MS = 10 * 60 * 1000; // older than 10min = abandoned, drop it
const SNAP_KEYFRAME_EVERY = 20; // broadcast keyframe every N snapshots (~4s at 5 Hz) for drift safety

interface PlayerRec {
  id: string;
  connId: string | null;
  name: string;
  slot: number;
  ready: boolean;
  spectator: boolean;
  wantSpectate?: boolean;
  connected: boolean;
  team: number;
  bot?: boolean;
  mcp?: boolean;
  diff?: BotDiff;
  profile?: BotProfile;
}

const send = (conn: Connection, msg: S2C) => conn.send(JSON.stringify(msg));
const VALID_MAPS = new Set<MapId>(MAP_LIST.map((m) => m.id));
const VALID_DIFFS = new Set<BotDiff>(["easy", "normal", "brutal"]);
const VALID_PROFILES = new Set<BotProfile>(["balanced", "rusher", "turtle", "tech"]);
const VALID_CREDITS = new Set([3000, 5000, 10000, 20000]);
const VALID_SPEEDS = new Set([0.75, 1, 1.5, 2]);
const hasOwn = (o: object, k: unknown): boolean =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
const isQuotaError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /Exceeded allowed duration|quota|limit/i.test(msg);
};
const round1 = (n: number) => Math.round(n * 10) / 10;

const MCP_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-session-id, mcp-protocol-version, authorization",
};

export class GameRoom extends Server<Env> {
  phase: "lobby" | "playing" | "ended" = "lobby";
  map: MapId = "crossroads";
  config: GameConfig = { ...DEFAULT_CONFIG };
  players = new Map<string, PlayerRec>(); // by player id (client token)
  connPlayer = new Map<string, string>(); // conn id -> player id
  // last inbound-message time per conn — a half-open TCP socket (client network
  // died silently: NAT drop, laptop sleep, network switch) never fires onClose
  // server-side, so without liveness tracking a zombie conn keeps its player
  // connected:true forever and blocks lobby start with phantom "not ready".
  private connLastMsg = new Map<string, number>();
  private hostId: string | null = null;
  world: World | null = null;
  alarmActive = false;
  alarmTarget = 0; // ideal-timeline timestamp the alarm loop schedules against
  paused = false; // solo-vs-bots freeze: alarm keeps rescheduling, sim skips stepping
  resetTimer: ReturnType<typeof setTimeout> | null = null;
  lastTickAt = 0;
  lastPersistAt = 0;
  lastOrePersistAt = 0;
  endSent = false;
  bots = new Map<string, AIBot>(); // player id -> AI brain, ticked once per game tick
  // ---- delta-compressed snapshot stream (v2) ----
  // snapBase retains the last broadcast full state (immutable — snapshot()
  // rebuilds it fresh every frame) as the diffing baseline AND the join-
  // keyframe source. Keyed to the World instance so any new/reset/restored
  // world automatically forces a fresh keyframe sequence.
  snapSeq = 0;
  snapBase: { world: World; tick: number; snap: ReturnType<World["snapshot"]> } | null = null;
  private joinKeyJson: string | null = null;
  private joinKeySeq = -1;
  private connV2 = new Set<string>(); // conn ids that joined with v:2 (delta-stream capable)
  private dir = new Map<string, RoomSummary>(); // used only when this.name === "__directory"
  // Client-error telemetry ring: browsers POST uncaught exceptions/rejections/
  // console.errors over plain HTTP (independent of ws health — the dead-socket
  // case is exactly what this exists to diagnose). Memory-only, last 100.
  private clientErrors: { ts: number; name: string; kind: string; msg: string; stack?: string; phase?: string; slot?: number; ua?: string; n?: number }[] = [];

  // ---------- match persistence: survive DO restarts/evictions ----------
  // A live match's state lives in memory; when the DO restarts (deploy, host
  // migration, eviction) it used to vanish and dump players into a reset lobby.
  // Now we checkpoint to DO storage every ~3s + on start, and restore onStart.

  onStart(): void | Promise<void> {
    if (this.name === "__directory") return;
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const saved = await this.ctx.storage.get<PersistedMatch>("match");
        if (!saved || !(saved.gz instanceof ArrayBuffer)) return;
        if (Date.now() - saved.savedAt > MATCH_STALE_MS) {
          await this.ctx.storage.delete(["match", "matchOre"]).catch(() => {});
          return;
        }
        const json = await new Response(
          new Blob([saved.gz]).stream().pipeThrough(new DecompressionStream("gzip")),
        ).text();
        const rec = JSON.parse(json) as PersistedCore;
        if (rec.phase !== "playing" || !rec.world) return;
        const oreRec = await this.ctx.storage.get<PersistedOre>("matchOre");
        const world = {
          ...rec.world,
          ore: oreRec?.ore && (!oreRec.map || oreRec.map === rec.map) ? new Int16Array(oreRec.ore) : undefined,
        };
        this.world = World.deserialize(world);
        this.phase = "playing";
        this.map = rec.map;
        this.config = rec.config;
        this.hostId = typeof rec.hostId === "string" ? rec.hostId : null;
        this.paused = false;
        this.endSent = false;
        for (const p of rec.players) {
          // nobody is actually connected yet — sockets rejoin via token
          const prec: PlayerRec = { ...p, connId: null, connected: false };
          this.players.set(prec.id, prec);
          if (prec.bot) this.bots.set(prec.id, new AIBot(prec.id, { diff: prec.diff, profile: prec.profile }));
        }
        this.alarmActive = true;
        this.lastTickAt = Date.now();
        this.ensureLoop();
        this.reportDirectory();
      } catch (err) {
        console.error("match restore failed:", err);
      }
    });
  }

  private persist() {
    if (this.name === "__directory" || this.phase !== "playing" || !this.world) return;
    const now = Date.now();
    this.lastPersistAt = now;
    const { ore, ...worldCore } = this.world.serialize();
    const core: PersistedCore = {
      phase: "playing",
      map: this.map,
      config: this.config,
      players: [...this.players.values()],
      hostId: this.hostId,
      world: worldCore,
    };
    const writeOre = !!ore && now - this.lastOrePersistAt >= PERSIST_ORE_MS;
    if (writeOre) this.lastOrePersistAt = now;
    void (async () => {
      try {
        const gz = await new Response(
          new Blob([JSON.stringify(core)]).stream().pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer();
        // the match may have ended/reset while we were compressing — writing now
        // would resurrect a ghost match that re-persists itself forever
        if (this.phase !== "playing" || !this.world) return;
        const puts: Promise<unknown>[] = [
          this.ctx.storage.put("match", { savedAt: now, gz } satisfies PersistedMatch),
        ];
        if (writeOre && ore) {
          puts.push(
            this.ctx.storage.put("matchOre", { at: now, map: this.map, ore: ore.slice().buffer } satisfies PersistedOre),
          );
        }
        await Promise.all(puts);
      } catch {
        /* checkpoint is best-effort */
      }
    })();
  }

  private clearPersist() {
    void this.ctx.storage.delete(["match", "matchOre"]).catch(() => {});
  }

  onClose(conn: Connection, code?: number) {
    const pid = this.connPlayer.get(conn.id);
    this.connPlayer.delete(conn.id);
    this.connV2.delete(conn.id);
    this.connLastMsg.delete(conn.id);
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
    const noHumans = [...this.players.values()].every((x) => x.bot || !x.connected);
    if (noHumans) {
      // During an active match, ALWAYS keep the room alive for a 30s reconnect grace window regardless of
      // WebSocket close code (1000 from PartySocket.reconnect(), 1001 from page refresh, 1006 from Wi-Fi drops, etc.)
      // so a brief reconnect or F5 refresh seamlessly rejoins instead of wiping the match!
      if (this.phase === "playing") {
        if (!this.resetTimer) {
          this.resetTimer = setTimeout(() => {
            this.resetTimer = null;
            if (this.phase === "playing" && [...this.players.values()].every((x) => x.bot || !x.connected)) {
              this.resetRoom();
            }
          }, 30000);
        }
      } else {
        this.resetRoom();
      }
    } else {
      this.broadcastLobby();
    }
  }

  // Reap connections that have gone completely silent. Healthy clients heartbeat
  // every 15s, so 30s without ANY message means the socket is half-open dead —
  // close it, which funnels into onClose's normal cleanup (lobby: frees the
  // player's slot so they stop blocking start; playing: 30s reconnect grace).
  // Scanned lazily on inbound traffic: a lobby where everyone is zombie-silent
  // has nobody left who cares, and any real activity (join/click) triggers a sweep.
  private static readonly IDLE_CONN_MS = 30_000;
  private reapIdleConns() {
    // lobby phases only — mid-match a quiet connection is legitimate (passive
    // spectators, observers) and zombies there block nothing; in the lobby a
    // zombie permanently blocks start with phantom "not ready" denies.
    if (this.phase === "playing") return;
    const now = Date.now();
    let swept = false;
    for (const conn of this.getConnections()) {
      const last = this.connLastMsg.get(conn.id);
      if (last === undefined || now - last <= GameRoom.IDLE_CONN_MS) continue;
      // mark the player disconnected rather than deleting the record: a network
      // casualty is not a rage-quit — the slot/team/name survive for the rejoin
      // (reconnecting clients resend join with their token automatically), and
      // disconnected players are excluded from start validation, so the phantom
      // "not ready" block lifts the moment the sweep lands.
      const pid = this.connPlayer.get(conn.id);
      this.connPlayer.delete(conn.id);
      this.connLastMsg.delete(conn.id);
      if (pid) {
        const p = this.players.get(pid);
        if (p && p.connId === conn.id) {
          if (p.spectator) this.players.delete(pid); // spectators hold no slot worth saving
          else {
            p.connected = false;
            p.connId = null;
          }
        }
      }
      try {
        conn.close(4001, "idle timeout");
      } catch {
        /* already closing */
      }
      swept = true;
    }
    if (swept) {
      // mirror onClose's bookkeeping for the room as a whole
      // (never phase "playing" here — the reaper returns early in that case)
      const noHumans = [...this.players.values()].every((x) => x.bot || !x.connected);
      if (noHumans) this.resetRoom();
      else this.broadcastLobby();
    }
  }

  onMessage(conn: Connection, raw: string | ArrayBuffer) {
    let m: C2S;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!m || typeof m !== "object" || typeof (m as { t?: unknown }).t !== "string") return;
    this.connLastMsg.set(conn.id, Date.now());
    this.reapIdleConns();
    try {
      this.dispatch(conn, m);
    } catch (err) {
      // never let a malformed command take down the connection or the room —
      // but log it: a throwing handler is a bug, silence hides regressions
      console.error("dispatch error:", err);
    }
  }

  private dispatch(conn: Connection, m: C2S) {
    const pid = this.connPlayer.get(conn.id);
    const me = pid ? this.players.get(pid) : null;

    switch (m.t) {
      case "hb":
        send(conn, { t: "hbok" } satisfies S2C);
        if (this.resetTimer) {
          clearTimeout(this.resetTimer);
          this.resetTimer = null;
        }
        if (this.phase === "playing" && this.world && (!this.alarmActive || Date.now() - this.lastTickAt > 2000)) {
          this.ensureLoop();
        }
        return;
      case "join":
        return this.handleJoin(conn, m.name, m.token, m.spectate, m.v);
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
          const limit = this.mapSlotLimit();
          const invalid = actives.find((p) => p.slot >= limit);
          if (invalid) {
            return send(conn, {
              t: "deny",
              msg: `${invalid.name} is in slot ${invalid.slot + 1}, outside this map's ${limit} spawn slots`,
            } satisfies S2C);
          }
          const unready = actives.filter((p) => !p.bot && p.id !== me.id && !p.ready);
          if (unready.length) return send(conn, { t: "deny", msg: `${unready[0].name} is not ready` });
          const firstTeam = actives[0].team;
          if (firstTeam > 0 && actives.every((p) => p.team === firstTeam)) {
            return send(conn, { t: "deny", msg: "need opponents on another team" });
          }
          this.startGame();
        } else if (this.phase === "lobby") {
          // Never drop a start click silently: an unbound connection means the
          // client's command raced ahead of its rejoin (half-open reconnect gap),
          // and a non-host click means the UI/host state desynced — both need
          // visible feedback instead of a dead button.
          if (!me) send(conn, { t: "deny", msg: "still reconnecting — click START again" } satisfies S2C);
          else if (!this.isHost(me)) send(conn, { t: "deny", msg: "only the host can start the game" } satisfies S2C);
        }
        return;
      case "addbot":
        if (me && this.isHost(me) && this.phase === "lobby") {
          const diff: BotDiff = typeof m.diff === "string" && VALID_DIFFS.has(m.diff) ? m.diff : "normal";
          const profile: BotProfile =
            typeof m.profile === "string" && VALID_PROFILES.has(m.profile) ? m.profile : "balanced";
          if (!this.addBot(diff, profile)) {
            send(conn, { t: "deny", msg: `room is full (${this.mapSlotLimit()} players on this map)` });
          }
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
      case "transferHost":
        if (me && this.isHost(me) && typeof m.id === "string") {
          const target = this.players.get(m.id);
          if (target && target !== me && target.connected && !target.spectator && !target.bot) {
            this.hostId = target.id;
            this.broadcastLobby();
          }
        }
        return;
      case "setMap":
        if (me && this.isHost(me) && this.phase === "lobby" && typeof m.map === "string" && VALID_MAPS.has(m.map)) {
          const limit = this.mapSlotLimit(m.map);
          const blocked = [...this.players.values()].find((p) => !p.spectator && p.slot >= limit);
          if (blocked) {
            send(conn, {
              t: "deny",
              msg: `${blocked.name} occupies slot ${blocked.slot + 1}; that map supports only ${limit} spawn slots`,
            } satisfies S2C);
          } else {
            this.map = m.map;
            this.broadcastLobby();
          }
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
          if (typeof c.logistics === "boolean") this.config.logistics = c.logistics;
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
      case "setSlot":
        if (me) this.handleSetSlot(conn, me, m);
        return;
      case "swapSlot":
        if (me) this.handleSwapSlot(conn, me, m);
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
      case "ping": {
        const mw = this.world?.w ?? MAP_W;
        const mh = this.world?.h ?? MAP_H;
        if (me && Number.isFinite(m.x) && Number.isFinite(m.y) && m.x >= 0 && m.y >= 0 && m.x < mw && m.y < mh) {
          this.broadcast(JSON.stringify({ t: "ping", x: m.x, y: m.y, slot: me.slot } satisfies S2C));
        }
        return;
      }
      case "rematch":
        if (me && this.phase === "ended") {
          this.phase = "lobby";
          this.world = null;
          this.lastTickAt = 0;
          this.endSent = false;
          // spectators who joined mid-game get real slots so they can play next
          // round — but only while a slot is free; a full room keeps them spectating
          const used = new Set([...this.players.values()].filter((p) => !p.spectator).map((p) => p.slot));
          const limit = this.mapSlotLimit();
          for (const p of this.players.values()) {
            p.ready = !!p.bot || !!p.mcp;
            if (p.spectator && !p.wantSpectate) {
              for (let s = 0; s < limit; s++)
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

    // in-game commands — validation + application shared with the local solo
    // room via src/server/dispatch.ts so both transports enforce identical rules
    if (!me || me.spectator || !this.world || this.phase !== "playing") return;
    const slot = me.slot;
    const cmdErr = applyGameCommand(this.world, slot, m);
    if (cmdErr !== undefined) {
      if (cmdErr) send(conn, { t: "deny", msg: cmdErr });
      return;
    }
    if (m.t === "pause") {
      // Pause only works when the requester is the sole human — solo games vs bots
      let humans = 0;
      for (const [opid, p] of this.players) {
        if (!p.spectator && !this.bots.has(opid)) humans++;
      }
      if (humans > 1) {
        send(conn, { t: "deny", msg: "pause only works in solo games vs bots" });
        return;
      }
      this.paused = !!m.paused;
      this.broadcast(JSON.stringify({ t: "paused", paused: this.paused } satisfies S2C));
    }
  }

  private handleJoin(conn: Connection, name: string, token?: string, spectate?: boolean, v?: number) {
    // protocol v2 = delta-stream capable; absent/older means legacy full-snapshots-only
    // (the MCP stdio bridge and older cached clients join without v and must not break)
    if (v === 2) this.connV2.add(conn.id);
    else this.connV2.delete(conn.id);
    const clean = String(name || "Commander").slice(0, 16).trim() || "Commander";
    const tok = typeof token === "string" && token.length > 0 && token.length <= 64 ? token : undefined;

    // Explicit spectator join: never occupies a player slot or triggers host transfer
    if (spectate === true) {
      if (this.resetTimer) {
        clearTimeout(this.resetTimer);
        this.resetTimer = null;
      }
      const existing = tok ? this.players.get(tok) : undefined;
      const id = tok && (!existing || existing.spectator) ? tok : `spec-${crypto.randomUUID().slice(0, 8)}`;
      const prev = this.players.get(id);
      if (prev && prev.connId && prev.connId !== conn.id) {
        for (const c of this.getConnections()) if (c.id === prev.connId) c.close(4000, "replaced");
        this.connPlayer.delete(prev.connId);
      }
      const p: PlayerRec = {
        id,
        connId: conn.id,
        name: clean,
        slot: -1,
        ready: false,
        spectator: true,
        wantSpectate: true,
        connected: true,
        team: 0,
      };
      this.players.set(id, p);
      this.connPlayer.set(conn.id, id);
      if (this.phase === "playing" && this.world) {
        this.ensureLoop();
        this.sendInit(conn, p);
        this.broadcastLobby();
      } else {
        this.broadcastLobby();
      }
      return;
    }

    // rejoin with a known token (reconnect / refresh / second tab)
    if (tok) {
      const p = this.players.get(tok);
      if (p) {
        if (this.resetTimer) {
          clearTimeout(this.resetTimer);
          this.resetTimer = null;
        }
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
          this.ensureLoop();
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

    const used = new Set([...this.players.values()].filter((x) => !x.spectator && x.slot >= 0).map((p) => p.slot));
    const limit = this.mapSlotLimit();
    let slot = -1;
    for (let s = 0; s < limit; s++)
      if (!used.has(s)) {
        slot = s;
        break;
      }
    if (slot < 0) {
      send(conn, { t: "deny", msg: `room is full (${limit} players on this map)` });
      conn.close(4000, "room full");
      return;
    }
    const p: PlayerRec = { id, connId: conn.id, name: clean, slot, ready: false, spectator: false, connected: true, team: 0 };
    this.players.set(id, p);
    this.connPlayer.set(conn.id, id);
    this.broadcastLobby();
  }

  private resolveHostId(): string | undefined {
    // host is always a connected human — a bot must never hold the start button
    const humans = [...this.players.values()]
      .filter((x) => x.connected && !x.spectator && !x.bot)
      .sort((a, b) => a.slot - b.slot);
    if (!humans.length) return undefined;
    // deliberate explicit transfer beats the 'v' auto-claim — 'v' keeps host
    // against slot-order accidents but can voluntarily give it away
    if (this.hostId && humans.some((x) => x.id === this.hostId)) return this.hostId;
    const v = humans.find((x) => x.name === "v");
    if (v) return v.id;
    return humans[0].id;
  }

  private isHost(p: PlayerRec) {
    return this.resolveHostId() === p.id;
  }

  // Valid spawn/color slots are capped by BOTH the global player palette and the
  // currently selected map. getSpawns() is dimension-driven today, but using its
  // length here keeps future lower-spawn layouts authoritative too.
  private mapSlotLimit(map: MapId = this.map): number {
    const meta = MAP_LIST.find((m) => m.id === map);
    const w = meta?.w ?? MAP_W;
    const h = meta?.h ?? MAP_H;
    return Math.max(1, Math.min(MAX_PLAYERS, meta?.maxPlayers ?? MAX_PLAYERS, getSpawns(w, h).length));
  }

  private playerAtSlot(slot: number, exceptId?: string): PlayerRec | undefined {
    for (const p of this.players.values()) {
      if (p.id !== exceptId && !p.spectator && p.slot === slot) return p;
    }
    return undefined;
  }

  // Host fallback historically follows the lowest occupied slot. Once players can
  // rearrange slots, that fallback must not silently transfer host as a side effect
  // of a spawn move/swap — pin the pre-change host; v still overrides in resolveHostId().
  private pinHostBeforeSlotChange() {
    const hostId = this.resolveHostId();
    if (hostId) this.hostId = hostId;
  }

  private denySlot(conn: Connection, msg: string) {
    send(conn, { t: "deny", msg } satisfies S2C);
  }

  private handleSetSlot(conn: Connection, me: PlayerRec, m: { slot: number; id?: string }) {
    if (this.phase !== "lobby") return this.denySlot(conn, "spawn slots can only change in the lobby");
    if (me.spectator || me.slot < 0) return this.denySlot(conn, "spectators do not have spawn slots");
    const limit = this.mapSlotLimit();
    if (!Number.isInteger(m.slot) || m.slot < 0 || m.slot >= limit) {
      return this.denySlot(conn, `invalid spawn slot for this map (0-${limit - 1})`);
    }

    let target = me;
    if (typeof m.id === "string" && m.id !== me.id) {
      if (!this.isHost(me)) return this.denySlot(conn, "only the host can move another player");
      const other = this.players.get(m.id);
      if (!other || other.spectator || other.slot < 0) return this.denySlot(conn, "target player has no spawn slot");
      target = other;
    }
    if (target.slot === m.slot) return; // harmless no-op

    const occupant = this.playerAtSlot(m.slot, target.id);
    if (occupant) return this.denySlot(conn, `slot ${m.slot + 1} is occupied — use swap`);

    this.pinHostBeforeSlotChange();
    target.slot = m.slot;
    this.broadcastLobby();
  }

  private handleSwapSlot(conn: Connection, me: PlayerRec, m: { id: string; id2?: string }) {
    if (this.phase !== "lobby") return this.denySlot(conn, "spawn slots can only change in the lobby");
    if (me.spectator || me.slot < 0) return this.denySlot(conn, "spectators do not have spawn slots");
    const first = typeof m.id === "string" ? this.players.get(m.id) : undefined;
    if (!first || first.spectator || first.slot < 0) return this.denySlot(conn, "target player has no spawn slot");

    // Default semantics are requester↔target. Hosts may instead pass id2 to
    // rearrange any two occupants atomically — important in a full lobby where
    // there is no spare slot to use as a temporary holding cell.
    let a = me;
    let b = first;
    if (typeof m.id2 === "string") {
      if (!this.isHost(me)) return this.denySlot(conn, "only the host can swap two other players");
      const second = this.players.get(m.id2);
      if (!second || second.spectator || second.slot < 0) return this.denySlot(conn, "second target player has no spawn slot");
      if (second.id === first.id) return this.denySlot(conn, "cannot swap a player with themselves");
      a = first;
      b = second;
    } else {
      if (first.id === me.id) return this.denySlot(conn, "cannot swap slots with yourself");
      if (!first.bot && !this.isHost(me)) {
        return this.denySlot(conn, "only the host can swap with another human");
      }
    }

    const limit = this.mapSlotLimit();
    if (a.slot >= limit || b.slot >= limit) return this.denySlot(conn, "spawn slot is not valid for this map");

    this.pinHostBeforeSlotChange();
    const slot = a.slot;
    a.slot = b.slot;
    b.slot = slot;
    this.broadcastLobby();
  }

  private lobbyList(): LobbyPlayer[] {
    const hostId = this.resolveHostId();
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
      if (pid)
        send(conn, { t: "lobby", players, you: pid, room: this.name, map: this.map, phase: this.phase, config: this.config });
    }
    this.reportDirectory();
  }

  private pruneDir(now = Date.now()) {
    for (const [room, s] of this.dir) {
      const ttl = s.phase === "ended" ? 15000 : 45000;
      if (s.players <= 0 || now - s.updatedAt > ttl) {
        this.dir.delete(room);
      }
    }
  }

  private reportDirectory(remove = false) {
    let roomName: string;
    try {
      roomName = this.name;
    } catch {
      return;
    }
    if (!roomName || roomName === "__directory" || !this.env?.GameRoom) return;
    let payload: { op: "delete"; room: string } | { op: "upsert"; summary: RoomSummary };
    if (remove) {
      payload = { op: "delete", room: roomName };
    } else {
      const all = [...this.players.values()];
      const nonSpec = all.filter((p) => !p.spectator && p.slot >= 0);
      const bots = nonSpec.filter((p) => p.bot).length;
      const humans = nonSpec.length - bots;
      const spectators = all.filter((p) => p.spectator && p.connected).length;
      const summary: RoomSummary = {
        room: roomName,
        phase: this.phase,
        map: this.map,
        players: nonSpec.length,
        humans,
        bots,
        spectators,
        tick: this.world?.tick ?? 0,
        ents: this.world?.ents.size ?? 0,
        names: nonSpec.map((p) => p.name),
        updatedAt: Date.now(),
      };
      payload = nonSpec.length === 0 ? { op: "delete", room: roomName } : { op: "upsert", summary };
    }
    try {
      const stub = this.env.GameRoom.getByName("__directory");
      void stub
        .fetch(
          new Request("https://internal/dir", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        )
        .then((r) => r.body?.cancel())
        .catch(() => {});
    } catch {
      // never throw or block ticks on directory reporting
    }
  }

  private sendInit(conn: Connection, p: PlayerRec) {
    if (!this.world) return;
    send(conn, {
      t: "init",
      you: p.id,
      slot: p.spectator ? -1 : p.slot,
      w: this.world.w,
      h: this.world.h,
      map: this.map,
      config: this.config,
      ore: this.world.oreSnapshot(),
      players: [...this.players.values()]
        .filter((x) => !x.spectator)
        .map((x) => ({ id: x.id, slot: x.slot, name: x.name, team: x.team })),
    });
    // sync the delta stream immediately — the joiner must not wait for the next
    // broadcast keyframe. Reliable+ordered delivery guarantees every frame after
    // this one applies cleanly onto it. Legacy clients simply see one extra full
    // snapshot, which is exactly their normal frame shape.
    const key = this.joinKeyframeJson();
    if (key) conn.send(key);
  }

  private addBot(diff: BotDiff = "normal", profile: BotProfile = "balanced"): boolean {
    const used = new Set([...this.players.values()].filter((p) => p.slot >= 0).map((p) => p.slot));
    const limit = this.mapSlotLimit();
    let slot = -1;
    for (let s = 0; s < limit; s++)
      if (!used.has(s)) {
        slot = s;
        break;
      }
    if (slot < 0) return false;
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
    return true;
  }

  private startGame() {
    const actives = [...this.players.values()].filter((p) => p.connected && !p.spectator && p.slot >= 0);
    const slots = actives.map((p) => p.slot).sort((a, b) => a - b);
    const limit = this.mapSlotLimit();
    if (!slots.length || actives.some((p) => p.slot >= limit)) return;
    const teams: Record<number, number> = {};
    const names: Record<number, string> = {};
    for (const p of actives) {
      teams[p.slot] = p.team;
      names[p.slot] = p.name;
    }
    this.world = new World(slots, { map: this.map, teams, names, config: this.config });
    this.phase = "playing";
    this.lastOrePersistAt = 0; // force a fresh ore checkpoint for the new match
    this.paused = false;
    this.endSent = false;
    for (const conn of this.getConnections()) {
      const pid = this.connPlayer.get(conn.id);
      const p = pid ? this.players.get(pid) : null;
      if (p) this.sendInit(conn, p);
    }
    if (this.phase === "playing" && this.world) {
      this.alarmActive = true;
      this.lastTickAt = Date.now();
      this.ensureLoop();
    }
    this.persist();
    this.reportDirectory();
  }

  private stepIntervalMs(): number {
    return Math.max(80, Math.round((TICK_MS * SNAP_EVERY) / (this.config.gameSpeed || 1)));
  }

  private ensureLoop() {
    // Pure Durable Object Alarm loop (ZERO setInterval!) — immune to cloudflare/workerd#8474
    // where cumulative setInterval CPU silently resets a DO isolate after ~2s of CPU.
    if (this.phase === "playing" && this.world) {
      this.alarmActive = true;
      this.alarmTarget = Date.now() + 50;
      void this.ctx.storage.setAlarm(this.alarmTarget).catch(() => {});
    }
  }

  async onAlarm() {
    if (this.phase !== "playing" || !this.world) {
      this.alarmActive = false;
      await this.ctx.storage.deleteAlarm().catch(() => {});
      return;
    }
    // Run SNAP_EVERY (2) sim ticks per alarm invocation = 10 Hz sim + 5 Hz snapshots
    // with a fresh per-alarm CPU budget and zero setInterval timers.
    for (let i = 0; i < SNAP_EVERY; i++) {
      if (this.phase !== "playing" || !this.world) break;
      this.gameTick();
    }
    if (this.phase === "playing" && this.world) {
      // Schedule against the ideal timeline (last target + interval), NOT
      // now+interval — handler execution time must not stretch the cadence or
      // the sim runs slow-motion under load. Clamp to now+20ms minimum so a
      // hopelessly-behind timeline shifts forward instead of catch-up spiraling.
      const interval = this.stepIntervalMs();
      const now = Date.now();
      let target = (this.alarmTarget || now) + interval;
      if (target < now + 20) target = now + 20;
      this.alarmTarget = target;
      await this.ctx.storage.setAlarm(target).catch(() => {});
    } else {
      this.alarmActive = false;
      await this.ctx.storage.deleteAlarm().catch(() => {});
    }
  }

  // Delta-compressed snapshot fan-out. The wire is reliable+ordered, so one
  // server-side delta stream works for every v2 connection: sparse per-ent
  // partials most frames, a full keyframe every SNAP_KEYFRAME_EVERY for drift
  // safety. Legacy connections (no v:2 join — MCP bridge, older cached clients)
  // still receive a full snapshot every frame, encoded once per frame and only
  // when such a connection exists.
  private broadcastSnap(w: World) {
    const snap = w.snapshot();
    this.snapSeq++;
    const seq = this.snapSeq;
    const tick = w.tick;
    const base = this.snapBase && this.snapBase.world === w ? this.snapBase : null;
    const isKey = !base || seq % SNAP_KEYFRAME_EVERY === 0;
    const keyJson = isKey ? JSON.stringify({ t: "snap", seq, key: true, tick, ...snap } satisfies S2C) : null;
    let deltaJson: string | null = null;
    let fullJson: string | null = null;
    for (const conn of this.getConnections()) {
      if (this.connV2.has(conn.id)) {
        if (keyJson) {
          conn.send(keyJson);
        } else {
          // snapshot() collects exactly this diff as a byproduct of its
          // memoization compare (zero redundant work, no O(N) rebuild Map);
          // it is valid only when our baseline IS the previous snapshot object
          // — any interleaved snapshot() caller or a restored world falls back
          // to the standalone diffSnaps.
          const meta = w.snapDelta;
          const fastDiff = meta && base && base.snap === meta.from ? meta.diff : null;
          deltaJson ??= JSON.stringify({
            t: "snapd",
            seq,
            tick,
            ...(fastDiff ?? diffSnaps(base!.snap, snap)),
            events: snap.events,
          } satisfies S2C);
          conn.send(deltaJson);
        }
      } else if (keyJson) {
        // keyframe payloads ARE the legacy full-snapshot shape — one encoding serves both
        conn.send(keyJson);
      } else {
        fullJson ??= JSON.stringify({ t: "snap", seq, tick, ...snap } satisfies S2C);
        conn.send(fullJson);
      }
    }
    this.snapBase = { world: w, tick, snap };
  }

  // Immediate keyframe for a (re)joining connection, built from the retained
  // baseline — without it a mid-stream joiner would wait up to ~4s for the next
  // broadcast keyframe with no state. Events are stripped: they were transient
  // visual effects of a frame the joiner never saw, and state is what matters.
  // Encoded lazily once per baseline (joins are rare, frames are not).
  private joinKeyframeJson(): string | null {
    const base = this.snapBase;
    if (!base || (this.world && base.world !== this.world)) return null;
    if (this.joinKeySeq !== this.snapSeq) {
      this.joinKeyJson = JSON.stringify({
        t: "snap",
        seq: this.snapSeq,
        key: true,
        tick: base.tick,
        ents: base.snap.ents,
        crates: base.snap.crates,
        bridges: base.snap.bridges,
        players: base.snap.players,
        events: [],
      } satisfies S2C);
      this.joinKeySeq = this.snapSeq;
    }
    return this.joinKeyJson;
  }

  private gameTick() {
    const w = this.world;
    if (!w) return;
    this.lastTickAt = Date.now();
    if (this.paused) {
      // sim frozen — keep the alarm alive, skip stepping; heartbeat the save
      // so a paused match never ages into "stale" while the room still lives
      if (Date.now() - this.lastPersistAt >= PERSIST_PAUSED_MS) this.persist();
      return;
    }
    try {
      for (const [pid, bot] of this.bots) {
        const p = this.players.get(pid);
        if (p && p.slot >= 0) {
          try {
            bot.tick(w, p.slot);
          } catch (err) {
            console.error("bot tick error:", err);
          }
        }
      }
      w.step();
      if (w.tick % SNAP_EVERY === 0) {
        this.broadcastSnap(w);
      }
      if (w.tick % 50 === 0) {
        this.reportDirectory();
      }
      if (Date.now() - this.lastPersistAt >= PERSIST_LIVE_MS) {
        this.persist();
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
            winner: w.winner >= 0 ? w.winner : null,
            winnerTeam: w.winnerTeam,
            reason,
            durationSec: Math.round((w.tick * TICK_MS) / 1000),
            stats: w.getStats(names),
          } satisfies S2C),
        );
        this.alarmActive = false;
        this.phase = "ended";
        void this.ctx.storage.deleteAlarm().catch(() => {});
        this.clearPersist();
        this.reportDirectory();
      }
    } catch (err) {
      console.error("gameTick error:", err);
    }
  }

  private resetRoom() {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    this.alarmActive = false;
    void this.ctx.storage.deleteAlarm().catch(() => {});
    this.world = null;
    this.lastTickAt = 0;
    this.paused = false;
    this.phase = "lobby";
    this.map = "crossroads";
    this.config = { ...DEFAULT_CONFIG };
    this.hostId = null;
    this.endSent = false;
    this.players.clear();
    this.bots.clear();
    this.clearPersist();
    this.reportDirectory(true);
  }

  private mcpPlayer(token: unknown): PlayerRec | null {
    if (typeof token !== "string" || !token) return null;
    const p = this.players.get(token);
    if (!p || p.spectator || p.slot < 0) return null;
    return p;
  }

  private findPlacementSpot(slot: number, kind: BuildingKind): { tx: number; ty: number } | null {
    const w = this.world;
    if (!w) return null;
    const d = BUILDINGS[kind];
    const spawns = getSpawns(w.w, w.h);
    const ownBuildings: { x: number; y: number }[] = [];
    let anchorX = spawns[slot]?.x ?? 8;
    let anchorY = spawns[slot]?.y ?? 8;
    let sawConyard = false;
    let hubAnchor: { x: number; y: number } | null = null;
    for (const e of w.ents.values()) {
      if (e.o === slot && hasOwn(BUILDINGS, e.k)) {
        const pt = { x: Math.floor(e.x), y: Math.floor(e.y) };
        ownBuildings.push(pt);
        if (e.k === "conyard") {
          sawConyard = true;
          anchorX = pt.x;
          anchorY = pt.y;
        } else if (e.k === "supplyhub" && !hubAnchor) {
          hubAnchor = pt;
        }
      }
    }
    // With the ConYard gone, automated placement should search outward from the
    // backup forward base rather than the long-dead original spawn anchor.
    if (!sawConyard && hubAnchor) {
      anchorX = hubAnchor.x;
      anchorY = hubAnchor.y;
    }
    const maxRadius = d.waterOnly ? SHIPYARD_BUILD_DIST + 6 : d.forwardRange ? d.forwardRange + 2 : 16;
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const tx = anchorX + dx;
          const ty = anchorY + dy;
          if (w.canPlace(slot, kind, tx, ty) === null) return { tx, ty };
        }
      }
    }
    const localR = d.waterOnly ? SHIPYARD_BUILD_DIST + 3 : 6;
    for (const b of ownBuildings) {
      for (let r = 1; r <= localR; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
            const tx = b.x + dx;
            const ty = b.y + dy;
            if (w.canPlace(slot, kind, tx, ty) === null) return { tx, ty };
          }
        }
      }
    }
    return null;
  }

  private handleMcpAction(op: string, args: Record<string, unknown>): Record<string, unknown> {
    const origin =
      typeof args.origin === "string" && args.origin ? args.origin : "https://open-alert.thapecroth.workers.dev";

    if (op === "create_ai_arena") {
      if (this.resetTimer) {
        clearTimeout(this.resetTimer);
        this.resetTimer = null;
      }
      if (this.phase === "playing") {
        return {
          ok: false,
          error: "room already has an active match; specify another room or omit room to auto-create",
        };
      }
      this.alarmActive = false;
      void this.ctx.storage.deleteAlarm().catch(() => {});
      this.world = null;
      this.lastTickAt = 0;
      this.endSent = false;
      this.phase = "lobby";
      this.bots.clear();
      // Preserve any connected spectators while clearing prior player seats
      for (const [k, rec] of this.players) {
        if (!rec.spectator) this.players.delete(k);
      }

      this.map =
        typeof args.map === "string" && VALID_MAPS.has(args.map as MapId) ? (args.map as MapId) : "crossroads";
      this.config = { ...DEFAULT_CONFIG };
      if (typeof args.start_credits === "number" && VALID_CREDITS.has(args.start_credits)) {
        this.config.startCredits = args.start_credits;
      }
      if (typeof args.game_speed === "number" && VALID_SPEEDS.has(args.game_speed)) {
        this.config.gameSpeed = args.game_speed;
      }

      const nameA = String(args.agent_a || "Agent-A").slice(0, 16).trim() || "Agent-A";
      const nameB = String(args.agent_b || "Agent-B").slice(0, 16).trim() || "Agent-B";
      const tokenA = `mcp-${crypto.randomUUID().slice(0, 12)}`;
      const tokenB = `mcp-${crypto.randomUUID().slice(0, 12)}`;

      this.players.set(tokenA, {
        id: tokenA,
        connId: null,
        name: nameA,
        slot: 0,
        ready: true,
        spectator: false,
        connected: true,
        team: 0,
        mcp: true,
      });
      this.players.set(tokenB, {
        id: tokenB,
        connId: null,
        name: nameB,
        slot: 1,
        ready: true,
        spectator: false,
        connected: true,
        team: 0,
        mcp: true,
      });

      const shouldStart = args.start !== false;
      if (shouldStart) {
        this.startGame();
      } else {
        this.broadcastLobby();
      }

      return {
        ok: true,
        room: this.name,
        map: this.map,
        phase: this.phase,
        config: this.config,
        agent_a: { name: nameA, slot: 0, token: tokenA },
        agent_b: { name: nameB, slot: 1, token: tokenB },
        watch_url: `${origin}/?room=${encodeURIComponent(this.name)}&spectate=1`,
        dashboard_url: `${origin}/?watch=1`,
      };
    }

    if (op === "join_game") {
      if (this.resetTimer) {
        clearTimeout(this.resetTimer);
        this.resetTimer = null;
      }
      const clean = String(args.name || "MCP-Cmdr").slice(0, 16).trim() || "MCP-Cmdr";
      const reqTok =
        typeof args.token === "string" && args.token.length > 0 && args.token.length <= 64 ? args.token : undefined;
      let p = reqTok ? this.players.get(reqTok) : undefined;
      if (p && p.spectator) p = undefined;
      const requestedMap =
        typeof args.map === "string" && VALID_MAPS.has(args.map as MapId) ? (args.map as MapId) : null;
      if (requestedMap && this.phase !== "playing") {
        const limit = this.mapSlotLimit(requestedMap);
        const blocked = [...this.players.values()].find((x) => !x.spectator && x.slot >= limit);
        if (blocked) {
          return {
            ok: false,
            error: `${blocked.name} occupies slot ${blocked.slot + 1}; ${requestedMap} supports only ${limit} spawn slots`,
          };
        }
      }

      if (!p) {
        if (this.phase === "ended") {
          this.phase = "lobby";
          this.world = null;
          this.lastTickAt = 0;
          this.endSent = false;
          this.bots.clear();
          for (const [k, rec] of this.players) {
            if (rec.bot || !rec.connected) this.players.delete(k);
            else rec.ready = !!rec.mcp;
          }
        }
        if (this.phase === "playing") {
          return { ok: false, error: "match already in progress; spectate or join another room" };
        }
        const used = new Set([...this.players.values()].filter((x) => !x.spectator && x.slot >= 0).map((x) => x.slot));
        const limit = this.mapSlotLimit(requestedMap ?? this.map);
        let slot = -1;
        for (let s = 0; s < limit; s++) {
          if (!used.has(s)) {
            slot = s;
            break;
          }
        }
        if (slot < 0) return { ok: false, error: `room is full (${limit} players on this map)` };
        const token = reqTok || `mcp-${crypto.randomUUID().slice(0, 12)}`;
        p = {
          id: token,
          connId: null,
          name: clean,
          slot,
          ready: true,
          spectator: false,
          connected: true,
          team: 0,
          mcp: true,
        };
        this.players.set(token, p);
      } else {
        p.connected = true;
        if (typeof args.name === "string" && args.name.trim()) p.name = clean;
      }

      if (this.phase === "lobby") {
        if (requestedMap) {
          this.map = requestedMap;
        }
        const limit = this.mapSlotLimit();
        const botCount =
          args.add_bot === true
            ? 1
            : typeof args.add_bot === "number" && Number.isFinite(args.add_bot)
              ? Math.max(0, Math.min(limit - 1, Math.floor(args.add_bot)))
              : 0;
        const diff: BotDiff =
          typeof args.diff === "string" && VALID_DIFFS.has(args.diff as BotDiff) ? (args.diff as BotDiff) : "normal";
        const explicitProfile: BotProfile | null =
          typeof args.profile === "string" && VALID_PROFILES.has(args.profile as BotProfile)
            ? (args.profile as BotProfile)
            : null;
        const cycleProfiles: BotProfile[] = ["balanced", "rusher", "tech", "turtle"];
        for (let i = 0; i < botCount; i++) {
          this.addBot(diff, explicitProfile ?? cycleProfiles[i % cycleProfiles.length]);
        }
        if (args.start === true) {
          const actives = [...this.players.values()].filter((x) => x.connected && !x.spectator && x.slot >= 0);
          if (actives.length < 2) {
            return { ok: false, error: "need at least 2 players to start — pass add_bot: true" };
          }
          const invalid = actives.find((x) => x.slot >= limit);
          if (invalid) {
            return {
              ok: false,
              error: `${invalid.name} is in slot ${invalid.slot + 1}, outside this map's ${limit} spawn slots`,
            };
          }
          this.startGame();
        } else {
          this.broadcastLobby();
        }
      } else if (this.phase === "playing") {
        this.ensureLoop();
      }

      return {
        ok: true,
        room: this.name,
        token: p.id,
        slot: p.slot,
        phase: this.phase,
        map: this.map,
        watch_url: `${origin}/?room=${encodeURIComponent(this.name)}&spectate=1`,
        play_url: `${origin}/?room=${encodeURIComponent(this.name)}`,
        players: this.lobbyList(),
      };
    }

    const p = this.mcpPlayer(args.token);
    if (!p) return { ok: false, error: "invalid or missing player token — call join_game first" };

    if (op === "set_slot") {
      if (this.phase !== "lobby") return { ok: false, error: "spawn slots can only change in the lobby" };
      const slot = typeof args.slot === "number" ? args.slot : NaN;
      const limit = this.mapSlotLimit();
      if (!Number.isInteger(slot) || slot < 0 || slot >= limit) {
        return { ok: false, error: `invalid spawn slot for this map (0-${limit - 1})` };
      }
      let target = p;
      if (typeof args.id === "string" && args.id !== p.id) {
        if (!this.isHost(p)) return { ok: false, error: "only the host can move another player" };
        const other = this.players.get(args.id);
        if (!other || other.spectator || other.slot < 0) return { ok: false, error: "target player has no spawn slot" };
        target = other;
      }
      const occupant = this.playerAtSlot(slot, target.id);
      if (occupant) return { ok: false, error: `slot ${slot + 1} is occupied — use swap_slot` };
      if (target.slot !== slot) {
        this.pinHostBeforeSlotChange();
        target.slot = slot;
        this.broadcastLobby();
      }
      return { ok: true, room: this.name, player: { id: target.id, name: target.name, slot: target.slot }, players: this.lobbyList() };
    }

    if (op === "swap_slot") {
      if (this.phase !== "lobby") return { ok: false, error: "spawn slots can only change in the lobby" };
      const first = typeof args.id === "string" ? this.players.get(args.id) : undefined;
      if (!first || first.spectator || first.slot < 0) return { ok: false, error: "target player has no spawn slot" };
      let a = p;
      let b = first;
      if (typeof args.id2 === "string") {
        if (!this.isHost(p)) return { ok: false, error: "only the host can swap two other players" };
        const second = this.players.get(args.id2);
        if (!second || second.spectator || second.slot < 0) return { ok: false, error: "second target player has no spawn slot" };
        if (second.id === first.id) return { ok: false, error: "cannot swap a player with themselves" };
        a = first;
        b = second;
      } else {
        if (first.id === p.id) return { ok: false, error: "cannot swap slots with yourself" };
        if (!first.bot && !this.isHost(p)) return { ok: false, error: "only the host can swap with another human" };
      }
      const limit = this.mapSlotLimit();
      if (a.slot >= limit || b.slot >= limit) return { ok: false, error: "spawn slot is not valid for this map" };
      this.pinHostBeforeSlotChange();
      const slot = a.slot;
      a.slot = b.slot;
      b.slot = slot;
      this.broadcastLobby();
      return {
        ok: true,
        room: this.name,
        swapped: [
          { id: a.id, name: a.name, slot: a.slot },
          { id: b.id, name: b.name, slot: b.slot },
        ],
        players: this.lobbyList(),
      };
    }

    if (op === "get_game_state") {
      const watchUrl = `${origin}/?room=${encodeURIComponent(this.name)}&spectate=1`;
      if (!this.world || this.phase === "lobby") {
        return {
          ok: true,
          room: this.name,
          phase: this.phase,
          map: this.map,
          slot: p.slot,
          done: false,
          winner: null,
          watch_url: watchUrl,
          summary: `lobby | map=${this.map} | players=${this.players.size}`,
          players: this.lobbyList(),
          gym_obs: {
            tick: 0,
            you: {
              slot: p.slot,
              credits: 0,
              pwrHave: 0,
              pwrUse: 0,
              lowPower: false,
              eliminated: false,
              bq: null,
              awaiting: null,
              dq: null,
              awaitingDef: null,
              queues: {},
            },
            ents: [],
            ore: [],
          },
        };
      }
      if (this.phase === "playing" && (!this.alarmActive || Date.now() - this.lastTickAt > 2000)) {
        this.ensureLoop();
      }
      const w = this.world;
      const wp = w.players.get(p.slot);
      if (!wp) return { ok: false, error: "player slot not in active world" };

      const ownBuildings: Record<string, unknown>[] = [];
      const ownUnits: Record<string, unknown>[] = [];
      const neutralDerricks: Record<string, unknown>[] = [];
      const neutralCoalmines: Record<string, unknown>[] = [];
      const visionSources: { x: number; y: number; r: number }[] = [];
      const spawns = getSpawns(w.w, w.h);
      let baseX = spawns[p.slot]?.x ?? 8;
      let baseY = spawns[p.slot]?.y ?? 8;

      for (const e of w.ents.values()) {
        if (w.isAlly(p.slot, e.o)) {
          const r =
            e.k === "radar" || e.k === "superweapon" || e.k === "satlink"
              ? 17
              : !hasOwn(BUILDINGS, e.k) && UNITS[e.k as UnitKind].vision
                ? UNITS[e.k as UnitKind].vision!
                : 14;
          visionSources.push({ x: e.x, y: e.y, r });
        }
        if (e.o === p.slot) {
          if (hasOwn(BUILDINGS, e.k)) {
            if (e.k === "conyard") {
              baseX = e.x;
              baseY = e.y;
            }
            ownBuildings.push({
              id: e.id,
              kind: e.k,
              x: round1(e.x),
              y: round1(e.y),
              hp: Math.round(e.hp),
              mhp: e.mhp,
              ...(e.rally ? { rally: e.rally } : {}),
            });
          } else {
            ownUnits.push({
              id: e.id,
              kind: e.k,
              x: round1(e.x),
              y: round1(e.y),
              hp: Math.round(e.hp),
              mhp: e.mhp,
              ...(e.vet > 0 ? { vet: e.vet } : {}),
              ...(e.k === "harvester" ? { cargo: e.cargo } : {}),
              ...(e.hold ? { hold: true } : {}),
              ...(e.order ? { order: e.order.kind } : {}),
            });
          }
        } else if (e.o === -1 && e.k === "derrick") {
          neutralDerricks.push({ id: e.id, x: round1(e.x), y: round1(e.y), hp: Math.round(e.hp), mhp: e.mhp });
        } else if (e.o === -1 && e.k === "coalmine") {
          neutralCoalmines.push({ id: e.id, x: round1(e.x), y: round1(e.y), hp: Math.round(e.hp), mhp: e.mhp });
        }
      }

      const visibleEnemies: Record<string, unknown>[] = [];
      for (const e of w.ents.values()) {
        if (e.o < 0 || w.isAlly(p.slot, e.o)) continue;
        const stealthed = w.isStealthed(e);
        let visible = false;
        if (stealthed) {
          visible = w.isStealthDetected(e, p.slot);
        } else if (!this.config.fog) {
          visible = true;
        } else {
          for (const v of visionSources) {
            const dx = v.x - e.x;
            const dy = v.y - e.y;
            if (dx * dx + dy * dy <= v.r * v.r) {
              visible = true;
              break;
            }
          }
        }
        if (visible) {
          visibleEnemies.push({
            id: e.id,
            owner: e.o,
            kind: e.k,
            building: hasOwn(BUILDINGS, e.k),
            x: round1(e.x),
            y: round1(e.y),
            hp: Math.round(e.hp),
            mhp: e.mhp,
          });
        }
      }

      const oreSnap = w.oreSnapshot();
      let nearestOre: { x: number; y: number; amount: number; dist: number } | null = null;
      let bestDist2 = Infinity;
      for (const [ox, oy, amt] of oreSnap) {
        if (amt <= 0) continue;
        const d2 = (ox - baseX) * (ox - baseX) + (oy - baseY) * (oy - baseY);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          nearestOre = { x: ox, y: oy, amount: amt, dist: round1(Math.sqrt(d2)) };
        }
      }

      const enemySpawns = [...w.players.values()]
        .filter((other) => other.slot !== p.slot && !w.isAlly(p.slot, other.slot) && !other.eliminated)
        .map((other) => ({ slot: other.slot, x: spawns[other.slot]?.x ?? 0, y: spawns[other.slot]?.y ?? 0 }));

      const gymObs = extractGymObs(w, p.slot);
      const summary =
        `t=${w.tick} | $${Math.floor(wp.credits)} | pwr ${wp.pwrHave}/${wp.pwrUse}${wp.lowPower ? " LOW" : ""}` +
        ` | bld=${ownBuildings.length} units=${ownUnits.length} enemies_seen=${visibleEnemies.length}` +
        (wp.awaiting ? ` | awaiting=${wp.awaiting}` : "") +
        (wp.awaitingDef ? ` | awaitingDef=${wp.awaitingDef}` : "") +
        (w.winner !== null ? ` | winner=${w.winner}` : "");

      const state: Record<string, unknown> = {
        ok: true,
        room: this.name,
        phase: this.phase,
        map: this.map,
        tick: w.tick,
        slot: p.slot,
        done: w.winner !== null,
        winner: w.winner,
        watch_url: watchUrl,
        summary,
        gym_obs: gymObs,
        credits: Math.floor(wp.credits),
        power: { have: wp.pwrHave, use: wp.pwrUse, low: wp.lowPower },
        eliminated: wp.eliminated,
        awaiting: wp.awaiting,
        bq: wp.bq,
        awaitingDef: wp.awaitingDef,
        dq: wp.dq,
        queues: wp.queues,
        swLeft: wp.swLeft >= 0 ? wp.swLeft : null,
        reconLeft: wp.reconLeft >= 0 ? wp.reconLeft : null,
        own_buildings: ownBuildings,
        own_units: ownUnits,
        visible_enemies: visibleEnemies,
        neutral_derricks: neutralDerricks,
        neutral_coalmines: neutralCoalmines,
        crates: [...w.crates.values()].map((c) => ({ id: c.id, kind: c.kind, x: round1(c.x), y: round1(c.y) })),
        nearest_ore: nearestOre,
        ore_tiles: oreSnap.length,
        enemy_spawns: enemySpawns,
      };

      if (args.include_feature_maps === true) {
        const fm = extractGymFeatureMaps(w, p.slot);
        state.feature_maps = {
          shape: [fm.c, fm.h, fm.w],
          dtype: "float32",
          channels: [...FEATURE_MAP_CHANNELS],
          base64: bytesToBase64(new Uint8Array(fm.data.buffer, fm.data.byteOffset, fm.data.byteLength)),
        };
      }

      if (args.include_rgb_frame === true) {
        const rgb = extractGymRgbFrame(w, p.slot, 1);
        state.rgb_frame = {
          w: rgb.w,
          h: rgb.h,
          c: 3,
          dtype: "uint8",
          base64: bytesToBase64(rgb.data),
        };
      }

      return state;
    }

    if (this.phase !== "playing" || !this.world) {
      return { ok: false, error: `cannot run ${op} while room phase is ${this.phase}` };
    }
    if (!this.alarmActive || Date.now() - this.lastTickAt > 2000) this.ensureLoop();
    const w = this.world;

    if (op === "build_structure") {
      if (typeof args.kind !== "string" || !hasOwn(BUILDINGS, args.kind)) {
        return { ok: false, error: "invalid building kind" };
      }
      const err = w.cmdBuild(p.slot, args.kind as BuildingKind);
      if (err) return { ok: false, error: err };
      const wp = w.players.get(p.slot);
      return { ok: true, kind: args.kind, bq: wp?.bq ?? null, dq: wp?.dq ?? null };
    }

    if (op === "place_structure") {
      const wp = w.players.get(p.slot);
      const cat: BuildCategory | undefined =
        args.cat === "structure" || args.cat === "defense" ? args.cat : undefined;
      const kind =
        cat === "defense"
          ? wp?.awaitingDef[0]
          : cat === "structure"
            ? wp?.awaiting[0]
            : (wp?.awaiting[0] ?? wp?.awaitingDef[0]);
      if (!kind) return { ok: false, error: "nothing to place" };
      let tx: number;
      let ty: number;
      if (typeof args.tx === "number" && Number.isFinite(args.tx) && typeof args.ty === "number" && Number.isFinite(args.ty)) {
        tx = Math.floor(args.tx);
        ty = Math.floor(args.ty);
      } else {
        const spot = this.findPlacementSpot(p.slot, kind);
        if (!spot) return { ok: false, error: `no valid placement spot found for ${kind}` };
        tx = spot.tx;
        ty = spot.ty;
      }
      const err = w.cmdPlace(p.slot, tx, ty, cat);
      if (err) return { ok: false, error: err };
      return { ok: true, kind, tx, ty };
    }

    if (op === "train_unit") {
      if (typeof args.unit !== "string" || !hasOwn(UNITS, args.unit)) {
        return { ok: false, error: "invalid unit kind" };
      }
      const count =
        typeof args.count === "number" && Number.isFinite(args.count)
          ? Math.max(1, Math.min(5, Math.floor(args.count)))
          : 1;
      let queued = 0;
      let lastErr: string | null = null;
      for (let i = 0; i < count; i++) {
        const err = w.cmdTrain(p.slot, args.unit as UnitKind);
        if (err) {
          lastErr = err;
          break;
        }
        queued++;
      }
      if (queued === 0) return { ok: false, error: lastErr ?? "failed to train unit" };
      return { ok: true, unit: args.unit, queued, ...(lastErr ? { note: lastErr } : {}) };
    }

    if (op === "command_units") {
      const kind = args.kind;
      if (typeof kind !== "string" || !["move", "amove", "attack", "patrol", "harvest", "stop", "hold"].includes(kind)) {
        return { ok: false, error: "invalid order kind" };
      }
      let ids = validIds(args.ids);
      if (ids.length === 0 && typeof args.group === "string") {
        const grp = args.group;
        ids = [];
        for (const e of w.ents.values()) {
          if (e.o !== p.slot || hasOwn(BUILDINGS, e.k)) continue;
          const u = UNITS[e.k as UnitKind];
          if (
            (grp === "all_combat" && (u.dmg > 0 || Boolean(u.ewJamRadius))) ||
            (grp === "infantry" && (e.k === "infantry" || e.k === "rocket" || e.k === "engineer")) ||
            (grp === "tanks" &&
              (e.k === "tank" ||
                e.k === "himars" ||
                e.k === "railtank" ||
                e.k === "heavy" ||
                e.k === "arty" ||
                e.k === "spider")) ||
            (grp === "air" &&
              (u.domain === "air" ||
                e.k === "fpvdrone" ||
                e.k === "shahed" ||
                e.k === "ewdrone" ||
                e.k === "uav")) ||
            (grp === "sea" && (u.domain === "sea" || e.k === "usv")) ||
            (grp === "harvesters" && e.k === "harvester")
          ) {
            ids.push(e.id);
          }
        }
      }
      if (ids.length === 0) return { ok: false, error: "no matching units (specify ids or group)" };

      if (kind === "stop") {
        w.cmdStop(p.slot, ids);
        return { ok: true, kind, count: ids.length };
      }
      if (kind === "hold") {
        w.cmdHold(p.slot, ids);
        return { ok: true, kind, count: ids.length };
      }

      let x = typeof args.x === "number" && Number.isFinite(args.x) ? args.x : NaN;
      let y = typeof args.y === "number" && Number.isFinite(args.y) ? args.y : NaN;
      const target = typeof args.target === "number" && Number.isFinite(args.target) ? args.target : undefined;
      if ((!Number.isFinite(x) || !Number.isFinite(y)) && target != null) {
        const te = w.ents.get(target);
        if (te) {
          x = te.x;
          y = te.y;
        }
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: "x and y coordinates (or a valid target entity id) are required" };
      }
      const err = w.cmdOrder(p.slot, ids, kind as OrderKind, x, y, target);
      if (err) return { ok: false, error: err };
      return { ok: true, kind, count: ids.length, x: round1(x), y: round1(y), ...(target != null ? { target } : {}) };
    }

    if (op === "special_action") {
      const action = args.action;
      if (typeof action !== "string") return { ok: false, error: "missing action" };
      switch (action) {
        case "superweapon": {
          if (typeof args.x !== "number" || typeof args.y !== "number") return { ok: false, error: "x and y required" };
          const err = w.cmdSuperweapon(p.slot, args.x, args.y);
          return err ? { ok: false, error: err } : { ok: true, action, x: args.x, y: args.y };
        }
        case "recon": {
          if (typeof args.x !== "number" || typeof args.y !== "number") return { ok: false, error: "x and y required" };
          const err = w.cmdRecon(p.slot, args.x, args.y);
          return err ? { ok: false, error: err } : { ok: true, action, x: args.x, y: args.y };
        }
        case "upgrade": {
          let id = typeof args.id === "number" && Number.isFinite(args.id) ? args.id : -1;
          if (id < 0) {
            for (const e of w.ents.values()) {
              if (e.o === p.slot && e.k === "factory") {
                id = e.id;
                break;
              }
            }
          }
          if (id < 0) {
            for (const e of w.ents.values()) {
              if (e.o === p.slot && hasOwn(UPGRADE_PATHS, e.k)) {
                id = e.id;
                break;
              }
            }
          }
          if (id < 0) return { ok: false, error: "no upgradeable building found" };
          const err = w.cmdUpgrade(p.slot, id);
          return err ? { ok: false, error: err } : { ok: true, action, id };
        }
        case "sell": {
          if (typeof args.id !== "number" || !Number.isFinite(args.id)) return { ok: false, error: "building id required" };
          const err = w.cmdSell(p.slot, args.id);
          return err ? { ok: false, error: err } : { ok: true, action, id: args.id };
        }
        case "repair": {
          if (typeof args.id !== "number" || !Number.isFinite(args.id)) return { ok: false, error: "building id required" };
          const err = w.cmdRepair(p.slot, args.id);
          return err ? { ok: false, error: err } : { ok: true, action, id: args.id };
        }
        case "rally": {
          if (
            typeof args.id !== "number" ||
            !Number.isFinite(args.id) ||
            typeof args.x !== "number" ||
            typeof args.y !== "number"
          ) {
            return { ok: false, error: "building id, x, and y required" };
          }
          const err = w.cmdRally(p.slot, args.id, args.x, args.y);
          return err ? { ok: false, error: err } : { ok: true, action, id: args.id, x: args.x, y: args.y };
        }
        case "chat": {
          const text = String(args.text || "").slice(0, 120).replace(/[<>&]/g, "").trim();
          if (!text) return { ok: false, error: "chat text required" };
          const color = p.slot >= 0 ? PLAYER_COLORS[p.slot] : "#8a97a5";
          this.broadcast(JSON.stringify({ t: "chat", name: p.name, color, text } satisfies S2C));
          return { ok: true, action, text };
        }
        case "resign": {
          w.cmdResign(p.slot);
          return { ok: true, action };
        }
        default:
          return { ok: false, error: `unknown action: ${action}` };
      }
    }

    return { ok: false, error: `unknown mcp op: ${op}` };
  }

  async onRequest(req: Request): Promise<Response> {
    if (this.name === "__directory") {
      if (req.method === "POST") {
        let body: { op?: string; summary?: RoomSummary; room?: string };
        try {
          body = (await req.json()) as { op?: string; summary?: RoomSummary; room?: string };
        } catch {
          return Response.json({ ok: false, error: "bad json" }, { status: 400 });
        }
        const now = Date.now();
        if (body.op === "delete" && typeof body.room === "string") {
          this.dir.delete(body.room);
        } else if (body.op === "upsert" && body.summary && typeof body.summary.room === "string") {
          const s = body.summary;
          if (s.players <= 0) {
            this.dir.delete(s.room);
          } else {
            const prev = this.dir.get(s.room);
            const updatedAt = prev && prev.phase === "ended" && s.phase === "ended" ? prev.updatedAt : now;
            this.dir.set(s.room, { ...s, updatedAt });
          }
        }
        this.pruneDir(now);
        return Response.json({ ok: true });
      }
      this.pruneDir();
      const rooms = [...this.dir.values()].sort(
        (a, b) => (b.phase === "playing" ? 1 : 0) - (a.phase === "playing" ? 1 : 0) || b.players - a.players,
      );
      return Response.json({ rooms });
    }

    if (new URL(req.url).pathname === "/clerr") {
      if (req.method === "GET") return Response.json({ errors: this.clientErrors });
      if (req.method !== "POST") return new Response(null, { status: 405 });
      let body: Record<string, unknown> = {};
      try {
        const parsed = await req.json();
        if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
      } catch {
        return Response.json({ ok: false, error: "bad json" }, { status: 400 });
      }
      const clip = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
      const msg = clip(body.msg, 500);
      const kind = clip(body.kind, 24);
      if (!msg || !kind) return Response.json({ ok: false, error: "msg/kind required" }, { status: 400 });
      // coalesce repeats of the same message from the same player (spam guard)
      const nm = clip(body.name, 40);
      let dup: (typeof this.clientErrors)[number] | undefined;
      for (let i = this.clientErrors.length - 1; i >= 0; i--) {
        const e = this.clientErrors[i];
        if (e.msg === msg && e.name === nm) {
          dup = e;
          break;
        }
      }
      if (dup && Date.now() - dup.ts < 60_000) {
        dup.n = (dup.n ?? 1) + 1;
        dup.ts = Date.now();
        return Response.json({ ok: true });
      }
      this.clientErrors.push({
        ts: Date.now(),
        name: clip(body.name, 40) ?? "?",
        kind,
        msg,
        stack: clip(body.stack, 800),
        phase: clip(body.phase, 12),
        slot: typeof body.slot === "number" ? body.slot : undefined,
        ua: clip(body.ua, 140),
      });
      if (this.clientErrors.length > 100) this.clientErrors.splice(0, this.clientErrors.length - 100);
      return Response.json({ ok: true });
    }

    const mcpOp = req.headers.get("x-mcp-op");
    if (req.method === "POST" && mcpOp) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = await req.json();
        if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
      } catch {
        return Response.json({ ok: false, error: "invalid json body" }, { status: 400 });
      }
      try {
        const res = this.handleMcpAction(mcpOp, args);
        return Response.json(res);
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    return Response.json({
      phase: this.phase,
      players: this.players.size,
      tick: this.world?.tick ?? 0,
      ents: this.world?.ents.size ?? 0,
      lastTickAgeMs: this.lastTickAt ? Date.now() - this.lastTickAt : null,
      hasTimer: this.alarmActive,
    });
  }
}

async function handleMcpRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "DELETE") {
    return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: MCP_CORS_HEADERS });
  }

  let body: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: MCP_CORS_HEADERS },
    );
  }
  if (!body || typeof body !== "object" || typeof body.method !== "string") {
    return Response.json(
      { jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Invalid Request" } },
      { status: 400, headers: MCP_CORS_HEADERS },
    );
  }

  const { id, method, params } = body;
  // JSON-RPC notifications (no id, or notifications/*) receive 202 Accepted
  if (method === "notifications/initialized" || method.startsWith("notifications/") || id === undefined) {
    return new Response(null, { status: 202, headers: MCP_CORS_HEADERS });
  }

  const ok = (result: unknown) =>
    Response.json({ jsonrpc: "2.0", id, result }, { headers: MCP_CORS_HEADERS });
  const fail = (code: number, message: string) =>
    Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { headers: MCP_CORS_HEADERS });

  if (method === "initialize") {
    return ok({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "open-alert", version: "1.0.0" },
    });
  }
  if (method === "ping") {
    return ok({});
  }
  if (method === "tools/list") {
    return ok({ tools: MCP_TOOLS });
  }
  if (method === "tools/call") {
    const toolName = typeof params?.name === "string" ? params.name : "";
    const toolArgs =
      params?.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};

    const toolRes = (data: unknown, isError = false) =>
      ok({
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        ...(isError ? { isError: true } : {}),
      });

    if (toolName === "list_live_games") {
      const stub = env.GameRoom.getByName("__directory");
      const res = await stub.fetch(new Request("https://internal/dir"));
      const data = await res.json();
      return toolRes(data);
    }

    if (toolName === "get_gym_schema") {
      return toolRes(buildGymSchemaResponse());
    }

    const roomTools = new Set([
      "join_game",
      "create_ai_arena",
      "set_slot",
      "swap_slot",
      "get_game_state",
      "build_structure",
      "place_structure",
      "train_unit",
      "command_units",
      "special_action",
    ]);
    if (!roomTools.has(toolName)) {
      return fail(-32602, `Unknown tool: ${toolName}`);
    }

    let room = typeof toolArgs.room === "string" ? toolArgs.room.trim().toLowerCase() : "";
    if (!room && (toolName === "join_game" || toolName === "create_ai_arena")) {
      const prefix = toolName === "create_ai_arena" ? "arena" : "mcp";
      room = `${prefix}-${crypto.randomUUID().slice(0, 6)}`;
    }
    if (!/^[a-z0-9-]{2,32}$/.test(room) || room === "__directory") {
      return toolRes({ ok: false, error: "room must be 2-32 lowercase alphanumeric/hyphen characters" }, true);
    }

    const stub = env.GameRoom.getByName(room);
    const res = await stub.fetch(
      new Request("https://internal/mcp-action", {
        method: "POST",
        headers: { "content-type": "application/json", "x-mcp-op": toolName },
        body: JSON.stringify({ ...toolArgs, room, origin: url.origin }),
      }),
    );
    const data = (await res.json()) as { ok?: boolean };
    return toolRes(data, data.ok === false);
  }

  return fail(-32601, `Method not found: ${method}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
    }

    if (url.pathname === "/api/rooms" && request.method === "GET") {
      try {
        const stub = env.GameRoom.getByName("__directory");
        const res = await stub.fetch(new Request("https://internal/dir"));
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          if (isQuotaError(txt)) {
            return Response.json(
              { rooms: [], quotaExceeded: true },
              { status: 200, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
            );
          }
          return Response.json(
            { rooms: [] },
            { status: 200, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
          );
        }
        const data = await res.json();
        return Response.json(data, {
          headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
        });
      } catch (err) {
        if (isQuotaError(err)) {
          return Response.json(
            { rooms: [], quotaExceeded: true },
            { status: 200, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
          );
        }
        return Response.json(
          { rooms: [] },
          { status: 200, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
        );
      }
    }

    if (url.pathname === "/client-error") {
      // Browser-error telemetry relay. POST: browser reports (room in body) —
      // forwarded into the room DO's ring buffer. GET ?room=X: read the ring.
      // Plain HTTP on purpose: the dead-websocket case is the one worth logging.
      if (request.method === "POST") {
        try {
          const body = (await request.json()) as { room?: string };
          const room = typeof body?.room === "string" && /^[a-z0-9-]{2,32}$/i.test(body.room) ? body.room : null;
          if (!room) return Response.json({ ok: false, error: "room required" }, { status: 400 });
          const stub = env.GameRoom.getByName(room);
          const res = await stub.fetch(
            new Request("https://internal/clerr", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          );
          return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
        } catch {
          return Response.json({ ok: false }, { status: 400 });
        }
      }
      if (request.method === "GET") {
        const room = url.searchParams.get("room") ?? "";
        if (!/^[a-z0-9-]{2,32}$/i.test(room)) return Response.json({ ok: false, error: "room required" }, { status: 400 });
        const stub = env.GameRoom.getByName(room);
        const res = await stub.fetch(new Request("https://internal/clerr"));
        return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      return new Response(null, { status: 405 });
    }

    try {
      if (url.pathname === "/mcp") {
        return await handleMcpRequest(request, env, url);
      }
      const partyRes = await routePartykitRequest(request, env);
      if (partyRes) return partyRes;
    } catch (err) {
      if (isQuotaError(err)) {
        return Response.json(
          {
            error: "quota_exceeded",
            message:
              "Cloudflare free-tier daily Durable Objects quota reached (resets at 00:00 UTC). Use Local Solo mode to play offline!",
          },
          { status: 503, headers: url.pathname === "/mcp" ? MCP_CORS_HEADERS : undefined },
        );
      }
      throw err;
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
