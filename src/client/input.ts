import * as THREE from "three";
import { BUILDINGS, BuildingKind, MAP_W, MAP_H, SPAWNS } from "../shared/gamedefs";
import type { OrderKind } from "../shared/protocol";
import { GameScene } from "./scene";
import { Renderer } from "./render";
import { Net } from "./net";
import { makePlacementGhost, setGhostColor } from "./models";
import { isBuildingKind } from "./util";

export class Input {
  selection = new Set<number>();
  groups = new Map<number, Set<number>>(); // control groups 1..9
  placing: BuildingKind | null = null;
  placingCancelled = false;
  placePending = false;
  verb: "sell" | "repair" | null = null;
  swArmed = false;
  reconArmed = false;
  wasdPan = localStorage.getItem("oa-wasd") === "1";

  onSelectionChange: (ids: Set<number>) => void = () => {};
  onGroupsChange: (groups: Map<number, Set<number>>) => void = () => {};
  onOrderLabel: (text: string | null, x?: number, y?: number) => void = () => {};
  onOpenChat: () => void = () => {};
  onEnterFpv: () => void = () => {};
  onWasdChange: (on: boolean) => void = () => {};
  onSuperweaponArmedChange: (armed: boolean) => void = () => {};
  onReconArmedChange: (armed: boolean) => void = () => {};
  onUiSound: (kind: "select" | "move" | "attack" | "place" | "deny" | "recon" | "hold") => void = () => {};
  isAlly: (slot: number) => boolean = () => false;

  private _enabled = true;
  private gs: GameScene;
  private r: Renderer;
  private net: Net;
  private getSlot: () => number;
  private keys = new Set<string>();
  private dragStart: { x: number; y: number; shift: boolean } | null = null;
  private selBox: HTMLDivElement | null = null;
  private middleDrag: { x: number; y: number } | null = null;
  private yawDrag: { x: number } | null = null;
  private pointerInside = false;
  private px = -1;
  private py = -1;
  private ghost: THREE.Mesh | null = null;
  private ghostOk = false;
  private ghostReason: string | null = null;
  private placePendingTimer: ReturnType<typeof setTimeout> | null = null;
  private amoveNext = false;
  private patrolNext = false;
  private lastClickTime = 0;
  private lastClickId = -1;
  private lastGroupTap = { num: -1, time: 0 };
  private lastAlertPos: { x: number; y: number } | null = null;
  private harvCycle = 0;
  private prodCycle = 0;
  private panVx = 0;
  private panVz = 0;
  private labelTimer: ReturnType<typeof setTimeout> | null = null;

  private placeReason: (tx: number, ty: number, w: number, h: number, kind?: BuildingKind) => string | null;
  private oreAt: (x: number, y: number) => boolean;

  constructor(
    gs: GameScene,
    r: Renderer,
    net: Net,
    getSlot: () => number,
    placeReason: (tx: number, ty: number, w: number, h: number, kind?: BuildingKind) => string | null,
    oreAt: (x: number, y: number) => boolean,
  ) {
    this.gs = gs;
    this.r = r;
    this.net = net;
    this.getSlot = getSlot;
    this.placeReason = placeReason;
    this.oreAt = oreAt;

    const canvas = gs.engine.getRenderingCanvas()!;
    canvas.addEventListener("pointerenter", () => (this.pointerInside = true));
    canvas.addEventListener("pointerleave", () => (this.pointerInside = false));
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    window.addEventListener("pointerup", (e) => this.onUp(e));
    window.addEventListener("pointermove", (e) => {
      this.px = e.clientX;
      this.py = e.clientY;
      this.onMove(e);
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this._enabled) return;
        e.preventDefault();
        gs.zoom(e.deltaY * 0.02);
      },
      { passive: false },
    );
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.middleDrag = null;
      this.yawDrag = null;
    });
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(v: boolean) {
    this._enabled = v;
    if (!v) {
      this.keys.clear();
      this.dragStart = null;
      this.middleDrag = null;
      this.yawDrag = null;
      this.panVx = 0;
      this.panVz = 0;
      if (this.selBox) {
        this.selBox.remove();
        this.selBox = null;
      }
    }
  }

  get hoverPointer(): { x: number; y: number } | null {
    if (
      !this._enabled ||
      !this.pointerInside ||
      this.placing ||
      this.dragStart ||
      this.middleDrag ||
      this.yawDrag ||
      this.px < 0 ||
      this.py < 0
    ) {
      return null;
    }
    return { x: this.px, y: this.py };
  }

  reset() {
    this.exitPlacing();
    this.clearPlacePending();
    this.placingCancelled = false;
    this.disarmSuperweapon();
    this.disarmRecon();
    this.setAmove(false);
    this.setPatrol(false);
    this.armVerb(null);
    this.yawDrag = null;
    this.selection = new Set();
    this.groups.clear();
    this.lastAlertPos = null;
    this.keys.clear();
    this.r.setSelected(this.selection);
    this.onSelectionChange(this.selection);
    this.onGroupsChange(this.groups);
  }

  setLastAlert(x: number, y: number) {
    this.lastAlertPos = { x, y };
  }

  setWasdPan(on: boolean) {
    this.wasdPan = on;
    localStorage.setItem("oa-wasd", on ? "1" : "0");
    this.onWasdChange(on);
  }

  clearPlacePending() {
    this.placePending = false;
    if (this.placePendingTimer) {
      clearTimeout(this.placePendingTimer);
      this.placePendingTimer = null;
    }
  }

  private flashLabel(text: string, ms = 900) {
    if (this.labelTimer) clearTimeout(this.labelTimer);
    this.onOrderLabel(text, Math.max(20, this.px + 12), Math.max(50, this.py - 12));
    this.labelTimer = setTimeout(() => this.onOrderLabel(null), ms);
  }

  private onKeyDown(e: KeyboardEvent) {
    if (!this._enabled) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (e.code === "Escape") (e.target as HTMLElement).blur();
      return;
    }

    // Enter focuses chat directly
    if (e.code === "Enter") {
      e.preventDefault();
      this.onOpenChat();
      return;
    }

    // E enters First-Person POV when a single owned unit is selected
    if (e.code === "KeyE" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.selection.size === 1) {
        const singleId = [...this.selection][0];
        const t = this.r.tracked.get(singleId);
        if (t && t.last.o === this.getSlot() && !isBuildingKind(t.last.k)) {
          e.preventDefault();
          this.onEnterFpv();
          return;
        }
      }
    }

    this.keys.add(e.code);

    // Prevent page scroll on Space / Arrow keys / Tab
    if (e.code === "Space" || e.code === "Tab" || e.code.startsWith("Arrow")) {
      e.preventDefault();
    }

    // Control groups: Ctrl+1..9 assign, 1..9 recall (double-tap centers), Shift+4 ($) = Sell
    if (/^Digit[1-9]$/.test(e.code)) {
      const n = Number(e.code.slice(5));
      if (e.shiftKey && n === 4 && !e.ctrlKey && !e.metaKey) {
        this.armVerb("sell");
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.assignGroup(n);
        return;
      }
      this.recallGroup(n, e.shiftKey);
      return;
    }

    // Attack-Move & Stop (respects WASD camera mode)
    if (this.wasdPan) {
      if (e.code === "KeyF") this.armAmove();
      if (e.code === "KeyX") this.stopSelected();
    } else {
      if (e.code === "KeyA") this.armAmove();
      if (e.code === "KeyS") this.stopSelected();
      if (e.code === "KeyX") this.scatterSelected();
    }

    if (e.code === "KeyP") this.armPatrol();
    if (e.code === "KeyG") this.holdSelected();
    if (e.code === "KeyV") this.armVerb("sell");
    if (e.code === "KeyR") this.armVerb("repair");
    if (e.code === "KeyH" || e.code === "Home") this.jumpToBase();
    if (e.code === "Space") this.jumpToAlertOrBase();
    if (e.code === "KeyC") this.centerOnSelection();
    if (e.code === "KeyQ") this.selectAllCombat();
    if (e.code === "F1") {
      e.preventDefault();
      this.selectNextHarvester();
    }
    if (e.code === "Tab") this.cycleProductionBuilding();
    if (e.code === "Equal" || e.code === "NumpadAdd") this.gs.zoom(-3);
    if (e.code === "Minus" || e.code === "NumpadSubtract") this.gs.zoom(3);
    if (e.code === "BracketLeft") {
      this.rotateCamYaw(-0.18);
      this.flashLabel("CAMERA CCW", 600);
    }
    if (e.code === "BracketRight") {
      this.rotateCamYaw(0.18);
      this.flashLabel("CAMERA CW", 600);
    }
    if (e.code === "Backslash") {
      this.resetCamYaw();
      this.flashLabel("CAMERA NORTH-UP", 700);
    }

    if (e.code === "Escape") {
      const help = document.getElementById("help");
      if (help && !help.classList.contains("hidden")) {
        help.classList.add("hidden");
        return;
      }
      if (this.swArmed) {
        this.disarmSuperweapon();
        return;
      }
      if (this.reconArmed) {
        this.disarmRecon();
        return;
      }
      this.setAmove(false);
      this.setPatrol(false);
      this.armVerb(null);
      if (this.placing) {
        this.cancelPlacing();
      } else if (this.selection.size) {
        this.setSelection(new Set());
      }
    }
  }

  private rotateCamYaw(deltaRad: number) {
    this.gs.rotateYaw(deltaRad);
  }

  private resetCamYaw() {
    this.gs.resetYaw();
  }

  private setAmove(on: boolean) {
    this.amoveNext = on;
    document.getElementById("verb-amove")?.classList.toggle("armed", on);
  }

  private setPatrol(on: boolean) {
    this.patrolNext = on;
    document.getElementById("verb-patrol")?.classList.toggle("armed", on);
  }

  private setSelection(sel: Set<number>) {
    this.selection = sel;
    if (this.amoveNext) this.setAmove(false);
    if (this.patrolNext) this.setPatrol(false);
    this.r.setSelected(this.selection);
    this.onSelectionChange(this.selection);
    if (sel.size > 0) this.onUiSound("select");
  }

  hasSelectedUnits(): boolean {
    return this.myUnits().length > 0;
  }

  armSuperweapon() {
    if (this.placing) return;
    if (this.swArmed) {
      this.disarmSuperweapon();
      return;
    }
    this.disarmRecon();
    this.setAmove(false);
    this.setPatrol(false);
    this.armVerb(null);
    this.swArmed = true;
    if (this.labelTimer) clearTimeout(this.labelTimer);
    this.onOrderLabel(
      "ION CANNON ARMED — LEFT-CLICK TARGET (RIGHT-CLICK / ESC TO CANCEL)",
      Math.max(20, this.px + 12),
      Math.max(50, this.py - 12),
    );
    this.onSuperweaponArmedChange(true);
    this.onUiSound("select");
  }

  disarmSuperweapon() {
    if (!this.swArmed) return;
    this.swArmed = false;
    if (this.labelTimer) clearTimeout(this.labelTimer);
    this.onOrderLabel(null);
    this.onSuperweaponArmedChange(false);
  }

  armRecon() {
    if (this.placing) return;
    if (this.reconArmed) {
      this.disarmRecon();
      return;
    }
    this.disarmSuperweapon();
    this.setAmove(false);
    this.setPatrol(false);
    this.armVerb(null);
    this.reconArmed = true;
    if (this.labelTimer) clearTimeout(this.labelTimer);
    this.onOrderLabel(
      "RECON SCAN ARMED — LEFT-CLICK TARGET (RIGHT-CLICK / ESC TO CANCEL)",
      Math.max(20, this.px + 12),
      Math.max(50, this.py - 12),
    );
    this.onReconArmedChange(true);
    this.onUiSound("select");
  }

  disarmRecon() {
    if (!this.reconArmed) return;
    this.reconArmed = false;
    if (this.labelTimer) clearTimeout(this.labelTimer);
    this.onOrderLabel(null);
    this.onReconArmedChange(false);
  }

  private myUnits(): number[] {
    const slot = this.getSlot();
    return [...this.selection].filter((id) => {
      const t = this.r.tracked.get(id);
      return t && t.last.o === slot && !isBuildingKind(t.last.k);
    });
  }

  // ---------- Control groups & quick-select hotkeys ----------

  assignGroup(n: number) {
    const slot = this.getSlot();
    const valid = new Set([...this.selection].filter((id) => this.r.tracked.get(id)?.last.o === slot));
    if (valid.size) {
      this.groups.set(n, valid);
      this.flashLabel(`GROUP ${n} (${valid.size})`, 800);
    } else {
      this.groups.delete(n);
    }
    this.onGroupsChange(this.groups);
  }

  recallGroup(n: number, add = false) {
    const g = this.groups.get(n);
    if (!g) return;
    const slot = this.getSlot();
    const alive = new Set([...g].filter((id) => this.r.tracked.get(id)?.last.o === slot));
    if (!alive.size) {
      this.groups.delete(n);
      this.onGroupsChange(this.groups);
      return;
    }
    this.groups.set(n, alive);
    const next = add ? new Set([...this.selection, ...alive]) : alive;
    this.setSelection(next);
    const now = performance.now();
    if (this.lastGroupTap.num === n && now - this.lastGroupTap.time < 420) {
      this.centerOnSelection();
    }
    this.lastGroupTap = { num: n, time: now };
  }

  private selectAllCombat() {
    const slot = this.getSlot();
    if (slot < 0) return;
    const sel = new Set<number>();
    for (const [id, t] of this.r.tracked) {
      if (t.last.o === slot && !isBuildingKind(t.last.k) && t.last.k !== "harvester") sel.add(id);
    }
    if (sel.size) {
      this.setSelection(sel);
      this.flashLabel(`ALL COMBAT (${sel.size})`, 800);
    }
  }

  private selectNextHarvester() {
    const slot = this.getSlot();
    if (slot < 0) return;
    const harvs = [...this.r.tracked.values()].filter((t) => t.last.o === slot && t.last.k === "harvester");
    if (!harvs.length) return;
    const pick = harvs[this.harvCycle++ % harvs.length];
    this.setSelection(new Set([pick.last.id]));
    this.centerOn(pick.last.x, pick.last.y);
    this.flashLabel("HARVESTER", 700);
  }

  private cycleProductionBuilding() {
    const slot = this.getSlot();
    if (slot < 0) return;
    const prods = [...this.r.tracked.values()].filter(
      (t) =>
        t.last.o === slot &&
        (t.last.k === "conyard" ||
          t.last.k === "barracks" ||
          t.last.k === "factory" ||
          t.last.k === "factory2" ||
          t.last.k === "airfield" ||
          t.last.k === "shipyard"),
    );
    if (!prods.length) return;
    const pick = prods[this.prodCycle++ % prods.length];
    this.setSelection(new Set([pick.last.id]));
    this.centerOn(pick.last.x, pick.last.y);
  }

  private jumpToBase() {
    const slot = this.getSlot();
    if (slot < 0) return;
    for (const t of this.r.tracked.values()) {
      if (t.last.o === slot && t.last.k === "conyard") {
        this.centerOn(t.last.x, t.last.y);
        return;
      }
    }
    const s = SPAWNS[slot];
    if (s) this.centerOn(s.x + 1.5, s.y + 1.5);
  }

  private jumpToAlertOrBase() {
    if (this.lastAlertPos) {
      this.centerOn(this.lastAlertPos.x, this.lastAlertPos.y);
    } else {
      this.jumpToBase();
    }
  }

  centerOnSelection() {
    if (!this.selection.size) return;
    let sx = 0,
      sy = 0,
      n = 0;
    for (const id of this.selection) {
      const t = this.r.tracked.get(id);
      if (!t) continue;
      sx += t.last.x;
      sy += t.last.y;
      n++;
    }
    if (n) this.centerOn(sx / n, sy / n);
  }

  private centerOn(x: number, y: number) {
    this.gs.camTarget.x = Math.max(-2, Math.min(MAP_W + 2, x));
    this.gs.camTarget.z = Math.max(-2, Math.min(MAP_H + 2, y));
    this.gs.updateCamera();
  }

  private scatterSelected() {
    const ids = this.myUnits();
    if (!ids.length) return;
    let cx = 0,
      cy = 0;
    for (const id of ids) {
      const t = this.r.tracked.get(id);
      if (t) {
        cx += t.last.x;
        cy += t.last.y;
      }
    }
    cx /= ids.length;
    cy /= ids.length;
    for (const [i, id] of ids.entries()) {
      const t = this.r.tracked.get(id);
      if (!t) continue;
      let dx = t.last.x - cx;
      let dy = t.last.y - cy;
      if (Math.hypot(dx, dy) < 0.15) {
        const ang = (i / Math.max(1, ids.length)) * Math.PI * 2;
        dx = Math.cos(ang);
        dy = Math.sin(ang);
      }
      const len = Math.hypot(dx, dy) || 1;
      const tx = Math.max(1, Math.min(MAP_W - 1, t.last.x + (dx / len) * 2.6));
      const ty = Math.max(1, Math.min(MAP_H - 1, t.last.y + (dy / len) * 2.6));
      this.net.send({ t: "order", ids: [id], kind: "move", x: tx, y: ty });
    }
    this.flashLabel("SCATTER", 700);
    this.onUiSound("move");
  }

  // ---------- Pointer interactions ----------

  private onDown(e: PointerEvent) {
    if (!this._enabled) return;
    this.px = e.clientX;
    this.py = e.clientY;
    this.gs.syncPointer(e.clientX, e.clientY);

    if (e.altKey && (e.button === 0 || e.button === 1) && !this.placing && !this.swArmed && !this.reconArmed && !this.verb) {
      this.yawDrag = { x: e.clientX };
      e.preventDefault();
      return;
    }
    if (e.button === 1) {
      this.middleDrag = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }
    if (this.swArmed) {
      if (e.button === 0) {
        const ground = this.gs.pickGround();
        if (ground) {
          this.net.send({ t: "superweapon", x: ground.x, y: ground.z });
          this.disarmSuperweapon();
          this.orderMarker(ground, "amove", false, 0x4ad8ff);
          this.flashLabel("ORBITAL STRIKE INBOUND!", 1600);
          this.onUiSound("attack");
        }
      } else {
        this.disarmSuperweapon();
      }
      return;
    }
    if (this.reconArmed) {
      if (e.button === 0) {
        const ground = this.gs.pickGround();
        if (ground) {
          this.net.send({ t: "recon", x: ground.x, y: ground.z });
          this.disarmRecon();
          this.orderMarker(ground, "move", false, 0x4ad8ff);
          this.flashLabel("RECON SCAN DEPLOYED", 1300);
          this.onUiSound("recon");
        }
      } else {
        this.disarmRecon();
      }
      return;
    }
    if (this.placing) {
      if (e.button === 0) this.tryPlace();
      else this.cancelPlacing();
      return;
    }
    if (e.button === 0) {
      if (this.verb) {
        this.useVerb();
        return;
      }
      if ((this.amoveNext || this.patrolNext) && this.myUnits().length) {
        // Classic RTS: A/P + Left-Click executes Attack-Move / Patrol!
        this.issueOrder(e.shiftKey);
        return;
      }
      this.dragStart = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    } else if (e.button === 2) {
      if (this.verb) {
        this.armVerb(null);
        return;
      }
      this.issueOrder(e.shiftKey);
    }
  }

  armAmove() {
    if (this.placing) return;
    this.disarmSuperweapon();
    this.disarmRecon();
    this.setPatrol(false);
    if (!this.myUnits().length) {
      this.flashLabel("select units first", 800);
      return;
    }
    this.setAmove(true);
    this.flashLabel("ATTACK-MOVE — click or right-click destination (Shift to queue)", 1400);
  }

  armPatrol() {
    if (this.placing) return;
    if (this.patrolNext) {
      this.setPatrol(false);
      if (this.labelTimer) clearTimeout(this.labelTimer);
      this.onOrderLabel(null);
      return;
    }
    this.disarmSuperweapon();
    this.disarmRecon();
    this.setAmove(false);
    this.armVerb(null);
    if (!this.myUnits().length) {
      this.flashLabel("select units first", 800);
      return;
    }
    this.setPatrol(true);
    this.flashLabel("PATROL — click or right-click destination (Shift to queue)", 1400);
  }

  holdNow() {
    this.holdSelected();
  }

  stopNow() {
    this.stopSelected();
  }

  armVerb(v: "sell" | "repair" | null) {
    if (v && this.placing) return;
    if (v) {
      this.disarmSuperweapon();
      this.disarmRecon();
      this.setAmove(false);
      this.setPatrol(false);
    }
    this.verb = this.verb === v ? null : v;
    if (this.labelTimer) clearTimeout(this.labelTimer);
    this.onOrderLabel(this.verb ? `${this.verb.toUpperCase()} — click your building` : null, this.px + 12, this.py - 12);
    for (const id of ["verb-sell", "verb-repair"]) {
      document.getElementById(id)?.classList.toggle("armed", `verb-${this.verb}` === id);
    }
  }

  private useVerb() {
    const id = this.gs.pickEntity();
    const t = id != null ? this.r.tracked.get(id) : null;
    const slot = this.getSlot();
    if (!t || t.last.o !== slot || !isBuildingKind(t.last.k)) {
      this.flashLabel("click one of YOUR buildings", 900);
      return;
    }
    this.net.send(this.verb === "sell" ? { t: "sell", id: id! } : { t: "repair", id: id! });
    this.armVerb(null);
  }

  private onMove(e: PointerEvent) {
    if (!this._enabled) return;
    if (this.yawDrag) {
      const dx = e.clientX - this.yawDrag.x;
      this.yawDrag = { x: e.clientX };
      this.rotateCamYaw(dx * 0.008);
      return;
    }
    if (this.middleDrag) {
      const dx = e.clientX - this.middleDrag.x;
      const dy = e.clientY - this.middleDrag.y;
      this.middleDrag = { x: e.clientX, y: e.clientY };
      const s = this.gs.camHeight / 400;
      this.gs.pan(-dx * s, -dy * s);
      return;
    }
    if (this.dragStart) {
      const { x, y } = this.dragStart;
      if (Math.hypot(e.clientX - x, e.clientY - y) > 6 && !this.selBox) {
        this.selBox = document.createElement("div");
        this.selBox.style.cssText =
          "position:fixed;border:1px solid #5ae8ff;background:rgba(90,232,255,0.1);z-index:7;pointer-events:none;border-radius:2px";
        document.body.appendChild(this.selBox);
      }
      if (this.selBox) {
        const l = Math.min(x, e.clientX),
          t = Math.min(y, e.clientY);
        this.selBox.style.left = l + "px";
        this.selBox.style.top = t + "px";
        this.selBox.style.width = Math.abs(e.clientX - x) + "px";
        this.selBox.style.height = Math.abs(e.clientY - t) + "px";
      }
    }
    if (this.placing) this.moveGhost();
  }

  private onUp(e: PointerEvent) {
    if (!this._enabled) return;
    if (this.yawDrag && (e.button === 0 || e.button === 1)) {
      this.yawDrag = null;
      return;
    }
    if (e.button === 1) {
      this.middleDrag = null;
      return;
    }
    if (!this.dragStart || e.button !== 0) return;
    this.gs.syncPointer(e.clientX, e.clientY);
    const a = this.dragStart;
    this.dragStart = null;
    const slot = this.getSlot();

    if (this.selBox) {
      const x1 = Math.min(a.x, e.clientX),
        x2 = Math.max(a.x, e.clientX);
      const y1 = Math.min(a.y, e.clientY),
        y2 = Math.max(a.y, e.clientY);
      this.selBox.remove();
      this.selBox = null;
      const sel = a.shift ? new Set(this.selection) : new Set<number>();
      for (const id of this.r.mySelectableIds(slot)) {
        const p = this.r.entScreenPos(id);
        if (p && p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2) sel.add(id);
      }
      this.setSelection(sel);
    } else {
      const id = this.gs.pickEntity();
      const t = id != null ? this.r.tracked.get(id) : null;
      const now = performance.now();
      if (t && t.last.o === slot) {
        // Double-click unit -> select all visible friendly units of the same kind on screen
        if (!isBuildingKind(t.last.k) && id === this.lastClickId && now - this.lastClickTime < 380) {
          const sel = a.shift ? new Set(this.selection) : new Set<number>();
          const w = this.gs.canvas.clientWidth;
          const h = this.gs.canvas.clientHeight;
          for (const uid of this.r.mySelectableIds(slot)) {
            if (this.r.tracked.get(uid)?.last.k !== t.last.k) continue;
            const p = this.r.entScreenPos(uid);
            if (p && p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h) sel.add(uid);
          }
          this.setSelection(sel);
          this.lastClickId = -1;
        } else if (a.shift) {
          const sel = new Set(this.selection);
          if (sel.has(id!)) sel.delete(id!);
          else sel.add(id!);
          this.setSelection(sel);
          this.lastClickId = id!;
          this.lastClickTime = now;
        } else {
          this.setSelection(new Set([id!]));
          this.lastClickId = id!;
          this.lastClickTime = now;
        }
      } else if (!a.shift) {
        this.setSelection(new Set());
        this.lastClickId = -1;
      }
    }
  }

  issueMinimapOrder(x: number, y: number, queue = false): boolean {
    const ids = this.myUnits();
    if (!ids.length) return false;
    let kind: OrderKind = "move";
    if (this.amoveNext) {
      kind = "amove";
      this.setAmove(false);
    } else if (this.patrolNext) {
      kind = "patrol";
      this.setPatrol(false);
    }
    this.net.send({ t: "order", ids, kind, x, y, ...(queue ? { queue: true } : {}) });
    this.orderMarker(new THREE.Vector3(x, 0, y), kind, queue);
    const base = kind === "amove" ? "ATTACK-MOVE" : kind === "patrol" ? "PATROL" : "MOVE";
    this.flashLabel(queue ? `+ ${base} (MAP)` : `${base} (MAP)`, 750);
    this.onUiSound(kind === "amove" ? "attack" : "move");
    return true;
  }

  private issueOrder(queue = false) {
    const ids = this.myUnits();
    const slot = this.getSlot();
    if (!ids.length) {
      // Single own production building selected -> right-click sets its rally point
      if (this.selection.size === 1) {
        const singleId = [...this.selection][0];
        const b = this.r.tracked.get(singleId);
        if (
          b &&
          b.last.o === slot &&
          (b.last.k === "barracks" ||
            b.last.k === "factory" ||
            b.last.k === "factory2" ||
            b.last.k === "airfield" ||
            b.last.k === "shipyard")
        ) {
          const ground = this.gs.pickGround();
          if (ground) {
            this.net.send({ t: "rally", id: singleId, x: ground.x, y: ground.z });
            this.orderMarker(ground, "move", false, 0x4ad8ff);
            this.flashLabel("RALLY POINT SET", 900);
            this.onUiSound("move");
          }
        }
      }
      return;
    }
    const entId = this.gs.pickEntity();
    const t = entId != null ? this.r.tracked.get(entId) : null;
    const ground = this.gs.pickGround();
    if (!ground) return;

    let kind: OrderKind = "move";
    let target: number | undefined;
    if (this.amoveNext) {
      kind = "amove";
      this.setAmove(false);
    } else if (this.patrolNext) {
      kind = "patrol";
      this.setPatrol(false);
    } else if (t && t.last.o !== slot && t.last.o >= 0 && !this.isAlly(t.last.o)) {
      kind = "attack";
      target = entId!;
    } else if (
      t &&
      t.last.o === -1 &&
      t.last.k === "derrick" &&
      ids.some((id) => this.r.tracked.get(id)?.last.k === "engineer")
    ) {
      kind = "attack";
      target = entId!;
    } else {
      const tx = Math.floor(ground.x),
        ty = Math.floor(ground.z);
      const hasHarv = ids.some((id) => this.r.tracked.get(id)?.last.k === "harvester");
      if (hasHarv && this.oreAt(tx, ty)) kind = "harvest";
      else if (hasHarv && t && t.last.o === slot && t.last.k === "refinery") kind = "harvest";
    }
    this.net.send({ t: "order", ids, kind, x: ground.x, y: ground.z, target, ...(queue ? { queue: true } : {}) });
    this.orderMarker(ground, kind, queue);
    const base = kind === "amove" ? "ATTACK-MOVE" : kind.toUpperCase();
    this.flashLabel(queue ? `+ ${base} WAYPOINT` : base, 750);
    this.onUiSound(kind === "attack" || kind === "amove" ? "attack" : "move");
  }

  private orderMarker(p: THREE.Vector3, kind: OrderKind, queue = false, colorOverride?: number) {
    const c =
      colorOverride ??
      (kind === "attack"
        ? 0xff3026
        : kind === "amove"
          ? 0xff6a3c
          : kind === "patrol"
            ? 0x4ad8ff
            : kind === "harvest"
              ? 0xffcc33
              : 0x4dff70);
    const disc = new THREE.Mesh(
      new THREE.RingGeometry(queue ? 0.22 : 0.3, queue ? 0.34 : 0.44, 24),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(p.x, 0.07, p.z);
    this.gs.scene.add(disc);
    const born = performance.now();
    const anim = () => {
      const t = (performance.now() - born) / 480;
      if (t >= 1) {
        this.gs.scene.remove(disc);
        disc.geometry.dispose();
        (disc.material as THREE.Material).dispose();
        return;
      }
      disc.scale.setScalar(1 + t * 1.45);
      (disc.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
      requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
  }

  private holdSelected() {
    const ids = this.myUnits();
    if (!ids.length) {
      this.flashLabel("select units first", 800);
      return;
    }
    const allHeld = ids.every((id) => this.r.tracked.get(id)?.last.hold);
    this.net.send({ t: "hold", ids });
    this.flashLabel(allHeld ? "HOLD POSITION OFF" : "HOLD POSITION", 800);
    this.onUiSound("hold");
  }

  private stopSelected() {
    const ids = this.myUnits();
    if (ids.length) {
      this.net.send({ t: "stop", ids });
      this.flashLabel("STOP", 600);
      this.onUiSound("move");
    }
  }

  // ---------- placement ----------

  private updateBuildZones(show: boolean) {
    if (!show) {
      this.gs.setBuildZones(null);
      return;
    }
    const slot = this.getSlot();
    const zones: { x: number; y: number; w: number; h: number }[] = [];
    for (const t of this.r.tracked.values()) {
      if (t.last.o === slot && isBuildingKind(t.last.k)) {
        const d = BUILDINGS[t.last.k];
        zones.push({
          x: Math.round(t.last.x - d.w / 2),
          y: Math.round(t.last.y - d.h / 2),
          w: d.w,
          h: d.h,
        });
      }
    }
    this.gs.setBuildZones(zones);
  }

  enterPlacing(kind: BuildingKind) {
    if (this.ghost) this.exitPlacing();
    this.disarmSuperweapon();
    this.disarmRecon();
    this.setAmove(false);
    this.setPatrol(false);
    this.placing = kind;
    this.ghost = makePlacementGhost(kind);
    this.gs.scene.add(this.ghost);
    this.updateBuildZones(true);
    this.moveGhost();
    document.getElementById("placement-hint")?.classList.remove("hidden");
  }

  exitPlacing() {
    this.placing = null;
    this.ghostOk = false;
    this.ghostReason = null;
    this.updateBuildZones(false);
    if (this.ghost) {
      this.gs.scene.remove(this.ghost);
      this.ghost.traverse((c) => {
        if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments) {
          c.geometry.dispose();
          (c.material as THREE.Material).dispose();
        }
      });
      this.ghost = null;
    }
    const hint = document.getElementById("placement-hint");
    if (hint) {
      hint.classList.add("hidden");
      hint.classList.remove("invalid");
    }
  }

  cancelPlacing() {
    this.placingCancelled = true;
    this.clearPlacePending();
    this.exitPlacing();
    this.net.send({ t: "buildCancel" });
  }

  private moveGhost() {
    if (!this.ghost || !this.placing) return;
    const p = this.gs.pickGround();
    if (!p) return;
    const d = BUILDINGS[this.placing];
    const tx = Math.floor(p.x - d.w / 2 + 0.5),
      ty = Math.floor(p.z - d.h / 2 + 0.5);
    this.ghost.position.set(tx + d.w / 2, 0.02, ty + d.h / 2);
    this.ghost.userData.tx = tx;
    this.ghost.userData.ty = ty;
    const reason = this.placeReason(tx, ty, d.w, d.h, this.placing);
    const ok = reason === null;
    this.ghostOk = ok;
    this.ghostReason = reason;
    setGhostColor(this.ghost, ok);
    const hint = document.getElementById("placement-hint");
    if (hint) {
      hint.classList.toggle("invalid", !ok);
      hint.textContent = ok
        ? d.waterOnly
          ? "Left-click on water to deploy Naval Shipyard · Right-click or Esc to cancel & refund"
          : "Left-click to place · Right-click or Esc to cancel & refund"
        : `Cannot place: ${reason} · Right-click or Esc to cancel`;
    }
  }

  private tryPlace() {
    if (!this.placing || !this.ghost || this.placePending) return;
    this.moveGhost();
    const { tx, ty } = this.ghost.userData;
    if (!this.ghostOk) {
      if (this.ghostReason) this.flashLabel(this.ghostReason.toUpperCase(), 850);
      this.onUiSound("deny");
      return;
    }
    this.placePending = true;
    if (this.placePendingTimer) clearTimeout(this.placePendingTimer);
    this.placePendingTimer = setTimeout(() => {
      this.placePending = false;
      this.placePendingTimer = null;
    }, 1500);
    this.net.send({ t: "place", tx, ty });
    this.onUiSound("place");
  }

  // ---------- per-frame ----------

  update(dt: number) {
    if (!this._enabled) return;
    if (this.placing) this.moveGhost();

    let dx = 0,
      dz = 0;
    // Standard North-Up camera pan: Left=-X, Right=+X, Up=-Z, Down=+Z
    if (this.keys.has("ArrowUp") || (this.wasdPan && this.keys.has("KeyW"))) dz -= 1;
    if (this.keys.has("ArrowDown") || (this.wasdPan && this.keys.has("KeyS"))) dz += 1;
    if (this.keys.has("ArrowLeft") || (this.wasdPan && this.keys.has("KeyA"))) dx -= 1;
    if (this.keys.has("ArrowRight") || (this.wasdPan && this.keys.has("KeyD"))) dx += 1;

    // Edge pan — only while pointer is over the canvas
    if (this.pointerInside && this.px >= 0) {
      const w = this.gs.engine.getRenderWidth(),
        h = this.gs.engine.getRenderHeight();
      if (this.px < 12) dx -= 1;
      if (this.px > w - 12) dx += 1;
      if (this.py < 12) dz -= 1;
      if (this.py > h - 12) dz += 1;
    }

    const spd = 18; // tiles/sec
    let tvx = 0,
      tvz = 0;
    if (dx || dz) {
      const l = Math.hypot(dx, dz);
      tvx = (dx / l) * spd;
      tvz = (dz / l) * spd;
    }
    const accel = Math.min(1, dt * 16);
    this.panVx += (tvx - this.panVx) * accel;
    this.panVz += (tvz - this.panVz) * accel;
    if (Math.abs(this.panVx) > 0.05 || Math.abs(this.panVz) > 0.05) {
      this.gs.pan(this.panVx * dt, this.panVz * dt);
    } else {
      this.panVx = 0;
      this.panVz = 0;
    }
  }
}
