// Steel Skies log collector (Cloudflare Worker + D1).
//
//   POST /ingest            { player, session, device, build, entries:[{uid,t,kind,msg,ctx,data}] }
//                           → { ok, stored, ack:[uid…] }   (the client deletes only acked entries)
//   GET  /report?key=…      HTML summary for analysis
//   GET  /export?key=…&since=ISO&kind=…&limit=…   JSON rows
//
// REPORT_KEY is a Worker secret (wrangler secret put REPORT_KEY).

const MAX_BODY = 512 * 1024;
const MAX_ENTRIES = 500;

const ALLOWED_ORIGINS = [
  /^https:\/\/tamirlan-mm\.github\.io$/,
  /^https:\/\/[a-z0-9-]+\.claudeusercontent\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

function cors(origin) {
  const ok = origin && ALLOWED_ORIGINS.some((r) => r.test(origin));
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'https://tamirlan-mm.github.io',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const idOk = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(s);

async function ingest(req, env, h) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return json({ ok: false, error: 'too large' }, 413, h);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: 'too large' }, 413, h);
  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'bad json' }, 400, h); }
  const { player, session } = body;
  if (!idOk(player) || !idOk(session)) return json({ ok: false, error: 'bad ids' }, 400, h);
  const list = Array.isArray(body.entries) ? body.entries.slice(0, MAX_ENTRIES) : [];
  const now = new Date().toISOString();
  const d = body.device || {};
  const stmts = [
    env.DB.prepare(
      `INSERT INTO sessions (session, player, first_seen, last_seen, origin, ua, gpu, screen, cores, mem_gb, build)
       VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(session) DO UPDATE SET last_seen = ?3,
         gpu = COALESCE(excluded.gpu, sessions.gpu), ua = COALESCE(excluded.ua, sessions.ua)`,
    ).bind(session, player, now, clip(req.headers.get('Origin'), 200), clip(d.ua, 400), clip(d.gpu, 200),
      clip(d.screen, 60), Number.isFinite(d.cores) ? d.cores : null, Number.isFinite(d.memGB) ? d.memGB : null,
      clip(body.build, 80)),
  ];
  const ack = [];
  for (const e of list) {
    if (!e || !idOk(e.uid)) continue;
    const ctx = e.ctx || {};
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO entries (uid, received, t, player, session, kind, msg, mode, vehicle, graphics, data)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(e.uid, now, clip(e.t, 40) || now, player, session, clip(e.kind, 12) || 'info', clip(e.msg, 2000),
      clip(ctx.mode, 30), clip(ctx.vehicle, 40), clip(ctx.graphics, 20),
      e.data == null ? null : clip(JSON.stringify(e.data), 6000)));
    ack.push(e.uid);
  }
  await env.DB.batch(stmts);
  return json({ ok: true, stored: ack.length, ack }, 200, h);
}

function authed(url, env) {
  return env.REPORT_KEY && url.searchParams.get('key') === env.REPORT_KEY;
}

async function exportRows(url, env) {
  const since = url.searchParams.get('since') || '1970-01-01';
  const kind = url.searchParams.get('kind');
  const limit = Math.min(Number(url.searchParams.get('limit') || 5000), 50000);
  const q = kind
    ? env.DB.prepare('SELECT * FROM entries WHERE t >= ?1 AND kind = ?2 ORDER BY id LIMIT ?3').bind(since, kind, limit)
    : env.DB.prepare('SELECT * FROM entries WHERE t >= ?1 ORDER BY id LIMIT ?2').bind(since, limit);
  const { results } = await q.all();
  const sessions = (await env.DB.prepare('SELECT * FROM sessions WHERE last_seen >= ?1').bind(since).all()).results;
  return json({ since, count: results.length, entries: results, sessions }, 200, {});
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function report(url, env) {
  const days = Math.min(Number(url.searchParams.get('days') || 7), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
  const [totals, errors, hitches, perf, gpus] = await Promise.all([
    q(`SELECT kind, COUNT(*) n, COUNT(DISTINCT player) players FROM entries WHERE t >= ?1 GROUP BY kind ORDER BY n DESC`, since),
    q(`SELECT msg, COUNT(*) n, COUNT(DISTINCT player) players, MAX(t) last, GROUP_CONCAT(DISTINCT mode) modes
       FROM entries WHERE kind = 'error' AND t >= ?1 GROUP BY msg ORDER BY players DESC, n DESC LIMIT 50`, since),
    q(`SELECT mode, vehicle, COUNT(*) n, COUNT(DISTINCT session) sessions FROM entries
       WHERE kind = 'hitch' AND t >= ?1 GROUP BY mode, vehicle ORDER BY n DESC LIMIT 40`, since),
    q(`SELECT mode, graphics, COUNT(*) n,
         ROUND(AVG(json_extract(data,'$.fps')),1) fps, ROUND(AVG(json_extract(data,'$.p95ms')),1) p95,
         ROUND(AVG(json_extract(data,'$.scale')),2) scale
       FROM entries WHERE kind = 'perf' AND t >= ?1 GROUP BY mode, graphics ORDER BY n DESC`, since),
    q(`SELECT s.gpu, COUNT(DISTINCT s.player) players,
         ROUND(AVG(json_extract(e.data,'$.fps')),1) fps
       FROM sessions s LEFT JOIN entries e ON e.session = s.session AND e.kind = 'perf'
       WHERE s.last_seen >= ?1 GROUP BY s.gpu ORDER BY players DESC LIMIT 30`, since),
  ]);
  const table = (rows, cols) => `<table><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>${rows
    .map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</table>`;
  const html = `<!doctype html><meta charset="utf-8"><title>Steel Skies logs</title>
<style>body{font:13px/1.4 system-ui,sans-serif;margin:16px;background:#f4f1ea;color:#222}
table{border-collapse:collapse;margin:8px 0 20px;width:100%}td,th{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#e4dfd3}td{word-break:break-word;max-width:700px}</style>
<h1>Steel Skies — logs, last ${days} days</h1>
<p><a href="?key=${esc(url.searchParams.get('key'))}&days=1">1 day</a> · <a href="?key=${esc(url.searchParams.get('key'))}&days=7">7</a> ·
<a href="?key=${esc(url.searchParams.get('key'))}&days=30">30</a> · <a href="/export?key=${esc(url.searchParams.get('key'))}&since=${since}">export JSON</a></p>
<h2>Totals</h2>${table(totals, ['kind', 'n', 'players'])}
<h2>Errors (by players affected)</h2>${table(errors, ['msg', 'players', 'n', 'modes', 'last'])}
<h2>Hitches (&gt;100 ms frames)</h2>${table(hitches, ['mode', 'vehicle', 'n', 'sessions'])}
<h2>Performance samples</h2>${table(perf, ['mode', 'graphics', 'n', 'fps', 'p95', 'scale'])}
<h2>GPUs</h2>${table(gpus, ['gpu', 'players', 'fps'])}`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const h = cors(req.headers.get('Origin'));
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    try {
      if (url.pathname === '/ingest' && req.method === 'POST') return await ingest(req, env, h);
      if (url.pathname === '/report') return authed(url, env) ? await report(url, env) : new Response('forbidden', { status: 403 });
      if (url.pathname === '/export') return authed(url, env) ? await exportRows(url, env) : new Response('forbidden', { status: 403 });
      if (url.pathname === '/health') return json({ ok: true }, 200, h);
      return new Response('not found', { status: 404 });
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err).slice(0, 300) }, 500, h);
    }
  },
};
