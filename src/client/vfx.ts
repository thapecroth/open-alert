import * as THREE from "three";
import type { OrderKind, WeaponFx } from "../shared/protocol";
import { getCraterTexture } from "./textures";

interface FxItem {
  obj: THREE.Object3D;
  born: number;
  life: number;
  tick: (o: THREE.Object3D, t: number, dt: number) => void;
  disposeGeo?: boolean;
  disposeTex?: boolean;
}

interface CraterItem {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  fading: boolean;
}

const sharedCyl = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
const sharedShell = new THREE.SphereGeometry(0.11, 8, 6);
const sharedSpark = new THREE.BoxGeometry(0.1, 0.1, 0.1);
const sharedSmoke = new THREE.DodecahedronGeometry(0.28, 0);
const sharedFire = new THREE.SphereGeometry(0.5, 10, 8);
const sharedRing = new THREE.TorusGeometry(1, 0.055, 8, 28);
const sharedBeamCyl = new THREE.CylinderGeometry(1, 1, 60, 18, 1, true);
const sharedCraterGeo = new THREE.PlaneGeometry(1, 1);
sharedCraterGeo.rotateX(-Math.PI / 2);
const sharedWakeRing = new THREE.RingGeometry(0.64, 1.0, 20);
sharedWakeRing.rotateX(-Math.PI / 2);
const sharedCone = new THREE.ConeGeometry(0.14, 0.42, 8);
const sharedPlume = new THREE.CylinderGeometry(0.28, 0.09, 1.0, 10);

const sharedPinRing = new THREE.RingGeometry(0.18, 0.28, 18);
sharedPinRing.rotateX(-Math.PI / 2);
const sharedPinPost = new THREE.CylinderGeometry(0.035, 0.035, 0.65, 6);
const sharedPinHead = new THREE.OctahedronGeometry(0.14, 0);
const sharedRallyFlag = new THREE.BoxGeometry(0.46, 0.24, 0.035);

const UP = new THREE.Vector3(0, 1, 0);
const MAX_CRATERS = 45;

let softPuffTexCache: THREE.CanvasTexture | null = null;
function getSoftPuffTex(): THREE.CanvasTexture {
  if (softPuffTexCache) return softPuffTexCache;
  const S = 64;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(255, 255, 255, 0.95)");
  g.addColorStop(0.35, "rgba(255, 255, 255, 0.62)");
  g.addColorStop(0.7, "rgba(255, 255, 255, 0.2)");
  g.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  softPuffTexCache = new THREE.CanvasTexture(c);
  softPuffTexCache.colorSpace = THREE.SRGBColorSpace;
  return softPuffTexCache;
}

const DUST_TINTS = [0xc2ad8e, 0xb49c7c, 0xa89476];

const ORDER_COLORS: Record<OrderKind, number> = {
  move: 0x4dff70,
  amove: 0xff6a3c,
  attack: 0xff3030,
  harvest: 0xffc436,
  patrol: 0x4ad8ff,
};

export class VfxSystem {
  private fxs: FxItem[] = [];
  private craters: CraterItem[] = [];
  private lastNow = performance.now();

  constructor(private scene: THREE.Scene) {}

  private add(
    obj: THREE.Object3D,
    life: number,
    tick: FxItem["tick"],
    disposeGeo = false,
    disposeTex = false,
  ) {
    this.scene.add(obj);
    this.fxs.push({ obj, born: performance.now(), life, tick, disposeGeo, disposeTex });
  }

  spawnSmoke(x: number, y: number, z: number, dark: boolean) {
    if (this.fxs.length > 160) return; // cap particle count under heavy battles
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

  spawnWake(x: number, z: number, scale = 1.0) {
    if (this.fxs.length > 190) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xdcf8ff,
      transparent: true,
      opacity: 0.48,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(sharedWakeRing, mat);
    ring.position.set(x, 0.052, z);
    ring.scale.setScalar(0.22 * scale);
    ring.renderOrder = 4;
    this.add(ring, 880, (o, t) => {
      const sc = (0.22 + t * 0.96) * scale;
      o.scale.setScalar(sc);
      mat.opacity = 0.48 * (1 - t) * (1 - t);
    });
  }

  spawnDust(x: number, z: number, scale = 1.0) {
    if (this.fxs.length > 220) return;
    const tint = DUST_TINTS[(Math.random() * DUST_TINTS.length) | 0];
    const startOp = 0.34;
    const mat = new THREE.SpriteMaterial({
      map: getSoftPuffTex(),
      color: tint,
      transparent: true,
      opacity: startOp,
      depthWrite: false,
    });
    const sp = new THREE.Sprite(mat);
    const sx = x + (Math.random() - 0.5) * 0.16;
    const sz = z + (Math.random() - 0.5) * 0.16;
    const driftX = (Math.random() - 0.5) * 0.38;
    const driftZ = (Math.random() - 0.5) * 0.38;
    sp.position.set(sx, 0.1, sz);
    sp.scale.setScalar(0.24 * scale);
    this.add(sp, 720, (o, t) => {
      const ease = 1 - Math.pow(1 - t, 1.8);
      o.position.set(sx + driftX * ease, 0.1 + ease * 0.42 * scale, sz + driftZ * ease);
      o.scale.setScalar((0.24 + ease * 0.78) * scale);
      mat.opacity = startOp * (1 - t) * (1 - t);
    });
  }

  spawnContrail(x: number, y: number, z: number, scale = 1.0) {
    if (this.fxs.length > 240) return;
    const startOp = 0.36;
    const mat = new THREE.SpriteMaterial({
      map: getSoftPuffTex(),
      color: 0xe6f9ff,
      transparent: true,
      opacity: startOp,
      depthWrite: false,
    });
    const sp = new THREE.Sprite(mat);
    sp.position.set(x, y, z);
    sp.scale.setScalar(0.16 * scale);
    this.add(sp, 760, (o, t) => {
      o.scale.setScalar((0.16 + t * 0.48) * scale);
      mat.opacity = startOp * Math.pow(1 - t, 1.65);
    });
  }

  spawnShot(
    fx: number,
    fy: number,
    tx: number,
    ty: number,
    weapon: WeaponFx = "bullet",
    vet = 0,
    startY?: number,
  ) {
    const heroic = vet >= 3;
    const a = new THREE.Vector3(fx, startY ?? (weapon === "arc" ? 1.35 : 0.72), fy);
    const b = new THREE.Vector3(tx, 0.48, ty);
    const dir = b.clone().sub(a);
    const len = Math.max(0.05, dir.length());

    if (weapon === "missile") {
      // Poseidon Dreadnought heavy high-arcing supersonic cruise missile + thick smoke trail + massive blast crater!
      const launchPos = new THREE.Vector3(fx, startY ?? 1.18, fy);
      const impactPos = new THREE.Vector3(tx, 0.25, ty);
      const horizLen = Math.max(0.1, Math.hypot(tx - fx, ty - fy));
      const arcH = Math.min(7.8, 3.2 + horizLen * 0.34);

      const mGroup = new THREE.Group();
      const bodyMesh = new THREE.Mesh(
        sharedCyl,
        new THREE.MeshBasicMaterial({ color: heroic ? 0xffdfc4 : 0xdce4ec }),
      );
      bodyMesh.scale.set(3.4, 0.95, 3.4);
      mGroup.add(bodyMesh);
      const tipMesh = new THREE.Mesh(
        sharedCone,
        new THREE.MeshBasicMaterial({ color: heroic ? new THREE.Color(3.2, 0.9, 0.3) : 0xe83824 }),
      );
      tipMesh.position.y = 0.65;
      mGroup.add(tipMesh);
      const exhaustMat = new THREE.MeshBasicMaterial({
        color: heroic ? new THREE.Color(3.6, 1.15, 0.35) : new THREE.Color(3.2, 1.45, 0.32),
      });
      const exhaust = new THREE.Mesh(sharedCone, exhaustMat);
      exhaust.rotation.x = Math.PI;
      exhaust.scale.set(1.15, 1.55, 1.15);
      exhaust.position.y = -0.68;
      mGroup.add(exhaust);

      const sc = heroic ? 1.28 : 1.05;
      mGroup.scale.setScalar(sc);
      mGroup.position.copy(launchPos);

      let smokeTick = 0;
      let impacted = false;
      const prevPos = launchPos.clone();
      const velDir = new THREE.Vector3();

      this.add(mGroup, 640, (o, t, dt) => {
        const p = launchPos.clone().lerp(impactPos, t);
        p.y += 4 * arcH * t * (1 - t);
        velDir.copy(p).sub(prevPos);
        if (velDir.lengthSq() > 0.00001) {
          o.quaternion.setFromUnitVectors(UP, velDir.normalize());
        }
        prevPos.copy(p);
        o.position.copy(p);
        exhaust.scale.y = 1.3 + Math.sin(t * 48) * 0.35;

        smokeTick += dt;
        if (smokeTick > 0.032 && t < 0.94) {
          smokeTick = 0;
          this.spawnSmoke(p.x, p.y, p.z, false);
        }
        if (t >= 0.94 && !impacted) {
          impacted = true;
          this.spawnCrater(tx, ty, heroic ? 2.75 : 2.25);
          // Massive blazing impact fireball + dual shockwaves
          const fMat = new THREE.MeshBasicMaterial({
            color: heroic ? new THREE.Color(3.4, 1.0, 0.28) : new THREE.Color(2.9, 1.2, 0.28),
            transparent: true,
            opacity: 0.98,
          });
          const fBall = new THREE.Mesh(sharedFire, fMat);
          fBall.position.set(tx, 0.6, ty);
          this.add(fBall, 560, (fo, ft) => {
            fo.scale.setScalar(0.55 + ft * (heroic ? 3.2 : 2.55));
            fo.position.y = 0.5 + ft * 1.1;
            fMat.opacity = (1 - ft) * (1 - ft);
          });
          this.spawnImpactRing(tx, ty, heroic ? 2.75 : 2.2, new THREE.Color(3.1, 1.15, 0.3), 520);
          this.spawnImpactRing(tx, ty, heroic ? 1.85 : 1.45, new THREE.Color(3.4, 2.2, 0.8), 400);
          this.spawnSmoke(tx, 0.85, ty, true);
          this.spawnSmoke(tx + 0.45, 0.65, ty - 0.35, true);
        }
      });

      this.spawnFlash(launchPos, new THREE.Color(3.2, 1.5, 0.4), 1.35, 220);
      this.spawnSmoke(launchPos.x, launchPos.y + 0.2, launchPos.z, false);
      return;
    }

    if (weapon === "torpedo") {
      // Kraken Sub fast water-skimming torpedo leaving a crisp foaming white wake + water plume splash!
      const tStart = new THREE.Vector3(fx, 0.08, fy);
      const tEnd = new THREE.Vector3(tx, 0.08, ty);
      const tDir = tEnd.clone().sub(tStart);
      const tLen = Math.max(0.1, tDir.length());
      const tUnit = tDir.clone().normalize();
      const life = Math.max(240, Math.min(620, tLen * 62));

      const torp = new THREE.Group();
      const hullM = new THREE.Mesh(sharedCyl, new THREE.MeshBasicMaterial({ color: 0x1d2a34 }));
      hullM.scale.set(2.2, 0.62, 2.2);
      torp.add(hullM);
      const tailGlow = new THREE.Mesh(
        sharedShell,
        new THREE.MeshBasicMaterial({ color: heroic ? new THREE.Color(2.4, 2.8, 3.6) : new THREE.Color(1.4, 2.5, 3.0) }),
      );
      tailGlow.scale.setScalar(0.85);
      tailGlow.position.y = -0.34;
      torp.add(tailGlow);
      torp.quaternion.setFromUnitVectors(UP, tUnit);
      torp.position.copy(tStart);

      // Persistent fading white foam wake line across the water surface
      const wakeLineMat = new THREE.MeshBasicMaterial({
        color: 0xe6fbff,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
      });
      const wakeLine = new THREE.Mesh(sharedCyl, wakeLineMat);
      wakeLine.quaternion.setFromUnitVectors(UP, tUnit);
      wakeLine.position.copy(tStart);
      wakeLine.scale.set(1.85, 0.05, 1.85);
      this.add(wakeLine, life + 520, (wo, wt) => {
        const travelU = Math.min(1, (wt * (life + 520)) / life);
        const segLen = Math.max(0.05, tLen * travelU);
        wo.scale.set(1.85 + wt * 2.2, segLen, 1.85);
        wo.position.copy(tStart).addScaledVector(tUnit, segLen * 0.5);
        wo.position.y = 0.055;
        wakeLineMat.opacity = 0.72 * (1 - wt);
      });

      let wakeTick = 0;
      let hit = false;
      this.add(torp, life, (o, t, dt) => {
        o.position.copy(tStart).lerp(tEnd, t);
        wakeTick += dt;
        if (wakeTick > 0.055 && t < 0.92) {
          wakeTick = 0;
          this.spawnWake(o.position.x, o.position.z, 0.62);
        }
        if (t >= 0.92 && !hit) {
          hit = true;
          // Dramatic tall white-aqua water plume splash on torpedo impact!
          const plumeMat = new THREE.MeshBasicMaterial({
            color: 0xdffaff,
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
          });
          const plume = new THREE.Mesh(sharedPlume, plumeMat);
          plume.position.set(tx, 0.3, ty);
          this.add(plume, 540, (po, pt) => {
            const rise = Math.sin(pt * Math.PI);
            po.scale.set(0.65 + pt * 1.45, 0.4 + rise * (heroic ? 2.6 : 2.1), 0.65 + pt * 1.45);
            po.position.y = 0.1 + rise * 1.05;
            plumeMat.opacity = 0.9 * (1 - pt);
          });
          this.spawnImpactRing(tx, ty, heroic ? 1.8 : 1.35, new THREE.Color(1.4, 2.6, 3.2), 460);
          this.spawnWake(tx, ty, 1.65);
          this.spawnFlash(
            new THREE.Vector3(tx, 0.55, ty),
            heroic ? new THREE.Color(2.6, 2.8, 3.5) : new THREE.Color(1.6, 2.6, 3.0),
            heroic ? 1.35 : 1.05,
            240,
          );
        }
      });
      this.spawnWake(fx, fy, 0.85);
      return;
    }

    if (weapon === "bomb") {
      // Tempest Bomber / Leviathan Airship heavy bomb tumbling downward from altitude -> fiery blast & scorch crater!
      const dropY = startY ?? 3.2;
      const bGroup = new THREE.Group();
      const casing = new THREE.Mesh(sharedShell, new THREE.MeshBasicMaterial({ color: 0x1e242a }));
      casing.scale.set(1.5, 2.4, 1.5);
      bGroup.add(casing);
      const fin = new THREE.Mesh(sharedCyl, new THREE.MeshBasicMaterial({ color: 0x3b444d }));
      fin.scale.set(4.4, 0.24, 4.4);
      fin.position.y = 0.24;
      bGroup.add(fin);
      const blinker = new THREE.Mesh(
        sharedShell,
        new THREE.MeshBasicMaterial({ color: heroic ? new THREE.Color(3.5, 1.0, 0.3) : new THREE.Color(3.0, 0.5, 0.2) }),
      );
      blinker.scale.setScalar(0.65);
      blinker.position.y = -0.24;
      bGroup.add(blinker);
      bGroup.position.set(fx, dropY, fy);

      let detonated = false;
      this.add(bGroup, 460, (o, t) => {
        const px = fx + (tx - fx) * t;
        const pz = fy + (ty - fy) * t;
        const py = dropY - (dropY - 0.1) * (t * t);
        o.position.set(px, py, pz);
        // Pitch & tumble nose-down as gravity accelerates the bomb
        o.rotation.x = t * 2.6;
        o.rotation.z = t * 1.4;
        if (t >= 0.94 && !detonated) {
          detonated = true;
          this.spawnCrater(tx, ty, heroic ? 2.55 : 2.1);
          const fMat = new THREE.MeshBasicMaterial({
            color: heroic ? new THREE.Color(3.5, 1.05, 0.25) : new THREE.Color(2.9, 1.18, 0.26),
            transparent: true,
            opacity: 0.96,
          });
          const fBall = new THREE.Mesh(sharedFire, fMat);
          fBall.position.set(tx, 0.55, ty);
          this.add(fBall, 520, (fo, ft) => {
            fo.scale.setScalar(0.5 + ft * (heroic ? 3.1 : 2.45));
            fo.position.y = 0.45 + ft * 1.05;
            fMat.opacity = (1 - ft) * (1 - ft);
          });
          this.spawnImpactRing(tx, ty, heroic ? 2.6 : 2.05, new THREE.Color(3.0, 1.25, 0.32), 480);
          this.spawnSmoke(tx, 0.75, ty, true);
          this.spawnSmoke(tx - 0.35, 0.6, ty + 0.3, true);
        }
      });
      return;
    }

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
      const col = heroic ? new THREE.Color(3.2, 1.1, 0.55) : new THREE.Color(1.4, 2.5, 3.2);
      const mat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 1 });
      const bolt = new THREE.Line(geo, mat);
      this.add(bolt, 210, (_o, t) => (mat.opacity = 1 - t), true);
      this.spawnFlash(b, heroic ? new THREE.Color(3.2, 1.0, 0.4) : new THREE.Color(1.0, 2.2, 3.0), heroic ? 1.15 : 0.85, 190);
      this.spawnFlash(a, heroic ? new THREE.Color(3.0, 1.1, 0.5) : new THREE.Color(1.0, 2.0, 2.8), heroic ? 0.8 : 0.6, 160);
      return;
    }

    if (weapon === "arty") {
      // High-arcing parabolic artillery shell + impact shockwave
      const col = heroic ? new THREE.Color(3.4, 0.85, 0.35) : new THREE.Color(2.4, 1.5, 0.5);
      const mat = new THREE.MeshBasicMaterial({ color: col });
      const shell = new THREE.Mesh(sharedShell, mat);
      shell.scale.setScalar(heroic ? 1.85 : 1.35);
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
          this.spawnImpactRing(b.x, b.z, heroic ? 1.55 : 1.15, heroic ? new THREE.Color(3.2, 0.8, 0.3) : new THREE.Color(2.4, 1.2, 0.35));
          this.spawnFlash(b, heroic ? new THREE.Color(3.4, 0.95, 0.35) : new THREE.Color(2.8, 1.4, 0.4), heroic ? 1.35 : 1.0, 220);
        }
      });
      this.spawnFlash(a, heroic ? new THREE.Color(3.2, 1.0, 0.4) : new THREE.Color(2.4, 1.4, 0.5), heroic ? 0.95 : 0.7, 150);
      return;
    }

    if (weapon === "rocket") {
      // Flying smoking rocket
      const col = heroic ? new THREE.Color(3.3, 0.85, 0.32) : new THREE.Color(2.5, 1.6, 0.55);
      const mat = new THREE.MeshBasicMaterial({ color: col });
      const m = new THREE.Mesh(sharedCyl, mat);
      const sc = heroic ? 2.1 : 1.5;
      m.scale.set(sc, heroic ? 0.58 : 0.42, sc);
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
          this.spawnFlash(b, heroic ? new THREE.Color(3.3, 0.9, 0.3) : new THREE.Color(2.6, 1.3, 0.35), heroic ? 1.05 : 0.75, 170);
          if (heroic) this.spawnImpactRing(b.x, b.z, 0.85, new THREE.Color(3.1, 0.85, 0.3));
        }
      });
      this.spawnFlash(a, heroic ? new THREE.Color(3.0, 0.95, 0.35) : new THREE.Color(2.2, 1.4, 0.5), heroic ? 0.65 : 0.45, 110);
      return;
    }

    if (weapon === "cannon") {
      // Heavy glowing shell streaking rapidly + muzzle puff
      const col = heroic ? new THREE.Color(3.4, 0.92, 0.3) : new THREE.Color(2.6, 1.7, 0.55);
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.98 });
      const beam = new THREE.Mesh(sharedCyl, mat);
      const thick = heroic ? 2.15 : 1.45;
      beam.scale.set(thick, Math.min(len, heroic ? 1.85 : 1.4), thick);
      beam.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
      let hit = false;
      this.add(beam, 175, (o, t) => {
        o.position.copy(a).lerp(b, Math.min(1, t * 1.1));
        mat.opacity = 1 - t * 0.85;
        if (t >= 0.82 && !hit) {
          hit = true;
          this.spawnFlash(b, heroic ? new THREE.Color(3.4, 0.95, 0.3) : new THREE.Color(2.5, 1.4, 0.4), heroic ? 0.95 : 0.65, 150);
          if (heroic) this.spawnImpactRing(b.x, b.z, 0.9, new THREE.Color(3.2, 0.85, 0.28));
        }
      });
      this.spawnFlash(a, heroic ? new THREE.Color(3.4, 1.25, 0.4) : new THREE.Color(2.8, 1.9, 0.7), heroic ? 0.95 : 0.68, 140);
      this.spawnSmoke(a.x, a.y, a.z, false);
      return;
    }

    if (weapon === "melee") {
      this.spawnFlash(b, heroic ? new THREE.Color(3.2, 0.95, 0.35) : new THREE.Color(1.2, 2.4, 2.8), heroic ? 0.8 : 0.55, 150);
      return;
    }

    // Default: crisp ballistic rifle / turret tracer
    const mat = new THREE.MeshBasicMaterial({
      color: heroic ? new THREE.Color(3.2, 0.95, 0.35) : new THREE.Color(2.2, 1.9, 0.85),
      transparent: true,
      opacity: 0.94,
    });
    const beam = new THREE.Mesh(sharedCyl, mat);
    const thick = heroic ? 1.25 : 0.75;
    beam.scale.set(thick, len, thick);
    beam.position.copy(a).lerp(b, 0.5);
    beam.quaternion.setFromUnitVectors(UP, dir.normalize());
    this.add(beam, 125, (_o, t) => (mat.opacity = 0.94 * (1 - t)));
    this.spawnFlash(a, heroic ? new THREE.Color(3.3, 1.15, 0.4) : new THREE.Color(2.6, 2.0, 0.85), heroic ? 0.56 : 0.36, 110);
    if (heroic) this.spawnFlash(b, new THREE.Color(3.0, 0.9, 0.35), 0.42, 110);
  }

  private spawnFlash(pos: THREE.Vector3, color: THREE.Color, size: number, life: number) {
    const mat = new THREE.SpriteMaterial({
      map: getSoftPuffTex(),
      color,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sp = new THREE.Sprite(mat);
    sp.position.copy(pos);
    sp.scale.setScalar(size * 1.35);
    this.add(sp, life, (o, t) => {
      o.scale.setScalar(size * 1.35 * (1 - t * 0.5));
      mat.opacity = 0.95 * (1 - t);
    });
  }

  private spawnImpactRing(x: number, z: number, radius: number, color: THREE.Color, life = 380) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.88, depthWrite: false });
    const ring = new THREE.Mesh(sharedRing, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.1, z);
    this.add(ring, life, (o, t) => {
      const sc = 0.3 + t * radius * 1.5;
      o.scale.setScalar(sc);
      mat.opacity = 0.88 * (1 - t);
    });
  }

  // ---------- Persistent Battlefield Scorch Craters ----------

  spawnCrater(x: number, y: number, r: number) {
    const mat = new THREE.MeshBasicMaterial({
      map: getCraterTexture(),
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const mesh = new THREE.Mesh(sharedCraterGeo, mat);
    const sz = Math.max(1.2, r * 2.15);
    mesh.position.set(x, 0.025, y);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    mesh.scale.set(sz, 1, sz);
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    this.craters.push({ mesh, mat, fading: false });

    // Ring-buffer cap: softly fade out oldest crater beyond MAX_CRATERS
    let liveCount = 0;
    for (const c of this.craters) if (!c.fading) liveCount++;
    if (liveCount > MAX_CRATERS) {
      for (const c of this.craters) {
        if (!c.fading) {
          c.fading = true;
          break;
        }
      }
    }
  }

  spawnBoom(x: number, y: number, r: number) {
    const rad = Math.max(1.2, r * 1.1);
    if (r >= 0.95) {
      this.spawnCrater(x, y, Math.min(3.4, r * 0.98));
    }

    // 1. Bright incandescent flash core (punchy initial blinding pop!)
    const flashMat = new THREE.SpriteMaterial({
      map: getSoftPuffTex(),
      color: new THREE.Color(4.2, 3.4, 2.1),
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    const flash = new THREE.Sprite(flashMat);
    flash.position.set(x, 0.55, y);
    const flashSize = 1.15 * rad;
    flash.scale.setScalar(flashSize * 0.6);
    this.add(flash, 180, (o, t) => {
      const pop = t < 0.25 ? 0.6 + (t / 0.25) * 0.85 : 1.45 - (t - 0.25) * 0.6;
      o.scale.setScalar(flashSize * pop);
      flashMat.opacity = Math.pow(1 - t, 1.5);
    });

    // 2. Fiery expanding explosion sphere (shifts incandescent gold-orange -> deep ember red)
    const hotCol = new THREE.Color(3.3, 1.25, 0.26);
    const coolCol = new THREE.Color(1.45, 0.3, 0.06);
    const fireMat = new THREE.MeshBasicMaterial({
      color: hotCol.clone(),
      transparent: true,
      opacity: 0.96,
    });
    const fire = new THREE.Mesh(sharedFire, fireMat);
    fire.position.set(x, 0.52, y);
    this.add(fire, 520, (o, t) => {
      const ease = 1 - Math.pow(1 - t, 2.0);
      o.scale.setScalar(0.38 + ease * rad * 1.12);
      o.position.y = 0.42 + ease * 0.95;
      fireMat.color.copy(hotCol).lerp(coolCol, Math.min(1, t * 1.35));
      fireMat.opacity = (1 - t) * (1 - t);
    });

    // 3. Crisp dual shockwave rings (outer gold-amber blast wave + fast inner pressure ring)
    this.spawnImpactRing(x, y, rad * 1.08, new THREE.Color(2.7, 1.35, 0.36), 440);
    this.spawnImpactRing(x, y, rad * 0.72, new THREE.Color(3.6, 2.8, 1.4), 260);

    // 4. Glowing HDR ember sparks & tumbling dark armor debris
    const chunks = Math.min(11, Math.max(5, Math.round(rad * 3.4)));
    for (let i = 0; i < chunks; i++) {
      const isEmber = i % 3 !== 2;
      const ang = (i / chunks) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const spd = (2.0 + Math.random() * 2.6) * Math.min(2.2, rad * 0.78);
      const vy = (isEmber ? 3.2 : 2.6) + Math.random() * 2.6;
      const dMat = new THREE.MeshBasicMaterial({
        color: isEmber
          ? i % 2 === 0
            ? new THREE.Color(3.4, 1.65, 0.35)
            : new THREE.Color(3.2, 2.35, 0.85)
          : 0x2a3038,
        transparent: true,
        opacity: 1,
      });
      const deb = new THREE.Mesh(sharedSpark, dMat);
      deb.scale.setScalar(isEmber ? 0.85 + Math.random() * 0.45 : 1.05 + Math.random() * 0.55);
      deb.position.set(x, 0.5, y);
      this.add(deb, isEmber ? 460 : 580, (o, t) => {
        const s = t * (isEmber ? 0.46 : 0.58);
        o.position.set(
          x + Math.cos(ang) * spd * s,
          Math.max(0.08, 0.5 + vy * s - 5.4 * s * s),
          y + Math.sin(ang) * spd * s,
        );
        o.rotation.x += 0.24;
        o.rotation.y += 0.18;
        dMat.opacity = 1 - t * t;
      });
    }

    // 5. Rising billowing dark blast smoke clouds
    this.spawnSmoke(x, 0.72, y, true);
    this.spawnSmoke(x + 0.34, 0.52, y - 0.28, true);
    if (rad >= 1.55) {
      this.spawnSmoke(x - 0.32, 0.58, y + 0.3, true);
    }
  }

  // ---------- Orbital Ion Cannon Sky-Beam Superweapon VFX ----------

  spawnSuperweapon(x: number, y: number) {
    // Phase 1 (0..450ms): 3 converging cyan-white plasma target rings on the ground
    for (let i = 0; i < 3; i++) {
      const startR = 5.6 - i * 1.1;
      const ringMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(1.4, 2.8, 3.6),
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(sharedRing, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.14 + i * 0.04, y);
      this.add(ring, 460 + i * 35, (o, t) => {
        const ease = t * t;
        const sc = Math.max(0.2, startR * (1 - ease * 0.92));
        o.scale.setScalar(sc);
        ringMat.opacity = t < 0.85 ? 0.3 + t * 0.7 : (1 - t) * 6;
      });
    }

    // Ground charge glow buildup during convergence
    const chargeMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.6, 3.0, 3.8),
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
    });
    const charge = new THREE.Mesh(sharedFire, chargeMat);
    charge.position.set(x, 0.25, y);
    this.add(charge, 480, (o, t) => {
      o.scale.setScalar(0.5 + t * 2.2);
      chargeMat.opacity = 0.2 + t * 0.75;
    });

    // Phase 2 & 3 (total 1700ms): Colossal orbital sky-beam descending from y=60 + blast detonation at t=0.26 (~450ms)
    const beamGroup = new THREE.Group();
    beamGroup.position.set(x, 0, y);

    const coreMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.6, 3.6, 4.2),
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const core = new THREE.Mesh(sharedBeamCyl, coreMat);
    core.position.y = 30;
    beamGroup.add(core);

    const outerMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.55, 2.0, 3.4),
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const outer = new THREE.Mesh(sharedBeamCyl, outerMat);
    outer.position.y = 30;
    beamGroup.add(outer);

    // Spiralling plasma energy helix rings cascading down the beam
    const helixMats: THREE.MeshBasicMaterial[] = [];
    const helixRings: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const hm = new THREE.MeshBasicMaterial({
        color: new THREE.Color(1.5, 3.0, 4.0),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const hr = new THREE.Mesh(sharedRing, hm);
      hr.rotation.x = Math.PI / 2 + (i % 2 === 0 ? 0.28 : -0.28);
      hr.position.y = 48;
      beamGroup.add(hr);
      helixMats.push(hm);
      helixRings.push(hr);
    }

    let detonated = false;
    this.add(beamGroup, 1700, (_o, t) => {
      const fireStart = 0.265; // ~450ms
      if (t < fireStart) {
        coreMat.opacity = 0;
        outerMat.opacity = 0;
        return;
      }
      const u = (t - fireStart) / (1 - fireStart); // 0..1 across beam duration

      if (!detonated) {
        detonated = true;
        // Massive scorch crater
        this.spawnCrater(x, y, 4.4);
        // Blinding ground impact flash core
        const blastMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(2.4, 3.2, 3.8),
          transparent: true,
          opacity: 0.98,
          depthWrite: false,
        });
        const blast = new THREE.Mesh(sharedFire, blastMat);
        blast.position.set(x, 0.8, y);
        this.add(blast, 820, (bo, bt) => {
          bo.scale.setScalar(1.4 + bt * 6.8);
          bo.position.y = 0.7 + bt * 1.4;
          blastMat.opacity = (1 - bt) * (1 - bt);
        });
        // Colossal expanding cyan plasma shockwave + secondary fiery thermal ring
        this.spawnImpactRing(x, y, 5.4, new THREE.Color(1.1, 2.8, 3.8), 760);
        this.spawnImpactRing(x, y, 4.2, new THREE.Color(3.0, 1.35, 0.32), 680);

        // 14 fiery debris & ionized chunks rocketing outward
        for (let i = 0; i < 14; i++) {
          const ang = (i / 14) * Math.PI * 2 + Math.random() * 0.35;
          const spd = 4.2 + Math.random() * 5.2;
          const vy = 4.6 + Math.random() * 4.2;
          const col = i % 3 === 0 ? 0x52e8ff : i % 2 === 0 ? 0xff9828 : 0x2e343c;
          const dMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 1 });
          const deb = new THREE.Mesh(sharedSpark, dMat);
          deb.scale.setScalar(1.6 + Math.random() * 1.2);
          deb.position.set(x, 0.7, y);
          this.add(deb, 880, (doObj, dt0) => {
            const s = dt0 * 0.88;
            doObj.position.set(
              x + Math.cos(ang) * spd * s,
              Math.max(0.1, 0.7 + vy * s - 6.4 * s * s),
              y + Math.sin(ang) * spd * s,
            );
            doObj.rotation.x += 0.24;
            doObj.rotation.y += 0.19;
            dMat.opacity = 1 - dt0;
          });
        }

        // Dense billowing blast smoke clouds
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * Math.PI * 2;
          this.spawnSmoke(x + Math.cos(ang) * 1.8, 0.9, y + Math.sin(ang) * 1.8, true);
        }
      }

      // Beam strike descent & taper envelope
      const drop = Math.min(1, u / 0.08);
      const env = u < 0.12 ? u / 0.12 : Math.pow(Math.max(0, 1 - (u - 0.12) / 0.88), 1.45);
      const pulse = 1 + 0.1 * Math.sin(u * 42);
      const coreR = Math.max(0.05, 1.55 * env * pulse);
      const outerR = Math.max(0.1, 3.05 * env * pulse);

      core.position.y = 60 - 30 * drop;
      core.scale.set(coreR, drop, coreR);
      coreMat.opacity = Math.min(0.98, env * 1.25);

      outer.position.y = 60 - 30 * drop;
      outer.scale.set(outerR, drop, outerR);
      outerMat.opacity = Math.min(0.55, env * 0.72);

      // Spiralling helix energy rings rushing downward along the sky-beam
      for (let i = 0; i < helixRings.length; i++) {
        const phase = (u * 3.2 + i * 0.25) % 1;
        helixRings[i].position.y = 46 * (1 - phase) + 0.5;
        helixRings[i].rotation.y = u * 14 + i * 1.6;
        const rSc = Math.max(0.1, (2.2 + 0.6 * Math.sin(phase * Math.PI)) * env);
        helixRings[i].scale.setScalar(rSc);
        helixMats[i].opacity = env * (1 - phase * 0.5) * 0.85;
      }
    });
  }

  // ---------- Radar Recon Scan VFX (3 expanding cyan pulses + rotating sweep line over 2.4s) ----------

  spawnRecon(x: number, y: number, r: number) {
    const duration = 2400;
    const rad = Math.max(2, r);

    // 3 concentric expanding cyan radar scan pulses staggered across 2.4s
    for (let i = 0; i < 3; i++) {
      const delay = i * 0.22; // 0, 0.22, 0.44
      const span = 1 - delay;
      const pulseMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.55, 2.35, 3.2),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(sharedRing, pulseMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.14 + i * 0.015, y);
      ring.renderOrder = 16;
      this.add(ring, duration, (o, t) => {
        if (t < delay) {
          pulseMat.opacity = 0;
          o.scale.setScalar(0.15);
          return;
        }
        const u = Math.min(1, (t - delay) / span);
        const ease = 1 - Math.pow(1 - u, 1.8);
        const sc = 0.35 + ease * (rad - 0.35);
        o.scale.set(sc, sc, Math.max(0.18, 0.9 - ease * 0.65));
        const fadeIn = Math.min(1, u / 0.08);
        const fadeOut = Math.pow(Math.max(0, 1 - u), 1.35);
        pulseMat.opacity = 0.9 * fadeIn * fadeOut;
      });
    }

    // Outer tactical scan perimeter ring marking full reveal radius
    const rimMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.38, 1.95, 2.75),
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const rim = new THREE.Mesh(sharedRing, rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(x, 0.12, y);
    rim.scale.set(rad, rad, 0.25);
    rim.renderOrder = 15;
    this.add(rim, duration, (_o, t) => {
      const env = t < 0.1 ? t / 0.1 : t > 0.72 ? (1 - t) / 0.28 : 1;
      rimMat.opacity = 0.48 * env * (0.85 + 0.15 * Math.sin(t * 28));
    });

    // Rotating radar sweep beam + soft glowing trailing sector on the ground
    const sweepGroup = new THREE.Group();
    sweepGroup.position.set(x, 0.15, y);
    sweepGroup.renderOrder = 17;

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(rad, 0, 0),
    ]);
    const lineMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(0.85, 2.8, 3.6),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const sweepLine = new THREE.Line(lineGeo, lineMat);
    sweepGroup.add(sweepLine);

    // Trailing radar sweep cone wedge behind the clockwise rotating line
    const wedgeGeo = new THREE.CircleGeometry(rad, 20, 0, Math.PI / 4);
    wedgeGeo.rotateX(-Math.PI / 2);
    const wedgeMat = new THREE.MeshBasicMaterial({
      color: 0x3ce4ff,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const wedge = new THREE.Mesh(wedgeGeo, wedgeMat);
    sweepGroup.add(wedge);

    // Center radar lock ping dot
    const dotGeo = new THREE.CircleGeometry(0.42, 16);
    dotGeo.rotateX(-Math.PI / 2);
    const dotMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.0, 2.8, 3.6),
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.position.y = 0.02;
    sweepGroup.add(dot);

    this.add(
      sweepGroup,
      duration,
      (o, t) => {
        // 2.5 crisp revolutions over 2.4s
        o.rotation.y = -t * Math.PI * 5;
        const env = t < 0.08 ? t / 0.08 : t > 0.72 ? (1 - t) / 0.28 : 1;
        lineMat.opacity = 0.95 * env;
        wedgeMat.opacity = 0.18 * env;
        dotMat.opacity = 0.92 * env;
        const p = 0.85 + 0.35 * Math.sin(t * 24);
        dot.scale.setScalar(p);
      },
      true,
    );
  }

  // ---------- Floating World-Space Text Popups ----------

  spawnPopup(x: number, y: number, text: string, color = "#ffd84d") {
    const W = 384;
    const H = 80;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);

    ctx.font = "900 32px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";

    // Crisp dark outline + subtle colored glow for high readability over terrain & explosions
    ctx.strokeStyle = "rgba(6, 10, 16, 0.92)";
    ctx.lineWidth = 8;
    ctx.strokeText(text, W / 2, H / 2);

    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.fillStyle = color;
    ctx.fillText(text, W / 2, H / 2);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    const sp = new THREE.Sprite(mat);
    const startY = 1.65;
    sp.position.set(x, startY, y);
    sp.renderOrder = 30;
    const baseW = 3.8;
    const baseH = baseW * (H / W);
    sp.scale.set(baseW, baseH, 1);

    this.add(
      sp,
      1400,
      (o, t) => {
        const easeOut = 1 - Math.pow(1 - t, 2.2);
        o.position.y = startY + easeOut * 2.1;
        const pop = t < 0.12 ? 0.72 + (t / 0.12) * 0.36 : t < 0.24 ? 1.08 - ((t - 0.12) / 0.12) * 0.08 : 1;
        o.scale.set(baseW * pop, baseH * pop, 1);
        mat.opacity = t > 0.58 ? Math.max(0, 1 - (t - 0.58) / 0.42) : 1;
      },
      false,
      true,
    );
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
        disposeFxObj(f.obj, !!f.disposeGeo, !!f.disposeTex);
        this.fxs.splice(i, 1);
      } else {
        f.tick(f.obj, t, dt);
      }
    }

    // Fade out overflow craters cleanly
    for (let i = this.craters.length - 1; i >= 0; i--) {
      const c = this.craters[i];
      if (!c.fading) continue;
      c.mat.opacity -= dt * 0.75;
      if (c.mat.opacity <= 0.02) {
        this.scene.remove(c.mesh);
        c.mat.dispose();
        this.craters.splice(i, 1);
      }
    }
  }

  clear() {
    for (const f of this.fxs) {
      this.scene.remove(f.obj);
      disposeFxObj(f.obj, !!f.disposeGeo, !!f.disposeTex);
    }
    this.fxs = [];
    for (const c of this.craters) {
      this.scene.remove(c.mesh);
      c.mat.dispose();
    }
    this.craters = [];
  }
}

function disposeFxObj(o: THREE.Object3D, disposeGeo: boolean, disposeTex = false) {
  o.traverse((c) => {
    if (c instanceof THREE.Mesh || c instanceof THREE.Line) {
      if (disposeGeo) (c.geometry as THREE.BufferGeometry)?.dispose?.();
      const m = c.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose?.();
    } else if (c instanceof THREE.Sprite) {
      const sm = c.material as THREE.SpriteMaterial;
      if (disposeTex && sm.map) sm.map.dispose();
      sm.dispose();
    }
  });
}

// ---------- Selected-Unit Waypoint & Building Rally Line Renderer ----------

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
    rallies: { x: number; y: number; rx: number; ry: number }[] = [],
  ) {
    // Clear previous frame's waypoint & rally segments cleanly
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
    if (!entries.length && !rallies.length) return;

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

    // Crisp cyan rally lines & animated flag pins for selected production buildings
    const RALLY_COL = 0x44f0ff;
    for (const r of rallies) {
      const pts = [new THREE.Vector3(r.x, 0.14, r.y), new THREE.Vector3(r.rx, 0.09, r.ry)];
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: RALLY_COL, transparent: true, opacity: 0.88 }),
      );
      this.group.add(line);
      this.objs.push(line);

      const ring = new THREE.Mesh(
        sharedPinRing,
        new THREE.MeshBasicMaterial({
          color: RALLY_COL,
          transparent: true,
          opacity: 0.88,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      ring.position.set(r.rx, 0.07, r.ry);
      ring.scale.setScalar(pulse * 1.15);
      this.group.add(ring);
      this.objs.push(ring);

      const post = new THREE.Mesh(
        sharedPinPost,
        new THREE.MeshBasicMaterial({ color: 0xbef9ff, transparent: true, opacity: 0.9 }),
      );
      post.position.set(r.rx, 0.45, r.ry);
      post.scale.set(1, 1.35, 1);
      this.group.add(post);
      this.objs.push(post);

      const flag = new THREE.Mesh(
        sharedRallyFlag,
        new THREE.MeshBasicMaterial({ color: RALLY_COL, transparent: true, opacity: 0.95 }),
      );
      flag.position.set(r.rx + 0.23, 0.76, r.ry);
      flag.rotation.y = Math.sin(nowSec * 4.5) * 0.24;
      this.group.add(flag);
      this.objs.push(flag);
    }
  }

  clear() {
    this.update([], 0, []);
  }
}
