import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  airframeMaterial,
  applyClearGlass,
  propDiscMaterial,
  AF_CLASS,
  markSharedGeometry } from '../core/materials.js';
import { insigniaAtlas } from '../core/insignia.js';
// The smoke-screen veil for the canopy glass (see canopyGlassMaterial below).
import { applySmokeVeil } from '../combat/effects.js';
// Height above the terrain and the sun's shadow box, for the distant-aircraft
// shadow cut (P-03).
import { terrainHeight } from '../world/terrain.js';
import { environmentState } from '../world/scenery.js';
// The battle's hour and light, for the navigation-lamp emitter (bible V-42).
import { activePreset } from '../world/presets.js';

// ---------------------------------------------------------------------------
// Aircraft paints (art bible 4.2 aircraft rows, C-17). Exact WWII values do
// not exist; each hex is the bible's default inside its documented BAND, and
// the band is the gate (aircraftPaintBands below, checked by the lane test).
// ---------------------------------------------------------------------------
export const AIR_PAINT = Object.freeze({
  RAF_DARK_GREEN: 0x4f5241,      // BS 381C 241, Spitfire upper
  RAF_OCEAN_GREY: 0x6a7078,      // Spitfire upper
  RAF_MEDIUM_SEA_GREY: 0x8e9799, // BS 381C 637, Spitfire under
  RAF_SKY: 0xb8c4a2,             // BS 381C 210, the band and spinner
  RLM74: 0x4f5155,               // Graugruen, Fw 190 A-5 upper
  RLM75: 0x676a72,               // Grauviolett, Fw 190 A-5 upper
  RLM76: 0xadb8b9,               // Lichtblau, Fw 190 A-5 under and sides
  RLM70: 0x2f3530,               // Schwarzgruen, Luftwaffe propeller blades
  IJN_GREY_GREEN: 0x8e8b6c,      // ameiro / hai-ryokushoku, A6M2 overall
  IJN_COWL_BLACK: 0x36383a,      // the semi-gloss blue-black cowling
  AMT4: 0x565a42,                // VVS green, Il-2 upper
  AMT6: 0x2c2d2f,                // VVS black, Il-2 upper (C-01 floor)
  AMT7: 0x7f98ab,                // VVS blue-grey, Il-2 under
  US_ANA613: 0x4d4c30,           // ANA 613 olive drab, the P-51D anti-glare panel
  NMF: 0xe3e5e6,                 // natural metal, weathered aluminium (F0 Y .78)
});
const AP = AIR_PAINT;
// Bible table 4.2: linear Y, HSV hue (deg) / saturation, roughness.
export const AIR_PAINT_BANDS = Object.freeze({
  [AP.RAF_DARK_GREEN]: { name: 'RAF Dark Green', y: [0.07, 0.10], hue: [65, 80], sat: [0.15, 0.28], rough: [0.60, 0.75] },
  [AP.RAF_OCEAN_GREY]: { name: 'RAF Ocean Grey', y: [0.13, 0.20], hue: [200, 225], sat: [0.08, 0.16], rough: [0.60, 0.75] },
  [AP.RAF_MEDIUM_SEA_GREY]: { name: 'RAF Medium Sea Grey', y: [0.26, 0.34], hue: [180, 200], sat: [0, 0.10], rough: [0.60, 0.75] },
  [AP.RAF_SKY]: { name: 'RAF Sky', y: [0.45, 0.58], hue: [75, 90], sat: [0.12, 0.22], rough: [0.55, 0.70] },
  [AP.RLM74]: { name: 'RLM 74', y: [0.07, 0.10], hue: [210, 235], sat: [0, 0.10], rough: [0.55, 0.70] },
  [AP.RLM75]: { name: 'RLM 75', y: [0.12, 0.18], hue: [215, 240], sat: [0, 0.12], rough: [0.55, 0.70] },
  [AP.RLM76]: { name: 'RLM 76', y: [0.42, 0.62], hue: [175, 200], sat: [0, 0.10], rough: [0.55, 0.70] },
  [AP.IJN_GREY_GREEN]: { name: 'IJN hai-ryokushoku', y: [0.21, 0.28], hue: [50, 65], sat: [0.18, 0.30], rough: [0.30, 0.42] },
  [AP.IJN_COWL_BLACK]: { name: 'IJN cowling black', y: [0.03, 0.05], hue: [0, 360], sat: [0, 0.10], rough: [0.30, 0.45] },
  [AP.AMT4]: { name: 'VVS AMT-4', y: [0.075, 0.11], hue: [62, 80], sat: [0.20, 0.32], rough: [0.60, 0.80] },
  [AP.AMT6]: { name: 'VVS AMT-6', y: [0.025, 0.040], hue: [0, 360], sat: [0, 0.10], rough: [0.60, 0.80] },
  [AP.AMT7]: { name: 'VVS AMT-7', y: [0.20, 0.34], hue: [195, 215], sat: [0.18, 0.35], rough: [0.60, 0.80] },
  [AP.US_ANA613]: { name: 'ANA 613 OD', y: [0.065, 0.100], hue: [50, 68], sat: [0.28, 0.42], rough: [0.55, 0.85] },
  [AP.NMF]: { name: 'Natural metal (F0)', y: [0.75, 0.92], hue: [0, 360], sat: [0, 0.05], rough: [0.25, 0.45] },
});
const RAF_YELLOW = 0xc9a23a; // the Day Fighter Scheme's outer-wing leading-edge strips

// Historical aircraft, five machines across five nations. Speeds in m/s;
// roll/pitch/yaw rates in rad/s. Figures come from the real aircraft and are
// then trimmed to the game's tiers — the Zero really does out-turn everything
// and really is made of paper, so that survives intact.
//
// The block under "flight model" feeds the aerodynamics in planeEntity.js.
// mass (kg) and wingArea (m²) are the real loaded figures, and stallSpeed is
// the game's own number: together they decide the lift coefficient the wing can
// reach, so wing loading is a real, comparable quantity between these five.
// maxSpeed and powerplant.thrust then pin down the drag polar (planeAero
// below), which is why every one of these numbers has to stay honest — change
// one and the aircraft's whole envelope moves with it.
//
// The block under "shape" is the aeroplane's SILHOUETTE, and it is the same
// kind of thing the tanks' hull/turret/chassis blocks are: measured metres, in
// the aircraft's own frame (+Z nose, +Y canopy, +X LEFT wing), origin at the
// fuselage mid-point. Nothing in here is a proportion of span or length —
// "span * 0.17" is how all five ended up wearing the same undercarriage. Every
// geometric decision the builder used to guess from a `look` string now reads a
// number from here, and `look` survives only as the fallback for anything a
// spec does not state.
//
// Wing planform is stated as root and tip chord plus the LEADING-edge sweep,
// because on a real aeroplane the trailing edge is what falls out of those
// three — that relationship is exactly what the old shared "sweep the mid-chord
// back" law destroyed. Wing AREA is not stated here: it is a consequence of the
// planform, and the harness checks it against the wingArea the flight model
// uses, so the shape a player sees and the lift the aeroplane makes agree.
export const PLANE_SPECS = {
  zero: {
    id: 'zero', name: 'A6M2 Zero', nation: 'Japan',
    klass: 'Light Fighter', tier: 1, price: null,
    span: 12, len: 9,
    maxSpeed: 62, minSpeed: 20, accel: 8, hp: 28,
    rollRate: 3.3, pitchRate: 1.8, yawRate: 0.85,
    // --- flight model ---
    // 2410 kg on 22.4 m² is by far the lightest wing loading here, and that is
    // the whole aeroplane: it turns with anything and then folds up in a dive.
    engines: 1, mass: 2410, wingArea: 22.4,
    stallSpeed: 20, structuralSpeed: 86, maxG: 7, climbRate: 12,
    powerplant: { name: 'Nakajima Sakae 12', kw: 700, thrust: 21000 },
    critDensity: 0.72,
    fuelCapacity: 320, fuelBurn: 0.3, fireRisk: 0.55,
    // Landing-flap limit, km/h INDICATED (see flapRipOf() below). No primary
    // A6M2 figure was found either; 250 sits where the documented types put
    // theirs against their gear limits (Spitfire 0.88, P-51 0.97, Fw 190 1.07).
    flapLimit: 250, airbrakeCd: 0.03,
    // Undercarriage limit, km/h INDICATED (see gearLimits() below). No primary
    // A6M2 handbook figure was found; 260 is an estimate placed between the
    // Spitfire's 257 and the Mustang's 274, the two documented fighters of the
    // same size and gear layout.
    gearLimit: { vlo: 260, vle: 260 },
    convergence: 250,
    parts: {
      leftWing: 16, rightWing: 16, tail: 12, elevator: 6, rudder: 6,
      aileronL: 6, aileronR: 6, engine: 14, oilCooler: 5, fuelTank: 7,
      pilot: 7, controls: 7,
    },
    gun: { dmg: 2.4, rof: 18, speed: 810, ammo: 800, spread: 0.013 },
    bombs: { count: 2, radius: 22 },
    rockets: { count: 8, radius: 8 },
    look: { engine: 'radial', wing: 'tapered', canopy: 'greenhouse', roundTail: true },
    // A6M2 Model 21. Span 12.00, length 9.06, wing area 22.44 m², prop 3.05 m.
    // The whole aeroplane is "a wing two sizes too big for the fuselage", so
    // the chords are the load-bearing numbers: 2.48 root on a 6.00 half-span
    // is 22.2 m², where the old shared 2.0 root gave 18.0 and read as an
    // ordinary small fighter.
    shape: {
      wing: {
        law: 'taper', rootChord: 2.52, tipChord: 1.24, leSweep: 6.5,
        tcRoot: 0.15, tcTip: 0.09, tipRound: 0.945, foldBreak: 0.9167,
        y: -0.30, z: 0.41, dihedral: 6.0, filletAft: 0.95,
      },
      // near-circular throughout, a parallel cowl drum, then a very long taper
      // to a pencil tail — the nose is fat and the tail is thin
      fuselage: [
        [4.35, 0.60, 0.60, 0.00], [3.70, 0.60, 0.60, 0.00], [3.00, 0.56, 0.58, 0.00],
        [1.70, 0.52, 0.58, 0.02], [0.30, 0.50, 0.55, 0.03], [-1.30, 0.44, 0.50, 0.05],
        [-2.60, 0.30, 0.36, 0.06], [-3.60, 0.18, 0.24, 0.07], [-4.40, 0.07, 0.14, 0.08],
      ],
      // 3.0 m of greenhouse blending aft into a raised turtledeck, so the spine
      // stays high a metre past the glass instead of falling away behind a hood
      canopy: {
        z: 0.30, y: 0.50, tubBack: -0.85,
        glass: [[
          [1.70, 0.20, 0.13, 0.50], [1.30, 0.38, 0.30, 0.50], [0.30, 0.40, 0.32, 0.50],
          [-0.55, 0.38, 0.29, 0.50], [-1.30, 0.26, 0.18, 0.48],
        ]],
        deck: [
          [-1.30, 0.32, 0.26, 0.38], [-1.85, 0.28, 0.19, 0.36], [-2.30, 0.22, 0.12, 0.34],
        ],
      },
      prop: {
        blades: 3, radius: 1.55, z: 4.24,
        spinnerR: 0.175, spinnerLen: 0.40, spinnerProfile: 'ogive',
        chordRoot: 0.26, chordTip: 0.13,
      },
      tail: {
        halfSpan: 1.80, rootChord: 1.05, tipChord: 0.62, law: 'taper', leSweep: 7,
        tipRound: 0.86, tcRoot: 0.10, tcTip: 0.09, y: 0.04, z: -3.72,
        finY: 0.14, finTop: [1.38, 0.12],
        fin: [[0.90, 0], [-0.52, 0], [-0.48, 1.12], [0.12, 1.38], [0.70, 0.80]],
        rudder: [[-0.50, -0.26], [-0.70, -0.16], [-0.74, 0.24], [-0.55, 1.22], [-0.45, 1.20]],
        rudderHinge: -0.48,
      },
      // 3.5 m track, inboard retraction — the inboard fold is already right,
      // the 4.08 m track was not
      gear: {
        x: 1.75, z: 1.25, legLen: 1.10, wheelR: 0.30, tyreW: 0.20, retract: 'in',
        tailZ: -3.95, tailLegLen: 0.36, tailR: 0.14,
      },
      // one 20 mm Type 99 per wing well outboard, and the two 7.7 mm cowl guns
      wingGuns: [{ u: 0.42, r: 0.038, protrude: 0.40 }],
      cowlGuns: [{ x: 0.10, y: 0.585, w: 0.11, h: 0.10, z0: 3.95, z1: 2.05 }],
      cowlLip: { w: 0.30, h: 0.09, z0: 4.30, z1: 2.45, y: -0.62 },
      topScoop: { w: 0.09, h: 0.05, len: 0.40, y: 0.62, z: 3.60 },
      // Two Type 97 No.6 60 kg bombs on the underwing racks just outboard of
      // the undercarriage: the only ordnance an A6M2 ever carried, and about
      // 0.75 m of bomb apiece. Rockets are the game's fit, not the Zero's, so
      // they go on the smallest rails that will hold them.
      stores: {
        bomb: { len: 0.75, dia: 0.20, pairs: [{ x: 2.05 }] },
        rocket: {
          len: 0.90, dia: 0.15,
          pairs: [{ x: 2.45 }, { x: 3.05 }, { x: 3.65 }, { x: 4.25 }],
        },
      },
    },
    color: 0x8c8b6a,
    // ---- finish: A6M2 Model 21, 1941-42 (bible V-01, C-17, V-40) ----
    // One glossy grey-green overall (the only gloss finish in the roster) with
    // the semi-gloss blue-black cowling; plain red hinomaru on both wing
    // surfaces and the fuselage, no white surround on this scheme.
    scheme: {
      pattern: 'mono', upper: [AP.IJN_GREY_GREEN], lower: AP.IJN_GREY_GREEN,
      demarcY: -0.3, fade: 0.05,
      bands: [{ kind: 'ring', z0: 3.25, z1: 4.6, hex: AP.IJN_COWL_BLACK, rough: 0.38 }],
    },
    // sizes and stations *verify against period photographs*
    markings: [
      { glyph: 'jp_hinomaru', on: 'wing', u: 0.66, face: 'upper', size: 1.05 },
      { glyph: 'jp_hinomaru', on: 'wing', u: 0.66, face: 'lower', size: 1.05 },
      { glyph: 'jp_hinomaru', on: 'fuselage', z: -1.55, y: 0.04, size: 0.75 },
    ],
    finish: {
      rough: 0.36, interior: 0x5d5c43, blade: 0x5a3c2a, tip: 0x8a2a22, tipFrom: 0.90,
      spinner: 0x9ea1a3, spinnerMetal: 1, spinnerRough: 0.32, bomb: 0x6b6d63,
    },
    // V-12: the Sakae's exhausts leave low on the cowl flanks
    weathering: {
      exhaust: { z: 3.15, len: 1.7, y: -0.22, halfH: 0.10, droop: 0.02, soot: 0.25, strength: 0.8 },
      oil: { z: 3.0, len: 1.6, halfW: 0.24, strength: 0.7 },
      walkway: { x0: 0.45, x1: 1.30, dz0: -0.9, dz1: 0.6, coverage: 0.10 },
    },
  },
  spitfire: {
    id: 'spitfire', name: 'Spitfire Mk Vb', nation: 'Britain',
    klass: 'Fighter', tier: 2,
    price: { silver: 2500, rp: 900 },
    span: 11.2, len: 9.1,
    maxSpeed: 70, minSpeed: 23, accel: 9.2, hp: 42,
    rollRate: 2.8, pitchRate: 1.55, yawRate: 0.72,
    // --- flight model ---
    // The elliptical wing earns a lift coefficient nothing else here reaches,
    // so it stalls last; the airframe is strong but the tanks are small.
    engines: 1, mass: 2900, wingArea: 22.5,
    stallSpeed: 21, structuralSpeed: 100, maxG: 9, climbRate: 13,
    powerplant: { name: 'Rolls-Royce Merlin 45', kw: 1100, thrust: 25000 },
    critDensity: 0.6,
    fuelCapacity: 220, fuelBurn: 0.32, fireRisk: 0.3,
    // Pilot's Notes, Spitfire V (A.P. 1565E), maximum speeds: undercarriage
    // down 160 m.p.h. I.A.S., flaps down 140. 160 mph = 257 km/h, 140 = 225.
    flapLimit: 225, airbrakeCd: 0.035,
    gearLimit: { vlo: 257, vle: 257 },
    convergence: 230,
    parts: {
      leftWing: 22, rightWing: 22, tail: 16, elevator: 8, rudder: 8,
      aileronL: 8, aileronR: 8, engine: 20, oilCooler: 7, fuelTank: 12,
      pilot: 10, controls: 10,
    },
    gun: { dmg: 3.6, rof: 14, speed: 830, ammo: 560, spread: 0.011 },
    bombs: { count: 2, radius: 26 },
    rockets: { count: 8, radius: 8 },
    look: { engine: 'inline', wing: 'elliptical', canopy: 'framed', chinRad: true, roundTail: true },
    // Mk Vb. Span 11.23, length 9.12, wing area 22.48 m², prop 3.28 m, 3 blades.
    // The ellipse is laid about a STRAIGHT QUARTER-CHORD line — that is the
    // difference between a Spitfire wing and a lens, and it is the single
    // most recognisable shape in the game. root chord = 4S/(pi*b) = 2.55.
    shape: {
      wing: {
        law: 'ellipse', rootChord: 2.55,
        tcRoot: 0.132, tcTip: 0.094,
        y: -0.30, z: 0.275, dihedral: 6.0, filletAft: 1.30,
      },
      // deeper than wide with a flat-ish top decking (superellipse n) and a
      // nose that breaks DOWN to the spinner instead of tapering symmetrically
      fuselage: [
        [4.10, 0.34, 0.44, 0.06, 2.6], [3.30, 0.39, 0.49, 0.05, 2.6],
        [1.60, 0.45, 0.58, 0.04, 2.4], [0.30, 0.45, 0.62, 0.05, 2.3],
        [-1.60, 0.38, 0.50, 0.07, 2.1], [-2.80, 0.24, 0.34, 0.09, 2.0],
        [-3.80, 0.14, 0.22, 0.10, 2.0], [-4.56, 0.06, 0.13, 0.11, 2.0],
      ],
      // short low framed sliding hood on a deep fuselage, with the flat
      // armoured front panel that makes a Spitfire windscreen read
      canopy: {
        z: 0.05, y: 0.50, tubBack: -0.75, flatScreen: true,
        glass: [[
          [0.95, 0.17, 0.11, 0.50], [0.62, 0.34, 0.26, 0.50],
          [-0.30, 0.35, 0.27, 0.50], [-1.05, 0.22, 0.14, 0.50],
        ]],
      },
      prop: {
        blades: 3, radius: 1.64, z: 4.02,
        spinnerR: 0.23, spinnerLen: 0.55, spinnerProfile: 'cone',
        chordRoot: 0.28, chordTip: 0.14,
      },
      tail: {
        halfSpan: 1.58, rootChord: 0.95, law: 'ellipse',
        tcRoot: 0.11, tcTip: 0.09, y: 0.06, z: -3.75,
        finY: 0.20, finTop: [1.62, 0.20],
        fin: [[0.95, 0], [-0.55, 0], [-0.52, 1.35], [0.20, 1.62], [0.85, 0.95]],
        rudder: [[-0.55, -0.32], [-0.78, -0.20], [-0.86, 0.30], [-0.62, 1.45], [-0.50, 1.42]],
        rudderHinge: -0.52,
      },
      // the famous narrow track that folds OUTWARD toward the tips: 1.56 m at
      // the pintles, raking out to about 1.74 m at the tyres
      gear: {
        x: 0.78, z: 1.20, legLen: 1.15, wheelR: 0.33, tyreW: 0.20,
        retract: 'out', rake: 0.08,
        tailZ: -3.85, tailLegLen: 0.30, tailR: 0.13, tailFixed: true,
      },
      // B wing: one Hispano with a drum blister, two flush .303 ports
      wingGuns: [
        { u: 0.36, r: 0.048, protrude: 0.90, fairing: true, blister: { len: 0.85, w: 0.26, h: 0.09 } },
        { u: 0.50, r: 0.020, protrude: 0 },
        { u: 0.62, r: 0.020, protrude: 0 },
      ],
      // the underside asymmetry: big square coolant radiator to STARBOARD
      // (-X), small round oil cooler to PORT (+X). There is no chin radiator.
      ducts: [
        { x: -1.70, mouth: 'square', sections: [
          [1.05, 0.27, 0.06, -0.30], [0.70, 0.28, 0.17, -0.40],
          [-0.20, 0.28, 0.18, -0.41], [-0.30, 0.24, 0.13, -0.37],
        ] },
        { x: 1.40, mouth: 'round', sections: [
          [0.80, 0.15, 0.06, -0.24], [0.55, 0.17, 0.15, -0.31],
          [-0.10, 0.16, 0.14, -0.30], [-0.20, 0.12, 0.08, -0.26],
        ] },
      ],
      noseIntake: { w: 0.36, h: 0.20, z0: 3.50, z1: 2.30, y: -0.52 },
      // The Mk Vb fighter-bomber fit: a 250 lb GP under each wing, OUTBOARD of
      // the radiator and the oil cooler, which is the only place on this wing
      // one will go. RP-3 60 lb rockets on four rails a side.
      stores: {
        bomb: { len: 1.30, dia: 0.28, pairs: [{ x: 2.25 }] },
        rocket: {
          len: 1.62, dia: 0.16,
          pairs: [{ x: 2.85 }, { x: 3.40 }, { x: 3.95 }, { x: 4.50 }],
        },
      },
    },
    color: 0x6e7a63,
    // ---- finish: Mk Vb, 1941-42 Day Fighter Scheme ----
    // Dark Green / Ocean Grey disruptive upper, about 50/50, over Medium Sea
    // Grey; the 18 in Sky band and Sky spinner; yellow leading-edge strips on
    // the outer wings. Type B roundels above the wings, A.1 on the fuselage,
    // the fin flash; no underwing roundels in this scheme (*verify*).
    scheme: {
      pattern: 'disruptive', upper: [AP.RAF_DARK_GREEN, AP.RAF_OCEAN_GREY], lower: AP.RAF_MEDIUM_SEA_GREY,
      coverage: 0.5, feature: 1.8, edge: 0.02, demarcY: -0.14, demarcSlope: -0.035, fade: 0.10,
      bands: [
        { kind: 'ring', z0: -3.20, z1: -2.74, hex: AP.RAF_SKY, rough: 0.62 },
        { kind: 'le', chord: 0.09, u0: 0.53, u1: 0.99, hex: RAF_YELLOW, rough: 0.62 },
      ],
    },
    markings: [
      { glyph: 'raf_b', on: 'wing', u: 0.64, face: 'upper', size: 1.42 },
      { glyph: 'raf_a1', on: 'fuselage', z: -1.80, y: 0.08, size: 0.89 },
      { glyph: 'raf_fin', on: 'fin', z: 0.28, y: 0.40, size: 0.61 },
    ],
    finish: {
      rough: 0.66, interior: 0x6b7562, blade: 0x2c2d2f, tip: RAF_YELLOW, tipFrom: 0.93,
      spinner: AP.RAF_SKY, bomb: 0x4d5244,
    },
    // a lean Merlin streaks light grey-tan aft of the six ejector stubs
    weathering: {
      exhaust: { z: 2.15, len: 2.3, y: 0.09, halfH: 0.07, droop: 0.012, soot: 0 },
      oil: { z: 3.2, len: 1.9, halfW: 0.22, strength: 0.7 },
      walkway: { x0: 0.42, x1: 1.20, dz0: -0.9, dz1: 0.7, coverage: 0.14 },
    },
  },
  fw190: {
    id: 'fw190', name: 'Fw 190 A-5', nation: 'Germany',
    klass: 'Heavy Fighter', tier: 3,
    price: { silver: 6000, rp: 2500 },
    // 9.00 m, not the A-4's 8.85: the A-5 moved the whole engine mount 150 mm
    // forward, and the longer nose ahead of the wing IS the sub-variant.
    span: 10.5, len: 9.0,
    maxSpeed: 80, minSpeed: 27, accel: 10.5, hp: 58,
    rollRate: 3.4, pitchRate: 1.2, yawRate: 0.6,
    // --- flight model ---
    // Heaviest wing loading of the fighters: it stalls early and sharply, but
    // it dives harder than anything else here and the armour behind the pilot
    // is the reason a burst that would kill a Zero only annoys it.
    engines: 1, mass: 3980, wingArea: 18.3,
    stallSpeed: 28, structuralSpeed: 120, maxG: 8.5, climbRate: 12,
    powerplant: { name: 'BMW 801 D-2', kw: 1250, thrust: 31000 },
    critDensity: 0.7,
    fuelCapacity: 380, fuelBurn: 0.42, fireRisk: 0.28,
    // Landing flap: the A-series manuals as quoted by their owners limit the
    // fully extended flap to 320 km/h (no scan of the table was found).
    flapLimit: 320, airbrakeCd: 0.04,
    // Fw 190 handbook practice is to extend the gear at about 300 km/h on the
    // circuit (the figure quoted from the D-9 Bedienungsvorschrift; no A-5
    // limitations table was found), so 300 is used as the limit.
    gearLimit: { vlo: 300, vle: 300 },
    convergence: 300,
    parts: {
      leftWing: 28, rightWing: 28, tail: 20, elevator: 10, rudder: 10,
      aileronL: 10, aileronR: 10, engine: 26, oilCooler: 9, fuelTank: 16,
      pilot: 16, controls: 13,
    },
    gun: { dmg: 6.5, rof: 9, speed: 800, ammo: 300, spread: 0.010 },
    bombs: { count: 2, radius: 36 },
    rockets: { count: 6, radius: 10 },
    look: { engine: 'radial', wing: 'straight', canopy: 'bubble', wideCowl: true },
    // A-5. Span 10.506, length 9.00, wing area 18.3 m², prop 3.30 m VDM.
    // Head-on the Fw 190 is a SOLID DISC with a fan in it: a flat-faced barrel
    // cowl of constant 1.30 m diameter, a blunt 0.62 m spinner filling the
    // middle, and the 12-blade cooling fan in the annulus. The old model had a
    // smooth bullet nose with the entire engine buried inside it, invisible.
    shape: {
      wing: {
        law: 'taper', rootChord: 2.30, tipChord: 1.20, leSweep: 4.0,
        tcRoot: 0.15, tcTip: 0.09, squareTip: true,
        y: -0.28, z: 0.11, dihedral: 6.0, filletAft: 0.85,
      },
      // a barrel that holds 1.30 m to the front face and then necks down hard
      // to a slim body within a metre; the deck aft runs almost straight to
      // the fin, so hood-top and spine read as one line
      fuselage: [
        [4.05, 0.645, 0.645, 0.00, 3.0], [3.85, 0.65, 0.65, 0.00, 3.0],
        [3.10, 0.65, 0.65, 0.00, 3.0], [2.35, 0.63, 0.65, 0.00, 2.8],
        [1.35, 0.52, 0.60, 0.02, 2.4], [0.35, 0.475, 0.575, 0.03, 2.2],
        [-1.20, 0.40, 0.475, 0.06, 2.0], [-2.60, 0.26, 0.34, 0.10, 2.0],
        [-4.05, 0.08, 0.16, 0.14, 2.0], [-4.55, 0.05, 0.12, 0.15, 2.0],
      ],
      // a low framed sliding hood set well FORWARD, ~0.30 m proud of the deck.
      // It is emphatically not the Mustang's bubble.
      canopy: {
        z: 0.35, y: 0.55, tubBack: -0.45, flatScreen: true,
        glass: [[
          [1.20, 0.18, 0.10, 0.60], [0.90, 0.36, 0.20, 0.56], [0.35, 0.39, 0.235, 0.55],
          [-0.10, 0.38, 0.22, 0.55], [-0.35, 0.30, 0.16, 0.55],
        ]],
      },
      prop: {
        blades: 3, radius: 1.65, z: 4.03,
        spinnerR: 0.31, spinnerLen: 0.45, spinnerProfile: 'ogive',
        // wide-chord paddle blades with a squared tip, not a fighter's taper
        chordRoot: 0.27, chordTip: 0.25, hubR: 0.20, squareTip: true,
      },
      cowlRing: { z: 4.17, outer: 0.658, inner: 0.545, depth: 0.13 },
      coolingFan: { blades: 12, inner: 0.315, outer: 0.545, chord: 0.15, z: 0.08 },
      tail: {
        halfSpan: 1.825, rootChord: 1.35, tipChord: 0.75, law: 'taper', leSweep: 6,
        tipRound: 0.87, tcRoot: 0.10, tcTip: 0.09, y: 0.06, z: -3.50,
        finY: 0.16, finTop: [1.22, 0.30],
        fin: [[0.95, 0], [-0.55, 0], [-0.34, 1.06], [0.30, 1.22], [0.82, 0.72]],
        rudder: [[-0.55, -0.06], [-0.80, 0.04], [-0.70, 1.04], [-0.33, 1.06]],
        rudderHinge: -0.52,
      },
      gear: {
        x: 1.75, z: 0.95, legLen: 1.28, wheelR: 0.35, tyreW: 0.18, retract: 'in',
        tailZ: -4.05, tailLegLen: 0.34, tailR: 0.175,
      },
      wingGuns: [
        { u: 0.18, r: 0.035, protrude: 0.12, fairing: true },
        { u: 0.50, r: 0.030, protrude: 0.18 },
      ],
      cowlGuns: [{ x: 0.11, y: 0.645, w: 0.12, h: 0.10, z0: 3.60, z1: 1.55 }],
      // An SC 250 on an ETC rack under each wing root — the A-5/U8 Jabo fit.
      // The aeroplane's other famous rack is the fuselage ETC 501, but the game
      // gives this airframe TWO bombs and a single centreline store plus half a
      // pair would drop asymmetrically, so both go on the wing where they can
      // leave in a pair. 1.64 m and 0.37 m across is a real SC 250.
      stores: {
        bomb: { len: 1.64, dia: 0.37, pairs: [{ x: 2.30 }] },
        // 21 cm Wfr.Gr. mortar tubes, three a side
        rocket: {
          len: 1.15, dia: 0.21,
          pairs: [{ x: 2.90 }, { x: 3.50 }, { x: 4.10 }],
        },
      },
    },
    color: 0x6b7078,
    // ---- finish: A-5, 1943, RLM 74/75/76 ----
    // 74/75 splinter on everything that faces the sky over 76, the fuselage
    // sides and fin 76 under a 74/75 mottle covering about 30 %. Balkenkreuz
    // above and below both wings and on the fuselage. The tail marking of the
    // period is deliberately omitted (bible V-41).
    scheme: {
      pattern: 'splinter', upper: [AP.RLM74, AP.RLM75], lower: AP.RLM76,
      coverage: 0.5, feature: 1.4, edge: 0.004, demarcY: 0.30, demarcSlope: 0, fade: 0.08,
      // sprayed soft and thin over the 76: about 30 % of the flank, at ~55 %
      // opacity, so the sides read light grey with a speckle
      sideMottle: { coverage: 0.30, feature: 0.15, edge: 0.16, strength: 0.55 },
      bands: [],
    },
    markings: [
      { glyph: 'de_balkenkreuz', on: 'wing', u: 0.66, face: 'upper', size: 0.90 },
      { glyph: 'de_balkenkreuz', on: 'wing', u: 0.66, face: 'lower', size: 1.00 },
      { glyph: 'de_balkenkreuz', on: 'fuselage', z: -1.70, y: 0.05, size: 0.78 },
    ],
    finish: {
      rough: 0.62, interior: 0x4b4d4f, blade: AP.RLM70, tip: null,
      spinner: AP.RLM70, bomb: 0x5d6152,
    },
    // German fuel: the BMW 801 leaves almost no grey, a sooty black streak
    weathering: {
      exhaust: { z: 2.30, len: 2.0, y: -0.12, halfH: 0.11, droop: 0.02, soot: 1, strength: 0.9 },
      oil: { z: 2.5, len: 1.5, halfW: 0.30, strength: 0.6 },
      walkway: { x0: 0.45, x1: 1.25, dz0: -0.8, dz1: 0.6, coverage: 0.12 },
    },
  },
  il2: {
    id: 'il2', name: 'Il-2 Sturmovik', nation: 'USSR',
    klass: 'Attacker', tier: 3,
    price: { silver: 5500, rp: 2200 },
    span: 14.6, len: 11.6,
    maxSpeed: 60, minSpeed: 24, accel: 6.5, hp: 110,
    rollRate: 1.6, pitchRate: 0.95, yawRate: 0.5,
    // --- flight model ---
    // Six tonnes of armour plate flying on a low-altitude engine. Everything
    // forward of the cockpit is a structural part of the aeroplane, which is
    // why the engine and pilot soak so much more than anything else here.
    engines: 1, mass: 5900, wingArea: 38.5,
    stallSpeed: 24, structuralSpeed: 86, maxG: 6, climbRate: 7,
    powerplant: { name: 'Mikulin AM-38F', kw: 1300, thrust: 42000 },
    critDensity: 0.88,
    fuelCapacity: 400, fuelBurn: 0.45, fireRisk: 0.22,
    // Landing flap: no primary figure found; 270 km/h is an estimate by the
    // same gear-limit ratio as the Zero's.
    flapLimit: 270, airbrakeCd: 0.07,
    // No primary Il-2 pilot's instruction figure was found; 280 km/h is an
    // estimate for a slow rough-field attacker whose wheels never leave the
    // airflow anyway (they ride half out of the nacelles when retracted).
    gearLimit: { vlo: 280, vle: 280 },
    convergence: 400,
    parts: {
      leftWing: 40, rightWing: 40, tail: 30, elevator: 14, rudder: 14,
      aileronL: 13, aileronR: 13, engine: 48, oilCooler: 16, fuelTank: 26,
      pilot: 40, controls: 20,
    },
    gun: { dmg: 5.0, rof: 8, speed: 790, ammo: 300, spread: 0.019 },
    bombs: { count: 6, radius: 28 },
    rockets: { count: 10, radius: 9 },
    look: { engine: 'inline', wing: 'thick', canopy: 'twoSeat', armoured: true },
    // Il-2M3. Span 14.60, length 11.65, wing area 38.50 m², prop 3.60 m, 3
    // blades. Three things name it: the ARROW wing (rectangular centre section,
    // dead-straight trailing edge, leading edge kicking back 15° at the break),
    // the STEPPED glasshouse (tall pilot hood, a gap, a lower gunner station),
    // and the flat-sided armoured SHELL that keeps ~1.05 m of width right up to
    // the cowl face instead of tapering to a fighter's nose.
    shape: {
      wing: {
        law: 'arrow', rootChord: 3.10, tipChord: 1.70, breakU: 0.342,
        tcRoot: 0.15, tcTip: 0.13, tipRound: 0.945,
        // the centre section is DEAD FLAT and the dihedral starts at the break
        y: -0.40, z: 0.0, dihedral: 4.83, dihedralBreak: 0.342, filletAft: 0.75,
      },
      // two different bodies bolted together: a boxy armoured shell forward
      // (superellipse n = 5) and a wooden oval monocoque aft (n = 2)
      fuselage: [
        [5.35, 0.42, 0.47, 0.02, 5.0], [4.30, 0.50, 0.62, 0.00, 5.0],
        [3.00, 0.53, 0.70, 0.02, 5.0], [1.85, 0.55, 0.72, 0.04, 4.6],
        [0.40, 0.52, 0.66, 0.06, 3.4], [-1.40, 0.44, 0.52, 0.08, 2.2],
        [-3.40, 0.28, 0.34, 0.12, 2.0], [-5.62, 0.10, 0.17, 0.16, 2.0],
      ],
      // TWO glazed volumes with bare decking between them
      canopy: {
        z: 1.20, y: 0.66, tubBack: 0.40, gunnerZ: -0.85, flatScreen: true,
        glass: [
          [
            [2.15, 0.18, 0.10, 0.86], [1.80, 0.44, 0.30, 0.66],
            [1.05, 0.46, 0.32, 0.64], [0.55, 0.40, 0.26, 0.62],
          ],
          [
            [-0.35, 0.30, 0.16, 0.52], [-0.85, 0.36, 0.20, 0.50],
            [-1.55, 0.30, 0.15, 0.48],
          ],
        ],
        deck: [[0.55, 0.46, 0.22, 0.58], [-0.35, 0.42, 0.20, 0.50]],
      },
      prop: {
        blades: 3, radius: 1.80, z: 5.38,
        spinnerR: 0.25, spinnerLen: 0.55, spinnerProfile: 'ogive',
        chordRoot: 0.30, chordTip: 0.16,
      },
      tail: {
        halfSpan: 2.50, rootChord: 1.35, tipChord: 0.85, law: 'taper', leSweep: 6,
        tipRound: 0.88, tcRoot: 0.10, tcTip: 0.09, y: 0.10, z: -4.80,
        finY: 0.20, finTop: [1.15, 0.20],
        fin: [[0.95, 0], [-0.60, 0], [-0.56, 0.86], [0.05, 1.15], [0.80, 0.72]],
        rudder: [[-0.60, -0.04], [-0.92, 0.06], [-0.80, 1.00], [-0.38, 0.98]],
        rudderHinge: -0.58,
      },
      // retracts REARWARD into centre-section nacelles and leaves the tyres
      // half exposed — the Il-2 never has a clean underside
      gear: {
        x: 1.75, z: 0.60, legLen: 1.05, wheelR: 0.444, tyreW: 0.26,
        retract: 'aft', alwaysVisible: true,
        tailZ: -5.05, tailLegLen: 0.34, tailR: 0.20, tailFixed: true,
      },
      nacelles: [
        [1.55, 0.26, 0.16, -0.20], [0.70, 0.28, 0.22, -0.32],
        [-0.40, 0.26, 0.20, -0.30], [-0.90, 0.16, 0.10, -0.22],
      ],
      // the chin duct that makes the nose look bearded and heavy
      chinDuct: {
        sections: [
          [4.95, 0.30, 0.13, -0.60], [4.20, 0.34, 0.19, -0.76], [3.00, 0.34, 0.20, -0.80],
          [1.60, 0.32, 0.18, -0.72], [0.60, 0.24, 0.12, -0.58],
        ],
        mouth: { w: 0.65, h: 0.25, z: 4.95, y: -0.60 },
        flap: { w: 0.55, h: 0.06, d: 0.30, z: 0.60, y: -0.62 },
      },
      // filter drum on the STARBOARD wing root only — deliberately not mirrored
      carbDrum: { x: 0.75, y: 0.32, z: 0.90, r: 0.13, len: 0.50 },
      exhaust: { perSide: 6, z0: 4.80, dz: 0.36, x: 0.56, y: 0.06, size: 0.13 },
      wingGuns: [
        { u: 0.185, r: 0.036, protrude: 0.34, fairing: true },
        { u: 0.245, r: 0.024, protrude: 0.22 },
      ],
      // The heaviest fit in the game, and the only one that is a mix. Four
      // FAB-50s live in the four centre-section BAYS inboard of the wheel
      // nacelles — an Il-2 has no bomb bay in the fuselage, it has four small
      // ones in the wing roots — and the last pair hangs on external racks
      // outboard of the nacelles. Ten RS-132 on rails outboard of those.
      //
      // These stations replace the bare `rails` block that used to be drawn
      // here unconditionally: the rails are the rocket fit's own hardware now,
      // so they arrive and leave with the rockets instead of being welded on.
      stores: {
        bomb: {
          len: 0.94, dia: 0.22, rack: 'bay',
          pairs: [
            { x: 0.85, dz: -0.25 },
            { x: 1.35, dz: -0.25 },
            { x: 2.35, dz: -0.22, len: 1.10, dia: 0.28, rack: 'sway' },
          ],
        },
        rocket: {
          len: 0.86, dia: 0.135,
          pairs: [{ x: 3.00 }, { x: 3.70 }, { x: 4.40 }, { x: 5.10 }, { x: 5.80 }],
        },
      },
    },
    color: 0x5a6349,
    // ---- finish: Il-2, 1942-43, AMT-4 / AMT-6 over AMT-7 ----
    // Green and black disruptive upper (the black the smaller share) over the
    // blue-grey underside, heavily sun-faded on top. Red stars, thinly
    // outlined, on the fuselage, fin and under the wings (*verify* against
    // photographs of the specific airframe and year).
    scheme: {
      pattern: 'disruptive', upper: [AP.AMT4, AP.AMT6], lower: AP.AMT7,
      coverage: 0.36, feature: 1.7, edge: 0.03, demarcY: -0.30, demarcSlope: -0.02, fade: 0.15,
      bands: [],
    },
    markings: [
      { glyph: 'su_star', on: 'fuselage', z: -2.75, y: 0.06, size: 0.85 },
      { glyph: 'su_star', on: 'fin', z: 0.10, y: 0.50, size: 0.66 },
      { glyph: 'su_star', on: 'wing', u: 0.66, face: 'lower', size: 1.10 },
    ],
    finish: {
      rough: 0.70, interior: 0x707368, blade: 0x2c2d2f, tip: null,
      spinner: AP.AMT4, bomb: 0x565a42,
    },
    weathering: {
      exhaust: { z: 2.95, len: 2.4, y: 0.05, halfH: 0.09, droop: 0.015, soot: 0.35 },
      oil: { z: 4.2, len: 2.0, halfW: 0.32, strength: 0.8 },
      walkway: { x0: 0.60, x1: 1.45, dz0: -1.0, dz1: 0.8, coverage: 0.16 },
    },
  },
  p51: {
    id: 'p51', name: 'P-51D Mustang', nation: 'USA',
    klass: 'Air Superiority', tier: 4,
    price: { silver: 12000, rp: 6000 },
    span: 11.3, len: 9.8,
    maxSpeed: 88, minSpeed: 28, accel: 11, hp: 50,
    rollRate: 3.0, pitchRate: 1.5, yawRate: 0.72,
    // --- flight model ---
    // Laminar wing, two-stage supercharger and enormous tankage: it keeps its
    // speed better than anything else and is still making power up high. The
    // belly radiator is the one soft spot, and a coolant hit ends the sortie.
    engines: 1, mass: 4600, wingArea: 21.8,
    stallSpeed: 28, structuralSpeed: 126, maxG: 8, climbRate: 13,
    powerplant: { name: 'Packard V-1650-7', kw: 1110, thrust: 38000 },
    critDensity: 0.52,
    fuelCapacity: 700, fuelBurn: 0.4, fireRisk: 0.3,
    // AN 01-60JE-1, P-51D Pilot's Flight Operating Instructions, landing
    // checklist: below 170 mph IAS before lowering the landing gear (full flap
    // below 165). 170 mph = 274 km/h, held with the gear down as well; 165 mph
    // = 265 km/h (which the stall-ratio floor in flapRipOf() lifts to 291).
    flapLimit: 265, airbrakeCd: 0.035,
    gearLimit: { vlo: 274, vle: 274 },
    convergence: 275,
    parts: {
      leftWing: 26, rightWing: 26, tail: 19, elevator: 9, rudder: 9,
      aileronL: 9, aileronR: 9, engine: 24, oilCooler: 8, fuelTank: 15,
      pilot: 12, controls: 12,
    },
    gun: { dmg: 5.2, rof: 13, speed: 840, ammo: 460, spread: 0.010 },
    bombs: { count: 2, radius: 32 },
    rockets: { count: 8, radius: 9 },
    look: { engine: 'inline', wing: 'tapered', canopy: 'bubble', bellyScoop: true, squareTail: true },
    // P-51D. Span 11.28, length 9.83, wing area 21.83 m², prop 3.40 m, FOUR
    // blades. The D-model is a razorback B with the rear decking SLICED AWAY,
    // and that cut-down is the first thing anyone names it by: the top line
    // falls sharply just behind the pilot and then runs low and near-straight
    // to the fin, with the dorsal fillet that the cut-down made necessary.
    shape: {
      wing: {
        // laminar wing: nearly straight leading edge, trailing edge swept
        // forward 10°, square tips. The old build had this exactly backwards.
        law: 'taper', rootChord: 2.61, tipChord: 1.25, leSweep: 3.5,
        tcRoot: 0.165, tcTip: 0.114, squareTip: true,
        y: -0.28, z: -0.235, dihedral: 5.0, filletAft: 1.00,
      },
      // note the step: half-height 0.60 -> 0.44 across 1.1 m behind the pilot
      fuselage: [
        [4.30, 0.31, 0.35, 0.02, 2.4], [3.75, 0.36, 0.46, 0.02, 2.4],
        [3.00, 0.39, 0.51, 0.01, 2.4], [1.60, 0.44, 0.56, 0.00, 2.3],
        [0.30, 0.45, 0.60, 0.02, 2.2], [-0.80, 0.40, 0.44, 0.02, 2.1],
        [-2.20, 0.30, 0.34, 0.04, 2.0], [-3.60, 0.19, 0.24, 0.07, 2.0],
        [-4.90, 0.08, 0.14, 0.09, 2.0],
      ],
      canopy: {
        z: 0.40, y: 0.55, tubBack: -0.45, flatScreen: true,
        glass: [[
          [1.30, 0.20, 0.10, 0.60], [1.00, 0.36, 0.21, 0.57], [0.50, 0.415, 0.26, 0.55],
          [-0.20, 0.40, 0.24, 0.54], [-0.70, 0.18, 0.09, 0.50],
        ]],
      },
      prop: {
        blades: 4, radius: 1.70, z: 4.33,
        spinnerR: 0.275, spinnerLen: 0.62, spinnerProfile: 'ogive',
        chordRoot: 0.30, chordTip: 0.20, hubR: 0.15,
      },
      tail: {
        halfSpan: 2.02, rootChord: 1.55, tipChord: 0.85, law: 'taper', leSweep: 5,
        tipRound: 0.88, tcRoot: 0.10, tcTip: 0.09, y: 0.06, z: -3.85,
        finY: 0.18, finTop: [1.32, 0.05],
        fin: [[0.95, 0], [-0.52, 0], [-0.50, 1.02], [-0.22, 1.28], [0.20, 1.30], [0.60, 0.70]],
        rudder: [[-0.52, -0.02], [-0.98, 0.06], [-0.88, 1.06], [-0.40, 1.12]],
        rudderHinge: -0.50,
        // The dorsal fillet fitted from June 1944 to cure the yaw instability
        // the cut-down fuselage introduced. Absolute body coordinates: it has
        // to sit ON the spine and grow into the fin leading edge, which is
        // exactly the curve that makes a D-model read from the side.
        fillet: [
          [-1.95, 0.02, 0.02, 0.40], [-2.40, 0.06, 0.16, 0.38],
          [-2.90, 0.09, 0.34, 0.40], [-3.15, 0.09, 0.46, 0.44],
        ],
      },
      gear: {
        x: 1.83, z: 0.85, legLen: 1.18, wheelR: 0.345, tyreW: 0.20, retract: 'in',
        tailZ: -4.20, tailLegLen: 0.34, tailR: 0.16,
      },
      // six .50 M2, three a side, staggered barrels
      wingGuns: [
        { u: 0.275, r: 0.016, protrude: 0.12 },
        { u: 0.342, r: 0.016, protrude: 0.20 },
        { u: 0.409, r: 0.016, protrude: 0.28 },
      ],
      // inlet BEHIND the wing trailing edge, exit under the fin leading edge,
      // with a boundary-layer splitter gap at the front lip
      bellyScoop: {
        sections: [
          [-0.65, 0.40, 0.13, -0.60], [-1.50, 0.42, 0.28, -0.72],
          [-2.50, 0.40, 0.26, -0.70], [-3.30, 0.30, 0.14, -0.60],
        ],
        exitDoor: { w: 0.56, h: 0.05, d: 0.34, z: -3.30, y: -0.66 },
      },
      // Merlin Mustangs breathe from UNDER the nose, not over it
      chinScoop: { w: 0.44, h: 0.18, len: 1.10, y: -0.58, z: 3.30 },
      // One 500 lb AN-M64 on the inboard wing rack a side, and the rocket tree
      // outboard of it: four 5 in HVAR a side on zero-length stubs, which is
      // the fit that made the D-model a ground-attack aeroplane.
      stores: {
        bomb: { len: 1.50, dia: 0.36, pairs: [{ x: 1.62 }] },
        rocket: {
          len: 1.70, dia: 0.13,
          pairs: [{ x: 2.40 }, { x: 3.00 }, { x: 3.60 }, { x: 4.20 }],
        },
      },
    },
    color: 0x8d939b,
    // ---- finish: P-51D, 1944-45, natural metal (V-06) ----
    // Bare aluminium, the roughness varying panel to panel; the puttied and
    // silver-lacquered laminar-flow front of the wing; the olive drab
    // anti-glare panel ahead of the windscreen. Star-and-bar with the
    // insignia-blue surround on the upper LEFT and lower RIGHT wing and both
    // fuselage sides, which is where the USAAF put them.
    scheme: {
      pattern: 'mono', upper: [AP.NMF], lower: AP.NMF, demarcY: -0.3, fade: 0,
      bands: [{ kind: 'top', z0: 1.28, z1: 4.40, halfW: 0.30, minNy: 0.30, hex: AP.US_ANA613, rough: 0.72 }],
    },
    nmf: { hex: AP.NMF, rough: [0.27, 0.43], puttyHex: 0xc9ccce, puttyChord: 0.40, puttyRough: 0.5 },
    markings: [
      { glyph: 'us_star_bar', on: 'wing', u: 0.60, face: 'upper', side: 'left', size: 1.80 },
      { glyph: 'us_star_bar', on: 'wing', u: 0.60, face: 'lower', side: 'right', size: 1.80 },
      { glyph: 'us_star_bar', on: 'fuselage', z: -2.55, y: 0.02, size: 1.16 },
    ],
    finish: {
      rough: 0.35, interior: 0x4f5a3b, blade: 0x2c2d2f, tip: 0xc9a23a, tipFrom: 0.93,
      spinner: AP.NMF, spinnerMetal: 1, spinnerRough: 0.30, bomb: 0x4d5244,
    },
    weathering: {
      exhaust: { z: 2.15, len: 2.3, y: 0.09, halfH: 0.07, droop: 0.012, soot: 0.55 },
      oil: { z: 2.9, len: 1.6, halfW: 0.26, strength: 0.6 },
    },
  },
};

// ---------------------------------------------------------------------------
// Atmosphere and the derived drag polar
// ---------------------------------------------------------------------------

export const GRAV = 9.8;

// Air density in game units. The world is compressed — a "fast" fighter here
// does 88 m/s, about a third of the real thing — so the density that turns
// airspeed into force has to be scaled up to match, or nothing would fly. 4.0
// is the number that makes the existing minSpeed figures come out as real stall
// speeds for the real masses and wing areas, which is a good sign it is right.
export const RHO0 = 4.0;

// The playable ceiling is 1 km, so altitude is stretched by ALT_SCALE to give
// the model a believable band to work in: the deck is thick air, 500 m behaves
// like 4 km and the ceiling like 8 km. REF_ALT is where the polar is defined —
// normal combat height — so top speeds match the specs where the fighting is.
const ALT_SCALE = 8;
const SCALE_HEIGHT = 9000;
const REF_ALT = 300;

export function airDensity(y) {
  const r = Math.exp((-(y - REF_ALT) * ALT_SCALE) / SCALE_HEIGHT);
  return RHO0 * Math.max(0.34, Math.min(1.16, r));
}

// ---------------------------------------------------------------------------
// Indicated airspeed, and the real-world limits that are quoted in it
// ---------------------------------------------------------------------------
//
// An airspeed indicator reads dynamic pressure, so INDICATED airspeed is the
// true airspeed scaled to the density the instrument is calibrated for. In
// this world that reference is RHO0: it is the density stallSpeed and the
// whole polar are defined at, so a stall "at 28" means 28 on the dial at any
// height, exactly as a real indicated stall speed does.
export function indicatedAirspeed(tas, y) {
  return tas * Math.sqrt(airDensity(y) / RHO0);
}

// Real air at sea level, kg/m3. The game's air is RHO0 because the world is
// compressed (see RHO0 above), so a handbook speed cannot be used as-is.
export const RHO_REAL = 1.225;

// A handbook gear or flap limit is a DYNAMIC-PRESSURE limit — it is the force
// on the doors and legs that matters, not the number on the dial — so a real
// indicated speed comes across at equal q: V_game = V_real * sqrt(1.225/RHO0).
// The same factor carries every type's real stall speed onto its game stall
// speed to within about fifteen per cent (P-51D 102 mph -> 25 m/s against the
// game's 28; Spitfire V 73 mph -> 18 against 21), which is the check that it is
// the right factor rather than merely a convenient one.
export const IAS_REAL_TO_GAME = Math.sqrt(RHO_REAL / RHO0);

// ---------------------------------------------------------------------------
// What the pilot reads
// ---------------------------------------------------------------------------
//
// Physics speeds are this world's compressed m/s (~0.553 of the real thing),
// and "m/s x 3.6" on the dial put a Zero cruising at 184 km/h and a Mustang
// flat out at 317. Every airspeed
// a player READS — the IAS tape, its stall mark, the gear limit printed beside
// the gear lamps, "Too fast for the gear — it comes down below N km/h", the
// overspeed warning, the hangar's top-speed figure — goes through this one
// helper instead, so the numbers agree with each other (the tape reads exactly
// the figure the warning quotes) and with the real aeroplanes.
//
// The scale is the world's own compression, undone: a real indicated speed
// comes into this world as V_real * IAS_REAL_TO_GAME (equal dynamic pressure,
// above), so the dial reads game m/s * 3.6 / IAS_REAL_TO_GAME = 6.51 km/h per
// game m/s. It is the one linear scale on which the numbers that decide how an
// aeroplane is FLOWN all read as the handbook prints them:
//   - gear limits: Zero 260, Spitfire 257, Fw 190 300, Il-2 280 (the P-51's
//     274 reads 291, its stall-ratio floor in gearLimits() below);
//   - landing-flap limits: Spitfire 225, Fw 190 320, Zero 250, Il-2 270 (P-51
//     265 -> 291, the same floor: flapRipOf());
//   - the stall, which the equal-q factor already carries within ~15% (the
//     dirty-stall mark reads Spitfire 119 against the Pilot's Notes' 73 mph =
//     117, P-51 157 against 102 mph = 164).
// The quoted top speeds then read Zero 403 / Spitfire 455 / Fw 190 520 /
// Il-2 390 / P-51 572 km/h. That is what the real aeroplanes' airspeed
// indicators showed flat out low down, where these battles are flown (P-51D
// ~600 at sea level, Fw 190 A-5 ~560, Spitfire Vb ~510, Il-2 ~390): the 703 /
// 653 / 597 of the type cards are TRUE airspeeds at the rated altitude, where
// the same dials read far less. No single factor can put both ends on the
// type cards — this world's speed range (top / stall ~3) is narrower than the
// real one (~4.5) — and an earlier 8.1 fitted to those altitude maxima read
// every handbook limit and stall ~25-35% high (the Fw 190's 300 km/h gear
// limit printed as 374). Physics never sees this number.
export const DISPLAY_KMH_PER_MS = 3.6 / IAS_REAL_TO_GAME;

/** Game m/s (TAS or IAS) -> the km/h figure shown to the player. */
export function displaySpeedKmh(ms) {
  const v = Number(ms);
  return Number.isFinite(v) ? v * DISPLAY_KMH_PER_MS : 0;
}

/** Inverse of displaySpeedKmh: a figure on the dial back to game m/s. */
export function gameSpeedFromDisplayKmh(kmh) {
  const v = Number(kmh);
  return Number.isFinite(v) ? v / DISPLAY_KMH_PER_MS : 0;
}

const gearLimitCache = new WeakMap();

// The undercarriage limits of a type in this game's INDICATED m/s:
//   vlo — fastest the gear may be operated (lowered) at;
//   vle — fastest it may be flown extended at.
// From spec.gearLimit, which carries the handbook figures in km/h IAS. A spec
// without one (a modded or future type) gets GEAR_LIMIT_STALL x its stall
// speed, which is where the documented types sit.
//
// That ratio is also a FLOOR under the converted handbook figures. The
// equal-q conversion carries real speeds over faithfully, but the game's stall
// speeds were authored on their own and do not all land where the conversion
// puts the real ones: the P-51's is 28 against a converted 25, so its handbook
// 274 km/h came out at only 1.5 x its stall where the real aeroplane had 1.7.
// The band between unstick and the gear limit is the whole climb-out, and on
// this world's compressed speed scale it is crossed in a few seconds anyway —
// so no type's limit is allowed closer to its own stall than the documented
// types sit (the Fw 190, the tightest, is at 1.65). Types already above the
// floor keep their handbook figure exactly.
const GEAR_LIMIT_STALL = 1.6;
export function gearLimits(spec) {
  let out = gearLimitCache.get(spec);
  if (out) return out;
  const src = spec && spec.gearLimit;
  const conv = (kmh) => (kmh / 3.6) * IAS_REAL_TO_GAME;
  const floor = ((spec && spec.stallSpeed) || 25) * GEAR_LIMIT_STALL;
  const vlo = src && src.vlo > 0 ? Math.max(floor, conv(src.vlo)) : floor;
  const vle = src && src.vle > 0 ? Math.max(floor, conv(src.vle)) : vlo;
  out = { vlo, vle, vloKmh: src ? src.vlo : null, vleKmh: src ? src.vle : null };
  gearLimitCache.set(spec, out);
  return out;
}

// The flap limits of a type, in this game's INDICATED m/s — spec.flapRip,
// [combat, take-off, landing], which planeEntity.js compares with the
// indicated airspeed (a flap limit is a dynamic-pressure limit, like the
// gear's). Derived here, once, from spec.flapLimit: the handbook's landing-
// flap figure in km/h IAS, carried across on the dial's own scale so the
// limit the pilot is quoted IS the handbook number. The combat and take-off
// stages are this game's, not the handbook's (the Spitfire's split flap had
// no intermediate stage at all): they keep the proportion to the landing
// stage the stage ladder was designed with. The same stall-ratio floor as
// the gear's (GEAR_LIMIT_STALL) sits under the landing figure, for the same
// reason — an approach at 1.45 x the clean stall has to fit under it — and
// only the P-51 is lifted by it (265 -> 291 km/h). A spec with no flapLimit
// keeps whatever flapRip it states.
const FLAP_STAGE_RATIO = [1.69, 1.34, 1];
export function flapRipOf(spec) {
  if (!(spec && spec.flapLimit > 0)) return spec && spec.flapRip ? spec.flapRip : [70, 55, 42];
  const land = Math.max(gameSpeedFromDisplayKmh(spec.flapLimit), (spec.stallSpeed || 25) * GEAR_LIMIT_STALL);
  return FLAP_STAGE_RATIO.map((k) => Math.round(land * k * 10) / 10);
}
for (const s of Object.values(PLANE_SPECS)) s.flapRip = flapRipOf(s);

const aeroCache = new WeakMap();

// Everything the flight model needs that follows from the spec rather than
// being authored: the wing's lift slope and its stalling angle, the induced
// drag factor, and the zero-lift drag that the quoted top speed implies.
//
// Deriving cd0 from maxSpeed instead of authoring it is what keeps the garage
// numbers honest: the aeroplane really does level out at exactly its quoted top
// speed, and when a modification adds 10% to maxSpeed the airframe gets the
// cleaner polar that would be needed to reach it.
export function planeAero(spec) {
  let a = aeroCache.get(spec);
  if (a) return a;

  const s = spec.wingArea;
  const weight = spec.mass * GRAV;
  const ar = (spec.span * spec.span) / s;
  const oswald = 0.78;
  const k = 1 / (Math.PI * oswald * ar);
  const clAlpha = (2 * Math.PI * ar) / (ar + 2); // finite-wing lift slope, /rad
  const clMax = (2 * weight) / (RHO0 * s * spec.stallSpeed * spec.stallSpeed);
  const qMaxS = 0.5 * RHO0 * spec.maxSpeed * spec.maxSpeed * s;
  const clLevel = weight / qMaxS; // lift coefficient in level flight, flat out

  // Propeller thrust falls off with speed — a prop is a fixed lump of power, so
  // it shoves hard when slow and runs out of authority near the top end. That
  // curve, not a flat force, is what makes acceleration feel like an aeroplane.
  const propKnee = spec.maxSpeed * 0.5;
  const thrustAtMax = spec.powerplant.thrust / (1 + spec.maxSpeed / propKnee);
  const cd0 = Math.max(0.014, thrustAtMax / qMaxS - k * clLevel * clLevel);

  a = {
    wingArea: s,
    aspect: ar,
    k,
    clAlpha,
    clMax,
    alphaCrit: clMax / clAlpha,
    cd0,
    clLevel,
    thrustStatic: spec.powerplant.thrust,
    propKnee,
    qRef: 0.5 * RHO0 * (spec.maxSpeed * 0.8) * (spec.maxSpeed * 0.8),
    weight,
  };
  aeroCache.set(spec, a);
  return a;
}

// ---------------------------------------------------------------------------
// Component layout — one box per part, in the aircraft's own local space
// (+Z nose, +Y canopy, +X left wing), exactly the frame buildPlaneMesh builds
// in. This is the aircraft's answer to combat/internals.js: the damage model
// asks which box a round actually passed through instead of rolling dice, so a
// burst through the tail takes the elevator and a burst through the nose takes
// the engine. Several boxes may name the same part (a wing is inner and outer
// panels), and the boxes deliberately overlap a little — a hit resolves to the
// smallest box that owns the point, which is how ailerons win over wings.
// ---------------------------------------------------------------------------

export const PART_LABELS = {
  leftWing: 'Left wing',
  rightWing: 'Right wing',
  tail: 'Tail',
  elevator: 'Elevator',
  rudder: 'Rudder',
  aileronL: 'Left aileron',
  aileronR: 'Right aileron',
  engine: 'Engine',
  oilCooler: 'Oil cooler',
  fuelTank: 'Fuel tank',
  pilot: 'Pilot',
  controls: 'Controls',
};

const partCache = new WeakMap();

function pbox(part, px, py, pz, hx, hy, hz) {
  return {
    part,
    label: PART_LABELS[part] || part,
    pos: [px, py, pz],
    half: [hx, hy, hz],
    // silhouette-ish weight, used when a blast has no impact point to trace
    weight: hx * hy + hy * hz + hx * hz,
  };
}

export function buildPlaneParts(spec) {
  let layout = partCache.get(spec);
  if (layout) return layout;

  const hs = spec.span * 0.5;
  const L = spec.len;
  const f = L * 0.5;
  const look = spec.look || {};
  // These two MUST be the same numbers buildPlaneGeometry lays the wing out
  // with, or the player shoots at a wing that is not where the damage model
  // thinks it is. They come off the same spec block for exactly that reason.
  const wingShape = (spec.shape && spec.shape.wing) || {};
  const wingY = wingShape.y != null ? wingShape.y : look.armoured ? -0.24 : -0.12;
  const wingZ = wingShape.z != null ? wingShape.z : L * 0.04;
  const boxes = [];

  // Engine bay and its cooling, which is where every head-on burst lands. The
  // cooler boxes follow the DUCTS the builder actually draws — same half
  // extents as before, so the odds a blast picks a cooler are unchanged, but a
  // round now has to pass through the radiator you can see to break it.
  const shp = spec.shape || {};
  boxes.push(pbox('engine', 0, 0, f * 0.72, 0.55, 0.5, f * 0.26));
  if (shp.bellyScoop) {
    boxes.push(pbox('oilCooler', 0, -0.62, -1.6, 0.35, 0.24, 0.6));
  } else if (shp.chinDuct) {
    boxes.push(pbox('oilCooler', 0, -0.62, 3.0, 0.5, 0.3, 0.42));
  } else if (shp.ducts) {
    // starboard coolant radiator and port oil cooler, under their own wings
    boxes.push(pbox('oilCooler', -1.70, wingY - 0.3, wingZ - 0.2, 0.3, 0.25, 0.5));
    boxes.push(pbox('oilCooler', 1.40, wingY - 0.24, wingZ - 0.2, 0.28, 0.2, 0.55));
  } else if (look.bellyScoop) {
    boxes.push(pbox('oilCooler', 0, -0.55, -L * 0.02, 0.35, 0.24, 0.6));
  } else if (look.chinRad) {
    boxes.push(pbox('oilCooler', 0, -0.5, L * 0.24, 0.3, 0.25, 0.5));
    boxes.push(pbox('oilCooler', hs * 0.32, -0.42, -L * 0.02, 0.28, 0.2, 0.55));
  } else {
    // radials cool through the cowl, so the damage sits right around the barrel
    boxes.push(pbox('oilCooler', 0, -0.32, f * 0.62, 0.5, 0.3, 0.42));
  }

  // fuselage tank between engine and pilot, plus the wing-root cells
  boxes.push(pbox('fuelTank', 0, -0.12, L * 0.11, 0.4, 0.3, L * 0.09));
  for (const side of [1, -1]) {
    boxes.push(pbox('fuelTank', side * hs * 0.26, wingY, wingZ, hs * 0.11, 0.16, 0.62));
  }

  boxes.push(pbox('pilot', 0, 0.34, look.canopy === 'twoSeat' ? L * 0.06 : 0, 0.3, 0.42, 0.55));
  boxes.push(pbox('controls', 0, -0.05, -L * 0.19, 0.28, 0.3, L * 0.11));

  // wings: an inner panel carrying the guns and root, an outer panel, and the
  // aileron hung on the outer trailing edge
  for (const [part, aile, side] of [['leftWing', 'aileronL', 1], ['rightWing', 'aileronR', -1]]) {
    boxes.push(pbox(part, side * hs * 0.33, wingY, wingZ, hs * 0.22, 0.16, 0.95));
    boxes.push(pbox(part, side * hs * 0.75, wingY, wingZ - 0.1, hs * 0.24, 0.13, 0.7));
    boxes.push(pbox(aile, side * hs * 0.72, wingY, wingZ - 0.72, hs * 0.2, 0.11, 0.28));
  }

  // empennage: rear fuselage and fin base are "tail", the moving surfaces are
  // their own parts so a clipped elevator costs pitch and nothing else
  // stabZ is a stated measurement now, so the elevator box sits on the elevator
  // instead of wherever -len * 0.42 happened to fall. Extents are unchanged.
  const stabZ = (shp.tail && shp.tail.z != null) ? shp.tail.z : -L * 0.42;
  boxes.push(pbox('tail', 0, 0.05, stabZ + L * 0.06, 0.26, 0.32, L * 0.13));
  boxes.push(pbox('tail', 0, 0.5, stabZ, 0.1, 0.34, 0.45));
  for (const side of [1, -1]) {
    boxes.push(pbox('tail', side * spec.span * 0.11, 0.06, stabZ, spec.span * 0.09, 0.09, 0.34));
    boxes.push(pbox('elevator', side * spec.span * 0.12, 0.06, stabZ - 0.42, spec.span * 0.1, 0.1, 0.24));
  }
  boxes.push(pbox('rudder', 0, 0.58, stabZ - L * 0.04, 0.09, 0.3, 0.22));

  let weightSum = 0;
  for (const b of boxes) weightSum += b.weight;

  layout = { boxes, weightSum, hp: spec.parts, labels: PART_LABELS };
  partCache.set(spec, layout);
  return layout;
}

// Squared distance from a point to a box, 0 when the point is inside it.
function distToBox(p, b) {
  let d = 0;
  for (let i = 0; i < 3; i++) {
    const v = i === 0 ? p.x : i === 1 ? p.y : p.z;
    const gap = Math.abs(v - b.pos[i]) - b.half[i];
    if (gap > 0) d += gap * gap;
  }
  return d;
}

// Slab test in the box's own frame; returns the entry distance, 0 if the ray
// starts inside, or -1 on a miss.
function rayBox(o, d, b) {
  let tmin = 0;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const oi = i === 0 ? o.x : i === 1 ? o.y : o.z;
    const di = i === 0 ? d.x : i === 1 ? d.y : d.z;
    const lo = b.pos[i] - b.half[i];
    const hi = b.pos[i] + b.half[i];
    if (Math.abs(di) < 1e-9) {
      if (oi < lo || oi > hi) return -1;
      continue;
    }
    let t1 = (lo - oi) / di;
    let t2 = (hi - oi) / di;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

// Which part did this round strike? `local` is the impact point in aircraft
// space; pass `dir` (also in aircraft space) when the shot direction is known
// and the round is traced through the airframe instead of being snapped to the
// nearest box — a burst entering the wing root and running inboard should find
// the fuel tank, not the wing skin it came in through.
export function tracePlaneParts(spec, local, dir = null) {
  const { boxes } = buildPlaneParts(spec);
  let best = null;

  if (dir) {
    let bestT = Infinity;
    for (const b of boxes) {
      const t = rayBox(local, dir, b);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = b;
      }
    }
    if (best) return best;
  }

  // no direction, or the trace missed everything (impacts land on the outer
  // hit box, which is roomier than the parts inside it): take the nearest box,
  // and let the smaller of two overlapping boxes win the point
  let bestD = Infinity;
  let bestVol = Infinity;
  for (const b of boxes) {
    const d = distToBox(local, b);
    const vol = b.half[0] * b.half[1] * b.half[2];
    if (d < bestD - 1e-6 || (d < bestD + 1e-6 && vol < bestVol)) {
      bestD = d;
      bestVol = vol;
      best = b;
    }
  }
  return best;
}

// Blast and other hits that arrive without a location still have to break
// something plausible: pick a box in proportion to how much of the aeroplane it
// is. This is the old random roll, except the odds now come from the geometry.
export function randomPlanePart(spec) {
  const { boxes, weightSum } = buildPlaneParts(spec);
  let r = Math.random() * weightSum;
  for (const b of boxes) {
    r -= b.weight;
    if (r <= 0) return b;
  }
  return boxes[boxes.length - 1];
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------
//
// Everything from here down builds ONE aircraft's geometry, and
// cachedPlaneGeometry() keeps it: planeEntity.js builds a fresh mesh for every
// spawn, so a twelve-aeroplane battle used to construct twelve identical sets
// of buffers and twelve identical sets of materials. Now the buffers are built
// once per spec and the materials come from the shared factory, so a spawn is
// a handful of Object3D allocations.

// A triangle with no area has no face normal, and computeVertexNormals turns
// that into NaN — which takes the whole mesh off the screen rather than one
// triangle. The control-surface cutouts below are built from PAIRS of stations
// at the same span station, so degenerate quads are normal here, not
// exceptional, and every builder goes through this.
function pushTri(v, a, b, c) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const wx = c[0] - a[0];
  const wy = c[1] - a[1];
  const wz = c[2] - a[2];
  const nx = uy * wz - uz * wy;
  const ny = uz * wx - ux * wz;
  const nz = ux * wy - uy * wx;
  if (nx * nx + ny * ny + nz * nz < 1e-14) return;
  v.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

function pushQuad(v, a, b, c, d) {
  pushTri(v, a, b, c);
  pushTri(v, a, c, d);
}

function geoFrom(v) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

// Skin a chain of equal-length point rings into a closed tube. Rings run along
// the part's own axis and each ring is ordered the same way round, which is
// what keeps the normals outward without a second pass.
function skinRings(rings, capStart = true, capEnd = true) {
  const v = [];
  const n = rings[0].length;
  for (let s = 0; s < rings.length - 1; s++) {
    const r0 = rings[s];
    const r1 = rings[s + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      pushQuad(v, r0[i], r0[j], r1[j], r1[i]);
    }
  }
  if (capStart) {
    const r = rings[0];
    for (let i = 1; i < n - 1; i++) pushTri(v, r[0], r[i + 1], r[i]);
  }
  if (capEnd) {
    const r = rings[rings.length - 1];
    for (let i = 1; i < n - 1; i++) pushTri(v, r[0], r[i], r[i + 1]);
  }
  return geoFrom(v);
}

// Lofted body: a chain of rings along Z, skinned with quads.
// Aircraft fuselages are round and tapered, which no amount of stacked boxes
// ever really sells. Sections are [z, halfWidth, halfHeight, yCentre, n].
//
// `n` is a SUPERELLIPSE exponent: |x/hw|^n + |y/hh|^n = 1. n = 2 is exactly the
// ellipse this used to be able to draw and nothing else, which is why the Il-2's
// armoured shell came out as a smooth fighter tube — a slab-sided box was not
// expressible at any resolution. n = 4-6 gives the rounded-corner box the
// bronekorpus actually is; n = 2.3-2.6 gives the flat-ish top decking and
// rounded-corner sides of a Merlin fuselage. A section may set its own, so one
// body can be boxy at the firewall and oval at the tail post.
function loftZ(sections, sides = 8) {
  const rings = sections.map(([z, hw, hh, y = 0, n = 2]) => {
    const pts = [];
    const p = 2 / n;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const s = Math.sin(a);
      const c = Math.cos(a);
      const sx = n === 2 ? s : Math.sign(s) * Math.abs(s) ** p;
      const cy = n === 2 ? c : Math.sign(c) * Math.abs(c) ** p;
      pts.push([sx * hw, y + cy * hh, z]);
    }
    return pts;
  });
  // sections run nose-first (+Z down to -Z), which is the ring order skinRings
  // wants for outward normals
  const v = [];
  const n = sides;
  for (let s = 0; s < rings.length - 1; s++) {
    const r0 = rings[s];
    const r1 = rings[s + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      pushTri(v, r0[i], r1[j], r1[i]);
      pushTri(v, r0[i], r0[j], r1[j]);
    }
  }
  const capA = rings[0];
  const capB = rings[rings.length - 1];
  for (let i = 1; i < n - 1; i++) {
    pushTri(v, capA[0], capA[i + 1], capA[i]);
    pushTri(v, capB[0], capB[i], capB[i + 1]);
  }
  return geoFrom(v);
}

// A flat plate whose outline is drawn in the ZY plane and extruded across the
// span: fins, rudders, gear doors. `pts` are [z, y].
function plateZY(pts, thick) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  geo.translate(0, 0, -thick / 2);
  geo.rotateY(-Math.PI / 2); // shape X becomes world Z, the extrusion becomes span
  return geo;
}

function boxAt(w, h, d, x, y, z) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

// cylinder lying along Z: barrels, exhaust stubs, the pitot head
function tubeZ(r0, r1, len, seg, x, y, z) {
  const g = new THREE.CylinderGeometry(r0, r1, len, seg);
  g.rotateX(Math.PI / 2);
  return g.translate(x, y, z);
}

// cylinder lying along X: wheels and axles
function tubeX(r0, r1, len, seg, x, y, z) {
  const g = new THREE.CylinderGeometry(r0, r1, len, seg);
  g.rotateZ(Math.PI / 2);
  return g.translate(x, y, z);
}

// upright cylinder: oleo legs, the aerial mast
function tubeY(r0, r1, len, seg, x, y, z) {
  return new THREE.CylinderGeometry(r0, r1, len, seg).translate(x, y, z);
}

// A thin bar from a to b — the aerial wire, gear bracing, canopy rails.
function barBetween(ax, ay, az, bx, by, bz, radius, seg = 4) {
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

// A hoop across the fuselage in the XY plane: canopy framing. The torus is
// built at the mean radius and only stretched to the oval from there, so the
// frame keeps a roughly constant section instead of thinning to a hair.
function hoopXY(hw, hh, tube, y, z, seg = 12) {
  const r = (hw + hh) * 0.5;
  const g = new THREE.TorusGeometry(r, tube, 3, seg);
  g.scale(hw / r, hh / r, 1);
  return g.translate(0, y, z);
}

// ---------------------------------------------------------------------------
// wings
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// A planform object, resolved once per panel from the spec's shape block. This
// replaces the old `kind` string: five aeroplanes sharing four hard-coded chord
// laws is exactly why three of them wore the same wing.
//
//   law        'ellipse' | 'taper' | 'arrow'
//   rootChord  chord at the centreline, metres
//   tipChord   chord at the tip (ellipse derives its own)
//   leSweep    LEADING-edge sweepback, degrees. On a real wing the trailing
//              edge is whatever falls out of root chord, tip chord and this —
//              which is the relationship the old "displace the mid-chord" law
//              threw away, and why the Mustang's wing came out as a Zero's.
//   breakU     'arrow' only: where the rectangular centre section ends
//   tipRound   round the outer (1 - tipRound) of the half-span to a point
//   squareTip  cut the tip off square at full tip chord (Fw 190, Mustang)
//   tcRoot/tcTip  thickness/chord at root and tip. Thickness follows CHORD, so
//              the outer wing is a thin blade instead of the fat slab that
//              cancelled out every planform fix.
//   dihedral   degrees, and dihedralBreak the station it starts from (the
//              Il-2's centre section is dead flat and the break is visible
//              head-on; everything else breaks at the root)
function makePlanform(src, spanHalf, defaults = {}) {
  const s = { ...defaults, ...(src || {}) };
  const law = s.law || 'taper';
  const rootChord = s.rootChord != null ? s.rootChord : 2.0;
  const tipChord = s.tipChord != null ? s.tipChord : rootChord * 0.5;
  const pf = {
    law,
    rootChord,
    tipChord,
    spanHalf,
    leTan: Math.tan((s.leSweep || 0) * DEG),
    breakU: s.breakU != null ? s.breakU : 0.35,
    tipRound: s.squareTip ? null : s.tipRound != null ? s.tipRound : law === 'ellipse' ? null : 0.94,
    squareTip: !!s.squareTip,
    tcRoot: s.tcRoot != null ? s.tcRoot : 0.15,
    tcTip: s.tcTip != null ? s.tcTip : 0.10,
    dih: (s.dihedral != null ? s.dihedral : 3.4) * DEG,
    dihBreak: s.dihedralBreak || 0,
    foldBreak: s.foldBreak || 0,
    y: s.y != null ? s.y : -0.12,
    z: s.z != null ? s.z : 0,
    filletAft: s.filletAft != null ? s.filletAft : 0.85,
  };
  return pf;
}

// Where the leading edge sits and how much chord there is, at one spanwise
// station, in the panel's own frame with the ROOT chord centred on z = 0.
// `sweep` is the chord centre, which is what wingSlab wants.
function planformAt(pf, u) {
  const uu = u < 0 ? 0 : u > 1 ? 1 : u;
  const rc = pf.rootChord;
  let chord;
  let centre;

  if (pf.law === 'ellipse') {
    // A true elliptic chord distribution laid about a STRAIGHT QUARTER-CHORD
    // line. That is the Spitfire wing: the leading edge sweeps back only
    // 0.25 x the lost chord (nearly straight) while the trailing edge sweeps
    // FORWARD by 0.75 x it. Bowing both edges equally makes a lens, not a
    // Spitfire, and a lens is what this used to build.
    chord = rc * Math.sqrt(Math.max(0, 1 - uu * uu));
    centre = 0.25 * (rc - chord);
    return { chord: Math.max(0.02, chord), sweep: centre };
  }

  if (pf.law === 'arrow') {
    // Il-2: a rectangular centre section, then outer panels whose leading edge
    // kicks back at the break while the trailing edge runs DEAD STRAIGHT to a
    // rounded tip. Straight back edge, swept front edge, kinked in plan.
    chord = uu <= pf.breakU
      ? rc
      : lerp(rc, pf.tipChord, (uu - pf.breakU) / (1 - pf.breakU));
    // trailing edge pinned at the root value for the whole span
    centre = chord * 0.5 - rc * 0.5;
  } else {
    chord = lerp(rc, pf.tipChord, uu);
    const lead = rc * 0.5 - pf.leTan * pf.spanHalf * uu;
    centre = lead - chord * 0.5;
  }

  // A rounded tip closes the chord to a point about its own mid-chord over the
  // outer few per cent of span, instead of the old `chord *= 0.55` cliff that
  // left every aeroplane in the file with a blunt chopped stub.
  if (pf.tipRound != null && uu > pf.tipRound) {
    const t = (uu - pf.tipRound) / (1 - pf.tipRound);
    chord *= Math.sqrt(Math.max(0, 1 - t * t));
  }
  return { chord: Math.max(0.02, chord), sweep: centre };
}

// Dihedral as a per-station height rather than a rotation at the root, so a
// flat centre section with an outboard break is expressible at all.
function dihedralY(pf, u) {
  if (!pf.dihBreak) return 0;
  return pf.spanHalf * Math.max(0, u - pf.dihBreak) * Math.tan(pf.dih);
}

// How much of the local chord a hinged surface takes off the trailing edge.
const WING_CUT = 0.26;
const TAIL_CUT = 0.42;
// Spanwise extent of each surface, as a fraction of the half-span. These match
// the aileron boxes in buildPlaneParts, so a round that hits the aileron in the
// damage model hits the piece of geometry the player can see moving.
const FLAP_SPAN = [0.15, 0.5];
const AIL_SPAN = [0.56, 0.95];
const ELEV_SPAN = [0.04, 0.97];

// One spanwise station of a wing panel. `cut` is how much chord has been taken
// off the back of it to leave room for a control surface. Thickness follows the
// local CHORD and the local t/c, not the span — an outer panel at 15% t/c on a
// 1.2 m chord is a plank, and a plank cancels out any planform work done on it.
function station(pf, sign, u, cut) {
  const { chord, sweep } = planformAt(pf, u);
  return {
    u,
    x: sign * pf.spanHalf * u,
    z: sweep,
    c: chord,
    t: Math.max(0.012, chord * lerp(pf.tcRoot, pf.tcTip, u) * 0.5),
    y: dihedralY(pf, u),
    cut,
  };
}

// Where to take spanwise sections. Stations cost about eight triangles a bay,
// so they go where the curvature is: a straight taper needs almost none in the
// middle, an ellipse needs them clustered out at the tip where sqrt(1 - u²)
// collapses, and both need a pair either side of any crease.
function baseStations(pf) {
  const list = pf.law === 'ellipse'
    ? [0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.7, 0.79, 0.86, 0.91, 0.95, 0.975, 0.99, 1]
    : [0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84, 0.92, 1];
  const creases = [];
  if (pf.law === 'arrow') creases.push(pf.breakU);
  if (pf.dihBreak > 0 && Math.abs(pf.dihBreak - pf.breakU) > 1e-3) creases.push(pf.dihBreak);
  // the Zero's 500 mm folding-tip line is a visible break, not a panel line
  if (pf.foldBreak > 0) creases.push(pf.foldBreak);
  for (const c of creases) list.push(c - 0.004, c + 0.004);
  if (pf.tipRound != null) {
    const r = pf.tipRound;
    list.push(r, r + (1 - r) * 0.45, r + (1 - r) * 0.75, r + (1 - r) * 0.92);
  }
  return [...new Set(list.map((u) => Math.round(u * 1e4) / 1e4))]
    .filter((u) => u >= 0 && u <= 1)
    .sort((a, b) => a - b);
}

// Station list for a wing half, with a pair of coincident stations at every
// control-surface boundary so the cutout has a wall instead of a smear.
function wingStations(pf, sign, spans) {
  const inside = (u) => spans.some(([a, b]) => u > a + 1e-6 && u < b - 1e-6);
  const base = baseStations(pf);
  const bounds = [];
  for (const [a, b] of spans) bounds.push(a, b);
  const marks = [];
  for (const u of bounds) marks.push({ u, dup: true });
  for (const u of base) {
    if (bounds.some((b) => Math.abs(b - u) < 0.03)) continue;
    marks.push({ u, dup: false });
  }
  marks.sort((p, q) => p.u - q.u);
  const st = [];
  for (const m of marks) {
    if (m.dup) {
      st.push(station(pf, sign, m.u, inside(m.u - 1e-3) ? WING_CUT : 0));
      st.push(station(pf, sign, m.u, inside(m.u + 1e-3) ? WING_CUT : 0));
    } else {
      st.push(station(pf, sign, m.u, inside(m.u) ? WING_CUT : 0));
    }
  }
  return st;
}

// Skin a station list into a thin aerofoil slab. `flip` reverses the winding
// for the starboard panel, whose stations run the other way along X — without
// it that wing is built inside out and lit from the wrong side, which is
// exactly what the old builder did.
function wingSlab(st, { flip = false, capTip = true, cut = 0 } = {}) {
  const v = [];
  const quad = flip
    ? (a, b, c, d) => pushQuad(v, d, c, b, a)
    : (a, b, c, d) => pushQuad(v, a, b, c, d);
  const lead = (s) => s.z + s.c * 0.5;
  const trail = (s) => s.z - s.c * 0.5 + s.c * (s.cut || cut);
  // s.y carries the dihedral for a wing that breaks outboard of the root
  const P = (s, y, z) => [s.x, (s.y || 0) + y, z];
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i];
    const b = st[i + 1];
    const aL = lead(a);
    const aT = trail(a);
    const bL = lead(b);
    const bT = trail(b);
    quad(P(a, a.t, aL), P(b, b.t, bL), P(b, b.t, bT), P(a, a.t, aT));
    quad(P(a, -a.t, aT), P(b, -b.t, bT), P(b, -b.t, bL), P(a, -a.t, aL));
    quad(P(a, -a.t, aL), P(b, -b.t, bL), P(b, b.t, bL), P(a, a.t, aL));
    quad(P(a, a.t, aT), P(b, b.t, bT), P(b, -b.t, bT), P(a, -a.t, aT));
  }
  if (capTip) {
    const e = st[st.length - 1];
    const eL = lead(e);
    const eT = trail(e);
    quad(P(e, e.t, eL), P(e, e.t, eT), P(e, -e.t, eT), P(e, -e.t, eL));
  }
  return geoFrom(v);
}

// The moving half of the trailing edge: aileron, flap or elevator. Built in the
// wing's own frame and then slid forward so its origin sits ON the hinge line,
// which is what lets the entity deflect it with a single rotation.
function controlSlab(pf, sign, u0, u1, cut, flip) {
  const N = 4;
  const st = [];
  let hinge = 0;
  let yOff = 0;
  for (let i = 0; i <= N; i++) {
    const u = u0 + (u1 - u0) * (i / N);
    const { chord, sweep } = planformAt(pf, u);
    const zTrail = sweep - chord * 0.5;
    const zHinge = zTrail + chord * cut;
    if (i === Math.round(N / 2)) {
      hinge = zHinge;
      yOff = dihedralY(pf, u);
    }
    st.push({
      x: sign * pf.spanHalf * u,
      z: (zHinge + zTrail) * 0.5,
      c: Math.max(0.02, zHinge - zTrail) * 0.97,
      t: Math.max(0.01, chord * lerp(pf.tcRoot, pf.tcTip, u) * 0.5 * 0.8),
      y: dihedralY(pf, u),
      cut: 0,
    });
  }
  const geo = wingSlab(st, { flip, capTip: true });
  // origin ON the hinge line, and on the panel's own dihedral height, so the
  // surface deflects about the hinge instead of swinging through an arc
  geo.translate(0, -yOff, -hinge);
  return { geo, hinge, yOff };
}

// Fuselage sections for one type, nose (+Z) to tail (-Z). A spec that states
// its own table in metres gets it; the three shared tables below survive only
// as the fallback, because sharing one "slim inline nose" between a Spitfire
// and a Mustang means neither of them gets its own.
function fuselageSections(spec) {
  const shape = spec.shape || {};
  if (shape.fuselage) return shape.fuselage;
  const { len } = spec;
  const look = spec.look || {};
  const f = len / 2;
  if (look.engine === 'radial') {
    const cowl = look.wideCowl ? 0.68 : 0.6;
    return [
      [f * 0.98, cowl * 0.86, cowl * 0.86],
      [f * 0.82, cowl, cowl],
      [f * 0.5, cowl * 0.92, cowl * 0.95],
      [f * 0.12, 0.5, 0.56, 0.02],
      [-f * 0.3, 0.36, 0.42, 0.02],
      [-f * 0.72, 0.19, 0.26, 0.04],
      [-f, 0.07, 0.14, 0.06],
    ];
  }
  if (look.armoured) {
    // Il-2: deep armoured bathtub around the engine and cockpit
    return [
      [f * 0.98, 0.3, 0.32],
      [f * 0.78, 0.46, 0.5, -0.02],
      [f * 0.42, 0.62, 0.66],
      [f * 0.02, 0.66, 0.7, 0.02],
      [-f * 0.36, 0.42, 0.46, 0.04],
      [-f * 0.74, 0.22, 0.28, 0.06],
      [-f, 0.08, 0.15, 0.08],
    ];
  }
  // slim inline nose: Spitfire, Mustang
  return [
    [f * 0.99, 0.2, 0.22],
    [f * 0.84, 0.34, 0.38, -0.01],
    [f * 0.52, 0.46, 0.52],
    [f * 0.1, 0.5, 0.56, 0.02],
    [-f * 0.32, 0.34, 0.4, 0.03],
    [-f * 0.72, 0.18, 0.25, 0.05],
    [-f, 0.07, 0.13, 0.07],
  ];
}

// Canopy sections, and the interior that has to exist behind them now that the
// glass is actually transparent. [z, halfWidth, halfHeight, yCentre].
//
// `glass` is a LIST of glazed volumes, not one: a two-seater is defined by the
// gap between its cockpits, and one shared loft cannot draw a gap. The Il-2's
// tall pilot hood, bare turtledeck and lower gunner station are three separate
// lofts at three different heights, which is the whole shape. `deck` is solid
// skin, not glass, and goes into the body bin.
function canopySections(spec) {
  const shape = spec.shape || {};
  if (shape.canopy && shape.canopy.glass) {
    const c = shape.canopy;
    const first = c.glass[0];
    const last = c.glass[c.glass.length - 1];
    return {
      y: c.y != null ? c.y : 0.5,
      z: c.z != null ? c.z : 0,
      front: first[0][0],
      back: last[last.length - 1][0],
      glass: c.glass,
      deck: c.deck || null,
      flatScreen: !!c.flatScreen,
      tubBack: c.tubBack,
      gunnerZ: c.gunnerZ,
      sections: first,
    };
  }

  const look = spec.look || {};
  const len = spec.len;
  const z = look.engine === 'radial' ? len * 0.06 : len * 0.04;
  const y = look.armoured ? 0.62 : 0.5;
  const wrap = (sections) => ({
    y,
    z,
    front: sections[0][0],
    back: sections[sections.length - 1][0],
    glass: [sections],
    deck: null,
    flatScreen: false,
    sections,
  });
  if (look.canopy === 'bubble') {
    return wrap([
      [z + 1.0, 0.16, 0.1, y],
      [z + 0.55, 0.4, 0.3, y],
      [z - 0.35, 0.42, 0.34, y],
      [z - 1.0, 0.22, 0.14, y],
    ]);
  }
  if (look.canopy === 'twoSeat') {
    return wrap([
      [z + 1.3, 0.2, 0.14, y],
      [z + 0.8, 0.44, 0.34, y],
      [z - 1.3, 0.44, 0.32, y],
      [z - 2.0, 0.26, 0.18, y],
    ]);
  }
  return wrap([
    [z + 0.9, 0.2, 0.13, y],
    [z + 0.5, 0.38, 0.3, y],
    [z - 0.75, 0.38, 0.28, y],
    [z - 1.35, 0.2, 0.13, y],
  ]);
}

// ---------------------------------------------------------------------------
// propeller
// ---------------------------------------------------------------------------

// A blade with real twist: sections stacked along the radius, each rotated
// about the blade's own axis so the root bites hard and the tip is nearly flat.
// Two crossed boxes never looked like a propeller from the cockpit, and the
// cockpit is where the player spends the match.
function propBlade(hubR, tipR, chordRoot, chordTip, twistRoot, twistTip, squareTip = false) {
  const N = 5;
  const rings = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const r = hubR + (tipR - hubR) * u;
    // fattest at about a third of the radius, tapering to a rounded tip — or,
    // on the Fw 190's VDM paddles, near-constant width all the way out
    const shape = squareTip ? 0.9 + 0.14 * Math.sin(Math.PI * u) : 0.82 + 0.35 * Math.sin(Math.PI * u);
    const c = (chordRoot + (chordTip - chordRoot) * u) * shape;
    const th = 0.055 * (1 - 0.62 * u);
    const a = twistRoot + (twistTip - twistRoot) * u;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const pt = (dz, dx) => [dx * ca + dz * sa, r, dz * ca - dx * sa];
    rings.push([
      pt(c * 0.5, th * 0.35),
      pt(-c * 0.5, th * 0.2),
      pt(-c * 0.5, -th * 0.2),
      pt(c * 0.5, -th * 0.35),
    ]);
  }
  return skinRings(rings, true, true);
}

// The spinner, built from the base back plate forward to the tip so a spec can
// state its real base diameter and length. Prop diameter and spinner size
// relative to the nose are a large part of how a fighter's front end reads, and
// every aircraft in this file used to fly the identical 0.34 x 0.55 m cone: the
// Fw 190's blunt 0.62 m spinner filling a 1.30 m cowl and the Zero's little
// 0.35 m bullet are opposite ends of the same measurement.
function spinnerGeo(r, len, profile) {
  // four rings is enough for an ogive and saves ~60 triangles a nose over six
  const N = 4;
  const sections = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // an ogive stays fat most of the way and then rounds over; a cone is a cone
    const rr = profile === 'cone' ? r * (1 - t) : r * Math.sqrt(Math.max(0, 1 - t * t)) ** 0.75;
    sections.push([len * t, Math.max(0.006, rr), Math.max(0.006, rr)]);
  }
  sections.reverse(); // loftZ wants nose-first for outward normals
  return loftZ(sections, 16);
}

// ---------------------------------------------------------------------------
// ordnance
// ---------------------------------------------------------------------------
//
// Aircraft in this game have always had a `bombs` and a `rockets` block in
// their spec and always dropped from an empty wing. They carry the stores now.
//
// Two pieces of hardware per station, and the difference between them is the
// whole point: the RACK is bolted to the aeroplane and stays there for the
// sortie, and the STORE hangs off it until it is released. They are therefore
// different objects — every rack of a kind merges into one buffer because they
// never move, while every store is its own mesh because each one has to be
// able to disappear on its own.
//
// The store bodies are built ONCE at unit length about their own centre and
// scaled per station, so a 60 kg Japanese bomb and an SC 250 four times its
// weight are the same buffer at different scales. That also means the object
// the release code is handed has its origin at the store's centre of mass,
// which is exactly where a bomb should appear when it leaves the rack.
const BOMB_CAL = 0.22; // canonical body diameter at unit length (fineness ~4.5)
const ROCKET_CAL = 0.16;

// A tapered body, a parallel mid-section, a boat tail, and four fins in a
// cruciform. That silhouette is what says "bomb" at fifty metres; the exact
// nose radius does not.
function addBombBody(bin) {
  add(bin, loftZ([
    [0.500, 0.014, 0.014], [0.445, 0.058, 0.058], [0.380, 0.092, 0.092],
    [0.280, 0.110, 0.110], [0.020, 0.110, 0.110], [-0.150, 0.103, 0.103],
    [-0.300, 0.078, 0.078], [-0.400, 0.056, 0.056], [-0.470, 0.048, 0.048],
  ], 8));
  // the fin can: four swept plates, and the band that ties their tips together
  for (let i = 0; i < 4; i++) {
    const fin = plateZY([
      [-0.20, 0.050], [-0.33, 0.142], [-0.50, 0.142], [-0.50, 0.050],
    ], 0.016);
    fin.rotateZ((i * Math.PI) / 2);
    add(bin, fin);
  }
  add(bin, tubeZ(0.142, 0.142, 0.10, 10, 0, 0, -0.45));
}

// A slim motor tube with a fatter warhead over the front of it and four small
// tail fins — a rocket reads as a rocket by being thinner than a bomb.
function addRocketBody(bin) {
  add(bin, loftZ([
    [0.500, 0.010, 0.010], [0.455, 0.046, 0.046], [0.400, 0.070, 0.070],
    [0.320, 0.080, 0.080], [0.150, 0.080, 0.080], [0.090, 0.072, 0.072],
    [-0.440, 0.072, 0.072], [-0.500, 0.062, 0.062],
  ], 6));
  for (let i = 0; i < 4; i++) {
    const fin = plateZY([
      [-0.30, 0.070], [-0.40, 0.152], [-0.50, 0.152], [-0.50, 0.070],
    ], 0.012);
    fin.rotateZ((i * Math.PI) / 2);
    add(bin, fin);
  }
}

// The permanent half of a station. `bay` is the Il-2's recessed centre-section
// cell, which is a frame you see the bomb sitting inside rather than a rack it
// hangs from; the other two hold their store clear of the skin.
function addRackGeo(bin, st) {
  if (st.rack === 'none') return;
  const half = st.dia * 0.5;
  const under = st.under != null ? st.under : st.y + half + 0.06;
  if (st.rack === 'bay') {
    // A lip round the opening, sitting ON the skin line: the cell itself is a
    // hole in a solid wing and would be invisible, so what says "bomb bay" is
    // the framed edge with the bomb showing through it.
    const w = st.dia + 0.13;
    const d = st.len * 1.04;
    const h = 0.07;
    const y = under - 0.015;
    add(bin, boxAt(0.035, h, d, st.x - w * 0.5, y, st.z));
    add(bin, boxAt(0.035, h, d, st.x + w * 0.5, y, st.z));
    add(bin, boxAt(w, h, 0.035, st.x, y, st.z - d * 0.5));
    add(bin, boxAt(w, h, 0.035, st.x, y, st.z + d * 0.5));
    return;
  }
  if (st.rack === 'rail') {
    const beam = st.y + half + 0.048;
    const hh = beam - st.y;
    add(bin, boxAt(0.05, 0.05, st.len * 0.66, st.x, beam, st.z));
    for (const s of [1, -1]) {
      add(bin, boxAt(0.032, hh, 0.05, st.x, st.y + hh * 0.5, st.z + s * st.len * 0.20));
    }
    return;
  }
  // 'sway': the crutched rack, faired into the wing skin above the bomb
  const top = st.y + half + 0.07;
  const hh = Math.max(0.04, top - st.y);
  add(bin, boxAt(0.13, hh * 0.92, st.len * 0.34, st.x, st.y + hh * 0.56, st.z));
  add(bin, boxAt(0.07, 0.06, st.len * 0.54, st.x, top, st.z));
  for (const s of [1, -1]) {
    add(bin, boxAt(0.11, hh * 0.72, 0.04, st.x, st.y + hh * 0.46, st.z + s * st.len * 0.16));
  }
}

// How many of each kind this aeroplane is BUILT to carry.
//
// This deliberately does not read the spawn's own loadout. mods.js nulls
// spec.bombs or spec.rockets to say which one is fitted today, and the geometry
// is cached per spec signature and shared by every spawn of the type — so if
// the build asked the loadout, the first aeroplane off the line would decide
// what every later one could carry. It asks the BASE spec instead, builds both
// fits, and buildPlaneMesh hides the one that is not being flown.
function storeCounts(spec) {
  const base = (spec && spec.id && PLANE_SPECS[spec.id]) || null;
  const pick = (own, fallback) => {
    const v = own && own.count != null
      ? own.count
      : fallback && fallback.count != null ? fallback.count : 0;
    return Math.max(0, Math.min(24, Math.round(v) || 0));
  };
  return {
    bomb: pick(spec && spec.bombs, base && base.bombs),
    rocket: pick(spec && spec.rockets, base && base.rockets),
  };
}

// Stations in RELEASE ORDER, in the aeroplane's own frame.
//
// A fit is stated for the LEFT wing only and mirrored, because that is what
// makes the order come out right: a station list is walked inboard to outboard
// and each pair is emitted left-then-right, so an aeroplane sheds its load
// symmetrically from the inboard station outward and never flies on with one
// wing loaded and the other clean. A centreline store, where a type has one,
// goes first.
function storeStations(spec, wing, lay, kind, count) {
  const n = Math.max(0, Math.round(count || 0));
  if (!n) return [];
  const shape = (spec && spec.shape) || {};
  const fit = (shape.stores && shape.stores[kind]) || {};
  const len = fit.len != null ? fit.len : kind === 'bomb' ? 1.2 : 1.0;
  const dia = fit.dia != null ? fit.dia : kind === 'bomb' ? 0.28 : 0.15;
  const rack = fit.rack || (kind === 'bomb' ? 'sway' : 'rail');
  const hs = wing.spanHalf;
  const cosD = Math.cos(wing.dih);
  const sinD = Math.sin(wing.dih);
  const out = [];

  const place = (src, sign) => {
    const sLen = src.len != null ? src.len : len;
    const sDia = src.dia != null ? src.dia : dia;
    const sRack = src.rack || rack;
    const x = sign * (src.x != null ? src.x : 0);
    let { y, z } = src;
    let under = null;
    if (y == null || z == null) {
      // Hang it off the wing the builder actually drew: chord centre for the
      // fore-and-aft position, lower surface for the height. Guessing either
      // from the span is how five different aeroplanes end up with their bombs
      // in the same wrong place.
      const u = Math.min(0.98, Math.abs(x) / hs);
      const pf = planformAt(wing, u);
      const thick = pf.chord * lerp(wing.tcRoot, wing.tcTip, u);
      // a wing with an outboard dihedral break carries its rise in the
      // stations; anything else is a flat panel rotated at the root
      under = wing.dihBreak > 0
        ? lay.wingY + dihedralY(wing, u) - thick * 0.5
        : lay.wingY + Math.abs(x) * sinD - thick * 0.5 * cosD;
      if (z == null) z = lay.wingZ + pf.sweep + (src.dz != null ? src.dz : sLen * 0.14);
      if (y == null) {
        y = sRack === 'bay'
          // recessed: only the bottom of it is proud of the skin
          ? under + sDia * 0.28
          : under - sDia * 0.5 - (src.drop != null ? src.drop : 0.06);
      }
    }
    out.push({ x, y, z, under, len: sLen, dia: sDia, rack: sRack });
  };

  if (fit.centre) place({ x: 0, ...fit.centre }, 1);
  const pairs = fit.pairs || [];
  for (const p of pairs) {
    if (out.length >= n) break;
    place(p, 1);
    if (out.length < n) place(p, -1);
  }
  // Defensive only. A spec whose station list is shorter than the count it
  // states still gets every store it says it carries, stepped outboard from
  // the last pair rather than silently dropped.
  let x = pairs.length && pairs[pairs.length - 1].x != null
    ? pairs[pairs.length - 1].x
    : hs * 0.32;
  for (let guard = 0; out.length < n && guard < 24; guard++) {
    const nx = Math.min(hs * 0.92, x + Math.max(0.40, dia * 2.6));
    if (nx <= x + 1e-4) break;
    x = nx;
    place({ x }, 1);
    if (out.length < n) place({ x }, -1);
  }
  return out.slice(0, n);
}

// ---------------------------------------------------------------------------
// merge plumbing
// ---------------------------------------------------------------------------
//
// One merged buffer per (frame, material). Anything that moves or can be shot
// off — a wing, an aileron, a gear leg — is its own frame, so merging never
// welds a moving part to a fixed one. mergeGeometries insists its inputs agree
// on indexing and attributes, and the hand-built lofts carry only position and
// normal, so the primitives' uvs go: every material in core/materials.js
// projects triplanar from object space and never reads one.
function mergeable(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  g.deleteAttribute('uv1');
  g.deleteAttribute('uv2');
  return g;
}

// Every piece carries the material class it is made of (core/materials.js
// AF_CLASS): one airframe material draws the whole aeroplane, so the class
// is what tells paint from gun steel from a tyre. A bin's own default holds
// unless the call site says otherwise.
function add(bin, geo, cls) {
  if (!geo) return;
  const g = mergeable(geo);
  const c = cls != null ? cls : bin.cls != null ? bin.cls : AF_CLASS.FUS;
  g.setAttribute('aCls', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(c), 1));
  bin.push(g);
}

function sealBins(bins) {
  const out = {};
  for (const key of Object.keys(bins)) {
    const list = bins[key];
    out[key] = list.length === 0 ? null : list.length === 1 ? list[0] : mergeGeometries(list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the aircraft, built once per spec
// ---------------------------------------------------------------------------

function buildPlaneGeometry(spec) {
  const { span, len } = spec;
  const look = spec.look || {};
  const f = len / 2;
  const hs = span / 2;

  const bins = {
    body: [], bodySteel: [], bodyMatt: [], glass: [],
    wingL: [], wingR: [], gunL: [], gunR: [],
    aileronL: [], aileronR: [], flapL: [], flapR: [],
    stabL: [], stabR: [], elevator: [], fin: [], rudder: [],
    propBlades: [], spinner: [], propDisc: [], navLightL: [], navLightR: [],
    gearLeg: [], gearTyre: [], tailLeg: [], tailTyre: [],
    bombBody: [], bombRacks: [], rocketBody: [], rocketRails: [],
  };
  // default material class per bin (AF_CLASS); call sites override
  const C = AF_CLASS;
  for (const [k, c] of Object.entries({
    body: C.FUS, bodySteel: C.STEEL, bodyMatt: C.INTERIOR, glass: C.FUS,
    wingL: C.SURF, wingR: C.SURF, gunL: C.GUN, gunR: C.GUN,
    aileronL: C.SURF, aileronR: C.SURF, flapL: C.SURF, flapR: C.SURF,
    stabL: C.SURF, stabR: C.SURF, elevator: C.SURF, fin: C.FUS, rudder: C.FUS,
    propBlades: C.BLADE, spinner: C.SPINNER, propDisc: C.BLADE,
    navLightL: C.LENS_RED, navLightR: C.LENS_GREEN,
    gearLeg: C.UNDER, gearTyre: C.TYRE, tailLeg: C.UNDER, tailTyre: C.TYRE,
    bombBody: C.BOMB, bombRacks: C.STEEL, rocketBody: C.ROCKET, rocketRails: C.STEEL,
  })) bins[k].cls = c;

  // ---- layout, shared with buildPlaneMesh so the two cannot drift apart ----
  const shape = spec.shape || {};
  const wingKind = look.wing;
  // The old literals stay as the fallback for anything a spec does not state,
  // so an aircraft without a shape block builds exactly what it built before.
  const wing = makePlanform(shape.wing, hs, {
    law: wingKind === 'elliptical' ? 'ellipse' : wingKind === 'thick' ? 'arrow' : 'taper',
    rootChord: wingKind === 'thick' ? 2.5 : wingKind === 'elliptical' ? 2.2 : 2.0,
    dihedral: wingKind === 'thick' ? 5.73 : 3.4,
    y: look.armoured ? -0.24 : -0.12,
    z: len * 0.04,
  });
  const propS = shape.prop || {};
  const tailS = shape.tail || {};
  const gearS = shape.gear || {};
  const lay = {
    wingY: wing.y,
    wingZ: wing.z,
    // a wing that breaks outboard of the root carries its dihedral in the
    // stations themselves, so the panel group must NOT be rotated as well
    dihedral: wing.dihBreak > 0 ? 0 : wing.dih,
    stabY: tailS.y != null ? tailS.y : 0.06,
    stabZ: tailS.z != null ? tailS.z : -len * 0.42,
    finY: tailS.finY != null ? tailS.finY : 0.18,
    propZ: propS.z != null ? propS.z : f + 0.28,
    blades: propS.blades != null ? propS.blades : look.engine === 'radial' ? 3 : 4,
    // The wingtip, for the ground-contact model: a landing with a wing down
    // puts this on the runway before anything else. A cranked wing carries its
    // dihedral in the stations, a straight one in the panel rotation.
    tipX: hs,
    tipY: wing.y + (wing.dihBreak > 0 ? dihedralY(wing, 1) : hs * Math.sin(wing.dih)),
    tipZ: wing.z,
  };
  const canopy = canopySections(spec);
  lay.canopyY = canopy.y;
  lay.canopyZ = canopy.z;

  // ---- fuselage ----
  add(bins.body, loftZ(fuselageSections(spec), 12));

  // Wing-root fairings. Every one of these aeroplanes has a fillet where the
  // wing meets the body; without it the wing looks stuck on with glue. The
  // Spitfire's runs well past the trailing edge, which is why filletAft is a
  // spec number rather than one shared constant.
  const rootChord = wing.rootChord;
  for (const sign of [1, -1]) {
    add(bins.body, loftZ([
      [lay.wingZ + rootChord * 0.5, 0.16, 0.09, lay.wingY + 0.1],
      [lay.wingZ + rootChord * 0.16, 0.34, 0.26, lay.wingY + 0.06],
      [lay.wingZ - rootChord * 0.34, 0.32, 0.24, lay.wingY + 0.04],
      [lay.wingZ - rootChord * wing.filletAft, 0.12, 0.07, lay.wingY + 0.02],
    ], 6).translate(sign * 0.38, 0, 0));
  }

  // ---- engine installation ----
  if (shape.cowlRing) {
    // Fw 190: the armoured annular oil-cooler ring forming the cowl lip, with
    // the spinner filling the middle and the cooling fan in the gap between.
    // Head-on this is a solid disc with a fan in it — which is the entire
    // difference between a BMW 801 installation and an open-nosed radial. The
    // nine-cylinder bank that used to live here was sealed INSIDE the fuselage
    // loft and never rendered a pixel, so it is gone.
    //
    // The ring and the fan have to stand PROUD of the fuselage's front cap:
    // loftZ closes both ends, so the cowl face is a solid disc and anything
    // behind it is invisible however carefully it is modelled.
    const r = shape.cowlRing;
    const ring = [];
    const seg = 16;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const p = (rad, z) => [Math.sin(a0) * rad, Math.cos(a0) * rad, z];
      const q = (rad, z) => [Math.sin(a1) * rad, Math.cos(a1) * rad, z];
      const zb = r.z - r.depth;
      pushQuad(ring, p(r.outer, r.z), q(r.outer, r.z), q(r.inner, r.z), p(r.inner, r.z));
      pushQuad(ring, p(r.inner, zb), q(r.inner, zb), q(r.inner, r.z), p(r.inner, r.z));
      pushQuad(ring, p(r.outer, r.z), q(r.outer, r.z), q(r.outer, zb), p(r.outer, zb));
    }
    add(bins.bodySteel, geoFrom(ring), AF_CLASS.FUS);
  } else if (look.engine === 'radial' && !shape.fuselage) {
    // legacy fallback only: the cylinder bank behind the cowl lip
    const cowl = look.wideCowl ? 0.68 : 0.6;
    add(bins.bodySteel, tubeZ(cowl * 0.82, cowl * 0.82, 0.1, 16, 0, 0, f * 0.9));
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      add(bins.bodySteel, tubeZ(
        0.1, 0.1, 0.3, 6,
        Math.sin(a) * cowl * 0.56, Math.cos(a) * cowl * 0.56, f * 0.82,
      ));
    }
    add(bins.bodySteel, tubeZ(0.09, 0.09, 0.7, 8, 0.2, -cowl * 0.72, f * 0.62));
  }

  if (shape.exhaust) {
    // a V12 has six cylinders a bank, so six stubs a side
    const e = shape.exhaust;
    for (const sign of [-1, 1]) {
      for (let i = 0; i < e.perSide; i++) {
        add(bins.bodySteel, boxAt(e.size, e.size, e.size * 1.5, sign * e.x, e.y, e.z0 - i * e.dz), AF_CLASS.EXHAUST);
      }
    }
  } else if (look.engine === 'inline' && !shape.fuselage) {
    for (const sign of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        add(bins.bodySteel, boxAt(0.11, 0.11, 0.22, sign * 0.42, 0.08, len * (0.34 - i * 0.06)), AF_CLASS.EXHAUST);
      }
      add(bins.bodySteel, boxAt(0.05, 0.08, 0.66, sign * 0.44, 0.02, len * 0.28), AF_CLASS.EXHAUST);
    }
    add(bins.body, boxAt(0.26, 0.12, 0.9, 0, 0.44, len * 0.3));
  } else if (look.engine === 'inline') {
    // ejector stubs in a row along a Merlin cowl
    for (const sign of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        add(bins.bodySteel, boxAt(0.09, 0.1, 0.17, sign * 0.40, 0.1, 3.30 - i * 0.22), AF_CLASS.EXHAUST);
      }
    }
  }

  // ---- wings, and the surfaces hung on them ----
  const gunList = shape.wingGuns || null;
  for (const [wingBin, gunBin, ailBin, flapBin, sign] of [
    [bins.wingL, bins.gunL, bins.aileronL, bins.flapL, 1],
    [bins.wingR, bins.gunR, bins.aileronR, bins.flapR, -1],
  ]) {
    const st = wingStations(wing, sign, [FLAP_SPAN, AIL_SPAN]);
    add(wingBin, wingSlab(st, { flip: sign < 0 }));

    // Where the gear lives. The Il-2's are big teardrop nacelles under the
    // centre section that are visible whether the wheels are up or down; every
    // other type here just needs a fairing over the well.
    if (shape.nacelles) {
      add(wingBin, loftZ(shape.nacelles, 8).translate(sign * gearS.x, 0, 0));
    } else if (gearS.x != null) {
      const wellU = Math.min(0.6, gearS.x / hs);
      const well = planformAt(wing, wellU);
      add(wingBin, loftZ([
        [well.sweep + 0.5, 0.2, 0.1, -0.06],
        [well.sweep, 0.3, 0.17, -0.1],
        [well.sweep - 0.6, 0.22, 0.12, -0.08],
      ], 6).translate(sign * gearS.x, dihedralY(wing, wellU), 0));
    } else {
      const wellU = 0.19;
      const well = planformAt(wing, wellU);
      add(wingBin, loftZ([
        [well.sweep + 0.5, 0.2, 0.1, -0.06],
        [well.sweep, 0.3, 0.17, -0.1],
        [well.sweep - 0.6, 0.22, 0.12, -0.08],
      ], 6).translate(sign * hs * wellU, 0, 0));
    }

    const ail = controlSlab(wing, sign, AIL_SPAN[0], AIL_SPAN[1], WING_CUT, sign < 0);
    add(ailBin, ail.geo);
    const flap = controlSlab(wing, sign, FLAP_SPAN[0], FLAP_SPAN[1], WING_CUT, sign < 0);
    add(flapBin, flap.geo);
    if (sign > 0) {
      lay.aileronHinge = ail.hinge;
      lay.aileronY = ail.yOff;
      lay.flapHinge = flap.hinge;
      lay.flapY = flap.yOff;
    }

    // Guns: barrels through the leading edge, plus the blast tube around them.
    // Deriving the barrel count from a DAMAGE number gave the Zero three where
    // it has one 20 mm cannon and the Mustang two where it has three .50s, so
    // the layout is stated per aircraft now.
    const guns = gunList || (spec.gun.dmg >= 5
      ? [{ u: 0.17, r: 0.045, protrude: 0.3 }, { u: 0.245, r: 0.045, protrude: 0.3 }]
      : [{ u: 0.17, r: 0.032, protrude: 0.3 }, { u: 0.245, r: 0.032, protrude: 0.3 },
        { u: 0.32, r: 0.032, protrude: 0.3 }]);
    for (const g of guns) {
      const pfa = planformAt(wing, g.u);
      const yD = dihedralY(wing, g.u);
      const port = pfa.sweep + pfa.chord * 0.5;
      const x = sign * hs * g.u;
      if (g.protrude > 0) {
        add(gunBin, tubeZ(g.r, g.r, g.protrude, 10, x, yD, port + g.protrude * 0.5 - 0.04));
      }
      if (g.fairing) {
        add(gunBin, tubeZ(g.r * 2.3, g.r * 1.6, 0.34, 10, x, yD, port - 0.14), AF_CLASS.SURF);
      } else {
        add(gunBin, tubeZ(g.r * 2.0, g.r * 2.0, 0.12, 8, x, yD, port - 0.05), AF_CLASS.SURF);
      }
      if (g.blister) {
        // the cannon-drum blister on the UPPER wing surface: a Mk Vb identifier
        const t = Math.max(0.012, pfa.chord * lerp(wing.tcRoot, wing.tcTip, g.u) * 0.5);
        add(wingBin, loftZ([
          [pfa.sweep + g.blister.len * 0.45, g.blister.w * 0.4, g.blister.h * 0.3, yD + t],
          [pfa.sweep, g.blister.w * 0.5, g.blister.h, yD + t],
          [pfa.sweep - g.blister.len * 0.55, g.blister.w * 0.3, g.blister.h * 0.3, yD + t],
        ], 6).translate(x, 0, 0));
      }
    }
    // pitot head under the starboard panel
    if (sign < 0) {
      const pfa = planformAt(wing, 0.62);
      const yD = dihedralY(wing, 0.62);
      add(gunBin, tubeZ(0.018, 0.018, 0.62, 5, -hs * 0.62, yD - 0.12, pfa.sweep + pfa.chord * 0.5 + 0.14), AF_CLASS.STEEL);
      add(gunBin, tubeY(0.02, 0.02, 0.14, 5, -hs * 0.62, yD - 0.07, pfa.sweep + pfa.chord * 0.4), AF_CLASS.STEEL);
    }
  }

  // Cowl guns. Both the Zero and the Fw 190 fire theirs THROUGH the cowl, so
  // there is no protruding barrel to draw — what you actually see is the pair
  // of raised troughs running forward from the windscreen along the top of the
  // cowl, and those have to straddle the cowl top line to be visible at all.
  if (shape.cowlGuns) {
    for (const g of shape.cowlGuns) {
      for (const sign of [-1, 1]) {
        add(bins.body, boxAt(g.w, g.h, g.z0 - g.z1, sign * g.x, g.y, (g.z0 + g.z1) * 0.5));
        add(bins.bodySteel, tubeZ(g.w * 0.32, g.w * 0.32, 0.1, 8, sign * g.x, g.y, g.z0 - 0.04), AF_CLASS.GUN);
      }
    }
  }

  // Wingtip navigation lights, in the wing's own frame so they leave with the
  // panel when it is shot off: unlit coloured glass domes (bible V-42), red to
  // port (+X), green to starboard. The national markings are no longer
  // geometry at all: they are painted into the scheme (see markingsOf).
  const tipPf = planformAt(wing, 0.99);
  lay.navZ = tipPf.sweep;
  lay.navY = dihedralY(wing, 0.99);
  lay.navU = 0.99;
  lay.navHs = hs;
  add(bins.navLightL, new THREE.SphereGeometry(0.055, 8, 6).translate(hs * lay.navU, lay.navY, lay.navZ));
  add(bins.navLightR, new THREE.SphereGeometry(0.055, 8, 6).translate(-hs * lay.navU, lay.navY, lay.navZ));
  lay.wing = wing;

  // ---- tail ----
  // `span * 0.19` used to be passed in as a HALF-span, so every tailplane in
  // the file was 27-35% too wide and the rear of each aeroplane read heavy and
  // short. It is a stated measurement now, and the Spitfire gets the elliptical
  // tailplane that deliberately echoes its wing.
  const tailPf = makePlanform(tailS, tailS.halfSpan != null ? tailS.halfSpan : span * 0.19, {
    law: 'taper',
    rootChord: tailS.rootChord != null ? tailS.rootChord : 1.0,
    tipChord: tailS.tipChord != null ? tailS.tipChord : (tailS.rootChord || 1.0) * 0.5,
    tcRoot: 0.10, tcTip: 0.09, dihedral: 0,
  });
  lay.tailPf = tailPf;
  for (const [bin, sign] of [[bins.stabL, 1], [bins.stabR, -1]]) {
    const st = wingStations(tailPf, sign, [ELEV_SPAN]);
    // the tailplane carries a much bigger surface than a wing does
    for (const s of st) if (s.cut) s.cut = TAIL_CUT;
    add(bin, wingSlab(st, { flip: sign < 0 }));
  }
  // Both elevator halves always deflect together, so they are one mesh on one
  // hinge — and the hinge line is the same either side, because the planform
  // does not care which wing it is on.
  for (const sign of [1, -1]) {
    const el = controlSlab(tailPf, sign, ELEV_SPAN[0], ELEV_SPAN[1], TAIL_CUT, sign < 0);
    add(bins.elevator, el.geo);
    lay.elevHinge = el.hinge;
  }

  // Fin and rudder as stated outlines. The two-option ternary could not produce
  // the Spitfire's tall fin with a rudder horn hanging BELOW the tailplane, or
  // the Mustang's rounded top — and the rudder polygon is now allowed to start
  // below y = 0 so that horn exists at all.
  const finPts = tailS.fin || (look.squareTail
    ? [[0.9, 0], [-0.5, 0], [-0.48, 1.1], [0.5, 1.2]]
    : [[0.85, 0], [-0.45, 0], [-0.42, 0.98], [0.25, 1.15], [0.75, 0.75]]);
  const rudPts = tailS.rudder || (look.squareTail
    ? [[-0.52, 0.01], [-0.75, 0.02], [-0.72, 1.06], [-0.5, 1.09]]
    : [[-0.47, 0.01], [-0.62, 0.02], [-0.8, 0.16], [-0.56, 0.99], [-0.44, 0.97]]);
  const rudderHinge = tailS.rudderHinge != null ? tailS.rudderHinge : look.squareTail ? -0.5 : -0.45;
  add(bins.fin, plateZY(finPts, 0.11));
  add(bins.rudder, plateZY(rudPts, 0.095).translate(0, 0, -rudderHinge));
  lay.rudderHinge = rudderHinge;
  lay.finTop = tailS.finTop || (look.squareTail ? [1.2, 0.5] : [1.15, 0.25]);

  // The dorsal fin fillet: fitted from June 1944 to cure the yaw instability
  // the cut-down rear fuselage introduced, and on a D-model silhouette the
  // unbroken curve from spine into fin is unmistakable.
  if (tailS.fillet) {
    add(bins.body, loftZ(tailS.fillet, 6));
  }

  // ---- canopy: glass, framing, and something to see behind it ----
  const cy = canopy.y;
  for (const volume of canopy.glass) {
    add(bins.glass, loftZ(volume, 12));
    for (let i = 0; i < volume.length; i++) {
      // the frontmost hoop is redundant on a type whose windscreen is a flat
      // armoured panel — the panel is the frame there
      if (i === 0 && canopy.flatScreen) continue;
      const s = volume[i];
      add(bins.body, hoopXY(s[1] * 1.03, s[2] * 1.03, 0.028, s[3] != null ? s[3] : cy, s[0], 10));
    }
    // one longitudinal rail per side along the bottom of each glazed volume
    const a = volume[1] || volume[0];
    const b = volume[volume.length - 1];
    const ay = (a[3] != null ? a[3] : cy) - a[2] * 0.7;
    for (const sign of [-1, 1]) {
      add(bins.body, barBetween(
        sign * a[1] * 0.98, ay, volume[0][0] - 0.05,
        sign * a[1] * 0.98, ay, b[0] + 0.05,
        0.026,
      ));
    }
  }
  // Solid decking between the two hoods — skin, not glass. It is the GAP that
  // makes an Il-2 an Il-2 rather than a generic two-seat fighter-bomber.
  if (canopy.deck) add(bins.body, loftZ(canopy.deck, 10));

  const screen = canopy.glass[0][0];
  const screenBack = canopy.glass[0][1] || screen;
  if (canopy.flatScreen) {
    // the flat armoured front panel, canted back — what makes a Spitfire,
    // Fw 190 or Mustang windscreen read as armoured rather than blown
    const sy = screen[3] != null ? screen[3] : cy;
    const by = screenBack[3] != null ? screenBack[3] : cy;
    const v = [];
    const w = screenBack[1] * 0.80;
    // nudge the panel clear of the glass loft it sits on, or the two z-fight
    const y0 = sy + screen[2] * 0.95 + 0.02;
    const y1 = by + screenBack[2] * 1.02 + 0.02;
    pushQuad(v,
      [-w, y0, screen[0] + 0.02],
      [w, y0, screen[0] + 0.02],
      [w, y1, screenBack[0] + 0.02],
      [-w, y1, screenBack[0] + 0.02]);
    add(bins.bodyMatt, geoFrom(v), AF_CLASS.ARMOUR_GLASS);
  } else {
    add(bins.body, barBetween(
      0, cy + screen[2] * 0.9, canopy.front - 0.02,
      0, cy + screenBack[2] * 1.0, canopy.front - 0.45,
      0.024,
    ));
  }

  // The cockpit itself. An open tub rather than a closed box: the point of a
  // transparent canopy is that there is something underneath it.
  const tubHW = 0.34;
  const tubFront = canopy.z + 0.55;
  const tubBack = canopy.tubBack != null
    ? canopy.tubBack
    : look.canopy === 'twoSeat' ? canopy.z - 1.7 : canopy.z - 0.8;
  const tubLen = tubFront - tubBack;
  const tubMid = (tubFront + tubBack) * 0.5;
  add(bins.bodyMatt, boxAt(tubHW * 2, 0.06, tubLen, 0, cy - 0.44, tubMid));
  for (const sign of [-1, 1]) {
    add(bins.bodyMatt, boxAt(0.05, 0.58, tubLen, sign * tubHW, cy - 0.16, tubMid));
  }
  add(bins.bodyMatt, boxAt(tubHW * 2, 0.6, 0.06, 0, cy - 0.15, tubBack));
  // instrument panel and coaming
  add(bins.bodyMatt, boxAt(0.56, 0.34, 0.07, 0, cy - 0.16, tubFront - 0.06));
  add(bins.bodyMatt, boxAt(0.6, 0.08, 0.24, 0, cy + 0.04, tubFront - 0.12));
  // control column
  add(bins.bodyMatt, tubeY(0.022, 0.026, 0.36, 5, 0, cy - 0.24, canopy.z + 0.28));
  // seat, and a pilot in it
  const seatZ = canopy.z - 0.05;
  add(bins.bodyMatt, boxAt(0.42, 0.05, 0.4, 0, cy - 0.3, seatZ));
  add(bins.bodyMatt, boxAt(0.42, 0.46, 0.06, 0, cy - 0.06, seatZ - 0.2));
  add(bins.bodyMatt, boxAt(0.34, 0.34, 0.24, 0, cy - 0.1, seatZ + 0.02));
  add(bins.bodyMatt, new THREE.SphereGeometry(0.125, 10, 8).translate(0, cy + 0.13, seatZ - 0.04), AF_CLASS.PILOT);
  if (look.canopy === 'twoSeat') {
    // the gunner sits in his OWN hood, a metre aft and about 0.28 m lower than
    // the pilot's, with the UBT in the open above him canted up and to
    // starboard — that offset gun is visible from every attacking angle
    const gz = canopy.gunnerZ != null ? canopy.gunnerZ : canopy.z - 1.25;
    const gy = canopy.gunnerZ != null ? cy - 0.16 : cy;
    add(bins.bodyMatt, boxAt(0.4, 0.44, 0.06, 0, gy - 0.08, gz - 0.18));
    add(bins.bodyMatt, boxAt(0.32, 0.32, 0.22, 0, gy - 0.12, gz));
    add(bins.bodyMatt, new THREE.SphereGeometry(0.12, 10, 8).translate(0, gy + 0.1, gz), AF_CLASS.PILOT);
    const mg = new THREE.CylinderGeometry(0.038, 0.038, 1.1, 8);
    mg.rotateX(1.31); // canted up ~25 degrees from the fuselage line
    mg.rotateY(-0.26); // and yawed to starboard, where the mount actually sat
    add(bins.bodySteel, mg.translate(-0.10, gy + 0.24, gz - 0.80), AF_CLASS.GUN);
    // the ring mount it swivels on, so the gun is attached to something
    add(bins.bodySteel, tubeY(0.05, 0.05, 0.16, 6, -0.06, gy + 0.06, gz - 0.30));
  }

  // ---- aerial mast and wire ----
  const mastZ = canopy.back - 0.12;
  const mastTop = cy + 0.42;
  add(bins.bodySteel, tubeY(0.035, 0.02, 0.46, 5, 0, cy + 0.2, mastZ), AF_CLASS.FUS);
  add(bins.bodySteel, barBetween(
    0, mastTop, mastZ,
    0, lay.finY + lay.finTop[0] * 0.94, lay.stabZ + lay.finTop[1],
    0.012, 3,
  ));

  // ---- type-specific signatures ----
  // The Mustang's radiator scoop: inlet BEHIND the wing trailing edge, deepest
  // under the fuselage, exit door under the fin leading edge. It used to start
  // 0.76 m AHEAD of the wing and run over half the aircraft, which reads as a
  // Typhoon chin bath rather than the Mustang's compact deep scoop set well aft.
  if (shape.bellyScoop) {
    add(bins.body, loftZ(shape.bellyScoop.sections, 10));
    const d = shape.bellyScoop.exitDoor;
    if (d) add(bins.bodySteel, boxAt(d.w, d.h, d.d, 0, d.y, d.z), AF_CLASS.UNDER);
  } else if (look.bellyScoop) {
    add(bins.body, loftZ([
      [len * 0.22, 0.32, 0.16, -0.52],
      [len * 0.05, 0.42, 0.26, -0.62],
      [-len * 0.22, 0.4, 0.24, -0.6],
      [-len * 0.34, 0.28, 0.12, -0.5],
    ], 8));
    add(bins.bodySteel, boxAt(0.6, 0.3, 0.06, 0, -0.62, len * 0.2), AF_CLASS.UNDER);
  }
  // Merlin Mustangs breathe from UNDER the nose; the box on TOP of the cowl is
  // the Allison-engined P-51A, a different aeroplane.
  if (shape.chinScoop) {
    const c = shape.chinScoop;
    add(bins.body, loftZ([
      [c.z + c.len * 0.5, c.w * 0.44, c.h * 0.4, c.y + 0.03],
      [c.z + c.len * 0.2, c.w * 0.5, c.h * 0.5, c.y],
      [c.z - c.len * 0.5, c.w * 0.4, c.h * 0.4, c.y + 0.04],
    ], 8));
  }

  // Ducts, stated per side. This is what replaces the chin radiator the
  // Spitfire never had: a BIG square coolant radiator under the starboard wing
  // and a SMALL round oil cooler under the port one. The underside asymmetry is
  // a genuine recognition cue and the builder had no way to express it.
  if (shape.ducts) {
    for (const d of shape.ducts) {
      add(bins.body, loftZ(d.sections, d.mouth === 'square' ? 8 : 10)
        .translate(d.x, lay.wingY, lay.wingZ));
    }
  } else if (look.chinRad) {
    add(bins.bodySteel, boxAt(0.34, 0.26, 0.9, -0.02, -0.52, len * 0.24));
    add(bins.body, loftZ([
      [0.62, 0.2, 0.1, -0.36],
      [0.2, 0.24, 0.18, -0.44],
      [-0.5, 0.22, 0.16, -0.42],
    ], 6).translate(span * 0.16, 0, -len * 0.02));
  }
  // the oval carburettor intake slung under a Merlin nose
  if (shape.noseIntake) {
    const ni = shape.noseIntake;
    add(bins.body, loftZ([
      [ni.z0, ni.w * 0.36, ni.h * 0.3, ni.y + 0.04],
      [ni.z0 - 0.3, ni.w * 0.5, ni.h * 0.5, ni.y],
      [ni.z1, ni.w * 0.44, ni.h * 0.42, ni.y + 0.03],
    ], 10));
  }
  // Zero: the wide shallow chin oil-cooler lip and the carb scoop at 12
  // o'clock. Those two plus the gun troughs are what make a Zero nose different
  // from an Fw 190 nose, and the shared radial branch could build neither.
  if (shape.cowlLip) {
    const cl = shape.cowlLip;
    add(bins.body, loftZ([
      [cl.z0, cl.w * 0.8, cl.h * 0.5, cl.y + 0.02],
      [cl.z0 - 0.5, cl.w, cl.h, cl.y],
      [cl.z1, cl.w * 0.7, cl.h * 0.7, cl.y + 0.06],
    ], 8));
  }
  if (shape.topScoop) {
    const ts = shape.topScoop;
    add(bins.body, boxAt(ts.w * 2, ts.h * 2, ts.len, 0, ts.y, ts.z));
  }
  // Il-2: the chin duct that makes the forward fuselage read deep and armoured
  // rather than streamlined, and the starboard-only filter drum
  if (shape.chinDuct) {
    const cd = shape.chinDuct;
    add(bins.body, loftZ(cd.sections, 8));
    if (cd.mouth) {
      add(bins.bodySteel, boxAt(cd.mouth.w, cd.mouth.h, 0.08, 0, cd.mouth.y, cd.mouth.z));
    }
    if (cd.flap) add(bins.bodySteel, boxAt(cd.flap.w, cd.flap.h, cd.flap.d, 0, cd.flap.y, cd.flap.z), AF_CLASS.UNDER);
  }
  if (shape.carbDrum) {
    const cdr = shape.carbDrum;
    add(bins.bodySteel, tubeZ(cdr.r, cdr.r, cdr.len, 12, cdr.x, cdr.y, cdr.z), AF_CLASS.FUS);
  }
  // ---- ordnance ----
  // Both fits are built and the one that is not being flown is hidden at
  // assembly, because this build is cached per spec and shared by every spawn
  // of the type while the loadout is chosen per spawn. Racks merge into one
  // buffer a kind; the store bodies stay separate meshes so they can be
  // released one at a time.
  const counts = storeCounts(spec);
  lay.stores = {};
  for (const [kind, bodyBin, rackBin, cal] of [
    ['bomb', bins.bombBody, bins.bombRacks, BOMB_CAL],
    ['rocket', bins.rocketBody, bins.rocketRails, ROCKET_CAL],
  ]) {
    const stations = storeStations(spec, wing, lay, kind, counts[kind]);
    lay.stores[kind] = stations.map((st) => ({
      x: st.x, y: st.y, z: st.z,
      // the canonical body is a unit length across a fixed calibre, so the
      // station's own dimensions come out as a scale
      r: st.dia / cal, s: st.len,
    }));
    if (!stations.length) continue;
    for (const st of stations) addRackGeo(rackBin, st);
    if (kind === 'bomb') addBombBody(bodyBin);
    else addRocketBody(bodyBin);
  }

  // ---- propeller ----
  const propR = propS.radius != null ? propS.radius : 1.42;
  lay.propR = propR;
  const spinR = propS.spinnerR != null ? propS.spinnerR : 0.17;
  const spinLen = propS.spinnerLen != null ? propS.spinnerLen : 0.55;
  const hubR = propS.hubR != null ? propS.hubR : Math.min(0.2, spinR * 0.7);
  const bladeZ = spinLen * 0.34;
  // what the disc texture needs to know about the blades (A-01)
  lay.prop = {
    hubR,
    spinR,
    bladeZ,
    chordRoot: propS.chordRoot != null ? propS.chordRoot : 0.3,
    chordTip: propS.chordTip != null ? propS.chordTip : 0.16,
    squareTip: !!propS.squareTip,
    fan: shape.coolingFan || null,
  };
  add(bins.spinner, spinnerGeo(spinR, spinLen, propS.spinnerProfile || 'cone'));
  add(bins.spinner, tubeZ(spinR * 0.7, spinR * 0.7, 0.18, 12, 0, 0, -0.08));
  for (let i = 0; i < lay.blades; i++) {
    const blade = propBlade(
      hubR, propR,
      propS.chordRoot != null ? propS.chordRoot : 0.3,
      propS.chordTip != null ? propS.chordTip : 0.16,
      0.55, 0.12, !!propS.squareTip,
    );
    blade.rotateZ((i * Math.PI * 2) / lay.blades);
    blade.translate(0, 0, bladeZ);
    add(bins.propBlades, blade);
  }
  // The Fw 190's 12-blade cooling fan, turning in the annulus between the
  // spinner and the cowl lip. It is parented to the prop group, so it spins.
  if (shape.coolingFan) {
    const fan = shape.coolingFan;
    for (let i = 0; i < fan.blades; i++) {
      const a = (i / fan.blades) * Math.PI * 2;
      const plate = boxAt(fan.chord, fan.outer - fan.inner, 0.02, 0, (fan.outer + fan.inner) * 0.5, 0);
      plate.rotateY(0.7); // set at a coarse pitch, which is what you see head-on
      plate.rotateZ(a);
      add(bins.propBlades, plate.translate(0, 0, fan.z));
    }
  }
  // (the disc is built with its uv in assembleSkins: its texture is radial)

  // ---- undercarriage ----
  // Built once in the leg's own frame, origin ON the pivot, so the same buffer
  // serves both main legs and a rotation retracts them. Track, leg length,
  // wheel size and the retraction DIRECTION all used to be one shared set of
  // literals, which is how a Spitfire ended up with a 3.81 m track folding
  // inboard when the real one is 1.74 m folding out.
  const legLen = gearS.legLen != null ? gearS.legLen : 0.34 + len * 0.1;
  const wheelR = gearS.wheelR != null ? gearS.wheelR : 0.3;
  const tyreW = gearS.tyreW != null ? gearS.tyreW : 0.22;
  lay.legLen = legLen;
  lay.wheelR = wheelR;
  lay.gearX = gearS.x != null ? gearS.x : span * 0.17;
  lay.gearZ = gearS.z != null ? gearS.z : len * 0.1;
  lay.gearRake = gearS.rake || 0;
  lay.gearRetract = gearS.retract || 'in';
  lay.gearAlwaysVisible = !!gearS.alwaysVisible;
  lay.tailFixed = !!gearS.tailFixed;
  add(bins.gearLeg, tubeY(0.075, 0.09, legLen, 8, 0, -legLen * 0.5, 0));
  add(bins.gearLeg, tubeY(0.05, 0.05, legLen * 0.55, 5, 0.1, -legLen * 0.62, 0.1));
  add(bins.gearLeg, tubeX(0.075, 0.075, 0.3, 8, 0, -legLen, 0));
  add(bins.gearLeg, tubeX(wheelR * 0.42, wheelR * 0.42, tyreW + 0.02, 10, 0, -legLen, 0));
  // the door that closes the well behind it
  add(bins.gearLeg, boxAt(0.04, legLen * 0.72, 0.62, 0.055, -legLen * 0.4, 0));
  add(bins.gearTyre, tubeX(wheelR, wheelR, tyreW, 14, 0, -legLen, 0));

  const tailLeg = gearS.tailLegLen != null ? gearS.tailLegLen : 0.42;
  const tailR = gearS.tailR != null ? gearS.tailR : 0.14;
  lay.tailLegLen = tailLeg;
  lay.tailR = tailR;
  lay.tailGearZ = gearS.tailZ != null ? gearS.tailZ : -len * 0.44;
  add(bins.tailLeg, tubeY(0.05, 0.06, tailLeg, 6, 0, -tailLeg * 0.5, 0));
  add(bins.tailLeg, tubeX(0.05, 0.05, 0.16, 6, 0, -tailLeg, 0));
  add(bins.tailTyre, tubeX(tailR, tailR, tailR * 0.8, 10, 0, -tailLeg, 0));

  return { geo: sealBins(bins), lay };
}

// ---------------------------------------------------------------------------
// P-03: the draw-call diet. The aeroplane used to be ~31 meshes (and 31
// shadow casters) because every moving or detachable part was its own mesh in
// its own material. Now it is one SKINNED mesh per frame that can leave —
// the airframe (fuselage, fin, tailplane, elevator, rudder, spinner), each
// wing panel (with its aileron, flap, guns and lamp) and each fitted kind of
// store — all in ONE material, sharing one skeleton per aeroplane. Every
// moving part is a Bone with exactly the transform its Object3D used to have,
// so the rig, the hinge pivots, the damage model's partMeshes and the hangar
// all drive the same nodes they always did. Gear legs stay separate meshes
// (the gear rig and planeGearGeometry are matched to them).
//
// Bone order (the skinIndex values baked below):
//   0 body root   1 elevator   2 fin   3 rudder   4 propeller (the spinner)
//   5 left wing   6 aileronL   7 flapL   8 right wing  9 aileronR  10 flapR
//   then each store kind: its root, then one bone per store in release order
// ---------------------------------------------------------------------------
const BONE = Object.freeze({
  root: 0, elevator: 1, fin: 2, rudder: 3, prop: 4,
  wingL: 5, aileronL: 6, flapL: 7, wingR: 8, aileronR: 9, flapR: 10, stores: 11,
});
// part ids carried in aMark.w (the shader keys the LE strips and gun soot on them)
const PART = Object.freeze({ wing: 0, tail: 1, fuselage: 2, fin: 3, other: 4 });

const _m4 = new THREE.Matrix4();
const _n3 = new THREE.Matrix3();
const _v3 = new THREE.Vector3();

function restFrames(lay) {
  const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
  const wingOf = (sign) => T(0, lay.wingY, lay.wingZ).multiply(new THREE.Matrix4().makeRotationZ(sign * lay.dihedral));
  const fin = T(0, lay.finY, lay.stabZ);
  return {
    stab: T(0, lay.stabY, lay.stabZ),
    elevator: T(0, lay.stabY, lay.stabZ + lay.elevHinge),
    fin,
    rudder: fin.clone().multiply(T(0, 0, lay.rudderHinge)),
    prop: T(0, 0, lay.propZ),
    wingL: wingOf(1),
    wingR: wingOf(-1),
    aileron: T(0, lay.aileronY || 0, lay.aileronHinge),
    flap: T(0, lay.flapY || 0, lay.flapHinge),
  };
}

// One piece of a skinned buffer: `local` places it in the mesh's own frame,
// `air` takes the mesh frame to the aircraft frame (scheme coordinates),
// `chord` = [planform, matrix mesh->planform frame] for chordwise position.
function piece(g, bone, part, local = null, chord = null) {
  return g ? { g, bone, part, local, chord } : null;
}

function markedGeometry(pc, air, skinned) {
  const g = pc.g.clone();
  if (pc.local) g.applyMatrix4(pc.local);
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const n = pos.count;
  const cls = g.attributes.aCls;
  const aAir = new Float32Array(n * 3);
  const aAirN = new Float32Array(n * 3);
  const aMark = new Float32Array(n * 4);
  _n3.getNormalMatrix(air);
  const toChord = pc.chord ? pc.chord[1] : null;
  for (let i = 0; i < n; i++) {
    _v3.fromBufferAttribute(pos, i).applyMatrix4(air);
    aAir[i * 3] = _v3.x;
    aAir[i * 3 + 1] = _v3.y;
    aAir[i * 3 + 2] = _v3.z;
    _v3.fromBufferAttribute(nrm, i).applyMatrix3(_n3).normalize();
    aAirN[i * 3] = _v3.x;
    aAirN[i * 3 + 1] = _v3.y;
    aAirN[i * 3 + 2] = _v3.z;
    let cf = -1;
    let su = -1;
    if (pc.chord) {
      _v3.fromBufferAttribute(pos, i);
      if (toChord) _v3.applyMatrix4(toChord);
      const pf = pc.chord[0];
      const u = Math.min(1, Math.abs(_v3.x) / pf.spanHalf);
      const at = planformAt(pf, u);
      cf = (at.sweep + at.chord * 0.5 - _v3.z) / at.chord;
      su = u;
    }
    aMark[i * 4] = cls ? cls.getX(i) : AF_CLASS.FUS;
    aMark[i * 4 + 1] = cf;
    aMark[i * 4 + 2] = su;
    aMark[i * 4 + 3] = pc.part;
  }
  g.deleteAttribute('aCls');
  g.setAttribute('aAir', new THREE.BufferAttribute(aAir, 3));
  g.setAttribute('aAirN', new THREE.BufferAttribute(aAirN, 3));
  g.setAttribute('aMark', new THREE.BufferAttribute(aMark, 4));
  if (skinned) {
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      si[i * 4] = pc.bone;
      sw[i * 4] = 1;
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  }
  return g;
}

function skinOf(pieces, air) {
  const list = pieces.filter(Boolean).map((pc) => markedGeometry(pc, air, true));
  if (!list.length) return null;
  const g = list.length === 1 ? list[0] : mergeGeometries(list);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function plainOf(g, part = PART.other) {
  if (!g) return null;
  const out = markedGeometry({ g, bone: 0, part, local: null, chord: null }, new THREE.Matrix4(), false);
  out.computeBoundingSphere();
  return out;
}

function assembleSkins(spec, built) {
  const { geo, lay } = built;
  const F = restFrames(lay);
  const I = new THREE.Matrix4();
  const stabInv = F.stab.clone().invert();
  const tail = lay.tailPf;
  const wing = lay.wing;
  const skin = {};
  // the airframe, in the aircraft frame
  skin.body = skinOf([
    piece(geo.body, BONE.root, PART.fuselage),
    piece(geo.bodySteel, BONE.root, PART.fuselage),
    piece(geo.bodyMatt, BONE.root, PART.fuselage),
    piece(geo.stabL, BONE.root, PART.tail, F.stab, [tail, stabInv]),
    piece(geo.stabR, BONE.root, PART.tail, F.stab, [tail, stabInv]),
    piece(geo.elevator, BONE.elevator, PART.tail, F.elevator, [tail, stabInv]),
    piece(geo.fin, BONE.root, PART.fin, F.fin),
    piece(geo.rudder, BONE.rudder, PART.fin, F.rudder),
    piece(geo.spinner, BONE.prop, PART.other, F.prop),
  ], I);
  // each wing panel, in its own (dihedral-rotated) frame as before
  for (const [k, wingGeo, gun, ail, flap, nav, side, bw, ba, bf] of [
    ['wingL', geo.wingL, geo.gunL, geo.aileronL, geo.flapL, geo.navLightL, F.wingL, BONE.wingL, BONE.aileronL, BONE.flapL],
    ['wingR', geo.wingR, geo.gunR, geo.aileronR, geo.flapR, geo.navLightR, F.wingR, BONE.wingR, BONE.aileronR, BONE.flapR],
  ]) {
    skin[k] = skinOf([
      piece(wingGeo, bw, PART.wing, null, [wing, null]),
      piece(gun, bw, PART.wing, null, [wing, null]),
      piece(ail, ba, PART.wing, F.aileron, [wing, null]),
      piece(flap, bf, PART.wing, F.flap, [wing, null]),
      piece(nav, bw, PART.other),
    ], side);
  }
  // the stores: racks on the kind's root bone, each body on its own bone,
  // baked at its station (the canonical body scaled to the station's size)
  let b = BONE.stores;
  lay.storeBones = {};
  for (const [kind, bodyGeo, rackGeo] of [
    ['bomb', geo.bombBody, geo.bombRacks],
    ['rocket', geo.rocketBody, geo.rocketRails],
  ]) {
    const list = (lay.stores && lay.stores[kind]) || [];
    const root = b++;
    const bones = list.map(() => b++);
    lay.storeBones[kind] = { root, bones };
    if (!list.length || !bodyGeo) continue;
    const parts = [piece(rackGeo, root, PART.other)];
    list.forEach((st, i) => {
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(st.x, st.y, st.z), new THREE.Quaternion(), new THREE.Vector3(st.r, st.r, st.s));
      parts.push(piece(bodyGeo, bones[i], PART.other, m));
    });
    skin[kind] = skinOf(parts, I);
  }
  lay.boneCount = b;
  // separate, unskinned: the blades (hidden once they would strobe), the
  // undercarriage (its own rig) — the same material, so they carry the marks
  skin.blades = plainOf(geo.propBlades);
  skin.gearLeg = plainOf(geo.gearLeg);
  skin.gearTyre = plainOf(geo.gearTyre);
  skin.tailLeg = plainOf(geo.tailLeg);
  skin.tailTyre = plainOf(geo.tailTyre);
  // the prop disc keeps its uv: its texture is radial
  skin.disc = new THREE.CircleGeometry(lay.propR * 1.012, 40).translate(0, 0, lay.prop.bladeZ);
  return skin;
}

// The key is a signature rather than the spec object: mods.js hands the player
// a structuredClone of their spec on every spawn, so a WeakMap keyed on
// identity would miss every single time. Nothing in the mod tree touches span,
// length or `look`, so specs that differ only in their gameplay numbers share
// one build and any spec that ever did move a dimension gets its own.
const planeGeoCache = new Map();

function cachedPlaneGeometry(spec) {
  const counts = storeCounts(spec);
  const key = JSON.stringify([
    // `shape` has to be in the key: it is now where every dimension lives, and
    // an id-only key would silently hand one aircraft another's buffers the
    // moment two specs shared an id with different shapes.
    spec.id, spec.span, spec.len, spec.look, spec.shape,
    // only whether the guns are cannon-sized changes the geometry, so a
    // modified gun does not fork the whole airframe
    !!(spec.gun && spec.gun.dmg >= 5),
    // How many stores hang under the wing is now a geometric fact, so it has
    // to be in the key. It is resolved from the BASE spec, so the two loadouts
    // of one aeroplane still agree on it and still share one build — but a spec
    // that genuinely carries a different number gets its own buffers instead of
    // wearing somebody else's bombs.
    counts.bomb, counts.rocket,
  ]);
  let built = planeGeoCache.get(key);
  if (!built) {
    built = buildPlaneGeometry(spec);
    // Callers get clones that SHARE these buffers, so a scene teardown that
    // disposed one would free the geometry for every battle after it.
    //
    // The stamp has to go on each BUFFER, not only on the record that holds
    // them: the teardown sweeps in game/*.js ask isSharedResource(o.geometry)
    // of every mesh they find, and a mesh's geometry is one of these buffers,
    // never this wrapper. Stamping the wrapper alone left every one of them
    // looking disposable — which is exactly the failure the comment above was
    // written to prevent, and it now costs a whole aeroplane's re-upload on
    // the first frame after every battle instead of nothing.
    markSharedGeometry(built);
    for (const g of Object.values(built.geo)) if (g) markSharedGeometry(g);
    // P-03: the merged, skinned buffers the mesh is actually drawn from
    built.skin = assembleSkins(spec, built);
    for (const g of Object.values(built.skin)) if (g && g.isBufferGeometry) markSharedGeometry(g);
    planeGeoCache.set(key, built);
  }
  return built;
}

// ---------------------------------------------------------------------------
// the rig: what moves, and how far
// ---------------------------------------------------------------------------
//
// Deflections in radians at full stick. Sign conventions follow the flight
// model in planeEntity.js (+X is the LEFT wing):
//   roll  +1 -> left wing UP   -> left aileron DOWN, right aileron UP
//   pitch +1 -> nose DOWN      -> elevator trailing edge DOWN
//   yaw   +1 -> nose LEFT      -> rudder trailing edge LEFT (+X)
const AILERON_MAX = 0.42;
const ELEVATOR_MAX = 0.38;
const RUDDER_MAX = 0.45;
const FLAP_ANGLE = [0, 0.14, 0.34, 0.7];
const GEAR_TIME = 2.4; // seconds from locked up to locked down

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// Aircraft mesh, forward = +Z, origin at the plane's centre.
// Returns the prop groups so the entity can spin them, the muzzle markers, the
// hit box, the meshes the damage model can take off the aeroplane, and the rig
// that drives the gear and the control surfaces.
// ---------------------------------------------------------------------------
// The canopy glass (V-08). Nearly colourless (#f2f4f4, HSV saturation .008)
// at opacity 0.10, and it gets its look the way glass does: the clear-glass
// patch (core/materials.js applyClearGlass) adds the Fresnel reflection ON
// TOP of the transmitted view instead of multiplying it by the alpha, so the
// pane shows the sky at a grazing angle and next to nothing face-on. It is its
// own instance because it also carries the smoke-screen veil
// (effects.js applySmokeVeil): glass is transparent and sorts AFTER the smoke
// volume, so without the veil it was blended over a screen that had already
// hidden the rest of the aeroplane and the canopy hung in the smoke on its
// own. The glass patch chains the veil's, and the veil fades the reflection
// as well as the pane. With no screen out the veil is exactly 1.0.
// Cached for the session and stamped shared, like every material it sits
// beside, so a battle teardown leaves it alone.
export const CANOPY_GLASS_HEX = 0xf2f4f4;
export const CANOPY_GLASS_OPACITY = 0.10;
let canopyGlass = null;
export function canopyGlassMaterial() {
  if (canopyGlass) return canopyGlass;
  const m = new THREE.MeshStandardMaterial({
    color: CANOPY_GLASS_HEX,
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: CANOPY_GLASS_OPACITY,
    envMapIntensity: 1,
  });
  m.name = 'canopyGlass';
  applySmokeVeil(m);
  applyClearGlass(m);
  // markSharedGeometry is the materials module's exported stamp; it marks any
  // object (userData.shared + the shared symbol) — the same stamp markShared
  // puts on the cached materials
  markSharedGeometry(m);
  canopyGlass = m;
  return m;
}

// Navigation lamps (bible V-42). The lens is lit coloured glass inside the
// airframe material (AF_CLASS.LENS_RED / LENS_GREEN), and that is all a
// fighter shows in daylight combat: the lamps are off. An emitter is allowed
// only on the airfield at dawn and dusk, the hours an aeroplane really taxied
// out with them burning, and at no more than 2.5x the luminance of the
// battle's sunlit white card (the bible's ceiling is 3x), so a wingtip never
// outshines the sky. Two small shells over the lenses, one per wing panel so
// a lamp leaves with its wing; hidden — no draw — whenever they are dark.
export const NAV_LAMP_WHITE_CARD = 2.5;
const NAV_LAMP = {
  red: { lens: 0x7a2420, emit: 0xff3020 },
  green: { lens: 0x245e3e, emit: 0x30ff80 },
};
const navLampMats = {};
export function navLampMaterial(kind) {
  let m = navLampMats[kind];
  if (m) return m;
  const k = NAV_LAMP[kind] || NAV_LAMP.red;
  m = new THREE.MeshStandardMaterial({
    color: k.lens, roughness: 0.2, metalness: 0, emissive: k.emit, emissiveIntensity: 0,
  });
  m.name = `navLamp ${kind}`;
  // linear luminance of one unit of the emissive colour
  m.userData.emitY = 0.2126 * m.emissive.r + 0.7152 * m.emissive.g + 0.0722 * m.emissive.b;
  markSharedGeometry(m);
  navLampMats[kind] = m;
  return m;
}
// The lens luminance the lamps burn at under `preset` (scene-linear, the units
// of preset.light.whiteLitH/V), or 0 when they are off.
export function navLampLuminance(preset = null) {
  let p = preset;
  if (!p) {
    try { p = activePreset(); } catch { p = null; }
  }
  if (!p || (p.todKey !== 'dawn' && p.todKey !== 'dusk') || !p.light) return 0;
  return NAV_LAMP_WHITE_CARD * Math.max(p.light.whiteLitH || 0, p.light.whiteLitV || 0);
}

// ---------------------------------------------------------------------------
// The finish: one airframe material per type (V-05/06/08/09/12)
// ---------------------------------------------------------------------------

// Half-width of the fuselage loft at station z.
function fuselageHalfWidthAt(spec, z) {
  const s = fuselageSections(spec);
  if (z >= s[0][0]) return s[0][1];
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i];
    const b = s[i + 1];
    if (z <= a[0] && z >= b[0]) return lerp(a[1], b[1], (a[0] - z) / Math.max(1e-6, a[0] - b[0]));
  }
  return s[s.length - 1][1];
}

// A point on the left wing panel (its own frame) carried into the aircraft frame.
function wingPointToAir(lay, xl, yl, zl, out = new THREE.Vector3()) {
  const d = lay.dihedral;
  return out.set(xl * Math.cos(d) - yl * Math.sin(d), lay.wingY + xl * Math.sin(d) + yl * Math.cos(d), lay.wingZ + zl);
}

// The spec's markings, placed on the airframe the builder drew. Wing markings
// are projected in plan onto the panel surface, fuselage ones from the side
// at the loft's own width, fin ones onto the fin plate (core/materials.js
// AF_FS_MAP). Painted, so a roundel continues over an aileron and wears with
// the coat. Sizes are glyph widths in metres (*verify* per type).
export function markingsOf(spec) {
  const { lay } = cachedPlaneGeometry(spec);
  const atlas = insigniaAtlas();
  const out = [];
  const wing = lay.wing;
  for (const m of spec.markings || []) {
    const r = atlas.rect(m.glyph);
    if (!r) continue;
    const w = m.size;
    const h = m.size * r.aspect;
    if (m.on === 'wing') {
      const pf = planformAt(wing, m.u);
      const p = wingPointToAir(lay, wing.spanHalf * m.u, dihedralY(wing, m.u), pf.sweep + (m.dz || 0));
      const side = m.side || 'both';
      out.push({
        glyph: m.glyph, rect: r, axis: 'plan', x: side === 'right' ? -p.x : p.x, y: p.y, z: p.z, w, h,
        facing: m.face === 'lower' ? -1 : 1, mirror: side === 'both', depth: 0.35, classes: 2,
      });
    } else if (m.on === 'fuselage') {
      const hw = fuselageHalfWidthAt(spec, m.z);
      out.push({
        glyph: m.glyph, rect: r, axis: 'side', x: hw, y: m.y, z: m.z, w, h,
        // on the flank, not wrapped over the spine and the belly
        facing: 1, mirror: true, depth: Math.max(0.18, hw * 0.6), classes: 1, minFace: 0.42,
      });
    } else if (m.on === 'fin') {
      out.push({
        glyph: m.glyph, rect: r, axis: 'side', x: 0, y: lay.finY + m.y, z: lay.stabZ + m.z, w, h,
        facing: 0, mirror: false, depth: 0.12, classes: 1,
      });
    }
  }
  return out;
}

// V-12 zone sources in the aircraft frame: exhaust, gun ports, the port
// walkway, the canopy sill, oil, leading edges.
function zonesOf(spec, lay) {
  const w = spec.weathering || {};
  const z = {};
  if (w.exhaust) z.exhaust = { ...w.exhaust };
  if (w.oil) z.oil = { ...w.oil };
  if (w.walkway) {
    z.walkway = {
      x0: w.walkway.x0, x1: w.walkway.x1,
      z0: lay.wingZ + w.walkway.dz0, z1: lay.wingZ + w.walkway.dz1, coverage: w.walkway.coverage,
    };
  }
  z.sill = {
    z0: lay.canopyZ - 0.95, z1: lay.canopyZ + 0.55,
    y0: lay.canopyY - 0.30, y1: lay.canopyY + 0.04, halfW: 0.62, coverage: 0.12,
  };
  z.le = { chord: 0.05, coverage: 0.05 };
  const guns = [];
  const wing = lay.wing;
  for (const g of (spec.shape && spec.shape.wingGuns) || []) {
    const pfa = planformAt(wing, g.u);
    const p = wingPointToAir(lay, wing.spanHalf * g.u, dihedralY(wing, g.u), pfa.sweep + pfa.chord * 0.5);
    guns.push({ x: p.x, y: p.y, z: p.z, r: Math.max(0.02, g.r) });
  }
  z.guns = guns;
  return z;
}

// The material table, per class (core/materials.js AF_CLASS). Paint classes
// take their colour from the scheme; these rows carry their roughness.
function classesOf(spec) {
  const f = spec.finish || {};
  const C = AF_CLASS;
  const paint = f.rough != null ? f.rough : 0.65;
  const t = [];
  t[C.FUS] = { hex: 0x808080, rough: paint, metal: 0, normal: 0.7 };
  t[C.SURF] = { hex: 0x808080, rough: paint, metal: 0, normal: 0.7 };
  t[C.UNDER] = { hex: 0x808080, rough: paint, metal: 0, normal: 0.6 };
  t[C.GUN] = { hex: 0x8a8c8e, rough: 0.42, metal: 1, normal: 0.3 };
  // heat-darkened stubs: burnt brown-black, not the rust of a tank muffler
  t[C.EXHAUST] = { hex: 0x463a31, rough: 0.78, metal: 0, normal: 0.6 };
  t[C.INTERIOR] = { hex: f.interior != null ? f.interior : 0x5a5c58, rough: 0.8, metal: 0, normal: 0.3 };
  t[C.PILOT] = { hex: 0x4a3a2c, rough: 0.7, metal: 0, normal: 0.2 };
  t[C.TYRE] = { hex: 0x3a3a38, rough: 0.85, metal: 0, normal: 0.4 };
  // unlit lenses: coloured glass domes, Y .03-.10 (bible 5.2, V-42)
  t[C.LENS_RED] = { hex: 0x7a2420, rough: 0.1, metal: 0, normal: 0 };
  t[C.LENS_GREEN] = { hex: 0x245e3e, rough: 0.1, metal: 0, normal: 0 };
  t[C.BLADE] = { hex: f.blade != null ? f.blade : 0x2c2d2f, rough: 0.55, metal: 0, normal: 0.2 };
  t[C.SPINNER] = {
    hex: f.spinner != null ? f.spinner : 0x2c2d2f,
    rough: f.spinnerRough != null ? f.spinnerRough : paint,
    metal: f.spinnerMetal || 0,
    normal: 0.3,
  };
  t[C.ARMOUR_GLASS] = { hex: 0x2e3133, rough: 0.06, metal: 0, normal: 0 };
  t[C.STEEL] = { hex: 0x3e4144, rough: 0.6, metal: 0, normal: 0.4 };
  t[C.BOMB] = { hex: f.bomb != null ? f.bomb : 0x4d5244, rough: 0.8, metal: 0, normal: 0.4 };
  t[C.ROCKET] = { hex: 0x6b6f72, rough: 0.55, metal: 0, normal: 0.3 };
  return t;
}

// The painted upper surfaces AS SEEN IN PLAN, [[x, z, area], ...]: the
// airframe is rasterised from above on a FOOT_STEP_M grid, keeping the
// top-most skin in each cell, and a cell joins the footprint when that skin
// wears the upper scheme (a wing or tailplane panel facing the sky, or the
// fuselage spine). The scheme's pattern is normalised on these, so its colour
// split is the split a plan view of the aeroplane shows (bible C-17; core/
// materials.js paintSchemePattern). Summing the triangles instead counts
// what the plan never shows — the wing centre section running through the
// fuselage, the roots under the fillets — and one sample per triangle
// misses the pattern's edges on a wing panel half a square metre across.
const FOOT_STEP_M = 0.03;
function paintFootprint(built) {
  if (built.footprint) return built.footprint;
  const geos = [built.skin.body, built.skin.wingL, built.skin.wingR].filter(Boolean);
  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
  for (const g of geos) {
    const a = g.attributes.aAir.array;
    for (let i = 0; i < a.length; i += 3) {
      x0 = Math.min(x0, a[i]); x1 = Math.max(x1, a[i]);
      z0 = Math.min(z0, a[i + 2]); z1 = Math.max(z1, a[i + 2]);
    }
  }
  const out = [];
  if (!(x1 > x0 && z1 > z0)) {
    built.footprint = out;
    return out;
  }
  const h = FOOT_STEP_M;
  const nx = Math.ceil((x1 - x0) / h) + 1;
  const nz = Math.ceil((z1 - z0) / h) + 1;
  const top = new Float32Array(nx * nz).fill(-Infinity);
  const paint = new Uint8Array(nx * nz);
  for (const g of geos) {
    const a = g.attributes.aAir.array;
    const n = g.attributes.aAirN.array;
    const mk = g.attributes.aMark.array;
    const cnt = g.attributes.position.count;
    for (let i = 0; i + 2 < cnt; i += 3) {
      const j = i * 3;
      const ax = a[j]; const ay = a[j + 1]; const az = a[j + 2];
      const bx = a[j + 3]; const by = a[j + 4]; const bz = a[j + 5];
      const cx = a[j + 6]; const cy = a[j + 7]; const cz = a[j + 8];
      const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
      if (Math.abs(det) < 1e-12) continue; // edge-on in plan: no area to own
      const cls = Math.round(mk[i * 4]);
      const ny = (n[i * 3 + 1] + n[i * 3 + 4] + n[i * 3 + 7]) / 3;
      const up = (cls === AF_CLASS.SURF && ny > 0.15) || (cls === AF_CLASS.FUS && ny > 0.5) ? 1 : 0;
      const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / h - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / h - 0.5));
      const k0 = Math.max(0, Math.ceil((Math.min(az, bz, cz) - z0) / h - 0.5));
      const k1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) - z0) / h - 0.5));
      for (let k = k0; k <= k1; k++) {
        const pz = z0 + (k + 0.5) * h;
        for (let q = i0; q <= i1; q++) {
          const px = x0 + (q + 0.5) * h;
          const u = ((px - ax) * (cz - az) - (cx - ax) * (pz - az)) / det;
          const v = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / det;
          if (u < 0 || v < 0 || u + v > 1) continue;
          const y = ay + u * (by - ay) + v * (cy - ay);
          const c = k * nx + q;
          if (y <= top[c]) continue;
          top[c] = y;
          paint[c] = up;
        }
      }
    }
  }
  const area = h * h;
  for (let k = 0; k < nz; k++) {
    for (let q = 0; q < nx; q++) {
      if (paint[k * nx + q]) out.push([x0 + (q + 0.5) * h, z0 + (k + 0.5) * h, area]);
    }
  }
  built.footprint = out;
  return out;
}

// Everything the airframe material needs for this type, resolved from the
// spec and the layout. Exported for the lane's tests and tools.
export function airframeDef(spec) {
  const built = cachedPlaneGeometry(spec);
  const { lay } = built;
  const f = spec.finish || {};
  const scheme = spec.scheme || { pattern: 'mono', upper: [spec.color], lower: spec.color };
  return {
    key: spec.id,
    classes: classesOf(spec),
    scheme,
    extent: Math.max(spec.span / 2, spec.len / 2) + 0.6,
    footprint: paintFootprint(built),
    nmf: spec.nmf || null,
    insignia: { texture: insigniaAtlas().texture, list: markingsOf(spec) },
    zones: zonesOf(spec, lay),
    prop: { R: lay.propR, tipFrom: f.tipFrom != null ? f.tipFrom : 2, tipHex: f.tip != null ? f.tip : null },
    tile: 2.4,
  };
}

export function planeMaterial(spec) {
  return airframeMaterial(airframeDef(spec));
}

// A-01: the disc for this propeller, a fresh material (its opacity is this
// aeroplane's spin) over a cached solidity texture.
//
// What a photograph of a turning propeller records, seen from ahead or
// behind, is the blade's PROJECTION on the disc: the chord times cos(beta),
// beta being the blade angle the constant-speed unit holds in fast flight.
// That angle follows the helix the section flies, tan(beta) = advance per
// turn / (2 pi r), with the advance = the type's top speed / the hub's
// full-power rate (PROP_PHOTO_RPS, the 22 rev/s planeEntity spins it at).
// The coarse root therefore shows far less of itself than its planform chord,
// which is why a real disc is a faint veil, densest a little inboard of mid
// radius, and not a dark hub.
const PROP_PHOTO_RPS = 22;
function propDiscFor(spec, lay) {
  const f = spec.finish || {};
  const p = lay.prop;
  const R = lay.propR;
  const advance = displaySpeedKmh(spec.maxSpeed || 100) / 3.6 / PROP_PHOTO_RPS;
  return propDiscMaterial({
    key: spec.id,
    blades: lay.blades,
    R,
    discR: R * 1.012,
    hubR: p.hubR,
    chord: (r) => {
      const u = Math.max(0, Math.min(1, (r - p.hubR) / Math.max(1e-3, R - p.hubR)));
      const shape = p.squareTip ? 0.9 + 0.14 * Math.sin(Math.PI * u) : 0.82 + 0.35 * Math.sin(Math.PI * u);
      const c = (p.chordRoot + (p.chordTip - p.chordRoot) * u) * shape;
      const ring = 2 * Math.PI * Math.max(r, 1e-3);
      return c * (ring / Math.hypot(ring, advance));
    },
    bladeHex: f.blade != null ? f.blade : 0x2c2d2f,
    tipHex: f.tip != null ? f.tip : null,
    tipFrom: f.tipFrom != null ? f.tipFrom : 2,
    rough: 0.55,
    fan: p.fan ? { blades: p.fan.blades, inner: p.fan.inner, outer: p.fan.outer, chord: p.fan.chord, hex: 0x3a3d3f } : null,
  });
}

// Above this many revolutions a second the blades are hidden and the disc
// carries the propeller alone (A-01): 8 rev/s is ~480 rpm. The limit also
// drops with the frame rate and the blade count, so a blade never steps more
// than 0.4 of the gap between blades in one frame — the strobing threshold.
export const PROP_BLUR_RPS = 8;
export function propHideRps(blades, fps = 60) {
  return Math.min(PROP_BLUR_RPS, (0.4 * Math.max(10, fps)) / Math.max(1, blades));
}

// P-03: distant aircraft stop casting shadows (a plane 1 km up throws a
// sub-texel speck outside the shadow box anyway). A low one casts only while
// its shadow can land in the sun's shadow box, which scenery.js centres on
// the ground under the camera: an aeroplane taxiing on the far airfield has
// nowhere to put one.
export const SHADOW_NEAR_M = 400;
export const SHADOW_AGL_M = 150;
export function lowPlaneCastsInto(dx, dz, agl, env) {
  const e = env || {};
  const tanE = Math.tan((Math.max(6, e.casterElevDeg != null ? e.casterElevDeg : 45) * Math.PI) / 180);
  const reach = Math.hypot(e.shadowHalf || 300, e.shadowHalfY || 300) + Math.max(0, agl) / tanE + 40;
  return dx * dx + dz * dz < reach * reach;
}

function bone(name, parent, x = 0, y = 0, z = 0) {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(x, y, z);
  parent.add(b);
  return b;
}

// A store is a bone: hiding it collapses its vertices to the station point.
// `visible` keeps its old meaning for planeEntity.js and combat/bombs.js —
// set it false and the store is gone from the rack, true and it is back.
function storeBone(name, parent, st) {
  const b = bone(name, parent, st.x, st.y, st.z);
  let shown = true;
  Object.defineProperty(b, 'visible', {
    configurable: true,
    enumerable: true,
    get() {
      return shown;
    },
    set(v) {
      shown = !!v;
      b.scale.setScalar(shown ? 1 : 1e-4);
    },
  });
  return b;
}

export function buildPlaneMesh(spec, tintColor = null, teamColor = 0x4f8fd0) {
  // Both colour arguments are kept for the callers' signature and ignored: an
  // aeroplane wears its own historical scheme and national markings whoever
  // flies it (bible C-11 and V-02 — paint is never a team signal; friend and
  // foe are told apart by the HUD markers, H-06), and the markings are the
  // aircraft's own, so they are drawn in the hangar too.
  void tintColor;
  void teamColor;
  const { span, len } = spec;
  const built = cachedPlaneGeometry(spec);
  const { geo, lay, skin } = built;

  const mat = planeMaterial(spec);
  const glass = canopyGlassMaterial();
  const discMat = propDiscFor(spec, lay);

  const group = new THREE.Group();
  const opaque = [];
  const skinnedMeshes = [];
  const plain = (g, name, parent) => {
    if (!g) return null;
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.castShadow = true;
    parent.add(m);
    opaque.push(m);
    return m;
  };
  const skinned = (g, name, parent) => {
    if (!g) return null;
    const m = new THREE.SkinnedMesh(g, mat);
    m.name = name;
    m.castShadow = true;
    parent.add(m);
    opaque.push(m);
    skinnedMeshes.push(m);
    return m;
  };

  // ---- airframe: fuselage, fin and rudder, tailplane and elevator ----
  const body = skinned(skin.body, 'body', group);
  const bodyRoot = bone('bodyRoot', body);
  const elevator = bone('elevator', bodyRoot, 0, lay.stabY, lay.stabZ + lay.elevHinge);
  const fin = bone('fin', bodyRoot, 0, lay.finY, lay.stabZ);
  const rudder = bone('rudder', fin, 0, 0, lay.rudderHinge);
  // the tailplane halves are welded to the airframe now; these name where
  // they are for anything that asks
  const stabs = [];
  for (const k of ['stabL', 'stabR']) {
    const s = new THREE.Object3D();
    s.name = k;
    s.position.set(0, lay.stabY, lay.stabZ);
    bodyRoot.add(s);
    stabs.push(s);
  }
  const canopy = new THREE.Mesh(geo.glass, glass);
  canopy.name = 'canopy';
  // glass throws no shadow worth a pass; its frames are in the airframe
  canopy.castShadow = false;
  group.add(canopy);

  // ---- wings, with their surfaces hung off them ----
  const wings = [];
  const wingBones = [];
  for (const [key, g, sign, ailName, flapName] of [
    ['leftWing', skin.wingL, 1, 'aileronL', 'flapL'],
    ['rightWing', skin.wingR, -1, 'aileronR', 'flapR'],
  ]) {
    const wing = skinned(g, key, group);
    wing.position.set(0, lay.wingY, lay.wingZ);
    wing.rotation.z = sign * lay.dihedral;
    wings.push(wing);
    const root = bone(`${key}Root`, wing);
    const ail = bone(ailName, root, 0, lay.aileronY || 0, lay.aileronHinge);
    const flap = bone(flapName, root, 0, lay.flapY || 0, lay.flapHinge);
    wingBones.push(root, ail, flap);
  }

  // ---- navigation lamps: the emitter shells (see navLampMaterial) ----
  if (!built.navGlow) {
    built.navGlow = [1, -1].map((s) => markSharedGeometry(
      new THREE.SphereGeometry(0.058, 8, 6).translate(s * lay.navHs * lay.navU, lay.navY, lay.navZ)));
  }
  const navLamps = wings.map((wing, i) => {
    const lamp = new THREE.Mesh(built.navGlow[i], navLampMaterial(i === 0 ? 'red' : 'green'));
    lamp.name = i === 0 ? 'navLampL' : 'navLampR';
    lamp.castShadow = false;
    lamp.visible = false;
    wing.add(lamp);
    return lamp;
  });

  // ---- propeller ----
  const props = [];
  const prop = new THREE.Group();
  prop.name = 'propeller';
  prop.position.z = lay.propZ;
  const blades = plain(skin.blades, 'propBlades', prop);
  const discMesh = new THREE.Mesh(skin.disc, discMat);
  discMesh.name = 'propDisc';
  discMesh.castShadow = false;
  prop.add(discMesh);
  group.add(prop);
  props.push(prop);

  // A-01. The disc reads the propeller's speed — prop.userData.rps when the
  // entity states it (planeEntity.js turns the prop at its real rate), else
  // measured off the rotation every caller already applies — and hands over
  // from the blades to the disc before the blades could strobe. The blades'
  // own visibility is decided here for the next frame (they draw before the
  // transparent disc).
  {
    let lastAngle = prop.rotation.z;
    let lastMs = 0;
    let level = 0;
    let fps = 60;
    discMesh.onBeforeRender = () => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const ms = now - lastMs;
      // a second camera in the same frame (minimap, hangar) is not a new sample
      if (ms < 4) return;
      lastMs = now;
      if (ms < 250) fps += (1000 / ms - fps) * 0.1;
      let rps;
      if (typeof prop.userData.rps === 'number') rps = prop.userData.rps;
      else {
        const d = prop.rotation.z - lastAngle;
        rps = d > 0 ? d / (ms / 1000) / (Math.PI * 2) : 0;
      }
      lastAngle = prop.rotation.z;
      const hide = propHideRps(lay.blades, fps);
      const t = Math.max(0, Math.min(1, (rps - hide * 0.5) / (hide * 0.5)));
      const want = t * t * (3 - 2 * t);
      level += (want - level) * Math.min(1, ms / 110);
      discMat.opacity = level;
      if (blades) blades.visible = rps < hide;
    };
  }

  // ---- undercarriage ----
  // Hidden outright while it is up: draw calls an aeroplane in cruise has no
  // use for, and the wheels are inside the wing anyway.
  const gearGroup = new THREE.Group();
  gearGroup.name = 'gear';
  const legs = [];
  for (const [key, sign] of [['gearMainL', 1], ['gearMainR', -1]]) {
    const leg = new THREE.Group();
    leg.name = key;
    leg.position.set(sign * lay.gearX, lay.wingY - 0.02, lay.gearZ);
    plain(skin.gearLeg, `${key}Strut`, leg);
    plain(skin.gearTyre, `${key}Tyre`, leg);
    // Which way the legs fold is a per-aircraft fact, not a shared constant.
    // The Spitfire's fold OUTWARD toward the tips off a narrow pintle — the
    // single most-cited thing about the aeroplane — while the Il-2's swing
    // REARWARD into centre-section nacelles and leave the tyres half exposed.
    if (lay.gearRetract === 'aft') {
      leg.userData.retractAxis = 'x';
      leg.userData.retractAngle = -1.5;
    } else {
      leg.userData.retractAxis = 'z';
      leg.userData.retractAngle = (lay.gearRetract === 'out' ? sign : -sign) * 1.52;
    }
    // rake, so the tyres end up wider apart than the pivots when down
    leg.userData.rake = sign * (lay.gearRake || 0);
    gearGroup.add(leg);
    legs.push(leg);
  }
  const tailLeg = new THREE.Group();
  tailLeg.name = 'gearTail';
  tailLeg.position.set(0, -0.1, lay.tailGearZ);
  plain(skin.tailLeg, 'gearTailStrut', tailLeg);
  plain(skin.tailTyre, 'gearTailTyre', tailLeg);
  // A fixed tailwheel hangs outside the retractable group, or it would vanish
  // with the mains the moment the aeroplane cleaned up.
  if (lay.tailFixed) group.add(tailLeg);
  else gearGroup.add(tailLeg);
  group.add(gearGroup);

  // ---- ordnance ----
  // One group a kind, both built, and the one the aeroplane is not flying today
  // is switched off at the group. That matters more than it looks: the release
  // code hides individual stores and the rearm puts them all back, and if it
  // put back a fit the aeroplane is not carrying we would have a Zero taxiing
  // out with bombs AND rockets on it. Hiding the parent means "not fitted"
  // survives anything done to the children.
  //
  // A kind is ONE skinned mesh (racks and bodies) and each store is a bone at
  // its station: a store's .position IS its position in the aeroplane's frame
  // (nothing above it carries a transform), which is what the release code
  // reads before it converts to world space.
  const storesRoot = new THREE.Group();
  storesRoot.name = 'stores';
  group.add(storesRoot);
  const stores = { bomb: [], rocket: [] };
  const storeGroups = { bomb: null, rocket: null };
  const storeBoneList = [];
  for (const kind of ['bomb', 'rocket']) {
    const list = (lay.stores && lay.stores[kind]) || [];
    const kindGroup = new THREE.Group();
    kindGroup.name = `${kind}Stores`;
    storesRoot.add(kindGroup);
    const sm = list.length && skin[kind] ? skinned(skin[kind], `${kind}Racks`, kindGroup) : null;
    const host = sm || kindGroup;
    const root = bone(`${kind}Root`, host);
    storeBoneList.push(root);
    list.forEach((st, i) => {
      const b = storeBone(`${kind}${i}`, root, st);
      stores[kind].push(b);
      storeBoneList.push(b);
    });
    if (sm) storeGroups[kind] = kindGroup;
    else storesRoot.remove(kindGroup);
  }
  // ---- one skeleton for the whole aeroplane ----
  // bone order = the skinIndex values assembleSkins baked (BONE above). The
  // bind pose is taken with EVERY store hanging (scale 1) — and bind() takes
  // it again, so the fit is applied only after the last bind: a store hidden
  // before the inverses are computed would bake its 1e-4 collapse into them,
  // and showing it later would throw the rack kilometres off the aeroplane.
  const boneList = [bodyRoot, elevator, fin, rudder, prop, ...wingBones, ...storeBoneList];
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(boneList);
  for (const m of skinnedMeshes) {
    m.bind(skeleton);
    // the rest-pose bounds, a little grown for deflected surfaces: three would
    // otherwise skin every vertex on the CPU the first time it culls
    m.boundingBox = m.geometry.boundingBox.clone().expandByScalar(0.25);
    m.boundingSphere = m.geometry.boundingSphere.clone();
    m.boundingSphere.radius += 0.25;
  }

  // Which fit is actually hanging there. In battle mods.js has already nulled
  // the one that is not carried, so this is exactly the player's choice; an
  // un-modded spec (the hangar, a vehicle card, the x-ray ghost) still lists
  // both, and showing a full bomb load reads better there than showing a full
  // bomb load AND a full rocket load on the same wing.
  const fitted = spec.bombs ? 'bomb' : spec.rockets ? 'rocket' : null;
  for (const kind of ['bomb', 'rocket']) {
    if (!storeGroups[kind]) continue;
    const on = kind === fitted;
    storeGroups[kind].visible = on;
    for (const s of stores[kind]) s.visible = on;
  }
  // the bone texture is the one GPU resource this aeroplane owns outright
  group.addEventListener('removed', () => skeleton.dispose());

  const surfaces = {
    aileronL: wingBones[1],
    aileronR: wingBones[4],
    flapL: wingBones[2],
    flapR: wingBones[5],
    elevator,
    rudder,
  };

  // P-03: a distant aircraft high above the ground casts no shadow. Decided
  // once per drawn frame from the camera that draws the aeroplane, and
  // applied to the next frame's shadow pass.
  const camPos = new THREE.Vector3();
  const selfPos = new THREE.Vector3();
  let casting = true;
  const shadowCut = (renderer, scene, camera) => {
    if (!camera || !camera.isPerspectiveCamera) return;
    camera.getWorldPosition(camPos);
    group.getWorldPosition(selfPos);
    let on = camPos.distanceToSquared(selfPos) < SHADOW_NEAR_M * SHADOW_NEAR_M;
    if (!on) {
      let ground = 0;
      try { ground = terrainHeight(selfPos.x, selfPos.z); } catch { ground = 0; }
      const agl = selfPos.y - ground;
      on = agl < SHADOW_AGL_M && lowPlaneCastsInto(selfPos.x - camPos.x, selfPos.z - camPos.z, agl, environmentState());
    }
    if (on === casting) return;
    casting = on;
    for (const m of opaque) m.castShadow = on;
  };
  // The lamps burn on the ground with the gear down, at dawn and dusk only.
  // planeEntity says where the aeroplane is on its propeller
  // (prop.userData.onGround, next to the rps it already states); the hangar
  // and the cards never say, so their lamps stay dark.
  const navUpdate = () => {
    const lum = prop.userData.onGround === true && rig.gearT > 0.99 ? navLampLuminance() : 0;
    const lit = lum > 0;
    for (const lamp of navLamps) {
      lamp.visible = lit;
      if (lit) lamp.material.emissiveIntensity = lum / Math.max(1e-3, lamp.material.userData.emitY);
    }
  };
  if (body) {
    body.onBeforeRender = (renderer, scene, camera) => {
      shadowCut(renderer, scene, camera);
      navUpdate();
    };
  }

  // The rig is the whole animatable aeroplane in one object, and it is on the
  // group's userData as well as on the return value so anything holding only a
  // scene node can still fly it.
  const rig = {
    group,
    gearGroup,
    legs,
    tailLeg,
    surfaces,
    props,
    stores,
    storeGroups,
    skeleton,
    navLamps,
    gearT: 0,
    // Swap the fit without rebuilding the aeroplane: 'bomb'/'bombs',
    // 'rocket'/'rockets', or null for a clean wing. This is what a loadout
    // chooser that does not want to go back to the hangar needs.
    setStores(kind) {
      const want = kind === 'bombs' ? 'bomb' : kind === 'rockets' ? 'rocket' : kind;
      for (const k of ['bomb', 'rocket']) {
        const g = storeGroups[k];
        if (!g) continue;
        const on = k === want;
        g.visible = on;
        // Belt and braces: the group says "this fit is not fitted" and each
        // store says "and I am not hanging there either". Whichever of the two
        // the release and rearm code touches, the other still holds.
        for (const s of stores[k]) s.visible = on;
      }
    },
    setGear(t) {
      const g = clamp01(t);
      this.gearT = g;
      for (const leg of legs) {
        const a = leg.userData.retractAngle * (1 - g);
        if (leg.userData.retractAxis === 'x') {
          leg.rotation.x = a;
          leg.rotation.z = (leg.userData.rake || 0) * g;
        } else {
          leg.rotation.z = a + (leg.userData.rake || 0) * g;
          leg.rotation.x = 0;
        }
      }
      // a Spitfire Mk V's tailwheel does not retract, and an Il-2's is a fixed
      // castoring wheel hanging in the airstream with no doors
      if (!lay.tailFixed) tailLeg.rotation.x = -1.35 * (1 - g);
      // Fully up is draw calls of wheels folded inside the wing: skip them.
      // Not on the Il-2 — its wheels deliberately protrude when retracted, and
      // hiding them would remove a recognition cue rather than save anything.
      gearGroup.visible = lay.gearAlwaysVisible || g > 0.002;
    },
    setSurfaces(c) {
      const roll = c && c.roll ? Math.max(-1, Math.min(1, c.roll)) : 0;
      const pitch = c && c.pitch ? Math.max(-1, Math.min(1, c.pitch)) : 0;
      const yaw = c && c.yaw ? Math.max(-1, Math.min(1, c.yaw)) : 0;
      const flapStage = c && c.flaps ? Math.max(0, Math.min(3, Math.round(c.flaps))) : 0;
      const flap = -FLAP_ANGLE[flapStage];
      if (surfaces.aileronL) surfaces.aileronL.rotation.x = -roll * AILERON_MAX;
      if (surfaces.aileronR) surfaces.aileronR.rotation.x = roll * AILERON_MAX;
      if (surfaces.flapL) surfaces.flapL.rotation.x = flap;
      if (surfaces.flapR) surfaces.flapR.rotation.x = flap;
      if (surfaces.elevator) surfaces.elevator.rotation.x = -pitch * ELEVATOR_MAX;
      if (surfaces.rudder) surfaces.rudder.rotation.y = -yaw * RUDDER_MAX;
    },
    // One call per frame from whoever owns the aeroplane: reads the same state
    // the flight model already keeps and drives every moving part from it.
    update(plane, dt = 1 / 60) {
      if (!plane) return;
      const want = plane.gear ? 1 : 0;
      const step = Math.max(0, dt) / GEAR_TIME;
      const g = this.gearT + Math.max(-step, Math.min(step, want - this.gearT));
      this.setGear(g);
      const ctl = plane.controls || null;
      this.setSurfaces({
        roll: ctl ? ctl.roll : 0,
        pitch: plane.pitchCmd != null ? plane.pitchCmd : ctl ? ctl.pitch : 0,
        yaw: ctl ? ctl.yaw : 0,
        flaps: plane.flaps || 0,
      });
    },
  };
  rig.setGear(0);
  rig.setSurfaces(null);
  group.userData.rig = rig;

  const muzzleL = new THREE.Object3D();
  muzzleL.position.set(-span * 0.16, -0.05, 1.0);
  const muzzleR = new THREE.Object3D();
  muzzleR.position.set(span * 0.16, -0.05, 1.0);
  group.add(muzzleL, muzzleR);

  // generous single hitbox (fuselage + wings), local space
  const hitBox = {
    min: new THREE.Vector3(-span / 2, -0.9, -len / 2 - 0.4),
    max: new THREE.Vector3(span / 2, 0.9, len / 2 + 1.2),
  };

  // partMeshes lets the damage model take pieces off the aeroplane — a wing
  // that fails structurally has to actually leave, or the player never believes
  // the roll that follows. Keyed by the same part names the layout uses; the
  // wing signs match the local frame (+X is the left wing). The wings are
  // meshes (hiding one takes its aileron, flap, guns and lamp with it); the
  // control surfaces and the fin are the bones that move them, the tailplane
  // halves named points on the airframe; the gear is as it always was.
  const partMeshes = {
    leftWing: wings[0],
    rightWing: wings[1],
    stabL: stabs[0],
    stabR: stabs[1],
    fin,
    elevator,
    rudder,
    aileronL: surfaces.aileronL,
    aileronR: surfaces.aileronR,
    flapL: surfaces.flapL,
    flapR: surfaces.flapR,
    canopy,
    gear: gearGroup,
    gearMainL: legs[0],
    gearMainR: legs[1],
    gearTail: tailLeg,
    propeller: prop,
  };

  // `stores` is the shared contract with planeEntity.js and combat/bombs.js:
  // { bomb: [Object3D, ...], rocket: [Object3D, ...] }, in RELEASE ORDER —
  // symmetrically in pairs from the inboard station outward, centreline first
  // where a type has one. Each entry is the store BODY only (a bone; its
  // `visible` collapses or restores it); its rack is part of `${kind}Racks`
  // and stays on the wing after the store has gone. Both arrays always exist,
  // and are empty when the type carries none of that kind.
  //
  // BOTH fits are built, because one cached build serves every spawn of the
  // type and the loadout is per spawn. The fit this aeroplane is not flying
  // starts hidden, at the group AND at each store, so:
  //   - releaseStore() hides one store; its rack stays, and the rest hang on;
  //   - restoreStores() may set every entry visible without putting a fit back
  //     on the aeroplane that it is not carrying — the kind's group still says
  //     no. Use setPlaneStores(built, kind) to change which fit is carried.
  // Each entry's .position is already the aeroplane's own frame (the two groups
  // above it carry no transform), so the release code can read .position or
  // getWorldPosition() and get the same station either way.
  return {
    group,
    muzzles: [muzzleL, muzzleR],
    hitBox,
    props,
    partMeshes,
    rig,
    surfaces,
    stores,
    storeGroups,
    storesRoot,
  };
}

// Convenience wrappers, so a caller that kept only the return value of
// buildPlaneMesh (or only the scene node) can still drive the aeroplane.
function rigOf(built) {
  if (!built) return null;
  if (built.rig) return built.rig;
  if (built.userData && built.userData.rig) return built.userData.rig;
  if (built.group && built.group.userData) return built.group.userData.rig || null;
  return null;
}

// t: 0 fully retracted, 1 down and locked.
export function setPlaneGear(built, t) {
  const rig = rigOf(built);
  if (rig) rig.setGear(t);
}

// Show one loadout and hide the other, on an aeroplane that is already built.
// kind: 'bomb' | 'bombs' | 'rocket' | 'rockets' | null (clean).
// Safe on a build that carries neither.
export function setPlaneStores(built, kind) {
  const rig = rigOf(built);
  if (rig && rig.setStores) rig.setStores(kind);
}

// controls: { roll, pitch, yaw, flaps } — the same numbers planeEntity tracks.
export function setPlaneSurfaces(built, controls) {
  const rig = rigOf(built);
  if (rig) rig.setSurfaces(controls);
}

// One call a frame with the Plane entity itself: gear follows plane.gear,
// the surfaces follow plane.controls / plane.pitchCmd / plane.flaps.
export function updatePlaneRig(built, plane, dt = 1 / 60) {
  const rig = rigOf(built);
  if (rig) rig.update(plane, dt);
}

// ---------------------------------------------------------------------------
// Where the aeroplane touches the ground
// ---------------------------------------------------------------------------
//
// The ground-contact model in planeEntity.js needs to know where the tyres,
// the tailwheel, the belly, the propeller disc and the wingtips are, in the
// aeroplane's own frame (+Z nose, +Y canopy, +X left wing, origin at the
// fuselage mid-point). They come from the SAME layout the mesh is built from,
// so a Spitfire sits on its own narrow, long legs and an Il-2 on its short
// ones, and the wheels a player sees are the wheels that touch the runway.
//
//   mainX, mainY, mainZ   left main tyre contact patch (mirror X for the right)
//                         with the gear down and locked, aeroplane level
//   tailY, tailZ          tailwheel contact patch
//   bellyY                lowest point of the fuselage with the gear up
//   propZ, propR          propeller disc centre (on the thrust line) and radius
//   tipX, tipY, tipZ      left wingtip (mirror X for the right)
//   threePoint            nose-up pitch, rad, at which mains and tailwheel
//                         both touch level ground: the attitude it sits at
//   restHeight            height of the origin above level ground at rest in
//                         that attitude
const gearGeoCache = new WeakMap();

export function planeGearGeometry(spec) {
  const built = cachedPlaneGeometry(spec);
  let g = gearGeoCache.get(built);
  if (g) return g;
  const lay = built.lay;
  const rake = Math.abs(lay.gearRake || 0);
  const legLen = lay.legLen || 1;
  const wheelR = lay.wheelR || 0.3;
  const tailR = lay.tailR || 0.14;
  const mainY = lay.wingY - 0.02 - legLen * Math.cos(rake) - wheelR;
  const mainZ = lay.gearZ;
  const mainX = lay.gearX + legLen * Math.sin(rake);
  const tailY = -0.1 - (lay.tailLegLen || 0.42) - tailR;
  const tailZ = lay.tailGearZ;
  const threePoint = Math.atan2(tailY - mainY, Math.max(0.5, mainZ - tailZ));
  g = {
    mainX,
    mainY,
    mainZ,
    tailY,
    tailZ,
    // The same box the damage model and the old hit test use for the bottom
    // of the airframe: radiators and scoops hang about this low.
    bellyY: -0.9,
    propZ: lay.propZ,
    propR: lay.propR || 1.42,
    tipX: lay.tipX,
    tipY: lay.tipY,
    tipZ: lay.tipZ,
    threePoint,
    restHeight: -(mainY * Math.cos(threePoint) + mainZ * Math.sin(threePoint)),
  };
  gearGeoCache.set(built, g);
  return g;
}
