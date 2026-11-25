import "./units.css";
import {
  ARMOR_MULTS,
  BUILDING_NAMES,
  BUILDINGS,
  IRONDOME_COOLDOWN,
  IRONDOME_RADIUS,
  THAAD_NUKE_RADIUS,
  TRAIN_ORDER,
  UNITS,
  UPGRADE_PATHS,
  isHeavyArmorKind,
  isInfantryKind,
  isLightUnitKind,
  isVehicleKind,
  type ArmorTargetClass,
  type BuildingKind,
  type EntKind,
  type UnitDef,
  type UnitKind,
} from "../shared/gamedefs";

interface UnitCopy {
  role: string;
  tactic: string;
}

interface CategoryDef {
  id: string;
  kicker: string;
  title: string;
  desc: string;
  units?: UnitKind[];
  defenses?: BuildingKind[];
}

const unitLabel = new Map<UnitKind, string>(TRAIN_ORDER.map((row) => [row.unit, row.label]));

const COPY: Partial<Record<UnitKind, UnitCopy>> = {
  infantry: {
    role: "Cheap rifle infantry for screening, capturing map control, and adding a little emergency anti-air fire. They are fragile, but their low cost makes them ideal scouts and damage sponges.",
    tactic: "Use small squads rather than one deathball. Riflemen trade well into other infantry and can finish aircraft, but heavy armor shrugs off much of their damage.",
  },
  engineer: {
    role: "Unarmed capture specialist. Engineers take over neutral oil derricks and can seize enemy buildings when ordered to attack them, instantly turning economy or production to your side.",
    tactic: "Escort them with armor or drones. A successful capture is worth far more than the engineer's cost, especially when it steals a refinery, production structure, or forward base.",
  },
  rocket: {
    role: "Portable anti-tank and anti-air infantry. Rocket troops extend much farther than riflemen and get strong damage multipliers against vehicles and aircraft.",
    tactic: "Keep them behind tanks or terrain. They are the affordable answer to early armor pushes and helicopter harassment, but they lose efficiency against massed infantry.",
  },
  fpvdrone: {
    role: "A disposable first-person-view explosive drone. It is extremely fast, cheap, and manually steerable, then detonates itself on the target for concentrated burst damage.",
    tactic: "Use the FPV camera for precise strikes on harvesters, artillery, supply trucks, and isolated armor. The drone is one-use, so do not waste it on cheap rifle screens.",
  },
  spy: {
    role: "Unarmed infiltration unit disguised as ordinary infantry in enemy intelligence. Attacking an enemy building sabotages it instead of capturing it.",
    tactic: "Pick the correct infiltration target: defenses go dark, radar is scrambled, superweapon charge is reset, and production queues can be wiped and refunded. One spy can decide a late-game push.",
  },
  tank: {
    role: "The backbone main battle tank: durable enough to lead pushes, cheap enough to mass, and reliable against vehicles, structures, and infantry at close range.",
    tactic: "Tank control wins games. Focus-fire damaged enemies, screen artillery with them, and retreat weakened tanks instead of feeding veterancy to the opponent.",
  },
  himars: {
    role: "Long-range rocket artillery with a bonus against buildings. HIMARS deletes bases and static defenses from outside normal tank range but has thin armor and a slow reload.",
    tactic: "Never let it fight alone. Park tanks or infantry in front, use vision from UAVs or infantry, and keep moving after each volley to avoid counter-battery fire.",
  },
  railtank: {
    role: "Elite War Factory II armor. The Aegis Railgun MBT combines heavy hit points, bonus damage against vehicles and buildings, and rare ground-based anti-air capability.",
    tactic: "Use railtanks as the spearhead once your economy can afford them. They are expensive, so pair them with supply support and do not let kamikaze drones surround them.",
  },
  ballistic: {
    role: "A mobile strategic missile launcher with extreme range, very high damage, and a long reload. Its missiles are especially punishing to buildings and ships.",
    tactic: "Treat it as a fragile superweapon platform. Scout the target, fire from maximum range, then relocate during the long reload cycle before aircraft or counterfire arrive.",
  },
  supplytruck: {
    role: "Unarmed logistics vehicle carrying a large supply stock. With logistics enabled, forward armies consume fuel and ammunition; supply convoys keep them fighting away from base.",
    tactic: "Follow armored pushes at a safe distance. Losing a convoy can strand an otherwise winning attack, so route it around drone and aircraft pressure.",
  },
  harvester: {
    role: "The economy engine. Harvesters automatically collect ore and return it for credits; the first one is spawned free with a refinery, and extras multiply income.",
    tactic: "Protect harvest routes before expanding. A dead harvester is both lost income and a large replacement cost, while an untouched second refinery quickly pays for itself.",
  },
  uav: {
    role: "Fast reconnaissance UCAV with excellent vision and light precision weapons. It reveals the battlefield, scouts bases, and efficiently picks off light units.",
    tactic: "Use it first as eyes, second as a weapon. Its vision enables HIMARS, ballistic launchers, and naval bombardment; avoid dedicated SAMs and interceptors.",
  },
  shahed: {
    role: "Cheap one-way attack drone built for saturation. Individually fragile, but inexpensive enough to swarm radar, power, artillery, and exposed buildings.",
    tactic: "Launch several together from different angles. Defenders can shoot some down, but every interceptor missile or turret shell spent on a Shahed is tempo gained elsewhere.",
  },
  ewdrone: {
    role: "Unarmed electronic-warfare aircraft with a wide jamming radius against enemy drones. It protects formations from FPVs, Shaheds, UAVs, and other drone pressure.",
    tactic: "Hold it behind the push rather than at the tip. Jamming does no damage by itself; its value is making expensive enemy drone waves miss or lose control.",
  },
  interceptor: {
    role: "Dedicated fast air-superiority fighter. Its speed, anti-air damage multiplier, and quick reaction time make it the cleanest answer to enemy aircraft.",
    tactic: "Keep interceptors near your airspace instead of chasing deep over SAM coverage. Use them to strip escorts before sending bombers, gunships, or drone waves.",
  },
  chopper: {
    role: "Flexible attack helicopter with solid health, good range, and the ability to engage both ground targets and aircraft.",
    tactic: "Use terrain and lateral movement to pick at exposed armor and harvesters. Choppers are versatile, not invincible—massed MANPADS, interceptors, and SAMs punish hovering too long.",
  },
  a10: {
    role: "Armored close-air-support gunship built around rapid-fire tank killing. Its weapon has a large multiplier against vehicles and enough hull strength to survive a short pass.",
    tactic: "Attack along the enemy formation rather than parking above it. Prioritize HIMARS, railtanks, convoys, and harvesters; disengage before dedicated air defenses focus it.",
  },
  ac130: {
    role: "Heavy Air Command II gunship with enormous health, strong sustained fire, excellent vision, and bonuses against infantry, vehicles, and buildings.",
    tactic: "Use it to grind down a weakened flank, not to open a fresh SAM umbrella alone. Once enemy interceptors and long-range air defenses are suppressed, it becomes a flying siege engine.",
  },
  stealthbomber: {
    role: "Very expensive stealth strategic bomber. It remains cloaked until it attacks, then delivers a massive single strike with bonus damage against buildings.",
    tactic: "Do not buy it before your economy is stable. Scout a high-value target—superweapon, tech lab, refinery cluster, or production—and commit only after air defenses are thinned out.",
  },
  hypersonic: {
    role: "Mach-9 one-use strike missile. It crosses the map faster than any other unit and hits buildings and ships with exceptional bonus damage.",
    tactic: "Use it as a rapid response weapon against exposed artillery, ships, superweapons, or critical power. It is a munition, not a plane—every launch is spent.",
  },
  usv: {
    role: "Small stealth unmanned surface vessel packed with explosives. It is fast, cheap, and detonates on contact with a ship or coastal target.",
    tactic: "Attack in small wolfpacks from outside the enemy's vision. One USV is easy to stop; several arriving together can sink a much more expensive warship.",
  },
  gunboat: {
    role: "Fast, inexpensive escort hydrofoil with meaningful anti-air fire. It is the fleet's cheap screen against aircraft, drones, and light coastal threats.",
    tactic: "Spread gunboats ahead of capital ships so incoming aircraft and USVs are engaged early. They are scouts and escorts, not line-of-battle ships.",
  },
  destroyer: {
    role: "Reliable multi-role fleet backbone. Aegis Destroyers combine solid hull strength, good surface firepower, and anti-air coverage in one cost-effective package.",
    tactic: "Build destroyers before capital ships. They protect bombardment platforms, contest sea lanes, and give your fleet enough anti-air depth to survive carrier and missile pressure.",
  },
  sub: {
    role: "Stealth attack submarine optimized for killing ships. It remains hidden until firing and receives a large damage multiplier against naval targets.",
    tactic: "Flank rather than charge through escorts. Use submarines to ambush dreadnoughts, carriers, and shipyards while avoiding situations where the fleet can focus them after detection.",
  },
  dreadnought: {
    role: "Heavy long-range bombardment cruiser. Poseidon reaches far inland and deals bonus damage to buildings, turning a protected coastline into a siege platform.",
    tactic: "Never sail it alone. Keep destroyers and gunboats between it and enemy USVs, submarines, and aircraft while it methodically removes shore defenses and bases.",
  },
  carrier: {
    role: "Capital drone carrier with huge health, long range, strong anti-air coverage, and excellent vision. It projects sustained naval air power across the theater.",
    tactic: "Anchor a fleet around it. The carrier is powerful but expensive; losing one late can collapse both sea control and the credit advantage that built it.",
  },
};

const DEFENSE_COPY: Partial<Record<BuildingKind, UnitCopy>> = {
  turret: {
    role: "The cheapest gun in the defense line: a 1×1 Vulcan point-defense cannon that engages ground and air targets alike. Damage per shot is modest, but it is power-cheap, goes up faster than any other turret, and costs little enough to sprinkle across every approach.",
    tactic: "Build them in pairs guarding the ore line as soon as your first refinery is running. One Vulcan only slows a tank column; three of them cost less than a single Railgun MBT and erase infantry waves, FPV drones, and light raiders. The anti-air is opportunistic — its reach is short — so treat it as a ground-first stopgap until SAMs take over the sky.",
  },
  sam: {
    role: "Dedicated long-range anti-air battery. It cannot engage ground targets at all — every credit goes into a wide air umbrella with a heavy damage multiplier against aircraft, and its radar-tier sensors strip stealth from cloaked bombers that lesser defenses never see.",
    tactic: "Coverage first, density second: spread SAM sites so their rings overlap refineries, production, and the tech lab instead of stacking them in one cluster. Always pair them with Vulcans or an Arc Spire on the ground side — a SAM site alone is free real estate for any tank that drives up to it.",
  },
  arc: {
    role: "Mid-tier Tesla spire trading rate of fire for a heavy per-shot punch against both ground and air targets. No specialized multiplier — its value is raw damage concentration in a cheap 1×1 footprint.",
    tactic: "Use it as the midline anchor behind a screen of Vulcans: the spire's slower cycle wastes shots on rifle infantry, but each bolt genuinely hurts tanks, helicopters, and gunships. It still loses the range duel to artillery, so never let it be your only answer to a siege.",
  },
  irondome: {
    role: `Rapid-fire air-denial system with an active interception layer no other defense has: every ${fmtNum(IRONDOME_COOLDOWN / 10)} seconds it can destroy one incoming artillery shell, HIMARS or cruiser volley, bomb, or kamikaze drone mid-flight within ${fmtNum(IRONDOME_RADIUS)} tiles — the projectiles your other guns cannot stop at all.`,
    tactic: "You are limited to three, so spend them protecting what cannot be replaced — the superweapon, tech lab, and refinery cluster — not the front line. One dome stops one projectile per cycle, meaning saturation volleys leak through: it buys time and blunts sieges, it does not make anything invincible.",
  },
  lasertower: {
    role: "The heavy anchor of the defense line. The Helios beam hits harder per shot than any other turret, with a large damage multiplier against vehicles and ships — and it still swats aircraft. It outranges every tank in the game, though not artillery.",
    tactic: "Its appetite for power is enormous, so check the grid before placing or the whole defense line browns out. Park it where armor actually attacks and protect it from HIMARS and ballistic launchers, which outrange it: pair the laser with Iron Dome coverage or mobile tanks that can push back.",
  },
  thaad: {
    role: `The theater umbrella. Longest engagement reach of any defense, a damage bonus against exactly the aircraft that matter — bombers, gunships, interceptors, hypersonic gliders — and the only hard counter to nuclear weapons: each ready THAAD within ${fmtNum(THAAD_NUKE_RADIUS)} tiles of the impact point has an 80% chance to kill an incoming ICBM, with similar odds against ballistic missiles.`,
    tactic: "Only two per commander, so position them where their rings cover the whole base rather than the front edge — their job is killing deep strike aircraft and nukes, not skirmishers. They cannot shoot ground targets at all: anything that survives the umbrella walks up unopposed, so layer them behind Vulcans and lasers.",
  },
  satlink: {
    role: "Not a pure turret but an armed technology structure: the satellite uplink mounts the longest-reaching beam in the base-defense inventory, strips stealth from B-21 bombers at extreme range, and is the mandatory gateway to the Nuclear Silo.",
    tactic: "Never buy it as a defensive gun — bought for damage alone it is badly outclassed per credit. Buy it because the stealth detection, radar coverage, and superweapon access win games, and treat the laser as a bonus that happens to make raiders regret approaching the most important building in your base.",
  },
};

// The defensive line in tech progression order. satlink is listed last on
// purpose: it is an armed hybrid tech structure rather than a turret, and its
// card explains that distinction to new commanders.
const DEFENSE_LINEUP: BuildingKind[] = ["turret", "sam", "arc", "irondome", "lasertower", "thaad", "satlink"];

const CATEGORIES: CategoryDef[] = [
  {
    id: "infantry",
    kicker: "01 / BOOTS & MICRO-DRONES",
    title: "Infantry & Covert Operations",
    desc: "Cheap bodies, capture mechanics, portable air defense, FPV strikes, and sabotage. These units win information and tempo before heavy armor arrives.",
    units: ["infantry", "rocket", "fpvdrone", "engineer", "spy"],
  },
  {
    id: "armor",
    kicker: "02 / MECHANIZED SPEARHEAD",
    title: "Armor & Artillery",
    desc: "The direct ground-combat core: durable tanks, long-range rocket artillery, elite railguns, and mobile strategic missiles.",
    units: ["tank", "himars", "railtank", "ballistic"],
  },
  {
    id: "logistics",
    kicker: "03 / ECONOMY & SUPPLY",
    title: "Economy & Logistics",
    desc: "The units that pay for the war and keep forward armies fueled and armed. They do not shoot, but losing them loses games.",
    units: ["harvester", "supplytruck"],
  },
  {
    id: "air",
    kicker: "04 / AIR POWER & DRONES",
    title: "Air Force",
    desc: "Scouting UCAVs, expendable one-way drones, electronic warfare, fighters, gunships, stealth bombers, and hypersonic munitions.",
    units: ["uav", "shahed", "ewdrone", "interceptor", "chopper", "a10", "ac130", "stealthbomber", "hypersonic"],
  },
  {
    id: "naval",
    kicker: "05 / SEA CONTROL",
    title: "Naval Warfare",
    desc: "Explosive drone boats, escorts, fleet air defense, stealth submarines, shore bombardment, and capital drone carriers.",
    units: ["usv", "gunboat", "destroyer", "sub", "dreadnought", "carrier"],
  },
  {
    id: "defenses",
    kicker: "06 / STATIC FIREPOWER",
    title: "Base Defenses",
    desc: "The parallel construction-queue defense line: point-defense guns, anti-air umbrellas, active interception systems, and the armed satellite uplink. They never move — placement, power, and layering are the whole game.",
    defenses: DEFENSE_LINEUP,
  },
];

const CLASS_LABEL: Record<ArmorTargetClass, string> = {
  air: "aircraft",
  infantry: "infantry",
  heavyArmor: "heavy armor",
  vehicle: "vehicles",
  building: "buildings",
  seaShip: "ships",
  lightUnit: "light units",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

function productionName(def: UnitDef): string {
  const base: Record<UnitDef["trainsAt"], BuildingKind> = {
    barracks: "barracks",
    factory: "factory",
    airfield: "airfield",
    shipyard: "shipyard",
  };
  return BUILDING_NAMES[base[def.trainsAt]];
}

function armorClassLabel(kind: UnitKind, def: UnitDef): string {
  if (isInfantryKind(kind)) return "Infantry";
  if (isHeavyArmorKind(kind)) return "Heavy armor";
  if (def.domain === "air") return "Airframe";
  if (def.domain === "sea") return "Ship hull";
  if (isLightUnitKind(kind)) return "Light unit";
  if (isVehicleKind(kind)) return "Vehicle";
  return "Standard";
}

function entName(kind: EntKind): string {
  const asUnit = kind as UnitKind;
  const label = unitLabel.get(asUnit);
  if (label) return label;
  if (kind in UNITS) return asUnit.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/\b\w/g, (c) => c.toUpperCase());
  return BUILDING_NAMES[kind as BuildingKind] ?? kind;
}

function countersText(kind: EntKind): string {
  const rules = ARMOR_MULTS[kind] ?? [];
  const strong = new Set<string>();
  for (const rule of rules) {
    if (rule.mult <= 1.15) continue;
    for (const cls of rule.classes ?? []) strong.add(CLASS_LABEL[cls]);
    for (const target of rule.kinds ?? []) strong.add(entName(target));
  }
  if (strong.size === 0) return "No specialized damage multiplier — its value comes from raw stats, cost, speed, stealth, or utility rather than a hard counter.";
  return `Bonus damage against ${[...strong].join(", ")}. Omitted target classes take normal damage; mismatched targets may take reduced damage.`;
}

function addBadge(row: HTMLElement, text: string, cls = ""): void {
  row.append(el("span", `badge${cls ? ` ${cls}` : ""}`, text));
}

interface WeaponLike {
  dmg?: number;
  range?: number;
  canHitAir?: boolean;
  canHitGround?: boolean;
}

function targetPills(def: WeaponLike): HTMLElement {
  const row = el("div", "target-row");
  const armed = (def.dmg ?? 0) > 0 && (def.range ?? 0) > 0;
  const entries: { label: string; yes: boolean }[] = [
    { label: "LAND", yes: armed && def.canHitGround !== false },
    { label: "AIR", yes: armed && def.canHitAir === true },
    { label: "NAVAL", yes: armed && def.canHitGround !== false },
    { label: "BUILDINGS", yes: armed && def.canHitGround !== false },
  ];
  for (const entry of entries) {
    const pill = el("span", `target-pill ${entry.yes ? "good" : "no"}`, entry.label);
    pill.title = entry.yes ? "Can engage this target class" : "Cannot engage this target class";
    row.append(pill);
  }
  return row;
}

function stat(label: string, value: string, cls = ""): HTMLElement {
  const box = el("div", `stat${cls ? ` ${cls}` : ""}`);
  box.append(el("span", "", label), el("b", "", value));
  return box;
}

function buildUnitCard(kind: UnitKind): HTMLElement {
  const def = UNITS[kind];
  const copy = COPY[kind] ?? {
    role: "Combat unit generated from the live Open Alert unit definition.",
    tactic: "Use the stats, prerequisites, and target capabilities above to decide where it belongs in your composition.",
  };
  const label = unitLabel.get(kind) ?? kind;
  const card = el("article", "unit-card");
  card.id = `unit-${kind}`;

  const media = el("div", "media-panel");
  const frame = el("div", "media-frame");
  const img = document.createElement("img");
  img.src = `/units/${kind}.gif`;
  img.alt = `${label} recorded in live Open Alert gameplay`;
  img.loading = "lazy";
  img.decoding = "async";
  img.addEventListener("error", () => frame.classList.add("missing"), { once: true });
  frame.append(img);
  media.append(frame, el("div", "media-caption", `Tactical file · ${kind.toUpperCase()} · recorded in-game`));

  const info = el("div", "unit-info");
  const titleRow = el("div", "unit-title-row");
  const titleWrap = el("div");
  titleWrap.append(el("h3", "", label));
  titleRow.append(titleWrap, el("div", "cost", `$${def.cost.toLocaleString("en-US")}`));
  info.append(titleRow);

  const badges = el("div", "badges");
  addBadge(badges, def.domain);
  addBadge(badges, armorClassLabel(kind, def), "violet");
  if (def.dmg === 0 || def.range === 0) addBadge(badges, "unarmed utility", "utility");
  if (def.stealth) addBadge(badges, "stealth", "warn");
  if (def.kamikaze) addBadge(badges, "one-way strike", "danger");
  if (def.ewJamRadius) addBadge(badges, `EW jam ${fmtNum(def.ewJamRadius)}`, "utility");
  if (def.vision && def.vision > 9) addBadge(badges, `vision ${def.vision}`, "utility");
  if (def.capacity) addBadge(badges, `cargo ${def.capacity}`, "utility");
  info.append(badges);

  info.append(el("p", "role", copy.role));

  const stats = el("div", "stat-grid");
  const dps = def.dmg > 0 && def.rof > 0 ? def.dmg * 10 / def.rof : 0;
  stats.append(
    stat("HP", String(def.hp), "hot"),
    stat("SPEED", `${fmtNum(def.speed * 10)} t/s`, "cool"),
    stat("RANGE", def.range > 0 ? `${fmtNum(def.range)}` : "—", "cool"),
    stat("DAMAGE", def.dmg > 0 ? String(def.dmg) : "—", "hot"),
    stat("RELOAD", def.rof > 0 ? `${fmtNum(def.rof / 10)}s` : "—"),
    stat("BASE DPS", dps > 0 ? fmtNum(dps) : "—", "hot"),
    stat("TRAIN TIME", `${fmtNum(def.buildTicks / 10)}s`),
    stat("MOVES ON", def.domain === "land" ? "ground" : def.domain === "sea" ? "water" : "air", "cool"),
  );
  info.append(stats);

  const targets = el("div", "info-block");
  targets.append(el("h4", "", "Can attack"), targetPills(def));
  info.append(targets);

  const counter = el("div", "info-block");
  counter.append(el("h4", "", "What it counters"), el("p", "", countersText(kind)));
  info.append(counter);

  const tactic = el("div", "info-block");
  const tacticText = el("p");
  tacticText.append(el("strong", "", "Commander doctrine: "), document.createTextNode(copy.tactic));
  tactic.append(el("h4", "", "How to use it"), tacticText);
  info.append(tactic);

  const train = el("div", "training-line");
  const produced = el("span");
  produced.append(document.createTextNode("Trains at "), el("b", "", productionName(def)));
  train.append(produced);
  if (def.requires) {
    train.append(el("span", "sep", "•"));
    const req = el("span");
    const upgrade = Object.values(UPGRADE_PATHS).find((path) => path.to === def.requires);
    req.append(
      document.createTextNode("Requires "),
      el("b", "", BUILDING_NAMES[def.requires]),
      document.createTextNode(upgrade ? " upgrade" : ""),
    );
    train.append(req);
  }
  info.append(train);

  card.append(media, info);
  return card;
}

function buildDefenseCard(kind: BuildingKind): HTMLElement {
  const def = BUILDINGS[kind];
  const copy = DEFENSE_COPY[kind] ?? {
    role: "Defensive structure generated from the live Open Alert building definition.",
    tactic: "Use the stats, prerequisites, and target capabilities above to decide where it belongs in your base layout.",
  };
  const label = BUILDING_NAMES[kind];
  const card = el("article", "unit-card defense-card");
  card.id = `defense-${kind}`;

  const media = el("div", "media-panel");
  const frame = el("div", "media-frame");
  const img = document.createElement("img");
  img.src = `/units/${kind}.gif`;
  img.alt = `${label} recorded in live Open Alert gameplay`;
  img.loading = "lazy";
  img.decoding = "async";
  img.addEventListener("error", () => frame.classList.add("missing"), { once: true });
  frame.append(img);
  media.append(frame, el("div", "media-caption", `Tactical file · ${kind.toUpperCase()} · recorded in-game`));

  const info = el("div", "unit-info");
  const titleRow = el("div", "unit-title-row");
  const titleWrap = el("div");
  titleWrap.append(el("h3", "", label));
  titleRow.append(titleWrap, el("div", "cost", `$${def.cost.toLocaleString("en-US")}`));
  info.append(titleRow);

  const dmg = def.dmg ?? 0;
  const range = def.range ?? 0;
  const rof = def.rof ?? 0;
  const armed = dmg > 0 && range > 0;
  const hitsGround = armed && def.canHitGround !== false;
  const hitsAir = armed && def.canHitAir === true;

  const badges = el("div", "badges");
  addBadge(badges, "static defense");
  if (hitsGround && hitsAir) addBadge(badges, "ground + air", "violet");
  else if (hitsAir) addBadge(badges, "air only", "warn");
  else if (hitsGround) addBadge(badges, "surface only", "violet");
  if (def.limit != null) addBadge(badges, `limit ${def.limit}`, "danger");
  if (kind === "irondome") addBadge(badges, "intercepts projectiles", "utility");
  if (kind === "thaad") addBadge(badges, "anti-nuke", "utility");
  if (kind === "sam" || kind === "irondome" || kind === "thaad") addBadge(badges, "stealth detector", "utility");
  if (kind === "satlink") {
    addBadge(badges, "stealth detect 18", "utility");
    addBadge(badges, "tech structure", "warn");
  }
  info.append(badges);

  info.append(el("p", "role", copy.role));

  const stats = el("div", "stat-grid");
  const dps = dmg > 0 && rof > 0 ? (dmg * 10) / rof : 0;
  stats.append(
    stat("HP", String(def.hp), "hot"),
    stat("RANGE", range > 0 ? fmtNum(range) : "—", "cool"),
    stat("DAMAGE", dmg > 0 ? String(dmg) : "—", "hot"),
    stat("RELOAD", rof > 0 ? `${fmtNum(rof / 10)}s` : "—"),
    stat("BASE DPS", dps > 0 ? fmtNum(dps) : "—", "hot"),
    stat("POWER DRAW", def.power < 0 ? String(-def.power) : "0", "cool"),
    stat("BUILD TIME", `${fmtNum(def.buildTicks / 10)}s`),
    stat("FOOTPRINT", `${def.w}×${def.h}`),
  );
  info.append(stats);

  const targets = el("div", "info-block");
  targets.append(el("h4", "", "Can attack"), targetPills(def));
  info.append(targets);

  const counter = el("div", "info-block");
  counter.append(el("h4", "", "What it counters"), el("p", "", countersText(kind)));
  info.append(counter);

  const tactic = el("div", "info-block");
  const tacticText = el("p");
  tacticText.append(el("strong", "", "Commander doctrine: "), document.createTextNode(copy.tactic));
  tactic.append(el("h4", "", "How to use it"), tacticText);
  info.append(tactic);

  const train = el("div", "training-line");
  const produced = el("span");
  produced.append(
    document.createTextNode("Built at "),
    el("b", "", BUILDING_NAMES.conyard),
    document.createTextNode(def.category === "defense" ? " — defense queue" : " — structure queue"),
  );
  train.append(produced);
  if (def.requires?.length) {
    train.append(el("span", "sep", "•"));
    const req = el("span");
    req.append(document.createTextNode("Requires "), el("b", "", def.requires.map((r) => BUILDING_NAMES[r]).join(" + ")));
    train.append(req);
  }
  if (def.power < 0) {
    train.append(el("span", "sep", "•"));
    const pw = el("span");
    pw.append(document.createTextNode("Goes "), el("b", "", "offline"), document.createTextNode(" if the grid browns out"));
    train.append(pw);
  }
  info.append(train);

  card.append(media, info);
  return card;
}

function render(): void {
  const root = document.getElementById("units-app");
  if (!root) throw new Error("missing #units-app");
  root.textContent = "";

  const topbar = el("header", "topbar");
  const brand = document.createElement("a");
  brand.className = "brand";
  brand.href = "/";
  const emblem = document.createElement("img");
  emblem.src = "/favicon.svg";
  emblem.alt = "";
  const brandText = el("div");
  brandText.append(el("strong", "", "OPEN ALERT"), el("span", "", "TACTICAL DATABASE"));
  brand.append(emblem, brandText);
  const actions = el("nav", "top-actions");
  const guide = document.createElement("a");
  guide.className = "ghost-link";
  guide.href = "/guide.html";
  guide.textContent = "FIELD MANUAL";
  const back = document.createElement("a");
  back.className = "back-link";
  back.href = "/";
  back.textContent = "◄ BACK TO BASE";
  actions.append(guide, back);
  topbar.append(brand, actions);
  root.append(topbar);

  const activeCount = TRAIN_ORDER.length;
  const categories = CATEGORIES.length;
  const hero = el("section", "hero");
  hero.append(el("div", "eyebrow", "LIVE-GAME UNIT INTELLIGENCE"));
  const h1 = el("h1");
  h1.append(document.createTextNode("UNITS "), el("span", "", "ENCYCLOPEDIA"));
  hero.append(h1);
  hero.append(
    el(
      "p",
      "hero-copy",
      "A visual field database for new commanders. Every card is generated from the same authoritative unit and building definitions the server simulates — mobile units, then the static defense line — paired with real recorded multiplayer gameplay footage so you can recognize what each system actually does in battle.",
    ),
  );
  const heroStats = el("div", "hero-stats");
  const heroData: [string, string][] = [
    [String(activeCount), "active units"],
    [String(DEFENSE_LINEUP.length), "base defenses"],
    [String(categories), "doctrine groups"],
    ["100%", "live game data"],
  ];
  for (const [num, lab] of heroData) {
    const box = el("div", "hero-stat");
    box.append(el("b", "", num), el("span", "", lab));
    heroStats.append(box);
  }
  hero.append(heroStats);
  const note = el("div", "guide-note");
  note.append(document.createTextNode("Need base-building order and economy advice? Open the "));
  const noteLink = document.createElement("a");
  noteLink.href = "/guide.html";
  noteLink.textContent = "Field Manual";
  note.append(noteLink, document.createTextNode(" after studying these units."));
  hero.append(note);
  root.append(hero);

  const strip = el("section", "commander-strip");
  const strips: [string, string, string][] = [
    ["", "READ TARGET CLASSES, NOT JUST DAMAGE", "A high-damage unit can still be the wrong tool. Damage multipliers determine what it truly counters; range and reload determine whether it survives long enough to use them."],
    ["amber", "UNARMED DOES NOT MEAN USELESS", "Engineers, spies, harvesters, supply trucks, and jammer drones win through capture, sabotage, income, logistics, and electronic control rather than direct fire."],
    ["red", "EVERY GIF IS REAL GAMEPLAY", "Footage is captured from live headless multiplayer sessions driven through the same WebSocket commands used by players and AI agents—not hand-authored mock footage."],
  ];
  for (const [cls, title, text] of strips) {
    const box = el("article", `strip-card ${cls}`);
    box.append(el("b", "", title), el("p", "", text));
    strip.append(box);
  }
  root.append(strip);

  const nav = el("nav", "category-nav");
  nav.setAttribute("aria-label", "Unit categories");
  nav.append(el("span", "nav-label", "BROWSE"));
  for (const cat of CATEGORIES) {
    const link = document.createElement("a");
    link.className = "cat-link";
    link.href = `#${cat.id}`;
    link.textContent = cat.title.replace(/ & .*/, "");
    nav.append(link);
  }
  root.append(nav);

  for (const cat of CATEGORIES) {
    const section = el("section", "category-section");
    section.id = cat.id;
    const head = el("div", "category-head");
    const titleBox = el("div");
    titleBox.append(el("div", "category-kicker", cat.kicker), el("h2", "", cat.title));
    head.append(titleBox, el("p", "", cat.desc));
    const grid = el("div", "unit-grid");
    for (const kind of cat.units ?? []) grid.append(buildUnitCard(kind));
    for (const kind of cat.defenses ?? []) grid.append(buildDefenseCard(kind));
    section.append(head, grid);
    root.append(section);
  }

  const footer = el("footer", "footer");
  const fb = el("b", "", "DATA PROVENANCE");
  footer.append(
    fb,
    document.createTextNode(
      " — Hit points, speed, cost, build time, range, damage, reload, stealth, vision, cargo, EW radius, prerequisites, power draw, footprint, build limits, and armor multipliers are imported directly from src/shared/gamedefs.ts at build time. Speed is displayed in tiles per second at the simulation's 10 Hz tick rate; damage-per-second figures are base values before armor multipliers and veterancy. Surface-capable weapons can engage land units, ships, and buildings because the combat simulation treats all non-air entities as surface targets. Defense structures build in a parallel construction queue and require a healthy power grid — a browned-out base is a silent one. Retired legacy units are intentionally omitted from this modern roster. Return to the ",
    ),
  );
  const home = document.createElement("a");
  home.href = "/";
  home.textContent = "multiplayer lobby";
  footer.append(home, document.createTextNode(" when you are ready to command."));
  root.append(footer);
}

render();
