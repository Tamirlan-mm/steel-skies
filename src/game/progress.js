import { TANK_SPECS } from '../vehicles/tanks.js';
import { PLANE_SPECS } from '../vehicles/planes.js';
import { brOf, vehicleKind, matchmake } from './battleRating.js';

// Player progression: an economy rather than a score counter.
//
// Three currencies. Silver pays for vehicles, modifications, repairs and the
// ammunition you burned; it is the only one that can go DOWN, and losing an
// expensive vehicle twice in a row is meant to hurt. Research Points are no
// longer one fungible pool — most of what you earn flows into whichever
// vehicle you are researching, and only the remainder is free to spend on
// modifications. Crew XP buys the skills that make a vehicle handle better
// than its stat block says it should.
//
// v3: adds research targets, crews, lineups, spawn points and settings. A v2
// save still holds everything that matters, so it is migrated rather than
// dropped — the v2 -> v3 wipe would have cost an existing player their garage.
const KEY = 'steelSkies.progress.v3';
const KEY_V2 = 'steelSkies.progress.v2';

export const SPEC_INDEX = { ...TANK_SPECS, ...PLANE_SPECS };

export function specById(id) {
  return SPEC_INDEX[id] || null;
}

function kindOf(spec) {
  return vehicleKind(spec);
}

// A settlement tally arrives from whichever battle file ran, and a field that
// was never filled in must not turn the whole payout into NaN.
function count(v) {
  if (v === true) return 1;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

const DEFAULT_SETTINGS = {
  masterVolume: 0.8,
  effectsVolume: 1.0,
  engineVolume: 0.8,
  shakeScale: 1.0,
  showDamageLog: true,
  // contract R3-S (K-02 / K-01): booleans, read by main.js applySettings() ->
  // postfx.setLens({ blur, grain }). Motion blur only ever draws on the high
  // graphics tier; the toggles live in the garage settings (R3-C).
  motionBlur: true,
  filmGrain: true,
  // settings lane (wave 4). graphics: the tier the player picked in the hangar
  // or the pause screen — 'auto' asks the hardware (main.js defaultGraphics).
  graphics: 'auto',
  // mouse sensitivity multipliers on top of the game's own fov-scaled gain;
  // 1 is the feel the game always had. core/input.js applies them.
  sensTank: 1,
  sensTankZoom: 1,
  sensAir: 1,
  sensAirZoom: 1,
  invertYTank: false,
  invertYAir: false,
  // key / button bindings, core/input.js serializeBindings(): only the codes
  // that differ from their default key. Versioned; anything else -> defaults.
  controls: { v: 1, bind: {} },
};

const GRAPHICS_CHOICES = ['auto', 'low', 'medium', 'high'];
const SENS_KEYS = ['sensTank', 'sensTankZoom', 'sensAir', 'sensAirZoom'];
const SENS_MIN = 0.1;
const SENS_MAX = 5;
const BIND_CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

function cleanControls(v) {
  const out = { v: 1, bind: {} };
  if (!v || typeof v !== 'object' || v.v !== 1 || !v.bind || typeof v.bind !== 'object') return out;
  for (const k of Object.keys(v.bind)) {
    const code = v.bind[k];
    if (BIND_CODE_RE.test(k) && typeof code === 'string' && BIND_CODE_RE.test(code)) out.bind[k] = code;
  }
  return out;
}

// One value of one key, coerced to the shape DEFAULT_SETTINGS gives it; a
// value that cannot be coerced is the default.
function cleanSetting(key, v) {
  const d = DEFAULT_SETTINGS[key];
  if (key === 'graphics') return GRAPHICS_CHOICES.includes(v) ? v : d;
  if (key === 'controls') return cleanControls(v);
  if (typeof d === 'boolean') return typeof v === 'boolean' ? v : d;
  if (SENS_KEYS.includes(key)) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, SENS_MIN), SENS_MAX) : d;
  }
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : d;
}

// The garage's old "graphics" choice lived beside the save under its own key
// (main.js, before progress could hold a string); a save that predates the
// graphics slot adopts it once.
const LEGACY_GFX_KEY = 'steelSkies.graphics';

function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...src };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    out[key] = key in src ? cleanSetting(key, src[key]) : cleanSetting(key, DEFAULT_SETTINGS[key]);
  }
  if (!('graphics' in src)) {
    try {
      const legacy = localStorage.getItem(LEGACY_GFX_KEY);
      if (GRAPHICS_CHOICES.includes(legacy)) out.graphics = legacy;
    } catch {
      /* no storage */
    }
  }
  return out;
}

const DEFAULTS = {
  version: 3,
  silver: 1500,
  rp: 0, // free RP: what is left after the research target takes its cut
  crewXp: 0,
  owned: ['stuart', 'zero'],
  selected: { ground: 'stuart', air: 'zero' },
  battleMode: 'ground',
  difficulty: 'arcade', // 'arcade' | 'realistic'
  mods: {}, // vehicleId -> array of owned mod ids
  loadout: {}, // planeId -> 'clean' | 'bombs' | 'rockets'
  ammoLoadout: {}, // tankId -> { AP: n, ... }
  research: { target: null, points: {} }, // vehicleId -> RP invested
  crew: {}, // vehicleId -> { skillId: level }
  lineups: { ground: [], air: [], combined: [] }, // vehicleId[] , max 4
  settings: { ...DEFAULT_SETTINGS },
  stats: { battles: 0, wins: 0, kills: 0, deaths: 0, earned: 0, spent: 0 },
};

// ---------------------------------------------------------------------------
// economy constants — the whole balance of the game lives in this block
// ---------------------------------------------------------------------------

// Gross battle income before expenses. Tuned so a decent battle in a tier-1
// vehicle nets around 1,500 Silver and 500 RP after the bill, which puts the
// first purchasable vehicle (2,500 Silver + 900 RP) about three battles away
// and a tier-3 machine somewhere north of a dozen.
//
// scout, capTick and fire are the three the battle files were already paying
// out over the top of the HUD with nothing behind them on the results screen.
// They are priced where the battles priced them — a report is worth two thirds
// of a penetrating hit, five seconds sitting on a point rather less — so the
// numbers that pop in battle are the numbers that get banked.
export const REWARD = {
  silver: {
    base: 340, kill: 280, assist: 140, ground: 130, hit: 11, cap: 200,
    scout: 90, capTick: 22, fire: 120,
    victory: 540, perMinute: 55, damage: 0.8,
  },
  rp: {
    base: 90, kill: 85, assist: 45, ground: 40, hit: 4, cap: 60,
    scout: 30, capTick: 8, fire: 35,
    victory: 170, perMinute: 18, damage: 0.25,
  },
};

// The reward multiplier the vehicle itself carries. Without it the economy
// does not close: the repair bill grows with tier squared and BR squared while
// the payout above is flat, so a player who wins half his battles in a Tiger
// averages about zero Silver a battle and can never save the 12,000 for the
// Pershing no matter how well he plays. Tuned so a tier-1 machine is exactly
// 1.0 — the numbers the REWARD block was balanced against are unchanged — and
// a tier-4 is a shade under 2.0, which is what keeps it solvent.
export function rewardMultiplier(spec) {
  const s = typeof spec === 'string' ? specById(spec) : spec;
  if (!s) return { silver: 1, rp: 1 };
  const tier = s.tier || 1;
  const br = brOf(s) || 1;
  // never below 1: a low-BR vehicle should be cheap to run, not underpaid
  return {
    silver: Math.max(1, 0.6 + tier * 0.12 + br * 0.22),
    // RP climbs more gently: the next machine up the tree should still be a
    // dozen battles away, not four
    rp: Math.max(1, 0.8 + tier * 0.07 + br * 0.09),
  };
}

// Realistic pays better and costs more, exactly as the mode difference should:
// you take the higher repair bill because the higher income is worth it.
export const DIFFICULTY_MULT = {
  arcade: { silver: 1.0, rp: 1.0, repair: 1.0 },
  realistic: { silver: 1.55, rp: 1.5, repair: 1.35 },
};

// A destroyed vehicle is billed by tier and Battle Rating together: tier says
// how expensive the machine is, BR says how much battle it was bringing.
export const REPAIR = { base: 55, tier: 58, br: 46, partial: 0.22 };

// Consumables are cheap individually and add up over a long battle.
export const CONSUMABLE_COST = { parts: 90, fpe: 70, crew: 120, artillery: 200 };

// Crew skills: seven of them, five levels each, escalating cost, scaled by the
// tier of the vehicle the crew sits in. A full crew is a long-term project.
export const CREW_SKILLS = [
  {
    id: 'targeting', name: 'Targeting', key: 'traverse', per: 0.055, dir: 1,
    desc: 'Turret traverse and gun elevation speed',
  },
  {
    id: 'rangefinding', name: 'Rangefinding', key: 'aim', per: 0.06, dir: -1,
    desc: 'Sight accuracy and lead estimation error',
  },
  {
    id: 'reloading', name: 'Reloading', key: 'reload', per: 0.04, dir: -1,
    desc: 'Time between shots',
  },
  {
    id: 'driving', name: 'Driving', key: 'mobility', per: 0.035, dir: 1,
    desc: 'Acceleration, top speed and turning',
  },
  {
    id: 'vitality', name: 'Vitality', key: 'vitality', per: 0.09, dir: 1,
    desc: 'Crew survive hits that would knock them out',
  },
  {
    id: 'repair', name: 'Repair Rank', key: 'repair', per: 0.08, dir: -1,
    desc: 'Time to bring a knocked-out module back',
  },
  {
    id: 'vision', name: 'Keen Vision', key: 'vision', per: 0.1, dir: 1,
    desc: 'Range at which targets are spotted and marked',
  },
];

export const CREW_MAX_LEVEL = 5;
const CREW_LEVEL_COST = [50, 120, 240, 430, 760];

// Qualification is the Silver half of crew training: skill levels are bought
// with crew XP, but getting the crew properly qualified on a specific machine
// is a bill, and on a heavy vehicle it is a serious one. Each step multiplies
// what the trained levels are already worth.
export const CREW_QUALS = [
  { id: 'basic', name: 'Basic', boost: 0 },
  { id: 'expert', name: 'Expert', boost: 0.35, minLevel: 12 },
  { id: 'ace', name: 'Ace', boost: 0.7, minLevel: 24 },
];

// Spawn points: entering a battle grants a budget, each vehicle costs a slice
// of it, and playing well buys the next spawn. A Tiger costs about two spawns
// worth of a Stuart, which is the trade the whole lineup system is about.
export const SPAWN_START = 130;
export const SPAWN_AWARDS = {
  kill: 55, assist: 25, groundKill: 30, cap: 45, hit: 5, capTick: 2, perMinute: 12,
};

export const LINEUP_MAX = 4;

// ---------------------------------------------------------------------------
// save / load
// ---------------------------------------------------------------------------

function merge(data) {
  const base = structuredClone(DEFAULTS);
  const out = {
    ...base,
    ...data,
    selected: { ...base.selected, ...(data.selected || {}) },
    mods: { ...(data.mods || {}) },
    loadout: { ...(data.loadout || {}) },
    ammoLoadout: { ...(data.ammoLoadout || {}) },
    research: {
      target: data.research?.target ?? null,
      points: { ...(data.research?.points || {}) },
    },
    crew: { ...(data.crew || {}) },
    lineups: { ...base.lineups, ...(data.lineups || {}) },
    settings: sanitizeSettings(data.settings),
    stats: { ...base.stats, ...(data.stats || {}) },
  };
  out.version = 3;
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(JSON.parse(raw));
    // v2 save: everything it holds is still valid, so carry it forward whole
    const old = localStorage.getItem(KEY_V2);
    if (old) {
      const v2 = JSON.parse(old);
      const migrated = merge({
        silver: v2.silver,
        rp: v2.rp,
        owned: Array.isArray(v2.owned) ? v2.owned : undefined,
        selected: v2.selected,
        battleMode: v2.battleMode,
        difficulty: v2.difficulty,
        mods: v2.mods,
        loadout: v2.loadout,
        ammoLoadout: v2.ammoLoadout,
      });
      migrated.migratedFrom = 2;
      return migrated;
    }
    return structuredClone(DEFAULTS);
  } catch {
    return structuredClone(DEFAULTS);
  }
}

// crew multipliers are read at spawn, not per frame, but they are read for
// every vehicle in a lineup — cache them and drop the cache when they change
const crewCache = new Map();

export const progress = {
  data: load(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable — play without persistence */
    }
  },

  // -------------------------------------------------------------------------
  // ownership
  // -------------------------------------------------------------------------

  isOwned(id) {
    return this.data.owned.includes(id);
  },

  // free vehicles (no price) become owned the first time they're seen
  ensureOwned(id) {
    if (!this.data.owned.includes(id)) {
      this.data.owned.push(id);
      this.save();
    }
  },

  ownedSpecs(kind) {
    const out = [];
    for (const id of this.data.owned) {
      const spec = specById(id);
      if (spec && (!kind || kindOf(spec) === kind)) out.push(spec);
    }
    return out.sort((a, b) => a.tier - b.tier);
  },

  canAfford(spec) {
    if (!spec.price) return true;
    if (!this.isResearchable(spec) && !this.isResearched(spec)) return false;
    if (this.data.silver < spec.price.silver) return false;
    // researched outright, or covered by what is left in the free RP pool —
    // which is exactly what "enough RP" meant before research targets existed
    return this.isResearched(spec) || this.data.rp >= this.researchRemaining(spec);
  },

  unlock(spec) {
    if (this.isOwned(spec.id) || !this.canAfford(spec)) return false;
    if (spec.price) {
      const remaining = this.researchRemaining(spec);
      if (remaining > 0) {
        // finish the research out of the free pool, then pay the Silver bill
        this.data.rp -= remaining;
        this.data.research.points[spec.id] = this.researchCost(spec);
      }
      this.data.silver -= spec.price.silver;
      this.data.stats.spent += spec.price.silver;
    }
    this.data.owned.push(spec.id);
    if (this.data.research.target === spec.id) this.data.research.target = null;
    this.save();
    return true;
  },

  getSelected(mode) {
    const id = this.data.selected[mode];
    return this.isOwned(id) ? id : DEFAULTS.selected[mode];
  },

  setSelected(mode, id) {
    this.data.selected[mode] = id;
    this.save();
  },

  setBattleMode(mode) {
    this.data.battleMode = mode;
    this.save();
  },

  getDifficulty() {
    return this.data.difficulty || 'arcade';
  },

  setDifficulty(v) {
    this.data.difficulty = v;
    this.save();
  },

  getLoadout(vehicleId) {
    return this.data.loadout[vehicleId] || 'clean';
  },

  setLoadout(vehicleId, value) {
    this.data.loadout[vehicleId] = value;
    this.save();
  },

  setAmmoCount(vehicleId, shellKey, count) {
    const d = this.data.ammoLoadout[vehicleId] || (this.data.ammoLoadout[vehicleId] = {});
    d[shellKey] = Math.max(0, Math.round(count));
    this.save();
  },

  // -------------------------------------------------------------------------
  // modifications
  // -------------------------------------------------------------------------

  // `cost` is either a plain RP number (the original contract) or an
  // { rp, silver } pair from the tiered tree.
  buyMod(vehicleId, modId, cost) {
    const list = this.data.mods[vehicleId] || (this.data.mods[vehicleId] = []);
    if (list.includes(modId)) return false;
    const rp = typeof cost === 'number' ? cost : cost?.rp || 0;
    const silver = typeof cost === 'number' ? 0 : cost?.silver || 0;
    if (this.data.rp < rp || this.data.silver < silver) return false;
    this.data.rp -= rp;
    this.data.silver -= silver;
    this.data.stats.spent += silver;
    list.push(modId);
    this.save();
    return true;
  },

  // -------------------------------------------------------------------------
  // research tree
  // -------------------------------------------------------------------------

  // What a vehicle costs to research. Identical to the RP half of its price,
  // so the numbers on the card are the numbers that were always there.
  researchCost(spec) {
    const s = typeof spec === 'string' ? specById(spec) : spec;
    if (!s || !s.price) return 0;
    return s.price.rp;
  },

  researchInvested(spec) {
    const id = typeof spec === 'string' ? spec : spec?.id;
    return this.data.research.points[id] || 0;
  },

  researchRemaining(spec) {
    return Math.max(0, this.researchCost(spec) - this.researchInvested(spec));
  },

  isResearched(spec) {
    const s = typeof spec === 'string' ? specById(spec) : spec;
    if (!s) return false;
    if (!s.price) return true;
    if (this.isOwned(s.id)) return true;
    return this.researchInvested(s) >= this.researchCost(s);
  },

  researchProgress(spec) {
    const s = typeof spec === 'string' ? specById(spec) : spec;
    const cost = this.researchCost(s);
    const spent = Math.min(this.researchInvested(s), cost || 0);
    return {
      spent, cost,
      pct: cost > 0 ? Math.min(1, spent / cost) : 1,
      done: this.isResearched(s),
    };
  },

  // The tree is derived, never authored. A vehicle's prerequisite is the
  // machine directly below it on its own nation's line; where that line has a
  // hole (each nation holds one vehicle per tier at most, so the Tiger's only
  // German predecessor is a tier-1 SPAA two rungs down) the national gate would
  // be no gate at all — it would let a fresh save research the Tiger and the
  // Pershing off the two free starter vehicles. A predecessor more than one
  // tier down is therefore ignored in favour of the tier gate, which asks for
  // an owned machine of the tier immediately below.
  prerequisiteFor(spec) {
    const s = typeof spec === 'string' ? specById(spec) : spec;
    if (!s || !s.price) return null;
    const kind = kindOf(s);
    const family = Object.values(kind === 'air' ? PLANE_SPECS : TANK_SPECS);
    let best = null;
    for (const other of family) {
      if (other.id === s.id || other.tier >= s.tier) continue;
      if (other.nation !== s.nation) continue;
      if (!best || other.tier > best.tier) best = other;
    }
    if (best && best.tier === s.tier - 1) {
      return { kind: 'vehicle', spec: best, tier: best.tier };
    }
    // no adjacent national predecessor: any owned machine one tier down opens
    // the line, which is the same ladder the air tree already climbs
    const tier = s.tier - 1;
    if (tier <= 0) return null;
    return { kind: 'tier', tier, vehicleKind: kind };
  },

  // Can research even begin? Owned vehicles are done; everything else needs
  // its prerequisite satisfied first.
  isResearchable(spec) {
    const s = typeof spec === 'string' ? specById(spec) : spec;
    if (!s) return false;
    if (!s.price) return true;
    const req = this.prerequisiteFor(s);
    if (!req) return true;
    if (req.kind === 'vehicle') return this.isOwned(req.spec.id);
    for (const owned of this.ownedSpecs(req.vehicleKind)) {
      if (owned.tier >= req.tier) return true;
    }
    return false;
  },

  // Human-readable reason a vehicle cannot be researched yet, or null.
  researchBlockedBy(spec) {
    const s = typeof spec === 'string' ? specById(spec) : spec;
    if (!s || this.isResearchable(s)) return null;
    const req = this.prerequisiteFor(s);
    if (!req) return null;
    return req.kind === 'vehicle'
      ? `Requires ${req.spec.name}`
      : `Requires any tier ${req.tier} ${req.vehicleKind === 'air' ? 'aircraft' : 'vehicle'}`;
  },

  // A finished or purchased target stops being one: the RP has to go somewhere
  // useful, and the garage should be asking you what is next.
  getResearchTarget() {
    const id = this.data.research.target;
    if (!id) return null;
    const spec = specById(id);
    if (!spec || this.isOwned(id) || !this.isResearchable(spec)) return null;
    if (this.isResearched(spec)) return null;
    return id;
  },

  setResearchTarget(vehicleId) {
    if (!vehicleId) {
      this.data.research.target = null;
      this.save();
      return true;
    }
    const spec = specById(vehicleId);
    if (!spec || this.isOwned(vehicleId) || !this.isResearchable(spec)) return false;
    if (this.isResearched(spec)) return false;
    this.data.research.target = vehicleId;
    this.save();
    return true;
  },

  // Pour RP into one vehicle. Anything past the finish line spills back into
  // the free pool rather than evaporating.
  addResearchPoints(vehicleId, amount) {
    const spec = specById(vehicleId);
    if (!spec || amount <= 0) return 0;
    const cost = this.researchCost(spec);
    const cur = this.data.research.points[vehicleId] || 0;
    const applied = Math.min(amount, Math.max(0, cost - cur));
    this.data.research.points[vehicleId] = cur + applied;
    if (applied < amount) this.data.rp += amount - applied;
    return applied;
  },

  // Spend free RP to close out a research bar by hand.
  applyFreeRp(vehicleId, amount) {
    const spec = specById(vehicleId);
    if (!spec) return 0;
    const want = Math.min(
      Math.max(0, Math.round(amount)), this.data.rp, this.researchRemaining(spec),
    );
    if (want <= 0) return 0;
    this.data.rp -= want;
    this.data.research.points[vehicleId] =
      (this.data.research.points[vehicleId] || 0) + want;
    this.save();
    return want;
  },

  // -------------------------------------------------------------------------
  // crew
  // -------------------------------------------------------------------------

  crewLevels(vehicleId) {
    return this.data.crew[vehicleId] || {};
  },

  crewLevel(vehicleId, skillId) {
    return this.crewLevels(vehicleId)[skillId] || 0;
  },

  crewTrainCost(vehicleId, skillId) {
    const level = this.crewLevel(vehicleId, skillId);
    if (level >= CREW_MAX_LEVEL) return null;
    const spec = specById(vehicleId);
    const tier = spec?.tier || 1;
    return Math.round(CREW_LEVEL_COST[level] * (0.7 + 0.3 * tier));
  },

  canTrainCrew(vehicleId, skillId) {
    const cost = this.crewTrainCost(vehicleId, skillId);
    return cost != null && this.data.crewXp >= cost;
  },

  trainCrew(vehicleId, skillId) {
    const cost = this.crewTrainCost(vehicleId, skillId);
    if (cost == null || this.data.crewXp < cost) return false;
    const slot = this.data.crew[vehicleId] || (this.data.crew[vehicleId] = {});
    slot[skillId] = (slot[skillId] || 0) + 1;
    this.data.crewXp -= cost;
    crewCache.delete(vehicleId);
    this.save();
    return true;
  },

  crewTotalLevel(vehicleId) {
    const levels = this.crewLevels(vehicleId);
    let total = 0;
    for (const s of CREW_SKILLS) total += levels[s.id] || 0;
    return total;
  },

  crewQual(vehicleId) {
    return Math.min(CREW_QUALS.length - 1, this.data.crew[vehicleId]?.qual || 0);
  },

  // What the next qualification step costs, or null once the crew is Ace.
  crewQualCost(vehicleId) {
    const at = this.crewQual(vehicleId);
    const next = CREW_QUALS[at + 1];
    if (!next) return null;
    const spec = specById(vehicleId);
    const tier = spec?.tier || 1;
    const br = spec ? brOf(spec) : 1;
    const silver = Math.round(900 * tier * (0.6 + br * 0.2) * (at === 0 ? 1 : 2.4));
    return {
      level: at + 1,
      name: next.name,
      minLevel: next.minLevel,
      silver,
      rp: at === 0 ? 0 : Math.round(silver * 0.5),
    };
  },

  canQualifyCrew(vehicleId) {
    const cost = this.crewQualCost(vehicleId);
    if (!cost) return false;
    return this.crewTotalLevel(vehicleId) >= cost.minLevel &&
      this.data.silver >= cost.silver && this.data.rp >= cost.rp;
  },

  qualifyCrew(vehicleId) {
    if (!this.canQualifyCrew(vehicleId)) return false;
    const cost = this.crewQualCost(vehicleId);
    this.data.silver -= cost.silver;
    this.data.rp -= cost.rp;
    this.data.stats.spent += cost.silver;
    const slot = this.data.crew[vehicleId] || (this.data.crew[vehicleId] = {});
    slot.qual = cost.level;
    crewCache.delete(vehicleId);
    this.save();
    return true;
  },

  // Multipliers the Tank and Plane classes can apply straight to their spec.
  // Everything is a factor around 1.0, and every one of them is 1.0 for an
  // untrained crew, so a caller that forgets a skill loses nothing.
  crewSkills(vehicleId) {
    if (crewCache.has(vehicleId)) return crewCache.get(vehicleId);
    const levels = this.crewLevels(vehicleId);
    const qual = this.crewQual(vehicleId);
    const boost = 1 + (CREW_QUALS[qual]?.boost || 0);
    const out = { levels: {}, total: 0, qual, qualName: CREW_QUALS[qual].name };
    for (const s of CREW_SKILLS) {
      const lvl = levels[s.id] || 0;
      out.levels[s.id] = lvl;
      out.total += lvl;
      // qualification multiplies the bonus, never the base: an untrained crew
      // is exactly 1.0 no matter how much Silver was spent on it
      out[s.key] = 1 + s.dir * s.per * lvl * boost;
    }
    // crew count is a whole number: vitality buys the fifth man back
    out.crewBonus = Math.floor((out.vitality - 1) / 0.18);
    crewCache.set(vehicleId, out);
    return out;
  },

  // -------------------------------------------------------------------------
  // lineups and spawn points
  // -------------------------------------------------------------------------

  // Which kinds of vehicle a battle mode will take.
  lineupKinds(mode) {
    if (mode === 'air') return ['air'];
    if (mode === 'combined') return ['ground', 'air'];
    return ['ground'];
  },

  getLineup(mode) {
    const kinds = this.lineupKinds(mode);
    const stored = (this.data.lineups[mode] || []).filter((id) => {
      const spec = specById(id);
      return spec && this.isOwned(id) && kinds.includes(kindOf(spec));
    });
    if (stored.length) return stored.slice(0, LINEUP_MAX);
    // No lineup picked yet. The selected vehicle for each kind seeds it, as it
    // always did — but stopping there handed Combined Arms a roster of two, one
    // tank and one aeroplane, when the spawn budget is built to carry four. So
    // the rest of the garage fills the empty slots, nearest Battle Rating
    // first: a reserve three ranks off the machine the battle was matched on is
    // a life nobody would spend.
    const out = [];
    for (const kind of kinds) {
      const id = this.getSelected(kind);
      if (id && specById(id) && this.isOwned(id) && !out.includes(id)) out.push(id);
    }
    if (out.length >= LINEUP_MAX) return out.slice(0, LINEUP_MAX);
    const anchor = out.length ? brOf(specById(out[0])) : 1;
    const reserves = [];
    for (const id of this.data.owned) {
      if (out.includes(id)) continue;
      const spec = specById(id);
      if (!spec || !kinds.includes(kindOf(spec))) continue;
      reserves.push({ id, gap: Math.abs(brOf(spec) - anchor) });
    }
    reserves.sort((a, b) => a.gap - b.gap);
    for (const r of reserves) {
      if (out.length >= LINEUP_MAX) break;
      // a save written by an older build can carry the same id twice, and a
      // lineup with a duplicate in it is a spawn slot the player cannot use
      if (!out.includes(r.id)) out.push(r.id);
    }
    return out;
  },

  setLineup(mode, ids) {
    const kinds = this.lineupKinds(mode);
    const clean = [];
    for (const id of ids || []) {
      const spec = specById(id);
      if (!spec || !this.isOwned(id) || !kinds.includes(kindOf(spec))) continue;
      if (!clean.includes(id)) clean.push(id);
      if (clean.length >= LINEUP_MAX) break;
    }
    this.data.lineups[mode] = clean;
    this.save();
    return clean;
  },

  toggleLineup(mode, id) {
    const cur = (this.data.lineups[mode] || []).slice();
    const at = cur.indexOf(id);
    if (at >= 0) cur.splice(at, 1);
    else if (cur.length < LINEUP_MAX) cur.push(id);
    else return false;
    this.setLineup(mode, cur);
    return true;
  },

  // What one spawn in this vehicle costs out of the battle's spawn budget.
  spawnCost(spec) {
    const s = typeof spec === 'string' ? specById(spec) : spec;
    if (!s) return SPAWN_START;
    return Math.round(26 + (s.tier || 1) * 14 + brOf(s) * 9);
  },

  // Spawn points earned by an event tally, for the battle files to add up.
  spawnPointsFor({
    kills = 0, assists = 0, groundKills = 0, caps = 0, hits = 0, capTicks = 0,
    minutes = 0,
  } = {}) {
    return Math.round(
      kills * SPAWN_AWARDS.kill + assists * SPAWN_AWARDS.assist +
      groundKills * SPAWN_AWARDS.groundKill + caps * SPAWN_AWARDS.cap +
      hits * SPAWN_AWARDS.hit + capTicks * SPAWN_AWARDS.capTick +
      minutes * SPAWN_AWARDS.perMinute,
    );
  },

  // -------------------------------------------------------------------------
  // expenses
  // -------------------------------------------------------------------------

  // The repair bill for one vehicle. `destroyed` false bills the lighter
  // "damaged but drove home" rate, which is what a survived battle costs.
  repairCost(spec, destroyed = true) {
    const s = typeof spec === 'string' ? specById(spec) : spec;
    if (!s) return 0;
    const br = brOf(s);
    const tier = s.tier || 1;
    const raw = REPAIR.base + tier * tier * REPAIR.tier + br * br * REPAIR.br;
    const mult = DIFFICULTY_MULT[this.getDifficulty()]?.repair || 1;
    return Math.round(raw * mult * (destroyed ? 1 : REPAIR.partial));
  },

  // Silver per round, by calibre. A 100mm AP round is not a rifle cartridge
  // and the results screen should say so.
  shellCost(spec, shellKey) {
    const s = typeof spec === 'string' ? specById(spec) : spec;
    const shell = s?.shells?.[shellKey];
    if (!shell) return 0;
    const cal = shell.caliber || 37;
    const premium = shell.kind === 'APCR' || shell.kind === 'HEAT' ? 1.8 : 1;
    return Math.max(1, Math.round((Math.pow(cal, 1.6) / 22) * premium));
  },

  // Ammunition and consumables actually spent this battle.
  //   usage = { id, shells: { AP: 12, APCR: 3 }, stream: 240, consumables: 2 }
  // `stream` covers machine-gun and autocannon belts, `consumables` the
  // repair kits, extinguishers and first-aid packs used.
  ammoCost(spec, usage = {}) {
    const s = typeof spec === 'string' ? specById(spec) : spec;
    if (!s) return 0;
    let total = 0;
    const shells = usage.shells || {};
    for (const k of Object.keys(shells)) {
      total += this.shellCost(s, k) * Math.max(0, shells[k] || 0);
    }
    if (usage.stream) {
      // belt-fed weapons: cheap per round, but you fire thousands of them
      const cal = s.aa ? 20 : 8;
      total += Math.max(0, usage.stream) * (cal >= 20 ? 0.9 : 0.22);
    }
    if (usage.bombs) total += Math.max(0, usage.bombs) * 320;
    if (usage.rockets) total += Math.max(0, usage.rockets) * 180;
    return Math.round(total);
  },

  consumableCost(usage = {}) {
    if (typeof usage === 'number') return Math.round(usage * CONSUMABLE_COST.parts);
    let total = 0;
    for (const k of Object.keys(CONSUMABLE_COST)) {
      total += (usage[k] || 0) * CONSUMABLE_COST[k];
    }
    return Math.round(total);
  },

  // -------------------------------------------------------------------------
  // settlement
  // -------------------------------------------------------------------------

  get settings() {
    return this.data.settings;
  },

  getSetting(key) {
    const v = this.data.settings[key];
    return v == null ? DEFAULT_SETTINGS[key] : v;
  },

  setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return false;
    const d = DEFAULT_SETTINGS[key];
    if (key === 'graphics') {
      if (!GRAPHICS_CHOICES.includes(value)) return false;
      this.data.settings[key] = value;
    } else if (key === 'controls') {
      this.data.settings[key] = cleanControls(value);
    } else if (typeof d === 'boolean') {
      this.data.settings[key] = !!value;
    } else if (SENS_KEYS.includes(key)) {
      this.data.settings[key] = cleanSetting(key, value);
    } else {
      this.data.settings[key] = Number(value);
    }
    this.save();
    return true;
  },

  // With no argument every setting goes back to its default; with a list of
  // keys only those do (the hangar resets audio, sensitivity and controls
  // separately).
  resetSettings(keys) {
    if (Array.isArray(keys)) {
      for (const k of keys) {
        if (k in DEFAULT_SETTINGS) this.data.settings[k] = cleanSetting(k, DEFAULT_SETTINGS[k]);
      }
    } else {
      this.data.settings = sanitizeSettings({ graphics: DEFAULT_SETTINGS.graphics });
    }
    this.save();
  },

  get defaultSettings() {
    return sanitizeSettings({ graphics: DEFAULT_SETTINGS.graphics });
  },

  // Settle one battle: gross income, then the bill.
  //
  //   settle({
  //     victory, kills, assists, groundKills, hits, caps, damage, seconds,
  //     scouts, capTicks, fires,        // the three the HUD pays out live
  //     vehicleId,                      // the vehicle you played
  //     losses: ['tiger'],              // vehicles destroyed (ids or specs)
  //     survived: ['t34'],              // spawned and driven home (part repair)
  //     usage: [{ id, shells: {...}, stream, consumables: { parts: 1 } }],
  //     apply: true,                    // false to preview without banking it
  //   })
  //
  // Returns { items, gross, expenses, net, silver, rp, crewXp, clamped }.
  // `items` is the itemised list the results screen prints, income first and
  // expenses (negative Silver) after.
  settle(result = {}) {
    const {
      victory = false, kills = 0, assists = 0, groundKills = 0, hits = 0,
      caps = 0, damage = 0, seconds = 0, quit = false, vehicleId = null,
      apply = true,
    } = result;
    // The battle files each spell these slightly differently — one counts every
    // fire it put out, another only remembers whether it put one out at all —
    // so every shape they hand over is read here rather than in three places.
    const scouts = count(result.scouts ?? result.scoutReports);
    const capTicks = count(result.capTicks);
    const fires = count(result.fires ?? result.firesPutOut ?? result.firePutOut);
    const diff = DIFFICULTY_MULT[result.difficulty || this.getDifficulty()] ||
      DIFFICULTY_MULT.arcade;
    const won = victory && !quit;
    const minutes = Math.max(0, seconds) / 60;
    const items = [];

    const add = (label, silver, rp = 0) => {
      if (!silver && !rp) return;
      items.push({ label, silver: Math.round(silver), rp: Math.round(rp) });
    };

    const S = REWARD.silver;
    const R = REWARD.rp;
    add('Battle activity', S.base, R.base);
    if (kills) add(`Vehicles destroyed ×${kills}`, S.kill * kills, R.kill * kills);
    if (assists) add(`Assists ×${assists}`, S.assist * assists, R.assist * assists);
    if (groundKills) {
      add(`Ground targets ×${groundKills}`, S.ground * groundKills, R.ground * groundKills);
    }
    if (hits) add(`Penetrating hits ×${hits}`, S.hit * hits, R.hit * hits);
    if (caps) add(`Point captures ×${caps}`, S.cap * caps, R.cap * caps);
    if (scouts) add(`Scout reports ×${scouts}`, S.scout * scouts, R.scout * scouts);
    if (capTicks) add(`Zone control ×${capTicks}`, S.capTick * capTicks, R.capTick * capTicks);
    if (fires) add(`Fires extinguished ×${fires}`, S.fire * fires, R.fire * fires);
    if (damage) add('Damage dealt', S.damage * damage, R.damage * damage);
    if (minutes > 0.25) add('Time in battle', S.perMinute * minutes, R.perMinute * minutes);
    if (won) add('Victory bonus', S.victory, R.victory);

    let gross = 0;
    let grossRp = 0;
    for (const it of items) {
      gross += it.silver;
      grossRp += it.rp;
    }
    // What the machine you brought is worth per action. Printed as its own row
    // so the results screen can show why the Tiger's battle paid more than the
    // Stuart's — and skipped entirely for a tier-1, where it is 1.0.
    const mult = rewardMultiplier(vehicleId);
    const bonusVs = Math.round(gross * (mult.silver - 1));
    const bonusVr = Math.round(grossRp * (mult.rp - 1));
    if (bonusVs || bonusVr) {
      const spec = specById(vehicleId);
      add(`Vehicle bonus — ${spec?.name || 'vehicle'}`, bonusVs, bonusVr);
      gross += bonusVs;
      grossRp += bonusVr;
    }
    if (diff.silver !== 1 || diff.rp !== 1) {
      const bonusS = Math.round(gross * (diff.silver - 1));
      const bonusR = Math.round(grossRp * (diff.rp - 1));
      add('Realistic bonus', bonusS, bonusR);
      gross += bonusS;
      grossRp += bonusR;
    }
    if (quit) {
      // leaving early forfeits a third of the gross, as it should
      const penaltyS = -Math.round(gross * 0.34);
      const penaltyR = -Math.round(grossRp * 0.34);
      add('Left the battle early', penaltyS, penaltyR);
      gross += penaltyS;
      grossRp += penaltyR;
    }

    // ---- expenses ----
    let expenses = 0;
    const bill = (label, silver) => {
      if (silver <= 0) return;
      items.push({ label, silver: -Math.round(silver), rp: 0 });
      expenses += Math.round(silver);
    };

    const asId = (v) => (typeof v === 'string' ? v : v?.id || v?.specId || null);
    const losses = (Array.isArray(result.losses) ? result.losses : []).map(asId).filter(Boolean);
    for (const id of losses) {
      const spec = specById(id);
      if (!spec) continue;
      bill(`Repair — ${spec.name}`, this.repairCost(spec, true));
    }
    const survived = (Array.isArray(result.survived) ? result.survived : [])
      .map(asId).filter(Boolean);
    for (const id of survived) {
      const spec = specById(id);
      if (!spec) continue;
      bill(`Maintenance — ${spec.name}`, this.repairCost(spec, false));
    }

    const usageList = Array.isArray(result.usage)
      ? result.usage
      : result.usage ? [result.usage] : [];
    let ammoTotal = 0;
    let consumableTotal = 0;
    for (const u of usageList) {
      const spec = specById(u.id || u.specId || vehicleId);
      if (spec) ammoTotal += this.ammoCost(spec, u);
      if (u.consumables) consumableTotal += this.consumableCost(u.consumables);
    }
    if (result.consumables) consumableTotal += this.consumableCost(result.consumables);
    bill('Ammunition', ammoTotal);
    bill('Consumables', consumableTotal);

    const net = gross - expenses;
    // Crew XP tracks how much battle you actually did, not what you spent.
    const crewXp = Math.max(0, Math.round(grossRp * 0.35 + kills * 25 + caps * 20));
    // carried as its own row so the results screen can print it in the list;
    // the currency columns stay zero because crew XP is neither of them
    if (crewXp) items.push({ label: `Crew experience +${crewXp} XP`, silver: 0, rp: 0, crewXp });

    const out = {
      items, gross, grossRp, expenses, net,
      silver: net, rp: grossRp, crewXp,
      clamped: false, debt: 0,
      research: null,
    };

    if (!apply) return out;

    // ---- bank it ----
    if (this.data.silver + net < 0) {
      // the player never goes into debt; the shortfall is written off and
      // flagged so the results screen can say the battle cost more than it paid
      out.debt = -(this.data.silver + net);
      out.clamped = true;
      this.data.silver = 0;
    } else {
      this.data.silver += net;
    }
    if (net > 0) this.data.stats.earned += net;
    else this.data.stats.spent += -net;

    const target = this.getResearchTarget();
    if (target && grossRp > 0) {
      // most of the RP goes to what you are researching; the rest stays free
      // so modifications on the vehicle you are actually flying still progress
      const toTarget = Math.round(grossRp * 0.75);
      const applied = this.addResearchPoints(target, toTarget);
      this.data.rp += grossRp - toTarget;
      const spec = specById(target);
      out.research = {
        id: target, name: spec?.name || target, applied,
        ...this.researchProgress(spec),
      };
    } else {
      this.data.rp += grossRp;
    }
    this.data.crewXp += crewXp;

    this.data.stats.battles += 1;
    if (won) this.data.stats.wins += 1;
    this.data.stats.kills += kills;
    this.data.stats.deaths += losses.length;
    this.save();
    return out;
  },

  // Original battle payout. Still the exact same call main.js makes, and still
  // returns { silver, rp } — it just runs through the settlement now, so a
  // caller that starts passing losses and ammunition gets the full economy.
  grantBattleRewards({
    victory, kills, assists = 0, groundKills = 0, hits = 0, caps = 0, ...rest
  }) {
    const out = this.settle({
      victory, kills, assists, groundKills, hits, caps, ...rest,
    });
    return { silver: out.silver, rp: out.rp, crewXp: out.crewXp, settlement: out };
  },
};

// The running spawn-point budget for one battle. A battle file makes one of
// these at the start, calls award() as the player scores, and asks canSpawn()
// before offering a respawn — the vehicle you keep losing is the vehicle you
// stop being able to afford to bring back.
export function createSpawnBudget(mode = 'ground', lineup = null) {
  const roster = lineup || progress.getLineup(mode);
  return {
    mode,
    lineup: roster.slice(),
    points: SPAWN_START,
    spawned: [],
    // the first spawn of a battle is always free, whatever you brought
    cost(id) {
      return this.spawned.length === 0 ? 0 : progress.spawnCost(id);
    },
    canSpawn(id) {
      if (!this.lineup.length) return true; // no lineup picked: single vehicle
      if (!this.lineup.includes(id)) return false;
      return this.points >= this.cost(id);
    },
    spend(id) {
      if (!this.canSpawn(id)) return false;
      this.points -= this.cost(id);
      this.spawned.push(id);
      return true;
    },
    award(events) {
      const gained = progress.spawnPointsFor(events);
      this.points += gained;
      return gained;
    },
    // what is still affordable, for a respawn picker to grey out the rest
    available() {
      return this.lineup.filter((id) => this.canSpawn(id));
    },
  };
}

// Everything a battle needs to set itself up: the player's vehicle, the
// lineup behind it, and a BR-matched roster for both teams.
export function planBattle({
  mode = 'ground', kind = null, playerSpecId = null, rng = Math.random,
  allies = 3, enemies = 4,
} = {}) {
  const k = kind || (mode === 'air' ? 'air' : 'ground');
  const playerId = playerSpecId || progress.getSelected(k);
  const playerSpec = specById(playerId);
  const difficulty = progress.getDifficulty();
  const air = matchmake({
    playerSpec, difficulty, rng, kind: 'air',
    allies: mode === 'combined' ? 3 : allies,
    enemies: mode === 'combined' ? 3 : enemies,
  });
  const ground = matchmake({
    playerSpec, difficulty, rng, kind: 'ground',
    allies: mode === 'combined' ? 5 : allies,
    enemies: mode === 'combined' ? 5 : enemies,
  });
  const own = kindOf(playerSpec) === 'air' ? air : ground;
  return {
    playerId,
    playerSpec,
    difficulty,
    br: own.playerBr,
    battleBr: own.battleBr,
    uptier: own.uptier,
    bracket: own.bracket,
    lineup: progress.getLineup(mode),
    spawnBudget: createSpawnBudget(mode),
    allies: own.allies,
    enemies: own.enemies,
    tankAllies: ground.allies,
    tankEnemies: ground.enemies,
    planeAllies: air.allies,
    planeEnemies: air.enemies,
  };
}

// A vehicle with no price is owned from the start; make that true before any
// screen asks, so the garage never renders a free vehicle as locked.
for (const spec of Object.values(SPEC_INDEX)) {
  if (!spec.price && !progress.data.owned.includes(spec.id)) {
    progress.data.owned.push(spec.id);
  }
}
