// Diagnostics log: errors, warnings, frame hitches and periodic performance
// samples, kept in a ring buffer that survives reloads (localStorage), so a
// player can open it after something went wrong and send it to the developer.
//
//   F8 (or #logs in the address)  open / close the log panel
//   panel buttons                 Copy · Download .json · Clear
//
// Everything here is best-effort and must never throw into the game.

const KEY = 'steelSkies.log.v1';
const MAX_ENTRIES = 1500;
const HITCH_MS = 100; // a frame this long is logged as a hitch
const SAMPLE_EVERY_S = 30; // performance sample period during a battle

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
      localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
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

// kind: 'error' | 'warn' | 'hitch' | 'perf' | 'event' | 'info'
export function logEvent(kind, msg, data = null) {
  try {
    const e = { t: now(), kind, msg: short(msg), ctx: { ...ctx } };
    if (data != null) e.data = data;
    entries.push(e);
    if (entries.length > MAX_ENTRIES * 1.2) entries.splice(0, entries.length - MAX_ENTRIES);
    persist();
    if (panel && panel.style.display !== 'none') renderPanel();
  } catch { /* never throw */ }
}

// What the game is doing right now; merged into every entry.
export function setLogContext(patch) {
  ctx = { ...ctx, ...patch };
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

function perfSnapshot(frames) {
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
      out.calls = renderer.info.render.calls;
      out.tris = renderer.info.render.triangles;
      out.geom = renderer.info.memory.geometries;
      out.tex = renderer.info.memory.textures;
    }
    if (performance.memory) out.heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
    if (getExtra) Object.assign(out, getExtra());
  } catch { /* ignore */ }
  return out;
}

export function initTelemetry() {
  if (started) return;
  started = true;
  try {
    const old = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (Array.isArray(old)) entries.push(...old.slice(-MAX_ENTRIES));
  } catch { /* ignore */ }
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
    if (document.visibilityState === 'visible' && dt < 5000) {
      frames.push(dt);
      if (dt > HITCH_MS && ctx.mode !== 'hangar') logEvent('hitch', `frame ${dt.toFixed(0)} ms`);
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

export function clearLog() {
  entries.length = 0;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  logEvent('info', 'log cleared');
}

function renderPanel() {
  const list = panel.querySelector('.ssLogList');
  const counts = logReport().counts;
  panel.querySelector('.ssLogHead span').textContent =
    `LOG · errors ${counts.error || 0} · warnings ${counts.warn || 0} · hitches ${counts.hitch || 0} · samples ${counts.perf || 0}`;
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
      #ssLogPanel .ssLog.hitch{color:#9fc0ff}#ssLogPanel .ssLog.perf{color:#9fe0a8}
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
