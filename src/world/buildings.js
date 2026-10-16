import * as THREE from 'three';
import { markSharedGeometry, getMaterialQuality } from '../core/materials.js';
import { loadTexture, getAssetSet } from '../core/assets.js';

// Village architecture kits (CONTRACT B of the maps audit).
//
//   buildingKit(style, quality) -> {
//     materials: { walls, roof, trim },
//     archetypes: [{ key, role, w, d, h, solidR,
//                    parts: { walls, roof, trim },      // BufferGeometry each
//                    ruin:  { walls, rubble } }],       // BufferGeometry each
//     ...extra read-only info (style, quality, palette, per-archetype eave/pitch/tris)
//   }
//
// style: 'normandy' | 'izba' | 'khata' | 'desert' | 'nordic' (unknown -> normandy)
// quality: 'low' | 'medium' | 'high' (unknown -> materials.js quality)
//
// AUTHORING CONVENTION — every geometry in a kit:
//   * origin at the footprint centre, base y = 0 (foundations run below 0 so a
//     house on a slope never floats), +Z = street front, w along X, d along Z;
//   * w / d are the WALL footprint; roofs overhang it by 0.3-0.65 m on both axes;
//   * h is the top of the highest part (ridge, chimney or spire);
//   * INDEXED, with exactly the attributes position(3) normal(3) uv(2) color(3),
//     so every part and ruin piece of every archetype can go into one
//     THREE.BatchedMesh per material (BatchedMesh rejects mixed layouts);
//   * `color` is baked occlusion / weathering (never brighter than 1) — the
//     materials have vertexColors on, and a BatchedMesh setColorAt multiplies on
//     top of it, so per-instance tints should stay around 0.85-1.1;
//   * walls / roof UVs are world metres (box-mapped, roof v runs up the slope);
//     the textures carry repeat = 1 / tile so a metre is a metre everywhere;
//   * trim UVs address cells of a 4 x 4 atlas (windows, doors, shutters, brick,
//     louvres, sheet metal, log end grain ...).
//   * ruin.walls is authored for materials.walls; ruin.rubble is textured in
//     metres too and reads correctly with either materials.walls or .roof, so a
//     collapse can swap walls -> ruin.walls and roof -> ruin.rubble in place.
//
// Pitches follow the real building traditions: Normandy stone houses 50 deg with
// slate and gable chimneys; the Russian izba 40 deg gable-to-street with plank
// roof, carved window surrounds and crossed log corners; the Ukrainian khata
// whitewashed clay under a thick 35 deg hipped thatch; North-African flat roofs
// behind a 0.6 m parapet; Finnish/Karelian log houses, Falu-red with white
// corner boards, 35 deg roofs carrying snow. Every village gets a landmark
// (church: nave 10 x 22 m, tower 5 x 5 x 16 m, spire 8 m; the desert one is a
// mosque with a square minaret of the same proportions).
//
// SURFACES. Walls and roofs wear CC0 photo scans from core/assets.js (see
// "photo surfaces" below: detail-only scans tinted to the calibrated colours,
// a second layer chosen per building by its palette entry). The trim atlas is
// painted and gains photo grain per cell. setBuildingTextureMode('procedural')
// (or a scan missing from the manifest) falls back to the painted canvases.
// Painted textures are made pixel-by-pixel at first use and cached with
// the geometry for the rest of the session. Colours are decoded from hex BY HAND
// into sRGB bytes — never through THREE.Color, which would linearise them and
// the sRGB texture upload would then linearise them a second time (see
// materials.js srgbBytes). Everything cached is stamped shared so the battle
// teardown sweeps leave it alone; disposeBuildingKits() is the only way to free it.

export const BUILDING_STYLES = Object.freeze(['normandy', 'izba', 'khata', 'desert', 'nordic']);

const TEX_SIZE = { low: 128, medium: 256, high: 512 };
const TILE = 4;              // metres covered by one walls / roof texture tile
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// deterministic noise (no Math.random anywhere in this module)
// ---------------------------------------------------------------------------

function ih(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Value noise whose lattice wraps at (px, py), so a texture built from it tiles.
function vnoise(x, y, px, py, s) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % px) + px) % px;
  const y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const a = ih(x0, y0, s);
  const b = ih(x1, y0, s);
  const c = ih(x0, y1, s);
  const d = ih(x1, y1, s);
  const ab = a + (b - a) * u;
  return ab + (c + (d - c) * u - ab) * v;
}

// Tiling fbm over a unit tile; fx / fy are the integer base frequencies.
function fbm(u, v, fx, fy, s, oct = 3) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let mx = fx;
  let my = fy;
  for (let o = 0; o < oct; o++) {
    sum += amp * vnoise(u * mx, v * my, mx, my, s + o * 131);
    norm += amp;
    amp *= 0.5;
    mx *= 2;
    my *= 2;
  }
  return sum / norm;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
function smooth(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// Packed hex -> sRGB-ENCODED 0..1 triple. By hand, on purpose (see header).
function rgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

// ---------------------------------------------------------------------------
// canvas pipeline
// ---------------------------------------------------------------------------

// Runs fn(u, v, out, cellX, cellY) for every pixel. v runs UP the texture (the
// way geometry UVs read it with flipY), so "bottom of a slate course" in a
// painter is the bottom on the roof.
function paintSurface(size, fn) {
  const n = size * size;
  const alb = new Uint8ClampedArray(n * 4);
  const rgh = new Uint8ClampedArray(n * 4);
  const hgt = new Float32Array(n);
  const o = { r: 0.5, g: 0.5, b: 0.5, h: 0.5, ro: 0.9 };
  for (let y = 0; y < size; y++) {
    const v = 1 - (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      o.r = o.g = o.b = 0.5;
      o.h = 0.5;
      o.ro = 0.9;
      fn(u, v, o);
      const i = y * size + x;
      const j = i * 4;
      alb[j] = clamp01(o.r) * 255;
      alb[j + 1] = clamp01(o.g) * 255;
      alb[j + 2] = clamp01(o.b) * 255;
      alb[j + 3] = 255;
      const rv = clamp01(o.ro) * 255;
      rgh[j] = rv;
      rgh[j + 1] = rv;
      rgh[j + 2] = rv;
      rgh[j + 3] = 255;
      hgt[i] = o.h;
    }
  }
  return { size, alb, rgh, hgt };
}

// Height -> tangent-space normal (OpenGL convention, +Y = up the texture).
// strength is height-units per texel of slope; see relief().
function normalBytes(hgt, size, strength) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const yu = (y - 1 + size) % size;     // one row UP the texture (higher v)
    const yd = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size;
      const xr = (x + 1) % size;
      const dhdu = (hgt[y * size + xr] - hgt[y * size + xl]) * strength;
      const dhdv = (hgt[yu * size + x] - hgt[yd * size + x]) * strength;
      const inv = 1 / Math.hypot(dhdu, dhdv, 1);
      const j = (y * size + x) * 4;
      out[j] = (-dhdu * inv * 0.5 + 0.5) * 255;
      out[j + 1] = (-dhdv * inv * 0.5 + 0.5) * 255;
      out[j + 2] = (inv * 0.5 + 0.5) * 255;
      out[j + 3] = 255;
    }
  }
  return out;
}

// Relief of `metres` over a tile of `tileM` metres, as a normalBytes strength.
const relief = (metres, tileM, size) => (metres * size) / (2 * tileM);

function canvasOf(size, bytes) {
  let c = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      c = new OffscreenCanvas(size, size);
      if (!c.getContext('2d')) c = null;
    } catch {
      c = null;
    }
  }
  if (!c) {
    c = document.createElement('canvas');
    c.width = size;
    c.height = size;
  }
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  img.data.set(bytes);
  ctx.putImageData(img, 0, 0);
  return c;
}

function texture(canvas, { srgb = false, tile = 0 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (tile > 0) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / tile, 1 / tile);
  } else {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  }
  t.anisotropy = 8;                     // the renderer clamps to what it has
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  markSharedGeometry(t);
  return t;
}

// ---------------------------------------------------------------------------
// walls painters (one 4 m tile; u along the wall, v up)
// ---------------------------------------------------------------------------

// Coursed limestone rubble with lime mortar: Normandy farm walls. 14 courses
// per 4 m (0.29 m), 6-10 stones per course, per-stone tone, rain streaks.
function paintStone(size, P, seed) {
  const ROWS = 14;
  const cols = P.stones.map(rgb);
  const mortar = rgb(P.mortar);
  return paintSurface(size, (u, v, o) => {
    const rv = v * ROWS;
    const r = Math.floor(rv) % ROWS;
    const fy = rv - Math.floor(rv);
    const n = 6 + Math.floor(ih(r, 7, seed) * 5);
    const uu = u * n + Math.floor(ih(r, 3, seed) * n) + 0.5 * (r & 1);
    const k = ((Math.floor(uu) % n) + n) % n;
    const fx = uu - Math.floor(uu);
    const wob = fbm(u, v, 24, 24, seed + 11, 2);
    const d = Math.min(Math.min(fx, 1 - fx) * (TILE / n), Math.min(fy, 1 - fy) * (TILE / ROWS))
      + (wob - 0.5) * 0.045;
    const stone = smooth(0.006, 0.024, d);
    const c = cols[Math.floor(ih(k, r, seed + 5) * cols.length)];
    const tone = 0.84 + ih(k, r, seed + 9) * 0.26;
    const grain = fbm(u, v, 64, 64, seed + 23, 2);
    const blotch = fbm(u, v, 4, 4, seed + 41, 3);
    const streak = fbm(u, v, 20, 3, seed + 57, 2);
    const dirt = (1 - Math.max(0, streak - 0.55) * 0.55) * (0.94 + (blotch - 0.5) * 0.16);
    const s = tone * (0.9 + grain * 0.2);
    const m = 0.92 + grain * 0.12;
    o.r = lerp(mortar[0] * m, c[0] * s, stone) * dirt;
    o.g = lerp(mortar[1] * m, c[1] * s, stone) * dirt;
    o.b = lerp(mortar[2] * m, c[2] * s, stone) * dirt;
    // lichen on the weather side of a few stones
    const lich = smooth(0.7, 0.8, fbm(u, v, 12, 12, seed + 71, 3)) * stone * 0.35;
    o.r = lerp(o.r, o.r * 0.92, lich);
    o.b = lerp(o.b, o.b * 0.78, lich);
    o.h = 0.18 + stone * (0.42 + smooth(0, 0.09, d) * 0.3) + (grain - 0.5) * 0.12;
    o.ro = 0.96;
  });
}

// Horizontal logs, 0.25 m, dark moss/oakum chinking in the grooves. Used raw
// (izba: weathered grey-brown) and painted (nordic: Falu red worn to wood).
function paintLogs(size, P, seed) {
  const ROWS = 16;
  const a = rgb(P.logA);
  const b = rgb(P.logB);
  const bare = rgb(P.bare ?? P.logB);
  const gap = rgb(P.chink);
  return paintSurface(size, (u, v, o) => {
    const rv = v * ROWS;
    const r = Math.floor(rv) % ROWS;
    let fy = rv - Math.floor(rv);
    fy = clamp01(fy + (vnoise(u * 6, r * 3.1, 6, 1000, seed + 2) - 0.5) * 0.14);
    const prof = Math.sqrt(Math.max(0, 1 - (2 * fy - 1) * (2 * fy - 1)));
    const log = smooth(0.2, 0.46, prof);
    const grain = fbm(u, v, 16, 160, seed + 3, 3);
    const crackN = fbm(u, v, 8, 96, seed + 7, 2);
    const crack = smooth(0.035, 0.0, Math.abs(crackN - 0.5)) * smooth(0.5, 0.9, prof);
    const patch = fbm(u, v, 3, 6, seed + 13, 3);
    const tone = 0.84 + ih(r, 1, seed) * 0.26;
    let c0 = lerp(a[0], b[0], patch);
    let c1 = lerp(a[1], b[1], patch);
    let c2 = lerp(a[2], b[2], patch);
    if (P.bare) {                                   // paint worn off to bare wood
      const worn = smooth(0.62, 0.74, fbm(u, v, 8, 24, seed + 17, 3)) * 0.8;
      c0 = lerp(c0, bare[0], worn);
      c1 = lerp(c1, bare[1], worn);
      c2 = lerp(c2, bare[2], worn);
    }
    const sh = tone * (0.72 + 0.28 * prof) * (0.86 + grain * 0.26) * (1 - crack * 0.5);
    o.r = lerp(gap[0], c0 * sh, log);
    o.g = lerp(gap[1], c1 * sh, log);
    o.b = lerp(gap[2], c2 * sh, log);
    o.h = prof * 0.85 + (grain - 0.5) * 0.08 - crack * 0.12;
    o.ro = 0.93;
  });
}

// Lime-washed clay (khata) or lime-plastered rubble (desert): broad uneven
// coats, rain streaks, and patches where the coat has fallen off.
function paintRender(size, P, seed) {
  const base = rgb(P.render);
  const under = rgb(P.under);
  const stoneRows = P.stoneUnder ? 22 : 0;
  return paintSurface(size, (u, v, o) => {
    const big = fbm(u, v, 3, 3, seed, 4);
    const fine = fbm(u, v, 48, 48, seed + 5, 2);
    const peelN = fbm(u, v, 10, 10, seed + 9, 3);
    const streak = fbm(u, v, 22, 2, seed + 19, 2);
    const loss = smooth(0.66, 0.71, peelN);
    let sh = (0.93 + big * 0.1 + (fine - 0.5) * 0.06) * (1 - Math.max(0, streak - 0.58) * 0.45);
    let ur = under[0];
    let ug = under[1];
    let ub = under[2];
    let uh = 0.3;
    if (stoneRows) {
      const rv = v * stoneRows;
      const r = Math.floor(rv) % stoneRows;
      const fy = rv - Math.floor(rv);
      const uu = u * 18 + 0.5 * (r & 1);
      const fx = uu - Math.floor(uu);
      const k = ((Math.floor(uu) % 18) + 18) % 18;
      const st = smooth(0.04, 0.14, Math.min(Math.min(fx, 1 - fx), Math.min(fy, 1 - fy)));
      const t = 0.75 + ih(k, r, seed + 3) * 0.3;
      ur = lerp(ur * 0.6, ur * t, st);
      ug = lerp(ug * 0.6, ug * t, st);
      ub = lerp(ub * 0.6, ub * t, st);
      uh = 0.1 + st * 0.25;
    }
    o.r = lerp(base[0] * sh, ur, loss);
    o.g = lerp(base[1] * sh * (1 - (big - 0.5) * 0.03), ug, loss);
    o.b = lerp(base[2] * sh * (1 - (big - 0.5) * 0.06), ub, loss);
    o.h = lerp(0.62 + (fine - 0.5) * 0.12 + (big - 0.5) * 0.18, uh, loss);
    o.ro = 0.97;
  });
}

// ---------------------------------------------------------------------------
// roof painters (u along the eave, v UP the slope)
// ---------------------------------------------------------------------------

// Natural slate: 0.2 m exposed courses, 0.31 m slates broken-bonded, the drop
// at each course's lower edge carried in the height so it shadows the course
// below. Faintly glossy.
function paintSlate(size, P, seed) {
  const ROWS = 20;
  const COLS = 13;
  const base = rgb(P.roofCol);
  const alt = rgb(P.roofColAlt);
  return paintSurface(size, (u, v, o) => {
    const rv = v * ROWS;
    const r = Math.floor(rv) % ROWS;
    const fy = rv - Math.floor(rv);
    const uu = u * COLS + 0.5 * (r & 1) + (ih(r, 5, seed) - 0.5) * 0.12 * 0;
    const k = ((Math.floor(uu) % COLS) + COLS) % COLS;
    const fx = uu - Math.floor(uu);
    const joint = smooth(0.0, 0.05, Math.min(fx, 1 - fx));
    const tone = 0.8 + ih(k, r, seed) * 0.34;
    const mixA = ih(k, r, seed + 1);
    const grain = fbm(u, v, 48, 48, seed + 3, 2);
    const lichen = smooth(0.73, 0.8, fbm(u, v, 14, 14, seed + 9, 3));
    const overlapShadow = 1 - smooth(0.78, 1.0, fy) * 0.38;
    const sh = tone * (0.92 + grain * 0.16) * overlapShadow * (0.55 + 0.45 * joint);
    o.r = lerp(base[0], alt[0], mixA) * sh;
    o.g = lerp(base[1], alt[1], mixA) * sh;
    o.b = lerp(base[2], alt[2], mixA) * sh;
    o.r = lerp(o.r, 0.46, lichen * 0.35);
    o.g = lerp(o.g, 0.44, lichen * 0.35);
    o.b = lerp(o.b, 0.3, lichen * 0.35);
    o.h = (1 - fy) * 0.5 + 0.3 - (1 - joint) * 0.25 + (grain - 0.5) * 0.06;
    o.ro = 0.6 + grain * 0.12 + lichen * 0.25;
  });
}

// Board roof (tesovaya krovlya): boards run down the slope, board-on-board,
// silvered by weather with dark run-off streaks.
function paintPlanks(size, P, seed) {
  const COLS = 18;
  const base = rgb(P.roofCol);
  const alt = rgb(P.roofColAlt);
  return paintSurface(size, (u, v, o) => {
    const uu = u * COLS;
    const k = Math.floor(uu) % COLS;
    const fx = uu - Math.floor(uu);
    const top = k & 1;
    const edge = smooth(0.0, 0.08, Math.min(fx, 1 - fx));
    const grain = fbm(u, v, 144, 10, seed + 3, 3);
    const run = fbm(u, v, 36, 3, seed + 5, 3);
    const tone = 0.82 + ih(k, 0, seed) * 0.3;
    const mixA = fbm(u, v, 4, 4, seed + 7, 3);
    const sh = tone * (0.8 + grain * 0.35) * (1 - Math.max(0, run - 0.55) * 0.7)
      * (top ? 1 : 0.84) * (0.6 + 0.4 * edge);
    o.r = lerp(base[0], alt[0], mixA) * sh;
    o.g = lerp(base[1], alt[1], mixA) * sh;
    o.b = lerp(base[2], alt[2], mixA) * sh;
    o.h = (top ? 0.7 : 0.45) * (0.5 + 0.5 * edge) + (grain - 0.5) * 0.1;
    o.ro = 0.9;
  });
}

// Long-straw thatch: strands down the slope, butt-ends of each 0.5 m course,
// aged grey-brown with moss in the damp patches.
function paintThatch(size, P, seed) {
  const base = rgb(P.roofCol);
  const alt = rgb(P.roofColAlt);
  const moss = rgb(P.moss);
  return paintSurface(size, (u, v, o) => {
    const strands = fbm(u, v, 96, 6, seed, 3);
    const fine = fbm(u, v, 192, 12, seed + 1, 2);
    const cv = v * 8 + (vnoise(u * 12, 0, 12, 1, seed + 4) - 0.5) * 0.3;
    const fy = cv - Math.floor(cv);
    const butt = smooth(0.0, 0.18, fy);
    const age = fbm(u, v, 3, 3, seed + 6, 3);
    const mossM = smooth(0.62, 0.78, fbm(u, v, 6, 6, seed + 8, 3)) * 0.6;
    const sh = (0.66 + strands * 0.42 + (fine - 0.5) * 0.22) * (0.72 + 0.28 * butt);
    o.r = lerp(lerp(base[0], alt[0], age), moss[0], mossM) * sh;
    o.g = lerp(lerp(base[1], alt[1], age), moss[1], mossM) * sh;
    o.b = lerp(lerp(base[2], alt[2], age), moss[2], mossM) * sh;
    o.h = strands * 0.45 + fine * 0.2 + (1 - fy) * 0.3;
    o.ro = 1;
  });
}

// Shingle roof under lying snow (the nordic kit only ever sits on the winter
// map): snow ridged over the battens, dark wood where it has slid or melted.
function paintSnowRoof(size, P, seed) {
  const wood = rgb(P.roofColAlt);
  const snow = rgb(P.roofCol);
  return paintSurface(size, (u, v, o) => {
    const rv = v * 11;
    const fy = rv - Math.floor(rv);
    const batten = Math.sin(fy * Math.PI);
    const cover = fbm(u, v, 5, 5, seed, 4);
    const drift = fbm(u, v, 32, 12, seed + 2, 2);
    const m = smooth(0.26, 0.4, cover + batten * 0.06 + (drift - 0.5) * 0.12);
    const grain = fbm(u, v, 96, 12, seed + 4, 2);
    const ws = (0.75 + grain * 0.4) * (0.7 + 0.3 * fy);
    const ss = 0.9 + drift * 0.1 + batten * 0.04;
    o.r = lerp(wood[0] * ws, snow[0] * ss, m);
    o.g = lerp(wood[1] * ws, snow[1] * ss, m);
    o.b = lerp(wood[2] * ws, snow[2] * ss * 1.01, m);
    o.h = lerp(0.35 + fy * 0.3, 0.6 + batten * 0.15 + drift * 0.1, m);
    o.ro = lerp(0.9, 0.7, m);
  });
}

// Lime/earth flat roof, cracked and patched.
function paintFlatRoof(size, P, seed) {
  const base = rgb(P.roofCol);
  const alt = rgb(P.roofColAlt);
  return paintSurface(size, (u, v, o) => {
    const big = fbm(u, v, 4, 4, seed, 4);
    const fine = fbm(u, v, 64, 64, seed + 1, 2);
    const crackN = fbm(u, v, 10, 10, seed + 3, 3);
    const crack = smooth(0.02, 0.0, Math.abs(crackN - 0.5));
    const sh = (0.9 + fine * 0.16) * (1 - crack * 0.35);
    o.r = lerp(base[0], alt[0], big) * sh;
    o.g = lerp(base[1], alt[1], big) * sh;
    o.b = lerp(base[2], alt[2], big) * sh;
    o.h = 0.5 + (fine - 0.5) * 0.2 - crack * 0.25;
    o.ro = 0.97;
  });
}

// ---------------------------------------------------------------------------
// trim atlas: 4 x 4 cells
// ---------------------------------------------------------------------------

const C = {
  WINDOW: 0, DOOR: 1, SHUTTER: 2, STONE: 3,
  FIELD: 4, TIMBER: 5, BRICK: 6, LOUVRE: 7,
  METAL: 8, BOARD: 9, IRON: 10, ARCHWIN: 11,
  ENDGRAIN: 12, SHINGLE: 13, POT: 14, CHAR: 15,
};

// Physical size of a cell in metres, or null = stretch the cell over the face.
// Faces bigger than the cell's size stretch rather than tile (the atlas cannot
// wrap), which is why the tiling ones are sized for the largest face they get.
const CELL_M = [
  null, null, null, null,
  [2.4, 2.4], null, [1.2, 2.4], null,
  [3, 3], null, null, null,
  [0.28, 4], [2, 2], null, [2, 2],
];
const CELL_PAD = 0.03;   // of a cell: keeps mip levels from bleeding neighbours

function paintTrim(size, P, seed) {
  const T = P.trim;
  const frame = rgb(T.frame);
  const glass = rgb(T.glass);
  const door = rgb(T.door);
  const shutter = rgb(T.shutter);
  const stone = rgb(T.stone);
  const field = rgb(T.field);
  const timber = rgb(T.timber);
  const brick = rgb(T.brick);
  const metal = rgb(T.metal);
  const board = rgb(T.board);
  const endg = rgb(T.endgrain);
  const shing = rgb(T.shingle);
  const pot = rgb(0x9a5b3e);
  const [pc, pr] = T.panes || [2, 3];
  const set = (o, c, s) => { o.r = c[0] * s; o.g = c[1] * s; o.b = c[2] * s; };

  const cells = [
    // WINDOW: painted casement frame, glazing bars, glass catching the sky
    (cu, cv, o, u, v) => {
      const fw = 0.085;
      const inFrame = cu < fw || cu > 1 - fw || cv < fw || cv > 1 - fw;
      let bar = Math.abs(cu - 0.5) < 0.03;
      for (let k = 1; k < pr; k++) if (Math.abs(cv - (fw + (1 - 2 * fw) * k / pr)) < 0.017) bar = true;
      for (let k = 1; k < pc; k++) if (pc > 2 && Math.abs(cu - k / pc) < 0.017) bar = true;
      let grille = false;
      if (T.grille) grille = Math.abs(((cu * 7) % 1) - 0.5) < 0.09 || Math.abs(cv - 0.52) < 0.03;
      const g = fbm(u, v, 64, 64, seed + 1, 2);
      if (inFrame || bar) {
        set(o, frame, 0.86 + g * 0.2 - (inFrame ? 0 : 0.06));
        o.h = inFrame ? 0.95 : 0.75;
        o.ro = 0.7;
      } else if (grille) {
        set(o, [0.13, 0.13, 0.13], 1);
        o.h = 0.85;
        o.ro = 0.6;
      } else {
        const sky = 0.72 + cv * 0.55 + (fbm(u, v, 8, 8, seed + 2, 2) - 0.5) * 0.3;
        const curtain = T.curtain ? smooth(0.75, 0.95, Math.abs(cu - 0.5) * 2) * 0.5 : 0;
        o.r = lerp(glass[0] * sky, 0.62, curtain);
        o.g = lerp(glass[1] * sky, 0.6, curtain);
        o.b = lerp(glass[2] * sky, 0.55, curtain);
        o.h = 0.3;
        o.ro = 0.12;
      }
    },
    // DOOR: vertical boards on ledgers, worn at the foot, handle; studs (desert)
    (cu, cv, o, u, v) => {
      const fw = 0.06;
      const g = fbm(u, v, 12, 96, seed + 3, 3);
      const seam = Math.abs(((cu * 5) % 1) - 0.5) > 0.47;
      const ledger = Math.abs(cv - 0.2) < 0.035 || Math.abs(cv - 0.78) < 0.035;
      const border = cu < fw || cu > 1 - fw || cv > 1 - fw * 0.8;
      let s = 0.82 + g * 0.3;
      if (seam) s *= 0.45;
      if (ledger || border) s *= 1.08;
      s *= 1 - smooth(0.25, 0.0, cv) * 0.25 * fbm(u, v, 20, 20, seed + 4, 2);
      set(o, door, s);
      o.h = border ? 0.9 : ledger ? 0.75 : seam ? 0.2 : 0.55;
      if (T.studs && !border && Math.hypot(((cu * 8) % 1) - 0.5, ((cv * 10) % 1) - 0.5) < 0.16) {
        set(o, [0.12, 0.12, 0.13], 1);
        o.h = 1;
      }
      if (Math.hypot((cu - 0.83) * 1.6, cv - 0.47) < 0.035) { set(o, [0.1, 0.1, 0.1], 1); o.h = 1; }
      o.ro = 0.82;
    },
    // SHUTTER: boards with Z-brace, or louvred slats
    (cu, cv, o, u, v) => {
      const g = fbm(u, v, 12, 96, seed + 5, 3);
      let s = 0.84 + g * 0.26;
      let h = 0.5;
      if (T.louvred) {
        const f = (cv * 12) % 1;
        s *= 0.6 + 0.4 * f;
        h = f;
        if (cu < 0.08 || cu > 0.92 || cv < 0.05 || cv > 0.95) { s = 0.9 + g * 0.2; h = 0.9; }
      } else {
        if (Math.abs(((cu * 3) % 1) - 0.5) > 0.46) { s *= 0.5; h = 0.2; }
        const batten = Math.abs(cv - 0.16) < 0.045 || Math.abs(cv - 0.84) < 0.045;
        const dy = 0.16 + (cu - 0.08) * (0.68 / 0.84);
        const brace = cu > 0.08 && cu < 0.92 && Math.abs(cv - dy) < 0.05;
        if (batten || brace) { s = 0.92 + g * 0.2; h = 0.85; }
      }
      set(o, shutter, s * (1 - Math.max(0, fbm(u, v, 8, 8, seed + 6, 3) - 0.6) * 0.8));
      o.h = h;
      o.ro = 0.8;
    },
    // STONE: dressed limestone (sills, lintels, quoins)
    (cu, cv, o, u, v) => {
      const g = fbm(u, v, 48, 48, seed + 7, 3);
      const b = fbm(u, v, 6, 6, seed + 8, 3);
      set(o, stone, 0.86 + g * 0.18 + (b - 0.5) * 0.12);
      o.h = 0.5 + (g - 0.5) * 0.3;
      o.ro = 0.9;
    },
    // FIELD: rough fieldstone foundation courses
    (cu, cv, o, u, v) => {
      const x = cu * 6;
      const y = cv * 6;
      let d1 = 9;
      let d2 = 9;
      let id = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const cx = Math.floor(x) + i;
          const cy = Math.floor(y) + j;
          const px = cx + 0.2 + ih(cx, cy, seed + 9) * 0.6;
          const py = cy + 0.2 + ih(cx, cy, seed + 10) * 0.6;
          const dd = Math.hypot(x - px, y - py);
          if (dd < d1) { d2 = d1; d1 = dd; id = ih(cx, cy, seed + 11); }
          else if (dd < d2) d2 = dd;
        }
      }
      const edge = smooth(0.02, 0.14, d2 - d1);
      const g = fbm(u, v, 48, 48, seed + 12, 2);
      set(o, field, (0.35 + 0.65 * edge) * (0.8 + id * 0.35) * (0.9 + g * 0.2));
      o.h = edge * 0.8 + g * 0.1;
      o.ro = 0.97;
    },
    // TIMBER: dark weathered oak / pine
    (cu, cv, o, u, v) => {
      const g = fbm(u, v, 160, 10, seed + 13, 3);
      set(o, timber, 0.78 + g * 0.4);
      o.h = 0.5 + (g - 0.5) * 0.4;
      o.ro = 0.88;
    },
    // BRICK: stretcher bond, lime mortar, soot at the top of a stack
    (cu, cv, o, u, v) => {
      const rows = 36;                                     // 2.4 m / 0.067 m
      const rv = cv * rows;
      const r = Math.floor(rv);
      const fy = rv - r;
      const uu = cu * 5 + 0.5 * (r & 1);                   // 1.2 m / 0.24 m
      const fx = uu - Math.floor(uu);
      const k = Math.floor(uu);
      const mortar = Math.min(fx * 0.24, (1 - fx) * 0.24, fy * 0.067, (1 - fy) * 0.067) < 0.006;
      const g = fbm(u, v, 48, 48, seed + 14, 2);
      const t = 0.8 + ih(k, r, seed + 15) * 0.35;
      if (mortar) { set(o, [0.62, 0.59, 0.54], 0.85 + g * 0.2); o.h = 0.2; }
      else { set(o, brick, t * (0.9 + g * 0.2)); o.h = 0.7; }
      const soot = smooth(0.8, 1.0, cv) * 0.75;
      o.r *= 1 - soot; o.g *= 1 - soot; o.b *= 1 - soot;
      o.ro = 0.95;
    },
    // LOUVRE: belfry / vent slats, dark behind
    (cu, cv, o, u, v) => {
      const g = fbm(u, v, 96, 12, seed + 16, 2);
      if (cu < 0.07 || cu > 0.93 || cv < 0.05 || cv > 0.95) { set(o, timber, 0.9 + g * 0.2); o.h = 0.9; }
      else {
        const f = (cv * 9) % 1;
        const slat = f > 0.3;
        set(o, slat ? timber : [0.05, 0.05, 0.05], slat ? (0.7 + 0.5 * f) * (0.85 + g * 0.2) : 1);
        o.h = slat ? f : 0;
      }
      o.ro = 0.9;
    },
    // METAL: painted sheet (domes, minaret cap, tin), standing seams, streaks
    (cu, cv, o, u, v) => {
      const seam = Math.abs(((cu * 6) % 1) - 0.5) > 0.46;
      const run = fbm(u, v, 24, 3, seed + 17, 3);
      const rust = smooth(0.6, 0.75, fbm(u, v, 10, 10, seed + 18, 3));
      const s = (seam ? 1.15 : 0.92) * (1 - Math.max(0, run - 0.56) * 0.6);
      o.r = lerp(metal[0] * s, 0.42, rust * 0.4);
      o.g = lerp(metal[1] * s, 0.26, rust * 0.4);
      o.b = lerp(metal[2] * s, 0.16, rust * 0.4);
      o.h = seam ? 0.95 : 0.45;
      o.ro = 0.55 + rust * 0.3;
    },
    // BOARD: painted trim boards (window surrounds, corner boards)
    (cu, cv, o, u, v) => {
      const g = fbm(u, v, 12, 96, seed + 19, 2);
      const flake = smooth(0.7, 0.76, fbm(u, v, 16, 16, seed + 20, 3));
      o.r = lerp(board[0] * (0.9 + g * 0.14), timber[0], flake * 0.7);
      o.g = lerp(board[1] * (0.9 + g * 0.14), timber[1], flake * 0.7);
      o.b = lerp(board[2] * (0.9 + g * 0.14), timber[2], flake * 0.7);
      o.h = 0.6 - flake * 0.2 + (g - 0.5) * 0.1;
      o.ro = 0.78;
    },
    // IRON: black iron (crosses, chimney caps, grilles)
    (cu, cv, o, u, v) => {
      const g = fbm(u, v, 32, 32, seed + 21, 2);
      set(o, [0.16, 0.155, 0.15], 0.8 + g * 0.4);
      o.h = 0.5;
      o.ro = 0.6;
    },
    // ARCHWIN: leaded glass under a round arch of dressed stone
    (cu, cv, o, u, v) => {
      const dx = (cu - 0.5) * 2;
      const dy = (cv - 0.72) / 0.28;
      const r = cv > 0.72 ? Math.hypot(dx, dy) : Math.abs(dx);
      const g = fbm(u, v, 48, 48, seed + 22, 2);
      if (r > 1 || cv < 0.03) { set(o, stone, 0.88 + g * 0.18); o.h = 0.9; o.ro = 0.9; }
      else if (r > 0.86) { set(o, stone, 0.78 + g * 0.18); o.h = 0.7; o.ro = 0.9; }
      else {
        const lead = Math.abs((((cu + cv * 0.5) * 7) % 1) - 0.5) > 0.46
          || Math.abs((((cu - cv * 0.5) * 7 + 10) % 1) - 0.5) > 0.46;
        if (lead) { set(o, [0.1, 0.1, 0.1], 1); o.h = 0.55; o.ro = 0.5; }
        else {
          const tint = 0.7 + cv * 0.45 + (ih(Math.floor((cu + cv * 0.5) * 7), Math.floor((cu - cv * 0.5) * 7 + 10), seed) - 0.5) * 0.3;
          set(o, glass, tint);
          o.h = 0.35;
          o.ro = 0.15;
        }
      }
    },
    // ENDGRAIN: a stack of 16 log ends, 0.25 m each, with growth rings
    (cu, cv, o, u, v) => {
      const rv = cv * 16;
      const r = Math.floor(rv);
      const x = (cu - 0.5) * 0.28;
      const y = (rv - r - 0.5) * 0.25;
      const d = Math.hypot(x + (ih(r, 1, seed) - 0.5) * 0.02, y);
      const R = 0.118;
      if (d < R) {
        const ring = 0.86 + Math.sin(d * 260 + ih(r, 2, seed) * 6) * 0.08;
        const age = 1 - smooth(0.6, 1, d / R) * 0.35;
        set(o, endg, ring * age * (0.85 + ih(r, 3, seed) * 0.3));
        o.h = 0.75 - (d / R) * 0.15;
      } else {
        set(o, [0.16, 0.15, 0.12], 1);
        o.h = 0.1;
      }
      o.ro = 0.95;
    },
    // SHINGLE: split-wood shingles for steep spires
    (cu, cv, o, u, v) => {
      const rows = 16;
      const rv = cv * rows;
      const r = Math.floor(rv);
      const fy = rv - r;
      const uu = cu * 14 + 0.5 * (r & 1);
      const fx = uu - Math.floor(uu);
      const joint = smooth(0, 0.07, Math.min(fx, 1 - fx));
      const g = fbm(u, v, 96, 12, seed + 23, 2);
      set(o, shing, (0.78 + ih(Math.floor(uu), r, seed) * 0.3) * (0.62 + 0.38 * joint)
        * (1 - smooth(0.75, 1, fy) * 0.35) * (0.9 + g * 0.2));
      o.h = (1 - fy) * 0.5 + 0.3 - (1 - joint) * 0.2;
      o.ro = 0.9;
    },
    // POT: terracotta chimney pot / tile
    (cu, cv, o, u, v) => {
      const g = fbm(u, v, 32, 32, seed + 24, 3);
      set(o, pot, 0.85 + g * 0.25);
      const soot = smooth(0.75, 1, cv) * 0.7;
      o.r *= 1 - soot; o.g *= 1 - soot; o.b *= 1 - soot;
      o.h = 0.5;
      o.ro = 0.85;
    },
    // CHAR: burnt timber, alligatored with grey ash at the cracks
    (cu, cv, o, u, v) => {
      const x = cu * 10;
      const y = cv * 14;
      const fx = x - Math.floor(x);
      const fy = y - Math.floor(y + ih(Math.floor(x), 0, seed) * 0.8);
      const crack = Math.min(fx, 1 - fx, Math.abs(fy % 1), 1 - Math.abs(fy % 1)) < 0.06;
      const g = fbm(u, v, 48, 48, seed + 25, 2);
      if (crack) { set(o, [0.3, 0.29, 0.27], 0.8 + g * 0.3); o.h = 0.1; }
      else { set(o, [0.085, 0.072, 0.062], 0.8 + g * 0.5); o.h = 0.6 + g * 0.2; }
      o.ro = 0.95;
    },
  ];

  return paintSurface(size, (u, v, o) => {
    const cx = Math.min(3, Math.floor(u * 4));
    const vy = (1 - v) * 4;                      // image rows from the top
    const cyTop = Math.min(3, Math.floor(vy));
    const cu = u * 4 - cx;
    const cv = 1 - (vy - cyTop);
    cells[cyTop * 4 + cx](cu, cv, o, u, v);
  });
}

// UV of local (lu, lv in 0..1) inside atlas cell `cell`.
function cellUV(cell, lu, lv) {
  const cx = cell % 4;
  const cyTop = (cell / 4) | 0;
  const a = CELL_PAD + clamp01(lu) * (1 - 2 * CELL_PAD);
  const b = CELL_PAD + clamp01(lv) * (1 - 2 * CELL_PAD);
  return [(cx + a) / 4, (3 - cyTop + b) / 4];
}

// ---------------------------------------------------------------------------
// geometry builder
// ---------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

class Geo {
  constructor() {
    this.P = [];
    this.N = [];
    this.U = [];
    this.K = [];
    this.I = [];
  }

  get tris() {
    return this.I.length / 3;
  }

  vert(p, n, uv, c) {
    const i = this.P.length / 3;
    this.P.push(p[0], p[1], p[2]);
    this.N.push(n[0], n[1], n[2]);
    this.U.push(uv[0], uv[1]);
    if (typeof c === 'number') this.K.push(c, c, c);
    else this.K.push(c[0], c[1], c[2]);
    return i;
  }

  // Planar convex polygon. `want` (optional) is the side it must face; the
  // winding is flipped to match, so callers never have to get it right.
  // uvf(p, n) -> [u, v]; col: number | [r,g,b] | (p) => number | [r,g,b].
  poly(pts, want, uvf, col = 1) {
    const q = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const prev = q[q.length - 1];
      if (prev && Math.abs(prev[0] - p[0]) + Math.abs(prev[1] - p[1]) + Math.abs(prev[2] - p[2]) < 1e-7) continue;
      q.push(p);
    }
    if (q.length > 2) {
      const f = q[0];
      const l = q[q.length - 1];
      if (Math.abs(f[0] - l[0]) + Math.abs(f[1] - l[1]) + Math.abs(f[2] - l[2]) < 1e-7) q.pop();
    }
    if (q.length < 3) return;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < q.length; i++) {
      const a = q[i];
      const b = q[(i + 1) % q.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    let n = [nx / len, ny / len, nz / len];
    if (want && dot(n, want) < 0) {
      q.reverse();
      n = [-n[0], -n[1], -n[2]];
    }
    const base = this.P.length / 3;
    for (const p of q) this.vert(p, n, uvf ? uvf(p, n) : uvBox(p, n), typeof col === 'function' ? col(p) : col);
    for (let k = 1; k < q.length - 1; k++) this.I.push(base, base + k, base + k + 1);
  }

  toGeometry() {
    if (this.I.length === 0) {
      // BatchedMesh wants every slot to be a real geometry; a hidden sliver
      const a = this.vert([0, -3, 0], [0, 1, 0], [0, 0], 0);
      const b = this.vert([0.001, -3, 0], [0, 1, 0], [0, 0], 0);
      const c = this.vert([0, -3, 0.001], [0, 1, 0], [0, 0], 0);
      this.I.push(a, c, b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.K, 3));
    g.setIndex(this.I);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return markSharedGeometry(g);
  }
}

// World-metre box mapping: horizontal faces take (x, z), walls take
// (along-the-wall, y) so log courses and slate rows stay level.
function uvBox(p, n) {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) return [p[0], p[2]];
  if (ax >= az) return [n[0] > 0 ? -p[2] : p[2], p[1]];
  return [n[2] > 0 ? p[0] : -p[0], p[1]];
}

// Planar frame UV: u along t from o, v along b from o (both unit).
const uvFrame = (o, t, b) => (p) => {
  const d = sub(p, o);
  return [dot(d, t), dot(d, b)];
};

// A quad p0..p3 (lower-left, lower-right, upper-right, upper-left seen from
// the front) with its uv laid either in metres along its own edges, or across
// an atlas cell.
function quad(g, p0, p1, p2, p3, cell, col) {
  const e1 = sub(p1, p0);
  const e3 = sub(p3, p0);
  const want = cross(e1, e3);
  if (cell === null || cell === undefined) {
    g.poly([p0, p1, p2, p3], want, null, col);
    return;
  }
  const fw = Math.hypot(e1[0], e1[1], e1[2]) || 1;
  const fh = Math.hypot(e3[0], e3[1], e3[2]) || 1;
  const t = [e1[0] / fw, e1[1] / fw, e1[2] / fw];
  const b = [e3[0] / fh, e3[1] / fh, e3[2] / fh];
  const cm = CELL_M[cell];
  const su = cm ? Math.max(fw, cm[0]) : fw;
  const sv = cm ? Math.max(fh, cm[1]) : fh;
  g.poly([p0, p1, p2, p3], want, (p) => {
    const d = sub(p, p0);
    return cellUV(cell, dot(d, t) / su, dot(d, b) / sv);
  }, col);
}

// Axis-aligned box; faces is a string of 'px nx py ny pz nz'. Optional m is a
// THREE.Matrix4 applied to the corners (for fallen beams).
const _v3 = new THREE.Vector3();
function box(g, x0, x1, y0, y1, z0, z1, faces, cell, col, m = null) {
  const P = (x, y, z) => {
    if (!m) return [x, y, z];
    _v3.set(x, y, z).applyMatrix4(m);
    return [_v3.x, _v3.y, _v3.z];
  };
  if (faces.includes('px')) quad(g, P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), cell, col);
  if (faces.includes('nx')) quad(g, P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), cell, col);
  if (faces.includes('pz')) quad(g, P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), cell, col);
  if (faces.includes('nz')) quad(g, P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), cell, col);
  if (faces.includes('py')) quad(g, P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0), cell, col);
  if (faces.includes('ny')) quad(g, P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), cell, col);
}

// --- wall faces --------------------------------------------------------------
// A face frame: o = centre of the wall's outer surface at y = 0, t = to the
// right seen from outside, n = outward. W = width along t.
function faces4(cx, cz, w, d) {
  return {
    front: { o: [cx, 0, cz + d / 2], t: [1, 0, 0], n: [0, 0, 1], W: w },
    back: { o: [cx, 0, cz - d / 2], t: [-1, 0, 0], n: [0, 0, -1], W: w },
    right: { o: [cx + w / 2, 0, cz], t: [0, 0, -1], n: [1, 0, 0], W: d },
    left: { o: [cx - w / 2, 0, cz], t: [0, 0, 1], n: [-1, 0, 0], W: d },
  };
}

// point on a face: s along, y up, dep INTO the wall (negative = proud of it)
function FP(F, s, y, dep = 0) {
  return [F.o[0] + F.t[0] * s - F.n[0] * dep, y, F.o[2] + F.t[2] * s - F.n[2] * dep];
}

// Solid wall with rectangular holes. Rows are cut at every hole edge and at
// `breaks` (so the vertex colours can carry a damp plinth / eave shadow), and
// each row is emitted as the fewest quads that skip the holes.
function facade(g, F, y0, y1, holes, breaks, col) {
  const W = F.W;
  const ys = [y0, y1];
  for (const b of breaks) if (b > y0 + 1e-4 && b < y1 - 1e-4) ys.push(b);
  for (const h of holes) {
    if (h.y0 > y0 + 1e-4 && h.y0 < y1 - 1e-4) ys.push(h.y0);
    if (h.y1 > y0 + 1e-4 && h.y1 < y1 - 1e-4) ys.push(h.y1);
  }
  ys.sort((a, b) => a - b);
  const uvf = uvFrame([F.o[0], 0, F.o[2]], F.t, [0, 1, 0]);
  for (let r = 0; r < ys.length - 1; r++) {
    const ya = ys[r];
    const yb = ys[r + 1];
    if (yb - ya < 1e-4) continue;
    const cut = holes.filter((h) => h.y0 < yb - 1e-4 && h.y1 > ya + 1e-4).sort((a, b) => a.s0 - b.s0);
    let s = -W / 2;
    const emit = (sa, sb) => {
      if (sb - sa < 1e-4) return;
      g.poly([FP(F, sa, ya), FP(F, sb, ya), FP(F, sb, yb), FP(F, sa, yb)], F.n, uvf, col);
    };
    for (const h of cut) {
      emit(s, h.s0);
      s = Math.max(s, h.s1);
    }
    emit(s, W / 2);
  }
}

// Gable triangle above the eave line ye up to yr, with at most one centred hole.
function gable(g, F, ye, yr, hole, col) {
  const W = F.W;
  const uvf = uvFrame([F.o[0], 0, F.o[2]], F.t, [0, 1, 0]);
  const hw = (y) => (W / 2) * (1 - (y - ye) / (yr - ye));
  if (!hole) {
    g.poly([FP(F, -W / 2, ye), FP(F, W / 2, ye), FP(F, 0, yr)], F.n, uvf, col);
    return;
  }
  const { s0, s1, y0, y1 } = hole;
  g.poly([FP(F, -W / 2, ye), FP(F, W / 2, ye), FP(F, hw(y0), y0), FP(F, -hw(y0), y0)], F.n, uvf, col);
  g.poly([FP(F, -hw(y0), y0), FP(F, s0, y0), FP(F, s0, y1), FP(F, -hw(y1), y1)], F.n, uvf, col);
  g.poly([FP(F, s1, y0), FP(F, hw(y0), y0), FP(F, hw(y1), y1), FP(F, s1, y1)], F.n, uvf, col);
  g.poly([FP(F, -hw(y1), y1), FP(F, hw(y1), y1), FP(F, 0, yr)], F.n, uvf, col);
}

// The four reveals of a hole `D` deep (walls) and the pane at the back (trim).
function reveal(gw, gt, F, h, D, cell, revealCol) {
  const { s0, s1, y0, y1 } = h;
  const tn = F.t;
  const neg = (v) => [-v[0], -v[1], -v[2]];
  gw.poly([FP(F, s0, y0), FP(F, s0, y1), FP(F, s0, y1, D), FP(F, s0, y0, D)], tn, null, revealCol);
  gw.poly([FP(F, s1, y0), FP(F, s1, y1), FP(F, s1, y1, D), FP(F, s1, y0, D)], neg(tn), null, revealCol);
  gw.poly([FP(F, s0, y1), FP(F, s1, y1), FP(F, s1, y1, D), FP(F, s0, y1, D)], [0, -1, 0], null, revealCol);
  gw.poly([FP(F, s0, y0), FP(F, s1, y0), FP(F, s1, y0, D), FP(F, s0, y0, D)], [0, 1, 0], null, revealCol);
  quad(gt, FP(F, s0, y0, D), FP(F, s1, y0, D), FP(F, s1, y1, D), FP(F, s0, y1, D), cell, 1);
}

// A board or stone proud of a face: [s0,s1] x [y0,y1], standing `out` metres
// off it. sides: 'f' front, 't' top, 'b' bottom, 'l' left, 'r' right.
function plate(g, F, s0, s1, y0, y1, out, sides, cell, col = 1) {
  const o = -out;
  if (sides.includes('f')) quad(g, FP(F, s0, y0, o), FP(F, s1, y0, o), FP(F, s1, y1, o), FP(F, s0, y1, o), cell, col);
  if (sides.includes('t')) quad(g, FP(F, s0, y1, o), FP(F, s1, y1, o), FP(F, s1, y1, 0), FP(F, s0, y1, 0), cell, col);
  if (sides.includes('b')) quad(g, FP(F, s0, y0, 0), FP(F, s1, y0, 0), FP(F, s1, y0, o), FP(F, s0, y0, o), cell, col);
  if (sides.includes('l')) quad(g, FP(F, s0, y0, 0), FP(F, s0, y0, o), FP(F, s0, y1, o), FP(F, s0, y1, 0), cell, col);
  if (sides.includes('r')) quad(g, FP(F, s1, y0, o), FP(F, s1, y0, 0), FP(F, s1, y1, 0), FP(F, s1, y1, o), cell, col);
}

// --- roofs ---------------------------------------------------------------------
// Local roof frame: a runs along the ridge, b across it. The bottom surface of
// the roof slab passes through the top outer edge of the wall at eave height e;
// the slab is tr thick (measured square to the slope).
function roofMap(cx, cz, alongX) {
  return alongX ? (a, y, b) => [cx + a, y, cz + b] : (a, y, b) => [cx + b, y, cz + a];
}
function roofVec(alongX, a, y, b) {
  return alongX ? [a, y, b] : [b, y, a];
}
function roofLocal(cx, cz, alongX, p) {
  return alongX ? [p[0] - cx, p[2] - cz] : [p[2] - cz, p[0] - cx];
}

function gableRoof(g, o) {
  const { cx = 0, cz = 0, L, S, e, pitch, oe, ov, tr, alongX, cap = false } = o;
  const tp = Math.tan(pitch * DEG);
  const cp = Math.cos(pitch * DEG);
  const sp = Math.sin(pitch * DEG);
  const hs = S / 2;
  const be = hs + oe;
  const a0 = -L / 2 - ov;
  const a1 = L / 2 + ov;
  const yb = (b) => e + (hs - Math.abs(b)) * tp;
  const yt = (b) => yb(b) + tr / cp;
  const M = roofMap(cx, cz, alongX);
  for (const sg of [1, -1]) {
    const B = be * sg;
    const slopeUV = (p) => {
      const [a, b] = roofLocal(cx, cz, alongX, p);
      return [a * sg, (be - Math.abs(b)) / cp];
    };
    g.poly([M(a0, yt(B), B), M(a1, yt(B), B), M(a1, yt(0), 0), M(a0, yt(0), 0)],
      roofVec(alongX, 0, cp, sg * sp), slopeUV, 1);
    g.poly([M(a0, yb(B), B), M(a1, yb(B), B), M(a1, yb(0), 0), M(a0, yb(0), 0)],
      roofVec(alongX, 0, -cp, -sg * sp), slopeUV, 0.62);
    g.poly([M(a0, yb(B), B), M(a1, yb(B), B), M(a1, yt(B), B), M(a0, yt(B), B)],
      roofVec(alongX, 0, 0, sg), null, 0.8);
    for (const ea of [a0, a1]) {
      g.poly([M(ea, yb(B), B), M(ea, yt(B), B), M(ea, yt(0), 0), M(ea, yb(0), 0)],
        roofVec(alongX, Math.sign(ea), 0, 0), null, 0.8);
    }
    if (cap) {
      const cw = 0.24;
      const lift = 0.1;
      g.poly([M(a0, yt(cw * sg), cw * sg), M(a1, yt(cw * sg), cw * sg), M(a1, yt(0) + lift, 0), M(a0, yt(0) + lift, 0)],
        roofVec(alongX, 0, 1, sg * 0.5), slopeUV, 0.92);
    }
  }
  return { ridge: yt(0) + (cap ? 0.1 : 0), eaveEdge: be, verge: ov };
}

function hipRoof(g, o) {
  const { cx = 0, cz = 0, L, S, e, pitch, oe, tr, alongX } = o;
  const tp = Math.tan(pitch * DEG);
  const cp = Math.cos(pitch * DEG);
  const sp = Math.sin(pitch * DEG);
  const hs = S / 2;
  const ra = Math.max(0, L / 2 - hs);
  const A = L / 2 + oe;
  const B = S / 2 + oe;
  const ye = e - oe * tp;
  const yr = e + hs * tp;
  const dt = tr / cp;
  const M = roofMap(cx, cz, alongX);
  for (const lay of [1, 0]) {
    const off = lay ? dt : 0;
    const k = lay ? 1 : -1;
    const shade = lay ? 1 : 0.62;
    for (const sg of [1, -1]) {
      const uvS = (p) => {
        const [a, b] = roofLocal(cx, cz, alongX, p);
        return [a * sg, (B - Math.abs(b)) / cp];
      };
      g.poly([M(-A, ye + off, sg * B), M(A, ye + off, sg * B), M(ra, yr + off, 0), M(-ra, yr + off, 0)],
        roofVec(alongX, 0, k * cp, k * sg * sp), uvS, shade);
      const uvE = (p) => {
        const [a, b] = roofLocal(cx, cz, alongX, p);
        return [b * sg, (A - Math.abs(a)) / cp];
      };
      g.poly([M(sg * A, ye + off, B), M(sg * A, ye + off, -B), M(sg * ra, yr + off, 0)],
        roofVec(alongX, k * sg * sp, k * cp, 0), uvE, shade);
    }
  }
  for (const sg of [1, -1]) {
    g.poly([M(-A, ye, sg * B), M(A, ye, sg * B), M(A, ye + dt, sg * B), M(-A, ye + dt, sg * B)], roofVec(alongX, 0, 0, sg), null, 0.8);
    g.poly([M(sg * A, ye, -B), M(sg * A, ye, B), M(sg * A, ye + dt, B), M(sg * A, ye + dt, -B)], roofVec(alongX, sg, 0, 0), null, 0.8);
  }
  return { ridge: yr + dt, eaveEdge: B, verge: oe };
}

// Flat roof behind a parapet: parapet inner faces into walls, slab + projecting
// coping into roof.
function flatRoof(gw, gr, o) {
  const { cx = 0, cz = 0, w, d, e, par, T, lip = 0.25, ct = 0.12 } = o;
  const hx = w / 2;
  const hz = d / 2;
  const ix = hx - T;
  const iz = hz - T;
  const yp = e + par;
  const inner = faces4(cx, cz, 2 * ix, 2 * iz);
  for (const k of ['front', 'back', 'left', 'right']) {
    const F = inner[k];
    const inward = [-F.n[0], 0, -F.n[2]];
    gw.poly([FP(F, -F.W / 2, e), FP(F, F.W / 2, e), FP(F, F.W / 2, yp), FP(F, -F.W / 2, yp)], inward, null, 0.8);
  }
  gr.poly([[cx - ix, e, cz + iz], [cx + ix, e, cz + iz], [cx + ix, e, cz - iz], [cx - ix, e, cz - iz]], [0, 1, 0], null, 0.9);
  const ox = hx + lip;
  const oz = hz + lip;
  const jx = ix - 0.05;
  const jz = iz - 0.05;
  const yc = yp + ct;
  // coping top ring
  gr.poly([[cx - ox, yc, cz + oz], [cx + ox, yc, cz + oz], [cx + jx, yc, cz + jz], [cx - jx, yc, cz + jz]], [0, 1, 0]);
  gr.poly([[cx + ox, yc, cz - oz], [cx - ox, yc, cz - oz], [cx - jx, yc, cz - jz], [cx + jx, yc, cz - jz]], [0, 1, 0]);
  gr.poly([[cx + ox, yc, cz + oz], [cx + ox, yc, cz - oz], [cx + jx, yc, cz - jz], [cx + jx, yc, cz + jz]], [0, 1, 0]);
  gr.poly([[cx - ox, yc, cz - oz], [cx - ox, yc, cz + oz], [cx - jx, yc, cz + jz], [cx - jx, yc, cz - jz]], [0, 1, 0]);
  const outer = faces4(cx, cz, 2 * ox, 2 * oz);
  const inn = faces4(cx, cz, 2 * jx, 2 * jz);
  for (const k of ['front', 'back', 'left', 'right']) {
    const F = outer[k];
    gr.poly([FP(F, -F.W / 2, yp), FP(F, F.W / 2, yp), FP(F, F.W / 2, yc), FP(F, -F.W / 2, yc)], F.n, null, 0.85);
    const G = inn[k];
    gr.poly([FP(G, -G.W / 2, yp), FP(G, G.W / 2, yp), FP(G, G.W / 2, yc), FP(G, -G.W / 2, yc)], [-G.n[0], 0, -G.n[2]], null, 0.8);
    // drip underside between the wall face and the lip
    const wall = faces4(cx, cz, w, d)[k];
    gr.poly([FP(F, -F.W / 2, yp), FP(F, F.W / 2, yp), FP(wall, wall.W / 2, yp), FP(wall, -wall.W / 2, yp)], [0, -1, 0], null, 0.6);
  }
  return { top: yc };
}

// Brick stack with a corbelled cap, dark flue and (not on low) a clay pot.
function chimney(gt, x, z, sx, sz, y0, y1, q, capCell = C.BRICK) {
  const hx = sx / 2;
  const hz = sz / 2;
  box(gt, x - hx, x + hx, y0, y1, z - hz, z + hz, 'px nx pz nz', C.BRICK, 1);
  const c = 0.07;
  box(gt, x - hx - c, x + hx + c, y1, y1 + 0.16, z - hz - c, z + hz + c, 'px nx pz nz ny', capCell, 0.9);
  box(gt, x - hx - c, x + hx + c, y1 + 0.16, y1 + 0.16, z - hz - c, z + hz + c, 'py', C.IRON, 1);
  if (q !== 'low') {
    const p = 0.12;
    box(gt, x - p, x + p, y1 + 0.16, y1 + 0.52, z - p, z + p, 'px nx pz nz', C.POT, 1);
  }
  return y1 + (q !== 'low' ? 0.52 : 0.16);
}

// Smooth surface of revolution. prof = [[r, y], ...] bottom to top.
function lathe(g, cx, cz, y0, prof, seg, cell, col = 1) {
  const rings = prof.length;
  const yTop = prof[rings - 1][1];
  const idx = [];
  for (let i = 0; i < rings; i++) {
    const [r, y] = prof[i];
    const pa = prof[Math.max(0, i - 1)];
    const pb = prof[Math.min(rings - 1, i + 1)];
    const dr = pb[0] - pa[0];
    const dy = pb[1] - pa[1];
    const nl = Math.hypot(dr, dy) || 1;
    const row = [];
    for (let k = 0; k <= seg; k++) {
      const ang = (k / seg) * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const n = [(dy / nl) * ca, -dr / nl, (dy / nl) * sa];
      const uv = cell === null ? [ang * 1.5, y] : cellUV(cell, k / seg, y / yTop);
      row.push(g.vert([cx + r * ca, y0 + y, cz + r * sa], n, uv, col));
    }
    idx.push(row);
  }
  for (let i = 0; i < rings - 1; i++) {
    const rTop = prof[i + 1][0];
    const rBot = prof[i][0];
    for (let k = 0; k < seg; k++) {
      const a = idx[i][k];
      const b = idx[i][k + 1];
      const c = idx[i + 1][k + 1];
      const d = idx[i + 1][k];
      if (rBot > 1e-6) g.I.push(a, d, b);
      if (rTop > 1e-6) g.I.push(b, d, c);
    }
  }
}

// Broach spire on a square tower top (half = half the tower side): square
// bell-cast eave, triangular broaches at the corners, octagonal needle.
function broachSpire(g, cx, cz, half, y0, h, ov, uvCell) {
  const Q = half + ov;
  const hb = h * 0.2;
  const ya = y0 + hb;
  const apex = [cx, y0 + h, cz];
  const R = half * 0.78;
  const V = [];
  for (let k = 0; k < 8; k++) {
    const ang = (22.5 + 45 * k) * DEG;
    V.push([cx + R * Math.cos(ang), ya, cz + R * Math.sin(ang)]);
  }
  const Qc = (sx, sz) => [cx + sx * Q, y0 - ov * 0.4, cz + sz * Q];
  const uvf = uvCell === null ? null : (p) => cellUV(uvCell,
    (Math.atan2(p[2] - cz, p[0] - cx) / (Math.PI * 2) + 1) % 1, (p[1] - y0) / h);
  const up = (x, z) => norm([x, 0.6, z]);
  // cardinal faces: +X uses V7, V0; +Z V1, V2; -X V3, V4; -Z V5, V6
  g.poly([Qc(1, -1), Qc(1, 1), V[0], V[7]], up(1, 0), uvf);
  g.poly([Qc(1, 1), Qc(-1, 1), V[2], V[1]], up(0, 1), uvf);
  g.poly([Qc(-1, 1), Qc(-1, -1), V[4], V[3]], up(-1, 0), uvf);
  g.poly([Qc(-1, -1), Qc(1, -1), V[6], V[5]], up(0, -1), uvf);
  g.poly([Qc(1, 1), V[1], V[0]], up(1, 1), uvf);
  g.poly([Qc(-1, 1), V[3], V[2]], up(-1, 1), uvf);
  g.poly([Qc(-1, -1), V[5], V[4]], up(-1, -1), uvf);
  g.poly([Qc(1, -1), V[7], V[6]], up(1, -1), uvf);
  for (let k = 0; k < 8; k++) {
    const a = V[k];
    const b = V[(k + 1) % 8];
    const mid = [(a[0] + b[0]) / 2 - cx, 0, (a[2] + b[2]) / 2 - cz];
    g.poly([a, b, apex], norm([mid[0], R / (h - hb), mid[2]]), uvf);
  }
  g.poly([Qc(-1, -1), Qc(1, -1), Qc(1, 1), Qc(-1, 1)], [0, -1, 0], uvf, 0.6);
  return y0 + h;
}

// Iron cross (trim).
function crossOn(gt, x, y, z, s = 1) {
  const t = 0.06 * s;
  box(gt, x - t, x + t, y, y + 1.7 * s, z - t, z + t, 'px nx pz nz', C.IRON, 1);
  box(gt, x - 0.45 * s, x + 0.45 * s, y + 1.05 * s, y + 1.17 * s, z - t, z + t, 'px nx pz nz py ny', C.IRON, 1);
  return y + 1.7 * s;
}

// ---------------------------------------------------------------------------
// house assembly
// ---------------------------------------------------------------------------

const OP_CELL = { win: C.WINDOW, door: C.DOOR, cart: C.DOOR, hatch: C.DOOR, louvre: C.LOUVRE, arch: C.ARCHWIN };
const FACE_KEYS = ['front', 'right', 'back', 'left'];

const hole = (op) => ({ s0: op.s - op.w / 2, s1: op.s + op.w / 2, y0: op.y, y1: op.y + op.h });

// Baked light on a wall: ground splash and damp at the foot, the band a plinth
// is painted, shadow under the eaves.
function wallShade(S, e) {
  const pt = S.plinthTint;
  const ph = S.plinthH ?? 0;
  return (p) => {
    const y = p[1];
    let k = 0.52 + 0.48 * smooth(-0.9, 0.8, y);
    if (y <= e + 1e-3) k *= 1 - 0.16 * smooth(e - 1.1, e, y);
    else k *= 0.9;
    if (pt && y <= ph + 1e-4) return [k * pt[0], k * pt[1], k * pt[2]];
    return k;
  };
}

// Everything a style hangs round an opening.
// lean: front faces only on frames, no pediment, at most 2 steps (churches).
function dressOpening(S, gt, F, op, q, plain = false, lean = false) {
  const h = hole(op);
  const { s0, s1, y0, y1 } = h;
  const lowQ = q === 'low';
  const fw = 0.12;
  const framed = S.frame && !plain && (op.k === 'win' || op.k === 'door' || op.k === 'hatch');
  if (op.k === 'win') {
    if (S.sill) plate(gt, F, s0 - 0.06, s1 + 0.06, y0 - 0.08, y0, 0.07, lowQ ? 'ft' : 'ftlr', S.sill, 0.95);
    if (S.lintel) plate(gt, F, s0 - 0.12, s1 + 0.12, y1, y1 + 0.2, 0.04, 'fb', S.lintel, 0.95);
  }
  if ((op.k === 'door' || op.k === 'hatch') && S.lintel) plate(gt, F, s0 - 0.12, s1 + 0.12, y1, y1 + 0.22, 0.04, 'fb', S.lintel, 0.95);
  if (op.k === 'cart') plate(gt, F, s0 - 0.3, s1 + 0.3, y1, y1 + 0.3, 0.07, 'fblr', C.TIMBER, 0.9);
  if (framed) {
    const out = 0.045;
    plate(gt, F, s0 - fw, s0, y0 - (op.k === 'win' ? fw : 0), y1 + fw, out, lean ? 'f' : 'fl', S.frame);
    plate(gt, F, s1, s1 + fw, y0 - (op.k === 'win' ? fw : 0), y1 + fw, out, lean ? 'f' : 'fr', S.frame);
    plate(gt, F, s0, s1, y1, y1 + fw, out, lean ? 'f' : 'ft', S.frame);
    if (op.k === 'win') plate(gt, F, s0, s1, y0 - fw, y0, out, lean ? 'f' : 'fb', S.frame);
    if (S.pediment && !lowQ && !lean) {
      const yb = y1 + fw;
      quad(gt, FP(F, s0 - fw - 0.1, yb, -out), FP(F, s1 + fw + 0.1, yb, -out),
        FP(F, (s0 + s1) / 2 + 0.001, yb + 0.36, -out), FP(F, (s0 + s1) / 2, yb + 0.36, -out), S.frame, 1);
    }
  }
  if (S.shutters && !plain && op.k === 'win' && op.sh !== false && !lowQ) {
    const hw = (s1 - s0) / 2;
    const gap = framed ? fw + 0.01 : 0.03;
    plate(gt, F, s0 - gap - hw, s0 - gap, y0, y1, 0.05, 'f', S.shutters);
    plate(gt, F, s1 + gap, s1 + gap + hw, y0, y1, 0.05, 'f', S.shutters);
  }
  if (op.k === 'door' && S.step && op.y < 1.2) {
    const nSteps = Math.max(1, Math.min(lean ? 2 : 3, Math.round(op.y / 0.2)));
    for (let i = 0; i < nSteps; i++) {
      const top = op.y - (op.y / nSteps) * i;
      plate(gt, F, s0 - 0.2 - i * 0.05, s1 + 0.2 + i * 0.05, -0.4, top, 0.32 * (i + 1), 'ftlr', S.step, 0.9);
    }
  }
}

// The whole of an ordinary building. A = archetype spec (see STYLES below).
function house(S, A, q) {
  const gw = new Geo();
  const gr = new Geo();
  const gt = new Geo();
  const { w, d } = A;
  const e = A.eave;
  const pitch = A.pitch ?? S.pitch;
  const alongX = w >= d;
  const L = Math.max(w, d);
  const Sp = Math.min(w, d);
  const tp = Math.tan(pitch * DEG);
  const F = faces4(0, 0, w, d);
  const trimFound = S.foundation === 'trim';
  const fH = trimFound ? (A.foundH ?? S.foundH) : 0;
  const wallY0 = trimFound ? fH : -1.2;
  const shade = wallShade(S, e);
  const breaks = [e - 1.1];
  if (S.plinthTint) breaks.push(S.plinthH, S.plinthH + 0.04);
  else breaks.push(0.6);
  const flat = S.roof === 'flat';
  const wallTop = flat ? e + S.par : e;

  if (trimFound) {
    for (const k of FACE_KEYS) {
      const Fk = F[k];
      const ext = k === 'front' || k === 'back' ? 0.08 : 0;
      plate(gt, Fk, -Fk.W / 2 - ext, Fk.W / 2 + ext, -1.2, fH, 0.08, ext ? 'ftlr' : 'ft', C.FIELD,
        (p) => 0.6 + 0.4 * smooth(-0.8, fH, p[1]));
    }
  }

  const revealCol = 0.66;
  for (const k of FACE_KEYS) {
    const ops = (A.ops && A.ops[k]) || [];
    const holes = ops.map(hole);
    facade(gw, F[k], wallY0, wallTop, holes, breaks, shade);
    for (const op of ops) {
      reveal(gw, gt, F[k], hole(op), op.k === 'cart' ? 0.2 : S.wallT, OP_CELL[op.k], revealCol);
      dressOpening(S, gt, F[k], op, q, A.plain);
    }
  }

  let roofInfo;
  if (S.roof === 'gable') {
    const gk = alongX ? ['left', 'right'] : ['front', 'back'];
    const yr = e + (Sp / 2) * tp;
    for (const k of gk) {
      const op = A.gableOps && A.gableOps[k];
      gable(gw, F[k], e, yr, op ? hole(op) : null, shade);
      if (op) {
        reveal(gw, gt, F[k], hole(op), S.wallT, OP_CELL[op.k], revealCol);
        dressOpening(S, gt, F[k], op, q, A.plain);
      }
    }
    roofInfo = gableRoof(gr, { L, S: Sp, e, pitch, oe: A.oe ?? S.oe, ov: A.ov ?? S.ov, tr: S.tr, alongX, cap: S.cap && q !== 'low' });
  } else if (S.roof === 'hip') {
    roofInfo = hipRoof(gr, { L, S: Sp, e, pitch, oe: A.oe ?? S.oe, tr: S.tr, alongX });
  } else {
    roofInfo = flatRoof(gw, gr, { w, d, e, par: S.par, T: S.wallT });
    roofInfo.ridge = roofInfo.top;
  }

  const dt = S.tr / Math.cos(pitch * DEG);
  const roofTopAt = (x, z) => {
    if (flat) return e;
    const a = Math.abs(alongX ? x : z);
    const b = Math.abs(alongX ? z : x);
    let run = Sp / 2 - b;
    if (S.roof === 'hip') run = Math.min(run, L / 2 - a);
    return e + run * tp + dt;
  };
  let top = roofInfo.ridge;
  for (const ch of A.chimneys || []) {
    let low = Infinity;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) low = Math.min(low, roofTopAt(ch.x + sx * ch.sx / 2, ch.z + sz * ch.sz / 2));
    const y1 = ch.top ?? roofInfo.ridge + 0.9;
    top = Math.max(top, chimney(gt, ch.x, ch.z, ch.sx, ch.sz, Math.max(e - 0.4, low - 0.3), y1, q));
  }

  if (S.logCorners || A.logCorners) logCorners(gw, gt, w, d, fH, e);
  if (S.cornerBoards && !A.logCorners) {
    for (const k of FACE_KEYS) {
      const Fk = F[k];
      plate(gt, Fk, -Fk.W / 2 - 0.04, -Fk.W / 2 + 0.16, fH, e, 0.04, 'fl', C.BOARD);
      plate(gt, Fk, Fk.W / 2 - 0.16, Fk.W / 2 + 0.04, fH, e, 0.04, 'fr', C.BOARD);
    }
  }
  if (A.extras) top = Math.max(top, A.extras({ gw, gr, gt, S, q, e, w, d, F, shade }) || 0);

  return { gw, gr, gt, top, pitch, alongX };
}

// Crossed log ends at the four corners (walls sides, trim end grain).
function logCorners(gw, gt, w, d, y0, y1) {
  const P = 0.3;
  const T = 0.26;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // log of the X-running wall pushing past the corner
      const xa0 = Math.min(sx * w / 2, sx * (w / 2 + P));
      const xa1 = Math.max(sx * w / 2, sx * (w / 2 + P));
      const za0 = Math.min(sz * d / 2, sz * (d / 2 - T));
      const za1 = Math.max(sz * d / 2, sz * (d / 2 - T));
      box(gw, xa0, xa1, y0, y1, za0, za1, 'pz nz py', null, 0.9);
      box(gt, xa0, xa1, y0, y1, za0, za1, sx > 0 ? 'px' : 'nx', C.ENDGRAIN, 1);
      // and of the Z-running wall
      const xb0 = Math.min(sx * w / 2, sx * (w / 2 - T));
      const xb1 = Math.max(sx * w / 2, sx * (w / 2 - T));
      const zb0 = Math.min(sz * d / 2, sz * (d / 2 + P));
      const zb1 = Math.max(sz * d / 2, sz * (d / 2 + P));
      box(gw, xb0, xb1, y0, y1, zb0, zb1, 'px nx py', null, 0.9);
      box(gt, xb0, xb1, y0, y1, zb0, zb1, sz > 0 ? 'pz' : 'nz', C.ENDGRAIN, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// ruins
// ---------------------------------------------------------------------------
// Masonry styles keep jagged wall stumps with the corners standing tallest and
// fragments of gable; timber styles burn down to charred log stubs round a
// standing stove chimney, which is what an eastern-front village looked like.
// rects: [{ cx, cz, w, d, e, pitch, gable: bool, alongX, step? }]

function ruinWalls(S, rects, seed, stove) {
  const g = new Geo();
  const burnt = S.ruin === 'burnt';
  const T = burnt ? 0.26 : Math.max(0.3, S.wallT);
  rects.forEach((R, ri) => {
    const F = faces4(R.cx, R.cz, R.w, R.d);
    const cornerH = [0, 1, 2, 3].map((c) => {
      const r = ih(c, ri, seed + 3);
      return burnt ? 0.9 + r * 1.2 : R.e * (0.78 + 0.22 * r);
    });
    FACE_KEYS.forEach((k, fi) => {
      const Fk = F[k];
      const W = Fk.W;
      const gableFace = R.gable && (R.alongX ? k === 'left' || k === 'right' : k === 'front' || k === 'back');
      const n = Math.max(2, Math.round(W / (R.step ?? 1.35)));
      const s = [];
      const hs = [];
      for (let i = 0; i <= n; i++) {
        const si = -W / 2 + (W * i) / n + (i > 0 && i < n ? (ih(i, fi + ri * 7, seed + 9) - 0.5) * (W / n) * 0.5 : 0);
        s.push(si);
        const r1 = ih(i, fi * 31 + ri * 97, seed);
        const r2 = ih(i, fi * 31 + ri * 97, seed + 1);
        let hgt;
        if (i === 0) hgt = cornerH[fi];
        else if (i === n) hgt = cornerH[(fi + 1) % 4];
        else if (burnt) hgt = 0.22 + r1 * r1 * 1.3;
        else {
          const cap = gableFace ? R.e + (W / 2 - Math.abs(si)) * Math.tan((R.pitch || 0) * DEG) : R.e;
          if (r2 < 0.16) hgt = 0.25 + r1 * 0.5;                          // breach
          else if (gableFace && r2 > 0.62) hgt = cap * (0.78 + 0.2 * r1);   // gable fragment
          else hgt = R.e * (0.32 + 0.6 * r1);
        }
        hs.push(hgt);
      }
      const col = (p) => {
        const nz = vnoise(p[0] * 0.8 + p[2] * 0.8, p[1] * 1.1, 1024, 1024, seed + 17);
        const base = burnt ? 0.22 + 0.16 * nz : 0.58 + 0.4 * nz;
        const ground = 0.6 + 0.4 * smooth(-0.8, 0.6, p[1]);
        return base * ground;
      };
      const inner = (si) => Math.max(-W / 2 + T, Math.min(W / 2 - T, si));
      for (let i = 0; i < n; i++) {
        const a = s[i];
        const b = s[i + 1];
        const ha = hs[i];
        const hb = hs[i + 1];
        g.poly([FP(Fk, a, -1), FP(Fk, b, -1), FP(Fk, b, hb), FP(Fk, a, ha)], Fk.n, null, col);
        g.poly([FP(Fk, inner(a), 0, T), FP(Fk, inner(b), 0, T), FP(Fk, inner(b), hb, T), FP(Fk, inner(a), ha, T)],
          [-Fk.n[0], 0, -Fk.n[2]], null, col);
        g.poly([FP(Fk, a, ha), FP(Fk, b, hb), FP(Fk, inner(b), hb, T), FP(Fk, inner(a), ha, T)], [0, 1, 0], null, col);
      }
    });
  });
  if (stove) {
    const { x, z, top } = stove;
    const sootCol = (p) => (0.55 + 0.35 * smooth(top, 0.5, p[1])) * (burnt ? 0.9 : 1);
    box(g, x - 0.8, x + 0.8, -0.5, 1.7, z - 0.8, z + 0.8, 'px nx pz nz py', null, sootCol);
    box(g, x - 0.34, x + 0.34, 1.7, top, z - 0.34, z + 0.34, 'px nx pz nz py', null, sootCol);
  }
  return g;
}

const _m4 = new THREE.Matrix4();
const _eu = new THREE.Euler();
function rubbleHeap(S, rects, seed, q) {
  const g = new Geo();
  const burnt = S.ruin === 'burnt';
  rects.forEach((R, ri) => {
    const ex = R.w / 2 + 1.2;
    const ez = R.d / 2 + 1.2;
    const nx = Math.max(3, Math.min(7, Math.round(R.w / 2.4)));
    const nz = Math.max(3, Math.min(7, Math.round(R.d / 2.4)));
    const H = R.heap ?? (burnt ? 0.6 : Math.min(2.2, 0.26 * R.e + 0.35));
    const grid = [];
    for (let j = 0; j <= nz; j++) {
      const row = [];
      for (let i = 0; i <= nx; i++) {
        const u = (i / nx) * 2 - 1;
        const v = (j / nz) * 2 - 1;
        const edge = i === 0 || j === 0 || i === nx || j === nz;
        const r = ih(i, j * 13 + ri * 101, seed + 21);
        const y = edge ? -0.35 : H * (1 - 0.55 * (u * u + v * v)) * (0.45 + 0.55 * r);
        row.push([R.cx + u * ex + (edge ? 0 : (r - 0.5) * 0.6), y, R.cz + v * ez]);
      }
      grid.push(row);
    }
    const col = (p) => {
      const nz2 = vnoise(p[0] * 1.3, p[2] * 1.3, 1024, 1024, seed + 23);
      return burnt ? 0.2 + 0.2 * nz2 : 0.55 + 0.4 * nz2;
    };
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = grid[j][i];
        const b = grid[j][i + 1];
        const c = grid[j + 1][i + 1];
        const d = grid[j + 1][i];
        g.poly([a, b, c], [0, 1, 0], null, col);
        g.poly([a, c, d], [0, 1, 0], null, col);
      }
    }
    const beams = q === 'low' ? 2 : 4;
    for (let k = 0; k < beams; k++) {
      const r1 = ih(k, ri, seed + 31);
      const r2 = ih(k, ri, seed + 32);
      const r3 = ih(k, ri, seed + 33);
      const len = 2.6 + r1 * Math.min(4, R.w * 0.45);
      _eu.set((r2 - 0.5) * 0.5, r3 * Math.PI, 0.12 + r1 * 0.35);
      _m4.makeRotationFromEuler(_eu);
      _m4.setPosition(R.cx + (r2 - 0.5) * R.w * 0.6, H * 0.45 + 0.1, R.cz + (r3 - 0.5) * R.d * 0.6);
      const t = 0.1 + r3 * 0.04;
      box(g, -len / 2, len / 2, -t, t, -t, t, 'px nx py ny pz nz', null, burnt ? 0.16 : 0.42, _m4);
    }
    if (!burnt) {
      for (let k = 0; k < (q === 'low' ? 2 : 4); k++) {
        const r1 = ih(k, ri, seed + 41);
        const r2 = ih(k, ri, seed + 42);
        const sz = 0.45 + r1 * 0.5;
        const ang = r2 * Math.PI * 2;
        const rad = 0.55 + 0.4 * r2;
        _eu.set(r1 * 0.3, r2 * 3, 0);
        _m4.makeRotationFromEuler(_eu);
        _m4.setPosition(R.cx + Math.cos(ang) * ex * rad, sz * 0.35, R.cz + Math.sin(ang) * ez * rad);
        box(g, -sz, sz, -sz * 0.6, sz * 0.6, -sz * 0.7, sz * 0.7, 'px nx py pz nz', null, 0.75, _m4);
      }
    }
  });
  return g;
}

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------
// Opening shorthand, in face coordinates: s = centre along the face (right is
// positive seen from outside), y = sill height, w x h = clear opening.

const win = (s, y, w, h, o = {}) => ({ k: 'win', s, y, w, h, ...o });
const door = (s, y, w, h) => ({ k: 'door', s, y, w, h });
const cart = (s, y, w, h) => ({ k: 'cart', s, y, w, h });
const hatch = (s, y, w, h) => ({ k: 'hatch', s, y, w, h });
const louvre = (s, y, w, h) => ({ k: 'louvre', s, y, w, h });
const arch = (s, y, w, h) => ({ k: 'arch', s, y, w, h });
const NS = { sh: false };

const STYLES = {
  // Norman stone farmhouse: coursed limestone, 50 deg slate, dressed sills and
  // lintels, painted plank shutters, a chimney stack on each gable.
  normandy: {
    wallTex: 'stone', roofTex: 'slate', wallRelief: 0.035, roofRelief: 0.02,
    wallRough: 1, roofRough: 1,
    roof: 'gable', pitch: 50, oe: 0.42, ov: 0.32, tr: 0.16, cap: true, wallT: 0.34,
    foundation: 'wall',
    sill: C.STONE, lintel: C.STONE, frame: null, pediment: false, shutters: C.SHUTTER, step: C.STONE,
    ruin: 'masonry', spire: 'broach-roof', churchEave: 6,
    stones: [0xbcb096, 0xab9f88, 0xc5b89e, 0x978872], mortar: 0xc4baa6,
    roofCol: 0x50555d, roofColAlt: 0x4c4a57,
    trim: {
      frame: 0xdad7cc, glass: 0x2a353c, door: 0x40503f, shutter: 0x6a7d66, stone: 0xd0c5ab,
      field: 0x8e8a80, timber: 0x4e4032, brick: 0x8c4c37, metal: 0x5a5f62, board: 0xdad7cc,
      endgrain: 0xa08a68, shingle: 0x5e554a, panes: [2, 3], curtain: true,
    },
    archetypes: [
      {
        key: 'normandy_house', role: 'house', w: 11, d: 7.5, eave: 5.8,
        ops: {
          front: [door(0, 0.12, 1.05, 2.2), win(-3.2, 0.95, 1.0, 1.45), win(3.2, 0.95, 1.0, 1.45),
            win(-3.2, 3.55, 1.0, 1.35), win(0, 3.55, 1.0, 1.35), win(3.2, 3.55, 1.0, 1.35)],
          back: [win(-2.2, 0.95, 0.9, 1.3), win(2.2, 0.95, 0.9, 1.3), win(0, 3.55, 0.8, 1.1, NS)],
          left: [win(1.2, 1.0, 0.8, 1.1, NS)],
        },
        gableOps: { left: win(0, 6.6, 0.6, 0.8, NS), right: win(0, 6.6, 0.6, 0.8, NS) },
        chimneys: [{ x: -5.11, z: 0, sx: 0.9, sz: 1.2 }, { x: 5.11, z: 0, sx: 0.9, sz: 1.2 }],
      },
      {
        key: 'normandy_longere', role: 'house', w: 16, d: 6.5, eave: 3.3,
        ops: {
          front: [win(-6.4, 0.9, 0.95, 1.3), door(-4.2, 0.12, 1.0, 2.1), win(-1.8, 0.9, 0.95, 1.3),
            win(1.0, 0.9, 0.95, 1.3), door(4.3, 0.12, 1.2, 2.2), win(6.6, 1.3, 0.6, 0.6, NS)],
          back: [win(-4, 1.0, 0.8, 1.0), win(2, 1.0, 0.8, 1.0, NS)],
          right: [door(0.6, 0.12, 1.0, 2.0)],
        },
        gableOps: { left: win(0, 4.0, 0.7, 0.9, NS), right: hatch(0, 3.9, 1.0, 1.2) },
        chimneys: [{ x: -7.61, z: 0, sx: 0.9, sz: 1.1 }, { x: 1.8, z: 0, sx: 0.8, sz: 1.0 }],
      },
      {
        key: 'normandy_barn', role: 'barn', w: 18, d: 10, eave: 4.2, plain: true,
        ops: {
          front: [cart(-3.5, 0, 3.6, 3.5), door(3.5, 0.12, 1.1, 2.2), win(7.2, 2.2, 0.6, 0.7), win(-7.6, 2.2, 0.6, 0.7)],
          back: [door(0, 0.12, 1.1, 2.2)],
        },
        gableOps: { left: hatch(0, 4.8, 1.4, 1.6), right: win(0, 5.0, 0.6, 0.8) },
      },
      {
        // farm bakehouse (four a pain): cart bay, oven chimney on the gable
        key: 'normandy_bakehouse', role: 'shed', w: 6, d: 4.5, eave: 2.5, plain: true,
        ops: {
          front: [cart(-0.9, 0, 2.2, 2.0), win(1.9, 1.0, 0.6, 0.7)],
          back: [win(1.2, 1.1, 0.5, 0.6)],
          right: [door(0, 0.12, 0.9, 1.95)],
        },
        gableOps: { left: hatch(0, 2.9, 0.7, 0.8) },
        chimneys: [{ x: -2.61, z: 0, sx: 0.8, sz: 0.9 }],
      },
      { key: 'normandy_church', role: 'church', church: true },
    ],
  },

  // Russian izba: log walls on a fieldstone footing, gable to the street with
  // three windows, white carved surrounds (nalichniki) and blue shutters,
  // 40 deg board roof, crossed log corners, brick stove chimney at the ridge.
  izba: {
    wallTex: 'logs', roofTex: 'planks', wallRelief: 0.05, roofRelief: 0.02,
    wallRough: 1, roofRough: 1,
    roof: 'gable', pitch: 40, oe: 0.62, ov: 0.55, tr: 0.1, cap: true, wallT: 0.2,
    foundation: 'trim', foundH: 0.5, logCorners: true,
    sill: null, lintel: null, frame: C.BOARD, pediment: true, shutters: C.SHUTTER, step: C.TIMBER,
    ruin: 'burnt', spire: 'tent-onion', churchEave: 5,
    logA: 0x6f604e, logB: 0x7c7466, chink: 0x3a3428,
    roofCol: 0x7a746b, roofColAlt: 0x6a6255,
    trim: {
      frame: 0xd8d3c3, glass: 0x27323a, door: 0x5a4733, shutter: 0x40709a, stone: 0x9a968c,
      field: 0x7f7b73, timber: 0x51422f, brick: 0x8a4d3a, metal: 0x5f6d66, board: 0xe4dfd0,
      endgrain: 0x9e8a6c, shingle: 0x7d776d, panes: [2, 3],
    },
    archetypes: [
      {
        key: 'izba_house', role: 'house', w: 6.2, d: 8.5, eave: 3.25,
        ops: {
          front: [win(-1.85, 1.35, 0.75, 1.05), win(0, 1.35, 0.75, 1.05), win(1.85, 1.35, 0.75, 1.05)],
          right: [door(2.6, 0.5, 0.95, 1.9), win(-1.5, 1.35, 0.75, 1.05)],
          left: [win(-2, 1.35, 0.75, 1.05), win(1.2, 1.35, 0.75, 1.05)],
          back: [win(0, 1.5, 0.6, 0.8, NS)],
        },
        gableOps: { front: win(0, 3.9, 0.55, 0.7, NS) },
        chimneys: [{ x: 0, z: -0.9, sx: 0.7, sz: 0.7 }],
      },
      {
        key: 'izba_large', role: 'house', w: 7.2, d: 11, eave: 3.5, foundH: 0.75,
        ops: {
          front: [win(-2.3, 1.55, 0.8, 1.1), win(0, 1.55, 0.8, 1.1), win(2.3, 1.55, 0.8, 1.1)],
          right: [door(3.4, 0.75, 1.0, 1.95), win(0.4, 1.55, 0.8, 1.1), win(-3.2, 1.55, 0.8, 1.1)],
          left: [win(-2.5, 1.55, 0.8, 1.1), win(0.5, 1.55, 0.8, 1.1), win(3.4, 1.55, 0.8, 1.1)],
        },
        gableOps: { front: win(0, 4.2, 0.6, 0.75, NS), back: hatch(0, 4.1, 0.8, 0.9) },
        chimneys: [{ x: 0, z: 0.8, sx: 0.75, sz: 0.75 }],
      },
      {
        key: 'izba_barn', role: 'barn', w: 11, d: 6, eave: 2.75, foundH: 0.25, plain: true,
        ops: { front: [cart(-2.3, 0.25, 2.6, 2.1), cart(2.6, 0.25, 2.2, 2.1)] },
        gableOps: { left: hatch(0, 3.1, 1.0, 1.0) },
      },
      {
        key: 'izba_banya', role: 'shed', w: 4.2, d: 5, eave: 2.25, foundH: 0.25, plain: true,
        ops: { front: [door(-0.6, 0.25, 0.8, 1.75)], right: [win(0.8, 1.2, 0.5, 0.45)] },
        chimneys: [{ x: 0, z: -1.2, sx: 0.5, sz: 0.5 }],
      },
      { key: 'izba_church', role: 'church', church: true },
    ],
  },

  // Ukrainian khata: whitewashed clay walls with a dark-painted plinth,
  // blue window frames, thick 35 deg hipped thatch with a deep overhang.
  khata: {
    wallTex: 'render', roofTex: 'thatch', wallRelief: 0.012, roofRelief: 0.06,
    wallRough: 1, roofRough: 1,
    roof: 'hip', pitch: 35, oe: 0.62, ov: 0.62, tr: 0.35, cap: false, wallT: 0.26,
    foundation: 'wall', plinthTint: [0.6, 0.47, 0.37], plinthH: 0.45,
    sill: null, lintel: null, frame: C.BOARD, pediment: false, shutters: null, step: null,
    ruin: 'masonry', stove: true, spire: 'dome-metal', churchEave: 5,
    render: 0xe4e0d4, under: 0xa98c68,
    roofCol: 0x9a8762, roofColAlt: 0x847866, moss: 0x5e5f45,
    trim: {
      frame: 0x3e6e8c, glass: 0x26323a, door: 0x5e4a34, shutter: 0x3e6e8c, stone: 0xc9c2b0,
      field: 0x8a8479, timber: 0x55452f, brick: 0x8e5a44, metal: 0x4f6e5a, board: 0x3e6e8c,
      endgrain: 0x9a8668, shingle: 0x6b6258, panes: [2, 2],
    },
    archetypes: [
      {
        key: 'khata_house', role: 'house', w: 9, d: 5.5, eave: 2.5,
        ops: {
          front: [door(-0.9, 0.1, 0.9, 1.9), win(-3.2, 0.9, 0.8, 0.95), win(1.3, 0.9, 0.8, 0.95), win(3.4, 0.9, 0.8, 0.95)],
          back: [win(1.5, 0.9, 0.7, 0.8)],
          right: [win(0, 0.9, 0.7, 0.8)],
        },
        chimneys: [{ x: 0.9, z: -0.7, sx: 0.6, sz: 0.6 }],
      },
      {
        key: 'khata_large', role: 'house', w: 11, d: 6, eave: 2.6,
        ops: {
          front: [win(-4.2, 0.9, 0.8, 1.0), win(-2.4, 0.9, 0.8, 1.0), door(0, 0.1, 0.9, 1.95),
            win(2.4, 0.9, 0.8, 1.0), win(4.2, 0.9, 0.8, 1.0)],
          back: [win(-2, 0.9, 0.7, 0.8), win(3, 0.9, 0.7, 0.8)],
          left: [win(0, 0.9, 0.7, 0.8)],
          right: [door(0.8, 0.1, 0.85, 1.85)],
        },
        chimneys: [{ x: -1.2, z: -0.8, sx: 0.6, sz: 0.6 }],
      },
      {
        key: 'khata_khliv', role: 'barn', w: 12, d: 6.5, eave: 2.4, plain: true, wallTint: [0.84, 0.74, 0.6],
        ops: {
          front: [cart(-3.2, 0, 1.8, 2.0), win(0, 1.3, 0.5, 0.45), cart(3.2, 0, 1.8, 2.0)],
          back: [win(-3, 1.4, 0.5, 0.4), win(3, 1.4, 0.5, 0.4)],
          left: [door(0.8, 0.05, 0.9, 1.8)],
          right: [win(0, 1.3, 0.45, 0.45)],
        },
      },
      {
        // summer kitchen (litnia kukhnia): whitewashed, its own stove chimney
        key: 'khata_kitchen', role: 'shed', w: 4.8, d: 3.8, eave: 2.2, plain: true,
        ops: {
          front: [door(-0.9, 0.05, 0.85, 1.8), win(1.2, 0.9, 0.6, 0.6)],
          back: [win(0.5, 0.9, 0.55, 0.55)],
          right: [win(0, 0.9, 0.5, 0.5)],
          left: [win(0.4, 0.9, 0.5, 0.5)],
        },
        chimneys: [{ x: -1.2, z: -0.6, sx: 0.55, sz: 0.55 }],
      },
      { key: 'khata_church', role: 'church', church: true },
    ],
  },

  // North-African village: lime-rendered rubble cubes, flat roofs behind a
  // 0.6 m parapet with a drip coping, small grilled windows, louvred blue
  // shutters and studded doors, rooftop stair huts and low domes.
  desert: {
    wallTex: 'render', roofTex: 'flat', wallRelief: 0.015, roofRelief: 0.015,
    wallRough: 1, roofRough: 1,
    roof: 'flat', par: 0.6, pitch: 0, oe: 0.25, ov: 0.25, tr: 0, wallT: 0.36,
    foundation: 'wall', plinthTint: [0.84, 0.78, 0.7], plinthH: 0.5,
    sill: null, lintel: null, frame: null, pediment: false, shutters: C.SHUTTER, step: C.STONE,
    ruin: 'masonry', spire: 'minaret', churchEave: 6.5,
    render: 0xd9caa9, under: 0xa48d6a, stoneUnder: true,
    roofCol: 0xc9b894, roofColAlt: 0xb5a27e,
    trim: {
      frame: 0x2f5f8f, glass: 0x1e2a33, door: 0x2f5e8e, shutter: 0x366996, stone: 0xd8ccb2,
      field: 0x9b8b70, timber: 0x5a4631, brick: 0x9a6a4a, metal: 0x3d7a5e, board: 0x2f5f8f,
      endgrain: 0xa08a68, shingle: 0x6b5d4c, panes: [2, 2], grille: true, louvred: true, studs: true,
    },
    archetypes: [
      {
        key: 'desert_house', role: 'house', w: 9, d: 8, eave: 6.0,
        ops: {
          front: [door(-2.2, 0.1, 1.1, 2.3), win(2.2, 1.3, 0.7, 0.9, NS), win(-2.2, 3.9, 0.85, 1.2), win(2.2, 3.9, 0.85, 1.2)],
          back: [win(0, 3.9, 0.7, 1.0)],
          left: [win(1.5, 1.3, 0.6, 0.7, NS)],
          right: [win(-1.5, 3.9, 0.7, 1.0)],
        },
        extras: stairHut,
      },
      {
        key: 'desert_low', role: 'house', w: 11, d: 7, eave: 3.4,
        ops: {
          front: [door(0, 0.1, 1.1, 2.2), win(-3, 1.2, 0.7, 0.9), win(3, 1.2, 0.7, 0.9)],
          back: [win(-2, 1.3, 0.6, 0.7, NS)],
          left: [win(0, 1.3, 0.6, 0.7, NS)],
        },
        extras: lowDome,
      },
      {
        key: 'desert_store', role: 'barn', w: 12, d: 8, eave: 3.6, plain: true,
        ops: {
          front: [cart(-2.5, 0, 2.8, 2.8), win(3.5, 2.4, 0.5, 0.5)],
          back: [win(-3, 2.4, 0.5, 0.5), win(3, 2.4, 0.5, 0.5)],
        },
      },
      {
        key: 'desert_shed', role: 'shed', w: 5, d: 4, eave: 2.5, plain: true,
        ops: {
          front: [door(0.6, 0.05, 0.9, 1.9), win(-1.4, 1.3, 0.45, 0.5)],
          back: [win(0, 1.6, 0.4, 0.4)],
          left: [win(0, 1.6, 0.4, 0.4)],
          right: [win(0.6, 1.6, 0.4, 0.4)],
        },
      },
      { key: 'desert_mosque', role: 'church', church: true },
    ],
  },

  // Finnish / Karelian farm: Falu-red logs on a stone footing, white corner
  // boards and window frames, 35 deg roofs under snow; barns and saunas keep
  // their crossed log corners.
  nordic: {
    wallTex: 'logs', roofTex: 'snow', wallRelief: 0.045, roofRelief: 0.03,
    wallRough: 1, roofRough: 1,
    roof: 'gable', pitch: 35, oe: 0.5, ov: 0.38, tr: 0.14, cap: false, wallT: 0.18,
    foundation: 'trim', foundH: 0.5, cornerBoards: true,
    sill: null, lintel: null, frame: C.BOARD, pediment: false, shutters: null, step: C.STONE,
    ruin: 'burnt', spire: 'broach-shingle', churchEave: 5.5,
    logA: 0x94422f, logB: 0x853b2b, bare: 0x6d6457, chink: 0x2e2420,
    roofCol: 0xe6ebf0, roofColAlt: 0x3f3731,
    trim: {
      frame: 0xeeeeea, glass: 0x28343c, door: 0x5e3a2a, shutter: 0xe6e6e0, stone: 0x9a9a94,
      field: 0x7c7c78, timber: 0x4a3a2c, brick: 0x8a4a38, metal: 0x5a6064, board: 0xefefea,
      endgrain: 0x9f8a6b, shingle: 0x5d5248, panes: [2, 3], curtain: true,
    },
    archetypes: [
      {
        key: 'nordic_house', role: 'house', w: 10, d: 7, eave: 3.6,
        ops: {
          front: [door(-1.4, 0.5, 1.0, 2.05), win(-3.7, 1.3, 0.9, 1.3), win(1.2, 1.3, 0.9, 1.3), win(3.7, 1.3, 0.9, 1.3)],
          back: [win(-2.5, 1.3, 0.9, 1.3), win(2.5, 1.3, 0.9, 1.3)],
          left: [win(-1.3, 1.3, 0.8, 1.1), win(1.3, 1.3, 0.8, 1.1)],
          right: [win(0, 1.3, 0.8, 1.1)],
        },
        gableOps: { left: win(0, 4.1, 0.7, 0.9), right: win(0, 4.1, 0.7, 0.9) },
        chimneys: [{ x: 0.4, z: 0, sx: 0.65, sz: 0.65 }],
      },
      {
        key: 'nordic_two_storey', role: 'house', w: 12, d: 8, eave: 5.8,
        ops: {
          front: [door(0, 0.5, 1.1, 2.1), win(-3.8, 1.3, 0.9, 1.3), win(-1.9, 1.3, 0.9, 1.3), win(1.9, 1.3, 0.9, 1.3),
            win(3.8, 1.3, 0.9, 1.3), win(-3.8, 3.8, 0.9, 1.25), win(-1.3, 3.8, 0.9, 1.25), win(1.3, 3.8, 0.9, 1.25),
            win(3.8, 3.8, 0.9, 1.25)],
          back: [win(-3, 1.3, 0.9, 1.3), win(3, 1.3, 0.9, 1.3), win(0, 3.8, 0.9, 1.25)],
        },
        gableOps: { left: win(0, 6.4, 0.6, 0.8), right: win(0, 6.4, 0.6, 0.8) },
        chimneys: [{ x: -1.5, z: 0, sx: 0.65, sz: 0.65 }],
      },
      {
        key: 'nordic_barn', role: 'barn', w: 13, d: 7.5, eave: 3.2, foundH: 0.25, plain: true, logCorners: true,
        oe: 0.62, ov: 0.58,   // log ends stick out 0.3 m; the eaves have to clear them
        wallTint: [0.8, 0.86, 0.9],
        ops: { front: [cart(-2.5, 0.25, 3.0, 2.5), door(3.5, 0.25, 1.0, 1.9)] },
        gableOps: { left: hatch(0, 3.6, 1.2, 1.2) },
      },
      {
        key: 'nordic_sauna', role: 'shed', w: 4.5, d: 3.6, eave: 2.2, foundH: 0.25, plain: true, logCorners: true,
        oe: 0.62, ov: 0.58,
        ops: { front: [door(-0.9, 0.25, 0.8, 1.75), win(1.1, 1.2, 0.5, 0.45)] },
        chimneys: [{ x: 1.2, z: 0, sx: 0.45, sz: 0.45 }],
      },
      { key: 'nordic_church', role: 'church', church: true },
    ],
  },
};

// Flat-roof extras (desert): the stair hut every roof terrace has...
function stairHut({ gw, gr, gt, e }) {
  const x0 = 1.8;
  const x1 = 4.1;
  const z0 = -3.6;
  const z1 = -1.4;
  const y1 = e + 2.3;
  const shade = (p) => 0.8 + 0.2 * smooth(e, e + 1.5, p[1]);
  box(gw, x0, x1, e, y1, z0, z1, 'px nx pz nz', null, shade);
  box(gr, x0 - 0.12, x1 + 0.12, y1, y1 + 0.12, z0 - 0.12, z1 + 0.12, 'px nx pz nz py ny', null, 0.9);
  quad(gt, [x0 - 0.03, e, z1 - 0.5], [x0 - 0.03, e, z1 - 1.35], [x0 - 0.03, e + 1.9, z1 - 1.35], [x0 - 0.03, e + 1.9, z1 - 0.5], C.DOOR, 1);
  return y1 + 0.12;
}

// ...and a low whitewashed vault-dome on a single-storey house.
function lowDome({ gw, q, e }) {
  const prof = [[1.9, 0], [1.86, 0.45], [1.62, 0.95], [1.18, 1.35], [0.62, 1.6], [0, 1.72]];
  lathe(gw, -2.5, -0.6, e - 0.05, prof, q === 'low' ? 8 : 10, null, 0.95);
  return e + 1.67;
}

// ---------------------------------------------------------------------------
// the landmark: church (mosque in the desert kit)
// ---------------------------------------------------------------------------
// Nave 10 x 22 m with its ridge along Z; a 5 x 5 x 16 m tower stands on the
// street front (+Z), 0.6 m proud of the facade; an 8 m spire / tent-and-onion /
// pear dome / minaret lantern crowns it. Footprint 10 x 22.6 m.

const NAVE_CZ = -0.3;
const TOWER_CZ = 8.8;
const TOWER_H = 16;

function church(S, st, q) {
  const gw = new Geo();
  const gr = new Geo();
  const gt = new Geo();
  const e = S.churchEave;
  const flat = S.roof === 'flat';
  const logs = S.wallTex === 'logs';
  const pitch = flat ? 0 : S.pitch;
  const tp = Math.tan(pitch * DEG);
  const trimFound = S.foundation === 'trim';
  const fH = trimFound ? S.foundH : 0;
  const y0w = trimFound ? fH : -1.2;
  const doorY = trimFound ? fH : 0.15;
  const breaks = [e - 1.1];
  if (S.plinthTint) breaks.push(S.plinthH, S.plinthH + 0.04);
  else breaks.push(0.6);
  breaks.shift();   // no eave-shadow row across the long church walls: a whole row of quads saved
  const shade = wallShade(S, e);
  const cw = (s, y, w, h) => (logs ? win(s, y, w, h, NS) : arch(s, y, w, h));
  const aw = flat ? 0.8 : 1.1;
  const ah = flat ? 1.5 : 2.6;
  const ay = flat ? 2.6 : 2.0;
  const N = faces4(0, NAVE_CZ, 10, 22);
  const T = faces4(0, TOWER_CZ, 5, 5);

  // timber churches have fewer, framed windows; masonry naves four arched bays
  const bays = logs ? [-3.2, 2.2, 7.6] : [-4.5, 0, 4.5, 8.5];
  const naveOps = {
    right: [door(-8.5, doorY, 1.3, 2.5), ...bays.map((s) => cw(s, ay, aw, ah))],
    left: bays.map((s) => cw(-s, ay, aw, ah)),
    back: [cw(0, flat ? 2.6 : 2.2, flat ? 0.9 : 1.2, flat ? 1.6 : 3.0)],
    front: [],
  };
  const minaret = S.spire === 'minaret';
  const towerOps = minaret
    ? {
      front: [door(0, doorY, 1.2, 2.4), arch(0, 5.4, 0.5, 1.0), arch(0, 9.6, 0.5, 1.0)],
      right: [arch(0, 13, 0.6, 1.2)], left: [arch(0, 13, 0.6, 1.2)], back: [arch(0, 13, 0.6, 1.2)],
    }
    : {
      front: [door(0, doorY, 1.4, 2.8), cw(0, 5.4, 0.8, 1.5), louvre(0, 12.4, 1.1, 1.9)],
      right: [louvre(0, 12.4, 1.1, 1.9)], left: [louvre(0, 12.4, 1.1, 1.9)], back: [louvre(0, 12.4, 1.1, 1.9)],
    };

  const foundRing = (Fs) => {
    if (!trimFound) return;
    for (const k of FACE_KEYS) {
      const Fk = Fs[k];
      const ext = k === 'front' || k === 'back' ? 0.08 : 0;
      plate(gt, Fk, -Fk.W / 2 - ext, Fk.W / 2 + ext, -1.2, fH, 0.08, ext ? 'ftlr' : 'ft', C.FIELD,
        (p) => 0.6 + 0.4 * smooth(-0.8, fH, p[1]));
    }
  };
  foundRing(N);
  // the tower's footing only shows on its street face; the rest is inside the nave
  if (trimFound) plate(gt, T.front, -2.58, 2.58, -1.2, fH, 0.08, 'ftlr', C.FIELD, 0.8);

  // nave walls
  for (const k of FACE_KEYS) {
    const ops = naveOps[k];
    facade(gw, N[k], y0w, flat ? e + S.par : e, ops.map(hole), breaks, shade);
    for (const op of ops) {
      reveal(gw, gt, N[k], hole(op), S.wallT, OP_CELL[op.k], 0.66);
      dressOpening(S, gt, N[k], op, q, false, true);
    }
  }
  let top = e;
  if (flat) {
    const r = flatRoof(gw, gr, { cz: NAVE_CZ, w: 10, d: 22, e, par: S.par, T: S.wallT });
    const prof = [[3.6, 0], [3.55, 0.7], [3.2, 1.6], [2.5, 2.4], [1.4, 3.0], [0, 3.3]];
    lathe(gw, 0, NAVE_CZ - 3.5, e - 0.05, prof, q === 'low' ? 10 : 12, null, 0.95);
    top = Math.max(r.top, e + 3.25);
  } else {
    const yr = e + 5 * tp;
    gable(gw, N.front, e, yr, null, shade);
    const rose = cw(0, e + 1.0, 0.9, 1.1);
    gable(gw, N.back, e, yr, hole(rose), shade);
    reveal(gw, gt, N.back, hole(rose), S.wallT, OP_CELL[rose.k], 0.66);
    dressOpening(S, gt, N.back, rose, q, false, true);
    top = gableRoof(gr, { cz: NAVE_CZ, L: 22, S: 10, e, pitch, oe: S.oe, ov: S.ov, tr: S.tr, alongX: false, cap: S.cap && q !== 'low' }).ridge;
  }
  // stepped buttresses on the Norman nave
  if (st === 'normandy' && q !== 'low') {
    for (const k of ['left', 'right']) {
      const Fk = N[k];
      for (const s of [-6.5, -2.25, 2.25, 6.5]) {
        plate(gw, Fk, s - 0.35, s + 0.35, -1.2, e - 1.3, 0.55, 'flr', null, shade);
        gw.poly([FP(Fk, s - 0.35, e - 1.3, -0.55), FP(Fk, s + 0.35, e - 1.3, -0.55), FP(Fk, s + 0.35, e - 0.6, 0), FP(Fk, s - 0.35, e - 0.6, 0)],
          norm([Fk.n[0], 0.8, Fk.n[2]]), null, 0.9);
      }
    }
  }

  // tower
  const tShade = wallShade(S, TOWER_H);
  for (const k of FACE_KEYS) {
    const ops = towerOps[k];
    facade(gw, T[k], y0w, TOWER_H, ops.map(hole), [TOWER_H - 1.1], tShade);
    for (const op of ops) {
      reveal(gw, gt, T[k], hole(op), S.wallT, OP_CELL[op.k], 0.66);
      dressOpening(S, gt, T[k], op, q, false, true);
    }
  }
  if ((st === 'normandy' || st === 'desert') && q === 'high') {   // dressed-stone string courses
    for (const k of FACE_KEYS) {
      const Fk = T[k];
      const ext = k === 'front' || k === 'back' ? 0.1 : 0;
      const sides = ext ? 'ftblr' : 'ftb';
      plate(gt, Fk, -2.5 - ext, 2.5 + ext, TOWER_H - 0.3, TOWER_H, 0.1, sides, C.STONE, 0.95);
      plate(gt, Fk, -2.5 - ext * 0.6, 2.5 + ext * 0.6, 11.5, 11.72, 0.06, sides, C.STONE, 0.95);
    }
  }

  // crown
  const seg = q === 'low' ? 8 : 12;
  let crown = TOWER_H;
  switch (S.spire) {
    case 'broach-roof':
      crown = broachSpire(gr, 0, TOWER_CZ, 2.5, TOWER_H, 8, 0.3, null);
      crown = crossOn(gt, 0, crown - 0.1, TOWER_CZ, 0.9);
      break;
    case 'broach-shingle':
      crown = broachSpire(gt, 0, TOWER_CZ, 2.5, TOWER_H, 8, 0.35, C.SHINGLE);
      crown = crossOn(gt, 0, crown - 0.1, TOWER_CZ, 0.9);
      break;
    case 'tent-onion': {
      broachSpire(gr, 0, TOWER_CZ, 2.5, TOWER_H, 5.2, 0.4, null);
      const prof = [[0.42, 0], [0.85, 0.7], [0.95, 1.1], [0.6, 1.65], [0.1, 2.1], [0, 2.25]];
      lathe(gr, 0, TOWER_CZ, TOWER_H + 4.9, prof, 8, null, 1);
      crown = crossOn(gt, 0, TOWER_H + 7.1, TOWER_CZ, 0.8);
      break;
    }
    case 'dome-metal': {
      // baroque pear dome: bell, waist, lantern bulb
      const prof = [[3.62, 0], [3.1, 1.2], [2.0, 2.4], [0.8, 3.25], [0.45, 3.8], [0.82, 4.6], [0.72, 5.4], [0.3, 6.1], [0, 6.6]];
      lathe(gt, 0, TOWER_CZ, TOWER_H, prof, q === 'low' ? 8 : 10, C.METAL, 1);
      const ring = [];
      for (let k = 0; k < seg; k++) {
        const a = (-k / seg) * Math.PI * 2;
        ring.push([3.62 * Math.cos(a), TOWER_H, TOWER_CZ + 3.62 * Math.sin(a)]);
      }
      gt.poly(ring, [0, -1, 0], () => cellUV(C.METAL, 0.5, 0.5), 0.55);
      crown = crossOn(gt, 0, TOWER_H + 6.5, TOWER_CZ, 0.9);
      break;
    }
    default: { // minaret: gallery slab, lantern, green-tiled pyramid, finial
      const y = TOWER_H;
      box(gr, -2.8, 2.8, y, y + 0.25, TOWER_CZ - 2.8, TOWER_CZ + 2.8, 'px nx pz nz py ny', null, 0.9);
      box(gw, -1.3, 1.3, y + 0.25, y + 3.2, TOWER_CZ - 1.3, TOWER_CZ + 1.3, 'px nx pz nz', null, 0.95);
      const L4 = faces4(0, TOWER_CZ, 2.6, 2.6);
      for (const k of FACE_KEYS) plate(gt, L4[k], -0.35, 0.35, y + 1.0, y + 2.6, 0.02, 'f', C.LOUVRE);
      box(gr, -1.55, 1.55, y + 3.2, y + 3.38, TOWER_CZ - 1.55, TOWER_CZ + 1.55, 'px nx pz nz py ny', null, 0.9);
      const ap = [0, y + 7.9, TOWER_CZ];
      const c = (sx, sz) => [sx * 1.5, y + 3.38, TOWER_CZ + sz * 1.5];
      const puv = (p) => cellUV(C.METAL, (p[0] + p[2] - TOWER_CZ) / 6 + 0.5, (p[1] - y - 3.38) / 4.5);
      gt.poly([c(-1, 1), c(1, 1), ap], [0, 0.3, 1], puv);
      gt.poly([c(1, 1), c(1, -1), ap], [1, 0.3, 0], puv);
      gt.poly([c(1, -1), c(-1, -1), ap], [0, 0.3, -1], puv);
      gt.poly([c(-1, -1), c(-1, 1), ap], [-1, 0.3, 0], puv);
      box(gt, -0.05, 0.05, y + 7.7, y + 8.9, TOWER_CZ - 0.05, TOWER_CZ + 0.05, 'px nx pz nz', C.IRON, 1);
      crown = y + 8.9;
    }
  }
  top = Math.max(top, crown);

  const rects = [
    { cx: 0, cz: NAVE_CZ, w: 10, d: 22, e, pitch, gable: !flat, alongX: false, step: 1.7 },
    { cx: 0, cz: TOWER_CZ, w: 5, d: 5, e: TOWER_H * 0.72, pitch: 0, gable: false, alongX: true, step: 1.25 },
  ];
  return { gw, gr, gt, top, pitch, rects };
}

// ---------------------------------------------------------------------------
// photo surfaces: CC0 scans from core/assets.js
// ---------------------------------------------------------------------------
// The walls and roofs wear photographed surfaces (Poly Haven / ambientCG, see
// public/media/CREDITS.md and design/research-assets.md section 6). The scans
// carry DETAIL only: every colour map is mean-neutral (linear mean 0.5 per
// channel), so a layer's albedo is
//     tex.rgb * 2 * tint                (tint = calibrated LINEAR albedo mean)
// and the calibrated colour of the old painted texture survives the swap. The
// kit geometry is untouched: walls and roofs already carry world-metre UVs, so
// a layer tiles at its scan's real size (manifest `tile`) with repeat 1/tile.
// The v axis is flipped because assets.js uploads with flipY = false (image
// top at v = 0) while the kit's v runs UP the wall / slope.
//
// A material can hold two layers. Layer B is picked per BUILDING from the
// instance colour scenery.js gives each house (setColorAt -> the batching
// colour), so a palette entry chooses its own material: the Pays d'Auge clay
// tile roof gets clay tiles instead of a red-tinted slate, a mud-brick desert
// house gets mud render, a grey Karelian log house gets bare logs instead of
// Falu-red boards. A neutral layer divides that instance tint back out (its own
// tint is absolute). Layer B can instead be mixed per FRAGMENT by a noise mask
// (snow lying on a board roof). A plinth layer swaps the detail below a given
// object-space height (the clay plinth of a khata, the stone base of a desert
// house). The trim atlas keeps its painted windows and doors and gains photo
// grain per atlas cell (wood, stone, brick); fieldstone footings and brick
// chimneys are replaced outright by their scan.
//
// CONTRACT for anyone binding these: the scans are the asset loader's shared,
// cached textures. They start as neutral placeholders (already in their final
// format) and are filled in place when they decode, so the program compiles
// once and nothing recompiles when an image lands. Never dispose them; only
// core/assets.js frees them. Headless they stay placeholders: flat calibrated
// colour, never a throw.

const srgbLin = (b) => {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
// packed sRGB hex -> LINEAR triple, decoded by hand (see the header)
function hexLin(hex) {
  return [srgbLin((hex >> 16) & 255), srgbLin((hex >> 8) & 255), srgbLin(hex & 255)];
}
const lumY = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

let texMode = 'photo';
// 'photo' (CC0 scans, default) or 'procedural' (the painted canvases). Affects
// kits built after the call; kits are cached per mode.
export function setBuildingTextureMode(mode) {
  texMode = mode === 'procedural' ? 'procedural' : 'photo';
  return texMode;
}
export function getBuildingTextureMode() { return texMode; }

// Strength of a scan's own ambient occlusion (arm.r) on the indirect light.
// research-assets.md 10.8: 0.6-0.8, so the photo AO does not double the
// screen-space GTAO (postfx.js, blend 0.85 on high). Scans whose AO is dark on
// average (reed thatch ~0.60, clay tiles ~0.65 mean) take the low end.
const PHOTO_AO = 0.7;
const PHOTO_AO_DARK = 0.6;

// A photo layer: { set, tint: linear [r,g,b], tint2?, rot?, normal?, rough?, ao?, neutral? }
// -> textures and the shader constants for it, or null if the set is missing.
function photoLayer(spec) {
  const s = getAssetSet(spec.set);
  if (!s || !s.files || !(s.kinds || []).includes('c') || !(s.kinds || []).includes('n')) return null;
  const quad = !!(s.layout && s.layout.n === 'quad');
  const arm = !quad && (s.kinds || []).includes('arm');
  const tile = spec.tile ?? (s.tile > 0 ? s.tile : 2);
  const setRough = s.rough > 0 ? s.rough : 0.8;
  return {
    set: spec.set,
    quad,
    arm,
    c: loadTexture(spec.set, 'c'),
    n: loadTexture(spec.set, 'n'),
    armTex: arm ? loadTexture(spec.set, 'arm') : null,
    tint: new THREE.Vector3(...spec.tint),
    tint2: new THREE.Vector3(...(spec.tint2 || spec.tint)),
    // (1/tile, -1/tile: v flipped, rotate 90 deg?, normal strength)
    xf: new THREE.Vector4(1 / tile, -1 / tile, spec.rot ? 1 : 0, spec.normal ?? 1),
    // (roughness gain to hit the target mean, floor, AO strength, -)
    rough: new THREE.Vector4((spec.rough ?? setRough) / setRough, spec.roughMin ?? 0.3, spec.ao ?? PHOTO_AO, 0),
    neutral: spec.neutral ? 1 : 0,
  };
}

// GLSL shared by both patches. Object mapping projects along the dominant axis
// of the OBJECT-space normal: tops take (x, z), walls (along the wall, up).
const PS_COMMON = /* glsl */`
varying vec2 vPsUv;
varying vec3 vPsPos;
varying vec3 vPsNrm;
varying vec3 vPsBC;
varying float vPsRnd;
float psHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float psNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(psHash(i), psHash(i + vec2(1.0, 0.0)), f.x),
             mix(psHash(i + vec2(0.0, 1.0)), psHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec2 psObjBase() {
  vec3 an = abs(vPsNrm);
  if (an.y >= an.x && an.y >= an.z) return vPsPos.xz;
  if (an.x >= an.z) return vec2(vPsNrm.x > 0.0 ? -vPsPos.z : vPsPos.z, vPsPos.y);
  return vec2(vPsNrm.z > 0.0 ? vPsPos.x : -vPsPos.x, vPsPos.y);
}
vec2 psXform(vec2 b, vec4 xf) { return (xf.z > 0.5 ? b.yx : b) * xf.xy; }
// three's own getTangentFrame (normalmap_pars_fragment), which is only compiled
// when a stock normalMap is set: TBN from screen-space derivatives of the uv
// the map is sampled with, so any flip / rotation / scale of it is honoured.
mat3 psTangentFrame(vec3 eyePos, vec3 surfNorm, vec2 uv) {
  vec3 q0 = dFdx(eyePos.xyz);
  vec3 q1 = dFdy(eyePos.xyz);
  vec2 st0 = dFdx(uv.st);
  vec2 st1 = dFdy(uv.st);
  vec3 N = surfNorm;
  vec3 q1perp = cross(q1, N);
  vec3 q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  // single-sided materials only (no faceDirection flip, unlike three's caller)
  return mat3(T * scale, B * scale, N);
}
`;

const PS_VERTEX_HEAD = /* glsl */`
varying vec2 vPsUv;
varying vec3 vPsPos;
varying vec3 vPsNrm;
varying vec3 vPsBC;
varying float vPsRnd;
`;

// After batching_vertex: object-space inputs, the building's instance colour
// and a per-building random number from where it stands.
const PS_VERTEX_BODY = /* glsl */`
  vPsUv = uv;
  vPsPos = position;
  vPsNrm = normal;
  #if defined( USE_BATCHING )
    vec2 psI = batchingMatrix[3].xz;
  #elif defined( USE_INSTANCING )
    vec2 psI = (modelMatrix * instanceMatrix)[3].xz;
  #else
    vec2 psI = modelMatrix[3].xz;
  #endif
  vPsRnd = fract(sin(dot(floor(psI * 4.0) * 0.25, vec2(12.9898, 78.233))) * 43758.5453);
  #ifdef USE_BATCHING_COLOR
    vPsBC = getBatchingColor(getIndirectIndex(gl_DrawID));
  #else
    vPsBC = vec3(1.0);
  #endif
`;

function patchVertex(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${PS_VERTEX_HEAD}`)
    .replace('#include <batching_vertex>', `#include <batching_vertex>\n${PS_VERTEX_BODY}`);
}

// Layer sampling, emitted once per layer (L = A or B).
function psLayerGlsl(L, quad, arm) {
  return /* glsl */`
  vec2 psUv${L} = psXform(psB0, psXf${L});
  vec3 psC${L} = texture2D(ps${L}c, psUv${L}).rgb * 2.0;
  vec4 psNt${L} = texture2D(ps${L}n, psUv${L});
  vec3 psN${L} = vec3((psNt${L}.rg * 2.0 - 1.0) * psXf${L}.w, 0.0);
  ${quad
    ? `psN${L}.z = sqrt(max(0.05, 1.0 - dot(psN${L}.xy, psN${L}.xy)));
  float psR${L} = psNt${L}.b;
  float psO${L} = 1.0;`
    : `psN${L}.z = psNt${L}.b * 2.0 - 1.0;
  ${arm ? `vec3 psArm${L} = texture2D(ps${L}arm, psUv${L}).rgb;
  float psR${L} = psArm${L}.g;
  float psO${L} = psArm${L}.r;` : `float psR${L} = 1.0;
  float psO${L} = 1.0;`}`}
  psR${L} = clamp(psR${L} * psR${L}x.x, psR${L}x.y, 1.0);
  psO${L} = mix(1.0, psO${L}, psR${L}x.z);
`;
}

/**
 * A MeshStandardMaterial that draws one or two photo layers (see above).
 * cfg: {
 *   name, mapping: 'uv' (geometry uv in metres) | 'object' (object-space planar),
 *   a: layer spec, b?: layer spec,
 *   select?: { mode: 'warm' | 'cool' | 'noise', lo, hi, scale, scaleV, split? },
 *            // warm / cool: B where the instance colour's r-b (b-r) passes
 *            // lo..hi; noise: the lying-snow mask (see the GLSL). split:
 *            // B takes tint above that r-b (b-r), tint2 below it (default:
 *            // tint / tint2 by a per-building hash)
 *   plinth?: { set, height, blend },     // detail swap below object y = height
 *   joints?: { px, pz, width, dark, tone }, // slab joints + per-slab tone (object mapping)
 *   macro?: { scale, amp },              // low-frequency brightness drift (object xz)
 *   jitter = 0.05,                       // per-building brightness, neutral layers
 *   vertexColors = true,
 * }
 * Layer spec: { set, tint (linear), tint2?, rot?, normal?, rough?, ao?, neutral? }.
 *   ao: strength of the scan's own AO on indirect light (default PHOTO_AO).
 *   Layer A only: alt?: { tint (linear), neutral?, mode: 'warm' | 'cool', lo, hi }
 *   gives one palette entry its own tint (e.g. desert whitewash among plaster).
 * Returns null when a scan is missing from the manifest (caller falls back).
 * The material and its uniforms are the caller's to cache; the textures are
 * the asset loader's (never dispose them). userData.photo.uniforms holds the
 * live uniform objects (tints can be changed without a recompile).
 */
export function photoSurfaceMaterial(cfg) {
  const A = photoLayer(cfg.a);
  if (!A) return null;
  const Bl = cfg.b ? photoLayer(cfg.b) : null;
  if (cfg.b && !Bl) return null;
  const plS = cfg.plinth ? getAssetSet(cfg.plinth.set) : null;
  const objectMap = cfg.mapping === 'object';
  const m = new THREE.MeshStandardMaterial({
    name: cfg.name || 'photoSurface',
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    vertexColors: cfg.vertexColors !== false,
  });
  const U = {
    psAc: { value: A.c },
    psAn: { value: A.n },
    psTintA: { value: A.tint },
    psXfA: { value: A.xf },
    psRAx: { value: A.rough },
    psNeutral: { value: new THREE.Vector2(A.neutral, Bl ? Bl.neutral : 0) },
    psJitter: { value: cfg.jitter ?? 0.05 },
  };
  if (A.armTex) U.psAarm = { value: A.armTex };
  const defs = [];
  if (objectMap) defs.push('PS_OBJECT');
  if (Bl) {
    defs.push('PS_B');
    Object.assign(U, {
      psBc: { value: Bl.c },
      psBn: { value: Bl.n },
      psTintB: { value: Bl.tint },
      psTintB2: { value: Bl.tint2 },
      psXfB: { value: Bl.xf },
      psRBx: { value: Bl.rough },
      psSel: { value: new THREE.Vector4(cfg.select?.lo ?? 0.5, cfg.select?.hi ?? 0.6, cfg.select?.scale ?? 0.3, cfg.select?.scaleV ?? cfg.select?.scale ?? 0.3) },
    });
    if (Bl.armTex) U.psBarm = { value: Bl.armTex };
    const mode = cfg.select?.mode || 'warm';
    defs.push(mode === 'cool' ? 'PS_SEL_COOL' : mode === 'noise' ? 'PS_SEL_NOISE' : 'PS_SEL_WARM');
    if (cfg.select && cfg.select.split != null && mode !== 'noise') {
      // tint vs tint2 of layer B by the same instance-colour measure (above
      // the split: tint), instead of by the per-building hash
      defs.push('PS_SPLIT');
      U.psSplit = { value: cfg.select.split };
    }
  }
  const alt = cfg.a && cfg.a.alt && (cfg.a.alt.tint || cfg.a.alt.tintHex != null)
    ? { ...cfg.a.alt, tint: cfg.a.alt.tint || hexLin(cfg.a.alt.tintHex) } : null;
  if (alt) {
    // layer A's own per-palette-entry tint: where the instance colour's r-b
    // (warm) or b-r (cool) passes lo..hi, A takes tint `alt.tint`, neutral or not
    defs.push('PS_ALT');
    U.psTintAlt = { value: new THREE.Vector3(...alt.tint) };
    U.psAltSel = { value: new THREE.Vector4(alt.lo ?? 0.15, alt.hi ?? 0.25, alt.neutral ? 1 : 0, alt.mode === 'cool' ? 1 : 0) };
  }
  if (plS) {
    defs.push('PS_PLINTH');
    const t = plS.tile > 0 ? plS.tile : 2;
    U.psCc = { value: loadTexture(cfg.plinth.set, 'c') };
    U.psPl = { value: new THREE.Vector4(cfg.plinth.height ?? 0.5, cfg.plinth.blend ?? 0.06, 1 / t, -1 / t) };
  }
  if (cfg.joints) {
    defs.push('PS_JOINTS');
    const j = cfg.joints;
    U.psJoint = { value: new THREE.Vector4(j.px ?? 6, j.pz ?? 5.5, j.width ?? 0.025, j.dark ?? 0.5) };
    U.psSlabTone = { value: j.tone ?? 0 };
  }
  if (cfg.macro) {
    // low-frequency brightness drift (mean 1), so a large flat area does not
    // read as one repeated tile from the air (art bible E-03)
    defs.push('PS_MACRO');
    U.psMacro = { value: new THREE.Vector2(1 / (cfg.macro.scale ?? 20), cfg.macro.amp ?? 0.08) };
  }

  const head = `${PS_COMMON}
uniform sampler2D psAc;
uniform sampler2D psAn;
${A.armTex ? 'uniform sampler2D psAarm;' : ''}
uniform vec3 psTintA;
uniform vec4 psXfA;
uniform vec4 psRAx;
uniform vec2 psNeutral;
uniform float psJitter;
${Bl ? `uniform sampler2D psBc;
uniform sampler2D psBn;
${Bl.armTex ? 'uniform sampler2D psBarm;' : ''}
uniform vec3 psTintB;
uniform vec3 psTintB2;
uniform vec4 psXfB;
uniform vec4 psRBx;
uniform vec4 psSel;` : ''}
${U.psSplit ? 'uniform float psSplit;' : ''}
${alt ? 'uniform vec3 psTintAlt;\nuniform vec4 psAltSel;' : ''}
${plS ? `uniform sampler2D psCc;
uniform vec4 psPl;` : ''}
${cfg.joints ? 'uniform vec4 psJoint;\nuniform float psSlabTone;' : ''}
${cfg.macro ? 'uniform vec2 psMacro;' : ''}
`;

  const body = /* glsl */`
#ifdef PS_OBJECT
  vec2 psB0 = psObjBase();
#else
  vec2 psB0 = vPsUv;
#endif
${psLayerGlsl('A', A.quad, !!A.armTex)}
  float psSelF = 0.0;
  // layer A's tint and neutrality, per palette entry when PS_ALT is set
  vec3 psTintAe = psTintA;
  float psNeuA = psNeutral.x;
#ifdef PS_ALT
  {
    float psAm = mix(vPsBC.r - vPsBC.b, vPsBC.b - vPsBC.r, psAltSel.w);
    float psAltF = smoothstep(psAltSel.x, psAltSel.y, psAm);
    psTintAe = mix(psTintA, psTintAlt, psAltF);
    psNeuA = mix(psNeutral.x, psAltSel.z, psAltF);
  }
#endif
#ifdef PS_B
${psLayerGlsl('B', Bl ? Bl.quad : false, !!(Bl && Bl.armTex))}
  float psSelM = 0.0;
  #if defined( PS_SEL_COOL )
    psSelM = vPsBC.b - vPsBC.r;
    psSelF = smoothstep(psSel.x, psSel.y, psSelM);
  #elif defined( PS_SEL_NOISE )
    // lying-snow mask on a roof (uv: u along the eave, v metres up the slope):
    // streaks running down the slope where the snow has slid, most of them
    // at the eave, none at the ridge
    vec2 psNp = psB0 * psSel.zw + vPsRnd * 37.0;
    float psNz = psNoise(psNp) * 0.65 + psNoise(psNp * 2.7 + 11.0) * 0.35;
    psNz += 0.2 * (1.0 - smoothstep(0.4, 2.6, psB0.y));
    psSelF = smoothstep(psSel.x, psSel.y, psNz);
  #else
    psSelM = vPsBC.r - vPsBC.b;
    psSelF = smoothstep(psSel.x, psSel.y, psSelM);
  #endif
  vec3 psDet = mix(psCA, psCB, psSelF);
  #ifdef PS_SPLIT
    // which of B's two tints: by palette entry (the same measure as the select)
    vec3 psTintBe = mix(psTintB2, psTintB, step(psSplit, psSelM));
  #else
    vec3 psTintBe = mix(psTintB, psTintB2, step(0.5, vPsRnd));
  #endif
  vec3 psTint = mix(psTintAe, psTintBe, psSelF);
  float psRoughF = mix(psRA, psRB, psSelF);
  float psAoF = mix(psOA, psOB, psSelF);
#else
  vec3 psDet = psCA;
  vec3 psTint = psTintAe;
  float psRoughF = psRA;
  float psAoF = psOA;
#endif
#ifdef PS_PLINTH
  float psPm = 1.0 - smoothstep(psPl.x - psPl.y, psPl.x + psPl.y, vPsPos.y);
  psDet = mix(psDet, texture2D(psCc, psB0 * psPl.zw).rgb * 2.0, psPm);
#endif
  float psNeu = mix(psNeuA, psNeutral.y, psSelF);
  vec3 psAlb = psDet * psTint;
  psAlb *= mix(vec3(1.0), 1.0 / max(vPsBC, vec3(0.05)), psNeu);
  psAlb *= 1.0 + psJitter * (vPsRnd * 2.0 - 1.0) * psNeu;
#ifdef PS_JOINTS
  {
    vec2 psJp = vPsPos.xz / psJoint.xy;
    vec2 psJd = abs(fract(psJp + 0.5) - 0.5) * psJoint.xy;
    float psJm = min(psJd.x, psJd.y);
    float psJw = max(fwidth(psJm), 1e-4);
    float psJc = smoothstep(psJoint.z + psJw, psJoint.z - psJw, psJm) * clamp(2.0 * psJoint.z / psJw, 0.0, 1.0);
    psJc *= step(0.5, vPsNrm.y);
    // every slab poured from its own batch: a slightly different tone each
    psAlb *= 1.0 + (psHash(floor(psJp) + 0.37) * 2.0 - 1.0) * psSlabTone;
    psAlb *= mix(1.0, psJoint.w, psJc);
    psRoughF = mix(psRoughF, 0.7, psJc);
  }
#endif
#ifdef PS_MACRO
  {
    vec2 psMp = vPsPos.xz * psMacro.x;
    float psM = psNoise(psMp) * 0.6 + psNoise(psMp * 2.3 + 7.1) * 0.4;
    psAlb *= 1.0 + (psM * 2.0 - 1.0) * psMacro.y;
  }
#endif
  diffuseColor.rgb *= psAlb;
`;

  const normalBody = /* glsl */`
  {
    vec3 psNa = normalize(psTangentFrame(- vViewPosition, normal, psUvA) * psNA);
#ifdef PS_B
    vec3 psNb = normalize(psTangentFrame(- vViewPosition, normal, psUvB) * psNB);
    normal = normalize(mix(psNa, psNb, psSelF));
#else
    normal = psNa;
#endif
  }
`;

  const defLines = defs.map((d) => `#define ${d}`).join('\n');
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    patchVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `${defLines}\n#include <common>\n${head}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${body}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = psRoughF;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${normalBody}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
  reflectedLight.indirectDiffuse *= psAoF;
  reflectedLight.indirectSpecular *= psAoF;`);
    m.userData.photoShader = shader;
  };
  const sig = `ps1|${defs.join(',')}|${A.quad ? 'q' : A.armTex ? 'a' : 'n'}|${Bl ? (Bl.quad ? 'q' : Bl.armTex ? 'a' : 'n') : '-'}`;
  m.customProgramCacheKey = () => sig;
  m.userData.photo = { uniforms: U, sets: [A.set, Bl && Bl.set, cfg.plinth && cfg.plinth.set].filter(Boolean), sig };
  return markSharedGeometry(m);
}

// The trim atlas (painted windows, doors, frames) with photo grain added per
// cell: wood grain on doors, shutters, boards and timber, stone on dressed
// stone; fieldstone footings and brick chimneys REPLACED by their scans (the
// painted bricks would beat against the photographed ones). Atlas cells are
// found from the atlas uv; the photo is projected in object space.
// cells: 16 entries [set (0 none, 1 wood, 2 stone, 3 brick), mode (0..1 =
// grain strength, 2 = replace), tint hex (replace only)].
function trimPhotoPatch(m, cfg) {
  const wood = getAssetSet(cfg.wood);
  const stone = getAssetSet(cfg.stone);
  const brick = getAssetSet(cfg.brick);
  if (!wood || !stone || !brick) return m;
  const tileV = (s) => new THREE.Vector2(1 / (s.tile || 2), -1 / (s.tile || 2));
  const U = {
    psWc: { value: loadTexture(cfg.wood, 'c') },
    psSc: { value: loadTexture(cfg.stone, 'c') },
    psSn: { value: loadTexture(cfg.stone, 'n') },
    psKc: { value: loadTexture(cfg.brick, 'c') },
    psKn: { value: loadTexture(cfg.brick, 'n') },
    psTileW: { value: tileV(wood) },
    psTileS: { value: tileV(stone) },
    psTileK: { value: tileV(brick) },
    psCellSet: { value: cfg.cells.map((c) => c[0]) },
    psCellMode: { value: cfg.cells.map((c) => c[1]) },
    psCellTint: { value: cfg.cells.map((c) => new THREE.Vector3(...(c[2] != null ? hexLin(c[2]) : [1, 1, 1]))) },
  };
  const head = `${PS_COMMON}
uniform sampler2D psWc;
uniform sampler2D psSc;
uniform sampler2D psSn;
uniform sampler2D psKc;
uniform sampler2D psKn;
uniform vec2 psTileW;
uniform vec2 psTileS;
uniform vec2 psTileK;
uniform float psCellSet[16];
uniform float psCellMode[16];
uniform vec3 psCellTint[16];
`;
  const body = /* glsl */`
#ifdef USE_MAP
  vec2 psAu = vMapUv;
#else
  vec2 psAu = vec2(0.0);
#endif
  float psCx = clamp(floor(psAu.x * 4.0), 0.0, 3.0);
  float psCy = 3.0 - clamp(floor(psAu.y * 4.0), 0.0, 3.0);
  int psCi = int(psCy * 4.0 + psCx + 0.5);
  float psSet = psCellSet[psCi];
  float psMode = psCellMode[psCi];
  vec3 psCellTnt = psCellTint[psCi];
  vec2 psB0 = psObjBase();
  vec2 psUvS = psB0 * psTileS;
  vec3 psCW = texture2D(psWc, psB0 * psTileW).rgb * 2.0;
  vec3 psCS = texture2D(psSc, psUvS).rgb * 2.0;
  vec3 psCK = texture2D(psKc, psB0 * psTileK).rgb * 2.0;
  vec3 psNS = texture2D(psSn, psUvS).rgb * 2.0 - 1.0;
  vec3 psNK = texture2D(psKn, psB0 * psTileK).rgb * 2.0 - 1.0;
  float psW1 = 1.0 - min(abs(psSet - 1.0), 1.0);
  float psW2 = 1.0 - min(abs(psSet - 2.0), 1.0);
  float psW3 = 1.0 - min(abs(psSet - 3.0), 1.0);
  vec3 psDet = psCW * psW1 + psCS * psW2 + psCK * psW3 + vec3(1.0 - psW1 - psW2 - psW3);
  float psRep = step(1.5, psMode);
  float psMod = min(psMode, 1.0) * (1.0 - psRep);
  diffuseColor.rgb = mix(diffuseColor.rgb * mix(vec3(1.0), psDet, psMod), psDet * psCellTnt, psRep);
  vec3 psNt = psNS * psW2 + psNK * psW3 + vec3(0.0, 0.0, 1.0) * (1.0 - psW2 - psW3);
`;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    patchVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${head}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${body}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.92, psRep);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  {
    vec3 psPN = normalize(psTangentFrame(- vViewPosition, nonPerturbedNormal, psUvS) * psNt);
    normal = normalize(mix(normal, psPN, psRep));
  }`);
    m.userData.photoShader = shader;
  };
  m.customProgramCacheKey = () => 'pstrim1';
  m.userData.photo = { uniforms: U, sets: [cfg.wood, cfg.stone, cfg.brick] };
  return m;
}

// Linear albedo means of the painted procedural textures (measured from the
// painters at 256 px; scratchpad wave3/bldtex/calib.mjs). These ARE the
// calibrated colours; a photo layer's default tint is this times `gain`.
const PAINT_MEAN = {
  normandy: { walls: [0.3639, 0.3117, 0.2240], roof: [0.0646, 0.0668, 0.0848] },
  izba: { walls: [0.1328, 0.1056, 0.0742], roof: [0.1207, 0.1059, 0.0850] },
  khata: { walls: [0.7125, 0.6675, 0.5757], roof: [0.1856, 0.1470, 0.0896] },
  desert: { walls: [0.5945, 0.5049, 0.3385], roof: [0.4826, 0.3880, 0.2331] },
  nordic: { walls: [0.1841, 0.0409, 0.0238], roof: [0.6907, 0.7236, 0.7750] },
};

// Per style. Bands (art bible 4.4, linear Y of the albedo a typical house
// shows, i.e. tint x its instance colour, ~0.85-0.9 on every preset):
//   limestone wall 0.30-0.45, log wall 0.06-0.12, whitewash 0.55-0.70,
//   slate 0.05-0.08, clay tile 0.10-0.15, thatch 0.15-0.25, sand <= 0.42
//   (C-07: nothing built brighter than the desert's sand, whitewash excepted).
const PHOTO_STYLES = {
  normandy: {
    // painted 0.317 x instance 0.87 = 0.275 sat under the band: x1.2 -> 0.33
    walls: { a: { set: 'stone_wall', gain: 1.2, rough: 0.92 } },
    roof: {
      a: { set: 'roof_slates_02', rough: 0.72 },
      // Pays d'Auge flat clay tiles, chosen by the palette's clay entry
      b: { set: 'clay_roof_tiles', tintHex: 0x8f5436, rough: 0.82, neutral: true, ao: PHOTO_AO_DARK },
      select: { mode: 'warm', lo: 0.25, hi: 0.35 },
    },
    trim: { wood: 'weathered_plank_siding', stone: 'stone_wall', brick: 'brick_wall_006' },
  },
  izba: {
    walls: { a: { set: 'wooden_rough_planks', rough: 0.88 } },
    // tesovaya krovlya: the boards run DOWN the slope
    roof: { a: { set: 'weathered_plank_siding', rot: true, rough: 0.9 } },
    trim: { wood: 'weathered_plank_siding', stone: 'stone_wall', brick: 'brick_wall_006' },
  },
  khata: {
    walls: { a: { set: 'Plaster007', rough: 0.95 }, plinth: { set: 'sandstone_cracks', height: 0.45 } },
    // painted 0.151 x 0.85 = 0.128 under the thatch band: x1.3 -> 0.167
    roof: { a: { set: 'riet_01', gain: 1.3, rough: 1, ao: PHOTO_AO_DARK } },
    trim: { wood: 'weathered_plank_siding', stone: 'stone_wall', brick: 'brick_wall_006' },
  },
  desert: {
    walls: {
      // painted 0.512 x 0.85 = 0.435 broke C-07: x0.92 -> 0.40, for the
      // limestone-plaster entry only. The palette's whitewash entry (b-r of its
      // instance colour 0.33, plaster -0.09) is exempt from C-07 and belongs in
      // the whitewash band 0.55-0.70 (C-01): it is drawn in its own palette
      // colour, Y 0.60, instead of the plaster tint x its instance colour (0.46)
      a: {
        set: 'Plaster007', gain: 0.92, rough: 0.95,
        alt: { tintHex: 0xcec8ba, gainY: 0.6, neutral: true, mode: 'cool', lo: 0.15, hi: 0.25 },
      },
      // the palette's mud-brick entry gets mud render
      b: { set: 'sandstone_cracks', tintHex: 0xab946f, rough: 0.95, neutral: true },
      select: { mode: 'warm', lo: 0.12, hi: 0.15 },
      plinth: { set: 'sandstone_blocks_05', height: 0.5 },
    },
    roof: { a: { set: 'sandstone_cracks', rough: 0.97 } },
    trim: { wood: 'weathered_plank_siding', stone: 'sandstone_blocks_05', brick: 'brick_wall_006' },
  },
  nordic: {
    walls: {
      // Falu-red board cladding, in the colour it had against the painted
      // kit's reference (PAINT_MEAN x the old Falu instance tint
      // [0.964, 0.78, 0.78], Y 0.062), absolute: the reference changed (below) ...
      a: { set: 'weathered_plank_siding', tint: [0.1775, 0.0319, 0.0186], rough: 0.85, neutral: true },
      // ... and the palette's grey / brown log entries as bare logs, each in
      // its own colour. Against the old reference (logA, Falu red) both log
      // entries clamped to the same instance colour [0.78, 1.22, 1.22]; against
      // the brown log (paletteWall) the three entries separate by b-r: grey
      // +0.42, brown 0, Falu -0.44.
      b: { set: 'wooden_rough_planks', tintHex: 0x58544d, tint2Hex: 0x5f4939, rough: 0.9, neutral: true },
      select: { mode: 'cool', lo: -0.3, hi: -0.15, split: 0.2 },
    },
    // kit.palette.wall of the photo kit: the colour scenery.js measures the
    // preset's wall palette against (paletteTint) — see the walls above
    paletteWall: 0x5f4939,
    roof: {
      // lying snow (old snow 0.50-0.70 .. fresh 0.80): white whatever the
      // instance colour, which is meant for the boards under it
      a: { set: 'snow_02', tint: [0.72, 0.74, 0.78], rough: 0.8, neutral: true },
      b: { set: 'weathered_plank_siding', rot: true, tintHex: 0x4a463f, rough: 0.9, neutral: true },
      select: { mode: 'noise', lo: 0.74, hi: 0.8, scale: 1.1, scaleV: 0.22 },
    },
    trim: { wood: 'weathered_plank_siding', stone: 'stone_wall', brick: 'brick_wall_006' },
  },
};

function layerSpec(spec, base) {
  if (!spec) return null;
  const tint = spec.tint || (spec.tintHex != null ? hexLin(spec.tintHex) : base.map((c) => c * (spec.gain ?? 1)));
  const tint2 = spec.tint2Hex != null ? hexLin(spec.tint2Hex) : null;
  let alt = null;
  if (spec.alt) {
    // alt tint: tint | tintHex (scaled to linear Y gainY when given) | base x gain
    const a = spec.alt;
    let t = a.tint || (a.tintHex != null ? hexLin(a.tintHex) : base.map((c) => c * (a.gain ?? 1)));
    if (a.gainY) { const k = a.gainY / Math.max(1e-4, lumY(t)); t = t.map((c) => c * k); }
    alt = { ...a, tint: t };
  }
  return { ...spec, tint, tint2, alt };
}

// Trim cells -> [set, mode, tint]: 1 wood, 2 stone, 3 brick; mode 0..1 grain, 2 replace.
function trimCells(S) {
  const cells = Array.from({ length: 16 }, () => [0, 0, null]);
  cells[C.DOOR] = [1, 0.85, null];
  cells[C.SHUTTER] = [1, 0.75, null];
  cells[C.STONE] = [2, 0.6, null];
  cells[C.FIELD] = [2, 2, S.trim.field];
  cells[C.TIMBER] = [1, 0.9, null];
  cells[C.BRICK] = [3, 2, S.trim.brick];
  cells[C.LOUVRE] = [1, 0.5, null];
  cells[C.BOARD] = [1, 0.6, null];
  cells[C.SHINGLE] = [1, 0.6, null];
  return cells;
}

// The photo materials of a style, or null (missing scans -> painted kit).
function photoMaterials(st, S, trimMat) {
  const P = PHOTO_STYLES[st];
  const mean = PAINT_MEAN[st];
  if (!P || !mean) return null;
  const mk = (part) => {
    const c = P[part];
    return photoSurfaceMaterial({
      name: `buildings:${st}:${part}`,
      mapping: 'uv',
      a: layerSpec(c.a, mean[part]),
      b: layerSpec(c.b, mean[part]),
      select: c.select,
      plinth: c.plinth,
    });
  };
  const walls = mk('walls');
  const roof = mk('roof');
  if (!walls || !roof) return null;
  return { walls, roof, trim: trimPhotoPatch(trimMat, { ...P.trim, cells: trimCells(S) }) };
}

// The albedo bands a style's photo layers are calibrated to: mean linear Y of
// every layer's tint (tests and tooling).
export function buildingPhotoCalibration(style) {
  const P = PHOTO_STYLES[style];
  const mean = PAINT_MEAN[style];
  if (!P || !mean) return null;
  const out = {};
  for (const part of ['walls', 'roof']) {
    for (const L of ['a', 'b']) {
      const s = layerSpec(P[part][L], mean[part]);
      if (!s) continue;
      out[`${part}.${L}`] = {
        set: s.set, tint: s.tint, Y: lumY(s.tint), tint2Y: s.tint2 ? lumY(s.tint2) : null, neutral: !!s.neutral,
        ao: s.ao ?? PHOTO_AO,
        alt: s.alt ? { tint: s.alt.tint, Y: lumY(s.alt.tint), neutral: !!s.alt.neutral, mode: s.alt.mode || 'warm', lo: s.alt.lo, hi: s.alt.hi } : null,
        tint2: s.tint2 || null,
        select: L === 'b' ? P[part].select || null : null,
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// kit
// ---------------------------------------------------------------------------

function styleSeed(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100000;
}

function buildArchetype(S, st, A, q, seed) {
  let b;
  let w;
  let d;
  let eave;
  let pitch;
  let rects;
  let solidR;
  let stove = null;
  if (A.church) {
    b = church(S, st, q);
    w = 10;
    d = 22.6;
    eave = S.churchEave;
    pitch = b.pitch;
    rects = b.rects;
    solidR = 8.3;
  } else {
    b = house(S, A, q);
    w = A.w;
    d = A.d;
    eave = A.eave;
    pitch = S.roof === 'flat' ? 0 : b.pitch;
    rects = [{ cx: 0, cz: 0, w, d, e: eave, pitch, gable: S.roof === 'gable', alongX: w >= d }];
    if ((S.ruin === 'burnt' || S.stove) && A.role === 'house') stove = { x: -w * 0.2, z: -d * 0.15, top: eave + 1.8 };
    solidR = 0.55 * Math.sqrt(w * d);
  }
  if (A.wallTint) {
    const K = b.gw.K;
    for (let i = 0; i < K.length; i += 3) {
      K[i] *= A.wallTint[0];
      K[i + 1] *= A.wallTint[1];
      K[i + 2] *= A.wallTint[2];
    }
  }
  const parts = { walls: b.gw.toGeometry(), roof: b.gr.toGeometry(), trim: b.gt.toGeometry() };
  const ruin = {
    walls: ruinWalls(S, rects, seed, stove).toGeometry(),
    rubble: rubbleHeap(S, rects, seed + 5, q).toGeometry(),
  };
  let h = 0;
  for (const g of Object.values(parts)) h = Math.max(h, g.boundingBox.max.y);
  const tri = (g) => g.index.count / 3;
  const tris = {
    walls: tri(parts.walls), roof: tri(parts.roof), trim: tri(parts.trim),
    ruinWalls: tri(ruin.walls), rubble: tri(ruin.rubble),
  };
  tris.total = tris.walls + tris.roof + tris.trim;
  return {
    key: A.key,
    role: A.role,
    w,
    d,
    h,
    solidR,
    parts,
    ruin,
    // --- extra, read-only --------------------------------------------------
    style: st,
    eave,
    pitch,
    ridgeAxis: S.roof === 'flat' ? null : w >= d ? 'x' : 'z',
    overhang: S.roof === 'flat' ? { eave: 0.25, verge: 0.25 } : { eave: A.oe ?? S.oe, verge: S.roof === 'hip' ? A.oe ?? S.oe : A.ov ?? S.ov },
    tris,
  };
}

function kitMaterial(name, size, painted, strength, tile, withRough, rough) {
  const opts = {
    name,
    color: 0xffffff,
    map: texture(canvasOf(size, painted.alb), { srgb: true, tile }),
    normalMap: texture(canvasOf(size, normalBytes(painted.hgt, size, strength)), { tile }),
    roughness: rough,
    metalness: 0,
    vertexColors: true,
  };
  if (withRough) opts.roughnessMap = texture(canvasOf(size, painted.rgh), { tile });
  return markSharedGeometry(new THREE.MeshStandardMaterial(opts));
}

const kitCache = new Map();

export function buildingKit(style, quality) {
  const st = Object.prototype.hasOwnProperty.call(STYLES, style) ? style : 'normandy';
  let q = quality;
  if (!TEX_SIZE[q]) {
    try {
      q = getMaterialQuality();
    } catch {
      q = 'high';
    }
    if (!TEX_SIZE[q]) q = 'high';
  }
  const key = `${st}|${q}|${texMode}`;
  const hit = kitCache.get(key);
  if (hit) return hit;

  const S = STYLES[st];
  const size = TEX_SIZE[q];
  const seed = styleSeed(st);
  // The trim atlas is always painted (windows, doors, frames); walls and roofs
  // wear the photo scans unless they are missing or the mode says otherwise.
  const trimP = paintTrim(size, S, seed + 13);
  const trimMat = kitMaterial(`buildings:${st}:trim`, size, trimP, relief(0.03, TILE, size), 0, true, 1);
  let materials = texMode === 'photo' ? photoMaterials(st, S, trimMat) : null;
  const surfaces = materials ? 'photo' : 'procedural';
  if (!materials) {
    const wallPaint = S.wallTex === 'stone' ? paintStone : S.wallTex === 'logs' ? paintLogs : paintRender;
    const roofPaint = { slate: paintSlate, planks: paintPlanks, thatch: paintThatch, snow: paintSnowRoof, flat: paintFlatRoof }[S.roofTex];
    const wallP = wallPaint(size, S, seed);
    const roofP = roofPaint(size, S, seed + 7);
    materials = {
      walls: kitMaterial(`buildings:${st}:walls`, size, wallP, relief(S.wallRelief, TILE, size), TILE, false, 0.95),
      roof: kitMaterial(`buildings:${st}:roof`, size, roofP, relief(S.roofRelief, TILE, size), TILE, true, 1),
      trim: trimMat,
    };
  }
  const archetypes = S.archetypes.map((A, i) => buildArchetype(S, st, A, q, seed + 101 * (i + 1)));
  const kit = {
    materials,
    archetypes,
    style: st,
    quality: q,
    surfaces,
    textureSize: size,
    // the colours the textures were painted in, for anyone tinting instances
    // (a photo kit may name its own wall reference: PHOTO_STYLES.paletteWall)
    palette: {
      wall: surfaces === 'photo' && PHOTO_STYLES[st] && PHOTO_STYLES[st].paletteWall != null
        ? PHOTO_STYLES[st].paletteWall
        : S.stones ? S.stones[0] : S.logA ?? S.render,
      roof: S.roofCol,
      trim: S.trim.frame,
    },
  };
  kitCache.set(key, kit);
  return kit;
}

// Frees every cached kit. Only for a quality change or a full shutdown; battle
// teardown must leave kits alone (they are all stamped shared).
export function disposeBuildingKits() {
  for (const kit of kitCache.values()) {
    for (const m of Object.values(kit.materials)) {
      m.map?.dispose();
      m.normalMap?.dispose();
      m.roughnessMap?.dispose();
      m.dispose();
    }
    for (const a of kit.archetypes) {
      for (const g of Object.values(a.parts)) g.dispose();
      for (const g of Object.values(a.ruin)) g.dispose();
    }
  }
  kitCache.clear();
}
