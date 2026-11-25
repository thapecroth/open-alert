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
  pool?: THREE.Object3D[];
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
const sharedNukeStem = new THREE.CylinderGeometry(0.76, 1.28, 1, 18);
const sharedNukeCap = new THREE.SphereGeometry(1, 20, 14);
const sharedNukeTorus = new THREE.TorusGeometry(1, 0.34, 12, 32);
const sharedNukeCollar = new THREE.TorusGeometry(1, 0.12, 10, 32);
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
  bridge: 0xd8a04a,
  board: 0x7cf7ff,
  unload: 0xffd84a,
};

const ORDER_KINDS: readonly OrderKind[] = ["move", "amove", "attack", "harvest", "patrol", "bridge", "board", "unload"];
const ORDER_KIND_INDEX: Record<OrderKind, number> = {
  move: 0,
  amove: 1,
  attack: 2,
  harvest: 3,
  patrol: 4,
  bridge: 5,
  board: 6,
  unload: 7,
};
const ORDER_COLOR_OBJS: Record<OrderKind, THREE.Color> = {
  move: new THREE.Color(ORDER_COLORS.move),
  amove: new THREE.Color(ORDER_COLORS.amove),
  attack: new THREE.Color(ORDER_COLORS.attack),
  harvest: new THREE.Color(ORDER_COLORS.harvest),
  patrol: new THREE.Color(ORDER_COLORS.patrol),
  bridge: new THREE.Color(ORDER_COLORS.bridge),
  board: new THREE.Color(ORDER_COLORS.board),
  unload: new THREE.Color(ORDER_COLORS.unload),
};

const WHITE_COL = new THREE.Color(0xffffff);
const SMOKE_DARK_COL = new THREE.Color(0x26292e);
const SMOKE_LIGHT_COL = new THREE.Color(0x8ea0ad);
const WAKE_COL = new THREE.Color(0xdcf8ff);
const CONTRAIL_COL = new THREE.Color(0xe6f9ff);
const HYPER_CONTRAIL_COL = new THREE.Color(1.8, 3.3, 4.2);
const HYPER_PLASMA_GOLD_COL = new THREE.Color(4.2, 2.55, 0.72);
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

  // Adaptive quality budgets (fed from GraphicsManager each frame)
  private fxCap = 400;
  private smokeCapEff = SMOKE_CAP;
  private wakeCapEff = WAKE_CAP;
  private puffCapEff = PUFF_CAP;

  // Scale ambient particle pools + cap one-shot beam/tracer/flash objects so
  // massive battles degrade gracefully instead of flooding draw calls.
  setBudget(vfxScale: number, fxCap: number) {
    const s = Math.max(0.1, Math.min(1, vfxScale));
    this.fxCap = Math.max(24, Math.round(fxCap));
    this.smokeCapEff = Math.max(16, Math.round(SMOKE_CAP * s));
    this.wakeCapEff = Math.max(12, Math.round(WAKE_CAP * s));
    this.puffCapEff = Math.max(16, Math.round(PUFF_CAP * s));
  }

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

  // reusable-mesh pools for the hottest archetypes (tracer bolts, impact sparks)
  private boltPool: THREE.Object3D[] = [];
  private sparkPool: THREE.Object3D[] = [];
  // Weapon-fire one-shots used to allocate a fresh Mesh/Sprite plus Material for
  // every shot. These small pools recycle the whole render object while keeping
  // one material instance per object so per-shot color/opacity animation is unchanged.
  private flashPool: THREE.Object3D[] = [];
  private ringPool: THREE.Object3D[] = [];
  private shellPool: THREE.Object3D[] = [];
  private rocketPool: THREE.Object3D[] = [];
  private cannonPool: THREE.Object3D[] = [];
  private tracerPool: THREE.Object3D[] = [];
  private fireballPool: THREE.Object3D[] = [];
  private debrisPool: THREE.Object3D[] = [];
  private laserPool: THREE.Object3D[] = [];
  private railgunPool: THREE.Object3D[] = [];

  private add(
    obj: THREE.Object3D,
    life: number,
    tick: FxItem["tick"],
    disposeGeo = false,
    disposeTex = false,
    pool?: THREE.Object3D[],
  ) {
    this.scene.add(obj);
    this.fxs.push({ obj, born: performance.now(), life, tick, disposeGeo, disposeTex, pool });
  }

  private acquireBolt(): { g: THREE.Group; coreMat: THREE.MeshBasicMaterial; glowMat: THREE.MeshBasicMaterial } {
    const g = this.boltPool.pop() as THREE.Group | undefined;
    if (g) {
      const w = g.userData.boltWrap as { coreMat: THREE.MeshBasicMaterial; glowMat: THREE.MeshBasicMaterial };
      return { g, ...w };
    }
    const ng = new THREE.Group();
    const coreMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const glowMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    ng.add(new THREE.Mesh(sharedCyl, coreMat), new THREE.Mesh(sharedCyl, glowMat));
    ng.userData.boltWrap = { coreMat, glowMat };
    return { g: ng, coreMat, glowMat };
  }

  private acquireSpark(): { m: THREE.Mesh; sMat: THREE.MeshBasicMaterial } {
    const m = this.sparkPool.pop() as THREE.Mesh | undefined;
    if (m) return { m, sMat: m.userData.sMat as THREE.MeshBasicMaterial };
    const sMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.96 });
    const nm = new THREE.Mesh(sharedSpark, sMat);
    nm.userData.sMat = sMat;
    return { m: nm, sMat };
  }

  private acquireFlashSprite(): { sp: THREE.Sprite; mat: THREE.SpriteMaterial } {
    const sp = this.flashPool.pop() as THREE.Sprite | undefined;
    if (sp) return { sp, mat: sp.userData.fxMat as THREE.SpriteMaterial };
    const mat = new THREE.SpriteMaterial({
      map: getSoftPuffTex(),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const ns = new THREE.Sprite(mat);
    ns.userData.fxMat = mat;
    return { sp: ns, mat };
  }

  private acquireBasicMesh(
    pool: THREE.Object3D[],
    geometry: THREE.BufferGeometry,
    init: ConstructorParameters<typeof THREE.MeshBasicMaterial>[0],
  ): { m: THREE.Mesh; mat: THREE.MeshBasicMaterial } {
    const m = pool.pop() as THREE.Mesh | undefined;
    if (m) return { m, mat: m.userData.fxMat as THREE.MeshBasicMaterial };
    const mat = new THREE.MeshBasicMaterial(init);
    const nm = new THREE.Mesh(geometry, mat);
    nm.userData.fxMat = mat;
    return { m: nm, mat };
  }

  private acquireRingMesh(): { m: THREE.Mesh; mat: THREE.MeshBasicMaterial } {
    return this.acquireBasicMesh(this.ringPool, sharedRing, {
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });
  }

  private acquireBeamGroup(
    pool: THREE.Object3D[],
    sheathAdditive: boolean,
  ): {
    g: THREE.Group;
    coreMesh: THREE.Mesh;
    coreMat: THREE.MeshBasicMaterial;
    sheathMesh: THREE.Mesh;
    sheathMat: THREE.MeshBasicMaterial;
  } {
    const g = pool.pop() as THREE.Group | undefined;
    if (g) return g.userData.beamWrap;
    const ng = new THREE.Group();
    const coreMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, depthWrite: false });
    const sheathMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.68,
      blending: sheathAdditive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
    });
    const coreMesh = new THREE.Mesh(sharedCyl, coreMat);
    const sheathMesh = new THREE.Mesh(sharedCyl, sheathMat);
    ng.add(coreMesh, sheathMesh);
    ng.userData.beamWrap = { g: ng, coreMesh, coreMat, sheathMesh, sheathMat };
    return ng.userData.beamWrap;
  }

  spawnSmoke(x: number, y: number, z: number, dark: boolean) {
    if (this.smokeCount >= this.smokeCapEff) return;
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
    if (this.wakeCount >= this.wakeCapEff) return;
    const w = this.wakeSlots[this.wakeCount++];
    w.born = performance.now();
    w.life = 880;
    w.x = x;
    w.z = z;
    w.scale = scale;
  }

  spawnDust(x: number, z: number, scale = 1.0) {
    if (this.puffCount >= this.puffCapEff) return;
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
    if (this.puffCount >= this.puffCapEff) return;
    const p = this.puffSlots[this.puffCount++];
    p.born = performance.now();
    p.life = scale >= 1.5 ? 540 : scale >= 1.3 ? 620 : 760;
    p.isDust = false;
    p.sx = x;
    p.sy = y;
    p.sz = z;
    p.driftX = 0;
    p.driftZ = 0;
    p.scale = scale;
    p.color = scale >= 1.5 ? HYPER_PLASMA_GOLD_COL : scale >= 1.3 ? HYPER_CONTRAIL_COL : CONTRAIL_COL;
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
    // Adaptive cap: drop cosmetic tracer/beam spawns once the battle is already
    // saturated with one-shot fx objects (the dominant draw-call source).
    if (this.fxs.length >= this.fxCap) return;
    const heroic = vet >= 3;
    const a = new THREE.Vector3(fx, startY ?? (weapon === "arc" ? 1.35 : weapon === "laser" ? 1.65 : weapon === "brrrt" ? 3.1 : 0.72), fy);
    const b = new THREE.Vector3(tx, 0.48, ty);
    const dir = b.clone().sub(a);
    const len = Math.max(0.05, dir.length());

    if (weapon === "brrrt") {
      // Iconic A-10 Warthog GAU-8 Avenger 30mm rotary burst: dense 3-bolt golden-amber tracer stream + fiery ground dust/spark impacts!
      const muzzlePos = new THREE.Vector3(fx, startY ?? 3.1, fy);
      const baseTarget = new THREE.Vector3(tx, 0.16, ty);
      const horizDir = new THREE.Vector3(tx - fx, 0, ty - fy);
      const hLen = horizDir.length();
      if (hLen > 0.01) horizDir.divideScalar(hLen);
      else horizDir.set(1, 0, 0);
      const perp = new THREE.Vector3(-horizDir.z, 0, horizDir.x);

      // Blazing GAU-8 nose muzzle flash & gun-gas smoke puff
      this.spawnFlash(
        muzzlePos,
        heroic ? new THREE.Color(4.4, 2.1, 0.55) : new THREE.Color(4.2, 2.65, 0.65),
        heroic ? 1.35 : 1.05,
        170,
      );
      this.spawnSmoke(muzzlePos.x, muzzlePos.y - 0.12, muzzlePos.z, false);

      const offsets: [number, number][] = [
        [-0.22, -0.18],
        [0.04, 0.02],
        [0.24, 0.2],
      ];

      for (let i = 0; i < 3; i++) {
        const [lat, lng] = offsets[i];
        const impactP = baseTarget
          .clone()
          .addScaledVector(perp, lat + (Math.random() - 0.5) * 0.14)
          .addScaledVector(horizDir, lng + (Math.random() - 0.5) * 0.14);
        const startP = muzzlePos.clone().addScaledVector(perp, (i - 1) * 0.06);
        const bDir = impactP.clone().sub(startP);
        const bLen = Math.max(0.2, bDir.length());
        const bUnit = bDir.clone().normalize();
        const segLen = Math.min(bLen * 0.62, heroic ? 2.85 : 2.35);

        const { g: boltGroup, coreMat, glowMat } = this.acquireBolt();
        boltGroup.quaternion.setFromUnitVectors(UP, bUnit);

        coreMat.color.setRGB(...(heroic ? [4.6, 1.85, 0.4] : [4.5, 2.75, 0.55]) as [number, number, number]);
        coreMat.opacity = 0;
        const coreMesh = boltGroup.children[0] as THREE.Mesh;
        const cThick = heroic ? 1.85 : 1.45;
        coreMesh.scale.set(cThick, segLen, cThick);

        glowMat.color.setRGB(...(heroic ? [4.0, 1.3, 0.25] : [3.8, 2.0, 0.35]) as [number, number, number]);
        glowMat.opacity = 0;
        const glowMesh = boltGroup.children[1] as THREE.Mesh;
        glowMesh.scale.set(cThick * 2.3, segLen * 1.12, cThick * 2.3);

        const delay = i * 0.15;
        const lifeMs = 215 + i * 38;
        let struck = false;

        this.add(boltGroup, lifeMs, (o, t) => {
          if (t < delay) {
            coreMat.opacity = 0;
            glowMat.opacity = 0;
            return;
          }
          const u = (t - delay) / (1 - delay);
          const travel = Math.min(1, u * 1.15);
          o.position.copy(startP).lerp(impactP, travel);
          const fade = u < 0.72 ? 1.0 : Math.max(0, 1 - (u - 0.72) / 0.28);
          coreMat.opacity = 0.98 * fade;
          glowMat.opacity = 0.68 * fade;

          if (travel >= 0.88 && !struck) {
            struck = true;
            // Fiery 30mm depleted-uranium impact flash + ground dust + flying hot sparks!
            this.spawnFlash(
              impactP,
              heroic ? new THREE.Color(4.4, 1.75, 0.35) : new THREE.Color(4.2, 2.35, 0.52),
              heroic ? 1.18 : 0.92,
              185,
            );
            this.spawnDust(impactP.x, impactP.z, heroic ? 1.25 : 0.96);
            if (i === 1) {
              this.spawnImpactRing(
                impactP.x,
                impactP.z,
                heroic ? 1.22 : 0.92,
                new THREE.Color(3.8, 1.95, 0.4),
                260,
              );
              this.spawnSmoke(impactP.x, 0.28, impactP.z, true);
            }
            for (let s = 0; s < 3; s++) {
              const { m: spark, sMat } = this.acquireSpark();
              sMat.color.setRGB(...(s === 0 ? [4.4, 3.1, 0.9] : [3.8, 1.7, 0.3]) as [number, number, number]);
              sMat.opacity = 0.96;
              spark.position.set(impactP.x, 0.22, impactP.z);
              const ang = Math.random() * Math.PI * 2;
              const spd = 1.6 + Math.random() * 2.6;
              const vx = Math.cos(ang) * spd;
              const vz = Math.sin(ang) * spd;
              const vy = 2.4 + Math.random() * 2.8;
              this.add(spark, 240 + Math.random() * 110, (so, st) => {
                so.position.set(
                  impactP.x + vx * st * 0.36,
                  Math.max(0.06, 0.22 + vy * st * 0.34 - 4.8 * st * st * 0.24),
                  impactP.z + vz * st * 0.36,
                );
                const sc = (1 - st) * (heroic ? 1.2 : 0.9);
                so.scale.set(sc * 0.7, sc * 1.4, sc * 0.7);
                sMat.opacity = 1 - st;
              }, false, false, this.sparkPool);
            }
          }
        }, false, false, this.boltPool);
      }
      return;
    }

    if (weapon === "laser") {
      // Helios Laser / Defense Satellite: intense searing continuous golden-cyan focused thermal beam (240ms)
      const isOrbital = srcKind === "satlink" || (startY !== undefined && startY >= 12);
      const laserA = isOrbital ? new THREE.Vector3(fx, 24, fy) : new THREE.Vector3(fx, startY ?? 1.65, fy);
      const laserB = new THREE.Vector3(tx, 0.42, ty);
      const lDir = laserB.clone().sub(laserA);
      const lLen = Math.max(0.1, lDir.length());
      const lUnit = lDir.clone().normalize();
      const mid = laserA.clone().lerp(laserB, 0.5);

      const { g: beamGroup, coreMesh, coreMat, sheathMesh, sheathMat } = this.acquireBeamGroup(this.laserPool, true);
      beamGroup.position.copy(mid);
      beamGroup.quaternion.setFromUnitVectors(UP, lUnit);

      // Incandescent golden-white inner thermal core
      if (heroic) coreMat.color.setRGB(4.4, 2.35, 1.05);
      else coreMat.color.setRGB(4.1, 3.35, 1.75);
      coreMat.opacity = 0.98;
      const coreThick = (isOrbital ? 3.2 : 2.15) * (heroic ? 1.25 : 1.0);
      coreMesh.scale.set(coreThick, lLen, coreThick);

      // Searing outer cyan-gold plasma sheath
      if (isOrbital) sheathMat.color.setRGB(1.4, 3.3, 4.1);
      else sheathMat.color.setRGB(1.5, 3.1, 3.5);
      sheathMat.opacity = 0.68;
      const sheathThick = coreThick * 2.35;
      sheathMesh.scale.set(sheathThick, lLen, sheathThick);

      this.add(beamGroup, 240, (_o, t) => {
        const pulse = 1 + 0.16 * Math.sin(t * 48);
        const taper = t < 0.72 ? 1.0 : Math.max(0.05, 1 - (t - 0.72) / 0.28);
        const cW = coreThick * pulse * taper;
        const sW = sheathThick * (1 + t * 0.22) * taper;
        coreMesh.scale.set(cW, lLen, cW);
        sheathMesh.scale.set(sW, lLen, sW);
        coreMat.opacity = 0.98 * taper;
        sheathMat.opacity = 0.68 * (1 - t * 0.85);
      }, false, false, this.laserPool);

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

      const { g: boltGroup, coreMesh, coreMat, sheathMesh: haloMesh, sheathMat: haloMat } = this.acquireBeamGroup(
        this.railgunPool,
        true,
      );
      boltGroup.position.copy(mid);
      boltGroup.quaternion.setFromUnitVectors(UP, railUnit);

      // Blazing cyan-white hyper-velocity inner core
      if (heroic) coreMat.color.setRGB(3.8, 2.8, 4.6);
      else coreMat.color.setRGB(2.8, 4.0, 4.6);
      coreMat.opacity = 1.0;
      const coreThick = heroic ? 2.45 : 1.85;
      coreMesh.scale.set(coreThick, len, coreThick);

      // Outer electric cyan plasma corona
      if (heroic) haloMat.color.setRGB(2.4, 1.5, 4.0);
      else haloMat.color.setRGB(0.75, 2.75, 4.1);
      haloMat.opacity = 0.65;
      const haloThick = coreThick * 2.7;
      haloMesh.scale.set(haloThick, len, haloThick);

      this.add(boltGroup, 220, (_o, t) => {
        const snap = Math.max(0.06, Math.pow(1 - t, 1.25));
        coreMesh.scale.set(coreThick * snap, len, coreThick * snap);
        haloMesh.scale.set(haloThick * (1 + t * 0.55), len, haloThick * (1 + t * 0.55));
        coreMat.opacity = snap;
        haloMat.opacity = 0.65 * (1 - t) * (1 - t);
      }, false, false, this.railgunPool);

      // 3 expanding electromagnetic vortex shock rings spaced along the barrel path
      const zAxis = new THREE.Vector3(0, 0, 1);
      const ringQuat = new THREE.Quaternion().setFromUnitVectors(zAxis, railUnit);
      const fracs = [0.2, 0.48, 0.76];
      for (let i = 0; i < fracs.length; i++) {
        const u = fracs[i];
        const rPos = a.clone().lerp(b, u);
        const { m: ring, mat: rMat } = this.acquireRingMesh();
        if (i === 1) rMat.color.setRGB(2.0, 3.6, 4.4);
        else rMat.color.setRGB(0.85, 2.8, 4.2);
        rMat.opacity = 0.92;
        rMat.blending = THREE.AdditiveBlending;
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
        }, false, false, this.ringPool);
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
      const { m: shell, mat } = this.acquireBasicMesh(this.shellPool, sharedShell, {});
      mat.color.setRGB(...(heroic ? [3.4, 0.85, 0.35] : [2.4, 1.5, 0.5]) as [number, number, number]);
      mat.opacity = 1;
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
      }, false, false, this.shellPool);
      this.spawnFlash(a, heroic ? new THREE.Color(3.2, 1.0, 0.4) : new THREE.Color(2.4, 1.4, 0.5), heroic ? 0.95 : 0.7, 150);
      return;
    }

    if (weapon === "rocket") {
      // Flying smoking rocket
      const { m, mat } = this.acquireBasicMesh(this.rocketPool, sharedCyl, {});
      mat.color.setRGB(...(heroic ? [3.3, 0.85, 0.32] : [2.5, 1.6, 0.55]) as [number, number, number]);
      mat.opacity = 1;
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
      }, false, false, this.rocketPool);
      this.spawnFlash(a, heroic ? new THREE.Color(3.0, 0.95, 0.35) : new THREE.Color(2.2, 1.4, 0.5), heroic ? 0.65 : 0.45, 110);
      return;
    }

    if (weapon === "cannon") {
      // Heavy glowing shell streaking rapidly + muzzle puff
      const { m: beam, mat } = this.acquireBasicMesh(this.cannonPool, sharedCyl, {
        transparent: true,
        opacity: 0.98,
      });
      mat.color.setRGB(...(heroic ? [3.4, 0.92, 0.3] : [2.6, 1.7, 0.55]) as [number, number, number]);
      mat.opacity = 0.98;
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
      }, false, false, this.cannonPool);
      this.spawnFlash(a, heroic ? new THREE.Color(3.4, 1.25, 0.4) : new THREE.Color(2.8, 1.9, 0.7), heroic ? 0.95 : 0.68, 140);
      this.spawnSmoke(a.x, a.y, a.z, false);
      return;
    }

    if (weapon === "melee") {
      this.spawnFlash(b, heroic ? new THREE.Color(3.2, 0.95, 0.35) : new THREE.Color(1.2, 2.4, 2.8), heroic ? 0.8 : 0.55, 150);
      return;
    }

    // Default: crisp ballistic rifle / turret tracer
    const { m: beam, mat } = this.acquireBasicMesh(this.tracerPool, sharedCyl, {
      transparent: true,
      opacity: 0.94,
    });
    mat.color.setRGB(...(heroic ? [3.2, 0.95, 0.35] : [2.2, 1.9, 0.85]) as [number, number, number]);
    mat.opacity = 0.94;
    const thick = heroic ? 1.25 : 0.75;
    beam.scale.set(thick, len, thick);
    beam.position.copy(a).lerp(b, 0.5);
    beam.quaternion.setFromUnitVectors(UP, dir.normalize());
    this.add(beam, 125, (_o, t) => (mat.opacity = 0.94 * (1 - t)), false, false, this.tracerPool);
    this.spawnFlash(a, heroic ? new THREE.Color(3.3, 1.15, 0.4) : new THREE.Color(2.6, 2.0, 0.85), heroic ? 0.56 : 0.36, 110);
    if (heroic) this.spawnFlash(b, new THREE.Color(3.0, 0.9, 0.35), 0.42, 110);
  }

  private spawnFlash(pos: THREE.Vector3, color: THREE.Color, size: number, life: number) {
    if (this.fxs.length >= this.fxCap) return;
    const { sp, mat } = this.acquireFlashSprite();
    mat.color.copy(color);
    mat.opacity = 0.95;
    mat.blending = THREE.AdditiveBlending;
    sp.position.copy(pos);
    sp.scale.setScalar(size * 1.35);
    this.add(sp, life, (o, t) => {
      o.scale.setScalar(size * 1.35 * (1 - t * 0.5));
      mat.opacity = 0.95 * (1 - t);
    }, false, false, this.flashPool);
  }

  private spawnImpactRing(x: number, z: number, radius: number, color: THREE.Color, life = 380) {
    if (this.fxs.length >= this.fxCap) return;
    const { m: ring, mat } = this.acquireRingMesh();
    mat.color.copy(color);
    mat.opacity = 0.88;
    mat.blending = THREE.NormalBlending;
    ring.rotation.set(-Math.PI / 2, 0, 0);
    ring.position.set(x, 0.1, z);
    this.add(ring, life, (o, t) => {
      const sc = 0.3 + t * radius * 1.5;
      o.scale.setScalar(sc);
      mat.opacity = 0.88 * (1 - t);
    }, false, false, this.ringPool);
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
    const { sp: flash, mat: flashMat } = this.acquireFlashSprite();
    flashMat.color.setRGB(4.2, 3.4, 2.1);
    flashMat.opacity = 1;
    flashMat.blending = THREE.NormalBlending;
    flash.position.set(x, 0.55, y);
    const flashSize = 1.15 * rad;
    flash.scale.setScalar(flashSize * 0.6);
    this.add(flash, 180, (o, t) => {
      const pop = t < 0.25 ? 0.6 + (t / 0.25) * 0.85 : 1.45 - (t - 0.25) * 0.6;
      o.scale.setScalar(flashSize * pop);
      flashMat.opacity = Math.pow(1 - t, 1.5);
    }, false, false, this.flashPool);

    // 2. Fiery expanding explosion sphere (shifts incandescent gold-orange -> deep ember red)
    const hotCol = new THREE.Color(3.3, 1.25, 0.26);
    const coolCol = new THREE.Color(1.45, 0.3, 0.06);
    const { m: fire, mat: fireMat } = this.acquireBasicMesh(this.fireballPool, sharedFire, {
      transparent: true,
      opacity: 0.96,
    });
    fireMat.color.copy(hotCol);
    fireMat.opacity = 0.96;
    fire.position.set(x, 0.52, y);
    this.add(fire, 520, (o, t) => {
      const ease = 1 - Math.pow(1 - t, 2.0);
      o.scale.setScalar(0.38 + ease * rad * 1.12);
      o.position.y = 0.42 + ease * 0.95;
      fireMat.color.copy(hotCol).lerp(coolCol, Math.min(1, t * 1.35));
      fireMat.opacity = (1 - t) * (1 - t);
    }, false, false, this.fireballPool);

    // 3. Crisp dual shockwave rings (outer gold-amber blast wave + fast inner pressure ring)
    this.spawnImpactRing(x, y, rad * 1.08, new THREE.Color(2.7, 1.35, 0.36), 440);
    this.spawnImpactRing(x, y, rad * 0.72, new THREE.Color(3.6, 2.8, 1.4), 260);

    // 4. Glowing HDR ember sparks & tumbling dark armor debris — shed first under fx pressure
    const lite = this.fxs.length >= this.fxCap;
    const chunks = lite ? 0 : Math.min(11, Math.max(5, Math.round(rad * 3.4)));
    for (let i = 0; i < chunks; i++) {
      const isEmber = i % 3 !== 2;
      const ang = (i / chunks) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const spd = (2.0 + Math.random() * 2.6) * Math.min(2.2, rad * 0.78);
      const vy = (isEmber ? 3.2 : 2.6) + Math.random() * 2.6;
      const { m: deb, mat: dMat } = this.acquireBasicMesh(this.debrisPool, sharedSpark, {
        transparent: true,
        opacity: 1,
      });
      if (isEmber) {
        if (i % 2 === 0) dMat.color.setRGB(3.4, 1.65, 0.35);
        else dMat.color.setRGB(3.2, 2.35, 0.85);
      } else {
        dMat.color.setHex(0x2a3038);
      }
      dMat.opacity = 1;
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
      }, false, false, this.debrisPool);
    }

    // 5. Rising billowing dark blast smoke clouds
    this.spawnSmoke(x, 0.72, y, true);
    this.spawnSmoke(x + 0.34, 0.52, y - 0.28, true);
    if (rad >= 1.55) {
      this.spawnSmoke(x - 0.32, 0.58, y + 0.3, true);
    }
  }

  // ---------- Thermonuclear ICBM Strike & Rising Mushroom Cloud VFX ----------

  spawnSuperweapon(x: number, y: number) {
    const descentMs = 750;
    const cloudMs = 2450; // 750ms -> 3200ms total spectacle
    const startPos = new THREE.Vector3(x + 2.4, 48, y - 1.6);
    const impactPos = new THREE.Vector3(x, 0.2, y);
    const flightDir = impactPos.clone().sub(startPos).normalize();

    // ===== PHASE 1 (0..750ms): Ground nuclear targeting lock rings + blazing descending ICBM =====
    for (let i = 0; i < 2; i++) {
      const startR = i === 0 ? 5.8 : 3.2;
      const ringMat = new THREE.MeshBasicMaterial({
        color: i === 0 ? new THREE.Color(3.6, 0.65, 0.25) : new THREE.Color(4.0, 2.2, 0.45),
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(sharedRing, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.14 + i * 0.03, y);
      this.add(ring, descentMs, (o, t) => {
        const pulse = 1 + 0.08 * Math.sin(t * 36 + i * 2);
        const sc = Math.max(0.45, startR * (1 - t * 0.68) * pulse);
        o.scale.setScalar(sc);
        ringMat.opacity = t < 0.88 ? 0.45 + 0.52 * Math.sin(t * 28 + i) * 0.5 + 0.25 : (1 - t) * 7;
      });
    }

    // Fiery plasma condensation trail ribbon behind the plunging ICBM warhead
    const trailSegs = 20;
    const trailPts: THREE.Vector3[] = [];
    for (let i = 0; i <= trailSegs; i++) {
      trailPts.push(startPos.clone().lerp(impactPos, i / trailSegs));
    }
    const trailGeo = new THREE.BufferGeometry().setFromPoints(trailPts);
    trailGeo.setDrawRange(0, 2);
    const trailMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(4.4, 1.9, 0.55),
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    });
    const trailLine = new THREE.Line(trailGeo, trailMat);
    const trailLife = descentMs + 650;
    this.add(
      trailLine,
      trailLife,
      (_o, t) => {
        const elapsed = t * trailLife;
        const u = Math.min(1, elapsed / descentMs);
        const drawN = Math.max(2, Math.min(trailSegs + 1, Math.ceil(u * (trailSegs + 1))));
        trailGeo.setDrawRange(0, drawN);
        trailMat.opacity = elapsed <= descentMs ? 0.96 : Math.max(0, 0.96 * (1 - (elapsed - descentMs) / 650));
      },
      true,
    );

    // Blazing red-orange ICBM re-entry warhead screaming steeply down (y = 48 -> 0.2)
    const warhead = new THREE.Group();
    warhead.quaternion.setFromUnitVectors(UP, flightDir);
    warhead.position.copy(startPos);

    const whBody = new THREE.Mesh(
      sharedCyl,
      new THREE.MeshBasicMaterial({ color: 0xeef4fa }),
    );
    whBody.scale.set(6.5, 1.55, 6.5);
    warhead.add(whBody);

    const whNose = new THREE.Mesh(
      sharedCone,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(3.8, 0.65, 0.22) }),
    );
    whNose.scale.set(2.1, 2.2, 2.1);
    whNose.position.y = 1.15;
    warhead.add(whNose);

    // Blazing incandescent re-entry bow shock sheath + long plasma wake plume
    const bowGlow = new THREE.Mesh(
      sharedCone,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(4.6, 2.35, 0.65),
        transparent: true,
        opacity: 0.86,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    bowGlow.scale.set(3.2, 3.8, 3.2);
    bowGlow.position.y = 0.72;
    warhead.add(bowGlow);

    const wakePlume = new THREE.Mesh(
      sharedCone,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(4.2, 1.55, 0.35),
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    wakePlume.rotation.x = Math.PI;
    wakePlume.scale.set(2.5, 7.6, 2.5);
    wakePlume.position.y = -2.25;
    warhead.add(wakePlume);

    let contrailAcc = 0;
    let detonated = false;

    this.add(warhead, descentMs, (o, t, dt) => {
      // Accelerating terminal re-entry curve (48 -> 0.2)
      const fall = Math.pow(t, 1.25);
      o.position.lerpVectors(startPos, impactPos, fall);
      const flick = 0.9 + 0.25 * Math.sin(t * 70);
      bowGlow.scale.set(3.2 * flick, 3.8 * flick, 3.2 * flick);
      wakePlume.scale.set(2.5 * flick, (6.8 + t * 2.4) * flick, 2.5 * flick);

      contrailAcc += dt;
      if (contrailAcc >= 0.026 && t < 0.95) {
        contrailAcc = 0;
        this.spawnContrail(o.position.x, o.position.y, o.position.z, 1.6);
      }

      // ===== PHASE 2 (750..3200ms): Thermonuclear Detonation & Colossal Rising Mushroom Cloud! =====
      if (t >= 0.96 && !detonated) {
        detonated = true;

        // 1. Massive persistent blackened blast crater
        this.spawnCrater(x, y, 5.2);

        // 2. Blinding incandescent white-gold thermonuclear flash dome + towering flash flare!
        const flashHot = new THREE.Color(5.2, 4.6, 3.1);
        const flashAmber = new THREE.Color(3.9, 1.85, 0.42);
        const domeMat = new THREE.MeshBasicMaterial({
          color: flashHot.clone(),
          transparent: true,
          opacity: 0.98,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const flashDome = new THREE.Mesh(sharedNukeCap, domeMat);
        flashDome.position.set(x, 0.4, y);
        this.add(flashDome, 1150, (fo, ft) => {
          const ease = 1 - Math.pow(1 - ft, 2.6);
          const r = 1.4 + ease * 10.6;
          fo.scale.set(r, r * 0.72, r);
          domeMat.color.copy(flashHot).lerp(flashAmber, Math.min(1, ft * 1.45));
          domeMat.opacity = Math.pow(Math.max(0, 1 - ft), 1.75) * 0.96;
        });

        // Blinding core flash billboard flare
        this.spawnFlash(new THREE.Vector3(x, 2.4, y), new THREE.Color(5.4, 4.8, 3.3), 10.5, 620);
        this.spawnFlash(new THREE.Vector3(x, 1.2, y), new THREE.Color(4.5, 2.2, 0.55), 8.2, 920);

        // 3. Huge expanding ground thermal shockwave ring (r = 1 -> 14) + secondary thermal wave!
        const swMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(4.4, 3.4, 1.5),
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const swRing = new THREE.Mesh(sharedRing, swMat);
        swRing.rotation.x = -Math.PI / 2;
        swRing.position.set(x, 0.22, y);
        this.add(swRing, 1280, (ro, rt) => {
          const ease = 1 - Math.pow(1 - rt, 1.85);
          const sc = 1.0 + ease * 13.0; // r = 1 -> 14!
          ro.scale.set(sc, sc, Math.max(0.35, 1.8 - rt * 1.3));
          swMat.opacity = 0.95 * Math.pow(1 - rt, 1.35);
        });

        const sw2Mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(3.8, 1.35, 0.28),
          transparent: true,
          opacity: 0.86,
          depthWrite: false,
        });
        const swRing2 = new THREE.Mesh(sharedRing, sw2Mat);
        swRing2.rotation.x = -Math.PI / 2;
        swRing2.position.set(x, 0.16, y);
        this.add(swRing2, 1520, (ro, rt) => {
          const ease = 1 - Math.pow(1 - rt, 1.65);
          const sc = 0.8 + ease * 10.6;
          ro.scale.set(sc, sc, Math.max(0.25, 1.2 - rt * 0.85));
          sw2Mat.opacity = 0.86 * Math.pow(1 - rt, 1.4);
        });

        // 4. Colossal Rising Thermonuclear Mushroom Cloud (750ms -> 3200ms)
        const cIncand = new THREE.Color(4.5, 3.7, 1.75);
        const cFire = new THREE.Color(3.25, 1.12, 0.22);
        const cEmber = new THREE.Color(0.95, 0.26, 0.1);
        const cSoot = new THREE.Color(0.15, 0.14, 0.16);
        const tmpColor = new THREE.Color();

        const evalNuclearColor = (u: number, out: THREE.Color) => {
          if (u < 0.22) {
            out.copy(cIncand).lerp(cFire, u / 0.22);
          } else if (u < 0.56) {
            out.copy(cFire).lerp(cEmber, (u - 0.22) / 0.34);
          } else {
            out.copy(cEmber).lerp(cSoot, Math.min(1, (u - 0.56) / 0.34));
          }
        };

        const cloudGroup = new THREE.Group();
        cloudGroup.position.set(x, 0, y);

        // Rising fireball stem column (CylinderGeometry)
        const stemMat = new THREE.MeshBasicMaterial({
          color: cIncand.clone(),
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        });
        const stem = new THREE.Mesh(sharedNukeStem, stemMat);
        cloudGroup.add(stem);

        // Ground base-surge dust/fire skirt torus
        const baseMat = new THREE.MeshBasicMaterial({
          color: cFire.clone(),
          transparent: true,
          opacity: 0.86,
          depthWrite: false,
        });
        const baseSurge = new THREE.Mesh(sharedNukeTorus, baseMat);
        baseSurge.rotation.x = Math.PI / 2;
        baseSurge.position.y = 0.65;
        cloudGroup.add(baseSurge);

        // Billowing toroidal mushroom cap: main dome + rolled toroidal under-cap + volumetric lobes
        const capGroup = new THREE.Group();
        cloudGroup.add(capGroup);

        const capMat = new THREE.MeshBasicMaterial({
          color: cIncand.clone(),
          transparent: true,
          opacity: 0.96,
          depthWrite: false,
        });
        const capDome = new THREE.Mesh(sharedNukeCap, capMat);
        capGroup.add(capDome);

        const capRollMat = new THREE.MeshBasicMaterial({
          color: cFire.clone(),
          transparent: true,
          opacity: 0.92,
          depthWrite: false,
        });
        const capRoll = new THREE.Mesh(sharedNukeTorus, capRollMat);
        capRoll.rotation.x = Math.PI / 2;
        capRoll.position.y = -0.35;
        capGroup.add(capRoll);

        // Inner glowing nuclear plasma core tucked inside the mushroom crown
        const innerCoreMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(4.6, 2.8, 0.85),
          transparent: true,
          opacity: 0.92,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const innerCore = new THREE.Mesh(sharedNukeCap, innerCoreMat);
        innerCore.position.y = -0.15;
        capGroup.add(innerCore);

        // 6 billowing perimeter cloud lobes giving dramatic sculpted mushroom volume
        const lobes: THREE.Mesh[] = [];
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * Math.PI * 2;
          const lobe = new THREE.Mesh(sharedNukeCap, capRollMat);
          lobe.userData.ang = ang;
          capGroup.add(lobe);
          lobes.push(lobe);
        }

        // Expanding Wilson condensation collar ring (TorusGeometry) encircling the rising stem!
        const collarMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(2.6, 2.4, 2.1),
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        const collar = new THREE.Mesh(sharedNukeCollar, collarMat);
        collar.rotation.x = Math.PI / 2;
        cloudGroup.add(collar);

        this.add(cloudGroup, cloudMs, (_co, ct) => {
          const rise = 1 - Math.pow(1 - ct, 2.1);
          const fade = ct < 0.72 ? 1.0 : Math.max(0, 1 - (ct - 0.72) / 0.28);

          // Stem rises smoothly from ground to y ~ 10.5
          const stemH = 1.6 + rise * 9.8;
          const stemR = 1.05 + rise * 0.95;
          stem.position.y = stemH * 0.5;
          stem.scale.set(stemR, stemH, stemR);
          evalNuclearColor(Math.min(1, ct * 1.12), tmpColor);
          stemMat.color.copy(tmpColor);
          stemMat.opacity = 0.92 * fade;

          // Base surge churns outward along the ground
          const bR = 1.5 + rise * 4.4;
          baseSurge.scale.set(bR, bR, 0.9 + rise * 1.1);
          baseSurge.position.y = 0.45 + rise * 0.65;
          evalNuclearColor(Math.min(1, ct * 1.25 + 0.14), tmpColor);
          baseMat.color.copy(tmpColor);
          baseMat.opacity = 0.82 * Math.pow(fade, 1.15);

          // Mushroom cap rises to y ~ 12.2 and billows wide into an iconic toroidal crown!
          const capY = 1.6 + rise * 10.6;
          const capRx = 1.45 + rise * 4.85;
          const capRy = 1.05 + rise * 2.35;
          capGroup.position.y = capY;
          capGroup.rotation.y = ct * 0.55;

          capDome.scale.set(capRx, capRy, capRx);
          evalNuclearColor(ct, tmpColor);
          capMat.color.copy(tmpColor);
          capMat.opacity = 0.96 * fade;

          const rollR = capRx * 0.86;
          capRoll.scale.set(rollR, rollR, capRy * 0.78);
          capRoll.position.y = -capRy * 0.36;
          evalNuclearColor(Math.min(1, ct * 1.08 + 0.08), tmpColor);
          capRollMat.color.copy(tmpColor);
          capRollMat.opacity = 0.92 * fade;

          innerCore.scale.set(capRx * 0.68, capRy * 0.62, capRx * 0.68);
          innerCoreMat.opacity = Math.max(0, 0.92 * Math.pow(1 - ct * 1.28, 1.6));

          for (let i = 0; i < lobes.length; i++) {
            const lb = lobes[i];
            const ang = (lb.userData.ang as number) + ct * 0.35;
            const orbitR = capRx * 0.64;
            lb.position.set(Math.cos(ang) * orbitR, -capRy * 0.18 + Math.sin(ct * 5 + i) * 0.25, Math.sin(ang) * orbitR);
            const ls = capRy * (0.64 + 0.1 * Math.sin(i * 1.7 + ct * 4));
            lb.scale.set(ls * 1.15, ls * 0.85, ls * 1.15);
          }

          // Wilson condensation collar ring forms mid-stem and expands crisply outward
          const collarIn = ct < 0.1 ? ct / 0.1 : 1;
          const collarFade = ct < 0.45 ? 1 : Math.max(0, 1 - (ct - 0.45) / 0.48);
          const collarR = 1.8 + rise * 6.2;
          collar.position.y = stemH * 0.54;
          collar.scale.set(collarR, collarR, 0.85 + rise * 0.75);
          collarMat.opacity = 0.76 * collarIn * collarFade;
        });

        // 5. Flying fiery nuclear debris chunks & incandescent embers
        for (let i = 0; i < 20; i++) {
          const ang = (i / 20) * Math.PI * 2 + (Math.random() - 0.5) * 0.32;
          const spd = 4.6 + Math.random() * 6.8;
          const vy = 5.4 + Math.random() * 5.6;
          const col =
            i % 3 === 0
              ? new THREE.Color(4.2, 2.6, 0.75)
              : i % 3 === 1
                ? new THREE.Color(3.6, 1.15, 0.22)
                : 0x262a30;
          const dMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 1 });
          const deb = new THREE.Mesh(sharedSpark, dMat);
          deb.scale.setScalar(1.65 + Math.random() * 1.45);
          deb.position.set(x, 0.85, y);
          this.add(deb, 1080 + Math.random() * 260, (doObj, dt0) => {
            const s = dt0 * 1.15;
            doObj.position.set(
              x + Math.cos(ang) * spd * s,
              Math.max(0.1, 0.85 + vy * s - 6.8 * s * s),
              y + Math.sin(ang) * spd * s,
            );
            doObj.rotation.x = s * 15.2;
            doObj.rotation.y = s * 11.8;
            dMat.opacity = 1 - dt0 * dt0;
          });
        }

        // Dense perimeter ring of dark nuclear battle smoke
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2;
          this.spawnSmoke(x + Math.cos(ang) * 2.6, 1.1, y + Math.sin(ang) * 2.6, true);
        }
      }
    });
  }

  // ---------- THAAD Hit-To-Kill Exo-Atmospheric Nuke Interception VFX ----------

  spawnNukeIntercept(fx: number, fy: number, tx: number, ty: number) {
    const flightMs = 700;
    const icbmStart = new THREE.Vector3(tx + 1.4, 46, ty - 0.9);
    const thaadStart = new THREE.Vector3(fx, 1.8, fy);
    const interceptP = new THREE.Vector3(tx, 19, ty);

    // Launch booster flare + white smoke puff at THAAD battery pad
    this.spawnFlash(thaadStart, new THREE.Color(3.2, 4.2, 4.8), 2.1, 260);
    this.spawnFlash(thaadStart, new THREE.Color(4.4, 2.8, 0.9), 1.4, 200);
    this.spawnSmoke(fx, 1.6, fy, false);

    // Ground danger ring that transforms into a safe cyan shield ripple on intercept (ZERO crater!)
    const warnMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(3.4, 0.75, 0.35),
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    const warnRing = new THREE.Mesh(sharedRing, warnMat);
    warnRing.rotation.x = -Math.PI / 2;
    warnRing.position.set(tx, 0.14, ty);
    this.add(warnRing, flightMs, (o, t) => {
      const sc = 4.6 * (1 - t * 0.45);
      o.scale.setScalar(sc);
      warnMat.opacity = 0.75 * (1 - t * 0.65);
    });

    // 1. Descending crimson-tipped Nuclear ICBM trajectory ribbon & missile: (tx, 46, ty) -> (tx, 19, ty)
    const icbmSegs = 16;
    const icbmPts: THREE.Vector3[] = [];
    for (let i = 0; i <= icbmSegs; i++) {
      icbmPts.push(icbmStart.clone().lerp(interceptP, i / icbmSegs));
    }
    const icbmTrailGeo = new THREE.BufferGeometry().setFromPoints(icbmPts);
    icbmTrailGeo.setDrawRange(0, 2);
    const icbmTrailMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(4.0, 1.35, 0.4),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const icbmTrailLine = new THREE.Line(icbmTrailGeo, icbmTrailMat);
    const trailLife = 1550;
    this.add(
      icbmTrailLine,
      trailLife,
      (_o, t) => {
        const elapsed = t * trailLife;
        const u = Math.min(1, elapsed / flightMs);
        icbmTrailGeo.setDrawRange(0, Math.max(2, Math.min(icbmSegs + 1, Math.ceil(u * (icbmSegs + 1)))));
        icbmTrailMat.opacity = elapsed <= flightMs ? 0.95 : Math.max(0, 0.95 * (1 - (elapsed - flightMs) / (trailLife - flightMs)));
      },
      true,
    );

    const icbmDir = interceptP.clone().sub(icbmStart).normalize();
    const icbmObj = new THREE.Group();
    icbmObj.quaternion.setFromUnitVectors(UP, icbmDir);
    icbmObj.position.copy(icbmStart);

    const icbmFuselage = new THREE.Mesh(sharedCyl, new THREE.MeshBasicMaterial({ color: 0xedf2f7 }));
    icbmFuselage.scale.set(6.0, 1.45, 6.0);
    icbmObj.add(icbmFuselage);

    const icbmTip = new THREE.Mesh(
      sharedCone,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(3.9, 0.52, 0.22) }),
    );
    icbmTip.scale.set(2.0, 2.1, 2.0);
    icbmTip.position.y = 1.05;
    icbmObj.add(icbmTip);

    const icbmPlume = new THREE.Mesh(
      sharedCone,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(4.2, 1.65, 0.38),
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    icbmPlume.rotation.x = Math.PI;
    icbmPlume.scale.set(2.2, 5.8, 2.2);
    icbmPlume.position.y = -1.9;
    icbmObj.add(icbmPlume);

    let icbmTrailCd = 0;
    this.add(icbmObj, flightMs, (o, t, dt) => {
      o.position.lerpVectors(icbmStart, interceptP, t);
      icbmTrailCd += dt;
      if (icbmTrailCd >= 0.036 && t < 0.94) {
        icbmTrailCd = 0;
        this.spawnContrail(o.position.x, o.position.y, o.position.z, 1.55);
      }
    });

    // 2. Blazing white-cyan THAAD Interceptor Missile launching steeply from (fx, 1.8, fy) -> (tx, 19, ty)
    const thaadSegs = 22;
    const thaadPts: THREE.Vector3[] = [];
    for (let i = 0; i <= thaadSegs; i++) {
      const u = i / thaadSegs;
      const p = thaadStart.clone().lerp(interceptP, u);
      // Steep initial boost climb curving gracefully into exo-atmospheric intercept point
      p.y += Math.sin(u * Math.PI) * 2.6;
      thaadPts.push(p);
    }
    const thaadTrailGeo = new THREE.BufferGeometry().setFromPoints(thaadPts);
    thaadTrailGeo.setDrawRange(0, 2);
    const thaadTrailMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(1.9, 3.8, 4.6),
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
    });
    const thaadTrailLine = new THREE.Line(thaadTrailGeo, thaadTrailMat);
    this.add(
      thaadTrailLine,
      trailLife + 150,
      (_o, t) => {
        const elapsed = t * (trailLife + 150);
        const u = Math.min(1, elapsed / flightMs);
        thaadTrailGeo.setDrawRange(0, Math.max(2, Math.min(thaadSegs + 1, Math.ceil(u * (thaadSegs + 1)))));
        thaadTrailMat.opacity =
          elapsed <= flightMs ? 0.98 : Math.max(0, 0.98 * (1 - (elapsed - flightMs) / (trailLife + 150 - flightMs)));
      },
      true,
    );

    const thaadObj = new THREE.Group();
    thaadObj.position.copy(thaadStart);

    const tBody = new THREE.Mesh(sharedCyl, new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 3.8, 4.4) }));
    tBody.scale.set(4.6, 1.38, 4.6);
    thaadObj.add(tBody);

    const tTip = new THREE.Mesh(sharedCone, new THREE.MeshBasicMaterial({ color: new THREE.Color(4.2, 3.3, 1.1) }));
    tTip.scale.set(1.55, 1.75, 1.55);
    tTip.position.y = 0.98;
    thaadObj.add(tTip);

    const tExhaust = new THREE.Mesh(
      sharedCone,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(2.0, 4.0, 4.8),
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    tExhaust.rotation.x = Math.PI;
    tExhaust.scale.set(1.85, 5.4, 1.85);
    tExhaust.position.y = -1.75;
    thaadObj.add(tExhaust);

    let thaadTrailCd = 0;
    let intercepted = false;
    const prevP = thaadStart.clone();
    const vel = new THREE.Vector3();

    this.add(thaadObj, flightMs, (o, t, dt) => {
      const p = thaadStart.clone().lerp(interceptP, t);
      p.y += Math.sin(t * Math.PI) * 2.6;
      vel.copy(p).sub(prevP);
      if (vel.lengthSq() > 0.00001) {
        o.quaternion.setFromUnitVectors(UP, vel.normalize());
      }
      prevP.copy(p);
      o.position.copy(p);

      thaadTrailCd += dt;
      if (thaadTrailCd >= 0.03 && t < 0.94) {
        thaadTrailCd = 0;
        this.spawnContrail(p.x, p.y, p.z, 1.38);
      }

      // 3. At 700ms: COLOSSAL SKY-HIGH KINETIC INTERCEPT AIRBURST at y = 19 (ZERO ground crater!)
      if (t >= 0.96 && !intercepted) {
        intercepted = true;

        // Blinding cyan-gold starburst flash sprites high in the sky
        this.spawnFlash(interceptP, new THREE.Color(2.6, 4.6, 5.4), 9.2, 620);
        this.spawnFlash(interceptP, new THREE.Color(4.8, 3.6, 1.25), 6.4, 480);

        // Expanding incandescent kinetic kill core sphere at y = 19
        const coreMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(2.4, 4.2, 5.0),
          transparent: true,
          opacity: 0.96,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const coreBall = new THREE.Mesh(sharedNukeCap, coreMat);
        coreBall.position.copy(interceptP);
        this.add(coreBall, 640, (bo, bt) => {
          const ease = 1 - Math.pow(1 - bt, 2.2);
          bo.scale.setScalar(0.75 + ease * 5.2);
          coreMat.opacity = 0.96 * Math.pow(1 - bt, 1.6);
        });

        // 3D Starburst kinetic flare spikes radiating from the hit-to-kill intercept point!
        const starGroup = new THREE.Group();
        starGroup.position.copy(interceptP);
        const rayMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(3.6, 4.6, 5.0),
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const rayDirs: [number, number, number][] = [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
          [1, 1, 0],
          [0, 1, 1],
          [1, 0, -1],
        ];
        for (const [rx, ry, rz] of rayDirs) {
          const ray = new THREE.Mesh(sharedCyl, rayMat);
          ray.quaternion.setFromUnitVectors(UP, new THREE.Vector3(rx, ry, rz).normalize());
          ray.scale.set(3.2, 11.5, 3.2);
          starGroup.add(ray);
        }
        this.add(starGroup, 560, (so, st) => {
          const ease = 1 - Math.pow(1 - st, 2.4);
          so.scale.setScalar(0.35 + ease * 1.45);
          so.rotation.y = st * 0.9;
          so.rotation.z = st * 0.55;
          rayMat.opacity = 0.95 * Math.pow(1 - st, 1.5);
        });

        // Dual 3D spherical shockwave rings high in the sky (y = 19) + translucent 3D shockwave shell!
        const ring1Mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(1.6, 4.0, 5.0),
          transparent: true,
          opacity: 0.96,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const ring1 = new THREE.Mesh(sharedRing, ring1Mat);
        ring1.position.copy(interceptP);
        ring1.rotation.x = -Math.PI / 2 + 0.42;
        ring1.rotation.z = 0.35;
        this.add(ring1, 960, (ro, rt) => {
          const ease = 1 - Math.pow(1 - rt, 1.85);
          ro.scale.setScalar(0.6 + ease * 9.2);
          ring1Mat.opacity = 0.96 * Math.pow(1 - rt, 1.3);
        });

        const ring2Mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(4.2, 3.2, 1.05),
          transparent: true,
          opacity: 0.94,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const ring2 = new THREE.Mesh(sharedRing, ring2Mat);
        ring2.position.copy(interceptP);
        ring2.rotation.x = -Math.PI / 2 - 0.52;
        ring2.rotation.y = 0.6;
        this.add(ring2, 860, (ro, rt) => {
          const ease = 1 - Math.pow(1 - rt, 1.9);
          ro.scale.setScalar(0.5 + ease * 7.6);
          ring2Mat.opacity = 0.94 * Math.pow(1 - rt, 1.35);
        });

        // Translucent expanding 3D spherical exo-atmospheric shockwave shell
        const shellMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(1.4, 3.6, 4.4),
          transparent: true,
          opacity: 0.34,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const shell = new THREE.Mesh(sharedNukeCap, shellMat);
        shell.position.copy(interceptP);
        this.add(shell, 820, (so, st) => {
          const ease = 1 - Math.pow(1 - st, 2.0);
          so.scale.setScalar(0.8 + ease * 7.2);
          shellMat.opacity = 0.34 * Math.pow(1 - st, 1.5);
        });

        // Subtle protective cyan shield ripple on ground far below (confirming ZERO ground impact!)
        this.spawnImpactRing(tx, ty, 3.8, new THREE.Color(1.4, 3.5, 4.4), 680);

        // 18 bright high-altitude kinetic embers spraying radially in 3D space at y = 19
        for (let i = 0; i < 18; i++) {
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos(2 * Math.random() - 1);
          const spd = 5.5 + Math.random() * 8.5;
          const vx = Math.sin(phi) * Math.cos(theta) * spd;
          const vy = Math.cos(phi) * spd * 0.72;
          const vz = Math.sin(phi) * Math.sin(theta) * spd;
          const eCol =
            i % 3 === 0
              ? new THREE.Color(2.0, 4.4, 5.0)
              : i % 3 === 1
                ? new THREE.Color(4.5, 3.3, 1.1)
                : new THREE.Color(4.2, 1.4, 0.45);
          const eMat = new THREE.MeshBasicMaterial({
            color: eCol,
            transparent: true,
            opacity: 1,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          const ember = new THREE.Mesh(sharedSpark, eMat);
          ember.scale.setScalar(1.35 + Math.random() * 1.1);
          ember.position.copy(interceptP);
          this.add(ember, 820 + Math.random() * 340, (eo, et) => {
            const drag = 1 - Math.pow(1 - et, 1.7);
            eo.position.set(
              interceptP.x + vx * drag * 0.95,
              interceptP.y + vy * drag * 0.95 - et * et * 2.4,
              interceptP.z + vz * drag * 0.95,
            );
            eo.rotation.x = et * 14;
            eo.rotation.y = et * 11;
            eMat.opacity = Math.pow(1 - et, 1.25);
          });
        }

        // Crisp floating "🛡 THAAD INTERCEPTED NUKE!" popup right at the sky-high intercept!
        this.spawnPopup(tx, ty, "🛡 LATTICE AEGIS INTERCEPTED NUKE!", "#5cf4ff", 17.6);
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

  // ---------- Electronic Warfare (EW) Jamming VFX ----------

  spawnEwJam(fx: number, fy: number, tx: number, ty: number) {
    const start = new THREE.Vector3(fx, 3.12, fy);
    const end = new THREE.Vector3(tx, 2.85, ty);
    const dist = Math.max(0.25, start.distanceTo(end));
    const segs = Math.max(8, Math.min(18, Math.round(dist * 2.2)));

    // Dual intertwined crackling purple-cyan electromagnetic static arcs
    const arcSpecs: { color: THREE.Color; jitter: number; life: number }[] = [
      { color: new THREE.Color(2.6, 0.85, 4.4), jitter: 0.42, life: 420 },
      { color: new THREE.Color(0.7, 3.3, 4.5), jitter: 0.34, life: 360 },
    ];
    for (let aIdx = 0; aIdx < arcSpecs.length; aIdx++) {
      const spec = arcSpecs[aIdx];
      const positions = new Float32Array((segs + 1) * 3);
      const fillArc = (amp: number) => {
        for (let i = 0; i <= segs; i++) {
          const u = i / segs;
          const env = Math.sin(u * Math.PI);
          const off = i * 3;
          positions[off] = start.x + (end.x - start.x) * u + (Math.random() - 0.5) * amp * env;
          positions[off + 1] =
            start.y + (end.y - start.y) * u + (Math.random() - 0.5) * amp * 0.8 * env + env * 0.22;
          positions[off + 2] = start.z + (end.z - start.z) * u + (Math.random() - 0.5) * amp * env;
        }
      };
      fillArc(spec.jitter);
      const geo = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(positions, 3);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("position", posAttr);

      const mat = new THREE.LineBasicMaterial({
        color: spec.color,
        transparent: true,
        opacity: 0.98,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const bolt = new THREE.Line(geo, mat);
      let crackleAccum = 0;
      this.add(
        bolt,
        spec.life,
        (_o, t, dt) => {
          crackleAccum += dt;
          if (crackleAccum >= 0.045) {
            crackleAccum = 0;
            fillArc(spec.jitter * (1.15 - t * 0.45));
            posAttr.needsUpdate = true;
          }
          const flicker = 0.72 + 0.28 * Math.sin(t * 54 + aIdx * 2.1);
          mat.opacity = 0.98 * (1 - t) * flicker;
        },
        true,
      );
    }

    // Emitter & target electromagnetic static flashes
    this.spawnFlash(start, new THREE.Color(2.2, 0.9, 4.0), 0.95, 220);
    this.spawnFlash(end, new THREE.Color(2.6, 1.0, 4.4), 1.45, 300);
    this.spawnFlash(end, new THREE.Color(0.8, 3.2, 4.4), 1.05, 230);

    // Brief translucent purple-cyan electromagnetic static burst around the jammed drone
    const staticMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.9, 0.75, 3.6),
      transparent: true,
      opacity: 0.65,
      wireframe: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const staticOrb = new THREE.Mesh(sharedFire, staticMat);
    staticOrb.position.copy(end);
    this.add(staticOrb, 380, (o, t) => {
      o.scale.setScalar(0.38 + t * 1.45);
      o.rotation.y += 0.28;
      o.rotation.x += 0.19;
      staticMat.opacity = 0.65 * (1 - t) * (0.75 + 0.25 * Math.sin(t * 60));
    });

    // 3 staggered tilted expanding purple-cyan interference rings around the jammed drone
    const ringTilts: [number, number, THREE.Color, number][] = [
      [-Math.PI / 2 + 0.28, 0.2, new THREE.Color(2.3, 0.75, 4.2), 460],
      [-Math.PI / 2 - 0.34, -0.26, new THREE.Color(0.75, 3.2, 4.4), 400],
      [-Math.PI / 2, 0, new THREE.Color(1.85, 1.3, 4.2), 520],
    ];
    for (let i = 0; i < ringTilts.length; i++) {
      const [rx, rz, col, life] = ringTilts[i];
      const rMat = new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(sharedRing, rMat);
      ring.position.copy(end);
      ring.rotation.set(rx, 0, rz);
      const delay = i * 0.1;
      this.add(ring, life, (ro, t) => {
        if (t < delay) {
          rMat.opacity = 0;
          return;
        }
        const rt = (t - delay) / (1 - delay);
        const ease = 1 - Math.pow(1 - rt, 1.8);
        ro.scale.setScalar(0.24 + ease * (1.85 + i * 0.25));
        ro.rotateZ(0.12 * (i % 2 === 0 ? 1 : -1));
        rMat.opacity = 0.92 * (1 - rt) * (1 - rt);
      });
    }

    // Subtle ground-projected purple-cyan EW ripple directly beneath the jammed drone
    this.spawnImpactRing(tx, ty, 1.65, new THREE.Color(1.9, 0.85, 3.8), 440);

    // Floating "JAMMED!" popup right above the disrupted drone
    this.spawnPopup(tx, ty, "JAMMED!", "#cc7cff", 3.65);
  }

  // ---------- Floating World-Space Text Popups ----------

  spawnPopup(x: number, y: number, text: string, color = "#ffd84d", startY = 1.65) {
    const wide = text.length > 16;
    const W = wide ? 640 : 384;
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
    const baseW = wide ? 6.4 : 3.8;
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
        if (f.pool && f.pool.length < 160) f.pool.push(f.obj);
        else disposeFxObj(f.obj, !!f.disposeGeo, !!f.disposeTex);
        // swap-remove keeps O(1) — order across fx objects is irrelevant
        this.fxs[i] = this.fxs[this.fxs.length - 1];
        this.fxs.pop();
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
      if (f.pool && f.pool.length < 160) f.pool.push(f.obj);
      else disposeFxObj(f.obj, !!f.disposeGeo, !!f.disposeTex);
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

    // Pre-allocated reusable LineSegments pools (one per OrderKind)
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
