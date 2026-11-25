#!/usr/bin/env node
// Adaptive Quality Governor grey-box suite — tier shedding on sustained low
// FPS, restoration on headroom, entity-pressure floors, effective settings,
// budgets, hardware safety caps, and user-ceiling preservation.
//   node test/gfxgov.mjs
// No sockets, no worker — the TS module hooks below let Node load src/*.ts.

import { registerHooks, createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z0-9]+$/i.test(specifier)) {
        return next(specifier + ".ts", context);
      }
      throw err;
    }
  },
  load(url, context, next) {
    const res = next(url, context);
    if (url.endsWith(".ts")) {
      const out = ts.transpileModule(String(res.source), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: url,
      });
      return { format: "module", source: out.outputText, shortCircuit: true };
    }
    return res;
  },
});

const { GraphicsManager } = await import("../src/client/graphics.ts");

// ---------- assert plumbing ----------
let passN = 0, failN = 0;
const fails = [];
const ok = (cond, name, ev = "") => {
  if (cond) { passN++; console.log(`ok: ${name}`); }
  else { failN++; fails.push(name); console.log(`FAIL: ${name} ${ev}`); }
};

// ---------- stub WebGL renderer (Intel iGPU profile) ----------
function makeStubRenderer(glName = "Intel UHD Graphics 620", webgl2 = true) {
  const gl = {
    RENDERER: 0x1f01,
    VENDOR: 0x1f00,
    getExtension: () => null,
    getParameter: (k) => (k === 0x1f01 ? glName : k === 0x1f00 ? "Intel Inc." : ""),
  };
  return {
    getContext: () => gl,
    capabilities: { isWebGL2: webgl2, maxTextureSize: 16384 },
    getPixelRatio: () => 1.5,
    info: { render: { calls: 120, triangles: 50000 } },
    setPixelRatio() {},
  };
}

function makeGfx() {
  const gm = new GraphicsManager(makeStubRenderer());
  // Private governor fields are plain JS props — bypass real-time dwell waits.
  gm.lastTierChangeMs = -1e9;
  return gm;
}

// ---------- 1. Hardware recommendation & caps ----------
{
  const gm = new GraphicsManager(makeStubRenderer());
  ok(gm.gpu.recommended === "medium", `Intel iGPU recommends medium (got ${gm.gpu.recommended})`);
  ok(gm.settings.preset === "medium", `no saved settings -> recommended preset (got ${gm.settings.preset})`);
  ok(gm.settings.autoQuality === true, "autoQuality defaults ON");
  const rt = new GraphicsManager(makeStubRenderer("NVIDIA GeForce RTX 4090", true));
  ok(rt.gpu.recommended === "ultra", `RTX dGPU recommends ultra (got ${rt.gpu.recommended})`);
  const w1 = new GraphicsManager(makeStubRenderer("AMD Radeon RX 7900 XTX", false));
  ok(w1.gpu.recommended !== "ultra" && w1.gpu.recommended !== "high", `WebGL1 caps at medium (got ${w1.gpu.recommended})`);
}

// ---------- 2. Governor sheds tiers on sustained low FPS ----------
{
  const gm = makeGfx();
  gm.applyPreset("high"); // user ceiling: rt + contactShadows + bloom
  ok(gm.autoTier === 0 && gm.getEffectiveSettings().raytracing === true, "tier0 keeps user raytracing");

  // ~30fps sustained -> tier 1
  gm.lowMs = 1400;
  gm.sampleFrame(33, makeStubRenderer());
  ok(gm.autoTier === 1, `low fps sheds to tier 1 (got ${gm.autoTier})`);
  const e1 = gm.getEffectiveSettings();
  ok(e1.raytracing === false && e1.contactShadows === true && e1.bloom === true, "tier1 drops SSR raytracing only");
  ok(gm.settings.raytracing === true, "user ceiling preset stays untouched");

  // tier 2
  gm.lastTierChangeMs = -1e9;
  gm.lowMs = 1400;
  gm.sampleFrame(33, makeStubRenderer());
  ok(gm.autoTier === 2, `continued low fps sheds to tier 2 (got ${gm.autoTier})`);
  const e2 = gm.getEffectiveSettings();
  ok(e2.raytracing === false && e2.contactShadows === false && e2.bloom === true, "tier2 also drops contact shadows");
  ok(gm.getShadowSize() <= 1024, `tier2 shrinks shadow map (got ${gm.getShadowSize()})`);

  // tier 3 = effective LOW: all post-FX off -> direct render path + low budgets
  gm.lastTierChangeMs = -1e9;
  gm.lowMs = 1400;
  gm.sampleFrame(33, makeStubRenderer());
  ok(gm.autoTier === 3, `continued low fps sheds to tier 3 (got ${gm.autoTier})`);
  const e3 = gm.getEffectiveSettings();
  ok(!e3.raytracing && !e3.contactShadows && !e3.bloom, "tier3 kills all post-FX (direct render path)");
  ok(gm.getTargetDpr() <= 1.0, `tier3 caps DPR at low spec (got ${gm.getTargetDpr()})`);
  ok(gm.getBudgets().fxCap < 100, `tier3 fx budget collapses (got ${gm.getBudgets().fxCap})`);
  ok(gm.settings.preset === "high" && gm.settings.bloom === true, "user ceiling still high/bloom after tier3");
}

// ---------- 3. Entity-pressure floor ----------
{
  const gm = makeGfx();
  gm.applyPreset("ultra");
  gm.setEntityCount(500);
  ok(gm.autoTier >= 2, `500 entities pins entity floor tier>=2 (got ${gm.autoTier})`);
  gm.setEntityCount(320);
  ok(gm.autoTier >= 1, `320 entities pins floor tier>=1 (got ${gm.autoTier})`);
  // Sustained headroom cannot drop below the floor while pressure is high
  gm.lastTierChangeMs = -1e9;
  gm.highMs = 6000;
  gm.sampleFrame(14, makeStubRenderer());
  ok(gm.autoTier >= 1, `headroom upgrade respects entity floor (got ${gm.autoTier})`);
  // Relieve pressure -> gradual upgrade path opens
  gm.setEntityCount(50);
  gm.lastTierChangeMs = -1e9;
  gm.highMs = 6000;
  gm.sampleFrame(14, makeStubRenderer());
  ok(gm.autoTier === 0, `light load + headroom restores tier 0 (got ${gm.autoTier})`);
  ok(gm.getEffectiveSettings().raytracing === true, "restored tier0 re-enables raytracing");
}

// ---------- 4. autoQuality OFF freezes the governor ----------
{
  const gm = makeGfx();
  gm.applyPreset("high");
  gm.setOption("autoQuality", false);
  gm.lastTierChangeMs = -1e9;
  gm.lowMs = 9999;
  gm.setEntityCount(800);
  gm.sampleFrame(33, makeStubRenderer());
  ok(gm.autoTier === 0, `autoQuality OFF never sheds (got ${gm.autoTier})`);
  ok(gm.getEffectiveSettings().raytracing === true, "autoQuality OFF keeps full pipeline");
}

// ---------- 5. Budgets scale with preset + entity pressure ----------
{
  const gm = makeGfx();
  gm.applyPreset("ultra");
  gm.setEntityCount(10);
  const idle = gm.getBudgets();
  gm.setEntityCount(500);
  const horde = gm.getBudgets();
  ok(idle.fxCap > horde.fxCap, `fx cap tightens under horde (${idle.fxCap} -> ${horde.fxCap})`);
  ok(idle.animFarDist > horde.animFarDist, `anim LOD distance tightens (${idle.animFarDist.toFixed(1)} -> ${horde.animFarDist.toFixed(1)})`);
  ok(idle.vfxScale >= horde.vfxScale, `vfx scale tightens (${idle.vfxScale} -> ${horde.vfxScale})`);
  ok(horde.animFarDist >= 18 && horde.animSkip >= 1 && horde.vfxScale > 0, "budgets stay within sane floors");
}

// ---------- 6. Crisis fast-path bypasses dwell ----------
{
  const gm = makeGfx();
  gm.applyPreset("ultra");
  // Sustained sub-28fps crisis sheds a tier immediately even inside the dwell window
  gm.lastTierChangeMs = performance.now(); // dwell fully closed
  gm.crisisMs = 450;
  gm.sampleFrame(50, makeStubRenderer());
  ok(gm.autoTier === 1, `crisis sheds tier despite closed dwell (got ${gm.autoTier})`);
  // 30fps is degraded but NOT a crisis: no bypass, normal dwell applies
  const gm2 = makeGfx();
  gm2.applyPreset("ultra");
  gm2.lastTierChangeMs = performance.now();
  gm2.crisisMs = 0;
  gm2.lowMs = 1400;
  gm2.sampleFrame(33, makeStubRenderer());
  ok(gm2.autoTier === 0, `non-crisis low fps respects downshift dwell (got ${gm2.autoTier})`);
  // Crisis accumulation resets when fps recovers
  gm.crisisMs = 300;
  gm.emaFrameMs = 14; // simulate recovered EMA (~71fps) — the EMA legitimately smooths over frames
  gm.sampleFrame(14, makeStubRenderer());
  ok(gm.crisisMs === 0, `crisis timer resets on recovery (got ${gm.crisisMs})`);
}

console.log(`\n${passN} passed, ${failN} failed`);
if (failN > 0) {
  console.log("failures:", fails.join(", "));
  process.exit(1);
}
