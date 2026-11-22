import * as THREE from "three";

export type QualityPreset = "low" | "medium" | "high" | "ultra";

export interface GraphicsSettings {
  preset: QualityPreset;
  raytracing: boolean;
  contactShadows: boolean;
  bloom: boolean;
  dynamicRes: boolean;
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

  constructor(
    renderer: THREE.WebGLRenderer,
    onChange?: (settings: GraphicsSettings, gpu: GpuInfo) => void,
  ) {
    if (onChange) {
      this.onChange = onChange;
    }

    this.gpu = this.probeWebGL(renderer);

    const saved = loadSavedSettings();
    this.settings = saved ?? makePresetSettings(this.gpu.recommended);

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
    const recommended = classifyGpu(rendererName, vendor, appleSilicon);

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
    saveSettings(this.settings);
    this.emitChange();
  }

  getTargetDpr(): number {
    const deviceDpr = typeof window !== "undefined" && typeof window.devicePixelRatio === "number" ? window.devicePixelRatio : 1;
    let maxDpr = PRESET_SPECS[this.settings.preset].maxDpr;
    // On Retina Apple Silicon MacBooks, cap Ultra DPR at 1.75 (saves ~24% fragment fillrate on 3K+ screens with crisp Retina sharpness)
    if (this.gpu.appleSilicon && this.settings.preset === "ultra") {
      maxDpr = Math.min(maxDpr, 1.75);
    }
    const baseDpr = Math.min(Math.max(1, deviceDpr), maxDpr);
    const scaled = this.settings.dynamicRes ? baseDpr * this.dynamicScale : baseDpr;
    return Math.max(0.5, Math.round(scaled * 100) / 100);
  }

  getBloomScale(): number {
    // Half-res bloom cuts Metal TBDR tile-memory bandwidth by ~70% with identical visual glow
    return this.gpu.appleSilicon || this.settings.preset !== "ultra" ? 0.5 : 0.75;
  }

  getShadowSize(): number {
    return PRESET_SPECS[this.settings.preset].shadowSize;
  }

  getShadowUpdateStride(): number {
    return PRESET_SPECS[this.settings.preset].shadowUpdateStride;
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

    let scaleChanged = false;

    if (this.settings.dynamicRes) {
      this.govFrameCount++;
      if (this.govFrameCount >= 45) {
        this.govFrameCount = 0;
        if (emaFps < 46 && this.dynamicScale > 0.65) {
          const next = Math.max(0.65, Math.round((this.dynamicScale - 0.1) * 100) / 100);
          if (next !== this.dynamicScale) {
            this.dynamicScale = next;
            scaleChanged = true;
          }
        } else if (emaFps > 57 && this.dynamicScale < 1.0) {
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
