// First-person "story layer" — the game-feel director for 1P mode.
// Turns raw snapshot GameEvents + per-frame FpvTelemetry into a readable
// campaign: entry barks, an objective ladder with medals, kill streaks,
// hitmarkers, radio chatter and critical warnings. Pure TypeScript — no
// three.js, no DOM — so it can be unit-tested headless.
//
// Wiring (main.ts): `story.reset(kind, callsign)` on FPV enter,
// `story.onEvent(ev, { myId, kindOf })` for each snapshot event,
// `story.tick(dt, tel)` after `fpv.update(dt)`, then `hud.updateFpvStory(story.state)`.
// `story.onSfx` mirrors fpv.onSfx into `audio.playFpvSfx`.

import { BUILDING_NAMES, TRAIN_ORDER, UNITS } from "../shared/gamedefs";
import type { EntKind, UnitKind, UnitDomain } from "../shared/gamedefs";
import type { GameEvent } from "../shared/protocol";
import { isBuildingKind } from "./util";
import type { FpvTelemetry } from "./fpv";

export type FpvFeedTone = "info" | "good" | "warn" | "kill" | "medal" | "radio";

export interface FpvFeedLine {
  text: string;
  tone: FpvFeedTone;
  age: number; // seconds since posted; HUD fades lines out toward FEED_LIFE_S
}

export interface FpvObjectiveState {
  text: string;
  prog: number;
  total: number;
  done: boolean;
}

/** Read-only view of the director — treated as immutable, mutated in place each tick. */
export interface FpvStoryState {
  feed: FpvFeedLine[]; // oldest first, newest last; capped at FEED_CAP
  objective: FpvObjectiveState | null;
  kills: number; // total confirmed kills this sortie
  streak: number; // chained kills within STREAK_WINDOW seconds (0 = none)
  medals: string[]; // medal names earned so far, in order
  hitmark: number; // 0..1 hitmarker flash timer (1 = just confirmed)
  lockMsg: string; // "LOCK 62%" while acquiring, "◈ LOCKED", else ""
}

export interface FpvEventCtx {
  myId: number; // the fpv.entId we are driving (-1 when none)
  kindOf: (id: number) => EntKind | undefined; // resolves even freshly-killed ents
}

const FEED_CAP = 5;
const FEED_LIFE_S = 5.0;
const STREAK_WINDOW_S = 8.0;
const HITMARK_DECAY_S = 0.4;
const CHATTER_IDLE_S = 25;
const CHATTER_GAP_S = 25;
const WARN_GAP_S = 10;

const STREAK_NAMES = ["", "", "DOUBLE KILL", "TRIPLE KILL", "RAMPAGE", "UNSTOPPABLE"];

/** Kill-chain callout for a streak count ("" below 2). Shared with the HUD chip. */
export function fpvStreakName(streak: number): string {
  return streak >= 2 ? STREAK_NAMES[Math.min(Math.floor(streak), STREAK_NAMES.length - 1)] : "";
}

// Per-kind entry bark — radio personality for every drivable unit.
const ENTRY_BARKS: Partial<Record<UnitKind, string>> = {
  infantry: "Boots down, weapon hot.",
  engineer: "Kit's packed. Point me at something to take.",
  rocket: "Tubes loaded. Say the word, Commander.",
  fpvdrone: "Terminal guidance online. Fly fast, hit hard.",
  tank: "Armor rolling out. Good hunting, Commander.",
  arty: "Gun laid in. Fire mission standing by.",
  heavy: "Heavy armor on the move. Nothing stops us.",
  spider: "All eight legs spinning. Let's crawl.",
  himars: "Launcher hot. Send the grid coordinates.",
  railtank: "Capacitors charged. Rail's humming.",
  supplytruck: "Logistics run started. Keep the line fed.",
  harvester: "Scoop's turning. Let's get rich.",
  uav: "Eyes in the sky. Painting targets.",
  shahed: "Loiter profile set. Hunting pattern live.",
  ewdrone: "Jamming array live. They're flying blind.",
  interceptor: "Sensors up. Boresight clear.",
  chopper: "Rotors at speed. Nap-of-the-earth.",
  a10: "Gun's spinning. Time to brrrt.",
  ac130: "Gunship on station. Rain fire.",
  bomber: "Bomb bay loaded. Delivery inbound.",
  stealthbomber: "Running silent. They won't see it coming.",
  hypersonic: "Boost phase nominal. Going terminal.",
  zeppelin: "Airship underway. Slow and dreadful.",
  usv: "Bow cam live. Send her in.",
  gunboat: "Deck gun manned. River rat on patrol.",
  destroyer: "Bridge crew ready. Guns hot.",
  sub: "Diving stations. Silent running.",
  dreadnought: "Missile tubes flooded. Holding launch authority.",
  carrier: "Flight deck cycling. Wings ready.",
};

const DOMAIN_BARKS: Record<UnitDomain, string> = {
  land: "Systems green. Weapons free.",
  air: "Wings up. Good hunting.",
  sea: "Stations manned. Steady as she goes.",
};

// Idle flavor radio lines, rotated per domain when nothing is happening.
const CHATTER: Record<UnitDomain, string[]> = {
  land: [
    "All quiet on this sector... for now.",
    "Command, holding position. Any tasking?",
    "Dust, diesel and daylight. Nice day for it.",
    "Movement reported on the ridge — eyes up.",
  ],
  air: [
    "Fuel state nominal. Still no bandits.",
    "Airspace clear. Making another pass.",
    "Nothing on scope but clouds and courage.",
    "Holding pattern — say your tasking, over.",
  ],
  sea: [
    "Sea state calm. Sonar quiet.",
    "All stations report ready. Waiting on you, sir.",
    "Just us and the horizon out here.",
    "Depth steady. Listening for contacts.",
  ],
};

interface ObjectiveStage {
  id: "shot" | "firstblood" | "hunter" | "saboteur" | "ace";
  title: string;
  desc: string;
  total: number;
  medal: string;
}

// The sortie ladder — completion posts a feed line + awards a named medal.
const OBJECTIVE_LADDER: ObjectiveStage[] = [
  { id: "shot", title: "BOOT CAMP", desc: "FIRE YOUR WEAPON", total: 1, medal: "Live Fire" },
  { id: "firstblood", title: "FIRST BLOOD", desc: "DESTROY AN ENEMY", total: 1, medal: "Blooded" },
  { id: "hunter", title: "HUNTER", desc: "DESTROY 3 ENEMIES", total: 3, medal: "Hunter" },
  { id: "saboteur", title: "SABOTEUR", desc: "DESTROY 2 ENEMY BUILDINGS", total: 2, medal: "Saboteur" },
  { id: "ace", title: "ACE", desc: "DESTROY 7 ENEMIES", total: 7, medal: "Ace" },
];

function entLabel(k: EntKind): string {
  if (isBuildingKind(k)) return BUILDING_NAMES[k];
  return TRAIN_ORDER.find((u) => u.unit === k)?.label ?? k;
}

export class FpvStory {
  /** Sound cues into audio.playFpvSfx — emits "radio" | "warn" | "medal" | "objective" |
   *  "kill" | "hitmark" | "lock" | "locked" | "lost". No-op until wired. */
  onSfx: (name: string) => void = () => {};

  private _state: FpvStoryState = {
    feed: [],
    objective: null,
    kills: 0,
    streak: 0,
    medals: [],
    hitmark: 0,
    lockMsg: "",
  };

  // Persistent objective record — mutated in place so state stays alloc-free
  private readonly obj: FpvObjectiveState = { text: "", prog: 0, total: 1, done: false };

  private now = 0; // story clock, advanced by tick()
  private domain: UnitDomain = "land";
  private stageIdx = 0;
  private warHeroDone = false;
  private shotsFired = 0;
  private kills = 0;
  private buildingKills = 0;
  private lastKillAt = -999;
  private lastActionAt = 0;
  private lastChatterAt = 0;
  private chatterIdx = 0;
  private warnHpAt = -999;
  private warnFuelAt = -999;
  private warnAmmoAt = -999;
  private aimTargetId = -1;
  private prevLock: FpvTelemetry["lockState"] = "none";

  get state(): FpvStoryState {
    return this._state;
  }

  /** Start a fresh sortie — call when entering first-person on `kind`. */
  reset(kind: UnitKind, callsign?: string): void {
    this.domain = UNITS[kind].domain;
    this.now = 0;
    this.stageIdx = 0;
    this.warHeroDone = false;
    this.shotsFired = 0;
    this.kills = 0;
    this.buildingKills = 0;
    this.lastKillAt = -999;
    this.lastActionAt = 0;
    this.lastChatterAt = 0;
    this.chatterIdx = 0;
    this.warnHpAt = -999;
    this.warnFuelAt = -999;
    this.warnAmmoAt = -999;
    this.aimTargetId = -1;
    this.prevLock = "none";
    const s = this._state;
    s.feed.length = 0;
    s.kills = 0;
    s.streak = 0;
    s.medals.length = 0;
    s.hitmark = 0;
    s.lockMsg = "";
    this.syncObjective();

    const bark = ENTRY_BARKS[kind] ?? DOMAIN_BARKS[this.domain];
    const who = callsign && callsign.trim() ? callsign.trim().toUpperCase() : "CONTROL";
    this.push(`${who} · ${bark}`, "radio");
  }

  /** Feed one snapshot GameEvent — call for every event while FPV is active. */
  onEvent(ev: GameEvent, ctx: FpvEventCtx): void {
    if (ctx.myId < 0) return;
    if (ev.e === "shot" && ev.src === ctx.myId) {
      this.shotsFired++;
      this.lastActionAt = this.now;
      this.syncObjective();
    } else if (ev.e === "kill" && ev.src === ctx.myId) {
      this.kills++;
      this.lastActionAt = this.now;
      this._state.kills = this.kills;
      this._state.hitmark = 1;
      this.sfx("hitmark");
      this.sfx("kill");

      // Chain streaks: kills within STREAK_WINDOW of the previous one count up
      const chained = this.now - this.lastKillAt <= STREAK_WINDOW_S;
      this._state.streak = chained ? this._state.streak + 1 : 1;
      this.lastKillAt = this.now;

      const victim = ctx.kindOf(ev.id);
      const building = victim !== undefined && isBuildingKind(victim);
      const vname = victim ? entLabel(victim).toUpperCase() : "HOSTILE";
      this.push(building ? `STRUCTURE DESTROYED — ${vname}` : `TARGET DOWN — ${vname}`, "kill");
      if (this._state.streak >= 2) {
        this.push(`${fpvStreakName(this._state.streak)} ×${this._state.streak}`, "kill");
      }
      if (building) this.buildingKills++;
      this.syncObjective();
    } else if (ev.e === "hit" && this.aimTargetId >= 0 && ev.id === this.aimTargetId) {
      // Confirmed hit on whatever we're aiming at
      this._state.hitmark = 1;
      this.sfx("hitmark");
    }
  }

  /** Advance the story clock, feed aging, hitmarker decay, lock readout,
   *  warnings and idle chatter — call every frame with fpv telemetry. */
  tick(dt: number, tel: FpvTelemetry | null): void {
    const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
    this.now += d;
    const s = this._state;

    const feed = s.feed;
    for (let i = feed.length - 1; i >= 0; i--) {
      feed[i].age += d;
      if (feed[i].age >= FEED_LIFE_S) feed.splice(i, 1);
    }
    if (s.hitmark > 0) s.hitmark = Math.max(0, s.hitmark - d / HITMARK_DECAY_S);
    if (s.streak > 0 && this.now - this.lastKillAt > STREAK_WINDOW_S) s.streak = 0;
    if (!tel) return;
    this.aimTargetId = tel.target?.id ?? -1;

    // Missile/guided lock readout + transition sounds
    const ls = tel.lockState;
    if (ls === "locked") s.lockMsg = "◈ LOCKED";
    else if (ls === "locking") s.lockMsg = `LOCK ${Math.round(Math.min(1, Math.max(0, tel.lockPct)) * 100)}%`;
    else s.lockMsg = "";
    if (ls !== this.prevLock) {
      if (ls === "locking") this.sfx("lock");
      else if (ls === "locked") this.sfx("locked");
      else if (this.prevLock !== "none") this.sfx("lost");
      this.prevLock = ls;
    }

    // Rate-limited critical warnings
    if (tel.mhp > 0 && tel.hp / tel.mhp < 0.3 && this.now - this.warnHpAt >= WARN_GAP_S) {
      this.warnHpAt = this.now;
      this.push("⚠ WARNING: HULL INTEGRITY CRITICAL", "warn");
    }
    if (tel.fuel !== undefined && tel.fuel < 15 && this.now - this.warnFuelAt >= WARN_GAP_S) {
      this.warnFuelAt = this.now;
      this.push("FUEL LOW — RTB ADVISED", "warn");
    }
    if (tel.ammo !== undefined && tel.ammo < 15 && this.now - this.warnAmmoAt >= WARN_GAP_S) {
      this.warnAmmoAt = this.now;
      this.push("GUNS DRY SOON — FIND A SUPPLY LINE", "warn");
    }

    // Idle radio chatter — one flavor line at a time when the sortie goes quiet
    if (this.now - this.lastActionAt >= CHATTER_IDLE_S && this.now - this.lastChatterAt >= CHATTER_GAP_S) {
      this.lastChatterAt = this.now;
      const pool = CHATTER[this.domain];
      this.push(pool[this.chatterIdx++ % pool.length], "radio");
    }
  }

  private push(text: string, tone: FpvFeedTone): void {
    const feed = this._state.feed;
    feed.push({ text, tone, age: 0 });
    while (feed.length > FEED_CAP) feed.shift();
    // Tone-to-sound mapping: radio squelch, warning klaxon & medal chime ride the feed
    if (tone === "radio" || tone === "warn" || tone === "medal") this.sfx(tone);
  }

  private sfx(name: string): void {
    this.onSfx(name);
  }

  private stageProgress(): number {
    const st = OBJECTIVE_LADDER[this.stageIdx];
    if (!st) return 0;
    switch (st.id) {
      case "shot":
        // Kamikaze platforms never emit a "shot" event — a kill proves weapon use
        return Math.min(this.shotsFired + this.kills, st.total);
      case "saboteur":
        return Math.min(this.buildingKills, st.total);
      default:
        return Math.min(this.kills, st.total);
    }
  }

  private syncObjective(): void {
    // Advance through every completed rung — a single kill can clear several
    while (this.stageIdx < OBJECTIVE_LADDER.length && this.stageProgress() >= OBJECTIVE_LADDER[this.stageIdx].total) {
      const st = OBJECTIVE_LADDER[this.stageIdx++];
      this._state.medals.push(st.medal);
      this.push(`OBJECTIVE COMPLETE — ${st.title}`, "good");
      this.push(`★ MEDAL EARNED: ${st.medal.toUpperCase()}`, "medal");
      this.sfx("objective");
    }
    const s = this._state;
    if (this.stageIdx < OBJECTIVE_LADDER.length) {
      const st = OBJECTIVE_LADDER[this.stageIdx];
      this.obj.text = `${st.title} — ${st.desc}`;
      this.obj.prog = this.stageProgress();
      this.obj.total = st.total;
      this.obj.done = false;
    } else {
      this.obj.text = "WAR HERO — CAMPAIGN COMPLETE";
      this.obj.prog = 1;
      this.obj.total = 1;
      this.obj.done = true;
      if (!this.warHeroDone) {
        this.warHeroDone = true;
        s.medals.push("War Hero");
        this.push("★ MEDAL EARNED: WAR HERO", "medal");
      }
    }
    s.objective = this.obj;
  }
}
