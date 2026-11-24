// Tech-tree integration test (2 humans, real WebSockets):
//  1. build gating: radar w/o barracks, factory2 noBuild, arc w/o radar, heavy w/o factory
//  2. upgrade: factory->factory2 needs techlab; heavy only trains after the upgrade
//  3. engineer capture of an enemy building ("cap" event, owner flips, engineer consumed)
//  4. purifier: harvester deposit pays cargo*25*1.25 (~1250 for a full 40 load)
//  5. depot: builds, sim keeps running
//  6. arc: placed coil fires on an enemy unit that attacks it (shot events + damage/death)
// Run: node test/techtree.mjs   (dev server on :8787, party "game-room")
const ROOM = "tt" + Date.now().toString(36);
const URL = `ws://localhost:8787/parties/game-room/${ROOM}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, l, ev) => {
  c ? (pass++, console.log("ok:", l)) : (fail++, console.log("FAIL:", l, ev ? `| evidência: ${ev}` : ""));
};

// w,h das footprints p/ espelhar o canPlace no cliente (placement determinístico)
const BLD = {
  conyard: [3, 3], power: [2, 2], refinery: [3, 2], barracks: [2, 2], radar: [2, 2],
  factory: [3, 3], factory2: [3, 3], techlab: [3, 3], turret: [1, 1], arc: [1, 1],
  purifier: [2, 2], depot: [3, 2],
};
const UNITK = new Set(["infantry", "engineer", "rocket", "tank", "arty", "heavy", "spider", "harvester"]);
// defense-category builds run on the parallel queue: progress in p.dq, pending placement in p.awaitingDef
const DEFK = new Set(["turret", "sam", "arc", "irondome", "lasertower", "thaad"]);
const awaitingOf = (p, kind) => ((DEFK.has(kind) ? p?.awaitingDef : p?.awaiting)?.includes(kind) ? kind : null);
const queueBusy = (p, kind) =>
  DEFK.has(kind) ? (p?.dq?.length ?? 0) + (p?.awaitingDef?.length ?? 0) : (p?.bq?.length ?? 0) + (p?.awaiting?.length ?? 0);

function conn(name, token) {
  const ws = new WebSocket(URL);
  const st = { ws, msgs: [], slot: null, snaps: [], lobby: null, ore: new Map() };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    st.msgs.push(m);
    if (m.t === "init") {
      st.slot = m.slot;
      for (const [x, y, a] of m.ore) st.ore.set(x + "," + y, a);
    }
    if (m.t === "snap") {
      st.snaps.push(m);
      for (const ev of m.events ?? [])
        if (ev.e === "ore")
          for (const [x, y, a] of ev.cells) a > 0 ? st.ore.set(x + "," + y, a) : st.ore.delete(x + "," + y);
    }
    if (m.t === "lobby") st.lobby = m;
  };
  ws.onopen = () => ws.send(JSON.stringify({ t: "join", name, token }));
  return st;
}
const send = (s, m) => s.ws.send(JSON.stringify(m));
const lastSnap = (s) => s.snaps[s.snaps.length - 1];
const me = (s) => lastSnap(s)?.players?.[s.slot];
const ent = (s, id) => lastSnap(s)?.ents.find((e) => e.id === id);
const mine = (s, k) => (lastSnap(s)?.ents ?? []).filter((e) => e.o === s.slot && (!k || e.k === k));
const denies = (s) => s.msgs.filter((m) => m.t === "deny").map((m) => m.msg);
const allEvents = (s) => s.snaps.flatMap((n) => n.events ?? []);

async function waitFor(pred, ms, step = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = pred();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

// envia o comando e espera a PRÓXIMA mensagem deny (baseline por contagem)
async function expectDeny(s, msg, ms = 2500) {
  const n0 = denies(s).length;
  send(s, msg);
  await waitFor(() => denies(s).length > n0, ms, 100);
  const d = denies(s);
  return d.length > n0 ? d[d.length - 1] : null;
}

function brect(e) {
  const [w, h] = BLD[e.k];
  return { tx: Math.round(e.x - w / 2), ty: Math.round(e.y - h / 2), w, h };
}

// espelho local do canPlace: bounds + footprint livre (prédio/minério/unidade) + adjacência <=2
function legalSpots(s, kind, anchor) {
  const [fw, fh] = BLD[kind];
  const snap = lastSnap(s);
  if (!snap) return [];
  const blocked = new Set(), units = [], myB = [];
  for (const e of snap.ents) {
    if (BLD[e.k]) {
      const r = brect(e);
      if (e.o === s.slot) myB.push(r);
      for (let y = r.ty; y < r.ty + r.h; y++)
        for (let x = r.tx; x < r.tx + r.w; x++) blocked.add(x + "," + y);
    } else units.push([Math.floor(e.x), Math.floor(e.y)]);
  }
  const out = [], seen = new Set();
  for (const b of myB) {
    for (let ty = b.ty - fh - 2; ty <= b.ty + b.h + 2; ty++)
      for (let tx = b.tx - fw - 2; tx <= b.tx + b.w + 2; tx++) {
        const key = tx + "," + ty;
        if (seen.has(key)) continue;
        seen.add(key);
        const gapX = Math.max(b.tx - (tx + fw), tx - (b.tx + b.w));
        const gapY = Math.max(b.ty - (ty + fh), ty - (b.ty + b.h));
        if (Math.max(gapX, gapY) > 2) continue; // só guarda tile já adjacente a ESTE prédio
        if (tx < 0 || ty < 0 || tx + fw > 128 || ty + fh > 128) continue;
        let bad = false;
        for (let y = ty; y < ty + fh && !bad; y++)
          for (let x = tx; x < tx + fw && !bad; x++)
            if (blocked.has(x + "," + y) || (s.ore.get(x + "," + y) ?? 0) > 0) bad = true;
        if (bad) continue;
        if (units.some(([ux, uy]) => ux >= tx && ux < tx + fw && uy >= ty && uy < ty + fh)) continue;
        out.push([tx, ty]);
      }
  }
  out.sort(
    (a, b) =>
      Math.hypot(a[0] + fw / 2 - anchor[0], a[1] + fh / 2 - anchor[1]) -
      Math.hypot(b[0] + fw / 2 - anchor[0], b[1] + fh / 2 - anchor[1])
  );
  return out;
}

async function placeKind(s, kind, anchor, before) {
  for (const [tx, ty] of legalSpots(s, kind, anchor).slice(0, 30)) {
    if (awaitingOf(me(s), kind) !== kind) return null;
    send(s, { t: "place", tx, ty });
    await sleep(180);
    const found = mine(s, kind).find((e) => !before.has(e.id));
    if (found) return found;
  }
  return null;
}

// build -> espera awaiting -> place; tolera "insufficient funds" (renda da colheitadeira)
async function buildAndPlace(s, kind, anchor, ms = 120000) {
  const before = new Set(mine(s, kind).map((e) => e.id)); // suporta N prédios do mesmo tipo
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const novo = mine(s, kind).find((e) => !before.has(e.id));
    if (novo) return { ent: novo };
    const p = me(s);
    if (awaitingOf(p, kind) === kind) {
      const placed = await placeKind(s, kind, anchor, before);
      if (placed) return { ent: placed };
      continue;
    }
    if (p && !queueBusy(p, kind)) {
      const n0 = denies(s).length;
      send(s, { t: "build", kind });
      await sleep(600);
      const d = denies(s);
      const last = d.length > n0 ? d[d.length - 1] : null;
      if (last && !/insufficient funds|construction in progress/i.test(last)) return { err: last };
      if (last) await sleep(3000); // espera um depósito p/ tentar de novo
      continue;
    }
    await sleep(700);
  }
  return { err: `timeout (bq=${me(s)?.bq?.[0]?.kind ?? "-"} awaiting=${me(s)?.awaiting ?? "-"} cr=${me(s)?.credits})` };
}

async function trainUnit(s, unit, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const n0 = denies(s).length;
    send(s, { t: "train", unit });
    await sleep(600);
    const d = denies(s);
    const last = d.length > n0 ? d[d.length - 1] : null;
    if (!last) return null; // aceito
    if (!/insufficient funds|queue busy|queue full/i.test(last)) return last;
    await sleep(2500);
  }
  return "timeout";
}

// ---------- jogo: Bob (host, slot 0) x Carl (slot 1) ----------
const b = conn("Bob", "tt-B");
const c = conn("Carl", "tt-C");
await sleep(900);
send(c, { t: "ready", ready: true });
await sleep(400);
send(b, { t: "start" });
ok(await waitFor(() => lastSnap(b)?.ents?.length > 0, 10000), "partida 1v1 iniciada");
ok(b.slot === 0 && c.slot === 1, `slots atribuídos (Bob=${b.slot} Carl=${c.slot})`);

// ---------- 1) gates de construção (fila vazia, só conyard no mapa) ----------
let d;
d = await expectDeny(b, { t: "build", kind: "radar" });
ok(d && /need a barracks/i.test(d), "radar antes de quartel negado", d);
d = await expectDeny(b, { t: "build", kind: "factory2" });
ok(d && /can't build that/i.test(d), "factory2 não entra na fila de construção", d);
d = await expectDeny(b, { t: "build", kind: "arc" });
ok(d && /need a radar/i.test(d), "arc antes de radar negado", d);
d = await expectDeny(b, { t: "train", unit: "heavy" });
ok(d && /need a factory/i.test(d), "heavy antes de fábrica negado", d);

// ---------- Carl: prédio-alvo da captura + unidades fora do trajeto ----------
const cyC = mine(c, "conyard")[0];
const cr = await buildAndPlace(c, "power", [cyC.x - 4, cyC.y], 60000);
ok(!!cr.ent, "Carl: power plant (alvo do engenheiro) colocada", cr.err);
const capTarget = cr.ent ?? cyC;
const cUnits = (lastSnap(c)?.ents ?? []).filter((e) => e.o === c.slot && UNITK.has(e.k));
const cInf = cUnits.find((u) => u.k === "infantry");
// infantaria caminha p/ o flanco NE da base do Bob (vira alvo do arc depois);
// o resto do exército do Carl vai p/ um canto fora da diagonal (não intercepta o engenheiro)
if (cInf) send(c, { t: "order", ids: [cInf.id], kind: "move", x: 30, y: 12 });
const rest = cUnits.filter((u) => u !== cInf).map((u) => u.id);
if (rest.length) send(c, { t: "order", ids: rest, kind: "move", x: 38, y: 58 });

// ---------- Bob: economia primeiro (power -> refinery -> barracks) ----------
const cy = mine(b, "conyard")[0];
const anchorS = [cy.x + 2, cy.y + 6]; // prefere ao sul da conyard
const anchorN = [cy.x + 6, cy.y - 1]; // prefere a leste/norte (perto da infantaria do Carl)

let r = await buildAndPlace(b, "power", anchorS);
ok(!!r.ent, "power plant do Bob colocada", r.err);
r = await buildAndPlace(b, "refinery", anchorS);
ok(!!r.ent, "refinaria colocada", r.err);
ok(await waitFor(() => mine(b, "harvester")[0], 20000), "colheitadeira da refinaria apareceu");
r = await buildAndPlace(b, "barracks", anchorS);
ok(!!r.ent, "quartel colocado", r.err);

// engenheiro sai cedo: a caminhada até a base do Carl (~55 tiles) roda em background
const tr = await trainUnit(b, "engineer");
ok(tr === null, "engenheiro aceito na fila do quartel", tr);
const eng = await waitFor(() => mine(b, "engineer")[0], 30000);
ok(!!eng, "engenheiro treinado");
if (eng && capTarget)
  send(b, { t: "order", ids: [eng.id], kind: "attack", x: capTarget.x, y: capTarget.y, target: capTarget.id });
ok(!!(eng && capTarget), `ordem de captura emitida (alvo ${capTarget?.k} #${capTarget?.id})`);

// ---------- 2) upgrade da fábrica ----------
r = await buildAndPlace(b, "radar", anchorS);
ok(!!r.ent, "radar colocado", r.err);
r = await buildAndPlace(b, "factory", anchorS);
ok(!!r.ent, "fábrica colocada", r.err);
const fac = r.ent;

// upgrade antes do techlab: precisa de créditos p/ cair no "need a techlab", não em "insufficient funds"
ok(await waitFor(() => me(b)?.credits >= 1600, 120000), `créditos p/ tentar upgrade (${me(b)?.credits})`);
d = await expectDeny(b, { t: "upgrade", id: fac.id });
ok(d && /need a techlab/i.test(d), "upgrade antes do techlab negado", d);
d = await expectDeny(b, { t: "train", unit: "heavy" });
ok(d && /need a factory2/i.test(d), "heavy antes do upgrade negado", d);

r = await buildAndPlace(b, "power", anchorS); // headroom p/ techlab (-60) sem brownout
ok(!!r.ent, "power plant 2 colocada", r.err);
r = await buildAndPlace(b, "techlab", anchorS);
ok(!!r.ent, "techlab colocado", r.err);

ok(await waitFor(() => me(b)?.credits >= 1600, 120000), `créditos p/ o upgrade (${me(b)?.credits})`);
const nd0 = denies(b).length;
send(b, { t: "upgrade", id: fac.id });
const f2 = await waitFor(() => ent(b, fac.id)?.k === "factory2", 20000);
const f2ent = ent(b, fac.id);
ok(!!f2 && denies(b).length === nd0, "upgrade converteu factory -> factory2", `k=${f2ent?.k} denies=${denies(b).at(-1) ?? "none"}`);
ok(f2ent?.mhp === 1300, `factory2 com hp novo (mhp=${f2ent?.mhp})`);
d = await expectDeny(b, { t: "upgrade", id: fac.id });
ok(d && /can't upgrade/i.test(d), "segundo upgrade negado", d);

await waitFor(() => me(b)?.credits >= 1200, 90000);
const th = await trainUnit(b, "heavy");
ok(th === null && me(b)?.queues?.factory?.some((i) => i.unit === "heavy"), "heavy aceito na fila pós-upgrade", th ?? JSON.stringify(me(b)?.queues?.factory));
ok(await waitFor(() => mine(b, "heavy")[0], 30000), "heavy spawnou");

// ---------- 4) purifier: depósito paga 1.25x ----------
r = await buildAndPlace(b, "power", anchorS); // power 3: arc(-40)+purifier(-25)+depot(-30)
ok(!!r.ent, "power plant 3 colocada", r.err);
r = await buildAndPlace(b, "purifier", anchorS);
ok(!!r.ent, "purificador colocado", r.err);
const purTick = lastSnap(b)?.tick ?? 0;
// procura um depósito POSTERIOR ao purifier: cargo>0 num snap, 0 no seguinte
const deposit = await waitFor(() => {
  for (let i = 1; i < b.snaps.length; i++) {
    const s1 = b.snaps[i - 1], s2 = b.snaps[i];
    if (s2.tick <= purTick) continue;
    for (const e1 of s1.ents) {
      if (e1.o !== b.slot || e1.k !== "harvester" || !(e1.cargo > 0)) continue;
      const e2 = s2.ents.find((e) => e.id === e1.id);
      if (e2 && (e2.cargo ?? 0) === 0)
        return { cargo: e1.cargo, delta: s2.players[b.slot].credits - s1.players[b.slot].credits };
    }
  }
  return null;
}, 120000, 400);
ok(
  !!deposit && deposit.delta > deposit.cargo * 25 * 1.1 && deposit.delta <= deposit.cargo * 25 * 1.3,
  `depósito com bônus do purifier (cargo=${deposit?.cargo} -> +${deposit?.delta} cr; sem bônus seria ${deposit ? deposit.cargo * 25 : "?"})`,
  deposit ? JSON.stringify(deposit) : "nenhum depósito em 120s"
);

// ---------- 6) arc: coil dispara na infantaria do Carl ----------
r = await buildAndPlace(b, "arc", anchorN);
ok(!!r.ent, "arc colocada", r.err);
if (r.ent) {
  const arc = r.ent;
  const foe = (lastSnap(c)?.ents ?? [])
    .filter((e) => e.o === c.slot && UNITK.has(e.k))
    .sort((p, q) => Math.hypot(p.x - arc.x, p.y - arc.y) - Math.hypot(q.x - arc.x, q.y - arc.y))[0];
  const f0 = foe ? { id: foe.id, hp: foe.hp } : null;
  if (foe) send(c, { t: "order", ids: [foe.id], kind: "attack", x: arc.x, y: arc.y, target: arc.id });
  ok(!!foe, `unidade inimiga ordenada a atacar o arc (#${foe?.id} ${foe?.k})`);
  const zap = await waitFor(
    () => allEvents(c).some((ev) => ev.e === "shot" && Math.hypot(ev.fx - arc.x, ev.fy - arc.y) < 1.2),
    90000,
    500
  );
  ok(!!zap, "arc disparou na unidade inimiga", `shots=${allEvents(c).filter((e) => e.e === "shot").length}`);
  const f1 = f0 ? ent(c, f0.id) : null;
  ok(!f1 || f1.hp < f0.hp, `unidade inimiga ${f1 ? "danificada" : "destruída"} pelo arc`, `hp=${f0?.hp} -> ${f1?.hp ?? "morta"}`);
}

// ---------- 5) depot: constrói e o jogo segue ----------
const tick0 = lastSnap(b)?.tick ?? 0;
r = await buildAndPlace(b, "depot", anchorS);
ok(!!r.ent, "service depot colocado", r.err);
ok(await waitFor(() => lastSnap(b).tick > tick0 + 30, 20000), "sim continua rodando após o depot");

// ---------- 3) captura do engenheiro (o longo prazo que ficou em background) ----------
const capEv = await waitFor(() => allEvents(b).find((ev) => ev.e === "cap" && ev.slot === b.slot), 240000, 800);
ok(!!capEv, `evento "cap" recebido (x=${capEv?.x} y=${capEv?.y})`, `events vistos: ${[...new Set(allEvents(b).map((e) => e.e))].join(",")}`);
const capNow = capTarget ? ent(b, capTarget.id) : null;
ok(capNow && capNow.o === b.slot, `prédio inimigo virou meu (o=${capNow?.o} k=${capNow?.k})`, `o=${capNow?.o}`);
ok(eng ? !ent(b, eng.id) : true, "engenheiro consumido na captura");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
