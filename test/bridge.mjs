import { registerHooks, createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
registerHooks({
  resolve(s, c, n) { try { return n(s, c); } catch (e) { if ((s.startsWith("./")||s.startsWith("../")) && !/\.[a-z0-9]+$/i.test(s)) return n(s+".ts", c); throw e; } },
  load(u, c, n) { const r = n(u, c); if (u.endsWith(".ts")) { const o = ts.transpileModule(String(r.source), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: u }); return { format: "module", source: o.outputText, shortCircuit: true }; } return r; },
});
const { World } = await import("../src/server/world.ts");
const { getMapLayout } = await import("../src/shared/gamedefs.ts");

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FAIL", n); } };

const w = new World([0, 1], { map: "islands", teams: { 0: 1, 1: 2 } });
const p = w.players.get(0);
p.credits = 10000;

// find a shore: passable land tile adjacent to water
const layout = getMapLayout("islands");
const W = layout.w, H = layout.h;
let eng = null, tx = -1, ty = -1, sx0 = -1, sy0 = -1;
outer:
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
  if (!w.passable(x, y)) continue;
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    if (w.water[w.idx(x+dx, y+dy)] !== 1) continue;
    const e2 = w["spawnUnit"](0, "engineer", x, y);
    // click the adjacent water tile — cmdBridge BFS-routes to a far landmass if one is within 16
    const err = w.cmdBridge(0, e2.id, x+dx, y+dy);
    if (err === null) { eng = e2; tx = x+dx; ty = y+dy; sx0 = x; sy0 = y; break outer; }
  }
}
ok(!!eng, `cmdBridge accepted somewhere on islands → click ${tx},${ty}`);
ok(eng?.bTiles?.length > 0, `bTiles queued: ${eng?.bTiles?.length}`);
ok(eng?.order?.kind === "bridge", "bridge order set");

const before = p.credits;
const err = w.cmdBridge(0, eng.id, tx, ty);
ok(err === null, `cmdBridge accepted (${err})`);
ok(eng.bTiles?.length > 0, `bTiles queued: ${eng.bTiles?.length}`);
ok(eng.order?.kind === "bridge", "bridge order set");

// step until done (18 ticks/tile + walking time)
let guard = 0;
while (eng.order?.kind === "bridge" && guard++ < 4000) w.step();
ok(!eng.order || eng.order.kind !== "bridge", `bridge complete after ${guard} ticks`);
const built = eng.bTiles ? 0 : (w.bridges.size);
ok(w.bridges.size > 0, `bridge tiles laid: ${w.bridges.size}`);
const spent = before - p.credits;
ok(spent === w.bridges.size * 40, `charged $40/tile: spent ${spent} for ${w.bridges.size} tiles`);

// bridge tiles are land-passable + sea-passable
const firstBridge = [...w.bridges][0];
const bx = firstBridge % W, by = (firstBridge / W) | 0;
ok(w.passable(bx, by) === true, "bridge tile land-passable");
ok(w.passableSea(bx, by) === true, "bridge tile sea-passable (ships pass under)");
ok(w.water[firstBridge] === 1, "bridge tile still water underneath");

// serialize round-trip keeps bridges
const d = w.serialize();
const w2 = World.deserialize(d);
ok(w2.bridges.size === w.bridges.size, `serialize keeps ${w2.bridges.size} bridge tiles`);
ok(w2.passable(bx, by) === true, "restored bridge land-passable");

// reject bad orders — target the engineer's own (land) tile so no water lies on the Bresenham line
const eng2 = w["spawnUnit"](0, "engineer", sx0, sy0);
ok(w.cmdBridge(0, eng2.id, Math.floor(eng2.x), Math.floor(eng2.y)) !== null, "rejects non-water target");
ok(w.cmdBridge(1, eng2.id, tx, ty) !== null, "rejects wrong owner");

// retasking mid-build drops the order (bTiles cleared)
const w3 = new World([0, 1], { map: "islands", teams: { 0: 1, 1: 2 } });
w3.players.get(0).credits = 10000;
const e3 = w3["spawnUnit"](0, "engineer", sx0, sy0);
w3.cmdBridge(0, e3.id, tx, ty);
w3.cmdOrder(0, [e3.id], "move", Math.max(0, sx0 - 2), sy0);
ok(e3.bTiles === undefined, "retask clears bridge plan");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
