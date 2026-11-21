import puppeteer from "puppeteer-core";
const room = process.argv[2] ?? "war";
const wait = parseInt(process.argv[3] ?? "120") * 1000;
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1400, height: 900 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await (await browser.createBrowserContext()).newPage();
page.on("pageerror", (e) => console.log("[spec:pageerror]", String(e).slice(0, 200)));

// A dev-server rebuild reloads the page mid-run; the old frame detaches and
// evaluate/screenshot throw. Re-navigate and continue instead of dying.
const DETACHED = /detached|Execution context was destroyed|Cannot find context|Target closed/i;
async function join() {
  await page.goto(`http://localhost:8787/?room=${room}&name=spectator`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  const st = await page.evaluate(() => ({ phase: window.__oa?.phase, slot: window.__oa?.slot })).catch(() => null);
  console.log("spectator joined:", JSON.stringify(st));
  // park camera on the contested center, slightly zoomed out
  await page.evaluate(() => {
    const oa = window.__oa;
    oa.gs.camTarget.set(32, 0, 32);
    oa.gs.camHeight = 40;
    oa.gs.updateCamera();
  }).catch(() => {});
}
await join();
const t0 = Date.now();
let n = 0;
while (Date.now() - t0 < wait) {
  await sleep(15000);
  try {
    const info = await page.evaluate(() => {
      const oa = window.__oa;
      if (!oa) return null;
      const kinds = {};
      for (const t of oa.renderer.tracked.values()) kinds[t.last.k] = (kinds[t.last.k] ?? 0) + 1;
      return { kinds, cam: [oa.gs.camTarget.x | 0, oa.gs.camTarget.z | 0] };
    });
    console.log(`t+${(((Date.now() - t0) / 1000) | 0)}s ents:`, JSON.stringify(info?.kinds ?? "reloading"));
    await page.screenshot({ path: `test/shots/war-${++n}.png` });
  } catch (e) {
    if (!DETACHED.test(String(e))) throw e;
    console.log(`t+${(((Date.now() - t0) / 1000) | 0)}s page reloaded — rejoining`);
    await sleep(2000);
    await join().catch((e2) => console.log("rejoin failed:", String(e2).slice(0, 120)));
  }
}
await browser.close();
process.exit(0);
