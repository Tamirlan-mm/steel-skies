import * as THREE from 'three';
import { hexToLinear } from '../../core/materials.js';

// Shared machinery of the first-person LAYERS: the tank interior (level B,
// interior/layer.js) and the aircraft cockpit (cockpit/index.js).
//
// HOW A LAYER IS DRAWN. The layer is ordinary geometry in the battle scene,
// drawn with the battle camera in the same frame as the world, but every
// layer material squashes its own depth into the front 1% of the depth range
// (LAYER_DEPTH_K), computed with its OWN near/far (LAYER_NEAR / LAYER_FAR):
//
//     z_layer = A * z_view + B                  (the layer's own projection)
//     z_clip  = -w + (z_layer + w) * K          (w = -z_view)
//
// That is linear in the vertex, so clipping and interpolation stay exact, and
// it means:
//   - the layer always draws over the world (nothing in the world is nearer
//     than ~1.01 x the world camera's near plane), so a turret wall 0.4 m from
//     the eye never z-fights the hull armour it sits inside, and the world
//     camera can keep its own near plane;
//   - the layer keeps a near plane of its own (3 cm), so a breech 25 cm from
//     the loader's face is never clipped;
//   - inside the layer the depth test still works, with ~5e-7 of window depth
//     per centimetre at 3 m: parts 1 cm apart do not fight.
//
// Every layer material is `transparent` (opacity 1, depth write ON). That
// files the layer in the see-through half of core/postfx.js (after AO, after
// the cloud composite), so screen-space AO never reads the squashed depth,
// and in three's transparent list, drawn after every opaque world surface —
// which is what lets a HOLE work: a vision port is a mesh with colour writes
// off drawn FIRST in the layer (renderOrder ORDER_HOLE); it stamps the near
// depth over the window, so the walls and the dark backstop behind it fail
// the depth test there and the world, already drawn, shows through.
//
// Lighting is the layer's own (no THREE light is added to the scene, which
// would recompile every world material): an ambient term, one optional
// directional "sun" (the cockpit; zero inside a closed tank) and four point
// lamps (dome light, daylight through a port or hatch, muzzle / fire glow,
// spall flash), plus a smoke term that fogs the layer by distance.
//
// Colours: vertex colours are LINEAR (hexToLinear), never routed through
// THREE.Color; the shader ends with three's tonemapping + colorspace chunks,
// so it is right both into the composer's linear buffer and straight to the
// canvas on the low tier.

export const LAYER_NEAR = 0.03;
export const LAYER_FAR = 14;
export const LAYER_DEPTH_K = 0.01;
// renderOrder of the layer's draws. Far above anything the world uses (<= 11
// today), so the whole layer draws after every world see-through object.
export const ORDER_HOLE = 900000;
export const ORDER_GLASS = 900001;
export const ORDER_BODY = 900002;
export const ORDER_FX = 900003;
export const LAMPS = 4;

const A_NEAR_FAR = -(LAYER_FAR + LAYER_NEAR) / (LAYER_FAR - LAYER_NEAR);
const B_NEAR_FAR = (-2 * LAYER_FAR * LAYER_NEAR) / (LAYER_FAR - LAYER_NEAR);

// One uniform block per layer instance; every material of that layer shares
// the SAME objects, so a lamp is moved once per frame for all of them.
export function createLayerUniforms() {
  const lampPos = [];
  const lampCol = [];
  const lampR = [];
  for (let i = 0; i < LAMPS; i++) {
    lampPos.push(new THREE.Vector3(0, -1000, 0));
    lampCol.push(new THREE.Vector3(0, 0, 0));
    lampR.push(1);
  }
  return {
    uK: { value: LAYER_DEPTH_K },
    uIA: { value: A_NEAR_FAR },
    uIB: { value: B_NEAR_FAR },
    uAmb: { value: new THREE.Vector3(0.05, 0.05, 0.05) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Vector3(0, 0, 0) },
    uLampPos: { value: lampPos },
    uLampCol: { value: lampCol },
    uLampR: { value: lampR },
    uSmoke: { value: 0 },
    uSmokeCol: { value: new THREE.Vector3(0.32, 0.31, 0.3) },
    // the layer's own exposure, multiplied in before three's tone mapping:
    // a crewman's eye adapts to the compartment, not to the noon sky the
    // renderer's exposure is solved for (layer.js sets it per frame)
    uExpo: { value: 1 },
  };
}

const VERT = /* glsl */ `
uniform float uK;
uniform float uIA;
uniform float uIB;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vCol;
varying float vDist;
#ifdef LAYER_UV
varying vec2 vUv;
#endif
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
#ifdef USE_COLOR
  vCol = color;
#else
  vCol = vec3(1.0);
#endif
#ifdef LAYER_UV
  vUv = uv;
#endif
  vec4 mv = viewMatrix * wp;
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
  // the layer's own projection, squashed into the front of the depth range
  float zi = uIA * mv.z + uIB;
  gl_Position.z = -gl_Position.w + (zi + gl_Position.w) * uK;
}
`;

const FRAG_LIT = /* glsl */ `
uniform vec3 uAmb;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uLampPos[${LAMPS}];
uniform vec3 uLampCol[${LAMPS}];
uniform float uLampR[${LAMPS}];
uniform float uSmoke;
uniform vec3 uSmokeCol;
uniform float uEmis;
uniform float uOpacity;
uniform float uExpo;
#ifdef LAYER_UV
uniform sampler2D uMap;
varying vec2 vUv;
#endif
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vCol;
varying float vDist;
void main() {
  vec3 n = normalize(vN);
  vec3 light = uAmb * (0.8 + 0.2 * n.y);
  light += uSunCol * max(dot(n, uSunDir), 0.0);
  for (int i = 0; i < ${LAMPS}; i++) {
    vec3 L = uLampPos[i] - vWorld;
    float d2 = max(dot(L, L), 1e-6);
    float ndl = max(dot(n, L * inversesqrt(d2)), 0.0) * 0.8 + 0.2;
    float r = uLampR[i];
    light += uLampCol[i] * ndl / (1.0 + d2 / (r * r));
  }
  vec3 base = vCol;
#ifdef LAYER_UV
  vec4 tex = texture2D(uMap, vUv);
  base *= tex.rgb;
#endif
  vec3 c = base * light + base * uEmis;
  float s = clamp(uSmoke * (1.0 - exp(-vDist * 1.1)), 0.0, 0.94);
  c = mix(c, uSmokeCol * (light * 0.6 + 0.01), s);
  gl_FragColor = vec4(c * uExpo, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const FRAG_HOLE = /* glsl */ `
void main() { gl_FragColor = vec4(0.0); }
`;

const FRAG_ADD = /* glsl */ `
uniform float uOpacity;
varying vec3 vCol;
void main() {
  gl_FragColor = vec4(vCol * uOpacity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// kind: 'lit' (default), 'emissive' (lit + its own glow), 'hole' (stamps the
// near depth, writes no colour), 'glass' (lit, see-through), 'add' (additive
// glow: flashes, sparks). opts: { emis, opacity, side, map (a texture: lit
// with uv), depthWrite }.
export function layerMaterial(uniforms, kind = 'lit', opts = {}) {
  const u = { ...uniforms };
  u.uEmis = { value: opts.emis != null ? opts.emis : kind === 'emissive' ? 1 : 0 };
  u.uOpacity = { value: opts.opacity != null ? opts.opacity : kind === 'glass' ? 0.16 : 1 };
  const defines = {};
  if (opts.map) {
    u.uMap = { value: opts.map };
    defines.LAYER_UV = '';
  }
  const frag = kind === 'hole' ? FRAG_HOLE : kind === 'add' ? FRAG_ADD : FRAG_LIT;
  const m = new THREE.ShaderMaterial({
    uniforms: u,
    defines,
    vertexShader: VERT,
    fragmentShader: frag,
    vertexColors: kind !== 'hole',
    transparent: true,
    depthWrite: opts.depthWrite != null ? opts.depthWrite : kind !== 'glass' && kind !== 'add',
    depthTest: true,
    side: opts.side != null ? opts.side : THREE.FrontSide,
    fog: false,
    toneMapped: true,
  });
  if (kind === 'hole') m.colorWrite = false;
  if (kind === 'add') {
    m.blending = THREE.AdditiveBlending;
  }
  m.name = `layer_${kind}`;
  m.userData.layer = true;
  return m;
}

// ---------------------------------------------------------------------------
// Geometry: a tiny merge-as-you-go builder. Parts are emitted straight into
// position / normal / colour arrays (colour = linear), through a current
// transform, so a whole frame's worth of walls, seats and racks is ONE draw.
// ---------------------------------------------------------------------------
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m3 = new THREE.Matrix3();

export function lin(hex, k = 1) {
  const c = hexToLinear(hex);
  return [c[0] * k, c[1] * k, c[2] * k];
}

export class GeoBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.col = [];
    this.uv = null;
    this.mat = new THREE.Matrix4();
    this._stack = [];
  }

  get count() {
    return this.pos.length / 3;
  }

  // transform stack (Matrix4 or [x,y,z] translation, optional Euler [x,y,z])
  push(m) {
    this._stack.push(this.mat.clone());
    this.mat.multiply(m);
    return this;
  }

  pushTR(t, r = null) {
    const m = new THREE.Matrix4();
    if (r) m.makeRotationFromEuler(new THREE.Euler(r[0] || 0, r[1] || 0, r[2] || 0, 'YXZ'));
    m.setPosition(t[0], t[1], t[2]);
    return this.push(m);
  }

  pop() {
    this.mat = this._stack.pop() || new THREE.Matrix4();
    return this;
  }

  _vert(x, y, z, nx, ny, nz, c, u = 0, w = 0) {
    _v.set(x, y, z).applyMatrix4(this.mat);
    _m3.getNormalMatrix(this.mat);
    _n.set(nx, ny, nz).applyMatrix3(_m3).normalize();
    this.pos.push(_v.x, _v.y, _v.z);
    this.nor.push(_n.x, _n.y, _n.z);
    this.col.push(c[0], c[1], c[2]);
    if (this.uv) this.uv.push(u, w);
  }

  // one flat triangle, normal from the winding (counter-clockwise = front)
  tri(a, b, c, col) {
    const e1x = b[0] - a[0]; const e1y = b[1] - a[1]; const e1z = b[2] - a[2];
    const e2x = c[0] - a[0]; const e2y = c[1] - a[1]; const e2z = c[2] - a[2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this._vert(a[0], a[1], a[2], nx, ny, nz, col);
    this._vert(b[0], b[1], b[2], nx, ny, nz, col);
    this._vert(c[0], c[1], c[2], nx, ny, nz, col);
  }

  // quad a-b-c-d, counter-clockwise seen from its front
  quad(a, b, c, d, col) {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  }

  // A box centred at (x, y, z) with full sizes (sx, sy, sz). inside: the
  // faces look INTO the box (a room); omit: the face names to leave open
  // ('px','nx','py','ny','pz','nz').
  box(x, y, z, sx, sy, sz, col, opts = {}) {
    const hx = sx / 2; const hy = sy / 2; const hz = sz / 2;
    const P = (i, j, k) => [x + i * hx, y + j * hy, z + k * hz];
    const omit = opts.omit || '';
    const faces = [
      ['px', P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1)],
      ['nx', P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), P(-1, -1, -1)],
      ['py', P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1)],
      ['ny', P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)],
      ['pz', P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), P(-1, -1, 1)],
      ['nz', P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1)],
    ];
    const shade = opts.shade !== false;
    for (const [name, a, b, c, d] of faces) {
      if (omit.includes(name)) continue;
      // a touch of baked shading per face so flat-lit boxes still read
      const k = !shade ? 1 : name === 'py' ? 1.0 : name === 'ny' ? 0.72 : name[1] === 'x' ? 0.86 : 0.92;
      const cc = [col[0] * k, col[1] * k, col[2] * k];
      if (opts.inside) this.quad(d, c, b, a, cc);
      else this.quad(a, b, c, d, cc);
    }
    return this;
  }

  // A cylinder along `axis` ('x' | 'y' | 'z') centred at (x, y, z).
  // opts: { caps (default true), inside, open: [startAngle, endAngle] }
  cyl(x, y, z, r, len, col, opts = {}) {
    const seg = opts.seg || 10;
    const axis = opts.axis || 'y';
    const caps = opts.caps !== false;
    const r1 = opts.r1 != null ? opts.r1 : r;
    const map = (a, b, h) => {
      // (a, b) around the axis, h along it
      if (axis === 'y') return [x + a, y + h, z + b];
      if (axis === 'x') return [x + h, y + a, z + b];
      return [x + a, y + b, z + h];
    };
    const h0 = -len / 2;
    const h1 = len / 2;
    const a0 = opts.from != null ? opts.from : 0;
    const a1 = opts.to != null ? opts.to : Math.PI * 2;
    const ring = [];
    for (let i = 0; i <= seg; i++) {
      const t = a0 + ((a1 - a0) * i) / seg;
      ring.push([Math.cos(t), Math.sin(t)]);
    }
    // (a, b, h) -> world is a reflection for 'y' and a rotation for 'x'/'z',
    // which flips what a given winding means
    const inward = !!opts.inside !== (axis !== 'y');
    const top = map(0, 0, h1);
    const bot = map(0, 0, h0);
    for (let i = 0; i < seg; i++) {
      const [c0, s0] = ring[i];
      const [c1, s1] = ring[i + 1];
      const A = map(c0 * r, s0 * r, h0);
      const B = map(c1 * r, s1 * r, h0);
      const C = map(c1 * r1, s1 * r1, h1);
      const D = map(c0 * r1, s0 * r1, h1);
      if (inward) this.quad(A, B, C, D, col);
      else this.quad(D, C, B, A, col);
      if (caps) {
        if (inward) {
          this.tri(top, D, C, col);
          this.tri(bot, B, A, col);
        } else {
          this.tri(top, C, D, col);
          this.tri(bot, A, B, col);
        }
      }
    }
    return this;
  }

  // A bar (square section, `t` thick) from a to b.
  bar(a, b, t, col) {
    const dx = b[0] - a[0]; const dy = b[1] - a[1]; const dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-5) return this;
    const dir = new THREE.Vector3(dx / L, dy / L, dz / L);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(1, 1, 1),
    );
    this.push(m);
    this.box(0, 0, 0, t, t, L, col);
    this.pop();
    return this;
  }

  // An extruded side profile seen from the INSIDE: `profile` is a convex
  // polygon of [y, z] points (any winding), extruded across x = -hw..hw; the
  // faces look inward (a hull compartment with a sloped glacis).
  // slope (optional): { yKnee, hwTop, yTop } — above y = yKnee the side walls
  // lean in linearly to half-width hwTop at y = yTop (sloped upper side
  // plates); below the knee they stand at hw.
  insideProfile(profile, hw, col, colSide = col, slope = null) {
    // orient the polygon counter-clockwise in (z, y)
    let area = 0;
    for (let i = 0; i < profile.length; i++) {
      const [y0, z0] = profile[i];
      const [y1, z1] = profile[(i + 1) % profile.length];
      area += z0 * y1 - z1 * y0;
    }
    let P = area > 0 ? profile : [...profile].reverse();
    const hwAt = (y) => {
      if (!slope || !(slope.yTop > slope.yKnee)) return hw;
      const t = Math.min(1, Math.max(0, (y - slope.yKnee) / (slope.yTop - slope.yKnee)));
      return hw + (slope.hwTop - hw) * t;
    };
    // a knee: split every edge that crosses it, so each strip is planar
    if (slope) {
      const out = [];
      for (let i = 0; i < P.length; i++) {
        const a = P[i];
        const b = P[(i + 1) % P.length];
        out.push(a);
        if ((a[0] - slope.yKnee) * (b[0] - slope.yKnee) < 0) {
          const t = (slope.yKnee - a[0]) / (b[0] - a[0]);
          out.push([slope.yKnee, a[1] + (b[1] - a[1]) * t]);
        }
      }
      P = out;
    }
    const n = P.length;
    for (let i = 0; i < n; i++) {
      const [y0, z0] = P[i];
      const [y1, z1] = P[(i + 1) % n];
      // a wall strip between consecutive profile points, facing in
      const k = Math.abs(z1 - z0) > Math.abs(y1 - y0) ? 1.0 : 0.88;
      const cc = [col[0] * k, col[1] * k, col[2] * k];
      const w0 = hwAt(y0);
      const w1 = hwAt(y1);
      this.quad([w0, y0, z0], [-w0, y0, z0], [-w1, y1, z1], [w1, y1, z1], cc);
    }
    // side walls, facing in: one fan per side of the knee (each half planar)
    const halves = slope
      ? [P.filter((p) => p[0] <= slope.yKnee + 1e-6), P.filter((p) => p[0] >= slope.yKnee - 1e-6)]
      : [P];
    for (const Q of halves) {
      for (let i = 1; i < Q.length - 1; i++) {
        const a = Q[0]; const b = Q[i]; const c = Q[i + 1];
        const wa = hwAt(a[0]); const wb = hwAt(b[0]); const wc = hwAt(c[0]);
        this.tri([wa, a[0], a[1]], [wb, b[0], b[1]], [wc, c[0], c[1]], colSide);
        this.tri([-wa, a[0], a[1]], [-wc, c[0], c[1]], [-wb, b[0], b[1]], colSide);
      }
    }
    return this;
  }

  // An elliptic cylinder room around the y axis (a turret seen from inside):
  // walls from y0 to y1, radii rx / rz, centre (cx, cz), plus its roof.
  insideTurret(cx, cz, rx, rz, y0, y1, col, colRoof = col, seg = 18) {
    const pts = [];
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      pts.push([cx + Math.sin(t) * rx, cz + Math.cos(t) * rz]);
    }
    for (let i = 0; i < seg; i++) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[i + 1];
      this.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z1], [x1, y0, z1], col);
      // roof fan, facing down
      this.tri([cx, y1, cz], [x1, y1, z1], [x0, y1, z0], colRoof);
    }
    return this;
  }

  // A rectangular frame (a window bezel) in the local XY plane at z, inner
  // size w x h, border b, depth d (towards -z, the eye side).
  frame(w, h, b, d, col, z = 0) {
    const hw = w / 2; const hh = h / 2;
    this.box(0, hh + b / 2, z - d / 2, w + 2 * b, b, d, col);
    this.box(0, -hh - b / 2, z - d / 2, w + 2 * b, b, d, col);
    this.box(hw + b / 2, 0, z - d / 2, b, h, d, col);
    this.box(-hw - b / 2, 0, z - d / 2, b, h, d, col);
    return this;
  }

  // a flat rectangle facing -z (towards the eye) in the local XY plane
  rect(w, h, col, z = 0) {
    const hw = w / 2; const hh = h / 2;
    this.quad([hw, -hh, z], [-hw, -hh, z], [-hw, hh, z], [hw, hh, z], col);
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

// A mesh of the layer: never casts or receives a shadow, never frustum-culled
// on its stale bounding sphere (it is a few metres from the eye anyway).
export function layerMesh(geo, mat, order = ORDER_BODY) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = false;
  m.receiveShadow = false;
  m.frustumCulled = false;
  m.renderOrder = order;
  m.matrixAutoUpdate = true;
  return m;
}

// Daylight the world is lit with, read once from the scene's own lights:
// { sun: intensity of the brightest directional light, sky: hemisphere +
// ambient intensity, sunDir: world direction TO the sun, sunCol, skyCol
// (linear rgb) }. Defaults to a grey noon when the scene has none (headless).
export function sceneDaylight(scene) {
  const out = {
    sun: 0, sky: 0, sunDir: new THREE.Vector3(0.3, 0.8, 0.2).normalize(),
    sunCol: [1, 0.95, 0.88], skyCol: [0.55, 0.62, 0.75],
  };
  if (!scene || typeof scene.traverse !== 'function') return { ...out, sun: 2.5, sky: 0.8 };
  scene.traverse((o) => {
    if (o.isDirectionalLight && o.intensity > out.sun) {
      out.sun = o.intensity;
      const t = o.target && o.target.position ? o.target.position : new THREE.Vector3();
      _v.copy(o.position).sub(t);
      if (_v.lengthSq() > 1e-8) out.sunDir.copy(_v.normalize());
      out.sunCol = [o.color.r, o.color.g, o.color.b];
    } else if (o.isHemisphereLight) {
      out.sky += o.intensity;
      out.skyCol = [o.color.r, o.color.g, o.color.b];
    } else if (o.isAmbientLight) {
      out.sky += o.intensity * 0.6;
    }
  });
  if (out.sun === 0 && out.sky === 0) return { ...out, sun: 2.5, sky: 0.8 };
  return out;
}

// Free a layer's own geometries and materials (textures in opts.textures).
export function disposeLayerObject(root, textures = []) {
  if (!root) return;
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) m.dispose();
  });
  for (const t of textures) if (t && t.dispose) t.dispose();
  if (root.parent) root.parent.remove(root);
}
