import * as THREE from "three";
import type { CrateSnap, EntSnap, GameEvent, OrderKind } from "../shared/protocol";
import type { CrateKind } from "../shared/gamedefs";
import { makeEntVis, makeCrateVis, setVetBadge, tagEntity, applyFacing, EntVis, CrateVis } from "./models";
import { createAnimState, stepEntityAnim, triggerFireAnim, triggerHitFlash, AnimState } from "./anim";
import { VfxSystem, WaypointOverlay } from "./vfx";
import { isBuildingKind } from "./util";
import { GameScene } from "./scene";

const INTERP_MS = 220; // crisp snapshot interpolation window
const SNAP_KEEP = 8;

const CRATE_POPUP_COLORS: Record<CrateKind, string> = {
  cash: "#ffd84d",
  vet: "#48ecff",
  heal: "#46f080",
  unit: "#ff6e45",
};

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
  crates = new Map<number, CrateSnap>();
  snaps: Snap[] = [];
  selection = new Set<number>();
  slotColors = new Map<number, string>();
  onOwnerLost?: (id: number) => void;

  private vfx: VfxSystem;
  private waypoints: WaypointOverlay;
  private crateVis = new Map<number, CrateVis>();
  private seen = new Set<number>();
  private hasInitialSnap = false;
  private swShakeTimers: ReturnType<typeof setTimeout>[] = [];

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
    for (const cv of this.crateVis.values()) {
      scene.remove(cv.root);
      (cv.ring.material as THREE.Material).dispose();
      (cv.beacon.material as THREE.Material).dispose();
    }
    this.crateVis.clear();
    this.crates.clear();
    this.gs.pickables.length = 0;
    this.snaps = [];
    this.selection.clear();
    this.seen.clear();
    this.hasInitialSnap = false;
    for (const tm of this.swShakeTimers) clearTimeout(tm);
    this.swShakeTimers = [];
    this.vfx.clear();
    this.waypoints.clear();
    this.gs.resetFog();
    this.gs.setBuildZones(null);
  }

  pushSnap(ents: EntSnap[], crates?: CrateSnap[]) {
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
      setVetBadge(vis, e.vet ?? 0);
      tagEntity(vis.root, e.id);
      scene.add(vis.root);
      this.gs.pickables.push(vis.root);
      const anim = createAnimState(e, this.hasInitialSnap);
      this.tracked.set(e.id, { vis, last: e, anim });
    }
    this.hasInitialSnap = true;

    // Sync battlefield supply crates (backward compatible when omitted)
    if (crates !== undefined) {
      const nextCrates = new Map<number, CrateSnap>();
      for (const c of crates) nextCrates.set(c.id, c);

      for (const [id, cv] of this.crateVis) {
        if (!nextCrates.has(id)) {
          scene.remove(cv.root);
          (cv.ring.material as THREE.Material).dispose();
          (cv.beacon.material as THREE.Material).dispose();
          this.crateVis.delete(id);
          this.crates.delete(id);
        }
      }
      for (const c of crates) {
        this.crates.set(c.id, c);
        if (!this.crateVis.has(c.id)) {
          const cv = makeCrateVis(c.kind);
          cv.root.position.set(c.x, 0, c.y);
          scene.add(cv.root);
          this.crateVis.set(c.id, cv);
        } else {
          this.crateVis.get(c.id)!.root.position.set(c.x, 0, c.y);
        }
      }
    }

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
        t.anim.flashing = false;
        t.anim.hitFlash = 0;
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
      setVetBadge(t.vis, e.vet ?? 0);
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
    const rallyEntries: { x: number; y: number; rx: number; ry: number }[] = [];

    for (const [id, t] of this.tracked) {
      const p = this.framePos(id);
      if (!p) continue;
      t.vis.root.position.x = p.x;
      t.vis.root.position.z = p.y;
      if (!isBuildingKind(t.last.k)) {
        applyFacing(t.vis.root, p.d);
      }
      stepEntityAnim(t.vis, t.anim, t.last, p.x, p.y, p.d, dt, nowSec, emitSmoke);

      if (this.selection.has(id) && t.vis.root.visible) {
        if (t.last.wp?.length) {
          wpEntries.push({ x: p.x, y: p.y, wp: t.last.wp });
        }
        if (
          t.last.rally &&
          (t.last.k === "barracks" || t.last.k === "factory" || t.last.k === "factory2")
        ) {
          rallyEntries.push({ x: p.x, y: p.y, rx: t.last.rally[0], ry: t.last.rally[1] });
        }
      }
    }

    // Animate hovering supply crates & pulsing beacon rings
    for (const [id, cv] of this.crateVis) {
      const phase = nowSec * 3.1 + id * 1.7;
      cv.box.position.y = 0.48 + Math.sin(phase) * 0.1;
      cv.box.rotation.y += dt * 1.45;
      const rPulse = 0.7 + Math.sin(phase * 1.35) * 0.14;
      cv.ring.scale.setScalar(rPulse);
      (cv.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.35 * Math.sin(phase * 1.35);
      (cv.beacon.material as THREE.MeshBasicMaterial).opacity = 0.14 + 0.08 * Math.sin(phase * 1.35);
    }

    this.waypoints.update(wpEntries, nowSec, rallyEntries);
    this.vfx.update();
  }

  applyEvents(events: GameEvent[], mySlot = -1) {
    for (const ev of events) {
      if (ev.e === "shot") {
        this.vfx.spawnShot(ev.fx, ev.fy, ev.tx, ev.ty, ev.w ?? "bullet", ev.vet ?? 0);
        if (ev.src != null) {
          const shooter = this.tracked.get(ev.src);
          if (shooter) triggerFireAnim(shooter.anim, ev.fx, ev.fy, ev.tx, ev.ty);
        }
      } else if (ev.e === "boom") {
        this.vfx.spawnBoom(ev.x, ev.y, ev.r);
        if (ev.r >= 1.5) {
          this.gs.shake(Math.min(0.75, ev.r * 0.24));
        }
      } else if (ev.e === "ore") {
        this.gs.setOreCells(ev.cells);
      } else if (ev.e === "hit") {
        const hitEnt = this.tracked.get(ev.id);
        if (hitEnt) triggerHitFlash(hitEnt.anim);
      } else if (ev.e === "superweapon") {
        this.vfx.spawnSuperweapon(ev.x, ev.y);
        this.gs.shake(0.75);
        const tm = setTimeout(() => {
          this.gs.shake(1.85);
          const idx = this.swShakeTimers.indexOf(tm);
          if (idx >= 0) this.swShakeTimers.splice(idx, 1);
        }, 450);
        this.swShakeTimers.push(tm);
      } else if (ev.e === "income") {
        if (mySlot < 0 || ev.slot === mySlot) {
          this.vfx.spawnPopup(ev.x, ev.y, `+$${ev.amt.toLocaleString()}`, "#ffd84d");
        }
      } else if (ev.e === "promote") {
        if (mySlot < 0 || ev.slot === mySlot || this.isVisible(ev.id)) {
          const label = ev.vet >= 3 ? "★★★ HEROIC!" : ev.vet === 2 ? "★★ ELITE!" : "★ VETERAN!";
          const color = ev.vet >= 3 ? "#ff5a36" : ev.vet === 2 ? "#ffd038" : "#f2e496";
          this.vfx.spawnPopup(ev.x, ev.y, label, color);
        }
      } else if (ev.e === "crate") {
        if (mySlot < 0 || ev.slot === mySlot) {
          const col = CRATE_POPUP_COLORS[ev.kind] ?? "#ffd84d";
          this.vfx.spawnPopup(ev.x, ev.y, ev.text || "SUPPLY CRATE!", col);
        }
      } else if (ev.e === "cap") {
        this.vfx.spawnPopup(ev.x, ev.y, "CAPTURED!", "#48eeff");
      }
    }
  }

  mySelectableIds(mySlot: number): number[] {
    const out: number[] = [];
    for (const [id, t] of this.tracked) if (t.last.o === mySlot && !isBuildingKind(t.last.k)) out.push(id);
    return out;
  }

  // Live Fog of War + Fog-lite entity reveal: allied forces share sight,
  // enemy buildings remain visible once scouted, and spectators see everything.
  applyVisibility(mySlot: number, allies?: Set<number>) {
    if (mySlot < 0) {
      for (const t of this.tracked.values()) if (!t.vis.root.visible) t.vis.root.visible = true;
      for (const cv of this.crateVis.values()) cv.root.visible = true;
      this.gs.updateFog(-1, []);
      return;
    }

    const isFriendly = (o: number) => o === mySlot || (allies?.has(o) ?? false);
    const visionSources: { x: number; y: number; r: number }[] = [];
    for (const t of this.tracked.values()) {
      if (isFriendly(t.last.o)) {
        const r = t.last.k === "radar" || t.last.k === "superweapon" ? 17 : 14;
        visionSources.push({ x: t.last.x, y: t.last.y, r });
      }
    }

    for (const [id, t] of this.tracked) {
      const e = t.last;
      if (isFriendly(e.o) || e.o < 0) {
        if (!t.vis.root.visible) t.vis.root.visible = true;
        continue;
      }
      let vis = false;
      for (const m of visionSources) {
        const dx = m.x - e.x;
        const dy = m.y - e.y;
        if (dx * dx + dy * dy <= m.r * m.r) {
          vis = true;
          break;
        }
      }
      if (vis) this.seen.add(id);
      const show = vis || (isBuildingKind(e.k) && this.seen.has(id));
      if (t.vis.root.visible !== show) t.vis.root.visible = show;
    }

    this.gs.updateFog(mySlot, visionSources);
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
