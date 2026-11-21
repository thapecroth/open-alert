// Tech-tree visual QA: sidebar icons, new building/unit meshes, factory
// upgrade flow, and the radar-gated minimap — all in real Chrome.
//
// Notes:
// - A second headless page joins as a passive 2nd player (no bot => no attacks).
// - Shots go to /tmp during the run and are copied into test/shots/ at the end:
//   wrangler dev watches the project tree and each file write hot-reloads the
//   worker, which kills every room mid-game.
// - The whole QA is retried: if another file edit reloads the worker anyway,
//   the snap stream goes stale; we detect that and restart with a fresh room.
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync, copyFileSync, readdirSync } from "fs";

const HTTP = process.env.OA_HTTP || "http://localhost:8787";
const SHOT_TMP = "/tmp/oa-tech-shots";
const SHOT_OUT = "test/shots";
mkdirSync(SHOT_TMP, { recursive: true });
mkdirSync(SHOT_OUT, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(0).padStart(4) + "s", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { icons: [], placed: {}, selinfo: "", badge: "", minimapGate: null };

const shot = (p, n) => p.screenshot({ path: `${SHOT_TMP}/${n}.png` });
// ElementHandle.screenshot's captureBeyondViewport path can deadlock under
// SwiftShader load — clip a normal page.screenshot to the element box instead.
const clipShot = async (p, sel, n) => {
  const r = await p.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  }, sel);
  if (!r) return log("MISSING ELEMENT", sel);
  r.x = Math.max(0, r.x);
  r.y = Math.max(0, r.y);
  r.width = Math.max(1, Math.min(r.width, 1360 - r.x));
  r.height = Math.max(1, Math.min(r.height, 820 - r.y));
  await p.screenshot({ path: `${SHOT_TMP}/${n}.png`, clip: r });
};
// read a canvas element directly — no compositor capture needed
const grabCanvas = async (p, sel, n) => {
  const data = await p.evaluate((s) => document.querySelector(s)?.toDataURL("image/png") ?? null, sel);
  if (!data) return log("MISSING CANVAS", sel);
  writeFileSync(`${SHOT_TMP}/${n}.png`, Buffer.from(data.split(",")[1], "base64"));
};

// SwiftShader renders every rAF frame on CPU in the GPU process — an
// unthrottled loop saturates it and CDP screenshots/evaluates starve.
// Cap frame rate in-page so the pipeline drains between frames.
const throttleRAF = () => {
  const orig = window.requestAnimationFrame.bind(window);
  let last = 0;
  window.requestAnimationFrame = (cb) => {
    const wrapped = (t) => (t - last < 350 ? orig(wrapped) : ((last = t), cb(t)));
    return orig(wrapped);
  };
};

class DeadWorld extends Error {}

async function attempt(k) {
  const ROOM = `tq${Date.now().toString(36)}a${k}`;
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: "new",
    protocolTimeout: 480000,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--window-size=1360,820"],
    defaultViewport: { width: 1360, height: 820 },
  });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(throttleRAF);
    page.on("pageerror", (e) => log("PAGE ERROR:", e.message));
    page.on("error", (e) => log("PAGE CRASH:", e.message));
    page.on("console", (m) => {
      if (m.type() === "error") log("CONSOLE ERR:", m.text());
    });
    await page.goto(`${HTTP}/?room=${ROOM}&name=TechQA`, { waitUntil: "domcontentloaded" });
    await sleep(3000);

    // second player: same room, distinct token, minimal render cost
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 240, height: 160 });
    await page2.evaluateOnNewDocument(throttleRAF);
    await page2.evaluateOnNewDocument(() => localStorage.setItem("oa-token", "qa-bystander-" + Math.random().toString(36).slice(2, 10)));
    await page2.goto(`${HTTP}/?room=${ROOM}&name=Bystander`, { waitUntil: "domcontentloaded" });
    await sleep(2000);
    await shot(page, "tech-01-lobby");

    await page2.evaluate(() => document.getElementById("ready-btn")?.click());
    await sleep(800);
    await page.evaluate(() => document.getElementById("start-btn")?.click());
    await sleep(4500);
    await shot(page, "tech-02-start");
    log("game started");

    // ---------- sidebar icon census ----------
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
    await clipShot(page, "#sidebar", "tech-03-sidebar");
    await grabCanvas(page, "#minimap", "tech-04-minimap-noradar");

    // ---------- in-page QA helpers ----------
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
      // world-liveness: snaps stream at 5Hz while a world exists; a worker
      // reload resets the room and the stream dies.
      window.__qaLastSnap = Date.now();
      window.__qaDenies = [];
      const origOnMsg = oa.net.onMsg;
      oa.net.onMsg = (m) => {
        if (m.t === "snap") window.__qaLastSnap = Date.now();
        else if (m.t === "deny") window.__qaDenies.push(m.msg);
        origOnMsg(m);
      };
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
        alive() {
          return Date.now() - (window.__qaLastSnap || 0) < 20000;
        },
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
            if (gap < 0 || gap > 2) continue;
            const dOre = Math.hypot(mx - oc.x, my - oc.y);
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
    log("helpers ready");

    const waitFor = async (fn, arg = null, timeout = 120000) => {
      try {
        await page.waitForFunction(fn, { timeout, polling: 300 }, arg);
        return true;
      } catch {
        return false;
      }
    };
    const aliveNow = () => page.evaluate(() => window.__qa.alive());
    const assertAlive = async () => {
      if (!(await aliveNow())) throw new DeadWorld("snap stream stale — worker reload/reset");
    };

    const fundsOk = (c) => {
      const s = window.__oa.state;
      return window.__qa.alive() && s && !s.bq && !s.awaiting && s.credits >= c && !s.eliminated;
    };
    const buildAndPlace = async (kind, cost) => {
      // state.credits lags the server's ledger by a snap or two — a send that
      // raced recent debits can be denied, so retry the send once.
      let sent = false;
      for (let tryN = 0; tryN < 2 && !sent; tryN++) {
        const okFunds = await waitFor(fundsOk, cost);
        if (!okFunds) {
          await assertAlive();
          log("TIMEOUT waiting funds/queue for", kind);
          return false;
        }
        await page.evaluate((k) => window.__oa.net.send({ t: "build", kind: k }), kind);
        sent = await waitFor((k) => {
          const s = window.__oa.state;
          return window.__qa.alive() && (s?.awaiting === k || s?.bq?.kind === k);
        }, kind, 20000);
        if (!sent) log("build", kind, "not accepted (stale funds?), denies:", JSON.stringify(await page.evaluate(() => window.__qaDenies)));
      }
      const okAwait = await waitFor((k) => window.__qa.alive() && window.__oa.state?.awaiting === k, kind, 90000);
      if (!okAwait) {
        await assertAlive();
        log("TIMEOUT awaiting", kind, "denies:", JSON.stringify(await page.evaluate(() => window.__qaDenies)));
        return false;
      }
      for (let i = 0; i < 60; i++) {
        const r = await page.evaluate((k) => {
          const oa = window.__oa, qa = window.__qa;
          if (!qa.alive()) return "dead";
          if (oa.state?.awaiting !== k) return "done";
          const s = qa.findSpot(k);
          if (!s) return "nospot";
          qa.tried.add(s.tx + "," + s.ty);
          oa.net.send({ t: "place", tx: s.tx, ty: s.ty });
          return "try";
        }, kind);
        if (r === "dead") throw new DeadWorld("room reset during placement");
        if (r !== "try") {
          if (r === "nospot") log("NO SPOT for", kind);
          break;
        }
        await sleep(500);
      }
      const placed = await page.evaluate((k) => !!window.__qa.ent(k), kind);
      report.placed[kind] = placed;
      log("BUILD", kind, placed ? "placed" : "FAILED", "| credits:", await page.evaluate(() => window.__oa.state?.credits));
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
    await grabCanvas(page, "#minimap", "tech-07-minimap-live");
    report.minimapGate = await page.evaluate(() => {
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

    // train the new units. A send is only confirmed when the queue appears in
    // a later snap — otherwise it may have been silently denied.
    const trainUnit = async (unit, cost, cat) => {
      await waitFor((c) => window.__qa.alive() && window.__oa.state?.credits >= c, cost);
      await sleep(700); // let a snap land so the credits read isn't stale
      await page.evaluate((u) => window.__oa.net.send({ t: "train", unit: u }), unit);
      const ok = await waitFor(
        (c) => window.__qa.alive() && window.__oa.state?.queues?.[c]?.unit != null,
        cat,
        15000,
      );
      if (!ok) log("TRAIN", unit, "never queued; denies:", JSON.stringify(await page.evaluate(() => window.__qaDenies)));
      else log("TRAIN", unit, "queued");
      return ok;
    };
    await trainUnit("engineer", 500, "barracks");
    // barracks only takes one unit kind at a time — wait for it to drain
    await waitFor(() => window.__qa.alive() && !window.__oa.state?.queues?.barracks, null, 40000);
    await trainUnit("rocket", 300, "barracks");
    await trainUnit("arty", 1100, "factory");

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
    await waitFor(() => window.__qa.alive() && !!window.__qa.ent("arty") && !!window.__qa.ent("engineer") && !!window.__qa.ent("rocket"), null, 60000);
    await assertAlive();
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
      // frame only the NEW unit kinds, close in — the tiny infantry meshes need it
      const us = [...oa.renderer.tracked.values()].filter(
        (t) => t.last.o === oa.slot && ["engineer", "rocket", "arty"].includes(t.last.k),
      );
      if (us.length) {
        const x = us.reduce((s, t) => s + t.last.x, 0) / us.length;
        const y = us.reduce((s, t) => s + t.last.y, 0) / us.length;
        q.look(x, y, 0.5, 4.5, 2.4);
      }
    });
    await sleep(600);
    await shot(page, "tech-11-units");

    // ---------- factory upgrade ----------
    await waitFor(() => window.__qa.alive() && window.__oa.state?.credits >= 1500);
    await assertAlive();
    const facId = await page.evaluate(() => window.__qa.ent("factory")?.id ?? window.__qa.ent("factory2")?.id);
    await page.evaluate((id) => {
      window.__qa.select([id]);
      const e = window.__qa.ent("factory") ?? window.__qa.ent("factory2");
      if (e) window.__qa.look(e.x, e.y, 0.7, 11, 6);
    }, facId);
    await sleep(800); // let a snap refresh #selinfo with the button
    report.selinfo = await page.evaluate(() => document.getElementById("selinfo").innerText);
    log("SELINFO:", JSON.stringify(report.selinfo));
    await shot(page, "tech-12-upgrade-btn");

    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#selinfo button")].find((x) => /UPGRADE/i.test(x.textContent));
      if (b) b.click();
      else {
        const id = window.__oa.input.selection.values().next().value;
        if (id != null) window.__oa.net.send({ t: "upgrade", id });
      }
    });
    const upgraded = await waitFor(() => window.__qa.alive() && !!window.__qa.ent("factory2"), null, 20000);
    if (!upgraded) log("UPGRADE failed; denies:", JSON.stringify(await page.evaluate(() => window.__qaDenies)));
    await page.evaluate(() => {
      const q = window.__qa, e = q.ent("factory2");
      if (e) {
        q.select([e.id]);
        q.look(e.x, e.y, 0.7, 11, 6);
      }
    });
    await sleep(800);
    report.badge = await page.evaluate(() => document.getElementById("selinfo").innerText);
    log("BADGE:", JSON.stringify(report.badge));
    await shot(page, "tech-13-factory2");

    // ---------- finale ----------
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
    log("FINAL:", JSON.stringify(st));
  } finally {
    await browser.close().catch(() => {});
  }
}

let done = false;
for (let k = 1; k <= 4 && !done; k++) {
  try {
    log(`--- attempt ${k} ---`);
    await attempt(k);
    done = true;
  } catch (e) {
    log(`attempt ${k} failed:`, e instanceof DeadWorld ? "world reset (worker reload)" : e.message);
  }
}
for (const f of readdirSync(SHOT_TMP)) if (f.startsWith("tech-")) copyFileSync(`${SHOT_TMP}/${f}`, `${SHOT_OUT}/${f}`);
log("REPORT:", JSON.stringify(report));
log(done ? "done" : "ALL ATTEMPTS FAILED");
