// One penetration vocabulary, two declared perspectives (art bible C-40/C-41,
// realism backlog H-05). This module is the ONLY place the pen-scale colours
// are written down: the battle HUD (ui/hud.js) and the hangar X-ray and
// protection analysis (ui/xray.js) both import it, so a gun sight and an
// armour drawing can never disagree about what green means again.
//
// THE VOCABULARY. Four outcomes, always with the same words and glyphs:
//   PEN       filled circle   ●
//   MARGINAL  half circle     ◐
//   NO PEN    cross           ×
//   RICOCHET  bent arrow      ↗
// Finer bands ("overmatch", "likely") are SUB-STEPS of one of the four: the
// same hue at a different CIE lightness, ΔL* >= 20 (SUB_STEP_DL), so lightness
// alone keeps them apart under every colour-vision deficiency.
//
// THE PERSPECTIVES. Green always means "the subject of this screen succeeds",
// and every legend names its subject:
//   'shot'   (HUD crosshair, gunner's optic, hit cam of your own shot)
//            PEN green, NO PEN red. Legend title "YOUR SHOT".
//   'armour' (protection analysis, any view of a shot striking you)
//            NO PEN green, PEN red (a hole in the armour). "THIS ARMOUR".
// Only the mapping swaps; the four hexes never do. RICOCHET is one hex in
// both. The two perspectives never appear on one screen.
//
// The verdict keys the game already speaks (tankEntity.penetrationForecast:
// 'yes' | 'maybe' | 'no' | 'ricochet', and xray.js's plate bands) all resolve
// through outcomeOf(), so callers never translate by hand.

// The four colours (bible 4.7). Measured minimum CIE76 ΔE between any two
// under the Machado 2009 severity-1 protan / deutan / tritan simulations is
// recorded by the instruments lane's test (penscale test, >= 20 required).
export const PEN_HEX = Object.freeze({
  green: '#5fd07a',
  amber: '#f2c24e',
  red: '#e8503c',
  ricochet: '#8aa8ff',
});

// ΔL* of a sub-step from its parent outcome (C-41: >= 20).
export const SUB_STEP_DL = 22;

export const OUTCOMES = Object.freeze([
  Object.freeze({ key: 'pen', verdict: 'yes', word: 'PEN', glyph: '●' }),
  Object.freeze({ key: 'marginal', verdict: 'maybe', word: 'MARGINAL', glyph: '◐' }),
  Object.freeze({ key: 'nopen', verdict: 'no', word: 'NO PEN', glyph: '×' }),
  Object.freeze({ key: 'ricochet', verdict: 'ricochet', word: 'RICOCHET', glyph: '↗' }),
]);

export const PERSPECTIVES = Object.freeze({
  shot: Object.freeze({ key: 'shot', title: 'YOUR SHOT' }),
  armour: Object.freeze({ key: 'armour', title: 'THIS ARMOUR' }),
});

// which of the four hexes each outcome wears, per perspective
const MAPPING = {
  shot: { pen: 'green', marginal: 'amber', nopen: 'red', ricochet: 'ricochet' },
  armour: { pen: 'red', marginal: 'amber', nopen: 'green', ricochet: 'ricochet' },
};

// Every spelling of a verdict the codebase uses, onto the four outcomes, with
// the sub-step it belongs to (0 = the outcome itself, -1 darker, +1 lighter).
const ALIAS = {
  yes: ['pen', 0],
  pen: ['pen', 0],
  penetration: ['pen', 0],
  overmatch: ['pen', -1],
  maybe: ['marginal', 0],
  marginal: ['marginal', 0],
  possible: ['marginal', 0],
  // penetrates on paper but inside the shell's scatter: penetrationForecast
  // calls that 'maybe', so it is a MARGINAL sub-step, not a PEN one
  likely: ['marginal', -1],
  no: ['nopen', 0],
  nopen: ['nopen', 0],
  nonpen: ['nopen', 0],
  'no pen': ['nopen', 0],
  ricochet: ['ricochet', 0],
};

const BY_KEY = {};
for (const o of OUTCOMES) BY_KEY[o.key] = o;

// The outcome record for any verdict spelling, or null.
export function outcomeOf(verdict) {
  if (verdict == null) return null;
  const a = ALIAS[String(verdict).toLowerCase()];
  return a ? BY_KEY[a[0]] : null;
}

// sub-step index of a verdict spelling (0 for the four outcomes themselves)
export function subStepOf(verdict) {
  const a = verdict == null ? null : ALIAS[String(verdict).toLowerCase()];
  return a ? a[1] : 0;
}

const perspectiveKey = (p) => (p === 'armour' || p === 'armor' ? 'armour' : 'shot');

// The '#rrggbb' a verdict wears in a perspective, sub-steps included; null for
// a verdict outside the vocabulary.
export function penHex(verdict, perspective = 'shot') {
  const o = outcomeOf(verdict);
  if (!o) return null;
  const base = PEN_HEX[MAPPING[perspectiveKey(perspective)][o.key]];
  const step = subStepOf(verdict);
  return step === 0 ? base : penSubStep(base, step * SUB_STEP_DL);
}

// The legend a screen shows: its subject title and the four rows in the
// vocabulary's order. `color` is the 0xRRGGBB integer for three.js-free
// canvas code that wants a number (xray.js); `hex` is the CSS string.
export function penLegend(perspective = 'shot') {
  const key = perspectiveKey(perspective);
  return {
    perspective: key,
    title: PERSPECTIVES[key].title,
    rows: OUTCOMES.map((o) => {
      const hex = PEN_HEX[MAPPING[key][o.key]];
      return { key: o.key, verdict: o.verdict, word: o.word, glyph: o.glyph, hex, color: hexToInt(hex) };
    }),
  };
}

export function hexToInt(hex) {
  return parseInt(String(hex).replace('#', ''), 16) >>> 0;
}

export function intToHex(n) {
  return `#${(n >>> 0).toString(16).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// colour science (sRGB D65 <-> CIELAB), used for the sub-steps and exported
// for the tests that hold this table to C-40
// ---------------------------------------------------------------------------
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;
const fLab = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fInv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

export function hexToLinear(hex) {
  const n = hexToInt(hex);
  return [toLin(((n >> 16) & 255) / 255), toLin(((n >> 8) & 255) / 255), toLin((n & 255) / 255)];
}

export function linearToLab(rgb) {
  const [r, g, b] = rgb;
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const fx = fLab(x / XN);
  const fy = fLab(y / YN);
  const fz = fLab(z / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToLinear(lab) {
  const fy = (lab[0] + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  const x = fInv(fx) * XN;
  const y = fInv(fy) * YN;
  const z = fInv(fz) * ZN;
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

export function hexToLab(hex) {
  return linearToLab(hexToLinear(hex));
}

export function linearToHex(rgb) {
  const byte = (v) => Math.round(Math.min(1, Math.max(0, toSrgb(Math.min(1, Math.max(0, v))))) * 255);
  return intToHex((byte(rgb[0]) << 16) | (byte(rgb[1]) << 8) | byte(rgb[2]));
}

// The same hue at L* + dL. Chroma is reduced only as far as it takes to stay
// inside the sRGB gamut, so the hue angle is kept exactly.
export function penSubStep(hex, dL) {
  const [L, a, b] = hexToLab(hex);
  const L2 = Math.min(98, Math.max(4, L + dL));
  const C = Math.hypot(a, b);
  const h = Math.atan2(b, a);
  for (let k = 0; k <= 40; k++) {
    const c = C * (1 - k / 40);
    const lin = labToLinear([L2, c * Math.cos(h), c * Math.sin(h)]);
    if (lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) return linearToHex(lin);
  }
  return linearToHex(labToLinear([L2, 0, 0]));
}

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied to LINEAR RGB.
export const CVD_MATRICES = Object.freeze({
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
});

export function simulateCvd(hex, kind) {
  const m = CVD_MATRICES[kind];
  const c = hexToLinear(hex);
  if (!m) return c;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = Math.min(1, Math.max(0, m[i][0] * c[0] + m[i][1] * c[1] + m[i][2] * c[2]));
  }
  return out;
}

export function deltaE76(labA, labB) {
  return Math.hypot(labA[0] - labB[0], labA[1] - labB[1], labA[2] - labB[2]);
}

// Smallest ΔE between any two of `hexes` under normal vision and the three
// simulations: { normal, protan, deutan, tritan, min }.
export function cvdSeparation(hexes) {
  const res = {};
  let min = Infinity;
  for (const kind of ['normal', 'protan', 'deutan', 'tritan']) {
    const labs = hexes.map((h) => linearToLab(kind === 'normal' ? hexToLinear(h) : simulateCvd(h, kind)));
    let m = Infinity;
    for (let i = 0; i < labs.length; i++) {
      for (let j = i + 1; j < labs.length; j++) m = Math.min(m, deltaE76(labs[i], labs[j]));
    }
    res[kind] = m;
    if (kind !== 'normal') min = Math.min(min, m);
  }
  res.min = min;
  return res;
}
