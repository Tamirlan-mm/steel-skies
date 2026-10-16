import * as THREE from 'three';
import { activePreset } from '../world/presets.js';
import { loadTexture, assetReady, assetStatus, getAssetSet } from './assets.js';

// Procedural PBR material factory.
//
// The whole game shipped on MeshLambertMaterial with flat colours: no specular
// response, no roughness variation, no environment, no surface detail. That is
// the single biggest reason it reads as "weak" next to a modern tank game, and
// it is fixable without adding one byte of asset — everything here is drawn on
// a 2D canvas at load time and uploaded as a texture.
//
// WHY TRIPLANAR, AND WHY IT IS NOT OPTIONAL
// The two largest surfaces on every tank — the lofted hull (loftHull) and the
// turret shell (prismY) in vehicles/tanks.js — are hand-built BufferGeometry
// that set `position` and nothing else. They have no `uv` attribute at all, so
// a conventional map would sample garbage on exactly the parts that fill the
// screen. Rather than author UVs for a dozen generated hull shapes, every
// material here projects its textures from object space along the three axes
// and blends by the surface normal. That works on any geometry, UVs or not,
// including the primitives, and it tiles without a seam.
//
// Cost note: triplanar samples each map three times. On the vehicles, which are
// a few thousand triangles each, that is free. It is NOT used for terrain, which
// is a single huge mesh with proper UVs of its own.
//
// PAINT (art bible 4.1-4.3, realism backlog V-01..V-04, V-11)
// * Paint is a DIELECTRIC: every painted surface is metalness 0 with F0 0.04
//   (C-02). Only bare metal is metal — the polished track faces (metalness map)
//   and the muzzle crown.
// * The calibrated paint hex is the colour. A canvas texture painted from it
//   keeps its mean within a few per cent of that hex (C-03); the CC0 photo
//   detail (core/assets.js vehicle sets) only MODULATES it, never replaces it.
// * Weathering is decided by ZONE in the shader (bible 5.3), not baked into the
//   albedo: dust and mud on the running gear, a dust film on decks, rain
//   streaks on vertical plates, chips on convex edges. The zone colours follow
//   the battle's biome through setVehicleEnvironment() (contract R1-Z).

// ---------------------------------------------------------------------------
// quality + render context
// ---------------------------------------------------------------------------

const TEX_SIZE = { low: 128, medium: 256, high: 512 };
let quality = 'high';
let maxAnisotropy = 4;
let battleRenderer = null;

// Textures are cached and shared, so a change of quality has to invalidate
// them. Callers that switch quality mid-session must call disposeMaterials().
export function setMaterialQuality(level) {
  if (level !== 'low' && level !== 'medium' && level !== 'high') return;
  if (level === quality) return;
  quality = level;
  disposeMaterials();
}

export function getMaterialQuality() {
  return quality;
}

// Anisotropy is a renderer capability, not a texture one, so it can only be
// known once a context exists. Call this early; textures made before it just
// get the conservative default.
export function setMaterialRenderer(renderer) {
  // the battle renderer: every OTHER renderer (hangar stage, vehicle cards,
  // X-ray) draws the zone materials in the clean garage environment below
  battleRenderer = renderer || null;
  try {
    maxAnisotropy = renderer?.capabilities?.getMaxAnisotropy?.() || 4;
  } catch {
    maxAnisotropy = 4;
  }
}

// ---------------------------------------------------------------------------
// colour: sRGB bytes in, linear out — never through THREE.Color for a canvas
// ---------------------------------------------------------------------------

// Decode a packed hex into sRGB-ENCODED 0..1 components.
//
// Deliberately NOT THREE.Color: with colour management on (the default since
// r152) that class converts hex into the LINEAR working space, and these values
// are painted into a canvas that is uploaded as an sRGB texture. Going through
// THREE.Color therefore applies the sRGB->linear transfer TWICE. Measured, that
// was landing the albedo at a quarter to a third of the intended luminance —
// the T-34 at 21 and the SU-100 at 18 against spec values of 85 and 78 — which
// is why every vehicle in the game looked black.
export function srgbBytes(hex) {
  return {
    r: ((hex >> 16) & 255) / 255,
    g: ((hex >> 8) & 255) / 255,
    b: (hex & 255) / 255,
  };
}

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c) {
  const v = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

// Linear-light [r, g, b] of a packed sRGB hex.
export function hexToLinear(hex) {
  const s = srgbBytes(hex);
  return [srgbToLinear(s.r), srgbToLinear(s.g), srgbToLinear(s.b)];
}

// Relative luminance Y (linear, Rec. 709) of a packed sRGB hex: the number the
// art bible's paint bands are written in.
export function hexLuminance(hex) {
  const [r, g, b] = hexToLinear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// HSV hue (degrees) and saturation of a packed sRGB hex, as the bible's bands
// state them.
export function hexHueSat(hex) {
  const { r, g, b } = srgbBytes(hex);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-9) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { hue: h, sat: mx > 0 ? d / mx : 0 };
}

// ---------------------------------------------------------------------------
// nation paints (art bible 4.2; naming per 8.2)
// ---------------------------------------------------------------------------
//
// Exact sRGB values for WWII paints do not exist; each hex is the bible's
// default inside a documented BAND, and the band is the gate. Same nation and
// year, same paint (C-11): vehicles are told apart by shape, never by colour.

export const PAINT_US_OD = 0x575639;               // US Olive Drab No. 9 family
export const PAINT_UK_SCC15 = 0x4f5338;            // British SCC 15 (Apr 1944+)
export const PAINT_SU_4BO = 0x565b40;              // Soviet 4BO protective green
export const PAINT_DE_DUNKELGELB_1943 = 0x867d5a;  // Dunkelgelb nach Muster (1943)
export const PAINT_DE_DUNKELGELB = 0xa8955f;       // Dunkelgelb RAL 7028 (late 1943-45)
export const PAINT_DE_OLIVGRUN = 0x4b573e;         // Olivgruen RAL 6003 (camo)
export const PAINT_DE_ROTBRAUN = 0x4a352d;         // Rotbraun RAL 8017 (camo)
export const PAINT_WHITEWASH = 0xc9cbc6;           // winter whitewash, washable
// German red-oxide primer showing through light chips (bible 5.3 Z4)
export const PAINT_DE_PRIMER = 0x6b3a2a;

// The bands the hexes must sit in: linear Y, HSV hue (deg) and saturation,
// and the lustre's roughness range. Bible table 4.2, tank rows.
export const PAINT_BANDS = {
  [PAINT_US_OD]: { name: 'US Olive Drab', y: [0.065, 0.100], hue: [50, 68], sat: [0.28, 0.42], rough: [0.70, 0.85] },
  [PAINT_UK_SCC15]: { name: 'UK SCC 15', y: [0.065, 0.095], hue: [62, 78], sat: [0.25, 0.40], rough: [0.70, 0.85] },
  [PAINT_SU_4BO]: { name: 'Soviet 4BO', y: [0.075, 0.110], hue: [62, 80], sat: [0.22, 0.36], rough: [0.70, 0.85] },
  [PAINT_DE_DUNKELGELB_1943]: { name: 'Dunkelgelb nach Muster', y: [0.16, 0.25], hue: [45, 65], sat: [0.26, 0.40], rough: [0.65, 0.80] },
  [PAINT_DE_DUNKELGELB]: { name: 'Dunkelgelb RAL 7028', y: [0.24, 0.36], hue: [40, 52], sat: [0.30, 0.46], rough: [0.65, 0.80] },
  [PAINT_DE_OLIVGRUN]: { name: 'Olivgruen RAL 6003', y: [0.07, 0.10], hue: [80, 95], sat: [0.22, 0.35], rough: [0.65, 0.80] },
  [PAINT_DE_ROTBRAUN]: { name: 'Rotbraun RAL 8017', y: [0.03, 0.055], hue: [10, 25], sat: [0.30, 0.45], rough: [0.65, 0.80] },
  [PAINT_WHITEWASH]: { name: 'Winter whitewash', y: [0.50, 0.70], hue: [0, 360], sat: [0, 0.06], rough: [0.85, 0.95] },
};

// Does `hex` sit inside the band of the paint `paintHex` (default: its own)?
export function inPaintBand(hex, paintHex = hex) {
  const band = PAINT_BANDS[paintHex];
  if (!band || hex == null) return false;
  const y = hexLuminance(hex);
  const { hue, sat } = hexHueSat(hex);
  return y >= band.y[0] && y <= band.y[1]
    && hue >= band.hue[0] && hue <= band.hue[1]
    && sat >= band.sat[0] && sat <= band.sat[1];
}

// The German three-tone (C-16): Olivgruen and Rotbraun spray bands over the
// Dunkelgelb base, together 30-50 % of the area. One seeded scheme per paint,
// cached (bible 8.7). Allied and Soviet tanks are monotone (C-15).
export const SCHEME_DE_THREE_TONE = Object.freeze([
  Object.freeze({ hex: PAINT_DE_OLIVGRUN, coverage: 0.22 }),
  Object.freeze({ hex: PAINT_DE_ROTBRAUN, coverage: 0.17 }),
]);

// ---------------------------------------------------------------------------
// deterministic noise
// ---------------------------------------------------------------------------
//
// Math.random() would give every player a different tank and every reload a
// different one again. These are seeded so a given vehicle always looks like
// itself, which matters because players learn to recognise silhouettes.

function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 1274126177;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function smoothstep(x, a, b) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Value noise on a lattice that wraps at (px, py). Cheap, and at these
// texture sizes indistinguishable from gradient noise once stacked into fbm.
function valueNoiseP(x, y, seed, px, py) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smooth(xf);
  const v = smooth(yf);
  const x0 = ((xi % px) + px) % px;
  const y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// Fractal brownian motion that tiles: x wraps at `px`, y at `py` (integers,
// in lattice units at the base frequency). Without the wrap every surface
// shows a visible seam where the triplanar projection repeats.
function fbm2(x, y, seed, octaves, px, py) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoiseP(x * freq, y * freq, seed + o * 97, px * freq, py * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// The original square-period form, kept for the painters that tile on one.
function fbm(x, y, seed, octaves = 4, period = 8) {
  return fbm2(x, y, seed, octaves, period, period);
}

// ---------------------------------------------------------------------------
// canvas helpers
// ---------------------------------------------------------------------------

function makeCanvas(size) {
  // OffscreenCanvas keeps these off the DOM, but Safari only grew support
  // recently and a missing 2d context here would take the whole game down.
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const c = new OffscreenCanvas(size, size);
      if (c.getContext('2d')) return c;
    } catch { /* fall through to a DOM canvas */ }
  }
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

function texFromCanvas(canvas, { srgb = false, repeat = 1 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = maxAnisotropy;
  // Albedo is authored in sRGB; normal and roughness are raw data and must not
  // be decoded, or the lighting comes out subtly wrong everywhere.
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// Sobel a height field into a tangent-space normal map. Height comes in as the
// red channel of `data`; strength scales the slope, so 1 is subtle panel relief
// and 4 is heavy casting texture.
function heightToNormal(heightData, size, strength) {
  const out = new Uint8ClampedArray(size * size * 4);
  const at = (x, y) => {
    const xi = ((x % size) + size) % size;
    const yi = ((y % size) + size) % size;
    return heightData[(yi * size + xi) * 4] / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, size, size, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAnisotropy;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function ctxOf(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

// linear 0..1 -> sRGB byte, through a 4096-step table (a pow per channel per
// texel was the slowest line in the painters)
const LIN2SRGB = (() => {
  const t = new Uint8ClampedArray(4097);
  for (let i = 0; i <= 4096; i++) t[i] = Math.round(linearToSrgb(i / 4096) * 255);
  return t;
})();
function linByte(v) {
  const i = v <= 0 ? 0 : v >= 1 ? 4096 : (v * 4096 + 0.5) | 0;
  return LIN2SRGB[i];
}

// Rank-normalise a 0..1 field in place to a uniform distribution, so a
// threshold t keeps (1 - t) of the area whatever the noise did. A 4096-bin
// cumulative histogram, interpolated inside each bin: a comparator sort of a
// quarter-million indices was the slowest step of the whole painter.
function rankUniform(field) {
  const n = field.length;
  const BINS = 4096;
  const hist = new Float64Array(BINS + 1);
  for (let i = 0; i < n; i++) {
    const v = field[i] <= 0 ? 0 : field[i] >= 1 ? 1 : field[i];
    hist[Math.min(BINS - 1, (v * BINS) | 0)]++;
  }
  const cdf = new Float64Array(BINS + 1);
  for (let b = 0; b < BINS; b++) cdf[b + 1] = cdf[b] + hist[b] / n;
  for (let i = 0; i < n; i++) {
    const v = field[i] <= 0 ? 0 : field[i] >= 1 ? 1 : field[i];
    const f = v * BINS;
    const b = Math.min(BINS - 1, f | 0);
    field[i] = cdf[b] + (cdf[b + 1] - cdf[b]) * (f - b);
  }
  return field;
}

const SRGB2LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
  return t;
})();

function quantile(arr, q) {
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

// ---------------------------------------------------------------------------
// surface painters
// ---------------------------------------------------------------------------
//
// Each painter fills its canvases at once — albedo, height (which becomes the
// normal map) and a data map — because they are correlated: a weld bead is
// darker, raised and rougher all at the same time, and generating them from one
// pass is what makes them line up.

// Camouflage (V-02, bible C-16): a MASK texture of its own, projected at a
// 4 m tile rather than the paint's 1.6 m, so a 6 m hull side does not show the
// same blotch four times over. R = weight of the first extra paint, G = the
// second. One domain-warped fbm field per extra colour, thresholded at the
// quantile that gives that colour its coverage, the thresholds then nudged
// until the RESOLVED coverage (after the two overlap) matches. The warp makes
// the bands snake like a spray gun's passes; features 0.3-0.8 m wide.
export const CAMO_TILE = 4.0;
const CAMO_PERIOD = 6;        // lattice cells across the tile: ~0.67 m features
const CAMO_EDGE = 0.022;      // soft-edge half width, field units: ~9-10 cm spray fringe
function paintCamoMask(size, seed, scheme) {
  const n = size * size;
  const k = Math.min(2, scheme.length);
  const P = CAMO_PERIOD;
  const wx = new Float32Array(n);
  const wy = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (x / size) * P;
      const t = (y / size) * P;
      const i = y * size + x;
      wx[i] = fbm(s + 5.2, t + 1.3, seed + 501, 3, P) - 0.5;
      wy[i] = fbm(s + 2.9, t + 7.1, seed + 517, 3, P) - 0.5;
    }
  }
  const fields = [];
  for (let c = 0; c < k; c++) {
    const f = new Float32Array(n);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const s = (x / size) * P + 1.6 * wx[i];
        const t = (y / size) * P + 1.6 * wy[i];
        f[i] = fbm(s, t, seed + 211 + c * 131, 3, P);
      }
    }
    fields.push(f);
  }
  const thr = scheme.slice(0, k).map((s, c) => quantile(fields[c], 1 - s.coverage));
  const step = Math.max(1, size >> 7);
  const resolved = () => {
    const cov = new Float64Array(k);
    let m = 0;
    for (let y = 0; y < size; y += step) {
      for (let x = 0; x < size; x += step) {
        const i = y * size + x;
        let best = -1;
        let bm = 0;
        for (let c = 0; c < k; c++) {
          const mg = fields[c][i] - thr[c];
          if (mg > bm) { bm = mg; best = c; }
        }
        if (best >= 0) cov[best]++;
        m++;
      }
    }
    return Array.from(cov, (v) => v / m);
  };
  for (let it = 0; it < 8; it++) {
    const cov = resolved();
    for (let c = 0; c < k; c++) thr[c] -= (scheme[c].coverage - cov[c]) * 0.35;
  }
  // soft weights: the camo as a whole fades in over its own edge, and where
  // two colours meet they blend over the same width (a sprayed overlap)
  const E = CAMO_EDGE;
  const w1 = new Float32Array(n);
  const w2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m1 = fields[0][i] - thr[0];
    const m2 = k > 1 ? fields[1][i] - thr[1] : -Infinity;
    const a = smoothstep(Math.max(m1, m2), -E, E);
    const b = k > 1 ? smoothstep(m1 - m2, -E, E) : 1;
    w1[i] = a * b;
    w2[i] = a * (1 - b);
  }
  // measurements: coverage by nearest paint (the largest of base, w1, w2),
  // the fringe (no paint above 98 %) and the fringe's mean width in metres
  const cls = new Uint8Array(n);
  const cov = [0, 0, 0];
  let fringe = 0;
  for (let i = 0; i < n; i++) {
    const w0 = 1 - w1[i] - w2[i];
    const c = w1[i] > w0 && w1[i] >= w2[i] ? 1 : w2[i] > w0 ? 2 : 0;
    cls[i] = c;
    cov[c]++;
    if (Math.max(w0, w1[i], w2[i]) < 0.98) fringe++;
  }
  let boundary = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (cls[i] !== cls[y * size + ((x + 1) % size)]) boundary++;
      if (cls[i] !== cls[((y + 1) % size) * size + x]) boundary++;
    }
  }
  const metresPerPx = CAMO_TILE / size;
  const edgeLenPx = boundary * (Math.PI / 4);
  const canvas = makeCanvas(size);
  const ctx = ctxOf(canvas);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < n; i++) {
    img.data[i * 4] = w1[i] * 255;
    img.data[i * 4 + 1] = w2[i] * 255;
    img.data[i * 4 + 2] = 0;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = texFromCanvas(canvas);
  tex.userData.camo = {
    tile: CAMO_TILE,
    coverage: cov.map((c) => c / n),
    camoCoverage: (cov[1] + cov[2]) / n,
    fringe: fringe / n,
    edgeWidthM: edgeLenPx > 0 ? (fringe / edgeLenPx) * metresPerPx : 0,
    thresholds: thr,
  };
  return tex;
}

// Painted armour (and painted fittings). `scheme` is an array of extra paints
// [{hex, coverage}] over the base; a bare number is the legacy two-tone blob
// (vehicles/groundUnits.js trucks). `bakeWear` puts the old baked grime and
// chips back in for materials that do NOT run the zone shader.
//
// Data map (roughnessMap) channels:
//   R = rain-streak mask (Z3 source, ~5 % of the area in clusters, vertical)
//   G = roughness (what three reads)
//   B = procedural chip field, rank-uniform 0..1 (Z4 fallback while the CC0
//       wear mask is still loading or absent)
function paintArmour(size, baseColor, seed, opts) {
  const {
    wear = 0.5, camo = null, scheme = null, rivets = true, bakeWear = true,
    roughBase = 0.76, normalStrength = 2.2,
  } = opts;
  const alb = makeCanvas(size);
  const hgt = makeCanvas(size);
  const rgh = makeCanvas(size);
  const ac = ctxOf(alb);
  const hc = ctxOf(hgt);
  const rc = ctxOf(rgh);
  const n = size * size;

  // paints in linear light: classes 0 = base, 1.. = scheme colours
  const paints = [baseColor];
  let weights = null;
  // a scheme's extra paints live in their own mask (paintCamoMask); the
  // albedo carries the base paint and its shading only
  const camoMap = Array.isArray(scheme) && scheme.length
    ? paintCamoMask(TEX_SIZE[quality] >> 1, seed + 7, scheme)
    : null;
  if (typeof camo === 'number') {
    // legacy blob two-tone, kept for the ground-unit trucks
    paints.push(camo);
    const w = new Float32Array(n);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x / size) * 8;
        const v = (y / size) * 8;
        const blob = fbm(u * 0.85 + 11, v * 0.85 + 5, seed + 211, 3, 8);
        w[y * size + x] = smoothstep(blob, 0.44, 0.60);
      }
    }
    weights = [w];
  }
  const lin = paints.map(hexToLinear);

  // shade fields first, so their mean can be normalised to exactly 1 and the
  // texture's mean lands on the calibrated hex (C-03)
  const shade = new Float32Array(n);
  const grainF = new Float32Array(n);
  const mottleF = new Float32Array(n);
  let shadeSum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 8;
      const v = (y / size) * 8;
      const i = y * size + x;
      // Broad mottling: paint that has faded unevenly in the sun.
      const mottle = fbm(u * 0.5, v * 0.5, seed, 4, 4);
      // Fine tooth: the grain of primer under a brush coat.
      const grain = fbm(u * 6, v * 6, seed + 31, 3, 48);
      mottleF[i] = mottle;
      grainF[i] = grain;
      const s = 1 + (mottle - 0.5) * 0.30 + (grain - 0.5) * 0.10;
      shade[i] = s;
      shadeSum += s;
    }
  }
  const shadeNorm = n / shadeSum;

  // Rain streaks: long in v (which is DOWN on a vertical face under every
  // projection the triplanar shader uses), narrow in u. 5-40 cm long at the
  // 1.6 m tile. The old field was long in u — streaks ran sideways.
  // Clustered by a low-frequency mask, so they gather under fittings and
  // seams in patches instead of pinstriping every plate evenly (seen in the
  // browser at 9 % unclustered coverage).
  const streakF = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 8;
      const v = (y / size) * 8;
      const cluster = smoothstep(fbm(u * 0.5 + 3.3, v * 0.5 + 9.1, seed + 83, 3, 4), 0.48, 0.66);
      streakF[y * size + x] = fbm2(u * 5, v * 0.75, seed + 71, 3, 40, 6) * cluster;
    }
  }
  const streakT = quantile(streakF, 0.95);
  // chips: high-frequency field, rank-uniform for an exact coverage threshold
  const chipF = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 8;
      const v = (y / size) * 8;
      chipF[y * size + x] = fbm(u * 9 + 3, v * 9 + 7, seed + 401, 2, 72);
    }
  }
  rankUniform(chipF);

  const albImg = ac.createImageData(size, size);
  const hgtImg = hc.createImageData(size, size);
  const rghImg = rc.createImageData(size, size);
  const k = paints.length - 1;
  for (let i = 0; i < n; i++) {
    const s = shade[i] * shadeNorm;
    let r = lin[0][0];
    let g = lin[0][1];
    let b = lin[0][2];
    for (let c = 0; c < k; c++) {
      const w = weights[c][i];
      if (w <= 0) continue;
      const p = lin[c + 1];
      r += (p[0] - r) * w;
      g += (p[1] - g) * w;
      b += (p[2] - b) * w;
    }
    r *= s;
    g *= s;
    b *= s;
    const streak = smoothstep(streakF[i], streakT, streakT + 0.07);
    let rough = roughBase + (grainF[i] - 0.5) * 0.10 + (mottleF[i] - 0.5) * 0.06;
    let h = 0.5 + (grainF[i] - 0.5) * 0.22 + (mottleF[i] - 0.5) * 0.12;
    if (bakeWear) {
      // the old baked weathering, for materials without the zone shader:
      // grime down the streaks and chips scattered over the plate
      const grime = streak * wear * 0.55;
      r *= 1 - grime;
      g *= 1 - grime;
      b *= 1 - grime * 1.1;
      rough += grime * 0.2;
      const chip = chipF[i];
      if (chip > 0.965 - wear * 0.03) {
        r = 0.045;
        g = 0.040;
        b = 0.036;
        rough = 0.42;
        h -= 0.25;
      }
    }
    const o = i * 4;
    albImg.data[o] = linByte(r);
    albImg.data[o + 1] = linByte(g);
    albImg.data[o + 2] = linByte(b);
    albImg.data[o + 3] = 255;

    const hv = Math.max(0, Math.min(1, h)) * 255;
    hgtImg.data[o] = hv;
    hgtImg.data[o + 1] = hv;
    hgtImg.data[o + 2] = hv;
    hgtImg.data[o + 3] = 255;

    rghImg.data[o] = streak * 255;
    rghImg.data[o + 1] = Math.max(0.25, Math.min(1, rough)) * 255;
    rghImg.data[o + 2] = chipF[i] * 255;
    rghImg.data[o + 3] = 255;
  }

  // what the painter measured, for the band checks (node can read this even
  // where the canvas is a stub): per-class linear mean and coverage
  const stats = paintStatsOf(albImg.data, weights, n, paints);

  ac.putImageData(albImg, 0, 0);
  hc.putImageData(hgtImg, 0, 0);
  rc.putImageData(rghImg, 0, 0);

  // Rivet lines, drawn on top rather than noised in, because a rivet is a
  // deliberate object with a position and noise cannot make one.
  if (rivets) {
    const step = size / 8;
    ac.save();
    hc.save();
    for (let gx = 0; gx < 8; gx++) {
      for (let gy = 0; gy < 8; gy++) {
        if (hash2(gx, gy, seed + 900) > 0.38) continue;
        const cx = (gx + 0.5) * step;
        const cy = (gy + 0.5) * step;
        const rr = Math.max(1, size / 190);
        ac.fillStyle = 'rgba(0,0,0,0.20)';
        ac.beginPath();
        ac.arc(cx, cy, rr * 1.5, 0, Math.PI * 2);
        ac.fill();
        hc.fillStyle = 'rgba(255,255,255,0.85)';
        hc.beginPath();
        hc.arc(cx, cy, rr, 0, Math.PI * 2);
        hc.fill();
      }
    }
    ac.restore();
    hc.restore();
  }

  const hData = hc.getImageData(0, 0, size, size).data;
  const map = texFromCanvas(alb, { srgb: true });
  map.userData.paint = stats;
  return {
    map,
    normalMap: heightToNormal(hData, size, normalStrength),
    roughnessMap: texFromCanvas(rgh),
    ...(camoMap ? { camoMap } : {}),
  };
}

// Per-class statistics of a painted albedo: each texel goes to the class with
// the largest weight (base when no extra colour exceeds 0.5), the bible C-16
// "nearest of three" rule in weight space.
function paintStatsOf(data, weights, n, paints) {
  const k = paints.length;
  const sum = Array.from({ length: k }, () => [0, 0, 0]);
  const core = Array.from({ length: k }, () => [0, 0, 0]);
  const cnt = new Float64Array(k);
  const coreN = new Float64Array(k);
  let yAll = 0;
  let fringe = 0;
  for (let i = 0; i < n; i++) {
    let cls = 0;
    let wb = 0.5;
    let wsum = 0;
    if (weights) {
      for (let c = 0; c < weights.length; c++) {
        const w = weights[c][i];
        wsum += w;
        if (w > wb) { wb = w; cls = c + 1; }
      }
    }
    const o = i * 4;
    const r = SRGB2LIN[data[o]];
    const g = SRGB2LIN[data[o + 1]];
    const b = SRGB2LIN[data[o + 2]];
    sum[cls][0] += r;
    sum[cls][1] += g;
    sum[cls][2] += b;
    cnt[cls]++;
    // core texels: fully one paint (no spray fringe), for the band check
    const pure = cls === 0 ? wsum < 0.02 : wb > 0.98;
    if (pure) {
      core[cls][0] += r;
      core[cls][1] += g;
      core[cls][2] += b;
      coreN[cls]++;
    } else {
      fringe++;
    }
    yAll += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const lum = (m) => 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  return {
    meanY: yAll / n,
    fringe: fringe / n,
    classes: paints.map((hex, c) => ({
      hex,
      // nearest-paint classification (C-16 coverage)
      coverage: cnt[c] / n,
      meanY: cnt[c] ? lum(sum[c]) / cnt[c] : 0,
      // the paint itself, away from the spray fringe (C-10 band)
      coreY: coreN[c] ? lum(core[c]) / coreN[c] : 0,
      targetY: hexLuminance(hex),
    })),
  };
}

// Track links (bible 5.2 / V-11). Dirty steel #4a4339 in the recesses and on
// most of every link, polished bare steel on the raised faces the ground and
// the wheels wear clean, rust-brown pins at the joints.
// Data map (used as metalnessMap): G = roughness, B = metalness.
const TRACK_DIRT = 0x4a4339;
const TRACK_PIN = 0x6b4a32;
// iron F0 (.530 .513 .494, PB DB) is the albedo of a bare-metal texel
const TRACK_STEEL_LIN = [0.530, 0.513, 0.494];
function paintTrack(size, seed) {
  const alb = makeCanvas(size);
  const hgt = makeCanvas(size);
  const mrc = makeCanvas(size);
  const ac = ctxOf(alb);
  const hc = ctxOf(hgt);
  const mc = ctxOf(mrc);
  const albImg = ac.createImageData(size, size);
  const hgtImg = hc.createImageData(size, size);
  const mrImg = mc.createImageData(size, size);
  const dirt = hexToLinear(TRACK_DIRT);
  const pin = hexToLinear(TRACK_PIN);
  let dirtY = 0;
  let dirtN = 0;
  let polN = 0;
  let polRough = 0;

  // grit and caked-mud fields first: their periods equal their spans, so the
  // tile wraps without a seam (the old field ran 10 lattice units over a
  // period of 80 and broke at every repeat)
  const n = size * size;
  const gritF = new Float32Array(n);
  const cakedF = new Float32Array(n);
  let gritSum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const i = y * size + x;
      gritF[i] = fbm(u * 10, v * 10, seed, 3, 10);
      cakedF[i] = fbm(u * 4 + 1.7, v * 4 + 3.1, seed + 77, 3, 4);
      gritSum += gritF[i];
    }
  }
  const gritMean = gritSum / n;
  // about half of each grouser crown is worn bright; the rest is caked over.
  // Seen in the browser, a wider polished band read as chrome plating.
  const cakeT = quantile(cakedF, 0.5);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Track links: a hard repeating band across the width, which is the one
      // thing that makes a track read as a track rather than a black strip.
      const cell = (v * 4) % 1;
      const link = Math.abs(cell - 0.5) * 2;
      // the grouser crown: the middle of each link, the face that meets the ground
      const crown = 1 - smoothstep(link, 0.20, 0.32);
      const plateau = 1 - smoothstep(link, 0.42, 0.58);
      const grit = gritF[y * size + x];
      const caked = cakedF[y * size + x];
      // polished where the raised face is not caked over
      const polish = crown * smoothstep(caked, cakeT + 0.04, cakeT - 0.04);
      const shade = 1 + (grit - gritMean) * 0.36;
      let r = dirt[0] * shade;
      let g = dirt[1] * shade;
      let b = dirt[2] * shade;
      // the pin bosses at each joint, five across the width
      const jd = Math.min(cell, 1 - cell) * 4;
      const across = Math.abs(((u * 5) % 1) - 0.5) * 2;
      const isPin = jd < 0.16 && across < 0.45 ? 1 : 0;
      if (isPin) { r = pin[0]; g = pin[1]; b = pin[2]; }
      const pol = isPin ? 0 : polish;
      r += (TRACK_STEEL_LIN[0] * (0.9 + grit * 0.2) - r) * pol;
      g += (TRACK_STEEL_LIN[1] * (0.9 + grit * 0.2) - g) * pol;
      b += (TRACK_STEEL_LIN[2] * (0.9 + grit * 0.2) - b) * pol;
      const rough = 0.90 + (grit - 0.5) * 0.08 + (0.30 - 0.90) * pol;
      const i = (y * size + x) * 4;
      albImg.data[i] = linByte(r);
      albImg.data[i + 1] = linByte(g);
      albImg.data[i + 2] = linByte(b);
      albImg.data[i + 3] = 255;
      const h = (plateau * 0.75 + grit * 0.25 + isPin * 0.2) * 255;
      hgtImg.data[i] = h;
      hgtImg.data[i + 1] = h;
      hgtImg.data[i + 2] = h;
      hgtImg.data[i + 3] = 255;
      mrImg.data[i] = 0;
      mrImg.data[i + 1] = Math.max(0, Math.min(1, rough)) * 255;
      mrImg.data[i + 2] = pol > 0.5 ? 255 : pol * 255;
      mrImg.data[i + 3] = 255;
      if (pol < 0.05 && !isPin) {
        dirtY += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        dirtN++;
      }
      if (pol > 0.95) { polN++; polRough += rough; }
    }
  }
  ac.putImageData(albImg, 0, 0);
  hc.putImageData(hgtImg, 0, 0);
  mc.putImageData(mrImg, 0, 0);
  const map = texFromCanvas(alb, { srgb: true });
  map.userData.paint = {
    dirtY: dirtN ? dirtY / dirtN : 0,
    polishedFraction: polN / (size * size),
    polishedRough: polN ? polRough / polN : 0,
  };
  return {
    map,
    normalMap: heightToNormal(hc.getImageData(0, 0, size, size).data, size, 3.0),
    metalnessMap: texFromCanvas(mrc),
  };
}

function paintAlloy(size, baseColor, seed, opts) {
  const { wear = 0.35 } = opts;
  const alb = makeCanvas(size);
  const hgt = makeCanvas(size);
  const rgh = makeCanvas(size);
  const ac = ctxOf(alb);
  const hc = ctxOf(hgt);
  const rc = ctxOf(rgh);
  const base = srgbBytes(baseColor);
  const albImg = ac.createImageData(size, size);
  const hgtImg = hc.createImageData(size, size);
  const rghImg = rc.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 8;
      const v = (y / size) * 8;
      const mottle = fbm(u * 0.6, v * 0.6, seed, 3, 5);
      const grain = fbm(u * 8, v * 8, seed + 17, 2, 64);
      // Exhaust staining streaks back from the cowl on every warbird.
      const soot = Math.max(0, fbm(u * 22, v * 1.1, seed + 55, 3, 24) - 0.58);

      let shade = 0.90 + mottle * 0.18 + (grain - 0.5) * 0.05;
      shade -= soot * wear * 1.2;

      const i = (y * size + x) * 4;
      albImg.data[i] = base.r * shade * 255;
      albImg.data[i + 1] = base.g * shade * 255;
      albImg.data[i + 2] = base.b * shade * 255;
      albImg.data[i + 3] = 255;

      // Aircraft skin is stressed sheet: gentle oil-canning between the ribs,
      // not the heavy casting texture of armour.
      const h = 0.5 + (mottle - 0.5) * 0.5 + (grain - 0.5) * 0.18;
      const hv = THREE.MathUtils.clamp(h, 0, 1) * 255;
      hgtImg.data[i] = hv;
      hgtImg.data[i + 1] = hv;
      hgtImg.data[i + 2] = hv;
      hgtImg.data[i + 3] = 255;

      // Painted metal is far smoother than armour plate, so it catches the sun.
      const rv = THREE.MathUtils.clamp(0.38 + soot * 0.3 + (grain - 0.5) * 0.1, 0.2, 0.9) * 255;
      rghImg.data[i] = rv;
      rghImg.data[i + 1] = rv;
      rghImg.data[i + 2] = rv;
      rghImg.data[i + 3] = 255;
    }
  }
  ac.putImageData(albImg, 0, 0);
  hc.putImageData(hgtImg, 0, 0);
  rc.putImageData(rghImg, 0, 0);

  // Panel lines. A recessed line every eighth of the projection, jittered so
  // the aircraft does not look like graph paper.
  const step = size / 4;
  hc.strokeStyle = 'rgba(0,0,0,0.9)';
  ac.strokeStyle = 'rgba(0,0,0,0.22)';
  hc.lineWidth = Math.max(1, size / 256);
  ac.lineWidth = hc.lineWidth;
  for (let k = 1; k < 4; k++) {
    const jitter = (hash2(k, 3, seed) - 0.5) * step * 0.3;
    const p = k * step + jitter;
    for (const c of [ac, hc]) {
      c.beginPath();
      c.moveTo(p, 0);
      c.lineTo(p, size);
      c.stroke();
      c.beginPath();
      c.moveTo(0, p);
      c.lineTo(size, p);
      c.stroke();
    }
  }

  return {
    map: texFromCanvas(alb, { srgb: true }),
    normalMap: heightToNormal(hc.getImageData(0, 0, size, size).data, size, 1.5),
    roughnessMap: texFromCanvas(rgh),
  };
}

// ---------------------------------------------------------------------------
// vehicle environment: the R1-Z zone uniforms
// ---------------------------------------------------------------------------
//
// One set of uniform OBJECTS shared by every zone material, so a battle sets
// its biome once and every tank on the map follows without a recompile.
//
// Contract (realism backlog 4.2, R1-Z):
//   setVehicleEnvironment({ dust, mud, snow, wet, whitewash? })
//     dust, mud  packed sRGB hex of the running-gear dust and the wet mud
//     snow, wet  0..1 — snow lying on decks / slush in the running gear, and
//                how wet everything is (darker, glossier, mud instead of dust)
//     whitewash  0..1, optional — field-applied winter whitewash (C-15);
//                defaults to 1 on a snow biome, 0 elsewhere
//   Call it once per battle, AFTER setActivePreset(). Until a battle calls it,
//   or once the active preset changes after the call, these values are read
//   from activePreset() (world/presets.js) automatically.

const ZONE_MUD_HEX = 0x4a3f30;   // bible 5.3 Z1 wet mud, Y .05-.08
const ZONE_U = {
  uZDust: { value: new THREE.Color(0.25, 0.2, 0.12) },
  uZMud: { value: new THREE.Color(0.06, 0.05, 0.03) },
  uZSnow: { value: 0 },
  uZWet: { value: 0 },
  uZWash: { value: 0 },
  uZWearOn: { value: 0 },
};
let envExplicit = null;   // { preset, env } from setVehicleEnvironment
let envFrom = undefined;  // the preset the uniforms were last derived from
let envNow = null;        // the values in force, for vehicleEnvironment()

function setLinearHex(color, hex) {
  const [r, g, b] = hexToLinear(hex);
  color.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function applyEnv(env) {
  const dust = Number.isFinite(env.dust) ? env.dust : 0x8a7050;
  const mud = Number.isFinite(env.mud) ? env.mud : ZONE_MUD_HEX;
  setLinearHex(ZONE_U.uZDust.value, dust);
  setLinearHex(ZONE_U.uZMud.value, mud);
  ZONE_U.uZSnow.value = clamp01(+env.snow || 0);
  ZONE_U.uZWet.value = clamp01(+env.wet || 0);
  ZONE_U.uZWash.value = clamp01(+env.whitewash || 0);
  envNow = {
    dust, mud,
    snow: ZONE_U.uZSnow.value,
    wet: ZONE_U.uZWet.value,
    whitewash: ZONE_U.uZWash.value,
  };
}

// What a preset implies for the vehicles fighting on it.
export function vehicleEnvironmentFromPreset(p) {
  if (!p) return { dust: 0x8a7050, mud: ZONE_MUD_HEX, snow: 0, wet: 0, whitewash: 0 };
  const ground = p.groundType || 'grass';
  const dustTable = p.dust || {};
  const snowGround = ground === 'snow';
  const dust = dustTable[ground] ?? dustTable.dirt ?? 0x8a7050;
  const precip = p.precip || 'none';
  let wet = precip === 'rain' ? 0.85 : 0;
  if (p.weatherKey === 'overcast') wet = Math.max(wet, 0.12);
  return {
    dust,
    mud: ZONE_MUD_HEX,
    snow: Math.max(p.snowCover || 0, snowGround ? 0.7 : 0),
    // dry steppe and desert have no mud; winter running gear is slush
    wet: snowGround ? Math.max(wet, 0.2) : wet,
    whitewash: snowGround ? 1 : 0,
  };
}

export function setVehicleEnvironment(env = {}) {
  let preset = null;
  try { preset = activePreset(); } catch { preset = null; }
  const base = vehicleEnvironmentFromPreset(preset);
  const merged = { ...base };
  for (const k of ['dust', 'mud', 'snow', 'wet', 'whitewash']) {
    if (env[k] !== undefined && env[k] !== null) merged[k] = env[k];
  }
  envExplicit = { preset, env: merged };
  envMode = 'battle';
  applyEnv(merged);
  return { ...envNow };
}

// What the hangar, the vehicle cards and the X-ray views show: a vehicle
// with ordinary meadow dust on its running gear and nothing else. Without
// this the garage would wear whatever the LAST battle was fought in — a
// whitewashed Tiger in a green hangar after a winter map.
const GARAGE_ENV = Object.freeze({ dust: 0x8a7050, mud: ZONE_MUD_HEX, snow: 0, wet: 0, whitewash: 0 });
let envMode = 'battle';

// Re-derive the uniforms from the active preset unless a battle set them
// explicitly for that same preset. Runs from every zone material's
// onBeforeRender, so it is an identity check almost every time. Renderers
// other than the battle's get the garage environment; three uploads a
// material's uniforms at its first draw in each render() call, after this
// hook, so two renderers sharing the materials each see their own values.
function syncVehicleEnv(renderer) {
  if (battleRenderer && renderer && renderer.isWebGLRenderer && renderer !== battleRenderer) {
    if (envMode !== 'garage') {
      envMode = 'garage';
      applyEnv(GARAGE_ENV);
    }
    return;
  }
  if (envMode === 'garage') {
    envMode = 'battle';
    envFrom = undefined;
    if (envExplicit) applyEnv(envExplicit.env);
  }
  let p = null;
  try { p = activePreset(); } catch { p = null; }
  if (envExplicit) {
    if (envExplicit.preset === p) return;
    envExplicit = null;
  }
  if (envFrom === p) return;
  envFrom = p;
  applyEnv(vehicleEnvironmentFromPreset(p));
}

// The values currently in force (after syncing), for tests and debug panels.
export function vehicleEnvironment() {
  syncVehicleEnv();
  return { ...envNow };
}

// ---------------------------------------------------------------------------
// CC0 detail and wear (core/assets.js vehicle sets)
// ---------------------------------------------------------------------------
//
// The photo sets are mean-neutral: 0.5 means "no change", so the calibrated
// paint stays the colour and the photo only modulates luminance, roughness and
// the normal. Placeholders are bound from the start (neutral, or zero for the
// wear mask), so nothing recompiles when the files arrive.

const DETAIL = {
  // k = [normal strength, roughness variation, luminance variation]. Seen up
  // close in the browser, normal 0.55 on paint read as stucco: a painted plate
  // is smooth at arm's length, so the photo relief is a whisper.
  paint: { set: 'green_metal_rust', mode: 'vehicle', tile: 0.9, k: [0.18, 0.60, 0.16] },
  cast: { set: 'Metal052C', mode: 'vehicle', tile: 0.45, k: [0.32, 0.50, 0.12] },
  rubber: { set: 'Rubber004', mode: 'vehicle', tile: 0.6, k: [0.45, 0.60, 0.15] },
  track: { set: 'green_metal_rust', mode: 'vehicle', tile: 0.7, k: [0.30, 0.50, 0.20] },
  rust: { set: 'rust_coarse_01', mode: 'surface', tile: 0.9, k: [0.45, 0.0, 0.45] },
};

// chip coverage thresholds of the wear mask's R channel, as measured by the
// asset build: {4 %: .7725, 8 %: .7098, 12 %: .6667}, under the manifest key
// `chipThreshold`. Read lazily: assets.js imports this module, so at OUR
// evaluation time its manifest may not exist. The literals are the fallback
// for a manifest without the key, not the source of truth.
let wearChipMemo = null;
function wearChip() {
  if (wearChipMemo) return wearChipMemo;
  let c = {};
  try {
    const s = getAssetSet('vehicle_wear');
    c = (s && (s.chipThreshold || s.chip)) || {};
  } catch { c = {}; }
  wearChipMemo = { near: c['12'] ?? 0.6667, far: c['4'] ?? 0.7725 };
  return wearChipMemo;
}

let wearTex = null;
function wearTexture() {
  if (wearTex) return wearTex;
  wearTex = loadTexture('vehicle_wear', 'w');
  assetReady(wearTex).then((t) => {
    if (assetStatus(t) === 'ready') ZONE_U.uZWearOn.value = 1;
  });
  return wearTex;
}

function detailTextures(kind) {
  const d = DETAIL[kind];
  if (!d) return null;
  if (d.mode === 'surface') {
    return { d, col: loadTexture(d.set, 'c'), nrm: loadTexture(d.set, 'n') };
  }
  return { d, col: null, nrm: loadTexture(d.set, 'n') };
}

// ---------------------------------------------------------------------------
// triplanar injection
// ---------------------------------------------------------------------------
//
// Patches a MeshStandardMaterial to project its maps from object space instead
// of reading a uv attribute. `scale` is in world units per texture tile.
//
// The normal blend is Golus' "whiteout" triplanar: each axis's tangent normal
// is added to the matching swizzle of the GEOMETRIC normal and recombined.
// The first version kept only the sign of the geometric normal, which snapped
// every surface toward the nearest axis: a 60-degree glacis shaded like a flat
// deck and a cast turret like a box. With a flat map this now returns the
// geometric normal exactly.
//
// opts (each changes the generated code, so each is in the cache key):
//   zones   bake-dependent weathering (needs aZone/aBary/aEdge, see tanks.js)
//   detail  'paint' | 'cast' | 'rubber' | 'track' | 'rust' — CC0 detail set
//   track   roughness/metalness from the metalnessMap's G/B (polished faces)
// and per-material uniform values (do NOT change code):
//   zoneMask [z1, z2, z3, z4]  weights of each zone for this material
//   wash     0..1 whether whitewash may land on it (painted coats only)
//   primer   hex of the colour light chips expose (German red-oxide primer)

const GLSL_NOISE = `
      float zHash(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float zNoise(vec3 x) {
        vec3 i = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(zHash(i), zHash(i + vec3(1.0, 0.0, 0.0)), f.x),
              mix(zHash(i + vec3(0.0, 1.0, 0.0)), zHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
          mix(mix(zHash(i + vec3(0.0, 0.0, 1.0)), zHash(i + vec3(1.0, 0.0, 1.0)), f.x),
              mix(zHash(i + vec3(0.0, 1.0, 1.0)), zHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
          f.z);
      }
      float zEdge(float b, float e) {
        return e > 0.0 ? b * e : 1000.0;
      }`;

function applyTriplanar(material, scale, opts = {}) {
  const zones = !!opts.zones;
  const track = !!opts.track;
  const det = opts.detail ? detailTextures(opts.detail) : null;
  const detMode = det ? det.d.mode : 'none';
  const wear = zones ? wearTexture() : null;
  const zoneMask = new THREE.Vector4(...(opts.zoneMask || [1, 1, 1, 1]));
  const primer = new THREE.Color();
  if (Number.isFinite(opts.primer)) setLinearHex(primer, opts.primer);
  const primerOn = Number.isFinite(opts.primer) ? 1 : 0;
  const washOk = opts.wash ? 1 : 0;
  // camouflage mask (V-02): base paint + up to two sprayed paints, linear
  const camo = opts.camo && opts.camo.tex ? opts.camo : null;
  const camoCols = camo ? camo.paints.map((h) => {
    const c = new THREE.Color();
    setLinearHex(c, h);
    return c;
  }) : null;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTriScale = { value: scale };
    if (camo) {
      shader.uniforms.uCamoTex = { value: camo.tex };
      shader.uniforms.uCamoTile = { value: camo.tile };
      shader.uniforms.uCamo0 = { value: camoCols[0] };
      shader.uniforms.uCamo1 = { value: camoCols[1] };
      shader.uniforms.uCamo2 = { value: camoCols[2] };
    }
    if (det) {
      shader.uniforms.uDetTex = { value: det.nrm };
      shader.uniforms.uDetTile = { value: det.d.tile };
      shader.uniforms.uDetK = { value: new THREE.Vector3(...det.d.k) };
      if (det.col) shader.uniforms.uDetCol = { value: det.col };
    }
    if (zones) {
      shader.uniforms.uWearTex = { value: wear };
      shader.uniforms.uWearTile = { value: 1.1 };
      shader.uniforms.uZMask = { value: zoneMask };
      shader.uniforms.uZPrimer = { value: primer };
      shader.uniforms.uZPrimerOn = { value: primerOn };
      shader.uniforms.uZWashOk = { value: washOk };
      // shared objects: one battle-wide setting for every tank
      for (const k of Object.keys(ZONE_U)) shader.uniforms[k] = ZONE_U[k];
    }

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTriPos;
        varying vec3 vTriNrm;
        varying vec3 vTriBX;
        varying vec3 vTriBY;
        varying vec3 vTriBZ;
        ${zones ? `attribute float aZone;
        attribute vec2 aBary;
        attribute vec3 aEdge;
        varying float vZoneH;
        varying vec2 vBary;
        varying vec3 vEdge;` : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTriPos = position;
        vTriNrm = normal;
        // normalMatrix is a vertex-stage uniform and cannot be read from the
        // fragment shader, so carry it across as its three transformed basis
        // vectors instead. Recombining them below is exactly normalMatrix * v.
        vTriBX = normalMatrix * vec3(1.0, 0.0, 0.0);
        vTriBY = normalMatrix * vec3(0.0, 1.0, 0.0);
        vTriBZ = normalMatrix * vec3(0.0, 0.0, 1.0);
        ${zones ? `vZoneH = aZone;
        vBary = aBary;
        vEdge = aEdge;` : ''}`,
      );

    const head = `#include <common>
      uniform float uTriScale;
      varying vec3 vTriPos;
      varying vec3 vTriNrm;
      varying vec3 vTriBX;
      varying vec3 vTriBY;
      varying vec3 vTriBZ;
      ${det ? `uniform sampler2D uDetTex;
      uniform float uDetTile;
      uniform vec3 uDetK;` : ''}
      ${det && det.col ? 'uniform sampler2D uDetCol;' : ''}
      ${camo ? `uniform sampler2D uCamoTex;
      uniform float uCamoTile;
      uniform vec3 uCamo0;
      uniform vec3 uCamo1;
      uniform vec3 uCamo2;` : ''}
      ${zones ? `varying float vZoneH;
      varying vec2 vBary;
      varying vec3 vEdge;
      uniform sampler2D uWearTex;
      uniform float uWearTile;
      uniform float uZWearOn;
      uniform vec4 uZMask;
      uniform vec3 uZPrimer;
      uniform float uZPrimerOn;
      uniform float uZWashOk;
      uniform vec3 uZDust;
      uniform vec3 uZMud;
      uniform float uZSnow;
      uniform float uZWet;
      uniform float uZWash;
      ${GLSL_NOISE}` : ''}

      vec3 triWeights() {
        vec3 w = abs(normalize(vTriNrm));
        w = pow(w, vec3(4.0));
        return w / max(w.x + w.y + w.z, 1e-4);
      }

      vec4 triSample(sampler2D t, vec3 w, vec3 p) {
        return texture2D(t, p.zy) * w.x
             + texture2D(t, p.xz) * w.y
             + texture2D(t, p.xy) * w.z;
      }`;

    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', head);

    // Albedo, plus every sample and weathering weight the later stages reuse:
    // map_fragment runs before roughness, metalness and normal in main().
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `vec3 triP = vTriPos / uTriScale;
      vec3 triW = triWeights();
      vec4 rghS = vec4(0.0, 1.0, 0.0, 1.0);
      #ifdef USE_ROUGHNESSMAP
        rghS = triSample(roughnessMap, triW, triP);
      #endif
      vec4 mtlS = vec4(0.0, 1.0, 1.0, 1.0);
      #ifdef USE_METALNESSMAP
        mtlS = triSample(metalnessMap, triW, triP);
      #endif
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = triSample(map, triW, triP);
        diffuseColor *= sampledDiffuseColor;
      #endif
      ${track ? `{
        // Only the faces that meet the ground or the wheels wear bright: the
        // link EDGES (the belt's side, normal along x) stay dirty. The side
        // projection's link bands do not line up with the real links anyway.
        float trackSide = smoothstep(0.55, 0.85, abs(normalize(vTriNrm).x));
        float sidePolish = trackSide * mtlS.b;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.0685, 0.0561, 0.0395), sidePolish);
        mtlS.g = mix(mtlS.g, 0.9, sidePolish);
        mtlS.b *= 1.0 - trackSide;
      }` : ''}
      ${camo ? `{
        // the map is base paint x shade; swap the base for the sprayed paint
        vec4 cmS = triSample(uCamoTex, triW, vTriPos / uCamoTile);
        vec3 camoPaint = uCamo0 * (1.0 - cmS.r - cmS.g) + uCamo1 * cmS.r + uCamo2 * cmS.g;
        diffuseColor.rgb *= camoPaint / max(uCamo0, vec3(1e-4));
      }` : ''}
      float zChipW = 0.0;
      float zZ1W = 0.0;
      float zZ2W = 0.0;
      float zSnowW = 0.0;
      float zWetW = 0.0;
      float zWashW = 0.0;
      float zZ1Rough = 0.9;
      ${det ? `vec3 dP = vTriPos / uDetTile;
      vec4 dX = texture2D(uDetTex, dP.zy);
      vec4 dY = texture2D(uDetTex, dP.xz);
      vec4 dZ = texture2D(uDetTex, dP.xy);
      vec4 dMix = dX * triW.x + dY * triW.y + dZ * triW.z;` : ''}
      ${detMode === 'vehicle' ? 'diffuseColor.rgb *= mix(1.0, 2.0 * dMix.a, uDetK.z);' : ''}
      ${detMode === 'surface' ? `vec4 cMix = triSample(uDetCol, triW, dP);
      diffuseColor.rgb *= mix(vec3(1.0), 2.0 * cMix.rgb, uDetK.z);` : ''}
      ${zones ? `{
        vec3 zN = normalize(vTriNrm);
        float zH = vZoneH;
        float zn1 = zNoise(vTriPos * 2.7);
        float zn2 = zNoise(vTriPos * 8.3 + vec3(3.7));
        float zn = zn1 * 0.65 + zn2 * 0.35;
        vec4 wMix = triSample(uWearTex, triW, vTriPos / uWearTile);
        float zb3 = 1.0 - vBary.x - vBary.y;
        float eD = min(min(zEdge(vBary.x, vEdge.x), zEdge(vBary.y, vEdge.y)), zEdge(zb3, vEdge.z));
        float polish = ${track ? 'mtlS.b' : '0.0'};
        // Z1 top edge, ragged between 0.42 and 0.74 m above the ground contact
        float z1Top = 0.42 + 0.32 * zn;
        // winter whitewash (C-15): brushed on thin, so the paint ghosts through
        // in vertical strokes, and worn through on convex edges (raggedly),
        // low on the hull and on the decks the crew climb over. A soft scrubbed
        // edge, never a hard noise threshold: that read as a deliberate
        // two-tone blotch camouflage. scratchpad t_wash.mjs is its CPU twin.
        if (uZWash * uZWashOk > 0.0) {
          float wb1 = zNoise(vTriPos * vec3(6.0, 1.7, 6.0) + vec3(7.1));
          float wb2 = zNoise(vTriPos * 15.0 + vec3(1.3));
          float washWear = 0.35 * (1.0 - smoothstep(0.005, 0.07, eD)) * (0.6 + 0.8 * wb2)
            + 0.35 * (1.0 - smoothstep(z1Top + 0.05, z1Top + 0.50, zH))
            + 0.20 * smoothstep(0.65, 0.92, zN.y);
          float washV = zn1 * 0.40 + wb1 * 0.35 + wb2 * 0.25 + 0.16 - washWear;
          zWashW = uZWash * uZWashOk * smoothstep(0.30, 0.50, washV)
            * smoothstep(z1Top - 0.1, z1Top + 0.15, zH);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.584, 0.597, 0.565) * (0.92 + 0.16 * zn2),
            zWashW * mix(0.78, 0.96, wb1));
        }
        // Z3: rain streaks down vertical plates above Z1 (R of the data map)
        float st = rghS.r * uZMask.z * (1.0 - smoothstep(0.22, 0.36, abs(zN.y)))
          * smoothstep(z1Top, z1Top + 0.2, zH);
        diffuseColor.rgb *= 1.0 - st * vec3(0.22, 0.27, 0.32);
        // Z4: chips within 3 cm of convex creases; the CC0 wear mask once it
        // has loaded, the painter's rank-uniform field until then
        float eT = clamp(eD / 0.03, 0.0, 1.0);
        float chipF = mix(rghS.b, wMix.r, uZWearOn);
        float thrN = mix(0.865, ${wearChip().near.toFixed(4)}, uZWearOn);
        float thrF = mix(0.955, ${wearChip().far.toFixed(4)}, uZWearOn);
        float thr = mix(thrN, thrF, eT);
        zChipW = (1.0 - step(0.03, eD)) * step(thr, chipF) * uZMask.w;
        vec3 chipCol = mix(vec3(0.050, 0.047, 0.044), uZPrimer,
          uZPrimerOn * (1.0 - step(thr + 0.06, chipF)));
        diffuseColor.rgb = mix(diffuseColor.rgb, chipCol, zChipW);
        // Z1: dust, or mud when wet / slush in winter, over the running gear
        // and lower hull. Polished track faces stay clean.
        float mudMix = clamp(uZWet + uZSnow * 0.6, 0.0, 1.0);
        const vec3 ZLUMA = vec3(0.2126, 0.7152, 0.0722);
        vec3 zDust = mix(uZDust, vec3(dot(uZDust, ZLUMA)), 0.2);
        vec3 z1Col = mix(zDust, uZMud, mudMix) * (0.85 + 0.30 * zn2);
        zZ1W = (1.0 - smoothstep(z1Top - 0.22, z1Top + 0.03, zH))
          * mix(0.62, 0.98, zn2) * uZMask.x * (1.0 - polish * 0.85);
        diffuseColor.rgb = mix(diffuseColor.rgb, z1Col, zZ1W);
        zZ1Rough = mix(0.92, 0.42, uZWet);
        // Z2: a dust film on decks and roofs, 15-35 %, capped so the coat
        // stays within V-20's +-12 % of its paint above Z1
        const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
        float lumNow = max(dot(diffuseColor.rgb, LUMA), 1e-3);
        float lumDust = dot(zDust, LUMA);
        float cap = 0.35 / max(abs(lumDust / lumNow - 1.0), 0.35);
        zZ2W = smoothstep(0.70, 0.92, zN.y) * (0.12 + 0.30 * max(wMix.g, zn * 0.8))
          * uZMask.y * cap * (1.0 - zZ1W);
        diffuseColor.rgb = mix(diffuseColor.rgb, zDust, zZ2W);
        // snow lying on the decks
        zSnowW = uZSnow * smoothstep(0.55, 0.85, zN.y) * smoothstep(0.42, 0.62, zn) * uZMask.y;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.855, 0.900, 0.930), zSnowW);
        // wet: darker and glossier, on the mud and on anything facing the sky
        zWetW = uZWet * max(zZ1W, smoothstep(0.5, 0.9, zN.y)) * (1.0 - zSnowW);
        diffuseColor.rgb *= 1.0 - 0.30 * zWetW;
      }` : ''}`,
    );

    // Roughness
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `float roughnessFactor = roughness;
      ${track ? 'roughnessFactor *= mtlS.g;' : `#ifdef USE_ROUGHNESSMAP
        roughnessFactor *= rghS.g;
      #endif`}
      ${detMode === 'vehicle' ? 'roughnessFactor *= mix(1.0, 2.0 * dMix.b, uDetK.y);' : ''}
      ${zones ? `roughnessFactor = mix(roughnessFactor, 0.90, zWashW);
      roughnessFactor = mix(roughnessFactor, 0.38, zChipW);
      roughnessFactor = mix(roughnessFactor, zZ1Rough, zZ1W);
      roughnessFactor = min(1.0, roughnessFactor + 0.40 * zZ2W);
      roughnessFactor = mix(roughnessFactor, 0.90, zSnowW);
      roughnessFactor *= 1.0 - 0.5 * zWetW;` : ''}`,
    );

    // Metalness: triplanar too, or the polished track faces would be read
    // through a uv the geometry does not have
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <metalnessmap_fragment>',
      `float metalnessFactor = metalness;
      #ifdef USE_METALNESSMAP
        metalnessFactor *= mtlS.b;
      #endif
      ${zones ? 'metalnessFactor *= 1.0 - zZ1W;' : ''}`,
    );

    // Normal. The object-space path only; the material must not also be asked
    // for a tangent attribute it does not have.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `{
        #ifdef USE_NORMALMAP
          vec3 tnX = texture2D(normalMap, triP.zy).xyz * 2.0 - 1.0;
          vec3 tnY = texture2D(normalMap, triP.xz).xyz * 2.0 - 1.0;
          vec3 tnZ = texture2D(normalMap, triP.xy).xyz * 2.0 - 1.0;
          tnX.xy *= normalScale;
          tnY.xy *= normalScale;
          tnZ.xy *= normalScale;
        #else
          vec3 tnX = vec3(0.0, 0.0, 1.0);
          vec3 tnY = tnX;
          vec3 tnZ = tnX;
        #endif
        ${det ? `tnX.xy += (dX.xy * 2.0 - 1.0) * uDetK.x;
        tnY.xy += (dY.xy * 2.0 - 1.0) * uDetK.x;
        tnZ.xy += (dZ.xy * 2.0 - 1.0) * uDetK.x;` : ''}
        ${zones ? `float zFlat = 1.0 - 0.7 * max(zZ1W, zSnowW);
        tnX.xy *= zFlat;
        tnY.xy *= zFlat;
        tnZ.xy *= zFlat;` : ''}
        vec3 gn = normalize(vTriNrm);
        vec3 nX = vec3(tnX.xy + gn.zy, abs(tnX.z) * gn.x);
        vec3 nY = vec3(tnY.xy + gn.xz, abs(tnY.z) * gn.y);
        vec3 nZ = vec3(tnZ.xy + gn.xy, abs(tnZ.z) * gn.z);
        vec3 objN = normalize(nX.zyx * triW.x + nY.xzy * triW.y + nZ.xyz * triW.z);
        normal = normalize(objN.x * vTriBX + objN.y * vTriBY + objN.z * vTriBZ);
      }`,
    );

    material.userData.shader = shader;
  };
  // Two materials that compile to different programs must not share a cache
  // key, and three.js keys on this string. Everything that changes the
  // GENERATED code is in it; per-material numbers are uniforms and are not.
  const key = `tri3|z${zones ? 1 : 0}|t${track ? 1 : 0}|d${detMode}|c${camo ? 1 : 0}`;
  material.customProgramCacheKey = () => key;
  material.userData.triScale = scale;
  if (zones) {
    // keeps the shared zone uniforms on the active biome (cheap identity test)
    material.onBeforeRender = syncVehicleEnv;
  }
  return material;
}

// ---------------------------------------------------------------------------
// caches
// ---------------------------------------------------------------------------

const texCache = new Map();
const matCache = new Map();

function cachedTex(key, build) {
  let t = texCache.get(key);
  if (!t) {
    t = build();
    for (const tex of Object.values(t)) markShared(tex);
    texCache.set(key, t);
  }
  return t;
}

function seedFromKey(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100000;
}

// material -> its camouflage mask texture, for tests and tools. Kept out of
// userData on purpose: Material/Texture.copy() JSON-copy userData, and a
// Texture in there is PNG-encoded on every clone (backlog N7).
const camoMaskOf = new WeakMap();
export function camoMask(material) {
  return camoMaskOf.get(material) || null;
}

function schemeKey(scheme) {
  if (!Array.isArray(scheme) || !scheme.length) return '';
  return scheme.map((s) => `${s.hex}:${s.coverage}`).join(',');
}

// ---------------------------------------------------------------------------
// public material builders
// ---------------------------------------------------------------------------

// Painted armour plate. The tank hull, turret, fittings, running gear and the
// gun: rough, matte, a DIELECTRIC (C-02), in the calibrated nation paint.
//   camo     legacy: a hex for the old soft two-tone blob, OR an array
//            [{hex, coverage}] — a seeded spray scheme (V-02, C-16)
//   zones    run the weathering zones (geometry must carry aZone/aBary/aEdge,
//            which vehicles/tanks.js bakes); off, the old wear is baked in
//   cast     a casting rather than rolled plate (orange-peel detail)
//   primer   colour light chips expose (German red-oxide); null = bare steel
//   rivets   rivet heads in the maps — a riveted hull (M3); welded plate and
//            castings have none
export function armourMaterial(color, opts = {}) {
  const {
    camo = null, wear = 0.5, scale = 1.6, flatShading = true,
    zones = false, cast = false, primer = null, detail = true, rivets = true,
  } = opts;
  const scheme = Array.isArray(camo) ? camo : null;
  const legacyCamo = typeof camo === 'number' ? camo : null;
  const sk = scheme ? schemeKey(scheme) : String(legacyCamo);
  const key = `armour|${color}|${sk}|${wear}|${zones ? 'z' : 'b'}|${rivets ? 'r' : 'w'}|${quality}`;
  const maps = cachedTex(key, () =>
    paintArmour(TEX_SIZE[quality], color, seedFromKey(key), {
      wear, camo: legacyCamo, scheme, bakeWear: !zones, rivets,
    }));
  const matKey = `${key}|${scale}|${flatShading}|${cast}|${primer}|${detail}`;
  let m = matCache.get(matKey);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    // The map carries the roughness; these are the multipliers on top of it.
    roughness: 1,
    // paint is a dielectric (bible C-02): F0 0.04 and nothing else
    metalness: 0,
    // a casting is smoother than rolled plate; the same maps, a softer relief
    // (the CC0 cast-steel detail then adds its own orange-peel)
    normalScale: cast ? new THREE.Vector2(0.4, 0.4) : new THREE.Vector2(0.6, 0.6),
    flatShading,
  });
  m.name = `paint ${color.toString(16)}${scheme ? ' scheme' : ''}${zones ? ' zones' : ''}`;
  if (maps.camoMap) {
    m.map.userData.camo = maps.camoMap.userData.camo;
    camoMaskOf.set(m, maps.camoMap);
  }
  applyTriplanar(m, scale, {
    zones,
    camo: maps.camoMap ? {
      tex: maps.camoMap,
      tile: CAMO_TILE,
      paints: [color, scheme[0].hex, (scheme[1] || scheme[0]).hex],
    } : null,
    detail: detail ? (cast ? 'cast' : 'paint') : null,
    zoneMask: [1, 1, 1, 1],
    wash: true,
    primer: Number.isFinite(primer) ? primer : null,
  });
  markShared(m);
  matCache.set(matKey, m);
  return m;
}

// Bare or blued steel: gun barrels, mantlets, fittings. Metalness high enough
// that it picks up the sky, which is what sells it as metal.
export function steelMaterial(color = 0x3c4038, opts = {}) {
  const { rough = 0.45, metal = 0.85, scale = 1.0 } = opts;
  // scale belongs in the key: it decides the triplanar tile size AND the
  // customProgramCacheKey, so two callers asking for the same steel at
  // different scales must not be handed the same material.
  const key = `steel|${color}|${rough}|${metal}|${scale}|${quality}`;
  let m = matCache.get(key);
  if (m) return m;
  const maps = cachedTex(`steeltex|${color}|${quality}`, () =>
    paintArmour(TEX_SIZE[quality], color, seedFromKey(key), { wear: 0.25, rivets: false }));
  m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: maps.map,
    normalMap: maps.normalMap,
    roughness: rough,
    metalness: metal,
    normalScale: new THREE.Vector2(0.5, 0.5),
    flatShading: true,
  });
  applyTriplanar(m, scale);
  markShared(m);
  matCache.set(key, m);
  return m;
}

// Track (V-11). Dirty steel, metalness 0, except the polished faces the
// metalness map marks (metal 1, roughness .25-.35). With `zones` the biome's
// dust and mud settle on it, away from the polished faces.
export function trackMaterial(opts = {}) {
  const { scale = 0.9, zones = false } = opts;
  const key = `track|${quality}|${scale}|${zones}`;
  let m = matCache.get(key);
  if (m) return m;
  const maps = cachedTex(`tracktex2|${quality}`, () =>
    paintTrack(TEX_SIZE[quality], 4242));
  m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: maps.map,
    normalMap: maps.normalMap,
    metalnessMap: maps.metalnessMap,
    roughness: 1,
    // metalness map multiplies this: 0 on the dirt, 1 on the polished faces
    metalness: 1,
    normalScale: new THREE.Vector2(1.0, 1.0),
  });
  m.name = 'track';
  applyTriplanar(m, scale, {
    zones, track: true, detail: 'track', zoneMask: [1, 0, 0, 0],
  });
  markShared(m);
  matCache.set(key, m);
  return m;
}

// Road-wheel tyres (V-11, bible 5.2): worn rubber #3a3a38, roughness .8.
export function rubberMaterial(opts = {}) {
  const { color = 0x3a3a38, rough = 0.8, scale = 0.6, zones = false } = opts;
  const key = `rubber|${color}|${rough}|${scale}|${zones}`;
  let m = matCache.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
  m.name = 'rubber';
  applyTriplanar(m, scale, { zones, detail: 'rubber', zoneMask: [1, 0, 0, 0] });
  markShared(m);
  matCache.set(key, m);
  return m;
}

// Heat-discoloured exhaust steel: rust orange-brown (bible 5.3 Z5, #7a4a2a),
// with the CC0 coarse-rust photo for its colour break-up and relief.
//
// One material serves every tank, whatever its paint, so it deliberately has
// NO roughnessMap (a flat .86, the painter's mean for it): vehicles/tankEntity
// wreckMaterial() takes "map + roughnessMap" to mean the painted coat and
// normalises it by the coat luminance of whichever tank died FIRST, which made
// every later exhaust wreck 3x too dark or right depending on kill order. The
// same holds for any future material shared across paints: map without a
// roughnessMap, or no map at all.
const EXHAUST_ROUGH = 0.86;
export function exhaustMaterial(opts = {}) {
  const { color = 0x7a4a2a, scale = 0.7, zones = false } = opts;
  const key = `exhaust|${color}|${scale}|${zones}|${quality}`;
  let m = matCache.get(key);
  if (m) return m;
  const maps = cachedTex(`exhausttex|${color}|${quality}`, () =>
    paintArmour(TEX_SIZE[quality], color, seedFromKey(key), {
      wear: 0.2, rivets: false, bakeWear: false, roughBase: EXHAUST_ROUGH,
    }));
  m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: maps.map,
    normalMap: maps.normalMap,
    roughness: EXHAUST_ROUGH,
    metalness: 0,
    normalScale: new THREE.Vector2(0.6, 0.6),
  });
  m.name = 'exhaust rust';
  applyTriplanar(m, scale, { zones, detail: 'rust', zoneMask: [1, 0.5, 0, 0] });
  markShared(m);
  matCache.set(key, m);
  return m;
}

// The muzzle crown and brake (V-03, C-04): bare steel, sooted toward the
// muzzle. The soot gradient is in the geometry's vertex colours, so one
// material serves every gun.
export function gunCrownMaterial(opts = {}) {
  const { color = 0x2b2a28, rough = 0.55, metal = 1, scale = 0.5 } = opts;
  const key = `crown|${color}|${rough}|${metal}|${scale}|${quality}`;
  let m = matCache.get(key);
  if (m) return m;
  const maps = cachedTex(`steeltex|${color}|${quality}`, () =>
    paintArmour(TEX_SIZE[quality], color, seedFromKey(key), { wear: 0.25, rivets: false }));
  m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: maps.map,
    normalMap: maps.normalMap,
    roughness: rough,
    metalness: metal,
    vertexColors: true,
    normalScale: new THREE.Vector2(0.5, 0.5),
  });
  m.name = 'gun crown';
  applyTriplanar(m, scale, { detail: 'cast' });
  markShared(m);
  matCache.set(key, m);
  return m;
}

// Contact shadow (V-10): a soft dark ellipse under a ground vehicle, multiply
// style (black at an alpha), depth-write off. Its strength follows the quality
// tier: full on low/medium, 0.35 on high where GTAO already darkens the
// contact (bible tier table). One shared texture, one shared unit quad.
//
// CONTACT_CENTRE is the LINEAR-light alpha under the belly. Measured in
// steppe-noon battles (frozen build; hull drawn invisible but still casting;
// texture-matched against the same ground with no tank): the sun shadow
// darkens the ground under a hull by only 0-10 % on low/medium (coarse map,
// large normal bias), so the blob does nearly all the grounding. 0.42 left
// medium at 0.57-0.62x of open ground, outside V-10's 0.35-0.55x; 0.55 gives
// 0.38-0.50x. On high the near cascade's shadow already gives 0.53-0.68x and
// the 0.35 tier lands the sum at 0.44-0.54x, clear of the 0.30x floor.
//
// Blending space: through the post chain (medium/high) the blob blends into a
// linear target; straight onto the canvas (low, or a chain that died) it
// blends in sRGB-ENCODED values, where the same alpha darkens ~(1-a)^2.2 —
// 0.19x measured on low. contactBlend() picks the alpha per render target so
// both land on the same linear darkening.
const CONTACT_CENTRE = 0.55;
function contactBlend(alphaLin) {
  const alphaSrgb = 1 - (1 - alphaLin) ** (1 / 2.2);
  return function contactBlendPick(renderer) {
    const rt = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
    const cs = rt ? (rt.texture && rt.texture.colorSpace) : renderer.outputColorSpace;
    this.opacity = cs === THREE.SRGBColorSpace ? alphaSrgb : alphaLin;
  };
}
let contactGeo = null;
export function contactShadowGeometry() {
  if (contactGeo) return contactGeo;
  contactGeo = new THREE.PlaneGeometry(1, 1);
  contactGeo.rotateX(-Math.PI / 2);
  contactGeo.deleteAttribute('normal');
  markShared(contactGeo);
  return contactGeo;
}

export function contactShadowMaterial() {
  const tier = quality === 'high' ? 0.35 : 1.0;
  const key = `contact|${quality}`;
  let m = matCache.get(key);
  if (m) return m;
  const maps = cachedTex('contacttex', () => {
    const size = 64;
    const c = makeCanvas(size);
    const ctx = ctxOf(c);
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = ((x + 0.5) / size) * 2 - 1;
        const dy = ((y + 0.5) / size) * 2 - 1;
        const r = Math.hypot(dx, dy);
        // full strength under the belly, fading out across the last half
        const a = (1 - smoothstep(r, 0.5, 1.0)) ** 1.2;
        const i = (y * size + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = a * 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = texFromCanvas(c);
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    return { alphaMap: t };
  });
  m = new THREE.MeshBasicMaterial({
    color: 0x000000,
    alphaMap: maps.alphaMap,
    transparent: true,
    opacity: CONTACT_CENTRE * tier,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  m.name = 'contact shadow';
  m.userData.contactShadow = true;
  // three calls this before the first blob of every render() refreshes the
  // material's uniforms, so the whole frame draws at the right alpha
  m.onBeforeRender = contactBlend(CONTACT_CENTRE * tier);
  markShared(m);
  matCache.set(key, m);
  return m;
}

// Painted aircraft skin: smoother than armour, panel-lined, soot-streaked.
// Metalness stays 0.35 until the air lane's schemes (V-05) and natural-metal
// skin (V-06) land; pass `metal` to override.
export function alloyMaterial(color, opts = {}) {
  const { wear = 0.35, scale = 2.4, flatShading = false, metal = 0.35 } = opts;
  const key = `alloy|${color}|${wear}|${quality}`;
  const maps = cachedTex(key, () =>
    paintAlloy(TEX_SIZE[quality], color, seedFromKey(key), { wear }));
  const matKey = `${key}|${scale}|${flatShading}|${metal}`;
  let m = matCache.get(matKey);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    roughness: 1,
    metalness: metal,
    normalScale: new THREE.Vector2(0.7, 0.7),
    flatShading,
  });
  applyTriplanar(m, scale);
  markShared(m);
  matCache.set(matKey, m);
  return m;
}

// Canopy and vision-block glass. Transmissive glass is too expensive for a
// dozen aircraft, so this is a cheap tinted dielectric that still reflects the
// sky — which is the only part anyone actually notices.
export function glassMaterial(color = 0x8fb4c8, opacity = 0.42) {
  const key = `glass|${color}|${opacity}`;
  let m = matCache.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.08,
    metalness: 0.1,
    transparent: true,
    opacity,
    envMapIntensity: 1.8,
  });
  markShared(m);
  matCache.set(key, m);
  return m;
}

// Flat unlit colour, for team markers and anything that must stay readable
// regardless of where the sun is. Kept here so callers have one import.
export function markerMaterial(color) {
  const key = `marker|${color}`;
  let m = matCache.get(key);
  if (m) return m;
  m = new THREE.MeshBasicMaterial({ color });
  markShared(m);
  matCache.set(key, m);
  return m;
}

// Rubber, canvas, wood, and the other matte odds and ends.
export function mattMaterial(color, opts = {}) {
  const { rough = 0.95, metal = 0, flatShading = true } = opts;
  const key = `matt|${color}|${rough}|${metal}|${flatShading}`;
  let m = matCache.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: metal, flatShading,
  });
  markShared(m);
  matCache.set(key, m);
  return m;
}

// ===========================================================================
// AIRCRAFT LOOK (wave 3d markings lane): new factories only.
//   airframeMaterial(def)   V-05 schemes, V-06 natural metal, V-08 dark parts,
//                           V-09 insignia painted into the scheme, V-12 zones
//   applyClearGlass(mat)    V-08 clear canopy glass (Fresnel alpha)
//   propDiscMaterial(def)   A-01 the propeller disc as a photograph sees it
//   markingsMaterial(atlas) V-09 tank decals and V-08 vision-block glass
// ===========================================================================
//
// ONE material draws every opaque part of an aeroplane. What a texel is made
// of — fuselage paint, flying-surface paint, gun steel, tyre, lens, blade —
// is a per-vertex class (aMark.x), so the airframe needs no material breaks
// and P-03's merged, skinned meshes stay one draw each. The scheme logic runs
// in the AIRCRAFT frame (aAir / aAirN: rest-pose position and normal, baked by
// vehicles/planes.js), so a pattern, a band or a roundel continues across the
// wing, the aileron and the fuselage as one coat of paint and stays on a
// control surface when it moves. The triplanar detail (panel lines, oil-can
// relief) runs in the mesh's own bind-pose frame, like every other vehicle
// material here; with skinning on, the bone rotation is carried into the
// normal basis so a deflected aileron is lit as deflected.
export const AF_CLASS = Object.freeze({
  FUS: 0,           // fuselage, fin, rudder: upper/lower by demarcation height
  SURF: 1,          // wings, tailplane, flaps, ailerons, elevator: by normal
  UNDER: 2,         // always the lower-surface colour (gear legs and doors)
  GUN: 3,           // blued gun steel
  EXHAUST: 4,       // heat-burnt exhaust stubs
  INTERIOR: 5,      // cockpit interior paint
  PILOT: 6,         // the pilot's leather
  TYRE: 7,          // worn tyre rubber
  LENS_RED: 8,      // port navigation light, unlit coloured glass
  LENS_GREEN: 9,    // starboard navigation light
  BLADE: 10,        // propeller blade paint (tip ring by radius)
  SPINNER: 11,
  ARMOUR_GLASS: 12, // the flat armoured windscreen: glass over a dark cockpit
  STEEL: 13,        // racks, rails, aerial wire, bare fittings
  BOMB: 14,
  ROCKET: 15,
});
const AF_N = 16;

// GLSL zNoise in JS (same hash), for calibrating thresholds against coverage.
// The hash lives on float32 rounding (a fract of a product in the 1e5 range),
// so every step is rounded to float32 the way a highp GPU evaluates it, or
// the distribution — and every threshold derived from it — would be wrong.
const f32 = Math.fround;
function zFract(v) {
  return f32(v - Math.floor(v));
}
function zHashJS(x, y, z) {
  const px = f32(zFract(f32(f32(f32(x) * f32(0.3183099)) + f32(0.71))) * 17);
  const py = f32(zFract(f32(f32(f32(y) * f32(0.3183099)) + f32(0.113))) * 17);
  const pz = f32(zFract(f32(f32(f32(z) * f32(0.3183099)) + f32(0.419))) * 17);
  return zFract(f32(f32(f32(px * py) * pz) * f32(f32(px + py) + pz)));
}
export function zNoiseJS(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  let fx = x - ix;
  let fy = y - iy;
  let fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const h = (a, b, c) => zHashJS(ix + a, iy + b, iz + c);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(h(0, 0, 0), h(1, 0, 0), fx), l(h(0, 1, 0), h(1, 1, 0), fx), fy),
    l(l(h(0, 0, 1), h(1, 0, 1), fx), l(h(0, 1, 1), h(1, 1, 1), fx), fy),
    fz,
  );
}
// The chip field the shader thresholds: 0.55 n(p*41) + 0.45 n(p*97 + 3.1).
export function afChipField(x, y, z) {
  return 0.55 * zNoiseJS(x * 41, y * 41, z * 41) + 0.45 * zNoiseJS(x * 97 + 3.1, y * 97 + 3.1, z * 97 + 3.1);
}
let chipCdf = null;
// The threshold that leaves `coverage` of a zone chipped.
export function afChipThreshold(coverage) {
  if (!chipCdf) {
    const s = [];
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 20000; i++) s.push(afChipField(rnd() * 9 - 4.5, rnd() * 3 - 1.5, rnd() * 11 - 5.5));
    chipCdf = Float32Array.from(s).sort();
  }
  const q = Math.min(0.9999, Math.max(0, 1 - coverage));
  return chipCdf[Math.floor(q * (chipCdf.length - 1))];
}

// A well-mixed integer hash -> [0, 1). (hash2 above multiplies in doubles and
// its spread collapses for seeds in the 1e4-1e5 range seedFromKey returns:
// every value lands under 0.5, so it cannot pick colours at 50/50.)
function ihash(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Shared panel detail for every aircraft: R albedo modulation (0.5 = x1),
// G roughness modulation, B a per-PANEL id (nine levels, the V-06 sheen
// variance), A the recessed panel line. Panels are staggered like real skin
// (each row's seams offset half a panel), 0.6 m at the default 2.4 m tile.
function paintAirframeDetail(size, seed) {
  const n = size * size;
  const data = new Uint8Array(n * 4);
  const hgt = new Uint8ClampedArray(n * 4);
  const step = size / 4;
  const rows = [0];
  const cols = [0];
  for (let k = 1; k < 4; k++) {
    rows.push(k * step + (ihash(k, 7, seed) - 0.5) * step * 0.3);
    cols.push(k * step + (ihash(k, 3, seed) - 0.5) * step * 0.3);
  }
  const lw = Math.max(1, size / 256) * 0.5;
  const P = 4;
  for (let y = 0; y < size; y++) {
    let r = 0;
    while (r < 3 && y >= rows[r + 1]) r++;
    const y0 = rows[r];
    const y1 = r < 3 ? rows[r + 1] : size;
    const dyLine = Math.min(y - y0, y1 - y);
    for (let x = 0; x < size; x++) {
      // brick stagger: odd rows shift their seams by half a panel
      const xs = (x + (r & 1 ? step * 0.5 : 0)) % size;
      let c = 0;
      while (c < 3 && xs >= cols[c + 1]) c++;
      const x0 = cols[c];
      const x1 = c < 3 ? cols[c + 1] : size;
      const dxLine = Math.min(xs - x0, x1 - xs);
      const d = Math.min(dxLine, dyLine);
      const line = 1 - smoothstep(d, lw, lw + 1);
      const mottle = fbm2((x / size) * P, (y / size) * P, seed, 3, P, P);
      const grain = fbm2((x / size) * 64, (y / size) * 64, seed + 17, 2, 64, 64);
      const id = Math.round(ihash(c + 5 * (r & 1), r, seed + 5) * 8) / 8;
      // oil-canning: each panel bulges a little between its frames
      const u = ((xs - x0) / Math.max(1, x1 - x0)) * 2 - 1;
      const v = ((y - y0) / Math.max(1, y1 - y0)) * 2 - 1;
      const dome = (1 - u * u) * (1 - v * v);
      const h = 0.5 + 0.10 * dome + (grain - 0.5) * 0.05 - line * 0.22;
      const i = (y * size + x) * 4;
      data[i] = Math.max(0, Math.min(255, Math.round(128 + (mottle - 0.5) * 90 + (grain - 0.5) * 24)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(128 + (grain - 0.5) * 80 + (mottle - 0.5) * 40)));
      data[i + 2] = Math.round(id * 255);
      data[i + 3] = Math.round(line * 255);
      const hv = Math.max(0, Math.min(255, Math.round(h * 255)));
      hgt[i] = hgt[i + 1] = hgt[i + 2] = hv;
      hgt[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = maxAnisotropy;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  const nrm = heightToNormal(hgt, size, 1.2);
  nrm.magFilter = THREE.LinearFilter;
  nrm.minFilter = THREE.LinearMipmapLinearFilter;
  nrm.generateMipmaps = true;
  return { detail: tex, normal: nrm, data, size };
}

// The scheme's pattern, projected in PLAN over the whole aeroplane (bible
// V-05: real schemes are drawn on a plan view). R: the two-colour upper
// field, 0.5 on the boundary (> 0.5 is the second upper colour). G: the
// fuselage-side mottle field, the same encoding. The texture spans the square
// [-S, S] in metres on both axes.
//   'splinter'   straight-edged facets (RLM 74/75): a two-colour Voronoi field,
//                whose boundary between differently coloured cells is exactly
//                the straight bisector, stored as a signed distance so the
//                edge stays hard and anti-aliased at any range
//   'disruptive' curving sprayed shapes (RAF, VVS): domain-warped fbm,
//                rank-normalised so `coverage` is exact
// `footprint` ([[x, z, planArea], ...], the upper surfaces the aeroplane
// really has) makes `coverage` exact ON THE AIRFRAME rather than over the whole
// square, most of which is air: a 50/50 Spitfire is 50/50 where the paint is.
function paintSchemePattern(scheme, S, size, seed, footprint = null) {
  const n = size * size;
  const data = new Uint8Array(n * 4);
  const kind = scheme.pattern || 'mono';
  const cover = scheme.coverage != null ? scheme.coverage : 0.5;
  const world = (p) => -S + ((p + 0.5) / size) * 2 * S;
  const field = new Float32Array(n);
  const foot = footprint && footprint.length ? footprint : null;
  if (kind === 'splinter') {
    const cell = scheme.feature || 1.5;
    const g = Math.ceil((2 * S) / cell) + 3;
    const sites = [];
    for (let j = 0; j < g; j++) {
      for (let i = 0; i < g; i++) {
        sites.push([
          -S - cell + (i + 0.15 + 0.7 * ihash(i, j, seed)) * cell,
          -S - cell + (j + 0.15 + 0.7 * ihash(i, j, seed + 11)) * cell,
          ihash(i, j, seed + 23) < cover ? 1 : 0,
          ihash(i, j, seed + 23),
        ]);
      }
    }
    if (foot) {
      // the facets that lie on the aeroplane take the second colour in hash
      // order until it covers `coverage` of the painted plan area
      const area = new Float64Array(sites.length);
      let tot = 0;
      for (const [x, z, a] of foot) {
        const ci = Math.floor((x + S + cell) / cell);
        const cj = Math.floor((z + S + cell) / cell);
        let best = -1;
        let bd = 1e9;
        for (let dj = -2; dj <= 2; dj++) {
          for (let di = -2; di <= 2; di++) {
            const ii = ci + di;
            const jj = cj + dj;
            if (ii < 0 || jj < 0 || ii >= g || jj >= g) continue;
            const s = sites[jj * g + ii];
            const d = Math.hypot(s[0] - x, s[1] - z);
            if (d < bd) {
              bd = d;
              best = jj * g + ii;
            }
          }
        }
        if (best >= 0) {
          area[best] += a;
          tot += a;
        }
      }
      const order = [];
      for (let k = 0; k < sites.length; k++) if (area[k] > 0) order.push(k);
      order.sort((a, b) => sites[a][3] - sites[b][3]);
      let acc = 0;
      for (const k of order) {
        const on = acc + area[k] * 0.5 <= cover * tot;
        sites[k][2] = on ? 1 : 0;
        if (on) acc += area[k];
      }
    }
    for (let py = 0; py < size; py++) {
      const z = world(py);
      const cj = Math.floor((z + S + cell) / cell);
      for (let px = 0; px < size; px++) {
        const x = world(px);
        const ci = Math.floor((x + S + cell) / cell);
        let d0 = 1e9;
        let d1 = 1e9;
        for (let dj = -2; dj <= 2; dj++) {
          for (let di = -2; di <= 2; di++) {
            const ii = ci + di;
            const jj = cj + dj;
            if (ii < 0 || jj < 0 || ii >= g || jj >= g) continue;
            const s = sites[jj * g + ii];
            const d = Math.hypot(s[0] - x, s[1] - z);
            if (s[2]) d1 = Math.min(d1, d);
            else d0 = Math.min(d0, d);
          }
        }
        // the bisector distance between the nearest of each colour
        field[py * size + px] = 0.5 + 0.5 * Math.max(-1, Math.min(1, (d0 - d1) / 0.6));
      }
    }
  } else if (kind === 'disruptive') {
    const f = scheme.feature || 1.8;
    const raw = new Float32Array(n);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = world(px) / f;
        const z = world(py) / f;
        const wx = fbm2(x * 0.7 + 3.1, z * 0.7, seed + 3, 3, 1e6, 1e6) - 0.5;
        const wz = fbm2(x * 0.7, z * 0.7 + 5.7, seed + 5, 3, 1e6, 1e6) - 0.5;
        raw[py * size + px] = fbm2(x + wx * 1.6 + 50, z + wz * 1.6 + 50, seed, 4, 1e6, 1e6);
      }
    }
    rankUniform(raw);
    let t = 1 - cover;
    if (foot) {
      // the threshold that leaves `coverage` of the painted plan area above it
      // (read bilinearly at texel centres, as the GPU filters the field)
      const at = [];
      let tot = 0;
      for (const [x, z, a] of foot) {
        const fx = ((x + S) / (2 * S)) * size - 0.5;
        const fz = ((z + S) / (2 * S)) * size - 0.5;
        const ix = Math.max(0, Math.min(size - 1, Math.floor(fx)));
        const iz = Math.max(0, Math.min(size - 1, Math.floor(fz)));
        const jx = Math.min(size - 1, ix + 1);
        const jz = Math.min(size - 1, iz + 1);
        const tx = Math.max(0, Math.min(1, fx - ix));
        const tz = Math.max(0, Math.min(1, fz - iz));
        const r0 = raw[iz * size + ix] * (1 - tx) + raw[iz * size + jx] * tx;
        const r1 = raw[jz * size + ix] * (1 - tx) + raw[jz * size + jx] * tx;
        at.push([r0 * (1 - tz) + r1 * tz, a]);
        tot += a;
      }
      at.sort((p, q) => q[0] - p[0]);
      let acc = 0;
      for (const [v, a] of at) {
        acc += a;
        if (acc >= cover * tot) {
          t = v;
          break;
        }
      }
    }
    for (let i = 0; i < n; i++) field[i] = 0.5 + 0.5 * Math.max(-1, Math.min(1, (raw[i] - t) / 0.12));
  } else {
    field.fill(0);
  }
  // fuselage-side mottle (Fw 190 A-5: 74/75 over 76 on 20-40 % of the sides)
  const mot = new Float32Array(n);
  if (scheme.sideMottle) {
    const f = scheme.sideMottle.feature || 0.24;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        mot[py * size + px] = fbm2(world(px) / f + 20, world(py) / f + 20, seed + 41, 3, 1e6, 1e6);
      }
    }
    rankUniform(mot);
    const t = 1 - (scheme.sideMottle.coverage != null ? scheme.sideMottle.coverage : 0.3);
    for (let i = 0; i < n; i++) mot[i] = 0.5 + 0.5 * Math.max(-1, Math.min(1, (mot[i] - t) / 0.15));
  }
  for (let i = 0; i < n; i++) {
    data[i * 4] = Math.round(field[i] * 255);
    data[i * 4 + 1] = Math.round(mot[i] * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { tex, data, size, S };
}

const AF_VS_HEAD = `#include <common>
      attribute vec3 aAir;
      attribute vec3 aAirN;
      attribute vec4 aMark;
      varying vec3 vAir;
      varying vec3 vAirN;
      varying vec4 vMark;
      varying vec3 vAfPos;
      varying vec3 vAfNrm;
      varying vec3 vAfBX;
      varying vec3 vAfBY;
      varying vec3 vAfBZ;`;

const AF_VS_BODY = `#include <begin_vertex>
      vAir = aAir;
      vAirN = aAirN;
      vMark = aMark;
      vAfPos = position;
      vAfNrm = normal;
      mat3 afR = mat3(1.0);
      #ifdef USE_SKINNING
        afR = mat3(skinMatrix);
      #endif
      vAfBX = normalMatrix * (afR * vec3(1.0, 0.0, 0.0));
      vAfBY = normalMatrix * (afR * vec3(0.0, 1.0, 0.0));
      vAfBZ = normalMatrix * (afR * vec3(0.0, 0.0, 1.0));`;

const AF_FS_HEAD = `#include <common>
      uniform sampler2D uAfDetail;
      uniform sampler2D uAfNormal;
      uniform float uAfTile;
      uniform sampler2D uAfPat;
      uniform sampler2D uAfIns;
      uniform highp sampler2D uAfTab;
      uniform vec3 uAfUp0;
      uniform vec3 uAfUp1;
      uniform vec3 uAfLow;
      uniform vec4 uAfSch;
      uniform vec4 uAfSch2;
      uniform vec4 uAfNmf;
      uniform vec3 uAfNmfCol;
      uniform vec3 uAfPuttyCol;
      uniform vec4 uAfBandA[6];
      uniform vec4 uAfBandB[6];
      uniform vec3 uAfBandC[6];
      uniform int uAfBandN;
      uniform vec4 uAfInsA[10];
      uniform vec4 uAfInsB[10];
      uniform vec4 uAfInsC[10];
      uniform int uAfInsN;
      uniform vec4 uAfExhA;
      uniform vec4 uAfExhB;
      uniform vec4 uAfGun[8];
      uniform int uAfGunN;
      uniform vec4 uAfWalk;
      uniform vec4 uAfSill;
      uniform vec4 uAfSill2;
      uniform vec4 uAfChip;
      uniform vec4 uAfOil;
      uniform vec4 uAfLe;
      uniform vec4 uAfProp;
      uniform vec3 uAfTip;
      varying vec3 vAir;
      varying vec3 vAirN;
      varying vec4 vMark;
      varying vec3 vAfPos;
      varying vec3 vAfNrm;
      varying vec3 vAfBX;
      varying vec3 vAfBY;
      varying vec3 vAfBZ;
      ${GLSL_NOISE}
      vec3 afTriW() {
        vec3 w = abs(normalize(vAfNrm));
        w = pow(w, vec3(4.0));
        return w / max(w.x + w.y + w.z, 1e-4);
      }
      vec4 afTri(sampler2D t, vec3 w, vec3 p) {
        return texture2D(t, p.zy) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z;
      }`;

const AF_FS_MAP = `
      vec3 afP = vAir;
      vec3 afN = normalize(vAirN);
      int afC = int(vMark.x + 0.5);
      vec3 afW = afTriW();
      vec3 afTP = vAfPos / uAfTile;
      vec4 afD = afTri(uAfDetail, afW, afTP);
      vec3 afDPx = dFdx(afP);
      vec3 afDPy = dFdy(afP);
      // both projections of the scheme pattern, in uniform control flow
      vec4 afPl = texture2D(uAfPat, afP.xz * uAfSch2.z + 0.5);
      vec4 afSd = texture2D(uAfPat, vec2(afP.y, afP.z) * uAfSch2.z + 0.5);
      float afWPlan = smoothstep(0.35, 0.65, abs(afN.y));
      float afField = mix(afSd.r, afPl.r, afWPlan);
      float afFw = max(fwidth(afField), uAfSch.z);
      float afM = smoothstep(0.5 - afFw, 0.5 + afFw, afField);
      float afMotFw = max(fwidth(afSd.g), uAfSch2.y);
      float afMot = smoothstep(0.5 - afMotFw, 0.5 + afMotFw, afSd.g);
      // the class table (a 16 x 2 float texture, not 32 uniform vectors: the
      // fragment uniform budget is 224 vectors on the weakest WebGL2 parts)
      vec4 afT0 = texelFetch(uAfTab, ivec2(clamp(afC, 0, ${AF_N - 1}), 0), 0);
      vec4 afT1 = texelFetch(uAfTab, ivec2(clamp(afC, 0, ${AF_N - 1}), 1), 0);
      vec3 afCol = afT0.rgb;
      float afRgh = afT1.x;
      float afMtl = afT1.y;
      float afNK = afT1.z;
      bool afPaint = afC <= 2;
      float afIns = 0.0;
      if (afPaint) {
        vec3 upCol = uAfSch.w > 0.5 ? mix(uAfUp0, uAfUp1, afM) : uAfUp0;
        float up = 0.0;
        if (afC == 0) {
          float yd = uAfSch.x + uAfSch.y * afP.z;
          up = smoothstep(yd - 0.025, yd + 0.025, afP.y);
          if (uAfSch2.x > 0.0) {
            // sides and fin in the lower colour under a mottle of the upper
            // two, which thins out down the flank; the splinter only on what
            // faces the sky above the spine line. The mottle was sprayed thin,
            // so it veils the 76 by its strength (uAfSch2.x) rather than
            // covering it: a speckle, not a dalmatian.
            float side = 1.0 - smoothstep(0.35, 0.6, afN.y);
            float zone = smoothstep(uAfSch.x - 0.75, uAfSch.x - 0.45, afP.y);
            upCol = mix(upCol, mix(uAfLow, mix(uAfUp0, uAfUp1, afM), afMot * zone * uAfSch2.x), side);
            up = mix(up, 1.0, side);
          }
        } else if (afC == 1) {
          up = smoothstep(-0.15, 0.15, afN.y);
        }
        afCol = mix(uAfLow, upCol, up);
        if (uAfSch2.w > 0.5) {
          // V-06 natural metal: aluminium, roughness varying panel to panel
          afCol = uAfNmfCol;
          afMtl = 1.0;
          afRgh = uAfNmf.x + uAfNmf.y * (floor(afD.b * 8.0 + 0.5) / 4.0 - 1.0);
          if (afC == 1 && vMark.w < 0.5 && vMark.y >= 0.0 && vMark.y < uAfNmf.z) {
            // puttied, silver-lacquered laminar-flow nose of the wing
            afCol = uAfPuttyCol;
            afMtl = 0.6;
            afRgh = uAfNmf.w;
          }
        }
        for (int i = 0; i < 6; i++) {
          if (i >= uAfBandN) break;
          vec4 bA = uAfBandA[i];
          vec4 bB = uAfBandB[i];
          int k = int(bB.x + 0.5);
          float w = 0.0;
          if (k == 1 && afC != 1) w = step(bA.x, afP.z) * step(afP.z, bA.y);
          else if (k == 3 && afC == 0) w = step(bA.x, afP.z) * step(afP.z, bA.y) * step(abs(afP.x), bA.z) * step(bA.w, afN.y);
          else if (k == 4 && afC == 1 && vMark.w < 0.5) w = step(0.0, vMark.y) * step(vMark.y, bA.x) * step(bA.z, vMark.z) * step(vMark.z, bA.w);
          if (w > 0.5) {
            afCol = uAfBandC[i];
            afRgh = bB.y;
            afMtl = bB.z;
          }
        }
        // V-09: the national markings, painted into the coat
        for (int i = 0; i < 10; i++) {
          if (i >= uAfInsN) break;
          vec4 iA = uAfInsA[i];
          vec4 iB = uAfInsB[i];
          // packed (x flags: bit0 side axis, bit1 mirror, bits2-4 classes,
          // bits5+ minimum facing x100; y facing; z height; w depth)
          vec4 iP = uAfInsC[i];
          int iF = int(iP.x + 0.5);
          vec4 iC = vec4(float(iF & 1), iP.y, float((iF >> 1) & 1), iP.z);
          vec4 iD = vec4(iP.w, float((iF >> 2) & 7), float(iF >> 5) * 0.01, 0.0);
          int mask = (iF >> 2) & 7;
          int cbit = afC == 0 ? 1 : (afC == 1 ? 2 : 4);
          if ((mask & cbit) == 0) continue;
          vec3 p = afP;
          vec3 nn = afN;
          vec3 gx = afDPx;
          vec3 gy = afDPy;
          if (iC.z > 0.5 && p.x < 0.0) {
            p.x = -p.x;
            nn.x = -nn.x;
            gx.x = -gx.x;
            gy.x = -gy.x;
          }
          vec2 q;
          vec2 qx;
          vec2 qy;
          float face;
          float dep;
          if (iC.x < 0.5) {
            q = vec2(0.5 - (p.x - iA.x) / iA.w, 0.5 + (p.z - iA.z) / iC.w);
            qx = vec2(-gx.x / iA.w, gx.z / iC.w);
            qy = vec2(-gy.x / iA.w, gy.z / iC.w);
            face = nn.y * iC.y;
            dep = abs(p.y - iA.y);
          } else {
            q = vec2(0.5 - (p.z - iA.z) / iA.w, 0.5 + (p.y - iA.y) / iC.w);
            qx = vec2(-gx.z / iA.w, gx.y / iC.w);
            qy = vec2(-gy.z / iA.w, gy.y / iC.w);
            face = abs(iC.y) < 0.5 ? abs(nn.x) : nn.x * iC.y;
            dep = abs(abs(p.x) - iA.x);
          }
          if (face < iD.z || dep > iD.x || q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) continue;
          vec2 rs = iB.zw - iB.xy;
          vec4 t = textureGrad(uAfIns, iB.xy + q * rs, qx * rs, qy * rs);
          float a = t.a * smoothstep(iD.z, iD.z + 0.15, face);
          afCol = mix(afCol, t.rgb, a);
          afIns = max(afIns, a);
        }
        afRgh = mix(afRgh, max(afRgh, 0.6), afIns);
        afMtl = mix(afMtl, 0.0, afIns);
        // ---- V-12 weathering zones ----
        // A1 exhaust stain, aft of the stacks along the fuselage sides
        if (uAfExhB.z > 0.0 && afC == 0) {
          float dz = uAfExhA.x - afP.z;
          float t = dz / uAfExhA.y;
          float outw = step(0.0, afP.x * afN.x) * smoothstep(0.15, 0.45, abs(afN.x));
          float yc = uAfExhA.z - uAfExhB.w * max(dz, 0.0);
          float dy = abs(afP.y - yc) / (uAfExhA.w * (1.0 + 0.9 * clamp(t, 0.0, 1.0)));
          float streak = 0.45 + 0.55 * zNoise(vec3(afP.z * 0.7, afP.y * 18.0, 1.7));
          float w = (1.0 - smoothstep(0.5, 1.0, dy)) * smoothstep(-0.04, 0.04, t)
            * (1.0 - smoothstep(0.55, 1.0, t)) * streak * outw * uAfExhB.z;
          vec3 st = mix(mix(vec3(0.323, 0.296, 0.254), vec3(0.040, 0.038, 0.036), smoothstep(0.08, 0.55, t)),
            vec3(0.040, 0.038, 0.036), uAfExhB.y);
          afCol = mix(afCol, st, w * 0.9);
          afRgh = mix(afRgh, 0.85, w);
          afMtl = mix(afMtl, 0.0, w);
        }
        // A2 gun soot, 0.3-0.8 m streaks behind the ports
        if (afC == 1 && vMark.w < 0.5 && uAfGunN > 0) {
          float s = 0.0;
          for (int i = 0; i < 8; i++) {
            if (i >= uAfGunN) break;
            vec4 g = uAfGun[i];
            float dz = g.z - afP.z;
            float lat = abs(abs(afP.x) - g.x);
            float wdt = g.w * (1.6 + 2.2 * clamp(dz, 0.0, 1.0));
            s += step(0.0, dz) * (1.0 - smoothstep(0.3, 0.8, dz)) * (1.0 - smoothstep(wdt * 0.6, wdt, lat))
              * step(abs(afP.y - g.y), 0.45);
          }
          s = clamp(s, 0.0, 1.0) * (0.6 + 0.4 * zNoise(afP * vec3(30.0, 30.0, 3.0)));
          afCol = mix(afCol, vec3(0.045, 0.043, 0.040), s * 0.85);
          afRgh = mix(afRgh, 0.8, s);
          afMtl = mix(afMtl, 0.0, s);
        }
        // A3 walkway and sill, A4 leading edges: chips to bare aluminium
        if (uAfSch2.w < 0.5) {
          float thr = 2.0;
          if (afC == 1 && vMark.w < 0.5 && afP.x > uAfWalk.x && afP.x < uAfWalk.y
            && afP.z > uAfWalk.z && afP.z < uAfWalk.w && afN.y > 0.4) thr = uAfChip.x;
          if (afC == 0 && afP.z > uAfSill.x && afP.z < uAfSill.y && afP.y > uAfSill.z
            && afP.y < uAfSill.w && abs(afP.x) < uAfSill2.x) thr = uAfChip.y;
          if (afC == 1 && vMark.y >= 0.0 && vMark.y < uAfLe.x) thr = min(thr, uAfChip.z);
          float cn = 0.55 * zNoise(afP * 41.0) + 0.45 * zNoise(afP * 97.0 + 3.1);
          float chip = step(thr, cn);
          afCol = mix(afCol, vec3(0.58, 0.59, 0.60), chip);
          afMtl = mix(afMtl, 1.0, chip);
          afRgh = mix(afRgh, 0.35, chip);
        }
        // A5 oil along the belly from the engine bay
        if (afC != 1 && afN.y < -0.3 && uAfOil.w > 0.0) {
          float dz = uAfOil.x - afP.z;
          float t = dz / uAfOil.y;
          float w = smoothstep(-0.05, 0.05, t) * (1.0 - smoothstep(0.6, 1.0, t))
            * (1.0 - smoothstep(uAfOil.z * 0.6, uAfOil.z, abs(afP.x)));
          w *= smoothstep(0.45, 0.75, zNoise(vec3(afP.x * 9.0, afP.y * 4.0, afP.z * 0.8))) * uAfOil.w;
          afCol = mix(afCol, vec3(0.024, 0.018, 0.013), w);
          afRgh = mix(afRgh, 0.28, w);
          afMtl = mix(afMtl, 0.0, w);
        }
      } else if (afC == 10) {
        // the blade: paint, and the tip ring by radius from the prop axis
        float r = length(afP.xy) / max(uAfProp.x, 1e-3);
        if (uAfProp.z > 0.5 && r > uAfProp.y) afCol = uAfTip;
      }
      float afLine = afPaint ? afD.a : 0.0;
      afCol *= (0.92 + 0.16 * afD.r) * (1.0 - 0.14 * afLine * (1.0 - afMtl));
      float afMod = mix(0.85 + 0.30 * afD.g, 0.97 + 0.06 * afD.g, step(0.99, afMtl));
      afRgh = clamp(afRgh * afMod + 0.12 * afLine * afMtl, 0.03, 1.0);
      diffuseColor.rgb *= afCol;`;

const AF_FS_NORMAL = `{
        vec3 tnX = texture2D(uAfNormal, afTP.zy).xyz * 2.0 - 1.0;
        vec3 tnY = texture2D(uAfNormal, afTP.xz).xyz * 2.0 - 1.0;
        vec3 tnZ = texture2D(uAfNormal, afTP.xy).xyz * 2.0 - 1.0;
        tnX.xy *= afNK;
        tnY.xy *= afNK;
        tnZ.xy *= afNK;
        vec3 gn = normalize(vAfNrm);
        vec3 nX = vec3(tnX.xy + gn.zy, abs(tnX.z) * gn.x);
        vec3 nY = vec3(tnY.xy + gn.xz, abs(tnY.z) * gn.y);
        vec3 nZ = vec3(tnZ.xy + gn.xy, abs(tnZ.z) * gn.z);
        vec3 objN = normalize(nX.zyx * afW.x + nY.xzy * afW.y + nZ.xyz * afW.z);
        normal = normalize(objN.x * vAfBX + objN.y * vAfBY + objN.z * vAfBZ);
      }`;

function linV3(hex) {
  const [r, g, b] = hexToLinear(hex);
  return new THREE.Vector3(r, g, b);
}
// bible A6: an upper surface fades +5-15 % in luminance and goes slightly
// chalky (saturation x0.85) against the sheltered underside
function fadedV3(hex, fade) {
  const [r, g, b] = hexToLinear(hex);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = 1 + (fade || 0);
  const mixC = (c) => (y + (c - y) * 0.85) * k;
  return new THREE.Vector3(mixC(r), mixC(g), mixC(b));
}

const afTexOf = new WeakMap();
const detailData = new WeakMap();
const patData = new WeakMap();
const propDiscData = new WeakMap();
// The CPU-side textures behind an airframe material, for tests and tools.
export function airframeTextures(material) {
  return afTexOf.get(material) || null;
}

let afDummy = null;
function afDummyTex() {
  if (afDummy) return afDummy;
  afDummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  afDummy.needsUpdate = true;
  markShared(afDummy);
  return afDummy;
}

// The airframe material for one aircraft type.
//   def.key        cache key (spec id + quality is added here)
//   def.classes    [{ hex, rough, metal, normal }] indexed by AF_CLASS
//   def.scheme     { upper:[hex, hex?], pattern, lower, demarcY, demarcSlope,
//                    edge, coverage, feature, fade, sideMottle, bands:[...] }
//                  bands: { kind: 'ring' z0 z1 | 'top' z0 z1 halfW minNy |
//                           'le' chord u0 u1, hex, rough, metal }
//   def.extent     half size of the plan square the pattern covers, metres
//   def.footprint  [[x, z, planArea], ...] the painted upper surfaces, so the
//                  pattern's coverage is exact on the airframe (optional)
//   def.nmf        { hex, rough:[lo, hi], puttyHex, puttyChord, puttyRough }
//   def.insignia   { texture, list:[{ rect, axis:'plan'|'side', x, y, z, w, h,
//                    facing, mirror, depth, classes }] }
//   def.zones      { exhaust, guns, walkway, sill, oil, le, chips } (V-12)
//   def.prop       { R, tipFrom, tipHex }
export function airframeMaterial(def) {
  const key = `airframe|${def.key}|${quality}`;
  let m = matCache.get(key);
  if (m) return m;
  const size = TEX_SIZE[quality];
  const det = cachedTex(`afdetail|${quality}`, () => {
    const d = paintAirframeDetail(size, 7711);
    detailData.set(d.detail, { data: d.data, size: d.size });
    return { detail: d.detail, normal: d.normal };
  });
  const sch = def.scheme || {};
  const S = def.extent || 8;
  const patSize = quality === 'high' ? 512 : 256;
  const pat = sch.pattern && sch.pattern !== 'mono' || sch.sideMottle
    ? cachedTex(`afpat|${def.key}|${patSize}`, () => {
      const p = paintSchemePattern(sch, S, patSize, seedFromKey(def.key), def.footprint || null);
      patData.set(p.tex, { data: p.data, size: p.size, S });
      return { tex: p.tex };
    }).tex
    : afDummyTex();

  const cols = [];
  const pbr = [];
  for (let i = 0; i < AF_N; i++) {
    const c = (def.classes && def.classes[i]) || { hex: 0x808080, rough: 0.6, metal: 0 };
    cols.push(linV3(c.hex));
    pbr.push(new THREE.Vector3(c.rough, c.metal || 0, c.normal != null ? c.normal : 0.7));
  }
  // row 0: linear colour per class, row 1: roughness, metalness, normal gain
  const tabData = new Float32Array(AF_N * 2 * 4);
  for (let i = 0; i < AF_N; i++) {
    tabData.set([cols[i].x, cols[i].y, cols[i].z, 1], i * 4);
    tabData.set([pbr[i].x, pbr[i].y, pbr[i].z, 0], (AF_N + i) * 4);
  }
  const tab = new THREE.DataTexture(tabData, AF_N, 2, THREE.RGBAFormat, THREE.FloatType);
  tab.magFilter = THREE.NearestFilter;
  tab.minFilter = THREE.NearestFilter;
  tab.generateMipmaps = false;
  tab.colorSpace = THREE.NoColorSpace;
  tab.needsUpdate = true;
  markShared(tab);
  const upper = sch.upper || [sch.lower || 0x808080];
  const fade = sch.fade || 0;
  const bands = (sch.bands || []).slice(0, 6);
  const bandA = [];
  const bandB = [];
  const bandC = [];
  const KIND = { ring: 1, top: 3, le: 4 };
  for (let i = 0; i < 6; i++) {
    const b = bands[i];
    if (!b) {
      bandA.push(new THREE.Vector4());
      bandB.push(new THREE.Vector4());
      bandC.push(new THREE.Vector3());
      continue;
    }
    if (b.kind === 'le') bandA.push(new THREE.Vector4(b.chord, 0, b.u0, b.u1));
    else if (b.kind === 'top') bandA.push(new THREE.Vector4(b.z0, b.z1, b.halfW, b.minNy));
    else bandA.push(new THREE.Vector4(b.z0, b.z1, 0, 0));
    bandB.push(new THREE.Vector4(KIND[b.kind] || 1, b.rough != null ? b.rough : 0.65, b.metal || 0, 0));
    bandC.push(b.fade ? fadedV3(b.hex, fade) : linV3(b.hex));
  }
  const ins = def.insignia || { list: [] };
  const list = (ins.list || []).slice(0, 10);
  const insA = [];
  const insB = [];
  const insC = [];
  for (let i = 0; i < 10; i++) {
    const p = list[i];
    if (!p) {
      insA.push(new THREE.Vector4());
      insB.push(new THREE.Vector4());
      insC.push(new THREE.Vector4());
      continue;
    }
    insA.push(new THREE.Vector4(p.x, p.y, p.z, p.w));
    insB.push(new THREE.Vector4(p.rect.u0, p.rect.v0, p.rect.u1, p.rect.v1));
    // flags: bit0 side axis, bit1 mirrored, bits2-4 classes, bits5+ minFace x100
    const minFace = Math.round(Math.max(0, Math.min(1, p.minFace != null ? p.minFace : 0.2)) * 100);
    const flags = (p.axis === 'side' ? 1 : 0) | (p.mirror ? 2 : 0) | (((p.classes || 3) & 7) << 2) | (minFace << 5);
    insC.push(new THREE.Vector4(flags, p.facing || 0, p.h, p.depth || 0.4));
  }
  const z = def.zones || {};
  const ex = z.exhaust || null;
  const guns = (z.guns || []).slice(0, 8);
  const gunV = [];
  for (let i = 0; i < 8; i++) {
    const g = guns[i];
    gunV.push(g ? new THREE.Vector4(Math.abs(g.x), g.y, g.z, g.r) : new THREE.Vector4());
  }
  const wk = z.walkway || null;
  const sill = z.sill || null;
  const oil = z.oil || null;
  const le = z.le || { chord: 0.05, coverage: 0.05 };
  const nmf = def.nmf || null;
  const prop = def.prop || { R: 1.5, tipFrom: 2, tipHex: 0 };

  const uniforms = {
    uAfDetail: { value: det.detail },
    uAfNormal: { value: det.normal },
    uAfTile: { value: def.tile || 2.4 },
    uAfPat: { value: pat },
    uAfIns: { value: ins.texture || afDummyTex() },
    uAfTab: { value: tab },
    uAfUp0: { value: fadedV3(upper[0], fade) },
    uAfUp1: { value: fadedV3(upper[1] != null ? upper[1] : upper[0], fade) },
    uAfLow: { value: linV3(sch.lower != null ? sch.lower : upper[0]) },
    uAfSch: {
      value: new THREE.Vector4(
        sch.demarcY != null ? sch.demarcY : -0.2, sch.demarcSlope || 0, sch.edge != null ? sch.edge : 0.01,
        upper.length > 1 && sch.pattern && sch.pattern !== 'mono' ? 1 : 0,
      ),
    },
    uAfSch2: {
      value: new THREE.Vector4(
        sch.sideMottle ? (sch.sideMottle.strength != null ? sch.sideMottle.strength : 1) : 0,
        sch.sideMottle ? (sch.sideMottle.edge || 0.04) : 0.04, 1 / (2 * S), nmf ? 1 : 0,
      ),
    },
    uAfNmf: {
      value: nmf
        ? new THREE.Vector4((nmf.rough[0] + nmf.rough[1]) / 2, (nmf.rough[1] - nmf.rough[0]) / 2, nmf.puttyChord || 0, nmf.puttyRough || 0.5)
        : new THREE.Vector4(),
    },
    uAfNmfCol: { value: linV3(nmf ? nmf.hex : 0xe3e5e6) },
    uAfPuttyCol: { value: linV3(nmf && nmf.puttyHex != null ? nmf.puttyHex : 0xc9ccce) },
    uAfBandA: { value: bandA },
    uAfBandB: { value: bandB },
    uAfBandC: { value: bandC },
    uAfBandN: { value: bands.length },
    uAfInsA: { value: insA },
    uAfInsB: { value: insB },
    uAfInsC: { value: insC },
    uAfInsN: { value: list.length },
    uAfExhA: { value: ex ? new THREE.Vector4(ex.z, ex.len, ex.y, ex.halfH) : new THREE.Vector4() },
    uAfExhB: { value: ex ? new THREE.Vector4(Math.abs(ex.x || 0), ex.soot || 0, ex.strength != null ? ex.strength : 1, ex.droop || 0) : new THREE.Vector4() },
    uAfGun: { value: gunV },
    uAfGunN: { value: guns.length },
    uAfWalk: { value: wk ? new THREE.Vector4(wk.x0, wk.x1, wk.z0, wk.z1) : new THREE.Vector4(1e5, -1e5, 0, 0) },
    uAfSill: { value: sill ? new THREE.Vector4(sill.z0, sill.z1, sill.y0, sill.y1) : new THREE.Vector4(1e5, -1e5, 0, 0) },
    uAfSill2: { value: new THREE.Vector4(sill ? sill.halfW : 0, 0, 0, 0) },
    uAfChip: {
      value: new THREE.Vector4(
        afChipThreshold(wk ? wk.coverage : 0), afChipThreshold(sill ? sill.coverage : 0),
        afChipThreshold(le.coverage), 0,
      ),
    },
    uAfOil: { value: oil ? new THREE.Vector4(oil.z, oil.len, oil.halfW, oil.strength != null ? oil.strength : 1) : new THREE.Vector4() },
    uAfLe: { value: new THREE.Vector4(le.chord, le.coverage, 0, 0) },
    uAfProp: { value: new THREE.Vector4(prop.R, prop.tipFrom != null ? prop.tipFrom : 2, prop.tipHex != null ? 1 : 0, 0) },
    uAfTip: { value: linV3(prop.tipHex != null ? prop.tipHex : 0) },
  };

  m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  m.name = `airframe ${def.key}`;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', AF_VS_HEAD)
      .replace('#include <begin_vertex>', AF_VS_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', AF_FS_HEAD)
      .replace('#include <map_fragment>', AF_FS_MAP)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = afRgh;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = afMtl;')
      .replace('#include <normal_fragment_maps>', AF_FS_NORMAL);
    m.userData.shader = shader;
  };
  m.customProgramCacheKey = () => 'airframe1';
  m.userData.airframe = { uniforms, def };
  afTexOf.set(m, {
    detail: detailData.get(det.detail) || null,
    pattern: patData.get(pat) || null,
    // the class table the shader reads (uAfTab), as vectors
    classes: { cols, pbr },
    uniforms,
  });
  markShared(m);
  matCache.set(key, m);
  return m;
}

// V-08: clear canopy glass. Plain transparency multiplies the specular by
// alpha, which is why the old glass needed a 0.34 blue tint to show at all.
// Here the surface is a clear dielectric: what it lets through is
// (1 - opacity - F) of the background, and what it reflects is added on top,
// F from Schlick at F0 0.04 — so a near-colourless pane at opacity 0.10 still
// throws the sky back at a grazing angle. Chains whatever onBeforeCompile the
// material already carries (the smoke veil, combat/effects.js), and honours
// its veil: behind a smoke screen the reflection fades with the glass.
const GLASS_OUT = `#ifdef OPAQUE
        diffuseColor.a = 1.0;
      #endif
      float glVeil = opacity > 0.0 ? clamp(diffuseColor.a / opacity, 0.0, 1.0) : 1.0;
      float glNV = clamp(dot(normal, geometryViewDir), 0.0, 1.0);
      float glF = (0.04 + 0.96 * pow(1.0 - glNV, 5.0)) * glVeil;
      float glA = clamp(diffuseColor.a + glF, 0.0, 1.0);
      gl_FragColor = vec4((totalDiffuse * diffuseColor.a + totalSpecular * glVeil) / max(glA, 1e-4), glA);`;
export function applyClearGlass(mat) {
  if (!mat || (mat.userData && mat.userData.clearGlass)) return mat;
  const own = (k) => Object.prototype.hasOwnProperty.call(mat, k);
  const prev = own('onBeforeCompile') ? mat.onBeforeCompile : null;
  const prevKey = own('customProgramCacheKey') ? String(mat.customProgramCacheKey()) : '';
  mat.onBeforeCompile = function clearGlassPatch(shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', GLASS_OUT);
  };
  mat.customProgramCacheKey = () => `${prevKey}|clearglass1`;
  mat.userData = mat.userData || {};
  mat.userData.clearGlass = true;
  mat.needsUpdate = true;
  return mat;
}

// A-01: the propeller disc as a photograph records it. Each texel's alpha is
// the blade solidity at that radius, N.c(r)/(2.pi.r) — the fraction of the
// circle the blades cover — in the blade paint, with the painted tip ring
// where the spec has one and, on the Fw 190, the cooling fan's annulus. Lit
// and transparent; the per-aircraft opacity (0..1) is the spin blend. One
// texture per propeller, cached; a fresh material per aircraft, because each
// one's opacity follows its own engine.
//   def: { key, blades, R, discR, hubR, chord(r)->m, bladeHex, tipHex, tipFrom,
//          rough, fan: { blades, inner, outer, chord, hex } }
export function propDiscMaterial(def) {
  const maps = cachedTex(`propdisc|${def.key}`, () => {
    const size = 256;
    const data = new Uint8Array(size * size * 4);
    const blade = srgbBytes(def.bladeHex);
    const tip = def.tipHex != null ? srgbBytes(def.tipHex) : null;
    const fan = def.fan || null;
    const fanC = fan ? srgbBytes(fan.hex) : null;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = ((x + 0.5) / size) * 2 - 1;
        const dy = ((y + 0.5) / size) * 2 - 1;
        const r = Math.hypot(dx, dy) * def.discR;
        let a = 0;
        let c = blade;
        if (r >= def.hubR && r <= def.R) {
          a = (def.blades * def.chord(r)) / (2 * Math.PI * Math.max(r, 1e-3));
          if (tip && r >= def.tipFrom * def.R) c = tip;
        }
        if (fan && r >= fan.inner && r <= fan.outer) {
          const af = (fan.blades * fan.chord) / (2 * Math.PI * r);
          c = a > 0 ? c : fanC;
          a = Math.min(1, a + af * 0.85);
        }
        a = Math.min(1, a);
        const i = (y * size + x) * 4;
        data[i] = Math.round(c.r * 255);
        data[i + 1] = Math.round(c.g * 255);
        data[i + 2] = Math.round(c.b * 255);
        data[i + 3] = Math.round(a * 255);
      }
    }
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    propDiscData.set(t, { data, size, discR: def.discR });
    return { map: t };
  });
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: maps.map,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
    roughness: def.rough != null ? def.rough : 0.6,
    metalness: 0,
  });
  m.name = `propDisc ${def.key}`;
  return m;
}
export function propDiscTexture(material) {
  return material && material.map ? propDiscData.get(material.map) || null : null;
}

// V-09 tank decals and V-08 vision-block glass: one material for every
// marking on every tank. The atlas is read through its own sampler rather
// than `map`, so the wreck twin in tankEntity.destroy() treats it as an
// untextured fitting and burns it to soot, as fire does to stencilled paint.
// Per-vertex: colour (the marking's tint; white glyphs take it) and aMkRgh
// (roughness: matt paint, or polished glass). Alpha-tested, 2 mm proud of the
// plate and pulled forward in depth.
export function markingsMaterial(atlasTex) {
  const key = 'markings';
  let m = matCache.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    alphaTest: 0.5,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  m.name = 'markings';
  const u = { uMkAtlas: { value: atlasTex } };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aMkUv;
        attribute float aMkRgh;
        varying vec2 vMkUv;
        varying float vMkRgh;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vMkUv = aMkUv;
        vMkRgh = aMkRgh;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uMkAtlas;
        varying vec2 vMkUv;
        varying float vMkRgh;`)
      .replace('#include <map_fragment>', `diffuseColor *= texture2D(uMkAtlas, vMkUv);`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vMkRgh;');
    m.userData.shader = shader;
  };
  m.customProgramCacheKey = () => 'markings1';
  markShared(m);
  matCache.set(key, m);
  return m;
}

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

// Battles are torn down and rebuilt many times per session. These caches are
// deliberately global and survive that — regenerating half a megabyte of canvas
// textures between every match would stutter badly. Only a quality change or a
// full teardown should call this.
// Everything above is CACHED AND SHARED: one armour material serves every
// Sherman on the map and survives from one battle into the next. The battle
// classes tear a scene down with a blanket scene.traverse(...material.dispose()),
// which would free the programs and textures of these shared materials and force
// three to recompile and re-upload all of them on the next battle. Stamping them
// lets that sweep skip anything it does not actually own.
const SHARED = Symbol.for('steelSkies.sharedResource');

// Stamp anything (geometry, material, texture) that is cached across battles.
export function markShared(obj) {
  if (obj) {
    obj.userData = obj.userData || {};
    obj.userData.shared = true;
    obj[SHARED] = true;
  }
  return obj;
}

// Stamp a cached geometry the vehicle builders clone from.
export function markSharedGeometry(geo) { return markShared(geo); }

// True for anything the factory owns and reuses. A teardown sweep must leave
// these alone; disposeMaterials() is the only correct way to free them.
export function isSharedResource(obj) {
  return !!(obj && (obj[SHARED] || (obj.userData && obj.userData.shared)));
}

// Dispose every mesh under `root` that the scene genuinely owns, skipping any
// shared geometry or material. This is what a battle teardown should call.
export function disposeOwned(root) {
  if (!root || typeof root.traverse !== 'function') return;
  root.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine && !o.isSprite) return;
    if (o.geometry && !isSharedResource(o.geometry)) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) if (m && !isSharedResource(m)) m.dispose();
  });
}

export function disposeMaterials() {
  for (const maps of texCache.values()) {
    for (const t of Object.values(maps)) t?.dispose?.();
  }
  texCache.clear();
  for (const m of matCache.values()) m?.dispose?.();
  matCache.clear();
}
