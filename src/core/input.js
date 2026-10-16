// Keyboard + mouse state. Mouse deltas only accumulate while pointer-locked.
//
// Rebinding (settings lane, wave 4) is a PHYSICAL -> LOGICAL remap layer. The
// game asks for logical codes, and a logical code is the key's DEFAULT
// physical code: input.down('KeyW') is "the drive-forward / pitch-down key",
// whatever the player has put it on. The two mouse buttons the game reads are
// logical codes too — 'Mouse0' (fire, input.fireHeld) and 'Mouse2' (aim zoom,
// input.rightDown) — so fire and zoom can live on a key or on another button.
// With no bindings changed every physical code resolves to itself and the
// layer is the identity: nothing the game sees differs from before.
//
// Sensitivity: input.mouseDX / mouseDY are getters over the raw sums, times a
// per-context multiplier (tank aim / tank optics / aircraft aim / aircraft
// zoom) and an optional Y inversion. Every multiplier defaults to exactly 1 and
// the raw sum is returned untouched then. The context is read from the battle
// the shell hands setAimProbe() (main.js applySettings).

// ---------------------------------------------------------------------------
// the action table: every key and button the game reads, by vehicle class
// ---------------------------------------------------------------------------
// `tank`, `air`, `common`: what the logical code does there. A code that both
// classes read is one binding (the remap is global), listed under both.
export const ACTIONS = [
  { code: 'KeyW', tank: 'Drive forward', air: 'Pitch down (nose down)' },
  { code: 'KeyS', tank: 'Reverse / brake', air: 'Pitch up (nose up)' },
  { code: 'KeyA', tank: 'Steer left', air: 'Roll left' },
  { code: 'KeyD', tank: 'Steer right', air: 'Roll right' },
  { code: 'Mouse0', tank: 'Fire main gun', air: 'Fire guns' },
  { code: 'Space', tank: 'Machine gun', air: 'Drop bomb' },
  { code: 'ShiftLeft', tank: 'Sniper view (toggle)', air: 'Throttle up' },
  { code: 'ControlLeft', air: 'Throttle down' },
  { code: 'Digit1', tank: 'AP shell' },
  { code: 'Digit2', tank: 'HE shell' },
  { code: 'Digit3', tank: 'Special shell' },
  { code: 'KeyR', tank: 'Repair (hold)', air: 'WEP on / off' },
  { code: 'KeyF', tank: 'Fire extinguisher', air: 'Fire rocket' },
  { code: 'KeyG', tank: 'Smoke grenade', air: 'Landing gear' },
  { code: 'KeyH', tank: 'First aid' },
  { code: 'KeyV', tank: 'Scout target', air: 'Flaps' },
  { code: 'KeyT', tank: 'Call artillery' },
  { code: 'KeyJ', tank: 'Abandon vehicle (hold)', air: 'Bail out (hold)' },
  { code: 'KeyQ', air: 'Rudder left' },
  { code: 'KeyE', air: 'Rudder right' },
  { code: 'KeyB', air: 'Airbrake / wheel brakes' },
  { code: 'KeyX', air: 'Fire extinguisher' },
  { code: 'KeyC', air: 'Radiator auto / manual (open, combined arms)' },
  { code: 'KeyZ', air: 'Radiator close (combined arms)' },
  { code: 'BracketLeft', air: 'Radiator close (manual)' },
  { code: 'BracketRight', air: 'Radiator open (manual)' },
  { code: 'Mouse2', air: 'Aim zoom (hold)' },
  { code: 'KeyP', air: 'Cockpit / chase view' },
  { code: 'KeyM', common: 'Tactical map' },
  { code: 'Tab', common: 'Scoreboard (hold)' },
];

export const GROUPS = [
  { id: 'tank', title: 'TANK' },
  { id: 'air', title: 'AIRCRAFT' },
  { id: 'common', title: 'COMMON' },
];

const LOGICAL = new Set(ACTIONS.map((a) => a.code));
const GROUPS_OF = new Map(
  ACTIONS.map((a) => [a.code, GROUPS.map((g) => g.id).filter((g) => a[g])]),
);

// Right Shift / Right Ctrl are the game's built-in second keys for the left
// ones. They follow their primary: while it sits on its default key they keep
// working, once it has been moved they fall silent (unless bound themselves).
const ALIAS = { ShiftRight: 'ShiftLeft', ControlRight: 'ControlLeft' };

// Never bindable: Esc pauses and cancels a rebind, the rest belong to the
// browser or the OS.
const RESERVED = new Set(['Escape', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
  'ContextMenu', 'F5', 'F11', 'F12']);

export const BINDINGS_VERSION = 1;

// A physical code we would ever store: keyboard codes are letters/digits only.
const CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const MOUSE_RE = /^Mouse[0-4]$/;

export function isBindableCode(code) {
  return typeof code === 'string' && CODE_RE.test(code) && !RESERVED.has(code);
}

const NAMED = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace',
  ShiftLeft: 'Shift', ShiftRight: 'R Shift', ControlLeft: 'Ctrl', ControlRight: 'R Ctrl',
  AltLeft: 'Alt', AltRight: 'R Alt', CapsLock: 'Caps',
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',',
  Period: '.', Slash: '/', Backslash: '\\', Backquote: '`', Minus: '-', Equal: '=',
  IntlBackslash: '\\', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left',
  ArrowRight: 'Right', Insert: 'Ins', Delete: 'Del', Home: 'Home', End: 'End',
  PageUp: 'PgUp', PageDown: 'PgDn',
  Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /', NumpadDecimal: 'Num .', NumpadEnter: 'Num Enter',
};

// Short human name of a physical code, as the help panels print it.
export function keyLabel(code) {
  if (!code) return '—';
  if (NAMED[code]) return NAMED[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `Num ${m[1]}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
}

// Keep only well-formed, known entries; anything else is the default.
export function sanitizeBindings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const src = raw.bind && typeof raw.bind === 'object' ? raw.bind : null;
  if (!src || raw.v !== BINDINGS_VERSION) return out;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (!LOGICAL.has(k) || !isBindableCode(v) || v === k) continue;
    out[k] = v;
  }
  return out;
}

const clampSens = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 0.1), 5) : 1;
};

// The multiplier on (dx, dy) for one aim context. Pure; exported for tests.
//   ctx  'tank' | 'tankZoom' | 'air' | 'airZoom' | null
export function sensFactor(sens, invert, ctx) {
  if (!ctx) return { x: 1, y: 1 };
  const k = clampSens(sens?.[ctx] ?? 1);
  const inv = ctx === 'tank' || ctx === 'tankZoom' ? invert?.tank : invert?.air;
  return { x: k, y: inv ? -k : k };
}

// Which aim context a battle is in right now. Duck-typed on purpose: the
// combined battle says playerIsPlane, the air battle has a plane camera, the
// ground battle has neither.
export function aimContextOf(b, rightDown) {
  if (!b || b.finished) return null;
  const air = b.playerIsPlane === true || (b.playerIsPlane === undefined && !!b.planeCam);
  const alive = !!(b.player && b.player.alive !== false) && !b.spectate;
  if (air) return alive && rightDown ? 'airZoom' : 'air';
  return alive && b.sniper ? 'tankZoom' : 'tank';
}

export const input = {
  keys: new Set(), // LOGICAL codes held
  justPressed: new Set(), // LOGICAL codes pressed this frame
  _dx: 0,
  _dy: 0,
  wheel: 0,
  locked: false,

  // remap state
  bind: {}, // logical -> physical, only entries that differ from default
  _phys: new Map(), // physical -> logical[] (rebuilt by setBindings)
  _held: new Map(), // physical -> logical[] it pressed (so release is exact)
  // sensitivity state
  sens: { tank: 1, tankZoom: 1, air: 1, airZoom: 1 },
  invert: { tank: false, air: false },
  _probe: null,
  _scale: null, // cached per frame

  get fireHeld() {
    return this.keys.has('Mouse0');
  },
  set fireHeld(v) {
    if (v) this.keys.add('Mouse0');
    else this.keys.delete('Mouse0');
  },
  get rightDown() {
    return this.keys.has('Mouse2');
  },
  set rightDown(v) {
    if (v) this.keys.add('Mouse2');
    else this.keys.delete('Mouse2');
  },

  get mouseDX() {
    if (this._dx === 0) return 0;
    const s = this.scale();
    return s.x === 1 ? this._dx : this._dx * s.x;
  },
  set mouseDX(v) {
    this._dx = v;
  },
  get mouseDY() {
    if (this._dy === 0) return 0;
    const s = this.scale();
    return s.y === 1 ? this._dy : this._dy * s.y;
  },
  set mouseDY(v) {
    this._dy = v;
  },

  // ---------------------------------------------------------------- remap
  // The logical codes a physical key / button press stands for.
  resolve(phys) {
    const hit = this._phys.get(phys);
    if (hit) return hit;
    if (LOGICAL.has(phys)) return []; // a default key that was moved away
    const alias = ALIAS[phys];
    if (alias) return this.bind[alias] ? [] : [phys];
    return [phys]; // a key the game does not bind (Esc, F-keys...) passes through
  },

  // Current physical code of a logical code.
  bindingOf(logical) {
    return this.bind[logical] || logical;
  },

  setBindings(map) {
    const clean = sanitizeBindings({ v: BINDINGS_VERSION, bind: map || {} });
    const same = this._phys.size > 0 && JSON.stringify(clean) === JSON.stringify(this.bind);
    if (same) return; // applySettings() runs on every spawn: keep held keys held
    this.bind = clean;
    const phys = new Map();
    for (const a of ACTIONS) {
      const p = this.bindingOf(a.code);
      if (!phys.has(p)) phys.set(p, []);
      phys.get(p).push(a.code);
    }
    this._phys = phys;
    // whatever is held was pressed under the old map: let it go
    this.releaseAll();
  },

  // Logical codes bound to `phys` that share a vehicle class with `logical`
  // (common clashes with everything); those would fire together.
  conflictsFor(logical, phys) {
    const mine = GROUPS_OF.get(logical) || [];
    const out = [];
    for (const a of ACTIONS) {
      if (a.code === logical || this.bindingOf(a.code) !== phys) continue;
      const theirs = GROUPS_OF.get(a.code) || [];
      const clash = mine.includes('common') || theirs.includes('common') ||
        theirs.some((g) => mine.includes(g));
      if (clash) out.push(a.code);
    }
    return out;
  },

  // Put `logical` on physical `phys`. A clash is refused unless swap: then
  // each clashing code takes the key `logical` had. Returns
  //   { ok, conflicts, bindings }   bindings: the new map (for persistence)
  rebind(logical, phys, { swap = false } = {}) {
    if (!LOGICAL.has(logical)) return { ok: false, reason: 'unknown', conflicts: [] };
    if (!isBindableCode(phys)) return { ok: false, reason: 'reserved', conflicts: [] };
    const conflicts = this.conflictsFor(logical, phys);
    if (conflicts.length && !swap) return { ok: false, reason: 'conflict', conflicts };
    const next = { ...this.bind };
    const old = this.bindingOf(logical);
    next[logical] = phys;
    for (const c of conflicts) next[c] = old;
    for (const k of Object.keys(next)) if (next[k] === k) delete next[k];
    this.setBindings(next);
    return { ok: true, conflicts, bindings: { ...this.bind } };
  },

  resetBindings() {
    this.setBindings({});
    return {};
  },

  // the persisted shape (progress.settings.controls)
  serializeBindings() {
    return { v: BINDINGS_VERSION, bind: { ...this.bind } };
  },

  isRebound() {
    return Object.keys(this.bind).length > 0;
  },

  // ---------------------------------------------------------- sensitivity
  // Everything the settings carry for input. Unknown / corrupt -> defaults.
  configure(s = {}) {
    this.setBindings(sanitizeBindings(s.controls));
    this.sens = {
      tank: clampSens(s.sensTank),
      tankZoom: clampSens(s.sensTankZoom),
      air: clampSens(s.sensAir),
      airZoom: clampSens(s.sensAirZoom),
    };
    this.invert = { tank: s.invertYTank === true, air: s.invertYAir === true };
    this._scale = null;
  },

  // fn() -> the running battle (or null). Read lazily, once per frame.
  setAimProbe(fn) {
    this._probe = typeof fn === 'function' ? fn : null;
    this._scale = null;
  },

  aimContext() {
    let b = null;
    try {
      b = this._probe ? this._probe() : null;
    } catch (e) {
      b = null;
    }
    return aimContextOf(b, this.rightDown);
  },

  scale() {
    if (!this._scale) this._scale = sensFactor(this.sens, this.invert, this.aimContext());
    return this._scale;
  },

  // ---------------------------------------------------------------- events
  press(phys) {
    const logical = this.resolve(phys);
    for (const l of logical) {
      if (!this.keys.has(l)) this.justPressed.add(l);
      this.keys.add(l);
    }
    const prev = this._held.get(phys);
    this._held.set(phys, prev ? [...new Set([...prev, ...logical])] : logical);
    return logical;
  },

  release(phys) {
    const logical = this._held.get(phys) || this.resolve(phys);
    for (const l of logical) this.keys.delete(l);
    this._held.delete(phys);
  },

  releaseAll() {
    this.keys.clear();
    this._held.clear();
  },

  // fire and zoom let go however they are bound (pointer lock lost)
  releaseLogical(...codes) {
    for (const c of codes) this.keys.delete(c);
    for (const [p, ls] of this._held) {
      const rest = ls.filter((l) => !codes.includes(l));
      if (rest.length) this._held.set(p, rest);
      else this._held.delete(p);
    }
  },

  onKeyDown(e) {
    const logical = this.press(e.code);
    const stop = ['Space', 'ArrowUp', 'ArrowDown', 'Tab'];
    if (stop.includes(e.code) || logical.some((l) => stop.includes(l))) e.preventDefault?.();
  },

  onKeyUp(e) {
    this.release(e.code);
  },

  onMouseDown(e) {
    const phys = `Mouse${e.button}`;
    if (!MOUSE_RE.test(phys)) return;
    this.press(phys);
    // back / forward buttons navigate the page unless told not to
    if (this.locked && (e.button === 3 || e.button === 4)) e.preventDefault?.();
  },

  onMouseUp(e) {
    const phys = `Mouse${e.button}`;
    if (!MOUSE_RE.test(phys)) return;
    this.release(phys);
    if (this.locked && (e.button === 3 || e.button === 4)) e.preventDefault?.();
  },

  init() {
    if (!this._phys.size) this.setBindings(this.bind);
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.releaseAll());
    window.addEventListener('mousemove', (e) => {
      if (this.locked) {
        this._dx += e.movementX;
        this._dy += e.movementY;
      }
    });
    window.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    window.addEventListener('contextmenu', (e) => {
      if (this.locked) e.preventDefault();
    });
    window.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement != null;
      if (!this.locked) this.releaseLogical('Mouse0', 'Mouse2');
    });
  },

  down(code) {
    return this.keys.has(code);
  },

  pressed(code) {
    return this.justPressed.has(code);
  },

  endFrame() {
    this.justPressed.clear();
    this._dx = 0;
    this._dy = 0;
    this.wheel = 0;
    this._scale = null;
  },
};

// build the identity map so a harness that never calls init() still resolves
input.setBindings({});

// ---------------------------------------------------------------------------
// help panels: print the CURRENT keys
// ---------------------------------------------------------------------------
// The battle files write their help text with the default key names
// ("W / S — throttle · LMB — fire"). This swaps each key name in the part of a
// segment before " — " (and an "X steer"-style lead) for the key it is bound
// to now. With nothing rebound the text comes back untouched.
const DEFAULT_LABEL_TO_CODE = (() => {
  const m = new Map();
  for (const a of ACTIONS) m.set(keyLabel(a.code), a.code);
  return m;
})();
const FIXED_TOKENS = new Set(['(hold)', 'hold', 'Mouse', 'Scroll', 'Esc', '']);
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function relabelKeys(spec) {
  const parts = spec.split(/(\s*\/\s*|\s+)/);
  let any = false;
  for (let i = 0; i < parts.length; i += 2) {
    const t = parts[i];
    if (FIXED_TOKENS.has(t)) continue;
    const code = DEFAULT_LABEL_TO_CODE.get(t);
    if (!code) return null; // not a key list
    parts[i] = escHtml(keyLabel(input.bindingOf(code)));
    any = true;
  }
  return any ? parts.join('') : null;
}

function relabelSegment(seg) {
  const dash = seg.indexOf(' — ');
  if (dash > 0) {
    const lead = /^(\s*)(.*)$/.exec(seg.slice(0, dash));
    const keys = relabelKeys(lead[2]);
    let rest = seg.slice(dash);
    rest = rest.replace(/\((\w) down\)/g, (all, k) => {
      const code = DEFAULT_LABEL_TO_CODE.get(k);
      return code ? `(${escHtml(keyLabel(input.bindingOf(code)))} down)` : all;
    });
    return (keys == null ? seg.slice(0, dash) : lead[1] + keys) + rest;
  }
  // "On the ground: Q / E steer" — an optional "Words: " lead, keys, a word
  const m = /^(\s*(?:[A-Za-z ]+:\s+)?)((?:[^\s/]+)(?:\s*\/\s*[^\s/]+)*)(\s+[a-z].*)$/s.exec(seg);
  if (m) {
    const keys = relabelKeys(m[2]);
    if (keys != null) return m[1] + keys + m[3];
  }
  return seg;
}

export function relabelHelp(html) {
  if (typeof html !== 'string' || !input.isRebound()) return html;
  return html.replace(/(<span>)([^<]*)(<\/span>)/g, (all, a, body, c) =>
    a + body.split(' · ').map(relabelSegment).join(' · ') + c);
}
