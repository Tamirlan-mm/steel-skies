import { WORLD_SIZE, terrainHeight, terrainFeatures } from '../world/terrain.js';
import { activePreset } from '../world/presets.js';
import { relabelHelp } from '../core/input.js'; // settings lane: current key names
// The one airspeed scale every number the pilot reads goes through (the tape,
// its stall mark, the gear limit), so the fallback below matches the battles.
import { displaySpeedKmh, airDensity, RHO0 } from '../vehicles/planes.js';
// H-05: the one penetration vocabulary, shared with the hangar X-ray. The HUD
// crosshair and the gunner's optic are the SHOT perspective.
import { PEN_HEX, penHex, penLegend, outcomeOf } from './penScale.js';

const $ = (id) => document.getElementById(id);

const DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// H-01 instrument register (art bible 7.1-7.3, 4.7, 4.8). Near-black olive
// glass, ivory engraving, DIN lettering. Every colour the HUD paints comes out
// of these two tables, CSS panels, the canvas map and the inline SVG alike, so
// a colour can never drift between the minimap and the panel describing the
// same thing. The fills that mean OK / warning / critical ARE the pen scale's
// green, amber and red (bible 4.7), imported, never retyped.
// ---------------------------------------------------------------------------
export const INK = Object.freeze({
  panel: 'rgba(14,15,12,0.84)', // H-21: α >= 0.80
  ivory: '#e9e4d4', // primary text: 8.7:1 on snow through the panel
  ivory2: '#bdb7a4', // secondary text
  ivory3: '#9a9585', // rules, ticks and large text only
  outline: 'rgba(0,0,0,0.85)', // H-11 free-floating text outline
  hair: 'rgba(233,228,212,0.22)', // hairlines on the panels
  face: '#0c0d0b', // instrument dial face
});

// a canvas tint of a pen-scale hex, derived (never retyped) from penScale.js
const hexAlpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const PEN_RED_WASH = hexAlpha(PEN_HEX.red, 0.18); // out-of-bounds wash on the map

const COL = {
  ally: '#7cb4f0',
  enemy: '#ff8a72',
  neutral: INK.ivory2,
  player: '#ffd95e',
  ok: PEN_HEX.green, // fills and lamps
  okText: '#86dc8e', // OK as text (bible 4.7)
  damaged: PEN_HEX.amber, // fills and text alike (6.7:1)
  destroyed: PEN_HEX.red, // fills only
  critText: '#ff7466', // critical as text, always on its own chip
  info: '#9cc8f0',
};

// H-01 font stack: Bahnschrift is Windows' DIN 1451; the rest are its
// equivalents elsewhere. Canvas text uses it too (no canvas font under 10 px).
export const HUD_FONT =
  "'Bahnschrift', 'DIN Alternate', 'DIN Condensed', 'Roboto Condensed', 'Arial Narrow', 'Segoe UI', sans-serif";
const cfont = (px, weight = 600) => `${weight} ${Math.max(10, px)}px ${HUD_FONT}`;

// A seat in the middle of a crew swap is not working, so both ends of the swap
// wear the amber "damaged" dress the stylesheet already knows; the extra class
// tells the two ends apart: `s-in` is the empty seat a man is climbing into,
// `s-leave` is the seat he has just walked out of.
const STATE_CLASS = {
  ok: 's-ok',
  damaged: 's-dmg',
  destroyed: 's-out',
  moving: 's-dmg s-in',
  leaving: 's-dmg s-leave',
};

// Swap progress wears the same blue as the repair bar: both mean "the crew is
// busy putting this right, wait for it".
const SWAP_COL = COL.info;
const SWAP_RING_R = 10.6;
const SWAP_RING_C = 2 * Math.PI * SWAP_RING_R;

// What the reload bar says in place of a countdown when the gun cannot fire at
// all. Anything not listed still reads as silenced, just less specifically.
const SILENCED_TEXT = { gunner: 'NO GUNNER', breech: 'BREECH OUT' };
const SILENCED_FALLBACK = 'GUN SILENCED';

// The palette reaches style.css as custom properties on #hud, written from the
// tables above (and the pen scale from penScale.js), so the stylesheet never
// carries a second copy of a semantic hex. The rules that used to be injected
// from here (keyframes, swap and silenced states) now live in style.css,
// which this lane owns.
const applyPalette = (root) => {
  if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
  const set = (k, v) => root.style.setProperty(k, v);
  set('--pen-green', PEN_HEX.green);
  set('--pen-amber', PEN_HEX.amber);
  set('--pen-red', PEN_HEX.red);
  set('--pen-ricochet', PEN_HEX.ricochet);
  set('--ally', COL.ally);
  set('--enemy', COL.enemy);
  set('--player', COL.player);
  set('--ok', COL.ok);
  set('--ok-text', COL.okText);
  set('--warn', COL.damaged);
  set('--crit', COL.destroyed);
  set('--crit-text', COL.critText);
  set('--info', COL.info);
  set('--ivory', INK.ivory);
  set('--ivory2', INK.ivory2);
  set('--ivory3', INK.ivory3);
  set('--panel', INK.panel);
  set('--hair', INK.hair);
};

// Air cluster scales. Sideslip goes full scale at fifteen degrees, which is
// far more than anything worth flying holds; the structural-speed ratio stays
// out of sight until the airframe is close enough to its limit for the number
// to mean something. (The stall mark is on the airspeed dial now, H-04.)
const SLIP_FULL = 15 / DEG;
const MACH_SHOW = 0.78;

// The G gauge reads against the airframe's own rated limit, not against a fixed
// number, because a Sturmovik is done at six and a Spitfire is still fine at
// eight. Three bands: under G_EASY of the limit the wing is not being worked at
// all; from there to the limit is the amber band the flight model's own
// instructor cap also lives in, so the warning arrives while there is still
// time to unload; at or over the limit the spar has started spending its stress
// budget and the readout goes red (the G dial's digits; its red tick is the
// rated limit).
const G_EASY = 0.8;
// With no limit in the payload the digits keep the old fixed warning.
const G_LEGACY_WARN = 5;

// Accumulated airframe stress, 0 = fresh, 1 = a wing leaves. The model bleeds
// it off at about half a unit a second, so anything under STRESS_SHOW is a
// snatch already forgotten and not worth stealing a row for. Past STRESS_WARN
// the bar goes red, and past STRESS_SHOUT it earns a line of text, because by
// then the pilot has roughly a second to unload.
const STRESS_SHOW = 0.06;
const STRESS_WARN = 0.45;
const STRESS_SHOUT = 0.6;

// Undercarriage load, as the flight model reports it (gearOver: indicated
// airspeed over the extended-gear limit, weighted by how far the legs are out;
// 1 = on the line). Over GEAR_WARN the aeroplane itself starts warning, and a
// sustained GEAR_TEAR tears the legs off — so the strain bar fills across
// exactly that band and goes red where the warning starts.
const GEAR_WARN = 1.1;
const GEAR_TEAR = 1.25;
// H-04 gear lamps, the period panel convention: green DOWN and locked, red IN
// TRANSIT, nothing lit for up. HELD (lever down, legs kept in the wells by the
// airspeed) and an over-limit strain flash amber; a gear that is gone shows a
// steady red. Every lamp carries its word as well as its colour (C-40).
// Pure, so the node test reads exactly what the panel draws.
export function gearLampState(data) {
  const has = !!data && (data.gearPos != null || data.gearGone != null || data.gearHeld != null);
  if (!has) return null;
  const pos = clamp(Number(data.gearPos) || 0, 0, 1);
  const lever = !!data.gear;
  const gone = !!data.gearGone;
  const held = !gone && !!data.gearHeld;
  const over = Number(data.gearOver) || 0;
  let state;
  let lamp;
  let text;
  if (gone) {
    state = 'gone';
    lamp = 'red';
    text = 'GONE';
  } else if (held) {
    state = 'held';
    lamp = 'amber';
    text = 'HELD';
  } else if (pos >= 0.999) {
    state = 'down';
    lamp = 'green';
    text = 'DOWN';
  } else if (pos <= 0.001 && !lever) {
    state = 'up';
    lamp = 'off';
    text = 'UP';
  } else {
    state = 'move';
    lamp = 'red';
    text = `TRANSIT ${Math.round(pos * 100)}%`;
  }
  // legs out in the airflow past the limit: the band the aeroplane warns in
  // and then tears them off in
  const strained = !gone && pos > 0.001 && over > 1;
  const crit = strained && over >= GEAR_WARN;
  if (strained) text = crit ? 'OVERSPEED' : 'FAST';
  const onGround = !!data.onGround;
  return {
    state,
    lamp,
    text,
    held,
    strained,
    crit,
    // blink at <= 3 Hz (H-50): held lamps and an over-limit warning only
    blink: held || crit,
    strain: strained ? clamp((over - 1) / (GEAR_TEAR - 1), 0, 1) : 0,
    brakeShown: onGround,
    brakeOn: onGround && (Number(data.wheelBrake) || 0) > 0.05,
  };
}

// ---------- tiny DOM helpers ----------
// Every panel below is refreshed once per frame, so each write is guarded by a
// cached copy of what is already on the node. Skipping the no-op writes keeps
// the browser from re-laying-out the HUD sixty times a second for nothing.
const setText = (el, v) => {
  if (el && el.__t !== v) {
    el.__t = v;
    el.textContent = v;
  }
};

const setStyle = (el, prop, v) => {
  if (!el) return;
  const key = `__s_${prop}`;
  if (el[key] !== v) {
    el[key] = v;
    el.style[prop] = v;
  }
};

const setSvgClass = (el, v) => {
  if (el && el.__c !== v) {
    el.__c = v;
    el.setAttribute('class', v);
  }
};

const setShown = (el, v) => {
  if (el) el.classList.toggle('hidden', !v);
};

const setAttr = (el, name, v) => {
  if (!el) return;
  const key = `__a_${name}`;
  if (el[key] !== v) {
    el[key] = v;
    el.setAttribute(name, v);
  }
};

// Toggles one extra class without disturbing whatever else is on the node
// (notably the shared 'hidden' class), and only when it actually changes.
const setFlag = (el, cls, on) => {
  if (!el) return;
  const key = `__f_${cls}`;
  if (el[key] !== on) {
    el[key] = on;
    el.classList.toggle(cls, on);
  }
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Bars and gauges are handed either a 0..1 fraction or a 0..100 percentage
// depending on which battle file ends up calling them — accept both rather than
// making the caller remember which.
const frac01 = (v) => {
  if (v == null || Number.isNaN(v)) return null;
  return clamp(v > 1.0001 ? v / 100 : v, 0, 1);
};

const wrap360 = (d) => ((d % 360) + 360) % 360;
const wrap180 = (d) => {
  const w = wrap360(d);
  return w > 180 ? w - 360 : w;
};

// The map is drawn looking straight down with +X to the right and +Z toward the
// bottom of the canvas, so "up" on the map is -Z. The compass uses the same
// convention: a hull yaw of PI (facing -Z) reads as 000 / North.
const yawToHeading = (yawRad) => wrap360(yawRad * DEG + 180);

// A cheap integer digest of the compass pip list. The tape can only skip its
// repaint if nothing on it moved, and finding that out must not cost a fresh
// signature string sixty times a second.
const markerSig = (markers) => {
  if (!markers || !markers.length) return 0;
  let h = markers.length;
  for (const m of markers) {
    if (!m) {
      h = (h * 31) | 0;
      continue;
    }
    const deg = m.deg != null ? m.deg : m.bearing != null ? m.bearing * DEG : 0;
    h = (h * 31 + Math.round(deg)) | 0;
    if (typeof m.color === 'string') {
      for (let i = 0; i < m.color.length; i++) h = (h * 31 + m.color.charCodeAt(i)) | 0;
    } else if (typeof m.color === 'number') {
      h = (h * 31 + m.color) | 0;
    }
    if (typeof m.label === 'string') {
      for (let i = 0; i < m.label.length; i++) h = (h * 31 + m.label.charCodeAt(i)) | 0;
    }
  }
  return h;
};

// The scoreboard's own ordering. A row that carries no score of its own is
// ranked by the same weights the battle files use to award one.
const scoreOf = (s) =>
  s.score != null ? s.score : (s.kills || 0) * 100 + (s.assists || 0) * 40 + (s.caps || 0) * 60;
const byScore = (a, b) => scoreOf(b) - scoreOf(a);

// Unit markers all arrive as "<span class="arrow">▼</span>123m". Only the
// distance ticks, so the two halves are kept as separate nodes and the hot one
// becomes a text-node write rather than an HTML re-parse.
const ARROW_OPEN = '<span class="arrow">';
const ARROW_CLOSE = '</span>';

// The four finite resources a ground crew carries, keyed by the letter that
// spends them. Anything the entity does not have simply does not appear.
const CONSUMABLE_KEYS = [
  { key: 'repair', field: 'repair', label: 'PARTS', hint: 'R' },
  { key: 'fpe', field: 'fpe', label: 'FPE', hint: 'F' },
  { key: 'firstAid', field: 'firstAid', label: 'MEDIC', hint: 'H' },
  { key: 'smoke', field: 'smoke', label: 'SMOKE', hint: 'G' },
];

const buildConsumables = (cons) => {
  if (!cons) return undefined;
  const out = [];
  for (const c of CONSUMABLE_KEYS) {
    if (cons[c.field] == null) continue;
    out.push({ key: c.key, label: c.label, hint: c.hint, count: cons[c.field] });
  }
  return out.length ? out : undefined;
};

// ---------- procedural shell icons ----------
// Drawn as inline SVG rather than glyphs so each family is recognisable at a
// glance from its silhouette alone, which is the whole point of the WT stack:
// pointed solid shot, a filled case with a band, a sub-calibre dart, a shaped
// charge with its standoff probe, and a blunt-nosed HE shell.
const SVG_HEAD =
  '<svg viewBox="0 0 30 12" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">';
const CASE_RIM = '<rect x="0.6" y="1.2" width="2.6" height="9.6" fill="currentColor" opacity="0.5"/>';

const SHELL_SVG = {
  AP:
    SVG_HEAD +
    '<path d="M1 2 H17 L28 6 L17 10 H1 Z" fill="currentColor"/>' +
    CASE_RIM +
    '</svg>',
  APHE:
    SVG_HEAD +
    '<path d="M1 2 H17 L28 6 L17 10 H1 Z" fill="currentColor" opacity="0.9"/>' +
    '<rect x="6" y="3.2" width="7.4" height="5.6" fill="#080b10" opacity="0.85"/>' +
    '<rect x="7.4" y="4.2" width="4.6" height="3.6" fill="currentColor"/>' +
    CASE_RIM +
    '</svg>',
  APCR:
    SVG_HEAD +
    '<path d="M1 2.6 H12 L16 4.2 H21 L28 6 L21 7.8 H16 L12 9.4 H1 Z" fill="currentColor" opacity="0.5"/>' +
    '<path d="M13 5 H22 L28 6 L22 7 H13 Z" fill="currentColor"/>' +
    CASE_RIM +
    '</svg>',
  HEAT:
    SVG_HEAD +
    '<path d="M1 2 H14 L25 6 L14 10 H1 Z" fill="currentColor" opacity="0.9"/>' +
    '<path d="M14 3.4 L22.5 6 L14 8.6 Z" fill="#080b10" opacity="0.7"/>' +
    '<rect x="24.6" y="5.4" width="4.4" height="1.2" fill="currentColor"/>' +
    CASE_RIM +
    '</svg>',
  HE:
    SVG_HEAD +
    '<path d="M1 2 H18 C24 2 26.6 4 26.6 6 C26.6 8 24 10 18 10 H1 Z" fill="currentColor" opacity="0.92"/>' +
    '<rect x="20.4" y="4.6" width="5.6" height="2.8" fill="#080b10" opacity="0.55"/>' +
    CASE_RIM +
    '</svg>',
};
SHELL_SVG.SMOKE = SHELL_SVG.HE;
SHELL_SVG.APDS = SHELL_SVG.APCR;
SHELL_SVG.MG = SHELL_SVG.AP;

const shellIcon = (kind) => SHELL_SVG[String(kind || 'AP').toUpperCase()] || SHELL_SVG.AP;

// ---------- damage-panel geometry ----------
// A 120x170 box with the vehicle nose at the top. Crew stations and modules sit
// where they really sit, because the whole value of the panel is being able to
// read "they got my driver" from the position of the mark, not from the label.
const TANK_CREW_POS = {
  driver: [45, 40],
  radio: [75, 40],
  'radio operator': [75, 40],
  'machine gunner': [75, 40],
  gunner: [45, 84],
  loader: [75, 84],
  commander: [60, 108],
};
const TANK_CREW_LETTER = {
  driver: 'D',
  radio: 'R',
  'radio operator': 'R',
  'machine gunner': 'R',
  gunner: 'G',
  loader: 'L',
  commander: 'C',
};
const TANK_MOD_POS = {
  engine: [[60, 138]],
  transmission: [[60, 24]],
  tracks: [[22, 88], [98, 88]],
  breech: [[60, 72]],
  gun: [[60, 72]],
  ammo: [[41, 124]],
  ammorack: [[41, 124]],
  fuel: [[79, 124]],
  turretdrive: [[60, 92]],
  radiator: [[60, 122]],
};

const PLANE_CREW_POS = { pilot: [60, 62], gunner: [60, 108] };
const PLANE_CREW_LETTER = { pilot: 'P', gunner: 'G' };
const PLANE_MOD_POS = {
  engine: [[60, 30]],
  wings: [[24, 84], [96, 84]],
  wing: [[24, 84], [96, 84]],
  tail: [[60, 150]],
  rudder: [[60, 150]],
  elevator: [[46, 146], [74, 146]],
  fuel: [[46, 92], [74, 92]],
  controls: [[60, 122]],
  radiator: [[60, 46]],
  ammo: [[38, 96]],
};

const TANK_SILHOUETTE =
  '<svg class="dpSvg" viewBox="0 0 120 170" xmlns="http://www.w3.org/2000/svg">' +
  '<rect class="dpTrack" x="12" y="26" width="17" height="122" rx="3"/>' +
  '<rect class="dpTrack" x="91" y="26" width="17" height="122" rx="3"/>' +
  '<rect class="dpHull" x="29" y="18" width="62" height="134" rx="5"/>' +
  '<polygon class="dpBarrel" points="56,4 64,4 63,70 57,70"/>' +
  '<polygon class="dpTurret" points="40,64 80,64 85,90 76,118 44,118 35,90"/>' +
  '</svg>';

const PLANE_SILHOUETTE =
  '<svg class="dpSvg" viewBox="0 0 120 170" xmlns="http://www.w3.org/2000/svg">' +
  '<rect class="dpBarrel" x="42" y="10" width="36" height="4" rx="2"/>' +
  '<polygon class="dpHull" points="52,16 68,16 71,120 66,158 54,158 49,120"/>' +
  '<polygon class="dpTurret" points="8,74 52,66 68,66 112,74 112,90 68,88 52,88 8,90"/>' +
  '<polygon class="dpTrack" points="32,138 88,138 88,150 32,150"/>' +
  '</svg>';

// ===========================================================================
// OPTICS, SIGHTS AND DIALS — the pure maths behind the instrument register.
// Everything here is a function of its arguments, so the node tests hold the
// HUD to the backlog's Accept lines without a browser.
// ===========================================================================

// ---- K-04 / H-31: the real optic, its field of view and its label --------
// The field stop is a circle FIELD_STOP_K of the viewport height (H-30), and
// the optic's true field is the angle THAT circle subtends (bible 1.2
// correction): vFOV = 2 atan(tan(field / 2) / k). The magnification step uses
// the reference eye geometry of the 1.2 decision (the screen spans 31.3° of
// the player's eye): vFOV = 2 atan(tan(15.65°) / M). Anything narrower is a
// labelled gameplay step, "AUX", down to the old 6° floor.
export const FIELD_STOP_K = 0.9;
export const REF_EYE_HALF_DEG = 15.65;
export const AUX_FLOOR_DEG = 6;
// NATO / German mil (2π/6400) and the Soviet thousandth (2π/6000), in mrad
export const MIL_MRAD = Object.freeze({ de: 0.9817, us: 0.9817, aa: 0.9817, su: 1.0472 });

// Per-vehicle gunner's sight. `source` says how sure the numbers are; the
// ones marked verify are the best period figure found, not a manual reading.
export const OPTICS = Object.freeze({
  tiger: {
    name: 'TZF 9b', mag: 2.5, field: 25, family: 'de',
    source: 'US TME 30-451: 2.4x / 26 deg; later histories 2.5x / 25 deg (bible H-31)',
  },
  wirbelwind: {
    name: 'Flakvisier 38', mag: 1, field: null, family: 'aa',
    source: 'reflector AA sight, no magnification (verify field)',
  },
  t34: {
    name: 'TSh-16', mag: 4, field: 16, family: 'su',
    source: 'T-34-85 sight ~4x / 16 deg, medium-low confidence (bible H-31)',
  },
  su100: {
    name: 'TSh-19', mag: 4, field: 16, family: 'su',
    source: 'same class as the T-34-85 sight (verify)',
  },
  stuart: {
    name: 'M70D', mag: 3, field: 12, family: 'us',
    source: 'M70-series telescope 3x / ~12 deg (bible H-31, M70F class; verify M70D)',
  },
  pershing: {
    name: 'M71C', mag: 5, field: 13, family: 'us',
    source: 'M71-series 5x / 13 deg (M71D figure, Zaloga; verify M71C)',
  },
});

const NATION_FAMILY = { Germany: 'de', USSR: 'su', USA: 'us', Britain: 'us', Japan: 'us' };

export function opticFor(spec) {
  if (spec && OPTICS[spec.id]) return OPTICS[spec.id];
  const family = spec && spec.aa ? 'aa' : (spec && NATION_FAMILY[spec.nation]) || 'us';
  return { name: 'Telescope', mag: 3, field: 14, family, source: 'generic fallback' };
}

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
export const fieldStepFov = (fieldDeg, k = FIELD_STOP_K) => deg(2 * Math.atan(Math.tan(rad(fieldDeg) / 2) / k));
export const magStepFov = (mag) => deg(2 * Math.atan(Math.tan(rad(REF_EYE_HALF_DEG)) / mag));
// the magnification a field of view amounts to at the reference eye
export const fovToMag = (fovDeg) => Math.tan(rad(REF_EYE_HALF_DEG)) / Math.tan(rad(fovDeg) / 2);

const fmtMag = (m) => `${Number.isInteger(m) ? m : m.toFixed(1)}×`;

// The detents the mouse wheel steps through, widest first. Step 0 (the true
// field) is the default (bible H-31 1.2 decision). Cached per optic: the
// battles ask every frame the sight is up, and must not allocate for it.
const OPTIC_STEPS = new Map();
export function opticSteps(spec) {
  const o = opticFor(spec);
  const key = `${o.name}|${o.mag}|${o.field}|${o.family}`;
  let steps = OPTIC_STEPS.get(key);
  if (!steps) {
    steps = Object.freeze(buildOpticSteps(o));
    OPTIC_STEPS.set(key, steps);
  }
  return steps;
}

function buildOpticSteps(o) {
  const steps = [];
  if (o.field) {
    steps.push({
      kind: 'field', fov: fieldStepFov(o.field), optic: o,
      label: `${o.name} · ${fmtMag(o.mag)} · ${o.field}° FIELD`,
    });
  }
  const magFov = magStepFov(o.mag);
  steps.push({ kind: 'mag', fov: magFov, optic: o, label: `${o.name} · ${fmtMag(o.mag)}` });
  const aux = [];
  if (magFov > 9) aux.push((magFov + AUX_FLOOR_DEG) / 2);
  if (magFov > AUX_FLOOR_DEG + 0.75) aux.push(AUX_FLOOR_DEG);
  for (const f of aux) {
    steps.push({ kind: 'aux', fov: f, optic: o, label: `${o.name} · AUX ${fovToMag(f).toFixed(1)}×` });
  }
  return steps;
}

// Pixels from the screen centre of a ray `angleRad` off the axis, for a
// camera of vertical field `fovDeg` on a viewport `H` pixels tall. Exact
// (gnomonic), not the small-angle approximation.
export const angleToPx = (angleRad, fovDeg, H) => ((H / 2) * Math.tan(angleRad)) / Math.tan(rad(fovDeg) / 2);
// pixels per mil of this family at the centre of the view (H-32)
export const pxPerMil = (fovDeg, H, family = 'de') => angleToPx((MIL_MRAD[family] || MIL_MRAD.de) / 1000, fovDeg, H);

// German triangle sizes in mils are bible *verify* — kept as data (H-35)
export const RETICLE = Object.freeze({
  de: { bigH: 4, bigW: 4, smallH: 2, smallW: 2, spacing: 4, count: 3 },
  su: { chevH: 3, chevW: 4, tick: 4, ticks: 4, tickLen: 1.5 },
  us: { lead: 5, leads: 3, leadLen: 1.5, gap: 1.2 },
  aa: { rings: [10, 20], dot: 1 },
});
export const PEN_CHEVRON_MILS = 2.5; // H-02: 2-3 mils below the aim point
// How deep the reticle's central aiming mark hangs below the aim point, mils:
// the TZF triangle and the TSh chevron. The pen chevron hangs PEN_CHEVRON_MILS
// below THAT (so it never sits on the mark at the wide true-field step, where a
// mil is under 1.5 px), and at least PEN_CHEVRON_MIN_PX clear of it.
const AIM_MARK_DEPTH = Object.freeze({ de: RETICLE.de.bigH, su: RETICLE.su.chevH, us: 0, aa: 0 });
export const PEN_CHEVRON_MIN_PX = 4;
export function penChevronOffsetPx(family, pxPerMilV) {
  const depth = (AIM_MARK_DEPTH[family] || 0) * pxPerMilV;
  return depth + Math.max(PEN_CHEVRON_MILS * pxPerMilV, PEN_CHEVRON_MIN_PX);
}
// With the optic up the battle's top strip folds to one row (style.css
// #hud.scoped: compass, tickets, timer and zone letters) that ends ~80 px down
// whatever the window height; the TZF range drum and its pointer stay below
// this line (measured in the browser: 79 px at 720p).
export const SCOPE_TOP_CLEAR_PX = 92;

// ---- H-03: the reflector sight -------------------------------------------
// Ring radius = the lead for a 100 mph (44.7 m/s) crossing target at the
// aircraft's own muzzle velocity: r = 1000 * 44.7 / v mrad (bible H-34).
export const RING_CROSSING_MS = 44.7;
export const reflectorRingMrad = (gunSpeed) => (1000 * RING_CROSSING_MS) / Math.max(1, gunSpeed || 800);
export const reflectorRingPx = (gunSpeed, fovDeg, H) => angleToPx(reflectorRingMrad(gunSpeed) / 1000, fovDeg, H);
export const REFLECTOR = Object.freeze({
  color: '#ffb86e', // a 3,000 K lamp (bible H-34: #ffb56a-#ffc180)
  nd: 0.15, // the neutral-density pane: 15 % (bible: 10-15 %)
  dotMrad: 2, // centre dot diameter <= 2 mrad
});

// ---- H-04: period flight instruments ------------------------------------
// Units follow the aircraft's nation: US and UK dials read mph and feet, the
// Japanese Navy's knots and metres, German and Soviet km/h and metres.
export const DIAL_UNITS = Object.freeze({
  USA: { speed: 'mph', alt: 'ft' },
  Britain: { speed: 'mph', alt: 'ft' },
  Japan: { speed: 'kt', alt: 'm' },
  Germany: { speed: 'km/h', alt: 'm' },
  USSR: { speed: 'km/h', alt: 'm' },
});
export const KMH_PER_UNIT = Object.freeze({ 'km/h': 1, mph: 1.609344, kt: 1.852 });
export const M_PER_UNIT = Object.freeze({ m: 1, ft: 0.3048 });
export const FT_MIN_PER_MS = 60 / 0.3048; // 1 m/s = 196.85 ft/min
export const dialUnits = (nation) => DIAL_UNITS[nation] || DIAL_UNITS.Germany;

// value range, long tick, short tick (the "minor tick" of the Accept line) and
// numeral step, per speed unit
export const ASI_SCALE = Object.freeze({
  mph: { min: 0, max: 450, major: 50, minor: 10, num: 100 },
  'km/h': { min: 0, max: 750, major: 50, minor: 25, num: 100 },
  kt: { min: 0, max: 350, major: 50, minor: 10, num: 100 },
});
export const G_SCALE = Object.freeze({ min: -4, max: 12, major: 2, minor: 1, num: 4 });
// one revolution of the long altimeter needle, and of the short one
export const ALT_REV = 1000;
export const ALT_REV_SHORT = 10000;

// Boost / manifold pressure per aircraft, in the unit its own gauge was
// marked in. idle, rated (full throttle, no WEP) and wep (the emergency or
// combat rating the game's WEP key selects). The handbook numbers carry
// "verify" where the figure is from secondary sources only.
export const BOOST_GAUGE = Object.freeze({
  spitfire: { unit: 'LB', title: 'BOOST', min: -6, max: 18, major: 2, minor: 1, num: 6, idle: -4, rated: 9, wep: 16, note: 'Merlin 45: +9 climb, +16 combat (verify)' },
  p51: { unit: 'IN HG', title: 'MAN PR', min: 10, max: 75, major: 5, minor: 1, num: 10, idle: 18, rated: 61, wep: 67, note: 'V-1650-7: 61 military, 67 WEP' },
  fw190: { unit: 'ATA', title: 'LADEDRUCK', min: 0.6, max: 1.8, major: 0.1, minor: 0.05, num: 0.4, idle: 0.7, rated: 1.32, wep: 1.42, note: 'BMW 801 D-2: 1.32 climb, 1.42 take-off/emergency' },
  il2: { unit: 'MM HG', title: 'BOOST', min: 400, max: 1600, major: 100, minor: 50, num: 400, idle: 500, rated: 1050, wep: 1400, note: 'AM-38F (verify)' },
  zero: { unit: 'MM HG', title: 'BOOST', min: -500, max: 500, major: 100, minor: 50, num: 250, idle: -400, rated: 150, wep: 250, note: 'Sakae 12: +250 take-off (verify)' },
});
const BOOST_BY_NATION = { USA: 'p51', Britain: 'spitfire', Germany: 'fw190', USSR: 'il2', Japan: 'zero' };
export const boostGaugeFor = (spec) =>
  (spec && BOOST_GAUGE[spec.id]) || BOOST_GAUGE[BOOST_BY_NATION[spec && spec.nation] || 'fw190'];

// The power the flight model is actually making, as its manifold would show
// it: the throttle opening times the supercharger's altitude factor, exactly
// the two terms planeEntity.thrustNow() multiplies (rated pressure up to the
// critical density, falling in proportion above it), on the gauge's scale.
export function boostReading(gauge, throttle, wep, altY, critDensity, rho0) {
  const thr = Math.min(1, Math.max(0, Number(throttle) || 0));
  let altF = 1;
  if (critDensity > 0 && altY != null && rho0 > 0) {
    const d = airDensity(altY) / rho0;
    altF = d >= critDensity ? 1 : d / critDensity;
  }
  const top = wep ? gauge.wep : gauge.rated;
  return gauge.idle + (top - gauge.idle) * thr * altF;
}

// Needle angle on a 300° dial, radians clockwise from twelve o'clock: the
// scale's minimum at seven o'clock, its maximum at five.
export const DIAL_SWEEP = rad(300);
export function dialAngle(v, scale) {
  const f = Math.min(1.02, Math.max(-0.02, (v - scale.min) / (scale.max - scale.min)));
  return -DIAL_SWEEP / 2 + DIAL_SWEEP * f;
}
// The two altimeter needles (long: ALT_REV per turn, short: ALT_REV_SHORT)
export const altNeedles = (v) => [
  (2 * Math.PI * (((v % ALT_REV) + ALT_REV) % ALT_REV)) / ALT_REV,
  (2 * Math.PI * (((v % ALT_REV_SHORT) + ALT_REV_SHORT) % ALT_REV_SHORT)) / ALT_REV_SHORT,
];
// Inverse of dialAngle: what a needle at `a` reads (the node test reads the
// drawn needle back through this).
export const dialRead = (a, scale) => scale.min + ((a + DIAL_SWEEP / 2) / DIAL_SWEEP) * (scale.max - scale.min);

// the four dials' geometry in CSS pixels: ASI, altimeter, boost, G
export const DIAL_LAYOUT = Object.freeze({ r: 40, cy: 42, w: 348, h: 98, cx: (i) => 42 + i * 88 });

// ---- H-06 map and marker helpers ----
// the paper map's relief resolution, and how many rows of it a frame builds
export const MAP_BG_RES = 128;
export const MAP_BG_ROWS = 10;
const intRgb = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
export const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
// The preset's ground albedo at x0.8 (bible 7.5); its rock where it is steep.
export function mapPalette(preset) {
  const p = preset || {};
  const k = (n, fb) => intRgb(typeof n === 'number' ? n : fb).map((v) => v * 0.8);
  return { low: k(p.low, 0x4e6e32), high: k(p.high, 0x68693c), rock: k(p.rock, 0x77776f) };
}
// The battles still hand the compass the old team colours; they are read as
// the team they meant and drawn in the instrument palette.
const LEGACY_TEAM = { '#5f9fdf': 'ally', '#7fb8f0': 'ally', '#df6a5f': 'enemy', '#f0917f': 'enemy', '#e8d080': 'neutral' };
export function mapColor(c) {
  const k = typeof c === 'string' ? c.toLowerCase() : '';
  const t = LEGACY_TEAM[k];
  if (t === 'ally') return COL.ally;
  if (t === 'enemy') return COL.enemy;
  if (t === 'neutral' || !k) return COL.neutral;
  return c;
}
// Marker shapes as inline SVG (H-36): ally an upward chevron (a ring for a
// ground target), enemy a diamond (with an ivory pip when a scout has called
// it). 12 px, a dark rim, the team colour from CSS currentColor.
export function markerShapeSvg(team, kind) {
  const head = '<svg class="mkSvg" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">';
  if (team === 'ally') {
    if (kind === 'target') {
      return `${head}<circle cx="6" cy="6" r="4.2" fill="none" stroke="#000" stroke-opacity=".85" stroke-width="3.6"/>` +
        '<circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    }
    return `${head}<path d="M1.2 10.2 L6 3.4 L10.8 10.2" fill="none" stroke="#000" stroke-opacity=".85" stroke-width="4.2" stroke-linejoin="miter"/>` +
      '<path d="M1.2 10.2 L6 3.4 L10.8 10.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="miter"/></svg>';
  }
  if (team === 'enemy') {
    return `${head}<path d="M6 0.9 L11.1 6 L6 11.1 L0.9 6 Z" fill="currentColor" stroke="#000" stroke-opacity=".85" stroke-width="1.2"/>` +
      (kind === 'scout' ? `<circle cx="6" cy="6" r="1.7" fill="${INK.ivory}" stroke="#000" stroke-width=".8"/>` : '') + '</svg>';
  }
  return `${head}<path d="M1.5 2.5 L10.5 2.5 L6 10.5 Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
}

let uid = 0;

export class HUD {
  constructor() {
    this.root = $('hud');
    this.crosshair = $('crosshair');
    this.scope = $('scope');
    // the gunner's optic (H-02): one canvas for field stop and reticle, the
    // pen chevron (#scopeDot keeps its old id), the optic's label (K-04), the
    // rangefinder, and the legend with its subject title (H-05)
    this.scopeCanvas = $('scopeCanvas');
    this.scopeDot = $('scopeDot');
    this.scopePen = $('scopePen');
    this.scopeInfo = $('scopeInfo');
    this.scopeRange = $('scopeRange');
    this.scopeLegend = $('scopeLegend');
    this.penMark = $('penMark');
    this.scopeGeom = null;
    this.reflector = null;
    this.gunMarker = $('gunMarker');
    this.mouseAim = $('mouseAim');
    this.deathInfo = $('deathInfo');
    this.killCamFrame = $('killCamFrame');
    this.killCamTitle = $('killCamTitle');
    this.killCamPerspective = 'shot';
    this.reloadWrap = $('reloadWrap');
    this.reloadBar = $('reloadBar');
    this.shellLabel = $('shellLabel');
    this.speedo = $('speedo');
    this.statusPanel = $('statusPanel');
    this.killfeed = $('killfeed');
    this.hitmsg = $('hitmsg');
    this.capStatus = $('capStatus');
    this.ticketsA = $('ticketsA');
    this.ticketsB = $('ticketsB');
    this.ticketsAText = $('ticketsAText');
    this.ticketsBText = $('ticketsBText');
    this.markersRoot = $('markers');
    this.scoreboard = $('scoreboard');
    this.helpPanel = $('helpPanel');
    this.minimap = $('minimap');
    this.mmCtx = this.minimap.getContext('2d');
    this.markers = new Map();
    this.wasReloading = false;

    // ---- new WT-style furniture ----
    this.compassWrap = $('compassWrap');
    this.compass = $('compass');
    this.compassCtx = this.compass ? this.compass.getContext('2d') : null;
    this.matchTop = $('matchTop');
    this.matchMode = $('matchMode');
    this.matchTimer = $('matchTimer');
    this.matchObjective = $('matchObjective');
    this.ammoPanel = $('ammoPanel');
    this.damagePanel = $('damagePanel');
    this.airPanel = $('airPanel');
    this.damageArcs = $('damageArcs');
    this.damageLog = $('damageLog');
    this.incomingMsg = $('incomingMsg');
    this.awardBanner = $('awardBanner');
    this.rewardPops = $('rewardPops');
    this.blackout = $('blackout');
    this.bigMap = $('bigMap');
    this.bigMapCanvas = $('bigMapCanvas');
    this.bigMapCtx = this.bigMapCanvas ? this.bigMapCanvas.getContext('2d') : null;
    this.bigMapTitle = $('bigMapTitle');

    // The old single-line widgets stay wired up (the battle files still drive
    // them) but step aside for as long as their replacement is on screen, so
    // the migration can happen one call site at a time without doubled-up
    // readouts — and a vehicle swap mid-battle puts the old one back.
    this.ammoPanelOwned = false;
    this.damagePanelOwned = false;
    this._damagePanelActive = false;
    this.speedoHidden = false;

    this.minimapZoom = 1;
    this.bigMapVisible = false;

    this._ammoSig = '';
    this._ammoRows = new Map();
    this._dmgSig = '';
    this._dmg = null;
    this._air = null;
    this._blackoutAmt = -1;
    this._blackoutRed = false;
    this._compassHeading = null;
    this._compassSig = 0;
    this._compassShown = false;
    // scoreboard: cached row elements plus the roster shape they were built
    // for, so holding Tab writes numbers instead of re-parsing both columns
    this._sbShown = false;
    this._sb = null;
    this._sbA = [];
    this._sbB = [];
    this._sbShape = '';
    this._sbNames = [];
    this._spawnEl = null;
    this._awardQueue = [];
    this._awardTimer = null;

    // out-of-bounds warning, built on first use
    this._boundEl = null;
    this._boundLvl = 0;

    // pen indicator, optic and reflector-sight state
    this._penKey = null;
    this._scopeShown = false;
    this._scopeSig = '';
    this._scopeCtx = null;
    this._reflEl = null;
    this._reflShown = false;
    this._reflKey = '';
    this._mapBg = null;

    applyPalette(this.root);
    this._fillScopeLegend();
    this.setPenIndicator(null);

    this.arcs = [];
    this._buildArcs();
  }

  // The optic's legend, outside the field stop: its subject named (C-41) and
  // the four outcomes with their glyphs, in the shot perspective.
  _fillScopeLegend() {
    const el = this.scopeLegend;
    if (!el) return;
    const leg = penLegend('shot');
    el.innerHTML =
      `<b>${leg.title}</b>` +
      leg.rows
        .map((r) => `<span><i style="color:${r.hex}">${r.glyph}</i>${r.word}</span>`)
        .join('');
  }

  show() {
    this.root.classList.remove('hidden');
    this.helpPanel.style.opacity = '1';
    setTimeout(() => (this.helpPanel.style.opacity = '0'), 5000);
    this.setBlackout(0);
    this.setBoundaryWarning(0);
    this.setBigMap(false);
    this.clearDamageLog();
  }

  hide() {
    this.root.classList.add('hidden');
    this.killfeed.innerHTML = '';
    this.hitmsg.innerHTML = '';
    this.setScopeVisible(false);
    this.setPenIndicator(null);
    this.setReflectorSight(0, 0, false);
    this.setDeathInfo(null);
    this.setMouseAim(0, 0, false);
    this.setKillCamVisible(false);
    this.setScoreboard(null);
    this.clearMarkers();
    // new panels: leave nothing burning on screen between battles
    this.statusPanel.innerHTML = '';
    this.setAmmoPanel(null);
    this.setDamagePanel(null);
    this.setAirPanel(null);
    this.setCompass(null);
    this.setMatchInfo(null);
    this.setSpawnPoints(null);
    this.setBlackout(0);
    this.setBoundaryWarning(0);
    this.setBigMap(false);
    this.clearDamageLog();
    this.incomingMsg.innerHTML = '';
    this.rewardPops.innerHTML = '';
    this._awardQueue.length = 0;
    if (this._awardTimer) {
      clearTimeout(this._awardTimer);
      this._awardTimer = null;
    }
    this.awardBanner.classList.add('hidden');
    for (const a of this.arcs) {
      a.el.classList.remove('live');
      a.until = 0;
    }
  }

  // H-02 / H-05: the penetration indicator. A small chevron in the pen
  // scale's SHOT perspective, with its glyph and word (C-40: never colour
  // alone): under the third-person crosshair, and 2.5 mils under the aim point
  // inside the gunner's optic. The reticle itself is never recoloured — real
  // reticles are etched ink. `state` is a penetrationForecast verdict
  // ('yes' | 'maybe' | 'no' | 'ricochet') or null to hide.
  setPenIndicator(state) {
    const o = state ? outcomeOf(state) : null;
    const key = o ? o.key : '';
    if (key === this._penKey) return;
    this._penKey = key;
    const hex = o ? penHex(o.key, 'shot') : '';
    // inside the optic the word moves out to the label column beside the
    // stop (#scopePen); the chevron and its glyph stay under the aim point
    if (this.scopePen) {
      this.scopePen.className = o ? `o-${o.key}` : 'hidden';
      if (this.scopePen.style && this.scopePen.style.setProperty) this.scopePen.style.setProperty('--pc', hex || 'transparent');
      const g = this.scopePen.querySelector ? this.scopePen.querySelector('.penGlyph') : null;
      const w = this.scopePen.querySelector ? this.scopePen.querySelector('.penWord') : null;
      if (g) g.textContent = o ? o.glyph : '';
      if (w) w.textContent = o ? o.word : '';
    }
    for (const el of [this.penMark, this.scopeDot]) {
      if (!el) continue;
      el.className = (o ? `penMark o-${o.key}` : 'penMark hidden')
        + (el === this.scopeDot && this._scopeDotSide ? ` ${this._scopeDotSide}` : '');
      if (el.style && el.style.setProperty) el.style.setProperty('--pc', hex || 'transparent');
      const g = el.querySelector ? el.querySelector('.penGlyph') : null;
      const w = el.querySelector ? el.querySelector('.penWord') : null;
      if (g) g.textContent = o ? o.glyph : '';
      if (w) w.textContent = o ? o.word : '';
    }
  }

  setCrosshairVisible(v) {
    this.crosshair.style.display = v ? 'block' : 'none';
    if (this.penMark) this.penMark.style.display = v ? '' : 'none';
  }

  setScopeVisible(v) {
    const on = !!v;
    if (on === this._scopeShown) return;
    this._scopeShown = on;
    this.scope.classList.toggle('hidden', !on);
    // the battle's top strip stands down inside the field stop: the objective
    // line would print across the range drum (style.css #hud.scoped)
    if (this.root && this.root.classList) this.root.classList.toggle('scoped', on);
    if (on) this._scopeSig = '';
  }

  // marks: [{ px, label }] — ballistic holdover marks, pixels below the screen
  // centre at the camera's CURRENT field of view (the battle computes them).
  // dist: the rangefinder distance, m. zoom: the old "N.Nx" figure, used only
  // when `view` is absent. view (optional): { fov, step } where fov is the
  // camera's current vertical field of view in degrees and step is one of
  // opticSteps(spec) — the optic, its family and the detent's label (K-04).
  updateScope(marks, dist, zoom, view = null) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const fov = view && view.fov > 0 ? view.fov : 60 / (parseFloat(zoom) || 1);
    const step = view && view.step ? view.step : null;
    const optic = step ? step.optic : (view && view.optic) || opticFor(null);
    const family = optic.family || 'us';
    const label = step ? step.label : `${optic.name} · ${(60 / fov).toFixed(1)}×`;
    setText(this.scopeInfo, label);
    setText(this.scopeRange, `DIST ${dist > 0 ? `${Math.round(dist)} m` : '—'}`);
    const scale = pxPerMil(fov, H, family);
    // the pen chevron rides PEN_CHEVRON_MILS under the aiming mark at any zoom
    // (penChevronOffsetPx), centred on the aim point's x; its glyph sits on
    // the side of it the reticle's ladder is not on
    if (this.scopeDot) {
      setStyle(this.scopeDot, 'top', `${Math.round(H / 2 + penChevronOffsetPx(family, scale))}px`);
      const side = family === 'su' ? 'g-right' : 'g-left';
      if (this._scopeDotSide !== side) {
        this._scopeDotSide = side;
        const base = String(this.scopeDot.className || '').replace(/\s*\bg-(left|right)\b/g, '');
        this.scopeDot.className = `${base} ${side}`;
      }
    }
    this.scopeGeom = { W, H, fov, family, pxPerMil: scale, stopR: (FIELD_STOP_K * H) / 2, label };
    let msig = '';
    for (const m of marks || []) msig += `${Math.round(m.px)}:${m.label};`;
    const sig = `${W}x${H}|${fov.toFixed(2)}|${family}|${msig}|${family === 'de' ? Math.round((dist || 0) / 10) : 0}`;
    if (sig === this._scopeSig) return;
    this._scopeSig = sig;
    this._drawScope(W, H, fov, family, marks || [], dist);
  }

  _drawScope(W, H, fov, family, marks, dist) {
    const cv = this.scopeCanvas;
    if (!cv || !cv.getContext) return;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const cw = Math.round(W * dpr);
    const ch = Math.round(H * dpr);
    if (cv.width !== cw) cv.width = cw;
    if (cv.height !== ch) cv.height = ch;
    const ctx = this._scopeCtx || (this._scopeCtx = cv.getContext('2d'));
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = W / 2;
    const cy = H / 2;
    const R = (FIELD_STOP_K * H) / 2;
    // H-30 field stop: black at 0.985 outside one hard circle (the canvas's
    // own anti-aliasing is the whole edge ramp, ~1 px = 0.2 % of the radius)
    ctx.fillStyle = 'rgba(0,0,0,0.985)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(cx, cy, R, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    // optical vignetting: 15 % across the outer 10 % of the radius
    const vg = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.15)');
    ctx.fillStyle = vg;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // everything etched stays inside the stop
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R - 1, 0, Math.PI * 2);
    ctx.clip();
    const m = pxPerMil(fov, H, family);
    const k = { ctx, cx, cy, R, m };
    if (family === 'de') this._reticleDe(k, marks, dist);
    else if (family === 'su') this._reticleSu(k, marks);
    else if (family === 'aa') this._reticleAa(k, marks);
    else this._reticleUs(k, marks);
    ctx.restore();
  }

  // H-33 dual tone: a 1.5 px black etched core over a 1 px white halo at 0.35
  // each side. `path` adds sub-paths to the current path.
  _etch(ctx, path, core = 1.5) {
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';
    ctx.beginPath();
    path();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = core + 2;
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = core;
    ctx.stroke();
  }

  _etchFill(ctx, path) {
    ctx.beginPath();
    path();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.fill();
  }

  _etchText(ctx, txt, x, y, align = 'left') {
    ctx.font = cfont(11, 700);
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 3;
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = '#000';
    ctx.fillText(txt, x, y);
  }

  // A labelled holdover ladder at x (px from centre): ticks at the battle's
  // ballistic marks, the label in hundreds of metres.
  _ladder(k, marks, x, dir = 1) {
    const { ctx, cx, cy, m } = k;
    if (!marks.length) return;
    const tick = Math.max(6, m * 1);
    const last = marks[marks.length - 1].px;
    this._etch(ctx, () => {
      ctx.moveTo(cx + x, cy + Math.min(marks[0].px, m));
      ctx.lineTo(cx + x, cy + last);
      for (const mk of marks) {
        ctx.moveTo(cx + x, cy + mk.px);
        ctx.lineTo(cx + x + dir * tick, cy + mk.px);
      }
    }, 1.2);
    // labels from the far end inward, each only where it clears the last one
    // drawn: at a wide field the near ranges crowd into a few pixels, and a
    // pile of numerals is worse than the long-range ones alone
    let lastY = Infinity;
    for (let i = marks.length - 1; i >= 0; i--) {
      const mk = marks[i];
      if (lastY - mk.px < 12) continue;
      lastY = mk.px;
      const lbl = typeof mk.label === 'number' ? String(Math.round(mk.label / 100)) : String(mk.label);
      this._etchText(ctx, lbl, cx + x + dir * (tick + 4), cy + mk.px, dir > 0 ? 'left' : 'right');
    }
  }

  // German (TZF): a central aiming triangle, smaller flanking triangles every
  // `spacing` mils, a range arc at the top of the field with a pointer at the
  // rangefinder distance (the range drum), holdover ladder to the right.
  _reticleDe(k, marks, dist) {
    const { ctx, cx, cy, R, m } = k;
    const T = RETICLE.de;
    const tri = (x, h, w) => {
      ctx.moveTo(cx + x, cy);
      ctx.lineTo(cx + x + (w / 2) * m, cy + h * m);
      ctx.lineTo(cx + x - (w / 2) * m, cy + h * m);
      ctx.closePath();
    };
    this._etchFill(ctx, () => {
      tri(0, T.bigH, T.bigW);
      for (let i = 1; i <= T.count; i++) {
        tri(i * T.spacing * m, T.smallH, T.smallW);
        tri(-i * T.spacing * m, T.smallH, T.smallW);
      }
    });
    this._ladder(k, marks, (T.count * T.spacing + 2.5) * m, 1);
    // range drum: 0-2000 m along an arc near the top of the field
    const a0 = (-38 * Math.PI) / 180;
    const a1 = (38 * Math.PI) / 180;
    // the arc, numerals and pointer tip (rr + 11) stay below the top strip
    const rr = Math.max(R * 0.6, Math.min(R * 0.86, cy - SCOPE_TOP_CLEAR_PX - 11));
    const at = (f) => a0 + (a1 - a0) * f;
    this._etch(ctx, () => {
      ctx.arc(cx, cy, rr, at(0) - Math.PI / 2, at(1) - Math.PI / 2);
      for (let r = 0; r <= 2000; r += 200) {
        const a = at(r / 2000);
        const len = r % 400 === 0 ? 8 : 4;
        ctx.moveTo(cx + Math.sin(a) * rr, cy - Math.cos(a) * rr);
        ctx.lineTo(cx + Math.sin(a) * (rr - len), cy - Math.cos(a) * (rr - len));
      }
    }, 1.2);
    for (let r = 0; r <= 2000; r += 400) {
      const a = at(r / 2000);
      this._etchText(ctx, String(r / 100), cx + Math.sin(a) * (rr - 16), cy - Math.cos(a) * (rr - 16), 'center');
    }
    if (dist > 0) {
      const a = at(Math.min(1, dist / 2000));
      const px = cx + Math.sin(a) * (rr + 2);
      const py = cy - Math.cos(a) * (rr + 2);
      this._etchFill(ctx, () => {
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.sin(a + 0.5) * 9, py - Math.cos(a + 0.5) * 9);
        ctx.lineTo(px + Math.sin(a - 0.5) * 9, py - Math.cos(a - 0.5) * 9);
        ctx.closePath();
      });
    }
  }

  // Soviet: a central chevron, a horizontal stadiametric scale in thousandths,
  // the holdover ladder (the range scale) to the left.
  _reticleSu(k, marks) {
    const { ctx, cx, cy, m } = k;
    const T = RETICLE.su;
    this._etch(ctx, () => {
      ctx.moveTo(cx - (T.chevW / 2) * m, cy + T.chevH * m);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + (T.chevW / 2) * m, cy + T.chevH * m);
      const x0 = (T.chevW / 2 + 1) * m;
      const x1 = (T.tick * T.ticks + 0.01) * m;
      ctx.moveTo(cx - x1, cy);
      ctx.lineTo(cx - x0, cy);
      ctx.moveTo(cx + x0, cy);
      ctx.lineTo(cx + x1, cy);
      for (let i = 1; i <= T.ticks; i++) {
        const x = i * T.tick * m;
        if (x < x0) continue;
        for (const s of [-1, 1]) {
          ctx.moveTo(cx + s * x, cy);
          ctx.lineTo(cx + s * x, cy - T.tickLen * m);
        }
      }
    });
    // numerals only where they have room (at the true field the scale is a
    // few pixels per thousandth and the ticks alone read better)
    if (2 * T.tick * m >= 26) {
      for (let i = 2; i <= T.ticks; i += 2) {
        const x = i * T.tick * m;
        this._etchText(ctx, String(i * T.tick), cx + x, cy - T.tickLen * m - 9, 'center');
        this._etchText(ctx, String(i * T.tick), cx - x, cy - T.tickLen * m - 9, 'center');
      }
    }
    this._ladder(k, marks, -(T.chevW / 2 + 2.5) * m, -1);
  }

  // US: a crosshair broken at the centre, lead ticks every `lead` mils along
  // the horizontal, range lines below the centre (the holdover marks).
  _reticleUs(k, marks) {
    const { ctx, cx, cy, R, m } = k;
    const T = RETICLE.us;
    const g = T.gap * m;
    this._etch(ctx, () => {
      ctx.moveTo(cx, cy - R);
      ctx.lineTo(cx, cy - g);
      ctx.moveTo(cx - R, cy);
      ctx.lineTo(cx - g, cy);
      ctx.moveTo(cx + g, cy);
      ctx.lineTo(cx + R, cy);
      for (let i = 1; i <= T.leads; i++) {
        const x = i * T.lead * m;
        for (const s of [-1, 1]) {
          ctx.moveTo(cx + s * x, cy - (T.leadLen / 2) * m);
          ctx.lineTo(cx + s * x, cy + (T.leadLen / 2) * m);
        }
      }
      // range lines: a short bar at each holdover mark, below the centre
      for (const mk of marks) {
        if (mk.px <= g) continue;
        const w = Math.max(8, 2 * m);
        ctx.moveTo(cx - w, cy + mk.px);
        ctx.lineTo(cx + w, cy + mk.px);
      }
      // the vertical below the range lines
      const last = marks.length ? marks[marks.length - 1].px : 0;
      ctx.moveTo(cx, cy + g);
      ctx.lineTo(cx, cy + Math.max(g, last));
    });
    let lastY = Infinity;
    for (let i = marks.length - 1; i >= 0; i--) {
      const mk = marks[i];
      if (mk.px <= g || lastY - mk.px < 12) continue;
      lastY = mk.px;
      const w = Math.max(8, 2 * m);
      const lbl = typeof mk.label === 'number' ? String(Math.round(mk.label / 100)) : String(mk.label);
      this._etchText(ctx, lbl, cx + w + 5, cy + mk.px, 'left');
    }
  }

  // AA (Flakvisier): lead rings and a centre dot, holdover ladder right.
  _reticleAa(k, marks) {
    const { ctx, cx, cy, m } = k;
    const T = RETICLE.aa;
    this._etch(ctx, () => {
      for (const r of T.rings) {
        ctx.moveTo(cx + r * m, cy);
        ctx.arc(cx, cy, r * m, 0, Math.PI * 2);
      }
      const out = T.rings[T.rings.length - 1] * m;
      ctx.moveTo(cx - out, cy);
      ctx.lineTo(cx + out, cy);
      ctx.moveTo(cx, cy - out);
      ctx.lineTo(cx, cy + out);
    });
    this._etchFill(ctx, () => ctx.arc(cx, cy, Math.max(2, T.dot * m), 0, Math.PI * 2));
    this._ladder(k, marks, (T.rings[T.rings.length - 1] + 2) * m, 1);
  }

  // H-03 / A-02: the collimated reflector sight of the cockpit view. Drawn at
  // the projected gun-line point every frame — the battle projects
  // PlaneCamera.gunLineWorldPoint() through the final camera, so neither
  // smoothing nor shake can move the graticule off the guns. opts: { fov
  // (vertical, degrees), gunSpeed (m/s) }. The ring is the 100 mph crossing
  // lead (reflectorRingMrad), drawn additively (plus-lighter) in a warm
  // 3,000 K over a 15 % neutral-density pane, so it stays readable against a
  // bright sky. The element lives under #app beside the game canvas, outside
  // the HUD's own stacking context, because only there can it blend with the
  // picture.
  setReflectorSight(x, y, visible, opts = null) {
    const el = this._ensureReflector();
    if (!el) return;
    if (!visible) {
      if (this._reflShown) {
        this._reflShown = false;
        el.style.display = 'none';
      }
      return;
    }
    if (!this._reflShown) {
      this._reflShown = true;
      el.style.display = 'block';
    }
    const H = window.innerHeight;
    const fov = opts && opts.fov > 0 ? opts.fov : 60;
    const gunSpeed = opts && opts.gunSpeed > 0 ? opts.gunSpeed : 800;
    const r = reflectorRingPx(gunSpeed, fov, H);
    // the centre dot is the real 2 mrad (H-03: <= 2 mrad), however few pixels
    // that is; it is drawn additively, so even ~1.3 px reads as a point of light
    const dot = angleToPx(REFLECTOR.dotMrad / 1000, fov, H);
    this.reflector = { x, y, r, dot, fov, gunSpeed };
    const q = (v) => Math.round(v * 4) / 4;
    const key = `${q(r)}|${q(dot)}`;
    if (key !== this._reflKey) {
      this._reflKey = key;
      const s = Math.ceil(r * 2 + 24);
      const c = s / 2;
      const col = REFLECTOR.color;
      const tick = Math.max(4, r * 0.28);
      el.__svg.setAttribute('width', String(s));
      el.__svg.setAttribute('height', String(s));
      el.__svg.setAttribute('viewBox', `0 0 ${s} ${s}`);
      el.__svg.innerHTML =
        `<circle cx="${c}" cy="${c}" r="${r.toFixed(2)}" fill="none" stroke="${col}" stroke-width="1.6"/>` +
        `<circle cx="${c}" cy="${c}" r="${(dot / 2).toFixed(2)}" fill="${col}"/>` +
        // the cross broken round the dot, as on the period graticules
        `<path d="M${c - r - tick} ${c}H${c - r + tick}M${c + r - tick} ${c}H${c + r + tick}` +
        `M${c} ${c - r - tick}V${c - r + tick}M${c} ${c + r - tick}V${c + r + tick}" ` +
        `stroke="${col}" stroke-width="1.6" fill="none"/>`;
      el.__svg.style.marginLeft = `${-c}px`;
      el.__svg.style.marginTop = `${-c}px`;
      // the reflector glass: a little wider than the ring, as the combiner was
      const pw = Math.round(r * 2.9);
      const ph = Math.round(r * 2.3);
      el.__pane.style.width = `${pw}px`;
      el.__pane.style.height = `${ph}px`;
      el.__pane.style.marginLeft = `${-pw / 2}px`;
      el.__pane.style.marginTop = `${-ph / 2}px`;
    }
    // left/top, never a transform: a transform would make the wrapper its own
    // stacking context and the graticule would blend with nothing but it
    setStyle(el, 'left', `${x.toFixed(1)}px`);
    setStyle(el, 'top', `${y.toFixed(1)}px`);
  }

  _ensureReflector() {
    if (this._reflEl) return this._reflEl;
    if (typeof document === 'undefined') return null;
    const host = $('app') || (this.root && this.root.parentNode);
    if (!host || !document.createElementNS) return null;
    const el = document.createElement('div');
    el.id = 'reflectorSight';
    el.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;display:none';
    const pane = document.createElement('div');
    pane.style.cssText = `position:absolute;left:0;top:0;background:rgba(0,0,0,${REFLECTOR.nd})`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'reflGraticule');
    svg.style.cssText = 'position:absolute;left:0;top:0;mix-blend-mode:plus-lighter;overflow:visible';
    el.appendChild(pane);
    el.appendChild(svg);
    el.__pane = pane;
    el.__svg = svg;
    // after the game canvas, before the HUD: the HUD (z-index 10) stays on top
    if (this.root && this.root.parentNode === host && host.insertBefore) host.insertBefore(el, this.root);
    else host.appendChild(el);
    this._reflEl = el;
    this._reflShown = false;
    return el;
  }

  setDeathInfo(text) {
    this.deathInfo.classList.toggle('hidden', !text);
    if (text) this.deathInfo.textContent = text;
  }

  // H-05: the hit cam declares its subject. Your own shot on an enemy is the
  // 'shot' perspective (PEN green); a shot striking YOU (the death cam, a bomb
  // on your tank) is 'armour' (PEN red), titled THIS ARMOUR. The X-ray tints
  // its impact ring from the same perspective (data.perspective).
  setKillCamVisible(v, perspective) {
    this.killCamFrame.classList.toggle('hidden', !v);
    if (!v) return;
    const persp = perspective === 'armour' ? 'armour' : 'shot';
    this.killCamPerspective = persp;
    this.killCamFrame.classList.toggle('armour', persp === 'armour');
    if (this.killCamTitle) {
      const txt = `HIT CAMERA · ${penLegend(persp).title}`;
      if (this.killCamTitle.textContent !== txt) this.killCamTitle.textContent = txt;
    }
  }

  // data: { allies: [...], enemies: [...] } or null.
  // A row is either the original { name, kills, deaths, assists, caps, isPlayer }
  // or the full stat line { name, vehicle, score, kills, groundKills, airKills,
  // assists, deaths, caps, isPlayer }. The table grows columns to fit whatever
  // the rows actually carry, so both shapes render without a flag.
  // Tab is held for seconds at a stretch, so the table is built once for a
  // given roster and only its numbers are written after that — through the same
  // guarded setText every other panel here uses. Rebuilding both columns from
  // innerHTML sixty times a second cost ~130 DOM nodes and a full relayout per
  // frame, for a picture that changes when somebody scores.
  setScoreboard(data) {
    if (!data) {
      if (this._sbShown) {
        this._sbShown = false;
        this.scoreboard.classList.add('hidden');
      }
      return;
    }
    if (!this._sbShown) {
      this._sbShown = true;
      this.scoreboard.classList.remove('hidden');
    }

    const allies = this._sbFill(this._sbA, data.allies);
    const enemies = this._sbFill(this._sbB, data.enemies);
    let rich = false;
    let hasVehicle = false;
    let splitKills = false;
    for (let pass = 0; pass < 2; pass++) {
      for (const s of pass ? enemies : allies) {
        if (s.score != null || s.vehicle != null) rich = true;
        if (s.vehicle != null) hasVehicle = true;
        if (s.groundKills != null || s.airKills != null) splitKills = true;
      }
    }
    // the plain shape has no score column, so it keeps the order it was given
    if (rich) {
      allies.sort(byScore);
      enemies.sort(byScore);
    }

    if (this._sbStale(allies, enemies, rich, hasVehicle, splitKills)) {
      this._buildScoreboard(allies, enemies, rich, hasVehicle, splitKills);
    }
    this._fillScoreboard(allies, enemies, rich, hasVehicle, splitKills);
  }

  _sbFill(out, list) {
    out.length = 0;
    if (list) for (const s of list) if (s) out.push(s);
    return out;
  }

  // True only when the table's shape changed — a different roster, a vehicle
  // swap that added a column, somebody joining or dying out of the lineup.
  _sbStale(allies, enemies, rich, hasVehicle, splitKills) {
    const shape =
      `${rich ? 'r' : 'p'}${hasVehicle ? 'v' : '-'}${splitKills ? 's' : '-'}` +
      `${allies.length}/${enemies.length}`;
    let stale = !this._sb || shape !== this._sbShape;
    const names = this._sbNames;
    if (!stale) {
      let i = 0;
      for (let pass = 0; pass < 2 && !stale; pass++) {
        for (const s of pass ? enemies : allies) {
          if (names[i++] !== s.name) {
            stale = true;
            break;
          }
        }
      }
    }
    if (!stale) return false;
    this._sbShape = shape;
    names.length = 0;
    for (const s of allies) names.push(s.name);
    for (const s of enemies) names.push(s.name);
    return true;
  }

  _buildScoreboard(allies, enemies, rich, hasVehicle, splitKills) {
    const head = rich
      ? '<div class="sbRow sbHead">' +
        '<span class="c-name">NAME</span>' +
        (hasVehicle ? '<span class="c-veh">VEHICLE</span>' : '') +
        (splitKills
          ? '<span class="c-n">GND</span><span class="c-n">AIR</span>'
          : '<span class="c-n">K</span>') +
        '<span class="c-n">A</span><span class="c-n">D</span><span class="c-n">C</span>' +
        '<span class="c-score">SCORE</span></div>'
      : '<div class="sbHead"><span>NAME</span><span>K / D / A / C</span></div>';
    const blank = rich
      ? '<div class="sbRow"><span class="c-name"></span>' +
        (hasVehicle ? '<span class="c-veh"></span>' : '') +
        (splitKills ? '<span class="c-n"></span><span class="c-n"></span>' : '<span class="c-n"></span>') +
        '<span class="c-n"></span><span class="c-n"></span><span class="c-n"></span>' +
        '<span class="c-score"></span></div>'
      : '<div class="sbRow"><span></span><span></span></div>';
    const col = (title, list) =>
      `<div class="sbCol${rich ? ' wide' : ''}"><h4>${title}${rich ? '<b></b>' : ''}</h4>` +
      head +
      blank.repeat(list.length) +
      '</div>';

    this.scoreboard.innerHTML = col('ALLIES', allies) + col('ENEMIES', enemies);

    const cols = this.scoreboard.querySelectorAll('.sbCol');
    const rows = [];
    for (const c of cols) {
      for (const row of c.querySelectorAll('.sbRow:not(.sbHead)')) {
        rows.push({ row, cls: 'sbRow', cells: row.children });
      }
    }
    this._sb = {
      rows,
      totals: [
        cols[0] ? cols[0].querySelector('h4 b') : null,
        cols[1] ? cols[1].querySelector('h4 b') : null,
      ],
    };
  }

  _fillScoreboard(allies, enemies, rich, hasVehicle, splitKills) {
    const sb = this._sb;
    if (!sb) return;
    let idx = 0;
    for (let pass = 0; pass < 2; pass++) {
      let sum = 0;
      for (const s of pass ? enemies : allies) {
        const ref = sb.rows[idx++];
        if (!ref) continue;
        const score = Math.round(scoreOf(s));
        sum += score;
        const cls = s.isPlayer ? 'sbRow me' : 'sbRow';
        if (ref.cls !== cls) {
          ref.cls = cls;
          ref.row.className = cls;
        }
        const c = ref.cells;
        let k = 0;
        setText(c[k++], String(s.name));
        if (!rich) {
          setText(c[k++], `${s.kills} / ${s.deaths} / ${s.assists || 0} / ${s.caps || 0}`);
          continue;
        }
        if (hasVehicle) setText(c[k++], s.vehicle || '—');
        if (splitKills) {
          setText(c[k++], String(s.groundKills != null ? s.groundKills : s.kills || 0));
          setText(c[k++], String(s.airKills != null ? s.airKills : 0));
        } else {
          setText(c[k++], String(s.kills || 0));
        }
        setText(c[k++], String(s.assists || 0));
        setText(c[k++], String(s.deaths || 0));
        setText(c[k++], String(s.caps || 0));
        setText(c[k++], String(score));
      }
      setText(sb.totals[pass], String(sum));
    }
  }

  // The aeroplane's mouse-aim point: where the instructor is flying it.
  setMouseAim(x, y, visible) {
    if (!this.mouseAim) return;
    this.mouseAim.style.display = visible ? 'block' : 'none';
    if (visible) {
      this.mouseAim.style.left = `${x}px`;
      this.mouseAim.style.top = `${y}px`;
    }
  }

  setGunMarker(x, y, visible) {
    this.gunMarker.style.display = visible ? 'block' : 'none';
    if (visible) {
      this.gunMarker.style.left = `${x}px`;
      this.gunMarker.style.top = `${y}px`;
    }
  }

  setReload(frac, ready) {
    this.reloadBar.style.width = `${Math.round(frac * 100)}%`;
    this.reloadBar.className = ready ? 'ready' : '';
    const done = ready && this.wasReloading;
    this.wasReloading = !ready;
    return done; // battle plays the ready click
  }

  setShell(type, ammo, mgAmmo = 0) {
    const mg = mgAmmo > 0 ? `  ·  MG ×${mgAmmo}` : '';
    const order = Object.keys(ammo);
    const hint = order
      .filter((k) => k !== type)
      .map((k) => `${order.indexOf(k) + 1}: ${k}`)
      .join(' · ');
    this.shellLabel.textContent =
      `${type} ×${ammo[type]}${hint ? `   (${hint})` : ''}${mg}`;
  }

  setAmmoLabel(text) {
    this.shellLabel.textContent = text;
  }

  setReloadVisible(v) {
    this.reloadWrap.style.display = v ? 'block' : 'none';
  }

  setHelp(html) {
    // the battle files write the default key names; print the bound ones
    this.helpPanel.innerHTML = '<b>CONTROLS</b>' + relabelHelp(html);
  }

  setSpeed(ms) {
    setText(this.speedo, `${Math.round(Math.abs(ms) * 3.6)} km/h`);
  }

  setFlightInfo(kmh, alt, thrPct) {
    setText(this.speedo, `${kmh} km/h · ALT ${alt} m · THR ${thrPct}%`);
  }

  setPlaneStatus(plane) {
    if (!plane) {
      this.statusPanel.innerHTML = '';
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round((plane.hp / plane.spec.hp) * 100)));
    const barColor = pct > 50 ? COL.ok : pct > 25 ? COL.damaged : COL.destroyed;
    const mod = (ok, label) =>
      `<div class="modRow"><span>${label}</span><span class="${ok ? 'ok' : 'out'}">${ok ? 'OK' : 'DAMAGED'}</span></div>`;
    const fireRow = plane.burning
      ? `<div class="modRow"><span class="burning">FIRE</span><span class="burning">${Math.ceil(plane.burnTimer)}s</span></div>`
      : '';
    this.statusPanel.innerHTML =
      `<div class="hpBar"><div style="width:${pct}%;background:${barColor}"></div></div>` +
      mod(plane.engineOk, 'Engine') +
      mod(plane.wingsOk, 'Wings') +
      fireRow;
    this._syncLegacyStatus();
  }

  setStatus(tank) {
    if (!tank) {
      this.statusPanel.innerHTML = '';
      return;
    }
    let crewDots = '';
    for (let i = 0; i < tank.spec.crew; i++) {
      crewDots += `<div class="crewDot${i < tank.crew ? '' : ' dead'}"></div>`;
    }
    const mod = (m, label) => {
      if (m.ok) return `<div class="modRow"><span>${label}</span><span class="ok">OK</span></div>`;
      return `<div class="modRow"><span>${label}</span><span class="out">${Math.ceil(m.timer)}s</span></div>`;
    };
    const ammoRow = tank.modules.ammoRack.ok
      ? '<div class="modRow"><span>Ammo rack</span><span class="ok">OK</span></div>'
      : '<div class="modRow"><span>Ammo rack</span><span class="dmg">DAMAGED</span></div>';
    const fireRow = tank.burning
      ? `<div class="modRow"><span class="burning">FIRE</span><span class="burning">${Math.ceil(tank.burnTimer)}s</span></div>`
      : '';
    this.statusPanel.innerHTML =
      `<div class="crewRow">${crewDots}</div>` +
      mod(tank.modules.engine, 'Engine') +
      mod(tank.modules.transmission, 'Transmission') +
      mod(tank.modules.tracks, 'Tracks') +
      mod(tank.modules.breech, 'Gun breech') +
      ammoRow +
      fireRow;
    this._syncLegacyStatus();
  }

  // The old text panel hides itself for good once the silhouette panel has been
  // fed real data, so the two never sit on top of each other mid-migration.
  _syncLegacyStatus() {
    setShown(this.statusPanel, !this._damagePanelActive);
  }

  addKillfeed(killerName, killerTeam, victimName, victimTeam) {
    const row = document.createElement('div');
    row.className = 'killrow';
    const kCls = killerTeam === 0 ? 'allies' : 'enemies';
    const vCls = victimTeam === 0 ? 'allies' : 'enemies';
    row.innerHTML = `<span class="${kCls}">${killerName}</span> ✕ <span class="${vCls}">${victimName}</span>`;
    this.killfeed.prepend(row);
    while (this.killfeed.children.length > 6) this.killfeed.lastChild.remove();
    setTimeout(() => row.remove(), 8000);
  }

  hitMessage(text, cls = 'good') {
    const el = document.createElement('div');
    el.className = `hitpop ${cls}`;
    el.textContent = text;
    this.hitmsg.appendChild(el);
    while (this.hitmsg.children.length > 4) this.hitmsg.firstChild.remove();
    setTimeout(() => el.remove(), 1700);
  }

  updateTickets(a, b, max, capOwner, capProgress, label = null) {
    setStyle(this.ticketsA, 'width', `${Math.max(0, (a / max) * 100)}%`);
    setStyle(this.ticketsB, 'width', `${Math.max(0, (b / max) * 100)}%`);
    setText(this.ticketsAText, String(Math.max(0, Math.ceil(a))));
    setText(this.ticketsBText, String(Math.max(0, Math.ceil(b))));
    let text;
    let cls;
    if (label != null) {
      text = label;
      cls = '';
    } else if (capOwner === 0) {
      text = 'POINT: ALLIES';
      cls = 'allies';
    } else if (capOwner === 1) {
      text = 'POINT: ENEMY';
      cls = 'enemies';
    } else if (Math.abs(capProgress) > 2) {
      text = `CAPTURING ${Math.round(Math.abs(capProgress))}%`;
      cls = capProgress > 0 ? 'enemies' : 'allies';
    } else {
      text = 'POINT: NEUTRAL';
      cls = '';
    }
    setText(this.capStatus, text);
    if (this.capStatus.className !== cls) this.capStatus.className = cls;
  }

  // The spawn-point balance, under the capture readout. The whole lineup system
  // exists to make "push for one more kill or bank what I have" a real
  // decision, and it cannot be made if the number only shows up on the death
  // screen. `nextCost` is what the vehicle the player would bring back costs;
  // the chip goes amber while it is out of reach. Pass null to hide it.
  setSpawnPoints(points, nextCost = null) {
    if (points == null) {
      if (this._spawnEl) setShown(this._spawnEl, false);
      return;
    }
    const el = this._ensureSpawnChip();
    if (!el) return;
    setShown(el, true);
    const n = Math.max(0, Math.round(points));
    const short = nextCost != null && n < Math.round(nextCost);
    setText(this._spawnVal, String(n));
    setText(this._spawnCost, nextCost != null ? ` / ${Math.round(nextCost)}` : '');
    setFlag(el, 'short', short);
  }

  // Built here rather than in index.html: the markup belongs to another file
  // and this widget must be able to appear without touching it.
  _ensureSpawnChip() {
    if (this._spawnEl) return this._spawnEl;
    if (typeof document === 'undefined') return null;
    const host = $('matchCentre') || $('topBar') || this.root;
    if (!host) return null;
    const el = document.createElement('div');
    el.id = 'spawnChip'; // styled by style.css (#spawnChip, .short)
    const label = document.createElement('span');
    label.textContent = 'SP';
    const val = document.createElement('b');
    const cost = document.createElement('span');
    el.appendChild(label);
    el.appendChild(val);
    el.appendChild(cost);
    host.appendChild(el);
    this._spawnEl = el;
    this._spawnVal = val;
    this._spawnCost = cost;
    return el;
  }

  // ============================================================
  // 1. AMMO PANEL
  // ============================================================
  // data: { shells: [{ key, label, count, selected, kind, hint }], mg,
  //         reloadFrac, reloadReady, reloadSeconds, noFireReason } — or null.
  // noFireReason ('gunner' | null, optional): the gun cannot fire at all right
  // now — drawn as silenced, never as READY, whatever reloadReady says.
  // `mg` is a plain count or { count, label }. `kind` picks the icon and falls
  // back to the key, so { key: 'APHE', count: 12 } is already enough.
  setAmmoPanel(data) {
    if (!data || !data.shells || !data.shells.length) {
      setShown(this.ammoPanel, false);
      // give the old label back — unless the air cluster is up, which prints
      // the plane's stores itself
      if (this.ammoPanelOwned && !this.speedoHidden) setShown(this.shellLabel, true);
      return;
    }
    this.ammoPanelOwned = true;
    setShown(this.shellLabel, false);
    setShown(this.ammoPanel, true);

    const shells = data.shells;
    const mgCount = data.mg == null ? null : typeof data.mg === 'object' ? data.mg.count : data.mg;
    const mgLabel = data.mg && typeof data.mg === 'object' && data.mg.label ? data.mg.label : 'MG';
    const sig = shells.map((s) => `${s.key}:${s.kind || ''}`).join('|') + `#${mgCount != null}`;

    if (sig !== this._ammoSig) {
      this._ammoSig = sig;
      this._ammoRows.clear();
      let html = '<div class="apRows">';
      shells.forEach((s, i) => {
        const hint = s.hint != null ? s.hint : i + 1;
        html +=
          '<div class="apRow">' +
          `<i class="apIcon k-${String(s.kind || s.key).toUpperCase()}">${shellIcon(s.kind || s.key)}</i>` +
          `<span class="apName">${s.label || s.key}</span>` +
          '<b class="apCount">0</b>' +
          `<em class="apKey">${hint}</em>` +
          '</div>';
      });
      html += '</div>';
      if (mgCount != null) {
        html +=
          `<div class="apMg"><span>${mgLabel}</span><b class="apMgCount">0</b></div>`;
      }
      html +=
        '<div class="apReload"><div class="apReloadFill"></div>' +
        '<span class="apReloadTxt"></span></div>';
      this.ammoPanel.innerHTML = html;
      const rows = this.ammoPanel.querySelectorAll('.apRow');
      shells.forEach((s, i) => {
        const row = rows[i];
        this._ammoRows.set(s.key, {
          row,
          count: row.querySelector('.apCount'),
        });
      });
      this._ammoMg = this.ammoPanel.querySelector('.apMgCount');
      this._ammoReload = this.ammoPanel.querySelector('.apReload');
      this._ammoReloadFill = this.ammoPanel.querySelector('.apReloadFill');
      this._ammoReloadTxt = this.ammoPanel.querySelector('.apReloadTxt');
    }

    for (const s of shells) {
      const ref = this._ammoRows.get(s.key);
      if (!ref) continue;
      const empty = !(s.count > 0);
      const cls = `apRow${s.selected ? ' sel' : ''}${empty ? ' empty' : ''}`;
      if (ref.row.className !== cls) ref.row.className = cls;
      setText(ref.count, String(s.count != null ? s.count : 0));
    }
    if (this._ammoMg) setText(this._ammoMg, String(mgCount != null ? mgCount : 0));

    // A gun with nobody to lay it is not "reloading", it is silenced. The bar
    // keeps its true reload progress underneath (the breech still gets loaded)
    // but is struck through in red and says why, the selected round's marker
    // goes red with it, and READY is never printed while the gun is silent.
    // An SPAA belt has no reload bar at all, so a silenced one grows one.
    const reason = data.noFireReason || null;
    const silenced = reason != null;
    setFlag(this.ammoPanel, 'apSilenced', silenced);
    if (data.reloadFrac == null && data.reloadReady == null && !silenced) {
      setShown(this._ammoReload, false);
    } else {
      setShown(this._ammoReload, true);
      setFlag(this._ammoReload, 'silenced', silenced);
      const loaded = !!data.reloadReady;
      const ready = loaded && !silenced;
      const f = loaded ? 1 : clamp(data.reloadFrac || 0, 0, 1);
      setStyle(this._ammoReloadFill, 'width', `${Math.round(f * 100)}%`);
      const rc = silenced ? 'apReloadFill silenced' : ready ? 'apReloadFill ready' : 'apReloadFill';
      if (this._ammoReloadFill.className !== rc) this._ammoReloadFill.className = rc;
      const secs = data.reloadSeconds;
      setText(
        this._ammoReloadTxt,
        silenced
          ? SILENCED_TEXT[reason] || SILENCED_FALLBACK
          : ready
            ? 'READY'
            : secs != null
              ? `${secs < 10 ? secs.toFixed(1) : Math.ceil(secs)} s`
              : '',
      );
    }
  }

  // Adapter: the exact ammo-panel payload for a Tank, so the battle files only
  // have to pass the vehicle they already hold.
  buildTankAmmoPanel(tank) {
    if (!tank || !tank.spec) return null;
    const keys = Object.keys(tank.spec.shells || {});
    const shells = keys
      .filter((k) => (tank.spec.shells[k].count || 0) > 0 || tank.ammo[k] > 0)
      .map((k) => ({
        key: k,
        label: k,
        kind: tank.spec.shells[k].kind || k,
        count: tank.ammo ? tank.ammo[k] || 0 : 0,
        selected: tank.shellType === k,
        hint: keys.indexOf(k) + 1,
      }));
    // An empty gunner's seat silences the main gun and the belt alike. Older
    // entities without staffed() simply never report it.
    const gunnerDown = typeof tank.staffed === 'function' && !tank.staffed('gunner');
    if (!shells.length) {
      // an SPAA carries no main-gun rounds at all — the belt is the weapon, so
      // it gets the stack to itself and no reload bar
      if (tank.streamAmmo > 0) {
        const label = tank.spec.aa ? 'AA' : 'MG';
        return {
          shells: [{ key: label, label, kind: 'HE', count: tank.streamAmmo, selected: true, hint: '1' }],
          noFireReason: gunnerDown ? 'gunner' : null,
        };
      }
      return null;
    }
    const loaded = tank.reload <= 0 && tank.modules && tank.modules.breech.ok;
    const ready = loaded && !gunnerDown;
    return {
      shells,
      mg: tank.streamAmmo > 0 ? { count: tank.streamAmmo, label: tank.spec.aa ? 'AA' : 'MG' } : null,
      reloadFrac: loaded ? 1 : 1 - Math.max(0, tank.reload) / tank.spec.reload,
      reloadReady: ready,
      reloadSeconds: Math.max(0, tank.reload),
      noFireReason: gunnerDown ? 'gunner' : null,
    };
  }

  // ============================================================
  // 2. DAMAGE PANEL
  // ============================================================
  // data: { kind: 'tank' | 'plane', name, hull, turret,
  //         crew: [{ role, state }], modules: [{ key, label, state }],
  // A crew row may also carry (all optional, e.g. Tank.crewPanelRows output):
  //   key        station id ('driver', 'gunner', ...) — places the pip when
  //              the role label is not itself a station name
  //   state      also 'moving' (a man is climbing into this empty seat) or
  //              'leaving' (this seat's man is on his way to another one)
  //   swapFrac   0..1 progress of that swap — ring on the pip, bar on the row
  //   swapSeconds seconds until the seat is manned (moving rows)
  //   swapFrom / swapTo  the other end of the swap (station id or label)
  //   text       overrides the word printed at the right of the row
  //   health     accepted, not drawn
  //         consumables: [{ key, label, count, hint }],
  //         fire, fireSeconds, repairing, repairFrac } — or null to hide.
  // `hull` / `turret` take either a state string or a 0..1 health fraction.
  // Every one of the consumable keys commands a finite resource, and a fire is
  // now fatal, so "how many extinguishers have I got" has to be readable
  // without pressing the key and being told there are none.
  setDamagePanel(data) {
    if (!data) {
      setShown(this.damagePanel, false);
      this._damagePanelActive = false;
      if (this.damagePanelOwned) setShown(this.statusPanel, true);
      return;
    }
    this.damagePanelOwned = true;
    this._damagePanelActive = true;
    setShown(this.statusPanel, false);
    setShown(this.damagePanel, true);

    const kind = data.kind === 'plane' ? 'plane' : 'tank';
    const crew = data.crew || [];
    const modules = data.modules || [];
    // either the explicit row list or the entity's raw consumables object, so a
    // caller can pass `consumables: tank.consumables` and be done
    const consumables = Array.isArray(data.consumables)
      ? data.consumables
      : buildConsumables(data.consumables) || [];
    const sig =
      kind +
      '|' +
      crew.map((c) => (c.key != null ? `${c.role}:${c.key}` : c.seat != null ? `${c.role}:${c.seat}` : c.role)).join(',') +
      '|' +
      modules.map((m) => m.key).join(',') +
      '|' +
      consumables.map((c) => c.key).join(',') +
      '|' +
      (data.name || '');
    if (sig !== this._dmgSig) {
      this._dmgSig = sig;
      this._buildDamagePanel(kind, data, crew, modules, consumables);
    }

    const d = this._dmg;
    if (!d) return;

    // hull / turret condition tints the body of the silhouette
    const hullState = this._condState(data.hull);
    const turretState = this._condState(data.turret);
    for (const el of d.hullParts) setSvgClass(el, `${el.__base} ${STATE_CLASS[hullState]}`);
    for (const el of d.turretParts) setSvgClass(el, `${el.__base} ${STATE_CLASS[turretState]}`);
    const hullFrac = typeof data.hull === 'number' ? frac01(data.hull) : null;
    if (d.hp) {
      if (hullFrac == null) {
        setShown(d.hp, false);
      } else {
        setShown(d.hp, true);
        setStyle(d.hpFill, 'width', `${Math.round(hullFrac * 100)}%`);
        setStyle(
          d.hpFill,
          'background',
          hullFrac > 0.5 ? COL.ok : hullFrac > 0.25 ? COL.damaged : COL.destroyed,
        );
      }
    }

    crew.forEach((c, i) => {
      const ref = d.crew[i];
      if (!ref || !c) return;
      const st = STATE_CLASS[c.state] || STATE_CLASS.ok;
      setSvgClass(ref.pip, `dpCrew ${st}`);
      if (ref.item.className !== `dpItem ${st}`) ref.item.className = `dpItem ${st}`;
      setText(ref.value, this._crewValue(c, d.letters));
      this._crewSwap(d, crew, i);
    });

    modules.forEach((m, i) => {
      const ref = d.modules[i];
      if (!ref) return;
      const st = STATE_CLASS[m.state] || STATE_CLASS.ok;
      for (const mark of ref.marks) setSvgClass(mark, `dpMod ${st}`);
      if (ref.item.className !== `dpItem ${st}`) ref.item.className = `dpItem ${st}`;
      const txt =
        m.text != null
          ? m.text
          : m.timer != null && m.state !== 'ok'
            ? `${Math.ceil(m.timer)}s`
            : m.state === 'destroyed'
              ? 'OUT'
              : m.state === 'damaged'
                ? 'DMG'
                : 'OK';
      setText(ref.value, txt);
    });

    consumables.forEach((c, i) => {
      const ref = d.cons[i];
      if (!ref) return;
      const n = c.count != null ? c.count : 0;
      setText(ref.value, c.text != null ? c.text : String(n));
      // an empty pocket has to read as empty at a glance, not as a small number
      setStyle(ref.el, 'opacity', n > 0 ? '1' : '0.45');
      setFlag(ref.el, 'empty', !(n > 0));
    });

    if (data.fire) {
      setShown(d.fire, true);
      setText(d.fireTime, data.fireSeconds != null ? `${Math.ceil(data.fireSeconds)}s` : '');
    } else {
      setShown(d.fire, false);
    }

    if (data.repairing) {
      setShown(d.repair, true);
      setStyle(d.repairFill, 'width', `${Math.round(clamp(data.repairFrac || 0, 0, 1) * 100)}%`);
    } else {
      setShown(d.repair, false);
    }
  }

  // The word at the right of a crew row. A row's own text always wins; a swap
  // without one counts down into the seat ("4s") or points at where the man is
  // going ("→G"); anything else reads as it always has.
  _crewValue(c, letters) {
    if (c.text != null) return String(c.text);
    if (c.state === 'moving') {
      return c.swapSeconds != null && Number.isFinite(c.swapSeconds)
        ? `${Math.max(0, Math.ceil(c.swapSeconds))}s`
        : 'SWAP';
    }
    if (c.state === 'leaving') {
      return c.swapTo != null ? `→${this._roleLetter(c.swapTo, letters)}` : 'MOVE';
    }
    return c.state === 'destroyed' ? 'OUT' : c.state === 'damaged' ? 'HURT' : 'OK';
  }

  _roleLetter(role, letters) {
    const k = String(role).toLowerCase();
    return (letters && letters[k]) || String(role).charAt(0).toUpperCase() || '?';
  }

  // Swap furniture for one crew row: a progress ring round its pip, a thin
  // progress line under its legend row, and — on the seat being filled — a
  // dashed path flowing from the donor's pip to this one. All of it is hidden
  // for every row that is not mid-swap, which is every row today.
  _crewSwap(d, crew, i) {
    const ref = d.crew[i];
    const c = crew[i];
    const moving = c.state === 'moving';
    const swapping = moving || c.state === 'leaving';
    const frac =
      swapping && typeof c.swapFrac === 'number' && Number.isFinite(c.swapFrac)
        ? clamp(c.swapFrac, 0, 1)
        : null;

    if (ref.ring) {
      if (frac == null) {
        setStyle(ref.ring, 'display', 'none');
      } else {
        setStyle(ref.ring, 'display', 'inline');
        setAttr(
          ref.ring,
          'stroke-dasharray',
          `${(frac * SWAP_RING_C).toFixed(1)} ${SWAP_RING_C.toFixed(1)}`,
        );
      }
    }

    if (ref.bar) {
      if (frac == null) {
        setStyle(ref.bar, 'display', 'none');
      } else {
        setStyle(ref.bar, 'display', 'block');
        setStyle(ref.barFill, 'width', `${Math.round(frac * 100)}%`);
      }
    }

    if (!ref.line) return;
    let from = -1;
    if (moving) {
      // the donor is named on this row, or failing that it is the row that
      // says it is leaving for this seat
      const want = c.swapFrom != null ? String(c.swapFrom).toLowerCase() : null;
      for (let j = 0; j < crew.length; j++) {
        const o = crew[j];
        const oref = d.crew[j];
        if (j === i || !o || !oref) continue;
        if (want != null) {
          if (want === oref.key || want === oref.label) {
            from = j;
            break;
          }
        } else if (o.state === 'leaving' && o.swapTo != null) {
          const to = String(o.swapTo).toLowerCase();
          if (to === ref.key || to === ref.label) {
            from = j;
            break;
          }
        }
      }
    }
    if (from < 0) {
      setStyle(ref.line, 'display', 'none');
      return;
    }
    const a = d.crew[from].pos;
    const b = ref.pos;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    // stop short of both pips so the path reads as running between them
    const inset = Math.min(len * 0.4, SWAP_RING_R + 1);
    const ux = dx / len;
    const uy = dy / len;
    setAttr(ref.line, 'x1', (a[0] + ux * inset).toFixed(1));
    setAttr(ref.line, 'y1', (a[1] + uy * inset).toFixed(1));
    setAttr(ref.line, 'x2', (b[0] - ux * inset).toFixed(1));
    setAttr(ref.line, 'y2', (b[1] - uy * inset).toFixed(1));
    setStyle(ref.line, 'display', 'inline');
  }

  _condState(v) {
    if (v == null) return 'ok';
    if (typeof v === 'string') return STATE_CLASS[v] ? v : 'ok';
    const f = frac01(v);
    return f > 0.55 ? 'ok' : f > 0.22 ? 'damaged' : 'destroyed';
  }

  _buildDamagePanel(kind, data, crew, modules, consumables = []) {
    const posTable = kind === 'plane' ? PLANE_CREW_POS : TANK_CREW_POS;
    const letters = kind === 'plane' ? PLANE_CREW_LETTER : TANK_CREW_LETTER;
    const modTable = kind === 'plane' ? PLANE_MOD_POS : TANK_MOD_POS;
    // stations the layout does not know about get parked down the spine so an
    // unusual crew list still renders something legible
    const spare = [[60, 128], [45, 128], [75, 128], [45, 60], [75, 60], [60, 46]];
    let spareIdx = 0;

    let pips = '';
    // swap paths go in first so every pip and module mark paints over them
    let swapLines = '';
    const crewMeta = [];
    crew.forEach((c) => {
      const label = String(c.role || '').toLowerCase();
      // an explicit station id places the pip; without one the label does,
      // exactly as it always has
      const key = c.key != null ? String(c.key).toLowerCase() : c.seat != null ? String(c.seat).toLowerCase() : label;
      const p = posTable[key] || posTable[label] || spare[spareIdx++ % spare.length];
      const letter = letters[key] || letters[label] || String(c.role || '?').charAt(0).toUpperCase();
      const id = `dpc${++uid}`;
      const ringId = `dpr${++uid}`;
      const lineId = `dpl${++uid}`;
      pips +=
        `<g class="dpCrew s-ok" id="${id}">` +
        `<circle cx="${p[0]}" cy="${p[1]}" r="7.6"/>` +
        `<text x="${p[0]}" y="${p[1]}" dy="0.34em">${letter}</text></g>` +
        `<circle class="dpSwapRing" id="${ringId}" cx="${p[0]}" cy="${p[1]}" r="${SWAP_RING_R}" ` +
        `transform="rotate(-90 ${p[0]} ${p[1]})" stroke-dasharray="0 ${SWAP_RING_C.toFixed(1)}" ` +
        `style="display:none;fill:none;stroke:${SWAP_COL};stroke-width:1.8"/>`;
      swapLines +=
        `<line class="dpSwapLine" id="${lineId}" x1="${p[0]}" y1="${p[1]}" x2="${p[0]}" y2="${p[1]}" ` +
        `style="display:none;stroke:${SWAP_COL};stroke-width:1.6;stroke-dasharray:4 2;` +
        'stroke-linecap:round"/>';
      crewMeta.push({ id, ringId, lineId, role: c.role || '—', k: key, lr: label, pos: p });
    });

    const modMeta = [];
    modules.forEach((m) => {
      const key = String(m.key || '').toLowerCase();
      const spots = modTable[key] || [spare[spareIdx++ % spare.length]];
      const ids = [];
      spots.forEach((p) => {
        const id = `dpm${++uid}`;
        ids.push(id);
        pips += `<rect class="dpMod s-ok" id="${id}" x="${p[0] - 6.5}" y="${p[1] - 5}" width="13" height="10" rx="2"/>`;
      });
      modMeta.push({ ids, label: m.label || m.key });
    });

    const body = kind === 'plane' ? PLANE_SILHOUETTE : TANK_SILHOUETTE;
    const art = body.replace('</svg>', `${swapLines}${pips}</svg>`);

    const legendRows = (list, cls) =>
      list
        .map(
          (r) =>
            `<div class="dpItem s-ok" data-k="${cls}"><i></i><span>${r.label || r.role}</span><b>OK</b></div>`,
        )
        .join('');
    // Crew rows carry a hidden swap-progress line along their bottom edge. It
    // is absolutely placed, so the row keeps exactly its old height and the
    // panel never jumps when a swap starts.
    const crewRows = (list) =>
      list
        .map(
          (r) =>
            '<div class="dpItem s-ok" data-k="crew">' +
            `<i></i><span>${r.role}</span><b>OK</b>` +
            '<em class="dpSwapBar" style="display:none"><u></u></em></div>',
        )
        .join('');

    // styled by style.css (#damagePanel .dpCons*)
    const consHtml = consumables.length
      ? '<div class="dpCons">' +
        consumables
          .map(
            (c) =>
              '<span class="dpConsItem">' +
              (c.hint != null ? `<em>${c.hint}</em>` : '') +
              `<i>${c.label || c.key}</i>` +
              '<b>0</b></span>',
          )
          .join('') +
        '</div>'
      : '';

    this.damagePanel.innerHTML =
      (data.name ? `<div class="dpName">${data.name}</div>` : '') +
      '<div class="dpHp"><div class="dpHpFill"></div></div>' +
      '<div class="dpBody">' +
      `<div class="dpArt">${art}</div>` +
      '<div class="dpLegend">' +
      (crewMeta.length ? `<h5>CREW</h5><div class="dpCrewList">${crewRows(crewMeta)}</div>` : '') +
      (modMeta.length ? `<h5>MODULES</h5><div class="dpModList">${legendRows(modMeta, 'mod')}</div>` : '') +
      '</div></div>' +
      consHtml +
      '<div class="dpFire hidden">FIRE<b></b></div>' +
      '<div class="dpRepair hidden"><span>REPAIRING</span><div class="dpRepBar"><div></div></div></div>';

    const svg = this.damagePanel.querySelector('.dpSvg');
    const hullParts = [...svg.querySelectorAll('.dpHull, .dpTrack')];
    const turretParts = [...svg.querySelectorAll('.dpTurret, .dpBarrel')];
    for (const el of [...hullParts, ...turretParts]) {
      el.__base = el.getAttribute('class');
    }

    const crewItems = this.damagePanel.querySelectorAll('.dpCrewList .dpItem');
    const modItems = this.damagePanel.querySelectorAll('.dpModList .dpItem');
    const consItems = this.damagePanel.querySelectorAll('.dpConsItem');

    this._dmg = {
      hullParts,
      turretParts,
      hp: this.damagePanel.querySelector('.dpHp'),
      hpFill: this.damagePanel.querySelector('.dpHpFill'),
      letters,
      crew: crewMeta.map((c, i) => {
        const bar = crewItems[i] ? crewItems[i].querySelector('.dpSwapBar') : null;
        return {
          pip: document.getElementById(c.id),
          item: crewItems[i],
          value: crewItems[i] ? crewItems[i].querySelector('b') : null,
          ring: document.getElementById(c.ringId),
          line: document.getElementById(c.lineId),
          bar,
          barFill: bar ? bar.firstChild : null,
          pos: c.pos,
          key: c.k,
          label: c.lr,
        };
      }),
      modules: modMeta.map((m, i) => ({
        marks: m.ids.map((id) => document.getElementById(id)),
        item: modItems[i],
        value: modItems[i] ? modItems[i].querySelector('b') : null,
      })),
      cons: consumables.map((c, i) => ({
        el: consItems[i],
        value: consItems[i] ? consItems[i].querySelector('b') : null,
      })),
      fire: this.damagePanel.querySelector('.dpFire'),
      fireTime: this.damagePanel.querySelector('.dpFire b'),
      repair: this.damagePanel.querySelector('.dpRepair'),
      repairFill: this.damagePanel.querySelector('.dpRepBar div'),
    };
  }

  // Adapter: turn a Tank into the damage-panel payload. The entity only tracks a
  // crew count, so the stations are knocked out from the back of the roster
  // forward — which is also roughly the order a real crew loses people.
  buildTankDamagePanel(tank) {
    if (!tank || !tank.spec) return null;
    const roster = ['Driver', 'Gunner', 'Loader', 'Commander', 'Radio', 'Machine gunner'];
    const total = tank.spec.crew || 4;
    const alive = Math.max(0, tank.crew || 0);
    const crew = [];
    for (let i = 0; i < total; i++) {
      crew.push({ role: roster[i] || `Crew ${i + 1}`, state: i < alive ? 'ok' : 'destroyed' });
    }
    const m = tank.modules || {};
    const st = (mod) => (!mod ? 'ok' : mod.ok ? 'ok' : 'destroyed');
    const timer = (mod) => (mod && !mod.ok ? mod.timer : null);
    const modules = [
      { key: 'engine', label: 'Engine', state: st(m.engine), timer: timer(m.engine) },
      { key: 'transmission', label: 'Transmission', state: st(m.transmission), timer: timer(m.transmission) },
      { key: 'tracks', label: 'Tracks', state: st(m.tracks), timer: timer(m.tracks) },
      { key: 'breech', label: 'Gun breech', state: st(m.breech), timer: timer(m.breech) },
      { key: 'ammo', label: 'Ammo rack', state: m.ammoRack && !m.ammoRack.ok ? 'damaged' : 'ok' },
      { key: 'fuel', label: 'Fuel', state: tank.burning ? 'damaged' : 'ok' },
    ];
    const repairing = modules.some((x) => x.timer != null);
    let repairFrac = 0;
    if (repairing) {
      // show the module closest to being back in action
      let best = 0;
      for (const key of ['engine', 'transmission', 'tracks', 'breech']) {
        const mod = m[key];
        if (mod && !mod.ok && mod.repair > 0) {
          best = Math.max(best, 1 - mod.timer / mod.repair);
        }
      }
      repairFrac = best;
    }
    return {
      kind: 'tank',
      name: tank.spec.name,
      hull: total > 0 ? alive / total : 1,
      turret: m.breech && !m.breech.ok ? 'damaged' : 'ok',
      crew,
      modules,
      consumables: buildConsumables(tank.consumables),
      fire: !!tank.burning,
      fireSeconds: tank.burnTimer,
      repairing,
      repairFrac,
    };
  }

  buildPlaneDamagePanel(plane) {
    if (!plane || !plane.spec) return null;
    const hp = plane.spec.hp ? clamp(plane.hp / plane.spec.hp, 0, 1) : 1;
    return {
      kind: 'plane',
      name: plane.spec.name,
      hull: hp,
      turret: plane.wingsOk ? 'ok' : 'destroyed',
      crew: [{ role: 'Pilot', state: plane.alive ? 'ok' : 'destroyed' }],
      modules: [
        { key: 'engine', label: 'Engine', state: plane.engineOk ? 'ok' : 'destroyed' },
        { key: 'wings', label: 'Wings', state: plane.wingsOk ? 'ok' : 'destroyed' },
        { key: 'fuel', label: 'Fuel', state: plane.burning ? 'damaged' : 'ok' },
        { key: 'controls', label: 'Controls', state: hp < 0.35 ? 'damaged' : 'ok' },
      ],
      // a pilot carries one bottle and burning is just as fatal up there
      consumables:
        plane.extinguishers != null
          ? [{ key: 'fpe', label: 'FPE', hint: 'F', count: plane.extinguishers }]
          : undefined,
      fire: !!plane.burning,
      fireSeconds: plane.burnTimer,
    };
  }

  // ============================================================
  // 3. AIR INSTRUMENTS (H-04 period flight instruments)
  // ============================================================
  // data: { ias, alt, vspeed, throttle, wep, wepLock, fuel, engineTemp,
  //         radiator, flaps, gear, airbrake, gload, maxG, stress, stalled,
  //         stallSpeed, mach, aoa, slip, ammo, bombs, rockets, parts,
  //         gearPos, gearHeld, gearLimit, gearOver, gearGone, onGround,
  //         wheelBrake, spec } or null.
  // Speeds are display km/h (planes.js displaySpeedKmh), angles radians,
  // everything else a 0..1 fraction. Everything is optional: a missing value
  // hides its own instrument rather than showing a zeroed one.
  //   maxG   — the airframe's rated load limit in G, already de-rated for wing
  //            damage if the caller de-rates it (the G dial's red limit tick).
  //   stress — accumulated structural fatigue, 0..1 (absent hides the row).
  //   spec   — the aircraft's spec: picks the dial units by nation (mph and
  //            feet for the US and UK, knots for the Japanese Navy, km/h and
  //            metres otherwise) and its boost gauge. Without it the dials
  //            read km/h and metres.
  // The four dials are one canvas, redrawn at most 30 times a second and only
  // when a needle would move by a visible amount; faces, scales and numerals
  // are cached and only the needles and the moving limit marks are painted.
  setAirPanel(data) {
    if (!data) {
      setShown(this.airPanel, false);
      this._airUnit = null;
      if (this.speedoHidden) {
        this.speedoHidden = false;
        setShown(this.speedo, true);
        if (!this.ammoPanelOwned) setShown(this.shellLabel, true);
      }
      return;
    }
    if (!this._air) this._buildAirPanel();
    setShown(this.airPanel, true);
    // the cluster already prints rounds, bombs and rockets, so the old
    // single-line readouts stand down while it is up
    if (!this.speedoHidden) {
      this.speedoHidden = true;
      setShown(this.speedo, false);
      setShown(this.shellLabel, false);
    }
    const a = this._air;
    const spec = data.spec || null;
    const units = dialUnits(spec && spec.nation);
    this._airUnit = units.speed;

    // ---- the digital pair the UX keeps beside the dials ----
    const iasU = data.ias != null ? data.ias / KMH_PER_UNIT[units.speed] : null;
    const altU = data.alt != null ? data.alt / M_PER_UNIT[units.alt] : null;
    setText(a.ias, iasU != null ? String(Math.round(iasU)) : '—');
    setText(a.alt, altU != null ? String(Math.round(altU)) : '—');
    setText(a.iasUnit, units.speed.toUpperCase());
    setText(a.altUnit, units.alt.toUpperCase());
    // the speed digits carry the stall warning: the digit the eye is already
    // on when the wing starts to let go
    const vStall = data.stallSpeed;
    let iasState = '';
    if (vStall > 0 && data.ias != null && !data.onGround) {
      const margin = data.ias / vStall;
      iasState = margin < 1.05 ? 'crit' : margin < 1.25 ? 'warn' : '';
    }
    setFlag(a.iasDig, 'warn', iasState === 'warn');
    setFlag(a.iasDig, 'crit', iasState === 'crit');

    const vs = data.vspeed;
    setShown(a.vsiWrap, vs != null);
    if (vs != null) {
      // the climb indicator follows the altimeter's unit: ft/min on a
      // US/UK aircraft (to 10 ft/min), m/s otherwise
      const vsFt = units.alt === 'ft';
      const mag = vsFt ? `${Math.round((Math.abs(vs) * FT_MIN_PER_MS) / 10) * 10}` : Math.abs(vs).toFixed(1);
      setText(a.vsiTxt, `${vs >= 0 ? '+' : '−'}${mag}`);
      setText(a.vsiUnit, vsFt ? 'FT/MIN' : 'M/S');
    }

    this._drawDials(data, spec, units);

    // ---- bars ----
    const thr = frac01(data.throttle);
    setShown(a.thrRow, thr != null);
    if (thr != null) {
      setStyle(a.thrFill, 'width', `${Math.round(thr * 100)}%`);
      setFlag(a.thrRow, 'wep', !!data.wep);
      setText(a.thrTxt, `${Math.round(thr * 100)}%`);
    }
    const fuel = frac01(data.fuel);
    setShown(a.fuelRow, fuel != null);
    if (fuel != null) {
      setStyle(a.fuelFill, 'width', `${Math.round(fuel * 100)}%`);
      setFlag(a.fuelRow, 'low', fuel <= 0.25);
      setText(a.fuelTxt, `${Math.round(fuel * 100)}%`);
    }
    const temp = frac01(data.engineTemp);
    setShown(a.tempRow, temp != null);
    if (temp != null) {
      setStyle(a.tempFill, 'width', `${Math.round(temp * 100)}%`);
      setFlag(a.tempRow, 'warm', temp > 0.65 && temp <= 0.85);
      setFlag(a.tempRow, 'hot', temp > 0.85);
      setText(a.tempTxt, `${Math.round(temp * 100)}%`);
    }
    // the radiator sits under TEMP because it is the lever that moves it
    const radv = frac01(data.radiator);
    setShown(a.radRow, radv != null);
    if (radv != null) {
      setStyle(a.radFill, 'width', `${Math.round(radv * 100)}%`);
      setText(a.radTxt, `${Math.round(radv * 100)}%`);
    }

    // ---- switches and lamps ----
    this._flag(a.fFlaps, data.flaps);
    if (data.gearPos == null && data.gearGone == null && data.gearHeld == null) {
      this._flag(a.fGear, data.gear);
    }
    this._flag(a.fAb, data.airbrake);
    this._flag(a.fWep, data.wep, 'hot');
    this._gearIndicator(a, data);
    // WEP has three states: available, engaged, and locked out while the
    // engine cools; the lock gets a line of its own
    setShown(a.wepLock, !!data.wepLock);

    // ---- airframe stress ----
    const stress = data.stress;
    if (stress == null || Number.isNaN(stress) || stress < STRESS_SHOW) {
      setShown(a.stressRow, false);
      setShown(a.stressWarn, false);
    } else {
      const s = clamp(stress, 0, 1);
      setShown(a.stressRow, true);
      setStyle(a.stressFill, 'width', `${Math.round(s * 100)}%`);
      setFlag(a.stressRow, 'crit', s >= STRESS_WARN);
      setText(a.stressTxt, `${Math.round(s * 100)}%`);
      setShown(a.stressWarn, s >= STRESS_SHOUT);
    }

    // ---- angle of attack, structural-speed ratio, sideslip ----
    const aoa = data.aoa;
    const slip = data.slip;
    const mach = data.mach;
    const haveAero = aoa != null || slip != null || mach != null;
    setShown(a.aeroRow, haveAero);
    if (haveAero) {
      if (aoa == null) {
        setText(a.aoaVal, '—');
        setSvgClass(a.aoaVal, 'aiAoa');
      } else {
        const d = Math.abs(aoa) * DEG;
        setText(a.aoaVal, `${aoa < -0.0005 ? '−' : ''}${d.toFixed(1)}°`);
        // a wing lets go around seventeen degrees
        setSvgClass(a.aoaVal, d > 16 ? 'aiAoa crit' : d > 12 ? 'aiAoa warn' : 'aiAoa');
      }
      if (mach == null || mach < MACH_SHOW) {
        setText(a.machVal, '');
      } else {
        setText(a.machVal, `M ${mach.toFixed(2)}`);
        setSvgClass(a.machVal, mach >= 1 ? 'aiMach crit' : 'aiMach warn');
      }
      setShown(a.slipTrack, slip != null);
      if (slip != null) {
        const b = clamp(slip / SLIP_FULL, -1, 1);
        setStyle(a.slipBall, 'left', `${((0.5 + b * 0.45) * 100).toFixed(1)}%`);
        setFlag(a.slipTrack, 'warn', Math.abs(b) > 0.34);
      }
    }

    const parts = [];
    if (data.ammo != null) parts.push(`RDS ${data.ammo}`);
    if (data.bombs) parts.push(`BOMB ${data.bombs}`);
    if (data.rockets) parts.push(`RKT ${data.rockets}`);
    if (data.parts != null && typeof data.parts !== 'object') parts.push(`PARTS ${data.parts}`);
    setText(a.stores, parts.join('  ·  '));
    setShown(a.stores, parts.length > 0);

    // a wheel on the ground is not a wing about to let go
    setShown(a.stall, !!data.stalled && !data.onGround);
  }

  // The undercarriage lamps (H-04): three per-leg lamps the way the period
  // panels had them, the state in words, the lowering speed, and the wheel
  // brake lamp while there are wheels on the ground. A thin strain bar fills
  // across the band where the aeroplane warns and then tears the legs off.
  _gearIndicator(a, data) {
    if (!a.gearRow) return;
    const g = gearLampState(data);
    setShown(a.gearRow, !!g);
    // the lamps say everything the flag did and more
    setShown(a.fGear, !g);
    if (!g) {
      setShown(a.gearStrain, false);
      setShown(a.gearBrk, false);
      return;
    }
    for (let i = 0; i < a.gearLamps.length; i++) setSvgClass(a.gearLamps[i], `aiLamp l-${g.lamp}`);
    setFlag(a.gearRow, 'blink', g.blink);
    setText(a.gearTxt, g.text);
    setSvgClass(
      a.gearTxt,
      g.crit || g.state === 'gone' ? 'aiGearTxt crit'
        : g.strained || g.held ? 'aiGearTxt warn'
          : g.state === 'move' ? 'aiGearTxt crit'
            : g.state === 'down' ? 'aiGearTxt ok' : 'aiGearTxt',
    );
    // the lowering speed, always, in the dial's own unit: the number the
    // pilot flies to on the way in; amber once he is faster than it with the
    // lever down or the legs out
    const units = dialUnits(data.spec && data.spec.nation);
    const limU = data.gearLimit > 0 ? Math.round(data.gearLimit / KMH_PER_UNIT[units.speed]) : 0;
    const lever = !!data.gear;
    const pos = Number(data.gearPos) || 0;
    const fast = data.gearLimit > 0 && data.ias != null && data.ias > data.gearLimit && (lever || pos > 0.001);
    setText(a.gearLim, limU > 0 && g.state !== 'gone' ? `<${limU}` : '');
    setSvgClass(a.gearLim, g.crit ? 'aiGearLim crit' : fast ? 'aiGearLim warn' : 'aiGearLim');
    setShown(a.gearStrain, g.strained);
    if (g.strained) {
      setStyle(a.gearStrainFill, 'width', `${Math.round(g.strain * 100)}%`);
      setFlag(a.gearStrain, 'crit', g.crit);
    }
    setShown(a.gearBrk, g.brakeShown);
    setSvgClass(a.gearBrkLamp, g.brakeOn ? 'aiLamp l-amber' : 'aiLamp l-off');
    setFlag(a.gearBrk, 'on', g.brakeOn);
  }

  _flag(el, on, extra) {
    if (!el) return;
    const cls = `aiFlag${on ? ` on${extra ? ` ${extra}` : ''}` : ''}`;
    if (el.className !== cls) el.className = cls;
  }

  // ---- the dial canvas ----
  _drawDials(data, spec, units) {
    const a = this._air;
    const cv = a.dials;
    if (!cv || !a.dialCtx) return;
    const gauge = boostGaugeFor(spec);
    const asi = ASI_SCALE[units.speed];
    // what each needle reads, in its own unit
    const vIas = data.ias != null ? data.ias / KMH_PER_UNIT[units.speed] : null;
    const vAlt = data.alt != null ? data.alt / M_PER_UNIT[units.alt] : null;
    const vBoost = data.throttle != null
      ? boostReading(gauge, frac01(data.throttle), !!data.wep, data.alt, spec && spec.critDensity, RHO0)
      : null;
    const vG = data.gload != null ? data.gload : null;
    const stallU = data.stallSpeed > 0 ? data.stallSpeed / KMH_PER_UNIT[units.speed] : null;
    const gearU = data.gearLimit > 0 ? data.gearLimit / KMH_PER_UNIT[units.speed] : null;
    const maxG = data.maxG > 0 ? data.maxG : null;
    const staticKey = `${units.speed}|${units.alt}|${gauge.unit}|${gauge.min}|${gauge.max}|${cv.width}`;
    // Redraw only for a visible change, at most every 33 ms (<= 30 Hz).
    const sig = [
      vIas != null ? Math.round(vIas * 2) : -1,
      vAlt != null ? Math.round(vAlt / 2) : -1,
      vBoost != null ? Math.round(((vBoost - gauge.min) / (gauge.max - gauge.min)) * 400) : -1,
      vG != null ? Math.round(vG * 20) : -1,
      stallU != null ? Math.round(stallU) : -1,
      gearU != null ? Math.round(gearU) : -1,
      maxG != null ? Math.round(maxG * 10) : -1,
      data.wep ? 1 : 0,
      staticKey,
    ].join(',');
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (sig === a.dialSig) return;
    if (a.dialSig && now - a.dialT < 33) return;
    a.dialSig = sig;
    a.dialT = now;
    a.dialValues = { ias: vIas, alt: vAlt, boost: vBoost, g: vG, stall: stallU, gear: gearU, maxG, units, gauge };

    const ctx = a.dialCtx;
    const dpr = a.dpr;
    if (a.staticKey !== staticKey) {
      a.staticKey = staticKey;
      a.staticCv = this._dialStatic(units, gauge, cv.width, cv.height, dpr);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (a.staticCv) ctx.drawImage(a.staticCv, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const L = DIAL_LAYOUT;
    // ASI: limit marks first (the needle passes over them), then the needle
    let cx = L.cx(0);
    if (stallU != null) this._dialMark(ctx, cx, L.cy, dialAngle(stallU, asi), COL.destroyed);
    if (gearU != null) this._dialMark(ctx, cx, L.cy, dialAngle(gearU, asi), COL.damaged);
    if (vIas != null) this._needle(ctx, cx, L.cy, dialAngle(vIas, asi), L.r * 0.84, 2.2);
    // altimeter: short needle (ALT_REV_SHORT a turn), then the long one
    cx = L.cx(1);
    if (vAlt != null) {
      const [lng, sht] = altNeedles(Math.max(0, vAlt));
      this._needle(ctx, cx, L.cy, sht, L.r * 0.5, 3.2);
      this._needle(ctx, cx, L.cy, lng, L.r * 0.84, 2);
    }
    // boost / manifold pressure: rated and WEP marks, then the needle
    cx = L.cx(2);
    const gsc = gauge;
    this._dialMark(ctx, cx, L.cy, dialAngle(gsc.rated, gsc), COL.damaged);
    this._dialMark(ctx, cx, L.cy, dialAngle(gsc.wep, gsc), COL.destroyed);
    if (vBoost != null) this._needle(ctx, cx, L.cy, dialAngle(vBoost, gsc), L.r * 0.84, 2.2);
    // accelerometer: the rated limit, then the needle and the digits
    cx = L.cx(3);
    if (maxG != null) this._dialMark(ctx, cx, L.cy, dialAngle(maxG, G_SCALE), COL.destroyed);
    if (vG != null) this._needle(ctx, cx, L.cy, dialAngle(vG, G_SCALE), L.r * 0.84, 2.2);
    // The digital G lives in the title row under the face (where the other
    // dials print their names), never inside it: at 0.52 r it printed across
    // the scale's end numerals, so 1.0 g read "−41.012".
    {
      const ty = L.cy + L.r + 13;
      ctx.textBaseline = 'alphabetic';
      if (vG == null) {
        ctx.font = cfont(10, 600);
        ctx.textAlign = 'center';
        ctx.fillStyle = INK.ivory2;
        ctx.fillText('G', cx, ty);
      } else {
        const over = maxG != null && Math.abs(vG) >= maxG;
        const warm = maxG != null ? Math.abs(vG) >= maxG * G_EASY : Math.abs(vG) > G_LEGACY_WARN;
        const num = `${vG < 0 ? '−' : ''}${Math.abs(vG).toFixed(1)}`;
        ctx.font = cfont(10, 600);
        const wT = ctx.measureText ? ctx.measureText('G ').width || 0 : 0;
        ctx.font = cfont(12, 700);
        const wN = ctx.measureText ? ctx.measureText(num).width || 0 : 0;
        const x0 = cx - (wT + wN) / 2;
        ctx.textAlign = 'left';
        ctx.font = cfont(10, 600);
        ctx.fillStyle = INK.ivory2;
        ctx.fillText('G', x0, ty);
        ctx.font = cfont(12, 700);
        ctx.fillStyle = over ? COL.critText : warm ? COL.damaged : INK.ivory;
        ctx.fillText(num, x0 + wT, ty);
        a.gText = { x: x0, y: ty, w: wT + wN, num };
      }
    }
    for (let i = 0; i < 4; i++) this._hub(ctx, L.cx(i), L.cy);
  }

  _needle(ctx, cx, cy, ang, len, w) {
    const sx = Math.sin(ang);
    const sy = -Math.cos(ang);
    ctx.lineCap = 'butt';
    // a dark core line under the ivory needle keeps it legible where it
    // crosses the ivory numerals
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = w + 2;
    ctx.beginPath();
    ctx.moveTo(cx - sx * len * 0.16, cy - sy * len * 0.16);
    ctx.lineTo(cx + sx * len, cy + sy * len);
    ctx.stroke();
    ctx.strokeStyle = INK.ivory;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(cx - sx * len * 0.16, cy - sy * len * 0.16);
    ctx.lineTo(cx + sx * len, cy + sy * len);
    ctx.stroke();
  }

  _hub(ctx, cx, cy) {
    ctx.fillStyle = '#2a2b26';
    ctx.beginPath();
    ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // a coloured wedge on the rim: a limit mark
  _dialMark(ctx, cx, cy, ang, col) {
    const r = DIAL_LAYOUT.r;
    const sx = Math.sin(ang);
    const sy = -Math.cos(ang);
    ctx.strokeStyle = col;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx + sx * r * 0.74, cy + sy * r * 0.74);
    ctx.lineTo(cx + sx * r * 0.98, cy + sy * r * 0.98);
    ctx.stroke();
  }

  // Faces, scales, numerals and titles, drawn once per unit set into an
  // offscreen canvas the per-frame draw blits.
  _dialStatic(units, gauge, W, H, dpr) {
    let cv;
    try {
      cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : document.createElement('canvas');
      cv.width = W;
      cv.height = H;
    } catch (e) {
      return null;
    }
    const ctx = cv.getContext && cv.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const L = DIAL_LAYOUT;
    const asi = ASI_SCALE[units.speed];
    const dial = (i, scale, fmt, title, unit) => {
      const cx = L.cx(i);
      this._face(ctx, cx, L.cy);
      if (scale) this._scale(ctx, cx, L.cy, scale, fmt);
      ctx.fillStyle = INK.ivory2;
      ctx.font = cfont(10, 600);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(title, cx, L.cy + L.r + 13);
      if (unit) {
        ctx.fillStyle = INK.ivory2;
        ctx.textBaseline = 'middle';
        ctx.fillText(unit, cx, L.cy + L.r * 0.24);
      }
    };
    const fmtInt = (v) => String(Math.round(v));
    dial(0, asi, (v) => (units.speed === 'km/h' ? String(Math.round(v / 100)) : fmtInt(v)), 'AIRSPEED',
      units.speed === 'km/h' ? 'KM/H ×100' : units.speed.toUpperCase());
    // altimeter: 0-9 round the face, hundreds of the unit per numeral
    const cxA = L.cx(1);
    this._face(ctx, cxA, L.cy);
    this._ring(ctx, cxA, L.cy);
    ctx.fillStyle = INK.ivory2;
    ctx.font = cfont(10, 600);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('ALTITUDE', cxA, L.cy + L.r + 13);
    ctx.textBaseline = 'middle';
    ctx.fillText(units.alt === 'ft' ? 'FT ×100' : 'M ×100', cxA, L.cy + L.r * 0.24);
    const gfmt = (v) => {
      const s = Math.abs(v) < 1e-9 ? '0' : Math.abs(v) >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
      return v < 0 ? `−${s.replace('-', '')}` : s;
    };
    dial(2, gauge, gfmt, gauge.title, gauge.unit);
    // the G dial's title row is drawn live: "G" and the digital reading
    dial(3, G_SCALE, gfmt, '', '');
    return cv;
  }

  _face(ctx, cx, cy) {
    const r = DIAL_LAYOUT.r;
    ctx.fillStyle = INK.face;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a3b35';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // the altimeter's 0-9 ring: ten numerals, fifty ticks
  _ring(ctx, cx, cy) {
    const r = DIAL_LAYOUT.r;
    ctx.strokeStyle = INK.ivory;
    for (let i = 0; i < 50; i++) {
      const ang = (i / 50) * Math.PI * 2;
      const major = i % 5 === 0;
      const sx = Math.sin(ang);
      const sy = -Math.cos(ang);
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + sx * r * (major ? 0.78 : 0.86), cy + sy * r * (major ? 0.78 : 0.86));
      ctx.lineTo(cx + sx * r * 0.95, cy + sy * r * 0.95);
      ctx.stroke();
    }
    ctx.fillStyle = INK.ivory;
    ctx.font = cfont(10, 600);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 10; i++) {
      const ang = (i / 10) * Math.PI * 2;
      ctx.fillText(String(i), cx + Math.sin(ang) * r * 0.6, cy - Math.cos(ang) * r * 0.6);
    }
  }

  _scale(ctx, cx, cy, sc, fmt) {
    const r = DIAL_LAYOUT.r;
    const n = Math.round((sc.max - sc.min) / sc.minor);
    ctx.strokeStyle = INK.ivory;
    for (let i = 0; i <= n; i++) {
      const v = sc.min + i * sc.minor;
      const ang = dialAngle(v, sc);
      const rel = (v - sc.min) / sc.major;
      const major = Math.abs(rel - Math.round(rel)) < 1e-6;
      const sx = Math.sin(ang);
      const sy = -Math.cos(ang);
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + sx * r * (major ? 0.78 : 0.86), cy + sy * r * (major ? 0.78 : 0.86));
      ctx.lineTo(cx + sx * r * 0.95, cy + sy * r * 0.95);
      ctx.stroke();
    }
    ctx.fillStyle = INK.ivory;
    ctx.font = cfont(10, 600);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const m = Math.round((sc.max - sc.min) / sc.num);
    for (let i = 0; i <= m; i++) {
      const v = sc.min + i * sc.num;
      if (v > sc.max + 1e-9) break;
      const ang = dialAngle(v, sc);
      ctx.fillText(fmt(v), cx + Math.sin(ang) * r * 0.58, cy - Math.cos(ang) * r * 0.58);
    }
  }

  _buildAirPanel() {
    const bar = (key, label) =>
      `<div class="aiRow" data-k="${key}"><label>${label}</label>` +
      '<div class="aiTrack"><div class="aiFill"></div></div><span></span></div>';
    const lamp = '<i class="aiLamp l-off"></i>';
    this.airPanel.innerHTML =
      '<canvas class="aiDials"></canvas>' +
      '<div class="aiTop">' +
      '<div class="aiRead aiIasD"><label>IAS</label><b class="aiIas">0</b><small class="aiIasU">KM/H</small></div>' +
      '<div class="aiRead"><label>ALT</label><b class="aiAlt">0</b><small class="aiAltU">M</small></div>' +
      '<div class="aiRead aiVsi"><label>V/S</label><b class="aiVsiTxt">0</b><small class="aiVsiU">M/S</small></div>' +
      '</div>' +
      // The undercarriage lamps, the brake lamp, and the switch flags
      '<div class="aiLamps">' +
      `<div class="aiGearRow hidden"><label>GEAR</label><span class="aiLampSet">${lamp}${lamp}${lamp}</span>` +
      '<b class="aiGearTxt">UP</b><em class="aiGearLim"></em></div>' +
      `<div class="aiBrk hidden">${lamp}<b>BRAKE</b></div>` +
      '</div>' +
      '<div class="aiGearStrain hidden"><div class="aiGearStrainFill"></div></div>' +
      '<div class="aiFlags">' +
      '<span class="aiFlag">FLAPS</span><span class="aiFlag">GEAR</span>' +
      '<span class="aiFlag">AB</span><span class="aiFlag">WEP</span>' +
      '</div>' +
      '<div class="aiBars">' +
      bar('thr', 'THR') +
      bar('fuel', 'FUEL') +
      bar('temp', 'TEMP') +
      bar('rad', 'RAD') +
      '</div>' +
      '<div class="aiAero"><label>AOA</label><b class="aiAoa">0.0°</b><b class="aiMach"></b>' +
      '<label class="aiSlipL">SLIP</label><div class="aiSlip"><i class="aiSlipZero"></i><i class="aiSlipBall"></i></div></div>' +
      // structural fatigue: hidden while the airframe is fresh
      '<div class="aiStress hidden"><label>AIRFRAME</label><div class="aiTrack"><div class="aiStressFill"></div></div>' +
      '<b class="aiStressTxt">0%</b></div>' +
      '<div class="aiStressWarn chipCrit hidden">UNLOAD — WING FAILING</div>' +
      '<div class="aiStores"></div>' +
      '<div class="aiWepLock chipWarn hidden">WEP LOCKED — COOLING</div>' +
      '<div class="aiStall chipCrit hidden">STALL</div>';

    const q = (s) => this.airPanel.querySelector(s);
    const rows = this.airPanel.querySelectorAll('.aiBars .aiRow');
    const flags = this.airPanel.querySelectorAll('.aiFlags .aiFlag');
    const dials = q('.aiDials');
    const dpr = Math.min(2, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    if (dials) {
      dials.width = Math.round(DIAL_LAYOUT.w * dpr);
      dials.height = Math.round(DIAL_LAYOUT.h * dpr);
      if (dials.style) {
        dials.style.width = `${DIAL_LAYOUT.w}px`;
        dials.style.height = `${DIAL_LAYOUT.h}px`;
      }
    }
    this._air = {
      dials,
      dialCtx: dials && dials.getContext ? dials.getContext('2d') : null,
      dpr,
      dialSig: '',
      dialT: 0,
      staticKey: '',
      staticCv: null,
      dialValues: null,
      ias: q('.aiIas'),
      iasDig: q('.aiIasD'),
      iasUnit: q('.aiIasU'),
      alt: q('.aiAlt'),
      altUnit: q('.aiAltU'),
      vsiWrap: q('.aiVsi'),
      vsiTxt: q('.aiVsiTxt'),
      vsiUnit: q('.aiVsiU'),
      thrRow: rows[0],
      thrFill: rows[0] && rows[0].querySelector('.aiFill'),
      thrTxt: rows[0] && rows[0].querySelector('span'),
      fuelRow: rows[1],
      fuelFill: rows[1] && rows[1].querySelector('.aiFill'),
      fuelTxt: rows[1] && rows[1].querySelector('span'),
      tempRow: rows[2],
      tempFill: rows[2] && rows[2].querySelector('.aiFill'),
      tempTxt: rows[2] && rows[2].querySelector('span'),
      radRow: rows[3],
      radFill: rows[3] && rows[3].querySelector('.aiFill'),
      radTxt: rows[3] && rows[3].querySelector('span'),
      aeroRow: q('.aiAero'),
      aoaVal: q('.aiAoa'),
      machVal: q('.aiMach'),
      slipTrack: q('.aiSlip'),
      slipBall: q('.aiSlipBall'),
      fFlaps: flags[0],
      fGear: flags[1],
      fAb: flags[2],
      fWep: flags[3],
      stressRow: q('.aiStress'),
      stressFill: q('.aiStressFill'),
      stressTxt: q('.aiStressTxt'),
      stressWarn: q('.aiStressWarn'),
      gearRow: q('.aiGearRow'),
      gearLamps: this.airPanel.querySelectorAll('.aiGearRow .aiLamp'),
      gearTxt: q('.aiGearTxt'),
      gearLim: q('.aiGearLim'),
      gearBrk: q('.aiBrk'),
      gearBrkLamp: q('.aiBrk .aiLamp'),
      gearStrain: q('.aiGearStrain'),
      gearStrainFill: q('.aiGearStrainFill'),
      stores: q('.aiStores'),
      wepLock: q('.aiWepLock'),
      stall: q('.aiStall'),
    };
  }

  // Adapter for a Plane. Fills what the flight model has; a battle file's own
  // fields (extra) win over these.
  buildPlaneAirPanel(plane, extra = null) {
    if (!plane || !plane.spec) return null;
    const data = {
      ias: displaySpeedKmh(plane.ias != null ? plane.ias : plane.speed),
      alt: Math.max(0, plane.position.y),
      vspeed: plane.dir ? plane.dir.y * plane.speed : null,
      throttle: plane.throttle,
      stalled: plane.speed < plane.spec.minSpeed * 1.05,
      ammo: plane.ammo,
      bombs: plane.bombs,
      rockets: plane.rockets,
      spec: plane.spec,
    };
    if (extra) Object.assign(data, extra);
    if (!data.spec) data.spec = plane.spec;
    // The flight model de-rates a wing that has lost a panel to just over half
    // its rated load, so the HUD de-rates with it.
    if (data.maxG == null && plane.spec.maxG > 0) {
      data.maxG = plane.wingsOk === false ? plane.spec.maxG * 0.55 : plane.spec.maxG;
    }
    if (data.stress == null && typeof plane.stress === 'number') data.stress = plane.stress;
    return data;
  }

  // Blackout / redout vignette. amount 0..1, isRedout swaps to the negative-G
  // red wash. Called every frame, so it only touches the DOM on real change.
  setBlackout(amount, isRedout = false) {
    const a = clamp(frac01(amount) || 0, 0, 1);
    if (Math.abs(a - this._blackoutAmt) > 0.008 || isRedout !== this._blackoutRed) {
      this._blackoutAmt = a;
      this._blackoutRed = isRedout;
      this.blackout.style.opacity = a.toFixed(3);
      const cls = isRedout ? 'red' : '';
      if (this.blackout.className !== cls) this.blackout.className = cls;
    }
  }

  // ============================================================
  // 4. TAKING DAMAGE
  // ============================================================
  _buildArcs() {
    if (!this.damageArcs) return;
    const svg =
      '<svg viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M76.4 34.5 A96 96 0 0 1 163.6 34.5" fill="none" stroke="currentColor" ' +
      'stroke-width="7" stroke-linecap="butt"/></svg>';
    for (let i = 0; i < 4; i++) {
      const el = document.createElement('div');
      el.className = 'dmgArc';
      el.innerHTML = svg;
      this.damageArcs.appendChild(el);
      this.arcs.push({ el, angle: 0, until: 0 });
    }
  }

  // angle is the bearing of the attacker measured from where the camera looks:
  // 0 = dead ahead, +PI/2 = the player's right, PI = behind. severity is either
  // 'light' | 'heavy' | 'critical' or a 0..1 number.
  damageDirection(angleRelativeToCameraRad, severity = 'heavy') {
    if (!this.arcs.length || angleRelativeToCameraRad == null) return;
    const deg = wrap180(angleRelativeToCameraRad * DEG);
    const now = performance.now();
    let slot = null;
    // a second hit from roughly the same side re-lights the arc that is already
    // there instead of eating another of the four slots
    for (const a of this.arcs) {
      if (a.until > now && Math.abs(wrap180(a.angle - deg)) < 26) {
        slot = a;
        break;
      }
    }
    if (!slot) {
      for (const a of this.arcs) {
        if (a.until <= now) {
          slot = a;
          break;
        }
      }
    }
    if (!slot) {
      // everything is lit: take the oldest
      slot = this.arcs.reduce((o, a) => (a.until < o.until ? a : o), this.arcs[0]);
    }
    slot.angle = deg;
    slot.until = now + 2000;
    const sev =
      typeof severity === 'number'
        ? severity > 0.66
          ? 'critical'
          : severity > 0.33
            ? 'heavy'
            : 'light'
        : severity || 'heavy';
    slot.el.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    // restart the fade: drop the class, force a reflow, put it back
    slot.el.classList.remove('live');
    void slot.el.offsetWidth;
    slot.el.className = `dmgArc sev-${sev} live`;
  }

  // A short-lived centred line for what just happened to the player's own
  // vehicle. severity: 'info' | 'warn' | 'critical' (aliases 'good' / 'bad').
  incomingMessage(text, severity = 'warn', alsoLog = false) {
    if (!text) return;
    text = this._localUnits(text);
    const sev =
      severity === 'bad' ? 'critical' : severity === 'good' ? 'info' : severity || 'warn';
    const el = document.createElement('div');
    el.className = `incRow sev-${sev}`;
    el.textContent = text;
    this.incomingMsg.appendChild(el);
    while (this.incomingMsg.children.length > 4) this.incomingMsg.firstChild.remove();
    setTimeout(() => el.remove(), 2400);
    if (alsoLog) this.addDamageLog(text, sev);
  }

  // The flight model words its limits in km/h; with the dials in mph or
  // knots (H-04) the pilot reads the same figure his airspeed needle shows.
  _localUnits(text) {
    const u = this._airUnit;
    if (!u || u === 'km/h' || typeof text !== 'string' || text.indexOf('km/h') < 0) return text;
    const k = KMH_PER_UNIT[u];
    return text.replace(/(\d+(?:\.\d+)?)\s*km\/h/g, (m, n) => `${Math.round(parseFloat(n) / k)} ${u}`);
  }

  // The persistent record: the pop-ups are gone in two seconds, this is what the
  // player reads afterwards to work out how they died.
  addDamageLog(text, kind = 'info') {
    if (!text) return;
    text = this._localUnits(text);
    const row = document.createElement('div');
    row.className = `dlRow dl-${kind}`;
    row.textContent = text;
    this.damageLog.prepend(row);
    while (this.damageLog.children.length > 8) this.damageLog.lastChild.remove();
  }

  clearDamageLog() {
    if (this.damageLog) this.damageLog.innerHTML = '';
  }

  // ============================================================
  // 5. AWARDS AND REWARDS
  // ============================================================
  showAward(title, subtitle = '') {
    if (!title) return;
    if (this._awardQueue.length > 3) this._awardQueue.shift();
    this._awardQueue.push({ title, subtitle });
    if (!this._awardTimer) this._nextAward();
  }

  _nextAward() {
    const next = this._awardQueue.shift();
    if (!next) {
      this._awardTimer = null;
      this.awardBanner.classList.add('hidden');
      return;
    }
    const t = this.awardBanner.querySelector('.awTitle');
    const s = this.awardBanner.querySelector('.awSub');
    t.textContent = next.title;
    s.textContent = next.subtitle || '';
    s.classList.toggle('hidden', !next.subtitle);
    this.awardBanner.classList.remove('hidden', 'live');
    void this.awardBanner.offsetWidth;
    this.awardBanner.classList.add('live');
    this._awardTimer = setTimeout(() => {
      this._awardTimer = null;
      this._nextAward();
    }, 2300);
  }

  // "+320 SL" floating up beside the crosshair — earning has to be visible in
  // the fight, not only on the results screen.
  showReward(amount, currency = 'SL') {
    if (!amount) return;
    const el = document.createElement('div');
    const positive = amount > 0;
    el.className = `rwPop${positive ? '' : ' neg'}${currency === 'RP' ? ' rp' : ''}`;
    el.textContent = `${positive ? '+' : '−'}${Math.abs(Math.round(amount))} ${currency}`;
    // small horizontal scatter so a burst of rewards does not stack into a blur
    el.style.marginLeft = `${(Math.random() - 0.5) * 44}px`;
    this.rewardPops.appendChild(el);
    while (this.rewardPops.children.length > 6) this.rewardPops.firstChild.remove();
    setTimeout(() => el.remove(), 1600);
  }

  // ============================================================
  // 6. TOP BAR
  // ============================================================
  // info: { timeLeft (seconds), mode, objective } — any subset, or null to hide.
  setMatchInfo(info) {
    if (!info) {
      setShown(this.matchTop, false);
      setShown(this.matchObjective, false);
      return;
    }
    let showTop = false;
    if (info.timeLeft != null) {
      const t = Math.max(0, Math.floor(info.timeLeft));
      const mm = Math.floor(t / 60);
      const ss = t % 60;
      setText(this.matchTimer, `${mm}:${ss < 10 ? '0' : ''}${ss}`);
      const cls = t <= 20 ? 'urgent' : t <= 60 ? 'low' : '';
      if (this.matchTimer.className !== cls) this.matchTimer.className = cls;
      showTop = true;
    }
    if (info.mode != null) {
      setText(this.matchMode, info.mode);
      showTop = true;
    }
    if (showTop) setShown(this.matchTop, true);
    if (info.objective !== undefined) {
      setText(this.matchObjective, info.objective || '');
      setShown(this.matchObjective, !!info.objective);
    }
  }

  // ============================================================
  // 7. COMPASS
  // ============================================================
  // yawRad is the player's hull/nose yaw straight out of the entity. markers is
  // an optional list of bearings to pip: { bearing (rad) | deg, label, color }.
  // Pass null to hide the tape.
  setCompass(yawRad, markers = null) {
    if (yawRad == null || !this.compassCtx) {
      if (this._compassShown) {
        this._compassShown = false;
        this._compassHeading = null;
        setShown(this.compassWrap, false);
      }
      return;
    }
    if (!this._compassShown) {
      this._compassShown = true;
      setShown(this.compassWrap, true);
    }
    const heading = yawToHeading(yawRad);
    // The tape is a picture of the heading and the pips on it. If neither moved
    // there is nothing to repaint.
    const sig = markerSig(markers);
    if (
      this._compassHeading != null &&
      sig === this._compassSig &&
      Math.abs(heading - this._compassHeading) < 0.35
    ) {
      return;
    }
    this._compassSig = sig;
    const ctx = this.compassCtx;
    const W = this.compass.width / 2;
    const H = this.compass.height / 2;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const half = 70; // degrees visible either side of the nose
    const pxPerDeg = W / (half * 2);
    const cx = W / 2;
    const base = H - 1; // the tape's baseline, ticks grow upward from here

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const first = Math.ceil((heading - half) / 5) * 5;
    const last = heading + half;

    ctx.beginPath();
    for (let a = first; a <= last; a += 5) {
      const norm = wrap360(a);
      if (norm % 90 === 0) continue;
      const x = cx + (a - heading) * pxPerDeg;
      ctx.moveTo(x, base);
      ctx.lineTo(x, base - (norm % 30 === 0 ? 6 : 3));
    }
    ctx.strokeStyle = INK.ivory3;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    for (let a = first; a <= last; a += 5) {
      if (wrap360(a) % 90 !== 0) continue;
      const x = cx + (a - heading) * pxPerDeg;
      ctx.moveTo(x, base);
      ctx.lineTo(x, base - 8);
    }
    ctx.strokeStyle = INK.ivory;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.font = cfont(10, 600);
    ctx.fillStyle = INK.ivory2;
    for (let a = first; a <= last; a += 5) {
      const norm = wrap360(a);
      if (norm % 30 !== 0 || norm % 90 === 0) continue;
      ctx.fillText(String(norm).padStart(3, '0'), cx + (a - heading) * pxPerDeg, 21);
    }

    ctx.font = cfont(12, 700);
    for (let a = first; a <= last; a += 5) {
      const norm = wrap360(a);
      if (norm % 90 !== 0) continue;
      ctx.fillStyle = INK.ivory;
      ctx.fillText('NESW'[norm / 90], cx + (a - heading) * pxPerDeg, 21);
    }

    if (markers) {
      for (const m of markers) {
        if (!m) continue;
        const mh =
          m.deg != null ? wrap360(m.deg) : m.bearing != null ? yawToHeading(m.bearing) : null;
        if (mh == null) continue;
        const d = wrap180(mh - heading);
        if (Math.abs(d) > half) continue;
        const x = cx + d * pxPerDeg;
        const col = mapColor(m.color);
        const team = col === COL.ally ? 0 : col === COL.enemy ? 1 : -1;
        if (m.label) {
          // a slab behind the pip label keeps it readable over the degree row
          ctx.fillStyle = 'rgba(14,15,12,0.92)';
          ctx.fillRect(x - 10, 14, 20, 15);
          ctx.fillStyle = col;
          ctx.font = cfont(11, 700);
          ctx.fillText(m.label, x, 21.5);
        }
        // H-06: the pip's shape says whose it is, the colour confirms it
        this._glyph(ctx, x, base - 5, team, 4.6, col);
      }
    }

    // the index: current heading, boxed, dead centre
    const txt = String(Math.round(heading) % 360).padStart(3, '0');
    ctx.fillStyle = 'rgba(14,15,12,0.95)';
    ctx.fillRect(cx - 19, 0, 38, 15);
    ctx.strokeStyle = INK.hair;
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - 18.5, 0.5, 37, 14);
    ctx.fillStyle = COL.player;
    ctx.font = cfont(11, 700);
    ctx.fillText(txt, cx, 8);
    ctx.beginPath();
    ctx.moveTo(cx, base);
    ctx.lineTo(cx - 5, base - 8);
    ctx.lineTo(cx + 5, base - 8);
    ctx.closePath();
    ctx.fillStyle = COL.player;
    ctx.fill();
    this._compassHeading = heading;
  }

  // H-06 team glyphs for every canvas the HUD paints: ally a circle, enemy a
  // diamond, neutral an open down-triangle; dark rim so they hold on any map
  // colour. `s` is the half-size in px.
  _glyph(ctx, x, y, team, s, col) {
    ctx.beginPath();
    if (team === 0) {
      ctx.arc(x, y, s * 0.92, 0, Math.PI * 2);
    } else if (team === 1) {
      ctx.moveTo(x, y - s * 1.15);
      ctx.lineTo(x + s * 1.15, y);
      ctx.lineTo(x, y + s * 1.15);
      ctx.lineTo(x - s * 1.15, y);
      ctx.closePath();
    } else {
      ctx.moveTo(x - s, y - s * 0.7);
      ctx.lineTo(x + s, y - s * 0.7);
      ctx.lineTo(x, y + s);
      ctx.closePath();
    }
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    if (team === -1) {
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = col;
      ctx.stroke();
      return;
    }
    ctx.fillStyle = col;
    ctx.fill();
    ctx.stroke();
  }

  // ---- world-space markers (H-06) ----
  // Called for every unit, every capture zone and every lead circle, every
  // frame — roughly half of them hidden. Each write is guarded, so a marker
  // that has not moved and a marker that is already hidden both cost nothing.
  // The battles still send the old "<span class="arrow">▼</span>123m" text;
  // the arrow glyph is replaced here by a drawn shape that carries the team
  // on its own (ally: upward chevron, enemy: diamond), 12 px whatever the
  // distance, and the label is ivory with the 1 px outline (H-11).
  setMarker(id, cls, screenX, screenY, text, visible) {
    let el = this.markers.get(id);
    if (!el) {
      if (!visible) return;
      el = document.createElement('div');
      el.__vis = null;
      el.__cls = null;
      el.__mt = null;
      this.markersRoot.appendChild(el);
      this.markers.set(id, el);
    }
    if (!visible) {
      if (el.__vis !== false) {
        el.__vis = false;
        el.style.display = 'none';
      }
      return;
    }
    if (el.__vis !== true) {
      el.__vis = true;
      el.style.display = 'block';
    }
    const full = `marker ${cls}`;
    if (el.__cls !== full) {
      el.__cls = full;
      el.className = full;
      el.__mt = null; // the shape depends on the class: rebuild the text
    }
    // whole pixels: a label has no business sitting on a half-pixel
    setStyle(el, 'left', `${Math.round(screenX)}px`);
    setStyle(el, 'top', `${Math.round(screenY)}px`);
    this._markerText(el, text);
  }

  _markerText(el, text) {
    const t = text == null ? '' : text;
    if (el.__mt === t) return;
    el.__mt = t;
    if (t.startsWith(ARROW_OPEN)) {
      const end = t.indexOf(ARROW_CLOSE, ARROW_OPEN.length);
      if (end > 0) {
        const glyph = t.slice(ARROW_OPEN.length, end);
        const cls = el.__cls || '';
        const team = /\bally\b/.test(cls) ? 'ally' : /\benemy\b/.test(cls) ? 'enemy' : '';
        const kind = glyph === '◈' ? 'scout' : glyph === '◆' ? 'target' : 'unit';
        const shapeKey = `${team}|${kind}`;
        if (!el.__arrow) {
          el.innerHTML = '<span class="arrow mkShape"></span><span class="mkTxt"></span>';
          el.__arrow = el.firstChild;
          el.__tail = el.lastChild;
          el.__shape = null;
        }
        if (el.__shape !== shapeKey) {
          el.__shape = shapeKey;
          el.__arrow.innerHTML = markerShapeSvg(team, kind, glyph);
        }
        setText(el.__tail, t.slice(end + ARROW_CLOSE.length));
        return;
      }
    }
    el.__arrow = null;
    el.__tail = null;
    el.__shape = null;
    el.innerHTML = t;
  }

  clearMarkers() {
    this.markersRoot.innerHTML = '';
    this.markers.clear();
  }

  // ============================================================
  // 8. MINIMAP (H-06: a paper map inside the dark instrument frame)
  // ============================================================
  setMinimapZoom(z) {
    this.minimapZoom = clamp(z || 1, 1, 4);
  }

  setBigMap(visible) {
    this.bigMapVisible = !!visible;
    setShown(this.bigMap, this.bigMapVisible);
  }

  toggleBigMap() {
    this.setBigMap(!this.bigMapVisible);
    return this.bigMapVisible;
  }

  // The original five arguments behave exactly as before. `opts` adds the rest:
  // { zones: [{x,z,r,owner,progress,label}], viewCone: {yaw,fov},
  //   spawns: [{x,z,team,r}], bounds: {minX,maxX,minZ,maxZ}, zoom, title }
  // worldSize (metres across) sets the canvas scale: the whole world fits the
  // canvas at zoom 1. zoom (>= 1, up to 4) magnifies the small minimap around
  // the player; the big map always shows the whole world.
  drawMinimap(units, player, capOwner, showCap = true, worldSize = WORLD_SIZE, opts = null) {
    const ws = worldSize > 0 ? worldSize : WORLD_SIZE;
    this._mapBackgroundStep(ws);
    this._drawMap(this.mmCtx, this.minimap.width, units, player, capOwner, showCap, ws, opts, false);
    if (this.bigMapVisible && this.bigMapCtx) {
      this._drawMap(
        this.bigMapCtx,
        this.bigMapCanvas.width,
        units,
        player,
        capOwner,
        showCap,
        ws,
        opts,
        true,
      );
      if (opts && opts.title) setText(this.bigMapTitle, opts.title);
    }
  }

  // The paper-map relief (bible 7.5): the preset's ground albedo at x0.8 with
  // a hillshade, roads #b9a27a, the treeline #4d5a3a, the village in stone,
  // a 1 px grid at 20 % ink. Built once per battle (a new terrain layout or a
  // new preset is a new map) a few rows a frame, so the first frame of a
  // battle is never the one that pays for it.
  _mapBackgroundStep(worldSize) {
    let feat = null;
    let preset = null;
    try {
      feat = terrainFeatures();
      preset = activePreset();
    } catch (e) {
      return;
    }
    const N = MAP_BG_RES;
    let b = this._mapBg;
    if (!b || b.feat !== feat || b.preset !== preset || b.ws !== worldSize) {
      let cv = null;
      try {
        cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(N, N) : document.createElement('canvas');
        cv.width = N;
        cv.height = N;
      } catch (e) {
        cv = null;
      }
      const ctx = cv && cv.getContext ? cv.getContext('2d') : null;
      b = this._mapBg = {
        feat, preset, ws: worldSize, cv, ctx, row: 0, shadeRow: 0, done: false,
        img: ctx && ctx.createImageData ? ctx.createImageData(N, N) : null,
        heights: new Float32Array((N + 1) * (N + 1)),
        hMin: Infinity, hMax: -Infinity,
      };
    }
    if (b.done || !b.ctx || !b.img) return;
    const ws = b.ws;
    const cell = ws / N;
    // pass 1: heights on the cell corners, MAP_BG_ROWS rows a frame
    if (b.row <= N) {
      const end = Math.min(N, b.row + MAP_BG_ROWS - 1);
      for (let j = b.row; j <= end; j++) {
        for (let i = 0; i <= N; i++) {
          let h = 0;
          try {
            h = terrainHeight(-ws / 2 + i * cell, -ws / 2 + j * cell);
          } catch (e) {
            h = 0;
          }
          if (!Number.isFinite(h)) h = 0;
          b.heights[j * (N + 1) + i] = h;
          if (h < b.hMin) b.hMin = h;
          if (h > b.hMax) b.hMax = h;
        }
      }
      b.row = end + 1;
      return;
    }
    // pass 2: hillshade in one go (pure arithmetic, well under a millisecond)
    const pal = mapPalette(b.preset);
    const hAt = (i, j) => b.heights[j * (N + 1) + i];
    const span = Math.max(1, b.hMax - b.hMin);
    const data = b.img.data;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const h00 = hAt(i, j);
        const dx = (hAt(i + 1, j) - h00) / cell;
        const dz = (hAt(i, j + 1) - h00) / cell;
        // a low light from the north-west: relief reads at a glance
        const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
        const lit = (dx * 0.55 + 0.62 + dz * 0.55) * inv;
        const shade = clamp(0.6 + 0.55 * lit, 0.55, 1.12);
        const slope = Math.sqrt(dx * dx + dz * dz);
        const t = clamp((h00 - b.hMin) / span, 0, 1);
        const base = slope > 0.36 ? pal.rock : mixRgb(pal.low, pal.high, t);
        const o = (j * N + i) * 4;
        data[o] = clamp(base[0] * shade, 0, 255);
        data[o + 1] = clamp(base[1] * shade, 0, 255);
        data[o + 2] = clamp(base[2] * shade, 0, 255);
        data[o + 3] = 255;
      }
    }
    const ctx = b.ctx;
    ctx.putImageData(b.img, 0, 0);
    // the line work on top
    const s = N / ws;
    const px = (x) => (x + ws / 2) * s;
    const line = (pts, col, w) => {
      ctx.strokeStyle = col;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = w;
      ctx.beginPath();
      pts.forEach((p, k) => (k ? ctx.lineTo(px(p.x), px(p.z)) : ctx.moveTo(px(p.x), px(p.z))));
      ctx.stroke();
    };
    if (feat && feat.treeline && feat.treeline.path && feat.treeline.path.length > 1) {
      line(feat.treeline.path, '#4d5a3a', Math.max(2, (feat.treeline.width || 30) * s));
    }
    if (feat && feat.town) {
      ctx.fillStyle = 'rgba(154,149,133,0.6)';
      ctx.beginPath();
      ctx.arc(px(feat.town.x), px(feat.town.z), Math.max(2, (feat.town.radius || 40) * s * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }
    if (feat && feat.road && feat.road.length > 1) {
      line(feat.road, '#b9a27a', Math.max(1.2, (feat.roadWidth || 4) * 2 * s));
    }
    b.done = true;
  }

  _drawMap(ctx, S, units, player, capOwner, showCap, worldSize, opts, big) {
    const zoomReq = opts && opts.zoom != null ? opts.zoom : this.minimapZoom;
    const zoom = big ? 1 : clamp(zoomReq || 1, 1, 4);
    const scale = (S / worldSize) * zoom;
    let ox = 0;
    let oz = 0;
    if (zoom > 1.001 && player && player.position) {
      // keep the window inside the world so the map never shows empty margin
      const lim = (worldSize / 2) * (1 - 1 / zoom);
      ox = clamp(player.position.x, -lim, lim);
      oz = clamp(player.position.z, -lim, lim);
    }
    const mx = (x) => S / 2 + (x - ox) * scale;
    const my = (z) => S / 2 + (z - oz) * scale;
    const us = big ? 1.8 : 1;

    ctx.setLineDash([]);
    ctx.clearRect(0, 0, S, S);
    // ---- the paper map, or the dark glass until it has been drawn ----
    const bg = this._mapBg;
    if (bg && bg.done && bg.cv && bg.ws === worldSize) {
      const N = MAP_BG_RES;
      ctx.imageSmoothingEnabled = true;
      // the background spans the whole world: place it with the same
      // transform as everything else on the map
      ctx.drawImage(bg.cv, 0, 0, N, N, mx(-worldSize / 2), my(-worldSize / 2), worldSize * scale, worldSize * scale);
    } else {
      ctx.fillStyle = 'rgb(14,15,12)';
      ctx.fillRect(0, 0, S, S);
    }
    // grid, 1 px at 20 % ink
    const step = worldSize > 1200 ? 400 : 200;
    ctx.strokeStyle = 'rgba(36,36,42,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let w = -worldSize / 2; w <= worldSize / 2 + 0.5; w += step) {
      const gx = Math.round(mx(w)) + 0.5;
      const gy = Math.round(my(w)) + 0.5;
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, S);
      ctx.moveTo(0, gy);
      ctx.lineTo(S, gy);
    }
    ctx.stroke();

    // ---- playable area ----
    if (opts && opts.bounds) this._drawBounds(ctx, S, opts.bounds, mx, my, big);

    // ---- spawn areas ----
    if (opts && opts.spawns) {
      for (const sp of opts.spawns) {
        if (!sp) continue;
        const r = Math.max(6, (sp.r || 60) * scale);
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.arc(mx(sp.x), my(sp.z), r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = sp.team === 0 ? COL.ally : COL.enemy;
        ctx.stroke();
        ctx.restore();
      }
    }

    // ---- capture zones ----
    if (opts && opts.zones && opts.zones.length) {
      for (const z of opts.zones) {
        if (!z) continue;
        const cx = mx(z.x);
        const cy = my(z.z);
        const r = Math.max(6, (z.r || 22) * scale);
        const owner = z.owner == null ? -1 : z.owner;
        const base = owner === 0 ? COL.ally : owner === 1 ? COL.enemy : COL.neutral;
        ctx.save();
        ctx.lineWidth = 3.4;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = base;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        // capture progress rides the outside of the ring, in the colour of
        // whoever is taking it
        const prog = z.progress || 0;
        if (Math.abs(prog) > 0.005) {
          const frac = clamp(Math.abs(prog) > 1.0001 ? Math.abs(prog) / 100 : Math.abs(prog), 0, 1);
          ctx.strokeStyle = prog < 0 ? COL.ally : owner === 0 ? COL.enemy : COL.neutral;
          ctx.lineWidth = 2.6;
          ctx.beginPath();
          ctx.arc(cx, cy, r + 2.5, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
          ctx.stroke();
        }
        if (z.label) this._mapText(ctx, z.label, cx, cy, Math.round(10 * us), base, 'center');
        ctx.restore();
      }
    } else if (showCap) {
      const cx = mx(0);
      const cy = my(0);
      const col = capOwner === 0 ? COL.ally : capOwner === 1 ? COL.enemy : COL.neutral;
      ctx.beginPath();
      ctx.arc(cx, cy, 22 * scale + 4, 0, Math.PI * 2);
      ctx.lineWidth = 3.4;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = col;
      ctx.stroke();
      this._mapText(ctx, 'A', cx, cy, Math.round(10 * us), col, 'center');
    }

    // ---- player view cone: a brass wedge outline, no gradient ----
    if (opts && opts.viewCone && player && player.position) {
      const vc = opts.viewCone;
      const fov = vc.fov || 1.05;
      const len = Math.max(18, (vc.range || 220) * scale);
      const px = mx(player.position.x);
      const py = my(player.position.z);
      // canvas angles run clockwise from +X; the world yaw runs from +Z, which
      // is straight down the canvas, hence the quarter-turn offset
      const a0 = Math.PI / 2 - vc.yaw - fov / 2;
      const a1 = Math.PI / 2 - vc.yaw + fov / 2;
      ctx.save();
      ctx.fillStyle = 'rgba(255,217,94,0.16)';
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.arc(px, py, len, a0, a1);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,217,94,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    // ---- units: the shape carries the team, the colour confirms it ----
    for (const t of units) {
      if (!t || !t.alive) continue;
      const x = mx(t.position.x);
      const y = my(t.position.z);
      if (x < -12 || y < -12 || x > S + 12 || y > S + 12) continue;
      if (t === player) continue; // drawn last so it is never buried
      const col = t.team === 0 ? COL.ally : COL.enemy;
      if (t.isAircraft) {
        // an aircraft points along its heading: ally an open chevron,
        // enemy a filled dart
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI - t.yaw);
        ctx.beginPath();
        if (t.team === 0) {
          ctx.moveTo(-3.6 * us, 3.6 * us);
          ctx.lineTo(0, -4.4 * us);
          ctx.lineTo(3.6 * us, 3.6 * us);
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.stroke();
          ctx.lineWidth = 2;
          ctx.strokeStyle = col;
          ctx.stroke();
        } else {
          ctx.moveTo(0, -5 * us);
          ctx.lineTo(3.2 * us, 0);
          ctx.lineTo(0, 5 * us);
          ctx.lineTo(-3.2 * us, 0);
          ctx.closePath();
          ctx.fillStyle = col;
          ctx.fill();
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.stroke();
        }
        ctx.restore();
      } else {
        this._glyph(ctx, x, y, t.team === 0 ? 0 : 1, 3.6 * us, col);
      }
      if (big && t.displayName) {
        this._mapText(ctx, t.displayName, x + 8, y, 11, INK.ivory, 'left');
      }
    }

    // ---- the player on top: a brass arrow ----
    if (player && player.alive && player.position) {
      const x = mx(player.position.x);
      const y = my(player.position.z);
      ctx.save();
      ctx.translate(x, y);
      // the hull points along (sin yaw, cos yaw) in world space, which is
      // (right, down) on the canvas — so the marker turns by PI - yaw
      ctx.rotate(Math.PI - player.yaw);
      ctx.beginPath();
      ctx.moveTo(0, -6 * us);
      ctx.lineTo(4.2 * us, 4.6 * us);
      ctx.lineTo(0, 2.4 * us);
      ctx.lineTo(-4.2 * us, 4.6 * us);
      ctx.closePath();
      ctx.fillStyle = COL.player;
      ctx.fill();
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.stroke();
      ctx.restore();
    }

    if (big) {
      // scale bar and the north index
      const bar = 200 * scale;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 3.5;
      const sbar = () => {
        ctx.beginPath();
        ctx.moveTo(16, S - 18);
        ctx.lineTo(16 + bar, S - 18);
        ctx.moveTo(16, S - 22);
        ctx.lineTo(16, S - 14);
        ctx.moveTo(16 + bar, S - 22);
        ctx.lineTo(16 + bar, S - 14);
        ctx.stroke();
      };
      sbar();
      ctx.strokeStyle = INK.ivory;
      ctx.lineWidth = 1.5;
      sbar();
      this._mapText(ctx, '200 m', 20, S - 30, 11, INK.ivory, 'left');
      this._mapText(ctx, 'N', S / 2, 14, 14, INK.ivory, 'center');
    }
  }

  // free-floating map text: ivory (or a team colour) with the 1 px outline
  _mapText(ctx, txt, x, y, px, col, align) {
    ctx.font = cfont(px, 700);
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = col;
    ctx.fillText(txt, x, y);
  }

  // The playable ground rectangle: a red wash over everything outside it and a
  // dashed red line along the edge itself.
  _drawBounds(ctx, S, b, mx, my, big) {
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    if (!b || !num(b.minX) || !num(b.maxX) || !num(b.minZ) || !num(b.maxZ)) return;
    const xa = mx(b.minX);
    const xb = mx(b.maxX);
    const ya = my(b.minZ);
    const yb = my(b.maxZ);
    const x0 = Math.min(xa, xb);
    const x1 = Math.max(xa, xb);
    const y0 = Math.min(ya, yb);
    const y1 = Math.max(ya, yb);
    const w = x1 - x0;
    const h = y1 - y0;
    ctx.save();
    ctx.fillStyle = PEN_RED_WASH;
    ctx.beginPath();
    ctx.rect(0, 0, S, S);
    ctx.rect(x0, y0, w, h);
    ctx.fill('evenodd');
    ctx.setLineDash(big ? [8, 5] : [5, 3]);
    ctx.strokeStyle = COL.destroyed;
    ctx.lineWidth = big ? 2 : 1.4;
    ctx.strokeRect(x0, y0, w, h);
    ctx.setLineDash([]);
    if (big && w > 120 && y0 > 30 && y0 < S) {
      this._mapText(ctx, 'BATTLE AREA LIMIT', Math.max(4, x0 + 4), y0 - 9, 11, COL.critText, 'left');
    }
    ctx.restore();
  }

  // ============================================================
  // 9. OUT-OF-BOUNDS WARNING
  // ============================================================
  // level 0..1: how hard to warn that the player is at the edge of the playable
  // area — a red frame round the screen whose strength follows the level, and
  // a banner under the top bar with a bar showing how close the edge is. From
  // 0.85 up the banner goes red and blinks. 0, null or NaN hides it. Called
  // every frame, so the DOM is only touched when the level visibly changes.
  setBoundaryWarning(level) {
    const n = level == null ? 0 : Number(level);
    const q = Number.isFinite(n) ? Math.round(clamp(n, 0, 1) * 100) / 100 : 0;
    if (q === this._boundLvl) return;
    this._boundLvl = q;
    if (q <= 0) {
      if (this._boundEl) setShown(this._boundEl, false);
      return;
    }
    const el = this._ensureBoundaryWarn();
    if (!el) return;
    setShown(el, true);
    setFlag(el, 'crit', q >= 0.85);
    setStyle(this._boundEdge, 'opacity', (0.2 + 0.8 * q).toFixed(2));
    setStyle(this._boundBanner, 'opacity', (0.65 + 0.35 * q).toFixed(2));
    setStyle(this._boundFill, 'width', `${Math.round(q * 100)}%`);
  }

  // Built here rather than in index.html, like the spawn chip: the markup
  // belongs to another file and this widget must be able to appear without it.
  _ensureBoundaryWarn() {
    if (this._boundEl) return this._boundEl;
    if (typeof document === 'undefined' || !this.root) return null;
    const el = document.createElement('div');
    // styled by style.css (#boundaryWarn): a hard red frame, no glow (H-12)
    el.id = 'boundaryWarn';
    el.className = 'hidden';
    const edge = document.createElement('div');
    edge.className = 'bwEdge';
    const banner = document.createElement('div');
    banner.className = 'bwBanner';
    const title = document.createElement('div');
    title.className = 'bwTitle';
    title.textContent = 'LEAVING THE BATTLE AREA';
    const sub = document.createElement('div');
    sub.className = 'bwSub';
    sub.textContent = 'TURN BACK';
    const track = document.createElement('div');
    track.className = 'bwTrack';
    const fill = document.createElement('div');
    fill.className = 'bwFill';
    track.appendChild(fill);
    banner.appendChild(title);
    banner.appendChild(sub);
    banner.appendChild(track);
    el.appendChild(edge);
    el.appendChild(banner);
    this.root.appendChild(el);
    this._boundEl = el;
    this._boundEdge = edge;
    this._boundBanner = banner;
    this._boundFill = fill;
    return el;
  }
}
