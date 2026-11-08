import * as THREE from 'three';
import { markShared } from '../../core/materials.js';
import { PLANE_SPEED_SCALE, displaySpeedKmh } from '../planes.js';
import { mergeDef } from '../interior/registry.js';
import {
  createLayerUniforms, layerMaterial, layerMesh, GeoBuilder, lin, sceneDaylight, ORDER_BODY,
} from '../interior/common.js';
import { cockpitDefinition, defineCockpit, definedCockpits } from './registry.js';

export { defineCockpit, definedCockpits };

// ===========================================================================
// AIRCRAFT COCKPITS (wave 6): the A-02 cockpit view as a per-type framework
// ===========================================================================
// What the pilot sees from his seat, per type, from src/vehicles/cockpit/
// <specId>.js (registry.js has the format) merged over defaults derived from
// the spec's own canopy shape:
//   eye       the pilot's eye in the body frame (+Z nose, +Y up, +X LEFT);
//             game/planeCamera.js cockpitEyeLocal() reads it
//   canopy    arches (hoops: { z, hw, hh, y, t, from, to }) and bars
//             ({ a: [x,y,z], b: [x,y,z], t }) — the REAL frame of the type —
//             and the sills along the cockpit sides
//   panel     the instrument panel: plane z, centre y, size w x h, tilt (rad,
//             top away from the pilot) and its instruments
//             [{ kind, u, v, r }] — u to the pilot's RIGHT, v up, metres
//             from the panel centre; kinds: ias alt ah vsi compass tach
//             boost temp fuel turn clock gmeter
//   coaming   the glare shield over the panel
//   gunsight  { type: 'k14' | 'revi' | 'gm2' | 'pbp' | 'type98', pos, glassH }
//             — type picks the H-03 reflector graticule (hud.js); pos is the
//             sight body under the combining glass
//   stick     { pos, len }, and colors
// CockpitLayer draws it as a near layer (interior/common.js) rigid on the
// airframe; the dials are one shared canvas texture redrawn at 15 Hz.
//
// Per-type files are picked up by import.meta.glob (Vite); in node the glob
// throws, and a headless test imports the type file it wants itself.
try {
  // eslint-disable-next-line no-undef
  import.meta.glob(['./*.js', '!./index.js', '!./registry.js'], { eager: true });
} catch (e) {
  /* node: no glob */
}

// eye above and ahead of the canopy station planes.js builds the pilot at
// (see planeCamera.js: outside his head sphere, >= 0.156 m from any own
// geometry in the 60-degree frustum for every type that does not override it)
export const EYE_UP = 0.16;
export const EYE_FWD = 0.05;

function canopyOf(spec) {
  const shape = (spec && spec.shape) || {};
  const look = (spec && spec.look) || {};
  if (shape.canopy && shape.canopy.glass) {
    const c = shape.canopy;
    return {
      y: c.y != null ? c.y : 0.5,
      z: c.z != null ? c.z : 0,
      glass: c.glass,
      flatScreen: !!c.flatScreen,
    };
  }
  const len = (spec && spec.len) || 9;
  return {
    y: look.armoured ? 0.62 : 0.5,
    z: look.engine === 'radial' ? len * 0.06 : len * 0.04,
    glass: null,
    flatScreen: false,
  };
}

export function defaultCockpitEye(spec) {
  const c = canopyOf(spec);
  return [0, c.y + EYE_UP, c.z + EYE_FWD];
}

const GUNSIGHT_BY_NATION = { USA: 'k14', Britain: 'gm2', Germany: 'revi', USSR: 'pbp', Japan: 'type98' };

export function deriveCockpit(spec) {
  const c = canopyOf(spec);
  const eye = defaultCockpitEye(spec);
  const cy = c.y;
  const arches = [];
  let sills = null;
  if (c.glass) {
    const vol = c.glass[0];
    for (let i = 0; i < vol.length; i++) {
      if (i === 0 && c.flatScreen) continue;
      const s = vol[i];
      arches.push({ z: s[0], hw: s[1] * 1.0, hh: s[2] * 1.0, y: s[3] != null ? s[3] : cy, t: 0.032 });
    }
    const a = vol[1] || vol[0];
    const b = vol[vol.length - 1];
    sills = { y: (a[3] != null ? a[3] : cy) - a[2] * 0.72, hw: a[1] * 0.97, z0: vol[0][0] - 0.05, z1: b[0] + 0.05, t: 0.05 };
  }
  const tubFront = c.z + 0.55;
  return {
    id: spec.id,
    eye,
    canopy: { arches, bars: [], sills },
    panel: {
      z: tubFront - 0.1,
      y: cy - 0.16,
      w: 0.56,
      h: 0.34,
      tilt: 0.12,
      instruments: [
        { kind: 'ias', u: -0.15, v: 0.075, r: 0.042 },
        { kind: 'ah', u: 0, v: 0.075, r: 0.045 },
        { kind: 'alt', u: 0.15, v: 0.075, r: 0.042 },
        { kind: 'turn', u: -0.15, v: -0.04, r: 0.036 },
        { kind: 'compass', u: 0, v: -0.04, r: 0.04 },
        { kind: 'vsi', u: 0.15, v: -0.04, r: 0.036 },
        { kind: 'tach', u: -0.06, v: -0.125, r: 0.03 },
        { kind: 'boost', u: 0.06, v: -0.125, r: 0.03 },
        { kind: 'temp', u: 0.22, v: -0.125, r: 0.024 },
        { kind: 'fuel', u: -0.22, v: -0.125, r: 0.024 },
      ],
    },
    coaming: { z: tubFront - 0.16, y: cy + 0.03, w: 0.58, h: 0.05, d: 0.2 },
    gunsight: {
      type: GUNSIGHT_BY_NATION[spec.nation] || 'revi',
      pos: [0, eye[1] - 0.075, eye[2] + 0.42],
      size: [0.09, 0.08, 0.16],
      glassH: 0.08,
    },
    stick: { pos: [0, cy - 0.3, c.z + 0.26], len: 0.36 },
    throttle: { pos: [0.3, cy - 0.12, c.z + 0.12] },
    colors: {
      panel: 0x1d1f1c,
      frame: 0x3b3e37,
      sill: 0x4a4d45,
      coaming: 0x151614,
      sight: 0x3a3c37,
      stick: 0x1a1a18,
    },
  };
}

const finite3 = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => Number.isFinite(v));
const resolved = new WeakMap();

export function resolveCockpit(spec) {
  if (!spec) return null;
  let r = resolved.get(spec);
  if (r) return r;
  const base = deriveCockpit(spec);
  const defn = cockpitDefinition(spec.id);
  let over = null;
  if (defn) {
    try {
      over = typeof defn === 'function' ? defn(spec, base) : defn;
    } catch (e) {
      console.warn(`[cockpit] ${spec.id}: definition threw, using defaults`, e);
      over = null;
    }
  }
  r = over ? mergeDef(base, over) : base;
  if (!finite3(r.eye)) r.eye = base.eye;
  if (!r.panel || !Array.isArray(r.panel.instruments)) r.panel = base.panel;
  if (!r.canopy) r.canopy = base.canopy;
  if (!r.gunsight) r.gunsight = base.gunsight;
  r.colors = { ...base.colors, ...(r.colors || {}) };
  r.source = over ? 'file' : 'default';
  resolved.set(spec, r);
  return r;
}

// ---------------------------------------------------------------------------
// the dials: one canvas, the panel's own aspect, shared across battles
// ---------------------------------------------------------------------------
const DIAL_W = 512;
let dialTex = null;
let dialCanvas = null;

function dialTexture(aspect) {
  const h = Math.max(128, Math.min(512, Math.round(DIAL_W / Math.max(0.5, aspect))));
  if (dialTex && dialCanvas.height === h) return dialTex;
  if (typeof document === 'undefined' || !document.createElement) return null;
  dialCanvas = document.createElement('canvas');
  dialCanvas.width = DIAL_W;
  dialCanvas.height = h;
  if (dialTex) dialTex.dispose();
  dialTex = new THREE.CanvasTexture(dialCanvas);
  dialTex.colorSpace = THREE.SRGBColorSpace;
  dialTex.anisotropy = 4;
  markShared(dialTex);
  return dialTex;
}

const UNITS = {
  USA: { speed: 'mph', alt: 'ft' },
  Britain: { speed: 'mph', alt: 'ft' },
  Japan: { speed: 'kt', alt: 'm' },
};
const KMH_PER = { kmh: 1, mph: 1.609344, kt: 1.852 };

const tmpQ = new THREE.Quaternion();
const tmpL = new THREE.Vector3();
const tmpU = new THREE.Vector3();

// What the needles read, from the aeroplane itself. Pure; exported for tests.
export function readInstruments(plane, prev = null, dt = 0) {
  const spec = plane.spec || {};
  const u = UNITS[spec.nation] || { speed: 'kmh', alt: 'm' };
  const kmh = displaySpeedKmh(plane.ias != null ? plane.ias : plane.speed);
  const q = plane.quat || tmpQ.identity();
  tmpL.set(1, 0, 0).applyQuaternion(q);
  tmpU.set(0, 1, 0).applyQuaternion(q);
  const dir = plane.dir || { x: 0, y: 0, z: 1 };
  const heading = Math.atan2(dir.x, dir.z);
  let turn = 0;
  if (prev && dt > 0) {
    let d = heading - prev.heading;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    turn = d / dt;
  }
  const alt = plane.position ? plane.position.y : 0;
  const thr = Math.min(1, Math.max(0, plane.throttle || 0));
  return {
    units: u,
    speed: kmh / KMH_PER[u.speed],
    alt: u.alt === 'ft' ? alt * 3.28084 : alt,
    // design m/s, like the HUD's V/S tape (airBattle.js x.vspeed): the dial's
    // +/- 30 m/s is a handbook scale and the world flies at PLANE_SPEED_SCALE
    vs: plane.vel ? plane.vel.y / PLANE_SPEED_SCALE : 0,
    bank: Math.atan2(tmpL.y, tmpU.y),
    pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))),
    heading,
    turn,
    slip: plane.slip || 0,
    rpm: plane.alive === false || plane.pilotOut ? 0 : 0.35 + 0.65 * thr * (plane.wep ? 1.04 : 1),
    boost: thr * (plane.wep ? 1.15 : 1),
    temp: plane.engineTemp != null ? plane.engineTemp : 0.4,
    fuel: spec.fuelCapacity ? (plane.fuel || 0) / spec.fuelCapacity : 1,
    g: plane.gLoad != null ? plane.gLoad : 1,
  };
}

function drawDialFaces(ctx, def, W, H) {
  const P = def.panel;
  const sx = W / P.w;
  const sy = H / P.h;
  ctx.clearRect(0, 0, W, H);
  // the board itself (the mesh colour multiplies this)
  ctx.fillStyle = '#2e302b';
  ctx.fillRect(0, 0, W, H);
  for (const ins of P.instruments) {
    const X = (ins.u / P.w + 0.5) * W;
    const Y = (0.5 - ins.v / P.h) * H;
    const R = ins.r * sx;
    ctx.save();
    ctx.translate(X, Y);
    ctx.scale(1, sy / sx);
    // bezel and face
    ctx.fillStyle = '#2a2a28';
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0d0e0c';
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
    // ticks round a 300-degree scale (the horizon and compass draw their own)
    if (ins.kind !== 'ah' && ins.kind !== 'compass' && ins.kind !== 'clock') {
      ctx.strokeStyle = '#e9e4d2';
      ctx.lineWidth = Math.max(1, R * 0.04);
      const n = ins.kind === 'vsi' || ins.kind === 'turn' ? 12 : 20;
      for (let i = 0; i <= n; i++) {
        const a = (-150 + (300 * i) / n) * (Math.PI / 180) - Math.PI / 2;
        const r0 = i % 5 === 0 ? R * 0.72 : R * 0.82;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        ctx.lineTo(Math.cos(a) * R * 0.94, Math.sin(a) * R * 0.94);
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#e9e4d2';
    ctx.font = `${Math.max(7, Math.round(R * 0.22))}px sans-serif`;
    ctx.textAlign = 'center';
    const label = { ias: def._units.speed.toUpperCase(), alt: def._units.alt.toUpperCase(), tach: 'RPM', boost: 'BOOST', temp: 'TEMP', fuel: 'FUEL', vsi: 'CLIMB', turn: 'TURN', gmeter: 'G' }[ins.kind];
    if (label) ctx.fillText(label, 0, R * 0.45);
    ctx.restore();
  }
}

function needle(ctx, frac, R, w, col = '#f2eee0') {
  const a = (-150 + 300 * Math.max(0, Math.min(1, frac))) * (Math.PI / 180) - Math.PI / 2;
  ctx.strokeStyle = col;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(-Math.cos(a) * R * 0.15, -Math.sin(a) * R * 0.15);
  ctx.lineTo(Math.cos(a) * R * 0.86, Math.sin(a) * R * 0.86);
  ctx.stroke();
}

function drawNeedles(ctx, def, W, H, v) {
  const P = def.panel;
  const sx = W / P.w;
  const sy = H / P.h;
  for (const ins of P.instruments) {
    const X = (ins.u / P.w + 0.5) * W;
    const Y = (0.5 - ins.v / P.h) * H;
    const R = ins.r * sx;
    ctx.save();
    ctx.translate(X, Y);
    ctx.scale(1, sy / sx);
    const lw = Math.max(1.2, R * 0.07);
    switch (ins.kind) {
      case 'ias': needle(ctx, v.speed / (v.units.speed === 'kmh' ? 800 : 500), R, lw); break;
      case 'alt': {
        const per = v.units.alt === 'ft' ? 1000 : 1000;
        needle(ctx, ((v.alt % per) + per) % per / per * (300 / 360) + 0, R, lw);
        needle(ctx, Math.max(0, v.alt) / (per * 10), R * 0.6, lw * 1.4);
        break;
      }
      case 'vsi': needle(ctx, 0.5 + Math.max(-1, Math.min(1, v.vs / 30)) * 0.5, R, lw); break;
      case 'tach': needle(ctx, v.rpm, R, lw); break;
      case 'boost': needle(ctx, 0.2 + v.boost * 0.7, R, lw); break;
      case 'temp': needle(ctx, v.temp, R, lw, v.temp > 0.85 ? '#ff6a4a' : '#f2eee0'); break;
      case 'fuel': needle(ctx, v.fuel, R, lw, v.fuel < 0.2 ? '#ff6a4a' : '#f2eee0'); break;
      case 'gmeter': needle(ctx, (v.g + 4) / 16, R, lw); break;
      case 'turn': {
        needle(ctx, 0.5 + Math.max(-1, Math.min(1, v.turn / 0.5)) * 0.35, R, lw);
        // the slip ball
        ctx.fillStyle = '#f2eee0';
        ctx.beginPath();
        ctx.arc(Math.max(-1, Math.min(1, v.slip * 6)) * R * 0.5, R * 0.62, R * 0.12, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'ah': {
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.96, 0, Math.PI * 2);
        ctx.clip();
        ctx.rotate(-v.bank);
        const off = Math.max(-R, Math.min(R, v.pitch * R * 2.2));
        ctx.fillStyle = '#3d5f86';
        ctx.fillRect(-R * 1.5, -R * 1.5 + off, R * 3, R * 1.5);
        ctx.fillStyle = '#4a3a28';
        ctx.fillRect(-R * 1.5, off, R * 3, R * 1.5);
        ctx.strokeStyle = '#f2eee0';
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(-R, off);
        ctx.lineTo(R, off);
        ctx.stroke();
        ctx.restore();
        // the little aeroplane, fixed
        ctx.strokeStyle = '#ffb86e';
        ctx.lineWidth = lw * 1.3;
        ctx.beginPath();
        ctx.moveTo(-R * 0.55, 0);
        ctx.lineTo(-R * 0.15, 0);
        ctx.lineTo(0, R * 0.12);
        ctx.lineTo(R * 0.15, 0);
        ctx.lineTo(R * 0.55, 0);
        ctx.stroke();
        break;
      }
      case 'compass': {
        ctx.rotate(-v.heading);
        ctx.fillStyle = '#e9e4d2';
        ctx.font = `${Math.max(7, Math.round(R * 0.3))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const card = ['N', 'E', 'S', 'W'];
        for (let i = 0; i < 4; i++) {
          ctx.save();
          ctx.rotate((i * Math.PI) / 2);
          ctx.fillText(card[i], 0, -R * 0.68);
          ctx.restore();
        }
        ctx.restore();
        ctx.save();
        ctx.translate(X, Y);
        ctx.scale(1, sy / sx);
        ctx.strokeStyle = '#ffb86e';
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(0, -R * 0.95);
        ctx.lineTo(0, -R * 0.5);
        ctx.stroke();
        break;
      }
      case 'clock': {
        const d = new Date();
        const hFrac = ((d.getHours() % 12) + d.getMinutes() / 60) / 12;
        const mFrac = d.getMinutes() / 60;
        for (const [f, l] of [[hFrac, 0.55], [mFrac, 0.85]]) {
          const a = f * Math.PI * 2 - Math.PI / 2;
          ctx.strokeStyle = '#f2eee0';
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(a) * R * l, Math.sin(a) * R * l);
          ctx.stroke();
        }
        break;
      }
      default: break;
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// the layer
// ---------------------------------------------------------------------------
const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Vector3(1, 1, 1);

export class CockpitLayer {
  constructor(scene, plane) {
    this.scene = scene;
    this.plane = plane;
    this.def = resolveCockpit(plane.spec);
    this.def._units = UNITS[plane.spec.nation] || { speed: 'kmh', alt: 'm' };
    this.u = createLayerUniforms();
    this.root = new THREE.Group();
    this.root.name = 'cockpitLayer';
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    this._dialT = 0;
    this._prev = null;
    this._faces = null;
    this.stats = { tris: 0, draws: 0 };
    this.day = sceneDaylight(scene);
    this.build();
    scene.add(this.root);
  }

  build() {
    const d = this.def;
    const C = {};
    for (const k of Object.keys(d.colors)) C[k] = lin(d.colors[k]);
    const b = new GeoBuilder();
    // ---- canopy frame: arches and straight bars
    for (const a of d.canopy.arches || []) {
      const t = a.t || 0.03;
      const from = a.from != null ? a.from : -0.35;
      const to = a.to != null ? a.to : Math.PI + 0.35;
      const seg = 14;
      let p0 = null;
      for (let i = 0; i <= seg; i++) {
        const th = from + ((to - from) * i) / seg;
        const p = [Math.cos(th) * a.hw, a.y + Math.sin(th) * a.hh, a.z];
        if (p0) b.bar(p0, p, t, C.frame);
        p0 = p;
      }
    }
    for (const bar of d.canopy.bars || []) b.bar(bar.a, bar.b, bar.t || 0.03, C.frame);
    const s = d.canopy.sills;
    if (s) {
      for (const sg of [-1, 1]) {
        b.box(sg * s.hw, s.y, (s.z0 + s.z1) / 2, s.t, s.t * 1.4, Math.abs(s.z0 - s.z1), C.sill);
      }
    }
    // ---- the panel board, the coaming over it
    const P = d.panel;
    b.pushTR([0, P.y, P.z], [P.tilt || 0, 0, 0]);
    b.box(0, 0, 0.02, P.w + 0.04, P.h + 0.04, 0.03, C.panel);
    b.pop();
    const co = d.coaming;
    if (co) b.box(0, co.y, co.z, co.w, co.h, co.d, C.coaming);
    // ---- the gunsight body and the frame of its combining glass
    const g = d.gunsight;
    if (g && finite3(g.pos)) {
      const [gx, gy, gz] = g.pos;
      const sz = g.size || [0.09, 0.08, 0.16];
      b.box(gx, gy, gz, sz[0], sz[1], sz[2], C.sight);
      const gh = g.glassH || 0.08;
      const gw = sz[0] * 1.05;
      const top = gy + sz[1] / 2 + gh;
      const zg = gz - sz[2] * 0.3;
      b.bar([gx - gw / 2, gy + sz[1] / 2, zg], [gx - gw / 2, top, zg + 0.012], 0.006, C.sight);
      b.bar([gx + gw / 2, gy + sz[1] / 2, zg], [gx + gw / 2, top, zg + 0.012], 0.006, C.sight);
      b.bar([gx - gw / 2, top, zg + 0.012], [gx + gw / 2, top, zg + 0.012], 0.006, C.sight);
      if (g.type === 'k14') {
        // the K-14's range and span knobs either side
        b.cyl(gx + sz[0] / 2 + 0.015, gy, gz, 0.02, 0.025, C.frame, { axis: 'x', seg: 10 });
        b.cyl(gx - sz[0] / 2 - 0.015, gy, gz, 0.02, 0.025, C.frame, { axis: 'x', seg: 10 });
      }
    }
    // ---- the stick and the throttle quadrant
    if (d.stick && finite3(d.stick.pos)) {
      const [x, y, z] = d.stick.pos;
      b.bar([x, y, z], [x, y + d.stick.len, z - 0.04], 0.026, C.stick);
      b.box(x, y + d.stick.len + 0.04, z - 0.05, 0.04, 0.09, 0.04, C.stick);
    }
    if (d.throttle && finite3(d.throttle.pos)) {
      const [x, y, z] = d.throttle.pos;
      b.box(x, y, z, 0.06, 0.06, 0.3, C.sill);
      b.bar([x, y + 0.03, z], [x - 0.02, y + 0.16, z + 0.05], 0.018, C.stick);
    }
    this.body = layerMesh(b.build(), layerMaterial(this.u, 'lit'), ORDER_BODY);
    this.root.add(this.body);
    this.stats.tris = b.count / 3;

    // ---- the dials: a textured quad on the board's face
    const aspect = P.w / P.h;
    const tex = dialTexture(aspect);
    this.tex = tex;
    if (tex) {
      const geo = new THREE.BufferGeometry();
      const hw = P.w / 2;
      const hh = P.h / 2;
      // facing -Z (the pilot), +X is the pilot's LEFT: u = 0 at his left
      geo.setAttribute('position', new THREE.Float32BufferAttribute([hw, -hh, 0, -hw, -hh, 0, -hw, hh, 0, hw, -hh, 0, -hw, hh, 0, hw, hh, 0], 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1], 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
      const w = lin(0xb8b8b8);
      geo.setAttribute('color', new THREE.Float32BufferAttribute([...w, ...w, ...w, ...w, ...w, ...w], 3));
      geo.translate(0, 0, 0);
      const m = layerMesh(geo, layerMaterial(this.u, 'lit', { map: tex, emis: 0.18 }), ORDER_BODY);
      m.matrixAutoUpdate = false;
      m.matrix.compose(new THREE.Vector3(0, P.y, P.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(P.tilt || 0, 0, 0)), tmpS);
      this.dials = m;
      this.root.add(m);
    }
  }

  setVisible(v) {
    if (this.root.visible !== v) this.root.visible = v;
  }

  // per frame while the cockpit view is up, after plane.update()
  update(dt, plane) {
    this.plane = plane;
    tmpM.compose(plane.position, plane.quat, tmpS);
    this.root.matrix.copy(tmpM);
    this.root.matrixWorldNeedsUpdate = true;
    this.root.updateMatrixWorld(true);
    // daylight: sky ambient and the sun, no shadows (an open canopy)
    const day = this.day;
    const sky = Math.min(1.5, day.sky);
    this.u.uAmb.value.set(day.skyCol[0] * sky * 1.1 + 0.1, day.skyCol[1] * sky * 1.1 + 0.1, day.skyCol[2] * sky * 1.1 + 0.1);
    const sun = Math.min(3, day.sun) * 0.6;
    this.u.uSunCol.value.set(day.sunCol[0] * sun, day.sunCol[1] * sun, day.sunCol[2] * sun);
    this.u.uSunDir.value.copy(day.sunDir);
    // dials at 15 Hz
    this._dialT -= dt;
    if (this.tex && this._dialT <= 0) {
      this._dialT = 1 / 15;
      this.drawDials(plane, dt);
    }
  }

  drawDials(plane, dt) {
    const c = this.tex.image;
    const ctx = c && c.getContext ? c.getContext('2d') : null;
    if (!ctx) return;
    const v = readInstruments(plane, this._prev, this._prevDt || dt);
    this._prev = { heading: v.heading };
    this._prevDt = 1 / 15;
    if (!this._faces) {
      this._faces = document.createElement('canvas');
      this._faces.width = c.width;
      this._faces.height = c.height;
      const fc = this._faces.getContext('2d');
      if (fc) drawDialFaces(fc, this.def, c.width, c.height);
    }
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(this._faces, 0, 0);
    drawNeedles(ctx, this.def, c.width, c.height, v);
    this.tex.needsUpdate = true;
    this.lastReading = v;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}
