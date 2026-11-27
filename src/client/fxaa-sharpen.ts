import { Vector2 } from "three";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";

// Deliberately conservative maximum: roughly 0.3-0.5 of the punch of a
// typical full-strength RCAS/unsharp installation. Dynamic-resolution loss
// modulates this CPU-side so native-resolution rendering is bit-identical
// aside from FXAA itself.
const MAX_SHARPEN_STRENGTH = 0.34;
// The governor's reachable non-native steps are <= 0.95 (down in 10% steps,
// back up in 5% steps). Treat any real governed downscale as active at full
// conservative strength; only exact/native rendering leaves sharpening off.
const DYNAMIC_LOSS_EPSILON = 0.001;

// three.js r0.187's FXAAShader ends with a tiny main() around the battle-tested
// ApplyFXAA implementation. Reuse all of that shader machinery verbatim and
// replace only the epilogue: this keeps the well-tuned edge search exact while
// adding a few color taps for the mild contrast-adaptive sharpen. If a future
// three.js restructures the shader, fall back to unmodified FXAA rather than
// risking a broken final pass.
function createFxaaSharpenFragment(): string {
  const mainIndex = FXAAShader.fragmentShader.lastIndexOf("void main()");
  if (mainIndex < 0) {
    return FXAAShader.fragmentShader;
  }

  return `uniform float uSharpenStrength;
${FXAAShader.fragmentShader.slice(0, mainIndex)}

vec4 ApplyFXAASharpen(sampler2D tex2D, vec2 texSize, vec2 uv) {
  vec4 aa = ApplyFXAA(tex2D, texSize, uv);

  if (uSharpenStrength <= 0.0001) {
    return aa;
  }

  // Five-tap contrast-adaptive sharpen. FXAA supplies the anti-aliased base;
  // the raw center/cross taps reconstruct only the high-frequency detail that
  // dynamic-resolution scaling blurred away. The nonlinear gates matter:
  // flat/noise-like regions are left alone, and very strong edges are damped
  // so sharpening cannot undo FXAA or produce black/white halos.
  vec3 c = texture(tex2D, uv).rgb;
  vec3 n = texture(tex2D, uv + vec2(0.0, texSize.y)).rgb;
  vec3 e = texture(tex2D, uv + vec2(texSize.x, 0.0)).rgb;
  vec3 s = texture(tex2D, uv - vec2(0.0, texSize.y)).rgb;
  vec3 w = texture(tex2D, uv - vec2(texSize.x, 0.0)).rgb;

  vec3 crossAvg = (n + e + s + w) * 0.25;
  vec3 highFreq = c - crossAvg;

  const vec3 lumaW = vec3(0.3, 0.59, 0.11);
  float lumC = dot(c, lumaW);
  vec4 lumCross = vec4(dot(n, lumaW), dot(e, lumaW), dot(s, lumaW), dot(w, lumaW));
  float lumMax = max(max(max(lumCross.x, lumCross.y), max(lumCross.z, lumCross.w)), lumC);
  float lumMin = min(min(min(lumCross.x, lumCross.y), min(lumCross.z, lumCross.w)), lumC);
  float localContrast = lumMax - lumMin;

  float noiseGate = smoothstep(0.0015, 0.006, localContrast);
  float edgeDamp = 1.0 - 0.45 * smoothstep(0.18, 0.48, localContrast);
  float amount = uSharpenStrength * noiseGate * edgeDamp;

  vec3 sharpened = aa.rgb + highFreq * amount;

  // Neighborhood clamp with a tiny contrast-proportional margin. Strictly
  // clamping to [min,max] would nullify most edge restoration; the small pad
  // allows crisp reconstruction while still bounding overshoot tightly enough
  // that halos remain imperceptible at this conservative strength.
  vec3 minRGB = min(c, min(min(n, e), min(s, w)));
  vec3 maxRGB = max(c, max(max(n, e), max(s, w)));
  vec3 pad = max((maxRGB - minRGB) * 0.08, vec3(0.002));
  sharpened = clamp(sharpened, minRGB - pad, maxRGB + pad);

  return vec4(sharpened, aa.a);
}

void main() {
  gl_FragColor = ApplyFXAASharpen(tDiffuse, resolution.xy, vUv);
}`;
}

const FXAA_SHARPEN_SHADER = {
  name: "FXAASharpenShader",
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new Vector2(1 / 1024, 1 / 512) },
    uSharpenStrength: { value: 0.0 },
  },
  vertexShader: FXAAShader.vertexShader,
  fragmentShader: createFxaaSharpenFragment(),
};

/**
 * Final LDR pass for the composer path: canonical three.js FXAA followed by a
 * conservative RCAS-style sharpen in the same fullscreen invocation. It must
 * sit after OutputPass because FXAA expects perceptual/sRGB-encoded input.
 */
export class FXAASharpenPass extends ShaderPass {
  constructor() {
    super(FXAA_SHARPEN_SHADER);
  }

  override setSize(width: number, height: number): void {
    this.uniforms.resolution.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }

  setDynamicResolutionScale(scale: number): void {
    const safeScale = Number.isFinite(scale) ? Math.max(0, Math.min(1, scale)) : 1;
    const dynamicLoss = 1 - safeScale;
    // Dynamic res moves in coarse 10%/5% steps rather than continuously, so a
    // binary gate is the correct strength scaling: native is exactly off and
    // any governed downscale receives the full conservative cap.
    const active = dynamicLoss > DYNAMIC_LOSS_EPSILON ? 1 : 0;
    this.uniforms.uSharpenStrength.value = MAX_SHARPEN_STRENGTH * active;
  }
}
