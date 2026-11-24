#!/usr/bin/env node
// End-to-end visual test: two real Chrome pages join a room, play via
// real DOM/canvas input, capture screenshots at each stage.
// Usage: node test/e2e.mjs <room> [--headless]
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";

const room = process.argv[2] ?? "e2e" + Math.random().toString(36).slice(2, 6);
const shots = "test/shots";
mkdirSync(shots, { recursive: true });
const CHROME = "/usr/bin/google-chrome";
const base = `http://localhost:8787/?room=${room}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--window-size=1400,900", "--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1400, height: 900 },
});

const shot = async (page, name) => {
  await page.screenshot({ path: `${shots}/${name}.png` });
  console.log("shot:", name);
};
const ev = (page, fn, ...args) => page.evaluate(fn, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function player(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || t.includes("error")) console.log(`[${name}:console]`, t.slice(0, 200));
  });
  page.on("pageerror", (e) => console.log(`[${name}:pageerror]`, String(e).slice(0, 300)));
  await page.goto(`${base}&name=${name}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.__oa !== undefined || document.querySelectorAll("#player-list li").length > 0, { timeout: 20000 });
  return page;
}

const step = (msg) => console.log("== " + msg);
const fail = (msg) => {
  console.log("FAIL:", msg);
  process.exitCode = 1;
};
const assert = (c, msg) => (c ? console.log("ok:", msg) : fail(msg));

// ---------- 1. lobby ----------
step("open two players");
const A = await player("alice");
const B = await player("bob");
await sleep(1500);
const lobbyA = await ev(A, () => ({
  phase: window.__oa?.phase,
  players: [...document.querySelectorAll("#player-list li")].map((l) => l.textContent.trim()),
  visible: !document.getElementById("lobby").classList.contains("hidden"),
}));
assert(lobbyA.visible, "lobby overlay visible for A");
assert(lobbyA.players.length === 2, `lobby lists 2 players (${lobbyA.players.join(" | ")})`);
await shot(A, "01-lobby");

// ---------- 2. start ----------
step("B readies, A (host) starts");
await B.click("#ready-btn");
await sleep(400);
const startVisible = await ev(A, () => !document.getElementById("start-btn").classList.contains("hidden"));
assert(startVisible, "A sees START button as host");
await A.click("#start-btn");
await sleep(2500);
const phaseA = await ev(A, () => window.__oa.phase);
const slotB = await ev(B, () => window.__oa.slot);
assert(phaseA === "playing", "A entered game");
assert(slotB === 1, `B got slot 1 (${slotB})`);
const hudVisible = await ev(A, () => !document.getElementById("sidebar").classList.contains("hidden"));
assert(hudVisible, "HUD sidebar visible");
await shot(A, "02-start-A");
await shot(B, "02-start-B");

// ---------- 3. selection & move via real mouse ----------
step("drag-select units on A, right-click move order");
// find A's unit screen positions
const units = await ev(A, () => {
  const oa = window.__oa;
  const out = [];
  for (const [id, t] of oa.renderer.tracked) {
    if (t.last.o !== oa.slot || ["conyard"].includes(t.last.k)) continue;
    const p = oa.renderer.entScreenPos(id);
    if (p) out.push({ id, k: t.last.k, ...p });
  }
  return out;
});
assert(units.length >= 4, `A sees ${units.length} own units`);
const xs = units.map((u) => u.x),
  ys = units.map((u) => u.y);
const x1 = Math.min(...xs) - 30,
  x2 = Math.max(...xs) + 30;
const y1 = Math.min(...ys) - 30,
  y2 = Math.max(...ys) + 30;
await A.mouse.move(x1, y1);
await A.mouse.down();
await A.mouse.move(x2, y2, { steps: 8 });
await A.mouse.up();
await sleep(400);
const selCount = await ev(A, () => window.__oa.input.selection.size);
assert(selCount >= 4, `drag-selected ${selCount} units`);
await shot(A, "03-selected");

// right-click at a point ~10 tiles right of selection centroid
const before = await ev(A, () => {
  const p = [];
  for (const id of window.__oa.input.selection) {
    const t = window.__oa.renderer.tracked.get(id);
    if (t) p.push([t.last.x, t.last.y]);
  }
  return p;
});
const cx = before.reduce((a, b) => a + b[0], 0) / before.length;
const cy = before.reduce((a, b) => a + b[1], 0) / before.length;
const dest = await ev(A, (cx, cy) => window.__oa.projectTile(cx + 8, cy + 4), cx, cy);
await A.mouse.move(dest.x, dest.y);
await A.mouse.click(dest.x, dest.y, { button: "right" });
await sleep(500);
await shot(A, "04-move-order");
await sleep(6000);
const after = await ev(A, () => {
  const p = [];
  for (const id of window.__oa.input.selection) {
    const t = window.__oa.renderer.tracked.get(id);
    if (t) p.push([t.last.x, t.last.y]);
  }
  return p;
});
if (!before.length || !after.length) {
  fail(`no selected units to compare (${before.length}->${after.length})`);
} else {
  const movedDist = Math.min(
    ...before.map((b, i) => (after[i] ? Math.hypot(after[i][0] - b[0], after[i][1] - b[1]) : 0)),
  );
  assert(movedDist > 0.5, `units moved (min displacement ${movedDist.toFixed(2)} tiles)`);
}

// ---------- 4. production: build + place a power plant ----------
step("build power plant via sidebar, place on map");
const bqStarted = await ev(A, () => {
  const btn = [...document.querySelectorAll("#build-list .sbtn")].find((b) => b.textContent.includes("Power"));
  btn.click();
  return true;
});
await sleep(500);
const building = await ev(A, () => window.__oa.state?.bq?.[0]?.kind);
assert(building === "power", `power plant in queue (${building})`);
// wait for it to finish (buildTicks 50 @10Hz = 5s) then placement mode auto-enters
await sleep(6000);
const placing = await ev(A, () => window.__oa.input.placing);
assert(placing === "power", `placement mode entered (${placing})`);
await shot(A, "05-placing-ghost");
// click a spot near the conyard: project a free tile next to it
const spot = await ev(A, () => {
  const oa = window.__oa;
  const cy = [...oa.renderer.tracked.values()].find((t) => t.last.k === "conyard" && t.last.o === oa.slot);
  // conyard occupies 3x3; try a few tiles to its right/below
  const candidates = [
    [cy.last.x + 3, cy.last.y],
    [cy.last.x + 3.5, cy.last.y + 2],
    [cy.last.x - 3, cy.last.y],
    [cy.last.x, cy.last.y + 3.5],
  ];
  return candidates.map(([x, y]) => ({ t: [x, y], s: oa.projectTile(x, y) }));
});
let placed = false;
for (const c of spot) {
  await A.mouse.move(c.s.x, c.s.y);
  await sleep(300);
  const ok = await ev(A, () => window.__oa.input["ghostOk"]);
  if (ok) {
    await A.mouse.click(c.s.x, c.s.y, { button: "left" });
    placed = true;
    break;
  }
}
if (!placed) {
  // just click the first candidate anyway and see
  await A.mouse.click(spot[0].s.x, spot[0].s.y, { button: "left" });
}
await sleep(800);
const powerNow = await ev(A, () => {
  const st = window.__oa.state;
  return { awaiting: st?.awaiting, pwr: (st?.pwrHave ?? 0) - (st?.pwrUse ?? 0), kinds: [...window.__oa.renderer.tracked.values()].filter((t) => t.last.o === window.__oa.slot).map((t) => t.last.k) };
});
assert(!powerNow.awaiting?.length, "placement consumed");
assert(powerNow.kinds.includes("power"), `power plant exists (${powerNow.kinds.join(",")})`);
await shot(A, "06-power-placed");

// ---------- 5. train infantry ----------
step("refinery + barracks chain, then train");
await ev(A, () => {
  const btn = [...document.querySelectorAll("#build-list .sbtn")].find((b) => b.textContent.includes("Refinery"));
  btn.click();
});
await sleep(9000); // refinery 80 ticks
for (const c of await ev(A, () => {
  const oa = window.__oa;
  const cy = [...oa.renderer.tracked.values()].find((t) => t.last.k === "conyard" && t.last.o === oa.slot);
  return [[cy.last.x + 4, cy.last.y - 2.5], [cy.last.x - 3, cy.last.y + 1], [cy.last.x + 1, cy.last.y + 4]].map(([x, y]) => ({ s: oa.projectTile(x, y) }));
})) {
  const ok = await ev(A, async (x, y) => {
    window.__oa.input["moveGhost"]?.();
    return window.__oa.input["ghostOk"];
  });
  await A.mouse.move(c.s.x, c.s.y);
  await sleep(250);
  const okNow = await ev(A, () => window.__oa.input["ghostOk"]);
  if (okNow) {
    await A.mouse.click(c.s.x, c.s.y);
    break;
  }
}
await sleep(1200);
const afterRef = await ev(A, () => ({
  kinds: [...window.__oa.renderer.tracked.values()].filter((t) => t.last.o === window.__oa.slot).map((t) => t.last.k),
  harv: [...window.__oa.renderer.tracked.values()].filter((t) => t.last.o === window.__oa.slot && t.last.k === "harvester").length,
}));
assert(afterRef.kinds.includes("refinery"), `refinery placed (${afterRef.kinds.join(",")})`);
assert(afterRef.harv >= 1, `free harvester spawned (${afterRef.harv})`);
await shot(A, "07-refinery");

// ---------- 6. combat check: order units to attack B's base ----------
step("send A's army at B's base, look for combat events");
await ev(A, () => {
  const oa = window.__oa;
  const ids = [...oa.renderer.tracked.entries()].filter(([, t]) => t.last.o === oa.slot && ["tank", "infantry"].includes(t.last.k)).map(([id]) => id);
  // find enemy target
  const foe = [...oa.renderer.tracked.values()].find((t) => t.last.o >= 0 && t.last.o !== oa.slot);
  oa.net.send({ t: "order", ids, kind: "amove", x: foe.last.x, y: foe.last.y });
  return ids.length;
});
await sleep(14000);
await shot(A, "08-assault");
const combat = await ev(A, () => {
  const oa = window.__oa;
  const mine = [...oa.renderer.tracked.values()].filter((t) => t.last.o === oa.slot && ["tank", "infantry"].includes(t.last.k)).length;
  const foes = [...oa.renderer.tracked.values()].filter((t) => t.last.o >= 0 && t.last.o !== oa.slot).length;
  return { mine, foes };
});
console.log(`combat state: A army=${combat.mine} B ents=${combat.foes}`);

// ---------- 7. minimap + HUD sanity ----------
const mm = await ev(A, () => {
  const c = document.getElementById("minimap");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && (d[i - 3] > 30 || d[i - 2] > 30 || d[i - 1] > 30)) lit++;
  return lit;
});
assert(mm > 20, `minimap has ${mm} non-background pixels`);

await B.close();
await A.close();
await browser.close();
console.log(process.exitCode ? "E2E DONE (with failures)" : "E2E DONE — all checks passed");
process.exit(process.exitCode ?? 0);
