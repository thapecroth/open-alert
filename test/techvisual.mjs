// Tech-tree visual QA: sidebar icons, new building/unit meshes, factory
// upgrade flow, and the radar-gated minimap — all in real Chrome.
// Uses a second headless page as a passive 2nd player (no bot => no attacks).
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";

const HTTP = process.env.OA_HTTP || "http://localhost:8787";
const ROOM = "tq" + Date.now().toString(36);
mkdirSync("test/shots", { recursive: true });
const shot = (p, n) => p.screenshot({ path: `test/shots/${n}.png` });
const shotEl = async (p, sel, n) => {
  const el = await p.$(sel);
  if (!el) return console.log("MISSING ELEMENT", sel);
  await el.screenshot({ path: `test/shots/${n}.png` });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(0).padStart(4) + "s", ...a);
const report = { icons: [], placed: {}, selinfo: "", badge: "", minimapGate: null };

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  protocolTimeout: 480000, // SwiftShader frames can starve the main thread
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--window-size=1360,820"],
  defaultViewport: { width: 1360, height: 820 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => log("PAGE ERROR:", e.message));
page.on("error", (e) => log("PAGE CRASH:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") log("CONSOLE ERR:", m.text());
});
await page.goto(`${HTTP}/?room=${ROOM}&name=TechQA`, { waitUntil: "domcontentloaded" });
await sleep(3000);

// second player joins same room under a different token so it isn't a rejoin.
// tiny viewport => its SwiftShader render loop stays cheap and doesn't starve page 1.
const page2 = await browser.newPage();
await page2.setViewport({ width: 240, height: 160 });
await page2.evaluateOnNewDocument(() => localStorage.setItem("oa-token", "qa-bystander-" + Math.random().toString(36).slice(2, 10)));
await page2.goto(`${HTTP}/?room=${ROOM}&name=Bystander`, { waitUntil: "domcontentloaded" });
await sleep(2000);
await shot(page, "tech-01-lobby");

// non-host must ready up before the host can start
await page2.evaluate(() => document.getElementById("ready-btn")?.click());
await sleep(800);
log("starting game");
await page.evaluate(() => document.getElementById("start-btn")?.click());
await sleep(4500);
await shot(page, "tech-02-start");
log("game started");

// ---------- sidebar icon census: 10 structures + 8 army, all rendered ----------
report.icons = await page.evaluate(async () => {
  const out = [];
  for (const span of document.querySelectorAll(".icon[data-kind]")) {
    const kind = span.dataset.kind;
    const has = span.classList.contains("has-icon");
    let frac = null;
    const m = /url\(("|')?(data:image\/png;base64,[^"')]+)\1\)/.exec(span.style.backgroundImage || "");
    if (m) {
      const img = new Image();
      await new Promise((res) => {
        img.onload = res;
        img.onerror = res;
        img.src = m[2];
      });
      const c = document.createElement("canvas");
      c.width = c.height = 96;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, 96, 96).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        // count pixels that aren't the clear-color dark navy or fully transparent
        if (d[i + 3] > 30 && Math.abs(d[i] - 10) + Math.abs(d[i + 1] - 16) + Math.abs(d[i + 2] - 24) > 40) lit++;
      }
      frac = +(lit / (96 * 96)).toFixed(3);
    }
    out.push({ kind, has, frac });
  }
  return out;
});
const iconCount = report.icons.filter((i) => i.has).length;
log(`ICONS: ${iconCount}/${report.icons.length} have rendered thumbnails`);
for (const i of report.icons) if (!i.has || i.frac === null || i.frac < 0.02) log("  ICON PROBLEM:", JSON.stringify(i));
await shotEl(page, "#sidebar", "tech-03-sidebar");
log("sidebar shot done");
await shotEl(page, "#minimap", "tech-04-minimap-noradar");
log("minimap shot done");

// ---------- in-page QA helpers ----------
log("injecting helpers");
await page.evaluate(() => {
  const oa = window.__oa;
  const BW = {
    conyard: [3, 3], power: [2, 2], refinery: [3, 2], barracks: [2, 2],
    radar: [2, 2], factory: [3, 3], factory2: [3, 3], techlab: [3, 3],
    turret: [1, 1], arc: [1, 1], purifier: [2, 2], depot: [3, 2],
  };
  const isB = (k) => k in BW;
  let sx = 0, sy = 0, n = 0;
  for (const k of oa.gs.oreSlots.keys()) { sx += k % 64; sy += (k / 64) | 0; n++; }
  const oc = n ? { x: sx / n, y: sy / n } : { x: 32, y: 32 };
  const gapToOwn = (tx, ty, w, h) => {
    let best = 99;
    for (const t of oa.renderer.tracked.values()) {
      const e = t.last;
      if (e.o !== oa.slot || !isB(e.k)) continue;
      const d = BW[e.k], bx = e.x - d[0] / 2, by = e.y - d[1] / 2;
      const gx = Math.max(bx - (tx + w), tx - (bx + d[0]));
      const gy = Math.max(by - (ty + h), ty - (by + d[1]));
      best = Math.min(best, Math.max(gx, gy));
    }
    return best;
  };
  window.__qa = {
    BW, isB, tried: new Set(),
    ent(kind) {
      return [...oa.renderer.tracked.values()].find((t) => t.last.o === oa.slot && t.last.k === kind)?.last ?? null;
    },
    findSpot(kind) {
      const [w, h] = BW[kind];
      const cy = this.ent("conyard") ?? { x: 6, y: 6 };
      const cands = [];
      for (let ty = 0; ty <= 64 - h; ty++) for (let tx = 0; tx <= 64 - w; tx++) {
        const mx = tx + w / 2, my = ty + h / 2;
        const dCon = Math.hypot(mx - cy.x, my - cy.y);
        if (dCon > 16) continue;
        const key = tx + "," + ty;
        if (this.tried.has(key)) continue;
        const gap = gapToOwn(tx, ty, w, h);
        if (gap < 0 || gap > 2) continue; // need adjacency <=2 anyway; <0 means overlap
        const dOre = Math.hypot(mx - oc.x, my - oc.y);
        // prefer: a little breathing room (gap ~1-2), close-ish to base, away from ore
        cands.push({ tx, ty, score: dCon - dOre * 0.5 - Math.min(gap, 2) * 2 });
      }
      cands.sort((a, b) => a.score - b.score);
      for (const c of cands) if (this.occ(c.tx, c.ty, w, h)) return c;
      return null;
    },
    occ(tx, ty, w, h) {
      if (tx < 0 || ty < 0 || tx + w > 64 || ty + h > 64) return false;
      for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) if (oa.gs.oreSlots.has(y * 64 + x)) return false;
      for (const t of oa.renderer.tracked.values()) {
        const e = t.last;
        if (isB(e.k)) {
          const d = BW[e.k], bx = Math.round(e.x - d[0] / 2), by = Math.round(e.y - d[1] / 2);
          if (tx < bx + d[0] && tx + w > bx && ty < by + d[1] && ty + h > by) return false;
        } else {
          const ux = Math.floor(e.x), uy = Math.floor(e.y);
          if (ux >= tx && ux < tx + w && uy >= ty && uy < ty + h) return false;
        }
      }
      return true;
    },
    look(x, y, ang, dist, h) {
      // free camera — ang 0 puts the camera on the +z (front) side of the model
      const c = oa.gs.camera;
      c.position.set(x + Math.sin(ang) * dist, h, y + Math.cos(ang) * dist);
      c.lookAt(x, 1, y);
    },
    overview(x, y, hh) {
      oa.gs.camTarget.set(x, 0, y);
      oa.gs.camHeight = hh;
      oa.gs.updateCamera();
    },
    select(ids) {
      oa.input.selection = new Set(ids);
      oa.renderer.setSelected(oa.input.selection);
    },
  };
});

const waitFor = async (fn, arg = null, timeout = 150000) => {
  try {
    await page.waitForFunction(fn, { timeout, polling: 300 }, arg);
    return true;
  } catch {
    return false;
  }
};

const buildAndPlace = async (kind, cost) => {
  log("build queued:", kind);
  const okFunds = await waitFor((c) => {
    const s = window.__oa.state;
    return s && !s.bq && !s.awaiting && s.credits >= c && !s.eliminated;
  }, cost);
  if (!okFunds) {
    console.log("TIMEOUT waiting funds/queue for", kind, JSON.stringify(await page.evaluate(() => window.__oa.state)));
    return false;
  }
  await page.evaluate((k) => window.__oa.net.send({ t: "build", kind: k }), kind);
  const okAwait = await waitFor((k) => window.__oa.state?.awaiting === k, kind, 60000);
  if (!okAwait) {
    console.log("TIMEOUT awaiting", kind, JSON.stringify(await page.evaluate(() => window.__oa.state)));
    return false;
  }
  for (let i = 0; i < 60; i++) {
    const r = await page.evaluate((k) => {
      const oa = window.__oa, qa = window.__qa;
      if (oa.state?.awaiting !== k) return "done";
      const s = qa.findSpot(k);
      if (!s) return "nospot";
      qa.tried.add(s.tx + "," + s.ty);
      oa.net.send({ t: "place", tx: s.tx, ty: s.ty });
      return "try";
    }, kind);
    if (r !== "try") {
      if (r === "nospot") console.log("NO SPOT for", kind);
      break;
    }
    await sleep(500);
  }
  const placed = await page.evaluate((k) => !!window.__qa.ent(k), kind);
  report.placed[kind] = placed;
  console.log("BUILD", kind, placed ? "placed" : "FAILED", "| credits:", await page.evaluate(() => window.__oa.state?.credits));
  return placed;
};

// ---------- build the base ----------
await buildAndPlace("power", 300);
await buildAndPlace("refinery", 600);
await buildAndPlace("barracks", 500);
await page.evaluate(() => {
  const q = window.__qa, e = q.ent("conyard");
  if (e) q.overview(e.x + 3, e.y + 3, 30);
});
await sleep(500);
await shot(page, "tech-05-early-base");

// radar + the minimap gate flipping live
await buildAndPlace("radar", 700);
await page.evaluate(() => {
  const q = window.__qa, e = q.ent("radar");
  if (e) q.look(e.x, e.y, 0.8, 10, 5.5);
});
await sleep(600);
await shot(page, "tech-06-radar");
await shotEl(page, "#minimap", "tech-07-minimap-live");
report.minimapGate = await page.evaluate(() => {
  // verify the canvas now draws map content instead of the text gate
  const c = document.getElementById("minimap");
  const d = c.getContext("2d").getImageData(0, 0, 160, 160).data;
  let nonBg = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) nonBg++;
  return { nonBgPx: nonBg };
});

await buildAndPlace("power", 300);
await buildAndPlace("factory", 1000);
await buildAndPlace("depot", 800);
await buildAndPlace("arc", 800);
await page.evaluate(() => {
  const q = window.__qa, e = q.ent("conyard");
  if (e) q.overview(e.x + 3, e.y + 4, 34);
});
await sleep(500);
await shot(page, "tech-08-mid-base");

// train the new units while the tech climb continues. barracks queue only
// takes one unit kind at a time, so wait for each slot to clear first.
await waitFor(() => window.__oa.state?.credits >= 500);
await page.evaluate(() => window.__oa.net.send({ t: "train", unit: "engineer" }));
await waitFor(() => !window.__oa.state?.queues?.barracks, null, 30000);
await waitFor(() => window.__oa.state?.credits >= 300);
await page.evaluate(() => window.__oa.net.send({ t: "train", unit: "rocket" }));
await waitFor(() => window.__oa.state?.credits >= 1100);
await page.evaluate(() => window.__oa.net.send({ t: "train", unit: "arty" })); // factory queue — independent

await buildAndPlace("power", 300);
await buildAndPlace("techlab", 1800);
await page.evaluate(() => {
  const q = window.__qa, e = q.ent("techlab");
  if (e) q.look(e.x, e.y, 0.7, 10, 6);
});
await sleep(600);
await shot(page, "tech-09-techlab");

await buildAndPlace("purifier", 900);
await page.evaluate(() => {
  const q = window.__qa, e = q.ent("purifier");
  if (e) q.look(e.x, e.y, 0.7, 9, 5);
});
await sleep(600);
await shot(page, "tech-10-purifier");

// ---------- units on the field ----------
await waitFor(() => !!window.__qa.ent("arty") && !!window.__qa.ent("engineer") && !!window.__qa.ent("rocket"), null, 60000);
await page.evaluate(() => {
  const q = window.__qa, oa = window.__oa;
  const cy = q.ent("conyard") ?? { x: 6, y: 6 };
  const ids = [...oa.renderer.tracked.values()]
    .filter((t) => t.last.o === oa.slot && ["engineer", "rocket", "arty", "tank", "harvester"].includes(t.last.k))
    .map((t) => t.last.id);
  oa.net.send({ t: "order", ids, kind: "move", x: cy.x + 7, y: cy.y + 7 });
});
await sleep(7000);
await page.evaluate(() => {
  const q = window.__qa, oa = window.__oa;
  const us = [...oa.renderer.tracked.values()].filter((t) => t.last.o === oa.slot && !q.isB(t.last.k));
  if (us.length) {
    const x = us.reduce((s, t) => s + t.last.x, 0) / us.length;
    const y = us.reduce((s, t) => s + t.last.y, 0) / us.length;
    q.look(x, y, 0.5, 10, 5);
  }
});
await sleep(600);
await shot(page, "tech-11-units");

// ---------- factory upgrade ----------
await waitFor(() => window.__oa.state?.credits >= 1500);
const facId = await page.evaluate(() => window.__qa.ent("factory")?.id ?? window.__qa.ent("factory2")?.id);
await page.evaluate((id) => {
  window.__qa.select([id]);
  const e = window.__qa.ent("factory") ?? window.__qa.ent("factory2");
  if (e) window.__qa.look(e.x, e.y, 0.7, 11, 6);
}, facId);
await sleep(800); // let a snap refresh #selinfo with the button
report.selinfo = await page.evaluate(() => document.getElementById("selinfo").innerText);
console.log("SELINFO:", JSON.stringify(report.selinfo));
await shot(page, "tech-12-upgrade-btn");

await page.evaluate(() => {
  const b = [...document.querySelectorAll("#selinfo button")].find((x) => /UPGRADE/i.test(x.textContent));
  if (b) b.click();
  else {
    const id = window.__oa.input.selection.values().next().value;
    if (id != null) window.__oa.net.send({ t: "upgrade", id });
  }
});
await waitFor(() => !!window.__qa.ent("factory2"), null, 20000);
await page.evaluate(() => {
  const q = window.__qa, e = q.ent("factory2");
  if (e) {
    q.select([e.id]);
    q.look(e.x, e.y, 0.7, 11, 6);
  }
});
await sleep(800);
report.badge = await page.evaluate(() => document.getElementById("selinfo").innerText);
console.log("BADGE:", JSON.stringify(report.badge));
await shot(page, "tech-13-factory2");

// ---------- finale: everything at once ----------
await page.evaluate(() => {
  const q = window.__qa, e = q.ent("conyard");
  if (e) q.overview(e.x + 4, e.y + 5, 40);
});
await sleep(500);
await shot(page, "tech-14-final");

const st = await page.evaluate(() => {
  const oa = window.__oa;
  return {
    credits: oa.state?.credits,
    phase: oa.phase,
    mine: [...oa.renderer.tracked.values()].filter((t) => t.last.o === oa.slot).map((t) => t.last.k),
  };
});
console.log("FINAL:", JSON.stringify(st));
console.log("REPORT:", JSON.stringify(report));
await browser.close();
console.log("done");
