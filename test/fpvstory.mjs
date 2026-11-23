// Grey-box: FpvStory — entry barks, objective ladder, kill streaks, feed cap,
// warnings rate-limit, lock messages, medals, campaign completion.
// Pure TS module — no DOM/three deps.
import { registerHooks, createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript");
registerHooks({
  resolve(s, c, n) {
    try { return n(s, c); } catch (e) { return n(s + ".ts", c); }
  },
  load(u, c, n) {
    const r = n(u, c);
    if (u.endsWith(".ts")) {
      const o = ts.transpileModule(String(r.source), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      return { format: "module", source: o.outputText, shortCircuit: true };
    }
    return r;
  },
});

const { FpvStory } = await import("../src/client/story.ts");
const { UNITS } = await import("../src/shared/gamedefs.ts");

let pass = 0, fail = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass++; console.log("ok:", label); }
  else { fail++; fails.push(label); console.log("FAIL:", label); }
}

const KINDS = {}; // fake kind registry for ctx.kindOf
const ctx = (myId) => ({ myId, kindOf: (id) => KINDS[id] });
const tel = { hp: 1, mhp: 1, fuel: 100, ammo: 100, lockState: "none", lockPct: 0, speed: 0, alt: 0.6, target: null };
const step = (s, n, t = tel) => { for (let i = 0; i < n; i++) s.tick(0.1, t); };

// ---------- entry ----------
{
  const s = new FpvStory();
  s.reset("tank", "cmdr-vex");
  const feed = s.state.feed;
  ok(feed.length === 1 && feed[0].tone === "radio", "entry bark pushed as radio line");
  ok(feed[0].text.includes("CMDR-VEX"), `callsign uppercased in bark (${feed[0].text})`);
  ok(s.state.objective && s.state.objective.text.length > 0, `first objective set (${s.state.objective?.text})`);
  ok(s.state.objective.prog === 0 && s.state.objective.total >= 1, "objective starts at 0 progress");
  ok(s.state.objective.text === "BOOT CAMP — FIRE YOUR WEAPON" || s.state.objective.text.includes("—"), "objective has title — desc format");
}

// ---------- shot objective advances ----------
{
  const s = new FpvStory();
  s.reset("tank", "A");
  const first = s.state.objective.text;
  s.onEvent({ e: "shot", src: 7 }, ctx(7));
  ok(s.state.objective.prog === 1 || s.state.objective.text !== first, "shot event advances/completes first objective");
}

// ---------- kill events: counter, hitmark, feed, streak ----------
{
  const s = new FpvStory();
  s.reset("infantry", "B");
  KINDS[50] = "tank"; KINDS[51] = "infantry"; KINDS[52] = "barracks";
  s.onEvent({ e: "kill", src: 7, id: 50, x: 0, y: 0 }, ctx(7));
  ok(s.state.kills === 1 && s.state.hitmark === 1, "kill bumps counter + hitmark");
  ok(s.state.feed.some((l) => l.tone === "kill" && l.text.includes("TARGET DOWN")), "kill feed line");
  ok(s.state.feed.some((l) => l.tone === "medal"), "medal line pushed when objective completes");
  s.onEvent({ e: "kill", src: 7, id: 51, x: 0, y: 0 }, ctx(7));
  ok(s.state.streak === 2, "quick second kill chains streak x2");
  s.onEvent({ e: "kill", src: 7, id: 52, x: 0, y: 0 }, ctx(7));
  ok(s.state.feed.some((l) => l.text.includes("STRUCTURE DESTROYED")), "building kill reports structure");
  // foreign kills ignored
  s.onEvent({ e: "kill", src: 99, id: 50, x: 0, y: 0 }, ctx(7));
  ok(s.state.kills === 3, "other players' kills not counted");
  // streak decays after window
  step(s, 90);
  s.onEvent({ e: "kill", src: 7, id: 50, x: 0, y: 0 }, ctx(7));
  ok(s.state.streak === 1, "streak resets after 8s window");
}

// ---------- feed cap ----------
{
  const s = new FpvStory();
  s.reset("tank", "C");
  for (let i = 0; i < 12; i++) s.onEvent({ e: "kill", src: 7, id: 60 + i, x: 0, y: 0 }, ctx(7));
  ok(s.state.feed.length <= 5, `feed capped at 5 (${s.state.feed.length})`);
}

// ---------- warnings rate-limited ----------
{
  const s = new FpvStory();
  s.reset("tank", "D");
  const low = { ...tel, hp: 0.15 * tel.mhp };
  step(s, 10, low);
  const warns1 = s.state.feed.filter((l) => l.tone === "warn").length;
  step(s, 10, low);
  const warns2 = s.state.feed.filter((l) => l.tone === "warn").length;
  ok(warns1 >= 1, "low HP warning pushed");
  ok(warns2 === warns1, "warning not spammed on consecutive ticks");
}

// ---------- idle chatter after 25s (count via sfx since feed lines age out) ----------
{
  const s = new FpvStory();
  let radio = 0;
  s.onSfx = (n) => { if (n === "radio") radio++; };
  s.reset("destroyer", "E"); // bark = 1 radio sfx
  step(s, 300); // 30s idle
  ok(radio >= 2, `idle radio chatter fires after 25s (${radio} radio cues)`);
}

// ---------- lock messages ----------
{
  const s = new FpvStory();
  s.reset("interceptor", "F");
  step(s, 5, { ...tel, lockState: "locking", lockPct: 0.5 });
  ok(s.state.lockMsg === "LOCK 50%", `locking msg shown (${s.state.lockMsg})`);
  step(s, 5, { ...tel, lockState: "locked" });
  ok(s.state.lockMsg === "◈ LOCKED", `locked msg (${s.state.lockMsg})`);
  step(s, 5, tel);
  ok(s.state.lockMsg !== "◈ LOCKED", "lock msg clears when lock drops");
}

// ---------- campaign completion: medals + WAR HERO ----------
{
  const s = new FpvStory();
  s.reset("tank", "G");
  s.onEvent({ e: "shot", src: 7 }, ctx(7)); // clear shot objective
  for (let i = 0; i < 40; i++) {
    KINDS[100 + i] = i % 5 === 0 ? "barracks" : "tank";
    s.onEvent({ e: "kill", src: 7, id: 100 + i, x: 0, y: 0 }, ctx(7));
    s.tick(0.05, tel);
  }
  ok(s.state.objective.done === true, `ladder completes (${s.state.objective.text})`);
  ok(s.state.medals.length >= 5, `medals earned incl War Hero (${s.state.medals.length}: ${s.state.medals.join(",")})`);
}

// ---------- sfx callback wired ----------
{
  const s = new FpvStory();
  const names = [];
  s.onSfx = (n) => names.push(n);
  s.reset("tank", "H");
  s.onEvent({ e: "kill", src: 7, id: 1, x: 0, y: 0 }, ctx(7));
  ok(names.includes("kill") && names.includes("hitmark"), `sfx cues emitted (${names.join(",")})`);
}

// ---------- reset between sorties ----------
{
  const s = new FpvStory();
  s.reset("tank", "I");
  for (let i = 0; i < 3; i++) s.onEvent({ e: "kill", src: 7, id: i, x: 0, y: 0 }, ctx(7));
  s.reset("chopper", "J");
  ok(s.state.kills === 0 && s.state.streak === 0 && s.state.medals.length === 0, "reset clears kills/streak/medals");
  ok(s.state.feed.length === 1 && s.state.objective.prog === 0, "reset restarts feed + objective ladder");
}

// ---------- every drivable kind has an entry bark ----------
{
  const s = new FpvStory();
  let covered = 0, total = 0;
  for (const k of Object.keys(UNITS)) {
    if (UNITS[k].isBuilding) continue;
    total++;
    s.reset(k, "Z");
    if (s.state.feed.length === 1 && s.state.feed[0].text.length > 10) covered++;
  }
  ok(covered === total, `all ${total} unit kinds produce an entry bark`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fails.length) console.log("failures:", fails.join(" | "));
process.exit(fail ? 1 : 0);
