#!/usr/bin/env node
// MCP defs drift guard + smoke test for mcp/open-alert-mcp.mjs.
//
// The MCP server single-sources its game definitions from src/shared/gamedefs.ts
// at startup. This test spawns the stdio server as a child process, speaks
// JSON-RPC initialize + tools/list + tools/call to it, and asserts the exposed
// tool surface matches the REAL defs imported directly here — so any future
// additive change to gamedefs.ts (new units/buildings/maps/tables) is verified
// end-to-end, and any regression to hand-mirrored tables fails loudly.
//
// Fully self-contained: no game server, no network, no puppeteer.
// Run: node test/mcpdefs.mjs

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const ok = (cond, name, evidence = "") => {
  if (cond) {
    pass++;
    console.log("ok:", name);
  } else {
    fail++;
    console.log("FAIL:", name, evidence);
  }
};

// Real defs straight from the source of truth (same native TS import the repo's tests use).
const gd = await import("../src/shared/gamedefs.ts");
const expectedBuildable = Object.entries(gd.BUILDINGS)
  .filter(([, d]) => !d.noBuild)
  .map(([k]) => k);
const expectedUnits = Object.keys(gd.UNITS);
const expectedMaps = gd.MAP_LIST.map((m) => m.id);
const maxMapDim = Math.max(gd.MAP_W ?? 64, ...gd.MAP_LIST.map((m) => Math.max(m.w ?? 0, m.h ?? 0)));

// ---- spawn the stdio MCP server ----
const t0 = Date.now();
const child = spawn(process.execPath, [join(root, "mcp/open-alert-mcp.mjs")], {
  env: { ...process.env, OA_URL: "http://127.0.0.1:9" }, // unreachable on purpose: tools/list must not need the game server
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => {
  stderr += d;
});
const responses = [];
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) {
      try {
        responses.push(JSON.parse(line));
      } catch {
        // ignore non-JSON noise
      }
    }
  }
});
const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const waitFor = async (id, timeoutMs = 10000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = responses.find((x) => x.id === id);
    if (r) return r;
    await new Promise((r2) => setTimeout(r2, 20));
  }
  return null;
};

let failed = false;
try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcpdefs", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_gym_schema", arguments: {} } });

  const init = await waitFor(1);
  ok(!!init?.result?.serverInfo, "initialize handshake", JSON.stringify(init ?? {}).slice(0, 200));
  const startupMs = Date.now() - t0;
  ok(init?.result?.serverInfo?.name === "open-alert-mcp", "serverInfo.name is open-alert-mcp");
  ok(startupMs < 3000, `startup+init fast (<3s, was ${startupMs}ms)`);

  const list = await waitFor(2);
  const tools = list?.result?.tools ?? [];
  ok(tools.length >= 8, `tools/list returns ${tools.length} tools`, tools.map((t) => t.name).join(","));

  const buildTool = tools.find((t) => t.name === "build_structure");
  const trainTool = tools.find((t) => t.name === "train_unit");
  const joinTool = tools.find((t) => t.name === "join_game");
  const placeTool = tools.find((t) => t.name === "place_structure");
  const arenaTool = tools.find((t) => t.name === "create_ai_arena");
  const setSlotTool = tools.find((t) => t.name === "set_slot");
  ok(tools.some((t) => t.name === "transfer_host"), "transfer_host tool exposed");
  ok(!!setSlotTool, "set_slot tool exposed");
  ok(tools.some((t) => t.name === "swap_slot"), "swap_slot tool exposed");
  ok(setSlotTool?.inputSchema?.properties?.slot?.maximum === (gd.MAX_PLAYERS ?? 8) - 1, `set_slot slot maximum tracks MAX_PLAYERS (${(gd.MAX_PLAYERS ?? 8) - 1})`, JSON.stringify(setSlotTool?.inputSchema?.properties?.slot ?? {}));

  // ---- enum drift checks: exact set equality with real defs ----
  const bk = buildTool?.inputSchema?.properties?.kind?.enum ?? [];
  const uk = trainTool?.inputSchema?.properties?.unit?.enum ?? [];
  const mk = joinTool?.inputSchema?.properties?.map?.enum ?? [];
  const ak = arenaTool?.inputSchema?.properties?.map?.enum ?? [];

  const missingB = expectedBuildable.filter((k) => !bk.includes(k));
  const extraB = bk.filter((k) => !expectedBuildable.includes(k));
  ok(missingB.length === 0 && extraB.length === 0, `build_structure enum == real buildable kinds (${expectedBuildable.length})`, `missing=${missingB} extra=${extraB}`);

  const missingU = expectedUnits.filter((k) => !uk.includes(k));
  const extraU = uk.filter((k) => !expectedUnits.includes(k));
  ok(missingU.length === 0 && extraU.length === 0, `train_unit enum == real unit kinds (${expectedUnits.length})`, `missing=${missingU} extra=${extraU}`);

  const missingM = expectedMaps.filter((k) => !mk.includes(k));
  const extraM = mk.filter((k) => !expectedMaps.includes(k));
  ok(missingM.length === 0 && extraM.length === 0, `join_game map enum == real map list (${expectedMaps.length})`, `missing=${missingM} extra=${extraM}`);
  ok(JSON.stringify(ak) === JSON.stringify(mk), "create_ai_arena map enum matches join_game");

  // noBuild kinds must NOT be buildable (coalplant/fusion/barracks2/factory2/airfield2/shipyard2/derrick/coalmine…)
  const noBuild = Object.entries(gd.BUILDINGS)
    .filter(([, d]) => d.noBuild)
    .map(([k]) => k);
  const leaked = noBuild.filter((k) => bk.includes(k));
  ok(leaked.length === 0, `noBuild kinds excluded from build enum (${noBuild.length} kinds)`, leaked.join(","));

  // ---- description accuracy: spot-check real stats appear in generated text ----
  const buildDesc = buildTool?.inputSchema?.properties?.kind?.description ?? "";
  const trainDesc = trainTool?.inputSchema?.properties?.unit?.description ?? "";
  ok(buildDesc.includes(`radar $${gd.BUILDINGS.radar.cost}`), `radar cost $${gd.BUILDINGS.radar.cost} in build desc (stale mirror had wrong cost)`);
  if (gd.BUILDINGS.satlink) ok(buildDesc.includes(`satlink $${gd.BUILDINGS.satlink.cost}`), "satlink cost in build desc");
  if (gd.UNITS.himars) ok(trainDesc.includes(`himars $${gd.UNITS.himars.cost}`), "himars cost in train desc");
  if (gd.UNITS.carrier) ok(trainDesc.includes(`carrier $${gd.UNITS.carrier.cost}`), "carrier cost in train desc");
  if (gd.UNITS.stealthbomber) ok(trainDesc.includes("stealthbomber"), "stealthbomber in train desc");
  if (gd.BUILDINGS.supplyhub?.forwardRange) ok(buildDesc.includes(`forward-range ${gd.BUILDINGS.supplyhub.forwardRange}`), "supplyhub forward-range in build desc");

  // ---- coordinate bounds track largest map, never hardcoded 63 ----
  const txMax = placeTool?.inputSchema?.properties?.tx?.maximum;
  ok(txMax === maxMapDim - 1, `place tx maximum == largest map dim - 1 (${maxMapDim - 1})`, `got ${txMax}`);
  ok(txMax > 63 || maxMapDim <= 64, "coordinate bounds not stuck at legacy 63");

  // ---- gym schema tool serves and references live defs ----
  const gym = await waitFor(3);
  const gymText = gym?.result?.content?.[0]?.text;
  ok(!!gymText && gym?.result?.isError === false, "get_gym_schema responds without error");
  if (gymText) {
    const schema = JSON.parse(gymText);
    const buildEnum = schema?.action_schema?.parameters?.properties?.build?.anyOf?.[0]?.enum ?? [];
    ok(buildEnum.length === Object.keys(gd.BUILDINGS).length, `gym action build enum covers all ${Object.keys(gd.BUILDINGS).length} building kinds`);
    const trainEnum = schema?.action_schema?.parameters?.properties?.train?.anyOf?.[0]?.enum ?? [];
    ok(trainEnum.length === expectedUnits.length, `gym action train enum covers all ${expectedUnits.length} unit kinds`);
    const upgDesc = schema?.action_schema?.parameters?.properties?.upgrade?.description ?? "";
    const allPaths = Object.values(gd.UPGRADE_PATHS ?? {}).every((p) => upgDesc.includes(`${p.from}→${p.to}`));
    ok(allPaths, "gym upgrade description lists every UPGRADE_PATHS path", upgDesc.slice(0, 120));
    // parallel-queue parity fields documented
    const youFields = JSON.stringify(schema?.gym_obs_contract?.fields?.you ?? {});
    ok(youFields.includes("awaitingDef") && youFields.includes("dq"), "gym obs contract documents parallel defense queues (dq/awaitingDef)");
  }

  // startup log line reports which loader was used
  ok(/defs=(native-strip-types|esbuild-bundle|typescript-transpile)/.test(stderr), "server reports defs loader used", stderr.trim().split("\n")[0] ?? "");
} catch (err) {
  failed = true;
  console.log("FAIL: unexpected test error:", err.message);
} finally {
  try {
    child.kill();
  } catch {
    // ignore
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail || failed ? 1 : 0);
