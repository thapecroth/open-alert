import { Net } from "./net";
import { GameScene } from "./scene";
import { Renderer } from "./render";
import { Input } from "./input";
import { Hud, type GraphicsBridge } from "./hud";
import { AudioEngine } from "./audio";
import { FirstPersonController } from "./fpv";
import { generateIcons } from "./icons";
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
  BuildingKind,
  EntKind,
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

const unlockAudio = () => {
  audio.unlock();
};
window.addEventListener("pointerdown", unlockAudio, { passive: true });
window.addEventListener("keydown", unlockAudio, { passive: true });

let mySlot = -1;
let myTeam = 0;
let myId = "";
let phase: "lobby" | "playing" | "ended" = "lobby";
let currentMap: MapId = "crossroads";
let currentConfig: GameConfig = { ...DEFAULT_CONFIG };
let latestState: PlayerState | null = null;
const oreCells = new Set<number>();
const allies = new Set<number>();
let prevAwaiting: BuildingKind | null = null;
let prevAwaitingDef: BuildingKind | null = null;
let prevLowPower = false;
let iconColor = "";
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
    }
  const maxGap = bdef?.forwardRange ?? (waterOnly ? SHIPYARD_BUILD_DIST : 2);
  let adj = false;
  for (const t of renderer.tracked.values()) {
    if (!isBuildingKind(t.last.k)) {
      const ux = Math.floor(t.last.x),
        uy = Math.floor(t.last.y);
      if (ux >= tx && ux < tx + w && uy >= ty && uy < ty + h) return "units in the way";
      continue;
    }
    const d = BUILDINGS[t.last.k];
    const bx = Math.round(t.last.x - d.w / 2),
      by = Math.round(t.last.y - d.h / 2);
    if (tx < bx + d.w && tx + w > bx && ty < by + d.h && ty + h > by) return "blocked by structure";
    if (t.last.o === mySlot) {
      const gapX = Math.max(bx - (tx + w), tx - (bx + d.w));
      const gapY = Math.max(by - (ty + h), ty - (by + d.h));
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
  if (k === "dreadnought" || k === "himars" || k === "carrier") return "missile";
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
const fpv = new FirstPersonController(gs, renderer, net, () => mySlot, isAlly);
hud.setWasdLabel(input.wasdPan);

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
  audio.playUi("select");
}

fpv.onExit = (reason) => {
  input.enabled = true;
  hud.setFpvMode(false, mySlot < 0);
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

function has(kind: string) {
  const mk2 = UPGRADED_ALIAS[kind];
  for (const t of renderer.tracked.values())
    if (t.last.o === mySlot && (t.last.k === kind || (mk2 !== undefined && t.last.k === mk2))) return true;
  return false;
}

function countOf(kind: BuildingKind) {
  let n = 0;
  for (const t of renderer.tracked.values()) if (t.last.o === mySlot && t.last.k === kind) n++;
  return n;
}

// ---------- hud wiring ----------

hud.onReady = (r) => net.send({ t: "ready", ready: r });
hud.onStart = () => net.send({ t: "start" });
hud.onRematch = () => net.send({ t: "rematch" });
hud.onAddBot = (diff, profile) => net.send({ t: "addbot", diff, profile });
hud.onSetBotConfig = (id, diff, profile) => net.send({ t: "setBotConfig", id, diff, profile });
hud.onKickBot = (id) => net.send({ t: "kickbot", id });
hud.onSetMap = (map) => net.send({ t: "setMap", map });
hud.onSetConfig = (config) => net.send({ t: "setConfig", config });
hud.onSetTeam = (team, id) => net.send({ t: "setTeam", team, ...(id ? { id } : {}) });
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
  else input.armVerb(v);
};
hud.onBuild = (kind) => {
  net.send({ t: "build", kind });
  audio.playUi("buildStart");
};
hud.onBuildCancel = (cat) => {
  if (input.placing && (!cat || buildCategoryOf(input.placing) === cat)) {
    input.exitPlacing();
  }
  net.send(cat ? { t: "buildCancel", cat } : { t: "buildCancel" });
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
hud.onTrainCancel = (u) => {
  net.send({ t: "trainCancel", unit: u });
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
  const aw = latestState?.awaiting ?? null;
  const awDef = latestState?.awaitingDef ?? null;
  if (!aw && !awDef) return;
  if (aw && awDef) {
    const next = input.placing === aw ? awDef : aw;
    input.placingCancelled = false;
    input.enterPlacing(next);
    audio.playUi("select");
    return;
  }
  const only = (aw ?? awDef)!;
  if (input.placing === only) input.exitPlacing();
  else {
    input.placingCancelled = false;
    input.enterPlacing(only);
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
        setAutoCam(false);
        renderer.reset();
        input.reset();
        hud.resetMatch();
        hud.hideEnd();
        hud.toast("Server updated / room reset — returned to lobby", true);
      }
      if (phase === "lobby") hud.showLobby(m.players, m.you, currentMap, currentConfig);
      break;
    }
    case "init": {
      if (fpv.active) fpv.exit("dead");
      myId = m.you;
      mySlot = m.slot;
      matchPlayers = m.players;
      combatEvents.length = 0;
      currentMap = m.map ?? "crossroads";
      currentConfig = m.config ? { ...DEFAULT_CONFIG, ...m.config } : { ...DEFAULT_CONFIG };
      phase = "playing";
      prevAwaiting = null;
      prevAwaitingDef = null;
      prevLowPower = false;
      latestState = null;
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
      // Render real 3D model thumbnails for sidebar + selection panel (incl. all upgrades, defenses & coalmine)
      const color = mySlot >= 0 ? PLAYER_COLORS[mySlot] : "#45d6ff";
      if (iconColor !== color) {
        iconColor = color;
        generateIcons(
          gs,
          [
            "conyard",
            "barracks2",
            "factory2",
            "airfield2",
            "shipyard2",
            "derrick",
            "coalmine",
            ...BUILD_ORDER,
            ...DEFENSE_ORDER,
            ...TRAIN_ORDER.map((t) => t.unit),
          ],
          color,
        ).then((icons) => hud.setIcons(icons));
      }
      hud.toast(mySlot >= 0 ? "battle control online — good luck, commander" : "spectating", true);
      break;
    }
    case "snap": {
      if (phase !== "playing") break;
      renderer.pushSnap(m.ents, m.crates);
      renderer.setPlayerPower(m.players);
      renderer.applyVisibility(currentConfig.fog ? mySlot : -1, allies);
      renderer.applyEvents(m.events, mySlot);
      let shotSfx = 0;
      let boomSfx = 0;
      let ewJamSfx = 0;
      const evNow = performance.now();
      const noteCombatPos = (x: number, y: number, w: number) => {
        if (mySlot >= 0) return;
        combatEvents.push({ x, y, w, t: evNow });
        if (combatEvents.length > 80) combatEvents.splice(0, combatEvents.length - 80);
      };
      for (const ev of m.events) {
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
          hud.toast("⚡ ORBITAL ION CANNON FIRED!", ev.slot === mySlot);
          hud.ping(ev.x, ev.y);
          input.setLastAlert(ev.x, ev.y);
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
      if (mySlot >= 0) {
        const awaiting = latestState?.awaiting ?? null;
        const awaitingDef = latestState?.awaitingDef ?? null;
        if (awaiting !== prevAwaiting) {
          input.placingCancelled = false;
          if (!input.placing || buildCategoryOf(input.placing) === "structure") input.clearPlacePending();
          if (awaiting) {
            audio.playUi("buildDone");
            hud.toast(`${BUILDING_NAMES[awaiting]} READY — click in sidebar or press B to place`, true);
          }
        }
        if (awaitingDef !== prevAwaitingDef) {
          input.placingCancelled = false;
          if (!input.placing || buildCategoryOf(input.placing) === "defense") input.clearPlacePending();
          if (awaitingDef) {
            audio.playUi("buildDone");
            hud.toast(`${BUILDING_NAMES[awaitingDef]} READY — click in sidebar or press B to place`, true);
          }
        }
        prevAwaiting = awaiting;
        prevAwaitingDef = awaitingDef;
        // Classic RA2 flow: NEVER auto-hijack cursor when a structure/defense finishes; player clicks READY or presses B!
        if (input.placing) {
          const cat = buildCategoryOf(input.placing);
          const expected = cat === "defense" ? awaitingDef : awaiting;
          if (expected !== input.placing) input.exitPlacing();
        }
      }
      break;
    }
    case "end": {
      if (fpv.active) fpv.exit("dead");
      phase = "ended";
      setAutoCam(false);
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
    case "deny":
      input.clearPlacePending();
      audio.playUi("deny");
      hud.toast(m.msg);
      break;
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
