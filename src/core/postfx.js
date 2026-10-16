import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SAOPass } from 'three/examples/jsm/postprocessing/SAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import {
  CASTER_FLOOR, FOG_SCALE_HEIGHT, SKY_SCALE, ENV_GAIN_GLSL, envGainFor, envGroundOf,
} from '../world/presets.js';
import { installAtmosphere, makeHeightFog, CIRRUS_GLSL, makeCirrusUniforms, setCirrus } from './atmosphere.js';
import { hdriFor, loadHDRI, assetStatus, hdriRotationY, assetsEnabled } from './assets.js';
import { makeCloudMarchMaterial, updateCloudMarch, CLOUD_MAX_PIXELS } from '../world/clouds.js';

// This module is the PRESENTATION layer: everything between "the simulation
// has a state" and "a pixel reaches the screen".
//
//   createFramePacer()  K-05: how much game time each displayed frame shows
//   createPostFX()      the battle (and hangar) post chain, including P-02's
//                       one depth buffer, L-05 bloom, L-07 grade, K-01 finish
//   gradeFor()          L-07: the per-preset grade as a pure function (node)
//   createPhotoRig()    L-09 / H-08: the battle's light rig (sun, sky, IBL,
//                       height fog, AgX exposure) for the hangar stage and the
//                       vehicle thumbnails, so they are lit like a battle

// Post-processing chain for the battle view.
//
// WHAT THIS IS FOR
// The game renders straight to the canvas with two lights and no screen-space
// effects at all, which is why a tank sitting in the shadow of a building is lit
// exactly like a tank standing in the open. Three things fix most of that
// without touching a single scene file:
//
//   1. Ambient occlusion, which is the only cue in the whole renderer that says
//      "these two surfaces meet". Track over roadwheel, hull over sponson,
//      wing over fuselage — all of it is currently flat. (P-02: GTAO reads the
//      beauty pass's own depth and reconstructs normals from it, so the scene
//      is no longer drawn a second time for an AO G-buffer.)
//   2. A very small bloom, for emitters only (L-05): 0.28 strength on a
//      threshold set per preset above the brightest diffuse surface (fresh
//      snow), so fire, flashes, tracers, the sun and sun glints bloom and
//      nothing merely lit does. It is not a glow filter.
//   3. OutputPass, which takes tone mapping and colour-space conversion off the
//      renderer's per-material path and does it once, last, on the finished
//      HDR buffer. That is the correct place for it and it is what lets the
//      passes above work in linear light.
//
// ORDERING, AND WHY
//   RenderPass -> AO -> SeeThroughPass -> Bloom -> OutputPass -> SMAA -> Finish
// (Finish = L-07 grade + K-01 vignette and grain/dither, one display-referred
// pass, switched off — bit-identical — inside battle optics.)
// The high tier also carries three dormant passes (wave 3c): a linear-depth
// copy, the S-02 cloud slab after AO and the K-02 motion blur after the
// see-through half — see LinearDepthPass below. Each runs only on the frames
// that need it, so a ground battle's chain is the one described here except
// while the camera moves fast enough to streak half a pixel (K-02).
// On the tier with AO the RenderPass draws only the opaque scene, AO darkens
// that, and SeeThroughPass then composites smoke, fire, tracers and glass on
// top — occlusion belongs to opaque surfaces, see "opaque first" below. On the
// tier without AO the RenderPass draws everything and there is no second half.
// AO must see the linear beauty buffer before anything brightens it. Bloom must
// see HDR values, because the whole point of a threshold is to find the pixels
// above 1.0 that tone mapping is about to pull back down. OutputPass then tone
// maps and encodes exactly once. SMAA runs last on purpose: its edge detector
// is a luma threshold tuned for perceptual (post-tone-map) values, and run on
// raw HDR it under-detects in shadow and over-detects in sky. Its shaders write
// their input through untouched, so it cannot disturb the colour OutputPass
// produced.
//
// TONE MAPPING IS NOT DOUBLE-APPLIED. three only compiles the tone-mapping
// chunk into a material when the render target is the canvas; RenderPass draws
// into a composer buffer, so the scene arrives at OutputPass in linear light and
// is mapped once. On the "low" tier the composer is bypassed entirely and the
// renderer does it itself, which is the same picture by a shorter road.
//
// The HUD is DOM and a 2D canvas stacked over the WebGL canvas. Nothing here
// can see it or touch it.

const LEVELS = ['low', 'medium', 'high'];

function isLevel(v) {
  return LEVELS.indexOf(v) !== -1;
}

// ---------------------------------------------------------------------------
// hardware heuristic
// ---------------------------------------------------------------------------

// Mirrors the shape ui/garage.js already uses for the hangar stage (cores <= 4
// means a weak GPU too), with one extra tier in the middle because a battle can
// afford more than a menu can. Accepts a bare core count, an options object, or
// nothing at all.
//
// Wave 3b fix: the GPU is asked too (hardware.gpu, the WebGL renderer string —
// main.js passes it). Cores and memory say nothing about the GPU of a modern
// laptop: an Intel Iris Xe machine with 20 threads and 32 GB came out "high",
// where the backlog (1.1) puts that class on "medium" — high measured GPU p95
// 15-31 ms there against the 13 ms budget. Intel integrated graphics (not Arc)
// is capped at medium; a software rasteriser gets low.
export function gpuClassOf(gpu) {
  const g = typeof gpu === 'string' ? gpu : '';
  if (!g) return 'unknown';
  if (/SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(g)) return 'software';
  if (/Intel/i.test(g) && !/\bArc\b/i.test(g)) return 'integrated';
  return 'discrete';
}

export function postFXQualityFor(hardware) {
  let cores;
  let memory;
  let mobile;
  let gpu;

  if (typeof hardware === 'number') {
    cores = hardware;
  } else if (hardware && typeof hardware === 'object') {
    cores = hardware.cores;
    memory = hardware.memory;
    mobile = hardware.mobile;
    gpu = hardware.gpu;
  }

  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!Number.isFinite(cores)) cores = (nav && nav.hardwareConcurrency) || 8;
  if (!Number.isFinite(memory)) memory = (nav && nav.deviceMemory) || 8;
  if (mobile == null) {
    // deviceMemory and hardwareConcurrency both lie on phones; the touch count
    // is the cheap tell, and a phone should never be asked for the full chain.
    mobile =
      !!nav &&
      (/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || '') ||
        ((nav.maxTouchPoints || 0) > 1 && !/Windows/i.test(nav.userAgent || '')));
  }

  const cls = gpuClassOf(gpu);
  if (mobile || cores <= 4 || memory <= 2 || cls === 'software') return 'low';
  if (cores < 8 || memory <= 4 || cls === 'integrated') return 'medium';
  return 'high';
}

// The WebGL renderer string of a live renderer ('' when the browser hides it).
export function gpuNameOf(renderer) {
  try {
    const gl = renderer && renderer.getContext ? renderer.getContext() : null;
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// K-05 frame pacing: step the game on the display's interval
// ---------------------------------------------------------------------------
//
// A fixed-refresh display shows frame k at vsync k . T, whatever the clock
// said when the frame was computed. Stepping the game by the raw callback
// delta (THREE.Clock = performance.now() at callback time, +/- 2 ms of
// scheduling noise) therefore draws positions that are a few milliseconds
// early or late on screen: 3.3 px p99 judder on a ground point in air (N20),
// against 0.67 px for an exact 1/60 step.
//
// So the game is stepped on the display's own clock, recovered from the
// timestamps by a phase-locked loop (wave 3b fix: the first version paced a
// sliding-median interval and paid the difference back slowly, which let the
// game wander up to 6.6 ms off the display under noisy stamps and 62 ms off
// on a variable-refresh display):
//   * frame time comes from the requestAnimationFrame timestamp (vsync-aligned
//     where the browser provides it); clamped stalls are taken out of it (R);
//   * LOCK: a least-squares line through the last 8 stamps that fits within
//     3 % of its slope (clean, vsync-aligned stamps), or through the last 30
//     within 10 % (stamps with callback noise), gives the interval T and the
//     phase P — the display time of the current frame;
//   * LOCKED: each frame lands n = round((R - P) / T) intervals on (n > 1 is a
//     missed vsync, stepped as whole intervals); its error e = R - P - n.T
//     moves the phase by 4 % of e and the interval by 0.04 % of e — a
//     second-order loop, so a wrong interval cannot leave a standing offset:
//     the game time IS the estimated display time, within a fraction of a ms;
//   * an error beyond 3.5 x the stamp noise the lock was made on (0.6 ms ..
//     30 % of T) is
//     an outlier, stepped on the lattice; two in a row (a refresh change,
//     variable refresh) drop the lock and the frames step their raw deltas
//     until a new line fits — on a VRR display the stamps ARE the display
//     times, so raw is the right answer there;
//   * whatever offset a change of mode leaves between game and target time is
//     drained (25 % a frame free, 10 % locked, capped), never stepped at once;
//   * a stall over 50 ms steps exactly 50 ms as before (a 50 ms hitch still
//     advances 50 ms, as three whole intervals at 60 Hz).
// P-04: renderer.compileAsync, minus its two failure modes. three's version
// polls every material's currentProgram until it is ready, and throws (in a
// timer, uncaught, every 10 ms until the page gives up) once a material it
// is waiting for has been disposed — a battle left during its warm-up — or
// asks a deleted program for its status. Here a disposed material or a
// deleted program simply counts as done, and the wait gives up after 30 s.
// Without KHR_parallel_shader_compile there is nothing to wait for without
// blocking, so it resolves at once (the first frame finishes the job).
export function compileQuietly(renderer, scene, camera) {
  let materials = null;
  try {
    materials = renderer.compile(scene, camera);
  } catch {
    return Promise.resolve();
  }
  const gl = renderer.getContext();
  const props = renderer.properties;
  let ext = null;
  try {
    ext = renderer.extensions && renderer.extensions.get('KHR_parallel_shader_compile');
  } catch {
    ext = null;
  }
  if (!ext || !materials || typeof materials.forEach !== 'function' || !props) return Promise.resolve();
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  return new Promise((resolve) => {
    const check = () => {
      for (const m of materials) {
        let ready = true;
        try {
          const p = props.get(m).currentProgram;
          ready = !p || !p.program || !gl.isProgram(p.program) || p.isReady();
        } catch {
          ready = true;
        }
        if (ready) materials.delete(m);
      }
      if (!materials.size || now() - t0 > 30000) resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}

export function createFramePacer(opts = {}) {
  const MAX_STEP_MS = (opts.maxStep ?? 0.05) * 1000;
  const FIT_FAST = Math.max(4, opts.minSamples ?? 8);
  const FIT_SLOW = Math.max(FIT_FAST, opts.window ?? 30);
  const CLEAN = opts.clean ?? 0.03;      // fast-lock fit RMS, x T
  const NOISY = opts.noisy ?? 0.10;      // slow-lock fit RMS, x T
  const ALPHA = opts.phaseGain ?? 0.04;
  const BETA = opts.freqGain ?? (ALPHA * ALPHA) / 4;   // critically damped
  const OUT_K = 3.5;
  const OUT_FLOOR = 0.6;                 // ms
  const OUT_CAP = 0.3;                   // x T
  const DRAIN_FREE = 0.25;
  const DRAIN_LOCKED = 0.10;

  const ring = new Float64Array(FIT_SLOW);   // R of the last frames
  let count = 0;
  let head = 0;
  let last = NaN;      // ms, the previous raw timestamp
  let first = NaN;     // ms, the first raw timestamp
  let restart = false; // reset(): the next stamp re-anchors, steps nothing
  let lost = 0;        // ms swallowed by the stall clamp (and restarts)
  let R = 0;           // ts - lost of the last frame
  let G = 0;           // game time, same timebase
  let G0 = 0;
  let locked = false;
  let T = 0;           // ms, the display interval while locked
  let P = 0;           // ms, the display time of the last frame while locked
  let ms2 = 0;         // the loop's mean squared error (EMA, diagnostics)
  let noise = 0.15;    // ms, RMS stamp noise of the fit the lock was made on
  let strikes = 0;
  let paced = false;

  function push(r) {
    ring[head] = r;
    head = (head + 1) % FIT_SLOW;
    if (count < FIT_SLOW) count++;
  }

  // least-squares line through the last n stamps against frame index:
  // -> slope (ms/frame), the line's value at the newest frame, RMS residual
  const fit = { slope: 0, at: 0, rms: 0 };
  function fitLast(n) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    const base = ring[(head - 1 + FIT_SLOW) % FIT_SLOW];
    for (let i = 0; i < n; i++) {
      const y = ring[(head - n + i + FIT_SLOW * 2) % FIT_SLOW] - base;
      sx += i; sy += y; sxx += i * i; sxy += i * y;
    }
    const den = n * sxx - sx * sx;
    const slope = den > 0 ? (n * sxy - sx * sy) / den : 0;
    const icpt = (sy - slope * sx) / n;
    let ss = 0;
    let sd = 0;
    let rPrev = 0;
    for (let i = 0; i < n; i++) {
      const y = ring[(head - n + i + FIT_SLOW * 2) % FIT_SLOW] - base;
      const r = y - (icpt + slope * i);
      ss += r * r;
      if (i > 0) sd += (r - rPrev) * (r - rPrev);
      rPrev = r;
    }
    fit.slope = slope;
    fit.at = base + icpt + slope * (n - 1);
    fit.rms = Math.sqrt(ss / Math.max(1, n - 2));
    // Durbin-Watson: ~2 for white callback noise, ~0 for a smooth wander
    // (a variable-refresh display), whose stamps must not be locked to a line
    fit.dw = ss > 1e-12 ? sd / ss : 2;
    return fit;
  }

  // After a lock was lost the fast path stays shut (a variable-refresh
  // display fits a short line now and then and would lock, drift and drop
  // again); a lock then needs the long fit, either clean or white noise.
  let fastOK = true;
  function tryLock() {
    const ok = (n, tol, white) => {
      if (count < n) return false;
      const f = fitLast(n);
      return f.slope > 2 && f.slope < 250 && f.rms <= tol * f.slope && (!white || f.dw > 1.2);
    };
    if (!(fastOK && ok(FIT_FAST, CLEAN, false)) && !ok(FIT_SLOW, CLEAN, false) && !ok(FIT_SLOW, NOISY, true)) return false;
    locked = true;
    T = fit.slope;
    P = fit.at;
    noise = Math.max(0.15, fit.rms);
    ms2 = noise * noise;
    strikes = 0;
    return true;
  }

  function unlock() {
    locked = false;
    fastOK = false;
    strikes = 0;
    count = 0;
    head = 0;
  }

  function median(n) {
    const a = [];
    for (let i = 1; i < n; i++) {
      a.push(ring[(head - n + i + FIT_SLOW * 2) % FIT_SLOW] - ring[(head - n + i - 1 + FIT_SLOW * 2) % FIT_SLOW]);
    }
    a.sort((x, y) => x - y);
    return a.length ? a[a.length >> 1] : 0;
  }

  return {
    // `ts` is the rAF timestamp in ms. Returns the game step in SECONDS.
    step(ts) {
      if (!Number.isFinite(ts)) ts = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!Number.isFinite(last)) {
        last = first = ts;
        lost = 0;
        R = G = G0 = ts;
        push(R);
        paced = false;
        return 0;
      }
      if (restart) {
        // the loop was stopped: the gap is nobody's time; the display has
        // not changed, so the lock (interval) is kept and only re-phased
        restart = false;
        lost += ts - last;
        last = ts;
        P = R;
        paced = false;
        return 0;
      }
      const raw = ts - last;
      // two callbacks inside one frame, or a clock that stepped backwards
      if (!(raw > 0)) {
        paced = false;
        return 0;
      }
      last = ts;
      const Rprev = R;
      const Pprev = P;
      const wasLocked = locked;
      let goal;
      let goalPrev;
      if (raw > MAX_STEP_MS + 0.5) {
        // a stall: exactly MAX_STEP of it is game time, the rest is lost; a
        // lock keeps its interval and restarts its phase there
        goalPrev = wasLocked ? Pprev : Rprev;
        goal = goalPrev + MAX_STEP_MS;
        lost = ts - goal;
        R = goal;
        P = goal;
        if (!locked) { count = 0; head = 0; push(R); }
        paced = false;
      } else {
        R = ts - lost;
        if (locked) {
          const n = Math.round((R - P) / T);
          const e = R - P - n * T;
          // the noise level is the one the lock was made on: a loop error that
          // grows (a display that changes its interval) must not raise it
          const thr = Math.min(OUT_CAP * T, Math.max(OUT_FLOOR, OUT_K * noise));
          if (n >= 1 && n * T <= MAX_STEP_MS + 0.5 && Math.abs(e) <= thr) {
            strikes = 0;
            P += n * T + ALPHA * e;
            T += (BETA * e) / n;
            ms2 += 0.05 * (e * e - ms2);
            paced = true;
          } else if (++strikes >= 2) {
            unlock();
            push(R);
            paced = false;
          } else {
            // one outlier: assume a late stamp, stay on the lattice
            if (n >= 1) P += n * T;
            paced = false;
          }
        } else {
          push(R);
          paced = false;
        }
        if (!locked && !wasLocked) tryLock();
        if (locked) {
          goal = P;
          goalPrev = wasLocked ? Pprev : P - T;
        } else {
          goal = R;
          goalPrev = Rprev;
        }
      }
      // the move of the target, plus a share of the offset a mode change left
      const off = goalPrev - G;
      const k = locked ? DRAIN_LOCKED : DRAIN_FREE;
      const cap = locked ? 0.1 * T : 0.25 * Math.max(goal - goalPrev, 1);
      let pay = off * k;
      pay = pay > cap ? cap : pay < -cap ? -cap : pay;
      let stepMs = goal - goalPrev + pay;
      if (stepMs < 0) stepMs = 0;
      G += stepMs;
      return stepMs / 1000;
    },
    // Forget the last timestamp (the loop was stopped and restarted).
    reset() {
      if (Number.isFinite(last)) restart = true;
    },
    // ms -> s; the locked interval, else the median of the deltas seen since
    // the lock was lost (0 before there are two)
    get interval() {
      if (locked) return T / 1000;
      return count >= 2 ? median(count) / 1000 : 0;
    },
    get locked() { return locked; },
    get loopError() { return Math.sqrt(ms2) / 1000; },
    // wall time (net of clamped stalls) not yet handed to the game
    get residual() { return (R - G) / 1000; },
    get paced() { return paced; },
    // game time minus wall time, net of the stalls the clamp swallowed on
    // purpose: what K-05's "drift <= 1 ms per 10 s" is about
    get drift() { return (G - R) / 1000; },
    get gameTime() { return (G - G0) / 1000; },
    get wallTime() { return Number.isFinite(first) ? (last - first) / 1000 : 0; },
  };
}

// ---------------------------------------------------------------------------
// L-07 grade + K-01 lens finish
// ---------------------------------------------------------------------------
//
// The grade is a pure function of the preset and holds only named physical
// trims (principle 1.1; no tint, no crush, no split-tone):
//
//   * Residual white balance. A camera on auto white balance pulls about half
//     of the light's colour cast back toward neutral. The cast is that of the
//     card under the preset's dominant light (preset.light: the horizontal
//     sunlit card, or the sun-facing one under a low sun), so a grey day loses
//     half its blue and a clear noon a little of its warmth — but a WARM cast
//     under a sun below 30 degrees is left alone (golden hour is the subject;
//     dusk keeps its warmth). The gains are normalised to keep the card's
//     luminance, so the 18 % card's level does not move.
//   * Overcast saturation. Diffuse light flattens colour: x0.88 when (nearly)
//     all of the light is diffuse, 1.0 under a clear sun, linear in between on
//     the diffuse share of the white card.
//
// White balance and saturation are both linear maps in linear light, so the
// "LUT" of the backlog is realised as its exact equivalent, one 3x3 matrix:
// no 32^3 quantisation, no trilinear error, and a node test can apply it.
const LUMA = [0.2126, 0.7152, 0.0722];
const lumOf3 = (c) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export const GRADE = Object.freeze({
  awbStrength: 0.5,      // share of the cast the camera's AWB removes
  warmKeepBelowDeg: 30,  // a warm cast under a lower sun is kept...
  warmKeepFromDeg: 6,    // ...entirely at the dusk sun
  overcastSat: 0.88,     // saturation when the light is all diffuse
  diffuseFrom: 0.4,      // diffuse share where desaturation starts
  diffuseTo: 0.9,        // ...and where it is full
});

export const LENS = Object.freeze({
  vignette: 0.15,        // corner darkening in linear light: corner/centre 0.85
  grain: 1.0,            // sigma in 8-bit sRGB levels at mid-grey (cap 1.2)
  grainFloor: 0.3,       // share of it kept at black and white (dither)
});

// The light that decides the grade, in linear RGB: the white card the light
// lane's exposure is solved on.
export function gradeIlluminant(preset) {
  const L = preset && preset.light;
  if (!L || !L.sunLin || !L.ambLin) return null;
  const elev = Number.isFinite(L.casterElev) ? L.casterElev : Math.asin(Math.max(CASTER_FLOOR, preset.sunDir ? preset.sunDir.y : 0.8));
  const cy = Math.sin(elev);
  const ch = Math.cos(elev);
  const litH = [0, 1, 2].map((i) => L.sunLin[i] * cy + L.ambLin[i]);
  const ambV = L.ambVLin || L.ambLin;
  const litV = [0, 1, 2].map((i) => L.sunLin[i] * ch + ambV[i]);
  return L.lowSun ? litV : litH;
}

// -> { matrix: [9] row-major, gains: [3], saturation, identity }
export function gradeFor(preset) {
  const ident = { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], gains: [1, 1, 1], saturation: 1, identity: true };
  const lit = gradeIlluminant(preset);
  if (!lit) return ident;
  const y = lumOf3(lit);
  if (!(y > 0)) return ident;
  const cast = lit.map((v) => v / y);
  // how much of the cast the camera takes out
  let k = GRADE.awbStrength;
  const warm = cast[0] > cast[2];
  if (warm) {
    const elevDeg = (Math.asin(clamp01(preset.sunDir ? preset.sunDir.y : 1)) * 180) / Math.PI;
    k *= clamp01((elevDeg - GRADE.warmKeepFromDeg) / (GRADE.warmKeepBelowDeg - GRADE.warmKeepFromDeg));
  }
  let gains = cast.map((c) => Math.pow(Math.max(1e-4, c), -k));
  // keep the card's luminance: lum(g . cast) = lum(cast) = 1
  const norm = lumOf3(gains.map((g, i) => g * cast[i]));
  gains = gains.map((g) => g / norm);
  // the diffuse share of the white card: 1 / (lit : shadow), on whichever
  // face carries the more direct light
  const L = preset.light;
  const ratio = Math.max(L.ratioH || 1, L.ratioV || 1);
  const diffuse = 1 / Math.max(1, ratio);
  const t = clamp01((diffuse - GRADE.diffuseFrom) / (GRADE.diffuseTo - GRADE.diffuseFrom));
  const s = 1 - (1 - GRADE.overcastSat) * t;
  // M = S . diag(gains), S = s.I + (1 - s).[luma; luma; luma]
  const m = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const sat = (r === c ? s : 0) + (1 - s) * LUMA[c];
      m.push(sat * gains[c]);
    }
  }
  return {
    matrix: m.map((v) => +v.toFixed(6)),
    gains: gains.map((v) => +v.toFixed(6)),
    saturation: +s.toFixed(4),
    identity: false,
  };
}

// The finish shader's colour maths on the CPU, for node tests: sRGB-encoded
// input (0..1) -> sRGB-encoded output, grade only (no vignette, no grain).
export function applyGradeSRGB(grade, rgb) {
  const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const toS = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  const l = rgb.map((c) => toLin(clamp01(c)));
  const m = grade.matrix;
  const o = [0, 1, 2].map((r) => m[r * 3] * l[0] + m[r * 3 + 1] * l[1] + m[r * 3 + 2] * l[2]);
  return o.map((c) => toS(clamp01(c)));
}

const FinishShader = {
  name: 'FinishShader',
  uniforms: {
    tDiffuse: { value: null },
    uGrade: { value: new THREE.Matrix3() },
    uGradeOn: { value: 1 },
    uVignette: { value: LENS.vignette },
    uGrain: { value: LENS.grain },
    uGrainFloor: { value: LENS.grainFloor },
    uSeed: { value: 0 },
    uAspect: { value: 16 / 9 },
    // P-04: contrast-adaptive sharpening of a frame drawn below the canvas
    // resolution (0 at full resolution: the pass is then what it always was)
    uSharp: { value: 0 },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  // Runs after OutputPass (and SMAA), on display-referred sRGB-encoded values:
  // decode, grade and vignette in linear light, encode, then the grain. The
  // grain is luminance-only (the same offset on R, G and B), triangular-PDF,
  // sigma = uGrain levels at mid-grey falling to uGrainFloor of that at black
  // and white — so it is also the dither that breaks 8-bit sky banding.
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform mat3 uGrade;
    uniform float uGradeOn;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uGrainFloor;
    uniform float uSeed;
    uniform float uAspect;
    uniform float uSharp;
    uniform vec2 uTexel;
    varying vec2 vUv;

    vec3 ssToLinear( vec3 c ) {
      return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) );
    }
    vec3 ssToSRGB( vec3 c ) {
      return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), c ) );
    }
    // hash without sine (Dave Hoskins), stable at large pixel coordinates
    float ssHash( vec2 p ) {
      vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
      p3 += dot( p3, p3.yzx + 33.33 );
      return fract( ( p3.x + p3.y ) * p3.z );
    }

    void main() {
      vec4 tex = texture2D( tDiffuse, vUv );
      if ( uSharp > 0.0 ) {
        // AMD CAS-style: a cross of four neighbours (source texels), weighted
        // down where the local contrast is already high, so edges get crisper
        // without ringing and flat areas are left alone
        vec3 nN = texture2D( tDiffuse, vUv + vec2( 0.0, uTexel.y ) ).rgb;
        vec3 nS = texture2D( tDiffuse, vUv - vec2( 0.0, uTexel.y ) ).rgb;
        vec3 nE = texture2D( tDiffuse, vUv + vec2( uTexel.x, 0.0 ) ).rgb;
        vec3 nW = texture2D( tDiffuse, vUv - vec2( uTexel.x, 0.0 ) ).rgb;
        vec3 c0 = clamp( tex.rgb, 0.0, 1.0 );
        vec3 mn = min( c0, min( min( nN, nS ), min( nE, nW ) ) );
        vec3 mx = max( c0, max( max( nN, nS ), max( nE, nW ) ) );
        vec3 amp = sqrt( clamp( min( mn, 1.0 - mx ) / max( mx, vec3( 1e-4 ) ), 0.0, 1.0 ) );
        vec3 w = amp * ( -1.0 / mix( 8.0, 5.0, uSharp ) );
        tex.rgb = clamp( ( c0 + ( nN + nS + nE + nW ) * w ) / ( 1.0 + 4.0 * w ), 0.0, 1.0 );
      }
      vec3 lin = ssToLinear( clamp( tex.rgb, 0.0, 1.0 ) );
      lin = mix( lin, max( uGrade * lin, vec3( 0.0 ) ), uGradeOn );
      // natural vignette: quadratic in the distance from the centre,
      // normalised so the corner gets exactly 1 - uVignette
      vec2 d = ( vUv - 0.5 ) * vec2( uAspect, 1.0 );
      float r2 = dot( d, d ) / ( 0.25 * ( uAspect * uAspect + 1.0 ) );
      lin *= 1.0 - uVignette * r2;
      vec3 s = ssToSRGB( clamp( lin, 0.0, 1.0 ) );
      float y = dot( s, vec3( 0.2126, 0.7152, 0.0722 ) );
      float shape = uGrainFloor + ( 1.0 - uGrainFloor ) * 4.0 * y * ( 1.0 - y );
      vec2 p = gl_FragCoord.xy + vec2( uSeed * 61.7, uSeed * 23.3 );
      float tri = ssHash( p ) + ssHash( p * 1.37 + 17.17 ) - 1.0;
      s += tri * 2.449490 * uGrain * shape / 255.0;
      gl_FragColor = vec4( s, tex.a );
    }`,
};

function makeFinishPass() {
  const pass = new ShaderPass(FinishShader);
  pass.__kind = 'finish';
  return pass;
}

// P-02 (wave 3b fix): a full-screen pass draws its quad with
// renderer.render(), and with renderer.autoClear on (the default — OutputPass,
// ShaderPass and SMAA leave it on) three clears colour, DEPTH and stencil of
// the bound target first. From OutputPass on that target is a composer buffer,
// whose depth is the shared one: postfx.depthTexture read 1.0 everywhere
// after the chain (measured, verifier). These passes therefore run with the
// depth and stencil auto-clear off; the colour clear stays (SMAA's edge
// shader discards and needs its own targets cleared). Screen draws keep the
// renderer's own behaviour.
function keepDepth(pass) {
  if (!pass || pass.__keepDepth) return pass;
  const base = pass.render.bind(pass);
  pass.render = function keepDepthRender(renderer, writeBuffer, readBuffer, dt, mask) {
    if (pass.renderToScreen) return base(renderer, writeBuffer, readBuffer, dt, mask);
    const d = renderer.autoClearDepth;
    const s = renderer.autoClearStencil;
    renderer.autoClearDepth = false;
    renderer.autoClearStencil = false;
    try {
      return base(renderer, writeBuffer, readBuffer, dt, mask);
    } finally {
      renderer.autoClearDepth = d;
      renderer.autoClearStencil = s;
    }
  };
  pass.__keepDepth = true;
  return pass;
}

// NaN / Inf guard (wave 3b fix). One non-finite pixel in the HDR buffer (the
// verifier caught the terrain's photo-detail path producing them on far skirt
// pixels) went through the bloom's mip chain and came out as screen-sized
// black rectangles. The bloom's bright-pass now reads a non-finite texel as
// black, and OutputPass replaces one with the mean of its finite 4-neighbours
// (or black), so a bad pixel stays one pixel. GLSL ES 1.0 safe (OutputPass is
// a RawShaderMaterial, compiled without #version 300 es: no isnan, no
// textureSize): a NaN fails every ordered comparison, an Inf the range, and
// clamp() is the belt to that: on D3D hardware min/max return the non-NaN
// operand.
const NAN_GUARD_GLSL = /* glsl */`
bool ssBadTexel( vec4 c ) {
	return ! ( c.r >= - 65000.0 && c.r <= 65000.0 && c.g >= - 65000.0 && c.g <= 65000.0
		&& c.b >= - 65000.0 && c.b <= 65000.0 && c.a >= - 65000.0 && c.a <= 65000.0 );
}
`;
function guardShader(material, anchor, replacement) {
  if (!material || typeof material.fragmentShader !== 'string') return false;
  const src = material.fragmentShader;
  if (src.indexOf('ssBadTexel') >= 0) return true;
  const at = src.indexOf(anchor);
  const main = src.indexOf('void main()');
  if (at < 0 || main < 0) return false;
  material.fragmentShader = src.slice(0, main) + NAN_GUARD_GLSL + src.slice(main).replace(anchor, replacement);
  material.needsUpdate = true;
  return true;
}
function guardBloom(bloom) {
  return guardShader(
    bloom && bloom.materialHighPassFilter,
    'vec4 texel = texture2D( tDiffuse, vUv );',
    `vec4 texel = texture2D( tDiffuse, vUv );
			texel = ssBadTexel( texel ) ? vec4( 0.0 ) : clamp( texel, 0.0, 65000.0 );`,
  );
}
function guardOutput(output, w, h) {
  const m = output && output.material;
  if (!m || !m.uniforms) return false;
  if (!m.uniforms.ssTexel) m.uniforms.ssTexel = { value: new THREE.Vector2(1 / Math.max(1, w), 1 / Math.max(1, h)) };
  // the composer hands every pass the frame size; OutputPass ignores it
  output.setSize = (sw, sh) => m.uniforms.ssTexel.value.set(1 / Math.max(1, sw), 1 / Math.max(1, sh));
  if (m.fragmentShader.indexOf('uniform vec2 ssTexel;') < 0) {
    m.fragmentShader = m.fragmentShader.replace('uniform sampler2D tDiffuse;', `uniform sampler2D tDiffuse;
		uniform vec2 ssTexel;`);
  }
  return guardShader(
    m,
    'gl_FragColor = texture2D( tDiffuse, vUv );',
    `gl_FragColor = texture2D( tDiffuse, vUv );
			if ( ssBadTexel( gl_FragColor ) ) {
				vec2 ssPx = ssTexel;
				vec4 ssAcc = vec4( 0.0 );
				float ssW = 0.0;
				vec4 ssN = texture2D( tDiffuse, vUv + vec2( ssPx.x, 0.0 ) );
				if ( ! ssBadTexel( ssN ) ) { ssAcc += ssN; ssW += 1.0; }
				ssN = texture2D( tDiffuse, vUv - vec2( ssPx.x, 0.0 ) );
				if ( ! ssBadTexel( ssN ) ) { ssAcc += ssN; ssW += 1.0; }
				ssN = texture2D( tDiffuse, vUv + vec2( 0.0, ssPx.y ) );
				if ( ! ssBadTexel( ssN ) ) { ssAcc += ssN; ssW += 1.0; }
				ssN = texture2D( tDiffuse, vUv - vec2( 0.0, ssPx.y ) );
				if ( ! ssBadTexel( ssN ) ) { ssAcc += ssN; ssW += 1.0; }
				gl_FragColor = ssW > 0.0 ? ssAcc / ssW : vec4( 0.0, 0.0, 0.0, 1.0 );
			}
			gl_FragColor = clamp( gl_FragColor, 0.0, 65000.0 );`,
  );
}

// ---------------------------------------------------------------------------
// pass builders
// ---------------------------------------------------------------------------

function disposePass(pass) {
  if (!pass) return;
  try {
    pass.dispose?.();
  } catch {
    /* a pass that cannot tear itself down must not take the frame with it */
  }
}

// GTAO is the better of the two — horizon-based, denoised, and it holds up on
// the long sight lines this game has — but it is also the one that trips over
// odd depth/normal buffer support. If it will not construct, or throws on its
// first frame, SAO takes over: cruder, cheaper, and universally supported.
function buildAO(scene, camera, w, h, prefer, samples = 16) {
  if (prefer !== 'sao') {
    try {
      const gtao = new GTAOPass(scene, camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default;
      // Full-strength AO reads as dirt on a vehicle; this is a contact shadow,
      // not a grime pass.
      gtao.blendIntensity = 0.85;
      gtao.updateGtaoMaterial({
        // Screen-space radius, not world-space: the camera sits 8 m from a tank
        // and 2 km from a hillside in the same frame, and a fixed world radius
        // is either invisible on one or a smear on the other.
        screenSpaceRadius: true,
        radius: 0.32,
        distanceExponent: 1,
        distanceFallOff: 1,
        thickness: 1,
        scale: 1,
        samples,
      });
      gtao.updatePdMaterial({
        lumaPhi: 10,
        depthPhi: 2,
        normalPhi: 3,
        radius: 4,
        radiusExponent: 1,
        rings: 2,
        samples: samples >= 16 ? 8 : 4,
      });
      gtao.__kind = 'gtao';
      return gtao;
    } catch {
      /* fall through to SAO */
    }
  }
  try {
    const sao = new SAOPass(scene, camera, new THREE.Vector2(w, h));
    tuneSAO(sao, camera);
    sao.__kind = 'sao';
    return sao;
  } catch {
    return null;
  }
}

// SAO's occlusion falloff is `saoScale / camera.far`, so a value tuned against
// the library's ten-metre demo scene turns into a black wash on a camera that
// sees four kilometres. Scale it with the far plane instead of hard-coding it,
// and re-do it whenever the camera is swapped: ground battles run a 2,500 m
// far plane and air battles 4,000 m.
function tuneSAO(sao, camera) {
  if (!sao || !sao.params) return;
  const far = camera && Number.isFinite(camera.far) ? camera.far : 1000;
  // remembered so render() re-tunes when the far plane moves under it (the
  // scenery driver raises battle cameras to 8,200 m after the hand-over)
  sao.__far = far;
  sao.params.saoScale = Math.max(1, far * 0.1);
  sao.params.saoBias = 0.5;
  // deliberately weak: this is the fallback path, and a wrong-looking AO is
  // worse than a faint one
  sao.params.saoIntensity = 0.05;
  sao.params.saoKernelRadius = 24;
  sao.params.saoMinResolution = 0;
  sao.params.saoBlur = true;
}

// ---------------------------------------------------------------------------
// opaque first, then occlusion, then everything see-through
// ---------------------------------------------------------------------------
//
// Both AO passes rebuild the frame with scene.overrideMaterial set to a normal
// material, and that swap cannot reason about anything see-through: tracers,
// muzzle flashes, smoke, explosion sprites, canopy glass and the rain sheet
// would all write depth under the override even though they write none in the
// beauty pass, so the AO would read a solid wall where the player sees a puff
// and ring every one of them with a dark halo. So the AO G-buffer has always
// been built with them hidden.
//
// But the AO was then MULTIPLIED INTO THE FINISHED BEAUTY BUFFER — smoke and
// all. Whatever stood behind a puff darkened the puff in its own silhouette:
// a tank parked behind a smoke screen the game calls blind (drawn at 1 - 1e-9
// opacity) showed through it on the high tier as a dark turret and a dark
// contact line under the hull (measured up to 43/255, 2 % of the tank's pixels
// off by more than 8 levels; medium and low showed nothing). Occlusion is a
// property of opaque surfaces and has to be applied before anything is
// composited over them, so on the tier with AO the frame is drawn in halves:
//
//   1. RenderPass: the opaque scene only;
//   2. AO, darkening just that;
//   3. SeeThroughPass: the see-through things only, over the result,
//      depth-tested against the opaque depth of half 1. The composer's two
//      buffers share one DepthTexture for this, because GTAO writes its
//      result into the other buffer of the ping-pong pair and half 3 draws
//      wherever the chain's result now is.
//
// The split is by MATERIAL (material.visible), not by object: an object's
// visible flag hides its whole subtree, and an opaque fuselage carrying a
// glass canopy as a child — or the other way round — would lose the wrong
// half. Two details keep it from changing anything but the AO:
//
//   * Shadows. The shadow maps are drawn inside the first render, so a
//     see-through thing that casts a shadow (canopy glass, the prop disc)
//     stays in half 1 with colour and depth writes masked off — it still lands
//     in the shadow map, draws nothing — and is hidden for the AO and drawn
//     for real in half 3. Without that, those shadows would exist on medium
//     and vanish on high.
//   * Second looks. The AO G-buffer and half 3 re-render a frame half 1 has
//     already prepared, so they reuse its shadow maps and world matrices
//     instead of redrawing every shadow map and recomputing every matrix
//     again (renderer.render does both on every call). Half 3 is thereby
//     exactly the transparent list half 1 used to draw, matrices and all, and
//     the shadow redraw skipped in the AO pass costs more than half 3 does:
//     on a real ground battle the high tier went from 354 draw calls a frame
//     to 268.

function isRenderable(o) {
  return !!(o.isMesh || o.isPoints || o.isLine || o.isSprite);
}

function isSeeThrough(m) {
  return !!(m.transparent || m.isSpriteMaterial);
}

// What the frame looks like to the split: every material on a visible
// renderable, sorted into opaque / see-through / see-through-and-casting, with
// the write flags it had before the split touched it. Rebuilt every frame (one
// traverse and a Map lookup per renderable — 9-30 us on the real battle scenes,
// the same as the old per-frame AO guard it replaces), because effects come
// and go every frame and a stale list would leave a material switched off.
const KIND_SOLID = 0;
const KIND_CLEAR = 1;
const KIND_CASTER = 2;

function createSceneSplit() {
  const index = new Map(); // material -> slot
  const mats = [];
  const kinds = [];
  const wasColorWrite = [];
  const wasDepthWrite = [];
  let count = 0;
  let clearCount = 0;
  // 0 idle, 1 opaque half, 2 AO, 3 see-through half
  let phase = 0;

  function note(m, casts) {
    if (!m) return;
    const slot = index.get(m);
    if (slot !== undefined) {
      if (casts && kinds[slot] === KIND_CLEAR) kinds[slot] = KIND_CASTER;
      return;
    }
    // Already switched off by the game: never drawn, never touched.
    if (m.visible === false) return;
    const see = isSeeThrough(m);
    index.set(m, count);
    mats[count] = m;
    kinds[count] = see ? (casts ? KIND_CASTER : KIND_CLEAR) : KIND_SOLID;
    wasColorWrite[count] = m.colorWrite;
    wasDepthWrite[count] = m.depthWrite;
    if (see) clearCount++;
    count++;
  }

  // Sprites never reach a shadow map, whatever their flag says.
  function visit(o) {
    if (!isRenderable(o)) return;
    const casts = !!o.castShadow && !o.isSprite;
    const m = o.material;
    if (Array.isArray(m)) {
      for (let i = 0; i < m.length; i++) note(m[i], casts);
    } else {
      note(m, casts);
    }
  }

  function setVisible(kindA, kindB, v) {
    for (let i = 0; i < count; i++) {
      const k = kinds[i];
      if (k === kindA || k === kindB) mats[i].visible = v;
    }
  }

  function unmaskCasters() {
    for (let i = 0; i < count; i++) {
      if (kinds[i] !== KIND_CASTER) continue;
      mats[i].colorWrite = wasColorWrite[i];
      mats[i].depthWrite = wasDepthWrite[i];
    }
  }

  const split = {
    // Before the opaque half. Returns false when the frame has nothing
    // see-through in it, in which case the halves collapse back into one.
    begin(scene) {
      split.end();
      if (!scene) return false;
      scene.traverseVisible(visit);
      if (clearCount === 0) return false;
      for (let i = 0; i < count; i++) {
        const k = kinds[i];
        if (k === KIND_CLEAR) {
          mats[i].visible = false;
        } else if (k === KIND_CASTER) {
          mats[i].colorWrite = false;
          mats[i].depthWrite = false;
        }
      }
      phase = 1;
      return true;
    },

    // After the opaque half: the casters are in the shadow map now, so they
    // go out of the AO G-buffer with the rest of the see-through things.
    toOcclusion() {
      if (phase !== 1) return;
      unmaskCasters();
      setVisible(KIND_CASTER, KIND_CASTER, false);
      phase = 2;
    },

    // Before the see-through half: swap which materials are switched off.
    // False when there is no see-through half to draw this frame.
    toSeeThrough() {
      if (phase === 1) split.toOcclusion();
      if (phase !== 2) return false;
      setVisible(KIND_CLEAR, KIND_CASTER, true);
      setVisible(KIND_SOLID, KIND_SOLID, false);
      phase = 3;
      return true;
    },

    // Everything back the way the game left it. Idempotent, and safe from any
    // phase, so a pass that throws halfway cannot leave half the scene dark.
    end() {
      if (phase === 1) {
        unmaskCasters();
        setVisible(KIND_CLEAR, KIND_CLEAR, true);
      } else if (phase === 2) {
        setVisible(KIND_CLEAR, KIND_CASTER, true);
      } else if (phase === 3) {
        setVisible(KIND_SOLID, KIND_SOLID, true);
      }
      phase = 0;
      // drop the references so a finished battle's materials can be collected
      for (let i = 0; i < count; i++) mats[i] = null;
      index.clear();
      count = 0;
      clearCount = 0;
    },
  };
  return split;
}

function drawScene(renderer, scene, camera) {
  renderer.render(scene, camera);
}

// A second look at a frame the first render already prepared: no shadow-map
// redraw, no matrix update. Saved and put back around the call, so the next
// frame's first render does both as usual.
function secondLook(renderer, scene, draw, a, b, c, d, e) {
  const sm = renderer.shadowMap;
  const autoUpdate = sm.autoUpdate;
  const needsUpdate = sm.needsUpdate;
  const matrices = scene ? scene.matrixWorldAutoUpdate : true;
  sm.autoUpdate = false;
  sm.needsUpdate = false;
  if (scene) scene.matrixWorldAutoUpdate = false;
  try {
    draw(a, b, c, d, e);
  } finally {
    sm.autoUpdate = autoUpdate;
    sm.needsUpdate = needsUpdate;
    if (scene) scene.matrixWorldAutoUpdate = matrices;
  }
}

// Half 1: the RenderPass, drawing only what the split leaves switched on.
function splitOpaquePass(pass, split, getScene) {
  const base = pass.render.bind(pass);
  pass.render = function opaqueHalf(renderer, writeBuffer, readBuffer, dt, mask) {
    split.begin(getScene());
    try {
      base(renderer, writeBuffer, readBuffer, dt, mask);
    } finally {
      split.toOcclusion();
    }
  };
  return pass;
}

// The AO pass, as a second look. The see-through materials are already off.
function occlusionPass(pass, getScene) {
  const base = pass.render.bind(pass);
  pass.render = function occlusion(renderer, writeBuffer, readBuffer, dt, mask) {
    secondLook(renderer, getScene(), base, renderer, writeBuffer, readBuffer, dt, mask);
  };
  return pass;
}

// Half 3: the see-through things, over the occluded opaque picture, into the
// buffer the chain's result is in (needsSwap false). No clear, no background:
// both would wipe what halves 1 and 2 drew.
class SeeThroughPass extends Pass {
  constructor(split, getScene, getCamera) {
    super();
    this.needsSwap = false;
    this.split = split;
    this.getScene = getScene;
    this.getCamera = getCamera;
  }

  render(renderer, writeBuffer, readBuffer) {
    const scene = this.getScene();
    const camera = this.getCamera();
    if (!scene || !camera || !this.split.toSeeThrough()) {
      this.split.end();
      return;
    }
    const background = scene.background;
    const autoClear = renderer.autoClear;
    scene.background = null;
    renderer.autoClear = false;
    try {
      renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
      secondLook(renderer, scene, drawScene, renderer, scene, camera);
    } finally {
      scene.background = background;
      renderer.autoClear = autoClear;
      this.split.end();
    }
  }
}

// ---------------------------------------------------------------------------
// S-02 / K-02: passes that read the frame's depth
// ---------------------------------------------------------------------------
//
// Both composer buffers carry the shared DepthTexture as their depth
// attachment (P-02), so a pass drawing into one of them must not SAMPLE that
// texture (WebGL: a feedback loop, INVALID_OPERATION). LinearDepthPass copies
// it once per frame, right after the opaque half, into a full-resolution R16F
// target of view depth in metres (65,000 = sky), and the cloud composite and
// the motion blur read that instead. It only runs while one of them does.
//
// Chain on high (see build()):
//   render(opaque) -> AO -> depthCopy -> clouds -> seeThrough -> motionBlur
//   -> bloom -> output -> SMAA -> finish
// The slab is composited over the opaque world and under the see-through
// half, so smoke, tracers and fire in front of a cloud are not veiled by it;
// the blur sees everything, the bloom sees the blurred, clouded HDR frame.
export const LIN_DEPTH_SKY = 65000;

const FULL_VS = /* glsl */`
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = vec4( position.xy, 0.0, 1.0 );
	}
`;

function lensTarget(w, h, format) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

// Draw a full-screen quad into `target` with no clear of any kind (every
// pixel is written, and a composer buffer's depth must survive).
function drawQuad(renderer, quad, target) {
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  try {
    renderer.setRenderTarget(target);
    quad.render(renderer);
  } finally {
    renderer.autoClear = autoClear;
  }
}

function fullMaterial(name, uniforms, fragmentShader) {
  return new THREE.ShaderMaterial({
    name,
    uniforms,
    vertexShader: FULL_VS,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

class LinearDepthPass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.enabled = false;
    this.__kind = 'depthCopy';
    this.source = null;   // the shared DepthTexture
    this.camera = null;
    this.target = null;   // allocated on first use: the hangar never pays for it
    this.w = 1;
    this.h = 1;
    this.quad = new FullScreenQuad(fullMaterial('SSLinearDepth', {
      tDepth: { value: null },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
    }, /* glsl */`
      #include <packing>
      uniform sampler2D tDepth;
      uniform float uNear;
      uniform float uFar;
      varying vec2 vUv;
      void main() {
        float d = texture2D( tDepth, vUv ).x;
        float z = d >= 1.0 ? ${LIN_DEPTH_SKY.toFixed(1)} : - perspectiveDepthToViewZ( d, uNear, uFar );
        gl_FragColor = vec4( min( z, ${LIN_DEPTH_SKY.toFixed(1)} ), 0.0, 0.0, 1.0 );
      }
    `));
  }

  setSize(w, h) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    if (this.target) this.target.setSize(this.w, this.h);
  }

  render(renderer) {
    const cam = this.camera;
    if (!this.source || !cam) return;
    if (!this.target) this.target = lensTarget(this.w, this.h, THREE.RedFormat);
    const u = this.quad.material.uniforms;
    u.tDepth.value = this.source;
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    drawQuad(renderer, this.quad, this.target);
  }

  dispose() {
    if (this.target) this.target.dispose();
    this.target = null;
    this.quad.material.dispose();
    this.quad.dispose();
  }
}

// S-02: depth downsample (min of the footprint) -> march at reduced
// resolution (world/clouds.js) -> depth-aware upsample and composite at full
// resolution: scene x T + S. The march stops at the low-res MIN depth, so a
// texel straddling an aeroplane's edge errs toward "no cloud"; the upsample
// then takes, per full-res pixel, the bilinear neighbours whose depth matches
// its own (and the nearest in depth when none does), so neither a halo of
// cloud over the aircraft nor of clear sky around it survives.
const CLOUD_COMPOSITE_FS = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform sampler2D tCloud;
  uniform sampler2D tLowDepth;
  uniform sampler2D tDepth;
  uniform vec2 uLowSize;
  varying vec2 vUv;
  void main() {
    vec4 scene = texture2D( tDiffuse, vUv );
    float z = texture2D( tDepth, vUv ).r;
    vec2 pos = vUv * uLowSize - 0.5;
    vec2 i0 = floor( pos );
    vec2 f = pos - i0;
    vec4 acc = vec4( 0.0 );
    float wsum = 0.0;
    vec4 best = vec4( 0.0, 0.0, 0.0, 1.0 );
    float bestD = 1e20;
    for ( int k = 0; k < 4; k ++ ) {
      vec2 o = vec2( float( k - ( k / 2 ) * 2 ), float( k / 2 ) );
      vec2 uvL = clamp( ( i0 + o + 0.5 ) / uLowSize, 0.0, 1.0 );
      vec4 c = texture2D( tCloud, uvL );
      float zl = texture2D( tLowDepth, uvL ).r;
      float dz = abs( zl - z );
      float rel = dz / max( min( zl, z ), 1.0 );
      float wb = ( o.x > 0.5 ? f.x : 1.0 - f.x ) * ( o.y > 0.5 ? f.y : 1.0 - f.y );
      float w = wb * exp( - rel * rel * 800.0 );
      acc += c * w;
      wsum += w;
      if ( dz < bestD ) { bestD = dz; best = c; }
    }
    vec4 cl = wsum > 1e-4 ? acc / wsum : best;
    gl_FragColor = vec4( scene.rgb * cl.a + cl.rgb, scene.a );
  }
`;

// The march jitters its first step per pixel with interleaved gradient noise,
// which is built to be resolved by a 3x3 neighbourhood: unfiltered, a grazing
// ray that a coarse step may or may not catch (the rim of a far cumulus, the
// top of a tower seen from above) alternates hit / miss from column to column
// and the rims grow vertical "hair" (seen in the frozen build, wave 3d). One
// 3x3 tent at the march resolution, depth-aware like the upsample so cloud
// in front of an aeroplane never bleeds onto it, turns that dither into the
// partial coverage it stands for (~0.05 ms at 0.3 MP).
const CLOUD_DENOISE_FS = /* glsl */`
  uniform sampler2D tCloud;
  uniform sampler2D tLowDepth;
  uniform vec2 uLowTexel;
  varying vec2 vUv;
  void main() {
    float z0 = texture2D( tLowDepth, vUv ).r;
    vec4 acc = vec4( 0.0 );
    float wsum = 0.0;
    for ( int k = 0; k < 9; k ++ ) {
      vec2 o = vec2( float( k - ( k / 3 ) * 3 - 1 ), float( k / 3 - 1 ) );
      vec2 uv = vUv + o * uLowTexel;
      vec4 c = texture2D( tCloud, uv );
      float z = texture2D( tLowDepth, uv ).r;
      float rel = abs( z - z0 ) / max( min( z, z0 ), 1.0 );
      float w = ( 2.0 - abs( o.x ) ) * ( 2.0 - abs( o.y ) ) * exp( - rel * rel * 800.0 );
      acc += c * w;
      wsum += w;
    }
    gl_FragColor = acc / wsum;
  }
`;

class CloudPass extends Pass {
  constructor(lin) {
    super();
    this.needsSwap = true;
    this.enabled = false;
    this.__kind = 'clouds';
    this.lin = lin;
    this.vol = null;       // scene.userData.cloudVolume (world/clouds.js)
    this.camera = null;
    this.failed = false;
    this.checked = false;
    this.fullW = 1;
    this.fullH = 1;
    this.lowW = 1;
    this.lowH = 1;
    this.lowDepth = null;
    this.lowCloud = null;
    this.downQuad = new FullScreenQuad(fullMaterial('S02DepthDown', {
      tDepth: { value: null },
      uLowTexel: { value: new THREE.Vector2(1, 1) },
    }, /* glsl */`
      uniform sampler2D tDepth;
      uniform vec2 uLowTexel;
      varying vec2 vUv;
      void main() {
        vec2 o = uLowTexel * 0.25;
        float a = texture2D( tDepth, vUv + vec2( - o.x, - o.y ) ).r;
        float b = texture2D( tDepth, vUv + vec2( o.x, - o.y ) ).r;
        float c = texture2D( tDepth, vUv + vec2( - o.x, o.y ) ).r;
        float d = texture2D( tDepth, vUv + vec2( o.x, o.y ) ).r;
        gl_FragColor = vec4( min( min( a, b ), min( c, d ) ), 0.0, 0.0, 1.0 );
      }
    `));
    this.marchMat = makeCloudMarchMaterial();
    this.marchQuad = new FullScreenQuad(this.marchMat);
    this.lowSoft = null;   // the march after the 3x3 denoise
    this.denoise = true;   // debug: false composites the raw march
    this.softQuad = new FullScreenQuad(fullMaterial('S02Denoise', {
      tCloud: { value: null },
      tLowDepth: { value: null },
      uLowTexel: { value: new THREE.Vector2(1, 1) },
    }, CLOUD_DENOISE_FS));
    this.compQuad = new FullScreenQuad(fullMaterial('S02Composite', {
      tDiffuse: { value: null },
      tCloud: { value: null },
      tLowDepth: { value: null },
      tDepth: { value: null },
      uLowSize: { value: new THREE.Vector2(1, 1) },
    }, CLOUD_COMPOSITE_FS));
  }

  setSize(w, h) {
    this.fullW = Math.max(1, w);
    this.fullH = Math.max(1, h);
    const s = Math.min(0.5, Math.sqrt(CLOUD_MAX_PIXELS / (this.fullW * this.fullH)));
    this.lowW = Math.max(1, Math.round(this.fullW * s));
    this.lowH = Math.max(1, Math.round(this.fullH * s));
    if (this.lowDepth) this.lowDepth.setSize(this.lowW, this.lowH);
    if (this.lowCloud) this.lowCloud.setSize(this.lowW, this.lowH);
    if (this.lowSoft) this.lowSoft.setSize(this.lowW, this.lowH);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.needsSwap = false;
    const vol = this.vol;
    const cam = this.camera;
    const lin = this.lin && this.lin.target;
    if (!vol || !cam || !lin || this.failed) return;
    try {
      if (!this.lowDepth) {
        this.lowDepth = lensTarget(this.lowW, this.lowH, THREE.RedFormat);
        this.lowCloud = lensTarget(this.lowW, this.lowH, THREE.RGBAFormat);
        this.lowSoft = lensTarget(this.lowW, this.lowH, THREE.RGBAFormat);
      }
      const du = this.downQuad.material.uniforms;
      du.tDepth.value = lin.texture;
      du.uLowTexel.value.set(1 / this.lowW, 1 / this.lowH);
      drawQuad(renderer, this.downQuad, this.lowDepth);

      updateCloudMarch(this.marchMat, vol, cam, this.lowDepth.texture, this.lowH);
      drawQuad(renderer, this.marchQuad, this.lowCloud);
      if (!this.checked) {
        // a march program that did not compile or link: S-01 takes over
        this.checked = true;
        const prog = renderer.properties?.get?.(this.marchMat)?.currentProgram;
        if (prog && prog.diagnostics && prog.diagnostics.runnable === false) {
          this.failed = true;
          return;
        }
      }

      let cloudTex = this.lowCloud.texture;
      if (this.denoise) {
        const su = this.softQuad.material.uniforms;
        su.tCloud.value = this.lowCloud.texture;
        su.tLowDepth.value = this.lowDepth.texture;
        su.uLowTexel.value.set(1 / this.lowW, 1 / this.lowH);
        drawQuad(renderer, this.softQuad, this.lowSoft);
        cloudTex = this.lowSoft.texture;
      }

      const cu = this.compQuad.material.uniforms;
      cu.tDiffuse.value = readBuffer.texture;
      cu.tCloud.value = cloudTex;
      cu.tLowDepth.value = this.lowDepth.texture;
      cu.tDepth.value = lin.texture;
      cu.uLowSize.value.set(this.lowW, this.lowH);
      drawQuad(renderer, this.compQuad, this.renderToScreen ? null : writeBuffer);
      this.needsSwap = !this.renderToScreen;
    } catch (e) {
      // never the battle: this frame keeps the picture it had, the next one
      // draws the S-01 deck instead
      this.failed = true;
      this.needsSwap = false;
    }
  }

  dispose() {
    if (this.lowDepth) this.lowDepth.dispose();
    if (this.lowCloud) this.lowCloud.dispose();
    if (this.lowSoft) this.lowSoft.dispose();
    this.lowDepth = null;
    this.lowCloud = null;
    this.lowSoft = null;
    for (const q of [this.downQuad, this.marchQuad, this.softQuad, this.compQuad]) {
      q.material.dispose();
      q.dispose();
    }
  }
}

// K-02: camera-motion reprojection blur on the linear HDR frame. Each pixel's
// world point (view depth from LinearDepthPass, a direction for the sky) is
// projected with the PREVIOUS frame's view-projection; the streak is that
// screen motion times the shutter share (exposure / frame time), centred on
// the pixel, capped at 24 px at 1080p (2.2 % of the frame height). 8 taps,
// jittered by interleaved gradient noise so a long streak dithers instead of
// stepping. Pixels nearer than the player vehicle + 12 m are neither blurred
// nor sampled, so the vehicle stays sharp and never smears into the world.
const MOTION_BLUR_FS = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform mat4 uInvProj;
  uniform mat4 uCamWorld;
  uniform mat4 uPrevViewProj;
  uniform float uShutter;
  uniform float uNear;
  uniform vec2 uRes;
  uniform float uMaxPx;
  varying vec2 vUv;
  void main() {
    vec4 c0 = texture2D( tDiffuse, vUv );
    float z = texture2D( tDepth, vUv ).r;
    if ( uShutter <= 0.0 || z < uNear ) { gl_FragColor = c0; return; }
    vec4 vp = uInvProj * vec4( vUv * 2.0 - 1.0, 1.0, 1.0 );
    vec3 rv = vp.xyz / vp.w;
    vec4 prev = z > ${(LIN_DEPTH_SKY - 5000).toFixed(1)}
      ? uPrevViewProj * vec4( mat3( uCamWorld ) * rv, 0.0 )
      : uPrevViewProj * ( uCamWorld * vec4( rv * ( z / max( - rv.z, 1e-6 ) ), 1.0 ) );
    if ( prev.w <= 1e-4 ) { gl_FragColor = c0; return; }
    vec2 v = ( vUv - ( prev.xy / prev.w * 0.5 + 0.5 ) ) * uShutter;
    float len = length( v * uRes );
    if ( len < 0.5 ) { gl_FragColor = c0; return; }
    if ( len > uMaxPx ) v *= uMaxPx / len;
    float j = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
    vec4 acc = c0;
    float wsum = 1.0;
    for ( int i = 0; i < 8; i ++ ) {
      vec2 uv = clamp( vUv + v * ( ( float( i ) + j ) / 8.0 - 0.5 ), vec2( 0.0 ), vec2( 1.0 ) );
      if ( texture2D( tDepth, uv ).r < uNear ) continue;
      acc += texture2D( tDiffuse, uv );
      wsum += 1.0;
    }
    gl_FragColor = acc / wsum;
  }
`;

export const BLUR_MAX_FRAC = 24 / 1080;   // streak cap as a share of the frame height
export const BLUR_NEAR_PAD = 12;          // m beyond the player vehicle that stay sharp
export const BLUR_SUBJECT_MAX = 80;       // m: a camera further from it is not on it
export const BLUR_MAX_EXPOSURE = 1 / 120; // s

class MotionBlurPass extends Pass {
  constructor(lin) {
    super();
    this.needsSwap = true;
    this.enabled = false;
    this.__kind = 'motionBlur';
    this.lin = lin;
    this.w = 1;
    this.h = 1;
    this.quad = new FullScreenQuad(fullMaterial('K02MotionBlur', {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uShutter: { value: 0 },
      uNear: { value: BLUR_NEAR_PAD },
      uRes: { value: new THREE.Vector2(1, 1) },
      uMaxPx: { value: 24 },
    }, MOTION_BLUR_FS));
  }

  get uniforms() {
    return this.quad.material.uniforms;
  }

  setSize(w, h) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.needsSwap = false;
    const lin = this.lin && this.lin.target;
    if (!lin) return;
    const u = this.quad.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = lin.texture;
    u.uRes.value.set(this.w, this.h);
    u.uMaxPx.value = Math.max(8, BLUR_MAX_FRAC * this.h);
    drawQuad(renderer, this.quad, this.renderToScreen ? null : writeBuffer);
    this.needsSwap = !this.renderToScreen;
  }

  dispose() {
    this.quad.material.dispose();
    this.quad.dispose();
  }
}

// The shader's reprojection on the CPU, at five screen points (centre and
// corners) and two depths (`near` and the sky), returning the longest streak
// in device pixels (uncapped).
const STREAK_UV = [0.5, 0.5, 0.02, 0.02, 0.98, 0.02, 0.02, 0.98, 0.98, 0.98];
const _sv = new THREE.Vector4();
const _sr = new THREE.Vector3();
const _sd = new THREE.Vector3();
function maxStreakPx(cam, prevVP, near, shutter, w, h) {
  let best = 0;
  for (let i = 0; i < STREAK_UV.length; i += 2) {
    const u = STREAK_UV[i];
    const v = STREAK_UV[i + 1];
    _sv.set(u * 2 - 1, v * 2 - 1, 1, 1).applyMatrix4(cam.projectionMatrixInverse);
    _sr.set(_sv.x / _sv.w, _sv.y / _sv.w, _sv.z / _sv.w);
    for (let k = 0; k < 2; k++) {
      if (k === 0) {
        const s = near / Math.max(1e-6, -_sr.z);
        _sv.set(_sr.x * s, _sr.y * s, _sr.z * s, 1).applyMatrix4(cam.matrixWorld);
      } else {
        _sd.copy(_sr).transformDirection(cam.matrixWorld);
        _sv.set(_sd.x, _sd.y, _sd.z, 0);
      }
      _sv.applyMatrix4(prevVP);
      if (!(_sv.w > 1e-4)) continue;
      const du = (u - (_sv.x / _sv.w * 0.5 + 0.5)) * shutter * w;
      const dv = (v - (_sv.y / _sv.w * 0.5 + 0.5)) * shutter * h;
      const px = Math.hypot(du, dv);
      if (px > best) best = px;
    }
  }
  return best;
}

// The streak a camera motion leaves on screen, as the shader computes it, in
// device pixels (node tests, K-02 accept): world point `p` ({x,y,z}) seen by
// `camera` now and by a camera with view-projection `prevVP` one frame of
// `dt` seconds ago. Not capped.
export function blurStreakPx(camera, prevVP, p, dt, width, height) {
  if (!(dt > 0)) return 0;
  const shutter = Math.min(0.5 * dt, BLUR_MAX_EXPOSURE) / dt;
  const cur = new THREE.Vector3(p.x, p.y, p.z).project(camera);
  const q = new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(prevVP);
  if (!(q.w > 1e-4)) return 0;
  const dx = ((cur.x - q.x / q.w) * 0.5) * width * shutter;
  const dy = ((cur.y - q.y / q.w) * 0.5) * height * shutter;
  return Math.hypot(dx, dy);
}

// ---------------------------------------------------------------------------
// createPostFX
// ---------------------------------------------------------------------------

// Returns a small facade rather than the composer itself, because the caller
// swaps scene and camera whenever the player changes battle mode and must not
// have to know which passes hold their own references to them.
//
//   opts.quality   "low" | "medium" | "high"   (default: postFXQualityFor())
//   opts.enabled   false to start bypassed     (default: true)
//   opts.ao        "sao" to skip GTAO entirely (default: try GTAO first)
//   opts.aoGBuffer "beauty" (P-02, default): GTAO reads the beauty depth;
//                  "own": GTAO re-renders the scene for its own G-buffer
//                  (kept only so the bench can A/B the two)
//   opts.bloom     { strength, radius, threshold } overrides, or false for
//                  no bloom pass at all (a scene with no emitters: the hangar)
//   opts.aoScale   GTAO's working resolution as a share of the frame (1;
//                  the hangar runs it at 0.5)
//   opts.aoSamples GTAO samples (16; the hangar runs 8, denoise 8 -> 4)
//   opts.aa        'smaa' (default) or 'fxaa' on the high tier: one pass in
//                  place of SMAA's three (the hangar: SMAA cost 4.4-5 ms of
//                  a 1080p frame on Iris Xe, FXAA well under 1)
//   opts.preset    a composed preset: sets the L-07 grade (setPreset later)
//   opts.finish    false to build without the grade/lens pass
export function createPostFX(renderer, scene, camera, opts = {}) {
  if (!renderer) throw new Error('createPostFX: a renderer is required');

  // --- L-07 grade + K-01 finish state (survives a rebuild) -------------------
  let gradeMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let gradeOn = 0;
  let optic = false;
  let lensGrain = LENS.grain;
  let lensVignette = LENS.vignette;
  let finishWanted = opts.finish !== false;
  let frameNo = 0;
  let aoGBuffer = opts.aoGBuffer === 'own' ? 'own' : 'beauty';
  let passHook = null;
  // K-02 (contract R3-S): the player's motion-blur wish. Off until someone
  // asks (main.js, from progress.settings.motionBlur): the hangar's orbiting
  // camera never blurs. It only ever runs on the high tier, outside optics.
  let lensBlur = false;
  let blurSubject = null;          // the player vehicle: it and 12 m beyond stay sharp
  let cloudsFailedFor = null;      // the volume whose march failed (S-01 then)
  const lensCam = {
    have: false,
    camera: null,
    vp: new THREE.Matrix4(),
    proj: new THREE.Matrix4(),
    pos: new THREE.Vector3(),
    fwd: new THREE.Vector3(),
    last: { shutter: 0, near: BLUR_NEAR_PAD, cut: false, active: false, maxPx: 0 },
  };
  const _lensView = new THREE.Matrix4();
  const _lensVP = new THREE.Matrix4();
  const _lensPos = new THREE.Vector3();
  const _lensFwd = new THREE.Vector3();

  const bloomWanted = opts.bloom !== false;
  const aoScale = Number.isFinite(opts.aoScale) ? Math.min(1, Math.max(0.25, opts.aoScale)) : 1;
  const aoSamples = Number.isFinite(opts.aoSamples) ? Math.min(16, Math.max(4, Math.round(opts.aoSamples))) : 16;
  const aaKind = opts.aa === 'fxaa' ? 'fxaa' : 'smaa';
  const bloomOpts = opts.bloom || {};
  let bloomStrength = Number.isFinite(bloomOpts.strength) ? bloomOpts.strength : 0.28;
  let bloomRadius = Number.isFinite(bloomOpts.radius) ? bloomOpts.radius : 0.5;
  let bloomThreshold = Number.isFinite(bloomOpts.threshold) ? bloomOpts.threshold : 0.85;
  // L-05 (bloom only from emitters): the battle scene carries its preset's
  // scene-referred threshold (1.15 x 0.85 x the brightest white card, from
  // preset.light, written by world/scenery.js into scene.userData). Bloom runs
  // on linear HDR before OutputPass applies exposure, so it is used as is.
  let sceneThreshold = NaN;
  function setBloom(o = {}) {
    if (Number.isFinite(o.threshold)) bloomThreshold = o.threshold;
    if (Number.isFinite(o.strength)) bloomStrength = Math.min(0.35, Math.max(0, o.strength));
    if (Number.isFinite(o.radius)) bloomRadius = Math.min(0.6, Math.max(0, o.radius));
    if (bloomPass) {
      bloomPass.threshold = bloomThreshold;
      bloomPass.strength = bloomStrength;
      bloomPass.radius = bloomRadius;
    }
  }
  function syncSceneBloom() {
    const t = curScene && curScene.userData ? curScene.userData.bloomThreshold : undefined;
    if (Number.isFinite(t) && t !== sceneThreshold) {
      sceneThreshold = t;
      setBloom({ threshold: t });
    }
  }

  let curScene = scene || null;
  let curCamera = camera || null;
  let quality = isLevel(opts.quality) ? opts.quality : postFXQualityFor();
  let enabled = opts.enabled !== false;
  let aoPreference = opts.ao === 'sao' ? 'sao' : 'gtao';

  // Once the chain has thrown on a real frame it is never trusted again: a
  // browser that cannot run it will not start being able to halfway through a
  // battle, and retrying every frame would turn a glitch into a slideshow.
  let broken = false;

  let composer = null;
  let renderPass = null;
  let aoPass = null;
  let seeThroughPass = null;
  let bloomPass = null;
  let outputPass = null;
  let smaaPass = null;
  let finishPass = null;
  let depthPass = null;    // S-02 / K-02 (high only), see LinearDepthPass
  let cloudPass = null;
  let blurPass = null;
  // P-02: the ONE depth buffer of the frame. Both composer targets draw into
  // it (see "opaque first" above), GTAO reads it instead of re-rendering the
  // scene for a G-buffer of its own, and later passes get it as
  // postfx.depthTexture. GTAO reads it with the opaque scene only in it; on
  // both tiers it ends the frame as the frame's depth (opaque, plus the few
  // see-through materials that write depth, e.g. canopy glass). Valid from the
  // end of the scene draw to the end of the chain: the full-screen passes are
  // kept from writing their own depth into it (see build()).
  let sharedDepth = null;

  const split = createSceneSplit();
  const getScene = () => curScene;
  const getCamera = () => curCamera;

  const size = new THREE.Vector2();
  renderer.getSize(size);
  let width = Math.max(1, Math.floor(size.x) || 1);
  let height = Math.max(1, Math.floor(size.y) || 1);

  // --- P-04 render scale (dynamic resolution) --------------------------------
  // The composer's buffers are drawn at renderScale x the canvas resolution and
  // the last pass (always a screen pass) stretches the result over the full
  // canvas, which keeps its own size: the HUD is DOM over it and stays sharp.
  // With opts.autoScale the scale follows the measured GPU time of the chain
  // (its own timer query, or reportGpuMs() from a bench that owns the timer)
  // toward opts.targetMs, in 0.05 steps no more than once a second, between
  // opts.minScale and 1. Without a timer query the frame interval stands in,
  // and then only a clearly slow frame rate lowers it.
  let renderScale = 1;
  const auto = {
    on: !!opts.autoScale,
    // a number, or one per tier: { high: 12, medium: 8.5 }
    target: Number.isFinite(opts.targetMs) || (opts.targetMs && typeof opts.targetMs === 'object') ? opts.targetMs : 12,
    // the floor; the low tier may go a step further (0.5): it has no chain
    // to spend the pixels on and its player asked for speed
    min: Number.isFinite(opts.minScale) ? Math.min(1, Math.max(0.4, opts.minScale)) : 0.6,
    ema: NaN,
    n: 0,
    lastChange: 0,
    lastDown: -1e9,
    lastFrame: NaN,
    external: 0,          // performance.now() of the last reportGpuMs()
    lastMs: NaN,
    // the slow tail: p90 of the last 90 GPU samples held under opts.tailMs
    // (number or per tier; default 1.2 x the target), since a frame budget
    // is about the bad frames, not the average one
    tail: opts.tailMs && (Number.isFinite(opts.tailMs) || typeof opts.tailMs === 'object') ? opts.tailMs : null,
    ring: new Float32Array(90),
    sorted: new Float32Array(90),
    probe: null,          // { before, scale } of an untimed step down on trial
    capped: -1e9,         // when an untimed step down did not help
  };
  const pixelRatio = () => (renderer.getPixelRatio() || 1) * renderScale;
  function effective() {
    const pr = pixelRatio();
    return [Math.max(1, Math.round(width * pr)), Math.max(1, Math.round(height * pr))];
  }

  function teardown() {
    split.end();
    if (composer) {
      try {
        composer.dispose();
      } catch {
        /* ignore */
      }
    }
    disposePass(renderPass);
    disposePass(aoPass);
    disposePass(seeThroughPass);
    disposePass(bloomPass);
    disposePass(outputPass);
    disposePass(smaaPass);
    disposePass(finishPass);
    disposePass(depthPass);
    disposePass(cloudPass);
    disposePass(blurPass);
    if (sharedDepth) sharedDepth.dispose();
    composer = null;
    renderPass = null;
    aoPass = null;
    seeThroughPass = null;
    bloomPass = null;
    outputPass = null;
    smaaPass = null;
    finishPass = null;
    depthPass = null;
    cloudPass = null;
    blurPass = null;
    sharedDepth = null;
    lensCam.have = false;
  }

  // --- S-02 / K-02, once per frame before the chain runs -------------------
  // The scene's cloud volume (world/scenery.js publishes one for air
  // battles): the slab replaces the S-01 deck while the cloud pass can run,
  // the deck comes back the moment it cannot.
  function sceneVolume() {
    const ud = curScene && curScene.userData;
    return ud && ud.cloudVolume ? ud.cloudVolume : null;
  }
  function showDeck(vol, on) {
    if (vol && vol.deck && vol.deck.visible !== on) vol.deck.visible = on;
  }
  function syncLens(dt) {
    const cam = curCamera;
    const vol = sceneVolume();
    if (cloudPass && cloudPass.failed && vol) cloudsFailedFor = vol;
    const clouds = !!(cloudPass && vol && cloudsFailedFor !== vol);
    if (cloudPass) {
      if (cloudPass.vol !== vol) {
        cloudPass.failed = false;
        cloudPass.checked = false;
      }
      cloudPass.enabled = clouds;
      cloudPass.vol = clouds ? vol : null;
      cloudPass.camera = cam;
    }
    showDeck(vol, !clouds);

    // camera history for the reprojection (every frame, blur or not)
    let blur = false;
    const L = lensCam.last;
    L.cut = false;
    if (blurPass && cam) {
      cam.updateMatrixWorld();
      _lensView.copy(cam.matrixWorld).invert();
      _lensVP.multiplyMatrices(cam.projectionMatrix, _lensView);
      _lensPos.setFromMatrixPosition(cam.matrixWorld);
      _lensFwd.set(0, 0, -1).transformDirection(cam.matrixWorld);
      let ok = lensCam.have && lensCam.camera === cam && dt > 0;
      if (ok) {
        // a cut (respawn, mode switch, sight, zoom) is not a motion
        const pe = cam.projectionMatrix.elements;
        const qe = lensCam.proj.elements;
        let dp = 0;
        for (let i = 0; i < 16; i++) dp += Math.abs(pe[i] - qe[i]);
        if (dp > 1e-3 || _lensPos.distanceTo(lensCam.pos) > 60 || _lensFwd.angleTo(lensCam.fwd) > 0.6) {
          ok = false;
          L.cut = true;
        }
      }
      blur = lensBlur && !optic && ok;
      if (blur) {
        const shutter = Math.min(0.5 * dt, BLUR_MAX_EXPOSURE) / dt;
        const sp = blurSubject && blurSubject.position;
        let d = sp && Number.isFinite(sp.x) ? _lensPos.distanceTo(sp) : 0;
        // a camera that is not riding the vehicle (a death or spectator
        // view, a debug pose) would otherwise keep everything out to it sharp
        if (!(d <= BLUR_SUBJECT_MAX)) d = 0;
        const near = d + BLUR_NEAR_PAD;
        L.shutter = shutter;
        L.near = near;
        // the largest streak this frame can have (frame centre and corners,
        // at the nearest blurred depth and at the sky): under half a pixel,
        // the pass is skipped, so a still or slow camera costs nothing
        L.maxPx = maxStreakPx(cam, lensCam.vp, near, shutter, blurPass.w, blurPass.h);
        blur = L.maxPx >= 0.5;
        if (blur) {
          const u = blurPass.uniforms;
          u.uInvProj.value.copy(cam.projectionMatrixInverse);
          u.uCamWorld.value.copy(cam.matrixWorld);
          u.uPrevViewProj.value.copy(lensCam.vp);
          u.uShutter.value = shutter;
          u.uNear.value = near;
        }
      } else {
        L.maxPx = 0;
      }
      lensCam.vp.copy(_lensVP);
      lensCam.proj.copy(cam.projectionMatrix);
      lensCam.pos.copy(_lensPos);
      lensCam.fwd.copy(_lensFwd);
      lensCam.camera = cam;
      lensCam.have = true;
      blurPass.enabled = blur;
    }
    L.active = blur;
    if (depthPass) {
      depthPass.enabled = clouds || blur;
      depthPass.source = sharedDepth;
      depthPass.camera = cam;
    }
  }

  // Push the grade / lens state into the finish pass. Off inside optics: the
  // pass is DISABLED there rather than set to identity, so EffectComposer
  // hands the screen to the pass before it and the sight picture is
  // bit-identical to a chain without the finish (L-07, K-01).
  function syncFinish() {
    if (!finishPass) return;
    finishPass.enabled = finishWanted && !optic;
    const u = finishPass.uniforms;
    const m = gradeMatrix;
    u.uGrade.value.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    u.uGradeOn.value = gradeOn;
    u.uGrain.value = lensGrain;
    u.uVignette.value = lensVignette;
  }

  // Builds the chain for the current quality. Returns false — leaving the
  // object in the bypassed state — if anything at all refuses to allocate, so
  // the caller's fallback path is the only thing that has to work.
  function build() {
    teardown();
    if (quality === 'low' || !curScene || !curCamera) return false;

    const [ew, eh] = effective();
    try {
      // EffectComposer's own buffer is already HalfFloat and already sized from
      // the renderer; handing it one built here only risks disagreeing with it
      // about whether a dimension is CSS pixels or device pixels.
      composer = new EffectComposer(renderer);
      composer.setPixelRatio(pixelRatio());
      composer.setSize(width, height);

      renderPass = new RenderPass(curScene, curCamera);
      renderPass.__kind = 'render';
      if (quality === 'high') {
        aoPass = buildAO(curScene, curCamera, Math.max(1, Math.round(ew * aoScale)), Math.max(1, Math.round(eh * aoScale)), aoPreference, aoSamples);
        if (aoPass && aoScale < 1) {
          // the composer resizes every pass to the frame; this one works at
          // its share of it (its depth reads are by uv, so any size works)
          const setSize = aoPass.setSize.bind(aoPass);
          aoPass.setSize = (w, h) => setSize(Math.max(1, Math.round(w * aoScale)), Math.max(1, Math.round(h * aoScale)));
        }
      }

      // P-02: one depth texture for the frame, on every tier with a composer.
      // The see-through half depth-tests against the opaque half's depth from
      // whichever composer buffer GTAO left the picture in, so both buffers
      // get the same texture (three sizes it to the targets when they are
      // bound).
      sharedDepth = new THREE.DepthTexture(ew, eh);
      composer.renderTarget1.depthTexture = sharedDepth;
      composer.renderTarget2.depthTexture = sharedDepth;

      // S-02 slab and K-02 blur: high only (backlog 4.3). Built disabled and
      // without targets; syncLens() switches them on per frame, and their
      // buffers are allocated on first use (the hangar never pays for them).
      if (quality === 'high') {
        depthPass = new LinearDepthPass();
        depthPass.source = sharedDepth;
        cloudPass = new CloudPass(depthPass);
        blurPass = new MotionBlurPass(depthPass);
      }
      const addSkyPasses = () => {
        if (depthPass) composer.addPass(depthPass);
        if (cloudPass) composer.addPass(cloudPass);
      };

      if (aoPass) {
        // GTAO on the beauty depth: no normal texture, so its shader
        // reconstructs normals from depth (NORMAL_VECTOR_TYPE 0) and it never
        // re-renders the scene. The pass was constructed with its own
        // G-buffer target (setGBuffer() with a depth texture in the
        // constructor reads a target that does not exist yet in r170), which
        // is simply never drawn into and so never allocated on the GPU.
        if (aoPass.__kind === 'gtao' && aoGBuffer === 'beauty') {
          aoPass.setGBuffer(sharedDepth, undefined);
          aoPass.gtaoMaterial.needsUpdate = true;
          aoPass.pdMaterial.needsUpdate = true;
          aoPass.__gbuffer = 'beauty';
        } else if (aoPass.__kind === 'gtao') {
          aoPass.__gbuffer = 'own';
        }
        composer.addPass(splitOpaquePass(renderPass, split, getScene));
        composer.addPass(occlusionPass(aoPass, getScene));
        addSkyPasses();
        seeThroughPass = new SeeThroughPass(split, getScene, getCamera);
        seeThroughPass.__kind = 'seeThrough';
        composer.addPass(seeThroughPass);
      } else {
        composer.addPass(renderPass);
        addSkyPasses();
      }
      // K-02 on everything the frame holds, before the bloom finds its peaks
      if (blurPass) composer.addPass(blurPass);

      if (bloomWanted) {
        bloomPass = new UnrealBloomPass(
          new THREE.Vector2(ew, eh),
          bloomStrength,
          bloomRadius,
          bloomThreshold,
        );
        bloomPass.__kind = 'bloom';
        composer.addPass(bloomPass);
        guardBloom(bloomPass);
      }

      // Last of the colour passes, always. Everything above it works in linear
      // HDR precisely because this one has not run yet.
      outputPass = new OutputPass();
      outputPass.__kind = 'output';
      guardOutput(outputPass, ew, eh);
      composer.addPass(keepDepth(outputPass));

      if (quality === 'high' && aaKind === 'fxaa') {
        // the hangar's cheaper edge filter (opts.aa); one display-referred pass
        const fx = new ShaderPass(FXAAShader);
        fx.__kind = 'fxaa';
        fx.material.depthTest = false;
        fx.material.depthWrite = false;
        const setRes = (w, h) => fx.uniforms.resolution.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
        setRes(ew, eh);
        fx.setSize = setRes;
        smaaPass = fx;
        composer.addPass(keepDepth(fx));
      } else if (quality === 'high') {
        // The canvas is created with antialias:true, but MSAA only exists on
        // the default framebuffer — the moment a composer is in the way it is
        // gone, and SMAA is what puts an edge filter back.
        smaaPass = new SMAAPass(ew, eh);
        smaaPass.__kind = 'smaa';
        composer.addPass(keepDepth(smaaPass));
      }

      // L-07 + K-01: last, on the finished display-referred picture.
      finishPass = makeFinishPass();
      composer.addPass(keepDepth(finishPass));
      syncFinish();

      // P-02: the depth stays the scene's for the whole frame. Two things
      // would overwrite it in whichever composer buffer a full-screen pass
      // lands in: the auto-clear before its draw (keepDepth above), and its
      // triangle at depth 0 under three's default depthTest / depthWrite.
      // The scene-free passes after the beauty never test depth, so they stop
      // writing it too (GTAO's and bloom's own blends already do).
      for (const m of [
        outputPass.material,
        smaaPass && smaaPass.materialBlend,
        finishPass.material,
      ]) {
        if (!m) continue;
        m.depthTest = false;
        m.depthWrite = false;
      }
      if (passHook) {
        try {
          passHook(composer.passes);
        } catch {
          /* an instrument must never cost the chain */
        }
      }
      return !!composer;
    } catch {
      teardown();
      broken = true;
      return false;
    }
  }

  function active() {
    return enabled && !broken && quality !== 'low' && !!composer && !!curScene && !!curCamera;
  }

  function direct() {
    // no chain, no slab: the S-01 deck is the sky's clouds (S-02 fallback)
    showDeck(sceneVolume(), true);
    if (curScene && curCamera) renderer.render(curScene, curCamera);
  }

  if (opts.preset) {
    const g = gradeFor(opts.preset);
    gradeMatrix = g.matrix.slice();
    gradeOn = g.identity ? 0 : 1;
  }

  build();

  // P-04: one TIME_ELAPSED query around the chain per frame, read back a few
  // frames later. Never while a pass hook is set: the bench times the passes
  // itself (queries cannot nest) and feeds its totals in via reportGpuMs().
  const gpuQ = (() => {
    try {
      const gl = renderer.getContext();
      const ext = gl && gl.getExtension && gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext || typeof gl.createQuery !== 'function') return null;
      return { gl, ext, open: null, pending: [] };
    } catch {
      return null;
    }
  })();
  function gpuBegin() {
    if (!gpuQ || !auto.on || passHook || gpuQ.pending.length > 6) return false;
    // someone else (the bench) owns the timer: its whole-frame query may be
    // open, and TIME_ELAPSED queries cannot nest
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - auto.external < 2000) return false;
    const { gl, ext } = gpuQ;
    try {
      if (typeof gl.getQuery === 'function' && gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return false;
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      // a failed begin leaves q a name that was never a query object
      if (typeof gl.isQuery === 'function' && !gl.isQuery(q)) {
        gl.deleteQuery(q);
        gpuQ.open = null;
        return false;
      }
      gpuQ.open = q;
      return true;
    } catch {
      gpuQ.open = null;
      return false;
    }
  }
  function gpuEnd() {
    if (!gpuQ || !gpuQ.open) return;
    try {
      gpuQ.gl.endQuery(gpuQ.ext.TIME_ELAPSED_EXT);
      gpuQ.pending.push(gpuQ.open);
    } catch {
      /* ignore */
    }
    gpuQ.open = null;
  }
  function gpuPoll() {
    if (!gpuQ || !gpuQ.pending.length) return;
    const { gl, ext } = gpuQ;
    let disjoint = false;
    try {
      disjoint = !!gl.getParameter(ext.GPU_DISJOINT_EXT);
    } catch {
      disjoint = true;
    }
    while (gpuQ.pending.length) {
      const q = gpuQ.pending[0];
      if (typeof gl.isQuery === 'function' && !gl.isQuery(q)) {
        gpuQ.pending.shift();
        continue;
      }
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      gl.deleteQuery(q);
      gpuQ.pending.shift();
      if (!disjoint) sampleGpu(ns / 1e6);
    }
  }
  function minScale() {
    // low may go one step pair further than the floor (0.6 -> 0.5)
    return quality === 'low' ? Math.max(0.4, auto.min - 0.1) : auto.min;
  }
  function targetMs() {
    const t = auto.target;
    const v = t && typeof t === 'object' ? t[quality] : t;
    return Number.isFinite(v) && v > 0 ? v : 12;
  }
  function tailMs() {
    const t = auto.tail;
    const v = t && typeof t === 'object' ? t[quality] : t;
    return Number.isFinite(v) && v > 0 ? v : targetMs() * 1.2;
  }
  // p90 of the samples since the last scale change (NaN under 20 of them)
  function p90() {
    const n = Math.min(auto.n, auto.ring.length);
    if (n < 20) return NaN;
    const a = auto.sorted.subarray(0, n);
    a.set(auto.ring.subarray(0, n));
    a.sort();
    return a[Math.min(n - 1, Math.floor(n * 0.9))];
  }
  function sampleGpu(ms) {
    if (!(ms > 0) || ms > 500) return;
    auto.ring[auto.n % auto.ring.length] = ms;
    auto.lastMs = ms;
    auto.ema = Number.isFinite(auto.ema) ? auto.ema * 0.9 + ms * 0.1 : ms;
    auto.n++;
  }
  // the renderer's own pixel ratio while the low tier has scaled it, else NaN
  let basePR = NaN;
  function restoreCanvas() {
    if (!Number.isFinite(basePR)) return;
    try {
      renderer.setPixelRatio(basePR);
    } catch {
      /* ignore */
    }
    basePR = NaN;
  }
  function resetScale() {
    restoreCanvas();
    if (composer && renderScale !== 1) setScale(1);
    renderScale = 1;
    auto.ema = NaN;
    auto.n = 0;
  }
  function setScale(s) {
    const q = Math.round(Math.min(1, Math.max(minScale(), s)) * 20) / 20;
    if (q === renderScale) return renderScale;
    renderScale = q;
    auto.ema = NaN;
    auto.n = 0;
    if (!composer && quality === 'low') {
      // no chain on low: the canvas itself is drawn smaller (its CSS size
      // stays, so the browser stretches it and the DOM HUD stays sharp)
      if (!Number.isFinite(basePR)) basePR = renderer.getPixelRatio() || 1;
      renderer.setPixelRatio(basePR * renderScale);
      if (renderScale === 1) basePR = NaN;
    } else if (composer) {
      try {
        composer.setPixelRatio(pixelRatio());
        composer.setSize(width, height);
      } catch {
        broken = true;
        teardown();
      }
    }
    return renderScale;
  }
  // A step up is taken when the cost it predicts still fits, with 3 % to
  // spare (the step down fires at +6 %): three quarters of the GPU time is
  // taken to follow the pixel count, the rest (the shadow map, fixed-size
  // passes) not. A fixed 0.8 x margin used to strand a cheap tier at its
  // floor, since that fixed share never shrinks with the resolution.
  function upFits(e, p, target, tail) {
    const s = renderScale;
    const k = 1 + 0.75 * (((s + 0.05) / s) ** 2 - 1);
    return e * k < target * 0.97 && !(p * k > tail * 0.97);
  }
  // once a frame: the frame interval stands in for a missing timer query, and
  // every second the scale may take one step toward the target
  function steerScale() {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const iv = Number.isFinite(auto.lastFrame) ? now - auto.lastFrame : NaN;
    auto.lastFrame = now;
    const timed = (gpuQ && !passHook) || now - auto.external < 2000;
    if (!timed && iv > 0 && iv < 200) sampleGpu(iv);
    if (!auto.on || auto.n < 20 || now - auto.lastChange < 1000) return;
    const e = auto.ema;
    // Without GPU time the frame interval is all there is, and a browser
    // that caps rAF (30 fps energy saver, a 30 Hz panel) or a busy CPU makes
    // it slow whatever the resolution. So every step down without a timer is
    // a probe: if the frame interval did not answer it (still >= 92 % of what
    // it was), the step is taken back and the scale stays put for a minute.
    if (auto.probe) {
      const pr = auto.probe;
      auto.probe = null;
      if (!timed && e > pr.before * 0.92) {
        auto.capped = now;
        setScale(pr.scale);
        auto.lastChange = now;
        return;
      }
    }
    if (!timed && now - auto.capped < 60000) return;
    // without GPU time only a clearly slow frame rate (< ~45 fps) counts
    const target = timed ? targetMs() : 22;
    const tail = timed ? tailMs() : Infinity;
    const p = timed ? p90() : NaN;
    const overMean = e > target * 1.06;
    const overTail = p > tail;
    if ((overMean || overTail) && renderScale > minScale()) {
      if (!timed) auto.probe = { before: e, scale: renderScale };
      // cost is roughly pixels (scale squared), a little less in practice
      const ratio = Math.min(overMean ? target / e : 1, overTail ? tail / p : 1);
      const want = renderScale * Math.sqrt(ratio) * 0.98;
      setScale(Math.min(renderScale - 0.05, want));
      auto.lastChange = now;
      auto.lastDown = now;
    } else if (renderScale < 1 && (timed ? upFits(e, p, target, tail) : e < 18 && now - auto.lastDown > 10000)) {
      setScale(renderScale + 0.05);
      auto.lastChange = now;
    }
  }

  const api = {
    // --- the chain -------------------------------------------------------
    render(dt) {
      if (!active()) {
        const lowAuto = quality === 'low' && enabled && auto.on;
        if (lowAuto) {
          gpuPoll();
          steerScale();
        }
        const timing = lowAuto && gpuBegin();
        direct();
        if (timing) gpuEnd();
        return;
      }
      gpuPoll();
      steerScale();
      syncSceneBloom();
      syncLens(Number.isFinite(dt) ? dt : 0);
      if (aoPass && aoPass.__kind === 'sao' && curCamera && aoPass.__far !== curCamera.far) tuneSAO(aoPass, curCamera);
      if (finishPass) {
        finishPass.uniforms.uSeed.value = (frameNo = (frameNo + 1) % 4096);
        const sz = composer.renderTarget1;
        finishPass.uniforms.uAspect.value = sz.height > 0 ? sz.width / sz.height : 16 / 9;
        // P-04: sharpen a frame drawn below the canvas resolution, more the
        // further below it is (0.6 at the 0.6 floor)
        finishPass.uniforms.uSharp.value = renderScale < 1 ? Math.min(0.6, (1 - renderScale) * 1.5) : 0;
        finishPass.uniforms.uTexel.value.set(1 / Math.max(1, sz.width), 1 / Math.max(1, sz.height));
      }
      const timing = gpuBegin();
      try {
        composer.render(Number.isFinite(dt) ? dt : 0);
        if (timing) gpuEnd();
      } catch (e) {
        if (timing) gpuEnd();
        // One bad frame is allowed to cost the effects, never the battle. If
        // GTAO was the thing in the chain, try once more without it before
        // giving up on post entirely.
        if (aoPass && aoPass.__kind === 'gtao' && aoPreference !== 'sao') {
          aoPreference = 'sao';
          if (build() && active()) {
            try {
              syncLens(0);
              composer.render(Number.isFinite(dt) ? dt : 0);
              return;
            } catch {
              /* fall through to the bypass */
            }
          }
        }
        broken = true;
        teardown();
        direct();
      } finally {
        // a pass that threw between the halves must not leave half the
        // scene's materials switched off
        split.end();
      }
    },

    setSize(w, h) {
      width = Math.max(1, Math.floor(w) || 1);
      height = Math.max(1, Math.floor(h) || 1);
      if (!composer) return;
      try {
        composer.setPixelRatio(pixelRatio());
        composer.setSize(width, height);
      } catch {
        broken = true;
        teardown();
      }
    },

    // --- what it is looking at -------------------------------------------
    // The battle object is thrown away and rebuilt when the player switches
    // mode, so these exist to hand the new one to the passes that cached the
    // old. Cheap and idempotent: calling them every frame costs two identity
    // comparisons.
    setScene(scn) {
      if (!scn || scn === curScene) return;
      curScene = scn;
      if (renderPass) renderPass.scene = scn;
      if (aoPass) aoPass.scene = scn;
      if (!composer && !broken && quality !== 'low') build();
    },

    setCamera(cam) {
      if (!cam || cam === curCamera) return;
      curCamera = cam;
      if (renderPass) renderPass.camera = cam;
      if (aoPass) {
        // Both passes re-read near, far and the projection matrices from
        // this.camera every frame, so the assignment is the whole handover —
        // except for SAO's falloff, which is derived from the far plane once.
        aoPass.camera = cam;
        if (aoPass.__kind === 'sao') tuneSAO(aoPass, cam);
      }
      if (!composer && !broken && quality !== 'low') build();
    },

    // --- quality ----------------------------------------------------------
    setQuality(level) {
      if (!isLevel(level) || level === quality) return quality;
      // every tier starts again from full resolution (and the canvas from
      // its own pixel ratio, if the low tier had lowered it)
      resetScale();
      quality = level;
      if (quality === 'low') {
        // Free the buffers rather than leave them allocated behind a flag: on
        // the machines that ask for "low" the VRAM is the reason they did.
        teardown();
      } else {
        // A chain that failed once gets exactly one more chance, because the
        // player asking for a different tier is asking for a different chain.
        broken = false;
        build();
      }
      return quality;
    },

    getQuality() {
      return quality;
    },

    // --- P-04 render scale ------------------------------------------------
    // The share of the canvas resolution the chain draws at (0.4..1).
    get renderScale() {
      return renderScale;
    },
    // A fixed scale (auto stays as it was; call setAutoScale(false) to pin).
    setRenderScale(s) {
      return Number.isFinite(s) ? setScale(s) : renderScale;
    },
    // { enabled, targetMs, minScale }; enabled false puts the scale back to 1.
    setAutoScale(o = {}) {
      const cfg = typeof o === 'boolean' ? { enabled: o } : o;
      if (cfg.enabled !== undefined) auto.on = !!cfg.enabled;
      if (Number.isFinite(cfg.targetMs)) auto.target = Math.max(4, cfg.targetMs);
      else if (cfg.targetMs && typeof cfg.targetMs === 'object') auto.target = { ...cfg.targetMs };
      if (Number.isFinite(cfg.minScale)) auto.min = Math.min(1, Math.max(0.4, cfg.minScale));
      if (Number.isFinite(cfg.tailMs)) auto.tail = Math.max(4, cfg.tailMs);
      else if (cfg.tailMs && typeof cfg.tailMs === 'object') auto.tail = { ...cfg.tailMs };
      if (!auto.on) resetScale();
      else if (renderScale < minScale()) setScale(minScale());
      auto.ema = NaN;
      auto.n = 0;
      return { enabled: auto.on, targetMs: auto.target, minScale: auto.min, scale: renderScale };
    },
    // A GPU time for the whole chain measured by someone else (the bench).
    reportGpuMs(ms) {
      auto.external = typeof performance !== 'undefined' ? performance.now() : Date.now();
      sampleGpu(ms);
    },
    // What the controller sees: { enabled, scale, ema, last, targetMs, timer }.
    get autoScaleState() {
      return {
        enabled: auto.on, scale: renderScale, ema: auto.ema, last: auto.lastMs, targetMs: auto.target, timer: !!gpuQ,
        // this tier's target, and whether the frame rate was found not to
        // follow the resolution (a rAF cap or the CPU: no GPU timer)
        target: targetMs(), tail: tailMs(), p90: p90(), floor: minScale(), capped: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - auto.capped < 60000,
      };
    },

    // L-05: { threshold, strength, radius }; strength <= 0.35, radius <= 0.6
    // (art bible 8.6). A battle scene's own threshold (scene.userData) is
    // picked up automatically; this is for anyone who wants to override it.
    setBloom,

    // --- L-07 grade, K-01 finish -----------------------------------------
    // The grade of a composed preset (gradeFor); null/undefined = identity.
    setPreset(preset) {
      const g = preset ? gradeFor(preset) : null;
      gradeMatrix = g ? g.matrix.slice() : [1, 0, 0, 0, 1, 0, 0, 0, 1];
      gradeOn = g && !g.identity ? 1 : 0;
      syncFinish();
      return g;
    },

    // A battle sight is up: grade, vignette and grain all off, and the sight
    // picture is bit-identical to a chain without them (the battle optics
    // carry their own H-30 field stop).
    setOptic(on) {
      const want = !!on;
      if (want === optic) return;
      optic = want;
      syncFinish();
    },

    // Contract R3-S lands the player's toggles here: { blur: bool, grain:
    // bool|number, vignette: bool|number, finish: bool }. Numbers are capped
    // at the K-01 limits (grain sigma <= 1.2 levels, vignette <= 0.2). blur
    // (K-02) only ever draws on the high tier and outside optics.
    setLens(o = {}) {
      if (o.blur !== undefined) {
        const want = !!o.blur;
        if (want !== lensBlur) {
          lensBlur = want;
          lensCam.have = false;
        }
      }
      if (o.grain !== undefined) {
        lensGrain = o.grain === true ? LENS.grain : o.grain === false ? 0
          : Math.min(1.2, Math.max(0, Number(o.grain) || 0));
      }
      if (o.vignette !== undefined) {
        lensVignette = o.vignette === true ? LENS.vignette : o.vignette === false ? 0
          : Math.min(0.2, Math.max(0, Number(o.vignette) || 0));
      }
      if (o.finish !== undefined) finishWanted = !!o.finish;
      syncFinish();
    },

    // K-02: the object whose pixels the blur leaves alone (the player vehicle:
    // everything nearer than camera->it + 12 m). null: the nearest 12 m.
    setMotionSubject(obj) {
      blurSubject = obj && obj.position ? obj : null;
    },

    // What the lens did on the last frame, for tests and the debug console:
    // { blur: wanted, active, shutter, near (m), cut, maxPx (longest streak) }.
    get lensState() {
      const L = lensCam.last;
      return {
        blur: lensBlur, active: L.active, shutter: L.shutter, near: L.near, cut: L.cut, maxPx: L.maxPx,
      };
    },

    // S-02 on the last frame: { active, failed, low: [w, h], full: [w, h] }
    // (active false and no pass: medium / low, S-01 draws the clouds).
    get cloudState() {
      if (!cloudPass) return { active: false, failed: false, low: null, full: null };
      return {
        active: !!cloudPass.enabled,
        failed: !!cloudPass.failed || (cloudsFailedFor !== null && cloudsFailedFor === sceneVolume()),
        low: [cloudPass.lowW, cloudPass.lowH],
        full: [cloudPass.fullW, cloudPass.fullH],
      };
    },

    // P-02 contract: the frame's depth (DepthTexture), or null on low, when
    // bypassed or broken. Consumers skip their pass on null.
    get depthTexture() {
      return active() ? sharedDepth : null;
    },

    // Bench: called with composer.passes after every (re)build, so a GPU
    // timer can wrap each pass. Instrumentation only.
    setPassHook(fn) {
      passHook = typeof fn === 'function' ? fn : null;
      if (passHook && composer) {
        try {
          passHook(composer.passes);
        } catch {
          /* ignore */
        }
      }
    },

    // Bench A/B of P-02: 'beauty' (GTAO on the beauty depth) or 'own'.
    get aoGBuffer() {
      return aoPass && aoPass.__gbuffer ? aoPass.__gbuffer : null;
    },
    set aoGBuffer(v) {
      const want = v === 'own' ? 'own' : 'beauty';
      if (want === aoGBuffer) return;
      aoGBuffer = want;
      if (composer && !broken) build();
    },

    get aoPassObject() {
      return aoPass;
    },

    // True only while the composer is genuinely doing the work.
    get running() {
      return active();
    },

    // --- P-04 shader warm-up ------------------------------------------------
    // What the scene is drawn into: a program's tone mapping and output
    // colour space follow the bound target, so a warm-up compiling for the
    // canvas while the chain draws into its buffers compiles the wrong
    // variant of every material. null on the direct (low) path.
    compileTarget() {
      return active() ? composer.readBuffer : null;
    },
    // Compile the chain's own full-screen programs ahead of its first frame
    // (in parallel where the browser has KHR_parallel_shader_compile). Each
    // material is hung on a throw-away quad in a scene with no lights and no
    // fog, the state a pass's FullScreenQuad draws it in; screen passes are
    // compiled for the canvas, the rest for a buffer.
    warmUp() {
      if (!active() || typeof renderer.compile !== 'function') return Promise.resolve();
      const toRT = new THREE.Scene();
      const toScreen = new THREE.Scene();
      const geo = new THREE.PlaneGeometry(2, 2);
      const seen = new Set();
      const add = (m, screen) => {
        if (!m || !m.isMaterial || seen.has(m)) return;
        seen.add(m);
        const mesh = new THREE.Mesh(geo, m);
        mesh.frustumCulled = false;
        (screen ? toScreen : toRT).add(mesh);
      };
      // the composer only marks its last enabled pass renderToScreen while it
      // renders, so work it out the same way here
      let last = -1;
      composer.passes.forEach((p, i) => {
        if (p && p.enabled !== false) last = i;
      });
      for (let i = 0; i < composer.passes.length; i++) {
        const pass = composer.passes[i];
        if (!pass) continue;
        const screen = composer.renderToScreen !== false && i === last;
        for (const k of Object.keys(pass)) {
          const v = pass[k];
          if (!v || typeof v !== 'object') continue;
          if (v.isMaterial) add(v, screen);
          else if (v.material && v.material.isMaterial) add(v.material, screen);
          else if (v._mesh && v._mesh.material) add(v._mesh.material, screen);
        }
      }
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const prev = renderer.getRenderTarget();
      const jobs = [];
      try {
        renderer.setRenderTarget(composer.readBuffer);
        if (toRT.children.length) jobs.push(compileQuietly(renderer, toRT, cam));
        renderer.setRenderTarget(null);
        if (toScreen.children.length) jobs.push(compileQuietly(renderer, toScreen, cam));
      } catch {
        /* the first frame compiles them, as before */
      } finally {
        renderer.setRenderTarget(prev);
      }
      const end = () => geo.dispose();
      return Promise.all(jobs).then(end, end);
    },

    // Which ambient-occlusion pass survived construction, for anyone debugging
    // a machine where GTAO fell back.
    get aoKind() {
      return aoPass ? aoPass.__kind : null;
    },

    dispose() {
      teardown();
      resetScale();
      if (gpuQ) {
        for (const q of gpuQ.pending) {
          try {
            gpuQ.gl.deleteQuery(q);
          } catch {
            /* ignore */
          }
        }
        gpuQ.pending.length = 0;
      }
      curScene = null;
      curCamera = null;
      enabled = false;
    },
  };

  // `composer` and `enabled` are read (and `enabled` written) by name in the
  // contract main.js was given, but both change underneath a quality switch, so
  // they are accessors rather than snapshots.
  Object.defineProperty(api, 'composer', {
    enumerable: true,
    get() {
      return composer;
    },
  });

  Object.defineProperty(api, 'enabled', {
    enumerable: true,
    get() {
      return enabled;
    },
    set(v) {
      const want = !!v;
      if (want === enabled) return;
      enabled = want;
      if (enabled && !composer && !broken && quality !== 'low') build();
    },
  });

  return api;
}

// ---------------------------------------------------------------------------
// L-09 / H-08: the photo rig — a battle's light, for the hangar and thumbnails
// ---------------------------------------------------------------------------
//
// A deliberate COPY of what world/scenery.js builds for a battle in
// setupEnvironment() + addSky() + updateEnvironment() (the backlog prefers the
// copy in this wave: scenery.js has another owner, and its rig is module-global
// — one battle at a time — while the hangar and the thumbnails need their own
// next to whatever the battle renderer holds):
//
//   sun     DirectionalLight(preset.sunColor, preset.sunIntensity) from the
//           sun on the dome, with the battle's caster floor (CASTER_FLOOR)
//   hemi    HemisphereLight at preset.light.hemiIntensity (ground bounce)
//   IBL     a PMREM of the Preetham dome with its sun disc off and the lit
//           ground below the horizon, at preset.light.envIntensity; replaced
//           by the preset's CC0 HDRI (normalised to the same horizontal
//           irradiance) once decoded, when opts.hdri is on
//   fog     the L-06 height law at the preset's visibility, horizon colour
//   dome    the same Sky.js dome at preset.skyScale, its lowest 4.6 degrees
//           melting into the fog colour (opts.dome)
//   expose  AgX at preset.light.exposure; scene.userData.bloomThreshold for
//           createPostFX (L-05)
//
// KEEP THE SHADER PATCH BELOW IN STEP WITH scenery.js addSky(). Any change to
// the battle's dome (disc size, horizon band, bake ground) must be mirrored
// here or the hangar card stops matching the battle card (L-09 accept: +/- 3).
const NL = String.fromCharCode(10);
function patchSkyMaterial(material, u) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSkyScale = u.uSkyScale;
    shader.uniforms.uSkyBake = u.uBake;
    shader.uniforms.uSkyGround = u.uGround;
    shader.uniforms.uSkyFog = u.uFogCol;
    // S-01 cirrus (core/atmosphere.js), as scenery.js addSky draws it
    if (u.uCirrus) {
      shader.uniforms.uCirrus = u.uCirrus;
      shader.uniforms.uCirrusSun = u.uCirrusSun;
      shader.uniforms.uCirrusAmb = u.uCirrusAmb;
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', ['uniform float uSkyScale;', 'uniform float uSkyBake;', 'uniform vec3 uSkyGround;', 'uniform vec3 uSkyFog;', CIRRUS_GLSL, 'void main() {'].join(NL))
      .replace(
        'float sundisk = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta );',
        `float sunSin = length( cross( direction, vSunDirection ) );
			float sundisk = ( 1.0 - smoothstep( 0.004305, 0.004655 + 0.000349, sunSin ) ) * step( 0.0, cosTheta ) * ( 1.0 - uSkyBake );`,
      )
      .replace(
        /gl_FragColor\s*=\s*vec4\(\s*retColor\s*,\s*1\.0\s*\);/,
        `vec3 skyOut = retColor * uSkyScale;
			if ( uSkyBake < 0.5 ) skyOut = ssCirrus( skyOut, direction, vSunDirection );
			skyOut = mix( skyOut, uSkyFog, ( 1.0 - uSkyBake ) * ( 1.0 - smoothstep( 0.0, 0.08, direction.y ) ) );
			skyOut = mix( skyOut, uSkyGround, uSkyBake * ( 1.0 - smoothstep( - 0.035, 0.0, direction.y ) ) );
			gl_FragColor = vec4( skyOut, 1.0 );`,
      );
  };
  // the key only has to vary with what changes the generated code, and
  // nothing per instance does
  material.customProgramCacheKey = () => 'ssPhotoRigSky';
  material.needsUpdate = true;
}

function makeSkyDome(preset, sunDir, u) {
  const atm = preset.atm;
  if (!atm) return null;
  const s = new Sky();
  s.scale.setScalar(60000);
  const su = s.material.uniforms;
  su.turbidity.value = atm.turbidity;
  su.rayleigh.value = atm.rayleigh;
  su.mieCoefficient.value = atm.mie;
  su.mieDirectionalG.value = atm.mieG;
  su.sunPosition.value.copy(sunDir);
  if (su.up) su.up.value.set(0, 1, 0);
  s.material.toneMapped = true;
  u.uSkyScale.value = Number.isFinite(preset.skyScale) ? preset.skyScale : SKY_SCALE;
  const L = preset.light;
  if (L && L.groundLin && L.envIntensity > 0) {
    u.uGround.value.set(L.groundLin[0], L.groundLin[1], L.groundLin[2]).multiplyScalar(1 / L.envIntensity);
  } else {
    u.uGround.value.set(0.02, 0.02, 0.018);
  }
  const hz = preset.horizonRGB;
  if (hz) u.uFogCol.value.set(hz[0], hz[1], hz[2]);
  if (!u.uCirrus) Object.assign(u, makeCirrusUniforms());
  setCirrus(u, preset);
  patchSkyMaterial(s.material, u);
  s.renderOrder = -1000;
  s.frustumCulled = false;
  return s;
}

// The HDRI drawn over the dome in the environment bake only (scenery.js
// buildHdriSphere): scaled to the dome's cosine-weighted upward mean, rotated
// so its clamped-out sun sits at the game sun, its sky multiplied by the SH
// gain that calibrates it to the light block and its ground replaced by the
// bake's lit ground (presets.js solveEnvGain, wave 3b fix), so every normal
// gets the irradiance preset.light predicts — in the hangar as in battle.
function makeHdriSphere(tex, scale, rot, gain, ground) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uHdri: { value: tex },
      uScale: { value: scale },
      uMix: { value: 1 },
      uRot: { value: new THREE.Vector2(Math.cos(rot), Math.sin(rot)) },
      uEnvGain: { value: gain.coeffs.map((c) => new THREE.Vector3(c[0], c[1], c[2])) },
      uEnvGround: { value: new THREE.Vector3(ground[0], ground[1], ground[2]) },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vDir = wp.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * wp;
        gl_Position.z = gl_Position.w;
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      uniform sampler2D uHdri;
      uniform float uScale;
      uniform float uMix;
      uniform vec2 uRot;
      uniform vec3 uEnvGround;
      varying vec3 vDir;
      ${ENV_GAIN_GLSL}
      void main() {
        vec3 d = normalize( vDir );
        vec3 h = vec3( d.x * uRot.x - d.z * uRot.y, d.y, d.x * uRot.y + d.z * uRot.x );
        vec2 uv = vec2( atan( h.z, h.x ) * RECIPROCAL_PI2 + 0.5, asin( clamp( h.y, - 1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5 );
        vec3 sky = texture2D( uHdri, uv ).rgb * uScale * ssEnvGain( d );
        gl_FragColor = vec4( mix( sky, uEnvGround, ssEnvGroundMix( d.y ) ), uMix );
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  m.frustumCulled = false;
  m.renderOrder = -999;
  return m;
}

//   opts.dome        add the visible sky dome to the scene      (true)
//   opts.fog         height fog on the scene                    (true)
//   opts.background  the fog colour as scene.background         (true)
//   opts.exposure    write AgX + the preset exposure            (true)
//   opts.hdri        swap the IBL to the preset's HDRI          (false)
//   opts.sunAzimuth  radians: turn the sun to this azimuth, same elevation
//                    (the thumbnails light the side the camera sees)
//   opts.sunDistance metres from the target to the light        (40)
export function createPhotoRig(renderer, scene, preset, opts = {}) {
  if (!renderer || !scene || !preset) throw new Error('createPhotoRig: renderer, scene and preset are required');
  installAtmosphere();
  const L = preset.light || null;

  const sd = preset.sunDir || { x: 0.5346, y: 0.8018, z: 0.2673 };
  const sunDir = new THREE.Vector3(sd.x, sd.y, sd.z).normalize();
  if (Number.isFinite(opts.sunAzimuth)) {
    const el = Math.asin(Math.max(-1, Math.min(1, sunDir.y)));
    const az = opts.sunAzimuth;
    sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  }
  const sy = Math.max(CASTER_FLOOR, sunDir.y);
  const flat = Math.hypot(sunDir.x, sunDir.z) || 1;
  const sxz = Math.sqrt(Math.max(0.0001, 1 - sy * sy)) / flat;
  const casterDir = new THREE.Vector3(sunDir.x * sxz, sy, sunDir.z * sxz).normalize();

  // fog colour: the Preetham horizon in linear radiance (presets.horizonRGB)
  const fogColor = new THREE.Color();
  const hz = preset.horizonRGB;
  if (hz) fogColor.setRGB(hz[0], hz[1], hz[2], THREE.LinearSRGBColorSpace);
  else fogColor.setHex(preset.fog ?? 0xb8cfe4);
  if (opts.fog !== false) {
    scene.fog = makeHeightFog(fogColor, L ? L.visibility : 10000, L ? L.fogScaleHeight : FOG_SCALE_HEIGHT);
  }
  if (opts.background !== false) scene.background = fogColor.clone();

  const hemi = new THREE.HemisphereLight(
    preset.hemiSky ?? 0xcfe4ff,
    preset.hemiGround ?? 0x59653f,
    L ? L.hemiIntensity : (preset.hemiIntensity ?? 1.15),
  );
  const sun = new THREE.DirectionalLight(preset.sunColor ?? 0xfff2dd, preset.sunIntensity ?? 2.6);
  sun.position.copy(casterDir).multiplyScalar(opts.sunDistance ?? 40);
  scene.add(hemi, sun, sun.target);

  const bakeU = {
    uSkyScale: { value: SKY_SCALE },
    uBake: { value: 0 },
    uGround: { value: new THREE.Vector3() },
    uFogCol: { value: new THREE.Vector3() },
  };
  const sky = makeSkyDome(preset, sunDir, bakeU);
  if (sky && opts.dome !== false) scene.add(sky);

  scene.environmentIntensity = L ? L.envIntensity : (preset.envIntensity ?? 0.7);
  scene.userData.bloomThreshold = L ? L.bloomThreshold : undefined;
  if (opts.exposure !== false) {
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = L ? L.exposure : (preset.exposure ?? 1.1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  let pmrem = null;
  let envTarget = null;
  let envScene = null;
  let envDirty = !!sky;
  let envFailed = false;
  let hdriId = null;
  let hdriTex = null;
  let hdriSphere = null;
  let hdriGain = null;
  let hdriState = 'none';
  // assetsEnabled(): a cached, decoded HDRI comes back whatever the switch
  // says, so the switch is honoured here
  if (opts.hdri && sky && assetsEnabled()) {
    try {
      hdriId = hdriFor(preset.biome || 'meadow', preset.todKey || 'noon', preset.weatherKey || 'clear');
      hdriTex = hdriId ? loadHDRI(hdriId) : null;
      hdriState = hdriTex ? 'loading' : 'none';
    } catch {
      hdriId = null;
      hdriTex = null;
    }
  }

  // scenery.js hemiFallbackOf: the hemisphere also carries the IBL's
  // horizontal share when there is no environment at all
  function hemiFallback() {
    if (!L || !L.skyUpLin) return preset.hemiIntensity ?? 1.15;
    const c = new THREE.Color(preset.hemiSky ?? 0xcfe4ff);
    const yHemi = Math.max(1e-4, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
    const up = L.skyUpLin;
    const yUp = 0.2126 * up[0] + 0.7152 * up[1] + 0.0722 * up[2];
    return L.hemiIntensity + (Math.PI * yUp * L.envIntensity) / yHemi;
  }

  function bake() {
    if (envFailed || !sky) return false;
    envDirty = false;
    try {
      if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);
      if (!envScene) envScene = new THREE.Scene();
      const parent = sky.parent;
      envScene.add(sky);
      if (hdriSphere) envScene.add(hdriSphere);
      bakeU.uBake.value = 1;
      const prev = envTarget;
      try {
        envTarget = pmrem.fromScene(envScene, 0.02);
      } finally {
        bakeU.uBake.value = 0;
        if (parent) parent.add(sky);
        else envScene.remove(sky);
      }
      if (prev) prev.dispose();
      scene.environment = envTarget.texture;
      scene.environmentIntensity = L ? L.envIntensity : (preset.envIntensity ?? 0.7);
      return true;
    } catch {
      // no cube target to be had: the hemisphere carries the IBL's share
      envFailed = true;
      if (envTarget) {
        envTarget.dispose();
        envTarget = null;
      }
      scene.environment = null;
      hemi.intensity = hemiFallback();
      return false;
    }
  }

  function pollHdri() {
    if (!hdriTex || hdriSphere) return;
    const s = assetStatus(hdriTex);
    if (s === 'ready') {
      try {
        const up = L && L.skyUpLin ? L.skyUpLin : null;
        const scale = up ? 0.2126 * up[0] + 0.7152 * up[1] + 0.0722 * up[2] : 0.25;
        const rot = hdriRotationY(hdriId, { x: sunDir.x, y: sunDir.y, z: sunDir.z });
        // the battle's own rotation and preset, so the hangar's calibration is
        // the battle's (a rig whose sun was turned solves for that sun)
        const gp = Number.isFinite(opts.sunAzimuth)
          ? { ...preset, id: `${preset.id}@${opts.sunAzimuth.toFixed(4)}`, sunDir: { x: sunDir.x, y: sunDir.y, z: sunDir.z } }
          : preset;
        const gain = L ? envGainFor(gp, hdriId, hdriTex.image, rot, scale) : null;
        if (!gain || !gain.ok) {
          // the photograph does not fit this preset: the dome stays the light
          hdriTex = null;
          hdriState = 'unfit';
          return;
        }
        hdriSphere = makeHdriSphere(hdriTex, scale, rot, gain, envGroundOf(preset));
        hdriGain = gain;
        hdriState = 'in use';
        envDirty = true;
      } catch {
        hdriTex = null;
        hdriState = 'failed';
      }
    } else if (s !== 'loading') {
      hdriTex = null;
      hdriState = s;
    }
  }

  return {
    sun,
    hemi,
    sky,
    sunDir,
    casterDir,
    fogColor,
    preset,
    // Per frame: swaps in the HDRI when it lands and (re)bakes the IBL when
    // dirty. Cheap on every other frame.
    update() {
      pollHdri();
      if (envDirty) bake();
    },
    bake,
    get envReady() {
      return !!envTarget;
    },
    get hdri() {
      return {
        id: hdriId,
        state: hdriState,
        gain: hdriGain ? { min: hdriGain.gainMin, max: hdriGain.gainMax } : null,
      };
    },
    dispose() {
      scene.remove(hemi, sun, sun.target);
      sun.shadow?.map?.dispose();
      if (sky) {
        sky.parent?.remove(sky);
        sky.geometry.dispose();
        sky.material.dispose();
      }
      if (hdriSphere) {
        hdriSphere.parent?.remove(hdriSphere);
        hdriSphere.geometry.dispose();
        hdriSphere.material.dispose();
        hdriSphere = null;
      }
      // the HDRI texture itself is assets.js's (stamped shared, cached)
      if (envTarget) {
        if (scene.environment === envTarget.texture) scene.environment = null;
        envTarget.dispose();
        envTarget = null;
      }
      pmrem?.dispose();
      pmrem = null;
      envScene = null;
    },
  };
}
