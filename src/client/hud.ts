import type { LobbyPlayer, PlayerState, EntSnap } from "../shared/protocol";
import {
  BUILDINGS,
  UNITS,
  BUILD_ORDER,
  TRAIN_ORDER,
  BUILDING_NAMES,
  UPGRADE_COST,
  PLAYER_COLORS,
  BuildingKind,
  UnitKind,
  MAP_W,
  MAP_H,
} from "../shared/gamedefs";
import { el, fmtCost, isBuildingKind } from "./util";
import { Renderer } from "./render";

const TOOLTIPS: Record<string, string> = {
  conyard: "Construction Yard — the heart of your base.",
  power: "Reactor Plant — +100 power. Your base slows without it.",
  refinery: "Ore Refinery — unlocks harvesters; deploys one free.",
  barracks: "Barracks — trains infantry: Riflemen, Sappers, Rocket Troopers.",
  radar: "Radar Uplink — reveals the minimap; unlocks rockets, siege, arc coils.",
  factory: "War Factory — builds vehicles. Upgrade it to unlock heavies.",
  techlab: "Tech Lab — unlocks the Ore Purifier and War Factory upgrades.",
  turret: "Sentry Turret — automated base defense. Needs power.",
  arc: "Arc Coil — heavy zap defense in every direction. Needs power + radar.",
  purifier: "Ore Purifier — +25% on every harvester deposit.",
  depot: "Service Depot — repairs nearby vehicles automatically.",
  infantry: "Rifleman — cheap, fast, good vs infantry.",
  engineer: "Sapper — captures enemy buildings on contact. Unarmed.",
  rocket: "Rocket Trooper — long-range anti-armor infantry. Needs radar.",
  tank: "Battle Tank — armored punch. Crushes infantry.",
  arty: "Siege Launcher — long-range artillery. Fragile. Needs radar.",
  heavy: "Mastodon Tank — twin-cannon monster. Needs War Factory II.",
  spider: "Spider Drone — fast melee scout. Needs War Factory II.",
  harvester: "Ore Harvester — collects ore; a full load is worth $1000.",
};

export class Hud {
  onReady: (r: boolean) => void = () => {};
  onStart: () => void = () => {};
  onRematch: () => void = () => {};
  onAddBot: () => void = () => {};
  onResign: () => void = () => {};
  onChat: (text: string) => void = () => {};
  onBuild: (k: BuildingKind) => void = () => {};
  onBuildCancel: () => void = () => {};
  onPlaceMode: (k: BuildingKind) => void = () => {};
  onTrain: (u: UnitKind) => void = () => {};
  onTrainCancel: (u: UnitKind) => void = () => {};
  onMinimapNav: (x: number, y: number) => void = () => {};
  onMinimapPing: (x: number, y: number) => void = () => {};
  onVerb: (v: "amove" | "stop" | "sell" | "repair") => void = () => {};
  onUpgrade?: (id: number) => void;
  onGroupClick?: (n: number, dbl: boolean) => void;
  onToggleWasd?: () => void;

  private ready = false;
  private icons = new Map<string, string>();
  private buildBtns = new Map<BuildingKind, HTMLButtonElement>();
  private trainBtns = new Map<UnitKind, HTMLButtonElement>();
  private minimap = el<HTMLCanvasElement>("minimap");
  private mmCtx = this.minimap.getContext("2d")!;
  private mmLast = 0;
  private pinged: { x: number; y: number; t: number } | null = null;
  private chatLines: string[] = [];
  private selSig = "";
  private lastGroupClick = { n: -1, t: 0 };

  constructor() {
    el("ready-btn").addEventListener("click", () => {
      this.ready = !this.ready;
      el("ready-btn").textContent = this.ready ? "UNREADY" : "READY";
      el("ready-btn").classList.toggle("on", this.ready);
      this.onReady(this.ready);
    });
    el("start-btn").addEventListener("click", () => this.onStart());
    el("rematch-btn").addEventListener("click", () => this.onRematch());
    el("addbot-btn")?.addEventListener("click", () => this.onAddBot());
    el("resign-btn")?.addEventListener("click", () => this.onResign());
    const copy = () => {
      navigator.clipboard?.writeText(location.href).catch(() => {});
      this.toast("invite link copied", true);
    };
    el("copy-link").addEventListener("click", copy);
    el("copy-link2").addEventListener("click", copy);
    el("help-btn")?.addEventListener("click", () => el("help").classList.toggle("hidden"));
    el("help-close")?.addEventListener("click", () => el("help").classList.add("hidden"));
    el("wasd-btn")?.addEventListener("click", () => this.onToggleWasd?.());

    for (const v of ["amove", "stop", "sell", "repair"] as const) {
      el(`verb-${v}`)?.addEventListener("click", () => this.onVerb(v));
    }

    // Chat input
    const chatInput = el<HTMLInputElement>("chat-input");
    chatInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        if (chatInput.value.trim()) {
          this.onChat(chatInput.value.trim().slice(0, 120));
          chatInput.value = "";
        }
        chatInput.blur();
      } else if (e.key === "Escape") {
        chatInput.blur();
      }
    });
    el("chat-box").addEventListener("click", () => chatInput.focus());

    // Build sidebar buttons once
    const bl = el("build-list");
    for (const kind of BUILD_ORDER) {
      const d = BUILDINGS[kind];
      const b = document.createElement("button");
      b.className = "sbtn";
      b.dataset.kind = kind;
      b.title = this.buildTooltip(kind);
      b.innerHTML = `<span class="icon" data-kind="${kind}"></span><span class="sname">${BUILDING_NAMES[kind]}</span><span class="cost">$${d.cost}</span><span class="btime">${d.buildTicks / 10}s</span><span class="prog"></span>`;
      b.addEventListener("click", () => this.clickBuild(kind));
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.onBuildCancel();
      });
      bl.appendChild(b);
      this.buildBtns.set(kind, b);
    }

    const tl = el("train-list");
    for (const { unit, label: l } of TRAIN_ORDER) {
      const d = UNITS[unit];
      const b = document.createElement("button");
      b.className = "sbtn";
      b.dataset.unit = unit;
      b.title = `${TOOLTIPS[unit] ?? l} · ${d.buildTicks / 10}s to train`;
      b.innerHTML = `<span class="icon" data-kind="${unit}"></span><span class="sname">${l}</span><span class="cost">$${d.cost}</span><span class="btime">${d.buildTicks / 10}s</span><span class="prog"></span>`;
      b.addEventListener("click", () => this.onTrain(unit));
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.onTrainCancel(unit);
      });
      tl.appendChild(b);
      this.trainBtns.set(unit, b);
    }

    // Minimap navigation & pings
    const nav = (e: PointerEvent) => {
      const r = this.minimap.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * MAP_W;
      const y = ((e.clientY - r.top) / r.height) * MAP_H;
      this.onMinimapNav(x, y);
    };
    let mmDrag = false;
    this.minimap.addEventListener("pointerdown", (e) => {
      if (e.button === 2) {
        const r = this.minimap.getBoundingClientRect();
        this.onMinimapPing(((e.clientX - r.left) / r.width) * MAP_W, ((e.clientY - r.top) / r.height) * MAP_H);
        return;
      }
      mmDrag = true;
      nav(e);
    });
    this.minimap.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("pointermove", (e) => mmDrag && nav(e));
    window.addEventListener("pointerup", () => (mmDrag = false));
  }

  private buildTooltip(kind: BuildingKind, missing?: BuildingKind[]) {
    const d = BUILDINGS[kind];
    const base = `${TOOLTIPS[kind] ?? BUILDING_NAMES[kind]} · ${d.buildTicks / 10}s to build`;
    if (missing?.length) return `${base} · Requires: ${missing.map((m) => BUILDING_NAMES[m]).join(", ")}`;
    return base;
  }

  focusChat() {
    el<HTMLInputElement>("chat-input").focus();
  }

  setWasdLabel(on: boolean) {
    const b = document.getElementById("wasd-btn");
    if (b) {
      b.textContent = on ? "KEYS: WASD" : "KEYS: RTS";
      b.classList.toggle("on", on);
      b.title = on
        ? "WASD pans camera · F = Attack-Move · X = Stop (click to switch to Classic RTS)"
        : "Arrows pan camera · A = Attack-Move · S = Stop · X = Scatter (click to switch to WASD pan)";
    }
    const va = document.querySelector("#verb-amove kbd");
    const vs = document.querySelector("#verb-stop kbd");
    if (va) va.textContent = on ? "F" : "A";
    if (vs) vs.textContent = on ? "X" : "S";
  }

  setIcons(icons: Map<string, string>) {
    this.icons = icons;
    for (const [k, url] of icons) {
      for (const span of document.querySelectorAll<HTMLElement>(`.icon[data-kind="${k}"]`)) {
        span.style.backgroundImage = `url(${url})`;
        span.classList.add("has-icon");
      }
    }
    this.selSig = ""; // refresh selection icons if already open
  }

  private iconFor(kind: string) {
    return this.icons.get(kind);
  }

  private clickBuild(kind: BuildingKind) {
    const b = this.buildBtns.get(kind)!;
    if (b.classList.contains("ready")) this.onPlaceMode(kind);
    else if (!b.dataset.busy) this.onBuild(kind);
  }

  setRoom(code: string) {
    el("room-code").textContent = "ROOM " + code;
    el("lobby-room").textContent = code;
  }

  setStatus(s: string) {
    el("conn-status").textContent = s;
  }

  showLobby(players: LobbyPlayer[], you: string) {
    el("lobby").classList.remove("hidden");
    el("endscreen").classList.add("hidden");
    const me = players.find((p) => p.id === you);
    this.ready = !!me?.ready;
    el("ready-btn").textContent = this.ready ? "UNREADY" : "READY";
    el("ready-btn").classList.toggle("on", this.ready);
    const list = el("player-list");
    list.innerHTML = "";
    for (const p of players) {
      const li = document.createElement("li");
      if (p.eliminated) li.classList.add("dead");
      const color = p.slot >= 0 ? PLAYER_COLORS[p.slot] : "#8a97a5";
      li.innerHTML = `<span class="cdot" style="background:${color}"></span><span class="pname" style="color:${color}">${esc(p.name)}${p.id === you ? " (you)" : ""}</span>
        <span class="meta">${p.spectator ? "spectating" : p.host ? "◆ host" : ""} ${p.connected ? (p.ready ? "· ready" : "") : "· offline"}${p.eliminated ? " · out" : ""}</span>`;
      list.appendChild(li);
    }
    const isHost = !!me?.host;
    el("start-btn").classList.toggle("hidden", !isHost);
    el("addbot-btn")?.classList.toggle("hidden", !isHost);
    el("lobby-hint").textContent = isHost
      ? "you are host — add a bot or wait for friends, then start (2-4 players)"
      : "waiting for host to start…";
  }

  hideLobby() {
    el("lobby").classList.add("hidden");
    for (const id of ["topbar", "sidebar", "minimap", "selinfo", "verbbar", "chat-box", "groupbar"]) {
      document.getElementById(id)?.classList.remove("hidden");
    }
  }

  showEnd(text: string) {
    el("end-text").textContent = text;
    el("endscreen").classList.remove("hidden");
  }

  hideEnd() {
    el("endscreen").classList.add("hidden");
  }

  toast(msg: string, info = false) {
    const t = document.createElement("div");
    t.className = "toast" + (info ? " info" : "");
    t.textContent = msg;
    el("toasts").appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  chat(name: string, color: string, text: string) {
    this.chatLines.push(`${name}: ${text}`);
    const box = el("chat-lines");
    const d = document.createElement("div");
    d.innerHTML = `<b style="color:${color}">${esc(name)}</b> ${esc(text)}`;
    box.appendChild(d);
    while (box.children.length > 6) box.firstChild?.remove();
    box.classList.add("flash");
    setTimeout(() => box.classList.remove("flash"), 300);
  }

  ping(x: number, y: number) {
    this.pinged = { x, y, t: performance.now() };
  }

  updateTop(state: PlayerState | null, spectatorStates?: Record<number, PlayerState>) {
    const cr = el("credits");
    const pw = el("power");
    const wrap = el("spec-board");
    if (spectatorStates) {
      cr.textContent = "";
      pw.innerHTML = "";
      pw.classList.remove("low");
      wrap.innerHTML = Object.entries(spectatorStates)
        .map(([s, p]) => `<span style="color:${PLAYER_COLORS[+s] ?? "#888"}">${fmtCost(p.credits)}</span>`)
        .join(" · ");
      return;
    }
    wrap.innerHTML = "";
    if (!state) return;
    cr.textContent = fmtCost(state.credits);
    const pct = state.pwrHave > 0 ? Math.min(1, state.pwrUse / state.pwrHave) : state.pwrUse > 0 ? 1 : 0;
    pw.innerHTML = `PWR <b>${state.pwrHave - state.pwrUse >= 0 ? "+" : ""}${state.pwrHave - state.pwrUse}</b><i style="width:${Math.round(pct * 34)}px"></i>`;
    pw.classList.toggle("low", state.lowPower);
  }

  updateSidebar(state: PlayerState | null, has: (k: string) => boolean) {
    for (const [kind, b] of this.buildBtns) {
      const d = BUILDINGS[kind];
      b.classList.remove("ready", "locked");
      delete b.dataset.busy;
      b.disabled = false;
      const prog = b.querySelector<HTMLElement>(".prog")!;
      const bt = b.querySelector<HTMLElement>(".btime")!;
      prog.style.width = "0%";
      bt.textContent = `${d.buildTicks / 10}s`;
      if (!state || !has("conyard")) {
        b.disabled = true;
        continue;
      }
      if (state.awaiting === kind) {
        b.classList.add("ready");
        bt.textContent = "RDY";
        continue;
      }
      if (state.bq?.kind === kind) {
        b.dataset.busy = "1";
        prog.style.width = `${(1 - state.bq.left / state.bq.total) * 100}%`;
        bt.textContent = `${(state.bq.left / 10).toFixed(1)}s`;
        continue;
      }
      const missing = d.requires?.filter((r) => !has(r)) ?? [];
      b.title = this.buildTooltip(kind, missing);
      if (missing.length) {
        b.classList.add("locked");
        b.disabled = true;
        continue;
      }
      if (state.bq || state.awaiting || state.credits < d.cost) b.disabled = true;
    }

    for (const [unit, b] of this.trainBtns) {
      const d = UNITS[unit];
      const prog = b.querySelector<HTMLElement>(".prog")!;
      const bt = b.querySelector<HTMLElement>(".btime")!;
      prog.style.width = "0%";
      bt.textContent = `${d.buildTicks / 10}s`;
      b.querySelector(".qcount")?.remove();
      b.classList.remove("locked");
      b.disabled = true;
      if (!state) continue;
      const cat = d.trainsAt;
      if (!has(cat) || (d.requires && !has(d.requires))) {
        b.classList.add("locked");
        continue;
      }
      const q = state.queues[cat];
      if (q && q.unit === unit) {
        prog.style.width = `${(1 - q.left / q.total) * 100}%`;
        bt.textContent = `${(q.left / 10).toFixed(1)}s`;
        const c = document.createElement("span");
        c.className = "qcount";
        c.textContent = "×" + q.count;
        b.appendChild(c);
      } else if (q) continue;
      b.disabled = state.credits < d.cost;
    }
  }

  updateGroups(groups: Map<number, Set<number>>, tracked: Renderer["tracked"], mySlot: number) {
    const bar = document.getElementById("groupbar");
    if (!bar) return;
    bar.innerHTML = "";
    const nums = [...groups.keys()].sort((a, b) => a - b);
    for (const n of nums) {
      const ids = groups.get(n)!;
      let count = 0;
      for (const id of ids) if (tracked.get(id)?.last.o === mySlot) count++;
      if (!count) continue;
      const b = document.createElement("button");
      b.className = "gbtn";
      b.title = `Group ${n} (${count}) — click to select, double-click to center`;
      b.innerHTML = `<kbd>${n}</kbd><span>${count}</span>`;
      b.addEventListener("click", () => {
        const now = performance.now();
        const dbl = this.lastGroupClick.n === n && now - this.lastGroupClick.t < 420;
        this.lastGroupClick = { n, t: now };
        this.onGroupClick?.(n, dbl);
      });
      bar.appendChild(b);
    }
  }

  updateSelInfo(
    sel: Set<number>,
    tracked: Renderer["tracked"],
    mySlot: number,
    state?: PlayerState | null,
    has?: (k: string) => boolean,
  ) {
    const box = el("selinfo");
    if (!sel.size) {
      if (this.selSig !== "") {
        this.selSig = "";
        box.innerHTML = "";
      }
      return;
    }
    const counts = new Map<string, number>();
    let hpSum = 0,
      hpMax = 0;
    let singleId: number | null = null;
    let singleKind: string | null = null;
    for (const id of sel) {
      const t = tracked.get(id);
      if (!t) continue;
      counts.set(t.last.k, (counts.get(t.last.k) ?? 0) + 1);
      hpSum += t.last.hp;
      hpMax += t.last.mhp;
      if (sel.size === 1 && t.last.o === mySlot) {
        singleId = id;
        singleKind = t.last.k;
      }
    }
    if (!hpMax) {
      if (this.selSig !== "") {
        this.selSig = "";
        box.innerHTML = "";
      }
      return;
    }

    const hasTech = has ? has("techlab") : true;
    const canAfford = state ? state.credits >= UPGRADE_COST : true;
    const sig =
      [...counts].map(([k, n]) => `${k}:${n}`).join(",") +
      `|${singleId ?? ""}|${singleKind ?? ""}|${hasTech ? 1 : 0}|${canAfford ? 1 : 0}`;

    // Only rebuild DOM structure when selection or upgrade readiness actually changes
    // (prevents 5Hz innerHTML destruction from eating clicks on the UPGRADE button)
    if (sig !== this.selSig) {
      this.selSig = sig;
      const parts = [...counts]
        .map(([k, n]) => {
          const ic = this.iconFor(k);
          const img = ic ? `<img class="si-icon" src="${ic}">` : "";
          return `${img}<span>${n}× ${label(k as BuildingKind | UnitKind as never)}</span>`;
        })
        .join("");
      box.innerHTML = `<div class="si-row">${parts}</div><div class="si-hp"><i></i><span></span></div>`;

      if (singleId !== null && singleKind === "factory") {
        const b = document.createElement("button");
        b.className = "sbtn si-upgrade";
        b.disabled = !hasTech || !canAfford;
        b.textContent = !hasTech
          ? `UPGRADE → MKII (NEEDS TECH LAB)`
          : `UPGRADE → ${BUILDING_NAMES.factory2.toUpperCase()} (${fmtCost(UPGRADE_COST)})`;
        b.addEventListener("click", () => this.onUpgrade?.(singleId!));
        box.appendChild(b);
      } else if (singleId !== null && singleKind === "factory2") {
        const d = document.createElement("div");
        d.className = "si-mk2";
        d.textContent = "★ MKII";
        box.appendChild(d);
      }
    }

    // Always update HP bar smoothly in place
    const bar = box.querySelector<HTMLElement>(".si-hp i");
    const txt = box.querySelector<HTMLElement>(".si-hp span");
    if (bar) bar.style.width = `${Math.round((hpSum / hpMax) * 100)}%`;
    if (txt) txt.textContent = `HP ${Math.round(hpSum)} / ${hpMax}`;
  }

  drawMinimap(
    r: Renderer,
    oreCells: Set<number>,
    camX: number,
    camY: number,
    camH: number,
    mySlot: number,
    hasRadar: boolean,
  ) {
    const now = performance.now();
    if (now - this.mmLast < 160) return;
    this.mmLast = now;
    const ctx = this.mmCtx;
    const s = this.minimap.width / MAP_W;
    ctx.fillStyle = "#080e14";
    ctx.fillRect(0, 0, 160, 160);
    if (mySlot >= 0 && !hasRadar) {
      ctx.fillStyle = "#5f7485";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("NO RADAR UPLINK", 80, 80);
      return;
    }
    ctx.fillStyle = "#b58b2e";
    for (const key of oreCells.keys()) {
      ctx.fillRect((key % MAP_W) * s, ((key / MAP_W) | 0) * s, Math.max(1.6, s), Math.max(1.6, s));
    }
    for (const t of r.tracked.values()) {
      const e: EntSnap = t.last;
      if (e.o !== mySlot && mySlot >= 0 && !r.isVisible(e.id)) continue;
      ctx.fillStyle = e.o >= 0 ? PLAYER_COLORS[e.o] : "#5a6a77";
      const sz = isBuildingKind(e.k) ? Math.max(3, BUILDINGS[e.k].w * s) : 2.5;
      ctx.fillRect(e.x * s - sz / 2, e.y * s - sz / 2, sz, sz);
    }
    if (this.pinged) {
      const age = now - this.pinged.t;
      if (age < 2400) {
        const rr = 4 + (age % 600) / 45;
        ctx.strokeStyle = `rgba(255,70,60,${1 - age / 2400})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(this.pinged.x * s, this.pinged.y * s, rr, 0, Math.PI * 2);
        ctx.stroke();
      } else this.pinged = null;
    }
    const vw = camH * 1.4,
      vh = camH * 1.1;
    ctx.strokeStyle = "rgba(140,220,255,0.65)";
    ctx.lineWidth = 1;
    ctx.strokeRect((camX - vw / 2) * s, (camY - vh / 2) * s, vw * s, vh * s);
  }
}

function label(k: BuildingKind | UnitKind): string {
  if (isBuildingKind(k)) return BUILDING_NAMES[k];
  return TRAIN_ORDER.find((u) => u.unit === k)?.label ?? k;
}
export { label };

function esc(s: string) {
  return s.replace(/[<>&"]/g, "");
}
