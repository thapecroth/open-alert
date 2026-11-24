#!/usr/bin/env node
// Permanent regression test for:
//   - Server-authoritative waypoint walking queue (Shift + Right-Click)
//   - Full RTS keyboard controls (Ctrl+1..9 / 1..9, Enter chat, H base, Q combat, +/- zoom, WASD toggle)
//   - North-Up camera alignment (screen +X = map +X, screen +Y = map +Z)
//   - Fixed HUD layout (zero overlap between #chat-box and #selinfo, sidebar prereq locks, resize)
// Also captures close-up screenshots for visual inspection.

import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";

const HTTP = process.env.OA_HTTP || "http://localhost:8787";
const CHROME = process.env.OA_CHROME || "/usr/bin/google-chrome";
const ROOM = "wp" + Date.now().toString(36);
const VW = 1440,
  VH = 900;

mkdirSync("test/shots", { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? " — " + detail : ""}`);
  }
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", `--window-size=${VW},${VH}`],
  defaultViewport: { width: VW, height: VH },
});

const page = await browser.newPage();
// Tests exercise Classic RTS hotkeys (A/S/X) — pin the mode explicitly since WASD-pan is now the default.
await page.evaluateOnNewDocument(() => { try { localStorage.setItem("oa-wasd", "0"); } catch {} });
const pageErrs = [];
page.on("pageerror", (e) => {
  pageErrs.push(e.message);
  console.log("PAGE ERROR:", e.message);
});

const ev = (fn, ...a) => page.evaluate(fn, ...a);

try {
  await page.goto(`${HTTP}/?room=${ROOM}&name=Commander`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.__oa && window.__oa.net, { timeout: 20000 });
  await page.waitForSelector("#addbot-btn:not(.hidden)", { timeout: 15000 });

  // 0. Lobby toast sits above #lobby overlay (never occluded)
  await page.click("#start-btn");
  await sleep(300);
  const lobbyToast = await ev(() => {
    const t = document.querySelector("#toasts .toast");
    if (!t) return { found: false };
    const r = t.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const zToast = Number(getComputedStyle(document.getElementById("toasts")).zIndex || 0);
    const zLobby = Number(getComputedStyle(document.getElementById("lobby")).zIndex || 0);
    return { found: true, zOk: zToast > zLobby, text: t.textContent, hitId: hit?.id };
  });
  ok(lobbyToast.found && lobbyToast.zOk, "Lobby deny toast sits above #lobby overlay", JSON.stringify(lobbyToast));

  await page.click("#addbot-btn");
  await sleep(300);
  await page.click("#start-btn");
  await page.waitForFunction(() => window.__oa.phase === "playing" && window.__oa.renderer.tracked.size >= 6, {
    timeout: 15000,
  });
  await sleep(900);

  // 1. North-Up camera screen alignment check
  const align = await ev(() => {
    const a = window.__oa.projectTile(8, 8);
    const east = window.__oa.projectTile(14, 8);
    const south = window.__oa.projectTile(8, 14);
    return { dx: east.x - a.x, dy: south.y - a.y };
  });
  ok(align.dx > 80 && align.dy > 80, "North-Up camera alignment", `east ΔscreenX=${align.dx.toFixed(0)}px, south ΔscreenY=${align.dy.toFixed(0)}px`);

  // 2. Sidebar building prerequisite lock
  const locked = await ev(() => {
    const b = document.querySelector('#build-list button[data-kind="techlab"]');
    return { exists: !!b, disabled: b?.disabled, locked: b?.classList.contains("locked"), title: b?.title };
  });
  ok(locked.exists && locked.disabled && locked.locked && /Requires:/i.test(locked.title || ""), "Sidebar building prereq lock", locked.title);

  // 3. Select all combat with Q hotkey
  await page.keyboard.press("q");
  await sleep(200);
  const selAfterQ = await ev(() => window.__oa.input.selection.size);
  ok(selAfterQ === 5, "Q hotkey selects all combat units", `selected=${selAfterQ}`);

  // 4. Zero overlap between #chat-box and #selinfo
  const layout = await ev(() => {
    const c = document.getElementById("chat-box").getBoundingClientRect();
    const s = document.getElementById("selinfo").getBoundingClientRect();
    const overlap = !(c.right <= s.left || s.right <= c.left || c.bottom <= s.top || s.bottom <= c.top);
    return { overlap, chat: [c.left, c.right, c.top, c.bottom].map(Math.round), sel: [s.left, s.right, s.top, s.bottom].map(Math.round) };
  });
  ok(!layout.overlap, "HUD zero overlap (#chat-box vs #selinfo)", `chat=${JSON.stringify(layout.chat)} sel=${JSON.stringify(layout.sel)}`);

  // 5. Control groups: Ctrl+1 assign, Escape clear, 1 recall
  await page.keyboard.down("Control");
  await page.keyboard.press("Digit1");
  await page.keyboard.up("Control");
  await sleep(200);
  const groupBadge = await ev(() => document.querySelectorAll("#groupbar .gbtn").length);
  await page.keyboard.press("Escape");
  await sleep(150);
  const selAfterEsc = await ev(() => window.__oa.input.selection.size);
  await page.keyboard.press("Digit1");
  await sleep(150);
  const selAfter1 = await ev(() => window.__oa.input.selection.size);
  ok(groupBadge === 1 && selAfterEsc === 0 && selAfter1 === 5, "Control group Ctrl+1 / Esc / 1", `badges=${groupBadge} afterEsc=${selAfterEsc} after1=${selAfter1}`);

  // 6. Enter focuses chat input, Escape blurs
  await page.keyboard.press("Enter");
  await sleep(120);
  const chatFocused = await ev(() => document.activeElement?.id === "chat-input");
  await page.keyboard.press("Escape");
  await sleep(120);
  const chatBlurred = await ev(() => document.activeElement?.id !== "chat-input");
  ok(chatFocused && chatBlurred, "Enter focuses chat & Esc blurs", `focused=${chatFocused} blurred=${chatBlurred}`);

  // 7. Shift+Right-Click waypoint walking queue (3-point path)
  // Pick a single tank for crisp verification
  const tankInfo = await ev(() => {
    for (const [id, t] of window.__oa.renderer.tracked) {
      if (t.last.o === window.__oa.slot && t.last.k === "tank") {
        window.__oa.input.selection = new Set([id]);
        window.__oa.renderer.setSelected(window.__oa.input.selection);
        return { id, x: t.last.x, y: t.last.y };
      }
    }
    return null;
  });
  await ev(() => {
    window.__oa.gs.camTarget.set(12, 0, 12);
    window.__oa.gs.camHeight = 22;
    window.__oa.gs.updateCamera();
  });
  await sleep(250);

  const wpCoords = [
    [11, 10],
    [16, 10],
    [16, 15],
  ];
  const pts = [];
  for (const [wx, wy] of wpCoords) {
    pts.push(await ev(([x, y]) => window.__oa.projectTile(x, y), [wx, wy]));
  }
  // Issue first move, then Shift+Right-Click 2 more waypoints
  await page.mouse.move(pts[0].x, pts[0].y);
  await sleep(80);
  await page.mouse.click(pts[0].x, pts[0].y, { button: "right" });
  await sleep(180);
  await page.keyboard.down("Shift");
  for (const p of pts.slice(1)) {
    await page.mouse.move(p.x, p.y);
    await sleep(80);
    await page.mouse.click(p.x, p.y, { button: "right" });
    await sleep(180);
  }
  await page.keyboard.up("Shift");

  let wpInit = [];
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    wpInit = await ev((id) => window.__oa.renderer.tracked.get(id)?.last.wp ?? [], tankInfo.id);
    if (wpInit.length === 3) break;
  }
  ok(wpInit.length === 3, "Shift+Right-Click queues 3 waypoints", `wp=${JSON.stringify(wpInit)}`);

  // Screenshot showing glowing waypoint path + pins + new models/terrain!
  await page.screenshot({ path: "test/shots/wp-01-waypoints.png" });

  // Wait for tank to traverse waypoint 1 and move toward waypoint 2
  let shrank = false;
  for (let i = 0; i < 40; i++) {
    await sleep(350);
    const cur = await ev((id) => {
      const t = window.__oa.renderer.tracked.get(id);
      return t ? { x: t.last.x, y: t.last.y, len: t.last.wp?.length ?? 0 } : null;
    }, tankInfo.id);
    if (cur && cur.len > 0 && cur.len < 3) {
      shrank = true;
      break;
    }
  }
  ok(shrank, "Unit walks through waypoint 1 and advances to waypoint 2");

  // Stop (S) clears the remaining waypoint queue
  await page.keyboard.press("s");
  let wpAfterStop = -1;
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    wpAfterStop = await ev((id) => window.__oa.renderer.tracked.get(id)?.last.wp?.length ?? 0, tankInfo.id);
    if (wpAfterStop === 0) break;
  }
  ok(wpAfterStop === 0, "Stop (S) clears waypoint queue", `wpLen=${wpAfterStop}`);

  // 8. Keyboard zoom (+/-), Base jump (H), and WASD toggle
  const h0 = await ev(() => window.__oa.gs.camHeight);
  await page.keyboard.press("Equal");
  await sleep(100);
  const h1 = await ev(() => window.__oa.gs.camHeight);
  await page.keyboard.press("Minus");
  await sleep(100);
  const h2 = await ev(() => window.__oa.gs.camHeight);
  ok(h1 < h0 && h2 > h1, "Keyboard +/- zoom", `${h0} -> ${h1} -> ${h2}`);

  await ev(() => {
    window.__oa.gs.camTarget.set(40, 0, 40);
    window.__oa.gs.updateCamera();
  });
  await page.keyboard.press("h");
  await sleep(150);
  const afterH = await ev(() => ({ x: window.__oa.gs.camTarget.x, z: window.__oa.gs.camTarget.z }));
  ok(afterH.x < 12 && afterH.z < 12, "H key jumps camera home to base", `cam=(${afterH.x.toFixed(1)},${afterH.z.toFixed(1)})`);

  // WASD camera pan toggle
  await page.click("#wasd-btn");
  await sleep(120);
  const c0 = await ev(() => ({ x: window.__oa.gs.camTarget.x, z: window.__oa.gs.camTarget.z, on: window.__oa.input.wasdPan }));
  await page.keyboard.down("KeyD");
  await sleep(380);
  await page.keyboard.up("KeyD");
  await sleep(120);
  const c1 = await ev(() => ({ x: window.__oa.gs.camTarget.x, z: window.__oa.gs.camTarget.z }));
  await page.click("#wasd-btn"); // restore Classic RTS
  ok(c0.on && c1.x > c0.x + 1.0, "WASD camera toggle pans East on D", `camX ${c0.x.toFixed(1)} -> ${c1.x.toFixed(1)}`);

  // 9. Window resize updates renderer dimensions & preserves zero HUD overlap at 1024x680
  await page.keyboard.press("q");
  await sleep(150);
  await page.setViewport({ width: 1024, height: 680 });
  await sleep(250);
  const resized = await ev(() => {
    const c = document.getElementById("chat-box").getBoundingClientRect();
    const s = document.getElementById("selinfo").getBoundingClientRect();
    const overlap = !(c.right <= s.left || s.right <= c.left || c.bottom <= s.top || s.bottom <= c.top);
    const imgsInsideSpans = [...document.querySelectorAll("#selinfo .si-icon")].every((img) => img.parentElement?.tagName === "SPAN");
    const dpr = window.__oa.gs.renderer.getPixelRatio();
    return { w: window.__oa.gs.renderer.domElement.width, h: window.__oa.gs.renderer.domElement.height, cw: window.__oa.gs.canvas.clientWidth, dpr, overlap, imgsInsideSpans };
  });
  ok(resized.cw === 1024 && Math.abs(resized.w - Math.round(1024 * resized.dpr)) <= 2 && !resized.overlap && resized.imgsInsideSpans, "Resize 1024x680: renderer + zero HUD overlap + inline icons", JSON.stringify(resized));

  // 9b. Pressing A with empty selection does NOT leave attack-move armed
  await page.keyboard.press("Escape");
  await sleep(100);
  await page.keyboard.press("a");
  await sleep(100);
  const emptyAmove = await ev(() => ({ armed: window.__oa.input.amoveNext, cls: document.getElementById("verb-amove")?.classList.contains("armed") }));
  ok(!emptyAmove.armed && !emptyAmove.cls, "A with empty selection does not stay armed", JSON.stringify(emptyAmove));

  await page.setViewport({ width: VW, height: VH });
  await sleep(250);

  // 10. Close-up visual showcase shot of articulated infantry, sloped tanks & ConYard
  await ev(() => {
    // Center close-up on player's base & starting army
    window.__oa.gs.camTarget.set(7.5, 0, 8.2);
    window.__oa.gs.camHeight = 12;
    window.__oa.gs.updateCamera();
  });
  await sleep(400);
  await page.screenshot({ path: "test/shots/wp-02-closeup-units.png" });

  // Wide overview shot
  await ev(() => {
    window.__oa.gs.camTarget.set(11, 0, 11);
    window.__oa.gs.camHeight = 26;
    window.__oa.gs.updateCamera();
  });
  await sleep(300);
  await page.screenshot({ path: "test/shots/wp-03-base-overview.png" });

  ok(pageErrs.length === 0, "Zero runtime page errors", pageErrs.join("; "));
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
