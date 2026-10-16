// One blast law for the picture, the sound and the shake (backlog AV-01).
//
// Every explosion in the game is described by ONE number, the mass of its
// charge in kilograms of TNT, and everything the player sees, hears and feels
// of it is derived from that number here — nowhere else. Gameplay damage does
// not come from this file and must never start to: this is presentation only.
//
// THE LAW: Hopkinson-Cranz cube-root scaling. Two charges W1 and W2 make
// geometrically similar blasts: every length AND every time of the larger is
// L = (W2/W1)^(1/3) times the smaller's, its velocities are the same, and its
// overpressure at distance d equals the smaller one's at d / L. So:
//
//   L = (W / REF_KG)^(1/3)            size and duration scale
//   Z = d / W^(1/3)   [m / kg^(1/3)]  scaled distance: overpressure, shake
//
// Calibrated on 75 mm HE (about 0.68 kg of filler), whose soil column the art
// bible puts at 8-15 m half a second in (bible 6.5; backlog X-02 / AV-01, which
// narrows the calibration to 8-10 m). With REF_COLUMN_M = 9 at L = 1:
//
//   105 mm  ~2.2 kg   x1.48  13.3 m
//   88 mm   ~0.9 kg   x1.10   9.9 m
//   37 mm   ~0.03 kg  x0.35   3.2 m   (the backlog's table says x0.28, which
//                                      is the law for 15 g, not for its own
//                                      30 g — see the lane report)
//   SC 250  ~130 kg   x5.76  51.8 m   (bible's independent 30-60 m bomb column)
//
// Filler masses are DATA marked "verify": nominal figures from period tables,
// rounded, to be checked against a primary source before anyone quotes them.

export const SPEED_OF_SOUND = 343; // m/s — the same clock core/audio.js uses
export const REF_KG = 0.68;        // 75 mm HE filler, the calibration charge
export const REF_COLUMN_M = 9;     // its soil column at 0.5 s

// HE filler by calibre, kg TNT-equivalent. verify: every row.
//   20 mm MG 151/20 mine shell ~18 g (HE+incendiary), 37 mm M63 ~30 g,
//   50 mm ~0.2 kg, 75 mm M48 / Sprgr 34 ~0.68 kg, 76 mm M42 ~0.39 kg (M42A1)
//   — but OF-350 ~0.62, the roster's 76 is Soviet-pattern, 85 mm O-365K
//   ~0.74, 88 mm Sprgr L/4.5 ~0.9, 90 mm M71 ~0.93, 100 mm OF-412 ~1.46,
//   105 mm M1 ~2.18, 122 mm OF-471 ~3.6, 152 mm OF-540 ~5.9.
const FILLER_TABLE = [
  [20, 0.018], [37, 0.03], [50, 0.2], [57, 0.25], [75, 0.68], [76, 0.62],
  [85, 0.74], [88, 0.9], [90, 0.93], [100, 1.46], [105, 2.2], [122, 3.6],
  [152, 5.9],
];

/** HE filler (kg TNT) of a shell of this calibre in mm. Interpolated as cal^3. */
export function heFillerKg(caliberMm) {
  const c = Number.isFinite(caliberMm) && caliberMm > 0 ? caliberMm : 75;
  const T = FILLER_TABLE;
  if (c <= T[0][0]) return T[0][1] * (c / T[0][0]) ** 3;
  for (let i = 1; i < T.length; i++) {
    if (c <= T[i][0]) {
      const [c0, w0] = T[i - 1];
      const [c1, w1] = T[i];
      // log-log between the two rows: filler goes roughly as the cube
      const t = Math.log(c / c0) / Math.log(c1 / c0);
      return Math.exp(Math.log(w0) + (Math.log(w1) - Math.log(w0)) * t);
    }
  }
  const [cl, wl] = T[T.length - 1];
  return wl * (c / cl) ** 3;
}

// Aircraft stores. bombs.js derives its scale as radius / 26 with 1 == a
// 250 kg-class bomb (SC 250: ~130 kg of filler). verify.
export function bombFillerKg(radius) {
  const s = (radius > 0 ? radius : 26) / 26;
  return 130 * s * s * s;
}
// Rocket heads: an HVAR's 3.4 kg, an RS-82's 0.36 kg, an RP-3's 60 lb head
// ~5.4 kg; the roster's 8-10 m radii sit around 2-4 kg. verify.
export function rocketFillerKg(radius) {
  const s = (radius > 0 ? radius : 9) / 9;
  return 3 * s * s * s;
}

// Things that blow up but are not a shell. TNT-equivalent of the event as the
// eye and ear read it, not of the stored energy. verify (estimates).
export const BLAST_KG = Object.freeze({
  vehicle: 3,        // a hulk brewing up: fuel, a few rounds, no rack
  vehicleAmmo: 15,   // ammunition rack detonation, turret off
  aircraft: 6,       // an aeroplane coming apart: fuel and the odd store
  groundTarget: 2,   // a lorry, a gun, a fuel bowser
  base: 25,          // a depot / ammunition dump going up
  artillery: 2.2,    // a 105 mm battery round
});

/** Hopkinson length/time scale of a charge against the 75 mm reference. */
export function blastScale(kg) {
  return Math.cbrt(Math.max(1e-5, kg) / REF_KG);
}

/** Scaled distance Z = d / W^(1/3), in m/kg^(1/3). */
export function scaledDistance(kg, d) {
  return Math.max(0, d) / Math.cbrt(Math.max(1e-5, kg));
}

// Peak side-on overpressure of a free-air TNT burst, bar (Sadovsky). Valid
// for Z of roughly 1-15 and a fair guide beyond; below Z = 0.6 it is clamped,
// the fireball itself.
export function overpressureBar(Z) {
  const z = Math.max(0.6, Z);
  return 0.84 / z + 2.7 / (z * z) + 7 / (z * z * z);
}

// The same distance weighting core/audio.js applies to every report: inside
// ~150 m a blast is a transient, past ~400 m a slow roll with a tail.
function farWeight(d) {
  const t = Math.min(1, Math.max(0, (d - 150) / 250));
  return t * t * (3 - 2 * t);
}

// Camera trauma from overpressure: 2.27 * dP^0.7 puts a 75 mm burst at 10 m
// at 0.45 (what the battles used to hand-tune for "HE close by"), an SC 250
// at 300 m at about 0.12. Under 0.02 (half a centimetre of camera) it is
// dropped: a 75 mm burst stops shaking anyone past ~640 m, a 250 kg bomb
// past ~3.7 km.
const SHAKE_K = 2.27;
const SHAKE_P = 0.7;
const SHAKE_MAX = 1.2;
const SHAKE_FLOOR = 0.02;

/**
 * Everything a detonation of `kg` kilograms of TNT looks, sounds and feels
 * like, seen from `distance` metres. Pure; pass `out` to reuse a record.
 *
 * Lengths are metres, times seconds, speeds m/s. Particle motion constants
 * follow the effects pool's law: v <- v (1 - drag dt) - gravity dt, gravity
 * positive DOWN. They obey the Hopkinson similarity exactly (velocities fixed,
 * accelerations / L), so a bigger charge is the same movie run bigger and
 * slower — except where a pool lifetime has to cap it (settling, below).
 */
export function blastOf(kg, distance = 0, out = null) {
  const W = Math.max(1e-5, Number.isFinite(kg) ? kg : REF_KG);
  const L = Math.cbrt(W / REF_KG);
  const d = Math.max(0, Number.isFinite(distance) ? distance : 0);
  const Z = d / Math.cbrt(W);
  const o = out || {
    flash: {}, core: {}, column: {}, soot: {}, debris: {}, ring: {},
    fireball: {}, smoke: {}, marker: {}, sound: {}, shake: {},
  };
  o.kg = W;
  o.L = L;
  o.distance = d;
  o.Z = Z;
  o.arrival = d / SPEED_OF_SOUND;
  o.overpressure = overpressureBar(Z);

  // Light: one point light, gone in the fireball's own time. 45 ms at 75 mm
  // is inside the bible's "flash <= 50 ms": lit on three 60 Hz frames, dark on
  // the fourth. Never under one frame, never past a big bomb's fireball.
  const f = o.flash;
  f.intensity = 300 * L ** 0.8;
  f.radius = Math.min(140, 30 * L ** 0.7);
  f.life = Math.min(0.35, Math.max(0.99 / 60, 0.045 * L));

  // The white core blob at the seat of the burst, same life as the light.
  const c = o.core;
  c.diameter = 1.7 * L;
  c.life = f.life;

  // Soil column. Launched at up to a fixed speed with drag 3/L and settling
  // gravity 2.4/L: at t = 0.5 L the body of it (the 90th percentile of its
  // puffs) stands REF_COLUMN_M * L high and its top ~10 % above that; it
  // peaks ~30 % higher at 1.3 L s and then settles at 0.8 m/s downwind.
  // Its life is the settling, and settling is NOT self-similar (the dust
  // falls at its own terminal speed whatever threw it), so lives grow as
  // L^0.5 and are capped by what the pools can hold.
  const col = o.column;
  col.height = REF_COLUMN_M * L;
  col.width = 8 * L;
  col.v0 = 39;
  col.drag = 3 / L;
  col.gravity = 2.4 / L;
  col.lifeMin = Math.min(24, 6 * Math.sqrt(L));
  col.lifeMax = Math.min(32, 14 * Math.sqrt(L));
  col.launchR = 2 * L;
  col.out = 3;
  // billboard width, m, of one puff of it
  col.puff = 3.2 * L;
  // enough puffs that the column is a body, not a scatter (it is opaque
  // soil at half a second) — and no more for a big one, whose puffs are
  // bigger instead: a busy air battle's bombs must not flood the pools
  col.count = Math.round(Math.min(60, 40 + 16 * L));
  // share of the column that is TNT soot rather than soil (bible: 20-30 %)
  col.sootShare = 0.25;

  // The soot core: the black of an oxygen-poor TNT detonation, rising a little
  // inside the soil column (it is hot) and leaving with the wind.
  const s = o.soot;
  s.v0 = 24;
  s.drag = 2.6 / L;
  s.gravity = 0.9 / L;
  s.lifeMin = col.lifeMin * 0.8;
  s.lifeMax = col.lifeMax * 0.85;
  s.launchR = 0.8 * L;
  s.puff = 2.4 * L;   // billboard width, m

  // Clods. Range ~ v^2 / g: a 75 mm throws them 10-15 m, a 250 kg bomb 50-100.
  const db = o.debris;
  db.speed = 14 * Math.sqrt(L);
  // long enough to come back down (a 45 deg lob: 2 v sin45 / g)
  db.life = Math.min(6, 0.15 * db.speed);
  db.count = Math.round(Math.min(40, 4 + 5 * L));

  // The dust ring rolling out over the ground, and the hole.
  const r = o.ring;
  r.r0 = 0.6 * L;
  r.r1 = 8 * L;
  r.life = 0.35 * Math.sqrt(L);
  // Crater: surface-burst craters grow slower than the cube root (bible:
  // 75 mm 1-1.5 m, SC 250 instant fuze ~4.4 m): diameter ~ W^0.24.
  o.crater = 1.25 * (W / REF_KG) ** 0.24;

  // Fuel / ammunition fireball, for explosions that are NOT ground HE (a
  // brewing hulk, an aeroplane, a store going off in the air). Hopkinson time.
  const fb = o.fireball;
  fb.diameter = 3.8 * L;
  fb.lifeMin = 0.16 * L;
  fb.lifeMax = 0.38 * L;
  fb.rise = 6 * Math.sqrt(L);
  fb.count = Math.round(Math.min(22, 5 + 4 * L));
  // a fuel fireball lights its surroundings for as long as it burns
  fb.lightLife = Math.min(0.9, 0.3 * L);

  // Black blast smoke off a fireball.
  const sm = o.smoke;
  sm.speed = 5 * Math.sqrt(L);
  sm.lifeMin = 2.4 * Math.sqrt(L);
  sm.lifeMax = 5 * Math.sqrt(L);
  sm.puff = 1.2 * L;
  sm.count = Math.round(Math.min(18, 6 + 3 * L));

  // The standing marker plume a big detonation leaves over the map.
  const mk = o.marker;
  mk.life = Math.min(30, 6.5 * Math.sqrt(L));
  mk.power = Math.min(3, 0.9 * L ** 0.6);

  // Sound: the voice size core/audio.js picks and pitches its takes by (1 a
  // 75 mm burst, 2+ the bomb takes, 3 a 250 kg bomb) and the length of it,
  // stretched by distance as the transient rolls into a tail.
  const snd = o.sound;
  snd.size = Math.min(3, Math.max(0.3, L ** 0.627));
  snd.dur = (0.9 + 0.5 * snd.size) * (1 + 0.5 * farWeight(d));

  // Shake: amplitude from the overpressure at the scaled distance; it arrives
  // with the sound (AV-02), lasts longer for a bigger charge and further off,
  // and drops in frequency with both.
  const sh = o.shake;
  const a = SHAKE_K * o.overpressure ** SHAKE_P;
  sh.amp = a < SHAKE_FLOOR ? 0 : Math.min(SHAKE_MAX, a);
  const zf = Math.min(1, Z / 80);
  sh.dur = (0.32 + 0.13 * L) * (1 + 0.6 * zf);
  sh.freq = (1 - 0.45 * Math.min(1, Z / 120)) / L ** 0.15;
  sh.delay = o.arrival;
  return o;
}

/** Distance at which a charge's shake falls to nothing (for broad-phase). */
export function shakeReach(kg) {
  // solve SHAKE_K * dP(Z)^P = FLOOR in the far field (dP ~ 0.84/Z)
  const dp = (SHAKE_FLOOR / SHAKE_K) ** (1 / SHAKE_P);
  return (0.84 / dp) * Math.cbrt(Math.max(1e-5, kg));
}
