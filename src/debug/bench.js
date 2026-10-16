import * as THREE from 'three';
import { terrainHeight, roadDistanceAt } from '../world/terrain.js';
import { environmentState } from '../world/scenery.js';
import { getMaterialQuality } from '../core/materials.js';

// P-01 bench mode (?bench).
//
// Runs scripted camera paths through REAL battles at a fixed seed and preset,
// on every graphics tier, and reports per path and tier:
//
//   cpu     ms of main-thread work per frame: simulation + three's scene walk +
//           draw submission (the time shell.frame() takes), p50 / p95 / p99
//   gpu     ms per composer pass and their sum, from EXT_disjoint_timer_query_
//           webgl2 when the browser exposes it (a whole-frame query on the low
//           tier, which has no composer); otherwise "n/a"
//   wall    ms from the start of a frame until WebGL reports its fence
//           signalled (frames are serialised on that fence, so one frame's
//           GPU work never queues behind the next one's CPU work). Chrome
//           tracks the fence through its GPU process, so it can signal before
//           the GPU has finished, and a hidden pane polls it late: treat it
//           as information, not as a frame time. The timer queries are the
//           GPU number; note they time a pass from its first to its last GPU
//           command, so a pass whose CPU side is slow (the scene draw) also
//           counts the GPU idling between its draws.
//   calls / triangles   renderer.info over the WHOLE frame (every pass), not
//           the last render() call three's autoReset would leave
//
// The paths (backlog P-01, plus one per remaining battle mode):
//   ground_pan    ground battle, a 360-degree third-person pan at the spawn
//   scope_600     ground battle, the gun sight at 16 deg on ground 600 m out
//   air_chase     air battle, the chase camera on the player at 1,200 m
//   scope_smoke   ground battle, the sight at 6 deg into a fresh smoke screen
//   low_pan       ground battle (meadow), 20 m over a parcel edge and a road
//   combined_pan  combined battle, an elevated pan over the player's tank
//
// On "high" the P-02 A/B is run on air_chase and ground_pan: the same frames
// with GTAO re-rendering the scene for its own G-buffer (the pre-P-02 chain)
// against GTAO on the beauty depth, draw calls and CPU side by side.
//
// The address picks what runs:
//   ?bench                 everything (6 paths x 3 tiers, 600 frames each)
//   ?bench=quick           180 frames per path
//   &frames=N  &tiers=high,medium  &paths=air_chase,low_pan  &ab=0
//   &autostart=0           wait for window.__bench.run()
// Results: window.__bench.results, one JSON line on the console
// ("[bench] RESULT {...}"), and a table in the overlay. Graphics tiers set
// here are never persisted; the player's own tier is put back at the end.
//
// Nothing in this file runs unless the address carries ?bench (main.js loads
// it on demand).

const DT = 1 / 60;
const SEED = 0x5eed1234;
const PRESET = Object.freeze({ biome: 'meadow', tod: 'noon', weather: 'clear' });
const BUDGET = Object.freeze({ cpuMs: 11, gpuMs: 13 });

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function mulberry32(a) {
  let s = a >>> 0;
  return function rnd() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

function stats(arr) {
  if (!arr.length) return null;
  let sum = 0;
  let max = -Infinity;
  for (const v of arr) {
    sum += v;
    if (v > max) max = v;
  }
  const r3 = (v) => (v == null ? null : +v.toFixed(3));
  return {
    p50: r3(pct(arr, 0.5)),
    p95: r3(pct(arr, 0.95)),
    p99: r3(pct(arr, 0.99)),
    mean: r3(sum / arr.length),
    max: r3(max),
    n: arr.length,
  };
}

// A macrotask that is not throttled in a hidden pane (setTimeout chains are
// clamped to 1 Hz there and requestAnimationFrame stops altogether).
const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
const waiting = [];
if (channel) {
  channel.port1.onmessage = () => {
    const r = waiting.shift();
    if (r) r();
  };
}
function nextTask() {
  if (!channel) return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => {
    waiting.push(r);
    channel.port2.postMessage(0);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// GPU timer (EXT_disjoint_timer_query_webgl2)
// ---------------------------------------------------------------------------

function createGpuTimer(gl, onTotal = null) {
  const ext = gl && typeof gl.getExtension === 'function'
    ? gl.getExtension('EXT_disjoint_timer_query_webgl2')
    : null;
  const ok = !!(ext && typeof gl.createQuery === 'function');
  let active = null;      // the query in flight (they cannot nest)
  let frame = null;       // { queries: [{ name, q }] } being recorded
  const pending = [];     // frames waiting for their results
  const done = [];        // [{ total, passes: { name: ms } }]

  function begin(name) {
    if (!ok || !frame || active) return false;
    // another query (postfx's own) is open: queries cannot nest
    if (typeof gl.getQuery === 'function' && gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return false;
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    active = { name, q };
    return true;
  }
  function end() {
    if (!active) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    frame.queries.push(active);
    active = null;
  }
  function poll() {
    if (!ok) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    while (pending.length) {
      const f = pending[0];
      const ready = f.queries.every((e) => gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE));
      if (!ready) break;
      pending.shift();
      const passes = {};
      let total = 0;
      for (const e of f.queries) {
        const ms = gl.getQueryParameter(e.q, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(e.q);
        passes[e.name] = (passes[e.name] || 0) + ms;
        total += ms;
      }
      if (!disjoint && f.queries.length && onTotal) {
        try {
          onTotal(total);
        } catch {
          /* instrumentation only */
        }
      }
      if (!disjoint && f.record && f.queries.length) done.push({ total, passes });
    }
  }
  // Time fn() under its own name in the middle of whatever query is open
  // (they cannot nest): the open one is closed, fn is timed, and the open
  // one's name is resumed; per-name times add up in poll().
  function split(name, fn) {
    if (!ok || !frame) return fn();
    const prev = active ? active.name : null;
    if (prev) end();
    const mine = begin(name);
    try {
      return fn();
    } finally {
      if (mine) end();
      if (prev) begin(prev);
    }
  }
  return {
    ok,
    begin,
    end,
    split,
    get active() {
      return !!active;
    },
    startFrame(record) {
      frame = { queries: [], record };
    },
    endFrame() {
      if (active) end();
      if (frame) pending.push(frame);
      frame = null;
    },
    poll,
    // results recorded since the last take()
    take() {
      poll();
      return done.splice(0, done.length);
    },
    // drop everything in flight (between runs)
    flush() {
      for (const f of pending) for (const e of f.queries) gl.deleteQuery(e.q);
      pending.length = 0;
      done.length = 0;
    },
  };
}

// Wrap every composer pass so it times itself. Idempotent per pass object.
function instrumentPasses(passes, timer) {
  passes.forEach((pass, i) => {
    if (!pass || pass.__benchWrapped) return;
    const name = pass.__kind || `pass${i}`;
    const base = pass.render;
    pass.render = function timedPass(...args) {
      const mine = timer.begin(name);
      try {
        return base.apply(this, args);
      } finally {
        if (mine) timer.end();
      }
    };
    pass.__benchWrapped = true;
  });
}

// ---------------------------------------------------------------------------
// the camera paths
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

const AIR_CHASE_AGL = 1200;   // m (backlog P-01)

function groundAt(x, z) {
  return terrainHeight(x, z);
}

function lookFrom(camera, pos, target, fov) {
  camera.position.copy(pos);
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  if (Number.isFinite(fov) && camera.fov !== fov) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
}

// toward the far side of the map from the player, or along the hull
function enemyward(battle) {
  const p = battle.player.position;
  const flat = Math.hypot(p.x, p.z);
  if (flat > 60) return Math.atan2(-p.x, -p.z);
  const yaw = Number.isFinite(battle.player.yaw) ? battle.player.yaw : 0;
  return yaw;
}

// a point on a road near the player, and the road's direction there
function findRoad(near) {
  let best = null;
  for (let i = -20; i <= 20; i++) {
    for (let j = -20; j <= 20; j++) {
      const x = near.x + i * 18;
      const z = near.z + j * 18;
      let d;
      try {
        d = roadDistanceAt(x, z);
      } catch {
        return null;
      }
      if (!Number.isFinite(d)) continue;
      // nearest road, but not hugging the map edge
      const score = d + Math.hypot(i, j) * 0.6;
      if (!best || score < best.score) best = { x, z, d, score };
    }
  }
  if (!best || best.d > 60) return null;
  // the gradient of the distance field is the road's normal; walk onto it
  const e = 2;
  const gx = roadDistanceAt(best.x + e, best.z) - roadDistanceAt(best.x - e, best.z);
  const gz = roadDistanceAt(best.x, best.z + e) - roadDistanceAt(best.x, best.z - e);
  const gl = Math.hypot(gx, gz) || 1;
  const nx = gx / gl;
  const nz = gz / gl;
  const x = best.x - nx * best.d;
  const z = best.z - nz * best.d;
  return { x, z, tx: -nz, tz: nx, nx, nz };
}

const PATHS = [
  {
    id: 'ground_pan',
    mode: 'ground',
    spec: 'tiger',
    ab: true,
    camera(b, f, ctx) {
      const a = ctx.yaw0 + f * Math.PI * 2;
      const c = ctx.center;
      _v.set(c.x - Math.sin(a) * 9, 0, c.z - Math.cos(a) * 9);
      _v.y = Math.max(groundAt(_v.x, _v.z) + 1.5, c.y + 3.2);
      _w.set(c.x + Math.sin(a) * 60, c.y + 1.0, c.z + Math.cos(a) * 60);
      lookFrom(b.camera, _v, _w, 60);
    },
    setup(b, ctx) {
      ctx.center = b.player.position.clone();
      ctx.yaw0 = enemyward(b);
    },
  },
  {
    id: 'scope_600',
    mode: 'ground',
    spec: 'tiger',
    optic: true,
    camera(b, f, ctx) {
      b.sniper = true;
      if ('sniperFov' in b) b.sniperFov = 16;
      const a = ctx.yaw0 + Math.sin(f * Math.PI * 2) * (6 * Math.PI) / 180;
      const c = ctx.center;
      _v.set(c.x, c.y + 2.4, c.z);
      const tx = c.x + Math.sin(a) * 600;
      const tz = c.z + Math.cos(a) * 600;
      _w.set(tx, groundAt(tx, tz) + 1.5, tz);
      lookFrom(b.camera, _v, _w, 16);
    },
    setup(b, ctx) {
      ctx.center = b.player.position.clone();
      ctx.yaw0 = enemyward(b);
    },
  },
  {
    id: 'air_chase',
    mode: 'air',
    spec: 'p51',
    ab: true,
    // The battle's own chase camera, 1,200 m over the ground. The game holds
    // every aeroplane under y = 1,000 m (planeEntity's ceiling), so the
    // physics flies at the ceiling and, after each update, the aeroplane and
    // the chase camera (rigid on it: planeCamera rebuilds the pose from the
    // aircraft every frame) are lifted together to 1,200 m AGL for the draw.
    camera(b) {
      const p = b.player;
      if (!p || !p.position) return;
      const lift = groundAt(p.position.x, p.position.z) + AIR_CHASE_AGL - p.position.y;
      if (!(lift > 0)) return;
      p.position.y += lift;
      b.camera.position.y += lift;
      b.camera.updateMatrixWorld();
    },
    setup(b) {
      const p = b.player;
      if (!p || typeof p.setPose !== 'function') return;
      const x = p.position.x;
      const z = p.position.z;
      const yaw = Math.atan2(-x, -z);
      p.setPose(x, groundAt(x, z) + AIR_CHASE_AGL, z, yaw);
    },
  },
  {
    id: 'scope_smoke',
    mode: 'ground',
    spec: 'tiger',
    optic: true,
    camera(b, f, ctx) {
      b.sniper = true;
      if ('sniperFov' in b) b.sniperFov = 6;
      const a = ctx.yaw0 + Math.sin(f * Math.PI * 2) * (1.5 * Math.PI) / 180;
      const c = ctx.center;
      _v.set(c.x, c.y + 2.4, c.z);
      _w.set(c.x + Math.sin(a) * ctx.dist, ctx.smokeY + 3, c.z + Math.cos(a) * ctx.dist);
      lookFrom(b.camera, _v, _w, 6);
    },
    setup(b, ctx) {
      ctx.center = b.player.position.clone();
      ctx.yaw0 = enemyward(b);
      ctx.dist = 120;
      const fx = Math.sin(ctx.yaw0);
      const fz = Math.cos(ctx.yaw0);
      const sx = ctx.center.x + fx * ctx.dist;
      const sz = ctx.center.z + fz * ctx.dist;
      ctx.smokeY = groundAt(sx, sz);
      // a screen of three grenades across the line of sight, as a platoon
      // would lay it
      for (const off of [-14, 0, 14]) {
        const x = sx + fz * off;
        const z = sz - fx * off;
        b.effects?.smokeScreen?.(new THREE.Vector3(x, groundAt(x, z) + 1.2, z), 12, 40);
      }
    },
    // the screen needs a couple of seconds to build before it is "fresh"
    warmFrames: 150,
  },
  {
    id: 'low_pan',
    mode: 'ground',
    spec: 'tiger',
    camera(b, f, ctx) {
      const r = ctx.road;
      const s = -150 + f * 300;
      const x = r.x + r.tx * s - r.nx * 25;
      const z = r.z + r.tz * s - r.nz * 25;
      _v.set(x, groundAt(x, z) + 20, z);
      const ax = r.x + r.tx * (s + 45);
      const az = r.z + r.tz * (s + 45);
      _w.set(ax, groundAt(ax, az), az);
      lookFrom(b.camera, _v, _w, 60);
    },
    setup(b, ctx) {
      const p = b.player.position;
      const road = findRoad(p);
      ctx.roadFound = !!road;
      ctx.road = road || {
        x: p.x, z: p.z, tx: 1, tz: 0, nx: 0, nz: 1,
      };
    },
  },
  {
    id: 'combined_pan',
    mode: 'combined',
    vehicleType: 'ground',
    spec: 't34',
    camera(b, f, ctx) {
      const a = ctx.yaw0 + f * Math.PI * 2;
      const c = ctx.center;
      _v.set(c.x - Math.sin(a) * 14, 0, c.z - Math.cos(a) * 14);
      _v.y = Math.max(groundAt(_v.x, _v.z) + 2, c.y + 6);
      _w.set(c.x + Math.sin(a) * 80, c.y + 8, c.z + Math.cos(a) * 80);
      lookFrom(b.camera, _v, _w, 60);
    },
    setup(b, ctx) {
      ctx.center = b.player.position.clone();
      ctx.yaw0 = enemyward(b);
    },
  },
];

// ---------------------------------------------------------------------------
// the overlay (in-house, DOM only)
// ---------------------------------------------------------------------------

function makeOverlay() {
  if (typeof document === 'undefined') return null;
  const el = document.createElement('div');
  el.id = 'benchOverlay';
  el.style.cssText = [
    'position:fixed', 'top:8px', 'right:8px', 'z-index:80', 'max-width:min(760px,calc(100vw - 16px))',
    'max-height:calc(100vh - 16px)', 'overflow:auto', 'padding:8px 10px',
    'font:11px/1.35 ui-monospace,Consolas,monospace', 'color:#24242a',
    'background:rgba(236,230,214,0.95)', 'border:1px solid #24242a', 'white-space:pre',
  ].join(';');
  const head = document.createElement('div');
  head.style.cssText = 'font-weight:700;letter-spacing:1.5px;margin-bottom:4px';
  head.textContent = 'BENCH · P-01';
  const line = document.createElement('div');
  const table = document.createElement('div');
  table.style.marginTop = '6px';
  const btn = document.createElement('button');
  btn.textContent = 'COPY JSON';
  btn.style.cssText = 'display:none;margin-top:6px;font:inherit;border:1px solid #24242a;background:transparent;color:inherit;padding:2px 8px;cursor:pointer';
  el.append(head, line, table, btn);
  document.body.appendChild(el);
  return {
    status(text) {
      line.textContent = text;
    },
    table(text) {
      table.textContent = text;
    },
    copy(json) {
      btn.style.display = 'inline-block';
      btn.onclick = () => {
        try {
          navigator.clipboard?.writeText(json);
          btn.textContent = 'COPIED';
        } catch {
          btn.textContent = 'SEE CONSOLE';
        }
      };
    },
  };
}

function tableOf(results) {
  const f = (v, d = 1) => (v == null ? '  n/a' : v.toFixed(d).padStart(5));
  const rows = ['tier    path          cpu p50  p95   gpu p50  p95   calls    tris  scale  cast  flag'];
  for (const r of results.runs) {
    rows.push([
      r.tier.padEnd(7),
      r.path.padEnd(13),
      f(r.cpu?.p50), f(r.cpu?.p95),
      '  ', f(r.gpu?.total?.p50), f(r.gpu?.total?.p95),
      String(r.calls?.p50 ?? '-').padStart(7),
      String(Math.round((r.triangles?.p50 ?? 0) / 1000)).padStart(6) + 'k',
      (r.renderScale && r.renderScale.p50 != null ? r.renderScale.p50.toFixed(2) : '   - ').padStart(6),
      String(r.casters ?? '-').padStart(5),
      String(r.castersFlagged ?? '-').padStart(5),
    ].join(' '));
  }
  if (results.p02 && Object.keys(results.p02).length) {
    rows.push('');
    rows.push('P-02 (high): draw calls, GTAO own G-buffer -> beauty depth');
    for (const [k, v] of Object.entries(results.p02)) {
      rows.push(`  ${k.padEnd(12)} ${v.own} -> ${v.beauty}  (-${v.saved})  cpu p50 ${f(v.cpuOwn)} -> ${f(v.cpuBeauty)} ms`);
    }
  }
  return rows.join(String.fromCharCode(10));
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

function readOptions(query) {
  const q = query || new URLSearchParams('');
  const v = q.get('bench');
  const quick = v === 'quick';
  const frames = Math.max(30, Math.min(5000, Number(q.get('frames')) || (quick ? 180 : 600)));
  const tiers = (q.get('tiers') || 'low,medium,high').split(',').map((s) => s.trim()).filter((s) => ['low', 'medium', 'high'].includes(s));
  const want = (q.get('paths') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const paths = want.length ? PATHS.filter((p) => want.includes(p.id)) : PATHS.slice();
  return {
    frames,
    tiers: tiers.length ? tiers : ['low', 'medium', 'high'],
    paths,
    ab: q.get('ab') !== '0',
    autostart: q.get('autostart') !== '0',
    scale: q.has('scale') ? Number(q.get('scale')) : NaN,
  };
}

export function startBench(shell) {
  const opts = readOptions(shell.flags && shell.flags.query);
  const ui = makeOverlay();
  const renderer = shell.renderer;
  const gl = renderer.getContext();
  // every timed frame's total also steers the chain's render scale (P-04):
  // the bench owns the timer queries, so the chain cannot run its own
  const timer = createGpuTimer(gl, (ms) => shell.postfx?.reportGpuMs?.(ms));
  let running = false;
  let cancelled = false;

  // the shadow map's share of the scene draw ('shadow'), carved out of
  // whichever pass query is open when three renders it
  const sm = renderer.shadowMap;
  const shadowDraws = { last: NaN };
  if (sm && typeof sm.render === 'function' && !sm.__benchWrapped) {
    const base = sm.render;
    sm.render = function timedShadow(...args) {
      // the draw calls three actually issued for the map: the casters that
      // survived its own frustum cull against the shadow camera
      const c0 = renderer.info.render.calls;
      const out = timer.split('shadow', () => base.apply(this, args));
      // summed over the frame: a chain renders the scene several times and
      // only the first of them updates the map
      const d = renderer.info.render.calls - c0;
      shadowDraws.last = (Number.isFinite(shadowDraws.last) ? shadowDraws.last : 0) + d;
      return out;
    };
    sm.__benchWrapped = true;
  }

  const api = {
    shell,
    state: 'idle',
    results: null,
    options: {
      frames: opts.frames, tiers: opts.tiers, paths: opts.paths.map((p) => p.id), ab: opts.ab,
    },
    run: (o) => run(o),
    cancel() {
      cancelled = true;
    },
  };
  window.__bench = api;

  // One frame, measured. Serialised on a fence: the next frame starts only
  // once the GPU has finished this one.
  async function step(record, sink) {
    const usePasses = !!(shell.postfx && shell.postfx.running);
    renderer.info.reset();
    timer.startFrame(record);
    const frameQuery = !usePasses && timer.begin('frame');
    const t0 = performance.now();
    shell.frame(DT);
    const t1 = performance.now();
    if (frameQuery) timer.end();
    timer.endFrame();
    const calls = renderer.info.render.calls;
    const tris = renderer.info.render.triangles;
    let fence = null;
    try {
      fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
    } catch {
      fence = null;
    }
    for (let i = 0; i < 400; i++) {
      await nextTask();
      if (!fence) break;
      const s = gl.getSyncParameter(fence, gl.SYNC_STATUS);
      if (s === gl.SIGNALED) break;
    }
    if (fence) gl.deleteSync(fence);
    const t2 = performance.now();
    timer.poll();
    if (record && sink) {
      sink.cpu.push(t1 - t0);
      sink.wall.push(t2 - t0);
      sink.calls.push(calls);
      sink.tris.push(tris);
    }
  }

  async function settleEnvironment(maxMs) {
    const t0 = performance.now();
    while (performance.now() - t0 < maxMs) {
      let st = null;
      try {
        st = environmentState();
      } catch {
        return;
      }
      const loading = st && st.hdriStatus === 'loading';
      const fading = st && st.hdriMix > 0 && st.hdriMix < 1;
      if (!loading && !fading) return;
      await step(false, null);
    }
  }

  function summarise(tier, path, sink, gpuFrames, extra) {
    let gpu = 'n/a';
    if (timer.ok && gpuFrames.length) {
      const names = new Set();
      for (const g of gpuFrames) for (const n of Object.keys(g.passes)) names.add(n);
      const passes = {};
      for (const n of names) passes[n] = stats(gpuFrames.map((g) => g.passes[n] || 0));
      gpu = { total: stats(gpuFrames.map((g) => g.total)), passes };
    }
    const calls = stats(sink.calls);
    const tris = stats(sink.tris);
    return {
      tier,
      path: path.id,
      mode: path.mode,
      frames: sink.cpu.length,
      cpu: stats(sink.cpu),
      wall: stats(sink.wall),
      gpu,
      calls: calls && { p50: Math.round(calls.p50), max: Math.round(calls.max) },
      triangles: tris && { p50: Math.round(tris.p50), max: Math.round(tris.max) },
      composer: shell.postfx ? {
        running: shell.postfx.running, quality: shell.postfx.getQuality(), ao: shell.postfx.aoKind, aoGBuffer: shell.postfx.aoGBuffer,
      } : null,
      materials: (() => { try { return getMaterialQuality(); } catch { return null; } })(),
      memory: { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures },
      programs: renderer.info.programs ? renderer.info.programs.length : null,
      ...extra,
    };
  }

  async function runPath(tier, path, frames, results) {
    Math.random = mulberry32(SEED ^ (path.id.length * 7919));
    const battle = shell.startBattle(path.mode, path.vehicleType || path.mode, path.spec);
    if (!battle) throw new Error(`no battle for ${path.id}`);
    const ctx = {};
    path.setup?.(battle, ctx);
    try {
      runOpts.prepare?.(battle, shell, tier, path.id);
    } catch (e) {
      console.warn('[bench] prepare failed:', e);
    }
    const camFn = path.camera;
    let k = 0;
    let n = 1;
    shell.hooks.afterUpdate = camFn
      ? (b) => {
        if (b === battle) camFn(b, k / n, ctx);
      }
      : null;
    // the chain is built on the first frame; time each of its passes
    shell.postfx?.setPassHook?.((passes) => instrumentPasses(passes, timer));
    // warm-up: shader compiles, the HDRI swap, first-use uploads
    const warm = path.warmFrames || 60;
    for (let i = 0; i < warm; i++) {
      k = 0;
      await step(false, null);
      if (i === 0) shell.postfx?.setPassHook?.((passes) => instrumentPasses(passes, timer));
    }
    await settleEnvironment(6000);
    // P-04: a fixed render scale on request (run({ scale: 1 }) or &scale=1),
    // else let the dynamic resolution settle before anything is recorded
    const pin = Number.isFinite(runOpts.scale) ? runOpts.scale : opts.scale;
    if (Number.isFinite(pin) && shell.postfx?.setAutoScale) {
      shell.postfx.setAutoScale(false);
      shell.postfx.setRenderScale(pin);
    } else if (shell.postfx?.setAutoScale) {
      shell.postfx.setAutoScale(true);
      let last = shell.postfx.renderScale;
      let steady = 0;
      for (let i = 0; i < 480 && steady < 100; i++) {
        await step(false, null);
        const sc = shell.postfx.renderScale;
        steady = sc === last ? steady + 1 : 0;
        last = sc;
      }
    }
    timer.flush();
    const scales = [];
    const sdraws = [];
    const sink = { cpu: [], wall: [], calls: [], tris: [] };
    n = frames;
    const gpuFrames = [];
    for (k = 0; k < frames; k++) {
      if (cancelled) break;
      await step(true, sink);
      gpuFrames.push(...timer.take());
      scales.push(shell.postfx ? (shell.postfx.renderScale ?? 1) : 1);
      if (Number.isFinite(shadowDraws.last)) sdraws.push(shadowDraws.last);
      shadowDraws.last = NaN;
      if ((k & 15) === 0) ui?.status(`${tier} · ${path.id} · ${k}/${frames} · cpu ${(sink.cpu[sink.cpu.length - 1] || 0).toFixed(1)} ms`);
    }
    // the last frames' queries
    for (let i = 0; i < 8 && timer.ok; i++) {
      await nextTask();
      gpuFrames.push(...timer.take());
    }
    const extra = {};
    try {
      let casters = 0;
      battle.scene.traverseVisible((o) => {
        if ((o.isMesh || o.isInstancedMesh || o.isBatchedMesh) && o.castShadow) casters++;
      });
      // flagged castShadow (what is ASKED to cast) and, separately, what the
      // shadow pass really drew (p50 of its draw calls)
      extra.castersFlagged = casters;
      const sd = stats(sdraws);
      extra.casters = sd ? Math.round(sd.p50) : casters;
      extra.pixelRatio = renderer.getPixelRatio();
      const sc = stats(scales);
      extra.renderScale = sc ? { p50: sc.p50, min: +(Math.min(...scales)).toFixed(2), max: +(Math.max(...scales)).toFixed(2) } : null;
    } catch {
      /* instrumentation only */
    }
    if (path.id === 'low_pan') extra.roadFound = !!ctx.roadFound;
    if (path.optic) extra.optic = !!battle.sniper;
    const row = summarise(tier, path, sink, gpuFrames, extra);
    results.runs.push(row);

    // P-02 A/B on high: the same path with GTAO's own scene re-render
    if (tier === 'high' && (runOpts.ab ?? opts.ab) && path.ab && shell.postfx && shell.postfx.aoKind === 'gtao' && !cancelled) {
      const abFrames = Math.min(120, frames);
      shell.postfx.aoGBuffer = 'own';
      for (let i = 0; i < 20; i++) await step(false, null);
      const own = { cpu: [], wall: [], calls: [], tris: [] };
      for (let i = 0; i < abFrames; i++) {
        k = Math.min(frames - 1, i);
        await step(true, own);
      }
      shell.postfx.aoGBuffer = 'beauty';
      for (let i = 0; i < 20; i++) await step(false, null);
      const beauty = { cpu: [], wall: [], calls: [], tris: [] };
      for (let i = 0; i < abFrames; i++) {
        k = Math.min(frames - 1, i);
        await step(true, beauty);
      }
      timer.flush();
      const o = stats(own.calls);
      const b = stats(beauty.calls);
      results.p02[path.id] = {
        own: Math.round(o.p50),
        beauty: Math.round(b.p50),
        saved: Math.round(o.p50 - b.p50),
        cpuOwn: stats(own.cpu).p50,
        cpuBeauty: stats(beauty.cpu).p50,
      };
    }
    shell.hooks.afterUpdate = null;
    shell.postfx?.setPassHook?.(null);
    shell.endBattle();
  }

  let runOpts = {};
  async function run(o = {}) {
    if (running) return api.results;
    running = true;
    runOpts = o;
    cancelled = false;
    const frames = o.frames || opts.frames;
    const tiers = o.tiers || opts.tiers;
    const paths = o.paths ? PATHS.filter((p) => o.paths.includes(p.id)) : opts.paths;
    api.state = 'running';
    const savedRandom = Math.random;
    const hadPreset = Object.prototype.hasOwnProperty.call(globalThis, '__STEEL_SKIES_PRESET__');
    const savedPreset = globalThis.__STEEL_SKIES_PRESET__;
    const savedAutoReset = renderer.info.autoReset;
    let dbg = null;
    try {
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      dbg = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch {
      dbg = null;
    }
    const results = {
      version: 1,
      date: new Date().toISOString(),
      gpu: dbg,
      userAgent: navigator.userAgent,
      canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      pixelRatio: renderer.getPixelRatio(),
      timerQuery: timer.ok,
      preset: PRESET,
      seed: SEED,
      framesPerPath: frames,
      budget: BUDGET,
      runs: [],
      p02: {},
      flags: [],
    };
    globalThis.__STEEL_SKIES_PRESET__ = { ...PRESET };
    renderer.info.autoReset = false;
    shell.setExternalDriver(true);
    try {
      for (const tier of tiers) {
        shell.setGraphics(tier);
        for (const path of paths) {
          if (cancelled) break;
          ui?.status(`${tier} · ${path.id} · starting`);
          try {
            await runPath(tier, path, frames, results);
          } catch (e) {
            console.warn(`[bench] ${tier}/${path.id} failed:`, e);
            results.runs.push({ tier, path: path.id, mode: path.mode, error: String(e && e.message || e) });
            try {
              shell.endBattle();
            } catch {
              /* already gone */
            }
          }
          ui?.table(tableOf(results));
          await sleep(30);
        }
      }
    } finally {
      shell.hooks.afterUpdate = null;
      Math.random = savedRandom;
      if (hadPreset) globalThis.__STEEL_SKIES_PRESET__ = savedPreset;
      else delete globalThis.__STEEL_SKIES_PRESET__;
      renderer.info.autoReset = savedAutoReset;
      timer.flush();
      shell.setExternalDriver(false);
      shell.restoreGraphics();
      shell.showGarage();
      running = false;
    }
    for (const r of results.runs) {
      if (r.error) continue;
      if (r.tier === 'high' && r.cpu && r.cpu.p95 > BUDGET.cpuMs) results.flags.push(`${r.path}: CPU p95 ${r.cpu.p95} ms > ${BUDGET.cpuMs}`);
      if (r.tier === 'high' && r.gpu && r.gpu.total && r.gpu.total.p95 > BUDGET.gpuMs) results.flags.push(`${r.path}: GPU p95 ${r.gpu.total.p95} ms > ${BUDGET.gpuMs}`);
    }
    api.results = results;
    api.state = cancelled ? 'cancelled' : 'done';
    const json = JSON.stringify(results);
    console.log(`[bench] RESULT ${json}`);
    ui?.status(`${api.state} · ${results.runs.length} runs · timer query ${timer.ok ? 'yes' : 'n/a'}`);
    ui?.table(tableOf(results));
    ui?.copy(json);
    return results;
  }

  ui?.status(opts.autostart ? 'starting in 2 s…' : 'idle · window.__bench.run()');
  if (opts.autostart) {
    // let the hangar and the first textures settle so the first path is not
    // timing the page load
    setTimeout(() => {
      run().catch((e) => {
        console.error('[bench] run failed:', e);
        api.state = 'failed';
      });
    }, 2000);
  }
  return api;
}
