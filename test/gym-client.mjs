#!/usr/bin/env node
// Standalone GymEnv demo — no sockets, no worker. Plays one episode with a
// simple scripted policy driving slot 0 vs the env's built-in opponent.
//
//   node test/gym-client.mjs [maxTicks] [--random] [--idle|--mirror]
//
// The repo's TS sources use bundler-style extensionless imports and type-only
// value imports (e.g. `import { BuildingKind }`), which plain Node can't load.
// The module hooks below patch that in-process: extensionless specifier ->
// +".ts", and .ts files are run through TypeScript's transpileModule so
// type-only imports are elided (strip-types alone keeps them and crashes).

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
const { BUILDINGS, UNITS, MAP_W, MAP_H } = await import("../src/shared/gamedefs.ts");

const maxTicks = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 4000;
const random = process.argv.includes("--random");
const opponent = process.argv.includes("--idle") ? "idle" : process.argv.includes("--mirror") ? "mirror" : "scripted";

const isB = (k) => k in BUILDINGS;
const idx = (x, y) => y * MAP_W + x;

// ---------- placement helper (client-side replica of world.canPlace) ----------
function occupiedAndOre(obs) {
  const occ = new Set(),
    ore = new Set();
  for (const e of obs.ents)
    if (isB(e.k)) {
      const d = BUILDINGS[e.k];
      const bx = Math.round(e.x - d.w / 2),
        by = Math.round(e.y - d.h / 2);
      for (let y = by; y < by + d.h; y++) for (let x = bx; x < bx + d.w; x++) occ.add(idx(x, y));
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
    const bx = Math.round(e.x - bd.w / 2),
      by = Math.round(e.y - bd.h / 2);
    const gapX = Math.max(bx - (tx + d.w), tx - (bx + bd.w));
    const gapY = Math.max(by - (ty + d.h), ty - (by + bd.h));
    if (Math.max(gapX, gapY) <= 2) return true;
  }
  return false;
}
function findSpot(obs, slot, kind) {
  const sets = occupiedAndOre(obs);
  const d = BUILDINGS[kind];
  for (const b of obs.ents) {
    if (b.o !== slot || !isB(b.k)) continue;
    const bd = BUILDINGS[b.k];
    const bx = Math.round(b.x - bd.w / 2),
      by = Math.round(b.y - bd.h / 2);
    for (let r = 1; r <= 4; r++)
      for (let y = by - r - d.h + 1; y < by + bd.h + r; y++)
        for (let x = bx - r - d.w + 1; x < bx + bd.w + r; x++)
          if (canPlaceObs(obs, slot, kind, x, y, sets)) return { tx: x, ty: y };
  }
  return null;
}

// ---------- policies ----------
const st = { lastAtk: -10000 };
function policy(obs) {
  const me = obs.you;
  if (me.eliminated) return {};
  const slot = me.slot;
  const mine = obs.ents.filter((e) => e.o === slot);
  const foes = obs.ents.filter((e) => e.o >= 0 && e.o !== slot);
  const has = (k) => mine.some((e) => e.k === k);
  const act = {};

  if (me.awaiting?.length) {
    act.place = findSpot(obs, slot, me.awaiting?.[0]) ?? { tx: 6, ty: 6 };
    return act;
  }
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
    if ((q?.length ?? 0) < 4 && me.credits > 400) act.train = "infantry";
  }
  if (has("factory")) {
    const q = me.queues?.factory;
    const harv = mine.filter((e) => e.k === "harvester").length;
    if (harv < 2 && !(q?.length ?? 0) && me.credits > 1600) act.train = "harvester";
    else if ((q?.length ?? 0) < 4 && me.credits > 900) act.train = "tank";
  }
  const army = mine.filter((e) => !isB(e.k) && e.k !== "harvester");
  const tgt = foes.find((e) => isB(e.k)) ?? foes[0];
  if (tgt && army.length && (army.length >= 8 || (army.length >= 4 && obs.tick - st.lastAtk > 800 && obs.tick > 1100))) {
    st.lastAtk = obs.tick;
    act.order = { ids: army.map((e) => e.id), kind: "amove", x: Math.floor(tgt.x), y: Math.floor(tgt.y) };
  }
  return act;
}

function randomPolicy(obs) {
  const me = obs.you;
  const mine = obs.ents.filter((e) => e.o === me.slot && !isB(e.k));
  const act = {};
  if (Math.random() < 0.1) act.build = Object.keys(BUILDINGS)[(Math.random() * 6) | 0];
  if (me.awaiting?.length && Math.random() < 0.8) {
    const spot = findSpot(obs, me.slot, me.awaiting?.[0]);
    if (spot) act.place = spot;
    else act.place = { tx: (Math.random() * MAP_W) | 0, ty: (Math.random() * MAP_H) | 0 };
  }
  if (Math.random() < 0.15) act.train = Object.keys(UNITS)[(Math.random() * 3) | 0];
  if (mine.length && Math.random() < 0.2) {
    act.order = {
      ids: mine.filter(() => Math.random() < 0.7).map((e) => e.id),
      kind: ["move", "amove", "attack", "harvest"][(Math.random() * 4) | 0],
      x: (Math.random() * MAP_W) | 0,
      y: (Math.random() * MAP_H) | 0,
    };
  }
  return act;
}

// ---------- episode ----------
console.log(`[gym] env: opponent=${opponent} maxTicks=${maxTicks} policy=${random ? "random" : "scripted"}`);
const env = new GymEnv({ opponent, maxTicks });
let obs = env.reset();
console.log(`[gym] reset: tick=${obs.tick} ents=${obs.ents.length} ore=${obs.ore.length} credits=${obs.you.credits}`);

// sanity: malformed action must be rejected with info.invalid and no crash
const probe = env.step({ build: "__proto__", order: { ids: "x", kind: "nuke", x: NaN, y: 0 } });
console.log(`[gym] invalid-action probe: invalid=${probe.info.invalid} reward=${probe.reward} reason=${probe.info.invalidReason}`);

let total = 0,
  steps = 0,
  done = false,
  last = probe;
total += probe.reward;
steps++;

while (!done && steps < maxTicks) {
  const action = (random ? randomPolicy : policy)(obs);
  const r = env.step(action, 10);
  obs = r.obs;
  done = r.done;
  total += r.reward;
  steps++;
  last = r;
  if (steps % 20 === 0 || done || r.info.invalid) {
    const me = obs.you;
    const own = obs.ents.filter((e) => e.o === me.slot).length;
    const foe = obs.ents.filter((e) => e.o >= 0 && e.o !== me.slot).length;
    const rw = r.info.rew ?? {};
    console.log(
      `[gym] t=${obs.tick} cr=${me.credits} pw=${me.pwrHave - me.pwrUse}${me.lowPower ? "LOW" : ""} ` +
        `own=${own} foe=${foe} await=${me.awaiting?.[0] ?? "-"} bq=${me.bq?.[0]?.kind ?? "-"} ` +
        `r=${r.reward >= 0 ? "+" : ""}${r.reward.toFixed(3)} ` +
        `(cr${rw.dCredits >= 0 ? "+" : ""}${rw.dCredits} k${rw.kills} l${rw.losses} T${rw.terminal}) ` +
        `tot=${total.toFixed(3)}${r.info.denied ? " denied=" + r.info.denied.join(";") : ""}`,
    );
  }
}

console.log(
  `[gym] DONE steps=${steps} tick=${obs.tick} winner=${last.info.winner} ` +
    `totalReward=${total.toFixed(3)} invalid=${!!last.info.invalid}`,
);
process.exit(0);
