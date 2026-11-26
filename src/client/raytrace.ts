import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { QualityPreset } from "./graphics";

const RAYTRACE_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Half-resolution effect generation. This shader deliberately does NOT output a
// final beauty pixel: RGB is the additive reflection/atmospheric contribution
// and A is the multiplicative transmission of the underlying base color after
// AO, contact shadowing, and reflection replacement. The full-resolution
// composite below reconstructs final color as base * A + RGB, which is exactly
// the algebra of the original single-pass pipeline while keeping the expensive
// ray marching at reduced resolution.
const RAYTRACE_EFFECT_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4 uProjection;
uniform mat4 uInvProjection;
uniform mat4 uInvView;
uniform vec3 uSunViewDir;
uniform float uCameraNear;
uniform float uCameraFar;
uniform vec2 uResolution;
uniform vec2 uFullResolution;
uniform float uWaterY;
uniform float uHasWater;
uniform float uHasDepth;
uniform float uEnableSsr;
uniform float uEnableContactShadows;
uniform int uSsrSteps;
uniform int uShadowSteps;
uniform float uAoStrength;

varying vec2 vUv;

const int MAX_SSR_STEPS = 24;
const int MAX_SHADOW_STEPS = 8;
const float PI = 3.14159265359;
const float GOLDEN_ANGLE = 2.39996322973;
const vec4 NEUTRAL_EFFECT = vec4(0.0, 0.0, 0.0, 1.0);

float interleavedGradientNoise(vec2 pixelPos) {
  vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
  return fract(magic.z * fract(dot(pixelPos, magic.xy)));
}

float getLinearDepth(float depth) {
  float zNdc = depth * 2.0 - 1.0;
  return (2.0 * uCameraNear * uCameraFar) /
         max(uCameraFar + uCameraNear - zNdc * (uCameraFar - uCameraNear), 1e-4);
}

vec3 getViewPos(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = uInvProjection * clip;
  return view.xyz / max(abs(view.w), 1e-6);
}

vec3 projectViewToScreen(vec3 viewPos) {
  vec4 clip = uProjection * vec4(viewPos, 1.0);
  float invW = 1.0 / max(abs(clip.w), 1e-6);
  return (clip.xyz * invW) * 0.5 + 0.5;
}

void main() {
  // Canonicalize the interpolated UV back to this half-res texel's exact
  // center. Besides removing rasterizer/interpolator roundoff, this is the
  // same center formula the composite pass uses for every low-res tap, so the
  // depth used to generate an effect texel and the depth used to weight it in
  // the bilateral reconstruction resolve to the same logical texel sample.
  vec2 effectPixel = floor(vUv * uResolution);
  effectPixel = min(effectPixel, uResolution - vec2(1.0));
  vec2 centerUv = (effectPixel + vec2(0.5)) / uResolution;

  vec4 baseSample = texture2D(tDiffuse, centerUv);

  // Passthrough cleanly if no depth texture is bound yet
  if (uHasDepth < 0.5) {
    gl_FragColor = NEUTRAL_EFFECT;
    return;
  }

  float depth = texture2D(tDepth, centerUv).x;

  // Guard sky dome pixels so they pass straight through at 100% speed
  if (depth >= 0.9999) {
    gl_FragColor = NEUTRAL_EFFECT;
    return;
  }

  // Fast passthrough when all raytraced effects are disabled
  if (uEnableSsr < 0.5 && uEnableContactShadows < 0.5 && uAoStrength <= 0.001) {
    gl_FragColor = NEUTRAL_EFFECT;
    return;
  }

  vec3 baseColor = baseSample.rgb;
  vec3 vPos = getViewPos(centerUv, depth);
  float viewDist = max(-vPos.z, uCameraNear);
  vec3 viewDir = normalize(vPos);

  // Smooth view-space normal reconstruction via screen-space derivatives
  vec3 dpdx = dFdx(vPos);
  vec3 dpdy = dFdy(vPos);
  vec3 rawNormal = cross(dpdx, dpdy);
  float rawLen = length(rawNormal);
  vec3 normal = (rawLen > 1e-6 && rawLen < 1e12) ? (rawNormal / rawLen) : vec3(0.0, 0.0, 1.0);
  if (dot(normal, -viewDir) < 0.0) {
    normal = -normal;
  }

  // World-space position & normal for water/armor surface classification
  vec3 worldPos = (uInvView * vec4(vPos, 1.0)).xyz;
  vec3 worldNormal = normalize(mat3(uInvView) * normal);

  // World +Y transformed into view space via R^T = row 1 of uInvView
  vec3 viewWorldUp = normalize(vec3(uInvView[0][1], uInvView[1][1], uInvView[2][1]));

  // Detect ocean/water pixels cleanly (handles depthWrite:false water over flat seabed too)
  float waterMask = 0.0;
  if (uHasWater > 0.5) {
    float nearWaterY = 1.0 - smoothstep(0.08, 0.24, abs(worldPos.y - uWaterY));
    float flatUp = smoothstep(0.84, 0.96, worldNormal.y);
    float blueRatio = smoothstep(1.12, 1.48, baseColor.b / max(baseColor.r, 0.004));
    float cyanLift = smoothstep(0.012, 0.055, baseColor.b - baseColor.r * 0.9);
    waterMask = nearWaterY * flatUp * blueRatio * cyanLift;
  }

  // Stabilize reflection normal on flat water to eliminate 2x2 quad aliasing
  vec3 reflNormal = normalize(mix(normal, viewWorldUp, waterMask * 0.88));
  if (dot(reflNormal, -viewDir) < 0.0) {
    reflNormal = -reflNormal;
  }

  float noise = interleavedGradientNoise(centerUv * uResolution);
  float distFade = 1.0 - smoothstep(135.0, 260.0, viewDist);

  float attenuation = 1.0;
  float reflectionBlend = 0.0;
  vec3 reflectionContrib = vec3(0.0);
  vec3 additiveContrib = vec3(0.0);

  // =========================================================================
  // 1. Fast 6-Tap Spiral Screen-Space Ambient Occlusion (SSAO)
  // =========================================================================
  if (uAoStrength > 0.001 && distFade > 0.01) {
    float aoWorldRadius = clamp(viewDist * 0.036, 0.42, 2.15);
    vec2 uvRadius = vec2(uProjection[0][0], uProjection[1][1]) * (aoWorldRadius / viewDist) * 0.5;
    // Pixel clamps remain expressed in full-resolution pixels even though this
    // pass runs at reduced resolution; otherwise halving the target would
    // double the screen-space AO kernel and visibly change the art direction.
    vec2 minRad = vec2(1.5) / uFullResolution;
    vec2 maxRad = vec2(26.0) / uFullResolution;
    uvRadius = clamp(uvRadius, minRad, maxRad);

    float angleOffset = noise * 2.0 * PI;
    float occ = 0.0;

    for (int i = 0; i < 6; i++) {
      float fi = (float(i) + 0.5) / 6.0;
      float r = sqrt(fi);
      float theta = float(i) * GOLDEN_ANGLE + angleOffset;
      vec2 tapUv = centerUv + vec2(cos(theta), sin(theta)) * (uvRadius * r);

      if (tapUv.x <= 0.001 || tapUv.x >= 0.999 || tapUv.y <= 0.001 || tapUv.y >= 0.999) {
        continue;
      }

      float tapDepth = texture2D(tDepth, tapUv).x;
      if (tapDepth >= 0.9999) {
        continue;
      }

      vec3 tapPos = getViewPos(tapUv, tapDepth);
      vec3 delta = tapPos - vPos;
      float dLen = length(delta);
      if (dLen > 1e-4) {
        // Depth-quantization rejection: on near-planar surfaces the 24-bit depth
        // reconstruction error lifts coplanar taps slightly off the plane in a
        // screen-periodic pattern; a flat tiny bias lets them through as regular
        // horizontal scanline bands. The angular error grows with view distance,
        // so the bias scales with it while true upright occluders (unit hulls,
        // walls) still exceed it easily.
        float aoBias = 0.14 + viewDist * 0.0052;
        float horizon = max(0.0, dot(normal, delta / dLen) - aoBias);
        float rangeCheck = 1.0 - smoothstep(aoWorldRadius * 0.35, aoWorldRadius * 1.45, dLen);
        occ += horizon * rangeCheck;
      }
    }

    occ = (occ / 6.0) * (1.0 - waterMask * 0.85) * distFade;
    float aoFactor = clamp(1.0 - occ * uAoStrength * 1.45, 0.72, 1.0);
    attenuation *= aoFactor;
  }

  // =========================================================================
  // 2. Ray-Marched Screen-Space Contact Shadows (SSCS)
  // =========================================================================
  if (uEnableContactShadows > 0.5 && waterMask < 0.85 && distFade > 0.01) {
    float nDotL = dot(normal, uSunViewDir);
    if (nDotL > 0.04) {
      float shadowDist = clamp(viewDist * 0.032, 0.35, 1.85);
      float stepLen = shadowDist / float(max(uShadowSteps, 1));
      vec3 rayOrigin = vPos + normal * max(0.025, viewDist * 0.0018);
      float minBias = max(0.03, viewDist * 0.0014);
      float maxThickness = max(0.42, shadowDist * 0.65);

      float contactOcc = 0.0;
      float jitter = 0.35 + noise * 0.65;

      for (int s = 0; s < MAX_SHADOW_STEPS; s++) {
        if (s >= uShadowSteps) break;

        float t = stepLen * (float(s) + jitter);
        vec3 samplePos = rayOrigin + uSunViewDir * t;
        if (samplePos.z >= -uCameraNear) break;

        vec3 proj = projectViewToScreen(samplePos);
        if (proj.x <= 0.001 || proj.x >= 0.999 || proj.y <= 0.001 || proj.y >= 0.999) {
          break;
        }

        float sDepth = texture2D(tDepth, proj.xy).x;
        if (sDepth >= 0.9999) continue;

        float sceneZ = getLinearDepth(sDepth);
        float rayZ = -samplePos.z;
        float diff = rayZ - sceneZ;

        if (diff > minBias && diff < maxThickness) {
          float stepFade = 1.0 - smoothstep(0.15, 1.0, float(s) / float(max(uShadowSteps, 1)));
          float thickFade = 1.0 - smoothstep(maxThickness * 0.45, maxThickness, diff);
          vec2 edge = min(proj.xy, 1.0 - proj.xy);
          float edgeFade = smoothstep(0.0, 0.05, min(edge.x, edge.y));
          contactOcc = max(contactOcc, stepFade * thickFade * edgeFade);
        }
      }

      float sunFade = smoothstep(0.04, 0.24, nDotL);
      float shadowStrength = contactOcc * sunFade * (1.0 - waterMask) * distFade;
      attenuation *= mix(1.0, 0.66, shadowStrength);
    }
  }

  // =========================================================================
  // 3. Screen-Space Raytraced Reflections (SSR) — Water & Metallic Armor
  // =========================================================================
  if (uEnableSsr > 0.5) {
    float luma = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
    float ndotv = max(dot(-viewDir, reflNormal), 0.0);
    float fresnel = pow(1.0 - ndotv, 3.0);

    // Water gets rich mirror-like Fresnel reflections; elevated metallic/glossy armor gets crisp grazing sheen
    float elevatedMask = smoothstep(uWaterY + 0.14, uWaterY + 0.48, worldPos.y);
    float glossHint = smoothstep(0.06, 0.55, luma);
    float metalRefl = elevatedMask * fresnel * mix(0.18, 0.44, glossHint);
    float waterRefl = waterMask * mix(0.32, 0.76, fresnel);
    float reflStrength = max(waterRefl, metalRefl) * (1.0 - smoothstep(160.0, 320.0, viewDist));

    if (reflStrength > 0.03) {
      vec3 reflDir = normalize(reflect(viewDir, reflNormal));
      // Smoothly attenuate reflections pointing straight back toward the camera
      float camDirFade = 1.0 - smoothstep(0.05, 0.35, reflDir.z);

      if (camDirFade > 0.01) {
        float maxDist = clamp(viewDist * 0.58, 4.5, 44.0);
        vec3 rayOrigin = vPos + reflNormal * (0.045 + viewDist * 0.0025);

        float invSteps = 1.0 / float(max(uSsrSteps, 1));
        vec3 prevPos = rayOrigin;
        vec2 hitUv = vec2(0.0);
        float hitStepFrac = 1.0;
        bool didHit = false;

        for (int i = 0; i < MAX_SSR_STEPS; i++) {
          if (i >= uSsrSteps) break;

          // Slightly quadratic step progression keeps near contacts razor-sharp while reaching distant skylines
          float f0 = (float(i) + 0.25 + noise * 0.75) * invSteps;
          float t = maxDist * (0.28 * f0 + 0.72 * f0 * f0);
          vec3 currPos = rayOrigin + reflDir * t;

          if (currPos.z >= -uCameraNear) break;

          vec3 proj = projectViewToScreen(currPos);
          if (proj.x <= 0.0 || proj.x >= 1.0 || proj.y <= 0.0 || proj.y >= 1.0) {
            break;
          }

          float sampleDepth = texture2D(tDepth, proj.xy).x;
          if (sampleDepth < 0.9999) {
            float sceneZ = getLinearDepth(sampleDepth);
            float rayZ = -currPos.z;
            float dz = rayZ - sceneZ;
            float segLen = length(currPos - prevPos);
            float thickness = max(0.30, segLen * 1.65 + rayZ * 0.016);

            if (dz > 0.0 && dz < thickness) {
              // 3-step binary search refinement to pinpoint exact surface intersection
              vec3 lo = prevPos;
              vec3 hi = currPos;
              vec2 bestUv = proj.xy;

              for (int b = 0; b < 3; b++) {
                vec3 mid = 0.5 * (lo + hi);
                vec3 midProj = projectViewToScreen(mid);
                if (midProj.x > 0.0 && midProj.x < 1.0 && midProj.y > 0.0 && midProj.y < 1.0) {
                  float midDepth = texture2D(tDepth, midProj.xy).x;
                  if (midDepth < 0.9999) {
                    float midSceneZ = getLinearDepth(midDepth);
                    float midRayZ = -mid.z;
                    if (midRayZ > midSceneZ) {
                      hi = mid;
                      bestUv = midProj.xy;
                    } else {
                      lo = mid;
                    }
                  } else {
                    lo = mid;
                  }
                } else {
                  hi = mid;
                }
              }

              float refinedDepth = texture2D(tDepth, bestUv).x;
              if (refinedDepth < 0.9999) {
                hitUv = bestUv;
                hitStepFrac = float(i) * invSteps;
                didHit = true;
              }
              break;
            }
          }

          prevPos = currPos;
        }

        if (didHit) {
          vec2 edgeDist = min(hitUv, 1.0 - hitUv);
          float edgeFade = smoothstep(0.0, 0.12, min(edgeDist.x, edgeDist.y));
          float rayFade = 1.0 - smoothstep(0.62, 1.0, hitStepFrac);
          float hitConf = edgeFade * rayFade * camDirFade;

          vec3 reflColor = min(texture2D(tDiffuse, hitUv).rgb, vec3(3.5));
          // Gently tint water reflections with ocean depth color while keeping luminous highlights vivid
          vec3 waterTint = mix(vec3(1.0), clamp(baseColor * 1.6 + vec3(0.28, 0.42, 0.52), 0.55, 1.15), waterMask * 0.22);
          reflColor *= waterTint;

          reflectionBlend = clamp(reflStrength * hitConf, 0.0, 0.72);
          reflectionContrib = reflColor * reflectionBlend;
        }
      }
    }
  }

  // =========================================================================
  // 4. Subtle Atmospheric Sun Glint & Volumetric Horizon Polish
  // =========================================================================
  if (waterMask > 0.05) {
    vec3 waterReflDir = reflect(viewDir, reflNormal);
    float sunSpec = pow(max(dot(waterReflDir, uSunViewDir), 0.0), 56.0);
    float sunBroad = pow(max(dot(waterReflDir, uSunViewDir), 0.0), 10.0) * 0.14;
    vec3 glintTint = vec3(1.05, 0.96, 0.80);
    additiveContrib += glintTint * (sunSpec * 0.65 + sunBroad) * waterMask;
  }

  // Gentle sunlit atmospheric forward-scatter shimmer at distant ridges (vibrant, never washes out)
  float horizonDepth = smoothstep(55.0, 220.0, viewDist);
  float sunForward = pow(max(dot(viewDir, uSunViewDir), 0.0), 5.0);
  additiveContrib += vec3(1.0, 0.92, 0.78) * (horizonDepth * sunForward * 0.045);

  // Premultiplied effect decomposition consumed by the composite pass:
  //   final = fullResBase * attenuation * (1 - reflectionBlend)
  //           + reflColor * reflectionBlend
  //           + additivePolish
  // Alpha packs the two base-color multipliers together; RGB packs the two
  // additive terms together. No precision-critical value is clamped away in
  // the normal HalfFloat path, and the neutral passthrough remains exactly
  // vec4(0,0,0,1).
  float baseTransmission = clamp(attenuation * (1.0 - reflectionBlend), 0.0, 1.0);
  vec3 effectContrib = max(reflectionContrib + additiveContrib, vec3(0.0));
  gl_FragColor = vec4(effectContrib, baseTransmission);
}
`;

// Full-resolution depth-aware reconstruction. The low-res effect pass samples
// the SAME full-resolution depth texture at its own texel centers, so sampling
// that depth texture again at those centers gives the exact surface depth that
// generated each effect texel — no separate downsampled-depth target needed.
const RAYTRACE_COMPOSITE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tEffect;
uniform float uCameraNear;
uniform float uCameraFar;
uniform vec2 uResolution;
uniform vec2 uEffectResolution;
uniform float uHasDepth;
uniform float uEnableSsr;
uniform float uEnableContactShadows;
uniform float uAoStrength;

varying vec2 vUv;

float getLinearDepth(float depth) {
  float zNdc = depth * 2.0 - 1.0;
  return (2.0 * uCameraNear * uCameraFar) /
         max(uCameraFar + uCameraNear - zNdc * (uCameraFar - uCameraNear), 1e-4);
}

vec2 effectTapUv(vec2 pixel) {
  vec2 maxPixel = max(uEffectResolution - vec2(1.0), vec2(0.0));
  vec2 clampedPixel = clamp(pixel, vec2(0.0), maxPixel);
  return (clampedPixel + vec2(0.5)) / uEffectResolution;
}

float effectDepthTolerance(float fullZ) {
  return max(uCameraNear * 0.12, fullZ * 0.02);
}

float effectDepthWeight(vec2 tapUv, float fullZ, float bilinearWeight) {
  if (bilinearWeight <= 0.00001) {
    return 0.0;
  }

  float tapDepth = texture2D(tDepth, tapUv).x;
  if (tapDepth >= 0.9999) {
    return 0.0;
  }

  float tapZ = getLinearDepth(tapDepth);
  float depthDelta = abs(fullZ - tapZ);

  // Relative bilateral range: forgiving enough for the continuous depth slope
  // of terrain/cliff planes, strict enough that unit hulls, walls, and water
  // silhouettes reject the opposite side of a depth discontinuity. The smooth
  // inner shoulder avoids binary sparkle along nearly-aligned edges.
  float tolerance = effectDepthTolerance(fullZ);
  float depthWeight = 1.0 - smoothstep(tolerance * 0.35, tolerance, depthDelta);
  return bilinearWeight * depthWeight;
}

void main() {
  vec4 baseSample = texture2D(tDiffuse, vUv);

  // Passthrough cleanly if no depth texture is bound yet
  if (uHasDepth < 0.5) {
    gl_FragColor = baseSample;
    return;
  }

  float depth = texture2D(tDepth, vUv).x;

  // Guard sky dome pixels so they pass straight through at 100% speed
  if (depth >= 0.9999) {
    gl_FragColor = baseSample;
    return;
  }

  // Fast passthrough when all raytraced effects are disabled
  if (uEnableSsr < 0.5 && uEnableContactShadows < 0.5 && uAoStrength <= 0.001) {
    gl_FragColor = baseSample;
    return;
  }

  float fullZ = getLinearDepth(depth);

  // Manual bilinear footprint in effect-texel space. Explicit taps (rather
  // than hardware linear filtering) let every candidate carry an independent
  // depth weight, so foreground shadows/AO cannot bleed onto background sky or
  // distant terrain across a silhouette.
  vec2 lowPixel = vUv * uEffectResolution - vec2(0.5);
  vec2 basePixel = floor(lowPixel);
  vec2 fracPixel = lowPixel - basePixel;

  vec2 uv00 = effectTapUv(basePixel);
  vec2 uv10 = effectTapUv(basePixel + vec2(1.0, 0.0));
  vec2 uv01 = effectTapUv(basePixel + vec2(0.0, 1.0));
  vec2 uv11 = effectTapUv(basePixel + vec2(1.0, 1.0));

  float w00 = effectDepthWeight(uv00, fullZ, (1.0 - fracPixel.x) * (1.0 - fracPixel.y));
  float w10 = effectDepthWeight(uv10, fullZ, fracPixel.x * (1.0 - fracPixel.y));
  float w01 = effectDepthWeight(uv01, fullZ, (1.0 - fracPixel.x) * fracPixel.y);
  float w11 = effectDepthWeight(uv11, fullZ, fracPixel.x * fracPixel.y);

  vec4 weightedEffect =
    texture2D(tEffect, uv00) * w00 +
    texture2D(tEffect, uv10) * w10 +
    texture2D(tEffect, uv01) * w01 +
    texture2D(tEffect, uv11) * w11;
  float weightSum = w00 + w10 + w01 + w11;

  vec4 effect;
  if (weightSum > 0.01) {
    effect = weightedEffect / weightSum;
  } else {
    // A thin depth discontinuity can reject the whole bilinear footprint. In
    // that case use the nearest low-res texel only when it is still the same
    // surface; otherwise fall back to the neutral effect. This favors a tiny
    // one-pixel loss of AO/SSR over the far more visible alternative: colored
    // reflection or shadow halos leaking across object edges.
    vec2 nearestPixel = floor(lowPixel + vec2(0.5));
    vec2 nearestUv = effectTapUv(nearestPixel);
    float nearestDepth = texture2D(tDepth, nearestUv).x;
    float nearestZ = getLinearDepth(nearestDepth);
    float tolerance = effectDepthTolerance(fullZ);
    if (nearestDepth < 0.9999 && abs(nearestZ - fullZ) <= tolerance) {
      effect = texture2D(tEffect, nearestUv);
    } else {
      effect = vec4(0.0, 0.0, 0.0, 1.0);
    }
  }

  vec3 color = baseSample.rgb * effect.a + effect.rgb;
  gl_FragColor = vec4(max(color, vec3(0.0)), baseSample.a);
}
`;

export class RaytracePass extends Pass {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Half-res effect-generation shader; quality/water uniforms live here. */
  readonly material: THREE.ShaderMaterial;
  /** Full-res bilateral reconstruction shader. */
  readonly compositeMaterial: THREE.ShaderMaterial;

  private fsQuad: FullScreenQuad;
  private effectTarget: THREE.WebGLRenderTarget;
  private depthTexture: THREE.DepthTexture | null = null;
  private sunDirWorld = new THREE.Vector3(-42, 58, 28).normalize();
  private sunViewDir = new THREE.Vector3();
  private appleSilicon = false;
  private qualityPreset: QualityPreset = "high";
  private effectScale = 0.5;
  private fullWidth: number;
  private fullHeight: number;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    effectType: THREE.TextureDataType = THREE.HalfFloatType,
  ) {
    super();
    this.scene = scene;
    this.camera = camera;

    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.fullWidth = w;
    this.fullHeight = h;

    const effectW = this.effectWidth();
    const effectH = this.effectHeight();

    this.material = new THREE.ShaderMaterial({
      name: "RaytraceEffectShader",
      vertexShader: RAYTRACE_VERT,
      fragmentShader: RAYTRACE_EFFECT_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uProjection: { value: new THREE.Matrix4() },
        uInvProjection: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
        uSunViewDir: { value: new THREE.Vector3(0, 1, 0) },
        uCameraNear: { value: camera.near },
        uCameraFar: { value: camera.far },
        uResolution: { value: new THREE.Vector2(effectW, effectH) },
        uFullResolution: { value: new THREE.Vector2(w, h) },
        uWaterY: { value: 0.03 },
        uHasWater: { value: 0.0 },
        uHasDepth: { value: 0.0 },
        uEnableSsr: { value: 1.0 },
        uEnableContactShadows: { value: 1.0 },
        uSsrSteps: { value: 18 },
        uShadowSteps: { value: 6 },
        uAoStrength: { value: 0.36 },
      },
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      name: "RaytraceCompositeShader",
      vertexShader: RAYTRACE_VERT,
      fragmentShader: RAYTRACE_COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        tEffect: { value: null },
        uCameraNear: { value: camera.near },
        uCameraFar: { value: camera.far },
        uResolution: { value: new THREE.Vector2(w, h) },
        uEffectResolution: { value: new THREE.Vector2(effectW, effectH) },
        uHasDepth: { value: 0.0 },
        uEnableSsr: { value: 1.0 },
        uEnableContactShadows: { value: 1.0 },
        uAoStrength: { value: 0.36 },
      },
    });

    // Nearest filtering is intentional: the composite performs its own
    // bilateral interpolation and must receive unblended effect texels at the
    // exact centers it weights. The target is color-only — depth is always
    // reconstructed from the authoritative full-resolution scene depth texture.
    this.effectTarget = new THREE.WebGLRenderTarget(effectW, effectH, {
      type: effectType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.effectTarget.texture.name = "RaytracePass.effects";

    this.fsQuad = new FullScreenQuad(this.material);
  }

  private effectWidth(): number {
    return Math.max(1, Math.floor(this.fullWidth * this.effectScale));
  }

  private effectHeight(): number {
    return Math.max(1, Math.floor(this.fullHeight * this.effectScale));
  }

  private syncEffectResolution(): void {
    const ew = this.effectWidth();
    const eh = this.effectHeight();
    if (this.effectTarget.width !== ew || this.effectTarget.height !== eh) {
      // WebGLRenderTarget.setSize disposes the previous GPU allocation only
      // when dimensions actually change, so DPR/quality oscillation cannot leak
      // a trail of half-res effect buffers.
      this.effectTarget.setSize(ew, eh);
    }
    this.material.uniforms.uResolution.value.set(ew, eh);
    this.material.uniforms.uFullResolution.value.set(this.fullWidth, this.fullHeight);
    this.compositeMaterial.uniforms.uResolution.value.set(this.fullWidth, this.fullHeight);
    this.compositeMaterial.uniforms.uEffectResolution.value.set(ew, eh);
  }

  private updateEffectScale(): void {
    // Apple Silicon ultra already caps DPR lower and is especially sensitive to
    // TBDR bandwidth; 0.4 keeps SSR/contact shadow structure visually intact
    // there while every other tier uses the safer half-resolution default.
    const next = this.qualityPreset === "ultra" && this.appleSilicon ? 0.4 : 0.5;
    if (next !== this.effectScale) {
      this.effectScale = next;
    }
    this.syncEffectResolution();
  }

  setDepthTexture(tex: THREE.DepthTexture): void {
    this.depthTexture = tex;
    this.material.uniforms.tDepth.value = tex;
    this.material.uniforms.uHasDepth.value = tex ? 1.0 : 0.0;
    this.compositeMaterial.uniforms.tDepth.value = tex;
    this.compositeMaterial.uniforms.uHasDepth.value = tex ? 1.0 : 0.0;
  }

  setSunDirection(dir: THREE.Vector3): void {
    if (dir.lengthSq() > 1e-8) {
      this.sunDirWorld.copy(dir).normalize();
    }
  }

  setWaterLevel(y: number, hasWater: boolean): void {
    this.material.uniforms.uWaterY.value = y;
    this.material.uniforms.uHasWater.value = hasWater ? 1.0 : 0.0;
  }

  setAppleSilicon(on: boolean): void {
    this.appleSilicon = on;
    this.updateEffectScale();
  }

  setQuality(preset: QualityPreset, ssr: boolean, contactShadows: boolean): void {
    this.qualityPreset = preset;

    const u = this.material.uniforms;
    const cu = this.compositeMaterial.uniforms;
    u.uEnableSsr.value = ssr ? 1.0 : 0.0;
    u.uEnableContactShadows.value = contactShadows ? 1.0 : 0.0;
    cu.uEnableSsr.value = u.uEnableSsr.value;
    cu.uEnableContactShadows.value = u.uEnableContactShadows.value;

    switch (preset) {
      case "low":
        u.uSsrSteps.value = 12;
        u.uShadowSteps.value = 6;
        u.uAoStrength.value = ssr || contactShadows ? 0.24 : 0.0;
        break;
      case "medium":
        u.uSsrSteps.value = 14;
        u.uShadowSteps.value = 6;
        u.uAoStrength.value = 0.34;
        break;
      case "high":
        u.uSsrSteps.value = this.appleSilicon ? 15 : 18;
        u.uShadowSteps.value = 6;
        u.uAoStrength.value = 0.40;
        break;
      case "ultra":
        u.uSsrSteps.value = this.appleSilicon ? 20 : 24;
        u.uShadowSteps.value = 8;
        u.uAoStrength.value = 0.44;
        break;
    }

    cu.uAoStrength.value = u.uAoStrength.value;
    this.updateEffectScale();
  }

  override setSize(w: number, h: number): void {
    this.fullWidth = Math.max(1, w);
    this.fullHeight = Math.max(1, h);
    this.syncEffectResolution();
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    _deltaTime?: number,
    _maskActive?: boolean,
  ): void {
    this.camera.updateMatrixWorld();

    // The composer's read buffer is authoritative: renderTarget1/2 ping-pong
    // every frame and each carries its own DepthTexture. Using readBuffer here
    // (rather than a stale cached pointer) guarantees the effect pass samples
    // the depth of the exact beauty texture it is reading, while the composite
    // writes only to the opposite composer buffer — never a feedback loop.
    const fallbackDepth = this.depthTexture !== writeBuffer.depthTexture ? this.depthTexture : null;
    const activeDepth = readBuffer.depthTexture ?? fallbackDepth;

    if (readBuffer && readBuffer.width > 0 && readBuffer.height > 0) {
      if (readBuffer.width !== this.fullWidth || readBuffer.height !== this.fullHeight) {
        this.setSize(readBuffer.width, readBuffer.height);
      }
    }

    const u = this.material.uniforms;
    const cu = this.compositeMaterial.uniforms;

    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = activeDepth;
    u.uHasDepth.value = activeDepth ? 1.0 : 0.0;

    u.uProjection.value.copy(this.camera.projectionMatrix);
    u.uInvProjection.value.copy(this.camera.projectionMatrixInverse);
    u.uInvView.value.copy(this.camera.matrixWorld);

    this.sunViewDir.copy(this.sunDirWorld).transformDirection(this.camera.matrixWorldInverse).normalize();
    u.uSunViewDir.value.copy(this.sunViewDir);

    u.uCameraNear.value = this.camera.near;
    u.uCameraFar.value = this.camera.far;

    // 1. March SSR/contact-shadow rays and integrate AO at reduced resolution
    // into the independent effect target. Neither the readBuffer color nor its
    // depth attachment is being rendered to here, so sampling both is legal.
    this.fsQuad.material = this.material;
    renderer.setRenderTarget(this.effectTarget);
    this.fsQuad.render(renderer);

    // 2. Reconstruct those premultiplied effect terms onto the full-res frame.
    // This pass reads readBuffer color/depth plus the independent effect target
    // and writes the opposite composer buffer (or screen), again with no
    // sampled texture simultaneously bound as the active render target.
    cu.tDiffuse.value = readBuffer.texture;
    cu.tDepth.value = activeDepth;
    cu.tEffect.value = this.effectTarget.texture;
    cu.uHasDepth.value = activeDepth ? 1.0 : 0.0;
    cu.uCameraNear.value = this.camera.near;
    cu.uCameraFar.value = this.camera.far;

    this.fsQuad.material = this.compositeMaterial;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) {
        renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
      }
      this.fsQuad.render(renderer);
    }
  }

  override dispose(): void {
    this.effectTarget.dispose();
    this.material.dispose();
    this.compositeMaterial.dispose();
    this.fsQuad.dispose();
  }
}
