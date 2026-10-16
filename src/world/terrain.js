import * as THREE from 'three';
import { activePreset, mixColor } from './presets.js';
import { getMaterialQuality } from '../core/materials.js';
import { LANDUSE_GLSL, landUseFor } from './landuse.js';
import {
  buildTerrainArrays, terrainLayers, releaseTerrainExcept, releaseAsset, assetStatus, assetsEnabled,
  getAssetSet, assetTile,
} from '../core/assets.js';

export const WORLD_SIZE = 900;   // terrain mesh extent (m)
export const PLAY_BOUND = 420;   // tanks are clamped inside ±PLAY_BOUND

// Analytic heightmap: the mesh is generated from this exact function, so
// physics (tanks, shells) can sample it directly with no raycasts.
// The seed shifts the noise field so every battle gets a fresh layout.
//
// On top of the noise sits a hand-shaped feature set — ridgelines across the
// axis of advance, draws running with it, a few knolls and a graded village —
// because open rolling hills make cover accidental. Every feature is a bump
// function with finite support and a cheap bounding test, so terrainHeight is
// still a pure, allocation-free function of (x, z) that a shell can sample
// forty times in a frame.
let seedX = 0;
let seedZ = 0;

const ROAD_CORE = 9;     // metres either side of the track that are fully graded
const ROAD_GRADE = 34;   // and the distance over which the grading tapers away
const ROAD_SURF = 6.5;   // metres either side that read as bare dirt
const HOLLOW_H = -6;     // below this the bottoms are damp and bare

// Deterministic 0..1 from an integer: the layout has to be reproducible from
// the seed alone, because physics and the mesh must agree on where the hill is.
function hash01(n) {
  let t = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  t ^= t >>> 13;
  t = Math.imul(t, 0xc2b2ae35);
  t ^= t >>> 16;
  return (t >>> 0) / 4294967296;
}

// Smoothstep bump: 1 at the crest, 0 at |t| >= 1, flat at both ends so a ridge
// meets the surrounding ground without a crease the mesh would have to fake.
function crest(t) {
  const p = 1 - (t < 0 ? -t : t);
  if (p <= 0) return 0;
  return p * p * (3 - 2 * p);
}

let layout = null;

function buildLayout(sx, sz) {
  let n = 0;
  const seed = (Math.floor(sx * 13.37) + Math.floor(sz * 7.77) * 65537) | 0;
  const r = () => hash01(seed + (n++) * 0x6d2b79f5);

  // The battle axis is X (both teams spawn at x = ±330), so the whole feature
  // set is laid out in a frame rotated a little off it and optionally mirrored.
  const theta = (r() - 0.5) * 0.85;
  const mirror = r() < 0.5 ? 1 : -1;

  const town = {
    x: (r() - 0.5) * 90,
    z: (r() < 0.5 ? 1 : -1) * (88 + r() * 42),
    r: 44 + r() * 16,
  };

  const knolls = [];
  for (let i = 0; i < 3; i++) {
    let kx = (r() - 0.5) * 230;
    let kz = (r() < 0.5 ? 1 : -1) * (72 + r() * 140);
    // never on the capture point, and never buried inside the village
    if (Math.hypot(kx, kz) < 82) kz += kz < 0 ? -60 : 60;
    if (Math.hypot(kx - town.x, kz - town.z) < town.r + 26) kx += 70;
    knolls.push({
      x: kx, z: kz,
      w: 30 + r() * 24,
      h: 26 + r() * 22,
      amp: 5.5 + r() * 4.5,
    });
  }

  // The road runs the length of the map through the village and past the point:
  // a graded lane is the one piece of terrain that tells a driver where to go.
  const pts = [
    { x: -380, z: (r() - 0.5) * 140 },
    { x: -110, z: town.z * 0.5 },
    { x: town.x, z: town.z * 0.82 },
    { x: 125, z: town.z * 0.22 },
    { x: 380, z: (r() - 0.5) * 140 },
  ];
  const road = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    road.push({
      ax: a.x, az: a.z, dx, dz, inv: 1 / len2,
      minX: Math.min(a.x, b.x) - ROAD_GRADE, maxX: Math.max(a.x, b.x) + ROAD_GRADE,
      minZ: Math.min(a.z, b.z) - ROAD_GRADE, maxZ: Math.max(a.z, b.z) + ROAD_GRADE,
    });
  }

  // A treeline down one flank, opposite the village, for a concealed approach.
  const tlSide = town.z > 0 ? -1 : 1;
  const treeline = {
    z: tlSide * (100 + r() * 80),
    x0: -(170 + r() * 90),
    x1: 130 + r() * 110,
    width: 12 + r() * 9,
    wobble: 16 + r() * 14,
    k: 0.009 + r() * 0.006,
    phase: r() * 6.283,
  };

  const L = {
    theta,
    cos: Math.cos(theta),
    sin: Math.sin(theta),
    mirror,
    // ridgelines: crests across the axis of advance, saddled along their length
    r1: 152 + r() * 44, w1: 66 + r() * 22, a1: 11 + r() * 5.5,
    k1: 0.0075 + r() * 0.005, p1: r() * 6.283,
    r2: 258 + r() * 46, w2: 54 + r() * 20, a2: 7 + r() * 4,
    k2: 0.006 + r() * 0.005, p2: r() * 6.283,
    // draws running with the advance: covered approaches onto each flank
    valleys: [
      { off: 128 + r() * 56, w: 62 + r() * 36, depth: 6.5 + r() * 4, len: 300 },
      { off: -(148 + r() * 72), w: 56 + r() * 30, depth: 5 + r() * 3.5, len: 270 },
    ],
    knolls,
    town,
    road,
    treeline,
  };
  L.features = worldFeatures(L);
  return L;
}

// Convert the layout out of its rotated frame so scenery (and anything else)
// can place props in world coordinates without repeating the trigonometry.
function worldFeatures(L) {
  const toWorld = (fx, fz) => {
    const rz = fz * L.mirror;
    return { x: fx * L.cos - rz * L.sin, z: fx * L.sin + rz * L.cos };
  };
  const town = toWorld(L.town.x, L.town.z);
  const roadPath = [];
  for (let i = 0; i < L.road.length; i++) {
    const s = L.road[i];
    roadPath.push(toWorld(s.ax, s.az));
    if (i === L.road.length - 1) roadPath.push(toWorld(s.ax + s.dx, s.az + s.dz));
  }
  const treePath = [];
  const tl = L.treeline;
  for (let i = 0; i <= 8; i++) {
    const fx = tl.x0 + (tl.x1 - tl.x0) * (i / 8);
    treePath.push(toWorld(fx, tl.z + Math.sin(fx * tl.k + tl.phase) * tl.wobble));
  }
  return {
    axis: L.theta,
    town: { x: town.x, z: town.z, radius: L.town.r },
    road: roadPath,
    roadWidth: ROAD_SURF,
    treeline: { path: treePath, width: tl.width },
    ridges: [
      { offset: L.r1, width: L.w1, height: L.a1 },
      { offset: L.r2, width: L.w2, height: L.a2 },
    ],
    valleys: L.valleys.map((v) => ({ offset: v.off, width: v.w, depth: v.depth })),
    knolls: L.knolls.map((k) => {
      const w = toWorld(k.x, k.z);
      return { x: w.x, z: w.z, radius: (k.w + k.h) * 0.5, height: k.amp };
    }),
    toWorld,
  };
}

layout = buildLayout(0, 0);

export function setTerrainSeed(sx, sz) {
  seedX = sx;
  seedZ = sz;
  layout = buildLayout(sx, sz);
}

// The map's fighting geometry in world coordinates: where the village stands,
// where the road runs, where the treeline is and where the ridges lie.
export function terrainFeatures() {
  return layout.features;
}

function roadDist(fx, fz, L) {
  let best = 1e9;
  const segs = L.road;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (fx < s.minX || fx > s.maxX || fz < s.minZ || fz > s.maxZ) continue;
    let t = ((fx - s.ax) * s.dx + (fz - s.az) * s.dz) * s.inv;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = s.ax + s.dx * t - fx;
    const pz = s.az + s.dz * t - fz;
    const d2 = px * px + pz * pz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

// Metres from the centreline of the track, for anything that wants to keep a
// prop (or a spawn) off the road.
export function roadDistanceAt(x, z) {
  const L = layout;
  const fx = x * L.cos + z * L.sin;
  const fz = (z * L.cos - x * L.sin) * L.mirror;
  return roadDist(fx, fz, L);
}

function featureHeight(fx, fz, L) {
  let h = 0;
  const ax = fx < 0 ? -fx : fx;

  let d = ax - L.r1;
  if (d > -L.w1 && d < L.w1) {
    // the saddle term is what turns a wall into a ridgeline: the crest sags
    // every couple of hundred metres, and those sags are the passes
    h += crest(d / L.w1) * L.a1 * (0.62 + 0.38 * Math.sin(fz * L.k1 + L.p1));
  }
  d = ax - L.r2;
  if (d > -L.w2 && d < L.w2) {
    h += crest(d / L.w2) * L.a2 * (0.55 + 0.45 * Math.sin(fz * L.k2 + L.p2));
  }

  for (let i = 0; i < 2; i++) {
    const v = L.valleys[i];
    d = fz - v.off;
    if (d > -v.w && d < v.w) {
      const over = ax - v.len;
      const fade = over > 0 ? 1 - over / 90 : 1;
      if (fade > 0) h -= crest(d / v.w) * v.depth * fade;
    }
  }

  for (let i = 0; i < L.knolls.length; i++) {
    const k = L.knolls[i];
    const dx = fx - k.x;
    if (dx < -k.w || dx > k.w) continue;
    const dz = fz - k.z;
    if (dz < -k.h || dz > k.h) continue;
    const q = Math.sqrt((dx * dx) / (k.w * k.w) + (dz * dz) / (k.h * k.h));
    if (q < 1) h += crest(q) * k.amp;
  }
  return h;
}

// How much of the graded works covers this point, 0..1. Both masks hold a flat
// core and taper a long way out — a short taper would berm the road instead of
// grading it, and a berm is worse cover to drive on than the hillside was.
function townMask(fx, fz, L) {
  const t = L.town;
  const dx = fx - t.x;
  const dz = fz - t.z;
  const dd = dx * dx + dz * dz;
  if (dd >= t.r * t.r) return 0;
  const p = 1 - Math.sqrt(dd) / t.r;
  return Math.min(1, p * p * (3 - 2 * p) * 1.5);
}

function roadMask(rd) {
  if (rd >= ROAD_GRADE) return 0;
  const p = Math.min(1, (ROAD_GRADE - rd) / (ROAD_GRADE - ROAD_CORE));
  return p * p * (3 - 2 * p);
}

function padMask(fx, fz, L, rd) {
  const t = townMask(fx, fz, L) * 0.85;
  const r = roadMask(rd) * 0.62;
  return t > r ? t : r;
}

export function terrainHeight(x0, z0) {
  const x = x0 + seedX;
  const z = z0 + seedZ;
  const broad = Math.sin(x * 0.008) * Math.cos(z * 0.008) * 14;
  let h = broad;
  h += Math.sin(x * 0.021 + 1.7) * Math.cos(z * 0.017 + 3.1) * 5;
  h += Math.sin(x * 0.052 + 4.2) * Math.cos(z * 0.047 + 1.3) * 1.4;

  const L = layout;
  const fx = x0 * L.cos + z0 * L.sin;
  const fz = (z0 * L.cos - x0 * L.sin) * L.mirror;
  h += featureHeight(fx, fz, L);

  // The village and its road are graded: the fine noise is scraped off and the
  // broad shape of the ground left, so buildings sit level and trucks can drive.
  const pad = padMask(fx, fz, L, roadDist(fx, fz, L));
  if (pad > 0) h += (broad - h) * pad;

  // flatten the middle (world origin) so the capture point sits on open ground
  const d = Math.hypot(x0, z0);
  const flat = Math.max(0, 1 - d / 70);
  h *= 1 - flat * 0.85;
  return h;
}

export function terrainNormal(x, z, out = new THREE.Vector3()) {
  const e = 0.6;
  out.set(
    terrainHeight(x - e, z) - terrainHeight(x + e, z),
    2 * e,
    terrainHeight(x, z - e) - terrainHeight(x, z + e),
  );
  return out.normalize();
}

// Tangent of the ground angle at a point (0 flat, 1 = 45 degrees). Sampled over
// a couple of metres so a single noisy vertex cannot read as a cliff.
export function terrainSlope(x, z) {
  const e = 1.6;
  const dx = terrainHeight(x - e, z) - terrainHeight(x + e, z);
  const dz = terrainHeight(x, z - e) - terrainHeight(x, z + e);
  return Math.sqrt(dx * dx + dz * dz) / (2 * e);
}

// ---------------------------------------------------------------------------
// Surfaces (shared contract C2). grip multiplies traction, drag is rolling
// resistance and dustColor tints what the tracks throw up.
export const SURFACE_TABLE = {
  grass: { grip: 1.0, drag: 0.06 },
  dirt: { grip: 0.92, drag: 0.13 },
  sand: { grip: 0.75, drag: 0.3 },
  snow: { grip: 0.65, drag: 0.2 },
  rock: { grip: 1.05, drag: 0.04 },
};

const DEFAULT_DUST = { grass: 0x8a7050, dirt: 0x9a8a68, sand: 0xd8bb84, snow: 0xeef3f7, rock: 0x9c968c };

// Reused so a per-frame caller allocates nothing. Read it, do not keep it —
// or pass your own object as the third argument if you need to hold on to one.
const surfScratch = { type: 'grass', grip: 1, drag: 0.06, dustColor: 0x9a8a68 };

export function terrainSurface(x, z, out = surfScratch) {
  const p = activePreset();
  const L = layout;
  const fx = x * L.cos + z * L.sin;
  const fz = (z * L.cos - x * L.sin) * L.mirror;
  const g = terrainSlope(x, z);

  let type;
  if (g > 0.36) {
    // anything this steep has had its soil washed off it
    type = 'rock';
  } else {
    const rd = roadDist(fx, fz, L);
    if (rd < ROAD_SURF || townMask(fx, fz, L) > 0.6) {
      // the track and the village streets are churned bare by everything that
      // has already driven down them
      type = 'dirt';
    } else {
      const h = terrainHeight(x, z);
      const snowLine = p.snowLine ?? 999;
      if ((p.snowCover ?? 0) > 0.35 || h > snowLine) type = 'snow';
      else if (h < HOLLOW_H && g < 0.1) type = p.hollowType || 'dirt';
      else type = p.groundType || 'grass';
    }
  }

  const s = SURFACE_TABLE[type] || SURFACE_TABLE.grass;
  const dust = p.dust || DEFAULT_DUST;
  out.type = type;
  out.grip = s.grip * (p.gripMul ?? 1);
  out.drag = s.drag;
  out.dustColor = dust[type] ?? DEFAULT_DUST[type];
  return out;
}

// ===========================================================================
// GROUND SURFACING
// ===========================================================================
//
// The ground is the largest thing on screen and it used to be a flat-shaded
// field of 7-metre facets carrying nothing but a vertex colour. It now carries
// three procedurally generated PBR layer sets — a cover layer (grass / sand /
// snow, picked from the preset), a soil layer and a rock layer — blended per
// fragment by weights the mesh builder computes per vertex.
//
// WHY DataTexture AND NOT A 2D CANVAS
// core/materials.js paints on a canvas because it draws real objects on top of
// its noise (rivets, panel lines) and a canvas is the only way to do that. The
// ground has no such features, and it wants something a canvas cannot give:
// roughness packed into the ALPHA channel of the albedo map, which halves the
// number of samplers the blend needs. A 2D canvas backing store is
// premultiplied, so writing (rgb, a=0.6) and reading it back does not give
// (rgb, 0.6). Raw byte uploads have no such problem, and every pixel here is
// computed anyway — there is nothing for a canvas to do. The noise, the Sobel
// and the sRGB handling follow materials.js exactly.
//
// WHY NOT TRIPLANAR
// PlaneGeometry has real uvs and the ground is a heightfield, so the layers are
// sampled from world XZ (equivalent to the uv, but at a tile size in METRES
// that does not change when a caller asks for a 2600 m mesh instead of a 900 m
// one). Only the rock layer pays for a second, slope-projected sample, and only
// at high quality, because that is the one layer that ever sits on a face steep
// enough for a top-down projection to smear.

const GROUND_TEX = { low: 128, medium: 256, high: 512 };
const MACRO_TEX = { low: 64, medium: 128, high: 192 };

// Mesh density. 130 segments over 900 m was 6.92 m per quad — coarse enough
// that the facets themselves were the dominant surface detail. The audit says
// the world half of a battle is 8 draw calls for 71,400 triangles and the GPU
// is idling, so triangles are the cheapest thing available to spend. The cap
// keeps the 2600 m air map from running away with it.
const SEG_MUL = { low: 1, medium: 1.45, high: 2 };
const SEG_CAP = { low: 200, medium: 270, high: 340 };

// Metres per texture tile, per layer. Deliberately mutually irrational-ish so
// two layers never repeat on the same beat.
const LAYER_TILE = { grass: 5.5, sand: 6.7, snow: 7.3, soil: 4.1, rock: 7.9 };
// Normal-map strength per layer: how deep the Sobel cuts the height field.
const LAYER_RELIEF = { grass: 2.4, sand: 2.0, snow: 1.5, soil: 2.9, rock: 3.4 };
const MACRO_TILE = 205;   // metres per macro-variation tile

function tier() {
  try {
    const q = getMaterialQuality();
    if (q === 'low' || q === 'medium' || q === 'high') return q;
  } catch { /* materials.js not initialised yet */ }
  return 'high';
}

// ---------------------------------------------------------------------------
// deterministic noise (equivalents of the private helpers in core/materials.js,
// which does not export them)

function ghash(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 1274126177;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

function gsmooth(t) {
  return t * t * (3 - 2 * t);
}

// period > 0 wraps the lattice itself: the last cell of a tile must
// interpolate toward lattice point 0, not toward point `period`, or every
// tile edge is a visible seam (measured: 8-18x the step between neighbouring
// texels, a grid of lines every 5.5 m of grass and every 205 m of macro).
function gvalue(x, y, seed, period = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = gsmooth(xf);
  const v = gsmooth(yf);
  let x1 = xi + 1;
  let y1 = yi + 1;
  if (period > 0) {
    if (x1 >= period) x1 -= period;
    if (y1 >= period) y1 -= period;
  }
  const a = ghash(xi, yi, seed);
  const b = ghash(x1, yi, seed);
  const c = ghash(xi, y1, seed);
  const d = ghash(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// Tileable fbm: pass coordinates that run 0..period across the texture and the
// lattice wraps, so the map has no seam when it repeats every few metres.
function gfbm(x, y, seed, octaves, period) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    const p = period * freq;
    sum += amp * gvalue(((x * freq) % p + p) % p, ((y * freq) % p + p) % p, seed + o * 97, p);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

// ---------------------------------------------------------------------------
// texture plumbing

// core/materials.js keeps the renderer's real limit to itself, and this module
// has no renderer to ask. Requesting more than the hardware has is safe: the
// renderer clamps it to getMaxAnisotropy() when it uploads.
const GROUND_ANISO = 8;

function dataTex(bytes, size, srgb) {
  const t = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  // The ground is seen at every angle from a metre away to two kilometres out;
  // without anisotropy the far half of the screen is mush. The renderer clamps
  // this to whatever it actually supports.
  t.anisotropy = GROUND_ANISO;
  // Albedo is authored as sRGB (the alpha rides along untouched, which is what
  // lets the roughness live in it); normals are raw data and must not decode.
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// Sobel a height field into a tangent-space normal map, wrapping at the edges
// so the normals tile with the albedo. Same sign convention as materials.js:
// nx = -dH/du, ny = -dH/dv, which with flipY = false is the OpenGL convention
// three's tangent frames expect.
function normalTex(height, size, strength) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const y0 = ((y - 1) + size) % size;
    const y1 = (y + 1) % size;
    const rowM = y0 * size;
    const rowC = y * size;
    const rowP = y1 * size;
    for (let x = 0; x < size; x++) {
      const x0 = ((x - 1) + size) % size;
      const x1 = (x + 1) % size;
      const dx =
        height[rowM + x0] + 2 * height[rowC + x0] + height[rowP + x0] -
        (height[rowM + x1] + 2 * height[rowC + x1] + height[rowP + x1]);
      const dy =
        height[rowM + x0] + 2 * height[rowM + x] + height[rowM + x1] -
        (height[rowP + x0] + 2 * height[rowP + x] + height[rowP + x1]);
      const nx = dx * strength;
      const ny = dy * strength;
      const len = Math.sqrt(nx * nx + ny * ny + 1) || 1;
      const i = (rowC + x) * 4;
      out[i] = (nx / len * 0.5 + 0.5) * 255;
      out[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      out[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return dataTex(out, size, false);
}

// ---------------------------------------------------------------------------
// the layer painters
//
// One pass fills albedo (rgb), roughness (a) and the height field the normal
// map is Sobelled from, because on real ground the three are the same fact: a
// pebble is lighter, higher and rougher than the mud it sits in.
//
// The albedo of every layer is normalised by its own mean at sample time (see
// the shader), so what survives is the RELATIVE variation — the tuft against
// the soil under it — while the actual colour of the ground comes from the
// preset: the cover's from the per-vertex palette, soil / rock / track from
// per-material uniforms, crops from the land-use colours. That is what lets
// one grass texture serve a green meadow, a bleached one and a snow-dusted one.

function paintLayer(kind, size, seed) {
  const alb = new Uint8Array(size * size * 4);
  const hgt = new Float32Array(size * size);
  let mr = 0;
  let mg = 0;
  let mb = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let r;
      let g;
      let b;
      let h;
      let rough;

      if (kind === 'grass') {
        // blades at the finest scale, clumps of taller growth over them, and
        // broad patches where the sward has gone over to straw
        const blade = gfbm(u * 48, v * 48, seed, 3, 48);
        const clump = gfbm(u * 8, v * 8, seed + 13, 4, 8);
        const dry = gfbm(u * 3, v * 3, seed + 51, 3, 3);
        const lum = 0.40 + clump * 0.30 + (blade - 0.5) * 0.34;
        r = lum * (0.90 + dry * 0.34);
        g = lum * (1.06 - dry * 0.10);
        b = lum * (0.70 + dry * 0.14);
        h = blade * 0.62 + clump * 0.38;
        rough = 0.88 + (blade - 0.5) * 0.10;
      } else if (kind === 'sand') {
        // wind ripples, dragged out of line by a low-frequency drift so they
        // do not read as corduroy
        const drift = gfbm(u * 5, v * 5, seed + 29, 3, 5);
        const grain = gfbm(u * 64, v * 64, seed + 3, 2, 64);
        const ripple = 0.5 + 0.5 * Math.sin((u * 18 + drift * 2.6) * Math.PI * 2);
        const lum = 0.60 + ripple * 0.13 + drift * 0.14 + (grain - 0.5) * 0.10;
        r = lum * 1.05;
        g = lum * 1.00;
        b = lum * 0.88;
        h = ripple * 0.55 + drift * 0.30 + grain * 0.15;
        rough = 0.74 + (grain - 0.5) * 0.14;
      } else if (kind === 'snow') {
        // drifts, a wind crust over them, and the odd facet catching the sun —
        // the sparkle is what stops snow reading as white cardboard
        const drift = gfbm(u * 6, v * 6, seed, 4, 6);
        const crust = gfbm(u * 30, v * 30, seed + 17, 3, 30);
        const spark = ghash(x, y, seed + 91) > 0.986 ? 1 : 0;
        const lum = 0.78 + drift * 0.15 + (crust - 0.5) * 0.07 + spark * 0.14;
        r = lum * 0.99;
        g = lum * 1.00;
        b = lum * 1.04;
        h = drift * 0.78 + crust * 0.22;
        rough = 0.54 + (crust - 0.5) * 0.16 - spark * 0.30;
      } else if (kind === 'rock') {
        // ridged noise gives creases instead of blobs, and a crease is the only
        // thing that makes stone read as fractured rather than lumpy
        const base = gfbm(u * 10, v * 10, seed, 4, 10);
        const ridge = 1 - Math.abs(gfbm(u * 6, v * 6, seed + 37, 3, 6) * 2 - 1);
        const grit = gfbm(u * 52, v * 52, seed + 5, 2, 52);
        const fissure = clamp01((ridge - 0.74) * 3.6);
        const lum = 0.52 + base * 0.26 + (grit - 0.5) * 0.16 - fissure * 0.30;
        r = lum * 1.02;
        g = lum * 1.00;
        b = lum * 0.96;
        h = base * 0.52 + grit * 0.18 + (1 - fissure) * 0.30;
        rough = 0.80 + fissure * 0.16 - (grit - 0.5) * 0.10;
      } else {
        // soil: clods, a scatter of pebbles, and the washed-out patches a
        // wheel leaves. This layer doubles as the road surface.
        const clod = gfbm(u * 16, v * 16, seed, 4, 16);
        const peb = gfbm(u * 40, v * 40, seed + 23, 2, 40);
        const wash = gfbm(u * 4, v * 4, seed + 61, 3, 4);
        const stone = clamp01((peb - 0.70) * 4.0);
        const lum = 0.42 + clod * 0.24 + wash * 0.16 + (peb - 0.5) * 0.14 + stone * 0.12;
        r = lum * 1.06;
        g = lum * 0.99;
        b = lum * 0.88;
        h = clod * 0.48 + peb * 0.34 + stone * 0.18;
        rough = 0.94 - stone * 0.16 + (clod - 0.5) * 0.08;
      }

      r = clamp01(r);
      g = clamp01(g);
      b = clamp01(b);
      const i = (y * size + x) * 4;
      alb[i] = r * 255;
      alb[i + 1] = g * 255;
      alb[i + 2] = b * 255;
      alb[i + 3] = clamp01(rough) * 255;
      hgt[y * size + x] = clamp01(h);
      mr += srgbToLinear(r);
      mg += srgbToLinear(g);
      mb += srgbToLinear(b);
    }
  }

  const n = size * size;
  return {
    map: dataTex(alb, size, true),
    normalMap: normalTex(hgt, size, LAYER_RELIEF[kind] ?? 2.5),
    // the mean the shader divides by, in the LINEAR space the sampler returns
    mean: new THREE.Vector3(
      Math.max(mr / n, 1e-3), Math.max(mg / n, 1e-3), Math.max(mb / n, 1e-3),
    ),
  };
}

// The macro variation map: the same idea as the layers but two hundred metres
// per tile instead of five. Multiplied into the detail, it is the difference
// between "textured" and "convincing" — the eye finds a five-metre repeat in
// about a second, and cannot find one that only closes every two hundred.
function paintMacro(size) {
  const px = new Uint8Array(size * size * 4);
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const broad = gfbm(u * 3, v * 3, 1301, 4, 3);
      const patch = gfbm(u * 9, v * 9, 907, 3, 9);
      const lum = 0.34 + broad * 0.46 + patch * 0.22;
      // decorrelated channels: the variation shifts hue as well as brightness,
      // which is what a real field does as the soil and the damp change
      const r = clamp01(lum * (0.94 + patch * 0.16));
      const g = clamp01(lum * (1.00 + (broad - 0.5) * 0.10));
      const b = clamp01(lum * (0.92 + (1 - patch) * 0.14));
      const i = (y * size + x) * 4;
      px[i] = r * 255;
      px[i + 1] = g * 255;
      px[i + 2] = b * 255;
      px[i + 3] = 255;
      mr += srgbToLinear(r);
      mg += srgbToLinear(g);
      mb += srgbToLinear(b);
    }
  }
  const n = size * size;
  return {
    map: dataTex(px, size, true),
    mean: new THREE.Vector3(
      Math.max(mr / n, 1e-3), Math.max(mg / n, 1e-3), Math.max(mb / n, 1e-3),
    ),
  };
}

// Painting five hundred thousand pixels of fbm is a load-time cost, not a
// per-frame one, but it is not one to pay twice. Battles are torn down and
// rebuilt all session and every one of them wants the same soil and the same
// rock, so the layers outlive the mesh that used them. Materials do not:
// battle.dispose() traverses the scene and disposes every material it finds,
// and Material.dispose() does not touch textures, so a shared texture is the
// only thing here that can safely survive a teardown.
const layerCache = new Map();
const macroCache = new Map();

// A stable seed per layer kind, so the same soil comes back every battle and
// the same rock every map — a ground that reshuffled its grain on reload would
// be one more thing the eye notices and cannot name.
function kindSeed(kind) {
  let h = 2166136261;
  for (let i = 0; i < kind.length; i++) {
    h ^= kind.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100000;
}

function layerSet(kind, size) {
  const key = `${kind}|${size}`;
  let s = layerCache.get(key);
  if (!s) {
    s = paintLayer(kind, size, kindSeed(kind));
    layerCache.set(key, s);
  }
  return s;
}

function macroSet(size) {
  let m = macroCache.get(size);
  if (!m) {
    m = paintMacro(size);
    macroCache.set(size, m);
  }
  return m;
}

// Hand every ground texture back. Nothing calls this in a normal session — the
// caches are meant to survive battles — but a full teardown should, exactly as
// disposeMaterials() does for the vehicles. Do not call it while a terrain mesh
// is still in a scene: its material is still holding these.
export function disposeTerrainTextures() {
  for (const s of layerCache.values()) {
    s.map.dispose();
    s.normalMap.dispose();
  }
  layerCache.clear();
  for (const m of macroCache.values()) m.map.dispose();
  macroCache.clear();
  // and the photo arrays of every biome (a ground still drawn takes its own
  // back on its next frame, see photoGen)
  try { releaseTerrainExcept(null); } catch { /* assets module unavailable */ }
  heldArrays.clear();
  photoGen++;
}

// ---------------------------------------------------------------------------
// the blend shader
//
// This is MeshStandardMaterial with four includes rewritten, NOT a
// ShaderMaterial: three's lighting, shadows, fog and tone mapping are all
// things the ground needs and none of them are worth reimplementing. All the
// sampling happens at the <map_fragment> site and is stashed in globals, so the
// roughness and normal sites downstream cost nothing but arithmetic.

const VERT_HEAD = `#include <common>
  attribute vec4 aSurf;
  varying vec4 vSurf;
  varying vec3 vTerrPos;
  varying vec3 vTerrNrm;`;

const VERT_BODY = `#include <begin_vertex>
  vSurf = aSurf;
  vTerrPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  // (wave 3c NaN fix) computeVertexNormals leaves a vertex whose triangles
  // are all degenerate at (0,0,0), and normalize(0) is NaN on every fragment
  // of every triangle touching it: such a vertex faces up instead
  vec3 ssTerrN = mat3(modelMatrix) * objectNormal;
  float ssTerrL2 = dot(ssTerrN, ssTerrN);
  vTerrNrm = ssTerrL2 > 1e-12 ? ssTerrN * inversesqrt(ssTerrL2) : vec3(0.0, 1.0, 0.0);`;

// LANDUSE_GLSL (world/landuse.js) rides in the head: it declares the six uLu*
// uniforms and defines luParcel() / luWood(), the GPU twins of the parcel and
// wood maps the scenery plants hedges and trees on. Nothing below redeclares
// any of them, and every name this file adds is prefixed terr / gTerr / uTerr
// or is one of the u* uniforms listed here, so the two never collide.
// P-04: the parcel hashes from a table. luParcel spends most of its time in
// four luHash chains (twelve exact-integer mods each) whose inputs are only
// ever a parcel's (column, row) or its row; parcelHashTable precomputes them
// for every parcel the mesh can show, in the same integer-exact arithmetic,
// so a fetch returns the very value the chain would. Outside the table (or
// if landuse.js ever renames what this patch hooks) the chain runs as before.
const LU_HASH_GLSL = `
  uniform highp sampler2D uTerrLuHash;  // RGBA32F: (ch 0, ch 2, ch 3, the row's offset hash)
  uniform vec4 uTerrLuHashBox;          // (first column, first row, columns, rows)
  float luHash(float a, float b, float ch) {
    // one exit and an initialised result (HLSL warns X4000 otherwise)
    float r = 0.0;
    bool rowOff = b == 1511.0 && ch == 1.0;
    vec2 t = (rowOff ? vec2(uTerrLuHashBox.x, a) : vec2(a, b)) - uTerrLuHashBox.xy;
    if ((rowOff || ch == 0.0 || ch == 2.0 || ch == 3.0)
        && t.x >= 0.0 && t.y >= 0.0 && t.x < uTerrLuHashBox.z && t.y < uTerrLuHashBox.w) {
      vec4 v = texelFetch(uTerrLuHash, ivec2(t), 0);
      r = rowOff ? v.a : (ch == 0.0 ? v.r : (ch == 2.0 ? v.g : v.b));
    } else {
      r = luHashCalc(a, b, ch);
    }
    return r;
  }
  float luBound(`;
const LANDUSE_FAST = (() => {
  const a = 'float luHash(float a, float b, float ch) {';
  const b = 'float luBound(';
  if (LANDUSE_GLSL.split(a).length !== 2 || LANDUSE_GLSL.split(b).length !== 2) return null;
  return LANDUSE_GLSL.replace(a, 'float luHashCalc(float a, float b, float ch) {').replace(b, LU_HASH_GLSL.trim());
})();

const FRAG_HEAD = `#include <common>
${LANDUSE_FAST || LANDUSE_GLSL}
  uniform sampler2D uTerrWoodMask; // P-04: 1 where some wood capsule may reach (woodMask)
  uniform vec4 uTerrWoodBox;       // its world box: (min x, min z, 1 / width, 1 / depth)
  uniform sampler2D uCoverMap;
  uniform sampler2D uCoverNrm;
  uniform sampler2D uSoilMap;
  uniform sampler2D uSoilNrm;
  uniform sampler2D uRockMap;
  uniform sampler2D uRockNrm;
  uniform sampler2D uMacroMap;
  uniform vec3 uCoverMean;
  uniform vec3 uSoilMean;
  uniform vec3 uRockMean;
  uniform vec3 uMacroMean;
  uniform vec4 uTile;          // 1 / metres-per-tile: cover, soil, rock, macro
  uniform vec2 uTerrNormalScale;
  uniform float uMacroAmt;
  uniform vec4 uRoadSeg[4];    // road centreline segments (ax, az, bx, bz), world
  uniform vec3 uCoverCol;      // linear cover colour of a plain pasture vertex (the crop tints' base)
  uniform vec3 uSoilCol;       // linear albedo of bare earth (plough, banks, hollows)
  uniform vec3 uRockCol;       // linear albedo of the rock layer
  uniform vec3 uTrackCol;      // linear albedo of the packed road / village earth
  uniform vec2 uSnow;          // x = fresh snow cover 0..1, y = 1 when the biome's ground IS snow
  uniform sampler2DArray uTerrC;   // photo albedo detail (sRGB; linear mean 0.5 per channel)
  uniform sampler2DArray uTerrN;   // photo (normal X, normal Y, roughness, height)
  uniform vec4 uPSlot[9];      // per photo slot: layer, 1 / tile metres, roughness bias, normal strength
  uniform vec4 uPSlotX[9];     // per photo slot, from its scan: x = albedo contrast (1 = as scanned),
                               // y = 1 if directional (half turns only), zw = its frame (cos, sin)
  uniform vec4 uPSlotM[9];     // per photo slot, from its scan: xy = the scan's mean normal tilt (taken
                               // out), z = its calibrated mean roughness (the far value), w unused
  uniform vec4 uPhoto;         // x = photo share 0..1, y = height-blend exponent, z / w = snow over soil / track
  uniform vec4 uPFade;         // photo detail fade: albedo from x to y metres, normals from z to w
  uniform vec4 uPTile;         // anti-tiling: x = 1 every base scan / 0.5 the cover only / 0 off,
                               // y = patch-noise cells per tile, z / w = footprint fade (tiles per pixel)
  uniform vec4 uPBand;         // anti-tiling bands: x = bands per unit of patch noise, y = seam half-width
                               // (bands), z = seam height-blend exponent
  varying vec4 vSurf;
  varying vec3 vTerrPos;
  varying vec3 vTerrNrm;

  float gTerrRough = 1.0;
  vec3 gTerrMapN = vec3(0.0, 0.0, 1.0);
  vec3 gTerrMapNv = vec3(0.0);
  vec3 gTerrContour = vec3(0.0, 0.0, 1.0);
  // Photo detail left at this fragment's distance (set by FRAG_MAP before any
  // fetch): gPK albedo, height and roughness variation, gPKN the normals.
  // Beyond the fade (gPFar) nothing is fetched and every scan is its mean.
  float gPK = 1.0;
  float gPKN = 1.0;
  bool gPFar = false;

  // One photo layer at world point p, the sample frame turned by cs = (cos,
  // sin) and shifted by off (tiles). s, sx, sm are one slot's uPSlot, uPSlotX
  // and uPSlotM entries (picked by the caller with constant indices, A-06).
  // Out: d = albedo factor (mean 1, so the calibrated colour still decides the
  // tint), r = roughness, n = tangent normal turned back into the world frame
  // (x = world X, y = world Z), h = height (mean 0.5), each already faded
  // toward its mean by distance, so every blend downstream stays continuous
  // out to the fade and past it. textureGrad off the caller's world
  // derivatives, because these fetches sit inside weight branches, where
  // implicit derivatives are undefined.
  void terrPhoto(vec4 s, vec4 sx, vec4 sm, vec2 p, vec2 dx, vec2 dy, vec2 cs, vec2 off,
                 out vec3 d, out float r, out vec3 n, out float h) {
    if (gPFar) {
      d = vec3(1.0);
      r = sm.z;
      n = vec3(0.0, 0.0, 1.0);
      h = 0.5;
      return;
    }
    // the scan's own frame on top (a directional scan's: the map's wind)
    cs = vec2(cs.x * sx.z - cs.y * sx.w, cs.x * sx.w + cs.y * sx.z);
    mat2 rot = mat2(cs.x, cs.y, -cs.y, cs.x);       // R p = (c px - s py, s px + c py)
    vec3 uvw = vec3(rot * p * s.y + off, s.x);
    vec2 gx = rot * dx * s.y;
    vec2 gy = rot * dy * s.y;
    vec4 c = textureGrad(uTerrC, uvw, gx, gy);
    vec4 t = textureGrad(uTerrN, uvw, gx, gy);
    d = mix(vec3(1.0), c.rgb * 2.0, sx.x * gPK);
    r = mix(sm.z, clamp(t.b * 0.5 + s.z, 0.04, 1.0), gPK);
    // Less the scan's mean tilt: a capture shot on a slope (snow_02 leans 12
    // degrees) would light every snowfield from one side, and each turned copy
    // of the anti-tiling from another.
    vec2 xy = t.rg * 2.0 - 1.0 - sm.xy;
    float z = sqrt(max(1.0 - dot(xy, xy), 0.0));
    n = vec3((xy * rot) * (s.w * gPKN), z);         // xy * rot = R^T xy
    h = mix(0.5, t.a, gPK);
  }

  // Share of b in a two-way blend whose plain share is t, weighted by the
  // two heights: the higher texel wins the transition (mud settles between
  // the tufts, gravel shows at the road edge). k = 0 gives t back.
  float terrHB(float t, float ha, float hb, float k) {
    if (gPFar) return t;   // every height is 0.5 out there: the plain share, without the pows
    // (pow of a base <= 0 is undefined in GLSL: NaN on most GPUs)
    float a = (1.0 - t) * pow(max(ha + 0.5, 1e-3), k);
    float b = t * pow(max(hb + 0.5, 1e-3), k);
    return b / max(a + b, 1e-5);
  }

  // (wave 3c NaN fix) a unit vector that is never NaN: a zero or non-finite
  // input (a degenerate normal, a cancelled blend) gives the fallback f
  vec3 terrSafeN(vec3 v, vec3 f) {
    float l2 = dot(v, v);
    return l2 > 1e-12 && l2 < 1e30 ? v * inversesqrt(l2) : f;
  }

  void terrMix(float t, vec3 d2, float r2, vec3 n2, float h2,
               inout vec3 d, inout float r, inout vec3 n, inout float h) {
    d = mix(d, d2, t);
    r = mix(r, r2, t);
    n = mix(n, n2, t);
    h = mix(h, h2, t);
  }

  // Hash without sine (exact enough for the integer cell ids of a 7 km skirt)
  // and a smooth value noise over it.
  float terrHash(vec2 c) {
    vec3 q = fract(vec3(c.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float terrVNoise(vec2 x) {
    vec2 i = floor(x);
    vec2 f = x - i;
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(terrHash(i), terrHash(i + vec2(1.0, 0.0)), u.x),
               mix(terrHash(i + vec2(0.0, 1.0)), terrHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  // The patch field of the anti-tiling: two octaves of value noise on
  // lattices turned off the world axes (0.6 and 2.0 rad), so no patch edge
  // runs along a grid line and the patches read as drifts, not blocks, plus a
  // slow third (amplitude uPBand.w, a tenth of the frequency) that walks the
  // band numbers on across the map, so the same few bands do not come back
  // everywhere.
  float terrPatch(vec2 q) {
    vec2 a = vec2(0.8253356 * q.x - 0.5646425 * q.y, 0.5646425 * q.x + 0.8253356 * q.y);
    vec2 b = vec2(-0.4161468 * q.x - 0.9092974 * q.y, 0.9092974 * q.x - 0.4161468 * q.y) * 2.31;
    vec2 c = vec2(0.2588190 * q.x - 0.9659258 * q.y, 0.9659258 * q.x + 0.2588190 * q.y) * 0.1;
    return 0.68 * terrVNoise(a) + 0.32 * terrVNoise(b + vec2(5.3, 1.7))
         + uPBand.w * terrVNoise(c + vec2(9.1, 3.3));
  }

  // Band k's copy of a scan: turned (any angle; half turns only when keep is
  // set) and shifted by its own fraction of a tile. Returned as the combined
  // frame c (on top of cs) and the shift off.
  void terrBand(float k, float seed, float keep, vec2 cs, out vec2 c, out vec2 off) {
    float a = terrHash(vec2(k * 7.13 + seed * 1.37, seed * 3.71 + 1.9));
    float ang = keep > 0.5 ? floor(a * 2.0) * 3.14159265 : a * 6.2831853;
    vec2 cb = vec2(cos(ang), sin(ang));
    c = vec2(cs.x * cb.x - cs.y * cb.y, cs.x * cb.y + cs.y * cb.x);
    off = vec2(terrHash(vec2(k + 0.37, seed + 11.1)), terrHash(vec2(seed + 4.23, k + 9.41)));
  }

  // A scan with its repeat broken. A 1-2.7 m scan repeats every few metres,
  // and anything distinctive in it (a footprint in the snow, a clump, a crack)
  // lines up into a lattice the eye finds at once. The patch noise (uPTile.y
  // cells per tile) is cut into bands, uPBand.x to its unit, like contour
  // lines; every band shows its own copy of the scan — turned, and shifted by
  // its own fraction of a tile — so no lattice runs on for more than a band,
  // and a fragment is never nearer than one band edge: two fetches at most.
  // At the edge the height blend (uPBand.z) lets the taller texel win, so the
  // seam is a clod or tuft edge, not a cross-fade. The seam narrows to a hard
  // switch (one fetch) where a tile is down to a pixel or two (uPTile.zw) and
  // the mips have averaged the scan to its mean. keep = 1: half turns only
  // (scans with a direction: wind ripples, ploughed rows).
  void terrPhotoNT(vec4 s, vec4 sx, vec4 sm, vec2 p, vec2 dx, vec2 dy, vec2 cs, float keep, float seed,
                   out vec3 d, out float r, out vec3 n, out float h) {
    d = vec3(1.0);
    r = sm.z;
    n = vec3(0.0, 0.0, 1.0);
    h = 0.5;
    if (gPFar) return;
    // the cover scan from 0.25, every base scan from 0.75 (cover is seed 0)
    if (uPTile.x < (seed < 0.5 ? 0.25 : 0.75)) {
      terrPhoto(s, sx, sm, p, dx, dy, cs, vec2(0.0), d, r, n, h);
      return;
    }
    keep = max(keep, sx.y);
    float ft = min(length(dx), length(dy)) * s.y;
    float bw = max(uPBand.y * (1.0 - smoothstep(uPTile.z, uPTile.w, ft)), 0.002);
    // ripples and rows run on: their bands are twice as wide
    float cells = uPTile.y * (keep > 0.5 ? 0.5 : 1.0);
    float L = terrPatch(p * (s.y * cells) + vec2(seed * 17.31, seed * 5.13)) * uPBand.x - 0.5;
    float k = floor(L);
    float t = smoothstep(0.5 - bw, 0.5 + bw, L - k);
    vec2 c;
    vec2 off;
    if (t < 0.995) {
      terrBand(k, seed, keep, cs, c, off);
      terrPhoto(s, sx, sm, p, dx, dy, c, off, d, r, n, h);
    }
    if (t > 0.005) {
      vec3 d2;
      float r2;
      vec3 n2;
      float h2;
      terrBand(k + 1.0, seed, keep, cs, c, off);
      terrPhoto(s, sx, sm, p, dx, dy, c, off, d2, r2, n2, h2);
      terrMix(t < 0.995 ? terrHB(t, h, h2, uPBand.z) : 1.0, d2, r2, n2, h2, d, r, n, h);
    }
  }

  // Nearest point on the road polyline. Returns x = metres from the centreline,
  // y = metres along the road; n = the unit direction AWAY from the centreline
  // (the gradient of x). Everything across the road is a function of x alone,
  // never of a signed offset along one segment's normal: round the outside of
  // a bend the nearest point is the joint itself, and an offset measured along
  // either leg's normal there is up to 1/cos(bend) short of the true distance
  // (bends reach 57 degrees, which broke the outer rut by 1.9 m at the joint).
  // On distance, ruts and ditch sweep round the bend as concentric arcs.
  // Unused slots are parked 100 km away with zero length, so they never win
  // and never add to the arc length.
  //
  // y is NOT the nearest leg's arc length: on the inside of a bend the
  // nearest leg changes at the inner bisector, where the two feet lie
  // 2 x tan(bend / 2) apart along the road, and the slow width and rut
  // wobbles read that jump as a sideways jog (up to 6.7 cm in the ruts). Each
  // leg's arc length is weighted by exp(-(its distance - the nearest) / 1.5 m)
  // instead, which is continuous everywhere: off the inside of a bend it
  // blends the two legs over a few metres; round the outside both feet are
  // the joint itself, and in the last metres of a leg before it the blend is
  // a smooth pull towards the joint; along a straight leg the next one is too
  // far away to count. (Measured on a JS port over 70 bends: the inside rut
  // jog per cm went from 0.090 to 0.00045, a straight road's own 0.00037.)
  vec2 terrRoad(vec2 p, out vec2 n) {
    float best = 1e9;
    vec2 r = vec2(1e9, 0.0);
    n = vec2(1.0, 0.0);
    float cum = 0.0;
    for (int i = 0; i < 4; i++) {
      vec4 sg = uRoadSeg[i];
      vec2 ab = sg.zw - sg.xy;
      float l2 = dot(ab, ab);
      float len = sqrt(l2);
      float t = l2 > 1e-6 ? clamp(dot(p - sg.xy, ab) / l2, 0.0, 1.0) : 0.0;
      vec2 q = p - (sg.xy + ab * t);
      float d = length(q);
      if (d < best) {
        best = d;
        r = vec2(d, cum + t * len);
        n = d > 1e-4 ? q / d : (len > 1e-3 ? vec2(-ab.y, ab.x) / len : vec2(1.0, 0.0));
      }
      cum += len;
    }
    float wSum = 0.0;
    float ySum = 0.0;
    cum = 0.0;
    for (int i = 0; i < 4; i++) {
      vec4 sg = uRoadSeg[i];
      vec2 ab = sg.zw - sg.xy;
      float l2 = dot(ab, ab);
      float len = sqrt(l2);
      float t = l2 > 1e-6 ? clamp(dot(p - sg.xy, ab) / l2, 0.0, 1.0) : 0.0;
      float d = length(p - (sg.xy + ab * t));
      float wt = exp(max(best - d, -40.0) / 1.5);
      ySum += wt * (cum + t * len);
      wSum += wt;
      cum += len;
    }
    r.y = ySum / max(wSum, 1e-6);
    return r;
  }`;

// The ground's albedo is built here in full, per layer, and <color_fragment> is
// emptied (FRAG_COLOR): vColor is now the COVER layer's colour only, and soil,
// rock and track each bring their own (uSoilCol / uRockCol / uTrackCol). The old
// shader tinted every layer with one blended vertex colour, which was fine while
// "soil" meant "the khaki highland grass", but a ploughed field has to be brown
// earth right up to a crisp hedge line, and a vertex colour cannot draw a line.
//
// Order of business:
//   1. per-vertex weights (cover / soil / rock / graded track), re-split by the
//      macro map only where soil already is, so a pasture stays a pasture;
//   2. land use (T4): luParcel -> crop, margin, row angle; luWood -> wood floor.
//      Plough turns the cover into soil, stubble half-way;
//   3. the road (T3), analytic, so it is crisp at every mesh density: a 5-5.5 m
//      carriageway with four wheel ruts, a trampled verge, a damp ditch;
//   4. colours (with a per-enclosure grazed / hay cast on pasture), detail,
//      macro, crop rows — straight in the body of a field, following its edge
//      in the headland — and concentric hay swaths; then roughness and the
//      normal blend with the row, rut and ditch relief as tangent-space tilts.
// Everything with a sub-metre period is faded by its own screen-space footprint
// (fwidth), so rows and ruts melt into their average instead of shimmering.
const FRAG_MAP = `{
    vec3 gn = terrSafeN(vTerrNrm, vec3(0.0, 1.0, 0.0));
    vec2 p = vTerrPos.xz;
    // Screen derivatives of the world position, taken here in uniform control
    // flow: every photo fetch below is a textureGrad off these, which is what
    // lets those fetches sit inside the weight branches.
    vec2 pdx = dFdx(p);
    vec2 pdy = dFdy(p);
    float photo = uPhoto.x;

    // macro variation first: it steers the layer split as well as the colour,
    // so the boundary between cover and bare earth wanders instead of following
    // a clean contour line
    vec3 macro = texture2D(uMacroMap, p * uTile.w).rgb / uMacroMean;
    float snowK = clamp(uSnow.x * 1.25, 0.0, 1.0);   // fresh snow over everything
    float snowG = max(snowK, uSnow.y);                 // the ground itself is white

    vec4 w = vSurf;
    w /= max(w.x + w.y + w.z + w.w, 1e-3);
    float open = w.x + w.y;
    if (open > 1e-4) {
      // the macro map only moves a cover/soil boundary that exists: with no
      // soil at the vertices the most it can do is a few per cent
      float base = w.y / open;
      float f = clamp(base + (macro.g - 1.0) * 0.55 * min(1.0, base * 4.0 + 0.15), 0.0, 1.0);
      w.x = open * (1.0 - f);
      w.y = open * f;
    }

    // ---- land use ----------------------------------------------------------
    vec4 lu = luParcel(p);
    int crop = clamp(int(lu.y + 0.5), 0, 5);
    float field = step(lu.z, 900.0);                        // 999 = no parcel edge here
    // a 2-3 m margin is sub-pixel a few hundred metres out: fade it rather
    // than let it sparkle along every field edge to the horizon
    float margin = field * (1.0 - smoothstep(1.2, 3.0, lu.z)) * (1.0 - smoothstep(0.8, 2.5, fwidth(lu.z)));
    // P-04: luWood walks all 19 capsules; the conservative mask says where
    // any of them can reach, and everywhere else its answer is exactly 0
    vec2 woodUv = (p - uTerrWoodBox.xy) * uTerrWoodBox.zw;
    float woodHit = texture2D(uTerrWoodMask, clamp(woodUv, vec2(0.0), vec2(1.0))).r;
    bool woodIn = woodUv.x >= 0.0 && woodUv.y >= 0.0 && woodUv.x < 1.0 && woodUv.y < 1.0;
    float wood = 0.0;
    if (woodIn && woodHit > 0.5) wood = luWood(p);
    float cropSoil = crop == 3 ? 0.92 : (crop == 2 ? 0.15 : 0.0);
    cropSoil *= (1.0 - margin) * (1.0 - wood);
    float toSoil = w.x * cropSoil;
    w.x -= toSoil;
    w.y += toSoil;

    // ---- the road ------------------------------------------------------------
    vec2 rn;
    vec2 road = terrRoad(p, rn);
    // Half-width 2.5-2.75 m (a 5-5.5 m carriageway), wandering slowly along
    // the road and a little with the macro map; the soft edge and the
    // trampled verge beyond it carry the rest of the irregularity.
    float hw = 2.625 + 0.09 * sin(road.y * 0.045 + 1.3) + 0.035 * clamp((macro.r - 1.0) * 2.0, -1.0, 1.0);
    float carriage = 1.0 - smoothstep(hw - 0.3, hw + 0.25, road.x);
    float verge = (1.0 - smoothstep(hw + 1.1, hw + 1.9, road.x)) * (1.0 - carriage);
    float ditch = smoothstep(4.9, 5.4, road.x) * (1.0 - smoothstep(6.0, 6.7, road.x));
    float roadAA = 1.0 - smoothstep(0.15, 0.4, fwidth(road.x));
    // two lanes, a wheel track either side of each lane centre (+/-1.375 m)
    float ar = road.x + 0.07 * sin(road.y * 0.13 + 2.0);
    float rutA = exp(-pow2((ar - 0.525) / 0.21));
    float rutB = exp(-pow2((ar - 2.225) / 0.21));
    float rut = max(rutA, rutB) * carriage * roadAA;
    float puddle = rut * (1.0 - smoothstep(0.74, 0.93, macro.g)) * (1.0 - snowK);
    float roadT = max(carriage, verge * 0.5);
    w.xyz *= 1.0 - roadT;
    w.w = mix(w.w, 1.0, roadT);

    float wCover = w.x;
    float wSoil = w.y;
    float wTrack = w.w;           // track colour; soil texture (procedural) or its own scan (photo)
    float wRock = w.z;

    // ---- detail, per slot ------------------------------------------------------
    // d = albedo factor (mean 1), r = roughness, n = tangent-space normal
    // (x = world X, y = world Z). Two sources: the procedural layers (always
    // there) and the photo scans (once they have decoded); uPhoto.x fades from
    // the one to the other, and each source is only sampled while it shows.
    vec3 dC = vec3(1.0);
    vec3 dS = vec3(1.0);
    vec3 dT = vec3(1.0);
    vec3 dR = vec3(1.0);
    float rC = 1.0;
    float rS = 1.0;
    float rT = 1.0;
    float rR = 1.0;
    vec3 nC = vec3(0.0, 0.0, 1.0);
    vec3 nS = nC;
    vec3 nT = nC;
    vec3 nR = nC;
    vec3 nRv = vec3(0.0);         // slope-projected rock normal, contour frame, weighted

    float steep = 0.0;
    vec2 qV = vec2(0.0);
    vec2 qVdx = vec2(0.0);
    vec2 qVdy = vec2(0.0);
    #ifdef TERRAIN_SLOPE_PROJ
      // A top-down tiling stretches by 1/cos(slope); on the rock faces that is
      // enough to smear. Re-project those along the contour instead — u runs
      // across the face, v runs up it — and cross-fade by how steep it is. The
      // direction is only ill-defined where the ground is flat, and there the
      // fade has already gone to zero.
      steep = smoothstep(0.92, 0.62, gn.y);
      vec2 hn = gn.xz;
      float hl = length(hn);
      vec2 hd = hl > 1e-4 ? hn / hl : vec2(1.0, 0.0);
      gTerrContour = vec3(-hd.y, 0.0, hd.x);
      qV = vec2(dot(p, gTerrContour.xz), vTerrPos.y);
      qVdx = vec2(dot(pdx, gTerrContour.xz), dFdx(vTerrPos.y));
      qVdy = vec2(dot(pdy, gTerrContour.xz), dFdy(vTerrPos.y));
    #endif

    if (photo < 1.0) {
      vec2 uvC = p * uTile.x;
      vec2 uvS = p * uTile.y;
      vec2 uvR = p * uTile.z;
      vec4 aC = texture2D(uCoverMap, uvC);
      vec4 aS = texture2D(uSoilMap, uvS);
      vec4 aR = texture2D(uRockMap, uvR);
      vec3 gC = texture2D(uCoverNrm, uvC).xyz * 2.0 - 1.0;
      vec3 gS = texture2D(uSoilNrm, uvS).xyz * 2.0 - 1.0;
      vec3 gR = texture2D(uRockNrm, uvR).xyz * 2.0 - 1.0;

      // The cover is most of the screen, and one 5.5 m tile repeats where a
      // driver can count it. A second lookup of the same maps, 2.3x larger and
      // turned 0.6 rad, is averaged in; the average is pushed back out from the
      // mean by 1.3 so the blend does not wash the grass flat. The second normal
      // is rotated back from its own tile frame (u2 = R p) with R^T.
      vec2 uvC2 = vec2(p.x * 0.8253356 - p.y * 0.5646425, p.x * 0.5646425 + p.y * 0.8253356) * (uTile.x * 0.43);
      vec4 aC2 = texture2D(uCoverMap, uvC2);
      vec3 nC2 = texture2D(uCoverNrm, uvC2).xyz * 2.0 - 1.0;
      aC.rgb = uCoverMean + ((aC.rgb + aC2.rgb) * 0.5 - uCoverMean) * 1.3;
      aC.a = (aC.a + aC2.a) * 0.5;
      gC = vec3((gC.xy + vec2(0.8253356 * nC2.x + 0.5646425 * nC2.y, -0.5646425 * nC2.x + 0.8253356 * nC2.y)) * 0.65,
                (gC.z + nC2.z) * 0.5);
      #ifdef TERRAIN_SLOPE_PROJ
        vec2 uvV = qV * uTile.z;
        aR = mix(aR, texture2D(uRockMap, uvV), steep);
        nRv = (texture2D(uRockNrm, uvV).xyz * 2.0 - 1.0) * (wRock * steep);
      #endif
      dC = aC.rgb / uCoverMean;
      dS = aS.rgb / uSoilMean;
      dT = dS;
      dR = aR.rgb / uRockMean;
      rC = aC.a;
      rS = aS.a;
      rT = aS.a;
      rR = aR.a;
      nC = gC;
      nS = gS;
      nT = gS;
      nR = gR;
    }

    // ---- photo detail (core/assets.js texture arrays) ------------------------
    // One layer per role and biome (uPSlot: 0 cover, 1 soil, 2 rock, 3 track,
    // 4 wood floor, 5 straw for wheat and stubble, 6 mud, 7 snow, 8 margin
    // grass). The crop picks the cover layer outright, so a field edge is a
    // crisp change of scan at no extra cost; a second scan is fetched only in
    // the bands that blend two (margins, wood edges, damp, ruts, snow). Every
    // base scan goes through terrPhotoNT, which breaks its repeat. Each scan
    // fades to its mean with distance inside terrPhoto (gPK, gPKN): albedo 1,
    // height 0.5, its calibrated roughness. Beyond the fade nothing is fetched
    // at all (gPFar, the air battle's view), but the blends below still run on
    // those means, so the mud's and the snow's own roughness (and their glint
    // under a low sun) carry on across the fade ring instead of stepping to a
    // default there.
    if (photo > 0.0) {
      float camD = length(vTerrPos - cameraPosition);
      gPK = 1.0 - smoothstep(uPFade.x, uPFade.y, camD);
      gPKN = 1.0 - smoothstep(uPFade.z, uPFade.w, camD);
      gPFar = camD >= uPFade.y;
      float hbK = uPhoto.y;
      vec2 cs0 = vec2(1.0, 0.0);
      vec2 of0 = vec2(0.0);
      vec3 xd = vec3(1.0);
      float xr = 0.9;
      vec3 xn = vec3(0.0, 0.0, 1.0);
      float xh = 0.5;
      vec3 eC = vec3(1.0);
      float oC = 0.9;
      vec3 mC = vec3(0.0, 0.0, 1.0);
      float hC = 0.5;
      vec3 eS = eC;
      float oS = oC;
      vec3 mS = mC;
      float hS = hC;
      vec3 eT = eC;
      float oT = oC;
      vec3 mT = mC;
      float hT = hC;
      vec3 eR = eC;
      float oR = oC;
      vec3 mR = mC;
      float hR = hC;
      vec3 mRv = vec3(0.0);
      // the snow scan, once fetched (the cover IS the snow on a snow map, and
      // soil and track both want it again)
      bool haveSn = false;
      vec3 snD = vec3(1.0);
      float snR = 0.9;
      vec3 snN = vec3(0.0, 0.0, 1.0);
      float snH = 0.5;

      if (wCover > 0.002) {
        bool straw = crop == 1 || crop == 2;
        vec4 sCov = straw ? uPSlot[5] : uPSlot[0];
        vec4 xCov = straw ? uPSlotX[5] : uPSlotX[0];
        vec4 mCov = straw ? uPSlotM[5] : uPSlotM[0];
        terrPhotoNT(sCov, xCov, mCov, p, pdx, pdy, cs0, 0.0, 0.0, eC, oC, mC, hC);
        if (uPSlot[7].x == sCov.x) {
          haveSn = true;
          snD = eC;
          snR = oC;
          snN = mC;
          snH = hC;
        }
        // uncut margins: rank pasture grass round straw, and round dry steppe
        if (margin > 0.01 && uPSlot[8].x != sCov.x) {
          terrPhoto(uPSlot[8], uPSlotX[8], uPSlotM[8], p, pdx, pdy, cs0, of0, xd, xr, xn, xh);
          terrMix(terrHB(margin, hC, xh, hbK), xd, xr, xn, xh, eC, oC, mC, hC);
        }
        // wood floor: leaf or needle litter, thinly under snow
        float tWd = smoothstep(0.1, 0.9, wood) * (1.0 - 0.6 * snowG);
        if (tWd > 0.01 && uPSlot[4].x != sCov.x) {
          terrPhotoNT(uPSlot[4], uPSlotX[4], uPSlotM[4], p, pdx, pdy, cs0, 0.0, 4.0, xd, xr, xn, xh);
          terrMix(terrHB(tWd, hC, xh, hbK), xd, xr, xn, xh, eC, oC, mC, hC);
        }
      }
      if (wSoil > 0.002) {
        // In a sown or ploughed parcel the earth is turned along the rows:
        // the scan's own tine lines are laid along them (texture +v along
        // the rows, (cos w, sin w)), and the anti-tiling turns its copies
        // by half circles only, so the lines stay parallel. Elsewhere (banks,
        // slips) the copies go any way.
        bool rowed = (crop == 1 || crop == 2 || crop == 3) && field > 0.5;
        vec2 csS = rowed ? vec2(sin(lu.w), cos(lu.w)) : cs0;
        terrPhotoNT(uPSlot[1], uPSlotX[1], uPSlotM[1], p, pdx, pdy, csS, rowed ? 1.0 : 0.0, 1.0, eS, oS, mS, hS);
        // damp: the low, flat hollows terrainSurface gives its hollowType, and the ditch
        float tanG = sqrt(max(1.0 - gn.y * gn.y, 0.0)) / max(gn.y, 0.05);
        float tMud = max((1.0 - smoothstep(-8.5, -4.5, vTerrPos.y)) * (1.0 - smoothstep(0.07, 0.14, tanG)), ditch);
        if (tMud > 0.01 && uPSlot[6].x != uPSlot[1].x) {
          terrPhoto(uPSlot[6], uPSlotX[6], uPSlotM[6], p, pdx, pdy, cs0, of0, xd, xr, xn, xh);
          terrMix(terrHB(tMud, hS, xh, hbK), xd, xr, xn, xh, eS, oS, mS, hS);
        }
        // Snow lies in the hollows of the earth first and the tallest clods
        // break through. On a field it lies deeper and evener than on a
        // bank (it has nothing to slide off), so only where the wind has
        // thinned it (macro map) does the turned earth show at all.
        if (uPhoto.z > 0.0) {
          if (!haveSn) {
            terrPhotoNT(uPSlot[7], uPSlotX[7], uPSlotM[7], p, pdx, pdy, cs0, 0.0, 7.0, snD, snR, snN, snH);
            haveSn = true;
          }
          float thin = smoothstep(1.0, 1.2, macro.g);
          float sAmt = rowed ? min(0.97, uPhoto.z * mix(1.14, 0.9, thin)) : uPhoto.z;
          terrMix(terrHB(sAmt, hS, 1.0 - hS, 4.0), snD, snR, snN, snH, eS, oS, mS, hS);
        }
      }
      if (wTrack > 0.002) {
        if (haveSn && uPSlot[3].x == uPSlot[7].x) {
          eT = snD;
          oT = snR;
          mT = snN;
          hT = snH;
        } else {
          terrPhotoNT(uPSlot[3], uPSlotX[3], uPSlotM[3], p, pdx, pdy, cs0, 0.0, 3.0, eT, oT, mT, hT);
        }
        // the wheel tracks hold the wet: mud along the ruts, standing in the puddles
        float tMudT = clamp(rut * 0.45 + puddle, 0.0, 1.0);
        if (tMudT > 0.01 && uPSlot[6].x != uPSlot[3].x) {
          terrPhoto(uPSlot[6], uPSlotX[6], uPSlotM[6], p, pdx, pdy, cs0, of0, xd, xr, xn, xh);
          terrMix(terrHB(tMudT, hT, xh, hbK), xd, xr, xn, xh, eT, oT, mT, hT);
        }
        if (uPhoto.w > 0.0) {
          if (!haveSn) {
            terrPhotoNT(uPSlot[7], uPSlotX[7], uPSlotM[7], p, pdx, pdy, cs0, 0.0, 7.0, snD, snR, snN, snH);
            haveSn = true;
          }
          terrMix(terrHB(uPhoto.w, hT, 1.0 - hT, 4.0), snD, snR, snN, snH, eT, oT, mT, hT);
        }
      }
      if (wRock > 0.002) {
        terrPhotoNT(uPSlot[2], uPSlotX[2], uPSlotM[2], p, pdx, pdy, cs0, 0.0, 2.0, eR, oR, mR, hR);
        #ifdef TERRAIN_SLOPE_PROJ
          if (steep > 0.0) {
            terrPhoto(uPSlot[2], uPSlotX[2], uPSlotM[2], qV, qVdx, qVdy, cs0, of0, xd, xr, xn, xh);
            eR = mix(eR, xd, steep);
            oR = mix(oR, xr, steep);
            hR = mix(hR, xh, steep);
            mRv = xn;
          }
        #endif
      }

      // Height blend across the four slots, w (h + 0.5)^k, same total weight.
      // The heights arrive faded to 0.5 by distance (terrPhoto), so far out
      // this is the plain split, and the calibrated colour times the macro map
      // is all that is left: no tile to shimmer.
      float bC = wCover;
      float bS = wSoil;
      float bT = wTrack;
      float bR = wRock;
      if (!gPFar) {
        bC *= pow(max(hC + 0.5, 1e-3), hbK);
        bS *= pow(max(hS + 0.5, 1e-3), hbK);
        bT *= pow(max(hT + 0.5, 1e-3), hbK);
        bR *= pow(max(hR + 0.5, 1e-3), hbK);
      }
      float bN = (wCover + wSoil + wTrack + wRock) / max(bC + bS + bT + bR, 1e-5);

      dC = mix(dC, eC, photo);
      dS = mix(dS, eS, photo);
      dT = mix(dT, eT, photo);
      dR = mix(dR, eR, photo);
      rC = mix(rC, oC, photo);
      rS = mix(rS, oS, photo);
      rT = mix(rT, oT, photo);
      rR = mix(rR, oR, photo);
      nC = mix(nC, mC, photo);
      nS = mix(nS, mS, photo);
      nT = mix(nT, mT, photo);
      nR = mix(nR, mR, photo);
      nRv = mix(nRv, mRv * (bR * bN * steep), photo);
      wCover = mix(wCover, bC * bN, photo);
      wSoil = mix(wSoil, bS * bN, photo);
      wTrack = mix(wTrack, bT * bN, photo);
      wRock = mix(wRock, bR * bN, photo);
    }
    gTerrMapNv = nRv;

    // ---- layer colours -------------------------------------------------------
    // A crop's colour is its cropCols entry relative to pasture (cropCols[0]),
    // applied to the PLAIN pasture colour of this preset and hour (uCoverCol),
    // then scaled by how bright this vertex is next to plain pasture. Applying
    // the ratio to vColor itself would multiply the crop's chroma into the
    // vertex's own (olive hilltop tint, damp hollows) and turn stubble pink.
    // Pasture keeps vColor exactly. A +/-6% per-parcel cast keeps two wheat
    // fields side by side two fields; uncut margins are pasture grass, darker
    // and ranker; fresh snow and woods have no crop showing; on a snow biome
    // the margins only grey a little.
    float lumV = dot(vColor, vec3(0.2126, 0.7152, 0.0722));
    float bright = lumV / max(dot(uCoverCol, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
    // (picked with constant indices, A-06)
    vec3 cropC = crop == 1 ? uLuCrop[1] : (crop == 2 ? uLuCrop[2] : (crop == 3 ? uLuCrop[3]
               : (crop == 4 ? uLuCrop[4] : (crop == 5 ? uLuCrop[5] : uLuCrop[0]))));
    vec3 cropTint = uCoverCol * (cropC / max(uLuCrop[0], vec3(1e-4))) * bright;
    vec3 coverCol = mix(vColor, cropTint, (crop == 0 ? 0.0 : 1.0) * (1.0 - max(snowK, wood)));
    coverCol *= 1.0 + (lu.x - 0.5) * 0.12 * field;
    // Pasture is not one lawn. Every enclosure is grazed or shut up for hay on
    // its own calendar, and from the air that is what makes a bocage read as a
    // patchwork even where no crop is sown: a second parcel hash (h2) places
    // each pasture between closely grazed (darker, bluer) and standing hay
    // (lighter, yellower). The casts average to 1.0, so the calibrated pasture
    // luminance holds; the top quarter of the range is mown hay (see the rows).
    float h2 = fract(lu.x * 13.731 + 0.37);
    float pastK = field * (crop == 0 ? 1.0 : 0.0) * (1.0 - snowG) * (1.0 - wood);
    coverCol *= mix(vec3(1.0), mix(vec3(0.84, 0.90, 0.97), vec3(1.14, 1.10, 0.86), h2), pastK);
    coverCol = mix(coverCol, vColor * mix(vec3(0.80, 0.86, 0.74), vec3(0.94, 0.94, 0.93), snowG), margin);
    // wood floor: leaf and needle litter, two thirds as bright and brown
    float lumC = dot(coverCol, vec3(0.2126, 0.7152, 0.0722));
    coverCol = mix(coverCol, lumC * 0.64 * vec3(1.45, 0.95, 0.62), wood * 0.8 * (1.0 - 0.7 * snowG));
    // the ditch holds the damp: darker, ranker grass
    coverCol *= 1.0 - 0.2 * ditch * (1.0 - snowG);
    vec3 soilCol = uSoilCol * (1.0 + (lu.x - 0.5) * 0.12 * field);
    vec3 trackCol = uTrackCol * (1.0 - 0.3 * rut) * (1.0 - 0.4 * puddle);

    vec3 alb = coverCol * dC * wCover
             + soilCol * dS * wSoil
             + trackCol * dT * wTrack
             + uRockCol * dR * wRock;
    alb *= mix(vec3(1.0), macro, uMacroAmt);

    // ---- crop rows -------------------------------------------------------------
    // Drill rows (wheat, stubble: 0.25 m) or plough furrows (0.6 m) across the
    // parcel's row angle, plus a faint 2.9 m stripe for the passes of the
    // implement, which is what still reads from a few hundred metres up. The
    // phase is taken through fract() so float precision holds kilometres out;
    // the fade uses the unwrapped coordinate, whose derivative has no seams.
    float rowOn = (crop == 1 || crop == 2 || crop == 3) ? 1.0 : 0.0;
    rowOn *= field * (1.0 - margin) * (1.0 - wood) * (1.0 - roadT);
    float rowP = crop == 3 ? 0.6 : 0.25;
    vec2 across = vec2(-sin(lu.w), cos(lu.w));
    float q = dot(p, across);
    float rowPh = fract(q / rowP) * 6.2831853;
    float rowAA = 1.0 - smoothstep(0.2, 0.45, fwidth(q) / rowP);
    float passQ = q / 2.9 + 0.35 * sin(dot(p, vec2(across.y, -across.x)) * 0.013 + lu.x * 20.0);
    float passAA = 1.0 - smoothstep(0.2, 0.45, fwidth(passQ));
    // Headland. A team cannot turn a plough or a binder inside the hedge, so
    // the outer passes go round the field and the straight rows stop short of
    // it: out to headW the rows are contours of the edge distance lu.z, which
    // run parallel to every side and mitre at the corners exactly as a team
    // working round would. Trodden at every turn, the strip is a shade darker.
    float headW = crop == 3 ? 7.2 : 6.0;
    float headK = 1.0 - smoothstep(headW - 0.3, headW + 0.3, lu.z);
    float head = headK * rowOn;
    float fwZ = fwidth(lu.z);
    float rowPhH = fract(lu.z / rowP) * 6.2831853;
    float rowAAH = 1.0 - smoothstep(0.2, 0.45, fwZ / rowP);
    float passAAH = 1.0 - smoothstep(0.2, 0.45, fwZ / 2.9);
    float rowS = mix(sin(rowPh) * rowAA, sin(rowPhH) * rowAAH, headK);
    float passS = mix(sin(fract(passQ) * 6.2831853) * passAA, sin(fract(lu.z / 2.9) * 6.2831853) * passAAH, headK);
    // Snow covers a field smoothly: no drill or implement stripes and no trodden
    // headland show through it (they used to, faintly, on every snow map).
    alb *= 1.0 + ((0.08 * rowS + 0.04 * passS) * rowOn - 0.05 * head) * (1.0 - snowG);
    // Hay is mown the same way, round and round from the hedge in, and lies in
    // swaths a cutter-bar's width apart: concentric bands of drying grass,
    // lighter and yellower than the stubble between them.
    float mown = pastK * step(0.75, h2) * (1.0 - margin) * (1.0 - roadT);
    // Faded to its mean (0.273 = 35/128 for this profile), not to zero, so a
    // mown meadow keeps its tone where the swaths are too fine to draw.
    // (max: 0.5 + 0.5 sin() can land an ulp under 0, and pow() of that is NaN,
    // which the mix below would carry even where swathAA is 0)
    float swath = pow(max(0.5 + 0.5 * sin(fract(lu.z / 3.6) * 6.2831853), 0.0), 4.0);
    float swathAA = 1.0 - smoothstep(0.2, 0.45, fwZ / 3.6);
    swath = mix(0.2734375, swath, swathAA);
    alb *= vec3(1.0) + (swath * vec3(0.26, 0.18, 0.04) - 0.05) * mown;
    // C-01 for the scans: no ground darker than charcoal (Y 0.02) or brighter
    // than fresh snow (Y 0.85). A scan doubles the calibrated colour at its
    // bright texels, so the ceiling is a soft knee on luminance (from Y 0.72,
    // hue kept), not a per-channel clamp that would grey the snow and flatten
    // its bright half. The procedural layers keep their old 0..1 clamp.
    vec3 albP = alb;
    if (photo > 0.0) {
      float yA = dot(albP, vec3(0.2126, 0.7152, 0.0722));
      float yK = yA > 0.72 ? 0.72 + 0.13 * (1.0 - exp((0.72 - yA) / 0.13)) : max(yA, 0.02);
      albP = min(albP * (yK / max(yA, 1e-4)), vec3(1.0));
      // (wave 3c NaN fix) the procedural path clamps its albedo, which turns
      // a non-finite one into black on D3D; the knee above would carry it on
      // as NaN (Inf / Inf). A luminance that fails this test is not a colour.
      if (!(yA >= 0.0 && yA < 1e4)) albP = vec3(0.02);
    }
    diffuseColor.rgb *= mix(clamp(alb, vec3(0.0), vec3(1.0)), albP, photo);

    gTerrRough = (rC * wCover + rS * wSoil + rT * wTrack + rR * wRock)
               * mix(1.0, 0.86, wTrack)
               * mix(1.0, macro.g, 0.25);
    // standing water in the ruts where the macro map says the ground lies low
    gTerrRough = mix(gTerrRough, 0.15, puddle);

    // Weighted tangent-space normal blend. The z terms carry the layer weights
    // too, so the three (or four) contributions sum back to a unit-ish normal.
    gTerrMapN = nC * wCover + nS * wSoil + nT * wTrack + nR * (wRock * (1.0 - steep));

    // Relief the mesh does not have, as slope tilts (tangent x = world X,
    // tangent y = world Z, tilt = -grad h): furrow flanks across the rows,
    // 6 cm wheel ruts, a 25 cm ditch. Both road profiles are functions of the
    // distance road.x, whose gradient is rn.
    // In the headland the furrows run along the edge, so they tilt along the
    // world gradient of lu.z. luParcel gives the distance, not its direction;
    // the screen derivatives of lu.z and of the world position give both
    // (solve [dFdx(p); dFdy(p)] g = (dFdx(z), dFdy(z)), sign-corrected, then
    // normalised: |g| is ~1 anyway). Where the screen frame degenerates, at a
    // grazing horizon, g falls to zero, and the rows have long faded there.
    vec2 dPx = dFdx(p);
    vec2 dPy = dFdy(p);
    float dZx = dFdx(lu.z);
    float dZy = dFdy(lu.z);
    vec2 gZ = vec2(dZx * dPy.y - dZy * dPx.y, dZy * dPx.x - dZx * dPy.x) * sign(dPx.x * dPy.y - dPx.y * dPy.x);
    float gZl = length(gZ);
    gZ = gZl > 1e-9 ? gZ / gZl : vec2(0.0);
    // Under snow the drill rows are gone; a ploughed field keeps only a faint
    // swell of its furrows, and only where the wind has left the snow thin.
    float snowThin = smoothstep(1.0, 1.2, macro.g);
    float furrowAmp = crop == 3 ? mix(0.42, 0.06 * snowThin, snowG) : 0.15 * (1.0 - snowG);
    vec2 tilt = -mix(across * (rowAA * cos(rowPh)), gZ * (rowAAH * cos(rowPhH)), headK)
              * (furrowAmp * rowOn);
    float rutSlope = 0.06 * 2.0 / (0.21 * 0.21) * ((ar - 0.525) * rutA + (ar - 2.225) * rutB);
    tilt -= rn * (rutSlope * carriage * roadAA);
    float dd = clamp((road.x - 5.75) / 0.75, -1.0, 1.0);
    float ditchSlope = 4.0 * 0.25 * dd * (1.0 - dd * dd) / 0.75;
    tilt -= rn * (ditchSlope * (1.0 - 0.5 * snowK) * (1.0 - smoothstep(0.3, 0.8, fwidth(road.x))));
    gTerrMapN.xy = (gTerrMapN.xy + tilt) * (1.0 - 0.8 * puddle);
  }`;

// vColor has already been folded into the albedo above.
const FRAG_COLOR = `/* terrain: vertex colour applied per layer in <map_fragment> */`;

const FRAG_ROUGH = `float roughnessFactor = roughness * clamp(gTerrRough, 0.04, 1.0);`;

// The ground is sampled from world XZ, not from the uv attribute, so three's
// derivative tangent frame (which is built from the normal map's own uv) is not
// the frame these normals were authored in. Build the right one directly: it is
// a heightfield, so +u is world +X projected onto the surface and +v is world
// +Z, which is exactly how the Sobel above ran.
const FRAG_NORMAL = `{
    vec3 gn = terrSafeN(vTerrNrm, vec3(0.0, 1.0, 0.0));
    vec3 tT = vec3(1.0, 0.0, 0.0) - gn * gn.x;
    float tl = length(tT);
    tT = tl > 1e-4 ? tT / tl : vec3(0.0, 0.0, 1.0);
    vec3 tB = cross(tT, gn);
    vec3 wn = tT * (gTerrMapN.x * uTerrNormalScale.x)
            + tB * (gTerrMapN.y * uTerrNormalScale.y)
            + gn * gTerrMapN.z;
    #ifdef TERRAIN_SLOPE_PROJ
      vec3 vB = vec3(0.0, 1.0, 0.0) - gn * gn.y;
      float vl = length(vB);
      if (vl > 1e-3) {
        vB /= vl;
        wn += gTerrContour * (gTerrMapNv.x * uTerrNormalScale.x)
            + vB * (gTerrMapNv.y * uTerrNormalScale.y)
            + gn * gTerrMapNv.z;
      }
    #endif
    // (wave 3c NaN fix) the weighted blend can cancel to zero (every layer
    // weight ~0, the tilts opposed): the plain surface normal then
    wn = terrSafeN(wn, gn);
    normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
  }`;

// Which cover layer the biome is wearing. This follows terrainSurface exactly
// — the same 0.35 snow-cover threshold — so what the eye sees under the tracks
// is what the physics says it is driving on.
function coverKind(palette) {
  const snow = palette ? (palette.snowCover || 0) : 0;
  const ground = (palette && palette.groundType) || 'grass';
  if (snow > 0.35 || ground === 'snow') return 'snow';
  if (ground === 'sand') return 'sand';
  return 'grass';
}

// ---------------------------------------------------------------------------
// what the shader is told about the map

// Land use for this build. The caller's preset decides the biome (the hangar
// builds its stage from a composed preset it never makes active), the live
// layout decides the parcels. landUseFor memoises on exactly that pair, so the
// scenery asking for the same thing a moment later gets the same object — and
// a new battle, with a new features object, can never be handed the last one's.
function landUseUniforms(palette) {
  try {
    const lu = landUseFor(terrainFeatures(), palette || activePreset(), {
      terrainHeight, terrainSlope, roadDistanceAt,
    });
    if (lu && lu.uniforms) return lu.uniforms;
  } catch (err) {
    console.warn('terrain: land use unavailable, drawing plain pasture', err);
  }
  return neutralLandUse();
}

// P-04: a conservative raster of where luWood() can be non-zero, so the
// fragment shader runs its 19-capsule loop only near a wood. A cell is set
// when its centre lies within r + 2 m (luWood's outer edge) + the cell's
// half-diagonal + 1 m of any capsule, so no point in an unset cell, or
// outside the box, can be inside one: the skip changes no pixel. Capsule
// decoding mirrors LANDUSE_GLSL (slots 5..23: ax, az, r, packed b).
const WOOD_MASK_N = 128;
function buildWoodMask(slots) {
  const caps = [];
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  if (Array.isArray(slots)) {
    for (let i = 5; i < Math.min(24, slots.length); i++) {
      const c = slots[i];
      if (!c || !(c.z > 0)) continue;
      const bxp = Math.floor(c.w / 4096);
      const bx = bxp - 2048;
      const bz = c.w - bxp * 4096 - 2048;
      const reach = c.z + 2;
      caps.push([c.x, c.y, bx, bz, reach]);
      x0 = Math.min(x0, c.x - reach, bx - reach);
      z0 = Math.min(z0, c.y - reach, bz - reach);
      x1 = Math.max(x1, c.x + reach, bx + reach);
      z1 = Math.max(z1, c.y + reach, bz + reach);
    }
  }
  const n = WOOD_MASK_N;
  const data = new Uint8Array(n * n * 4);
  let box;
  if (!caps.length) {
    // nothing anywhere: a box no fragment is in
    box = new THREE.Vector4(1e7, 1e7, 1e-6, 1e-6);
  } else {
    x0 -= 4; z0 -= 4; x1 += 4; z1 += 4;
    const cw = (x1 - x0) / n;
    const cd = (z1 - z0) / n;
    const pad = 0.5 * Math.hypot(cw, cd) + 1;
    for (let j = 0; j < n; j++) {
      const pz = z0 + (j + 0.5) * cd;
      for (let i = 0; i < n; i++) {
        const px = x0 + (i + 0.5) * cw;
        let hit = false;
        for (const [ax, az, bx, bz, reach] of caps) {
          const ex = bx - ax;
          const ez = bz - az;
          const l2 = ex * ex + ez * ez;
          const t = l2 > 1e-6 ? Math.min(1, Math.max(0, ((px - ax) * ex + (pz - az) * ez) / l2)) : 0;
          if (Math.hypot(ax + ex * t - px, az + ez * t - pz) < reach + pad) {
            hit = true;
            break;
          }
        }
        if (hit) data[(j * n + i) * 4] = 255;
      }
    }
    box = new THREE.Vector4(x0, z0, 1 / (x1 - x0), 1 / (z1 - z0));
  }
  const texture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, box, cells: caps.length ? data.reduce((a, v, k) => a + (k % 4 === 0 && v ? 1 : 0), 0) : 0 };
}

// The JS side of LU_HASH_GLSL: landuse.js's integer-exact hash, operation for
// operation (every intermediate is an integer under 2^24, so float32 on the
// GPU and float64 here agree exactly).
const LU_P = 4091;
function luModJs(x) {
  let r = x - LU_P * Math.floor(x / LU_P);
  if (r >= LU_P) r -= LU_P;
  if (r < 0) r += LU_P;
  return r;
}
function luPermJs(x) {
  const y = luModJs(x * 1597 + 2111);
  return luModJs(luModJs(y * y) * y + 1);
}
function luHashJs(a, b, ch, s) {
  let h = luPermJs(luModJs(a + s));
  h = luPermJs(luModJs(h + b));
  return luPermJs(luModJs(h + ch));
}
// Every (column, row) luParcel can reach on a mesh `size` across: the layout
// frame is the world turned by uLuAngle (|u|, |v| <= the half-diagonal),
// warped by up to uLuWarp and shifted by up to a cell per row, and luParcel
// looks one column either side of the one it lands in.
function parcelHashTable(u, size) {
  const seed = u.uLuSeed ? u.uLuSeed.value : 0;
  const cell = u.uLuCell ? u.uLuCell.value : null;
  const warp = u.uLuWarp ? Math.abs(u.uLuWarp.value) : 0;
  const cw = cell && cell.x > 0 ? cell.x : 0;
  const cd = cell && cell.y > 0 ? cell.y : 0;
  let cols = 0;
  let rows = 0;
  let c0 = 0;
  let r0 = 0;
  if (cw > 0 && cd > 0 && Number.isFinite(seed) && Number.isInteger(seed)) {
    const R = (Math.max(1, size) / 2) * Math.SQRT2 + warp + 8;
    c0 = Math.floor(-R / cw) - 2;
    r0 = Math.floor(-R / cd) - 1;
    cols = Math.floor((R + cw) / cw) + 2 - c0 + 1;
    rows = Math.floor(R / cd) + 1 - r0 + 1;
    if (cols > 512 || rows > 512) cols = rows = 0;
  }
  const w = Math.max(1, cols);
  const h = Math.max(1, rows);
  const data = new Float32Array(w * h * 4);
  for (let j = 0; j < rows; j++) {
    const row = r0 + j;
    const off = luHashJs(row, 1511, 1, seed);
    for (let i = 0; i < cols; i++) {
      const col = c0 + i;
      const k = (j * w + i) * 4;
      data[k] = luHashJs(col, row, 0, seed);
      data[k + 1] = luHashJs(col, row, 2, seed);
      data[k + 2] = luHashJs(col, row, 3, seed);
      data[k + 3] = off;
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, box: new THREE.Vector4(c0, r0, cols, rows) };
}

// What luParcel / luWood read when there is no land use: crop threshold 0 at
// 4091 is LANDUSE_GLSL's own "no fields" switch (every fragment plain pasture,
// no edge), and capsules of radius 0 are skipped, so there is no wood either.
let neutralLu = null;
function neutralLandUse() {
  if (!neutralLu) {
    const wood = [];
    for (let i = 0; i < 24; i++) wood.push(new THREE.Vector4(0, 0, 0, 0));
    wood[0].set(4091, 4091, 4091, 4091);
    wood[1].set(4091, 75, 0, 0);
    const crop = [];
    for (let i = 0; i < 6; i++) crop.push(new THREE.Vector3(1, 1, 1));
    neutralLu = {
      uLuSeed: { value: 0 },
      uLuCell: { value: new THREE.Vector2(100, 100) },
      uLuAngle: { value: 0 },
      uLuWarp: { value: 0 },
      uLuCrop: { value: crop },
      uLuWood: { value: wood },
    };
  }
  return neutralLu;
}

// The road centreline for the shader, from the same world-space polyline the
// scenery and the land use read. Empty slots are parked far away, zero length.
function roadSegments() {
  const pts = terrainFeatures().road || [];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    out.push(a && b
      ? new THREE.Vector4(a.x, a.z, b.x, b.z)
      : new THREE.Vector4(1e5, 1e5, 1e5, 1e5));
  }
  return out;
}

// ---------------------------------------------------------------------------
// photo detail: the CC0 scans (core/assets.js, design/research-assets.md 4, 10.8)
//
// The scans are DETAIL only. Each colour map is mean-neutral (linear mean 0.5
// per channel), so the shader's albedo is still the calibrated colour of this
// preset and hour — vColor, uSoilCol, the crop tints — times 2 x the scan,
// exactly where it used to be times (procedural layer / its mean). One texture
// array per kind holds every layer the biome needs; a slot is a layer index
// plus its real tile size, so the shader never branches on the biome.
//
// The procedural layers stay: they are what the ground shows until the scans
// have decoded (and for good when they cannot load: headless, assets turned
// off, a fetch or decode failure). uPhoto.x cross-fades the two once both
// arrays report 'ready'; the program never recompiles, the arrays fill in
// place. A biome whose scans are partly missing keeps the procedural ground.

// Slots, in uPSlot order (FRAG_MAP reads them by these constant indices).
const PS_COVER = 0;
const PS_SOIL = 1;
const PS_ROCK = 2;
const PS_TRACK = 3;
const PS_FOREST = 4;
const PS_DRY = 5;      // straw: wheat and stubble parcels
const PS_MUD = 6;
const PS_SNOW = 7;
const PS_MARGIN = 8;   // rank pasture grass on field margins
const PS_COUNT = 9;

// Mean roughness each scan is pulled to: the ground's own calibrated values
// (the procedural layers' means), not the capture's (Grass001 measures 0.54:
// a lawn after rain). The scan keeps half of its own variation around it.
const PHOTO_ROUGH_ROLE = { cover: 0.88, soil: 0.94, rock: 0.8, track: 0.94, forestFloor: 0.9, mud: 0.45, snow: 0.62 };
const PHOTO_ROUGH_SET = { withered_grass: 0.86, Ground093C: 0.74, snow_02: 0.62, sandy_gravel_02: 0.86 };
// Normal strength per scan (1 = as scanned): powder snow reads lumpy at full depth.
const PHOTO_NRM_SET = { snow_02: 0.7 };
// Albedo contrast per scan (1 = as scanned). snow_02 was shot on a trodden
// patch: at full strength its prints and twigs pepper every snowfield with
// dark marks, two to the square metre.
const PHOTO_CONTRAST_SET = { snow_02: 0.45 };
// Directional scans: one orientation per map, never the anti-tiling turn.
// Ground093C's ripple crests run along its u axis, so its v axis is laid along
// the map's wind (preset.windDir, blowing along (cos, sin) in world x, z as
// groundcover.js reads it): crests across the wind, as sand ripples form.
const PHOTO_WIND_SET = { Ground093C: true };
const PHOTO_MAX_LAYERS = 8;   // layers an array may hold (terrainLayers() has 8 roles at most)
// Height-blend exponent per quality (0 = plain cross-fades).
const PHOTO_HB = { low: 0, medium: 3, high: 4 };
// Scan detail fades to its mean with distance: albedo 220 -> 1100 m, normals 140 -> 800 m.
const PHOTO_FADE = [220, 1100, 140, 800];
const PHOTO_FADE_MS = 1200;   // procedural -> photo cross-fade once the scans are in
// Anti-tiling (terrPhotoNT, uPTile): which scans (1 every base scan, 0.5 the
// cover only: the low tier, as the old macro-driven cover breaker ran at every
// quality), patch-noise cells per tile, and the footprint (tiles per pixel)
// over which the band seams narrow to a hard switch (one fetch).
const PHOTO_NT = { low: [0.5, 0.3, 0.3, 0.6], medium: [1, 0.3, 0.3, 0.6], high: [1, 0.3, 0.35, 0.7] };
// uPBand: bands per unit of patch noise, seam half-width (bands), seam
// height-blend exponent, amplitude of the slow octave. Modelled offline
// (wave3b terrain lane, sim.py): bands about a tile across, ~20 distinct
// copies in view, two fetches on 28 % of the ground; the same copy one tile
// on 35 % of the time (the old two-copy field: 69 %).
const PHOTO_BAND = [10, 0.15, 8, 1.5];

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// The scan biome for a preset: a composed preset names it; a raw MAP_PRESETS
// entry goes by the cover it wears, as shadeContext does.
function photoBiome(palette) {
  const b = palette && palette.biome;
  if (b === 'meadow' || b === 'steppe' || b === 'winter' || b === 'desert') return b;
  const byName = { Bocage: 'meadow', Steppe: 'steppe', Winter: 'winter', Desert: 'desert' };
  if (palette && byName[palette.name]) return byName[palette.name];
  const k = coverKind(palette);
  return k === 'sand' ? 'desert' : (k === 'snow' ? 'winter' : 'meadow');
}

// Straw-coloured scans (stubble, dry steppe grass) by id or label.
function isDryScan(id) {
  const s = id ? getAssetSet(id) : null;
  return !!s && /stubble|withered|dry/i.test(`${id} ${s.label || ''}`);
}

// Which array layer serves each slot for this preset, and the per-slot vec4
// (layer, 1 / tile metres, roughness bias, normal strength) the shader reads.
// Exported for the harness; the shader contract is the uPSlot order above.
export function photoSlotTable(palette = null) {
  const biome = photoBiome(palette);
  const L = terrainLayers(biome);
  const s = L.slot;
  const has = (i) => Number.isInteger(i) && i >= 0 && i < L.layers.length && i < PHOTO_MAX_LAYERS;
  let cover = has(s.cover) ? s.cover : 0;
  // Straw and margin grass: the biome's two cover scans, whichever is which.
  // Bocage: pasture grass is the cover, straw the alternate; steppe: the
  // reverse — its pasture is dry and its margins and ravines are green.
  let dry = cover;
  let margin = cover;
  if (has(s.coverAlt)) {
    if (isDryScan(L.layers[s.coverAlt]) && !isDryScan(L.layers[cover])) dry = s.coverAlt;
    else if (!isDryScan(L.layers[s.coverAlt]) && isDryScan(L.layers[cover])) margin = s.coverAlt;
  }
  const snow = has(s.snow) ? s.snow : -1;
  // under snow every grass is under it (the threshold terrainSurface uses)
  if (coverKind(palette) === 'snow' && snow >= 0) cover = dry = margin = snow;
  const soil = has(s.soil) ? s.soil : cover;
  const track = has(s.track) ? s.track : soil;
  const idx = new Array(PS_COUNT);
  idx[PS_COVER] = cover;
  idx[PS_SOIL] = soil;
  idx[PS_ROCK] = has(s.rock) ? s.rock : soil;
  idx[PS_TRACK] = track;
  idx[PS_FOREST] = has(s.forest) ? s.forest : cover;
  idx[PS_DRY] = dry;
  idx[PS_MUD] = has(s.mud) ? s.mud : soil;
  idx[PS_SNOW] = snow >= 0 ? snow : cover;
  idx[PS_MARGIN] = margin;
  // per array layer: albedo contrast, directional frame
  const wind = palette && Number.isFinite(palette.windDir) ? palette.windDir : 0;
  const layerParams = [];
  for (let i = 0; i < PHOTO_MAX_LAYERS; i++) {
    const id = L.layers[i];
    const dir = !!(id && PHOTO_WIND_SET[id]);
    // texture +v along (cos w, sin w): the frame R = (sin w, cos w), as for the crop rows
    layerParams.push({
      id: id || null,
      contrast: id ? (PHOTO_CONTRAST_SET[id] ?? 1) : 1,
      directional: dir,
      frame: dir ? [Math.sin(wind), Math.cos(wind)] : [1, 0],
    });
  }
  // Per slot, everything the shader needs about its scan (uPSlot, uPSlotX,
  // uPSlotM): the shader picks these with constant indices only (A-06), never
  // by the layer number it has just read.
  const slots = idx.map((i) => {
    const id = L.layers[i];
    const set = getAssetSet(id);
    const tile = assetTile(id) || 2;
    const target = PHOTO_ROUGH_SET[id] ?? PHOTO_ROUGH_ROLE[set && set.role] ?? 0.88;
    const mean = set && Number.isFinite(set.rough) ? set.rough : 0.75;
    const lp = layerParams[i];
    return {
      layer: i, id, tile, roughBias: target - 0.5 * mean, normal: PHOTO_NRM_SET[id] ?? 1,
      rough: target, contrast: lp.contrast, directional: lp.directional, frame: lp.frame,
    };
  });
  return { biome, layers: L.layers, slots, layerParams, snowLayer: snow, trackIsSnow: snow >= 0 && track === snow };
}

// The mean normal tilt (x, y) of every layer of a decoded normal array: a
// strided average of its unpacked (X, Y) bytes, once per array. null while
// the array is still the 4 x 4 placeholder.
const tiltOf = new WeakMap();
function arrayTilts(tex) {
  if (!tex) return null;
  if (tiltOf.has(tex)) return tiltOf.get(tex);
  const img = tex.image;
  const data = img && img.data;
  const W = img && img.width;
  const H = img && img.height;
  const N = img && img.depth;
  if (!data || !(W > 4) || !(H > 4) || !(N > 0) || data.length < W * H * N * 4) return null;
  const step = Math.max(1, Math.floor(Math.min(W, H) / 256));
  const out = [];
  for (let l = 0; l < N; l++) {
    const base = l * W * H * 4;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < H; y += step) {
      for (let x = 0, i = base + y * W * 4; x < W; x += step, i += step * 4) {
        sx += data[i];
        sy += data[i + 1];
        n++;
      }
    }
    out.push([(sx / n / 255) * 2 - 1, (sy / n / 255) * 2 - 1]);
  }
  tiltOf.set(tex, out);
  return out;
}

// Take each slot's scan tilt out (uPSlotM.xy) once its normal array is in.
function applyTilts(state, nTex) {
  const tilts = arrayTilts(nTex);
  const S = state.uniforms.uPSlot.value;
  const M = state.uniforms.uPSlotM.value;
  for (let i = 0; i < M.length; i++) {
    const t = tilts && tilts[Math.round(S[i].x)];
    M[i].x = t ? t[0] : 0;
    M[i].y = t ? t[1] : 0;
  }
}

// The arrays this module took, per biome and tier. releaseTerrainExcept()
// matches arrays by their layer names only, so after a quality change the
// same biome's other tier would stay resident beside the new one: freed here.
const heldArrays = new Map();   // `${biome}|${tier}` -> { biome, tier, c, n }
function takeArrays(biome, tierPx) {
  const a = buildTerrainArrays(biome, { tier: tierPx });
  heldArrays.set(`${biome}|${tierPx}`, { biome, tier: tierPx, c: a.c, n: a.n });
  return a;
}
function releaseOtherTiers(biome, tierPx) {
  for (const [k, e] of heldArrays) {
    if (e.biome === biome && e.tier === tierPx) continue;
    // other biomes' arrays are releaseTerrainExcept's to free (already done)
    if (e.biome === biome) {
      releaseAsset(e.c);
      releaseAsset(e.n);
    }
    heldArrays.delete(k);
  }
}

// Build (or reuse) the biome's arrays and the photo uniforms for one material.
// Returns { uniforms, state }; state.t0 is set when the cross-fade may start.
function photoSetup(palette, quality, S) {
  const table = photoSlotTable(palette);
  const tierPx = quality === 'high' ? 1024 : 512;
  let arrays = null;
  try {
    // only the current biome, at the current tier, stays resident (~39 MB of
    // GPU per 1024 array)
    releaseTerrainExcept(table.biome);
    releaseOtherTiers(table.biome, tierPx);
    photoGen++;
    arrays = takeArrays(table.biome, tierPx);
    // assets.js caches whatever it handed out, including the placeholders of a
    // build made while the scans were switched off, and an array whose fetch
    // failed: start those over (once per terrain build)
    const stale = (t) => ['placeholder', 'failed', 'partial'].includes(assetStatus(t));
    if (assetsEnabled() && (stale(arrays.c) || stale(arrays.n))) {
      releaseAsset(arrays.c);
      releaseAsset(arrays.n);
      photoGen++;
      arrays = takeArrays(table.biome, tierPx);
    }
  } catch (err) {
    console.warn('terrain: photo detail unavailable, keeping the procedural ground', err);
  }
  const snowG = Math.max(Math.min(1, S.snowCover * 1.25), S.snowGround);
  const photo = new THREE.Vector4(
    0,
    PHOTO_HB[quality] ?? 0,
    table.snowLayer >= 0 ? 0.85 * snowG : 0,
    table.snowLayer >= 0 && !table.trackIsSnow ? 0.5 * snowG : 0,
  );
  const uniforms = {
    uTerrC: { value: arrays ? arrays.c : null },
    uTerrN: { value: arrays ? arrays.n : null },
    uPSlot: { value: table.slots.map((t) => new THREE.Vector4(t.layer, 1 / t.tile, t.roughBias, t.normal)) },
    uPhoto: { value: photo },
    uPFade: { value: new THREE.Vector4(...PHOTO_FADE) },
    uPTile: { value: new THREE.Vector4(...(PHOTO_NT[quality] || PHOTO_NT.high)) },
    uPBand: { value: new THREE.Vector4(...PHOTO_BAND) },
    uPSlotX: { value: table.slots.map((t) => new THREE.Vector4(t.contrast, t.directional ? 1 : 0, t.frame[0], t.frame[1])) },
    // xy: the scan's mean tilt, filled in once the normal array has decoded (applyTilts)
    uPSlotM: { value: table.slots.map((t) => new THREE.Vector4(0, 0, t.rough, 0)) },
  };
  const state = { t0: null, biome: table.biome, tierPx, gen: photoGen, uniforms, token: null };
  if (arrays) watchArrays(state, arrays);
  return { uniforms, state };
}

// Bumped whenever this module frees terrain arrays (another biome's build,
// a stale retry, disposeTerrainTextures). A ground that is still alive — the
// hangar's stage, kept while a battle on another biome ran — notices on its
// next frame and takes its biome's arrays back from assets.js (photoReacquire)
// instead of drawing, and silently re-uploading, the freed ones.
let photoGen = 0;

// Point the fade at these arrays: photo on at once when they are already in,
// else procedural until both report 'ready', then the cross-fade.
function watchArrays(state, arrays) {
  const photo = state.uniforms.uPhoto.value;
  state.t0 = null;
  const token = {};
  state.token = token;
  applyTilts(state, null);
  if (!arrays.c || !arrays.n || !assetsEnabled()) { photo.x = 0; return; }
  const ready = () => assetStatus(arrays.c) === 'ready' && assetStatus(arrays.n) === 'ready';
  if (ready()) {
    // cached from an earlier battle: no fade, the scans are there from frame one
    applyTilts(state, arrays.n);
    photo.x = 1;
    return;
  }
  photo.x = 0;
  const gen = photoGen;
  arrays.ready.then(() => {
    if (state.token !== token) return;
    if (ready()) {
      applyTilts(state, arrays.n);
      state.t0 = nowMs();
    } else if (gen === photoGen) {
      // (not ready because another biome's build freed them mid-load — the
      // hangar's stage while a battle loads — is no failure: photoReacquire
      // takes them back on the next frame drawn)
      console.info(`terrain: ${state.biome} scans ${assetStatus(arrays.c)}/${assetStatus(arrays.n)}, keeping the procedural ground`);
    }
  }, () => { /* assetReady never rejects; nothing to do */ });
}

function photoReacquire(state) {
  state.gen = photoGen;
  let arrays = null;
  try { arrays = takeArrays(state.biome, state.tierPx); } catch { return; }
  const U = state.uniforms;
  if (arrays.c === U.uTerrC.value && arrays.n === U.uTerrN.value) return;
  // same sampler type and format: a new binding, never a new program
  U.uTerrC.value = arrays.c;
  U.uTerrN.value = arrays.n;
  watchArrays(state, arrays);
}

// material -> { state, uniform }. A WeakMap, not userData: Material.copy
// JSON-clones userData.
const photoOf = new WeakMap();

// onBeforeRender for the ground and its skirt: takes the arrays back if they
// were freed under it, runs the cross-fade, then costs two comparisons a frame.
function photoFader(state, u) {
  return () => {
    if (state.gen !== photoGen) photoReacquire(state);
    const v = u.value;
    if (state.t0 === null || v.x >= 1) return;
    v.x = Math.min(1, Math.max(0, (nowMs() - state.t0) / PHOTO_FADE_MS));
  };
}

function groundMaterial(palette, size, quality, S) {
  const cover = layerSet(coverKind(palette), GROUND_TEX[quality]);
  const soil = layerSet('soil', GROUND_TEX[quality]);
  const rock = layerSet('rock', GROUND_TEX[quality]);
  const macro = macroSet(MACRO_TEX[quality]);

  // Tiles grow a little on the very large meshes: the air map is 2600 m across
  // and a 5 m tile there is 520 repeats of pure minification.
  const ts = THREE.MathUtils.clamp(size / WORLD_SIZE, 1, 1.9);
  const slopeProj = quality === 'high';

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // the maps carry the roughness; this is the multiplier on top of them
    roughness: 1,
    metalness: 0,
  });
  if (slopeProj) mat.defines = { TERRAIN_SLOPE_PROJ: 1 };

  // Every uniform here is built for THIS call — this map's road, this preset's
  // colours, this layout's land use — and the material is never cached, so a
  // later battle can never inherit an earlier one's fields.
  const uniforms = {
    uCoverMap: { value: cover.map },
    uCoverNrm: { value: cover.normalMap },
    uSoilMap: { value: soil.map },
    uSoilNrm: { value: soil.normalMap },
    uRockMap: { value: rock.map },
    uRockNrm: { value: rock.normalMap },
    uMacroMap: { value: macro.map },
    uCoverMean: { value: cover.mean },
    uSoilMean: { value: soil.mean },
    uRockMean: { value: rock.mean },
    uMacroMean: { value: macro.mean },
    uTile: {
      value: new THREE.Vector4(
        1 / (LAYER_TILE[coverKind(palette)] * ts),
        1 / (LAYER_TILE.soil * ts),
        1 / (LAYER_TILE.rock * ts),
        1 / (MACRO_TILE * ts),
      ),
    },
    uTerrNormalScale: { value: new THREE.Vector2(1.0, 1.0) },
    uMacroAmt: { value: 0.75 },
    uRoadSeg: { value: roadSegments() },
    uCoverCol: { value: S.coverBase.clone() },
    uSoilCol: { value: S.soil.clone() },
    uRockCol: { value: S.rock.clone() },
    uTrackCol: { value: S.track.clone() },
    uSnow: { value: new THREE.Vector2(S.snowCover, S.snowGround) },
  };
  // All six land-use uniforms, as the very {value} objects landuse.js made:
  // slots 0-4 of uLuWood are a header luParcel reads (crop thresholds, cap,
  // town, road), so a partial copy would turn every fragment into orchard.
  Object.assign(uniforms, landUseUniforms(palette));
  const woodMask = buildWoodMask(uniforms.uLuWood && uniforms.uLuWood.value);
  uniforms.uTerrWoodMask = { value: woodMask.texture };
  uniforms.uTerrWoodBox = { value: woodMask.box };
  mat.addEventListener('dispose', () => woodMask.texture.dispose());
  const luHash = parcelHashTable(uniforms, size);
  uniforms.uTerrLuHash = { value: luHash.texture };
  uniforms.uTerrLuHashBox = { value: luHash.box };
  mat.addEventListener('dispose', () => luHash.texture.dispose());
  // The scans: arrays shared across battles (stamped by assets.js), uniforms
  // and fade state per material.
  const photo = photoSetup(palette, quality, S);
  Object.assign(uniforms, photo.uniforms);
  photoOf.set(mat, { state: photo.state, uniform: uniforms.uPhoto });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERT_HEAD)
      .replace('#include <begin_vertex>', VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', FRAG_HEAD)
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL);
    mat.userData.shader = shader;
  };
  // A patched program must never share a cache key with an unpatched one, and
  // three keys on this string.
  mat.customProgramCacheKey = () => `terrain|${slopeProj ? 1 : 0}`;
  return mat;
}

// ---------------------------------------------------------------------------
// per-vertex surfacing, shared by the mesh and its skirt
//
// Since the land-use wave the vertex colour is the COVER layer's colour only
// (grass / sand / snow, with the hour's tint the preset already applied), and
// aSurf carries the four layer weights (x cover, y soil, z rock, w graded
// track). Soil, rock and track colours are uniforms (see shadeContext), and the
// crops, the road and the field margins are drawn per fragment.
//
// T2: soil used to be driven by HEIGHT — every hilltop above about +6 m went
// khaki, a quarter of the meadow. Soil now comes only from what bares ground in
// a real field: slopes steep enough to slip (per biome, SLOPE_BARE, with rock
// taking over on the steepest faces), damp trodden hollows (the same
// low-and-flat test terrainSurface uses for its hollowType, never more than 40%
// bare), the village core, and — per fragment, so the edge is a crisp line —
// the plough.

// Where a slope starts to shed its turf: [tan where bare patches begin, tan
// where they are fully grown, the most of the vertex they take]. One rule for
// every biome (bare from tan 0.22, 12 degrees) turned the flanks of every
// ridge and knoll in the bocage into brown smudges — 15% of the meadow mesh is
// steeper than that, and from a tank the knolls read as spoil heaps. A grazed
// sward holds on anything a cow will walk up: in the bocage and under snow the
// bare patches start at about 21 degrees and never take more than half the
// ground (with the macro map that is worn, terraced patches, not a bald face).
// Steppe loess slumps into bare gully sides much sooner; desert slopes were
// bare to begin with, so it keeps the old rule.
const SLOPE_BARE = {
  meadow: [0.38, 0.7, 0.5],
  winter: [0.38, 0.7, 0.6],
  steppe: [0.26, 0.5, 0.75],
  desert: [0.22, 0.42, 0.9],
};

// The vertex road/village halo; the shader draws the road itself. 0.298 so
// that after 8-bit quantisation (76/255) it is still under the 30% cap.
const TRACK_VERTEX_MAX = 0.298;

function sstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function shadeContext(palette) {
  // composePreset tints low/high/rock with the hour and the snow; cropCols are
  // passed through raw, so a crop colour used as an albedo gets the same tint.
  const tod = palette && palette.tod;
  const snowCover = palette ? (palette.snowCover || 0) : 0;
  const tint = (hex) => {
    let h = hex;
    if (tod && typeof tod.groundTint === 'number') h = mixColor(h, tod.groundTint, tod.groundMix || 0);
    return snowCover > 0 ? mixColor(h, 0xe8eef4, snowCover * 0.55) : h;
  };
  // Bare earth is the biome's ploughland colour where it has one (cropCols[3]);
  // a biome without fields (desert: every crop colour equals pasture) falls
  // back to its `high` ground, which is what its bare patches always were.
  const cols = palette && Array.isArray(palette.cropCols) ? palette.cropCols : null;
  const soilHex = cols && typeof cols[3] === 'number' && cols[3] !== cols[0]
    ? tint(cols[3])
    : (palette ? palette.high : 0x67513d);
  const dustSet = (palette && palette.dust) || DEFAULT_DUST;
  const snowCol = new THREE.Color(0xeef4f9);
  const low = new THREE.Color(palette ? palette.low : 0x67894c);
  // a composed preset names its biome; a raw MAP_PRESETS entry does not, and
  // goes by the cover it wears (sand -> desert, snow -> winter, else bocage)
  const kind = coverKind(palette);
  const bare = (palette && SLOPE_BARE[palette.biome])
    || (kind === 'sand' ? SLOPE_BARE.desert : (kind === 'snow' ? SLOPE_BARE.winter : SLOPE_BARE.meadow));
  return {
    low,
    // what shadeVertex paints on flat, dry, low-lying pasture (no highland
    // tint, no damp): the base the shader's crop tints are measured from
    coverBase: low.clone().lerp(snowCol, snowCover * 0.8),
    high: new THREE.Color(palette ? palette.high : 0x8d8258),
    rock: new THREE.Color(palette ? palette.rock : 0x77776f),
    // fresh snow settles on the earth as it does on the grass; a road under
    // snow (or through a snow biome) is packed snow dirtied by the traffic
    soil: new THREE.Color(soilHex).lerp(snowCol, snowCover * 0.8),
    track: new THREE.Color(dustSet.dirt).multiplyScalar(0.72)
      .lerp(snowCol, Math.max(snowCover * 0.5, coverKind(palette) === 'snow' ? 0.45 : 0)),
    snowCol,
    snowCover,
    snowGround: coverKind(palette) === 'snow' ? 1 : 0,
    bare,           // SLOPE_BARE rule for this biome
    slopeSoil: 1,   // how much a steep face bares (paintTerrainSurface's turf)
    c: new THREE.Color(),
  };
}

function shadeVertex(S, x, z, y, ny, colors, surf, i) {
  const L = layout;
  // the old lowland/highland lerp survives as a gentle tint only
  const c = S.c.copy(S.low).lerp(S.high, clamp01((y + 6) / 24) * 0.5);

  const slope = 1 - ny;
  const rocky = clamp01(slope * 3.2 - 0.15);
  const tanS = ny > 0.05 ? Math.sqrt(Math.max(0, 1 - ny * ny)) / ny : 20;
  const soilSlope = sstep(S.bare[0], S.bare[1], tanS) * S.bare[2] * S.slopeSoil;
  const wet = sstep(HOLLOW_H + 1.5, HOLLOW_H - 2.5, y) * (1 - sstep(0.07, 0.14, tanS));

  // the graded works: the same masks terrainSurface classifies from, but only
  // as a soft halo now — the crisp road is drawn analytically in the shader
  const fx = x * L.cos + z * L.sin;
  const fz = (z * L.cos - x * L.sin) * L.mirror;
  const rd = roadDist(fx, fz, L);
  const tm = townMask(fx, fz, L);
  const roadBare = rd < ROAD_SURF * 1.4 ? clamp01(1 - rd / (ROAD_SURF * 1.35)) * TRACK_VERTEX_MAX : 0;
  const bare = Math.max(roadBare, sstep(0.5, 0.95, tm) * TRACK_VERTEX_MAX);
  const soil = Math.max(soilSlope, wet * 0.4, sstep(0.35, 0.8, tm) * 0.35);

  // damp hollows grow darker, ranker grass
  c.r *= 1 - 0.16 * wet;
  c.g *= 1 - 0.08 * wet;
  c.b *= 1 - 0.12 * wet;
  if (S.snowCover > 0) c.lerp(S.snowCol, S.snowCover * 0.8);

  // Very gentle large-scale dither, multiplicative now: on the calibrated
  // (darker) palettes the old additive +/-0.018 swung blue by half its value.
  const n = 1 + Math.sin(x * 1.7) * Math.sin(z * 2.3) * 0.05;
  colors[i * 3 + 0] = c.r * n;
  colors[i * 3 + 1] = c.g * n;
  colors[i * 3 + 2] = c.b * n;

  // rock takes what it wants off the top, the track halo its share of what is
  // left, and the rest splits cover / soil
  const rest = 1 - rocky;
  const wTrack = rest * bare;
  const openW = rest - wTrack;
  const wSoil = openW * soil;
  const s4 = i * 4;
  surf[s4] = (openW - wSoil) * 255 + 0.5;
  surf[s4 + 1] = wSoil * 255 + 0.5;
  surf[s4 + 2] = rocky * 255 + 0.5;
  surf[s4 + 3] = wTrack * 255 + 0.5;
}

// Write 'color' and 'aSurf' onto a geometry whose normals are already
// computed, vertex by vertex, at its position plus (ox, oy, oz) in world space.
function paintSurface(geo, S, ox = 0, oy = 0, oz = 0) {
  const pos = geo.attributes.position;
  const normal = geo.attributes.normal;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const surf = new Uint8Array(count * 4);   // normalized attribute: 0..255 -> 0..1
  for (let i = 0; i < count; i++) {
    shadeVertex(S, pos.getX(i) + ox, pos.getZ(i) + oz, pos.getY(i) + oy, normal.getY(i), colors, surf, i);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSurf', new THREE.BufferAttribute(surf, 4, true));
  return geo;
}

// For a mesh that borrows the ground's material (the airfield's embankment):
// gives it exactly the 'color' and 'aSurf' the ground would have at the same
// world positions, so it shades as the same hillside. The attribute meanings
// changed with the land-use wave (colour = cover only, y = bare earth from
// slope / damp / village, not from height), and a mesh still painted by the
// old height rule turns plough-brown wherever it stands above +6 m.
// Call after computeVertexNormals(); offset is the mesh's world translation
// (its parent group's position) when the geometry is built in local space.
// opts.turf: the faces are a sown, built bank, not a natural slope — the
// biome's SLOPE_BARE rule would bare a steep fill face (a 1:2.4 face is tan
// 0.42: 2% earth in the bocage, 81% in the desert); turf keeps a quarter.
export function paintTerrainSurface(geometry, palette = null, offset = null, opts = null) {
  const S = shadeContext(palette);
  if (opts && opts.turf) S.slopeSoil = 0.25;
  return paintSurface(geometry, S,
    offset ? offset.x : 0, offset ? offset.y : 0, offset ? offset.z : 0);
}

// ---------------------------------------------------------------------------
// T1: the skirt — the world does not end
//
// The battle mesh stops at +/-size/2, but fog only starts at a few hundred
// metres, so the audit found the edge of the world in plain view from 80% of
// azimuths. The skirt is a square annulus from the mesh border out to 7 km,
// drawn as a child of the ground mesh with the SAME material (one extra draw
// call, no new shader).
//
// - Crack-free: ring 0 IS the mesh border — its XZ and Y are copied from the
//   border vertices (float32 for float32), and the zipper below uses every one
//   of them in order, so the shared edges are the same edges.
// - Exact: out to a half-extent of max(1300, size/2 + 150) every vertex is
//   terrainHeight() itself (planes are clamped to +/-1200 and must never fly
//   through a ground that disagrees with the one they crash into). Beyond, it
//   blends over 1200 m into a far field: the noise of terrainHeight at 1.3x
//   amplitude, settling toward -2 m by the outer edge. The far field is
//   low-passed as the rings spread: the 120 m and 300 m terms fade out where
//   the vertex spacing could only alias them into spikes (measured: 20-30 m
//   errors at 250-450 m spacing), leaving the 785 m swell, which ~140 m
//   spacing draws to within a few metres.
// - Cheap: the spacing ALONG a ring starts at the mesh's own vertex spacing and
//   grows 6.5 cm per metre to the exact limit, with rings 1.8x that apart —
//   nearly every feature the skirt carries there runs radially across it (the
//   ridges along fz, the draws along fx), so its silhouette lives in the
//   along-ring resolution. Beyond, the far field is isotropic: spacing grows
//   10 cm per metre to 140 m, holds there as far as any camera can see
//   (size/2 + 2.6 km: the ground battle's far plane is 2.5 km, the big maps'
//   fog is 95% by 2.6 km), then opens up to the 7 km edge. 18-32k triangles.
// - Shading: the same shadeVertex as the mesh; ring 0 also copies the border's
//   colour, weights and normal, so the seam has no lighting step either.
// - Placement: terrainSkirtHeight() returns the height of the triangles as
//   DRAWN, so anything planted on the skirt sits on it exactly.
const SKIRT_OUTER = 7000;
const SKIRT_EXACT = 1300;
const SKIRT_EXACT_PAD = 150;
const SKIRT_BLEND = 1200;
const SKIRT_FLOOR = -2;
const SKIRT_GROW_NEAR = 0.065;   // along-ring spacing growth per metre, exact zone
const SKIRT_RADIAL = 1.8;        // ring step / along-ring spacing, exact zone
const SKIRT_GROW_FAR = 0.1;      // isotropic growth per metre beyond it
const SKIRT_FAR_CAP = 140;       // metres, held while a camera can still see it
const SKIRT_SEEN_PAD = 2600;     // ... out to size/2 + this
const SKIRT_GROW_OUT = 0.4;      // and then nobody is looking

const skirtExact = (half) => Math.max(SKIRT_EXACT, half + SKIRT_EXACT_PAD);

let meshInfo = {
  size: WORLD_SIZE, half: WORLD_SIZE / 2, skirtOuter: SKIRT_OUTER, exactHalf: skirtExact(WORLD_SIZE / 2),
};
// The last skirt's triangles, for terrainSkirtHeight (arrays only; the GPU
// buffers are the mesh's to dispose).
let lastSkirt = null;

// Extent of the LAST terrain built (the defaults describe WORLD_SIZE before any
// build): scenery uses it to put distant woods on the skirt, not the mesh.
// exactHalf is how far out the drawn ground is still terrainHeight() exactly.
export function terrainMeshInfo() {
  return {
    size: meshInfo.size, half: meshInfo.half, skirtOuter: meshInfo.skirtOuter, exactHalf: meshInfo.exactHalf,
  };
}

// Perimeter parameter 0..4 of a direction on the square rings (side + 0..1),
// the same parametrisation buildSkirt lays its rings out with. The rings are
// concentric scaled squares, so a fixed parameter is a ray from the origin.
function ringParam(x, z) {
  const d = Math.max(Math.abs(x), Math.abs(z)) || 1;
  const ux = x / d;
  const uz = z / d;
  if (Math.abs(uz) >= Math.abs(ux)) return uz < 0 ? (ux + 1) / 2 : 2 + (1 - ux) / 2;
  return ux > 0 ? 1 + (uz + 1) / 2 : 3 + (1 - uz) / 2;
}

// Height of the ground AS DRAWN for the last terrain built. Inside the battle
// mesh that is terrainHeight() (the mesh is within centimetres of it); on the
// skirt it is the skirt's own triangle under (x, z) — exact terrainHeight at
// the vertices out to exactHalf, the far-field blend beyond — so anything
// planted on the skirt (the distant woods) stands on what is actually drawn.
// terrainHeight() is NOT that beyond exactHalf: it keeps its ridges and draws
// going for ever, and a wood placed on it would float or sink by up to 20 m.
export function terrainSkirtHeight(x, z) {
  const S = lastSkirt;
  const d = Math.max(Math.abs(x), Math.abs(z));
  if (!S || d <= S.half) return terrainHeight(x, z);
  if (d >= S.R[S.R.length - 1]) return skirtHeight(x, z, meshInfo.exactHalf);
  let lo = 0;
  let hi = S.R.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S.R[mid] <= d) lo = mid; else hi = mid;
  }
  const u = ringParam(x, z);
  const pos = S.pos;
  const idx = S.index;
  let best = -Infinity;
  let bestY = NaN;
  for (let t = S.strip[lo]; t < S.strip[lo + 1]; t++) {
    if (u < S.uMin[t] - 1e-6 || u > S.uMax[t] + 1e-6) continue;
    const a = idx[t * 3];
    const b = idx[t * 3 + 1];
    const c = idx[t * 3 + 2];
    const ax = pos[a * 3];
    const az = pos[a * 3 + 2];
    const bx = pos[b * 3];
    const bz = pos[b * 3 + 2];
    const cx = pos[c * 3];
    const cz = pos[c * 3 + 2];
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-12) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
    const l3 = 1 - l1 - l2;
    const inside = Math.min(l1, l2, l3);
    if (inside > best) {
      best = inside;
      bestY = l1 * pos[a * 3 + 1] + l2 * pos[b * 3 + 1] + l3 * pos[c * 3 + 1];
      if (inside >= -1e-9) break;
    }
  }
  return Number.isNaN(bestY) ? skirtHeight(x, z, meshInfo.exactHalf) : bestY;
}

function farHeight(x0, z0, d, exact) {
  const x = x0 + seedX;
  const z = z0 + seedZ;
  // the two short terms fade out as the rings spread past what can draw them
  const k3 = 1 - gsmooth(clamp01((d - exact) / 400));
  const k2 = 1 - gsmooth(clamp01((d - exact - 200) / 800));
  return 1.3 * (
    Math.sin(x * 0.008) * Math.cos(z * 0.008) * 14
    + Math.sin(x * 0.021 + 1.7) * Math.cos(z * 0.017 + 3.1) * 5 * k2
    + Math.sin(x * 0.052 + 4.2) * Math.cos(z * 0.047 + 1.3) * 1.4 * k3);
}

function skirtHeight(x, z, exact) {
  const h = terrainHeight(x, z);
  const d = Math.max(Math.abs(x), Math.abs(z));
  if (d <= exact) return h;
  const t = gsmooth(clamp01((d - exact) / SKIRT_BLEND));
  const settle = gsmooth(clamp01((d - exact - SKIRT_BLEND) / Math.max(1, SKIRT_OUTER - exact - SKIRT_BLEND)));
  const f = farHeight(x, z, d, exact);
  const far = f + (SKIRT_FLOOR - f) * settle;
  return h + (far - h) * t;
}

// Square rings: half-extent R and m vertices per side (corners included once,
// so the ring has 4m). Ring 0 is the mesh border.
function skirtRings(half, seg, exact) {
  const s0 = (2 * half) / seg;
  const spE = s0 + Math.max(0, exact - half) * SKIRT_GROW_NEAR;
  const seen = half + SKIRT_SEEN_PAD;
  const sp = (R) => {
    if (R <= exact) return s0 + (R - half) * SKIRT_GROW_NEAR;
    const a = Math.min(Math.max(spE, SKIRT_FAR_CAP), spE + (R - exact) * SKIRT_GROW_FAR);
    return R <= seen ? a : a + (R - seen) * SKIRT_GROW_OUT;
  };
  const rings = [{ R: half, m: seg }];
  let R = half;
  let m = seg;
  while (R < SKIRT_OUTER) {
    const step = sp(R) * (R < exact ? SKIRT_RADIAL : 1);
    let next = R + step;
    if (next > SKIRT_OUTER - step * 0.35) next = SKIRT_OUTER;
    R = next;
    m = Math.min(m, Math.max(8, Math.round((2 * R) / sp(R))));
    rings.push({ R, m });
  }
  return rings;
}

function buildSkirt(mainGeo, seg, size, S, material) {
  const half = size / 2;
  const exact = skirtExact(half);
  const rings = skirtRings(half, seg, exact);
  let nv = 0;
  for (const r of rings) nv += 4 * r.m;

  const mPos = mainGeo.attributes.position;
  const mNrm = mainGeo.attributes.normal;
  const mCol = mainGeo.attributes.color.array;
  const mSurf = mainGeo.attributes.aSurf.array;
  const pos = new Float32Array(nv * 3);
  const border = new Int32Array(4 * seg);   // ring-0 vertex -> mesh vertex
  const starts = [];
  let v = 0;
  for (let k = 0; k < rings.length; k++) {
    const { R, m } = rings[k];
    starts.push(v);
    for (let s = 0; s < 4; s++) {
      for (let j = 0; j < m; j++, v++) {
        if (k === 0) {
          // PlaneGeometry rotated -90 deg about X: x = ix*step - half,
          // z = iy*step - half, vertex index iy*(seg+1) + ix
          let ix;
          let iy;
          if (s === 0) { ix = j; iy = 0; } else if (s === 1) { ix = seg; iy = j; } else if (s === 2) { ix = seg - j; iy = seg; } else { ix = 0; iy = seg - j; }
          const mi = iy * (seg + 1) + ix;
          border[v] = mi;
          pos[v * 3] = mPos.getX(mi);
          pos[v * 3 + 1] = mPos.getY(mi);
          pos[v * 3 + 2] = mPos.getZ(mi);
        } else {
          const f = j / m;
          let x;
          let z;
          if (s === 0) { x = -R + 2 * R * f; z = -R; } else if (s === 1) { x = R; z = -R + 2 * R * f; } else if (s === 2) { x = R - 2 * R * f; z = R; } else { x = -R; z = R - 2 * R * f; }
          // evaluate at the float32 position the GPU will actually draw
          x = Math.fround(x);
          z = Math.fround(z);
          pos[v * 3] = x;
          pos[v * 3 + 1] = skirtHeight(x, z, exact);
          pos[v * 3 + 2] = z;
        }
      }
    }
  }

  // Zip each ring to the next by perimeter parameter (side + j/m): every
  // vertex of both rings is used in order, so there are no T-junctions, and a
  // tie (the corners) advances the inner ring first so the corner diagonal is
  // always an edge. Triangles are wound to face +Y whatever the order.
  let ntri = 0;
  for (let k = 0; k + 1 < rings.length; k++) ntri += 4 * (rings[k].m + rings[k + 1].m);
  const index = nv < 65536 ? new Uint16Array(ntri * 3) : new Uint32Array(ntri * 3);
  // per triangle, the span of perimeter parameter it covers, and where each
  // strip starts: terrainSkirtHeight's lookup table
  const uMin = new Float32Array(ntri);
  const uMax = new Float32Array(ntri);
  const strip = new Int32Array(rings.length);
  let t = 0;
  const tri = (a, b, c, u0, u1) => {
    const ax = pos[a * 3];
    const az = pos[a * 3 + 2];
    const up = (pos[b * 3 + 2] - az) * (pos[c * 3] - ax) - (pos[b * 3] - ax) * (pos[c * 3 + 2] - az);
    uMin[t / 3] = u0;
    uMax[t / 3] = u1;
    index[t++] = a;
    index[t++] = up >= 0 ? b : c;
    index[t++] = up >= 0 ? c : b;
  };
  for (let k = 0; k + 1 < rings.length; k++) {
    const mA = rings[k].m;
    const mB = rings[k + 1].m;
    const nA = 4 * mA;
    const nB = 4 * mB;
    const a0 = starts[k];
    const b0 = starts[k + 1];
    strip[k] = t / 3;
    let i = 0;
    let j = 0;
    while (i < nA || j < nB) {
      // compare (i+1)/mA with (j+1)/mB in integers
      if (j >= nB || (i < nA && (i + 1) * mB <= (j + 1) * mA)) {
        tri(a0 + (i % nA), a0 + ((i + 1) % nA), b0 + (j % nB),
          Math.min(i / mA, j / mB), Math.max((i + 1) / mA, j / mB));
        i++;
      } else {
        tri(a0 + (i % nA), b0 + ((j + 1) % nB), b0 + (j % nB),
          Math.min(i / mA, j / mB), Math.max(i / mA, (j + 1) / mB));
        j++;
      }
    }
  }
  strip[rings.length - 1] = t / 3;
  lastSkirt = {
    half,
    R: Float64Array.from(rings, (r) => r.R),
    strip,
    uMin,
    uMax,
    pos,
    index,
  };

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();

  const nrm = geo.attributes.normal;
  const colors = new Float32Array(nv * 3);
  const surf = new Uint8Array(nv * 4);
  for (let q = 0; q < nv; q++) {
    if (q < 4 * seg) {
      const mi = border[q];
      nrm.setXYZ(q, mNrm.getX(mi), mNrm.getY(mi), mNrm.getZ(mi));
      colors[q * 3] = mCol[mi * 3];
      colors[q * 3 + 1] = mCol[mi * 3 + 1];
      colors[q * 3 + 2] = mCol[mi * 3 + 2];
      surf[q * 4] = mSurf[mi * 4];
      surf[q * 4 + 1] = mSurf[mi * 4 + 1];
      surf[q * 4 + 2] = mSurf[mi * 4 + 2];
      surf[q * 4 + 3] = mSurf[mi * 4 + 3];
    } else {
      shadeVertex(S, pos[q * 3], pos[q * 3 + 2], pos[q * 3 + 1], nrm.getY(q), colors, surf, q);
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSurf', new THREE.BufferAttribute(surf, 4, true));

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'terrainSkirt';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// size: mesh extent in metres (heightmap itself is analytic and unbounded)
export const TERRAIN_RENDER_ORDER = 50;

export function buildTerrain(size = WORLD_SIZE, segs = 130, palette = null) {
  const quality = tier();
  const seg = Math.max(segs, Math.min(SEG_CAP[quality], Math.round(segs * SEG_MUL[quality])));

  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }
  // Smooth normals, not flat: the faceted look was a large part of why the
  // ground read as cheap, and the layer normal maps now carry the detail the
  // facets used to fake.
  geo.computeVertexNormals();

  // Per vertex: the cover colour plus the four layer weights the blend shader
  // needs (see shadeVertex).
  const S = shadeContext(palette);
  paintSurface(geo, S);

  const material = groundMaterial(palette, size, quality, S);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  const ph = photoOf.get(material);
  const fade = ph ? photoFader(ph.state, ph.uniform) : null;
  if (fade) mesh.onBeforeRender = fade;

  // The skirt rides along as a child, so every caller that adds, removes or
  // traverses the ground gets it for free. Callers that dispose only
  // terrain.geometry (the hangar) still free it: the listener below.
  const skirt = buildSkirt(geo, seg, size, S, material);
  // the skirt can be all a high camera sees of the ground
  if (fade) skirt.onBeforeRender = fade;
  // P-04: the ground is the most expensive fragment shader in the frame and
  // covers most of the screen, so it is drawn AFTER every other opaque thing
  // (vehicles, grass, hedges, trees, buildings): the depth test then rejects
  // the ground behind them before it is shaded instead of shading it and
  // painting over it (-1.3..1.7 ms a frame on Iris Xe). The sky (-1000) and
  // the cloud deck (-900) keep their places; the see-through decals live in
  // the transparent list, which three draws after every opaque anyway, and
  // the airfield's surfaces are pulled forward by polygon offset, so no
  // coplanar tie depends on which of the two is drawn first.
  mesh.renderOrder = TERRAIN_RENDER_ORDER;
  skirt.renderOrder = TERRAIN_RENDER_ORDER;
  mesh.add(skirt);
  mesh.userData.skirt = skirt;
  geo.addEventListener('dispose', () => skirt.geometry.dispose());

  meshInfo = { size, half: size / 2, skirtOuter: SKIRT_OUTER, exactHalf: skirtExact(size / 2) };
  return mesh;
}

// Test hook (P-04): the patched land-use GLSL and the table builder, so a
// harness can check on a real GPU that the table path returns exactly what
// the hash chains do. Nothing in the game reads it.
export const __luHashTest = { glsl: () => LANDUSE_FAST, table: (u, size) => parcelHashTable(u, size) };
