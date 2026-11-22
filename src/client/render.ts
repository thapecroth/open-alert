import * as THREE from "three";
import type { EntSnap, GameEvent, OrderKind } from "../shared/protocol";
import { makeEntVis, tagEntity, applyFacing, EntVis } from "./models";
import { createAnimState, stepEntityAnim, triggerFireAnim, AnimState } from "./anim";
import { VfxSystem, WaypointOverlay } from "./vfx";
import { isBuildingKind } from "./util";
import { GameScene } from "./scene";

const INTERP_MS = 220; // crisp snapshot interpolation window
const SNAP_KEEP = 8;

interface Snap {
  recv: number;
  ents: Map<number, EntSnap>;
}

interface Tracked {
  vis: EntVis;
  last: EntSnap;
  anim: AnimState;
}

export class Renderer {
  tracked = new Map<number, Tracked>();
  snaps: Snap[] = [];
  selection = new Set<number>();
  slotColors = new Map<number, string>();
  onOwnerLost?: (id: number) => void;

  private vfx: VfxSystem;
  private waypoints: WaypointOverlay;
  private seen = new Set<number>();
  private hasInitialSnap = false;

  constructor(private gs: GameScene) {
    this.vfx = new VfxSystem(gs.scene);
    this.waypoints = new WaypointOverlay(gs.scene);
  }

  reset() {
    const scene = this.gs.scene;
    for (const t of this.tracked.values()) {
      scene.remove(t.vis.root);
    }
    this.tracked.clear();
    this.gs.pickables.length = 0;
    this.snaps = [];
    this.selection.clear();
    this.seen.clear();
    this.hasInitialSnap = false;
    this.vfx.clear();
    this.waypoints.clear();
  }

  pushSnap(ents: EntSnap[]) {
    const map = new Map<number, EntSnap>();
    for (const e of ents) map.set(e.id, e);
    this.snaps.push({ recv: performance.now(), ents: map });
    if (this.snaps.length > SNAP_KEEP) this.snaps.shift();

    const scene = this.gs.scene;
    // Remove gone entities
    for (const [id, t] of this.tracked) {
      if (!map.has(id)) {
        scene.remove(t.vis.root);
        const i = this.gs.pickables.indexOf(t.vis.root);
        if (i >= 0) this.gs.pickables.splice(i, 1);
        this.tracked.delete(id);
        this.selection.delete(id);
      }
    }
    // Create new entities
    for (const e of ents) {
      if (this.tracked.has(e.id)) continue;
      const color = this.slotColors.get(e.o) ?? "#888888";
      const vis = makeEntVis(e.k, color, scene);
      vis.root.position.set(e.x, 0, e.y);
      if (!isBuildingKind(e.k)) applyFacing(vis.root, e.d / 10);
      tagEntity(vis.root, e.id);
      scene.add(vis.root);
      this.gs.pickables.push(vis.root);
      const anim = createAnimState(e, this.hasInitialSnap);
      this.tracked.set(e.id, { vis, last: e, anim });
    }
    this.hasInitialSnap = true;

    // Prune selection to living entities
    for (const id of [...this.selection]) if (!this.tracked.has(id)) this.selection.delete(id);
    this.updateBars(map);
  }

  private updateBars(map: Map<number, EntSnap>) {
    for (const [id, t] of this.tracked) {
      const e = map.get(id);
      if (!e) continue;
      const ownerChanged = t.last.o !== e.o;
      const kindChanged = t.last.k !== e.k;
      if (ownerChanged || kindChanged) {
        // Ownership changed (capture) OR kind changed (factory -> factory2 upgrade) — rebuild visual!
        const scene = this.gs.scene;
        const wasVisible = t.vis.root.visible;
        scene.remove(t.vis.root);
        const i = this.gs.pickables.indexOf(t.vis.root);
        if (i >= 0) this.gs.pickables.splice(i, 1);
        const color = this.slotColors.get(e.o) ?? "#888888";
        const vis = makeEntVis(e.k, color, scene);
        vis.root.position.copy(t.vis.root.position);
        vis.root.rotation.y = t.vis.root.rotation.y;
        vis.root.visible = wasVisible;
        tagEntity(vis.root, e.id);
        scene.add(vis.root);
        this.gs.pickables.push(vis.root);
        t.vis = vis;
        if (ownerChanged) {
          this.selection.delete(id);
          this.onOwnerLost?.(id);
        } else {
          // Keep selection ring active across upgrade
          t.vis.ring.visible = this.selection.has(id);
        }
      }
      t.last = e;
      const frac = Math.max(0, e.hp / e.mhp);
      t.vis.barFg.scale.x = Math.max(0.02, frac * t.vis.barFg.userData.w);
      const c = frac > 0.6 ? 0x26e050 : frac > 0.3 ? 0xf0cc26 : 0xe52626;
      (t.vis.barFg.material as THREE.SpriteMaterial).color.setHex(c);
      const show = frac < 1 || this.selection.has(id);
      t.vis.barBg.visible = show;
      t.vis.barFg.visible = show;
      if (t.vis.bin) t.vis.bin.scale.y = Math.max(0.05, (e.cargo ?? 0) / 40);
    }
  }

  setSelected(ids: Set<number>) {
    this.selection = ids;
    for (const [id, t] of this.tracked) t.vis.ring.visible = ids.has(id);
  }

  private framePos(id: number): { x: number; y: number; d: number } | null {
    const n = this.snaps.length;
    if (!n) return null;
    const rt = performance.now() - INTERP_MS;
    let a = this.snaps[0],
      b = this.snaps[n - 1];
    for (let i = n - 1; i > 0; i--) {
      if (this.snaps[i - 1].recv <= rt) {
        a = this.snaps[i - 1];
        b = this.snaps[i];
        break;
      }
    }
    const ea = a.ents.get(id);
    const eb = b.ents.get(id);
    if (!ea && !eb) return null;
    if (!ea) return { x: eb!.x, y: eb!.y, d: eb!.d / 10 };
    if (!eb) return { x: ea.x, y: ea.y, d: ea.d / 10 };
    const span = Math.max(1, b.recv - a.recv);
    const t = Math.max(0, Math.min(1, (rt - a.recv) / span));
    let dd = eb.d - ea.d;
    if (dd > Math.PI * 10) dd -= Math.PI * 20;
    if (dd < -Math.PI * 10) dd += Math.PI * 20;
    return {
      x: ea.x + (eb.x - ea.x) * t,
      y: ea.y + (eb.y - ea.y) * t,
      d: (ea.d + dd * t) / 10,
    };
  }

  update(dt = 0.016) {
    const nowSec = performance.now() / 1000;
    const emitSmoke = (x: number, y: number, z: number, dark: boolean) => this.vfx.spawnSmoke(x, y, z, dark);
    const wpEntries: { x: number; y: number; wp: [number, number, OrderKind][] }[] = [];

    for (const [id, t] of this.tracked) {
      const p = this.framePos(id);
      if (!p) continue;
      t.vis.root.position.x = p.x;
      t.vis.root.position.z = p.y;
      if (!isBuildingKind(t.last.k)) {
        applyFacing(t.vis.root, p.d);
      }
      stepEntityAnim(t.vis, t.anim, t.last, p.x, p.y, p.d, dt, nowSec, emitSmoke);

      if (this.selection.has(id) && t.last.wp?.length && t.vis.root.visible) {
        wpEntries.push({ x: p.x, y: p.y, wp: t.last.wp });
      }
    }

    this.waypoints.update(wpEntries, nowSec);
    this.vfx.update();
  }

  applyEvents(events: GameEvent[]) {
    for (const ev of events) {
      if (ev.e === "shot") {
        this.vfx.spawnShot(ev.fx, ev.fy, ev.tx, ev.ty, ev.w ?? "bullet");
        if (ev.src != null) {
          const shooter = this.tracked.get(ev.src);
          if (shooter) triggerFireAnim(shooter.anim, ev.fx, ev.fy, ev.tx, ev.ty);
        }
      } else if (ev.e === "boom") {
        this.vfx.spawnBoom(ev.x, ev.y, ev.r);
      } else if (ev.e === "ore") {
        this.gs.setOreCells(ev.cells);
      }
    }
  }

  mySelectableIds(mySlot: number): number[] {
    const out: number[] = [];
    for (const [id, t] of this.tracked) if (t.last.o === mySlot && !isBuildingKind(t.last.k)) out.push(id);
    return out;
  }

  // Fog-lite: enemy units only render within sight of your forces; enemy
  // buildings stay visible once scouted. Spectators see everything.
  applyVisibility(mySlot: number) {
    if (mySlot < 0) {
      for (const t of this.tracked.values()) if (!t.vis.root.visible) t.vis.root.visible = true;
      return;
    }
    const mine: { x: number; y: number }[] = [];
    for (const t of this.tracked.values()) if (t.last.o === mySlot) mine.push(t.last);
    for (const [id, t] of this.tracked) {
      const e = t.last;
      if (e.o === mySlot || e.o < 0) {
        if (!t.vis.root.visible) t.vis.root.visible = true;
        continue;
      }
      let vis = false;
      for (const m of mine) {
        if ((m.x - e.x) * (m.x - e.x) + (m.y - e.y) * (m.y - e.y) <= 14 * 14) {
          vis = true;
          break;
        }
      }
      if (vis) this.seen.add(id);
      const show = vis || (isBuildingKind(e.k) && this.seen.has(id));
      if (t.vis.root.visible !== show) t.vis.root.visible = show;
    }
  }

  isVisible(id: number) {
    return this.tracked.get(id)?.vis.root.visible ?? false;
  }

  entScreenPos(id: number): { x: number; y: number } | null {
    const t = this.tracked.get(id);
    if (!t || !t.vis.root.visible) return null;
    const v = t.vis.root.position.clone();
    v.y = 0.5;
    v.project(this.gs.camera);
    // Reject entities behind or clipped outside camera frustum
    if (v.z < -1 || v.z > 1) return null;
    return {
      x: (v.x * 0.5 + 0.5) * this.gs.canvas.clientWidth,
      y: (-v.y * 0.5 + 0.5) * this.gs.canvas.clientHeight,
    };
  }
}
