import {
  MAP_W,
  MAP_H,
  BUILDINGS,
  UNITS,
  BuildingKind,
  UnitKind,
  EntKind,
  START_CREDITS,
  ORE_VALUE,
  HARVEST_TICKS_PER_UNIT,
  ORE_REGEN_TICKS,
  ORE_CELL_MAX,
  ORE_SPREAD_CHANCE,
  UPGRADE_COST,
  PURIFIER_BONUS,
  DEPOT_RANGE,
  DEPOT_HEAL,
  CAPTURE_RANGE,
  SPAWNS,
} from "../shared/gamedefs";
import type { OrderKind, EntSnap, PlayerState, ProdQueue, GameEvent, WeaponFx } from "../shared/protocol";
import { findPath, nearestPassable } from "./path";

const MAX_WAYPOINTS = 16;

const hasOwn = (o: object, k: unknown): boolean =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);

interface Order {
  kind: OrderKind;
  x: number;
  y: number;
  target?: number;
}

export interface Ent {
  id: number;
  o: number; // owner slot
  k: EntKind;
  x: number;
  y: number;
  hp: number;
  mhp: number;
  d: number; // facing radians
  order: Order | null;
  orderQueue: Order[];
  path: { x: number; y: number }[] | null;
  cd: number;
  cargo: number;
  hstate: "toOre" | "mining" | "toRef" | null;
  oreIdx: number;
  repath: number;
  agro: number | null; // enemy id an amove unit is currently chasing (for resume-after-kill)
  holdUntil: number; // suppress harvester auto-resume until this tick (stop/explicit orders)
}

export interface P {
  slot: number;
  credits: number;
  awaiting: BuildingKind | null;
  bq: { kind: BuildingKind; left: number; total: number } | null;
  queues: { barracks?: ProdQueue; factory?: ProdQueue };
  eliminated: boolean;
  pwrHave: number;
  pwrUse: number;
  lowPower: boolean;
}

const idx = (x: number, y: number) => y * MAP_W + x;
const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const isBuilding = (k: EntKind): k is BuildingKind => k in BUILDINGS;
const entityDist = (a: Ent, b: Ent) => {
  if (!isBuilding(b.k)) return dist(a.x, a.y, b.x, b.y);
  const bd = BUILDINGS[b.k];
  return Math.hypot(
    Math.max(0, Math.abs(a.x - b.x) - bd.w / 2),
    Math.max(0, Math.abs(a.y - b.y) - bd.h / 2),
  );
};
const weaponFxOf = (k: EntKind): WeaponFx => {
  if (k === "tank" || k === "heavy") return "cannon";
  if (k === "rocket") return "rocket";
  if (k === "arty") return "arty";
  if (k === "arc") return "arc";
  if (k === "spider") return "melee";
  return "bullet";
};
const weaponOf = (e: Ent) =>
  isBuilding(e.k) ? { range: BUILDINGS[e.k].range ?? 0, dmg: BUILDINGS[e.k].dmg ?? 0, rof: BUILDINGS[e.k].rof ?? 0 } : { range: UNITS[e.k as UnitKind].range, dmg: UNITS[e.k as UnitKind].dmg, rof: UNITS[e.k as UnitKind].rof };

export class World {
  tick = 0;
  winner: number | null = null;
  ents = new Map<number, Ent>();
  players = new Map<number, P>(); // keyed by slot
  events: GameEvent[] = [];

  private block = new Uint8Array(MAP_W * MAP_H); // 1 = building footprint
  private bld = new Int32Array(MAP_W * MAP_H).fill(-1); // ent id per tile
  private ore = new Int16Array(MAP_W * MAP_H); // remaining per tile
  private nextId = 1;
  private lastAlert = new Map<number, number>(); // slot -> tick of last under-attack alert

  constructor(slots: number[]) {
    this.genOre(slots);
    for (const slot of slots) {
      const s = SPAWNS[slot];
      this.players.set(slot, {
        slot,
        credits: START_CREDITS,
        awaiting: null,
        bq: null,
        queues: {},
        eliminated: false,
        pwrHave: 0,
        pwrUse: 0,
        lowPower: false,
      });
      this.placeBuilding(slot, "conyard", s.x, s.y);
      // starting squad
      const spot = (dx: number, dy: number) =>
        nearestPassable(s.x + 1 + dx, s.y + 3 + dy, (x, y) => this.passable(x, y), 10) ?? { x: s.x, y: s.y + 4 };
      const t1 = spot(0, 0);
      const t2 = spot(2, 0);
      this.spawnUnit(slot, "tank", t1.x, t1.y);
      this.spawnUnit(slot, "tank", t2.x, t2.y);
      for (let i = 0; i < 3; i++) {
        const p = spot(i, 1);
        this.spawnUnit(slot, "infantry", p.x, p.y);
      }
      this.recomputePower(slot);
    }
  }

  private genOre(slots: number[]) {
    const blob = (cx: number, cy: number, r: number) => {
      for (let y = Math.max(0, cy - r); y <= Math.min(MAP_H - 1, cy + r); y++)
        for (let x = Math.max(0, cx - r); x <= Math.min(MAP_W - 1, cx + r); x++) {
          const d = dist(x, y, cx, cy);
          if (d <= r && Math.random() > d / (r + 1)) this.ore[idx(x, y)] = 25 + ((Math.random() * 35) | 0);
        }
    };
    for (const slot of slots) {
      const s = SPAWNS[slot];
      const cx = s.x < MAP_W / 2 ? s.x + 8 : s.x - 6;
      const cy = s.y < MAP_H / 2 ? s.y + 9 : s.y - 7;
      blob(cx, cy, 3);
    }
    blob(MAP_W / 2, MAP_H / 2, 4); // contested center field
  }

  oreSnapshot(): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let y = 0; y < MAP_H; y++)
      for (let x = 0; x < MAP_W; x++) if (this.ore[idx(x, y)] > 0) out.push([x, y, this.ore[idx(x, y)]]);
    return out;
  }

  passable = (x: number, y: number) => inBounds(x, y) && this.block[idx(x, y)] === 0;

  footprint(kind: BuildingKind, tx: number, ty: number) {
    const d = BUILDINGS[kind];
    return { tx, ty, w: d.w, h: d.h };
  }
  footprintCenter(kind: BuildingKind, tx: number, ty: number) {
    const d = BUILDINGS[kind];
    return { x: tx + d.w / 2, y: ty + d.h / 2 };
  }

  private placeBuilding(slot: number, kind: BuildingKind, tx: number, ty: number) {
    const d = BUILDINGS[kind];
    const c = this.footprintCenter(kind, tx, ty);
    const e: Ent = {
      id: this.nextId++,
      o: slot,
      k: kind,
      x: c.x,
      y: c.y,
      hp: d.hp,
      mhp: d.hp,
      d: Math.PI / 2,
      order: null,
      orderQueue: [],
      path: null,
      cd: 0,
      cargo: 0,
      hstate: null,
      oreIdx: -1,
      repath: 0,
      agro: null,
      holdUntil: 0,
    };
    this.ents.set(e.id, e);
    for (let y = ty; y < ty + d.h; y++)
      for (let x = tx; x < tx + d.w; x++) {
        this.block[idx(x, y)] = 1;
        this.bld[idx(x, y)] = e.id;
      }
    return e;
  }

  private spawnUnit(slot: number, kind: UnitKind, x: number, y: number) {
    const d = UNITS[kind];
    const e: Ent = {
      id: this.nextId++,
      o: slot,
      k: kind,
      x: x + 0.5,
      y: y + 0.5,
      hp: d.hp,
      mhp: d.hp,
      d: Math.PI / 2,
      order: null,
      orderQueue: [],
      path: null,
      cd: 0,
      cargo: 0,
      hstate: null,
      oreIdx: -1,
      repath: 0,
      agro: null,
      holdUntil: 0,
    };
    this.ents.set(e.id, e);
    this.events.push({ e: "spawn", id: e.id });
    return e;
  }

  private spawnNearBuilding(slot: number, kind: UnitKind, b: Ent) {
    const def = BUILDINGS[b.k as BuildingKind];
    const bx = b.x - def.w / 2,
      by = b.y - def.h / 2;
    const occupied = (x: number, y: number) => {
      for (const u of this.ents.values())
        if (!isBuilding(u.k) && Math.floor(u.x) === x && Math.floor(u.y) === y) return true;
      return false;
    };
    // first empty passable tile on an expanding ring below the building
    for (let r = 1; r <= 6; r++) {
      for (let dy = -1; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const x = bx + (def.w >> 1) + dx,
            y = by + def.h + dy;
          if (this.passable(x, y) && !occupied(x, y)) return this.spawnUnit(slot, kind, x, y);
        }
    }
    const spot = nearestPassable(bx + (def.w >> 1), by + def.h + 1, (x, y) => this.passable(x, y) && !occupied(x, y), 12);
    if (spot) return this.spawnUnit(slot, kind, spot.x, spot.y);
    return null;
  }

  // ---------- commands ----------

  canPlace(slot: number, kind: BuildingKind, tx: number, ty: number): string | null {
    const d = BUILDINGS[kind];
    if (tx < 0 || ty < 0 || tx + d.w > MAP_W || ty + d.h > MAP_H) return "off map";
    for (let y = ty; y < ty + d.h; y++)
      for (let x = tx; x < tx + d.w; x++) {
        const i = idx(x, y);
        if (this.block[i]) return "blocked";
        if (this.ore[i] > 0) return "can't build on ore";
      }
    // no units standing inside the footprint
    for (const u of this.ents.values()) {
      if (isBuilding(u.k)) continue;
      const ux = Math.floor(u.x),
        uy = Math.floor(u.y);
      if (ux >= tx && ux < tx + d.w && uy >= ty && uy < ty + d.h) return "units in the way";
    }
    // adjacency: some own building within 2 tiles of the new footprint
    for (const b of this.ents.values()) {
      if (b.o !== slot || !isBuilding(b.k)) continue;
      const bd = BUILDINGS[b.k];
      const bx = b.x - bd.w / 2,
        by = b.y - bd.h / 2;
      const gapX = Math.max(bx - (tx + d.w), tx - (bx + bd.w));
      const gapY = Math.max(by - (ty + d.h), ty - (by + bd.h));
      if (Math.max(gapX, gapY) <= 2) return null;
    }
    return "must build next to your base";
  }

  cmdOrder(slot: number, ids: number[], kind: OrderKind, x: number, y: number, target?: number, queue = false): string | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return "bad order";
    if (kind !== "move" && kind !== "amove" && kind !== "attack" && kind !== "harvest") return "bad order";
    if (!inBounds(Math.floor(x), Math.floor(y))) return "off map";
    const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
    const rows = Math.max(1, Math.ceil(ids.length / cols));
    let n = 0;
    for (const [i, id] of ids.entries()) {
      const e = this.ents.get(id);
      if (!e || e.o !== slot || isBuilding(e.k)) continue;
      // unarmed units can't take attack orders (a harvester told to attack would just chase forever)
      if ((kind === "attack" || kind === "amove") && weaponOf(e).dmg <= 0 && e.k !== "engineer") continue;
      // spread group destinations on a dynamic grid so large groups don't stack on one tile
      const ox = kind === "attack" || kind === "harvest" ? 0 : ((i % cols) - (cols - 1) / 2) * 1.15;
      const oy = kind === "attack" || kind === "harvest" ? 0 : (Math.floor(i / cols) - (rows - 1) / 2) * 1.15;
      const gx = Math.max(0.5, Math.min(MAP_W - 0.5, x + ox));
      const gy = Math.max(0.5, Math.min(MAP_H - 0.5, y + oy));

      let ord: Order | null = null;
      let hstate: Ent["hstate"] = null;
      let oreIdx = -1;

      if (kind === "harvest" && e.k !== "harvester") {
        // escorting units in a mixed group follow along as a plain move
        ord = { kind: "move", x: gx, y: gy };
      } else if (kind === "attack") {
        const tgt = Number.isFinite(target) ? this.ents.get(target as number) : null;
        if (!tgt || tgt.o === slot) continue;
        ord = { kind, x: tgt.x, y: tgt.y, target };
      } else if (kind === "harvest") {
        const t = Math.floor(x) + Math.floor(y) * MAP_W;
        if (this.ore[t] > 0) {
          ord = { kind, x, y };
          hstate = "toOre";
          oreIdx = t;
        } else {
          // right-clicked own refinery with cargo
          const bid = this.bld[idx(Math.floor(x), Math.floor(y))];
          const b = bid >= 0 ? this.ents.get(bid) : null;
          if (!b || b.o !== slot || b.k !== "refinery") continue;
          ord = { kind, x, y };
          hstate = "toRef";
        }
      } else {
        ord = { kind, x: gx, y: gy };
      }

      if (!ord) continue;
      if (queue && e.order) {
        if (e.orderQueue.length < MAX_WAYPOINTS) e.orderQueue.push(ord);
        n++;
        continue;
      }
      e.orderQueue = [];
      e.order = ord;
      e.agro = null;
      if (e.k === "harvester") {
        if (ord.kind === "harvest") {
          e.hstate = hstate;
          if (oreIdx >= 0) e.oreIdx = oreIdx;
        } else {
          // explicit order beats hauling — pause auto-harvest so the move is honored
          e.hstate = null;
          e.holdUntil = this.tick + 150;
        }
      }
      e.path = null;
      e.repath = 0;
      n++;
    }
    return n ? null : "nothing to order";
  }

  private advanceOrder(e: Ent) {
    e.order = null;
    e.path = null;
    e.repath = 0;
    e.agro = null;
    while (e.orderQueue.length) {
      const next = e.orderQueue.shift()!;
      if (next.kind === "attack" && next.target != null) {
        const tgt = this.ents.get(next.target);
        if (!tgt || tgt.o === e.o) continue;
      }
      if (next.kind === "harvest" && e.k === "harvester") {
        const t = Math.floor(next.x) + Math.floor(next.y) * MAP_W;
        if (this.ore[t] > 0) {
          e.hstate = "toOre";
          e.oreIdx = t;
        } else {
          const bid = this.bld[idx(Math.floor(next.x), Math.floor(next.y))];
          const b = bid >= 0 ? this.ents.get(bid) : null;
          if (!b || b.o !== e.o || b.k !== "refinery") continue;
          e.hstate = "toRef";
        }
      } else if (e.k === "harvester") {
        e.hstate = null;
        e.holdUntil = this.tick + 150;
      }
      e.order = next;
      return;
    }
  }

  cmdStop(slot: number, ids: number[]) {
    for (const id of ids) {
      const e = this.ents.get(id);
      if (!e || e.o !== slot || isBuilding(e.k)) continue;
      e.order = null;
      e.orderQueue = [];
      e.path = null;
      e.hstate = null;
      e.agro = null;
      e.holdUntil = this.tick + 150; // don't auto-resume hauling right after a stop
    }
  }

  cmdBuild(slot: number, kind: BuildingKind): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    if (p.bq || p.awaiting) return "construction in progress";
    if (!hasOwn(BUILDINGS, kind)) return "unknown building";
    const d = BUILDINGS[kind];
    if (d.noBuild) return "can't build that";
    if (d.requires) for (const r of d.requires) if (!this.hasBuilding(slot, r)) return `need a ${r}`;
    if (p.credits < d.cost) return "insufficient funds";
    if (!this.hasBuilding(slot, "conyard")) return "need a construction yard";
    p.credits -= d.cost;
    p.bq = { kind, left: d.buildTicks, total: d.buildTicks };
    return null;
  }

  cmdBuildCancel(slot: number) {
    const p = this.players.get(slot);
    if (!p) return;
    if (p.bq) {
      p.credits += BUILDINGS[p.bq.kind].cost;
      p.bq = null;
    } else if (p.awaiting) {
      p.credits += BUILDINGS[p.awaiting].cost;
      p.awaiting = null;
    }
  }

  cmdSell(slot: number, id: number): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    const e = this.ents.get(id);
    if (!e || e.o !== slot || !isBuilding(e.k)) return "can't sell that";
    // factory2's cost is 0 (it arrives via upgrade) — value it at factory+upgrade
    const basis = e.k === "factory2" ? BUILDINGS.factory.cost + UPGRADE_COST : BUILDINGS[e.k].cost;
    p.credits += Math.floor(basis * 0.5);
    this.destroy(e);
    return null;
  }

  cmdRepair(slot: number, id: number): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    const e = this.ents.get(id);
    if (!e || e.o !== slot || !isBuilding(e.k)) return "can't repair that";
    if (e.hp >= e.mhp) return "already at full health";
    const basis = e.k === "factory2" ? BUILDINGS.factory.cost + UPGRADE_COST : BUILDINGS[e.k].cost;
    const cost = Math.ceil(basis * 0.25);
    if (p.credits < cost) return "insufficient funds";
    p.credits -= cost;
    e.hp = e.mhp;
    return null;
  }

  cmdUpgrade(slot: number, id: number): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    const e = this.ents.get(id);
    if (!e || e.o !== slot || e.k !== "factory") return "can't upgrade that";
    if (p.credits < UPGRADE_COST) return "insufficient funds";
    if (!this.hasBuilding(slot, "techlab")) return "need a techlab";
    p.credits -= UPGRADE_COST;
    e.k = "factory2";
    e.mhp = BUILDINGS.factory2.hp;
    e.hp = Math.min(e.mhp, e.hp + 400);
    this.recomputePower(slot);
    return null;
  }

  cmdResign(slot: number) {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return;
    for (const e of [...this.ents.values()]) if (e.o === slot) this.destroy(e);
    // checkEnd picks up the elimination next tick
  }

  cmdPlace(slot: number, tx: number, ty: number): string | null {
    const p = this.players.get(slot);
    if (!p || !p.awaiting) return "nothing to place";
    const kind = p.awaiting;
    const err = this.canPlace(slot, kind, tx, ty);
    if (err) return err;
    p.awaiting = null;
    const b = this.placeBuilding(slot, kind, tx, ty);
    this.recomputePower(slot);
    if (kind === "refinery") this.spawnNearBuilding(slot, "harvester", b);
    return null;
  }

  cmdTrain(slot: number, unit: UnitKind): string | null {
    const p = this.players.get(slot);
    if (!p || p.eliminated) return "dead";
    if (!hasOwn(UNITS, unit)) return "unknown unit";
    const d = UNITS[unit];
    if (!this.hasBuilding(slot, d.trainsAt)) return `need a ${d.trainsAt}`;
    if (d.requires && !this.hasBuilding(slot, d.requires)) return `need a ${d.requires}`;
    if (p.credits < d.cost) return "insufficient funds";
    const q = p.queues[d.trainsAt];
    if (q && q.unit !== unit) return "queue busy";
    if (q && q.count >= 9) return "queue full";
    p.credits -= d.cost;
    if (q) q.count++;
    else p.queues[d.trainsAt] = { unit, left: d.buildTicks, total: d.buildTicks, count: 1 };
    return null;
  }

  cmdTrainCancel(slot: number, unit: UnitKind): void {
    const p = this.players.get(slot);
    if (!p || !hasOwn(UNITS, unit)) return;
    const d = UNITS[unit];
    const q = p.queues[d.trainsAt];
    if (!q || q.unit !== unit) return;
    p.credits += d.cost;
    if (--q.count === 0) delete p.queues[d.trainsAt];
  }

  // engineer takes over an enemy building once it reaches the footprint edge.
  // distance is measured to the edge, not the center, or 3x3 buildings
  // (conyard/factory/techlab) would stay unreachable.
  private tryCapture(e: Ent, tgt: Ent): boolean {
    if (e.k !== "engineer" || !isBuilding(tgt.k) || tgt.o === e.o) return false;
    const bd = BUILDINGS[tgt.k];
    const edgeDist = Math.hypot(
      Math.max(0, Math.abs(e.x - tgt.x) - bd.w / 2),
      Math.max(0, Math.abs(e.y - tgt.y) - bd.h / 2)
    );
    if (edgeDist > CAPTURE_RANGE) return false;
    const prev = tgt.o;
    tgt.o = e.o;
    this.recomputePower(prev);
    this.recomputePower(e.o);
    this.events.push({ e: "cap", x: tgt.x, y: tgt.y, slot: e.o });
    this.destroy(e);
    return true;
  }

  private hasBuilding(slot: number, kind: BuildingKind) {
    for (const e of this.ents.values())
      if (e.o === slot && (e.k === kind || (kind === "factory" && e.k === "factory2"))) return true;
    return false;
  }

  private buildingsOf(slot: number, kind: BuildingKind) {
    const out: Ent[] = [];
    for (const e of this.ents.values())
      if (e.o === slot && (e.k === kind || (kind === "factory" && e.k === "factory2"))) out.push(e);
    return out;
  }

  private recomputePower(slot: number) {
    const p = this.players.get(slot);
    if (!p) return;
    let have = 0,
      use = 0;
    for (const e of this.ents.values()) {
      if (e.o !== slot || !isBuilding(e.k)) continue;
      const pw = BUILDINGS[e.k].power;
      if (pw > 0) have += pw;
      else use -= pw;
    }
    p.pwrHave = have;
    p.pwrUse = use;
    p.lowPower = use > have;
  }

  // ---------- tick ----------

  step() {
    this.tick++;
    this.tickProduction();
    for (const e of this.ents.values()) this.tickEnt(e);
    this.separate();
    if (this.tick % 10 === 0) this.tickDepots();
    if (this.tick % ORE_REGEN_TICKS === 0) this.regenOre();
    this.checkEnd();
  }

  private tickDepots() {
    for (const d of this.ents.values()) {
      if (d.k !== "depot") continue;
      for (const e of this.ents.values())
        if (e.o === d.o && !isBuilding(e.k) && e.hp < e.mhp && dist(e.x, e.y, d.x, d.y) <= DEPOT_RANGE)
          e.hp = Math.min(e.mhp, e.hp + DEPOT_HEAL);
    }
  }

  // ore fields slowly regrow and creep outward, like the real game
  private regenOre() {
    const changed: [number, number, number][] = [];
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const t = idx(x, y);
        const amt = this.ore[t];
        if (amt > 0) {
          if (amt < ORE_CELL_MAX) {
            this.ore[t] = amt + 1;
            changed.push([x, y, amt + 1]);
          }
          continue;
        }
        if (this.bld[t] >= 0 || !this.passable(x, y)) continue;
        let adj = 0;
        if (x + 1 < MAP_W && this.ore[t + 1] > 0) adj++;
        if (x > 0 && this.ore[t - 1] > 0) adj++;
        if (y + 1 < MAP_H && this.ore[t + MAP_W] > 0) adj++;
        if (y > 0 && this.ore[t - MAP_W] > 0) adj++;
        if (adj >= 2 && Math.random() < ORE_SPREAD_CHANCE) {
          this.ore[t] = 1;
          changed.push([x, y, 1]);
        }
      }
    }
    if (changed.length) this.events.push({ e: "ore", cells: changed });
  }

  private tickProduction() {
    for (const p of this.players.values()) {
      const rate = p.lowPower ? 0.5 : 1;
      if (p.bq) {
        p.bq.left -= rate;
        if (p.bq.left <= 0) {
          p.awaiting = p.bq.kind;
          p.bq = null;
        }
      }
      for (const cat of ["barracks", "factory"] as const) {
        const q = p.queues[cat];
        if (!q) continue;
        q.left -= rate;
        if (q.left <= 0) {
          // losing the tech prerequisite mid-queue halts production with a refund
          const ud = UNITS[q.unit];
          if (ud.requires && !this.hasBuilding(p.slot, ud.requires)) {
            p.credits += ud.cost * q.count;
            delete p.queues[cat];
            continue;
          }
          const b = this.buildingsOf(p.slot, cat)[0];
          const spawned = b ? this.spawnNearBuilding(p.slot, q.unit, b) : null;
          if (!spawned) {
            // nowhere to deploy — refund instead of eating the unit
            p.credits += UNITS[q.unit].cost;
          }
          if (--q.count <= 0) delete p.queues[cat];
          else q.left = q.total;
        }
      }
    }
  }

  private tickEnt(e: Ent) {
    if (e.cd > 0) e.cd--;
    if (e.k === "harvester") {
      this.tickHarvester(e);
      return;
    }
    const w = weaponOf(e);
    const o = e.order;
    if (o?.kind === "attack" && o.target != null) {
      const tgt = this.ents.get(o.target);
      if (!tgt || tgt.o === e.o) {
        this.advanceOrder(e);
      } else if (e.k === "engineer" && isBuilding(tgt.k)) {
        // engineers don't shoot — they walk in and take the building
        if (!this.tryCapture(e, tgt)) {
          if (e.repath-- <= 0) {
            e.repath = 12;
            this.pathNear(e, tgt);
          }
          this.stepAlong(e);
        }
      } else {
        const d = entityDist(e, tgt);
        if (d <= w.range) {
          this.face(e, tgt.x, tgt.y);
          this.tryFire(e, tgt);
        } else {
          if (e.repath-- <= 0) {
            e.repath = 12;
            this.pathNear(e, tgt);
          }
          this.stepAlong(e);
        }
      }
    } else if (o?.kind === "amove") {
      const enemy = this.nearestEnemy(e, Math.max(w.range + 2, e.k === "engineer" ? 5 : 3));
      if (enemy) {
        if (e.k === "engineer" && isBuilding(enemy.k)) {
          // attack-moving engineers capture buildings they reach
          if (!this.tryCapture(e, enemy)) {
            if (e.repath-- <= 0) {
              e.repath = 12;
              this.pathNear(e, enemy);
              e.agro = enemy.id;
            }
            this.stepAlong(e);
          }
        } else {
          const d = entityDist(e, enemy);
          if (d <= w.range) {
            this.face(e, enemy.x, enemy.y);
            this.tryFire(e, enemy);
          } else {
            if (e.repath-- <= 0) {
              e.repath = 12;
              this.pathNear(e, enemy);
              e.agro = enemy.id;
            }
            this.stepAlong(e);
          }
        }
      } else {
        if (e.agro != null) {
          // the enemy we were chasing died — resume marching to the real destination
          e.agro = null;
          e.path = null;
        }
        if (this.stepAlong(e)) this.advanceOrder(e);
      }
    } else if (o?.kind === "move") {
      if (this.stepAlong(e)) this.advanceOrder(e);
    } else if (w.range > 0) {
      // idle: hold position, auto-fire within weapon range (no pursuit)
      if (!isBuilding(e.k) || ((BUILDINGS[e.k].range ?? 0) > 0 && !this.players.get(e.o)?.lowPower)) {
        const enemy = this.nearestEnemy(e, w.range);
        if (enemy) {
          this.face(e, enemy.x, enemy.y);
          this.tryFire(e, enemy);
        }
      }
    }
  }

  private tickHarvester(e: Ent) {
    const o = e.order;
    // explicit move orders run through the generic mover — tickEnt returns
    // early for harvesters, so this is the only place they get stepped
    if (o?.kind === "move") {
      if (this.stepAlong(e)) this.advanceOrder(e);
      return;
    }
    if (o?.kind === "harvest" && e.hstate) {
      if (e.hstate === "toOre") {
        const arrived = this.stepAlong(e, 0.45); // land on the ore tile itself
        if (arrived) e.hstate = "mining";
      } else if (e.hstate === "toRef") {
        const ref = this.nearestRefinery(e);
        if (!ref) {
          e.order = null;
          e.hstate = null;
          return;
        }
        const dockR = Math.max(BUILDINGS.refinery.w, BUILDINGS.refinery.h) / 2 + 0.9;
        const arrived = this.stepAlong(e, 0.4) || dist(e.x, e.y, ref.x, ref.y) <= dockR;
        if (arrived) {
          const p = this.players.get(e.o);
          if (p)
            p.credits += Math.floor(e.cargo * ORE_VALUE * (this.hasBuilding(e.o, "purifier") ? 1 + PURIFIER_BONUS : 1));
          e.cargo = 0;
          e.hstate = "toOre";
          e.order = null;
          // resume at last ore tile
          if (e.oreIdx >= 0 && this.ore[e.oreIdx] > 0) {
            e.path = findPath(e.x | 0, e.y | 0, e.oreIdx % MAP_W, (e.oreIdx / MAP_W) | 0, this.passable);
            e.order = { kind: "harvest", x: e.oreIdx % MAP_W, y: (e.oreIdx / MAP_W) | 0 };
          }
        }
      }
    }

    if (e.hstate === "mining") {
      const ox = e.oreIdx % MAP_W,
        oy = (e.oreIdx / MAP_W) | 0;
      const cap = UNITS.harvester.capacity!;
      if (Math.floor(e.x) !== ox || Math.floor(e.y) !== oy) {
        // drifted off the ore tile — drive back onto it
        e.hstate = "toOre";
        e.order = { kind: "harvest", x: ox, y: oy };
        e.path = null;
        return;
      }
      const t = e.oreIdx;
      if (this.ore[t] > 0 && e.cargo < cap) {
        if (this.tick % HARVEST_TICKS_PER_UNIT === 0) {
          this.ore[t]--;
          e.cargo++;
          this.events.push({ e: "ore", cells: [[ox, oy, this.ore[t]]] });
          if (this.ore[t] === 0) {
            const next = this.nearestOre(e.x | 0, e.y | 0);
            if (next >= 0) {
              e.oreIdx = next;
              e.hstate = "toOre";
              e.order = { kind: "harvest", x: next % MAP_W, y: (next / MAP_W) | 0 };
              e.path = null;
            } else e.hstate = e.cargo > 0 ? "toRef" : null;
          }
          if (e.cargo >= cap) {
            e.hstate = "toRef";
            e.order = { kind: "harvest", x: e.x, y: e.y };
          }
        }
      } else if (e.cargo >= cap) {
        e.hstate = "toRef";
      } else {
        const next = this.nearestOre(e.x | 0, e.y | 0);
        if (next >= 0) {
          e.oreIdx = next;
          e.hstate = "toOre";
          e.order = { kind: "harvest", x: next % MAP_W, y: (next / MAP_W) | 0 };
          e.path = null;
        } else e.hstate = e.cargo > 0 ? "toRef" : null;
      }
      return;
    }

    // toOre without a path yet
    if (e.hstate === "toOre" && !e.path?.length) {
      const goal = this.ore[e.oreIdx] > 0 ? { x: e.oreIdx % MAP_W, y: (e.oreIdx / MAP_W) | 0 } : null;
      if (!goal) {
        const n = this.nearestOre(e.x | 0, e.y | 0);
        if (n < 0) {
          e.hstate = e.cargo > 0 ? "toRef" : null;
          e.order = null;
          return;
        }
        e.oreIdx = n;
        e.order = { kind: "harvest", x: n % MAP_W, y: (n / MAP_W) | 0 };
      }
      const g = goal ?? { x: e.oreIdx % MAP_W, y: (e.oreIdx / MAP_W) | 0 };
      e.path = findPath(e.x | 0, e.y | 0, g.x, g.y, this.passable);
      e.order = { kind: "harvest", x: g.x, y: g.y };
      if (!e.path) {
        e.hstate = null;
        e.order = null;
      }
      return;
    }

    if (e.hstate === "toRef" && !e.path?.length) {
      const ref = this.nearestRefinery(e);
      if (!ref) {
        e.hstate = null;
        e.order = null;
        return;
      }
      this.pathNear(e, ref, Math.max(BUILDINGS.refinery.w, BUILDINGS.refinery.h) / 2 + 0.5);
      e.order = { kind: "harvest", x: ref.x, y: ref.y };
      return;
    }

    // idle harvester: auto-start harvesting nearby ore, or return cargo —
    // but stay put while holdUntil suppresses auto-resume (stop/explicit orders)
    if (!e.order && !e.hstate && this.tick >= e.holdUntil) {
      if (e.cargo > 0) {
        if (this.nearestRefinery(e)) e.hstate = "toRef"; // no refinery → wait with cargo
      } else {
        const n = this.nearestOre(e.x | 0, e.y | 0);
        if (n >= 0) {
          e.oreIdx = n;
          e.hstate = "toOre";
          e.order = { kind: "harvest", x: n % MAP_W, y: (n / MAP_W) | 0 };
        }
      }
    }
  }

  private nearestRefinery(e: Ent) {
    let best: Ent | null = null,
      bd = Infinity;
    for (const b of this.ents.values()) {
      if (b.o !== e.o || b.k !== "refinery") continue;
      const d = dist(e.x, e.y, b.x, b.y);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  private nearestOre(x: number, y: number, maxR = 999) {
    let best = -1,
      bd = Infinity;
    // scan outward rings — cheaper than full scan, plenty for 64x64
    for (let r = 0; r < Math.min(maxR, Math.max(MAP_W, MAP_H)); r++) {
      let found = false;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x + dx,
            ny = y + dy;
          if (!inBounds(nx, ny)) continue;
          const i = idx(nx, ny);
          if (this.ore[i] > 0) {
            const d = dx * dx + dy * dy;
            if (d < bd) {
              bd = d;
              best = i;
            }
            found = true;
          }
        }
      if (found) return best;
    }
    return best;
  }

  private nearestEnemy(e: Ent, range: number) {
    let best: Ent | null = null,
      bd = range;
    for (const t of this.ents.values()) {
      if (t.o === e.o || t.o < 0) continue;
      const tp = this.players.get(t.o);
      if (!tp || tp.eliminated) continue;
      const d = entityDist(e, t);
      if (d <= bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  private face(e: Ent, x: number, y: number) {
    e.d = Math.atan2(y - e.y, x - e.x);
  }

  private tryFire(e: Ent, tgt: Ent) {
    if (e.cd > 0) return;
    const w = weaponOf(e);
    if (w.range <= 0) return;
    if (isBuilding(e.k) && this.players.get(e.o)?.lowPower) return; // powered defenses offline
    e.cd = w.rof;
    tgt.hp -= w.dmg;
    this.events.push({ e: "shot", fx: e.x, fy: e.y, tx: tgt.x, ty: tgt.y, w: weaponFxOf(e.k), src: e.id });
    // rate-limited "under attack" alert for the victim
    if (tgt.o >= 0) {
      const last = this.lastAlert.get(tgt.o) ?? -999;
      if (this.tick - last >= 80) {
        this.lastAlert.set(tgt.o, this.tick);
        this.events.push({ e: "alert", slot: tgt.o, x: tgt.x, y: tgt.y });
      }
    }
    if (tgt.hp <= 0) this.destroy(tgt);
  }

  private destroy(e: Ent) {
    if (!this.ents.has(e.id)) return;
    const wasBuilding = isBuilding(e.k);
    if (wasBuilding) {
      const d = BUILDINGS[e.k as BuildingKind];
      const bx = Math.round(e.x - d.w / 2),
        by = Math.round(e.y - d.h / 2);
      for (let y = by; y < by + d.h; y++)
        for (let x = bx; x < bx + d.w; x++) {
          this.block[idx(x, y)] = 0;
          this.bld[idx(x, y)] = -1;
        }
    }
    this.ents.delete(e.id);
    if (wasBuilding) this.recomputePower(e.o); // after removal so the corpse doesn't count
    const size = wasBuilding ? Math.max(BUILDINGS[e.k as BuildingKind].w, BUILDINGS[e.k as BuildingKind].h) : 1;
    this.events.push({ e: "boom", x: e.x, y: e.y, r: size });
  }

  private pathNear(e: Ent, tgt: Ent, r = 0) {
    // path to the tile nearest the target's edge for buildings
    const gx = tgt.x | 0,
      gy = tgt.y | 0;
    const spot = nearestPassable(gx, gy, this.passable, 10) ?? { x: gx, y: gy };
    e.path = findPath(e.x | 0, e.y | 0, spot.x, spot.y, this.passable);
    if (!e.path?.length && r > 0) e.path = [];
  }

  // advance along path; returns true when arrived (within `arriveR` of final goal).
  // null path = "needs compute"; empty path = "gave up" (avoids re-running A* every tick)
  private stepAlong(e: Ent, arriveR = 0.35): boolean {
    if (e.path === null) {
      const o = e.order;
      if (!o) {
        e.path = [];
        return true;
      }
      const goal = nearestPassable(Math.floor(o.x), Math.floor(o.y), this.passable, 12);
      e.path = goal ? (findPath(e.x | 0, e.y | 0, goal.x, goal.y, this.passable) ?? []) : [];
    }
    if (!e.path.length) return true;
    const wp = e.path[0];
    const wx = wp.x + 0.5,
      wy = wp.y + 0.5;
    const speed = UNITS[e.k as UnitKind].speed;
    const d = dist(e.x, e.y, wx, wy);
    const last = e.path.length === 1;
    if (d <= (last ? arriveR : 0.25)) {
      e.path.shift();
      return e.path.length === 0;
    }
    if (!this.passable(wp.x, wp.y)) {
      // path invalidated by new construction — repath once
      const o = e.order;
      if (!o) return true;
      const goal = nearestPassable(Math.floor(o.x), Math.floor(o.y), this.passable, 12);
      e.path = goal ? (findPath(e.x | 0, e.y | 0, goal.x, goal.y, this.passable) ?? []) : [];
      return e.path.length === 0;
    }
    const step = Math.min(speed, d);
    e.x += ((wx - e.x) / d) * step;
    e.y += ((wy - e.y) / d) * step;
    e.d = Math.atan2(wy - e.y, wx - e.x);
    return false;
  }

  private separate() {
    // soft separation between units so they don't stack; tanks crush enemy infantry on contact
    const units = [...this.ents.values()].filter((e) => !isBuilding(e.k));
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      if (!this.ents.has(a.id)) continue;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j];
        if (!this.ents.has(b.id)) continue;
        let dx = b.x - a.x,
          dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 === 0) {
          // perfectly stacked — push apart on a deterministic per-pair angle
          const ang = ((a.id * 7 + b.id * 13) % 8) * (Math.PI / 4);
          dx = Math.cos(ang) * 0.01;
          dy = Math.sin(ang) * 0.01;
          d2 = dx * dx + dy * dy;
        }
        if (d2 > 0.56) continue;
        const crushable = (k: EntKind) => k === "infantry" || k === "rocket" || k === "engineer";
        if ((a.k === "tank" || a.k === "heavy") && crushable(b.k) && a.o !== b.o) {
          this.destroy(b);
          continue;
        }
        if ((b.k === "tank" || b.k === "heavy") && crushable(a.k) && a.o !== b.o) {
          this.destroy(a);
          break;
        }
        const d = Math.sqrt(d2) || 0.01;
        const push = ((0.75 - d) / d) * 0.5 * 0.35;
        const px = dx * push,
          py = dy * push;
        if (this.passable((a.x - px) | 0, (a.y - py) | 0)) {
          a.x -= px;
          a.y -= py;
        }
        if (this.passable((b.x + px) | 0, (b.y + py) | 0)) {
          b.x += px;
          b.y += py;
        }
      }
    }
  }

  private checkEnd() {
    if (this.winner !== null) return;
    if (this.players.size < 2) return; // solo games run until a rematch
    for (const p of this.players.values()) {
      if (p.eliminated) continue;
      let alive = false;
      for (const e of this.ents.values())
        if (e.o === p.slot) {
          alive = true;
          break;
        }
      if (!alive) {
        p.eliminated = true;
        this.events.push({ e: "elim", slot: p.slot });
      }
    }
    const aliveSlots = [...this.players.values()].filter((p) => !p.eliminated).map((p) => p.slot);
    if (aliveSlots.length <= 1) this.winner = aliveSlots[0] ?? null;
  }

  snapshot(): { ents: EntSnap[]; players: Record<number, PlayerState>; events: GameEvent[] } {
    const ents: EntSnap[] = [];
    for (const e of this.ents.values()) {
      const s: EntSnap = {
        id: e.id,
        o: e.o,
        k: e.k,
        x: Math.round(e.x * 100) / 100,
        y: Math.round(e.y * 100) / 100,
        hp: Math.max(0, Math.round(e.hp)),
        mhp: e.mhp,
        d: Math.round(e.d * 10),
      };
      if (e.k === "harvester") s.cargo = e.cargo;
      if (!isBuilding(e.k) && (e.order || e.orderQueue.length)) {
        const wp: [number, number, OrderKind][] = [];
        const pushOrd = (ord: Order) => {
          let ox = ord.x,
            oy = ord.y;
          if (ord.kind === "attack" && ord.target != null) {
            const t = this.ents.get(ord.target);
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
    const players: Record<number, PlayerState> = {};
    for (const p of this.players.values()) {
      players[p.slot] = {
        slot: p.slot,
        credits: Math.floor(p.credits),
        pwrHave: p.pwrHave,
        pwrUse: p.pwrUse,
        lowPower: p.lowPower,
        eliminated: p.eliminated,
        awaiting: p.awaiting,
        bq: p.bq ? { ...p.bq } : null,
        queues: { ...p.queues },
      };
    }
    const events = this.events;
    this.events = [];
    return { ents, players, events };
  }
}
