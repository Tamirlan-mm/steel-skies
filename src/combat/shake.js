import * as THREE from 'three';
import { clamp } from '../core/utils.js';
import { blastOf, SPEED_OF_SOUND } from './blast.js';

// Camera shake. Everything that ought to rattle the crew — your own gun going
// off, a 152mm round landing thirty metres away, a hit on your hull, a plane
// pulling out of a dive — is pushed in here as one "trauma" impulse, and the
// camera reads the sum of whatever is still alive.
//
// The motion is deliberately not white noise. A fresh random offset every frame
// reads as a rendering glitch, because nothing in it is continuous. What recoil
// actually looks like is a fast body movement with a rougher edge riding on it,
// so every impulse is three sine layers per channel at unrelated frequencies
// with the phases rolled the moment the impulse is created. Two shots a frame
// apart therefore never land on the same waveform, and a shake read on frame N
// is still the same curve on frame N+1 — which is what sells it as inertia.

const MAX_SHAKES = 10;
// Shakes still on their way to the listener (AV-02: the blast wave travels
// with the sound, at 343 m/s, so a burst 300 m off is felt 0.87 s after it is
// seen, together with the bang core/audio.js schedules on the same clock).
const MAX_PENDING = 24;
// Closer than this the wave is already here: no queue, no frame of lag.
const NO_DELAY = 1 / 240;
const CHANNELS = 6; // 0-2 positional (right/up/forward), 3-5 pitch/yaw/roll
const LAYERS = 3;
const TAU = Math.PI * 2;

// Hz. The bottom layer carries the body of the movement, the two above it
// roughen the edge. The gains sum to 1 so a single channel stays inside ±amp.
const LAYER_HZ = [7.1, 13.7, 24.3];
const LAYER_GAIN = [0.6, 0.28, 0.12];

// Detune per channel so the six of them never move in lockstep — in lockstep
// the whole thing reads as one sideways slide instead of a rattle. The angular
// channels run slower than the positional ones, which is what a heavy gun mount
// on torsion bars actually does.
const CHANNEL_DETUNE = [1.0, 0.91, 1.13, 0.79, 0.86, 0.71];

// Relative authority of each channel. Roll leads, because a roll around the
// view axis is the cheapest possible way to say "that was violent" without
// throwing the aim point off the target; forward/back barely moves at all.
const CHANNEL_WEIGHT = [1.0, 0.95, 0.45, 0.8, 0.62, 1.15];

const tmpRight = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();
const tmpEuler = new THREE.Euler(0, 0, 0, 'XYZ');
const tmpQuat = new THREE.Quaternion();

// Fast attack, exponential-ish tail that reaches exactly zero at the end of the
// window. Ending on a hard zero matters: an envelope that is merely small when
// the shake expires leaves a visible one-frame step.
function envelope(age, dur) {
  if (age <= 0) return 0;
  const attack = Math.min(0.05, dur * 0.2);
  if (age < attack) return age / attack;
  const u = (age - attack) / Math.max(1e-4, dur - attack);
  if (u >= 1) return 0;
  return Math.exp(-3.6 * u) * (1 - u * u);
}

export class CameraShake {
  constructor(options = {}) {
    // 0..1 damping for a settings slider. 0 disables the system outright and
    // makes add() a no-op, so nothing is even accumulated while it is off.
    this.scale = options.scale !== undefined ? options.scale : 1;

    // Peak metres of positional jitter and radians of angular jitter at a
    // summed trauma of 1. Kept small on purpose — a big camera translation
    // pushes the muzzle through walls, a rotation does not.
    this.posAmp = options.posAmp !== undefined ? options.posAmp : 0.26;
    this.rotAmp = options.rotAmp !== undefined ? options.rotAmp : 0.026;
    this.rollAmp = options.rollAmp !== undefined ? options.rollAmp : 0.045;

    // Hard ceiling on the summed trauma, per channel and overall. Four tanks
    // brewing up in the same second must not launch the camera off the map.
    this.maxTotal = options.maxTotal !== undefined ? options.maxTotal : 1;

    this.time = 0;
    this.amount = 0; // summed unclamped trauma, handy for HUD/audio ducking
    this.active = 0;
    this.channel = new Float32Array(CHANNELS);
    this.lastOffset = new THREE.Vector3();

    this.shakes = [];
    for (let i = 0; i < MAX_SHAKES; i++) {
      this.shakes.push({
        active: false,
        amp: 0,
        age: 0,
        dur: 0.4,
        freqScale: 1,
        phase: new Float32Array(CHANNELS * LAYERS),
      });
    }
    // Arrivals in flight, preallocated: { active, at (this.time of onset),
    // amp, dur, freq }. Distance and amplitude are settled when the blast
    // happens; only the onset waits.
    this.pending = [];
    for (let i = 0; i < MAX_PENDING; i++) {
      this.pending.push({ active: false, at: 0, amp: 0, dur: 0.4, freq: 1 });
    }
    this.pendingCount = 0;
    this._blast = null;
  }

  // Queue an impulse to start `delay` seconds from now. Full queue: the
  // weakest waiting impulse makes room, never a stronger one.
  later(delay, amp, duration, freqScale) {
    if (!(delay > NO_DELAY)) return this.add(amp, duration, freqScale);
    let slot = null;
    let weakest = Infinity;
    for (let i = 0; i < MAX_PENDING; i++) {
      const p = this.pending[i];
      if (!p.active) {
        slot = p;
        break;
      }
      if (p.amp < weakest) {
        weakest = p.amp;
        slot = p;
      }
    }
    if (slot.active) {
      if (weakest >= amp) return 0;
    } else {
      this.pendingCount++;
    }
    slot.active = true;
    slot.at = this.time + delay;
    slot.amp = amp;
    slot.dur = duration;
    slot.freq = freqScale;
    return amp;
  }

  // intensity is roughly 0..1 (0.15 a machine gun burst, 0.35 your own main
  // gun, 1.0 an ammo rack going off under you). Additive: the caller never has
  // to know what else is already shaking.
  add(intensity, duration = 0.4, freqScale = 1, age0 = 0) {
    if (this.scale <= 0) return 0;
    const amp = clamp(intensity, 0, 1.4);
    if (amp <= 0.004) return 0;

    let slot = null;
    let weakest = Infinity;
    for (let i = 0; i < MAX_SHAKES; i++) {
      const s = this.shakes[i];
      if (!s.active) {
        slot = s;
        break;
      }
      // All ten busy: evict whichever contributes least right now rather than
      // dropping the new impulse, so the loudest event always gets heard.
      const w = s.amp * envelope(s.age, s.dur);
      if (w < weakest) {
        weakest = w;
        slot = s;
      }
    }
    if (!slot) return 0;
    if (slot.active && weakest >= amp) return 0;

    slot.active = true;
    slot.amp = amp;
    // a delayed arrival that landed part-way through a frame starts that far
    // in (update() hands over its age minus the dt it is about to add)
    slot.age = Number.isFinite(age0) ? age0 : 0;
    slot.dur = Math.max(0.08, duration);
    slot.freqScale = freqScale * (0.9 + Math.random() * 0.24);
    for (let i = 0; i < CHANNELS * LAYERS; i++) slot.phase[i] = Math.random() * TAU;
    return amp;
  }

  // Distance-scaled convenience. Falls off with the square of the remaining
  // range and, further out, stretches longer and drops in frequency — a blast
  // half a kilometre away arrives as a rumble, not as a slap. It arrives when
  // the sound does (AV-02): d / 343 s after the call, the clock core/audio.js
  // schedules every report on. Call sites are unchanged.
  addAt(intensity, sourcePos, listenerPos, falloffRadius = 80, duration = 0.45) {
    if (this.scale <= 0 || !sourcePos || !listenerPos) return 0;
    const r = falloffRadius > 0 ? falloffRadius : 1;
    const d = sourcePos.distanceTo(listenerPos);
    if (d >= r) return 0;
    const n = 1 - d / r;
    const amp = intensity * n * n;
    if (amp <= 0.01) return 0;
    return this.later(d / SPEED_OF_SOUND, amp, duration * (1 + (1 - n) * 0.8), 1 - (1 - n) * 0.45);
  }

  // A detonation of `kg` kilograms of TNT at sourcePos (AV-01): amplitude,
  // length and pitch from the one blast law (combat/blast.js blastOf, scaled
  // distance Z = d / W^(1/3)), arriving with the sound (AV-02). `gain`
  // (optional, default 1) scales the amplitude for a listener who is better
  // or worse coupled to the ground than a tank crew — a pilot, say.
  addBlast(kg, sourcePos, listenerPos, gain = 1) {
    if (this.scale <= 0 || !sourcePos || !listenerPos || !(kg > 0)) return 0;
    const d = sourcePos.distanceTo(listenerPos);
    const b = (this._blast = blastOf(kg, d, this._blast));
    const amp = b.shake.amp * gain;
    if (amp <= 0.01) return 0;
    return this.later(b.shake.delay, amp, b.shake.dur, b.shake.freq);
  }

  update(dt) {
    // A tab switch or a stall must not fast-forward the decay into a jump.
    if (!(dt > 0)) return;
    if (dt > 0.25) dt = 0.25;
    this.time += dt;

    // Arrivals due by now start this frame, already as far into their own
    // envelope as the wave has been here (at least a hair, so the frame it
    // lands on is the frame it shows on).
    if (this.pendingCount > 0) {
      for (let i = 0; i < MAX_PENDING; i++) {
        const p = this.pending[i];
        if (!p.active || p.at > this.time) continue;
        p.active = false;
        this.pendingCount--;
        // the loop below adds this frame's dt to every live shake
        this.add(p.amp, p.dur, p.freq, Math.max(1e-3, this.time - p.at) - dt);
      }
    }

    const ch = this.channel;
    for (let c = 0; c < CHANNELS; c++) ch[c] = 0;

    let live = 0;
    let total = 0;
    for (let i = 0; i < MAX_SHAKES; i++) {
      const s = this.shakes[i];
      if (!s.active) continue;
      s.age += dt;
      const env = envelope(s.age, s.dur);
      if (env <= 0) {
        s.active = false;
        continue;
      }
      live++;
      const a = s.amp * env;
      total += a;
      const t = this.time * s.freqScale * TAU;
      const ph = s.phase;
      for (let c = 0; c < CHANNELS; c++) {
        const w = t * CHANNEL_DETUNE[c];
        let n = 0;
        for (let l = 0; l < LAYERS; l++) {
          n += LAYER_GAIN[l] * Math.sin(w * LAYER_HZ[l] + ph[c * LAYERS + l]);
        }
        ch[c] += n * a * CHANNEL_WEIGHT[c];
      }
    }

    this.active = live;
    // Clamp after summing, not per impulse: stacking is what makes a barrage
    // feel heavy, it just must not run away.
    const cap = this.maxTotal;
    for (let c = 0; c < CHANNELS; c++) ch[c] = clamp(ch[c], -cap, cap);
    this.amount = Math.min(total, cap);
  }

  // Call this AFTER the battle has finished placing the camera and has called
  // lookAt — it reads the camera's own basis to shake in view space, and the
  // battle rebuilds position and orientation from scratch every frame, so
  // nothing accumulates. (One exception: the death/kill cams lerp toward their
  // target from the current position. The offset is a couple of centimetres and
  // the lerp converges within a frame, but lastOffset is exposed so that code
  // can subtract it before lerping if it ever wants to be exact.)
  apply(camera) {
    this.lastOffset.set(0, 0, 0);
    if (!camera || this.active === 0 || this.scale <= 0) return;

    const ch = this.channel;
    const q = camera.quaternion;
    tmpRight.set(1, 0, 0).applyQuaternion(q);
    tmpUp.set(0, 1, 0).applyQuaternion(q);
    tmpFwd.set(0, 0, -1).applyQuaternion(q);

    const p = this.posAmp * this.scale;
    this.lastOffset
      .addScaledVector(tmpRight, ch[0] * p)
      .addScaledVector(tmpUp, ch[1] * p)
      .addScaledVector(tmpFwd, ch[2] * p);
    camera.position.add(this.lastOffset);

    tmpEuler.set(
      ch[3] * this.rotAmp * this.scale,
      ch[4] * this.rotAmp * this.scale,
      ch[5] * this.rollAmp * this.scale,
    );
    tmpQuat.setFromEuler(tmpEuler);
    // Right-multiply: the offset is expressed in the camera's own frame, so
    // "roll" really is roll around the view axis whatever direction we face.
    camera.quaternion.multiply(tmpQuat);
    // Anything that reads matrixWorld between here and the draw (raycasts,
    // billboards, the HUD's world-to-screen) then sees the shaken camera.
    camera.updateMatrixWorld();
  }

  // Kill everything instantly — respawn, camera cut, leaving the battle.
  reset() {
    for (let i = 0; i < MAX_SHAKES; i++) this.shakes[i].active = false;
    for (let i = 0; i < MAX_PENDING; i++) this.pending[i].active = false;
    this.pendingCount = 0;
    for (let c = 0; c < CHANNELS; c++) this.channel[c] = 0;
    this.active = 0;
    this.amount = 0;
    this.lastOffset.set(0, 0, 0);
  }

  setScale(v) {
    this.scale = clamp(v, 0, 1);
    if (this.scale <= 0) this.reset();
  }
}
