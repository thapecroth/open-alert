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
for (const [p, n] of [[A, "aa"], [B, "bb"]]) {
  await p.goto(`http://localhost:8787/?room=${room}&name=${n}`, { waitUntil: "domcontentloaded" });
}
await sleep(2000);
await B.click("#ready-btn");
await A.click("#start-btn");
await sleep(2000);

const info = await A.evaluate(() => {
  const oa = window.__oa;
  const cam = oa.gs.camTarget;
  const units = [];
  for (const [id, t] of oa.renderer.tracked) {
    const p = oa.renderer.entScreenPos(id);
    units.push({ id, k: t.last.k, o: t.last.o, wx: t.last.x, wy: t.last.y, sx: p?.x, sy: p?.y });
  }
  return { cam: { x: cam.x, z: cam.z }, slot: oa.slot, units };
});
console.log(JSON.stringify(info, null, 1).slice(0, 3000));
await A.screenshot({ path: "/tmp/dbg1.png" });
// click on first own tank's projected position
const tank = info.units.find((u) => u.o === info.slot && u.k === "tank");
console.log("clicking tank at", tank.sx, tank.sy, "world", tank.wx, tank.wy);
await A.mouse.click(tank.sx, tank.sy, { button: "left" });
await sleep(500);
console.log("selection after click:", await A.evaluate(() => [...window.__oa.input.selection]));
await A.screenshot({ path: "/tmp/dbg2.png" });
await browser.close();
process.exit(0);
