// The TOWN map: a small European market town grown along the map's road.
//
// CONTRACT (wave 5, map+mode lane). Everything here is a deterministic function
// of the terrain feature set (terrain.js terrainFeatures()) and the helpers it
// is handed — no Math.random — so land use (the lots), scenery (the street
// surfaces), the battle (capture points) and the AI (the street graph) all see
// the same town without passing state around.
//
//   townPlanFor(features, helpers) -> TownPlan    memoised per features object
//     helpers = { terrainHeight, terrainSlope }   (both optional)
//
//   TownPlan = {
//     centre: { x, z },              the market square's centre (on the road)
//     radius,                        disc that covers the built-up area: land use
//                                    keeps fields, hedges and woods out of it
//     streets: [{ ax, az, bx, bz, w, kind }]   centrelines, w = full width (m);
//                                    kind 'main' | 'back' | 'cross' | 'alley' | 'lane'
//     square: { x, z, yaw, hw, hd }  the paved square (yaw: local +X = along road)
//     lots: [ landuse-style lots ]   { x, z, yaw, w, d, role, group: 'town',
//                                    archetype, ruined? } — w along local X, local
//                                    +Z faces the street (buildingKit's front)
//     zones: [{ key, x, z, r }]      capture points for Ground Domination
//     nodes: [{ id, x, z, links: [ids] }]   the street graph (tankAI routing)
//     axisYaw                        heading of the main street at the square
//   }
//
// The town follows the terrain road because the road is graded (terrain.js
// padMask) and the village feature it bends through is graded flatter still:
// the main street IS the road, the square sits where it passes the old village,
// back streets run parallel to it 42 m either side, cross streets and alleys
// tie the three together and lanes lead out into the fields. Blocks are rows of
// town houses on every street front with walled yards behind them, so a tank
// can only move along the streets — or flank through an alley or round the back.
//
// The archetype keys and dimensions below are the townhouse set added to the
// normandy kit in buildings.js; keep the two tables in step.

import * as THREE from 'three';
import { markSharedGeometry } from '../core/materials.js';

export const TOWN_ARCH = Object.freeze({
  townhouse: { key: 'normandy_townhouse', w: 9, d: 8.5 },
  narrow: { key: 'normandy_townhouse_narrow', w: 7, d: 9.5 },
  shop: { key: 'normandy_shop', w: 11, d: 9 },
  house: { key: 'normandy_house', w: 11, d: 7.5 },
  wall: { key: 'normandy_wall', w: 12, d: 0.6 },
  wallShort: { key: 'normandy_wall_short', w: 6, d: 0.6 },
  church: { key: 'normandy_church', w: 10, d: 22.6 },
});

// Hand-picked terrain seeds whose road and village lie on gentle ground (the
// built-up area holds its rows instead of losing them to slopes). Found with
// the wave-5 seed search (steel-skies-dev/wave5/mapmode/seedsearch.mjs: most
// level plots, church placed, capture points within 3.5 m of level).
export const TOWN_SEEDS = Object.freeze([
  [1914, -1153], [2312, -1380], [1763, -1847], [-417, -2863],
  [-2915, 839], [-1653, 2452], [-2050, -1093], [1820, -124],
]);

const MAIN_W = 12;
const BACK_W = 9;
const CROSS_W = 8.5;
const ALLEY_W = 6.5;
const LANE_W = 8;
const BACK_OFF = 42;          // back streets: metres either side of the main street
const MAIN_HALF = 168;        // main street length either side of the square
const BACK_HALF = 136;
const STATIONS = [-130, -75, -25, 25, 75, 130];    // cross streets (arc metres from the square)
const ALLEYS = [[-102, 1], [-50, -1], [50, 1], [102, -1]];   // [station, side]
const LANES = [[-75, -1], [-75, 1], [75, -1], [75, 1]];      // lanes out of the back streets
const LANE_LEN = 46;
const SQ_HALF_ALONG = 20.5;   // the square, inside the two cross streets at +/-25
const SQ_HALF_ACROSS = 24;
const WALK = 1.1;             // pavement between the street edge and a facade
const MAX_STEP = 2.2;         // metres of fall under a footprint (the uphill side is dug in)
const SPAWN_X = 330;

// ---------------------------------------------------------------------------
// small deterministic helpers

function mulberry(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(feat) {
  let h = 0x2545f491;
  const mix = (v) => {
    h = Math.imul(h ^ (Math.round(v * 10) | 0), 0x01000193);
    h ^= h >>> 13;
  };
  for (const p of feat.road || []) { mix(p.x); mix(p.z); }
  if (feat.town) { mix(feat.town.x); mix(feat.town.z); }
  return h >>> 0;
}

function polyline(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  return { pts, cum, total: cum[cum.length - 1] };
}

function segIndex(pl, s) {
  const n = pl.pts.length - 1;
  let i = 0;
  while (i < n - 1 && pl.cum[i + 1] < s) i++;
  return i;
}

// point and unit tangent at arc length s (clamped to the line)
function at(pl, s) {
  const S = Math.min(pl.total, Math.max(0, s));
  const i = segIndex(pl, S);
  const a = pl.pts[i];
  const b = pl.pts[i + 1];
  const L = pl.cum[i + 1] - pl.cum[i] || 1;
  const f = (S - pl.cum[i]) / L;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, tx: (b.x - a.x) / L, tz: (b.z - a.z) / L, i, f };
}

function nearestS(pl, x, z) {
  let best = Infinity;
  let bestS = 0;
  for (let i = 0; i + 1 < pl.pts.length; i++) {
    const a = pl.pts[i];
    const b = pl.pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const L2 = dx * dx + dz * dz || 1;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / L2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
    if (d < best) {
      best = d;
      bestS = pl.cum[i] + t * Math.sqrt(L2);
    }
  }
  return bestS;
}

// distance from point to segment
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}

// Oriented rectangles: { x, z, yaw, w, d }; local +X = (cos yaw, -sin yaw),
// local +Z = (sin yaw, cos yaw) — three.js rotation.y = yaw, as landuse.js.
function axes(r) {
  const c = Math.cos(r.yaw);
  const s = Math.sin(r.yaw);
  return { ux: c, uz: -s, vx: s, vz: c };
}

function corners(r) {
  const a = axes(r);
  const hw = r.w / 2;
  const hd = r.d / 2;
  const out = [];
  for (const [p, q] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    out.push(r.x + a.ux * hw * p + a.vx * hd * q, r.z + a.uz * hw * p + a.vz * hd * q);
  }
  return out;
}

function rectsOverlap(p, q, pad) {
  const A = axes(p);
  const B = axes(q);
  const dx = q.x - p.x;
  const dz = q.z - p.z;
  const tests = [[A.ux, A.uz], [A.vx, A.vz], [B.ux, B.uz], [B.vx, B.vz]];
  for (const [ax, az] of tests) {
    const rp = (p.w / 2) * Math.abs(A.ux * ax + A.uz * az) + (p.d / 2) * Math.abs(A.vx * ax + A.vz * az);
    const rq = (q.w / 2) * Math.abs(B.ux * ax + B.uz * az) + (q.d / 2) * Math.abs(B.vx * ax + B.vz * az);
    if (Math.abs(dx * ax + dz * az) > rp + rq + pad) return false;
  }
  return true;
}

// shortest distance from a segment to an oriented rectangle (0 if they touch)
function segRectDist(r, ax, az, bx, bz) {
  const A = axes(r);
  const loc = (x, z) => {
    const dx = x - r.x;
    const dz = z - r.z;
    return [dx * A.ux + dz * A.uz, dx * A.vx + dz * A.vz];
  };
  const [x0, z0] = loc(ax, az);
  const [x1, z1] = loc(bx, bz);
  const hw = r.w / 2;
  const hd = r.d / 2;
  // sample-free exact test: clip the segment to the box (slab test)
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dz = z1 - z0;
  let inside = true;
  for (const [p, q, lo, hi] of [[x0, dx, -hw, hw], [z0, dz, -hd, hd]]) {
    if (Math.abs(q) < 1e-9) {
      if (p < lo || p > hi) { inside = false; break; }
    } else {
      let ta = (lo - p) / q;
      let tb = (hi - p) / q;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) { inside = false; break; }
    }
  }
  if (inside) return 0;
  // otherwise: min over segment-to-edge distances
  const c = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const [ex, ez] = c[i];
    const [fx, fz] = c[(i + 1) % 4];
    best = Math.min(best, segDist(ex, ez, x0, z0, x1, z1), segDist(fx, fz, x0, z0, x1, z1));
    best = Math.min(best, segDist(x0, z0, ex, ez, fx, fz), segDist(x1, z1, ex, ez, fx, fz));
  }
  return best;
}

// ---------------------------------------------------------------------------

const memo = new WeakMap();

export function townPlanFor(features, helpers = {}) {
  if (!features || typeof features !== 'object') return null;
  const hit = memo.get(features);
  if (hit !== undefined) return hit;
  let plan = null;
  try {
    plan = buildTown(features, helpers);
  } catch (err) {
    console.warn('[town] plan failed:', err);
    plan = null;
  }
  memo.set(features, plan);
  return plan;
}

function buildTown(feat, helpers) {
  const road = (feat.road || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.z));
  if (road.length < 2) return null;
  const H = typeof helpers.terrainHeight === 'function' ? helpers.terrainHeight : () => 0;
  const rng = mulberry(seedOf(feat));
  const pl = polyline(road.map((p) => ({ x: p.x, z: p.z })));

  // the square: where the road passes nearest the graded village
  const tc = feat.town && Number.isFinite(feat.town.x) ? feat.town : { x: 0, z: 0 };
  let sC = nearestS(pl, tc.x, tc.z);
  sC = Math.max(MAIN_HALF + 20, Math.min(pl.total - MAIN_HALF - 20, sC));
  const C = at(pl, sC);
  const P = (s) => at(pl, sC + s);

  // ---- the main street: the road between sC - MAIN_HALF and sC + MAIN_HALF
  const vParams = [];
  for (let i = 1; i < pl.pts.length - 1; i++) {
    const s = pl.cum[i] - sC;
    if (s > -MAIN_HALF + 1 && s < MAIN_HALF - 1) vParams.push(s);
  }

  // ---- back streets: the main street offset BACK_OFF to each side, mitred at
  // the bends, parametrised by the same arc length (Q(side, s))
  const knots = [-MAIN_HALF, ...vParams, MAIN_HALF].sort((a, b) => a - b);
  const leftN = (t) => ({ x: -t.tz, z: t.tx });
  const offsetKnots = {};
  for (const side of [-1, 1]) {
    const out = [];
    for (let k = 0; k < knots.length; k++) {
      const s = knots[k];
      const p = P(s);
      let nx;
      let nz;
      if (k === 0 || k === knots.length - 1) {
        const n = leftN(p);
        nx = n.x;
        nz = n.z;
      } else {
        // the vertex itself: average the two segment normals, mitre length
        const a = P(s - 0.5);
        const b = P(s + 0.5);
        const na = leftN(a);
        const nb = leftN(b);
        let mx = na.x + nb.x;
        let mz = na.z + nb.z;
        const ml = Math.hypot(mx, mz) || 1;
        mx /= ml;
        mz /= ml;
        const cosH = Math.max(0.5, mx * na.x + mz * na.z);
        nx = mx / cosH;
        nz = mz / cosH;
      }
      out.push({ s, x: p.x + nx * side * BACK_OFF, z: p.z + nz * side * BACK_OFF });
    }
    offsetKnots[side] = out;
  }
  const Q = (side, s) => {
    const ks = offsetKnots[side];
    const S = Math.max(ks[0].s, Math.min(ks[ks.length - 1].s, s));
    let i = 0;
    while (i < ks.length - 2 && ks[i + 1].s < S) i++;
    const a = ks[i];
    const b = ks[i + 1];
    const f = (S - a.s) / ((b.s - a.s) || 1);
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  };

  // ---- the street graph -----------------------------------------------------
  const nodes = [];
  const nodeAt = (x, z) => {
    for (const n of nodes) if (Math.abs(n.x - x) < 0.6 && Math.abs(n.z - z) < 0.6) return n.id;
    const id = nodes.length;
    nodes.push({ id, x, z, links: [] });
    return id;
  };
  const link = (a, b) => {
    if (a === b) return;
    if (!nodes[a].links.includes(b)) nodes[a].links.push(b);
    if (!nodes[b].links.includes(a)) nodes[b].links.push(a);
  };
  const streets = [];
  const addStreet = (pts, w, kind) => {
    let prev = nodeAt(pts[0].x, pts[0].z);
    for (let i = 1; i < pts.length; i++) {
      const id = nodeAt(pts[i].x, pts[i].z);
      const a = nodes[prev];
      const b = nodes[id];
      if (Math.hypot(b.x - a.x, b.z - a.z) > 0.5) {
        streets.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, w, kind });
        link(prev, id);
      }
      prev = id;
    }
  };

  const crossS = STATIONS.slice();
  const alleyS = ALLEYS.map((a) => a[0]);
  const mainParams = [...new Set([-MAIN_HALF, MAIN_HALF, ...vParams, ...crossS, ...alleyS])]
    .sort((a, b) => a - b);
  addStreet(mainParams.map((s) => P(s)), MAIN_W, 'main');
  for (const side of [-1, 1]) {
    const bp = [...new Set([-BACK_HALF, BACK_HALF, ...crossS, ...alleyS,
      ...vParams.filter((s) => Math.abs(s) < BACK_HALF)])].sort((a, b) => a - b);
    addStreet(bp.map((s) => Q(side, s)), BACK_W, 'back');
    for (const s of crossS) addStreet([P(s), Q(side, s)], CROSS_W, 'cross');
  }
  for (const [s, side] of ALLEYS) addStreet([P(s), Q(side, s)], ALLEY_W, 'alley');
  for (const [s, side] of LANES) {
    const p = P(s);
    const q = Q(side, s);
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const l = Math.hypot(dx, dz) || 1;
    addStreet([q, { x: q.x + (dx / l) * LANE_LEN, z: q.z + (dz / l) * LANE_LEN }], LANE_W, 'lane');
  }

  // ---- the square: centred on the main street, axis along the chord ---------
  const pa = P(-SQ_HALF_ALONG);
  const pb = P(SQ_HALF_ALONG);
  const axX = pb.x - pa.x;
  const axZ = pb.z - pa.z;
  const axL = Math.hypot(axX, axZ) || 1;
  // local +X along the street: (cos yaw, -sin yaw) = (axX, axZ) / axL
  const sqYaw = Math.atan2(-axZ / axL, axX / axL);
  const square = {
    x: (pa.x + pb.x) / 2, z: (pa.z + pb.z) / 2, yaw: sqYaw,
    hw: SQ_HALF_ALONG + 2, hd: SQ_HALF_ACROSS,
  };
  const squareRect = { x: square.x, z: square.z, yaw: sqYaw, w: square.hw * 2, d: square.hd * 2 };

  // ---- lots -----------------------------------------------------------------
  const lots = [];
  const spawnClear = (r) => {
    for (let i = 0; i < 8; i += 2) {
      // (corners) inside the playable square and clear of both spawn strips
      const c = corners(r);
      const x = c[i];
      const z = c[i + 1];
      if (Math.abs(x) > 405 || Math.abs(z) > 405) return false;
      if (Math.abs(Math.abs(x) - SPAWN_X) < 60 && Math.abs(z) < 175) return false;
    }
    return true;
  };
  const level = (r) => {
    const c = corners(r);
    let lo = H(r.x, r.z);
    let hi = lo;
    for (let i = 0; i < 8; i += 2) {
      const y = H(c[i], c[i + 1]);
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    return hi - lo <= MAX_STEP;
  };
  const canPlace = (r, streetPad, lotPad) => {
    if (!spawnClear(r)) return false;
    for (const st of streets) {
      if (segRectDist(r, st.ax, st.az, st.bx, st.bz) < st.w / 2 + streetPad) return false;
    }
    if (rectsOverlap(r, squareRect, 0.8)) return false;
    for (const l of lots) if (rectsOverlap(r, l, lotPad)) return false;
    return level(r);
  };
  const pickArch = (outer) => {
    const u = rng();
    if (outer) return u < 0.55 ? TOWN_ARCH.house : u < 0.8 ? TOWN_ARCH.townhouse : TOWN_ARCH.narrow;
    return u < 0.45 ? TOWN_ARCH.townhouse : u < 0.75 ? TOWN_ARCH.narrow : TOWN_ARCH.shop;
  };
  const role = (a) => (a === TOWN_ARCH.house ? 'house' : 'townhouse');

  // walk a street front: lots facing the street, nearly shoulder to shoulder
  const front = (ax, az, bx, bz, halfW, side, outer = false) => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 6) return;
    const tx = (bx - ax) / L;
    const tz = (bz - az) / L;
    const nx = -tz * side;      // from the street toward the lot
    const nz = tx * side;
    const yaw = Math.atan2(-nx, -nz);   // local +Z faces the street (-n)
    let s = 2;
    while (s < L - 4) {
      const a = pickArch(outer);
      const set = halfW + WALK + a.d / 2 + rng() * 0.25;
      const cs = s + a.w / 2;
      if (cs + a.w / 2 > L - 1) break;
      const r = {
        x: ax + tx * cs + nx * set, z: az + tz * cs + nz * set, yaw, w: a.w, d: a.d,
      };
      if (canPlace(r, WALK - 0.2, 0.25)) {
        lots.push({ ...r, role: role(a), group: 'town', archetype: a.key });
        s += a.w + 0.15 + rng() * 0.35;
      } else {
        s += 1.5;
      }
    }
  };

  // church first, on the square's flank, side toward the old village
  const vSide = ((tc.x - C.x) * -C.tz + (tc.z - C.z) * C.tx) >= 0 ? 1 : -1;
  {
    const a = TOWN_ARCH.church;
    const ux = Math.cos(sqYaw);
    const uz = -Math.sin(sqYaw);
    const nx = -uz;    // left of the street axis
    const nz = ux;
    for (const side of [vSide, -vSide]) {
      // long axis along the street: local Z (d) along u, so yaw = atan2(ux, uz)
      const off = SQ_HALF_ACROSS + 1.5 + a.w / 2;
      const r = { x: square.x + nx * side * off, z: square.z + nz * side * off, yaw: Math.atan2(ux, uz), w: a.w, d: a.d };
      if (canPlace(r, 1.0, 1.0)) {
        lots.push({ ...r, role: 'church', group: 'town', archetype: a.key });
        break;
      }
    }
  }

  // the square's own facades (between the two cross streets)
  {
    const ux = Math.cos(sqYaw);
    const uz = -Math.sin(sqYaw);
    for (const side of [-1, 1]) {
      const nx = -uz * side;
      const nz = ux * side;
      const ox = square.x + nx * SQ_HALF_ACROSS;
      const oz = square.z + nz * SQ_HALF_ACROSS;
      // a "street" of width 0 along the square's edge, lots on its far side;
      // front() puts lots on the side `s` of the direction a->b, so pick the
      // direction whose left (side=+1) points away from the square
      const ax = ox - ux * SQ_HALF_ALONG;
      const az = oz - uz * SQ_HALF_ALONG;
      const bx = ox + ux * SQ_HALF_ALONG;
      const bz = oz + uz * SQ_HALF_ALONG;
      // left normal of (b-a) is (-uz, ux) = n for side +1
      front(ax, az, bx, bz, 0, side);
    }
  }

  // every street, both sides; main street first so its fronts are the fullest,
  // then the back streets, then the yard walls, then whatever fits on the
  // cross streets, alleys and lanes
  const frontsOf = (kinds) => {
    for (const kind of kinds) {
      for (const st of streets) {
        if (st.kind !== kind) continue;
        const outer = kind === 'back' || kind === 'lane';
        for (const side of [1, -1]) {
          front(st.ax, st.az, st.bx, st.bz, st.w / 2, side, outer);
          // reversed too: a short block is often fillable only from the other end
          front(st.bx, st.bz, st.ax, st.az, st.w / 2, -side, outer);
        }
      }
    }
  };
  frontsOf(['main', 'back']);

  // ---- garden walls down the middle of every block's yards -------------------
  const yardMid = (MAIN_W / 2 + WALK + 8.5 + (BACK_OFF - BACK_W / 2 - WALK - 8.5)) / 2;
  const walls = [];
  for (const side of [-1, 1]) {
    for (let k = 0; k + 1 < STATIONS.length; k++) {
      const s0 = STATIONS[k] + CROSS_W / 2 + 2;
      const s1 = STATIONS[k + 1] - CROSS_W / 2 - 2;
      if (s0 < SQ_HALF_ALONG && s1 > -SQ_HALF_ALONG) continue;  // the square's block
      let s = s0;
      while (s < s1 - 3) {
        const len = s1 - s >= TOWN_ARCH.wall.w ? TOWN_ARCH.wall.w : TOWN_ARCH.wallShort.w;
        if (s + len > s1 + 0.5) break;
        const a = len === TOWN_ARCH.wall.w ? TOWN_ARCH.wall : TOWN_ARCH.wallShort;
        const m = s + len / 2;
        const p = P(m);
        const q = Q(side, m);
        const fx = (q.x - p.x) / BACK_OFF;
        const fz = (q.z - p.z) / BACK_OFF;
        const cx = p.x + fx * yardMid;
        const cz = p.z + fz * yardMid;
        // the wall runs along the street: local X along the tangent
        const yaw = Math.atan2(-p.tz, p.tx);
        const r = { x: cx, z: cz, yaw, w: a.w, d: a.d };
        if (canPlace(r, 0.6, 0.4)) {
          walls.push({ ...r, role: 'wall', group: 'town', archetype: a.key });
          lots.push(walls[walls.length - 1]);
          s += len + 0.2;
        } else {
          s += 2;
        }
      }
    }
  }

  frontsOf(['cross', 'alley', 'lane']);

  // ---- war damage: a share of the houses stand as ruins ---------------------
  for (const l of lots) {
    if (l.role !== 'townhouse' && l.role !== 'house') continue;
    // never the square's own fronts: the landmark stays readable
    if (rectsOverlap(l, squareRect, 6)) continue;
    if (rng() < 0.13) l.ruined = true;
  }

  // ---- capture points -------------------------------------------------------
  const qb = Q(-1, -118);
  const qc = Q(1, 118);
  const zones = [
    { key: 'A', x: square.x, z: square.z, r: 22 },
    { key: 'B', x: qb.x, z: qb.z, r: 17 },
    { key: 'C', x: qc.x, z: qc.z, r: 17 },
  ];
  // keep team A/B/C order by the road direction: B toward team 0 (x < 0)
  if (zones[1].x > zones[2].x) {
    const t = zones[1];
    zones[1] = { ...zones[2], key: 'B' };
    zones[2] = { ...t, key: 'C' };
  }

  // ---- extent ---------------------------------------------------------------
  let radius = 0;
  for (const l of lots) radius = Math.max(radius, Math.hypot(l.x - square.x, l.z - square.z) + Math.hypot(l.w, l.d) / 2);
  for (const st of streets) {
    radius = Math.max(radius, Math.hypot(st.ax - square.x, st.az - square.z), Math.hypot(st.bx - square.x, st.bz - square.z));
  }

  return {
    centre: { x: square.x, z: square.z },
    radius: Math.min(radius + 6, 240),
    streets,
    square,
    lots,
    zones,
    nodes,
    axisYaw: Math.atan2(C.tx, C.tz),
    walls: walls.length,
  };
}

// ---------------------------------------------------------------------------
// Street surfaces (scenery calls this for a town map). Cobbled setts on every
// street and the square, one mesh, laid on the ground a hand's breadth up. UVs
// are world metres, so where two streets overlap the setts line up exactly and
// the junction shows no seam. Returns { meshes, owned } for scenery's books.


let settMat = null;
let settQ = '';

function paintSetts(size) {
  // sRGB bytes by hand (never through THREE.Color): grey granite setts in
  // staggered courses with dark joints, a little colour variation per stone
  const alb = new Uint8ClampedArray(size * size * 4);
  const hgt = new Float32Array(size * size);
  const rows = 8;          // courses per tile (tile = 3 m -> 0.37 m courses)
  const cols = 6;
  const h = (a, b) => {
    let t = Math.imul(a * 374761393 + b * 668265263, 0x27d4eb2d);
    t ^= t >>> 15;
    return ((t >>> 0) % 1000) / 1000;
  };
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * rows;
    const row = Math.floor(fy);
    const vy = fy - row;
    const shift = (row % 2) * 0.5;
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cols + shift;
      const col = Math.floor(fx);
      const vx = fx - col;
      const ex = Math.min(vx, 1 - vx) * 2;
      const ey = Math.min(vy, 1 - vy) * 2;
      const edge = Math.min(ex * 1.25, ey);
      const joint = edge < 0.16;
      const k = h(((col % cols) + cols) % cols, row);
      const k2 = h(x * 7 + 3, y * 13 + 1);
      let r;
      let g;
      let b;
      if (joint) {
        r = 74; g = 70; b = 62;
      } else {
        const base = 118 + k * 34 + (k2 - 0.5) * 16;
        const warm = (h(col, row + 99) - 0.5) * 12;
        r = base + warm;
        g = base + warm * 0.4 - 2;
        b = base - warm * 0.3 - 6;
      }
      const i = (y * size + x) * 4;
      alb[i] = r;
      alb[i + 1] = g;
      alb[i + 2] = b;
      alb[i + 3] = 255;
      hgt[y * size + x] = joint ? 0 : Math.min(1, 0.4 + edge) + (k2 - 0.5) * 0.05;
    }
  }
  const nrm = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = hgt[y * size + ((x - 1 + size) % size)];
      const rr = hgt[y * size + ((x + 1) % size)];
      const u = hgt[((y - 1 + size) % size) * size + x];
      const d = hgt[((y + 1) % size) * size + x];
      let nx = (l - rr) * 2.2;
      let ny = (u - d) * 2.2;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      nrm[i] = ((nx / len) * 0.5 + 0.5) * 255;
      nrm[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      nrm[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
    }
  }
  return { alb, nrm };
}

function dataTexture(bytes, size, srgb) {
  const t = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return markSharedGeometry(t);
}

function streetMaterial(quality) {
  const q = quality === 'low' ? 'low' : quality === 'medium' ? 'medium' : 'high';
  if (settMat && settQ === q) return settMat;
  const size = q === 'low' ? 128 : q === 'medium' ? 256 : 512;
  const p = paintSetts(size);
  const m = new THREE.MeshStandardMaterial({
    name: 'town:setts',
    color: 0xffffff,
    map: dataTexture(new Uint8Array(p.alb.buffer), size, true),
    normalMap: q === 'low' ? null : dataTexture(new Uint8Array(p.nrm.buffer), size, false),
    roughness: 0.93,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  m.normalScale.set(0.8, 0.8);
  settMat = markSharedGeometry(m);
  settQ = q;
  return settMat;
}

const TILE_M = 3;      // metres per sett tile
const LIFT = { main: 0.16, square: 0.15, cross: 0.14, back: 0.13, alley: 0.12, lane: 0.11 };

export function buildTownSurfaces(plan, { terrainHeight, quality = 'high' } = {}) {
  if (!plan) return { meshes: [], owned: [] };
  const H = typeof terrainHeight === 'function' ? terrainHeight : () => 0;
  const pos = [];
  const uv = [];
  const idx = [];
  const strip = (ax, az, bx, bz, w, lift) => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.5) return;
    const tx = (bx - ax) / L;
    const tz = (bz - az) / L;
    const nx = -tz;
    const nz = tx;
    // a little past each end so junctions overlap instead of gapping
    const ext = w * 0.5;
    const n = Math.max(1, Math.ceil((L + 2 * ext) / 2.5));
    const across = Math.max(2, Math.ceil(w / 3));
    const base = pos.length / 3;
    for (let i = 0; i <= n; i++) {
      const s = -ext + ((L + 2 * ext) * i) / n;
      const cx = ax + tx * s;
      const cz = az + tz * s;
      for (let j = 0; j <= across; j++) {
        const o = (j / across - 0.5) * w;
        const x = cx + nx * o;
        const z = cz + nz * o;
        pos.push(x, H(x, z) + lift, z);
        uv.push(x / TILE_M, z / TILE_M);
      }
    }
    const rw = across + 1;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < across; j++) {
        const a = base + i * rw + j;
        const b = a + 1;
        const c = a + rw;
        const d = c + 1;
        // b - a runs across the street, c - a along it (for the left-normal
        // across direction): (b - a) x (c - a) is +Y, so (a, b, c) and
        // (b, d, c) face up
        idx.push(a, b, c, b, d, c);
      }
    }
  };
  for (const st of plan.streets) strip(st.ax, st.az, st.bx, st.bz, st.w, LIFT[st.kind] ?? 0.12);
  // the square as one more broad strip along its axis
  const sq = plan.square;
  const ux = Math.cos(sq.yaw);
  const uz = -Math.sin(sq.yaw);
  strip(sq.x - ux * sq.hw, sq.z - uz * sq.hw, sq.x + ux * sq.hw, sq.z + uz * sq.hw, sq.hd * 2, LIFT.square);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, streetMaterial(quality));
  mesh.name = 'town:streets';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  // decal-like: drawn with the ground, before anything translucent
  mesh.renderOrder = -4;
  return { meshes: [mesh], owned: [geo] };
}

// The town's footprint as a disc in the shape groundcover.js reads
// features.town in: no grass inside 0.6 r, thinning out to r. Widened by a
// quarter so the 0.6 r core reaches the outer streets.
export function townDisc(plan) {
  return plan ? { x: plan.centre.x, z: plan.centre.z, radius: plan.radius * 1.25 } : null;
}
