import { Net } from "./net";
import { GameScene } from "./scene";
import { Renderer } from "./render";
import { Input } from "./input";
import { Hud } from "./hud";
import { AudioEngine } from "./audio";
import { generateIcons } from "./icons";
import { isBuildingKind, el } from "./util";
import * as THREE from "three";
import {
  MAP_W,
  MAP_H,
  BUILDINGS,
  PLAYER_COLORS,
  SPAWNS,
  BUILD_ORDER,
  TRAIN_ORDER,
  DEFAULT_CONFIG,
  BuildingKind,
  MapId,
  GameConfig,
} from "../shared/gamedefs";
import type { S2C, PlayerState } from "../shared/protocol";

// ---------- identity & room ----------

const params = new URLSearchParams(location.search);
let room = params.get("room") ?? "";
if (!/^[a-z0-9-]{2,32}$/i.test(room)) {
  room = Math.random().toString(36).slice(2, 8);
}
history.replaceState(null, "", `?room=${room}`);

let token = localStorage.getItem("oa-token");
if (!token) {
  token = crypto.randomUUID();
  localStorage.setItem("oa-token", token);
}
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
let prevAwaiting: string | null = null;
let iconColor = "";
let lastTrainSfx = 0;
let lastHoverMs = 0;

hud.setRoom(room);
hud.setStatus("connecting…");
hud.setInitialName(name);
hud.setAudioState(audio.muted, audio.musicOn);

// ---------- placement validity (exact client parity with server canPlace) ----------

function placeReason(tx: number, ty: number, w: number, h: number): string | null {
  if (tx < 0 || ty < 0 || tx + w > MAP_W || ty + h > MAP_H) return "off map";
  for (let y = ty; y < ty + h; y++)
    for (let x = tx; x < tx + w; x++) {
      if (gs.isCliff(x, y)) return "blocked by terrain";
      if (oreCells.has(y * MAP_W + x)) return "can't build on ore";
    }
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
      if (Math.max(gapX, gapY) <= 2) adj = true;
    }
  }
  return adj ? null : "too far from your base";
}

const oreAt = (x: number, y: number) => oreCells.has(y * MAP_W + x);

const input = new Input(gs, renderer, net, () => mySlot, placeReason, oreAt);
input.isAlly = (slot) => allies.has(slot);
hud.setWasdLabel(input.wasdPan);

function has(kind: string) {
  for (const t of renderer.tracked.values())
    if (t.last.o === mySlot && (t.last.k === kind || (kind === "factory" && t.last.k === "factory2"))) return true;
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
hud.onBuildCancel = () => net.send({ t: "buildCancel" });
hud.onPlaceMode = (kind) => {
  input.placingCancelled = false;
  input.enterPlacing(kind);
};
hud.onTrain = (u) => {
  net.send({ t: "train", unit: u });
  const now = performance.now();
  if (now - lastTrainSfx > 60) {
    lastTrainSfx = now;
    audio.playUi("buildStart");
  }
};
hud.onTrainCancel = (u) => net.send({ t: "trainCancel", unit: u });
hud.onUpgrade = (id) => {
  net.send({ t: "upgrade", id });
  audio.playUi("upgrade");
};
hud.onSuperweaponClick = () => {
  if (latestState?.swReady) input.armSuperweapon();
};
hud.onReconClick = () => {
  if (latestState?.reconReady && !latestState.lowPower) input.armRecon();
};
hud.onMinimapPing = (x, y) => net.send({ t: "ping", x, y });
hud.onMinimapOrder = (x, y, shift) => input.issueMinimapOrder(x, y, shift);
hud.onMinimapNav = (x, y) => {
  gs.camTarget.x = Math.max(-2, Math.min(MAP_W + 2, x));
  gs.camTarget.z = Math.max(-2, Math.min(MAP_H + 2, y));
  gs.updateCamera();
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

net.onStatus = (s) => hud.setStatus(s);
net.onMsg = (m: S2C) => {
  switch (m.t) {
    case "lobby": {
      myId = m.you;
      currentMap = m.map ?? "crossroads";
      if (m.config) currentConfig = { ...DEFAULT_CONFIG, ...m.config };
      if (phase === "ended") {
        phase = "lobby";
        hud.hideEnd();
      }
      if (phase === "lobby") hud.showLobby(m.players, m.you, currentMap, currentConfig);
      break;
    }
    case "init": {
      myId = m.you;
      mySlot = m.slot;
      currentMap = m.map ?? "crossroads";
      currentConfig = m.config ? { ...DEFAULT_CONFIG, ...m.config } : { ...DEFAULT_CONFIG };
      phase = "playing";
      prevAwaiting = null;
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
      hud.clearChat();
      hud.hideLobby(mySlot < 0);
      hud.hideEnd();
      renderer.slotColors.clear();
      for (const p of m.players) renderer.slotColors.set(p.slot, PLAYER_COLORS[p.slot]);
      oreCells.clear();
      gs.setOreCells(m.ore);
      for (const [x, y, a] of m.ore) if (a > 0) oreCells.add(y * MAP_W + x);
      if (mySlot >= 0) {
        const s = SPAWNS[mySlot];
        gs.camTarget.set(s.x + 2, 0, s.y + 3);
        gs.updateCamera();
      } else {
        gs.camTarget.set(MAP_W / 2, 0, MAP_H / 2);
        gs.updateCamera();
      }
      // Render real 3D model thumbnails for sidebar + selection panel (incl. conyard, factory2 & derrick)
      const color = mySlot >= 0 ? PLAYER_COLORS[mySlot] : "#45d6ff";
      if (iconColor !== color) {
        iconColor = color;
        generateIcons(gs, ["conyard", "factory2", "derrick", ...BUILD_ORDER, ...TRAIN_ORDER.map((t) => t.unit)], color).then(
          (icons) => hud.setIcons(icons),
        );
      }
      hud.toast(mySlot >= 0 ? "battle control online — good luck, commander" : "spectating", true);
      break;
    }
    case "snap": {
      if (phase !== "playing") break;
      renderer.pushSnap(m.ents, m.crates);
      renderer.applyVisibility(currentConfig.fog ? mySlot : -1, allies);
      renderer.applyEvents(m.events, mySlot);
      let shotSfx = 0;
      let boomSfx = 0;
      for (const ev of m.events) {
        if (ev.e === "ore") {
          for (const [x, y, a] of ev.cells) {
            if (a <= 0) oreCells.delete(y * MAP_W + x);
            else oreCells.add(y * MAP_W + x);
          }
        } else if (ev.e === "shot") {
          const vis = mySlot < 0 || ev.src == null || renderer.isVisible(ev.src);
          if (vis) {
            if (shotSfx++ < 3) audio.playShot(ev.w, ev.vet);
            audio.noteCombat(0.25);
          }
        } else if (ev.e === "boom") {
          if (boomSfx++ < 2) audio.playBoom(ev.r);
          audio.noteCombat(0.5);
        } else if (ev.e === "superweapon") {
          audio.playSuperweapon();
          audio.noteCombat(1.0);
          hud.toast("⚡ ORBITAL ION CANNON FIRED!", ev.slot === mySlot);
          hud.ping(ev.x, ev.y);
          input.setLastAlert(ev.x, ev.y);
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
            mySlot = -1;
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
      if (!latestState?.swReady && input.swArmed) input.disarmSuperweapon();
      if ((!latestState?.reconReady || latestState?.lowPower) && input.reconArmed) input.disarmRecon();
      hud.updateClock(m.tick);
      hud.updateTop(latestState, mySlot < 0 ? m.players : undefined);
      hud.updateRecon(latestState, input.reconArmed);
      hud.updateSuperweapon(latestState, input.swArmed);
      hud.updateSidebar(latestState, has, countOf, currentConfig);
      hud.updateSelInfo(input.selection, renderer.tracked, mySlot, latestState, has);
      hud.updateGroups(input.groups, renderer.tracked, mySlot);
      if (mySlot >= 0) {
        const awaiting = latestState?.awaiting ?? null;
        if (awaiting !== prevAwaiting) {
          input.placingCancelled = false;
          input.clearPlacePending();
          if (awaiting) audio.playUi("buildDone");
        }
        prevAwaiting = awaiting;
        if (awaiting && !input.placing && !input.placingCancelled) input.enterPlacing(awaiting);
        if (!awaiting && input.placing) input.exitPlacing();
      }
      break;
    }
    case "end": {
      phase = "ended";
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
  net.send({ t: "join", name, token });
});

// debug/e2e hook
(window as any).__oa = {
  gs,
  renderer,
  input,
  net,
  hud,
  audio,
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

gs.engine.runRenderLoop(() => {
  const dt = gs.engine.getDeltaTime() / 1000;
  input.update(dt);
  renderer.update(dt);
  hud.tick(dt);
  audio.update(dt);
  if (phase === "playing") {
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
