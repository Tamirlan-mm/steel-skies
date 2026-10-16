// Battlefield sound via Web Audio: recorded samples where they exist, synthesis
// everywhere else.
//
// Real recordings (CC0 / public domain — every file and its source is listed in
// public/media/sfx/CREDITS.md) now carry the engines, guns, explosions, hits and
// ambience. They are fetched lazily relative to document.baseURI and decoded once
// the AudioContext exists. Every synthesised voice below is kept as the fallback:
// a file that is still downloading, failed, or never existed simply means the old
// voice plays instead — no recording can make the game silent or throw, and
// nothing here touches the network headless.
//
// The mix is arranged the way a crew actually experiences a battlefield rather
// than the way a mixing desk would lay it out. Everything positional goes
// through a PannerNode so a Tiger idling behind a ridge is a direction and a
// distance rather than a rumble of unknown origin, every report is delayed by
// the time sound needs to cross the map, and the timbre of that report — not
// only its volume — tells you how far away the gun was. Distance is the primary
// information channel here; loudness alone is a very poor one.
//
// Bus layout (all of it optional — nothing throws before the first gesture):
//
//   sources ─┬─ sfxBus   ──┐
//            ├─ engineBus ─┴─ duck ─┐
//            ├─ loudBus  ───────────┼─ master ─ limiter ─ destination
//            ├─ radioBus ───────────┤
//            └─ tailBus (feedback) ─┘
//
// loudBus, radioBus and tailBus deliberately sit *outside* the ducker: an
// explosion must not duck itself, and the rolling tail it throws off is the
// part that makes it feel big. Everything else — engines, small arms, hits —
// goes through the duck and gets shoved out of the way for ~0.6 s.

// AV-01: the one blast law (pure maths, no imports of its own). The same
// SPEED_OF_SOUND constant schedules the camera shake (combat/shake.js), so the
// thump and the jolt land on the same frame.
import { blastOf, SPEED_OF_SOUND } from '../combat/blast.js';

const MAX_ENGINE_VOICES = 8;
// One-shots are budgeted by their *prominent* part only (see playSample /
// sampleBusy): a recorded cannon report rolls on for 2-4 s, but only its first
// second or so is what the ear is following, so only that holds a voice slot.
// The low tail plays on outside the budget, and when too many tails pile up the
// oldest is faded out (stealTail) rather than a new sound being dropped.
const MAX_ONESHOT_VOICES = 26;
const MAX_LIVE_ONESHOTS = 40; // prominent + tails, hard cap on live one-shot subgraphs
const MAX_PANNERS = 56; // headroom over MAX_LIVE_ONESHOTS for tails still fading out

let ctx = null;
let master = null;
let limiter = null;
let duckGain = null;
let sfxBus = null;
let loudBus = null;
let engineBus = null;
let radioBus = null;
let tailBus = null;
let noiseBuf = null;

const vol = { master: 1, effects: 1, engines: 1 };

// ---------------- small math helpers ----------------
// Kept local so this module stays free of any THREE dependency: the audio layer
// only ever reads plain x/y/z off whatever it is handed.

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ±amount of random spread around 1 — every recorded one-shot gets a little,
// so the tenth shot from the same gun is not a photocopy of the first.
function jit(amount) {
  return 1 + (Math.random() * 2 - 1) * amount;
}

const HALF_PI = Math.PI / 2;

// ---------------- recorded samples ----------------

const SAMPLE_DIR = 'media/sfx/';

// Loop region (seconds) of every looping file. Each loop file carries 4096 samples
// of circular padding on both sides, so [start, end) is exactly one period of the
// loop wherever a decoder decides to put the MP3 priming delay — the seam stays
// seamless with or without gapless-MP3 support.
const SAMPLE_LOOPS = {
  tank_idle: [0.09288, 4.886599],
  tank_run: [0.09288, 4.176304],
  tank_tracks: [0.09288, 4.289501],
  plane_prop: [0.09288, 5.30746],
  plane_exhaust: [0.09288, 4.084331],
  amb_wind: [0.09288, 12.124331],
  amb_battle: [0.09288, 16.220204],
};

// Interchangeable takes of one sound; a random one (never the same twice in a row
// when there is a choice) plays each time.
const SAMPLE_BANKS = {
  cannon_near: ['cannon_near_1', 'cannon_near_2', 'cannon_near_3', 'cannon_near_4'],
  cannon_far: ['cannon_far_1', 'cannon_far_2', 'cannon_far_3'],
  mg: ['mg_1', 'mg_2', 'mg_3', 'mg_4'],
  explosion: ['explosion_1', 'explosion_2'],
  bomb: ['bomb_1', 'bomb_2', 'bomb_3'],
  clang: ['clang_1', 'clang_2', 'clang_3', 'clang_4'],
  pen: ['pen_1', 'pen_2', 'pen_3'],
  ricochet: ['ricochet_1', 'ricochet_2', 'ricochet_3', 'ricochet_4'],
  crack: ['whiz_1', 'whiz_3'],
  whiz: ['whiz_2'],
  // the loader slamming the breech shut: what an auto-reload sounds like from the
  // turret (sfx.reloadDone), before the radio blip confirms it
  breech: ['breech_1', 'breech_2', 'breech_3'],
};

// Engine loop layers per profile, in voice-slot order.
const ENGINE_LAYERS = {
  tank: ['tank_idle', 'tank_run', 'tank_tracks'],
  plane: ['plane_prop', 'plane_exhaust'],
};

// Level of each recorded family. Within a family every take is normalised to the
// same short-term K-weighted loudness (see public/media/sfx/CREDITS.md), so a
// random take never jumps out or drops away; families sit at different file
// levels because each is as loud as its peakiest take allows under -1 dBTP.
// These gains put each family back where the offline fit against the
// synthesised voices had it (engine loops -18 LUFS, beds -22..-28 integrated),
// near perspective — the mix balance the game was tuned with survives.
const SG = {
  cannonNear: 1.1,
  cannonFar: 1.11,
  smallGun: 0.68,
  mg: 0.5,
  blast: 1.77,
  bomb: 1.15,
  pen: 1.87,
  clang: 2.59,
  ricochet: 2.7,
  crack: 0.99,
  whiz: 0.78,
  breech: 0.53, // 4 LU above the square-wave tick it replaces
  engineTank: 3.4,
  enginePlane: 4.6,
  wind: 0.8,
  battle: 0.45,
};

const ALL_SAMPLES = (() => {
  const seen = new Set(Object.keys(SAMPLE_LOOPS));
  Object.keys(SAMPLE_BANKS).forEach((k) => SAMPLE_BANKS[k].forEach((n) => seen.add(n)));
  return Array.from(seen);
})();

const sampleBuf = Object.create(null); // name -> AudioBuffer
const sampleSkip = Object.create(null); // name -> seconds of decoder priming silence to skip
const sampleBusy = Object.create(null); // name -> seconds (from the skip point) holding 90% of its energy
const sampleBytes = Object.create(null); // name -> Promise<ArrayBuffer|null>
const lastPick = Object.create(null); // bank -> name played last
const engineReady = { tank: false, plane: false };
const sampleStats = { requested: 0, decoded: 0, failed: 0 };
let samplesEnabled = true;
let prefetchStarted = false;
let decodeStarted = false;

// Relative to the page, never the site root: the game may be hosted under any
// sub-path. No usable base (headless, about:blank) means no fetch at all.
function sampleUrl(name) {
  try {
    const d = typeof document !== 'undefined' ? document : null;
    let base = d && typeof d.baseURI === 'string' ? d.baseURI : '';
    if (!base && typeof location !== 'undefined' && location && typeof location.href === 'string') {
      base = location.href;
    }
    if (!/^(https?|file):/i.test(base)) return null;
    return new URL(SAMPLE_DIR + name + '.mp3', base).href;
  } catch (e) {
    return null;
  }
}

// Bytes only — no AudioContext needed, so this can run at hangar time and the
// first battle finds everything already downloaded.
function prefetchSamples() {
  if (prefetchStarted || !samplesEnabled) return;
  prefetchStarted = true;
  if (typeof fetch !== 'function') return;
  for (let i = 0; i < ALL_SAMPLES.length; i++) {
    const name = ALL_SAMPLES[i];
    const url = sampleUrl(name);
    if (!url) return;
    let p = null;
    try {
      p = fetch(url)
        .then((r) => (r && r.ok ? r.arrayBuffer() : null))
        .catch(() => null);
    } catch (e) {
      p = null;
    }
    if (p) {
      sampleBytes[name] = p;
      sampleStats.requested++;
    }
  }
}

function decodeBytes(ab) {
  return new Promise((resolve) => {
    let done = false;
    const ok = (b) => {
      if (done) return;
      done = true;
      resolve(b || null);
    };
    const bad = () => ok(null);
    try {
      // callback form for older Safari, promise form for everyone else
      const r = ctx.decodeAudioData(ab, ok, bad);
      if (r && typeof r.then === 'function') r.then(ok, bad);
    } catch (e) {
      bad();
    }
  });
}

// Some decoders keep the MP3 encoder's priming silence; skipping it keeps a
// gunshot on the frame it was fired rather than 25 ms behind it.
function leadingSkip(buf) {
  try {
    const d = buf.getChannelData(0);
    const n = Math.min(d.length, Math.floor(buf.sampleRate * 0.12));
    for (let i = 0; i < n; i++) {
      if (d[i] > 0.002 || d[i] < -0.002) return Math.max(0, i - 24) / buf.sampleRate;
    }
  } catch (e) {
    // a buffer we cannot inspect just plays from the top
  }
  return 0;
}

// How long a one-shot stays prominent: the time by which 90% of its energy has
// been delivered. A cannon report's rolling tail or a bomb's debris patter carries
// on long after that at a level a busy mix masks anyway; only the prominent part
// is charged against the voice budget. Measured once per file, at decode.
function prominentTime(buf, skip) {
  try {
    const d = buf.getChannelData(0);
    const from = Math.min(d.length, Math.floor(skip * buf.sampleRate));
    let total = 0;
    for (let i = from; i < d.length; i++) total += d[i] * d[i];
    if (!(total > 0)) return 0;
    const want = total * 0.9;
    let acc = 0;
    for (let i = from; i < d.length; i++) {
      acc += d[i] * d[i];
      if (acc >= want) return (i - from + 1) / buf.sampleRate;
    }
  } catch (e) {
    // an uninspectable buffer is charged for its whole length
  }
  return 0;
}

function onSampleDecoded(name, buf) {
  const loop = SAMPLE_LOOPS[name];
  if (!buf || !(buf.duration > 0) || (loop && buf.duration < loop[1])) {
    sampleStats.failed++;
    return;
  }
  sampleBuf[name] = buf;
  sampleSkip[name] = loop ? 0 : leadingSkip(buf);
  if (!loop) sampleBusy[name] = prominentTime(buf, sampleSkip[name]);
  sampleStats.decoded++;
  engineReady.tank = layersLoaded(ENGINE_LAYERS.tank);
  engineReady.plane = layersLoaded(ENGINE_LAYERS.plane);
}

function layersLoaded(names) {
  for (let i = 0; i < names.length; i++) if (!sampleBuf[names[i]]) return false;
  return true;
}

function decodeSamples() {
  if (decodeStarted || !ctx || !samplesEnabled) return;
  prefetchSamples();
  decodeStarted = true;
  const decodeCtx = ctx;
  for (let i = 0; i < ALL_SAMPLES.length; i++) {
    const name = ALL_SAMPLES[i];
    const p = sampleBytes[name];
    if (!p || typeof p.then !== 'function') continue;
    p.then((ab) => {
      sampleBytes[name] = null; // the bytes are only needed once
      if (!ab || ctx !== decodeCtx) {
        sampleStats.failed++;
        return null;
      }
      return decodeBytes(ab).then((buf) => onSampleDecoded(name, buf));
    }).catch(() => {
      sampleStats.failed++;
    });
  }
}

// A random loaded take from a bank, never the previous one when there is a
// choice. Allocation-free; null when nothing in the bank has loaded.
function pickSample(bank) {
  if (!samplesEnabled) return null;
  const list = SAMPLE_BANKS[bank];
  if (!list) return null;
  let n = 0;
  for (let i = 0; i < list.length; i++) if (sampleBuf[list[i]]) n++;
  if (!n) return null;
  let k = Math.floor(Math.random() * n);
  let pick = null;
  for (let i = 0; i < list.length; i++) {
    if (!sampleBuf[list[i]]) continue;
    if (k-- === 0) {
      pick = list[i];
      break;
    }
  }
  if (pick === lastPick[bank] && n > 1) {
    const at = list.indexOf(pick);
    for (let j = 1; j < list.length; j++) {
      const c = list[(at + j) % list.length];
      if (sampleBuf[c]) {
        pick = c;
        break;
      }
    }
  }
  lastPick[bank] = pick;
  return pick;
}

// Longest prominent time (seconds, after playbackRate) of the takes started since
// the caller last zeroed it — what the caller's one-shot is charged to the voice
// budget for (see retire). A module scalar so playSample stays allocation-free.
let playBusy = 0;

// One recorded take into `dest` at `when`, optionally also into `send` (the
// valley tail). Returns how long it will sound, in seconds, or 0 if it could not.
function playSample(name, when, dest, rate, gain, send, sendGain) {
  const buf = name ? sampleBuf[name] : null;
  if (!buf || !(gain > 0.0005)) return 0;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const r = clamp(rate, 0.25, 4);
  src.playbackRate.value = r;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g);
  g.connect(dest);
  if (send && sendGain > 0.01) {
    const s = ctx.createGain();
    s.gain.value = sendGain;
    g.connect(s);
    s.connect(send);
  }
  const skip = sampleSkip[name] || 0;
  src.start(when, skip);
  const len = (buf.duration - skip) / r;
  const pb = sampleBusy[name];
  const busy = pb > 0 ? Math.min(len, pb / r) : len;
  if (busy > playBusy) playBusy = busy;
  return len;
}

// Air eats the top end first: ~10 kHz survives 100 m, ~4 kHz 300 m, under 1 kHz
// past a kilometre. That, not volume, is what makes a recording read as distant.
function airCutoff(dist) {
  return 700 + 17000 * Math.exp(-Math.max(0, dist) / 180);
}

function airFilter(dist, dest, open) {
  if (dist < 45) return dest;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = Math.min(18000, airCutoff(dist) * (open || 1));
  f.Q.value = 0.5;
  f.connect(dest);
  return f;
}

/**
 * Debug / A-B switch for the recorded set. Off = every voice is synthesised again
 * (engine voices switch over on their next update). Purely additive API.
 */
export function setSampleMode(enabled) {
  samplesEnabled = enabled !== false;
  if (samplesEnabled) {
    prefetchSamples();
    decodeSamples();
  }
}

/** Load state of the recorded set (for a debug overlay or tests). */
export function getSampleStatus() {
  return {
    enabled: samplesEnabled,
    requested: sampleStats.requested,
    decoded: sampleStats.decoded,
    failed: sampleStats.failed,
    engines: { tank: engineReady.tank, plane: engineReady.plane },
  };
}

// ---------------- listener ----------------

const listenerPos = { x: 0, y: 0, z: 0 };
const listenerFwd = { x: 0, y: 0, z: -1 };
const listenerUp = { x: 0, y: 1, z: 0 };
let hasListener = false;

function distTo(pos) {
  const dx = pos.x - listenerPos.x;
  const dy = pos.y - listenerPos.y;
  const dz = pos.z - listenerPos.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Drives the AudioListener from a THREE camera without importing THREE: the
// position is read straight off the object and the basis vectors come out of
// its world matrix (column-major, camera looks down its own -Z).
export function setListener(camera) {
  if (!camera || !camera.position) return;
  const p = camera.position;
  listenerPos.x = p.x;
  listenerPos.y = p.y;
  listenerPos.z = p.z;

  const m = camera.matrixWorld && camera.matrixWorld.elements;
  if (m) {
    let fx = -m[8];
    let fy = -m[9];
    let fz = -m[10];
    let len = Math.hypot(fx, fy, fz) || 1;
    listenerFwd.x = fx / len;
    listenerFwd.y = fy / len;
    listenerFwd.z = fz / len;
    let ux = m[4];
    let uy = m[5];
    let uz = m[6];
    len = Math.hypot(ux, uy, uz) || 1;
    listenerUp.x = ux / len;
    listenerUp.y = uy / len;
    listenerUp.z = uz / len;
  }
  hasListener = true;

  if (!ctx) return;
  const l = ctx.listener;
  const t = ctx.currentTime;
  // The AudioParam form is smoothed; the legacy setters are a hard jump, which
  // is fine because they only exist on browsers old enough not to interpolate.
  if (l.positionX) {
    l.positionX.setTargetAtTime(listenerPos.x, t, 0.02);
    l.positionY.setTargetAtTime(listenerPos.y, t, 0.02);
    l.positionZ.setTargetAtTime(listenerPos.z, t, 0.02);
    l.forwardX.setTargetAtTime(listenerFwd.x, t, 0.02);
    l.forwardY.setTargetAtTime(listenerFwd.y, t, 0.02);
    l.forwardZ.setTargetAtTime(listenerFwd.z, t, 0.02);
    l.upX.setTargetAtTime(listenerUp.x, t, 0.02);
    l.upY.setTargetAtTime(listenerUp.y, t, 0.02);
    l.upZ.setTargetAtTime(listenerUp.z, t, 0.02);
  } else if (l.setPosition) {
    l.setPosition(listenerPos.x, listenerPos.y, listenerPos.z);
    l.setOrientation(
      listenerFwd.x, listenerFwd.y, listenerFwd.z,
      listenerUp.x, listenerUp.y, listenerUp.z,
    );
  }
}

// ---------------- init ----------------

export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    decodeSamples();
    return;
  }
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return;
  try {
    ctx = new Ctor();
  } catch (e) {
    ctx = null;
    return;
  }

  // A gentle limiter on the very end so a wall of simultaneous explosions
  // compresses instead of clipping into digital mud.
  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 8;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(ctx.destination);

  master = ctx.createGain();
  master.gain.value = 0.45 * vol.master;
  master.connect(limiter);

  duckGain = ctx.createGain();
  duckGain.gain.value = 1;
  duckGain.connect(master);

  sfxBus = ctx.createGain();
  sfxBus.gain.value = vol.effects;
  sfxBus.connect(duckGain);

  engineBus = ctx.createGain();
  engineBus.gain.value = vol.engines;
  engineBus.connect(duckGain);

  // Big, dominant sounds bypass the ducker — otherwise the explosion that
  // triggers the duck is the first thing the duck swallows.
  loudBus = ctx.createGain();
  loudBus.gain.value = vol.effects;
  loudBus.connect(master);

  radioBus = ctx.createGain();
  radioBus.gain.value = vol.effects;
  const radioBand = ctx.createBiquadFilter();
  radioBand.type = 'bandpass';
  radioBand.frequency.value = 1500;
  radioBand.Q.value = 0.8;
  radioBus.connect(radioBand);
  radioBand.connect(master);

  buildTail();

  // 2s of white noise, reused by every burst-type sound
  const len = ctx.sampleRate * 2;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  // The player's engine is now simply the permanent first entry in the pool:
  // updateEngineSound() feeds it exactly the numbers it always fed the old
  // single oscillator, and it is the one voice that is never culled.
  playerVoice = createVoice();
  playerVoice.player = true;
  routeVoice(playerVoice, true);

  if (hasListener) {
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = listenerPos.x;
      l.positionY.value = listenerPos.y;
      l.positionZ.value = listenerPos.z;
      l.forwardX.value = listenerFwd.x;
      l.forwardY.value = listenerFwd.y;
      l.forwardZ.value = listenerFwd.z;
    } else if (l.setPosition) {
      l.setPosition(listenerPos.x, listenerPos.y, listenerPos.z);
    }
  }

  // the gesture that unlocked the context is the moment to turn bytes into buffers
  decodeSamples();
}

// A pair of short feedback delays standing in for the valley the fight happens
// in. Only distant reports and explosions are sent here, which is exactly when
// a real gun stops being a crack and becomes rolling thunder.
function buildTail() {
  tailBus = ctx.createGain();
  tailBus.gain.value = 1;
  const shape = ctx.createBiquadFilter();
  shape.type = 'lowpass';
  shape.frequency.value = 900;
  tailBus.connect(shape);

  const out = ctx.createGain();
  out.gain.value = 0.55;
  out.connect(master);

  const taps = [0.113, 0.191];
  for (let i = 0; i < taps.length; i++) {
    const d = ctx.createDelay(0.5);
    d.delayTime.value = taps[i];
    const fb = ctx.createGain();
    fb.gain.value = i === 0 ? 0.42 : 0.34;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 640;
    shape.connect(d);
    d.connect(damp);
    damp.connect(fb);
    fb.connect(d); // the loop that makes it a tail rather than an echo
    damp.connect(out);
  }
}

function ready() {
  return !!ctx && !!master;
}

// ---------------- volumes ----------------

export function setVolumes(opts = {}) {
  // called once at startup (hangar): start downloading the recordings now, so
  // the first battle does not spend its opening seconds on the fallback voices
  prefetchSamples();
  if (typeof opts.master === 'number') vol.master = clamp(opts.master, 0, 1);
  if (typeof opts.effects === 'number') vol.effects = clamp(opts.effects, 0, 1);
  if (typeof opts.engines === 'number') vol.engines = clamp(opts.engines, 0, 1);
  if (!ready()) return;
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(0.45 * vol.master, t, 0.03);
  sfxBus.gain.setTargetAtTime(vol.effects, t, 0.03);
  loudBus.gain.setTargetAtTime(vol.effects, t, 0.03);
  radioBus.gain.setTargetAtTime(vol.effects, t, 0.03);
  engineBus.gain.setTargetAtTime(vol.engines, t, 0.03);
}

export function getVolumes() {
  return { master: vol.master, effects: vol.effects, engines: vol.engines };
}

// ---------------- ducking ----------------

let duckTarget = 1;
let duckEnds = 0;

// A near explosion should physically take the room away from everything else
// for a moment. Only ever deepens an existing duck — a small hit must not
// cancel the recovery ramp of the big one that just landed.
function duck(amount, hold = 0.05, release = 0.6) {
  if (!ready()) return;
  const now = ctx.currentTime;
  const target = clamp(1 - amount, 0.12, 1);
  if (now < duckEnds && target >= duckTarget) return;
  duckTarget = target;
  duckEnds = now + 0.04 + hold + release;
  const g = duckGain.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(target, now + 0.04);
  g.setValueAtTime(target, now + 0.04 + hold);
  g.linearRampToValueAtTime(1, now + 0.04 + hold + release);
}

// ---------------- scheduling with speed of sound ----------------

const pendingTimers = new Set();

// Short delays are scheduled on the audio clock (sample accurate); long ones
// wait on a timer first so a shot 2 km away is not holding a dozen live nodes
// for six seconds before it is heard.
function scheduleAt(delay, fn) {
  if (!ready()) return;
  if (delay <= 0.25) {
    fn(ctx.currentTime + Math.max(0, delay));
    return;
  }
  const id = setTimeout(() => {
    pendingTimers.delete(id);
    if (ready()) fn(ctx.currentTime + 0.02);
  }, (delay - 0.02) * 1000);
  pendingTimers.add(id);
}

// ---------------- panner pool ----------------

const pannerPool = [];
let pannersMade = 0;
let activeOneShots = 0; // one-shots still in their prominent part: the voice budget
let liveOneShots = 0; // one-shots whose subgraph is still wired (prominent + tail)

// HRTF is worth its cost on the handful of long-lived engine voices, where
// knowing *where* the Tiger is matters more than anything else in the mix. The
// one-shot pool can run to twenty-odd simultaneous nodes, so it takes the cheap
// model — a transient carries its azimuth perfectly well through equal-power.
function configurePanner(p, model) {
  p.panningModel = model;
  p.distanceModel = 'inverse';
  p.refDistance = 18;
  p.rolloffFactor = 0.9;
  p.maxDistance = 2000;
  p.coneInnerAngle = 360;
  p.coneOuterAngle = 360;
  p.coneOuterGain = 1;
}

// Moving sources are smoothed; a one-shot only ever gets placed once, and a
// ramp there would smear the very transient the sound exists for.
function setPannerPos(p, pos, smooth) {
  const t = ctx.currentTime;
  if (p.positionX) {
    if (smooth) {
      p.positionX.setTargetAtTime(pos.x, t, 0.02);
      p.positionY.setTargetAtTime(pos.y, t, 0.02);
      p.positionZ.setTargetAtTime(pos.z, t, 0.02);
    } else {
      p.positionX.setValueAtTime(pos.x, t);
      p.positionY.setValueAtTime(pos.y, t);
      p.positionZ.setValueAtTime(pos.z, t);
    }
  } else if (p.setPosition) {
    p.setPosition(pos.x, pos.y, pos.z);
  }
}

function acquirePanner(bus, pos) {
  let p = pannerPool.pop();
  if (!p) {
    if (pannersMade >= MAX_PANNERS) return null;
    p = ctx.createPanner();
    configurePanner(p, 'equalpower');
    pannersMade++;
  }
  setPannerPos(p, pos, false);
  p.connect(bus);
  return p;
}

function releasePanner(p) {
  try {
    p.disconnect();
  } catch (e) {
    // a node disconnected twice is not worth a thrown frame
  }
  if (pannerPool.length < MAX_PANNERS) pannerPool.push(p);
}

// A teardown is tracked as a record rather than a bare timer handle because
// resetAudio has to be able to *run* it early: a cancelled timer would strand
// the panner it was holding outside the pool, and after a few battles
// acquirePanner would have nothing left to hand out.
const pendingTeardowns = new Set();

// A one-shot's voice slot comes back when its prominent part is over, which for
// a recording is usually well before its subgraph can be torn down.
function releaseSlot(rec) {
  if (!rec.busy) return;
  rec.busy = false;
  if (rec.bid) clearTimeout(rec.bid);
  activeOneShots = Math.max(0, activeOneShots - 1);
}

function dropLive(rec) {
  if (!rec.live) return;
  rec.live = false;
  liveOneShots = Math.max(0, liveOneShots - 1);
}

// Idempotent: whichever of the timer or resetAudio gets here first wins.
function runTeardown(rec) {
  pendingTeardowns.delete(rec);
  if (rec.done) return;
  rec.done = true;
  clearTimeout(rec.id);
  releaseSlot(rec);
  dropLive(rec);
  try {
    rec.out.disconnect();
  } catch (e) {
    // teardown must never take the frame down with it
  }
  if (rec.panner) releasePanner(rec.panner);
}

// voice: a positional one-shot, counted against both budgets. busyMs (voices
// only): when its slot frees up; omitted, the slot is held until teardown.
function scheduleTeardown(out, panner, ms, voice, busyMs) {
  const rec = { id: 0, bid: 0, out, panner, voice, busy: false, live: false, stolen: false, done: false };
  rec.id = setTimeout(() => runTeardown(rec), ms);
  if (voice) {
    rec.busy = true;
    rec.live = true;
    activeOneShots++;
    liveOneShots++;
    if (busyMs != null && busyMs < ms) rec.bid = setTimeout(() => releaseSlot(rec), busyMs);
  }
  pendingTeardowns.add(rec);
  return rec;
}

// Too many tails still ringing: fade the oldest one that is past its prominent
// part (40 ms, no click) and tear it down, instead of refusing the new sound.
// Records sit in the Set in creation order, so the first match is the oldest.
function stealTail() {
  for (const rec of pendingTeardowns) {
    if (!rec.voice || rec.busy || rec.done || rec.stolen) continue;
    rec.stolen = true;
    dropLive(rec);
    const now = ctx.currentTime;
    try {
      const g = rec.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + 0.04);
    } catch (e) {
      // a node we cannot fade is simply cut a moment later
    }
    clearTimeout(rec.id);
    rec.id = setTimeout(() => runTeardown(rec), 60);
    return true;
  }
  return false;
}

// Every positional one-shot funnels into a single `out` gain, so retiring it is
// one disconnect and the whole little subgraph behind it becomes garbage.
// dur: how long it sounds at all; busy: how long it is prominent (defaults to
// dur — the synthesised voices are short and charged for all of it).
function retire(out, panner, when, dur, busy) {
  if (liveOneShots >= MAX_LIVE_ONESHOTS) stealTail();
  const lead = when - ctx.currentTime;
  const ms = Math.max(0, (lead + dur + 0.15) * 1000);
  const busyMs = busy > 0 && busy < dur ? Math.max(0, (lead + busy + 0.05) * 1000) : undefined;
  scheduleTeardown(out, panner, ms, true, busyMs);
}

// ---------------- node builders ----------------

function noiseNode(when, dur, rate = 1) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = rate;
  // Looping and starting at a random offset means one 2 s buffer can serve a
  // burst of any length without ever phase-locking against the previous one.
  src.loop = true;
  src.start(when, Math.random() * 1.9);
  src.stop(when + dur + 0.05);
  return src;
}

function env(gain, when, peak, attack, decay) {
  const g = gain.gain;
  const p = Math.max(0.0002, peak);
  g.setValueAtTime(0.0001, when);
  g.linearRampToValueAtTime(p, when + Math.max(0.0005, attack));
  g.exponentialRampToValueAtTime(0.0001, when + attack + decay);
}

// ---------------- legacy 2D one-shots ----------------
// Unchanged in signature and character; they simply land on the new buses now.

function noiseBurst({ dur = 0.3, freq = 800, q = 1, vol: v = 0.5, type = 'lowpass', bus = null }) {
  if (!ready()) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = 0.7 + Math.random() * 0.6;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(v, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(bus || sfxBus);
  src.start();
  src.stop(ctx.currentTime + dur + 0.05);
}

function tone({ from = 400, to = 100, dur = 0.15, vol: v = 0.3, type = 'sine', bus = null }) {
  if (!ready()) return;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), ctx.currentTime + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(v, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  osc.connect(gain);
  gain.connect(bus || sfxBus);
  osc.start();
  osc.stop(ctx.currentTime + dur + 0.05);
}

// A recorded take straight onto a bus (no position). False when the bank has
// nothing loaded yet, so the caller can fall back to its synthesised voice.
function play2D(bank, gain, rate, bus) {
  if (!ready()) return false;
  const name = pickSample(bank);
  if (!name) return false;
  return playSample(name, ctx.currentTime + 0.005, bus || sfxBus, rate * jit(0.04), gain * jit(0.08)) > 0;
}

export const sfx = {
  fire(distFactor = 1) {
    if (!play2D('cannon_near', SG.cannonNear * distFactor, 1, loudBus)) {
      noiseBurst({ dur: 0.35, freq: 300, vol: 0.8 * distFactor, bus: loudBus });
      tone({ from: 110, to: 35, dur: 0.3, vol: 0.5 * distFactor, type: 'triangle', bus: loudBus });
    }
    duck(0.25 * distFactor, 0.03, 0.35);
  },
  hit() {
    if (play2D('pen', SG.pen, 1)) return;
    tone({ from: 900, to: 250, dur: 0.09, vol: 0.4, type: 'square' });
    noiseBurst({ dur: 0.12, freq: 2500, vol: 0.25, type: 'highpass' });
  },
  ricochet() {
    if (play2D('ricochet', SG.ricochet, 1)) return;
    tone({ from: 1200, to: 2600, dur: 0.18, vol: 0.25, type: 'sine' });
  },
  nonpen() {
    if (play2D('clang', SG.clang, 1)) return;
    tone({ from: 500, to: 180, dur: 0.1, vol: 0.3, type: 'square' });
  },
  explosion(distFactor = 1) {
    if (!play2D('explosion', SG.blast * distFactor, 1, loudBus)) {
      noiseBurst({ dur: 1.1, freq: 160, vol: 1.0 * distFactor, bus: loudBus });
      tone({ from: 80, to: 25, dur: 0.9, vol: 0.7 * distFactor, type: 'triangle', bus: loudBus });
    }
    duck(0.55 * distFactor, 0.06, 0.6);
  },
  // The gun has auto-reloaded: the loader slams the breech shut — a heavy, low
  // clunk from inside the turret, pitched down a little because a 75 mm breech
  // block weighs more than anything the take was recorded on. The radio blip
  // every caller plays right after (radioCue('reload')) stays the UI half of the
  // cue; the old square-wave tick is the fallback until the takes have loaded.
  reloadDone() {
    if (play2D('breech', SG.breech, 0.84, sfxBus)) return;
    tone({ from: 700, to: 900, dur: 0.08, vol: 0.15, type: 'square' });
  },
  mg(distFactor = 1) {
    if (play2D('mg', SG.mg * distFactor, 1)) return;
    noiseBurst({ dur: 0.07, freq: 1600, vol: 0.22 * distFactor, type: 'highpass' });
    tone({ from: 220, to: 120, dur: 0.05, vol: 0.12 * distFactor, type: 'square' });
  },
};

// ---------------- positional one-shots ----------------

// Two things vary with distance and only one of them is loudness. Inside ~150 m
// a gun is a transient — a crack with an edge on it. Past ~400 m the edge is
// gone entirely and what arrives is a low, slow roll with a tail. Everything
// between is a genuine crossfade of the two, which is why a single lowpass
// sweep never sounds right.
function farWeight(dist) {
  return smoothstep(150, 400, dist);
}

// Anything scheduled into the future has to own its position: callers hand us
// live vectors that keep moving, and a report from 800 m away is placed two and
// a third seconds after the gun that made it has driven off. Only sounds that
// survived the range and voice-budget checks pay for the copy.
function snap(pos) {
  return { x: pos.x, y: pos.y, z: pos.z };
}

function tooBusy(dist, priority) {
  if (activeOneShots < MAX_ONESHOT_VOICES) return false;
  // when the mix is saturated, the near and the important survive
  return !(priority && dist < 220);
}

function gunReport(pos, caliber, opts) {
  if (!ready() || !pos) return;
  const dist = distTo(pos);
  const cal = clamp(caliber || 75, 7.62, 152);
  if (dist > 2200) return;
  if (tooBusy(dist, cal >= 60)) return;
  const at = snap(pos);
  scheduleAt(dist / SPEED_OF_SOUND, (when) => {
    playReport(at, cal, dist, when, opts || {});
  });
}

function playReport(pos, cal, dist, when, opts) {
  const far = farWeight(dist);
  const near = 1 - far;
  // 20 mm sits near 240 Hz and snaps; 122 mm sits near 56 Hz and thumps
  const f0 = 240 * Math.pow(20 / cal, 0.8);
  const size = clamp((cal - 20) / 100, 0, 1.3);
  const dur = 0.18 + size * 0.5;
  const gainScale = (opts.gain == null ? 1 : opts.gain) * (0.55 + size * 0.75);

  const out = ctx.createGain();
  out.gain.value = 1;
  const panner = acquirePanner(loudBus, pos);
  if (panner) out.connect(panner);
  else out.connect(loudBus);

  playBusy = 0;
  const recorded = reportSamples(out, cal, dist, far, near, gainScale, when);
  if (recorded > 0) {
    duck(clamp((0.16 + size * 0.3) * near + 0.06, 0, 0.55), 0.03, 0.4);
    retire(out, panner, when, recorded + 0.1, playBusy + 0.05);
    return;
  }

  const total = dur + far * 0.9;
  const src = noiseNode(when, total + 0.3, 0.75 + Math.random() * 0.4);

  // near half: a bright band with a fast transient on the front
  const nf = ctx.createBiquadFilter();
  nf.type = 'bandpass';
  nf.frequency.setValueAtTime(1400 + 1600 * (1 - size), when);
  nf.frequency.exponentialRampToValueAtTime(320 + 500 * (1 - size), when + dur * 0.8);
  nf.Q.value = 0.7;
  const ng = ctx.createGain();
  env(ng, when, 1.15 * near * gainScale, 0.002, dur * 0.75);
  src.connect(nf);
  nf.connect(ng);
  ng.connect(out);

  // far half: everything above ~400 Hz has been eaten by the air on the way
  const ff = ctx.createBiquadFilter();
  ff.type = 'lowpass';
  ff.frequency.setValueAtTime(520 - 160 * size, when);
  ff.frequency.exponentialRampToValueAtTime(180, when + total);
  ff.Q.value = 0.6;
  const fg = ctx.createGain();
  env(fg, when, 1.0 * far * gainScale, 0.045 + far * 0.05, total);
  src.connect(ff);
  ff.connect(fg);
  fg.connect(out);
  if (far > 0.05) {
    const send = ctx.createGain();
    send.gain.value = far * 0.5;
    fg.connect(send);
    send.connect(tailBus);
  }

  // the body of the gun itself, dropping an octave as the muzzle blast expands
  const body = ctx.createOscillator();
  body.type = 'triangle';
  body.frequency.setValueAtTime(f0 * 1.5, when);
  body.frequency.exponentialRampToValueAtTime(f0 * 0.45, when + dur);
  const bg = ctx.createGain();
  env(bg, when, (0.5 + size * 0.55) * gainScale * (0.6 + far * 0.6), 0.006, dur + far * 0.4);
  body.connect(bg);
  bg.connect(out);
  body.start(when);
  body.stop(when + total + 0.2);

  duck(clamp((0.16 + size * 0.3) * near + 0.06, 0, 0.55), 0.03, 0.4);
  retire(out, panner, when, total + 0.3);
}

// The recorded report: a close take and a genuinely distant take, crossfaded by
// the same farWeight the synth uses, both pushed through the air filter for the
// actual range. Guns under 30 mm borrow the machine-gun takes, pitched to size.
// Returns the seconds it will sound, or 0 to let the synthesised report play.
function reportSamples(out, cal, dist, far, near, gainScale, when) {
  const big = cal >= 30;
  const nName = pickSample(big ? 'cannon_near' : 'mg');
  if (!nName) return 0;
  // a 37 mm cracks a little higher than a 75, a 128 sits lower and rolls longer
  const rate = (big
    ? clamp(Math.pow(75 / cal, 0.3), 0.8, 1.3)
    : clamp(1.25 - (cal - 7.62) * 0.02, 0.7, 1.25)) * jit(0.04);
  const g = gainScale * (big ? SG.cannonNear : SG.smallGun) * jit(0.1);
  let len = 0;
  if (near > 0.02) {
    len = Math.max(len, playSample(nName, when, airFilter(dist, out), rate, g * near));
  }
  if (far > 0.02) {
    // the far take was recorded at range already, so it needs less extra filtering
    const dest = airFilter(dist, out, 1.8);
    const fName = big ? pickSample('cannon_far') : null;
    const fg = fName ? gainScale * SG.cannonFar * jit(0.1) : g * 0.8;
    len = Math.max(len, playSample(fName || nName, when, dest, fName ? rate : rate * 0.92, fg * far, tailBus, far * 0.5));
  }
  return len;
}

function metalImpact(pos, kind) {
  if (!ready() || !pos) return;
  const dist = distTo(pos);
  if (dist > 1400) return;
  // a penetration, or anything hitting close by (your own hull), is information
  // the player needs: it survives a saturated mix where a distant ping does not
  if (tooBusy(dist, kind === 'pen' || dist < 120)) return;
  const at = snap(pos);
  scheduleAt(dist / SPEED_OF_SOUND, (when) => {
    const far = farWeight(dist);
    const out = ctx.createGain();
    out.gain.value = 1;
    const panner = acquirePanner(sfxBus, at);
    if (panner) out.connect(panner);
    else out.connect(sfxBus);

    playBusy = 0;
    const recorded = impactSamples(out, kind, dist, far, when);
    if (recorded > 0) {
      retire(out, panner, when, recorded + 0.05, playBusy + 0.03);
      return;
    }

    if (kind === 'ricochet') {
      // the spinning fragment whining away, up in pitch as it departs
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200 + Math.random() * 400, when);
      osc.frequency.exponentialRampToValueAtTime(2400 + Math.random() * 700, when + 0.2);
      const g = ctx.createGain();
      env(g, when, 0.9 * (1 - far * 0.6), 0.004, 0.22);
      osc.connect(g);
      g.connect(out);
      osc.start(when);
      osc.stop(when + 0.4);
      const n = noiseNode(when, 0.1, 1.4);
      const nf = ctx.createBiquadFilter();
      nf.type = 'bandpass';
      nf.frequency.value = 3200;
      nf.Q.value = 1.4;
      const ng = ctx.createGain();
      env(ng, when, 0.4 * (1 - far), 0.001, 0.07);
      n.connect(nf);
      nf.connect(ng);
      ng.connect(out);
      retire(out, panner, when, 0.5);
      return;
    }

    const pen = kind === 'pen';
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(pen ? 900 : 500, when);
    osc.frequency.exponentialRampToValueAtTime(pen ? 250 : 180, when + 0.1);
    const g = ctx.createGain();
    env(g, when, (pen ? 0.85 : 0.7) * (1 - far * 0.5), 0.002, pen ? 0.1 : 0.12);
    osc.connect(g);
    g.connect(out);
    osc.start(when);
    osc.stop(when + 0.3);

    // the plate ringing: bright and immediate up close, a dull knock far off
    const n = noiseNode(when, 0.2, 1);
    const nf = ctx.createBiquadFilter();
    nf.type = far > 0.5 ? 'lowpass' : 'highpass';
    nf.frequency.value = far > 0.5 ? 500 : 2400;
    const ng = ctx.createGain();
    env(ng, when, 0.5 * (1 - far * 0.35), 0.002, 0.13 + far * 0.2);
    n.connect(nf);
    nf.connect(ng);
    ng.connect(out);
    retire(out, panner, when, 0.5);
  });
}

// Recorded armour hits. A penetration is the crunch of the plate giving way
// with the ring of the hull on top of it; a bounce is only the ring; a ricochet
// is the round leaving. Returns seconds of sound, or 0 for the synth fallback.
function impactSamples(out, kind, dist, far, when) {
  if (kind === 'ricochet') {
    const r = pickSample('ricochet');
    if (!r) return 0;
    return playSample(r, when, airFilter(dist, out), jit(0.08), SG.ricochet * (1 - far * 0.6) * jit(0.12));
  }
  const p = kind === 'pen' ? pickSample('pen') : null;
  if (kind === 'pen' && !p) return 0;
  const c = pickSample('clang');
  if (!p && !c) return 0;
  const dest = airFilter(dist, out);
  let len = 0;
  if (p) len = playSample(p, when, dest, jit(0.07), SG.pen * (1 - far * 0.5) * jit(0.12));
  if (c) {
    // under a penetration the ring is a supporting layer, a little lower and quieter
    const ring = p ? 0.5 : 1;
    const len2 = playSample(c, when, dest, (p ? 0.88 : 1) * jit(0.07), SG.clang * ring * (1 - far * (p ? 0.5 : 0.4)) * jit(0.13));
    len = Math.max(len, len2);
  }
  return len;
}

// ---------------- the ground under an impact (AV-03) ----------------
//
// The same surface record that picked the dust colour and the crater tint
// (the round's own terrain lookup, ShellManager's info.surface, or the
// effects system's per-point lookup) also colours the sound: snow swallows
// the top end, sand dulls it, rock, concrete and masonry ring. One lookup per
// impact feeds all three; nothing here asks the terrain anything itself.

/** 'snow' | 'sand' | 'mud' | 'rock' | 'soil' for a surface record (or null). */
export function surfaceSoundKind(surface) {
  if (!surface) return 'soil';
  if (surface.sound) return surface.sound;
  if (surface.scenery || surface.airfield) return 'rock';
  const t = surface.type;
  if (t === 'snow' || t === 'sand' || t === 'rock' || t === 'mud') return t;
  return 'soil';
}

// Filter a voice by the ground it came off. Returns the node to feed (the
// filter, or `dest` itself for plain soil). The filter lives as long as the
// sources feeding it, like airFilter's.
function surfaceFilter(kind, dest) {
  if (kind === 'soil' || !ctx) return dest;
  const f = ctx.createBiquadFilter();
  if (kind === 'rock') {
    f.type = 'highshelf';
    f.frequency.value = 2400;
    f.gain.value = 5;
  } else {
    f.type = 'lowpass';
    f.frequency.value = kind === 'snow' ? 650 : kind === 'mud' ? 1100 : 1500;
    f.Q.value = 0.5;
  }
  f.connect(dest);
  return f;
}

const blastRec = { flash: {}, core: {}, column: {}, soot: {}, debris: {}, ring: {}, fireball: {}, smoke: {}, marker: {}, sound: {}, shake: {} };

// kg (optional): the charge in kg of TNT. Given it, the voice size and the
// length of the sound are blastOf's (AV-01) — the same law that sized the
// column on screen and the shake. Without it, `size` is the legacy voice size.
function blast(pos, size, kindGain, kg = 0, surface = null) {
  if (!ready() || !pos) return;
  const dist = distTo(pos);
  if (dist > 2400) return;
  const at = snap(pos);
  let lawSize = 0;
  let lawDur = 0;
  if (kg > 0) {
    const b = blastOf(kg, dist, blastRec);
    lawSize = b.sound.size;
    lawDur = b.sound.dur;
  }
  const ground = surfaceSoundKind(surface);
  scheduleAt(dist / SPEED_OF_SOUND, (when) => {
    const far = farWeight(dist);
    const s = lawSize > 0 ? lawSize : clamp(size || 1, 0.3, 3);
    const dur = lawDur > 0 ? lawDur : (0.9 + s * 0.5) * (1 + far * 0.5);

    const out = ctx.createGain();
    out.gain.value = kindGain;
    const panner = acquirePanner(loudBus, at);
    if (panner) out.connect(panner);
    else out.connect(loudBus);
    // everything below feeds `voice`: the ground's colour, then the bus
    const voice = surfaceFilter(ground, out);

    playBusy = 0;
    const recorded = blastSamples(voice, s, dist, far, when, dur);
    if (recorded > 0) {
      duck(clamp(0.35 + s * 0.3 - far * 0.35, 0.1, 0.8), 0.07, 0.6);
      retire(out, panner, when, recorded + 0.2, Math.max(playBusy, 0.3) + 0.05);
      return;
    }

    const n = noiseNode(when, dur + 0.4, 0.55 + Math.random() * 0.3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime((900 - far * 500) / s, when);
    lp.frequency.exponentialRampToValueAtTime(90, when + dur);
    const ng = ctx.createGain();
    env(ng, when, 1.25 * s, 0.004 + far * 0.06, dur);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(voice);

    const send = ctx.createGain();
    send.gain.value = 0.35 + far * 0.5;
    ng.connect(send);
    send.connect(tailBus);

    // the sub thump you feel more than hear
    const sub = ctx.createOscillator();
    sub.type = 'triangle';
    sub.frequency.setValueAtTime(85 / s, when);
    sub.frequency.exponentialRampToValueAtTime(22, when + dur * 0.9);
    const sg = ctx.createGain();
    env(sg, when, 0.9 * s, 0.01, dur * 0.9);
    sub.connect(sg);
    sg.connect(voice);
    sub.start(when);
    sub.stop(when + dur + 0.3);

    // close in there is a hard crack on the front of the blast
    if (far < 0.9) {
      const c = noiseNode(when, 0.06, 1.6);
      const cf = ctx.createBiquadFilter();
      cf.type = 'highpass';
      cf.frequency.value = 1800;
      const cg = ctx.createGain();
      env(cg, when, 0.7 * (1 - far), 0.001, 0.05);
      c.connect(cf);
      cf.connect(cg);
      cg.connect(voice);
    }

    duck(clamp(0.35 + s * 0.3 - far * 0.35, 0.1, 0.8), 0.07, 0.6);
    retire(out, panner, when, dur + 0.5);
  });
}

// Recorded blast: a real charge going off, slowed for size (a bomb is the 4 kg
// TNT take, a brewing tank or a small HE round the shorter ones, sped up), the
// air filter for range and the valley tail for distance. Video-sourced takes
// are thin below 50 Hz, so anything tank-sized and up keeps the synthesised
// sub thump underneath. Returns seconds of sound, or 0 for the synth fallback.
function blastSamples(out, s, dist, far, when, dur) {
  let name = s >= 2 ? pickSample('bomb') : null;
  const bomb = !!name;
  if (!name) name = pickSample('explosion');
  if (!name) return 0;
  const rate = (bomb ? clamp(1.12 - s * 0.1, 0.75, 1.05) : clamp(1.25 - s * 0.2, 0.75, 1.3)) * jit(0.05);
  const gain = (bomb ? SG.bomb : SG.blast) * clamp(0.3 + s * 0.5, 0.35, 1.5) * jit(0.1);
  let len = playSample(name, when, airFilter(dist, out), rate, gain, tailBus, 0.35 + far * 0.5);
  if (s >= 1.2) {
    const sub = ctx.createOscillator();
    sub.type = 'triangle';
    sub.frequency.setValueAtTime(70 / s, when);
    sub.frequency.exponentialRampToValueAtTime(22, when + dur * 0.8);
    const sg = ctx.createGain();
    env(sg, when, 0.55 * s, 0.012, dur * 0.8);
    sub.connect(sg);
    sg.connect(out);
    sub.start(when);
    sub.stop(when + dur + 0.2);
    len = Math.max(len, dur + 0.2);
  }
  return len;
}

let lastMgVoice = 0;

export const sfx3d = {
  // opts: { caliber, gain }
  fire(pos, opts) {
    gunReport(pos, opts && opts.caliber, opts);
  },
  hit(pos) {
    metalImpact(pos, 'pen');
  },
  ricochet(pos) {
    metalImpact(pos, 'ricochet');
  },
  nonpen(pos) {
    metalImpact(pos, 'nonpen');
  },
  // opts: { size, kg, surface }
  //   size     legacy voice size — 1 is a tank brewing up, 2+ is a bomb
  //   kg       the charge in kg of TNT: size and length then come from the
  //            blast law (combat/blast.js), like the picture and the shake
  //   surface  the impact's surface record (AV-03): snow muffles, sand dulls,
  //            rock / concrete / masonry ring
  explosion(pos, opts) {
    blast(pos, opts && opts.size, 1, opts && opts.kg, opts && opts.surface);
  },
  bomb(pos, opts) {
    blast(pos, (opts && opts.size) || 2.4, 1.15, opts && opts.kg, opts && opts.surface);
  },
  // A solid round burying itself in the ground: a short, low thud, coloured
  // by what it went into (AV-03). opts: { caliber, surface }
  groundImpact(pos, opts) {
    if (!ready() || !pos) return;
    const dist = distTo(pos);
    if (dist > 700) return;
    if (tooBusy(dist, false)) return;
    const cal = clamp((opts && opts.caliber) || 75, 20, 152);
    const ground = surfaceSoundKind(opts && opts.surface);
    const at = snap(pos);
    scheduleAt(dist / SPEED_OF_SOUND, (when) => {
      const far = farWeight(dist);
      const out = ctx.createGain();
      out.gain.value = 1;
      const panner = acquirePanner(sfxBus, at);
      if (panner) out.connect(panner);
      else out.connect(sfxBus);
      const voice = surfaceFilter(ground, airFilter(dist, out));
      const k = cal / 88;
      const n = noiseNode(when, 0.22, 0.7);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1400 / Math.sqrt(k), when);
      lp.frequency.exponentialRampToValueAtTime(160, when + 0.18);
      const ng = ctx.createGain();
      env(ng, when, 0.42 * (1 - far * 0.5) * Math.min(1.3, 0.6 + 0.5 * k), 0.002, 0.16);
      n.connect(lp);
      lp.connect(ng);
      ng.connect(voice);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(95 / Math.sqrt(k), when);
      o.frequency.exponentialRampToValueAtTime(38, when + 0.15);
      const og = ctx.createGain();
      env(og, when, 0.5 * (1 - far * 0.4), 0.004, 0.14);
      o.connect(og);
      og.connect(voice);
      o.start(when);
      o.stop(when + 0.3);
      retire(out, panner, when, 0.35);
    });
  },
  mg(pos) {
    if (!ready() || !pos) return;
    const dist = distTo(pos);
    if (dist > 900) return;
    // machine guns fire far faster than they need to be voiced; one node per
    // round would eat the whole pool and sound worse for it
    const now = ctx.currentTime;
    if (now - lastMgVoice < 0.035) return;
    lastMgVoice = now;
    if (tooBusy(dist, false)) return;
    const at = snap(pos);
    scheduleAt(dist / SPEED_OF_SOUND, (when) => {
      const far = farWeight(dist);
      const out = ctx.createGain();
      out.gain.value = 1;
      const panner = acquirePanner(sfxBus, at);
      if (panner) out.connect(panner);
      else out.connect(sfxBus);

      const take = pickSample('mg');
      if (take) {
        playBusy = 0;
        const len = playSample(take, when, airFilter(dist, out), jit(0.05), SG.mg * (1 - far * 0.45) * jit(0.12));
        if (len > 0) {
          retire(out, panner, when, len + 0.05, playBusy + 0.02);
          return;
        }
      }

      const n = noiseNode(when, 0.12, 1.1);
      const f = ctx.createBiquadFilter();
      f.type = far > 0.55 ? 'lowpass' : 'highpass';
      f.frequency.value = far > 0.55 ? 600 : 1500;
      const g = ctx.createGain();
      env(g, when, 0.55 * (1 - far * 0.45), 0.001, 0.05 + far * 0.09);
      n.connect(f);
      f.connect(g);
      g.connect(out);

      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(230 - far * 80, when);
      o.frequency.exponentialRampToValueAtTime(110, when + 0.05);
      const og = ctx.createGain();
      env(og, when, 0.28 * (0.6 + far * 0.5), 0.002, 0.05 + far * 0.08);
      o.connect(og);
      og.connect(out);
      o.start(when);
      o.stop(when + 0.2);
      retire(out, panner, when, 0.3);
    });
  },
  // A round going past your head. No speed-of-sound scheduling worth the name —
  // by definition this happens at the listener — but the pitch sweep sells the
  // Doppler and anything supersonic drags its own shock wave along behind it.
  flyby(pos, speed = 800) {
    if (!ready() || !pos) return;
    const dist = distTo(pos);
    if (dist > 90) return;
    const near = 1 - clamp(dist / 90, 0, 1);
    const out = ctx.createGain();
    out.gain.value = 1;
    const panner = acquirePanner(sfxBus, pos);
    if (panner) out.connect(panner);
    else out.connect(sfxBus);
    const when = ctx.currentTime + 0.005;
    const fast = clamp(speed / 900, 0.3, 1.6);
    const dur = clamp(0.34 / fast, 0.1, 0.4);

    // Recorded: the whoosh of the round, pitched by its speed, plus — anything
    // supersonic — the real ballistic crack on top of it.
    const whoosh = pickSample('whiz');
    const crack = speed > 400 ? pickSample('crack') : null;
    if (whoosh || crack) {
      let len = 0;
      playBusy = 0;
      if (whoosh) {
        const wr = clamp(0.35 + speed / 1400, 0.45, 1.1) * jit(0.05);
        len = playSample(whoosh, when, out, wr, SG.whiz * (0.35 + near) * jit(0.1));
      }
      if (crack) {
        const cg = SG.crack * near * clamp(speed / 800, 0.4, 1.3) * jit(0.1);
        len = Math.max(len, playSample(crack, when, out, jit(0.06), cg));
      }
      if (len > 0) {
        retire(out, panner, when, len + 0.05, playBusy + 0.02);
        return;
      }
    }

    const n = noiseNode(when, dur + 0.15, 1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1500 + 1400 * fast, when);
    bp.frequency.exponentialRampToValueAtTime(260, when + dur);
    bp.Q.value = 2.6;
    const g = ctx.createGain();
    env(g, when, 0.85 * (0.35 + near), 0.012, dur);
    n.connect(bp);
    bp.connect(g);
    g.connect(out);

    // the tonal core of the whoosh, swept down hard: that is the Doppler
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(900 * fast, when);
    o.frequency.exponentialRampToValueAtTime(180, when + dur);
    const og = ctx.createGain();
    env(og, when, 0.3 * (0.3 + near), 0.015, dur);
    o.connect(og);
    og.connect(out);
    o.start(when);
    o.stop(when + dur + 0.2);

    if (speed > 400) {
      const c = noiseNode(when, 0.04, 1.7);
      const cf = ctx.createBiquadFilter();
      cf.type = 'highpass';
      cf.frequency.value = 3000;
      const cg = ctx.createGain();
      env(cg, when, 0.75 * near * clamp(speed / 800, 0.4, 1.3), 0.0008, 0.03);
      c.connect(cf);
      cf.connect(cg);
      cg.connect(out);
    }
    retire(out, panner, when, dur + 0.3);
  },
};

// ---------------- radio / crew cues ----------------

// The audio half of a crew callout. No speech — the HUD carries the words, and
// a squelch plus a two-tone blip is what tells you a callout happened without
// pretending to be a voice actor.
const RADIO = {
  destroyed: { squelch: 0.1, tones: [880, 620], step: 0.1, vol: 0.34, type: 'square', dur: 0.11 },
  critical: { squelch: 0.07, tones: [1050, 1400, 1050], step: 0.07, vol: 0.32, type: 'square', dur: 0.06 },
  reload: { squelch: 0.04, tones: [700, 950], step: 0.06, vol: 0.2, type: 'sine', dur: 0.06 },
  damage: { squelch: 0.08, tones: [520, 400], step: 0.09, vol: 0.28, type: 'sawtooth', dur: 0.1 },
  warning: { squelch: 0.05, tones: [1250, 900, 1250, 900], step: 0.085, vol: 0.3, type: 'triangle', dur: 0.07 },
};

export function radioCue(kind) {
  if (!ready()) return;
  const cfg = RADIO[kind] || RADIO.reload;
  const t0 = ctx.currentTime + 0.005;

  const n = noiseNode(t0, cfg.squelch + 0.05, 1.2);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1900;
  bp.Q.value = 1.1;
  const ng = ctx.createGain();
  env(ng, t0, 0.35, 0.004, cfg.squelch);
  n.connect(bp);
  bp.connect(ng);
  ng.connect(radioBus);

  for (let i = 0; i < cfg.tones.length; i++) {
    const when = t0 + cfg.squelch * 0.7 + i * cfg.step;
    const o = ctx.createOscillator();
    o.type = cfg.type;
    o.frequency.setValueAtTime(cfg.tones[i], when);
    const g = ctx.createGain();
    env(g, when, cfg.vol, 0.005, cfg.dur);
    o.connect(g);
    g.connect(radioBus);
    o.start(when);
    o.stop(when + cfg.dur + 0.08);
  }

  // a callout has to cut through the battle, so it ducks the rest a little
  duck(0.22, 0.05, 0.35);
}

// ---------------- engine voices ----------------

// One pooled voice structure covers both profiles: three oscillators plus a
// filtered noise layer. A tank uses them as a firing-order fundamental with its
// harmonics and track clatter; a plane uses them as a blade-pass tone, a
// slightly detuned twin (that is where the classic prop beat comes from) and
// airflow. Pooling matters because oscillators cannot be restarted — a voice is
// built once and then re-tuned forever.

const engines = new Map();
const voices = [];
let playerVoice = null;
const rankBuf = [];
const staleBuf = [];
let lastRealloc = 0;

const PLAYER_ID = '__player__';
const CULL = { tank: 460, plane: 780 };

function createVoice() {
  const v = {
    id: null,
    player: false,
    type: 'tank',
    positional: false,
    freeAt: 0,
    busy: false,
    shiftLock: 0,
    // recorded layers (see buildEngineLayers): looping sources for one profile,
    // summed through `sfilter` into the same `body` gain the synth layers use,
    // so assign / free / gear dips / reset treat both kinds of voice the same
    sType: null,
    sFail: null,
    sCount: 0,
    sSrc: [null, null, null],
    sGain: [null, null, null],
    sfilter: null,
    synthMuted: false,
    detune: 1,
  };
  v.osc1 = ctx.createOscillator();
  v.osc1.type = 'sawtooth';
  v.osc1.frequency.value = 42;
  v.osc2 = ctx.createOscillator();
  v.osc2.type = 'square';
  v.osc2.frequency.value = 84;
  v.osc3 = ctx.createOscillator();
  v.osc3.type = 'sawtooth';
  v.osc3.frequency.value = 126;

  v.g1 = ctx.createGain();
  v.g1.gain.value = 1;
  v.g2 = ctx.createGain();
  v.g2.gain.value = 0.3;
  v.g3 = ctx.createGain();
  v.g3.gain.value = 0.14;
  v.mix = ctx.createGain();
  v.mix.gain.value = 1;

  v.osc1.connect(v.g1);
  v.osc2.connect(v.g2);
  v.osc3.connect(v.g3);
  v.g1.connect(v.mix);
  v.g2.connect(v.mix);
  v.g3.connect(v.mix);

  v.filter = ctx.createBiquadFilter();
  v.filter.type = 'lowpass';
  v.filter.frequency.value = 220;
  v.filter.Q.value = 0.8;
  v.mix.connect(v.filter);

  v.body = ctx.createGain();
  v.body.gain.value = 0;
  v.filter.connect(v.body);

  v.noise = ctx.createBufferSource();
  v.noise.buffer = noiseBuf;
  v.noise.loop = true;
  v.noise.playbackRate.value = 0.8 + Math.random() * 0.4;
  v.nf = ctx.createBiquadFilter();
  v.nf.type = 'bandpass';
  v.nf.frequency.value = 1200;
  v.nf.Q.value = 0.8;
  v.ng = ctx.createGain();
  v.ng.gain.value = 0;
  v.noise.connect(v.nf);
  v.nf.connect(v.ng);

  // A separate stage for the gear dip so it never fights the per-frame
  // automation running on `body`.
  v.gear = ctx.createGain();
  v.gear.gain.value = 1;
  v.body.connect(v.gear);
  v.ng.connect(v.gear);

  v.fxIn = ctx.createGain();
  v.fxIn.gain.value = 1;

  v.panner = ctx.createPanner();
  configurePanner(v.panner, 'HRTF');
  v.panner.connect(engineBus);

  v.osc1.start();
  v.osc2.start();
  v.osc3.start();
  v.noise.start();
  voices.push(v);
  return v;
}

function routeVoice(v, player) {
  try {
    v.gear.disconnect();
    v.fxIn.disconnect();
  } catch (e) {
    // first route on a fresh voice has nothing to disconnect
  }
  v.positional = !player;
  if (player) {
    v.gear.connect(engineBus);
    v.fxIn.connect(engineBus);
  } else {
    v.gear.connect(v.panner);
    v.fxIn.connect(v.panner);
  }
}

function assignVoice(req) {
  const now = ctx.currentTime;
  let v = null;
  for (let i = 0; i < voices.length; i++) {
    const c = voices[i];
    if (!c.busy && !c.player && c.freeAt <= now) {
      v = c;
      break;
    }
  }
  if (!v) {
    if (voices.length >= MAX_ENGINE_VOICES + 1) return; // +1 for the player voice
    v = createVoice();
  }
  v.busy = true;
  v.id = req.id;
  v.shiftLock = 0;
  // two identical tanks are never quite the same engine
  v.detune = 0.95 + Math.random() * 0.1;
  // v.type is deliberately left alone: applyVoice owns it, and it is what
  // triggers the oscillator re-shaping when a voice is recycled from a tank
  // onto a plane. Setting it here would skip that.
  routeVoice(v, false);
  // come in from silence; an engine that snaps to full level pops
  v.body.gain.cancelScheduledValues(now);
  v.body.gain.setValueAtTime(0.0001, now);
  v.ng.gain.cancelScheduledValues(now);
  v.ng.gain.setValueAtTime(0.0001, now);
  v.gear.gain.cancelScheduledValues(now);
  v.gear.gain.setValueAtTime(1, now);
  req.voice = v;
}

function freeVoice(req) {
  const v = req.voice;
  if (!v) return;
  const now = ctx.currentTime;
  v.body.gain.setTargetAtTime(0.0001, now, 0.04);
  v.ng.gain.setTargetAtTime(0.0001, now, 0.04);
  v.busy = false;
  v.id = null;
  v.freeAt = now + 0.18; // let the fade finish before anyone else takes it
  req.voice = null;
}

// Callers may pass a normalised 0..1 rpm or a real engine speed; either reads
// the same once it is folded back into 0..1.
function normRpm(rpm) {
  if (!(rpm > 0)) return 0;
  return rpm > 3 ? clamp(rpm / 3000, 0, 1.2) : clamp(rpm, 0, 1.2);
}

function makeRequest(id, type) {
  return {
    id,
    type,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    rpm: 0,
    throttle: 0,
    moving: false,
    player: false,
    legacy: null,
    dist: 0,
    lastSeen: 0,
    lastPos: null,
    lastT: 0,
    voice: null,
  };
}

/**
 * Feed one vehicle's engine state. Call every frame for every vehicle you want
 * heard; the pool decides which ~8 actually get a voice.
 *
 * opts: { pos, rpm, throttle, type, moving, shift }
 *   pos      anything with x/y/z (a THREE.Vector3 is fine — not retained)
 *   rpm      0..1 idle..redline, or a raw rpm figure
 *   throttle 0..1
 *   type     'tank' | 'plane'
 *   moving   drives the track-clatter layer on tanks
 *   shift    optional explicit gear-change flag for this frame
 */
export function updateEngine(id, opts) {
  if (!ready() || id == null || !opts) return;
  const type = opts.type === 'plane' ? 'plane' : 'tank';
  let req = engines.get(id);
  if (!req) {
    req = makeRequest(id, type);
    engines.set(id, req);
  }
  req.type = type;
  const now = ctx.currentTime;

  if (opts.pos) {
    // Velocity comes out of the position deltas: it drives both the manual
    // Doppler shift and the panner cone, and no caller has to supply it.
    if (req.lastPos && now > req.lastT) {
      const dt = Math.min(0.25, now - req.lastT);
      if (dt > 0.001) {
        const k = 0.35;
        req.vel.x += ((opts.pos.x - req.lastPos.x) / dt - req.vel.x) * k;
        req.vel.y += ((opts.pos.y - req.lastPos.y) / dt - req.vel.y) * k;
        req.vel.z += ((opts.pos.z - req.lastPos.z) / dt - req.vel.z) * k;
      }
    } else if (!req.lastPos) {
      req.lastPos = { x: opts.pos.x, y: opts.pos.y, z: opts.pos.z };
    }
    req.lastPos.x = opts.pos.x;
    req.lastPos.y = opts.pos.y;
    req.lastPos.z = opts.pos.z;
    req.lastT = now;
    req.pos.x = opts.pos.x;
    req.pos.y = opts.pos.y;
    req.pos.z = opts.pos.z;
  }

  const rpm = normRpm(opts.rpm);
  const throttle = clamp(opts.throttle || 0, 0, 1);
  // A shift shows up as an rpm cliff with the throttle still open — no caller
  // needs to tell us, though one may via { shift: true }.
  const dropped = req.rpm - rpm > 0.18 && throttle > 0.2;
  const shifted = (opts.shift === true || dropped) && type === 'tank';
  req.rpm = rpm;
  req.throttle = throttle;
  req.moving = !!opts.moving;
  req.legacy = opts.legacy || null;
  req.lastSeen = now;
  if (opts.player) req.player = true;

  if (req.voice) {
    if (shifted) gearTransient(req.voice, now);
    applyVoice(req, req.voice, now);
  }

  // Reallocation is throttled — a full ranking every frame for 16 vehicles is
  // pointless when the nearest eight barely change from second to second. A
  // vehicle that has just appeared and can still be given a spare voice is
  // worth a faster look, otherwise it stays mute for up to a fifth of a second.
  const wait = !req.voice && voices.length <= MAX_ENGINE_VOICES ? 0.05 : 0.2;
  if (now - lastRealloc > wait) reallocEngines(now);
}

export function removeEngine(id) {
  const req = engines.get(id);
  if (!req) return;
  if (req.voice) freeVoice(req);
  engines.delete(id);
}

function reallocEngines(now) {
  lastRealloc = now;
  rankBuf.length = 0;
  staleBuf.length = 0;
  engines.forEach((req, id) => {
    // A caller that forgets removeEngine() must not leave a voice droning on
    // an exploded hull forever.
    if (now - req.lastSeen > 1.2) {
      staleBuf.push(id);
      return;
    }
    if (req.player) {
      req.dist = -1;
      rankBuf.push(req);
      return;
    }
    req.dist = distTo(req.pos);
    if (req.dist > CULL[req.type]) {
      if (req.voice) freeVoice(req);
      return;
    }
    rankBuf.push(req);
  });
  for (let i = 0; i < staleBuf.length; i++) removeEngine(staleBuf[i]);

  rankBuf.sort(byDist);
  // The player is always in the list and always first, so budget one extra
  // slot for it: the cap is on how many *other* vehicles can be heard at once.
  const keep = Math.min(MAX_ENGINE_VOICES + 1, rankBuf.length);
  for (let i = keep; i < rankBuf.length; i++) {
    if (rankBuf[i].voice) freeVoice(rankBuf[i]);
  }
  for (let i = 0; i < keep; i++) {
    const req = rankBuf[i];
    if (req.player) {
      if (!req.voice && playerVoice) {
        req.voice = playerVoice;
        playerVoice.busy = true;
        playerVoice.id = req.id;
      }
      continue;
    }
    if (!req.voice) assignVoice(req);
  }
}

function byDist(a, b) {
  return a.dist - b.dist;
}

// Per-frame parameter drive for one voice. Deliberately allocation-free and
// built entirely out of setTargetAtTime so nothing accumulates on the timeline.
function applyVoice(req, v, now) {
  const tc = 0.05;
  const rpm = req.rpm;
  const throttle = req.throttle;

  // Doppler is done by hand: PannerNode velocity was removed from the platform,
  // and a diving Fw 190 without it sounds like a photograph of a plane.
  let doppler = 1;
  let dist = 0;
  if (!req.player) {
    const dx = req.pos.x - listenerPos.x;
    const dy = req.pos.y - listenerPos.y;
    const dz = req.pos.z - listenerPos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    dist = d;
    const closing = -(req.vel.x * dx + req.vel.y * dy + req.vel.z * dz) / d;
    doppler = clamp(1 + closing / SPEED_OF_SOUND, 0.85, 1.18);
  }

  // Recorded loops whenever this profile's set has loaded; a voice whose profile
  // has none (yet, or ever) keeps the synthesised layers below.
  const want = samplesEnabled && engineReady[req.type] && v.sFail !== req.type;
  if (want && v.sType !== req.type) buildEngineLayers(v, req.type, now);
  else if (!want && v.sCount) dropEngineLayers(v, now);
  const sampled = v.sCount > 0 && v.sType === req.type;
  if (!sampled && v.synthMuted) {
    v.synthMuted = false;
    v.mix.gain.setTargetAtTime(1, now, 0.03);
  }

  if (v.type !== req.type) {
    v.type = req.type;
    // A prop's second harmonic is soft; a tank's is the whole character of it.
    v.osc2.type = req.type === 'plane' ? 'triangle' : 'square';
    v.nf.frequency.setTargetAtTime(req.type === 'plane' ? 900 : 1200, now, tc);
  }

  let f0;
  let level;
  let cutoff;

  if (req.legacy) {
    // The player's engine keeps the exact numbers it has always had; the extra
    // harmonic and clatter layers below sit on top of it rather than replacing
    // it, so the vehicle you drive sounds like itself, only fuller.
    f0 = req.legacy.freq;
    level = req.legacy.gain;
    cutoff = req.legacy.filter;
  } else if (req.type === 'plane') {
    f0 = 74 + rpm * 96 + throttle * 20;
    level = 0.06 + throttle * 0.06;
    cutoff = 420 + rpm * 700;
  } else {
    f0 = 30 + rpm * 62 + throttle * 12;
    level = 0.055 + throttle * 0.06;
    cutoff = 190 + rpm * 340 + throttle * 90;
  }
  f0 *= doppler;

  if (sampled) {
    // the oscillators are muted under the recordings; no point re-tuning them
  } else if (req.type === 'plane') {
    // The detuned twin beats against the fundamental a few times a second —
    // that slow warble is most of what makes a piston fighter recognisable.
    v.osc1.frequency.setTargetAtTime(f0, now, tc);
    v.osc2.frequency.setTargetAtTime(f0 * 2.02 + 2.5, now, tc);
    v.osc3.frequency.setTargetAtTime(f0 * 0.5, now, tc);
    v.g2.gain.setTargetAtTime(0.34, now, tc);
    v.g3.gain.setTargetAtTime(0.2, now, tc);
  } else {
    v.osc1.frequency.setTargetAtTime(f0, now, tc);
    v.osc2.frequency.setTargetAtTime(f0 * 2, now, tc);
    v.osc3.frequency.setTargetAtTime(f0 * 3, now, tc);
    // Harmonics come up with rpm: a labouring diesel is all fundamental, a
    // revving one is all edge.
    v.g2.gain.setTargetAtTime(0.18 + rpm * 0.38, now, tc);
    v.g3.gain.setTargetAtTime(0.05 + rpm * 0.26, now, tc);
  }

  let offAxisOpen = 0;
  if (!req.player) {
    // Point the panner cone along the vehicle's travel and open the timbre as
    // the listener moves off that axis: a plane pulling away sounds nothing
    // like one coming head-on.
    const vs = Math.hypot(req.vel.x, req.vel.y, req.vel.z);
    if (vs > 1) {
      const ox = req.vel.x / vs;
      const oy = req.vel.y / vs;
      const oz = req.vel.z / vs;
      const p = v.panner;
      if (p.orientationX) {
        p.orientationX.setTargetAtTime(ox, now, 0.08);
        p.orientationY.setTargetAtTime(oy, now, 0.08);
        p.orientationZ.setTargetAtTime(oz, now, 0.08);
      } else if (p.setOrientation) {
        p.setOrientation(ox, oy, oz);
      }
      const dx = listenerPos.x - req.pos.x;
      const dy = listenerPos.y - req.pos.y;
      const dz = listenerPos.z - req.pos.z;
      const dl = Math.hypot(dx, dy, dz) || 1;
      const axial = (ox * dx + oy * dy + oz * dz) / dl;
      offAxisOpen = 1 - Math.abs(axial);
    }
    if (req.type === 'plane') {
      v.panner.coneInnerAngle = 70;
      v.panner.coneOuterAngle = 250;
      v.panner.coneOuterGain = 0.6;
    } else {
      v.panner.coneInnerAngle = 360;
      v.panner.coneOuterAngle = 360;
      v.panner.coneOuterGain = 1;
    }
    setPannerPos(v.panner, req.pos, true);
    // Enemy engines start further down the inverse curve than the player's, so
    // they need more level at the source to read as a threat at all.
    level *= 1.7;
  }

  if (sampled) {
    driveEngineLayers(req, v, now, doppler, dist, level, offAxisOpen);
    return;
  }

  v.filter.frequency.setTargetAtTime(cutoff + offAxisOpen * 850, now, tc);
  v.body.gain.setTargetAtTime(Math.max(0.0001, level), now, tc);

  // Track clatter for tanks, airflow for planes.
  let nz;
  if (req.type === 'plane') {
    nz = (0.012 + throttle * 0.02) * (0.5 + offAxisOpen);
    v.nf.frequency.setTargetAtTime(700 + rpm * 900, now, tc);
  } else {
    nz = req.moving ? 0.02 + rpm * 0.05 : 0.0001;
    v.nf.frequency.setTargetAtTime(900 + rpm * 1100, now, tc);
  }
  if (!req.player) nz *= 1.7;
  v.ng.gain.setTargetAtTime(Math.max(0.0001, nz), now, tc);
}

// ---------------- recorded engine layers ----------------
//
// A tank voice is three loops of real machinery: a big engine at idle, the same
// engine working hard, and WW2 tracks clattering. Load crossfades idle into run,
// rpm drives playbackRate on both, the tracks come up with speed. A plane is a
// steady in-flight propeller drone plus a close-up Merlin exhaust whose share
// grows with throttle and proximity. Built once per voice and profile — sources
// are only made again when a pooled voice moves from a tank to a plane — and
// re-tuned every frame with setTargetAtTime only, so the frame allocates nothing.

function buildEngineLayers(v, type, now) {
  const names = ENGINE_LAYERS[type];
  dropEngineLayers(v, now);
  try {
    if (!v.sfilter) {
      v.sfilter = ctx.createBiquadFilter();
      v.sfilter.type = 'lowpass';
      v.sfilter.frequency.value = 12000;
      v.sfilter.Q.value = 0.5;
      v.sfilter.connect(v.body);
    }
    for (let i = 0; i < names.length; i++) {
      const lp = SAMPLE_LOOPS[names[i]];
      const src = ctx.createBufferSource();
      src.buffer = sampleBuf[names[i]];
      src.loop = true;
      src.loopStart = lp[0];
      src.loopEnd = lp[1];
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      g.connect(v.sfilter);
      // a random phase, so a column of the same tank never phase-locks
      src.start(now, lp[0] + Math.random() * (lp[1] - lp[0]) * 0.98);
      v.sSrc[i] = src;
      v.sGain[i] = g;
      v.sCount = i + 1;
    }
    v.sType = type;
  } catch (e) {
    // a profile that cannot be built stays synthesised for this voice
    dropEngineLayers(v, now);
    v.sFail = type;
    return false;
  }
  // fast, so the louder recorded body level never carries the synth with it
  v.mix.gain.setTargetAtTime(0, now, 0.01);
  v.ng.gain.setTargetAtTime(0.0001, now, 0.01);
  v.synthMuted = true;
  return true;
}

function dropEngineLayers(v, now) {
  for (let i = 0; i < v.sCount; i++) {
    const g = v.sGain[i];
    const s = v.sSrc[i];
    v.sSrc[i] = null;
    v.sGain[i] = null;
    try {
      if (g) g.gain.setTargetAtTime(0, now, 0.02);
      if (s) s.stop(now + 0.15);
    } catch (e) {
      // already stopped: nothing left to silence
    }
    if (g) scheduleTeardown(g, null, 250, false);
  }
  v.sCount = 0;
  v.sType = null;
}

function setRate(src, rate, now) {
  src.playbackRate.setTargetAtTime(clamp(rate, 0.3, 3), now, 0.05);
}

function setLayer(g, level, now) {
  g.gain.setTargetAtTime(level, now, 0.05);
}

function driveEngineLayers(req, v, now, doppler, dist, level, offAxisOpen) {
  const rpm = clamp(req.rpm, 0, 1.2);
  const th = req.throttle;
  const k = v.detune * doppler;
  let cutoff;
  if (req.type === 'plane') {
    // the drone rises with rpm, the exhaust note with the throttle
    setRate(v.sSrc[0], (0.72 + rpm * 0.4 + th * 0.14) * k, now);
    setLayer(v.sGain[0], 0.9, now);
    setRate(v.sSrc[1], (0.8 + th * 0.3 + rpm * 0.12) * k, now);
    const close = req.player ? 1 : 1 - clamp(dist / 260, 0, 1);
    setLayer(v.sGain[1], (req.player ? 0.3 : 0.12) + th * 0.35 * (0.35 + 0.65 * close), now);
    // a plane coming head-on is muffled by its own disc; off-axis it opens up
    cutoff = req.player ? 15000 : airCutoff(dist) * (0.55 + 0.45 * offAxisOpen);
  } else {
    const load = clamp(rpm * 0.8 + th * 0.3, 0, 1);
    const x = smoothstep(0.1, 0.8, load);
    setRate(v.sSrc[0], (0.86 + rpm * 0.42) * k, now);
    setLayer(v.sGain[0], 0.9 * Math.cos(x * HALF_PI), now);
    setRate(v.sSrc[1], (0.78 + rpm * 0.38 + th * 0.05) * k, now);
    setLayer(v.sGain[1], (0.85 + th * 0.25) * Math.sin(x * HALF_PI), now);
    setRate(v.sSrc[2], (0.7 + rpm * 0.5) * doppler, now);
    setLayer(v.sGain[2], req.moving ? 0.25 + Math.min(rpm, 1) * 0.55 : 0, now);
    cutoff = req.player ? 15000 : airCutoff(dist);
  }
  v.sfilter.frequency.setTargetAtTime(clamp(cutoff, 350, 16000), now, 0.05);
  const gain = req.type === 'plane' ? SG.enginePlane : SG.engineTank;
  v.body.gain.setTargetAtTime(Math.max(0.0001, level * gain), now, 0.05);
}

// The dip-and-blip of a gearbox taking the next ratio: torque comes off the
// tracks for a moment, there is a clunk, and then it bites again.
function gearTransient(v, now) {
  if (now < v.shiftLock) return;
  v.shiftLock = now + 0.35;
  const g = v.gear.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0.32, now + 0.05);
  g.setValueAtTime(0.32, now + 0.1);
  g.linearRampToValueAtTime(1.18, now + 0.18); // the blip as it re-engages
  g.linearRampToValueAtTime(1, now + 0.3);

  const n = noiseNode(now + 0.09, 0.09, 1);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 330;
  f.Q.value = 1.6;
  const ng = ctx.createGain();
  env(ng, now + 0.09, 0.09, 0.002, 0.07);
  n.connect(f);
  f.connect(ng);
  ng.connect(v.fxIn);
  // Same record-based teardown as the one-shots: a shift landing right on the
  // battle's last frame used to leave this filter chain hanging off v.fxIn.
  scheduleTeardown(ng, null, 400, false);
}

// speedNorm, throttle in [0..1]; profile: 'tank' | 'plane'
// Unchanged contract — it now just drives the player's entry in the engine pool.
// shift (optional, AV-04): the drivetrain changed gear THIS frame — the same
// event the exhaust puff is thrown on, so the clunk and the puff coincide.
export function updateEngineSound(throttle, speedNorm, active, profile = 'tank', shift = false) {
  if (!ready() || !playerVoice) return;
  const th = clamp(throttle || 0, 0, 1);
  const sn = clamp(speedNorm || 0, 0, 2);
  let targetFreq;
  let targetGain;
  let targetFilter;
  if (profile === 'plane') {
    targetFreq = active ? 72 + sn * 88 + th * 22 : 42;
    targetGain = active ? 0.04 + th * 0.05 : 0;
    targetFilter = 380 + sn * 640;
  } else {
    targetFreq = active ? 42 + sn * 50 + th * 14 : 42;
    targetGain = active ? 0.035 + th * 0.05 : 0;
    targetFilter = 180 + sn * 320;
  }
  ambProfile = profile === 'plane' ? 'plane' : 'tank';
  ambSpeed = active ? sn : 0;
  updateEngine(PLAYER_ID, {
    pos: listenerPos,
    rpm: active ? clamp(sn * 0.75 + th * 0.35, 0, 1) : 0,
    throttle: active ? th : 0,
    type: profile === 'plane' ? 'plane' : 'tank',
    moving: active && sn > 0.02,
    shift: active && shift === true,
    player: true,
    legacy: { freq: targetFreq, gain: targetGain, filter: targetFilter },
  });
}

// ---------------- ambience ----------------
//
// Two recorded beds under the battle, both only ever driven from updateAudio()
// (so the hangar stays quiet) and faded out by resetAudio(): wind — a breeze
// over open ground for a tank crew, a rush that climbs with airspeed for a
// pilot — and a distant battle that thins out as the listener climbs away
// from the ground war. Both are kept well under the real, positional sounds:
// they are atmosphere, never information.

let ambProfile = 'tank';
let ambSpeed = 0;
let ambWind = null;
let ambBattle = null;

function startBed(name, now) {
  const buf = sampleBuf[name];
  const lp = SAMPLE_LOOPS[name];
  if (!buf || !lp) return null;
  try {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = lp[0];
    src.loopEnd = lp[1];
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g);
    g.connect(sfxBus);
    src.start(now, lp[0] + Math.random() * (lp[1] - lp[0]) * 0.98);
    return { src, g };
  } catch (e) {
    return null;
  }
}

function driveAmbience(now) {
  if (!samplesEnabled) {
    if (ambWind) ambWind.g.gain.setTargetAtTime(0, now, 0.2);
    if (ambBattle) ambBattle.g.gain.setTargetAtTime(0, now, 0.2);
    return;
  }
  if (!ambWind && sampleBuf.amb_wind) ambWind = startBed('amb_wind', now);
  if (!ambBattle && sampleBuf.amb_battle) ambBattle = startBed('amb_battle', now);
  const plane = ambProfile === 'plane';
  const alt = listenerPos.y;
  if (ambWind) {
    const sp = clamp(ambSpeed, 0, 1.4);
    const w = plane ? 0.06 + 0.55 * sp * sp : 0.16 + 0.1 * smoothstep(30, 250, alt);
    ambWind.g.gain.setTargetAtTime(w * SG.wind, now, 0.6);
    ambWind.src.playbackRate.setTargetAtTime(plane ? 0.8 + 0.45 * sp : 0.9, now, 0.6);
  }
  if (ambBattle) {
    const b = 1 - smoothstep(80, 600, alt);
    ambBattle.g.gain.setTargetAtTime(b * SG.battle, now, 1.0);
  }
}

// ---------------- rain (stub for W-01) ----------------
//
// The contract the rain lane calls from scenery.addWeather(): 0 = dry, 1 =
// a downpour. Recorded only, for now — the bed itself arrives with W-01's
// sample; until then a call is harmless and silent.
let rainLevel = 0;
export function rainBed(level) {
  rainLevel = clamp(Number(level) || 0, 0, 1);
  return rainLevel;
}

// ---------------- housekeeping ----------------

// Optional per-frame tick. Everything works without it (updateEngine reallocs
// on its own), but calling it once a frame keeps culling prompt on the frames
// where no engine reported in at all — a wing that just died, for instance.
export function updateAudio() {
  if (!ready()) return;
  const now = ctx.currentTime;
  if (now - lastRealloc > 0.2) reallocEngines(now);
  driveAmbience(now);
}

// Drop every scheduled sound and silence every engine. Worth calling when a
// battle ends, otherwise reports still in flight arrive over the results screen.
export function resetAudio() {
  pendingTimers.forEach((id) => clearTimeout(id));
  pendingTimers.clear();
  // Pending teardowns are RUN, not cancelled. Cancelling them is what used to
  // leak: the panner never came back to the pool and its `out` gain stayed
  // wired to its bus for the rest of the session.
  pendingTeardowns.forEach((rec) => runTeardown(rec));
  pendingTeardowns.clear();
  if (!ready()) {
    engines.clear();
    return;
  }
  engines.forEach((req) => {
    if (req.voice) freeVoice(req);
  });
  engines.clear();
  activeOneShots = 0;
  liveOneShots = 0;
  const now = ctx.currentTime;
  duckGain.gain.cancelScheduledValues(now);
  duckGain.gain.setValueAtTime(1, now);
  duckTarget = 1;
  duckEnds = 0;
  if (playerVoice) {
    playerVoice.busy = false;
    playerVoice.body.gain.setTargetAtTime(0.0001, now, 0.03);
    playerVoice.ng.gain.setTargetAtTime(0.0001, now, 0.03);
  }
  // the beds only come back when a battle starts calling updateAudio() again
  if (ambWind) ambWind.g.gain.setTargetAtTime(0, now, 0.15);
  if (ambBattle) ambBattle.g.gain.setTargetAtTime(0, now, 0.15);
  ambSpeed = 0;
}
