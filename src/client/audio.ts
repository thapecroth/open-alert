import type { WeaponFx } from "../shared/protocol";

export type UiSfx =
  | "select"
  | "move"
  | "attack"
  | "buildStart"
  | "buildDone"
  | "place"
  | "deny"
  | "cash"
  | "promote"
  | "crate"
  | "alert"
  | "cap"
  | "upgrade"
  | "recon"
  | "ewjam"
  | "hold"
  | "powerDown"
  | "powerUp"
  | "win"
  | "lose";

const MUTE_KEY = "oa-mute";
const MUSIC_KEY = "oa-music";

const SFX_GAIN = 0.56;
const MUSIC_GAIN = 0.16;

// 122 BPM, 16th-note grid
const BPM = 122;
const STEP_SEC = 60 / BPM / 4;
const LOOKAHEAD_SEC = 0.12;

// D minor industrial-RTS palette (Hz)
const N = {
  D1: 36.71,
  A1: 55.0,
  Bb1: 58.27,
  C2: 65.41,
  D2: 73.42,
  E2: 82.41,
  F2: 87.31,
  G2: 98.0,
  Ab2: 103.83,
  A2: 110.0,
  Bb2: 116.54,
  C3: 130.81,
  D3: 146.83,
  E3: 164.81,
  F3: 174.61,
  G3: 196.0,
  A3: 220.0,
  Bb3: 233.08,
  C4: 261.63,
  D4: 293.66,
  E4: 329.63,
  F4: 349.23,
  Fs4: 369.99,
  G4: 392.0,
  A4: 440.0,
  Bb4: 466.16,
  B4: 493.88,
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  Fs5: 739.99,
  A5: 880.0,
  D6: 1174.66,
  E6: 1318.51,
} as const;

// 64-step (4-bar) dark industrial D-minor bassline (0 = rest)
const BASS_SEQ: readonly number[] = [
  // Bar 1: Driving D minor chug
  N.D2, 0, N.D2, N.D2, 0, N.D2, N.F2, 0, N.D2, 0, N.D2, 0, N.G2, 0, N.F2, 0,
  // Bar 2: Rising fifth & minor sixth tension
  N.D2, 0, N.D2, N.D2, 0, N.D2, N.A2, 0, N.Bb2, 0, N.A2, 0, N.G2, 0, N.F2, N.E2,
  // Bar 3: Heavy tritone industrial grit
  N.D2, 0, N.D2, N.D2, 0, N.D2, N.F2, 0, N.G2, 0, N.Ab2, 0, N.G2, 0, N.F2, 0,
  // Bar 4: March turnaround (Bb -> C -> A)
  N.Bb1, 0, N.Bb2, 0, N.C2, 0, N.C3, 0, N.A2, 0, N.A2, N.G2, N.F2, 0, N.E2, 0,
];

// Combat distorted power-chord stab roots per 64 steps (0 = rest)
const STAB_SEQ: readonly number[] = [
  // Bar 1
  N.D3, 0, 0, 0, 0, 0, N.D3, 0, 0, 0, N.F3, 0, 0, 0, N.E3, 0,
  // Bar 2
  N.D3, 0, 0, 0, 0, 0, N.A2, 0, N.Bb2, 0, 0, 0, N.G2, 0, 0, 0,
  // Bar 3
  N.D3, 0, 0, N.D3, 0, 0, N.F3, 0, 0, 0, N.G3, 0, 0, 0, N.F3, 0,
  // Bar 4
  N.Bb2, 0, 0, 0, N.C3, 0, 0, 0, N.A2, 0, N.A2, 0, N.A2, 0, N.G2, 0,
];

// Pad roots per bar of the 4-bar loop (matches BASS_SEQ's implied progression)
const PAD_ROOTS: readonly number[] = [N.D2, N.Bb1, N.G2, N.C2];

// Sparse dark-minor lead motif for low-intensity play — [step, freq, durSteps].
// Two alternate phrases cycled by loop parity so successive loops differ.
const MOTIF_A: readonly (readonly [number, number, number])[] = [
  [24, N.D4, 2],
  [26, N.F4, 1],
  [27, N.E4, 2],
  [30, N.C4, 3],
  [56, N.Bb3, 2],
  [58, N.A3, 2],
  [60, N.D4, 4],
];
const MOTIF_B: readonly (readonly [number, number, number])[] = [
  [24, N.A3, 2],
  [26, N.C4, 1],
  [27, N.D4, 2],
  [30, N.F4, 3],
  [56, N.E4, 2],
  [58, N.F4, 2],
  [60, N.G4, 4],
];

// High-intensity combat 16th-note urgent arp (64 steps)
const ARP_SEQ: readonly number[] = [
  // Bar 1 (Dm)
  N.D4, N.F4, N.A4, N.D5, N.A4, N.F4, N.D4, N.A4, N.D4, N.F4, N.A4, N.Bb4, N.A4, N.F4, N.E4, N.A4,
  // Bar 2 (Dm -> Bb -> Gm)
  N.D4, N.F4, N.A4, N.D5, N.A4, N.F4, N.E4, N.A4, N.Bb4, N.F4, N.D4, N.F4, N.G4, N.Bb4, N.A4, N.G4,
  // Bar 3 (Dm tension)
  N.D4, N.F4, N.A4, N.D5, N.C5, N.A4, N.F4, N.A4, N.G4, N.Bb4, N.A4, N.G4, N.F4, N.E4, N.D4, N.F4,
  // Bar 4 (Bb -> C -> A7)
  N.Bb3, N.D4, N.F4, N.Bb4, N.C4, N.E4, N.G4, N.C5, N.A4, N.G4, N.F4, N.E4, N.A4, N.E4, N.G4, N.E4,
];

type AudioCtxCtor = typeof AudioContext;

function getAudioCtxCtor(): AudioCtxCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioCtxCtor;
    webkitAudioContext?: AudioCtxCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function readStorage(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, val: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, val);
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function makeWhiteNoise(ctx: AudioContext, seconds = 2.0): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buf;
}

function makePinkNoise(ctx: AudioContext, seconds = 2.0): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Paul Kellet's refined pink noise filter
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.13;
    b6 = white * 0.115926;
    data[i] = clamp(pink, -1, 1);
  }
  return buf;
}

function makeDriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 512;
  const curve = new Float32Array(samples);
  const k = Math.max(1, amount);
  const norm = Math.tanh(k);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.tanh(x * k) / norm;
  }
  return curve;
}

export class AudioEngine {
  muted: boolean;
  musicOn: boolean;

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;

  private whiteNoise: AudioBuffer | null = null;
  private pinkNoise: AudioBuffer | null = null;
  private softDrive: Float32Array<ArrayBuffer> | null = null;
  private hardDrive: Float32Array<ArrayBuffer> | null = null;

  // Rate-limiting map keyed by SFX category -> ctx.currentTime
  private lastPlayed = new Map<string, number>();
  private lastBoomRadius = 0;

  // Adaptive soundtrack state
  private targetCombat = 0;
  private combatBlend = 0;
  private combatHold = 0;
  private stepIndex = 0;
  private nextStepTime = 0;
  private musicDuckUntil = 0;
  // Incremented each time the 64-step sequence wraps — drives A/B loop variation
  private cycleCount = 0;

  constructor() {
    this.muted = readStorage(MUTE_KEY) === "1";
    this.musicOn = readStorage(MUSIC_KEY) !== "0";
  }

  /**
   * Lazily initializes and resumes the AudioContext on the first user gesture.
   * Safe to call repeatedly and safe in headless/restricted environments.
   */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = getAudioCtxCtor();
        if (!Ctor) return;
        const ctx = new Ctor();
        this.ctx = ctx;

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -14;
        compressor.knee.value = 18;
        compressor.ratio.value = 8;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.16;

        const masterGain = ctx.createGain();
        masterGain.gain.value = this.muted ? 0 : 1;

        const sfxBus = ctx.createGain();
        sfxBus.gain.value = SFX_GAIN;

        const musicBus = ctx.createGain();
        musicBus.gain.value = this.musicOn ? MUSIC_GAIN : 0;

        sfxBus.connect(compressor);
        musicBus.connect(compressor);
        compressor.connect(masterGain);
        masterGain.connect(ctx.destination);

        this.compressor = compressor;
        this.masterGain = masterGain;
        this.sfxBus = sfxBus;
        this.musicBus = musicBus;

        this.whiteNoise = makeWhiteNoise(ctx, 2.0);
        this.pinkNoise = makePinkNoise(ctx, 2.0);
        this.softDrive = makeDriveCurve(2.4);
        this.hardDrive = makeDriveCurve(6.5);
        this.nextStepTime = ctx.currentTime + 0.05;

        // Continuous ambient drone bed beneath the step sequencer. Routes
        // through musicBus so it obeys the music toggle, mute and ducking.
        this.startDrone(ctx, musicBus);
      }

      if (this.ctx.state === "suspended") {
        void this.ctx.resume().catch(() => {});
      }
      this.syncBusGains();
    } catch {
      // Never throw if browser blocks or lacks Web Audio
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    writeStorage(MUTE_KEY, this.muted ? "1" : "0");
    this.syncBusGains();
    if (!this.muted && this.ctx && this.ctx.state === "running") {
      this.nextStepTime = this.ctx.currentTime + 0.04;
    }
    return this.muted;
  }

  toggleMusic(): boolean {
    this.musicOn = !this.musicOn;
    this.musicDuckUntil = 0;
    writeStorage(MUSIC_KEY, this.musicOn ? "1" : "0");
    this.syncBusGains();
    if (this.musicOn && this.ctx && this.ctx.state === "running") {
      this.nextStepTime = this.ctx.currentTime + 0.04;
    }
    return this.musicOn;
  }

  /**
   * Raises combat intensity for the adaptive soundtrack.
   * Smoothly transitions from base-building groove into full industrial combat.
   */
  noteCombat(intensity = 0.25): void {
    const amt = clamp(intensity, 0.02, 1);
    this.targetCombat = clamp(Math.max(this.targetCombat + amt * 0.55, amt), 0, 1);
    this.combatHold = Math.max(this.combatHold, 3.2);
  }

  /**
   * Advances adaptive soundtrack modulation and lookahead step sequencer.
   * Call once per animation frame with delta seconds.
   */
  update(dt: number): void {
    const safeDt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);

    // Decay combat energy smoothly after combat hold window expires
    if (this.combatHold > 0) {
      this.combatHold = Math.max(0, this.combatHold - safeDt);
    } else if (this.targetCombat > 0) {
      this.targetCombat = Math.max(0, this.targetCombat - safeDt * 0.16);
    }

    const slew = this.targetCombat > this.combatBlend ? 1.8 : 0.45;
    this.combatBlend += (this.targetCombat - this.combatBlend) * Math.min(1, safeDt * slew);
    if (this.combatBlend < 0.002 && this.targetCombat === 0) {
      this.combatBlend = 0;
    }

    const ctx = this.ctx;
    if (!ctx || !this.musicBus || !this.musicOn || this.muted || ctx.state !== "running") {
      return;
    }

    const now = ctx.currentTime;
    // Restore music ducking smoothly after superweapon
    if (this.musicDuckUntil > 0 && now >= this.musicDuckUntil) {
      this.musicDuckUntil = 0;
      this.syncBusGains();
    }

    // Prevent catch-up bursts after tab switch or pause
    if (this.nextStepTime < now - 0.05 || this.nextStepTime > now + 1.0) {
      this.nextStepTime = now + 0.03;
    }

    while (this.nextStepTime < now + LOOKAHEAD_SEC) {
      this.scheduleMusicStep(ctx, this.musicBus, this.stepIndex, this.nextStepTime, this.combatBlend);
      this.nextStepTime += STEP_SEC;
      this.stepIndex = (this.stepIndex + 1) & 63;
      if (this.stepIndex === 0) this.cycleCount++;
    }
  }

  playShot(weapon: WeaponFx = "bullet", vet = 0): void {
    const ctx = this.readySfxCtx();
    if (!ctx || !this.sfxBus) return;

    const minGap =
      weapon === "bullet"
        ? 0.055
        : weapon === "cannon"
          ? 0.065
          : weapon === "rocket"
            ? 0.075
            : weapon === "arty" || weapon === "bomb"
              ? 0.09
              : weapon === "missile" || weapon === "torpedo" || weapon === "railgun"
                ? 0.085
                : weapon === "laser"
                  ? 0.08
                  : weapon === "brrrt"
                    ? 0.16
                    : weapon === "intercept"
                      ? 0.06
                      : weapon === "arc"
                        ? 0.07
                        : 0.065;

    if (!this.allow(`shot:${weapon}`, minGap, ctx.currentTime)) return;

    const now = ctx.currentTime;
    const jitter = 0.94 + Math.random() * 0.12;
    const heroic = vet >= 3;

    try {
      switch (weapon) {
        case "bullet":
          this.synthBullet(ctx, this.sfxBus, now, jitter, heroic);
          break;
        case "cannon":
          this.synthCannon(ctx, this.sfxBus, now, jitter, heroic);
          break;
        case "rocket":
          this.synthRocket(ctx, this.sfxBus, now, jitter, heroic);
          break;
        case "arty":
          this.synthArty(ctx, this.sfxBus, now, jitter, heroic);
          break;
        case "arc":
          this.synthArc(ctx, this.sfxBus, now, jitter, heroic);
          break;
        case "melee":
          this.synthMelee(ctx, this.sfxBus, now, jitter, heroic);
          break;
        case "missile":
          this.synthMissile(ctx, this.sfxBus, now, jitter, heroic);
          break;
        case "torpedo":
          this.synthTorpedo(ctx, this.sfxBus, now, jitter, heroic);
          break;
        case "bomb":
          this.synthBomb(ctx, this.sfxBus, now, jitter, heroic);
          break;
        case "laser":
          this.synthLaser(ctx, this.sfxBus, now, jitter, heroic);
          break;
        case "railgun":
          this.synthRailgun(ctx, this.sfxBus, now, jitter, heroic);
          break;
        case "brrrt":
          this.synthBrrrt(ctx, this.sfxBus, now, jitter, heroic);
          break;
        case "intercept":
          this.synthIntercept(ctx, this.sfxBus, now, jitter, heroic);
          break;
      }
      if (heroic) {
        this.synthHeroicOvertone(ctx, this.sfxBus, now, weapon, jitter);
      }
    } catch {
      // Ignore transient Web Audio errors
    }
  }

  playBoom(radius = 1): void {
    const ctx = this.readySfxCtx();
    if (!ctx || !this.sfxBus) return;

    const now = ctx.currentTime;
    const r = clamp(Number.isFinite(radius) ? radius : 1, 0.4, 4.5);
    const prev = this.lastPlayed.get("boom") ?? -999;
    const elapsed = now - prev;

    // Rate-limit booms to 70ms, but let a substantially bigger explosion cut through after 32ms
    const bigOverride = r >= 2.1 && r > this.lastBoomRadius + 0.6 && elapsed >= 0.032;
    if (elapsed < 0.07 && !bigOverride) return;

    this.lastPlayed.set("boom", now);
    this.lastBoomRadius = r;

    const scale = clamp((r - 0.5) / 3.0, 0, 1);
    const dur = 0.36 + scale * 0.54;
    const vol = 0.34 + scale * 0.34;

    try {
      const bus = this.sfxBus;

      // 1. Sub-bass impact drop (95Hz -> 24Hz)
      const sub = ctx.createOscillator();
      const subG = ctx.createGain();
      sub.type = "sine";
      sub.frequency.setValueAtTime(95 - scale * 12, now);
      sub.frequency.exponentialRampToValueAtTime(24, now + dur * 0.85);
      subG.gain.setValueAtTime(0.0001, now);
      subG.gain.linearRampToValueAtTime(vol * 0.95, now + 0.008);
      subG.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      sub.connect(subG);
      subG.connect(bus);
      sub.start(now);
      sub.stop(now + dur + 0.02);

      // 2. Chest-punch mid body so explosions cut through small speakers
      const punch = ctx.createOscillator();
      const punchG = ctx.createGain();
      punch.type = "triangle";
      punch.frequency.setValueAtTime(165, now);
      punch.frequency.exponentialRampToValueAtTime(36, now + 0.11 + scale * 0.06);
      punchG.gain.setValueAtTime(0.0001, now);
      punchG.gain.linearRampToValueAtTime(vol * 0.5, now + 0.004);
      punchG.gain.exponentialRampToValueAtTime(0.0001, now + 0.13 + scale * 0.07);
      punch.connect(punchG);
      punchG.connect(bus);
      punch.start(now);
      punch.stop(now + 0.22);

      // 3. Lowpass-filtered noise roar
      if (this.pinkNoise) {
        const roar = this.makeNoiseSource(ctx, this.pinkNoise);
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.Q.value = 1.1;
        lp.frequency.setValueAtTime(1150 + scale * 950, now);
        lp.frequency.exponentialRampToValueAtTime(140, now + dur);

        const roarG = ctx.createGain();
        roarG.gain.setValueAtTime(0.0001, now);
        roarG.gain.linearRampToValueAtTime(vol * 0.88, now + 0.012);
        roarG.gain.exponentialRampToValueAtTime(0.0001, now + dur);

        roar.connect(lp);
        lp.connect(roarG);
        roarG.connect(bus);
        roar.start(now);
        roar.stop(now + dur + 0.02);
      }

      // 4. High-frequency debris crackle tail
      if (this.whiteNoise) {
        const crackleDur = 0.22 + scale * 0.42;
        const crackle = this.makeNoiseSource(ctx, this.whiteNoise);
        const hp = ctx.createBiquadFilter();
        hp.type = "bandpass";
        hp.frequency.setValueAtTime(2400, now);
        hp.frequency.exponentialRampToValueAtTime(950, now + crackleDur);
        hp.Q.value = 1.2;

        const cg = ctx.createGain();
        cg.gain.setValueAtTime(0.0001, now);
        cg.gain.linearRampToValueAtTime(vol * 0.32, now + 0.006);
        cg.gain.exponentialRampToValueAtTime(vol * 0.12, now + 0.055);
        cg.gain.linearRampToValueAtTime(vol * 0.2, now + 0.09);
        cg.gain.exponentialRampToValueAtTime(0.0001, now + crackleDur);

        crackle.connect(hp);
        hp.connect(cg);
        cg.connect(bus);
        crackle.start(now);
        crackle.stop(now + crackleDur + 0.02);
      }

      // 5. Pressure-wave shock snap at the very onset
      if (this.whiteNoise) {
        const snap = this.makeNoiseSource(ctx, this.whiteNoise);
        const sbp = ctx.createBiquadFilter();
        sbp.type = "bandpass";
        sbp.Q.value = 0.9;
        sbp.frequency.setValueAtTime(3300, now);
        sbp.frequency.exponentialRampToValueAtTime(1500, now + 0.045);
        const sg = ctx.createGain();
        sg.gain.setValueAtTime(0.0001, now);
        sg.gain.linearRampToValueAtTime(0.2 + scale * 0.18, now + 0.002);
        sg.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
        snap.connect(sbp);
        sbp.connect(sg);
        sg.connect(bus);
        snap.start(now, Math.random() * 1.2);
        snap.stop(now + 0.06);
      }

      // 6. Rolling secondary rumble — big explosions keep moving air
      if (scale > 0.5 && this.pinkNoise) {
        const rumbleAt = now + 0.12;
        const rumbleDur = 0.9 + scale * 0.5;
        const rumble = this.makeNoiseSource(ctx, this.pinkNoise);
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.Q.value = 0.8;
        lp.frequency.setValueAtTime(270, rumbleAt);
        lp.frequency.exponentialRampToValueAtTime(55, rumbleAt + rumbleDur);
        const rg = ctx.createGain();
        rg.gain.setValueAtTime(0.0001, rumbleAt);
        rg.gain.linearRampToValueAtTime(0.24 * scale, rumbleAt + 0.09);
        rg.gain.exponentialRampToValueAtTime(0.0001, rumbleAt + rumbleDur);
        rumble.connect(lp);
        lp.connect(rg);
        rg.connect(bus);
        rumble.start(rumbleAt, Math.random() * 1.2);
        rumble.stop(rumbleAt + rumbleDur + 0.02);
      }
    } catch {
      // Ignore transient Web Audio errors
    }
  }

  playSuperweapon(): void {
    const ctx = this.readySfxCtx();
    if (!ctx || !this.sfxBus) return;

    const now = ctx.currentTime;
    if (!this.allow("superweapon", 0.4, now)) return;

    // Nuclear ICBM strike spikes battle intensity and ducks music dramatically
    this.noteCombat(1.0);
    if (this.musicBus && this.musicOn) {
      this.musicBus.gain.cancelScheduledValues(now);
      this.musicBus.gain.setTargetAtTime(MUSIC_GAIN * 0.2, now, 0.08);
      this.musicDuckUntil = now + 2.95;
    }

    try {
      const bus = this.sfxBus;
      const impactAt = now + 0.75;
      const blastDur = 2.35;
      const blastEnd = impactAt + blastDur;

      // ===== PHASE 1 (0..0.75s): Chilling descending ICBM missile shriek + air-raid alarm pulse =====
      // 1a. Dual pulsing civil-defense air-raid klaxon siren
      const sirenFilter = ctx.createBiquadFilter();
      sirenFilter.type = "bandpass";
      sirenFilter.Q.value = 3.2;
      sirenFilter.frequency.setValueAtTime(920, now);
      sirenFilter.frequency.linearRampToValueAtTime(1480, now + 0.36);
      sirenFilter.frequency.linearRampToValueAtTime(860, impactAt);

      const sirenGain = ctx.createGain();
      sirenGain.gain.setValueAtTime(0.0001, now);
      sirenGain.gain.linearRampToValueAtTime(0.24, now + 0.06);
      sirenGain.gain.linearRampToValueAtTime(0.09, now + 0.24);
      sirenGain.gain.linearRampToValueAtTime(0.26, now + 0.44);
      sirenGain.gain.linearRampToValueAtTime(0.11, now + 0.62);
      sirenGain.gain.exponentialRampToValueAtTime(0.0001, impactAt + 0.03);

      sirenFilter.connect(sirenGain);
      sirenGain.connect(bus);

      for (const detune of [-12, 12]) {
        const sOsc = ctx.createOscillator();
        sOsc.type = "sawtooth";
        sOsc.detune.value = detune;
        sOsc.frequency.setValueAtTime(520, now);
        sOsc.frequency.linearRampToValueAtTime(860, now + 0.24);
        sOsc.frequency.linearRampToValueAtTime(560, now + 0.44);
        sOsc.frequency.linearRampToValueAtTime(940, impactAt);
        sOsc.connect(sirenFilter);
        sOsc.start(now);
        sOsc.stop(impactAt + 0.05);
      }

      // 1b. Descending supersonic ICBM re-entry Doppler shriek (2950Hz -> 310Hz)
      const shriekOsc = ctx.createOscillator();
      const shriekG = ctx.createGain();
      shriekOsc.type = "sine";
      shriekOsc.frequency.setValueAtTime(2950, now);
      shriekOsc.frequency.exponentialRampToValueAtTime(310, impactAt);
      shriekG.gain.setValueAtTime(0.0001, now);
      shriekG.gain.exponentialRampToValueAtTime(0.22, now + 0.56);
      shriekG.gain.linearRampToValueAtTime(0.3, impactAt - 0.02);
      shriekG.gain.exponentialRampToValueAtTime(0.0001, impactAt + 0.03);
      shriekOsc.connect(shriekG);
      shriekG.connect(bus);
      shriekOsc.start(now);
      shriekOsc.stop(impactAt + 0.04);

      if (this.whiteNoise) {
        const reentry = this.makeNoiseSource(ctx, this.whiteNoise);
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.Q.value = 3.8;
        bp.frequency.setValueAtTime(3400, now);
        bp.frequency.exponentialRampToValueAtTime(420, impactAt);

        const rg = ctx.createGain();
        rg.gain.setValueAtTime(0.0001, now);
        rg.gain.exponentialRampToValueAtTime(0.28, impactAt - 0.03);
        rg.gain.exponentialRampToValueAtTime(0.0001, impactAt + 0.03);

        reentry.connect(bp);
        bp.connect(rg);
        rg.connect(bus);
        reentry.start(now);
        reentry.stop(impactAt + 0.04);
      }

      // ===== PHASE 2 (0.75s..3.1s): Colossal deep seismic thermonuclear detonation boom =====
      // 2a. Massive sub-seismic earth-shaker drop (115Hz -> 18Hz)
      const sub = ctx.createOscillator();
      const subG = ctx.createGain();
      sub.type = "sine";
      sub.frequency.setValueAtTime(115, impactAt);
      sub.frequency.exponentialRampToValueAtTime(26, impactAt + 0.65);
      sub.frequency.exponentialRampToValueAtTime(18, blastEnd);
      subG.gain.setValueAtTime(0.0001, impactAt);
      subG.gain.linearRampToValueAtTime(0.95, impactAt + 0.018);
      subG.gain.exponentialRampToValueAtTime(0.54, impactAt + 0.85);
      subG.gain.exponentialRampToValueAtTime(0.0001, blastEnd);
      sub.connect(subG);
      subG.connect(bus);
      sub.start(impactAt);
      sub.stop(blastEnd + 0.04);

      // 2b. Punchy nuclear shock-front transient slam
      const slam = ctx.createOscillator();
      const slamG = ctx.createGain();
      slam.type = "triangle";
      slam.frequency.setValueAtTime(210, impactAt);
      slam.frequency.exponentialRampToValueAtTime(30, impactAt + 0.28);
      slamG.gain.setValueAtTime(0.0001, impactAt);
      slamG.gain.linearRampToValueAtTime(0.68, impactAt + 0.005);
      slamG.gain.exponentialRampToValueAtTime(0.0001, impactAt + 0.34);
      slam.connect(slamG);
      slamG.connect(bus);
      slam.start(impactAt);
      slam.stop(impactAt + 0.36);

      // 2c. Overdriven seismic thermonuclear rumble column
      const rumbleLp = ctx.createBiquadFilter();
      rumbleLp.type = "lowpass";
      rumbleLp.Q.value = 2.4;
      rumbleLp.frequency.setValueAtTime(1950, impactAt);
      rumbleLp.frequency.exponentialRampToValueAtTime(95, blastEnd);

      const shaper = ctx.createWaveShaper();
      if (this.hardDrive) shaper.curve = this.hardDrive;

      const rumbleG = ctx.createGain();
      rumbleG.gain.setValueAtTime(0.0001, impactAt);
      rumbleG.gain.linearRampToValueAtTime(0.42, impactAt + 0.02);
      rumbleG.gain.exponentialRampToValueAtTime(0.22, impactAt + 0.95);
      rumbleG.gain.exponentialRampToValueAtTime(0.0001, blastEnd);

      shaper.connect(rumbleLp);
      rumbleLp.connect(rumbleG);
      rumbleG.connect(bus);

      for (const freq of [N.D1, N.D2, N.A2 * 0.5]) {
        const rOsc = ctx.createOscillator();
        rOsc.type = "sawtooth";
        rOsc.frequency.setValueAtTime(freq * 1.25, impactAt);
        rOsc.frequency.exponentialRampToValueAtTime(freq * 0.62, blastEnd);
        rOsc.connect(shaper);
        rOsc.start(impactAt);
        rOsc.stop(blastEnd + 0.04);
      }

      // 2d. Colossal broadband nuclear shockwave roar (pinkNoise)
      if (this.pinkNoise) {
        const roar = this.makeNoiseSource(ctx, this.pinkNoise);
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.Q.value = 1.4;
        lp.frequency.setValueAtTime(2800, impactAt);
        lp.frequency.exponentialRampToValueAtTime(480, impactAt + 0.7);
        lp.frequency.exponentialRampToValueAtTime(110, blastEnd);

        const rg = ctx.createGain();
        rg.gain.setValueAtTime(0.0001, impactAt);
        rg.gain.linearRampToValueAtTime(0.84, impactAt + 0.02);
        rg.gain.exponentialRampToValueAtTime(0.44, impactAt + 0.85);
        rg.gain.exponentialRampToValueAtTime(0.0001, blastEnd);

        roar.connect(lp);
        lp.connect(rg);
        rg.connect(bus);
        roar.start(impactAt);
        roar.stop(blastEnd + 0.04);
      }

      // 2e. Initial white-hot pressure crack + rolling nuclear shockwave debris tail
      if (this.whiteNoise) {
        const crack = this.makeNoiseSource(ctx, this.whiteNoise);
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.Q.value = 0.9;
        bp.frequency.setValueAtTime(3200, impactAt);
        bp.frequency.exponentialRampToValueAtTime(620, blastEnd - 0.15);

        const cg = ctx.createGain();
        cg.gain.setValueAtTime(0.0001, impactAt);
        cg.gain.linearRampToValueAtTime(0.52, impactAt + 0.006);
        cg.gain.exponentialRampToValueAtTime(0.14, impactAt + 0.24);
        cg.gain.linearRampToValueAtTime(0.28, impactAt + 0.48);
        cg.gain.exponentialRampToValueAtTime(0.08, impactAt + 1.25);
        cg.gain.exponentialRampToValueAtTime(0.0001, blastEnd - 0.1);

        crack.connect(bp);
        bp.connect(cg);
        cg.connect(bus);
        crack.start(impactAt);
        crack.stop(blastEnd);
      }
    } catch {
      // Ignore transient Web Audio errors
    }
  }

  playNukeIntercept(): void {
    const ctx = this.readySfxCtx();
    if (!ctx || !this.sfxBus) return;

    const now = ctx.currentTime;
    if (!this.allow("nukeIntercept", 0.35, now)) return;

    this.noteCombat(0.75);
    if (this.musicBus && this.musicOn) {
      this.musicBus.gain.cancelScheduledValues(now);
      this.musicBus.gain.setTargetAtTime(MUSIC_GAIN * 0.35, now, 0.06);
      this.musicDuckUntil = now + 1.55;
    }

    try {
      const bus = this.sfxBus;
      const hitAt = now + 0.7;

      // ===== PHASE 1 (0..0.70s): Sharp steep THAAD solid-rocket booster launch whoosh =====
      // Pneumatic canister ignition pop
      this.playTone(ctx, bus, "triangle", 260, 68, now, 0.08, 0.38, 0.003);

      // Rising supersonic interceptor climb whine (640Hz -> 2780Hz)
      const climbOsc = ctx.createOscillator();
      const climbG = ctx.createGain();
      climbOsc.type = "sine";
      climbOsc.frequency.setValueAtTime(640, now + 0.01);
      climbOsc.frequency.exponentialRampToValueAtTime(2780, hitAt);
      climbG.gain.setValueAtTime(0.0001, now + 0.01);
      climbG.gain.linearRampToValueAtTime(0.18, now + 0.14);
      climbG.gain.exponentialRampToValueAtTime(0.24, hitAt - 0.03);
      climbG.gain.exponentialRampToValueAtTime(0.0001, hitAt + 0.02);
      climbOsc.connect(climbG);
      climbG.connect(bus);
      climbOsc.start(now + 0.01);
      climbOsc.stop(hitAt + 0.04);

      if (this.whiteNoise) {
        const whoosh = this.makeNoiseSource(ctx, this.whiteNoise);
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.Q.value = 2.2;
        bp.frequency.setValueAtTime(520, now);
        bp.frequency.exponentialRampToValueAtTime(4200, hitAt);

        const wg = ctx.createGain();
        wg.gain.setValueAtTime(0.0001, now);
        wg.gain.linearRampToValueAtTime(0.42, now + 0.045);
        wg.gain.exponentialRampToValueAtTime(0.28, now + 0.45);
        wg.gain.exponentialRampToValueAtTime(0.0001, hitAt + 0.02);

        whoosh.connect(bp);
        bp.connect(wg);
        wg.connect(bus);
        whoosh.start(now);
        whoosh.stop(hitAt + 0.04);
      }

      if (this.pinkNoise) {
        const thrust = this.makeNoiseSource(ctx, this.pinkNoise);
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.setValueAtTime(1400, now);
        lp.frequency.exponentialRampToValueAtTime(320, hitAt);

        const tg = ctx.createGain();
        tg.gain.setValueAtTime(0.0001, now);
        tg.gain.linearRampToValueAtTime(0.36, now + 0.03);
        tg.gain.exponentialRampToValueAtTime(0.0001, hitAt + 0.04);

        thrust.connect(lp);
        lp.connect(tg);
        tg.connect(bus);
        thrust.start(now);
        thrust.stop(hitAt + 0.05);
      }

      // ===== PHASE 2 (0.70s): Crisp high-altitude kinetic crack & echoing triumphant shield chime! =====
      // Razor-sharp exo-atmospheric hit-to-kill kinetic snap
      this.playTone(ctx, bus, "sine", 340, 62, hitAt, 0.22, 0.56, 0.002);
      this.playTone(ctx, bus, "triangle", 1180, 190, hitAt, 0.09, 0.34, 0.002);

      if (this.whiteNoise) {
        const crack = this.makeNoiseSource(ctx, this.whiteNoise);
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.Q.value = 1.3;
        bp.frequency.setValueAtTime(3600, hitAt);
        bp.frequency.exponentialRampToValueAtTime(820, hitAt + 0.24);

        const cg = ctx.createGain();
        cg.gain.setValueAtTime(0.0001, hitAt);
        cg.gain.linearRampToValueAtTime(0.62, hitAt + 0.003);
        cg.gain.exponentialRampToValueAtTime(0.16, hitAt + 0.07);
        cg.gain.exponentialRampToValueAtTime(0.0001, hitAt + 0.28);

        crack.connect(bp);
        bp.connect(cg);
        cg.connect(bus);
        crack.start(hitAt);
        crack.stop(hitAt + 0.3);
      }

      // Echoing triumphant crystalline shield chime (A4 -> E5 -> A5 -> D6 with shimmering echo!)
      const chimeNotes: [number, number, number][] = [
        [N.A4, 0.03, 0.2],
        [N.E5, 0.095, 0.22],
        [N.A5, 0.16, 0.24],
        [N.D6, 0.23, 0.22],
      ];
      for (const [freq, off, vol] of chimeNotes) {
        const t0 = hitAt + off;
        // Primary crystalline chime
        this.playTone(ctx, bus, "sine", freq, freq * 1.004, t0, 0.42, vol, 0.004);
        this.playTone(ctx, bus, "triangle", freq * 2, freq * 2, t0, 0.24, vol * 0.26, 0.004);
        // Echoing sky-high reflection tail
        this.playTone(ctx, bus, "sine", freq, freq, t0 + 0.18, 0.38, vol * 0.44, 0.008);
      }
    } catch {
      // Ignore transient Web Audio errors
    }
  }

  playUi(kind: UiSfx): void {
    const ctx = this.readySfxCtx();
    if (!ctx || !this.sfxBus) return;

    const now = ctx.currentTime;
    const minGap =
      kind === "cash"
        ? 0.08
        : kind === "alert"
          ? 0.65
          : kind === "powerDown" || kind === "powerUp"
            ? 0.45
            : kind === "select"
              ? 0.04
              : kind === "move" || kind === "attack"
                ? 0.045
                : kind === "deny"
                  ? 0.12
                  : kind === "promote" || kind === "crate"
                    ? 0.12
                    : kind === "recon"
                      ? 0.35
                      : kind === "ewjam"
                        ? 0.09
                        : kind === "hold"
                          ? 0.06
                          : 0.04;

    if (!this.allow(`ui:${kind}`, minGap, now)) return;

    try {
      const bus = this.sfxBus;
      switch (kind) {
        case "select":
          this.uiSelect(ctx, bus, now);
          break;
        case "move":
          this.uiMove(ctx, bus, now);
          break;
        case "attack":
          this.uiAttack(ctx, bus, now);
          break;
        case "buildStart":
          this.uiBuildStart(ctx, bus, now);
          break;
        case "buildDone":
          this.uiBuildDone(ctx, bus, now);
          break;
        case "place":
          this.uiPlace(ctx, bus, now);
          break;
        case "deny":
          this.uiDeny(ctx, bus, now);
          break;
        case "cash":
          this.uiCash(ctx, bus, now);
          break;
        case "promote":
          this.uiPromote(ctx, bus, now);
          break;
        case "crate":
          this.uiCrate(ctx, bus, now);
          break;
        case "alert":
          this.uiAlert(ctx, bus, now);
          break;
        case "cap":
          this.uiCap(ctx, bus, now);
          break;
        case "upgrade":
          this.uiUpgrade(ctx, bus, now);
          break;
        case "recon":
          this.uiRecon(ctx, bus, now);
          break;
        case "ewjam":
          this.uiEwJam(ctx, bus, now);
          break;
        case "hold":
          this.uiHold(ctx, bus, now);
          break;
        case "powerDown":
          this.uiPowerDown(ctx, bus, now);
          break;
        case "powerUp":
          this.uiPowerUp(ctx, bus, now);
          break;
        case "win":
          this.uiWin(ctx, bus, now);
          break;
        case "lose":
          this.uiLose(ctx, bus, now);
          break;
      }
    } catch {
      // Ignore transient Web Audio errors
    }
  }

  /**
   * First-person feedback sounds — seeker lock ticks, movement cues, hitmarker,
   * kill/objective/medal stingers & radio squelch. All short (<0.4s) and quiet
   * so they layer under the battlefield mix without fatigue.
   * Names: lock | locked | lost | sprint | boost | ads | crouch | wpn |
   * climb | dive | hitmark | damage | kill | medal | radio | objective | warn
   */
  playFpvSfx(name: string): void {
    const ctx = this.readySfxCtx();
    if (!ctx || !this.sfxBus) return;

    const now = ctx.currentTime;
    const minGap =
      name === "hitmark"
        ? 0.05
        : name === "lock"
          ? 0.08
          : name === "kill" || name === "wpn"
            ? 0.1
            : name === "crouch"
              ? 0.12
              : name === "radio" || name === "locked" || name === "lost"
                ? 0.16
                : name === "sprint" || name === "boost" || name === "damage"
                  ? 0.25
                  : name === "climb" || name === "dive"
                    ? 0.3
                    : name === "warn"
                      ? 0.55
                      : name === "medal" || name === "objective"
                        ? 0.4
                        : 0.07;

    if (!this.allow(`fpv:${name}`, minGap, now)) return;

    try {
      const bus = this.sfxBus;
      switch (name) {
        case "lock":
          // Soft seeker acquisition tick
          this.playTone(ctx, bus, "sine", 1180, 1220, now, 0.045, 0.09, 0.002);
          break;
        case "locked":
          // Rising lock confirm chirp
          this.playTone(ctx, bus, "sine", 880, 1180, now, 0.07, 0.13, 0.003);
          this.playTone(ctx, bus, "sine", 1480, 1980, now + 0.07, 0.12, 0.15, 0.003);
          break;
        case "lost":
          // Descending lock-lost buzz
          this.playTone(ctx, bus, "sawtooth", 430, 175, now, 0.2, 0.09, 0.004);
          break;
        case "sprint":
        case "boost":
          // Rush of air past the intake
          this.fpvNoise(ctx, bus, now, 620, 2600, 0.24, 0.11);
          break;
        case "ads":
          // Optic raised — soft click
          this.playTone(ctx, bus, "triangle", 660, 430, now, 0.028, 0.12, 0.002);
          this.fpvNoise(ctx, bus, now, 3200, 3200, 0.018, 0.05);
          break;
        case "crouch":
          // Soft gear thud
          this.playTone(ctx, bus, "sine", 150, 62, now, 0.11, 0.15, 0.004);
          break;
        case "wpn":
          // Mechanical weapon-selector clack
          this.playTone(ctx, bus, "triangle", 540, 380, now, 0.026, 0.13, 0.002);
          this.playTone(ctx, bus, "triangle", 760, 520, now + 0.045, 0.03, 0.12, 0.002);
          break;
        case "climb":
          this.playTone(ctx, bus, "sine", 290, 540, now, 0.28, 0.06, 0.02);
          break;
        case "dive":
          this.playTone(ctx, bus, "sine", 540, 260, now, 0.28, 0.06, 0.02);
          break;
        case "hitmark":
          // Quick hit-confirm tick
          this.playTone(ctx, bus, "sine", 1520, 1460, now, 0.03, 0.1, 0.002);
          this.playTone(ctx, bus, "triangle", 2280, 2100, now, 0.022, 0.05, 0.002);
          break;
        case "damage":
          // Own hull taking a hit
          this.playTone(ctx, bus, "sine", 120, 46, now, 0.17, 0.19, 0.003);
          this.fpvNoise(ctx, bus, now, 900, 260, 0.12, 0.09);
          break;
        case "kill":
          // Low confirm thunk
          this.playTone(ctx, bus, "sine", 150, 44, now, 0.16, 0.19, 0.003);
          this.playTone(ctx, bus, "triangle", 460, 300, now + 0.02, 0.07, 0.08, 0.003);
          break;
        case "medal":
          // Little brass arpeggio
          this.playTone(ctx, bus, "triangle", N.D5, N.D5, now, 0.1, 0.13, 0.004);
          this.playTone(ctx, bus, "triangle", N.A5, N.A5, now + 0.075, 0.1, 0.13, 0.004);
          this.playTone(ctx, bus, "triangle", N.D6, N.D6, now + 0.15, 0.2, 0.14, 0.004);
          break;
        case "objective":
          // Mission ding + octave sparkle
          this.playTone(ctx, bus, "sine", 988, 988, now, 0.11, 0.13, 0.004);
          this.playTone(ctx, bus, "sine", 1976, 1976, now + 0.02, 0.09, 0.05, 0.004);
          break;
        case "warn":
          // Two-tone caution alert
          this.playTone(ctx, bus, "square", 640, 640, now, 0.07, 0.07, 0.003);
          this.playTone(ctx, bus, "square", 470, 470, now + 0.085, 0.09, 0.07, 0.003);
          break;
        case "radio":
        default:
          // Radio squelch blip
          this.fpvNoise(ctx, bus, now, 1900, 1200, 0.05, 0.1);
          this.playTone(ctx, bus, "sine", 940, 860, now + 0.015, 0.05, 0.07, 0.003);
          break;
      }
    } catch {
      // Ignore transient Web Audio errors
    }
  }

  /** Radio squelch blip — used for story barks & chatter lines. */
  playBark(): void {
    this.playFpvSfx("radio");
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  private readySfxCtx(): AudioContext | null {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== "running") return null;
    return ctx;
  }

  private syncBusGains(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (this.masterGain) {
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 1, now, 0.015);
    }
    if (this.musicBus) {
      const target = this.musicOn ? MUSIC_GAIN : 0;
      this.musicBus.gain.cancelScheduledValues(now);
      this.musicBus.gain.setTargetAtTime(target, now, 0.04);
    }
  }

  private allow(key: string, minGap: number, now: number): boolean {
    const prev = this.lastPlayed.get(key) ?? -999;
    if (now - prev < minGap) return false;
    this.lastPlayed.set(key, now);
    return true;
  }

  private makeNoiseSource(ctx: AudioContext, buf: AudioBuffer): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    // Randomize buffer phase offset so successive bursts never sound identical
    src.loopStart = 0;
    src.loopEnd = buf.duration;
    return src;
  }

  /** Short band-passed white-noise sweep for FPV cues (whooshes, squelch, clicks). */
  private fpvNoise(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    f0: number,
    f1: number,
    dur: number,
    gain: number,
  ): void {
    if (!this.whiteNoise) return;
    const src = this.makeNoiseSource(ctx, this.whiteNoise);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(Math.max(60, f0), now);
    bp.frequency.exponentialRampToValueAtTime(Math.max(60, f1), now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain, now + Math.min(0.008, dur * 0.4));
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(bus);
    src.start(now, (now * 1.7) % 1.0);
    src.stop(now + dur + 0.02);
  }

  private playTone(
    ctx: AudioContext,
    dest: AudioNode,
    type: OscillatorType,
    f0: number,
    f1: number,
    start: number,
    dur: number,
    gain: number,
    attack = 0.005,
  ): void {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(18, f0), start);
    if (f1 !== f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(18, f1), start + dur);
    }
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gain, start + Math.min(attack, dur * 0.4));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    g.connect(dest);
    osc.start(start);
    osc.stop(start + dur + 0.015);
  }

  // =========================================================================
  // Weapon synthesizers
  // =========================================================================

  private synthBullet(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    // Tight punch transient
    this.playTone(ctx, bus, "triangle", 320 * jitter, 92, now, 0.036, heroic ? 0.24 : 0.18, 0.002);

    // Crisp bandpass crack
    if (this.whiteNoise) {
      const src = this.makeNoiseSource(ctx, this.whiteNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(1950 * jitter, now);
      bp.frequency.exponentialRampToValueAtTime(980, now + 0.048);
      bp.Q.value = 1.6;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(heroic ? 0.34 : 0.26, now + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.052);

      src.connect(bp);
      bp.connect(g);
      g.connect(bus);
      src.start(now, Math.random() * 1.2);
      src.stop(now + 0.06);

      // Supersonic snap — the high "crack" that makes a shot feel fast
      const snap = this.makeNoiseSource(ctx, this.whiteNoise);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.setValueAtTime(4200 * jitter, now);
      hp.frequency.exponentialRampToValueAtTime(2600, now + 0.022);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.0001, now);
      sg.gain.linearRampToValueAtTime(heroic ? 0.17 : 0.13, now + 0.0015);
      sg.gain.exponentialRampToValueAtTime(0.0001, now + 0.024);
      snap.connect(hp);
      hp.connect(sg);
      sg.connect(bus);
      snap.start(now, Math.random() * 1.2);
      snap.stop(now + 0.03);
    }

    // Occasional spent-casing tink bouncing off the ground (~35%)
    if (Math.random() < 0.35) {
      const t = now + 0.055 + Math.random() * 0.09;
      const f = 3050 + Math.random() * 900;
      this.playTone(ctx, bus, "sine", f, f * 0.96, t, 0.045, 0.045, 0.002);
    }
  }

  private synthCannon(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    // Meaty low-end pitch drop (140Hz -> 38Hz)
    this.playTone(
      ctx,
      bus,
      "sine",
      142 * jitter,
      38,
      now,
      heroic ? 0.25 : 0.21,
      heroic ? 0.56 : 0.46,
      0.004,
    );
    // Mid-punch body
    this.playTone(ctx, bus, "triangle", 250 * jitter, 64, now, 0.09, 0.28, 0.003);

    // Metallic muzzle crack noise burst
    if (this.whiteNoise) {
      const src = this.makeNoiseSource(ctx, this.whiteNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(1350 * jitter, now);
      bp.frequency.exponentialRampToValueAtTime(380, now + 0.13);
      bp.Q.value = 1.1;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(0.38, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

      src.connect(bp);
      bp.connect(g);
      g.connect(bus);
      src.start(now, Math.random() * 1.2);
      src.stop(now + 0.16);

      // Faster supersonic crack on top — sharp attack sells the muzzle blast
      const crack = this.makeNoiseSource(ctx, this.whiteNoise);
      const chp = ctx.createBiquadFilter();
      chp.type = "highpass";
      chp.frequency.setValueAtTime(2900, now);
      chp.frequency.exponentialRampToValueAtTime(1500, now + 0.035);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, now);
      cg.gain.linearRampToValueAtTime(0.26, now + 0.002);
      cg.gain.exponentialRampToValueAtTime(0.0001, now + 0.038);
      crack.connect(chp);
      chp.connect(cg);
      cg.connect(bus);
      crack.start(now, Math.random() * 1.2);
      crack.stop(now + 0.045);
    }

    // Rolling low rumble tail — cannon shots should linger in the chest
    if (this.pinkNoise) {
      const rumble = this.makeNoiseSource(ctx, this.pinkNoise);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(230, now + 0.03);
      lp.frequency.exponentialRampToValueAtTime(70, now + 0.34);
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.0001, now + 0.03);
      rg.gain.linearRampToValueAtTime(heroic ? 0.17 : 0.13, now + 0.07);
      rg.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
      rumble.connect(lp);
      lp.connect(rg);
      rg.connect(bus);
      rumble.start(now + 0.03, Math.random() * 1.2);
      rumble.stop(now + 0.38);
    }
  }

  private synthRocket(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    // Launch tube ignition pop
    this.playTone(ctx, bus, "sine", 190 * jitter, 62, now, 0.065, 0.24, 0.003);

    // Rising bandpass white-noise whoosh (400Hz -> 1800Hz)
    if (this.whiteNoise) {
      const src = this.makeNoiseSource(ctx, this.whiteNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 2.2;
      bp.frequency.setValueAtTime(400 * jitter, now);
      bp.frequency.exponentialRampToValueAtTime(1850 * jitter, now + 0.24);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(heroic ? 0.36 : 0.29, now + 0.035);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.27);

      src.connect(bp);
      bp.connect(g);
      g.connect(bus);
      src.start(now, Math.random() * 1.2);
      src.stop(now + 0.29);
    }

    // Subtle exhaust tail
    if (this.pinkNoise) {
      const tail = this.makeNoiseSource(ctx, this.pinkNoise);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 800;
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.0001, now + 0.02);
      tg.gain.linearRampToValueAtTime(0.14, now + 0.06);
      tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
      tail.connect(hp);
      hp.connect(tg);
      tg.connect(bus);
      tail.start(now + 0.02, Math.random() * 1.2);
      tail.stop(now + 0.3);
    }
  }

  private synthArty(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    // Deep distant mortar thump
    this.playTone(ctx, bus, "sine", 106 * jitter, 27, now, 0.32, heroic ? 0.56 : 0.46, 0.008);

    if (this.pinkNoise) {
      const boom = this.makeNoiseSource(ctx, this.pinkNoise);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(480, now);
      lp.frequency.exponentialRampToValueAtTime(130, now + 0.28);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(0.38, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);

      boom.connect(lp);
      lp.connect(g);
      g.connect(bus);
      boom.start(now, Math.random() * 1.2);
      boom.stop(now + 0.32);
    }

    // Brief descending shell whistle
    this.playTone(ctx, bus, "sine", 1320 * jitter, 620 * jitter, now + 0.045, 0.24, 0.085, 0.03);
  }

  private synthArc(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    const dur = heroic ? 0.26 : 0.22;

    // Electric FM buzz: sawtooth carrier modulated by square LFO -> waveshaper
    const carrier = ctx.createOscillator();
    carrier.type = "sawtooth";
    carrier.frequency.setValueAtTime(125 * jitter, now);
    carrier.frequency.exponentialRampToValueAtTime(76 * jitter, now + dur);

    const mod = ctx.createOscillator();
    mod.type = "square";
    mod.frequency.setValueAtTime(62 * jitter, now);
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(260, now);
    modGain.gain.exponentialRampToValueAtTime(55, now + dur);
    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    const shaper = ctx.createWaveShaper();
    if (this.hardDrive) shaper.curve = this.hardDrive;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(1650 * jitter, now);
    bp.frequency.exponentialRampToValueAtTime(720, now + dur);
    bp.Q.value = 1.8;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(heroic ? 0.32 : 0.25, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.14, now + 0.07);
    g.gain.linearRampToValueAtTime(0.22, now + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    carrier.connect(shaper);
    shaper.connect(bp);
    bp.connect(g);
    g.connect(bus);

    carrier.start(now);
    mod.start(now);
    carrier.stop(now + dur + 0.02);
    mod.stop(now + dur + 0.02);

    // High-pass electric crackle & snap
    if (this.whiteNoise) {
      const src = this.makeNoiseSource(ctx, this.whiteNoise);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.setValueAtTime(2900, now);

      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, now);
      cg.gain.linearRampToValueAtTime(0.32, now + 0.003);
      cg.gain.exponentialRampToValueAtTime(0.06, now + 0.045);
      cg.gain.linearRampToValueAtTime(0.22, now + 0.075);
      cg.gain.exponentialRampToValueAtTime(0.0001, now + dur * 0.88);

      src.connect(hp);
      hp.connect(cg);
      cg.connect(bus);
      src.start(now, Math.random() * 1.2);
      src.stop(now + dur);
    }
  }

  private synthMelee(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    // Sharp metallic swipe spark
    this.playTone(ctx, bus, "triangle", 1680 * jitter, 760 * jitter, now, 0.075, 0.16, 0.003);
    this.playTone(ctx, bus, "sine", 2520 * jitter, 1400 * jitter, now, 0.055, 0.1, 0.002);

    if (this.whiteNoise) {
      const src = this.makeNoiseSource(ctx, this.whiteNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 3.2;
      bp.frequency.setValueAtTime(3400 * jitter, now);
      bp.frequency.exponentialRampToValueAtTime(920, now + 0.09);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(heroic ? 0.3 : 0.23, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);

      src.connect(bp);
      bp.connect(g);
      g.connect(bus);
      src.start(now, Math.random() * 1.2);
      src.stop(now + 0.11);
    }
  }

  private synthMissile(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    // Heavy VLS / cruise missile ignition thump
    this.playTone(ctx, bus, "sine", 148 * jitter, 38, now, 0.16, heroic ? 0.44 : 0.36, 0.005);
    this.playTone(ctx, bus, "triangle", 280 * jitter, 90, now, 0.09, 0.22, 0.004);

    // Sweeping booster roar (heavy whoosh)
    if (this.pinkNoise) {
      const roar = this.makeNoiseSource(ctx, this.pinkNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 1.6;
      bp.frequency.setValueAtTime(240 * jitter, now);
      bp.frequency.exponentialRampToValueAtTime(1450 * jitter, now + 0.16);
      bp.frequency.exponentialRampToValueAtTime(520 * jitter, now + 0.42);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(heroic ? 0.46 : 0.38, now + 0.035);
      g.gain.exponentialRampToValueAtTime(0.18, now + 0.22);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.44);

      roar.connect(bp);
      bp.connect(g);
      g.connect(bus);
      roar.start(now, Math.random() * 1.2);
      roar.stop(now + 0.46);
    }

    // Supersonic jet crackle tail
    if (this.whiteNoise) {
      const jet = this.makeNoiseSource(ctx, this.whiteNoise);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.setValueAtTime(1400, now);

      const jg = ctx.createGain();
      jg.gain.setValueAtTime(0.0001, now + 0.015);
      jg.gain.linearRampToValueAtTime(heroic ? 0.24 : 0.18, now + 0.06);
      jg.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

      jet.connect(hp);
      hp.connect(jg);
      jg.connect(bus);
      jet.start(now + 0.015, Math.random() * 1.2);
      jet.stop(now + 0.4);
    }
  }

  private synthTorpedo(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    // Pneumatic underwater tube launch thump
    this.playTone(ctx, bus, "sine", 132 * jitter, 46, now, 0.13, heroic ? 0.4 : 0.32, 0.004);

    // Subtle submarine sonar lock ping
    this.playTone(ctx, bus, "sine", 1480 * jitter, 1440 * jitter, now + 0.015, 0.18, 0.085, 0.004);

    // Underwater propeller / cavitation bubble rush
    if (this.pinkNoise) {
      const rush = this.makeNoiseSource(ctx, this.pinkNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 2.4;
      bp.frequency.setValueAtTime(260 * jitter, now);
      bp.frequency.exponentialRampToValueAtTime(760 * jitter, now + 0.14);
      bp.frequency.exponentialRampToValueAtTime(210 * jitter, now + 0.38);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(heroic ? 0.4 : 0.32, now + 0.045);
      g.gain.exponentialRampToValueAtTime(0.16, now + 0.18);
      g.gain.linearRampToValueAtTime(0.22, now + 0.24);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

      rush.connect(bp);
      bp.connect(g);
      g.connect(bus);
      rush.start(now, Math.random() * 1.2);
      rush.stop(now + 0.42);
    }
  }

  private synthBomb(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    // Bomb-bay release mechanical clunk
    this.playTone(ctx, bus, "triangle", 230 * jitter, 78, now, 0.055, 0.22, 0.003);

    // Classic whistling falling bomb Doppler descent
    const dur = heroic ? 0.38 : 0.34;
    this.playTone(ctx, bus, "sine", 1680 * jitter, 420 * jitter, now + 0.02, dur, heroic ? 0.2 : 0.16, 0.025);
    this.playTone(ctx, bus, "triangle", 840 * jitter, 220 * jitter, now + 0.03, dur * 0.9, 0.075, 0.025);

    // Rushing wind turbulence around falling ordnance
    if (this.whiteNoise) {
      const wind = this.makeNoiseSource(ctx, this.whiteNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 2.8;
      bp.frequency.setValueAtTime(1900 * jitter, now + 0.02);
      bp.frequency.exponentialRampToValueAtTime(480 * jitter, now + dur);

      const wg = ctx.createGain();
      wg.gain.setValueAtTime(0.0001, now + 0.02);
      wg.gain.linearRampToValueAtTime(0.14, now + 0.09);
      wg.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.02);

      wind.connect(bp);
      bp.connect(wg);
      wg.connect(bus);
      wind.start(now + 0.02, Math.random() * 1.2);
      wind.stop(now + dur + 0.04);
    }
  }

  private synthLaser(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    // High-energy searing plasma/laser hum (Helios Laser & Defense Satellite)
    const dur = heroic ? 0.28 : 0.24;

    // Sharp focused emitter ignition zap
    this.playTone(ctx, bus, "sine", 2480 * jitter, 880 * jitter, now, 0.055, heroic ? 0.24 : 0.19, 0.002);

    // Continuous resonant dual-harmonic thermal beam hum through soft overdrive
    const shaper = ctx.createWaveShaper();
    if (this.softDrive) shaper.curve = this.softDrive;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 3.0;
    bp.frequency.setValueAtTime(1950 * jitter, now);
    bp.frequency.exponentialRampToValueAtTime(1080 * jitter, now + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(heroic ? 0.34 : 0.28, now + 0.01);
    g.gain.setValueAtTime(heroic ? 0.3 : 0.24, now + dur * 0.65);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    shaper.connect(bp);
    bp.connect(g);
    g.connect(bus);

    for (const [f0, f1, type] of [
      [520 * jitter, 410 * jitter, "sawtooth"],
      [785 * jitter, 620 * jitter, "triangle"],
      [1560 * jitter, 1180 * jitter, "sine"],
    ] as [number, number, OscillatorType][]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, now);
      osc.frequency.exponentialRampToValueAtTime(f1, now + dur);
      osc.connect(shaper);
      osc.start(now);
      osc.stop(now + dur + 0.02);
    }

    // Searing high-frequency thermal plasma sizzle
    if (this.whiteNoise) {
      const sizzle = this.makeNoiseSource(ctx, this.whiteNoise);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.setValueAtTime(3200, now);

      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.0001, now);
      sg.gain.linearRampToValueAtTime(heroic ? 0.2 : 0.15, now + 0.012);
      sg.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      sizzle.connect(hp);
      hp.connect(sg);
      sg.connect(bus);
      sizzle.start(now, Math.random() * 1.2);
      sizzle.stop(now + dur + 0.02);
    }
  }

  private synthRailgun(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    // Sharp electromagnetic crack + deep magnetic rail sub-thump (Aegis Railgun MBT)
    // 1. Deep sub-bass electromagnetic recoil thump
    this.playTone(ctx, bus, "sine", 168 * jitter, 32, now, heroic ? 0.28 : 0.24, heroic ? 0.6 : 0.5, 0.003);
    // 2. Metallic rail ring body
    this.playTone(ctx, bus, "triangle", 460 * jitter, 118 * jitter, now, 0.14, 0.26, 0.002);
    // 3. Blistering high-voltage discharge transient
    this.playTone(ctx, bus, "sawtooth", 3150 * jitter, 420 * jitter, now, 0.06, heroic ? 0.24 : 0.19, 0.0015);

    // 4. Supersonic electromagnetic crack burst (hard-driven white noise)
    if (this.whiteNoise) {
      const crack = this.makeNoiseSource(ctx, this.whiteNoise);
      const shaper = ctx.createWaveShaper();
      if (this.hardDrive) shaper.curve = this.hardDrive;

      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(3600 * jitter, now);
      bp.frequency.exponentialRampToValueAtTime(840, now + 0.11);

      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, now);
      cg.gain.linearRampToValueAtTime(heroic ? 0.44 : 0.36, now + 0.002);
      cg.gain.exponentialRampToValueAtTime(0.0001, now + 0.125);

      crack.connect(shaper);
      shaper.connect(bp);
      bp.connect(cg);
      cg.connect(bus);
      crack.start(now, Math.random() * 1.2);
      crack.stop(now + 0.14);
    }

    // 5. Subtle rising capacitor recharge whine tail
    this.playTone(ctx, bus, "sine", 1380 * jitter, 2120 * jitter, now + 0.045, 0.16, 0.065, 0.015);
  }

  private synthBrrrt(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    // Iconic A-10 Warthog GAU-8/A Avenger 30mm rotary gatling "BRRRRRRT!"
    // 3,900 RPM = 65 Hz fundamental pulse rate -> raspy sawtooth/pulse buzz + bandpass punch + sub-bass roar + distant crackle!
    const dur = heroic ? 0.48 : 0.42;
    const baseHz = 65 * (0.97 + (jitter - 0.94) * 0.5);

    // 1. Raspy 65Hz rotary sawtooth + square pulse core through hard overdrive & punchy bandpass
    const shaper = ctx.createWaveShaper();
    if (this.hardDrive) shaper.curve = this.hardDrive;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 2.0;
    bp.frequency.setValueAtTime(980 * jitter, now);
    bp.frequency.exponentialRampToValueAtTime(480 * jitter, now + dur);

    const buzzGain = ctx.createGain();
    buzzGain.gain.setValueAtTime(0.0001, now);
    buzzGain.gain.linearRampToValueAtTime(heroic ? 0.46 : 0.39, now + 0.014);
    buzzGain.gain.setValueAtTime(heroic ? 0.42 : 0.35, now + dur * 0.72);
    buzzGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    shaper.connect(bp);
    bp.connect(buzzGain);
    buzzGain.connect(bus);

    const saw = ctx.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.setValueAtTime(baseHz, now);
    saw.frequency.linearRampToValueAtTime(baseHz * 0.92, now + dur);
    saw.connect(shaper);
    saw.start(now);
    saw.stop(now + dur + 0.02);

    const pulseOsc = ctx.createOscillator();
    pulseOsc.type = "square";
    pulseOsc.frequency.setValueAtTime(baseHz * 2.0, now);
    pulseOsc.frequency.linearRampToValueAtTime(baseHz * 1.84, now + dur);
    const pulseMix = ctx.createGain();
    pulseMix.gain.value = 0.55;
    pulseOsc.connect(pulseMix);
    pulseMix.connect(shaper);
    pulseOsc.start(now);
    pulseOsc.stop(now + dur + 0.02);

    // 2. Chest-rattling GAU-8 sub-bass roar (65Hz fundamental + 32.5Hz sub-octave rumble)
    const subOsc = ctx.createOscillator();
    subOsc.type = "sine";
    subOsc.frequency.setValueAtTime(baseHz, now);
    subOsc.frequency.exponentialRampToValueAtTime(baseHz * 0.74, now + dur);

    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.linearRampToValueAtTime(heroic ? 0.54 : 0.46, now + 0.018);
    subGain.gain.setValueAtTime(heroic ? 0.46 : 0.38, now + dur * 0.68);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.06);

    subOsc.connect(subGain);
    subGain.connect(bus);
    subOsc.start(now);
    subOsc.stop(now + dur + 0.08);

    this.playTone(ctx, bus, "triangle", baseHz * 0.5, 28, now, dur * 0.92, heroic ? 0.28 : 0.22, 0.02);

    // 3. High-pressure supersonic air-rip modulated at 65Hz + distant acoustic crackle tail
    if (this.whiteNoise) {
      const rip = this.makeNoiseSource(ctx, this.whiteNoise);
      const ripBp = ctx.createBiquadFilter();
      ripBp.type = "bandpass";
      ripBp.Q.value = 1.6;
      ripBp.frequency.setValueAtTime(2150 * jitter, now);
      ripBp.frequency.exponentialRampToValueAtTime(860, now + dur);

      const ripGain = ctx.createGain();
      ripGain.gain.setValueAtTime(0.0001, now);
      ripGain.gain.linearRampToValueAtTime(heroic ? 0.28 : 0.22, now + 0.012);
      ripGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      // 65Hz AM modulation onto noise gives crisp individual 30mm muzzle-blast teeth
      const amLfo = ctx.createOscillator();
      amLfo.type = "sawtooth";
      amLfo.frequency.setValueAtTime(baseHz, now);
      const amDepth = ctx.createGain();
      amDepth.gain.value = 0.14;
      amLfo.connect(amDepth);
      amDepth.connect(ripGain.gain);

      rip.connect(ripBp);
      ripBp.connect(ripGain);
      ripGain.connect(bus);
      rip.start(now, Math.random() * 1.1);
      rip.stop(now + dur + 0.02);
      amLfo.start(now);
      amLfo.stop(now + dur + 0.02);
    }

    // Distant battlefield canyon roar & impact crackle echo tail
    if (this.pinkNoise) {
      const echoStart = now + 0.085;
      const echoDur = dur + 0.26;
      const echo = this.makeNoiseSource(ctx, this.pinkNoise);
      const echoBp = ctx.createBiquadFilter();
      echoBp.type = "bandpass";
      echoBp.Q.value = 1.1;
      echoBp.frequency.setValueAtTime(1450, echoStart);
      echoBp.frequency.exponentialRampToValueAtTime(260, echoStart + echoDur);

      const eg = ctx.createGain();
      eg.gain.setValueAtTime(0.0001, echoStart);
      eg.gain.linearRampToValueAtTime(heroic ? 0.24 : 0.19, echoStart + 0.05);
      eg.gain.exponentialRampToValueAtTime(0.0001, echoStart + echoDur);

      echo.connect(echoBp);
      echoBp.connect(eg);
      eg.connect(bus);
      echo.start(echoStart, Math.random() * 1.1);
      echo.stop(echoStart + echoDur + 0.02);
    }
  }

  private synthIntercept(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    jitter: number,
    heroic: boolean,
  ): void {
    // Iron Dome: crisp whistling interceptor launch + tight midair airburst pop!
    const popAt = now + 0.17;

    // Phase 1: Snappy launch tube pop + rising whistling interceptor streak
    this.playTone(ctx, bus, "triangle", 250 * jitter, 92, now, 0.042, 0.22, 0.002);
    this.playTone(ctx, bus, "sine", 940 * jitter, 2520 * jitter, now + 0.008, 0.16, heroic ? 0.19 : 0.15, 0.012);

    if (this.whiteNoise) {
      const whoosh = this.makeNoiseSource(ctx, this.whiteNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 2.6;
      bp.frequency.setValueAtTime(1150 * jitter, now);
      bp.frequency.exponentialRampToValueAtTime(3300 * jitter, popAt);

      const wg = ctx.createGain();
      wg.gain.setValueAtTime(0.0001, now);
      wg.gain.linearRampToValueAtTime(0.22, now + 0.025);
      wg.gain.exponentialRampToValueAtTime(0.0001, popAt + 0.01);

      whoosh.connect(bp);
      bp.connect(wg);
      wg.connect(bus);
      whoosh.start(now, Math.random() * 1.2);
      whoosh.stop(popAt + 0.02);

      // Phase 2: Tight crisp midair airburst pop!
      const popNoise = this.makeNoiseSource(ctx, this.whiteNoise);
      const pbp = ctx.createBiquadFilter();
      pbp.type = "bandpass";
      pbp.Q.value = 1.5;
      pbp.frequency.setValueAtTime(2400 * jitter, popAt);
      pbp.frequency.exponentialRampToValueAtTime(760, popAt + 0.085);

      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.0001, popAt);
      pg.gain.linearRampToValueAtTime(heroic ? 0.4 : 0.34, popAt + 0.003);
      pg.gain.exponentialRampToValueAtTime(0.0001, popAt + 0.095);

      popNoise.connect(pbp);
      pbp.connect(pg);
      pg.connect(bus);
      popNoise.start(popAt, Math.random() * 1.2);
      popNoise.stop(popAt + 0.11);
    }

    // Tight midair detonation snap + clean cyan intercept confirmation ping
    this.playTone(ctx, bus, "sine", 215 * jitter, 58, popAt, 0.085, 0.32, 0.002);
    this.playTone(ctx, bus, "sine", 1760 * jitter, 1720 * jitter, popAt + 0.006, 0.075, 0.09, 0.002);
  }

  private synthHeroicOvertone(
    ctx: AudioContext,
    bus: AudioNode,
    now: number,
    weapon: WeaponFx,
    jitter: number,
  ): void {
    // Subtle heroic rank-3 punch & metallic harmonic shimmer
    const base =
      weapon === "cannon" ||
      weapon === "arty" ||
      weapon === "missile" ||
      weapon === "bomb" ||
      weapon === "railgun" ||
      weapon === "brrrt"
        ? 82
        : 164;
    this.playTone(ctx, bus, "sine", base * jitter, base * 0.55, now, 0.14, 0.14, 0.003);
    this.playTone(ctx, bus, "triangle", 880 * jitter, 1320 * jitter, now, 0.075, 0.065, 0.004);
  }

  // =========================================================================
  // UI & Stinger synthesizers
  // =========================================================================

  private uiSelect(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Crisp futuristic radio chirp + click
    this.playTone(ctx, bus, "sine", 860, 1180, now, 0.048, 0.16, 0.003);
    this.playTone(ctx, bus, "triangle", 1720, 1480, now, 0.025, 0.07, 0.002);

    // Tactile switch-click under the chirp — selection feels physical
    if (this.whiteNoise) {
      const click = this.makeNoiseSource(ctx, this.whiteNoise);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 3100;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(0.075, now + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.014);
      click.connect(hp);
      hp.connect(g);
      g.connect(bus);
      click.start(now, 0.4);
      click.stop(now + 0.02);
    }
  }

  private uiMove(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Clean double-pip tactical confirm (520Hz -> 740Hz)
    this.playTone(ctx, bus, "sine", 520, 535, now, 0.05, 0.18, 0.004);
    this.playTone(ctx, bus, "sine", 740, 760, now + 0.058, 0.07, 0.2, 0.004);
    this.playTone(ctx, bus, "triangle", 1480, 1480, now + 0.058, 0.04, 0.05, 0.003);
  }

  private uiAttack(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Sharper urgent double-beep (680Hz -> 500Hz)
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1900;
    lp.connect(bus);
    this.playTone(ctx, lp, "sawtooth", 680, 660, now, 0.05, 0.17, 0.003);
    this.playTone(ctx, lp, "sawtooth", 500, 485, now + 0.058, 0.08, 0.2, 0.003);
  }

  private uiBuildStart(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Mechanical ratchet click
    this.playTone(ctx, bus, "triangle", 420, 310, now, 0.024, 0.16, 0.002);
    this.playTone(ctx, bus, "triangle", 580, 460, now + 0.032, 0.024, 0.18, 0.002);
    this.playTone(ctx, bus, "sine", 780, 740, now + 0.064, 0.036, 0.15, 0.002);
    if (this.whiteNoise) {
      const src = this.makeNoiseSource(ctx, this.whiteNoise);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 2600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(0.14, now + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.022);
      src.connect(hp);
      hp.connect(g);
      g.connect(bus);
      src.start(now, 0.1);
      src.stop(now + 0.03);
    }
  }

  private uiBuildDone(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Warm harmonic triad chime ("Construction Complete" feel)
    const notes = [N.D5, N.Fs5, N.A5, N.D6];
    notes.forEach((freq, i) => {
      const t = now + i * 0.062;
      const d = i === notes.length - 1 ? 0.36 : 0.18;
      this.playTone(ctx, bus, "triangle", freq, freq, t, d, 0.17, 0.008);
      this.playTone(ctx, bus, "sine", freq * 0.5, freq * 0.5, t, d * 0.9, 0.09, 0.01);
    });
  }

  private uiPlace(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Heavy hydraulic CLUNK-THUD + pneumatic hiss
    this.playTone(ctx, bus, "sine", 165, 44, now, 0.16, 0.48, 0.004);
    this.playTone(ctx, bus, "triangle", 260, 74, now, 0.09, 0.28, 0.003);

    if (this.whiteNoise) {
      // Mechanical metal lock clunk
      const clunk = this.makeNoiseSource(ctx, this.whiteNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(980, now);
      bp.frequency.exponentialRampToValueAtTime(340, now + 0.075);
      bp.Q.value = 1.8;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, now);
      cg.gain.linearRampToValueAtTime(0.32, now + 0.003);
      cg.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
      clunk.connect(bp);
      bp.connect(cg);
      cg.connect(bus);
      clunk.start(now, 0.2);
      clunk.stop(now + 0.09);

      // Pneumatic air-brake hiss
      const hiss = this.makeNoiseSource(ctx, this.whiteNoise);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.setValueAtTime(2400, now + 0.04);
      const hg = ctx.createGain();
      hg.gain.setValueAtTime(0.0001, now + 0.04);
      hg.gain.linearRampToValueAtTime(0.16, now + 0.075);
      hg.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      hiss.connect(hp);
      hp.connect(hg);
      hg.connect(bus);
      hiss.start(now + 0.04, 0.6);
      hiss.stop(now + 0.27);
    }
  }

  private uiDeny(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Short low buzz (190Hz -> 145Hz)
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 640;
    lp.connect(bus);
    this.playTone(ctx, lp, "sawtooth", 190, 145, now, 0.16, 0.28, 0.005);
    this.playTone(ctx, lp, "square", 142, 118, now + 0.02, 0.14, 0.12, 0.005);
  }

  private uiCash(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Bright metallic register tick (1100Hz + 1650Hz)
    this.playTone(ctx, bus, "sine", 1100, 1120, now, 0.055, 0.13, 0.002);
    this.playTone(ctx, bus, "triangle", 1650, 1680, now + 0.012, 0.06, 0.1, 0.002);
  }

  private uiPromote(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Triumphant brassy 3-note rising fanfare (D4 -> A4 -> D5 + heroic F#5 top)
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(950, now);
    lp.frequency.exponentialRampToValueAtTime(3000, now + 0.28);
    lp.connect(bus);

    const steps: [number, number, number][] = [
      [N.D4, 0, 0.11],
      [N.A4, 0.105, 0.12],
      [N.D5, 0.215, 0.38],
    ];
    for (const [f, off, dur] of steps) {
      this.playTone(ctx, lp, "sawtooth", f, f, now + off, dur, 0.17, 0.012);
      this.playTone(ctx, bus, "triangle", f * 0.5, f * 0.5, now + off, dur, 0.1, 0.012);
    }
    // Bright brass third harmonic on the final triumphant note
    this.playTone(ctx, lp, "sawtooth", N.Fs5, N.Fs5, now + 0.22, 0.36, 0.09, 0.018);
  }

  private uiCrate(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Sparkling arpeggio pickup chime
    const arp = [N.D5, N.Fs5, N.A5, N.D6, N.E6];
    arp.forEach((f, i) => {
      const t = now + i * 0.044;
      this.playTone(ctx, bus, "sine", f, f, t, 0.22, 0.15, 0.004);
      this.playTone(ctx, bus, "triangle", f * 0.5, f * 0.5, t, 0.14, 0.06, 0.004);
    });
  }

  private uiAlert(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Urgent 2-pulse radar klaxon (880Hz / 660Hz)
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1200;
    bp.Q.value = 1.4;
    bp.connect(bus);

    for (let i = 0; i < 2; i++) {
      const t = now + i * 0.17;
      this.playTone(ctx, bp, "sawtooth", 880, 660, t, 0.13, 0.26, 0.006);
      this.playTone(ctx, bp, "square", 660, 880, t + 0.065, 0.075, 0.14, 0.005);
    }
  }

  private uiCap(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Distinct tactical capture sweep (440 -> 660 -> 880Hz)
    this.playTone(ctx, bus, "triangle", 440, 660, now, 0.11, 0.2, 0.006);
    this.playTone(ctx, bus, "triangle", 660, 880, now + 0.1, 0.14, 0.22, 0.006);
    this.playTone(ctx, bus, "sine", 880, 880, now + 0.22, 0.2, 0.18, 0.005);
  }

  private uiUpgrade(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Sci-fi power-up rising chord sweep
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 3.5;
    lp.frequency.setValueAtTime(380, now);
    lp.frequency.exponentialRampToValueAtTime(3800, now + 0.42);
    lp.connect(bus);

    const chord = [N.D3, N.A3, N.D4, N.Fs4];
    for (const f of chord) {
      this.playTone(ctx, lp, "sawtooth", f * 0.75, f * 1.5, now, 0.44, 0.12, 0.03);
    }
    this.playTone(ctx, bus, "sine", N.A4, N.D5, now + 0.18, 0.32, 0.14, 0.015);
  }

  private uiRecon(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Crisp sweeping sonar/radar ping with subtle secondary echo
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 3.2;
    bp.frequency.setValueAtTime(900, now);
    bp.frequency.exponentialRampToValueAtTime(2200, now + 0.16);
    bp.connect(bus);

    // Rising dish sweep
    this.playTone(ctx, bp, "sine", 680, 1780, now, 0.16, 0.22, 0.008);
    this.playTone(ctx, bp, "triangle", 340, 890, now, 0.15, 0.1, 0.008);

    // Resonant sonar ping + overtone shimmer
    this.playTone(ctx, bus, "sine", 1320, 1295, now + 0.11, 0.38, 0.2, 0.004);
    this.playTone(ctx, bus, "sine", 2640, 2610, now + 0.11, 0.22, 0.075, 0.004);

    // Faint radar bounce echo
    this.playTone(ctx, bus, "sine", 1320, 1300, now + 0.31, 0.24, 0.08, 0.006);
  }

  private uiEwJam(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Crisp electronic static interference zap/burst (FM EM warble + stuttered static crackle)
    const dur = 0.24;

    // 1. FM-modulated descending electromagnetic interference zap
    const carrier = ctx.createOscillator();
    carrier.type = "sawtooth";
    carrier.frequency.setValueAtTime(1920, now);
    carrier.frequency.exponentialRampToValueAtTime(360, now + dur);

    const mod = ctx.createOscillator();
    mod.type = "square";
    mod.frequency.setValueAtTime(92, now);
    mod.frequency.exponentialRampToValueAtTime(34, now + dur);

    const modDepth = ctx.createGain();
    modDepth.gain.setValueAtTime(640, now);
    modDepth.gain.exponentialRampToValueAtTime(95, now + dur);

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 3.2;
    bp.frequency.setValueAtTime(2400, now);
    bp.frequency.exponentialRampToValueAtTime(620, now + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.24, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.08, now + 0.075);
    g.gain.linearRampToValueAtTime(0.19, now + 0.105);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    mod.connect(modDepth);
    modDepth.connect(carrier.frequency);
    carrier.connect(bp);
    bp.connect(g);
    g.connect(bus);

    carrier.start(now);
    mod.start(now);
    carrier.stop(now + dur + 0.02);
    mod.stop(now + dur + 0.02);

    // 2. Crisp RF white-noise static burst with gated double-crackle envelope
    if (this.whiteNoise) {
      const noise = this.makeNoiseSource(ctx, this.whiteNoise);
      const nBp = ctx.createBiquadFilter();
      nBp.type = "bandpass";
      nBp.Q.value = 2.4;
      nBp.frequency.setValueAtTime(3800, now);
      nBp.frequency.exponentialRampToValueAtTime(1150, now + 0.2);

      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, now);
      ng.gain.linearRampToValueAtTime(0.32, now + 0.004);
      ng.gain.exponentialRampToValueAtTime(0.05, now + 0.055);
      ng.gain.linearRampToValueAtTime(0.24, now + 0.085);
      ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.21);

      noise.connect(nBp);
      nBp.connect(ng);
      ng.connect(bus);
      noise.start(now, Math.random() * 1.2);
      noise.stop(now + 0.23);
    }

    // 3. Tight low-mid electromagnetic pulse thump
    this.playTone(ctx, bus, "triangle", 260, 68, now, 0.095, 0.22, 0.003);
  }

  private uiHold(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Short firm mechanical lock click (stabilizer clamp engagement)
    this.playTone(ctx, bus, "triangle", 250, 96, now, 0.048, 0.24, 0.002);

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1680;
    bp.Q.value = 2.4;
    bp.connect(bus);

    this.playTone(ctx, bp, "square", 1520, 940, now + 0.02, 0.032, 0.22, 0.002);
    this.playTone(ctx, bus, "sine", 520, 390, now + 0.022, 0.04, 0.14, 0.002);

    if (this.whiteNoise) {
      const snap = this.makeNoiseSource(ctx, this.whiteNoise);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 2600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + 0.016);
      g.gain.linearRampToValueAtTime(0.18, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.044);
      snap.connect(hp);
      hp.connect(g);
      g.connect(bus);
      snap.start(now + 0.016, 0.15);
      snap.stop(now + 0.05);
    }
  }

  private uiPowerDown(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Classic RTS brownout: breaker snap + descending turbine/generator power-down hum
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 2.4;
    lp.frequency.setValueAtTime(1650, now);
    lp.frequency.exponentialRampToValueAtTime(125, now + 0.68);
    lp.connect(bus);

    // Dual detuned generator hums winding down
    this.playTone(ctx, lp, "sawtooth", 220, 48, now, 0.68, 0.24, 0.012);
    this.playTone(ctx, lp, "triangle", 112, 28, now, 0.72, 0.28, 0.015);
    // Low warning tone dip
    this.playTone(ctx, bus, "sine", 440, 290, now + 0.04, 0.26, 0.14, 0.01);

    if (this.whiteNoise) {
      // Breaker trip snap
      const snap = this.makeNoiseSource(ctx, this.whiteNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1800;
      bp.Q.value = 1.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(0.22, now + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
      snap.connect(bp);
      bp.connect(g);
      g.connect(bus);
      snap.start(now, 0.3);
      snap.stop(now + 0.05);
    }
  }

  private uiPowerUp(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Rising generator turbine spin-up resolving into crisp power-online chime
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 2.2;
    lp.frequency.setValueAtTime(220, now);
    lp.frequency.exponentialRampToValueAtTime(2400, now + 0.38);
    lp.connect(bus);

    this.playTone(ctx, lp, "sawtooth", 92, 220, now, 0.36, 0.16, 0.025);
    this.playTone(ctx, lp, "triangle", 184, 440, now, 0.36, 0.14, 0.025);

    // Clean systems-online 2-note chime
    this.playTone(ctx, bus, "sine", N.A4, N.A4, now + 0.22, 0.16, 0.16, 0.006);
    this.playTone(ctx, bus, "sine", N.D5, N.D5, now + 0.32, 0.34, 0.2, 0.006);
    this.playTone(ctx, bus, "triangle", N.A5, N.A5, now + 0.32, 0.22, 0.08, 0.006);
  }

  private uiWin(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Rich 4-note ascending victory chord fanfare (D4 -> A4 -> B4 -> D5)
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1400, now);
    lp.frequency.exponentialRampToValueAtTime(3600, now + 0.65);
    lp.connect(bus);

    const lead: [number, number, number][] = [
      [N.D4, 0.0, 0.18],
      [N.A4, 0.16, 0.18],
      [N.B4, 0.32, 0.2],
      [N.D5, 0.5, 0.88],
    ];
    for (const [f, off, dur] of lead) {
      this.playTone(ctx, lp, "sawtooth", f, f, now + off, dur, 0.15, 0.015);
      this.playTone(ctx, bus, "triangle", f, f, now + off, dur, 0.12, 0.012);
    }
    // Warm D-major sustaining resolution chord
    for (const f of [N.D3, N.A3, N.D4, N.Fs4, N.A4]) {
      this.playTone(ctx, lp, "triangle", f, f, now + 0.5, 0.94, 0.095, 0.03);
    }
  }

  private uiLose(ctx: AudioContext, bus: AudioNode, now: number): void {
    // Somber descending D-minor cadence
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1100, now);
    lp.frequency.exponentialRampToValueAtTime(380, now + 1.35);
    lp.connect(bus);

    const motif: [number, number, number][] = [
      [N.D4, 0.0, 0.28],
      [N.C4, 0.24, 0.28],
      [N.Bb3, 0.48, 0.3],
      [N.A3, 0.74, 0.62],
    ];
    for (const [f, off, dur] of motif) {
      this.playTone(ctx, lp, "sawtooth", f, f * 0.992, now + off, dur, 0.14, 0.02);
      this.playTone(ctx, bus, "sine", f * 0.5, f * 0.5, now + off, dur, 0.11, 0.025);
    }
    // Dark low tonic tail
    this.playTone(ctx, bus, "sine", N.D2, N.D2, now + 0.74, 0.75, 0.22, 0.04);
  }

  // =========================================================================
  // Adaptive procedural industrial-RTS music engine (122 BPM, D minor)
  // =========================================================================

  private scheduleMusicStep(
    ctx: AudioContext,
    bus: AudioNode,
    step: number,
    time: number,
    combat: number,
  ): void {
    const barStep = step & 15;

    // 1. Pulsing dark industrial bassline (always present; brighter & punchier in combat)
    const bassFreq = BASS_SEQ[step];
    if (bassFreq > 0) {
      this.musicBass(ctx, bus, bassFreq, time, combat, barStep === 0 || barStep === 8);
    }

    // 2. Industrial kick drum (base groove: steady pulse; combat: driving syncopation)
    const baseKick = barStep === 0 || barStep === 8 || (barStep === 14 && (step & 31) >= 16);
    const combatKick = combat > 0.35 && (barStep === 6 || barStep === 10);
    if (baseKick || combatKick) {
      const accent = barStep === 0 ? 1.0 : barStep === 8 ? 0.9 : 0.72;
      this.musicKick(ctx, bus, time, accent * (0.72 + combat * 0.28));
    }

    // 3. Crisp industrial hi-hat
    const baseHat = (barStep & 3) === 2;
    const combatHat = combat > 0.25 && (barStep & 1) === 1;
    if (baseHat || combatHat) {
      const open = barStep === 14 && combat > 0.4;
      const gain = baseHat ? 0.22 + combat * 0.1 : 0.14 * combat;
      this.musicHat(ctx, bus, time, gain, open);
    }

    // 4. Driving combat snare / metallic clank on beats 2 & 4
    if (combat > 0.18 && (barStep === 4 || barStep === 12)) {
      const snGain = clamp((combat - 0.18) / 0.55, 0, 1);
      this.musicSnare(ctx, bus, time, snGain);
    }

    // 5. Distorted industrial synth power-chord stabs in combat
    if (combat > 0.25) {
      const stabFreq = STAB_SEQ[step];
      if (stabFreq > 0) {
        const stabLevel = clamp((combat - 0.25) / 0.65, 0, 1);
        this.musicStab(ctx, bus, stabFreq, time, stabLevel);
      }
    }

    // 6. Tense high-urgency combat arp
    if (combat > 0.45) {
      const arpFreq = ARP_SEQ[step];
      if (arpFreq > 0) {
        const arpLevel = clamp((combat - 0.45) / 0.55, 0, 1);
        this.musicArp(ctx, bus, arpFreq, time, arpLevel, barStep);
      }
    }

    // 7. Brooding base-building pad — one slow chord swell per bar so the bed
    // stays continuous; recedes as combat layers take over.
    if (barStep === 0) {
      const padLevel = 0.24 * (1 - combat * 0.5);
      if (padLevel > 0.03) {
        this.musicPad(ctx, bus, PAD_ROOTS[step >> 4], time, padLevel);
      }
    }

    // 8. Sparse haunting lead motif while things are calm — alternate phrases
    // on successive loops; hands off to stabs/arp as combat rises.
    if (combat < 0.7) {
      const motif = (this.cycleCount & 1) === 0 ? MOTIF_A : MOTIF_B;
      for (const [s, f, durSteps] of motif) {
        if (s === step) {
          this.musicMotif(ctx, bus, f, time, durSteps, 1 - combat / 0.7);
        }
      }
    }

    // 9. Crash splash marking the loop head during heavy combat
    if (step === 0 && combat > 0.55) {
      this.musicCrash(ctx, bus, time, clamp((combat - 0.55) / 0.45, 0, 1));
    }

    // 10. Low tom fill closing bar 4 on odd loops — keeps the cycle from
    // sounding like a verbatim repeat.
    if ((this.cycleCount & 1) === 1 && combat > 0.12) {
      if (barStep === 12) this.musicTom(ctx, bus, 168, time, 0.5 + combat * 0.3);
      if (barStep === 14) this.musicTom(ctx, bus, 118, time, 0.55 + combat * 0.3);
    }
  }

  private musicBass(
    ctx: AudioContext,
    bus: AudioNode,
    freq: number,
    time: number,
    combat: number,
    accent: boolean,
  ): void {
    const dur = STEP_SEC * (accent ? 1.45 : 0.92);

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, time);

    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(freq * 0.5, time);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 2.8 + combat * 2.2;
    const peakCut = 340 + combat * 950 + (accent ? 220 : 0);
    lp.frequency.setValueAtTime(peakCut, time);
    lp.frequency.exponentialRampToValueAtTime(140 + combat * 120, time + dur);

    const g = ctx.createGain();
    const vol = (accent ? 0.46 : 0.34) * (0.85 + combat * 0.22);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(vol, time + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.0001, time);
    subG.gain.linearRampToValueAtTime(vol * 0.45, time + 0.008);
    subG.gain.exponentialRampToValueAtTime(0.0001, time + dur);

    osc.connect(lp);
    lp.connect(g);
    g.connect(bus);

    sub.connect(subG);
    subG.connect(bus);

    osc.start(time);
    sub.start(time);
    osc.stop(time + dur + 0.015);
    sub.stop(time + dur + 0.015);
  }

  private musicKick(ctx: AudioContext, bus: AudioNode, time: number, level: number): void {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(118, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.11);

    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.62 * level, time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);

    osc.connect(g);
    g.connect(bus);
    osc.start(time);
    osc.stop(time + 0.17);

    // Beater click transient — gives the kick audible attack on small speakers
    if (this.whiteNoise) {
      const click = this.makeNoiseSource(ctx, this.whiteNoise);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 3400;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, time);
      cg.gain.linearRampToValueAtTime(0.16 * level, time + 0.0015);
      cg.gain.exponentialRampToValueAtTime(0.0001, time + 0.018);
      click.connect(hp);
      hp.connect(cg);
      cg.connect(bus);
      click.start(time, (time * 5.1) % 1.0);
      click.stop(time + 0.025);
    }
  }

  private musicHat(
    ctx: AudioContext,
    bus: AudioNode,
    time: number,
    level: number,
    open: boolean,
  ): void {
    if (!this.whiteNoise) return;
    const dur = open ? 0.12 : 0.038;
    const src = this.makeNoiseSource(ctx, this.whiteNoise);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = open ? 6500 : 7800;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(level, time + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

    src.connect(hp);
    hp.connect(g);
    g.connect(bus);
    src.start(time, (time * 3.7) % 1.0);
    src.stop(time + dur + 0.01);
  }

  private musicSnare(ctx: AudioContext, bus: AudioNode, time: number, level: number): void {
    // Punchy industrial snare body
    this.playTone(ctx, bus, "triangle", 195, 102, time, 0.095, 0.34 * level, 0.003);

    // Metallic snare crack
    if (this.whiteNoise) {
      const src = this.makeNoiseSource(ctx, this.whiteNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(1850, time);
      bp.Q.value = 1.1;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(0.42 * level, time + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.13);

      src.connect(bp);
      bp.connect(g);
      g.connect(bus);
      src.start(time, (time * 2.3) % 1.0);
      src.stop(time + 0.145);
    }

    // Snare-wire body tail — fills the gap between the crack and the next hit
    if (this.pinkNoise) {
      const tail = this.makeNoiseSource(ctx, this.pinkNoise);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(1050, time);
      lp.frequency.exponentialRampToValueAtTime(320, time + 0.2);

      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.0001, time + 0.008);
      tg.gain.linearRampToValueAtTime(0.13 * level, time + 0.02);
      tg.gain.exponentialRampToValueAtTime(0.0001, time + 0.21);

      tail.connect(lp);
      lp.connect(tg);
      tg.connect(bus);
      tail.start(time + 0.008, (time * 2.9) % 1.0);
      tail.stop(time + 0.23);
    }
  }

  private musicStab(
    ctx: AudioContext,
    bus: AudioNode,
    root: number,
    time: number,
    level: number,
  ): void {
    const dur = STEP_SEC * 1.6;
    const shaper = ctx.createWaveShaper();
    if (this.softDrive) shaper.curve = this.softDrive;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 2.4;
    lp.frequency.setValueAtTime(2200, time);
    lp.frequency.exponentialRampToValueAtTime(420, time + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.24 * level, time + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

    shaper.connect(lp);
    lp.connect(g);
    g.connect(bus);

    // Power-chord fifth (root + fifth)
    for (const ratio of [1, 1.498]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(root * ratio, time);
      osc.connect(shaper);
      osc.start(time);
      osc.stop(time + dur + 0.015);
    }
  }

  private musicArp(
    ctx: AudioContext,
    bus: AudioNode,
    freq: number,
    time: number,
    level: number,
    barStep: number,
  ): void {
    const dur = STEP_SEC * 0.82;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(freq, time);

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 2.6;
    bp.frequency.setValueAtTime(1400 + (barStep & 3) * 320, time);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.14 * level, time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

    osc.connect(bp);
    bp.connect(g);
    g.connect(bus);
    osc.start(time);
    osc.stop(time + dur + 0.015);
  }

  private musicPad(
    ctx: AudioContext,
    bus: AudioNode,
    root: number,
    time: number,
    level: number,
  ): void {
    // ~1.9 bars so consecutive bar-swels overlap into a continuous bed
    const dur = STEP_SEC * 30;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.9;
    lp.frequency.setValueAtTime(240, time);
    lp.frequency.linearRampToValueAtTime(540, time + dur * 0.45);
    lp.frequency.exponentialRampToValueAtTime(190, time + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(level, time + 0.5);
    g.gain.linearRampToValueAtTime(level * 0.82, time + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

    lp.connect(g);
    g.connect(bus);

    // Detuned saw stack (root/fifth/octave) — the classic dark RTS pad body.
    // ±7 cent pairs beat slowly against each other for movement.
    for (const [ratio, detune] of [
      [1, -7],
      [1, 7],
      [1.498, -5],
      [1.498, 5],
      [2, 0],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(root * ratio, time);
      osc.detune.value = detune;
      const og = ctx.createGain();
      og.gain.value = ratio === 2 ? 0.4 : 0.5;
      osc.connect(og);
      og.connect(lp);
      osc.start(time);
      osc.stop(time + dur + 0.05);
    }

    // Faint airy breath riding the swell so the pad doesn't feel sterile
    if (this.pinkNoise) {
      const breath = this.makeNoiseSource(ctx, this.pinkNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 0.7;
      bp.frequency.setValueAtTime(620, time);
      bp.frequency.linearRampToValueAtTime(940, time + dur * 0.5);
      bp.frequency.exponentialRampToValueAtTime(430, time + dur);

      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0.0001, time);
      bg.gain.linearRampToValueAtTime(level * 0.16, time + 0.6);
      bg.gain.exponentialRampToValueAtTime(0.0001, time + dur);

      breath.connect(bp);
      bp.connect(bg);
      bg.connect(bus);
      breath.start(time, (time * 1.3) % 1.0);
      breath.stop(time + dur + 0.02);
    }
  }

  /** Sparse lead voice for the low-intensity motif phrases. */
  private musicMotif(
    ctx: AudioContext,
    bus: AudioNode,
    freq: number,
    time: number,
    durSteps: number,
    level: number,
  ): void {
    const dur = STEP_SEC * durSteps * 1.05;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(freq * 3.1, time);
    bp.frequency.exponentialRampToValueAtTime(freq * 1.6, time + dur);

    const g = ctx.createGain();
    const vol = 0.16 * level;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(vol, time + Math.min(0.03, dur * 0.2));
    g.gain.setValueAtTime(vol, time + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

    bp.connect(g);
    g.connect(bus);

    // Sine core + triangle octave double — cold, lonely lead timbre
    for (const [ratio, type, mix] of [
      [1, "sine", 1],
      [2, "triangle", 0.4],
    ] as [number, OscillatorType, number][]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq * ratio, time);
      const og = ctx.createGain();
      og.gain.value = mix;
      osc.connect(og);
      og.connect(bp);
      osc.start(time);
      osc.stop(time + dur + 0.02);
    }
  }

  /** Metallic cymbal-ish splash used to mark loop heads during heavy combat. */
  private musicCrash(ctx: AudioContext, bus: AudioNode, time: number, level: number): void {
    if (!this.whiteNoise) return;
    const src = this.makeNoiseSource(ctx, this.whiteNoise);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.setValueAtTime(4300, time);
    hp.frequency.exponentialRampToValueAtTime(2600, time + 0.6);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.22 * level, time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.68);

    src.connect(hp);
    hp.connect(g);
    g.connect(bus);
    src.start(time, (time * 4.3) % 1.0);
    src.stop(time + 0.72);
  }

  /** Pitch-bent low tom for bar-4 fills. */
  private musicTom(
    ctx: AudioContext,
    bus: AudioNode,
    freq: number,
    time: number,
    level: number,
  ): void {
    const dur = 0.3;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, time);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.45, time + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.3 * level, time + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

    osc.connect(g);
    g.connect(bus);
    osc.start(time);
    osc.stop(time + dur + 0.02);

    // Skin noise on the attack
    if (this.whiteNoise) {
      const src = this.makeNoiseSource(ctx, this.whiteNoise);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 1.6;
      bp.frequency.setValueAtTime(freq * 4, time);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, time);
      ng.gain.linearRampToValueAtTime(0.12 * level, time + 0.003);
      ng.gain.exponentialRampToValueAtTime(0.0001, time + 0.07);
      src.connect(bp);
      bp.connect(ng);
      ng.connect(bus);
      src.start(time, (time * 3.1) % 1.0);
      src.stop(time + 0.09);
    }
  }

  /**
   * Continuous low drone bed — sub sine + detuned saw pair through a slowly
   * breathing lowpass, plus a whisper of filtered noise. Runs once for the
   * life of the context; loudness is governed entirely by musicBus.
   */
  private startDrone(ctx: AudioContext, bus: AudioNode): void {
    try {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 1.2;
      lp.frequency.value = 150;

      // Slow breathing on the filter cutoff (period ~37s)
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.027;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 62;
      lfo.connect(lfoDepth);
      lfoDepth.connect(lp.frequency);

      const droneGain = ctx.createGain();
      droneGain.gain.value = 0.34;

      lp.connect(droneGain);
      droneGain.connect(bus);

      // Sub-root D1 sine + D2 detuned saw pair + A1 fifth for width
      for (const [freq, type, detune, mix] of [
        [N.D1, "sine", 0, 0.9],
        [N.D2, "sawtooth", -6, 0.32],
        [N.D2, "sawtooth", 6, 0.32],
        [N.A1, "triangle", 0, 0.22],
      ] as [number, OscillatorType, number, number][]) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        osc.detune.value = detune;
        const og = ctx.createGain();
        og.gain.value = mix;
        osc.connect(og);
        og.connect(lp);
        osc.start();
      }

      // High air shimmer — barely audible dust on top of the drone
      if (this.pinkNoise) {
        const shimmer = this.makeNoiseSource(ctx, this.pinkNoise);
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.Q.value = 2.2;
        bp.frequency.value = 1150;
        const sg = ctx.createGain();
        sg.gain.value = 0.012;
        shimmer.connect(bp);
        bp.connect(sg);
        sg.connect(bus);
        shimmer.start();
      }
      lfo.start();
    } catch {
      // Drone is decorative — never let it break unlock()
    }
  }
}
