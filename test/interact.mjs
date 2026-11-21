#!/usr/bin/env node
// UI-interaction test for Open Alert (Three.js RTS) against a live server.
//
// Every action goes through the REAL input path — trusted PointerEvent /
// KeyboardEvent / wheel / contextmenu produced by Chrome itself via CDP
// (page.mouse / page.keyboard), exactly what a human produces. Nothing is
// injected through net.send for gameplay. Each check then verifies the
// SERVER-visible outcome in snapshots / PlayerState / deny messages.
//
//   node test/interact.mjs            # uses http://localhost:8787
//   OA_HTTP=http://host:port node test/interact.mjs
//
// Runtime (non-invasive) instrumentation: net.send and net.onMsg are wrapped
// inside the page to log C2S traffic and deny messages — evidence only.

import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";

const HTTP = process.env.OA_HTTP || "http://localhost:8787";
const CHROME = process.env.OA_CHROME || "/usr/bin/google-chrome";
const ROOM = "it" + Date.now().toString(36);
const VW = 1500,
  VH = 950;
// canvas is fullscreen; clicks must land on it, not on HUD overlays:
// topbar y<40, verbbar ~y48-80 center, sidebar x>1310, minimap x<175,y<215,
// chat/selinfo bottom-left. Keep interaction points inside this rect.
const SAFE = { x0: 200, x1: 1290, y0: 95, y1: 820 };
const inSafe = (p) => p && p.x > SAFE.x0 && p.x < SAFE.x1 && p.y > SAFE.y0 && p.y < SAFE.y1;

mkdirSync("test/shots", { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (name, ok, ev) => {
  const st = ok === null ? "SKIP" : ok ? "PASS" : "FAIL";
  results.push({ name, st, ev });
  console.log(`${st}  ${name}\n      ${ev}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", `--window-size=${VW},${VH}`],
  defaultViewport: { width: VW, height: VH },
});
const page = await browser.newPage();
const pageErrs = [];
page.on("pageerror", (e) => {
  pageErrs.push(e.message);
  console.log("PAGE ERROR:", e.message);
});
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: `test/shots/${n}.png` }).catch(() => {});

try {
  // ---------- boot ----------
  await page.goto(`${HTTP}/?room=${ROOM}&name=UITest`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.__oa && window.__oa.net, { timeout: 25000 });
  // instrument: log outgoing commands + incoming denies (evidence channel)
  await ev(() => {
    const oa = window.__oa;
    const L = (window.__ilog = { sent: [], deny: [] });
    const s = oa.net.send.bind(oa.net);
    oa.net.send = (m) => {
      L.sent.push(JSON.parse(JSON.stringify(m)));
      return s(m);
    };
    const h = oa.net.onMsg;
    oa.net.onMsg = (m) => {
      if (m.t === "deny") L.deny.push(m.msg);
      return h(m);
    };
    L.status = [];
    const stw = oa.net.onStatus;
    oa.net.onStatus = (s) => {
      L.status.push(s || "open");
      return stw(s);
    };
    window.__BK = new Set(["conyard", "power", "refinery", "barracks", "radar", "factory", "factory2", "techlab", "turret", "arc", "purifier", "depot"]);
    window.__DIMS = { conyard: [3, 3], power: [2, 2], refinery: [3, 2], barracks: [2, 2], radar: [2, 2], factory: [3, 3], factory2: [3, 3], techlab: [3, 3], turret: [1, 1], arc: [1, 1], purifier: [2, 2], depot: [3, 2] };
  });

  // ---------- helpers ----------
  const until = async (fn, ms, arg) => {
    try {
      await page.waitForFunction(fn, { timeout: ms, polling: 160 }, arg);
      return true;
    } catch {
      return false;
    }
  };
  const hover = async (x, y, ms = 170) => {
    await page.mouse.move(x, y);
    await sleep(ms);
  };
  const click = async (x, y, button = "left", holdMs = 45) => {
    await page.mouse.move(x, y);
    await sleep(150);
    await page.mouse.down({ button });
    await sleep(holdMs);
    await page.mouse.up({ button });
    await sleep(60);
  };
  const rightClick = (x, y) => click(x, y, "right");
  const onCanvas = (x, y) => ev(([x, y]) => document.elementFromPoint(x, y)?.id === "game", [x, y]);
  const mark = () => ev(() => window.__ilog.sent.length);
  const sentAfter = (i) => ev((i) => window.__ilog.sent.slice(i), i);
  const denyCount = () => ev(() => window.__ilog.deny.length);
  const deniesAfter = (i) => ev((i) => window.__ilog.deny.slice(i), i);
  const project = (wx, wz) => ev(([wx, wz]) => window.__oa.projectTile(wx - 0.5, wz - 0.5), [wx, wz]);
  const gs = () =>
    ev(() => {
      const oa = window.__oa;
      return {
        slot: oa.slot,
        phase: oa.phase,
        credits: oa.state?.credits,
        awaiting: oa.state?.awaiting ?? null,
        bq: oa.state?.bq?.kind ?? null,
        camH: oa.gs.camHeight,
        camX: oa.gs.camTarget.x,
        camZ: oa.gs.camTarget.z,
        sel: oa.input.selection.size,
        placing: oa.input.placing,
        cancelled: oa.input.placingCancelled,
        verb: oa.input.verb,
        amove: oa.input["amoveNext"],
      };
    });
  const ownUnits = () =>
    ev(() => {
      const oa = window.__oa;
      const out = [];
      for (const [id, t] of oa.renderer.tracked) {
        if (t.last.o !== oa.slot || window.__BK.has(t.last.k)) continue;
        const p = oa.renderer.entScreenPos(id);
        out.push({ id, k: t.last.k, x: t.last.x, y: t.last.y, sx: p?.x ?? -1, sy: p?.y ?? -1 });
      }
      return out;
    });
  const ownBld = (kind) =>
    ev((kind) => {
      const oa = window.__oa;
      for (const [id, t] of oa.renderer.tracked)
        if (t.last.o === oa.slot && t.last.k === kind) {
          const p = oa.renderer.entScreenPos(id);
          return { id, x: t.last.x, y: t.last.y, sx: p?.x ?? -1, sy: p?.y ?? -1 };
        }
      return null;
    }, kind);
  const selPositions = () =>
    ev(() => {
      const oa = window.__oa;
      const m = {};
      for (const id of oa.input.selection) {
        const t = oa.renderer.tracked.get(id);
        if (t) m[id] = [t.last.x, t.last.y];
      }
      return m;
    });
  // legal placement footprints for a WxH building: inside map, free of ore/
  // buildings/units (mirrors server canPlace), adjacent to own base
  const findSpots = () =>
    ev(() => {
      const oa = window.__oa,
        B = window.__BK,
        D = window.__DIMS,
        W = 2,
        H = 2;
      const ore = new Set([...oa.gs["oreSlots"].keys()]);
      const unitTiles = new Set(),
        bldTiles = new Set(),
        ownB = [];
      for (const t of oa.renderer.tracked.values()) {
        if (B.has(t.last.k)) {
          const [w, h] = D[t.last.k];
          const bx = Math.round(t.last.x - w / 2),
            by = Math.round(t.last.y - h / 2);
          for (let y = by; y < by + h; y++) for (let x = bx; x < bx + w; x++) bldTiles.add(y * 64 + x);
          if (t.last.o === oa.slot) ownB.push({ bx, by, w, h });
        } else unitTiles.add(Math.floor(t.last.y) * 64 + Math.floor(t.last.x));
      }
      const out = [];
      for (const b of ownB)
        for (let ty = b.by - H - 2; ty <= b.by + b.h + 2; ty++)
          for (let tx = b.bx - W - 2; tx <= b.bx + b.w + 2; tx++) {
            let ok = true;
            for (let y = ty; y < ty + H && ok; y++)
              for (let x = tx; x < tx + W && ok; x++) {
                if (x < 0 || y < 0 || x >= 64 || y >= 64) {
                  ok = false;
                  break;
                }
                const i = y * 64 + x;
                if (ore.has(i) || unitTiles.has(i) || bldTiles.has(i)) ok = false;
              }
            if (!ok) continue;
            let adj = false;
            for (const o of ownB) {
              const gx = Math.max(o.bx - (tx + W), tx - (o.bx + o.w)),
                gy = Math.max(o.by - (ty + H), ty - (o.by + o.h));
              if (Math.max(gx, gy) <= 2) {
                adj = true;
                break;
              }
            }
            if (!adj) continue;
            const s = oa.projectTile(tx + W / 2 - 0.5, ty + H / 2 - 0.5); // hover point that yields footprint tx,ty
            out.push({ tx, ty, sx: s.x, sy: s.y });
          }
      return out;
    });
  // footprints passing every client placeOk check EXCEPT unit occupancy:
  // in-bounds, ore-free, building-free, gap<=2 adjacent to an own building.
  // needUnit=true keeps only footprints currently containing a unit tile —
  // those still show a GREEN ghost, but the server must deny "units in the way".
  const placeFps = (needUnit) =>
    ev((needUnit) => {
      const oa = window.__oa,
        B = window.__BK,
        D = window.__DIMS,
        W = 2,
        H = 2;
      const ore = new Set([...oa.gs["oreSlots"].keys()]);
      const bldTiles = new Set(),
        ownB = [],
        unitIdx = new Set();
      for (const t of oa.renderer.tracked.values()) {
        if (B.has(t.last.k)) {
          const [w, h] = D[t.last.k];
          const bx = Math.round(t.last.x - w / 2),
            by = Math.round(t.last.y - h / 2);
          for (let y = by; y < by + h; y++) for (let x = bx; x < bx + w; x++) bldTiles.add(y * 64 + x);
          if (t.last.o === oa.slot) ownB.push({ bx, by, w, h });
        } else unitIdx.add(Math.floor(t.last.y) * 64 + Math.floor(t.last.x));
      }
      const seen = new Set(),
        out = [];
      for (const b of ownB)
        for (let ty = b.by - H - 2; ty <= b.by + b.h + 2; ty++)
          for (let tx = b.bx - W - 2; tx <= b.bx + b.w + 2; tx++) {
            if (tx < 0 || ty < 0 || tx + W > 64 || ty + H > 64) continue;
            const key = ty * 64 + tx;
            if (seen.has(key)) continue;
            let ok = true,
              hasUnit = false;
            for (let y = ty; y < ty + H && ok; y++)
              for (let x = tx; x < tx + W; x++) {
                const i = y * 64 + x;
                if (ore.has(i) || bldTiles.has(i)) {
                  ok = false;
                  break;
                }
                if (unitIdx.has(i)) hasUnit = true;
              }
            if (!ok || (needUnit && !hasUnit)) continue;
            let adj = false;
            for (const o of ownB) {
              const gx = Math.max(o.bx - (tx + W), tx - (o.bx + o.w)),
                gy = Math.max(o.by - (ty + H), ty - (o.by + o.h));
              if (Math.max(gx, gy) <= 2) {
                adj = true;
                break;
              }
            }
            if (!adj) continue;
            seen.add(key);
            const s = oa.projectTile(tx + W / 2 - 0.5, ty + H / 2 - 0.5); // hover point that yields footprint tx,ty
            out.push({ tx, ty, sx: s.x, sy: s.y, hasUnit });
          }
      return out;
    }, needUnit);
  const ghost = () =>
    ev(() => {
      const i = window.__oa.input;
      return {
        ok: i["ghostOk"],
        tx: i["ghost"]?.userData?.tx,
        ty: i["ghost"]?.userData?.ty,
        hex: i["ghost"] ? i["ghost"].material.color.getHexString() : null,
      };
    });
  const buildBtn = () =>
    ev(() => {
      const b = document.querySelector('#build-list .icon[data-kind="power"]')?.closest("button");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled, ready: b.classList.contains("ready") };
    });
  // drag a selection box over all on-screen own units
  const dragSelectAll = async () => {
    const pts = (await ownUnits()).filter((u) => inSafe({ x: u.sx, y: u.sy }));
    if (pts.length < 2) return 0;
    const xs = pts.map((u) => u.sx),
      ys = pts.map((u) => u.sy);
    const x1 = Math.max(180, Math.min(...xs) - 45),
      y1 = Math.max(85, Math.min(...ys) - 45);
    const x2 = Math.min(VW - 200, Math.max(...xs) + 45),
      y2 = Math.min(VH - 130, Math.max(...ys) + 45);
    if (!(await onCanvas(x1, y1))) return -1;
    await page.mouse.move(x1, y1);
    await sleep(120);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 7 });
    await sleep(120);
    await page.mouse.up();
    await sleep(200);
    return ev(() => window.__oa.input.selection.size);
  };

  // ---------- lobby → game ----------
  await page.waitForFunction(
    () => {
      const b = document.getElementById("addbot-btn");
      return b && !b.classList.contains("hidden") && b.getBoundingClientRect().width > 0;
    },
    { timeout: 15000, polling: 200 },
  );
  await page.click("#addbot-btn");
  await sleep(900);
  await page.waitForFunction(
    () => {
      const b = document.getElementById("start-btn");
      return b && !b.classList.contains("hidden");
    },
    { timeout: 10000, polling: 200 },
  );
  await page.click("#start-btn");
  const inGame = await until(() => {
    const oa = window.__oa;
    if (oa?.phase !== "playing") return false;
    for (const t of oa.renderer.tracked.values()) if (t.last.o === oa.slot && t.last.k === "conyard") return true;
    return false;
  }, 20000);
  if (!inGame) throw new Error("game never entered playing phase with our conyard");
  await sleep(900); // camera + icons settle
  const boot = await gs();
  console.log(`game on: slot=${boot.slot} credits=${boot.credits} cam=(${boot.camX.toFixed(1)},${boot.camZ.toFixed(1)})`);

  // ================= CHECK 1: click-select a tank, right-click move =================
  {
    const name = "1 click-select + right-click move";
    try {
      const units = await ownUnits();
      const pickable = units.filter((u) => u.k === "tank" && inSafe({ x: u.sx, y: u.sy }));
      const tank = pickable[0] ?? units.find((u) => u.k === "tank") ?? units[0];
      if (!tank) {
        rec(name, false, "no own units in snapshots");
      } else {
        await click(tank.sx, tank.sy);
        await sleep(180);
        let s = await ev(() => ({
          sel: [...window.__oa.input.selection],
          info: document.getElementById("selinfo").textContent,
        }));
        if (!s.sel.includes(tank.id)) {
          // one retry at a refreshed interpolated position (unit may have drifted)
          const u2 = (await ownUnits()).find((u) => u.id === tank.id);
          if (u2) {
            await click(u2.sx, u2.sy);
            await sleep(180);
            s = await ev(() => ({ sel: [...window.__oa.input.selection], info: document.getElementById("selinfo").textContent }));
          }
        }
        const selOk = s.sel.includes(tank.id);
        const infoOk = /tank/i.test(s.info);
        // right-click the ground ~5 tiles away
        const destW = { x: Math.min(61, tank.x + 5), y: Math.min(61, tank.y + 4) };
        const ds = await project(destW.x, destW.y);
        const m0 = await mark();
        let orderSent = false,
          moved = false,
          dist = 0;
        if (await onCanvas(ds.x, ds.y)) {
          await rightClick(ds.x, ds.y);
          await sleep(300);
          orderSent = (await sentAfter(m0)).some((m) => m.t === "order" && m.kind === "move" && m.ids?.includes(tank.id));
          moved = await until((a) => {
            const t = window.__oa.renderer.tracked.get(a.id);
            return t && Math.hypot(t.last.x - a.x, t.last.y - a.y) > 1.0;
          }, 7000, { id: tank.id, x: tank.x, y: tank.y });
          const p2 = await ev((id) => {
            const t = window.__oa.renderer.tracked.get(id);
            return t ? { x: t.last.x, y: t.last.y } : null;
          }, tank.id);
          dist = p2 ? Math.hypot(p2.x - tank.x, p2.y - tank.y) : 0;
        }
        rec(
          name,
          selOk && infoOk && orderSent && moved,
          `sel.has(tank#${tank.id})=${selOk} selinfo="${s.info.slice(0, 60)}" orderMsg=${orderSent} moved ${dist.toFixed(2)} tiles (${tank.x},${tank.y})→target(${destW.x},${destW.y})`,
        );
      }
    } catch (e) {
      rec(name, false, "threw: " + e.message);
    }
  }

  // ================= CHECK 2: drag-select box =================
  {
    const name = "2 drag-select box";
    try {
      const n = await dragSelectAll();
      const rsel = await ev(() => window.__oa.renderer.selection.size);
      rec(name, n > 1 && rsel > 1, `input.selection=${n} renderer.selection=${rsel} (own units on-screen boxed)`);
      await shot("i-02-dragselect");
    } catch (e) {
      rec(name, false, "threw: " + e.message);
    }
  }

  // ================= CHECK 3: attack-move =================
  {
    const name = "3 attack-move (A + right-click)";
    try {
      const units = await ownUnits();
      const sel = units.filter((u) => u.k === "tank" || u.k === "infantry");
      if (!sel.length) {
        rec(name, false, "no combat units selected/alive");
      } else {
        const cx = sel.reduce((a, u) => a + u.x, 0) / sel.length,
          cy = sel.reduce((a, u) => a + u.y, 0) / sel.length;
        const foe = { x: 57, y: 57 }; // enemy spawn corner (slot 1)
        const l = Math.hypot(foe.x - cx, foe.y - cy) || 1;
        let d = null;
        for (const r of [11, 8, 6, 4]) {
          const w = { x: cx + ((foe.x - cx) / l) * r, y: cy + ((foe.y - cy) / l) * r };
          const s = await project(Math.max(1, Math.min(62, w.x)), Math.max(1, Math.min(62, w.y)));
          if (inSafe(s) && (await onCanvas(s.x, s.y))) {
            d = { w, s };
            break;
          }
        }
        if (!d) {
          rec(name, false, "could not find an on-screen ground point toward enemy");
        } else {
          const m0 = await mark();
          await page.keyboard.press("a");
          await sleep(140);
          const armed = await ev(() => window.__oa.input["amoveNext"]);
          await rightClick(d.s.x, d.s.y);
          await sleep(350);
          const sent = await sentAfter(m0);
          const om = sent.find((m) => m.t === "order");
          const consumed = (await ev(() => window.__oa.input["amoveNext"])) === false;
          // units should actually march toward the point
          const base = await ev((d) => {
            const oa = window.__oa;
            let sum = 0,
              n = 0;
            for (const id of oa.input.selection) {
              const t = oa.renderer.tracked.get(id);
              if (!t) continue;
              sum += Math.hypot(t.last.x - d.x, t.last.y - d.y);
              n++;
            }
            return n ? sum / n : -1;
          }, d.w);
          const progressed = await until((a) => {
            const oa = window.__oa;
            let sum = 0,
              n = 0;
            for (const id of oa.input.selection) {
              const t = oa.renderer.tracked.get(id);
              if (!t) continue;
              sum += Math.hypot(t.last.x - a.x, t.last.y - a.y);
              n++;
            }
            return n > 0 && sum / n < a.base - 1.2;
          }, 7000, { x: d.w.x, y: d.w.y, base });
          rec(
            name,
            armed === true && om?.kind === "amove" && consumed && progressed,
            `armedAfterA=${armed} orderMsg.kind=${om?.kind ?? "none"} amoveNextConsumed=${consumed} avgDistToDestFell=${progressed} (dest ${d.w.x.toFixed(1)},${d.w.y.toFixed(1)})`,
          );
        }
      }
    } catch (e) {
      rec(name, false, "threw: " + e.message);
    }
  }

  // ================= CHECK 4: 's' stop =================
  {
    const name = "4 stop (S key)";
    try {
      // units should be mid-march from the amove — press S and verify freeze
      const m0 = await mark();
      await page.keyboard.press("s");
      await sleep(500);
      const p1 = await selPositions();
      await sleep(900);
      const p2 = await selPositions();
      let maxD = 0;
      for (const id in p1) if (p2[id]) maxD = Math.max(maxD, Math.hypot(p2[id][0] - p1[id][0], p2[id][1] - p1[id][1]));
      const stopSent = (await sentAfter(m0)).some((m) => m.t === "stop");
      const n = Object.keys(p2).length;
      rec(name, stopSent && n > 0 && maxD < 0.12, `stopMsg=${stopSent} tracked=${n} units, max drift over 900ms = ${maxD.toFixed(3)} tiles`);
    } catch (e) {
      rec(name, false, "threw: " + e.message);
    }
  }

  // ---------- send the squad home so the base stays defended ----------
  // check 3 marched every selected unit toward the enemy corner and check 4
  // froze them there; left mid-map they can't stop the bot razing the conyard,
  // which would disable every build button (hud.updateSidebar) and make the
  // later placement checks untestable. A real right-click brings them back.
  try {
    const cyB = await ownBld("conyard");
    if (cyB && (await ev(() => window.__oa.input.selection.size)) > 0) {
      for (const [ox, oy] of [
        [4, 0],
        [0, 4],
        [-4, 0],
        [0, -4],
        [3, 3],
        [-3, -3],
      ]) {
        const s = await project(cyB.x + ox, cyB.y + oy);
        if (inSafe(s) && (await onCanvas(s.x, s.y))) {
          await rightClick(s.x, s.y);
          break;
        }
      }
    }
  } catch {}

  // ================= CHECK 5: sidebar build → ghost place → ESC cancel → right-click refund =================
  {
    const name = "5 sidebar build/place + ESC + refund";
    try {
      const m0 = await mark();
      const b0 = await buildBtn();
      if (!b0 || b0.disabled) {
        rec(name, false, `power button ${b0 ? "disabled" : "missing"}`);
      } else {
        await click(b0.x, b0.y);
        const sentBuild = (await sentAfter(m0)).some((m) => m.t === "build" && m.kind === "power");
        const bqOk = await until(() => window.__oa.state?.bq?.kind === "power", 4000);
        const awaitingOk = await until(() => window.__oa.state?.awaiting === "power", 18000);
        const placingOk = await until(() => window.__oa.input.placing === "power", 3000);
        // find a legal ghost spot and click it for real
        const cands = await findSpots();
        let spot = null,
          ghex = null;
        for (const c of cands) {
          if (!inSafe({ x: c.sx, y: c.sy }) || !(await onCanvas(c.sx, c.sy))) continue;
          await hover(c.sx, c.sy, 260);
          const g = await ghost();
          if (g.ok && g.tx === c.tx && g.ty === c.ty) {
            spot = c;
            ghex = g.hex;
            break;
          }
        }
        let placeSent = false,
          placed = false,
          cleared = false;
        if (spot) {
          const m1 = await mark();
          await page.mouse.down();
          await sleep(50);
          await page.mouse.up();
          placeSent = (await sentAfter(m1)).some((m) => m.t === "place" && m.tx === spot.tx && m.ty === spot.ty);
          placed = await until(() => {
            const oa = window.__oa;
            for (const t of oa.renderer.tracked.values()) if (t.last.o === oa.slot && t.last.k === "power") return true;
            return false;
          }, 5000);
          cleared = await until(() => window.__oa.state?.awaiting == null, 3000);
        }
        rec(
          name,
          sentBuild && bqOk && awaitingOk && placingOk && placeSent && placed && cleared,
          `buildMsg=${sentBuild} bq=${bqOk} awaiting=${awaitingOk} autoPlacing=${placingOk} ghostGreen@${spot ? spot.tx + "," + spot.ty : "NONE"}(#${ghex}) placeMsg=${placeSent} entInSnaps=${placed} awaitingCleared=${cleared}`,
        );
        await shot("i-05-placed");

        // --- second plant: ESC during placement = real cancel (refund + unblock queue)
        const b1 = await buildBtn();
        await click(b1.x, b1.y);
        const awaiting2 = await until(() => window.__oa.state?.awaiting === "power", 18000);
        const placing2 = await until(() => window.__oa.input.placing === "power", 3000);
        const cr0 = (await gs()).credits;
        const m2 = await mark();
        await page.keyboard.press("Escape");
        await sleep(400);
        const esc = await gs();
        const bcSent = (await sentAfter(m2)).some((m) => m.t === "buildCancel");
        const awGone = await until(() => window.__oa.state?.awaiting == null, 4000);
        await sleep(350);
        const cr1 = (await gs()).credits;
        const refundOk = bcSent && awGone && cr1 - cr0 === 300;
        // the queue must accept a fresh build afterwards (the old stuck-forever bug)
        const b4 = await buildBtn();
        await click(b4.x, b4.y);
        const rebuild = await until(
          () => window.__oa.state?.bq?.kind === "power" || window.__oa.state?.awaiting === "power",
          8000,
        );
        // clean up the fresh build so later checks start from a clear queue
        const b5 = await buildBtn();
        if (b5) {
          await rightClick(b5.x, b5.y); // contextmenu → buildCancel
          await until(() => window.__oa.state?.awaiting == null && window.__oa.state?.bq == null, 5000);
        }
        rec(
          "5b ESC cancel = real buildCancel (refund + queue unblocked)",
          awaiting2 && placing2 && esc.placing === null && refundOk && rebuild,
          `awaiting2=${awaiting2} placing2=${placing2} esc(placing=${esc.placing},cancelled=${esc.cancelled}) refund +${cr1 - cr0}cr (want +300, cancelMsg=${bcSent}, awGone=${awGone}) rebuild=${rebuild}`,
        );
      }
    } catch (e) {
      rec(name, false, "threw: " + e.message);
      rec("5b ESC cancel + right-click refund", false, "skipped — earlier step threw: " + e.message);
    }
  }

  // ================= CHECK 6: chat regression =================
  {
    const name = "6 chat regression: typing 'asr4' triggers nothing";
    try {
      // keep a live selection so a leaked 's' would send {t:"stop"}
      let selN = await ev(() => window.__oa.input.selection.size);
      if (selN === 0) {
        await dragSelectAll();
        selN = await ev(() => window.__oa.input.selection.size);
      }
      const m0 = await mark(),
        d0 = await denyCount();
      await page.click("#chat-input");
      await sleep(150);
      const focused = await ev(() => document.activeElement?.id === "chat-input");
      await page.keyboard.type("asr4", { delay: 25 });
      await sleep(250);
      const flags = await ev(() => ({
        amove: window.__oa.input["amoveNext"],
        verb: window.__oa.input.verb,
        placing: window.__oa.input.placing,
        val: document.getElementById("chat-input").value,
        label: document.getElementById("order-label").classList.contains("hidden") ? null : document.getElementById("order-label").textContent,
      }));
      const sent6 = await sentAfter(m0); // must be EMPTY — nothing may be sent while typing
      const denies6 = await deniesAfter(d0);
      await page.keyboard.press("Enter");
      await sleep(250);
      const chatSent = (await ev(() => window.__ilog.sent)).some((m) => m.t === "chat" && m.text === "asr4");
      const echoed = await until(() => document.getElementById("chat-lines").textContent.includes("asr4"), 4000);
      const ok =
        focused &&
        flags.val === "asr4" &&
        flags.amove !== true &&
        flags.verb === null &&
        sent6.length === 0 &&
        denies6.length === 0 &&
        chatSent &&
        echoed;
      rec(
        name,
        ok,
        `focus=${focused} typed="${flags.val}" amoveNext=${flags.amove} verb=${flags.verb} orderLabel=${flags.label} msgsSentWhileTyping=${JSON.stringify(sent6.map((m) => m.t))} denies=${JSON.stringify(denies6)} chatSent=${chatSent} echoed=${echoed} selBefore=${selN}`,
      );
    } catch (e) {
      rec(name, false, "threw: " + e.message);
    }
  }

  // ================= CHECK 7: sell verb =================
  {
    const name = "7 sell verb → click own building → +50% credits";
    try {
      const pw = await ownBld("power");
      if (!pw) {
        rec(name, false, "no owned power plant to sell");
      } else {
        const cr0 = (await gs()).credits;
        await page.click("#verb-sell");
        await sleep(180);
        const armed = await ev(() => window.__oa.input.verb);
        const m0 = await mark();
        await click(pw.sx, pw.sy);
        const sellSent = (await sentAfter(m0)).some((m) => m.t === "sell" && m.id === pw.id);
        const gone = await until((id) => !window.__oa.renderer.tracked.has(id), 4000, pw.id);
        await sleep(350);
        const cr1 = (await gs()).credits;
        const verbAfter = await ev(() => window.__oa.input.verb);
        rec(
          name,
          armed === "sell" && sellSent && gone && cr1 - cr0 === 150 && verbAfter === null,
          `armed=${armed} sellMsg=${sellSent} ent#${pw.id}Gone=${gone} credits ${cr0}→${cr1} (+${cr1 - cr0}, want +150) verbAfter=${verbAfter}`,
        );
      }
    } catch (e) {
      rec(name, false, "threw: " + e.message);
    }
  }

  // ================= CHECK 8: placement edge cases =================
  {
    const name = "8 placement edges (ore/units/too far → deny-safe)";
    try {
      // a) a unit must stand inside a client-legal 2x2 footprint for the
      //    "units in the way" deny. If none does already, walk one in via a
      //    real right-click and halt it with a real `s` press — all before
      //    placement mode begins (right-click during placing cancels instead
      //    of ordering).
      let gid = null,
        parkEv = "unit already inside a legal footprint";
      if (!(await placeFps(true)).length) {
        const guard =
          (await ownUnits()).find((u) => u.k === "tank" && inSafe({ x: u.sx, y: u.sy })) ??
          (await ownUnits()).find((u) => inSafe({ x: u.sx, y: u.sy }));
        const cands = await placeFps(false);
        if (!guard) parkEv = "no on-screen own unit to walk in";
        else if (!cands.length) parkEv = "no legal 2x2 footprint exists";
        else {
          // prefer empty footprints: nearestPassable retargets the order when
          // the goal tile is occupied, which can strand the guard off-band
          cands.sort(
            (a, b) =>
              (a.hasUnit ? 1 : 0) - (b.hasUnit ? 1 : 0) ||
              Math.abs(a.tx + 1 - guard.x) + Math.abs(a.ty + 1 - guard.y) - (Math.abs(b.tx + 1 - guard.x) + Math.abs(b.ty + 1 - guard.y)),
          );
          await click(guard.sx, guard.sy); // select just this unit
          await sleep(150);
          // track whatever actually got picked — units cluster, the raycast may
          // hit a neighbor instead of `guard`; the selected id is ground truth
          gid = (await ev(() => [...window.__oa.input.selection]))[0] ?? null;
          if (gid == null) parkEv = "guard click selected nothing";
          else {
            let ordTxt = "no on-canvas target";
            for (const f of cands) {
              if (!(await onCanvas(f.sx, f.sy))) continue;
              const mP = await mark();
              await rightClick(f.sx, f.sy); // real move order to the footprint center
              await sleep(250);
              const ord = (await sentAfter(mP)).find((m) => m.t === "order");
              ordTxt = ord ? `${ord.kind}→(${ord.x.toFixed(1)},${ord.y.toFixed(1)})` : "no order sent";
              break;
            }
            // wait until some unit tile lands inside a legal fp (or the guard
            // settles), then halt it with `s` so it stays put for the click
            const t0 = Date.now();
            let lastP = null,
              still = 0;
            while (Date.now() - t0 < 15000 && !(await placeFps(true)).length) {
              const p = await ev((id) => {
                const t = window.__oa.renderer.tracked.get(id);
                return t ? [t.last.x, t.last.y] : null;
              }, gid);
              if (p && lastP && Math.hypot(p[0] - lastP[0], p[1] - lastP[1]) < 0.02) {
                if ((still += 300) >= 900) break;
              } else still = 0;
              lastP = p;
              await sleep(300);
            }
            const inFp = (await placeFps(true)).length;
            if (inFp) {
              await page.keyboard.press("s"); // halt inside the footprint
              await sleep(350);
            }
            const gp = await ev((id) => {
              const t = window.__oa.renderer.tracked.get(id);
              return t ? `${t.last.x.toFixed(1)},${t.last.y.toFixed(1)}` : "gone";
            }, gid);
            parkEv = `order=${ordTxt} #${gid}@${gp} legalUnitFps=${inFp}`;
          }
        }
      }
      // b) build a third plant — capture why it might never reach placement:
      //    a razed conyard disables every build button (hud.updateSidebar)
      const hasCy = await ev(() => {
        const oa = window.__oa;
        for (const t of oa.renderer.tracked.values()) if (t.last.o === oa.slot && t.last.k === "conyard") return true;
        return false;
      });
      const pre8 = await gs();
      const b = await buildBtn();
      const mB = await mark();
      if (b && !b.disabled) await click(b.x, b.y);
      const buildMsg8 = (await sentAfter(mB)).some((m) => m.t === "build");
      const awaiting = await until(() => window.__oa.state?.awaiting === "power", 18000);
      const placing = await until(() => window.__oa.input.placing === "power", 3000);
      const buildEv = `hasConyard=${hasCy} credits=${pre8.credits} bq=${pre8.bq} awaitingPre=${pre8.awaiting} btn=${b ? (b.disabled ? "disabled" : "enabled") : "missing"} buildMsgSent=${buildMsg8}`;
      if (awaiting && placing) {
      // c) too far: on-screen-safe tile not adjacent to own base → red ghost, click does nothing
      const farSpots = await ev(() => {
        const oa = window.__oa,
          B = window.__BK,
          D = window.__DIMS;
        const ownB = [];
        for (const t of oa.renderer.tracked.values())
          if (t.last.o === oa.slot && B.has(t.last.k)) {
            const [w, h] = D[t.last.k];
            ownB.push({ bx: Math.round(t.last.x - w / 2), by: Math.round(t.last.y - h / 2), w, h });
          }
        const out = [];
        for (let ty = 0; ty < 62; ty++)
          for (let tx = 0; tx < 62; tx++) {
            let adj = false;
            for (const o of ownB) {
              const gx = Math.max(o.bx - (tx + 2), tx - (o.bx + o.w)),
                gy = Math.max(o.by - (ty + 2), ty - (o.by + o.h));
              if (Math.max(gx, gy) <= 2) {
                adj = true;
                break;
              }
            }
            if (adj) continue;
            const s = oa.projectTile(tx + 0.5, ty + 0.5);
            out.push({ tx, ty, sx: s.x, sy: s.y });
          }
        return out;
      });
      let farRed = null;
      for (const f of farSpots) {
        if (!inSafe({ x: f.sx, y: f.sy }) || !(await onCanvas(f.sx, f.sy))) continue;
        await hover(f.sx, f.sy, 240);
        const g = await ghost();
        if (g.ok === false) {
          farRed = { ...f, hex: g.hex };
          const mF = await mark();
          await click(f.sx, f.sy);
          const leakF = (await sentAfter(mF)).filter((m) => m.t === "place");
          farRed.noPlaceSent = leakF.length === 0;
          break;
        }
      }
      // d) ore: hover a known ore tile → red ghost, click does nothing
      const orePts = await ev(() => {
        const oa = window.__oa;
        return [...oa.gs["oreSlots"].keys()]
          .map((k) => {
            const x = k % 64,
              y = (k / 64) | 0;
            const s = oa.projectTile(x + 0.5, y + 0.5);
            return { x, y, sx: s.x, sy: s.y };
          })
          .filter((p) => p.sx > 200 && p.sx < 1290 && p.sy > 95 && p.sy < 820)
          .sort((a, b) => Math.abs(a.sx - 750) + Math.abs(a.sy - 450) - (Math.abs(b.sx - 750) + Math.abs(b.sy - 450)));
      });
      let oreRed = null;
      for (const o of orePts) {
        if (!(await onCanvas(o.sx, o.sy))) continue;
        await hover(o.sx, o.sy, 240);
        const g = await ghost();
        if (g.ok === false) {
          oreRed = { ...o, hex: g.hex };
          const mO = await mark();
          await click(o.sx, o.sy);
          oreRed.noPlaceSent = (await sentAfter(mO)).filter((m) => m.t === "place").length === 0;
          break;
        }
      }
      // e) units-in-the-way: a footprint containing a unit tile must show a
      //    RED ghost client-side (occCheck parity with the server) and send no
      //    place cmd on click. Footprints covering the halted guard are tried
      //    first (it is stopped; a wandering unit could drift out).
      const gpos2 = await ev((id) => {
        const t = id == null ? null : window.__oa.renderer.tracked.get(id);
        return t ? { x: Math.floor(t.last.x), y: Math.floor(t.last.y) } : null;
      }, gid);
      const dcands = (await placeFps(true)).sort((a, b) => {
        const ca = gpos2 && a.tx <= gpos2.x && gpos2.x < a.tx + 2 && a.ty <= gpos2.y && gpos2.y < a.ty + 2 ? 0 : 1;
        const cb = gpos2 && b.tx <= gpos2.x && gpos2.x < b.tx + 2 && b.ty <= gpos2.y && gpos2.y < b.ty + 2 ? 0 : 1;
        return ca - cb;
      });
      const attempts = [];
      for (const f of dcands) {
        if (attempts.length >= 1) break;
        if (!inSafe({ x: f.sx, y: f.sy }) || !(await onCanvas(f.sx, f.sy))) continue;
        await hover(f.sx, f.sy, 260);
        const g = await ghost();
        if (g.ok !== false || g.tx !== f.tx || g.ty !== f.ty) continue; // want exactly RED here
        const mE = await mark();
        await page.mouse.down();
        await sleep(50);
        await page.mouse.up();
        const sentE = await sentAfter(mE);
        const st = await gs();
        const inside = await ev((f) => {
          let n = 0;
          for (const t of window.__oa.renderer.tracked.values())
            if (!window.__BK.has(t.last.k) && Math.floor(t.last.x) >= f.tx && Math.floor(t.last.x) < f.tx + 2 && Math.floor(t.last.y) >= f.ty && Math.floor(t.last.y) < f.ty + 2) n++;
          return n;
        }, f);
        attempts.push({
          fp: `${f.tx},${f.ty}`,
          g,
          placeSent: sentE.some((m) => m.t === "place"),
          sentE: sentE.map((m) => m.t).join("+") || "none",
          awaitingKept: st.awaiting === "power",
          stillPlacing: st.placing === "power",
          inside,
        });
      }
      const redE = attempts.length ? attempts[0] : { noCand: true, dcands: dcands.length };
      // f) re-place a legal spot works
      const cands2 = await findSpots();
      let spot2 = null;
      for (const c of cands2) {
        if (!inSafe({ x: c.sx, y: c.sy }) || !(await onCanvas(c.sx, c.sy))) continue;
        await hover(c.sx, c.sy, 260);
        const g = await ghost();
        if (g.ok && g.tx === c.tx && g.ty === c.ty) {
          spot2 = c;
          break;
        }
      }
      let placed2 = false;
      if (spot2) {
        await page.mouse.down();
        await sleep(50);
        await page.mouse.up();
        placed2 = await until(() => {
          const oa = window.__oa;
          let n = 0;
          for (const t of oa.renderer.tracked.values()) if (t.last.o === oa.slot && t.last.k === "power") n++;
          return n >= 1 && oa.state?.awaiting == null;
        }, 5000);
      }
      const redOk = attempts.some((a) => a.g.ok === false && a.inside >= 1 && !a.placeSent && a.awaitingKept);
      const sub = {
        parked: parkEv,
        farRed: farRed ? `tile(${farRed.tx},${farRed.ty}) red#${farRed.hex} noPlaceSent=${farRed.noPlaceSent}` : "no far-red spot tested",
        oreRed: oreRed ? `ore(${oreRed.x},${oreRed.y}) red#${oreRed.hex} noPlaceSent=${oreRed.noPlaceSent}` : "no ore tile on screen",
        unitRed: redE?.noCand
          ? `no legal footprint contains a unit (dcands=${redE.dcands}; ${parkEv})`
          : attempts
              .map(
                (a, i) =>
                  `#${i + 1}@(${a.fp}) ghost{ok=${a.g.ok},#${a.g.hex}} inside=${a.inside} placeSent=${a.placeSent} sent=${a.sentE} awaitingKept=${a.awaitingKept} placing=${a.stillPlacing}`,
              )
              .join(" ") || "skipped",
        replace: `legal re-place → inSnaps=${placed2}`,
      };
      const ok =
        farRed?.noPlaceSent === true &&
        (oreRed ? oreRed.noPlaceSent : true) &&
        redOk &&
        redE.awaitingKept &&
        redE.stillPlacing &&
        placed2;
      rec(name, !!ok, `${buildEv} | ${sub.parked} | far: ${sub.farRed} | ore: ${sub.oreRed} | unitRed: ${sub.unitRed} | ${sub.replace}`);
      } else {
        rec(name, false, `build never reached placement — ${buildEv} awaiting=${awaiting} placing=${placing}`);
      }
      await shot("i-08-edges");
    } catch (e) {
      rec(name, false, "threw: " + e.message);
    }
  }

  // ================= CHECK 9: camera =================
  {
    try {
      // wheel zoom
      await hover(750, 475, 200);
      const h0 = (await gs()).camH;
      await page.mouse.wheel({ deltaY: -300 });
      const zoomIn = await until((h) => window.__oa.gs.camHeight < h - 1, 3000, h0);
      const h1 = (await gs()).camH;
      await page.mouse.wheel({ deltaY: 700 });
      const zoomOut = await until((h) => window.__oa.gs.camHeight > h + 1, 3000, h1);
      const h2 = (await gs()).camH;
      rec("9a wheel zoom", zoomIn && zoomOut, `camHeight ${h0.toFixed(1)} → ${h1.toFixed(1)} (in=${zoomIn}) → ${h2.toFixed(1)} (out=${zoomOut})`);
    } catch (e) {
      rec("9a wheel zoom", false, "threw: " + e.message);
    }
    try {
      // arrow keys pan
      await ev(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : 0));
      const t0 = await gs();
      await page.keyboard.down("ArrowLeft");
      await sleep(450);
      await page.keyboard.up("ArrowLeft");
      await sleep(120);
      const t1 = await gs();
      await page.keyboard.down("ArrowUp");
      await sleep(450);
      await page.keyboard.up("ArrowUp");
      await sleep(120);
      const t2 = await gs();
      const xOk = t1.camX < t0.camX - 0.4,
        zOk = t2.camZ > t1.camZ + 0.4;
      rec("9b arrow-key pan", xOk && zOk, `camTarget.x ${t0.camX.toFixed(1)}→${t1.camX.toFixed(1)} (ArrowLeft, ${xOk}) · camTarget.z ${t1.camZ.toFixed(1)}→${t2.camZ.toFixed(1)} (ArrowUp, ${zOk})`);
    } catch (e) {
      rec("9b arrow-key pan", false, "threw: " + e.message);
    }
    try {
      // edge pan: left border then bottom border (both hover over live canvas).
      // re-center the camera first (fixture setup) so each pan has travel room —
      // otherwise the ±clamp swallows the delta and the check can't see motion.
      const recenter = () => ev(() => { const g = window.__oa.gs; g.camTarget.set(32, 0, 32); g.updateCamera(); });
      await recenter();
      const e0 = await gs();
      const leftOk = await onCanvas(6, 470);
      await page.mouse.move(6, 470);
      await sleep(650);
      const e1 = await gs();
      const dxe = e1.camX - e0.camX;
      const botOk = await onCanvas(1100, 944);
      await page.mouse.move(700, 400);
      await sleep(250); // pull pointer back inside so the border approach is fresh
      await recenter();
      const e2 = await gs();
      await page.mouse.move(1100, 944);
      await sleep(650);
      const e3 = await gs();
      const dze = e3.camZ - e2.camZ;
      rec("9c edge-pan", leftOk && botOk && dxe < -0.5 && dze < -0.5, `left-edge Δx=${dxe.toFixed(2)} (want <−0.5, canvas=${leftOk}) · bottom-edge Δz=${dze.toFixed(2)} (want <−0.5, canvas=${botOk})`);
    } catch (e) {
      rec("9c edge-pan", false, "threw: " + e.message);
    }
    try {
      // middle-drag pan
      await page.mouse.move(700, 400);
      await sleep(160);
      const m0 = await gs();
      await page.mouse.down({ button: "middle" });
      await sleep(80);
      await page.mouse.move(780, 460, { steps: 5 });
      await sleep(200);
      await page.mouse.up({ button: "middle" });
      const m1 = await gs();
      const dx = m1.camX - m0.camX,
        dz = m1.camZ - m0.camZ;
      rec("9d middle-drag pan", Math.hypot(dx, dz) > 1.0, `camTarget Δ=(${dx.toFixed(2)},${dz.toFixed(2)}) after +80/+60px middle-drag (want |Δ|>1)`);
    } catch (e) {
      rec("9d middle-drag pan", false, "threw: " + e.message);
    }
  }

  // ================= CHECK 10: minimap click =================
  {
    const name = "10 minimap click → camera jumps";
    try {
      const mm = await ev(() => {
        const r = document.getElementById("minimap").getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, hidden: document.getElementById("minimap").classList.contains("hidden") };
      });
      if (mm.hidden) {
        rec(name, false, "minimap hidden");
      } else {
        const fx = 0.55,
          fy = 0.62;
        const t0 = await gs();
        await click(mm.x + mm.w * fx, mm.y + mm.h * fy);
        await sleep(300);
        const t1 = await gs();
        const exX = fx * 64,
          exZ = fy * 64;
        const ok = Math.abs(t1.camX - exX) < 3 && Math.abs(t1.camZ - exZ) < 3 && Math.hypot(t1.camX - t0.camX, t1.camZ - t0.camZ) > 3;
        rec(name, ok, `click @(${exX.toFixed(1)},${exZ.toFixed(1)}) map → camTarget (${t0.camX.toFixed(1)},${t0.camZ.toFixed(1)})→(${t1.camX.toFixed(1)},${t1.camZ.toFixed(1)})`);
      }
    } catch (e) {
      rec(name, false, "threw: " + e.message);
    }
  }

  // ================= CHECK 11: upgrade =================
  rec(
    "11 factory upgrade button",
    null,
    "needs barracks→radar→factory→techlab chain ($4000) + $1500 upgrade = $5500 on a $5000 start (post-check credits ~" +
      ((await gs()).credits ?? "?") +
      ") plus ~40s of queued builds + 4 placements; exceeds the 5min guidance — reported skipped per instructions",
  );

  // ---------- summary ----------
  const allDenies = await ev(() => window.__ilog.deny);
  console.log("\n================ RESULTS ================");
  for (const r of results) console.log(`${r.st}  ${r.name}\n      ${r.ev}`);
  const fails = results.filter((r) => r.st === "FAIL").length;
  const skips = results.filter((r) => r.st === "SKIP").length;
  console.log(`\n${results.length - fails - skips} passed · ${fails} failed · ${skips} skipped`);
  console.log(`deny msgs seen: ${JSON.stringify(allDenies)}`);
  console.log(`page errors: ${pageErrs.length ? JSON.stringify(pageErrs) : "none"}`);
  await browser.close();
  process.exit(fails ? 1 : 0);
} catch (e) {
  console.log("FATAL:", e);
  for (const r of results) console.log(`${r.st}  ${r.name}`);
  await browser.close().catch(() => {});
  process.exit(1);
}
