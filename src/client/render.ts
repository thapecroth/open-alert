import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CrateSnap, EntSnap, GameEvent, OrderKind, PlayerState } from "../shared/protocol";
import {
  UNITS,
  SUPPLY_HUB_RADIUS,
  SUPPLY_TRUCK_RADIUS,
  THAAD_NUKE_RADIUS,
  type CrateKind,
  type UnitKind,
} from "../shared/gamedefs";
import {
  makeEntVis,
  makeCrateVis,
  setVetBadge,
  setGroupTag,
  tagEntity,
  applyFacing,
  makeRangeRing,
  EntVis,
  CrateVis,
  SHADOW_PROXY_LAYER,
  simplifyShadowProxyGeometry,
  isUnifiedArmorEligible,
  isMergedGlowEligible,
  bakeUnifiedGeometry,
  bakeGlowGeometry,
  getMergedGlowMat,
} from "./models";
import { createAnimState, stepEntityAnim, triggerFireAnim, triggerHitFlash, AnimState } from "./anim";
import { VfxSystem, WaypointOverlay } from "./vfx";
import { BUILDINGS, isBuildingKind, type BuildingKind, type EntKind } from "./util";
import { GameScene } from "./scene";
import { getAccentMat, getUnifiedArmorMat } from "./textures";

const INTERP_MS = 250; // 50ms WAN jitter cushion above 200ms (5 Hz) snapshot interval
const SNAP_KEEP = 8;

// ---------- Instanced swarm rendering ----------
// Cheap high-count kinds (drones & infantry — the bulk of late-game entity
// counts) render through InstancedMesh pools: a few draw calls per kind
// regardless of swarm size instead of ~6 per entity. The full EntVis is still
// built for bookkeeping (fog flag, FPV, icons) but is NEVER added to the scene;
// a lightweight proxy Group carries the pick box + selection ring.
const INSTANCED_KINDS = new Set<EntKind>(["fpvdrone", "shahed", "usv", "infantry", "rocket", "engineer"]);
// Rigid-hulled vehicles are instanced separately from the swarm path. Their
// turrets/recoil/spinning scoops still articulate per instance: the pool stores
// authored part transforms relative to those animated anchors and composes the
// anchor chain every frame. Spider is excluded because its four leg roots are
// independent articulated anchors rather than one rigid hull+turret chain.
const VEHICLE_INSTANCED_KINDS = new Set<EntKind>([
  "tank",
  "heavy",
  "arty",
  "himars",
  "ballistic",
  "railtank",
  "supplytruck",
  "harvester",
  // Fixed-wing aircraft, helicopters, airships and surface/submarine warships
  // use the same rigid hull+turret-chain shape as land armor. Their banking,
  // pitch, heave and altitude all live on rig.body, so the existing anchor-chain
  // compose reproduces them without a separate aircraft renderer.
  "uav",
  "ewdrone",
  "interceptor",
  "chopper",
  "a10",
  "ac130",
  "bomber",
  "stealthbomber",
  "hypersonic",
  "zeppelin",
  "gunboat",
  "destroyer",
  "sub",
  "dreadnought",
  "carrier",
]);
// Buildings join the rigid-instance path only after construction/material
// transitions settle. The set is derived from the authoritative building table
// so upgrade and neutral landmark kinds cannot drift out of the optimization.
const BUILDING_INSTANCED_KINDS = new Set<EntKind>(Object.keys(BUILDINGS) as EntKind[]);
const INSTANCE_CAP = 512;
// 512 matches the swarm-pool ceiling: enough for extreme single-kind armor
// hordes without preallocating megabytes of rarely-used instance attributes.
const VEHICLE_INSTANCE_CAP = 512;
// Building pools are per kind rather than per kind+color. Even a heavily
// vertical-teched 8-player match rarely approaches triple digits of one kind;
// 256 leaves generous headroom without preallocating vehicle-sized pools.
const BUILDING_INSTANCE_CAP = 256;

const instPickGeo = new THREE.BoxGeometry(1, 1, 1);
const instPickMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
const instSelGeo = new THREE.RingGeometry(0.5, 0.62, 28);
const instSelMat = new THREE.MeshBasicMaterial({
  color: 0x5ae8ff,
  transparent: true,
  opacity: 0.9,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const _instPos = new THREE.Vector3();
const _instQ = new THREE.Quaternion();
const _instOne = new THREE.Vector3(1, 1, 1);
const _instZero = new THREE.Vector3(0.0001, 0.0001, 0.0001);
const _instM = new THREE.Matrix4();
const _instP = new THREE.Matrix4();
const _instUp = new THREE.Vector3(0, 1, 0);
const _instColor = new THREE.Color();
const _instWhite = new THREE.Color(0xffffff);
let instWhiteAccentMat: THREE.MeshStandardMaterial | null = null;

function getInstWhiteAccentMat(src: THREE.Material): THREE.MeshStandardMaterial {
  if (!instWhiteAccentMat) {
    // Accent materials differ only by faction color; maps/roughness/metalness are
    // identical. A white clone lets InstancedMesh.instanceColor carry the exact
    // per-player tint, collapsing the old kind+color pool proliferation.
    instWhiteAccentMat = (src as THREE.MeshStandardMaterial).clone();
    instWhiteAccentMat.color.set(0xffffff);
  }
  return instWhiteAccentMat;
}

function accentHexForVariant(colorHex: string, variant: number): string {
  _instColor.set(colorHex);
  if (variant === 1) _instColor.multiplyScalar(0.62);
  else if (variant === 2) _instColor.lerp(_instWhite, 0.22);
  // The model helpers round through a hex string before constructing the
  // cached accent material; preserving that quantization keeps colors exact.
  return `#${_instColor.getHexString()}`;
}

interface InstPoolPart {
  im: THREE.InstancedMesh;
  local: THREE.Matrix4; // part transform relative to model root
  accentVariant?: number; // faction-tinted part: 0=base, 1=dimmed, 2=lifted
}
interface InstPool {
  parts: InstPoolPart[];
  owners: Int32Array; // instIdx -> entity id
  free: number[];
  used: number; // high-water index
}
interface InstSlot {
  pool: InstPool;
  idx: number;
  proxy: THREE.Group;
  ring: THREE.Mesh;
  // last-written transform — skip the per-part matrix pass + buffer upload when unchanged
  lx: number;
  ly: number;
  lyaw: number;
  lvis: boolean;
}

// ---------- Instanced rigid-vehicle rendering ----------
// Anchor keys are intentionally open-ended: the fixed rig nodes cover vehicles,
// ships and buildings, while AC-130 prop hubs add spinChild<N>/spin2Child<N>
// keys because their animation rotates each child around its own axle rather
// than rotating the parent group (which would make the props orbit the hull).
type VehicleAnchorKind = string;

interface VehicleNodeSpec {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
  parentBase: "body" | "turret" | "spin" | "spin2";
  // Static transform of the animated node's parent relative to parentBase.
  // HIMARS/ballistic recoil, for example, lives inside a fixed pitched pod under
  // the rotating turret; only the recoil node itself translates per instance.
  parentRel: THREE.Matrix4;
  parentRelIdentity: boolean;
}

interface VehiclePartDef {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  local: THREE.Matrix4; // mesh transform relative to its nearest animated anchor
  // 0 = identity, 1 = translation-only, 2 = full affine. Most mergeStaticBody
  // outputs are baked at the origin, letting the hot loop copy/transform columns
  // instead of paying a full 4x4 multiply for every small part.
  localMode: 0 | 1 | 2;
  localPos: THREE.Vector3;
  anchor: VehicleAnchorKind;
  accentVariant?: number;
  castShadow: boolean;
  receiveShadow: boolean;
  renderOrder: number;
  isBar: boolean; // contact-shadow discs use the isBar tag but are hull visuals
  pulse: boolean; // scale-pulsed glow mesh
  bin: boolean; // harvester ore-load mesh (scale.y is cargo-driven)
  shadow: boolean; // aircraft ground contact shadow (root-anchored, XZ scale breathes)
  childAnchor: 0 | 1 | 2; // 0 fixed anchor, 1 spin child, 2 spin2 child
  childIndex: number;
  baseScale: THREE.Vector3;
  shadowProxied?: boolean; // rigid geometry represented by the consolidated depth-only proxy
}

interface VehicleRigSpec {
  bodyPosition: THREE.Vector3;
  bodyRotation: THREE.Euler;
  bodyScale: THREE.Vector3;
  turret?: VehicleNodeSpec;
  recoil?: VehicleNodeSpec;
  spin?: VehicleNodeSpec;
  spin2?: VehicleNodeSpec;
  crane?: VehicleNodeSpec;
  flag?: VehicleNodeSpec;
  spinChildren: VehicleNodeSpec[];
  spin2Children: VehicleNodeSpec[];
  pulseScales: THREE.Vector3[];
  binScale?: THREE.Vector3;
  shadowScale?: THREE.Vector3;
  altitude?: number;
  smokePos?: THREE.Vector3;
  pickCenter: THREE.Vector3;
  pickScale: THREE.Vector3;
  cullRadius: number;
}

interface VehicleShadowPartDef {
  geometry: THREE.BufferGeometry; // position-only, baked into anchor space
  anchor: VehicleAnchorKind;
  childAnchor: 0 | 1 | 2;
  childIndex: number;
}

interface VehicleTemplate {
  parts: VehiclePartDef[];
  shadowParts: VehicleShadowPartDef[];
  rig: VehicleRigSpec;
}

interface VehicleMatrixDirtyState {
  // Inclusive instance-slot span written since the last flush. Ranges are
  // coalesced once per part instead of allocating one update-range object for
  // every vehicle every frame.
  matrixMinSlot: number;
  matrixMaxSlot: number;
  matrixUpdateRange: { start: number; count: number };
}
interface VehicleInstPart extends VehicleMatrixDirtyState {
  im: THREE.InstancedMesh;
  def: VehiclePartDef;
}
interface VehicleShadowInstPart extends VehicleMatrixDirtyState {
  im: THREE.InstancedMesh;
  def: VehicleShadowPartDef;
}
interface VehicleInstPool {
  template: VehicleTemplate;
  parts: VehicleInstPart[];
  shadowParts: VehicleShadowInstPart[];
  owners: Int32Array;
  used: number;
  cap: number;
  // Conservative union of live instance positions. InstancedMesh cannot cull
  // individual instances, but this still drops the whole kind pool when every
  // vehicle of that kind is outside the camera/shadow frustum.
  bounds: THREE.Sphere;
  boundsFrame: number;
}
interface VehicleReservation {
  pool: VehicleInstPool;
  idx: number;
  colorHex: string;
}
interface VehicleInstSlot {
  pool: VehicleInstPool;
  idx: number;
  proxy: THREE.Group;
  ring: THREE.Mesh;
  accentHex: string;
  flash: boolean;
  lvis: boolean;
  // Last-composed rig state fingerprint. Parked vehicles (the common case in
  // base defenses, siege lines, and any formation waiting for orders) skip the
  // per-part matrix fan-out entirely while nothing animated.
  sigX: number;
  sigY: number;
  sigYaw: number;
  sigBody: number;
  sigTurret: number;
  sigRecoil: number;
  sigSpin: number;
  sigSpin2: number;
  sigCrane: number;
  sigFlag: number;
  sigPulse: number;
  sigBin: number;
  sigShadowX: number;
  sigShadowZ: number;
  sigSpinKids: number[];
  sigSpin2Kids: number[];
}

const MAX_SPIN_CHILD_ANCHORS = 8;
const _vehRootM = new THREE.Matrix4();
const _vehBodyM = new THREE.Matrix4();
const _vehTurretM = new THREE.Matrix4();
const _vehRecoilM = new THREE.Matrix4();
const _vehSpinM = new THREE.Matrix4();
const _vehSpin2M = new THREE.Matrix4();
const _vehCraneM = new THREE.Matrix4();
const _vehFlagM = new THREE.Matrix4();
const _vehNodeM = new THREE.Matrix4();
const _vehSpinChildM = Array.from({ length: MAX_SPIN_CHILD_ANCHORS }, () => new THREE.Matrix4());
const _vehSpin2ChildM = Array.from({ length: MAX_SPIN_CHILD_ANCHORS }, () => new THREE.Matrix4());
const _vehFlashColor = new THREE.Color(2.4, 2.15, 1.65);
const vehRigDummyGeo = new THREE.BufferGeometry();
const vehRigDummyMat = new THREE.MeshBasicMaterial();
const vehShadowProxyMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

// Position-only clone used exclusively for depth rendering. Dropping normals,
// UVs and vertex colors lets every rigid visual material in one articulated
// anchor collapse into a single shadow draw without changing the main pass.
function vehicleShadowGeometry(src: THREE.BufferGeometry, transform: THREE.Matrix4): THREE.BufferGeometry {
  const nonIndexed = src.index ? src.toNonIndexed() : null;
  const posSrc = (nonIndexed ?? src).attributes.position as THREE.BufferAttribute | undefined;
  const out = new THREE.BufferGeometry();
  if (posSrc) {
    const arr = new Float32Array(posSrc.count * 3);
    for (let i = 0; i < posSrc.count; i++) {
      arr[i * 3] = posSrc.getX(i);
      arr[i * 3 + 1] = posSrc.getY(i);
      arr[i * 3 + 2] = posSrc.getZ(i);
    }
    out.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    out.applyMatrix4(transform);
  }
  nonIndexed?.dispose();
  return out;
}

function unionAttributeUpdateRange(
  attr: THREE.BufferAttribute,
  start: number,
  count: number,
  scratch?: { start: number; count: number },
): void {
  if (count <= 0) return;
  const ranges = attr.updateRanges;
  if (ranges.length === 0) {
    if (scratch) {
      scratch.start = start;
      scratch.count = count;
      ranges.push(scratch);
    } else {
      attr.addUpdateRange(start, count);
    }
    return;
  }
  // Multiple writes before one render must union with any still-pending range;
  // replacing it would drop matrix data written in an earlier update. Keep the
  // first range object and mutate it in place so the hot path does not allocate.
  let minStart = start;
  let maxEnd = start + count;
  for (const r of ranges) {
    minStart = Math.min(minStart, r.start);
    maxEnd = Math.max(maxEnd, r.start + r.count);
  }
  ranges[0].start = minStart;
  ranges[0].count = maxEnd - minStart;
  ranges.length = 1;
}

function copyMatrixElementsToArray(m: THREE.Matrix4, out: Float32Array, offset: number): void {
  const e = m.elements;
  out[offset] = e[0];
  out[offset + 1] = e[1];
  out[offset + 2] = e[2];
  out[offset + 3] = e[3];
  out[offset + 4] = e[4];
  out[offset + 5] = e[5];
  out[offset + 6] = e[6];
  out[offset + 7] = e[7];
  out[offset + 8] = e[8];
  out[offset + 9] = e[9];
  out[offset + 10] = e[10];
  out[offset + 11] = e[11];
  out[offset + 12] = e[12];
  out[offset + 13] = e[13];
  out[offset + 14] = e[14];
  out[offset + 15] = e[15];
}

// Write anchor * local * scale directly into an instance buffer. Matrix4's
// general-purpose post-multiply would multiply all 16 coefficients by the
// sparse scale matrix; keeping the scale on the first three columns avoids a
// second 4x4 multiply and the temporary-copy pass for every animated glow/bin.
function writeMulScaledMatrix(
  anchorM: THREE.Matrix4,
  localM: THREE.Matrix4,
  sx: number,
  sy: number,
  sz: number,
  out: Float32Array,
  base: number,
): void {
  const ae = anchorM.elements;
  const le = localM.elements;
  const m00 = ae[0] * le[0] + ae[4] * le[1] + ae[8] * le[2] + ae[12] * le[3];
  const m01 = ae[0] * le[4] + ae[4] * le[5] + ae[8] * le[6] + ae[12] * le[7];
  const m02 = ae[0] * le[8] + ae[4] * le[9] + ae[8] * le[10] + ae[12] * le[11];
  const m10 = ae[1] * le[0] + ae[5] * le[1] + ae[9] * le[2] + ae[13] * le[3];
  const m11 = ae[1] * le[4] + ae[5] * le[5] + ae[9] * le[6] + ae[13] * le[7];
  const m12 = ae[1] * le[8] + ae[5] * le[9] + ae[9] * le[10] + ae[13] * le[11];
  const m20 = ae[2] * le[0] + ae[6] * le[1] + ae[10] * le[2] + ae[14] * le[3];
  const m21 = ae[2] * le[4] + ae[6] * le[5] + ae[10] * le[6] + ae[14] * le[7];
  const m22 = ae[2] * le[8] + ae[6] * le[9] + ae[10] * le[10] + ae[14] * le[11];
  const m30 = ae[3] * le[0] + ae[7] * le[1] + ae[11] * le[2] + ae[15] * le[3];
  const m31 = ae[3] * le[4] + ae[7] * le[5] + ae[11] * le[6] + ae[15] * le[7];
  const m32 = ae[3] * le[8] + ae[7] * le[9] + ae[11] * le[10] + ae[15] * le[11];
  out[base] = m00 * sx;
  out[base + 1] = m10 * sx;
  out[base + 2] = m20 * sx;
  out[base + 3] = m30 * sx;
  out[base + 4] = m01 * sy;
  out[base + 5] = m11 * sy;
  out[base + 6] = m21 * sy;
  out[base + 7] = m31 * sy;
  out[base + 8] = m02 * sz;
  out[base + 9] = m12 * sz;
  out[base + 10] = m22 * sz;
  out[base + 11] = m32 * sz;
  out[base + 12] = ae[0] * le[12] + ae[4] * le[13] + ae[8] * le[14] + ae[12] * le[15];
  out[base + 13] = ae[1] * le[12] + ae[5] * le[13] + ae[9] * le[14] + ae[13] * le[15];
  out[base + 14] = ae[2] * le[12] + ae[6] * le[13] + ae[10] * le[14] + ae[14] * le[15];
  out[base + 15] = ae[3] * le[12] + ae[7] * le[13] + ae[11] * le[14] + ae[15] * le[15];
}

// Compose animated-node local matrices exactly as the scene graph would have:
// parentRel carries any static intermediate group chain, then the node's own
// animated position/rotation/scale is applied beneath the animated base anchor.
function composeVehicleNodeMatrix(
  node: THREE.Object3D,
  spec: VehicleNodeSpec,
  baseM: THREE.Matrix4,
  out: THREE.Matrix4,
): void {
  node.updateMatrix();
  if (spec.parentRelIdentity) {
    out.multiplyMatrices(baseM, node.matrix);
  } else {
    _vehNodeM.multiplyMatrices(spec.parentRel, node.matrix);
    out.multiplyMatrices(baseM, _vehNodeM);
  }
}

const MAX_EXTRAP_T = 1.38;
const EXTRAP_DAMP = 0.72;
const SNAP_JUMP_DIST_SQ = 16; // snap visual filter if jump > 4 tiles

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

interface LogBars {
  group: THREE.Group;
  barW: number;
  fuelBg: THREE.Sprite;
  fuelFg: THREE.Sprite;
  ammoBg: THREE.Sprite;
  ammoFg: THREE.Sprite;
}

interface Tracked {
  vis: EntVis;
  last: EntSnap;
  anim: AnimState;
  visX: number;
  visY: number;
  visYaw: number;
  // Cached endpoint lookups for the active interpolation window. Snapshot
  // objects are immutable once queued, so these stay valid until the window
  // advances (normally once per 200ms network snapshot rather than per frame).
  interpSnapA: Snap | null;
  interpSnapB: Snap | null;
  interpEntA: EntSnap | null;
  interpEntB: EntSnap | null;
  holdInd?: THREE.Group;
  supplyAura?: THREE.Group;
  logBars?: LogBars;
  lastResupplyFxMs: number;
  isBuilding: boolean;
  isStaticBld: boolean;
  staticFrozen: boolean;
  lastLowPower: boolean;
  cullR: number; // bounding-sphere radius for frustum update culling (includes stale-matrix margin)
  cullY: number; // bounding-sphere center height
  rangeRing?: THREE.Mesh | null; // lazily-built defense range ring (buildings with range only)
  inst?: InstSlot | null; // instanced-swarm slot: proxy replaces the full scene subtree
  vehInst?: VehicleInstSlot | null; // rigid vehicle pool slot; lite rig still animates anchors
}

function isStaticBuildingRig(vis: EntVis): boolean {
  const r = vis.rig;
  return !r.crane && !r.spin && !r.spin2 && !r.flag && !r.turret && !r.pulse?.length;
}

// Generous bounding sphere per entity so a 1-frame-stale camera frustum can
// never wrongly cull update work at screen edges or during fast pans.
function entityCullSphere(vis: EntVis, isBuilding: boolean, kind: string): { r: number; y: number } {
  if (isBuilding) {
    const d = BUILDINGS[kind as keyof typeof BUILDINGS];
    const m = d ? Math.max(d.w, d.h) : 3;
    return { r: m * 0.9 + 2.5, y: 1.4 };
  }
  const alt = vis.rig.altitude ?? 0;
  return { r: alt * 0.5 + 2.6, y: alt > 0 ? alt * 0.5 : 0.9 };
}

function freezeStaticBuilding(vis: EntVis): void {
  vis.rig.body.scale.set(1, 1, 1);
  vis.root.updateMatrix();
  vis.root.updateMatrixWorld(true);
  vis.root.matrixAutoUpdate = false;
  vis.rig.body.traverse((o) => {
    o.matrixAutoUpdate = false;
  });
}

// Shared Hold Position indicator assets (zero per-unit GPU leaks)
const holdRingGeo = new THREE.RingGeometry(0.46, 0.56, 8);
holdRingGeo.rotateX(-Math.PI / 2);
const holdRingMat = new THREE.MeshBasicMaterial({
  color: 0xffc83d,
  transparent: true,
  opacity: 0.82,
  side: THREE.DoubleSide,
  depthWrite: false,
});
let holdBadgeMat: THREE.SpriteMaterial | null = null;

function getHoldBadgeMat(): THREE.SpriteMaterial {
  if (holdBadgeMat) return holdBadgeMat;
  const S = 64;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, S, S);

  // Crisp tactical amber shield silhouette
  ctx.beginPath();
  ctx.moveTo(S * 0.5, S * 0.08);
  ctx.lineTo(S * 0.88, S * 0.22);
  ctx.lineTo(S * 0.82, S * 0.62);
  ctx.quadraticCurveTo(S * 0.5, S * 0.94, S * 0.5, S * 0.94);
  ctx.quadraticCurveTo(S * 0.5, S * 0.94, S * 0.18, S * 0.62);
  ctx.lineTo(S * 0.12, S * 0.22);
  ctx.closePath();
  ctx.fillStyle = "rgba(18, 22, 28, 0.92)";
  ctx.fill();
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = "#ffc83d";
  ctx.stroke();

  // Bold 'H' hold-position glyph
  ctx.fillStyle = "#ffe28a";
  ctx.font = "900 30px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("H", S * 0.5, S * 0.52);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  holdBadgeMat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    opacity: 0.96,
    depthTest: false,
    depthWrite: false,
  });
  return holdBadgeMat;
}

function makeHoldIndicator(topY: number): THREE.Group {
  const g = new THREE.Group();
  g.userData.isBar = true;

  const ring = new THREE.Mesh(holdRingGeo, holdRingMat);
  ring.position.y = 0.062;
  ring.renderOrder = 6;
  ring.userData.isBar = true;
  g.add(ring);

  const badge = new THREE.Sprite(getHoldBadgeMat());
  badge.position.set(0, topY + 0.62, 0);
  badge.scale.set(0.32, 0.32, 1);
  badge.renderOrder = 23;
  badge.userData.isBar = true;
  g.userData.badge = badge;
  g.add(badge);

  return g;
}

// Shared Supply & EW Jamming Aura assets (zero per-entity GPU leaks)
const EW_JAM_RADIUS = UNITS.ewdrone.ewJamRadius ?? 8.5;

const supplyHubAuraRingGeo = new THREE.RingGeometry(SUPPLY_HUB_RADIUS - 0.16, SUPPLY_HUB_RADIUS, 72);
supplyHubAuraRingGeo.rotateX(-Math.PI / 2);
const supplyHubAuraFillGeo = new THREE.CircleGeometry(SUPPLY_HUB_RADIUS - 0.16, 72);
supplyHubAuraFillGeo.rotateX(-Math.PI / 2);

const supplyTruckAuraRingGeo = new THREE.RingGeometry(SUPPLY_TRUCK_RADIUS - 0.14, SUPPLY_TRUCK_RADIUS, 56);
supplyTruckAuraRingGeo.rotateX(-Math.PI / 2);
const supplyTruckAuraFillGeo = new THREE.CircleGeometry(SUPPLY_TRUCK_RADIUS - 0.14, 56);
supplyTruckAuraFillGeo.rotateX(-Math.PI / 2);

const ewJamAuraRingGeo = new THREE.RingGeometry(EW_JAM_RADIUS - 0.16, EW_JAM_RADIUS, 72);
ewJamAuraRingGeo.rotateX(-Math.PI / 2);
const ewJamAuraInnerRingGeo = new THREE.RingGeometry(EW_JAM_RADIUS * 0.56 - 0.06, EW_JAM_RADIUS * 0.56, 56);
ewJamAuraInnerRingGeo.rotateX(-Math.PI / 2);
const ewJamAuraFillGeo = new THREE.CircleGeometry(EW_JAM_RADIUS - 0.16, 72);
ewJamAuraFillGeo.rotateX(-Math.PI / 2);

const thaadAuraRingGeo = new THREE.RingGeometry(THAAD_NUKE_RADIUS - 0.24, THAAD_NUKE_RADIUS, 96);
thaadAuraRingGeo.rotateX(-Math.PI / 2);
const thaadAuraGoldRingGeo = new THREE.RingGeometry(THAAD_NUKE_RADIUS - 0.54, THAAD_NUKE_RADIUS - 0.38, 96);
thaadAuraGoldRingGeo.rotateX(-Math.PI / 2);
const thaadAuraMidRingGeo = new THREE.RingGeometry(THAAD_NUKE_RADIUS * 0.84 - 0.12, THAAD_NUKE_RADIUS * 0.84, 72);
thaadAuraMidRingGeo.rotateX(-Math.PI / 2);
const thaadAuraFillGeo = new THREE.CircleGeometry(THAAD_NUKE_RADIUS - 0.24, 96);
thaadAuraFillGeo.rotateX(-Math.PI / 2);
const thaadAuraDomeGeo = new THREE.SphereGeometry(THAAD_NUKE_RADIUS, 44, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);

const supplyAuraRingMat = new THREE.MeshBasicMaterial({
  color: 0x3ef088,
  transparent: true,
  opacity: 0.42,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const supplyAuraFillMat = new THREE.MeshBasicMaterial({
  color: 0x22d46c,
  transparent: true,
  opacity: 0.075,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const ewAuraRingMat = new THREE.MeshBasicMaterial({
  color: 0xb066ff,
  transparent: true,
  opacity: 0.48,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const ewAuraInnerRingMat = new THREE.MeshBasicMaterial({
  color: 0x46ecff,
  transparent: true,
  opacity: 0.3,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const ewAuraFillMat = new THREE.MeshBasicMaterial({
  color: 0x8a3cff,
  transparent: true,
  opacity: 0.075,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const thaadAuraRingMat = new THREE.MeshBasicMaterial({
  color: 0x48eeff,
  transparent: true,
  opacity: 0.58,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const thaadAuraGoldMat = new THREE.MeshBasicMaterial({
  color: 0xffd252,
  transparent: true,
  opacity: 0.52,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const thaadAuraFillMat = new THREE.MeshBasicMaterial({
  color: 0x36c8e8,
  transparent: true,
  opacity: 0.055,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const thaadAuraDomeMat = new THREE.MeshBasicMaterial({
  color: 0x56e4ff,
  transparent: true,
  opacity: 0.048,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

function makeSupplyAura(kind: "supplyhub" | "supplytruck" | "ewdrone" | "thaad"): THREE.Group {
  const g = new THREE.Group();
  g.visible = false;
  g.userData.isBar = true;

  if (kind === "thaad") {
    const outerRing = new THREE.Mesh(thaadAuraRingGeo, thaadAuraRingMat);
    outerRing.position.y = 0.062;
    outerRing.renderOrder = 6;
    outerRing.userData.isBar = true;
    g.add(outerRing);

    const goldRing = new THREE.Mesh(thaadAuraGoldRingGeo, thaadAuraGoldMat);
    goldRing.position.y = 0.06;
    goldRing.renderOrder = 6;
    goldRing.userData.isBar = true;
    g.add(goldRing);

    const midRing = new THREE.Mesh(thaadAuraMidRingGeo, thaadAuraGoldMat);
    midRing.position.y = 2.65;
    midRing.renderOrder = 6;
    midRing.userData.isBar = true;
    g.add(midRing);

    const fill = new THREE.Mesh(thaadAuraFillGeo, thaadAuraFillMat);
    fill.position.y = 0.052;
    fill.renderOrder = 4;
    fill.userData.isBar = true;
    g.add(fill);

    const dome = new THREE.Mesh(thaadAuraDomeGeo, thaadAuraDomeMat);
    dome.scale.set(1, 0.28, 1);
    dome.position.y = 0.05;
    dome.renderOrder = 5;
    dome.userData.isBar = true;
    g.add(dome);
    return g;
  }

  if (kind === "ewdrone") {
    const ring = new THREE.Mesh(ewJamAuraRingGeo, ewAuraRingMat);
    ring.position.y = 0.058;
    ring.renderOrder = 5;
    ring.userData.isBar = true;
    g.add(ring);

    const innerRing = new THREE.Mesh(ewJamAuraInnerRingGeo, ewAuraInnerRingMat);
    innerRing.position.y = 0.056;
    innerRing.renderOrder = 5;
    innerRing.userData.isBar = true;
    g.add(innerRing);

    const fill = new THREE.Mesh(ewJamAuraFillGeo, ewAuraFillMat);
    fill.position.y = 0.052;
    fill.renderOrder = 4;
    fill.userData.isBar = true;
    g.add(fill);
    return g;
  }

  const isHub = kind === "supplyhub";
  const ring = new THREE.Mesh(isHub ? supplyHubAuraRingGeo : supplyTruckAuraRingGeo, supplyAuraRingMat);
  ring.position.y = 0.056;
  ring.renderOrder = 5;
  ring.userData.isBar = true;
  g.add(ring);

  const fill = new THREE.Mesh(isHub ? supplyHubAuraFillGeo : supplyTruckAuraFillGeo, supplyAuraFillMat);
  fill.position.y = 0.052;
  fill.renderOrder = 4;
  fill.userData.isBar = true;
  g.add(fill);

  return g;
}

// Shared Fuel / Ammo / Supply-Reserve micro-bar materials (zero per-entity GPU leaks)
const logBarBgMat = new THREE.SpriteMaterial({ color: 0x0b1016, transparent: true, opacity: 0.78, depthTest: false });
const logFuelOkMat = new THREE.SpriteMaterial({ color: 0xf4b63d, transparent: true, opacity: 0.94, depthTest: false });
const logFuelLowMat = new THREE.SpriteMaterial({ color: 0xff4938, transparent: true, opacity: 0.98, depthTest: false });
const logAmmoOkMat = new THREE.SpriteMaterial({ color: 0x45d8ff, transparent: true, opacity: 0.94, depthTest: false });
const logAmmoLowMat = new THREE.SpriteMaterial({ color: 0xff5a36, transparent: true, opacity: 0.98, depthTest: false });
const logCargoMat = new THREE.SpriteMaterial({ color: 0x38e882, transparent: true, opacity: 0.95, depthTest: false });

function makeLogBars(topY: number, barW: number): LogBars {
  const group = new THREE.Group();
  group.userData.isBar = true;

  const mk = (mat: THREE.SpriteMaterial, y: number, order: number) => {
    const s = new THREE.Sprite(mat);
    s.position.set(0, y, 0);
    s.scale.set(barW, 0.055, 1);
    s.renderOrder = order;
    s.visible = false;
    s.userData.isBar = true;
    group.add(s);
    return s;
  };

  const fuelBg = mk(logBarBgMat, topY + 0.27, 20);
  const fuelFg = mk(logFuelOkMat, topY + 0.27, 21);
  const ammoBg = mk(logBarBgMat, topY + 0.2, 20);
  const ammoFg = mk(logAmmoOkMat, topY + 0.2, 21);
  return { group, barW, fuelBg, fuelFg, ammoBg, ammoFg };
}

// ---------- Batched solid-color billboard bars ----------
// Health / fuel / ammo bars were individual THREE.Sprite objects: simple solid
// quads, but each visible bar cost a separate transparent draw call and every
// entity carried several extra scene nodes. They remain Sprite-shaped state
// objects for the existing gameplay logic, but are rendered here as one
// instanced billboard mesh with per-instance RGB + alpha.
const OVERLAY_BAR_CAP = 4096;

class OverlayBarBatch {
  private readonly mesh: THREE.InstancedMesh;
  private readonly alphaArr: Float32Array;
  private readonly alphaAttr: THREE.InstancedBufferAttribute;
  private readonly colorArr: Float32Array;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly matrixUpdateRange = { start: 0, count: 0 };
  private readonly alphaUpdateRange = { start: 0, count: 0 };
  private readonly colorUpdateRange = { start: 0, count: 0 };
  private count = 0;

  constructor(
    scene: THREE.Scene,
    texture: THREE.Texture | null = null,
    renderOrder = 20,
    private readonly cap = OVERLAY_BAR_CAP,
  ) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.alphaArr = new Float32Array(this.cap);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphaArr, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aAlpha", this.alphaAttr);

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: texture,
      transparent: true,
      opacity: 1,
      depthTest: false,
      // SpriteMaterial's default depthWrite=true is preserved; depthTest=false
      // is the property that makes these read as command-overlay bars.
      depthWrite: true,
    });
    mat.customProgramCacheKey = () => (texture ? "overlay-textured-instanced-billboard" : "overlay-bar-instanced-billboard");
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aAlpha;\nvarying float vBarAlpha;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBarAlpha = aAlpha;")
        .replace(
          "#include <project_vertex>",
          `#ifdef USE_INSTANCING
vec4 mvPosition = modelViewMatrix * vec4( instanceMatrix[3].xyz, 1.0 );
mvPosition.xy += transformed.xy * vec2( length( instanceMatrix[0].xyz ), length( instanceMatrix[1].xyz ) );
gl_Position = projectionMatrix * mvPosition;
#else
#include <project_vertex>
#endif`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vBarAlpha;")
        .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a *= vBarAlpha;");
    };

    this.mesh = new THREE.InstancedMesh(geo, mat, this.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Overlay matrices always have the same sparse scale+translation shape.
    // Seed the invariant z-scale/homogeneous terms once; pushSprite then only
    // writes the five terms that actually vary (sx, sy, x, y, z).
    const initialMatrices = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.cap; i++) {
      initialMatrices[i * 16 + 10] = 1;
      initialMatrices[i * 16 + 15] = 1;
    }
    this.colorArr = new Float32Array(this.cap * 3);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArr, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = this.colorAttr;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.count = 0;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  begin() {
    this.count = 0;
  }

  pushSprite(s: THREE.Sprite, x: number, z: number, rotCos = 1, rotSin = 0) {
    if (!s.visible || this.count >= this.cap) return;
    const i = this.count++;
    const sx = s.scale.x;
    const sy = s.scale.y;
    if (sx <= 0 || sy <= 0) {
      this.count = i;
      return;
    }
    // Sprite local offsets live in the rotating entity root's XZ plane. Solid
    // bars are centered (offset zero), while group badges sit slightly left;
    // rotating that offset preserves the original parent-transform behavior.
    const lx = s.position.x;
    const lz = s.position.z;
    // Every overlay instance matrix is a pure scale + translation. The zero
    // basis terms and invariant z/homogeneous terms were seeded when the batch
    // was created, so only the five varying terms need to be written per bar.
    const out = this.mesh.instanceMatrix.array as Float32Array;
    const o16 = i * 16;
    out[o16] = sx;
    out[o16 + 5] = sy;
    if (lx === 0 && lz === 0) {
      // HP/fuel/ammo bars are centered; only group badges carry a lateral offset.
      out[o16 + 12] = x;
      out[o16 + 14] = z;
    } else {
      out[o16 + 12] = x + lx * rotCos + lz * rotSin;
      out[o16 + 14] = z - lx * rotSin + lz * rotCos;
    }
    out[o16 + 13] = s.position.y;
    const mat = s.material as THREE.SpriteMaterial;
    const c3 = i * 3;
    this.colorArr[c3] = mat.color.r;
    this.colorArr[c3 + 1] = mat.color.g;
    this.colorArr[c3 + 2] = mat.color.b;
    this.alphaArr[i] = mat.opacity;
  }

  commit() {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      // Only the dense prefix participates in this frame's draw. Range uploads
      // avoid re-uploading the 4096-instance cap for a few hundred live bars.
      unionAttributeUpdateRange(this.mesh.instanceMatrix, 0, this.count * 16, this.matrixUpdateRange);
      unionAttributeUpdateRange(this.alphaAttr, 0, this.count, this.alphaUpdateRange);
      unionAttributeUpdateRange(this.colorAttr, 0, this.count * 3, this.colorUpdateRange);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
    }
  }

  clear() {
    this.count = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }
}

export class Renderer {
  tracked = new Map<number, Tracked>();
  groupOf = new Map<number, number>(); // entId → control-group digit

  setGroups(groups: Map<number, Set<number>>) {
    this.groupOf.clear();
    for (const [n, ids] of groups) for (const id of ids) this.groupOf.set(id, n);
  }

  private bridgeMesh: THREE.InstancedMesh | null = null;
  private bridgeMat: THREE.MeshStandardMaterial | null = null;
  private bridgeKey = "";
  setBridges(tiles?: number[]) {
    const key = tiles?.length ? tiles.join(",") : "";
    if (key === this.bridgeKey) return;
    this.bridgeKey = key;
    if (this.bridgeMesh) {
      this.gs.scene.remove(this.bridgeMesh);
      this.bridgeMesh.geometry.dispose();
      this.bridgeMesh = null;
    }
    if (!tiles?.length) return;
    this.bridgeMat ??= new THREE.MeshStandardMaterial({ color: 0x9a7648, roughness: 0.85, metalness: 0.05 });
    const geo = new THREE.BoxGeometry(1.0, 0.14, 1.0);
    const im = new THREE.InstancedMesh(geo, this.bridgeMat, tiles.length);
    const d = new THREE.Object3D();
    const w = this.gs.mapW;
    for (let i = 0; i < tiles.length; i++) {
      d.position.set((tiles[i] % w) + 0.5, 0.1, Math.floor(tiles[i] / w) + 0.5);
      d.updateMatrix();
      im.setMatrixAt(i, d.matrix);
    }
    im.castShadow = im.receiveShadow = true;
    this.gs.scene.add(im);
    this.bridgeMesh = im;
  }
  crates = new Map<number, CrateSnap>();
  snaps: Snap[] = [];
  selection = new Set<number>();
  slotColors = new Map<number, string>();
  onOwnerLost?: (id: number) => void;

  private vfx: VfxSystem;
  private waypoints: WaypointOverlay;
  private overlayBars: OverlayBarBatch; // background planes (old renderOrder 20)
  private overlayBarFg: OverlayBarBatch; // foreground fill planes (old renderOrder 21)
  private overlayTextureBatches = new Map<THREE.Texture, OverlayBarBatch>();
  private crateVis = new Map<number, CrateVis>();
  private seen = new Set<number>();
  private hasInitialSnap = false;
  private swShakeTimers: ReturnType<typeof setTimeout>[] = [];
  private lastAllies?: Set<number>;
  private lastVisSlot = -1;
  private playerLowPower = new Map<number, boolean>();
  private hiddenEntityId: number | null = null;

  // Bound VFX emitter callbacks & scratch buffers (zero per-frame allocations)
  private readonly emitSmoke: (x: number, y: number, z: number, dark: boolean) => void;
  private readonly emitWake: (x: number, z: number, scale?: number) => void;
  private readonly emitDust: (x: number, z: number, scale?: number) => void;
  private readonly emitContrail: (x: number, y: number, z: number, scale?: number) => void;
  private readonly scratchVec = new THREE.Vector3();
  private readonly scratchPos = { x: 0, y: 0, d: 0 };
  private readonly scratchWin: { a: Snap | null; b: Snap | null; t: number } = { a: null, b: null, t: 0 };
  private readonly wpEntries: { x: number; y: number; wp: [number, number, OrderKind][] }[] = [];
  private readonly wpEntryPool: { x: number; y: number; wp: [number, number, OrderKind][] }[] = [];
  private readonly rallyEntries: { x: number; y: number; rx: number; ry: number }[] = [];
  private readonly rallyEntryPool: { x: number; y: number; rx: number; ry: number }[] = [];

  // Per-frame update culling & adaptive quality budgets
  private readonly frustum = new THREE.Frustum();
  private readonly frustumMat = new THREE.Matrix4();
  private readonly cullSphere = new THREE.Sphere();
  private frameIdx = 0;
  private vfxScale = 1;

  constructor(private gs: GameScene) {
    this.vfx = new VfxSystem(gs.scene);
    this.waypoints = new WaypointOverlay(gs.scene);
    this.overlayBars = new OverlayBarBatch(gs.scene, null, 20);
    // Sprite renderOrder separated all logistics foregrounds from backgrounds.
    // Keep that ordering exactly: two instanced draws still replace hundreds of
    // individual sprite draws, and overlapping bars cannot paint a later
    // background over an earlier foreground.
    this.overlayBarFg = new OverlayBarBatch(gs.scene, null, 21);
    this.emitSmoke = (x, y, z, dark) => {
      if (Math.random() <= this.vfxScale) this.vfx.spawnSmoke(x, y, z, dark);
    };
    this.emitWake = (x, z, scale) => {
      if (Math.random() <= this.vfxScale) this.vfx.spawnWake(x, z, scale);
    };
    this.emitDust = (x, z, scale) => {
      if (Math.random() <= this.vfxScale) this.vfx.spawnDust(x, z, scale);
    };
    this.emitContrail = (x, y, z, scale) => {
      if (Math.random() <= this.vfxScale) this.vfx.spawnContrail(x, y, z, scale);
    };

    // Boot warm-up: prebuild every vehicle instancing template+pool while the
    // menu is idle. First-contact frames otherwise pay template construction
    // (donor build + merge passes), VBO/IBO uploads AND first-use shader
    // compilation exactly when the battle starts — the classic RTS hitch.
    // Pools are keyed by kind only, so warming them costs the same memory as
    // building them lazily; nothing is duplicated. Shadow-proxy simplification
    // stays async internally and resolves on its own.
    const warmPools = () => {
      for (const kind of VEHICLE_INSTANCED_KINDS) {
        try {
          this.ensureVehiclePool(kind);
        } catch {
          // Opportunistic warm-up — the lazy first-use path remains as fallback.
        }
      }
    };
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
      .requestIdleCallback;
    if (ric) ric(warmPools, { timeout: 6000 });
    else setTimeout(warmPools, 2500);
  }

  setPlayerPower(players: Record<number, PlayerState>): void {
    this.playerLowPower.clear();
    for (const [key, p] of Object.entries(players)) {
      if (!p) continue;
      this.playerLowPower.set(p.slot ?? Number(key), Boolean(p.lowPower));
    }
  }

  private defenseRangesOn = false;

  // Coverage view while placing a defense: every own building with a range shows its ring
  setDefenseRangesVisible(v: boolean) {
    this.defenseRangesOn = v;
    for (const [id, t] of this.tracked) this.syncRangeRing(t, this.selection.has(id));
  }

  private syncRangeRing(t: Tracked, selected: boolean) {
    const bd = t.last && isBuildingKind(t.last.k) ? BUILDINGS[t.last.k as BuildingKind] : undefined;
    const range = bd?.range ?? 0;
    const show =
      range > 0 && (selected || (this.defenseRangesOn && (t.last.o === this.lastVisSlot || this.lastVisSlot < 0)));
    if (show && !t.rangeRing) {
      t.rangeRing = makeRangeRing(range);
      (t.vehInst ? t.vehInst.proxy : t.vis.root).add(t.rangeRing);
    }
    if (t.rangeRing) t.rangeRing.visible = show;
  }

  private disposeTracked(t: Tracked) {
    if (t.rangeRing) {
      t.rangeRing.geometry.dispose();
      (t.rangeRing.material as THREE.Material).dispose();
      t.rangeRing = null;
    }
    this.disposeVis(t.vis);
  }

  // ---------- Instanced swarm pools ----------
  private instPools = new Map<string, InstPool>();
  private instGroup: THREE.Group | null = null;

  private ensureInstPool(kind: EntKind, color: string): InstPool {
    // One pool per kind, not kind+player-color. Faction-accented parts use a
    // shared white material plus per-instance colors, so an 8-player infantry
    // battle no longer multiplies the whole 35-part soldier rig by 8.
    const key = kind;
    const existing = this.instPools.get(key);
    if (existing) return existing;
    if (!this.instGroup) {
      this.instGroup = new THREE.Group();
      this.instGroup.name = "instanced-swarms";
      this.gs.scene.add(this.instGroup);
    }
    // Harvest the authored model's mesh parts once; reuse for every instance.
    // donorMode bakes faction-accent verts white + variant-masked inside the
    // unified armor merge so per-instance accent colors can flow through the
    // aAccV0/1/2 instance attributes instead of fixed material colors.
    const probe = makeEntVis(kind, color, this.gs.scene, false, true);
    probe.root.updateMatrixWorld(true);
    const parts: InstPoolPart[] = [];
    probe.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.userData.isBar) return;
      const srcMat = o.material as THREE.Material;
      const unified = srcMat.userData?.unifiedArmorSingleton === true;
      const accentVariant = typeof srcMat.userData?.instAccentVariant === "number"
        ? (srcMat.userData.instAccentVariant as number)
        : undefined;
      const mat = accentVariant !== undefined ? getInstWhiteAccentMat(srcMat) : srcMat;
      const im = new THREE.InstancedMesh(o.geometry, mat, INSTANCE_CAP);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (accentVariant !== undefined || unified) {
        const colors = new Float32Array(INSTANCE_CAP * 3);
        colors.fill(1);
        im.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
        im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      if (unified) {
        // Per-instance final accent colors for the three variant shadings. The
        // vertex mask picks which (if any) of these tints each vertex reads.
        for (const attrName of ["aAccV0", "aAccV1", "aAccV2"]) {
          const arr = new Float32Array(INSTANCE_CAP * 3);
          arr.fill(1);
          const attr = new THREE.InstancedBufferAttribute(arr, 3);
          attr.setUsage(THREE.DynamicDrawUsage);
          im.geometry.setAttribute(attrName, attr);
        }
      }
      im.frustumCulled = false;
      im.castShadow = false;
      im.receiveShadow = false;
      _instM.makeScale(0, 0, 0);
      for (let i = 0; i < INSTANCE_CAP; i++) im.setMatrixAt(i, _instM);
      im.count = 0; // draw only live slots — never burn vertex work on empty ones
      this.instGroup!.add(im);
      parts.push({ im, local: o.matrixWorld.clone(), accentVariant });
    });
    const p: InstPool = { parts, owners: new Int32Array(INSTANCE_CAP).fill(-1), free: [], used: 0 };
    this.instPools.set(key, p);
    return p;
  }

  // Write the three per-variant faction accent colors into a unified armor
  // part's instance attributes (or white them out during hit flash — the flash
  // multiplication then reaches accent verts exactly like the old per-part
  // instanceColor flash did).
  private writeUnifiedAccentColors(im: THREE.InstancedMesh, idx: number, colorHex: string, suppress: boolean): void {
    for (let v = 0; v < 3; v++) {
      const attr = im.geometry.getAttribute(`aAccV${v}`) as THREE.InstancedBufferAttribute | undefined;
      if (!attr) continue;
      if (suppress) {
        attr.setXYZ(idx, 1, 1, 1);
      } else {
        const accent = getAccentMat(accentHexForVariant(colorHex, v)).color;
        attr.setXYZ(idx, accent.r, accent.g, accent.b);
      }
      attr.needsUpdate = true;
    }
  }

  private copyUnifiedAccentColors(im: THREE.InstancedMesh, fromIdx: number, toIdx: number): boolean {
    let touched = false;
    for (let v = 0; v < 3; v++) {
      const attr = im.geometry.getAttribute(`aAccV${v}`) as THREE.InstancedBufferAttribute | undefined;
      if (!attr) continue;
      attr.setXYZ(toIdx, attr.getX(fromIdx), attr.getY(fromIdx), attr.getZ(fromIdx));
      attr.needsUpdate = true;
      touched = true;
    }
    return touched;
  }

  private makeInstProxy(e: EntSnap): InstSlot | null {
    const colorHex = this.slotColors.get(e.o) ?? "#888888";
    const pool = this.ensureInstPool(e.k, colorHex);
    const idx = pool.free.length ? pool.free.pop()! : pool.used < INSTANCE_CAP ? pool.used++ : -1;
    if (idx < 0) return null;
    for (const part of pool.parts) {
      if (part.im.count < pool.used) part.im.count = pool.used;
      if (part.accentVariant !== undefined) {
        const accent = getAccentMat(accentHexForVariant(colorHex, part.accentVariant)).color;
        part.im.setColorAt(idx, accent);
        if (part.im.instanceColor) part.im.instanceColor.needsUpdate = true;
      }
      if ((part.im.material as THREE.Material).userData?.unifiedArmorSingleton === true) {
        this.writeUnifiedAccentColors(part.im, idx, colorHex, false);
        if (part.im.instanceColor) {
          part.im.setColorAt(idx, _instWhite);
          part.im.instanceColor.needsUpdate = true;
        }
      }
    }
    const proxy = new THREE.Group();
    proxy.position.set(e.x, 0, e.y);
    const pick = new THREE.Mesh(instPickGeo, instPickMat);
    pick.position.y = 0.45;
    pick.scale.setScalar(1.15);
    pick.layers.set(1); // raycast-only layer — the camera never draws it
    const ring = new THREE.Mesh(instSelGeo, instSelMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.055;
    ring.visible = false;
    proxy.add(pick, ring);
    tagEntity(proxy, e.id);
    pool.owners[idx] = e.id;
    return { pool, idx, proxy, ring, lx: NaN, ly: NaN, lyaw: NaN, lvis: false };
  }

  private freeInstance(slot: InstSlot) {
    const pool = slot.pool;
    const last = --pool.used;
    if (slot.idx !== last) {
      // swap-compact: move the last live instance into the freed slot so count stays tight
      const movedId = pool.owners[last];
      const movedT = movedId >= 0 ? this.tracked.get(movedId) : undefined;
      for (const part of pool.parts) {
        part.im.getMatrixAt(last, _instP);
        part.im.setMatrixAt(slot.idx, _instP);
        if (part.accentVariant !== undefined && part.im.instanceColor) {
          part.im.getColorAt(last, _instColor);
          part.im.setColorAt(slot.idx, _instColor);
          part.im.instanceColor.needsUpdate = true;
        }
        this.copyUnifiedAccentColors(part.im, last, slot.idx);
      }
      pool.owners[slot.idx] = movedId;
      if (movedT?.inst) movedT.inst.idx = slot.idx;
    }
    _instM.makeScale(0, 0, 0);
    for (const part of pool.parts) {
      part.im.setMatrixAt(last, _instM);
      part.im.count = last;
      part.im.instanceMatrix.needsUpdate = true;
    }
    pool.owners[last] = -1;
    // dense slots: `used` alone tracks free space — nothing goes on the free list
  }

  private writeInstance(t: Tracked) {
    const inst = t.inst!;
    const visible = t.vis.root.visible && t.last.id !== this.hiddenEntityId;
    if (inst.lx === t.visX && inst.ly === t.visY && inst.lyaw === t.visYaw && inst.lvis === visible) {
      inst.proxy.visible = t.vis.root.visible;
      return; // nothing changed — skip ~40 matrix writes + the full-buffer upload
    }
    inst.lx = t.visX;
    inst.ly = t.visY;
    inst.lyaw = t.visYaw;
    inst.lvis = visible;
    _instPos.set(t.visX, 0, t.visY);
    _instQ.setFromAxisAngle(_instUp, Math.PI / 2 - t.visYaw);
    _instM.compose(_instPos, _instQ, visible ? _instOne : _instZero);
    // Entity transforms are always yaw + uniform scale + translation. Exploit
    // that sparsity and write each instanceMatrix directly: 24 multiplies per
    // part instead of Matrix4.multiplyMatrices' generic 64, with no temp copy.
    // Verified element-for-element against three's column-major multiplication.
    const em = _instM.elements;
    const ea = em[0];
    const eb = em[2];
    const ec = em[5];
    const ed = em[8];
    const ef = em[10];
    const etx = em[12];
    const ety = em[13];
    const etz = em[14];
    const base = inst.idx * 16;
    for (const part of inst.pool.parts) {
      const lm = part.local.elements;
      const out = part.im.instanceMatrix.array as Float32Array;
      for (let col = 0; col < 3; col++) {
        const li = col * 4;
        const oi = base + li;
        const x = lm[li];
        const y = lm[li + 1];
        const z = lm[li + 2];
        out[oi] = ea * x + ed * z;
        out[oi + 1] = ec * y;
        out[oi + 2] = eb * x + ef * z;
        out[oi + 3] = 0;
      }
      const x = lm[12];
      const y = lm[13];
      const z = lm[14];
      out[base + 12] = ea * x + ed * z + etx;
      out[base + 13] = ec * y + ety;
      out[base + 14] = eb * x + ef * z + etz;
      out[base + 15] = 1;
      part.im.instanceMatrix.needsUpdate = true;
    }
    inst.proxy.position.set(t.visX, 0, t.visY);
    inst.proxy.rotation.y = Math.PI / 2 - t.visYaw;
    inst.proxy.visible = t.vis.root.visible;
    // vis.root isn't in the scene for instanced kinds but its position is the
    // canonical entity position for entScreenPos/badges — keep it live
    t.vis.root.position.set(t.visX, 0, t.visY);
  }

  // ---------- Instanced rigid-vehicle pools ----------
  private vehiclePools = new Map<string, VehicleInstPool>();
  private vehicleTemplates = new Map<EntKind, VehicleTemplate>();

  private getVehicleTemplate(kind: EntKind): VehicleTemplate {
    const cached = this.vehicleTemplates.get(kind);
    if (cached) return cached;

    // Build one fully-authored, fully-mergeStaticBody-collapsed donor rig. It is
    // never scene-added: geometries/materials become the shared instancing assets,
    // while the hierarchy tells us exactly which animated anchor owns each mesh.
    // donorMode: faction-accent verts bake white + variant-masked inside the
    // unified armor merge so per-instance aAccV0/1/2 attributes carry the exact
    // per-player tint (matching what accentVariant instance colors did before).
    const probe = makeEntVis(kind, "#ffffff", this.gs.scene, false, true);
    const rig = probe.rig;
    const body = rig.body;
    probe.root.updateMatrixWorld(true);

    const relMatrix = (ancestor: THREE.Object3D, obj: THREE.Object3D): THREE.Matrix4 =>
      new THREE.Matrix4().copy(ancestor.matrixWorld).invert().multiply(obj.matrixWorld);
    const atOrInside = (obj: THREE.Object3D, ancestor: THREE.Object3D): boolean => {
      for (let p: THREE.Object3D | null = obj; p; p = p.parent) if (p === ancestor) return true;
      return false;
    };
    const copyNode = (
      obj: THREE.Object3D,
      parentBase: "body" | "turret" | "spin" | "spin2",
      baseObj: THREE.Object3D,
    ): VehicleNodeSpec => {
      // A direct child of the animated base has an exactly-identity parentRel.
      // Construct it directly rather than round-tripping through matrixWorld
      // inversion (which both costs setup time and obscures the hot-loop fast path).
      const parentRel = !obj.parent || obj.parent === baseObj ? new THREE.Matrix4() : relMatrix(baseObj, obj.parent);
      const pe = parentRel.elements;
      const parentRelIdentity =
        pe[0] === 1 && pe[1] === 0 && pe[2] === 0 && pe[3] === 0 &&
        pe[4] === 0 && pe[5] === 1 && pe[6] === 0 && pe[7] === 0 &&
        pe[8] === 0 && pe[9] === 0 && pe[10] === 1 && pe[11] === 0 &&
        pe[12] === 0 && pe[13] === 0 && pe[14] === 0 && pe[15] === 1;
      return {
        position: obj.position.clone(),
        rotation: obj.rotation.clone(),
        scale: obj.scale.clone(),
        parentBase,
        parentRel,
        parentRelIdentity,
      };
    };

    const turretSpec = rig.turret ? copyNode(rig.turret, "body", body) : undefined;
    let recoilSpec: VehicleNodeSpec | undefined;
    if (rig.recoil) {
      const recoilInTurret = rig.turret && rig.recoil.parent ? atOrInside(rig.recoil.parent, rig.turret) : false;
      recoilSpec = recoilInTurret && rig.turret
        ? copyNode(rig.recoil, "turret", rig.turret)
        : copyNode(rig.recoil, "body", body);
    }
    const spinSpec = rig.spin ? copyNode(rig.spin, "body", body) : undefined;
    const spin2Spec = rig.spin2 ? copyNode(rig.spin2, "body", body) : undefined;
    const craneSpec = rig.crane ? copyNode(rig.crane, "body", body) : undefined;
    const flagSpec = rig.flag ? copyNode(rig.flag, "body", body) : undefined;

    // AC-130 port/starboard prop hubs rotate around their own axes. They are
    // children of the spin groups, but rotating the groups themselves would
    // swing the nacelles around the fuselage — so each hub becomes its own
    // composed child anchor. Other spinner models rotate the parent group and
    // deliberately stay on the cheaper fixed spin/spin2 anchors.
    const spinChildren: VehicleNodeSpec[] = [];
    const spin2Children: VehicleNodeSpec[] = [];
    const anchorObjects = new Map<VehicleAnchorKind, THREE.Object3D>();
    if (rig.turret) anchorObjects.set("turret", rig.turret);
    if (rig.recoil) anchorObjects.set("recoil", rig.recoil);
    if (rig.spin) anchorObjects.set("spin", rig.spin);
    if (rig.spin2) anchorObjects.set("spin2", rig.spin2);
    if (rig.crane) anchorObjects.set("crane", rig.crane);
    if (rig.flag) anchorObjects.set("flag", rig.flag);
    if (kind === "ac130") {
      if (rig.spin) {
        for (const child of rig.spin.children) {
          if (!(child instanceof THREE.Group)) continue;
          const key = `spinChild${spinChildren.length}`;
          anchorObjects.set(key, child);
          spinChildren.push(copyNode(child, "spin", rig.spin));
        }
      }
      if (rig.spin2) {
        for (const child of rig.spin2.children) {
          if (!(child instanceof THREE.Group)) continue;
          const key = `spin2Child${spin2Children.length}`;
          anchorObjects.set(key, child);
          spin2Children.push(copyNode(child, "spin2", rig.spin2));
        }
      }
    }

    const anchorObject = (anchor: VehicleAnchorKind): THREE.Object3D => anchorObjects.get(anchor) ?? body;
    const classify = (mesh: THREE.Mesh): VehicleAnchorKind => {
      // Include the mesh itself: building flags are simultaneously the animated
      // object and the visual part. Otherwise nearest animated ancestor wins.
      for (let p: THREE.Object3D | null = mesh; p && p !== body; p = p.parent) {
        for (const [key, obj] of anchorObjects) if (p === obj) return key;
      }
      return "body";
    };
    const childMeta = (anchor: VehicleAnchorKind): { childAnchor: 0 | 1 | 2; childIndex: number } => {
      if (anchor.startsWith("spinChild")) return { childAnchor: 1, childIndex: Number(anchor.slice(9)) || 0 };
      if (anchor.startsWith("spin2Child")) return { childAnchor: 2, childIndex: Number(anchor.slice(10)) || 0 };
      return { childAnchor: 0, childIndex: -1 };
    };

    const parts: VehiclePartDef[] = [];
    const donorProxyShadowParts: VehicleShadowPartDef[] = [];
    body.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o instanceof THREE.SkinnedMesh || !o.visible) return;
      const anchor = classify(o);
      if (o.userData.shadowProxy) {
        // Building donors carry already-consolidated position-only shadow blobs
        // in exact anchor space. Clone them into the template instead of either
        // instancing their invisible depth material in the main pass or letting
        // donor disposal/async simplification destroy the template geometry.
        const g = o.geometry.clone();
        g.computeBoundingSphere();
        g.computeBoundingBox();
        donorProxyShadowParts.push({ geometry: g, anchor, ...childMeta(anchor) });
        return;
      }
      const srcMat = o.material as THREE.Material;
      const accentVariant = typeof srcMat.userData?.instAccentVariant === "number"
        ? (srcMat.userData.instAccentVariant as number)
        : undefined;
      const baseScale = ((o.userData.baseScale as THREE.Vector3 | undefined) ?? o.scale).clone();
      const local = relMatrix(anchorObject(anchor), o);
      const le = local.elements;
      const basisIdentity =
        Math.abs(le[0] - 1) < 1e-8 && Math.abs(le[1]) < 1e-8 && Math.abs(le[2]) < 1e-8 &&
        Math.abs(le[4]) < 1e-8 && Math.abs(le[5] - 1) < 1e-8 && Math.abs(le[6]) < 1e-8 &&
        Math.abs(le[8]) < 1e-8 && Math.abs(le[9]) < 1e-8 && Math.abs(le[10] - 1) < 1e-8;
      const localPos = new THREE.Vector3(le[12], le[13], le[14]);
      parts.push({
        geometry: o.geometry,
        material: srcMat,
        local,
        localMode: !basisIdentity ? 2 : localPos.lengthSq() < 1e-12 ? 0 : 1,
        localPos,
        anchor,
        accentVariant,
        castShadow: o.castShadow,
        receiveShadow: o.receiveShadow,
        renderOrder: o.renderOrder,
        isBar: Boolean(o.userData.isBar),
        pulse: Boolean(rig.pulse?.includes(o)),
        bin: rig.bin === o,
        shadow: false,
        ...childMeta(anchor),
        baseScale,
      });
    });

    // Aircraft contact shadows live on the entity root, not inside rig.body, so
    // the body traversal never sees them. Harvest them as root-anchored parts;
    // their authored elliptical scale is preserved in `local` while anim.ts'
    // bob-driven breathing is applied as a per-instance XZ scale multiplier.
    if (rig.shadow && rig.shadow.visible) {
      const local = relMatrix(probe.root, rig.shadow);
      parts.push({
        geometry: rig.shadow.geometry,
        material: rig.shadow.material as THREE.Material,
        local,
        localMode: 2,
        localPos: new THREE.Vector3(local.elements[12], local.elements[13], local.elements[14]),
        anchor: "root",
        accentVariant: undefined,
        castShadow: false,
        receiveShadow: false,
        renderOrder: rig.shadow.renderOrder,
        isBar: true,
        pulse: false,
        bin: false,
        shadow: true,
        childAnchor: 0,
        childIndex: -1,
        baseScale: ((rig.shadow.userData.baseShadowScale as THREE.Vector3 | undefined) ?? rig.shadow.scale).clone(),
      });
    }

    // Depth-pass collapse: visual material/UV/color distinctions are irrelevant
    // to the shadow depth material. Bake every rigid caster in each articulated
    // anchor into one position-only geometry. Pulse/bin parts stay on their
    // original instanced meshes because their per-instance scale animation is
    // part of the authored silhouette; everything they do not cover keeps its
    // exact rigid transform and occlusion while costing one draw per anchor.
    const shadowParts: VehicleShadowPartDef[] = [];
    {
      const byAnchor = new Map<VehicleAnchorKind, VehiclePartDef[]>();
      for (const def of parts) {
        if (!def.castShadow || def.pulse || def.bin || def.isBar) continue;
        let g = byAnchor.get(def.anchor);
        if (!g) byAnchor.set(def.anchor, (g = []));
        g.push(def);
      }
      for (const [anchor, group] of byAnchor) {
        if (!group.length) continue;
        const geos = group.map((def) => vehicleShadowGeometry(def.geometry, def.local));
        const merged = mergeGeometries(geos, false);
        for (const g of geos) g.dispose();
        if (!merged) continue;
        merged.computeBoundingSphere();
        merged.computeBoundingBox();
        shadowParts.push({ geometry: merged, anchor, ...childMeta(anchor) });
        for (const def of group) def.shadowProxied = true;
      }
      // Building donors already did the expensive per-anchor shadow merge once;
      // reuse those blobs verbatim instead of reconstructing them from visual
      // casters whose castShadow flags were deliberately disabled by the proxy pass.
      shadowParts.push(...donorProxyShadowParts);
    }


    // Draw-call collapse pass for the instanced representation: anything sharing
    // (material, anchor, shadow flags, render order, tint variant) is baked into a
    // single geometry in anchor space. The donor build already merges what it can,
    // but rigidified spin children (harvester scoop wheels), multi-part recoil pods
    // and per-material one-off plates still arrive as separate instanced draws —
    // each costing a draw call in BOTH the main and shadow passes every frame.
    // Pulse/bin parts are excluded: their per-part scale animation is anchored at
    // each part's own origin, which a merged geometry could not reproduce.
    {
      // Loose parts (spin children — harvester scoop wheels etc.) never passed
      // through mergeStaticBody, so they still carry their original per-variant
      // armor/glow materials. Convert them here — donor-mode baking, same as the
      // body merge — so they join the unified singleton and collapse across
      // material variants instead of surviving as one instanced draw each.
      const convertLooseDef = (def: VehiclePartDef): VehiclePartDef => {
        const m = def.material;
        if (m.userData?.unifiedArmorSingleton === true || m.userData?.mergedGlowSingleton === true) return def;
        if (isUnifiedArmorEligible(m) && def.geometry.attributes.uv && def.geometry.attributes.normal) {
          const g2 = bakeUnifiedGeometry(def.geometry.clone(), m, def.accentVariant, true);
          return { ...def, geometry: g2, material: getUnifiedArmorMat(), accentVariant: undefined };
        }
        if (isMergedGlowEligible(m)) {
          const g2 = bakeGlowGeometry(def.geometry.clone(), m.color);
          return { ...def, geometry: g2, material: getMergedGlowMat(), accentVariant: undefined };
        }
        return def;
      };
      const groups = new Map<string, VehiclePartDef[]>();
      const keep: VehiclePartDef[] = [];
      for (const rawDef of parts) {
        const def = convertLooseDef(rawDef);
        if (def.pulse || def.bin) {
          keep.push(def);
          continue;
        }
        const attrSig = `${def.geometry.index ? 1 : 0}|${Object.keys(def.geometry.attributes).sort().join(",")}`;
        const key = [
          def.material.uuid,
          def.anchor,
          def.accentVariant ?? "-",
          def.castShadow && !def.shadowProxied ? 1 : 0,
          def.receiveShadow ? 1 : 0,
          def.renderOrder,
          def.isBar ? 1 : 0,
          attrSig,
        ].join("|");
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push(def);
      }
      const mergedParts: VehiclePartDef[] = [];
      for (const group of groups.values()) {
        if (group.length < 2) {
          mergedParts.push(group[0]);
          continue;
        }
        const geos: THREE.BufferGeometry[] = [];
        let ok = true;
        for (const def of group) {
          const g2 = def.geometry.clone();
          g2.applyMatrix4(def.local);
          geos.push(g2);
        }
        const merged = mergeGeometries(geos, false);
        for (const g of geos) g.dispose();
        if (!merged) {
          ok = false;
        }
        if (!ok || !merged) {
          mergedParts.push(...group);
          continue;
        }
        merged.computeBoundingSphere();
        merged.computeBoundingBox();
        const first = group[0];
        mergedParts.push({
          geometry: merged,
          material: first.material,
          local: new THREE.Matrix4(),
          localMode: 0,
          localPos: new THREE.Vector3(),
          anchor: first.anchor,
          accentVariant: first.accentVariant,
          castShadow: first.castShadow && !first.shadowProxied,
          receiveShadow: first.receiveShadow,
          renderOrder: first.renderOrder,
          isBar: first.isBar,
          pulse: false,
          bin: false,
          shadow: false,
          childAnchor: first.childAnchor,
          childIndex: first.childIndex,
          baseScale: new THREE.Vector3(1, 1, 1),
        });
      }
      parts.length = 0;
      parts.push(...mergedParts, ...keep);
    }

    const pickBox = new THREE.Box3().setFromObject(body);
    const pickSize = pickBox.getSize(new THREE.Vector3());
    const pickCenter = pickBox.getCenter(new THREE.Vector3());
    pickCenter.y = Math.max(0.48, pickCenter.y);
    const pickScale = new THREE.Vector3(
      Math.max(1.05, pickSize.x * 0.92),
      Math.max(0.82, pickSize.y + 0.24),
      Math.max(1.05, pickSize.z * 0.86),
    );

    const template: VehicleTemplate = {
      parts,
      shadowParts,
      rig: {
        bodyPosition: body.position.clone(),
        bodyRotation: body.rotation.clone(),
        bodyScale: body.scale.clone(),
        turret: turretSpec,
        recoil: recoilSpec,
        spin: spinSpec,
        spin2: spin2Spec,
        crane: craneSpec,
        flag: flagSpec,
        spinChildren,
        spin2Children,
        pulseScales: (rig.pulse ?? []).map((p) => ((p.userData.baseScale as THREE.Vector3 | undefined) ?? p.scale).clone()),
        binScale: rig.bin?.scale.clone(),
        shadowScale: rig.shadow ? ((rig.shadow.userData.baseShadowScale as THREE.Vector3 | undefined) ?? rig.shadow.scale).clone() : undefined,
        altitude: rig.altitude,
        smokePos: rig.smokePos?.clone(),
        pickCenter,
        pickScale,
        cullRadius: pickSize.length() * 0.55 + 0.55,
      },
    };
    // The donor's sprite/ring materials are per-build trash. Geometry and vehicle
    // materials stay alive through the template/pool references above. Submarine,
    // stealth and power-glow donors use per-build clones; mark the exact materials
    // the template retained so donor disposal cannot invalidate pool rendering.
    for (const def of template.parts) def.material.userData.rigidTemplateKeep = true;
    this.disposeVis(probe);
    this.vehicleTemplates.set(kind, template);
    return template;
  }

  private ensureVehiclePool(kind: EntKind): VehicleInstPool {
    const key = `veh:${kind}`;
    const existing = this.vehiclePools.get(key);
    if (existing) return existing;
    if (!this.instGroup) {
      this.instGroup = new THREE.Group();
      this.instGroup.name = "instanced-swarms";
      this.gs.scene.add(this.instGroup);
    }
    const template = this.getVehicleTemplate(kind);
    const cap = isBuildingKind(kind) ? BUILDING_INSTANCE_CAP : VEHICLE_INSTANCE_CAP;
    const parts: VehicleInstPart[] = [];
    for (const def of template.parts) {
      const unified = def.material.userData?.unifiedArmorSingleton === true;
      const mat = def.accentVariant !== undefined ? getInstWhiteAccentMat(def.material) : def.material;
      const im = new THREE.InstancedMesh(def.geometry, mat, cap);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const colors = new Float32Array(cap * 3);
      colors.fill(1);
      im.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      if (unified) {
        // Per-instance final accent colors for the three variant shadings. The
        // baked vertex mask (aAccent) picks which of these tints a vertex reads;
        // non-accent verts use none of them.
        for (const attrName of ["aAccV0", "aAccV1", "aAccV2"]) {
          const arr = new Float32Array(cap * 3);
          arr.fill(1);
          const attr = new THREE.InstancedBufferAttribute(arr, 3);
          attr.setUsage(THREE.DynamicDrawUsage);
          im.geometry.setAttribute(attrName, attr);
        }
      }
      im.frustumCulled = true;
      im.castShadow = def.castShadow && !def.shadowProxied;
      im.receiveShadow = def.receiveShadow;
      im.renderOrder = def.renderOrder;
      _instM.makeScale(0, 0, 0);
      for (let i = 0; i < cap; i++) im.setMatrixAt(i, _instM);
      im.count = 0;
      this.instGroup.add(im);
      parts.push({ im, def, matrixMinSlot: Infinity, matrixMaxSlot: -1, matrixUpdateRange: { start: 0, count: 0 } });
    }
    const shadowParts: VehicleShadowInstPart[] = [];
    for (const def of template.shadowParts) {
      const im = new THREE.InstancedMesh(def.geometry, vehShadowProxyMat, cap);
      im.name = "vehicle-shadow-proxy";
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = true;
      im.castShadow = true;
      im.receiveShadow = false;
      im.layers.set(SHADOW_PROXY_LAYER);
      im.raycast = () => {};
      _instM.makeScale(0, 0, 0);
      for (let i = 0; i < cap; i++) im.setMatrixAt(i, _instM);
      im.count = 0;
      simplifyShadowProxyGeometry(im, (geometry) => {
        def.geometry = geometry;
      });
      this.instGroup.add(im);
      shadowParts.push({ im, def, matrixMinSlot: Infinity, matrixMaxSlot: -1, matrixUpdateRange: { start: 0, count: 0 } });
    }
    const pool: VehicleInstPool = {
      template,
      parts,
      shadowParts,
      owners: new Int32Array(cap).fill(-1),
      used: 0,
      cap,
      bounds: new THREE.Sphere(new THREE.Vector3(), 0),
      boundsFrame: -1,
    };
    for (const part of parts) part.im.boundingSphere = pool.bounds;
    for (const part of shadowParts) part.im.boundingSphere = pool.bounds;
    this.vehiclePools.set(key, pool);
    return pool;
  }

  private reserveVehicleInstance(e: EntSnap): VehicleReservation | null {
    const colorHex = this.slotColors.get(e.o) ?? "#888888";
    const pool = this.ensureVehiclePool(e.k);
    const idx = pool.used < pool.cap ? pool.used++ : -1;
    if (idx < 0) return null;
    for (const part of pool.parts) if (part.im.count < pool.used) part.im.count = pool.used;
    for (const part of pool.shadowParts) if (part.im.count < pool.used) part.im.count = pool.used;
    pool.owners[idx] = e.id;
    return { pool, idx, colorHex };
  }

  private applyVehicleRigSpec(vis: EntVis, spec: VehicleRigSpec): void {
    const rig = vis.rig;
    rig.body.position.copy(spec.bodyPosition);
    rig.body.rotation.copy(spec.bodyRotation);
    rig.body.scale.copy(spec.bodyScale);
    const copyNode = (specNode: VehicleNodeSpec): THREE.Group => {
      const g = new THREE.Group();
      g.position.copy(specNode.position);
      g.rotation.copy(specNode.rotation);
      g.scale.copy(specNode.scale);
      return g;
    };
    if (spec.turret) {
      rig.turret = copyNode(spec.turret);
      vis.turret = rig.turret;
    }
    if (spec.recoil) rig.recoil = copyNode(spec.recoil);
    if (spec.spin) {
      rig.spin = copyNode(spec.spin);
      vis.spin = rig.spin;
      // Child hubs are deliberately parented to the lightweight spinner group:
      // AC-130 animation enumerates spin.children and rotates each hub around
      // its own axis, exactly matching the authored model hierarchy.
      for (const childSpec of spec.spinChildren.slice(0, MAX_SPIN_CHILD_ANCHORS)) rig.spin.add(copyNode(childSpec));
    }
    if (spec.spin2) {
      rig.spin2 = copyNode(spec.spin2);
      for (const childSpec of spec.spin2Children.slice(0, MAX_SPIN_CHILD_ANCHORS)) rig.spin2.add(copyNode(childSpec));
    }
    if (spec.crane) rig.crane = copyNode(spec.crane);
    if (spec.flag) {
      const m = new THREE.Mesh(vehRigDummyGeo, vehRigDummyMat);
      m.position.copy(spec.flag.position);
      m.rotation.copy(spec.flag.rotation);
      m.scale.copy(spec.flag.scale);
      rig.flag = m;
    }
    if (spec.altitude !== undefined) rig.altitude = spec.altitude;
    if (spec.shadowScale) {
      const m = new THREE.Mesh(vehRigDummyGeo, vehRigDummyMat);
      m.scale.copy(spec.shadowScale);
      m.userData.baseShadowScale = spec.shadowScale.clone();
      rig.shadow = m;
    }
    if (spec.pulseScales.length) {
      rig.pulse = spec.pulseScales.map((base) => {
        // Lightweight animation-state stand-ins. They are never scene-added; only
        // their scale is consumed when composing the pulsing glow instance matrix.
        const m = new THREE.Mesh(vehRigDummyGeo, vehRigDummyMat);
        m.scale.copy(base);
        m.userData.baseScale = base.clone();
        return m;
      });
    }
    if (spec.binScale) {
      const m = new THREE.Mesh(vehRigDummyGeo, vehRigDummyMat);
      m.scale.copy(spec.binScale);
      rig.bin = m;
      vis.bin = m;
    }
    if (spec.smokePos) rig.smokePos = spec.smokePos.clone();
  }

  private writeVehicleColors(slot: VehicleInstSlot): void {
    for (const part of slot.pool.parts) {
      const def = part.def;
      const unified = (part.im.material as THREE.Material).userData?.unifiedArmorSingleton === true;
      if (slot.flash && !def.isBar) {
        part.im.setColorAt(slot.idx, _vehFlashColor);
      } else if (unified) {
        // Unified parts carry their faction tint in the aAccV* attributes; the
        // instanceColor channel is reserved for the hit-flash multiplication.
        part.im.setColorAt(slot.idx, _instWhite);
      } else if (def.accentVariant !== undefined) {
        const accent = getAccentMat(accentHexForVariant(slot.accentHex, def.accentVariant)).color;
        part.im.setColorAt(slot.idx, accent);
      } else {
        part.im.setColorAt(slot.idx, _instWhite);
      }
      if (part.im.instanceColor) {
        part.im.instanceColor.addUpdateRange(slot.idx * 3, 3);
        part.im.instanceColor.needsUpdate = true;
      }
      if (unified) {
        // Flash suppresses the accent tint so the flash multiplication reaches
        // accent verts exactly like the pre-unification per-part instanceColor
        // flash did; otherwise each variant channel gets its final faction color.
        this.writeUnifiedAccentColors(part.im, slot.idx, slot.accentHex, slot.flash && !def.isBar);
      }
    }
  }

  private setVehicleFlash(slot: VehicleInstSlot, flash: boolean): void {
    if (slot.flash === flash) return;
    slot.flash = flash;
    this.writeVehicleColors(slot);
  }

  private makeVehicleInstProxy(e: EntSnap, vis: EntVis, reservation: VehicleReservation, applySpec = true): VehicleInstSlot {
    const { pool, idx, colorHex } = reservation;
    // Lite vehicle rigs need reconstructed animation stand-ins. Buildings and
    // alpha-capable stealth units keep their full rig while migrated, preserving
    // power-glow materials and in-flight subAlpha/subY state exactly.
    if (applySpec) this.applyVehicleRigSpec(vis, pool.template.rig);
    const proxy = new THREE.Group();
    proxy.position.set(e.x, 0, e.y);
    const pick = new THREE.Mesh(instPickGeo, instPickMat);
    pick.position.copy(pool.template.rig.pickCenter);
    pick.scale.copy(pool.template.rig.pickScale);
    pick.layers.set(1); // raycast-only layer — the camera never draws it
    const ring = new THREE.Mesh(instSelGeo, instSelMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.055;
    // instSelGeo is 62% the authored selection-ring radius; scale it back up so
    // vehicle selection rings keep their kind-specific sizes exactly.
    ring.scale.setScalar(Math.max(0.5, vis.ring.scale.x / 0.62));
    ring.visible = false;
    proxy.add(pick, ring);
    tagEntity(proxy, e.id);
    const slot: VehicleInstSlot = {
      pool,
      idx,
      proxy,
      ring,
      accentHex: colorHex,
      flash: false,
      lvis: false,
      sigX: NaN,
      sigY: NaN,
      sigYaw: NaN,
      sigBody: NaN,
      sigTurret: NaN,
      sigRecoil: NaN,
      sigSpin: NaN,
      sigSpin2: NaN,
      sigCrane: NaN,
      sigFlag: NaN,
      sigPulse: NaN,
      sigBin: NaN,
      sigShadowX: NaN,
      sigShadowZ: NaN,
      sigSpinKids: [],
      sigSpin2Kids: [],
    };
    this.writeVehicleColors(slot);
    return slot;
  }

  private markVehicleMatrixDirty(part: VehicleMatrixDirtyState, idx: number): void {
    if (idx < part.matrixMinSlot) part.matrixMinSlot = idx;
    if (idx > part.matrixMaxSlot) part.matrixMaxSlot = idx;
  }

  private flushVehicleMatrixPart(part: VehicleMatrixDirtyState & { im: THREE.InstancedMesh }): void {
    if (part.matrixMaxSlot < 0) return;
    const start = part.matrixMinSlot * 16;
    const count = (part.matrixMaxSlot - part.matrixMinSlot + 1) * 16;
    unionAttributeUpdateRange(part.im.instanceMatrix, start, count, part.matrixUpdateRange);
    part.im.instanceMatrix.needsUpdate = true;
    part.matrixMinSlot = Infinity;
    part.matrixMaxSlot = -1;
  }

  // Upload markings are deliberately deferred out of the per-entity fan-out.
  // A kind pool has only a handful of parts, while hundreds of vehicles may write
  // those same parts; coalescing here turns thousands of per-frame update-range
  // allocations into at most one dirty span per part.
  private flushVehicleInstanceMatrices(): void {
    for (const pool of this.vehiclePools.values()) {
      for (const part of pool.parts) this.flushVehicleMatrixPart(part);
      for (const part of pool.shadowParts) this.flushVehicleMatrixPart(part);
    }
  }

  private freeVehicleInstance(slot: VehicleInstSlot): void {
    const pool = slot.pool;
    const last = --pool.used;
    if (slot.idx !== last) {
      const movedId = pool.owners[last];
      const movedT = movedId >= 0 ? this.tracked.get(movedId) : undefined;
      for (const part of pool.parts) {
        part.im.getMatrixAt(last, _instP);
        part.im.setMatrixAt(slot.idx, _instP);
        this.markVehicleMatrixDirty(part, slot.idx);
        if (part.im.instanceColor) {
          part.im.getColorAt(last, _instColor);
          part.im.setColorAt(slot.idx, _instColor);
          part.im.instanceColor.needsUpdate = true;
        }
        this.copyUnifiedAccentColors(part.im, last, slot.idx);
      }
      for (const part of pool.shadowParts) {
        part.im.getMatrixAt(last, _instP);
        part.im.setMatrixAt(slot.idx, _instP);
        this.markVehicleMatrixDirty(part, slot.idx);
      }
      pool.owners[slot.idx] = movedId;
      if (movedT?.vehInst) movedT.vehInst.idx = slot.idx;
    }
    // The vacated tail slot is outside the draw count immediately, so zeroing
    // and re-uploading it is wasted work even before considering combat death
    // spikes. If the slot is reused later, the owning entity's normal matrix
    // write (or hide transition) fully initializes it before it can be drawn.
    for (const part of pool.parts) part.im.count = last;
    for (const part of pool.shadowParts) part.im.count = last;
    pool.owners[last] = -1;
  }

  private rigidInstanceWanted(t: Tracked): boolean {
    const kind = t.last.k;
    const supported = VEHICLE_INSTANCED_KINDS.has(kind) || BUILDING_INSTANCED_KINDS.has(kind);
    if (!supported) return false;
    if (t.isBuilding) {
      // Construction growth and holographic preview are whole-rig transform /
      // material transitions. Keep the legacy mesh until both have settled, and
      // fall back while low-power emissive dimming needs per-mesh cloned colors.
      if (t.anim.buildAge < 1 || t.anim.matMode === "holo" || t.lastLowPower) return false;
    }
    if ((kind === "sub" || kind === "stealthbomber") && (t.anim.subAlpha <= 0.985 || t.anim.subY < -0.001)) return false;
    return true;
  }

  // Rigid instancing is migratory rather than all-or-nothing. The full visual is
  // retained offscene while instanced, so transitioning out (submarine dive,
  // stealth cloak, low power) resumes with exactly the same articulated/material
  // state instead of reconstructing a rig mid-animation.
  private syncRigidInstancing(t: Tracked): void {
    const kind = t.last.k;
    const supported = VEHICLE_INSTANCED_KINDS.has(kind) || BUILDING_INSTANCED_KINDS.has(kind);
    if (!supported) return;
    const want = this.rigidInstanceWanted(t);
    if (want && !t.vehInst) {
      const reservation = this.reserveVehicleInstance(t.last);
      if (!reservation) return;
      const keepFullRig = t.isBuilding || kind === "sub" || kind === "stealthbomber";
      const slot = this.makeVehicleInstProxy(t.last, t.vis, reservation, !keepFullRig);
      t.vehInst = slot;
      this.gs.scene.add(slot.proxy);
      this.gs.scene.remove(t.vis.root);
      const pi = this.gs.pickables.indexOf(t.vis.root);
      if (pi >= 0) this.gs.pickables.splice(pi, 1);
      if (!this.gs.pickables.includes(slot.proxy)) this.gs.pickables.push(slot.proxy);
      if (t.supplyAura && t.supplyAura.parent !== slot.proxy) {
        t.supplyAura.parent?.remove(t.supplyAura);
        slot.proxy.add(t.supplyAura);
      }
      if (t.rangeRing && t.rangeRing.parent !== slot.proxy) {
        t.rangeRing.parent?.remove(t.rangeRing);
        slot.proxy.add(t.rangeRing);
      }
      slot.lvis = false;
      slot.sigX = NaN;
      slot.sigY = NaN;
      slot.sigYaw = NaN;
    } else if (!want && t.vehInst) {
      const slot = t.vehInst;
      this.freeVehicleInstance(slot);
      this.gs.scene.remove(slot.proxy);
      const pi = this.gs.pickables.indexOf(slot.proxy);
      if (pi >= 0) this.gs.pickables.splice(pi, 1);
      t.vehInst = undefined;
      if (!t.vis.root.parent) this.gs.scene.add(t.vis.root);
      if (!this.gs.pickables.includes(t.vis.root)) this.gs.pickables.push(t.vis.root);
      if (t.supplyAura && t.supplyAura.parent !== t.vis.root) {
        t.supplyAura.parent?.remove(t.supplyAura);
        t.vis.root.add(t.supplyAura);
      }
      if (t.rangeRing && t.rangeRing.parent !== t.vis.root) {
        t.rangeRing.parent?.remove(t.rangeRing);
        t.vis.root.add(t.rangeRing);
      }
    }
  }

  private writeVehicleInstance(t: Tracked): void {
    const slot = t.vehInst!;
    const pool = slot.pool;
    const visible = t.vis.root.visible && t.last.id !== this.hiddenEntityId;
    // Buildings never apply server facing to their root in the legacy scene path;
    // only their turret animation consumes heading. Preserve that exactly while
    // mobile rigid units continue to yaw the whole hull.
    const entityYaw = t.isBuilding ? 0 : t.visYaw;
    const rootRotY = t.isBuilding ? 0 : Math.PI / 2 - entityYaw;
    slot.proxy.position.set(t.visX, 0, t.visY);
    slot.proxy.rotation.y = rootRotY;
    slot.proxy.visible = visible;
    t.vis.root.position.set(t.visX, 0, t.visY);
    t.vis.root.rotation.y = rootRotY;

    const wasVisible = slot.lvis;
    if (!visible) {
      if (wasVisible) {
        _instM.makeScale(0, 0, 0);
        for (const part of pool.parts) {
          part.im.setMatrixAt(slot.idx, _instM);
          this.markVehicleMatrixDirty(part, slot.idx);
        }
        for (const part of pool.shadowParts) {
          part.im.setMatrixAt(slot.idx, _instM);
          this.markVehicleMatrixDirty(part, slot.idx);
        }
      }
      slot.lvis = false;
      return;
    }
    slot.lvis = true;
    this.setVehicleFlash(slot, t.anim.hitFlash > 0 || t.anim.matMode === "hit");

    const rig = t.vis.rig;
    const spec = pool.template.rig;

    // All pulse meshes use the same time-varying multiplier in stepEntityAnim;
    // read it back from the first lightweight stand-in rather than duplicating
    // the animation curve here. Cargo bin scale.y is entity-specific.
    let pulseScale = 1;
    const pulse0 = rig.pulse?.[0];
    if (pulse0) {
      const base = pulse0.userData.baseScale as THREE.Vector3 | undefined;
      if (base && Math.abs(base.x) > 1e-6) pulseScale = pulse0.scale.x / base.x;
    }
    const binScaleY = rig.bin && spec.binScale && Math.abs(spec.binScale.y) > 1e-6
      ? rig.bin.scale.y / spec.binScale.y
      : 1;
    const shadowScaleX = rig.shadow && spec.shadowScale && Math.abs(spec.shadowScale.x) > 1e-6
      ? rig.shadow.scale.x / spec.shadowScale.x
      : 1;
    const shadowScaleZ = rig.shadow && spec.shadowScale && Math.abs(spec.shadowScale.z) > 1e-6
      ? rig.shadow.scale.z / spec.shadowScale.z
      : 1;

    // Idle fast-path: skip the entire fan-out for parts that cannot have moved
    // enough to affect a pixel. Rigid parts depend only on the anchor chain and
    // entity transform. Parked vehicles still have a tiny sinusoidal idle hum
    // (±0.005 tiles in body.y), which made exact fingerprints differ forever;
    // once the suspension/recoil state has settled, tolerate that subpixel hum
    // against the last matrix actually written. The weighted-signature range is
    // about 0.052 peak-to-peak, so 0.08 is conservative hysteresis rather than a
    // quantization snap. Moving/firing entities keep exact comparisons.
    const bodySig = rig.body.rotation.x * 7.13 + rig.body.rotation.y * 3.71 + rig.body.rotation.z * 1.97 + rig.body.position.y * 5.23;
    const turretSig = rig.turret ? rig.turret.rotation.y + rig.turret.rotation.x * 2.1 + rig.turret.rotation.z * 4.3 : 0;
    const recoilSig = rig.recoil ? rig.recoil.position.z + rig.recoil.position.x * 2.7 + rig.recoil.rotation.x * 1.3 : 0;
    const spinSig = rig.spin ? rig.spin.rotation.x * 3.1 + rig.spin.rotation.y * 1.9 + rig.spin.rotation.z * 5.7 : 0;
    const spin2Sig = rig.spin2 ? rig.spin2.rotation.x * 2.9 + rig.spin2.rotation.y * 2.3 + rig.spin2.rotation.z * 4.9 : 0;
    const craneSig = rig.crane
      ? rig.crane.position.x * 1.7 + rig.crane.position.z * 2.3 + rig.crane.rotation.x * 3.9 + rig.crane.rotation.y * 2.1 + rig.crane.rotation.z * 1.3
      : 0;
    const flagSig = rig.flag ? rig.flag.rotation.x * 2.7 + rig.flag.rotation.y * 5.1 + rig.flag.rotation.z * 1.9 : 0;
    const spinKidSig = (kids: THREE.Object3D[] | undefined, store: number[]): boolean => {
      if (!kids?.length) return store.length !== 0;
      if (store.length !== kids.length) return true;
      for (let i = 0; i < kids.length; i++) {
        const sig = kids[i].rotation.x * 3.7 + kids[i].rotation.y * 2.3 + kids[i].rotation.z * 5.9;
        if (store[i] !== sig) return true;
      }
      return false;
    };
    const spinKids = spec.spinChildren.length && rig.spin ? rig.spin.children : undefined;
    const spin2Kids = spec.spin2Children.length && rig.spin2 ? rig.spin2.children : undefined;
    const spinKidsDirty = spinKidSig(spinKids, slot.sigSpinKids);
    const spin2KidsDirty = spinKidSig(spin2Kids, slot.sigSpin2Kids);
    const settled =
      t.anim.moveBlend < 0.03 &&
      t.anim.speed < 0.2 &&
      t.anim.recoil <= 0 &&
      t.anim.hullKick <= 0;
    const bodySame =
      slot.sigBody === bodySig ||
      (settled && Math.abs(slot.sigBody - bodySig) <= 0.08);
    // Turret yaw uses exponential asymptotic smoothing, so exact fingerprints
    // would rewrite forever even after the barrel is visually at rest. The same
    // last-written-pose hysteresis applies here; 0.002 weighted units is below
    // a quarter pixel at the barrel tip in the closest RTS zoom.
    const turretSame =
      slot.sigTurret === turretSig ||
      (settled && Math.abs(slot.sigTurret - turretSig) <= 0.002);
    const rootDirty = !(wasVisible && slot.sigX === t.visX && slot.sigY === t.visY && slot.sigYaw === rootRotY);
    const bodyChainDirty = rootDirty || !bodySame;
    const turretChainDirty = bodyChainDirty || !turretSame;
    const recoilUsesTurret = spec.recoil?.parentBase === "turret" && !!(rig.turret && spec.turret);
    const recoilChainDirty =
      (recoilUsesTurret ? turretChainDirty : bodyChainDirty) ||
      slot.sigRecoil !== recoilSig;
    const spinChainDirty = bodyChainDirty || slot.sigSpin !== spinSig;
    const spin2ChainDirty = bodyChainDirty || slot.sigSpin2 !== spin2Sig;
    const craneChainDirty = bodyChainDirty || slot.sigCrane !== craneSig;
    const flagChainDirty = bodyChainDirty || slot.sigFlag !== flagSig;
    const spinChildChainDirty = spinChainDirty || spinKidsDirty;
    const spin2ChildChainDirty = spin2ChainDirty || spin2KidsDirty;
    const anyChainDirty =
      bodyChainDirty ||
      turretChainDirty ||
      recoilChainDirty ||
      spinChainDirty ||
      spin2ChainDirty ||
      craneChainDirty ||
      flagChainDirty ||
      spinChildChainDirty ||
      spin2ChildChainDirty;
    // Pulse/bin/contact-shadow parts rewrite only when their scale factors
    // actually changed; rigid parts independently follow their anchor dirty bit.
    const pulseDirty =
      !wasVisible ||
      pulseScale !== slot.sigPulse ||
      binScaleY !== slot.sigBin ||
      shadowScaleX !== slot.sigShadowX ||
      shadowScaleZ !== slot.sigShadowZ;
    // Maintain one conservative pool sphere in world space (instGroup itself is
    // identity). This is deliberately cheap online sphere union work, not a full
    // InstancedMesh.computeBoundingSphere() pass over every part every frame.
    const entityRadius = Math.max(spec.cullRadius, t.cullR);
    if (pool.boundsFrame !== this.frameIdx) {
      pool.boundsFrame = this.frameIdx;
      pool.bounds.center.set(t.visX, t.cullY, t.visY);
      pool.bounds.radius = entityRadius;
    } else {
      const dx = t.visX - pool.bounds.center.x;
      const dy = t.cullY - pool.bounds.center.y;
      const dz = t.visY - pool.bounds.center.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const slack = pool.bounds.radius - entityRadius;
      if (distSq > slack * slack) {
        const dist = Math.sqrt(distSq);
        const needed = dist + entityRadius;
        if (needed > pool.bounds.radius && dist > 1e-6) {
          const newRadius = (pool.bounds.radius + needed) * 0.5;
          const shift = (newRadius - pool.bounds.radius) / dist;
          pool.bounds.center.x += dx * shift;
          pool.bounds.center.y += dy * shift;
          pool.bounds.center.z += dz * shift;
          pool.bounds.radius = newRadius;
        }
      }
    }
    if (!anyChainDirty && !pulseDirty) {
      // Absolutely nothing animated, so every matrix is already correct in the
      // instance buffers. Bounds maintenance above still saw the entity: pool
      // membership can change even when every surviving vehicle is stationary.
      return;
    }

    rig.body.updateMatrix();
    _instPos.set(t.visX, 0, t.visY);
    _instQ.setFromAxisAngle(_instUp, rootRotY);
    _vehRootM.compose(_instPos, _instQ, _instOne);
    _vehBodyM.multiplyMatrices(_vehRootM, rig.body.matrix);

    let hasTurret = false;
    if (rig.turret && spec.turret) {
      composeVehicleNodeMatrix(rig.turret, spec.turret, _vehBodyM, _vehTurretM);
      hasTurret = true;
    }
    let hasRecoil = false;
    if (rig.recoil && spec.recoil) {
      composeVehicleNodeMatrix(
        rig.recoil,
        spec.recoil,
        spec.recoil.parentBase === "turret" && hasTurret ? _vehTurretM : _vehBodyM,
        _vehRecoilM,
      );
      hasRecoil = true;
    }
    let hasSpin = false;
    if (rig.spin && spec.spin) {
      composeVehicleNodeMatrix(rig.spin, spec.spin, _vehBodyM, _vehSpinM);
      hasSpin = true;
    }
    let hasSpin2 = false;
    if (rig.spin2 && spec.spin2) {
      composeVehicleNodeMatrix(rig.spin2, spec.spin2, _vehBodyM, _vehSpin2M);
      hasSpin2 = true;
    }
    let hasCrane = false;
    if (rig.crane && spec.crane) {
      composeVehicleNodeMatrix(rig.crane, spec.crane, _vehBodyM, _vehCraneM);
      hasCrane = true;
    }
    let hasFlag = false;
    if (rig.flag && spec.flag) {
      composeVehicleNodeMatrix(rig.flag, spec.flag, _vehBodyM, _vehFlagM);
      hasFlag = true;
    }
    const hasSpinKids = hasSpin && spec.spinChildren.length > 0 && rig.spin!.children.length > 0;
    if (hasSpinKids) {
      for (let i = 0; i < Math.min(spec.spinChildren.length, rig.spin!.children.length, MAX_SPIN_CHILD_ANCHORS); i++) {
        composeVehicleNodeMatrix(rig.spin!.children[i], spec.spinChildren[i], _vehSpinM, _vehSpinChildM[i]);
      }
    }
    const hasSpin2Kids = hasSpin2 && spec.spin2Children.length > 0 && rig.spin2!.children.length > 0;
    if (hasSpin2Kids) {
      for (let i = 0; i < Math.min(spec.spin2Children.length, rig.spin2!.children.length, MAX_SPIN_CHILD_ANCHORS); i++) {
        composeVehicleNodeMatrix(rig.spin2!.children[i], spec.spin2Children[i], _vehSpin2M, _vehSpin2ChildM[i]);
      }
    }

    // These signatures describe the matrices written below. In particular the
    // settled-body/turret tolerances must keep referring to the last written pose;
    // updating them on skipped frames would let the pose drift by accumulation.
    if (bodyChainDirty) {
      slot.sigX = t.visX;
      slot.sigY = t.visY;
      slot.sigYaw = rootRotY;
      slot.sigBody = bodySig;
    }
    if (turretChainDirty) slot.sigTurret = turretSig;
    if (recoilChainDirty) slot.sigRecoil = recoilSig;
    if (spinChainDirty) slot.sigSpin = spinSig;
    if (spin2ChainDirty) slot.sigSpin2 = spin2Sig;
    if (craneChainDirty) slot.sigCrane = craneSig;
    if (flagChainDirty) slot.sigFlag = flagSig;
    if (spinChildChainDirty && spinKids) {
      slot.sigSpinKids.length = spinKids.length;
      for (let i = 0; i < spinKids.length; i++) {
        slot.sigSpinKids[i] = spinKids[i].rotation.x * 3.7 + spinKids[i].rotation.y * 2.3 + spinKids[i].rotation.z * 5.9;
      }
    }
    if (spin2ChildChainDirty && spin2Kids) {
      slot.sigSpin2Kids.length = spin2Kids.length;
      for (let i = 0; i < spin2Kids.length; i++) {
        slot.sigSpin2Kids[i] = spin2Kids[i].rotation.x * 3.7 + spin2Kids[i].rotation.y * 2.3 + spin2Kids[i].rotation.z * 5.9;
      }
    }
    slot.sigPulse = pulseScale;
    slot.sigBin = binScaleY;
    slot.sigShadowX = shadowScaleX;
    slot.sigShadowZ = shadowScaleZ;

    const base16 = slot.idx * 16;
    for (const part of pool.parts) {
      const def = part.def;
      const animated = def.pulse || def.bin || def.shadow;
      let anchorM = _vehBodyM;
      let anchorDirty = bodyChainDirty;
      if (def.childAnchor === 1 && hasSpinKids && def.childIndex < MAX_SPIN_CHILD_ANCHORS) {
        anchorM = _vehSpinChildM[def.childIndex];
        anchorDirty = spinChildChainDirty;
      } else if (def.childAnchor === 2 && hasSpin2Kids && def.childIndex < MAX_SPIN_CHILD_ANCHORS) {
        anchorM = _vehSpin2ChildM[def.childIndex];
        anchorDirty = spin2ChildChainDirty;
      } else if (def.anchor === "turret" && hasTurret) {
        anchorM = _vehTurretM;
        anchorDirty = turretChainDirty;
      } else if (def.anchor === "recoil" && hasRecoil) {
        anchorM = _vehRecoilM;
        anchorDirty = recoilChainDirty;
      } else if (def.anchor === "spin" && hasSpin) {
        anchorM = _vehSpinM;
        anchorDirty = spinChainDirty;
      } else if (def.anchor === "spin2" && hasSpin2) {
        anchorM = _vehSpin2M;
        anchorDirty = spin2ChainDirty;
      } else if (def.anchor === "crane" && hasCrane) {
        anchorM = _vehCraneM;
        anchorDirty = craneChainDirty;
      } else if (def.anchor === "flag" && hasFlag) {
        anchorM = _vehFlagM;
        anchorDirty = flagChainDirty;
      } else if (def.anchor === "root") {
        anchorM = _vehRootM;
        anchorDirty = rootDirty;
      }
      if (!anchorDirty && !animated) continue;
      if (!pulseDirty && animated && !anchorDirty) continue;
      const sx = def.pulse ? pulseScale : def.shadow ? shadowScaleX : 1;
      const sy = (def.pulse ? pulseScale : 1) * (def.bin ? binScaleY : 1);
      const sz = def.pulse ? pulseScale : def.shadow ? shadowScaleZ : 1;
      const out = part.im.instanceMatrix.array as Float32Array;
      if (def.localMode !== 2) {
        // Fast path for baked/translation-only parts: copy the anchor basis (with
        // any pulse/bin scale on the right) and transform just the local offset.
        const ae = anchorM.elements;
        const tx = def.localPos.x;
        const ty = def.localPos.y;
        const tz = def.localPos.z;
        if (sx === 1 && sy === 1 && sz === 1 && tx === 0 && ty === 0 && tz === 0) {
          // Most merged rigid parts are baked exactly in anchor space. Manual
          // element copies measurably beat Float32Array.set in this hot loop.
          copyMatrixElementsToArray(anchorM, out, base16);
          this.markVehicleMatrixDirty(part, slot.idx);
          continue;
        }
        out[base16] = ae[0] * sx;
        out[base16 + 1] = ae[1] * sx;
        out[base16 + 2] = ae[2] * sx;
        out[base16 + 3] = 0;
        out[base16 + 4] = ae[4] * sy;
        out[base16 + 5] = ae[5] * sy;
        out[base16 + 6] = ae[6] * sy;
        out[base16 + 7] = 0;
        out[base16 + 8] = ae[8] * sz;
        out[base16 + 9] = ae[9] * sz;
        out[base16 + 10] = ae[10] * sz;
        out[base16 + 11] = 0;
        out[base16 + 12] = ae[0] * tx + ae[4] * ty + ae[8] * tz + ae[12];
        out[base16 + 13] = ae[1] * tx + ae[5] * ty + ae[9] * tz + ae[13];
        out[base16 + 14] = ae[2] * tx + ae[6] * ty + ae[10] * tz + ae[14];
        out[base16 + 15] = 1;
      } else {
        writeMulScaledMatrix(anchorM, def.local, sx, sy, sz, out, base16);
      }
      this.markVehicleMatrixDirty(part, slot.idx);
    }
    // Proxy geometries are already baked in anchor space, so their instance
    // matrix is exactly the anchor chain — no per-part local multiply at all.
    for (const part of pool.shadowParts) {
      let anchorM = _vehBodyM;
      let anchorDirty = bodyChainDirty;
      const def = part.def;
      if (def.childAnchor === 1 && hasSpinKids && def.childIndex < MAX_SPIN_CHILD_ANCHORS) {
        anchorM = _vehSpinChildM[def.childIndex];
        anchorDirty = spinChildChainDirty;
      } else if (def.childAnchor === 2 && hasSpin2Kids && def.childIndex < MAX_SPIN_CHILD_ANCHORS) {
        anchorM = _vehSpin2ChildM[def.childIndex];
        anchorDirty = spin2ChildChainDirty;
      } else if (def.anchor === "turret" && hasTurret) {
        anchorM = _vehTurretM;
        anchorDirty = turretChainDirty;
      } else if (def.anchor === "recoil" && hasRecoil) {
        anchorM = _vehRecoilM;
        anchorDirty = recoilChainDirty;
      } else if (def.anchor === "spin" && hasSpin) {
        anchorM = _vehSpinM;
        anchorDirty = spinChainDirty;
      } else if (def.anchor === "spin2" && hasSpin2) {
        anchorM = _vehSpin2M;
        anchorDirty = spin2ChainDirty;
      } else if (def.anchor === "crane" && hasCrane) {
        anchorM = _vehCraneM;
        anchorDirty = craneChainDirty;
      } else if (def.anchor === "flag" && hasFlag) {
        anchorM = _vehFlagM;
        anchorDirty = flagChainDirty;
      } else if (def.anchor === "root") {
        anchorM = _vehRootM;
        anchorDirty = rootDirty;
      }
      if (!anchorDirty) continue;
      copyMatrixElementsToArray(anchorM, part.im.instanceMatrix.array as Float32Array, base16);
      this.markVehicleMatrixDirty(part, slot.idx);
    }
  }

  private disposeVis(vis: EntVis) {
    // Shadow proxies are the one per-vis geometry allocation introduced here;
    // unlike the shared primitive/model geometries they must be released with
    // the building visual. The flag also prevents a queued async LOD swap from
    // reinstalling geometry after teardown.
    vis.root.traverse((o) => {
      if (o.userData.shadowProxy) {
        o.userData.shadowProxyDisposed = true;
        (o as THREE.Mesh).geometry?.dispose?.();
      }
    });
    if (vis.rig.subMats) {
      for (const m of vis.rig.subMats) if (!m?.userData.rigidTemplateKeep) m?.dispose?.();
    }
    if (vis.rig.powerGlow) {
      for (const gm of vis.rig.powerGlow) {
        const m = (gm.userData._origMat as THREE.Material | THREE.Material[] | undefined) ?? gm.material;
        if (Array.isArray(m)) m.forEach((x) => { if (!x.userData.rigidTemplateKeep) x.dispose(); });
        else if (!m.userData.rigidTemplateKeep) m.dispose();
      }
    }
    (vis.ring?.material as THREE.Material | undefined)?.dispose?.();
    (vis.barBg?.material as THREE.Material | undefined)?.dispose?.();
    (vis.barFg?.material as THREE.Material | undefined)?.dispose?.();
    (vis.vetBadge?.material as THREE.Material | undefined)?.dispose?.();
    (vis.groupTag?.material as THREE.Material | undefined)?.dispose?.();
  }

  reset() {
    const scene = this.gs.scene;
    for (const t of this.tracked.values()) {
      scene.remove(t.vis.root);
      if (t.inst) scene.remove(t.inst.proxy);
      if (t.vehInst) scene.remove(t.vehInst.proxy);
      this.disposeTracked(t);
    }
    this.tracked.clear();
    for (const cv of this.crateVis.values()) {
      scene.remove(cv.root);
      (cv.ring.material as THREE.Material).dispose();
      (cv.beacon.material as THREE.Material).dispose();
    }
    this.crateVis.clear();
    this.crates.clear();
    this.setBridges(undefined);
    this.gs.pickables.length = 0;
    this.snaps = [];
    this.selection.clear();
    this.defenseRangesOn = false;
    for (const p of this.instPools.values()) for (const part of p.parts) part.im.dispose();
    this.instPools.clear();
    for (const p of this.vehiclePools.values()) {
      for (const part of p.parts) part.im.dispose();
      for (const part of p.shadowParts) {
        part.im.userData.shadowProxyDisposed = true;
        part.im.geometry.dispose();
        part.im.dispose();
      }
    }
    this.vehiclePools.clear();
    this.vehicleTemplates.clear();
    if (this.instGroup) {
      scene.remove(this.instGroup);
      this.instGroup = null;
    }
    this.seen.clear();
    this.hasInitialSnap = false;
    this.lastAllies = undefined;
    this.lastVisSlot = -1;
    this.hiddenEntityId = null;
    this.playerLowPower.clear();
    for (const tm of this.swShakeTimers) clearTimeout(tm);
    this.swShakeTimers = [];
    this.vfx.clear();
    this.waypoints.clear();
    this.overlayBars.clear();
    this.overlayBarFg.clear();
    for (const b of this.overlayTextureBatches.values()) b.clear();
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
        if (t.inst) {
          this.freeInstance(t.inst);
          scene.remove(t.inst.proxy);
          const i = this.gs.pickables.indexOf(t.inst.proxy);
          if (i >= 0) this.gs.pickables.splice(i, 1);
        } else if (t.vehInst) {
          this.freeVehicleInstance(t.vehInst);
          scene.remove(t.vehInst.proxy);
          const i = this.gs.pickables.indexOf(t.vehInst.proxy);
          if (i >= 0) this.gs.pickables.splice(i, 1);
        } else {
          scene.remove(t.vis.root);
          const i = this.gs.pickables.indexOf(t.vis.root);
          if (i >= 0) this.gs.pickables.splice(i, 1);
        }
        this.disposeTracked(t);
        this.tracked.delete(id);
        this.selection.delete(id);
      }
    }
    // Create new entities
    for (const e of ents) {
      if (this.tracked.has(e.id)) continue;
      const color = this.slotColors.get(e.o) ?? "#888888";
      const isBuilding = isBuildingKind(e.k);
      // instanced kinds render via pools — their vis only carries HUD overlays.
      // Rigid vehicles additionally keep a lightweight turret/recoil/spin rig in
      // the lite vis, whose per-frame node state drives their instance matrices.
      const wantsSwarmInst = !isBuilding && INSTANCED_KINDS.has(e.k);
      const wantsVehicleInst =
        !isBuilding &&
        !wantsSwarmInst &&
        VEHICLE_INSTANCED_KINDS.has(e.k) &&
        e.k !== "sub" &&
        e.k !== "stealthbomber";
      const vehReservation = wantsVehicleInst ? this.reserveVehicleInstance(e) : null;
      const vis = makeEntVis(e.k, color, scene, wantsSwarmInst || vehReservation !== null);
      vis.root.position.set(e.x, 0, e.y);
      if (!isBuilding) applyFacing(vis.root, e.d / 10);
      setVetBadge(vis, e.vet ?? 0);
      tagEntity(vis.root, e.id);
      if (e.id === this.hiddenEntityId) vis.root.visible = false;
      // Instanced swarm kinds swap the full scene subtree for a proxy + pool slot
      const inst = wantsSwarmInst ? this.makeInstProxy(e) : null;
      const vehInst = vehReservation ? this.makeVehicleInstProxy(e, vis, vehReservation) : null;
      if (inst) {
        scene.add(inst.proxy);
        this.gs.pickables.push(inst.proxy);
      } else if (vehInst) {
        scene.add(vehInst.proxy);
        this.gs.pickables.push(vehInst.proxy);
      } else {
        scene.add(vis.root);
        this.gs.pickables.push(vis.root);
      }
      const anim = createAnimState(e, this.hasInitialSnap);
      const isStaticBld = isBuilding && isStaticBuildingRig(vis);
      let supplyAura: THREE.Group | undefined;
      if (e.k === "supplyhub" || e.k === "supplytruck" || e.k === "ewdrone" || e.k === "thaad") {
        supplyAura = makeSupplyAura(e.k);
        (vehInst ? vehInst.proxy : vis.root).add(supplyAura);
      }
      const cs = entityCullSphere(vis, isBuilding, e.k);
      if (vehInst) {
        // The lite HUD rig has almost no geometry of its own; use the authored
        // pick bounds so turret/scoop animation doesn't freeze prematurely when
        // a long vehicle is only partly inside the frame edge.
        const ps = vehInst.pool.template.rig.pickScale;
        cs.r = Math.max(cs.r, Math.hypot(ps.x, ps.z) * 0.55 + 0.7);
        cs.y = Math.max(cs.y, vehInst.pool.template.rig.pickCenter.y);
      }
      this.tracked.set(e.id, {
        vis,
        last: e,
        anim,
        visX: e.x,
        visY: e.y,
        visYaw: e.d / 10,
        interpSnapA: null,
        interpSnapB: null,
        interpEntA: null,
        interpEntB: null,
        supplyAura,
        lastResupplyFxMs: 0,
        isBuilding,
        isStaticBld,
        staticFrozen: false,
        lastLowPower: false,
        cullR: cs.r,
        cullY: cs.y,
        inst,
        vehInst,
      });
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
    for (const id of this.selection) if (!this.tracked.has(id)) this.selection.delete(id);
    this.updateBars(map);
  }

  private updateLogBars(t: Tracked, e: EntSnap, selected: boolean) {
    if (t.isBuilding) return;
    const isSupplyTruck = e.k === "supplytruck";
    const hasFuel = e.fl !== undefined;
    const hasAmmo = e.am !== undefined;
    if (!isSupplyTruck && !hasFuel && !hasAmmo) {
      if (t.logBars) t.logBars.group.visible = false;
      return;
    }

    if (!t.logBars) {
      const w = (t.vis.barFg.userData.w as number | undefined) ?? 0.96;
      t.logBars = makeLogBars(t.vis.topY, w);
      // Like the HP bars, these sprites are logical state consumed by the
      // instanced overlay batch — never individual scene-graph draw calls.
    }

    const lb = t.logBars;
    const w = lb.barW;

    if (isSupplyTruck) {
      const cap = UNITS.supplytruck.capacity ?? 500;
      const frac = Math.max(0, Math.min(1, (e.cargo ?? 0) / Math.max(1, cap)));
      const showCargo = selected || frac < 0.99;
      lb.group.visible = showCargo;
      lb.fuelBg.visible = showCargo;
      lb.fuelFg.visible = showCargo;
      lb.ammoBg.visible = false;
      lb.ammoFg.visible = false;
      if (showCargo) {
        lb.fuelFg.material = frac <= 0.15 ? logFuelLowMat : logCargoMat;
        lb.fuelFg.scale.x = Math.max(0.02, frac * w);
      }
      return;
    }

    const fuel = e.fl ?? 100;
    const ammo = e.am ?? 100;
    const showFuel = hasFuel && (selected || fuel <= 25);
    const showAmmo = hasAmmo && (selected || ammo <= 20);
    lb.group.visible = showFuel || showAmmo;

    lb.fuelBg.visible = showFuel;
    lb.fuelFg.visible = showFuel;
    if (showFuel) {
      const frac = Math.max(0, Math.min(1, fuel / 100));
      lb.fuelFg.material = fuel <= 25 ? logFuelLowMat : logFuelOkMat;
      lb.fuelFg.scale.x = Math.max(0.02, frac * w);
    }

    lb.ammoBg.visible = showAmmo;
    lb.ammoFg.visible = showAmmo;
    if (showAmmo) {
      const frac = Math.max(0, Math.min(1, ammo / 100));
      const yPos = showFuel ? t.vis.topY + 0.2 : t.vis.topY + 0.27;
      lb.ammoBg.position.y = yPos;
      lb.ammoFg.position.y = yPos;
      lb.ammoFg.material = ammo <= 20 ? logAmmoLowMat : logAmmoOkMat;
      lb.ammoFg.scale.x = Math.max(0.02, frac * w);
    }
  }

  private updateBars(map: Map<number, EntSnap>) {
    const nowMs = performance.now();
    for (const [id, t] of this.tracked) {
      const e = map.get(id);
      if (!e) continue;
      const ownerChanged = t.last.o !== e.o;
      const kindChanged = t.last.k !== e.k;
      const prevLast = t.last;
      if (ownerChanged || kindChanged) {
        // Ownership changed (capture) OR kind changed (factory -> factory2 upgrade) — rebuild visual!
        const scene = this.gs.scene;
        const wasVisible = t.vis.root.visible;
        const prevPos = t.inst
          ? t.inst.proxy.position
          : t.vehInst
            ? t.vehInst.proxy.position
            : t.vis.root.position;
        const prevYaw = t.inst
          ? t.inst.proxy.rotation.y
          : t.vehInst
            ? t.vehInst.proxy.rotation.y
            : t.vis.root.rotation.y;
        if (t.inst) {
          this.freeInstance(t.inst);
          scene.remove(t.inst.proxy);
          const pi = this.gs.pickables.indexOf(t.inst.proxy);
          if (pi >= 0) this.gs.pickables.splice(pi, 1);
          t.inst = null;
        } else if (t.vehInst) {
          this.freeVehicleInstance(t.vehInst);
          scene.remove(t.vehInst.proxy);
          const pi = this.gs.pickables.indexOf(t.vehInst.proxy);
          if (pi >= 0) this.gs.pickables.splice(pi, 1);
          t.vehInst = null;
        } else {
          scene.remove(t.vis.root);
          const i = this.gs.pickables.indexOf(t.vis.root);
          if (i >= 0) this.gs.pickables.splice(i, 1);
        }
        this.disposeTracked(t);
        const color = this.slotColors.get(e.o) ?? "#888888";
        const nextIsBuilding = isBuildingKind(e.k);
        const wantsSwarmInst = !nextIsBuilding && INSTANCED_KINDS.has(e.k);
        const wantsVehicleInst =
          !nextIsBuilding &&
          !wantsSwarmInst &&
          VEHICLE_INSTANCED_KINDS.has(e.k) &&
          e.k !== "sub" &&
          e.k !== "stealthbomber";
        const vehReservation = wantsVehicleInst ? this.reserveVehicleInstance(e) : null;
        const vis = makeEntVis(e.k, color, scene, wantsSwarmInst || vehReservation !== null);
        vis.root.position.copy(prevPos);
        vis.root.rotation.y = prevYaw;
        vis.root.visible = id === this.hiddenEntityId ? false : wasVisible;
        tagEntity(vis.root, e.id);
        // Re-instance if the new kind is also a swarm or rigid-vehicle kind
        const newInst = wantsSwarmInst ? this.makeInstProxy(e) : null;
        const newVehInst = vehReservation ? this.makeVehicleInstProxy(e, vis, vehReservation) : null;
        if (newInst) {
          newInst.proxy.position.copy(prevPos);
          newInst.proxy.rotation.y = prevYaw;
          scene.add(newInst.proxy);
          this.gs.pickables.push(newInst.proxy);
        } else if (newVehInst) {
          newVehInst.proxy.position.copy(prevPos);
          newVehInst.proxy.rotation.y = prevYaw;
          scene.add(newVehInst.proxy);
          this.gs.pickables.push(newVehInst.proxy);
        } else {
          scene.add(vis.root);
          this.gs.pickables.push(vis.root);
        }
        t.vis = vis;
        t.inst = newInst;
        t.vehInst = newVehInst;
        t.holdInd = undefined;
        t.logBars = undefined;
        t.supplyAura = undefined;
        if (e.k === "supplyhub" || e.k === "supplytruck" || e.k === "ewdrone" || e.k === "thaad") {
          t.supplyAura = makeSupplyAura(e.k);
          (newVehInst ? newVehInst.proxy : vis.root).add(t.supplyAura);
        }
        t.anim.flashing = false;
        t.anim.hitFlash = 0;
        t.anim.matMode = "normal";
        t.isBuilding = nextIsBuilding;
        t.isStaticBld = t.isBuilding && isStaticBuildingRig(vis);
        t.staticFrozen = false;
        t.lastLowPower = false;
        const cs = entityCullSphere(vis, t.isBuilding, e.k);
        if (newVehInst) {
          const ps = newVehInst.pool.template.rig.pickScale;
          cs.r = Math.max(cs.r, Math.hypot(ps.x, ps.z) * 0.55 + 0.7);
          cs.y = Math.max(cs.y, newVehInst.pool.template.rig.pickCenter.y);
        }
        t.cullR = cs.r;
        t.cullY = cs.y;
        if (ownerChanged) {
          this.selection.delete(id);
          this.onOwnerLost?.(id);
        } else {
          // Keep selection ring & supply aura active across upgrade
          const sel = this.selection.has(id);
          (t.inst ? t.inst.ring : t.vehInst ? t.vehInst.ring : t.vis.ring).visible = sel;
          if (t.supplyAura) t.supplyAura.visible = sel;
        }
      } else if (!t.inst && t.vis.root.visible && nowMs - t.lastResupplyFxMs >= 1350) {
        // Trigger subtle emerald resupply shimmer when fuel, ammo, or convoy cargo refills
        const fuelGain = (e.fl ?? 100) - (prevLast.fl ?? 100);
        const ammoGain = (e.am ?? 100) - (prevLast.am ?? 100);
        const truckGain = e.k === "supplytruck" ? (e.cargo ?? 0) - (prevLast.cargo ?? 0) : 0;
        if (fuelGain >= 6 || ammoGain >= 10 || truckGain >= 25) {
          this.vfx.spawnResupplyPulse(t.visX, t.visY, t.isBuilding ? 1.4 : 0.88);
          t.lastResupplyFxMs = nowMs;
        }
      }
      t.last = e;
      if (t.inst) continue; // instanced swarm ent: no bars/auras/indicators to update
      const selected = this.selection.has(id);
      const frac = Math.max(0, e.hp / e.mhp);
      t.vis.barFg.scale.x = Math.max(0.02, frac * t.vis.barFg.userData.w);
      const c = frac > 0.6 ? 0x26e050 : frac > 0.3 ? 0xf0cc26 : 0xe52626;
      (t.vis.barFg.material as THREE.SpriteMaterial).color.setHex(c);
      const show = frac < 1 || selected;
      t.vis.barBg.visible = show;
      t.vis.barFg.visible = show;
      setVetBadge(t.vis, e.vet ?? 0);
      setGroupTag(t.vis, this.groupOf.get(id) ?? 0);
      if (t.vis.bin) {
        const cap = !t.isBuilding ? (UNITS[e.k as UnitKind]?.capacity ?? 45) : 45;
        t.vis.bin.scale.y = Math.max(0.05, Math.min(1, (e.cargo ?? 0) / Math.max(1, cap)));
      }
      if (t.supplyAura) {
        t.supplyAura.visible = selected;
      }
      this.syncRangeRing(t, selected);
      this.updateLogBars(t, e, selected);

      // Hold Position stance indicator (ground amber anchor ring + centered shield badge)
      const holding = Boolean(e.hold) && !t.isBuilding;
      if (holding && !t.holdInd) {
        t.holdInd = makeHoldIndicator(t.vis.topY);
        (t.vehInst ? t.vehInst.proxy : t.vis.root).add(t.holdInd);
      }
      if (t.holdInd) {
        t.holdInd.visible = holding;
        const badge = t.holdInd.userData.badge as THREE.Sprite | undefined;
        if (badge) badge.position.y = t.vis.topY + ((e.vet ?? 0) > 0 ? 0.86 : 0.62);
      }
    }
  }

  setSelected(ids: Set<number>) {
    this.selection = ids;
    for (const [id, t] of this.tracked) {
      const sel = ids.has(id);
      (t.inst ? t.inst.ring : t.vehInst ? t.vehInst.ring : t.vis.ring).visible = sel;
      if (t.supplyAura) t.supplyAura.visible = sel;
      this.syncRangeRing(t, sel);
      if (!t.inst) this.updateLogBars(t, t.last, sel);
    }
  }

  setHiddenEntity(id: number | null): void {
    const prev = this.hiddenEntityId;
    this.hiddenEntityId = id;
    if (prev !== null && prev !== id) {
      const prevT = this.tracked.get(prev);
      if (prevT) prevT.vis.root.visible = true;
    }
    if (id !== null) {
      const nextT = this.tracked.get(id);
      if (nextT) nextT.vis.root.visible = false;
    }
    if (this.lastVisSlot >= 0) {
      this.applyVisibility(this.lastVisSlot, this.lastAllies);
    }
  }

  getEntityWorldPos(id: number): { x: number; y: number; d: number } | null {
    const t = this.tracked.get(id);
    if (t) return { x: t.visX, y: t.visY, d: t.visYaw };
    return this.framePos(id);
  }

  private resolveInterpWindow(nowMs: number): boolean {
    const n = this.snaps.length;
    if (n === 0) return false;
    const win = this.scratchWin;
    if (n === 1) {
      win.a = this.snaps[0];
      win.b = this.snaps[0];
      win.t = 0;
      return true;
    }
    const rt = nowMs - INTERP_MS;
    if (rt <= this.snaps[0].recv) {
      win.a = this.snaps[0];
      win.b = this.snaps[1];
      win.t = 0;
      return true;
    }
    let a = this.snaps[0];
    let b = this.snaps[1];
    for (let i = n - 1; i > 0; i--) {
      if (this.snaps[i - 1].recv <= rt) {
        a = this.snaps[i - 1];
        b = this.snaps[i];
        break;
      }
    }
    const span = Math.max(1, b.recv - a.recv);
    const rawT = (rt - a.recv) / span;
    win.a = a;
    win.b = b;
    // Smoothly extrapolate with velocity damping if the latest snapshot is slightly late over WAN
    win.t =
      rawT <= 0
        ? 0
        : rawT <= 1
          ? rawT
          : Math.min(MAX_EXTRAP_T, 1 + (rawT - 1) * EXTRAP_DAMP);
    return true;
  }

  private interpolateEntPair(
    ea: EntSnap | null | undefined,
    eb: EntSnap | null | undefined,
    interpT: number,
    out: { x: number; y: number; d: number },
  ): boolean {
    if (!ea && !eb) return false;
    if (!ea) {
      out.x = eb!.x;
      out.y = eb!.y;
      out.d = eb!.d / 10;
      return true;
    }
    if (!eb) {
      out.x = ea.x;
      out.y = ea.y;
      out.d = ea.d / 10;
      return true;
    }
    const dx = eb.x - ea.x;
    const dy = eb.y - ea.y;
    const moveT = interpT > 1 && dx * dx + dy * dy > SNAP_JUMP_DIST_SQ ? 1 : interpT;
    const dirT = Math.min(1, interpT);
    let dd = eb.d - ea.d;
    if (dd > Math.PI * 10) dd -= Math.PI * 20;
    if (dd < -Math.PI * 10) dd += Math.PI * 20;
    out.x = ea.x + dx * moveT;
    out.y = ea.y + dy * moveT;
    out.d = (ea.d + dd * dirT) / 10;
    return true;
  }

  private framePosInto(
    id: number,
    a: Snap,
    b: Snap,
    interpT: number,
    out: { x: number; y: number; d: number },
  ): boolean {
    return this.interpolateEntPair(a.ents.get(id), b.ents.get(id), interpT, out);
  }

  // Hot per-frame variant used by the tracked-entity loop. The endpoint Map
  // lookups depend only on the snapshot-pair identity, not on interpT, so they
  // are paid once per entity per network window instead of once per frame.
  private framePosTrackedInto(
    id: number,
    t: Tracked,
    a: Snap,
    b: Snap,
    interpT: number,
    out: { x: number; y: number; d: number },
  ): boolean {
    if (t.interpSnapA !== a || t.interpSnapB !== b) {
      t.interpSnapA = a;
      t.interpSnapB = b;
      t.interpEntA = a.ents.get(id) ?? null;
      t.interpEntB = b === a ? t.interpEntA : b.ents.get(id) ?? null;
    }
    return this.interpolateEntPair(t.interpEntA, t.interpEntB, interpT, out);
  }

  private framePos(id: number): { x: number; y: number; d: number } | null {
    if (!this.resolveInterpWindow(performance.now())) return null;
    const win = this.scratchWin;
    const out = { x: 0, y: 0, d: 0 };
    return this.framePosInto(id, win.a!, win.b!, win.t, out) ? out : null;
  }

  private pushTexturedOverlay(s: THREE.Sprite, x: number, z: number, rotCos: number, rotSin: number) {
    if (!s.visible) return;
    const mat = s.material as THREE.SpriteMaterial;
    const tex = mat.map;
    if (!tex) return;
    let batch = this.overlayTextureBatches.get(tex);
    if (!batch) {
      batch = new OverlayBarBatch(this.gs.scene, tex, 22, 1024);
      this.overlayTextureBatches.set(tex, batch);
    }
    batch.pushSprite(s, x, z, rotCos, rotSin);
  }

  private updateOverlayBars() {
    const batch = this.overlayBars;
    const fgBatch = this.overlayBarFg;
    batch.begin();
    fgBatch.begin();
    for (const b of this.overlayTextureBatches.values()) b.begin();
    for (const [id, t] of this.tracked) {
      if (id === this.hiddenEntityId || !t.vis.root.visible) continue;
      const x = t.visX;
      const z = t.visY;
      this.cullSphere.center.set(x, t.cullY, z);
      this.cullSphere.radius = t.cullR;
      if (!this.frustum.intersectsSphere(this.cullSphere)) continue;

      batch.pushSprite(t.vis.barBg, x, z);
      fgBatch.pushSprite(t.vis.barFg, x, z);
      const lb = t.logBars;
      if (lb && lb.group.visible) {
        batch.pushSprite(lb.fuelBg, x, z);
        fgBatch.pushSprite(lb.fuelFg, x, z);
        batch.pushSprite(lb.ammoBg, x, z);
        fgBatch.pushSprite(lb.ammoFg, x, z);
      }

      // applyFacing uses rotation.y = PI/2 - server yaw. Textured badges keep
      // their authored root-local offsets under that rotation, then billboard.
      // Most entities carry neither badge, so don't pay two trig calls for them.
      if (t.vis.vetBadge.visible || t.vis.groupTag.visible) {
        const rot = Math.PI / 2 - t.visYaw;
        const rc = Math.cos(rot);
        const rs = Math.sin(rot);
        this.pushTexturedOverlay(t.vis.vetBadge, x, z, rc, rs);
        this.pushTexturedOverlay(t.vis.groupTag, x, z, rc, rs);
      }
    }
    batch.commit();
    fgBatch.commit();
    for (const b of this.overlayTextureBatches.values()) b.commit();
  }

  update(dt = 0.016) {
    const nowMs = performance.now();
    const nowSec = nowMs / 1000;
    const safeDt = Math.max(0.0005, Math.min(0.1, dt));

    this.wpEntries.length = 0;
    this.rallyEntries.length = 0;

    // Resolve snapshot interpolation/extrapolation window ONCE per frame instead of per entity
    const hasWindow = this.resolveInterpWindow(nowMs);
    const snapA = hasWindow ? this.scratchWin.a : null;
    const snapB = hasWindow ? this.scratchWin.b : null;
    const interpT = hasWindow ? this.scratchWin.t : 0;

    // Frame-rate independent exponential visual smoothing gains
    const posAlpha = 1 - Math.exp(-22 * safeDt);
    const yawAlpha = 1 - Math.exp(-16 * safeDt);

    const pos = this.scratchPos;

    // Adaptive budgets: report live entity count to the quality governor, then
    // fetch this frame's work budgets (anim LOD distance, VFX scale, fx cap)
    this.frameIdx++;
    this.gs.graphics.setEntityCount(this.tracked.size);
    const budget = this.gs.graphics.getBudgets();
    this.vfxScale = budget.vfxScale;
    this.vfx.setBudget(budget.vfxScale, budget.fxCap);
    const zoomScale = Math.min(2.4, Math.max(0.85, this.gs.camHeight / 26));
    const farSq = budget.animFarDist * zoomScale * (budget.animFarDist * zoomScale);
    const animSkip = Math.max(1, Math.round(budget.animSkip));
    const camX = this.gs.camTarget.x;
    const camZ = this.gs.camTarget.z;
    // Frustum built from last frame's camera matrices — generous cull radii absorb the staleness
    const cam = this.gs.camera;
    cam.updateMatrixWorld();
    this.frustumMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMat);
    const cullSphere = this.cullSphere;

    if (snapA && snapB) {
      for (const [id, t] of this.tracked) {
        const lowPwr = this.playerLowPower.get(t.last.o) === true;

        // Fast-path & static matrix freezing for settled buildings with no moving sub-parts
        let px: number;
        let py: number;
        if (
          t.isStaticBld &&
          (!t.anim.isNewBuilding || t.anim.buildAge >= 1) &&
          t.anim.hitFlash <= 0 &&
          t.anim.matMode === "normal"
        ) {
          px = t.last.x;
          py = t.last.y;
          t.visX = px;
          t.visY = py;
          t.visYaw = t.last.d / 10;
          if (!t.staticFrozen) {
            t.vis.root.position.set(px, 0, py);
            freezeStaticBuilding(t.vis);
            t.staticFrozen = true;
          } else if (t.vis.root.position.x !== px || t.vis.root.position.z !== py) {
            t.vis.root.position.set(px, 0, py);
            t.vis.root.updateMatrix();
            t.vis.root.updateMatrixWorld(true);
          }

          cullSphere.center.set(px, t.cullY, py);
          cullSphere.radius = t.cullR;
          const onScreen = this.frustum.intersectsSphere(cullSphere);

          const hasPowerGlow = Boolean(t.vis.rig.powerGlow?.length);
          if (onScreen && hasPowerGlow && (lowPwr || t.lastLowPower)) {
            stepEntityAnim(
              t.vis,
              t.anim,
              t.last,
              px,
              py,
              t.visYaw,
              dt,
              nowSec,
              this.emitSmoke,
              this.emitWake,
              lowPwr,
              this.emitDust,
              this.emitContrail,
            );
          } else if (onScreen) {
            // Only tick smoke stack / battle-damage smoke timer on settled static buildings
            const rig = t.vis.rig;
            if (rig.smokePos && t.vis.root.visible) {
              const k = t.last.k;
              const damaged = t.last.hp < t.last.mhp * 0.55;
              const isStack = k === "factory" || k === "factory2" || k === "refinery" || k === "power" || k === "coalplant";
              if (damaged || isStack) {
                t.anim.smokeCd -= safeDt;
                if (t.anim.smokeCd <= 0) {
                  t.anim.smokeCd = damaged ? 0.28 + Math.random() * 0.2 : 0.9 + Math.random() * 0.5;
                  this.emitSmoke(
                    px + rig.smokePos.x * 0.5,
                    rig.smokePos.y,
                    py + rig.smokePos.z * 0.5,
                    damaged,
                  );
                }
              }
            }
          }
          t.lastLowPower = lowPwr;
          this.syncRigidInstancing(t);
          if (t.vehInst) this.writeVehicleInstance(t);
        } else {
          if (!this.framePosTrackedInto(id, t, snapA, snapB, interpT, pos)) continue;
          const dxVis = pos.x - t.visX;
          const dyVis = pos.y - t.visY;
          if (dxVis * dxVis + dyVis * dyVis > SNAP_JUMP_DIST_SQ) {
            t.visX = pos.x;
            t.visY = pos.y;
          } else {
            t.visX += dxVis * posAlpha;
            t.visY += dyVis * posAlpha;
          }
          let dYaw = pos.d - t.visYaw;
          while (dYaw > Math.PI) dYaw -= Math.PI * 2;
          while (dYaw < -Math.PI) dYaw += Math.PI * 2;
          t.visYaw += dYaw * yawAlpha;
          if (t.visYaw > Math.PI) t.visYaw -= Math.PI * 2;
          else if (t.visYaw < -Math.PI) t.visYaw += Math.PI * 2;

          px = t.visX;
          py = t.visY;
          if (t.inst) {
            // Instanced swarm ent: write the pool matrix + mirror the proxy —
            // no scene subtree, no per-part anim, no ambient VFX emitters.
            this.writeInstance(t);
            t.anim.prevX = px;
            t.anim.prevY = py;
            t.anim.prevHeading = t.visYaw;
          } else {
            if (t.staticFrozen) {
              if (t.vis.root.position.x !== px || t.vis.root.position.z !== py) {
                t.vis.root.position.set(px, 0, py);
                t.vis.root.updateMatrix();
                t.vis.root.updateMatrixWorld(true);
              }
            } else {
              t.vis.root.position.x = px;
              t.vis.root.position.z = py;
            }
            if (!t.isBuilding) {
              applyFacing(t.vis.root, t.visYaw);
            }
          }
          if (!t.inst) {
          // Per-entity update culling: skip animation & ambient VFX work when the
          // entity is outside the camera frustum; far on-screen entities animate
          // at a staggered reduced rate. Position/heading still update every frame
          // so picking, FPV & waypoint overlays stay exact.
          const dxC = px - camX;
          const dzC = py - camZ;
          const far = dxC * dxC + dzC * dzC > farSq;
          cullSphere.center.set(px, t.cullY, py);
          cullSphere.radius = t.cullR;
          const onScreen = this.frustum.intersectsSphere(cullSphere);
          if (onScreen && (!far || this.selection.has(id) || (this.frameIdx + id) % animSkip === 0)) {
            stepEntityAnim(
              t.vis,
              t.anim,
              t.last,
              px,
              py,
              t.visYaw,
              far ? Math.min(0.1, dt * animSkip) : dt,
              nowSec,
              this.emitSmoke,
              this.emitWake,
              lowPwr,
              this.emitDust,
              this.emitContrail,
            );
          } else {
            // Keep velocity anchors fresh so re-entry doesn't read a phantom speed burst
            t.anim.prevX = px;
            t.anim.prevY = py;
            t.anim.prevHeading = t.visYaw;
          }
          t.lastLowPower = lowPwr;
          this.syncRigidInstancing(t);
          if (t.vehInst) this.writeVehicleInstance(t);
          }
        }

        if (this.selection.has(id) && t.vis.root.visible) {
          if (t.last.wp?.length) {
            const wi = this.wpEntries.length;
            let entry = this.wpEntryPool[wi];
            if (!entry) {
              entry = { x: px, y: py, wp: t.last.wp };
              this.wpEntryPool[wi] = entry;
            } else {
              entry.x = px;
              entry.y = py;
              entry.wp = t.last.wp;
            }
            this.wpEntries.push(entry);
          }
          if (
            t.last.rally &&
            (t.last.k === "barracks" ||
              t.last.k === "barracks2" ||
              t.last.k === "factory" ||
              t.last.k === "factory2" ||
              t.last.k === "airfield" ||
              t.last.k === "airfield2" ||
              t.last.k === "shipyard" ||
              t.last.k === "shipyard2")
          ) {
            const ri = this.rallyEntries.length;
            let rEntry = this.rallyEntryPool[ri];
            if (!rEntry) {
              rEntry = { x: px, y: py, rx: t.last.rally[0], ry: t.last.rally[1] };
              this.rallyEntryPool[ri] = rEntry;
            } else {
              rEntry.x = px;
              rEntry.y = py;
              rEntry.rx = t.last.rally[0];
              rEntry.ry = t.last.rally[1];
            }
            this.rallyEntries.push(rEntry);
          }
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

    // Subtle breathing pulse on selected supply hub / supply truck, EW jammer & THAAD nuke-shield aura rings
    supplyAuraRingMat.opacity = 0.36 + 0.08 * Math.sin(nowSec * 2.6);
    ewAuraRingMat.opacity = 0.42 + 0.1 * Math.sin(nowSec * 3.8);
    ewAuraInnerRingMat.opacity = 0.24 + 0.09 * Math.sin(nowSec * 3.8 + 1.4);
    thaadAuraRingMat.opacity = 0.52 + 0.12 * Math.sin(nowSec * 2.8);
    thaadAuraGoldMat.opacity = 0.44 + 0.12 * Math.sin(nowSec * 2.8 + 1.2);
    thaadAuraDomeMat.opacity = 0.042 + 0.014 * Math.sin(nowSec * 2.2);

    this.flushVehicleInstanceMatrices();
    this.updateOverlayBars();
    this.waypoints.update(this.wpEntries, nowSec, this.rallyEntries);
    this.vfx.update();
  }

  applyEvents(events: GameEvent[], mySlot = -1) {
    for (const ev of events) {
      if (ev.e === "shot") {
        const shooter = ev.src != null ? this.tracked.get(ev.src) : undefined;
        const isSatLaser = shooter?.last.k === "satlink" && ev.w === "laser";
        this.vfx.spawnShot(
          ev.fx,
          ev.fy,
          ev.tx,
          ev.ty,
          ev.w ?? "bullet",
          ev.vet ?? 0,
          isSatLaser ? 24 : shooter?.vis.rig.altitude,
          shooter?.last.k,
        );
        if (shooter) triggerFireAnim(shooter.anim, ev.fx, ev.fy, ev.tx, ev.ty);
      } else if (ev.e === "intercept") {
        this.vfx.spawnIntercept(ev.fx, ev.fy, ev.tx, ev.ty);
      } else if (ev.e === "ewjam") {
        this.vfx.spawnEwJam(ev.fx, ev.fy, ev.tx, ev.ty);
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
        this.gs.shake(0.35);
        const tm = setTimeout(() => {
          this.gs.shake(1.6);
          const idx = this.swShakeTimers.indexOf(tm);
          if (idx >= 0) this.swShakeTimers.splice(idx, 1);
        }, 750);
        this.swShakeTimers.push(tm);
      } else if (ev.e === "nukeIntercept") {
        this.vfx.spawnNukeIntercept(ev.fx, ev.fy, ev.tx, ev.ty);
        const tm = setTimeout(() => {
          this.gs.shake(0.95);
          const idx = this.swShakeTimers.indexOf(tm);
          if (idx >= 0) this.swShakeTimers.splice(idx, 1);
        }, 700);
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
      } else if (ev.e === "recon") {
        this.vfx.spawnRecon(ev.x, ev.y, ev.r);
        this.vfx.spawnPopup(ev.x, ev.y, "RECON SCAN", "#4ad8ff");
        if (mySlot < 0 || ev.slot === mySlot || this.lastAllies?.has(ev.slot)) {
          this.gs.addReconReveal(ev.x, ev.y, ev.r, 10000);
          if (this.lastVisSlot >= 0) {
            this.applyVisibility(this.lastVisSlot, this.lastAllies);
          }
        }
      }
    }
  }

  mySelectableIds(mySlot: number): number[] {
    const out: number[] = [];
    for (const [id, t] of this.tracked) if (t.last.o === mySlot && !isBuildingKind(t.last.k)) out.push(id);
    return out;
  }

  pickCrateAt(wx: number, wz: number): CrateSnap | null {
    let best: CrateSnap | null = null;
    let bestD2 = 1.2 * 1.2;
    for (const c of this.crates.values()) {
      const dx = c.x - wx;
      const dz = c.y - wz;
      const d2 = dx * dx + dz * dz;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = c;
      }
    }
    return best;
  }

  // Live Fog of War + Fog-lite entity reveal: allied forces & active recon scans share sight,
  // enemy buildings remain visible once scouted, and spectators see everything.
  applyVisibility(mySlot: number, allies?: Set<number>) {
    this.lastAllies = allies;
    this.lastVisSlot = mySlot;
    if (mySlot < 0) {
      for (const [id, t] of this.tracked) {
        const show = id !== this.hiddenEntityId;
        if (t.vis.root.visible !== show) t.vis.root.visible = show;
      }
      for (const cv of this.crateVis.values()) cv.root.visible = true;
      this.gs.updateFog(-1, []);
      return;
    }

    const isFriendly = (o: number) => o === mySlot || (allies?.has(o) ?? false);
    let hasSatlink = false;
    for (const t of this.tracked.values()) {
      if (isFriendly(t.last.o) && t.last.k === "satlink") {
        hasSatlink = true;
        break;
      }
    }
    const visionMult = hasSatlink ? 1.4 : 1.0;

    const visionSources: {
      x: number;
      y: number;
      r: number;
      subDetectR: number;
      usvDetectR: number;
      stealthAirDetectR: number;
    }[] = [];
    for (const t of this.tracked.values()) {
      if (isFriendly(t.last.o)) {
        const k = t.last.k;
        const baseR = t.isBuilding
          ? k === "radar" || k === "superweapon" || k === "satlink"
            ? 17
            : k === "thaad"
              ? 16
              : k === "supplyhub"
                ? 15
                : 14
          : (UNITS[k as UnitKind]?.vision ?? 9);
        const r = baseR * visionMult;
        const subDetectR = k === "gunboat" || k === "destroyer" || k === "sub" || k === "carrier" ? 9 : 5.5;
        const usvDetectR =
          k === "usv" ||
          k === "gunboat" ||
          k === "destroyer" ||
          k === "sub" ||
          k === "dreadnought" ||
          k === "carrier" ||
          k === "radar" ||
          k === "uav"
            ? 9
            : 5.5;
        const lowPwr = this.playerLowPower.get(t.last.o) === true;
        // B-21 Stealth Bomber is completely invisible without powered Radar-tier sensors
        const stealthAirDetectR = lowPwr
          ? 0
          : k === "satlink"
            ? 18
            : k === "thaad"
              ? 15
              : k === "radar" || k === "sam" || k === "irondome"
                ? 12
                : 0;
        visionSources.push({ x: t.last.x, y: t.last.y, r, subDetectR, usvDetectR, stealthAirDetectR });
      }
    }
    const reconZones = this.gs.getActiveReconReveals();

    for (const [id, t] of this.tracked) {
      if (id === this.hiddenEntityId) {
        if (t.vis.root.visible) t.vis.root.visible = false;
        continue;
      }
      const e = t.last;
      if (isFriendly(e.o) || e.o < 0) {
        if (!t.vis.root.visible) t.vis.root.visible = true;
        continue;
      }
      const isStealthedSub = e.k === "sub" && Boolean(e.sub);
      const isStealthedUsv = e.k === "usv" && Boolean(e.sub);
      const isStealthedAir = e.k === "stealthbomber" && Boolean(e.sub);
      let vis = false;
      for (const m of visionSources) {
        const dx = m.x - e.x;
        const dy = m.y - e.y;
        const lim = isStealthedSub
          ? m.subDetectR
          : isStealthedUsv
            ? m.usvDetectR
            : isStealthedAir
              ? m.stealthAirDetectR
              : m.r;
        if (lim <= 0) continue;
        if (dx * dx + dy * dy <= lim * lim) {
          vis = true;
          break;
        }
      }
      if (!vis) {
        for (const z of reconZones) {
          const dx = z.x - e.x;
          const dy = z.y - e.y;
          if (dx * dx + dy * dy <= z.r * z.r) {
            vis = true;
            break;
          }
        }
      }
      if (vis) this.seen.add(id);
      const show = vis || (t.isBuilding && this.seen.has(id));
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
    const v = this.scratchVec.copy(t.vis.root.position);
    // Air units project at an averaged mid-height between ground ring & flying hull for reliable drag-box selection
    v.y = t.vis.rig.altitude ? t.vis.rig.altitude * 0.42 : 0.5;
    v.project(this.gs.camera);
    // Reject entities behind or clipped outside camera frustum
    if (v.z < -1 || v.z > 1) return null;
    return {
      x: (v.x * 0.5 + 0.5) * this.gs.canvas.clientWidth,
      y: (-v.y * 0.5 + 0.5) * this.gs.canvas.clientHeight,
    };
  }
}
