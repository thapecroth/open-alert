import * as THREE from "three";

export type QualityPreset = "low" | "medium" | "high" | "ultra";

export interface GraphicsSettings {
  preset: QualityPreset;
  raytracing: boolean;
  contactShadows: boolean;
  bloom: boolean;
  dynamicRes: boolean;
  autoQuality: boolean;
}

// Per-frame CPU/GPU work budgets consumed by the entity renderer & VFX system.
// Derived from the effective quality tier + live entity count pressure.
export interface RenderBudgets {
  animFarDist: number; // world tiles from camera target beyond which entity anim throttles
  animSkip: number; // far entities step animation every Nth frame (with accumulated dt)
  vfxScale: number; // probability scale for ambient particle emission (dust/smoke/wake/contrail)
  fxCap: number; // max simultaneous beam/tracer/flash one-shot fx objects
}

export interface GpuInfo {
  backend: "WebGL2" | "WebGL";
  webgpuAvailable: boolean;
  webgpuAdapter: string;
  rendererName: string;
  vendor: string;
  maxTextureSize: number;
  cores: number;
  recommended: QualityPreset;
  appleSilicon: boolean;
  isMac: boolean;
}

export interface PerfStats {
  fps: number;
  frameMs: number;
  calls: number;
  triangles: number;
  dpr: number;
}

interface PresetSpec {
  raytracing: boolean;
  contactShadows: boolean;
  bloom: boolean;
  dynamicRes: boolean;
  maxDpr: number;
  shadowSize: number;
  shadowUpdateStride: number;
}

const STORAGE_KEY = "oa-gfx-v1";
const VALID_PRESETS: readonly QualityPreset[] = ["low", "medium", "high", "ultra"];

const PRESET_BUDGETS: Record<QualityPreset, Omit<RenderBudgets, never>> = {
  low: { animFarDist: 38, animSkip: 4, vfxScale: 0.4, fxCap: 90 },
  medium: { animFarDist: 55, animSkip: 3, vfxScale: 0.65, fxCap: 170 },
  high: { animFarDist: 75, animSkip: 2, vfxScale: 0.85, fxCap: 280 },
  ultra: { animFarDist: 95, animSkip: 2, vfxScale: 1.0, fxCap: 400 },
};

// Adaptive Quality Governor: autoTier sheds rendering cost in steps while the
// user's chosen preset stays the ceiling. T3 removes all post-FX so the scene
// hits the zero-composer direct render path regardless of preset.
const AUTO_TIER_MAX = 3;
// fps-locked adaptive policy: full quality while fps >= 25, progressive shedding
// only below that floor, recovery once comfortably clear of it.
const AUTO_DOWN_FPS = 25;
const AUTO_UP_FPS = 40;
const AUTO_DOWN_MS = 1400;
const AUTO_UP_MS = 6000;
const AUTO_DWELL_MS = 4000;
// Downshifts answer a *current* crisis, so they need far less oscillation
// protection than upshifts (which are already guarded by 6s sustained headroom).
// Below CRISIS_FPS the dwell is bypassed entirely — a battle that tanks the
// frame rate must reach the protective tier in ~1-2s, not ~15s.
const AUTO_DWELL_DOWN_MS = 900;
const CRISIS_FPS = 18;
const CRISIS_DOWN_MS = 450;
const TIER_VFX = [1, 0.8, 0.55, 0.3];
const TIER_FX = [1, 0.75, 0.5, 0.35];
const TIER_ANIM = [1, 0.85, 0.7, 0.55];

const PRESET_SPECS: Record<QualityPreset, PresetSpec> = {
  low: {
    raytracing: false,
    contactShadows: false,
    bloom: false,
    dynamicRes: true,
    maxDpr: 1.0,
    shadowSize: 1024,
    shadowUpdateStride: 2,
  },
  medium: {
    raytracing: false,
    contactShadows: true,
    bloom: true,
    dynamicRes: true,
    maxDpr: 1.25,
    shadowSize: 1536,
    shadowUpdateStride: 2,
  },
  high: {
    raytracing: true,
    contactShadows: true,
    bloom: true,
    dynamicRes: true,
    maxDpr: 1.5,
    shadowSize: 2048,
    shadowUpdateStride: 1,
  },
  ultra: {
    raytracing: true,
    contactShadows: true,
    bloom: true,
    dynamicRes: false,
    maxDpr: 2.0,
    shadowSize: 2048,
    shadowUpdateStride: 1,
  },
};

function isQualityPreset(v: unknown): v is QualityPreset {
  return typeof v === "string" && (VALID_PRESETS as readonly string[]).includes(v);
}

function makePresetSettings(preset: QualityPreset): GraphicsSettings {
  const spec = PRESET_SPECS[preset];
  return {
    preset,
    raytracing: spec.raytracing,
    contactShadows: spec.contactShadows,
    bloom: spec.bloom,
    dynamicRes: spec.dynamicRes,
    autoQuality: true,
  };
}

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  const plat = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /Mac/i.test(plat) || /Macintosh|Mac OS X/i.test(ua);
}

function detectAppleSilicon(rendererName: string, vendor: string, isMac: boolean): boolean {
  const probe = `${rendererName} ${vendor}`;
  if (/Apple\s+M[1-9]|Apple\s+GPU/i.test(probe)) return true;
  if (isMac && /Apple/i.test(probe) && !/Intel|AMD|Radeon|NVIDIA/i.test(probe)) return true;
  return false;
}

function classifyGpu(rendererName: string, vendor: string, appleSilicon: boolean): QualityPreset {
  const probe = `${rendererName} ${vendor}`;

  // 1. Software rasterizers (headless Chrome / CI / VM) -> crisp balanced medium
  if (/SwiftShader|llvmpipe|Basic Render|Softpipe|Software Rasterizer/i.test(probe)) {
    return "medium";
  }

  // 2. High-performance discrete GPUs & Apple Pro/Max/Ultra/M3/M4 silicon -> full ultra raytraced
  if (
    /\b(RTX|GTX|Quadro|TITAN|Arc)\b|RX\s*[6789]\d{2}|Radeon\s+RX\s*[6789]|Apple\s+M(1\s+(Pro|Max|Ultra)|2\s+(Pro|Max|Ultra)|[3-9])/i.test(
      probe,
    )
  ) {
    return "ultra";
  }

  // 3. Base Apple Silicon (M1 / M2 / Safari generic "Apple GPU") -> HIGH with Metal-optimized SSR Raytracing + Dynamic Res
  if (appleSilicon) {
    return "high";
  }

  // 4. Integrated x86 laptop & mobile GPUs -> smooth 60fps medium with dynamicRes ON
  if (/Intel|Radeon\s*(\(TM\)\s*)?Graphics|Mali|Adreno|Iris|UHD|HD\s+Graphics|Vega/i.test(probe)) {
    return "medium";
  }

  // 5. Safe laptop-friendly fallback
  return "medium";
}

function loadSavedSettings(): GraphicsSettings | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GraphicsSettings> | null;
    if (!parsed || typeof parsed !== "object" || !isQualityPreset(parsed.preset)) {
      return null;
    }
    const base = makePresetSettings(parsed.preset);
    return {
      preset: parsed.preset,
      raytracing: typeof parsed.raytracing === "boolean" ? parsed.raytracing : base.raytracing,
      contactShadows: typeof parsed.contactShadows === "boolean" ? parsed.contactShadows : base.contactShadows,
      bloom: typeof parsed.bloom === "boolean" ? parsed.bloom : base.bloom,
      dynamicRes: typeof parsed.dynamicRes === "boolean" ? parsed.dynamicRes : base.dynamicRes,
      autoQuality: typeof parsed.autoQuality === "boolean" ? parsed.autoQuality : true,
    };
  } catch {
    return null;
  }
}

function saveSettings(settings: GraphicsSettings): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota or sandbox restrictions
  }
}

interface WebGpuAdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

interface WebGpuAdapterLike {
  info?: WebGpuAdapterInfoLike;
  requestAdapterInfo?: () => Promise<WebGpuAdapterInfoLike>;
}

interface NavigatorGpuLike {
  requestAdapter: (options?: { powerPreference?: "high-performance" | "low-power" }) => Promise<WebGpuAdapterLike | null>;
}

export class GraphicsManager {
  readonly gpu: GpuInfo;
  settings: GraphicsSettings;
  stats: PerfStats;
  onChange: ((settings: GraphicsSettings, gpu: GpuInfo) => void) | null = null;

  private dynamicScale = 1.0;
  private emaFrameMs = 16.67;
  private hasSample = false;
  private govFrameCount = 0;

  // Adaptive Quality Governor state (runtime-only, never persisted)
  autoTier = 0;
  private eff: GraphicsSettings;
  private entityCount = 0;
  private lowMs = 0;
  private highMs = 0;
  private crisisMs = 0;
  private lastTierChangeMs = 0;

  constructor(
    renderer: THREE.WebGLRenderer,
    onChange?: (settings: GraphicsSettings, gpu: GpuInfo) => void,
  ) {
    if (onChange) {
      this.onChange = onChange;
    }

    this.gpu = this.probeWebGL(renderer);

    const saved = loadSavedSettings();
    // Start at the highest quality ceiling: the fps-locked governor sheds tiers
    // within seconds when hardware can't hold 25fps, so beauty is the default and
    // adaptation is the safety net — not the other way round.
    this.settings = saved ?? makePresetSettings("ultra");
    this.eff = this.settings;

    this.stats = {
      fps: 60,
      frameMs: 16.7,
      calls: 0,
      triangles: 0,
      dpr: renderer.getPixelRatio(),
    };

    this.probeWebGPU();
  }

  private probeWebGL(renderer: THREE.WebGLRenderer): GpuInfo {
    const gl = renderer.getContext();
    const backend: "WebGL2" | "WebGL" = renderer.capabilities.isWebGL2 ? "WebGL2" : "WebGL";
    const maxTextureSize = renderer.capabilities.maxTextureSize || 4096;
    const cores =
      typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency > 0
        ? navigator.hardwareConcurrency
        : 4;

    let rendererName = "Unknown GPU";
    let vendor = "Unknown";

    try {
      const debugExt = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugExt) {
        const unmaskedRenderer = gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL);
        const unmaskedVendor = gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL);
        if (typeof unmaskedRenderer === "string" && unmaskedRenderer.trim().length > 0) {
          rendererName = unmaskedRenderer.trim();
        }
        if (typeof unmaskedVendor === "string" && unmaskedVendor.trim().length > 0) {
          vendor = unmaskedVendor.trim();
        }
      } else {
        const fallbackRenderer = gl.getParameter(gl.RENDERER);
        const fallbackVendor = gl.getParameter(gl.VENDOR);
        if (typeof fallbackRenderer === "string" && fallbackRenderer.trim().length > 0) {
          rendererName = fallbackRenderer.trim();
        }
        if (typeof fallbackVendor === "string" && fallbackVendor.trim().length > 0) {
          vendor = fallbackVendor.trim();
        }
      }
    } catch {
      // Restricted WebGL context; retain fallback strings
    }

    const isMac = detectMac();
    const appleSilicon = detectAppleSilicon(rendererName, vendor, isMac);
    let recommended = classifyGpu(rendererName, vendor, appleSilicon);

    // Hardware safety caps: weak/rasterized environments start conservative.
    // The adaptive governor can still shed below this, and users can raise it.
    const rank: Record<QualityPreset, number> = { low: 0, medium: 1, high: 2, ultra: 3 };
    const capAt = (p: QualityPreset, max: QualityPreset): QualityPreset => (rank[p] > rank[max] ? max : p);
    const ua = typeof navigator !== "undefined" ? navigator.userAgent ?? "" : "";
    const mobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua);
    const devMem =
      typeof navigator !== "undefined" ? (navigator as unknown as { deviceMemory?: number }).deviceMemory : undefined;
    if (!renderer.capabilities.isWebGL2 || mobile || cores <= 4 || maxTextureSize < 8192) {
      recommended = capAt(recommended, "medium");
    }
    if (typeof devMem === "number" && devMem > 0) {
      if (devMem < 4) recommended = capAt(recommended, "medium");
      else if (devMem < 8) recommended = capAt(recommended, "high");
    }

    return {
      backend,
      webgpuAvailable: false,
      webgpuAdapter: "",
      rendererName,
      vendor,
      maxTextureSize,
      cores,
      recommended,
      appleSilicon,
      isMac,
    };
  }

  private probeWebGPU(): void {
    if (typeof navigator === "undefined") return;
    const gpuApi = (navigator as unknown as { gpu?: NavigatorGpuLike }).gpu;
    if (!gpuApi || typeof gpuApi.requestAdapter !== "function") return;

    gpuApi
      .requestAdapter({ powerPreference: "high-performance" })
      .then(async (adapter) => {
        if (!adapter) return;
        let adapterName = "WebGPU Hardware Adapter";
        try {
          const info =
            adapter.info ??
            (typeof adapter.requestAdapterInfo === "function" ? await adapter.requestAdapterInfo() : undefined);
          if (info) {
            if (typeof info.description === "string" && info.description.trim().length > 0) {
              adapterName = info.description.trim();
            } else {
              const parts = [info.vendor, info.architecture, info.device]
                .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
                .map((p) => p.trim());
              if (parts.length > 0) {
                adapterName = Array.from(new Set(parts)).join(" ");
              }
            }
          }
        } catch {
          // Adapter info query is optional in some implementations
        }

        this.gpu.webgpuAvailable = true;
        this.gpu.webgpuAdapter = adapterName;
        this.emitChange();
      })
      .catch(() => {
        // WebGPU unavailable or blocked; remain on WebGL cleanly
      });
  }

  private emitChange(): void {
    if (this.onChange) {
      this.onChange({ ...this.settings }, { ...this.gpu });
    }
  }

  applyPreset(p: QualityPreset): void {
    this.settings = makePresetSettings(p);
    this.recomputeEffective();
    this.dynamicScale = 1.0;
    this.govFrameCount = 0;
    saveSettings(this.settings);
    this.emitChange();
  }

  setOption<K extends keyof GraphicsSettings>(k: K, v: GraphicsSettings[K]): void {
    if (k === "preset") {
      this.applyPreset(v as QualityPreset);
      return;
    }
    if (this.settings[k] === v) return;
    this.settings = { ...this.settings, [k]: v };
    if (k === "dynamicRes" && !v) {
      this.dynamicScale = 1.0;
      this.govFrameCount = 0;
    }
    if (k === "autoQuality" && !v) {
      this.autoTier = 0;
      this.lowMs = 0;
      this.highMs = 0;
    }
    this.recomputeEffective();
    saveSettings(this.settings);
    this.emitChange();
  }

  // ---------- Adaptive Quality Governor ----------

  // Live entity pressure fed by the entity renderer each frame
  setEntityCount(n: number): void {
    this.entityCount = n;
    if (this.settings.autoQuality) {
      const floor = this.entityFloor();
      if (this.autoTier < floor) this.setAutoTier(floor);
    }
  }

  private entityFloor(): number {
    if (this.entityCount > 480) return 2;
    if (this.entityCount > 300) return 1;
    return 0;
  }

  private setAutoTier(t: number): void {
    if (t === this.autoTier) return;
    this.autoTier = t;
    this.lowMs = 0;
    this.highMs = 0;
    this.crisisMs = 0;
    this.lastTierChangeMs = performance.now();
    this.recomputeEffective();
    this.emitChange();
  }

  private recomputeEffective(): void {
    const s = this.settings;
    if (this.autoTier === 0) this.eff = s;
    else if (this.autoTier === 1) this.eff = { ...s, raytracing: false };
    else if (this.autoTier === 2) this.eff = { ...s, raytracing: false, contactShadows: false };
    else this.eff = { ...s, raytracing: false, contactShadows: false, bloom: false };
  }

  // Effective runtime settings = user settings shed by the current auto tier.
  // `settings` stays the user's ceiling; consumers should use this.
  getEffectiveSettings(): GraphicsSettings {
    return this.eff;
  }

  private effPreset(): QualityPreset {
    return this.autoTier >= AUTO_TIER_MAX ? "low" : this.settings.preset;
  }

  getBudgets(): RenderBudgets {
    const base = PRESET_BUDGETS[this.effPreset()];
    const ent =
      this.entityCount > 480 ? 0.6 : this.entityCount > 300 ? 0.78 : this.entityCount > 180 ? 0.9 : 1;
    return {
      animFarDist: Math.max(18, base.animFarDist * TIER_ANIM[this.autoTier] * ent),
      animSkip: Math.min(6, base.animSkip + (this.autoTier >= 2 ? 1 : 0)),
      vfxScale: base.vfxScale * TIER_VFX[this.autoTier] * ent,
      fxCap: Math.round(base.fxCap * TIER_FX[this.autoTier] * (this.entityCount > 480 ? 0.7 : 1)),
    };
  }

  getTargetDpr(): number {
    const deviceDpr = typeof window !== "undefined" && typeof window.devicePixelRatio === "number" ? window.devicePixelRatio : 1;
    let maxDpr = PRESET_SPECS[this.effPreset()].maxDpr;
    // On Retina Apple Silicon MacBooks, cap Ultra DPR at 1.75 (saves ~24% fragment fillrate on 3K+ screens with crisp Retina sharpness)
    if (this.gpu.appleSilicon && this.effPreset() === "ultra") {
      maxDpr = Math.min(maxDpr, 1.75);
    }
    if (this.autoTier === 2) maxDpr *= 0.85;
    const baseDpr = Math.min(Math.max(1, deviceDpr), maxDpr);
    const scaled = this.settings.dynamicRes ? baseDpr * this.dynamicScale : baseDpr;
    return Math.max(0.5, Math.round(scaled * 100) / 100);
  }

  getBloomScale(): number {
    // Half-res bloom cuts Metal TBDR tile-memory bandwidth by ~70% with identical visual glow
    return this.gpu.appleSilicon || this.effPreset() !== "ultra" ? 0.5 : 0.75;
  }

  getDynamicResolutionScale(): number {
    // Governor-controlled render-scale factor only (1 = native target DPR).
    // The final sharpening pass uses this loss signal, independently of the
    // static per-preset DPR cap, so it never sharpens a native-res frame.
    return this.settings.dynamicRes ? this.dynamicScale : 1;
  }

  getShadowSize(): number {
    const spec = PRESET_SPECS[this.effPreset()].shadowSize;
    return this.autoTier >= 2 ? Math.min(spec, 1024) : spec;
  }

  getShadowUpdateStride(): number {
    const entExtra = this.entityCount > 480 ? 2 : this.entityCount > 300 ? 1 : 0;
    return Math.min(6, PRESET_SPECS[this.effPreset()].shadowUpdateStride + (this.autoTier >= 2 ? 1 : 0) + entExtra);
  }

  sampleFrame(dtMs: number, renderer: THREE.WebGLRenderer): { scaleChanged: boolean; targetDpr: number } {
    const clampedDt = Number.isFinite(dtMs) ? Math.max(1, Math.min(250, dtMs)) : 16.67;

    if (!this.hasSample) {
      this.emaFrameMs = clampedDt;
      this.hasSample = true;
    } else {
      const alpha = 0.1;
      this.emaFrameMs = this.emaFrameMs * (1 - alpha) + clampedDt * alpha;
    }

    const emaFps = 1000 / Math.max(1, this.emaFrameMs);

    this.stats.fps = Math.round(emaFps);
    this.stats.frameMs = Math.round(this.emaFrameMs * 10) / 10;
    this.stats.calls = renderer.info.render.calls;
    this.stats.triangles = renderer.info.render.triangles;
    this.stats.dpr = renderer.getPixelRatio();

    // Adaptive Quality Governor: shed cost on sustained low FPS / heavy entity
    // pressure, restore gradually on sustained headroom. Hysteresis + min dwell
    // prevents oscillation; entityFloor() pins a minimum tier in big battles.
    if (this.settings.autoQuality) {
      const now = performance.now();
      const floor = this.entityFloor();
      if (emaFps < CRISIS_FPS) this.crisisMs += clampedDt;
      else this.crisisMs = 0;
      if (this.autoTier < floor) {
        this.setAutoTier(floor);
      } else if (this.crisisMs >= CRISIS_DOWN_MS && this.autoTier < AUTO_TIER_MAX) {
        // Crisis fast-path: sustained sub-CRISIS_FPS sheds a tier immediately,
        // bypassing the dwell — protection matters more than stability here.
        this.setAutoTier(this.autoTier + 1);
      } else {
        const dwellMs = now - this.lastTierChangeMs;
        if (emaFps < AUTO_DOWN_FPS) {
          this.lowMs += clampedDt;
          this.highMs = 0;
        } else if (emaFps > AUTO_UP_FPS) {
          this.highMs += clampedDt;
          this.lowMs = 0;
        } else {
          this.lowMs = 0;
          this.highMs = 0;
        }
        if (this.lowMs >= AUTO_DOWN_MS && this.autoTier < AUTO_TIER_MAX && dwellMs >= AUTO_DWELL_DOWN_MS) {
          this.setAutoTier(this.autoTier + 1);
        } else if (this.highMs >= AUTO_UP_MS && this.autoTier > floor && dwellMs >= AUTO_DWELL_MS) {
          this.setAutoTier(Math.max(floor, this.autoTier - 1));
        }
      }
    }

    let scaleChanged = false;

    if (this.settings.dynamicRes) {
      this.govFrameCount++;
      const cadence = emaFps < 30 ? 12 : 45;
      const floor = this.autoTier >= 3 ? 0.5 : 0.65;
      if (this.govFrameCount >= cadence) {
        this.govFrameCount = 0;
        if (emaFps < 26 && this.dynamicScale > floor) {
          const next = Math.max(floor, Math.round((this.dynamicScale - 0.1) * 100) / 100);
          if (next !== this.dynamicScale) {
            this.dynamicScale = next;
            scaleChanged = true;
          }
        } else if (emaFps > 40 && this.dynamicScale < 1.0) {
          const next = Math.min(1.0, Math.round((this.dynamicScale + 0.05) * 100) / 100);
          if (next !== this.dynamicScale) {
            this.dynamicScale = next;
            scaleChanged = true;
          }
        }
      }
    } else if (this.dynamicScale !== 1.0) {
      this.dynamicScale = 1.0;
      this.govFrameCount = 0;
      scaleChanged = true;
    }

    return { scaleChanged, targetDpr: this.getTargetDpr() };
  }
}
