import * as THREE from "three";
import type { OrderKind, WeaponFx } from "../shared/protocol";

interface FxItem {
  obj: THREE.Object3D;
  born: number;
  life: number;
  tick: (o: THREE.Object3D, t: number, dt: number) => void;
  disposeGeo?: boolean;
}

const sharedCyl = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
const sharedShell = new THREE.SphereGeometry(0.11, 8, 6);
const sharedSpark = new THREE.BoxGeometry(0.1, 0.1, 0.1);
const sharedSmoke = new THREE.DodecahedronGeometry(0.28, 0);
const sharedFire = new THREE.SphereGeometry(0.5, 10, 8);
const sharedRing = new THREE.TorusGeometry(1, 0.055, 8, 28);
const sharedPinRing = new THREE.RingGeometry(0.18, 0.28, 18);
sharedPinRing.rotateX(-Math.PI / 2);
const sharedPinPost = new THREE.CylinderGeometry(0.035, 0.035, 0.65, 6);
const sharedPinHead = new THREE.OctahedronGeometry(0.14, 0);

const UP = new THREE.Vector3(0, 1, 0);

const ORDER_COLORS: Record<OrderKind, number> = {
  move: 0x4dff70,
  amove: 0xff6a3c,
  attack: 0xff3030,
  harvest: 0xffc436,
};

export class VfxSystem {
  private fxs: FxItem[] = [];
  private lastNow = performance.now();

  constructor(private scene: THREE.Scene) {}

  private add(obj: THREE.Object3D, life: number, tick: FxItem["tick"], disposeGeo = false) {
    this.scene.add(obj);
    this.fxs.push({ obj, born: performance.now(), life, tick, disposeGeo });
  }

  spawnSmoke(x: number, y: number, z: number, dark: boolean) {
    if (this.fxs.length > 140) return; // cap particle count under heavy battles
    const col = dark ? 0x26292e : 0x8ea0ad;
    const mat = new THREE.MeshBasicMaterial({
      color: col,
      transparent: true,
      opacity: dark ? 0.52 : 0.26,
      depthWrite: false,
    });
    const m = new THREE.Mesh(sharedSmoke, mat);
    m.position.set(x + (Math.random() - 0.5) * 0.18, y, z + (Math.random() - 0.5) * 0.18);
    const driftX = (Math.random() - 0.5) * 0.45;
    const driftZ = (Math.random() - 0.5) * 0.45;
    const baseScale = dark ? 0.65 : 0.48;
    const startY = y;
    const startX = m.position.x;
    const startZ = m.position.z;
    this.add(m, dark ? 1150 : 1400, (o, t) => {
      o.position.set(startX + driftX * t, startY + t * (dark ? 1.8 : 2.2), startZ + driftZ * t);
      o.scale.setScalar(baseScale + t * 1.4);
      o.rotation.y = t * 1.4;
      mat.opacity = (dark ? 0.52 : 0.26) * (1 - t);
    });
  }

  spawnShot(fx: number, fy: number, tx: number, ty: number, weapon: WeaponFx = "bullet") {
    const a = new THREE.Vector3(fx, weapon === "arc" ? 1.35 : 0.72, fy);
    const b = new THREE.Vector3(tx, 0.48, ty);
    const dir = b.clone().sub(a);
    const len = Math.max(0.05, dir.length());

    if (weapon === "arc") {
      // Jagged multi-segment electric lightning bolt
      const segs = Math.max(6, Math.min(14, Math.round(len * 2)));
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= segs; i++) {
        const u = i / segs;
        const p = a.clone().lerp(b, u);
        if (i > 0 && i < segs) {
          p.x += (Math.random() - 0.5) * 0.55;
          p.y += (Math.random() - 0.5) * 0.45 + 0.18;
          p.z += (Math.random() - 0.5) * 0.55;
        }
        pts.push(p);
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(1.4, 2.5, 3.2), transparent: true, opacity: 1 });
      const bolt = new THREE.Line(geo, mat);
      this.add(bolt, 210, (_o, t) => (mat.opacity = 1 - t), true);
      // Electric impact burst
      this.spawnFlash(b, new THREE.Color(1.0, 2.2, 3.0), 0.85, 190);
      this.spawnFlash(a, new THREE.Color(1.0, 2.0, 2.8), 0.6, 160);
      return;
    }

    if (weapon === "arty") {
      // High-arcing parabolic artillery shell + impact shockwave
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.5, 0.5) });
      const shell = new THREE.Mesh(sharedShell, mat);
      shell.scale.setScalar(1.35);
      const arcH = Math.min(5.2, 1.8 + len * 0.36);
      let smokeTick = 0;
      let impacted = false;
      this.add(shell, 420, (o, t, dt) => {
        const p = a.clone().lerp(b, t);
        p.y += 4 * arcH * t * (1 - t);
        o.position.copy(p);
        smokeTick += dt;
        if (smokeTick > 0.055 && t < 0.92) {
          smokeTick = 0;
          this.spawnSmoke(p.x, p.y, p.z, false);
        }
        if (t >= 0.92 && !impacted) {
          impacted = true;
          this.spawnImpactRing(b.x, b.z, 1.15, new THREE.Color(2.4, 1.2, 0.35));
          this.spawnFlash(b, new THREE.Color(2.8, 1.4, 0.4), 1.0, 220);
        }
      });
      this.spawnFlash(a, new THREE.Color(2.4, 1.4, 0.5), 0.7, 150);
      return;
    }

    if (weapon === "rocket") {
      // Flying smoking rocket
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 1.6, 0.55) });
      const m = new THREE.Mesh(sharedCyl, mat);
      m.scale.set(1.5, 0.42, 1.5);
      m.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
      let smokeTick = 0;
      let hit = false;
      this.add(m, 260, (o, t, dt) => {
        o.position.copy(a).lerp(b, t);
        smokeTick += dt;
        if (smokeTick > 0.06 && t < 0.9) {
          smokeTick = 0;
          this.spawnSmoke(o.position.x, o.position.y, o.position.z, false);
        }
        if (t >= 0.9 && !hit) {
          hit = true;
          this.spawnFlash(b, new THREE.Color(2.6, 1.3, 0.35), 0.75, 170);
        }
      });
      this.spawnFlash(a, new THREE.Color(2.2, 1.4, 0.5), 0.45, 110);
      return;
    }

    if (weapon === "cannon") {
      // Heavy glowing shell streaking rapidly + muzzle puff
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 1.7, 0.55), transparent: true, opacity: 0.98 });
      const beam = new THREE.Mesh(sharedCyl, mat);
      beam.scale.set(1.45, Math.min(len, 1.4), 1.45);
      beam.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
      let hit = false;
      this.add(beam, 175, (o, t) => {
        o.position.copy(a).lerp(b, Math.min(1, t * 1.1));
        mat.opacity = 1 - t * 0.85;
        if (t >= 0.82 && !hit) {
          hit = true;
          this.spawnFlash(b, new THREE.Color(2.5, 1.4, 0.4), 0.65, 150);
        }
      });
      this.spawnFlash(a, new THREE.Color(2.8, 1.9, 0.7), 0.68, 130);
      this.spawnSmoke(a.x, a.y, a.z, false);
      return;
    }

    if (weapon === "melee") {
      // Electric melee slash spark
      this.spawnFlash(b, new THREE.Color(1.2, 2.4, 2.8), 0.55, 150);
      return;
    }

    // Default: crisp ballistic rifle / turret tracer
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.2, 1.9, 0.85),
      transparent: true,
      opacity: 0.92,
    });
    const beam = new THREE.Mesh(sharedCyl, mat);
    beam.scale.set(0.75, len, 0.75);
    beam.position.copy(a).lerp(b, 0.5);
    beam.quaternion.setFromUnitVectors(UP, dir.normalize());
    this.add(beam, 120, (_o, t) => (mat.opacity = 0.92 * (1 - t)));
    this.spawnFlash(a, new THREE.Color(2.6, 2.0, 0.85), 0.36, 100);
  }

  private spawnFlash(pos: THREE.Vector3, color: THREE.Color, size: number, life: number) {
    const mat = new THREE.SpriteMaterial({ color, transparent: true, opacity: 1, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.position.copy(pos);
    sp.scale.setScalar(size);
    this.add(sp, life, (o, t) => {
      o.scale.setScalar(size * (1 - t * 0.55));
      mat.opacity = 1 - t;
    });
  }

  private spawnImpactRing(x: number, z: number, radius: number, color: THREE.Color) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false });
    const ring = new THREE.Mesh(sharedRing, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.1, z);
    this.add(ring, 380, (o, t) => {
      const sc = 0.3 + t * radius * 1.5;
      o.scale.setScalar(sc);
      mat.opacity = 0.85 * (1 - t);
    });
  }

  spawnBoom(x: number, y: number, r: number) {
    const rad = Math.max(1.2, r * 1.05);
    // Fireball
    const fireMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 1.05, 0.25), transparent: true, opacity: 0.95 });
    const fire = new THREE.Mesh(sharedFire, fireMat);
    fire.position.set(x, 0.55, y);
    this.add(fire, 480, (o, t) => {
      o.scale.setScalar(0.35 + t * rad);
      o.position.y = 0.4 + t * 0.85;
      fireMat.opacity = (1 - t) * (1 - t);
    });

    // Ground shockwave ring
    this.spawnImpactRing(x, y, rad, new THREE.Color(2.2, 1.25, 0.35));

    // Flying sparks/debris chunks
    const chunks = Math.min(6, Math.max(3, Math.round(rad * 2.5)));
    for (let i = 0; i < chunks; i++) {
      const ang = (i / chunks) * Math.PI * 2 + Math.random() * 0.6;
      const spd = (1.6 + Math.random() * 2.0) * Math.min(2, rad * 0.7);
      const vy = 2.6 + Math.random() * 2.4;
      const dMat = new THREE.MeshBasicMaterial({ color: i % 2 === 0 ? 0xff9e32 : 0x323840, transparent: true, opacity: 1 });
      const deb = new THREE.Mesh(sharedSpark, dMat);
      deb.position.set(x, 0.5, y);
      this.add(deb, 520, (o, t) => {
        const s = t * 0.52;
        o.position.set(x + Math.cos(ang) * spd * s, Math.max(0.08, 0.5 + vy * s - 4.8 * s * s), y + Math.sin(ang) * spd * s);
        o.rotation.x += 0.2;
        o.rotation.y += 0.16;
        dMat.opacity = 1 - t;
      });
    }

    // Dark explosion smoke cloud
    this.spawnSmoke(x, 0.7, y, true);
    this.spawnSmoke(x + 0.3, 0.5, y - 0.25, true);
  }

  update() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    for (let i = this.fxs.length - 1; i >= 0; i--) {
      const f = this.fxs[i];
      const t = (now - f.born) / f.life;
      if (t >= 1) {
        this.scene.remove(f.obj);
        disposeFxObj(f.obj, !!f.disposeGeo);
        this.fxs.splice(i, 1);
      } else {
        f.tick(f.obj, t, dt);
      }
    }
  }

  clear() {
    for (const f of this.fxs) {
      this.scene.remove(f.obj);
      disposeFxObj(f.obj, !!f.disposeGeo);
    }
    this.fxs = [];
  }
}

function disposeFxObj(o: THREE.Object3D, disposeGeo: boolean) {
  o.traverse((c) => {
    if (c instanceof THREE.Mesh || c instanceof THREE.Line) {
      if (disposeGeo) (c.geometry as THREE.BufferGeometry)?.dispose?.();
      const m = c.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose?.();
    } else if (c instanceof THREE.Sprite) {
      (c.material as THREE.SpriteMaterial).dispose();
    }
  });
}

// ---------- Selected-Unit Waypoint Path Renderer ----------

export class WaypointOverlay {
  private group = new THREE.Group();
  private objs: THREE.Object3D[] = [];

  constructor(private scene: THREE.Scene) {
    this.group.renderOrder = 15;
    this.scene.add(this.group);
  }

  update(
    entries: { x: number; y: number; wp: [number, number, OrderKind][] }[],
    nowSec: number,
  ) {
    // Clear previous frame's waypoint segments cleanly
    for (const o of this.objs) {
      this.group.remove(o);
      if (o instanceof THREE.Line) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      } else if (o instanceof THREE.Mesh) {
        (o.material as THREE.Material).dispose();
      }
    }
    this.objs = [];
    if (!entries.length) return;

    const pulse = 0.85 + 0.2 * Math.sin(nowSec * 6);
    const seenNodes = new Set<string>();

    for (const ent of entries) {
      let px = ent.x;
      let py = ent.y;
      for (const [wx, wy, kind] of ent.wp) {
        const col = ORDER_COLORS[kind] ?? 0x4dff70;
        const pts = [new THREE.Vector3(px, 0.08, py), new THREE.Vector3(wx, 0.08, wy)];
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.78 }),
        );
        this.group.add(line);
        this.objs.push(line);

        // Deduplicate pins at identical group waypoint coordinates (rounded to 0.6 tiles)
        const key = `${Math.round(wx * 1.5)}:${Math.round(wy * 1.5)}:${kind}`;
        if (!seenNodes.has(key)) {
          seenNodes.add(key);
          const ringMat = new THREE.MeshBasicMaterial({
            color: col,
            transparent: true,
            opacity: 0.85,
            side: THREE.DoubleSide,
            depthWrite: false,
          });
          const ring = new THREE.Mesh(sharedPinRing, ringMat);
          ring.position.set(wx, 0.07, wy);
          ring.scale.setScalar(pulse);
          this.group.add(ring);
          this.objs.push(ring);

          const postMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.75 });
          const post = new THREE.Mesh(sharedPinPost, postMat);
          post.position.set(wx, 0.36, wy);
          this.group.add(post);
          this.objs.push(post);

          const headMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95 });
          const head = new THREE.Mesh(sharedPinHead, headMat);
          head.position.set(wx, 0.74 + Math.sin(nowSec * 5) * 0.06, wy);
          head.rotation.y = nowSec * 2.5;
          this.group.add(head);
          this.objs.push(head);
        }

        px = wx;
        py = wy;
      }
    }
  }

  clear() {
    this.update([], 0);
  }
}
