import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  armourMaterial,
  trackMaterial,
  rubberMaterial,
  exhaustMaterial,
  gunCrownMaterial,
  contactShadowMaterial,
  contactShadowGeometry,
  mattMaterial,
  markingsMaterial, markSharedGeometry, markShared,
  inPaintBand, hexToLinear,
  PAINT_US_OD, PAINT_SU_4BO, PAINT_DE_DUNKELGELB, PAINT_DE_PRIMER,
  SCHEME_DE_THREE_TONE,
} from '../core/materials.js';
import { insigniaAtlas, INSIGNIA_PAINT, INSIGNIA_ROUGHNESS } from '../core/insignia.js';

// V-09 tank markings: tints over the white stencil glyphs, and the US air
// recognition panel's fluorescent cerise (Y ~0.15, matt).
const MARK_WHITE = INSIGNIA_PAINT.white;
const MARK_DE_RED = 0x6e2a22;     // Tiger turret numbers, dark red      Y ~0.04
const MARK_CERISE = 0xb8436e;     // US air recognition panel, 1944-45   Y ~0.15
const VISION_GLASS = 0x2e3133;    // armoured glass over a dark interior Y ~0.03

// A shell with a bursting charge is a shell with a cavity in it, and a cavity
// is armour the penetrator is not carrying. APHE therefore beats about a tenth
// less plate than the solid shot it was machined from — that loss is what makes
// the choice between the two interesting instead of automatic, and it is paid
// for by the burst among the crew and the far readier ammo-rack detonation.
// The loss lives in the TANK_SPECS pen figures themselves: one number per
// shell, rather than a table figure and a hidden factor that disagree.

// Real penetration is not one number: nominally identical rounds scatter by a
// few per cent, which is why a marginal shot is a gamble rather than a lookup.
export const PEN_SCATTER = 0.05;

// Effective penetration at a distance, by shell family:
// AP/APHE lose 25% over 1.5km, APCR loses 40%, HE and HEAT don't drop off.
// `roll` adds the per-shot scatter; leave it off for anything that has to be
// deterministic, like the HUD's penetration indicator.
export function shellPenAt(shell, dist, roll = false) {
  const kind = shell.kind || 'AP';
  const falloff = kind === 'HE' || kind === 'HEAT' ? 0 : kind === 'APCR' ? 0.4 : 0.25;
  const base = shell.pen;
  const scatter = roll ? 1 + (Math.random() * 2 - 1) * PEN_SCATTER : 1;
  return base * (1 - (Math.min(dist, 1500) / 1500) * falloff) * scatter;
}

// ---------------------------------------------------------------------------
// Ground under the tracks. Presets name their surface (the map preset keys are
// accepted directly), and everything falls back to firm going so a caller that
// never sets one drives exactly as it did before.
//   grip  — how much of the engine's effort reaches the ground, and how hard
//           the vehicle can be steered before the tracks simply slide
//   top   — ceiling on road speed: sand robs it, packed snow much less
//   steer — steering authority multiplier
//   roll  — rolling resistance, which is what makes deep going feel heavy
// ---------------------------------------------------------------------------
// These are the physics numbers — terrain.js's SURFACE_TABLE only classifies
// the ground and tints the dust, so when the two disagree this table wins.
export const SURFACES = {
  firm: { grip: 1, top: 1, steer: 1, roll: 1 },
  grass: { grip: 1, top: 1, steer: 1, roll: 1 },
  meadow: { grip: 1, top: 1, steer: 1, roll: 1 },
  // roads and village streets, churned bare by everything that drove down them
  // first: the going a tank spends most of its life on, and until this row
  // existed every one of them silently fell back to firm ground
  dirt: { grip: 0.92, top: 0.97, steer: 0.95, roll: 1.12 },
  sand: { grip: 0.82, top: 0.78, steer: 0.8, roll: 1.35 },
  desert: { grip: 0.82, top: 0.78, steer: 0.8, roll: 1.35 },
  snow: { grip: 0.55, top: 0.86, steer: 0.55, roll: 1.12 },
  winter: { grip: 0.55, top: 0.86, steer: 0.55, roll: 1.12 },
  mud: { grip: 0.6, top: 0.7, steer: 0.65, roll: 1.6 },
  rock: { grip: 1.05, top: 0.95, steer: 1.05, roll: 1.15 },
};

export function surfaceProps(name) {
  return SURFACES[name] || SURFACES.firm;
}

// Gearbox fallback for any spec that does not carry one: four forward speeds
// and a single reverse, which is the plainest WWII transmission there is.
const DEFAULT_GEARBOX = { forward: [0.2, 0.42, 0.68, 1], reverse: [1], shift: 0.4 };

// Per-gear entries are the fraction of the vehicle's top speed that gear will
// pull to. Tractive effort falls out of the same number — a low gear is a low
// number, and a low number is a lot of pull — so no second table is needed.
export function gearboxFor(spec) {
  const gb = spec.gearbox || DEFAULT_GEARBOX;
  return {
    forward: gb.forward && gb.forward.length ? gb.forward : DEFAULT_GEARBOX.forward,
    reverse: gb.reverse && gb.reverse.length ? gb.reverse : DEFAULT_GEARBOX.reverse,
    shift: gb.shift ?? DEFAULT_GEARBOX.shift,
  };
}

// Suspension rates. A light tank on volute bogies bounces quickly; sixty tonnes
// of Tiger on torsion bars wallows. Both fall out of the mass, so a spec that
// never declares a suspension still gets one that suits it.
export function suspensionFor(spec) {
  if (spec.suspension) return spec.suspension;
  const m = spec.mass || 30;
  return {
    stiff: Math.max(34, Math.min(64, 72 - m * 0.5)),
    damp: Math.max(7.5, Math.min(12.5, 13.4 - m * 0.06)),
    squat: Math.max(0.005, Math.min(0.016, 0.32 / m)),
  };
}

// Historical vehicles, six machines across three nations. Armour in mm, speeds
// in m/s, traverse/turn rates in rad/s, reload in seconds, shell pen in mm.
//
// `hull` and `turret` are the collision volumes the penetration model and the
// internal layout are built from — the visual mesh is fitted to them, never the
// other way round. `chassis` and `shape` only drive the mesh: `chassis` places
// the running gear (the track is then wrapped around it automatically) and
// `shape` selects the hull stations, turret plan and stowage.
export const TANK_SPECS = {
  stuart: {
    id: 'stuart', name: 'M3 Stuart', nation: 'USA',
    klass: 'Light Tank', tier: 1, price: null,
    maxSpeed: 18, accel: 9, turnRate: 1.9,
    traverse: 2.6, reload: 4.0, crew: 4,
    mass: 12.7, maxReverse: 6.0,
    // clutch-and-brake steering: nothing happens until the tracks are turning
    neutralSteer: false, climbMax: 0.62,
    // a Westinghouse gyrostabiliser in elevation only, and a short barrel with
    // a light shell, so the gun is never especially precise
    stabiliser: { vertical: 0.55 }, dispersion: 0.0016,
    gearbox: { forward: [0.13, 0.26, 0.45, 0.7, 1], reverse: [1], shift: 0.5 },
    consumables: { repair: 3, fpe: 1, firstAid: 1, smoke: 2 },
    // 4.53 x 2.24 x 2.51m over the cupola. `trackH` is the TOP OF THE TRACK
    // RUN, not the fender: trackH + h is the hull roof, which is 1.72m here,
    // so the superstructure side is only 0.77m of a vehicle that stands 2.51m.
    // Running gear plus fenders are 55% of the hull roof height, and that is
    // why the M3 is the one vehicle in the roster taller than it is wide.
    hull: { w: 2.24, h: 0.77, len: 4.53, trackH: 0.95, clear: 0.42, sideDeg: 0 },
    turret: { w: 1.45, h: 0.60, len: 1.52, offZ: 0.38 },
    // the 37mm M6 is L/56.6 but sits far enough back that the muzzle stops
    // SHORT of the nose — length over gun is the same as hull length
    gunLen: 1.30,
    armor: {
      hull: { front: 38, side: 25, rear: 25, top: 13 },
      turret: { front: 38, side: 32, rear: 32, top: 13 },
      // plate angles from the vertical. The Stuart's nose is a shallow riveted
      // step and its sides are flat, so the slope buys it almost nothing.
      hullSlope: { front: 17, side: 0, rear: 17 },
      turretSlope: { front: 10, side: 5, rear: 0 },
      mantlet: 51,
    },
    shells: {
      AP: { kind: 'AP', caliber: 37, pen: 60, speed: 792, count: 60 },
      HE: { kind: 'HE', caliber: 37, pen: 14, speed: 780, splash: 4, count: 30 },
      APCR: { kind: 'APCR', caliber: 37, pen: 88, speed: 1030, count: 10 },
    },
    ammoCap: 103,
    mg: { dmg: 1.5, rof: 13, speed: 850, spread: 0.015, ammo: 600 },
    chassis: {
      trackW: 0.295, thickness: 0.08, sag: 0.045,
      // the GROUND-CONTACTING trailing idler under a high front sprocket is
      // the Stuart's signature: it tilts the whole top run down toward the
      // tail and leaves a bare metre of track between the rear bogie and the
      // idler. (The raised idler belongs to the M2A4 the M3 replaced.)
      sprocket: { z: 1.86, y: 0.55, r: 0.30 },
      idler: { z: -1.88, y: 0.37, r: 0.29 },
      // two VVSS bogies grouped forward of centre — tight pairs, not an even
      // row: 0.52m inside a bogie, 0.74m between them
      road: { at: [1.12, 0.60, -0.14, -0.66], r: 0.26, y: 0.34 },
      rollers: { count: 3, r: 0.09, y: 0.73, from: 1.05, to: -1.25 },
      bogies: 'volute',
    },
    shape: {
      hull: 'boxy', turret: 'horseshoeSmall',
      // local +Z is forward, so +X is the vehicle's LEFT (see plateNormal and
      // tankEntity.forwardDir). The M3's low hexagonal drum sits left-rear.
      cupola: { r: 0.28, h: 0.19, x: 0.30, z: -0.34, sides: 6 },
      driverHoods: true, sponsonMg: true,
    },
    // M3, 1942-43: US Olive Drab, monotone (bible 4.2 / C-15)
    color: PAINT_US_OD,
    desc: 'Tall riveted scout on volute bogies. Thin armour, small gun — flank and hit sides.',
    // V-09 (bible V-40): the Allied white star on the sponsons and the turret
    // sides. Sizes and stations *verify against period photographs*. y is in
    // the frame's own height (hull: above the ground; turret: above the roof).
    markings: [
      { glyph: 'us_star_white', frame: 'turret', side: 'both', y: 0.30, z: -0.05, size: 0.40 },
      { glyph: 'us_star_white', frame: 'hull', side: 'both', y: 1.32, z: -0.55, size: 0.50 },
    ],
  },
  wirbelwind: {
    id: 'wirbelwind', name: 'Wirbelwind', nation: 'Germany',
    klass: 'SPAA', tier: 1, price: null,
    maxSpeed: 11, accel: 6, turnRate: 1.5,
    traverse: 3.2, reload: 1, crew: 5,
    pitchSpeed: 3.2,
    gunElev: { min: -0.17, max: 1.48 }, // 85 degrees up
    mass: 22, maxReverse: 4.0,
    neutralSteer: false, climbMax: 0.55, dispersion: 0.0021,
    gearbox: { forward: [0.12, 0.22, 0.36, 0.55, 0.78, 1], reverse: [1], shift: 0.45 },
    consumables: { repair: 2, fpe: 1, firstAid: 1, smoke: 0 },
    // 5.92 x 2.88 x 2.76m. The turret was designed to exactly 1050mm to meet
    // Guderian's height limit, which puts the Panzer IV roof at 1.71m — the
    // tub is 61% of the hull's height, and that ratio is the vehicle.
    hull: { w: 2.88, h: 0.72, len: 5.92, trackH: 0.99, clear: 0.40, sideDeg: 0 },
    turret: { w: 2.0, h: 1.05, len: 2.3, offZ: -0.15 },
    // 2cm FlaK 38 barrels are 1.30m; with the trunnion near the middle of the
    // tub only about 0.9m of that shows ahead of the front plate
    gunLen: 1.3,
    gunMount: { x: 0, y: 0.45, z: 0.30 },
    armor: {
      hull: { front: 50, side: 30, rear: 20, top: 12 },
      turret: { front: 16, side: 16, rear: 16, top: 0 }, // open-topped
      hullSlope: { front: 12, side: 0, rear: 10 },
      // the tub's walls flare outward, so every face of it is angled
      turretSlope: { front: 26, side: 26, rear: 26 },
    },
    // the main gun entries are dummies — the LMB weapon is the quad 20mm stream
    shells: {
      AP: { kind: 'AP', caliber: 20, pen: 42, speed: 900, count: 0 },
      HE: { kind: 'HE', caliber: 20, pen: 8, speed: 900, splash: 2, count: 0 },
    },
    aa: { dmg: 3.4, rof: 16, speed: 900, spread: 0.014, ammo: 1400 },
    chassis: {
      trackW: 0.4, thickness: 0.08, sag: 0.04,
      sprocket: { z: 2.52, y: 0.54, r: 0.34 },
      idler: { z: -2.58, y: 0.5, r: 0.31 },
      // eight wheels in FOUR leaf-sprung pairs: 0.49m inside a pair, 0.66m
      // between them, which is a rhythm rather than a row of discs
      road: {
        at: [1.95, 1.46, 0.80, 0.31, -0.35, -0.84, -1.50, -1.99],
        r: 0.235, y: 0.315,
      },
      rollers: { count: 4, r: 0.125, y: 0.76, from: 1.62, to: -1.72 },
      bogies: 'leaf',
    },
    shape: {
      hull: 'panzer4', turret: 'flakTub',
      quadGun: true, openTurret: true, sideSkirts: true, bowMg: true,
    },
    // late 1944: Dunkelgelb RAL 7028 under Olivgruen / Rotbraun spray bands
    color: PAINT_DE_DUNKELGELB,
    scheme: SCHEME_DE_THREE_TONE,
    desc: 'Panzer IV chassis under an open faceted tub: four 20mm cannons shred aircraft.',
    // late 1944: a small Balkenkreuz on the Schuerzen either side (*verify*)
    markings: [
      { glyph: 'de_balkenkreuz', frame: 'hull', side: 'both', y: 0.78, z: -0.55, size: 0.42 },
    ],
  },
  t34: {
    id: 't34', name: 'T-34-85', nation: 'USSR',
    klass: 'Medium Tank', tier: 2,
    price: { silver: 2500, rp: 900 },
    maxSpeed: 15, accel: 6.5, turnRate: 1.45,
    traverse: 1.9, reload: 6.5, crew: 5,
    mass: 32, maxReverse: 3.2,
    // a four-speed crash box with dry clutch steering: no pivot turns, and the
    // shift itself is famously slow and heavy
    neutralSteer: false, climbMax: 0.6, dispersion: 0.0013,
    gearbox: { forward: [0.16, 0.34, 0.58, 0.8, 1], reverse: [1], shift: 0.7 },
    consumables: { repair: 3, fpe: 1, firstAid: 1, smoke: 2 },
    // 6.10 x 3.00 x 2.72m over the cupola, 0.40m ground clearance. `sideDeg`
    // is the upper side plate's lay from vertical, and it is the whole front
    // aspect: 40 degrees over 0.59m of rise closes a 2.90m sponson line to a
    // deck only ~1.91m wide, so the turret casting visibly overhangs it.
    hull: { w: 3.0, h: 0.67, len: 6.1, trackH: 0.93, clear: 0.40, sideDeg: 40 },
    // the casting's PLAN is 1.10m ahead of the ring and 1.35m behind it (see
    // turretShell); `len` is the collision box around it, sized to cover the
    // bustle overhang rather than to match the plan's nominal 2.45m
    turret: { w: 2.30, h: 0.87, len: 2.62, offZ: 0.70 },
    // the ZiS-S-53 overhangs the nose by exactly 2.00m; measured from the
    // trunnion that is 3.46m of tube in front of the mount
    gunLen: 3.46,
    armor: {
      hull: { front: 45, side: 45, rear: 45, top: 20 },
      turret: { front: 90, side: 75, rear: 52, top: 20 },
      // the whole point of the vehicle: 45mm laid at sixty degrees is worth
      // twice its thickness head-on, while the sponson sides stand upright and
      // are worth exactly what they measure
      hullSlope: { front: 60, side: 0, rear: 47 },
      turretSlope: { front: 22, side: 18, rear: 12 },
      mantlet: 100, turretCheek: 90,
    },
    shells: {
      AP: { kind: 'AP', caliber: 85, pen: 120, speed: 792, count: 40 },
      HE: { kind: 'HE', caliber: 85, pen: 26, speed: 793, splash: 5, count: 20 },
      // BR-365 beat less plate than the solid BR-365K of the same gun: 108 to
      // its 120, and what it buys is the burst inside, not the hole through.
      // It does not leave the muzzle faster than the shot it is machined from
      // either — the cavity is mass the charge no longer has to push, but the
      // ballistic cap and the heavier body take that back and more.
      APHE: { kind: 'APHE', caliber: 85, pen: 108, speed: 785, count: 8 },
    },
    // room for the authored load plus the APHE rack the tier-4 module unlocks,
    // so buying 'Ammunition' does not hand the player an empty third rack
    ammoCap: 72,
    mg: { dmg: 1.5, rof: 13, speed: 850, spread: 0.015, ammo: 600 },
    chassis: {
      trackW: 0.5, thickness: 0.05, sag: 0.03,
      // Christie: five 0.830m wheels with real daylight between them, a
      // conspicuously SMALLER idler at the front, six-roller drive sprocket at
      // the rear, and NO return rollers — the top run lies on the wheel tops,
      // which is the most destroyable thing about a T-34's profile.
      sprocket: { z: -2.75, y: 0.60, r: 0.315, style: 'roller' },
      idler: { z: 2.70, y: 0.52, r: 0.25 },
      road: { count: 5, r: 0.415, y: 0.465, from: 1.92, to: -1.9 },
      rollers: { count: 0 },
    },
    shape: {
      hull: 't34', turret: 'hexCast', cast: true,
      cupola: { r: 0.33, h: 0.25, x: 0.50, z: -0.30 },
      loaderHatch: { r: 0.25, x: -0.52, z: 0.05 },
      roofDomes: true, bowMg: true, glacisHatch: true,
      fuelDrums: true, spareTrack: true,
    },
    // 1944-45: Soviet 4BO protective green, monotone — the SAME paint as the
    // SU-100 (C-11: told apart by shape, never by colour)
    color: PAINT_SU_4BO,
    desc: 'Sixty-degree glacis, sloped sponsons and a big cast turret with a rear overhang.',
    // 1945: a white tactical number on the turret sides and the white air
    // recognition cross on the turret roof (*verify* per unit). The cross sits
    // on the flat of the roof forward of the commander's cupola (left rear,
    // x 0.50 z -0.30, r 0.33, vision blocks to z ~0.06), its cross-bar ending
    // on the loader's hatch, so no arm runs up the cupola or down a chamfer.
    markings: [
      { number: '214', frame: 'turret', side: 'both', y: 0.46, z: -0.25, height: 0.30, color: MARK_WHITE },
      { glyph: 'solid', frame: 'turret', side: 'top', x: 0, z: 0.14, size: [1.00, 0.13], color: MARK_WHITE },
      { glyph: 'solid', frame: 'turret', side: 'top', x: 0, z: 0.14, size: [0.13, 0.96], color: MARK_WHITE },
    ],
  },
  tiger: {
    id: 'tiger', name: 'Tiger I', nation: 'Germany',
    klass: 'Heavy Tank', tier: 3,
    price: { silver: 6000, rp: 2500 },
    maxSpeed: 11, accel: 3.8, turnRate: 0.95,
    traverse: 1.1, reload: 9.0, crew: 5,
    mass: 57, maxReverse: 3.4,
    // eight forward speeds through a pre-selector, and a regenerative steering
    // gear good enough to spin the vehicle on the spot
    neutralSteer: true, climbMax: 0.5, dispersion: 0.0009,
    gearbox: {
      forward: [0.1, 0.17, 0.27, 0.4, 0.55, 0.7, 0.85, 1],
      reverse: [0.5, 1], shift: 0.35,
    },
    consumables: { repair: 3, fpe: 2, firstAid: 2, smoke: 3 },
    // 6.32 x 3.70 x 3.00m over the cupola, hull ROOF at 1.78m. The Tiger is a
    // wide low slab, not a tall box: the turret is only 2.10m across a 3.61m
    // superstructure, so a broad band of sponson roof shows either side of it.
    hull: { w: 3.7, h: 0.85, len: 6.32, trackH: 0.93, clear: 0.47, sideDeg: 0 },
    turret: { w: 2.10, h: 0.86, len: 2.52, offZ: 0.20 },
    // 8.8cm KwK 36: the muzzle sits 2.13m ahead of the nose, no further
    gunLen: 4.24,
    armor: {
      hull: { front: 102, side: 80, rear: 80, top: 26 },
      turret: { front: 120, side: 80, rear: 80, top: 26 },
      // thickness instead of geometry: near-vertical plates everywhere, which
      // is why the Tiger is beaten by a big enough gun and not by an angle
      hullSlope: { front: 9, side: 0, rear: 8 },
      turretSlope: { front: 5, side: 0, rear: 0 },
      mantlet: 150,
    },
    shells: {
      // PzGr 39 is itself a capped APHE round, and the filler costs it the same
      // tenth it costs everyone else: the 88 would beat about 172mm firing the
      // solid shot it is machined from, and 155 is what is left once the cavity
      // is cut. There is no solid round in the rack to compare it against, so
      // the figure it is priced from is written down here instead.
      AP: { kind: 'APHE', caliber: 88, pen: 155, speed: 773, count: 40 },
      HE: { kind: 'HE', caliber: 88, pen: 30, speed: 700, splash: 6, count: 16 },
      APCR: { kind: 'APCR', caliber: 88, pen: 217, speed: 930, count: 10 },
    },
    ammoCap: 92,
    mg: { dmg: 1.5, rof: 13, speed: 850, spread: 0.015, ammo: 700 },
    chassis: {
      trackW: 0.72, thickness: 0.09, sag: 0,
      // Schachtellaufwerk: eight arms at a 0.414m pitch carrying 0.80m wheels
      // in two transverse planes, so consecutive discs overlap by half a
      // diameter and the run has no daylight in it anywhere. `interleave` is
      // the x offset of each plane as a fraction of track width — without it
      // the wheels all sit in one plane and read as any eight-wheel chassis.
      sprocket: { z: 2.66, y: 0.55, r: 0.457 },
      idler: { z: -2.80, y: 0.44, r: 0.35 },
      road: { count: 8, r: 0.40, y: 0.49, from: 1.45, to: -1.45 },
      rollers: { count: 0 },
      interleave: [0.19, -0.09],
    },
    shape: {
      hull: 'slab', turret: 'horseshoe',
      cupolaLeft: true, cupola: { r: 0.27, h: 0.36, z: -0.72 },
      muzzleBrake: 'double', bowMg: true, glacisTrack: true,
      rearBins: true, boxFenders: true,
    },
    // spec year 1944: Dunkelgelb RAL 7028 three-tone. (A 1943 spec would use
    // PAINT_DE_DUNKELGELB_1943, Dunkelgelb nach Muster — bible C-11 1.2.)
    color: PAINT_DE_DUNKELGELB,
    scheme: SCHEME_DE_THREE_TONE,
    desc: 'Slab sides, interleaved wheels and a long 88 with a double-baffle brake.',
    // 1943-44: the three-digit turret number and the Balkenkreuz on the hull
    // sides (*verify* per unit)
    markings: [
      { number: '131', frame: 'turret', side: 'both', y: 0.50, z: 0.30, height: 0.38, color: MARK_DE_RED },
      { glyph: 'de_balkenkreuz', frame: 'hull', side: 'both', y: 1.40, z: -0.95, size: 0.46 },
    ],
  },
  su100: {
    id: 'su100', name: 'SU-100', nation: 'USSR',
    klass: 'Tank Destroyer', tier: 3,
    price: { silver: 5500, rp: 2200 },
    maxSpeed: 13.5, accel: 5.2, turnRate: 1.3,
    traverse: 1.6, reload: 8.0, crew: 4,
    turretYawLimit: 0.15, // casemate: the gun barely traverses, aim with the hull
    casemate: true,
    mass: 31.6, maxReverse: 3.4,
    neutralSteer: false, climbMax: 0.58, dispersion: 0.0011,
    gearbox: { forward: [0.16, 0.34, 0.58, 0.8, 1], reverse: [1], shift: 0.7 },
    consumables: { repair: 2, fpe: 1, firstAid: 1, smoke: 2 },
    // 2.245m tall against the T-34-85's 2.72m on the same chassis — a full
    // 17% lower, and LOW is the entire point of the vehicle. `hull` is the
    // T-34 tub and engine deck (roof 1.60m); the casemate is lofted into the
    // hull stations as ONE 50-degree sweep from the nose beam to the roof, so
    // `turret` here is only the collision volume that sits over it, 1.60-2.02.
    hull: { w: 3.0, h: 0.67, len: 6.1, trackH: 0.93, clear: 0.40, sideDeg: 40 },
    turret: { w: 2.16, h: 0.42, len: 2.86, offZ: 0.72 },
    // D-10S overhangs the nose by 3.35m from a mantlet sitting on the front
    // plate at z = +1.88, offset to the RIGHT of the centreline
    gunLen: 4.52,
    gunMount: { x: -0.26, y: 0.20, z: 1.16 },
    armor: {
      hull: { front: 45, side: 45, rear: 45, top: 20 },
      turret: { front: 75, side: 45, rear: 45, top: 20 },
      // T-34 running gear under a casemate raked even harder than the glacis
      hullSlope: { front: 55, side: 0, rear: 45 },
      turretSlope: { front: 50, side: 20, rear: 10 },
      mantlet: 110,
    },
    shells: {
      AP: { kind: 'AP', caliber: 100, pen: 185, speed: 895, count: 33 },
      HE: { kind: 'HE', caliber: 100, pen: 32, speed: 900, splash: 7, count: 12 },
      APHE: { kind: 'APHE', caliber: 100, pen: 166, speed: 887, count: 8 },
    },
    // the authored load is 33 AP + 12 HE; the old cap of 33 silently trimmed
    // every HE round off the vehicle before it left the hangar
    ammoCap: 56,
    mg: { dmg: 1.5, rof: 13, speed: 850, spread: 0.015, ammo: 600 },
    // running gear identical to the T-34-85 — the only real difference is the
    // thicker front springs, which nobody can see
    chassis: {
      trackW: 0.5, thickness: 0.05, sag: 0.03,
      sprocket: { z: -2.75, y: 0.60, r: 0.315, style: 'roller' },
      idler: { z: 2.70, y: 0.52, r: 0.25 },
      road: { count: 5, r: 0.415, y: 0.465, from: 1.92, to: -1.9 },
      rollers: { count: 0 },
    },
    shape: {
      hull: 't34low', turret: 'casemate',
      // `blister` is the x of the bulge that carries the cupola out past the
      // casemate wall — the asymmetric right shoulder every source singles out
      cupolaRight: true, cupola: { r: 0.33, h: 0.22, x: -0.72, z: 0.90, blister: -1.20 },
      ballMantlet: true, mantletR: 0.275, unditchLog: true, travelLock: true,
    },
    // 1944-45: 4BO, the T-34-85's paint (C-11)
    color: PAINT_SU_4BO,
    desc: 'T-34 chassis under a raked casemate. The offset cupola and long 100mm give it away.',
    // 1945: a white tactical number on the casemate sides (*verify*), painted
    // high on the plate: the unditching log rides along the right side at
    // about 1.1-1.4 m and would hide anything lower
    markings: [
      { number: '125', frame: 'hull', side: 'both', y: 1.62, z: 0.20, height: 0.26, color: MARK_WHITE },
    ],
  },
  pershing: {
    id: 'pershing', name: 'M26 Pershing', nation: 'USA',
    klass: 'Battle Tank', tier: 4,
    price: { silver: 12000, rp: 6000 },
    maxSpeed: 12, accel: 5.0, turnRate: 1.25,
    traverse: 2.0, reload: 7.5, crew: 5,
    mass: 41.9, maxReverse: 5.2,
    // a three-speed torque converter behind a controlled differential: it
    // pivots, it reverses nearly as fast as it advances, and it never stalls
    // between gears the way a crash box does
    neutralSteer: true, climbMax: 0.55,
    stabiliser: { vertical: 0.7 }, dispersion: 0.001,
    gearbox: { forward: [0.3, 0.62, 1], reverse: [1], shift: 0.25 },
    consumables: { repair: 4, fpe: 2, firstAid: 2, smoke: 3 },
    // 6.33 x 3.51 x 2.78m over the cupola, hull ROOF at 1.57m. Above the
    // tracks the hull side is only a 0.5m band, so almost everything you see
    // head-on is glacis and turret — that is what makes the M26 read as low
    // and sloped standing next to a Tiger, which is the point of the pair.
    hull: { w: 3.51, h: 0.55, len: 6.33, trackH: 1.02, clear: 0.44, sideDeg: 0 },
    turret: { w: 2.30, h: 0.90, len: 2.90, offZ: 0.15 },
    // 90mm M3: 2.32m of muzzle ahead of the nose, long but slim
    gunLen: 4.35,
    armor: {
      hull: { front: 102, side: 76, rear: 51, top: 22 },
      turret: { front: 114, side: 76, rear: 76, top: 25 },
      hullSlope: { front: 46, side: 0, rear: 10 },
      turretSlope: { front: 18, side: 12, rear: 8 },
      mantlet: 114,
    },
    shells: {
      AP: { kind: 'AP', caliber: 90, pen: 145, speed: 853, count: 35 },
      HE: { kind: 'HE', caliber: 90, pen: 28, speed: 820, splash: 6, count: 15 },
      HEAT: { kind: 'HEAT', caliber: 90, pen: 178, speed: 780, count: 10 },
    },
    ammoCap: 70,
    mg: { dmg: 1.5, rof: 13, speed: 850, spread: 0.015, ammo: 700 },
    // the exact opposite read to a Tiger: six wheels with daylight between
    // them, and five return rollers carrying the top run in a dead straight
    // line along the hull side. Sprocket and idler tops are set level with the
    // rollers so that line stays straight from end to end.
    chassis: {
      trackW: 0.58, thickness: 0.085, sag: 0.02,
      sprocket: { z: -2.72, y: 0.56, r: 0.36 },
      idler: { z: 2.78, y: 0.59, r: 0.33 },
      road: { count: 6, r: 0.33, y: 0.415, from: 1.66, to: -1.66 },
      rollers: { count: 5, r: 0.10, y: 0.82, from: 1.90, to: -1.85 },
    },
    shape: {
      hull: 'pershing', turret: 'castOval', cast: true,
      // US practice puts the commander on the RIGHT; wartime M26s carried the
      // 90mm M3 with no muzzle brake at all
      cupolaRight: true, cupola: { r: 0.28, h: 0.31, z: -0.80 },
      bowMg: true, bustleRack: true, sandShields: true, headlights: true,
    },
    // 1945: US Olive Drab, the Stuart's paint (C-11)
    color: PAINT_US_OD,
    desc: 'Rounded cast turret on torsion bars: heavy firepower at medium-tank pace.',
    // 1945: white stars on the turret and hull sides, and the fluorescent
    // cerise air recognition panel tied over the engine deck (bible V-40)
    markings: [
      { glyph: 'us_star_white', frame: 'turret', side: 'both', y: 0.42, z: -0.25, size: 0.50 },
      { glyph: 'us_star_white', frame: 'hull', side: 'both', y: 1.31, z: 0.55, size: 0.42 },
      { glyph: 'solid', frame: 'hull', side: 'top', x: 0, z: -2.62, size: [1.15, 0.60], color: MARK_CERISE },
    ],
  },
};

// ---------------------------------------------------------------------------
// armour geometry
// ---------------------------------------------------------------------------
const DEG = Math.PI / 180;

// Outward normal of the plate that was actually struck, in the local frame of
// the part that was struck. The collision volumes are axis-aligned slabs, so
// without this every plate would be treated as upright and a sixty-degree
// glacis would be worth its bare 45mm instead of the ninety the angle buys.
// `localDir` only matters for the sides, where it picks which of the two the
// round is travelling into.
export function plateNormal(zone, slopeDeg, localDir, out) {
  const s = (slopeDeg || 0) * DEG;
  const c = Math.cos(s);
  const y = Math.sin(s);
  if (zone === 'front') return out.set(0, y, c);
  if (zone === 'rear') return out.set(0, y, -c);
  if (zone === 'top') return out.set(0, 1, 0);
  if (zone === 'bottom') return out.set(0, -1, 0);
  return out.set(localDir && localDir.x > 0 ? -c : c, y, 0);
}

// Thickness and lay of one armour face. `armor.hull` / `armor.turret` stay the
// base thickness they always were; the optional slope tables and the mantlet
// entry refine them, and a spec carrying none of that behaves exactly as it
// did when every plate was a flat number.
// Writes the plate normal into `outNormal` and returns { thickness, slope, face }.
export function armourFace(spec, isTurret, zone, localPoint, localDir, outNormal) {
  const key = zone === 'bottom' ? 'top' : zone;
  const set = isTurret ? spec.armor.turret : spec.armor.hull;
  const slopes = (isTurret ? spec.armor.turretSlope : spec.armor.hullSlope) || null;
  let thickness = set[key] ?? set.side ?? 25;
  let slope = slopes ? slopes[key] || 0 : 0;
  let face = key;

  // The gun shield is a separate casting from the turret cheek beside it, and
  // on most of these vehicles it is much the thicker of the two — which is why
  // aiming at the mantlet is usually the wrong idea.
  if (isTurret && key === 'front') {
    const t = spec.turret;
    const onMantlet =
      !!localPoint &&
      Math.abs(localPoint.x) < t.w * 0.24 &&
      localPoint.y > t.h * 0.16 &&
      localPoint.y < t.h * 0.86;
    if (onMantlet && spec.armor.mantlet) {
      thickness = spec.armor.mantlet;
      slope = spec.armor.mantletSlope ?? 0;
      face = 'mantlet';
    } else if (!onMantlet && spec.armor.turretCheek) {
      thickness = spec.armor.turretCheek;
      face = 'cheek';
    }
  }

  plateNormal(zone, slope, localDir, outNormal);
  return { thickness, slope, face };
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

function circlePts(c, r, n = 24) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([c.z + Math.cos(a) * r, c.y + Math.sin(a) * r]);
  }
  return out;
}

// Where the wheels actually sit. `road.at: [z, ...]` states the positions
// outright, which is the only way to draw a chassis whose wheels have a
// RHYTHM — the Stuart's two tight bogie pairs forward of centre with a metre
// of empty track behind them, the Panzer IV's four leaf-sprung pairs. Without
// it every suspension flattens into an anonymous evenly-spaced row of discs.
function roadZs(rd) {
  if (rd.at) return rd.at.slice();
  const out = [];
  for (let i = 0; i < rd.count; i++) {
    const u = rd.count === 1 ? 0 : i / (rd.count - 1);
    out.push(rd.from + (rd.to - rd.from) * u);
  }
  return out;
}

function spanZs(block) {
  const out = [];
  const n = block?.count || 0;
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : i / (n - 1);
    out.push(block.from + (block.to - block.from) * u);
  }
  return out;
}

function chassisCircles(chassis) {
  const rd = chassis.road;
  const ro = chassis.rollers;
  return {
    sprocket: chassis.sprocket,
    idler: chassis.idler,
    road: roadZs(rd).map((z) => ({ z, y: rd.y, r: rd.r })),
    rollers: spanZs(ro).map((z) => ({ z, y: ro.y, r: ro.r })),
  };
}

// The top of the track run a fender has to clear. Sprocket and idler are
// deliberately left out: on a Tiger and a T-34 those stand proud of the guards
// at the ends of the vehicle, which is correct, but a fender seated on THEM
// would float clear above the run it exists to shroud. Everything that used to
// hard-code `trackH + 0.06` now measures this instead, which is what stops the
// track from visibly passing through its own guards.
function trackRunTop(chassis) {
  const c = chassisCircles(chassis);
  let top = -Infinity;
  for (const q of c.road.concat(c.rollers)) {
    // + half a link for the grousers beltGeometry lifts off the outer edge,
    // which are part of the belt's real outside surface
    top = Math.max(top, q.y + q.r + chassis.thickness * 1.5);
  }
  return top;
}

// Lower boundary of Andrew's monotone chain: the ground run, taut, leftmost
// point to rightmost.
function lowerChain(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2
      && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  return lower;
}

// Walk the belt over its supports, left to right along their TOPS: arc across
// each wheel between the tangent it arrives on and the tangent it leaves on,
// then a free span to the next one that dips under its own weight.
//
// This is the part a convex hull could never do. A hull's top run is one taut
// chord from sprocket to idler, floating above everything between — which is
// why the return rollers used to be buried inside a belt they are there to
// hold up, and why every track in the game read as a rigid rubber band. Real
// track drapes in scallops between rollers, and on a T-34, which has none, it
// lies directly on the road-wheel tops.
function topRun(circles, radiusOf, sag, arcStep = 0.3) {
  const s = circles.slice().sort((a, b) => a.z - b.z);
  const R = s.map(radiusOf);
  const ang = [];
  for (let i = 0; i < s.length - 1; i++) {
    const dz = s[i + 1].z - s[i].z;
    const dy = s[i + 1].y - s[i].y;
    const L = Math.hypot(dz, dy) || 1e-6;
    const t = Math.max(-1, Math.min(1, (R[i] - R[i + 1]) / L));
    ang.push(Math.atan2(dy, dz) + Math.acos(t));
  }
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const a0 = i === 0 ? Math.PI : ang[i - 1];
    const a1 = i === s.length - 1 ? 0 : ang[i];
    const steps = Math.max(1, Math.round(Math.abs(a1 - a0) / arcStep));
    for (let k = 0; k <= steps; k++) {
      const a = a0 + (a1 - a0) * (k / steps);
      out.push([s[i].z + Math.cos(a) * R[i], s[i].y + Math.sin(a) * R[i]]);
    }
    if (i === s.length - 1) break;
    const az = s[i].z + Math.cos(ang[i]) * R[i];
    const ay = s[i].y + Math.sin(ang[i]) * R[i];
    const bz = s[i + 1].z + Math.cos(ang[i]) * R[i + 1];
    const by = s[i + 1].y + Math.sin(ang[i]) * R[i + 1];
    const span = Math.hypot(bz - az, by - ay);
    const cells = sag > 0 && span > 0.45 ? Math.max(2, Math.round(span / 0.3)) : 1;
    for (let k = 1; k < cells; k++) {
      const u = k / cells;
      out.push([
        az + (bz - az) * u,
        ay + (by - ay) * u - sag * 4 * u * (1 - u),
      ]);
    }
  }
  return out;
}

// One closed belt outline, offset outward by `pad`. Both the outer edge and
// the hole are walked by the same code so the sag matches and the hole can
// never poke through the sagging outer edge.
function beltOutline(chassis, pad, sag, arcPts = 24) {
  const c = chassisCircles(chassis);
  const all = [c.sprocket, c.idler, ...c.road, ...c.rollers];
  const rOf = (q) => q.r + pad;
  const bottom = lowerChain(all.flatMap((q) => circlePts(q, rOf(q), arcPts)));
  // return rollers carry the top run where a vehicle has them; where it has
  // none — Tiger, T-34 — the road wheels themselves do
  const supports = [c.sprocket, c.idler, ...(c.rollers.length ? c.rollers : c.road)];
  const top = topRun(supports, rOf, sag, arcPts === 24 ? 0.3 : (Math.PI * 2) / arcPts).reverse();
  return bottom.slice(0, -1).concat(top.slice(0, -1));
}

// The belt is chopped into links. It used to be one smooth ribbon, and a
// smooth ribbon reads as a black stripe painted along the hull from about
// thirty metres out; what the eye actually recognises as track is the sawtooth
// the grousers cut into the silhouette. That belongs in the outline, where it
// survives being seen edge-on, rather than in the normal map, where it does not.
//
// MOVING TRACK. The belt is built along its own path rather than extruded
// from a flat outline, so that it can RUN: every vertex carries `aBelt` =
// (s, off) — its arc length along the belt's centre line and its offset along
// that line's outward normal — and the vertex shader (runningGearMaterial)
// re-places it at s - d, where d is how far that side's track has run. The
// grousers and the link texture (triplanar off the REST position, so it is
// glued to the link) travel round the sprocket, along the top run and down
// the ground run together; nothing is rebuilt per frame. The centre line is
// shipped once per spec as a BELT_SAMPLES x 1 float texture (beltPath), and
// beltAt() is the shader's exact JS twin, which is what lays the geometry.
//
// The link pattern is counted round the WHOLE perimeter at a constant pitch
// (an even number of cells), so it is periodic along s and a run of any
// length lands on the same sawtooth: alternate cells lifted by half a link,
// a 55 % plateau and a ramp, as the old per-edge profile cut it.
export const BELT_SAMPLES = 1024;

// The belt's centre line — half a link out from the wheels — resampled at
// equal arc length, counter-clockwise in (z, y): s increases forward along the
// ground run and rearward along the top. data = (z, y, nz, ny) per sample,
// n the outward normal.
export function beltPath(chassis, samples = BELT_SAMPLES) {
  const th = chassis.thickness;
  const raw = beltOutline(chassis, th * 0.5, chassis.sag || 0, 72);
  let area = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    const b = raw[(i + 1) % raw.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area < 0) raw.reverse();
  const pts = [];
  for (const p of raw) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) pts.push(p);
  }
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) pts.pop();
  const n = pts.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const perim = cum[n];
  const zy = new Float64Array(samples * 2);
  let seg = 0;
  for (let k = 0; k < samples; k++) {
    const s = (k / samples) * perim;
    while (seg < n - 1 && cum[seg + 1] < s) seg++;
    const a = pts[seg];
    const b = pts[(seg + 1) % n];
    const L = cum[seg + 1] - cum[seg] || 1;
    const u = (s - cum[seg]) / L;
    zy[k * 2] = a[0] + (b[0] - a[0]) * u;
    zy[k * 2 + 1] = a[1] + (b[1] - a[1]) * u;
  }
  // a short tangent window smooths the outline's polygon corners, so a link
  // turning round the sprocket turns rather than snapping between facets
  const W = 3;
  const data = new Float32Array(samples * 4);
  for (let k = 0; k < samples; k++) {
    const a = (k - W + samples) % samples;
    const b = (k + W) % samples;
    const tz = zy[b * 2] - zy[a * 2];
    const ty = zy[b * 2 + 1] - zy[a * 2 + 1];
    const l = Math.hypot(tz, ty) || 1;
    data[k * 4] = zy[k * 2];
    data[k * 4 + 1] = zy[k * 2 + 1];
    data[k * 4 + 2] = ty / l;    // outward normal of a CCW loop: (ty, -tz)
    data[k * 4 + 3] = -tz / l;
  }
  return { data, perim, samples };
}

// The point and outward normal at arc length s (any real s; the loop wraps).
// The shader's beltAt() line for line.
export function beltAt(path, s, out = {}) {
  const { data, perim, samples: M } = path;
  const f = s / perim;
  const u = (f - Math.floor(f)) * M;
  const a = Math.min(Math.floor(u), M - 1);
  const t = u - a;
  const b = a + 1 >= M ? 0 : a + 1;
  const lerp = (c) => data[a * 4 + c] + (data[b * 4 + c] - data[a * 4 + c]) * t;
  const nz = lerp(2);
  const ny = lerp(3);
  const l = Math.hypot(nz, ny) || 1;
  out.z = lerp(0);
  out.y = lerp(1);
  out.nz = nz / l;
  out.ny = ny / l;
  return out;
}

// One belt, centred on x = 0, laid round `path`. Non-indexed (the zone bake
// wants triangles), with flat face normals like the extrusion it replaces.
// cell length round the loop: an even count at (about) the link pitch
function beltCell(chassis, path) {
  const pitch = chassis.linkPitch || 0.17;
  const cells = Math.max(2, 2 * Math.round(path.perim / pitch / 2));
  return { cells, L: path.perim / cells };
}

function beltGeometry(chassis, width, path) {
  const th = chassis.thickness;
  const { cells, L } = beltCell(chassis, path);
  const lift = th * 0.5;
  const rings = [];
  for (let k = 0; k < cells; k++) {
    const hi = k % 2 === 0 ? lift : 0;
    // plateau start and end, and the middle of the ramp (it rounds the arcs)
    rings.push([k * L, hi], [(k + 0.55) * L, hi], [(k + 0.775) * L, lift * 0.5]);
  }
  const R = rings.length;
  const q = {};
  const ring = rings.map(([s, lf]) => {
    beltAt(path, s, q);
    const offIn = -th * 0.5;
    const offOut = th * 0.5 + lf;
    return {
      s, nz: q.nz, ny: q.ny, offIn, offOut,
      iz: q.z + q.nz * offIn, iy: q.y + q.ny * offIn,
      oz: q.z + q.nz * offOut, oy: q.y + q.ny * offOut,
    };
  });
  const pos = [];
  const bel = [];
  const x0 = -width / 2;
  const x1 = width / 2;
  // a vertex: [x, y, z, s, off]
  const tri = (A, B, C, ex, ey, ez) => {
    const ux = B[0] - A[0]; const uy = B[1] - A[1]; const uz = B[2] - A[2];
    const vx = C[0] - A[0]; const vy = C[1] - A[1]; const vz = C[2] - A[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const list = cx * ex + cy * ey + cz * ez < 0 ? [A, C, B] : [A, B, C];
    for (const v of list) {
      pos.push(v[0], v[1], v[2]);
      bel.push(v[3], v[4]);
    }
  };
  const quad = (A, B, C, D, ex, ey, ez) => {
    tri(A, B, C, ex, ey, ez);
    tri(A, C, D, ex, ey, ez);
  };
  for (let i = 0; i < R; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % R];
    const ny = a.ny + b.ny;
    const nz = a.nz + b.nz;
    const O = (r, x) => [x, r.oy, r.oz, r.s, r.offOut];
    const I = (r, x) => [x, r.iy, r.iz, r.s, r.offIn];
    quad(O(a, x0), O(a, x1), O(b, x1), O(b, x0), 0, ny, nz);
    quad(I(a, x0), I(a, x1), I(b, x1), I(b, x0), 0, -ny, -nz);
    quad(I(a, x1), O(a, x1), O(b, x1), I(b, x1), 1, 0, 0);
    quad(I(a, x0), O(a, x0), O(b, x0), I(b, x0), -1, 0, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBelt', new THREE.Float32BufferAttribute(bel, 2));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// moving running gear: shader + per-tank state
// ---------------------------------------------------------------------------
// Per-tank values on SHARED materials and SHARED geometry. A uniform cannot
// carry them (three uploads material uniforms once per material switch, and
// every tank's belt draws back to back with the same material), so they ride
// in the one per-object array three uploads for every draw: the morph target
// influences. The moving meshes' geometry carries two all-zero relative morph
// targets, so the morph itself adds nothing; morphTargetInfluences[0] is the
// distance the LEFT (+X) side has run, [1] the right. Nothing else changes per
// frame — no geometry, no material, no uniform. A wreck simply stops writing
// them, and the X-ray / protection views re-dress the meshes in their own
// materials, which do not read them.
const RG_COMMON = `
      #ifdef USE_MORPHTARGETS
        #define RG_DIST(px) ((px) > 0.0 ? morphTargetInfluences[0] : morphTargetInfluences[1])
      #else
        #define RG_DIST(px) 0.0
      #endif`;

const RG_BELT_PARS = `
      attribute vec2 aBelt;
      uniform sampler2D uBeltPath;
      uniform vec2 uBeltInfo;
      uniform vec2 uBeltTex;
      varying vec3 vRgN;
      vec4 rgBeltAt(float s) {
        float f = s / uBeltInfo.x;
        float u = (f - floor(f)) * uBeltInfo.y;
        int n = int(uBeltInfo.y + 0.5);
        int a = min(int(floor(u)), n - 1);
        float t = u - float(a);
        int b = a + 1 >= n ? 0 : a + 1;
        vec4 p = mix(texelFetch(uBeltPath, ivec2(a, 0), 0), texelFetch(uBeltPath, ivec2(b, 0), 0), t);
        p.zw = normalize(p.zw);
        return p;
      }`;

// p.xy = (z, y), p.zw = (nz, ny)
const RG_BELT_MAIN = `
      vec3 rgDelta = vec3(0.0);
      {
        vec4 p0 = rgBeltAt(aBelt.x);
        // the rest normal UNROLLED (path normal turned to +Y): which way the
        // face points on the link itself, for the texture projection
        vRgN = vec3(objectNormal.x,
          objectNormal.z * p0.z + objectNormal.y * p0.w,
          objectNormal.z * p0.w - objectNormal.y * p0.z);
        float rgD = RG_DIST(position.x);
        if (rgD != 0.0) {
          vec4 p1 = rgBeltAt(aBelt.x - rgD);
          vec2 q0 = p0.xy + p0.zw * aBelt.y;
          vec2 q1 = p1.xy + p1.zw * aBelt.y;
          rgDelta.z = q1.x - q0.x;
          rgDelta.y = q1.y - q0.y;
          float c = dot(p0.zw, p1.zw);
          float sn = p0.z * p1.w - p0.w * p1.z;
          float onz = objectNormal.z;
          float ony = objectNormal.y;
          objectNormal.z = onz * c - ony * sn;
          objectNormal.y = onz * sn + ony * c;
        }
      }`;

const RG_SPIN_PARS = `
      attribute vec3 aSpin;`;

// aSpin = (centre y, centre z, 1 / rolling radius). Positive angle about +X
// carries the top of a wheel forward (+Z): a wheel rolling forward.
const RG_SPIN_MAIN = `
      vec3 rgDelta = vec3(0.0);
      {
        float rgD = RG_DIST(position.x);
        if (rgD != 0.0) {
          float ang = rgD * aSpin.z;
          float c = cos(ang);
          float sn = sin(ang);
          float dy = position.y - aSpin.x;
          float dz = position.z - aSpin.y;
          rgDelta.y = dy * c - dz * sn - dy;
          rgDelta.z = dy * sn + dz * c - dz;
          float ony = objectNormal.y;
          float onz = objectNormal.z;
          objectNormal.y = ony * c - onz * sn;
          objectNormal.z = ony * sn + onz * c;
        }
      }`;

function patchRunningGear(shader, kind) {
  const belt = kind === 'belt';
  let vs = shader.vertexShader;
  vs = vs.replace('#include <common>', `#include <common>
      ${RG_COMMON}
      ${belt ? RG_BELT_PARS : RG_SPIN_PARS}`);
  vs = vs.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      ${belt ? RG_BELT_MAIN : RG_SPIN_MAIN}`);
  vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed += rgDelta;`);
  // the triplanar patch (core/materials.js) samples off the REST position, so
  // texture and weathering stay glued to the part — but it must light the
  // part with the normal it has NOW, or a link carried round onto the top run
  // would still be lit as if it faced the ground
  vs = vs.replace('vTriNrm = normal;', 'vTriNrm = objectNormal;');
  if (belt) {
    // A link's texture is read in UNROLLED belt space — (x, offset, s), a
    // straight belt lying along z — so it is the same wherever on the loop
    // the link has got to. Off the rest position, a link that started on the
    // sprocket arc dragged that arc's projection along the ground run as
    // streaks. s is scaled so the texture's link bands (four per tile) land
    // one per grouser pair, crowns on the raised cells.
    vs = vs.replace('vTriPos = position;',
      'vTriPos = vec3(position.x, aBelt.y, aBelt.x * uBeltTex.x + uBeltTex.y);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
      varying vec3 vRgN;`)
      .replace('vec3 w = abs(normalize(vTriNrm));', 'vec3 w = abs(normalize(vRgN));');
  }
  shader.vertexShader = vs;
}

// The moving twin of a shared factory material: same maps, same patch, same
// look, plus the running-gear vertex stage. Shared itself (one per base
// material, and per spec for a belt, whose path it carries), so a battle of
// twenty tanks still draws from a handful of materials and one program each.
// Made the way tankEntity's wreckMaterial is: never a userData JSON copy.
const rgVariants = new WeakMap();
function runningGearMaterial(base, kind, belt = null) {
  let per = rgVariants.get(base);
  if (!per) {
    per = new Map();
    rgVariants.set(base, per);
  }
  const key = kind === 'belt' ? `belt|${belt.id}` : 'spin';
  let m = per.get(key);
  if (m) return m;
  m = new base.constructor();
  const ud = base.userData;
  base.userData = {};
  try {
    m.copy(base);
  } finally {
    base.userData = ud;
  }
  const keepUd = { ...ud };
  delete keepUd.shader;
  m.userData = keepUd;
  m.name = `${base.name || 'material'} (${kind})`;
  const own = (k) => Object.prototype.hasOwnProperty.call(base, k);
  const patch = own('onBeforeCompile') ? base.onBeforeCompile : null;
  const prevKey = own('customProgramCacheKey') ? String(base.customProgramCacheKey()) : '';
  const uniforms = kind === 'belt' ? {
    uBeltPath: { value: belt.texture },
    uBeltInfo: { value: new THREE.Vector2(belt.perim, belt.samples) },
    // texture link (tile / 4) per two cells, band centre on the raised cell
    uBeltTex: { value: beltTexMap(base.userData.triScale || 0.6, belt.cellLen) },
  } : null;
  m.onBeforeCompile = function runningGearPatch(shader, renderer) {
    if (patch) {
      // the factory patch records its shader on the material it was written
      // for; keep that record pointing at the base, not at us
      const had = Object.prototype.hasOwnProperty.call(base.userData, 'shader');
      const keep = base.userData.shader;
      patch.call(this, shader, renderer);
      if (had) base.userData.shader = keep;
      else delete base.userData.shader;
    }
    if (uniforms) Object.assign(shader.uniforms, uniforms);
    patchRunningGear(shader, kind);
    this.userData.shader = shader;
  };
  m.customProgramCacheKey = () => `${prevKey}|rg1${kind}`;
  if (own('onBeforeRender')) m.onBeforeRender = base.onBeforeRender;
  markShared(m);
  per.set(key, m);
  return m;
}

function beltTexMap(tile, L) {
  const k = (tile / 4) / (2 * L);
  return new THREE.Vector2(k, tile / 8 - 0.3 * L * k);
}

// Two zero relative morph targets: the carrier of the per-tank distances.
function addRunningGearMorphs(geo) {
  if (!geo) return;
  const zero = new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3);
  geo.morphAttributes.position = [zero, zero];
  geo.morphTargetsRelative = true;
}

// Wheels, sprocket, idler and rollers spin about their own axle: one bin per
// material, every part stamped with its axle and rolling radius.
function addSpin(bin, geo, cy, cz, r) {
  if (!geo) return;
  const g = mergeable(geo);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = cy;
    a[i * 3 + 1] = cz;
    a[i * 3 + 2] = 1 / r;
  }
  g.setAttribute('aSpin', new THREE.BufferAttribute(a, 3));
  bin.push(g);
}

// Drives one tank's running gear: `beltL/R` metres each track has run (the
// shader wraps them round the loop), `wheelL/R` metres each side's wheels have
// rolled. Callers keep their own running totals and wrap them with
// rg.wrap (a whole number of belt perimeters, ~500 m) so float precision
// holds and the belt never jumps.
export function driveRunningGear(rg, beltL, beltR, wheelL = beltL, wheelR = beltR) {
  if (!rg) return;
  if (rg.belt) {
    const f = rg.belt.morphTargetInfluences;
    f[0] = beltL;
    f[1] = beltR;
  }
  for (const m of rg.wheels) {
    const f = m.morphTargetInfluences;
    f[0] = wheelL;
    f[1] = wheelR;
  }
}

// JS twin of the spin stage, for tests: where a point (y, z) of a wheel with
// centre (cy, cz) and radius r sits after its side has rolled d metres.
export function spinPoint(y, z, cy, cz, r, d) {
  const a = d / r;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dy = y - cy;
  const dz = z - cz;
  return { y: cy + dy * c - dz * s, z: cz + dy * s + dz * c };
}

// One hull station. Real tanks are not a single box: there is a narrow body
// down between the tracks, sponsons overhanging them, and on most designs a
// roof narrower than the sponson line because the side plates slope inward.
function station(z, wLow, yFloor, wSpon, ySpon, wRoof, yRoof) {
  return {
    z,
    pts: [
      [-wLow, yFloor], [wLow, yFloor],
      [wSpon, ySpon], [wRoof, yRoof],
      [-wRoof, yRoof], [-wSpon, ySpon],
    ],
  };
}

// Skin a chain of stations, ordered front (+Z) to back (-Z).
function loftHull(sections) {
  const v = [];
  const tri = (a, b, c) => v.push(...a, ...b, ...c);
  const P = (s, i) => [s.pts[i][0], s.pts[i][1], s.z];
  for (let s = 0; s < sections.length - 1; s++) {
    const A = sections[s];
    const B = sections[s + 1];
    const n = A.pts.length;
    // stations run front to back, so this is the order that puts the side
    // normals outward rather than into the hull
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tri(P(A, i), P(B, i), P(B, j));
      tri(P(A, i), P(B, j), P(A, j));
    }
  }
  const capA = sections[0];
  const capB = sections[sections.length - 1];
  for (let i = 1; i < capA.pts.length - 1; i++) {
    tri(P(capA, 0), P(capA, i), P(capA, i + 1));
    tri(P(capB, 0), P(capB, i + 1), P(capB, i));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

function planArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    area += x0 * z1 - x1 * z0;
  }
  return area;
}

// Polygon prism: footprint in XZ swept up Y, top ring scaled and optionally
// shifted so the walls slope. `opts.capTop: false` leaves the top OPEN, which
// is the whole point of a Wirbelwind — a closed tub is a different vehicle.
function prismY(pts, height, topScale = 1, topShiftZ = 0, yBase = 0, opts = {}) {
  const { capTop = true, capBottom = true } = opts;
  const p = planArea(pts) > 0 ? [...pts].reverse() : pts;
  const n = p.length;
  const top = p.map(([x, z]) => [x * topScale, z * topScale + topShiftZ]);
  const v = [];
  const push = (a, y, b) => v.push(a, y, b);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    push(p[i][0], yBase, p[i][1]); push(p[j][0], yBase, p[j][1]); push(top[j][0], yBase + height, top[j][1]);
    push(p[i][0], yBase, p[i][1]); push(top[j][0], yBase + height, top[j][1]); push(top[i][0], yBase + height, top[i][1]);
  }
  for (let i = 1; i < n - 1; i++) {
    if (capBottom) {
      push(p[0][0], yBase, p[0][1]); push(p[i + 1][0], yBase, p[i + 1][1]); push(p[i][0], yBase, p[i][1]);
    }
    if (capTop) {
      push(top[0][0], yBase + height, top[0][1]); push(top[i][0], yBase + height, top[i][1]);
      push(top[i + 1][0], yBase + height, top[i + 1][1]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

// A wall that changes its lean partway up. Each band starts from the previous
// band's top ring, so `[{h, scale}, ...]` stacks into a profile a single taper
// cannot express — the Wirbelwind's waist, where every one of the nine facets
// is two plates, the lower leaning out and the upper leaning back in, meeting
// at a belt about halfway up.
function prismBands(pts, bands, opts = {}) {
  const parts = [];
  let ring = pts;
  let y = opts.yBase || 0;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    parts.push(prismY(ring, b.h, b.scale, 0, y, {
      capBottom: i === 0 ? opts.capBottom !== false : false,
      capTop: i === bands.length - 1 ? opts.capTop !== false : false,
    }));
    ring = ring.map(([x, z]) => [x * b.scale, z * b.scale]);
    y += b.h;
  }
  return { parts, topRing: ring, topY: y };
}

// Skin a stack of rings, each its own plan at its own height, with SMOOTH
// normals up the walls and a hard edge at the roof. A cast turret is not a
// prism with a flat top: it swells outward at the cheeks and pulls back in
// under the roof, and eight hard facets on a casting is precisely the case
// where the geometry is wrong and the shading is being asked to hide it.
function loftYRings(rings) {
  const n = rings[0].pts.length;
  const pos = [];
  const idx = [];
  for (const r of rings) for (const [x, z] of r.pts) pos.push(x, r.y, z);
  for (let s = 0; s < rings.length - 1; s++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = s * n + i;
      const b = s * n + j;
      const c = (s + 1) * n + j;
      const d = (s + 1) * n + i;
      // Wound so the face normal points OUT of the shell. Emitted the other
      // way round this loft came out inside out, and with FrontSide culling
      // every outer face was discarded — you saw straight through the turret
      // wall into the far interior. Measured before the fix: 136 of the
      // T-34's 140 shell triangles faced inward, and 140 of 140 on the
      // Pershing. prismY normalises its plan winding instead, which is why
      // the Tiger and the Stuart were never affected.
      idx.push(a, b, c, a, c, d);
    }
  }
  // caps get their own copies of the ring so the roof edge stays sharp
  const capBase = pos.length / 3;
  const bottom = rings[0];
  const top = rings[rings.length - 1];
  for (const [x, z] of bottom.pts) pos.push(x, bottom.y, z);
  for (const [x, z] of top.pts) pos.push(x, top.y, z);
  for (let i = 1; i < n - 1; i++) {
    idx.push(capBase, capBase + i + 1, capBase + i);
    idx.push(capBase + n, capBase + n + i, capBase + n + i + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// Move a plan inward: `dx` off the half-width, `dzF`/`dzB` off the front and
// rear. Separate axes because a cast turret's sides come in twice as far as
// its rear plate does, and one uniform scale is what erases a bustle.
function insetPlan(pts, dx, dzF, dzB) {
  return pts.map(([x, z]) => [
    Math.sign(x) * Math.max(0, Math.abs(x) - dx),
    z > 0 ? Math.max(0, z - dzF) : Math.min(0, z + dzB),
  ]);
}

// Chaikin corner-cutting, so a handful of control points becomes a smooth
// closed outline. Cheaper than raising a polygon's side count blindly: the
// points land where the curvature is.
function smoothClosed(pts, iterations = 1) {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    const out = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    p = out;
  }
  return p;
}

// `phase` rotates the polygon by a fraction of one facet, which is how an
// odd-sided plan puts a flat PLATE facing forward instead of a vertex — the
// Wirbelwind's front plate, pierced by the barrel openings, is a facet.
// `rearStretch` extends the plan behind the ring the way `noseStretch`
// extends it in front.
function ovalPts(halfW, halfL, sides = 12, noseStretch = 1, rearStretch = 1, phase = 0) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = ((i + phase) / sides) * Math.PI * 2;
    const c = Math.cos(a);
    pts.push([Math.sin(a) * halfW, c * halfL * (c > 0 ? noseStretch : rearStretch)]);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// hull stations, front (+Z) to back (-Z)
// ---------------------------------------------------------------------------
// Stations are in ABSOLUTE metres, not in fractions of a track width, and a
// bow is expressed as a STEP: two stations a few centimetres apart give a
// near-vertical plate where a single station could only give a lofted wedge.
// That distinction is the whole argument here — a Tiger, a Panzer IV and a
// Stuart are all defined by NOT having a sloping glacis, and the old recipe
// could not draw anything else.
function hullStations(spec) {
  const { w, h, len, trackH } = spec.hull;
  const tw = spec.chassis.trackW;
  const f = len / 2;
  const y0 = spec.hull.clear ?? trackH * 0.18;   // belly, real ground clearance
  // sponson floor: above the top of the actual track run, never a guess
  const ySp = Math.max(trackH + 0.04, trackRunTop(spec.chassis) + 0.05);
  const yR = trackH + h;                          // roof
  const wLow = w / 2 - tw * 0.92;                 // tub, squeezed between the runs
  const wSp = w / 2 - tw * 0.06;                  // sponsons out over the tracks
  // roof half-width from the upper side plate's REAL lay, not a coefficient:
  // 40 degrees on a T-34 closes a 2.90m sponson line to a 1.91m deck, which is
  // the wedge you see head-on and the reason its turret overhangs the hull.
  const wR = Math.max(0.3, wSp - (yR - ySp) * Math.tan((spec.hull.sideDeg || 0) * DEG));
  const kind = spec.shape.hull;

  if (kind === 't34') {
    // rounded nose beam, then ONE 60-degree glacis plate to a flat deck
    return [
      station(f, wLow * 0.78, y0 + 0.28, wSp * 0.72, ySp - 0.27, wR * 0.86, 0.82),
      station(1.70, wLow, y0, wSp, ySp, wR, yR),
      station(-1.90, wLow, y0, wSp, ySp, wR, yR),
      station(-2.85, wLow, y0 + 0.04, wSp, ySp, wR, yR),
      station(-f, wLow * 0.88, y0 + 0.45, wSp * 0.96, ySp, wR * 0.96, yR - 0.08),
    ];
  }
  if (kind === 't34low') {
    // SU-100: the casemate IS the hull. One unbroken 50-degree plate from the
    // nose beam to the roof — no glacis, no flat deck, no separate box dropped
    // on top — then a near-vertical rear wall stepping down to the T-34 engine
    // deck for the last 2.2m. That step is the second-best cue the vehicle has.
    const wCase = 1.08;   // casemate roof half-width: 20 degrees off the sponson
    return [
      station(f, wLow * 0.78, y0 + 0.12, wSp * 0.72, ySp - 0.27, wSp * 0.60, 0.82),
      station(1.62, wLow, y0, wSp, ySp, wCase, 2.02),
      station(-0.80, wLow, y0, wSp, ySp, wCase, 2.02),
      station(-0.85, wLow, y0, wSp, ySp, wR, yR),
      station(-2.85, wLow, y0 + 0.04, wSp, ySp, wR, yR),
      station(-f, wLow * 0.88, y0 + 0.45, wSp * 0.96, ySp, wR * 0.96, yR - 0.08),
    ];
  }
  if (kind === 'slab') {
    // Tiger: STEPPED SQUARE NOSE — a 25-degree nose plate, a near-horizontal
    // glacis shelf carrying the spare track, then a 9-degree full-width
    // driver's plate. There is no wedge anywhere on this tank. The sponsons
    // flare to full width at the driver's plate and stay there: one flat
    // vertical wall per side, all the way to the tail.
    return [
      station(f, wLow * 0.90, 0.86, wLow * 0.98, 0.88, wLow * 0.94, 0.92),
      station(f - 0.18, wLow, y0, wLow * 1.02, 0.90, wLow * 0.98, 0.93),
      station(f - 0.71, wLow, y0, wLow * 1.04, 0.97, wLow * 1.02, 1.05),
      station(f - 0.84, wLow, y0, wSp, ySp, wR, yR),
      station(-2.30, wLow, y0, wSp, ySp, wR, yR),
      station(-2.95, wLow, y0 + 0.05, wSp, ySp, wR, yR),
      station(-f, wLow * 0.96, y0 + 0.15, wSp * 0.99, ySp, wR * 0.99, yR - 0.06),
    ];
  }
  if (kind === 'panzer4') {
    // Panzer IV: near-vertical lower nose, a short HORIZONTAL ledge, then the
    // superstructure front standing vertical up to the roof. A step, not a ramp.
    return [
      station(f, wLow * 0.92, 0.98, wSp * 0.82, ySp - 0.12, wR * 0.82, 1.05),
      station(f - 0.16, wLow, y0, wSp * 0.90, ySp - 0.04, wR * 0.90, 1.05),
      station(f - 0.36, wLow, y0, wSp, ySp, wR, 1.05),
      station(f - 0.42, wLow, y0, wSp, ySp, wR, yR),
      station(-2.40, wLow, y0, wSp, ySp, wR, yR),
      station(-2.80, wLow, y0 + 0.04, wSp, ySp, wR, yR - 0.03),
      station(-f, wLow * 0.92, y0 + 0.20, wSp * 0.96, ySp, wR * 0.96, yR - 0.09),
    ];
  }
  if (kind === 'pershing') {
    // M26: one clean 46-degree glacis over a short 0.63m run onto a wide flat
    // deck, with the 53-degree lower front falling out of the same loft. The
    // upper sides are VERTICAL — the broad deck either side of the turret is
    // a recognition feature, so nothing tapers.
    return [
      station(f, wLow * 0.90, 0.90, wLow * 1.02, 0.92, wLow * 0.96, 0.95),
      station(2.53, wLow, y0 + 0.06, wSp, ySp, wR, yR),
      station(2.30, wLow, y0, wSp, ySp, wR, yR),
      station(-1.20, wLow, y0, wSp, ySp, wR, yR),
      station(-2.60, wLow, y0, wSp, ySp, wR, yR - 0.07),
      station(-f, wLow * 0.94, y0 + 0.14, wSp * 0.98, ySp, wR * 0.98, yR - 0.17),
    ];
  }
  // 'boxy' — M3 Stuart. A BLUNT STEPPED BOW: the bolted three-piece final
  // drive casting at the bottom, a near-vertical 18-degree driver's plate
  // above it, then only a 20-degree deck back to the roof. There is no long
  // sloping glacis anywhere on an M3, and the superstructure sides are flat
  // vertical slabs flush with the sponson edge.
  return [
    station(f, wLow * 0.86, 0.78, wSp * 0.80, 0.86, wR * 0.78, 1.02),
    station(f - 0.22, wLow, y0, wSp, ySp, wR, 1.05),
    station(f - 0.38, wLow, y0, wSp, ySp, wR, 1.52),
    station(f - 1.02, wLow, y0, wSp, ySp, wR, yR),
    station(-f + 1.05, wLow, y0, wSp, ySp, wR, yR),
    station(-f + 0.30, wLow, y0 + 0.04, wSp, ySp, wR, yR - 0.02),
    station(-f, wLow * 0.90, y0 + 0.20, wSp * 0.94, ySp, wR * 0.94, yR - 0.10),
  ];
}

// ---------------------------------------------------------------------------
// merge plumbing
// ---------------------------------------------------------------------------
//
// Every part of the vehicle is merged into one mesh per material. That is the
// point of this pass rather than a nicety: a full battle was 316 draw calls and
// 94 materials for only 91,912 triangles, so the renderer was starving on state
// changes while the GPU sat idle on geometry.
//
// mergeGeometries insists that its inputs agree on indexing and on the exact
// set of attributes, and the hand-built hull (loftHull) and turret (prismY)
// carry only `position` and `normal` — no uv at all. Every material in
// core/materials.js projects its maps triplanar from object space and never
// reads a uv, so throwing the primitives' uvs away costs nothing and is what
// makes a BoxGeometry mergeable with a lofted hull.
function mergeable(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  g.deleteAttribute('uv1');
  g.deleteAttribute('uv2');
  return g;
}

// One bucket per (frame, material). Anything that has to move or be hidden on
// its own — the turret, the gun, the recoiling mass — gets its own frame, so
// merging can never weld a moving part to a fixed one.
function newBins() {
  return {
    hullArmour: [], hullSteel: [], hullGear: [], hullTrack: [], hullMatt: [],
    hullMarker: [],
    // V-11: rubber tyres apart from the steel track; V-03/Z5: heat-burnt bare
    // metal (exhaust, tow cable) apart from the painted fittings
    hullTyre: [], hullBare: [],
    // the moving running gear (see runningGearMaterial): the belt, and the
    // wheels in tyre rubber and in paint, every part keyed to its own axle
    trackBelt: [], wheelTyre: [], wheelGear: [],
    // cast parts get their own bin because they are the one place on these
    // vehicles where smooth normals are CORRECT: a turret casting is not a
    // faceted plate structure and flat-shading one is what made the T-34 and
    // the Pershing read as welded boxes.
    turArmour: [], turCast: [], turSteel: [], turMarker: [],
    gunSteel: [], recSteel: [],
    // gun-framed but PAINTED: the mantlet elevates with the barrel yet wears
    // the turret's coat, and putting it in gunSteel made it a black ball.
    gunArmour: [],
    // V-03: the last 0.3 m of every tube and the muzzle brake, bare and
    // sooted (vertex colours), on the recoiling frame with the barrel
    gunCrown: [],
  };
}

function add(bin, geo) {
  if (!geo) return;
  bin.push(mergeable(geo));
}

// The crown: a part whose vertex colours grade from heat-browned steel at
// `z0` to soot at the muzzle `z1` (bible C-04: the last 0.1-0.3 m).
const CROWN_HEAT = [1.0, 0.86, 0.70];
const CROWN_SOOT = [0.42, 0.40, 0.38];
function addCrown(bins, geo, z0, z1) {
  const g = mergeable(geo);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, Math.min(1, (pos.getZ(i) - z0) / Math.max(1e-3, z1 - z0)));
    const s = t * t * (3 - 2 * t);
    for (let c = 0; c < 3; c++) col[i * 3 + c] = CROWN_HEAT[c] + (CROWN_SOOT[c] - CROWN_HEAT[c]) * s;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  bins.gunCrown.push(g);
}

// ---------------------------------------------------------------------------
// weathering-zone bake (V-04)
// ---------------------------------------------------------------------------
// The zone shader in core/materials.js needs three things a fragment cannot
// work out for itself, baked once per spec because the geometry is cached:
//   aZone  height above the ground contact in metres. Turret and gun parts
//          add their frame's offset here, so a turret roof knows it is 2 m up.
//   aBary  barycentric (x, y; z = 1 - x - y) of each corner of its triangle.
//   aEdge  per edge opposite corner i: the triangle's height onto that edge
//          (metres) if the edge is a CONVEX CREASE sharper than 32 degrees or
//          an open plate edge, else -1. distance-to-edge = bary_i * aEdge_i.
// The crease test welds positions within each PART before the merge, so two
// parts that merely touch never make a false edge. 32 degrees rather than the
// bible's 25: twelve-sided wheel hubs (30 degree facets) would otherwise chip
// along every facet line.
const CREASE_COS = Math.cos(32 * Math.PI / 180);

function bakeZones(g, yOffset) {
  const pos = g.attributes.position;
  const nv = pos.count;
  const nt = Math.floor(nv / 3);
  const zone = new Float32Array(nv);
  const bary = new Float32Array(nv * 2);
  const edge = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    zone[i] = pos.getY(i) + yOffset;
    const k = i % 3;
    bary[i * 2] = k === 0 ? 1 : 0;
    bary[i * 2 + 1] = k === 1 ? 1 : 0;
  }
  // weld
  const Q = 1e4;
  const idOf = new Map();
  const vid = new Int32Array(nv);
  for (let i = 0; i < nv; i++) {
    const key = `${Math.round(pos.getX(i) * Q)},${Math.round(pos.getY(i) * Q)},${Math.round(pos.getZ(i) * Q)}`;
    let id = idOf.get(key);
    if (id === undefined) { id = idOf.size; idOf.set(key, id); }
    vid[i] = id;
  }
  const P = (i) => [pos.getX(i), pos.getY(i), pos.getZ(i)];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const nrm = new Array(nt);
  const area2 = new Float32Array(nt);
  const edges = new Map();   // "a_b" -> [{t, apex}]
  for (let t = 0; t < nt; t++) {
    const a = P(t * 3);
    const b = P(t * 3 + 1);
    const c = P(t * 3 + 2);
    const n = cross(sub(b, a), sub(c, a));
    const l = len(n);
    area2[t] = l;
    nrm[t] = l > 1e-12 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0];
    for (let e = 0; e < 3; e++) {
      // edge e is opposite corner e: corners (e+1, e+2)
      const i1 = vid[t * 3 + (e + 1) % 3];
      const i2 = vid[t * 3 + (e + 2) % 3];
      const key = i1 < i2 ? `${i1}_${i2}` : `${i2}_${i1}`;
      let list = edges.get(key);
      if (!list) { list = []; edges.set(key, list); }
      list.push({ t, apex: t * 3 + e });
    }
  }
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      let h = -1;
      if (area2[t] > 1e-12) {
        const i1 = t * 3 + (e + 1) % 3;
        const i2 = t * 3 + (e + 2) % 3;
        const v1 = vid[i1];
        const v2 = vid[i2];
        const list = edges.get(v1 < v2 ? `${v1}_${v2}` : `${v2}_${v1}`);
        let sharp = false;
        if (!list || list.length === 1) {
          sharp = true;   // an open plate edge
        } else if (list.length === 2) {
          const o = list[0].t === t ? list[1] : list[0];
          const n1 = nrm[t];
          const n2 = nrm[o.t];
          if (dot(n1, n2) < CREASE_COS) {
            // convex when the neighbour's far corner lies behind our plane
            sharp = dot(n1, sub(P(o.apex), P(i1))) < -1e-6;
          }
        }
        if (sharp) {
          const el = len(sub(P(i2), P(i1)));
          if (el > 1e-9) h = area2[t] / el;   // |cross| = 2 * area; h = 2A / |edge|
        }
      }
      for (let k = 0; k < 3; k++) edge[(t * 3 + k) * 3 + e] = h;
    }
  }
  g.setAttribute('aZone', new THREE.BufferAttribute(zone, 1));
  g.setAttribute('aBary', new THREE.BufferAttribute(bary, 2));
  g.setAttribute('aEdge', new THREE.BufferAttribute(edge, 3));
  return g;
}

// `frameY` maps a bin to the height of its frame's origin above the ground
// contact (turret ring, gun trunnion), which the zone bake adds to aZone.
function sealBins(bins, frameY = {}) {
  const out = {};
  for (const key of Object.keys(bins)) {
    const list = bins[key];
    const y = frameY[key] || 0;
    for (const g of list) bakeZones(g, y);
    out[key] = list.length === 0 ? null
      : list.length === 1 ? list[0]
        : mergeGeometries(list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// primitive placement
// ---------------------------------------------------------------------------
// Everything is built in place and baked into its geometry rather than carried
// on a Mesh transform, because a merged mesh has only one transform to give.

function boxAt(w, h, d, x, y, z) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

// cylinder lying along Z: barrels, mufflers, the unditching log
function tubeZ(r0, r1, len, seg, x, y, z) {
  const g = new THREE.CylinderGeometry(r0, r1, len, seg);
  g.rotateX(Math.PI / 2);
  return g.translate(x, y, z);
}

// cylinder lying along X: every wheel on the vehicle
function tubeX(r0, r1, len, seg, x, y, z) {
  const g = new THREE.CylinderGeometry(r0, r1, len, seg);
  g.rotateZ(Math.PI / 2);
  return g.translate(x, y, z);
}

// upright cylinder: cupolas, hatches, exhaust stacks
function tubeY(r0, r1, len, seg, x, y, z) {
  return new THREE.CylinderGeometry(r0, r1, len, seg).translate(x, y, z);
}

// A short bar running from a to b, for weld beads and grab handles. Cheap
// enough at five sides that a hull can afford one along every plate join.
function barBetween(ax, ay, az, bx, by, bz, radius, seg = 5) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const L = Math.hypot(dx, dy, dz);
  if (L < 1e-4) return null;
  const g = new THREE.CylinderGeometry(radius, radius, L, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / L, dy / L, dz / L),
  );
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
  return g.translate(ax + dx / 2, ay + dy / 2, az + dz / 2);
}

// A gun tube along +Z from the trunnion (z = 0) to the muzzle (z = len), in
// two pieces: the painted barrel (bible C-04) and the last 0.3 m as the bare,
// sooted crown. The radius tapers through the joint without a step.
function barrelWithCrown(bins, rBreech, rMuzzle, len, seg, x, y) {
  const crown = Math.min(0.3, len * 0.25);
  const zc = len - crown;
  const rAt = (z) => rBreech + (rMuzzle - rBreech) * (z / len);
  add(bins.recSteel, tubeZ(rAt(zc), rBreech, zc, seg, x, y, zc / 2));
  addCrown(bins, tubeZ(rMuzzle, rAt(zc), crown, seg, x, y, zc + crown / 2), zc, len);
}

// Grow `box` (turret frame: origin on the hull roof at z = offZ) over the
// part of a lofted hull that stands above the roof line — the SU-100's
// casemate. Triangles are clipped at the roof plane, so a sloping side plate
// counts from where it crosses the roof, not only from its top corners.
function casemateBounds(loft, roofY, offZ, box) {
  const pos = loft.attributes.position;
  const v = new THREE.Vector3();
  const put = (x, y, z) => box.expandByPoint(v.set(x, y - roofY, z - offZ));
  // strictly above: the engine deck lies exactly ON the roof line and is hull
  const cut = roofY + 0.002;
  for (let t = 0; t + 2 < pos.count; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = t + e;
      const b = t + (e + 1) % 3;
      const ay = pos.getY(a);
      const by = pos.getY(b);
      if (ay > cut) put(pos.getX(a), ay, pos.getZ(a));
      if ((ay - cut) * (by - cut) < 0) {
        const u = (cut - ay) / (by - ay);
        put(
          pos.getX(a) + (pos.getX(b) - pos.getX(a)) * u,
          roofY,
          pos.getZ(a) + (pos.getZ(b) - pos.getZ(a)) * u,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// running gear
// ---------------------------------------------------------------------------

// A road wheel is not a bare ten-sided cylinder: it is a rubber tyre on a
// pressed steel rim with a hub cap and a bolt circle, and at sniper zoom that
// is the whole difference between running gear and a row of oil drums. The tyre
// goes in the track bucket because it is the same rubber the track is.
// The tyre's outline is what a player reads at range, so it keeps its sixteen
// sides; the bolt circle inside it is not, so small wheels are given none at
// all and the rest get six three-sided studs. That is the trade this whole
// pass is about — silhouette first, and detail nobody can see deleted.
// The tyre is rubber (V-11: worn #3a3a38, roughness .8) in its own bin; the
// rim, hub and bolts wear the vehicle's paint like the real pressed wheel.
function roadWheel(bins, x, y, z, r, width, bolts = 6) {
  const T = (g) => addSpin(bins.wheelTyre, g, y, z, r);
  const G = (g) => addSpin(bins.wheelGear, g, y, z, r);
  T(tubeX(r, r, width, 16, x, y, z));
  G(tubeX(r * 0.80, r * 0.80, width * 1.14, 12, x, y, z));
  G(tubeX(r * 0.26, r * 0.26, width * 1.42, 8, x, y, z));
  const br = r * 0.52;
  for (let i = 0; i < bolts; i++) {
    const a = (i / bolts) * Math.PI * 2;
    G(tubeX(
      r * 0.055, r * 0.055, width * 1.5, 3,
      x, y + Math.sin(a) * br, z + Math.cos(a) * br,
    ));
  }
}

// The drive sprocket is the one wheel a player can name, and it is a toothed
// ring rather than a disc. The teeth are what the track visibly rides on.
function sprocketWheel(bins, x, y, z, r, width, style) {
  const G = (g) => addSpin(bins.wheelGear, g, y, z, r);
  G(tubeX(r * 0.78, r * 0.78, width, 16, x, y, z));
  G(tubeX(r * 0.30, r * 0.30, width * 1.4, 10, x, y, z));
  if (style === 'roller') {
    // Soviet roller-type sprocket: six rollers on a plain disc, not teeth.
    // The cheapest identity win either T-34-family vehicle has — it is visible
    // in profile and from behind, and it costs fewer triangles than the boxes.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      G(tubeX(
        r * 0.19, r * 0.19, width * 1.05, 6,
        x, y + Math.sin(a) * r * 0.80, z + Math.cos(a) * r * 0.80,
      ));
    }
    return;
  }
  const teeth = 14;
  for (let i = 0; i < teeth; i++) {
    const g = new THREE.BoxGeometry(width * 0.76, r * 0.34, r * 0.22);
    g.translate(0, r * 0.88, 0);
    g.rotateX((i / teeth) * Math.PI * 2);
    G(g.translate(x, y, z));
  }
}

function rollerWheel(bins, x, y, z, r, width) {
  const T = (g) => addSpin(bins.wheelTyre, g, y, z, r);
  const G = (g) => addSpin(bins.wheelGear, g, y, z, r);
  T(tubeX(r, r, width, 12, x, y, z));
  G(tubeX(r * 0.44, r * 0.44, width * 1.35, 6, x, y, z));
}

// ---------------------------------------------------------------------------
// hull deck geometry
// ---------------------------------------------------------------------------

// Roof height and half-width at a station-space z, so deck furniture sits ON
// the hull instead of hovering above it. Stations run front (+Z) to back (-Z),
// and pts[3] is the [halfWidth, height] of the roof corner.
function roofAt(stations, z) {
  const first = stations[0];
  const last = stations[stations.length - 1];
  if (z >= first.z) return { y: first.pts[3][1], hw: first.pts[3][0] };
  if (z <= last.z) return { y: last.pts[3][1], hw: last.pts[3][0] };
  for (let i = 0; i < stations.length - 1; i++) {
    const A = stations[i];
    const B = stations[i + 1];
    if (z <= A.z && z >= B.z) {
      const u = (A.z - z) / Math.max(1e-6, A.z - B.z);
      return {
        y: A.pts[3][1] + (B.pts[3][1] - A.pts[3][1]) * u,
        hw: A.pts[3][0] + (B.pts[3][0] - A.pts[3][0]) * u,
      };
    }
  }
  return { y: last.pts[3][1], hw: last.pts[3][0] };
}

// Weld beads down one corner of the lofted hull. Following the stations rather
// than a straight line means the bead bends where the plate does, which is the
// only reason it reads as a weld and not as a pipe strapped to the side.
function weldBead(bins, stations, idx, radius) {
  for (let s = 0; s < stations.length - 1; s++) {
    const A = stations[s];
    const B = stations[s + 1];
    const g = barBetween(
      A.pts[idx][0], A.pts[idx][1], A.z,
      B.pts[idx][0], B.pts[idx][1], B.z,
      radius,
    );
    if (g) add(bins.hullArmour, g);
  }
}

// A louvred engine deck. Six slats over a shallow recessed frame: the deck was
// a bare quad before, and it is the part of a tank a player looks straight down
// on for the whole of a hull-down fight.
function engineDeck(bins, stations, w, len) {
  const cz = -len * 0.26;
  const seat = roofAt(stations, cz);
  const hw = Math.min(w * 0.26, seat.hw * 0.78);
  const hl = len * 0.075;
  add(bins.hullArmour, boxAt(hw * 2, 0.08, hl * 2, 0, seat.y - 0.005, cz));
  for (let i = 0; i < 6; i++) {
    const gz = cz + (i / 5 - 0.5) * hl * 1.7;
    const slat = new THREE.BoxGeometry(hw * 1.82, 0.075, 0.05);
    slat.rotateX(0.55);
    add(bins.hullSteel, slat.translate(0, seat.y + 0.05, gz));
  }
  // the mesh frame around the louvres
  for (const sx of [-1, 1]) {
    add(bins.hullSteel, boxAt(0.05, 0.06, hl * 1.9, sx * hw * 0.95, seat.y + 0.04, cz));
  }
}

// Exhaust, cut to the CHASSIS rather than the nation. 'Germany' used to mean
// two upright stacks, which is Tiger practice — a Panzer IV hull carries one
// large transverse muffler can slung low across the rear plate instead, and
// the Wirbelwind inherits it.
// Mufflers and stacks go in the bare-metal bin: heat burns the paint off them
// and leaves the rust orange-brown of bible 5.3 Z5.
function exhaust(bins, spec, w, len, fenderY) {
  const kind = spec.shape.hull;
  const zBack = -len / 2 + 0.06;
  const y = fenderY + 0.12;
  if (kind === 'slab') {
    for (const sx of [-1, 1]) {
      add(bins.hullBare, tubeY(0.09, 0.11, 0.62, 12, sx * w * 0.3, y + 0.2, zBack));
      add(bins.hullBare, tubeY(0.13, 0.13, 0.08, 12, sx * w * 0.3, y + 0.53, zBack));
    }
    return;
  }
  if (kind === 'panzer4') {
    add(bins.hullBare, tubeX(0.13, 0.13, w * 0.55, 12, 0, fenderY + 0.02, zBack - 0.1));
    add(bins.hullBare, tubeX(0.07, 0.07, w * 0.18, 10, w * 0.32, fenderY + 0.02, zBack - 0.1));
    return;
  }
  if (spec.nation === 'USSR') {
    for (const sx of [-1, 1]) {
      add(bins.hullBare, tubeZ(0.085, 0.1, 0.34, 12, sx * w * 0.26, y, zBack - 0.1));
    }
    return;
  }
  add(bins.hullBare, tubeX(0.11, 0.11, w * 0.52, 12, 0, fenderY + 0.06, zBack - 0.02));
  for (const sx of [-1, 1]) {
    add(bins.hullBare, tubeZ(0.06, 0.06, 0.3, 8, sx * w * 0.2, fenderY + 0.06, zBack - 0.2));
  }
}

// Where the hull's roof line crosses a given height, searching from the nose.
// Front-plate furniture — the hull MG ball, a driver's hatch, spare track on a
// glacis shelf — has to lie IN the plate, and the plate's angle now varies
// from vehicle to vehicle, so it cannot be a fixed fraction of hull height.
// The sponson-floor height the station table actually settled on. Read from
// the middle of the hull, where it is the real one rather than a nose taper.
function ySpOf(stations) {
  return stations[Math.floor(stations.length / 2)].pts[2][1];
}

// The height of the near-horizontal shelf in a stepped bow: the roof line just
// below its steepest rise. That is where a Tiger stows its spare track.
function noseShelfY(stations) {
  let best = 0;
  let y = stations[0].pts[3][1];
  for (let i = 0; i < stations.length - 1; i++) {
    const d = stations[i + 1].pts[3][1] - stations[i].pts[3][1];
    if (d > best) { best = d; y = stations[i].pts[3][1]; }
  }
  return y;
}

function noseZAt(stations, y) {
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i].pts[3];
    const b = stations[i + 1].pts[3];
    if ((a[1] - y) * (b[1] - y) <= 0 && Math.abs(b[1] - a[1]) > 1e-6) {
      const u = (y - a[1]) / (b[1] - a[1]);
      return stations[i].z + (stations[i + 1].z - stations[i].z) * u;
    }
  }
  return stations[0].z;
}

// ---------------------------------------------------------------------------
// turret shells
// ---------------------------------------------------------------------------
// An OPEN-TOPPED tub: an outer shell, an inner shell and a rim ring so the
// plate edge is visible over the top. `openFront` leaves two rectangular
// openings cut in the upper half of the facet that faces forward, either side
// of a centre pillar — which is how a Flakvierling's barrels get out and what
// makes the front of a Wirbelwind unmistakable.
function tubShell(plan, bands, wallT, openFront) {
  const p = planArea(plan) > 0 ? [...plan].reverse() : plan;
  const n = p.length;
  const shrink = (pts, t) => pts.map(([x, z]) => {
    const L = Math.hypot(x, z) || 1e-6;
    return [x - (x / L) * t, z - (z / L) * t];
  });
  const lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  let front = 0;
  let bestZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const z = (p[i][1] + p[(i + 1) % n][1]) / 2;
    if (z > bestZ) { bestZ = z; front = i; }
  }
  const v = [];
  const quad = (a, ay, b, by, c, cy, d, dy) => {
    v.push(a[0], ay, a[1], b[0], by, b[1], c[0], cy, c[1]);
    v.push(a[0], ay, a[1], c[0], cy, c[1], d[0], dy, d[1]);
  };
  let outer = p;
  let inner = shrink(p, wallT);
  let y = 0;
  for (let bi = 0; bi < bands.length; bi++) {
    const b = bands[bi];
    const yT = y + b.h;
    const outerTop = outer.map(([x, z]) => [x * b.scale, z * b.scale]);
    const innerTop = shrink(outerTop, wallT);
    const last = bi === bands.length - 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // the openings run from just above the sill band to the rim
      const cut = openFront && i === front && bi > 0;
      // the two apertures sit where the barrel columns actually are, near the
      // outer thirds of the plate, either side of a broad central web
      const spans = cut ? [[0, 0.05], [0.29, 0.71], [0.95, 1]] : [[0, 1]];
      for (const [u0, u1] of spans) {
        const a = lerp(outer[i], outer[j], u0);
        const b2 = lerp(outer[i], outer[j], u1);
        const c = lerp(outerTop[i], outerTop[j], u1);
        const d = lerp(outerTop[i], outerTop[j], u0);
        quad(a, y, b2, y, c, yT, d, yT);
        const ai = lerp(inner[i], inner[j], u0);
        const bi2 = lerp(inner[i], inner[j], u1);
        const ci = lerp(innerTop[i], innerTop[j], u1);
        const di = lerp(innerTop[i], innerTop[j], u0);
        quad(ai, y, di, yT, ci, yT, bi2, y);
      }
    }
    outer = outerTop;
    inner = innerTop;
    y = yT;
  }
  for (let i = 0; i < n; i++) {
    if (openFront && i === front) continue;
    const j = (i + 1) % n;
    quad(outer[i], y, inner[i], y, inner[j], y, outer[j], y);
    quad(outer[j], y, inner[j], y, inner[i], y, outer[i], y);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

function turretShell(spec, bins) {
  const t = spec.turret;
  const hw = t.w / 2;
  const hl = t.len / 2;
  const kind = spec.shape.turret;
  const cast = spec.shape.cast ? bins.turCast : bins.turArmour;

  if (kind === 'hexCast') {
    // T-34-85: a CASTING on a 1.60m ring, and the ring axis is NOT the plan
    // centre — 1.10m of it lies ahead of the axis and 1.35m behind, so the
    // bustle hangs back over the engine deck. That overhang is the most
    // identifiable thing about the tank from any three-quarter angle, and a
    // shell built symmetrically about its own rotation axis cannot make one.
    // The rings bulge at the cheeks and pull back in under the roof; eight
    // hard facets and a normal map is the case where the geometry is wrong
    // and the shading is being asked to cover for it.
    const zF = 1.10;
    const zB = -1.35;
    const plan = smoothClosed([
      [0, zF], [hw * 0.70, zF * 0.52], [hw, -0.25], [hw * 0.95, zB * 0.70],
      [hw * 0.89, zB], [-hw * 0.89, zB], [-hw * 0.95, zB * 0.70],
      [-hw, -0.25], [-hw * 0.70, zF * 0.52],
    ], 1);
    add(cast, loftYRings([
      { y: 0, pts: insetPlan(plan, 0.05, 0.04, 0.04) },
      { y: t.h * 0.34, pts: plan },
      { y: t.h * 0.72, pts: insetPlan(plan, 0.18, 0.13, 0.09) },
      { y: t.h, pts: insetPlan(plan, 0.33, 0.28, 0.24) },
    ]));
    return;
  }
  if (kind === 'horseshoe') {
    // Tiger: one 82mm plate bent around — a rounded front, flat parallel
    // VERTICAL sides (82mm at 0 degrees, so no taper at all) and a flat
    // full-width rear plate. No bustle of any kind.
    const pts = [
      [0, hl], [hw * 0.44, hl * 0.95], [hw * 0.78, hl * 0.80], [hw * 0.96, hl * 0.46],
      [hw, hl * 0.08], [hw, -hl * 0.6], [hw * 0.99, -hl],
      [-hw * 0.99, -hl], [-hw, -hl * 0.6], [-hw, hl * 0.08],
      [-hw * 0.96, hl * 0.46], [-hw * 0.78, hl * 0.80], [-hw * 0.44, hl * 0.95],
    ];
    add(bins.turArmour, prismY(pts, t.h, 1.0));
    return;
  }
  if (kind === 'castOval') {
    // M26: a rounded nose wrapped around the mantlet, sides bulging just aft
    // of the trunnions, then near-parallel back into a FULL-WIDTH bustle
    // closed by a flat rear plate. The bustle is the rear third of the same
    // casting, not a narrower box hung off the back, and the sides lay at
    // only 5-8 degrees — a 22% taper turns the whole turret into a cone.
    const zF = 1.30;
    const zB = -1.60;
    const plan = smoothClosed([
      [0, zF], [hw * 0.60, zF * 0.80], [hw, zF * 0.16], [hw, zB * 0.55],
      [hw * 0.94, zB], [-hw * 0.94, zB], [-hw, zB * 0.55],
      [-hw, zF * 0.16], [-hw * 0.60, zF * 0.80],
    ], 1);
    add(cast, loftYRings([
      { y: 0, pts: insetPlan(plan, 0.06, 0.05, 0.05) },
      { y: t.h * 0.38, pts: plan },
      { y: t.h * 0.78, pts: insetPlan(plan, 0.09, 0.08, 0.07) },
      { y: t.h, pts: insetPlan(plan, 0.14, 0.14, 0.11) },
    ]));
    return;
  }
  if (kind === 'casemate') {
    // SU-100: nothing to build here. The fixed superstructure is lofted into
    // the HULL stations as one continuous 50-degree sweep, which is both the
    // right shape and the fix for a casemate that used to swing 8.6 degrees
    // with the gun because it was parented to the traverse frame.
    return;
  }
  if (kind === 'flakTub') {
    // Wirbelwind: the 'Keksdose'. Nine-sided, OPEN TOP, and every facet is two
    // plates — the lower leaning outward, the upper leaning back in — so the
    // tub is widest at a belt halfway up and narrower again at the rim. The
    // plan is rotated half a facet to put a flat PLATE forward instead of a
    // vertex, and stretched BEHIND the ring rather than in front of it.
    // Nine facets, hand-placed rather than a regular n-gon: the front plate
    // has to be wide enough to carry both barrel apertures at their real
    // 0.674m spacing, and the mass has to sit BEHIND the ring. At the belt
    // this is 1.98m wide, 0.95m ahead of the ring and 1.35m behind it, with a
    // 1.0m flat front plate and a flat rear.
    const plan = [
      [hw * 0.44, hl * 0.722],                        // flat front plate, right end
      [hw * 0.82, hl * 0.400], [hw * 0.87, -hl * 0.220], [hw * 0.60, -hl * 0.820],
      [0, -hl * 1.026],                               // the extended rear
      [-hw * 0.60, -hl * 0.820], [-hw * 0.87, -hl * 0.220], [-hw * 0.82, hl * 0.400],
      [-hw * 0.44, hl * 0.722],                       // flat front plate, left end
    ];
    add(bins.turArmour, tubShell(
      plan,
      [
        { h: t.h * 0.16, scale: 1.05 },   // solid sill below the openings
        { h: t.h * 0.34, scale: 1.086 },  // lower plate, leaning OUT to the belt
        { h: t.h * 0.50, scale: 0.88 },   // upper plate, leaning back IN to the rim
      ],
      0.032, true,
    ));
    // the tub floor — there is no turret basket, so this is all there is
    add(bins.turSteel, boxAt(t.w * 0.72, 0.07, t.len * 0.62, 0, 0.035, -0.1));
    return;
  }
  if (kind === 'horseshoeSmall') {
    // M3 Stuart: a welded HORSESHOE — one continuous curve around the front
    // and both sides closed by a flat rear, on a 1.187m ring, with walls that
    // stand essentially VERTICAL. It is not an octagon and it does not have a
    // vertex pointing forward.
    const arc = 8;
    const zc = hl - hw;
    const pts = [];
    for (let i = 0; i <= arc; i++) {
      const a = -Math.PI / 2 + (i / arc) * Math.PI;
      pts.push([Math.sin(a) * hw, zc + Math.cos(a) * hw]);
    }
    pts.push([hw * 0.98, -hl], [-hw * 0.98, -hl]);
    add(bins.turArmour, prismY(pts, t.h, 0.97));
    return;
  }
  add(bins.turArmour, prismY(ovalPts(hw, hl, 10, 1.04), t.h, 0.9));
}

// ---------------------------------------------------------------------------
// geometry build, and the cache in front of it
// ---------------------------------------------------------------------------
//
// tankEntity.js builds a fresh mesh for every spawn, so eleven tanks used to
// mean eleven complete sets of geometry. Nothing about the geometry depends on
// the colours, so it is built once per distinct set of geometric inputs and
// every later caller gets meshes that share it.
//
// The key is a signature rather than the spec object, deliberately: mods.js
// hands the player a structuredClone of the spec on every spawn, so a WeakMap
// keyed on identity would miss every single time. Nothing in applyMods touches
// hull, turret, chassis, shape or gunLen, so specs that differ only in their
// gameplay numbers collapse onto one entry, and any spec that ever did move a
// dimension would correctly get its own.
const geoCache = new Map();
let beltIds = 0;

function geoKeyFor(spec) {
  return JSON.stringify([
    spec.id, spec.hull, spec.turret, spec.chassis, spec.shape,
    spec.gunLen, spec.shells && spec.shells.AP ? spec.shells.AP.caliber : 0,
    spec.markings || null,
  ]);
}

// ---------------------------------------------------------------------------
// V-09 markings and V-08 vision glass
// ---------------------------------------------------------------------------
// Every marking is a decal: a small grid of vertices, each ray-cast onto the
// plate it is painted on and lifted 2 mm off it, so a star follows a sloped
// T-34 flank or a cast Pershing turret instead of floating as a flat card.
// They are drawn with one alpha-tested, lit, matt material
// (core/materials.js markingsMaterial) into one mesh per frame (hull,
// turret), which is what replaced the unlit team stripes: friend and foe are
// told apart by the HUD markers (H-06), never by paint on the model (V-02).
// The armoured glass of the vision blocks and periscopes rides in the same
// mesh: a glossy near-colourless pane over the block's dark interior.
const MARK_LIFT = 0.003;
const markTint = (hex, glyphHex = MARK_WHITE) => {
  const a = hexToLinear(hex);
  const b = hexToLinear(glyphHex);
  return [a[0] / b[0], a[1] / b[1], a[2] / b[2]];
};

// one glass pane on the outward face of a vision block (an axis-aligned box)
function visionGlass(list, cx, cy, cz, bw, bh, bd, ox, oz, off) {
  const quad = [];
  const ax = Math.abs(ox) >= Math.abs(oz);
  const s = ax ? Math.sign(ox) || 1 : Math.sign(oz) || 1;
  const hw = (ax ? bd : bw) * 0.4;
  const hh = bh * 0.3;
  const o = off || [0, 0, 0];
  if (ax) {
    const x = cx + s * (bw / 2 + 0.0015);
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) quad.push([x + o[0], cy + v * hh + o[1], cz + u * hw * s + o[2]]);
    list.push({ quad, n: [s, 0, 0] });
  } else {
    const z = cz + s * (bd / 2 + 0.0015);
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) quad.push([cx - u * hw * s + o[0], cy + v * hh + o[1], z + o[2]]);
    list.push({ quad, n: [0, 0, s] });
  }
}

// candidate triangles of the plates a decal may land on: facing the ray and
// inside the decal's footprint (plus a margin)
function trianglesFor(geos, dir, axes, lo, hi) {
  const out = [];
  const [a0, a1] = axes;
  for (const g of geos) {
    if (!g) continue;
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 9) {
      const ux = p[i + 3] - p[i]; const uy = p[i + 4] - p[i + 1]; const uz = p[i + 5] - p[i + 2];
      const vx = p[i + 6] - p[i]; const vy = p[i + 7] - p[i + 1]; const vz = p[i + 8] - p[i + 2];
      let nx = uy * vz - uz * vy; let ny = uz * vx - ux * vz; let nz = ux * vy - uy * vx;
      const L = Math.hypot(nx, ny, nz);
      if (L < 1e-12) continue;
      nx /= L; ny /= L; nz /= L;
      // anything not edge-on to the ray, either winding (the lofts are not all
      // wound alike): a cast turret's undercut is steep but still the plate
      const f = -(nx * dir[0] + ny * dir[1] + nz * dir[2]);
      if (Math.abs(f) < 0.02) continue;
      let in0 = false;
      let mn0 = Infinity; let mx0 = -Infinity; let mn1 = Infinity; let mx1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const c0 = p[i + k * 3 + a0];
        const c1 = p[i + k * 3 + a1];
        mn0 = Math.min(mn0, c0); mx0 = Math.max(mx0, c0); mn1 = Math.min(mn1, c1); mx1 = Math.max(mx1, c1);
      }
      in0 = mx0 >= lo[0] && mn0 <= hi[0] && mx1 >= lo[1] && mn1 <= hi[1];
      if (!in0) continue;
      out.push(p.subarray(i, i + 9));
    }
  }
  return out;
}

// Moller-Trumbore, nearest hit along +t; returns [t, nx, ny, nz] or null
function castOn(tris, o, d) {
  let best = null;
  for (const p of tris) {
    const e1x = p[3] - p[0]; const e1y = p[4] - p[1]; const e1z = p[5] - p[2];
    const e2x = p[6] - p[0]; const e2y = p[7] - p[1]; const e2z = p[8] - p[2];
    const px = d[1] * e2z - d[2] * e2y; const py = d[2] * e2x - d[0] * e2z; const pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = o[0] - p[0]; const ty = o[1] - p[1]; const tz = o[2] - p[2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y; const qy = tz * e1x - tx * e1z; const qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t <= 0 || (best && t >= best[0])) continue;
    let nx = e1y * e2z - e1z * e2y; let ny = e1z * e2x - e1x * e2z; let nz = e1x * e2y - e1y * e2x;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    // face the normal back toward the ray origin
    if (nx * d[0] + ny * d[1] + nz * d[2] > 0) { nx = -nx; ny = -ny; nz = -nz; }
    best = [t, nx, ny, nz];
  }
  return best;
}

// One conformed decal. side 'left' (+X, read from the left: glyph right = aft),
// 'right' (-X: glyph right = forward) or 'top' (read from above, nose up).
function decalOn(out, geos, side, c, w, h, rect, tint, rough) {
  // dense enough that a flat facet between two samples on a cast turret
  // stays inside the lift (sagitta < 2 mm at a 0.5 m radius), along a long
  // thin decal (a roof cross arm) as well as across a square one
  const NU = Math.max(5, Math.min(41, Math.ceil(w / 0.03) + 1));
  const NV = Math.max(4, Math.min(41, Math.ceil(h / 0.03) + 1));
  let dir;
  let axes;
  let at;
  if (side === 'left' || side === 'right') {
    const s = side === 'left' ? 1 : -1;
    dir = [-s, 0, 0];
    axes = [2, 1];
    at = (su, tv) => [s * 30, c.y + (tv - 0.5) * h, c.z - s * (su - 0.5) * w];
  } else {
    dir = [0, -1, 0];
    axes = [0, 2];
    at = (su, tv) => [c.x - (su - 0.5) * w, 30, c.z + (tv - 0.5) * h];
  }
  const p0 = at(0, 0);
  const p1 = at(1, 1);
  const m = 0.06;
  const lo = [Math.min(p0[axes[0]], p1[axes[0]]) - m, Math.min(p0[axes[1]], p1[axes[1]]) - m];
  const hi = [Math.max(p0[axes[0]], p1[axes[0]]) + m, Math.max(p0[axes[1]], p1[axes[1]]) + m];
  const tris = trianglesFor(geos, dir, axes, lo, hi);
  if (!tris.length) return 0;
  const grid = [];
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const su = i / (NU - 1);
      const tv = j / (NV - 1);
      const o = at(su, tv);
      const hit = castOn(tris, o, dir);
      grid.push(hit ? {
        p: [o[0] + dir[0] * hit[0] + hit[1] * MARK_LIFT, o[1] + dir[1] * hit[0] + hit[2] * MARK_LIFT, o[2] + dir[2] * hit[0] + hit[3] * MARK_LIFT],
        n: [hit[1], hit[2], hit[3]],
        uv: [rect.u0 + su * (rect.u1 - rect.u0), rect.v0 + tv * (rect.v1 - rect.v0)],
      } : null);
    }
  }
  // Paint follows a plate, it never climbs a wall: two neighbouring samples
  // whose depth along the ray differs by more than a steep plate's slope over
  // the sample spacing (a flank: about 68 degrees off the projection plane,
  // for sloped and cast armour; a roof: about 30 degrees, roofs being flat),
  // plus 2 cm for a weld, are on different things — the roof and a cupola or
  // a hatch lid, a skirt plate and the hull behind its gap — and the decal
  // ends there rather than bridging the step. A lid gets its own piece of
  // the marking, flat on top, with its rim left unpainted.
  const du = w / (NU - 1);
  const dv = h / (NV - 1);
  const slope = side === 'top' ? 0.6 : 2.5;
  const depth = (q) => q.p[0] * dir[0] + q.p[1] * dir[1] + q.p[2] * dir[2];
  const near = (a, b, step) => Math.abs(depth(a) - depth(b)) <= 0.02 + slope * step;
  let quads = 0;
  for (let j = 0; j < NV - 1; j++) {
    for (let i = 0; i < NU - 1; i++) {
      const a = grid[j * NU + i];
      const b = grid[j * NU + i + 1];
      const cc = grid[(j + 1) * NU + i + 1];
      const d = grid[(j + 1) * NU + i];
      if (!a || !b || !cc || !d) continue;
      if (!near(a, b, du) || !near(d, cc, du) || !near(a, d, dv) || !near(b, cc, dv)) continue;
      // wind each triangle to face along its own normal
      for (const tri of [[a, b, cc], [a, cc, d]]) {
        const [q0, q1, q2] = tri;
        const ux = q1.p[0] - q0.p[0]; const uy = q1.p[1] - q0.p[1]; const uz = q1.p[2] - q0.p[2];
        const vx = q2.p[0] - q0.p[0]; const vy = q2.p[1] - q0.p[1]; const vz = q2.p[2] - q0.p[2];
        const fx = uy * vz - uz * vy; const fy = uz * vx - ux * vz; const fz = ux * vy - uy * vx;
        const ord = fx * q0.n[0] + fy * q0.n[1] + fz * q0.n[2] >= 0 ? tri : [q0, q2, q1];
        for (const q of ord) out.push({ p: q.p, n: q.n, uv: q.uv, tint, rough });
      }
      quads++;
    }
  }
  return quads;
}

// The digits of a tactical number laid along the flank, read left to right
// from whichever side the viewer stands.
function numberOn(out, geos, side, c, text, height, tint) {
  const atlas = insigniaAtlas();
  const r0 = atlas.rect('digit_0');
  const dw = height / r0.aspect;
  const pitch = dw * 0.86;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const rect = atlas.rect(`digit_${text[i]}`);
    if (!rect) continue;
    const off = (i - (n - 1) / 2) * pitch;
    const z = side === 'left' ? c.z - off : c.z + off;
    decalOn(out, geos, side, { y: c.y, z }, dw, height, rect, tint, INSIGNIA_ROUGHNESS);
  }
}

function marksGeometry(verts, glass) {
  const atlas = insigniaAtlas();
  const solid = atlas.rect('solid');
  const su = (solid.u0 + solid.u1) / 2;
  const sv = (solid.v0 + solid.v1) / 2;
  const gt = markTint(VISION_GLASS);
  for (const g of glass) {
    const q = g.quad;
    const ux = q[1][0] - q[0][0]; const uy = q[1][1] - q[0][1]; const uz = q[1][2] - q[0][2];
    const vx = q[2][0] - q[0][0]; const vy = q[2][1] - q[0][1]; const vz = q[2][2] - q[0][2];
    const f = (uy * vz - uz * vy) * g.n[0] + (uz * vx - ux * vz) * g.n[1] + (ux * vy - uy * vx) * g.n[2];
    const order = f >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (const k of order) verts.push({ p: q[k], n: g.n, uv: [su, sv], tint: gt, rough: 0.06 });
  }
  if (!verts.length) return null;
  const n = verts.length;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const col = new Float32Array(n * 3);
  const rgh = new Float32Array(n);
  verts.forEach((v, i) => {
    pos.set(v.p, i * 3);
    nrm.set(v.n, i * 3);
    uv.set(v.uv, i * 2);
    col.set(v.tint, i * 3);
    rgh[i] = v.rough;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aMkUv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aMkRgh', new THREE.BufferAttribute(rgh, 1));
  g.computeBoundingSphere();
  return g;
}

// A decal is paint on a plate, so it is drawn only while it wears its own
// material — or that material's burnt twin (tankEntity wreckMaterial stamps
// userData.wreckOf), where it shows as soot. The hangar X-ray film, the
// protection model and the battle's hit-cam ghost re-dress every mesh of the
// group in their own materials and outline each with its edges; a decal there
// is a stack of rectangles floating 3 mm off the armour, so it steps out of
// those views by itself (and its edge lines with it: they are its children).
function decalVisibility(mesh, own) {
  let shown = true;
  Object.defineProperty(mesh, 'visible', {
    configurable: true,
    enumerable: true,
    get() {
      const m = mesh.material;
      return shown && (m === own || !!(m && m.userData && m.userData.wreckOf === own.uuid));
    },
    set(v) {
      shown = !!v;
    },
  });
}

// Lay the spec's markings onto the sealed armour, one marks buffer per frame.
function attachMarks(spec, sealed, glass) {
  const atlas = insigniaAtlas();
  const verts = { hull: [], turret: [] };
  const geosOf = {
    hull: [sealed.hullArmour],
    turret: [sealed.turArmour, sealed.turCast],
  };
  // A roof marking is brushed over the hatch lids and fittings it crosses
  // (the step rule in decalOn still stops it at a cupola wall); a flank
  // marking stays on the plate, under any stowage hung in front of it.
  const roofGeosOf = {
    hull: [sealed.hullArmour, sealed.hullSteel],
    turret: [sealed.turArmour, sealed.turCast, sealed.turSteel],
  };
  for (const m of spec.markings || []) {
    const frame = m.frame === 'turret' ? 'turret' : 'hull';
    const sides = m.side === 'both' ? ['left', 'right'] : [m.side || 'left'];
    for (const side of sides) {
      const geos = side === 'top' ? roofGeosOf[frame] : geosOf[frame];
      if (m.number) {
        numberOn(verts[frame], geos, side, { y: m.y, z: m.z }, String(m.number), m.height, markTint(m.color != null ? m.color : MARK_WHITE));
        continue;
      }
      const rect = atlas.rect(m.glyph);
      if (!rect) continue;
      const [w, h] = Array.isArray(m.size) ? m.size : [m.size, m.size * rect.aspect];
      const tint = m.color != null ? markTint(m.color) : [1, 1, 1];
      const c = side === 'top' ? { x: m.x || 0, z: m.z } : { y: m.y, z: m.z };
      decalOn(verts[frame], geos, side, c, w, h, rect, tint, INSIGNIA_ROUGHNESS);
    }
  }
  sealed.hullMarks = marksGeometry(verts.hull, glass.hull);
  sealed.turMarks = marksGeometry(verts.turret, glass.turret);
}

function buildTankGeometry(spec) {
  const { w, h, len, trackH } = spec.hull;
  const t = spec.turret;
  const ch = spec.chassis;
  const sh = spec.shape;
  const bins = newBins();
  const xTrack = w / 2 - ch.trackW / 2;
  const stations = hullStations(spec);
  const roofY = trackH + h;
  const bandTop = trackRunTop(ch);
  // V-08: the vision-block and periscope glass, per frame (attachMarks)
  const glassAt = { hull: [], turret: [] };

  // ---- running gear: wheels first, then the track wrapped around them ----
  const roadZ = roadZs(ch.road);
  for (const side of [-1, 1]) {
    const sx = side * xTrack;
    sprocketWheel(
      bins, sx, ch.sprocket.y, ch.sprocket.z, ch.sprocket.r,
      ch.trackW * 0.72, ch.sprocket.style,
    );
    roadWheel(
      bins, sx, ch.idler.y, ch.idler.z, ch.idler.r, ch.trackW * 0.7,
      ch.idler.r >= 0.3 ? 6 : 0,
    );
    const rd = ch.road;
    // Interleaved wheels have to be offset in X, in two overlapping planes.
    // Varying only their WIDTH — which is what this used to do — is invisible
    // in side view, and side view is the only reason a Schachtellaufwerk
    // exists: what a player recognises is a dense wall of discs with no
    // daylight in it, and that needs real inboard/outboard rows.
    const rows = ch.interleave || null;
    for (let i = 0; i < roadZ.length; i++) {
      const row = rows ? rows[i % rows.length] : 0;
      const width = rows ? ch.trackW * 0.36 : ch.trackW * 0.8;
      // the inner row is behind the outer one and its bolt circle never shows
      const bolts = rows ? (row > 0 ? 6 : 0) : (rd.r >= 0.3 ? 6 : 0);
      roadWheel(bins, sx + side * ch.trackW * row, rd.y, roadZ[i], rd.r, width, bolts);
    }
    const ro = ch.rollers;
    for (const rz of spanZs(ro)) {
      rollerWheel(bins, sx, ro.y, rz, ro.r, ch.trackW * 0.5);
    }
    // One housing per declared PAIR, at the pair's midpoint — a bogie is two
    // wheels on one casting, so deriving positions from an even-spacing index
    // put the springs between the pairs instead of inside them.
    if (ch.bogies) {
      const leaf = ch.bogies === 'leaf';
      for (let i = 0; i + 1 < roadZ.length; i += 2) {
        const z = (roadZ[i] + roadZ[i + 1]) / 2;
        const span = Math.abs(roadZ[i] - roadZ[i + 1]);
        if (leaf) {
          // Panzer IV: a quarter-elliptic LEAF spring lying along the run.
          // The vertical spring stack below is American VVSS practice.
          add(bins.hullGear, boxAt(
            ch.trackW * 0.42, rd.r * 0.44, span + rd.r * 1.5,
            sx, rd.y + rd.r * 0.92, z,
          ));
          add(bins.hullGear, boxAt(
            ch.trackW * 0.22, rd.r * 0.24, span + rd.r * 2.1,
            sx + side * ch.trackW * 0.18, rd.y + rd.r * 1.18, z,
          ));
        } else {
          add(bins.hullGear, boxAt(
            ch.trackW * 0.5, rd.r * 1.5, span + rd.r * 1.2, sx, rd.y + rd.r * 0.55, z,
          ));
          // the volute spring stack itself, standing proud of the housing
          add(bins.hullGear, tubeY(
            rd.r * 0.34, rd.r * 0.34, rd.r * 1.1, 8,
            sx + side * ch.trackW * 0.22, rd.y + rd.r * 1.1, z,
          ));
        }
      }
    }
  }

  // the belt is laid along its own path so it can run (beltGeometry)
  const path = beltPath(ch);
  const band = beltGeometry(ch, ch.trackW, path);
  add(bins.trackBelt, band.clone().translate(-xTrack, 0, 0));
  add(bins.trackBelt, band.translate(xTrack, 0, 0));

  // What the armour LOOKS like, in each collision frame, so buildTankMesh can
  // grow the hit boxes over anything drawn outside them (a shell that visibly
  // strikes the Wirbelwind's rear overhang used to pass straight through).
  const drawn = { hull: new THREE.Box3(), turret: new THREE.Box3() };
  const grow = (box, geo) => {
    if (!geo) return geo;
    geo.computeBoundingBox();
    box.union(geo.boundingBox);
    return geo;
  };

  // ---- hull ----
  const hullLoft = loftHull(stations);
  grow(drawn.hull, hullLoft);
  add(bins.hullArmour, hullLoft);

  // weld beads down the sponson and roof corners: four seams that follow the
  // hull's own plan, so every facet of the loft gets an edge the light catches
  for (const idx of [2, 3, 4, 5]) weldBead(bins, stations, idx, 0.028);

  // Track guards. The height comes from the ACTUAL top of the track run, not
  // from trackH + a constant: on three of these vehicles the old constant put
  // the guard 50-200mm inside the belt, so the track visibly passed through
  // it, and the clean horizontal fender line above an unbroken run is what
  // separates 'hull' from 'running gear' in the silhouette.
  const fenderY = bandTop + 0.03;
  const fenderLen = sh.boxFenders ? len * 1.02 : len * 0.9;
  const lipDrop = sh.sandShields ? 0.3 : 0.13;
  for (const side of [-1, 1]) {
    add(bins.hullArmour, grow(drawn.hull, boxAt(
      ch.trackW * 1.12, 0.07, fenderLen, side * xTrack, fenderY, 0,
    )));
    // a lip down the outboard edge, which is what stops a fender reading as a
    // floating plank — and on the M26 it is a sandshield, so it hangs deeper
    add(bins.hullArmour, grow(drawn.hull, boxAt(
      0.05, lipDrop, fenderLen,
      side * (xTrack + ch.trackW * 0.53), fenderY - lipDrop * 0.32, 0,
    )));
  }

  engineDeck(bins, stations, w, len);
  exhaust(bins, spec, w, len, fenderY);

  // driver's periscope, seated on whatever the deck is doing at that station.
  // Local +Z is forward, so +X is the vehicle's LEFT — and every driver in
  // this roster sits on the left.
  const dz = Math.min(len * 0.5 - 0.55, t.offZ + t.len * 0.5 + 0.42);
  const dSeat = roofAt(stations, dz);
  add(bins.hullSteel, boxAt(0.16, 0.08, 0.12, w * 0.2, dSeat.y + 0.04, dz));
  add(bins.hullSteel, boxAt(0.19, 0.035, 0.05, w * 0.2, dSeat.y + 0.095, dz + 0.03));
  visionGlass(glassAt.hull, w * 0.2, dSeat.y + 0.04, dz, 0.16, 0.08, 0.12, 0, 1);

  // tow cable down one fender and the pioneer tools down the other: the
  // asymmetry is what real stowage looks like. The cable is bare, rusting wire.
  add(bins.hullBare, tubeZ(
    0.032, 0.032, len * 0.44, 8, -xTrack, fenderY + 0.07, len * 0.02,
  ));
  for (const dzTool of [len * 0.2, -len * 0.02]) {
    add(bins.hullMatt, boxAt(0.05, 0.045, 0.44, xTrack + 0.04, fenderY + 0.06, dzTool));
    add(bins.hullSteel, boxAt(0.12, 0.035, 0.2, xTrack + 0.04, fenderY + 0.06, dzTool - 0.3));
  }
  // grab handles on the nose
  for (const sx of [-1, 1]) {
    const gz = len * 0.42;
    const gSeat = roofAt(stations, gz);
    add(bins.hullSteel, barBetween(
      sx * w * 0.16, gSeat.y + 0.09, gz, sx * w * 0.30, gSeat.y + 0.09, gz, 0.022,
    ));
    for (const hx of [w * 0.16, w * 0.30]) {
      add(bins.hullSteel, boxAt(0.03, 0.09, 0.03, sx * hx, gSeat.y + 0.045, gz));
    }
  }

  // ---- turret ----
  const shellBin = spec.shape.cast ? bins.turCast : bins.turArmour;
  const shellFrom = shellBin.length;
  turretShell(spec, bins);
  for (let i = shellFrom; i < shellBin.length; i++) grow(drawn.turret, shellBin[i]);
  if (sh.turret === 'casemate') {
    // the SU-100's "turret" box sits over the casemate, which is lofted into
    // the hull: clip the hull loft at the roof line and measure what is above
    casemateBounds(hullLoft, roofY, t.offZ, drawn.turret);
  }

  // A FIXED casemate has no rotating roof. Its cupola, hatches and markings
  // are baked into hull space and go in the hull bins, so that the gun's
  // limited traverse reads as a gun moving inside a fixed aperture — which is
  // what it is — instead of swinging the whole superstructure with it.
  const fixed = sh.turret === 'casemate';
  const tArm = fixed ? bins.hullArmour : bins.turArmour;
  const tSte = fixed ? bins.hullSteel : bins.turSteel;
  const put = (bin, geo) => {
    if (!geo) return;
    add(bin, fixed ? geo.translate(0, roofY, t.offZ) : geo);
  };

  if (sh.cupolaLeft || sh.cupolaRight || sh.cupola) {
    const cu = sh.cupola || {};
    // +X is the vehicle's LEFT, because local +Z is forward (tankEntity's
    // forwardDir is (sin yaw, 0, cos yaw) in a right-handed Y-up frame). The
    // Tiger's commander sits left-rear, the M26's and the SU-100's right.
    const cs = sh.cupolaRight ? -1 : 1;
    const cr = cu.r ?? t.w * 0.19;
    const cHgt = cu.h ?? 0.3;
    const cx = cu.x ?? cs * t.w * 0.26;
    const cz = cu.z ?? -t.len * 0.28;
    const seg = cu.sides ?? 14;
    put(tArm, tubeY(cr, cr * 1.02, cHgt, seg, cx, t.h + cHgt / 2, cz));
    // the lid sits flush on the cupola roof, not proud of it
    put(tSte, tubeY(cr * 0.86, cr * 0.86, 0.04, seg, cx, t.h + cHgt - 0.02, cz));
    // the ring of vision blocks that makes a cupola a cupola
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      put(tSte, boxAt(
        0.07, 0.065, 0.055,
        cx + Math.sin(a) * cr * 1.02, t.h + cHgt * 0.62, cz + Math.cos(a) * cr * 1.02,
      ));
      visionGlass(
        fixed ? glassAt.hull : glassAt.turret,
        cx + Math.sin(a) * cr * 1.02, t.h + cHgt * 0.62, cz + Math.cos(a) * cr * 1.02,
        0.07, 0.065, 0.055, Math.sin(a), Math.cos(a), fixed ? [0, roofY, t.offZ] : null,
      );
    }
    // the SU-100's cupola sits in a blister that stands proud of the flank,
    // so head-on the right shoulder is visibly bulged out and up
    if (cu.blister) {
      put(tArm, boxAt(0.22, 0.40, 0.70, cu.blister, t.h - 0.26, cz));
    }
  }
  if (sh.loaderHatch) {
    const lh = sh.loaderHatch;
    put(tSte, tubeY(lh.r, lh.r, 0.06, 14, lh.x, t.h + 0.03, lh.z));
    put(tSte, barBetween(lh.x - 0.09, t.h + 0.09, lh.z, lh.x + 0.09, t.h + 0.09, lh.z, 0.02));
  }
  if (sh.roofDomes) {
    // the two mushroom ventilators on the centreline at the back of a 1944 roof
    for (const sx of [-1, 1]) {
      put(tSte, tubeY(0.1, 0.11, 0.06, 10, sx * 0.18, t.h + 0.03, -t.len * 0.39));
    }
  }
  if (!sh.openTurret && !sh.cupolaLeft && !sh.cupolaRight && !sh.cupola && !sh.loaderHatch) {
    put(tSte, tubeY(t.w * 0.16, t.w * 0.16, 0.07, 14, t.w * 0.2, t.h + 0.03, -t.len * 0.14));
  }

  if (!sh.openTurret) {
    for (const sx of [-1, 1]) {
      put(tSte, boxAt(0.15, 0.075, 0.11, sx * t.w * 0.28, t.h + 0.038, t.len * 0.2));
      put(tSte, boxAt(0.18, 0.035, 0.045, sx * t.w * 0.28, t.h + 0.09, t.len * 0.2 + 0.03));
      visionGlass(
        fixed ? glassAt.hull : glassAt.turret,
        sx * t.w * 0.28, t.h + 0.038, t.len * 0.2, 0.15, 0.075, 0.11, 0, 1,
        fixed ? [0, roofY, t.offZ] : null,
      );
    }
  }
  // grab handles on the turret flanks, for the tank riders nobody models.
  // A sloping casemate wall has no flank to hang them on, so it gets none.
  if (!fixed) {
    for (const sx of [-1, 1]) {
      const hx = sx * t.w * 0.46;
      add(bins.turSteel, barBetween(
        hx, t.h * 0.72, t.len * 0.2, hx, t.h * 0.72, -t.len * 0.02, 0.021,
      ));
      for (const hz of [t.len * 0.2, -t.len * 0.02]) {
        add(bins.turSteel, boxAt(0.06, 0.03, 0.03, sx * t.w * 0.44, t.h * 0.72, hz));
      }
    }
  }

  put(tSte, tubeY(0.03, 0.05, 0.12, 8, -t.w * 0.38, t.h + 0.06, -t.len * 0.3));
  const antenna = new THREE.CylinderGeometry(0.012, 0.018, 1.2, 6);
  antenna.rotateZ(0.12);
  put(tSte, antenna.translate(-t.w * 0.38, t.h + 0.6, -t.len * 0.3));

  // (The unlit team-colour stripes that used to be here are retired: friend
  // and foe are told apart by the HUD markers, H-06, and the model carries
  // its own nation's markings instead — attachMarks below, bible V-40.)

  // ---- gun ----
  if (sh.quadGun) {
    // Flakvierling 38: the four barrels are 0.674m apart HORIZONTALLY and
    // only 0.280m apart vertically — a wide flat rectangle, 2.4:1. Clustered
    // into a near-square the mount reads as one fat gun at any distance, and
    // that wide splay is the one thing that identifies the vehicle head-on.
    for (const bx of [-0.337, 0.337]) {
      for (const by of [-0.14, 0.14]) {
        // painted tube, then the bare sooted crown (V-03)
        barrelWithCrown(bins, 0.05, 0.042, spec.gunLen, 12, bx, by);
        // the perforated jacket over the breech end of each barrel
        add(bins.recSteel, tubeZ(0.062, 0.062, spec.gunLen * 0.22, 10, bx, by, 0.18));
      }
    }
    for (const bx of [-0.52, 0.52]) {
      add(bins.gunSteel, boxAt(0.16, 0.4, 0.24, bx, -0.02, 0.1));
    }
    add(bins.gunSteel, boxAt(0.5, 0.34, 0.6, 0, 0, -0.1));
  } else {
    // Barrel thickness sets the APPARENT length of the gun, and gun length is
    // the first thing read at range. The old expression gave the 88 a 217mm
    // tube against a real ~200mm at the trunnion and half again too much at
    // the muzzle, which is what made every gun on the roster look cartoonish.
    const rBase = (spec.shells.AP.caliber / 1000) * 0.78;
    // twenty sides, because a six-sided barrel reads as a hexagon down a scope.
    // Painted like the rest of the vehicle, except the last 0.3 m (V-03).
    barrelWithCrown(bins, rBase, rBase * 0.78, spec.gunLen, 20, 0, 0);
    // the recuperator sleeve over the breech end
    add(bins.recSteel, tubeZ(
      rBase * 1.22, rBase * 1.16, spec.gunLen * 0.2, 16, 0, 0, spec.gunLen * 0.1,
    ));

    // A double-baffle brake is a specifically GERMAN cue: putting one on an
    // M26 actively mis-identifies the vehicle, and wartime M26s carried the
    // 90mm M3 with the muzzle threads capped and no brake at all.
    // The brake is bare and sooted with the crown: blast and heat take the
    // paint off it first.
    if (sh.muzzleBrake) {
      const baffles = sh.muzzleBrake === 'single' ? [0.0] : [0.0, 0.22];
      const z0 = spec.gunLen - 0.5;
      for (const bz of baffles) {
        addCrown(bins, tubeZ(
          rBase * 1.55, rBase * 1.55, 0.15, 20, 0, 0, spec.gunLen - 0.4 + bz,
        ), z0, spec.gunLen);
        // the side ports the gas is thrown out of
        for (const sx of [-1, 1]) {
          addCrown(bins, boxAt(
            rBase * 0.7, rBase * 2.2, 0.1,
            sx * rBase * 1.5, 0, spec.gunLen - 0.4 + bz,
          ), z0, spec.gunLen);
        }
      }
    }
    // mantlet: a cast ball on the Soviet guns, a slab on the riveted turrets.
    // It is bolted to the cradle rather than the gun, so it stays put.
    if (sh.ballMantlet || sh.turret === 'hexCast' || sh.turret === 'castOval') {
      // absolute where a spec states one: a casemate's turret box is a thin
      // slab and scaling the mantlet off its height gives a pebble
      const ball = new THREE.SphereGeometry(sh.mantletR ?? t.h * 0.44, 18, 14);
      // Painted, not bare: a mantlet is cast steel that got the same coat of
      // paint as the turret. In gunSteel (metalness 0.85) it read as a black
      // ball bolted to a green turret.
      add(bins.gunArmour, ball.scale(1, 1, 1.2));
    } else {
      add(bins.gunArmour, boxAt(t.w * 0.44, t.h * 0.6, 0.34, 0, 0, 0));
      // the bolt ring around a slab shield
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        add(bins.gunSteel, tubeZ(
          0.028, 0.028, 0.06, 5,
          Math.sin(a) * t.w * 0.17, Math.cos(a) * t.h * 0.22, 0.18,
        ));
      }
    }
  }

  // ---- stowage and signature details ----
  const wSpon = w / 2 - ch.trackW * 0.06;
  // The M3's two forward-projecting driver/bow-gunner hoods. These are not a
  // greeble: they are the front of the tank, and without them a blunt stepped
  // bow reads as a plain plate.
  if (sh.driverHoods) {
    const hy = ySpOf(stations) + (roofY - ySpOf(stations)) * 0.5;
    const hz = noseZAt(stations, hy);
    for (const sx of [-1, 1]) {
      add(bins.hullArmour, boxAt(0.5, 0.34, 0.26, sx * 0.30, hy, hz + 0.11));
      add(bins.hullSteel, boxAt(0.34, 0.16, 0.05, sx * 0.30, hy + 0.02, hz + 0.245));
    }
  }
  // The M3's sponson guns are a symmetric PAIR of fixed .30 cal in the sponson
  // sides, close to the front plate — not one tube on the centre-right.
  if (sh.sponsonMg) {
    const sy = roofY - h * 0.5;
    const sz = noseZAt(stations, sy);
    for (const sx of [-1, 1]) {
      add(bins.hullSteel, tubeZ(0.04, 0.04, 0.4, 10, sx * (w / 2 - 0.22), sy, sz + 0.14));
    }
  }
  // hull MG ball, laid IN the front plate — and on the vehicle's RIGHT, where
  // the bow gunner sits, which is -X
  if (sh.bowMg) {
    const my = ySpOf(stations) + (roofY - ySpOf(stations)) * 0.45;
    const mz = noseZAt(stations, my);
    add(bins.hullArmour, tubeZ(0.15, 0.15, 0.16, 12, -w * 0.2, my, mz + 0.04));
    add(bins.hullSteel, tubeZ(0.05, 0.05, 0.44, 10, -w * 0.2, my, mz + 0.24));
  }
  // the T-34's big rectangular driver's hatch, on the LEFT of the glacis
  if (sh.glacisHatch) {
    const gy = ySpOf(stations) + (roofY - ySpOf(stations)) * 0.5;
    const gz = noseZAt(stations, gy);
    const plate = new THREE.BoxGeometry(0.5, 0.6, 0.07);
    plate.rotateX(-(spec.armor.hullSlope.front || 45) * DEG);
    add(bins.hullArmour, plate.translate(w * 0.14, gy, gz + 0.04));
  }
  // spare track links flat on the Tiger's glacis shelf, which is what that
  // near-horizontal plate is for
  if (sh.glacisTrack) {
    const sz = noseZAt(stations, noseShelfY(stations) - 0.01);
    for (let i = 0; i < 3; i++) {
      const lz = sz + 0.10 + i * 0.20;
      add(bins.hullTrack, boxAt(w * 0.5, 0.07, 0.18, 0, roofAt(stations, lz).y + 0.05, lz));
    }
  }
  // Schurzen hang DOWN from a rail at the fender line and cover the upper
  // track run and the tops of the road wheels. They are not side cladding.
  if (sh.sideSkirts) {
    for (const side of [-1, 1]) {
      add(bins.hullArmour, grow(drawn.hull, boxAt(
        0.05, 0.55, len * 0.72, side * (w / 2 + 0.05), fenderY - 0.28, -len * 0.02,
      )));
      add(bins.hullSteel, boxAt(
        0.09, 0.05, len * 0.74, side * (w / 2 + 0.05), fenderY + 0.03, -len * 0.02,
      ));
    }
  }
  if (sh.fuelDrums) {
    for (const side of [-1, 1]) {
      // outboard of the sloping side plate, where the brackets carry them
      const dx = side * (wSpon + 0.01);
      add(bins.hullSteel, tubeZ(0.2, 0.2, 0.74, 14, dx, fenderY + 0.2, -len * 0.34));
      // banding hoops, so a drum is a drum rather than a peg
      for (const bz of [-0.26, 0.26]) {
        add(bins.hullSteel, tubeZ(
          0.212, 0.212, 0.05, 14, dx, fenderY + 0.2, -len * 0.34 + bz,
        ));
      }
    }
  }
  if (sh.spareTrack) {
    const sy = roofY - h * 0.28;
    const sz = noseZAt(stations, sy);
    const links = new THREE.BoxGeometry(w * 0.42, 0.08, 0.46);
    links.rotateX(-(spec.armor.hullSlope.front || 45) * DEG);
    add(bins.hullTrack, links.translate(0, sy, sz + 0.05));
  }
  if (sh.rearBins) {
    add(bins.hullSteel, boxAt(w * 0.5, 0.36, 0.4, 0, roofY + 0.19, -len * 0.46));
  }
  if (sh.bustleRack) {
    // the M26's bustle is armour, not a box hung off the back, so the rack
    // sits ON it rather than floating behind it
    add(bins.turSteel, boxAt(t.w * 0.66, 0.22, 0.3, 0, t.h * 0.5, -t.len * 0.6));
    for (const sx of [-1, 1]) {
      add(bins.turSteel, boxAt(
        0.04, 0.3, 0.04, sx * t.w * 0.3, t.h * 0.5, -t.len * 0.6,
      ));
    }
  }
  if (sh.unditchLog) {
    add(bins.hullMatt, tubeZ(
      0.13, 0.13, len * 0.46, 10, -(wSpon + 0.02), fenderY + 0.26, -len * 0.16,
    ));
  }
  if (sh.travelLock) {
    // the SU-100's travel lock stands on the nose, so it follows the plate
    const ly = ySpOf(stations) + 0.32;
    const lz = noseZAt(stations, ly);
    add(bins.hullSteel, boxAt(0.12, 0.5, 0.14, 0, ly + 0.25, lz + 0.06));
    add(bins.hullSteel, boxAt(0.3, 0.1, 0.12, 0, ly + 0.5, lz + 0.06));
  }
  if (sh.headlights) {
    for (const side of [-1, 1]) {
      const hz = len * 0.45;
      const hSeat = roofAt(stations, hz);
      const hy = Math.min(roofY - 0.08, hSeat.y - 0.1);
      add(bins.hullSteel, tubeZ(0.11, 0.11, 0.11, 14, side * w * 0.26, hy, hz));
      // the brush guard over it
      add(bins.hullSteel, barBetween(
        side * w * 0.26 - 0.13, hy, hz + 0.03,
        side * w * 0.26 + 0.13, hy, hz + 0.03, 0.016,
      ));
    }
  }
  // jerrycans on the German rear deck
  if (spec.nation === 'Germany') {
    const jz = -len * 0.42;
    const jSeat = roofAt(stations, jz);
    for (const sx of [-1, 1]) {
      add(bins.hullSteel, boxAt(
        0.16, 0.34, 0.24, sx * Math.min(w * 0.24, jSeat.hw * 0.7), jSeat.y + 0.17, jz,
      ));
    }
  }

  // the height of each frame's origin above the ground contact, for the zone
  // bake: turret parts sit on the hull roof, gun parts on the trunnion
  const gunY = roofY + ((spec.gunMount && spec.gunMount.y) ?? t.h * 0.48);
  const frameY = {
    turArmour: roofY, turCast: roofY, turSteel: roofY, turMarker: roofY,
    gunSteel: gunY, gunArmour: gunY, recSteel: gunY, gunCrown: gunY,
  };
  const sealed = sealBins(bins, frameY);
  attachMarks(spec, sealed, glassAt);
  for (const k of ['trackBelt', 'wheelTyre', 'wheelGear']) addRunningGearMorphs(sealed[k]);
  // the belt's centre line, once per spec, for the vertex stage
  const beltTex = new THREE.DataTexture(
    path.data, path.samples, 1, THREE.RGBAFormat, THREE.FloatType,
  );
  beltTex.minFilter = THREE.NearestFilter;
  beltTex.magFilter = THREE.NearestFilter;
  beltTex.generateMipmaps = false;
  beltTex.needsUpdate = true;
  markShared(beltTex);
  const belt = {
    id: ++beltIds, texture: beltTex, perim: path.perim, samples: path.samples, path,
    cellLen: beltCell(ch, path).L,
  };
  return { bins: sealed, drawn, belt };
}

function cachedTankGeometry(spec) {
  const key = geoKeyFor(spec);
  let geo = geoCache.get(key);
  if (!geo) {
    geo = buildTankGeometry(spec);
    // Callers get meshes that SHARE these buffers, so a scene teardown that
    // disposed one would free the geometry for every battle after it. Stamp
    // every geometry, not only the record: isSharedResource() is asked about
    // the geometry a mesh holds (X-ray lane request; planes.js does the same).
    markSharedGeometry(geo);
    for (const g of Object.values(geo.bins)) if (g) markSharedGeometry(g);
    geoCache.set(key, geo);
  }
  return geo;
}

// The coat a tank is built in. A tint is honoured only when it is a paint the
// bible allows for this vehicle (inside the band of its spec paint, C-10);
// anything else falls back to the spec's own calibrated paint, because
// vehicles are told apart by shape and never by a per-vehicle colour (C-11).
function paintFor(spec, tintColor) {
  if (tintColor != null && tintColor !== spec.color && !inPaintBand(tintColor, spec.color)) {
    return spec.color;
  }
  return tintColor ?? spec.color;
}

// ---------------------------------------------------------------------------
// Builds the mesh hierarchy for one tank.
// Group origin sits at ground level, forward = +Z.
// Also returns the local-space collision boxes used by the penetration model.
//
// The geometry is shared with every other tank of the same shape and the
// materials with every other tank of the same paint, so this is now a dozen
// object allocations rather than fifty geometry constructions.
//
// `opts.contactShadow` (V-10) puts a soft dark ellipse under the hull. It is a
// battle device, so it defaults ON only for a battle build — one that passes
// its team colour explicitly (tankEntity does). The hangar has its own lit,
// shadowed stage, and the X-ray views re-dress every mesh in the group, where
// a ground quad would show up as a disc of "armour".
// ---------------------------------------------------------------------------
export function buildTankMesh(spec, tintColor = null, teamColor = 0x4f8fd0, opts = {}) {
  const color = paintFor(spec, tintColor);
  const battleBuild = arguments.length >= 3 && teamColor != null;
  const contactShadow = opts.contactShadow ?? battleBuild;
  const { w, h, len, trackH } = spec.hull;
  const t = spec.turret;
  const sh = spec.shape;
  const cached = cachedTankGeometry(spec);
  const geo = cached.bins;
  // a German spec carries its three-tone scheme; everyone else is monotone
  const scheme = color === spec.color && Array.isArray(spec.scheme) ? spec.scheme : null;
  const primer = spec.nation === 'Germany' ? PAINT_DE_PRIMER : null;
  // rivet heads belong to the riveted M3 only; every other hull here is
  // welded plate or a casting, and a grid of dots on a T-34 is just wrong
  const rivets = sh.hull === 'boxy';

  // Flat shading stays on the armour: a faceted glacis is CORRECT on a plate
  // vehicle, and the normal map supplies the surface inside each facet rather
  // than trying to round it off. Every coat is a dielectric with the zone
  // weathering on (V-01, V-04).
  const paint = armourMaterial(color, {
    camo: scheme, wear: 0.55, scale: 1.6, zones: true, primer, rivets,
  });
  // Fittings, hatches, wheels and the gun are painted too (C-04): the same
  // coat, at a finer tile so a periscope guard is not one smear of texture.
  const fittings = armourMaterial(color, {
    camo: scheme, wear: 0.55, scale: 0.8, zones: true, primer, rivets: false,
  });
  const mats = {
    hullArmour: paint,
    hullSteel: fittings,
    hullGear: fittings,
    hullTrack: trackMaterial({ scale: 0.6, zones: true }),
    hullTyre: rubberMaterial({ zones: true }),
    hullBare: exhaustMaterial({ zones: true }),
    hullMatt: mattMaterial(0x6b4f33, { rough: 0.94 }),
    // V-09 national markings and V-08 vision glass, lit and matt (one shared
    // material; the old unlit team stripes are gone — H-06 carries the team)
    hullMarks: markingsMaterial(insigniaAtlas().texture),
  };
  // the moving running gear: the same coats, with the vertex stage that runs
  // the belt and spins the wheels (runningGearMaterial)
  mats.trackBelt = runningGearMaterial(mats.hullTrack, 'belt', cached.belt);
  mats.wheelTyre = runningGearMaterial(mats.hullTyre, 'spin');
  mats.wheelGear = runningGearMaterial(fittings, 'spin');
  mats.turMarks = mats.hullMarks;
  mats.turArmour = paint;
  // Cast turrets are the one place on these vehicles where smooth normals are
  // right: a casting has no facets, and flat-shading a rounded T-34 or M26
  // turret is exactly the 'let the shader do the work' failure. Same factory,
  // same cache key discipline — only the shading flag and the casting detail
  // differ, and only the vehicles with castings pay for the extra material.
  mats.turCast = sh.cast
    ? armourMaterial(color, {
      camo: scheme, wear: 0.55, scale: 1.6, flatShading: false, zones: true, cast: true, primer, rivets: false,
    })
    : paint;
  mats.turSteel = fittings;
  mats.gunSteel = fittings;
  // the mantlet is painted armour on a moving frame; cast vehicles get the
  // smooth-shaded coat so the bulge does not facet
  mats.gunArmour = sh.cast ? mats.turCast : paint;
  // the barrel wears the paint; only its crown is bare steel (V-03)
  mats.recSteel = fittings;
  mats.gunCrown = gunCrownMaterial();

  const group = new THREE.Group();
  const turretGroup = new THREE.Group();
  turretGroup.position.set(0, trackH + h, t.offZ);

  // One constant cannot serve a 37mm in a mantlet at the front of a small
  // turret, a Flakvierling trunnion in the middle of a 2.3m open tub and a
  // 100mm offset to the right of an SU-100's front plate, so a spec may state
  // its own mount. Anything that does not falls back to what it always got.
  const gm = spec.gunMount || {};
  const gunGroup = new THREE.Group();
  gunGroup.position.set(
    gm.x ?? 0,
    gm.y ?? t.h * 0.48,
    gm.z ?? t.len * (sh.turret === 'casemate' ? 0.24 : 0.34),
  );

  // Everything the recuperator throws back on firing hangs off this one group,
  // so the entity can slide the whole gun without knowing what it is made of.
  // The muzzle marker deliberately stays put: it is where the shell leaves and
  // where the flash is drawn, and it should not jump around between shots.
  const recoilGroup = new THREE.Group();
  gunGroup.add(recoilGroup);
  gunGroup.userData.recoilGroup = recoilGroup;

  const muzzle = new THREE.Object3D();
  muzzle.position.z = spec.gunLen + 0.15;
  gunGroup.add(muzzle);

  const frames = {
    hullArmour: group, hullSteel: group, hullGear: group,
    hullTrack: group, hullTyre: group, hullBare: group,
    hullMatt: group, hullMarks: group,
    trackBelt: group, wheelTyre: group, wheelGear: group,
    turArmour: turretGroup, turCast: turretGroup,
    turSteel: turretGroup, turMarks: turretGroup,
    gunSteel: gunGroup, gunArmour: gunGroup,
    recSteel: recoilGroup, gunCrown: recoilGroup,
  };
  // The national markings are the vehicle's own (V-40), so they are drawn in
  // the hangar and on the cards as well as in battle; team identity is the
  // HUD's (H-06), whatever colour a caller passes.
  const runningGear = {
    belt: null,
    wheels: [],
    perim: cached.belt.perim,
    // a whole number of belt loops near 500 m: the running totals wrap here
    // so float precision holds, and the belt itself never jumps
    wrap: cached.belt.perim * Math.max(1, Math.round(500 / cached.belt.perim)),
  };
  for (const key of Object.keys(frames)) {
    const g = geo[key];
    if (g) {
      const m = new THREE.Mesh(g, mats[key]);
      if (key === 'trackBelt') {
        m.name = key;
        runningGear.belt = m;
      } else if (key === 'wheelTyre' || key === 'wheelGear') {
        m.name = key;
        runningGear.wheels.push(m);
      }
      if (key === 'hullMarks' || key === 'turMarks') {
        m.name = key;
        m.userData.decal = true;
        decalVisibility(m, mats[key]);
      }
      frames[key].add(m);
    }
  }

  turretGroup.add(gunGroup);
  group.add(turretGroup);

  group.traverse((o) => {
    if (o.isMesh) {
      // a decal lies on the plate: it takes the plate's shadow, casts none
      const decal = o.name === 'hullMarks' || o.name === 'turMarks';
      o.castShadow = !decal;
      o.receiveShadow = true;
    }
  });

  // V-10: the contact shadow, a child of the hull so it pitches and rolls
  // with it on a slope. One shared quad and material; this mesh only scales.
  if (contactShadow) {
    const blob = new THREE.Mesh(contactShadowGeometry(), contactShadowMaterial());
    blob.name = 'contactShadow';
    blob.scale.set(w * 1.15, 1, len * 1.15);
    blob.position.y = 0.06;
    blob.castShadow = false;
    blob.receiveShadow = false;
    blob.renderOrder = -1;
    blob.userData.contactShadow = true;
    group.add(blob);
  }

  // collision boxes in local space (min/max), used by ballistics. The spec's
  // nominal volumes, grown over any armour that is DRAWN outside them — a
  // turret bustle, the Wirbelwind's rear overhang, the SU-100's casemate
  // shoulders, fenders and skirts — so a shell that visibly strikes the
  // vehicle never passes through it. Never shrunk: a spec's armour layout and
  // internals are laid out in the nominal volume. Cupolas stay outside (one
  // box cannot hold a cupola without a phantom slab across the whole roof).
  const hullBox = {
    min: new THREE.Vector3(-w / 2, 0.05, -len / 2),
    max: new THREE.Vector3(w / 2, trackH + h, len / 2),
  };
  const turretBox = {
    min: new THREE.Vector3(-t.w / 2, 0, -t.len / 2),
    max: new THREE.Vector3(t.w / 2, t.h, t.len / 2),
  };
  growBox(hullBox, cached.drawn.hull, { minY: 0.05, maxY: trackH + h });
  growBox(turretBox, cached.drawn.turret, { minY: 0 });

  // `paintHex` is the coat the tank was ACTUALLY built in — the spec paint
  // whenever paintFor() refused the tint (the player's old 0x8a9464 is outside
  // every band). Anything that reasons about the coat's brightness, such as
  // the wreck twin in tankEntity.destroy(), must use this and not the tint it
  // asked for: the coat materials are shared by every tank in the same paint.
  // `runningGear` is driven with driveRunningGear(); left alone it is at rest
  return {
    group, turretGroup, gunGroup, muzzle, hullBox, turretBox, paintHex: color, scheme, runningGear,
  };
}

// Union a {min, max} collision box with a drawn Box3, symmetric in x (the
// armour is), optionally keeping a y floor/ceiling where another box takes
// over (the hull box stops at the roof, where the turret box begins).
function growBox(box, drawn, { minY = -Infinity, maxY = Infinity } = {}) {
  if (!drawn || drawn.isEmpty()) return box;
  const hx = Math.max(box.max.x, -box.min.x, drawn.max.x, -drawn.min.x);
  box.min.x = -hx;
  box.max.x = hx;
  box.min.y = Math.max(minY, Math.min(box.min.y, drawn.min.y));
  box.max.y = Math.min(maxY, Math.max(box.max.y, drawn.max.y));
  box.min.z = Math.min(box.min.z, drawn.min.z);
  box.max.z = Math.max(box.max.z, drawn.max.z);
  return box;
}
