import * as THREE from 'three';
import { input } from '../../core/input.js';
import { TOUCH_BUTTONS } from '../../core/touch.js';
import { wrapAngle, clamp } from '../../core/utils.js';
import { mergeDef, tankInteriorDefinition, defineTankInterior, definedTankInteriors } from './registry.js';
import {
  deriveTankInterior, STATION_ORDER, STATION_LABEL, DEVICE_LABEL, DEVICE_DEFAULTS, limitsFor,
} from './stations.js';
import { InteriorLayer, breechPhase } from './layer.js';

export { defineTankInterior, definedTankInteriors, breechPhase, STATION_ORDER };

// ===========================================================================
// TANK CREW STATIONS (wave 6, interior framework)
// ===========================================================================
// Level A: the player can sit at a crew station — gunner (the existing H-02
// sniper optic), commander (cupola vision blocks or periscope, hatch open on
// the wheel), driver (periscope or slit; the tank still drives), loader (the
// interior and the breech), bow gunner — cycled with the "crew station" key
// (KeyC, rebindable) and left with the "third person" key (KeyX); on a
// touch screen the CREW button cycles and the cycle ends in third person.
// Level B (layer.js): while in a station other than the gunner's, the tank's
// own simplified interior is drawn around the eye.
//
// For the battles the whole contract is stationsFor(battle):
//   updatePlayerControls:  const sv = stationsFor(this); sv.input(dt);
//                          mouse -> camYaw/camPitch only if !sv.ownsMouse,
//                          wheel -> sniper / dolly only if !sv.ownsMouse,
//                          aim ray origin: sv.aimOrigin(p, v) while sv.ownsMouse
//   updateCamera (first):  const viewing = sv.beginFrame(alive tank | null);
//                          ... else if (viewing) targetFov = sv.placeCamera(camera, p, dt)
//   updateHUD:             crosshair hidden while sv.viewing
// The turret holds the world direction it was laid on while the player looks
// round from another seat; firing still works from every station.
//
// Per-vehicle data: src/vehicles/interior/<specId>.js (registry.js has the
// file format); resolveTankInterior(spec) merges it over stations.js's
// derived defaults.

// ---- per-vehicle files: every ./<specId>.js beside this one (Vite). In node
// import.meta.glob does not exist, the call throws and nothing is loaded:
// a headless test imports the vehicle file it wants itself.
try {
  // eslint-disable-next-line no-undef
  import.meta.glob(['./*.js', '!./index.js', '!./registry.js', '!./common.js', '!./stations.js', '!./layer.js'], { eager: true });
} catch (e) {
  /* node: no glob */
}

// ---- the touch button (core/touch.js builds its buttons from this table at
// touch.init(), which runs after every module has loaded)
try {
  if (Array.isArray(TOUCH_BUTTONS) && !TOUCH_BUTTONS.some((b) => b && b.id === 'crew')) {
    const i = TOUCH_BUTTONS.findIndex((b) => b && b.id === 'sight');
    TOUCH_BUTTONS.splice(i >= 0 ? i + 1 : TOUCH_BUTTONS.length, 0,
      { id: 'crew', label: 'CREW', modes: 'tank', code: 'KeyC' });
  }
} catch (e) {
  /* a touch table without the hook: the keyboard still works */
}

export const STATION_HELP = 'C — crew stations · E — gunner: sight / look around · X — third person';

const finite3 = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => Number.isFinite(v));

// Fill in every station's device and limits, and drop anything malformed
// (a broken per-vehicle file must never take a battle down).
function normStation(key, st, b) {
  if (!st || typeof st !== 'object') return null;
  b = b || {};
  {
    const frame = st.frame === 'hull' || st.frame === 'turret' ? st.frame : b.frame || 'hull';
    const eye = finite3(st.eye) ? st.eye : b.eye;
    if (!finite3(eye)) return null;
    const type = st.device && DEVICE_DEFAULTS[st.device.type] ? st.device.type : st.device && st.device.type === 'sight' ? 'sight' : 'none';
    const device = { ...(DEVICE_DEFAULTS[type] || {}), ...(st.device || {}), type };
    const lim = limitsFor(type);
    const limits = {
      yaw: st.limits && 'yaw' in st.limits ? st.limits.yaw : lim.yaw,
      pitch: st.limits && st.limits.pitch ? st.limits.pitch : lim.pitch,
    };
    let hatch = null;
    if (st.hatch && finite3(st.hatch.eye)) {
      const hl = limitsFor('hatch');
      hatch = {
        eye: st.hatch.eye,
        fov: Number.isFinite(st.hatch.fov) ? st.hatch.fov : hl.fov,
        limits: {
          yaw: st.hatch.limits && 'yaw' in st.hatch.limits ? st.hatch.limits.yaw : hl.yaw,
          pitch: st.hatch.limits && st.hatch.limits.pitch ? st.hatch.limits.pitch : hl.pitch,
        },
      };
    }
    return {
      ...st,
      key,
      frame,
      eye,
      look: Array.isArray(st.look) && st.look.length >= 2 ? st.look : [0, 0],
      device,
      limits,
      fov: Number.isFinite(st.fov) ? st.fov : lim.fov,
      hatch,
      shake: Number.isFinite(st.shake) ? st.shake : 1,
      seat: finite3(st.seat) ? st.seat : null,
    };
  }
}

function finalize(def, base) {
  const out = { ...def, stations: {} };
  for (const key of Object.keys(def.stations || {})) {
    const st = normStation(key, def.stations[key], base.stations[key]);
    if (!st) continue;
    // the gunner's look-around view (wave 7): his own vision device, or a
    // seated view in the turret, beside the sight (index.js gunnerLook)
    if (key === 'gunner') {
      const bg = base.stations.gunner || {};
      const bv = bg.vision || null;
      let src = st.vision === null ? null : st.vision || bv;
      // the derived seated eye follows a gunner's eye the vehicle file moved
      if (src && bv && finite3(src.eye) && finite3(bv.eye) && finite3(bg.eye)
        && src.eye.every((x, i) => Math.abs(x - bv.eye[i]) < 1e-9) && !st.eye.every((x, i) => Math.abs(x - bg.eye[i]) < 1e-9)) {
        src = { ...src, eye: [0, 1, 2].map((i) => st.eye[i] + (bv.eye[i] - bg.eye[i])) };
      }
      const v = src ? normStation('gunner_look', src, bv) : null;
      if (v) v.hatch = null;
      st.vision = v;
    }
    out.stations[key] = st;
  }
  if (!out.colors) out.colors = base.colors;
  else out.colors = { ...base.colors, ...out.colors };
  if (!out.layout || !out.layout.hull) out.layout = base.layout;
  return out;
}

const resolved = new WeakMap();

// The interior of one spec: the derived defaults with its per-vehicle file
// (if any) merged over them. Cached per spec object.
export function resolveTankInterior(spec) {
  if (!spec) return null;
  let r = resolved.get(spec);
  if (r) return r;
  const base = deriveTankInterior(spec);
  const defn = tankInteriorDefinition(spec.id);
  let over = null;
  if (defn) {
    try {
      over = typeof defn === 'function' ? defn(spec, base) : defn;
    } catch (e) {
      console.warn(`[interior] ${spec.id}: definition threw, using defaults`, e);
      over = null;
    }
  }
  r = finalize(over ? mergeDef(base, over) : base, base);
  r.source = over ? 'file' : 'default';
  resolved.set(spec, r);
  return r;
}

// ---------------------------------------------------------------------------
// the station camera maths (pure: frame matrix in, eye / aperture / look out)
// ---------------------------------------------------------------------------
const _e = new THREE.Vector3();
const _a = new THREE.Vector3();
const _d = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qf = new THREE.Quaternion();
const _eul = new THREE.Euler(0, 0, 0, 'YXZ');
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Where one station looks from. frameMatrix: the station frame's world matrix
 * (tank.group or tank.turretGroup). Returns into `out`:
 *   eye       world: where the interior is seen from (the crewman's eye)
 *   aperture  world: where the world is seen from (periscope head, the
 *             outside of a slit or block) — the camera goes here
 *   dir, up   world view direction and up (the head stays upright in the hull)
 *   view      Matrix4: frame * eye * look (a periscope's window rides it)
 */
export function stationPose(frameMatrix, st, yaw, pitch, hatchOpen, bob, out, ext = null) {
  const hatch = hatchOpen && st.hatch ? st.hatch : null;
  const dv = st.device || {};
  const type = hatch ? 'hatch' : dv.type;
  frameMatrix.decompose(_p, _qf, _s);
  _eul.set(-pitch, yaw, 0, 'YXZ');
  _q.setFromEuler(_eul);
  const dirL = _d.set(0, 0, 1).applyQuaternion(_q);
  const eyeL = _e.fromArray(hatch ? hatch.eye : st.eye);
  const apL = _a.copy(eyeL);
  if (type === 'periscope' && ext && ext.head) {
    // the head the outside model draws (wave 7): the world is seen from
    // just outside its window, so its own box never fills the view
    apL.fromArray(ext.head);
    apL.y += HEAD_UP;
    apL.x += Math.sin(yaw) * HEAD_FWD;
    apL.z += Math.cos(yaw) * HEAD_FWD;
  } else if (type === 'periscope' && ext && ext.through > 0) {
    // a sight through the armour (an MG ball's telescope): its objective
    // sits just outside the plate, along the look
    apL.addScaledVector(dirL, ext.through);
  } else if (type === 'periscope') {
    const rise = Number.isFinite(dv.rise) ? dv.rise : 0.24;
    const fwd = Number.isFinite(dv.fwd) ? dv.fwd : 0.06;
    apL.x += Math.sin(yaw) * fwd;
    apL.z += Math.cos(yaw) * fwd;
    apL.y += rise;
  } else if (type === 'blocks') {
    const lean = Number.isFinite(dv.lean) ? dv.lean : 0.12;
    const R = Number.isFinite(dv.radius) ? dv.radius : 0.3;
    const sx = Math.sin(yaw);
    const cz = Math.cos(yaw);
    apL.x = st.eye[0] + sx * (R + 0.16);
    apL.z = st.eye[2] + cz * (R + 0.16);
    eyeL.x += sx * lean;
    eyeL.z += cz * lean;
  } else if (type === 'slit') {
    const dist = Number.isFinite(dv.dist) ? dv.dist : 0.12;
    // through the plate: where the outside model's armour ends on the
    // station's line of sight (wave 7: the IS-2's visor looked into its
    // own cast nose), else the window plus 10 cm
    apL.addScaledVector(dirL, ext && ext.through > 0 ? ext.through : dist + 0.1);
  }
  out.view.makeRotationFromQuaternion(_q).setPosition(eyeL);
  out.view.premultiply(frameMatrix);
  if (bob) eyeL.add(bob);
  out.eye.copy(eyeL).applyMatrix4(frameMatrix);
  out.aperture.copy(apL).applyMatrix4(frameMatrix);
  out.dir.copy(dirL).applyQuaternion(_qf).normalize();
  out.up.copy(_up.set(0, 1, 0)).applyQuaternion(_qf).normalize();
  out.type = type;
  return out;
}

// ---------------------------------------------------------------------------
// the controller
// ---------------------------------------------------------------------------
const NEAR_STATION = 0.15;
// a periscope head's window: the aperture sits this far out of its centre
const HEAD_FWD = 0.1;
// ...and this far over its centre, at its window (the box is ~8 cm tall)
const HEAD_UP = 0.025;
// the gunner's look-around toggle (core/input.js action table)
export const KEY_GUNNER_VIEW = 'KeyE';
const NEAR_HATCH = 0.1;
const POS_SHAKE_STATION = 0.035;

let lastController = null;

// ---------------------------------------------------------------------------
// where the OUTSIDE model puts a station's aperture (wave 7). The exterior
// (vehicles/tanks.js) draws one driver's periscope head on the hull roof and
// solid armour round every slit; a camera left behind the head or inside
// the plate sees the tank's own paint fill the window. Measured once per
// tank by casting rays at its own exterior meshes, in the station frame.
// ---------------------------------------------------------------------------
const _ray = new THREE.Raycaster();
const _ro = new THREE.Vector3();
const _rd = new THREE.Vector3();
const _rm = new THREE.Matrix3();

function exteriorMeshes(tank) {
  const list = [];
  if (!tank || !tank.group || typeof tank.group.traverse !== 'function') return list;
  tank.group.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    const m = o.material;
    if (!m || m.colorWrite === false || m.visible === false) return;
    if (o.name === 'contactShadow' || o.name === 'shadowProxy') return;
    list.push(o);
  });
  return list;
}

// first hit of a ray given in the frame node's local space; returns the
// local distance or -1
function castLocal(node, meshes, from, dir, far) {
  node.updateWorldMatrix(true, true);
  const mw = node.matrixWorld;
  _ro.fromArray(from).applyMatrix4(mw);
  _rd.fromArray(dir).applyMatrix3(_rm.setFromMatrix4(mw));
  const scale = _rd.length() || 1;
  _rd.divideScalar(scale);
  _ray.set(_ro, _rd);
  _ray.near = 0;
  _ray.far = far * scale;
  let hits = [];
  try {
    hits = _ray.intersectObjects(meshes, false);
  } catch (e) {
    hits = [];
  }
  return hits.length ? hits[0].distance / scale : -1;
}

export function stationApertures(tank, def) {
  const out = {};
  if (!tank || !def || !def.stations) return out;
  const meshes = exteriorMeshes(tank);
  if (!meshes.length) return out;
  const spec = tank.spec;
  const roof = spec.hull.trackH + spec.hull.h;
  const list = Object.entries(def.stations).map(([k, st]) => [k, st]);
  const gv = def.stations.gunner && def.stations.gunner.vision;
  if (gv) list.push(['gunner_look', gv]);
  for (const [key, st] of list) {
    const dv = st.device || {};
    const node = st.frame === 'turret' && tank.turretGroup ? tank.turretGroup : tank.group;
    const headAt = dv.type === 'periscope' && Array.isArray(dv.headAt) ? dv.headAt : null;
    if ((key === 'driver' && dv.type === 'periscope' && dv.rise !== 0 && st.frame === 'hull') || headAt) {
      // tanks.js: the driver's periscope box, centre (dx, deck + 0.04, dz),
      // or the head a station names (device.headAt [x, z] in its frame)
      const { w, len } = spec.hull;
      const t = spec.turret;
      const dz = headAt ? headAt[1] : Math.min(len * 0.5 - 0.55, t.offZ + t.len * 0.5 + 0.42);
      const dx = headAt ? headAt[0] : spec.shape && spec.shape.driverRight ? -w * 0.2 : w * 0.2;
      // its expected top: 8 cm over the deck / turret roof it stands on
      const base = headAt ? st.eye[1] + (dv.rise || 0.25) + 0.04 : roof + 0.08;
      const d = castLocal(node, meshes, [dx, base + 1.5, dz], [0, -1, 0], 2.5);
      const top = d >= 0 ? base + 1.5 - d : NaN;
      if (Number.isFinite(top) && Math.abs(top - base) < 0.3
        && Math.hypot(dx - st.eye[0], dz - st.eye[2]) < 0.75) {
        out[key] = { head: [dx, top - 0.04, dz] };
      }
    } else if (dv.type === 'slit' || (dv.type === 'periscope' && dv.rise === 0)) {
      // along the station's own forward line of sight, from outside in
      const y0 = st.look ? st.look[0] || 0 : 0;
      const f = [Math.sin(y0), 0, Math.cos(y0)];
      const R = 2.5;
      const from = [st.eye[0] + f[0] * R, st.eye[1], st.eye[2] + f[2] * R];
      const d = castLocal(node, meshes, from, [-f[0], 0, -f[2]], R);
      if (d >= 0) {
        const thick = R - d;
        // an MG ball's telescope (a periscope with rise 0) looks past the
        // ball and the barrel stub in front of it, not into them
        const extra = dv.type === 'periscope' ? 0.35 : 0.035;
        if (thick > 0.04 && thick < 1.5) out[key] = { through: thick + extra };
      }
    }
  }
  return out;
}

export function stationsFor(battle) {
  if (!battle) return null;
  if (!battle._crewStations) battle._crewStations = new TankStations(battle);
  lastController = battle._crewStations;
  return battle._crewStations;
}

function stationPref() {
  let v = globalThis.__STEEL_SKIES_STATION__;
  if (v == null) {
    try {
      const q = typeof location !== 'undefined' && location.search ? new URLSearchParams(location.search) : null;
      if (q && q.has('station')) v = q.get('station');
    } catch (e) {
      v = null;
    }
  }
  if (!v) return null;
  if (typeof v === 'string') {
    const [station, mod] = v.split(':');
    return { station, hatch: mod === 'hatch', look: mod === 'look' };
  }
  return typeof v === 'object' && v.station ? { station: String(v.station), hatch: !!v.hatch, look: !!v.look } : null;
}

export class TankStations {
  constructor(battle) {
    this.battle = battle;
    this.tank = null;
    this.def = null;
    this.layer = null;
    this.station = null; // null = third person
    this.hatch = false;
    // in the gunner's station: false = the sight (H-02 sniper view), true =
    // his look-around view (his vision device / seated in the turret)
    this.gunnerLook = false;
    this._ext = {};
    this.yaw = 0;
    this.pitch = 0;
    this.viewing = false;
    this.fov = 60;
    this._near = null;
    this._posAmp = null;
    this._bobT = 0;
    this._bob = new THREE.Vector3();
    this._pose = {
      eye: new THREE.Vector3(), aperture: new THREE.Vector3(), dir: new THREE.Vector3(),
      up: new THREE.Vector3(), view: new THREE.Matrix4(), type: 'none',
    };
    this._offset = new THREE.Vector3();
    this._tagKey = '';
    this._tag = null;
    this._touchBtn = null;
    this._crewSeen = null;
    this.layerMs = 0;
  }

  // ---- the vehicle
  attach(tank) {
    if (this.tank && this.tank.onInteriorEvent) this.tank.onInteriorEvent = null;
    if (this.layer) {
      this.layer.dispose();
      this.layer = null;
    }
    this.tank = tank || null;
    this.def = tank && tank.spec ? resolveTankInterior(tank.spec) : null;
    this.station = null;
    this.hatch = false;
    this.gunnerLook = false;
    this._crewSeen = tank && tank.crewAlive ? { ...tank.crewAlive } : null;
    this._ext = {};
    if (tank && this.def) {
      try {
        this._ext = stationApertures(tank, this.def);
      } catch (e) {
        this._ext = {};
      }
    }
    if (tank) {
      tank.onInteriorEvent = (type, a, b) => {
        if (this.layer && this.viewing) this.layer.onEvent(type, a, b);
      };
      const pref = stationPref();
      if (pref && pref.station !== 'gunner' && this.available(pref.station)) {
        this.enter(pref.station);
        this.hatch = pref.hatch && !!this.def.stations[pref.station].hatch;
      } else if (pref && pref.station === 'gunner') {
        this.enter('gunner');
        if (pref.look) this.lookAround(true);
      }
    }
  }

  available(role) {
    const st = this.def && this.def.stations[role];
    const t = this.tank;
    if (!st || !t || t.alive === false) return false;
    const a = t.crewAlive ? t.crewAlive[role] : 1;
    return !(a <= 0);
  }

  // the stations this tank offers right now, in cycle order
  stations() {
    return STATION_ORDER.filter((r) => this.available(r));
  }

  enter(role) {
    const b = this.battle;
    if (!role) return this.exit();
    if (!this.available(role)) return false;
    this.station = role;
    this.hatch = false;
    this.gunnerLook = false;
    if (role === 'gunner') {
      b.sniper = true;
      return true;
    }
    b.sniper = false;
    const st = this.def.stations[role];
    this.yaw = st.look[0] || 0;
    this.pitch = st.look[1] || 0;
    return true;
  }

  // the station definition in use (the gunner's look-around view is a
  // station of its own, stations.gunner.vision)
  current() {
    if (!this.def || !this.station) return null;
    const st = this.def.stations[this.station];
    if (this.station === 'gunner' && this.gunnerLook) return (st && st.vision) || null;
    return st || null;
  }

  // the key the layer files the active device under
  currentKey() {
    return this.station === 'gunner' && this.gunnerLook ? 'gunner_look' : this.station;
  }

  // gunner: sight <-> look-around (on = true / false; omitted = toggle)
  lookAround(on) {
    const b = this.battle;
    if (this.station !== 'gunner') return false;
    const st = this.def.stations.gunner;
    const want = on == null ? !this.gunnerLook : !!on;
    if (want && !(st && st.vision)) return false;
    this.gunnerLook = want;
    b.sniper = !want;
    if (want) {
      this.yaw = st.vision.look[0] || 0;
      this.pitch = st.vision.look[1] || 0;
    }
    return true;
  }

  exit() {
    this.station = null;
    this.hatch = false;
    this.gunnerLook = false;
    if (this.battle.sniper) this.battle.sniper = false;
    return true;
  }

  // Next station in the cycle; past the last one, back to third person.
  cycle() {
    // the gunner's sight steps on to his look-around view first
    if (this.station === 'gunner' && !this.gunnerLook && this.lookAround(true)) return true;
    const list = this.stations();
    if (!list.length) return this.exit();
    const i = this.station ? list.indexOf(this.station) : -1;
    if (i >= list.length - 1 && this.station) return this.exit();
    return this.enter(list[i + 1]);
  }

  get ownsMouse() {
    return this.viewing;
  }

  _notify(text, sev = 'warn') {
    const b = this.battle;
    if (typeof b.notify === 'function') b.notify(text, sev);
    else if (b.hud && typeof b.hud.incomingMessage === 'function') b.hud.incomingMessage(text, sev);
  }

  // ---- per frame, from the battle's player controls (alive player only)
  input(dt) {
    const b = this.battle;
    const p = b.player;
    if (p !== this.tank) this.attach(p);
    if (!p || p.alive === false) return;
    // the gunner's seat is the sniper view, whoever toggled it (Shift in
    // the look-around view goes back to the sight)
    if (b.sniper && this.station !== 'gunner') {
      this.station = 'gunner';
      this.gunnerLook = false;
    } else if (b.sniper && this.gunnerLook) this.gunnerLook = false;
    else if (!b.sniper && this.station === 'gunner' && !this.gunnerLook) this.station = null;
    if (input.pressed('KeyC')) this.cycle();
    if (input.pressed(KEY_GUNNER_VIEW) && this.station === 'gunner') this.lookAround();
    if (input.pressed('KeyX') && this.station) this.exit();
    // a crewman down: his seat is gone
    if (this.station && !this.available(this.station)) {
      const lost = this.station;
      const next = this.stations().find((r) => r !== 'gunner') || null;
      this._notify(`${STATION_LABEL[lost] || lost} knocked out — ${next ? STATION_LABEL[next] : 'third person'}`, 'warn');
      if (next) this.enter(next);
      else this.exit();
    }
    this._pollCrew();
    if (!this.station || (this.station === 'gunner' && !this.gunnerLook)) return;
    const st = this.current();
    if (!st) return;
    const hatch = this.hatch && st.hatch;
    const lim = hatch ? st.hatch.limits : st.limits;
    const sens = 0.0022 * (this.fov / 60);
    this.yaw -= input.mouseDX * sens;
    this.pitch -= input.mouseDY * sens;
    if (lim.yaw) {
      const y0 = st.look[0] || 0;
      this.yaw = y0 + clamp(wrapAngle(this.yaw - y0), lim.yaw[0], lim.yaw[1]);
    } else this.yaw = wrapAngle(this.yaw);
    this.pitch = clamp(this.pitch, lim.pitch[0], lim.pitch[1]);
    // the wheel: head up through the hatch / back down
    if (input.wheel !== 0 && st.hatch) {
      const up = input.wheel < 0;
      if (up !== this.hatch) {
        this.hatch = up;
        const l2 = up ? st.hatch.limits : st.limits;
        const y0 = st.look[0] || 0;
        if (l2.yaw) this.yaw = y0 + clamp(wrapAngle(this.yaw - y0), l2.yaw[0], l2.yaw[1]);
        this.pitch = clamp(this.pitch, l2.pitch[0], l2.pitch[1]);
      }
    }
  }

  // knocked-out crewmen as interior events (the layer's own feedback)
  _pollCrew() {
    const t = this.tank;
    if (!t || !t.crewAlive || !this._crewSeen) return;
    for (const k of Object.keys(t.crewAlive)) {
      const was = this._crewSeen[k];
      const now = t.crewAlive[k];
      if (was > 0 && now <= 0 && this.layer && this.viewing) this.layer.onEvent('crew', k);
      this._crewSeen[k] = now;
    }
  }

  // ---- the turret keeps its lay: aim from the gunner's sight, not the eye
  aimOrigin(tank, out) {
    if (tank && typeof tank.turretWorldPos === 'function') return tank.turretWorldPos(out).add(_s.set(0, 0.9, 0));
    return out.copy(this.battle.camera.position);
  }

  // ---- first thing in updateCamera: is a station view up this frame?
  beginFrame(tank) {
    const b = this.battle;
    if (tank && tank !== this.tank) this.attach(tank);
    if (b.sniper && this.station && this.station !== 'gunner') this.station = 'gunner';
    if (b.sniper && this.gunnerLook) this.gunnerLook = false;
    const v = !!(tank && tank.alive !== false && this.def && this.station
      && (this.station !== 'gunner' || this.gunnerLook) && this.current()
      && !b.sniper && !b.spectate && !b.finished);
    if (!v && this.viewing) this._leave();
    this.viewing = v;
    if (!v && this.layer) this.layer.setVisible(false);
    this._syncTag();
    return v;
  }

  _leave() {
    const cam = this.battle.camera;
    // the station view tilts camera.up with the hull: the world's again
    if (cam && cam.up) cam.up.set(0, 1, 0);
    if (cam && this._near != null) {
      cam.near = this._near;
      cam.updateProjectionMatrix();
    }
    this._near = null;
    const sh = this.battle.shake;
    if (sh && this._posAmp != null) sh.posAmp = this._posAmp;
    this._posAmp = null;
  }

  /**
   * Place the camera at the station (base pose, before shake) and draw the
   * interior around it. Returns the field of view the battle eases to.
   */
  placeCamera(camera, tank, dt) {
    const st = this.current();
    if (!st) return 60;
    const key = this.currentKey();
    const hatch = this.hatch && st.hatch;
    // the head rides the hull: a little bob with speed and pitching
    this._bobT += dt;
    const sp = tank.spec && tank.spec.maxSpeed ? Math.min(1, Math.abs(tank.speed || 0) / tank.spec.maxSpeed) : 0;
    const a = (this.def.shake ?? 1) * st.shake * (0.006 * sp + 0.004 * Math.min(1, Math.abs(tank.hullPitchRate || 0)));
    this._bob.set(Math.sin(this._bobT * 7.3) * a * 0.6, Math.sin(this._bobT * 11.1 + 0.7) * a, 0);
    const frameNode = st.frame === 'turret' && tank.turretGroup ? tank.turretGroup : tank.group;
    frameNode.updateWorldMatrix(true, false);
    const pose = stationPose(frameNode.matrixWorld, st, this.yaw, this.pitch, hatch, this._bob, this._pose, this._ext[key] || null);
    camera.position.copy(pose.aperture);
    camera.up.copy(pose.up);
    camera.lookAt(_p.copy(pose.aperture).addScaledVector(pose.dir, 100));
    // near plane and positional shake sized for a head inside a hull
    const near = hatch ? NEAR_HATCH : NEAR_STATION;
    if (this._near == null) this._near = camera.near;
    if (Math.abs(camera.near - near) > 1e-6) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    const sh = this.battle.shake;
    if (sh) {
      if (this._posAmp == null) this._posAmp = sh.posAmp;
      sh.posAmp = Math.min(this._posAmp, POS_SHAKE_STATION);
    }
    this.fov = hatch ? st.hatch.fov : st.fov;
    // level B: the interior around the eye (not with the head out of a hatch)
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    if (pose.type === 'hatch') {
      if (this.layer) this.layer.setVisible(false);
    } else {
      if (!this.layer) this.layer = new InteriorLayer(this.battle.scene, tank, this.def);
      this.layer.setVisible(true);
      this._offset.copy(pose.aperture).sub(pose.eye);
      if (typeof window !== 'undefined' && window.innerHeight) this.layer.setPixelHeight(window.innerHeight);
      const r = this.battle.renderer;
      this.layer.update(dt, {
        key, station: st, offset: this._offset, viewMatrix: pose.view,
        fov: this.fov, aspect: camera.aspect, exposure: r && Number.isFinite(r.toneMappingExposure) ? r.toneMappingExposure : 1.1,
      });
    }
    this.layerMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    return this.fov;
  }

  // ---- the little station tag and the touch button's lit state
  _syncTag() {
    // shown at every station, the gunner's sight too (its hint is the
    // look-around key)
    const sight = !this.viewing && this.station === 'gunner' && this.battle.sniper && !this.battle.spectate;
    const tid = this.tank && this.tank.spec ? this.tank.spec.id : '';
    const key = this.viewing ? `${tid}|${this.station}|${this.hatch ? 1 : 0}|${this.gunnerLook ? 1 : 0}` : sight ? `${tid}|gunner|sight` : '';
    if (key === this._tagKey) return;
    this._tagKey = key;
    // the HUD steps aside while a station view is up (markers hidden, damage
    // panel dimmed; ui/hud.js setCrewStation)
    const hud = this.battle && this.battle.hud;
    if (hud && typeof hud.setCrewStation === 'function') {
      try {
        hud.setCrewStation(this.viewing);
      } catch (e) {
        /* a stub HUD */
      }
    }
    if (typeof document === 'undefined' || !document.createElement) return;
    if (!this._tag) {
      const host = document.getElementById ? document.getElementById('app') : null;
      if (!host || !host.appendChild) return;
      const el = document.createElement('div');
      el.id = 'stationTag';
      el.className = 'hidden';
      host.appendChild(el);
      this._tag = el;
    }
    const el = this._tag;
    if (!key) {
      el.classList.add('hidden');
    } else {
      const st = sight ? this.def.stations.gunner : this.current();
      const dev = sight ? 'sight' : this.hatch && st.hatch ? 'hatch' : st.device.type;
      const hint = !sight && st.hatch ? ` · Scroll — ${this.hatch ? 'button up' : 'hatch'}` : '';
      const look = this.station === 'gunner' && this.def.stations.gunner && this.def.stations.gunner.vision
        ? `E — ${sight ? 'look around' : 'sight'} · ` : '';
      const label = this.station === 'gunner' && this.gunnerLook && st.device.type === 'none' ? 'SEAT VIEW' : DEVICE_LABEL[dev] || '';
      el.innerHTML = `<b>${STATION_LABEL[this.station] || this.station}</b><span>${label}</span>` +
        `<i>${look}C — next · X — third person${hint}</i>`;
      el.classList.remove('hidden');
    }
    try {
      if (!this._touchBtn && document.querySelector) this._touchBtn = document.querySelector('#touchUI [data-tc="crew"]');
      if (this._touchBtn && this._touchBtn.classList) this._touchBtn.classList.toggle('tcSel', !!key);
    } catch (e) {
      /* no touch layer */
    }
  }

  // what the debug console and the tests read
  state() {
    return {
      tank: this.tank ? this.tank.spec.id : null,
      source: this.def ? this.def.source : null,
      station: this.station,
      hatch: this.hatch,
      gunnerLook: this.gunnerLook,
      apertures: this._ext,
      viewing: this.viewing,
      yaw: this.yaw,
      pitch: this.pitch,
      fov: this.fov,
      offered: this.def ? this.stations() : [],
      layerMs: this.layerMs,
      layer: this.layer ? { ...this.layer.stats, visible: this.layer.root.visible } : null,
    };
  }

  dispose() {
    if (this.tank && this.tank.onInteriorEvent) this.tank.onInteriorEvent = null;
    if (this.layer) this.layer.dispose();
    this.layer = null;
    if (this._tag) this._tag.classList.add('hidden');
    const hud = this.battle && this.battle.hud;
    if (hud && typeof hud.setCrewStation === 'function') {
      try {
        hud.setCrewStation(false);
      } catch (e) {
        /* a stub HUD */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// debug console: __STEEL_SKIES_INTERIOR__ (always present; it only reads and
// drives the running battle's station controller)
//   .state()                 the controller's state
//   .enter('driver'[, true]) sit at a station (true: hatch open)
//   .cycle() / .exit()
//   .respawn('sherman76'[, 'loader'])  respawn the player in that vehicle
//                            (debug only: the old one is left as a wreck)
//   .hit('pen')              fire an interior event (hit | pen | fire)
// __STEEL_SKIES_STATION__ = 'commander' | 'commander:hatch' (or ?station=
// in the address) puts every new player tank straight into that station.
// ---------------------------------------------------------------------------
try {
  globalThis.__STEEL_SKIES_INTERIOR__ = {
    get controller() {
      return lastController;
    },
    state() {
      return lastController ? lastController.state() : null;
    },
    enter(role, hatch = false) {
      const c = lastController;
      if (!c) return false;
      if (c.battle.player !== c.tank) c.attach(c.battle.player);
      const ok = c.enter(role);
      if (ok && hatch && c.def.stations[role] && c.def.stations[role].hatch) c.hatch = true;
      return ok;
    },
    // the gunner's look-around view (true) / sight (false); omitted: toggle
    look(on) {
      const c = lastController;
      if (!c) return false;
      if (c.battle.player !== c.tank) c.attach(c.battle.player);
      if (c.station !== 'gunner') c.enter('gunner');
      return c.lookAround(on);
    },
    cycle() {
      return lastController ? lastController.cycle() : false;
    },
    exit() {
      return lastController ? lastController.exit() : false;
    },
    respawn(specId, station = null) {
      const c = lastController;
      if (!c) return false;
      const b = c.battle;
      if (b.player && b.player.alive !== false && typeof b.player.destroy === 'function') b.player.destroy(false);
      if (station) globalThis.__STEEL_SKIES_STATION__ = station;
      if (b.playerIsPlane !== undefined) b.playerRespawn(/^(zero|spitfire|fw190|bf109g6|il2|p51|yak3)$/.test(specId) ? 'air' : 'tank', specId);
      else b.playerRespawn(specId);
      return true;
    },
    hit(type = 'pen') {
      const c = lastController;
      const t = c && c.tank;
      if (!t || !c.layer) return false;
      const p = t.position.clone().add(new THREE.Vector3(0, 1.4, 0));
      c.layer.onEvent(type, type === 'pen' ? p : 1, new THREE.Vector3(Math.sin(t.yaw), 0, Math.cos(t.yaw)).negate());
      return true;
    },
  };
} catch (e) {
  /* frozen global */
}
