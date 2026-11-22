import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { MAP_W, MAP_H } from "../shared/gamedefs";
import { createBattlefieldTextures } from "./textures";

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

export class GameScene {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  engine: EngineShim;
  camTarget = new THREE.Vector3(MAP_W / 2, 0, MAP_H / 2);
  camHeight = 26;
  ground!: THREE.Mesh;
  raycaster = new THREE.Raycaster();
  pickables: THREE.Object3D[] = []; // entity roots — raycast for pickEntity
  pointerX = 0;
  pointerY = 0;
  pointerInside = false;
  dtMs = 16;
  envReady = false;

  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ore!: THREE.InstancedMesh;
  private oreSlots = new Map<number, number>(); // cellKey -> instance index
  private oreFree: number[] = [];
  private orePeak = 0;
  private static ORE_MAX = 4096;
  private dummy = new THREE.Object3D();

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
    this.buildProps();
    this.buildOre();
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
    const { map, bumpMap } = createBattlefieldTextures();
    const mat = new THREE.MeshStandardMaterial({
      map,
      bumpMap,
      bumpScale: 0.14,
      roughness: 0.92,
      metalness: 0.04,
    });
    const g = new THREE.Mesh(geo, mat);
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
    const skirtMat = new THREE.MeshStandardMaterial({
      color: 0x1e2524,
      roughness: 0.96,
      metalness: 0.02,
    });
    const skirt = new THREE.Mesh(skirtGeo, skirtMat);
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

  private buildProps() {
    // Clean perimeter border fades naturally into atmospheric fog without distracting blobs
  }

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

  // ---------- camera / loop ----------

  // Standard North-Up isometric RTS camera: -Z is UP (North), +X is RIGHT (East),
  // matching the minimap (0,0 top-left -> 64,64 bottom-right).
  updateCamera() {
    const h = this.camHeight;
    this.camera.position.set(this.camTarget.x, h, this.camTarget.z + h * 0.68);
    this.camera.lookAt(this.camTarget);
  }

  pan(dx: number, dz: number) {
    const s = this.camHeight / 26;
    this.camTarget.x = Math.max(-2, Math.min(MAP_W + 2, this.camTarget.x + dx * s));
    this.camTarget.z = Math.max(-2, Math.min(MAP_H + 2, this.camTarget.z + dz * s));
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
    this.composer.render();
  }
}
