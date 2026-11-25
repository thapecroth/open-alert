#!/usr/bin/env node
// ASCII preview of map layouts: node tools/mappreview.mjs <mapId> [scale]
import { registerHooks, createRequire } from "node:module";
const require = createRequire(new URL("/home/r1ch/projs/ra2/package.json", import.meta.url));
const ts = require("typescript");
registerHooks({
  resolve(s, c, n) { try { return n(s, c); } catch (e) { if ((s.startsWith("./") || s.startsWith("../")) && !/\.[a-z0-9]+$/i.test(s)) return n(s + ".ts", c); throw e; } },
  load(u, c, n) { const r = n(u, c); if (u.endsWith(".ts")) { const o = ts.transpileModule(String(r.source), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: u }); return { format: "module", source: o.outputText, shortCircuit: true }; } return r; },
});
const { getMapLayout, getSpawns } = await import("/home/r1ch/projs/ra2/src/shared/gamedefs.ts");
const id = process.argv[2] ?? "archipelago";
const sy = +(process.argv[3] ?? 2); // vertical sample step
const sx = +(process.argv[4] ?? 1); // horizontal sample step (optional; default exact)
const layout = getMapLayout(id);
const W = layout.w, H = layout.h;
const water = new Uint8Array(W * H), cliff = new Uint8Array(W * H);
for (const [x, y] of layout.water) water[y * W + x] = 1;
for (const [x, y] of layout.cliffs) cliff[y * W + x] = 1;
const spawns = getSpawns(W, H);
const sp = new Map();
spawns.forEach((s, i) => sp.set(`${s.x},${s.y}`, i));
const ore = new Set((layout.extraOre ?? []).map(([x, y]) => `${x},${y}`));
const der = new Set([...layout.derricks, ...(layout.coalmines ?? [])].map(([x, y]) => `${x},${y}`));
let out = `${id} ${W}x${H} water=${(layout.water.length / (W * H) * 100).toFixed(1)}% cliff=${(layout.cliffs.length / (W * H) * 100).toFixed(1)}%\n`;
for (let y = 0; y < H; y += sy) {
  let row = "";
  for (let x = 0; x < W; x += sx) {
    const k = `${x},${y}`;
    if (sp.has(k)) { row += String(sp.get(k)); continue; }
    if (der.has(k)) { row += "D"; continue; }
    if (ore.has(k)) { row += "O"; continue; }
    if (cliff[y * W + x]) row += "^";
    else if (water[y * W + x]) row += "~";
    else row += ".";
  }
  out += row + "\n";
}
console.log(out);
