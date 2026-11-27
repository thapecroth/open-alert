#!/usr/bin/env node
// Correctness verification for the memoized snapshot pipeline — in-process, no sockets.
//
//   node test/snapverify.mjs [--ticks 4500] [--frames 300]
//
// Checks, over a live evolved battle:
//  1. CONTENT: memoized snapshot() output is byte-identical (canonical JSON) to an
//     independent reimplementation of the ORIGINAL always-rebuild serializer.
//  2. RETENTION: objects emitted in earlier frames never mutate afterwards —
//     a JSON clone taken at emission time still matches frames later.
//  3. REUSE: unchanged ents/players are reference-identical across frames.
//  4. SNAPDELTA: world.snapDelta.diff deep-equals diffSnaps(prev, next) every frame
//     (the worker fast path), and `from` identity chains correctly.
//  5. ROUNDTRIP: applying the delta through SnapReassembler reproduces the full state.

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

const { World } = await import("../src/server/world.ts");
const { AIBot } = await import("../src/server/bot.ts");
const { diffSnaps, SnapReassembler } = await import("../src/shared/snapdelta.ts");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const EVOLVE = Number(arg("ticks", "4500")) || 4500;
const FRAMES = Number(arg("frames", "300")) || 300;

let pass = 0;
let fail = 0;
const failures = [];
const ok = (cond, msg) => {
  if (cond) pass++;
  else {
    fail++;
    if (failures.length < 12) failures.push(msg);
  }
};

// ---------- independent reference serializer: the ORIGINAL pre-memoization logic ----------
// copied verbatim (logic-wise) from git HEAD snapshot(), operating on world internals.
function referenceSnapshot(w) {
  const ents = [];
  for (const e of w.ents.values()) {
    const s = {
      id: e.id,
      o: e.o,
      k: e.k === "spy" && w.tick >= e.spottedUntil ? "infantry" : e.k,
      x: Math.round(e.x * 100) / 100,
      y: Math.round(e.y * 100) / 100,
      hp: Math.max(0, Math.round(e.hp)),
      mhp: e.mhp,
      d: Math.round(e.d * 10),
    };
    if (e.k === "harvester" || e.k === "supplytruck") s.cargo = Math.round(e.cargo);
    else if (transportCapOfLocal(e.k) > 0) s.cargo = e.passengers?.length ?? 0;
    if (w.config.logistics !== false && !isBuildingLocal(e.k)) {
      const fl = Math.round(e.fuel);
      const am = Math.round(e.ammo);
      if (fl < 100) s.fl = fl;
      if (am < 100) s.am = am;
    }
    if (e.vet > 0) s.vet = e.vet;
    if (e.hold) s.hold = true;
    if (w.isStealthed(e)) s.sub = true;
    if (e.k === "spy" && w.tick >= e.spottedUntil) s.disg = "spy";
    if (e.fpvAlt !== undefined) s.alt = Math.round(e.fpvAlt * 100) / 100;
    if (e.rally) s.rally = [e.rally[0], e.rally[1]];
    if (!isBuildingLocal(e.k) && (e.order || e.orderQueue.length)) {
      const wp = [];
      const pushOrd = (ord) => {
        let ox = ord.x,
          oy = ord.y;
        if ((ord.kind === "attack" || ord.kind === "board") && ord.target != null) {
          const t = w.ents.get(ord.target);
          if (t) {
            ox = t.x;
            oy = t.y;
          }
        }
        wp.push([Math.round(ox * 10) / 10, Math.round(oy * 10) / 10, ord.kind]);
      };
      if (e.order) pushOrd(e.order);
      for (const q of e.orderQueue) pushOrd(q);
      if (wp.length) s.wp = wp;
    }
    ents.push(s);
  }
  const players = {};
  for (const p of w.players.values()) {
    const qCopy = {};
    for (const cat of PROD_CATS_LOCAL) if (p.queues[cat]?.length) qCopy[cat] = p.queues[cat].map((i) => ({ ...i }));
    const ps = {
      slot: p.slot,
      credits: Math.floor(p.credits),
      pwrHave: p.pwrHave,
      pwrUse: p.pwrUse,
      lowPower: p.lowPower,
      eliminated: p.eliminated,
      awaiting: [...p.awaiting],
      bq: p.bq.map((i) => ({ ...i })),
      awaitingDef: [...p.awaitingDef],
      dq: p.dq.map((i) => ({ ...i })),
      queues: qCopy,
      team: p.team,
    };
    if (p.swLeft >= 0) {
      ps.swReady = p.swLeft <= 0 && !p.lowPower;
      ps.swLeft = Math.ceil(p.swLeft);
      ps.swTotal = SW_CHARGE_TICKS_LOCAL;
    }
    if (p.reconLeft >= 0) {
      ps.reconReady = p.reconLeft <= 0 && !p.lowPower;
      ps.reconLeft = Math.ceil(p.reconLeft);
      ps.reconTotal = RECON_CHARGE_TICKS_LOCAL;
    }
    ps.prodBoost = {
      barracks: w.prodBoostOf(p.slot, "barracks"),
      factory: w.prodBoostOf(p.slot, "factory"),
      airfield: w.prodBoostOf(p.slot, "airfield"),
      shipyard: w.prodBoostOf(p.slot, "shipyard"),
    };
    players[p.slot] = ps;
  }
  return { ents, crates: [...w.crates.values()], bridges: [...w.bridges], players };
}

// pull the few gamedefs helpers/constants the reference needs
const gamedefs = await import("../src/shared/gamedefs.ts");
const transportCapOfLocal = gamedefs.transportCapOf;
const PROD_CATS_LOCAL = ["barracks", "factory", "airfield", "shipyard"];
const SW_CHARGE_TICKS_LOCAL = gamedefs.SW_CHARGE_TICKS;
const RECON_CHARGE_TICKS_LOCAL = gamedefs.RECON_CHARGE_TICKS;
const BUILDINGS_LOCAL = gamedefs.BUILDINGS;
const isBuildingLocal = (k) => k in BUILDINGS_LOCAL;

// canonical JSON with sorted keys — comparison immune to property insertion order
const canon = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
};

// ---------- scenario ----------
const slots = [0, 1, 2, 3, 4, 5, 6, 7];
const teams = {};
for (const s of slots) teams[s] = 0;
const world = new World(slots, {
  map: "fulda_gap",
  teams,
  config: { startCredits: 20000, gameSpeed: 1, superweapons: true, crates: true, derricks: true, fog: true, logistics: true },
});
const profiles = ["balanced", "rusher", "turtle", "tech"];
const bots = slots.map((s, i) => new AIBot(`bot-${s}`, { diff: i < 4 ? "brutal" : "normal", profile: profiles[i % 4] }));
const stepOnce = () => {
  for (let b = 0; b < slots.length; b++) {
    try {
      bots[b].tick(world, slots[b]);
    } catch {
      /* noise */
    }
  }
  world.step();
};

for (let t = 0; t < EVOLVE && world.winner === null; t++) {
  stepOnce();
  if (world.tick % 2 === 0) world.snapshot(); // drain events like production
}
console.log(`[verify] evolved to tick ${world.tick}, ents=${world.ents.size} — checking ${FRAMES} frames`);

// ---------- per-frame checks ----------
let prevSnap = null;
let prevRetObj = null;
let reuseEntSum = 0;
let reuseEntTotal = 0;
let reusePlayerSum = 0;
let reusePlayerTotal = 0;
let retentionClones = []; // clones of emissions, validated later after more stepping
const rx = new SnapReassembler();
let rxSeeded = false;
let seqCounter = 0;

for (let f = 0; f < FRAMES && world.winner === null; f++) {
  stepOnce();
  stepOnce();
  const snap = world.snapshot();
  const retObj = snap; // the exact returned object
  const ref = referenceSnapshot(world);

  // 1. CONTENT — memoized output identical to the reference serializer
  if (canon(snap.ents) !== canon(ref.ents)) {
    // find first diverging ent for diagnostics
    let diag = "";
    const byId = new Map(ref.ents.map((e) => [e.id, e]));
    for (const e of snap.ents) {
      const r = byId.get(e.id);
      if (!r) {
        diag = `ent ${e.id} in memo but not ref`;
        break;
      }
      if (canon(e) !== canon(r)) {
        diag = `ent ${e.id}: memo=${canon(e)} ref=${canon(r)}`;
        break;
      }
    }
    ok(false, `frame ${f} ents diverge: ${diag || "length/order mismatch"}`);
  } else {
    ok(true, "ents content");
  }
  ok(canon(snap.players) === canon(ref.players), `frame ${f} players diverge`);
  ok(canon(snap.crates) === canon(ref.crates), `frame ${f} crates diverge`);
  canon(snap.bridges) === canon(ref.bridges) ? pass++ : ((fail++), failures.push(`frame ${f} bridges diverge`));

  // 3. REUSE — reference stability across consecutive frames
  if (prevSnap) {
    const prevById = new Map(prevSnap.ents.map((e) => [e.id, e]));
    let same = 0;
    let both = 0;
    for (const e of snap.ents) {
      const p = prevById.get(e.id);
      if (!p) continue;
      both++;
      if (p === e) same++;
    }
    reuseEntSum += same;
    reuseEntTotal += both;
    for (const s of Object.keys(snap.players)) {
      reusePlayerTotal++;
      if (prevSnap.players[s] === snap.players[s]) reusePlayerSum++;
    }

    // 4. SNAPDELTA — metadata matches the standalone diff and chains correctly
    const meta = world.snapDelta;
    ok(meta !== null && meta.from === prevRetObj, `frame ${f} snapDelta.from chains to previous snapshot object`);
    const standalone = diffSnaps(prevSnap, snap);
    if (canon(meta.diff.ents) !== canon(standalone.ents)) {
      const diag = `meta=${canon(meta.diff.ents).slice(0, 400)} standalone=${canon(standalone.ents).slice(0, 400)}`;
      ok(false, `frame ${f} snapDelta.ents diverge: ${diag}`);
    } else pass++;
    canon(meta.diff.gone ?? []) === canon(standalone.gone ?? [])
      ? pass++
      : ((fail++), failures.push(`frame ${f} snapDelta.gone diverge: meta=${JSON.stringify(meta.diff.gone)} standalone=${JSON.stringify(standalone.gone)}`));
    canon(meta.diff.players ?? {}) === canon(standalone.players ?? {})
      ? pass++
      : ((fail++), failures.push(`frame ${f} snapDelta.players diverge`));
    canon(meta.diff.crates ?? []) === canon(standalone.crates ?? []) ? pass++ : ((fail++), failures.push(`frame ${f} snapDelta.crates diverge`));
    canon(meta.diff.bridges ?? []) === canon(standalone.bridges ?? []) ? pass++ : ((fail++), failures.push(`frame ${f} snapDelta.bridges diverge`));

    // 5. ROUNDTRIP — reassemble the standalone diff onto the keyframed state
    if (!rxSeeded) {
      rx.keyframe({ t: "snap", seq: seqCounter, tick: world.tick - 2, ents: prevSnap.ents, crates: prevSnap.crates, bridges: prevSnap.bridges, players: prevSnap.players, events: [] });
      rxSeeded = true;
    } else {
      // re-seed every frame from prevSnap to isolate single-delta application
      rx.keyframe({ t: "snap", seq: seqCounter, tick: world.tick - 2, ents: prevSnap.ents, crates: prevSnap.crates, bridges: prevSnap.bridges, players: prevSnap.players, events: [] });
    }
    seqCounter++;
    const out = rx.delta({ seq: seqCounter, tick: world.tick, ents: standalone.ents, gone: standalone.gone, crates: standalone.crates, bridges: standalone.bridges, players: standalone.players, events: [] });
    ok(out !== null, `frame ${f} reassembly dropped`);
    if (out) {
      ok(canon(out.ents) === canon(snap.ents), `frame ${f} roundtrip ents mismatch`);
      canon(out.players) === canon(snap.players) ? pass++ : ((fail++), failures.push(`frame ${f} roundtrip players mismatch`));
    }
  }

  // 2. RETENTION — clone at emission; validate the ORIGINAL references later
  if (f % 25 === 0) {
    retentionClones.push({ frame: f, cloneJson: canon(snap.ents) + canon(snap.players), snap });
  }
  // validate older clones: the ORIGINAL objects must still serialize identically
  for (const rc of retentionClones) {
    if (rc.frame !== f && f - rc.frame >= 20 && !rc.checked) {
      rc.checked = true;
      ok(canon(rc.snap.ents) + canon(rc.snap.players) === rc.cloneJson, `retention: frame-${rc.snap ? rc.frame : "?"} emitted objects mutated after emission!`);
    }
  }

  prevSnap = snap;
  prevRetObj = retObj;
}

console.log(`[verify] ent reference-reuse rate: ${((reuseEntSum / Math.max(1, reuseEntTotal)) * 100).toFixed(1)}% (${reuseEntSum}/${reuseEntTotal})`);
console.log(`[verify] player reference-reuse rate: ${((reusePlayerSum / Math.max(1, reusePlayerTotal)) * 100).toFixed(1)}% (${reusePlayerSum}/${reusePlayerTotal})`);
ok(reuseEntTotal > 0 && reuseEntSum / reuseEntTotal > 0.3, "memoization reuses a meaningful share of ent references");
console.log(`\n${pass} passed, ${fail} failed`);
for (const m of failures) console.log(`  FAIL: ${m}`);
process.exit(fail ? 1 : 0);
