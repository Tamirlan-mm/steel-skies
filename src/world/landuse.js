// Land use: fields, hedgerows, woods, orchards, village lots and pole lines.
//
// CONTRACT L (audit maps.md). Everything here is a deterministic function of the
// terrain feature set and the biome: no Math.random anywhere, so the terrain
// shader, the scenery, the ground cover and any future AI hookup all agree on
// where a hedge or a wood is without passing state around.
//
//   landUseFor(features, preset, helpers) -> LandUse   (memoised per features
//     object identity and preset biome; helpers = { terrainHeight, terrainSlope,
//     roadDistanceAt })
//   LANDUSE_GLSL: the parcel and wood fields for the terrain fragment shader,
//     mirroring parcelAt()/woodAt() below.
//
// ---------------------------------------------------------------------------
// Conventions every consumer relies on
//
// * Parcel scheme (identical in JS and GLSL). World XZ is rotated by uLuAngle
//   (u = x cos a + z sin a, v = -x sin a + z cos a), then domain-warped by a
//   sinusoid of wavelength 170 m and amplitude uLuWarp whose phase drifts slowly
//   (610 m / 530 m) so neighbouring boundaries do not wave in lockstep:
//     u' = u + W sin(v k + ph1 + 2 sin(u k3 + ph3))
//     v' = v + W sin(u k + ph2 + 2 sin(v k4 + ph4))
//   Rows are fixed depth uLuCell.y in v'. Each row is shifted by a brick offset
//   hash(row) * uLuCell.x, and column boundaries sit at
//   (i + 0.5 + (hash(i, row) - 0.5) * 0.6) * uLuCell.x.
// * Hash: an integer-exact permutation mod the prime 4091 (a linear scramble,
//   then x -> x^3 + 1, bijective because 4091 = 2 mod 3). Every intermediate is an
//   integer below 2^24, so float32 on the GPU and float64 here agree bit for bit
//   whatever the driver does with rounding or fused multiply-add. It is the
//   "hash without sine" of the contract in the form that actually delivers the
//   float32/float64 agreement the contract chose it for.
// * luParcel / parcelAt:
//     x / hash      parcel hash 0..1 (k / 4091)
//     y / crop      0 pasture, 1 wheat, 2 stubble, 3 plough, 4 fallow, 5 orchard grass
//     z / edgeDist  metres to the nearest parcel boundary (warped-frame distance
//                   divided by the warp's gradient length: true metres to first
//                   order). EXCLUDED parcels and biomes without fields report 999:
//                   there is no field edge to draw there.
//     w / rowAngle  world angle of the crop rows: they run along (cos w, sin w) in
//                   world (x, z).
// * Exclusions (-> pasture, no hedge): the parcel rectangle (warped layout frame)
//   comes within 75 m of the origin (the cap) or within town radius + 12 m of the
//   town centre, or the parcel's centre has road distance < 14 m. Hedge and fence
//   polylines are additionally gapped wherever they come within 14 m (hedge) /
//   9 m (fence) of the road, 75 m of the cap or town radius + 12 m (hedge).
// * uLuWood[24] layout (private to this file; the terrain only calls luWood()):
//     [0] = crop thresholds T0..T3            [1] = (T4, capKeep, townU, townV)
//     [2] = (townKeep, roadPoints, p0u, p0v)  [3] = (p1u, p1v, p2u, p2v)
//     [4] = (p3u, p3v, p4u, p4v)              (road and town in the rotated frame)
//     [5..23] = wood capsules (ax, az, r, packedB), B packed as
//               (bx + 2048) * 4096 + (bz + 2048), integer metres.
// * Rectangles (lots, orchards) use three.js rotation.y = yaw: local +X maps to
//   world (cos yaw, -sin yaw), local +Z to (sin yaw, cos yaw); w runs along local
//   X, d along local Z. For lots, local +Z faces the street (buildingKit's front).
// * edges[i].pts is the sampled boundary polyline [x0, z0, x1, z1, ...] at ~4 m
//   spacing; ax/az/bx/bz are its ends (the boundary is curved wherever the biome
//   warps, so place along pts, not along the chord). gaps are [t0, t1] fractions
//   of the polyline's arc length (edges[i].len metres); edgePointAt(edge, t)
//   evaluates a point. parcels = [idA, idB] (the ids parcelAt returns).
// * woods[i].lobes are discs (x, z, r) covering the wood; woods[i].caps are the
//   exact capsules luWood()/woodAt() use. woodAt(x, z) is the JS twin of luWood.
// * Coverage: edges and orchards cover |x|, |z| <= params.extent (1300 m, the air
//   map); lots, poles and woods sit in the ground-battle square plus a ring for
//   the combined map. Keep-outs are unknown here: scenery filters by keepOuts().
// ---------------------------------------------------------------------------

import * as THREE from 'three';

const LU_P = 4091;
const LU_K = 6.2831853 / 170;
const LU_K3 = 6.2831853 / 610;
const LU_K4 = 6.2831853 / 530;
const HALF_PI = 1.5707963;
const EXTENT = 1300;
const CAP_KEEP = 75;
const TOWN_KEEP = 12;
const ROAD_KEEP = 14;
const FENCE_ROAD_KEEP = 9;
const GAP_MARGIN = 2.5;        // >= half the polyline step, so interpolated clumps keep the distance too
const NO_EDGE = 999;
const WOOD_SLOTS = 24;
const WOOD_FIRST = 5;
const PACK = 4096;
const PACK_OFF = 2048;
const ROW_FLIP = 900;          // of 4091: ~22% of parcels are worked across their long axis
const EDGE_STEP = 4;
const OCC_CELL = 8;
const PLAY_HALF = 420;

// Ground-battle spawn boxes (battle.js teamSpawnPose: x = +/-330 +/- 20, z -135..135).
const SPAWN_BOXES = [
  { x: -330, z: 0, hx: 45, hz: 160 },
  { x: 330, z: 0, hx: 45, hz: 160 },
];

// Share of the +/-420 m play square that woods may cover (audit canopy targets,
// with headroom for the gaps scenery leaves inside a wood).
const WOOD_AREA_CAP = { meadow: 0.19, steppe: 0.08, winter: 0.4, desert: 0.012 };
const WOOD_ELONG = { broadleaf: 0.55, mixed: 0.7, conifer: 1.0, palm: 0 };

// ---------------------------------------------------------------------------
// GLSL
export const LANDUSE_GLSL = /* glsl */ `
  // ---- land use (world/landuse.js): parcels and woods -----------------------
  uniform float uLuSeed;
  uniform vec2 uLuCell;
  uniform float uLuAngle;
  uniform float uLuWarp;
  uniform vec3 uLuCrop[6];
  uniform vec4 uLuWood[24];

  #define LU_P 4091.0
  #define LU_K (6.2831853 / 170.0)
  #define LU_K3 (6.2831853 / 610.0)
  #define LU_K4 (6.2831853 / 530.0)

  float luMod(float x) {
    float r = x - LU_P * floor(x / LU_P);
    r -= LU_P * step(LU_P - 0.5, r);
    r += LU_P * step(r, -0.5);
    return r;
  }
  float luPerm(float x) {
    float y = luMod(x * 1597.0 + 2111.0);
    return luMod(luMod(y * y) * y + 1.0);
  }
  float luHash(float a, float b, float ch) {
    float h = luPerm(luMod(a + uLuSeed));
    h = luPerm(luMod(h + b));
    return luPerm(luMod(h + ch));
  }
  float luBound(float i, float row) {
    return (i + 0.5 + (luHash(i, row, 0.0) / LU_P - 0.5) * 0.6) * uLuCell.x;
  }
  float luBoxDist(vec2 p, vec2 lo, vec2 hi) {
    vec2 d = max(max(lo - p, p - hi), vec2(0.0));
    return length(d);
  }
  float luSegDist(vec2 p, vec2 a, vec2 b) {
    vec2 ab = b - a;
    float l2 = dot(ab, ab);
    float t = l2 > 1e-6 ? clamp(dot(p - a, ab) / l2, 0.0, 1.0) : 0.0;
    return length(a + ab * t - p);
  }
  bool luExcluded(vec2 lo, vec2 hi) {
    if (luBoxDist(vec2(0.0), lo, hi) < uLuWood[1].y) return true;
    if (uLuWood[2].x > 0.0 && luBoxDist(uLuWood[1].zw, lo, hi) < uLuWood[2].x) return true;
    int n = int(uLuWood[2].y + 0.5);
    vec2 pts[5] = vec2[5](uLuWood[2].zw, uLuWood[3].xy, uLuWood[3].zw, uLuWood[4].xy, uLuWood[4].zw);
    vec2 c = 0.5 * (lo + hi);
    for (int i = 0; i < 4; i++) {
      if (i + 1 >= n) break;
      if (luSegDist(c, pts[i], pts[i + 1]) < 14.0) return true;
    }
    return false;
  }

  // x = parcel hash 0..1, y = crop index 0..5, z = metres to the nearest parcel
  // edge (999 where there is no field), w = world angle of the crop rows
  vec4 luParcel(vec2 wp) {
    float ca = cos(uLuAngle);
    float sa = sin(uLuAngle);
    float u = wp.x * ca + wp.y * sa;
    float v = wp.y * ca - wp.x * sa;
    float ph1 = fract(uLuSeed * 0.6180339) * 6.2831853;
    float ph2 = fract(uLuSeed * 0.7548777) * 6.2831853;
    float ph3 = fract(uLuSeed * 0.3819660) * 6.2831853;
    float ph4 = fract(uLuSeed * 0.8660254) * 6.2831853;
    float mu = u * LU_K3 + ph3;
    float mv = v * LU_K4 + ph4;
    float au = v * LU_K + ph1 + 2.0 * sin(mu);
    float av = u * LU_K + ph2 + 2.0 * sin(mv);
    float wu = u + uLuWarp * sin(au);
    float wv = v + uLuWarp * sin(av);
    float cw = uLuCell.x;
    float cd = uLuCell.y;
    float row = floor(wv / cd);
    float off = luHash(row, 1511.0, 1.0) / LU_P * cw;
    float uc = wu + off;
    float i0 = floor(uc / cw);
    float col = i0;
    float bL;
    float bR = luBound(i0, row);
    if (uc >= bR) {
      col = i0 + 1.0;
      bL = bR;
      bR = luBound(col, row);
    } else {
      bL = luBound(i0 - 1.0, row);
    }
    float h = luHash(col, row, 2.0);
    bool alongU = (bR - bL) >= cd;
    if (luHash(col, row, 3.0) < 900.0) alongU = !alongU;
    float ang = alongU ? uLuAngle : uLuAngle + 1.5707963;
    if (uLuWood[0].x > LU_P - 0.5) return vec4(h / LU_P, 0.0, 999.0, ang);
    vec2 lo = vec2(bL - off, row * cd);
    vec2 hi = vec2(bR - off, row * cd + cd);
    if (luExcluded(lo, hi)) return vec4(h / LU_P, 0.0, 999.0, ang);
    float crop = step(uLuWood[0].x - 0.5, h) + step(uLuWood[0].y - 0.5, h)
               + step(uLuWood[0].z - 0.5, h) + step(uLuWood[0].w - 0.5, h)
               + step(uLuWood[1].x - 0.5, h);
    float cu = uLuWarp * cos(au);
    float cv = uLuWarp * cos(av);
    float gu = length(vec2(1.0 + cu * 2.0 * LU_K3 * cos(mu), cu * LU_K));
    float gv = length(vec2(cv * LU_K, 1.0 + cv * 2.0 * LU_K4 * cos(mv)));
    float e = min(min(uc - bL, bR - uc) / gu, min(wv - row * cd, row * cd + cd - wv) / gv);
    return vec4(h / LU_P, crop, max(e, 0.0), ang);
  }

  // 0..1 inside a wood patch: 1 from 6 m inside a lobe's edge, 0 from 2 m outside
  float luWood(vec2 wp) {
    float w = 0.0;
    for (int i = 5; i < 24; i++) {
      vec4 c = uLuWood[i];
      if (c.z <= 0.0) continue;
      float bx = floor(c.w / 4096.0);
      float bz = c.w - bx * 4096.0;
      float d = luSegDist(wp, c.xy, vec2(bx - 2048.0, bz - 2048.0));
      w = max(w, 1.0 - smoothstep(c.z - 6.0, c.z + 2.0, d));
    }
    return w;
  }
`;

// ---------------------------------------------------------------------------
// Fallbacks for anything presets.js does not carry. A preset's own `landuse`
// block, `cropCols` and `architecture` win field by field.
const BIOME_DEFAULTS = {
  meadow: {
    architecture: 'normandy',
    cell: [125, 95], warp: 12, hedgeChance: 0.85, fenceChance: 0.1, orchardChance: 0.1,
    crops: { pasture: 0.5, wheat: 0.18, stubble: 0.07, plough: 0.1, fallow: 0.15 },
    woods: { count: 5, r: [45, 90], types: ['broadleaf', 'mixed'] },
    fields: true, roadTrees: 'poplar', hedgeStyle: 'bocage',
    cropCols: [0x4e6e32, 0xa8944f, 0x9f8f65, 0x67513d, 0x6f6f43, 0x4a6730],
  },
  steppe: {
    architecture: 'khata',
    cell: [420, 260], warp: 4, hedgeChance: 0.1, fenceChance: 0.05, orchardChance: 0.04,
    crops: { pasture: 0.18, wheat: 0.36, stubble: 0.14, plough: 0.12, fallow: 0.2 },
    woods: { count: 4, r: [28, 60], types: ['broadleaf', 'mixed'] },
    fields: true, roadTrees: 'poplar', hedgeStyle: 'belt',
    cropCols: [0x8a8351, 0xb2974f, 0xa0926a, 0x574c40, 0x77754a, 0x62683a],
  },
  winter: {
    architecture: 'nordic',
    cell: [170, 120], warp: 8, hedgeChance: 0, fenceChance: 0.35, orchardChance: 0,
    crops: { pasture: 0.45, wheat: 0, stubble: 0.25, plough: 0.1, fallow: 0.2 },
    woods: { count: 7, r: [90, 140], types: ['conifer', 'mixed'] },
    fields: true, roadTrees: null, hedgeStyle: 'bocage',
    cropCols: [0xe3e9ee, 0xdbdbd1, 0xd6d4c9, 0xccd2d9, 0xd8d9d4, 0xdde2e6],
  },
  desert: {
    architecture: 'desert',
    cell: [6000, 6000], warp: 0, hedgeChance: 0, fenceChance: 0, orchardChance: 0,
    crops: { pasture: 1, wheat: 0, stubble: 0, plough: 0, fallow: 0 },
    woods: { count: 2, r: [16, 28], types: ['palm'] },
    fields: false, roadTrees: null, hedgeStyle: 'bocage',
    cropCols: [0xc4a56b, 0xc4a56b, 0xc4a56b, 0xc4a56b, 0xc4a56b, 0xc4a56b],
  },
};
const BIOME_ALIASES = { bocage: 'meadow' };
const FARMS = { meadow: 4, steppe: 2, winter: 3, desert: 2 };

// How a roadside row is laid out when the preset names a tree for it.
const ROAD_ROWS = {
  meadow: { stretches: 2, len: [140, 230], spacing: 9, offset: 10.5, sides: 2 },
  steppe: { stretches: 2, len: [260, 400], spacing: 7, offset: 11, sides: 1 },
  default: { stretches: 1, len: [120, 200], spacing: 9, offset: 10.5, sides: 2 },
};

// Footprints [w, d] per architecture (w along the street, d away from it).
const STYLE_DIMS = {
  normandy: { house: [10, 8], barn: [18, 9], shed: [5.5, 4.5], church: [12, 28] },
  izba: { house: [7, 9.5], barn: [12, 7], shed: [4.5, 4.5], church: [10, 20] },
  khata: { house: [10, 6.5], barn: [12, 7], shed: [4.5, 4], church: [10, 20] },
  desert: { house: [8.5, 8.5], barn: [11, 9], shed: [4.5, 4.5], church: [13, 13] },
  nordic: { house: [9, 7], barn: [13, 8], shed: [4.5, 4], church: [10, 22] },
};

// ---------------------------------------------------------------------------
// Integer-exact hash (mirrors the GLSL operation for operation).
function luMod(x) {
  let r = x - LU_P * Math.floor(x / LU_P);
  if (r >= LU_P) r -= LU_P;
  if (r < 0) r += LU_P;
  return r;
}
function luPerm(x) {
  const y = luMod(x * 1597 + 2111);
  return luMod(luMod(y * y) * y + 1);
}
function luHash(a, b, ch, s) {
  let h = luPerm(luMod(a + s));
  h = luPerm(luMod(h + b));
  return luPerm(luMod(h + ch));
}

// Seeded generator for placement (woods, lots, poles). Integer maths only.
function makeRng(seed) {
  let a = seed | 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// 2D distance helpers (float64 twins of the GLSL ones).
function boxDist(px, pz, lox, loz, hix, hiz) {
  const dx = Math.max(lox - px, px - hix, 0);
  const dz = Math.max(loz - pz, pz - hiz, 0);
  return Math.sqrt(dx * dx + dz * dz);
}

function segDist(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = 0;
  if (l2 > 1e-6) {
    t = ((px - ax) * abx + (pz - az) * abz) / l2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const qx = ax + abx * t - px;
  const qz = az + abz * t - pz;
  return Math.sqrt(qx * qx + qz * qz);
}

// exact distance between a segment and an axis-aligned box (0 when they touch)
function segBoxDist(ax, az, bx, bz, lox, loz, hix, hiz) {
  const a = [ax, az];
  const d = [bx - ax, bz - az];
  const lo = [lox, loz];
  const hi = [hix, hiz];
  let t0 = 0;
  let t1 = 1;
  let hit = true;
  for (let k = 0; k < 2; k++) {
    if (Math.abs(d[k]) < 1e-9) {
      if (a[k] < lo[k] || a[k] > hi[k]) hit = false;
    } else {
      const ta = (lo[k] - a[k]) / d[k];
      const tb = (hi[k] - a[k]) / d[k];
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
  }
  if (hit && t0 <= t1) return 0;
  let m = Math.min(boxDist(ax, az, lox, loz, hix, hiz), boxDist(bx, bz, lox, loz, hix, hiz));
  m = Math.min(m, segDist(lox, loz, ax, az, bx, bz));
  m = Math.min(m, segDist(hix, hiz, ax, az, bx, bz));
  m = Math.min(m, segDist(lox, hiz, ax, az, bx, bz));
  m = Math.min(m, segDist(hix, loz, ax, az, bx, bz));
  return m;
}

// ---------------------------------------------------------------------------
// Oriented rectangles (three.js rotation.y convention, see header).
function rectAxes(r) {
  const c = Math.cos(r.yaw);
  const s = Math.sin(r.yaw);
  return { xx: c, xz: -s, zx: s, zz: c };
}

function rectCorners(r) {
  const a = rectAxes(r);
  const hw = r.w / 2;
  const hd = r.d / 2;
  const out = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    out.push(r.x + a.xx * hw * sx + a.zx * hd * sz, r.z + a.xz * hw * sx + a.zz * hd * sz);
  }
  return out;
}

function toLocal(r, px, pz) {
  const a = rectAxes(r);
  const dx = px - r.x;
  const dz = pz - r.z;
  return [dx * a.xx + dz * a.xz, dx * a.zx + dz * a.zz];
}

function rectsOverlap(p, q, pad) {
  const cp = rectCorners(p);
  const cq = rectCorners(q);
  for (const a of [rectAxes(p), rectAxes(q)]) {
    for (const [ax, az] of [[a.xx, a.xz], [a.zx, a.zz]]) {
      let pMin = Infinity; let pMax = -Infinity; let qMin = Infinity; let qMax = -Infinity;
      for (let i = 0; i < 8; i += 2) {
        const vp = cp[i] * ax + cp[i + 1] * az;
        const vq = cq[i] * ax + cq[i + 1] * az;
        if (vp < pMin) pMin = vp;
        if (vp > pMax) pMax = vp;
        if (vq < qMin) qMin = vq;
        if (vq > qMax) qMax = vq;
      }
      if (pMax + pad <= qMin || qMax + pad <= pMin) return false;
    }
  }
  return true;
}

function pointInRect(r, px, pz, pad) {
  const [lx, lz] = toLocal(r, px, pz);
  return Math.abs(lx) <= r.w / 2 + pad && Math.abs(lz) <= r.d / 2 + pad;
}

// ---------------------------------------------------------------------------
// Road polyline in world space.
function roadModel(points) {
  const segs = [];
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1e-6;
    segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, len, tx: (b.x - a.x) / len, tz: (b.z - a.z) / len, s0: total });
    total += len;
  }
  return {
    segs,
    total,
    pointAt(s) {
      if (!segs.length) return { x: 0, z: 0, tx: 1, tz: 0 };
      let g = segs[segs.length - 1];
      for (const sg of segs) {
        if (s <= sg.s0 + sg.len) { g = sg; break; }
      }
      const t = Math.max(0, Math.min(g.len, s - g.s0));
      return { x: g.ax + g.tx * t, z: g.az + g.tz * t, tx: g.tx, tz: g.tz };
    },
    nearest(px, pz) {
      let best = { x: px, z: pz, s: 0, d: Infinity, tx: 1, tz: 0 };
      for (const g of segs) {
        let t = (px - g.ax) * g.tx + (pz - g.az) * g.tz;
        t = Math.max(0, Math.min(g.len, t));
        const x = g.ax + g.tx * t;
        const z = g.az + g.tz * t;
        const d = Math.hypot(px - x, pz - z);
        if (d < best.d) best = { x, z, s: g.s0 + t, d, tx: g.tx, tz: g.tz };
      }
      return best;
    },
    distance(px, pz) {
      let d = Infinity;
      for (const g of segs) d = Math.min(d, segDist(px, pz, g.ax, g.az, g.bx, g.bz));
      return d;
    },
  };
}

function spawnDist(x, z) {
  let best = Infinity;
  for (const b of SPAWN_BOXES) {
    best = Math.min(best, boxDist(x, z, b.x - b.hx, b.z - b.hz, b.x + b.hx, b.z + b.hz));
  }
  return best;
}

// ---------------------------------------------------------------------------
// Config: biome defaults overlaid with whatever the preset carries.
function biomeKeyOf(preset) {
  if (preset && typeof preset.biome === 'string') return preset.biome;
  const n = preset && typeof preset.name === 'string' ? preset.name.toLowerCase() : '';
  if (BIOME_DEFAULTS[n]) return n;
  if (BIOME_ALIASES[n]) return BIOME_ALIASES[n];
  return 'meadow';
}

function resolveConfig(preset, biome) {
  const base = BIOME_DEFAULTS[biome] || BIOME_DEFAULTS.meadow;
  const src = (preset && typeof preset.landuse === 'object' && preset.landuse) || {};
  const cfg = {
    architecture: base.architecture,
    cell: base.cell.slice(),
    warp: base.warp,
    angleOffset: { meadow: 0.12, steppe: 0, winter: 0.3, desert: 0 }[biome] ?? 0.12,
    hedgeChance: base.hedgeChance,
    fenceChance: base.fenceChance,
    orchardChance: base.orchardChance,
    crops: { ...base.crops },
    woods: { count: base.woods.count, r: base.woods.r.slice(), types: base.woods.types.slice() },
    fields: base.fields,
    roadTrees: base.roadTrees,
    hedgeStyle: base.hedgeStyle,
    farms: FARMS[biome] ?? 3,
    cropCols: base.cropCols.slice(),
  };
  if (Array.isArray(src.cell) && isNum(src.cell[0]) && isNum(src.cell[1])) {
    cfg.cell = [Math.max(20, src.cell[0]), Math.max(20, src.cell[1])];
  }
  for (const k of ['warp', 'angleOffset', 'hedgeChance', 'fenceChance', 'orchardChance', 'farms']) {
    if (isNum(src[k])) cfg[k] = src[k];
  }
  if (src.crops && typeof src.crops === 'object') {
    const c = {};
    for (const k of ['pasture', 'wheat', 'stubble', 'plough', 'fallow']) c[k] = isNum(src.crops[k]) ? Math.max(0, src.crops[k]) : 0;
    cfg.crops = c;
  }
  if (src.woods && typeof src.woods === 'object') {
    if (isNum(src.woods.count)) cfg.woods.count = Math.max(0, Math.round(src.woods.count));
    if (Array.isArray(src.woods.r) && isNum(src.woods.r[0]) && isNum(src.woods.r[1])) {
      cfg.woods.r = [Math.min(src.woods.r[0], src.woods.r[1]), Math.max(src.woods.r[0], src.woods.r[1])];
    }
    if (Array.isArray(src.woods.types)) {
      const t = src.woods.types.filter((x) => typeof x === 'string');
      if (t.length) cfg.woods.types = t;
    }
  }
  if (typeof src.fields === 'boolean') cfg.fields = src.fields;
  if ('roadTrees' in src) cfg.roadTrees = src.roadTrees;
  if (typeof src.hedgeStyle === 'string') cfg.hedgeStyle = src.hedgeStyle;
  const cols = Array.isArray(preset && preset.cropCols) ? preset.cropCols : null;
  if (cols) for (let i = 0; i < 6; i++) if (isNum(cols[i])) cfg.cropCols[i] = cols[i];
  if (preset && typeof preset.architecture === 'string') cfg.architecture = preset.architecture;
  return cfg;
}

function seedFrom(features, biome) {
  let h = 0x811c9dc5 | 0;
  const mix = (v) => {
    h = Math.imul(h ^ (v | 0), 0x01000193);
    h ^= h >>> 15;
  };
  const town = features.town;
  if (town && isNum(town.x) && isNum(town.z)) {
    mix(Math.round(town.x * 100));
    mix(Math.round(town.z * 100));
  }
  for (const p of features.road || []) {
    if (!p) continue;
    mix(Math.round((p.x || 0) * 100));
    mix(Math.round((p.z || 0) * 100));
  }
  for (let i = 0; i < biome.length; i++) mix(biome.charCodeAt(i));
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h ^= h >>> 15;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
const memo = new WeakMap();
const NO_FEATURES = { town: null, road: [], ridges: [], treeline: null, axis: 0 };

export function landUseFor(features, preset, helpers) {
  const feat = features && typeof features === 'object' ? features : NO_FEATURES;
  const biome = biomeKeyOf(preset);
  let byBiome = memo.get(feat);
  if (!byBiome) {
    byBiome = new Map();
    memo.set(feat, byBiome);
  }
  const hit = byBiome.get(biome);
  if (hit) return hit;
  const lu = buildLandUse(feat, preset, biome, helpers || {});
  byBiome.set(biome, lu);
  return lu;
}

function buildLandUse(feat, preset, biome, helpers) {
  const cfg = resolveConfig(preset, biome);
  const seed = seedFrom(feat, biome);
  const seedMod = seed % 997;
  const rngFor = (salt) => makeRng((seed ^ Math.imul(salt, 0x9e3779b1)) | 0);

  const style = cfg.architecture || 'normandy';
  const angle = (isNum(feat.axis) ? feat.axis : 0) + (isNum(cfg.angleOffset) ? cfg.angleOffset : 0);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const W = Math.max(0, isNum(cfg.warp) ? cfg.warp : 0);
  const cw = cfg.cell[0];
  const cd = cfg.cell[1];
  const ph1 = ((seedMod * 0.6180339) % 1) * 6.2831853;
  const ph2 = ((seedMod * 0.7548777) % 1) * 6.2831853;
  const ph3 = ((seedMod * 0.3819660) % 1) * 6.2831853;
  const ph4 = ((seedMod * 0.8660254) % 1) * 6.2831853;

  // crop thresholds: integers, cumulative over 4091
  const wts = [cfg.crops.pasture, cfg.crops.wheat, cfg.crops.stubble, cfg.crops.plough, cfg.crops.fallow];
  const wSum = wts.reduce((a, b) => a + b, 0);
  const orch = clamp01(isNum(cfg.orchardChance) ? cfg.orchardChance : 0);
  const fieldsOn = cfg.fields !== false && wSum > 0 && (wSum - wts[0] > 1e-9 || orch > 0);
  const cropWeights = [];
  const thresholds = [];
  if (fieldsOn) {
    let acc = 0;
    for (let i = 0; i < 5; i++) {
      const f = (wts[i] / wSum) * (1 - orch);
      cropWeights.push(f);
      acc += f;
      thresholds.push(Math.min(LU_P, Math.round(acc * LU_P)));
    }
    cropWeights.push(orch);
  } else {
    for (let i = 0; i < 5; i++) thresholds.push(LU_P);
    cropWeights.push(1, 0, 0, 0, 0, 0);
  }

  const town = feat.town && isNum(feat.town.x) && isNum(feat.town.z)
    ? { x: feat.town.x, z: feat.town.z, r: isNum(feat.town.radius) ? feat.town.radius : 50 }
    : null;
  const roadPts = (feat.road || []).filter((p) => p && isNum(p.x) && isNum(p.z)).slice(0, 5);
  const road = roadModel(roadPts);
  const rot = (x, z) => [x * ca + z * sa, z * ca - x * sa];
  const roadUV = roadPts.map((p) => rot(p.x, p.z));
  const townUV = town ? rot(town.x, town.z) : [0, 0];
  const townKeep = town ? town.r + TOWN_KEEP : 0;

  const hTerrain = typeof helpers.terrainHeight === 'function' ? helpers.terrainHeight : () => 0;
  const hSlope = typeof helpers.terrainSlope === 'function' ? helpers.terrainSlope : () => 0;
  const hRoad = typeof helpers.roadDistanceAt === 'function' ? helpers.roadDistanceAt : (x, z) => road.distance(x, z);

  // ---- parcel core ---------------------------------------------------------
  const bound = (i, row) => (i + 0.5 + (luHash(i, row, 0, seedMod) / LU_P - 0.5) * 0.6) * cw;
  const rowOffset = (row) => (luHash(row, 1511, 1, seedMod) / LU_P) * cw;

  function excludedBox(lox, loz, hix, hiz) {
    if (boxDist(0, 0, lox, loz, hix, hiz) < CAP_KEEP) return true;
    if (townKeep > 0 && boxDist(townUV[0], townUV[1], lox, loz, hix, hiz) < townKeep) return true;
    const cx = 0.5 * (lox + hix);
    const cz = 0.5 * (loz + hiz);
    for (let i = 0; i + 1 < roadUV.length && i < 4; i++) {
      const a = roadUV[i];
      const b = roadUV[i + 1];
      if (segDist(cx, cz, a[0], a[1], b[0], b[1]) < ROAD_KEEP) return true;
    }
    return false;
  }

  const metaCache = new Map();
  function parcelMeta(row, col, bL, bR, off) {
    const key = row * 1048576 + col;
    let m = metaCache.get(key);
    if (m) return m;
    const h = luHash(col, row, 2, seedMod);
    let alongU = (bR - bL) >= cd;
    if (luHash(col, row, 3, seedMod) < ROW_FLIP) alongU = !alongU;
    const excluded = fieldsOn ? excludedBox(bL - off, row * cd, bR - off, row * cd + cd) : true;
    let crop = 0;
    if (fieldsOn && !excluded) for (let k = 0; k < 5; k++) if (h >= thresholds[k]) crop++;
    m = {
      id: (row + 32768) * 65536 + (col + 32768),
      row, col, hash: h / LU_P, crop, excluded,
      rowAngle: alongU ? angle : angle + HALF_PI,
    };
    if (metaCache.size > 200000) metaCache.clear();
    metaCache.set(key, m);
    return m;
  }

  function parcelAt(x, z, out) {
    const u = x * ca + z * sa;
    const v = z * ca - x * sa;
    const mu = u * LU_K3 + ph3;
    const mv = v * LU_K4 + ph4;
    const au = v * LU_K + ph1 + 2 * Math.sin(mu);
    const av = u * LU_K + ph2 + 2 * Math.sin(mv);
    const wu = u + W * Math.sin(au);
    const wv = v + W * Math.sin(av);
    const row = Math.floor(wv / cd);
    const off = rowOffset(row);
    const uc = wu + off;
    const i0 = Math.floor(uc / cw);
    let col = i0;
    let bL;
    let bR = bound(i0, row);
    if (uc >= bR) {
      col = i0 + 1;
      bL = bR;
      bR = bound(col, row);
    } else {
      bL = bound(i0 - 1, row);
    }
    const m = parcelMeta(row, col, bL, bR, off);
    let edgeDist = NO_EDGE;
    if (!m.excluded) {
      const cu = W * Math.cos(au);
      const cv = W * Math.cos(av);
      const gu = Math.hypot(1 + cu * 2 * LU_K3 * Math.cos(mu), cu * LU_K);
      const gv = Math.hypot(cv * LU_K, 1 + cv * 2 * LU_K4 * Math.cos(mv));
      const r0 = row * cd;
      edgeDist = Math.max(0, Math.min(
        Math.min(uc - bL, bR - uc) / gu,
        Math.min(wv - r0, r0 + cd - wv) / gv,
      ));
    }
    const o = out || {};
    o.id = m.id;
    o.crop = m.crop;
    o.edgeDist = edgeDist;
    o.rowAngle = m.rowAngle;
    o.hash = m.hash;
    o.row = m.row;
    o.col = m.col;
    o.excluded = m.excluded;
    return o;
  }

  // warped layout coordinates -> unwarped (u, v): Newton on a near-identity map
  function unwarp(wu, wv, guess) {
    let u = guess ? guess[0] : wu;
    let v = guess ? guess[1] : wv;
    for (let it = 0; it < 30; it++) {
      const mu = u * LU_K3 + ph3;
      const mv = v * LU_K4 + ph4;
      const au = v * LU_K + ph1 + 2 * Math.sin(mu);
      const av = u * LU_K + ph2 + 2 * Math.sin(mv);
      const fu = u + W * Math.sin(au) - wu;
      const fv = v + W * Math.sin(av) - wv;
      if (Math.abs(fu) + Math.abs(fv) < 1e-9) break;
      const cu = W * Math.cos(au);
      const cv = W * Math.cos(av);
      const a = 1 + cu * 2 * LU_K3 * Math.cos(mu);
      const b = cu * LU_K;
      const c = cv * LU_K;
      const d = 1 + cv * 2 * LU_K4 * Math.cos(mv);
      const det = a * d - b * c;
      u -= (d * fu - b * fv) / det;
      v -= (a * fv - c * fu) / det;
    }
    return [u, v];
  }
  const uvToWorld = (u, v) => [u * ca - v * sa, u * sa + v * ca];

  // ---- woods ---------------------------------------------------------------
  const caps = [];   // { ax, az, bx, bz, r } integer metres: the exact shapes luWood sees
  const woods = buildWoods();

  function woodAt(x, z) {
    let w = 0;
    for (let i = 0; i < caps.length; i++) {
      const c = caps[i];
      const d = segDist(x, z, c.ax, c.az, c.bx, c.bz);
      if (d >= c.r + 2) continue;
      const v = 1 - smoothstep(c.r - 6, c.r + 2, d);
      if (v > w) w = v;
    }
    return w;
  }

  function buildWoods() {
    const out = [];
    const rng = rngFor(11);
    const budget = WOOD_SLOTS - WOOD_FIRST;
    const clampI = (v) => Math.max(-PACK_OFF, Math.min(PACK_OFF - 1, Math.round(v)));
    const mkCap = (ax, az, bx, bz, r) => ({ ax: clampI(ax), az: clampI(az), bx: clampI(bx), bz: clampI(bz), r: r1(r) });
    const capDist = (x, z, skip) => {
      let d = Infinity;
      for (const c of caps) {
        if (skip && skip.includes(c)) continue;
        d = Math.min(d, segDist(x, z, c.ax, c.az, c.bx, c.bz) - c.r);
      }
      return d;
    };

    // coverage grid over the play square, for the per-biome area cap
    const G = 10;
    const gN = Math.floor((2 * PLAY_HALF) / G);
    const gFlag = new Uint8Array(gN * gN);
    let gCount = 0;
    const areaCap = WOOD_AREA_CAP[biome] ?? 0.19;
    const gain = (list) => {
      let n = 0;
      for (const c of list) {
        const i0 = Math.max(0, Math.floor((Math.min(c.ax, c.bx) - c.r + PLAY_HALF) / G));
        const i1 = Math.min(gN - 1, Math.floor((Math.max(c.ax, c.bx) + c.r + PLAY_HALF) / G));
        const j0 = Math.max(0, Math.floor((Math.min(c.az, c.bz) - c.r + PLAY_HALF) / G));
        const j1 = Math.min(gN - 1, Math.floor((Math.max(c.az, c.bz) + c.r + PLAY_HALF) / G));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const k = j * gN + i;
            if (gFlag[k] === 1) continue;
            const x = -PLAY_HALF + (i + 0.5) * G;
            const z = -PLAY_HALF + (j + 0.5) * G;
            if (segDist(x, z, c.ax, c.az, c.bx, c.bz) <= c.r - 2) { gFlag[k] = 2; n++; }
          }
        }
      }
      return n;
    };
    const commit = (list, keep) => {
      for (let k = 0; k < gFlag.length; k++) {
        if (gFlag[k] === 2) gFlag[k] = keep ? 1 : 0;
      }
      if (keep) for (const c of list) caps.push(c);
    };
    const tryShape = (list) => {
      const n = gain(list);
      const ok = (gCount + n) / (gN * gN) <= areaCap;
      commit(list, ok);
      if (ok) gCount += n;
      return ok;
    };

    const clearAt = (x, z, r, skip) => {
      if (hRoad(x, z) < r + 16) return false;
      if (Math.hypot(x, z) < r + 100) return false;
      if (town && Math.hypot(x - town.x, z - town.z) < town.r + r + 18) return false;
      if (spawnDist(x, z) < r + 20) return false;
      if (capDist(x, z, skip) < r + 25) return false;
      return true;
    };
    const capsuleClear = (c, lim, skip) => {
      for (let j = 0; j <= 4; j++) {
        const x = c.ax + ((c.bx - c.ax) * j) / 4;
        const z = c.az + ((c.bz - c.az) * j) / 4;
        if (Math.abs(x) > lim || Math.abs(z) > lim) return false;
        if (!clearAt(x, z, c.r, skip)) return false;
      }
      return true;
    };

    // 1) the treeline becomes a wood strip: simplified to a few capsules and
    //    trimmed off the road, the cap and the village
    const tl = feat.treeline;
    if (!cfg.oasis && biome !== 'desert' && tl && Array.isArray(tl.path) && tl.path.length >= 2) {
      const path = tl.path.filter((p) => p && isNum(p.x) && isNum(p.z));
      const r = (isNum(tl.width) ? tl.width : 14) * 0.5 + 3;
      const keyIdx = [0];
      for (let i = 0; i < path.length - 1;) {
        let j = i + 1;
        while (j + 1 < path.length) {
          let ok = true;
          for (let k = i + 1; k <= j; k++) {
            if (segDist(path[k].x, path[k].z, path[i].x, path[i].z, path[j + 1].x, path[j + 1].z) > 3.5) { ok = false; break; }
          }
          if (!ok) break;
          j++;
        }
        keyIdx.push(j);
        i = j;
      }
      const stripCaps = [];
      for (let q = 0; q + 1 < keyIdx.length && caps.length + stripCaps.length < budget - 4; q++) {
        const a = path[keyIdx[q]];
        const b = path[keyIdx[q + 1]];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const n = Math.max(1, Math.ceil(len / 4));
        let runStart = -1;
        const flush = (j0, j1) => {
          if (j1 - j0 < 2) return;
          stripCaps.push(mkCap(a.x + ((b.x - a.x) * j0) / n, a.z + ((b.z - a.z) * j0) / n,
            a.x + ((b.x - a.x) * j1) / n, a.z + ((b.z - a.z) * j1) / n, r));
        };
        for (let j = 0; j <= n; j++) {
          const x = a.x + ((b.x - a.x) * j) / n;
          const z = a.z + ((b.z - a.z) * j) / n;
          const ok = hRoad(x, z) >= r + 8 && Math.hypot(x, z) >= CAP_KEEP + r
            && (!town || Math.hypot(x - town.x, z - town.z) >= town.r + r + 10);
          if (ok && runStart < 0) runStart = j;
          if (!ok && runStart >= 0) { flush(runStart, j - 1); runStart = -1; }
        }
        if (runStart >= 0) flush(runStart, n);
      }
      if (stripCaps.length) {
        gain(stripCaps);
        commit(stripCaps, true);
        gCount = 0;
        for (const f of gFlag) if (f === 1) gCount++;
        const lobes = [];
        let sx = 0; let sz = 0; let cnt = 0;
        let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
        for (const c of stripCaps) {
          const len = Math.hypot(c.bx - c.ax, c.bz - c.az);
          const n = Math.max(1, Math.round(len / (c.r * 0.9)));
          for (let j = 0; j <= n; j++) {
            const x = c.ax + ((c.bx - c.ax) * j) / n;
            const z = c.az + ((c.bz - c.az) * j) / n;
            lobes.push({ x: r1(x), z: r1(z), r: c.r });
            sx += x; sz += z; cnt++;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
          }
        }
        out.push({
          x: r1(sx / cnt), z: r1(sz / cnt), r: r1(Math.hypot(maxX - minX, maxZ - minZ) / 2 + r),
          type: cfg.woods.types.includes('conifer') ? 'conifer' : 'broadleaf',
          lobes, caps: stripCaps, strip: true, outer: false,
        });
      }
    }

    // 2) patches: ridge crests, the flanks and behind the spawns; spread apart
    const ridges = Array.isArray(feat.ridges) ? feat.ridges : [];
    const axis = isNum(feat.axis) ? feat.axis : 0;
    const fcos = Math.cos(axis);
    const fsin = Math.sin(axis);
    const makeCands = (lim, step, ringMin) => {
      const list = [];
      for (let x = -lim; x <= lim + 1e-6; x += step) {
        for (let z = -lim; z <= lim + 1e-6; z += step) {
          if (ringMin > 0 && Math.max(Math.abs(x), Math.abs(z)) < ringMin) continue;
          let s = 0;
          let crest = 0;
          if (cfg.oasis || biome === 'desert') {
            s = -hTerrain(x, z) * 0.12;
          } else {
            const fx = Math.abs(x * fcos + z * fsin);
            for (const rg of ridges) {
              if (!rg || !isNum(rg.offset) || !isNum(rg.width)) continue;
              crest = Math.max(crest, 1 - Math.min(1, Math.abs(fx - rg.offset) / rg.width));
            }
            const az = Math.abs(z);
            const flank = clamp01((az - 120) / 120) - 0.6 * clamp01((az - 390) / 80);
            s = crest * 0.9 + flank * 0.9 + (Math.abs(x) > 380 && az < 300 ? 0.45 : 0);
          }
          // crest woods run along the crest, flank woods along the flank
          const dirA = crest > 0.6 ? axis + HALF_PI : axis;
          list.push({ x, z, s, dirA });
        }
      }
      return list;
    };
    const placePatches = (count, rRange, lim, step, ringMin, outer) => {
      const cands = makeCands(lim, step, ringMin);
      const centres = out.filter((w) => !w.strip).map((w) => [w.x, w.z]);
      for (let k = 0; k < count && caps.length < budget; k++) {
        const reserve = count - k - 1;
        const type = cfg.woods.types[Math.floor(rng() * cfg.woods.types.length)] || 'broadleaf';
        const elong = cfg.oasis || biome === 'desert' ? 0 : (WOOD_ELONG[type] ?? 0.8);
        const rBase = rRange[0] + (rRange[1] - rRange[0]) * rng();
        const lBase = rBase * elong * (0.3 + 0.7 * rng());
        const jitter = cands.map(() => rng() * 0.7);
        const order = cands.map((c, i) => {
          let near = Infinity;
          for (const [px, pz] of centres) near = Math.min(near, Math.hypot(c.x - px, c.z - pz));
          return { c, s: c.s + clamp01(near / 350) + jitter[i] };
        }).sort((p, q) => q.s - p.s);
        let placed = null;
        for (const shrink of [1, 0.8, 0.62]) {
          const r = rBase * shrink;
          const ell = lBase * shrink;
          for (const { c } of order) {
            const dx = Math.cos(c.dirA);
            const dz = Math.sin(c.dirA);
            const main = mkCap(c.x - dx * ell, c.z - dz * ell, c.x + dx * ell, c.z + dz * ell, r);
            if (!capsuleClear(main, lim, null)) continue;
            if (outer) { caps.push(main); placed = { c, main, r, ell, dx, dz }; break; }
            if (tryShape([main])) { placed = { c, main, r, ell, dx, dz }; break; }
            break;   // the best spot would overshoot the area cap: try smaller
          }
          if (placed) break;
        }
        if (!placed) continue;
        const woodCaps = [placed.main];
        const extraMax = Math.max(0, budget - caps.length - reserve);
        const extra = Math.min(extraMax, cfg.oasis || biome === 'desert' ? 1 + Math.floor(rng() * 2) : 1 + Math.floor(rng() * 2.5));
        for (let e = 0; e < extra; e++) {
          for (let tr = 0; tr < 8; tr++) {
            const t = rng() * 2 - 1;
            const side = rng() < 0.5 ? -1 : 1;
            const rr = placed.r * (0.45 + 0.3 * rng());
            const dist = placed.r * (0.55 + 0.45 * rng());
            const x = placed.c.x + placed.dx * placed.ell * t - placed.dz * side * dist;
            const z = placed.c.z + placed.dz * placed.ell * t + placed.dx * side * dist;
            const lobe = mkCap(x, z, x, z, rr);
            if (!capsuleClear(lobe, lim + rr * 0.5, woodCaps)) continue;
            if (outer) { caps.push(lobe); woodCaps.push(lobe); break; }
            if (tryShape([lobe])) { woodCaps.push(lobe); break; }
          }
        }
        let sx = 0; let sz = 0; let reach = 0;
        for (const c of woodCaps) { sx += (c.ax + c.bx) / 2; sz += (c.az + c.bz) / 2; }
        sx /= woodCaps.length;
        sz /= woodCaps.length;
        for (const c of woodCaps) {
          reach = Math.max(reach, Math.hypot(c.ax - sx, c.az - sz) + c.r, Math.hypot(c.bx - sx, c.bz - sz) + c.r);
        }
        // discs covering the wood: capsules are sampled along their axis
        const lobes = [];
        for (const c of woodCaps) {
          const len = Math.hypot(c.bx - c.ax, c.bz - c.az);
          const n = len < 1 ? 0 : Math.max(1, Math.round(len / (c.r * 0.9)));
          for (let j = 0; j <= n; j++) {
            const f = n ? j / n : 0;
            lobes.push({ x: r1(c.ax + (c.bx - c.ax) * f), z: r1(c.az + (c.bz - c.az) * f), r: c.r });
          }
        }
        centres.push([sx, sz]);
        out.push({ x: r1(sx), z: r1(sz), r: r1(reach), type, lobes, caps: woodCaps, strip: false, outer });
      }
    };
    placePatches(cfg.woods.count, cfg.woods.r, 440, 20, 0, false);
    // leftover slots dress the combined map's outer ring
    if (biome !== 'desert' && budget - caps.length >= 3) {
      placePatches(2, [cfg.woods.r[0] * 1.1, cfg.woods.r[1] * 1.1], 720, 30, 500, true);
    }
    return out;
  }

  // ---- uniforms ------------------------------------------------------------
  const crop6 = cfg.cropCols.map((hex) => new THREE.Vector3(
    srgbToLinear((hex >> 16) & 255), srgbToLinear((hex >> 8) & 255), srgbToLinear(hex & 255),
  ));
  const wood24 = [];
  for (let i = 0; i < WOOD_SLOTS; i++) wood24.push(new THREE.Vector4(0, 0, 0, 0));
  wood24[0].set(thresholds[0], thresholds[1], thresholds[2], thresholds[3]);
  wood24[1].set(thresholds[4], CAP_KEEP, townUV[0], townUV[1]);
  const rp = (i, k) => (roadUV[i] ? roadUV[i][k] : 0);
  wood24[2].set(townKeep, roadUV.length, rp(0, 0), rp(0, 1));
  wood24[3].set(rp(1, 0), rp(1, 1), rp(2, 0), rp(2, 1));
  wood24[4].set(rp(3, 0), rp(3, 1), rp(4, 0), rp(4, 1));
  for (let i = 0; i < caps.length && WOOD_FIRST + i < WOOD_SLOTS; i++) {
    const c = caps[i];
    wood24[WOOD_FIRST + i].set(c.ax, c.az, c.r, (c.bx + PACK_OFF) * PACK + (c.bz + PACK_OFF));
  }
  const uniforms = {
    uLuSeed: { value: seedMod },
    uLuCell: { value: new THREE.Vector2(cw, cd) },
    uLuAngle: { value: angle },
    uLuWarp: { value: W },
    uLuCrop: { value: crop6 },
    uLuWood: { value: wood24 },
  };

  const params = {
    biome,
    style,
    seed,
    seedMod,
    angle,
    warp: W,
    cell: [cw, cd],
    extent: EXTENT,
    fields: fieldsOn,
    hedgeChance: cfg.hedgeChance,
    fenceChance: cfg.fenceChance,
    orchardChance: orch,
    hedgeStyle: cfg.hedgeStyle,
    roadTreeType: typeof cfg.roadTrees === 'string' ? cfg.roadTrees : null,
    cropWeights,
    thresholds: thresholds.slice(),
    cropCols: cfg.cropCols.slice(),
    capKeep: CAP_KEEP,
    townKeep: TOWN_KEEP,
    roadKeep: ROAD_KEEP,
    town: town ? { ...town } : null,
    woodSlots: caps.length,
    woodSlotCapacity: WOOD_SLOTS - WOOD_FIRST,
  };

  // ---- lots ----------------------------------------------------------------
  function buildLots() {
    const lots = [];
    const rng = rngFor(23);
    const dims = STYLE_DIMS[style] || STYLE_DIMS.normandy;
    const dimOf = (role) => {
      const b = dims[role];
      if (role === 'church') return { w: b[0], d: b[1] };
      return { w: r1(b[0] * (0.9 + 0.2 * rng())), d: r1(b[1] * (0.9 + 0.2 * rng())) };
    };
    const roadClear = (rect) => {
      let m = Infinity;
      for (const g of road.segs) {
        const [ax, az] = toLocal(rect, g.ax, g.az);
        const [bx, bz] = toLocal(rect, g.bx, g.bz);
        m = Math.min(m, segBoxDist(ax, az, bx, bz, -rect.w / 2, -rect.d / 2, rect.w / 2, rect.d / 2));
      }
      return m;
    };
    const canPlace = (rect, farm) => {
      const lim = EXTENT - 20;
      if (Math.abs(rect.x) > lim || Math.abs(rect.z) > lim) return false;
      const corners = rectCorners(rect);
      for (let i = 0; i < 8; i += 2) {
        if (hRoad(corners[i], corners[i + 1]) < 8) return false;
        if (woodAt(corners[i], corners[i + 1]) > 0.15) return false;
      }
      if (roadClear(rect) < 8) return false;
      if (woodAt(rect.x, rect.z) > 0.15) return false;
      const [ox, oz] = toLocal(rect, 0, 0);
      if (boxDist(ox, oz, -rect.w / 2, -rect.d / 2, rect.w / 2, rect.d / 2) < 62) return false;
      const half = Math.hypot(rect.w, rect.d) / 2;
      if (spawnDist(rect.x, rect.z) < half + 10) return false;
      if (hSlope(rect.x, rect.z) > (farm ? 0.2 : 0.35)) return false;
      for (const l of lots) if (rectsOverlap(rect, l, 2.5)) return false;
      if (farm) {
        const p = parcelAt(rect.x, rect.z);
        if (p.edgeDist < half + 4) return false;
      }
      return true;
    };
    const mkLot = (rect, role, group, farm = -1) => {
      const lot = { x: r2(rect.x), z: r2(rect.z), yaw: Math.round(rect.yaw * 10000) / 10000, w: rect.w, d: rect.d, role, group };
      if (farm >= 0) lot.farm = farm;
      return lot;
    };
    const yawFacing = (fx, fz) => Math.atan2(fx, fz);

    if (town && road.segs.length) {
      const T = town;
      const R = T.r;
      const near = road.nearest(T.x, T.z);
      const sideT = ((T.x - near.x) * -near.tz + (T.z - near.z) * near.tx) >= 0 ? 1 : -1;
      const village = { church: null, houses: [], barns: [], sheds: [] };
      const put = (rect, role) => {
        const lot = mkLot(rect, role, 'village');
        lots.push(lot);
        return lot;
      };

      // church: as near the centre as it will go, tower end to the street
      const cDim = dimOf('church');
      for (let dist = 0; dist <= R * 0.34 && !village.church; dist += 1.5) {
        const nAng = dist === 0 ? 1 : 24;
        for (let k = 0; k < nAng && !village.church; k++) {
          const a = (k / nAng) * Math.PI * 2;
          const x = T.x + Math.cos(a) * dist;
          const z = T.z + Math.sin(a) * dist;
          const q = road.nearest(x, z);
          const base = yawFacing(q.x - x, q.z - z);
          for (const turn of [0, HALF_PI, -HALF_PI, Math.PI]) {
            const rect = { x, z, yaw: base + turn, w: cDim.w, d: cDim.d };
            if (canPlace(rect, false)) { village.church = put(rect, 'church'); break; }
          }
        }
      }

      // houses along the street, both sides, facing it
      const span = R + 16;
      for (const side of [sideT, -sideT]) {
        let s = Math.max(0, near.s - span);
        const sEnd = Math.min(road.total, near.s + span);
        while (s < sEnd) {
          const dm = dimOf('house');
          const q = road.pointAt(s + dm.w / 2);
          const nx = -q.tz;
          const nz = q.tx;
          const setback = 8.8 + dm.d / 2 + rng() * 2.4;
          const x = q.x + nx * side * setback;
          const z = q.z + nz * side * setback;
          const rect = { x, z, yaw: yawFacing(-nx * side, -nz * side), w: dm.w, d: dm.d };
          if (Math.hypot(x - T.x, z - T.z) <= R + 12 && canPlace(rect, false)) {
            village.houses.push(put(rect, 'house'));
            s += dm.w + 3 + rng() * 5;
          } else {
            s += 4;
          }
        }
      }
      // a lane from the street through the square, houses facing it
      let mx = T.x - near.x;
      let mz = T.z - near.z;
      const ml = Math.hypot(mx, mz);
      if (ml > 1) { mx /= ml; mz /= ml; } else { mx = -near.tz * sideT; mz = near.tx * sideT; }
      const px = -mz;
      const pz = mx;
      for (let k = 22; k <= R + 6; k += 3) {
        for (const lat of [1, -1]) {
          const dm = dimOf('house');
          const off = 7 + dm.d / 2;
          const x = near.x + mx * (k + dm.w / 2) + px * lat * off;
          const z = near.z + mz * (k + dm.w / 2) + pz * lat * off;
          const rect = { x, z, yaw: yawFacing(-px * lat, -pz * lat), w: dm.w, d: dm.d };
          if (Math.hypot(x - T.x, z - T.z) <= R + 12 && canPlace(rect, false)) {
            village.houses.push(put(rect, 'house'));
            k += dm.w;
          }
        }
      }
      village.houses.sort((a, b) => Math.hypot(a.x - T.x, a.z - T.z) - Math.hypot(b.x - T.x, b.z - T.z));

      // barns behind every other house, sheds beside
      village.houses.forEach((h, idx) => {
        const ax = rectAxes(h);
        if (idx % 2 === 0) {
          const dm = dimOf('barn');
          for (const yawAdd of [0, HALF_PI, -HALF_PI]) {
            const back = h.d / 2 + 5 + (yawAdd === 0 ? dm.d : dm.w) / 2;
            const rect = { x: h.x - ax.zx * back, z: h.z - ax.zz * back, yaw: h.yaw + yawAdd, w: dm.w, d: dm.d };
            if (canPlace(rect, false)) { village.barns.push(put(rect, 'barn')); break; }
          }
        }
        if (idx % 3 === 1) {
          const dm = dimOf('shed');
          for (const side of [1, -1]) {
            const lat = h.w / 2 + 3 + dm.w / 2;
            const back = h.d / 2 - dm.d / 2 - 1;
            const rect = {
              x: h.x + ax.xx * lat * side - ax.zx * back,
              z: h.z + ax.xz * lat * side - ax.zz * back,
              yaw: h.yaw, w: dm.w, d: dm.d,
            };
            if (canPlace(rect, false)) { village.sheds.push(put(rect, 'shed')); break; }
          }
        }
      });
      // issue in priority order: church, houses nearest the square first, barns, sheds
      lots.length = 0;
      if (village.church) lots.push(village.church);
      lots.push(...village.houses, ...village.barns, ...village.sheds);
    }

    // outlying farmsteads: a house facing the lane, a barn across the yard, a shed
    const farmCount = Math.max(0, Math.round(cfg.farms));
    if (farmCount > 0) {
      const cands = [];
      for (let x = -400; x <= 400; x += 30) {
        for (let z = -400; z <= 400; z += 30) {
          const rd = hRoad(x, z);
          if (rd < 26 || rd > 160) continue;
          if (Math.hypot(x, z) < 140) continue;
          if (town && Math.hypot(x - town.x, z - town.z) < town.r + 100) continue;
          if (woodAt(x, z) > 0) continue;
          cands.push({ x, z, s: 1 - Math.abs(rd - 55) / 110 + rng() * 0.9 });
        }
      }
      cands.sort((a, b) => b.s - a.s);
      const farmCentres = [];
      for (const c of cands) {
        if (farmCentres.length >= farmCount) break;
        if (farmCentres.some((f) => Math.hypot(f.x - c.x, f.z - c.z) < 170)) continue;
        const q = road.segs.length ? road.nearest(c.x, c.z) : { x: c.x, z: c.z + 10 };
        const hd = dimOf('house');
        const house = { x: c.x, z: c.z, yaw: yawFacing(q.x - c.x, q.z - c.z), w: hd.w, d: hd.d };
        if (!canPlace(house, true)) continue;
        const fi = farmCentres.length;
        const before = lots.length;
        lots.push(mkLot(house, 'house', 'farm', fi));
        const ax = rectAxes(house);
        const bd = dimOf('barn');
        let barnOk = false;
        for (const side of [1, -1]) {
          const lat = house.w / 2 + 6 + bd.d / 2;
          const back = -(bd.w / 2 - house.d / 2);
          const rect = {
            x: house.x + ax.xx * lat * side - ax.zx * back,
            z: house.z + ax.xz * lat * side - ax.zz * back,
            yaw: house.yaw + HALF_PI * side, w: bd.w, d: bd.d,
          };
          if (canPlace(rect, true)) { lots.push(mkLot(rect, 'barn', 'farm', fi)); barnOk = true; break; }
        }
        if (!barnOk) { lots.length = before; continue; }
        const sd = dimOf('shed');
        for (const side of [-1, 1]) {
          const lat = house.w / 2 + 4 + sd.w / 2;
          const back = house.d / 2 + 4 + sd.d / 2;
          const rect = {
            x: house.x - ax.xx * lat * side - ax.zx * back,
            z: house.z - ax.xz * lat * side - ax.zz * back,
            yaw: house.yaw, w: sd.w, d: sd.d,
          };
          if (canPlace(rect, true)) { lots.push(mkLot(rect, 'shed', 'farm', fi)); break; }
        }
        farmCentres.push(c);
      }
    }
    return lots;
  }

  // ---- edges (hedges, fences, open boundaries) -----------------------------
  function buildEdges(lots) {
    if (!fieldsOn) return [];
    const E = EXTENT;
    const R2 = E * Math.SQRT2 + W + 2;
    const rowMin = Math.floor(-R2 / cd) - 1;
    const rowMax = Math.floor(R2 / cd) + 1;
    const uMin = -R2 - cw;
    const uMax = R2 + cw;
    const rows = new Map();
    const rowData = (r) => {
      let rd = rows.get(r);
      if (rd) return rd;
      const off = rowOffset(r);
      const i0 = Math.floor((uMin + off) / cw) - 2;
      const i1 = Math.floor((uMax + off) / cw) + 2;
      const B = [];
      for (let i = i0; i <= i1; i++) B.push(bound(i, r) - off);
      rd = { off, i0, B };
      rows.set(r, rd);
      return rd;
    };
    // index of the cell whose span [B(i-1), B(i)) holds u
    const colAt = (rd, u) => {
      let lo = 0;
      let hi = rd.B.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rd.B[mid] > u) hi = mid;
        else lo = mid + 1;
      }
      return rd.i0 + lo;
    };
    const meta = (r, col) => {
      const rd = rowData(r);
      const k = col - rd.i0;
      return parcelMeta(r, col, rd.B[k - 1] + rd.off, rd.B[k] + rd.off, rd.off);
    };

    const lim = E + W + 4;
    const inBounds = (u0, v0, u1, v1) => {
      const [x0, z0] = uvToWorld(u0, v0);
      const [x1, z1] = uvToWorld(u1, v1);
      return !(Math.max(x0, x1) < -lim || Math.min(x0, x1) > lim
        || Math.max(z0, z1) < -lim || Math.min(z0, z1) > lim);
    };

    const edges = [];
    const makeEdge = (u0, v0, u1, v1, pA, pB, hv, gateH) => {
      if (!inBounds(u0, v0, u1, v1)) return;
      const Lw = Math.hypot(u1 - u0, v1 - v0);
      const n = Math.max(1, Math.ceil(Lw / 2));
      const fine = [];
      let guess = null;
      let inside = false;
      for (let j = 0; j <= n; j++) {
        const t = j / n;
        guess = unwarp(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t, guess);
        const [x, z] = uvToWorld(guess[0], guess[1]);
        fine.push(x, z);
        if (Math.abs(x) <= E && Math.abs(z) <= E) inside = true;
      }
      if (!inside) return;
      // resample to even arc length
      const cum = [0];
      for (let j = 1; j <= n; j++) {
        cum.push(cum[j - 1] + Math.hypot(fine[2 * j] - fine[2 * j - 2], fine[2 * j + 1] - fine[2 * j - 1]));
      }
      const S = cum[n];
      const m = Math.max(1, Math.round(S / EDGE_STEP));
      const pts = [];
      let seg = 1;
      for (let q = 0; q <= m; q++) {
        const s = (S * q) / m;
        while (seg < n && cum[seg] < s) seg++;
        const s0 = cum[seg - 1];
        const f = cum[seg] > s0 ? (s - s0) / (cum[seg] - s0) : 0;
        const x = fine[2 * seg - 2] + (fine[2 * seg] - fine[2 * seg - 2]) * f;
        const z = fine[2 * seg - 1] + (fine[2 * seg + 1] - fine[2 * seg - 1]) * f;
        pts.push(Math.round(x * 1000) / 1000, Math.round(z * 1000) / 1000);
      }

      let type;
      if (pA.excluded || pB.excluded) {
        const mxp = pts[2 * (m >> 1)];
        const mzp = pts[2 * (m >> 1) + 1];
        const nearTown = town && Math.hypot(mxp - town.x, mzp - town.z) < town.r + 45;
        type = hv < (nearTown ? 0.45 : cfg.fenceChance * 1.2) ? 'fence' : 'open';
      } else if (hv < cfg.hedgeChance) {
        type = 'hedge';
      } else if (hv < cfg.hedgeChance + (1 - cfg.hedgeChance) * cfg.fenceChance) {
        type = 'fence';
      } else {
        type = 'open';
      }

      let gaps = [];
      if (type !== 'open') {
        const hedge = type === 'hedge';
        const step = S / m;
        const roadKeep = (hedge ? ROAD_KEEP : FENCE_ROAD_KEEP) + GAP_MARGIN;
        const runs = [];
        let r0 = -1;
        for (let q = 0; q <= m; q++) {
          const x = pts[2 * q];
          const z = pts[2 * q + 1];
          let blocked = hRoad(x, z) < roadKeep
            || Math.hypot(x, z) < CAP_KEEP + GAP_MARGIN
            || woodAt(x, z) > 0.35;
          if (!blocked && hedge && town && Math.hypot(x - town.x, z - town.z) < town.r + TOWN_KEEP + GAP_MARGIN) blocked = true;
          if (!blocked) {
            for (const l of lots) {
              if (Math.abs(l.x - x) > 40 || Math.abs(l.z - z) > 40) continue;
              if (pointInRect(l, x, z, 3 + GAP_MARGIN)) { blocked = true; break; }
            }
          }
          if (blocked && r0 < 0) r0 = q;
          if (!blocked && r0 >= 0) { runs.push([r0, q - 1]); r0 = -1; }
        }
        if (r0 >= 0) runs.push([r0, m]);
        for (const [a, b] of runs) {
          gaps.push([Math.max(0, (a - 0.5) * step) / S, Math.min(S, (b + 0.5) * step) / S]);
        }
        // a field gate
        if (S > 30 && gateH < 0.6) {
          const tc = 0.2 + 0.6 * ((gateH / 0.6) % 1);
          const hw = (hedge ? 2.6 : 2.1) / S;
          gaps.push([tc - hw, tc + hw]);
        }
        gaps.sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const g of gaps) {
          const last = merged[merged.length - 1];
          if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1]);
          else merged.push([g[0], g[1]]);
        }
        let covered = 0;
        for (const g of merged) {
          // round outward so a rounded gap never shrinks
          g[0] = Math.floor(Math.max(0, g[0]) * 1e5) / 1e5;
          g[1] = Math.ceil(Math.min(1, g[1]) * 1e5) / 1e5;
          covered += g[1] - g[0];
        }
        gaps = merged;
        if (covered > 0.97 || S * (1 - covered) < 6) {
          type = 'open';
          gaps = [];
        }
      }
      edges.push({
        ax: pts[0], az: pts[1], bx: pts[2 * m], bz: pts[2 * m + 1],
        type, gaps, pts, len: Math.round(S * 1000) / 1000,
        parcels: [pA.id, pB.id],
      });
    };

    for (let r = rowMin; r <= rowMax; r++) {
      const rd = rowData(r);
      const v0 = r * cd;
      const v1 = r * cd + cd;
      // boundaries between neighbours in this row
      for (let k = 1; k < rd.B.length - 1; k++) {
        const u = rd.B[k];
        if (u < uMin || u > uMax) continue;
        const col = rd.i0 + k;
        makeEdge(u, v0, u, v1, meta(r, col), meta(r, col + 1),
          luHash(col, r, 4, seedMod) / LU_P, luHash(col, r, 6, seedMod) / LU_P);
      }
      // the boundary under this row, split wherever either row has a column break
      const below = rowData(r - 1);
      const br = [];
      for (const u of rd.B) if (u > uMin && u < uMax) br.push(u);
      for (const u of below.B) if (u > uMin && u < uMax) br.push(u);
      br.push(uMin, uMax);
      br.sort((a, b) => a - b);
      for (let k = 0; k + 1 < br.length; k++) {
        const a = br[k];
        const b = br[k + 1];
        if (b - a < 0.25) continue;
        const mid = 0.5 * (a + b);
        const cA = colAt(rd, mid);
        const cB = colAt(below, mid);
        makeEdge(a, v0, b, v0, meta(r, cA), meta(r - 1, cB),
          luHash(cA * 7 + cB, r, 5, seedMod) / LU_P, luHash(cA * 7 + cB, r, 7, seedMod) / LU_P);
      }
    }
    return edges;
  }

  // ---- orchards --------------------------------------------------------------
  function buildOrchards(lots) {
    if (!fieldsOn || orch <= 0) return [];
    const out = [];
    const E = EXTENT;
    const R2 = E * Math.SQRT2 + W + 2;
    const inset = W + 5;
    for (let r = Math.floor(-R2 / cd) - 1; r <= Math.floor(R2 / cd) + 1; r++) {
      const off = rowOffset(r);
      const i0 = Math.floor((-R2 - cw + off) / cw) - 1;
      const i1 = Math.floor((R2 + cw + off) / cw) + 1;
      for (let i = i0; i <= i1; i++) {
        const bL = bound(i - 1, r);
        const bR = bound(i, r);
        const m = parcelMeta(r, i, bL, bR, off);
        if (m.crop !== 5) continue;
        const w = (bR - bL) - 2 * inset;
        const d = cd - 2 * inset;
        if (w < 18 || d < 18) continue;
        const [u, v] = unwarp(0.5 * (bL + bR) - off, r * cd + cd / 2, null);
        const [x, z] = uvToWorld(u, v);
        if (Math.abs(x) > E || Math.abs(z) > E) continue;
        const rect = { x, z, yaw: -angle, w, d };
        if (woodAt(x, z) > 0.2) continue;
        const cs = rectCorners(rect);
        let bad = false;
        for (let k = 0; k < 8 && !bad; k += 2) if (woodAt(cs[k], cs[k + 1]) > 0.35 || hRoad(cs[k], cs[k + 1]) < 10) bad = true;
        if (bad) continue;
        for (const l of lots) if (rectsOverlap(rect, l, 4)) { bad = true; break; }
        if (bad) continue;
        out.push({
          x: r2(x), z: r2(z), w: r2(w), d: r2(d),
          yaw: Math.round(-angle * 10000) / 10000,
          parcel: m.id,
          rowAngle: m.rowAngle,
        });
      }
    }
    return out;
  }

  // ---- telegraph poles ------------------------------------------------------
  function buildPoles(lots) {
    const out = [];
    if (!road.segs.length) return out;
    const rng = rngFor(37);
    const side = rng() < 0.5 ? 1 : -1;
    const blockedAt = (x, z) => {
      if (Math.hypot(x, z) < 40) return true;
      if (hRoad(x, z) < 6.6) return true;
      if (woodAt(x, z) > 0.5) return true;
      for (const l of lots) if (pointInRect(l, x, z, 2)) return true;
      return false;
    };
    let s = 6 + rng() * 10;
    let last = null;
    while (s < road.total - 2) {
      let placed = false;
      for (let tr = 0; tr < 6 && !placed && s < road.total - 2; tr++) {
        const q = road.pointAt(s);
        for (const sd of [side, -side]) {
          const x = q.x - q.tz * 7 * sd;
          const z = q.z + q.tx * 7 * sd;
          if (blockedAt(x, z)) continue;
          // at a bend the inside line shortens: keep the wire spans at least 44 m
          if (last && Math.hypot(x - last.x, z - last.z) < 44) continue;
          last = { x: r2(x), z: r2(z), yaw: Math.round(Math.atan2(q.tx, q.tz) * 10000) / 10000 };
          out.push(last);
          placed = true;
          break;
        }
        if (!placed) s += 3;
      }
      s += 45 + rng() * 10;
    }
    return out;
  }

  // ---- roadside tree rows ---------------------------------------------------
  function buildRoadTrees(lots, poles) {
    const out = [];
    const key = cfg.roadTrees;
    if (!key || !road.segs.length) return out;
    const rt = typeof key === 'object' ? { ...ROAD_ROWS.default, ...key } : (ROAD_ROWS[biome] || ROAD_ROWS.default);
    const type = typeof key === 'string' ? key : (typeof rt.type === 'string' ? rt.type : 'poplar');
    const rng = rngFor(41);
    const spacing = isNum(rt.spacing) ? Math.max(4, rt.spacing) : 9;
    const offset = isNum(rt.offset) ? rt.offset : 10;
    const lenR = Array.isArray(rt.len) ? rt.len : [150, 220];
    const stretches = isNum(rt.stretches) ? rt.stretches : 1;
    const taken = [];
    for (let k = 0; k < stretches; k++) {
      const len = lenR[0] + (lenR[1] - lenR[0]) * rng();
      let start = rng() * Math.max(1, road.total - len);
      for (let tries = 0; tries < 6 && taken.some(([a, b]) => start < b && start + len > a); tries++) {
        start = rng() * Math.max(1, road.total - len);
      }
      taken.push([start, start + len]);
      const sides = rt.sides >= 2 ? [1, -1] : [rng() < 0.5 ? 1 : -1];
      for (let s = start; s <= start + len; s += spacing) {
        const q = road.pointAt(s);
        for (const sd of sides) {
          const x = q.x - q.tz * offset * sd;
          const z = q.z + q.tx * offset * sd;
          if (Math.abs(x) > EXTENT || Math.abs(z) > EXTENT) continue;
          if (Math.hypot(x, z) < 90) continue;
          if (town && Math.hypot(x - town.x, z - town.z) < town.r + 15) continue;
          if (hRoad(x, z) < 8.5) continue;
          if (woodAt(x, z) > 0.3) continue;
          if (spawnDist(x, z) < 6) continue;
          if (lots.some((l) => pointInRect(l, x, z, 3))) continue;
          if (poles.some((p) => Math.abs(p.x - x) < 4 && Math.abs(p.z - z) < 4)) continue;
          out.push({ x: r2(x), z: r2(z), type });
        }
      }
    }
    return out;
  }

  // ---- foliage occupancy (for a future AI line-of-sight hookup) -------------
  let occ = null;
  const occN = Math.ceil((2 * EXTENT) / OCC_CELL);
  const occIndex = (x, z) => {
    const i = Math.floor((x + EXTENT) / OCC_CELL);
    const j = Math.floor((z + EXTENT) / OCC_CELL);
    if (i < 0 || j < 0 || i >= occN || j >= occN) return -1;
    return j * occN + i;
  };
  function buildOcc(edges) {
    const g = new Uint8Array(occN * occN);
    for (const c of caps) {
      const x0 = Math.min(c.ax, c.bx) - c.r;
      const x1 = Math.max(c.ax, c.bx) + c.r;
      const z0 = Math.min(c.az, c.bz) - c.r;
      const z1 = Math.max(c.az, c.bz) + c.r;
      for (let z = Math.floor(z0 / OCC_CELL) * OCC_CELL + OCC_CELL / 2; z <= z1; z += OCC_CELL) {
        for (let x = Math.floor(x0 / OCC_CELL) * OCC_CELL + OCC_CELL / 2; x <= x1; x += OCC_CELL) {
          const idx = occIndex(x, z);
          if (idx >= 0 && woodAt(x, z) >= 0.5) g[idx] = 1;
        }
      }
    }
    for (const e of edges) {
      if (e.type !== 'hedge') continue;
      const m = e.pts.length / 2 - 1;
      for (let q = 0; q <= m; q++) {
        const t = m > 0 ? q / m : 0;
        if (e.gaps.some((gp) => t >= gp[0] && t <= gp[1])) continue;
        const idx = occIndex(e.pts[2 * q], e.pts[2 * q + 1]);
        if (idx >= 0) g[idx] = 1;
      }
    }
    return g;
  }

  // ---- assemble ---------------------------------------------------------------
  const lu = {
    params,
    parcelAt,
    woodAt,
    edgePointAt,
    uniforms,
    woods,
    // true when a hedge or a wood (8 m cells) lies on the line, ignoring the
    // 6 m at either end so a tank parked in a hedge gap can still see out
    foliageBlocks(ax, az, bx, bz) {
      if (!occ) occ = buildOcc(lu.edges);
      const len = Math.hypot(bx - ax, bz - az);
      if (!(len > 1e-6)) return false;
      const n = Math.ceil(len / 4);
      for (let k = 0; k <= n; k++) {
        const s = (len * k) / n;
        if (s < 6 || s > len - 6) continue;
        const idx = occIndex(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
        if (idx >= 0 && occ[idx]) return true;
      }
      return false;
    },
  };
  // The long lists are built on first read, so the terrain (which only needs
  // the uniforms) never pays for them.
  const defineLazy = (name, fn) => {
    Object.defineProperty(lu, name, {
      enumerable: true,
      configurable: true,
      get() {
        const value = fn();
        Object.defineProperty(lu, name, { value, enumerable: true, writable: false, configurable: false });
        return value;
      },
    });
  };
  defineLazy('lots', () => buildLots());
  defineLazy('edges', () => buildEdges(lu.lots));
  defineLazy('orchards', () => buildOrchards(lu.lots));
  defineLazy('poles', () => buildPoles(lu.lots));
  defineLazy('roadTrees', () => buildRoadTrees(lu.lots, lu.poles));
  return lu;
}

// Point at arc-length fraction t (0..1) along an edge's polyline.
export function edgePointAt(edge, t, out = { x: 0, z: 0 }) {
  const pts = edge && edge.pts;
  if (!pts || pts.length < 4) {
    out.x = edge ? edge.ax + (edge.bx - edge.ax) * t : 0;
    out.z = edge ? edge.az + (edge.bz - edge.az) * t : 0;
    return out;
  }
  const m = pts.length / 2 - 1;
  const f = Math.max(0, Math.min(1, t)) * m;
  const q = Math.min(m - 1, Math.floor(f));
  const r = f - q;
  out.x = pts[2 * q] + (pts[2 * q + 2] - pts[2 * q]) * r;
  out.z = pts[2 * q + 1] + (pts[2 * q + 3] - pts[2 * q + 1]) * r;
  return out;
}
