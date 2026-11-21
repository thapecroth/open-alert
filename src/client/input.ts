import * as THREE from "three";
import { BUILDINGS, BuildingKind } from "../shared/gamedefs";
import type { OrderKind } from "../shared/protocol";
import { GameScene } from "./scene";
import { Renderer } from "./render";
import { Net } from "./net";
import { isBuildingKind } from "./util";

export class Input {
  selection = new Set<number>();
  placing: BuildingKind | null = null;
  placingCancelled = false;
  onSelectionChange: (ids: Set<number>) => void = () => {};
  onOrderLabel: (text: string | null, x?: number, y?: number) => void = () => {};

  private gs: GameScene;
  private r: Renderer;
  private net: Net;
  private getSlot: () => number;
  private keys = new Set<string>();
  private dragStart: { x: number; y: number } | null = null;
  private selBox: HTMLDivElement | null = null;
  private middleDrag: { x: number; y: number } | null = null;
  private pointerInside = false;
  private px = -1;
  private py = -1;
  private ghost: THREE.Mesh | null = null;
  private ghostOk = false;
  placePending = false; // a place cmd is in flight — wait for the next snap
  private amoveNext = false;
  verb: "sell" | "repair" | null = null; // armed cursor mode for own buildings
  private occCheck: (tx: number, ty: number, w: number, h: number) => boolean;
  private adjCheck: (tx: number, ty: number, w: number, h: number) => boolean;
  private oreAt: (x: number, y: number) => boolean;

  constructor(
    gs: GameScene,
    r: Renderer,
    net: Net,
    getSlot: () => number,
    occCheck: (tx: number, ty: number, w: number, h: number) => boolean,
    adjCheck: (tx: number, ty: number, w: number, h: number) => boolean,
    oreAt: (x: number, y: number) => boolean,
  ) {
    this.gs = gs;
    this.r = r;
    this.net = net;
    this.getSlot = getSlot;
    this.occCheck = occCheck;
    this.adjCheck = adjCheck;
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
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      gs.zoom(e.deltaY * 0.02);
    }, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        // typing in chat must not drive the game
        if (e.code === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      this.keys.add(e.code);
      if (e.code === "KeyA") this.amoveNext = true;
      if (e.code === "KeyS") this.stopSelected();
      if (e.code === "Digit4") this.armVerb("sell");
      if (e.code === "KeyR") this.armVerb("repair");
      if (e.code === "Escape") {
        this.amoveNext = false;
        this.armVerb(null);
        if (this.placing) this.cancelPlacing();
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  private myUnits(): number[] {
    const slot = this.getSlot();
    return [...this.selection].filter((id) => {
      const t = this.r.tracked.get(id);
      return t && t.last.o === slot && !isBuildingKind(t.last.k);
    });
  }

  private onDown(e: PointerEvent) {
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
      this.dragStart = { x: e.clientX, y: e.clientY };
    } else if (e.button === 2) {
      if (this.verb) {
        this.armVerb(null);
        return;
      }
      this.issueOrder();
    }
  }

  armAmove() {
    this.amoveNext = true;
    this.onOrderLabel("ATTACK-MOVE — right-click destination", this.px + 10, this.py - 10);
    setTimeout(() => this.onOrderLabel(null), 1200);
  }

  stopNow() {
    this.stopSelected();
  }

  armVerb(v: "sell" | "repair" | null) {
    this.verb = this.verb === v ? null : v;
    this.onOrderLabel(this.verb ? `${this.verb.toUpperCase()} — click your building` : null, this.px + 10, this.py - 10);
    for (const id of ["verb-sell", "verb-repair"])
      document.getElementById(id)?.classList.toggle("armed", `verb-${this.verb}` === id);
  }

  private useVerb() {
    const id = this.gs.pickEntity();
    const t = id != null ? this.r.tracked.get(id) : null;
    const slot = this.getSlot();
    if (!t || t.last.o !== slot || !isBuildingKind(t.last.k)) {
      this.onOrderLabel("click one of YOUR buildings", this.px + 10, this.py - 10);
      setTimeout(() => this.onOrderLabel(null), 900);
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
        this.selBox.style.cssText = "position:fixed;border:1px solid #7f7;background:rgba(80,255,80,0.08);z-index:7;pointer-events:none";
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
    const a = this.dragStart;
    this.dragStart = null;
    if (this.selBox) {
      const x1 = Math.min(a.x, e.clientX),
        x2 = Math.max(a.x, e.clientX);
      const y1 = Math.min(a.y, e.clientY),
        y2 = Math.max(a.y, e.clientY);
      this.selBox.remove();
      this.selBox = null;
      const slot = this.getSlot();
      const sel = new Set<number>();
      for (const id of this.r.mySelectableIds(slot)) {
        const p = this.r.entScreenPos(id);
        if (p && p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2) sel.add(id);
      }
      this.selection = sel;
    } else {
      // click select
      const id = this.gs.pickEntity();
      const t = id != null ? this.r.tracked.get(id) : null;
      const slot = this.getSlot();
      if (t && t.last.o === slot) this.selection = new Set([id!]);
      else this.selection = new Set();
    }
    this.r.setSelected(this.selection);
    this.onSelectionChange(this.selection);
  }

  private issueOrder() {
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
      this.amoveNext = false;
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
    this.net.send({ t: "order", ids, kind, x: ground.x, y: ground.z, target });
    this.orderMarker(ground, kind);
    const label = kind === "amove" ? "ATTACK-MOVE" : kind.toUpperCase();
    this.onOrderLabel(label, this.px + 10, this.py - 10);
    setTimeout(() => this.onOrderLabel(null), 700);
  }

  private orderMarker(p: THREE.Vector3, kind: OrderKind) {
    const c = kind === "attack" ? 0xff3026 : kind === "harvest" ? 0xffcc33 : 0x4dff4d;
    const disc = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.42, 24),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(p.x, 0.06, p.z);
    this.gs.scene.add(disc);
    const born = performance.now();
    const anim = () => {
      const t = (performance.now() - born) / 500;
      if (t >= 1) {
        this.gs.scene.remove(disc);
        disc.geometry.dispose();
        (disc.material as THREE.Material).dispose();
        return;
      }
      disc.scale.setScalar(1 + t * 1.4);
      (disc.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t);
      requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
  }

  private stopSelected() {
    const ids = this.myUnits();
    if (ids.length) this.net.send({ t: "stop", ids });
  }

  // ---------- placement ----------

  enterPlacing(kind: BuildingKind) {
    this.placing = kind;
    const d = BUILDINGS[kind];
    this.ghost = new THREE.Mesh(
      new THREE.BoxGeometry(d.w, 0.25, d.h),
      new THREE.MeshBasicMaterial({ color: 0x22e040, transparent: true, opacity: 0.4, depthWrite: false })
    );
    this.gs.scene.add(this.ghost);
    this.moveGhost();
    document.getElementById("placement-hint")?.classList.remove("hidden");
  }

  exitPlacing() {
    this.placing = null;
    if (this.ghost) {
      this.gs.scene.remove(this.ghost);
      this.ghost.geometry.dispose();
      (this.ghost.material as THREE.Material).dispose();
      this.ghost = null;
    }
    document.getElementById("placement-hint")?.classList.add("hidden");
  }

  cancelPlacing() {
    this.placingCancelled = true; // user-initiated: don't auto re-enter
    this.exitPlacing();
    // the server still holds `awaiting` — cancel it for real or the build
    // queue stays blocked ("construction in progress") forever
    this.net.send({ t: "buildCancel" });
  }

  private moveGhost() {
    if (!this.ghost || !this.placing) return;
    const p = this.gs.pickGround();
    if (!p) return;
    const d = BUILDINGS[this.placing];
    const tx = Math.floor(p.x - d.w / 2 + 0.5),
      ty = Math.floor(p.z - d.h / 2 + 0.5);
    this.ghost.position.set(tx + d.w / 2, 0.15, ty + d.h / 2);
    this.ghost.userData = { tx, ty };
    const ok = this.placeOk(tx, ty, d);
    this.ghostOk = ok;
    (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(ok ? 0x22e040 : 0xe52525);
  }

  private placeOk(tx: number, ty: number, d: { w: number; h: number }) {
    if (!this.occCheck(tx, ty, d.w, d.h)) return false;
    return this.adjCheck(tx, ty, d.w, d.h);
  }

  private tryPlace() {
    if (!this.placing || !this.ghost || this.placePending) return;
    const { tx, ty } = this.ghost.userData;
    if (!this.ghostOk) return;
    this.placePending = true;
    this.net.send({ t: "place", tx, ty });
    // stay in placing mode until server confirms (awaiting clears in next snap)
  }

  // ---------- per-frame ----------

  update(dt: number) {
    // keep the ghost glued to the cursor + validity fresh even when the
    // pointer is still (camera pan, units wandering into the footprint)
    if (this.placing) this.moveGhost();
    const spd = dt * 14; // tiles/sec
    let dx = 0,
      dz = 0;
    if (this.keys.has("ArrowUp")) dz += 1;
    if (this.keys.has("ArrowDown")) dz -= 1;
    if (this.keys.has("ArrowLeft")) dx -= 1;
    if (this.keys.has("ArrowRight")) dx += 1;
    // edge pan — only while the pointer is actually over the canvas
    if (this.pointerInside && this.px >= 0) {
      const w = this.gs.engine.getRenderWidth(),
        h = this.gs.engine.getRenderHeight();
      if (this.px < 12) dx -= 1;
      if (this.px > w - 12) dx += 1;
      if (this.py < 12) dz += 1;
      if (this.py > h - 12) dz -= 1;
    }
    if (dx || dz) {
      const l = Math.hypot(dx, dz);
      this.gs.pan((dx / l) * spd, (dz / l) * spd);
    }
  }
}
