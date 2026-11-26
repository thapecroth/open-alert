import * as THREE from "three";
import type { MapId } from "../shared/gamedefs";
import {
  generateArmorDetail,
  generateBattlefieldTextures,
  generateConcrete,
  generateGroundMicroDetail,
  generateRockDetail,
  generateTread,
  generateWaterNormal,
  mulberry32,
  type CanvasFactory,
  type TextureCanvas,
} from "./texture-core";
import { isTextureJobCancelled, requestBattlefieldTextureJob, requestStaticTextureJob } from "./texture-worker-client";
import type { TextureJobTextureMap, TexturePixels } from "./texture-protocol";

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

const mainCanvasFactory: CanvasFactory = (w, h) => makeCanvas(w, h);

const NEUTRAL_NORMAL_FILL = "rgb(128, 128, 255)";

function makePlaceholderTexture(w: number, h: number, fill: string): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(w, h);
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  return new THREE.CanvasTexture(c);
}

function paintCanvasFromPixels(canvas: TextureCanvas, payload: TexturePixels): void {
  if (canvas.width !== payload.width || canvas.height !== payload.height) {
    throw new Error(
      `Texture payload dimension mismatch: canvas ${canvas.width}x${canvas.height}, payload ${payload.width}x${payload.height}`,
    );
  }
  const ctx = canvas.getContext("2d")!;
  // Wrap the transferred backing store directly instead of copying it into a
  // fresh createImageData allocation first; putImageData remains the canvas-write
  // boundary that preserves the original top-left-origin pixel ordering.
  const img = new ImageData(new Uint8ClampedArray(payload.pixels), payload.width, payload.height);
  ctx.putImageData(img, 0, 0);
}

function paintTextureFromPixels(texture: THREE.CanvasTexture, payload: TexturePixels): void {
  paintCanvasFromPixels(texture.image as unknown as TextureCanvas, payload);
  texture.needsUpdate = true;
}

function adoptTextureCanvas(texture: THREE.CanvasTexture, canvas: TextureCanvas): void {
  texture.image = canvas as unknown as HTMLCanvasElement;
  texture.needsUpdate = true;
}

function copyCanvasContents(src: TextureCanvas, dest: TextureCanvas): void {
  if (src.width !== dest.width || src.height !== dest.height) {
    throw new Error(`Canvas copy dimension mismatch: ${src.width}x${src.height} -> ${dest.width}x${dest.height}`);
  }
  const sctx = src.getContext("2d")!;
  const dctx = dest.getContext("2d")!;
  dctx.putImageData(sctx.getImageData(0, 0, src.width, src.height), 0, 0);
}

function runStaticTextureJob(
  kind: Parameters<typeof requestStaticTextureJob>[0],
  apply: (textures: TextureJobTextureMap) => void,
  fallback: () => void,
): Promise<void> {
  const job = requestStaticTextureJob(kind);
  if (!job) {
    fallback();
    return Promise.resolve();
  }
  return job
    .then((result) => apply(result.textures))
    .catch(() => fallback());
}

// ---------- Shared 512x512 Next-Gen PBR Armor Detail Maps ----------

let armorNormalTex: THREE.CanvasTexture | null = null;
let armorRoughTex: THREE.CanvasTexture | null = null;
let armorDetailTex: THREE.CanvasTexture | null = null;
let concreteDiffTex: THREE.CanvasTexture | null = null;
let concreteNormalTex: THREE.CanvasTexture | null = null;
let concreteRoughTex: THREE.CanvasTexture | null = null;
let treadTex: THREE.CanvasTexture | null = null;
let treadNormalTex: THREE.CanvasTexture | null = null;
let armorDetailReady: Promise<void> = Promise.resolve();
let concreteDetailReady: Promise<void> = Promise.resolve();
let treadDetailReady: Promise<void> = Promise.resolve();

function ensureArmorDetail() {
  if (armorNormalTex && armorRoughTex && armorDetailTex) return;
  const S = 512;
  armorNormalTex = makePlaceholderTexture(S, S, NEUTRAL_NORMAL_FILL);
  armorNormalTex.wrapS = armorNormalTex.wrapT = THREE.RepeatWrapping;
  armorNormalTex.anisotropy = 4;

  armorRoughTex = makePlaceholderTexture(S, S, "#dedede");
  armorRoughTex.wrapS = armorRoughTex.wrapT = THREE.RepeatWrapping;
  armorRoughTex.anisotropy = 4;

  armorDetailTex = makePlaceholderTexture(S, S, "#f4f4f4");
  armorDetailTex.colorSpace = THREE.SRGBColorSpace;
  armorDetailTex.wrapS = armorDetailTex.wrapT = THREE.RepeatWrapping;
  armorDetailTex.anisotropy = 4;

  armorDetailReady = runStaticTextureJob(
    "armor",
    (textures) => {
      paintTextureFromPixels(armorNormalTex!, textures.normalMap);
      paintTextureFromPixels(armorRoughTex!, textures.roughMap);
      paintTextureFromPixels(armorDetailTex!, textures.detailMap);
    },
    () => {
      const g = generateArmorDetail(mainCanvasFactory);
      adoptTextureCanvas(armorNormalTex!, g.normalMap);
      adoptTextureCanvas(armorRoughTex!, g.roughMap);
      adoptTextureCanvas(armorDetailTex!, g.detailMap);
    },
  );
}

function ensureConcrete() {
  if (concreteDiffTex && concreteNormalTex && concreteRoughTex) return;
  const S = 512;
  concreteDiffTex = makePlaceholderTexture(S, S, "#52595f");
  concreteDiffTex.colorSpace = THREE.SRGBColorSpace;
  concreteDiffTex.anisotropy = 4;

  concreteNormalTex = makePlaceholderTexture(S, S, NEUTRAL_NORMAL_FILL);
  concreteNormalTex.anisotropy = 4;

  concreteRoughTex = makePlaceholderTexture(S, S, "#d8d8d8");
  concreteRoughTex.anisotropy = 4;

  concreteDetailReady = runStaticTextureJob(
    "concrete",
    (textures) => {
      paintTextureFromPixels(concreteDiffTex!, textures.diffuseMap);
      paintTextureFromPixels(concreteNormalTex!, textures.normalMap);
      paintTextureFromPixels(concreteRoughTex!, textures.roughMap);
    },
    () => {
      const g = generateConcrete(mainCanvasFactory);
      adoptTextureCanvas(concreteDiffTex!, g.diffuseMap);
      adoptTextureCanvas(concreteNormalTex!, g.normalMap);
      adoptTextureCanvas(concreteRoughTex!, g.roughMap);
    },
  );
}

export function getTreadTexture(): THREE.CanvasTexture {
  if (treadTex) return treadTex;
  treadTex = makePlaceholderTexture(128, 256, "#181c20");
  treadTex.colorSpace = THREE.SRGBColorSpace;
  treadTex.wrapS = treadTex.wrapT = THREE.RepeatWrapping;
  treadTex.repeat.set(1, 3);
  treadTex.anisotropy = 4;

  treadNormalTex = makePlaceholderTexture(128, 256, NEUTRAL_NORMAL_FILL);
  treadNormalTex.wrapS = treadNormalTex.wrapT = THREE.RepeatWrapping;
  treadNormalTex.repeat.set(1, 3);

  treadDetailReady = runStaticTextureJob(
    "tread",
    (textures) => {
      paintTextureFromPixels(treadTex!, textures.map);
      paintTextureFromPixels(treadNormalTex!, textures.normalMap);
    },
    () => {
      const g = generateTread(mainCanvasFactory);
      adoptTextureCanvas(treadTex!, g.map);
      adoptTextureCanvas(treadNormalTex!, g.normalMap);
    },
  );
  return treadTex;
}

// Icons are rendered snapshots rather than live materials, so they must wait for
// the worker-produced armor/concrete/tread pixels instead of capturing the neutral
// placeholder canvases used to keep model construction non-blocking.
export function whenModelTexturesReady(): Promise<void> {
  ensureArmorDetail();
  ensureConcrete();
  getTreadTexture();
  return Promise.all([armorDetailReady, concreteDetailReady, treadDetailReady]).then(() => undefined);
}

// ---------- Next-Gen 2026 PBR Material Caches ----------

// Materials minted by the armor/chassis/accent/glass factories share one texture
// set and differ only in uniform-valued shading parameters. Tagging them lets
// the static-body merger collapse dozens of per-part materials into a single
// vertex-attribute-driven unified material with zero visual change.
function tagUnifiedArmor(m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  m.userData.unifiedArmor = true;
  return m;
}

const chassisMatCache = new Map<string, THREE.MeshStandardMaterial>();
export function getChassisMat(hex = "#3d4752", roughness = 0.44, metalness = 0.62): THREE.MeshStandardMaterial {
  ensureArmorDetail();
  const key = `${hex}|${roughness}|${metalness}`;
  let m = chassisMatCache.get(key);
  if (!m) {
    m = tagUnifiedArmor(new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex),
      map: armorDetailTex!,
      normalMap: armorNormalTex!,
      normalScale: new THREE.Vector2(0.88, 0.88),
      roughnessMap: armorRoughTex!,
      roughness,
      metalness,
      envMapIntensity: 1.12,
    }));
    chassisMatCache.set(key, m);
  }
  return m;
}

const accentMatCache = new Map<string, THREE.MeshStandardMaterial>();
export function getAccentMat(hex: string): THREE.MeshStandardMaterial {
  ensureArmorDetail();
  let m = accentMatCache.get(hex);
  if (!m) {
    const c = new THREE.Color(hex);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    // Deepen & refine faction hue by ~14% toward rich tactical military composite paint
    hsl.s = Math.max(0, Math.min(1, hsl.s * 0.86));
    hsl.l = hsl.l > 0.4 ? hsl.l * 0.91 : hsl.l * 0.96;
    c.setHSL(hsl.h, hsl.s, hsl.l);

    m = tagUnifiedArmor(new THREE.MeshStandardMaterial({
      color: c,
      map: armorDetailTex!,
      normalMap: armorNormalTex!,
      normalScale: new THREE.Vector2(0.76, 0.76),
      roughnessMap: armorRoughTex!,
      metalness: 0.38,
      roughness: 0.42,
      envMapIntensity: 1.05,
    }));
    accentMatCache.set(hex, m);
  }
  return m;
}

const glassMatCache = new Map<string, THREE.MeshStandardMaterial>();
export function getGlassMat(tint = "#66d4ff"): THREE.MeshStandardMaterial {
  let m = glassMatCache.get(tint);
  if (!m) {
    const c = new THREE.Color(tint);
    m = tagUnifiedArmor(new THREE.MeshStandardMaterial({
      color: c,
      roughness: 0.1,
      metalness: 0.85,
      emissive: c.clone().multiplyScalar(0.28),
      envMapIntensity: 1.45,
    }));
    glassMatCache.set(tint, m);
  }
  return m;
}

// ---------- Unified Vertex-Attribute Armor Material ----------
//
// Every tagged factory material shares the armor detail/normal/roughness
// texture set and differs only in scalar uniforms (color, roughness, metalness,
// normalScale, envMapIntensity, emissive). This singleton reproduces all of them
// exactly with per-vertex attributes, letting the static-body merger collapse
// what used to be 5-15 separate material draw calls per articulated anchor into
// ONE. Baked per-vertex layout:
//   color      (vec3, native)  — base diffuse color (white on faction-accent verts
//                                of instancing donors; the instance tint supplies it)
//   aShading   (vec4)          — roughness, metalness, normalScale, envMapIntensity
//   aEmissive  (vec3)          — emissive × emissiveIntensity (pre-multiplied)
//   aTexMix    (float)         — 1 = full armor texture set, 0 = untextured (glass)
//   aAccent    (float)         — 0 none, 1/2/3 faction accent variant (instanced only)
// Per-instance inputs on instanced pools: instanceColor stays the hit-flash
// channel (white normally, flash tint while flashing — exactly as before) and
// aAccV0/1/2 carry the final per-variant faction accent colors.
let unifiedArmorMat: THREE.MeshStandardMaterial | null = null;
export function getUnifiedArmorMat(): THREE.MeshStandardMaterial {
  if (unifiedArmorMat) return unifiedArmorMat;
  ensureArmorDetail();
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    map: armorDetailTex!,
    normalMap: armorNormalTex!,
    normalScale: new THREE.Vector2(1, 1),
    roughnessMap: armorRoughTex!,
    roughness: 1,
    metalness: 1,
    emissive: 0xffffff,
    emissiveIntensity: 1,
    envMapIntensity: 1,
  });
  m.userData.unifiedArmorSingleton = true;
  m.customProgramCacheKey = () => "unified-armor-v2";
  m.onBeforeCompile = (shader) => {
    // CRITICAL three.js pipeline fact: onBeforeCompile receives the shader with
    // `#include` statements UNRESOLVED (resolution happens later inside
    // WebGLProgram). Replacements targeting text inside a chunk silently no-op.
    // So every chunk patch below first resolves the include line against
    // THREE.ShaderChunk — guaranteeing an exact match with the pinned three
    // version — and rewrites the chunk content itself.
    const patchChunk = (
      src: string,
      includeName: keyof typeof THREE.ShaderChunk,
      patch: (chunk: string) => string,
    ): string => {
      const chunk = (THREE.ShaderChunk as Record<string, string>)[includeName as string];
      if (!chunk) return src;
      return src.replace(`#include <${includeName as string}>`, patch(chunk));
    };

    // ---- vertex: fetch per-vertex shading, resolve faction accent tint ----
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec4 aShading;
attribute vec3 aEmissive;
attribute float aTexMix;
attribute float aAccent;
#ifdef USE_INSTANCING
attribute vec3 aAccV0;
attribute vec3 aAccV1;
attribute vec3 aAccV2;
#endif
varying vec4 vAShading;
varying vec3 vAEmissive;
varying float vATexMix;
varying vec3 vATint;`,
      )
      .replace(
        "#include <color_vertex>",
        `#include <color_vertex>
vAShading = aShading;
vAEmissive = aEmissive;
vATexMix = aTexMix;
vATint = vec3( 1.0 );
#ifdef USE_INSTANCING
if ( aAccent > 0.5 ) {
  vATint = aAccent < 1.5 ? aAccV0 : aAccent < 2.5 ? aAccV1 : aAccV2;
}
#endif`,
      );

    // ---- fragment: apply per-vertex shading at the exact uniform use sites ----
    let frag = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
varying vec4 vAShading;
varying vec3 vAEmissive;
varying float vATexMix;
varying vec3 vATint;`,
    );
    // envMapIntensity is consumed inside the IBL helpers; scale per-vertex.
    frag = patchChunk(frag, "envmap_physical_pars_fragment", (chunk) =>
      chunk.replace(
        /envMapColor\.rgb \* envMapIntensity/g,
        "envMapColor.rgb * envMapIntensity * vAShading.w",
      ),
    );
    // Diffuse texture: untextured (glass) verts must not sample the armor detail.
    frag = patchChunk(frag, "map_fragment", (chunk) =>
      chunk.replace(
        "diffuseColor *= sampledDiffuseColor;",
        "diffuseColor *= mix( vec4( 1.0 ), sampledDiffuseColor, vATexMix );",
      ),
    );
    // Roughness: per-vertex scalar × conditional texel (exactly the factory materials).
    frag = patchChunk(frag, "roughnessmap_fragment", (chunk) =>
      chunk
        .replace(
          "float roughnessFactor = roughness;",
          "float roughnessFactor = roughness * vAShading.x;",
        )
        .replace(
          "roughnessFactor *= texelRoughness.g;",
          "roughnessFactor *= mix( 1.0, texelRoughness.g, vATexMix );",
        ),
    );
    // Metalness: no metalnessMap exists in the armor family — per-vertex scalar only.
    frag = patchChunk(frag, "metalnessmap_fragment", (chunk) =>
      chunk.replace(
        "float metalnessFactor = metalness;",
        "float metalnessFactor = metalness * vAShading.y;",
      ),
    );
    // Normal map: per-vertex scale; untextured verts blend to the exact neutral
    // normal (0,0,1), reproducing the no-normalMap glass materials through the TBN.
    frag = patchChunk(frag, "normal_fragment_maps", (chunk) =>
      chunk.replace(
        "mapN.xy *= normalScale;",
        `mapN.xy *= normalScale * vAShading.z;
	mapN = mix( vec3( 0.0, 0.0, 1.0 ), mapN, vATexMix );`,
      ),
    );
    shader.fragmentShader = frag
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
diffuseColor.rgb *= vATint;`,
      )
      // emissive premultiply: the uniform stays white×1, per-vertex carries the
      // original emissive×intensity — this line IS in the meshphysical main body.
      .replace(
        "vec3 totalEmissiveRadiance = emissive;",
        "vec3 totalEmissiveRadiance = emissive * vAEmissive;",
      );
  };
  unifiedArmorMat = m;
  return m;
}

let contactShadowTexCache: THREE.CanvasTexture | null = null;
export function getContactShadowTex(): THREE.CanvasTexture {
  if (contactShadowTexCache) return contactShadowTexCache;
  const S = 128;
  const [c, ctx] = makeCanvas(S, S);
  const cx = S / 2;
  const cy = S / 2;
  ctx.clearRect(0, 0, S, S);

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.5);
  grad.addColorStop(0.0, "rgba(4, 8, 12, 0.58)");
  grad.addColorStop(0.36, "rgba(4, 8, 12, 0.44)");
  grad.addColorStop(0.66, "rgba(4, 8, 12, 0.2)");
  grad.addColorStop(0.86, "rgba(4, 8, 12, 0.05)");
  grad.addColorStop(1.0, "rgba(4, 8, 12, 0)");

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);

  contactShadowTexCache = new THREE.CanvasTexture(c);
  contactShadowTexCache.colorSpace = THREE.SRGBColorSpace;
  return contactShadowTexCache;
}

// ---------- Legacy-Compatible Shared Material Caches (Upgraded to Tangent-Space Normals) ----------

const armorMatCache = new Map<string, THREE.MeshStandardMaterial>();
export function getArmorMat(hex: string, metalness = 0.45, roughness = 0.56, emissive = 0): THREE.MeshStandardMaterial {
  ensureArmorDetail();
  const key = `${hex}|${metalness}|${roughness}|${emissive}`;
  let m = armorMatCache.get(key);
  if (!m) {
    const c = new THREE.Color(hex);
    m = new THREE.MeshStandardMaterial({
      color: c,
      map: armorDetailTex!,
      metalness,
      roughness,
      normalMap: armorNormalTex!,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughnessMap: armorRoughTex!,
      emissive: emissive > 0 ? c.clone().multiplyScalar(emissive) : new THREE.Color(0x000000),
      envMapIntensity: 1.05,
    });
    armorMatCache.set(key, m);
  }
  return m;
}

let concreteMatCache: THREE.MeshStandardMaterial | null = null;
export function getConcreteMat(): THREE.MeshStandardMaterial {
  ensureConcrete();
  if (!concreteMatCache) {
    concreteMatCache = new THREE.MeshStandardMaterial({
      map: concreteDiffTex!,
      normalMap: concreteNormalTex!,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: concreteRoughTex!,
      roughness: 0.88,
      metalness: 0.08,
      envMapIntensity: 0.65,
    });
  }
  return concreteMatCache;
}

let treadMatCache: THREE.MeshStandardMaterial | null = null;
export function getTreadMat(): THREE.MeshStandardMaterial {
  if (!treadMatCache) {
    const map = getTreadTexture();
    treadMatCache = new THREE.MeshStandardMaterial({
      map,
      normalMap: treadNormalTex!,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.82,
      metalness: 0.28,
    });
  }
  return treadMatCache;
}

const glowMatCache = new Map<string, THREE.MeshBasicMaterial>();
export function getGlowMat(hex: string, intensity = 1.25): THREE.MeshBasicMaterial {
  const key = `${hex}|${intensity}`;
  let m = glowMatCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: hex });
    m.color.multiplyScalar(intensity);
    glowMatCache.set(key, m);
  }
  return m;
}

// ---------- Stratified Rock & Scorch Crater Textures ----------

let rockNormalTex: THREE.CanvasTexture | null = null;
let rockRoughTex: THREE.CanvasTexture | null = null;

function ensureRockDetail() {
  if (rockNormalTex && rockRoughTex) return;
  const S = 256;
  rockNormalTex = makePlaceholderTexture(S, S, NEUTRAL_NORMAL_FILL);
  rockNormalTex.wrapS = rockNormalTex.wrapT = THREE.RepeatWrapping;
  rockNormalTex.repeat.set(2, 2);
  rockNormalTex.anisotropy = 4;

  rockRoughTex = makePlaceholderTexture(S, S, "rgb(202, 202, 202)");
  rockRoughTex.wrapS = rockRoughTex.wrapT = THREE.RepeatWrapping;
  rockRoughTex.repeat.set(2, 2);

  runStaticTextureJob(
    "rock",
    (textures) => {
      paintTextureFromPixels(rockNormalTex!, textures.normalMap);
      paintTextureFromPixels(rockRoughTex!, textures.roughMap);
    },
    () => {
      const g = generateRockDetail(mainCanvasFactory);
      adoptTextureCanvas(rockNormalTex!, g.normalMap);
      adoptTextureCanvas(rockRoughTex!, g.roughMap);
    },
  );
}

export interface CliffBiomeMats {
  wall: THREE.MeshStandardMaterial;
  cap: THREE.MeshStandardMaterial;
  boulder: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  trunk: THREE.MeshStandardMaterial;
  accent?: THREE.MeshStandardMaterial;
  water?: THREE.MeshStandardMaterial;
}

const cliffMatsCache = new Map<MapId, CliffBiomeMats>();

export function getCliffRockMaterials(mapId: MapId): CliffBiomeMats {
  const cached = cliffMatsCache.get(mapId);
  if (cached) return cached;
  ensureRockDetail();

  const palette: Record<
    MapId,
    {
      wall: number;
      cap: number;
      boulder: number;
      foliage: number;
      trunk: number;
      wallRough?: number;
      capRough?: number;
      wallMetal?: number;
      capMetal?: number;
      accent?: number;
      water?: number;
    }
  > = {
    crossroads: {
      wall: 0x4b4a45,
      cap: 0x7b7868,
      boulder: 0x5c5b55,
      foliage: 0x264b30,
      trunk: 0x4a3525,
    },
    fulda_gap: {
      wall: 0x4b4a45,
      cap: 0x7b7868,
      boulder: 0x5c5b55,
      foliage: 0x264b30,
      trunk: 0x4a3525,
    },
    canyon: {
      wall: 0x86442c,
      cap: 0xc2794e,
      boulder: 0x9b5538,
      foliage: 0x4b5c32,
      trunk: 0x573b28,
    },
    basin: {
      wall: 0x2f3640,
      cap: 0x55606d,
      boulder: 0x3e4752,
      foliage: 0x1e3c38,
      trunk: 0x362d28,
    },
    tundra: {
      // Ice-blue glacier cliffs, bright snow-frosted cap & dark arctic spruce
      wall: 0x5d8eb4,
      cap: 0xd6eaf8,
      boulder: 0x84aac7,
      foliage: 0x224642,
      trunk: 0x3d3028,
      wallRough: 0.42,
      capRough: 0.5,
      wallMetal: 0.16,
      capMetal: 0.1,
      accent: 0xe6f4ff,
    },
    fortress: {
      // Weathered ochre sandstone citadel walls with fortified dark stone parapet trim
      wall: 0x9c8056,
      cap: 0x4a4742,
      boulder: 0x876f4c,
      foliage: 0x566034,
      trunk: 0x5a402a,
      wallRough: 0.88,
      capRough: 0.78,
      capMetal: 0.12,
      accent: 0x3a3834,
    },
    jungle: {
      // Mossy dark basalt ridges & rich dense vibrant tropical canopies
      wall: 0x2a3c30,
      cap: 0x355c35,
      boulder: 0x344a39,
      foliage: 0x1e7d38,
      trunk: 0x4c321e,
      accent: 0x2ea048,
    },
    islands: {
      // Wet coastal slate river-gorge crags & shimmering blue-teal water surface
      wall: 0x284756,
      cap: 0x476874,
      boulder: 0x3a5460,
      foliage: 0x235c46,
      trunk: 0x47382c,
      wallRough: 0.56,
      capRough: 0.48,
      wallMetal: 0.14,
      water: 0x166d8c,
    },
    oasis: {
      // Terracotta Sahara rock spurs & vibrant palm-green oasis foliage
      wall: 0xa65836,
      cap: 0xd9a162,
      boulder: 0xb56d42,
      foliage: 0x2d8a3c,
      trunk: 0x6e4d30,
      accent: 0x3ba64a,
    },
    archipelago: {
      // Pacific Atoll: dark volcanic basalt crags, tropical emerald palms & turquoise ocean
      wall: 0x2d3238,
      cap: 0x455348,
      boulder: 0x3c4347,
      foliage: 0x24943e,
      trunk: 0x6b4c30,
      wallRough: 0.84,
      capRough: 0.78,
      wallMetal: 0.08,
      accent: 0x38ba54,
      water: 0x16a8b8,
    },
    coastline: {
      // Storm Coast: rugged wet granite sea-cliffs, stormy spruce & slate-blue North Sea
      wall: 0x37444f,
      cap: 0x52636b,
      boulder: 0x46545e,
      foliage: 0x1f4d3a,
      trunk: 0x3f332a,
      wallRough: 0.66,
      capRough: 0.62,
      wallMetal: 0.14,
      water: 0x154768,
    },
    atlantis: {
      // Mythic Sea: teal coral stone pylons, pale marble-gold ancient temple caps & luminous turquoise reef
      wall: 0x3c8492,
      cap: 0xe0d6bc,
      boulder: 0x4c8a90,
      foliage: 0x1fa67a,
      trunk: 0x7c745e,
      wallRough: 0.48,
      capRough: 0.36,
      wallMetal: 0.16,
      capMetal: 0.24,
      accent: 0xe4be58,
      water: 0x18c4d6,
    },
    shipwreck: {
      // Abyssal: wet dark granite reefs, weathered kelp-slate caps & deep stormy teal-slate ocean
      wall: 0x26353e,
      cap: 0x3b4d52,
      boulder: 0x31414a,
      foliage: 0x1a463a,
      trunk: 0x362d26,
      wallRough: 0.5,
      capRough: 0.56,
      wallMetal: 0.2,
      water: 0x114256,
    },
    volcano: {
      // Volcanic: charcoal-basalt obsidian spires with glowing molten orange-amber caldera fissures
      wall: 0x242022,
      cap: 0x3a3234,
      boulder: 0x2d2729,
      foliage: 0x3e2a20,
      trunk: 0x261d1a,
      wallRough: 0.62,
      capRough: 0.72,
      wallMetal: 0.24,
      capMetal: 0.14,
      accent: 0xff5a14,
      water: 0x1a3e50,
    },
    oilrig: {
      // Deep Sea: riveted industrial steel offshore bulkheads, concrete decks & yellow safety accents
      wall: 0x3c4854,
      cap: 0x5c6670,
      boulder: 0x46525c,
      foliage: 0x2c6c56,
      trunk: 0x4e4238,
      wallRough: 0.44,
      capRough: 0.52,
      wallMetal: 0.64,
      capMetal: 0.42,
      accent: 0xe4ae24,
      water: 0x104478,
    },
    cybergrid: {
      // Orbital: sleek dark carbon-titanium monolith walls with luminous cyan energy inlays
      wall: 0x1c2432,
      cap: 0x2d3a4e,
      boulder: 0x232f40,
      foliage: 0x20d8ff,
      trunk: 0x1a222e,
      wallRough: 0.28,
      capRough: 0.24,
      wallMetal: 0.82,
      capMetal: 0.86,
      accent: 0x28ecff,
    },
    hormuz: {
      // Gulf Strait: sun-bleached arid coastal bluffs, salt-crusted rocks & deep teal Persian Gulf water
      wall: 0x8a7a5c,
      cap: 0xa89a74,
      boulder: 0x7a6c52,
      foliage: 0x4a7a44,
      trunk: 0x5c4630,
      wallRough: 0.88,
      capRough: 0.82,
      wallMetal: 0.06,
      accent: 0xd8b56a,
      water: 0x0e5e78,
    },
    delta: {
      // River Delta: lush jungle mangrove bluffs, wet dark mud & warm green-brown waterways
      wall: 0x3a5a3a,
      cap: 0x54704c,
      boulder: 0x2e4a34,
      foliage: 0x1e7a38,
      trunk: 0x4a3826,
      wallRough: 0.86,
      capRough: 0.8,
      wallMetal: 0.06,
      accent: 0x5aa84c,
      water: 0x1e6a52,
    },
    bering: {
      // Polar Strait: sea-ice floes, frost-covered granite shores & steel-blue arctic water
      wall: 0x6e96b4,
      cap: 0xe4f2fc,
      boulder: 0x86aac2,
      foliage: 0x24484a,
      trunk: 0x3c3028,
      wallRough: 0.44,
      capRough: 0.5,
      wallMetal: 0.16,
      capMetal: 0.1,
      accent: 0xecf8ff,
      water: 0x14506e,
    },
    europa: {
      // Continental European steppe/highlands: rugged slate-granite mountain ridges & rich olive-emerald conifers
      wall: 0x494f54,
      cap: 0x6c7566,
      boulder: 0x575d60,
      foliage: 0x265c32,
      trunk: 0x4a3524,
      wallRough: 0.84,
      capRough: 0.82,
      wallMetal: 0.08,
    },
    pacific_theatre: {
      // Coral Sea: dark volcanic basalt atoll crags, vivid tropical emerald palms & turquoise coral sea
      wall: 0x2d3238,
      cap: 0x46584a,
      boulder: 0x3c4347,
      foliage: 0x249c42,
      trunk: 0x6b4c30,
      wallRough: 0.84,
      capRough: 0.78,
      wallMetal: 0.08,
      accent: 0x38ba54,
      water: 0x14b4c8,
    },
    panama: {
      // Coral Sea: dark volcanic basalt atoll crags, vivid tropical emerald palms & turquoise coral sea
      wall: 0x2d3238,
      cap: 0x46584a,
      boulder: 0x3c4347,
      foliage: 0x249c42,
      trunk: 0x6b4c30,
      wallRough: 0.84,
      capRough: 0.78,
      wallMetal: 0.08,
      accent: 0x38ba54,
      water: 0x14b4c8,
    },
    english_channel: {
      // Coral Sea: dark volcanic basalt atoll crags, vivid tropical emerald palms & turquoise coral sea
      wall: 0x2d3238,
      cap: 0x46584a,
      boulder: 0x3c4347,
      foliage: 0x249c42,
      trunk: 0x6b4c30,
      wallRough: 0.84,
      capRough: 0.78,
      wallMetal: 0.08,
      accent: 0x38ba54,
      water: 0x14b4c8,
    },
    arctic_front: {
      // Polar War: ice-blue glacial ridges, snow-frosted caps & icy steel-blue polar ocean
      wall: 0x5786ad,
      cap: 0xdceefa,
      boulder: 0x7ca2c0,
      foliage: 0x204542,
      trunk: 0x3b2f28,
      wallRough: 0.4,
      capRough: 0.48,
      wallMetal: 0.18,
      capMetal: 0.1,
      accent: 0xeaf6ff,
      water: 0x16547c,
    },
    megacontinent: {
      // Eurasia Grand Theater: alpine granite peaks, snow-dusted crests, steppe pines & deep azure sea strait
      wall: 0x4a4f58,
      cap: 0x9aa4a8,
      boulder: 0x5b6066,
      foliage: 0x285834,
      trunk: 0x4c3726,
      wallRough: 0.78,
      capRough: 0.72,
      wallMetal: 0.1,
      accent: 0xdbe6ee,
      water: 0x125e94,
    },
    persian_gulf: {
      // Eurasia Grand Theater: alpine granite peaks, snow-dusted crests, steppe pines & deep azure sea strait
      wall: 0x4a4f58,
      cap: 0x9aa4a8,
      boulder: 0x5b6066,
      foliage: 0x285834,
      trunk: 0x4c3726,
      wallRough: 0.78,
      capRough: 0.72,
      wallMetal: 0.1,
      accent: 0xdbe6ee,
      water: 0x125e94,
    },
    mediterranean: {
      wall: 0x6a6254, cap: 0xa89a78, boulder: 0x756c5b, foliage: 0x3f6b32, trunk: 0x563d25,
      wallRough: 0.76, capRough: 0.7, wallMetal: 0.08, accent: 0xf0dfb4, water: 0x14749a,
    },
    scandinavia: {
      wall: 0x4d5c66, cap: 0x9fb2bd, boulder: 0x5b6b74, foliage: 0x24533d, trunk: 0x3d2d22,
      wallRough: 0.8, capRough: 0.72, wallMetal: 0.1, accent: 0xe4eef5, water: 0x124765,
    },
    terra: {
      wall: 0x535d55, cap: 0x9aa79a, boulder: 0x626b61, foliage: 0x2e6336, trunk: 0x4b3524,
      wallRough: 0.78, capRough: 0.72, wallMetal: 0.09, accent: 0xdde8dc, water: 0x115b8c,
    },
  };
  const p = palette[mapId] ?? palette.crossroads;

  let cliffWaterMat: THREE.MeshStandardMaterial | undefined;
  if (p.water !== undefined) {
    const cliffWaterNorm = registerWaterNormalTexture(new THREE.CanvasTexture(ensureWaterNormalCanvas()));
    cliffWaterNorm.wrapS = cliffWaterNorm.wrapT = THREE.RepeatWrapping;
    cliffWaterMat = new THREE.MeshStandardMaterial({
      color: p.water,
      emissive: 0x0a384c,
      emissiveIntensity: 0.35,
      normalMap: cliffWaterNorm,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness: 0.14,
      metalness: 0.32,
      transparent: true,
      opacity: 0.88,
      envMapIntensity: 1.25,
    });
  }

  const isGlowingVolcano = mapId === "volcano";
  const isGlowingCyber = mapId === "cybergrid";
  const isAtlantis = mapId === "atlantis";
  const isArctic = mapId === "tundra" || mapId === "arctic_front";
  const isMetallicBiome = mapId === "cybergrid" || mapId === "oilrig";

  const mats: CliffBiomeMats = {
    wall: new THREE.MeshStandardMaterial({
      color: p.wall,
      normalMap: rockNormalTex!,
      normalScale: new THREE.Vector2(isMetallicBiome ? 0.65 : 1.15, isMetallicBiome ? 0.65 : 1.15),
      roughnessMap: rockRoughTex!,
      roughness: p.wallRough ?? 0.9,
      metalness: p.wallMetal ?? 0.06,
      envMapIntensity: isArctic ? 0.95 : isMetallicBiome ? 1.25 : isAtlantis ? 0.9 : 0.6,
    }),
    cap: new THREE.MeshStandardMaterial({
      color: p.cap,
      normalMap: rockNormalTex!,
      normalScale: new THREE.Vector2(isMetallicBiome ? 0.45 : 0.75, isMetallicBiome ? 0.45 : 0.75),
      roughnessMap: rockRoughTex!,
      roughness: p.capRough ?? 0.86,
      metalness: p.capMetal ?? 0.05,
      envMapIntensity: isArctic ? 0.9 : isMetallicBiome ? 1.2 : isAtlantis ? 0.95 : 0.55,
    }),
    boulder: new THREE.MeshStandardMaterial({
      color: p.boulder,
      normalMap: rockNormalTex!,
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: p.wallRough ? Math.min(0.86, p.wallRough + 0.15) : 0.9,
      metalness: p.wallMetal ?? 0.08,
      envMapIntensity: isMetallicBiome ? 1.1 : 0.55,
    }),
    foliage: new THREE.MeshStandardMaterial({
      color: p.foliage,
      roughness: isGlowingCyber ? 0.25 : 0.84,
      metalness: isGlowingCyber ? 0.4 : 0.03,
      emissive: isGlowingCyber ? new THREE.Color(0x16c8ff) : new THREE.Color(0x000000),
      emissiveIntensity: isGlowingCyber ? 0.95 : 0,
      flatShading: true,
      envMapIntensity: 0.55,
    }),
    trunk: new THREE.MeshStandardMaterial({
      color: p.trunk,
      roughness: isMetallicBiome ? 0.45 : 0.94,
      metalness: isMetallicBiome ? 0.65 : 0.02,
    }),
    accent:
      p.accent !== undefined
        ? new THREE.MeshStandardMaterial({
            color: p.accent,
            roughness: isArctic ? 0.38 : isAtlantis ? 0.28 : isGlowingVolcano || isGlowingCyber ? 0.22 : 0.78,
            metalness: isArctic ? 0.16 : isAtlantis ? 0.58 : isGlowingCyber ? 0.45 : 0.08,
            emissive: isGlowingVolcano
              ? new THREE.Color(0xff4a08)
              : isGlowingCyber
                ? new THREE.Color(0x18e0ff)
                : new THREE.Color(0x000000),
            emissiveIntensity: isGlowingVolcano ? 1.55 : isGlowingCyber ? 1.45 : 0,
            flatShading: true,
            envMapIntensity: isArctic || isAtlantis || isGlowingCyber ? 1.2 : 0.6,
          })
        : undefined,
    water: cliffWaterMat,
  };
  cliffMatsCache.set(mapId, mats);
  return mats;
}

let craterTexCache: THREE.CanvasTexture | null = null;
export function getCraterTexture(): THREE.CanvasTexture {
  if (craterTexCache) return craterTexCache;
  const S = 256;
  const [c, ctx] = makeCanvas(S, S);
  const rand = mulberry32(3197);
  const cx = S / 2;
  const cy = S / 2;

  ctx.clearRect(0, 0, S, S);

  // Soft outer soot halo
  const outer = ctx.createRadialGradient(cx, cy, S * 0.06, cx, cy, S * 0.48);
  outer.addColorStop(0, "rgba(8, 7, 7, 0.94)");
  outer.addColorStop(0.32, "rgba(18, 15, 13, 0.82)");
  outer.addColorStop(0.58, "rgba(38, 30, 24, 0.46)");
  outer.addColorStop(0.82, "rgba(28, 22, 18, 0.16)");
  outer.addColorStop(1, "rgba(15, 12, 10, 0)");
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.48, 0, Math.PI * 2);
  ctx.fill();

  // Radial scorch streaks & blast rays
  for (let i = 0; i < 42; i++) {
    const ang = rand() * Math.PI * 2;
    const r0 = S * (0.08 + rand() * 0.1);
    const r1 = S * (0.28 + rand() * 0.2);
    ctx.strokeStyle = `rgba(12, 10, 9, ${0.18 + rand() * 0.34})`;
    ctx.lineWidth = 1.5 + rand() * 5.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    ctx.stroke();
  }

  // Subtle warm ash / cracked rim ring
  const rim = ctx.createRadialGradient(cx, cy, S * 0.16, cx, cy, S * 0.32);
  rim.addColorStop(0, "rgba(85, 58, 36, 0)");
  rim.addColorStop(0.55, "rgba(72, 54, 40, 0.28)");
  rim.addColorStop(1, "rgba(40, 32, 26, 0)");
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.34, 0, Math.PI * 2);
  ctx.fill();

  // Deep charred impact pit center
  const pit = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.22);
  pit.addColorStop(0, "rgba(4, 4, 4, 0.96)");
  pit.addColorStop(0.65, "rgba(14, 11, 10, 0.85)");
  pit.addColorStop(1, "rgba(20, 16, 14, 0)");
  ctx.fillStyle = pit;
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.22, 0, Math.PI * 2);
  ctx.fill();

  // Fine scorched speckles
  for (let i = 0; i < 240; i++) {
    const a = rand() * Math.PI * 2;
    const rad = Math.sqrt(rand()) * S * 0.44;
    const sz = 1 + rand() * 2.4;
    ctx.fillStyle = rand() > 0.25 ? "rgba(10, 9, 8, 0.45)" : "rgba(95, 76, 56, 0.25)";
    ctx.fillRect(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, sz, sz);
  }

  craterTexCache = new THREE.CanvasTexture(c);
  craterTexCache.colorSpace = THREE.SRGBColorSpace;
  return craterTexCache;
}

// ---------- Animated Shimmering Ocean Water Material (Tangent-Space Wave Normals) ----------

let waterNormalBase: HTMLCanvasElement | null = null;
let waterNormalBaseComplete = false;
const waterNormalTextureRefs = new Set<WeakRef<THREE.CanvasTexture>>();

function registerWaterNormalTexture(texture: THREE.CanvasTexture): THREE.CanvasTexture {
  if (!waterNormalBaseComplete) waterNormalTextureRefs.add(new WeakRef(texture));
  return texture;
}

function markWaterNormalTexturesDirty(): void {
  waterNormalBaseComplete = true;
  for (const ref of waterNormalTextureRefs) {
    const texture = ref.deref();
    if (texture) texture.needsUpdate = true;
  }
  waterNormalTextureRefs.clear();
}

function ensureWaterNormalCanvas(): HTMLCanvasElement {
  if (waterNormalBase) return waterNormalBase;
  const S = 256;
  const [c, ctx] = makeCanvas(S, S);
  ctx.fillStyle = NEUTRAL_NORMAL_FILL;
  ctx.fillRect(0, 0, S, S);
  waterNormalBase = c;

  runStaticTextureJob(
    "water-normal",
    (textures) => {
      paintCanvasFromPixels(c, textures.normalMap);
      markWaterNormalTexturesDirty();
    },
    () => {
      copyCanvasContents(generateWaterNormal(mainCanvasFactory), c);
      markWaterNormalTexturesDirty();
    },
  );
  return c;
}

export function createOceanWaterMaterial(mapId: MapId): THREE.MeshStandardMaterial {
  const normalMap = registerWaterNormalTexture(new THREE.CanvasTexture(ensureWaterNormalCanvas()));
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat.set(0.42, 0.42);
  normalMap.anisotropy = 4;

  const cfg: Record<string, { color: number; emissive: number; ei: number; normalScale: number; opacity?: number }> = {
    archipelago: { color: 0x16a8be, emissive: 0x0a5668, ei: 0.28, normalScale: 0.58 },
    coastline: { color: 0x184e72, emissive: 0x082438, ei: 0.22, normalScale: 0.72 },
    islands: { color: 0x1680a2, emissive: 0x083c52, ei: 0.26, normalScale: 0.62 },
    atlantis: { color: 0x16c8da, emissive: 0x0d7488, ei: 0.36, normalScale: 0.52, opacity: 0.82 },
    shipwreck: { color: 0x103f52, emissive: 0x061d28, ei: 0.2, normalScale: 0.78, opacity: 0.88 },
    volcano: { color: 0x1a3e50, emissive: 0x102834, ei: 0.24, normalScale: 0.68, opacity: 0.86 },
    oilrig: { color: 0x0f4478, emissive: 0x061f42, ei: 0.22, normalScale: 0.7, opacity: 0.87 },
    hormuz: { color: 0x0e6a8a, emissive: 0x064054, ei: 0.28, normalScale: 0.66, opacity: 0.85 },
    delta: { color: 0x1a7458, emissive: 0x0a3e2c, ei: 0.26, normalScale: 0.7, opacity: 0.86 },
    bering: { color: 0x165a7e, emissive: 0x0a2e48, ei: 0.22, normalScale: 0.72, opacity: 0.88 },
    europa: { color: 0x186c88, emissive: 0x083448, ei: 0.24, normalScale: 0.62, opacity: 0.85 },
    pacific_theatre: { color: 0x14b6cc, emissive: 0x0a6476, ei: 0.3, normalScale: 0.56, opacity: 0.84 },
    arctic_front: { color: 0x1a567c, emissive: 0x0a2c44, ei: 0.24, normalScale: 0.68, opacity: 0.87 },
    megacontinent: { color: 0x125e94, emissive: 0x082e52, ei: 0.26, normalScale: 0.64, opacity: 0.86 },
  };
  const c = cfg[mapId] ?? cfg.islands;

  return new THREE.MeshStandardMaterial({
    color: c.color,
    emissive: c.emissive,
    emissiveIntensity: c.ei,
    normalMap,
    normalScale: new THREE.Vector2(c.normalScale, c.normalScale),
    roughness: 0.08,
    metalness: 0.36,
    envMapIntensity: 1.5,
    transparent: true,
    opacity: c.opacity ?? 0.85,
    depthWrite: false,
  });
}

// ---------- Procedural Battlefield Terrain Map ----------

export function createBattlefieldTextures(mapId: MapId = "crossroads"): {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
} {
  const S = 1024;
  const map = makePlaceholderTexture(S, S, "rgb(84, 82, 56)");
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;

  const bumpMap = makePlaceholderTexture(S, S, "rgb(124, 124, 124)");
  bumpMap.anisotropy = 4;
  // scene.ts currently discards the legacy bump texture immediately. Avoid a
  // pointless 4 MiB main-thread putImageData when the asynchronous result
  // arrives after that disposal, while still supporting any future consumer.
  let bumpMapDisposed = false;
  bumpMap.addEventListener("dispose", () => {
    bumpMapDisposed = true;
  });

  const normalMap = makePlaceholderTexture(S, S, NEUTRAL_NORMAL_FILL);
  normalMap.anisotropy = 8;

  const fallback = () => {
    const g = generateBattlefieldTextures(mainCanvasFactory, mapId);
    adoptTextureCanvas(map, g.map);
    adoptTextureCanvas(bumpMap, g.bumpMap);
    adoptTextureCanvas(normalMap, g.normalMap);
  };

  const job = requestBattlefieldTextureJob(mapId);
  if (!job) {
    fallback();
  } else {
    job
      .then((result) => {
        paintTextureFromPixels(map, result.textures.map);
        if (!bumpMapDisposed) paintTextureFromPixels(bumpMap, result.textures.bumpMap);
        paintTextureFromPixels(normalMap, result.textures.normalMap);
      })
      .catch((err) => {
        if (!isTextureJobCancelled(err)) fallback();
      });
  }

  return { map, bumpMap, normalMap };
}

// ---------- Seamless 256x256 Close-Up 1P Ground Micro-Detail Maps ----------

let groundMicroMapTex: THREE.CanvasTexture | null = null;
let groundMicroNormalTex: THREE.CanvasTexture | null = null;

export function getGroundMicroDetail(): {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
} {
  if (groundMicroMapTex && groundMicroNormalTex) {
    return { map: groundMicroMapTex, normalMap: groundMicroNormalTex };
  }

  const S = 256;
  // Keep micro-albedo linear so neutral 0.50 maps cleanly to 1.00 contrast multiplier in GLSL
  groundMicroMapTex = makePlaceholderTexture(S, S, "rgb(128, 128, 128)");
  groundMicroMapTex.wrapS = groundMicroMapTex.wrapT = THREE.RepeatWrapping;
  groundMicroMapTex.anisotropy = 8;

  groundMicroNormalTex = makePlaceholderTexture(S, S, NEUTRAL_NORMAL_FILL);
  groundMicroNormalTex.wrapS = groundMicroNormalTex.wrapT = THREE.RepeatWrapping;
  groundMicroNormalTex.anisotropy = 8;

  runStaticTextureJob(
    "ground-micro",
    (textures) => {
      paintTextureFromPixels(groundMicroMapTex!, textures.map);
      paintTextureFromPixels(groundMicroNormalTex!, textures.normalMap);
    },
    () => {
      const g = generateGroundMicroDetail(mainCanvasFactory);
      adoptTextureCanvas(groundMicroMapTex!, g.map);
      adoptTextureCanvas(groundMicroNormalTex!, g.normalMap);
    },
  );

  return { map: groundMicroMapTex, normalMap: groundMicroNormalTex };
}
