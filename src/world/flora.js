// Flora geometry: per-biome tree archetypes, hedgerow bush clumps and the hull
// used for distant woodland masses (CONTRACT F in the maps audit).
//
// What this module is, and is not:
//   - It builds BufferGeometry only. It creates NO materials: scenery.js builds
//     its own MeshStandardMaterial per archetype, patches wind sway into it and
//     varies each instance with InstancedMesh.setColorAt.
//   - Every geometry is built once per (archetype, quality), cached for the
//     life of the page and stamped with markSharedGeometry(), so the battle
//     teardown sweep (disposeOwned / isSharedResource) leaves it alone.
//   - Fully deterministic: vertex displacement comes from a string-seeded hash,
//     never Math.random, so every client and every battle sees the same trees.
//
// Geometry conventions (shared by trees, hedge clumps and far-wood hulls):
//   - base at y = 0 (nothing below it), total height exactly 1, trunk axis on
//     x = z = 0 at the ground. Proportions are real: scale an instance
//     UNIFORMLY by its height in metres and it has the right crown spread.
//   - crownGeo and trunkGeo share one frame, so one instance matrix places both.
//   - Broadleaf crowns are ONE scalloped mass (plus at most one offset clump),
//     not a cluster of balls: at battle ranges a real crown reads as a single
//     silhouette with an irregular, bumpy outline.
//   - Smooth indexed normals, blended toward the normal of the crown's overall
//     volume so the canopy shades as one soft volume rather than facets.
//   - A 'color' attribute holds grey ambient occlusion (about 0.6 to 1.0:
//     darker crown undersides, darker trunk base). It is ignored unless the
//     material sets vertexColors: true, and then it multiplies the instance colour.
//   - A 'uv' attribute (cylindrical / spherical) exists so textured materials do
//     not sample garbage; nothing here relies on it.
//   - Local y is the height fraction, so a sway term driven by transformed.y
//     (for example y * y) keeps the trunk base planted.
//
// Archetype fields (the first seven are the contract; the rest are optional hints):
//   key             'oak' | 'beech' | 'poplar' | 'birch' | 'spruce' | 'pine'
//                   | 'fruit' | 'palm' | 'scrub'
//   crownGeo        foliage geometry (fronds for the palm, the bush for scrub)
//   trunkGeo        bark geometry (short hidden stems for scrub)
//   heightRange     [min, max] in metres for a mature tree of that species
//   crownRFactor    crown radius / height  (prop crownR = crownRFactor * height)
//   trunkRFactor    trunk base radius / height  (prop r = trunkRFactor * height)
//   weight          relative share of this biome's wood and lone-tree placements
//   role            'wood'    fills wood patches and lone field trees
//                   'row'     poplar road rows, shelter belts, oasis palms
//                   'orchard' orchard rows and farmyard trees
//                   'scrub'   low shrub layer
//   crownBaseFactor height fraction where the foliage starts (clear bole)
//   crownHex, trunkHex  suggested sRGB colours; broadleaf crowns sit at linear
//                   luminance 0.05-0.09 and conifers at 0.03-0.06 (the desert
//                   palm and scrub are dusty grey-olive, a little brighter)
//   tris            triangles per tree, crown plus trunk
//
// treeArchetypes(biomeKey, quality) returns 2-3 archetypes per biome, because
// each one costs two draw calls (crown + trunk) plus two shadow calls:
//   meadow  (Normandy bocage)       oak, poplar, fruit
//   steppe  (forest-steppe)          birch, oak, poplar
//   winter  (Karelian taiga)         spruce, pine, birch
//   desert  (North Africa)           palm, scrub
// Any other key falls back to meadow. floraArchetype(key, quality) returns any
// single species on its own, for example a beech for a special placement.

import * as THREE from 'three';
import { markSharedGeometry, getMaterialQuality } from '../core/materials.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Deterministic hash / PRNG

function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(key) {
  let a = hashString(key) || 0x9e3779b9;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------
// Icosahedron (detail 0) with a vertex on each pole: 12 vertices, 20 faces.
// Pole-up orientation gives two pentagonal rings, which reads far better as a
// foliage clump than three.js's axis-aligned icosahedron.

const ICO_VERTS = (() => {
  const v = [[0, 1, 0]];
  const ry = 1 / Math.sqrt(5);
  const rr = 2 / Math.sqrt(5);
  for (let k = 0; k < 5; k++) v.push([rr * Math.cos(TAU * k / 5), ry, rr * Math.sin(TAU * k / 5)]);
  for (let k = 0; k < 5; k++) v.push([rr * Math.cos(TAU * k / 5 + Math.PI / 5), -ry, rr * Math.sin(TAU * k / 5 + Math.PI / 5)]);
  v.push([0, -1, 0]);
  return v;
})();

const ICO_FACES = (() => {
  const f = [];
  for (let k = 0; k < 5; k++) {
    const k1 = (k + 1) % 5;
    f.push([0, 1 + k, 1 + k1]);
    f.push([1 + k, 6 + k, 1 + k1]);
    f.push([1 + k1, 6 + k, 6 + k1]);
    f.push([11, 6 + k1, 6 + k]);
  }
  return f;
})();

// ---------------------------------------------------------------------------
// Geometry builder

const TAG_FOLIAGE = 0;
const TAG_BARK = 1;
const TAG_BIRCH = 2;
const TAG_PALM = 3;
const TAG_HULL = 4;

class GeoBuilder {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.index = [];
    this.tag = [];
    this.target = [];   // direction the smooth normal is blended toward
    this.blend = [];    // 0 = keep the computed normal, 1 = use the target
  }

  get count() { return this.pos.length / 3; }

  vert(x, y, z, u, v, tag, tx = 0, ty = 0, tz = 0, blend = 0) {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.tag.push(tag);
    this.target.push(tx, ty, tz);
    this.blend.push(blend);
    return this.count - 1;
  }

  // Emit a triangle wound so its face normal has a non-negative dot with w.
  triFacing(a, b, c, wx, wy, wz) {
    const p = this.pos;
    const e1x = p[b * 3] - p[a * 3], e1y = p[b * 3 + 1] - p[a * 3 + 1], e1z = p[b * 3 + 2] - p[a * 3 + 2];
    const e2x = p[c * 3] - p[a * 3], e2y = p[c * 3 + 1] - p[a * 3 + 1], e2z = p[c * 3 + 2] - p[a * 3 + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    if (nx * wx + ny * wy + nz * wz < 0) this.index.push(a, c, b);
    else this.index.push(a, b, c);
  }

  centroid(a, b, c) {
    const p = this.pos;
    return [
      (p[a * 3] + p[b * 3] + p[c * 3]) / 3,
      (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1]) / 3,
      (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]) / 3,
    ];
  }

  // Outward from a point (lobes, hulls, mounds).
  triOut(a, b, c, ox, oy, oz) {
    const [cx, cy, cz] = this.centroid(a, b, c);
    this.triFacing(a, b, c, cx - ox, cy - oy, cz - oz);
  }

  // Outward from the segment p0-p1 (tubes).
  triAxis(a, b, c, p0, p1) {
    const [cx, cy, cz] = this.centroid(a, b, c);
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len2 = dx * dx + dy * dy + dz * dz || 1;
    const t = clamp01(((cx - p0[0]) * dx + (cy - p0[1]) * dy + (cz - p0[2]) * dz) / len2);
    this.triFacing(a, b, c, cx - (p0[0] + dx * t), cy - (p0[1] + dy * t), cz - (p0[2] + dz * t));
  }

  maxY() {
    let m = 0;
    for (let i = 1; i < this.pos.length; i += 3) if (this.pos[i] > m) m = this.pos[i];
    return m;
  }

  minY() {
    let m = Infinity;
    for (let i = 1; i < this.pos.length; i += 3) if (this.pos[i] < m) m = this.pos[i];
    return m;
  }
}

// Ellipsoid gradient: the outward normal of the crown's overall volume at p.
function volumeTarget(vol, x, y, z) {
  return [
    (x - vol.c[0]) / (vol.r[0] * vol.r[0]),
    (y - vol.c[1]) / (vol.r[1] * vol.r[1]),
    (z - vol.c[2]) / (vol.r[2] * vol.r[2]),
  ];
}

// Triangulate the band between two rings of (possibly different) vertex
// counts by walking both in angle order: nA + nB triangles.
function band(out, A, B) {
  const nA = A.idx.length, nB = B.idx.length;
  const angA = (i) => (i >= nA ? A.ang[i - nA] + TAU : A.ang[i]);
  const angB = (j) => (j >= nB ? B.ang[j - nB] + TAU : B.ang[j]);
  let i = 0, j = 0;
  while (i < nA || j < nB) {
    const advanceA = j >= nB || (i < nA && angA(i + 1) <= angB(j + 1));
    if (advanceA) { out(A.idx[i % nA], A.idx[(i + 1) % nA], B.idx[j % nB]); i++; }
    else { out(A.idx[i % nA], B.idx[j % nB], B.idx[(j + 1) % nB]); j++; }
  }
}

// One crown mass: a top vertex, rings from top to bottom and a bottom vertex.
// spec.rings = [[yf, n, rf, scallop], ...] with yf in -1..1 of the half-height,
// rf the ring radius factor and scallop how deep every other vertex is pulled
// in (and down), which gives the outline its clumps. spec.lean = [lx, lz]
// shifts the upper rings and the leader sideways (birch).
// Triangles: n(first) + n(last) + sum over neighbouring rings of (nA + nB).
function hull(b, rng, c, r, spec, vol, opt = {}) {
  const jitter = opt.jitter ?? 0.12;
  const blend = opt.blend ?? 0.55;
  const put = (x, y, z, u, v) => {
    const py = Math.max(0, y);
    const [tx, ty, tz] = volumeTarget(vol, x, py, z);
    return b.vert(x, py, z, u, v, TAG_FOLIAGE, tx, ty, tz, blend);
  };
  const lean = spec.lean ?? [0, 0];
  const top = put(c[0] + lean[0] * r[0], c[1] + spec.top * r[1], c[2] + lean[1] * r[2], 0.5, 1);
  const phase = rng() * TAU;
  const rings = spec.rings.map(([yf, n, rf, scallop], ri) => {
    const step = TAU / n;
    const leanF = clamp01((yf + 1) / 2) ** 2;
    const idx = [], ang = [];
    for (let k = 0; k < n; k++) {
      const a = phase + (ri % 2) * step * 0.5 + k * step + (rng() * 2 - 1) * step * 0.2;
      const clump = k % 2 === 0;
      const rr = rf * (clump ? 1 : 1 - scallop) * (1 + (rng() * 2 - 1) * jitter);
      const yy = yf + (rng() * 2 - 1) * 0.07 + (clump ? 0.2 : -0.2) * scallop;
      const x = c[0] + (Math.cos(a) * rr + lean[0] * leanF) * r[0];
      const z = c[2] + (Math.sin(a) * rr + lean[1] * leanF) * r[2];
      idx.push(put(x, c[1] + yy * r[1], z, k / n, yy * 0.5 + 0.5));
      ang.push(a);
    }
    return { idx, ang };
  });
  const bottom = put(c[0], c[1] + spec.bottom * r[1], c[2], 0.5, 0);
  const out = (i, j, k) => b.triOut(i, j, k, c[0], c[1], c[2]);
  const first = rings[0], last = rings[rings.length - 1];
  for (let k = 0; k < first.idx.length; k++) out(top, first.idx[k], first.idx[(k + 1) % first.idx.length]);
  for (let i = 0; i < rings.length - 1; i++) band(out, rings[i], rings[i + 1]);
  for (let k = 0; k < last.idx.length; k++) out(bottom, last.idx[k], last.idx[(k + 1) % last.idx.length]);
}

// A displaced icosahedron clump of foliage: 20 triangles.
function lobe(b, rng, c, r, vol, opt = {}) {
  const jitter = opt.jitter ?? 0.14;
  const blend = opt.blend ?? 0.5;
  const yaw = rng() * TAU;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const base = b.count;
  for (const [x0, y0, z0] of ICO_VERTS) {
    const x = x0 * cs - z0 * sn;
    const z = x0 * sn + z0 * cs;
    const pole = Math.abs(y0) > 0.99;
    const j = 1 + (rng() * 2 - 1) * jitter * (pole ? 0.5 : 1);
    const px = c[0] + x * r[0] * j;
    const py = Math.max(0, c[1] + y0 * r[1] * j);
    const pz = c[2] + z * r[2] * j;
    const [tx, ty, tz] = volumeTarget(vol, px, py, pz);
    b.vert(px, py, pz, Math.atan2(z, x) / TAU + 0.5, y0 * 0.5 + 0.5, TAG_FOLIAGE, tx, ty, tz, blend);
  }
  for (const [i, j, k] of ICO_FACES) b.triOut(base + i, base + j, base + k, c[0], c[1], c[2]);
}

// A ground-hugging dome on the same 20-face topology: the lower ring sits near
// the ground and is the widest, so a bush has no undercut when seen from a
// tank's eye height. c is the footprint centre, h the height, r = [rx, rz].
function mound(b, rng, c, h, r, vol, opt = {}) {
  const jitter = opt.jitter ?? 0.12;
  const blend = opt.blend ?? 0.5;
  const yaw = rng() * TAU;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const base = b.count;
  for (let i = 0; i < ICO_VERTS.length; i++) {
    const [x0, , z0] = ICO_VERTS[i];
    let yf, rf;
    if (i === 0) { yf = 1 + (rng() * 2 - 1) * 0.05; rf = 0; }
    // a broad shoulder high up keeps the top a gentle bun, not a peak
    else if (i <= 5) { yf = 0.74 * (1 + (rng() * 2 - 1) * 0.07); rf = 0.84 * (1 + (rng() * 2 - 1) * jitter * 0.7); }
    else if (i <= 10) { yf = 0.1 * (1 + (rng() * 2 - 1) * 0.3); rf = 1 + (rng() * 2 - 1) * jitter * 0.7; }
    else { yf = 0; rf = 0; }
    const len = Math.hypot(x0, z0) || 1;
    const dx = (x0 * cs - z0 * sn) / len;
    const dz = (x0 * sn + z0 * cs) / len;
    const px = c[0] + dx * r[0] * rf;
    const py = c[1] + h * yf;
    const pz = c[2] + dz * r[1] * rf;
    const [tx, ty, tz] = volumeTarget(vol, px, py, pz);
    b.vert(px, py, pz, Math.atan2(dz, dx) / TAU + 0.5, yf, TAG_FOLIAGE, tx, ty, tz, blend);
  }
  const oy = c[1] + h * 0.35;
  for (const [i, j, k] of ICO_FACES) b.triOut(base + i, base + j, base + k, c[0], oy, c[2]);
}

// An open tapered tube through a polyline of [x, y, z, radius] points: the
// bottom is in the ground and the top is normally hidden inside the crown.
// capTop > 0 closes the top with a short cone of that height (palm stem).
function tube(b, rng, pts, sides, tag, capTop = 0) {
  const phase = rng() * TAU;
  const rings = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, y, z, r] = pts[i];
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[Math.min(pts.length - 1, i + 1)];
    let tx = p1[0] - p0[0], ty = p1[1] - p0[1], tz = p1[2] - p0[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    let ax = 0, az = 1;
    if (Math.abs(tz) > 0.9) { ax = 1; az = 0; }
    let ux = ty * az, uy = tz * ax - tx * az, uz = -ty * ax;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const wx = ty * uz - tz * uy, wy = tz * ux - tx * uz, wz = tx * uy - ty * ux;
    const ring = [];
    for (let s = 0; s < sides; s++) {
      const a = phase + TAU * s / sides;
      const j = r * (1 + (rng() * 2 - 1) * 0.08);
      const ox = (ux * Math.cos(a) + wx * Math.sin(a)) * j;
      const oy = (uy * Math.cos(a) + wy * Math.sin(a)) * j;
      const oz = (uz * Math.cos(a) + wz * Math.sin(a)) * j;
      const py = y === 0 ? 0 : y + oy;
      ring.push(b.vert(x + ox, py, z + oz, s / sides, y * 6, tag));
    }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      const a = rings[i][s], bb = rings[i + 1][s], c = rings[i + 1][s1], d = rings[i][s1];
      b.triAxis(a, bb, c, pts[i], pts[i + 1]);
      b.triAxis(a, c, d, pts[i], pts[i + 1]);
    }
  }
  if (capTop > 0) {
    const [x, y, z] = pts[pts.length - 1];
    const ring = rings[rings.length - 1];
    const apex = b.vert(x, y + capTop, z, 0.5, (y + capTop) * 6, tag);
    for (let s = 0; s < sides; s++) b.triOut(apex, ring[s], ring[(s + 1) % sides], x, y - capTop, z);
  }
}

// One ragged conifer tier: a cone whose rim alternates branch tips (longer,
// drooping) and gaps, closed underneath by a shallow concave cone so it does
// not turn see-through when viewed from below.
function tier(b, rng, yBot, yTop, r, seg, vol, blend) {
  const hTier = yTop - yBot;
  const apex = b.count;
  {
    const ax = (rng() * 2 - 1) * r * 0.06, az = (rng() * 2 - 1) * r * 0.06;
    const [tx, ty, tz] = volumeTarget(vol, ax, yTop, az);
    b.vert(ax, yTop, az, 0.5, 1, TAG_FOLIAGE, tx, ty + 1, tz, blend);
  }
  const phase = rng() * TAU;
  const ring = [];
  for (let k = 0; k < seg; k++) {
    const tip = k % 2 === 0;
    const a = phase + TAU * k / seg + (rng() * 2 - 1) * 0.18;
    const rr = r * (tip ? 1 : 0.78) * (1 + (rng() * 2 - 1) * 0.1);
    const yy = yBot + hTier * ((tip ? -0.05 : 0.07) + (rng() * 2 - 1) * 0.03);
    const px = Math.cos(a) * rr, pz = Math.sin(a) * rr;
    const [tx, ty, tz] = volumeTarget(vol, px, yy, pz);
    ring.push(b.vert(px, yy, pz, k / seg, 0, TAG_FOLIAGE, tx, ty, tz, blend));
  }
  const under = b.vert(0, yBot + hTier * 0.22, 0, 0.5, 0, TAG_FOLIAGE, 0, -1, 0, blend);
  for (let k = 0; k < seg; k++) {
    const a = ring[k], c = ring[(k + 1) % seg];
    const [cx, , cz] = b.centroid(apex, a, c);
    b.triFacing(apex, a, c, cx, 0, cz);          // side: outward
    b.triFacing(under, a, c, 0, -1, 0);          // underside: down
  }
}

// A date-palm frond: a keeled blade (ridge up) seen from above, closed by a
// valley underside so it still shows from below. 6 triangles.
function frond(b, base, ang, len, rise, droop, halfW, keel) {
  const dx = Math.cos(ang), dz = Math.sin(ang);
  const sx = -dz, sz = dx;
  const m = [base[0] + dx * len * 0.45, base[1] + rise, base[2] + dz * len * 0.45];
  const t = [base[0] + dx * len, base[1] + rise - droop, base[2] + dz * len];
  const l = [m[0] - sx * halfW, m[1] - keel, m[2] - sz * halfW];
  const r = [m[0] + sx * halfW, m[1] - keel, m[2] + sz * halfW];
  const top = (p, u, v) => b.vert(p[0], p[1], p[2], u, v, TAG_FOLIAGE, 0, 1, 0, 0.3);
  const bot = (p, u, v) => b.vert(p[0], p[1], p[2], u, v, TAG_FOLIAGE, 0, -1, 0, 0.3);
  const B = top(base, 0.5, 0), M = top(m, 0.5, 0.45), L = top(l, 0, 0.45), R = top(r, 1, 0.45), T = top(t, 0.5, 1);
  b.triFacing(B, L, M, 0, 1, 0);
  b.triFacing(B, M, R, 0, 1, 0);
  b.triFacing(M, L, T, 0, 1, 0);
  b.triFacing(M, T, R, 0, 1, 0);
  const B2 = bot(base, 0.5, 0), L2 = bot(l, 0, 0.45), R2 = bot(r, 1, 0.45), T2 = bot(t, 0.5, 1);
  b.triFacing(B2, L2, T2, 0, -1, 0);
  b.triFacing(B2, T2, R2, 0, -1, 0);
}

// ---------------------------------------------------------------------------
// Finishing: normalise, normals, occlusion colours, bounds, shared stamp.

function occlusion(tag, y, ny, crownMin, crownMax, noise) {
  let ao;
  switch (tag) {
    case TAG_FOLIAGE: {
      const hf = clamp01((y - crownMin) / Math.max(1e-6, crownMax - crownMin));
      ao = 0.66 + 0.2 * hf + 0.14 * (ny * 0.5 + 0.5);
      break;
    }
    case TAG_BIRCH:
      // the rough black bark at a birch's foot, white higher up
      ao = 0.5 + 0.5 * clamp01(y / 0.14) - 0.12 * clamp01((y - crownMin) / 0.2);
      break;
    case TAG_PALM:
      // old leaf bases darken the top of the stem under the crown
      ao = 0.82 + 0.18 * clamp01(y / 0.3) - 0.2 * clamp01((y - (crownMin + 0.05)) / 0.12);
      break;
    case TAG_HULL:
      ao = 0.6 + 0.4 * clamp01(y);
      break;
    default:
      ao = 0.8 + 0.2 * clamp01(y / 0.12) - 0.16 * clamp01((y - crownMin) / 0.15);
  }
  return Math.min(1, Math.max(0.5, ao + noise));
}

function toGeometry(b, scale, crownMin, crownMax, name, aoRng) {
  const n = b.count;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) pos[i] = b.pos[i] * scale;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uv), 2));
  geo.setIndex(b.index);
  geo.computeVertexNormals();

  const nrm = geo.attributes.normal.array;
  for (let i = 0; i < n; i++) {
    const w = b.blend[i];
    if (w <= 0) continue;
    let tx = b.target[i * 3], ty = b.target[i * 3 + 1], tz = b.target[i * 3 + 2];
    const tl = Math.hypot(tx, ty, tz);
    if (tl < 1e-9) continue;
    tx /= tl; ty /= tl; tz /= tl;
    let x = nrm[i * 3] * (1 - w) + tx * w;
    let y = nrm[i * 3 + 1] * (1 - w) + ty * w;
    let z = nrm[i * 3 + 2] * (1 - w) + tz * w;
    const l = Math.hypot(x, y, z);
    if (l < 1e-6) { x = tx; y = ty; z = tz; } else { x /= l; y /= l; z /= l; }
    nrm[i * 3] = x; nrm[i * 3 + 1] = y; nrm[i * 3 + 2] = z;
  }

  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const ao = occlusion(b.tag[i], pos[i * 3 + 1], nrm[i * 3 + 1], crownMin, crownMax, (aoRng() * 2 - 1) * 0.03);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.name = name;
  geo.userData.flora = name;
  return markSharedGeometry(geo);
}

// Horizontal distance of the farthest vertex from the trunk axis.
function horizontalExtent(b, scale) {
  let m = 0;
  for (let i = 0; i < b.pos.length; i += 3) m = Math.max(m, Math.hypot(b.pos[i], b.pos[i + 2]));
  return m * scale;
}

function groundRadius(b, scale) {
  let m = 0;
  for (let i = 0; i < b.pos.length; i += 3) {
    if (b.pos[i + 1] <= 1e-9) m = Math.max(m, Math.hypot(b.pos[i], b.pos[i + 2]));
  }
  return m * scale;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// Species. Each builder receives (crown, trunk, rng, q) with q 0 = low,
// 1 = medium, 2 = high, and works in pre-normalisation units where the tree
// is about 1 tall. Triangle counts per tier are noted as low / medium / high.

// Pedunculate oak (Quercus robur): a broad, irregular, lopsided dome about
// 0.75 x height across in woodland, clear bole about a third of the height,
// a stout trunk and a heavy low limb. 42 / 70 / 78 tris.
function buildOak(c, t, rng, q) {
  const vol = { c: [0.02, 0.64, 0], r: [0.4, 0.34, 0.38] };
  if (q === 0) {
    hull(c, rng, [0, 0.66, 0], [0.37, 0.31, 0.35],
      { top: 1, bottom: -0.8, rings: [[0.58, 5, 0.74, 0.1], [0.02, 7, 1, 0.16], [-0.55, 5, 0.8, 0.1]] }, vol);
    tube(t, rng, [[0, 0, 0, 0.03], [0.01, 0.56, 0, 0.018]], 4, TAG_BARK);
    return;
  }
  hull(c, rng, [-0.03, 0.68, 0.01], [0.34, 0.29, 0.33],
    { top: 1, bottom: -0.78, rings: [[0.62, 5, 0.72, 0.12], [0.05, 9, 1, 0.18], [-0.55, 7, 0.8, 0.1]] }, vol);
  lobe(c, rng, [0.22, 0.5, -0.1], [0.19, 0.15, 0.18], vol);
  tube(t, rng, [[0, 0, 0, 0.032], [0.008, 0.58, -0.004, 0.017]], q === 2 ? 5 : 4, TAG_BARK);
  if (q === 2) tube(t, rng, [[0.004, 0.3, 0, 0.014], [0.18, 0.5, -0.08, 0.008]], 3, TAG_BARK);
}

// European beech (Fagus sylvatica): denser, more upright egg-shaped crown,
// slimmer smooth grey trunk. 42 / 70 / 78 tris.
function buildBeech(c, t, rng, q) {
  const vol = { c: [0, 0.64, 0], r: [0.31, 0.38, 0.3] };
  if (q === 0) {
    hull(c, rng, [0, 0.64, 0], [0.29, 0.36, 0.28],
      { top: 1, bottom: -0.82, rings: [[0.58, 5, 0.75, 0.08], [0, 7, 1, 0.12], [-0.6, 5, 0.78, 0.08]] }, vol);
    tube(t, rng, [[0, 0, 0, 0.024], [0, 0.56, 0, 0.014]], 4, TAG_BARK);
    return;
  }
  hull(c, rng, [0, 0.66, 0], [0.28, 0.34, 0.27],
    { top: 1, bottom: -0.8, rings: [[0.6, 5, 0.75, 0.1], [0, 9, 1, 0.12], [-0.6, 7, 0.78, 0.08]] }, vol);
  lobe(c, rng, [-0.15, 0.46, 0.1], [0.15, 0.13, 0.14], vol, { jitter: 0.12 });
  tube(t, rng, [[0, 0, 0, 0.024], [0.006, 0.6, 0, 0.013]], q === 2 ? 5 : 4, TAG_BARK);
  if (q === 2) tube(t, rng, [[0, 0.34, 0, 0.01], [-0.13, 0.48, 0.09, 0.006]], 3, TAG_BARK);
}

// Lombardy poplar (Populus nigra 'Italica'): a narrow flame-shaped column only
// about 0.16 x height across, foliage almost to the ground. 24 / 50 / 52 tris.
function buildPoplar(c, t, rng, q) {
  const vol = { c: [0, 0.52, 0], r: [0.1, 0.52, 0.1] };
  const o = { jitter: 0.1 };
  if (q === 0) {
    hull(c, rng, [0, 0.54, 0], [0.09, 0.46, 0.088],
      { top: 1, bottom: -0.92, rings: [[0.45, 4, 0.72, 0.1], [-0.3, 5, 1, 0.12]] }, vol, o);
    tube(t, rng, [[0, 0, 0, 0.016], [0, 0.45, 0, 0.009]], 3, TAG_BARK);
    return;
  }
  hull(c, rng, [0, 0.54, 0], [0.09, 0.46, 0.088],
    { top: 1, bottom: -0.9, rings: [[0.7, 4, 0.55, 0.1], [0.28, 6, 0.95, 0.14], [-0.22, 6, 1, 0.14], [-0.7, 5, 0.72, 0.1]] }, vol, o);
  tube(t, rng, [[0, 0, 0, 0.016], [0, 0.5, 0, 0.008]], q === 2 ? 5 : 4, TAG_BARK);
}

// Silver birch (Betula pendula): slender, slightly leaning white stem, narrow
// irregular oval crown in the upper two thirds, a leader bent to one side.
// 40 / 68 / 74 tris.
function buildBirch(c, t, rng, q) {
  const vol = { c: [0.03, 0.66, 0], r: [0.21, 0.34, 0.2] };
  const o = { jitter: 0.18 };
  const lean = [0.25, 0.1];
  if (q === 0) {
    hull(c, rng, [0.02, 0.66, 0], [0.19, 0.32, 0.18],
      { top: 1, bottom: -0.85, lean, rings: [[0.5, 5, 0.72, 0.15], [-0.05, 6, 1, 0.18], [-0.6, 5, 0.8, 0.15]] }, vol, o);
    tube(t, rng, [[0, 0, 0, 0.014], [0.03, 0.8, 0.01, 0.005]], 4, TAG_BIRCH);
    return;
  }
  hull(c, rng, [0.02, 0.67, 0], [0.18, 0.31, 0.17],
    { top: 1, bottom: -0.82, lean, rings: [[0.6, 5, 0.62, 0.15], [0.05, 8, 1, 0.2], [-0.6, 6, 0.8, 0.15]] }, vol, o);
  lobe(c, rng, [-0.1, 0.5, 0.06], [0.1, 0.11, 0.1], vol, { jitter: 0.16 });
  if (q === 2) tube(t, rng, [[0, 0, 0, 0.014], [0.015, 0.45, 0.005, 0.009], [0.03, 0.82, 0.01, 0.005]], 4, TAG_BIRCH);
  else tube(t, rng, [[0, 0, 0, 0.014], [0.03, 0.82, 0.01, 0.005]], 5, TAG_BIRCH);
}

// Norway spruce (Picea abies): a narrow ragged cone about 0.3 x height wide at
// the base, branches reaching nearly to the ground at a wood edge.
// 30 / 50 / 64 tris.
function buildSpruce(c, t, rng, q) {
  const vol = { c: [0, 0.45, 0], r: [0.16, 0.55, 0.16] };
  const blend = 0.35;
  if (q === 0) {
    tier(c, rng, 0.05, 0.62, 0.15, 6, vol, blend);
    tier(c, rng, 0.42, 1.0, 0.085, 6, vol, blend);
    tube(t, rng, [[0, 0, 0, 0.016], [0, 0.6, 0, 0.006]], 3, TAG_BARK);
    return;
  }
  if (q === 1) {
    tier(c, rng, 0.05, 0.5, 0.15, 7, vol, blend);
    tier(c, rng, 0.32, 0.76, 0.115, 7, vol, blend);
    tier(c, rng, 0.6, 1.0, 0.068, 7, vol, blend);
  } else {
    tier(c, rng, 0.05, 0.44, 0.152, 7, vol, blend);
    tier(c, rng, 0.24, 0.64, 0.125, 7, vol, blend);
    tier(c, rng, 0.44, 0.84, 0.092, 7, vol, blend);
    tier(c, rng, 0.66, 1.0, 0.056, 7, vol, blend);
  }
  tube(t, rng, [[0, 0, 0, 0.016], [0, 0.7, 0, 0.005]], 4, TAG_BARK);
}

// Scots pine (Pinus sylvestris): a tall bare bole for about 60% of the height
// and a flattish, clumpy, umbrella crown on top. 34 / 70 / 76 tris.
function buildPine(c, t, rng, q) {
  const vol = { c: [0.02, 0.8, 0], r: [0.22, 0.16, 0.21] };
  const o = { jitter: 0.16 };
  if (q === 0) {
    hull(c, rng, [0.02, 0.82, 0], [0.2, 0.13, 0.19],
      { top: 0.95, bottom: -0.8, rings: [[0.3, 6, 0.9, 0.2], [-0.4, 7, 0.95, 0.2]] }, vol, o);
    tube(t, rng, [[0, 0, 0, 0.02], [0.01, 0.78, 0.005, 0.009]], 4, TAG_BARK);
    return;
  }
  hull(c, rng, [0.02, 0.83, 0], [0.2, 0.13, 0.19],
    { top: 0.95, bottom: -0.75, rings: [[0.6, 5, 0.7, 0.15], [0, 9, 1, 0.28], [-0.55, 6, 0.75, 0.15]] }, vol, o);
  // a lower branch clump growing straight off the bole
  lobe(c, rng, [-0.06, 0.69, 0.04], [0.1, 0.06, 0.09], vol, o);
  if (q === 2) tube(t, rng, [[0, 0, 0, 0.021], [0.018, 0.42, 0.006, 0.015], [0.004, 0.8, 0.012, 0.009]], 4, TAG_BARK);
  else tube(t, rng, [[0, 0, 0, 0.021], [0.006, 0.8, 0.01, 0.009]], 5, TAG_BARK);
}

// Standard (high-stem) apple tree of a Normandy pasture orchard: 4-6 m, a
// clear stem cattle graze under, a round crown wider than the tree is tall.
// 30 / 48 / 68 tris.
function buildFruit(c, t, rng, q) {
  const vol = { c: [0, 0.62, 0], r: [0.46, 0.36, 0.44] };
  if (q === 0) {
    hull(c, rng, [0, 0.64, 0], [0.43, 0.34, 0.41],
      { top: 1, bottom: -0.8, rings: [[0.4, 5, 0.85, 0.1], [-0.35, 6, 0.95, 0.1]] }, vol);
    tube(t, rng, [[0, 0, 0, 0.042], [-0.01, 0.5, 0.01, 0.022]], 4, TAG_BARK);
    return;
  }
  hull(c, rng, [0, 0.65, 0], [0.42, 0.33, 0.4],
    { top: 1, bottom: -0.78, rings: [[0.55, 5, 0.75, 0.1], [-0.05, 8, 1, 0.14], [-0.6, 6, 0.8, 0.08]] }, vol);
  if (q === 2) lobe(c, rng, [0.2, 0.5, 0.14], [0.2, 0.16, 0.19], vol);
  tube(t, rng, [[0, 0, 0, 0.042], [-0.01, 0.5, 0.01, 0.022]], 5, TAG_BARK);
}

// Date palm (Phoenix dactylifera): a slim, slightly curved stem and a crown of
// long arching fronds; upper fronds rise, lower ones droop. 48 / 62 / 73 tris.
function buildPalm(c, t, rng, q) {
  const top = [0.05, 0.9, 0.012];
  if (q === 0) {
    tube(t, rng, [[0, 0, 0, 0.03], [top[0], top[1], top[2], 0.019]], 4, TAG_PALM, 0.04);
  } else {
    tube(t, rng, [[0, 0, 0, 0.03], [0.012, 0.45, 0.003, 0.022], [top[0], top[1], top[2], 0.019]],
      q === 2 ? 5 : 4, TAG_PALM, 0.04);
  }
  const n = q === 0 ? 6 : q === 1 ? 7 : 8;
  const phase = rng() * TAU;
  const base = [top[0], top[1] + 0.01, top[2]];
  for (let k = 0; k < n; k++) {
    const upper = k % 2 === 0;
    const ang = phase + TAU * k / n + (rng() - 0.5) * 0.35;
    const len = (upper ? 0.4 : 0.44) * (1 + (rng() - 0.5) * 0.12);
    const rise = upper ? 0.1 : 0.035;
    const droop = (upper ? 0.06 : 0.2) * (1 + (rng() - 0.5) * 0.2);
    frond(c, base, ang, len, rise, droop, 0.05, 0.012);
  }
}

// Desert scrub (saltbush / tamarisk-like): a low dome wider than it is tall,
// a few stems hidden inside. 26 / 46 / 66 tris.
function buildScrub(c, t, rng, q) {
  const vol = { c: [0, 0.35, 0], r: [0.75, 0.55, 0.7] };
  const o = { jitter: 0.2 };
  if (q === 0) {
    mound(c, rng, [0, 0, 0], 1.0, [0.72, 0.64], vol, o);
  } else {
    mound(c, rng, [0.05, 0, 0], 1.0, [0.62, 0.56], vol, o);
    mound(c, rng, [-0.36, 0, 0.2], 0.7, [0.42, 0.4], vol, o);
    if (q === 2) mound(c, rng, [0.3, 0, -0.32], 0.6, [0.36, 0.34], vol, o);
  }
  tube(t, rng, [[0, 0, 0, 0.05], [0.03, 0.3, 0.01, 0.028]], 3, TAG_BARK);
}

// ---------------------------------------------------------------------------
// Species table. Heights are contract F; colours are hints only.

const SPECIES = {
  oak:    { build: buildOak,    heightRange: [14, 22],   role: 'wood',    crownHex: 0x3f5a2a, trunkHex: 0x4a4034 },
  beech:  { build: buildBeech,  heightRange: [14, 22],   role: 'wood',    crownHex: 0x3e5a26, trunkHex: 0x6f6c65 },
  poplar: { build: buildPoplar, heightRange: [18, 26],   role: 'row',     crownHex: 0x3d582b, trunkHex: 0x5a5248 },
  birch:  { build: buildBirch,  heightRange: [12, 18],   role: 'wood',    crownHex: 0x445a2b, trunkHex: 0xcdc8bc },
  spruce: { build: buildSpruce, heightRange: [16, 26],   role: 'wood',    crownHex: 0x2c4128, trunkHex: 0x4a3c31 },
  pine:   { build: buildPine,   heightRange: [16, 26],   role: 'wood',    crownHex: 0x324a2c, trunkHex: 0x7a5238 },
  fruit:  { build: buildFruit,  heightRange: [4, 6],     role: 'orchard', crownHex: 0x425a2b, trunkHex: 0x4e4338 },
  palm:   { build: buildPalm,   heightRange: [8, 14],    role: 'row',     crownHex: 0x4c5a36, trunkHex: 0x6e604c },
  scrub:  { build: buildScrub,  heightRange: [0.8, 1.6], role: 'scrub',   crownHex: 0x5c5e40, trunkHex: 0x574a3b },
};

export const FLORA_KEYS = Object.freeze(Object.keys(SPECIES));

const BIOME_FLORA = {
  // Normandy bocage: oak woods and hedgerow standards, Lombardy poplars along
  // roads and streams, apple trees in pasture orchards and by the farms.
  meadow: [['oak', 0.8], ['poplar', 0.12], ['fruit', 0.08]],
  // Forest-steppe (Kursk, Kuban): birch groves, oak in the ravines, poplar
  // shelter belts and village roads.
  steppe: [['birch', 0.55], ['oak', 0.3], ['poplar', 0.15]],
  // Karelian taiga: spruce-dominated, Scots pine on dry ground, birch at edges.
  winter: [['spruce', 0.55], ['pine', 0.3], ['birch', 0.15]],
  // North Africa: date palms at oases and wadis, scrub elsewhere.
  desert: [['palm', 0.35], ['scrub', 0.65]],
};

// Largest weight a species has in any biome (0 for species no biome lists).
const SPECIES_WEIGHT = (() => {
  const w = {};
  for (const list of Object.values(BIOME_FLORA)) for (const [k, v] of list) w[k] = Math.max(w[k] ?? 0, v);
  return w;
})();

const QUALITY_INDEX = { low: 0, medium: 1, high: 2 };

function qualityKey(quality) {
  if (quality in QUALITY_INDEX) return quality;
  const q = typeof getMaterialQuality === 'function' ? getMaterialQuality() : 'high';
  return q in QUALITY_INDEX ? q : 'high';
}

const geoCache = new Map();

function speciesGeometry(key, quality) {
  const cacheKey = `${key}|${quality}`;
  let entry = geoCache.get(cacheKey);
  if (entry) return entry;

  const spec = SPECIES[key];
  const crown = new GeoBuilder();
  const trunk = new GeoBuilder();
  spec.build(crown, trunk, seededRandom(`flora:${key}:${quality}`), QUALITY_INDEX[quality]);

  const scale = 1 / Math.max(crown.maxY(), trunk.maxY());
  const crownMin = crown.minY() * scale;
  const aoRng = seededRandom(`flora-ao:${key}:${quality}`);
  const crownGeo = toGeometry(crown, scale, crownMin, 1, `flora-${key}-crown-${quality}`, aoRng);
  const trunkGeo = toGeometry(trunk, scale, crownMin, 1, `flora-${key}-trunk-${quality}`, aoRng);

  entry = {
    crownGeo,
    trunkGeo,
    // 0.9 of the extreme: the outermost displaced vertices are single points,
    // not the bulk a shell or a hull would actually meet.
    crownRFactor: round3(horizontalExtent(crown, scale) * 0.9),
    trunkRFactor: round3(groundRadius(trunk, scale) || horizontalExtent(trunk, scale)),
    crownBaseFactor: round3(crownMin),
    tris: (crown.index.length + trunk.index.length) / 3,
  };
  geoCache.set(cacheKey, entry);
  return entry;
}

function makeArchetype(key, quality, weight) {
  const spec = SPECIES[key];
  const g = speciesGeometry(key, quality);
  return {
    key,
    crownGeo: g.crownGeo,
    trunkGeo: g.trunkGeo,
    heightRange: [spec.heightRange[0], spec.heightRange[1]],
    crownRFactor: g.crownRFactor,
    trunkRFactor: g.trunkRFactor,
    weight,
    role: spec.role,
    crownBaseFactor: g.crownBaseFactor,
    crownHex: spec.crownHex,
    trunkHex: spec.trunkHex,
    tris: g.tris,
  };
}

// CONTRACT F. biomeKey: 'meadow' | 'steppe' | 'winter' | 'desert' (a composed
// preset object is also accepted and read through its .biome). quality:
// 'low' | 'medium' | 'high', defaulting to the material factory's tier.
// Returns fresh archetype objects (safe to mutate) over cached shared geometry.
export function treeArchetypes(biomeKey, quality) {
  const biome = biomeKey && typeof biomeKey === 'object' ? biomeKey.biome : biomeKey;
  const list = BIOME_FLORA[biome] || BIOME_FLORA.meadow;
  const q = qualityKey(quality);
  return list.map(([key, weight]) => makeArchetype(key, q, weight));
}

// Any single species by key, independent of biome; null for an unknown key.
export function floraArchetype(key, quality) {
  if (!SPECIES[key]) return null;
  return makeArchetype(key, qualityKey(quality), SPECIES_WEIGHT[key] ?? 0);
}

// ---------------------------------------------------------------------------
// Hedge clump: one bush of a bocage hedgerow. 21 triangles. Unit size: 1 wide
// along X, about 1 deep, 1 tall, base at y = 0. A cushion: a slightly narrower
// foot, the widest ring at shoulder height (about 0.7) and a low roof, so
// clumps stepped 2.6 m apart at scale 2.5-4 m overlap at shoulder height and
// read as ONE continuous hedge whose top only undulates, not a row of domes.
// The bottom is open: it sits on the ground or on the earth bank.

let hedgeGeo = null;

export function hedgeClumpGeometry() {
  if (hedgeGeo) return hedgeGeo;
  const b = new GeoBuilder();
  const rng = seededRandom('flora:hedge-clump');
  const N = 7;
  const step = TAU / N;
  const vol = { c: [0, 0.35, 0], r: [0.55, 0.75, 0.55] };
  const put = (x, y, z, u) => {
    const [tx, ty, tz] = volumeTarget(vol, x, y, z);
    return b.vert(x, y, z, u, y, TAG_FOLIAGE, tx, ty, tz, 0.55);
  };
  const phase = rng() * TAU;
  const foot = [], shoulder = [];
  for (let k = 0; k < N; k++) {
    const a = phase + k * step + (rng() * 2 - 1) * step * 0.15;
    const r = 0.44 * (1 + (rng() * 2 - 1) * 0.08);
    foot.push(put(Math.cos(a) * r, 0, Math.sin(a) * r, k / N));
  }
  for (let k = 0; k < N; k++) {
    const a = phase + (k + 0.5) * step + (rng() * 2 - 1) * step * 0.15;
    const r = 0.5 * (1 + (rng() * 2 - 1) * 0.1);
    const y = 0.72 + (rng() * 2 - 1) * 0.06;
    shoulder.push(put(Math.cos(a) * r, y, Math.sin(a) * r, k / N));
  }
  const crown = put((rng() * 2 - 1) * 0.06, 1, (rng() * 2 - 1) * 0.06, 0.5);
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    // foot[k] and foot[k1] straddle shoulder[k]
    b.triOut(foot[k], shoulder[k], foot[k1], 0, 0.4, 0);
    b.triOut(foot[k1], shoulder[k], shoulder[k1], 0, 0.4, 0);
    b.triOut(crown, shoulder[k], shoulder[k1], 0, 0.4, 0);
  }
  let maxX = 0;
  for (let i = 0; i < b.pos.length; i += 3) maxX = Math.max(maxX, Math.abs(b.pos[i]));
  const sx = 0.5 / maxX;
  const sy = 1 / b.maxY();
  for (let i = 0; i < b.pos.length; i += 3) {
    b.pos[i] *= sx;
    b.pos[i + 1] *= sy;
    b.pos[i + 2] *= sx;
  }
  hedgeGeo = toGeometry(b, 1, 0, 1, 'flora-hedge-clump', seededRandom('flora-ao:hedge'));
  return hedgeGeo;
}

// ---------------------------------------------------------------------------
// Far-wood hull: the silhouette of a whole wood seen from 500 m to 2.5 km.
// 42 triangles. Unit size: radius 0.5 (1 across), 1 tall, base at y = 0.
// Near-vertical sides (a wood edge is abrupt) rising to a rim of alternating
// crown peaks and troughs, so the skyline of a wood is a bumpy line of
// individual crowns rather than a smooth loaf; a low centre keeps those bumps
// in the side silhouette. Occlusion darkens the base like shaded understorey.
// Scale 30-80 m across and 14-24 m tall.

let farWoodGeo = null;

export function farWoodGeometry() {
  if (farWoodGeo) return farWoodGeo;
  const b = new GeoBuilder();
  const rng = seededRandom('flora:far-wood');
  const N = 14;
  const step = TAU / N;
  const vol = { c: [0, 0.2, 0], r: [0.55, 0.85, 0.55] };
  // The rim and centre lean hard on the volume normal: from the air the
  // star-shaped top then shades as one soft canopy, and the crown bumps show
  // only where they matter, in the silhouette.
  // (targetY, targetR): where on the smooth volume the normal is read. Rim and
  // centre use one fixed height and radius, so a peak and the trough next to
  // it get the same normal and the top cannot shade as alternating wedges.
  const put = (x, y, z, u, blend, targetY = y, targetR = null) => {
    const d = Math.hypot(x, z);
    const s = targetR !== null && d > 1e-6 ? targetR / d : 1;
    const [tx, ty, tz] = volumeTarget(vol, x * s, targetY, z * s);
    return b.vert(x, y, z, u, y, TAG_HULL, tx, ty, tz, blend);
  };
  const base = [], rim = [];
  for (let k = 0; k < N; k++) {
    const a = k * step + (rng() * 2 - 1) * step * 0.2;
    const r = 0.48 + 0.02 * rng();
    base.push(put(Math.cos(a) * r, 0, Math.sin(a) * r, k / N, 0.5));
  }
  for (let k = 0; k < N; k++) {
    const a = (k + 0.5) * step + (rng() * 2 - 1) * step * 0.2;
    const peak = k % 2 === 0;
    // a slight taper: the wood edge leans back a little as it rises
    const r = peak ? 0.44 + 0.03 * rng() : 0.4 + 0.04 * rng();
    const y = peak ? 0.85 + 0.15 * rng() : 0.55 + 0.1 * rng();
    rim.push(put(Math.cos(a) * r, y, Math.sin(a) * r, k / N, 0.8, 0.8, 0.45));
  }
  const centre = put((rng() * 2 - 1) * 0.05, 0.7, (rng() * 2 - 1) * 0.05, 0.5, 0.8, 0.8, 0);
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    // base[k] and base[k1] straddle rim[k]
    b.triOut(base[k], rim[k], base[k1], 0, 0.35, 0);
    b.triOut(base[k1], rim[k], rim[k1], 0, 0.35, 0);
    b.triOut(centre, rim[k], rim[k1], 0, 0.3, 0);
  }
  let maxR = 0;
  for (let i = 0; i < b.pos.length; i += 3) maxR = Math.max(maxR, Math.hypot(b.pos[i], b.pos[i + 2]));
  const sr = 0.5 / maxR;
  const sy = 1 / b.maxY();
  for (let i = 0; i < b.pos.length; i += 3) {
    b.pos[i] *= sr;
    b.pos[i + 1] *= sy;
    b.pos[i + 2] *= sr;
  }
  farWoodGeo = toGeometry(b, 1, 0, 1, 'flora-far-wood', seededRandom('flora-ao:far-wood'));
  return farWoodGeo;
}
