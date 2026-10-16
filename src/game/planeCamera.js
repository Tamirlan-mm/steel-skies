import * as THREE from 'three';
import { groundHeightAt } from '../world/airfield.js';
import { clamp, wrapAngle } from '../core/utils.js';

// The aircraft camera: chase, aim zoom along the nose, and the two death cams.
// One controller for every battle that flies aeroplanes, so the air battle and
// the combined battle cannot drift apart again.
//
// WHY IT EXISTS. The old cameras lived inline in each battle and had four
// separate ways of jerking:
//   - the keyboard "follow the nose" moved the view at a CONSTANT rate
//     (angleToward), so its angular velocity jumped from zero to 170 deg/s in
//     one frame when it engaged and back to zero when it caught up (measured:
//     94 deg/s of angular-velocity step in a single frame);
//   - the mouse aim went straight into the view, so a 1000 Hz mouse sampled
//     at 60 or 144 Hz arrived as an integer count that alternated 15/16 or 6/7
//     per frame — a sawtooth in the turn rate, every frame (12-19 deg/s);
//   - the aim zoom was welded to the nose, so every twitch of the instructor
//     was a full-screen twitch at 22 degrees of field of view;
//   - the terrain clamp was a hard max(), a kink in the camera's path.
// And the death cams lerped from wherever the camera was, which included last
// frame's shake offset.
//
// HOW IT IS BUILT.
//   - Position is RIGID on the aircraft: the eye is the aeroplane's position
//     plus an offset computed from smoothed angles only. At 150 m/s anything
//     that smooths position smears the aeroplane across the screen; this
//     cannot, because the aeroplane's screen position depends on nothing but
//     the angles.
//   - Rotation is a critically damped spring, integrated EXACTLY for a target
//     that moves linearly through the frame (which is what a mouse sweep or a
//     turning nose is). That makes it frame-rate independent in the strong
//     sense: the same motion at 30, 60 or 144 Hz and straight through a 50 ms
//     hitch, with no lag-and-catch-up on the long frame. The spring is stiff
//     (a 36 ms time constant on the mouse): enough to iron out the count
//     sawtooth, not enough to feel like the view is behind the hand.
//   - The base pose is recomputed from this controller's own state every
//     frame and only then shaken, so shake can never accumulate.
//   - Nothing in the per-frame path allocates: vectors are module scratch and
//     the spring state is a Float64Array.

// The keyboard nose-follow. A plain spring (lead 0) trails a steady turn by
// 2u/w: at w = 7 that was 18 degrees behind a 60 deg/s keyboard turn, three
// times the lag of the constant-rate follow it replaced, and on letting go the
// instructor flew the nose back toward an aim that far behind it. Leading the
// spring with most of the nose's own rate (see springRamp) takes the steady lag
// down to 2u(1 - lead)/w — about 3 degrees — without making it stiffer.
//
// What is left is the transient when a key goes down: the nose's turn rate
// steps by up to 85 deg/s in a single frame (the stick is a rate command), and
// any view that does not pass that step on as a jerk has to fall behind while
// it catches up. How far is set by how hard it may accelerate — at 9 deg/s of
// turn-rate change per 60 Hz frame the floor is about 6.5 degrees — and these
// two numbers sit at that floor (measured: 6-7 degrees p99 behind the nose in a
// keyboard turn, turn-rate change at most about 9 deg/s per frame). More lead
// or more stiffness buys lag with jerk; less lead puts the steady lag back and
// leaves the aim behind the nose at the moment the keys are released.
const FOLLOW_W = 8;
const FOLLOW_LEAD = 0.8;

const SPRING = {
  aim: 55, // view following the raw mouse aim, rad/s (lag in a steady sweep 2/w = 36 ms)
  follow: FOLLOW_W, // keyboard nose-follow pulling the aim round, at full strength
  followLead: FOLLOW_LEAD, // share of the nose's own rate the follow leads with
  coast: 9, // how fast a released nose-follow bleeds its swing off, 1/s
  zoom: 20, // aim zoom following the nose
  fov: 9.2, // field of view, exponential (1 - 0.0001^dt, as it always was)
  death: 6.9, // death cam position, exponential (1 - 0.001^dt, as it always was)
};
// A raw aim that jumps further than this in one frame was SET (a respawn, the
// aim zoom snapping to the nose), not swept: it is followed as a step, without
// inventing the angular velocity a sweep that fast would have had.
const AIM_STEP = 0.6;
const MAX_AIM_RATE = 25; // rad/s; anything faster is a set, not a sweep

// The keyboard nose-follow near the VERTICAL. The follow chases the nose as a
// yaw and a pitch, and straight up (or down) the nose has no yaw: at 89
// degrees a one-degree drift sideways is 60 degrees of yaw, and passing the
// vertical — the top of a loop, the bottom of a split-S — turns it round by
// 180 degrees in a single frame. Fed to the spring as a rate, that flip was a
// lead of 0.8 × pi/dt: the view whipped round at 1250 deg/s with a 640 deg/s
// change of turn rate in one frame, overshot the new heading by 80 degrees,
// and left the aim (where the instructor flies when the key comes up)
// pointing off to one side.
//
// A world-up camera that cannot look past the vertical HAS to turn round
// half a turn somewhere over the top; the only question is how. Weakening the
// spring near the vertical was tried first and only moved the whip: the half
// turn was still owed when the nose came back out of the band, and a full-
// strength spring then paid it off at 400+ deg/s. So the yaw that cannot be
// trusted as a rate is taken OUT of the spring's target and handed to a swing
// of its own:
//   - all of a jump (further than AIM_STEP or faster than MAX_AIM_RATE in one
//     frame, the same test as the raw aim's), and
//   - above the follow's pitch clamp, most of the ordinary yaw motion too. A
//     yaw rate r moves the nose sideways at r cos(nose pitch), but the view,
//     held at the clamp, at r cos(clamp) and — the part that is felt — turns
//     the whole picture at r, mostly as roll. Only the share k = cos(nose
//     pitch) / cos(clamp) of r is the nose's own sideways motion, and the
//     follow keeps k squared of it: all of it at or below the clamp (72
//     degrees, where nothing changes), 31% at 80 degrees, none at the
//     vertical; past 84 degrees that turns the picture no faster than the
//     nose itself moves. (k alone was tried: a nose passing a few degrees
//     beside the vertical, which sweeps its yaw round in a few frames without
//     ever "jumping", still rolled the view at 16 deg/s of change per frame.)
// What is handed over becomes an offset between the nose's yaw and the yaw the
// spring chases, so the target itself never moves discontinuously; the offset
// then runs down to zero as a critically damped triple pole (tripleDecay).
// Started from rest that is an S-curve whose rate AND acceleration both start
// at zero: half a turn takes about 1.3 s, peaking near 200 deg/s with the turn
// rate changing by about 10 deg/s per 60 Hz frame — a deliberate look round,
// not a whip, and the same at any frame rate. That is as quick as it can be
// within that budget, so a fighter that comes down the back of a loop fast
// (Zero, Spitfire) is seen from 45-50 degrees off its tail for half a second
// while the view comes round; the alternative is the whip.
const SWING_W = 4; // rad/s, the swing's triple pole
const SWING_LOOK = 2 / SWING_W; // s, how far ahead the swing judges "which way round"
// the steepest pitch the nose-follow chases (as it always was: asin 0.95),
// and the cosine of it
const FOLLOW_PITCH_MAX = Math.asin(0.95);
const FOLLOW_PITCH_MAX_COS = Math.cos(FOLLOW_PITCH_MAX);
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// A-02 cockpit view. The eye sits in the pilot's head, rigid on the airframe:
// no spring, no head inertia (0 deg under any g, inside the backlog's 0.5 deg
// budget), looking straight along the nose with the aeroplane's own up, so the
// horizon banks with the wings. The near plane drops to COCKPIT_NEAR in this
// mode only, so the canopy frame 0.3 m from the eye is not clipped; at
// 0.1 / 4000 the 24-bit depth step is about 0.6 m at 1 km.
// ---------------------------------------------------------------------------
export const COCKPIT_NEAR = 0.1;
// eye above and ahead of the canopy station planes.js builds the pilot at:
// his head sphere sits at canopy.y + 0.13, canopy.z - 0.09 (radius 0.125),
// and the eyes are at the front of the face, just OUTSIDE that sphere
// (0.143 m from its centre), never inside the head. Measured for all five
// aircraft (instruments-fix t_eye.mjs): the nearest own-aircraft geometry
// inside the 60 deg cockpit frustum is >= 0.156 m away (Fw 190 canopy
// frame), so COCKPIT_NEAR = 0.1 cannot clip it, and the backlog's 0.05 would
// only halve the depth precision for nothing.
const EYE_UP = 0.16;
const EYE_FWD = 0.05;

// The pilot's eye in the aircraft's body frame (+Z nose, +Y up, +X left).
// planes.js keeps the canopy station in its private layout, so the station is
// derived the way its canopySections() derives it: the spec's own canopy
// shape, else the default glasshouse by engine type. (The old namespace probe
// for a planeEyePoint export that never existed only made every build warn.)
export function cockpitEyeLocal(spec, out = new THREE.Vector3()) {
  const shape = (spec && spec.shape) || {};
  const look = (spec && spec.look) || {};
  let cy;
  let cz;
  if (shape.canopy && shape.canopy.glass) {
    cy = shape.canopy.y != null ? shape.canopy.y : 0.5;
    cz = shape.canopy.z != null ? shape.canopy.z : 0;
  } else {
    const len = (spec && spec.len) || 9;
    cz = look.engine === 'radial' ? len * 0.06 : len * 0.04;
    cy = look.armoured ? 0.62 : 0.5;
  }
  return out.set(0, cy + EYE_UP, cz + EYE_FWD);
}

// Collimated at infinity: the point is taken along the boresight FROM THE
// EYE, so it projects to the same pixel at any distance; 1 km keeps it well
// inside the battle cameras' 4 km far plane (beyond it a projection reports
// z > 1 and reads as behind the camera).
const GUN_LINE_DIST = 1000;

const UP = new THREE.Vector3(0, 1, 0);
const tmpEyeLocal = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpCamUp = new THREE.Vector3();
const tmpAim = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpPlaneUp = new THREE.Vector3();

// spring state slots in PlaneCamera.s
const S_YAW = 0; // view yaw, unwrapped
const S_YAW_V = 1;
const S_PITCH = 2;
const S_PITCH_V = 3;
const S_FOLLOW_YAW_V = 4; // the raw aim's own velocity while following the nose
const S_FOLLOW_PITCH_V = 5;
const S_ZX = 6; // zoom view direction, x y z and their velocities
const S_ZY = 7;
const S_ZZ = 8;
const S_ZXV = 9;
const S_ZYV = 10;
const S_ZZV = 11;
const S_PREV_YAW = 12; // the raw aim and the nose at the previous update
const S_PREV_PITCH = 13;
const S_PREV_NX = 14;
const S_PREV_NY = 15;
const S_PREV_NZ = 16;
const S_FPREV_YAW = 17; // the nose at the previous followNose() call (NaN: none)
const S_FPREV_PITCH = 18;
const S_SWING = 19; // nose yaw minus the yaw the follow chases (see SWING_W),
const S_SWING_V = 20; // with its rate and acceleration: tripleDecay() wants
const S_SWING_A = 21; // the three in consecutive slots
const S_HOLD = 22; // how far the follow's pitch target is held up by the swing
const S_COUNT = 23;

// One exact step of the critically damped spring
//   x'' = w^2 (T - x) + 2w (lead * u - x')
// for a target that moves linearly from t0 to t1 across the step (u is that
// rate), in place on two slots of `s` (position at i, velocity at j). With
// e = x - T the motion is e = e_ss + (A + Bt) exp(-wt), e_ss = -2u(1 - lead)/w;
// closed form, so two steps of h land exactly where one step of 2h does,
// whatever h is.
//
// `lead` is how much of the target's own velocity the damping is measured
// against. At 0 (the plain spring) the damping drags against absolute motion,
// so a target moving at a steady rate is trailed by a steady 2u/w — fine for
// the 36 ms mouse spring, where that is a couple of degrees. At 1 the damping
// acts on the velocity RELATIVE to the target, and a steady rate is tracked
// with no lag at all. Either way the follower's velocity is a state, so it
// never steps: what the lead changes is only where the spring settles.
function springRamp(s, i, j, t0, t1, omega, dt, lead = 0) {
  if (!(dt > 0)) return;
  const u = (t1 - t0) / dt;
  const ess = (-2 * u * (1 - lead)) / omega;
  const a = s[i] - t0 - ess;
  const b = s[j] - u + omega * a;
  const ex = Math.exp(-omega * dt);
  const ab = a + b * dt;
  s[i] = t1 + ess + ab * ex;
  s[j] = u + (b - omega * ab) * ex;
}

// One exact step of a critically damped TRIPLE pole running down to zero,
//   (d/dt + w)^3 x = 0,   x = (c0 + c1 t + c2 t^2) exp(-wt),
// in place on three consecutive slots of `s` (position, rate, acceleration).
// Given a sudden offset x0 from rest, the rate and the acceleration both start
// at zero; the acceleration peaks at 0.23 x0 w^2, the rate at 0.27 x0 w, and
// it is 90% of the way home at t = 5.3/w. A jump added to the position while
// it runs leaves the rate and acceleration alone, so nothing it drives ever
// steps. Closed form, so frame-rate independent like springRamp.
function tripleDecay(s, i, w, dt) {
  const p = s[i];
  const v = s[i + 1];
  const a = s[i + 2];
  if (p === 0 && v === 0 && a === 0) return;
  const c1 = v + w * p;
  const c2 = (a + 2 * w * c1 - w * w * p) * 0.5;
  const q = p + (c1 + c2 * dt) * dt; // x exp(wt) and its derivatives at dt
  const q1 = c1 + 2 * c2 * dt;
  const ex = Math.exp(-w * dt);
  s[i] = q * ex;
  s[i + 1] = (q1 - w * q) * ex;
  s[i + 2] = (2 * c2 - 2 * w * q1 + w * w * q) * ex;
  // settle to an exact zero (micro-radians), so a finished swing costs nothing
  if (Math.abs(s[i]) < 1e-6 && Math.abs(s[i + 1]) < 1e-5 && Math.abs(s[i + 2]) < 1e-4) {
    s[i] = 0;
    s[i + 1] = 0;
    s[i + 2] = 0;
  }
}

// C1-continuous max: equal to max(a, b) away from the crossover, rounded over
// a band of `k` metres around it, so a clamp engaging is a curve, not a kink.
function smoothMax(a, b, k) {
  const d = a - b;
  return (a + b + Math.sqrt(d * d + k * k)) * 0.5;
}

export class PlaneCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera  the battle's camera; this writes
   *        its position, quaternion, up and fov every update().
   * @param {object} [opts]
   *   fov       {number} chase field of view, degrees (60)
   *   zoomFov   {number} aim-zoom field of view, degrees (22)
   *   height    {number} chase eye height above the aircraft, m (3.5)
   *   lookAhead {number} chase look point ahead of the aircraft, m (80)
   *   clearance {number} the eye never goes below the ground + this, m (2)
   *   minPitch / maxPitch {number} raw aim pitch limits, rad (-1.35 / 1.35)
   */
  constructor(camera, opts = {}) {
    this.camera = camera;
    this.fovChase = opts.fov != null ? opts.fov : 60;
    this.fovZoom = opts.zoomFov != null ? opts.zoomFov : 22;
    this.height = opts.height != null ? opts.height : 3.5;
    this.lookAhead = opts.lookAhead != null ? opts.lookAhead : 80;
    this.clearance = opts.clearance != null ? opts.clearance : 2;
    this.minPitch = opts.minPitch != null ? opts.minPitch : -1.35;
    this.maxPitch = opts.maxPitch != null ? opts.maxPitch : 1.35;
    // The RAW aim: where the mouse says to look, and where the instructor is
    // told to fly. Integrated by the battle (or addMouse()); smoothed here.
    this.yaw = 0;
    this.pitch = 0;
    this.s = new Float64Array(S_COUNT);
    this.fov = this.fovChase;
    // the death cams' own eye, so they ease from where the view WAS rather
    // than from wherever last frame's shake left the camera
    this.deathEye = new THREE.Vector3();
    this.deathAngle = 0;
    this.mode = 'none';
    // the chase view's near plane, restored when the cockpit view is left
    this.nearChase = camera && camera.near > 0 ? camera.near : 0.3;
    this._cockpitYaw = 0;
  }

  // Mouse counts into the raw aim, measured on the SCREEN: a count to the
  // right turns the aim toward screen-right whatever the camera's roll. The
  // cockpit view banks with the wings, so there addMouse()'s world yaw and
  // pitch would send a sideways sweep up the screen in a 90 degree bank.
  // With a level camera (the chase view) this is addMouse() to rounding.
  addMouseScreen(dx, dy, sens) {
    if (!dx && !dy) return;
    const q = this.camera ? this.camera.quaternion : null;
    if (!q) {
      this.addMouse(dx, dy, sens);
      return;
    }
    tmpCamUp.set(0, 1, 0).applyQuaternion(q);
    tmpRight.set(1, 0, 0).applyQuaternion(q);
    const d = this.aimDirection(tmpAim);
    if (dx) d.applyAxisAngle(tmpCamUp, -dx * sens);
    if (dy) d.applyAxisAngle(tmpRight, -dy * sens);
    d.normalize();
    this.yaw = wrapAngle(Math.atan2(d.x, d.z));
    this.pitch = clamp(Math.asin(clamp(d.y, -1, 1)), this.minPitch, this.maxPitch);
  }

  // H-03 / A-02: a world point on the gun line at infinity, as seen from the
  // eye. Project it through the camera AFTER update() — shake included — and
  // the reflector graticule drawn there cannot leave the guns.
  gunLineWorldPoint(plane, out = new THREE.Vector3(), dist = GUN_LINE_DIST) {
    const from = this.camera ? this.camera.position : plane.position;
    return out.copy(plane.dir).multiplyScalar(dist).add(from);
  }

  // The pilot's eye in the world, rigid on the airframe.
  cockpitEye(plane, out = new THREE.Vector3()) {
    cockpitEyeLocal(plane.spec, out);
    if (plane.quat) out.applyQuaternion(plane.quat);
    return out.add(plane.position);
  }

  _setNear(n) {
    const cam = this.camera;
    if (cam && Math.abs(cam.near - n) > 1e-6) {
      cam.near = n;
      cam.updateProjectionMatrix();
    }
  }

  // Snap everything to the aircraft's nose: spawn, respawn, a camera cut.
  reset(plane) {
    if (plane && plane.dir) {
      this.yaw = Math.atan2(plane.dir.x, plane.dir.z);
      this.pitch = clamp(Math.asin(clamp(plane.dir.y, -0.95, 0.95)), this.minPitch, this.maxPitch);
    }
    const s = this.s;
    s.fill(0);
    s[S_FPREV_YAW] = NaN;
    s[S_FPREV_PITCH] = NaN;
    s[S_YAW] = this.yaw;
    s[S_PITCH] = this.pitch;
    s[S_PREV_YAW] = this.yaw;
    s[S_PREV_PITCH] = this.pitch;
    if (plane && plane.dir) {
      s[S_ZX] = s[S_PREV_NX] = plane.dir.x;
      s[S_ZY] = s[S_PREV_NY] = plane.dir.y;
      s[S_ZZ] = s[S_PREV_NZ] = plane.dir.z;
    }
    this.fov = this.fovChase;
    this.mode = 'none';
  }

  // Mouse counts into the raw aim. `sens` is radians per count.
  addMouse(dx, dy, sens) {
    if (dx) this.yaw = wrapAngle(this.yaw - dx * sens);
    if (dy) this.pitch = clamp(this.pitch - dy * sens, this.minPitch, this.maxPitch);
  }

  // Look along the nose right now (entering the aim zoom does this).
  aimAlongNose(plane) {
    this.yaw = Math.atan2(plane.dir.x, plane.dir.z);
    this.pitch = clamp(Math.asin(clamp(plane.dir.y, -0.95, 0.95)), this.minPitch, this.maxPitch);
  }

  // Keyboard flying: pull the raw aim round onto the nose with a spring that
  // tracks the nose's own motion, so the view settles behind the aircraft
  // without ever stepping. `strength` is 0..1 (1 while keys are held, easing
  // off after); at 0 the swing the aim already has bleeds away instead of
  // stopping dead, so letting go of a key is as smooth as pressing it.
  followNose(dt, plane, strength) {
    const s = this.s;
    if (!(dt > 0) || !plane) return;
    if (!(strength > 0.001)) {
      s[S_FPREV_YAW] = NaN;
      s[S_FPREV_PITCH] = NaN;
      // a swing still under way belongs to the follow that let go: what the
      // aim keeps is the motion it already has, which coasts off below
      s[S_SWING] = 0;
      s[S_SWING_V] = 0;
      s[S_SWING_A] = 0;
      s[S_HOLD] = 0;
      const decay = Math.exp(-SPRING.coast * dt);
      const vy = s[S_FOLLOW_YAW_V];
      const vp = s[S_FOLLOW_PITCH_V];
      if (vy === 0 && vp === 0) return;
      // coast: integrate the decaying velocity exactly over the step
      const f = (1 - decay) / SPRING.coast;
      this.yaw = wrapAngle(this.yaw + vy * f);
      this.pitch = clamp(this.pitch + vp * f, this.minPitch, this.maxPitch);
      s[S_FOLLOW_YAW_V] = Math.abs(vy * decay) < 1e-5 ? 0 : vy * decay;
      s[S_FOLLOW_PITCH_V] = Math.abs(vp * decay) < 1e-5 ? 0 : vp * decay;
      return;
    }
    const omega = SPRING.follow * clamp(strength, 0, 1);
    const nose = plane.dir;
    const ty = Math.atan2(nose.x, nose.z);
    // The nose is the target and it is moving: its motion over the last frame
    // is the target velocity through this one (smooth physics, so one frame
    // of history is plenty).
    const ty0 = Number.isNaN(s[S_FPREV_YAW]) ? ty : s[S_FPREV_YAW];
    s[S_FPREV_YAW] = ty;
    // The yaw the spring chases is the nose's yaw less the swing still owed
    // (see SWING_W). This frame's nose yaw change splits in two: what can be
    // trusted as a rate stays in the target, the rest — a jump, or the share
    // above the pitch clamp — joins the swing, so the target does not move by it.
    const dny = wrapAngle(ty - ty0);
    let handed = 0;
    if (Math.abs(dny) > AIM_STEP || Math.abs(dny) > MAX_AIM_RATE * dt) handed = dny;
    else if (nose.y > 0.95 || nose.y < -0.95) {
      const share = Math.min(1, Math.sqrt(nose.x * nose.x + nose.z * nose.z) / FOLLOW_PITCH_MAX_COS);
      handed = dny * (1 - share * share);
    }
    // the target and its own motion this frame: off the vertical, with no
    // swing under way, exactly the nose's (and this whole block is skipped,
    // so the follow there is the same arithmetic it always was)
    let target = ty;
    let dtarget = dny;
    if (handed !== 0 || s[S_SWING] !== 0 || s[S_SWING_V] !== 0 || s[S_SWING_A] !== 0) {
      const swing0 = s[S_SWING];
      tripleDecay(s, S_SWING, SWING_W, dt);
      const swing1 = s[S_SWING] + handed;
      // the trusted part of the nose's motion, plus however far the swing ran
      dtarget = dny - handed - (s[S_SWING] - swing0);
      // Which way round: an offset and the same offset a whole turn away are
      // the same target (the unwrap below absorbs the turn), so the swing is
      // free to pick. It takes the one that keeps where it is heading — the
      // offset projected SWING_LOOK ahead at its present rate — within half a
      // turn. At rest that is the shorter way; mid-swing, a second flip (the
      // bottom of a loop that came over the top a moment ago) carries on
      // round the way the view is already turning instead of stopping it
      // dead and throwing it back, and two flips of a nose hanging at the
      // vertical still cancel instead of queuing a full turn. (Written out
      // rather than wrapAngle(): one more call tips followNose over the
      // optimiser's inlining budget, and a helper left un-inlined returns its
      // number boxed — 32 bytes of garbage a frame.)
      const ahead = swing1 + s[S_SWING_V] * SWING_LOOK;
      s[S_SWING] = swing1 - TWO_PI * Math.round(ahead / TWO_PI);
      target = ty - s[S_SWING];
    }
    // yaw on an unwrapped line through the aim
    const ty1u = this.yaw + wrapAngle(target - this.yaw);
    const ty0u = ty1u - dtarget;
    const tmp = this._followScratch || (this._followScratch = new Float64Array(2));
    tmp[0] = this.yaw;
    tmp[1] = s[S_FOLLOW_YAW_V];
    springRamp(tmp, 0, 1, ty0u, ty1u, omega, dt, SPRING.followLead);
    this.yaw = wrapAngle(tmp[0]);
    s[S_FOLLOW_YAW_V] = tmp[1];
    // The pitch it chases is the nose's — held up toward the vertical while
    // the yaw is still swinging round, by the share (1 - cos swing)/2: all
    // the way up with half a turn owed, not at all once it is paid. Otherwise
    // the view would tip down the far side of a loop while still facing the
    // near side, 60 degrees off the nose. A smooth share and not the exact
    // geometry (the nose's elevation in the plane of the yaw being chased):
    // that stays pinned to the clamp and then drops off it at 160 deg/s near
    // the end of the swing, a jolt of its own. Continuous through the
    // vertical, where the nose's pitch is at the clamp either way, and
    // through the horizon: the pole it is held toward is the one on the
    // nose's side, faded out over the 30 degrees either side of level (a nose
    // still swinging as it crosses level would otherwise flip it, a step of
    // a few degrees in the pitch target).
    const tpn = Math.asin(clamp(nose.y, -0.95, 0.95));
    let tp = clamp(tpn, this.minPitch, this.maxPitch);
    s[S_HOLD] = 0;
    if (s[S_SWING] !== 0) {
      const hold = (1 - Math.cos(s[S_SWING])) * 0.5;
      const pole = FOLLOW_PITCH_MAX * Math.min(Math.max(nose.y * 2, -1), 1);
      const held = tpn + (pole - tpn) * hold;
      const tph = Math.min(Math.max(held, this.minPitch), this.maxPitch);
      s[S_HOLD] = tph - tp;
      tp = tph;
    }
    const tp0 = Number.isNaN(s[S_FPREV_PITCH]) ? tp : s[S_FPREV_PITCH];
    s[S_FPREV_PITCH] = tp;
    tmp[0] = this.pitch;
    tmp[1] = s[S_FOLLOW_PITCH_V];
    springRamp(tmp, 0, 1, tp0, tp, omega, dt, SPRING.followLead);
    this.pitch = clamp(tmp[0], this.minPitch, this.maxPitch);
    s[S_FOLLOW_PITCH_V] = tmp[1];
  }

  // The smoothed view direction (unit vector) — where the chase camera looks.
  viewDirection(out) {
    const s = this.s;
    const cp = Math.cos(s[S_PITCH]);
    return out.set(Math.sin(s[S_YAW]) * cp, Math.sin(s[S_PITCH]), Math.cos(s[S_YAW]) * cp);
  }

  // The RAW aim direction (unit vector) — where the mouse points.
  aimDirection(out) {
    const cp = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  // A world point `dist` metres out along the raw aim from the aircraft: the
  // steer point for plane.steerTowards().
  aimPoint(plane, dist, out) {
    return this.aimDirection(out).multiplyScalar(dist).add(plane.position);
  }

  // The steer point for the instructor while the keyboard nose-follow is
  // easing off (the grace after a key comes up): the raw aim less whatever
  // part of it is only the view coming round over the vertical (the swing
  // still owed, and the pitch it holds up). Mid-swing the raw aim can be 45
  // degrees off the nose — passing through, not going there — and letting go
  // of the key must not send the aeroplane after it. With no swing under way
  // (every manoeuvre that stays off the vertical) this IS aimPoint(), to the
  // bit; as the swing runs out the two converge. Not for mouse flying: the
  // mouse drops the follow, and the swing with it.
  steerPoint(plane, dist, out) {
    const s = this.s;
    const yaw = this.yaw + s[S_SWING];
    const pitch = clamp(this.pitch - s[S_HOLD], this.minPitch, this.maxPitch);
    const cp = Math.cos(pitch);
    return out.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp).multiplyScalar(dist).add(plane.position);
  }

  // The yaw the view is actually looking along (smoothed), for compasses,
  // minimap cones and directional damage arcs.
  get viewYaw() {
    if (this.mode === 'cockpit') return this._cockpitYaw;
    return wrapAngle(this.s[S_YAW]);
  }

  /**
   * Place the camera. Call once per frame, AFTER the physics step and after
   * the aircraft's visual transform has been written (plane.update() does
   * both), and before anything reads the camera (HUD projection, audio).
   *
   * @param {number} dt  frame time, s
   * @param {object} st
   *   plane   {Plane}       the aircraft being watched (alive, falling or dead)
   *   zoom    {boolean}     aim zoom (RMB): look along the nose, narrow fov
   *   dead    {boolean}     the aircraft is gone (falling or dead): wreck cam
   *   killer  {object|null} with dead: orbit him instead of the wreck
   *   dist    {number}      chase distance, m (the battle's mouse-wheel dolly)
   *   shake   {CameraShake|null} applied last, to this frame's pose only
   *   cockpit {boolean}     A-02 cockpit view: the pilot's eye, rigid on the
   *                         airframe (zoom then only narrows the field)
   */
  update(dt, st) {
    const cam = this.camera;
    const plane = st.plane;
    if (!cam || !plane) return;
    if (!(dt > 0)) dt = 1e-6;
    const s = this.s;

    // ---- the view angles chase the raw aim ----
    let dy = wrapAngle(this.yaw - s[S_PREV_YAW]);
    let dp = this.pitch - s[S_PREV_PITCH];
    if (Math.abs(dy) > AIM_STEP || Math.abs(dy) > MAX_AIM_RATE * dt) dy = 0;
    if (Math.abs(dp) > AIM_STEP || Math.abs(dp) > MAX_AIM_RATE * dt) dp = 0;
    const ty1 = s[S_YAW] + wrapAngle(this.yaw - s[S_YAW]);
    springRamp(s, S_YAW, S_YAW_V, ty1 - dy, ty1, SPRING.aim, dt);
    springRamp(s, S_PITCH, S_PITCH_V, this.pitch - dp, this.pitch, SPRING.aim, dt);
    s[S_PREV_YAW] = this.yaw;
    s[S_PREV_PITCH] = this.pitch;
    // keep the unwrapped yaw from growing without bound
    if (s[S_YAW] > Math.PI * 4 || s[S_YAW] < -Math.PI * 4) s[S_YAW] = wrapAngle(s[S_YAW]);

    const pos = plane.position;
    const nose = plane.dir;
    const dir = this.viewDirection(tmpDir);
    let fovTarget = this.fovChase;
    const dead = !!st.dead || plane.alive === false;
    const cockpit = !dead && !!st.cockpit;
    this._setNear(cockpit ? COCKPIT_NEAR : this.nearChase);

    if (cockpit) {
      // ---- cockpit (A-02): the pilot's eye, rigid on the airframe ----
      // No smoothing of any kind: the reflector sight is part of this
      // airframe, and the view is the airframe's own attitude.
      this.mode = 'cockpit';
      if (st.zoom) fovTarget = this.fovZoom;
      this.cockpitEye(plane, tmpEye);
      tmpPlaneUp.set(0, 1, 0);
      if (plane.quat) tmpPlaneUp.applyQuaternion(plane.quat);
      cam.position.copy(tmpEye);
      cam.up.copy(tmpPlaneUp);
      cam.lookAt(tmpTarget.copy(tmpEye).addScaledVector(nose, 300));
      this._cockpitYaw = Math.atan2(nose.x, nose.z);
      // the zoom spring starts from the nose whenever the cockpit is left
      s[S_ZX] = nose.x;
      s[S_ZY] = nose.y;
      s[S_ZZ] = nose.z;
      s[S_ZXV] = 0;
      s[S_ZYV] = 0;
      s[S_ZZV] = 0;
    } else if (dead) {
      // ---- death cams: ease the eye, look at the subject ----
      if (this.mode !== 'dead') {
        this.mode = 'dead';
        this.deathEye.copy(cam.position);
        this.deathAngle = Math.atan2(-dir.x, -dir.z);
      }
      const k = 1 - Math.exp(-SPRING.death * dt);
      if (st.killer && st.killer.position) {
        const kp = st.killer.position;
        this.deathAngle += 0.25 * dt;
        tmpEye.set(kp.x + Math.sin(this.deathAngle) * 26, kp.y + 8, kp.z + Math.cos(this.deathAngle) * 26);
        tmpEye.y = Math.max(tmpEye.y, groundHeightAt(tmpEye.x, tmpEye.z) + this.clearance);
        this.deathEye.lerp(tmpEye, k);
        tmpTarget.copy(kp);
      } else {
        tmpEye.set(pos.x - dir.x * 30, pos.y + 14, pos.z - dir.z * 30);
        tmpEye.y = Math.max(tmpEye.y, groundHeightAt(tmpEye.x, tmpEye.z) + 3);
        this.deathEye.lerp(tmpEye, k);
        tmpTarget.copy(pos);
      }
      cam.position.copy(this.deathEye);
      cam.up.copy(UP);
      cam.lookAt(tmpTarget);
    } else if (st.zoom) {
      // ---- aim zoom: along the nose, with the nose's twitches filtered ----
      if (this.mode !== 'zoom') {
        this.mode = 'zoom';
        s[S_ZX] = s[S_PREV_NX] = nose.x;
        s[S_ZY] = s[S_PREV_NY] = nose.y;
        s[S_ZZ] = s[S_PREV_NZ] = nose.z;
        s[S_ZXV] = 0;
        s[S_ZYV] = 0;
        s[S_ZZV] = 0;
      }
      fovTarget = this.fovZoom;
      springRamp(s, S_ZX, S_ZXV, s[S_PREV_NX], nose.x, SPRING.zoom, dt);
      springRamp(s, S_ZY, S_ZYV, s[S_PREV_NY], nose.y, SPRING.zoom, dt);
      springRamp(s, S_ZZ, S_ZZV, s[S_PREV_NZ], nose.z, SPRING.zoom, dt);
      const zd = tmpTarget.set(s[S_ZX], s[S_ZY], s[S_ZZ]);
      if (zd.lengthSq() < 1e-8) zd.copy(nose);
      zd.normalize();
      // rigid on the aircraft: a metre above and four ahead of its origin
      tmpEye.copy(pos).addScaledVector(UP, 1.2).addScaledVector(nose, 4);
      // world up keeps the horizon level; near the vertical it has no meaning,
      // so the aircraft's own up takes over smoothly
      tmpPlaneUp.set(0, 1, 0).applyQuaternion(plane.quat);
      const w = clamp((Math.abs(zd.y) - 0.86) / 0.12, 0, 1);
      tmpUp.copy(UP).multiplyScalar(1 - w).addScaledVector(tmpPlaneUp, w);
      if (tmpUp.lengthSq() < 1e-6) tmpUp.copy(tmpPlaneUp);
      cam.position.copy(tmpEye);
      cam.up.copy(tmpUp.normalize());
      cam.lookAt(tmpEye.addScaledVector(zd, 300));
    } else {
      // ---- chase: rigid on the aircraft, angles smoothed ----
      this.mode = 'chase';
      const d = st.dist > 0 ? st.dist : 20;
      tmpEye.copy(pos).addScaledVector(dir, -d);
      tmpEye.y += this.height;
      const ground = groundHeightAt(tmpEye.x, tmpEye.z) + this.clearance;
      tmpEye.y = smoothMax(tmpEye.y, ground, 1.5);
      cam.position.copy(tmpEye);
      cam.up.copy(UP);
      cam.lookAt(tmpTarget.copy(pos).addScaledVector(dir, this.lookAhead));
    }
    s[S_PREV_NX] = nose.x;
    s[S_PREV_NY] = nose.y;
    s[S_PREV_NZ] = nose.z;

    // ---- field of view ----
    this.fov += (fovTarget - this.fov) * (1 - Math.exp(-SPRING.fov * dt));
    if (Math.abs(cam.fov - this.fov) > 1e-4) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    // Shake last, on top of a pose rebuilt from scratch: it is never read
    // back, so it cannot accumulate. apply() also refreshes matrixWorld.
    if (st.shake) st.shake.apply(cam);
    else cam.updateMatrixWorld();
  }
}

// ---------------------------------------------------------------------------
// The contract, for a battle wiring this in
// ---------------------------------------------------------------------------
// Construction (once, after the THREE.PerspectiveCamera exists):
//     this.planeCam = new PlaneCamera(this.camera, { fov: 60, zoomFov: 22 });
//     this.planeCam.reset(player);                 // and on every respawn
//
// Raw aim (the mouse). Integrate it into pc.yaw / pc.pitch (the air battle
// keeps camYaw / camPitch as accessors onto them), or call
//     pc.addMouse(input.mouseDX, input.mouseDY, 0.0022 * (camera.fov / 60));
// On entering the aim zoom:  pc.aimAlongNose(player);
// Keyboard flying (nose follow), every frame while flying, BEFORE update():
//     pc.followNose(dt, player, strength);   // 1 keys held, ease to 0 after
// Steering the instructor (mouse flying):
//     player.steerTowards(pc.aimPoint(player, 600, tmpV), dt);
//
// Per frame, after every plane.update() / updateGroundRoll() and after
// shake.update(dt), before the HUD projects anything:
//     pc.update(dt, {
//       plane: player,
//       zoom: aimZoomHeld && player.alive,
//       dead: !player.alive,
//       killer: deathCamKiller,        // or null
//       dist: chaseDistance,           // mouse-wheel dolly, 12..40
//       shake: this.shake,             // applied last
//     });
// It reads from the plane: position, dir, quat, alive. It reads the ground
// through world/airfield.js groundHeightAt() (terrain + airfields). It writes
// camera.position, camera.quaternion (via lookAt), camera.up, camera.fov (and
// updateProjectionMatrix when that changes) and matrixWorld. pc.fov is the
// current field of view (for mouse sensitivity scaling); pc.viewYaw is the
// yaw actually on screen, for the compass, minimap cone and damage arcs.
//
// Cockpit view (A-02, wave 3d): pass `cockpit: true` in the state. The eye is
// cockpitEye(plane) (cockpitEyeLocal(spec) in the body frame), the camera
// looks along plane.dir with the airframe's up, the near plane is
// COCKPIT_NEAR while it lasts. Feed the mouse through
//     pc.addMouseScreen(input.mouseDX, input.mouseDY, sens);
// so a sweep follows the screen in a bank. The reflector sight (H-03) goes
// where pc.gunLineWorldPoint(plane, v) projects through the final camera:
//     const g = pc.gunLineWorldPoint(player, tmpV).project(camera);
//     hud.setReflectorSight(sx(g), sy(g), g.z < 1, { fov: camera.fov, gunSpeed: spec.gun.speed });
