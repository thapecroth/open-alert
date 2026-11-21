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
await page.goto(`http://localhost:8787/?room=${room}&name=spectator`, { waitUntil: "domcontentloaded" });
await sleep(2500);
const st = await page.evaluate(() => ({ phase: window.__oa?.phase, slot: window.__oa?.slot }));
console.log("spectator joined:", JSON.stringify(st));

// park camera on the contested center, slightly zoomed out
await page.evaluate(() => {
  const oa = window.__oa;
  oa.gs.camTarget.set(32, 0, 32);
  oa.gs.camHeight = 40;
  oa.gs.updateCamera();
});
const t0 = Date.now();
let n = 0;
while (Date.now() - t0 < wait) {
  await sleep(15000);
  const info = await page.evaluate(() => {
    const oa = window.__oa;
    const kinds = {};
    for (const t of oa.renderer.tracked.values()) kinds[t.last.k] = (kinds[t.last.k] ?? 0) + 1;
    return { kinds, cam: [oa.gs.camTarget.x | 0, oa.gs.camTarget.z | 0] };
  });
  console.log(`t+${(((Date.now() - t0) / 1000) | 0)}s ents:`, JSON.stringify(info.kinds));
  await page.screenshot({ path: `test/shots/war-${++n}.png` });
}
await browser.close();
process.exit(0);
