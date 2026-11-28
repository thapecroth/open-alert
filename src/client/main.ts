import { Net } from "./net";
import { installTelemetry } from "./telemetry";
import { GameScene } from "./scene";
import { Renderer } from "./render";
import { Input } from "./input";
import { Hud, type GraphicsBridge } from "./hud";
import { AudioEngine } from "./audio";
import type { FirstPersonController } from "./fpv";
import { FpvStory } from "./story";
import { generateIcons } from "./icons";
import { whenModelTexturesReady } from "./textures";
import { isBuildingKind, el } from "./util";
import * as THREE from "three";
import {
  MAP_W,
  MAP_H,
  BUILDINGS,
  BUILDING_NAMES,
  PLAYER_COLORS,
  getSpawns,
  BUILD_ORDER,
  DEFENSE_ORDER,
  TRAIN_ORDER,
  DEFAULT_CONFIG,
  SHIPYARD_BUILD_DIST,
  buildCategoryOf,
  UNITS,
  BuildingKind,
  EntKind,
  UnitKind,
  MapId,
  GameConfig,
} from "../shared/gamedefs";
import type { S2C, PlayerState, WeaponFx } from "../shared/protocol";

// ---------- identity & room ----------

const params = new URLSearchParams(location.search);
const spectateParam = params.get("spectate") === "1";
const watchParam = params.get("watch") === "1";
let room = params.get("room") ?? "";
if (!/^[a-z0-9-]{2,32}$/i.test(room)) {
  room = Math.random().toString(36).slice(2, 8);
}
history.replaceState(null, "", spectateParam ? `?room=${room}&spectate=1` : `?room=${room}`);

let token = localStorage.getItem("oa-token");
if (!token) {
  token = crypto.randomUUID();
  localStorage.setItem("oa-token", token);
}
// Use an ephemeral token when joining as a spectator so opening a spectator tab never steals our player slot
const joinToken = spectateParam ? crypto.randomUUID() : token;
let name =
  params.get("name") ??
  localStorage.getItem("oa-name") ??
  "Cmdr-" + Math.random().toString(36).slice(2, 6);
localStorage.setItem("oa-name", name);

// ---------- boot ----------

const canvas = el<HTMLCanvasElement>("game");
const gs = new GameScene(canvas);
const renderer = new Renderer(gs);
const hud = new Hud();
const audio = new AudioEngine();
const net = new Net(room);
net.setIdentity(name, joinToken);

// Half-open-connection watchdog: in a quiet lobby the ONLY periodic server
// traffic is the hbok reply to our 15s heartbeat (in-game, snapshots arrive at
// 5Hz). 32s of total silence therefore means the TCP socket is dead even though
// the browser still reports it open — a state in which every click (ready,
// start!) silently vanishes into PartySocket's offline queue. Force a reconnect
// so the socket heals, the queued commands flush, and the server-side reaper
// can clean up any stale duplicate of us.
setInterval(() => {
  if (!net.localMode && Date.now() - net.lastRecvAt > 32_000) net.reconnect();
}, 5_000);

const unlockAudio = () => {
  audio.unlock();
};
window.addEventListener("pointerdown", unlockAudio, { passive: true });
window.addEventListener("keydown", unlockAudio, { passive: true });

let mySlot = -1;
let myTeam = 0;
let myId = "";
let lobbyHumans = 1; // non-spectator, non-bot count from latest lobby state — gates the pause button
let iAmLobbyHost = false;
let lastLobbyPhase: "lobby" | "playing" | "ended" = "lobby";
let phase: "lobby" | "playing" | "ended" = "lobby";
// Important-only error telemetry — reports uncaught exceptions/rejections/
// console.errors with room+phase+slot context so client failures are fetchable
// server-side (/client-error?room=X) instead of dying inside one user's browser.
installTelemetry({ room, name, phase: () => phase, slot: () => mySlot });
let currentMap: MapId = "crossroads";
let currentConfig: GameConfig = { ...DEFAULT_CONFIG };
let latestState: PlayerState | null = null;
const oreCells = new Set<number>();
const allies = new Set<number>();
let prevAwaiting = "";
let prevAwaitingDef = "";
let prevLowPower = false;
let iconColor = "";
let iconRunColor = "";
const ICON_KINDS: EntKind[] = [
  "conyard",
  "coalplant",
  "fusion",
  "barracks2",
  "factory2",
  "airfield2",
  "shipyard2",
  "derrick",
  "coalmine",
  ...BUILD_ORDER,
  ...DEFENSE_ORDER,
  ...TRAIN_ORDER.map((t) => t.unit),
];
// Sidebar thumbnails are expensive (per-kind offscreen render + pixel readback),
// so they are generated incrementally and cached by faction color. The lobby
// prewarms them with the player's predicted slot color; init only regenerates
// when the prediction was wrong, and the time-sliced loop never blocks the
// game-start transition either way.
function ensureIcons(color: string) {
  if (iconColor === color) return;
  iconColor = color;
  if (iconRunColor === color) return; // correct-color run already in flight — it applies itself when done
  iconRunColor = color; // any in-flight run for a different color now cancels itself as stale
  const isStale = () => iconRunColor !== color;
  // Icons are snapshots: wait for the worker-produced shared detail textures so
  // thumbnails never capture the transient neutral placeholders. The icon bake
  // itself remains incremental/cancellable through generateIcons.
  whenModelTexturesReady()
    .then(() => generateIcons(gs, ICON_KINDS, color, isStale))
    .then((icons) => {
      if (!isStale()) hud.setIcons(icons);
    });
}

// ---------- lobby idle prewarm pipeline ----------
// Everything expensive that game start used to pay synchronously is instead
// prepared here while the player sits in the lobby: terrain/cliff/water scene
// construction for the selected map (time-sliced generator), instanced unit
// pool templates, and shader program compilation against the real scene
// lighting. Each stage is cancellation-safe; starting the match or switching
// the map invalidates in-flight work, and the init handler's loadMap becomes a
// cheap no-op whenever the pipeline got there first.
let prewarmGen = 0;
let prewarmTargetMap: MapId | null = null;
let shaderRewarmGen = 0;

function schedulePrewarm(map: MapId) {
  if (phase !== "lobby" || prewarmTargetMap === map) return;
  prewarmTargetMap = map;
  const gen = ++prewarmGen;
  const cancelled = () => gen !== prewarmGen || phase !== "lobby";
  void (async () => {
    // Stage 1: terrain textures (in the texture worker) + cliff/water/artifact
    // geometry, with the scene-construction portion fully sliced.
    await gs.prewarmMap(map, cancelled);
    if (cancelled()) return;
    // Stage 2: instanced pool templates + incremental shader compilation,
    // one entity kind per slice.
    await renderer.warmPoolsAsync(cancelled);
  })();
}

function cancelPrewarm() {
  prewarmGen++;
  shaderRewarmGen++;
  prewarmTargetMap = null;
}

// Quality changes can alter shader program variants (shadow defines, postfx).
// The menu render loop re-warms scene materials naturally within a frame, but
// zero-count instanced pool meshes never draw — re-run the cheap incremental
// compile pass so their variants are warm too. ensure-calls no-op fast when
// the pools already exist, and the map build (quality-independent) is never
// restarted.
function scheduleShaderRewarm() {
  if (phase !== "lobby") return;
  const gen = ++shaderRewarmGen;
  const cancelled = () => gen !== shaderRewarmGen || phase !== "lobby";
  void renderer.warmPoolsAsync(cancelled);
}

const sceneGraphicsOnChange = gs.graphics.onChange;
gs.graphics.onChange = (s, g) => {
  sceneGraphicsOnChange?.(s, g);
  scheduleShaderRewarm();
};
let lastTrainSfx = 0;
let lastHoverMs = 0;
let matchPlayers: { id: string; slot: number; name: string; team: number }[] = [];
let pendingAiSpectate = false;
let autoCam = false;
let autoCamGoal = { x: MAP_W / 2, z: MAP_H / 2 };
let autoCamNextEval = 0;
let autoCamCycleIdx = 0;
let lastCamX = MAP_W / 2;
let lastCamZ = MAP_H / 2;
const combatEvents: { x: number; y: number; w: number; t: number }[] = [];

function setAutoCam(on: boolean) {
  autoCam = on;
  hud.setAutoCamState(on);
  if (on) {
    autoCamNextEval = 0;
    lastCamX = gs.camTarget.x;
    lastCamZ = gs.camTarget.z;
  }
}

function focusCommander(slot: number) {
  if (autoCam) setAutoCam(false);
  let sx = 0,
    sz = 0,
    n = 0;
  let bsx = 0,
    bsz = 0,
    bn = 0;
  let conyardPos: { x: number; z: number } | null = null;
  for (const t of renderer.tracked.values()) {
    const e = t.last;
    if (e.o !== slot) continue;
    if (!isBuildingKind(e.k) && e.k !== "harvester") {
      sx += e.x;
      sz += e.y;
      n++;
    } else {
      bsx += e.x;
      bsz += e.y;
      bn++;
      if (e.k === "conyard") conyardPos = { x: e.x, z: e.y };
    }
  }
  let tx: number, tz: number;
  if (n > 0) {
    tx = sx / n;
    tz = sz / n;
  } else if (conyardPos) {
    tx = conyardPos.x;
    tz = conyardPos.z;
  } else if (bn > 0) {
    tx = bsx / bn;
    tz = bsz / bn;
  } else {
    const sp = getSpawns(gs.mapW, gs.mapH)[slot] ?? { x: gs.mapW / 2, y: gs.mapH / 2 };
    tx = sp.x + 1.5;
    tz = sp.y + 1.5;
  }
  gs.camTarget.x = Math.max(4, Math.min(gs.mapW - 4, tx));
  gs.camTarget.z = Math.max(4, Math.min(gs.mapH - 4, tz));
  gs.updateCamera();
  lastCamX = gs.camTarget.x;
  lastCamZ = gs.camTarget.z;
}

function pickAutoCamTarget(now: number): { x: number; z: number } | null {
  // Prune stale combat events older than 3.8s
  while (combatEvents.length && now - combatEvents[0].t > 3800) combatEvents.shift();

  const mobile: { x: number; y: number; o: number; combat: boolean }[] = [];
  for (const t of renderer.tracked.values()) {
    const e = t.last;
    if (e.o < 0 || isBuildingKind(e.k)) continue;
    mobile.push({ x: e.x, y: e.y, o: e.o, combat: e.k !== "harvester" });
  }

  let bestScore = 0;
  let bestX = gs.mapW / 2;
  let bestZ = gs.mapH / 2;

  // 1. Score recent combat event clusters (shots, explosions, ion strikes, captures)
  for (let i = 0; i < combatEvents.length; i++) {
    const ev = combatEvents[i];
    let score = 0;
    let wx = 0;
    let wz = 0;
    for (let j = 0; j < combatEvents.length; j++) {
      const o = combatEvents[j];
      const dx = o.x - ev.x;
      const dy = o.y - ev.y;
      if (dx * dx + dy * dy <= 100) {
        const decay = Math.max(0.2, 1 - (now - o.t) / 3800);
        const w = o.w * decay;
        score += w;
        wx += o.x * w;
        wz += o.y * w;
      }
    }
    // Bonus when multiple factions have units engaged near this hotspot
    const owners = new Set<number>();
    for (let k = 0; k < mobile.length; k++) {
      const u = mobile[k];
      const dx = u.x - ev.x;
      const dy = u.y - ev.y;
      if (dx * dx + dy * dy <= 144) owners.add(u.o);
    }
    if (owners.size >= 2) score *= 1.65;
    if (score > bestScore && score > 0) {
      bestScore = score;
      bestX = wx / score;
      bestZ = wz / score;
    }
  }

  // 2. Score live multi-faction unit clashes (even between volleys)
  for (let i = 0; i < mobile.length; i++) {
    const u = mobile[i];
    if (!u.combat) continue;
    let enemies = 0;
    let friends = 0;
    let sx = u.x;
    let sz = u.y;
    let cnt = 1;
    for (let j = 0; j < mobile.length; j++) {
      if (i === j) continue;
      const v = mobile[j];
      const dx = v.x - u.x;
      const dy = v.y - u.y;
      if (dx * dx + dy * dy <= 121) {
        if (v.o !== u.o) enemies++;
        else friends++;
        sx += v.x;
        sz += v.y;
        cnt++;
      }
    }
    if (enemies > 0) {
      const score = 3 + enemies * 2.4 + Math.min(friends, 6) * 0.7;
      if (score > bestScore) {
        bestScore = score;
        bestX = sx / cnt;
        bestZ = sz / cnt;
      }
    }
  }

  if (bestScore > 0) {
    return {
      x: Math.max(6, Math.min(gs.mapW - 6, bestX)),
      z: Math.max(6, Math.min(gs.mapH - 6, bestZ)),
    };
  }

  // 3. Early-game fallback: follow active mobile unit clusters or cycle smoothly between commanders
  if (mobile.length > 0) {
    const activeSlots = [...new Set(mobile.map((u) => u.o))].sort((a, b) => a - b);
    if (activeSlots.length) {
      const slot = activeSlots[autoCamCycleIdx++ % activeSlots.length];
      let sx = 0,
        sz = 0,
        cnt = 0;
      for (const u of mobile) {
        if (u.o !== slot) continue;
        sx += u.x;
        sz += u.y;
        cnt++;
      }
      if (cnt > 0) {
        return {
          x: Math.max(6, Math.min(gs.mapW - 6, sx / cnt)),
          z: Math.max(6, Math.min(gs.mapH - 6, sz / cnt)),
        };
      }
    }
  }

  return null;
}

hud.setRoom(room);
hud.setStatus("connecting…");
hud.setInitialName(name);
hud.setAudioState(audio.muted, audio.musicOn);
const gfx = (gs as unknown as { graphics?: GraphicsBridge }).graphics;
if (gfx) hud.bindGraphics(gfx);

// ---------- placement validity (exact client parity with server canPlace) ----------

// building footprints + occupied unit tiles, rebuilt per snap — placeReason runs
// per pointer-move while placing, so keep its scan tiny
let bldRects: { bx: number; by: number; w: number; h: number; o: number }[] = [];
let landTiles = new Set<number>();
let seaTiles = new Set<number>();

function placeReason(tx: number, ty: number, w: number, h: number, kind?: BuildingKind): string | null {
  if (tx < 0 || ty < 0 || tx + w > gs.mapW || ty + h > gs.mapH) return "off map";
  const bdef = kind ? BUILDINGS[kind] : undefined;
  const waterOnly = !!bdef?.waterOnly;
  for (let y = ty; y < ty + h; y++)
    for (let x = tx; x < tx + w; x++) {
      if (gs.isCliff(x, y)) return "blocked by terrain";
      if (waterOnly) {
        if (!gs.isWater(x, y)) return "must build on water";
      } else {
        if (gs.isWater(x, y)) return "can't build on water";
      }
      if (oreCells.has(y * gs.mapW + x)) return "can't build on ore";
      if ((waterOnly ? seaTiles : landTiles).has(y * gs.mapW + x)) return "units in the way";
    }
  const maxGap = bdef?.forwardRange ?? (waterOnly ? SHIPYARD_BUILD_DIST : 2);
  let adj = false;
  for (const b of bldRects) {
    if (tx < b.bx + b.w && tx + w > b.bx && ty < b.by + b.h && ty + h > b.by) return "blocked by structure";
    if (b.o === mySlot) {
      const gapX = Math.max(b.bx - (tx + w), tx - (b.bx + b.w));
      const gapY = Math.max(b.by - (ty + h), ty - (b.by + b.h));
      if (Math.max(gapX, gapY) <= maxGap) adj = true;
    }
  }
  return adj ? null : "too far from your base";
}

const oreAt = (x: number, y: number) => oreCells.has(y * gs.mapW + x);
const isAlly = (slot: number) => allies.has(slot);

function weaponFxOf(k: EntKind): WeaponFx {
  if (k === "tank" || k === "heavy" || k === "destroyer") return "cannon";
  if (k === "rocket" || k === "interceptor" || k === "sam") return "rocket";
  if (k === "arty" || k === "ac130") return "arty";
  if (k === "arc") return "arc";
  if (k === "spider") return "melee";
  if (k === "dreadnought" || k === "himars" || k === "carrier" || k === "thaad") return "missile";
  if (k === "sub") return "torpedo";
  if (
    k === "bomber" ||
    k === "stealthbomber" ||
    k === "zeppelin" ||
    k === "fpvdrone" ||
    k === "shahed" ||
    k === "hypersonic" ||
    k === "usv"
  )
    return "bomb";
  if (k === "lasertower" || k === "satlink") return "laser";
  if (k === "railtank") return "railgun";
  if (k === "a10") return "brrrt";
  if (k === "irondome") return "intercept";
  return "bullet";
}

const input = new Input(gs, renderer, net, () => mySlot, placeReason, oreAt);
input.isAlly = isAlly;
// FPV bundle is ~5k lines of viewmodel code — loaded on first POV entry, not at startup.
let fpvReal: FirstPersonController | null = null;
let fpvLoading: Promise<FirstPersonController> | null = null;
const fpvHandlers: Partial<Pick<FirstPersonController, "onSfx" | "onExit" | "onFireSfx">> = {};
function loadFpv(): Promise<FirstPersonController> {
  if (fpvReal) return Promise.resolve(fpvReal);
  if (!fpvLoading) {
    fpvLoading = import("./fpv").then((m) => {
      fpvReal = new m.FirstPersonController(gs, renderer, net, () => mySlot, isAlly);
      Object.assign(fpvReal, fpvHandlers);
      return fpvReal;
    });
  }
  return fpvLoading;
}
const fpv = {
  get active() { return fpvReal?.active ?? false; },
  get entId() { return fpvReal?.entId ?? null; },
  get onSfx() { return fpvHandlers.onSfx; },
  set onSfx(v) { fpvHandlers.onSfx = v; if (fpvReal && v) fpvReal.onSfx = v; },
  get onExit() { return fpvHandlers.onExit; },
  set onExit(v) { fpvHandlers.onExit = v; if (fpvReal && v) fpvReal.onExit = v; },
  get onFireSfx() { return fpvHandlers.onFireSfx; },
  set onFireSfx(v) { fpvHandlers.onFireSfx = v; if (fpvReal && v) fpvReal.onFireSfx = v; },
  enter(id: number) {
    if (fpvReal) return fpvReal.enter(id);
    void loadFpv().then((c) => { if (!c.enter(id)) fpvHandlers.onExit?.("user"); });
    return true;
  },
  exit(reason: "user" | "dead") { fpvReal?.exit(reason); },
  update(dt: number) { return fpvReal?.update(dt) ?? null; },
  onShotEvent(id: number) { fpvReal?.onShotEvent(id); },
};
const story = new FpvStory();
fpv.onSfx = (n) => audio.playFpvSfx(n);
story.onSfx = (n) => audio.playFpvSfx(n);
hud.setWasdLabel(input.wasdPan);

// Entity-kind memory — victims vanish from the snap the tick they die, so the
// story layer resolves kill-event target names through this persistent map.
const lastKind = new Map<number, EntKind>();
const kindOf = (id: number): EntKind | undefined => renderer.tracked.get(id)?.last.k ?? lastKind.get(id);

function enterFpv(id: number) {
  if (phase !== "playing" || mySlot < 0 || fpv.active) return;
  if (input.placing) input.exitPlacing();
  input.armVerb(null);
  input.disarmOrders();
  input.disarmRecon();
  input.disarmSuperweapon();
  if (!fpv.enter(id)) return;
  input.enabled = false;
  hud.setFpvMode(true);
  const ek = kindOf(id);
  if (ek !== undefined && !isBuildingKind(ek)) story.reset(ek as UnitKind, name);
  audio.playUi("select");
}

fpv.onExit = (reason) => {
  input.enabled = true;
  hud.setFpvMode(false, mySlot < 0);
  hud.updateFpvStory(null);
  hud.updateSelInfo(input.selection, renderer.tracked, mySlot, latestState, has);
  if (reason === "dead") {
    hud.toast("UNIT DESTROYED — RETURNING TO COMMAND");
    audio.playUi("lose");
  }
};
fpv.onFireSfx = (kind, vet) => {
  audio.playShot(weaponFxOf(kind), vet);
};

const UPGRADED_ALIAS: Partial<Record<string, string>> = {
  barracks: "barracks2",
  factory: "factory2",
  airfield: "airfield2",
  shipyard: "shipyard2",
};

// per-snap memoized own-entity kind counts — has()/countOf() are called ~100x per
// sidebar refresh, so scan `tracked` once instead of once per call
let ownKindCounts: Map<string, number> | null = null;
function ownCounts() {
  if (!ownKindCounts) {
    ownKindCounts = new Map<string, number>();
    for (const t of renderer.tracked.values()) {
      if (t.last.o !== mySlot) continue;
      ownKindCounts.set(t.last.k, (ownKindCounts.get(t.last.k) ?? 0) + 1);
    }
  }
  return ownKindCounts;
}

function has(kind: string) {
  const mk2 = UPGRADED_ALIAS[kind];
  const c = ownCounts();
  if ((c.get(kind) ?? 0) > 0) return true;
  if (mk2 !== undefined && (c.get(mk2) ?? 0) > 0) return true;
  if (kind === "power" && ((c.get("coalplant") ?? 0) > 0 || (c.get("fusion") ?? 0) > 0)) return true;
  return false;
}

function countOf(kind: BuildingKind) {
  return ownCounts().get(kind) ?? 0;
}

// ---------- game-start feedback state ----------
// The start click must never feel like a dead button. The pending state is
// optimistic and immediate; the loading overlay is deliberately not — it only
// appears when battle-control handoff is still incomplete after 400ms, so warm
// prewarmed starts transition without a full-screen flash.
const START_PENDING_TIMEOUT_MS = 5000;
const START_OVERLAY_DELAY_MS = 400;
const START_OVERLAY_FAILSAFE_MS = 15000;

let startPending = false;
let startClickAt: number | null = null;
let startPendingTimer: ReturnType<typeof setTimeout> | null = null;

interface MatchLoadingState {
  map: MapId;
  sourceLabel: string;
  startedAt: number;
  snapSeen: boolean;
  snapAt: number | null;
  visible: boolean;
  showTimer: ReturnType<typeof setTimeout> | null;
  failsafeTimer: ReturnType<typeof setTimeout> | null;
}
let matchLoading: MatchLoadingState | null = null;

function clearStartPending() {
  if (startPendingTimer) {
    clearTimeout(startPendingTimer);
    startPendingTimer = null;
  }
  startPending = false;
  hud.setStartPending(false);
}

function beginMatchLoading(map: MapId, sourceLabel: string, startedAt = performance.now()) {
  if (matchLoading) {
    // `starting` and `init` are two milestones of the same transition. Keep the
    // original clock (that is what the anti-flash threshold is measuring) and
    // merely refresh the presentation data.
    matchLoading.map = map;
    matchLoading.sourceLabel = sourceLabel;
    return;
  }
  const st: MatchLoadingState = {
    map,
    sourceLabel,
    startedAt,
    snapSeen: false,
    snapAt: null,
    visible: false,
    showTimer: null,
    failsafeTimer: null,
  };
  matchLoading = st;
  const showCheck = () => {
    st.showTimer = null;
    if (matchLoading !== st) return;
    if (st.snapSeen) {
      // A snapshot that arrived only moments ago is about to paint — defer the
      // decision briefly instead of flashing the overlay for one frame. If the
      // machine is too weak to paint that frame promptly, the age grows past
      // this grace window and the overlay legitimately appears.
      const age = performance.now() - (st.snapAt ?? performance.now());
      if (age < 140) {
        st.showTimer = setTimeout(showCheck, 140 - age + 1);
        return;
      }
    }
    st.visible = true;
    hud.showStartOverlay(st.map, st.sourceLabel);
  };
  // The host-side clock starts at the click (network time is part of the
  // perceived transition), but the state object itself is only created once
  // the server has accepted the start or init arrives — invalid starts therefore
  // never put up a misleading full-screen loader before their deny.
  st.showTimer = setTimeout(showCheck, Math.max(0, START_OVERLAY_DELAY_MS - (performance.now() - startedAt)));
  st.failsafeTimer = setTimeout(() => {
    st.failsafeTimer = null;
    if (matchLoading !== st) return;
    console.warn("match-start loading failsafe fired — revealing the game/lobby regardless");
    finishMatchLoading(st);
  }, START_OVERLAY_FAILSAFE_MS);
}

function finishMatchLoading(st: MatchLoadingState) {
  if (matchLoading !== st) return;
  if (st.showTimer) clearTimeout(st.showTimer);
  if (st.failsafeTimer) clearTimeout(st.failsafeTimer);
  matchLoading = null;
  // Normal completion already hid this via hideLobby(); on the failsafe path
  // this is what prevents a stale LOADING strip from surviving forever.
  hud.hideLobbyStarting();
  if (st.visible) hud.hideStartOverlay();
  else hud.cancelStartOverlay();
}

function cancelMatchLoading() {
  const st = matchLoading;
  if (!st) return;
  if (st.showTimer) clearTimeout(st.showTimer);
  if (st.failsafeTimer) clearTimeout(st.failsafeTimer);
  matchLoading = null;
  hud.cancelStartOverlay();
}

function noteMatchLoadingInit(map: MapId) {
  if (!matchLoading) {
    const label =
      startPending || iAmLobbyHost
        ? "STARTING GAME"
        : lastLobbyPhase === "lobby"
          ? "HOST STARTED THE GAME"
          : "CONNECTING TO MATCH";
    beginMatchLoading(map, label, startClickAt ?? undefined);
  } else {
    matchLoading.map = map;
  }
}

function noteMatchSnapshot() {
  const st = matchLoading;
  if (!st || st.snapSeen) return;
  st.snapSeen = true;
  st.snapAt = performance.now();
  // The render loop's next RAF callback was scheduled before this one, so one
  // RAF is enough to let the first entity-bearing frame actually paint before
  // the overlay fades. If the frame never comes (hidden tab / GPU stall), the
  // 15s failsafe above still guarantees removal.
  requestAnimationFrame(() => finishMatchLoading(st));
}

function beginStartRequest() {
  if (startPending) return;
  startPending = true;
  startClickAt = performance.now();
  hud.hideLobbyAlert();
  hud.setStartPending(true);
  // Arm before send: the in-process local fallback can answer synchronously.
  startPendingTimer = setTimeout(() => {
    startPendingTimer = null;
    if (!startPending) return;
    startPending = false;
    startClickAt = null;
    hud.setStartPending(false);
    if (phase === "lobby") {
      const acknowledged = !!matchLoading;
      hud.hideLobbyStarting();
      cancelMatchLoading();
      hud.showLobbyAlert(
        acknowledged
          ? "Game start was accepted, but battle control did not arrive — check the connection or try again."
          : "No response from server — check the connection, then click START again.",
        "START TIMED OUT",
      );
    }
  }, START_PENDING_TIMEOUT_MS);
  net.send({ t: "start" });
}

// ---------- hud wiring ----------

hud.onReady = (r) => net.send({ t: "ready", ready: r });
hud.onStart = () => beginStartRequest();
hud.onRematch = () => net.send({ t: "rematch" });
hud.onAddBot = (diff, profile) => net.send({ t: "addbot", diff, profile });
hud.onSetBotConfig = (id, diff, profile) => net.send({ t: "setBotConfig", id, diff, profile });
hud.onKickBot = (id) => net.send({ t: "kickbot", id });
hud.onTransferHost = (id) => net.send({ t: "transferHost", id });
hud.onSetMap = (map) => net.send({ t: "setMap", map });
hud.onSetConfig = (config) => net.send({ t: "setConfig", config });
hud.onSetTeam = (team, id) => net.send({ t: "setTeam", team, ...(id ? { id } : {}) });
hud.onSetSlot = (slot, id) => net.send({ t: "setSlot", slot, ...(id ? { id } : {}) });
hud.onSwapSlot = (id, id2) => net.send({ t: "swapSlot", id, ...(id2 ? { id2 } : {}) });
hud.onSetName = (n) => {
  name = n;
  localStorage.setItem("oa-name", n);
  net.send({ t: "setName", name: n });
};
hud.onResign = () => net.send({ t: "resign" });
hud.onChat = (text) => net.send({ t: "chat", text });
hud.onVerb = (v) => {
  if (v === "amove") input.armAmove();
  else if (v === "patrol") input.armPatrol();
  else if (v === "hold") input.holdNow();
  else if (v === "stop") input.stopNow();
  else if (v === "unload") input.armUnload();
  else input.armVerb(v);
};
hud.onBuild = (kind) => {
  net.send({ t: "build", kind });
  audio.playUi("buildStart");
};
hud.onBuildCancel = (cat, kind, awaiting, index) => {
  if (input.placing && (!cat || buildCategoryOf(input.placing) === cat)) {
    input.exitPlacing();
  }
  net.send({ t: "buildCancel", cat, kind, awaiting, index });
  audio.playUi("select");
  hud.toast(cat === "defense" ? "Defense cancelled & refunded" : "Construction cancelled & refunded", true);
};
hud.onPlaceMode = (kind) => {
  if (input.placing === kind) {
    input.exitPlacing();
    return;
  }
  input.placingCancelled = false;
  input.enterPlacing(kind);
  audio.playUi("select");
};
hud.onTrain = (u) => {
  net.send({ t: "train", unit: u });
  const now = performance.now();
  if (now - lastTrainSfx > 60) {
    lastTrainSfx = now;
    audio.playUi("buildStart");
  }
};
hud.onTrainCancel = (u, cat, index) => {
  net.send({ t: "trainCancel", unit: u, cat, index });
  audio.playUi("select");
};
hud.onFilterSelection = (kind) => {
  const next = new Set<number>();
  for (const id of input.selection) {
    const t = renderer.tracked.get(id);
    if (t && t.last.o === mySlot && t.last.k === kind) next.add(id);
  }
  if (next.size) {
    input.setSelection(next);
    audio.playUi("select");
  }
};
input.onPlaceReadyHotkey = () => {
  const aw = latestState?.awaiting ?? [];
  const awDef = latestState?.awaitingDef ?? [];
  if (!aw.length && !awDef.length) return;
  // Prefer the pile matching current placing cat; B cycles through its ready kinds
  const curCat = input.placing ? buildCategoryOf(input.placing) : null;
  const pile = curCat === "defense" ? (awDef.length ? awDef : aw) : (aw.length ? aw : awDef);
  const idx = input.placing ? pile.indexOf(input.placing) : -1;
  const next = pile[(idx + 1) % pile.length];
  if (input.placing === next && pile.length === 1) input.exitPlacing();
  else {
    input.placingCancelled = false;
    input.enterPlacing(next);
    audio.playUi("select");
  }
};
hud.onBuildBlocked = () => audio.playUi("deny");
hud.onUpgrade = (id) => {
  net.send({ t: "upgrade", id });
  audio.playUi("upgrade");
};
hud.onEnterFpv = (id) => enterFpv(id);
hud.onExitFpv = () => {
  if (fpv.active) fpv.exit("user");
};
hud.onSuperweaponClick = () => {
  if (latestState?.swReady && !latestState.lowPower) input.armSuperweapon();
};
hud.onReconClick = () => {
  if (latestState?.reconReady && !latestState.lowPower) input.armRecon();
};
hud.onMinimapPing = (x, y) => net.send({ t: "ping", x, y });
hud.onMinimapOrder = (x, y, shift) => (fpv.active ? false : input.issueMinimapOrder(x, y, shift));
hud.onMinimapNav = (x, y) => {
  if (fpv.active) return;
  if (autoCam) setAutoCam(false);
  gs.camTarget.x = Math.max(-2, Math.min(gs.mapW + 2, x));
  gs.camTarget.z = Math.max(-2, Math.min(gs.mapH + 2, y));
  gs.updateCamera();
  lastCamX = gs.camTarget.x;
  lastCamZ = gs.camTarget.z;
};
hud.onGroupClick = (n, dbl) => {
  input.recallGroup(n, false);
  if (dbl) input.centerOnSelection();
};
hud.onToggleWasd = () => input.setWasdPan(!input.wasdPan);
hud.onTogglePause = () => net.send({ t: "pause", paused: !hud.isPaused() });
hud.onToggleMute = () => {
  audio.unlock();
  audio.toggleMute();
  hud.setAudioState(audio.muted, audio.musicOn);
};
hud.onToggleMusic = () => {
  audio.unlock();
  audio.toggleMusic();
  hud.setAudioState(audio.muted, audio.musicOn);
};

input.onOpenChat = () => hud.focusChat();
input.onEnterFpv = () => {
  if (input.selection.size === 1) enterFpv([...input.selection][0]);
};
input.onWasdChange = (on) => hud.setWasdLabel(on);
input.onSelectionChange = (sel) => hud.updateSelInfo(sel, renderer.tracked, mySlot, latestState, has);
input.onGroupsChange = (g) => hud.updateGroups(g, renderer.tracked, mySlot);
input.onSuperweaponArmedChange = (armed) => hud.updateSuperweapon(latestState, armed);
input.onReconArmedChange = (armed) => hud.updateRecon(latestState, armed);
input.onUiSound = (kind) => audio.playUi(kind);
input.onOrderLabel = (text, x, y) => {
  const l = el("order-label");
  if (!text) {
    l.classList.add("hidden");
    return;
  }
  l.textContent = text;
  l.style.left = (x ?? 0) + "px";
  l.style.top = (y ?? 0) + "px";
  l.classList.remove("hidden");
};
renderer.onOwnerLost = (id) => {
  if (input.selection.delete(id)) {
    hud.updateSelInfo(input.selection, renderer.tracked, mySlot, latestState, has);
  }
};

// ---------- network ----------

hud.onSwitchLocal = () => {
  net.switchToLocal("Local Solo Skirmish active — 0ms ping, plays offline with bots!");
  document.getElementById("solo-local-btn")?.classList.add("hidden");
};
hud.onRetryOnline = () => {
  hud.toast("Retrying online multiplayer connection…", true);
  net.retryOnline();
};
hud.onWatchAiBattle = (map) => {
  pendingAiSpectate = true;
  hud.closeWatchPanel();
  document.getElementById("solo-local-btn")?.classList.add("hidden");
  net.startAiSpectate(map);
};
hud.onToggleAutoCam = () => setAutoCam(!autoCam);
hud.onFocusCommander = (slot) => focusCommander(slot);
net.onLocalFallback = (reason) => {
  document.getElementById("solo-local-btn")?.classList.add("hidden");
  if (net.quotaExceeded || /quota|limit|free-tier/i.test(reason)) {
    hud.setQuotaExceeded(true);
  }
  hud.toast(reason, true);
};
net.onStatus = (s) => {
  hud.setStatus(s);
  if (s === "" && !net.localMode) {
    hud.setQuotaExceeded(false);
    document.getElementById("solo-local-btn")?.classList.remove("hidden");
  }
};
if (watchParam) hud.openWatchPanel();
net.onMsg = (m: S2C) => {
  switch (m.t) {
    case "lobby": {
      myId = m.you;
      lobbyHumans = m.players.filter((p) => !p.spectator && !p.bot && p.connected !== false).length;
      const lobbyMe = m.players.find((p) => p.id === m.you);
      iAmLobbyHost = !!lobbyMe?.host;
      lastLobbyPhase = m.phase ?? "lobby";
      currentMap = m.map ?? "crossroads";
      if (m.config) currentConfig = { ...DEFAULT_CONFIG, ...m.config };
      if (phase === "ended") {
        phase = "lobby";
        hud.hideEnd();
      } else if (phase === "playing" && m.phase === "lobby") {
        // Server room restarted (e.g. deploy or idle reset) — recover cleanly to lobby instead of freezing!
        if (fpv.active) fpv.exit("user");
        phase = "lobby";
        mySlot = -1;
        latestState = null;
        lastKind.clear();
        setAutoCam(false);
        renderer.reset();
        input.reset();
        clearStartPending();
        cancelMatchLoading();
        hud.hideLobbyStarting();
        hud.resetMatch();
        hud.hideEnd();
        hud.toast("Server updated / room reset — returned to lobby", true);
      }
      if (phase === "lobby") {
        hud.showLobby(m.players, m.you, currentMap, currentConfig);
        // Icon prewarm: the lobby already knows which spawn/color slot we occupy,
        // so the expensive thumbnail batch can bake incrementally during idle
        // lobby time instead of inside the synchronous game-start handler.
        const me = m.players.find((p) => p.id === m.you);
        const predictedColor = me && me.slot >= 0 && !me.spectator ? PLAYER_COLORS[me.slot] : "#45d6ff";
        ensureIcons(predictedColor);
        schedulePrewarm(currentMap);
      }
      break;
    }
    case "starting": {
      const mine = m.hostId === myId;
      const label = mine ? "STARTING GAME" : `${m.host} STARTED THE GAME`;
      hud.hideLobbyAlert();
      hud.showLobbyStarting(`${label} — LOADING…`);
      beginMatchLoading(m.map, label, mine ? (startClickAt ?? undefined) : undefined);
      break;
    }
    case "init": {
      noteMatchLoadingInit(m.map ?? currentMap);
      clearStartPending();
      startClickAt = null;
      hud.hideLobbyAlert();
      if (fpv.active) fpv.exit("dead");
      cancelPrewarm(); // lobby idle work stops here; anything already built carries over
      myId = m.you;
      mySlot = m.slot;
      matchPlayers = m.players;
      combatEvents.length = 0;
      lastKind.clear();
      currentMap = m.map ?? "crossroads";
      currentConfig = m.config ? { ...DEFAULT_CONFIG, ...m.config } : { ...DEFAULT_CONFIG };
      phase = "playing";
      prevAwaiting = "";
      prevAwaitingDef = "";
      prevLowPower = false;
      latestState = null;
      hud.setPauseVisible(mySlot >= 0 && lobbyHumans <= 1);
      myTeam = m.players.find((p) => p.slot === mySlot)?.team ?? 0;
      allies.clear();
      if (mySlot >= 0) {
        allies.add(mySlot);
        if (myTeam > 0) {
          for (const p of m.players) if (p.team === myTeam) allies.add(p.slot);
        }
      }
      renderer.reset();
      input.reset();
      gs.resetYaw();
      gs.loadMap(currentMap);
      gs.resetFog();
      gs.clearOre();
      hud.resetMatch();
      hud.setMapSize(gs.mapW, gs.mapH);
      hud.clearChat();
      hud.hideLobby(mySlot < 0);
      hud.hideEnd();
      hud.updateSpecCommanders(matchPlayers);
      const startAutoCam = mySlot < 0 && pendingAiSpectate;
      pendingAiSpectate = false;
      renderer.slotColors.clear();
      for (const p of m.players) renderer.slotColors.set(p.slot, PLAYER_COLORS[p.slot]);
      oreCells.clear();
      gs.setOreCells(m.ore);
      for (const [x, y, a] of m.ore) if (a > 0) oreCells.add(y * gs.mapW + x);
      if (mySlot >= 0) {
        const spawns = getSpawns(gs.mapW, gs.mapH);
        const s = spawns[mySlot] ?? spawns[0];
        gs.camTarget.set(s.x + 2, 0, s.y + 3);
        gs.updateCamera();
      } else {
        gs.camTarget.set(gs.mapW / 2, 0, gs.mapH / 2);
        gs.updateCamera();
      }
      lastCamX = gs.camTarget.x;
      lastCamZ = gs.camTarget.z;
      autoCamGoal = { x: gs.camTarget.x, z: gs.camTarget.z };
      setAutoCam(startAutoCam);
      // Render real 3D model thumbnails for sidebar + selection panel (incl. all
      // upgrades, defenses & coalmine). Normally already warm from the lobby;
      // regenerates incrementally (never blocking the transition) if the slot
      // color prediction missed.
      ensureIcons(mySlot >= 0 ? PLAYER_COLORS[mySlot] : "#45d6ff");
      hud.toast(mySlot >= 0 ? "battle control online — good luck, commander" : "spectating", true);
      break;
    }
    case "snap": {
      if (phase !== "playing") break;
      ownKindCounts = null; // entity set changed — rebuild the sidebar kind cache
      bldRects = [];
      landTiles = new Set();
      seaTiles = new Set();
      for (const e of m.ents) {
        if (isBuildingKind(e.k)) {
          const d = BUILDINGS[e.k];
          bldRects.push({ bx: Math.round(e.x - d.w / 2), by: Math.round(e.y - d.h / 2), w: d.w, h: d.h, o: e.o });
        } else {
          const dom = UNITS[e.k as UnitKind].domain;
          if (dom === "sea") seaTiles.add(Math.floor(e.y) * gs.mapW + Math.floor(e.x));
          else if (dom === "land") landTiles.add(Math.floor(e.y) * gs.mapW + Math.floor(e.x));
        }
      }
      renderer.pushSnap(m.ents, m.crates);
      renderer.setBridges(m.bridges);
      hud.setBridges(m.bridges);
      // Remember every seen entity kind BEFORE pruning — dead ents vanish from
      // the snap but kill events still need to resolve their names.
      for (const e of m.ents) lastKind.set(e.id, e.k);
      renderer.setPlayerPower(m.players);
      renderer.applyVisibility(currentConfig.fog ? mySlot : -1, allies);
      renderer.applyEvents(m.events, mySlot);
      let shotSfx = 0;
      let boomSfx = 0;
      let ewJamSfx = 0;
      const evNow = performance.now();
      const storyCtx = { myId: fpv.entId ?? -1, kindOf };
      const noteCombatPos = (x: number, y: number, w: number) => {
        if (mySlot >= 0) return;
        combatEvents.push({ x, y, w, t: evNow });
        if (combatEvents.length > 80) combatEvents.splice(0, combatEvents.length - 80);
      };
      for (const ev of m.events) {
        if (fpv.active) story.onEvent(ev, storyCtx);
        if (ev.e === "ore") {
          for (const [x, y, a] of ev.cells) {
            if (a <= 0) oreCells.delete(y * gs.mapW + x);
            else oreCells.add(y * gs.mapW + x);
          }
        } else if (ev.e === "shot") {
          const isFpvShot = fpv.active && ev.src != null && ev.src === fpv.entId;
          if (ev.src != null) fpv.onShotEvent(ev.src);
          noteCombatPos((ev.fx + ev.tx) * 0.5, (ev.fy + ev.ty) * 0.5, 1.2);
          const vis = mySlot < 0 || ev.src == null || renderer.isVisible(ev.src);
          if (vis) {
            if (!isFpvShot && shotSfx++ < 3) audio.playShot(ev.w, ev.vet);
            audio.noteCombat(0.25);
          }
        } else if (ev.e === "boom") {
          noteCombatPos(ev.x, ev.y, 3.0);
          if (boomSfx++ < 2) audio.playBoom(ev.r);
          audio.noteCombat(0.5);
        } else if (ev.e === "superweapon") {
          noteCombatPos(ev.x, ev.y, 8.0);
          audio.playSuperweapon();
          audio.noteCombat(1.0);
          hud.toast("☢ NUCLEAR MISSILE STRIKE!", ev.slot === mySlot);
          hud.ping(ev.x, ev.y);
          input.setLastAlert(ev.x, ev.y);
        } else if (ev.e === "nukeIntercept") {
          noteCombatPos(ev.tx, ev.ty, 7.0);
          audio.playNukeIntercept();
          audio.noteCombat(0.8);
          hud.toast("🛡 LATTICE AEGIS INTERCEPTED NUCLEAR MISSILE!", ev.slot === mySlot || allies.has(ev.slot));
          hud.ping(ev.tx, ev.ty);
          input.setLastAlert(ev.tx, ev.ty);
        } else if (ev.e === "intercept") {
          noteCombatPos(ev.tx, ev.ty, 1.5);
          audio.playShot("intercept");
          audio.noteCombat(0.3);
        } else if (ev.e === "ewjam") {
          noteCombatPos(ev.tx, ev.ty, 1.5);
          let vis = mySlot < 0 || !currentConfig.fog || ev.slot === mySlot || allies.has(ev.slot);
          if (!vis) {
            for (const t of renderer.tracked.values()) {
              if (t.last.o === mySlot || allies.has(t.last.o)) {
                const dx = t.last.x - ev.tx;
                const dy = t.last.y - ev.ty;
                if (dx * dx + dy * dy <= 144) {
                  vis = true;
                  break;
                }
              }
            }
          }
          if (vis) {
            if (ewJamSfx++ < 2) audio.playUi("ewjam");
            audio.noteCombat(0.3);
          }
        } else if (ev.e === "recon") {
          if (mySlot < 0 || ev.slot === mySlot || allies.has(ev.slot)) {
            audio.playUi("recon");
            hud.ping(ev.x, ev.y);
            if (ev.slot === mySlot || allies.has(ev.slot)) {
              hud.toast("◎ RECON SCAN ACTIVE", true);
            }
          }
        } else if (ev.e === "elim") {
          const mine = ev.slot === mySlot;
          if (mine) {
            if (fpv.active) fpv.exit("dead");
            mySlot = -1;
            prevLowPower = false;
            input.reset();
            hud.setSpectatorMode(true);
            audio.playUi("lose");
          }
          hud.toast(mine ? "you were eliminated!" : `player ${ev.slot} eliminated`, !mine);
        } else if (ev.e === "alert" && ev.slot === mySlot) {
          audio.playUi("alert");
          hud.toast("UNDER ATTACK!");
          hud.ping(ev.x, ev.y);
          input.setLastAlert(ev.x, ev.y);
        } else if (ev.e === "cap") {
          noteCombatPos(ev.x, ev.y, 5.0);
          audio.playUi("cap");
          hud.toast(ev.slot === mySlot ? "BUILDING CAPTURED!" : "a building was captured!", ev.slot !== mySlot);
          hud.ping(ev.x, ev.y);
          input.setLastAlert(ev.x, ev.y);
        } else if (ev.e === "sabotage") {
          noteCombatPos(ev.x, ev.y, 5.0);
          if (ev.vslot === mySlot) {
            audio.playUi("alert");
            hud.toast(`SABOTAGED! An enemy spy infiltrated your ${ev.kind}!`);
            hud.ping(ev.x, ev.y);
            input.setLastAlert(ev.x, ev.y);
          } else if (ev.slot === mySlot) {
            audio.playUi("cap");
            hud.toast(`SABOTAGE COMPLETE — enemy ${ev.kind} hit!`, true);
          } else {
            hud.toast("a spy sabotage op went down!", true);
          }
        } else if (ev.e === "promote" && ev.slot === mySlot) {
          audio.playUi("promote");
          hud.toast(`UNIT PROMOTED ${"★".repeat(Math.min(3, ev.vet))}`, true);
        } else if (ev.e === "crate" && ev.slot === mySlot) {
          audio.playUi("crate");
          hud.toast(ev.text || "SUPPLY CRATE COLLECTED!", true);
        } else if (ev.e === "income" && ev.slot === mySlot) {
          audio.playUi("cash");
        }
      }
      latestState = mySlot >= 0 ? m.players[mySlot] ?? null : null;
      if (mySlot >= 0 && latestState) {
        const curLow = !!latestState.lowPower;
        if (curLow && !prevLowPower) {
          hud.toast("⚡ LOW POWER! Build a Reactor Plant — defenses, radar & superweapon offline!");
          audio.playUi("powerDown");
        } else if (!curLow && prevLowPower) {
          hud.toast("Power restored — systems online", true);
          audio.playUi("powerUp");
        }
        prevLowPower = curLow;
      } else {
        prevLowPower = false;
      }
      if ((!latestState?.swReady || latestState?.lowPower) && input.swArmed) input.disarmSuperweapon();
      if ((!latestState?.reconReady || latestState?.lowPower) && input.reconArmed) input.disarmRecon();
      hud.updateClock(m.tick);
      hud.updateTop(latestState, mySlot < 0 ? m.players : undefined);
      if (mySlot < 0) hud.updateSpecCommanders(matchPlayers, m.players);
      hud.updateRecon(latestState, input.reconArmed);
      hud.updateSuperweapon(latestState, input.swArmed);
      hud.updateSidebar(latestState, has, countOf, currentConfig, gs.hasWater());
      hud.updateSelInfo(input.selection, renderer.tracked, mySlot, latestState, has);
      hud.updateGroups(input.groups, renderer.tracked, mySlot);
      renderer.setGroups(input.groups);
      if (mySlot >= 0) {
        const awaiting = latestState?.awaiting ?? null;
        const awaitingDef = latestState?.awaitingDef ?? null;
        const aKey = awaiting?.join(",") ?? "";
        const dKey = awaitingDef?.join(",") ?? "";
        if (aKey !== prevAwaiting) {
          input.placingCancelled = false;
          if (!input.placing || buildCategoryOf(input.placing) === "structure") input.clearPlacePending();
          if (awaiting?.length) {
            // toast only for a genuinely NEW ready item — a cancel/place shrink must not chime
            const prevList = prevAwaiting ? prevAwaiting.split(",") : [];
            const rest = [...prevList];
            let fresh: BuildingKind | undefined;
            for (const k of awaiting) {
              const i = rest.indexOf(k);
              if (i >= 0) rest.splice(i, 1);
              else fresh ??= k;
            }
            if (fresh) {
              audio.playUi("buildDone");
              hud.toast(`${BUILDING_NAMES[fresh]} READY — click in sidebar or press B to place`, true);
            }
          }
        }
        if (dKey !== prevAwaitingDef) {
          input.placingCancelled = false;
          if (!input.placing || buildCategoryOf(input.placing) === "defense") input.clearPlacePending();
          if (awaitingDef?.length) {
            const prevList = prevAwaitingDef ? prevAwaitingDef.split(",") : [];
            const rest = [...prevList];
            let fresh: BuildingKind | undefined;
            for (const k of awaitingDef) {
              const i = rest.indexOf(k);
              if (i >= 0) rest.splice(i, 1);
              else fresh ??= k;
            }
            if (fresh) {
              audio.playUi("buildDone");
              hud.toast(`${BUILDING_NAMES[fresh]} READY — click in sidebar or press B to place`, true);
            }
          }
        }
        prevAwaiting = aKey;
        prevAwaitingDef = dKey;
        // Classic RA2 flow: NEVER auto-hijack cursor when a structure/defense finishes; player clicks READY or presses B!
        if (input.placing) {
          const cat = buildCategoryOf(input.placing);
          const expected = cat === "defense" ? awaitingDef : awaiting;
          if (!expected?.includes(input.placing)) input.exitPlacing();
        }
      }
      noteMatchSnapshot();
      break;
    }
    case "end": {
      if (fpv.active) fpv.exit("dead");
      phase = "ended";
      // Normally the first snapshot has long since finished the transition;
      // this covers a rare instant end before that first frame and must never
      // leave a dead loading layer above the end screen.
      cancelMatchLoading();
      hud.hideLobbyStarting();
      setAutoCam(false);
      hud.setPauseVisible(false);
      const mine =
        mySlot >= 0 &&
        (m.winner === mySlot || (m.winnerTeam != null && m.winnerTeam > 0 && m.winnerTeam === myTeam));
      const draw = m.winner === null && (m.winnerTeam == null || m.winnerTeam === 0);
      const title = mySlot < 0 ? "MATCH OVER" : mine ? "VICTORY!" : draw ? "DRAW" : "DEFEATED";
      hud.showEnd(title, m.reason, m.stats, m.durationSec);
      hud.toast(m.reason, mine || mySlot < 0);
      if (mySlot >= 0) audio.playUi(mine ? "win" : "lose");
      break;
    }
    case "chat":
      hud.chat(m.name, m.color, m.text);
      break;
    case "ping":
      hud.ping(m.x, m.y);
      input.setLastAlert(m.x, m.y);
      break;
    case "paused":
      hud.setPaused(m.paused);
      hud.toast(m.paused ? "⏸ game paused" : "▶ game resumed", true);
      break;
    case "deny": {
      input.clearPlacePending();
      audio.playUi("deny");
      // Denies are otherwise uncorrelated command responses. Start denies carry
      // an explicit cmd tag so a nearby addbot/slot deny cannot cancel the wrong
      // in-flight request or masquerade as the start result.
      const startDenied = m.cmd === "start";
      const wasStartPending = startPending && startDenied;
      if (startDenied) {
        clearStartPending();
        startClickAt = null;
      }
      if (phase === "lobby") {
        // Lobby denies are the moment the player most needs an explanation
        // ("why didn't START do anything?"). A 2.6s toast is too easy to miss,
        // so surface them as a durable in-panel alert instead; in-game denies
        // keep the lighter toast treatment.
        hud.hideLobbyStarting();
        if (wasStartPending) cancelMatchLoading();
        hud.showLobbyAlert(m.msg, startDenied ? "START BLOCKED" : "ACTION BLOCKED");
      } else {
        hud.toast(m.msg);
      }
      break;
    }
  }
};

net.socket.addEventListener("open", () => {
  if (net.localMode) return;
  hud.setQuotaExceeded(false);
  document.getElementById("solo-local-btn")?.classList.remove("hidden");
  net.send({ t: "join", name, token: joinToken, ...(spectateParam ? { spectate: true } : {}) });
});

// debug/e2e hook
(window as any).__oa = {
  gs,
  renderer,
  input,
  net,
  hud,
  audio,
  fpv,
  get phase() {
    return phase;
  },
  get slot() {
    return mySlot;
  },
  get state() {
    return latestState;
  },
  projectTile(x: number, y: number) {
    const v = new THREE.Vector3(x + 0.5, 0, y + 0.5).project(gs.camera);
    return {
      x: (v.x * 0.5 + 0.5) * canvas.clientWidth,
      y: (-v.y * 0.5 + 0.5) * canvas.clientHeight,
    };
  },
};

// ---------- main loop ----------

let tabVisibleAt = Date.now();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tabVisibleAt = Date.now();
});

gs.engine.runRenderLoop(() => {
  const dt = gs.engine.getDeltaTime() / 1000;
  const preCamX = gs.camTarget.x;
  const preCamZ = gs.camTarget.z;
  input.update(dt);
  if (phase === "playing" && mySlot < 0 && !fpv.active && autoCam) {
    const manualDrag = Math.hypot(preCamX - lastCamX, preCamZ - lastCamZ) > 0.04;
    const manualPan = Math.hypot(gs.camTarget.x - preCamX, gs.camTarget.z - preCamZ) > 0.015;
    if (manualDrag || manualPan) {
      setAutoCam(false);
    } else {
      const watchPanel = document.getElementById("watch-panel");
      const watchOpen = watchPanel && !watchPanel.classList.contains("hidden");
      if (!watchOpen) {
        const now = performance.now();
        if (now >= autoCamNextEval) {
          autoCamNextEval = now + 2000;
          const next = pickAutoCamTarget(now);
          if (next) autoCamGoal = next;
        }
        const lerp = 1 - Math.exp(-Math.min(0.1, dt) * 2.4);
        gs.camTarget.x += (autoCamGoal.x - gs.camTarget.x) * lerp;
        gs.camTarget.z += (autoCamGoal.z - gs.camTarget.z) * lerp;
        gs.updateCamera();
      }
      lastCamX = gs.camTarget.x;
      lastCamZ = gs.camTarget.z;
    }
  } else {
    lastCamX = gs.camTarget.x;
    lastCamZ = gs.camTarget.z;
  }
  renderer.update(dt);
  if (fpv.active) {
    const tel = fpv.update(dt);
    hud.updateFpv(tel);
    story.tick(dt, tel);
    hud.updateFpvStory(story.state);
  }
  hud.tick(dt);
  audio.update(dt);
  if (phase === "playing") {
    // Auto-recover half-open / silent zombie WebSockets during a live 5 Hz match (with 2s Alt-Tab grace)
    const nowMs = Date.now();
    if (!document.hidden && nowMs - tabVisibleAt > 2000 && nowMs - net.lastRecvAt > 6500) {
      net.lastRecvAt = nowMs;
      net.reconnect();
    }
    hud.drawMinimap(
      renderer,
      oreCells,
      gs.camTarget.x,
      gs.camTarget.z,
      gs.camHeight,
      mySlot,
      has("radar"),
      currentMap,
      !!latestState?.lowPower,
    );
    const hp = input.hoverPointer;
    if (!hp) {
      hud.hideHoverTip();
    } else {
      const now = performance.now();
      if (now - lastHoverMs >= 80) {
        lastHoverMs = now;
        if (document.elementFromPoint(hp.x, hp.y) !== canvas) {
          hud.hideHoverTip();
        } else {
          gs.syncPointer(hp.x, hp.y);
          const entId = gs.pickEntity();
          const t = entId != null ? renderer.tracked.get(entId) : null;
          if (t && t.vis.root.visible) {
            hud.showHoverTip(t.last, null, hp.x, hp.y);
          } else {
            const g = gs.pickGround();
            const crate = g ? renderer.pickCrateAt(g.x, g.z) : null;
            if (crate) hud.showHoverTip(null, crate, hp.x, hp.y);
            else hud.hideHoverTip();
          }
        }
      }
    }
  } else {
    hud.hideHoverTip();
  }
  gs.render();
});
window.addEventListener("resize", () => gs.engine.resize());
