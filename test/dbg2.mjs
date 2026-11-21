import puppeteer from "puppeteer-core";
const room = "dbg" + Math.random().toString(36).slice(2, 5);
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1400, height: 900 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = await (await browser.createBrowserContext()).newPage();
const B = await (await browser.createBrowserContext()).newPage();
for (const [p, n] of [[A, "aa"], [B, "bb"]])
  await p.goto(`http://localhost:8787/?room=${room}&name=${n}`, { waitUntil: "domcontentloaded" });
await sleep(2000);
// instrument pan + pointer state BEFORE starting
await A.evaluate(() => {
  const oa = window.__oa;
  const orig = oa.gs.pan.bind(oa.gs);
  window.__panlog = [];
  oa.gs.pan = (dx, dz) => {
    window.__panlog.push([dx, dz, oa.gs.scene.pointerX, oa.gs.scene.pointerY]);
    orig(dx, dz);
  };
});
await B.click("#ready-btn");
await A.click("#start-btn");
await sleep(3000);
const out = await A.evaluate(() => ({
  cam: { x: window.__oa.gs.camTarget.x, z: window.__oa.gs.camTarget.z },
  inside: window.__oa.input["pointerInside"],
  ptr: [window.__oa.gs.scene.pointerX, window.__oa.gs.scene.pointerY],
  panlog: window.__panlog.slice(0, 8),
  panCount: window.__panlog.length,
}));
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(0);
