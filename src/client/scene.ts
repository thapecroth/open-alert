import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { MAP_W, MAP_H, MapId, getMapLayout } from "../shared/gamedefs";
import { createBattlefieldTextures, getCliffRockMaterials } from "./textures";

// Facade preserving the legacy engine API expected by main.ts / input.ts / tests
class EngineShim {
  constructor(private gs: GameScene) {}
  getRenderingCanvas() {
    return this.gs.canvas;
  }
  getRenderWidth() {
    return this.gs.canvas.clientWidth;
  }
  getRenderHeight() {
    return this.gs.canvas.clientHeight;
  }
  getDeltaTime() {
    return this.gs.dtMs;
  }
  runRenderLoop(cb: () => void) {
    this.gs.setLoop(cb);
  }
  resize() {
    this.gs.resize();
  }
}

// Deterministic per-tile hash in [0, 1) for organic rock & tree placement
function tileHash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class GameScene {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  engine: EngineShim;
  camTarget = new THREE.Vector3(MAP_W / 2, 0, MAP_H / 2);
  camHeight = 26;
  camYaw = 0; // radians around Y axis (0 = North-Up)
  ground!: THREE.Mesh;
  raycaster = new THREE.Raycaster();
  pickables: THREE.Object3D[] = []; // entity roots — raycast for pickEntity
  pointerX = 0;
  pointerY = 0;
  pointerInside = false;
  dtMs = 16;
  envReady = false;

  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private groundMat!: THREE.MeshStandardMaterial;
  private skirtMat!: THREE.MeshStandardMaterial;
  private ore!: THREE.InstancedMesh;
  private oreSlots = new Map<number, number>(); // cellKey -> instance index
  private oreFree: number[] = [];
  private orePeak = 0;
  private static ORE_MAX = 4096;
  private dummy = new THREE.Object3D();

  // Map cliffs & biome terrain
  private mapId: MapId = "crossroads";
  private cliffSet = new Set<number>();
  private mapGroup: THREE.Group | null = null;

  // Live 64x64 Fog of War shroud plane
  private fogMesh!: THREE.Mesh;
  private fogTex!: THREE.DataTexture;
  private fogData = new Uint8Array(MAP_W * MAP_H * 4);
  private fogExplored = new Uint8Array(MAP_W * MAP_H);
  private fogVisBuf = new Float32Array(MAP_W * MAP_H);
  private reconReveals: { x: number; y: number; r: number; expiresAt: number }[] = [];
  private lastFogSlot = -1;
  private lastFogSources: { x: number; y: number; r: number }[] = [];

  // Build-zone perimeter overlay
  private buildZoneGroup = new THREE.Group();

  // Damped cinematic camera shake
  private shakeAmp = 0;
  private shakePhase = 0;
  private shakeOffset = new THREE.Vector3();
  private lookVec = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.engine = new EngineShim(this);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1520);
    this.scene.fog = new THREE.FogExp2(0x0d1520, 0.0042);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.5, 700);
    this.updateCamera();

    // Tactical daylight-dusk lighting: warm sun key + cool sky bounce + soft rim
    const hemi = new THREE.HemisphereLight(0xa6c4e6, 0x3b352a, 1.05);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffe7c2, 2.05);
    dir.position.set(-28, 60, 42);
    dir.target.position.set(MAP_W / 2, 0, MAP_H / 2);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -48;
    dir.shadow.camera.right = 48;
    dir.shadow.camera.top = 48;
    dir.shadow.camera.bottom = -48;
    dir.shadow.camera.near = 10;
    dir.shadow.camera.far = 180;
    dir.shadow.bias = -0.0004;
    dir.shadow.normalBias = 0.03;
    this.scene.add(dir, dir.target);

    // Subtle cool counter-fill so shaded sides stay legible
    const rim = new THREE.DirectionalLight(0x52a8dc, 0.45);
    rim.position.set(55, 28, -35);
    this.scene.add(rim);

    // HDRI environment for metallic specular reflections
    new RGBELoader().load("/tex/satara_night_1k.hdr", (hdr) => {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const env = pmrem.fromEquirectangular(hdr).texture;
      this.scene.environment = env;
      this.scene.environmentIntensity = 0.5;
      hdr.dispose();
      pmrem.dispose();
      this.envReady = true;
    });

    // Calibrated bloom: crisp weapon flashes & energy cores without blowing out meshes
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1024, 1024), 0.34, 0.48, 0.92);
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());

    // Pointer tracking — synced on move AND down so clicks never use stale coordinates
    canvas.addEventListener("pointermove", (e) => this.syncPointer(e.clientX, e.clientY));
    canvas.addEventListener("pointerdown", (e) => this.syncPointer(e.clientX, e.clientY));

    this.buildSky();
    this.buildGround();
    this.buildPerimeter();
    this.buildOre();
    this.buildFog();
    this.buildZoneGroup.renderOrder = 4;
    this.buildZoneGroup.visible = false;
    this.scene.add(this.buildZoneGroup);
    this.loadMap("crossroads");
    this.resize();
  }

  syncPointer(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    this.pointerX = clientX - r.left;
    this.pointerY = clientY - r.top;
  }

  // ---------- environment pieces ----------

  private buildSky() {
    const geo = new THREE.SphereGeometry(420, 24, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0x162436, side: THREE.BackSide, fog: false, depthWrite: false });
    new THREE.TextureLoader().load("/tex/sky.png", (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t;
      mat.color.setHex(0xffffff);
      mat.needsUpdate = true;
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.renderOrder = -10;
    this.scene.add(sky);
  }

  private buildGround() {
    const geo = new THREE.PlaneGeometry(MAP_W, MAP_H);
    geo.rotateX(-Math.PI / 2);
    this.groundMat = new THREE.MeshStandardMaterial({
      bumpScale: 0.14,
      roughness: 0.92,
      metalness: 0.04,
    });
    const g = new THREE.Mesh(geo, this.groundMat);
    g.position.set(MAP_W / 2, 0, MAP_H / 2);
    g.receiveShadow = true;
    this.ground = g;
    this.scene.add(g);

    // Subtle tactical command grid overlay (uniform color so no fake center UV seam)
    const grid = new THREE.GridHelper(MAP_W, MAP_W, 0x3b6e80, 0x3b6e80);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.045;
    grid.position.set(MAP_W / 2, 0.018, MAP_H / 2);
    this.scene.add(grid);
  }

  private buildPerimeter() {
    // Grounded outer terrain skirt fading into atmospheric fog instead of floating over pitch black
    const skirtGeo = new THREE.PlaneGeometry(MAP_W * 4, MAP_H * 4);
    skirtGeo.rotateX(-Math.PI / 2);
    this.skirtMat = new THREE.MeshStandardMaterial({
      color: 0x1e2524,
      roughness: 0.96,
      metalness: 0.02,
    });
    const skirt = new THREE.Mesh(skirtGeo, this.skirtMat);
    skirt.position.set(MAP_W / 2, -0.18, MAP_H / 2);
    skirt.receiveShadow = true;
    this.scene.add(skirt);

    // Subtle glowing tactical boundary line around the playable 64x64 theater
    const borderPts = [
      new THREE.Vector3(0, 0.05, 0),
      new THREE.Vector3(MAP_W, 0.05, 0),
      new THREE.Vector3(MAP_W, 0.05, MAP_H),
      new THREE.Vector3(0, 0.05, MAP_H),
      new THREE.Vector3(0, 0.05, 0),
    ];
    const border = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(borderPts),
      new THREE.LineBasicMaterial({ color: 0x3c8ba6, transparent: true, opacity: 0.45 }),
    );
    this.scene.add(border);
  }

  // ---------- Elevated 3D Cliff Mesas & Map Loading ----------

  loadMap(mapId: MapId): void {
    this.mapId = mapId;
    const prevMap = this.groundMat.map;
    const prevBump = this.groundMat.bumpMap;
    const { map, bumpMap } = createBattlefieldTextures(mapId);
    this.groundMat.map = map;
    this.groundMat.bumpMap = bumpMap;
    this.groundMat.needsUpdate = true;
    prevMap?.dispose();
    prevBump?.dispose();

    // Biome atmosphere tuning across all 8 theaters
    const atm: Record<MapId, { bg: number; skirt: number; fogDensity: number }> = {
      crossroads: { bg: 0x0d1520, skirt: 0x1e2524, fogDensity: 0.0042 },
      canyon: { bg: 0x1d1310, skirt: 0x2f1e17, fogDensity: 0.0045 },
      basin: { bg: 0x0b121b, skirt: 0x181f27, fogDensity: 0.0046 },
      tundra: { bg: 0x142233, skirt: 0x3a4d5f, fogDensity: 0.0048 },
      fortress: { bg: 0x1c1711, skirt: 0x362b1f, fogDensity: 0.004 },
      jungle: { bg: 0x0a1a13, skirt: 0x172b1d, fogDensity: 0.0048 },
      islands: { bg: 0x0a1c26, skirt: 0x113142, fogDensity: 0.0042 },
      oasis: { bg: 0x221810, skirt: 0x422f1d, fogDensity: 0.0044 },
    };
    const a = atm[mapId] ?? atm.crossroads;
    (this.scene.background as THREE.Color).setHex(a.bg);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.setHex(a.bg);
      this.scene.fog.density = a.fogDensity;
    }
    this.skirtMat.color.setHex(a.skirt);

    // Clear previous 3D cliff mesas & props
    if (this.mapGroup) {
      this.scene.remove(this.mapGroup);
      this.mapGroup.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
          o.geometry.dispose();
        }
      });
      this.mapGroup = null;
    }

    const layout = getMapLayout(mapId);
    this.cliffSet.clear();
    for (const [cx, cy] of layout.cliffs) {
      this.cliffSet.add(cy * MAP_W + cx);
    }

    const group = new THREE.Group();
    const cliffs = layout.cliffs;
    if (cliffs.length > 0) {
      const mats = getCliffRockMaterials(mapId);
      const hasCliff = (tx: number, ty: number) =>
        tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H && this.cliffSet.has(ty * MAP_W + tx);

      const isIslands = mapId === "islands";
      const isFortress = mapId === "fortress";
      const isTundra = mapId === "tundra";
      const isJungle = mapId === "jungle";
      const isOasis = mapId === "oasis";

      // 1) Tapered rocky/glacial/citadel base wall blocks
      const wallGeo = isFortress
        ? new THREE.BoxGeometry(1.02, 1, 1.02)
        : new THREE.CylinderGeometry(isIslands ? 0.56 : 0.67, isIslands ? 0.78 : 0.82, 1, 4);
      if (!isFortress) wallGeo.rotateY(Math.PI / 4);
      const wallInst = new THREE.InstancedMesh(wallGeo, mats.wall, cliffs.length);
      wallInst.castShadow = true;
      wallInst.receiveShadow = true;

      // 2) Sunlit terraced weathered cap plateau
      const capGeo = isFortress
        ? new THREE.BoxGeometry(1.06, 1, 1.06)
        : new THREE.CylinderGeometry(isIslands ? 0.44 : 0.58, isIslands ? 0.6 : 0.7, 1, 4);
      if (!isFortress) capGeo.rotateY(Math.PI / 4);
      const capInst = new THREE.InstancedMesh(capGeo, mats.cap, cliffs.length);
      capInst.castShadow = true;
      capInst.receiveShadow = true;

      // 3) Interior mesa bridge slabs so multi-tile mesas have a solid unified terrace deck
      const deckGeo = new THREE.BoxGeometry(1.06, isFortress ? 0.42 : 0.36, 1.06);
      const deckInst = new THREE.InstancedMesh(deckGeo, mats.cap, cliffs.length);
      deckInst.castShadow = true;
      deckInst.receiveShadow = true;

      // Optional river-gorge water slab across impassable channels on Islands
      let waterInst: THREE.InstancedMesh | null = null;
      if (isIslands && mats.water) {
        const waterGeo = new THREE.BoxGeometry(1.06, 0.14, 1.06);
        waterInst = new THREE.InstancedMesh(waterGeo, mats.water, cliffs.length);
        waterInst.receiveShadow = true;
      }

      const boulderTransforms: { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number }[] = [];
      const treeTransforms: { x: number; y: number; z: number; s: number; ry: number }[] = [];
      const accentTransforms: { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number }[] = [];

      let wallCount = 0;
      let capCount = 0;
      let deckCount = 0;
      const d = this.dummy;
      for (let i = 0; i < cliffs.length; i++) {
        const [tx, ty] = cliffs[i];
        const h1 = tileHash(tx, ty, 1);
        const h2 = tileHash(tx, ty, 2);
        const h3 = tileHash(tx, ty, 3);
        const nN = hasCliff(tx, ty - 1);
        const nS = hasCliff(tx, ty + 1);
        const nW = hasCliff(tx - 1, ty);
        const nE = hasCliff(tx + 1, ty);
        const neighbors = (nN ? 1 : 0) + (nS ? 1 : 0) + (nW ? 1 : 0) + (nE ? 1 : 0);

        const cx = tx + 0.5;
        const cz = ty + 0.5;

        if (waterInst) {
          d.position.set(cx, 0.08, cz);
          d.rotation.set(0, 0, 0);
          d.scale.set(1, 1, 1);
          d.updateMatrix();
          waterInst.setMatrixAt(i, d.matrix);
        }

        // Biome-appropriate cliff elevation
        let baseH = 1.48 + h1 * 0.34 + (neighbors >= 3 ? 0.2 : 0);
        if (mapId === "canyon") baseH = 1.85 + h1 * 0.34 + (neighbors >= 3 ? 0.2 : 0);
        else if (isTundra) baseH = 1.64 + h1 * 0.44 + (neighbors >= 3 ? 0.24 : 0);
        else if (isFortress) baseH = 1.56 + (neighbors >= 2 ? 0.1 : 0) + h1 * 0.09;
        else if (isJungle) baseH = 1.6 + h1 * 0.36 + (neighbors >= 3 ? 0.22 : 0);
        else if (isOasis) baseH = 1.5 + h1 * 0.34 + (neighbors >= 3 ? 0.18 : 0);
        else if (isIslands) baseH = 0.46 + h1 * 0.46 + (neighbors < 4 ? 0.18 : 0);

        const capH = isFortress ? 0.24 : isIslands ? 0.18 + h2 * 0.14 : 0.28 + h2 * 0.16;

        // On Islands, leave sleek deep water channels in interior tiles while raising jagged wet-slate crags along banks & islets
        const buildCrag = !isIslands || neighbors < 4 || h2 > 0.52;
        if (buildCrag) {
          d.position.set(cx, baseH * 0.5 - 0.04, cz);
          d.rotation.set(0, isIslands ? (h1 - 0.5) * 0.28 : 0, 0);
          const sx = isIslands ? 0.78 + h2 * 0.28 : 1.04 + (nW || nE ? 0.06 : 0);
          const sz = isIslands ? 0.78 + h3 * 0.28 : 1.04 + (nN || nS ? 0.06 : 0);
          d.scale.set(sx, baseH, sz);
          d.updateMatrix();
          wallInst.setMatrixAt(wallCount++, d.matrix);

          d.position.set(cx + (h2 - 0.5) * (isFortress ? 0.01 : 0.05), baseH + capH * 0.42, cz + (h3 - 0.5) * (isFortress ? 0.01 : 0.05));
          d.rotation.set(0, isFortress ? 0 : (h1 - 0.5) * 0.1, 0);
          d.scale.set(isIslands ? sx * 0.85 : 0.98, capH, isIslands ? sz * 0.85 : 0.98);
          d.updateMatrix();
          capInst.setMatrixAt(capCount++, d.matrix);
        }

        // Unified mesa deck on tiles connected to >= 2 cliff neighbors (skipped on open river channels)
        if (!isIslands && neighbors >= 2) {
          d.position.set(cx, baseH - 0.06, cz);
          d.rotation.set(0, 0, 0);
          d.scale.set(1, 1, 1);
          d.updateMatrix();
          deckInst.setMatrixAt(deckCount++, d.matrix);
        }

        // Edge scree boulders tucked tightly against exposed cliff flanks
        const edgeDirs: [number, number][] = [];
        if (!nN) edgeDirs.push([0, -1]);
        if (!nS) edgeDirs.push([0, 1]);
        if (!nW) edgeDirs.push([-1, 0]);
        if (!nE) edgeDirs.push([1, 0]);
        for (let ei = 0; ei < edgeDirs.length; ei++) {
          const rh = tileHash(tx + ei * 17, ty, 7);
          const boulderThresh = isFortress ? 0.76 : isIslands ? 0.46 : 0.54;
          if (rh > boulderThresh) {
            const [ex, ez] = edgeDirs[ei];
            const tang = (tileHash(tx, ty + ei * 13, 11) - 0.5) * 0.58;
            const bx = cx + ex * 0.56 + (ez !== 0 ? tang : 0);
            const bz = cz + ez * 0.56 + (ex !== 0 ? tang : 0);
            const bs = 0.22 + tileHash(tx, ty, 19 + ei) * 0.22;
            boulderTransforms.push({
              x: bx,
              y: bs * 0.48,
              z: bz,
              sx: bs * (0.95 + rh * 0.45),
              sy: bs * (0.65 + h2 * 0.4),
              sz: bs * (0.9 + h3 * 0.4),
              ry: rh * Math.PI * 2,
            });
          }

          // Fortified dark-stone citadel parapet merlons along exposed Fortress wall tops
          if (isFortress && (tx + ty) % 2 === 0) {
            const [ex, ez] = edgeDirs[ei];
            accentTransforms.push({
              x: cx + ex * 0.36,
              y: baseH + capH + 0.12,
              z: cz + ez * 0.36,
              sx: ez !== 0 ? 0.46 : 0.24,
              sy: 0.28,
              sz: ex !== 0 ? 0.46 : 0.24,
              ry: 0,
            });
          }
        }

        // Glacier ice spires on Tundra ledges
        if (isTundra && h2 > 0.62) {
          accentTransforms.push({
            x: cx + (h1 - 0.5) * 0.36,
            y: baseH + capH * 0.8 + 0.28,
            z: cz + (h3 - 0.5) * 0.36,
            sx: 0.22 + h1 * 0.16,
            sy: 0.55 + h2 * 0.6,
            sz: 0.22 + h3 * 0.16,
            ry: h1 * Math.PI * 2,
          });
        }

        // Biome-specific trees / palms / jungle canopy / scrub placement
        const treeThresh = isJungle ? 0.28 : isFortress ? 0.82 : isIslands ? 0.64 : isOasis ? 0.52 : 0.56;
        if (buildCrag && h3 > treeThresh) {
          const count = isJungle ? (h1 > 0.45 ? 2 : 1) : h1 > 0.65 ? 2 : 1;
          for (let ti = 0; ti < count; ti++) {
            const ox = (tileHash(tx, ty, 31 + ti) - 0.5) * 0.52;
            const oz = (tileHash(tx, ty, 47 + ti) - 0.5) * 0.52;
            const scBase =
              mapId === "canyon" || isFortress
                ? 0.52
                : isJungle
                  ? 0.92
                  : isOasis
                    ? 0.86
                    : isIslands
                      ? 0.66
                      : 0.72;
            const sc = scBase + tileHash(tx, ty, 59 + ti) * 0.42;
            treeTransforms.push({
              x: cx + ox,
              y: baseH + capH * 0.78,
              z: cz + oz,
              s: sc,
              ry: tileHash(tx, ty, 71 + ti) * Math.PI * 2,
            });
          }
        }
      }
      wallInst.count = wallCount;
      wallInst.instanceMatrix.needsUpdate = true;
      capInst.count = capCount;
      capInst.instanceMatrix.needsUpdate = true;
      deckInst.count = deckCount;
      deckInst.instanceMatrix.needsUpdate = true;
      group.add(wallInst, capInst, deckInst);
      if (waterInst) {
        waterInst.instanceMatrix.needsUpdate = true;
        group.add(waterInst);
      }

      // Scree boulders around cliff bases
      if (boulderTransforms.length > 0) {
        const bGeo = new THREE.DodecahedronGeometry(0.65, 0);
        const bInst = new THREE.InstancedMesh(bGeo, mats.boulder, boulderTransforms.length);
        bInst.castShadow = true;
        bInst.receiveShadow = true;
        boulderTransforms.forEach((b, idx) => {
          d.position.set(b.x, b.y, b.z);
          d.rotation.set(b.ry * 0.3, b.ry, b.ry * 0.2);
          d.scale.set(b.sx, b.sy, b.sz);
          d.updateMatrix();
          bInst.setMatrixAt(idx, d.matrix);
        });
        bInst.instanceMatrix.needsUpdate = true;
        group.add(bInst);
      }

      // Biome accent architecture / glacier crystal spires
      if (accentTransforms.length > 0 && mats.accent) {
        const accGeo = isTundra ? new THREE.ConeGeometry(0.55, 1, 5) : new THREE.BoxGeometry(1, 1, 1);
        const accInst = new THREE.InstancedMesh(accGeo, mats.accent, accentTransforms.length);
        accInst.castShadow = true;
        accInst.receiveShadow = true;
        accentTransforms.forEach((aTr, idx) => {
          d.position.set(aTr.x, aTr.y, aTr.z);
          d.rotation.set(0, aTr.ry, 0);
          d.scale.set(aTr.sx, aTr.sy, aTr.sz);
          d.updateMatrix();
          accInst.setMatrixAt(idx, d.matrix);
        });
        accInst.instanceMatrix.needsUpdate = true;
        group.add(accInst);
      }

      // Stylized biome foliage: conifer pines, snow-frosted spruce, desert palms, lush jungle canopies, or canyon scrub
      if (treeTransforms.length > 0) {
        const trunkH = isOasis ? 0.88 : isJungle ? 0.56 : 0.34;
        const trunkGeo = new THREE.CylinderGeometry(isOasis ? 0.042 : 0.055, isOasis ? 0.078 : 0.085, trunkH, 6);
        trunkGeo.translate(0, trunkH * 0.5, 0);
        const trunkInst = new THREE.InstancedMesh(trunkGeo, mats.trunk, treeTransforms.length);
        trunkInst.castShadow = true;

        let canopyGeo: THREE.BufferGeometry;
        let snowCapGeo: THREE.BufferGeometry | null = null;
        if (mapId === "canyon" || isFortress) {
          // Hardy desert scrub cluster
          const s1 = new THREE.DodecahedronGeometry(0.28, 0);
          s1.scale(1.15, 0.68, 1.15);
          s1.translate(0, 0.28, 0);
          const s2 = new THREE.DodecahedronGeometry(0.2, 0);
          s2.translate(0.14, 0.22, 0.08);
          canopyGeo = mergeGeometries([s1, s2])!;
          s1.dispose();
          s2.dispose();
        } else if (isOasis) {
          // Iconic Sahara palm crown (radiating arched fronds)
          const fronds: THREE.BufferGeometry[] = [];
          for (let fi = 0; fi < 6; fi++) {
            const ang = (fi / 6) * Math.PI * 2;
            const f = new THREE.BoxGeometry(0.12, 0.03, 0.52);
            f.rotateX(0.32);
            f.translate(0, 0, 0.24);
            f.rotateY(ang);
            f.translate(0, trunkH + 0.02, 0);
            fronds.push(f);
          }
          const crown = new THREE.DodecahedronGeometry(0.12, 0);
          crown.translate(0, trunkH + 0.05, 0);
          fronds.push(crown);
          canopyGeo = mergeGeometries(fronds)!;
          fronds.forEach((g) => g.dispose());
        } else if (isJungle) {
          // Rich dense multi-layered tropical broadleaf umbrella canopy
          const b1 = new THREE.DodecahedronGeometry(0.42, 0);
          b1.scale(1.25, 0.58, 1.25);
          b1.translate(0, trunkH + 0.16, 0);
          const b2 = new THREE.DodecahedronGeometry(0.32, 0);
          b2.scale(1.15, 0.62, 1.15);
          b2.translate(0.22, trunkH + 0.05, 0.14);
          const b3 = new THREE.DodecahedronGeometry(0.28, 0);
          b3.scale(1.1, 0.65, 1.1);
          b3.translate(-0.2, trunkH + 0.22, -0.14);
          canopyGeo = mergeGeometries([b1, b2, b3])!;
          b1.dispose();
          b2.dispose();
          b3.dispose();
        } else {
          // Layered tactical pine / arctic spruce conifer (3 stacked faceted cones)
          const c1 = new THREE.ConeGeometry(0.36, 0.56, 7);
          c1.translate(0, 0.52, 0);
          const c2 = new THREE.ConeGeometry(0.28, 0.5, 7);
          c2.translate(0, 0.84, 0);
          const c3 = new THREE.ConeGeometry(0.18, 0.42, 7);
          c3.translate(0, 1.14, 0);
          canopyGeo = mergeGeometries([c1, c2, c3])!;
          c1.dispose();
          c2.dispose();
          c3.dispose();
          if (isTundra && mats.accent) {
            // Crisp snow-frosted crown dusting on top of arctic spruce
            const sc1 = new THREE.ConeGeometry(0.2, 0.28, 7);
            sc1.translate(0, 1.22, 0);
            const sc2 = new THREE.ConeGeometry(0.3, 0.16, 7);
            sc2.translate(0, 0.94, 0);
            snowCapGeo = mergeGeometries([sc1, sc2])!;
            sc1.dispose();
            sc2.dispose();
          }
        }
        const canopyInst = new THREE.InstancedMesh(canopyGeo, mats.foliage, treeTransforms.length);
        canopyInst.castShadow = true;
        canopyInst.receiveShadow = true;
        const snowInst = snowCapGeo && mats.accent ? new THREE.InstancedMesh(snowCapGeo, mats.accent, treeTransforms.length) : null;

        treeTransforms.forEach((tr, idx) => {
          d.position.set(tr.x, tr.y, tr.z);
          d.rotation.set(0, tr.ry, 0);
          d.scale.setScalar(tr.s);
          d.updateMatrix();
          trunkInst.setMatrixAt(idx, d.matrix);
          canopyInst.setMatrixAt(idx, d.matrix);
          snowInst?.setMatrixAt(idx, d.matrix);
        });
        trunkInst.instanceMatrix.needsUpdate = true;
        canopyInst.instanceMatrix.needsUpdate = true;
        group.add(trunkInst, canopyInst);
        if (snowInst) {
          snowInst.instanceMatrix.needsUpdate = true;
          group.add(snowInst);
        }
      }
    }

    // Never add mapGroup to this.pickables so terrain never blocks unit selection!
    this.mapGroup = group;
    this.scene.add(group);
    this.resetFog();
  }

  isCliff(x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return false;
    return this.cliffSet.has(ty * MAP_W + tx);
  }

  // ---------- Live Fog of War Shroud ----------

  private buildFog() {
    this.fogTex = new THREE.DataTexture(this.fogData, MAP_W, MAP_H, THREE.RGBAFormat);
    this.fogTex.magFilter = THREE.LinearFilter;
    this.fogTex.minFilter = THREE.LinearFilter;
    this.fogTex.generateMipmaps = false;
    this.fogTex.wrapS = THREE.ClampToEdgeWrapping;
    this.fogTex.wrapT = THREE.ClampToEdgeWrapping;

    const geo = new THREE.PlaneGeometry(MAP_W, MAP_H);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: this.fogTex,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.fogMesh = new THREE.Mesh(geo, mat);
    this.fogMesh.position.set(MAP_W / 2, 0.035, MAP_H / 2);
    this.fogMesh.renderOrder = 2;
    this.fogMesh.visible = false;
    this.scene.add(this.fogMesh);
    this.resetFog();
  }

  resetFog(): void {
    this.reconReveals = [];
    this.lastFogSlot = -1;
    this.lastFogSources = [];
    this.fogExplored.fill(0);
    const d = this.fogData;
    for (let i = 0; i < MAP_W * MAP_H; i++) {
      const p = i * 4;
      d[p] = 7;
      d[p + 1] = 12;
      d[p + 2] = 20;
      d[p + 3] = 184; // ~0.72 unexplored shroud
    }
    this.fogTex.needsUpdate = true;
  }

  addReconReveal(x: number, y: number, r: number, durationMs = 10000): void {
    this.reconReveals.push({ x, y, r, expiresAt: performance.now() + durationMs });
    if (this.lastFogSlot >= 0) {
      this.updateFog(this.lastFogSlot, this.lastFogSources);
    }
  }

  getActiveReconReveals(): { x: number; y: number; r: number }[] {
    const now = performance.now();
    if (this.reconReveals.length > 0) {
      let write = 0;
      for (let i = 0; i < this.reconReveals.length; i++) {
        if (this.reconReveals[i].expiresAt > now) {
          this.reconReveals[write++] = this.reconReveals[i];
        }
      }
      this.reconReveals.length = write;
    }
    return this.reconReveals;
  }

  updateFog(mySlot: number, visionSources: { x: number; y: number; r: number }[]): void {
    this.lastFogSlot = mySlot;
    this.lastFogSources = visionSources;
    if (mySlot < 0) {
      this.fogMesh.visible = false;
      return;
    }
    this.fogMesh.visible = true;

    const vis = this.fogVisBuf;
    const exp = this.fogExplored;
    vis.fill(0);

    const recon = this.getActiveReconReveals();
    const totalSources = visionSources.length + recon.length;
    for (let i = 0; i < totalSources; i++) {
      const s = i < visionSources.length ? visionSources[i] : recon[i - visionSources.length];
      const rOut = s.r + 1.15;
      const rIn = Math.max(0.5, s.r - 1.5);
      const span = Math.max(0.1, rOut - rIn);
      const x0 = Math.max(0, Math.floor(s.x - rOut));
      const x1 = Math.min(MAP_W - 1, Math.ceil(s.x + rOut));
      const y0 = Math.max(0, Math.floor(s.y - rOut));
      const y1 = Math.min(MAP_H - 1, Math.ceil(s.y + rOut));
      for (let ty = y0; ty <= y1; ty++) {
        const dy = ty + 0.5 - s.y;
        const rowOff = ty * MAP_W;
        for (let tx = x0; tx <= x1; tx++) {
          const dx = tx + 0.5 - s.x;
          const dist = Math.hypot(dx, dy);
          if (dist < rOut) {
            const idx = rowOff + tx;
            if (dist <= s.r + 0.2) exp[idx] = 1;
            let f = dist <= rIn ? 1 : 1 - (dist - rIn) / span;
            f = f * f * (3 - 2 * f);
            if (f > vis[idx]) vis[idx] = f;
          }
        }
      }
    }

    const d = this.fogData;
    for (let ty = 0; ty < MAP_H; ty++) {
      const rowOff = ty * MAP_W;
      // DataTexture flipY=false maps row 0 to v=0 (+Z = MAP_H) and row MAP_H-1 to v=1 (z = 0)
      const texRowOff = (MAP_H - 1 - ty) * MAP_W;
      for (let tx = 0; tx < MAP_W; tx++) {
        const idx = rowOff + tx;
        const explored = exp[idx];
        const v = vis[idx];
        const baseAlpha = explored ? 87 : 184; // ~0.34 explored dimmed fog, ~0.72 unexplored shroud
        const p = (texRowOff + tx) * 4;
        d[p] = explored ? 10 : 7;
        d[p + 1] = explored ? 18 : 12;
        d[p + 2] = explored ? 28 : 20;
        d[p + 3] = Math.round(baseAlpha * (1 - v));
      }
    }
    this.fogTex.needsUpdate = true;
  }

  // ---------- Build-Zone Overlay (+2 tile perimeter frames) ----------

  setBuildZones(zones: { x: number; y: number; w: number; h: number }[] | null): void {
    while (this.buildZoneGroup.children.length > 0) {
      const c = this.buildZoneGroup.children.pop()!;
      c.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m.dispose();
        }
      });
    }
    if (!zones || zones.length === 0) {
      this.buildZoneGroup.visible = false;
      return;
    }
    this.buildZoneGroup.visible = true;

    const fillMat = new THREE.MeshBasicMaterial({
      color: 0x30dcff,
      transparent: true,
      opacity: 0.065,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x52f2ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const cornerMat = new THREE.LineBasicMaterial({
      color: 0xb8fbff,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    });

    const yFill = 0.048;
    const yLine = 0.062;
    const cornerPts: THREE.Vector3[] = [];

    for (const z of zones) {
      // Zones pass building top-left tile (x, y) and footprint (w, h); expand by +2 tiles each side
      const x0 = Math.max(0, z.x - 2);
      const x1 = Math.min(MAP_W, z.x + z.w + 2);
      const z0 = Math.max(0, z.y - 2);
      const z1 = Math.min(MAP_H, z.y + z.h + 2);
      const bw = x1 - x0;
      const bh = z1 - z0;
      if (bw <= 0 || bh <= 0) continue;

      // Subtle translucent cyan pad highlight
      const planeGeo = new THREE.PlaneGeometry(bw, bh);
      planeGeo.rotateX(-Math.PI / 2);
      const fill = new THREE.Mesh(planeGeo, fillMat.clone());
      fill.position.set((x0 + x1) * 0.5, yFill, (z0 + z1) * 0.5);
      fill.renderOrder = 4;
      this.buildZoneGroup.add(fill);

      // Glowing cyan perimeter frame
      const framePts = [
        new THREE.Vector3(x0, yLine, z0),
        new THREE.Vector3(x1, yLine, z0),
        new THREE.Vector3(x1, yLine, z1),
        new THREE.Vector3(x0, yLine, z1),
        new THREE.Vector3(x0, yLine, z0),
      ];
      const frame = new THREE.Line(new THREE.BufferGeometry().setFromPoints(framePts), lineMat.clone());
      frame.renderOrder = 5;
      this.buildZoneGroup.add(frame);

      // Crisp bright L-brackets at all 4 corners
      const arm = Math.min(0.65, bw * 0.2, bh * 0.2);
      const yC = yLine + 0.008;
      // Top-left
      cornerPts.push(new THREE.Vector3(x0, yC, z0 + arm), new THREE.Vector3(x0, yC, z0));
      cornerPts.push(new THREE.Vector3(x0, yC, z0), new THREE.Vector3(x0 + arm, yC, z0));
      // Top-right
      cornerPts.push(new THREE.Vector3(x1 - arm, yC, z0), new THREE.Vector3(x1, yC, z0));
      cornerPts.push(new THREE.Vector3(x1, yC, z0), new THREE.Vector3(x1, yC, z0 + arm));
      // Bottom-right
      cornerPts.push(new THREE.Vector3(x1, yC, z1 - arm), new THREE.Vector3(x1, yC, z1));
      cornerPts.push(new THREE.Vector3(x1, yC, z1), new THREE.Vector3(x1 - arm, yC, z1));
      // Bottom-left
      cornerPts.push(new THREE.Vector3(x0 + arm, yC, z1), new THREE.Vector3(x0, yC, z1));
      cornerPts.push(new THREE.Vector3(x0, yC, z1), new THREE.Vector3(x0, yC, z1 - arm));
    }

    if (cornerPts.length > 0) {
      const corners = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(cornerPts), cornerMat);
      corners.renderOrder = 6;
      this.buildZoneGroup.add(corners);
    } else {
      cornerMat.dispose();
    }
    fillMat.dispose();
    lineMat.dispose();
  }

  // ---------- Ore Field ----------

  private buildOre() {
    // Rich mineral crystal clusters anchored into a rocky base
    const shards: THREE.BufferGeometry[] = [];
    const mk = (x: number, z: number, s: number, h: number, rot: number, tilt: number) => {
      const g = new THREE.OctahedronGeometry(s, 0);
      g.scale(1, h, 1);
      g.rotateY(rot);
      g.rotateZ(tilt);
      g.translate(x, s * h * 0.42, z);
      shards.push(g);
    };
    mk(0, 0.02, 0.18, 1.9, 0.4, 0.08);
    mk(-0.18, 0.1, 0.14, 1.35, 1.9, -0.18);
    mk(0.17, 0.12, 0.12, 1.15, 3.6, 0.22);
    mk(0.05, -0.16, 0.11, 0.95, 5.1, -0.12);
    mk(-0.11, -0.13, 0.09, 0.8, 2.7, 0.16);
    const geo = mergeGeometries(shards)!;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xb87c18,
      emissive: 0xff9f1a,
      emissiveIntensity: 0.72,
      roughness: 0.26,
      metalness: 0.35,
    });
    const ore = new THREE.InstancedMesh(geo, mat, GameScene.ORE_MAX);
    ore.count = 0;
    ore.castShadow = false;
    ore.frustumCulled = false;
    this.ore = ore;
    this.scene.add(ore);
  }

  clearOre() {
    this.oreSlots.clear();
    this.oreFree = [];
    this.orePeak = 0;
    this.ore.count = 0;
    this.ore.instanceMatrix.needsUpdate = true;
  }

  setOreCells(cells: [number, number, number][]) {
    for (const [x, y, amt] of cells) {
      const key = y * MAP_W + x;
      let slot = this.oreSlots.get(key);
      if (amt <= 0) {
        if (slot !== undefined) {
          this.dummy.position.set(x + 0.5, -10, y + 0.5);
          this.dummy.scale.setScalar(0.001);
          this.dummy.updateMatrix();
          this.ore.setMatrixAt(slot, this.dummy.matrix);
          this.oreSlots.delete(key);
          this.oreFree.push(slot);
        }
        continue;
      }
      if (slot === undefined) {
        slot = this.oreFree.length ? this.oreFree.pop()! : this.orePeak++;
        if (slot >= GameScene.ORE_MAX) continue;
        this.oreSlots.set(key, slot);
      }
      const s = 0.45 + Math.min(1, amt / 60) * 0.55;
      this.dummy.position.set(x + 0.5, 0.02, y + 0.5);
      this.dummy.rotation.set(0, ((key * 2654435761) % 628) / 100, 0);
      this.dummy.scale.set(s, s * (0.8 + Math.min(1, amt / 60) * 0.4), s);
      this.dummy.updateMatrix();
      this.ore.setMatrixAt(slot, this.dummy.matrix);
    }
    this.ore.count = this.orePeak;
    this.ore.instanceMatrix.needsUpdate = true;
  }

  // ---------- picking ----------

  private ndc() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    return {
      x: (this.pointerX / w) * 2 - 1,
      y: -(this.pointerY / h) * 2 + 1,
    };
  }

  // screen -> ground plane point (returns THREE.Vector3: x=map x, z=map y)
  pickGround(): THREE.Vector3 | null {
    const p = this.ndc();
    this.raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, out) ? out : null;
  }

  // screen -> visible entity pick (ignores fog-hidden roots, health bars, and selection rings)
  pickEntity(): number | null {
    const p = this.ndc();
    this.raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), this.camera);
    const visibleRoots = this.pickables.filter((r) => r.visible);
    const hits = this.raycaster.intersectObjects(visibleRoots, true);
    for (const h of hits) {
      if (h.object.userData?.isBar) continue;
      let o: THREE.Object3D | null = h.object;
      let hidden = false;
      let foundId: number | undefined;
      while (o) {
        if (!o.visible || o.userData?.isBar) {
          hidden = true;
          break;
        }
        if (foundId === undefined && o.userData?.entityId !== undefined) {
          foundId = o.userData.entityId as number;
        }
        o = o.parent;
      }
      if (!hidden && foundId !== undefined) return foundId;
    }
    return null;
  }

  // ---------- camera / shake / loop ----------

  shake(intensity: number): void {
    this.shakeAmp = Math.min(2.4, Math.max(this.shakeAmp, intensity));
  }

  // Standard North-Up isometric RTS camera (camYaw === 0: -Z is UP/North, +X is RIGHT/East),
  // supporting smooth orbital yaw rotation around camTarget.
  updateCamera() {
    const h = this.camHeight;
    const dist = h * 0.68;
    const offX = this.camYaw === 0 ? 0 : Math.sin(this.camYaw) * dist;
    const offZ = this.camYaw === 0 ? dist : Math.cos(this.camYaw) * dist;
    this.camera.position.set(
      this.camTarget.x + offX + this.shakeOffset.x,
      h + this.shakeOffset.y,
      this.camTarget.z + offZ + this.shakeOffset.z,
    );
    this.lookVec.set(
      this.camTarget.x + this.shakeOffset.x * 0.35,
      this.camTarget.y,
      this.camTarget.z + this.shakeOffset.z * 0.35,
    );
    this.camera.lookAt(this.lookVec);
  }

  rotateYaw(deltaRad: number): void {
    let next = this.camYaw + deltaRad;
    next = ((((next + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
    if (next <= -Math.PI) next += Math.PI * 2;
    this.camYaw = next;
    this.updateCamera();
  }

  resetYaw(): void {
    this.camYaw = 0;
    this.updateCamera();
  }

  pan(dx: number, dz: number) {
    const s = this.camHeight / 26;
    let wx = dx;
    let wz = dz;
    if (this.camYaw !== 0) {
      const cosY = Math.cos(this.camYaw);
      const sinY = Math.sin(this.camYaw);
      // Screen-right (+dx) = (cosY, -sinY), Screen-down (+dz) = (sinY, cosY)
      wx = dx * cosY + dz * sinY;
      wz = -dx * sinY + dz * cosY;
    }
    this.camTarget.x = Math.max(-2, Math.min(MAP_W + 2, this.camTarget.x + wx * s));
    this.camTarget.z = Math.max(-2, Math.min(MAP_H + 2, this.camTarget.z + wz * s));
    this.updateCamera();
  }

  zoom(delta: number) {
    this.camHeight = Math.max(11, Math.min(48, this.camHeight + delta));
    this.updateCamera();
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer.setSize(w, h);
  }

  setLoop(cb: () => void) {
    let last = performance.now();
    const tick = (now: number) => {
      this.dtMs = Math.min(100, Math.max(1, now - last));
      last = now;
      cb();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  render() {
    if (this.shakeAmp > 0.004) {
      const dt = Math.min(0.05, this.dtMs / 1000);
      this.shakePhase += dt * 48;
      this.shakeAmp *= Math.exp(-dt * 6.2);
      this.shakeOffset.set(
        Math.sin(this.shakePhase * 1.13) * this.shakeAmp,
        Math.cos(this.shakePhase * 1.67) * this.shakeAmp * 0.42,
        Math.sin(this.shakePhase * 1.37 + 1.4) * this.shakeAmp * 0.85,
      );
      this.updateCamera();
    } else if (this.shakeAmp > 0) {
      this.shakeAmp = 0;
      this.shakeOffset.set(0, 0, 0);
      this.updateCamera();
    }
    this.composer.render();
  }
}
