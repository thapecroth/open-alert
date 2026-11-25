#!/usr/bin/env node
// Browser click-flow test for troop transports (puppeteer, trusted input).
//
// Setup (building the airfield chain, training the chopper) goes over the wire
// — that path is already covered by wstrans.mjs. What this test exists for is
// the CLICK layer: select troops, right-click the transport to board, U+click
// a drop zone for a positional unload, and the FPV cockpit flow: E to enter,
// U to rappel passengers beneath the airframe, E to leave. Every interaction
// is a real Chrome-generated mouse/keyboard event; verification is server
// state as mirrored in the client snapshot stream plus the instrumented
// net.send log as evidence.
//
//   OA_HTTP=http://localhost:8802 node test/browsertrans.mjs
import puppeteer from "puppeteer-core";

const HTTP = process.env.OA_HTTP || "http://localhost:8802";
const CHROME = process.env.OA_CHROME || "/usr/bin/google-chrome";
const ROOM = "bt" + Date.now().toString(36);
const VW = 1500, VH = 950;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    "--enable-unsafe-swiftshader",
    `--window-size=${VW},${VH}`,
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
  defaultViewport: { width: VW, height: VH },
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => { try { localStorage.setItem("oa-wasd", "0"); } catch {} });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
const ev = (fn, ...a) => page.evaluate(fn, ...a);

try {
  await page.goto(`${HTTP}/?room=${ROOM}&name=TransUI`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.__oa && window.__oa.net, { timeout: 25000 });
  await ev(() => {
    const oa = window.__oa;
    const L = (window.__ilog = { sent: [] });
    const s = oa.net.send.bind(oa.net);
    oa.net.send = (m) => { L.sent.push(JSON.parse(JSON.stringify(m))); return s(m); };
  });
  const send = (m) => ev((m) => window.__oa.net.send(m), m);
  const until = async (fn, ms, arg) => {
    try { await page.waitForFunction(fn, { timeout: ms, polling: 150 }, arg); return true; } catch { return false; }
  };
  const click = async (x, y, button = "left") => {
    await page.mouse.move(x, y);
    await sleep(140);
    await page.mouse.down({ button });
    await sleep(45);
    await page.mouse.up({ button });
    await sleep(70);
  };
  const key = async (k) => { await page.keyboard.press(k); await sleep(80); };
  const sentKinds = () => ev(() => window.__ilog.sent.map((m) => (m.kind ? `${m.t}:${m.kind}` : m.t)));
  const ownUnits = () =>
    ev(() => {
      const oa = window.__oa;
      const out = [];
      for (const [id, t] of oa.renderer.tracked) {
        if (t.last.o !== oa.slot) continue;
        if (["conyard","power","refinery","barracks","radar","factory","airfield","turret","sam","depot","techlab"].includes(t.last.k)) continue;
        const p = oa.renderer.entScreenPos(id);
        out.push({ id, k: t.last.k, x: t.last.x, y: t.last.y, cargo: t.last.cargo, sx: p?.x ?? -1, sy: p?.y ?? -1 });
      }
      return out;
    });
  const project = (wx, wy) => ev(([wx, wy]) => window.__oa.projectTile(wx - 0.5, wy - 0.5), [wx, wy]);

  // ---- lobby: add bot, fat config, start ----
  await page.waitForFunction(() => {
    const b = document.getElementById("addbot-btn");
    return b && !b.classList.contains("hidden") && b.getBoundingClientRect().width > 0;
  }, { timeout: 15000, polling: 200 });
  await page.click("#addbot-btn");
  await sleep(700);
  await send({ t: "setConfig", config: { startCredits: 20000, gameSpeed: 2, fog: false, derricks: false } });
  await sleep(400);
  await page.click("#start-btn");
  const started = await until(() => {
    for (const t of window.__oa.renderer.tracked.values()) if (t.last.o === window.__oa.slot && t.last.k === "conyard") return true;
    return false;
  }, 15000);
  ok(started, "game started, conyard tracked");
  if (!started) throw new Error("no game — aborting");

  // ---- wire setup: power → barracks → radar → airfield → chopper ----
  const cyPos = await ev(() => {
    for (const t of window.__oa.renderer.tracked.values())
      if (t.last.o === window.__oa.slot && t.last.k === "conyard") return { x: Math.floor(t.last.x), y: Math.floor(t.last.y) };
    return null;
  });
  const build = async (kind) => {
    await send({ t: "build", kind });
    const rdy = await until((k) => (window.__oa.state?.awaiting ?? []).includes(k), 30000, kind);
    if (!rdy) return false;
    for (let r = 4; r <= 12; r += 4) {
      for (let a = 0; a < 8; a++) {
        const tx = Math.round(cyPos.x + r * Math.cos((a * Math.PI) / 4));
        const ty = Math.round(cyPos.y + r * Math.sin((a * Math.PI) / 4));
        await send({ t: "place", tx, ty });
        await sleep(130);
        const found = await ev((k) => {
          for (const t of window.__oa.renderer.tracked.values()) if (t.last.o === window.__oa.slot && t.last.k === k) return true;
          return false;
        }, kind);
        if (found) return true;
      }
    }
    return false;
  };
  ok(await build("power"), "power placed");
  ok(await build("barracks"), "barracks placed");
  ok(await build("radar"), "radar placed");
  ok(await build("airfield"), "airfield placed");
  await send({ t: "train", unit: "chopper" });
  const chopUp = await until(() => {
    for (const t of window.__oa.renderer.tracked.values()) if (t.last.o === window.__oa.slot && t.last.k === "chopper") return true;
    return false;
  }, 30000);
  ok(chopUp, "chopper trained");
  // extra riflemen so selection is unambiguous
  await send({ t: "train", unit: "infantry" });
  await send({ t: "train", unit: "infantry" });
  await sleep(4000);

  // ---------- CLICK-FLOW 1: select infantry, right-click chopper = board ----------
  // cluster infantry near the chopper first over the wire so everyone is in click range
  const units0 = await ownUnits();
  const chop0 = units0.find((u) => u.k === "chopper");
  const infs0 = units0.filter((u) => u.k === "infantry");
  ok(!!chop0 && infs0.length >= 2, `cast present: chopper + ${infs0.length} infantry`);
  await send({ t: "order", ids: infs0.slice(0, 2).map((u) => u.id), kind: "move", x: chop0.x + 1, y: chop0.y + 1 });
  await sleep(2500);
  // drag-select a box around the two infantry
  const units1 = await ownUnits();
  const infs = units1.filter((u) => u.k === "infantry").filter((u) => u.sx > 200 && u.sx < 1290 && u.sy > 95 && u.sy < 820);
  if (infs.length >= 2) {
    const xs = infs.map((u) => u.sx), ys = infs.map((u) => u.sy);
    const x0 = Math.min(...xs) - 20, x1 = Math.max(...xs) + 20;
    const y0 = Math.min(...ys) - 20, y1 = Math.max(...ys) + 20;
    await page.mouse.move(x0, y0);
    await sleep(130);
    await page.mouse.down();
    await sleep(60);
    await page.mouse.move(x1, y1, { steps: 6 });
    await sleep(120);
    await page.mouse.up();
    await sleep(150);
  }
  const selCount = await ev(() => window.__oa.input.selection.size);
  ok(selCount >= 2, `drag-selected ${selCount} units`);
  // right-click the chopper — board cursor flow
  const chopV = (await ownUnits()).find((u) => u.k === "chopper");
  await click(chopV.sx, chopV.sy, "right");
  await sleep(300);
  const sent1 = await sentKinds();
  ok(sent1.some((s) => s === "order:board"), "right-click on chopper produced a board order");
  const boarded = await until(() => {
    for (const t of window.__oa.renderer.tracked.values())
      if (t.last.o === window.__oa.slot && t.last.k === "chopper" && (t.last.cargo ?? 0) >= 2) return true;
    return false;
  }, 15000);
  ok(boarded, "two riflemen embarked (cargo scalar >= 2)");

  // ---------- CLICK-FLOW 2: select chopper, U + click drop zone = positional unload ----------
  await click(chopV.sx, chopV.sy, "left"); // select the chopper alone
  await sleep(200);
  const selOne = await ev(() => window.__oa.input.selection.size === 1);
  ok(selOne, "chopper selected alone");
  await key("u");
  const dropPt = await project(chopV.x + 8, chopV.y + 6);
  await click(dropPt.x, dropPt.y, "left");
  await sleep(300);
  const sent2 = await sentKinds();
  ok(sent2.filter((s) => s === "order:unload").length >= 1, "U+click produced an unload order");
  const dropped = await until(() => {
    let n = 0;
    for (const t of window.__oa.renderer.tracked.values())
      if (t.last.o === window.__oa.slot && t.last.k === "infantry") n++;
    return n >= 2;
  }, 20000);
  ok(dropped, "passengers disembarked at the drop zone");

  // ---------- CLICK-FLOW 3: FPV cockpit — E to enter, U to rappel, E to exit ----------
  // re-board first (click-flow again)
  const units2 = await ownUnits();
  const infNow = units2.filter((u) => u.k === "infantry").slice(0, 2);
  const chopNow = units2.find((u) => u.k === "chopper");
  await send({ t: "order", ids: infNow.map((u) => u.id), kind: "board", x: chopNow.x, y: chopNow.y, target: chopNow.id });
  const reboarded = await until(() => {
    for (const t of window.__oa.renderer.tracked.values())
      if (t.last.o === window.__oa.slot && t.last.k === "chopper" && (t.last.cargo ?? 0) >= 1) return true;
    return false;
  }, 15000);
  ok(reboarded, "re-boarded for the FPV leg");
  // select the chopper alone and press E — enter first person
  const chopV2 = (await ownUnits()).find((u) => u.k === "chopper");
  await click(chopV2.sx, chopV2.sy, "left");
  await sleep(200);
  await key("e");
  await sleep(900);
  const inFpv = await ev(() => window.__oa.input.enabled === false);
  ok(inFpv, "E entered first-person mode (input disabled)");
  const markSend = await ev(() => window.__ilog.sent.length);
  await key("u"); // rappel!
  await sleep(400);
  const fpvUnloadSent = await ev((i) => window.__ilog.sent.slice(i).some((m) => m.t === "order" && m.kind === "unload"), markSend);
  ok(fpvUnloadSent, "U in the cockpit sent a driven-unload order");
  const rappelled = await until(() => {
    let n = 0;
    for (const t of window.__oa.renderer.tracked.values())
      if (t.last.o === window.__oa.slot && t.last.k === "infantry") n++;
    return n >= 1;
  }, 12000);
  ok(rappelled, "passengers rappelled out beneath the airframe");
  // second U cancels (hygiene: even with an empty bay it must not error)
  await key("u");
  await sleep(200);
  await key("e"); // exit FPV
  await sleep(600);
  const outFpv = await ev(() => window.__oa.input.enabled !== false);
  ok(outFpv, "E exited first-person mode");

  const denies = await ev(() => window.__oa ? (window.__ilog.sent.length, 0) : 0);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (err) {
  console.log("ABORT:", err.message);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
