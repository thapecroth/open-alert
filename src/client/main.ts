import { Net } from "./net";
import { GameScene } from "./scene";
import { Renderer } from "./render";
import { Input } from "./input";
import { Hud } from "./hud";
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
const name =
  params.get("name") ??
  localStorage.getItem("oa-name") ??
  "Cmdr-" + Math.random().toString(36).slice(2, 6);
localStorage.setItem("oa-name", name);

// ---------- boot ----------

const canvas = el<HTMLCanvasElement>("game");
const gs = new GameScene(canvas);
const renderer = new Renderer(gs);
const hud = new Hud();
const net = new Net(room);

let mySlot = -1;
let myId = "";
let phase: "lobby" | "playing" | "ended" = "lobby";
let latestState: PlayerState | null = null;
const oreCells = new Set<number>();
let prevAwaiting: string | null = null;
let iconColor = "";

hud.setRoom(room);
hud.setStatus("connecting…");

// ---------- placement validity (exact client parity with server canPlace) ----------

function placeReason(tx: number, ty: number, w: number, h: number): string | null {
  if (tx < 0 || ty < 0 || tx + w > MAP_W || ty + h > MAP_H) return "off map";
  for (let y = ty; y < ty + h; y++)
    for (let x = tx; x < tx + w; x++) if (oreCells.has(y * MAP_W + x)) return "can't build on ore";
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
hud.setWasdLabel(input.wasdPan);

function has(kind: string) {
  for (const t of renderer.tracked.values())
    if (t.last.o === mySlot && (t.last.k === kind || (kind === "factory" && t.last.k === "factory2"))) return true;
  return false;
}

// ---------- hud wiring ----------

hud.onReady = (r) => net.send({ t: "ready", ready: r });
hud.onStart = () => net.send({ t: "start" });
hud.onRematch = () => net.send({ t: "rematch" });
hud.onAddBot = () => net.send({ t: "addbot" });
hud.onResign = () => net.send({ t: "resign" });
hud.onChat = (text) => net.send({ t: "chat", text });
hud.onVerb = (v) => {
  if (v === "amove") input.armAmove();
  else if (v === "stop") input.stopNow();
  else input.armVerb(v);
};
hud.onBuild = (kind) => net.send({ t: "build", kind });
hud.onBuildCancel = () => net.send({ t: "buildCancel" });
hud.onPlaceMode = (kind) => {
  input.placingCancelled = false;
  input.enterPlacing(kind);
};
hud.onTrain = (u) => net.send({ t: "train", unit: u });
hud.onTrainCancel = (u) => net.send({ t: "trainCancel", unit: u });
hud.onUpgrade = (id) => net.send({ t: "upgrade", id });
hud.onMinimapPing = (x, y) => net.send({ t: "ping", x, y });
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

input.onOpenChat = () => hud.focusChat();
input.onWasdChange = (on) => hud.setWasdLabel(on);
input.onSelectionChange = (sel) => hud.updateSelInfo(sel, renderer.tracked, mySlot, latestState, has);
input.onGroupsChange = (g) => hud.updateGroups(g, renderer.tracked, mySlot);
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
      if (phase === "ended") {
        phase = "lobby";
        hud.hideEnd();
      }
      if (phase === "lobby") hud.showLobby(m.players, m.you);
      break;
    }
    case "init": {
      myId = m.you;
      mySlot = m.slot;
      phase = "playing";
      prevAwaiting = null;
      latestState = null;
      renderer.reset();
      input.reset();
      gs.clearOre();
      hud.hideLobby();
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
      // Render real 3D model thumbnails for the sidebar (regenerates if slot color changed)
      const color = mySlot >= 0 ? PLAYER_COLORS[mySlot] : "#45d6ff";
      if (iconColor !== color) {
        iconColor = color;
        generateIcons(gs, [...BUILD_ORDER, ...TRAIN_ORDER.map((t) => t.unit)], color).then((icons) =>
          hud.setIcons(icons),
        );
      }
      hud.toast(mySlot >= 0 ? "battle control online — good luck, commander" : "spectating", true);
      break;
    }
    case "snap": {
      if (phase !== "playing") break;
      renderer.pushSnap(m.ents);
      renderer.applyVisibility(mySlot);
      renderer.applyEvents(m.events);
      for (const ev of m.events) {
        if (ev.e === "ore") {
          for (const [x, y, a] of ev.cells) {
            if (a <= 0) oreCells.delete(y * MAP_W + x);
            else oreCells.add(y * MAP_W + x);
          }
        } else if (ev.e === "elim") {
          const mine = ev.slot === mySlot;
          if (mine) {
            mySlot = -1;
            if (input.placing) input.exitPlacing();
          }
          hud.toast(mine ? "you were eliminated!" : `player ${ev.slot} eliminated`, !mine);
        } else if (ev.e === "alert" && ev.slot === mySlot) {
          hud.toast("UNDER ATTACK!");
          hud.ping(ev.x, ev.y);
          input.setLastAlert(ev.x, ev.y);
        } else if (ev.e === "cap") {
          hud.toast(ev.slot === mySlot ? "BUILDING CAPTURED!" : "a building was captured!", ev.slot !== mySlot);
          hud.ping(ev.x, ev.y);
          input.setLastAlert(ev.x, ev.y);
        }
      }
      latestState = mySlot >= 0 ? m.players[mySlot] ?? null : null;
      hud.updateTop(latestState, mySlot < 0 ? m.players : undefined);
      hud.updateSidebar(latestState, has);
      hud.updateSelInfo(input.selection, renderer.tracked, mySlot, latestState, has);
      hud.updateGroups(input.groups, renderer.tracked, mySlot);
      if (mySlot >= 0) {
        const awaiting = latestState?.awaiting ?? null;
        if (awaiting !== prevAwaiting) {
          input.placingCancelled = false;
          input.clearPlacePending();
        }
        prevAwaiting = awaiting;
        if (awaiting && !input.placing && !input.placingCancelled) input.enterPlacing(awaiting);
        if (!awaiting && input.placing) input.exitPlacing();
      }
      break;
    }
    case "end": {
      phase = "ended";
      const mine = m.winner === mySlot;
      hud.showEnd(mine ? "VICTORY!" : m.winner === null ? "DRAW" : "DEFEATED");
      hud.toast(m.reason, mine);
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
  if (phase === "playing")
    hud.drawMinimap(renderer, oreCells, gs.camTarget.x, gs.camTarget.z, gs.camHeight, mySlot, has("radar"));
  gs.render();
});
window.addEventListener("resize", () => gs.engine.resize());
