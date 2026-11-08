import * as THREE from 'three';
import {
  createLayerUniforms, layerMaterial, layerMesh, GeoBuilder, lin, sceneDaylight, disposeLayerObject,
  ORDER_HOLE, ORDER_GLASS, ORDER_BODY, ORDER_FX, LAMPS,
} from './common.js';
import { DEVICE_DEFAULTS } from './stations.js';

// Level B: the simplified interior of the PLAYER's own tank, drawn around the
// camera only while the player sits in a crew station (see common.js for how
// the layer is drawn over the world without z-fighting the hull it sits in).
//
// Built once per tank from its resolved interior definition (index.js):
// hull room + turret room as inside surfaces, seats, racks with rounds in
// them, gearbox / shaft / radio / traverse boxes, closed hatches, the cupola
// with its vision blocks, the breech that recoils when the gun fires and
// opens / loads / closes on the reload timer, spent cases that bounce off
// the basket floor, and the hit feedback (spall sparks, smoke, flicker, the
// dome light going out, fire glow) driven by the damage model's events.
//
// Draw calls while shown: hull, turret, glow (lit glass), gun cradle, breech
// ring, breech block, round, backstop, the active device (hole, glass,
// bezel), up to six cases, sparks — 10 to 16, all small.

const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const IDENT = new THREE.Matrix4();
const MAX_CASES = 6;
const MAX_SPARKS = 48;
// lid underside / hatch handle above the eye under it (m)
const LID_CLEAR = 0.05;
// the share of the screen's half-width / half-height a periscope or slit
// window (with its bezel) may span: the rest is the frame of interior
// around it, on any aspect (wave 7: 74-degree windows overflowed 4:3)
const FIT_H = 0.84;
const FIT_V = 0.8;
// the exposure the compartment is graded for (the renderer's is divided out)
const INTERIOR_EXPOSURE = 0.62;

// reload progress u (0 just fired .. 1 ready) -> what the breech is doing
//   [0, OPEN)        counter-recoil; the semi-automatic breech flies open
//   [OPEN, FETCH)    the loader brings a round from the rack
//   [FETCH, RAM)     ...and rams it home
//   [RAM, CLOSE)     the block closes
const T_OPEN = 0.05;
const T_FETCH = 0.62;
const T_RAM = 0.8;
const T_CLOSE = 0.87;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// The breech's state for a reload fraction. Pure, exported for tests:
// { open 0..1 (block travel), round: null | { t 0..1 along fetch, ram 0..1 } }
export function breechPhase(u) {
  if (!(u >= 0)) u = 1;
  if (u >= 1) return { open: 0, round: null, phase: 'ready' };
  if (u < T_OPEN) return { open: smooth(0.02, T_OPEN, u), round: null, phase: 'open' };
  if (u < T_FETCH) return { open: 1, round: { t: smooth(T_OPEN + 0.05, T_FETCH, u), ram: 0 }, phase: 'fetch' };
  if (u < T_RAM) return { open: 1, round: { t: 1, ram: smooth(T_FETCH, T_RAM, u) }, phase: 'ram' };
  if (u < T_CLOSE) return { open: 1 - smooth(T_RAM, T_CLOSE, u), round: null, phase: 'close' };
  return { open: 0, round: null, phase: 'ready' };
}

const SPARK_VERT = /* glsl */ `
uniform float uK;
uniform float uIA;
uniform float uIB;
uniform float uPx;
attribute float life;
varying float vLife;
void main() {
  vLife = life;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float zi = uIA * mv.z + uIB;
  gl_Position.z = -gl_Position.w + (zi + gl_Position.w) * uK;
  gl_PointSize = life > 0.0 ? clamp(uPx * 0.02 / max(-mv.z, 0.05), 1.5, 14.0) : 0.0;
}
`;
const SPARK_FRAG = /* glsl */ `
varying float vLife;
void main() {
  if (vLife <= 0.0) discard;
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(d));
  vec3 c = mix(vec3(4.0, 1.4, 0.35), vec3(9.0, 6.5, 3.0), clamp(vLife * 1.5, 0.0, 1.0));
  gl_FragColor = vec4(c * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class InteriorLayer {
  /**
   * @param {THREE.Scene} scene  the battle scene (the layer is a child of it)
   * @param {object} tank        the player's Tank entity
   * @param {object} def         the resolved interior (index.js resolveTankInterior)
   */
  constructor(scene, tank, def) {
    this.scene = scene;
    this.tank = tank;
    this.def = def;
    this.u = createLayerUniforms();
    this.mats = {
      lit: layerMaterial(this.u, 'lit'),
      glow: layerMaterial(this.u, 'emissive', { emis: 0.6 }),
      hole: layerMaterial(this.u, 'hole'),
      glass: layerMaterial(this.u, 'glass', { opacity: 0.14 }),
      back: layerMaterial(this.u, 'lit', { side: THREE.BackSide }),
    };
    this.root = new THREE.Group();
    this.root.name = 'interiorLayer';
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    this.offset = new THREE.Vector3();
    this.frames = {};
    this.devices = new Map(); // station key -> { group, frame }
    this.housings = {}; // station key -> its static housing meshes (seen from elsewhere)
    this.activeDevice = null;
    this.cases = [];
    this.caseNext = 0;
    this.sparkLife = new Float32Array(MAX_SPARKS);
    this.sparkVel = new Float32Array(MAX_SPARKS * 3);
    this.sparksLive = 0;
    this.fx = {
      smoke: 0, flicker: 0, domeOut: false, flash: 0, flashPos: new THREE.Vector3(),
      gunFlash: 0, time: 0, ejectAt: -1, lastReload: tank.reload, hit: 0,
    };
    this.day = sceneDaylight(scene);
    this.stats = { builtMs: 0, tris: 0, draws: 0 };
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    this.build();
    this.stats.builtMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    scene.add(this.root);
  }

  // ------------------------------------------------------------------ build
  _group(name) {
    const g = new THREE.Group();
    g.name = name;
    g.matrixAutoUpdate = false;
    this.root.add(g);
    return g;
  }

  _add(group, builder, mat, order = ORDER_BODY) {
    if (!builder.count) return null;
    const m = layerMesh(builder.build(), mat, order);
    group.add(m);
    this.stats.tris += builder.count / 3;
    return m;
  }

  build() {
    const def = this.def;
    const C = def.colors;
    const col = {};
    for (const k of Object.keys(C)) col[k] = lin(C[k]);
    this.col = col;
    const L = def.layout;
    const spec = this.tank.spec;
    this.frames.hull = this._group('ivHull');
    if (L.turret || this.tank.turretGroup) this.frames.turret = this._group('ivTurret');
    this.frames.gun = this._group('ivGun');

    const B = { hull: new GeoBuilder(), turret: new GeoBuilder() };
    const G = { hull: new GeoBuilder(), turret: new GeoBuilder() }; // lit glass
    const bOf = (f) => B[f === 'turret' && this.frames.turret ? 'turret' : 'hull'];
    const gOf = (f) => G[f === 'turret' && this.frames.turret ? 'turret' : 'hull'];

    // ---- hull room
    const H = L.hull;
    const hb = B.hull;
    // roofHalfWidth (optional): the upper side plates lean in from the
    // sponson shelf to the roof (Panther, SU-100 ...); without it the room
    // is one width top to bottom, as before
    const hwTop = Number.isFinite(H.roofHalfWidth) ? H.roofHalfWidth : null;
    hb.insideProfile([
      [H.floorY, H.rearZ],
      [H.roofY, H.rearZ],
      [H.roofY, H.glacisTopZ],
      [H.lowFrontY, H.frontZ],
      [H.floorY + 0.1, H.frontZ - 0.12],
    ], H.halfWidth, col.wall, col.wall, hwTop != null ? { yKnee: H.sponsonY, hwTop, yTop: H.roofY } : null);
    // the floor plate, darker, a hair above the room's own floor
    hb.box(0, H.floorY + 0.006, (H.rearZ + H.frontZ) / 2, H.lowerHalfWidth * 2, 0.012, H.frontZ - H.rearZ - 0.2, col.floor);
    // the track runs: lower walls and the sponson shelves above them
    for (const s of [-1, 1]) {
      const xIn = s * H.lowerHalfWidth;
      const xOut = s * H.halfWidth;
      const zc = (H.rearZ + H.glacisTopZ) / 2;
      const zl = H.glacisTopZ - H.rearZ - 0.05;
      hb.box((xIn + xOut) / 2, H.sponsonY, zc, Math.abs(xOut - xIn), 0.03, zl, col.wall);
      hb.box(xIn + s * 0.015, (H.floorY + H.sponsonY) / 2, zc, 0.03, H.sponsonY - H.floorY, zl, col.wall);
    }
    // firewall ribs
    for (let i = -2; i <= 2; i++) {
      hb.box(i * H.halfWidth * 0.38, (H.floorY + H.roofY) / 2, H.rearZ + 0.03, 0.05, H.roofY - H.floorY - 0.05, 0.05, col.metal);
    }

    // ---- turret room
    if (L.turret && this.frames.turret) {
      const T = L.turret;
      const tb = B.turret;
      tb.insideTurret(0, T.cz, T.rx, T.rz, T.y0, T.y1, col.wall, col.wall);
      // the race ring and the basket floor
      tb.cyl(0, T.y0 + 0.02, 0, T.ringR + 0.04, 0.06, col.metal, { seg: 20, caps: false, inside: true });
      tb.cyl(0, T.basketY + 0.02, 0, T.ringR, 0.025, col.floor, { seg: 20 });
      // basket posts
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        tb.box(Math.sin(a) * T.ringR, (T.basketY + T.y0) / 2, Math.cos(a) * T.ringR, 0.035, T.y0 - T.basketY, 0.035, col.metal);
      }
    }

    // ---- hatches (closed lids from inside) and the cupola
    for (const h of L.hatches || []) {
      const b = bOf(h.frame);
      // the lid's underside (and the handle bar under it) stays a hand's
      // breadth above the eye of the station seated under it: a lid inside
      // the layer's 3 cm near plane is clipped open (wave 7: the Panther's
      // was 1.7 cm, the Sherman's 1 cm above the commander's eye)
      let lidY = h.pos[1];
      const st = h.cupola ? def.stations.commander : null;
      if (st && st.frame === h.frame && Math.hypot(st.eye[0] - h.pos[0], st.eye[2] - h.pos[2]) < h.r + 0.1) {
        lidY = Math.max(lidY, st.eye[1] + LID_CLEAR + 0.024 + 0.035);
      }
      b.cyl(h.pos[0], lidY - 0.012, h.pos[2], h.r, 0.024, col.metal, { seg: 14 });
      b.bar([h.pos[0] - h.r * 0.5, lidY - 0.024 - 0.0125 - 0.01, h.pos[2]], [h.pos[0] + h.r * 0.5, lidY - 0.024 - 0.0125 - 0.01, h.pos[2]], 0.025, col.dark);
      if (h.cupola) {
        const cu = h.cupola;
        // the cupola wall sits just behind the block windows (index.js puts
        // the block holes at the device radius)
        const dv = st && st.device && st.device.type === 'blocks' ? st.device : null;
        const rWall = dv ? dv.radius + 0.012 : cu.r * 0.95;
        const y1 = Math.max(cu.y1, lidY);
        b.cyl(h.pos[0], (cu.y0 + y1) / 2, h.pos[2], rWall, y1 - cu.y0, col.wall, { seg: 16, caps: false, inside: true });
        if (dv) this._blockGlass(gOf(h.frame), st, dv, 0.006);
      }
    }

    // ---- seats, crew stations' fittings
    for (const key of Object.keys(def.stations)) {
      const st = def.stations[key];
      if (!st || !st.seat) continue;
      const b = bOf(st.frame);
      const [x, y, z] = st.seat;
      const sy = Math.max((st.frame === 'hull' ? H.floorY : L.turret ? L.turret.basketY : H.floorY - (spec.hull.trackH + spec.hull.h)) + 0.38, y - 0.25);
      b.box(x, sy, z, 0.4, 0.07, 0.38, col.seat);
      b.box(x, sy + 0.26, z - 0.2, 0.38, 0.46, 0.06, col.seat);
      b.box(x, (sy + (st.frame === 'hull' ? H.floorY : sy - 0.4)) / 2, z, 0.05, Math.max(0.05, sy - (st.frame === 'hull' ? H.floorY : sy - 0.4)), 0.05, col.metal);
      // housings of the station's own device (the window itself is built by
      // _device while the station is in use; glass glows otherwise)
      const dv = st.device || {};
      if (dv.type === 'periscope' || dv.type === 'sight') this._housing(key, st, dv);
      if (key === 'driver') {
        // steering levers, a gear lever and the instrument box
        for (const s of [-1, 1]) {
          b.bar([x + s * 0.17, H.floorY + 0.05, z + 0.42], [x + s * 0.17, sy + 0.42, z + 0.3], 0.03, col.metal);
          b.box(x + s * 0.17, sy + 0.44, z + 0.3, 0.05, 0.05, 0.09, col.dark);
        }
        b.box(x + Math.sign(x || 1) * 0.42, sy + 0.32, z + 0.38, 0.22, 0.18, 0.12, col.dark);
        b.bar([x - Math.sign(x || 1) * 0.32, H.floorY + 0.05, z + 0.1], [x - Math.sign(x || 1) * 0.3, sy + 0.3, z + 0.12], 0.025, col.metal);
        // pedals
        for (const s of [-1, 0, 1]) b.box(x + s * 0.13, H.floorY + 0.08, z + 0.62, 0.07, 0.04, 0.12, col.dark);
      }
    }
    // the gunner's own vision device (the look-around view beside his
    // sight): its housing, like any other station's
    const gv = def.stations.gunner && def.stations.gunner.vision;
    if (gv && gv.device && gv.device.type === 'periscope') this._housing('gunner_look', gv, gv.device);

    // ---- racks with rounds
    for (const r of L.racks || []) this._rack(bOf(r.frame), r);
    // ---- gearbox, propeller shaft, radio, turret drive, extras
    if (L.transmission) {
      const t = L.transmission;
      const b = bOf(t.frame);
      b.box(t.pos[0], t.pos[1], t.pos[2], t.size[0], t.size[1], t.size[2], col.metal);
      b.cyl(t.pos[0], t.pos[1] + t.size[1] / 2, t.pos[2], t.size[0] * 0.42, t.size[2] * 0.96, col.metal, { axis: 'z', seg: 12 });
    }
    if (L.shaft) {
      const s = L.shaft;
      const b = bOf(s.frame);
      const zc = (s.from[2] + s.to[2]) / 2;
      b.box(s.from[0], s.from[1], zc, s.size, s.size * 0.8, Math.abs(s.to[2] - s.from[2]), col.wall);
    }
    if (L.radio) {
      const r = L.radio;
      const b = bOf(r.frame);
      b.box(r.pos[0], r.pos[1], r.pos[2], r.size[0], r.size[1], r.size[2], col.radio);
      // dials on its face
      const g = gOf(r.frame);
      for (let i = 0; i < 3; i++) {
        g.pushTR([r.pos[0] - r.size[0] * 0.3 + i * r.size[0] * 0.3, r.pos[1] + r.size[1] * 0.12, r.pos[2] + r.size[2] / 2 + 0.004], [0, Math.PI, 0]);
        g.rect(0.04, 0.03, lin(0xffc070, 0.5));
        g.pop();
      }
    }
    if (L.traverse) {
      const t = L.traverse;
      const b = bOf(t.frame);
      b.box(t.pos[0], t.pos[1], t.pos[2], t.size[0], t.size[1], t.size[2], col.metal);
      b.cyl(t.pos[0], t.pos[1] + t.size[1] * 0.5 + 0.06, t.pos[2] + t.size[2] * 0.3, 0.07, 0.03, col.dark, { axis: 'z', seg: 10 });
    }
    for (const e of L.extras || []) {
      const b = bOf(e.frame);
      const c = e.color != null ? lin(e.color) : col.metal;
      if (e.cyl) b.cyl(e.pos[0], e.pos[1], e.pos[2], e.r, e.len, c, { axis: e.axis || 'y', seg: e.seg || 10 });
      else b.box(e.pos[0], e.pos[1], e.pos[2], e.size[0], e.size[1], e.size[2], c);
    }
    // the dome light
    if (L.domeLight) {
      const d = L.domeLight;
      bOf(d.frame).box(d.pos[0], d.pos[1] + 0.015, d.pos[2], 0.12, 0.03, 0.08, col.metal);
      gOf(d.frame).box(d.pos[0], d.pos[1] - 0.005, d.pos[2], 0.08, 0.012, 0.05, col.lamp);
    }

    this.meshHull = this._add(this.frames.hull, B.hull, this.mats.lit);
    if (this.frames.turret) this.meshTurret = this._add(this.frames.turret, B.turret, this.mats.lit);
    this._add(this.frames.hull, G.hull, this.mats.glow);
    if (this.frames.turret) this._add(this.frames.turret, G.turret, this.mats.glow);

    // ---- the backstop: a dark room beyond everything, shown only in gaps
    const back = new GeoBuilder();
    back.box(0, H.roofY * 0.6, (H.rearZ + H.frontZ) / 2, H.halfWidth * 2 + 1.2, H.roofY * 1.2 + 2.4, H.frontZ - H.rearZ + 1.4, lin(0x0b0b0a), { inside: true, shade: false });
    this._add(this.frames.hull, back, this.mats.lit);

    this._buildBreech();
    this._buildCases();
    this._buildSparks();
  }

  // the rack: a bin box and the bases of the rounds in it, on the face the
  // crew reach in from
  _rack(b, r) {
    const col = this.col;
    const [cx, cy, cz] = r.center;
    const [sx, sy, sz] = r.size;
    b.box(cx, cy, cz, sx, sy, sz, col.metal);
    const rr = Math.max(0.018, (r.round || 0.075) * 0.62);
    const face = r.face || 'py';
    // the face plane: two in-plane axes, the outward normal, its offset
    let u; let v; let n; let du; let dv;
    if (face === 'py' || face === 'ny') { u = [1, 0, 0]; v = [0, 0, 1]; n = [0, face === 'py' ? 1 : -1, 0]; du = sx; dv = sz; }
    else if (face === 'px' || face === 'nx') { u = [0, 0, 1]; v = [0, 1, 0]; n = [face === 'px' ? 1 : -1, 0, 0]; du = sz; dv = sy; }
    else { u = [1, 0, 0]; v = [0, 1, 0]; n = [0, 0, face === 'pz' ? 1 : -1]; du = sx; dv = sy; }
    const cols = r.cols || Math.max(1, Math.floor((du - 0.04) / (rr * 2.3)));
    const rows = r.rows || Math.max(1, Math.floor((dv - 0.04) / (rr * 2.3)));
    const half = [sx / 2, sy / 2, sz / 2];
    const off = Math.abs(n[0]) * half[0] + Math.abs(n[1]) * half[1] + Math.abs(n[2]) * half[2];
    const brass = col.brass;
    const primer = lin(0x6f5a35);
    const seg = 8;
    const nV = new THREE.Vector3(...n);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), nV);
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const a = ((i + 0.5) / cols - 0.5) * (du - 0.04);
        const c = ((j + 0.5) / rows - 0.5) * (dv - 0.04);
        const p = new THREE.Vector3(
          cx + u[0] * a + v[0] * c + n[0] * (off + 0.004),
          cy + u[1] * a + v[1] * c + n[1] * (off + 0.004),
          cz + u[2] * a + v[2] * c + n[2] * (off + 0.004),
        );
        const m = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
        b.push(m);
        // a disc facing -z in local = facing out of the rack
        for (let s = 0; s < seg; s++) {
          const t0 = (s / seg) * Math.PI * 2;
          const t1 = ((s + 1) / seg) * Math.PI * 2;
          b.tri([0, 0, 0], [Math.cos(t1) * rr, Math.sin(t1) * rr, 0], [Math.cos(t0) * rr, Math.sin(t0) * rr, 0], brass);
        }
        b.tri([0, 0, -0.001], [rr * 0.25, 0, -0.001], [0, rr * 0.25, -0.001], primer);
        b.pop();
      }
    }
  }

  // A periscope / sight housing down from the roof and its glowing
  // eyepiece, as seen from the OTHER stations: its own meshes in the station
  // frame, hidden while that station is in use (wave 7: the static housing
  // stood in front of a periscope window that turns with the look, and
  // filled a third of the Panther driver's screen at yaw). The station's
  // own housing then rides the look with its window (device()).
  _housing(key, st, dv) {
    const b = new GeoBuilder();
    const g = new GeoBuilder();
    this._periscopeHousing(b, g, st, dv);
    const fr = this.frames[st.frame === 'turret' && this.frames.turret ? 'turret' : 'hull'];
    const ms = [this._add(fr, b, this.mats.lit), this._add(fr, g, this.mats.glow)].filter(Boolean);
    this.housings[key] = ms;
  }

  _periscopeHousing(b, g, st, dv) {
    const col = this.col;
    const [x, y, z] = st.eye;
    const d = { ...DEVICE_DEFAULTS.periscope, ...dv };
    const wz = z + (d.dist || 0.07);
    const top = this._roofOver(st);
    const hgt = Math.max(0.06, top - (y - d.h / 2 - 0.03));
    // the body stands BEHIND the eyepiece plane: anything nearer the eye
    // than the window would cover the hole the station view stamps there
    b.box(x, top - hgt / 2, wz + 0.052, d.w + 0.06, hgt, 0.09, col.metal);
    // the brow pad
    b.box(x, y + d.h / 2 + 0.035, wz - 0.03, d.w * 0.9, 0.03, 0.05, col.dark);
    // the eyepiece glass, glowing with daylight (behind the hole the station
    // view stamps over it)
    g.pushTR([x, y, wz + 0.004]);
    g.rect(d.w, d.h, lin(this.def.colors.glass));
    g.pop();
  }

  // the roof over a station's eye, in its own frame
  _roofOver(st) {
    const L = this.def.layout;
    if (st.frame === 'hull') return L.hull.roofY;
    return L.turret ? L.turret.y1 : st.eye[1] + 0.2;
  }

  // the vision blocks' glass, glowing, `back` m behind the window plane
  _blockGlass(g, st, dv, back) {
    const d = { ...DEVICE_DEFAULTS.blocks, ...dv };
    const [cx, , cz] = st.eye;
    const y = d.y != null ? d.y : st.eye[1];
    for (let i = 0; i < d.count; i++) {
      const a = (i / d.count) * Math.PI * 2 + (d.phase || 0);
      g.pushTR([cx + Math.sin(a) * (d.radius + back), y, cz + Math.cos(a) * (d.radius + back)], [0, a, 0]);
      g.rect(d.w, d.h, lin(this.def.colors.glass));
      g.pop();
    }
  }

  _buildBreech() {
    const br = this.def.breech;
    this.breech = null;
    if (!br) return;
    const col = this.col;
    const gun = this.frames.gun;
    const [bx, by, bz] = br.pos;
    const [bw, bh, bl] = br.size;
    const cal = (br.caliber || 75) / 1000;
    // the cradle, guard and recoil cylinders: fixed to the gun, not recoiling
    const cr = new GeoBuilder();
    const gx = bw / 2 + 0.12;
    const g0 = bz + bl / 2 - 0.05;
    const g1 = g0 - br.guardLength;
    // the guard is a tubular frame either side (an open cage: the loader
    // has to see and reach the breech through it)
    for (const s of [-1, 1]) {
      const x = bx + s * gx;
      cr.bar([x, by + bh * 0.25, g0], [x, by + bh * 0.25, g1], 0.025, col.metal);
      cr.bar([x, by - bh * 0.55, g0], [x, by - bh * 0.55, g1], 0.025, col.metal);
      cr.bar([x, by + bh * 0.25, g1], [x, by - bh * 0.55, g1], 0.025, col.metal);
    }
    cr.bar([bx - gx, by - bh * 0.55, g1], [bx + gx, by - bh * 0.55, g1], 0.035, col.metal);
    cr.box(bx, by - bh * 0.62, (g0 + g1) / 2, gx * 2, 0.015, g0 - g1, col.dark); // the case tray
    for (const s of [-1, 1]) {
      cr.cyl(bx + s * bw * 0.22, by + bh / 2 + 0.06, bz + bl / 2 + 0.25, 0.055, 0.5, col.metal, { axis: 'z', seg: 10 });
    }
    // the elevating arc on the gunner's side
    const gs = this.def.stations.gunner && this.def.stations.gunner.eye[0] < 0 ? -1 : 1;
    cr.box(bx + gs * (bw / 2 + 0.05), by - bh * 0.4, bz + bl / 2 + 0.05, 0.03, 0.3, 0.3, col.dark);
    // the bore between the mantlet and the breech ring (inside the turret)
    cr.cyl(bx, by, bz + bl / 2 + 0.25, cal * 0.95, 0.5, col.metal, { axis: 'z', seg: 12 });
    this._add(gun, cr, this.mats.lit);

    // the recoiling breech ring, with its block as a child
    const ringG = new THREE.Group();
    ringG.name = 'ivBreechRing';
    gun.add(ringG);
    const ring = new GeoBuilder();
    ring.box(bx, by, bz, bw, bh, bl, col.metal);
    // the chamber mouth, dark, on the rear face
    ring.pushTR([bx, by, bz - bl / 2 - 0.002]);
    ring.rect(cal * 1.5, cal * 1.5, col.dark);
    ring.pop();
    // the operating handle
    ring.bar([bx + bw / 2, by, bz - bl * 0.2], [bx + bw / 2 + 0.12, by - 0.08, bz - bl * 0.35], 0.025, col.dark);
    this._add(ringG, ring, this.mats.lit);
    const blockG = new THREE.Group();
    blockG.name = 'ivBreechBlock';
    ringG.add(blockG);
    const blk = new GeoBuilder();
    if (br.type === 'screw') {
      blk.cyl(bx, by, bz - bl / 2 - 0.03, cal * 1.05, 0.08, lin(0x6b6e66), { axis: 'z', seg: 14 });
    } else {
      blk.box(bx, by, bz - bl / 2 + bl * 0.16, bw * 0.84, bh * 0.82, bl * 0.34, lin(0x6b6e66));
    }
    this._add(blockG, blk, this.mats.lit);

    // the round being loaded: case + projectile, along +z, base at z = 0
    const roundG = new THREE.Group();
    roundG.name = 'ivRound';
    roundG.visible = false;
    gun.add(roundG);
    const rnd = new GeoBuilder();
    const caseL = br.caseLength;
    const projL = cal * 3.6;
    rnd.cyl(0, 0, caseL / 2, cal * 0.62, caseL, col.brass, { axis: 'z', seg: 10 });
    rnd.cyl(0, 0, caseL + projL * 0.35, cal * 0.5, projL * 0.7, lin(0x3e4234), { axis: 'z', seg: 10 });
    rnd.cyl(0, 0, caseL + projL * 0.85, cal * 0.5, projL * 0.3, lin(0x3e4234), { axis: 'z', seg: 10, r1: cal * 0.12 });
    this._add(roundG, rnd, this.mats.lit);

    this.breech = { def: br, ringG, blockG, roundG, roundLen: caseL + projL, rackPick: null, fetchFrom: new THREE.Vector3() };
  }

  _buildCases() {
    const br = this.def.breech;
    if (!br) return;
    const cal = (br.caliber || 75) / 1000;
    const g = new GeoBuilder();
    g.cyl(0, 0, 0, cal * 0.62, br.caseLength, this.col.brass, { axis: 'z', seg: 9 });
    g.cyl(0, 0, -br.caseLength / 2 - 0.004, cal * 0.72, 0.01, lin(0x8a6c36), { axis: 'z', seg: 9 });
    const geo = g.build();
    const parent = this.frames.turret || this.frames.hull;
    for (let i = 0; i < MAX_CASES; i++) {
      const m = layerMesh(geo, this.mats.lit);
      m.visible = false;
      m.userData.shareGeo = i > 0;
      parent.add(m);
      this.cases.push({ mesh: m, vel: new THREE.Vector3(), spin: new THREE.Vector3(), rest: true, age: 0 });
    }
    this.caseGeo = geo;
  }

  _buildSparks() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3));
    g.setAttribute('life', new THREE.Float32BufferAttribute(new Float32Array(MAX_SPARKS), 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uK: this.u.uK, uIA: this.u.uIA, uIB: this.u.uIB, uPx: { value: 720 } },
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.renderOrder = ORDER_FX;
    pts.visible = false;
    this.frames.hull.add(pts);
    this.sparks = pts;
  }

  // ---- the device of one station, built the first time it is used
  device(key, st) {
    if (this.devices.has(key)) return this.devices.get(key);
    const dv = st.device || { type: 'none' };
    const type = dv.type;
    let entry = null;
    if (type === 'periscope' || type === 'slit') {
      const d = { ...DEVICE_DEFAULTS[type], ...dv };
      // periscope: rides the look (index.js puts it in the view frame);
      // slit: fixed in the station frame at the eye
      const group = type === 'periscope' ? this._group(`ivView_${key}`) : new THREE.Group();
      if (type === 'slit') {
        const fr = this.frames[st.frame === 'turret' && this.frames.turret ? 'turret' : 'hull'];
        group.position.set(st.eye[0], st.eye[1], st.eye[2]);
        fr.add(group);
      }
      const hole = new GeoBuilder();
      hole.rect(d.w, d.h, [0, 0, 0], d.dist);
      const glass = new GeoBuilder();
      glass.rect(d.w, d.h, lin(0x7d9590), d.dist - 0.002);
      const bez = new GeoBuilder();
      bez.frame(d.w, d.h, d.bezel, d.depth, this.col.dark, d.dist);
      // the housing face around the bezel, wide enough to frame the view
      bez.frame(d.w + d.bezel * 2, d.h + d.bezel * 2, 0.08, 0.012, this.col.metal, d.dist + 0.006);
      if (type === 'periscope') {
        // the periscope's own body, turning with it: behind the window
        // plane, up into the roof (the static copy other stations see is
        // hidden while this one is in use)
        const up = Math.max(0.08, this._roofOver(st) - st.eye[1] + 0.06);
        bez.box(0, (up - d.h / 2 - 0.03) / 2, d.dist + 0.06, d.w + d.bezel * 2 + 0.16, up + d.h / 2 + 0.03, 0.09, this.col.metal);
        // (no brow pad on the turning copy: in front of the window plane it
        // ate into the view in the browser — the bezel frames it instead)
      }
      group.add(layerMesh(hole.build(), this.mats.hole, ORDER_HOLE));
      group.add(layerMesh(glass.build(), this.mats.glass, ORDER_GLASS));
      group.add(layerMesh(bez.build(), this.mats.lit, ORDER_BODY));
      group.visible = false;
      entry = { group, type, view: type === 'periscope', d };
    } else if (type === 'blocks') {
      const d = { ...DEVICE_DEFAULTS.blocks, ...dv };
      const fr = this.frames[st.frame === 'turret' && this.frames.turret ? 'turret' : 'hull'];
      const group = new THREE.Group();
      fr.add(group);
      const hole = new GeoBuilder();
      const glass = new GeoBuilder();
      const bez = new GeoBuilder();
      const [cx, , cz] = st.eye;
      const y = d.y != null ? d.y : st.eye[1];
      for (let i = 0; i < d.count; i++) {
        const a = (i / d.count) * Math.PI * 2 + (d.phase || 0);
        const p = [cx + Math.sin(a) * d.radius, y, cz + Math.cos(a) * d.radius];
        for (const b of [hole, glass, bez]) b.pushTR(p, [0, a, 0]);
        hole.rect(d.w, d.h, [0, 0, 0]);
        glass.rect(d.w, d.h, lin(0x7d9590), -0.002);
        bez.frame(d.w, d.h, d.bezel, d.depth, this.col.dark, 0);
        for (const b of [hole, glass, bez]) b.pop();
      }
      group.add(layerMesh(hole.build(), this.mats.hole, ORDER_HOLE));
      group.add(layerMesh(glass.build(), this.mats.glass, ORDER_GLASS));
      group.add(layerMesh(bez.build(), this.mats.lit, ORDER_BODY));
      group.visible = false;
      entry = { group, type, view: false, d };
    } else {
      entry = { group: null, type, view: false, d: dv };
    }
    this.devices.set(key, entry);
    return entry;
  }

  // ----------------------------------------------------------------- frame
  setVisible(v) {
    if (this.root.visible !== v) this.root.visible = v;
    if (!v && this.activeDevice && this.activeDevice.group) this.activeDevice.group.visible = false;
    if (!v) this.activeDevice = null;
  }

  /**
   * Per frame while shown, after the camera's base pose is known (before
   * shake). view: { key, station, offset (world Vector3: aperture - eye),
   * viewMatrix (Matrix4: station frame * eye * look, world, for a device that
   * rides the look) }.
   */
  update(dt, view) {
    const tank = this.tank;
    const fx = this.fx;
    fx.time += dt;
    this.offset.copy(view.offset);
    tmpM.makeTranslation(this.offset.x, this.offset.y, this.offset.z);
    // frames follow the tank's own nodes
    tank.group.updateWorldMatrix(true, true);
    this.frames.hull.matrix.multiplyMatrices(tmpM, tank.group.matrixWorld);
    if (this.frames.turret) this.frames.turret.matrix.multiplyMatrices(tmpM, tank.turretGroup.matrixWorld);
    this.frames.gun.matrix.multiplyMatrices(tmpM, tank.gunGroup.matrixWorld);

    // the active device
    const dev = this.device(view.key, view.station);
    if (this.activeDevice !== dev) {
      if (this.activeDevice && this.activeDevice.group) this.activeDevice.group.visible = false;
      this.activeDevice = dev;
      if (dev.group) dev.group.visible = true;
    }
    // the station's own static housing is replaced by the one that turns
    if (this._housingHidden !== view.key) {
      for (const [k, ms] of Object.entries(this.housings)) for (const m of ms) m.visible = k !== view.key;
      this._housingHidden = view.key;
    }
    // the window (and its bezel) fitted inside the screen at this aspect
    // and field of view, so interior always frames it
    const fit = this._fit(dev, view);
    if (dev.view && dev.group) {
      dev.group.matrix.multiplyMatrices(tmpM, view.viewMatrix);
      if (fit) dev.group.matrix.multiply(tmpM2.makeScale(fit[0], fit[1], 1));
    } else if (dev.group && dev.type === 'slit' && fit) {
      dev.group.scale.set(fit[0], fit[1], 1);
    }

    this._animateBreech(dt);
    this._animateCases(dt);
    this._animateSparks(dt);
    this._light(dt, view);

    for (const k of Object.keys(this.frames)) this.frames[k].matrixWorldNeedsUpdate = true;
    if (dev.view && dev.group) dev.group.matrixWorldNeedsUpdate = true;
    this.root.updateMatrixWorld(true);
  }

  // [sx, sy] that keep a periscope / slit window and its bezel inside
  // FIT_H / FIT_V of the screen's half extents (null: nothing to fit)
  _fit(dev, view) {
    if (!dev || !dev.d || (dev.type !== 'periscope' && dev.type !== 'slit')) return null;
    const d = dev.d;
    const fov = Number.isFinite(view.fov) ? view.fov : 55;
    const aspect = Number.isFinite(view.aspect) && view.aspect > 0 ? view.aspect : 16 / 9;
    const tv = Math.tan((fov * Math.PI) / 360);
    const th = tv * aspect;
    const dist = d.dist > 0.01 ? d.dist : 0.07;
    const bz = Number.isFinite(d.bezel) ? d.bezel : 0.014;
    const tx = (d.w / 2 + bz) / dist;
    const ty = (d.h / 2 + bz) / dist;
    return [Math.min(1, (FIT_H * th) / tx), Math.min(1, (FIT_V * tv) / ty)];
  }

  _strokeOf() {
    const tank = this.tank;
    const shell = tank.spec.shells[tank.shellType];
    return Math.min(0.42, Math.max(0.1, (shell ? shell.caliber : 75) / 620));
  }

  _animateBreech(dt) {
    const tank = this.tank;
    const fx = this.fx;
    // a shot: the reload timer jumps back up
    if (tank.reload > fx.lastReload + 0.25) {
      fx.ejectAt = fx.time + 0.09;
      fx.gunFlash = 1;
      fx.smoke = Math.min(0.7, fx.smoke + 0.07);
    }
    fx.lastReload = tank.reload;
    const b = this.breech;
    if (!b) return;
    const br = b.def;
    const rec = Math.min(1, Math.max(0, -(tank.recoilZ || 0) / this._strokeOf()));
    b.ringG.position.z = -br.recoilLength * rec;
    const total = tank.reloadTotal > 0 ? tank.reloadTotal : tank.spec.reload || 1;
    const u = tank.reload > 0 ? 1 - tank.reload / total : 1;
    const ph = breechPhase(u);
    const ot = br.openTravel * ph.open;
    if (br.type === 'horizontal') b.blockG.position.set(ot, 0, 0);
    else if (br.type === 'screw') {
      b.blockG.position.set(ot * 0.6, 0, -ot * 0.5);
      b.blockG.rotation.y = -ph.open * 1.4;
    } else b.blockG.position.set(0, -ot, 0);
    // the round: from the rack (in the gun frame, picked once per load) to
    // behind the breech, then rammed into the chamber
    if (ph.round) {
      if (!b.rackPick) b.rackPick = this._pickRack(b.fetchFrom);
      const rear = br.pos[2] - br.size[2] / 2;
      const load = tmpV.set(br.pos[0], br.pos[1] + 0.03, rear - b.roundLen - 0.04);
      const chamber = tmpV2.set(br.pos[0], br.pos[1], rear - b.roundLen * 0.12);
      const p = b.roundG.position;
      if (ph.round.ram > 0) {
        p.copy(load).lerp(chamber, ph.round.ram);
        b.roundG.rotation.set(0, 0, 0);
      } else {
        const t = ph.round.t;
        p.copy(b.fetchFrom).lerp(load, t);
        p.y += Math.sin(t * Math.PI) * 0.25;
        b.roundG.rotation.set((1 - t) * 0.5, (1 - t) * 0.6, 0);
      }
      b.roundG.visible = true;
    } else {
      b.roundG.visible = false;
      b.rackPick = null;
    }
  }

  // the nearest rack's front, in the gun frame
  _pickRack(out) {
    const racks = this.def.layout.racks || [];
    const gunInv = tmpM2.copy(this.frames.gun.matrix).invert();
    let best = Infinity;
    out.set(0.3, -0.35, -0.9);
    for (const r of racks) {
      const fr = this.frames[r.frame === 'turret' && this.frames.turret ? 'turret' : 'hull'];
      const p = tmpV.set(r.center[0], r.center[1] + r.size[1] * 0.4, r.center[2]).applyMatrix4(fr.matrix).applyMatrix4(gunInv);
      const d = p.lengthSq();
      if (d < best) {
        best = d;
        out.copy(p);
      }
    }
    // never further than an arm's reach from the breech
    const br = this.def.breech;
    tmpV.set(br.pos[0], br.pos[1], br.pos[2] - 0.5);
    if (out.distanceTo(tmpV) > 1.4) out.sub(tmpV).setLength(1.4).add(tmpV);
    return true;
  }

  _animateCases(dt) {
    const fx = this.fx;
    const br = this.def.breech;
    if (!br || !this.cases.length) return;
    const parentFrame = this.frames.turret ? 'turret' : 'hull';
    if (fx.ejectAt > 0 && fx.time >= fx.ejectAt) {
      fx.ejectAt = -1;
      const c = this.cases[this.caseNext];
      this.caseNext = (this.caseNext + 1) % this.cases.length;
      // spawn at the chamber mouth, in the gun frame, carried into the
      // turret frame (the gun frame's matrix relative to the turret's)
      const g2p = tmpM2.copy(this.frames[parentFrame].matrix).invert().multiply(this.frames.gun.matrix);
      const rear = br.pos[2] - br.size[2] / 2 - br.caseLength / 2;
      c.mesh.position.set(br.pos[0], br.pos[1], rear).applyMatrix4(g2p);
      tmpQ.setFromRotationMatrix(g2p);
      c.mesh.quaternion.copy(tmpQ);
      c.vel.set((Math.random() - 0.5) * 0.4, 0.5, -3.0 - Math.random()).applyQuaternion(tmpQ);
      c.spin.set(4 + Math.random() * 6, (Math.random() - 0.5) * 3, 0);
      c.rest = false;
      c.age = 0;
      c.mesh.visible = true;
    }
    const L = this.def.layout;
    const floorY = parentFrame === 'turret' && L.turret ? L.turret.basketY + 0.04 : L.hull.floorY + 0.04;
    for (const c of this.cases) {
      if (c.rest || !c.mesh.visible) continue;
      c.age += dt;
      c.vel.y -= 9.8 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      if (c.mesh.position.y < floorY) {
        c.mesh.position.y = floorY;
        if (Math.abs(c.vel.y) < 0.6 || c.age > 3) {
          c.rest = true;
          // lie on the floor along whatever heading it ended with
          c.mesh.rotation.set(0, c.mesh.rotation.y, 0);
        } else {
          c.vel.y = -c.vel.y * 0.35;
          c.vel.x *= 0.5;
          c.vel.z *= 0.5;
          c.spin.multiplyScalar(0.5);
        }
      }
      // keep it inside the room
      const lim = L.turret ? L.turret.ringR : L.hull.halfWidth;
      const r = Math.hypot(c.mesh.position.x, c.mesh.position.z);
      if (r > lim) {
        c.mesh.position.x *= lim / r;
        c.mesh.position.z *= lim / r;
        c.vel.x *= -0.3;
        c.vel.z *= -0.3;
      }
    }
  }

  _animateSparks(dt) {
    if (this.sparksLive <= 0) {
      if (this.sparks.visible) this.sparks.visible = false;
      return;
    }
    const pos = this.sparks.geometry.attributes.position;
    const life = this.sparks.geometry.attributes.life;
    const P = pos.array;
    const V = this.sparkVel;
    let live = 0;
    for (let i = 0; i < MAX_SPARKS; i++) {
      let l = this.sparkLife[i];
      if (l <= 0) continue;
      l -= dt;
      this.sparkLife[i] = l;
      life.array[i] = Math.max(0, l);
      if (l <= 0) continue;
      live++;
      V[i * 3 + 1] -= 9.8 * dt;
      P[i * 3] += V[i * 3] * dt;
      P[i * 3 + 1] += V[i * 3 + 1] * dt;
      P[i * 3 + 2] += V[i * 3 + 2] * dt;
    }
    this.sparksLive = live;
    pos.needsUpdate = true;
    life.needsUpdate = true;
    this.sparks.visible = live > 0;
  }

  // ---- lights: dome, daylight through the active port, gun / fire glow,
  // spall flash; smoke
  _light(dt, view) {
    const fx = this.fx;
    const tank = this.tank;
    const u = this.u;
    const day = Math.min(1, (this.day.sun * 0.25 + this.day.sky * 0.6) / 1.6);
    const L = this.def.layout;
    // the dome light
    let dome = fx.domeOut ? 0 : 0.9;
    if (fx.flicker > 0) {
      fx.flicker -= dt;
      const n = Math.sin(fx.time * 63) * Math.sin(fx.time * 23.7 + 1.3);
      dome *= n > 0.1 ? 1 : 0.15;
    }
    const d = L.domeLight;
    const dFrame = this.frames[d && d.frame === 'turret' && this.frames.turret ? 'turret' : 'hull'];
    if (d) u.uLampPos.value[0].set(d.pos[0], d.pos[1] - 0.05, d.pos[2]).applyMatrix4(dFrame.matrix);
    u.uLampCol.value[0].set(1.0 * dome, 0.86 * dome, 0.62 * dome);
    u.uLampR.value[0] = 1.7;
    // daylight in through the port the crewman is looking through (or the
    // cupola blocks / periscopes overhead)
    const st = view.station;
    const sf = this.frames[st.frame === 'turret' && this.frames.turret ? 'turret' : 'hull'];
    const dev = this.activeDevice;
    const sky = this.day.skyCol;
    let kd = 0.35 * day;
    let lampR = 0.55;
    if (dev && dev.view && dev.group && dev.d) {
      // a periscope: the light comes in through its window, so the lamp
      // rides it, between the eye and the eyepiece (the bezel and the brow
      // read instead of a black frame round the view)
      u.uLampPos.value[1].set(0, 0.01, dev.d.dist * 0.45).applyMatrix4(dev.group.matrix);
      kd = 2.2 * day;
      lampR = 0.35;
    } else if (dev && dev.type === 'slit' && dev.d) {
      u.uLampPos.value[1].set(st.eye[0], st.eye[1] + 0.01, st.eye[2] + dev.d.dist * 0.45).applyMatrix4(sf.matrix);
      kd = 2.2 * day;
      lampR = 0.35;
    } else {
      u.uLampPos.value[1].set(st.eye[0], st.eye[1] + 0.12, st.eye[2] + 0.12).applyMatrix4(sf.matrix);
    }
    const kw = 0.05 * day * (lampR < 0.5 ? 5 : 1);
    u.uLampCol.value[1].set(sky[0] * kd + kw, sky[1] * kd + kw, sky[2] * kd + kw);
    u.uLampR.value[1] = lampR;
    // the eye inside adapts to the compartment: the renderer's exposure is
    // solved for the world outside (a noon grey card), so most of it is
    // divided back out here (wave 7: the ivory walls washed out at noon)
    const ex = Number.isFinite(view.exposure) && view.exposure > 0 ? view.exposure : 1.1;
    u.uExpo.value = Math.min(1.25, Math.max(0.35, Math.pow(INTERIOR_EXPOSURE / ex, 0.85)));
    // the gun / fire glow
    let g = 0;
    if (fx.gunFlash > 0) {
      g = fx.gunFlash * 3.5;
      fx.gunFlash = Math.max(0, fx.gunFlash - dt * 9);
    }
    let fire = 0;
    if (tank.burning) fire = 0.8 + 0.5 * Math.sin(fx.time * 17) * Math.sin(fx.time * 5.3);
    const br = this.def.breech;
    if (fire > g && L.hull) {
      u.uLampPos.value[2].set(0, (L.hull.floorY + L.hull.roofY) / 2, L.hull.firewallZ + 0.2).applyMatrix4(this.frames.hull.matrix);
      u.uLampCol.value[2].set(1.6 * fire, 0.55 * fire, 0.12 * fire);
      u.uLampR.value[2] = 1.6;
    } else if (br) {
      u.uLampPos.value[2].set(br.pos[0], br.pos[1] + 0.1, br.pos[2] - br.size[2]).applyMatrix4(this.frames.gun.matrix);
      u.uLampCol.value[2].set(1.4 * g, 0.9 * g, 0.45 * g);
      u.uLampR.value[2] = 1.2;
    } else {
      u.uLampCol.value[2].set(0, 0, 0);
    }
    // the spall flash
    if (fx.flash > 0) {
      const f = fx.flash * 6;
      u.uLampPos.value[3].copy(fx.flashPos).applyMatrix4(this.frames.hull.matrix);
      u.uLampCol.value[3].set(f, f * 0.75, f * 0.45);
      u.uLampR.value[3] = 1.4;
      fx.flash = Math.max(0, fx.flash - dt * 5);
    } else {
      u.uLampCol.value[3].set(0, 0, 0);
    }
    // ambient: what leaks in through every vision port
    const amb = (fx.domeOut ? 0.02 : 0.05) + 0.07 * day;
    u.uAmb.value.set(amb * 0.95, amb, amb * 1.04);
    // smoke: fumes and spall dust clear through the ventilator, a fire keeps
    // filling the compartment
    const target = tank.burning ? 0.55 : 0;
    if (fx.smoke < target) fx.smoke = Math.min(target, fx.smoke + dt * 0.12);
    else fx.smoke = Math.max(target, fx.smoke - dt * 0.07);
    u.uSmoke.value = fx.smoke;
    this.mats.glow.uniforms.uEmis.value = 0.12 + 0.95 * day;
    for (let i = 0; i < LAMPS; i++) if (!Number.isFinite(u.uLampR.value[i])) u.uLampR.value[i] = 1;
  }

  // ---- damage-model events (tankEntity onInteriorEvent)
  //   'hit' (amount)       any hit that rang the hull (addShake)
  //   'pen' (point, dir)   a penetration, world point and direction
  //   'fire'               the vehicle caught fire
  //   'crew' (role)        a crewman knocked out (index.js polls crewAlive)
  onEvent(type, a, b) {
    const fx = this.fx;
    if (type === 'hit') {
      fx.flicker = Math.max(fx.flicker, 0.25 + 0.2 * (a || 1));
      fx.smoke = Math.min(0.8, fx.smoke + 0.04 * (a || 1));
    } else if (type === 'pen') {
      fx.flicker = Math.max(fx.flicker, 1.1);
      fx.smoke = Math.min(0.85, fx.smoke + 0.45);
      if (!fx.domeOut && Math.random() < 0.35) fx.domeOut = true;
      this._spall(a, b);
    } else if (type === 'fire') {
      fx.flicker = Math.max(fx.flicker, 0.6);
    }
  }

  _spall(point, dir) {
    const tank = this.tank;
    // into the hull frame (the layer's own frames are offset; the hull node
    // is not)
    tank.group.updateWorldMatrix(true, false);
    const inv = tmpM2.copy(tank.group.matrixWorld).invert();
    const L = this.def.layout.hull;
    const p = tmpV.set(0, (L.floorY + L.roofY) / 2, 0);
    if (point && Number.isFinite(point.x)) p.copy(point).applyMatrix4(inv);
    // clamp the burst point inside the room
    p.x = Math.max(-L.halfWidth + 0.05, Math.min(L.halfWidth - 0.05, p.x));
    p.y = Math.max(L.floorY + 0.05, Math.min(L.roofY + 0.8, p.y));
    p.z = Math.max(L.rearZ + 0.05, Math.min(L.frontZ - 0.05, p.z));
    const d = tmpV2.set(0, 0, -1);
    if (dir && Number.isFinite(dir.x)) d.copy(dir).transformDirection(inv);
    else d.set(-p.x, 0, -p.z).normalize();
    this.fx.flash = 1;
    this.fx.flashPos.copy(p);
    const P = this.sparks.geometry.attributes.position.array;
    const V = this.sparkVel;
    for (let i = 0; i < MAX_SPARKS; i++) {
      this.sparkLife[i] = 0.25 + Math.random() * 0.7;
      P[i * 3] = p.x;
      P[i * 3 + 1] = p.y;
      P[i * 3 + 2] = p.z;
      const s = 3 + Math.random() * 9;
      V[i * 3] = d.x * s + (Math.random() - 0.5) * 6;
      V[i * 3 + 1] = d.y * s + (Math.random() - 0.3) * 5;
      V[i * 3 + 2] = d.z * s + (Math.random() - 0.5) * 6;
    }
    this.sparksLive = MAX_SPARKS;
    this.sparks.visible = true;
  }

  setPixelHeight(px) {
    if (this.sparks) this.sparks.material.uniforms.uPx.value = px;
  }

  dispose() {
    // the case meshes share one geometry: drop the duplicates first
    for (const c of this.cases) {
      if (c.mesh.userData.shareGeo) c.mesh.geometry = new THREE.BufferGeometry();
    }
    disposeLayerObject(this.root);
    for (const m of Object.values(this.mats)) m.dispose();
    this.devices.clear();
  }
}
