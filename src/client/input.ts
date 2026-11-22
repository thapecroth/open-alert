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
  wasdPan = localStorage.getItem("oa-wasd") === "1";

  onSelectionChange: (ids: Set<number>) => void = () => {};
  onGroupsChange: (groups: Map<number, Set<number>>) => void = () => {};
  onOrderLabel: (text: string | null, x?: number, y?: number) => void = () => {};
  onOpenChat: () => void = () => {};
  onWasdChange: (on: boolean) => void = () => {};

  private gs: GameScene;
  private r: Renderer;
  private net: Net;
  private getSlot: () => number;
  private keys = new Set<string>();
  private dragStart: { x: number; y: number; shift: boolean } | null = null;
  private selBox: HTMLDivElement | null = null;
  private middleDrag: { x: number; y: number } | null = null;
  private pointerInside = false;
  private px = -1;
  private py = -1;
  private ghost: THREE.Mesh | null = null;
  private ghostOk = false;
  private ghostReason: string | null = null;
  private placePendingTimer: ReturnType<typeof setTimeout> | null = null;
  private amoveNext = false;
  private lastClickTime = 0;
  private lastClickId = -1;
  private lastGroupTap = { num: -1, time: 0 };
  private lastAlertPos: { x: number; y: number } | null = null;
  private harvCycle = 0;
  private prodCycle = 0;
  private panVx = 0;
  private panVz = 0;
  private labelTimer: ReturnType<typeof setTimeout> | null = null;

  private placeReason: (tx: number, ty: number, w: number, h: number) => string | null;
  private oreAt: (x: number, y: number) => boolean;

  constructor(
    gs: GameScene,
    r: Renderer,
    net: Net,
    getSlot: () => number,
    placeReason: (tx: number, ty: number, w: number, h: number) => string | null,
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
        e.preventDefault();
        gs.zoom(e.deltaY * 0.02);
      },
      { passive: false },
    );
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.middleDrag = null;
    });
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  reset() {
    this.exitPlacing();
    this.clearPlacePending();
    this.placingCancelled = false;
    this.setAmove(false);
    this.armVerb(null);
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
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (e.code === "Escape") (e.target as HTMLElement).blur();
      return;
    }

    // Enter focuses chat directly
    if (e.code === "Enter") {
      e.preventDefault();
      this.onOpenChat();
      return;
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

    if (e.code === "Escape") {
      const help = document.getElementById("help");
      if (help && !help.classList.contains("hidden")) {
        help.classList.add("hidden");
        return;
      }
      this.setAmove(false);
      this.armVerb(null);
      if (this.placing) {
        this.cancelPlacing();
      } else if (this.selection.size) {
        this.setSelection(new Set());
      }
    }
  }

  private setAmove(on: boolean) {
    this.amoveNext = on;
    document.getElementById("verb-amove")?.classList.toggle("armed", on);
  }

  private setSelection(sel: Set<number>) {
    this.selection = sel;
    if (this.amoveNext) this.setAmove(false);
    this.r.setSelected(this.selection);
    this.onSelectionChange(this.selection);
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
        (t.last.k === "conyard" || t.last.k === "barracks" || t.last.k === "factory" || t.last.k === "factory2"),
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
  }

  // ---------- Pointer interactions ----------

  private onDown(e: PointerEvent) {
    this.px = e.clientX;
    this.py = e.clientY;
    this.gs.syncPointer(e.clientX, e.clientY);

    if (e.button === 1) {
      this.middleDrag = { x: e.clientX, y: e.clientY };
      e.preventDefault();
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
      if (this.amoveNext && this.myUnits().length) {
        // Classic RTS: A + Left-Click executes Attack-Move!
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
    if (!this.myUnits().length) {
      this.flashLabel("select units first", 800);
      return;
    }
    this.setAmove(true);
    this.flashLabel("ATTACK-MOVE — click or right-click destination (Shift to queue)", 1400);
  }

  stopNow() {
    this.stopSelected();
  }

  armVerb(v: "sell" | "repair" | null) {
    if (v && this.placing) return;
    if (v) this.setAmove(false);
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

  private issueOrder(queue = false) {
    const ids = this.myUnits();
    if (!ids.length) return;
    const entId = this.gs.pickEntity();
    const t = entId != null ? this.r.tracked.get(entId) : null;
    const slot = this.getSlot();
    const ground = this.gs.pickGround();
    if (!ground) return;

    let kind: OrderKind = "move";
    let target: number | undefined;
    if (this.amoveNext) {
      kind = "amove";
      this.setAmove(false);
    } else if (t && t.last.o !== slot && t.last.o >= 0) {
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
  }

  private orderMarker(p: THREE.Vector3, kind: OrderKind, queue = false) {
    const c = kind === "attack" ? 0xff3026 : kind === "amove" ? 0xff6a3c : kind === "harvest" ? 0xffcc33 : 0x4dff70;
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

  private stopSelected() {
    const ids = this.myUnits();
    if (ids.length) {
      this.net.send({ t: "stop", ids });
      this.flashLabel("STOP", 600);
    }
  }

  // ---------- placement ----------

  enterPlacing(kind: BuildingKind) {
    if (this.ghost) this.exitPlacing();
    this.placing = kind;
    this.ghost = makePlacementGhost(kind);
    this.gs.scene.add(this.ghost);
    this.moveGhost();
    document.getElementById("placement-hint")?.classList.remove("hidden");
  }

  exitPlacing() {
    this.placing = null;
    this.ghostOk = false;
    this.ghostReason = null;
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
    const reason = this.placeReason(tx, ty, d.w, d.h);
    const ok = reason === null;
    this.ghostOk = ok;
    this.ghostReason = reason;
    setGhostColor(this.ghost, ok);
    const hint = document.getElementById("placement-hint");
    if (hint) {
      hint.classList.toggle("invalid", !ok);
      hint.textContent = ok
        ? "Left-click to place · Right-click or Esc to cancel & refund"
        : `Cannot place: ${reason} · Right-click or Esc to cancel`;
    }
  }

  private tryPlace() {
    if (!this.placing || !this.ghost || this.placePending) return;
    this.moveGhost();
    const { tx, ty } = this.ghost.userData;
    if (!this.ghostOk) {
      if (this.ghostReason) this.flashLabel(this.ghostReason.toUpperCase(), 850);
      return;
    }
    this.placePending = true;
    if (this.placePendingTimer) clearTimeout(this.placePendingTimer);
    this.placePendingTimer = setTimeout(() => {
      this.placePending = false;
      this.placePendingTimer = null;
    }, 1500);
    this.net.send({ t: "place", tx, ty });
  }

  // ---------- per-frame ----------

  update(dt: number) {
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
