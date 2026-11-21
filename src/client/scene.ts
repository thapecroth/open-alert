import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { MAP_W, MAP_H } from "../shared/gamedefs";

// Small facade so callers used to the old engine API keep working:
//   gs.engine.getRenderingCanvas()/getRenderWidth()/getDeltaTime()/runRenderLoop()/resize()
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
  resize() {}
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
    this.renderer.toneMappingExposure = 1.28;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x04060a);
    this.scene.fog = new THREE.FogExp2(0x04060a, 0.005);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 700);
    this.updateCamera();

    // lights — cool hemisphere ambient + warm key with shadows
    const hemi = new THREE.HemisphereLight(0x93aecf, 0x1a1815, 1.15);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffe2b8, 1.9);
    dir.position.set(42, 58, 26);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -46;
    dir.shadow.camera.right = MAP_W + 46;
    dir.shadow.camera.top = MAP_H + 46;
    dir.shadow.camera.bottom = -46;
    dir.shadow.camera.near = 8;
    dir.shadow.camera.far = 190;
    dir.shadow.bias = -0.0004;
    dir.shadow.normalBias = 0.03;
    this.scene.add(dir);
    // faint cyan rim light from behind for silhouette separation
    const rim = new THREE.DirectionalLight(0x3fb8e8, 0.35);
    rim.position.set(-30, 24, -40);
    this.scene.add(rim);

    // HDRI environment for PBR reflections (night sky — subtle sheen)
    new RGBELoader().load("/tex/satara_night_1k.hdr", (hdr) => {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const env = pmrem.fromEquirectangular(hdr).texture;
      this.scene.environment = env;
      this.scene.environmentIntensity = 0.55;
      hdr.dispose();
      pmrem.dispose();
      this.envReady = true;
    });

    // bloom — emissive accents and FX glow
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1024, 1024), 0.55, 0.65, 0.8);
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());

    // pointer tracking for picking (canvas-relative CSS pixels)
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.pointerX = e.clientX - r.left;
      this.pointerY = e.clientY - r.top;
    });

    this.buildSky();
    this.buildGround();
    this.buildVoidRing();
    this.buildOre();
    this.resize();
  }

  // ---------- environment pieces ----------

  private buildSky() {
    const geo = new THREE.SphereGeometry(420, 24, 16);
    const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, fog: false, depthWrite: false });
    new THREE.TextureLoader().load("/tex/sky.png", (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t;
      mat.needsUpdate = true;
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.renderOrder = -10;
    this.scene.add(sky);
  }

  private buildGround() {
    const geo = new THREE.PlaneGeometry(MAP_W, MAP_H);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x9fb2a8, roughness: 1.0, metalness: 0.0 });
    const tl = new THREE.TextureLoader();
    const rep = (t: THREE.Texture, srgb = false) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(5, 5);
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    };
    tl.load("/tex/coast_sand_rocks_02_diff_2k.jpg", (t) => {
      mat.map = rep(t, true);
      mat.needsUpdate = true;
    });
    tl.load("/tex/coast_sand_rocks_02_nor_gl_2k.jpg", (t) => {
      mat.normalMap = rep(t);
      mat.normalScale.set(0.7, 0.7);
      mat.needsUpdate = true;
    });
    tl.load("/tex/coast_sand_rocks_02_arm_2k.jpg", (t) => {
      // arm texture: AO=R, roughness=G, metalness=B (glTF packing)
      mat.aoMap = rep(t);
      mat.roughnessMap = rep(t);
      mat.needsUpdate = true;
    });
    const g = new THREE.Mesh(geo, mat);
    g.position.set(MAP_W / 2, 0, MAP_H / 2);
    g.receiveShadow = true;
    this.ground = g;
    this.scene.add(g);

    // faint command-grid overlay
    const grid = new THREE.GridHelper(MAP_W, MAP_W, 0x46c8e8, 0x2a7d99);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.055;
    grid.position.set(MAP_W / 2, 0.02, MAP_H / 2);
    this.scene.add(grid);
  }

  private buildVoidRing() {
    // dark collar so the map edge reads as a floating platform over the void
    const voidGeo = new THREE.PlaneGeometry(MAP_W * 4, MAP_H * 4);
    voidGeo.rotateX(-Math.PI / 2);
    const voidMat = new THREE.MeshBasicMaterial({ color: 0x030507, fog: false });
    const ring = new THREE.Mesh(voidGeo, voidMat);
    ring.position.set(MAP_W / 2, -0.32, MAP_H / 2);
    this.scene.add(ring);
    // glowing rim under the battlefield edge
    const rimGeo = new THREE.PlaneGeometry(MAP_W + 0.9, MAP_H + 0.9);
    rimGeo.rotateX(-Math.PI / 2);
    const rimMat = new THREE.MeshBasicMaterial({ color: 0x0a2a38, fog: false });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.set(MAP_W / 2, -0.03, MAP_H / 2);
    this.scene.add(rim);
  }

  private buildOre() {
    // a small crystal cluster per cell reads as an ore deposit, not a floating gem
    const shards: THREE.BufferGeometry[] = [];
    const mk = (x: number, z: number, s: number, h: number, rot: number) => {
      const g = new THREE.OctahedronGeometry(s, 0);
      g.scale(1, h, 1);
      g.rotateY(rot);
      g.rotateZ((x * 7) % 0.3 - 0.15);
      g.translate(x, 0, z);
      shards.push(g);
    };
    mk(0, 0.02, 0.2, 1.9, 0.4);
    mk(-0.19, 0.1, 0.15, 1.3, 1.9);
    mk(0.17, 0.14, 0.12, 1.05, 3.6);
    mk(0.06, -0.16, 0.1, 0.85, 5.1);
    const geo = mergeGeometries(shards)!;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x8a5a14,
      emissive: 0xff9d1e,
      emissiveIntensity: 0.95,
      roughness: 0.3,
      metalness: 0.15,
    });
    const ore = new THREE.InstancedMesh(geo, mat, GameScene.ORE_MAX);
    ore.count = 0;
    ore.castShadow = false;
    ore.frustumCulled = false;
    this.ore = ore;
    this.scene.add(ore);
  }

  setOreCells(cells: [number, number, number][]) {
    for (const [x, y, amt] of cells) {
      const key = y * MAP_W + x;
      let slot = this.oreSlots.get(key);
      if (amt <= 0) {
        if (slot !== undefined) {
          // hide by scaling to zero, free the slot
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
      this.dummy.position.set(x + 0.5, 0.16, y + 0.5);
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
    return {
      x: (this.pointerX / this.canvas.clientWidth) * 2 - 1,
      y: -(this.pointerY / this.canvas.clientHeight) * 2 + 1,
    };
  }

  // screen -> ground plane point (returns THREE.Vector3: x=map x, z=map y)
  pickGround(): THREE.Vector3 | null {
    const p = this.ndc();
    this.raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, out) ? out : null;
  }

  // screen -> entity pick (children carry userData.entityId up the chain)
  pickEntity(): number | null {
    const p = this.ndc();
    this.raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        const id = o.userData?.entityId as number | undefined;
        if (id !== undefined) return id;
        o = o.parent;
      }
    }
    return null;
  }

  // ---------- camera / loop ----------

  updateCamera() {
    const h = this.camHeight;
    this.camera.position.set(this.camTarget.x, h, this.camTarget.z - h * 0.62);
    this.camera.lookAt(this.camTarget);
  }

  pan(dx: number, dz: number) {
    const s = this.camHeight / 26;
    this.camTarget.x = Math.max(-2, Math.min(MAP_W + 2, this.camTarget.x + dx * s));
    this.camTarget.z = Math.max(-2, Math.min(MAP_H + 2, this.camTarget.z + dz * s));
    this.updateCamera();
  }

  zoom(delta: number) {
    this.camHeight = Math.max(12, Math.min(48, this.camHeight + delta));
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
      this.dtMs = now - last;
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
