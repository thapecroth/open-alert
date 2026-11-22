import type { LobbyPlayer, PlayerState, EntSnap, CrateSnap, MatchStats } from "../shared/protocol";
import {
  BUILDINGS,
  UNITS,
  BUILD_ORDER,
  TRAIN_ORDER,
  BUILDING_NAMES,
  UPGRADE_COST,
  CAPTURE_RANGE,
  PLAYER_COLORS,
  SPAWNS,
  SW_CHARGE_TICKS,
  RECON_CHARGE_TICKS,
  MAP_LIST,
  BOT_PROFILES,
  DEFAULT_CONFIG,
  getMapLayout,
  BuildingKind,
  UnitKind,
  EntKind,
  MapId,
  BotDiff,
  BotProfile,
  GameConfig,
  MAP_W,
  MAP_H,
} from "../shared/gamedefs";
import { el, fmtCost, isBuildingKind } from "./util";
import { Renderer } from "./render";
import type { FpvTelemetry } from "./fpv";

const TOOLTIPS: Record<string, string> = {
  conyard: "Construction Yard — the heart of your base.",
  power: "Reactor Plant — powers your base; keeps defenses, radar & superweapon online.",
  refinery: "Ore Refinery — unlocks harvesters; deploys one free.",
  barracks: "Barracks — trains infantry: Riflemen, Sappers, Rocket Troopers.",
  radar: "Radar Uplink — reveals the minimap; unlocks rockets, siege, air command & arc coils.",
  factory: "War Factory — builds vehicles. Upgrade it to unlock heavies.",
  airfield: "Air Command — deploys Air Force aircraft that fly over cliffs & water. Needs Radar.",
  shipyard: "Naval Shipyard — builds warships; must be placed on navigable water near your base.",
  techlab: "Tech Lab — unlocks heavy air/sea units, Ore Purifier, Ion Uplink & War Factory II.",
  turret: "Sentry Turret — automated ground & anti-air (AA) base defense. Needs power.",
  arc: "Arc Coil — heavy ground & anti-air (AA) zap defense in every direction. Needs power + radar.",
  purifier: "Ore Purifier — +25% on every harvester deposit.",
  depot: "Service Depot — repairs nearby vehicles automatically.",
  superweapon: "Ion Uplink — charges an Orbital Ion Cannon strike (90s). Needs power. Limit 1.",
  derrick: "Oil Derrick — capture with a Sapper for +$500 bonus & +$25/s income.",
  infantry: "Rifleman — cheap, fast, anti-infantry & light AA.",
  engineer: "Sapper — captures enemy buildings & Oil Derricks on contact. Unarmed.",
  rocket: "Rocket Trooper — long-range anti-armor & anti-air (AA) infantry. Needs radar.",
  tank: "Battle Tank — armored punch. Crushes infantry.",
  arty: "Siege Launcher — long-range splash artillery. Fragile. Needs radar.",
  heavy: "Mastodon Tank — twin-cannon monster. Needs War Factory II.",
  spider: "Spider Drone — fast melee scout. Needs War Factory II.",
  harvester: "Ore Harvester — collects ore; a full load is worth $1000.",
  interceptor: "Valkyrie Jet — supersonic Air Force fighter (Air + Ground, AA).",
  chopper: "Hornet Gunship — agile Air Force gunship (Air + Ground, AA).",
  bomber: "Tempest Bomber — heavy Air Force splash strike bomber vs ground & ships. Needs Tech Lab.",
  zeppelin: "Leviathan Airship — armored Air Force flying dreadnought with massive splash bombs. Needs Tech Lab.",
  gunboat: "Viper Hydrofoil — fast Navy patrol & anti-air (AA) picket craft.",
  destroyer: "Aegis Destroyer — versatile Navy warship with heavy cannons & anti-air (AA) defense.",
  sub: "Kraken Sub — stealth Navy submarine; submerges unseen to launch torpedoes. Needs Radar.",
  dreadnought: "Poseidon Dreadnought — long-range Navy bombardment cruiser with splash cruise missiles. Needs Tech Lab.",
};

const MAP_PREVIEW_PALETTES: Record<MapId, { bg: string; grid: string; cliff: string; cliffEdge: string }> = {
  crossroads: { bg: "#2b3926", grid: "rgba(180,210,160,0.08)", cliff: "#5a6257", cliffEdge: "#768072" }, // Steppe (olive)
  canyon: { bg: "#4a2c20", grid: "rgba(235,175,140,0.08)", cliff: "#82523c", cliffEdge: "#a16a50" }, // Canyon (rust)
  basin: { bg: "#28323c", grid: "rgba(170,200,225,0.08)", cliff: "#576574", cliffEdge: "#748494" }, // Alpine (slate)
  tundra: { bg: "#2e4656", grid: "rgba(210,240,255,0.1)", cliff: "#88b3ca", cliffEdge: "#b0d5e8" }, // Arctic (icy)
  fortress: { bg: "#4d3f2a", grid: "rgba(235,210,160,0.08)", cliff: "#85704f", cliffEdge: "#a38d68" }, // Desert (sandy)
  jungle: { bg: "#1c3828", grid: "rgba(150,225,175,0.08)", cliff: "#3e5e47", cliffEdge: "#567d61" }, // Jungle (emerald)
  islands: { bg: "#2b4a3e", grid: "rgba(165,225,205,0.08)", cliff: "#4a5c58", cliffEdge: "#68807b" }, // Riverland (emerald/water)
  oasis: { bg: "#574323", grid: "rgba(250,215,145,0.09)", cliff: "#947542", cliffEdge: "#b39259" }, // Sahara (golden)
  archipelago: { bg: "#3a5c36", grid: "rgba(185,235,195,0.08)", cliff: "#524942", cliffEdge: "#756a60" }, // Pacific tropical ocean/atoll
  coastline: { bg: "#33424a", grid: "rgba(175,215,235,0.08)", cliff: "#4d5c66", cliffEdge: "#6c7f8c" }, // Stormy slate ocean/shore
};

function fmtBoost(mult: number): string {
  return `×${Number(mult.toFixed(2))}`;
}

const SHORT_BUILDING_NAMES: Record<BuildingKind, string> = {
  conyard: "ConYard",
  power: "Reactor",
  refinery: "Refinery",
  barracks: "Barracks",
  radar: "Radar",
  factory: "War Factory",
  factory2: "Factory II",
  airfield: "Air Command",
  shipyard: "Shipyard",
  techlab: "Tech Lab",
  turret: "Turret",
  arc: "Arc Coil",
  purifier: "Purifier",
  depot: "Depot",
  superweapon: "Ion Uplink",
  derrick: "Oil Derrick",
};

const COMPACT_BUILDING_NAMES: Record<BuildingKind, string> = {
  conyard: "ConYard",
  power: "Reactor",
  refinery: "Refinery",
  barracks: "Barracks",
  radar: "Radar",
  factory: "Factory",
  factory2: "Factory II",
  airfield: "Air Cmd",
  shipyard: "Shipyard",
  techlab: "Tech Lab",
  turret: "Turret",
  arc: "Arc Coil",
  purifier: "Purifier",
  depot: "Depot",
  superweapon: "Ion Uplink",
  derrick: "Derrick",
};

function prereqsOf(k: BuildingKind): BuildingKind[] {
  if (k === "factory2") return ["techlab", "factory"];
  return BUILDINGS[k]?.requires ?? [];
}

/**
 * Resolves the exact ordered list of missing buildings you must construct FIRST
 * (topological order, dependencies before dependents) to satisfy `reqs`.
 */
export function missingPrereqChain(reqs: BuildingKind[], has: (k: string) => boolean): BuildingKind[] {
  const out: BuildingKind[] = [];
  const seen = new Set<BuildingKind>();
  const visit = (k: BuildingKind) => {
    if (seen.has(k) || has(k)) return;
    seen.add(k);
    for (const dep of prereqsOf(k)) visit(dep);
    out.push(k);
  };
  for (const r of reqs) visit(r);
  return out;
}

function formatShortNeed(missing: BuildingKind[]): string {
  if (missing.length === 1) return `Need ${SHORT_BUILDING_NAMES[missing[0]]}`;
  return `Need ${missing.map((k) => COMPACT_BUILDING_NAMES[k]).join(" + ")}`;
}

function formatChainSteps(chain: BuildingKind[]): string[] {
  return chain.map((k) => (k === "factory2" ? "Upgrade War Factory → MKII" : BUILDING_NAMES[k]));
}

export class Hud {
  onReady: (r: boolean) => void = () => {};
  onStart: () => void = () => {};
  onRematch: () => void = () => {};
  onAddBot: (diff: BotDiff, profile: BotProfile) => void = () => {};
  onSetBotConfig: (id: string, diff?: BotDiff, profile?: BotProfile) => void = () => {};
  onKickBot: (id: string) => void = () => {};
  onSetMap: (map: MapId) => void = () => {};
  onSetConfig: (cfg: Partial<GameConfig>) => void = () => {};
  onSetTeam: (team: number, id?: string) => void = () => {};
  onSetName: (name: string) => void = () => {};
  onResign: () => void = () => {};
  onChat: (text: string) => void = () => {};
  onBuild: (k: BuildingKind) => void = () => {};
  onBuildCancel: () => void = () => {};
  onPlaceMode: (k: BuildingKind) => void = () => {};
  onTrain: (u: UnitKind) => void = () => {};
  onTrainCancel: (u: UnitKind) => void = () => {};
  onBuildBlocked?: (msg: string) => void;
  onMinimapNav: (x: number, y: number) => void = () => {};
  onMinimapPing: (x: number, y: number) => void = () => {};
  onMinimapOrder?: (x: number, y: number, shift: boolean) => boolean;
  onSuperweaponClick: () => void = () => {};
  onReconClick: () => void = () => {};
  onVerb: (v: "amove" | "patrol" | "hold" | "stop" | "sell" | "repair") => void = () => {};
  onUpgrade?: (id: number) => void;
  onEnterFpv?: (id: number) => void;
  onExitFpv?: () => void;
  onGroupClick?: (n: number, dbl: boolean) => void;
  onToggleWasd?: () => void;
  onToggleMute?: () => void;
  onToggleMusic?: () => void;

  private ready = false;
  private icons = new Map<string, string>();
  private buildBtns = new Map<BuildingKind, HTMLButtonElement>();
  private trainBtns = new Map<UnitKind, HTMLButtonElement>();
  private trainGroupHeaders = new Map<"land" | "air" | "sea", HTMLElement>();
  private hoveredBtn: HTMLButtonElement | null = null;
  private lastBlockedToast = { msg: "", t: 0 };
  private minimap = el<HTMLCanvasElement>("minimap");
  private mmCtx = this.minimap.getContext("2d")!;
  private mmLast = 0;
  private pinged: { x: number; y: number; t: number } | null = null;
  private chatLines: string[] = [];
  private selSig = "";
  private lastGroupClick = { n: -1, t: 0 };
  private lastSubmittedName = "";
  private displayCredits = 0;
  private targetCredits = 0;
  private creditsInit = false;
  private spectating = false;
  private fpvMode = false;
  private fpvLastKind = "";

  constructor() {
    el("ready-btn").addEventListener("click", () => {
      this.ready = !this.ready;
      el("ready-btn").textContent = this.ready ? "UNREADY" : "READY";
      el("ready-btn").classList.toggle("on", this.ready);
      this.onReady(this.ready);
    });
    el("start-btn").addEventListener("click", () => this.onStart());
    el("rematch-btn").addEventListener("click", () => this.onRematch());
    el("addbot-btn")?.addEventListener("click", () => {
      const diff = ((document.getElementById("bot-diff") as HTMLSelectElement | null)?.value as BotDiff) ?? "normal";
      const profile =
        ((document.getElementById("bot-profile") as HTMLSelectElement | null)?.value as BotProfile) ?? "balanced";
      this.onAddBot(diff, profile);
    });
    (document.getElementById("cfg-credits") as HTMLSelectElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ startCredits: Number((e.target as HTMLSelectElement).value) });
    });
    (document.getElementById("cfg-speed") as HTMLSelectElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ gameSpeed: Number((e.target as HTMLSelectElement).value) });
    });
    (document.getElementById("cfg-sw") as HTMLInputElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ superweapons: (e.target as HTMLInputElement).checked });
    });
    (document.getElementById("cfg-crates") as HTMLInputElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ crates: (e.target as HTMLInputElement).checked });
    });
    (document.getElementById("cfg-derricks") as HTMLInputElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ derricks: (e.target as HTMLInputElement).checked });
    });
    (document.getElementById("cfg-fog") as HTMLInputElement | null)?.addEventListener("change", (e) => {
      this.onSetConfig({ fog: (e.target as HTMLInputElement).checked });
    });
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
    document.getElementById("mute-btn")?.addEventListener("click", () => this.onToggleMute?.());
    document.getElementById("music-btn")?.addEventListener("click", () => this.onToggleMusic?.());
    document.getElementById("sw-hud")?.addEventListener("click", () => this.onSuperweaponClick());
    document.getElementById("recon-hud")?.addEventListener("click", () => this.onReconClick());
    document.getElementById("fpv-exit")?.addEventListener("click", () => this.onExitFpv?.());

    // Lobby callsign input
    const nameInput = document.getElementById("name-input") as HTMLInputElement | null;
    if (nameInput) {
      const commitName = () => {
        const clean = nameInput.value.trim().slice(0, 20);
        if (!clean) {
          nameInput.value = this.lastSubmittedName;
          return;
        }
        nameInput.value = clean;
        if (clean !== this.lastSubmittedName) {
          this.lastSubmittedName = clean;
          localStorage.setItem("oa-name", clean);
          this.onSetName(clean);
        }
      };
      nameInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          commitName();
          nameInput.blur();
        } else if (e.key === "Escape") {
          nameInput.value = this.lastSubmittedName;
          nameInput.blur();
        }
      });
      nameInput.addEventListener("blur", commitName);
    }

    // Lobby map selector populated from MAP_LIST
    const mapSelect = document.getElementById("map-select") as HTMLSelectElement | null;
    if (mapSelect) {
      mapSelect.innerHTML = "";
      for (const m of MAP_LIST) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `${m.name} · ${m.biome}${m.naval ? " ⚓" : ""}`;
        mapSelect.appendChild(opt);
      }
      mapSelect.addEventListener("change", () => {
        const map = mapSelect.value as MapId;
        this.updateMapDesc(map);
        this.onSetMap(map);
      });
      this.updateMapDesc(MAP_LIST[0].id);
    }

    for (const v of ["amove", "patrol", "hold", "stop", "sell", "repair"] as const) {
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
      b.innerHTML = `<span class="icon" data-kind="${kind}"></span><span class="slabel"><span class="sname">${BUILDING_NAMES[kind]}</span><span class="req-tag"></span></span><span class="cost">$${d.cost}</span><span class="btime">${d.buildTicks / 10}s</span><span class="prog"></span>`;
      b.addEventListener("click", () => this.clickBuild(kind));
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.onBuildCancel();
      });
      bl.appendChild(b);
      this.buildBtns.set(kind, b);
    }

    const tl = el("train-list");
    const groupLabels: Record<"land" | "air" | "sea", string> = {
      land: "LAND",
      air: "AIR FORCE",
      sea: "NAVY",
    };
    let curGroup: "land" | "air" | "sea" | null = null;
    for (const { unit, label: l, group } of TRAIN_ORDER) {
      if (group !== curGroup) {
        curGroup = group;
        const sep = document.createElement("div");
        sep.className = "sub-title";
        sep.dataset.group = group;
        sep.textContent = groupLabels[group];
        tl.appendChild(sep);
        this.trainGroupHeaders.set(group, sep);
      }
      const d = UNITS[unit];
      const b = document.createElement("button");
      b.className = "sbtn";
      b.dataset.unit = unit;
      b.title = `${TOOLTIPS[unit] ?? l} · ${d.buildTicks / 10}s to train · Shift+click = ×5`;
      b.innerHTML = `<span class="icon" data-kind="${unit}"></span><span class="slabel"><span class="sname">${l}</span><span class="req-tag"></span></span><span class="cost">$${d.cost}</span><span class="btime">${d.buildTicks / 10}s</span><span class="prog"></span>`;
      b.addEventListener("click", (e) => {
        const count = e.shiftKey ? 5 : 1;
        for (let i = 0; i < count; i++) this.onTrain(unit);
      });
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.onTrainCancel(unit);
      });
      tl.appendChild(b);
      this.trainBtns.set(unit, b);
    }

    // Sidebar tech-chain inspector + click-on-locked feedback (works on disabled buttons too!)
    const sidebar = el("sidebar");
    const inSideInfo = (x: number, y: number) => {
      const info = document.getElementById("side-info");
      if (!info || info.classList.contains("hidden")) return false;
      const ir = info.getBoundingClientRect();
      return x >= ir.left && x <= ir.right && y >= ir.top && y <= ir.bottom;
    };
    sidebar.addEventListener("pointermove", (e) => {
      if (inSideInfo(e.clientX, e.clientY)) return;
      const btn = this.findSidebarBtnAt(e.clientX, e.clientY);
      if (btn) this.showSideInfo(btn);
      else this.hideSideInfo();
    });
    sidebar.addEventListener("pointerleave", () => this.hideSideInfo());
    sidebar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || inSideInfo(e.clientX, e.clientY)) return;
      const btn = this.findSidebarBtnAt(e.clientX, e.clientY);
      if (!btn || !btn.disabled) return;
      this.showSideInfo(btn);
      const reason = btn.dataset.reason;
      if (!reason) return;
      const now = performance.now();
      if (this.lastBlockedToast.msg !== reason || now - this.lastBlockedToast.t > 280) {
        this.lastBlockedToast = { msg: reason, t: now };
        this.toast(reason);
        this.onBuildBlocked?.(reason);
      }
    });

    // Minimap navigation, orders & pings
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
        const x = Math.max(0.5, Math.min(MAP_W - 0.5, ((e.clientX - r.left) / r.width) * MAP_W));
        const y = Math.max(0.5, Math.min(MAP_H - 0.5, ((e.clientY - r.top) / r.height) * MAP_H));
        if (!e.altKey && this.onMinimapOrder?.(x, y, e.shiftKey)) return;
        this.onMinimapPing(x, y);
        return;
      }
      mmDrag = true;
      nav(e);
    });
    this.minimap.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("pointermove", (e) => mmDrag && nav(e));
    window.addEventListener("pointerup", () => (mmDrag = false));
  }

  private updateMapDesc(mapId: MapId) {
    const d = document.getElementById("map-desc");
    if (d) {
      const info = MAP_LIST.find((m) => m.id === mapId);
      d.textContent = info ? info.desc : "";
    }
    this.drawMapPreview(mapId);
  }

  drawMapPreview(mapId: MapId) {
    const canvas = document.getElementById("map-preview") as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const s = w / MAP_W;
    const pal = MAP_PREVIEW_PALETTES[mapId] ?? MAP_PREVIEW_PALETTES.crossroads;
    const layout = getMapLayout(mapId);

    // Biome-tinted terrain background
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);

    // Navigable ocean / river water tiles with subtle wave glints
    const cs = Math.ceil(s);
    if (layout.water.length) {
      ctx.fillStyle = "#19587a";
      for (let i = 0; i < layout.water.length; i++) {
        const [wx, wy] = layout.water[i];
        ctx.fillRect(wx * s, wy * s, cs, cs);
      }
      ctx.fillStyle = "rgba(130, 222, 255, 0.3)";
      for (let i = 0; i < layout.water.length; i++) {
        const [wx, wy] = layout.water[i];
        if (((wx * 13 + wy * 29) & 15) === 0) {
          ctx.fillRect(wx * s, wy * s, Math.max(1.5, s * 1.15), Math.max(1, s * 0.45));
        }
      }
    }

    // Subtle quadrant tactical grid
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1;
    for (let t = 16; t < MAP_W; t += 16) {
      const p = Math.round(t * s) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, h);
      ctx.moveTo(0, p);
      ctx.lineTo(w, p);
      ctx.stroke();
    }

    // Center gold ore blob + bonus extraOre zones
    const drawOreBlob = (cx: number, cy: number, rTiles: number) => {
      const px = cx * s;
      const py = cy * s;
      const pr = Math.max(2.6, rTiles * s);
      ctx.fillStyle = "rgba(255, 196, 61, 0.28)";
      ctx.beginPath();
      ctx.arc(px, py, pr * 1.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e0ae34";
      ctx.beginPath();
      ctx.arc(px, py, pr * 0.88, 0, Math.PI * 2);
      ctx.fill();
    };
    drawOreBlob(MAP_W / 2, MAP_H / 2, 3.6);
    if (layout.extraOre) {
      for (const [ox, oy, or] of layout.extraOre) {
        drawOreBlob(ox, oy, or);
      }
    }

    // Impassable cliff mesas / rock outcrops
    ctx.fillStyle = pal.cliff;
    for (let i = 0; i < layout.cliffs.length; i++) {
      const [cx, cy] = layout.cliffs[i];
      ctx.fillRect(cx * s, cy * s, cs, cs);
    }
    ctx.fillStyle = pal.cliffEdge;
    for (let i = 0; i < layout.cliffs.length; i++) {
      const [cx, cy] = layout.cliffs[i];
      ctx.fillRect(cx * s, cy * s, cs, Math.max(1, s * 0.4));
    }

    // Neutral Oil Derricks (amber diamond markers)
    for (const [dx, dy] of layout.derricks) {
      const mx = (dx + 1) * s;
      const my = (dy + 1) * s;
      const r = 4;
      ctx.beginPath();
      ctx.moveTo(mx, my - r);
      ctx.lineTo(mx + r, my);
      ctx.lineTo(mx, my + r);
      ctx.lineTo(mx - r, my);
      ctx.closePath();
      ctx.fillStyle = "#ffc43d";
      ctx.fill();
      ctx.strokeStyle = "#0b1118";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // 4 corner player spawn dots
    for (let i = 0; i < SPAWNS.length; i++) {
      const sp = SPAWNS[i];
      const sx = (sp.x + 1.5) * s;
      const sy = (sp.y + 1.5) * s;
      ctx.beginPath();
      ctx.arc(sx, sy, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = PLAYER_COLORS[i] ?? "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#0b1118";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // Subtle inset tactical frame
    ctx.strokeStyle = "rgba(180, 220, 240, 0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  setInitialName(name: string) {
    this.lastSubmittedName = name;
    const inp = document.getElementById("name-input") as HTMLInputElement | null;
    if (inp && document.activeElement !== inp) inp.value = name;
  }

  setAudioState(muted: boolean, musicOn: boolean) {
    const mb = document.getElementById("mute-btn");
    if (mb) {
      mb.textContent = muted ? "SFX: OFF" : "SFX";
      mb.classList.toggle("on", !muted);
    }
    const bgm = document.getElementById("music-btn");
    if (bgm) {
      bgm.textContent = musicOn ? "BGM" : "BGM: OFF";
      bgm.classList.toggle("on", musicOn && !muted);
    }
  }

  resetMatch() {
    this.creditsInit = false;
    this.displayCredits = 0;
    this.targetCredits = 0;
    this.spectating = false;
    this.fpvMode = false;
    this.fpvLastKind = "";
    this.selSig = "";
    this.updateClock(0);
    this.hideHoverTip();
    this.hideSideInfo();
    document.getElementById("fpv-hud")?.classList.add("hidden");
    const sw = document.getElementById("sw-hud");
    if (sw) sw.classList.add("hidden");
    const recon = document.getElementById("recon-hud");
    if (recon) recon.classList.add("hidden");
    const boost = document.getElementById("prod-boost");
    if (boost) boost.classList.add("hidden");
  }

  updateClock(tick: number) {
    const clock = document.getElementById("game-clock");
    if (!clock) return;
    const sec = Math.max(0, Math.floor(tick / 10));
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    clock.textContent = `${mm}:${ss}`;
  }

  tick(dt: number) {
    if (this.spectating || !this.creditsInit) return;
    const diff = this.targetCredits - this.displayCredits;
    if (Math.abs(diff) > 0.5) {
      this.displayCredits = Math.abs(diff) < 2 ? this.targetCredits : this.displayCredits + diff * Math.min(1, dt * 11);
      el("credits").textContent = fmtCost(Math.round(this.displayCredits));
    } else if (this.displayCredits !== this.targetCredits) {
      this.displayCredits = this.targetCredits;
      el("credits").textContent = fmtCost(Math.round(this.displayCredits));
    }
  }

  private buildTooltip(kind: BuildingKind, missing?: BuildingKind[]) {
    const d = BUILDINGS[kind];
    const pwr = d.power !== 0 ? `${d.power > 0 ? "+" : ""}${d.power}⚡ · ` : "";
    const base = `${TOOLTIPS[kind] ?? BUILDING_NAMES[kind]} · ${pwr}${d.buildTicks / 10}s to build`;
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

  showLobby(players: LobbyPlayer[], you: string, mapId: MapId = "crossroads", config: GameConfig = DEFAULT_CONFIG) {
    this.fpvMode = false;
    document.getElementById("fpv-hud")?.classList.add("hidden");
    this.hideHoverTip();
    this.hideSideInfo();
    el("lobby").classList.remove("hidden");
    el("endscreen").classList.add("hidden");
    const me = players.find((p) => p.id === you);
    this.ready = !!me?.ready;
    el("ready-btn").textContent = this.ready ? "UNREADY" : "READY";
    el("ready-btn").classList.toggle("on", this.ready);
    const isHost = !!me?.host;

    if (me) this.setInitialName(me.name);
    const mapSelect = document.getElementById("map-select") as HTMLSelectElement | null;
    if (mapSelect) {
      mapSelect.value = mapId;
      mapSelect.disabled = !isHost;
    }
    const cfgCr = document.getElementById("cfg-credits") as HTMLSelectElement | null;
    if (cfgCr) {
      cfgCr.value = String(config.startCredits);
      cfgCr.disabled = !isHost;
    }
    const cfgSp = document.getElementById("cfg-speed") as HTMLSelectElement | null;
    if (cfgSp) {
      cfgSp.value = String(config.gameSpeed);
      cfgSp.disabled = !isHost;
    }
    const syncChk = (id: string, val: boolean) => {
      const inp = document.getElementById(id) as HTMLInputElement | null;
      if (inp) {
        inp.checked = val;
        inp.disabled = !isHost;
      }
    };
    syncChk("cfg-sw", config.superweapons);
    syncChk("cfg-crates", config.crates);
    syncChk("cfg-derricks", config.derricks);
    syncChk("cfg-fog", config.fog);
    this.updateMapDesc(mapId);

    const list = el("player-list");
    list.innerHTML = "";
    for (const p of players) {
      const li = document.createElement("li");
      if (p.eliminated) li.classList.add("dead");
      const color = p.slot >= 0 ? PLAYER_COLORS[p.slot] : "#8a97a5";

      const dot = document.createElement("span");
      dot.className = "cdot";
      dot.style.background = color;
      li.appendChild(dot);

      const pname = document.createElement("span");
      pname.className = "pname";
      pname.style.color = color;
      pname.textContent = `${p.name}${p.id === you ? " (you)" : ""}`;
      li.appendChild(pname);

      if (!p.spectator) {
        const team = p.team ?? 0;
        const tLabel = team === 0 ? "FFA" : `T${team}`;
        const tClass = `tbadge ${team === 1 ? "t1" : team === 2 ? "t2" : "ffa"}`;
        if (p.id === you || (isHost && p.bot)) {
          const tb = document.createElement("button");
          tb.type = "button";
          tb.className = tClass + " own";
          tb.textContent = tLabel;
          tb.title = "Click to cycle team (FFA / Team 1 / Team 2)";
          tb.addEventListener("click", () => {
            const next = team === 0 ? 1 : team === 1 ? 2 : 0;
            this.onSetTeam(next, p.id === you ? undefined : p.id);
          });
          li.appendChild(tb);
        } else {
          const ts = document.createElement("span");
          ts.className = tClass;
          ts.textContent = tLabel;
          li.appendChild(ts);
        }
      }

      if (isHost && p.bot) {
        const dSel = document.createElement("select");
        dSel.className = "bot-inline";
        dSel.title = "Bot difficulty";
        for (const dv of ["easy", "normal", "brutal"] as BotDiff[]) {
          const o = document.createElement("option");
          o.value = dv;
          o.textContent = dv[0].toUpperCase() + dv.slice(1);
          o.selected = (p.diff ?? "normal") === dv;
          dSel.appendChild(o);
        }
        dSel.addEventListener("change", () => this.onSetBotConfig(p.id, dSel.value as BotDiff, undefined));
        li.appendChild(dSel);

        const pSel = document.createElement("select");
        pSel.className = "bot-inline";
        pSel.title = "Bot playstyle profile";
        for (const bp of BOT_PROFILES) {
          const o = document.createElement("option");
          o.value = bp.id;
          o.textContent = bp.label;
          o.selected = (p.profile ?? "balanced") === bp.id;
          pSel.appendChild(o);
        }
        pSel.addEventListener("change", () => this.onSetBotConfig(p.id, undefined, pSel.value as BotProfile));
        li.appendChild(pSel);
      } else {
        const meta = document.createElement("span");
        meta.className = "meta";
        const profLabel = BOT_PROFILES.find((bp) => bp.id === (p.profile ?? "balanced"))?.label ?? "Balanced";
        const role = p.spectator
          ? "spectating"
          : p.bot
            ? `AI · ${p.diff ?? "normal"} · ${profLabel}`
            : p.host
              ? "◆ host"
              : "";
        const conn = p.connected ? (p.ready ? "· ready" : "") : "· offline";
        const out = p.eliminated ? " · out" : "";
        meta.textContent = `${role} ${conn}${out}`.trim();
        li.appendChild(meta);
      }

      if (isHost && p.bot) {
        const kick = document.createElement("button");
        kick.type = "button";
        kick.className = "kick-btn";
        kick.title = `Remove ${p.name}`;
        kick.textContent = "×";
        kick.addEventListener("click", () => this.onKickBot(p.id));
        li.appendChild(kick);
      }

      list.appendChild(li);
    }

    el("start-btn").classList.toggle("hidden", !isHost);
    el("addbot-btn")?.classList.toggle("hidden", !isHost);
    document.getElementById("bot-diff")?.classList.toggle("hidden", !isHost);
    document.getElementById("bot-profile")?.classList.toggle("hidden", !isHost);
    el("lobby-hint").textContent = isHost
      ? "you are host — configure match rules, bot difficulty & playstyles, then start (2-4 players)"
      : "waiting for host to start… (click your team badge to switch teams)";
  }

  hideLobby(spectating = false) {
    el("lobby").classList.add("hidden");
    for (const id of ["topbar", "minimap", "selinfo", "chat-box"]) {
      document.getElementById(id)?.classList.remove("hidden");
    }
    this.setSpectatorMode(spectating);
  }

  setSpectatorMode(spectating: boolean) {
    this.spectating = spectating;
    for (const id of ["sidebar", "verbbar", "resign-btn", "groupbar"]) {
      document.getElementById(id)?.classList.toggle("hidden", spectating || this.fpvMode);
    }
    if (spectating) {
      this.hideSideInfo();
      document.getElementById("sw-hud")?.classList.add("hidden");
      document.getElementById("recon-hud")?.classList.add("hidden");
    }
  }

  setFpvMode(active: boolean, spectating = this.spectating) {
    this.fpvMode = active;
    const fpvHud = document.getElementById("fpv-hud");
    if (active) {
      this.fpvLastKind = "";
      this.hideHoverTip();
      this.hideSideInfo();
      for (const id of [
        "sidebar",
        "verbbar",
        "selinfo",
        "groupbar",
        "placement-hint",
        "hover-tip",
        "order-label",
        "chat-box",
        "recon-hud",
        "sw-hud",
      ]) {
        document.getElementById(id)?.classList.add("hidden");
      }
      fpvHud?.classList.remove("hidden");
    } else {
      fpvHud?.classList.add("hidden");
      document.getElementById("selinfo")?.classList.remove("hidden");
      document.getElementById("chat-box")?.classList.remove("hidden");
      this.setSpectatorMode(spectating);
    }
  }

  updateFpv(tel: FpvTelemetry | null) {
    if (!this.fpvMode || !tel) return;
    const udef = !isBuildingKind(tel.kind) ? UNITS[tel.kind as UnitKind] : null;
    const domain = tel.domain ?? udef?.domain ?? "land";
    const isInf = udef?.trainsAt === "barracks";

    // Top-center banner (pointer lock state)
    const banner = document.getElementById("fpv-banner");
    if (banner) {
      const locked = tel.pointerLocked || document.pointerLockElement != null;
      banner.textContent = locked
        ? "FIRST-PERSON POV · WASD MOVE · MOUSE AIM · LMB FIRE · E / ESC EXIT"
        : "FIRST-PERSON POV · CLICK TO LOCK MOUSE · E / ESC TO EXIT";
    }

    // Center tactical reticle domain style + lock-on state
    const reticle = document.getElementById("fpv-reticle");
    if (reticle) {
      const domCls = isInf ? "fpv-inf" : domain === "air" ? "fpv-air" : domain === "sea" ? "fpv-sea" : "fpv-land";
      reticle.classList.remove("fpv-inf", "fpv-land", "fpv-air", "fpv-sea");
      reticle.classList.add(domCls);
      const tgt = tel.target;
      reticle.classList.toggle("locked", Boolean(tgt && tgt.enemy && tgt.inRange));

      const tgtEl = document.getElementById("fpv-target");
      if (tgtEl) {
        if (tgt) {
          const tgtName = label(tgt.kind).toUpperCase();
          const tHp = Math.max(0, Math.round(tgt.hp));
          const tMhp = Math.max(1, Math.round(tgt.mhp));
          const distM = Math.round(tgt.dist * 10);
          tgtEl.classList.remove("range-only");
          if (tgt.enemy) {
            const rangeTag = tgt.inRange ? "IN RANGE" : "OUT OF RANGE";
            tgtEl.textContent = `TARGET: ${tgtName} · HP ${tHp}/${tMhp} · ${distM}m · ${rangeTag}`;
            tgtEl.classList.toggle("out-of-range", !tgt.inRange);
          } else {
            tgtEl.textContent = `${tgtName} · HP ${tHp}/${tMhp} · ${distM}m`;
            tgtEl.classList.remove("out-of-range");
          }
          tgtEl.classList.remove("hidden");
        } else if (tel.aimDist > 0) {
          tgtEl.textContent = `${Math.round(tel.aimDist * 10)}m`;
          tgtEl.classList.remove("out-of-range");
          tgtEl.classList.add("range-only");
          tgtEl.classList.remove("hidden");
        } else {
          tgtEl.classList.add("hidden");
          tgtEl.classList.remove("out-of-range", "range-only");
        }
      }
    }

    // Bottom-left unit telemetry card
    if (tel.kind !== this.fpvLastKind) {
      this.fpvLastKind = tel.kind;
      const nameEl = document.getElementById("fpv-unit-name");
      if (nameEl) nameEl.textContent = label(tel.kind).toUpperCase();
      const iconEl = document.getElementById("fpv-unit-icon");
      if (iconEl) {
        const ic = this.iconFor(tel.kind);
        iconEl.style.backgroundImage = ic ? `url(${ic})` : "";
        iconEl.classList.toggle("has-icon", Boolean(ic));
      }
      const domBadge = document.getElementById("fpv-domain-badge");
      if (domBadge) {
        domBadge.textContent = isInf
          ? "INFANTRY"
          : domain === "air"
            ? "AIRCRAFT"
            : domain === "sea"
              ? "NAVAL"
              : "ARMOR";
      }
    }

    const vetEl = document.getElementById("fpv-unit-vet");
    if (vetEl) {
      const vet = Math.max(0, Math.min(3, Math.floor(tel.vet)));
      vetEl.textContent = vet > 0 ? "★".repeat(vet) : "";
    }

    const subBadge = document.getElementById("fpv-sub-badge");
    if (subBadge) {
      subBadge.classList.toggle("hidden", !tel.submerged);
    }

    const hp = Math.max(0, tel.hp);
    const mhp = Math.max(1, tel.mhp);
    const hpPct = Math.max(0, Math.min(100, (hp / mhp) * 100));
    const hpFill = document.getElementById("fpv-hp-fill");
    if (hpFill) {
      hpFill.style.width = `${hpPct.toFixed(1)}%`;
      hpFill.classList.toggle("warn", hpPct < 55 && hpPct >= 28);
      hpFill.classList.toggle("crit", hpPct < 28);
    }
    const hpText = document.getElementById("fpv-hp-text");
    if (hpText) hpText.textContent = `HP ${Math.round(hp)} / ${Math.round(mhp)}`;

    const spdEl = document.getElementById("fpv-spd");
    if (spdEl) {
      const spdVal = Math.round(Math.abs(tel.speed) * 10);
      const unitSuffix = domain === "sea" ? "kt" : "m/s";
      spdEl.textContent = `SPD ${spdVal} ${unitSuffix}`;
    }

    const hdgEl = document.getElementById("fpv-hdg");
    if (hdgEl) {
      const deg = ((Math.round(tel.headingDeg) % 360) + 360) % 360;
      hdgEl.textContent = `HDG ${String(deg).padStart(3, "0")}°`;
    }

    const altEl = document.getElementById("fpv-alt");
    if (altEl) {
      if (domain === "air") {
        altEl.textContent = `ALT ${Math.round(tel.altitude)}m`;
        altEl.classList.remove("hidden");
      } else {
        altEl.classList.add("hidden");
      }
    }

    // Bottom-right weapon & reload panel
    const wpnStatus = document.getElementById("fpv-wpn-status");
    const wpnRange = document.getElementById("fpv-wpn-range");
    const reloadFill = document.getElementById("fpv-reload-fill");
    if (wpnStatus && reloadFill) {
      if (tel.kind === "engineer") {
        wpnStatus.textContent = "CAPTURE RANGE — CLICK BUILDING";
        wpnStatus.className = "utility";
        reloadFill.style.width = "100%";
        reloadFill.className = "utility";
        if (wpnRange) wpnRange.textContent = `RNG ${Math.round(CAPTURE_RANGE * 10)}m`;
      } else if (tel.kind === "harvester") {
        wpnStatus.textContent = "MINING MODE";
        wpnStatus.className = "utility";
        reloadFill.style.width = "100%";
        reloadFill.className = "utility";
        if (wpnRange) wpnRange.textContent = "ORE RIG";
      } else {
        const readyFrac = Math.max(0, Math.min(1, 1 - tel.reloading));
        const ready = tel.reloading <= 0.01;
        wpnStatus.textContent = ready ? "WEAPON READY" : "RELOADING...";
        wpnStatus.className = ready ? "" : "reloading";
        reloadFill.style.width = `${(readyFrac * 100).toFixed(1)}%`;
        reloadFill.className = ready ? "" : "reloading";
        if (wpnRange) {
          const rngM = udef && udef.range > 0 ? Math.round(udef.range * 10) : 0;
          wpnRange.textContent = rngM > 0 ? `RNG ${rngM}m` : "";
        }
      }
    }
  }

  clearChat() {
    this.chatLines = [];
    const box = document.getElementById("chat-lines");
    if (box) box.innerHTML = "";
  }

  showEnd(text: string, reason = "", stats?: MatchStats[], durationSec?: number) {
    this.fpvMode = false;
    document.getElementById("fpv-hud")?.classList.add("hidden");
    this.hideHoverTip();
    this.hideSideInfo();
    el("end-text").textContent = text;
    const r = document.getElementById("end-reason");
    if (r) r.textContent = reason;

    const dur = document.getElementById("end-duration");
    if (dur) {
      if (durationSec !== undefined && Number.isFinite(durationSec)) {
        const s = Math.max(0, Math.floor(durationSec));
        const mm = String(Math.floor(s / 60)).padStart(2, "0");
        const ss = String(s % 60).padStart(2, "0");
        dur.textContent = `MATCH DURATION ${mm}:${ss}`;
        dur.classList.remove("hidden");
      } else {
        dur.textContent = "";
        dur.classList.add("hidden");
      }
    }

    const box = document.getElementById("end-stats");
    if (box) {
      if (stats?.length) {
        const rows = [...stats]
          .sort((a, b) => a.slot - b.slot)
          .map((st) => {
            const color = st.slot >= 0 ? PLAYER_COLORS[st.slot] ?? "#8a97a5" : "#8a97a5";
            const tLabel = st.team > 0 ? `T${st.team}` : "FFA";
            const tCls = st.team === 1 ? "t1" : st.team === 2 ? "t2" : "ffa";
            return `<tr>
              <td><span class="stats-cmdr"><span class="cdot" style="background:${color}"></span><span style="color:${color}">${esc(st.name)}</span></span></td>
              <td><span class="tbadge ${tCls}">${tLabel}</span></td>
              <td class="stats-cr">${fmtCost(Math.round(st.creditsEarned))}</td>
              <td>${st.unitsBuilt}</td>
              <td>${st.unitsLost}</td>
              <td>${st.bldDestroyed}</td>
            </tr>`;
          })
          .join("");
        box.innerHTML = `<table class="stats-table">
          <thead><tr><th>COMMANDER</th><th>TEAM</th><th>CREDITS</th><th>BUILT</th><th>LOST</th><th>RAZED</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      } else {
        box.innerHTML = "";
      }
    }

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
      this.spectating = true;
      cr.textContent = "";
      pw.innerHTML = "";
      pw.title = "";
      pw.classList.remove("low", "warn");
      wrap.innerHTML = Object.entries(spectatorStates)
        .map(
          ([s, p]) =>
            `<span class="${p.eliminated ? "elim" : ""}" style="color:${PLAYER_COLORS[+s] ?? "#888"}">${fmtCost(p.credits)}</span>`,
        )
        .join(" · ");
      return;
    }
    this.spectating = false;
    wrap.innerHTML = "";
    if (!state) return;
    if (!this.creditsInit) {
      this.creditsInit = true;
      this.displayCredits = state.credits;
      this.targetCredits = state.credits;
      cr.textContent = fmtCost(state.credits);
    } else {
      this.targetCredits = state.credits;
    }
    const net = state.pwrHave - state.pwrUse;
    const rawReserve = state.pwrHave > 0 ? net / state.pwrHave : 0;
    const fillPct = state.lowPower
      ? 100
      : state.pwrHave === 0
        ? 0
        : Math.round(Math.max(0.12, Math.min(1, rawReserve)) * 100);
    const warn = !state.lowPower && state.pwrHave > 0 && rawReserve < 0.25;
    pw.title = `Power output: ${state.pwrHave} ⚡ · Drain: ${state.pwrUse} ⚡ · Net: ${net >= 0 ? "+" : ""}${net}`;
    pw.innerHTML = `PWR <b>${net >= 0 ? "+" : ""}${net}</b>${state.lowPower ? ' <span class="pwr-tag">(LOW)</span>' : ""}<span class="pwr-track"><span class="pwr-fill" style="width:${fillPct}%"></span></span>`;
    pw.classList.toggle("low", state.lowPower);
    pw.classList.toggle("warn", warn);
  }

  updateRecon(state: PlayerState | null, reconArmed = false) {
    const btn = document.getElementById("recon-hud") as HTMLButtonElement | null;
    if (!btn) return;
    if (this.fpvMode || !state || this.spectating || state.reconLeft === undefined || state.reconLeft < 0) {
      btn.classList.add("hidden");
      btn.classList.remove("ready", "armed", "offline");
      return;
    }
    btn.classList.remove("hidden");
    const prog = btn.querySelector<HTMLElement>(".recon-prog");
    const txt = btn.querySelector<HTMLElement>(".recon-txt");
    const total = state.reconTotal && state.reconTotal > 0 ? state.reconTotal : RECON_CHARGE_TICKS;
    if (state.lowPower) {
      btn.disabled = true;
      btn.classList.remove("ready", "armed");
      btn.classList.add("offline");
      const pct = Math.max(0, Math.min(100, (1 - state.reconLeft / total) * 100));
      if (prog) prog.style.width = `${pct.toFixed(1)}%`;
      if (txt) txt.textContent = "RECON OFFLINE (LOW PWR)";
    } else if (state.reconReady) {
      btn.disabled = false;
      btn.classList.remove("offline");
      btn.classList.add("ready");
      btn.classList.toggle("armed", reconArmed);
      if (prog) prog.style.width = "100%";
      if (txt) txt.textContent = reconArmed ? "RECON SCAN — CLICK MAP" : "◎ RECON SCAN READY";
    } else {
      btn.disabled = true;
      btn.classList.remove("ready", "armed", "offline");
      const sec = Math.max(0, Math.ceil(state.reconLeft / 10));
      const m = Math.floor(sec / 60);
      const s = String(sec % 60).padStart(2, "0");
      const pct = Math.max(0, Math.min(100, (1 - state.reconLeft / total) * 100));
      if (prog) prog.style.width = `${pct.toFixed(1)}%`;
      if (txt) txt.textContent = `RECON SCAN ${m}:${s}`;
    }
  }

  updateSuperweapon(state: PlayerState | null, swArmed = false) {
    const btn = document.getElementById("sw-hud") as HTMLButtonElement | null;
    if (!btn) return;
    if (this.fpvMode || !state || this.spectating || state.swLeft === undefined || state.swLeft < 0) {
      btn.classList.add("hidden");
      btn.classList.remove("ready", "armed", "offline");
      return;
    }
    btn.classList.remove("hidden");
    const prog = btn.querySelector<HTMLElement>(".sw-prog");
    const txt = btn.querySelector<HTMLElement>(".sw-txt");
    const total = state.swTotal && state.swTotal > 0 ? state.swTotal : SW_CHARGE_TICKS;
    if (state.lowPower) {
      btn.disabled = true;
      btn.classList.remove("ready", "armed");
      btn.classList.add("offline");
      const pct = Math.max(0, Math.min(100, (1 - state.swLeft / total) * 100));
      if (prog) prog.style.width = `${pct.toFixed(1)}%`;
      if (txt) txt.textContent = "ION OFFLINE (LOW PWR)";
    } else if (state.swReady) {
      btn.disabled = false;
      btn.classList.remove("offline");
      btn.classList.add("ready");
      btn.classList.toggle("armed", swArmed);
      if (prog) prog.style.width = "100%";
      if (txt) txt.textContent = swArmed ? "TARGET STRIKE — CLICK MAP" : "⚡ ION CANNON READY — CLICK TO FIRE";
    } else {
      btn.disabled = true;
      btn.classList.remove("ready", "armed", "offline");
      const sec = Math.max(0, Math.ceil(state.swLeft / 10));
      const m = Math.floor(sec / 60);
      const s = String(sec % 60).padStart(2, "0");
      const pct = Math.max(0, Math.min(100, (1 - state.swLeft / total) * 100));
      if (prog) prog.style.width = `${pct.toFixed(1)}%`;
      if (txt) txt.textContent = `ION CANNON ${m}:${s}`;
    }
  }

  private findSidebarBtnAt(x: number, y: number): HTMLButtonElement | null {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar || sidebar.classList.contains("hidden")) return null;
    const sr = sidebar.getBoundingClientRect();
    if (x < sr.left || x > sr.right || y < sr.top || y > sr.bottom) return null;
    if (typeof document.elementsFromPoint === "function") {
      for (const node of document.elementsFromPoint(x, y)) {
        if (node instanceof HTMLButtonElement && node.classList.contains("sbtn") && sidebar.contains(node)) {
          return node;
        }
        const parent = node instanceof Element ? node.closest<HTMLButtonElement>("#sidebar .sbtn") : null;
        if (parent) return parent;
      }
    }
    for (const b of this.buildBtns.values()) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return b;
    }
    for (const b of this.trainBtns.values()) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return b;
    }
    return null;
  }

  private showSideInfo(btn: HTMLButtonElement) {
    const box = document.getElementById("side-info");
    if (!box) return;
    if (this.hoveredBtn && this.hoveredBtn !== btn) {
      this.hoveredBtn.classList.remove("inspected");
    }
    this.hoveredBtn = btn;
    btn.classList.add("inspected");

    const kind = btn.dataset.kind as BuildingKind | undefined;
    const unit = btn.dataset.unit as UnitKind | undefined;
    const reason = btn.dataset.reason ?? "";
    const reasonKind = btn.dataset.reasonKind ?? "";
    const status = btn.dataset.status ?? "";
    const statusText = btn.dataset.statusText ?? "";

    let title = "";
    let chipsHtml = "";
    let desc = "";

    if (kind) {
      const d = BUILDINGS[kind];
      title = BUILDING_NAMES[kind];
      const pwrHtml =
        d.power !== 0
          ? `<span class="${d.power > 0 ? "si-pwr-pos" : "si-pwr-neg"}">${d.power > 0 ? "+" : ""}${d.power}⚡</span>`
          : "";
      chipsHtml = `<span class="si-cost">${fmtCost(d.cost)}</span><span class="si-time">${d.buildTicks / 10}s</span>${pwrHtml}`;
      desc = TOOLTIPS[kind] ?? title;
    } else if (unit) {
      const d = UNITS[unit];
      title = label(unit);
      const bt = btn.querySelector<HTMLElement>(".btime")?.textContent ?? `${d.buildTicks / 10}s`;
      const timeLabel = bt === "NO SEA" ? `${d.buildTicks / 10}s` : bt;
      chipsHtml = `<span class="si-cost">${fmtCost(d.cost)}</span><span class="si-time">${timeLabel}</span><span class="si-time">${SHORT_BUILDING_NAMES[d.trainsAt]}</span>`;
      desc = TOOLTIPS[unit] ?? title;
    } else {
      box.classList.add("hidden");
      return;
    }

    let calloutCls = "si-callout";
    let calloutText = "";
    if (reason) {
      calloutCls += " blocked" + (reasonKind === "funds" || reasonKind === "busy" ? " funds" : "");
      calloutText = reason;
    } else if (status === "building" || status === "training") {
      calloutCls += " busy";
      calloutText = statusText;
    } else {
      calloutCls += " ready";
      calloutText = statusText || (kind ? "Ready to build — click to start." : "Click to train · Shift+click ×5.");
    }

    box.innerHTML =
      `<div class="si-head"><span class="si-name">${esc(title)}</span></div>` +
      `<div class="si-chips">${chipsHtml}</div>` +
      `<div class="si-desc">${esc(desc)}</div>` +
      `<div class="${calloutCls}">${esc(calloutText)}</div>`;
    box.classList.remove("hidden");
  }

  hideSideInfo() {
    if (this.hoveredBtn) {
      this.hoveredBtn.classList.remove("inspected");
      this.hoveredBtn = null;
    }
    document.getElementById("side-info")?.classList.add("hidden");
  }

  updateSidebar(
    state: PlayerState | null,
    has: (k: string) => boolean,
    countOf?: (k: BuildingKind) => number,
    config: GameConfig = DEFAULT_CONFIG,
    hasWater = true,
  ) {
    const applyReason = (
      b: HTMLButtonElement,
      shortReason: string,
      detail: string,
      reasonKind: "" | "lock" | "funds" | "busy" | "limit",
      status: "ready" | "building" | "training" | "avail" | "blocked",
      statusText = "",
    ) => {
      const tag = b.querySelector<HTMLElement>(".req-tag");
      if (tag) tag.textContent = shortReason;
      if (detail) b.dataset.reason = detail;
      else delete b.dataset.reason;
      if (reasonKind) b.dataset.reasonKind = reasonKind;
      else delete b.dataset.reasonKind;
      b.dataset.status = status;
      if (statusText) b.dataset.statusText = statusText;
      else delete b.dataset.statusText;
    };

    for (const [kind, b] of this.buildBtns) {
      const d = BUILDINGS[kind];
      b.classList.remove("ready", "locked");
      delete b.dataset.busy;
      b.disabled = false;
      const prog = b.querySelector<HTMLElement>(".prog")!;
      const bt = b.querySelector<HTMLElement>(".btime")!;
      prog.style.width = "0%";
      bt.textContent = `${d.buildTicks / 10}s`;
      if (kind === "superweapon" && !config.superweapons) {
        b.classList.add("locked");
        b.disabled = true;
        bt.textContent = "OFF";
        const detail = "Superweapons are disabled in match settings.";
        b.title = detail;
        applyReason(b, "Disabled", detail, "limit", "blocked");
        continue;
      }
      if (d.waterOnly && !hasWater) {
        b.classList.add("locked");
        b.disabled = true;
        bt.textContent = "NO WATER";
        const detail =
          "Naval Shipyard requires navigable water — pick a naval map (Bridgehead Crossing, Pacific Atoll, Storm Coast).";
        b.title = `${this.buildTooltip(kind)} · ${detail}`;
        applyReason(b, "No water", detail, "lock", "blocked");
        continue;
      }
      if (!state) {
        b.disabled = true;
        b.title = this.buildTooltip(kind);
        applyReason(b, "", "", "", "blocked");
        continue;
      }
      if (!has("conyard")) {
        b.classList.add("locked");
        b.disabled = true;
        const detail = "Lost Construction Yard — cannot build structures.";
        b.title = `${this.buildTooltip(kind)} · ${detail}`;
        applyReason(b, "Need ConYard", detail, "busy", "blocked");
        continue;
      }
      if (state.awaiting === kind) {
        b.classList.add("ready");
        bt.textContent = "RDY";
        b.title = this.buildTooltip(kind);
        applyReason(b, "", "", "", "ready", "Finished — click to place on the map (right-click to cancel).");
        continue;
      }
      if (state.bq?.kind === kind) {
        b.dataset.busy = "1";
        prog.style.width = `${(1 - state.bq.left / state.bq.total) * 100}%`;
        bt.textContent = `${(state.bq.left / 10).toFixed(1)}s`;
        b.title = this.buildTooltip(kind);
        applyReason(b, "", "", "", "building", "Constructing — right-click to cancel & refund.");
        continue;
      }
      if (d.limit !== undefined && countOf && countOf(kind) >= d.limit) {
        b.disabled = true;
        bt.textContent = "MAX";
        const detail = `Limit reached — you can only have ${d.limit} ${BUILDING_NAMES[kind]} at a time.`;
        b.title = `${this.buildTooltip(kind)} · ${detail}`;
        applyReason(b, `Max ${d.limit} built`, detail, "limit", "blocked");
        continue;
      }
      const missing = d.requires?.filter((r) => !has(r)) ?? [];
      b.title = this.buildTooltip(kind, missing);
      if (missing.length) {
        const chain = missingPrereqChain(d.requires ?? [], has);
        const detail = `Locked — Build first: ${formatChainSteps(chain).join(" → ")}.`;
        b.classList.add("locked");
        b.disabled = true;
        applyReason(b, formatShortNeed(missing), detail, "lock", "blocked");
        continue;
      }
      if (state.awaiting) {
        b.disabled = true;
        const awaitingName = BUILDING_NAMES[state.awaiting];
        const detail = `Place your finished ${awaitingName} on the map first (or right-click to cancel).`;
        applyReason(b, `Place ${SHORT_BUILDING_NAMES[state.awaiting]}`, detail, "lock", "blocked");
        continue;
      }
      if (state.bq) {
        b.disabled = true;
        const bqName = BUILDING_NAMES[state.bq.kind];
        const detail = `Construction Yard is busy building ${bqName}.`;
        applyReason(b, "Queue busy", detail, "busy", "blocked");
        continue;
      }
      if (state.credits < d.cost) {
        b.disabled = true;
        const detail = `Insufficient funds — need ${fmtCost(d.cost)} (have ${fmtCost(Math.floor(state.credits))}). Build Refineries/Harvesters or capture Oil Derricks.`;
        applyReason(b, `Need ${fmtCost(d.cost)}`, detail, "funds", "blocked");
        continue;
      }
      applyReason(b, "", "", "", "avail", "Ready to build — click to start.");
    }

    // Multi-factory production speed badge on ARMY header (all 4 production categories)
    const boostEl = document.getElementById("prod-boost");
    const bBoost = state?.prodBoost?.barracks ?? 1;
    const fBoost = state?.prodBoost?.factory ?? 1;
    const aBoost = state?.prodBoost?.airfield ?? 1;
    const sBoost = state?.prodBoost?.shipyard ?? 1;
    if (boostEl) {
      const active: { short: string; key: string; name: string; mult: number }[] = [];
      if (bBoost > 1.01) active.push({ short: "INF", key: "B", name: "Barracks", mult: bBoost });
      if (fBoost > 1.01) active.push({ short: "VEH", key: "F", name: "War Factory", mult: fBoost });
      if (aBoost > 1.01) active.push({ short: "AIR", key: "A", name: "Air Command", mult: aBoost });
      if (sBoost > 1.01) active.push({ short: "SEA", key: "S", name: "Naval Shipyard", mult: sBoost });
      if (active.length) {
        const allEqual = active.every((x) => Math.abs(x.mult - active[0].mult) < 0.01);
        if (active.length === 1) {
          boostEl.textContent = `${active[0].short} ${fmtBoost(active[0].mult)}`;
        } else if (allEqual) {
          boostEl.textContent = fmtBoost(active[0].mult);
        } else if (active.length === 2) {
          boostEl.textContent = active.map((x) => `${x.key} ${fmtBoost(x.mult)}`).join(" · ");
        } else {
          const maxMult = Math.max(...active.map((x) => x.mult));
          boostEl.textContent = `${active.length}× ${fmtBoost(maxMult)}`;
        }
        boostEl.title = `Multi-structure speed bonus: ${active.map((x) => `${x.name} ${fmtBoost(x.mult)}`).join(", ")}`;
        boostEl.classList.remove("hidden");
      } else {
        boostEl.classList.add("hidden");
      }
    }

    const seaHdr = this.trainGroupHeaders.get("sea");
    if (seaHdr) {
      seaHdr.classList.toggle("no-water", !hasWater);
      seaHdr.textContent = hasWater ? "NAVY" : "NAVY · NO WATER";
    }

    for (const [unit, b] of this.trainBtns) {
      const d = UNITS[unit];
      const prog = b.querySelector<HTMLElement>(".prog")!;
      const bt = b.querySelector<HTMLElement>(".btime")!;
      const cat = d.trainsAt;
      const mult = state?.prodBoost?.[cat] ?? 1;
      prog.style.width = "0%";
      b.querySelector(".qcount")?.remove();
      b.classList.remove("locked");
      b.disabled = true;
      if (d.domain === "sea" && !hasWater) {
        b.classList.add("locked");
        bt.textContent = "NO SEA";
        const detail = "Navy units require a Naval Shipyard on a naval map.";
        b.title = `${TOOLTIPS[unit] ?? label(unit)} · ${detail}`;
        applyReason(b, "No water", detail, "lock", "blocked");
        continue;
      }
      const baseTitle = `${TOOLTIPS[unit] ?? label(unit)} · ${d.buildTicks / 10}s to train · Shift+click = ×5`;
      b.title = baseTitle;
      bt.textContent = mult > 1.01 ? `${(d.buildTicks / 10 / mult).toFixed(1)}s` : `${d.buildTicks / 10}s`;
      if (!state) {
        applyReason(b, "", "", "", "blocked");
        continue;
      }
      if (!has(cat) || (d.requires && !has(d.requires))) {
        b.classList.add("locked");
        const directReqs: BuildingKind[] =
          d.requires === "factory2" ? ["factory2"] : d.requires ? [cat, d.requires] : [cat];
        const directMissing = directReqs.filter((r) => !has(r));
        const chain = missingPrereqChain(directReqs, has);
        let detail: string;
        if (chain.includes("factory2")) {
          const beforeUpgrade = chain.filter((k) => k !== "factory2");
          detail = beforeUpgrade.length
            ? `Locked — Build first: ${beforeUpgrade.map((k) => BUILDING_NAMES[k]).join(" → ")} → then select War Factory and click UPGRADE → WAR FACTORY II (${fmtCost(UPGRADE_COST)}).`
            : `Locked — Select your War Factory and click UPGRADE → WAR FACTORY II (${fmtCost(UPGRADE_COST)}).`;
        } else {
          detail = `Locked — Build first: ${formatChainSteps(chain).join(" → ")}.`;
        }
        b.title = `${baseTitle} · Requires: ${directMissing.map((m) => BUILDING_NAMES[m]).join(", ")}`;
        applyReason(b, formatShortNeed(directMissing), detail, "lock", "blocked");
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
        if (q.count >= 9) {
          applyReason(b, "Queue full", "Production queue full (max 9).", "busy", "blocked");
          continue;
        }
        if (state.credits < d.cost) {
          const detail = `Insufficient funds — need ${fmtCost(d.cost)} (have ${fmtCost(Math.floor(state.credits))}).`;
          applyReason(b, `Need ${fmtCost(d.cost)}`, detail, "funds", "blocked");
          continue;
        }
        b.disabled = false;
        applyReason(
          b,
          "",
          "",
          "",
          "training",
          `Training (×${q.count}) — click to queue more · Shift+click ×5 · Right-click to cancel.`,
        );
        continue;
      }
      if (q) {
        const prodName = BUILDING_NAMES[cat];
        const qUnitName = label(q.unit);
        const detail = `${prodName} is training ${qUnitName}. Right-click ${qUnitName} to cancel.`;
        applyReason(b, "Queue busy", detail, "busy", "blocked");
        continue;
      }
      if (state.credits < d.cost) {
        const detail = `Insufficient funds — need ${fmtCost(d.cost)} (have ${fmtCost(Math.floor(state.credits))}).`;
        applyReason(b, `Need ${fmtCost(d.cost)}`, detail, "funds", "blocked");
        continue;
      }
      b.disabled = false;
      applyReason(b, "", "", "", "avail", "Click to train · Shift+click ×5.");
    }

    if (this.hoveredBtn && this.hoveredBtn.isConnected) {
      this.showSideInfo(this.hoveredBtn);
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
      hpMax = 0,
      maxVet = 0,
      anyHold = false;
    let singleId: number | null = null;
    let singleKind: EntKind | null = null;
    for (const id of sel) {
      const t = tracked.get(id);
      if (!t) continue;
      counts.set(t.last.k, (counts.get(t.last.k) ?? 0) + 1);
      hpSum += t.last.hp;
      hpMax += t.last.mhp;
      if ((t.last.vet ?? 0) > maxVet) maxVet = t.last.vet ?? 0;
      if (t.last.hold) anyHold = true;
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
      `|${singleId ?? ""}|${singleKind ?? ""}|${hasTech ? 1 : 0}|${canAfford ? 1 : 0}|v${maxVet}|h${anyHold ? 1 : 0}`;

    // Only rebuild DOM structure when selection or upgrade readiness actually changes
    // (prevents 5Hz innerHTML destruction from eating clicks on the UPGRADE button)
    if (sig !== this.selSig) {
      this.selSig = sig;
      const parts = [...counts]
        .map(([k, n]) => {
          const ic = this.iconFor(k);
          const img = ic ? `<img class="si-icon" src="${ic}">` : "";
          return `<span>${img}${n}× ${label(k as BuildingKind | UnitKind as never)}</span>`;
        })
        .join("");
      const vetBadge =
        maxVet > 0
          ? `<span class="si-vet" title="Veterancy rank ${maxVet}">${"★".repeat(Math.min(3, maxVet))}</span>`
          : "";
      const holdBadge = anyHold
        ? `<span class="si-hold" title="Holding position — fires in range without chasing">[HOLD]</span>`
        : "";
      box.innerHTML = `<div class="si-row">${parts}${vetBadge}${holdBadge}</div><div class="si-hp"><i></i><span></span></div>`;

      if (singleId !== null && singleKind === "factory") {
        const b = document.createElement("button");
        b.className = "sbtn si-upgrade";
        b.disabled = !hasTech || !canAfford;
        const techChain = !hasTech && has ? missingPrereqChain(["techlab"], has) : [];
        b.textContent = !hasTech
          ? `UPGRADE → MKII (NEEDS TECH LAB)`
          : `UPGRADE → ${BUILDING_NAMES.factory2.toUpperCase()} (${fmtCost(UPGRADE_COST)})`;
        b.title = !hasTech
          ? techChain.length
            ? `Locked — Build first: ${formatChainSteps(techChain).join(" → ")}.`
            : "Locked — Build a Tech Lab first."
          : !canAfford
            ? `Insufficient funds — need ${fmtCost(UPGRADE_COST)} (have ${fmtCost(Math.floor(state?.credits ?? 0))}).`
            : "Upgrade War Factory to MKII — unlocks Mastodon Tank & Spider Drone.";
        b.addEventListener("click", () => this.onUpgrade?.(singleId!));
        box.appendChild(b);
      } else if (singleId !== null && singleKind === "factory2") {
        const d = document.createElement("div");
        d.className = "si-mk2";
        d.textContent = "★ MKII";
        box.appendChild(d);
      } else if (singleId !== null && singleKind !== null && !isBuildingKind(singleKind)) {
        const uk = singleKind as UnitKind;
        const udef = UNITS[uk];
        const b = document.createElement("button");
        b.id = "fpv-btn";
        b.type = "button";
        b.className = "sbtn si-fpv";
        b.textContent =
          udef?.domain === "air"
            ? "▶ PILOT AIRCRAFT [E]"
            : udef?.domain === "sea"
              ? "▶ COMMAND VESSEL [E]"
              : udef?.trainsAt === "barracks"
                ? "▶ FIRST-PERSON FPS [E]"
                : "▶ DRIVE VEHICLE [E]";
        b.title = "Enter First-Person POV (E) — WASD move, Mouse aim, Left-Click fire, E/Esc exit";
        b.addEventListener("click", () => this.onEnterFpv?.(singleId!));
        box.appendChild(b);
      }
    }

    // Always update HP bar smoothly in place
    const bar = box.querySelector<HTMLElement>(".si-hp i");
    const txt = box.querySelector<HTMLElement>(".si-hp span");
    if (bar) bar.style.width = `${Math.round((hpSum / hpMax) * 100)}%`;
    if (txt) txt.textContent = `HP ${Math.round(hpSum)} / ${hpMax}`;
  }

  showHoverTip(ent: EntSnap | null, crate: CrateSnap | null, x: number, y: number) {
    const tip = document.getElementById("hover-tip");
    if (!tip) return;
    if (!ent && !crate) {
      tip.classList.add("hidden");
      return;
    }
    if (ent) {
      if (ent.o === -1 && ent.k === "derrick") {
        tip.innerHTML = `<span class="ht-dot" style="background:#ffc43d"></span><span>Oil Derrick — Capture with Sapper</span>`;
      } else {
        const col = ent.o >= 0 ? PLAYER_COLORS[ent.o] ?? "#8a97a5" : "#8a97a5";
        const name = esc(label(ent.k));
        const vet = (ent.vet ?? 0) > 0 ? `<span class="ht-vet">${"★".repeat(Math.min(3, ent.vet!))}</span>` : "";
        const hold = ent.hold ? `<span class="ht-hold">[HOLD]</span>` : "";
        const sub = ent.sub ? `<span class="ht-hold">[SUB]</span>` : "";
        tip.innerHTML = `<span class="ht-dot" style="background:${col}"></span><span>${name}</span>${vet}${hold}${sub}<span class="ht-meta">· HP ${Math.round(ent.hp)}/${ent.mhp}</span>`;
      }
    } else if (crate) {
      tip.innerHTML = `<span class="ht-dot" style="background:#ffc43d"></span><span>Supply Crate — Walk unit over to collect</span>`;
    }
    tip.classList.remove("hidden");
    const w = tip.offsetWidth || 180;
    const h = tip.offsetHeight || 26;
    const lx = Math.max(10, Math.min(window.innerWidth - w - 10, x + 14));
    const ly = y + 18 + h > window.innerHeight - 10 ? Math.max(46, y - h - 10) : Math.max(46, y + 18);
    tip.style.left = `${lx}px`;
    tip.style.top = `${ly}px`;
  }

  hideHoverTip() {
    document.getElementById("hover-tip")?.classList.add("hidden");
  }

  drawMinimap(
    r: Renderer,
    oreCells: Set<number>,
    camX: number,
    camY: number,
    camH: number,
    mySlot: number,
    hasRadar: boolean,
    mapId: MapId = "crossroads",
    lowPower = false,
  ) {
    const now = performance.now();
    if (now - this.mmLast < 160) return;
    this.mmLast = now;
    const ctx = this.mmCtx;
    const s = this.minimap.width / MAP_W;
    ctx.fillStyle = "#080e14";
    ctx.fillRect(0, 0, 160, 160);
    if (mySlot >= 0 && !hasRadar) {
      ctx.fillStyle = "#6e8699";
      ctx.font = '700 11px "Rajdhani", monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("NO RADAR UPLINK", 80, 80);
      return;
    }
    if (mySlot >= 0 && hasRadar && lowPower) {
      // Subtle outage scanlines + amber/red warning instead of live radar dots
      ctx.fillStyle = "rgba(255, 196, 61, 0.045)";
      const shift = Math.floor((now / 90) % 8);
      for (let y = shift; y < 160; y += 8) {
        ctx.fillRect(0, y, 160, 2);
      }
      ctx.strokeStyle = "rgba(255, 84, 84, 0.45)";
      ctx.lineWidth = 1;
      ctx.strokeRect(4.5, 4.5, 151, 151);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = '700 12px "Rajdhani", monospace';
      ctx.fillStyle = "#ffc43d";
      ctx.fillText("LOW POWER —", 80, 71);
      ctx.fillStyle = "#ff5454";
      ctx.fillText("RADAR OFFLINE", 80, 89);
      return;
    }
    const layout = getMapLayout(mapId);
    const cs = Math.ceil(s);
    // Navigable ocean / river water channels
    if (layout.water.length) {
      ctx.fillStyle = "#19587a";
      for (let i = 0; i < layout.water.length; i++) {
        ctx.fillRect(layout.water[i][0] * s, layout.water[i][1] * s, cs, cs);
      }
    }
    // Impassable rocky cliff plateaus
    const cliffs = layout.cliffs;
    ctx.fillStyle = "#2a343d";
    for (let i = 0; i < cliffs.length; i++) {
      ctx.fillRect(cliffs[i][0] * s, cliffs[i][1] * s, cs, cs);
    }
    // Ore veins
    ctx.fillStyle = "#b58b2e";
    for (const key of oreCells.keys()) {
      ctx.fillRect((key % MAP_W) * s, ((key / MAP_W) | 0) * s, Math.max(1.6, s), Math.max(1.6, s));
    }
    // Supply crates (pulsing bright white/gold dots)
    if (r.crates && r.crates.size) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.008);
      for (const c of r.crates.values()) {
        ctx.fillStyle = pulse > 0.5 ? "#fff7cc" : "#ffc43d";
        ctx.beginPath();
        ctx.arc(c.x * s, c.y * s, 2.2 + pulse * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
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
