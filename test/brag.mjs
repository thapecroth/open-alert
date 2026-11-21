// Brag capture: hosts a 3-way CABAL war, spectator camera auto-follows the
// action centroid, records frames ~130ms apart for ffmpeg → gif/mp4.
//   node test/brag.mjs [seconds]
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const ROOM = "brag" + Math.random().toString(36).slice(2, 7);
const DUR = Math.min(240, Math.max(30, parseInt(process.argv[2] ?? "120")));
const DIR = "/tmp/brag-frames";
mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--window-size=1280,760"],
  defaultViewport: { width: 1280, height: 760 },
});

// ---- host: join, add 3 bots, start, resign → pure AI war ----
const host = await browser.newPage();
await host.goto(`http://localhost:8787/?room=${ROOM}&name=BragHost`, { waitUntil: "domcontentloaded" });
await host.waitForFunction(() => window.__oa?.net, { timeout: 25000 });
await host.waitForFunction(() => !document.getElementById("addbot-btn")?.classList.contains("hidden"), { timeout: 15000 });
for (let i = 0; i < 3; i++) { await host.click("#addbot-btn"); await sleep(500); }
await host.waitForFunction(() => !document.getElementById("start-btn")?.classList.contains("hidden"), { timeout: 10000 });
await host.click("#start-btn");
await host.waitForFunction(() => window.__oa?.phase === "playing", { timeout: 20000 });
await host.evaluate(() => window.__oa.net.send({ t: "resign" }));
console.log("3-way CABAL war running on", ROOM);

// ---- spectator camera — isolated context: a second page in the same
// browser shares the host's localStorage oa-token and would steal its slot ----
const specCtx = await browser.createBrowserContext();
const page = await specCtx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 120)));
await page.goto(`http://localhost:8787/?room=${ROOM}&name=cam`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__oa?.net, { timeout: 25000 });
await sleep(2000);
console.log("camera slot:", await page.evaluate(() => window.__oa.slot));

// cinematic frame: hide all game UI so the gif is pure battlefield
await page.evaluate(() => {
  const st = document.createElement("style");
  st.textContent = "#topbar,#verbbar,#sidebar,#selinfo,#minimap,#chat-box,#toasts,#order-label,#placement-hint,#help{display:none!important}";
  document.head.appendChild(st);
});

// per-tick camera brain: ease toward the biggest ARMED multi-owner cluster
// (combat = mixed factions in one area), closer framing for readability.
await page.evaluate(() => {
  const oa = window.__oa;
  oa.gs.camHeight = 22;
  const BLDG = new Set(["conyard","power","refinery","barracks","radar","factory","factory2","techlab","turret","arc","purifier","depot"]);
  window.__cam = { tx: 32, tz: 32 };
  const step = () => {
    const cells = new Map();
    for (const t of oa.renderer.tracked.values()) {
      if (BLDG.has(t.last.k) || t.last.k === "harvester") continue;
      const k = `${t.last.x / 8 | 0},${t.last.y / 8 | 0}`;
      const c = cells.get(k) ?? { n: 0, sx: 0, sy: 0, owners: new Set() };
      c.n++; c.sx += t.last.x; c.sy += t.last.y; c.owners.add(t.last.o);
      cells.set(k, c);
    }
    let best = null;
    for (const c of cells.values()) {
      // prefer contested cells (2+ owners), then biggest
      const score = (c.owners.size > 1 ? 1000 : 0) + c.n;
      if (!best || score > best.score) { c.score = score; best = c; }
    }
    if (best) { window.__cam.tx = best.sx / best.n; window.__cam.tz = best.sy / best.n; }
    const c = window.__cam;
    oa.gs.camTarget.x += (c.tx - oa.gs.camTarget.x) * 0.045;
    oa.gs.camTarget.z += (c.tz - oa.gs.camTarget.z) * 0.045;
    const target = 21 + Math.sin(performance.now() / 11000) * 3;
    oa.gs.camHeight += (target - oa.gs.camHeight) * 0.01;
    oa.gs.updateCamera();
  };
  window.__camTimer = setInterval(step, 90);
});

// ---- record ----
const t0 = Date.now();
let n = 0;
const log = [];
while (Date.now() - t0 < DUR * 1000) {
  const f = `${DIR}/f${String(++n).padStart(4, "0")}.png`;
  const info = await page.evaluate(() => {
    const oa = window.__oa;
    if (!oa || oa.phase !== "playing") return null;
    let units = 0, bldgs = 0;
    for (const t of oa.renderer.tracked.values())
      if (["conyard","power","refinery","barracks","radar","factory","factory2","techlab","turret","arc","purifier","depot"].includes(t.last.k)) bldgs++;
      else units++;
    return { units, bldgs, tick: oa.state?.tick };
  }).catch(() => null);
  if (info === null) { console.log("game over — stopping capture"); break; }
  const s = Date.now();
  await page.screenshot({ path: f }).catch(() => {});
  log.push({ f, ...info });
  if (n % 40 === 0) console.log(`t+${((Date.now() - t0) / 1000) | 0}s frames=${n} units=${info.units} bldgs=${info.bldgs}`);
  const spent = Date.now() - s;
  await sleep(Math.max(30, 125 - spent));
}
writeFileSync(`${DIR}/log.json`, JSON.stringify(log));
console.log(`captured ${n} frames → ${DIR}`);
await browser.close();
process.exit(0);
