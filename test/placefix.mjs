// Placement-fix verification: ghost unit parity, real cancel, placePending, build times.
import puppeteer from "puppeteer-core";
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const ROOM = "pfx" + Math.random().toString(36).slice(2, 7);
const HTTP = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passN = 0, failN = 0, skipN = 0;
const ok = (c, n, ev = "") => { if (c) { passN++; console.log("ok:", n); } else { failN++; console.log("FAIL:", n, ev); } };
const skip = (n, why) => { skipN++; console.log("skip:", n, `(${why})`); };

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--window-size=1400,900"],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 160)));
await page.goto(`${HTTP}/?room=${ROOM}&name=PlaceFix`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__oa?.net, { timeout: 25000 });
const ev = (fn, ...a) => page.evaluate(fn, ...a);

await ev(() => {
  const oa = window.__oa;
  const L = (window.__plog = { sent: [], deny: [] });
  const s = oa.net.send.bind(oa.net);
  oa.net.send = (m) => { L.sent.push(JSON.parse(JSON.stringify(m))); return s(m); };
  const h = oa.net.onMsg;
  oa.net.onMsg = (m) => { if (m.t === "deny") L.deny.push(m.msg); return h(m); };
});

// lobby → game with a bot
await page.waitForFunction(() => !document.getElementById("addbot-btn")?.classList.contains("hidden"), { timeout: 15000 });
await page.click("#addbot-btn");
await sleep(800);
await page.waitForFunction(() => !document.getElementById("start-btn")?.classList.contains("hidden"), { timeout: 10000 });
await page.click("#start-btn");
await page.waitForFunction(() => window.__oa?.phase === "playing", { timeout: 20000 });
console.log("game started");

// ---------- build times ----------
const times = await ev(() => [...document.querySelectorAll(".sbtn .btime")].map((b) => b.textContent));
ok(times.length >= 18, "build-time labels on all sidebar buttons", `n=${times.length}`);
ok(times.every((t) => /^\d+(\.\d+)?s$/.test(t ?? "")), "build times formatted as seconds", times.slice(0, 4).join(","));
const tip = await ev(() => document.querySelector(".sbtn")?.title ?? "");
ok(/· \d+(\.\d+)?s to build/.test(tip), "tooltip carries build duration", tip);

// ---------- helpers ----------
// project world (x,z) → screen px
const w2s = `(wx, wz) => {
  const oa = window.__oa;
  const v = new (oa.gs.camTarget.constructor)(wx, 0, wz).project(oa.gs.camera);
  return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
}`;
// first screen point where the client ghost checks pass (placeOk) for a 2x2
const findSpotFn = `() => {
  const oa = window.__oa;
  const w2s = ${w2s};
  const occ = oa.input["occCheck"], adj = oa.input["adjCheck"];
  const cony = [...oa.renderer.tracked.values()].find((t) => t.last.k === "conyard");
  if (!cony || !occ || !adj) return null;
  const bx = Math.round(cony.last.x - 1.5), by = Math.round(cony.last.y - 1.5);
  for (let dy = -6; dy < 8; dy++) for (let dx = -6; dx < 8; dx++) {
    const tx = bx + dx, ty = by + dy;
    if (!(occ(tx, ty, 2, 2) && adj(tx, ty, 2, 2))) continue;
    const s = w2s(tx + 1, ty + 1);
    if (s.x > 60 && s.x < 1150 && s.y > 60 && s.y < 780) return { ...s, tx, ty };
  }
  return null;
}`;
// first screen point whose 2x2 footprint contains a unit tile (green client-side before fix)
const findUnitSpotFn = `() => {
  const oa = window.__oa;
  const w2s = ${w2s};
  const adj = oa.input["adjCheck"];
  const units = [...oa.renderer.tracked.values()].filter((t) => !["conyard","power","refinery","barracks","radar","factory","factory2","techlab","turret","arc","purifier","depot"].includes(t.last.k));
  for (const u of units) {
    const ux = Math.floor(u.last.x), uy = Math.floor(u.last.y);
    const s = w2s(ux + 1, uy + 1);
    if (s.x > 60 && s.x < 1150 && s.y > 60 && s.y < 780 && adj(ux, uy, 2, 2)) return { ...s, ux, uy };
  }
  return null;
}`;

// ---------- flow 1: build → ghost → red over units → green place ----------
await ev(() => window.__oa.net.send({ t: "build", kind: "power" }));
await page.waitForFunction(() => window.__oa.input.placing === "power", { timeout: 30000 });
ok(true, "ghost entered placement when construction finished");

const uspot = await ev(`(${findUnitSpotFn})()`);
if (uspot) {
  await page.mouse.move(uspot.x, uspot.y, { steps: 5 });
  await sleep(450); // per-frame moveGhost refreshes validity
  const isRed = await ev(() => window.__oa.input["ghost"]?.material?.color.getHex() === 0xe52525);
  ok(isRed, "ghost RED over a unit-occupied tile (server parity)", `spot=${JSON.stringify(uspot)}`);
} else skip("ghost RED over a unit-occupied tile", "no unit-tile spot found on screen");

const spot = await ev(`(${findSpotFn})()`);
if (spot) {
  await page.mouse.move(spot.x, spot.y, { steps: 5 });
  await sleep(450);
  const green = await ev(() => window.__oa.input["ghost"]?.material?.color.getHex() === 0x22e040);
  ok(green, "ghost GREEN over a legal tile", `spot=${JSON.stringify(spot)}`);
  await page.mouse.click(spot.x, spot.y, { button: "left" });
  await sleep(250);
  const places1 = await ev(() => window.__plog.sent.filter((m) => m.t === "place").length);
  ok(places1 === 1, "one place cmd sent on green click", `n=${places1}`);
  // rapid extra clicks while pending must not spam more place cmds
  await page.mouse.click(spot.x, spot.y, { button: "left" });
  await page.mouse.click(spot.x, spot.y, { button: "left" });
  await sleep(300);
  const places2 = await ev(() => window.__plog.sent.filter((m) => m.t === "place").length);
  ok(places2 <= 2, "placePending blocks spam while awaiting snap", `n=${places2}`);
  await sleep(2500);
  const hasPower = await ev(() => [...window.__oa.renderer.tracked.values()].some((t) => t.last.k === "power" && t.last.o === 0));
  ok(hasPower, "power plant spawned from place");
} else skip("green place flow", "no legal spot on screen");

// ---------- flow 2: right-click cancel refunds + unblocks the build queue ----------
await ev(() => window.__oa.net.send({ t: "build", kind: "barracks" }));
await page.waitForFunction(() => window.__oa.input.placing === "barracks", { timeout: 40000 });
await page.mouse.move(700, 450);
await page.mouse.down({ button: "right" });
await page.mouse.up({ button: "right" });
await sleep(500);
const after = await ev(() => ({
  placing: window.__oa.input.placing,
  cancels: window.__plog.sent.filter((m) => m.t === "buildCancel").length,
}));
ok(after.placing === null, "right-click exits placement mode");
ok(after.cancels >= 1, "cancel sends buildCancel (server refund + unblock)");
await sleep(800);
// the queue must accept a new build — this was the stuck-forever bug
await ev(() => window.__oa.net.send({ t: "build", kind: "barracks" }));
const gotA2 = await page.waitForFunction(() => window.__oa.input.placing === "barracks", { timeout: 40000 }).then(() => true).catch(() => false);
ok(gotA2, "new build proceeds after cancel (queue not stuck)", await ev(() => JSON.stringify(window.__plog.deny.slice(-3))));

console.log(`\n${passN} passed, ${failN} failed, ${skipN} skipped`);
await browser.close();
process.exit(failN ? 1 : 0);
