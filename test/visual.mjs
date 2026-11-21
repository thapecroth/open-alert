// Visual verification: real Chrome, player auto-plays vs server-side AI bot.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";

const HTTP = process.env.OA_HTTP || "http://localhost:8787";
const ROOM = "vis" + Date.now().toString(36);
mkdirSync("test/shots", { recursive: true });
const shot = (p, n) => p.screenshot({ path: `test/shots/${n}.png` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--window-size=1500,950"],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
await page.goto(`${HTTP}/?room=${ROOM}&name=Viewer`, { waitUntil: "domcontentloaded" });
await sleep(3500);
await shot(page, "v-01-lobby");

await page.evaluate(() => document.getElementById("addbot-btn")?.click());
await sleep(700);
await shot(page, "v-02-lobby-bot");
await page.evaluate(() => document.getElementById("start-btn")?.click());
await sleep(4000);
await shot(page, "v-03-game-start");
const iconCount = await page.evaluate(() => document.querySelectorAll(".icon.has-icon").length);
console.log("sidebar icons:", iconCount);

// drive the player's economy through the real command surface
const act = (fn) => page.evaluate(fn);
await act(() => window.__oa.net.send({ t: "build", kind: "power" }));
await sleep(5600);
// place next to conyard: find our conyard then send place at adjacent tile
await act(() => {
  const oa = window.__oa;
  const cy = [...oa.renderer.tracked.values()].find((t) => t.last.o === oa.slot && t.last.k === "conyard");
  if (cy) oa.net.send({ t: "place", tx: Math.round(cy.last.x + 3), ty: Math.round(cy.last.y - 1) });
});
await sleep(700);
await act(() => window.__oa.net.send({ t: "build", kind: "refinery" }));
await sleep(7000);
await act(() => {
  const oa = window.__oa;
  const cy = [...oa.renderer.tracked.values()].find((t) => t.last.o === oa.slot && t.last.k === "conyard");
  if (cy) oa.net.send({ t: "place", tx: Math.round(cy.last.x - 4), ty: Math.round(cy.last.y + 1) });
});
await sleep(800);
await shot(page, "v-04-economy");
await act(() => window.__oa.net.send({ t: "build", kind: "barracks" }));
await sleep(7000);
await act(() => {
  const oa = window.__oa;
  const cy = [...oa.renderer.tracked.values()].find((t) => t.last.o === oa.slot && t.last.k === "conyard");
  if (cy) oa.net.send({ t: "place", tx: Math.round(cy.last.x + 3), ty: Math.round(cy.last.y + 3) });
});
await sleep(600);
await act(() => window.__oa.net.send({ t: "build", kind: "factory" }));
await sleep(8000);
await act(() => {
  const oa = window.__oa;
  const cy = [...oa.renderer.tracked.values()].find((t) => t.last.o === oa.slot && t.last.k === "conyard");
  if (cy) oa.net.send({ t: "place", tx: Math.round(cy.last.x - 1), ty: Math.round(cy.last.y - 5) });
});
await sleep(800);
await shot(page, "v-05-base-built");
const st = await page.evaluate(() => window.__oa?.state);
console.log("state:", JSON.stringify({ cr: st?.credits, awaiting: st?.awaiting, bq: st?.bq?.kind }));

// produce an army
await act(() => {
  const oa = window.__oa;
  for (let i = 0; i < 4; i++) oa.net.send({ t: "train", unit: "tank" });
  for (let i = 0; i < 5; i++) oa.net.send({ t: "train", unit: "infantry" });
});
await sleep(30000);
await shot(page, "v-06-army");

// assault the bot
await act(() => {
  const oa = window.__oa;
  const ids = [...oa.renderer.tracked.values()].filter((t) => t.last.o === oa.slot && (t.last.k === "tank" || t.last.k === "infantry")).map((t) => t.last.id);
  const foe = [...oa.renderer.tracked.values()].find((t) => t.last.o !== oa.slot && t.last.o >= 0);
  if (ids.length && foe) oa.net.send({ t: "order", ids, kind: "amove", x: foe.last.x, y: foe.last.y });
});
await sleep(25000);
await shot(page, "v-07-battle");
const phase = await page.evaluate(() => window.__oa?.phase);
const ents = await page.evaluate(() => window.__oa?.renderer?.tracked?.size);
console.log("phase:", phase, "ents:", ents);
await browser.close();
console.log("done");
