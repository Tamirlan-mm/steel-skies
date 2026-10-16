import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { clamp, rand } from '../core/utils.js';
import * as terrainNS from '../world/terrain.js';
import { activePreset, planckianLinear } from '../world/presets.js';
import { getMaterialQuality, markShared } from '../core/materials.js';
import { blastOf, BLAST_KG, REF_KG } from './blast.js';

const { terrainHeight } = terrainNS;
// the per-point surface (AV-03); a namespace read so this file still loads
// against a terrain.js that predates it
const terrainSurface = typeof terrainNS.terrainSurface === 'function' ? terrainNS.terrainSurface : null;

const HIDDEN_Y = -9999;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// colour convention
// ---------------------------------------------------------------------------
//
// A particle's colour reaches the GPU as a vertex colour, and three treats
// vertex colours as LINEAR: the hex handed to spawn() is divided by 255 and
// used as the albedo (or, additive, the radiance) as it stands. The art bible
// writes colours as sRGB hex. So a bible colour goes through lin() first —
// 0x2b2926 fuel smoke is albedo 0.022, not the 0.16 its bytes would say — and
// every colour taken from a preset (dust, ground) is sRGB and converted the
// same way. Older hand-tuned hexes in this file that were tuned by eye in the
// raw convention keep it; anything a Y band is asserted on uses lin().
function s2l(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** sRGB hex -> the linear-albedo hex the particle pools read. */
export function lin(hex) {
  const r = Math.round(s2l(((hex >> 16) & 255) / 255) * 255);
  const g = Math.round(s2l(((hex >> 8) & 255) / 255) * 255);
  const b = Math.round(s2l((hex & 255) / 255) * 255);
  return (r << 16) | (g << 8) | b;
}
/** Linear luminance Y of a pool colour (hex read as linear, as the GPU does). */
export function poolY(hex) {
  return (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255;
}
// one-entry memo for the per-frame callers (track dust hands the same hex
// sixty times a second)
let linMemoIn = -1;
let linMemoOut = 0;
function linCached(hex) {
  if (hex !== linMemoIn) {
    linMemoIn = hex;
    linMemoOut = lin(hex);
  }
  return linMemoOut;
}
// scale a pool hex by k (linear), clamped
function scaleHex(hex, k) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}
// a + (b - a) * t, per channel
function mixHex(a, b, t) {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bb = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | bb;
}

// Colours the Accept lines measure (backlog X-02, X-03, X-05, AV-04), each a
// bible sRGB hex turned into the linear albedo the pools take.
const SOOT_TNT = lin(0x423d38);     // TNT soot core, Y .048 (bible .04-.08)
const PROPELLANT = lin(0xc2c0ba);   // propellant smoke, Y .53 (bible .45-.60)
const FUEL_SMOKE = lin(0x2b2926);   // fuel smoke at the source, Y .022 (.02-.05)
const FUEL_SMOKE_THIN = lin(0x4a453d); // higher up the column, Y .06
const DIESEL_PUFF = lin(0x393836);  // V-2 diesel on a throttle stab, Y .040 (.03-.05)
const PETROL_WISP = lin(0x9e9d99);  // a petrol engine's grey wisp, Y .34
const BLAST_SMOKE = lin(0x30302c);  // black smoke off a fireball, Y .028

// ---------------------------------------------------------------------------
// deterministic noise
// ---------------------------------------------------------------------------
//
// Only used at load time, to paint the sprite sheets. Seeded rather than
// Math.random so a crater looks the same on every machine and every reload —
// a player who learns to read "that is a 152 mm hole" should keep being right.

function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 1274126177;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

function smoothT(t) {
  return t * t * (3 - 2 * t);
}

function vnoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smoothT(x - xi);
  const v = smoothT(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// Tiling fbm. `period` wraps the lattice so a sprite drawn in polar coordinates
// has no seam where the angle comes back round to zero.
function fbm2(x, y, seed, octaves = 4, period = 8) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    const p = period * freq;
    sum += amp * vnoise(((x * freq) % p + p) % p, ((y * freq) % p + p) % p, seed + o * 131);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function canvasOf(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ---------------------------------------------------------------------------
// particle sprites
// ---------------------------------------------------------------------------
//
// An untextured billboard is a hard square, which is fine for a single tracer
// spark and very much not fine for a smoke screen made of three hundred
// overlapping billboards, so every pool gets a procedural mask.
//
//   soft   gaussian blob, anything gaseous that wants no shape of its own
//   hard   flat core with a quick rim, sparks and tumbling debris
//   smoke  turbulent puff: radial falloff chewed up by fbm, so a smoke column
//          reads as cloud rather than as a stack of perfect circles. This is
//          the single biggest thing separating "smoke" from "grey dots".
//   fire   hot core with a ragged edge, for fireballs and muzzle flame
//   flare  bright core plus four rays, for the instant a gun goes off

const spriteCache = {};
// Alpha-weighted mean brightness of each mask, in LINEAR light — what the eye
// averages a cloud of these puffs down to. The smoke-screen volume core is
// coloured from it so the solid middle of a screen and the billboards drawn
// over it are the same grey, whatever the noise above happened to paint.
const spriteLum = {};

function sprite(kind) {
  if (spriteCache[kind] !== undefined) return spriteCache[kind];
  const S = kind === 'smoke' || kind === 'flare' ? 96 : 64;
  const canvas = canvasOf(S, S);
  if (!canvas) {
    spriteCache[kind] = null;
    return null;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // No 2d context to be had: fall back to plain square points rather than
    // taking the whole effects system down with us.
    spriteCache[kind] = null;
    return null;
  }
  const img = ctx.createImageData(S, S);
  const half = S / 2;
  const seed = kind.length * 977 + 13;
  let lumSum = 0;
  let alphaSum = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const d = Math.sqrt(dx * dx + dy * dy);
      let a = 0;
      let lum = 1;
      if (d < 1) {
        if (kind === 'hard') {
          a = clamp((1 - d) * 3.2, 0, 1);
        } else if (kind === 'smoke') {
          // polar noise: sampled on (angle, radius) so it tiles round the rim
          const ang = Math.atan2(dy, dx);
          const n = fbm2((ang / TAU + 1) * 8, d * 5, seed, 4, 8);
          const shape = Math.pow(1 - d, 1.35) * (0.42 + 1.05 * n);
          a = clamp(shape, 0, 1);
          // billowing: the lit side of a puff is where it is thickest
          lum = 0.72 + 0.55 * n;
        } else if (kind === 'fire') {
          const ang = Math.atan2(dy, dx);
          const n = fbm2((ang / TAU + 1) * 6, d * 4, seed + 41, 3, 6);
          a = clamp(Math.pow(1 - d, 1.5) * (0.75 + 0.7 * n) + (d < 0.28 ? 0.5 : 0), 0, 1);
          lum = 1;
        } else if (kind === 'flare') {
          const core = Math.pow(1 - d, 2.6);
          // four rays, so a muzzle flash has a shape instead of being a dot
          const rays = Math.pow(Math.max(Math.abs(dx), Math.abs(dy)) < 1e-4 ? 1
            : Math.max(1 - Math.abs(dy) * 7, 0) + Math.max(1 - Math.abs(dx) * 7, 0), 1.6)
            * Math.pow(1 - d, 1.7) * 0.45;
          a = clamp(core + rays, 0, 1);
        } else {
          a = Math.pow(1 - d, 1.9);
        }
      }
      const i = (y * S + x) * 4;
      const l = Math.round(clamp(lum, 0, 1) * 255);
      img.data[i] = l;
      img.data[i + 1] = l;
      img.data[i + 2] = l;
      img.data[i + 3] = Math.round(a * 255);
      // the texture is sRGB, so the GPU decodes this byte before using it
      lumSum += Math.pow(l / 255, 2.2) * a;
      alphaSum += a;
    }
  }
  spriteLum[kind] = alphaSum > 0 ? lumSum / alphaSum : 1;
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  spriteCache[kind] = tex;
  return tex;
}

// Long soft streak for tracers: bright round head at u = 1, tapering tail back
// to u = 0, gaussian across. Non-square because the shape is: 4:1 of texture
// for 4:1 of streak costs a quarter of the memory of a square one.
let tracerTex;
function tracerTexture() {
  if (tracerTex !== undefined) return tracerTex;
  const W = 128;
  const H = 32;
  const canvas = canvasOf(W, H);
  if (!canvas) {
    tracerTex = null;
    return null;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    tracerTex = null;
    return null;
  }
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const v = ((y + 0.5) / H) * 2 - 1;
      // tail: nothing at the back, full at the head, with a slight swell
      const tail = Math.pow(u, 2.4);
      const across = Math.exp(-v * v * 7);
      // the head is a hot round blob riding the front of the streak
      const hd = Math.hypot((u - 0.94) * (W / H) * 0.55, v);
      const head = Math.exp(-hd * hd * 9);
      const a = clamp(tail * across * 0.85 + head, 0, 1);
      const i = (y * W + x) * 4;
      // the core reads white and the flanks take the instance colour
      const white = clamp(head * 1.2 + tail * across * 0.25, 0, 1);
      img.data[i] = Math.round((0.55 + 0.45 * white) * 255);
      img.data[i + 1] = Math.round((0.5 + 0.5 * white) * 255);
      img.data[i + 2] = Math.round((0.45 + 0.55 * white) * 255);
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  tracerTex = t;
  return t;
}

// Soft annulus for shockwave rings. RingGeometry's uv is a square around the
// ring, so a plain radial band lands exactly where it should.
let ringTex;
function ringTexture() {
  if (ringTex !== undefined) return ringTex;
  const S = 128;
  const canvas = canvasOf(S, S);
  if (!canvas) {
    ringTex = null;
    return null;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    ringTex = null;
    return null;
  }
  const img = ctx.createImageData(S, S);
  const half = S / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const d = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      // a wave front is never a perfect circle; break it up round the rim
      const n = fbm2((ang / TAU + 1) * 10, 2.5, 733, 3, 10);
      const r0 = 0.80 + (n - 0.5) * 0.10;
      const w = 0.16 + n * 0.10;
      const band = Math.exp(-((d - r0) * (d - r0)) / (w * w));
      const inner = clamp(1 - d / r0, 0, 1) * 0.12;
      const a = clamp(band * (0.55 + 0.7 * n) + inner, 0, 1) * clamp((1 - d) * 4, 0, 1);
      const i = (y * S + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  ringTex = t;
  return t;
}

// ---------------------------------------------------------------------------
// ground decal atlas
// ---------------------------------------------------------------------------
//
// One 2x2 sheet, so every crater, scorch and dust splash on the map shares a
// single material and a single draw call. Every quadrant fades to alpha 0 at
// its border, which is what stops mip levels bleeding one into the next.
//
//   0  crater  dark bowl, bright thrown-up rim, radial ejecta rays
//   1  scorch  soft irregular soot smudge
//   2  burn    ring of char with streaks running out of it, for a big blast
//   3  splash  pale dust splatter, for a near miss that only kicked dirt

const DECAL_CRATER = 0;
const DECAL_SCORCH = 1;
const DECAL_BURN = 2;
const DECAL_SPLASH = 3;

let decalTex;
function decalAtlas() {
  if (decalTex !== undefined) return decalTex;
  const Q = 128;
  const S = Q * 2;
  const canvas = canvasOf(S, S);
  if (!canvas) {
    decalTex = null;
    return null;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    decalTex = null;
    return null;
  }
  const img = ctx.createImageData(S, S);
  for (let q = 0; q < 4; q++) {
    const ox = (q & 1) * Q;
    const oy = (q >> 1) * Q;
    const seed = 3100 + q * 617;
    for (let y = 0; y < Q; y++) {
      for (let x = 0; x < Q; x++) {
        const dx = (x + 0.5) / Q * 2 - 1;
        const dy = (y + 0.5) / Q * 2 - 1;
        const d = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        const n = fbm2((ang / TAU + 1) * 9, d * 4 + 1, seed, 4, 9);
        const grit = fbm2(x / Q * 22, y / Q * 22, seed + 55, 3, 22);
        let a = 0;
        let lum = 1;
        // every quadrant dies at its own border or the mip chain will smear
        // one decal's edge into its neighbour
        const cut = clamp((1 - d) * 3.2, 0, 1);

        if (q === DECAL_CRATER) {
          const rim = 0.60 + (n - 0.5) * 0.18;
          const bowl = clamp(1 - d / rim, 0, 1);
          // ejecta: spokes of thrown soil reaching past the lip
          const rays = clamp((n - 0.52) * 3.4, 0, 1) * clamp(1 - (d - rim) / 0.42, 0, 1);
          a = clamp(Math.pow(bowl, 0.55) + rays * 0.55, 0, 1) * cut;
          // dark in the hole, bright on the freshly turned lip
          const lip = Math.exp(-((d - rim) * (d - rim)) / 0.012);
          lum = clamp(0.20 + bowl * 0.10 + lip * 0.95 + rays * 0.65 + grit * 0.18, 0, 1);
        } else if (q === DECAL_SCORCH) {
          const shape = clamp(1 - d / (0.78 + (n - 0.5) * 0.34), 0, 1);
          a = clamp(Math.pow(shape, 0.8) * (0.55 + 0.75 * n), 0, 1) * cut;
          lum = clamp(0.06 + grit * 0.14 + (1 - shape) * 0.12, 0, 1);
        } else if (q === DECAL_BURN) {
          const r0 = 0.52 + (n - 0.5) * 0.20;
          const ring = Math.exp(-((d - r0) * (d - r0)) / 0.030);
          const core = clamp(1 - d / (r0 * 0.95), 0, 1);
          const streak = clamp((n - 0.56) * 4, 0, 1) * clamp(1 - (d - r0) / 0.45, 0, 1);
          a = clamp(ring * 0.9 + core * 0.72 + streak * 0.6, 0, 1) * cut;
          lum = clamp(0.05 + core * 0.06 + streak * 0.22 + grit * 0.1, 0, 1);
        } else {
          const shape = clamp(1 - d / (0.85 + (n - 0.5) * 0.3), 0, 1);
          // splatter rather than a disc: the noise punches holes in it
          a = clamp(Math.pow(shape, 1.1) * clamp((n - 0.30) * 2.2, 0, 1), 0, 1) * cut;
          lum = clamp(0.62 + grit * 0.35, 0, 1);
        }

        const i = ((oy + y) * S + (ox + x)) * 4;
        const l = Math.round(lum * 255);
        img.data[i] = l;
        img.data[i + 1] = l;
        img.data[i + 2] = l;
        img.data[i + 3] = Math.round(clamp(a, 0, 1) * 255);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  decalTex = t;
  return t;
}

// ---------------------------------------------------------------------------
// buffer upload helper
// ---------------------------------------------------------------------------

// Flag a buffer attribute for upload, bounded to the slice that changed.
// Ranges are additive because the renderer clears them itself once it has
// uploaded: a frame that updated but never rendered must not lose its writes.
// If they pile up — which only happens while nothing is being drawn — drop back
// to an unbounded upload rather than growing the list forever.
//
// The fallback is STICKY until the renderer has actually uploaded (its
// onUploadCallback): three uploads only the listed ranges when there are any,
// so a range added after the clear would narrow the pending whole-buffer
// upload back down and silently drop every write made before it. A range
// that continues the last one (a ring buffer written in order) extends it
// instead of adding another, so a burst of rounds is one range, not twenty.
function fullUploadDone() {
  this.fxFullUpload = false;
}
export function markFullUpload(attr) {
  if (attr.updateRanges) {
    attr.clearUpdateRanges();
    attr.fxFullUpload = true;
    if (attr.onUploadCallback !== fullUploadDone) attr.onUpload(fullUploadDone);
  }
  attr.needsUpdate = true;
}
export function markRange(attr, off, len) {
  if (attr.updateRanges) {
    const R = attr.updateRanges;
    if (attr.fxFullUpload) {
      // the whole buffer is going up anyway
    } else if (R.length > 0 && off >= R[R.length - 1].start
      && off <= R[R.length - 1].start + R[R.length - 1].count) {
      const last = R[R.length - 1];
      last.count = Math.max(last.count, off + len - last.start);
    } else if (R.length >= 8) markFullUpload(attr);
    else attr.addUpdateRange(off, len);
  } else if (attr.updateRange) {
    attr.updateRange.offset = off;
    attr.updateRange.count = len;
  }
  attr.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// the smoke-screen volume: one set of maths for the eye and for the AI
// ---------------------------------------------------------------------------
//
// "I can see the tank through the smoke" had three causes, and this block is
// the answer to the deepest one: the sight-line test and the picture were two
// unrelated models. Gameplay asked "is there a 24 m sphere of uniform fog in
// the way", the renderer drew a few hundred random puffs in a flat disc, and
// nothing guaranteed the two agreed — through the top of that sphere, through
// a gap between puffs, or simply on a low-quality setting with half the puffs,
// the AI was blind and the player was not.
//
// Now a screen IS one analytic volume and both sides integrate the same one:
//
//   * an oblate ellipsoid sitting on the ground: horizontal semi-axis
//     SCREEN_RH × radius, vertical SCREEN_RV × radius, centre SCREEN_YC ×
//     radius above the ground, and nothing at all below a floor plane just
//     under the ground (smoke does not fill the hill under it);
//   * a parabolic density profile, rho(q) = SCREEN_RHO · density · (1 - q²),
//     q the normalised ellipsoid radius. A uniform sphere has a razor edge —
//     its chord reaches 4 m within 17 cm of the rim, so any faithful picture of
//     it is a hard grey disc. The parabola thins out to nothing at the rim, so
//     the visible edge is soft and the gameplay edge sits where it looks thin;
//   * optical depth tau along a segment = the integral of rho over it, in
//     "metres of full-density smoke". blocksLineOfSight is tau >= losThreshold
//     (4, as before), and the renderer draws the volume with opacity
//     1 - exp(-kappa · tau), kappa = ln(20) / losThreshold. So a line the game
//     calls blocked is drawn at >= 95 % opacity BY CONSTRUCTION — at any FOV,
//     any distance, any quality setting — and the billboards drawn over it can
//     only add to that, never subtract.
//
// Sized so the blind window at turret height is what it was (±11.7 m across a
// 12 m screen against the old ±11.8 m) while the top of the screen is about
// where the old puffs topped out (~10 m) rather than 13 m of invisible sphere.
//
// The chord in screensTau() below and fxSmokeSeg() in FX_SMOKE_SEG are the
// same function. Change one, change the other: the guarantee is that they
// agree.

const SCREEN_RH = 1.15;
const SCREEN_RV = 0.7;
const SCREEN_YC = 0.12;
const SCREEN_RHO = 1.5;
// metres of slack under the ground at the screen's centre, so a dip in the
// ground just in front of it still fills with smoke
const SCREEN_FLOOR = 0.6;
const SCREEN_PUFF = 0xd2d6d0;

// How the volume is drawn: CORE_SLICES view-aligned slabs per screen, see
// SmokeCore. CORE_RIM is how far the drawn rim may billow past the volume the
// game uses (the noise only ever adds smoke, never removes it).
const CORE_SLICES = 12;
const CORE_RIM = 1.3;

// The segment a sight-line query is integrating, and the answer. Slots: 0-2
// origin, 3-5 unit direction, 6-7 the [ta, tb] stretch of it that counts,
// 8 the optical depth.
//
// Why a scratch array and not arguments and return values: V8 boxes every
// double that crosses a call it did not inline into a fresh heap number. The
// chord used to be a function taking the ray as eight double arguments and
// handing tau back as a double, called once per screen and too big to be
// inlined — ~150 bytes of garbage per query (53-76 young-generation GCs per two
// million queries, against none for the old sphere test), and the AI and the
// HUD ask per unit per frame. Now the sight-line queries write the segment
// here and make ONE call, to screensTau: the whole screen loop, no calls left
// in it once screenShape is inlined, too big for V8 ever to inline into a
// caller (so a caller only ever sees one plain call with no numbers crossing
// it), answer left in SEG[8]. Measured with every query in its own loop: 0
// bytes per call. See integrateScreens for the one shape that still boxed.
const SEG = new Float64Array(9);

// Optical depth of the segment in SEG through every live screen at least
// minDensity thick, into SEG[8]. Per screen, the same algebra as fxSmokeSeg:
// ellipsoid-normalised ray, closest approach, clip to [ta, tb] and to the floor
// plane, integrate the parabola in closed form about the closest point
// (centred, so a camera two kilometres away does not cancel itself to nothing
// in 32-bit floats on the GPU side). Kept as one function on purpose, see SEG.
// A segment shorter than a millimetre crosses nothing.
function screensTau(screens, minDensity) {
  SEG[8] = 0;
  if (SEG[7] < 1e-3) return;
  for (let i = 0; i < MAX_SCREENS; i++) {
    const s = screens[i];
    if (!s.active || s.density <= 0 || s.density < minDensity) continue;
    const sh = screenShape(s, SHAPE);
    if (sh.rho <= 0) continue;
    const ih = 1 / sh.rh;
    const iv = 1 / sh.rv;
    const oy = SEG[1];
    const dy = SEG[4];
    const px = (SEG[0] - sh.cx) * ih;
    const py = (oy - sh.cy) * iv;
    const pz = (SEG[2] - sh.cz) * ih;
    const qx = SEG[3] * ih;
    const qy = dy * iv;
    const qz = SEG[5] * ih;
    const a = qx * qx + qy * qy + qz * qz;
    const tm = -(px * qx + py * qy + pz * qz) / a;
    const cx = px + qx * tm;
    const cy = py + qy * tm;
    const cz = pz + qz * tm;
    const k = 1 - (cx * cx + cy * cy + cz * cz);
    if (k <= 0) continue;
    const h = Math.sqrt(k / a);
    let t0 = Math.max(tm - h, SEG[6]);
    let t1 = Math.min(tm + h, SEG[7]);
    if (dy < -1e-5) t1 = Math.min(t1, (sh.floor - oy) / dy);
    else if (dy > 1e-5) t0 = Math.max(t0, (sh.floor - oy) / dy);
    else if (oy < sh.floor) continue;
    if (t1 <= t0) continue;
    const s0 = t0 - tm;
    const s1 = t1 - tm;
    SEG[8] += sh.rho * (k * (s1 - s0) - (a * (s1 * s1 * s1 - s0 * s0 * s0)) / 3);
  }
}

// GLSL ES 3.0. Every stage that includes FX_SMOKE_TAU must include
// FX_SMOKE_UNIFORMS first; FX_SMOKE_SEG on its own needs no uniforms.
const FX_SMOKE_UNIFORMS = /* glsl */`
#define FX_MAX_SCREENS 8
uniform vec4 uSmkA[ FX_MAX_SCREENS ];
uniform vec4 uSmkB[ FX_MAX_SCREENS ];
uniform int uSmkN;
uniform float uSmkKappa;
`;

// A = centre.xyz, peak density;  B = horizontal semi-axis, vertical semi-axis,
// floor plane y, per-screen noise seed.
const FX_SMOKE_SEG = /* glsl */`
float fxSmokeSeg( vec3 ro, vec3 rd, float ta, float tb, vec4 A, vec4 B, out float t0, out float t1 ) {
	t0 = 0.0;
	t1 = 0.0;
	if ( A.w <= 0.0 ) return 0.0;
	vec3 inv = vec3( 1.0 / B.x, 1.0 / B.y, 1.0 / B.x );
	vec3 o = ( ro - A.xyz ) * inv;
	vec3 d = rd * inv;
	float a = dot( d, d );
	float tm = - dot( o, d ) / a;
	vec3 pc = o + d * tm;
	float k = 1.0 - dot( pc, pc );
	if ( k <= 0.0 ) return 0.0;
	float h = sqrt( k / a );
	t0 = max( tm - h, ta );
	t1 = min( tm + h, tb );
	if ( rd.y < -1e-5 ) {
		t1 = min( t1, ( B.z - ro.y ) / rd.y );
	} else if ( rd.y > 1e-5 ) {
		t0 = max( t0, ( B.z - ro.y ) / rd.y );
	} else if ( ro.y < B.z ) {
		return 0.0;
	}
	if ( t1 <= t0 ) return 0.0;
	float s0 = t0 - tm;
	float s1 = t1 - tm;
	return A.w * ( k * ( s1 - s0 ) - a * ( s1 * s1 * s1 - s0 * s0 * s0 ) / 3.0 );
}
`;

const FX_SMOKE_TAU = /* glsl */`
float fxSmokeTau( vec3 ro, vec3 rd, float len ) {
	float tau = 0.0;
	float t0;
	float t1;
	for ( int i = 0; i < FX_MAX_SCREENS; i ++ ) {
		if ( i >= uSmkN ) break;
		tau += fxSmokeSeg( ro, rd, 0.0, len, uSmkA[ i ], uSmkB[ i ], t0, t1 );
	}
	return tau;
}
`;

// What gets through every live screen between the camera and the point `ray`
// away from it, the first `skin` e-folds forgiven (see the smoke veil under
// the billboards). 1.0 at once while no screen is out, so a battle without
// smoke pays one uniform compare per call. Needs FX_SMOKE_UNIFORMS,
// FX_SMOKE_SEG and FX_SMOKE_TAU first, and three's cameraPosition, which every
// non-raw material declares in both stages.
const FX_SMOKE_VEIL = /* glsl */`
float fxSmokeVeil( vec3 ray, float skin ) {
	if ( uSmkN <= 0 ) return 1.0;
	float len = length( ray );
	return exp( - max( uSmkKappa * fxSmokeTau( cameraPosition, ray / max( len, 1e-4 ), len ) - skin, 0.0 ) );
}
`;

// 1.0 if a sight-line from the camera to anywhere within r of the point c may
// pass through a live screen, 0.0 if none can. Conservative by construction:
// a ray to a point within r of c never strays more than r from the ray to c,
// so a segment camera -> c that clears a screen's bounding sphere by more than
// r means every ray to the disc clears the screen. The metre of slack covers
// float rounding a couple of kilometres from the origin.
const FX_SMOKE_NEAR = /* glsl */`
float fxSmokeNear( vec3 c, float r ) {
	vec3 d = c - cameraPosition;
	float dd = max( dot( d, d ), 1e-8 );
	for ( int i = 0; i < FX_MAX_SCREENS; i ++ ) {
		if ( i >= uSmkN ) break;
		vec3 s = uSmkA[ i ].xyz - cameraPosition;
		vec3 e = s - d * clamp( dot( s, d ) / dd, 0.0, 1.0 );
		float R = max( uSmkB[ i ].x, uSmkB[ i ].y ) + r + 1.0;
		if ( dot( e, e ) < R * R ) return 1.0;
	}
	return 0.0;
}
`;

// Cheap 3D value noise for the volume's rim. Float literals throughout: GLSL
// ES has no implicit int-to-float.
const FX_NOISE = /* glsl */`
float fxHash3( vec3 p ) {
	p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
	p *= 17.0;
	return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float fxNoise3( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( mix( fxHash3( i ), fxHash3( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
			mix( fxHash3( i + vec3( 0.0, 1.0, 0.0 ) ), fxHash3( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
		mix( mix( fxHash3( i + vec3( 0.0, 0.0, 1.0 ) ), fxHash3( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
			mix( fxHash3( i + vec3( 0.0, 1.0, 1.0 ) ), fxHash3( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ),
		f.z );
}
`;

// ---------------------------------------------------------------------------
// camera-facing billboards
// ---------------------------------------------------------------------------
//
// The particles used to be THREE.Points, and a point sprite is sized in
// PIXELS: three scales gl_PointSize by (canvas height / 2) / depth and never
// looks at the camera's field of view. Zoom the gunner's sight from 60° to 6°
// and the world is magnified ten times while every smoke puff stays the same
// number of pixels — a smoke screen falls apart into scattered grey dots and
// the tank behind it shows between them. On top of that the GPU clamps
// gl_PointSize (ALIASED_POINT_SIZE_RANGE: 1024 px on ANGLE/D3D11, 256 on some
// drivers), which chopped the near puffs down whatever size they asked for.
//
// So every pool is now an instanced quad facing the camera, sized in METRES:
// it magnifies with the sight exactly like the hull behind it, and there is no
// size limit to hit. Still one draw call per pool, still one vertex-attribute
// upload per frame bounded to the live span, and an empty pool now draws
// nothing at all instead of 900 parked points.
//
// The sizes everywhere in this file were tuned as point sizes under the 60°
// battle camera. A point of size S there covers what a billboard S·tan(30°)
// metres wide does, so POINT_TO_WORLD keeps the normal view exactly as it was
// and only changes what happens when the field of view narrows.
//
// Per instance:
//   iPos   world position
//   color  rgb, past 1.0 for the hot stuff so bloom finds it
//   aFx    x scale (grows over life), y alpha (dissolves), z ground height
//          under the puff (NO_GROUND for pools that do not fade into it)
//
// and the shader adds, for free:
//   spin        a fixed random roll per slot, plus a slow turn, so three
//               hundred copies of one sprite stop reading as one sprite
//   near fade   a puff dissolves as the camera enters it instead of popping
//               across the near plane as a screen-filling grey square
//   ground fade soft-particle edge where a puff sinks into flat ground, from
//               the ground height under it — no depth texture needed
//   sun         a puff is lit on the side facing the sun (a sphere normal
//               reconstructed across the quad), which is most of what makes a
//               billboard read as a lump of smoke rather than a decal
//   smoke veil  everything behind a smoke screen is attenuated by the screen's
//               optical depth, so a burning wreck or a tracer behind the
//               screen does not draw straight over the top of it. `skin` (in
//               e-folds) exempts the outermost layer: the screen's own puffs
//               live in that layer and are its visible surface, not something
//               seen through it.
//               Integrated PER FRAGMENT, along that fragment's own view ray.
//               Optical depth is nothing like linear across a quad: a fire's
//               lower corners sit under the screen's floor plane, the rays to
//               them pass beneath the smoke with tau = 0, while the rays to
//               the middle of the same quad cross metres of it. Interpolating
//               a per-corner veil let fire, wreck smoke and a muzzle flash
//               behind a blind screen show through at up to two thirds of
//               their brightness. The vertex stage only decides, per instance
//               and conservatively, whether a quad's sight-lines come near any
//               screen at all, so a quad nowhere near one skips the loop

const POINT_TO_WORLD = Math.tan(Math.PI / 6);
const NO_GROUND = -1e5;
const QUAD_CORNERS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
const QUAD_UVS = [0, 0, 1, 0, 1, 1, 0, 1];
// counter-clockwise seen from +z, which is toward the camera in view space
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

const BILLBOARD_VS_DECL = /* glsl */`
attribute vec3 iPos;
attribute vec3 aFx;
uniform float uFxSize;
uniform float uFxSpin;
uniform float uFxSkin;
uniform float uFxMaxNdc;
uniform float uFxTime;
uniform vec3 uFxSun;
varying float vFxAlpha;
varying vec2 vFxQ;
varying vec3 vFxRay;
varying vec2 vFxSoft;
varying vec3 vFxSunV;
flat varying float vFxSmk;
${FX_SMOKE_UNIFORMS}${FX_SMOKE_SEG}${FX_SMOKE_TAU}${FX_SMOKE_VEIL}${FX_SMOKE_NEAR}`;

// Replaces three's project_vertex: the instance centre goes to view space and
// the quad corner is added there, so the quad always faces the camera.
const BILLBOARD_VS_PROJECT = /* glsl */`
	float fxId = float( gl_InstanceID );
	float fxW = uFxSize * aFx.x;
	float fxDir = mod( fxId, 2.0 ) < 0.5 ? 1.0 : -1.0;
	float fxAng = fxId * 2.3999632 + uFxTime * uFxSpin * fxDir * ( 0.4 + fract( fxId * 0.618034 ) );
	float fxC = cos( fxAng );
	float fxS = sin( fxAng );
	vec2 fxCorner = vec2( fxC * position.x - fxS * position.y, fxS * position.x + fxC * position.y ) * fxW;
	vec4 fxCentre = modelMatrix * vec4( iPos, 1.0 );
	vec4 mvPosition = viewMatrix * fxCentre;
	float fxDepth = max( - mvPosition.z, 1e-3 );
	float fxNear = clamp( ( fxDepth - 0.18 * fxW ) / ( 0.55 * fxW ), 0.0, 1.0 );
	// Pools backed by a volume (uFxMaxNdc > 0) let a puff go once it is bigger
	// than the screen: zoomed hard into a smoke screen at close range every
	// puff would otherwise be a full-screen layer of overdraw adding nothing
	// the volume does not already paint.
	float fxBig = uFxMaxNdc > 0.0
		? clamp( 2.0 - fxW * projectionMatrix[ 1 ][ 1 ] / ( fxDepth * uFxMaxNdc ), 0.0, 1.0 ) : 1.0;
	// Whether any screen comes near this quad's sight-lines: the fragment
	// stage integrates the veil only if so. 0.7072 is a corner's reach, half
	// the quad's diagonal, whatever its spin.
	float fxSmk = fxSmokeNear( fxCentre.xyz, 0.7072 * fxW );
	vFxSmk = fxSmk;
	// ...and one whose centre is deep behind the volume's dense middle is
	// never seen at all, so it is not rasterised either.
	float fxHidden = 1.0;
	if ( uFxSkin > 0.0 && fxSmk > 0.5 ) fxHidden = fxSmokeVeil( fxCentre.xyz - cameraPosition, uFxSkin );
	mvPosition.xy += fxCorner;
	gl_Position = projectionMatrix * mvPosition;
	// dead, invisible or inside the camera: collapse the whole quad. Decided
	// per instance, never per corner, or a half-collapsed quad would smear.
	if ( aFx.y * fxNear * fxBig < 0.002 || fxHidden < 0.05 ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
	vec3 fxRight = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
	vec3 fxUp = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
	vec3 fxWorld = fxCentre.xyz + fxRight * fxCorner.x + fxUp * fxCorner.y;
	vFxRay = fxWorld - cameraPosition;
	vFxAlpha = aFx.y * fxNear * fxBig;
	vFxQ = fxCorner / ( 0.5 * fxW );
	vFxSoft = vec2( fxWorld.y - aFx.z, 0.4 * fxW );
	vFxSunV = ( viewMatrix * vec4( uFxSun, 0.0 ) ).xyz;
`;

const BILLBOARD_FS_DECL = /* glsl */`
uniform float uFxLit;
uniform vec3 uFxAmb;
uniform vec3 uFxSunCol;
uniform float uFxSkin;
varying float vFxAlpha;
varying vec2 vFxQ;
varying vec3 vFxRay;
varying vec2 vFxSoft;
varying vec3 vFxSunV;
flat varying float vFxSmk;
${FX_SMOKE_UNIFORMS}${FX_SMOKE_SEG}${FX_SMOKE_TAU}${FX_SMOKE_VEIL}`;

// Soft ground: on flat ground the distance from this fragment to the ground
// BEHIND it, along the view ray, is its height over the ground divided by how
// steeply the ray falls. That is exactly what a soft-particle depth compare
// measures, without the depth texture.
const BILLBOARD_FS_ALPHA = /* glsl */`
	float fxDy = vFxRay.y / max( length( vFxRay ), 1e-4 );
	float fxBehind = fxDy < -1e-3 ? vFxSoft.x / - fxDy : 1e6;
	float fxSoftK = clamp( fxBehind / max( vFxSoft.y, 1e-3 ), 0.0, 1.0 );
	vec4 diffuseColor = vec4( diffuse, opacity * vFxAlpha * fxSoftK );
`;

// The smoke veil, along this fragment's own view ray (vFxRay is exact per
// fragment: the quad is flat, so its world point interpolates linearly).
// Applied AFTER three's alpha test, so a sprite's transparent corners are
// discarded before they pay for the loop over the screens, then the test runs
// again on the veiled alpha, so exactly the same fragments end up discarded.
// On an Iris Xe, zoomed on a screen with a fight round it, that ordering took
// the veil from about a third more frame time to about a fifth more; with no
// screen in the picture it costs nothing measurable.
const BILLBOARD_FS_VEIL = /* glsl */`
	#include <alphatest_fragment>
	if ( vFxSmk > 0.5 ) {
		diffuseColor.a *= fxSmokeVeil( vFxRay, uFxSkin );
		#include <alphatest_fragment>
	}
`;

// Lit by the map's own light: sky ambient plus a wrapped sun term (smoke is
// translucent, so light wraps a long way round the shadow side), on a sphere
// normal rebuilt across the quad. At noon that is near white on the sunny
// side and blue-grey in shadow; at dusk it warms and darkens with the hour.
const BILLBOARD_FS_LIGHT = /* glsl */`
	#include <color_fragment>
	vec3 fxN = normalize( vec3( vFxQ, sqrt( max( 1.0 - dot( vFxQ, vFxQ ), 0.0 ) ) ) );
	float fxWrap = clamp( ( dot( fxN, normalize( vFxSunV ) ) + 0.5 ) / 1.5, 0.0, 1.0 );
	diffuseColor.rgb *= mix( vec3( 1.0 ), uFxAmb + uFxSunCol * fxWrap, uFxLit );
`;

// The uniforms every patched material reads by reference from its Effects.
function sharedFxUniforms(target, shared) {
  // (the smoke-veil set alone carries only the uSmk* four)
  if (shared.uFxTime) target.uFxTime = shared.uFxTime;
  if (shared.uFxSun) target.uFxSun = shared.uFxSun;
  if (shared.uFxAmb) target.uFxAmb = shared.uFxAmb;
  if (shared.uFxSunCol) target.uFxSunCol = shared.uFxSunCol;
  target.uSmkA = shared.uSmkA;
  target.uSmkB = shared.uSmkB;
  target.uSmkN = shared.uSmkN;
  target.uSmkKappa = shared.uSmkKappa;
  return target;
}

// Patch a MeshBasicMaterial rather than write a ShaderMaterial: fog, tone
// mapping, the sprite map, vertex colours and alpha test all keep coming from
// three's own chunks. `local` holds this pool's own uniforms.
function patchBillboardMaterial(mat, local, shared) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, local);
    sharedFxUniforms(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BILLBOARD_VS_DECL}`)
      .replace('#include <project_vertex>', BILLBOARD_VS_PROJECT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${BILLBOARD_FS_DECL}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', BILLBOARD_FS_ALPHA)
      .replace('#include <color_fragment>', BILLBOARD_FS_LIGHT)
      .replace('#include <alphatest_fragment>', BILLBOARD_FS_VEIL);
  };
  // Every pool compiles to this same program; three keys its cache on this.
  mat.customProgramCacheKey = () => 'fxbillboard3';
  return mat;
}

// The smoke veil alone, for the tracer and shockwave meshes: attenuate each
// fragment by whatever smoke screen lies between the camera and it. Per
// fragment for the same reason as the billboards: a long streak or a wide
// ring has vertices on both sides of a screen's edge. The vertex stage only
// hands over the camera -> vertex ray, which interpolates exactly across a
// flat triangle.
const VEIL_VS = /* glsl */`
	#include <fog_vertex>
	vec4 fxWp = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		fxWp = instanceMatrix * fxWp;
	#endif
	vFxVeilRay = ( modelMatrix * fxWp ).xyz - cameraPosition;
`;

// Exported (contract R1-T) for any additive mesh outside this file that wants
// the veil alone; `shared` defaults to the live module screens.
export function patchVeilMaterial(mat, shared = null) {
  mat.onBeforeCompile = (shader) => {
    if (!shared) shared = SMOKE_VEIL_U;
    sharedFxUniforms(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFxVeilRay;')
      .replace('#include <fog_vertex>', VEIL_VS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>\nvarying vec3 vFxVeilRay;\n${FX_SMOKE_UNIFORMS}${FX_SMOKE_SEG}${FX_SMOKE_TAU}${FX_SMOKE_VEIL}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );',
        'vec4 diffuseColor = vec4( diffuse, opacity * fxSmokeVeil( vFxVeilRay, 0.0 ) );');
  };
  mat.customProgramCacheKey = () => 'fxveil2';
  return mat;
}

function dynInstanced(array, itemSize) {
  const a = new THREE.InstancedBufferAttribute(array, itemSize);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

function noRaycast() {}

// ---------------------------------------------------------------------------
// particle pool
// ---------------------------------------------------------------------------

// fade: how a particle dies.
//   'color'  multiply the colour down — right for additive, where alpha and
//            brightness are the same thing and a hot spark should cool
//   'alpha'  hold the colour and dissolve — right for smoke under normal
//            blending, where scaling the colour only turns it black
//   'both'   a fireball does both: it cools AND thins out
//
// spin: radians per second a puff turns (alternating sense per slot); lit: how
// much the sun shades it, 0 for anything that is its own light; soft: fade it
// where it meets the ground — costs one terrain sample per spawn; skin: how
// deep into a smoke screen (in e-folds of its optical depth) the pool is
// still drawn unveiled, and > 0 also culls puffs hidden deep behind one;
// maxNdc: fade a puff out as it grows past this many NDC units tall (2 = the
// screen height), 0 for never — only for a pool a volume stands behind.
class ParticlePool {
  constructor(scene, count, opts, shared) {
    const {
      size, blending, opacity, fadeColor, sprite: spriteKind,
      fade = 'color', swirl = 0, wind = 0, depthWrite = false,
      spin = 0, lit = 0, soft = false, skin = 0, maxNdc = 0,
    } = opts;
    this.count = count;
    this.cursor = 0;
    // Live count plus a dirty flag: an idle pool costs nothing per frame, which
    // matters once there are seven of them and most are empty most of the time.
    this.live = 0;
    this.dirty = false;
    // Inclusive span of slots that may hold something live. A muzzle flash puts
    // a dozen particles in a 900-slot pool; without this both the walk and the
    // buffer upload were sized to the pool rather than to the smoke.
    this.lo = 0;
    this.hi = -1; // hi < lo means empty
    this.pos = new Float32Array(count * 3).fill(HIDDEN_Y);
    this.col = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.base = new Float32Array(count * 3);
    this.gravity = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.scale0 = new Float32Array(count);
    this.grow = new Float32Array(count);
    this.alpha0 = new Float32Array(count);
    // seconds over which a particle fades in; 0 = the default tenth of its
    // life (ejecta want to be there at once even when they live 12 s)
    this.ramp = new Float32Array(count);
    // metres of billboard per unit of spawn scale, for callers that size in
    // metres (the blast law, the muzzle flame)
    this.unit = size * POINT_TO_WORLD;
    // interleaved per-instance scale, alpha, ground height: one attribute, one
    // upload range
    this.fx = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) this.fx[i * 3 + 2] = NO_GROUND;
    this.soft = soft;
    this.fadeColor = fadeColor ? new THREE.Color(fadeColor) : null;
    this.fade = fade;
    this.swirl = swirl;
    // How hard the map's wind drags this class of particle around. Smoke goes
    // with the weather; a spark is gone before the air can move it.
    this.wind = wind;
    this.windX = 0;
    this.windZ = 0;
    this.time = 0;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(QUAD_INDEX);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(QUAD_CORNERS, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(QUAD_UVS, 2));
    geo.setAttribute('iPos', dynInstanced(this.pos, 3));
    // named `color` so three's own vertex-colour chunks pick it up per instance
    geo.setAttribute('color', dynInstanced(this.col, 3));
    geo.setAttribute('aFx', dynInstanced(this.fx, 3));
    geo.instanceCount = 0;
    const tex = sprite(spriteKind || 'soft');
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity,
      blending,
      depthWrite,
      // Passed at construction rather than assigned afterwards: swapping a map
      // in later needs a program rebuild, and there is no reason to pay for one.
      map: tex || null,
      alphaTest: tex ? 0.02 : 0,
    });
    patchBillboardMaterial(mat, {
      uFxSize: { value: size * POINT_TO_WORLD },
      uFxSpin: { value: spin },
      uFxLit: { value: lit },
      uFxSkin: { value: skin },
      uFxMaxNdc: { value: maxNdc },
    }, shared);
    this.mesh = new THREE.Mesh(geo, mat);
    // the old name, for anything that still reaches for it
    this.points = this.mesh;
    this.mesh.frustumCulled = false;
    // Particles are lit by their own colour and would only smear the shadow map.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // one quad at the origin as far as a raycaster could tell; nobody should
    // ever be able to click on smoke
    this.mesh.raycast = noRaycast;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // How many instances the GPU walks: up to the highest live slot, and none at
  // all — not even a draw call — while the pool is empty.
  sync() {
    const n = this.hi >= this.lo ? this.hi + 1 : 0;
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  setWind(x, z) {
    this.windX = x;
    this.windZ = z;
  }

  // gravity is positive down, so a negative value is buoyancy — that is how
  // smoke rises. scale multiplies the pool's point size, grow adds to it over
  // the particle's life, alpha is its peak opacity and heat multiplies the
  // colour past 1.0 so the bloom pass has something to find.
  spawn(p, v, life, color, gravity = 0, drag = 0, scale = 1, grow = 0, alpha = 1, heat = 1, ramp = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    if (this.life[i] <= 0) this.live++;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x;
    this.vel[i * 3 + 1] = v.y;
    this.vel[i * 3 + 2] = v.z;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.base[i * 3] = (((color >> 16) & 255) / 255) * heat;
    this.base[i * 3 + 1] = (((color >> 8) & 255) / 255) * heat;
    this.base[i * 3 + 2] = ((color & 255) / 255) * heat;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
    this.scale0[i] = scale;
    this.grow[i] = grow;
    this.alpha0[i] = alpha;
    this.ramp[i] = ramp > 0 ? ramp : 0;
    this.fx[i * 3] = scale;
    this.fx[i * 3 + 1] = 0;
    // The ground under the puff where it was born. It drifts a few metres at
    // most before it is gone, and the fade only needs the local height.
    this.fx[i * 3 + 2] = this.soft ? terrainHeight(p.x, p.z) : NO_GROUND;
    this.dirty = true;
    if (this.hi < this.lo) {
      this.lo = i;
      this.hi = i;
    } else {
      if (i < this.lo) this.lo = i;
      if (i > this.hi) this.hi = i;
    }
  }

  // Upload only the slice of the three attributes that the span [lo..hi] covers.
  flush(lo, hi) {
    if (hi < lo) return;
    const attrs = this.mesh.geometry.attributes;
    const off = lo * 3;
    const len = (hi - lo + 1) * 3;
    markRange(attrs.iPos, off, len);
    markRange(attrs.color, off, len);
    markRange(attrs.aFx, off, len);
  }

  update(dt) {
    this.time += dt;
    if (this.live <= 0) {
      if (!this.dirty) return;
      this.dirty = false;
      // the last write was the one that hid them; it still has to reach the GPU
      this.flush(this.lo, this.hi);
      this.lo = 0;
      this.hi = -1;
      this.sync();
      return;
    }
    const lo = this.lo;
    const hi = this.hi;
    const fadeAlpha = this.fade === 'alpha' || this.fade === 'both';
    const fadeCol = this.fade === 'color' || this.fade === 'both';
    const wind = this.wind;
    const swirl = this.swirl;
    const t = this.time;
    let nlo = -1;
    let nhi = -1;
    for (let i = lo; i <= hi; i++) {
      const L0 = this.life[i];
      if (L0 <= 0) continue;
      // Spawned this frame (never aged) and shorter than the frame: aged by
      // half its life instead, so it is drawn once rather than never — the
      // battles spawn before they update, and a 37 mm core lives < 1/60 s.
      this.life[i] = L0 === this.maxLife[i] && L0 <= dt ? L0 * 0.5 : L0 - dt;
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = HIDDEN_Y;
        this.fx[i * 3 + 1] = 0;
        this.live--;
        continue;
      }
      const damp = 1 - this.drag[i] * dt;
      let vx = this.vel[i * 3] * damp;
      let vy = this.vel[i * 3 + 1] * damp - this.gravity[i] * dt;
      let vz = this.vel[i * 3 + 2] * damp;
      if (wind > 0) {
        // advection, not a shove: the puff is dragged toward the airspeed of
        // the map rather than accelerated forever by it
        vx += (this.windX - vx) * wind * dt;
        vz += (this.windZ - vz) * wind * dt;
      }
      if (swirl > 0) {
        // cheap curl. The index is the phase, so no per-particle state is
        // needed and two neighbours never turn the same way.
        const ph = i * 0.618;
        vx += Math.sin(this.pos[i * 3 + 1] * 0.33 + t * 0.9 + ph) * swirl * dt;
        vz += Math.cos(this.pos[i * 3] * 0.29 - t * 0.72 + ph) * swirl * dt;
      }
      this.vel[i * 3] = vx;
      this.vel[i * 3 + 1] = vy;
      this.vel[i * 3 + 2] = vz;
      this.pos[i * 3] += vx * dt;
      this.pos[i * 3 + 1] += vy * dt;
      this.pos[i * 3 + 2] += vz * dt;

      const f = this.life[i] / this.maxLife[i];
      if (this.fadeColor) {
        // aerial perspective: distant smoke takes the colour of the air, so it
        // dissolves into the fog instead of staying a grey lump in front of it
        this.col[i * 3] = this.base[i * 3] * f + this.fadeColor.r * (1 - f);
        this.col[i * 3 + 1] = this.base[i * 3 + 1] * f + this.fadeColor.g * (1 - f);
        this.col[i * 3 + 2] = this.base[i * 3 + 2] * f + this.fadeColor.b * (1 - f);
      } else if (fadeCol) {
        this.col[i * 3] = this.base[i * 3] * f;
        this.col[i * 3 + 1] = this.base[i * 3 + 1] * f;
        this.col[i * 3 + 2] = this.base[i * 3 + 2] * f;
      } else {
        this.col[i * 3] = this.base[i * 3];
        this.col[i * 3 + 1] = this.base[i * 3 + 1];
        this.col[i * 3 + 2] = this.base[i * 3 + 2];
      }

      const aged = 1 - f;
      this.fx[i * 3] = this.scale0[i] * (1 + this.grow[i] * aged);
      // a puff swells into existence over the first tenth of its life; without
      // the ramp every particle pops (or over its own ramp time, if it has one)
      const rp = this.ramp[i];
      const rampIn = rp > 0
        ? Math.min(1, (this.maxLife[i] - this.life[i]) / rp)
        : aged < 0.09 ? aged / 0.09 : 1;
      this.fx[i * 3 + 1] = fadeAlpha
        ? this.alpha0[i] * rampIn * Math.pow(f, 0.75)
        : this.alpha0[i] * rampIn;
      if (nlo < 0) nlo = i;
      nhi = i;
    }
    // the slots that died this frame were written too, so the upload still
    // covers the span we walked, not the narrower one that survived it
    this.lo = nlo < 0 ? 0 : nlo;
    this.hi = nlo < 0 ? -1 : nhi;
    this.dirty = false;
    this.flush(lo, hi);
    this.sync();
  }

  clear() {
    for (let i = 0; i < this.count; i++) {
      this.life[i] = 0;
      this.pos[i * 3 + 1] = HIDDEN_Y;
      this.fx[i * 3 + 1] = 0;
    }
    this.live = 0;
    this.dirty = true;
    // everything was just rewritten, so the next update has to flush all of it
    this.lo = 0;
    this.hi = this.count - 1;
    // and nothing is drawn meanwhile: the GPU still holds the old frame
    this.mesh.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// shockwave rings
// ---------------------------------------------------------------------------
//
// One InstancedMesh for every expanding front in the game: the pressure ring
// off a muzzle brake, the dust wave a big gun blows off the ground, the front
// of a bomb going off. Additive, so fading is a colour scale and there is no
// sorting to get wrong, and one draw call for the lot.

const MAX_RINGS = 16;

class RingField {
  constructor(scene, shared) {
    const geo = new THREE.RingGeometry(0.34, 1, 40, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: ringTexture() || null,
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    // a blast wave behind a smoke screen is behind the smoke screen
    if (shared) patchVeilMaterial(mat, shared);
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_RINGS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = MAX_RINGS;
    scene.add(this.mesh);

    this.state = [];
    for (let i = 0; i < MAX_RINGS; i++) {
      this.state.push({
        live: false, age: 0, life: 1, r0: 1, r1: 4, heat: 1,
        quat: new THREE.Quaternion(), pos: new THREE.Vector3(),
      });
    }
    this.cursor = 0;
    this.live = 0;
    this.color = new THREE.Color();
    this.mat4 = new THREE.Matrix4();
    this.scaleV = new THREE.Vector3();
    this.zero = new THREE.Vector3(0, 0, 0);
    this.hidden = new THREE.Vector3(0, HIDDEN_Y, 0);
    this.unit = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < MAX_RINGS; i++) {
      this.mat4.compose(this.hidden, this.state[i].quat, this.unit);
      this.mesh.setMatrixAt(i, this.mat4);
      this.mesh.setColorAt(i, this.color.setRGB(0, 0, 0));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  // `axis` is the ring's normal: WORLD_UP for a wave running over the ground,
  // the bore direction for the pressure ring off a muzzle.
  add(pos, axis, r0, r1, life, color, heat = 1) {
    const s = this.state[this.cursor];
    if (!s.live) this.live++;
    this.cursor = (this.cursor + 1) % MAX_RINGS;
    s.live = true;
    s.age = 0;
    s.life = life;
    s.r0 = r0;
    s.r1 = r1;
    s.heat = heat;
    s.pos.copy(pos);
    s.colR = ((color >> 16) & 255) / 255;
    s.colG = ((color >> 8) & 255) / 255;
    s.colB = (color & 255) / 255;
    tv.copy(axis);
    if (tv.lengthSq() < 1e-8) tv.set(0, 1, 0);
    else tv.normalize();
    s.quat.setFromUnitVectors(RING_AXIS, tv);
  }

  update(dt) {
    if (this.live <= 0) return;
    for (let i = 0; i < MAX_RINGS; i++) {
      const s = this.state[i];
      if (!s.live) continue;
      s.age += dt;
      const f = s.age / s.life;
      if (f >= 1) {
        s.live = false;
        this.live--;
        this.mat4.compose(this.hidden, s.quat, this.unit);
        this.mesh.setMatrixAt(i, this.mat4);
        this.mesh.setColorAt(i, this.color.setRGB(0, 0, 0));
        continue;
      }
      // fast out of the gate, then it runs out of energy — that easing is what
      // makes it read as a pressure wave rather than as a growing circle
      const e = 1 - Math.pow(1 - f, 2.4);
      const r = s.r0 + (s.r1 - s.r0) * e;
      this.scaleV.set(r, r, 1);
      this.mat4.compose(s.pos, s.quat, this.scaleV);
      this.mesh.setMatrixAt(i, this.mat4);
      const k = Math.pow(1 - f, 1.7) * s.heat;
      this.mesh.setColorAt(i, this.color.setRGB(s.colR * k, s.colG * k, s.colB * k));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < MAX_RINGS; i++) {
      const s = this.state[i];
      s.live = false;
      this.mat4.compose(this.hidden, s.quat, this.unit);
      this.mesh.setMatrixAt(i, this.mat4);
      this.mesh.setColorAt(i, this.color.setRGB(0, 0, 0));
    }
    this.live = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// tracers
// ---------------------------------------------------------------------------
//
// A tracer is not a glowing box: it is a streak, stretched along where the
// round is going and long enough that the eye joins consecutive frames into a
// line. This is a cross of two quads — one in the plane containing the bore and
// the world up, one perpendicular — which reads correctly from any angle
// without the system needing to know where the camera is.
//
// Two modes. `tracer()` fires and forgets: the streak flies its own ballistic
// arc and expires. `attachTracer()` hands back a handle a projectile manager
// can drive, for rounds whose flight is simulated elsewhere.
//
// X-04: ONE tracer law for everything that draws one — the shells
// (ShellManager drives handles here), the bullets (BulletManager keeps its own
// InstancedMesh but this material, geometry and law) and the ricochet streaks:
//   length  = what the round covers in one 60 Hz frame, |v| / 60, clamped to
//             4-15 m (800 m/s -> 13.3 m), and never longer than the round has
//             actually flown (a streak does not reach back behind the muzzle)
//   width   = the spec core (4-8 cm, bible 6.5), but never under 1.5 px on
//             screen: widened in the vertex stage from the projection, so a
//             tracer still reads at 1.5 km in the sight — a real one is a
//             light source and does
//   colour  = HDR, peak 4-10, so it clears L-05's bloom threshold by >= 3x
//   veil    = the smoke screens' per-fragment veil, like every effect: a
//             tracer behind a screen is behind the screen
// The handle packs the slot in 8 bits, so MAX_TRACERS stays <= 256.

const MAX_TRACERS = 192;
export const TRACER_MIN_LEN = 4;
export const TRACER_MAX_LEN = 15;
// minimum on-screen width of the CORE, px, and what share of the quad the core
// is: the streak texture's across profile exp(-7 v^2) is at half its peak at
// |v| = 0.315, so the full-width-at-half-maximum is 0.315 of the quad
export const TRACER_MIN_PX = 1.5;
export const TRACER_CORE = 0.315;
// HDR multiplier on the streak colour (its white core is 1.0 in the texture):
// a confirmed-red tracer's core then reads luminance ~3.0, >= 3x the highest
// L-05 bloom threshold any preset sets (0.945, winter overcast)
export const TRACER_HEAT = 7.5;
// ...but that "~3.0" was Rec.601 maths. UnrealBloom's luminance() reads the
// working space (Rec.709: .2126/.7152/.0722), where a red core is far dimmer
// (7.5 x 0xff2a14 = 2.52, only 2.4x the highest threshold, 1.046). So the heat
// is per colour: at least TRACER_HEAT, raised until the core's Rec.709
// luminance is TRACER_BLOOM_LUM (>= 3.2x that threshold), never past the
// backlog's HDR ceiling of 10. Red 10.0, Soviet red 8.8, the rest 7.5.
export const TRACER_HEAT_MAX = 10;
export const TRACER_BLOOM_LUM = 3.36;
export function tracerHeatFor(hex) {
  const y = 0.2126 * (((hex >> 16) & 255) / 255) + 0.7152 * (((hex >> 8) & 255) / 255)
    + 0.0722 * ((hex & 255) / 255);
  return y > 0 ? clamp(TRACER_BLOOM_LUM / y, TRACER_HEAT, TRACER_HEAT_MAX) : TRACER_HEAT;
}
// Default core widths, m (bible 6.5: 4-8 cm).
export const TRACER_CORE_SHELL = 0.07;
export const TRACER_CORE_BULLET = 0.05;

/** Streak length for a round moving at `speed` m/s (the one law). */
export function tracerLength(speed, minLen = TRACER_MIN_LEN) {
  return clamp(speed / 60, minLen, TRACER_MAX_LEN);
}

/**
 * The quad width the vertex stage draws a tracer at (JS twin of TRACER_VS):
 * the spec width `quadW`, or wider so the core is TRACER_MIN_PX pixels at
 * `depth` metres in a view `fovDeg` high and `viewH` pixels tall.
 */
export function tracerQuadWidth(quadW, depth, fovDeg, viewH) {
  const p11 = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const px = (2 * Math.max(depth, 1e-3)) / (viewH * p11);
  return Math.max(quadW, (TRACER_MIN_PX * px) / TRACER_CORE);
}

// Tracer colours by nation (bible 6.5). LINEAR, as instance colours are.
// US and British red is confirmed; the rest are period-plausible placeholders
// — verify before anyone quotes them (German red-orange and Soviet red/green
// both turn up in sources, Japanese practice is unclear). Unknown: amber.
export const TRACER_COLOUR = Object.freeze({
  USA: 0xff2a14,       // red (confirmed)
  Britain: 0xff2a14,   // red (confirmed)
  UK: 0xff2a14,
  Germany: 0xff7a1e,   // verify
  USSR: 0xff3a1a,      // verify
  Japan: 0xffa040,     // verify
  default: 0xffb050,
});

/** Tracer colour for a vehicle (anything with .spec.nation), linear hex. */
export function tracerColourFor(shooter) {
  const n = shooter && shooter.spec && shooter.spec.nation;
  return (n && TRACER_COLOUR[n]) || TRACER_COLOUR.default;
}

// The uniforms every tracer material reads: the live smoke screens (module
// state, shared with the canopy veil, so a material cached across battles
// follows whichever battle is running) and the viewport height the minimum
// width is computed in, refreshed by each tracer mesh just before it draws.
const TRACER_U = {
  uTrViewH: { value: 1080 },
  uTrMinPx: { value: TRACER_MIN_PX },
  uTrCore: { value: TRACER_CORE },
};
const trViewSize = new THREE.Vector2();
// Mesh.onBeforeRender for a tracer mesh: what is being drawn into decides the
// pixel size (the composer's target, or the canvas itself on the low tier).
function tracerViewHook(renderer) {
  const rt = renderer && renderer.getRenderTarget ? renderer.getRenderTarget() : null;
  let h = rt && rt.height;
  if (!h && renderer && renderer.getDrawingBufferSize) h = renderer.getDrawingBufferSize(trViewSize).y;
  if (h > 0) TRACER_U.uTrViewH.value = h;
}

// Widen the quad's cross-section (local x and y; z is the length) so its core
// covers TRACER_MIN_PX pixels at this vertex's depth. Per vertex, so a long
// streak running away from the camera stays the same pixel width end to end.
const TRACER_VS = /* glsl */`
	#include <begin_vertex>
	{
		#ifdef USE_INSTANCING
			mat4 trM = modelViewMatrix * instanceMatrix;
			float trW = length( instanceMatrix[ 0 ].xyz );
		#else
			mat4 trM = modelViewMatrix;
			float trW = length( modelMatrix[ 0 ].xyz );
		#endif
		vec4 trV = trM * vec4( transformed, 1.0 );
		float trPx = 2.0 * max( - trV.z, 1e-3 ) / ( uTrViewH * projectionMatrix[ 1 ][ 1 ] );
		transformed.xy *= max( 1.0, uTrMinPx * trPx / uTrCore / max( trW, 1e-6 ) );
	}
`;

/**
 * Turn an additive streak material into a tracer: the minimum-width vertex
 * patch plus the per-fragment smoke veil. Replaces the material's
 * onBeforeCompile. Bullets and shells share one program through the key.
 */
export function patchTracerMaterial(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSmkA = SMOKE_VEIL_U.uSmkA;
    shader.uniforms.uSmkB = SMOKE_VEIL_U.uSmkB;
    shader.uniforms.uSmkN = SMOKE_VEIL_U.uSmkN;
    shader.uniforms.uSmkKappa = SMOKE_VEIL_U.uSmkKappa;
    shader.uniforms.uTrViewH = TRACER_U.uTrViewH;
    shader.uniforms.uTrMinPx = TRACER_U.uTrMinPx;
    shader.uniforms.uTrCore = TRACER_U.uTrCore;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vFxVeilRay;\nuniform float uTrViewH;\nuniform float uTrMinPx;\nuniform float uTrCore;')
      .replace('#include <begin_vertex>', TRACER_VS)
      .replace('#include <fog_vertex>', VEIL_VS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>\nvarying vec3 vFxVeilRay;\n${FX_SMOKE_UNIFORMS}${FX_SMOKE_SEG}${FX_SMOKE_TAU}${FX_SMOKE_VEIL}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );',
        'vec4 diffuseColor = vec4( diffuse, opacity * fxSmokeVeil( vFxVeilRay, 0.0 ) );');
  };
  mat.customProgramCacheKey = () => 'fxtracer1';
  return mat;
}

/** The additive streak material every tracer draws with (per caller; dispose it). */
export function createTracerMaterial() {
  return patchTracerMaterial(new THREE.MeshBasicMaterial({
    map: tracerTexture() || null,
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexColors: false,
  }));
}

/** Hook a tracer mesh up to the viewport-height uniform. Returns the mesh. */
export function attachTracerViewHook(mesh) {
  mesh.onBeforeRender = tracerViewHook;
  return mesh;
}

/** The cross-of-two-quads streak, length along +Z, unit size (per caller). */
export function tracerGeometry() {
  return crossQuadGeometry();
}

function crossQuadGeometry() {
  const g = new THREE.BufferGeometry();
  const p = new Float32Array([
    // quad lying in XZ, length along Z
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5,
    // quad lying in YZ
    0, -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5,
  ]);
  const uv = new Float32Array([
    0, 0, 0, 1, 1, 1, 1, 0,
    0, 0, 0, 1, 1, 1, 1, 0,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}

class TracerField {
  constructor(scene) {
    // Additive, so it would otherwise draw straight over a smoke screen it is
    // flying behind and give the shooter away. Per fragment: a streak half in
    // the smoke fades along its length. Plus the minimum-width patch (X-04).
    const mat = createTracerMaterial();
    this.mesh = new THREE.InstancedMesh(crossQuadGeometry(), mat, MAX_TRACERS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    attachTracerViewHook(this.mesh);
    scene.add(this.mesh);

    this.items = [];
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.items.push({
        live: false, gen: 1, attached: false,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        life: 0, maxLife: 1, minLen: TRACER_MIN_LEN, wid: 0.35, grav: 0,
        r: 1, g: 0.85, b: 0.5, heat: 1, trail: 0, trailAcc: 0,
        // metres flown since the streak was (re)anchored: its length cap
        flown: 0,
      });
    }
    this.cursor = 0;
    this.live = 0;
    this.color = new THREE.Color();
    this.mat4 = new THREE.Matrix4();
    this.quat = new THREE.Quaternion();
    this.scaleV = new THREE.Vector3();
    this.midV = new THREE.Vector3();
    this.hidden = new THREE.Vector3(0, HIDDEN_Y, 0);
    this.unit = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.mat4.compose(this.hidden, this.quat.identity(), this.unit);
      this.mesh.setMatrixAt(i, this.mat4);
      this.mesh.setColorAt(i, this.color.setRGB(0, 0, 0));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  alloc() {
    // take the first free slot from the cursor, else stamp on the oldest
    for (let n = 0; n < MAX_TRACERS; n++) {
      const i = (this.cursor + n) % MAX_TRACERS;
      if (!this.items[i].live) {
        this.cursor = (i + 1) % MAX_TRACERS;
        return i;
      }
    }
    const i = this.cursor;
    this.cursor = (i + 1) % MAX_TRACERS;
    return i;
  }

  //   opts: { color, life, width, gravity, heat, trail, minLength }
  //   width is the CORE width in metres (bible 4-8 cm); the quad is drawn
  //   core / TRACER_CORE wide and never under TRACER_MIN_PX on screen.
  //   minLength: the law's lower clamp (4 m for rounds; a tumbling fragment
  //   may ask for less). `length` is no longer read: speed decides.
  add(pos, vel, opts, attached) {
    const i = this.alloc();
    const it = this.items[i];
    if (!it.live) this.live++;
    // a slot stamped over while still live: retire the old handle
    else it.gen = (it.gen + 1) & 0x3fffff;
    it.live = true;
    it.attached = attached;
    it.pos.copy(pos);
    if (vel) it.vel.copy(vel);
    else it.vel.set(0, 0, 1);
    const o = opts || EMPTY;
    it.maxLife = o.life || 1.2;
    it.life = it.maxLife;
    it.minLen = o.minLength > 0 ? o.minLength : TRACER_MIN_LEN;
    it.wid = (o.width > 0 ? o.width : TRACER_CORE_SHELL) / TRACER_CORE;
    it.grav = o.gravity || 0;
    const c = o.color != null ? o.color : TRACER_COLOUR.default;
    it.heat = o.heat != null ? o.heat : tracerHeatFor(c);
    it.trail = o.trail || 0;
    it.trailAcc = 0;
    it.flown = 0;
    it.r = ((c >> 16) & 255) / 255;
    it.g = ((c >> 8) & 255) / 255;
    it.b = (c & 255) / 255;
    this.write(i, it);
    return i | (it.gen << 8);
  }

  resolve(handle) {
    const i = handle & 255;
    if (i < 0 || i >= MAX_TRACERS) return null;
    const it = this.items[i];
    if (!it.live || it.gen !== (handle >> 8)) return null;
    return it;
  }

  // `anchor`: the round just changed direction (a ricochet) — the streak
  // starts again from here rather than reaching back along the new heading.
  move(handle, pos, vel, anchor = false) {
    const it = this.resolve(handle);
    if (!it) return false;
    if (anchor) {
      it.flown = 0;
    } else {
      const dx = pos.x - it.pos.x;
      const dy = pos.y - it.pos.y;
      const dz = pos.z - it.pos.z;
      it.flown += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    it.pos.copy(pos);
    if (vel) it.vel.copy(vel);
    return true;
  }

  kill(handle) {
    const i = handle & 255;
    if (i < 0 || i >= MAX_TRACERS) return;
    const it = this.items[i];
    if (!it.live || it.gen !== (handle >> 8)) return;
    it.live = false;
    it.gen = (it.gen + 1) & 0x3fffff;
    this.live--;
    this.mat4.compose(this.hidden, this.quat.identity(), this.unit);
    this.mesh.setMatrixAt(i, this.mat4);
    this.mesh.setColorAt(i, this.color.setRGB(0, 0, 0));
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  write(i, it) {
    tv.copy(it.vel);
    const sp = tv.length();
    if (sp < 1e-4) tv.set(0, 0, 1);
    else tv.multiplyScalar(1 / sp);
    this.quat.setFromUnitVectors(TRACER_AXIS, tv);
    // X-04: the distance the round covers in a 60 Hz frame, clamped 4-15 m,
    // and never more than it has flown (a dot at the muzzle on the frame it
    // is fired, the full streak one step later)
    const len = Math.max(it.wid, Math.min(tracerLength(sp, it.minLen), it.flown));
    this.midV.copy(it.pos).addScaledVector(tv, -len * 0.5);
    this.scaleV.set(it.wid, it.wid, len);
    this.mat4.compose(this.midV, this.quat, this.scaleV);
    this.mesh.setMatrixAt(i, this.mat4);
    const f = it.life / it.maxLife;
    // holds bright, then dies in the last third — a tracer burns out, it does
    // not dim smoothly from the muzzle
    const k = clamp(f * 3, 0, 1) * it.heat;
    this.mesh.setColorAt(i, this.color.setRGB(it.r * k, it.g * k, it.b * k));
  }

  update(dt, fx) {
    if (this.live <= 0) return;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const it = this.items[i];
      if (!it.live) continue;
      it.life -= dt;
      if (it.life <= 0) {
        it.live = false;
        it.gen = (it.gen + 1) & 0x3fffff;
        this.live--;
        this.mat4.compose(this.hidden, this.quat.identity(), this.unit);
        this.mesh.setMatrixAt(i, this.mat4);
        this.mesh.setColorAt(i, this.color.setRGB(0, 0, 0));
        continue;
      }
      if (!it.attached) {
        it.vel.y -= it.grav * dt;
        it.pos.addScaledVector(it.vel, dt);
        it.flown += it.vel.length() * dt;
      }
      if (it.trail > 0 && fx) {
        it.trailAcc += it.trail * fx.density * dt;
        while (it.trailAcc >= 1) {
          it.trailAcc -= 1;
          fx.roundTrailPuff(it.pos);
        }
      }
      this.write(i, it);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < MAX_TRACERS; i++) {
      const it = this.items[i];
      it.live = false;
      it.gen = (it.gen + 1) & 0x3fffff;
      this.mat4.compose(this.hidden, this.quat.identity(), this.unit);
      this.mesh.setMatrixAt(i, this.mat4);
      this.mesh.setColorAt(i, this.color.setRGB(0, 0, 0));
    }
    this.live = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// ground decals
// ---------------------------------------------------------------------------
//
// Craters and scorch marks projected onto the terrain with DecalGeometry, then
// packed into ONE mesh sharing ONE material — a mesh per crater would put forty
// draw calls on a renderer the audit says is already starving on them.
//
// DecalGeometry walks every triangle of whatever mesh it is handed, and the
// terrain is 33,800 of them, so it is not handed the terrain. It is handed a
// small patch rebuilt under each impact from the same analytic heightfield the
// terrain mesh was built from — sampled through the mesh's own triangulation,
// so the decal sits exactly on the surface being drawn rather than on the
// smooth function underneath it.

const DECAL_SLOTS = 40;
const DECAL_SLOT_VERTS = 264;
const DECAL_MAX_VERTS = DECAL_SLOTS * DECAL_SLOT_VERTS;
const PATCH_SEGS = 8;

class DecalField {
  constructor(scene) {
    this.scene = scene;
    this.pos = new Float32Array(DECAL_MAX_VERTS * 3);
    this.nrm = new Float32Array(DECAL_MAX_VERTS * 3);
    this.uv = new Float32Array(DECAL_MAX_VERTS * 2);
    // four components, so three.js compiles USE_COLOR_ALPHA and each decal can
    // fade in on its own without a second material
    this.col = new Float32Array(DECAL_MAX_VERTS * 4);
    for (let i = 0; i < DECAL_MAX_VERTS; i++) this.nrm[i * 3 + 1] = 1;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    geo.setDrawRange(0, 0);
    const mat = new THREE.MeshStandardMaterial({
      map: decalAtlas() || null,
      vertexColors: true,
      transparent: true,
      roughness: 0.96,
      metalness: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.FrontSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    // First of the transparent things, not last: smoke drawn after a crater
    // covers it, smoke drawn before it has the crater painted over the top —
    // which is how a scorch mark used to show straight through a smoke screen.
    this.mesh.renderOrder = -3;
    scene.add(this.mesh);

    this.slots = [];
    for (let i = 0; i < DECAL_SLOTS; i++) this.slots.push({ used: 0, age: 0, fadeIn: 0 });
    this.cursor = 0;
    this.usedHigh = 0;
    this.fading = [];

    // the patch the projector is aimed at, rebuilt in place under every impact
    const pg = new THREE.PlaneGeometry(1, 1, PATCH_SEGS, PATCH_SEGS);
    pg.rotateX(-Math.PI / 2);
    this.patchGeo = pg;
    this.patchMesh = new THREE.Mesh(pg, new THREE.MeshBasicMaterial());
    this.patchMesh.matrixAutoUpdate = false;
    this.patchMesh.updateMatrixWorld(true);
    this.projector = new THREE.Object3D();
    this.size = new THREE.Vector3();

    // the terrain mesh's own lattice, discovered lazily
    this.lattice = null;
    this.latticeTried = false;
  }

  // Find the battle's terrain so decals can be snapped to the triangles that
  // are actually drawn. buildTerrain makes an unnamed Mesh from a rotated
  // PlaneGeometry hundreds of metres across; nothing else in any battle is
  // remotely that big, so the shape of it is identification enough.
  findLattice() {
    if (this.lattice || this.latticeTried) return this.lattice;
    this.latticeTried = true;
    const kids = this.scene.children;
    for (let i = 0; i < kids.length; i++) {
      const o = kids[i];
      if (!o.isMesh || !o.geometry) continue;
      const p = o.geometry.parameters;
      if (o.geometry.type !== 'PlaneGeometry' || !p) continue;
      if (!(p.width >= 400) || !(p.widthSegments >= 8)) continue;
      this.lattice = {
        half: p.width * 0.5,
        q: p.width / p.widthSegments,
        segs: p.widthSegments,
        row: p.widthSegments + 1,
        pos: o.geometry.attributes.position,
      };
      break;
    }
    return this.lattice;
  }

  // Height of the drawn surface, not of the function. PlaneGeometry splits each
  // cell into (a,b,d) and (b,c,d); interpolating inside the right one of those
  // two is what keeps a crater from floating over a coarse air map.
  surfaceY(x, z) {
    const L = this.lattice;
    if (!L) return terrainHeight(x, z);
    const fx = (x + L.half) / L.q;
    const fz = (z + L.half) / L.q;
    let i = Math.floor(fx);
    let j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= L.segs || j >= L.segs) return terrainHeight(x, z);
    const u = fx - i;
    const v = fz - j;
    const P = L.pos;
    const ia = i + L.row * j;
    const ib = i + L.row * (j + 1);
    const ic = (i + 1) + L.row * (j + 1);
    const id = (i + 1) + L.row * j;
    if (u + v <= 1) {
      return P.getY(ia) * (1 - u - v) + P.getY(ib) * v + P.getY(id) * u;
    }
    const s = 1 - u;
    const t = 1 - v;
    return P.getY(ic) * (1 - s - t) + P.getY(ib) * s + P.getY(id) * t;
  }

  buildPatch(cx, cz, extent) {
    const g = this.patchGeo;
    const p = g.attributes.position;
    const n = PATCH_SEGS + 1;
    const step = extent / PATCH_SEGS;
    const x0 = cx - extent * 0.5;
    const z0 = cz - extent * 0.5;
    for (let j = 0; j < n; j++) {
      const z = z0 + j * step;
      for (let i = 0; i < n; i++) {
        const x = x0 + i * step;
        const k = i + j * n;
        p.setXYZ(k, x, this.surfaceY(x, z), z);
      }
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    g.attributes.normal.needsUpdate = true;
  }

  // kind indexes the atlas; colour tints it; roll spins it so two craters side
  // by side are not the same picture twice.
  add(pos, diameter, kind, colorHex, alpha = 1) {
    this.findLattice();
    const extent = Math.max(2, diameter * 2.1);
    const cx = pos.x;
    const cz = pos.z;
    this.buildPatch(cx, cz, extent);

    // aim the projector straight down the surface normal, with a random roll
    const y = this.surfaceY(cx, cz);
    const e = Math.max(0.35, extent * 0.06);
    const hL = this.surfaceY(cx - e, cz);
    const hR = this.surfaceY(cx + e, cz);
    const hD = this.surfaceY(cx, cz - e);
    const hU = this.surfaceY(cx, cz + e);
    tv.set(hL - hR, 2 * e, hD - hU).normalize();
    this.projector.position.set(cx, y, cz);
    this.projector.lookAt(cx + tv.x, y + tv.y, cz + tv.z);
    this.projector.rotation.z = Math.random() * TAU;
    this.size.set(diameter, diameter, Math.max(3, diameter * 1.2));

    let dg;
    try {
      dg = new DecalGeometry(this.patchMesh, this.projector.position, this.projector.rotation, this.size);
    } catch {
      return false;
    }
    const dp = dg.attributes.position;
    const dn = dg.attributes.normal;
    const du = dg.attributes.uv;
    let verts = dp ? dp.count : 0;
    if (!verts) {
      dg.dispose();
      return false;
    }
    // keep whole triangles only, and never more than the slot can hold
    if (verts > DECAL_SLOT_VERTS) verts = DECAL_SLOT_VERTS;
    verts -= verts % 3;
    if (verts < 3) {
      dg.dispose();
      return false;
    }

    const slotIdx = this.cursor;
    this.cursor = (this.cursor + 1) % DECAL_SLOTS;
    const slot = this.slots[slotIdx];
    const base = slotIdx * DECAL_SLOT_VERTS;

    const qx = (kind & 1) * 0.5;
    const qy = (kind >> 1) * 0.5;
    // inset two texels: without it the mip chain smears one decal into the next
    const uScale = 0.5 - 4 / 256;
    const uOff = 2 / 256;
    const cr = (((colorHex >> 16) & 255) / 255);
    const cg = (((colorHex >> 8) & 255) / 255);
    const cb = ((colorHex & 255) / 255);

    for (let i = 0; i < verts; i++) {
      const o3 = (base + i) * 3;
      const nx = dn ? dn.getX(i) : 0;
      const ny = dn ? dn.getY(i) : 1;
      const nz = dn ? dn.getZ(i) : 0;
      // lift off the surface: polygon offset alone loses on a shallow slope
      this.pos[o3] = dp.getX(i) + nx * 0.035;
      this.pos[o3 + 1] = dp.getY(i) + ny * 0.035;
      this.pos[o3 + 2] = dp.getZ(i) + nz * 0.035;
      this.nrm[o3] = nx;
      this.nrm[o3 + 1] = ny;
      this.nrm[o3 + 2] = nz;
      const o2 = (base + i) * 2;
      this.uv[o2] = qx + uOff + du.getX(i) * uScale;
      this.uv[o2 + 1] = qy + uOff + du.getY(i) * uScale;
      const o4 = (base + i) * 4;
      this.col[o4] = cr;
      this.col[o4 + 1] = cg;
      this.col[o4 + 2] = cb;
      this.col[o4 + 3] = 0;
    }
    // anything the decal did not fill collapses to a point and draws nothing
    for (let i = verts; i < slot.used; i++) {
      const o3 = (base + i) * 3;
      this.pos[o3] = 0;
      this.pos[o3 + 1] = HIDDEN_Y;
      this.pos[o3 + 2] = 0;
      this.col[(base + i) * 4 + 3] = 0;
    }
    const wrote = Math.max(verts, slot.used);
    slot.used = verts;
    slot.age = 0;
    slot.fadeIn = 0;
    slot.alpha = alpha;
    dg.dispose();

    const end = base + Math.max(verts, wrote);
    if (end > this.usedHigh) this.usedHigh = end;
    this.mesh.geometry.setDrawRange(0, this.usedHigh);
    const attrs = this.mesh.geometry.attributes;
    markRange(attrs.position, base * 3, wrote * 3);
    markRange(attrs.normal, base * 3, wrote * 3);
    markRange(attrs.uv, base * 2, wrote * 2);
    markRange(attrs.color, base * 4, wrote * 4);
    this.mesh.geometry.computeBoundingSphere();

    // dirt does not appear, it settles
    if (this.fading.length < DECAL_SLOTS) this.fading.push(slotIdx);
    return true;
  }

  update(dt) {
    if (!this.fading.length) return;
    const attrs = this.mesh.geometry.attributes;
    for (let k = this.fading.length - 1; k >= 0; k--) {
      const idx = this.fading[k];
      const slot = this.slots[idx];
      slot.fadeIn += dt;
      const a = clamp(slot.fadeIn / 0.35, 0, 1) * (slot.alpha != null ? slot.alpha : 1);
      const base = idx * DECAL_SLOT_VERTS;
      for (let i = 0; i < slot.used; i++) this.col[(base + i) * 4 + 3] = a;
      markRange(attrs.color, base * 4, slot.used * 4);
      if (slot.fadeIn >= 0.35) this.fading.splice(k, 1);
    }
  }

  clear() {
    for (let i = 0; i < DECAL_SLOTS; i++) this.slots[i].used = 0;
    this.pos.fill(0);
    this.col.fill(0);
    this.cursor = 0;
    this.usedHigh = 0;
    this.fading.length = 0;
    this.mesh.geometry.setDrawRange(0, 0);
    markFullUpload(this.mesh.geometry.attributes.position);
    markFullUpload(this.mesh.geometry.attributes.color);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.patchGeo.dispose();
    this.patchMesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// track prints (X-07)
// ---------------------------------------------------------------------------
//
// "The battlefield remembers": every metre a tank travels lays two quads on
// the ground, one per track, the spec's track width wide, onto the drawn
// terrain surface (the same lattice sampler the craters use, so a print sits
// ON the triangles being drawn, not on the smooth function under them). They
// go into one ring buffer in one BufferGeometry — the whole field is one draw
// call however many tanks have driven where — and the oldest tenth fades out
// before its slots are recycled, so a print never pops.
//
// The material MULTIPLIES what is already in the frame: dst = dst x k, with k
// the surface's compaction factor (soil x0.75-0.85, sand x0.9, snow x0.8) and
// a relief term from the grouser map lit by the map's own sun. So the print
// is the ground's own colour, its own shadows and its own fog, made a shade
// darker where it was pressed — it cannot glow, cannot be the wrong colour
// for the biome, and costs one texture fetch. (Not the MeshStandardMaterial
// the backlog sketched: a lit decal would have to know the terrain's albedo
// per fragment, which only the terrain shader does.)
//
// Off on the low tier (the frame goes straight to the sRGB canvas there,
// where a multiply is not linear, and the budget is tight); 8,192 quads on
// medium, 16,384 on high (backlog 4.3): 4.1 / 8.2 km of tank travel, which is
// ~85 / ~170 s of sixteen tanks averaging 3 m/s.

// Quads in the ring (2 per metre a tank travels). The backlog's 4.3 table
// says 8,192 on medium, but that ring holds only ~73-85 s of 16 tanks at
// 3-3.5 m/s, which fails X-07's own ">= 120 s" Accept line; 14,336 holds
// 128-149 s for +1.4 MB and the same one draw. (Designer: update the 4.3 row.)
const PRINT_CAP = { low: 0, medium: 14336, high: 16384 };
const PRINT_STEP = 1.0;        // m of travel per cross-section
const PRINT_TEX_LEN = 0.6;     // m of track per texture repeat (4 grousers)
const PRINT_LIFT = 0.03;       // m off the drawn surface, plus polygon offset
const PRINT_RANGE = 430;       // laid only inside the crater range
const PRINT_FADE = 0.1;        // oldest share of the ring fading out
const PRINT_SPLIT = (10 * Math.PI) / 180; // split a quad on a 10 deg crease
const PRINT_FAR = 260;         // m from the camera where a print has faded
const MAX_PRINT_CURSORS = 40;
const PRINT_JUMP = 6;          // m moved between calls: a respawn, not travel

// albedo factor and relief strength by surface type (AV-03: the same lookup
// that colours the dust picks these). Darker than the backlog's soil
// x0.75-0.85 on grass and stubble: there the drawn ground is the pale cover
// layer, and a track cuts through it to the compacted soil underneath (at
// x0.82 the browser check could not find the prints at 10 m). Bare soil and
// sand are pressed, not exposed; on snow the relief does most of the work.
const PRINT_LOOK = {
  grass: [0.6, 1.0], dirt: [0.68, 1.0], mud: [0.62, 1.1], sand: [0.8, 1.1],
  snow: [0.82, 1.8], rock: [0.92, 0.3], concrete: [0.95, 0.2],
};

let printTex;
// The grouser imprint: bars across the track every 0.15 m, pressed in, with
// the soil squeezed up a little at the edges of the run. RGBA bytes: RG the
// tangent-space normal (x across, y along), B the height, A the coverage.
// Raw data, not a canvas — a 2D canvas premultiplies, which would wreck the
// normal where the coverage fades out at the edges.
function trackPrintTexture() {
  if (printTex !== undefined) return printTex;
  const W = 32;  // across
  const H = 64;  // along, PRINT_TEX_LEN metres
  const hgt = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const v = (y + 0.5) / H;
      const ph = (v * 4) % 1; // four grousers per repeat
      const groove = smoothT(clamp(ph / 0.12, 0, 1)) * (1 - smoothT(clamp((ph - 0.38) / 0.12, 0, 1)));
      const edge = Math.exp(-((u - 0.04) * (u - 0.04)) / 0.002) + Math.exp(-((u - 0.96) * (u - 0.96)) / 0.002);
      const grit = vnoise(u * 9, v * 18, 911) - 0.5;
      hgt[y * W + x] = 0.75 - 0.6 * groove + 0.25 * edge + 0.08 * grit;
    }
  }
  const data = new Uint8Array(W * H * 4);
  const S = 2.2; // slope gain into the normal
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const xl = Math.max(0, x - 1);
      const xr = Math.min(W - 1, x + 1);
      const yd = (y + H - 1) % H;
      const yu = (y + 1) % H;
      const du = (hgt[y * W + xr] - hgt[y * W + xl]) * 0.5;
      const dv = (hgt[yu * W + x] - hgt[yd * W + x]) * 0.5;
      let nx = -du * S;
      let ny = -dv * S;
      const nl = Math.hypot(nx, ny, 1);
      nx /= nl;
      ny /= nl;
      const u = (x + 0.5) / W;
      const cover = smoothT(clamp(u / 0.08, 0, 1)) * smoothT(clamp((1 - u) / 0.08, 0, 1))
        * (0.82 + 0.18 * vnoise(u * 6, ((y + 0.5) / H) * 7, 457));
      const i = (y * W + x) * 4;
      data[i] = Math.round((0.5 + 0.5 * nx) * 255);
      data[i + 1] = Math.round((0.5 + 0.5 * ny) * 255);
      data[i + 2] = Math.round(clamp(hgt[y * W + x], 0, 1) * 255);
      data[i + 3] = Math.round(clamp(cover, 0, 1) * 255);
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  // cached for the session: a battle teardown sweep must leave it alone
  markShared(t);
  printTex = t;
  return t;
}

const PRINT_VS = /* glsl */`
attribute vec2 aTan;
attribute vec3 aPrint;
uniform float uHead;
uniform float uCap;
uniform float uFade;
uniform float uFar;
varying vec2 vUv;
varying vec2 vTan;
varying float vA;
varying float vK;
varying float vRelief;
void main() {
	vUv = uv;
	vTan = aTan;
	vK = aPrint.y;
	vRelief = aPrint.z;
	// age through the ring, 0 newest .. 1 about to be recycled
	float age = ( uHead - aPrint.x ) / uCap;
	vec4 wp = modelMatrix * vec4( position, 1.0 );
	float far = 1.0 - smoothstep( uFar * 0.6, uFar, distance( wp.xyz, cameraPosition ) );
	vA = clamp( ( 1.0 - age ) / uFade, 0.0, 1.0 ) * far;
	gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const PRINT_FS = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uSun;
uniform float uAmb;
uniform float uSunY;
uniform float uEncode;
varying vec2 vUv;
varying vec2 vTan;
varying float vA;
varying float vK;
varying float vRelief;
void main() {
	vec4 t = texture2D( uMap, vUv );
	float cover = t.a * vA;
	if ( cover < 0.004 ) discard;
	vec2 nt = ( t.rg * 2.0 - 1.0 ) * vRelief;
	vec3 T = vec3( vTan.x, 0.0, vTan.y );
	vec3 B = vec3( vTan.y, 0.0, - vTan.x );
	vec3 N = normalize( vec3( 0.0, 1.0, 0.0 ) + B * nt.x + T * nt.y );
	// the pressed surface against the flat one it replaced, under the same
	// sky and sun: >1 on the faces turned to the sun, <1 in the grooves' lee
	float lit = uAmb + uSunY * max( dot( N, uSun ), 0.0 );
	float flatLit = uAmb + uSunY * max( uSun.y, 0.0 );
	float shade = lit / max( flatLit, 1e-4 );
	// compacted, moister soil is darkest at the bottom of the grooves
	float k = mix( 1.0, vK, 0.6 + 0.4 * ( 1.0 - t.b ) ) * shade;
	k = mix( 1.0, k, cover );
	if ( uEncode > 0.5 ) k = pow( max( k, 0.0 ), 1.0 / 2.2 );
	gl_FragColor = vec4( vec3( k ), 1.0 );
}
`;

class TrackPrintField {
  constructor(scene, capacity, ground, fxU) {
    this.cap = capacity;
    this.ground = ground; // DecalField: the drawn-surface sampler
    const nv = capacity * 4;
    this.pos = new Float32Array(nv * 3);
    this.uv = new Float32Array(nv * 2);
    this.tan = new Float32Array(nv * 2);
    this.aux = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) this.pos[i * 3 + 1] = HIDDEN_Y;
    const index = new Uint16Array(capacity * 6);
    for (let q = 0; q < capacity; q++) {
      const v = q * 4;
      index.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
    }
    const geo = new THREE.BufferGeometry();
    const dyn = (arr, n) => {
      const a = new THREE.BufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    geo.setAttribute('position', dyn(this.pos, 3));
    geo.setAttribute('uv', dyn(this.uv, 2));
    geo.setAttribute('aTan', dyn(this.tan, 2));
    geo.setAttribute('aPrint', dyn(this.aux, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, 0);
    this.uniforms = {
      uMap: { value: trackPrintTexture() },
      uHead: { value: 0 },
      uCap: { value: capacity },
      uFade: { value: PRINT_FADE },
      uFar: { value: PRINT_FAR },
      uSun: fxU.uFxSun,
      uAmb: { value: 0.3 },
      uSunY: { value: 1 },
      uEncode: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: PRINT_VS,
      fragmentShader: PRINT_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.raycast = noRaycast;
    // the ground's own layer: before the craters and every transparent effect
    this.mesh.renderOrder = -4;
    // a multiply into the sRGB canvas (no post chain) is done in sRGB space:
    // hand the shader the encoded factor there
    const U = this.uniforms;
    this.mesh.onBeforeRender = (renderer) => {
      const rt = renderer && renderer.getRenderTarget ? renderer.getRenderTarget() : null;
      U.uEncode.value = rt ? 0 : 1;
    };
    scene.add(this.mesh);

    this.head = 0;        // serial of the next quad
    this.dirtyFrom = -1;  // first serial written since the last upload
    this.cursors = [];
    for (let i = 0; i < MAX_PRINT_CURSORS; i++) {
      this.cursors.push({
        live: false, seen: -1, lastX: 0, lastZ: 0,
        px: 0, pz: 0, yaw: 0, dist: 0, surfAt: -1e9, k: 0.8, relief: 0.45,
        // the end cross-section of the last quad on each side, reused as
        // the start of the next: [x0, y0, z0, x1, y1, z1] per side
        edge: new Float32Array(12), edgeOk: false,
      });
    }
    this.cross = new Float32Array(6);
    this.stats = { quads: 0, splits: 0 };
  }

  setLight(ambY, sunY) {
    this.uniforms.uAmb.value = ambY;
    this.uniforms.uSunY.value = sunY;
  }

  // The cursor following this tank: the live one whose last call was within
  // a few metres of here, else a fresh one (the stalest is recycled).
  cursorFor(x, z, now) {
    let best = null;
    let bestD = 9;
    let stale = null;
    let staleT = Infinity;
    for (let i = 0; i < MAX_PRINT_CURSORS; i++) {
      const c = this.cursors[i];
      if (c.live && now - c.seen < 0.75) {
        const dx = c.lastX - x;
        const dz = c.lastZ - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      } else if (!c.live || c.seen < staleT) {
        staleT = c.live ? c.seen : -Infinity;
        stale = c;
      }
    }
    if (best) return best;
    const c = stale || this.cursors[0];
    c.live = true;
    c.seen = now;
    c.lastX = x;
    c.lastZ = z;
    c.px = x;
    c.pz = z;
    c.dist = 0;
    c.edgeOk = false;
    c.surfAt = -1e9;
    c.fresh = true;
    return c;
  }

  // One tank's call for this frame. `look(x, z)` is the effects system's
  // surface lookup, asked once every few metres per tank.
  track(x, z, yaw, gauge, trackW, now, lookFn) {
    this.ground.findLattice();
    const c = this.cursorFor(x, z, now);
    if (c.fresh) {
      c.fresh = false;
      c.yaw = yaw;
      return;
    }
    c.seen = now;
    c.lastX = x;
    c.lastZ = z;
    let dx = x - c.px;
    let dz = z - c.pz;
    let d = Math.sqrt(dx * dx + dz * dz);
    if (d > PRINT_JUMP) {
      // respawned or teleported: start again here
      c.px = x;
      c.pz = z;
      c.yaw = yaw;
      c.edgeOk = false;
      return;
    }
    while (d >= PRINT_STEP) {
      const f = PRINT_STEP / d;
      const nx = c.px + dx * f;
      const nz = c.pz + dz * f;
      let dy = yaw - c.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const yEnd = c.yaw + dy * f;
      if (c.dist - c.surfAt >= 4) {
        c.surfAt = c.dist;
        const lk = lookFn(nx, nz);
        c.k = lk.printK;
        c.relief = lk.printRelief;
      }
      if (Math.abs(nx) < PRINT_RANGE && Math.abs(nz) < PRINT_RANGE) {
        this.lay(c, nx, nz, yEnd, dx / d, dz / d, gauge, trackW);
      } else {
        c.edgeOk = false;
      }
      c.px = nx;
      c.pz = nz;
      c.yaw = yEnd;
      c.dist += PRINT_STEP;
      dx = x - c.px;
      dz = z - c.pz;
      d = Math.sqrt(dx * dx + dz * dz);
    }
  }

  surfaceY(x, z) {
    return this.ground.surfaceY(x, z) + PRINT_LIFT;
  }

  // The two edges of one track's run, centred `side * gauge/2` off the
  // hull's centre line across `yaw`, laid on the surface. The run is tw wide
  // ALONG the ground: on a cross slope the horizontal span is pulled in so
  // the 3D width stays the track's width.
  crossSection(cx, cz, yaw, side, gauge, tw, out, o) {
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const mx = cx + rx * side * gauge * 0.5;
    const mz = cz + rz * side * gauge * 0.5;
    let hw = tw * 0.5;
    let y0 = this.surfaceY(mx - rx * hw, mz - rz * hw);
    let y1 = this.surfaceY(mx + rx * hw, mz + rz * hw);
    const w3 = Math.sqrt(tw * tw + (y1 - y0) * (y1 - y0));
    if (w3 > tw * 1.002) {
      hw *= tw / w3;
      y0 = this.surfaceY(mx - rx * hw, mz - rz * hw);
      y1 = this.surfaceY(mx + rx * hw, mz + rz * hw);
    }
    out[o] = mx - rx * hw;
    out[o + 1] = y0;
    out[o + 2] = mz - rz * hw;
    out[o + 3] = mx + rx * hw;
    out[o + 4] = y1;
    out[o + 5] = mz + rz * hw;
  }

  lay(c, nx, nz, yEnd, ux, uz, gauge, tw) {
    const E = c.edge;
    const X = this.cross;
    const v0 = c.dist / PRINT_TEX_LEN;
    const v1 = (c.dist + PRINT_STEP) / PRINT_TEX_LEN;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const o = s * 6;
      if (!c.edgeOk) this.crossSection(c.px, c.pz, c.yaw, side, gauge, tw, E, o);
      this.crossSection(nx, nz, yEnd, side, gauge, tw, X, 0);
      // a crease across the run (a lattice edge, a crest): split at the middle
      // so the print bends with the ground instead of bridging or burying
      const ys = (E[o + 1] + E[o + 4]) * 0.5;
      const ye = (X[1] + X[4]) * 0.5;
      const mx = (c.px + nx) * 0.5;
      const mz = (c.pz + nz) * 0.5;
      const rx = Math.cos(yEnd);
      const rz = -Math.sin(yEnd);
      const ym = this.surfaceY(mx + rx * side * gauge * 0.5, mz + rz * side * gauge * 0.5);
      const a0 = Math.atan2(ym - ys, PRINT_STEP * 0.5);
      const a1 = Math.atan2(ye - ym, PRINT_STEP * 0.5);
      if (Math.abs(a1 - a0) > PRINT_SPLIT) {
        const M = this.mid || (this.mid = new Float32Array(6));
        let dy = yEnd - c.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        this.crossSection(mx, mz, c.yaw + dy * 0.5, side, gauge, tw, M, 0);
        const vm = (v0 + v1) * 0.5;
        this.quad(E, o, M, 0, v0, vm, ux, uz, c.k, c.relief);
        this.quad(M, 0, X, 0, vm, v1, ux, uz, c.k, c.relief);
        this.stats.splits++;
      } else {
        this.quad(E, o, X, 0, v0, v1, ux, uz, c.k, c.relief);
      }
      for (let k = 0; k < 6; k++) E[o + k] = X[k];
    }
    c.edgeOk = true;
  }

  // Write one quad into the ring: start edge A (2 points), end edge B.
  quad(A, ao, B, bo, v0, v1, ux, uz, k, relief) {
    const q = this.head % this.cap;
    const serial = this.head;
    this.head++;
    this.stats.quads++;
    const P = this.pos;
    const b3 = q * 12;
    // A.left, A.right, B.right, B.left
    P[b3] = A[ao]; P[b3 + 1] = A[ao + 1]; P[b3 + 2] = A[ao + 2];
    P[b3 + 3] = A[ao + 3]; P[b3 + 4] = A[ao + 4]; P[b3 + 5] = A[ao + 5];
    P[b3 + 6] = B[bo + 3]; P[b3 + 7] = B[bo + 4]; P[b3 + 8] = B[bo + 5];
    P[b3 + 9] = B[bo]; P[b3 + 10] = B[bo + 1]; P[b3 + 11] = B[bo + 2];
    const U = this.uv;
    const b2 = q * 8;
    U[b2] = 0; U[b2 + 1] = v0;
    U[b2 + 2] = 1; U[b2 + 3] = v0;
    U[b2 + 4] = 1; U[b2 + 5] = v1;
    U[b2 + 6] = 0; U[b2 + 7] = v1;
    const T = this.tan;
    for (let j = 0; j < 4; j++) {
      T[b2 + j * 2] = ux;
      T[b2 + j * 2 + 1] = uz;
    }
    const X = this.aux;
    const b3a = q * 12;
    for (let j = 0; j < 4; j++) {
      X[b3a + j * 3] = serial;
      X[b3a + j * 3 + 1] = k;
      X[b3a + j * 3 + 2] = relief;
    }
    // the slots written since the last upload run from serial dirtyFrom on
    if (this.dirtyFrom < 0) this.dirtyFrom = serial;
  }

  // Upload what was written since last frame: one contiguous stretch of the
  // ring, or two when it wrapped round the end.
  update() {
    this.uniforms.uHead.value = this.head - 1;
    if (this.dirtyFrom < 0) return;
    const g = this.mesh.geometry;
    const n = this.head - this.dirtyFrom;
    this.dirtyFrom = -1;
    if (n >= this.cap) {
      this.uploadSlots(0, this.cap - 1);
    } else {
      const lo = (this.head - n) % this.cap;
      const hi = (this.head - 1) % this.cap;
      if (hi >= lo) {
        this.uploadSlots(lo, hi);
      } else {
        this.uploadSlots(lo, this.cap - 1);
        this.uploadSlots(0, hi);
      }
    }
    g.setDrawRange(0, Math.min(this.head, this.cap) * 6);
  }

  uploadSlots(lo, hi) {
    const A = this.mesh.geometry.attributes;
    const n = hi - lo + 1;
    markRange(A.position, lo * 12, n * 12);
    markRange(A.uv, lo * 8, n * 8);
    markRange(A.aTan, lo * 8, n * 8);
    markRange(A.aPrint, lo * 12, n * 12);
  }

  clear() {
    this.head = 0;
    for (let i = 0; i < MAX_PRINT_CURSORS; i++) this.cursors[i].live = false;
    this.pos.fill(0);
    for (let i = 0; i < this.cap * 4; i++) this.pos[i * 3 + 1] = HIDDEN_Y;
    this.dirtyFrom = -1;
    const g = this.mesh.geometry;
    g.setDrawRange(0, 0);
    markFullUpload(g.attributes.position);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// fire glow on the ground (X-05)
// ---------------------------------------------------------------------------
//
// A burning hulk lights the ground round it — without a light. Under every
// registered wreck sits an additive glow patch, laid on the drawn surface
// like a crater, coloured by a ~1,900 K flame and by the ground's own albedo
// (it is fire light REFLECTED by the ground, so its ratio to the daylight on
// that same ground does not depend on how dark the ground is), and flickering
// with the flame emission at 2-6 Hz. Its peak irradiance is fixed in the
// battle rig's own units (a white card under the fire reads GLOW_E): that is
// under 2x the noon ground beside it (fire is barely visible in daylight) and
// over 4x the ground at dusk. Clamped below the bloom threshold (L-05) so a
// snowfield cannot blow out. One draw for every wreck; no PointLight.

const GLOW_SLOTS = 26;       // = MAX_WRECKS
const GLOW_GRID = 9;         // vertices per side of a patch
const GLOW_HALF = 10;        // m, half the patch
const GLOW_H = 4;            // m, height of the flame's centre above the ground
const GLOW_E = 0.75;         // peak, in white-card radiance units (preset.light)
const GLOW_K = 1900;         // flame colour temperature

// ground albedo (linear Y) by surface, for the reflected glow
const GROUND_ALBEDO = { grass: 0.16, dirt: 0.15, mud: 0.1, sand: 0.33, snow: 0.7, rock: 0.22, concrete: 0.3 };

const GLOW_VS = /* glsl */`
attribute float aSlot;
uniform float uGlow[ ${GLOW_SLOTS} ];
varying vec2 vQ;
varying float vG;
varying float vFar;
#include <common>
void main() {
	vQ = uv * 2.0 - 1.0;
	vG = uGlow[ int( aSlot + 0.5 ) ];
	vec4 wp = modelMatrix * vec4( position, 1.0 );
	vFar = 1.0 - smoothstep( 900.0, 1600.0, distance( wp.xyz, cameraPosition ) );
	gl_Position = projectionMatrix * viewMatrix * wp;
	if ( vG <= 0.0 ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
}
`;

const GLOW_FS = /* glsl */`
uniform vec3 uGlowCol;
uniform float uMax;
varying vec2 vQ;
varying float vG;
varying float vFar;
#include <common>
void main() {
	float r = length( vQ ) * ${GLOW_HALF.toFixed(1)};
	float h = ${GLOW_H.toFixed(1)};
	// irradiance under a source h above the ground, normalised to 1 under it
	float e = h * h * h / pow( h * h + r * r, 1.5 );
	e *= 1.0 - smoothstep( ${(GLOW_HALF * 0.75).toFixed(2)}, ${GLOW_HALF.toFixed(1)}, r );
	vec3 c = uGlowCol * ( e * vG * vFar );
	// never past the bloom threshold: a snowfield does not turn into a lamp
	float y = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	if ( y > uMax ) c *= uMax / y;
	if ( y < 1e-5 ) discard;
	gl_FragColor = vec4( c, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

class GlowField {
  constructor(scene, ground) {
    this.ground = ground;
    const per = GLOW_GRID * GLOW_GRID;
    const nv = GLOW_SLOTS * per;
    this.pos = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const slot = new Float32Array(nv);
    const cells = GLOW_GRID - 1;
    const index = new Uint16Array(GLOW_SLOTS * cells * cells * 6);
    let ii = 0;
    for (let s = 0; s < GLOW_SLOTS; s++) {
      const base = s * per;
      for (let j = 0; j < GLOW_GRID; j++) {
        for (let i = 0; i < GLOW_GRID; i++) {
          const k = base + j * GLOW_GRID + i;
          uv[k * 2] = i / cells;
          uv[k * 2 + 1] = j / cells;
          slot[k] = s;
          this.pos[k * 3 + 1] = HIDDEN_Y;
        }
      }
      for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
          const a = base + j * GLOW_GRID + i;
          const b = a + 1;
          const c = a + GLOW_GRID;
          const d = c + 1;
          index[ii++] = a; index[ii++] = c; index[ii++] = b;
          index[ii++] = b; index[ii++] = c; index[ii++] = d;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.level = new Float32Array(GLOW_SLOTS);
    const fire = planckianLinear(GLOW_K);
    const fy = 0.2126 * fire[0] + 0.7152 * fire[1] + 0.0722 * fire[2];
    // linear colour of luminance 1 at the flame's temperature
    this.fireCol = [fire[0] / fy, fire[1] / fy, fire[2] / fy];
    this.uniforms = {
      uGlow: { value: this.level },
      uGlowCol: { value: new THREE.Vector3(1, 0.5, 0.2) },
      uMax: { value: 0.7 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: GLOW_VS,
      fragmentShader: GLOW_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.raycast = noRaycast;
    this.mesh.renderOrder = -3;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.used = 0;
    this.setGround('grass', 0.7);
  }

  // The ground the fire lights, and the bloom threshold it must stay under.
  setGround(type, bloomThreshold) {
    const alb = GROUND_ALBEDO[type] != null ? GROUND_ALBEDO[type] : 0.16;
    const k = GLOW_E * alb;
    this.uniforms.uGlowCol.value.set(this.fireCol[0] * k, this.fireCol[1] * k, this.fireCol[2] * k);
    this.uniforms.uMax.value = Math.max(0.05, (bloomThreshold || 0.7) * 0.95);
  }

  // Lay slot s's patch on the drawn ground round (x, z).
  place(s, x, z) {
    if (s < 0 || s >= GLOW_SLOTS) return;
    this.ground.findLattice();
    const per = GLOW_GRID * GLOW_GRID;
    const cells = GLOW_GRID - 1;
    for (let j = 0; j < GLOW_GRID; j++) {
      for (let i = 0; i < GLOW_GRID; i++) {
        const k = s * per + j * GLOW_GRID + i;
        const px = x + (i / cells * 2 - 1) * GLOW_HALF;
        const pz = z + (j / cells * 2 - 1) * GLOW_HALF;
        this.pos[k * 3] = px;
        this.pos[k * 3 + 1] = this.ground.surfaceY(px, pz) + 0.06;
        this.pos[k * 3 + 2] = pz;
      }
    }
    markRange(this.mesh.geometry.attributes.position, s * per * 3, per * 3);
    this.mesh.geometry.computeBoundingSphere();
    if (s + 1 > this.used) this.used = s + 1;
    this.mesh.visible = true;
  }

  set(s, v) {
    if (s >= 0 && s < GLOW_SLOTS) this.level[s] = v;
  }

  clear() {
    this.level.fill(0);
    this.used = 0;
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// smoke-screen volume core
// ---------------------------------------------------------------------------
//
// The body of every live smoke screen, drawn as the analytic volume the
// sight-line query integrates (see the block at the top), by slicing it.
//
// Each screen's view-space bounding box is cut into CORE_SLICES slabs between
// planes of constant view depth. Each slab is one camera-facing quad placed at
// its FRONT plane, and every fragment of it integrates the density along its
// own view ray between the slab's two planes — in closed form, so the slabs
// add up to the exact integral with nothing missed or counted twice. The quad
// is depth-tested against whatever solid thing is in the scene, so a slab is
// drawn over an object exactly when it starts in front of it. Hence, for any
// object anywhere — behind the screen, in front of it, inside it, with the
// camera outside or inside — the optical depth painted over it is at least
// the true optical depth between the camera and it, and at most one slab more
// (3 m across a grenade screen). That is the 95 % guarantee with no exceptions,
// and it is also why a tank driving into a screen fades out rather than
// vanishing on the spot.
//
// The rim billows: per slab the volume is drawn up to CORE_RIM times larger
// and up to 1.6 times denser, by drifting noise. Scaling an ellipsoid up and
// its peak density up only ever adds smoke at every point, so the noise can
// never thin the picture
// below what the game uses — and it is what keeps the outline from being a
// perfect ellipse. The screen's billboards are drawn on top (renderOrder -2
// puts the slabs first), and are the lumpy surface; puffs on the far side
// fade behind the slabs through their own smoke veil.
//
// One instanced draw for every slab of every screen; nothing while no screen
// is out. Slabs entirely behind the camera, or off screen, collapse in the
// vertex shader before they cost a single fragment.

const CORE_VS = /* glsl */`
${FX_SMOKE_UNIFORMS}
#define FX_SLICES ${CORE_SLICES}
#define FX_RIM ${CORE_RIM.toFixed(3)}
flat varying vec4 vCoreA;
flat varying vec4 vCoreB;
flat varying vec2 vCoreSlab;
varying vec3 vCoreView;
#include <common>
#include <fog_pars_vertex>
void main() {
	int j = gl_InstanceID / FX_SLICES;
	// back to front, so the slabs of one screen composite in order
	int k = FX_SLICES - 1 - ( gl_InstanceID - j * FX_SLICES );
	vec4 mvPosition = vec4( 0.0, 0.0, - 1.0, 1.0 );
	bool live = false;
	vCoreA = vec4( 0.0 );
	vCoreB = vec4( 1.0 );
	vCoreSlab = vec2( 0.0 );
	vCoreView = vec3( 0.0, 0.0, - 1.0 );
	if ( j < uSmkN ) {
		vec4 A = uSmkA[ j ];
		vec4 B = uSmkB[ j ];
		// The largest the noisy rim can grow, in view space, as its shape
		// matrix S = R diag(r^2) R^T: the extent along view axis i is
		// sqrt(S_ii), and a plane of constant view depth cuts it in an ellipse
		// whose centre slides by S_iz / S_zz per metre of depth and whose
		// half-width is sqrt(S_ii - S_iz^2 / S_zz) times sqrt(1 - dz^2 / S_zz).
		vec3 r2 = vec3( B.x, B.y, B.x ) * FX_RIM;
		r2 *= r2;
		mat3 R = mat3( viewMatrix );
		vec3 rx = vec3( R[ 0 ][ 0 ], R[ 1 ][ 0 ], R[ 2 ][ 0 ] );
		vec3 ry = vec3( R[ 0 ][ 1 ], R[ 1 ][ 1 ], R[ 2 ][ 1 ] );
		vec3 rz = vec3( R[ 0 ][ 2 ], R[ 1 ][ 2 ], R[ 2 ][ 2 ] );
		float Szz = dot( rz * rz, r2 );
		vec2 Sii = vec2( dot( rx * rx, r2 ), dot( ry * ry, r2 ) );
		vec2 Siz = vec2( dot( rx * rz, r2 ), dot( ry * rz, r2 ) );
		vec3 c = ( viewMatrix * vec4( A.xyz, 1.0 ) ).xyz;
		float D = - c.z;
		float ez = sqrt( Szz );
		float camNear = projectionMatrix[ 3 ][ 2 ] / ( projectionMatrix[ 2 ][ 2 ] - 1.0 );
		float zN = D - ez;
		float zF = D + ez;
		float d0 = mix( zN, zF, float( k ) / float( FX_SLICES ) );
		float d1 = mix( zN, zF, float( k + 1 ) / float( FX_SLICES ) );
		// a slab reaching back to the camera is drawn just past the near plane
		float dq = max( d0, camNear * 1.5 );
		if ( A.w > 0.0 && d1 > dq ) {
			// this slab's part of the volume: cross-sections between its two
			// planes, centres at both ends, widest where it is nearest the middle
			float dLo = D - d1;
			float dHi = D - d0;
			float dMid = clamp( 0.0, dLo, dHi );
			vec2 h = sqrt( max( Sii - Siz * Siz / Szz, vec2( 0.0 ) ) ) * sqrt( max( 1.0 - dMid * dMid / Szz, 0.0 ) );
			vec2 cA = c.xy + Siz / Szz * dLo;
			vec2 cB = c.xy + Siz / Szz * dHi;
			vec2 lo = min( cA, cB ) - h;
			vec2 hi = max( cA, cB ) + h;
			// projected from wherever in the slab it lies onto the plane at dq
			float zLo = max( d0, dq );
			float zHi = d1;
			float fLo = dq / zHi;
			float fHi = dq / zLo;
			vec2 qa = min( lo * fLo, lo * fHi );
			vec2 qb = max( hi * fLo, hi * fHi );
			vec2 fr = vec2( 1.0 / projectionMatrix[ 0 ][ 0 ], 1.0 / projectionMatrix[ 1 ][ 1 ] ) * dq * 1.02;
			if ( d0 < dq ) {
				qa = - fr;
				qb = fr;
			}
			qa = max( qa, - fr );
			qb = min( qb, fr );
			if ( qa.x < qb.x && qa.y < qb.y ) {
				mvPosition = vec4( mix( qa, qb, position.xy + 0.5 ), - dq, 1.0 );
				live = true;
				vCoreA = A;
				vCoreB = B;
				// the slab pulled forward to the near plane takes everything
				// from the camera on, including any thinner slab in front of
				// it that ended too close to be drawn at all
				vCoreSlab = vec2( d0 < dq ? 0.0 : d0, d1 );
				vCoreView = mvPosition.xyz;
			}
		}
	}
	gl_Position = live ? projectionMatrix * mvPosition : vec4( 0.0, 0.0, 2.0, 1.0 );
	#include <fog_vertex>
}
`;

const CORE_FS = /* glsl */`
#define FX_RIM ${CORE_RIM.toFixed(3)}
uniform float uSmkKappa;
uniform float uFxTime;
uniform vec3 uFxSun;
uniform vec3 uFxAmb;
uniform vec3 uFxSunCol;
uniform vec2 uSmkWind;
uniform vec3 uCoreCol;
uniform float uCoreLit;
flat varying vec4 vCoreA;
flat varying vec4 vCoreB;
flat varying vec2 vCoreSlab;
varying vec3 vCoreView;
#include <common>
#include <fog_pars_fragment>
${FX_SMOKE_SEG}
${FX_NOISE}
void main() {
	float vl = length( vCoreView );
	float cosT = max( - vCoreView.z / vl, 1e-4 );
	vec3 rd = normalize( transpose( mat3( viewMatrix ) ) * vCoreView );
	float ta = vCoreSlab.x / cosT;
	float tb = vCoreSlab.y / cosT;
	vec3 pm = cameraPosition + rd * ( 0.5 * ( ta + tb ) );
	// noise rides the wind and rises, so the rim boils instead of sitting still
	vec3 np = pm * 0.21 - vec3( uSmkWind.x, 0.35, uSmkWind.y ) * ( uFxTime * 0.21 ) + vec3( vCoreB.w * 7.31 );
	float n = 0.62 * fxNoise3( np ) + 0.38 * fxNoise3( np * 2.07 + vec3( 13.1 ) );
	// Grow, never shrink: a bigger ellipsoid with a higher peak density holds
	// at least as much smoke at every point as the one the game tests, so the
	// lobes this adds can only ever thicken the picture.
	float nk = clamp( n * 1.25 - 0.1, 0.0, 1.0 );
	float s = 1.0 + ( FX_RIM - 1.0 ) * nk;
	vec4 Av = vec4( vCoreA.xyz, vCoreA.w * ( 1.0 + 0.6 * nk ) );
	vec4 Bv = vec4( vCoreB.x * s, vCoreB.y * s, vCoreB.z, vCoreB.w );
	float t0;
	float t1;
	float tau = fxSmokeSeg( cameraPosition, rd, ta, tb, Av, Bv, t0, t1 );
	if ( tau <= 0.0 ) discard;
	float alpha = 1.0 - exp( - uSmkKappa * tau );
	if ( alpha < 0.002 ) discard;
	// Lit like the billboards: sky ambient plus wrapped sun, with the
	// position in the volume standing in for the normal (the sunward side of
	// the cloud is the bright side), darker underneath, mottled by the noise.
	vec3 radii = vec3( Bv.x, Bv.y, Bv.x );
	vec3 q = ( cameraPosition + rd * ( 0.5 * ( t0 + t1 ) ) - vCoreA.xyz ) / radii;
	float sunK = clamp( ( dot( q, uFxSun ) + 0.5 ) / 1.5, 0.0, 1.0 );
	vec3 light = mix( vec3( 1.0 ), uFxAmb + uFxSunCol * sunK, uCoreLit )
		* mix( 0.8, 1.04, smoothstep( - 0.5, 0.9, q.y ) ) * mix( 0.8, 1.12, n );
	gl_FragColor = vec4( uCoreCol * light, alpha );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}
`;

class SmokeCore {
  constructor(scene, shared) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(QUAD_INDEX);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(QUAD_CORNERS, 3));
    geo.instanceCount = 0;
    this.colU = { value: new THREE.Vector3(0.55, 0.57, 0.54) };
    const uniforms = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    sharedFxUniforms(uniforms, shared);
    uniforms.uSmkWind = shared.uSmkWind;
    uniforms.uCoreCol = this.colU;
    uniforms.uCoreLit = { value: 1 };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: CORE_VS,
      fragmentShader: CORE_FS,
      transparent: true,
      depthWrite: false,
      // the slabs are built facing the camera; DoubleSide only so that no
      // winding slip could ever cull the volume away
      side: THREE.DoubleSide,
      fog: true,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.raycast = noRaycast;
    this.mesh.renderOrder = -2;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  setCount(n) {
    this.mesh.geometry.instanceCount = n * CORE_SLICES;
    this.mesh.visible = n > 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// scratch
// ---------------------------------------------------------------------------

const EMPTY = {};
const tv = new THREE.Vector3();
const tv2 = new THREE.Vector3();
const tv3 = new THREE.Vector3();
// Orthonormal frame around a fire direction, rebuilt by basis() on demand and
// reused by whichever method asked for it. Nothing else writes them mid-loop.
const nd = new THREE.Vector3();
const bR = new THREE.Vector3();
const bU = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_X = new THREE.Vector3(1, 0, 0);
const RING_AXIS = new THREE.Vector3(0, 0, 1);
const TRACER_AXIS = new THREE.Vector3(0, 0, 1);

function basis(dir) {
  nd.copy(dir);
  if (nd.lengthSq() < 1e-8) nd.set(0, 0, 1);
  else nd.normalize();
  bR.crossVectors(nd, Math.abs(nd.y) > 0.97 ? WORLD_X : WORLD_UP).normalize();
  bU.crossVectors(bR, nd).normalize();
}

// One smoke screen's volume as it stands this frame. Everything that needs
// the shape — the sight-line query, the puff spawner, the GPU upload — reads
// it through here, so there is exactly one definition of where a screen is.
const SHAPE = { cx: 0, cy: 0, cz: 0, rh: 1, rv: 1, floor: 0, rho: 0 };
function screenShape(s, out) {
  const R = s.radius;
  out.cx = s.pos.x;
  out.cz = s.pos.z;
  out.cy = s.ground + R * SCREEN_YC;
  out.rh = R * SCREEN_RH;
  out.rv = R * SCREEN_RV;
  out.floor = s.ground - SCREEN_FLOOR;
  out.rho = SCREEN_RHO * s.density;
  return out;
}

// X-03, the muzzle (bible 6.5): flame at most 3 m, rings at most 8 m, the
// ground ring 4-8 m, dust fan within 10 m of the muzzle hanging 1.5-3 s,
// propellant smoke 1.5-4 s.
const MUZZLE_FLAME_MAX = 3;
const MUZZLE_RING_MAX = 8;
const MUZZLE_GROUND_RING = [4, 8];
const MUZZLE_FAN_SPEED = 12;  // m/s, with MUZZLE_FAN_DRAG: <= 6 m of run-out
const MUZZLE_FAN_DRAG = 2;
const MUZZLE_DUST_LIFE = [1.5, 3];
const MUZZLE_SMOKE_LIFE = [1.5, 4];
/**
 * Design flag, OFF: a >= 85 mm gun's own obscuration (2-3 s of smoke over its
 * sight). Realistic and gameplay-changing — the game designer's call.
 */
export const MUZZLE_OBSCURATION = false;

// Must match FX_MAX_SCREENS in the shaders: the uniform arrays are this long.
const MAX_SCREENS = 8;
// Default reach of a flash light, i.e. what every existing call site gets.
const FLASH_RADIUS = 40;
// Burning hulks and the columns off a big hit. Both are cheap per tick and
// both are capped, because a losing team leaves a great many of them.
const MAX_WRECKS = 26;
// Things that smoke but are NOT a hulk on the ground: a falling or damaged
// aeroplane, a coasting rocket, a tank burning on the move, the artillery
// marker. They get the smoke (and a lick of flame while the caller is still
// there) but no ground glow, no 50-200 m column and no permanent fire, and
// they live in their own pool so they can never evict a real hulk. A point
// nobody has re-registered for TRANSIENT_HOLD s tapers out over the tail.
const MAX_SMOKE_POINTS = 26;
const TRANSIENT_HOLD = 0.5;
const TRANSIENT_TAIL = 6;
// A "hulk" registered this far above the ground is not one (safety net for a
// caller that passes the flag for something in the air): it is demoted.
const HULK_MAX_AGL = 12;
// The battles re-register every hulk every few frames for as long as its hull
// is on the map (and sink and remove a hull ~26 s after the kill). A hulk not
// re-registered for HULK_LOST s is gone: its glow, its column and its flame
// fade out over HULK_FADE s; the smoulder carries on, as it always did.
const HULK_LOST = 3;
const HULK_FADE = 4;
const MAX_COLUMNS = 12;
// X-05 wreck column: rises ~5.5 m/s (buoyancy / drag) for 20-35 s, so it
// stands 50-200 m and spreads x7 as it goes
const PLUME_BUOYANCY = -1.2;
const PLUME_DRAG = 0.22;
const PLUME_GROW = 6;

// ---------------------------------------------------------------------------
// the smoke veil on transparent surfaces that are not effects
// ---------------------------------------------------------------------------
//
// An aeroplane behind a smoke screen is hidden by the screen's volume core: the
// slabs (SmokeCore, transparent pass, renderOrder -2) are painted over whatever
// OPAQUE thing the depth buffer says stands behind them. A canopy is not
// opaque. Transparent glass sorts after the slabs (renderOrder 0 > -2), so it
// was blended on TOP of the smoke that had just covered the fuselage under it,
// and the cockpit glass hung in the screen on its own. Moving the glass in
// front of the slabs in the sort (renderOrder < -2) would fix that case and
// break the opposite one: glass writes no depth, so a slab BEHIND a canopy that
// is itself in front of the screen would then be painted over the glass.
//
// So the glass carries the veil, the same per-fragment integral the tracers
// and the billboards use: its alpha is multiplied by what gets through every
// live screen between the camera and that fragment. In front of the smoke, or
// with no screen out at all (one uniform compare, the veil is exactly 1.0),
// the glass is untouched; behind it, it fades out with exactly the opacity the
// core paints over the fuselage around it.
//
// The uniforms are MODULE state because the glass material is cached across
// battles (stamped shared) while every battle builds its own Effects: each
// Effects reads and writes these very objects for its smoke list, so the glass
// is always bound to whichever battle is running, and a disposed one leaves
// uSmkN at 0 (clearSmokeScreens -> packScreens).
const SMOKE_VEIL_U = (() => {
  const v4 = () => {
    const a = [];
    for (let i = 0; i < MAX_SCREENS; i++) a.push(new THREE.Vector4());
    return a;
  };
  return {
    uSmkA: { value: v4() },
    uSmkB: { value: v4() },
    uSmkN: { value: 0 },
    uSmkKappa: { value: Math.log(20) / 4 },
  };
})();

/** The live smoke-screen uniforms every veiled material reads (read-only). */
export function smokeVeilUniforms() {
  return SMOKE_VEIL_U;
}

/**
 * Give a lit, transparent three.js material (MeshStandard/Physical/Basic…)
 * the smoke-screen veil: its alpha is attenuated by the smoke between the
 * camera and each fragment. Idempotent; returns the material. The material
 * must not need an onBeforeCompile of its own (it is replaced).
 */
export function applySmokeVeil(mat) {
  if (!mat || (mat.userData && mat.userData.smokeVeil)) return mat;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSmkA = SMOKE_VEIL_U.uSmkA;
    shader.uniforms.uSmkB = SMOKE_VEIL_U.uSmkB;
    shader.uniforms.uSmkN = SMOKE_VEIL_U.uSmkN;
    shader.uniforms.uSmkKappa = SMOKE_VEIL_U.uSmkKappa;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFxVeilRay;')
      .replace('#include <fog_vertex>', VEIL_VS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>\nvarying vec3 vFxVeilRay;\n${FX_SMOKE_UNIFORMS}${FX_SMOKE_SEG}${FX_SMOKE_TAU}${FX_SMOKE_VEIL}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );',
        'vec4 diffuseColor = vec4( diffuse, opacity * fxSmokeVeil( vFxVeilRay, 0.0 ) );');
  };
  // one program per material TYPE with this key (three adds the type itself)
  mat.customProgramCacheKey = () => 'fxveilsolid1';
  mat.userData = mat.userData || {};
  mat.userData.smokeVeil = true;
  mat.needsUpdate = true;
  return mat;
}

// How much loose material a surface has to give. Sand throws half the desert
// into the air behind a tank; snow throws almost nothing, and reads wrong the
// moment it throws anything brown.
const SURFACE_DUST = {
  sand: 1.65, dirt: 1.3, grass: 1, rock: 0.7, snow: 0.12, mud: 0.5, concrete: 0.45,
};
const WEATHER_DUST = { clear: 1, haze: 1.2, overcast: 0.75, snow: 0.3 };

export class Effects {
  constructor(scene) {
    this.scene = scene;
    // Uniforms every effects shader reads by reference, written once a frame:
    // the clock, the sun, and the live smoke screens packed for the GPU.
    this.fxU = {
      uFxTime: { value: 0 },
      uFxSun: { value: new THREE.Vector3(0.45, 0.8, 0.4).normalize() },
      // sky ambient and sun radiance as the smoke sees them (readPreset)
      uFxAmb: { value: new THREE.Vector3(0.25, 0.31, 0.4) },
      uFxSunCol: { value: new THREE.Vector3(0.78, 0.69, 0.56) },
      // The live screens are the module's SMOKE_VEIL_U, not this instance's
      // own: transparent surfaces outside the effects system (a canopy, see
      // applySmokeVeil) bind to them once and must follow every battle.
      uSmkA: SMOKE_VEIL_U.uSmkA,
      uSmkB: SMOKE_VEIL_U.uSmkB,
      uSmkN: SMOKE_VEIL_U.uSmkN,
      uSmkKappa: SMOKE_VEIL_U.uSmkKappa,
      uSmkWind: { value: new THREE.Vector2() },
    };
    // a fresh battle starts with no screens out, whatever the last one left
    SMOKE_VEIL_U.uSmkN.value = 0;
    const U = this.fxU;
    this.sparks = new ParticlePool(scene, 900, {
      size: 1.1,
      blending: THREE.AdditiveBlending,
      opacity: 1,
      sprite: 'hard',
      fade: 'color',
    }, U);
    this.smoke = new ParticlePool(scene, 900, {
      size: 5.5,
      blending: THREE.NormalBlending,
      opacity: 0.45,
      fadeColor: 0xb8cfe4,
      sprite: 'smoke',
      fade: 'alpha',
      swirl: 0.55,
      wind: 0.5,
      spin: 0.22,
      lit: 1,
      soft: true,
    }, U);
    // Dirt: smaller and grittier than smoke, and it settles instead of rising.
    this.dust = new ParticlePool(scene, 700, {
      size: 2.9,
      blending: THREE.NormalBlending,
      opacity: 0.52,
      fadeColor: 0xc9bda4,
      sprite: 'smoke',
      fade: 'alpha',
      swirl: 0.3,
      wind: 0.35,
      spin: 0.3,
      lit: 0.8,
      soft: true,
    }, U);
    // Solid fragments — clods, spall, splinters. No fade colour: chunks just go
    // dark as they die, which is what a tumbling piece of steel does anyway.
    this.debris = new ParticlePool(scene, 380, {
      size: 0.55,
      blending: THREE.NormalBlending,
      opacity: 1,
      sprite: 'hard',
      fade: 'color',
      spin: 6.5,
      lit: 0.6,
    }, U);
    // Aircraft condensation. Long-lived, near-weightless, fades toward the sky
    // rather than toward black so it dissolves instead of popping out.
    this.trails = new ParticlePool(scene, 560, {
      size: 4.2,
      blending: THREE.NormalBlending,
      opacity: 0.3,
      fadeColor: 0xa9c0d6,
      sprite: 'soft',
      fade: 'alpha',
      wind: 0.12,
      spin: 0.06,
      lit: 0.5,
    }, U);
    // Everything hot. Additive and deliberately over-bright: the colours here
    // run past 1.0 so the bloom pass has something above its threshold to find,
    // which is what makes a fireball look like light rather than like paint.
    this.fire = new ParticlePool(scene, 340, {
      size: 6.5,
      blending: THREE.AdditiveBlending,
      opacity: 1,
      sprite: 'fire',
      fade: 'both',
      spin: 0.9,
      soft: true,
    }, U);
    // Smoke screens live in their own pool because they need hundreds of
    // long-lived billboards and must never be starved by a busy firefight.
    // They are the billowing surface of the screen's volume core (below),
    // which is what actually makes the screen opaque: placed in its outer
    // shell and drawn unveiled through the first 1.5 e-folds of it, so the
    // lumps read on the surface and the ones on the far side fade out.
    this.screenPool = new ParticlePool(scene, 1100, {
      size: 9.5,
      blending: THREE.NormalBlending,
      opacity: 0.7,
      fadeColor: 0x9aa09a,
      sprite: 'smoke',
      fade: 'alpha',
      swirl: 0.25,
      wind: 0.18,
      spin: 0.1,
      lit: 1,
      soft: true,
      skin: 1.5,
      maxNdc: 1.6,
    }, U);

    // X-05: the column over a burning hulk. Its own pool because it is tall
    // (50-200 m), slow and long-lived (20-35 s a puff) and must not starve
    // the firefight's smoke, nor be starved by it. Lit like all smoke; the
    // wind leans it over.
    this.plume = new ParticlePool(scene, 900, {
      size: 9,
      blending: THREE.NormalBlending,
      opacity: 0.5,
      fadeColor: 0x8c949c,
      sprite: 'smoke',
      fade: 'alpha',
      swirl: 0.2,
      wind: 0.4,
      spin: 0.07,
      lit: 1,
    }, U);

    this.rings = new RingField(scene, U);
    this.tracers = new TracerField(scene);
    this.decals = new DecalField(scene);
    this.core = new SmokeCore(scene, U);
    // X-05 ground glow under burning wrecks, laid on the drawn surface
    this.glow = new GlowField(scene, this.decals);
    // X-07 track prints, by quality tier (backlog 4.3): none on low. Built
    // on the first tank that asks, so an air battle never pays for the ring.
    {
      const tier = getMaterialQuality();
      this.printCap = PRINT_CAP[tier] != null ? PRINT_CAP[tier] : PRINT_CAP.medium;
      this.prints = null;
    }
    // the blast law's record, reused (AV-01)
    this.blastRec = null;
    // the prints ask for the ground every few metres per tank
    this.printLookFn = (x, z) => this.surfaceAt(x, z);
    // surface look-ups (AV-03): a small ring of records, so the one a battle
    // handler took for an impact survives the next couple of calls
    this.looks = [{}, {}, {}, {}];
    this.lookIdx = 0;
    this.surfaceLookups = 0;
    // The core is coloured to be the grey the screen's puffs average out to
    // over a life: base colour fading toward the pool's fade colour, weighted
    // by how opaque each stage of the fade is (alpha ~ f^0.75, colour linear
    // in f), times the mask's own mean brightness — and then a shade darker,
    // because what shows between the lumps of a real cloud is the shadow
    // they cast on each other. That contrast is what makes the lumps read.
    {
      const pool = this.screenPool;
      const fc = pool.fadeColor;
      const L = (spriteLum.smoke != null ? spriteLum.smoke : 0.85) * 0.85;
      const wB = 1.75 / 2.75;
      const ch = (shift, fadeC) => ((((SCREEN_PUFF >> shift) & 255) / 255) * wB + fadeC * (1 - wB)) * L;
      this.core.colU.value.set(ch(16, fc.r), ch(8, fc.g), ch(0, fc.b));
    }
    this.packedScreens = 0;

    this.pools = [
      this.sparks, this.smoke, this.dust, this.debris,
      this.trails, this.fire, this.screenPool, this.plume,
    ];

    this.flashes = [
      new THREE.PointLight(0xffc060, 0, 40),
      new THREE.PointLight(0xffc060, 0, 40),
      new THREE.PointLight(0xffc060, 0, 40),
    ];
    this.flashes.forEach((l) => {
      l.castShadow = false;
      // How fast this slot is currently dying. A muzzle flash is gone in two
      // frames; a fireball has to hang around long enough to light the hull it
      // just came out of.
      l.userData.decay = 12;
      // ...and the hard end of it: a flash with a stated life is dark after it
      l.userData.life = Infinity;
      scene.add(l);
    });
    this.flashIdx = 0;

    // Global quality knob, 0..1. Scales spawn counts and emission rates only —
    // nothing gameplay-visible depends on it, smoke screens still block sight.
    this.density = 1;

    // Live smoke screens, preallocated. Gameplay queries these, so they are
    // state, not decoration.
    this.smokeScreens = [];
    for (let i = 0; i < MAX_SCREENS; i++) {
      this.smokeScreens.push({
        active: false,
        pos: new THREE.Vector3(),
        radius: 2.5,
        maxRadius: 9,
        age: 0,
        life: 20,
        density: 0,
        emit: 0,
        // ground height the volume sits on, and its noise seed
        ground: 0,
        seed: 0,
      });
    }
    this.activeScreens = 0;
    // Optical depth — metres of full-density smoke — a sight line must cross
    // before it is blocked. Also sets how opaque the screen is DRAWN per metre
    // (smokeKappa), so changing it moves the picture and the rule together.
    this.losThreshold = 4;

    // Hulks. Once a vehicle is registered it goes on smoking for the rest of
    // the match whether or not anybody keeps asking it to, because a battle
    // that forgets its own wreckage looks like a practice range.
    this.wrecks = [];
    this.activeWrecks = 0;
    // ...and the smoke points that are not hulks (wreckSmoke without the
    // hulk flag, burningTick): a fixed pool, `live` flags, no allocation
    this.smokePoints = [];
    for (let i = 0; i < MAX_SMOKE_POINTS; i++) {
      this.smokePoints.push({ live: false, pos: new THREE.Vector3(), age: 0, emit: 0, seen: 0 });
    }
    // Columns: the tall plume a big detonation leaves standing behind it.
    this.columns = [];
    for (let i = 0; i < MAX_COLUMNS; i++) {
      this.columns.push({ active: false, pos: new THREE.Vector3(), age: 0, life: 0, emit: 0, power: 1 });
    }
    this.activeColumns = 0;

    this.mgTick = 0;
    this.engineTick = 0;
    this.decalCd = 0;
    this.time = 0;

    // Map-derived state, refreshed whenever the battle rolls a new preset.
    this.presetId = null;
    this.dustFactor = 1;
    this.groundDust = 0x9a8a68;
    this.groundDustLin = lin(0x9a8a68);
    this.groundType = 'grass';
    this.litScale = 1;
    this.scorchColor = lin(0x2b2724);
    this.windX = 0;
    this.windZ = 0;
    this.readPreset();
  }

  // ---------------- map preset ----------------

  // The biome decides what comes off the ground and how much of it. presets.js
  // hands over a per-surface dust palette already tinted for the hour and for
  // however much snow is lying, so the colour is simply read; the quantity is
  // the part that has to be judged — a tank on sand drags a wall of it behind
  // him and the same tank on fresh snow barely marks it.
  readPreset() {
    let p = null;
    try {
      p = activePreset();
    } catch {
      p = null;
    }
    if (!p) return;
    if (p.id === this.presetId) return;
    this.presetId = p.id;
    const gt = p.groundType || 'grass';
    const dustSet = p.dust || EMPTY;
    this.groundDust = dustSet[gt] != null ? dustSet[gt] : 0x9a8a68;
    let f = SURFACE_DUST[gt] != null ? SURFACE_DUST[gt] : 1;
    this.snowDust = 1 - (p.snowCover || 0) * 0.8;
    f *= this.snowDust;
    const wk = p.weatherKey || 'clear';
    this.weatherDust = WEATHER_DUST[wk] != null ? WEATHER_DUST[wk] : 1;
    f *= this.weatherDust;
    this.dustFactor = clamp(f, 0.05, 2);
    // Burnt ground keeps a little of the map's colour, or a black smear on
    // snow reads as a hole rather than as soot. (sRGB, then to the linear
    // the decal's vertex colour is read as.)
    const g = this.groundDust;
    this.scorchColor = lin(((((g >> 16) & 255) * 0.30 + 18) << 16)
      | ((((g >> 8) & 255) * 0.30 + 16) << 8)
      | (((g & 255) * 0.30 + 15) | 0));
    // the biome's dust as an albedo (AV-03 per-point lookups refine it) — and
    // what aging dust drifts toward, rather than one beige for every map
    this.groundDustLin = lin(this.groundDust);
    {
      const d = this.groundDustLin;
      this.dust.fadeColor.setRGB(((d >> 16) & 255) / 255, ((d >> 8) & 255) / 255, (d & 255) / 255);
    }
    this.groundType = (p.snowCover || 0) > 0.35 ? 'snow' : gt;
    const Lb = p.light;
    // additive dust rings stand in for lit dust: as bright as the day is
    this.litScale = Lb && Lb.whiteLitH > 0 ? clamp(Lb.whiteLitH / 0.72, 0.1, 1.2) : 1;
    this.glow.setGround(this.groundType, Lb && Lb.bloomThreshold);
    this.printLight = null;
    if (Lb && Lb.ambLin && Lb.sunLin) {
      const y = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
      this.printLight = [y(Lb.ambLin), y(Lb.sunLin)];
    }
    if (this.prints && this.printLight) this.prints.setLight(this.printLight[0], this.printLight[1]);
    const wind = p.windStrength || 0;
    const dir = p.windDir || 0;
    this.windX = Math.cos(dir) * wind * 0.45;
    this.windZ = Math.sin(dir) * wind * 0.45;
    for (const pool of this.pools) pool.setWind(this.windX, this.windZ);
    this.fxU.uSmkWind.value.set(this.windX, this.windZ);
    // the same sun the scene is lit by, so smoke is bright on the same side
    // as the hull standing in it
    const sd = p.sunDir;
    if (sd && Number.isFinite(sd.x) && Number.isFinite(sd.y) && Number.isFinite(sd.z)
      && sd.x * sd.x + sd.y * sd.y + sd.z * sd.z > 1e-6) {
      this.fxU.uFxSun.value.set(sd.x, sd.y, sd.z).normalize();
    }
    // ...and the same light. These are light colours, so the hex is sRGB and
    // THREE.Color's conversion to linear is exactly what is wanted. Scaled so
    // the midday preset lands the sunny side of a puff at ~1.0 (the colour it
    // was tuned at) and its shadow side at the sky's blue-grey ~0.3.
    // X-01: the battle rig's own numbers (contract R1-K, presets.lightBlock):
    // radiance per unit albedo exactly as a Lambert card sees it, so a puff
    // stays seated in the world whatever the exposure. A multiple-scattering
    // floor of 0.12 x sun moves into the shade term and comes off the sun
    // term, so the fully lit side is still ambLin + sunLin and the shaded side
    // ambLin + 0.12 sunLin (lit:shadow between 1.5 and the world's, E-30).
    const L = p.light;
    if (L && L.sunLin && L.ambLin) {
      const s = L.sunLin;
      const a = L.ambLin;
      this.fxU.uFxAmb.value.set(a[0] + 0.12 * s[0], a[1] + 0.12 * s[1], a[2] + 0.12 * s[2]);
      this.fxU.uFxSunCol.value.set(0.88 * s[0], 0.88 * s[1], 0.88 * s[2]);
    } else if (p.hemiSky != null && p.sunColor != null) {
      const c = new THREE.Color();
      c.setHex(p.hemiSky).multiplyScalar(0.35 * (p.hemiIntensity ?? 1));
      this.fxU.uFxAmb.value.set(c.r, c.g, c.b);
      c.setHex(p.sunColor).multiplyScalar(0.3 * (p.sunIntensity ?? 2.6));
      this.fxU.uFxSunCol.value.set(c.r, c.g, c.b);
    }
  }

  // Ground height under a point, and how far above it that point sits. Used to
  // decide whether an explosion gets a crater or is simply an aeroplane coming
  // apart at three thousand feet.
  groundUnder(x, z) {
    const gy = terrainHeight(x, z);
    return Number.isFinite(gy) ? gy : 0;
  }

  // ---------------- the ground under an impact (AV-03) ----------------
  //
  // One record per impact decides the dust it throws, the mark it leaves and
  // — handed on to core/audio.js as `surface` — the sound it makes. `surface`
  // is the lookup the caller already made (ShellManager's info.surface, a
  // wall's masonry record, an airfield's concrete); without one the terrain is
  // asked here, once. The record comes from a ring of four, so the one an
  // impact handler holds survives the calls it then makes.
  //   type, sound ('snow'|'sand'|'mud'|'rock'|'soil'), dust (linear hex),
  //   dustSrgb, factor (how much loose material), decal (crater tint),
  //   printK / printRelief (X-07), scenery
  surfaceLook(surface = null, x = 0, z = 0) {
    let s = surface;
    if (!s && terrainSurface) {
      this.surfaceLookups++;
      try {
        s = terrainSurface(x, z);
      } catch {
        s = null;
      }
    }
    const out = this.looks[this.lookIdx];
    this.lookIdx = (this.lookIdx + 1) & 3;
    let type = (s && s.type) || this.groundType;
    if (s && s.airfield) type = 'concrete';
    const dustS = s && s.dustColor != null ? s.dustColor : this.groundDust;
    out.type = type;
    out.scenery = (s && s.scenery) || null;
    out.sound = out.scenery || type === 'concrete' || type === 'rock' ? 'rock'
      : type === 'snow' || type === 'sand' || type === 'mud' ? type : 'soil';
    out.dustSrgb = dustS;
    out.dust = linCached(dustS);
    out.decal = out.dust;
    let f = SURFACE_DUST[type] != null ? SURFACE_DUST[type] : 1;
    if (type !== 'snow') f *= this.snowDust != null ? this.snowDust : 1;
    f *= this.weatherDust != null ? this.weatherDust : 1;
    out.factor = clamp(f, 0.05, 2);
    const pl = PRINT_LOOK[type] || PRINT_LOOK.grass;
    out.printK = pl[0];
    out.printRelief = pl[1];
    return out;
  }

  /** The surface record for a ground point (one terrain lookup). */
  surfaceAt(x, z) {
    return this.surfaceLook(null, x, z);
  }

  // ---------------- lights ----------------

  // life (s, optional): the light is dark after this, whatever its decay —
  // how "visible light <= 3 frames" is guaranteed rather than hoped for.
  flash(pos, intensity, color = 0xffc060, radius = 0, decay = 12, life = 0) {
    // Take the dimmest slot rather than round-robining, so a machine gun burst
    // cannot stamp on the light from an explosion that is still blooming.
    let l = this.flashes[0];
    for (let i = 1; i < this.flashes.length; i++) {
      if (this.flashes[i].intensity < l.intensity) l = this.flashes[i];
    }
    this.flashIdx = (this.flashIdx + 1) % this.flashes.length;
    l.position.copy(pos);
    l.color.setHex(color);
    l.intensity = intensity;
    // Always restated, never left over: the lights are shared, so a 152mm blast
    // must not lend its reach to the next hit that forgets to ask for one.
    l.distance = radius > 0 ? radius : FLASH_RADIUS;
    l.userData.decay = decay;
    l.userData.life = life > 0 ? life : Infinity;
    // The battles spawn before they call update(dt), so without this a light
    // shorter than one frame (a 37 mm burst's) was aged to dark before it was
    // ever drawn. Its first update spares it if (and only if) that update
    // would kill it: lit on max(1, ceil(life / dt) - 1) frames, never none,
    // and every longer light exactly as before (75 mm 2, 105 mm 3 at 60 Hz).
    l.userData.fresh = true;
    return l;
  }

  // ---------------- guns ----------------

  muzzleFlash(pos, dir) {
    // kept for callers that have no calibre to give; muzzleBlast is the real one
    this.muzzleBlast(pos, dir, 75, null);
  }

  // The signature look of a tank gun firing, tuned to the real event (X-03,
  // bible 6.5): a flame 1.5-3 m long that is gone inside two frames, one
  // light reaching 30-60 m for as long, the pressure ring off the brake, and
  // — if the muzzle is low enough over the ground — the dust wave that blows
  // out 5-10 m ahead of the tank, hangs 1.5-3 s and gives the position away,
  // under the grey-white propellant smoke that drifts off over 1.5-4 s.
  // caliber is in mm; groundY is the terrain height under the muzzle, or null
  // when the caller does not know it (aircraft cannon, for instance).
  muzzleBlast(pos, dir, caliber = 75, groundY = null) {
    basis(dir);
    const s = clamp(caliber / 88, 0.22, 1.75); // the 88 is the reference bore
    const q = this.density;
    const frame2 = 1 / 30; // two 60 Hz frames: the flame and its light
    // One light, dark after two frames, reaching 30-60 m.
    this.flash(pos, 160 + 340 * s, 0xffd8a0, 30 + 30 * Math.min(1, s), 22, frame2);

    // The flame itself: one bright core and a couple of tongues along the
    // bore, together 1.5-3 m long for a 75-105 mm gun (shorter below that).
    // Additive and over-bright, so it blooms; it lives at most two frames.
    const flame = clamp(2.4 * s, 0.8, MUZZLE_FLAME_MAX);
    const fu = this.fire.unit;
    tv.copy(pos).addScaledVector(nd, flame * 0.32);
    tv2.copy(nd).multiplyScalar(2 + 3 * s);
    this.fire.spawn(tv, tv2, frame2, 0xfff0c8, 0, 0, (flame * 0.62) / fu, 0.3, 1, 3.2, 0.001);
    // spaced down the bore so the last one makes the tip: the flame's length
    // is a property of the gun, not of the dice
    const tongues = Math.max(2, Math.round(3 * q));
    for (let i = 0; i < tongues; i++) {
      tv.copy(pos).addScaledVector(nd, flame * (0.4 + (0.38 * i) / (tongues - 1) + rand(-0.03, 0.03)));
      tv.addScaledVector(bR, rand(-0.08, 0.08) * flame);
      tv.addScaledVector(bU, rand(-0.08, 0.08) * flame);
      tv2.copy(nd).multiplyScalar(rand(2, 5) * (0.5 + s));
      this.fire.spawn(tv, tv2, rand(0.6, 1) * frame2, i ? 0xffa838 : 0xffe0a0, 0, 0,
        (flame * rand(0.34, 0.42)) / fu, 0.3, 1, 2.4, 0.001);
    }

    // Burning grains thrown out with the gas: a big bore flashes wider, not
    // only brighter, since the gas leaves faster than the shot sweeps it.
    const spread = 0.14 + 0.34 * s;
    const n = Math.max(4, Math.round((9 + 15 * s) * q));
    for (let i = 0; i < n; i++) {
      const reach = rand(10, 34) * (0.55 + 0.55 * s);
      tv.copy(nd).multiplyScalar(reach);
      tv.addScaledVector(bR, rand(-spread, spread) * reach);
      tv.addScaledVector(bU, rand(-spread, spread) * reach);
      this.sparks.spawn(pos, tv, rand(0.05, 0.17), i % 4 === 0 ? 0xfff6d8 : 0xffbe60,
        0, 3, rand(0.8, 1.6), 0, 1, 2);
    }

    // Pressure ring off the brake, across the bore a little ahead of it — an
    // actual expanding front behind the gas puffs, so the eye reads one wave.
    tv3.copy(pos).addScaledVector(nd, 0.8 + 1.6 * s);
    this.rings.add(tv3, nd, 0.4 + 0.6 * s, Math.min(MUZZLE_RING_MAX, 2.2 + 4.5 * s),
      0.12 + 0.08 * s, 0xffe8c8, 1.1 + 0.7 * s);
    const ringN = Math.max(6, Math.round((8 + 10 * s) * q));
    const ringR = 0.55 + 1.1 * s;
    const ringV = 7 + 9 * s;
    for (let i = 0; i < ringN; i++) {
      const a = (i / ringN) * TAU + rand(-0.16, 0.16);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      tv.copy(tv3).addScaledVector(bR, ca * ringR).addScaledVector(bU, sa * ringR);
      tv2.set(0, 0, 0)
        .addScaledVector(bR, ca * ringV)
        .addScaledVector(bU, sa * ringV)
        .addScaledVector(nd, 3 + 4 * s);
      this.dust.spawn(tv, tv2, rand(0.18, 0.36), PROPELLANT, 0.6, 3.6, rand(0.7, 1.3), 2.2, 0.6);
    }

    // Propellant smoke hanging off the muzzle: grey-white (Y .45-.60), swelling
    // hard and drifting off over 1.5-4 s. The volume of gas is what a big gun
    // looks like a second after it fires.
    const smokeN = Math.max(1, Math.round((2 + 3 * s) * q));
    for (let i = 0; i < smokeN; i++) {
      tv.copy(pos).addScaledVector(nd, rand(0.2, 1.4 + 2 * s));
      tv2.copy(nd).multiplyScalar(rand(2, 7) * s);
      tv2.x += rand(-1.2, 1.2);
      tv2.y += rand(0.6, 2.2);
      tv2.z += rand(-1.2, 1.2);
      this.smoke.spawn(tv, tv2, rand(MUZZLE_SMOKE_LIFE[0], MUZZLE_SMOKE_LIFE[1]), PROPELLANT,
        -0.35, 1.4, rand(0.5, 0.9) * (0.7 + s), 2.1, 0.5);
    }

    // Design flag (default off, the game designer's call): the obscuration a
    // >= 85 mm gun really throws over its own sight for 2-3 s (bible 6.5: 90 mm
    // APC blinded the gunner 3.0 s). Realistic, but it changes gameplay.
    if (MUZZLE_OBSCURATION && caliber >= 85) {
      for (let i = 0; i < Math.round(6 * q) + 2; i++) {
        tv.copy(pos).addScaledVector(nd, rand(1, 6));
        tv2.copy(nd).multiplyScalar(rand(1, 3));
        tv2.y += rand(0.3, 1);
        this.smoke.spawn(tv, tv2, rand(2, 3), PROPELLANT, -0.1, 1.2, rand(1.1, 1.6), 1.2, 0.9);
      }
    }

    if (groundY === null || groundY === undefined) return;
    const h = pos.y - groundY;
    if (h > 2.5) return;

    // Ground wave. Flatten the bore onto the terrain and blow the ground's
    // own dust (AV-03: one lookup, under the blast) out through a forward arc.
    const g = clamp(1 - h / 2.5, 0, 1) * Math.min(1.2, s);
    tv3.set(nd.x, 0, nd.z);
    if (tv3.lengthSq() < 1e-6) tv3.set(1, 0, 0);
    else tv3.normalize();
    const cx = pos.x + tv3.x * 1.5;
    const cz = pos.z + tv3.z * 1.5;
    const look = this.surfaceAt(cx, cz);
    const dry = look.factor;
    // the pressure ring on the ground, inside the fan: 4-8 m whatever the gun
    tv.set(cx, groundY + 0.12, cz);
    this.rings.add(tv, WORLD_UP, 0.8 + 1.2 * Math.min(1, s),
      clamp((4 + 4 * Math.min(1, g)) * clamp(dry, 0.7, 1.15), MUZZLE_GROUND_RING[0], MUZZLE_GROUND_RING[1]),
      0.22 + 0.1 * s, look.dust, 0.55 * clamp(dry, 0.25, 1.2) * this.litScale);
    // the dust fan: reaches 5-10 m ahead of the muzzle for a 75-90 mm gun,
    // and hangs 1.5-3 s (lives) — speeds bounded so nothing outruns 10 m
    const m = Math.max(3, Math.round((10 + 26 * g) * q * clamp(dry, 0.25, 1.5)));
    for (let i = 0; i < m; i++) {
      const a = rand(-1.4, 1.4);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const ox = tv3.x * ca - tv3.z * sa;
      const oz = tv3.x * sa + tv3.z * ca;
      const r0 = rand(0.3, 2.2);
      tv.set(cx + ox * r0, groundY + rand(0.05, 0.5), cz + oz * r0);
      const sp = rand(4, MUZZLE_FAN_SPEED) * (0.7 + 0.3 * Math.min(1, g));
      tv2.set(ox * sp, rand(0.4, 2.2), oz * sp);
      this.dust.spawn(tv, tv2, rand(MUZZLE_DUST_LIFE[0], MUZZLE_DUST_LIFE[1]), look.dust, 0.9, MUZZLE_FAN_DRAG,
        rand(0.9, 1.7), 1.8, 0.7, 1, 0.08);
    }
    const bN = Math.max(1, Math.round(3 * g * q));
    for (let i = 0; i < bN; i++) {
      const a = rand(-1.2, 1.2);
      const ox = tv3.x * Math.cos(a) - tv3.z * Math.sin(a);
      const oz = tv3.x * Math.sin(a) + tv3.z * Math.cos(a);
      tv.set(cx + ox * rand(0.5, 3), groundY + rand(0.3, 1), cz + oz * rand(0.5, 3));
      tv2.set(ox * rand(2, 5), rand(0.5, 1.5), oz * rand(2, 5));
      this.smoke.spawn(tv, tv2, rand(MUZZLE_DUST_LIFE[0], MUZZLE_DUST_LIFE[1]), look.dust, -0.1, 1.9,
        rand(0.8, 1.4), 1.5, 0.45);
    }
    // A heavy gun scorches its own firing position. Rare and small, but it is
    // what tells a returning player that somebody has been shooting from here.
    if (s > 0.85 && this.decalCd <= 0 && Math.random() < 0.22) {
      this.decalCd = 0.12;
      tv.set(cx, groundY, cz);
      this.decals.add(tv, 3 + 3 * s, DECAL_SCORCH, this.scorchColor, 0.45);
    }
  }

  // Machine gun / autocannon. Tiny, cheap, and fired dozens of times a second,
  // so it spends almost nothing: three sparks, a light on every third round and
  // an occasional wisp so a sustained burst builds a haze at the barrel.
  mgFlash(pos, dir) {
    basis(dir);
    this.mgTick = (this.mgTick + 1) % 6;
    if (this.mgTick % 3 === 0) this.flash(pos, 26, 0xffd8a0, 14, 26);
    for (let i = 0; i < 3; i++) {
      const reach = rand(3, 9);
      tv.copy(nd).multiplyScalar(reach);
      tv.addScaledVector(bR, rand(-0.22, 0.22) * reach);
      tv.addScaledVector(bU, rand(-0.22, 0.22) * reach);
      this.sparks.spawn(pos, tv, rand(0.03, 0.09), 0xfff0c0, 0, 4, 1, 0, 1, 1.8);
    }
    if (this.mgTick === 0) {
      tv.copy(pos).addScaledVector(nd, rand(0.3, 1.1));
      tv2.copy(nd).multiplyScalar(rand(3, 7));
      this.fire.spawn(tv, tv2, rand(0.03, 0.06), 0xffdc90, 0, 6, 0.35, 1.2, 1, 2.2);
      tv.copy(pos).addScaledVector(nd, rand(0.1, 0.6));
      tv2.set(rand(-0.5, 0.5), rand(0.6, 1.6), rand(-0.5, 0.5));
      this.smoke.spawn(tv, tv2, rand(0.35, 0.8), 0xb0aa9c, -0.4, 2, 0.4, 1.6, 0.35);
    }
  }

  // ---------------- tracers ----------------

  // Fire-and-forget streak. It flies its own arc and expires; the caller keeps
  // nothing. Good for ricochet spall, AA bursts and anything whose ballistics
  // nobody needs to query.
  //   opts: { color, life, length, width, gravity, heat, trail }
  //   trail is puffs per second of cannon smoke laid down behind it.
  tracer(pos, vel, opts) {
    return this.tracers.add(pos, vel, opts, false);
  }

  // Streak driven by somebody else's simulation. Returns a handle for
  // moveTracer/killTracer; the round's own manager owns the flight (contract
  // R1-T: { color, width, heat, life } — width the core in metres).
  attachTracer(pos, vel, opts) {
    return this.tracers.add(pos, vel, opts, true);
  }

  // anchor: true on the step a round changed direction (a ricochet).
  moveTracer(handle, pos, vel, anchor = false) {
    return this.tracers.move(handle, pos, vel, anchor);
  }

  /** The tracer colour (linear) for a shooter's nation, TRACER_COLOUR. */
  tracerColourFor(shooter) {
    return tracerColourFor(shooter);
  }

  killTracer(handle) {
    this.tracers.kill(handle);
  }

  // One puff of the thin grey thread a cannon shell drags behind it. Public
  // because a projectile manager that does not want a managed tracer can still
  // want the trail.
  roundTrailPuff(pos) {
    tv2.set(rand(-0.25, 0.25), rand(0.05, 0.5), rand(-0.25, 0.25));
    this.smoke.spawn(pos, tv2, rand(0.5, 1.1), 0xb8b2a6, -0.15, 1.2,
      rand(0.16, 0.3), 3.4, 0.24);
  }

  // Rate-based trail for a round the caller is flying itself. caliber in mm.
  roundTrail(pos, caliber = 75, dt = 0.016) {
    const s = clamp(caliber / 88, 0.2, 2);
    if (Math.random() > 26 * s * this.density * dt) return;
    this.roundTrailPuff(pos);
  }

  // ---------------- impacts ----------------
  //
  // Four outcomes, four looks, because this is the only feedback the player
  // gets about what his shot actually did:
  //   non-penetration  a wide white spark shower and a puff of paint dust
  //   penetration      a deep orange flash swallowed by the hull, little spray
  //   ricochet         one coherent deflected streak that arcs away
  //   ground miss      a dirt plume, a dust ring and a hole left behind

  impactSparks(pos, big = false) {
    const q = this.density;
    if (!big) {
      // Non-penetration: the round broke up on the plate. Lots of small white
      // fragments going everywhere fast, a hard white flash, and the grey puff
      // of vapourised paint that is the giveaway you did nothing.
      const n = Math.max(8, Math.round(20 * q));
      for (let i = 0; i < n; i++) {
        tv.set(rand(-13, 13), rand(1, 15), rand(-13, 13));
        this.sparks.spawn(pos, tv, rand(0.12, 0.4), i % 4 === 0 ? 0xffffff : 0xfff2c0,
          17, 2.4, rand(0.7, 1.4), 0, 1, 2.6);
      }
      this.flash(pos, 55, 0xfff0d0, 16, 26);
      this.fire.spawn(pos, tv.set(0, 1, 0), 0.06, 0xffffe8, 0, 5, 0.7, 1.2, 1, 2.6);
      for (let i = 0; i < Math.max(1, Math.round(3 * q)); i++) {
        tv.set(pos.x + rand(-0.3, 0.3), pos.y + rand(-0.2, 0.4), pos.z + rand(-0.3, 0.3));
        tv2.set(rand(-2, 2), rand(0.6, 2.4), rand(-2, 2));
        this.dust.spawn(tv, tv2, rand(0.4, 0.9), 0xbdb6ab, 0.6, 2.4, rand(0.5, 0.9), 2.2, 0.5);
      }
      return;
    }
    // Penetration: most of the energy went inside. A short deep flash, a lick
    // of flame out of the hole and dark smoke — far less spray than a bounce.
    this.flash(pos, 110, 0xffa040, 20, 9);
    const n = Math.max(5, Math.round(11 * q));
    for (let i = 0; i < n; i++) {
      tv.set(rand(-6, 6), rand(1, 9), rand(-6, 6));
      this.sparks.spawn(pos, tv, rand(0.15, 0.45), i % 3 === 0 ? 0xfff0a0 : 0xff9040,
        16, 2, rand(0.8, 1.5), 0, 1, 2);
    }
    this.fire.spawn(pos, tv.set(rand(-1, 1), rand(2, 5), rand(-1, 1)), rand(0.14, 0.3),
      0xff8828, -1.5, 3, 1.1, 2.2, 1, 2.2);
    tv2.set(rand(-1, 1), rand(1.5, 3.5), rand(-1, 1));
    this.smoke.spawn(pos, tv2, rand(0.9, 1.9), 0x2e2a26, -0.9, 1.3, 0.7, 2.4, 0.7);
  }

  // A deflection has a direction, and that is the whole read: the shot did not
  // stop, it went somewhere else. `dir` is the incoming shot line when the
  // caller has it; without one the deflection is picked upward at random.
  ricochetSparks(pos, dir = null) {
    const q = this.density;
    if (dir && dir.lengthSq && dir.lengthSq() > 1e-8) {
      // glance off: keep most of the shot line, tip it upward and aside
      basis(dir);
      tv3.copy(nd).multiplyScalar(0.62);
      tv3.addScaledVector(bU, rand(0.35, 0.8));
      tv3.addScaledVector(bR, rand(-0.5, 0.5));
      tv3.normalize();
    } else {
      tv3.set(rand(-1, 1), rand(0.7, 1.6), rand(-1, 1)).normalize();
    }
    for (let i = 0; i < Math.max(5, Math.round(9 * q)); i++) {
      tv.copy(tv3).multiplyScalar(rand(12, 30));
      tv.x += rand(-4, 4);
      tv.y += rand(-2, 5);
      tv.z += rand(-4, 4);
      this.sparks.spawn(pos, tv, rand(0.18, 0.5), 0xfff6c0, 10, 1,
        rand(0.9, 1.6), 0, 1, 2.4);
    }
    this.flash(pos, 34, 0xffe8b0, 13, 24);
    // The streak itself: one or two glowing fragments tumbling away downrange,
    // which is what a bounce looks like from the gunner's sight.
    const streaks = Math.random() < 0.5 ? 2 : 1;
    for (let i = 0; i < streaks; i++) {
      tv.copy(tv3).multiplyScalar(rand(45, 85));
      tv.x += rand(-9, 9);
      tv.y += rand(-3, 9);
      tv.z += rand(-9, 9);
      // a tumbling fragment, not tracer composition: the same streak law,
      // with a shorter floor on the length (it is slow)
      this.tracer(pos, tv, {
        color: 0xffd88a, life: rand(0.5, 0.95), width: 0.06, minLength: 1.2,
        gravity: 11, heat: 2.6,
      });
    }
  }

  // A round into dirt that hit nothing. Cheap version — dirtImpact is the one
  // that leaves a hole. bullets.js fires this from machine-gun strikes.
  // look (optional, AV-03): the impact's surface record (surfaceLook); left
  // out, the ground under `pos` is looked up once here.
  groundHit(pos, splash = 1, look = null) {
    const q = this.density;
    const lk = look || this.surfaceAt(pos.x, pos.z);
    const n = Math.round((8 + splash * 3) * clamp(q, 0.3, 1));
    const col = lk.dust;
    for (let i = 0; i < n; i++) {
      tv.set(rand(-6, 6) * splash * 0.5, rand(4, 12), rand(-6, 6) * splash * 0.5);
      this.sparks.spawn(pos, tv, rand(0.2, 0.5), col, 18, 1, rand(0.7, 1.3), 0, 1, 1);
    }
    tv2.set(rand(-1, 1), rand(2, 4), rand(-1, 1));
    this.smoke.spawn(pos, tv2, rand(1, 2.2), col, -0.6, 1,
      rand(0.5, 0.9) * (0.6 + splash * 0.25), 2, 0.45);
  }

  // A shell into dirt. size: roughly 1 for a solid shot, 2 for one into
  // masonry, 3+ the legacy "HE" size. kg (optional): the HE filler in kg of
  // TNT — given it (or a legacy size >= 2.5, read as a 75 mm-class round),
  // this is an HE burst at real scale and life (X-02, heBurst). look
  // (optional, AV-03): the impact's surface record.
  dirtImpact(pos, size = 1, kg = 0, look = null) {
    if (kg > 0) {
      this.heBurst(pos, kg, look);
      return;
    }
    if (size >= 2.5) {
      // the legacy HE call: size 3 is the calibration round, 0.68 kg
      this.heBurst(pos, REF_KG * (size / 3) ** 3, look);
      return;
    }
    const lk = look || this.surfaceAt(pos.x, pos.z);
    const k = clamp(size, 0.3, 4);
    const q = this.density;
    const dry = clamp(lk.factor, 0.3, 1.7);
    const col = lk.dust;
    const n = Math.max(5, Math.round((12 + 11 * k) * q * dry));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const r = Math.random() * (1.2 + k);
      tv.set(pos.x + Math.cos(a) * r, pos.y + rand(0, 0.4), pos.z + Math.sin(a) * r);
      const out = rand(1.5, 5) * k;
      tv2.set(Math.cos(a) * out, rand(4, 11) * (0.6 + 0.35 * k), Math.sin(a) * out);
      this.dust.spawn(tv, tv2, rand(0.7, 1.9), col, 8.5, 1.1,
        rand(0.9, 1.8) * (0.7 + 0.3 * k), 1.7, 0.8);
    }
    const clod = scaleHex(col, 0.45);
    const nC = Math.max(2, Math.round(6 * k * q));
    for (let i = 0; i < nC; i++) {
      tv2.set(rand(-7, 7) * k, rand(6, 15), rand(-7, 7) * k);
      this.debris.spawn(pos, tv2, rand(0.5, 1.1), clod, 15, 0.4, rand(0.7, 1.6));
    }
    const nS = Math.max(1, Math.round(2 * k * q));
    for (let i = 0; i < nS; i++) {
      tv.set(pos.x + rand(-1, 1) * k, pos.y + rand(0.2, 1), pos.z + rand(-1, 1) * k);
      tv2.set(rand(-1.5, 1.5), rand(1.5, 3.5), rand(-1.5, 1.5));
      this.smoke.spawn(tv, tv2, rand(1.4, 3.2), mixHex(col, BLAST_SMOKE, 0.35), -0.4, 1.3,
        rand(0.8, 1.5) * (0.7 + 0.3 * k), 2, 0.55);
    }

    const gy = this.groundUnder(pos.x, pos.z);
    if (pos.y - gy > 3 + k) return;
    // the dust ring rolling out from the base of the plume
    tv.set(pos.x, gy + 0.1, pos.z);
    this.rings.add(tv, WORLD_UP, 0.6 + k, (3.5 + 4.5 * k) * dry, 0.3 + 0.1 * k, col,
      0.5 * dry * this.litScale);
    // and the mark. Rate-limited hard: DecalGeometry is cheap here but not
    // free, and forty craters is the whole budget.
    if (k >= 1.6 && this.decalCd <= 0 && Math.abs(pos.x) < 430 && Math.abs(pos.z) < 430) {
      this.decalCd = 0.1;
      this.decals.add(tv, 1.6 + k * 1.5, DECAL_CRATER, lk.decal, 1);
    } else if (k >= 0.8 && this.decalCd <= 0 && Math.random() < 0.35
      && Math.abs(pos.x) < 430 && Math.abs(pos.z) < 430) {
      this.decalCd = 0.1;
      this.decals.add(tv, 1.2 + k, DECAL_SPLASH, lk.decal, 0.7);
    }
  }

  // An HE round bursting in the ground, at real scale and life (X-02, bible
  // 6.5), every number from the one blast law (AV-01, combat/blast.js):
  //   a flash under 50 ms — one light and one white core, NO lingering
  //   fireball (TNT in soil does not make one);
  //   a soil column REF_COLUMN_M x L tall half a second in, 8 L wide, three
  //   quarters the ground's own dust (AV-03) and a quarter TNT soot (Y .05),
  //   settling over 6-15 s for a 75 mm and drifting downwind;
  //   clods, the dust ring, and a crater 1-1.5 m across for a 75 mm.
  // kg: filler in kg of TNT. look: the surface record (or null). noDecal:
  // the caller lays its own mark (a bomb's crater and scorch ring).
  heBurst(pos, kg, look = null, noDecal = false) {
    const b = (this.blastRec = blastOf(kg, 0, this.blastRec));
    const L = b.L;
    const q = this.density;
    const lk = look || this.surfaceAt(pos.x, pos.z);
    const gy = this.groundUnder(pos.x, pos.z);
    const base = Math.min(pos.y, gy + 0.6 * L);

    // the flash: one light and one core, both dark by the fourth frame
    this.flash(pos, b.flash.intensity, 0xffd2a0, b.flash.radius, 6, b.flash.life);
    tv2.set(0, 0, 0);
    this.fire.spawn(pos, tv2, b.core.life, 0xfff4dc, 0, 0, b.core.diameter / this.fire.unit,
      0.4, 1, 4, 0.001);

    // the column: soil and soot thrown up together. Count and look scale with
    // the blast; how much loose stuff there is to throw scales with the ground.
    const C = b.column;
    const S = b.soot;
    const nAll = Math.max(8, Math.round(C.count * clamp(q, 0.35, 1) * clamp(lk.factor, 0.6, 1.3)));
    const nSoot = Math.max(2, Math.round(nAll * C.sootShare));
    const nSoil = nAll - nSoot;
    const du = this.dust.unit;
    for (let i = 0; i < nSoil; i++) {
      const a = Math.random() * TAU;
      const r = C.launchR * Math.sqrt(Math.random());
      tv.set(pos.x + Math.cos(a) * r, base + rand(0, 0.35) * L, pos.z + Math.sin(a) * r);
      // speed spread fills the column from the ground up (stratified, so
      // every burst has its top); the fastest make the top at 0.5 L s
      const up = C.v0 * Math.pow((i + Math.random()) / nSoil, 0.55);
      const out = C.out * rand(0.3, 1);
      tv2.set(Math.cos(a) * out, up, Math.sin(a) * out);
      this.dust.spawn(tv, tv2, rand(C.lifeMin, C.lifeMax), lk.dust, C.gravity, C.drag,
        (C.puff / du) * rand(0.8, 1.25), 1.2, 1, 1, 0.06);
    }
    const su = this.smoke.unit;
    for (let i = 0; i < nSoot; i++) {
      const a = Math.random() * TAU;
      const r = S.launchR * Math.sqrt(Math.random());
      tv.set(pos.x + Math.cos(a) * r, base + rand(0, 0.5) * L, pos.z + Math.sin(a) * r);
      tv2.set(Math.cos(a) * rand(0.2, 1), S.v0 * rand(0.35, 1), Math.sin(a) * rand(0.2, 1));
      this.smoke.spawn(tv, tv2, rand(S.lifeMin, S.lifeMax), SOOT_TNT, S.gravity, S.drag,
        (S.puff / su) * rand(0.8, 1.25), 2.2, 0.75, 1, 0.06);
    }

    // clods coming back down out of it, darker than the dust they came with
    const D = b.debris;
    const clod = scaleHex(lk.dust, 0.42);
    const nC = Math.max(2, Math.round(D.count * q));
    for (let i = 0; i < nC; i++) {
      const a = Math.random() * TAU;
      const sp = D.speed * rand(0.4, 1);
      const el = rand(0.55, 1.3);
      tv2.set(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp);
      this.debris.spawn(pos, tv2, D.life * rand(0.6, 1), clod, 9.8, 0.25, rand(0.8, 1.8) * Math.sqrt(L));
    }

    if (pos.y - gy > 3 * L + 1) return;
    // the dust ring rolling out from the base, and the hole
    const R = b.ring;
    tv.set(pos.x, gy + 0.1, pos.z);
    this.rings.add(tv, WORLD_UP, R.r0, R.r1 * clamp(lk.factor, 0.5, 1.2), R.life, lk.dust,
      0.45 * clamp(lk.factor, 0.3, 1.2) * this.litScale);
    if (!noDecal && this.decalCd <= 0 && Math.abs(pos.x) < 430 && Math.abs(pos.z) < 430) {
      this.decalCd = 0.1;
      this.decals.add(tv, b.crater, DECAL_CRATER, lk.decal, 1);
    }
  }

  // The bright cone of fragments that follows a penetration — spall coming off
  // the back face of the plate, thrown along the shot line.
  spallBurst(pos, dir) {
    basis(dir);
    const q = this.density;
    this.flash(pos, 70, 0xffe0a0, 16, 14);
    const n = Math.max(6, Math.round(18 * q));
    for (let i = 0; i < n; i++) {
      const reach = rand(14, 44);
      const spread = rand(0, 0.55);
      const a = Math.random() * TAU;
      tv.copy(nd).multiplyScalar(reach);
      tv.addScaledVector(bR, Math.cos(a) * spread * reach);
      tv.addScaledVector(bU, Math.sin(a) * spread * reach);
      this.sparks.spawn(pos, tv, rand(0.12, 0.35), i % 3 === 0 ? 0xffffe0 : 0xffc060,
        9, 1.6, rand(0.8, 1.5), 0, 1, 2.4);
    }
    const nD = Math.max(2, Math.round(7 * q));
    for (let i = 0; i < nD; i++) {
      const reach = rand(6, 20);
      const a = Math.random() * TAU;
      tv.copy(nd).multiplyScalar(reach);
      tv.addScaledVector(bR, Math.cos(a) * rand(0, 0.7) * reach);
      tv.addScaledVector(bU, Math.sin(a) * rand(0, 0.7) * reach);
      this.debris.spawn(pos, tv, rand(0.3, 0.7), 0x6a6055, 14, 0.7, rand(0.8, 1.5));
    }
    // the jet of hot gas that follows the fragments through the hole
    tv.copy(nd).multiplyScalar(rand(6, 14));
    this.fire.spawn(pos, tv, rand(0.08, 0.18), 0xffc060, -1, 4, 0.9, 2, 1, 2.4);
  }

  // ---------------- explosions ----------------

  // Something that burns as it blows: a hulk brewing up, an ammunition rack,
  // an aeroplane coming apart, a store going off in the air. Unlike HE in the
  // ground (heBurst) it has a fireball, and the fireball lights its
  // surroundings for as long as it burns.
  //   big: kg of TNT-equivalent, or the legacy flag — true an ammunition rack
  //        (BLAST_KG.vehicleAmmo), false a hulk brewing up (BLAST_KG.vehicle)
  // Every size and every life below is blastOf's (AV-01, combat/blast.js):
  // nothing here is a size of its own.
  explosion(pos, big = false) {
    const kg = typeof big === 'number' && big > 0 ? big
      : big ? BLAST_KG.vehicleAmmo : BLAST_KG.vehicle;
    const b = (this.blastRec = blastOf(kg, 0, this.blastRec));
    const L = b.L;
    const q = this.density;
    const F = b.fireball;
    const gy = this.groundUnder(pos.x, pos.z);
    const onGround = pos.y - gy < F.diameter;

    // Light: the fireball's, for as long as it burns. One light per blast.
    this.flash(pos, b.flash.intensity * 1.6, 0xff8030, b.flash.radius * 1.4, 3, F.lightLife);

    // Fireball: soft additive blobs that swell fast and cool as they go,
    // which is the difference between a detonation and an orange firework.
    const fu = this.fire.unit;
    const r = F.diameter * 0.5;
    const nF = Math.max(4, Math.round(F.count * q));
    for (let i = 0; i < nF; i++) {
      tv.set(pos.x + rand(-0.5, 0.5) * r, pos.y + rand(-0.3, 0.6) * r, pos.z + rand(-0.5, 0.5) * r);
      tv2.set(rand(-1, 1) * F.rise, rand(0.2, 1.2) * F.rise, rand(-1, 1) * F.rise);
      this.fire.spawn(tv, tv2, rand(F.lifeMin, F.lifeMax),
        i % 3 === 0 ? 0xfff0c0 : 0xff7a20, -3 / L, 3.2 / L,
        (F.diameter / fu) * rand(0.45, 0.8), 2.4, 1, 2.6);
    }
    // the core: one very bright, very short blob at the seat of the blast
    tv2.set(0, 2, 0);
    this.fire.spawn(pos, tv2, b.core.life * 2.5, 0xffffe0, -1, 5, b.core.diameter * 1.3 / fu, 1.6, 1, 4, 0.001);

    // Shockwave. Flat on the deck if it went off near the ground, otherwise a
    // spherical front facing whichever way the blast was travelling.
    const R = b.ring;
    this.rings.add(
      onGround ? tv.set(pos.x, gy + 0.15, pos.z) : pos,
      onGround ? WORLD_UP : tv3.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)),
      R.r0, R.r1 * 1.6, R.life, 0xffd8a0, 1.2,
    );

    const nS = Math.max(8, Math.round((14 + 6 * L) * q));
    for (let i = 0; i < nS; i++) {
      tv.set(rand(-1, 1) * F.rise * 2.6, rand(0.3, 1.8) * F.rise * 2, rand(-1, 1) * F.rise * 2.6);
      this.sparks.spawn(pos, tv, rand(0.3, 0.9) * Math.sqrt(L), i % 2 ? 0xffa030 : 0xffe080,
        14 / Math.sqrt(L), 1.5, rand(0.8, 1.6), 0, 1, 2.2);
    }
    const D = b.debris;
    const nD = Math.max(3, Math.round(D.count * q));
    for (let i = 0; i < nD; i++) {
      tv.set(rand(-0.8, 0.8) * D.speed, rand(0.3, 1.2) * D.speed, rand(-0.8, 0.8) * D.speed);
      this.debris.spawn(pos, tv, D.life * rand(0.5, 1), 0x4a4038, 12, 0.4, rand(0.9, 1.9) * Math.sqrt(L));
    }
    const M = b.smoke;
    const su = this.smoke.unit;
    const nK = Math.max(4, Math.round(M.count * q));
    for (let i = 0; i < nK; i++) {
      tv.set(rand(-0.8, 0.8) * M.speed, rand(0.6, 1.8) * M.speed, rand(-0.8, 0.8) * M.speed);
      this.smoke.spawn(pos, tv, rand(M.lifeMin, M.lifeMax), BLAST_SMOKE, -1.2, 1.2,
        (M.puff / su) * rand(0.7, 1.3), 2.6, 0.8);
    }

    // The column. A detonation does not finish when the fire goes out — it
    // leaves a marker standing over the map that everybody can see and read.
    this.addColumn(pos, b.marker.life * rand(0.85, 1.15), b.marker.power);

    if (!onGround) return;
    tv.set(pos.x, gy, pos.z);
    if (Math.abs(pos.x) > 430 || Math.abs(pos.z) > 430) return;
    if (this.decalCd > 0) return;
    this.decalCd = 0.1;
    // a fuel fire scorches; the burn ring is the fireball's footprint
    this.decals.add(tv, F.diameter * rand(1.1, 1.5), DECAL_BURN, this.scorchColor, 0.95);
  }

  // ---------------- persistent smoke ----------------

  // A standing plume. Used by explosions and by anything else that wants a
  // column of smoke to keep rising after the fire is out.
  addColumn(pos, life, power = 1) {
    let slot = null;
    let oldest = -1;
    for (let i = 0; i < MAX_COLUMNS; i++) {
      const c = this.columns[i];
      if (!c.active) {
        slot = c;
        break;
      }
      const f = c.age / Math.max(0.1, c.life);
      if (f > oldest) {
        oldest = f;
        slot = c;
      }
    }
    if (!slot) return null;
    if (!slot.active) this.activeColumns++;
    slot.active = true;
    slot.pos.copy(pos);
    slot.age = 0;
    slot.life = life;
    slot.emit = 0;
    slot.power = power;
    return slot;
  }

  /** The marker plume a charge of `kg` TNT leaves, sized by the blast law. */
  addColumnKg(pos, kg) {
    const b = (this.blastRec = blastOf(kg, 0, this.blastRec));
    return this.addColumn(pos, b.marker.life, b.marker.power);
  }

  updateColumns(dt) {
    if (this.activeColumns === 0) return;
    for (let i = 0; i < MAX_COLUMNS; i++) {
      const c = this.columns[i];
      if (!c.active) continue;
      c.age += dt;
      if (c.age >= c.life) {
        c.active = false;
        this.activeColumns--;
        continue;
      }
      // thick and black at first, thinning to a grey haze as it dies
      const f = 1 - c.age / c.life;
      c.emit += (2.2 + 5 * f) * c.power * this.density * dt;
      while (c.emit >= 1) {
        c.emit -= 1;
        tv.set(
          c.pos.x + rand(-1.1, 1.1) * c.power,
          c.pos.y + rand(0, 1.6),
          c.pos.z + rand(-1.1, 1.1) * c.power,
        );
        tv2.set(rand(-0.7, 0.7), rand(2.2, 4.6) * (0.6 + 0.5 * c.power), rand(-0.7, 0.7));
        const dark = f > 0.5 ? FUEL_SMOKE : FUEL_SMOKE_THIN;
        this.smoke.spawn(tv, tv2, rand(3.5, 7.5), dark, -1.15, 0.85,
          rand(0.9, 1.6) * c.power, 3.2, 0.55 * (0.5 + 0.5 * f));
      }
      if (c.power > 1.2 && f > 0.55 && Math.random() < 3 * dt) {
        tv.set(c.pos.x + rand(-0.8, 0.8), c.pos.y + rand(0, 1), c.pos.z + rand(-0.8, 0.8));
        tv2.set(rand(-1, 1), rand(2, 5), rand(-1, 1));
        this.fire.spawn(tv, tv2, rand(0.2, 0.45), 0xff7a24, -2, 2.5, rand(0.7, 1.3), 1.8, 1, 1.8);
      }
    }
  }

  // Register a burning hulk. The battle files call this with a random gate
  // every few frames for every dead vehicle on the map, so it dedupes by
  // position and then keeps the fire going on its own — a wreck that stops
  // smoking the moment the caller loses interest is what makes a battlefield
  // look swept clean. X-05: it also lays the hulk's ground glow.
  //
  // hulk: true ONLY for a dead vehicle standing on the ground (a tank hulk,
  // a burnt-out truck or gun). Only a hulk gets the X-05 ground glow, the
  // 50-200 m column, the flame that never quite goes out and cook-offs —
  // for as long as the caller keeps re-registering it (the hull is on the
  // map); once it stops, those fade out (HULK_LOST) and the smoulder stays.
  // Without the flag it is a transient smoke point (a falling or smoking
  // aeroplane, a coasting rocket, a tank burning on the move, the artillery
  // marker): smoke, a lick of flame while the caller keeps re-registering it,
  // and it tapers out once nobody does. The two never share slots.
  wreckSmoke(pos, hulk = false) {
    if (!hulk) return this.smokePoint(pos);
    for (let i = 0; i < this.wrecks.length; i++) {
      const w = this.wrecks[i];
      const dx = w.pos.x - pos.x;
      const dz = w.pos.z - pos.z;
      const dy = w.pos.y - pos.y;
      if (dx * dx + dy * dy + dz * dz < 16) {
        w.seen = this.time;
        return w;
      }
    }
    // a hulk is on the ground by definition; anything well above it is not
    if (pos.y - this.groundUnder(pos.x, pos.z) > HULK_MAX_AGL) return this.smokePoint(pos);
    let w;
    if (this.wrecks.length < MAX_WRECKS) {
      w = {
        pos: new THREE.Vector3(), age: 0, emit: 0, plumeEmit: 0, seen: 0,
        slot: this.wrecks.length, ph: 0, jet: 0, jetEmit: 0, jetPos: new THREE.Vector3(), hulk: true,
      };
      this.wrecks.push(w);
    } else {
      // full: recycle whichever has been burning longest
      w = this.wrecks[0];
      for (let i = 1; i < this.wrecks.length; i++) {
        if (this.wrecks[i].age > w.age) w = this.wrecks[i];
      }
    }
    w.pos.copy(pos);
    w.age = 0;
    w.emit = 0;
    w.plumeEmit = 0;
    w.seen = this.time;
    w.ph = Math.random() * 100;
    w.jet = 0;
    w.hulk = true;
    this.glow.place(w.slot, pos.x, pos.z);
    return w;
  }

  // A transient smoke point (see wreckSmoke). Dedupes by position like a
  // hulk; when the pool is full the one nobody has asked about for longest
  // is recycled, so a marker or a burning tank that keeps re-registering is
  // never pushed out by a falling aeroplane's trail.
  smokePoint(pos) {
    const pts = this.smokePoints;
    let free = null;
    let lru = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p.live) {
        if (!free) free = p;
        continue;
      }
      const dx = p.pos.x - pos.x;
      const dy = p.pos.y - pos.y;
      const dz = p.pos.z - pos.z;
      if (dx * dx + dy * dy + dz * dz < 16) {
        p.seen = this.time;
        return p;
      }
      if (!lru || p.seen < lru.seen) lru = p;
    }
    const p = free || lru;
    p.live = true;
    p.pos.copy(pos);
    p.age = 0;
    p.emit = 0;
    p.seen = this.time;
    return p;
  }

  // X-05: the ammunition cooking off — flame jets 3-8 m out of the hatches
  // for 1-5 s. pos is the hatch (the turret roof will do). The hulk it
  // belongs to is registered, or found, so the jets are part of its fire.
  // Returns null if pos is not near the ground (no hulk, no jets).
  cookOff(pos, duration = 0) {
    const w = this.wreckSmoke(pos, true);
    if (!w || !w.hulk) return null;
    w.jet = duration > 0 ? duration : rand(1, 5);
    w.jetEmit = 0;
    w.jetPos.copy(pos);
    return w;
  }

  // Transient smoke points (see wreckSmoke): the smoke a hulk makes, at the
  // pre-X-05 rate, a lick of flame only while the caller is still there and
  // hot, and nothing once it has tapered out. No glow, no column.
  updateSmokePoints(dt) {
    const q = this.density;
    const t = this.time;
    const pts = this.smokePoints;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p.live) continue;
      const since = t - p.seen;
      if (since > TRANSIENT_TAIL) {
        p.live = false;
        continue;
      }
      p.age += dt;
      const hot = clamp(1 - p.age / 26, 0, 1);
      const held = since <= TRANSIENT_HOLD;
      const fade = held ? 1 : 1 - (since - TRANSIENT_HOLD) / (TRANSIENT_TAIL - TRANSIENT_HOLD);
      p.emit += (0.9 + 2.6 * hot) * q * fade * dt;
      while (p.emit >= 1) {
        p.emit -= 1;
        tv.set(p.pos.x + rand(-0.7, 0.7), p.pos.y + rand(-0.2, 0.7), p.pos.z + rand(-0.7, 0.7));
        tv2.set(rand(-0.5, 0.5), rand(1.8, 3.6) + hot * 1.4, rand(-0.5, 0.5));
        this.smoke.spawn(tv, tv2, rand(3.5, 7), hot > 0.5 ? FUEL_SMOKE : FUEL_SMOKE_THIN,
          -0.95, 0.8, rand(1, 1.6), 3, 0.95 * (0.6 + 0.4 * hot) * (0.4 + 0.6 * fade));
      }
      if (held && hot > 0.25 && Math.random() < 2.4 * hot * q * dt) {
        tv.set(p.pos.x + rand(-0.6, 0.6), p.pos.y + rand(0, 0.6), p.pos.z + rand(-0.6, 0.6));
        tv2.set(rand(-0.8, 0.8), rand(2.5, 5), rand(-0.8, 0.8));
        this.fire.spawn(tv, tv2, rand(0.2, 0.45), 0xff7020, -2.2, 2.4,
          rand(0.35, 0.7), 1.2, 1, 1.9);
      }
    }
  }

  updateWrecks(dt) {
    this.updateSmokePoints(dt);
    const n = this.wrecks.length;
    if (!n) return;
    const q = this.density;
    const t = this.time;
    const pu = this.plume.unit;
    for (let i = 0; i < n; i++) {
      const w = this.wrecks[i];
      w.age += dt;
      // a fresh kill boils; an hour-old hulk just smoulders, and it never
      // stops, because it is still sitting there
      const hot = clamp(1 - w.age / 26, 0, 1);
      // the flame's flicker, 2-6 Hz: drives the fire licks AND the glow
      const ph = w.ph;
      const flick = 0.72 + 0.12 * Math.sin(TAU * 2.3 * t + ph)
        + 0.09 * Math.sin(TAU * 3.7 * t + ph * 1.7) + 0.07 * Math.sin(TAU * 5.3 * t + ph * 2.9);
      // still on the map? (see HULK_LOST) — 1 while it is, to 0 once it is not
      const gone = t - w.seen - HULK_LOST;
      const here = gone <= 0 ? 1 : gone >= HULK_FADE ? 0 : 1 - gone / HULK_FADE;
      this.glow.set(w.slot, (0.2 + 0.8 * hot) * flick * here);

      // the base of the column: dense fuel smoke right off the hulk
      w.emit += (0.9 + 2.6 * hot) * q * dt;
      while (w.emit >= 1) {
        w.emit -= 1;
        tv.set(w.pos.x + rand(-0.7, 0.7), w.pos.y + rand(-0.2, 0.7), w.pos.z + rand(-0.7, 0.7));
        tv2.set(rand(-0.5, 0.5), rand(1.8, 3.6) + hot * 1.4, rand(-0.5, 0.5));
        // fuel smoke is near-black AND thick: at dusk a thin black puff
        // over a dark sky simply is not there (browser check)
        this.smoke.spawn(tv, tv2, rand(3.5, 7), hot > 0.5 ? FUEL_SMOKE : FUEL_SMOKE_THIN,
          -0.95, 0.8, rand(1, 1.6), 3, 0.95 * (0.6 + 0.4 * hot));
      }
      // ...and the column itself, 50-200 m tall and leaning with the wind:
      // big slow puffs that rise ~5.5 m/s for 20-35 s and spread as they go
      // close enough that the puffs join into a column (browser check: at
      // 1.25 a second it read as a dotted line)
      w.plumeEmit += (0.5 + 1.5 * hot) * q * here * dt;
      while (w.plumeEmit >= 1) {
        w.plumeEmit -= 1;
        tv.set(w.pos.x + rand(-0.6, 0.6), w.pos.y + rand(1, 3), w.pos.z + rand(-0.6, 0.6));
        tv2.set(rand(-0.4, 0.4), rand(4.5, 7), rand(-0.4, 0.4));
        this.plume.spawn(tv, tv2, rand(20, 35), mixHex(FUEL_SMOKE, FUEL_SMOKE_THIN, 1 - hot),
          PLUME_BUOYANCY, PLUME_DRAG, (rand(3.5, 5) / pu), PLUME_GROW, 0.9 * (0.5 + 0.5 * hot), 1, 1.5);
      }
      // the flame at the hatches and through the engine deck: a steady lick
      // (a few alive at once while it is hot, an odd one as it smoulders),
      // in step with the glow's flicker
      if (Math.random() < (0.6 + 7 * hot) * q * flick * here * dt) {
        tv.set(w.pos.x + rand(-0.6, 0.6), w.pos.y + rand(0, 0.6), w.pos.z + rand(-0.6, 0.6));
        tv2.set(rand(-0.8, 0.8), rand(2.5, 5), rand(-0.8, 0.8));
        this.fire.spawn(tv, tv2, rand(0.2, 0.45), 0xff7020, -2.2, 2.4,
          rand(0.35, 0.7), 1.2, 1, 1.9);
      }
      // cook-off jets: hard, upward, 3-8 m tall
      if (w.jet > 0 && here > 0) {
        w.jet -= dt;
        w.jetEmit += 30 * q * dt;
        while (w.jetEmit >= 1) {
          w.jetEmit -= 1;
          tv.set(w.jetPos.x + rand(-0.25, 0.25), w.jetPos.y + rand(0, 0.3), w.jetPos.z + rand(-0.25, 0.25));
          tv2.set(rand(-1.2, 1.2), rand(11, 19), rand(-1.2, 1.2));
          this.fire.spawn(tv, tv2, rand(0.25, 0.5), Math.random() < 0.35 ? 0xffe0a0 : 0xff8a28,
            -2, 2.4, rand(0.25, 0.45), 1.4, 1, 2.6);
        }
      }
    }
  }

  // A vehicle actively on fire, ticked by the battle every few frames.
  burningTick(pos) {
    tv.set(rand(-1.5, 1.5), rand(3, 6), rand(-1.5, 1.5));
    this.fire.spawn(pos, tv, rand(0.22, 0.5), 0xff7a24, -2.4, 2.2, rand(0.6, 1.2), 1.9, 1, 2);
    this.sparks.spawn(pos, tv.set(rand(-1.5, 1.5), rand(4, 8), rand(-1.5, 1.5)),
      rand(0.3, 0.7), 0xffb040, -1.5, 1, rand(0.6, 1.1), 0, 1, 2);
    this.smoke.spawn(pos, tv.set(rand(-1, 1), rand(2, 4), rand(-1, 1)),
      rand(2, 4), FUEL_SMOKE, -1.1, 1, rand(0.8, 1.4), 2.8, 0.75);
    // and it keeps smoking once it has stopped burning
    this.wreckSmoke(pos);
  }

  // ---------------- ground vehicles ----------------

  // Dirt thrown off the running gear. Called every frame per moving tank, so it
  // is rate-based rather than burst-based: a crawling tank barely powders the
  // grass, a Stuart at full tilt drags a plume behind it. How much of it there
  // is comes from the map — sand goes up in a wall, snow barely marks.
  //
  // X-07 (contract R2-T): with the hull's yaw, the track gauge (centre to
  // centre) and the track width also given, it lays the track prints too —
  // every metre travelled, on any ground, snow included. Without them it is
  // the dust alone, as before. Call it every frame the tank moves at all:
  // the dust gates itself on speed, the prints must not.
  // surfaceColor is the sRGB dust hex terrainSurface() reports (or 0 for the
  // map's own); it is converted to the albedo the pool reads (AV-03).
  trackDust(pos, speedNorm, surfaceColor = 0, dt = 0.016, yaw = null, gauge = 0, trackWidth = 0) {
    if (yaw != null && gauge > 0 && trackWidth > 0 && (this.prints || this.ensurePrints())) {
      this.prints.track(pos.x, pos.z, yaw, gauge, trackWidth, this.time, this.printLookFn);
    }
    const s = clamp(speedNorm, 0, 1);
    if (s < 0.07) return;
    const dry = this.dustFactor;
    if (dry < 0.09) return; // deep snow: the tracks pack it, they do not lift it
    const col = surfaceColor ? linCached(surfaceColor) : this.groundDustLin;
    const rate = (1.5 + 20 * s) * s * this.density * dry;
    if (Math.random() > rate * dt) return;
    tv.set(pos.x + rand(-0.9, 0.9), pos.y + rand(0, 0.35), pos.z + rand(-0.9, 0.9));
    tv2.set(rand(-1.6, 1.6), rand(0.7, 2.4) + s * 1.6, rand(-1.6, 1.6));
    this.dust.spawn(tv, tv2, (rand(0.6, 1.4) + s * 0.6) * clamp(dry, 0.5, 1.4), col,
      1.1, 1.5, rand(0.7, 1.3) * (0.7 + 0.5 * dry), 2.4, 0.62 * clamp(dry, 0.4, 1.3));
    // Above about half speed the tracks start throwing actual clods, not dust.
    if (s > 0.5 && dry > 0.5 && Math.random() < 0.25) {
      tv2.set(rand(-3, 3), rand(2, 5), rand(-3, 3));
      this.debris.spawn(tv, tv2, rand(0.35, 0.8), scaleHex(col, 0.45), 11, 0.6, rand(0.7, 1.3));
    }
  }

  // The print field, built once on demand (null on the low tier).
  ensurePrints() {
    if (this.prints || !(this.printCap > 0)) return this.prints;
    this.prints = new TrackPrintField(this.scene, this.printCap, this.decals, this.fxU);
    if (this.printLight) this.prints.setLight(this.printLight[0], this.printLight[1]);
    return this.prints;
  }

  // AV-04: the exhaust's answer to a rev event (tankEntity.revKick: a gear
  // taken, or a stab of throttle) — thrown on the same frame the engine
  // voice is told about the shift. A diesel (the V-2) coughs a black puff,
  // Y .03-.05; a petrol engine a light grey wisp. pos: tank.exhaustWorld().
  exhaustPuff(pos, kind = 'petrol', cause = 'throttle') {
    const q = this.density;
    const diesel = kind === 'diesel';
    const n = Math.max(1, Math.round((diesel ? (cause === 'throttle' ? 4 : 3) : 1) * clamp(q, 0.5, 1)));
    for (let i = 0; i < n; i++) {
      tv.set(pos.x + rand(-0.25, 0.25), pos.y + rand(0, 0.2), pos.z + rand(-0.25, 0.25));
      tv2.set(rand(-0.5, 0.5), rand(1.2, 2.6), rand(-0.5, 0.5));
      if (diesel) {
        this.smoke.spawn(tv, tv2, rand(1, 2), DIESEL_PUFF, -0.4, 1.4,
          rand(0.22, 0.38), 2.6, 0.8, 1, 0.05);
      } else {
        this.smoke.spawn(tv, tv2, rand(0.8, 1.5), PETROL_WISP, -0.5, 1.4,
          rand(0.16, 0.26), 2.2, 0.3, 1, 0.05);
      }
    }
    this.exhaustPuffs = (this.exhaustPuffs || 0) + 1;
  }

  // ---------------- damage states ----------------

  // Damaged engines, in three stages. Rate-based like trackDust because the
  // caller ticks it every frame for as long as the module stays broken. `vel`
  // is optional: hand it the vehicle's velocity and the plume is laid down in
  // its wake rather than dropped where the hull was a frame ago.
  engineSmoke(pos, severity = 'light', dt = 0.016, vel = null) {
    const q = this.density;
    const vx = vel ? vel.x * 0.35 : 0;
    const vy = vel ? vel.y * 0.35 : 0;
    const vz = vel ? vel.z * 0.35 : 0;
    if (severity === 'fire') {
      if (Math.random() < 26 * q * dt) {
        tv.set(pos.x + rand(-0.5, 0.5), pos.y + rand(-0.2, 0.4), pos.z + rand(-0.5, 0.5));
        tv2.set(vx + rand(-1, 1), vy + rand(3.5, 7), vz + rand(-1, 1));
        this.fire.spawn(tv, tv2, rand(0.18, 0.4), Math.random() < 0.3 ? 0xffd070 : 0xff6820,
          -2.5, 1.6, rand(0.4, 0.9), 1.8, 1, 2);
      }
      if (Math.random() < 22 * q * dt) {
        tv.set(pos.x + rand(-0.6, 0.6), pos.y + rand(0.2, 0.9), pos.z + rand(-0.6, 0.6));
        tv2.set(vx + rand(-0.8, 0.8), vy + rand(2.4, 4.4), vz + rand(-0.8, 0.8));
        this.smoke.spawn(tv, tv2, rand(2.2, 4.2), 0x1e1c1a, -1.1, 1,
          rand(0.7, 1.2), 3, 0.85);
      }
      this.engineTick = (this.engineTick + 1) % 9;
      if (this.engineTick === 0) this.flash(pos, rand(18, 34), 0xff7a28, 12, 10);
      return;
    }
    const heavy = severity === 'heavy';
    // A hit engine does not only smoke, it bleeds: oil and unburnt fuel come
    // out as a thin dark thread that hangs behind the aeroplane far longer than
    // the smoke does. It is the trail you follow a runner home by.
    if (heavy && Math.random() < 9 * q * dt) {
      tv.set(pos.x + rand(-0.25, 0.25), pos.y + rand(-0.2, 0.2), pos.z + rand(-0.25, 0.25));
      tv2.set(vx * 0.6 + rand(-0.3, 0.3), vy * 0.6 + rand(-0.4, 0.3), vz * 0.6 + rand(-0.3, 0.3));
      this.trails.spawn(tv, tv2, rand(2.5, 5), 0x2b2620, 0.12, 0.5,
        rand(0.35, 0.7), 2.2, 0.7);
    }
    if (Math.random() > (heavy ? 17 : 6) * q * dt) return;
    tv.set(pos.x + rand(-0.4, 0.4), pos.y + rand(0, 0.5), pos.z + rand(-0.4, 0.4));
    tv2.set(vx + rand(-0.6, 0.6), vy + (heavy ? rand(2.2, 4) : rand(1.2, 2.4)), vz + rand(-0.6, 0.6));
    this.smoke.spawn(
      tv,
      tv2,
      heavy ? rand(2, 3.6) : rand(1, 2),
      heavy ? 0x322f2b : 0x8e8a80,
      heavy ? -0.9 : -0.6,
      1.1,
      heavy ? rand(0.7, 1.2) : rand(0.45, 0.8),
      heavy ? 2.6 : 1.8,
      heavy ? 0.7 : 0.4,
    );
  }

  // The thin oil thread on its own, for a caller that wants to draw a leak
  // without the smoke that engineSmoke('heavy') comes with.
  oilTrail(pos, strength = 1, dt = 0.016, vel = null) {
    const s = clamp(strength, 0, 1);
    if (s <= 0.02) return;
    if (Math.random() > 16 * s * this.density * dt) return;
    tv.set(pos.x + rand(-0.25, 0.25), pos.y + rand(-0.2, 0.2), pos.z + rand(-0.25, 0.25));
    tv2.set(
      (vel ? vel.x * 0.2 : 0) + rand(-0.3, 0.3),
      (vel ? vel.y * 0.2 : 0) + rand(-0.5, 0.2),
      (vel ? vel.z * 0.2 : 0) + rand(-0.3, 0.3),
    );
    this.trails.spawn(tv, tv2, rand(2.5, 5.5) * (0.6 + 0.6 * s), 0x2b2620, 0.12, 0.5,
      rand(0.3, 0.7) * (0.6 + 0.6 * s), 2.4, 0.75 * s);
  }

  // ---------------- aircraft ----------------

  // Wingtip condensation at speed. Ribbon, not puffs, so it emits fast and the
  // particles barely move once laid down.
  contrail(pos, strength = 1, dt = 0.016) {
    const s = clamp(strength, 0, 1);
    if (s <= 0.02) return;
    if (Math.random() > 34 * s * this.density * dt) return;
    tv.set(pos.x + rand(-0.2, 0.2), pos.y + rand(-0.2, 0.2), pos.z + rand(-0.2, 0.2));
    tv2.set(rand(-0.35, 0.35), rand(-0.2, 0.2), rand(-0.35, 0.35));
    this.trails.spawn(tv, tv2, rand(3, 5.5) * (0.6 + 0.6 * s), 0xf2f8ff, -0.02, 0.35,
      rand(0.5, 0.9), 2.6, 0.8 * (0.4 + 0.6 * s));
  }

  // The short-lived vapour that rips off a wing under load. Denser, tighter and
  // gone in a second — it should read as a stress cue, not as a trail. It grows
  // hard as it goes, which is what the real thing does as the pressure recovers.
  wingVortex(pos, strength = 1, dt = 0.016) {
    const s = clamp(strength, 0, 1);
    if (s <= 0.05) return;
    if (Math.random() > 30 * s * this.density * dt) return;
    tv.set(pos.x + rand(-0.3, 0.3), pos.y + rand(-0.3, 0.3), pos.z + rand(-0.3, 0.3));
    tv2.set(rand(-1.4, 1.4), rand(-1.2, 0.4), rand(-1.4, 1.4));
    this.trails.spawn(tv, tv2, rand(0.45, 1.1) * (0.5 + s), 0xffffff, 0.3, 1.6,
      rand(0.35, 0.7) * (0.6 + 0.6 * s), 2.8, 0.95 * s);
  }

  // ---------------- smoke screens ----------------

  // A persistent, growing cloud dense enough to actually hide a vehicle. Returns
  // the internal record so the caller can hold on to it (or ignore it); the
  // screen expires on its own. blocksLineOfSight() is the gameplay half.
  smokeScreen(pos, radius = 9, duration = 20) {
    let slot = null;
    let oldest = -1;
    for (let i = 0; i < MAX_SCREENS; i++) {
      const s = this.smokeScreens[i];
      if (!s.active) {
        slot = s;
        break;
      }
      // All busy: recycle whichever is furthest through its life.
      const f = s.age / Math.max(0.1, s.life);
      if (f > oldest) {
        oldest = f;
        slot = s;
      }
    }
    slot.active = true;
    slot.pos.copy(pos);
    slot.maxRadius = Math.max(2, radius);
    slot.radius = slot.maxRadius * 0.28;
    slot.age = 0;
    slot.life = Math.max(1, duration);
    slot.density = 0;
    slot.emit = 0;
    // The volume sits on the ground under the given point. Callers hand over
    // a point a metre or three up (the grenade's burst height, a depot's
    // roof); anything far higher than that is taken as its own base.
    const gy = this.groundUnder(pos.x, pos.z);
    slot.ground = pos.y - gy < 8 ? Math.min(pos.y, gy) : pos.y;
    slot.seed = Math.random() * 64;
    // Initial bloom, so the grenade reads instantly instead of easing in.
    const n = Math.round(26 * this.density);
    for (let i = 0; i < n; i++) this.puffScreen(slot, 0.4);
    this.countScreens();
    return slot;
  }

  // One billboard on a screen. Split out because both the initial bloom and
  // the per-frame emission want it. The volume core is the screen's body; the
  // billboards are its surface, so they go in the outer shell of the volume
  // (55-102 % of the way out, biased outward) where the eye actually lands —
  // a puff placed deep inside would only be veiled by the core in front of
  // it. Anything that would be buried is mirrored up off the ground, so smoke
  // piles up along the ground the way it does.
  puffScreen(s, spreadScale = 1) {
    const sh = screenShape(s, SHAPE);
    let x = 0;
    let y = 1;
    let z = 0;
    for (let k = 0; k < 8; k++) {
      const ux = Math.random() * 2 - 1;
      const uy = Math.random() * 2 - 1;
      const uz = Math.random() * 2 - 1;
      const r2 = ux * ux + uy * uy + uz * uz;
      if (r2 >= 1 || r2 < 1e-4) continue;
      const k1 = 1 / Math.sqrt(r2);
      x = ux * k1;
      y = uy * k1;
      z = uz * k1;
      break;
    }
    const r = (0.55 + 0.47 * Math.pow(Math.random(), 0.6)) * spreadScale;
    const base = s.ground + 0.35;
    let wy = sh.cy + y * r * sh.rv;
    if (wy < base) wy = Math.min(base + (base - wy), sh.cy + sh.rv * 0.9);
    tv.set(sh.cx + x * r * sh.rh, wy, sh.cz + z * r * sh.rh);
    // While the cloud is still swelling, its surface moves outward and the
    // puffs have to ride it, or the ones laid down in the first second end up
    // buried in the middle of a cloud that grew past them. Same relative rate
    // as updateSmokeScreens' radius curve.
    const gu = clamp(s.age / 3, 0, 1);
    const swell = (s.maxRadius * 0.72 * (2 / 3) * (1 - gu)) / Math.max(0.5, s.radius);
    tv2.set(
      rand(-0.7, 0.7) + (tv.x - sh.cx) * swell,
      rand(0.15, 0.75) + Math.max(0, tv.y - sh.cy) * swell * 0.6,
      rand(-0.7, 0.7) + (tv.z - sh.cz) * swell,
    );
    // a bigger cloud billows in bigger lumps
    const big = clamp(s.maxRadius / 12, 0.8, 1.8);
    this.screenPool.spawn(tv, tv2, rand(4.5, 8), SCREEN_PUFF, -0.12, 0.75,
      rand(0.75, 1.25) * big, 0.7, 1);
  }

  countScreens() {
    let n = 0;
    for (let i = 0; i < MAX_SCREENS; i++) if (this.smokeScreens[i].active) n++;
    this.activeScreens = n;
  }

  // Hand the live screens to the GPU: the volume core draws one instance per
  // packed screen, and every particle and tracer shader integrates the same
  // list to know how much smoke stands between it and the camera.
  packScreens() {
    const A = this.fxU.uSmkA.value;
    const B = this.fxU.uSmkB.value;
    let n = 0;
    for (let i = 0; i < MAX_SCREENS; i++) {
      const s = this.smokeScreens[i];
      if (!s.active || s.density <= 0) continue;
      const sh = screenShape(s, SHAPE);
      A[n].set(sh.cx, sh.cy, sh.cz, sh.rho);
      B[n].set(sh.rh, sh.rv, sh.floor, s.seed);
      n++;
    }
    this.fxU.uSmkN.value = n;
    this.core.setCount(n);
    this.packedScreens = n;
  }

  updateSmokeScreens(dt) {
    if (this.activeScreens === 0) {
      if (this.packedScreens) this.packScreens();
      return;
    }
    let changed = false;
    for (let i = 0; i < MAX_SCREENS; i++) {
      const s = this.smokeScreens[i];
      if (!s.active) continue;
      s.age += dt;
      if (s.age >= s.life) {
        s.active = false;
        s.density = 0;
        changed = true;
        continue;
      }
      // Grows fast then settles, the way a burst of smoke composition does.
      const gu = clamp(s.age / 3, 0, 1);
      s.radius = s.maxRadius * (0.28 + 0.72 * (1 - (1 - gu) * (1 - gu)));
      // Opaque within a second, holds, then thins out over the last quarter.
      const fadeIn = clamp(s.age / 1.1, 0, 1);
      const left = s.life - s.age;
      const fadeOut = clamp(left / Math.min(4, s.life * 0.3), 0, 1);
      s.density = Math.min(fadeIn, fadeOut);

      // twice the puffs while it swells, so the growing surface stays covered
      s.emit += 44 * s.density * this.density * (2 - gu) * dt;
      while (s.emit >= 1) {
        s.emit -= 1;
        this.puffScreen(s, 1);
      }
    }
    if (changed) this.countScreens();
    this.packScreens();
  }

  // How opaque the volume is drawn per unit of optical depth: tuned so that
  // exactly losThreshold of it is 95 % opaque. See the block at the top.
  smokeKappa() {
    return Math.log(20) / Math.max(0.5, this.losThreshold);
  }

  // Optical depth of smoke-screen volume on the segment from -> to, in metres
  // of full-density smoke (the integral of the screens' density profile along
  // it). Screens thinner than minDensity are ignored — the sight-line rule
  // ignores a screen still bursting open (< 0.25), the picture does not.
  smokeOpticalDepth(from, to, minDensity = 0) {
    if (this.activeScreens === 0) return 0;
    this.integrateScreens(from, to, minDensity);
    return SEG[8];
  }

  // The body of all three sight-line queries: loads the segment into SEG and
  // leaves its optical depth in SEG[8] instead of returning it, so the queries
  // that only want a yes/no (blocksLineOfSight) never box a double at all.
  // Straight-line on purpose — no early out, and nothing here writes SEG[8]:
  // when this is inlined into a caller, a path that stores SEG[8] merging with
  // one that calls screensTau makes V8 box the depth it then reads back
  // (measured, 16 B a call). screensTau handles the degenerate segment itself.
  integrateScreens(from, to, minDensity) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const il = 1 / Math.max(len, 1e-9);
    SEG[0] = from.x;
    SEG[1] = from.y;
    SEG[2] = from.z;
    SEG[3] = dx * il;
    SEG[4] = dy * il;
    SEG[5] = dz * il;
    SEG[6] = 0;
    SEG[7] = len;
    screensTau(this.smokeScreens, minDensity);
  }

  // True when enough smoke sits on the segment for the shot to be blind: the
  // optical depth through every screen on it reaches losThreshold. A line that
  // clips the thin rim of a screen does not blind anybody; one through the
  // middle certainly does. Whatever this calls blocked is DRAWN at >= 95 %
  // opacity — same integral, see smokeOpacityAlong().
  blocksLineOfSight(from, to) {
    if (this.activeScreens === 0) return false;
    this.integrateScreens(from, to, 0.25);
    return SEG[8] >= this.losThreshold;
  }

  // 0..1: how opaque the smoke-screen volume is drawn along from -> to — what
  // fraction of whatever stands at `to` the player cannot see from `from`.
  // It is the exact opacity of the volume core and therefore a LOWER bound on
  // the picture (the billboards on top only add). >= 0.95 exactly when
  // blocksLineOfSight would say blocked (ignoring its 0.25 burst-open gate).
  // Use it to fade a spotting marker or an AI's confidence smoothly instead
  // of switching them at the threshold. One closed-form chord per live
  // screen, no allocation: fine to call per unit per frame.
  smokeOpacityAlong(from, to) {
    if (this.activeScreens === 0) return 0;
    this.integrateScreens(from, to, 0);
    return 1 - Math.exp(-this.smokeKappa() * SEG[8]);
  }

  // 0..1 thickness of smoke at a point — for gunner accuracy penalties, AI
  // spotting, or fogging the sight picture when the player sits inside one.
  // 1 at the heart of a fully formed screen, falling to 0 at its rim.
  smokeDensityAt(pos) {
    if (this.activeScreens === 0) return 0;
    let d = 0;
    for (let i = 0; i < MAX_SCREENS; i++) {
      const s = this.smokeScreens[i];
      if (!s.active || s.density <= 0) continue;
      const sh = screenShape(s, SHAPE);
      if (pos.y < sh.floor) continue;
      const qx = (pos.x - sh.cx) / sh.rh;
      const qy = (pos.y - sh.cy) / sh.rv;
      const qz = (pos.z - sh.cz) / sh.rh;
      const q2 = qx * qx + qy * qy + qz * qz;
      if (q2 >= 1) continue;
      d += s.density * (1 - q2);
    }
    return clamp(d, 0, 1);
  }

  clearSmokeScreens() {
    for (let i = 0; i < MAX_SCREENS; i++) {
      this.smokeScreens[i].active = false;
      this.smokeScreens[i].density = 0;
    }
    this.activeScreens = 0;
    this.packScreens();
  }

  // ---------------- terrain and scenery ----------------

  // Splinters and foliage off a tree or a fence taking a hit. The leaves get
  // heavy drag and almost no gravity so they hang and flutter down.
  treeDebris(pos) {
    const q = this.density;
    const n = Math.max(3, Math.round(10 * q));
    for (let i = 0; i < n; i++) {
      tv2.set(rand(-6, 6), rand(2, 9), rand(-6, 6));
      this.debris.spawn(pos, tv2, rand(0.5, 1.2), i % 3 === 0 ? 0x8a7448 : 0x4a3a26,
        13, 0.6, rand(0.7, 1.4));
    }
    const nL = Math.max(3, Math.round(12 * q));
    for (let i = 0; i < nL; i++) {
      tv.set(pos.x + rand(-1.2, 1.2), pos.y + rand(-0.6, 1.4), pos.z + rand(-1.2, 1.2));
      tv2.set(rand(-3.5, 3.5), rand(0.5, 3.5), rand(-3.5, 3.5));
      this.debris.spawn(tv, tv2, rand(1.4, 3), i % 4 === 0 ? 0x6d7a3a : 0x3f5326,
        1.6, 2.2, rand(0.6, 1.2));
    }
    tv.set(pos.x + rand(-0.5, 0.5), pos.y + rand(0, 0.8), pos.z + rand(-0.5, 0.5));
    tv2.set(rand(-0.8, 0.8), rand(0.8, 2), rand(-0.8, 0.8));
    this.dust.spawn(tv, tv2, rand(0.7, 1.6), 0x8f8468, 1.5, 1.4, rand(0.6, 1.1), 2, 0.5);
  }

  // Put a mark on the ground directly. kind: 'crater' | 'scorch' | 'burn' |
  // 'splash'. Returns false when the cap is busy or the point is off the map.
  groundDecal(pos, diameter, kind = 'scorch', colorHex = null) {
    if (Math.abs(pos.x) > 430 || Math.abs(pos.z) > 430) return false;
    const k = kind === 'crater' ? DECAL_CRATER
      : kind === 'burn' ? DECAL_BURN
        : kind === 'splash' ? DECAL_SPLASH : DECAL_SCORCH;
    // colorHex, if given, is a LINEAR tint (the decal's vertex colour);
    // the defaults are the map's dust and soot as albedos
    const col = colorHex != null ? colorHex
      : (k === DECAL_CRATER || k === DECAL_SPLASH ? this.groundDustLin : this.scorchColor);
    tv.set(pos.x, this.groundUnder(pos.x, pos.z), pos.z);
    return this.decals.add(tv, diameter, k, col, 1);
  }

  // ---------------- frame ----------------

  update(dt) {
    this.time += dt;
    this.decalCd -= dt;
    // A battle rolls its map once, but nothing tells the effects system when;
    // the check is an id comparison, so asking every frame costs nothing.
    this.readPreset();
    this.fxU.uFxTime.value = this.time;
    this.fxU.uSmkKappa.value = this.smokeKappa();

    this.sparks.update(dt);
    this.smoke.update(dt);
    this.dust.update(dt);
    this.debris.update(dt);
    this.trails.update(dt);
    this.fire.update(dt);
    this.updateSmokeScreens(dt);
    this.screenPool.update(dt);
    this.updateColumns(dt);
    this.updateWrecks(dt);
    this.plume.update(dt);
    this.rings.update(dt);
    this.tracers.update(dt, this);
    this.decals.update(dt);
    if (this.prints) this.prints.update();
    for (const l of this.flashes) {
      if (l.intensity <= 0) continue;
      if (l.userData.fresh) {
        l.userData.fresh = false;
        if (l.userData.life <= dt) continue;
      }
      l.userData.life -= dt;
      l.intensity = Math.max(0, l.intensity - l.intensity * l.userData.decay * dt);
      if (l.intensity < 0.05 || l.userData.life <= 0) l.intensity = 0;
    }
  }

  // Full teardown between battles. clearSmokeScreens() deliberately does NOT
  // do this: it is called on match end while the wreckage is still meant to be
  // sitting there behind the results screen.
  reset() {
    for (const pool of this.pools) pool.clear();
    this.clearSmokeScreens();
    this.rings.clear();
    this.tracers.clear();
    this.decals.clear();
    this.glow.clear();
    if (this.prints) this.prints.clear();
    this.wrecks.length = 0;
    for (let i = 0; i < this.smokePoints.length; i++) this.smokePoints[i].live = false;
    for (let i = 0; i < MAX_COLUMNS; i++) this.columns[i].active = false;
    this.activeColumns = 0;
    for (const l of this.flashes) l.intensity = 0;
  }

  dispose() {
    this.reset();
    for (const pool of this.pools) pool.dispose();
    this.rings.dispose();
    this.tracers.dispose();
    this.decals.dispose();
    this.glow.dispose();
    if (this.prints) this.prints.dispose();
    this.core.dispose();
    for (const l of this.flashes) l.parent?.remove(l);
  }
}
