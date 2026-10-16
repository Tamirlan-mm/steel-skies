import { progress, CREW_SKILLS } from './progress.js';

// Per-vehicle modifications, bought with RP and Silver and applied only to the
// player's vehicle at spawn time (AI always flies and drives stock).
//
// The list used to be six flat modules at one price. It is now a four-tier
// tree: a tier opens only once enough of the tier below it is installed, so
// the best shell and the artillery call-in sit behind an actual investment
// rather than behind one number. Every id that existed before still exists and
// still does exactly what it did — the tree only sorts them and adds to them.
export const MOD_TIER_COUNT = 4;

// Mirrors tankEntity's own fallback, for the one tank spec that might ship
// without an authored dispersion figure. Kept local so mods.js still has no
// dependency on the entity classes.
const BASE_DISPERSION = 0.0012;

// How many modules of the previous tier open the next one. Two thirds of it,
// rounded up: enough that you have to commit, not so many that the last tier
// is unreachable.
export function tierRequirement(prevCount) {
  return Math.max(1, Math.ceil(prevCount * 0.66));
}

export const MOD_DEFS = {
  ground: [
    // --- tier 1: keep it running ---
    { id: 'repair', tier: 1, name: 'Parts', desc: '35% faster module repairs' },
    { id: 'tracks', tier: 1, name: 'Tracks', desc: '+10% turn rate, +5% acceleration' },
    { id: 'brakes', tier: 1, name: 'Brake System', desc: 'Sharper stopping, +20% reverse speed' },
    // --- tier 2: fight better ---
    { id: 'fpe', tier: 2, name: 'FPE', desc: 'A second extinguisher charge' },
    { id: 'adjustment', tier: 2, name: 'Adjustment of Fire', desc: '-15% gun dispersion' },
    { id: 'turret', tier: 2, name: 'Elevation Mechanism', desc: '+20% turret traverse speed' },
    { id: 'filters', tier: 2, name: 'Filters', desc: '+4% speed, +4% acceleration' },
    // --- tier 3: the machine itself ---
    { id: 'crewrepl', tier: 3, name: 'Crew Replenishment', desc: '+2 first aid kits for the wounded' },
    { id: 'engine', tier: 3, name: 'Engine', desc: '+12% speed & acceleration' },
    { id: 'loader', tier: 3, name: 'Loader', desc: '-15% reload time' },
    { id: 'shells', tier: 3, name: 'Improved Shells', desc: '+12% penetration' },
    // --- tier 4: the good stuff ---
    { id: 'transmission', tier: 4, name: 'Transmission', desc: '+8% acceleration, +6% turn rate' },
    { id: 'hdrive', tier: 4, name: 'Horizontal Drive', desc: '+15% turret traverse speed' },
    { id: 'arty', tier: 4, name: 'Artillery Support', desc: 'Fire mission net, +15% spotting range' },
    { id: 'shell3', tier: 4, name: 'Ammunition', desc: 'Unlock the special shell' },
  ],
  air: [
    // --- tier 1: airframe and cooling ---
    { id: 'airframe', tier: 1, name: 'Fuselage Repair', desc: '+20% durability' },
    { id: 'rad', tier: 1, name: 'Radiator', desc: '+3% speed, engine runs cooler' },
    { id: 'comp', tier: 1, name: 'Compressor', desc: '+4% speed at altitude' },
    // --- tier 2: handling ---
    { id: 'flaps', tier: 2, name: 'Combat Flaps', desc: '+12% pitch, +8% roll rate' },
    { id: 'boost', tier: 2, name: 'New Boosters', desc: '+12% acceleration' },
    { id: 'ammo', tier: 2, name: 'Ammo Racks', desc: '+35% gun rounds' },
    // --- tier 3: guns and engine ---
    { id: 'belts', tier: 3, name: 'Offensive Belts', desc: '+15% gun damage' },
    { id: 'engine', tier: 3, name: 'Engine', desc: '+10% speed & acceleration' },
    { id: 'armour', tier: 3, name: 'Cockpit Armour', desc: '+10% durability, pilot protected' },
    // --- tier 4: ordnance ---
    { id: 'injection', tier: 4, name: 'Engine Injection', desc: '+5% speed & acceleration' },
    { id: 'sight', tier: 4, name: 'Gyro Gunsight', desc: '-15% gun dispersion' },
    { id: 'bombs', tier: 4, name: 'Bombs', desc: 'Unlock the bomb loadout' },
    { id: 'rockets', tier: 4, name: 'Rockets', desc: 'Unlock the rocket loadout' },
  ],
};

// MOD_DEFS grouped by tier: MOD_TREE.ground[0] is tier 1.
export const MOD_TREE = {
  ground: buildTree('ground'),
  air: buildTree('air'),
};

function buildTree(kind) {
  const tiers = [];
  for (let t = 1; t <= MOD_TIER_COUNT; t++) {
    tiers.push(MOD_DEFS[kind].filter((m) => m.tier === t));
  }
  return tiers;
}

export function modDef(kind, modId) {
  return MOD_DEFS[kind].find((m) => m.id === modId) || null;
}

// the third (special) shell key of a tank, e.g. 'APCR' / 'APHE' / 'HEAT'
export function specialShellKey(spec) {
  if (!spec.shells) return null;
  return Object.keys(spec.shells).find((k) => k !== 'AP' && k !== 'HE') || null;
}

// The stock number of rounds of one type, before the rack is balanced. The
// special shell is authored with count 0 because it is locked; once its module
// is bought it has to arrive with a real share of the rack or the player has
// paid a tier-4 price for an empty ammunition bin.
function stockCount(spec, key, special) {
  const authored = spec.shells[key].count;
  if (authored > 0 || key !== special) return authored;
  return Math.max(1, Math.round((spec.ammoCap || 20) * 0.2));
}

// resolved shell counts for a tank: garage picks + defaults, clamped to cap
export function ammoDistribution(spec, owned = ownedMods(spec.id)) {
  const stored = progress.data.ammoLoadout[spec.id] || {};
  const special = specialShellKey(spec);
  const keys = Object.keys(spec.shells).filter(
    (k) => k !== special || owned.includes('shell3'),
  );
  const cap = spec.ammoCap || 0;
  const out = {};
  let total = 0;
  for (const k of keys) {
    let v = stored[k] != null ? stored[k] : stockCount(spec, k, special);
    v = Math.max(0, Math.round(v));
    out[k] = v;
    total += v;
  }
  let over = total - (cap || total);
  // The stock counts of several tanks add up to more than the rack holds — the
  // SU-100 alone stows 45 rounds of authored ammunition in 33 slots. Shave the
  // types the player has not set by hand in proportion, leaving at least one of
  // each, instead of cutting the tail types to nothing: the old tail-first trim
  // sent the SU-100 out with no HE at all and its APHE forever at zero.
  if (over > 0) {
    const flex = keys.filter((k) => stored[k] == null && out[k] > 1);
    let pool = 0;
    for (const k of flex) pool += out[k] - 1;
    if (pool > 0) {
      const take = Math.min(over, pool);
      let taken = 0;
      for (let i = 0; i < flex.length && taken < take; i++) {
        // the last type absorbs the rounding so the total lands exactly on cap
        const want = i === flex.length - 1
          ? take - taken
          : Math.round(((out[flex[i]] - 1) / pool) * take);
        const cut = Math.min(want, out[flex[i]] - 1, take - taken);
        out[flex[i]] -= cut;
        taken += cut;
      }
      over -= taken;
    }
  }
  // still over: the player asked for more than fits, so the tail gives way
  for (let i = keys.length - 1; i >= 0 && over > 0; i--) {
    const cut = Math.min(over, out[keys[i]]);
    out[keys[i]] -= cut;
    over -= cut;
  }
  return out;
}

// Legacy flat cost in RP. Still exported, still the same number, still what a
// caller that has not heard of the tree will get.
export function modCost(spec) {
  return spec.tier * 150; // RP
}

// A module deeper in the tree costs more, and a module on a heavier vehicle
// costs more again. Both currencies, as everything does now.
const TIER_FACTOR = [1, 1.6, 2.4, 3.4];

export function modCostFor(spec, mod) {
  const tier = typeof mod === 'number' ? mod : mod?.tier || 1;
  const rp = Math.round((spec.tier || 1) * 110 * TIER_FACTOR[tier - 1]);
  return { rp, silver: Math.round(rp * 0.85) };
}

export function ownedMods(vehicleId) {
  return progress.data.mods[vehicleId] || [];
}

// How many modules of each tier are installed on a vehicle.
export function tierCounts(vehicleId, kind) {
  const owned = ownedMods(vehicleId);
  const counts = [];
  for (let t = 0; t < MOD_TIER_COUNT; t++) {
    counts.push(MOD_TREE[kind][t].filter((m) => owned.includes(m.id)).length);
  }
  return counts;
}

// Is a tier open? Tier 1 always; every tier after it needs its predecessor
// mostly bought.
export function isTierUnlocked(vehicleId, kind, tier) {
  if (tier <= 1) return true;
  const prev = MOD_TREE[kind][tier - 2];
  const have = tierCounts(vehicleId, kind)[tier - 2];
  return have >= tierRequirement(prev.length);
}

export function tierGate(vehicleId, kind, tier) {
  if (tier <= 1) return { unlocked: true, have: 0, need: 0 };
  const prev = MOD_TREE[kind][tier - 2];
  const need = tierRequirement(prev.length);
  const have = tierCounts(vehicleId, kind)[tier - 2];
  return { unlocked: have >= need, have, need };
}

// Everything the garage needs to draw one module button.
export function modStatus(spec, kind, mod) {
  const owned = ownedMods(spec.id).includes(mod.id);
  const gate = tierGate(spec.id, kind, mod.tier);
  const cost = modCostFor(spec, mod);
  return {
    owned,
    tierUnlocked: gate.unlocked,
    gate,
    cost,
    affordable: progress.data.rp >= cost.rp && progress.data.silver >= cost.silver,
    buyable: !owned && gate.unlocked &&
      progress.data.rp >= cost.rp && progress.data.silver >= cost.silver,
  };
}

// Buy one module through the tree: checks the tier gate, then charges both
// currencies. Returns false and changes nothing if anything does not add up.
export function buyModule(spec, kind, modId) {
  const mod = modDef(kind, modId);
  if (!mod) return false;
  if (ownedMods(spec.id).includes(modId)) return false;
  if (!isTierUnlocked(spec.id, kind, mod.tier)) return false;
  return progress.buyMod(spec.id, modId, modCostFor(spec, mod));
}

// Crew multipliers folded into a spec. Kept separate from applyMods so a
// caller can apply crew on its own, or skip it entirely. `inPlace` is for the
// applyMods path, which is already holding a private clone.
export function applyCrew(spec, vehicleId = spec.id, inPlace = false) {
  const crew = progress.crewSkills(vehicleId);
  if (!crew.total) return spec;
  const s = inPlace ? spec : structuredClone(spec);
  s.maxSpeed = Math.round(s.maxSpeed * crew.mobility * 10) / 10;
  s.accel = Math.round(s.accel * crew.mobility * 10) / 10;
  // An aeroplane whose top speed goes up without its critical speed following
  // cruises inside its own compressibility band, so a trained crew would cost
  // the pilot control authority instead of buying it.
  if (s.structuralSpeed) {
    s.structuralSpeed = Math.round(s.structuralSpeed * crew.mobility);
  }
  if (s.turnRate) s.turnRate = Math.round(s.turnRate * crew.mobility * 100) / 100;
  if (s.traverse) s.traverse = Math.round(s.traverse * crew.traverse * 100) / 100;
  if (s.pitchSpeed) s.pitchSpeed = Math.round(s.pitchSpeed * crew.traverse * 100) / 100;
  if (s.reload) s.reload = Math.round(s.reload * crew.reload * 100) / 100;
  if (s.rollRate) s.rollRate = Math.round(s.rollRate * crew.traverse * 100) / 100;
  if (s.pitchRate) s.pitchRate = Math.round(s.pitchRate * crew.traverse * 100) / 100;
  if (s.hp) s.hp = Math.round(s.hp * crew.vitality);
  if (s.crew) s.crew = s.crew + crew.crewBonus;
  // fields the entity classes read directly rather than through a stat
  s.repairFactor = (s.repairFactor ?? 1) * crew.repair;
  s.spotFactor = (s.spotFactor ?? 1) * crew.vision;
  s.aimFactor = (s.aimFactor ?? 1) * crew.aim;
  s.crewSkills = crew;
  return s;
}

// Returns the spec with owned modifications applied (clone; base untouched).
// For planes this also applies the selected weapon loadout: bombs/rockets
// are researchable modules, and only the chosen loadout is carried.
//
// `opts.crew` folds the trained crew in as well. It defaults to off so the
// call the battle files make today behaves exactly as it always has.
export function applyMods(baseSpec, kind, opts = {}) {
  const owned = ownedMods(baseSpec.id);
  if (kind === 'air') {
    const s = structuredClone(baseSpec);
    const loadout = progress.getLoadout(baseSpec.id);
    s.bombs = loadout === 'bombs' && owned.includes('bombs') ? baseSpec.bombs : null;
    s.rockets = loadout === 'rockets' && owned.includes('rockets') ? baseSpec.rockets : null;
    if (owned.includes('belts')) {
      s.gun.dmg = Math.round(s.gun.dmg * 1.15 * 10) / 10;
    }
    // Every module that raises the top speed has to raise the critical speed
    // with it. compressibility() stiffens the controls from 0.75 × Vne and the
    // wave-drag term bites past Mach 0.82 of it, so a fully modded fighter that
    // kept its stock Vne would fly its own cruise with a third of its pitch,
    // roll and yaw gone — the mods would be making the aeroplane worse.
    let speedMult = 1;
    if (owned.includes('engine')) {
      s.maxSpeed = Math.round(s.maxSpeed * 1.1 * 10) / 10;
      s.accel = Math.round(s.accel * 1.1 * 10) / 10;
      speedMult *= 1.1;
    }
    if (owned.includes('airframe')) {
      s.hp = Math.round(s.hp * 1.2);
    }
    if (owned.includes('ammo')) {
      s.gun.ammo = Math.round(s.gun.ammo * 1.35);
    }
    // --- tree additions ---
    if (owned.includes('rad')) {
      s.maxSpeed = Math.round(s.maxSpeed * 1.03 * 10) / 10;
      speedMult *= 1.03;
    }
    if (owned.includes('comp')) {
      s.maxSpeed = Math.round(s.maxSpeed * 1.04 * 10) / 10;
      speedMult *= 1.04;
    }
    if (owned.includes('flaps')) {
      s.pitchRate = Math.round(s.pitchRate * 1.12 * 100) / 100;
      s.rollRate = Math.round(s.rollRate * 1.08 * 100) / 100;
      s.combatFlaps = true;
    }
    if (owned.includes('boost')) s.accel = Math.round(s.accel * 1.12 * 10) / 10;
    if (owned.includes('armour')) {
      s.hp = Math.round(s.hp * 1.1);
      // "pilot protected" has to mean the seat back is there: buildPlaneParts
      // hands spec.parts straight to the component model, so doubling the
      // pilot box is the only place that promise can actually live.
      if (s.parts && s.parts.pilot) {
        s.parts = { ...s.parts, pilot: Math.round(s.parts.pilot * 2) };
      }
      s.pilotArmour = true;
    }
    if (owned.includes('injection')) {
      s.maxSpeed = Math.round(s.maxSpeed * 1.05 * 10) / 10;
      s.accel = Math.round(s.accel * 1.05 * 10) / 10;
      speedMult *= 1.05;
    }
    if (owned.includes('sight')) {
      s.gun.spread = Math.round(s.gun.spread * 0.85 * 10000) / 10000;
      s.gyroSight = true;
    }
    if (speedMult !== 1 && s.structuralSpeed) {
      s.structuralSpeed = Math.round(s.structuralSpeed * speedMult);
    }
    return opts.crew ? applyCrew(s, baseSpec.id, true) : s;
  }
  const s = structuredClone(baseSpec);
  if (kind === 'ground') {
    // special shell is locked behind its module; ammo counts come from
    // the garage loadout picker
    const special = specialShellKey(s);
    if (special && !owned.includes('shell3')) delete s.shells[special];
    if (s.ammoCap) {
      const dist = ammoDistribution(baseSpec, owned);
      for (const k of Object.keys(s.shells)) {
        if (dist[k] != null) s.shells[k].count = dist[k];
      }
    }
    if (owned.includes('shells')) {
      for (const k of Object.keys(s.shells)) {
        s.shells[k].pen = Math.round(s.shells[k].pen * 1.12);
      }
      if (s.aa) s.aa.dmg = Math.round(s.aa.dmg * 1.15 * 10) / 10;
    }
    if (owned.includes('engine')) {
      s.maxSpeed = Math.round(s.maxSpeed * 1.12 * 10) / 10;
      s.accel = Math.round(s.accel * 1.12 * 10) / 10;
    }
    if (owned.includes('loader')) {
      s.reload = Math.round(s.reload * 0.85 * 10) / 10;
      if (s.aa) s.aa.rof = Math.round(s.aa.rof * 1.15);
    }
    if (owned.includes('turret')) {
      s.traverse = Math.round(s.traverse * 1.2 * 100) / 100;
      s.pitchSpeed = Math.round((s.pitchSpeed || 1.4) * 1.2 * 100) / 100;
    }
    if (owned.includes('repair')) {
      s.repairFactor = 0.65;
    }
    // --- tree additions ---
    if (owned.includes('tracks')) {
      s.turnRate = Math.round(s.turnRate * 1.1 * 100) / 100;
      s.accel = Math.round(s.accel * 1.05 * 10) / 10;
    }
    if (owned.includes('brakes')) {
      // the drivetrain brakes at spec.accel × 1.6, so the accel bump is the
      // stopping half; reverse is the half you feel backing out of a trade
      s.accel = Math.round(s.accel * 1.08 * 10) / 10;
      s.maxReverse = Math.round((s.maxReverse ?? s.maxSpeed * 0.32) * 1.2 * 10) / 10;
      s.brakeFactor = 1.3;
    }
    if (owned.includes('fpe')) {
      // an extinguisher the crew never gets to pull is not an extinguisher:
      // the charge count is what tankEntity.useExtinguisher actually spends
      s.consumables = { ...(s.consumables || {}) };
      s.consumables.fpe = (s.consumables.fpe ?? 1) + 1;
      s.fireExtinguisher = true;
      s.burnFactor = 0.4;
    }
    if (owned.includes('adjustment')) {
      // updateDispersion reads spec.dispersion as its base term, so the -15%
      // has to land there rather than on a factor nothing multiplies by
      s.dispersion = Math.round((s.dispersion ?? BASE_DISPERSION) * 0.85 * 1e6) / 1e6;
      s.spreadFactor = (s.spreadFactor ?? 1) * 0.85;
    }
    if (owned.includes('filters')) {
      s.maxSpeed = Math.round(s.maxSpeed * 1.04 * 10) / 10;
      s.accel = Math.round(s.accel * 1.04 * 10) / 10;
      s.engineWearFactor = 0.8;
    }
    if (owned.includes('crewrepl')) {
      // crews patch themselves back to 70% on their own; the kits are what put
      // a knocked-out man back in his seat, and those are counted per battle
      s.consumables = { ...(s.consumables || {}) };
      s.consumables.firstAid = (s.consumables.firstAid ?? 1) + 2;
      s.crewReplenish = true;
    }
    if (owned.includes('transmission')) {
      s.accel = Math.round(s.accel * 1.08 * 10) / 10;
      s.turnRate = Math.round(s.turnRate * 1.06 * 100) / 100;
    }
    if (owned.includes('hdrive')) {
      s.traverse = Math.round(s.traverse * 1.15 * 100) / 100;
    }
    if (owned.includes('arty')) {
      // The fire-mission call itself is granted unconditionally by the battle
      // files, so the flag is only half of this module: the observer's optics
      // and the radio net behind them are what it can deliver on its own.
      s.spotFactor = (s.spotFactor ?? 1) * 1.15;
      s.artillerySupport = true;
    }
  }
  return opts.crew ? applyCrew(s, baseSpec.id, true) : s;
}

// Re-exported so a screen can list the skills without importing progress too.
export { CREW_SKILLS };
