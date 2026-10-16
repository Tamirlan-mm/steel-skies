// Airfields: the place an aeroplane goes home to.
//
// This is the single implementation of the field — its geometry, the solid
// surface and obstacles an aeroplane can touch, the messages a landing earns,
// and the ground crew. It was lifted out of AirBattle so the combined battle
// can have one too without a second copy drifting away from the first.
//
// The module is deliberately free of battle-class internals. Everything the
// callers own — the ground-unit list, the HUD, the camera shake, the particle
// system, who the player is — arrives through an explicit `ctx` object, and
// every field of it is optional. A caller that passes `{}` gets a silent,
// effectless, but still correct airfield.
//
// WHAT IS SOLID. An airfield is a graded PLATFORM: a rectangle of mown grass at
// one level, with the concrete runway, the apron and the blast pens let into
// it, and an earth EMBANKMENT (the berm) sloping from its edge down to the
// natural ground. There is no terrain-flatten API in this project —
// terrainHeight() is analytic and nobody may write to it — so the platform is
// poured just above the highest ground under its own footprint and the berm
// carries it back down to the hillside. The platform, the berm and every
// building on the field are registered here as SOLID, and planeEntity.js asks
// groundSurfaceAt() / airfieldObstacleAt() wherever it used to ask
// terrainHeight(): the tyres roll on the concrete, the belly scrapes it, and a
// hangar is a wall, not scenery. The registry is module state: createAirfield()
// adds to it, the airfield's dispose() (and disposeAirfields()) removes it, so a
// battle that already disposes its airfields on teardown needs nothing else.
//
// WHO FLIES THE LANDING. The landing itself — touchdown, the oleos taking the
// sink rate or failing to, the ground roll, the brakes, the lift-off — is
// planeEntity.js's, because it is physics and runs inside the flight model's
// own substeps. This file reads what happened (plane.lastContact) and turns it
// into what the battle shows: messages, dust, a camera kick, the ground crew.

import * as THREE from 'three';
// same specifier vehicles/tanks.js already uses, so this resolves to the one
// module instance rather than a second copy of the merger
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { terrainHeight, paintTerrainSurface } from './terrain.js';
import {
  steelMaterial, mattMaterial, alloyMaterial, glassMaterial,
} from '../core/materials.js';
import { ASSET_MANIFEST } from '../core/assets.js';
import { photoSurfaceMaterial } from './buildings.js';
import { input as globalInput } from '../core/input.js';
import { radioCue } from '../core/audio.js';
import { clamp, rand } from '../core/utils.js';

// ---------------------------------------------------------------------------
// public constants
// ---------------------------------------------------------------------------

// The strip runs along X, so a takeoff run from either field points straight at
// the other side. These are the defaults; createAirfield() takes overrides.
export const STRIP_HALF_LEN = 150;
export const STRIP_HALF_WID = 22;
// Metres the platform stands above the highest natural ground under its whole
// footprint. It only has to clear the terrain MESH, which never rises above
// the analytic surface it is sampled from; the old 4.5 was there to keep an
// aeroplane's 1.6 m crash test off the hillside, and the crash test is now
// against this platform itself.
export const STRIP_CLEARANCE = 1.5;
export const SERVICE_TIME = 17; // seconds on the ground for a full repair and rearm

// Everything an airfield builds — apron, hangars, revetments, tower — lives
// inside this box around its centre. Scenery keep-out is derived from it.
const APRON_DEPTH = 58;
const APRON_WIDTH = 170;
const REVET_DEPTH = 32;
// The graded grass reaches this far past the concrete: an overrun beyond both
// runway ends and a strip of field outside the pens and the apron, wide enough
// to put an aeroplane down beside the runway rather than only on it. The
// overrun matters most at the OUTER end: every landing rolls toward the map
// edge (there is no approach from beyond it), and 40 m puts the crest of the
// embankment past MAP_EDGE (1200) for a field at 1020, so an aeroplane that
// runs long is stopped on the grass by the edge instead of launched off the
// fill.
const FIELD_OVERRUN = 40;
const FIELD_SIDE = 14;
// The embankment: metres of run per metre of drop. 2.4:1 is a graded earth
// fill an engineer would sign off and a tailwheel can still roll down.
const BERM_RUN = 2.4;
const BERM_MAX = 95; // never wider than this, however deep the valley below
// The mown grass sits this far below the concrete, so the slabs read as laid
// into the field rather than z-fighting with it.
const GRASS_DROP = 0.04;

// Service only happens with the aeroplane actually stopped, and is abandoned if
// it leaves at speed (a touch-and-go is not a pit stop).
const SERVICE_STOPPED = 1.5;
const SERVICE_ABANDON = 14;
// Where the crew line an aeroplane up when the runway ahead of it is too short
// to take off from: this far in from the outer end of the concrete.
const LINEUP_IN = 10;

const _pos = new THREE.Vector3();

// ---------------------------------------------------------------------------
// the registry: every airfield that is solid right now
// ---------------------------------------------------------------------------

const ACTIVE = [];

export function registerAirfield(af) {
  if (af && !ACTIVE.includes(af)) ACTIVE.push(af);
  return af;
}

export function unregisterAirfield(af) {
  const i = ACTIVE.indexOf(af);
  if (i >= 0) ACTIVE.splice(i, 1);
}

// Belt and braces for a teardown that lost its handles: drops every field.
export function clearAirfieldRegistry() {
  ACTIVE.length = 0;
}

// Read-only view of what is registered. Do not keep it.
export function activeAirfields() {
  return ACTIVE;
}

// ---------------------------------------------------------------------------
// surface and obstacle queries — the API planeEntity.js and planeAI.js use
// ---------------------------------------------------------------------------

// Distance from (lx, lz), in the field's own frame, to its platform rectangle.
// Zero inside. Euclidean outside, so the berm turns its corners in a curve.
function platformDist(af, lx, lz) {
  const p = af.platform;
  const dx = lx < p.minX ? p.minX - lx : lx > p.maxX ? lx - p.maxX : 0;
  const dz = lz < p.minZ ? p.minZ - lz : lz > p.maxZ ? lz - p.maxZ : 0;
  return dx === 0 && dz === 0 ? 0 : Math.sqrt(dx * dx + dz * dz);
}

function onConcrete(af, lx, lz) {
  const c = af.concrete;
  for (let i = 0; i < c.length; i++) {
    const r = c[i];
    if (lx >= r.minX && lx <= r.maxX && lz >= r.minZ && lz <= r.maxZ) return true;
  }
  return false;
}

// One field's contribution at (x, z): writes out.y / out.kind / out.af and
// returns true, or returns false where the field is not above the natural
// ground (outside the berm's foot). `terrain` is terrainHeight(x, z), passed in
// so a caller looping over several fields samples the hillside once.
function fieldSurface(af, x, z, terrain, out) {
  const lx = x - af.x;
  const lz = z - af.z;
  const r = af.reach;
  if (lx < r.minX || lx > r.maxX || lz < r.minZ || lz > r.maxZ) return false;
  const d = platformDist(af, lx, lz);
  if (d === 0) {
    if (onConcrete(af, lx, lz)) {
      out.y = af.y;
      out.kind = 'concrete';
    } else {
      out.y = af.y - GRASS_DROP;
      out.kind = 'grass';
    }
    out.af = af;
    return true;
  }
  const h = af.y - GRASS_DROP - d / BERM_RUN;
  if (h <= terrain) return false;
  out.y = h;
  out.kind = 'berm';
  out.af = af;
  return true;
}

const surfScratch = { y: 0, kind: 'terrain', af: null };

/**
 * The solid ground at (x, z): the natural terrain, or an airfield's concrete,
 * grass or embankment where one stands above it. Allocation-free; pass your
 * own `out` if you need to keep the result past the next call.
 * @returns {{y:number, kind:'terrain'|'concrete'|'grass'|'berm', af:object|null}}
 */
export function groundSurfaceAt(x, z, out = surfScratch) {
  const t = terrainHeight(x, z);
  out.y = t;
  out.kind = 'terrain';
  out.af = null;
  for (let i = 0; i < ACTIVE.length; i++) {
    const af = ACTIVE[i];
    // a field's own surface always wins inside its footprint; two fields
    // never overlap, so the first hit is the only one
    if (fieldSurface(af, x, z, t, out)) break;
  }
  return out;
}

// Height of the solid ground at (x, z) — terrainHeight() with the airfields
// standing on it.
export function groundHeightAt(x, z) {
  return groundSurfaceAt(x, z, surfScratch).y;
}

// The top of the airfield at (x, z), or null where no airfield stands above
// the natural ground.
export function airfieldSurfaceAt(x, z) {
  const s = groundSurfaceAt(x, z, surfScratch);
  return s.af ? s.y : null;
}

/**
 * The first solid building, wall or parked aeroplane on any registered field
 * that contains the world point, grown by `pad` metres; null if none.
 * Each obstacle is { minX, maxX, minY, maxY, minZ, maxZ, name } in world space.
 */
export function airfieldObstacleAt(x, y, z, pad = 0) {
  for (let i = 0; i < ACTIVE.length; i++) {
    const af = ACTIVE[i];
    const b = af.obstacleBounds;
    if (!b) continue;
    if (x < b.minX - pad || x > b.maxX + pad) continue;
    if (z < b.minZ - pad || z > b.maxZ + pad) continue;
    if (y < b.minY - pad || y > b.maxY + pad) continue;
    const list = af.obstacles;
    for (let k = 0; k < list.length; k++) {
      const o = list[k];
      if (x < o.minX - pad || x > o.maxX + pad) continue;
      if (z < o.minZ - pad || z > o.maxZ + pad) continue;
      if (y < o.minY - pad || y > o.maxY + pad) continue;
      return o;
    }
  }
  return null;
}

// Highest obstacle top over (x, z), or -Infinity. For ground avoidance: an AI
// that clears the ground but not the control tower has not cleared anything.
export function obstacleTopAt(x, z, pad = 0) {
  let top = -Infinity;
  for (let i = 0; i < ACTIVE.length; i++) {
    const af = ACTIVE[i];
    const b = af.obstacleBounds;
    if (!b) continue;
    if (x < b.minX - pad || x > b.maxX + pad || z < b.minZ - pad || z > b.maxZ + pad) continue;
    const list = af.obstacles;
    for (let k = 0; k < list.length; k++) {
      const o = list[k];
      if (x < o.minX - pad || x > o.maxX + pad || z < o.minZ - pad || z > o.maxZ + pad) continue;
      if (o.maxY > top) top = o.maxY;
    }
  }
  return top;
}

// The field whose PLATFORM (concrete or grass, not the embankment) contains
// (x, z) — where an aeroplane can be serviced — or null.
export function airfieldAtPoint(x, z) {
  for (let i = 0; i < ACTIVE.length; i++) {
    const af = ACTIVE[i];
    if (platformDist(af, x - af.x, z - af.z) === 0) return af;
  }
  return null;
}

// ---------------------------------------------------------------------------
// small ctx helpers — every hook is optional
// ---------------------------------------------------------------------------

function isPlayerPlane(plane, ctx) {
  if (ctx && 'player' in ctx) return plane === ctx.player;
  return !!plane.isPlayer;
}

function say(ctx, text, kind = 'info', alsoLog = false) {
  if (!ctx) return;
  if (typeof ctx.onMessage === 'function') {
    ctx.onMessage(text, kind, alsoLog);
    return;
  }
  ctx.hud?.incomingMessage?.(text, kind, alsoLog);
}

function award(ctx, title, subtitle = '') {
  if (!ctx) return;
  if (typeof ctx.onAward === 'function') {
    ctx.onAward(title, subtitle);
    return;
  }
  ctx.hud?.showAward?.(title, subtitle);
}

function cue(ctx, kind) {
  if (!ctx) return;
  const fn = typeof ctx.radioCue === 'function' ? ctx.radioCue : radioCue;
  fn(kind);
}

function inputOf(ctx) {
  return (ctx && ctx.input) || globalInput;
}

// ---------------------------------------------------------------------------
// per-plane state
// ---------------------------------------------------------------------------

// The battle seeds these at spawn; every entry point here seeds them as well,
// because a missing serviceFrac would turn into NaN on the first service tick
// and the HUD would read "NaN%".
export function initPlaneAirfieldState(plane) {
  if (!plane) return plane;
  if (plane.onGround === undefined) plane.onGround = false;
  if (plane.serviceFrac === undefined) plane.serviceFrac = 0;
  if (plane.rearmTimer === undefined) plane.rearmTimer = 0;
  if (plane.airfield === undefined) plane.airfield = null;
  if (plane.groundYaw === undefined) plane.groundYaw = plane.yaw || 0;
  if (plane.afWarnCd === undefined) plane.afWarnCd = 0;
  if (plane.afRumbleCd === undefined) plane.afRumbleCd = 0;
  if (plane.afSeenContact === undefined) plane.afSeenContact = plane.lastContact ? plane.lastContact.seq : 0;
  // A NaN that already got in is worse than a missing field, because it is
  // sticky: NaN + dt is NaN forever.
  if (!Number.isFinite(plane.serviceFrac)) plane.serviceFrac = 0;
  if (!Number.isFinite(plane.rearmTimer)) plane.rearmTimer = 0;
  return plane;
}

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// surfaces: CC0 photo scans (design/research-assets.md section 5; art bible
// E-20 / E-22). Detail-only scans tinted to calibrated linear albedo, mapped in
// the field's own frame (tops take x, z), see buildings.js photoSurfaceMaterial.
// Cached for the session and stamped shared, like the factory materials: the
// battle teardown sweeps must leave them alone, and so does dispose() below.
// ---------------------------------------------------------------------------

const srgbLin = (b) => {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
// packed sRGB hex -> LINEAR triple, by hand (never through THREE.Color)
const hexLin = (hex) => [srgbLin((hex >> 16) & 255), srgbLin((hex >> 8) & 255), srgbLin(hex & 255)];

// E-20 weathered runway concrete, band Y 0.25-0.38: Y 0.313.
const CONCRETE_TINT = [0.325, 0.312, 0.288];
// Tar macadam (tar with stone chippings, weathered), taxiways and apron: Y 0.113.
const TARMAC_TINT = [0.118, 0.112, 0.104];
// Worn white paint on concrete (E-22 threshold bars): Y 0.57, the concrete
// grain showing through it.
const PAINT_TINT = [0.58, 0.57, 0.53];
// Boundary boards on the grass (E-22): white-painted planks, Y 0.55.
const BOARD_TINT = [0.57, 0.555, 0.52];
// On snow (field Y ~0.81) white boards vanish; E-22 also allows yellow, and
// winter fields were marked in dark as well: weathered chrome-yellow planks
// (Y 0.38, sRGB ~#c8a43a) alternating with tarred ones (Y 0.030, the C-01
// painted-black floor is 0.025), the corner Ls tarred.
const BOARD_YELLOW_TINT = [0.58, 0.37, 0.045];
const BOARD_DARK_TINT = [0.032, 0.030, 0.027];
// Slab joints of the concrete runway: 6 m bays along it, 5.5 m lanes across.
const JOINTS = { px: 6, pz: 5.5, width: 0.022, dark: 0.45, tone: 0.045 };

const surfCache = new Map();
function surface(key, cfg) {
  if (!surfCache.has(key)) surfCache.set(key, photoSurfaceMaterial({ mapping: 'object', vertexColors: false, jitter: 0, ...cfg }));
  return surfCache.get(key);
}

// The grass of the graded field: a mown version of the biome's own cover so
// it meets the hillside (and the embankment, which wears the terrain's own
// material) without a seam. E-20: on the green biomes it is pasture.
function fieldCover(palette) {
  const biome = palette && palette.biome;
  const t = ASSET_MANIFEST.terrain && biome ? ASSET_MANIFEST.terrain[biome] : null;
  if ((biome === 'winter' || biome === 'desert') && t && t.cover) return t.cover;
  return (ASSET_MANIFEST.airfield && ASSET_MANIFEST.airfield.grass) || 'Grass001';
}

// True when the field is too bright for white boards to read: brighter than
// the brightest sand (C-07, 0.42) - the winter snow field (Y 0.81) and any
// biome under fallen snow (palette.low Y 0.44-0.57). The boards switch colour.
function brightField(grassHex) {
  const c = hexLin(grassHex);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.42;
}

// { runway, tarmac, paint, board, boardDark?, grass } photo materials, or null
// if a scan is missing from the manifest (the caller keeps the procedural
// factory ones). On a bright (snow) field `board` is the yellow board and
// `boardDark` the tarred one.
function airfieldSurfaces(grassHex, palette) {
  const AF = ASSET_MANIFEST.airfield || {};
  const runwaySet = AF.runway || 'concrete_floor_damaged_01';
  const tarmacSet = AF.tarmac || 'tarred_gravel';
  const cover = fieldCover(palette);
  const snow = brightField(grassHex);
  const mown = cover === 'Grass001' || cover === 'withered_grass';
  const out = {
    runway: surface('runway', {
      name: 'airfield:runway', a: { set: runwaySet, tint: CONCRETE_TINT, rough: 0.9 }, joints: JOINTS, macro: { scale: 34, amp: 0.05 },
    }),
    tarmac: surface('tarmac', { name: 'airfield:tarmac', a: { set: tarmacSet, tint: TARMAC_TINT, rough: 0.86 }, macro: { scale: 16, amp: 0.07 } }),
    paint: surface('paint', { name: 'airfield:paint', a: { set: runwaySet, tint: PAINT_TINT, rough: 0.8, normal: 0.6 } }),
    board: snow
      ? surface('board|yellow', { name: 'airfield:board', a: { set: 'weathered_plank_siding', tint: BOARD_YELLOW_TINT, rough: 0.8 } })
      : surface('board', { name: 'airfield:board', a: { set: 'weathered_plank_siding', tint: BOARD_TINT, rough: 0.85 } }),
    grass: surface(`grass|${cover}|${grassHex}`, {
      name: 'airfield:grass',
      // mown: flatter and a touch smoother than the meadow (research F-03)
      a: { set: cover, tint: hexLin(grassHex), normal: mown ? 0.6 : 0.8, rough: mown ? 0.9 : 0.95 },
      // patchy growth over tens of metres, as the terrain's own cover has
      macro: { scale: 22, amp: mown ? 0.11 : 0.06 },
    }),
  };
  if (snow) out.boardDark = surface('board|dark', { name: 'airfield:board-dark', a: { set: 'weathered_plank_siding', tint: BOARD_DARK_TINT, rough: 0.9 } });
  for (const k of Object.keys(out)) if (!out[k]) return null;
  for (const k of ['paint', 'board', 'boardDark']) {
    if (!out[k]) continue;
    // a few centimetres proud of the surface they lie on: pull them forward
    // in depth instead of standing them taller
    out[k].polygonOffset = true;
    out[k].polygonOffsetFactor = -1;
    out[k].polygonOffsetUnits = -4;
  }
  return out;
}

// One material's worth of static geometry, merged into a single mesh. The
// renderer audit found this scene starving on draw calls and idling on
// triangles, so the airfield spends triangles and buys back calls.
class Batch {
  constructor(material, opts = {}) {
    this.material = material;
    this.cast = opts.cast !== false;
    this.receive = opts.receive !== false;
    this.parts = [];
  }

  // Geometry is authored at the origin, then rotated and moved into the
  // airfield's local frame. Rotation first — translating first would swing the
  // part around the field instead of around itself.
  add(geo, x = 0, y = 0, z = 0, ry = 0, rz = 0) {
    if (rz) geo.rotateZ(rz);
    if (ry) geo.rotateY(ry);
    geo.translate(x, y, z);
    this.parts.push(geo);
    return this;
  }

  build(group, owned) {
    if (!this.parts.length) return null;
    const merged = this.parts.length === 1 ? this.parts[0] : mergeGeometries(this.parts, false);
    if (this.parts.length > 1) for (const g of this.parts) g.dispose();
    this.parts.length = 0;
    if (!merged) return null;
    const mesh = new THREE.Mesh(merged, this.material);
    mesh.castShadow = this.cast;
    mesh.receiveShadow = this.receive;
    owned.push(merged);
    group.add(mesh);
    return mesh;
  }
}

// The terrain mesh of this scene, if one has been added: the embankment is
// drawn with ITS material so the fill and the hillside it runs into are one
// surface under one light, and the seam where they meet disappears.
function findTerrainMesh(scene) {
  if (!scene || !scene.children) return null;
  for (const o of scene.children) {
    if (o.isMesh && o.geometry && o.geometry.getAttribute && o.geometry.getAttribute('aSurf')) return o;
  }
  return null;
}

// The embankment. A grid over the platform rectangle grown by the berm's
// reach, its vertices on the analytic berm surface where that stands above the
// natural ground and tucked just under the hillside where it does not, so the
// fill visibly runs out onto the slope instead of ending in a cliff. Grid lines
// fall exactly on the platform's edges, which is where the crest crease is.
//
// Vertex colour and the four surface weights come from terrain.js's own
// per-vertex rule (paintTerrainSurface), so with the terrain's material the
// fill shades exactly like the hill it meets.
function buildBerm(af, scene, palette, owned, group) {
  const p = af.platform;
  const reach = af.bermWidth;
  if (reach <= 0.5) return null;
  const axis = (lo, hi, inside) => {
    const out = [];
    const outerN = Math.max(2, Math.ceil(reach / 6));
    for (let i = 0; i < outerN; i++) out.push(lo - reach + (reach * i) / outerN);
    const innerN = Math.max(1, Math.ceil((hi - lo) / inside));
    for (let i = 0; i <= innerN; i++) out.push(lo + ((hi - lo) * i) / innerN);
    for (let i = 1; i <= outerN; i++) out.push(hi + (reach * i) / outerN);
    return out;
  };
  const xs = axis(p.minX, p.maxX, 24);
  const zs = axis(p.minZ, p.maxZ, 24);
  const nx = xs.length;
  const nz = zs.length;
  const top = af.y - GRASS_DROP;
  const pos = new Float32Array(nx * nz * 3);
  const above = new Uint8Array(nx * nz);
  const inside = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const lx = xs[i];
      const lz = zs[j];
      const wx = af.x + lx;
      const wz = af.z + lz;
      const t = terrainHeight(wx, wz);
      const d = platformDist(af, lx, lz);
      const h = top - d / BERM_RUN;
      let y;
      if (h > t + 0.02) {
        y = h;
        above[k] = 1;
      } else {
        // under the hillside: deep enough that the terrain mesh, which can sit
        // a little below the analytic surface between its own vertices, still
        // covers it
        y = t - 1.4;
      }
      // the platform itself is drawn by the grass slab; strictly interior
      // cells are skipped below, but their corners still need a height
      if (d === 0) inside[k] = 1;
      pos[k * 3] = lx;
      pos[k * 3 + 1] = y - af.y;
      pos[k * 3 + 2] = lz;
    }
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // a cell wholly inside the platform is under the grass slab
      if (inside[a] && inside[b] && inside[c] && inside[d]) continue;
      if (!(above[a] || above[b] || above[c] || above[d])) continue;
      // counter-clockwise seen from above (+Y): a(i,j) -> c(i,j+1) -> b(i+1,j)
      idx.push(a, c, b, b, c, d);
    }
  }
  if (!idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const terrainMesh = findTerrainMesh(scene);
  // 'color' and 'aSurf' exactly as the ground's own vertices would have them
  // at these world positions (the geometry is local to the group, which
  // stands at af.x, af.y, af.z). Since the land-use wave aSurf.y is BARE
  // EARTH, not the old height share: painting the fill by that old rule put
  // plough-brown on 22-35% of every embankment. turf: a sown, built bank keeps
  // its grass on a 1:2.4 face where the biome's natural-slope rule would bare it.
  // The vertices tucked under the hillside are painted at the ground they are
  // tucked under, not 1.4 m below it (the damp-hollow share is height-driven:
  // up to 20% more soil at the seam), then put back exactly.
  const builtPos = pos.slice();
  for (let k = 0; k < nx * nz; k++) {
    if (!above[k]) pos[k * 3 + 1] += 1.4;
  }
  paintTerrainSurface(geo, palette, { x: af.x, y: af.y, z: af.z }, { turf: true });
  pos.set(builtPos);
  owned.push(geo);
  // The terrain's material is per battle and owned by the terrain mesh: the
  // battle's scene sweep frees it with the terrain, and dispose() below only
  // frees this geometry. Without a terrain mesh (a test scene) the fill is
  // plain earth from the shared factory.
  const mat = terrainMesh ? terrainMesh.material : mattMaterial(0x6f7650, { rough: 1, flatShading: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'airfieldBerm';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  group.add(mesh);
  return mesh;
}

// How far out the berm has to reach to get down to the natural ground, looked
// for around the whole platform edge. Capped, and never narrower than a slope
// that still reads as a bank.
function measureBerm(cx, cz, platform, y) {
  const top = y - GRASS_DROP;
  let reach = 4;
  const stepAlong = 10;
  const edges = [];
  for (let x = platform.minX; x <= platform.maxX; x += stepAlong) {
    edges.push([x, platform.minZ, 0, -1], [x, platform.maxZ, 0, 1]);
  }
  for (let z = platform.minZ; z <= platform.maxZ; z += stepAlong) {
    edges.push([platform.minX, z, -1, 0], [platform.maxX, z, 1, 0]);
  }
  // corners walk out on the diagonal
  const s = Math.SQRT1_2;
  edges.push(
    [platform.minX, platform.minZ, -s, -s], [platform.maxX, platform.minZ, s, -s],
    [platform.minX, platform.maxZ, -s, s], [platform.maxX, platform.maxZ, s, s],
  );
  for (const [lx, lz, dx, dz] of edges) {
    for (let d = 2; d <= BERM_MAX; d += 2) {
      const h = top - d / BERM_RUN;
      if (h <= terrainHeight(cx + lx + dx * d, cz + lz + dz * d)) {
        if (d > reach) reach = d;
        break;
      }
      if (d >= BERM_MAX) reach = BERM_MAX;
    }
  }
  return Math.min(BERM_MAX, reach + 4);
}

// Suggested AA emplacements, ringing the field and clear of the concrete AND of
// the embankment: a gun is placed on the natural ground by its own class, so a
// spot on the berm would bury it. The guns themselves are NOT built here: they
// belong to the battle's groundUnits list, which owns their update, targeting
// and teardown, and the two battles want different numbers of them.
function aaSpots(af, count = 6) {
  const out = [];
  const tmp = { y: 0, kind: 'terrain', af: null };
  for (let i = 0; i < count; i++) {
    const sx = i < Math.ceil(count / 2) ? -1 : 1;
    const sz = i % 2 === 0 ? -1 : 1;
    const x = af.x + sx * rand(60, 130);
    let z = af.z + sz * rand(95, 145);
    // walk outward until the gun stands on the hillside, not on the fill
    for (let k = 0; k < 30; k++) {
      const t = terrainHeight(x, z);
      if (!fieldSurface(af, x, z, t, tmp)) break;
      z += sz * 6;
    }
    out.push({ x, z, y: terrainHeight(x, z) });
  }
  return out;
}

// Push an axis-aligned obstacle box, given in the field's own frame with y from
// the platform top, into world space.
function addObstacle(list, af, name, minX, maxX, minY, maxY, minZ, maxZ) {
  list.push({
    name,
    minX: af.x + minX,
    maxX: af.x + maxX,
    minY: af.y + minY,
    maxY: af.y + maxY,
    minZ: af.z + minZ,
    maxZ: af.z + maxZ,
  });
}

/**
 * Build one airfield, add it to the scene and register it as solid.
 *
 * WHERE TO PUT IT. With the default size the concrete occupies
 *     x from cx - 150 to cx + 150,   z from cz - 80 to cz + 54
 * the graded platform x from cx - 190 to cx + 190, z from cz - 94 to cz + 68,
 * and the embankment reaches up to 95 m further (usually 30-70). It must sit
 * inside the terrain mesh, because there is no ground past the mesh edge for
 * the berm to run out onto. Both battles use x = -/+1020, z = 0 on a 2600 m
 * mesh: the platform's outer end is 10 m past MAP_EDGE (1200), so the edge,
 * not the embankment, is what stops an aeroplane that rolls long.
 *
 * @param {THREE.Scene} scene  add the terrain mesh FIRST: the berm borrows its
 *                             material so the fill and the hillside match.
 * @param {object} opts
 *   team       {number}   0 or 1. Only used for ownership and paint.
 *   x, z       {number}   centre of the runway, world metres.
 *   halfLen    {number}   runway half length along X (default 150).
 *   halfWid    {number}   runway half width along Z (default 22).
 *   clearance  {number}   metres above the highest ground under the platform.
 *   heading    {number}   yaw a departing aircraft should be pointed at.
 *   detail     {boolean}  false builds the platform, slab and markings only.
 *   palette    {object}   the map preset handed to buildTerrain (low/high/rock),
 *                         so the embankment is coloured like the hillside.
 *   register   {boolean}  false keeps the field out of the solid registry (a
 *                         preview); default true.
 *   buildAA    {function} (airfield, spots) => void. Called once, after the
 *                         airfield's y is known, so the caller can push AA guns
 *                         onto its own ground-unit list.
 * @returns {object} the airfield handle.
 */
export function createAirfield(scene, opts = {}) {
  const {
    team = 0,
    x: cx = 0,
    z: cz = 0,
    halfLen = STRIP_HALF_LEN,
    halfWid = STRIP_HALF_WID,
    clearance = STRIP_CLEARANCE,
    detail = true,
    buildAA = null,
    palette = null,
    register = true,
  } = opts;
  const heading = opts.heading !== undefined
    ? opts.heading
    : (team === 0 ? Math.PI / 2 : -Math.PI / 2);

  // The graded platform, in the field's own frame.
  const platform = {
    minX: -(halfLen + FIELD_OVERRUN),
    maxX: halfLen + FIELD_OVERRUN,
    minZ: -(halfWid + APRON_DEPTH + FIELD_SIDE),
    maxZ: halfWid + REVET_DEPTH + FIELD_SIDE,
  };

  // Sample the whole platform, not just the runway: a hill under the apron or
  // the overrun would otherwise stand up through the grass.
  let maxY = -Infinity;
  for (let x = platform.minX; x <= platform.maxX + 0.01; x += 8) {
    for (let z = platform.minZ; z <= platform.maxZ + 0.01; z += 8) {
      const h = terrainHeight(cx + x, cz + z);
      if (h > maxY) maxY = h;
    }
  }
  if (!Number.isFinite(maxY)) maxY = 0;
  const y = maxY + clearance;

  const group = new THREE.Group();
  const owned = []; // geometries this airfield allocated and must dispose

  // Materials are CACHED AND SHARED across every caller (the surface scans
  // here, the procedural factory for the furniture). Disposing them would
  // blank somebody else's textures, so dispose() below leaves them alone.
  //
  // Surfaces (E-20): the runway is weathered concrete, the apron and the pens
  // tar macadam, the field mown pasture of the biome's own cover; all photo
  // scans from core/assets.js. If a scan were missing from the manifest the
  // old factory stand-ins are used: steelMaterial with the metalness taken out
  // for the concrete, and tinted green and tiled larger for the field.
  const grassHex = palette && palette.low != null ? palette.low : 0x5f7a45;
  const photo = airfieldSurfaces(grassHex, palette);
  const concreteMat = photo ? photo.runway : steelMaterial(0x63655d, { rough: 0.97, metal: 0.04, scale: 5.5 });
  const tarmacMat = photo ? photo.tarmac : concreteMat;
  const grassMat = photo ? photo.grass : steelMaterial(grassHex, { rough: 1, metal: 0, scale: 9 });
  const paintMat = photo ? photo.paint : mattMaterial(0xcfd0c4, { rough: 0.82, flatShading: false });
  const boardMat = photo ? photo.board : paintMat;
  // snow field: yellow and tarred boards alternate (only with the photo set)
  const boardDarkMat = photo && photo.boardDark ? photo.boardDark : null;
  const steelMat = steelMaterial(0x565b4f, { rough: 0.58, metal: 0.55, scale: 2.2 });
  const oliveMat = mattMaterial(0x4d5240, { rough: 0.95 });
  const sockMat = mattMaterial(0xd06a24, { rough: 0.9, flatShading: false });
  const skinMat = alloyMaterial(team === 0 ? 0x6d7a68 : 0x6a6f78, { wear: 0.55, scale: 2.2 });
  const glassMat = glassMaterial();

  const grass = new Batch(grassMat, { cast: false });
  const concrete = new Batch(concreteMat, { cast: false });
  const tarmac = new Batch(tarmacMat, { cast: false });
  const paint = new Batch(paintMat, { cast: false });
  const boards = new Batch(boardMat, { cast: false });
  const boardsDark = boardDarkMat ? new Batch(boardDarkMat, { cast: false }) : null;
  const steel = new Batch(steelMat);
  const olive = new Batch(oliveMat);
  const skin = new Batch(skinMat);
  const sock = new Batch(sockMat);
  const glass = new Batch(glassMat);

  // ---- the graded field ----
  {
    const w = platform.maxX - platform.minX;
    const d = platform.maxZ - platform.minZ;
    const g = new THREE.PlaneGeometry(w, d, 1, 1);
    g.rotateX(-Math.PI / 2);
    grass.add(g, (platform.minX + platform.maxX) / 2, -GRASS_DROP, (platform.minZ + platform.maxZ) / 2);
  }

  // ---- the concrete, let into the field ----
  // Each slab is also a rectangle of the solid-surface model, so what is drawn
  // as concrete is exactly what rolls like concrete.
  // The runway is concrete, the apron and the pens tar macadam; both are the
  // 'concrete' kind of the surface model (hard standing), exactly as before.
  const SLAB = 0.6;
  const concreteRects = [];
  const slab = (w, d, x, z, batch = concrete) => {
    batch.add(new THREE.BoxGeometry(w, SLAB, d), x, -SLAB / 2, z);
    concreteRects.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
  };
  slab(halfLen * 2, halfWid * 2, 0, 0);
  const apronZ = -(halfWid + APRON_DEPTH / 2);
  const apronW = Math.min(APRON_WIDTH, halfLen * 2 - 40);
  if (detail) slab(apronW, APRON_DEPTH, -halfLen * 0.18, apronZ, tarmac);

  // Blast pens on the far side, so a strafing run has to pick its way between
  // earth walls instead of hosing a line of parked aircraft.
  const revetX = [-halfLen * 0.64, 0, halfLen * 0.64];
  if (detail) {
    for (const px of revetX) slab(34, REVET_DEPTH, px, halfWid + REVET_DEPTH / 2 - 1, tarmac);
  }

  // ---- the paint ----
  // E-22: a wartime concrete strip carried threshold bars and nothing else
  // (no centreline, no edge stripes, no taxi lines). 3 cm of worn paint, held
  // off the slab by polygon offset rather than by standing 12 cm proud of the
  // surface the wheels actually roll on.
  const PAINT_T = photo ? 0.03 : 0.12;
  const PY = PAINT_T / 2;
  for (const end of [-1, 1]) {
    for (let k = -2; k <= 2; k++) {
      paint.add(new THREE.BoxGeometry(7, PAINT_T, 2.6), end * (halfLen - 10), PY, k * 5.2);
    }
  }

  const af = {
    team,
    x: cx,
    z: cz,
    y,
    halfLen,
    halfWid,
    heading,
    group,
    geometries: owned,
    // Kept for the benefit of teardown code that iterates it. It is EMPTY on
    // purpose: every material here is shared and cached by core/materials.js,
    // and the embankment borrows the terrain's, which the terrain owns.
    materials: [],
    platform,
    concrete: concreteRects,
    obstacles: [],
    obstacleBounds: null,
    bermWidth: 0,
    reach: null,
    keepOut: null,
    bounds: {
      minX: cx - halfLen,
      maxX: cx + halfLen,
      minZ: cz - (halfWid + APRON_DEPTH),
      maxZ: cz + (halfWid + REVET_DEPTH),
    },
    spots: null,
    scene,
    disposed: false,
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      unregisterAirfield(this);
      this.group.parent?.remove(this.group);
      for (const g of this.geometries) g.dispose();
      this.geometries.length = 0;
    },
  };
  const obs = af.obstacles;

  if (detail) {
    // ---- boundary boards (E-22) ----
    // White planks laid flat round the edge of the landing ground, every 50-60
    // m along the sides and in an L at each corner: how a grass field showed a
    // pilot where it ended. 5 cm thick on the grass, so their top is 1 cm above
    // the concrete level: drawn flat, nothing for a wheel to hit (E-21).
    const BT = 0.05;
    const by = -GRASS_DROP + BT / 2;
    const inset = 5;
    const bx0 = platform.minX + inset;
    const bx1 = platform.maxX - inset;
    const bz0 = platform.minZ + inset;
    const bz1 = platform.maxZ - inset;
    const clearOfHard = (x, z, r) => !onConcrete({ concrete: concreteRects }, x - r, z)
      && !onConcrete({ concrete: concreteRects }, x + r, z)
      && !onConcrete({ concrete: concreteRects }, x, z - r)
      && !onConcrete({ concrete: concreteRects }, x, z + r);
    // dark: the tarred board of a snow field (corner Ls and every other one)
    const board = (x, z, alongX, dark) => {
      if (!clearOfHard(x, z, 1.6)) return;
      (dark && boardsDark ? boardsDark : boards).add(new THREE.BoxGeometry(alongX ? 2.4 : 0.45, BT, alongX ? 0.45 : 2.4), x, by, z);
    };
    // corner boards slide 0.975 m inward so the two meet in an L
    const L = 0.975;
    const nX = Math.max(2, Math.round((bx1 - bx0) / 55));
    for (let i = 0; i <= nX; i++) {
      const x = bx0 + ((bx1 - bx0) * i) / nX + (i === 0 ? L : i === nX ? -L : 0);
      const dark = i === 0 || i === nX || i % 2 === 1;
      board(x, bz0, true, dark);
      board(x, bz1, true, dark);
    }
    const nZ = Math.max(1, Math.round((bz1 - bz0) / 50));
    for (let i = 0; i <= nZ; i++) {
      const z = bz0 + ((bz1 - bz0) * i) / nZ + (i === 0 ? L : i === nZ ? -L : 0);
      const dark = i === 0 || i === nZ || i % 2 === 1;
      board(bx0, z, false, dark);
      board(bx1, z, false, dark);
    }

    // ---- hangars: two half-barrel blister sheds on the apron ----
    for (const hx of [-halfLen * 0.52, -halfLen * 0.16]) {
      const shell = new THREE.CylinderGeometry(9, 9, 26, 16, 1, false, 0, Math.PI);
      steel.add(shell, hx, 0, apronZ - 4, 0, Math.PI / 2);
      olive.add(new THREE.BoxGeometry(0.6, 8.4, 16), hx - 13.3, 4.2, apronZ - 4);
      addObstacle(obs, af, 'hangar', hx - 13.6, hx + 13, 0, 9, apronZ - 4 - 9, apronZ - 4 + 9);
    }

    // ---- control tower ----
    const tx = halfLen * 0.27;
    const tz = -(halfWid + 12);
    olive.add(new THREE.BoxGeometry(7, 8, 7), tx, 4, tz);
    steel.add(new THREE.BoxGeometry(8.4, 0.5, 8.4), tx, 8.25, tz);
    glass.add(new THREE.BoxGeometry(7.6, 3, 7.6), tx, 10, tz);
    steel.add(new THREE.BoxGeometry(9, 0.6, 9), tx, 11.8, tz);
    steel.add(new THREE.CylinderGeometry(0.12, 0.12, 5, 5), tx + 3.2, 14.5, tz);
    addObstacle(obs, af, 'control tower', tx - 4.5, tx + 4.5, 0, 12.1, tz - 4.5, tz + 4.5);
    addObstacle(obs, af, 'control tower', tx + 2.9, tx + 3.5, 12.1, 17, tz - 0.3, tz + 0.3);

    // ---- revetment walls: a U of earth open toward the runway ----
    for (const px of revetX) {
      olive.add(new THREE.BoxGeometry(32, 4.5, 3), px, 2.25, halfWid + 28);
      addObstacle(obs, af, 'revetment', px - 16, px + 16, 0, 4.5, halfWid + 26.5, halfWid + 29.5);
      for (const side of [-1, 1]) {
        olive.add(new THREE.BoxGeometry(3, 4.5, 26), px + side * 14.5, 2.25, halfWid + 14);
        addObstacle(
          obs, af, 'revetment',
          px + side * 14.5 - 1.5, px + side * 14.5 + 1.5, 0, 4.5, halfWid + 1, halfWid + 27,
        );
      }
    }

    // ---- windsocks: the one piece of airfield furniture a pilot reads ----
    for (const side of [-1, 1]) {
      const mx = side * (halfLen - 26);
      const mz = side * (halfWid + 9);
      steel.add(new THREE.CylinderGeometry(0.18, 0.24, 9, 6), mx, 4.5, mz);
      const hoop = new THREE.TorusGeometry(1.0, 0.1, 5, 12);
      hoop.rotateY(Math.PI / 2);
      steel.add(hoop, mx + 0.6, 8.6, mz);
      olive.add(new THREE.BoxGeometry(3.2, 0.9, 3.2), mx, 0.45, mz);
      sock.add(
        new THREE.CylinderGeometry(1.15, 0.5, 4.6, 8),
        mx + 3.0, 8.2, mz + 0.9, 0.45, Math.PI / 2 - 0.16,
      );
      addObstacle(obs, af, 'windsock', mx - 1.6, mx + 1.6, 0, 0.9, mz - 1.6, mz + 1.6);
      addObstacle(obs, af, 'windsock', mx - 0.3, mx + 0.3, 0.9, 9.2, mz - 0.3, mz + 0.3);
    }

    // ---- fuel bowsers on the apron ----
    for (const side of [-1, 1]) {
      const bx = -halfLen * 0.18 + side * 52;
      const bz = apronZ + 18;
      steel.add(new THREE.CylinderGeometry(1.4, 1.4, 5.2, 10), bx, 2.0, bz, 0, Math.PI / 2);
      olive.add(new THREE.BoxGeometry(2.6, 2.2, 2.4), bx + 3.9, 1.5, bz);
      olive.add(new THREE.CylinderGeometry(0.55, 0.55, 0.5, 8), bx + 3.9, 0.55, bz + 1.3, 0, Math.PI / 2);
      olive.add(new THREE.CylinderGeometry(0.55, 0.55, 0.5, 8), bx - 1.6, 0.55, bz + 1.3, 0, Math.PI / 2);
      addObstacle(obs, af, 'fuel bowser', bx - 2.7, bx + 5.3, 0, 3.4, bz - 1.5, bz + 1.6);
    }

    // ---- parked scenery aircraft: two in the pens, one on the apron ----
    // Static props, not entities: nothing shoots them and nothing flies them.
    // They are here because an empty airfield reads as a car park — and they
    // are solid, because taxiing through one should end the way it would.
    const parkAircraft = (px, pz, ry) => {
      const fus = new THREE.CylinderGeometry(0.95, 0.5, 8.6, 8);
      skin.add(fus, px, 1.35, pz, ry, Math.PI / 2);
      const nose = new THREE.ConeGeometry(0.75, 1.5, 8);
      const nx = Math.cos(ry) * 4.9;
      const nz = -Math.sin(ry) * 4.9;
      skin.add(nose, px + nx, 1.35, pz + nz, ry, -Math.PI / 2);
      const wing = new THREE.BoxGeometry(1.9, 0.32, 11.5);
      skin.add(wing, px, 0.98, pz, ry);
      const tp = new THREE.BoxGeometry(1.2, 0.24, 4.6);
      const tx2 = Math.cos(ry) * -3.6;
      const tz2 = -Math.sin(ry) * -3.6;
      skin.add(tp, px + tx2, 1.5, pz + tz2, ry);
      const fin = new THREE.BoxGeometry(1.3, 1.9, 0.28);
      skin.add(fin, px + tx2 * 1.08, 2.3, pz + tz2 * 1.08, ry);
      // fuselage along the nose direction, wings square to it
      const along = Math.abs(Math.cos(ry)) > 0.5;
      if (along) addObstacle(obs, af, 'parked aircraft', px - 4.5, px + 5.7, 0, 3.3, pz - 5.75, pz + 5.75);
      else addObstacle(obs, af, 'parked aircraft', px - 5.75, px + 5.75, 0, 3.3, pz - 5.7, pz + 4.5);
    };
    parkAircraft(revetX[0], halfWid + 15, Math.PI / 2);
    parkAircraft(revetX[2], halfWid + 15, Math.PI / 2);
    parkAircraft(-halfLen * 0.18 + 34, apronZ - 6, 0);
  }

  grass.build(group, owned);
  concrete.build(group, owned);
  tarmac.build(group, owned);
  paint.build(group, owned);
  boards.build(group, owned);
  if (boardsDark) boardsDark.build(group, owned);
  steel.build(group, owned);
  olive.build(group, owned);
  skin.build(group, owned);
  sock.build(group, owned);
  glass.build(group, owned);

  // ---- the embankment ----
  af.bermWidth = measureBerm(cx, cz, platform, y);
  af.reach = {
    minX: platform.minX - af.bermWidth,
    maxX: platform.maxX + af.bermWidth,
    minZ: platform.minZ - af.bermWidth,
    maxZ: platform.maxZ + af.bermWidth,
  };
  buildBerm(af, scene, palette, owned, group);

  // One box round every obstacle, so a query far from the buildings costs
  // four comparisons.
  if (obs.length) {
    const b = {
      minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity,
    };
    for (const o of obs) {
      b.minX = Math.min(b.minX, o.minX); b.maxX = Math.max(b.maxX, o.maxX);
      b.minY = Math.min(b.minY, o.minY); b.maxY = Math.max(b.maxY, o.maxY);
      b.minZ = Math.min(b.minZ, o.minZ); b.maxZ = Math.max(b.maxZ, o.maxZ);
    }
    af.obstacleBounds = b;
  }

  // Footprint for scenery keep-out registration — scatterPositions() in
  // scenery.js takes { avoid: {x, z}, avoidR }, which is exactly this shape.
  // It covers the platform AND the embankment, or the hillside's trees would
  // come up through the fill.
  {
    const hx = Math.max(-platform.minX, platform.maxX) + af.bermWidth * 0.85;
    const hz = Math.max(-platform.minZ, platform.maxZ) + af.bermWidth * 0.85;
    af.keepOut = { x: cx, z: cz, r: Math.hypot(hx, hz) * 0.94 };
  }

  group.position.set(cx, y, cz);
  scene.add(group);
  if (register) registerAirfield(af);

  af.spots = aaSpots(af);
  if (typeof buildAA === 'function') buildAA(af, af.spots);
  return af;
}

// The keep-out discs for a list of airfields, in the shape scenery.js wants.
// Register these before scattering props or the trees grow through the runway.
export function airfieldKeepOut(airfields) {
  const out = [];
  if (!airfields) return out;
  for (const af of airfields) if (af && af.keepOut) out.push(af.keepOut);
  return out;
}

// Disposes and unregisters every field in the list. A battle teardown that
// calls this needs nothing else to leave the solid registry empty.
export function disposeAirfields(airfields) {
  if (!airfields) return;
  for (const af of airfields) af?.dispose?.();
}

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

// Which runway, if any, is this aircraft over? Rectangular test, matching the
// runway concrete exactly. Kept for callers that want "over the strip".
export function airfieldUnder(airfields, plane) {
  if (!airfields || !plane) return null;
  for (const af of airfields) {
    if (!af) continue;
    if (Math.abs(plane.position.x - af.x) > af.halfLen) continue;
    if (Math.abs(plane.position.z - af.z) > af.halfWid) continue;
    return af;
  }
  return null;
}

export function homeAirfield(airfields, team) {
  if (!airfields || !airfields.length) return null;
  return airfields.find((a) => a && a.team === team) || airfields[0];
}

// ---------------------------------------------------------------------------
// what a landing looks and sounds like
// ---------------------------------------------------------------------------

// Present whatever the flight model reported since the last call: the
// touchdown, a bounce, a collapse, the lift-off. Called by both entry points
// below, so a touchdown that happened inside plane.update() is shown the same
// frame whichever of the two the battle calls next.
function presentContacts(plane, ctx) {
  const c = plane.lastContact;
  if (!c || c.seq === plane.afSeenContact) return null;
  plane.afSeenContact = c.seq;
  const player = isPlayerPlane(plane, ctx);
  const af = c.af || null;
  switch (c.kind) {
    case 'touchdown': {
      plane.airfield = af;
      plane.serviceFrac = 0;
      ctx.effects?.trackDust?.(_pos.copy(plane.position), 1, c.surface === 'concrete' ? 0xb8b0a0 : 0x9a8a68, 0.05);
      if (player) {
        ctx.shake?.add?.(clamp(0.1 + c.sink * 0.07, 0.1, 0.5), 0.4);
        const sink = c.sink.toFixed(1);
        if (af && af.team === plane.team) {
          say(ctx, `Touchdown, ${sink} m/s — brakes (B), stop to be serviced`, 'info');
        } else if (af) {
          say(ctx, 'Enemy airfield', 'warn');
        } else {
          say(ctx, `Off-field landing, ${sink} m/s`, 'warn');
        }
      }
      ctx.onTouchDown?.(plane, af);
      return 'touchdown';
    }
    case 'bounce':
      if (player) {
        ctx.shake?.add?.(clamp(0.12 + c.sink * 0.06, 0.12, 0.45), 0.35);
        say(ctx, `Bounced, ${c.sink.toFixed(1)} m/s — ease it down`, 'warn');
      }
      return 'bounce';
    case 'liftoff':
      plane.serviceFrac = 0;
      if (player) say(ctx, 'Airborne — gear up (G)', 'info');
      // The battle owns the chase camera: it may want to snap it back
      // behind the aircraft on rotation.
      ctx.onTakeOff?.(plane);
      return 'liftoff';
    case 'collapse':
    case 'belly':
      if (player) ctx.shake?.add?.(0.6, 0.6);
      ctx.effects?.trackDust?.(_pos.copy(plane.position), 1, 0x9a8a68, 0.08);
      return c.kind;
    default:
      return c.kind;
  }
}

// The approach and the touchdown. The flight model decides whether an arrival
// was a landing (gear down and locked, sink rate the oleos can take, wings
// level, nothing but the tyres touching); this only reports it, and warns the
// player who is about to arrive without wheels.
//
// Returns the airfield if the aircraft touched down since the last call.
export function updateAirfieldService(plane, dt, ctx = {}) {
  if (!plane) return null;
  initPlaneAirfieldState(plane);
  if (plane.afWarnCd > 0) plane.afWarnCd -= dt;
  const what = presentContacts(plane, ctx);
  if (plane.onGround || plane.state !== 'alive') return what === 'touchdown' ? plane.airfield : null;

  // Gear warning: low and slow over a field, descending, with the wheels not
  // down and locked. "Slow" keeps a strafing run across the field quiet.
  const slow = plane.gearLim ? plane.ias < plane.gearLim.vle * 1.35 : plane.speed < plane.spec.stallSpeed * 2;
  if (isPlayerPlane(plane, ctx) && plane.afWarnCd <= 0 && plane.vel && plane.vel.y < 0 && slow) {
    const field = airfieldAtPoint(plane.position.x, plane.position.z);
    if (field && plane.position.y - field.y < 45 && !(plane.gearPos >= 1)) {
      plane.afWarnCd = 3;
      say(ctx, plane.gearGone ? 'No undercarriage — do not land' : 'Gear not down — go around', 'warn');
    }
  }
  return what === 'touchdown' ? plane.airfield : null;
}

// Compatibility shim for callers that used to force a landing: puts the
// aeroplane on its wheels where it is. The flight model normally does this
// itself on contact.
export function touchDown(plane, af, ctx = {}) {
  if (!plane) return;
  initPlaneAirfieldState(plane);
  if (typeof plane.settleOnGround === 'function') plane.settleOnGround();
  else plane.onGround = true;
  plane.airfield = af || plane.airfield;
  presentContacts(plane, ctx);
}

// ---------------------------------------------------------------------------
// ground handling
// ---------------------------------------------------------------------------

// One frame of an aeroplane on its wheels. The physics — thrust, drag, the
// tyres, the brakes, the tail coming up and the wing taking the weight — is
// planeEntity's own ground model and runs inside plane.update(); this hands it
// the pilot's ground controls, works the ground crew, and does the dust.
//
// Player ground controls: Q / E steer (rudder, and the tailwheel at taxiing
// speed), B is the wheel brake. AI aeroplanes steer with their own yaw.
//
// Returns 'rolling' | 'airborne' | 'wrecked' | 'dead' | 'none'.
export function updateGroundRoll(plane, dt, ctx = {}) {
  if (!plane) return 'none';
  initPlaneAirfieldState(plane);
  if (plane.afRumbleCd > 0) plane.afRumbleCd -= dt;

  if (isPlayerPlane(plane, ctx)) {
    const inp = inputOf(ctx);
    plane.groundRudder = (inp.down('KeyQ') ? 1 : 0) - (inp.down('KeyE') ? 1 : 0);
  } else {
    plane.groundRudder = clamp((plane.controls && plane.controls.yaw) || 0, -1, 1);
  }

  if (typeof plane.update === 'function') plane.update(dt);
  const what = presentContacts(plane, ctx);
  if (plane.state !== 'alive') return plane.state === 'dead' && plane.wreckedOnGround ? 'wrecked' : 'dead';
  if (!plane.onGround) return 'airborne';

  if (plane.speed > 6) {
    const surf = plane.groundKind || 'concrete';
    ctx.effects?.trackDust?.(
      _pos.copy(plane.position).addScaledVector(plane.dir, -2),
      clamp(plane.speed / 40, 0, 1),
      surf === 'concrete' ? 0x9a9a92 : 0x9a8a68,
      dt,
    );
    if (isPlayerPlane(plane, ctx) && plane.afRumbleCd <= 0) {
      // the strip is not glass and the field less so: a fast roll rattles
      plane.afRumbleCd = 0.1;
      const rough = surf === 'concrete' ? 1 : 1.8;
      ctx.shake?.add?.((0.01 + plane.speed * 0.001) * rough, 0.16);
    }
  }

  serviceOnGround(plane, dt, ctx);
  return 'rolling';
}

// Compatibility shim: lift off now, whatever the wing thinks. The ground model
// normally decides this itself.
export function takeOff(plane, ctx = {}) {
  if (!plane) return;
  initPlaneAirfieldState(plane);
  if (typeof plane.liftOff === 'function') plane.liftOff();
  else plane.onGround = false;
  presentContacts(plane, ctx);
}

// ---------------------------------------------------------------------------
// the ground crew
// ---------------------------------------------------------------------------

// Platform a type needs ahead of it to be off and climbing before the edge of
// the fill, from a standstill at full throttle with the flaps UP (the worst a
// pilot can do it): its lift-off roll scales as Vs^2 m / T, and through the
// real ground model that roll is 1.38-1.61 times Vs^2 m / T (Zero 66 m,
// Spitfire 72, Il-2 130, P-51 131, Fw 190 146; takeoff flaps take a fifth to
// a quarter off). 1.65 of it, 30% on top, and 40 m to climb away in.
function takeoffRoomNeeded(spec) {
  const thrust = spec && spec.powerplant ? spec.powerplant.thrust : 0;
  if (!(thrust > 0) || !(spec.mass > 0)) return Infinity;
  const vs = spec.stallSpeed > 0 ? spec.stallSpeed : 25;
  return 1.3 * 1.65 * vs * vs * spec.mass / thrust + 40;
}

// The crew have just turned a stopped aeroplane to face the departure heading
// (serviceOnGround). The runway ahead of it now is only what it rolled down
// after touching down, plus the overrun: an Il-2 that touched down at the
// threshold and braked hard stopped 33-59 m in, swung round with 75-100 m in
// front of it, was told "full throttle to take off", and ran off the end of
// the fill. When that is less than the type needs, the crew tow it back to the
// far end of the field and line it up there: on the lane it stopped on (the
// mown grass beside the runway is a lane too) if the whole aeroplane fits
// there on concrete or grass clear of every building and pen, otherwise on
// the runway. An instant move, like the swing itself: the aeroplane is
// stopped and being worked on. Returns true if it moved.
// The aeroplane fits at (x, z) facing along X: nothing built under its nose,
// tail or wingtips, and its wheels and fuselage over concrete or grass (the
// tips may overhang the fill, as they did where it stopped).
const lineUpSurf = { y: 0, kind: 'terrain', af: null };
function spotClear(plane, x, z) {
  const g = plane.gearGeo;
  const halfSpan = g && g.tipX ? Math.abs(g.tipX) : 6;
  const track = g && g.mainX ? Math.abs(g.mainX) : 1.5;
  const halfLen = (plane.spec && plane.spec.len > 0 ? plane.spec.len : 10) * 0.5;
  for (let i = -1; i <= 1; i++) {
    const sx = x + i * halfLen;
    for (let j = -1; j <= 1; j++) {
      if (obstacleTopAt(sx, z + j * halfSpan, 0.3) > -Infinity) return false;
      const k = groundSurfaceAt(sx, z + j * track, lineUpSurf).kind;
      if (k !== 'concrete' && k !== 'grass') return false;
    }
  }
  return true;
}
function lineUpIfShort(plane, af) {
  const d = Math.sin(af.heading);
  // the runway runs along X: only a departure along it has a far end to go to
  if (!af.platform || Math.abs(d) < 0.7 || typeof plane.settleOnGround !== 'function') return false;
  const sgn = d > 0 ? 1 : -1;
  const edge = af.x + (sgn > 0 ? af.platform.maxX : af.platform.minX);
  const p = plane.position;
  const ahead = (edge - p.x) * sgn;
  if (ahead >= takeoffRoomNeeded(plane.spec)) return false;
  const lx = af.x - sgn * (af.halfLen - LINEUP_IN);
  if ((edge - lx) * sgn <= ahead + 1) return false;
  let lz = p.z;
  if (!spotClear(plane, lx, lz)) {
    const lane = Math.max(4, af.halfWid - 4);
    lz = clamp(p.z, af.z - lane, af.z + lane);
  }
  p.x = lx;
  p.z = lz;
  // on its wheels at the new spot: ride height, slope and attitude from the
  // surface there, at rest
  plane.settleOnGround();
  return true;
}

// Slow enough that going home is a real decision — you are out of the fight for
// the better part of twenty seconds — and complete enough that it is worth
// making. The aeroplane has to be STOPPED on its own side's field (runway,
// apron, pens or the grass; not the embankment). Returns the service fraction.
export function serviceOnGround(plane, dt, ctx = {}) {
  if (!plane) return 0;
  initPlaneAirfieldState(plane);
  if (!plane.onGround || plane.wrecked) return plane.serviceFrac;
  if (plane.speed > SERVICE_ABANDON) {
    plane.serviceFrac = 0;
    return 0;
  }
  // moving, but not leaving: the crew wait for it to stop
  if (plane.speed > SERVICE_STOPPED) return plane.serviceFrac;
  const af = airfieldAtPoint(plane.position.x, plane.position.z);
  if (!af || af.team !== plane.team) return plane.serviceFrac;
  plane.airfield = af;
  const spec = plane.spec;
  const wasDone = plane.serviceFrac >= 1;
  if (wasDone) return 1;
  const serviceTime = ctx.serviceTime > 0 ? ctx.serviceTime : SERVICE_TIME;
  const f = dt / serviceTime;
  plane.serviceFrac = Math.min(1, plane.serviceFrac + f);
  const player = isPlayerPlane(plane, ctx);

  if (plane.burning) {
    plane.extinguishers = Math.max(plane.extinguishers, 1);
    plane.useExtinguisher();
    if (player) say(ctx, 'Ground crew put the fire out', 'info', !!ctx.logOn);
  }
  plane.hp = Math.min(spec.hp, plane.hp + spec.hp * f);
  for (const key of Object.keys(plane.parts)) {
    const part = plane.parts[key];
    part.hp = Math.min(part.max, part.hp + part.max * f);
  }
  plane.oilLeak = Math.max(0, plane.oilLeak - f * 2.5);
  plane.fuelLeak = Math.max(0, plane.fuelLeak - f * 2.5);
  plane.smoking = plane.oilLeak > 0.15;
  plane.pilotOut = false;
  plane.stress = 0;
  plane.spinEnergy = 0;
  plane.wepLock = false;
  plane.engineTemp = Math.max(0.25, plane.engineTemp - f * 1.5);
  plane.extinguishers = Math.max(plane.extinguishers, 1);
  plane.fuel = Math.min(spec.fuelCapacity, plane.fuel + spec.fuelCapacity * f * 1.6);
  plane.ammo = Math.min(spec.gun.ammo, Math.round(plane.ammo + spec.gun.ammo * f));

  if (plane.serviceFrac >= 1) {
    if (spec.bombs) plane.bombs = spec.bombs.count;
    if (spec.rockets) plane.rockets = spec.rockets.count;
    // The counters above are only half a rearm: the store bodies were hidden
    // one by one as they were dropped and have to come back too, or the
    // aeroplane taxies out with a full load and visibly bare pylons.
    plane.restoreStores?.();
    plane.ammo = spec.gun.ammo;
    plane.hp = spec.hp;
    plane.fuel = spec.fuelCapacity;
    plane.resetGearStrain?.();
    // Every landing rolls toward the map edge — there is no approach from
    // beyond it — so an aeroplane stops facing the wrong way, with the edge 30
    // m past the end of the runway. The crew do what crews did: lift the tail
    // and walk it round to face the departure heading, with the runway it
    // rolled down now ahead of it.
    let swung = false;
    let towed = false;
    if (typeof plane.swingTo === 'function') {
      const dx = Math.sin(af.heading);
      const dz = Math.cos(af.heading);
      if (plane.dir.x * dx + plane.dir.z * dz < 0) {
        plane.swingTo(af.heading);
        swung = true;
        towed = lineUpIfShort(plane, af);
      }
    }
    if (player) {
      say(
        ctx,
        towed
          ? 'Serviced — the crew have towed you to the end of the runway. Full throttle to take off'
          : swung
            ? 'Serviced — the crew have turned you round. Full throttle to take off'
            : 'Repaired, refuelled and rearmed — full throttle to take off',
        'info',
        !!ctx.logOn,
      );
      award(ctx, 'BACK IN THE FIGHT', 'Serviced at the airfield');
      cue(ctx, 'reload');
    }
    ctx.onServiced?.(plane, af, { swung, towed });
  }
  return plane.serviceFrac;
}

// Exposed for tests and tooling.
export const AIRFIELD_LAYOUT = Object.freeze({
  APRON_DEPTH, APRON_WIDTH, REVET_DEPTH, FIELD_OVERRUN, FIELD_SIDE, BERM_RUN, BERM_MAX, GRASS_DROP,
});
