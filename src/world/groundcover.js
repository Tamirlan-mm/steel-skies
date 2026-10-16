import * as THREE from 'three';
import { MAP_PRESETS, mixColor } from './presets.js';
import {
  terrainFeatures,
  terrainHeight as defaultTerrainHeight,
  roadDistanceAt as defaultRoadDistanceAt,
} from './terrain.js';
import { getMaterialQuality } from '../core/materials.js';

// Ground cover: the grass a tank actually drives through (maps.md, CONTRACT G).
//
// The terrain shader paints a grass TEXTURE, and from a tank's eye height that
// reads as a green carpet: nothing breaks the ground plane, so distance and
// scale have nothing to hang on. A real pasture is a mat of tufts that stand up
// out of the soil, lean with the wind and change with what the field is used
// for — cut short on stubble, tall and gold in wheat, rank along the hedge
// margin, thin under trees and gone on the lane. This module draws that layer
// as ONE instanced draw call around the camera.
//
// How it stays cheap and stable:
//  - Space is cut into 4 m cells snapped to the world, and each cell's tufts are
//    a pure hash of its integer id, so a tuft is always in the same place — the
//    carpet never swims as the camera moves.
//  - The ring of cells around the camera owns fixed blocks of instance slots.
//    When the camera crosses a cell boundary only the cells that LEAVE the ring
//    give their block back and only the cells that ENTER it are generated.
//  - Everything that moves per frame (wind, the distance fade, the far-blade
//    widening) happens in the vertex shader. The CPU does nothing between
//    boundary crossings except bump one time uniform.
//
// Visual only: never registered as a prop, never raycast, never casts a shadow.

const CELL = 4;
const HALF_DIAG = CELL * Math.SQRT1_2;   // 2.83 m, centre of a cell to its corner
const FADE = 15;                         // metres over which a tuft shrinks to 0
const ROAD_CLEAR = 5;                    // no tufts closer than this to the road centreline
const SLOPE_MAX = 0.6;
const MAX_CELLS_PER_UPDATE = 220;        // a teleport fills over a few frames, nearest first
const WORLD_LIMIT = 1300;                // beyond this the skirt stops following terrainHeight

export const GROUNDCOVER_TIERS = {
  low: { count: 0, radius: 0 },
  medium: { count: 6000, radius: 40 },
  high: { count: 12000, radius: 55 },
};

// ---------------------------------------------------------------------------
// hashing and noise — integer maths only, so the layout is identical everywhere

function hash3(i, j, k) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(k | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Value noise with a smoothstep blend: the patchiness of a real sward (clumps of
// taller growth, drier spots) at a scale the eye reads as ground, not pattern.
function vnoise(x, z, seed) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  let fx = x - xi;
  let fz = z - zi;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const a = hash3(xi, zi, seed);
  const b = hash3(xi + 1, zi, seed);
  const c = hash3(xi, zi + 1, seed);
  const d = hash3(xi + 1, zi + 1, seed);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// colour: packed sRGB hex -> LINEAR components, decoded by hand. The instance
// colour attribute is multiplied into diffuseColor in linear space, and it is
// raw data, so it must not go through THREE.Color's colour management.

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexLinear(hex) {
  const h = Number(hex) >>> 0;
  return [
    srgbToLinear(((h >> 16) & 255) / 255),
    srgbToLinear(((h >> 8) & 255) / 255),
    srgbToLinear((h & 255) / 255),
  ];
}

function isHex(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 0xffffff;
}

// ---------------------------------------------------------------------------
// The tuft. Unit height 1, about 0.5 across; the instance matrix scales it to
// metres. Three curved, tapered blades (base quad, narrower mid, tip: 3 tris
// each) splayed outward, plus one short single-triangle blade: 10 triangles.
//
// Normals point up with a slight lean toward each blade's splay. A thin blade
// lit by its true face normal goes black whenever the sun is behind it, which a
// field of real grass (translucent, and lit by the sky from every side) never
// does; lit like the ground it grows from, it sits IN the terrain instead of
// on it. The fragment shader also stops DoubleSide from flipping that normal.
//
// aGc: xyz = across-blade half-width vector (for widening far blades so they do
// not alias into sparkle), w = height of the vertex (0 base .. 1 tallest tip).

let tuftGeoTemplate = null;

function buildTuftGeometry() {
  const pos = [];
  const nrm = [];
  const gc = [];
  const idx = [];

  const pushV = (x, y, z, ax, az, lx, lz) => {
    pos.push(x, y, z);
    const nx = lx * 0.42;
    const nz = lz * 0.42;
    const inv = 1 / Math.hypot(nx, 1, nz);
    nrm.push(nx * inv, inv, nz * inv);
    gc.push(ax, 0, az, y);
    return pos.length / 3 - 1;
  };

  const LONG = [
    { phi: 0.35, h: 1.0, hw: 0.058, off: 0.07, bend: 0.30 },
    { phi: 2.45, h: 0.86, hw: 0.062, off: 0.09, bend: 0.36 },
    { phi: 4.45, h: 0.72, hw: 0.055, off: 0.08, bend: 0.40 },
  ];
  for (const b of LONG) {
    const lx = Math.cos(b.phi);
    const lz = Math.sin(b.phi);
    const ax = -lz;   // across the blade
    const az = lx;
    const bx = lx * b.off;
    const bz = lz * b.off;
    // bend follows a quadratic: a quarter of the tip offset at mid height
    const mx = bx + lx * b.bend * 0.25;
    const mz = bz + lz * b.bend * 0.25;
    const tx = bx + lx * b.bend;
    const tz = bz + lz * b.bend;
    const mw = b.hw * 0.62;
    const b0 = pushV(bx - ax * b.hw, 0, bz - az * b.hw, -ax * b.hw, -az * b.hw, lx, lz);
    const b1 = pushV(bx + ax * b.hw, 0, bz + az * b.hw, ax * b.hw, az * b.hw, lx, lz);
    const m0 = pushV(mx - ax * mw, b.h * 0.52, mz - az * mw, -ax * mw, -az * mw, lx, lz);
    const m1 = pushV(mx + ax * mw, b.h * 0.52, mz + az * mw, ax * mw, az * mw, lx, lz);
    const t = pushV(tx, b.h, tz, 0, 0, lx, lz);
    idx.push(b0, b1, m1, b0, m1, m0, m0, m1, t);
  }
  {
    const phi = 1.3;
    const lx = Math.cos(phi);
    const lz = Math.sin(phi);
    const ax = -lz;
    const az = lx;
    const hw = 0.07;
    const bx = lx * 0.05;
    const bz = lz * 0.05;
    const s0 = pushV(bx - ax * hw, 0, bz - az * hw, -ax * hw, -az * hw, lx, lz);
    const s1 = pushV(bx + ax * hw, 0, bz + az * hw, ax * hw, az * hw, lx, lz);
    const st = pushV(bx + lx * 0.22, 0.5, bz + lz * 0.22, 0, 0, lx, lz);
    idx.push(s0, s1, st);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aGc', new THREE.Float32BufferAttribute(gc, 4));
  geo.setIndex(idx);
  // Instances are placed far from the origin; the mesh is never frustum culled
  // (it always surrounds the camera) so these bounds only need to be finite.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 1e5);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-1e5, -1e5, -1e5), new THREE.Vector3(1e5, 1e5, 1e5));
  return geo;
}

// Per battle a fresh geometry is made (it is tiny) and freed by dispose(), so
// nothing here outlives the battle and nothing needs the shared stamp. The
// template only avoids recomputing the arrays.
function tuftGeometry() {
  if (!tuftGeoTemplate) tuftGeoTemplate = buildTuftGeometry();
  return tuftGeoTemplate.clone();
}

// ---------------------------------------------------------------------------
// shader

const GC_VERTEX_HEAD = /* glsl */`
attribute vec4 aGc;
uniform float uGcTime;
uniform vec3 uGcWind;     // xy = wind direction (world XZ), z = lean amplitude
uniform vec2 uGcFade;     // distance where the fade starts, distance where tufts are gone
varying float vGcH;
`;

const GC_VERTEX_BODY = /* glsl */`
#include <begin_vertex>
{
  vec3 gcC0 = instanceMatrix[0].xyz;
  vec3 gcC1 = instanceMatrix[1].xyz;
  vec3 gcC2 = instanceMatrix[2].xyz;
  vec3 gcIp = instanceMatrix[3].xyz;
  float gcH = aGc.w;
  float gcDist = distance(gcIp, cameraPosition);

  // far blades are thickened so they stay at least about a pixel wide instead
  // of flickering in and out between samples
  transformed.xz += aGc.xz * (smoothstep(6.0, uGcFade.y, gcDist) * 1.4);

  // Wind. Gusts are waves that roll across the field DOWNWIND — the thing that
  // makes a real meadow read as moving air — with a faster, smaller flutter
  // across the wind on top.
  vec2 gcWd = uGcWind.xy;
  float gcPh = dot(gcIp.xz, gcWd) * 0.09 - uGcTime * 1.6;
  float gcGust = 0.5 + 0.5 * sin(gcPh) * (0.6 + 0.4 * sin(gcPh * 0.41 + 1.3));
  float gcFl = sin(uGcTime * 4.7 + gcIp.x * 1.37 + gcIp.z * 1.11 + gcH * 1.9);
  vec2 gcLean = gcWd * (uGcWind.z * (0.35 + gcGust))
              + vec2(-gcWd.y, gcWd.x) * (gcFl * uGcWind.z * 0.22);
  float gcBend = gcH * gcH;
  float gcSy = length(gcC1);
  vec3 gcOff = vec3(gcLean.x, -0.45 * dot(gcLean, gcLean), gcLean.y) * (gcBend * gcSy);
  // world metres -> the tuft's own (rotated, scaled) space
  transformed += vec3(
    dot(gcOff, gcC0) / max(dot(gcC0, gcC0), 1e-8),
    dot(gcOff, gcC1) / max(dot(gcC1, gcC1), 1e-8),
    dot(gcOff, gcC2) / max(dot(gcC2, gcC2), 1e-8)
  );

  // distance fade: the whole tuft shrinks into its root over the last FADE metres
  transformed *= 1.0 - smoothstep(uGcFade.x, uGcFade.y, gcDist);
  vGcH = gcH;
}
`;

const GC_FRAGMENT_HEAD = /* glsl */`
uniform vec2 uGcShade;    // x = brightness at the root, y = at the tallest tip
varying float vGcH;
`;

const GC_COLOR_FRAGMENT = /* glsl */`
#if defined( USE_INSTANCING_COLOR ) || defined( USE_COLOR )
  // root in the shade of the sward, sun-bleached tips
  diffuseColor.rgb *= vColor * mix(uGcShade.x, uGcShade.y, vGcH);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.06, 1.02, 0.78), vGcH * vGcH * 0.55);
#endif
`;

const GC_NORMAL_FRAGMENT = /* glsl */`
#include <normal_fragment_begin>
#ifndef FLAT_SHADED
  normal = normalize( vNormal );
  nonPerturbedNormal = normal;
#endif
`;

function makeMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  mat.name = 'groundcover';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uGcTime = uniforms.uGcTime;
    sh.uniforms.uGcWind = uniforms.uGcWind;
    sh.uniforms.uGcFade = uniforms.uGcFade;
    sh.uniforms.uGcShade = uniforms.uGcShade;
    sh.vertexShader = GC_VERTEX_HEAD + sh.vertexShader.replace('#include <begin_vertex>', GC_VERTEX_BODY);
    sh.fragmentShader = GC_FRAGMENT_HEAD + sh.fragmentShader
      .replace('#include <color_fragment>', GC_COLOR_FRAGMENT)
      .replace('#include <normal_fragment_begin>', GC_NORMAL_FRAGMENT);
  };
  mat.customProgramCacheKey = () => 'steelSkies.groundcover.v1';
  return mat;
}

// ---------------------------------------------------------------------------
// biome look

const CROP_INDEX = { pasture: 0, wheat: 1, stubble: 2, plough: 3, fallow: 4, orchard: 5 };

function cropIndexOf(c) {
  if (typeof c === 'number' && Number.isFinite(c)) return c | 0;
  if (typeof c === 'string') return CROP_INDEX[c] ?? (c.startsWith('orchard') ? 5 : 0);
  return 0;
}

// How each crop changes the tufts standing in it: density, height, dryness,
// and an optional colour of its own (index into preset.cropCols).
const CROP_STYLE = [
  { d: 1.0, h: 1.0, dry: 0.0, own: false },   // 0 pasture: grazed sward
  { d: 1.0, h: 2.2, dry: 0.0, own: true },    // 1 wheat: tall, gold, uniform
  { d: 0.7, h: 0.36, dry: 0.0, own: true },   // 2 stubble: cut straw
  { d: 0.0, h: 0.0, dry: 0.0, own: false },   // 3 plough: bare
  { d: 0.95, h: 1.4, dry: 0.45, own: false }, // 4 fallow: rank weeds going to seed
  { d: 1.0, h: 1.15, dry: 0.05, own: false }, // 5 orchard grass: long, shaded
];
const CROP_DEFAULT_COL = [null, 0xb89b52, 0xb3a275, null, null, null];

function biomeDefaults(biome) {
  switch (biome) {
    case 'desert':
      // scrub: low, wide, dusty grey-green clumps, and few of them
      return { mode: 'scrub', density: 0.1, height: 0.5, width: 1.05, color: 0x6c6e4c, dryColor: 0x9a8a60 };
    case 'winter':
      return { mode: 'stalks', density: 0.26, height: 0.55, width: 0.26, color: 0x7a6a4e, dryColor: 0x9c8a66 };
    case 'steppe':
      return { mode: 'grass', density: 0.95, height: 0.6, width: 0.42, color: 0x8f8a4e, dryColor: 0xb7a468 };
    default:
      return { mode: 'grass', density: 1.0, height: 0.42, width: 0.46, color: null, dryColor: null };
  }
}

function resolveLook(preset) {
  const p = preset || {};
  const biomeKey = typeof p.biome === 'string' ? p.biome : 'meadow';
  const biome = MAP_PRESETS[biomeKey] || null;
  const def = biomeDefaults(biomeKey);
  const g = (p.grass && typeof p.grass === 'object') ? p.grass
    : (biome && biome.grass && typeof biome.grass === 'object') ? biome.grass : null;

  // The hour's colour cast, the same one composePreset puts on the ground
  // palette. Colours already taken from the composed palette carry it.
  const tod = p.tod || null;
  const gt = tod && isHex(tod.groundTint) ? tod.groundTint : null;
  const gm = tod && Number.isFinite(tod.groundMix) ? tod.groundMix : 0;
  const tint = (hex) => (gt !== null && gm > 0 ? mixColor(hex, gt, gm) : hex);

  const snowCover = Number.isFinite(p.snowCover) ? p.snowCover : 0;
  let mode = def.mode;
  let density = def.density;
  if (biomeKey === 'winter') {
    // winter ground is snow whatever the sky does: a few dead stalks through
    // it, fewer still once it is snowing properly
    mode = 'stalks';
    density = snowCover < 0.35 ? 0.26 : 0.13;
  } else if (snowCover >= 0.35 && mode !== 'scrub') {
    // a snowed-over meadow: only the tallest dead stems stand out of it
    mode = 'stalks';
    density = 0.2;
  }

  // presets.js: density is "x the quality tier's count". The tier count is a hard
  // cap (CONTRACT G), so above 1 it fills more of the existing slots instead.
  const gDensity = g && Number.isFinite(g.density) ? Math.min(1.5, Math.max(0, g.density)) : null;
  const gHeight = g && Number.isFinite(g.height) ? Math.min(1.5, Math.max(0.1, g.height)) : null;

  let color;
  let dryColor;
  let height = def.height;
  let width = def.width;
  if (mode === 'stalks') {
    const s = biomeDefaults('winter');
    color = tint(s.color);
    dryColor = tint(s.dryColor);
    height = s.height;
    width = s.width;
    if (biomeKey === 'winter' && gDensity !== null) density = Math.min(density, gDensity);
  } else {
    if (gDensity !== null) density = mode === 'scrub' ? Math.min(gDensity, 0.25) : gDensity;
    if (gHeight !== null) height = gHeight;
    const low = isHex(p.low) ? p.low : 0x5a7a3c;
    const high = isHex(p.high) ? p.high : low;
    color = g && isHex(g.color) ? tint(g.color) : def.color !== null ? tint(def.color) : low;
    dryColor = g && isHex(g.dryColor) ? tint(g.dryColor)
      : def.dryColor !== null ? tint(def.dryColor) : mixColor(high, 0xb09a62, 0.5);
  }

  const cropCols = Array.isArray(p.cropCols) ? p.cropCols
    : (biome && Array.isArray(biome.cropCols) ? biome.cropCols : null);
  const cropLin = CROP_STYLE.map((st, i) => {
    if (!st.own) return null;
    const hex = cropCols && isHex(cropCols[i]) ? tint(cropCols[i]) : CROP_DEFAULT_COL[i];
    return hex === null ? null : hexLinear(hex);
  });

  const windStrength = Number.isFinite(p.windStrength) ? p.windStrength
    : Number.isFinite(p.wind) ? p.wind : 3;
  const windDir = Number.isFinite(p.windDir) ? p.windDir : 0;

  return {
    biomeKey,
    mode,
    density,
    height,
    width,
    green: hexLinear(color),
    dry: hexLinear(dryColor),
    cropLin,
    useCrops: mode === 'grass',
    windDir,
    windAmp: Math.min(12, Math.max(0, windStrength)) * (mode === 'scrub' ? 0.012 : 0.034),
  };
}

// ---------------------------------------------------------------------------

function resolveQuality(q) {
  if (typeof q === 'string' && GROUNDCOVER_TIERS[q]) return q;
  try {
    const m = getMaterialQuality();
    if (GROUNDCOVER_TIERS[m]) return m;
  } catch { /* fall through */ }
  return 'high';
}

function ringOffsets(radius) {
  const reach = radius + HALF_DIAG;
  const n = Math.ceil(reach / CELL);
  const list = [];
  for (let di = -n; di <= n; di++) {
    for (let dj = -n; dj <= n; dj++) {
      const d2 = (di * di + dj * dj) * CELL * CELL;
      if (d2 <= reach * reach) list.push([di, dj, d2]);
    }
  }
  // nearest first, so a partial fill (teleport, respawn) grows outward from the
  // camera and whatever is still missing sits in the fade band
  list.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
  const di = new Int16Array(list.length);
  const dj = new Int16Array(list.length);
  const d2 = new Int32Array(list.length);
  for (let i = 0; i < list.length; i++) {
    di[i] = list[i][0];
    dj[i] = list[i][1];
    d2[i] = list[i][0] * list[i][0] + list[i][1] * list[i][1];
  }
  return { di, dj, d2, reachCells2: (reach / CELL) * (reach / CELL) };
}

const cellKey = (i, j) => (i + 32768) * 65536 + (j + 32768);

// Zero scale, parked far below the world: a free or masked slot draws nothing
// and cannot be mistaken for a tuft standing anywhere on the map.
function writeEmpty(arr, o) {
  arr.fill(0, o, o + 16);
  arr[o + 13] = -1e5;
  arr[o + 15] = 1;
}

/**
 * createGroundCover(scene, { preset, landUse, keepOuts, quality, terrainHeight, roadDistanceAt })
 *   -> { mesh, update(camera), dispose() }
 */
export function createGroundCover(scene, opts = {}) {
  const o = opts || {};
  const tierKey = resolveQuality(o.quality);
  const tier = GROUNDCOVER_TIERS[tierKey];
  const heightAt = typeof o.terrainHeight === 'function' ? o.terrainHeight : defaultTerrainHeight;
  const roadAt = typeof o.roadDistanceAt === 'function' ? o.roadDistanceAt : defaultRoadDistanceAt;
  const look = resolveLook(o.preset);

  let disposed = false;

  const uniforms = {
    uGcTime: { value: 0 },
    uGcWind: { value: new THREE.Vector3(Math.cos(look.windDir), Math.sin(look.windDir), look.windAmp) },
    uGcFade: { value: new THREE.Vector2(Math.max(0, tier.radius - FADE), Math.max(1, tier.radius)) },
    uGcShade: { value: new THREE.Vector2(look.mode === 'stalks' ? 0.8 : 0.58, look.mode === 'stalks' ? 1.1 : 1.2) },
  };

  // ---- the low tier: an empty, hidden mesh so callers need no special case ----
  if (tier.count <= 0 || (look.density <= 0)) {
    const geo = tuftGeometry();
    const mat = makeMaterial(uniforms);
    const mesh = new THREE.InstancedMesh(geo, mat, 1);
    mesh.count = 0;
    mesh.visible = false;
    setupMesh(mesh);
    if (scene && typeof scene.add === 'function') scene.add(mesh);
    return {
      mesh,
      update() {},
      dispose() {
        if (disposed) return;
        disposed = true;
        disposeMesh(mesh);
      },
    };
  }

  // ---- ring, slots ----------------------------------------------------------
  const ring = ringOffsets(tier.radius);
  const slotCount = ring.di.length;
  const kFull = Math.max(1, Math.floor(tier.count / slotCount));
  // Sparse looks (desert scrub, winter stalks) get fewer slots per cell rather
  // than thousands of zero-scale instances the GPU would still transform; the
  // keep probability is scaled back up so the density on the ground is the same.
  const K = Math.max(1, Math.min(kFull, Math.ceil(kFull * Math.min(1, look.density * 1.25))));
  const keepBoost = kFull / K;
  const capacity = slotCount * K;

  const geo = tuftGeometry();
  const mat = makeMaterial(uniforms);
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const colorArr = new Float32Array(capacity * 3);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(colorArr, 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  const matArr = mesh.instanceMatrix.array;
  for (let s = 0; s < capacity; s++) writeEmpty(matArr, s * 16);
  mesh.count = capacity;
  setupMesh(mesh);
  if (scene && typeof scene.add === 'function') scene.add(mesh);

  const freeSlots = [];
  for (let s = slotCount - 1; s >= 0; s--) freeSlots.push(s);
  const active = new Map();        // cellKey -> slot
  const activeI = new Int32Array(slotCount);
  const activeJ = new Int32Array(slotCount);
  const slotUsed = new Uint8Array(slotCount);
  const dirtySlots = [];
  const slotDirty = new Uint8Array(slotCount);

  // ---- static masks gathered once per battle ----------------------------------
  let feat = null;
  try { feat = o.features || terrainFeatures(); } catch { feat = null; }
  const town = feat && feat.town && Number.isFinite(feat.town.x)
    ? { x: feat.town.x, z: feat.town.z, r: Number(feat.town.radius) || 0 } : null;

  const lu = o.landUse && typeof o.landUse === 'object' ? o.landUse : null;
  let parcelFn = lu && typeof lu.parcelAt === 'function' ? lu.parcelAt.bind(lu) : null;

  // buildings: a disc around each footprint (half diagonal + 0.6 m). Yards are
  // trampled bare around a farmhouse anyway, and a disc is right whatever yaw
  // convention the lot uses.
  const lotDiscs = [];
  if (lu && Array.isArray(lu.lots)) {
    for (const l of lu.lots) {
      if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.z)) continue;
      const w = Number(l.w) || 8;
      const d = Number(l.d) || 8;
      lotDiscs.push(l.x, l.z, Math.hypot(w, d) * 0.5 + 0.6);
    }
  }
  // woods: the floor under a canopy is shaded and thin
  const woodDiscs = [];
  if (lu && Array.isArray(lu.woods)) {
    for (const wd of lu.woods) {
      if (!wd) continue;
      if (Array.isArray(wd.lobes) && wd.lobes.length) {
        for (const lb of wd.lobes) {
          if (lb && Number.isFinite(lb.x) && Number.isFinite(lb.z) && Number(lb.r) > 0) woodDiscs.push(lb.x, lb.z, Number(lb.r));
        }
      } else if (Number.isFinite(wd.x) && Number.isFinite(wd.z) && Number(wd.r) > 0) {
        woodDiscs.push(wd.x, wd.z, Number(wd.r));
      }
    }
  }

  // Keep-outs are a live list that can grow after the scenery is built (an
  // airfield registering late). A change flushes the ring and it refills.
  const koSource = o.keepOuts;
  let koSig = '';
  const koDiscs = [];
  function readKeepOuts() {
    const src = typeof koSource === 'function' ? safeCall(koSource) : koSource;
    const list = Array.isArray(src) ? src : [];
    let sig = String(list.length);
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      sig += `|${k && k.x},${k && k.z},${k && k.r}`;
    }
    if (sig === koSig) return false;
    koSig = sig;
    koDiscs.length = 0;
    for (const k of list) {
      if (!k) continue;
      const x = Number(k.x);
      const z = Number(k.z);
      const r = Number(k.r);
      if (Number.isFinite(x) && Number.isFinite(z) && r > 0) koDiscs.push(x, z, r);
    }
    return true;
  }
  readKeepOuts();

  function parcel(x, z) {
    if (!parcelFn) return null;
    try {
      return parcelFn(x, z) || null;
    } catch {
      parcelFn = null;   // a broken land-use module must not take the battle down
      return null;
    }
  }

  // ---- per-cell generation ---------------------------------------------------
  const cellInfo = { density: 1, height: 1, dry: 0, shade: 1, checkKo: false, checkRoad: false, checkLot: false, checkParcel: false, cropCol: null };

  function applyCrop(info, crop, edgeDist) {
    if (edgeDist < 3) {
      // the uncut margin along the hedge: rank, dark and dense
      info.height *= 1.5;
      info.shade *= 0.9;
      info.cropCol = null;
      return;
    }
    const st = CROP_STYLE[crop] || CROP_STYLE[0];
    info.density *= st.d;
    info.height *= st.h;
    info.dry = Math.min(1, info.dry + st.dry);
    info.cropCol = look.cropLin[crop] || null;
  }

  // Returns false when the whole cell is bare.
  function classifyCell(cx, cz) {
    const info = cellInfo;
    info.density = look.density;
    info.height = 1;
    info.dry = 0;
    info.shade = 1;
    info.checkKo = false;
    info.checkRoad = false;
    info.checkLot = false;
    info.checkParcel = false;
    info.cropCol = null;

    if (cx < -WORLD_LIMIT || cx > WORLD_LIMIT || cz < -WORLD_LIMIT || cz > WORLD_LIMIT) return false;

    for (let k = 0; k < koDiscs.length; k += 3) {
      const d = Math.hypot(cx - koDiscs[k], cz - koDiscs[k + 1]);
      const r = koDiscs[k + 2];
      if (d < r - HALF_DIAG) return false;
      if (d < r + HALF_DIAG) info.checkKo = true;
    }

    const rd = roadAt(cx, cz);
    if (rd < ROAD_CLEAR - HALF_DIAG) return false;
    if (rd < ROAD_CLEAR + HALF_DIAG) info.checkRoad = true;
    if (rd < ROAD_CLEAR + 4) info.height *= 1.25;   // uncut verge and ditch

    if (town && town.r > 0) {
      const d = Math.hypot(cx - town.x, cz - town.z);
      if (d < town.r * 0.6) return false;           // village core: streets and yards
      if (d < town.r) {
        const t = (d - town.r * 0.6) / (town.r * 0.4);
        info.density *= 0.35 + 0.65 * t;
        info.height *= 0.7 + 0.3 * t;
      }
    }

    for (let k = 0; k < lotDiscs.length; k += 3) {
      const d = Math.hypot(cx - lotDiscs[k], cz - lotDiscs[k + 1]);
      const r = lotDiscs[k + 2];
      if (d < r - HALF_DIAG) return false;
      if (d < r + HALF_DIAG) info.checkLot = true;
    }

    // slope, sampled the way terrainSlope does (±1.6 m)
    const e = 1.6;
    const sdx = heightAt(cx - e, cz) - heightAt(cx + e, cz);
    const sdz = heightAt(cx, cz - e) - heightAt(cx, cz + e);
    const slope = Math.sqrt(sdx * sdx + sdz * sdz) / (2 * e);
    if (slope > SLOPE_MAX) return false;
    if (slope > 0.3) info.density *= 1 - 0.75 * smoothstep(0.3, SLOPE_MAX, slope);

    for (let k = 0; k < woodDiscs.length; k += 3) {
      const dx = cx - woodDiscs[k];
      const dz = cz - woodDiscs[k + 1];
      const r = woodDiscs[k + 2];
      if (dx * dx + dz * dz < r * r) {
        info.density *= 0.4;
        info.height *= 0.8;
        info.shade *= 0.78;
        break;
      }
    }

    const pc = parcel(cx, cz);
    if (pc) {
      const crop = cropIndexOf(pc.crop);
      const edge = Number.isFinite(pc.edgeDist) ? pc.edgeDist : 1e9;
      if (edge < 3 + HALF_DIAG) {
        info.checkParcel = true;          // straddles a field boundary: decide per tuft
      } else if (crop === 3) {
        return false;                     // ploughed
      } else if (look.useCrops) {
        applyCrop(info, crop, edge);
      }
    }

    return info.density > 0.001;
  }

  const green = look.green;
  const dryC = look.dry;

  function fillCell(slot, ci, cj) {
    const base = slot * K;
    const cx = (ci + 0.5) * CELL;
    const cz = (cj + 0.5) * CELL;
    const ok = classifyCell(cx, cz);
    const info = cellInfo;
    const u0 = hash3(ci, cj, 101);
    const v0 = hash3(ci, cj, 202);

    for (let k = 0; k < K; k++) {
      const mo = (base + k) * 16;
      const co = (base + k) * 3;
      if (!ok) { writeEmpty(matArr, mo); continue; }

      // R2 low-discrepancy points inside the cell: even cover without a grid
      const u = (u0 + k * 0.7548776662) % 1;
      const v = (v0 + k * 0.5698402910) % 1;
      const x = (ci + u) * CELL;
      const z = (cj + v) * CELL;

      const hA = hash3(ci * 31 + k, cj * 17 - k, 303);
      const hB = hash3(ci - k * 7, cj + k * 13, 404);
      const hC = hash3(ci + k * 5, cj * 3 + k, 505);

      let density = info.density;
      let height = info.height;
      let dry = info.dry;
      let shade = info.shade;
      let cropCol = info.cropCol;

      if (info.checkKo) {
        let inside = false;
        for (let q = 0; q < koDiscs.length; q += 3) {
          const dx = x - koDiscs[q];
          const dz = z - koDiscs[q + 1];
          if (dx * dx + dz * dz < koDiscs[q + 2] * koDiscs[q + 2]) { inside = true; break; }
        }
        if (inside) { writeEmpty(matArr, mo); continue; }
      }
      if (info.checkRoad && roadAt(x, z) < ROAD_CLEAR) { writeEmpty(matArr, mo); continue; }
      if (info.checkLot) {
        let inside = false;
        for (let q = 0; q < lotDiscs.length; q += 3) {
          const dx = x - lotDiscs[q];
          const dz = z - lotDiscs[q + 1];
          if (dx * dx + dz * dz < lotDiscs[q + 2] * lotDiscs[q + 2]) { inside = true; break; }
        }
        if (inside) { writeEmpty(matArr, mo); continue; }
      }
      if (info.checkParcel) {
        const pc = parcel(x, z);
        if (pc) {
          const crop = cropIndexOf(pc.crop);
          const edge = Number.isFinite(pc.edgeDist) ? pc.edgeDist : 1e9;
          if (crop === 3 && edge >= 3) { writeEmpty(matArr, mo); continue; }
          if (look.useCrops) {
            if (edge < 3) {
              height *= 1.5;
              shade *= 0.9;
              cropCol = null;
            } else {
              const st = CROP_STYLE[crop] || CROP_STYLE[0];
              density *= st.d;
              height *= st.h;
              dry = Math.min(1, dry + st.dry);
              cropCol = look.cropLin[crop] || null;
            }
          }
        }
      }

      // patches: clumps of taller growth every ~9 m, drier ground every ~30 m
      const patch = vnoise(x * 0.11, z * 0.11, 17);
      const broad = vnoise(x * 0.033, z * 0.033, 29);
      const keep = Math.min(1, density * keepBoost * (0.35 + 0.85 * patch));
      if (hA >= keep) { writeEmpty(matArr, mo); continue; }

      const y = heightAt(x, z) - 0.04;
      const hMetres = look.height * height * (0.62 + 0.7 * patch) * (0.8 + 0.4 * hB);
      const wMetres = look.width * (0.75 + 0.5 * hC) * (cropCol ? 0.8 : 1);
      const yaw = hB * 6.283185307;
      const c = Math.cos(yaw) * wMetres;
      const s = Math.sin(yaw) * wMetres;

      matArr[mo] = c; matArr[mo + 1] = 0; matArr[mo + 2] = -s; matArr[mo + 3] = 0;
      matArr[mo + 4] = 0; matArr[mo + 5] = hMetres; matArr[mo + 6] = 0; matArr[mo + 7] = 0;
      matArr[mo + 8] = s; matArr[mo + 9] = 0; matArr[mo + 10] = c; matArr[mo + 11] = 0;
      matArr[mo + 12] = x; matArr[mo + 13] = y; matArr[mo + 14] = z; matArr[mo + 15] = 1;

      // colour: green to straw by the broad dry patches, a little value jitter
      const dryT = Math.min(1, Math.max(0, dry + (broad - 0.45) * 0.9 + (hC - 0.5) * 0.3));
      const val = (0.86 + 0.26 * hA / Math.max(keep, 1e-3)) * shade;
      let r, g, b;
      if (cropCol) {
        r = cropCol[0]; g = cropCol[1]; b = cropCol[2];
        const jit = 0.9 + 0.2 * hC;
        r *= jit; g *= jit; b *= jit;
      } else {
        r = green[0] + (dryC[0] - green[0]) * dryT;
        g = green[1] + (dryC[1] - green[1]) * dryT;
        b = green[2] + (dryC[2] - green[2]) * dryT;
      }
      colorArr[co] = r * val;
      colorArr[co + 1] = g * val;
      colorArr[co + 2] = b * val;
    }
    if (!slotDirty[slot]) { slotDirty[slot] = 1; dirtySlots.push(slot); }
  }

  function releaseSlot(slot) {
    slotUsed[slot] = 0;
    freeSlots.push(slot);
    const base = slot * K;
    for (let k = 0; k < K; k++) writeEmpty(matArr, (base + k) * 16);
    if (!slotDirty[slot]) { slotDirty[slot] = 1; dirtySlots.push(slot); }
  }

  function flushAll() {
    for (let s = 0; s < slotCount; s++) {
      if (slotUsed[s]) releaseSlot(s);
    }
    active.clear();
  }

  function upload() {
    if (!dirtySlots.length) return;
    const im = mesh.instanceMatrix;
    const ic = mesh.instanceColor;
    im.clearUpdateRanges();
    ic.clearUpdateRanges();
    if (dirtySlots.length <= 48) {
      dirtySlots.sort((a, b) => a - b);
      let runStart = dirtySlots[0];
      let prev = runStart;
      const emit = (a, bEnd) => {
        im.addUpdateRange(a * K * 16, (bEnd - a + 1) * K * 16);
        ic.addUpdateRange(a * K * 3, (bEnd - a + 1) * K * 3);
      };
      for (let n = 1; n < dirtySlots.length; n++) {
        const s = dirtySlots[n];
        if (s !== prev + 1) { emit(runStart, prev); runStart = s; }
        prev = s;
      }
      emit(runStart, prev);
    }
    // no ranges = the whole buffer goes up, cheaper than hundreds of small ones
    im.needsUpdate = true;
    ic.needsUpdate = true;
    for (let n = 0; n < dirtySlots.length; n++) slotDirty[dirtySlots[n]] = 0;
    dirtySlots.length = 0;
  }

  // ---- per frame ---------------------------------------------------------------
  const camPos = new THREE.Vector3();
  let lastCi = null;
  let lastCj = null;
  let pending = false;       // cells still waiting for a slot after a partial fill
  const t0 = nowMs();

  function update(camera) {
    if (disposed) return;
    uniforms.uGcTime.value = (nowMs() - t0) / 1000;
    if (!camera) return;

    if (camera.parent && !camera.parent.isScene && typeof camera.getWorldPosition === 'function') {
      camera.getWorldPosition(camPos);
    } else if (camera.position) {
      camPos.copy(camera.position);
    } else if (Number.isFinite(camera.x) && Number.isFinite(camera.z)) {
      camPos.set(camera.x, Number(camera.y) || 0, camera.z);
    } else {
      return;
    }
    if (!Number.isFinite(camPos.x) || !Number.isFinite(camPos.z)) return;

    // high above the ground (a plane, a spectator orbit) every tuft is past the
    // fade: hide the draw call and do no work until the camera comes back down
    const above = camPos.y - heightAt(camPos.x, camPos.z);
    if (above > tier.radius) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;

    if (readKeepOuts()) {
      flushAll();
      pending = true;
    }

    const ci = Math.floor(camPos.x / CELL);
    const cj = Math.floor(camPos.z / CELL);
    const moved = ci !== lastCi || cj !== lastCj;
    if (!moved && !pending) return;

    if (moved) {
      // cells that fell out of the ring give their slots back
      const r2 = ring.reachCells2;
      for (let s = 0; s < slotCount; s++) {
        if (!slotUsed[s]) continue;
        const di = activeI[s] - ci;
        const dj = activeJ[s] - cj;
        if (di * di + dj * dj > r2) {
          active.delete(cellKey(activeI[s], activeJ[s]));
          releaseSlot(s);
        }
      }
      lastCi = ci;
      lastCj = cj;
    }

    // cells that entered it, nearest first, with a per-update cap
    let made = 0;
    pending = false;
    for (let n = 0; n < slotCount; n++) {
      const i = ci + ring.di[n];
      const j = cj + ring.dj[n];
      const key = cellKey(i, j);
      if (active.has(key)) continue;
      if (made >= MAX_CELLS_PER_UPDATE || !freeSlots.length) { pending = true; break; }
      const slot = freeSlots.pop();
      slotUsed[slot] = 1;
      activeI[slot] = i;
      activeJ[slot] = j;
      active.set(key, slot);
      fillCell(slot, i, j);
      made++;
    }
    upload();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    active.clear();
    freeSlots.length = 0;
    disposeMesh(mesh);
  }

  return { mesh, update, dispose };
}

function setupMesh(mesh) {
  mesh.name = 'groundcover';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.userData.groundCover = true;
  mesh.userData.visualOnly = true;
  // never a shell, bullet or picking target
  mesh.raycast = () => {};
}

function disposeMesh(mesh) {
  if (mesh.parent) mesh.parent.remove(mesh);
  mesh.geometry?.dispose?.();
  const m = mesh.material;
  if (Array.isArray(m)) m.forEach((x) => x?.dispose?.());
  else m?.dispose?.();
  mesh.dispose?.();
}

function safeCall(fn) {
  try { return fn(); } catch { return null; }
}

function nowMs() {
  const p = globalThis.performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}
