import { routePartykitRequest, Server } from "partyserver";
import type { Connection } from "partyserver";
import { World } from "./server/world";
import { AIBot } from "./server/bot";
import {
  extractGymObs,
  extractGymFeatureMaps,
  extractGymRgbFrame,
  getGymActionSchema,
  bytesToBase64,
} from "./server/gym";
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
  ore: ArrayBuffer; // Int16Array buffer — changes slowly (mining), written rarely
}

interface PersistedCore {
  phase: "playing";
  map: MapId;
  config: GameConfig;
  players: PlayerRec[];
  world: Omit<ReturnType<World["serialize"]>, "ore">;
}

const PERSIST_LIVE_MS = 3000; // checkpoint every ~3s while simulating
const PERSIST_PAUSED_MS = 60_000; // slower heartbeat while solo-paused
const PERSIST_ORE_MS = 30_000; // ore field drifts slowly; 30s is plenty
const MATCH_STALE_MS = 10 * 60 * 1000; // older than 10min = abandoned, drop it

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
const ORDER_KINDS = new Set(["move", "amove", "attack", "harvest", "patrol"]);
const VALID_MAPS = new Set<MapId>(MAP_LIST.map((m) => m.id));
const VALID_DIFFS = new Set<BotDiff>(["easy", "normal", "brutal"]);
const VALID_PROFILES = new Set<BotProfile>(["balanced", "rusher", "turtle", "tech"]);
const VALID_CREDITS = new Set([3000, 5000, 10000, 20000]);
const VALID_SPEEDS = new Set([0.75, 1, 1.5, 2]);
const validIds = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => Number.isFinite(n)) : [];
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

const ACTIVE_UNITS = (Object.keys(UNITS) as UnitKind[]).filter((k) => !UNITS[k].retired);

const MCP_TOOLS = [
  {
    name: "list_live_games",
    description: "List active and lobby Open Alert multiplayer rooms currently live on the server.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "join_game",
    description:
      "Create or join an Open Alert room as a player commander. Optionally pick map, add AI bot(s), and start the match immediately. Returns token, slot, watch_url (spectator link), and play_url.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room slug (2-32 alphanumeric/hyphen chars). Auto-generated if omitted." },
        name: { type: "string", description: "Commander callsign (max 16 chars)." },
        map: { type: "string", enum: MAP_LIST.map((m) => m.id), description: "Map id (lobby only)." },
        add_bot: {
          oneOf: [{ type: "boolean" }, { type: "integer", minimum: 1, maximum: MAX_PLAYERS - 1 }],
          description: `Add 1 (true) or up to ${MAX_PLAYERS - 1} AI bot opponents in lobby.`,
        },
        diff: { type: "string", enum: ["easy", "normal", "brutal"], description: "Bot difficulty." },
        profile: { type: "string", enum: ["balanced", "rusher", "turtle", "tech"], description: "Bot strategy profile." },
        start: { type: "boolean", description: "Start the match immediately if >= 2 players are in the room." },
        token: { type: "string", description: "Optional existing player token to reconnect." },
      },
    },
  },
  {
    name: "get_game_state",
    description:
      "Get full RL Gym parity state (`gym_obs`) plus concise tactical summary for your commander: tick, done, winner, watch_url, credits, power, awaiting placement, production queues, own buildings & units, visible enemies, neutral oil derricks, supply crates, and nearest ore. Optionally include 6x64x64 float32 `feature_maps` and/or 64x64x3 uint8 `rgb_frame`.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room slug." },
        token: { type: "string", description: "Your commander token returned by join_game or create_ai_arena." },
        include_feature_maps: {
          type: "boolean",
          description: "If true, include base64-encoded 6x64x64 float32 feature planes (ore, own_units, own_buildings, foe_units, foe_buildings, all_hp).",
        },
        include_rgb_frame: {
          type: "boolean",
          description: "If true, include base64-encoded 64x64x3 uint8 RGB minimap frame.",
        },
      },
      required: ["room", "token"],
    },
  },
  {
    name: "build_structure",
    description:
      "Start constructing a structure (power, coalplant, fusion, refinery, supplyhub, barracks, radar, factory, airfield, shipyard, depot, techlab, purifier, satlink, superweapon [Nuclear Silo]) or defense (turret, sam, arc, irondome, lasertower, thaad [anti-nuke & anti-hypersonic missile shield]) in your Construction Yard parallel queues (structures & defenses build simultaneously).",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        token: { type: "string" },
        kind: {
          type: "string",
          enum: Object.keys(BUILDINGS).filter((k) => !BUILDINGS[k as BuildingKind].noBuild && k !== "conyard"),
        },
      },
      required: ["room", "token", "kind"],
    },
  },
  {
    name: "place_structure",
    description:
      "Place the finished structure or defense currently in `awaiting` / `awaitingDef`. Optional `cat` ('structure' | 'defense') selects which queue; if tx/ty are omitted, automatically scans for a legal valid placement tile near your base.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        token: { type: "string" },
        tx: { type: "integer", minimum: 0, maximum: 127 },
        ty: { type: "integer", minimum: 0, maximum: 127 },
        cat: { type: "string", enum: ["structure", "defense"] },
      },
      required: ["room", "token"],
    },
  },
  {
    name: "train_unit",
    description: `Queue 1 to 5 active modern units for training at your barracks, war factory, airfield, or naval shipyard. Active units: ${ACTIVE_UNITS.join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        token: { type: "string" },
        unit: {
          type: "string",
          enum: ACTIVE_UNITS,
          description: `Active non-retired unit kind: ${ACTIVE_UNITS.join(", ")}.`,
        },
        count: { type: "integer", minimum: 1, maximum: 5, default: 1 },
      },
      required: ["room", "token", "unit"],
    },
  },
  {
    name: "command_units",
    description:
      "Issue tactical orders (move, amove, attack, patrol, harvest, stop, hold) to specific unit IDs or a named unit group (all_combat, infantry, tanks [tank/himars/railtank], air [fpvdrone/shahed/ewdrone/uav/interceptor/chopper/a10/ac130/stealthbomber/hypersonic], sea [usv/gunboat/destroyer/sub/dreadnought/carrier], harvesters).",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        token: { type: "string" },
        kind: { type: "string", enum: ["move", "amove", "attack", "patrol", "harvest", "stop", "hold"] },
        x: { type: "number", minimum: 0, maximum: 128 },
        y: { type: "number", minimum: 0, maximum: 128 },
        target: { type: "integer", description: "Optional target entity ID for attack orders." },
        ids: { type: "array", items: { type: "integer" }, description: "Specific unit entity IDs." },
        group: {
          type: "string",
          enum: ["all_combat", "infantry", "tanks", "air", "sea", "harvesters"],
          description:
            "Select all your units matching this group if ids omitted (air includes fpvdrone/shahed/ewdrone/uav, sea includes usv, tanks includes himars/railtank).",
        },
      },
      required: ["room", "token", "kind"],
    },
  },
  {
    name: "special_action",
    description:
      "Trigger special commander actions: superweapon (Nuclear Silo strike at x,y — interceptable by enemy THAAD Defense), recon (Radar Scan at x,y), upgrade (War Factory/Barracks/Air Command/Shipyard -> II), sell, repair, rally, chat, or resign.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        token: { type: "string" },
        action: {
          type: "string",
          enum: ["superweapon", "recon", "upgrade", "sell", "repair", "rally", "chat", "resign"],
        },
        x: { type: "number" },
        y: { type: "number" },
        id: { type: "integer", description: "Target building entity ID (for upgrade/sell/repair/rally)." },
        text: { type: "string", description: "Chat message text (for action=chat)." },
      },
      required: ["room", "token", "action"],
    },
  },
  {
    name: "create_ai_arena",
    description:
      "Create a live AI-vs-AI arena match with two external MCP agent seats (agent_a in slot 0, agent_b in slot 1). Registers live on the Spectator Dashboard (/?watch=1) so humans can watch models compete in 3D, and returns both tokens plus watch_url and dashboard_url.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room slug (2-32 lowercase alphanumeric/hyphen chars). Auto-generated if omitted." },
        map: { type: "string", enum: MAP_LIST.map((m) => m.id), description: "Map id (default 'crossroads')." },
        agent_a: { type: "string", description: "Callsign for slot 0 agent (max 16 chars, default 'Agent-A')." },
        agent_b: { type: "string", description: "Callsign for slot 1 agent (max 16 chars, default 'Agent-B')." },
        start: { type: "boolean", description: "Start the match immediately (default true)." },
        start_credits: { type: "integer", enum: [3000, 5000, 10000, 20000], description: "Starting credits per agent (default 5000)." },
        game_speed: { type: "number", enum: [0.75, 1, 1.5, 2], description: "Simulation speed multiplier (default 1)." },
      },
    },
  },
  {
    name: "get_gym_schema",
    description:
      "Return the exact RL Gym observation contract (gym_obs), float32 feature_maps contract ([6,map_h,map_w] — plane dims follow the room's live map), uint8 rgb_frame contract ([map_w,map_h,3]), and rts_action JSON schema shared 1:1 between src/server/gym.ts and live MCP matches for training & finetuning models.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

const FEATURE_MAP_CHANNELS = ["ore", "own_units", "own_buildings", "foe_units", "foe_buildings", "all_hp"] as const;

function buildGymSchemaResponse() {
  return {
    gym_obs_contract: {
      description:
        "Exact structured RL Gym observation contract shared 1:1 between src/server/gym.ts (GymEnv / extractGymObs) and MCP get_game_state.gym_obs.",
      fields: {
        tick: "integer — authoritative simulation tick (10 ticks = 1s at 1x speed)",
        you: {
          slot: "integer — your player slot index (0..7)",
          credits: "integer — current floored credits",
          pwrHave: "integer — total power generated",
          pwrUse: "integer — total power consumed",
          lowPower: "boolean — true when pwrUse > pwrHave (halves production & disables defenses)",
          eliminated: "boolean — true if your faction has been eliminated",
          bq: "{ kind: BuildingKind, left: number, total: number }[] — structure build queue (head builds, rest queued)",
          awaiting: "BuildingKind[] — finished structures stacked for placement",
          dq: "{ kind: BuildingKind, left: number, total: number }[] — parallel defense build queue",
          awaitingDef: "BuildingKind[] — finished defenses stacked for placement",
          queues: "Partial<Record<'barracks'|'factory'|'airfield'|'shipyard', { unit: UnitKind, left: number, total: number, count: number }>>",
        },
        ents: "Array<{ id: number, o: number, k: EntKind, x: number, y: number, hp: number, mhp: number, cargo?: number }>",
        ore: "Array<[x: number, y: number, amount: number]>",
      },
    },
    feature_maps_contract: {
      shape: "[6, map_h, map_w] — plane dims follow the room's live map (96x96 standard, up to 128x128); each call's feature_maps.shape reports the exact size",
      dtype: "float32",
      channels: [...FEATURE_MAP_CHANNELS],
      encoding: "base64 (little-endian IEEE-754 Float32Array, C-contiguous [channel, y, x])",
    },
    rgb_frame_contract: {
      w: "map_w — live map width",
      h: "map_h — live map height",
      c: 3,
      dtype: "uint8",
      encoding: "base64 (row-major RGB Uint8Array of w*h*3 bytes)",
    },
    action_schema: getGymActionSchema(),
  };
}

export class GameRoom extends Server<Env> {
  phase: "lobby" | "playing" | "ended" = "lobby";
  map: MapId = "crossroads";
  config: GameConfig = { ...DEFAULT_CONFIG };
  players = new Map<string, PlayerRec>(); // by player id (client token)
  connPlayer = new Map<string, string>(); // conn id -> player id
  world: World | null = null;
  alarmActive = false;
  paused = false; // solo-vs-bots freeze: alarm keeps rescheduling, sim skips stepping
  resetTimer: ReturnType<typeof setTimeout> | null = null;
  lastTickAt = 0;
  lastPersistAt = 0;
  lastOrePersistAt = 0;
  endSent = false;
  bots = new Map<string, AIBot>(); // player id -> AI brain, ticked once per game tick
  private dir = new Map<string, RoomSummary>(); // used only when this.name === "__directory"

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
          ore: oreRec?.ore ? new Int16Array(oreRec.ore) : undefined,
        };
        this.world = World.deserialize(world);
        this.phase = "playing";
        this.map = rec.map;
        this.config = rec.config;
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
      world: worldCore,
    };
    const writeOre = !!ore && now - this.lastOrePersistAt >= PERSIST_ORE_MS;
    if (writeOre) this.lastOrePersistAt = now;
    void (async () => {
      try {
        const gz = await new Response(
          new Blob([JSON.stringify(core)]).stream().pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer();
        const puts: Promise<unknown>[] = [
          this.ctx.storage.put("match", { savedAt: now, gz } satisfies PersistedMatch),
        ];
        if (writeOre && ore) {
          puts.push(this.ctx.storage.put("matchOre", { at: now, ore: ore.slice().buffer } satisfies PersistedOre));
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
      case "hb":
        if (this.resetTimer) {
          clearTimeout(this.resetTimer);
          this.resetTimer = null;
        }
        if (this.phase === "playing" && this.world && (!this.alarmActive || Date.now() - this.lastTickAt > 2000)) {
          this.ensureLoop();
        }
        return;
      case "join":
        return this.handleJoin(conn, m.name, m.token, m.spectate);
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
          if (!this.addBot(diff, profile)) {
            send(conn, { t: "deny", msg: `room is full (${MAX_PLAYERS} players)` });
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
          for (const p of this.players.values()) {
            p.ready = !!p.bot || !!p.mcp;
            if (p.spectator && !p.wantSpectate) {
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
      case "hold":
        this.world.cmdHold(slot, validIds(m.ids));
        break;
      case "drive":
        if (
          Number.isFinite(m.id) &&
          Number.isFinite(m.fwd) &&
          Number.isFinite(m.strafe) &&
          Number.isFinite(m.yaw)
        ) {
          this.world.cmdDrive(
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
        break;
      case "driveExit":
        if (Number.isFinite(m.id)) this.world.cmdDriveExit(slot, m.id);
        break;
      case "recon":
        err = Number.isFinite(m.x) && Number.isFinite(m.y) ? this.world.cmdRecon(slot, m.x, m.y) : "bad coords";
        break;
      case "build":
        err = typeof m.kind === "string" ? this.world.cmdBuild(slot, m.kind) : "bad kind";
        break;
      case "buildCancel": {
        const cat: BuildCategory | undefined = m.cat === "structure" || m.cat === "defense" ? m.cat : undefined;
        this.world.cmdBuildCancel(
          slot,
          cat,
          Number.isFinite(m.index) ? m.index : 0,
          m.awaiting === true,
          typeof m.kind === "string" ? (m.kind as BuildingKind) : undefined,
        );
        break;
      }
      case "place": {
        const cat: BuildCategory | undefined = m.cat === "structure" || m.cat === "defense" ? m.cat : undefined;
        const kind = typeof m.kind === "string" ? (m.kind as BuildingKind) : undefined;
        err =
          Number.isFinite(m.tx) && Number.isFinite(m.ty)
            ? this.world.cmdPlace(slot, Math.floor(m.tx), Math.floor(m.ty), cat, kind)
            : "bad coords";
        break;
      }
      case "bridge": {
        err =
          Number.isFinite(m.id) && Number.isFinite(m.tx) && Number.isFinite(m.ty)
            ? this.world.cmdBridge(slot, Math.floor(m.id), Math.floor(m.tx), Math.floor(m.ty))
            : "bad bridge order";
        break;
      }
      case "train":
        err = typeof m.unit === "string" ? this.world.cmdTrain(slot, m.unit) : "bad unit";
        break;
      case "trainCancel":
        this.world.cmdTrainCancel(
          slot,
          typeof m.unit === "string" ? m.unit : undefined,
          m.cat === "barracks" || m.cat === "factory" || m.cat === "airfield" || m.cat === "shipyard" ? m.cat : undefined,
          Number.isFinite(m.index) ? m.index : undefined,
        );
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
      case "pause": {
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
        return;
      }
    }
    if (err) send(conn, { t: "deny", msg: err });
  }

  private handleJoin(conn: Connection, name: string, token?: string, spectate?: boolean) {
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
    let slot = -1;
    for (let s = 0; s < MAX_PLAYERS; s++)
      if (!used.has(s)) {
        slot = s;
        break;
      }
    if (slot < 0) {
      send(conn, { t: "deny", msg: `room is full (${MAX_PLAYERS} players)` });
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
  }

  private addBot(diff: BotDiff = "normal", profile: BotProfile = "balanced"): boolean {
    const used = new Set([...this.players.values()].filter((p) => p.slot >= 0).map((p) => p.slot));
    let slot = -1;
    for (let s = 0; s < MAX_PLAYERS; s++)
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
    if (!slots.length) return;
    const teams: Record<number, number> = {};
    const names: Record<number, string> = {};
    for (const p of actives) {
      teams[p.slot] = p.team;
      names[p.slot] = p.name;
    }
    this.world = new World(slots, { map: this.map, teams, names, config: this.config });
    this.phase = "playing";
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
      void this.ctx.storage.setAlarm(Date.now() + 50).catch(() => {});
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
      await this.ctx.storage.setAlarm(Date.now() + this.stepIntervalMs()).catch(() => {});
    } else {
      this.alarmActive = false;
      await this.ctx.storage.deleteAlarm().catch(() => {});
    }
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
        const snap = w.snapshot();
        this.broadcast(JSON.stringify({ t: "snap", tick: w.tick, ...snap } satisfies S2C));
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
            winner: w.winner,
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
    for (const e of w.ents.values()) {
      if (e.o === slot && hasOwn(BUILDINGS, e.k)) {
        ownBuildings.push({ x: Math.floor(e.x), y: Math.floor(e.y) });
        if (e.k === "conyard") {
          anchorX = Math.floor(e.x);
          anchorY = Math.floor(e.y);
        }
      }
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
        let slot = -1;
        for (let s = 0; s < MAX_PLAYERS; s++) {
          if (!used.has(s)) {
            slot = s;
            break;
          }
        }
        if (slot < 0) return { ok: false, error: `room is full (${MAX_PLAYERS} players)` };
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
        if (typeof args.map === "string" && VALID_MAPS.has(args.map as MapId)) {
          this.map = args.map as MapId;
        }
        const botCount =
          args.add_bot === true
            ? 1
            : typeof args.add_bot === "number" && Number.isFinite(args.add_bot)
              ? Math.max(0, Math.min(MAX_PLAYERS - 1, Math.floor(args.add_bot)))
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
