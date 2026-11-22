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

const RAYTRACE_FRAG = /* glsl */ `
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

  vec3 baseColor = baseSample.rgb;
  vec3 vPos = getViewPos(vUv, depth);
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

  float noise = interleavedGradientNoise(vUv * uResolution);
  float distFade = 1.0 - smoothstep(135.0, 260.0, viewDist);

  vec3 color = baseColor;

  // =========================================================================
  // 1. Fast 6-Tap Spiral Screen-Space Ambient Occlusion (SSAO)
  // =========================================================================
  if (uAoStrength > 0.001 && distFade > 0.01) {
    float aoWorldRadius = clamp(viewDist * 0.036, 0.42, 2.15);
    vec2 uvRadius = vec2(uProjection[0][0], uProjection[1][1]) * (aoWorldRadius / viewDist) * 0.5;
    vec2 minRad = vec2(1.5) / uResolution;
    vec2 maxRad = vec2(26.0) / uResolution;
    uvRadius = clamp(uvRadius, minRad, maxRad);

    float angleOffset = noise * 2.0 * PI;
    float occ = 0.0;

    for (int i = 0; i < 6; i++) {
      float fi = (float(i) + 0.5) / 6.0;
      float r = sqrt(fi);
      float theta = float(i) * GOLDEN_ANGLE + angleOffset;
      vec2 tapUv = vUv + vec2(cos(theta), sin(theta)) * (uvRadius * r);

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
        float horizon = max(0.0, dot(normal, delta / dLen) - 0.14);
        float rangeCheck = 1.0 - smoothstep(aoWorldRadius * 0.35, aoWorldRadius * 1.45, dLen);
        occ += horizon * rangeCheck;
      }
    }

    occ = (occ / 6.0) * (1.0 - waterMask * 0.85) * distFade;
    float aoFactor = clamp(1.0 - occ * uAoStrength * 1.45, 0.72, 1.0);
    color *= aoFactor;
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
      color *= mix(1.0, 0.66, shadowStrength);
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

          float blendAmt = clamp(reflStrength * hitConf, 0.0, 0.72);
          color = mix(color, reflColor, blendAmt);
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
    color += glintTint * (sunSpec * 0.65 + sunBroad) * waterMask;
  }

  // Gentle sunlit atmospheric forward-scatter shimmer at distant ridges (vibrant, never washes out)
  float horizonDepth = smoothstep(55.0, 220.0, viewDist);
  float sunForward = pow(max(dot(viewDir, uSunViewDir), 0.0), 5.0);
  color += vec3(1.0, 0.92, 0.78) * (horizonDepth * sunForward * 0.045);

  gl_FragColor = vec4(max(color, vec3(0.0)), baseSample.a);
}
`;

export class RaytracePass extends Pass {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly material: THREE.ShaderMaterial;

  private fsQuad: FullScreenQuad;
  private depthTexture: THREE.DepthTexture | null = null;
  private sunDirWorld = new THREE.Vector3(-42, 58, 28).normalize();
  private sunViewDir = new THREE.Vector3();

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number) {
    super();
    this.scene = scene;
    this.camera = camera;

    const w = Math.max(1, width);
    const h = Math.max(1, height);

    this.material = new THREE.ShaderMaterial({
      name: "RaytracePassShader",
      vertexShader: RAYTRACE_VERT,
      fragmentShader: RAYTRACE_FRAG,
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
        uResolution: { value: new THREE.Vector2(w, h) },
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

    this.fsQuad = new FullScreenQuad(this.material);
  }

  setDepthTexture(tex: THREE.DepthTexture): void {
    this.depthTexture = tex;
    this.material.uniforms.tDepth.value = tex;
    this.material.uniforms.uHasDepth.value = tex ? 1.0 : 0.0;
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

  private appleSilicon = false;

  setAppleSilicon(on: boolean): void {
    this.appleSilicon = on;
  }

  setQuality(preset: QualityPreset, ssr: boolean, contactShadows: boolean): void {
    const u = this.material.uniforms;
    u.uEnableSsr.value = ssr ? 1.0 : 0.0;
    u.uEnableContactShadows.value = contactShadows ? 1.0 : 0.0;

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
  }

  override setSize(w: number, h: number): void {
    this.material.uniforms.uResolution.value.set(Math.max(1, w), Math.max(1, h));
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    _deltaTime?: number,
    _maskActive?: boolean,
  ): void {
    this.camera.updateMatrixWorld();

    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;

    const activeDepth = this.depthTexture ?? readBuffer.depthTexture ?? null;
    u.tDepth.value = activeDepth;
    u.uHasDepth.value = activeDepth ? 1.0 : 0.0;

    u.uProjection.value.copy(this.camera.projectionMatrix);
    u.uInvProjection.value.copy(this.camera.projectionMatrixInverse);
    u.uInvView.value.copy(this.camera.matrixWorld);

    this.sunViewDir.copy(this.sunDirWorld).transformDirection(this.camera.matrixWorldInverse).normalize();
    u.uSunViewDir.value.copy(this.sunViewDir);

    u.uCameraNear.value = this.camera.near;
    u.uCameraFar.value = this.camera.far;

    if (readBuffer && readBuffer.width > 0 && readBuffer.height > 0) {
      u.uResolution.value.set(readBuffer.width, readBuffer.height);
    }

    this.fsQuad.material = this.material;

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
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
