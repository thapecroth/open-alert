#!/usr/bin/env node
// GymEnv regression suite — structured obs, action schema, feature planes,
// RGB frames, validation/invalid handling, upgrade path, full episode.
//   node test/gym.mjs
// No sockets, no worker — the TS module hooks below let Node load src/*.ts.

import { registerHooks, createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z0-9]+$/i.test(specifier)) {
        return next(specifier + ".ts", context);
      }
      throw err;
    }
  },
  load(url, context, next) {
    const res = next(url, context);
    if (url.endsWith(".ts")) {
      const out = ts.transpileModule(String(res.source), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: url,
      });
      return { format: "module", source: out.outputText, shortCircuit: true };
    }
    return res;
  },
});

const { GymEnv } = await import("../src/server/gym.ts");
const { BUILDINGS, UNITS, MAP_W, MAP_H, UPGRADE_COST } = await import("../src/shared/gamedefs.ts");

// ---------- assert plumbing ----------
let passN = 0, failN = 0, skipN = 0;
const fails = [];
const ok = (cond, name, ev = "") => {
  if (cond) { passN++; console.log(`ok: ${name}`); }
  else { failN++; fails.push(name); console.log(`FAIL: ${name} ${ev}`); }
};
const skip = (name, why) => { skipN++; console.log(`skip: ${name} (${why})`); };

const isB = (k) => k in BUILDINGS;
const idx = (x, y) => y * MAP_W + x;

// ---------- placement helpers (client-side replica of world.canPlace) ----------
function occupiedAndOre(obs, slot) {
  const occ = new Set(), ore = new Set();
  for (const e of obs.ents) {
    if (isB(e.k)) {
      const d = BUILDINGS[e.k];
      const bx = Math.round(e.x - d.w / 2), by = Math.round(e.y - d.h / 2);
      for (let y = by; y < by + d.h; y++) for (let x = bx; x < bx + d.w; x++) occ.add(idx(x, y));
    } else {
      occ.add(idx(Math.floor(e.x), Math.floor(e.y)));
    }
  }
  for (const [x, y, a] of obs.ore) if (a > 0) ore.add(idx(x, y));
  return { occ, ore };
}
function canPlaceObs(obs, slot, kind, tx, ty, sets) {
  const d = BUILDINGS[kind];
  if (tx < 0 || ty < 0 || tx + d.w > MAP_W || ty + d.h > MAP_H) return false;
  for (let y = ty; y < ty + d.h; y++)
    for (let x = tx; x < tx + d.w; x++) if (sets.occ.has(idx(x, y)) || sets.ore.has(idx(x, y))) return false;
  for (const e of obs.ents) {
    if (e.o !== slot || !isB(e.k)) continue;
    const bd = BUILDINGS[e.k];
    const bx = Math.round(e.x - bd.w / 2), by = Math.round(e.y - bd.h / 2);
    const gapX = Math.max(bx - (tx + d.w), tx - (bx + bd.w));
    const gapY = Math.max(by - (ty + d.h), ty - (by + bd.h));
    if (Math.max(gapX, gapY) <= 2) return true;
  }
  return false;
}
function findSpot(obs, slot, kind) {
  const sets = occupiedAndOre(obs, slot);
  const d = BUILDINGS[kind];
  for (const b of obs.ents) {
    if (b.o !== slot || !isB(b.k)) continue;
    const bd = BUILDINGS[b.k];
    const bx = Math.round(b.x - bd.w / 2), by = Math.round(b.y - bd.h / 2);
    for (let r = 1; r <= 4; r++)
      for (let y = by - r - d.h + 1; y < by + bd.h + r; y++)
        for (let x = bx - r - d.w + 1; x < bx + bd.w + r; x++)
          if (canPlaceObs(obs, slot, kind, x, y, sets)) return { tx: x, ty: y };
  }
  return null;
}

// Drive a building chain via real actions; returns the obs after each step.
function tryBuild(env, obs, kind) {
  if (obs.you.bq || obs.you.awaiting) return obs; // busy
  if (obs.you.credits < BUILDINGS[kind].cost) return obs;
  let r = env.step({ build: kind }, 10);
  obs = r.obs;
  if (obs.you.awaiting === kind) {
    const spot = findSpot(obs, obs.you.slot, kind);
    if (spot) r = env.step({ place: spot }, 10);
    else r = env.step({ place: { tx: 6, ty: 6 } }, 10);
    obs = r.obs;
  }
  return obs;
}

// ---------- 1. reset + structured observation ----------
console.log("--- reset / obs ---");
const env = new GymEnv({ opponent: "idle" });
let obs = env.reset();
ok(obs && typeof obs === "object", "reset returns obs");
ok(Number.isInteger(obs.tick), "obs.tick integer");
ok(obs.you && obs.you.slot === 0, "obs.you.slot = 0");
ok(obs.you.credits > 0, "obs.you.credits positive", `credits=${obs.you.credits}`);
ok("pwrHave" in obs.you && "pwrUse" in obs.you && "lowPower" in obs.you, "power fields present");
ok("bq" in obs.you && "awaiting" in obs.you && "queues" in obs.you, "build-queue fields present");
ok(Array.isArray(obs.ents) && obs.ents.length > 0, "obs.ents populated", `n=${obs.ents.length}`);
const e0 = obs.ents[0];
ok("id" in e0 && "o" in e0 && "k" in e0 && "x" in e0 && "y" in e0 && "hp" in e0 && "mhp" in e0, "ent fields present");
ok(Array.isArray(obs.ore) && obs.ore.length > 0, "obs.ore populated", `cells=${obs.ore.length}`);

// ---------- 2. action schema ----------
console.log("--- action schema ---");
const schema = env.actionSchema();
ok(schema && typeof schema === "object", "actionSchema returns object");
const sstr = JSON.stringify(schema);
for (const prop of ["build", "place", "train", "cancelTrain", "order", "stop", "upgrade"])
  ok(sstr.includes(`"${prop}"`), `schema exposes "${prop}"`);
for (const k of Object.keys(BUILDINGS)) ok(sstr.includes(`"${k}"`), `schema lists building "${k}"`);
for (const k of Object.keys(UNITS)) ok(sstr.includes(`"${k}"`), `schema lists unit "${k}"`);

// ---------- 3. step + validation ----------
console.log("--- step / validation ---");
const tick0 = obs.tick;
let r = env.step({}, 10);
ok(r.obs.tick === tick0 + 10, "step advances sim ticks", `t=${r.obs.tick}`);
ok(typeof r.reward === "number" && Number.isFinite(r.reward), "reward finite", `r=${r.reward}`);
ok(r.done === false, "episode alive after empty step");
for (const [bad, why] of [
  [{ build: "nope" }, "bad build kind"],
  [{ train: 123 }, "non-string train"],
  [{ order: { kind: "bogus", x: 1, y: 1 } }, "bad order kind"],
  [{ upgrade: "x" }, "non-numeric upgrade"],
  ["not-an-object", "non-object action"],
]) {
  r = env.step(bad, 1);
  ok(r.info && r.info.invalid === true, `invalid flagged: ${why}`, JSON.stringify(r.info?.invalidReason));
}
r = env.step({ upgrade: 99999 }, 1);
ok(r.info.invalid !== true, "schema-valid upgrade id is not 'invalid'");
ok(Array.isArray(r.info.denied) && r.info.denied.some((d) => d.startsWith("upgrade")), "bogus upgrade id denied in-sim", JSON.stringify(r.info.denied));
r = env.step({ build: "power" }, 1);
ok(r.info.invalid !== true && r.obs.you.bq?.kind === "power", "build action accepted → queue started", JSON.stringify(r.info.denied ?? []));

// ---------- 4. feature maps ----------
console.log("--- featureMaps ---");
const fm = env.featureMaps();
ok(fm.w === MAP_W && fm.h === MAP_H && fm.c === 6, `featureMaps shape ${fm.w}x${fm.h}x${fm.c}`);
ok(fm.data instanceof Float32Array && fm.data.length === MAP_W * MAP_H * 6, "featureMaps data is Float32Array plane set");
const chanNZ = (c) => {
  let n = 0;
  const off = c * MAP_W * MAP_H;
  for (let i = 0; i < MAP_W * MAP_H; i++) if (fm.data[off + i] !== 0) n++;
  return n;
};
ok(chanNZ(0) > 30, "ch0 ore density populated", `nz=${chanNZ(0)}`);
ok(chanNZ(1) > 0, "ch1 own units populated", `nz=${chanNZ(1)}`);
ok(chanNZ(2) > 0, "ch2 own buildings populated", `nz=${chanNZ(2)}`);
ok(chanNZ(5) > 0, "ch5 all-ent hp populated", `nz=${chanNZ(5)}`);
ok(chanNZ(3) + chanNZ(4) > 0, "ch3+ch4 foe populated (idle opp has base)", `nz=${chanNZ(3) + chanNZ(4)}`);
let inRange = true;
for (let i = 0; i < fm.data.length; i++) if (fm.data[i] < 0 || fm.data[i] > 1) { inRange = false; break; }
ok(inRange, "all feature values within [0,1]");

// ---------- 5. RGB frame ----------
console.log("--- rgbFrame ---");
for (const [scale, exp] of [[1, MAP_W], [2, MAP_W * 2], [3, MAP_W * 3]]) {
  const fr = env.rgbFrame(scale);
  ok(fr.w === exp && fr.h === exp && fr.data.length === exp * exp * 3, `rgbFrame(${scale}) = ${exp}x${exp}x3`);
}
const fr3 = env.rgbFrame(3);
let lit = 0;
for (let i = 0; i < fr3.data.length; i++) if (fr3.data[i] > 30) lit++;
ok(lit > 500, "rgbFrame has rendered content", `lit=${lit}`);
const fr3b = env.rgbFrame(3);
ok(Buffer.compare(Buffer.from(fr3.data), Buffer.from(fr3b.data)) === 0, "rgbFrame deterministic for same state");

// ---------- 6. upgrade path end-to-end (idle opp keeps episode alive) ----------
console.log("--- upgrade path ---");
const env2 = new GymEnv({ opponent: "idle", maxTicks: 20000 });
let o2 = env2.reset();
const CHAIN = ["power", "refinery", "barracks", "radar", "factory", "techlab"];
let guard = 0;
const mine = (k) => o2.ents.some((e) => e.o === 0 && e.k === k);
while (guard++ < 1200) {
  if (o2.you.awaiting) {
    const spot = findSpot(o2, 0, o2.you.awaiting);
    const s = env2.step({ place: spot ?? { tx: 6, ty: 6 } }, 25);
    o2 = s.obs;
    if (s.done) break;
    continue;
  }
  const next = CHAIN.find((k) => !mine(k));
  if (!next) break;
  o2 = tryBuild(env2, o2, next);
  const s = env2.step({}, 25);
  o2 = s.obs;
  if (s.done) break;
}
// drain: make sure nothing is still building/awaiting before asserting
for (let i = 0; i < 200 && (o2.you.bq || o2.you.awaiting); i++) o2 = env2.step({}, 25).obs;
const builtAll = CHAIN.every(mine);
ok(builtAll, "full tech chain built via actions", `missing=${CHAIN.filter((k) => !mine(k))} credits=${o2.you.credits} t=${o2.tick}`);
const fac = o2.ents.find((e) => e.o === 0 && e.k === "factory");
ok(!!fac, "factory exists for upgrade");
let sawFactory2 = false;
if (fac) {
  // accumulate credits to afford UPGRADE_COST
  for (let i = 0; i < 600 && o2.you.credits < UPGRADE_COST; i++) {
    const s = env2.step({}, 25);
    o2 = s.obs;
    if (s.done) break;
  }
  ok(o2.you.credits >= UPGRADE_COST, `credits >= ${UPGRADE_COST} for upgrade`, `credits=${o2.you.credits} t=${o2.tick}`);
  if (o2.you.credits >= UPGRADE_COST) {
    r = env2.step({ upgrade: fac.id }, 60);
    o2 = r.obs;
    sawFactory2 = o2.ents.some((e) => e.o === 0 && e.k === "factory2");
    ok(sawFactory2, "factory upgraded to factory2 via gym action", JSON.stringify(r.info.denied ?? "no denies"));
    const f2 = o2.ents.find((e) => e.k === "factory2");
    if (f2) ok(f2.mhp === 1300, "factory2 has upgraded max hp", `mhp=${f2.mhp}`);
  } else skip("factory upgraded to factory2 via gym action", "insufficient credits in budget");
} else skip("factory upgraded to factory2 via gym action", "no factory");

// ---------- 7. full episode vs scripted opponent ----------
console.log("--- full episode ---");
const env3 = new GymEnv({ opponent: "scripted", maxTicks: 6000 });
let o3 = env3.reset();
const st = { lastAtk: -10000 };
let done = false, final = null, steps = 0;
while (!done && steps++ < 1200) {
  // scripted baseline policy (same skeleton as gym-client demo)
  const me = o3.you, slot = me.slot;
  const mineE = o3.ents.filter((e) => e.o === slot);
  const foes = o3.ents.filter((e) => e.o >= 0 && e.o !== slot);
  const has = (k) => mineE.some((e) => e.k === k);
  const act = {};
  if (me.awaiting) act.place = findSpot(o3, slot, me.awaiting) ?? { tx: 6, ty: 6 };
  else {
    if (!me.bq) {
      let want = null;
      if (!has("power")) want = "power";
      else if (!has("refinery")) want = "refinery";
      else if (!has("barracks")) want = "barracks";
      else if (!has("factory")) want = "factory";
      else if (me.lowPower) want = "power";
      else if (!has("turret") && me.credits > 2000) want = "turret";
      if (want && me.credits >= BUILDINGS[want].cost) act.build = want;
    }
    if (has("barracks")) {
      const q = me.queues?.barracks;
      if ((q?.count ?? 0) < 4 && me.credits > 400) act.train = "infantry";
    }
    if (has("factory")) {
      const q = me.queues?.factory;
      const harv = mineE.filter((e) => e.k === "harvester").length;
      if (harv < 2 && !(q?.count ?? 0) && me.credits > 1600) act.train = "harvester";
      else if ((q?.count ?? 0) < 4 && me.credits > 900) act.train = "tank";
    }
    const army = mineE.filter((e) => !isB(e.k) && e.k !== "harvester");
    const tgt = foes.find((e) => isB(e.k)) ?? foes[0];
    if (tgt && army.length >= 8 && o3.tick - st.lastAtk > 800) {
      st.lastAtk = o3.tick;
      act.order = { ids: army.map((e) => e.id), kind: "amove", x: Math.floor(tgt.x), y: Math.floor(tgt.y) };
    }
  }
  const res = env3.step(act, 50);
  o3 = res.obs;
  done = res.done;
  final = res;
}
ok(done, "episode terminated", `steps=${steps} t=${o3.tick}`);
if (final) {
  ok(final.info.winner === 0 || final.info.winner === 1 || final.info.timeout === true, "winner decided or honest timeout", `winner=${final.info.winner} t=${final.info.tick}`);
  ok(Number.isFinite(final.reward), "terminal reward finite", `r=${final.reward}`);
  ok(final.info.rew && Number.isFinite(final.info.rew.total), "reward breakdown present", JSON.stringify(final.info.rew));
}
ok(steps < 1200, "episode resolved within step budget", `steps=${steps}`);

// ---------- summary ----------
console.log(`\n${passN} passed, ${failN} failed, ${skipN} skipped`);
if (fails.length) console.log("failures:", fails.join(" | "));
process.exit(failN ? 1 : 0);
