import puppeteer from "puppeteer-core";
const [room = "war", tx = "57", ty = "57", h = "30", name = "focus"] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1400, height: 900 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await (await browser.createBrowserContext()).newPage();
await page.goto(`${process.env.OA_HTTP ?? "http://localhost:8787"}/?room=${room}&name=cam`, { waitUntil: "domcontentloaded" });
await sleep(2200);
await page.evaluate((tx, ty, h) => {
  const oa = window.__oa;
  oa.gs.camTarget.set(+tx, 0, +ty);
  oa.gs.camHeight = +h;
  oa.gs.updateCamera();
}, tx, ty, h);
for (let i = 0; i < 4; i++) {
  await sleep(4000);
  await page.screenshot({ path: `test/shots/${name}-${i}.png` });
}
await browser.close();
console.log("done");
process.exit(0);
