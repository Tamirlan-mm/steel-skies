import { TANK_SPECS } from '../vehicles/tanks.js';
import { PLANE_SPECS } from '../vehicles/planes.js';

// Battle Rating: one number that says how much vehicle you brought.
//
// Nothing here is hand-authored. Every rating falls out of the same stat block
// the damage model reads, which means a rebalanced Tiger re-rates itself and
// any vehicle added later gets a rating for free. The weights below are the
// only editorial content: they say what actually wins battles in this game —
// for tanks, the gun first and the armour second; for aircraft, energy first
// and guns second.
//
// Ratings are computed from the STOCK spec on purpose. Modifications and crew
// are the player's own investment; matchmaking that punished you for spending
// on your vehicle would just teach you not to spend.

// The familiar ladder: thirds of a point, printed to one decimal, so the rungs
// read 1.0 / 1.3 / 1.7 / 2.0 rather than a flat 0.3 march that drifts.
export const BR_MIN = 1.0;
export const BR_MAX = 8.0;
export const BR_RUNGS = (() => {
  const out = [];
  for (let i = 0; i <= 21; i++) out.push(Math.round((BR_MIN + i / 3) * 10) / 10);
  return out;
})();

// Snap a continuous score onto the ladder.
export function snapBr(v) {
  const i = Math.round((v - BR_MIN) * 3);
  return BR_RUNGS[Math.max(0, Math.min(BR_RUNGS.length - 1, i))];
}

export function brLabel(br) {
  return br.toFixed(1);
}

// Ground and air are rated on separate curves but share the ladder, so a 3.7
// tank and a 3.7 fighter belong in the same combined-arms battle.
export function vehicleKind(spec) {
  if (!spec) return 'ground';
  if (spec.isAir || spec.span != null || spec.rollRate != null) return 'air';
  return 'ground';
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Best penetration the vehicle can put on a plate, ignoring the HE filler
// round nobody uses for that. Autocannon SPAA have dummy main-gun entries, so
// their sustained damage is converted into a pen-equivalent instead.
function bestPen(spec) {
  let pen = 0;
  if (spec.shells) {
    for (const k of Object.keys(spec.shells)) {
      const sh = spec.shells[k];
      if (sh.kind === 'HE') continue;
      if (sh.pen > pen) pen = sh.pen;
    }
  }
  if (spec.aa) {
    // a Flakvierling will never punch a Tiger, but it deletes anything soft,
    // and the rating has to price that somewhere
    const dps = spec.aa.dmg * spec.aa.rof;
    pen = Math.max(pen, 34 + dps * 0.85);
  }
  return pen || 30;
}

function tankScore(spec) {
  const pen = bestPen(spec);
  const rpm = clamp(60 / Math.max(0.5, spec.reload || 6), 3, 26);
  // penetration is worth slightly more than linear: the step from 120 to 165mm
  // is the step from "bounce off the front" to "do not care about the front"
  const firepower = Math.pow(pen / 100, 1.22) * (0.68 + 0.32 * clamp(rpm / 11, 0.35, 1.7));

  const ar = spec.armor || { hull: {}, turret: {} };
  const hull = ar.hull || {};
  const tur = ar.turret || {};
  // what the enemy actually shoots at: the glacis and the mantlet, with the
  // sides as a small survivability term for the flanking that always happens
  const frontal = (hull.front || 20) * 0.5 + (tur.front || hull.front || 20) * 0.38 +
    ((hull.side || 15) + (tur.side || 15)) * 0.06;
  const armour = Math.pow(frontal / 90, 1.1);

  const mobility =
    clamp(spec.maxSpeed / 14, 0.2, 2) * 0.5 +
    clamp(spec.accel / 6, 0.2, 2) * 0.3 +
    clamp(spec.turnRate / 1.5, 0.2, 2) * 0.2;

  // a gun you cannot bring to bear is a gun you do not have
  const handling = clamp((spec.traverse || 1.5) / 2.0, 0.25, 1.8) *
    (spec.casemate ? 0.55 : 1);

  const crew = clamp((spec.crew || 4) / 4.5, 0.6, 1.3);

  return (
    firepower * 0.46 +
    armour * 0.28 +
    mobility * 0.15 +
    handling * 0.07 +
    crew * 0.04
  );
}

function planeScore(spec) {
  const gun = spec.gun || { dmg: 2, rof: 10, ammo: 400 };
  const dps = gun.dmg * gun.rof;
  const firepower = Math.pow(dps / 50, 1.1) * (0.9 + 0.1 * clamp(gun.ammo / 500, 0.4, 1.6));

  // top speed and acceleration together are "energy", which decides who gets
  // to choose whether a fight happens at all
  const speed = Math.pow(clamp(spec.maxSpeed / 70, 0.4, 1.8), 1.35);
  const climb = clamp(spec.accel / 9, 0.3, 1.8);

  const agility =
    clamp(spec.pitchRate / 1.5, 0.3, 1.8) * 0.55 +
    clamp(spec.rollRate / 3, 0.3, 1.8) * 0.3 +
    clamp((spec.yawRate || 0.6) / 0.75, 0.3, 1.8) * 0.15;

  // an armoured attacker soaks hits a fighter cannot, and in combined arms its
  // bombs are the whole point of it being there
  const toughness = clamp(spec.hp / 45, 0.4, 2.2);
  const strike = spec.bombs ? clamp((spec.bombs.count * spec.bombs.radius) / 40, 0, 0.6) : 0;

  return (
    firepower * 0.30 +
    speed * 0.24 +
    climb * 0.10 +
    agility * 0.15 +
    toughness * 0.15 +
    strike * 0.06
  );
}

// Both curves are mapped through the same affine transform so the two families
// land on one ladder. The constants were fitted so that the free starter sits
// near the bottom rung and the top-tier machines land around 6.
const GROUND_A = 4.775;
const GROUND_B = 0.792;
const AIR_A = 8.61;
const AIR_B = 0.8328;

const brCache = new Map();

// Rating for one vehicle spec. Cached by id — the specs are module constants
// and applyMods clones keep their id, which is exactly what we want: a modded
// Tiger is still a Tiger for matchmaking purposes.
export function brOf(spec) {
  if (!spec) return BR_MIN;
  const id = spec.id;
  if (id && brCache.has(id)) return brCache.get(id);
  const kind = vehicleKind(spec);
  const raw = kind === 'air' ? planeScore(spec) : tankScore(spec);
  const a = kind === 'air' ? AIR_A : GROUND_A;
  const b = kind === 'air' ? AIR_B : GROUND_B;
  const br = snapBr(clamp(BR_MIN + (raw - b) * a, BR_MIN, BR_MAX));
  if (id) brCache.set(id, br);
  return br;
}

// The band a battle rated `br` will pull from. Down one full step and up one
// full step, which is the spread the lineup picker actually uses.
export function brBracket(br) {
  const min = snapBr(Math.max(BR_MIN, br - 1.0));
  const max = snapBr(Math.min(BR_MAX, br + 1.0));
  return { br, min, max, label: `${brLabel(min)} – ${brLabel(max)}` };
}

// Small deterministic generator so a battle can be replayed exactly (mulberry32).
export function makeRng(seed) {
  let t = (seed >>> 0) || 1;
  return function rng() {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function poolSpecs(pool, kind) {
  const src = pool || (kind === 'air' ? PLANE_SPECS : TANK_SPECS);
  const list = Array.isArray(src) ? src : Object.values(src);
  const out = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      const spec = TANK_SPECS[entry] || PLANE_SPECS[entry];
      if (spec) out.push(spec);
    } else if (entry && entry.id) {
      out.push(entry);
    }
  }
  return out;
}

// How wide a net the matchmaker casts, and how often it throws you a battle
// above your weight. Realistic keeps the brackets tighter; arcade is looser
// because arcade is where the mixed-bag battles are supposed to happen.
function tuning(difficulty) {
  return difficulty === 'realistic'
    ? { spread: 0.6, uptierChance: 0.33, uptierMax: 0.7 }
    : { spread: 0.8, uptierChance: 0.28, uptierMax: 0.7 };
}

// Pick a BR-matched lineup of vehicle ids.
//
//   pickLineup({ playerSpec: TANK_SPECS.tiger, count: 4 })
//     -> ['tiger', 't34', 'su100', 't34']
//
// Everything is optional except the player's spec: the pool defaults to every
// vehicle of the same kind, and passing an `rng` makes the result reproducible.
// Duplicates are allowed (a battle of four T-34s is a real battle) but each
// repeat is progressively less likely, so lineups still look varied.
export function pickLineup({
  playerSpec,
  pool,
  count = 4,
  difficulty = 'arcade',
  rng = Math.random,
  kind,
  battleBr,
  uptier,
  spread,
  exclude,
} = {}) {
  const k = kind || vehicleKind(playerSpec);
  const specs = poolSpecs(pool, k).filter((s) => vehicleKind(s) === k);
  if (!specs.length || count <= 0) return [];

  const t = tuning(difficulty);
  const base = playerSpec ? brOf(playerSpec) : BR_MIN + 1;
  let target = battleBr;
  if (target == null) {
    const up = uptier == null ? rng() < t.uptierChance : uptier;
    target = up
      ? base + 0.3 + rng() * (t.uptierMax - 0.3)
      : base + (rng() - 0.5) * 0.4;
  }
  const sp = spread || t.spread;

  const skip = new Set(Array.isArray(exclude) ? exclude : exclude ? [exclude] : []);
  const picked = [];
  const used = new Map();
  for (let i = 0; i < count; i++) {
    let total = 0;
    const weights = [];
    for (const s of specs) {
      const d = Math.abs(brOf(s) - target);
      // gaussian around the battle BR, with a long thin tail so a lopsided
      // roster is possible but never the norm
      let w = Math.exp(-(d * d) / (2 * sp * sp));
      if (d > sp * 1.6) w *= 0.06;
      if (skip.has(s.id)) w *= 0.15;
      const seen = used.get(s.id) || 0;
      w *= Math.pow(0.45, seen);
      w = Math.max(w, 1e-6);
      weights.push(w);
      total += w;
    }
    let r = rng() * total;
    let choice = specs[specs.length - 1];
    for (let j = 0; j < specs.length; j++) {
      r -= weights[j];
      if (r <= 0) {
        choice = specs[j];
        break;
      }
    }
    used.set(choice.id, (used.get(choice.id) || 0) + 1);
    picked.push(choice.id);
  }
  return picked;
}

// Full matchmaking pass for one battle: both teams drawn against the same
// battle BR, so allies are as plausible as enemies. The battle files can take
// the two arrays straight to their spawn loops.
export function matchmake({
  playerSpec,
  pool,
  allies = 3,
  enemies = 4,
  difficulty = 'arcade',
  rng = Math.random,
  kind,
} = {}) {
  const k = kind || vehicleKind(playerSpec);
  const t = tuning(difficulty);
  const base = playerSpec ? brOf(playerSpec) : BR_MIN + 1;
  const up = rng() < t.uptierChance;
  const battleBr = up
    ? base + 0.3 + rng() * (t.uptierMax - 0.3)
    : base + (rng() - 0.5) * 0.4;
  const opts = { playerSpec, pool, difficulty, rng, kind: k, battleBr };
  return {
    playerBr: base,
    battleBr: snapBr(battleBr),
    uptier: up,
    bracket: brBracket(snapBr(battleBr)),
    allies: pickLineup({ ...opts, count: allies }),
    enemies: pickLineup({ ...opts, count: enemies }),
  };
}
