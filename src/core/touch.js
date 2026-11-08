// Touch controls for phones and tablets (mobile lane, wave 5).
//
// Nothing here runs on a desktop: detectTouch() is false for a fine primary
// pointer, touch.init() then returns without building anything, and every
// input path the keyboard and mouse use stays exactly as it was.
//
// On a touch device this module is the only thing that talks to the fingers.
// It writes into core/input.js the same LOGICAL codes the keyboard does
// (input.touchPress / touchRelease), look deltas in mouse counts
// (input.addLook), wheel steps, and one analog stick (input.stick, read by the
// battles' drive / roll+pitch hooks). The battles never see a touch event.
//
//   left stick (floating)    tank: throttle + steer   aircraft: roll + pitch
//                            spectator: W/A/S/D
//   drag anywhere else       aim: tank turret / camera, aircraft mouse-aim
//                            instructor (both through input.mouseDX/DY)
//   two fingers (pinch)      zoom steps (wheel), same sign as the wheel
//   FIRE / MG                held, and a drag that starts on them also aims
//   buttons                  logical codes per vehicle class (see BUTTONS)
//
// Stick maths and the drag gain follow design/mobile-plan.md 5.2 / 5.3.
import { input } from './input.js';

// ---------------------------------------------------------------- detection
function q(name) {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch (e) {
    return null;
  }
}

function mm(query) {
  try {
    return !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia(query).matches);
  } catch (e) {
    return false;
  }
}

// True on a device whose primary pointer is a finger: (pointer: coarse).
// ?touch=1 / ?touch=0 force it (tests; the in-app browser only emulates touch
// below 768 px width).
export function detectTouch() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const f = q('touch');
  if (f === '1') return true;
  if (f === '0') return false;
  if (mm('(pointer: coarse)')) return true;
  // iPadOS with a keyboard case attached can report a fine primary pointer
  // while having no mouse; a Mac reports 0 touch points, Windows is excluded
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const ua = (nav && nav.userAgent) || '';
  return !!nav && (nav.maxTouchPoints || 0) > 1 && !/Windows/i.test(ua) && !mm('(any-pointer: fine)');
}

// 'phone' | 'tablet' — the shorter screen side below 600 CSS px is a phone.
export function touchDeviceClass() {
  const f = q('phone');
  if (f === '1') return 'phone';
  if (f === '0') return 'tablet';
  try {
    const sc = Math.min(window.screen?.width || 9999, window.screen?.height || 9999);
    const vp = Math.min(window.innerWidth, window.innerHeight);
    return sc < 600 || vp < 480 ? 'phone' : 'tablet';
  } catch (e) {
    return 'tablet';
  }
}

// ---------------------------------------------------------------- pure maths
// Floating-stick output. (dx, dy) is the thumb's offset from the base in CSS
// px, screen-down positive. Returns { x, y, m } with y screen-UP positive, x
// screen-right positive, magnitude m in 0..1 after a radial dead zone and a
// response curve. Exported for node tests.
export function stickVector(dx, dy, R, dz = 0.12, gamma = 1.3) {
  const d = Math.hypot(dx, dy);
  if (!(d > 0) || !(R > 0)) return { x: 0, y: 0, m: 0 };
  const m0 = Math.min(d / R, 1);
  const m = m0 <= dz ? 0 : Math.pow((m0 - dz) / (1 - dz), gamma);
  return { x: (dx / d) * m, y: (-dy / d) * m, m };
}

// Touch px -> mouse counts. 1.67 counts/px gives 0.21 deg/px at fov 60 with
// the battles' 0.0022 rad/count; a fast flick turns up to 1.5x further.
export function dragGain(speedPxS, sens = 1) {
  const v = Number.isFinite(speedPxS) ? speedPxS : 0;
  const accel = 1 + 0.5 * Math.min(Math.max((v - 600) / 1200, 0), 1);
  return 1.67 * sens * accel;
}

// ---------------------------------------------------------------- buttons
// id, label, modes it shows in, what it does:
//   code: a logical code held while the finger is down
//   wheel: +-1 wheel step per tap
//   act: a shell action (pause, map, score)
//   aim: a drag that starts on it also aims
const BUTTONS = [
  { id: 'pause', label: '❚❚', modes: 'tank air spec', act: 'pause' },
  { id: 'map', label: 'MAP', modes: 'tank air spec', act: 'map' },
  { id: 'score', label: 'SCORE', modes: 'tank air spec', act: 'score' },
  // hold to abandon the tank / bail out (the battles count the 1.5 s hold,
  // which is the confirmation)
  { id: 'bail', label: '⏏', modes: 'tank air', code: 'KeyJ' },
  // tank
  { id: 'fire', label: 'FIRE', modes: 'tank', code: 'Mouse0', aim: true },
  { id: 'mg', label: 'MG', modes: 'tank', code: 'Space', aim: true },
  { id: 'sight', label: 'SIGHT', modes: 'tank', code: 'ShiftLeft' },
  { id: 'zin', label: '+', modes: 'tank air', wheel: -1 },
  { id: 'zout', label: '−', modes: 'tank air', wheel: 1 },
  { id: 'sh1', label: 'AP', modes: 'tank', code: 'Digit1', shell: 0 },
  { id: 'sh2', label: 'HE', modes: 'tank', code: 'Digit2', shell: 1 },
  { id: 'sh3', label: '—', modes: 'tank', code: 'Digit3', shell: 2 },
  { id: 'repair', label: 'REPAIR', modes: 'tank', code: 'KeyR' },
  { id: 'ext', label: 'EXT', modes: 'tank', code: 'KeyF' },
  { id: 'smoke', label: 'SMOKE', modes: 'tank', code: 'KeyG' },
  { id: 'aid', label: 'AID', modes: 'tank', code: 'KeyH' },
  { id: 'scout', label: 'SCOUT', modes: 'tank', code: 'KeyV' },
  { id: 'art', label: 'ART', modes: 'tank', code: 'KeyT' }, // only when fitted
  // aircraft
  { id: 'afire', label: 'FIRE', modes: 'air', code: 'Mouse0', aim: true },
  { id: 'azoom', label: 'ZOOM', modes: 'air', code: 'Mouse2', aim: true },
  { id: 'bomb', label: 'BOMB', modes: 'air', code: 'Space' },
  { id: 'rocket', label: 'RKT', modes: 'air', code: 'KeyF' },
  { id: 'thrUp', label: 'THR+', modes: 'air', code: 'ShiftLeft' },
  { id: 'thrDn', label: 'THR−', modes: 'air', code: 'ControlLeft' },
  { id: 'gear', label: 'GEAR', modes: 'air', code: 'KeyG' },
  { id: 'flaps', label: 'FLAPS', modes: 'air', code: 'KeyV' },
  { id: 'brake', label: 'BRAKE', modes: 'air', code: 'KeyB' },
  { id: 'wep', label: 'WEP', modes: 'air', code: 'KeyR' },
  { id: 'aext', label: 'EXT', modes: 'air', code: 'KeyX' },
  { id: 'view', label: 'VIEW', modes: 'air', code: 'KeyP' }, // cockpit / chase
  { id: 'rudL', label: '◄', modes: 'air', code: 'KeyQ' },
  { id: 'rudR', label: '►', modes: 'air', code: 'KeyE' },
  // spectator
  { id: 'up', label: '▲', modes: 'spec', code: 'Space' },
  { id: 'down', label: '▼', modes: 'spec', code: 'ControlLeft' },
  { id: 'fast', label: '⇧', modes: 'spec', code: 'ShiftLeft' },
];
export const TOUCH_BUTTONS = BUTTONS;

const STICK_KEYS = 0.35; // stick magnitude that also holds W/A/S/D (spectator)

function modeOf(b) {
  if (!b || b.finished || !b.player) return null;
  if (b.spectate || b.player.alive === false) return 'spec';
  const air = b.playerIsPlane === true || (b.playerIsPlane === undefined && !!b.planeCam);
  return air ? 'air' : 'tank';
}

export const touch = {
  active: false,
  device: 'desktop', // 'phone' | 'tablet' | 'desktop'
  root: null,
  mode: null,
  live: false,
  sens: 1,
  hooks: {},
  _btn: new Map(), // id -> element
  _held: new Map(), // pointerId -> { kind, ... }
  _codes: new Map(), // logical code -> refcount of fingers holding it
  _stick: null, // { id, bx, by, x, y }
  _stickKeys: new Set(),
  _pinch: null,
  _ctx: '',
  _gatePaused: false,

  // hooks: { pause(reason), toggleMap(), mapOpen(), score(on) }
  init(hooks = {}) {
    this.hooks = hooks;
    this.active = detectTouch();
    if (!this.active) return false;
    this.device = touchDeviceClass();
    const html = document.documentElement;
    html.classList.add('ss-touch', this.device === 'phone' ? 'ss-phone' : 'ss-tablet');
    this.classes();
    window.addEventListener('resize', () => this.classes());
    window.addEventListener('orientationchange', () => setTimeout(() => this.classes(), 60));
    // iOS ignores user-scalable=no; a pinch on the HUD must not zoom the page
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
    this.build();
    return true;
  },

  classes() {
    const html = document.documentElement;
    const portrait = window.innerHeight > window.innerWidth;
    html.classList.toggle('ss-portrait', portrait);
    html.classList.toggle('ss-landscape', !portrait);
    html.classList.toggle('ss-compact', window.innerHeight < 500);
  },

  build() {
    let root = document.getElementById('touchUI');
    if (!root) {
      root = document.createElement('div');
      root.id = 'touchUI';
      (document.getElementById('app') || document.body).appendChild(root);
    }
    root.classList.add('hidden');
    root.innerHTML = '<div class="tcStickZone" id="tcStickZone"><i class="tcHint"></i>' +
      '<div class="tcBase hidden" id="tcBase"><i class="tcKnob" id="tcKnob"></i></div></div>' +
      BUTTONS.map((b) => `<button type="button" class="tcBtn tc-${b.id}" data-tc="${b.id}" data-modes="${b.modes}">` +
        `<span>${b.label}</span><em></em></button>`).join('');
    this.root = root;
    for (const b of BUTTONS) this._btn.set(b.id, root.querySelector(`[data-tc="${b.id}"]`));
    this.base = root.querySelector('#tcBase');
    this.knob = root.querySelector('#tcKnob');
    this.zone = root.querySelector('#tcStickZone');

    const opt = { passive: false };
    root.addEventListener('pointerdown', (e) => this.down(e), opt);
    root.addEventListener('pointermove', (e) => this.move(e), opt);
    root.addEventListener('pointerup', (e) => this.up(e), opt);
    root.addEventListener('pointercancel', (e) => this.up(e), opt);
    root.addEventListener('lostpointercapture', (e) => this.up(e), opt);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    // a finger leaving the page (app switch, notification shade) lets go
    window.addEventListener('blur', () => this.releaseAll());
  },

  // ------------------------------------------------------------ per frame
  // battle: the running battle or null. live: the shell is simulating it
  // with no overlay up.
  update(battle, live) {
    if (!this.active) return;
    const mode = live ? modeOf(battle) : null;
    const html = document.documentElement;
    html.classList.toggle('ss-inbattle', !!battle && !battle.finished);
    if (mode !== this.mode) {
      if (this.mode) html.classList.remove(`ss-m-${this.mode}`);
      if (mode) html.classList.add(`ss-m-${mode}`);
      this.releaseAll();
      this.mode = mode;
    }
    this.live = !!mode;
    this.root.classList.toggle('hidden', !this.live);
    // a battle on a phone held upright is paused behind the rotate gate
    if (this.live && html.classList.contains('ss-portrait')) {
      this.releaseAll();
      this.hooks.pause?.('rotate');
      return;
    }
    if (!this.live) return;
    this.root.classList.toggle('tcMap', !!this.hooks.mapOpen?.());
    this.context(battle);
  },

  // Contextual labels and visibility (shell chips, stores, urgent actions);
  // only touches the DOM when something changed.
  context(b) {
    const p = b.player;
    const parts = [this.mode];
    const show = {};
    const badge = {};
    if (this.mode === 'tank' && p.spec) {
      const keys = Object.keys(p.spec.shells || {});
      ['sh1', 'sh2', 'sh3'].forEach((id, i) => {
        // Digit1 = AP, Digit2 = HE, Digit3 = the third type (battle.js)
        const k = i === 0 ? (keys.includes('AP') ? 'AP' : null)
          : i === 1 ? (keys.includes('HE') ? 'HE' : null) : keys[2] || null;
        show[id] = !!k;
        if (k) badge[id] = `${k}|${p.ammo?.[k] ?? ''}|${p.shellType === k ? 1 : 0}`;
      });
      show.ext = !!p.burning;
      show.repair = !p.burning;
      show.zin = show.zout = !!b.sniper;
      badge.sight = b.sniper ? 'on' : '';
      // ground battle: getter; combined arms: the tank's own fit
      show.art = !!(b.hasArtillery || p.spec.artillerySupport);
    } else if (this.mode === 'air') {
      show.bomb = (p.bombs || 0) > 0;
      show.rocket = (p.rockets || 0) > 0;
      if (show.bomb) badge.bomb = String(p.bombs);
      if (show.rocket) badge.rocket = String(p.rockets);
      show.aext = !!p.burning;
      show.rudL = show.rudR = !!p.onGround;
      show.zin = show.zout = false;
      badge.flaps = String(p.flaps ?? '');
      badge.gear = p.gearGone ? '—' : p.gear ? 'DN' : 'UP';
      badge.view = b.cockpit ? 'on' : '';
    }
    for (const k of Object.keys(show)) parts.push(`${k}${show[k] ? 1 : 0}`);
    for (const k of Object.keys(badge)) parts.push(`${k}=${badge[k]}`);
    const sig = parts.join(';');
    if (sig === this._ctx) return;
    this._ctx = sig;
    for (const [id, el] of this._btn) {
      if (!el) continue;
      el.classList.toggle('tcOff', show[id] === false);
      const em = el.firstChild?.nextSibling;
      const bd = badge[id];
      if (id.startsWith('sh') && bd) {
        const [k, n, sel] = bd.split('|');
        el.firstChild.textContent = k;
        if (em) em.textContent = n;
        el.classList.toggle('tcSel', sel === '1');
      } else if (em) {
        em.textContent = bd && bd !== 'on' ? bd : '';
        el.classList.toggle('tcSel', bd === 'on');
      }
    }
  },

  // ------------------------------------------------------------ fingers
  hold(code) {
    const n = this._codes.get(code) || 0;
    this._codes.set(code, n + 1);
    if (n === 0) input.touchPress(code);
  },

  unhold(code) {
    const n = this._codes.get(code) || 0;
    if (n <= 1) {
      this._codes.delete(code);
      input.touchRelease(code);
    } else this._codes.set(code, n - 1);
  },

  releaseAll() {
    for (const [, h] of this._held) {
      if (h.el) h.el.classList.remove('tcDown');
    }
    this._held.clear();
    for (const code of this._codes.keys()) input.touchRelease(code);
    this._codes.clear();
    this.stickEnd();
    this._pinch = null;
    if (this._score) {
      this._score = false;
      input.touchRelease('Tab');
    }
  },

  down(e) {
    e.preventDefault();
    input.noteTouch();
    if (!this.live) return;
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch (err) {
      /* synthetic events have no capture */
    }
    // the tactical map is closed by a tap anywhere
    if (this.hooks.mapOpen?.()) {
      this.hooks.toggleMap?.();
      this._held.set(e.pointerId, { kind: 'none' });
      return;
    }
    const btnEl = e.target.closest?.('[data-tc]');
    if (btnEl && !btnEl.classList.contains('tcOff')) {
      const b = BUTTONS.find((x) => x.id === btnEl.dataset.tc);
      btnEl.classList.add('tcDown');
      const h = { kind: 'btn', b, el: btnEl, x: e.clientX, y: e.clientY, t: e.timeStamp, v: 0 };
      this._held.set(e.pointerId, h);
      if (b.code) this.hold(b.code);
      if (b.wheel) input.wheel += b.wheel;
      if (b.act === 'pause') this.hooks.pause?.('button');
      if (b.act === 'map') this.hooks.toggleMap?.();
      if (b.act === 'score') {
        this._score = !this._score;
        if (this._score) input.touchPress('Tab');
        else input.touchRelease('Tab');
        btnEl.classList.toggle('tcSel', this._score);
      }
      return;
    }
    if (e.target.closest?.('#tcStickZone') && !this._stick) {
      this.stickStart(e);
      this._held.set(e.pointerId, { kind: 'stick' });
      return;
    }
    // aim zone
    const h = { kind: 'aim', x: e.clientX, y: e.clientY, t: e.timeStamp, v: 0 };
    this._held.set(e.pointerId, h);
    const aims = [...this._held.entries()].filter(([, a]) => a.kind === 'aim');
    if (aims.length === 2) {
      const [a, c] = aims.map(([, a2]) => a2);
      this._pinch = { d0: Math.hypot(a.x - c.x, a.y - c.y) || 1 };
    }
  },

  move(e) {
    const h = this._held.get(e.pointerId);
    if (!h) return;
    e.preventDefault();
    input.noteTouch();
    if (h.kind === 'stick') {
      this.stickMove(e);
      return;
    }
    if (h.kind !== 'aim' && !(h.kind === 'btn' && h.b.aim)) return;
    const dx = e.clientX - h.x;
    const dy = e.clientY - h.y;
    const dt = Math.max(1, e.timeStamp - h.t);
    // finger speed, smoothed over ~50 ms
    const v = Math.hypot(dx, dy) / (dt / 1000);
    h.v = h.v ? h.v + (v - h.v) * Math.min(1, dt / 50) : v;
    h.x = e.clientX;
    h.y = e.clientY;
    h.t = e.timeStamp;
    if (this._pinch && h.kind === 'aim') {
      const aims = [...this._held.values()].filter((a) => a.kind === 'aim');
      if (aims.length >= 2) {
        const d = Math.hypot(aims[0].x - aims[1].x, aims[0].y - aims[1].y) || 1;
        const r = d / this._pinch.d0;
        // each 12 % change is one step; fingers apart = zoom in (wheel up)
        if (r > 1.12) {
          input.wheel -= 1;
          this._pinch.d0 = d;
        } else if (r < 1 / 1.12) {
          input.wheel += 1;
          this._pinch.d0 = d;
        }
        return;
      }
    }
    const g = dragGain(h.v, this.sens);
    input.addLook(dx * g, dy * g);
  },

  up(e) {
    const h = this._held.get(e.pointerId);
    if (!h) return;
    this._held.delete(e.pointerId);
    if (h.kind === 'stick') this.stickEnd();
    else if (h.kind === 'btn') {
      h.el.classList.remove('tcDown');
      if (h.b.code) this.unhold(h.b.code);
    } else if (h.kind === 'aim') {
      if ([...this._held.values()].filter((a) => a.kind === 'aim').length < 2) this._pinch = null;
    }
  },

  // ------------------------------------------------------------ stick
  radius() {
    return this.device === 'phone' ? 56 : 68;
  },

  stickStart(e) {
    this._stick = { id: e.pointerId, bx: e.clientX, by: e.clientY };
    const zr = this.zone.getBoundingClientRect();
    this.base.style.left = `${e.clientX - zr.left}px`;
    this.base.style.top = `${e.clientY - zr.top}px`;
    this.base.classList.remove('hidden');
    this.zone.classList.add('tcActive');
    this.stickApply(0, 0);
  },

  stickMove(e) {
    const s = this._stick;
    if (!s) return;
    const R = this.radius();
    let dx = e.clientX - s.bx;
    let dy = e.clientY - s.by;
    const d = Math.hypot(dx, dy);
    // beyond 1.4 R the base follows the thumb, so a drifting thumb keeps it
    if (d > 1.4 * R) {
      const k = (d - 1.4 * R) / d;
      s.bx += dx * k;
      s.by += dy * k;
      dx = e.clientX - s.bx;
      dy = e.clientY - s.by;
      const zr = this.zone.getBoundingClientRect();
      this.base.style.left = `${s.bx - zr.left}px`;
      this.base.style.top = `${s.by - zr.top}px`;
    }
    this.stickApply(dx, dy);
  },

  stickApply(dx, dy) {
    const R = this.radius();
    const air = this.mode === 'air';
    const v = stickVector(dx, dy, R, air ? 0.1 : 0.12, air ? 1.6 : 1.3);
    const d = Math.hypot(dx, dy);
    const k = d > R ? R / d : 1;
    this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    input.stick = v.m > 0 ? { x: v.x, y: v.y } : null;
    // the same thumb as held keys, for everything that reads only keys
    const want = new Set();
    if (v.y > STICK_KEYS) want.add('KeyW');
    if (v.y < -STICK_KEYS) want.add('KeyS');
    if (v.x > STICK_KEYS) want.add('KeyD');
    if (v.x < -STICK_KEYS) want.add('KeyA');
    for (const c of this._stickKeys) if (!want.has(c)) this.unhold(c);
    for (const c of want) if (!this._stickKeys.has(c)) this.hold(c);
    this._stickKeys = want;
  },

  stickEnd() {
    if (this._stick) {
      this._stick = null;
      this.base?.classList.add('hidden');
      this.zone?.classList.remove('tcActive');
    }
    for (const c of this._stickKeys) this.unhold(c);
    this._stickKeys = new Set();
    input.stick = null;
  },

  // ------------------------------------------------------------ platform
  // Best effort, inside the TO BATTLE / RESUME tap: fullscreen, landscape
  // lock (Android), screen wake lock. Every one may be missing or refused
  // (iPhone, a sandboxed frame) and the game plays the same without them.
  enterImmersive() {
    if (!this.active) return;
    const el = document.documentElement;
    let p = null;
    try {
      if (this.device === 'phone' && !document.fullscreenElement && !document.webkitFullscreenElement) {
        p = el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.();
      }
    } catch (e) {
      p = null;
    }
    Promise.resolve(p)
      .then(() => screen.orientation?.lock?.('landscape'))
      .catch(() => {});
    try {
      navigator.wakeLock?.request?.('screen').then((l) => { this._wake = l; }).catch(() => {});
    } catch (e) {
      /* no wake lock */
    }
  },
};
