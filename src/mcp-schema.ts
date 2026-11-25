// MCP tool schemas + the RL Gym contract response, extracted from worker.ts
// (pure move) so the Durable Object room logic stays focused on the game loop.

import { MAP_LIST, MAX_PLAYERS, BUILDINGS, UNITS } from "./shared/gamedefs";
import type { BuildingKind, UnitKind } from "./shared/gamedefs";
import { getGymActionSchema } from "./server/gym";

export const ACTIVE_UNITS = (Object.keys(UNITS) as UnitKind[]).filter((k) => !UNITS[k].retired);

export const MCP_TOOLS = [
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
    name: "set_slot",
    description:
      "Lobby only: move yourself to an EMPTY spawn/color slot (0-based). Slots determine both player color and home-base spawn position. Hosts may pass another player token/id in `id` to move that player.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room slug." },
        token: { type: "string", description: "Your commander token returned by join_game." },
        slot: { type: "integer", minimum: 0, maximum: MAX_PLAYERS - 1, description: "Empty destination slot index (0-based)." },
        id: { type: "string", description: "Optional target player id/token (host only)." },
      },
      required: ["room", "token", "slot"],
    },
  },
  {
    name: "swap_slot",
    description:
      "Lobby only: swap your spawn/color slot with another player. Anyone may swap with an AI bot; swaps with another human are host-only. Hosts may pass id2 to atomically swap any two players.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room slug." },
        token: { type: "string", description: "Your commander token returned by join_game." },
        id: { type: "string", description: "Target player id/token." },
        id2: { type: "string", description: "Optional second player id/token (host only): swap id↔id2 instead of yourself↔id." },
      },
      required: ["room", "token", "id"],
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

export const FEATURE_MAP_CHANNELS = ["ore", "own_units", "own_buildings", "foe_units", "foe_buildings", "all_hp"] as const;

export function buildGymSchemaResponse() {
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
