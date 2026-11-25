#!/usr/bin/env node
// Scripted heavy-battle render performance harness (headless Chrome + SwiftShader).
// SwiftShader is CPU rasterization, so FPS is NOT GPU truth here; the important
// evidence is per-frame JS/render-loop CPU ms, draw calls, triangles, scene-node
// counts, and heap/GC pressure under a reproducible entity load.
//
//   node test/perfbattle.mjs [--map fulda_gap] [--scale 1] [--seconds 8] [--tag before]
//   OA_HTTP=http://localhost:8787 OA_CHROME=/usr/bin/google-chrome node test/perfbattle.mjs

import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const HTTP = process.env.OA_HTTP || "http://localhost:8787";
const CHROME = process.env.OA_CHROME || "/usr/bin/google-chrome";
const MAP = arg("map", "fulda_gap");
const SCALE = Number(arg("scale", "1")) || 1;
const SECONDS = Math.max(3, Number(arg("seconds", "8")) || 8);
const TAG = arg("tag", `${Date.now().toString(36)}`);
const WARMUP = Math.max(0, Number(arg("warmup", "6")) || 0);
const VW = 1500;
const VH = 950;
const ROOM = `perf${Date.now().toString(36)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(".tmp", { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    "--enable-unsafe-swiftshader",
    "--enable-precise-memory-info",
    // Headless pages count as hidden; without these the game's setInterval
    // world-step timer is throttled to ~1Hz and the battle never develops.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=IntensiveWakeUpThrottling",
    `--window-size=${VW},${VH}`,
  ],
  defaultViewport: { width: VW, height: VH },
});
const page = await browser.newPage();
const pageErrs = [];
page.on("pageerror", (e) => pageErrs.push(e.message));

console.log(`[perf] room=${ROOM} map=${MAP} scale=${SCALE} seconds=${SECONDS}`);
await page.goto(`${HTTP}/?room=${ROOM}&name=PerfProbe`, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__oa && window.__oa.net, { timeout: 25000 });

// Runtime-only instrumentation: measure the real hot methods called by the main loop.
await page.evaluate(() => {
  const oa = window.__oa;
  if (window.__perf) return;
  const P = (window.__perf = {
    frames: 0,
    totals: Object.create(null),
    callsSum: 0,
    trisSum: 0,
    renderSamples: 0,
    memSamples: 0,
    heapLast: 0,
    heapPeak: 0,
    gcDrops: 0,
    gcBytes: 0,
  });
  const bump = (name, ms) => {
    P.totals[name] = (P.totals[name] ?? 0) + ms;
  };
  const wrap = (obj, name, label = name, after) => {
    if (!obj || typeof obj[name] !== "function" || obj[name].__perfWrapped) return;
    const orig = obj[name];
    const wrapped = function (...args) {
      const t0 = performance.now();
      try {
        const out = orig.apply(this, args);
        if (after) after();
        return out;
      } finally {
        bump(label, performance.now() - t0);
      }
    };
    wrapped.__perfWrapped = true;
    obj[name] = wrapped;
  };
  wrap(oa.renderer, "update", "rendererUpdate");
  wrap(oa.gs, "render", "gsRender", () => {
    const ri = oa.gs.renderer.info.render;
    P.callsSum += ri.calls;
    P.trisSum += ri.triangles;
    P.renderSamples++;
  });
  wrap(oa.hud, "drawMinimap", "minimap");
  wrap(oa.hud, "tick", "hudTick");
  wrap(oa.audio, "update", "audioUpdate");
  wrap(oa.input, "update", "inputUpdate");
  const countFrame = () => {
    P.frames++;
    requestAnimationFrame(countFrame);
  };
  requestAnimationFrame(countFrame);
  if (performance.memory) {
    P.heapLast = performance.memory.usedJSHeapSize;
    P.heapPeak = P.heapLast;
    setInterval(() => {
      const used = performance.memory.usedJSHeapSize;
      P.memSamples++;
      if (used > P.heapPeak) P.heapPeak = used;
      // Sawtooth drops are a practical proxy for major GC pressure in Chrome.
      if (P.heapLast - used > 512 * 1024) {
        P.gcDrops++;
        P.gcBytes += P.heapLast - used;
      }
      P.heapLast = used;
    }, 100);
  }
});

// Start a local 8-bot AI war directly (NOT through the UI helper, so auto-cam stays off).
await page.evaluate((map) => window.__oa.net.startAiSpectate(map, 8), MAP);
await sleep(900);

// Inject a deterministic mixed armored/infantry/drone battle into the browser-local World.
// TS-private methods are runtime properties; this is a test-only direct simulation seed.
const injected = await page.evaluate((scale) => {
  const oa = window.__oa;
  const world = oa.net.local?.world;
  if (!world) return { error: "no local world" };
  const before = [...world.ents.values()].length;
  const perSide = {
    tank: Math.round(55 * scale),
    railtank: Math.round(10 * scale),
    infantry: Math.round(85 * scale),
    fpvdrone: Math.round(35 * scale),
  };
  const ids0 = [];
  const ids1 = [];
  const kinds = Object.entries(perSide);
  const place = (slot, kind, n, x0, y0, cols, rows) => {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i % cols);
      const y = y0 + ((i / cols) | 0) % rows;
      const layer = ((i / (cols * rows)) | 0);
      const e = world.spawnUnit(slot, kind, Math.min(x + layer, 190), y);
      (slot === 0 ? ids0 : ids1).push(e.id);
    }
  };
  for (const [kind, n] of kinds) {
    place(0, kind, n, 82, 72, 12, 41);
    place(1, kind, n, 99, 72, 12, 41);
  }
  const err0 = world.cmdOrder(0, ids0, "amove", 109, 96);
  const err1 = world.cmdOrder(1, ids1, "amove", 84, 96);

  // Fixed tactical camera: most of the collision/formation is visible, with map edges off-screen.
  oa.gs.camTarget.set(96, 0, 96);
  oa.gs.camHeight = 34;
  oa.gs.updateCamera();
  return { before, injected: ids0.length + ids1.length, ids0: ids0.length, ids1: ids1.length, err0, err1 };
}, SCALE);
console.log("[perf] injected", injected);

// Warm up visual creation/interpolation, then fast-forward the sim into mid-battle.
// (The main thread is saturated by SwiftShader rasterization, so the net's own
// setInterval stepping only manages ~1 tick/s — step manually in chunks, draining
// accumulated events via snapshot() so the measurement doesn't start with a huge
// artificial vfx burst.)
await sleep(Math.min(WARMUP, 2) * 1000);
const ff = await page.evaluate((ticks) => {
  const world = window.__oa.net.local?.world;
  if (!world) return { error: "no world" };
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    world.step();
    if (world.tick % 20 === 0) world.snapshot(); // drain events
  }
  return { tick: world.tick, ms: Math.round(performance.now() - t0), ents: [...world.ents.values()].length };
}, Math.max(0, (WARMUP - 2) * 25));
console.log("[perf] fast-forward", ff);
await sleep(800);
await page.evaluate(() => {
  const P = window.__perf;
  P.frames = 0;
  P.totals = Object.create(null);
  P.callsSum = 0;
  P.trisSum = 0;
  P.renderSamples = 0;
  P.memSamples = 0;
  P.gcDrops = 0;
  P.gcBytes = 0;
  if (performance.memory) {
    P.heapLast = performance.memory.usedJSHeapSize;
    P.heapPeak = P.heapLast;
  }
  P.measureStartHeap = P.heapLast;
  P.measureStart = performance.now();
});

await sleep(SECONDS * 1000);

const result = await page.evaluate(() => {
  const oa = window.__oa;
  const P = window.__perf;
  const elapsedMs = Math.max(1, performance.now() - P.measureStart);
  const frames = Math.max(1, P.frames);
  const perFrame = {};
  for (const [k, v] of Object.entries(P.totals)) perFrame[k] = (v / frames) * 1000; // seconds total -> microseconds/frame? corrected below
  for (const k of Object.keys(perFrame)) perFrame[k] = perFrame[k] / 1000; // ms/frame
  let nodes = { total: 0, mesh: 0, instanced: 0, sprite: 0, line: 0, visibleMesh: 0, castShadow: 0 };
  oa.gs.scene.traverse((o) => {
    nodes.total++;
    if (o.isMesh) nodes.mesh++;
    if (o.isInstancedMesh) nodes.instanced++;
    if (o.isSprite) nodes.sprite++;
    if (o.isLine) nodes.line++;
    if (o.visible && o.isMesh) nodes.visibleMesh++;
    if (o.castShadow) nodes.castShadow++;
  });
  let instancedEnts = 0;
  let visibleEnts = 0;
  for (const t of oa.renderer.tracked.values()) {
    if (t.inst) instancedEnts++;
    if (t.vis.root.visible) visibleEnts++;
  }
  const pools = [];
  for (const [key, p] of oa.renderer.instPools ?? []) {
    pools.push({ key, used: p.used, parts: p.parts.length });
  }
  return {
    elapsedMs,
    frames,
    fps: (frames * 1000) / elapsedMs,
    perFrameMs: perFrame,
    loopTotalMs: Object.values(perFrame).reduce((a, b) => a + b, 0),
    drawCallsAvg: P.callsSum / Math.max(1, P.renderSamples),
    trianglesAvg: P.trisSum / Math.max(1, P.renderSamples),
    heapEnd: performance.memory?.usedJSHeapSize ?? 0,
    heapPeak: P.heapPeak,
    heapDelta: (performance.memory?.usedJSHeapSize ?? 0) - (P.measureStartHeap ?? 0),
    gcDrops: P.gcDrops,
    gcBytes: P.gcBytes,
    entityCount: oa.renderer.tracked.size,
    visibleEnts,
    instancedEnts,
    pools,
    nodes,
    graphics: {
      autoTier: oa.gs.graphics.autoTier,
      stats: { ...oa.gs.graphics.stats },
      effective: { ...oa.gs.graphics.getEffectiveSettings() },
      budgets: { ...oa.gs.graphics.getBudgets() },
      dpr: oa.gs.renderer.getPixelRatio(),
      targetDpr: oa.gs.graphics.getTargetDpr(),
      shadowSize: oa.gs.graphics.getShadowSize(),
      shadowStride: oa.gs.graphics.getShadowUpdateStride(),
    },
    worldTick: oa.net.local?.world?.tick ?? 0,
    worldEnts: oa.net.local?.world ? [...oa.net.local.world.ents.values()].length : 0,
  };
});
result.pageErrs = pageErrs;
result.config = { MAP, SCALE, SECONDS, VW, VH, ROOM };
writeFileSync(`.tmp/perfbattle-${TAG}.json`, JSON.stringify(result, null, 2));

const fmt = (n, d = 2) => Number(n).toFixed(d);
console.log("\n[perf] RESULT");
console.log(`frames=${result.frames} elapsed=${fmt(result.elapsedMs / 1000, 1)}s fps(swiftshader)=${fmt(result.fps, 1)}`);
console.log(`entities=${result.entityCount} visible=${result.visibleEnts} instanced=${result.instancedEnts} world=${result.worldEnts} tick=${result.worldTick}`);
console.log(`drawCalls avg=${fmt(result.drawCallsAvg, 0)} tris avg=${fmt(result.trianglesAvg / 1000, 0)}k`);
console.log(`cpu ms/frame total=${fmt(result.loopTotalMs)} renderer.update=${fmt(result.perFrameMs.rendererUpdate ?? 0)} gs.render=${fmt(result.perFrameMs.gsRender ?? 0)} minimap=${fmt(result.perFrameMs.minimap ?? 0)} hud=${fmt(result.perFrameMs.hudTick ?? 0)} audio=${fmt(result.perFrameMs.audioUpdate ?? 0)} input=${fmt(result.perFrameMs.inputUpdate ?? 0)}`);
console.log(`heap delta=${fmt(result.heapDelta / 1048576, 2)}MiB peak=${fmt(result.heapPeak / 1048576, 1)}MiB gcDrops=${result.gcDrops} gcBytes=${fmt(result.gcBytes / 1048576, 1)}MiB`);
console.log(`governor tier=${result.graphics.autoTier} dpr=${fmt(result.graphics.dpr)}/${fmt(result.graphics.targetDpr)} shadow=${result.graphics.shadowSize}/${result.graphics.shadowStride} fxCap=${result.graphics.budgets.fxCap} vfx=${fmt(result.graphics.budgets.vfxScale)}`);
console.log(`scene nodes=${result.nodes.total} mesh=${result.nodes.mesh} instancedMesh=${result.nodes.instanced} sprites=${result.nodes.sprite} casters=${result.nodes.castShadow}`);
console.log(`pools=${result.pools.map((p) => `${p.key}:${p.used}/${p.parts}`).join(" ")}`);
if (pageErrs.length) console.log(`pageErrs=${pageErrs.join(" | ")}`);
console.log(`[perf] wrote .tmp/perfbattle-${TAG}.json`);

await browser.close();
if (pageErrs.length) process.exit(1);
