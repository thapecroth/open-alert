import * as THREE from "three";
import type { EntKind } from "../shared/gamedefs";
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

const ORDER_KINDS: readonly OrderKind[] = ["move", "amove", "attack", "harvest", "patrol"];
const ORDER_KIND_INDEX: Record<OrderKind, number> = {
  move: 0,
  amove: 1,
  attack: 2,
  harvest: 3,
  patrol: 4,
};
const ORDER_COLOR_OBJS: Record<OrderKind, THREE.Color> = {
  move: new THREE.Color(ORDER_COLORS.move),
  amove: new THREE.Color(ORDER_COLORS.amove),
  attack: new THREE.Color(ORDER_COLORS.attack),
  harvest: new THREE.Color(ORDER_COLORS.harvest),
  patrol: new THREE.Color(ORDER_COLORS.patrol),
};

const WHITE_COL = new THREE.Color(0xffffff);
const SMOKE_DARK_COL = new THREE.Color(0x26292e);
const SMOKE_LIGHT_COL = new THREE.Color(0x8ea0ad);
const WAKE_COL = new THREE.Color(0xdcf8ff);
const CONTRAIL_COL = new THREE.Color(0xe6f9ff);
const HYPER_CONTRAIL_COL = new THREE.Color(2.0, 3.0, 3.6);
const DUST_COLOR_OBJS = DUST_TINTS.map((hex) => new THREE.Color(hex));

const RALLY_COL = 0x44f0ff;
const RALLY_COLOR_OBJ = new THREE.Color(RALLY_COL);
const RALLY_POST_COLOR_OBJ = new THREE.Color(0xbef9ff);

const SMOKE_CAP = 128;
const WAKE_CAP = 96;
const PUFF_CAP = 128;

// Reusable scratch transforms (zero per-frame heap allocations)
const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

interface SmokeSlot {
  born: number;
  life: number;
  sx: number;
  sy: number;
  sz: number;
  driftX: number;
  driftZ: number;
  riseY: number;
  baseScale: number;
  baseAlpha: number;
  dark: boolean;
}

interface WakeSlot {
  born: number;
  life: number;
  x: number;
  z: number;
  scale: number;
}

interface PuffSlot {
  born: number;
  life: number;
  isDust: boolean;
  sx: number;
  sy: number;
  sz: number;
  driftX: number;
  driftZ: number;
  scale: number;
  color: THREE.Color;
}

function initInstancedPool(inst: THREE.InstancedMesh, cap: number, defaultColor: THREE.Color) {
  const arr = new Float32Array(cap * 3);
  for (let i = 0; i < cap; i++) {
    arr[i * 3] = defaultColor.r;
    arr[i * 3 + 1] = defaultColor.g;
    arr[i * 3 + 2] = defaultColor.b;
  }
  inst.instanceColor = new THREE.InstancedBufferAttribute(arr, 3);
  inst.instanceColor.setUsage(THREE.DynamicDrawUsage);
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  inst.frustumCulled = false;
  inst.count = 0;
  inst.visible = false;
}

function attachPerInstanceAlpha(mat: THREE.MeshBasicMaterial, billboard: boolean) {
  mat.customProgramCacheKey = () => (billboard ? "vfx-inst-billboard-alpha" : "vfx-inst-alpha");
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aAlpha;\nvarying float vInstAlpha;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvInstAlpha = aAlpha;");
    if (billboard) {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <project_vertex>",
        `#ifdef USE_INSTANCING
vec4 mvPosition = modelViewMatrix * vec4( instanceMatrix[3].xyz, 1.0 );
mvPosition.xy += transformed.xy * vec2( length( instanceMatrix[0].xyz ), length( instanceMatrix[1].xyz ) );
gl_Position = projectionMatrix * mvPosition;
#else
#include <project_vertex>
#endif`,
      );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vInstAlpha;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a *= vInstAlpha;");
  };
}

export class VfxSystem {
  private fxs: FxItem[] = [];
  private craters: CraterItem[] = [];
  private lastNow = performance.now();

  // Fixed-capacity GPU InstancedMesh particle pools (zero per-particle Mesh/Material GC)
  private smokeInst: THREE.InstancedMesh;
  private smokeAlphaArr: Float32Array;
  private smokeAlphaAttr: THREE.InstancedBufferAttribute;
  private smokeSlots: SmokeSlot[];
  private smokeCount = 0;

  private wakeInst: THREE.InstancedMesh;
  private wakeAlphaArr: Float32Array;
  private wakeAlphaAttr: THREE.InstancedBufferAttribute;
  private wakeSlots: WakeSlot[];
  private wakeCount = 0;

  private puffInst: THREE.InstancedMesh;
  private puffAlphaArr: Float32Array;
  private puffAlphaAttr: THREE.InstancedBufferAttribute;
  private puffSlots: PuffSlot[];
  private puffCount = 0;

  constructor(private scene: THREE.Scene) {
    // 1. Smoke pool (dark battle smoke & light industrial exhaust)
    const smokeGeo = sharedSmoke.clone();
    this.smokeAlphaArr = new Float32Array(SMOKE_CAP);
    this.smokeAlphaAttr = new THREE.InstancedBufferAttribute(this.smokeAlphaArr, 1);
    this.smokeAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    smokeGeo.setAttribute("aAlpha", this.smokeAlphaAttr);
    const smokeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    attachPerInstanceAlpha(smokeMat, false);
    this.smokeInst = new THREE.InstancedMesh(smokeGeo, smokeMat, SMOKE_CAP);
    initInstancedPool(this.smokeInst, SMOKE_CAP, SMOKE_LIGHT_COL);
    this.scene.add(this.smokeInst);
    this.smokeSlots = Array.from({ length: SMOKE_CAP }, () => ({
      born: 0,
      life: 1,
      sx: 0,
      sy: 0,
      sz: 0,
      driftX: 0,
      driftZ: 0,
      riseY: 2,
      baseScale: 0.5,
      baseAlpha: 0.3,
      dark: false,
    }));

    // 2. Water wake ring pool (warships & torpedoes)
    const wakeGeo = sharedWakeRing.clone();
    this.wakeAlphaArr = new Float32Array(WAKE_CAP);
    this.wakeAlphaAttr = new THREE.InstancedBufferAttribute(this.wakeAlphaArr, 1);
    this.wakeAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    wakeGeo.setAttribute("aAlpha", this.wakeAlphaAttr);
    const wakeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    attachPerInstanceAlpha(wakeMat, false);
    this.wakeInst = new THREE.InstancedMesh(wakeGeo, wakeMat, WAKE_CAP);
    initInstancedPool(this.wakeInst, WAKE_CAP, WAKE_COL);
    this.wakeInst.renderOrder = 4;
    this.scene.add(this.wakeInst);
    this.wakeSlots = Array.from({ length: WAKE_CAP }, () => ({
      born: 0,
      life: 1,
      x: 0,
      z: 0,
      scale: 1,
    }));

    // 3. Soft camera-facing puff billboard pool (tank dust plumes + jet wingtip contrails)
    const puffGeo = new THREE.PlaneGeometry(1, 1);
    this.puffAlphaArr = new Float32Array(PUFF_CAP);
    this.puffAlphaAttr = new THREE.InstancedBufferAttribute(this.puffAlphaArr, 1);
    this.puffAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    puffGeo.setAttribute("aAlpha", this.puffAlphaAttr);
    const puffMat = new THREE.MeshBasicMaterial({
      map: getSoftPuffTex(),
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    attachPerInstanceAlpha(puffMat, true);
    this.puffInst = new THREE.InstancedMesh(puffGeo, puffMat, PUFF_CAP);
    initInstancedPool(this.puffInst, PUFF_CAP, WHITE_COL);
    this.scene.add(this.puffInst);
    this.puffSlots = Array.from({ length: PUFF_CAP }, () => ({
      born: 0,
      life: 1,
      isDust: true,
      sx: 0,
      sy: 0,
      sz: 0,
      driftX: 0,
      driftZ: 0,
      scale: 1,
      color: DUST_COLOR_OBJS[0],
    }));
  }

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
    if (this.smokeCount >= SMOKE_CAP) return;
    const s = this.smokeSlots[this.smokeCount++];
    s.born = performance.now();
    s.life = dark ? 1150 : 1400;
    s.sx = x + (Math.random() - 0.5) * 0.18;
    s.sy = y;
    s.sz = z + (Math.random() - 0.5) * 0.18;
    s.driftX = (Math.random() - 0.5) * 0.45;
    s.driftZ = (Math.random() - 0.5) * 0.45;
    s.riseY = dark ? 1.8 : 2.2;
    s.baseScale = dark ? 0.65 : 0.48;
    s.baseAlpha = dark ? 0.52 : 0.26;
    s.dark = dark;
  }

  spawnWake(x: number, z: number, scale = 1.0) {
    if (this.wakeCount >= WAKE_CAP) return;
    const w = this.wakeSlots[this.wakeCount++];
    w.born = performance.now();
    w.life = 880;
    w.x = x;
    w.z = z;
    w.scale = scale;
  }

  spawnDust(x: number, z: number, scale = 1.0) {
    if (this.puffCount >= PUFF_CAP) return;
    const p = this.puffSlots[this.puffCount++];
    p.born = performance.now();
    p.life = 720;
    p.isDust = true;
    p.sx = x + (Math.random() - 0.5) * 0.16;
    p.sy = 0.1;
    p.sz = z + (Math.random() - 0.5) * 0.16;
    p.driftX = (Math.random() - 0.5) * 0.38;
    p.driftZ = (Math.random() - 0.5) * 0.38;
    p.scale = scale;
    p.color = DUST_COLOR_OBJS[(Math.random() * DUST_COLOR_OBJS.length) | 0];
  }

  spawnContrail(x: number, y: number, z: number, scale = 1.0) {
    if (this.puffCount >= PUFF_CAP) return;
    const p = this.puffSlots[this.puffCount++];
    p.born = performance.now();
    p.life = scale >= 1.3 ? 620 : 760;
    p.isDust = false;
    p.sx = x;
    p.sy = y;
    p.sz = z;
    p.driftX = 0;
    p.driftZ = 0;
    p.scale = scale;
    p.color = scale >= 1.3 ? HYPER_CONTRAIL_COL : CONTRAIL_COL;
  }

  spawnShot(
    fx: number,
    fy: number,
    tx: number,
    ty: number,
    weapon: WeaponFx = "bullet",
    vet = 0,
    startY?: number,
    srcKind?: EntKind,
  ) {
    if (weapon === "intercept") {
      this.spawnIntercept(fx, fy, tx, ty);
      return;
    }
    const heroic = vet >= 3;
    const a = new THREE.Vector3(fx, startY ?? (weapon === "arc" ? 1.35 : weapon === "laser" ? 1.65 : 0.72), fy);
    const b = new THREE.Vector3(tx, 0.48, ty);
    const dir = b.clone().sub(a);
    const len = Math.max(0.05, dir.length());

    if (weapon === "laser") {
      // Helios Laser / Defense Satellite: intense searing continuous golden-cyan focused thermal beam (240ms)
      const isOrbital = srcKind === "satlink" || (startY !== undefined && startY >= 12);
      const laserA = isOrbital ? new THREE.Vector3(fx, 24, fy) : new THREE.Vector3(fx, startY ?? 1.65, fy);
      const laserB = new THREE.Vector3(tx, 0.42, ty);
      const lDir = laserB.clone().sub(laserA);
      const lLen = Math.max(0.1, lDir.length());
      const lUnit = lDir.clone().normalize();
      const mid = laserA.clone().lerp(laserB, 0.5);

      const beamGroup = new THREE.Group();
      beamGroup.position.copy(mid);
      beamGroup.quaternion.setFromUnitVectors(UP, lUnit);

      // Incandescent golden-white inner thermal core
      const coreMat = new THREE.MeshBasicMaterial({
        color: heroic ? new THREE.Color(4.4, 2.35, 1.05) : new THREE.Color(4.1, 3.35, 1.75),
        transparent: true,
        opacity: 0.98,
        depthWrite: false,
      });
      const coreMesh = new THREE.Mesh(sharedCyl, coreMat);
      const coreThick = (isOrbital ? 3.2 : 2.15) * (heroic ? 1.25 : 1.0);
      coreMesh.scale.set(coreThick, lLen, coreThick);
      beamGroup.add(coreMesh);

      // Searing outer cyan-gold plasma sheath
      const sheathMat = new THREE.MeshBasicMaterial({
        color: isOrbital ? new THREE.Color(1.4, 3.3, 4.1) : new THREE.Color(1.5, 3.1, 3.5),
        transparent: true,
        opacity: 0.68,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sheathMesh = new THREE.Mesh(sharedCyl, sheathMat);
      const sheathThick = coreThick * 2.35;
      sheathMesh.scale.set(sheathThick, lLen, sheathThick);
      beamGroup.add(sheathMesh);

      this.add(beamGroup, 240, (_o, t) => {
        const pulse = 1 + 0.16 * Math.sin(t * 48);
        const taper = t < 0.72 ? 1.0 : Math.max(0.05, 1 - (t - 0.72) / 0.28);
        const cW = coreThick * pulse * taper;
        const sW = sheathThick * (1 + t * 0.22) * taper;
        coreMesh.scale.set(cW, lLen, cW);
        sheathMesh.scale.set(sW, lLen, sW);
        coreMat.opacity = 0.98 * taper;
        sheathMat.opacity = 0.68 * (1 - t * 0.85);
      });

      // Muzzle emitter flare + intense glowing scorching impact ring & flash!
      this.spawnFlash(
        laserA,
        isOrbital ? new THREE.Color(2.2, 3.6, 4.4) : new THREE.Color(3.6, 2.9, 1.4),
        isOrbital ? 1.9 : heroic ? 1.15 : 0.88,
        220,
      );
      this.spawnFlash(
        laserB,
        heroic ? new THREE.Color(4.2, 2.2, 0.95) : new THREE.Color(4.0, 3.1, 1.5),
        isOrbital ? 1.75 : heroic ? 1.4 : 1.12,
        260,
      );
      this.spawnImpactRing(
        tx,
        ty,
        isOrbital ? 1.85 : heroic ? 1.45 : 1.12,
        new THREE.Color(3.4, 2.3, 0.85),
        340,
      );
      this.spawnImpactRing(
        tx,
        ty,
        isOrbital ? 1.25 : 0.82,
        new THREE.Color(1.2, 3.1, 3.8),
        270,
      );
      this.spawnSmoke(tx, 0.32, ty, true);
      return;
    }

    if (weapon === "railgun") {
      // Aegis Railgun MBT: blazing hyper-velocity cyan-white rail bolt + 3 expanding EM vortex shock rings + blinding flash!
      const railUnit = dir.clone().normalize();
      const mid = a.clone().lerp(b, 0.5);

      const boltGroup = new THREE.Group();
      boltGroup.position.copy(mid);
      boltGroup.quaternion.setFromUnitVectors(UP, railUnit);

      // Blazing cyan-white hyper-velocity inner core
      const coreMat = new THREE.MeshBasicMaterial({
        color: heroic ? new THREE.Color(3.8, 2.8, 4.6) : new THREE.Color(2.8, 4.0, 4.6),
        transparent: true,
        opacity: 1.0,
        depthWrite: false,
      });
      const coreMesh = new THREE.Mesh(sharedCyl, coreMat);
      const coreThick = heroic ? 2.45 : 1.85;
      coreMesh.scale.set(coreThick, len, coreThick);
      boltGroup.add(coreMesh);

      // Outer electric cyan plasma corona
      const haloMat = new THREE.MeshBasicMaterial({
        color: heroic ? new THREE.Color(2.4, 1.5, 4.0) : new THREE.Color(0.75, 2.75, 4.1),
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const haloMesh = new THREE.Mesh(sharedCyl, haloMat);
      const haloThick = coreThick * 2.7;
      haloMesh.scale.set(haloThick, len, haloThick);
      boltGroup.add(haloMesh);

      this.add(boltGroup, 220, (_o, t) => {
        const snap = Math.max(0.06, Math.pow(1 - t, 1.25));
        coreMesh.scale.set(coreThick * snap, len, coreThick * snap);
        haloMesh.scale.set(haloThick * (1 + t * 0.55), len, haloThick * (1 + t * 0.55));
        coreMat.opacity = snap;
        haloMat.opacity = 0.65 * (1 - t) * (1 - t);
      });

      // 3 expanding electromagnetic vortex shock rings spaced along the barrel path
      const zAxis = new THREE.Vector3(0, 0, 1);
      const ringQuat = new THREE.Quaternion().setFromUnitVectors(zAxis, railUnit);
      const fracs = [0.2, 0.48, 0.76];
      for (let i = 0; i < fracs.length; i++) {
        const u = fracs[i];
        const rPos = a.clone().lerp(b, u);
        const rMat = new THREE.MeshBasicMaterial({
          color: i === 1 ? new THREE.Color(2.0, 3.6, 4.4) : new THREE.Color(0.85, 2.8, 4.2),
          transparent: true,
          opacity: 0.92,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const ring = new THREE.Mesh(sharedRing, rMat);
        ring.position.copy(rPos);
        ring.quaternion.copy(ringQuat);
        ring.scale.setScalar(0.12);
        const maxR = (heroic ? 1.15 : 0.85) * (1 - i * 0.12);
        const delay = i * 0.08;
        this.add(ring, 320 + i * 35, (ro, t) => {
          if (t < delay) {
            rMat.opacity = 0;
            return;
          }
          const rt = (t - delay) / (1 - delay);
          const ease = 1 - Math.pow(1 - rt, 2.0);
          const sc = 0.12 + ease * maxR;
          ro.scale.setScalar(sc);
          ro.rotateZ(0.14);
          rMat.opacity = 0.92 * (1 - rt) * (1 - rt);
        });
      }

      // Muzzle discharge flash + blinding impact flash + electromagnetic ground shockwave
      this.spawnFlash(a, new THREE.Color(2.2, 3.7, 4.4), heroic ? 1.25 : 0.95, 180);
      this.spawnFlash(b, new THREE.Color(3.2, 4.1, 4.8), heroic ? 1.75 : 1.38, 250);
      this.spawnImpactRing(b.x, b.z, heroic ? 1.65 : 1.28, new THREE.Color(1.2, 3.1, 4.2), 340);
      return;
    }

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

  /** Subtle emerald-green logistics resupply shimmer ring around refueled / rearmed units */
  spawnResupplyPulse(x: number, y: number, radius = 0.85) {
    const riseMat = new THREE.MeshBasicMaterial({
      color: 0x3ef58c,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const riseRing = new THREE.Mesh(sharedRing, riseMat);
    riseRing.rotation.x = -Math.PI / 2;
    riseRing.position.set(x, 0.12, y);
    riseRing.scale.setScalar(radius * 0.62);
    this.add(riseRing, 580, (o, t) => {
      const ease = 1 - Math.pow(1 - t, 2);
      o.position.y = 0.12 + ease * 0.78;
      const sc = radius * (0.62 + ease * 0.45);
      o.scale.setScalar(sc);
      riseMat.opacity = 0.72 * (1 - t) * (1 - t);
    });

    const groundMat = new THREE.MeshBasicMaterial({
      color: 0x26df74,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
    });
    const groundRing = new THREE.Mesh(sharedRing, groundMat);
    groundRing.rotation.x = -Math.PI / 2;
    groundRing.position.set(x, 0.08, y);
    groundRing.scale.setScalar(radius * 0.45);
    this.add(groundRing, 520, (o, t) => {
      const sc = radius * (0.45 + t * 0.95);
      o.scale.setScalar(sc);
      groundMat.opacity = 0.48 * (1 - t);
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
        o.rotation.x = s * 14.4;
        o.rotation.y = s * 10.8;
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
            doObj.rotation.x = s * 14.4;
            doObj.rotation.y = s * 11.4;
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

  // ---------- Iron Dome Midair Interception VFX ----------

  spawnIntercept(fx: number, fy: number, tx: number, ty: number) {
    const start = new THREE.Vector3(fx, 1.3, fy);
    const midX = (fx + tx) * 0.5;
    const midZ = (fy + ty) * 0.5;
    const end = new THREE.Vector3(midX, 3.8, midZ);

    // Build curved interceptor trajectory points (steep vertical Iron Dome climb curving into midair intercept)
    const curvePts: THREE.Vector3[] = [];
    const segs = 14;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const p = start.clone().lerp(end, u);
      p.y += Math.sin(u * Math.PI) * 1.18;
      curvePts.push(p);
    }

    // Glowing cyan-gold curved interceptor streak ribbon
    const trailGeo = new THREE.BufferGeometry().setFromPoints(curvePts);
    trailGeo.setDrawRange(0, 2);
    const trailMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(1.9, 3.3, 3.9),
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    });
    const trailLine = new THREE.Line(trailGeo, trailMat);
    const flightMs = 240;
    const trailLife = 540;
    this.add(
      trailLine,
      trailLife,
      (_o, t) => {
        const flightU = Math.min(1, (t * trailLife) / flightMs);
        const count = Math.max(2, Math.min(segs + 1, Math.ceil(flightU * (segs + 1))));
        trailGeo.setDrawRange(0, count);
        trailMat.opacity = t < 0.45 ? 0.96 : Math.max(0, 0.96 * (1 - (t - 0.45) / 0.55));
      },
      true,
    );

    // Swift glowing cyan-gold interceptor missile dart
    const dart = new THREE.Group();
    const dartBody = new THREE.Mesh(
      sharedCyl,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 3.5, 4.1) }),
    );
    dartBody.scale.set(2.0, 0.52, 2.0);
    dart.add(dartBody);
    const dartTip = new THREE.Mesh(
      sharedCone,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(3.6, 2.7, 1.0) }),
    );
    dartTip.scale.set(0.65, 0.72, 0.65);
    dartTip.position.y = 0.36;
    dart.add(dartTip);
    const dartExhaust = new THREE.Mesh(
      sharedCone,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(3.5, 2.4, 0.85) }),
    );
    dartExhaust.rotation.x = Math.PI;
    dartExhaust.scale.set(0.85, 1.35, 0.85);
    dartExhaust.position.y = -0.4;
    dart.add(dartExhaust);
    dart.position.copy(start);

    let smokeTick = 0;
    let intercepted = false;
    const prevP = start.clone();
    const vel = new THREE.Vector3();

    this.add(dart, flightMs, (o, t, dt) => {
      const p = start.clone().lerp(end, t);
      p.y += Math.sin(t * Math.PI) * 1.18;
      vel.copy(p).sub(prevP);
      if (vel.lengthSq() > 0.00001) {
        o.quaternion.setFromUnitVectors(UP, vel.normalize());
      }
      prevP.copy(p);
      o.position.copy(p);

      smokeTick += dt;
      if (smokeTick > 0.045 && t < 0.88) {
        smokeTick = 0;
        this.spawnContrail(p.x, p.y, p.z, 0.9);
      }

      if (t >= 0.9 && !intercepted) {
        intercepted = true;
        // Crisp bright cyan-white midair airburst flash
        this.spawnFlash(end, new THREE.Color(2.8, 4.0, 4.6), 1.85, 280);
        this.spawnFlash(end, new THREE.Color(3.8, 2.9, 1.3), 1.15, 200);

        // Crisp midair core flash sphere
        const burstMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(2.4, 3.8, 4.4),
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const burst = new THREE.Mesh(sharedFire, burstMat);
        burst.position.copy(end);
        this.add(burst, 280, (bo, bt) => {
          bo.scale.setScalar(0.28 + bt * 1.65);
          burstMat.opacity = 0.95 * (1 - bt) * (1 - bt);
        });

        // Expanding 3D midair cyan-white & gold shockwave rings
        const ringMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(1.6, 3.6, 4.4),
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const ring = new THREE.Mesh(sharedRing, ringMat);
        ring.position.copy(end);
        ring.rotation.x = -Math.PI / 2 + 0.35;
        ring.rotation.z = Math.random() * Math.PI;
        this.add(ring, 360, (ro, rt) => {
          const sc = 0.25 + rt * 2.15;
          ro.scale.setScalar(sc);
          ringMat.opacity = 0.95 * (1 - rt);
        });

        const ring2Mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(3.4, 2.6, 1.0),
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const ring2 = new THREE.Mesh(sharedRing, ring2Mat);
        ring2.position.copy(end);
        ring2.rotation.x = -Math.PI / 2 - 0.35;
        this.add(ring2, 300, (ro, rt) => {
          const sc = 0.2 + rt * 1.55;
          ro.scale.setScalar(sc);
          ring2Mat.opacity = 0.85 * (1 - rt);
        });

        // Floating "INTERCEPTED!" popup right at the midair intercept point
        this.spawnPopup(midX, midZ, "INTERCEPTED!", "#5cf4ff", 3.85);
      }
    });

    // Launch tube flare at Iron Dome battery
    this.spawnFlash(start, new THREE.Color(3.2, 2.5, 1.1), 0.95, 170);
  }

  // ---------- Floating World-Space Text Popups ----------

  spawnPopup(x: number, y: number, text: string, color = "#ffd84d", startY = 1.65) {
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

    // Update GPU-instanced smoke pool in-place (zero GC)
    this.updateSmokePool(now);
    // Update GPU-instanced wake pool in-place (zero GC)
    this.updateWakePool(now);
    // Update GPU-instanced dust + contrail billboard pool in-place (zero GC)
    this.updatePuffPool(now);

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

  private updateSmokePool(now: number) {
    if (this.smokeCount === 0) {
      if (this.smokeInst.visible) {
        this.smokeInst.count = 0;
        this.smokeInst.visible = false;
      }
      return;
    }
    let i = 0;
    while (i < this.smokeCount) {
      const s = this.smokeSlots[i];
      const t = (now - s.born) / s.life;
      if (t >= 1) {
        const last = --this.smokeCount;
        this.smokeSlots[i] = this.smokeSlots[last];
        this.smokeSlots[last] = s;
        continue;
      }
      const tc = t < 0 ? 0 : t;
      const sc = s.baseScale + tc * 1.4;
      _pos.set(s.sx + s.driftX * tc, s.sy + tc * s.riseY, s.sz + s.driftZ * tc);
      _quat.setFromAxisAngle(UP, tc * 1.4);
      _scale.set(sc, sc, sc);
      _mat4.compose(_pos, _quat, _scale);
      this.smokeInst.setMatrixAt(i, _mat4);
      this.smokeInst.setColorAt(i, s.dark ? SMOKE_DARK_COL : SMOKE_LIGHT_COL);
      this.smokeAlphaArr[i] = s.baseAlpha * (1 - tc);
      i++;
    }
    this.smokeInst.count = this.smokeCount;
    if (this.smokeCount > 0) {
      this.smokeInst.visible = true;
      this.smokeInst.instanceMatrix.needsUpdate = true;
      if (this.smokeInst.instanceColor) this.smokeInst.instanceColor.needsUpdate = true;
      this.smokeAlphaAttr.needsUpdate = true;
    } else {
      this.smokeInst.visible = false;
    }
  }

  private updateWakePool(now: number) {
    if (this.wakeCount === 0) {
      if (this.wakeInst.visible) {
        this.wakeInst.count = 0;
        this.wakeInst.visible = false;
      }
      return;
    }
    let i = 0;
    while (i < this.wakeCount) {
      const w = this.wakeSlots[i];
      const t = (now - w.born) / w.life;
      if (t >= 1) {
        const last = --this.wakeCount;
        this.wakeSlots[i] = this.wakeSlots[last];
        this.wakeSlots[last] = w;
        continue;
      }
      const tc = t < 0 ? 0 : t;
      const sc = (0.22 + tc * 0.96) * w.scale;
      _mat4.makeScale(sc, sc, sc);
      _mat4.setPosition(w.x, 0.052, w.z);
      this.wakeInst.setMatrixAt(i, _mat4);
      this.wakeInst.setColorAt(i, WAKE_COL);
      const inv = 1 - tc;
      this.wakeAlphaArr[i] = 0.48 * inv * inv;
      i++;
    }
    this.wakeInst.count = this.wakeCount;
    if (this.wakeCount > 0) {
      this.wakeInst.visible = true;
      this.wakeInst.instanceMatrix.needsUpdate = true;
      if (this.wakeInst.instanceColor) this.wakeInst.instanceColor.needsUpdate = true;
      this.wakeAlphaAttr.needsUpdate = true;
    } else {
      this.wakeInst.visible = false;
    }
  }

  private updatePuffPool(now: number) {
    if (this.puffCount === 0) {
      if (this.puffInst.visible) {
        this.puffInst.count = 0;
        this.puffInst.visible = false;
      }
      return;
    }
    let i = 0;
    while (i < this.puffCount) {
      const p = this.puffSlots[i];
      const t = (now - p.born) / p.life;
      if (t >= 1) {
        const last = --this.puffCount;
        this.puffSlots[i] = this.puffSlots[last];
        this.puffSlots[last] = p;
        continue;
      }
      const tc = t < 0 ? 0 : t;
      const inv = 1 - tc;
      if (p.isDust) {
        const ease = 1 - Math.pow(inv, 1.8);
        const sc = (0.24 + ease * 0.78) * p.scale;
        _mat4.makeScale(sc, sc, sc);
        _mat4.setPosition(p.sx + p.driftX * ease, p.sy + ease * 0.42 * p.scale, p.sz + p.driftZ * ease);
        this.puffAlphaArr[i] = 0.34 * inv * inv;
      } else {
        const sc = (0.16 + tc * 0.48) * p.scale;
        _mat4.makeScale(sc, sc, sc);
        _mat4.setPosition(p.sx, p.sy, p.sz);
        this.puffAlphaArr[i] = 0.36 * Math.pow(inv, 1.65);
      }
      this.puffInst.setMatrixAt(i, _mat4);
      this.puffInst.setColorAt(i, p.color);
      i++;
    }
    this.puffInst.count = this.puffCount;
    if (this.puffCount > 0) {
      this.puffInst.visible = true;
      this.puffInst.instanceMatrix.needsUpdate = true;
      if (this.puffInst.instanceColor) this.puffInst.instanceColor.needsUpdate = true;
      this.puffAlphaAttr.needsUpdate = true;
    } else {
      this.puffInst.visible = false;
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
    this.smokeCount = 0;
    this.smokeInst.count = 0;
    this.smokeInst.visible = false;
    this.wakeCount = 0;
    this.wakeInst.count = 0;
    this.wakeInst.visible = false;
    this.puffCount = 0;
    this.puffInst.count = 0;
    this.puffInst.visible = false;
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

// ---------- Selected-Unit Waypoint & Building Rally Line Renderer (Zero-Alloc Pooled) ----------

const MAX_WP_SEGS_PER_KIND = 512;
const MAX_RALLY_SEGS = 128;
const WP_RING_CAP = 256;
const WP_POST_CAP = 256;
const WP_HEAD_CAP = 256;
const RALLY_FLAG_CAP = 128;

interface LinePool {
  lines: THREE.LineSegments;
  geo: THREE.BufferGeometry;
  posArr: Float32Array;
  posAttr: THREE.BufferAttribute;
  maxSegs: number;
  count: number;
}

function makeLinePool(color: number, opacity: number, maxSegs: number): LinePool {
  const posArr = new Float32Array(maxSegs * 2 * 3);
  const posAttr = new THREE.BufferAttribute(posArr, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", posAttr);
  geo.setDrawRange(0, 0);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 15;
  lines.visible = false;
  return { lines, geo, posArr, posAttr, maxSegs, count: 0 };
}

function pushLineSeg(
  pool: LinePool,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
) {
  if (pool.count >= pool.maxSegs) return;
  const off = pool.count * 6;
  const arr = pool.posArr;
  arr[off] = x0;
  arr[off + 1] = y0;
  arr[off + 2] = z0;
  arr[off + 3] = x1;
  arr[off + 4] = y1;
  arr[off + 5] = z1;
  pool.count++;
}

function commitLinePool(pool: LinePool) {
  if (pool.count > 0) {
    pool.geo.setDrawRange(0, pool.count * 2);
    pool.posAttr.needsUpdate = true;
    pool.lines.visible = true;
  } else if (pool.lines.visible) {
    pool.geo.setDrawRange(0, 0);
    pool.lines.visible = false;
  }
}

export class WaypointOverlay {
  private group = new THREE.Group();
  private wpLines: LinePool[];
  private rallyLines: LinePool;
  private ringInst: THREE.InstancedMesh;
  private postInst: THREE.InstancedMesh;
  private headInst: THREE.InstancedMesh;
  private flagInst: THREE.InstancedMesh;
  private seenNodes = new Set<number>();
  private hasActive = false;

  constructor(private scene: THREE.Scene) {
    this.group.renderOrder = 15;

    // 5 pre-allocated reusable LineSegments pools (one per OrderKind)
    this.wpLines = ORDER_KINDS.map((kind) => {
      const lp = makeLinePool(ORDER_COLORS[kind], 0.78, MAX_WP_SEGS_PER_KIND);
      this.group.add(lp.lines);
      return lp;
    });

    // 1 pre-allocated reusable LineSegments pool for building rally lines
    this.rallyLines = makeLinePool(RALLY_COL, 0.88, MAX_RALLY_SEGS);
    this.group.add(this.rallyLines.lines);

    // Pre-allocated InstancedMesh pools for rings, posts, diamond heads, and rally flags
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.86,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ringInst = new THREE.InstancedMesh(sharedPinRing, ringMat, WP_RING_CAP);
    initInstancedPool(this.ringInst, WP_RING_CAP, WHITE_COL);
    this.ringInst.renderOrder = 15;
    this.group.add(this.ringInst);

    const postMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
    });
    this.postInst = new THREE.InstancedMesh(sharedPinPost, postMat, WP_POST_CAP);
    initInstancedPool(this.postInst, WP_POST_CAP, WHITE_COL);
    this.postInst.renderOrder = 15;
    this.group.add(this.postInst);

    const headMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
    });
    this.headInst = new THREE.InstancedMesh(sharedPinHead, headMat, WP_HEAD_CAP);
    initInstancedPool(this.headInst, WP_HEAD_CAP, WHITE_COL);
    this.headInst.renderOrder = 15;
    this.group.add(this.headInst);

    const flagMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
    });
    this.flagInst = new THREE.InstancedMesh(sharedRallyFlag, flagMat, RALLY_FLAG_CAP);
    initInstancedPool(this.flagInst, RALLY_FLAG_CAP, RALLY_COLOR_OBJ);
    this.flagInst.renderOrder = 15;
    this.group.add(this.flagInst);

    this.scene.add(this.group);
  }

  private hideAll() {
    for (let i = 0; i < this.wpLines.length; i++) {
      const lp = this.wpLines[i];
      lp.count = 0;
      if (lp.lines.visible) {
        lp.geo.setDrawRange(0, 0);
        lp.lines.visible = false;
      }
    }
    this.rallyLines.count = 0;
    if (this.rallyLines.lines.visible) {
      this.rallyLines.geo.setDrawRange(0, 0);
      this.rallyLines.lines.visible = false;
    }
    this.ringInst.count = 0;
    this.ringInst.visible = false;
    this.postInst.count = 0;
    this.postInst.visible = false;
    this.headInst.count = 0;
    this.headInst.visible = false;
    this.flagInst.count = 0;
    this.flagInst.visible = false;
    this.hasActive = false;
  }

  update(
    entries: { x: number; y: number; wp: [number, number, OrderKind][] }[],
    nowSec: number,
    rallies: { x: number; y: number; rx: number; ry: number }[] = [],
  ) {
    if (!entries.length && !rallies.length) {
      if (this.hasActive) this.hideAll();
      return;
    }
    this.hasActive = true;

    for (let i = 0; i < this.wpLines.length; i++) this.wpLines[i].count = 0;
    this.rallyLines.count = 0;
    this.seenNodes.clear();

    const pulse = 0.85 + 0.2 * Math.sin(nowSec * 6);
    const headY = 0.74 + Math.sin(nowSec * 5) * 0.06;
    const headYaw = nowSec * 2.5;
    const flagYaw = Math.sin(nowSec * 4.5) * 0.24;

    let ringCount = 0;
    let postCount = 0;
    let headCount = 0;
    let flagCount = 0;

    for (let eIdx = 0; eIdx < entries.length; eIdx++) {
      const ent = entries[eIdx];
      let px = ent.x;
      let py = ent.y;
      const wpList = ent.wp;
      for (let wIdx = 0; wIdx < wpList.length; wIdx++) {
        const wp = wpList[wIdx];
        const wx = wp[0];
        const wy = wp[1];
        const kind = wp[2];
        const kindIdx = ORDER_KIND_INDEX[kind] ?? 0;
        const colObj = ORDER_COLOR_OBJS[kind] ?? ORDER_COLOR_OBJS.move;

        pushLineSeg(this.wpLines[kindIdx], px, 0.08, py, wx, 0.08, wy);

        // Deduplicate pins at identical group waypoint coordinates (rounded to 0.6 tiles) using zero-alloc integer key
        const gx = Math.round(wx * 1.5) + 32768;
        const gy = Math.round(wy * 1.5) + 32768;
        const key = (gx * 65536 + gy) * 8 + kindIdx;
        if (!this.seenNodes.has(key)) {
          this.seenNodes.add(key);

          if (ringCount < WP_RING_CAP) {
            _mat4.makeScale(pulse, pulse, pulse);
            _mat4.setPosition(wx, 0.07, wy);
            this.ringInst.setMatrixAt(ringCount, _mat4);
            this.ringInst.setColorAt(ringCount, colObj);
            ringCount++;
          }

          if (postCount < WP_POST_CAP) {
            _mat4.makeTranslation(wx, 0.36, wy);
            this.postInst.setMatrixAt(postCount, _mat4);
            this.postInst.setColorAt(postCount, colObj);
            postCount++;
          }

          if (headCount < WP_HEAD_CAP) {
            _pos.set(wx, headY, wy);
            _quat.setFromAxisAngle(UP, headYaw);
            _scale.set(1, 1, 1);
            _mat4.compose(_pos, _quat, _scale);
            this.headInst.setMatrixAt(headCount, _mat4);
            this.headInst.setColorAt(headCount, colObj);
            headCount++;
          }
        }

        px = wx;
        py = wy;
      }
    }

    // Crisp cyan rally lines & animated flag pins for selected production buildings
    const rallyPulse = pulse * 1.15;
    for (let rIdx = 0; rIdx < rallies.length; rIdx++) {
      const r = rallies[rIdx];
      pushLineSeg(this.rallyLines, r.x, 0.14, r.y, r.rx, 0.09, r.ry);

      if (ringCount < WP_RING_CAP) {
        _mat4.makeScale(rallyPulse, rallyPulse, rallyPulse);
        _mat4.setPosition(r.rx, 0.07, r.ry);
        this.ringInst.setMatrixAt(ringCount, _mat4);
        this.ringInst.setColorAt(ringCount, RALLY_COLOR_OBJ);
        ringCount++;
      }

      if (postCount < WP_POST_CAP) {
        _mat4.makeScale(1, 1.35, 1);
        _mat4.setPosition(r.rx, 0.45, r.ry);
        this.postInst.setMatrixAt(postCount, _mat4);
        this.postInst.setColorAt(postCount, RALLY_POST_COLOR_OBJ);
        postCount++;
      }

      if (flagCount < RALLY_FLAG_CAP) {
        _pos.set(r.rx + 0.23, 0.76, r.ry);
        _quat.setFromAxisAngle(UP, flagYaw);
        _scale.set(1, 1, 1);
        _mat4.compose(_pos, _quat, _scale);
        this.flagInst.setMatrixAt(flagCount, _mat4);
        this.flagInst.setColorAt(flagCount, RALLY_COLOR_OBJ);
        flagCount++;
      }
    }

    // Commit line pools
    for (let i = 0; i < this.wpLines.length; i++) commitLinePool(this.wpLines[i]);
    commitLinePool(this.rallyLines);

    // Commit instanced marker pools
    this.commitInst(this.ringInst, ringCount);
    this.commitInst(this.postInst, postCount);
    this.commitInst(this.headInst, headCount);
    this.commitInst(this.flagInst, flagCount);
  }

  private commitInst(inst: THREE.InstancedMesh, count: number) {
    inst.count = count;
    if (count > 0) {
      inst.visible = true;
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    } else if (inst.visible) {
      inst.visible = false;
    }
  }

  clear() {
    if (this.hasActive) this.hideAll();
  }
}
