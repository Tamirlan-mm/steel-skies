// Diagnostics log: errors, warnings, frame hitches and periodic performance
// samples, kept in a ring buffer that survives reloads (localStorage), so a
// player can open it after something went wrong and send it to the developer.
//
//   F8 (or #logs in the address)  open / close the log panel
//   panel buttons                 Copy · Download .json · Clear
//
// Everything here is best-effort and must never throw into the game.

const KEY = 'steelSkies.log.v1';
const PLAYER_KEY = 'steelSkies.player.v1';
const MAX_ENTRIES = 1500;
const MAX_UNSENT = 5000; // never drop an entry the server has not confirmed, up to this
const HITCH_MS = 100; // a frame this long is logged as a hitch
const GAP_MS = 15000; // longer than this was no frame: sleep, a debugger, a hidden tab
const SAMPLE_EVERY_S = 30; // performance sample period during a battle

// Upload: entries are kept locally (survive reloads) until the collector
// acknowledges them, then marked sent. Offline or blocked (e.g. a host whose
// CSP forbids the request) they simply wait for the next attempt.
const ENDPOINT = 'https://steel-skies-logs.tamirlan-meshiyev.workers.dev/ingest';
const FLUSH_EVERY_MS = 15000;
const BATCH = 300;

const rid = (n = 16) => {
  const a = new Uint8Array(n);
  (globalThis.crypto || { getRandomValues: (x) => x.map(() => (Math.random() * 256) | 0) }).getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
};
let playerId = null;
const sessionId = rid(16);
let flushing = false;

const entries = [];
let ctx = { mode: 'hangar' };
let renderer = null;
let getExtra = null;
let saveTimer = null;
let panel = null;
let started = false;

function now() {
  return new Date().toISOString();
}

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(trimmed()));
    } catch { /* storage full or blocked */ }
  }, 1000);
}

function short(v) {
  try {
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof v === 'string') return v.slice(0, 2000);
    return JSON.stringify(v).slice(0, 2000);
  } catch {
    return String(v).slice(0, 2000);
  }
}

// The kept log: the last MAX_ENTRIES sent entries plus every unsent one (up to
// MAX_UNSENT), in order.
function trimmed() {
  let unsent = 0;
  for (const e of entries) if (!e.sent) unsent++;
  let keepSent = MAX_ENTRIES;
  const out = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e.sent) {
      if (unsent-- <= MAX_UNSENT) out.push(e);
    } else if (keepSent-- > 0) out.push(e);
  }
  return out.reverse();
}

function deviceLite() {
  const d = deviceInfo();
  return { ua: d.ua, gpu: d.gpu, screen: d.screen, cores: d.cores, memGB: d.memGB };
}

async function flush(useBeacon = false) {
  if (flushing || typeof fetch !== 'function' || !playerId) return;
  const batch = [];
  for (const e of entries) {
    if (!e.sent) batch.push(e);
    if (batch.length >= BATCH) break;
  }
  if (!batch.length) return;
  const body = JSON.stringify({
    player: playerId, session: sessionId, build: document.lastModified, device: deviceLite(),
    entries: batch.map((e) => ({ uid: e.uid, t: e.t, kind: e.kind, msg: e.msg, ctx: e.ctx, data: e.data })),
  });
  if (useBeacon && navigator.sendBeacon) {
    // the page is going away: hand it to the browser; the entries stay unsent
    // locally and are re-sent next time (the server ignores duplicates)
    try { navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' })); } catch { /* ignore */ }
    return;
  }
  flushing = true;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST', body, keepalive: body.length < 60000, headers: { 'Content-Type': 'text/plain' },
    });
    if (res.ok) {
      const j = await res.json();
      const ack = new Set(j.ack || []);
      for (const e of batch) if (ack.has(e.uid)) e.sent = 1;
      persist();
      if (batch.length >= BATCH) setTimeout(() => flush(), 500);
    }
  } catch { /* offline / blocked: retry later */ }
  flushing = false;
}

// kind: 'error' | 'warn' | 'hitch' | 'camjerk' | 'perf' | 'event' | 'info'
const repeats = new Map(); // a message that repeats every frame must not flood the log
const REPEAT_CAP = 20;
const REPEAT_CAP_FRAMES = 80;

export function logEvent(kind, msg, data = null) {
  try {
    const text = short(msg);
    if (kind === 'error' || kind === 'warn' || kind === 'hitch' || kind === 'camjerk') {
      // hitches and camera jerks: capped per battle (mode + vehicle), with
      // room for a battle's worth of detail (wave 8: 20 per session left 100+
      // hitches of a 30-minute session unexplained)
      const perBattle = kind === 'hitch' || kind === 'camjerk';
      const key = kind + '|' + (perBattle ? `${ctx.mode}|${ctx.vehicle || ''}|${ctx.battle || ''}` : text);
      const n = (repeats.get(key) || 0) + 1;
      repeats.set(key, n);
      if (n > (perBattle ? REPEAT_CAP_FRAMES : REPEAT_CAP)) {
        if (n % 100 === 0) logEvent('info', `repeated ×${n}: ${text}`.slice(0, 300));
        return;
      }
    }
    const e = { uid: rid(20), t: now(), kind, msg: text, ctx: { ...ctx } };
    if (data != null) e.data = data;
    entries.push(e);
    if (entries.length > (MAX_ENTRIES + MAX_UNSENT) * 1.1) {
      const keep = trimmed();
      entries.length = 0;
      entries.push(...keep);
    }
    if (kind === 'error') setTimeout(() => flush(), 1000);
    persist();
    if (panel && panel.style.display !== 'none') renderPanel();
  } catch { /* never throw */ }
}

// What the game is doing right now; merged into every entry.
export function setLogContext(patch) {
  // another battle, or back in the hangar: the time between the last frame of
  // one and the first of the next is not a frame
  if (patch && ((patch.mode !== undefined && patch.mode !== ctx.mode) || (patch.battle !== undefined && patch.battle !== ctx.battle))) noteFrameGap();
  ctx = { ...ctx, ...patch };
}

// Frame clocks restart: whatever comes next is not measured against the past.
function noteFrameGap() {
  lastFrameTs = NaN;
  tickGap = true;
}

export function setLogRenderer(r, extra = null) {
  renderer = r;
  getExtra = extra;
}

function deviceInfo() {
  const info = {
    ua: navigator.userAgent,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
    viewport: `${innerWidth}x${innerHeight}`,
    cores: navigator.hardwareConcurrency,
    memGB: navigator.deviceMemory,
  };
  try {
    const gl = renderer && renderer.getContext();
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) info.gpu = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
  } catch { /* ignore */ }
  return info;
}

function pctOf(arr, q) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1);
}

export function perfSnapshot(frames) {
  const s = frames.slice().sort((a, b) => a - b);
  const pick = (q) => (s.length ? +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1) : null);
  const out = {
    fps: s.length ? +(1000 / (s.reduce((a, b) => a + b, 0) / s.length)).toFixed(1) : null,
    p50ms: pick(0.5),
    p95ms: pick(0.95),
    p99ms: pick(0.99),
    maxms: s.length ? +s[s.length - 1].toFixed(1) : null,
  };
  try {
    if (renderer) {
      // wave 8: renderer.info is reset once per FRAME by main.js
      // (autoReset off), so these are the whole frame's draws — every pass —
      // not the last full-screen quad's 1 call / 1 triangle
      const fr = frameStats;
      if (fr.n) {
        out.calls = pctOf(fr.calls, 0.5);
        out.callsMax = Math.max(...fr.calls);
        out.tris = pctOf(fr.tris, 0.5);
        out.updMs = pctOf(fr.upd, 0.5);
        out.updP95 = pctOf(fr.upd, 0.95);
        out.rndMs = pctOf(fr.rnd, 0.5);
        out.rndP95 = pctOf(fr.rnd, 0.95);
        if (fr.gpu.length) {
          out.gpuMs = pctOf(fr.gpu, 0.5);
          out.gpuP95 = pctOf(fr.gpu, 0.95);
        }
        out.newPrograms = fr.prog;
        out.newTextures = fr.tex;
      } else {
        out.calls = renderer.info.render.calls;
        out.tris = renderer.info.render.triangles;
      }
      out.geom = renderer.info.memory.geometries;
      out.tex = renderer.info.memory.textures;
      out.programs = renderer.info.programs ? renderer.info.programs.length : undefined;
      out.canvas = `${renderer.domElement.width}x${renderer.domElement.height}`;
    }
    out.hitches = hitchCount.n;
    out.stalls = hitchCount.stall;
    out.camJerks = jerkCount.n;
    out.mouseSpikes = jerkCount.mouse;
    hitchCount.n = 0;
    hitchCount.stall = 0;
    jerkCount.n = 0;
    jerkCount.mouse = 0;
    resetFrameStats();
    if (performance.memory) out.heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
    if (getExtra) Object.assign(out, getExtra());
  } catch { /* ignore */ }
  return out;
}

// ---------------------------------------------------------------------------
// wave 8: per-frame breakdown, long tasks, and the camera-jerk detector
// ---------------------------------------------------------------------------
//
// main.js reports every frame (reportFrame) with what it measured: the game
// update and the render submission in ms (CPU), the chain's GPU time when it
// has a timer, the renderer's whole-frame calls / triangles (renderer.info is
// no longer auto-reset per render() call: main.js resets it once a frame) and
// how many programs / textures / geometries the frame created. A frame whose
// interval is over HITCH_MS is then logged WITH that breakdown, the long tasks
// and long animation frames (script attribution) the browser saw in it, the
// names of the shader programs it compiled, the heap change (a drop is a GC)
// and the pacer's state. Without main.js reporting (the hangar) the rAF tick
// below still logs bare hitches.

const hitchCount = { n: 0, stall: 0 };
const jerkCount = { n: 0, mouse: 0 };
const frameStats = { n: 0, calls: [], tris: [], upd: [], rnd: [], gpu: [], prog: 0, tex: 0 };
function resetFrameStats() {
  frameStats.n = 0;
  frameStats.calls.length = 0;
  frameStats.tris.length = 0;
  frameStats.upd.length = 0;
  frameStats.rnd.length = 0;
  frameStats.gpu.length = 0;
  frameStats.prog = 0;
  frameStats.tex = 0;
}
const FRAME_STATS_MAX = 4000; // ~30 s at 144 Hz; older frames are dropped

let lastReport = -1e9;   // performance.now() of the last reportFrame()
let lastFrameTs = NaN;   // its rAF timestamp (NaN after a gap: no interval yet)
let tickGap = false;     // the same, for the bare rAF tick
let gapHooked = false;
let prevRec = null;      // the previous frame's record (the work before a hitch)
let lastProgId = -1;     // newest program id already seen
let lastHeap = NaN;
const longTasks = [];    // { t, d, name } — PerformanceObserver 'longtask'
const longFrames = [];   // { t, d, block, scripts } — 'long-animation-frame'

function pushRing(a, e, max = 24) {
  a.push(e);
  if (a.length > max) a.shift();
}

function observeLongTasks() {
  if (typeof PerformanceObserver !== 'function') return;
  try {
    const lt = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const at = e.attribution && e.attribution[0];
        pushRing(longTasks, { t: e.startTime, d: Math.round(e.duration), name: at ? `${at.containerType || ''}${at.containerName ? ':' + at.containerName : ''}` || e.name : e.name });
      }
    });
    lt.observe({ type: 'longtask', buffered: false });
  } catch { /* not supported */ }
  try {
    const loaf = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const scripts = (e.scripts || [])
          .filter((s) => s.duration >= 10)
          .slice(0, 4)
          .map((s) => `${(s.sourceFunctionName || s.invoker || '?').slice(0, 60)}@${String(s.sourceURL || '').split('/').pop().slice(0, 40)}:${s.sourceCharPosition ?? ''} ${Math.round(s.duration)}ms`);
        pushRing(longFrames, {
          t: e.startTime,
          d: Math.round(e.duration),
          block: Math.round(e.blockingDuration || 0),
          render: e.renderStart ? Math.round(e.startTime + e.duration - e.renderStart) : undefined,
          scripts,
        });
      }
    });
    loaf.observe({ type: 'long-animation-frame', buffered: false });
  } catch { /* not supported (Chrome < 123, Firefox) */ }
}

// What happened between two rAF stamps: long tasks / long frames overlapping it.
function overlapping(ring, t0, t1) {
  const out = [];
  for (const e of ring) if (e.t + e.d >= t0 - 1 && e.t <= t1 + 1) out.push(e);
  return out;
}

function newProgramNames() {
  const out = [];
  try {
    const progs = renderer && renderer.info && renderer.info.programs;
    if (!progs) return out;
    let maxId = lastProgId;
    for (const p of progs) {
      if (p.id > lastProgId) {
        if (out.length < 12) out.push(String(p.name || p.cacheKey || p.id).slice(0, 48));
        if (p.id > maxId) maxId = p.id;
      }
    }
    lastProgId = maxId;
  } catch { /* ignore */ }
  return out;
}

// A hidden tab stops rAF, and the first frame back is visible again by the time
// it is reported, so only the transition itself tells.
function hookGaps() {
  if (gapHooked) return;
  gapHooked = true;
  try {
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', noteFrameGap);
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pageshow', noteFrameGap);
      window.addEventListener('focus', noteFrameGap); // a fully occluded window runs rAF at ~1 Hz
    }
  } catch { /* no DOM */ }
}

// main.js, once per frame, after it has drawn:
//   rec = { ts (rAF stamp), dt (game step s), upd, rnd (ms), gpu (ms|NaN),
//           calls, tris, prog, tex, geo (created this frame),
//           scale, pacer: { locked, interval, residual } }
// Returns nothing; never throws.
export function reportFrame(rec) {
  try {
    hookGaps();
    const nowT = typeof performance !== 'undefined' ? performance.now() : Date.now();
    lastReport = nowT;
    const names = rec.prog > 0 ? newProgramNames() : null;
    if (rec.prog > 0 && !names.length) newProgramNames();
    if (frameStats.n < FRAME_STATS_MAX) {
      frameStats.n++;
      frameStats.calls.push(rec.calls | 0);
      frameStats.tris.push(rec.tris | 0);
      frameStats.upd.push(rec.upd);
      frameStats.rnd.push(rec.rnd);
      if (rec.gpu > 0) frameStats.gpu.push(rec.gpu);
    }
    frameStats.prog += rec.prog | 0;
    frameStats.tex += rec.tex | 0;
    const iv = rec.ts - lastFrameTs;
    const heap = typeof performance !== 'undefined' && performance.memory ? performance.memory.usedJSHeapSize / 1048576 : NaN;
    if (iv >= GAP_MS && ctx.mode !== 'hangar') {
      logEvent('event', `frame gap ${Math.round(iv / 1000)} s`, { iv: Math.round(iv) });
    } else if (
      iv > HITCH_MS && ctx.mode !== 'hangar' &&
      (typeof document === 'undefined' || document.visibilityState === 'visible')
    ) {
      // an alt-tab leaves the page "visible" and rAF at 1 Hz or stopped: logged
      // for what it is, but it says nothing about the game's frame time
      let unfocused = false;
      try { unfocused = typeof document !== 'undefined' && !!document.hasFocus && !document.hasFocus(); } catch { /* ignore */ }
      if (!unfocused) {
        hitchCount.n++;
        if (iv >= 500) hitchCount.stall++;
      }
      const p = prevRec || {};
      const data = {
        iv: Math.round(iv),
        // the work of the frame that ran long (the one before this stamp) and
        // of this one; whatever is left of iv was spent outside the game
        // (GPU wait, GC, the browser, another tab)
        prev: { upd: p.upd, rnd: p.rnd, gpu: p.gpu, prog: p.prog, tex: p.tex, geo: p.geo, calls: p.calls },
        cur: { upd: rec.upd, rnd: rec.rnd, prog: rec.prog, tex: rec.tex, geo: rec.geo, calls: rec.calls },
        dt: rec.dt != null ? +(+rec.dt).toFixed(4) : undefined,
        scale: rec.scale,
        // main.js refills one object per frame: this hitch keeps its own
        pacer: rec.pacer ? { ...rec.pacer } : undefined,
      };
      if (unfocused) data.unfocused = true;
      const progNames = (p.names || []).concat(names || []);
      if (progNames.length) data.programs = progNames.slice(0, 12);
      if (Number.isFinite(heap) && Number.isFinite(lastHeap)) data.heapDeltaMB = +(heap - lastHeap).toFixed(1);
      const t1 = nowT;
      const t0 = t1 - iv - 20;
      const lt = overlapping(longTasks, t0, t1);
      if (lt.length) data.longTasks = lt.map((e) => `${e.d}ms ${e.name || ''}`.trim());
      const lf = overlapping(longFrames, t0, t1);
      if (lf.length) data.longFrames = lf.map((e) => ({ d: e.d, block: e.block, render: e.render, scripts: e.scripts }));
      logEvent('hitch', `frame ${iv.toFixed(0)} ms`, data);
    }
    lastHeap = heap;
    lastFrameTs = rec.ts;
    // main.js refills one record per frame: keep a copy of what the next
    // hitch will want to know about this frame
    const pr = prevRec || (prevRec = {});
    pr.upd = rec.upd;
    pr.rnd = rec.rnd;
    pr.gpu = rec.gpu;
    pr.prog = rec.prog;
    pr.tex = rec.tex;
    pr.geo = rec.geo;
    pr.calls = rec.calls;
    pr.names = names;
  } catch { /* never throw */ }
}

// The camera-jerk detector. Pure (no DOM): node harnesses use it directly.
//
// Each frame it is handed the final camera pose (after shake) and the context
// the battle knows: the raw aim angles (what the mouse / nose-follow asked
// for), the vehicle's position, the frame step. It measures the camera's
// angular velocity w (quaternion delta / dt, a vector) and the aim's own wa,
// and flags a frame where the change of w is not explained by the change of
// the aim: |dw| > |dwa| + JERK_RAD_S. For the position it takes the camera's
// second difference minus the vehicle's (rigid chase cameras: zero), over
// JERK_POS_M. Cuts (a view change, a respawn, a jump over CUT_M, a field of
// view step) are not jerks. Mouse spikes (one frame's counts far above the
// recent ones) are reported on their own.
export const JERK = Object.freeze({
  radS: 0.9,      // rad/s of angular-velocity change in one frame, beyond the aim's...
  angRad: 0.015,  // ...or, when the frame is long, what makes a 0.86 deg kink of the
                  // view that frame (the same 0.9 rad/s at 60 Hz, 0.3 at 20 Hz)
  posM: 0.12,     // m of unexplained position second difference in one frame
  cutM: 6,        // a camera that moves further than this in a frame was cut
  fovDeg: 2.5,    // ...or whose field of view stepped this much
  mouseK: 8,      // a frame's counts over this x the recent median...
  mouseMin: 220,  // ...and over this many counts is a mouse spike
});

export function createJerkDetector(opts = {}) {
  const th = { ...JERK, ...opts };
  const st = {
    has: 0, qx: 0, qy: 0, qz: 0, qw: 1, px: 0, py: 0, pz: 0, fov: 0, view: '',
    wx: 0, wy: 0, wz: 0, hasW: false,
    awx: 0, awy: 0, awz: 0, ayaw: NaN, apitch: NaN,
    dpx: 0, dpy: 0, dpz: 0, dvx: 0, dvy: 0, dvz: 0, hasD: false,
    vx: NaN, vy: 0, vz: 0,
    mouse: [],
    worst: 0, count: 0, frames: 0, mouseSpikes: 0, shakeJerks: 0,
    dwaD: 0,
    dwN: 0, dwSq: 0, dwMax: 0,   // the view's own roughness, explained or not
  };
  // the aim's angular velocity: yaw about world up, pitch about the
  // horizontal right of the aim
  function aimOmega(yaw, pitch, dt, out) {
    if (!Number.isFinite(st.ayaw) || !Number.isFinite(yaw)) { out[0] = out[1] = out[2] = 0; return false; }
    let dy = yaw - st.ayaw;
    dy -= Math.PI * 2 * Math.round(dy / (Math.PI * 2));
    const dp = pitch - st.apitch;
    // the pitch axis: forward x world up = (-cos yaw, 0, sin yaw); a positive
    // pitch step is a positive rotation about it
    const rx = -Math.cos(yaw);
    const rz = Math.sin(yaw);
    out[0] = (rx * dp) / dt;
    out[1] = dy / dt;
    out[2] = (rz * dp) / dt;
    return true;
  }
  const aw = [0, 0, 0];
  return {
    // cam: THREE camera (position, quaternion, fov). c: {
    //   dt (s), view (string: a change is a cut), aimYaw, aimPitch (rad, raw
    //   aim; omit when there is none), vehicle ({x,y,z} position), mouseDX,
    //   mouseDY (counts this frame), shake (bool), ...anything else, copied
    //   into the report }
    // Returns null or a report { kind: 'cam'|'pos'|'mouse', ... }.
    sample(cam, c = {}) {
      const dt = c.dt;
      if (!(dt > 0) || !cam) return null;
      const q = cam.quaternion;
      const p = cam.position;
      const fov = cam.fov || 0;
      st.frames++;
      let report = null;
      // mouse spike: this frame's counts against the median of the last 30
      const m = Math.hypot(c.mouseDX || 0, c.mouseDY || 0);
      if (m > 0) {
        const arr = st.mouse;
        if (arr.length >= 10) {
          const s = arr.slice().sort((a, b) => a - b);
          const med = s[s.length >> 1];
          if (m > th.mouseMin && m > th.mouseK * Math.max(med, 4)) {
            st.mouseSpikes++;
            report = { kind: 'mouse', counts: Math.round(m), dx: c.mouseDX, dy: c.mouseDY, median: +med.toFixed(1) };
          }
        }
        arr.push(m);
        if (arr.length > 30) arr.shift();
      }
      const cut = !st.has || c.view !== st.view ||
        Math.hypot(p.x - st.px, p.y - st.py, p.z - st.pz) > th.cutM ||
        Math.abs(fov - st.fov) > th.fovDeg;
      let wx = 0, wy = 0, wz = 0;
      if (!cut) {
        // relative rotation r = q * conj(q_prev), as an axis-angle vector
        let rx = q.w * -st.qx + q.x * st.qw + q.y * -st.qz - q.z * -st.qy;
        let ry = q.w * -st.qy - q.x * -st.qz + q.y * st.qw + q.z * -st.qx;
        let rz = q.w * -st.qz + q.x * -st.qy - q.y * -st.qx + q.z * st.qw;
        let rw = q.w * st.qw - q.x * -st.qx - q.y * -st.qy - q.z * -st.qz;
        if (rw < 0) { rx = -rx; ry = -ry; rz = -rz; rw = -rw; }
        const sn = Math.hypot(rx, ry, rz);
        const ang = 2 * Math.atan2(sn, rw);
        const k = sn > 1e-12 ? ang / sn / dt : 2 / dt;
        wx = rx * k; wy = ry * k; wz = rz * k;
      }
      const haveAim = Number.isFinite(c.aimYaw) && aimOmega(c.aimYaw, c.aimPitch || 0, dt, aw);
      // What the aim's own changes of rate explain: a view on a spring answers
      // a step of the aim over the next frames, not all in the frame it came,
      // so the explanation fades (25 /s, a touch slower than the view springs)
      // instead of ending at once.
      const dwaNow = haveAim ? Math.hypot(aw[0] - st.awx, aw[1] - st.awy, aw[2] - st.awz) : 0;
      st.dwaD = Math.max(dwaNow, st.dwaD * Math.exp(-25 * dt));
      if (!cut && st.hasW) {
        const dw = Math.hypot(wx - st.wx, wy - st.wy, wz - st.wz);
        // and a view closing on the aim's rate is doing its job, however long the
        // frame: at 20 Hz the spring's answer to a step spans two whole frames
        const closing = haveAim ? Math.hypot(aw[0] - st.wx, aw[1] - st.wy, aw[2] - st.wz) : 0;
        const dwa = Math.max(st.dwaD, closing);
        const excess = dw - dwa;
        if (!c.shake) {
          st.dwN++;
          st.dwSq += dw * dw;
          if (dw > st.dwMax) st.dwMax = dw;
        }
        if (excess > st.worst && !c.shake) st.worst = excess;
        // a view the hand drives with nothing to compare it to (a crew station:
        // no aim angles) only tells when the mouse has been still; a dead or
        // spectator camera is a shot, not the player's view
        const unjudged = (!haveAim && /^station/.test(c.view || '') && c.mouseIdle !== true) || c.view === 'dead' || c.view === 'spectate';
        if (!unjudged && excess > Math.min(th.radS, th.angRad / dt)) {
          if (c.shake) st.shakeJerks++;
          else st.count++;
          report = {
            kind: 'cam',
            dw: +dw.toFixed(2), dwAim: +dwa.toFixed(2),
            w: +Math.hypot(wx, wy, wz).toFixed(2), wPrev: +Math.hypot(st.wx, st.wy, st.wz).toFixed(2),
            wAim: haveAim ? +Math.hypot(aw[0], aw[1], aw[2]).toFixed(2) : undefined,
            dt: +dt.toFixed(4),
          };
        }
      }
      // position: the camera's second difference less the vehicle's
      const v = c.vehicle;
      if (!cut && st.has) {
        // as velocities (m/s), so an uneven dt is not a jump; the difference
        // is put back in metres over this frame's step
        const dpx = (p.x - st.px) / dt, dpy = (p.y - st.py) / dt, dpz = (p.z - st.pz) / dt;
        let dvx = 0, dvy = 0, dvz = 0;
        if (v && Number.isFinite(st.vx)) { dvx = (v.x - st.vx) / dt; dvy = (v.y - st.vy) / dt; dvz = (v.z - st.vz) / dt; }
        if (st.hasD) {
          const ex = ((dpx - st.dpx) - (dvx - st.dvx)) * dt;
          const ey = ((dpy - st.dpy) - (dvy - st.dvy)) * dt;
          const ez = ((dpz - st.dpz) - (dvz - st.dvz)) * dt;
          // a chase camera orbits its vehicle: the aim's own change of rate
          // moves the eye by that x the arm x dt, which is the player's hand
          const arm = haveAim && v ? Math.hypot(p.x - v.x, p.y - v.y, p.z - v.z) : 0;
          const wNow = Math.hypot(wx, wy, wz);
          // (and a steady orbit bends the eye's path by arm x w^2 x dt^2 each frame)
          const closing = haveAim ? Math.hypot(aw[0] - st.wx, aw[1] - st.wy, aw[2] - st.wz) : 0;
          const e = Math.hypot(ex, ey, ez) - Math.max(st.dwaD, closing) * arm * dt - arm * wNow * wNow * dt * dt;
          // (a second difference grows with dt squared; once per 60 Hz frame is enough)
          if (e > th.posM * Math.max(1, dt * 60) && !report && c.view !== 'dead' && c.view !== 'spectate') {
            if (c.shake) st.shakeJerks++;
            else st.count++;
            report = { kind: 'pos', jump: +e.toFixed(3), dy: +ey.toFixed(3), dt: +dt.toFixed(4) };
          }
        }
        st.dpx = dpx; st.dpy = dpy; st.dpz = dpz;
        st.dvx = dvx; st.dvy = dvy; st.dvz = dvz;
        st.hasD = true;
      } else {
        st.hasD = false;
      }
      if (report) {
        report.view = c.view;
        for (const key in c) {
          if (key === 'vehicle' || key === 'dt' || key === 'view') continue;
          const val = c[key];
          report[key] = typeof val === 'number' ? +val.toFixed(4) : val;
        }
      }
      st.qx = q.x; st.qy = q.y; st.qz = q.z; st.qw = q.w;
      st.px = p.x; st.py = p.y; st.pz = p.z;
      st.fov = fov;
      st.view = c.view;
      st.has = 1;
      if (cut) { st.hasW = false; } else { st.wx = wx; st.wy = wy; st.wz = wz; st.hasW = true; }
      if (haveAim) { st.awx = aw[0]; st.awy = aw[1]; st.awz = aw[2]; } else { st.awx = st.awy = st.awz = 0; }
      st.ayaw = Number.isFinite(c.aimYaw) ? c.aimYaw : NaN;
      st.apitch = Number.isFinite(c.aimPitch) ? c.aimPitch : NaN;
      if (v) { st.vx = v.x; st.vy = v.y; st.vz = v.z; } else st.vx = NaN;
      return report;
    },
    reset() { st.has = 0; st.hasW = false; st.hasD = false; st.ayaw = NaN; st.vx = NaN; st.dwaD = 0; st.mouse.length = 0; },
    get stats() { return { frames: st.frames, jerks: st.count, shakeJerks: st.shakeJerks, worst: +st.worst.toFixed(2), mouseSpikes: st.mouseSpikes, dwRms: +Math.sqrt(st.dwSq / Math.max(1, st.dwN)).toFixed(3), dwMax: +st.dwMax.toFixed(2) }; },
  };
}

// The game's own detector: main.js feeds it every battle frame. Reports go to
// the log as kind 'camjerk' (capped like hitches), counts into the perf sample.
const gameJerks = createJerkDetector();
export function watchCamera(cam, c) {
  try {
    const r = gameJerks.sample(cam, c);
    if (!r) return null;
    if (r.kind === 'mouse') jerkCount.mouse++;
    else if (!r.shake) jerkCount.n++;
    logEvent('camjerk', r.kind === 'mouse' ? `mouse spike ${r.counts} counts` : `camera ${r.kind} jerk`, r);
    return r;
  } catch {
    return null;
  }
}
export function resetCameraWatch() {
  gameJerks.reset();
}
export function cameraWatchStats() {
  return gameJerks.stats;
}

export function initTelemetry() {
  if (started) return;
  started = true;
  observeLongTasks();
  hookGaps();
  try {
    const old = JSON.parse(localStorage.getItem(KEY) || '[]');
    // entries from before upload existed had no uid: give them one so they go up too
    if (Array.isArray(old)) for (const e of old) { if (!e.uid) e.uid = rid(20); entries.push(e); }
  } catch { /* ignore */ }
  try {
    playerId = localStorage.getItem(PLAYER_KEY);
    if (!playerId || !/^[a-z0-9]{6,64}$/.test(playerId)) {
      playerId = rid(16);
      localStorage.setItem(PLAYER_KEY, playerId);
    }
  } catch {
    playerId = rid(16);
  }
  setInterval(() => flush(), FLUSH_EVERY_MS);
  setTimeout(() => flush(), 5000);
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
  logEvent('info', 'session start', { url: location.href.split('#')[0], build: document.lastModified });

  window.addEventListener('error', (ev) => {
    logEvent('error', ev.message || 'error', {
      src: ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : undefined,
      stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 3000) : undefined,
    });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    logEvent('error', 'unhandled promise: ' + short(r), r && r.stack ? { stack: String(r.stack).slice(0, 3000) } : null);
  });
  // console.error / warn also land in the log (shader compile errors arrive here)
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      logEvent(level === 'error' ? 'error' : 'warn', args.map(short).join(' '));
    };
  }

  // frame timing: hitches immediately, a summary every SAMPLE_EVERY_S
  let last = performance.now();
  let frames = [];
  let sampleT = 0;
  const tick = (t) => {
    const dt = t - last;
    last = t;
    const gap = tickGap;
    tickGap = false;
    if (document.visibilityState === 'visible' && dt < 5000 && !gap) {
      frames.push(dt);
      // a battle frame is reported (with its breakdown) by reportFrame();
      // this bare line only covers frames nobody reports
      if (dt > HITCH_MS && ctx.mode !== 'hangar' && t - lastReport > 1000) {
        hitchCount.n++;
        logEvent('hitch', `frame ${dt.toFixed(0)} ms`);
      }
      sampleT += dt;
      if (sampleT >= SAMPLE_EVERY_S * 1000) {
        if (ctx.mode !== 'hangar') logEvent('perf', 'sample', perfSnapshot(frames));
        frames = [];
        sampleT = 0;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.addEventListener('keydown', (e) => {
    if (e.code === 'F8') {
      e.preventDefault();
      toggleLogPanel();
    }
  });
  if (location.hash === '#logs') setTimeout(() => toggleLogPanel(true), 500);
  setTimeout(() => logEvent('info', 'device', deviceInfo()), 3000);
}

// Hook for the WebGL canvas: a lost context is the classic "black screen".
export function watchContext(canvas) {
  try {
    canvas.addEventListener('webglcontextlost', () => logEvent('error', 'WebGL context lost'));
    canvas.addEventListener('webglcontextrestored', () => logEvent('info', 'WebGL context restored'));
  } catch { /* ignore */ }
}

export function logReport() {
  return {
    game: 'Steel Skies',
    exported: now(),
    device: deviceInfo(),
    counts: entries.reduce((m, e) => ((m[e.kind] = (m[e.kind] || 0) + 1), m), {}),
    entries,
  };
}

// Clears the local view of everything already uploaded; entries the server
// has not confirmed yet are kept so nothing is lost.
export function clearLog() {
  const keep = entries.filter((e) => !e.sent);
  entries.length = 0;
  entries.push(...keep);
  persist();
  logEvent('info', 'log cleared');
}

function renderPanel() {
  const list = panel.querySelector('.ssLogList');
  const counts = logReport().counts;
  const pending = entries.filter((e) => !e.sent).length;
  panel.querySelector('.ssLogHead span').textContent =
    `LOG · errors ${counts.error || 0} · warnings ${counts.warn || 0} · hitches ${counts.hitch || 0} · samples ${counts.perf || 0}` +
    ` · ${pending ? `${pending} waiting to upload` : 'all uploaded'} · player ${playerId}`;
  const rows = entries.slice(-300).reverse().map((e) => {
    const d = e.data ? ' ' + short(e.data) : '';
    return `<div class="ssLog ${e.kind}"><b>${e.t.slice(11, 19)}</b> [${e.kind}] ${escapeHtml(e.msg)}${escapeHtml(d).slice(0, 400)} <i>${escapeHtml(e.ctx.mode || '')}</i></div>`;
  });
  list.innerHTML = rows.join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function toggleLogPanel(force) {
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'ssLogPanel';
    panel.innerHTML = `
      <div class="ssLogHead"><span>LOG</span>
        <button data-a="copy">Copy</button><button data-a="dl">Download</button>
        <button data-a="clear">Clear</button><button data-a="close">Close (F8)</button></div>
      <div class="ssLogList"></div>`;
    const st = document.createElement('style');
    st.textContent = `
      #ssLogPanel{position:fixed;inset:6% 6%;z-index:99999;background:rgba(12,14,16,.96);color:#dfe3e6;
        font:12px/1.35 ui-monospace,Consolas,monospace;display:flex;flex-direction:column;border:1px solid #556}
      #ssLogPanel .ssLogHead{display:flex;gap:8px;align-items:center;padding:8px;border-bottom:1px solid #445;flex-wrap:wrap}
      #ssLogPanel .ssLogHead span{flex:1;min-width:200px;font-weight:700}
      #ssLogPanel button{font:inherit;padding:8px 12px;min-height:40px;background:#2a3038;color:#eef;border:1px solid #667;cursor:pointer}
      #ssLogPanel .ssLogList{overflow:auto;padding:8px;flex:1}
      #ssLogPanel .ssLog{padding:2px 0;border-bottom:1px solid #222;word-break:break-word}
      #ssLogPanel .ssLog.error{color:#ff8a7a}#ssLogPanel .ssLog.warn{color:#f0c060}
      #ssLogPanel .ssLog.hitch{color:#9fc0ff}#ssLogPanel .ssLog.camjerk{color:#e0a0ff}#ssLogPanel .ssLog.perf{color:#9fe0a8}
      #ssLogPanel i{color:#889;font-style:normal}`;
    document.head.appendChild(st);
    panel.addEventListener('click', async (e) => {
      const a = e.target && e.target.dataset && e.target.dataset.a;
      if (!a) return;
      const text = JSON.stringify(logReport(), null, 1);
      if (a === 'copy') {
        try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Copy failed'; }
      } else if (a === 'dl') {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `steel-skies-log-${now().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } else if (a === 'clear') {
        clearLog();
        renderPanel();
      } else if (a === 'close') {
        toggleLogPanel(false);
      }
    });
    document.body.appendChild(panel);
    panel.style.display = 'none';
  }
  const show = force ?? panel.style.display === 'none';
  panel.style.display = show ? 'flex' : 'none';
  if (show) {
    if (document.pointerLockElement) document.exitPointerLock?.();
    renderPanel();
  }
}
