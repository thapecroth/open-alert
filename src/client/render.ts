import * as THREE from "three";
import type { EntSnap, GameEvent } from "../shared/protocol";
import { makeEntVis, tagEntity, applyFacing, EntVis } from "./meshes";
import { isBuildingKind } from "./util";
import { GameScene } from "./scene";

const INTERP_MS = 260; // render delay for snapshot interpolation
const SNAP_KEEP = 8;

interface Snap {
  recv: number;
  ents: Map<number, EntSnap>;
}

interface Tracked {
  vis: EntVis;
  last: EntSnap;
}

interface Fx {
  obj: THREE.Object3D;
  born: number;
  life: number;
  tick: (o: THREE.Object3D, t: number) => void;
}

export class Renderer {
  tracked = new Map<number, Tracked>();
  snaps: Snap[] = [];
  selection = new Set<number>();
  slotColors = new Map<number, string>();
  private fxs: Fx[] = [];

  constructor(private gs: GameScene) {}

  pushSnap(ents: EntSnap[]) {
    const map = new Map<number, EntSnap>();
    for (const e of ents) map.set(e.id, e);
    this.snaps.push({ recv: performance.now(), ents: map });
    if (this.snaps.length > SNAP_KEEP) this.snaps.shift();

    const scene = this.gs.scene;
    // remove gone entities
    for (const [id, t] of this.tracked) {
      if (!map.has(id)) {
        scene.remove(t.vis.root);
        const i = this.gs.pickables.indexOf(t.vis.root);
        if (i >= 0) this.gs.pickables.splice(i, 1);
        this.tracked.delete(id);
        this.selection.delete(id);
      }
    }
    // create new
    for (const e of ents) {
      if (this.tracked.has(e.id)) continue;
      const color = this.slotColors.get(e.o) ?? "#888888";
      const vis = makeEntVis(e.k, color, scene);
      vis.root.position.set(e.x, 0, e.y);
      tagEntity(vis.root, e.id);
      scene.add(vis.root);
      this.gs.pickables.push(vis.root);
      this.tracked.set(e.id, { vis, last: e });
    }
    // prune selection to own living units
    for (const id of [...this.selection]) if (!this.tracked.has(id)) this.selection.delete(id);
    this.updateBars(map);
  }

  private updateBars(map: Map<number, EntSnap>) {
    for (const [id, t] of this.tracked) {
      const e = map.get(id);
      if (!e) continue;
      t.last = e;
      const frac = Math.max(0, e.hp / e.mhp);
      t.vis.barFg.scale.x = Math.max(0.02, frac * t.vis.barFg.userData.w);
      const c = frac > 0.6 ? 0x26e050 : frac > 0.3 ? 0xf0cc26 : 0xe52626;
      (t.vis.barFg.material as THREE.SpriteMaterial).color.setHex(c);
      const show = frac < 1 || this.selection.has(id);
      t.vis.barBg.visible = show;
      t.vis.barFg.visible = show;
      // harvester cargo glow scales with load (cap 40)
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

  update() {
    const now = performance.now();
    for (const [id, t] of this.tracked) {
      const p = this.framePos(id);
      if (!p) continue;
      t.vis.root.position.x = p.x;
      t.vis.root.position.z = p.y;
      if (isBuildingKind(t.last.k)) {
        if (t.last.k === "turret" && t.vis.turret) applyFacing(t.vis.turret, p.d);
      } else {
        applyFacing(t.vis.root, p.d);
      }
      if (t.vis.spin) t.vis.spin.rotation.y += 0.012;
    }
    // fx
    for (let i = this.fxs.length - 1; i >= 0; i--) {
      const f = this.fxs[i];
      const t = (now - f.born) / f.life;
      if (t >= 1) {
        this.gs.scene.remove(f.obj);
        disposeObj(f.obj);
        this.fxs.splice(i, 1);
      } else f.tick(f.obj, t);
    }
  }

  private addFx(obj: THREE.Object3D, life: number, tick: Fx["tick"]) {
    this.gs.scene.add(obj);
    this.fxs.push({ obj, born: performance.now(), life, tick });
  }

  applyEvents(events: GameEvent[]) {
    const scene = this.gs.scene;
    for (const ev of events) {
      if (ev.e === "shot") {
        const a = new THREE.Vector3(ev.fx, 0.7, ev.fy);
        const b = new THREE.Vector3(ev.tx, 0.5, ev.ty);
        // tracer beam — stretched emissive cylinder
        const len = a.distanceTo(b);
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.035, 0.035, 1, 6),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.0, 0.8), transparent: true, opacity: 0.95 })
        );
        beam.scale.y = len;
        beam.position.copy(a).lerp(b, 0.5);
        beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        this.addFx(beam, 140, (m, t) => ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t));
        // muzzle flash sprite
        const flash = new THREE.Sprite(new THREE.SpriteMaterial({ color: new THREE.Color(3, 2.2, 0.9), transparent: true }));
        flash.position.copy(a);
        flash.scale.setScalar(0.5);
        this.addFx(flash, 120, (m, t) => {
          m.scale.setScalar(0.5 * (1 - t * 0.6));
          (m as THREE.Sprite).material.opacity = 1 - t;
        });
      } else if (ev.e === "boom") {
        const r = Math.max(1.4, ev.r * 1.1);
        // fireball
        const s = new THREE.Mesh(
          new THREE.SphereGeometry(0.5, 10, 8),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(2.8, 1.1, 0.3), transparent: true })
        );
        s.position.set(ev.x, 0.6, ev.y);
        this.addFx(s, 520, (m, t) => {
          const sc = 0.4 + t * r;
          m.scale.setScalar(sc);
          m.position.y = 0.4 + t * 0.9;
          ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (1 - t) * (1 - t);
        });
        // ground shockwave ring
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(1, 0.05, 8, 32),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.3, 0.4), transparent: true })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(ev.x, 0.12, ev.y);
        this.addFx(ring, 430, (m, t) => {
          const sc = 1 + t * r * 1.9;
          m.scale.set(sc, sc, sc);
          ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
        });
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

  // fog-lite: enemy units only render within sight of your forces; enemy
  // buildings stay visible once scouted. spectators see everything.
  private seen = new Set<number>();
  applyVisibility(mySlot: number) {
    if (mySlot < 0) return;
    const mine: { x: number; y: number }[] = [];
    for (const t of this.tracked.values()) if (t.last.o === mySlot) mine.push(t.last);
    for (const [id, t] of this.tracked) {
      const e = t.last;
      if (e.o === mySlot || e.o < 0) continue;
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
    if (!t) return null;
    const v = t.vis.root.position.clone();
    v.y = 0.5;
    v.project(this.gs.camera);
    return {
      x: (v.x * 0.5 + 0.5) * this.gs.canvas.clientWidth,
      y: (-v.y * 0.5 + 0.5) * this.gs.canvas.clientHeight,
    };
  }
}

function disposeObj(o: THREE.Object3D) {
  o.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      (c.geometry as THREE.BufferGeometry)?.dispose?.();
      const m = c.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose?.();
    } else if (c instanceof THREE.Sprite) {
      (c.material as THREE.SpriteMaterial).dispose();
    }
  });
}
