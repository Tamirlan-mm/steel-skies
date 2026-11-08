import * as THREE from 'three';
import { layerMaterial, lin, GeoBuilder, ORDER_BODY } from './common.js';

// The crew inside the player's tank (wave 8): one low-poly mannequin per seat
// the interior file defines, seen from the OTHER stations. Everything is one
// InstancedMesh of a single faceted capsule per frame (hull, turret): limbs,
// torso, head, headgear and the driver's levers are instances of it, posed
// every frame, so the whole crew adds two draw calls and about 5k triangles.
//
// The loader's hands follow the round the layer already animates (rack ->
// breech -> rammed), then close the block; the gunner's hands turn the
// handwheels with the turret and the gun; the driver's levers (or the Tiger's
// wheel) move with the steering; the bow gunner holds his MG / set.
//
//   hidden      the station the player sits at (the camera is in that head)
//   knocked out crewAlive[role] <= 0: he slumps, with a dark stain under him
//   commander   out of the hatch (layer.commanderOut): stands on his seat with
//               his head outside; his legs and torso are what the others see
//   fire        the figures go sooty (the layer's own smoke term fills the room)

// by nation: tunic, trousers, boots, headgear colour + headgear shape
const UNIFORM = {
  USSR: { tunic: 0x6e6a43, legs: 0x5f5b3a, boots: 0x2a2218, gear: 0x2b2a25, shape: 'helmet' }, // khaki, padded tanker's helmet
  Germany: { tunic: 0x34363b, legs: 0x303237, boots: 0x1a1714, gear: 0x1c1d20, shape: 'cap' }, // black Panzer wrap, side cap
  USA: { tunic: 0x565a3a, legs: 0x4b4f36, boots: 0x3f2f20, gear: 0x3b342a, shape: 'helmet' }, // OD, composition tanker's helmet
  Britain: { tunic: 0x6f6344, legs: 0x655a3e, boots: 0x221c16, gear: 0x15161a, shape: 'beret' }, // battledress, RTR black beret
};
const SKIN = 0xb98f73;
const STAIN = 0x2a0a08;
const METAL = 0x4a4d48;
const DARK = 0x1c1d1b;

// instances per crewman; the driver's controls come after the men
const PARTS = 19;
const P = {
  torso: 0, hips: 1, head: 2, gear: 3, gearB: 4,
  uL: 5, fL: 6, hL: 7, uR: 8, fR: 9, hR: 10,
  thL: 11, shL: 12, ftL: 13, thR: 14, shR: 15, ftR: 16,
  stain: 17, neck: 18,
};
const UPPER_ARM = 0.3;
const FOREARM = 0.28;
const THIGH = 0.44;
const SHIN = 0.44;
const SOOT = 0.5;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _e = new THREE.Vector3();
const _h = new THREE.Vector3();

const UP = new THREE.Vector3(0, 1, 0);

function capsuleGeometry() {
  const g = new GeoBuilder();
  const w = [1, 1, 1];
  // a six-sided body with bevelled ends, unit length and width along y
  g.cyl(0, 0, 0, 0.5, 0.7, w, { seg: 6, caps: false });
  g.cyl(0, 0.425, 0, 0.5, 0.15, w, { seg: 6, r1: 0.28 });
  g.cyl(0, -0.425, 0, 0.28, 0.15, w, { seg: 6, r1: 0.5 });
  return g.build();
}

// Two-bone IK: the joint between `a` and `t` (lengths l1, l2), bent towards
// `hint`. Writes the joint to `outJ` and the (reach-clamped) end to `outT`.
export function solveLimb(a, t, l1, l2, hint, outJ, outT) {
  _a.copy(t).sub(a);
  let d = _a.length();
  const max = (l1 + l2) * 0.995;
  const min = Math.abs(l1 - l2) + 0.01;
  if (d < 1e-5) { _a.set(0, -1, 0); d = 1e-5; } else _a.divideScalar(d);
  const c = Math.min(max, Math.max(min, d));
  outT.copy(a).addScaledVector(_a, c);
  const along = (l1 * l1 - l2 * l2 + c * c) / (2 * c);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  _b.copy(hint).addScaledVector(_a, -hint.dot(_a));
  if (_b.lengthSq() < 1e-6) _b.set(_a.y, -_a.x, 0.01);
  _b.normalize();
  outJ.copy(a).addScaledVector(_a, along).addScaledVector(_b, h);
  return outJ;
}

export class CrewFigures {
  constructor(layer) {
    this.layer = layer;
    this.geo = capsuleGeometry();
    this.mat = layerMaterial(layer.u, 'lit');
    this.mat.name = 'layer_crew';
    this.figs = [];
    this.meshes = {};
    this.time = 0;
    this.soot = false;
    this.lastGunPitch = 0;
    this.tris = 0;
    this._build();
  }

  // the height of a station's seat top in its frame (as layer.js builds it)
  _seatTop(st) {
    const L = this.layer.def.layout;
    const spec = this.layer.tank.spec;
    const roof = spec.hull.trackH + spec.hull.h;
    if (!st.seat) return null;
    const floorBase = st.frame === 'hull' ? L.hull.floorY : L.turret ? L.turret.basketY : L.hull.floorY - roof;
    return Math.max(floorBase + 0.38, st.seat[1] - 0.25) + 0.035;
  }

  _floorOf(st) {
    const L = this.layer.def.layout;
    const spec = this.layer.tank.spec;
    if (Number.isFinite(st.footY)) return st.footY;
    // an open tub has its own floor on the old turret ring (wirbelwind.js)
    if (this.layer.def.tub && st.frame === 'turret') return this.layer.def.tub.floorY;
    if (st.frame === 'hull') return L.hull.floorY;
    if (L.turret) return L.turret.basketY;
    return L.hull.floorY - (spec.hull.trackH + spec.hull.h);
  }

  _build() {
    const layer = this.layer;
    const def = layer.def;
    const nation = layer.tank.spec.nation;
    const U = UNIFORM[nation] || UNIFORM.USA;
    const byFrame = { hull: [], turret: [] };
    for (const role of Object.keys(def.stations)) {
      const st = def.stations[role];
      if (!st || !finiteEye(st)) continue;
      const frame = st.frame === 'turret' && layer.frames.turret ? 'turret' : 'hull';
      byFrame[frame].push({ role, st });
    }
    const wheel = def.layout && def.layout.driverWheel;
    for (const frame of ['hull', 'turret']) {
      const list = byFrame[frame];
      if (!list.length) continue;
      const extras = list.some((f) => f.role === 'driver') ? 3 : 0;
      const n = list.length * PARTS + extras;
      const mesh = new THREE.InstancedMesh(this.geo, this.mat, n);
      mesh.name = `ivCrew_${frame}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = ORDER_BODY;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const colors = new Float32Array(n * 3);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      const setCol = (i, c) => colors.set(c, i * 3);
      list.forEach((f, idx) => {
        const base = idx * PARTS;
        const fig = {
          role: f.role, st: f.st, mesh, base, frame, ko: 0, phase: Math.random() * 6,
          seatTop: this._seatTop(f.st), floor: this._floorOf(f.st),
        };
        const tunic = lin(U.tunic);
        const legs = lin(U.legs);
        const boots = lin(U.boots);
        const skin = lin(SKIN);
        const gear = lin(U.gear);
        const col = (p, c) => setCol(base + p, c);
        col(P.torso, tunic); col(P.hips, legs); col(P.head, skin); col(P.neck, skin);
        col(P.gear, gear); col(P.gearB, gear);
        for (const p of [P.uL, P.fL, P.uR, P.fR]) col(p, tunic);
        col(P.hL, skin); col(P.hR, skin);
        for (const p of [P.thL, P.shL, P.thR, P.shR]) col(p, legs);
        col(P.ftL, boots); col(P.ftR, boots);
        col(P.stain, lin(STAIN));
        this.figs.push(fig);
      });
      if (extras) {
        const i0 = list.length * PARTS;
        const metal = lin(METAL);
        const dark = lin(DARK);
        setCol(i0, metal);
        setCol(i0 + 1, metal);
        setCol(i0 + 2, dark);
        this.controls = { mesh, i0, wheel: wheel || null };
      }
      this.meshes[frame] = mesh;
      this.tris += n * (this.geo.attributes.position.count / 3);
      // start hidden: nothing is posed until the first update
      const zero = _m.makeScale(0, 0, 0);
      for (let i = 0; i < n; i++) mesh.setMatrixAt(i, zero);
      layer.frames[frame].add(mesh);
    }
    layer.stats.tris += this.tris;
  }

  // one capsule from a to b, width w, depth d; `front` keeps its flat side
  _seg(mesh, i, a, b, w, d, front) {
    _y.copy(b).sub(a);
    const len = _y.length();
    if (len < 1e-5) {
      mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
      return;
    }
    _y.divideScalar(len);
    _z.copy(front).addScaledVector(_y, -front.dot(_y));
    if (_z.lengthSq() < 1e-6) _z.set(_y.y, -_y.x, 0.01);
    _z.normalize();
    _x.crossVectors(_y, _z);
    _m.makeBasis(_x.multiplyScalar(w), _y.multiplyScalar(len), _z.multiplyScalar(d));
    _m.setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    mesh.setMatrixAt(i, _m);
  }

  _hide(fig) {
    _m.makeScale(0, 0, 0);
    for (let p = 0; p < PARTS; p++) fig.mesh.setMatrixAt(fig.base + p, _m);
  }

  /**
   * Per frame while the layer is shown.
   * view: { key } (the station in use); the layer's breech state is read
   * through this.layer.breechNow, the gun frame through its own frames.
   */
  update(dt, view) {
    const layer = this.layer;
    const tank = layer.tank;
    this.time += dt;
    const key = view.key === 'gunner_look' ? 'gunner' : view.key;
    // the head the player is in, in its frame: no elbow in his face
    const vs = view.station;
    this._viewFrame = vs && finiteEye(vs) ? vs.frame : null;
    if (this._viewFrame) (this._viewEye || (this._viewEye = new THREE.Vector3())).fromArray(vs.eye);
    const akey = layer.def.crewAliveKey || null;
    for (const fig of this.figs) {
      const a = tank.crewAlive ? tank.crewAlive[(akey && akey[fig.role]) || fig.role] : 1;
      const dead = a != null && a <= 0;
      fig.ko += ((dead ? 1 : 0) - fig.ko) * Math.min(1, dt * 3.5);
      if (fig.role === key) this._hide(fig);
      else this._pose(fig, dt);
    }
    if (this.controls) this._driverControls();
    this._gunPrev = tank.gunPitch;
    // a fire: sooty figures (one write, on the change)
    const burning = !!tank.burning;
    if (burning !== this.soot) {
      this.soot = burning;
      const k = burning ? SOOT : 1 / SOOT;
      for (const m of Object.values(this.meshes)) {
        const arr = m.instanceColor.array;
        for (let i = 0; i < arr.length; i++) arr[i] *= k;
        m.instanceColor.needsUpdate = true;
      }
    }
    for (const m of Object.values(this.meshes)) m.instanceMatrix.needsUpdate = true;
  }

  // the matrix taking the gun frame into a figure's own frame
  _gunToFrame(frame, out) {
    const fr = this.layer.frames[frame];
    return out.copy(fr.matrix).invert().multiply(this.layer.frames.gun.matrix);
  }

  _pose(fig, dt) {
    const layer = this.layer;
    const tank = layer.tank;
    const st = fig.st;
    const role = fig.role;
    const mesh = fig.mesh;
    const base = fig.base;
    const out = role === 'commander' && layer.commanderOut && st.hatch && !(fig.ko > 0.5);
    const eye = out ? st.hatch.eye : st.figEye || st.eye;
    const loads = role === 'loader' || !!st.loads;
    const look = st.look || [0, 0];
    let yaw = look[0] || 0;
    // the loader turns to what he is handling
    let handL = null;
    let handR = null;
    const E = fig._E || (fig._E = new THREE.Vector3());
    const hL = fig._hL || (fig._hL = new THREE.Vector3());
    const hR = fig._hR || (fig._hR = new THREE.Vector3());
    E.set(eye[0], eye[1], eye[2]);

    // he steps and bends to what he reaches for (eased, so a change of target
    // does not teleport him)
    const reachTo = fig._reach || (fig._reach = new THREE.Vector3());
    reachTo.set(0, 0, 0);
    if (loads && !out && fig.ko < 0.5) {
      const b = layer.breech;
      if (!b && layer._ww) {
        this._magHands(fig, hL, hR, E);
        handL = hL;
        handR = hR;
      } else if (b && layer.breechNow) {
        const ph = layer.breechNow;
        const M = this._gunToFrame(fig.frame, _m2);
        const br = b.def;
        const rear = br.pos[2] - br.size[2] / 2;
        if (ph.round) {
          // both hands on the round the layer is carrying from the rack
          _h.copy(b.roundG.position);
          hR.copy(_h).applyMatrix4(M);
          _h.z += b.roundLen * 0.5;
          hL.copy(_h).applyMatrix4(M);
          if (ph.round.ram > 0) {
            // ramming: the right fist follows the base home, the left clear
            hL.set(br.pos[0] + 0.28, br.pos[1] - 0.14, rear - 0.25).applyMatrix4(M);
          }
        } else if (ph.phase === 'close' || ph.phase === 'open') {
          hR.set(br.pos[0] + br.size[0] / 2 + 0.1, br.pos[1] - 0.08, rear + br.size[2] * 0.2).applyMatrix4(M);
          hL.set(br.pos[0] - 0.22, br.pos[1] - 0.18, rear - 0.2).applyMatrix4(M);
        } else {
          hR.set(br.pos[0] + 0.14, br.pos[1] - 0.2, rear - 0.28).applyMatrix4(M);
          hL.set(br.pos[0] - 0.14, br.pos[1] - 0.22, rear - 0.28).applyMatrix4(M);
        }
        handL = hL;
        handR = hR;
      }
      if (handR) {
        const yt = Math.atan2(hR.x - E.x, hR.z - E.z);
        const dy = Math.atan2(Math.sin(yt - yaw), Math.cos(yt - yaw));
        yaw += Math.max(-1.3, Math.min(1.3, dy)) * 0.7;
        const reach = Math.hypot(hR.x - E.x, hR.z - E.z);
        const k = Math.min(0.62, Math.max(0, reach - 0.42));
        if (reach > 1e-3) reachTo.set(((hR.x - E.x) / reach) * k, -Math.min(0.45, Math.max(0, E.y - 0.54 - hR.y)), ((hR.z - E.z) / reach) * k);
      }
    }
    const lean = fig._lean || (fig._lean = new THREE.Vector3());
    lean.lerp(reachTo, Math.min(1, dt * 7));
    E.add(lean);

    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const F = fig._F || (fig._F = new THREE.Vector3());
    const R = fig._R || (fig._R = new THREE.Vector3());
    F.set(fx, 0, fz);
    R.set(-fz, 0, fx); // +X is LEFT, so right = (-cos, 0, sin)
    // a slump: the head drops forward, the shoulders with it
    const ko = fig.ko;
    const head = _a.copy(E).addScaledVector(F, -0.06 + ko * 0.2);
    head.y += 0.03 - ko * 0.27;
    const Hd = fig._Hd || (fig._Hd = new THREE.Vector3());
    Hd.copy(head);
    const S = fig._S || (fig._S = new THREE.Vector3());
    S.copy(Hd).addScaledVector(F, -0.02 - ko * 0.08);
    S.y -= 0.22 - ko * 0.04;
    // the hip stays over the seat; never below it
    const Pv = fig._P || (fig._P = new THREE.Vector3());
    // (the man at the breech stands, whatever his fold-down seat's height)
    const hipRest = loads ? fig.floor + 0.62 : (fig.seatTop != null ? fig.seatTop : fig.floor + 0.4) + 0.06;
    const hipY = Math.max(eye[1] - 0.76 - ko * 0.06 + lean.y * 0.7, hipRest);
    Pv.set(eye[0] + lean.x * 0.7, hipY, eye[2] + lean.z * 0.7).addScaledVector(F, -0.08);
    if (out && st.seat) Pv.y = Math.max(eye[1] - 0.76, hipY);

    const put = (p, a, b, w, d) => this._seg(mesh, base + p, a, b, w, d, F);
    // torso, hips, neck
    put(P.torso, Pv, S, 0.38, 0.24);
    const hb = fig._hb || (fig._hb = new THREE.Vector3());
    hb.copy(Pv);
    hb.y -= 0.1;
    put(P.hips, hb, Pv, 0.34, 0.22);
    const nk = fig._nk || (fig._nk = new THREE.Vector3());
    nk.copy(S).lerp(Hd, 0.6);
    put(P.neck, S, nk, 0.1, 0.1);
    // the head: a short capsule; the eye is forward of its centre
    const top = fig._top || (fig._top = new THREE.Vector3());
    const bot = fig._bot || (fig._bot = new THREE.Vector3());
    bot.copy(Hd);
    bot.y -= 0.1;
    top.copy(Hd);
    top.y += 0.1;
    put(P.head, bot, top, 0.17, 0.2);
    this._gear(fig, put, Hd, top, F, R);

    // ---- hands, by role
    const SL = fig._SL || (fig._SL = new THREE.Vector3());
    const SR = fig._SR || (fig._SR = new THREE.Vector3());
    SL.copy(S).addScaledVector(R, -0.2);
    SR.copy(S).addScaledVector(R, 0.2);
    SL.y -= 0.02;
    SR.y -= 0.02;
    const TL = fig._TL || (fig._TL = new THREE.Vector3());
    const TR = fig._TR || (fig._TR = new THREE.Vector3());
    if (ko > 0.5) {
      // arms hang
      TL.copy(SL).addScaledVector(F, 0.14);
      TL.y -= 0.5;
      TR.copy(SR).addScaledVector(F, 0.14);
      TR.y -= 0.5;
    } else if (loads && handL) {
      TL.copy(handL);
      TR.copy(handR);
    } else if (role === 'driver') {
      const c = this._leverTops();
      TL.copy(c.left);
      TR.copy(c.right);
    } else if (role === 'gunner') {
      // handwheels: elevation under the right hand, traverse under the left;
      // each turns with what it drives
      const tr = Math.abs(tank.turretRate || 0);
      const gp = tank.gunPitch || 0;
      const el = Math.abs(gp - (this._gunPrev ?? gp)) / Math.max(dt, 1e-3);
      fig.phase += dt * Math.min(9, tr * 7);
      fig.phase2 = (fig.phase2 || 0) + dt * Math.min(9, el * 20);
      const r = 0.05;
      TR.copy(E).addScaledVector(F, 0.26).addScaledVector(R, 0.16);
      TR.y -= 0.32;
      TR.addScaledVector(R, Math.cos(fig.phase2) * r);
      TR.y += Math.sin(fig.phase2) * r;
      TL.copy(E).addScaledVector(F, 0.3).addScaledVector(R, -0.13);
      TL.y -= 0.4;
      TL.addScaledVector(F, Math.cos(fig.phase) * r);
      TL.y += Math.sin(fig.phase) * r;
    } else if (role === 'radio') {
      // the bow MG's grips, or the set's dials
      const n = Math.sin(this.time * 0.7 + fig.phase) * 0.01;
      TR.copy(E).addScaledVector(F, 0.42).addScaledVector(R, 0.07);
      TR.y -= 0.24 + n;
      TL.copy(E).addScaledVector(F, 0.42).addScaledVector(R, -0.07);
      TL.y -= 0.24 - n;
    } else {
      // the commander: a hand up on the cupola ring, the other down at his side
      // (he stands with his head in the cupola, so his knee is far below)
      const n = Math.sin(this.time * 0.5 + fig.phase) * 0.012;
      TR.copy(E).addScaledVector(F, 0.16).addScaledVector(R, 0.2);
      TR.y -= 0.14 + n;
      TL.copy(E).addScaledVector(F, 0.1).addScaledVector(R, -0.27);
      TL.y -= 0.74 + n;
    }
    this._arm(fig, P.uL, P.fL, P.hL, SL, TL, -1, F, R);
    this._arm(fig, P.uR, P.fR, P.hR, SR, TR, 1, F, R);

    // ---- legs: feet on the floor (or his seat, standing out of the hatch)
    const floorY = out && fig.seatTop != null ? fig.seatTop : fig.floor + 0.04;
    const h = Math.max(0.2, Pv.y - floorY);
    const fwd = Math.min(0.48, Math.sqrt(Math.max(0, 0.78 - h * h)) * 0.72);
    // a high seat: a slightly longer leg rather than boots in mid-air
    fig.legK = Math.max(1, Math.min(1.25, (h - 0.1) / (0.995 * (THIGH + SHIN))));
    this._leg(fig, P.thL, P.shL, P.ftL, -1, Pv, floorY, fwd, F, R);
    this._leg(fig, P.thR, P.shR, P.ftR, 1, Pv, floorY, fwd, F, R);

    // ---- the stain under a knocked-out man
    if (ko > 0.3) {
      const a = _a.copy(Pv).addScaledVector(F, 0.1);
      a.y = (fig.seatTop != null ? fig.seatTop : fig.floor) + 0.012;
      const b = _b.copy(a);
      b.y += 0.008;
      this._seg(mesh, base + P.stain, a, b, 0.42 * Math.min(1, ko), 0.36 * Math.min(1, ko), F);
    } else {
      mesh.setMatrixAt(base + P.stain, _m.makeScale(0, 0, 0));
    }
  }

  // The Flakvierling's loader (no breech): a hand on the magazine being changed
  // (wirbelwind.js swap), the other holding the next one; between changes he
  // stands by the right-hand guns with a spare at his chest.
  _magHands(fig, hL, hR, E) {
    const ww = this.layer._ww;
    // two loaders: each works the guns on his own side of the mount (st.magSide)
    const side = Math.sign(fig.st.magSide || -1);
    let i = -1;
    for (let k = 0; k < ww.swap.length; k++) if (ww.swap[k] >= 0 && Math.sign(ww.mags[k].out) === side) i = k;
    if (i >= 0 && ww.mags[i].pos) {
      const m = ww.mags[i];
      const M = this._gunToFrame(fig.frame, _m2);
      hR.fromArray(m.pos).add(m.group.position).applyMatrix4(M);
      hL.copy(hR);
      hL.y += 0.06;
      hL.x += 0.1;
    } else {
      const n = Math.sin(this.time * 0.6 + fig.phase) * 0.012;
      hR.set(E.x - side * 0.1, E.y - 0.42 + n, E.z + 0.28);
      hL.set(E.x - side * 0.32, E.y - 0.4 - n, E.z + 0.24);
    }
  }

  _gear(fig, put, Hd, top, F, R) {
    const U = UNIFORM[this.layer.tank.spec.nation] || UNIFORM.USA;
    const a = fig._ga || (fig._ga = new THREE.Vector3());
    const b = fig._gb || (fig._gb = new THREE.Vector3());
    if (U.shape === 'helmet') {
      // a padded / composition helmet over the crown, ear flaps below it
      a.copy(Hd);
      a.y += 0.02;
      b.copy(top);
      b.y += 0.035;
      put(P.gear, a, b, 0.215, 0.235);
      a.copy(Hd).addScaledVector(F, -0.05);
      a.y -= 0.07;
      b.copy(a);
      b.y += 0.09;
      put(P.gearB, a, b, 0.19, 0.1);
    } else if (U.shape === 'cap') {
      // a flat side cap on the crown
      a.copy(top);
      a.y -= 0.03;
      b.copy(top);
      b.y += 0.035;
      put(P.gear, a, b, 0.19, 0.25);
      a.copy(top).addScaledVector(F, 0.1);
      a.y -= 0.035;
      b.copy(a);
      b.y += 0.02;
      put(P.gearB, a, b, 0.18, 0.06);
    } else {
      // a beret, pulled to the right
      a.copy(top).addScaledVector(R, 0.03);
      a.y -= 0.03;
      b.copy(a).addScaledVector(R, 0.04);
      b.y += 0.045;
      put(P.gear, a, b, 0.26, 0.26);
      a.copy(top).addScaledVector(F, 0.09);
      a.y -= 0.05;
      b.copy(a);
      b.y += 0.012;
      put(P.gearB, a, b, 0.18, 0.05);
    }
  }

  _arm(fig, pU, pF, pH, shoulder, target, side, F, R) {
    const J = fig._J || (fig._J = new THREE.Vector3());
    const H = fig._Hnd || (fig._Hnd = new THREE.Vector3());
    const hint = fig._hint || (fig._hint = new THREE.Vector3());
    hint.copy(R).multiplyScalar(side * 0.5).addScaledVector(UP, -1).addScaledVector(F, -0.2);
    solveLimb(shoulder, target, UPPER_ARM, FOREARM, hint, J, H);
    if (this._viewFrame === fig.frame && distToSeg(this._viewEye, shoulder, J) < 0.26) {
      hint.copy(shoulder).sub(this._viewEye);
      hint.y -= 0.2;
      solveLimb(shoulder, target, UPPER_ARM, FOREARM, hint, J, H);
    }
    const m = fig.mesh;
    const b = fig.base;
    this._seg(m, b + pU, shoulder, J, 0.1, 0.1, F);
    this._seg(m, b + pF, J, H, 0.085, 0.085, F);
    _e.copy(H).sub(J).normalize();
    _h.copy(H).addScaledVector(_e, 0.09);
    this._seg(m, b + pH, H, _h, 0.075, 0.09, F);
  }

  _leg(fig, pT, pS, pF, side, hip, floorY, fwd, F, R) {
    const m = fig.mesh;
    const b = fig.base;
    const H0 = fig._H0 || (fig._H0 = new THREE.Vector3());
    const T = fig._Ft || (fig._Ft = new THREE.Vector3());
    const K = fig._Kn || (fig._Kn = new THREE.Vector3());
    const E2 = fig._E2 || (fig._E2 = new THREE.Vector3());
    const hint = fig._lh || (fig._lh = new THREE.Vector3());
    H0.copy(hip).addScaledVector(R, side * 0.1);
    H0.y -= 0.06;
    T.copy(H0).addScaledVector(F, fwd);
    T.y = floorY + 0.05;
    hint.copy(F).addScaledVector(UP, 0.4);
    const k = fig.legK || 1;
    solveLimb(H0, T, THIGH * k, SHIN * k, hint, K, E2);
    this._seg(m, b + pT, H0, K, 0.15, 0.16, F);
    this._seg(m, b + pS, K, E2, 0.11, 0.12, F);
    // the boot, toes forward
    _h.copy(E2).addScaledVector(F, 0.2);
    _e.copy(E2).addScaledVector(F, -0.05);
    this._seg(m, b + pF, _e, _h, 0.1, 0.12, UP);
  }

  // ---- the driver's levers (or the Tiger's wheel) and the tops his hands hold
  _leverGeom() {
    const def = this.layer.def;
    const st = def.stations.driver;
    const H = def.layout.hull;
    const [x, y, z] = st.seat || [st.eye[0], st.eye[1] - 0.6, st.eye[2] - 0.1];
    const sy = Math.max(H.floorY + 0.38, y - 0.25);
    return { x, z, sy, floorY: H.floorY };
  }

  _leverTops() {
    const tops = this._tops || (this._tops = { left: new THREE.Vector3(), right: new THREE.Vector3() });
    const tank = this.layer.tank;
    const s = Math.max(-1, Math.min(1, tank.steerInput || 0));
    const wheel = this.controls && this.controls.wheel;
    if (wheel) {
      // hands on the rim at ten and two, carried round with the steering
      const a = s * 0.7;
      const [cx, cy, cz] = wheel.pos;
      const r = wheel.r;
      tops.left.set(cx + Math.cos(0.5 + a) * r, cy + Math.sin(0.5 + a) * r, cz - 0.02);
      tops.right.set(cx - Math.cos(0.5 - a) * r, cy + Math.sin(0.5 - a) * r, cz - 0.02);
      return tops;
    }
    const g = this._leverGeom();
    // +steer turns left (core/input convention): the left lever comes back
    tops.left.set(g.x + 0.17, g.sy + 0.42, g.z + 0.3 - Math.max(0, s) * 0.14);
    tops.right.set(g.x - 0.17, g.sy + 0.42, g.z + 0.3 - Math.max(0, -s) * 0.14);
    return tops;
  }

  _driverControls() {
    const c = this.controls;
    const m = c.mesh;
    const tops = this._leverTops();
    if (c.wheel) {
      // one spoke turning with the rim (the rim itself is in the vehicle file)
      const [cx, cy, cz] = c.wheel.pos;
      const r = c.wheel.r;
      const a = Math.max(-1, Math.min(1, this.layer.tank.steerInput || 0)) * 0.7;
      _x.set(cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz - 0.015);
      _y.set(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cz - 0.015);
      this._seg(m, c.i0, _x.clone(), _y.clone(), 0.03, 0.03, UP);
      m.setMatrixAt(c.i0 + 1, _m.makeScale(0, 0, 0));
      m.setMatrixAt(c.i0 + 2, _m.makeScale(0, 0, 0));
      return;
    }
    const g = this._leverGeom();
    const a = (c._a || (c._a = new THREE.Vector3())).set(g.x + 0.17, g.floorY + 0.05, g.z + 0.42);
    const b = (c._b || (c._b = new THREE.Vector3())).set(g.x - 0.17, g.floorY + 0.05, g.z + 0.42);
    this._seg(m, c.i0, a, tops.left, 0.03, 0.03, UP);
    this._seg(m, c.i0 + 1, b, tops.right, 0.03, 0.03, UP);
    m.setMatrixAt(c.i0 + 2, _m.makeScale(0, 0, 0));
  }

  dispose() {
    for (const m of Object.values(this.meshes)) {
      if (m.parent) m.parent.remove(m);
      m.dispose();
    }
    this.geo.dispose();
    this.mat.dispose();
  }
}

const _dd = new THREE.Vector3();
function distToSeg(p, a, b) {
  _dd.copy(b).sub(a);
  const t = Math.max(0, Math.min(1, _dd.dot(_e.copy(p).sub(a)) / Math.max(_dd.lengthSq(), 1e-9)));
  return _e.copy(a).addScaledVector(_dd, t).distanceTo(p);
}

function finiteEye(st) {
  return Array.isArray(st.eye) && st.eye.length === 3 && st.eye.every((v) => Number.isFinite(v));
}
