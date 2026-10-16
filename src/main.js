import * as THREE from 'three';
import { input } from './core/input.js';
import {
  initAudio, updateEngineSound, setVolumes, resetAudio,
} from './core/audio.js';
import { setMaterialRenderer, setMaterialQuality, getMaterialQuality } from './core/materials.js';
import { createPostFX, postFXQualityFor, createFramePacer, gpuNameOf, compileQuietly } from './core/postfx.js';
import { activePreset } from './world/presets.js';
import { warmEnvironment } from './world/scenery.js';
import { HUD } from './ui/hud.js';
import { Garage } from './ui/garage.js';
import { Battle } from './game/battle.js';
import { AirBattle } from './game/airBattle.js';
import { CombinedBattle } from './game/combinedBattle.js';
import { progress, createSpawnBudget, specById } from './game/progress.js';
import { ownedMods } from './game/mods.js';
import { vehicleKind, brLabel, brOf } from './game/battleRating.js';
import { SPEC_INDEX, CREW_SKILLS, CREW_MAX_LEVEL, CREW_QUALS } from './game/progress.js';
import { MOD_DEFS } from './game/mods.js';

// Test-build unlock: every vehicle researched, every modification installed,
// every crew trained to Ace. Progress lives in localStorage per site and per
// person, so anyone opening the hosted test build would otherwise start from
// zero. Applied once per browser (MAXALL_FLAG), and again on demand with
// #maxall in the address.
const MAXALL_FLAG = 'steelSkies.maxall.v1';
let maxallDone = false;
try { maxallDone = localStorage.getItem(MAXALL_FLAG) === '1'; } catch { /* no storage */ }
if (location.hash === '#maxall' || !maxallDone) {
  const d = progress.data;
  for (const spec of Object.values(SPEC_INDEX)) {
    if (!d.owned.includes(spec.id)) d.owned.push(spec.id);
    const kind = spec.hull ? 'ground' : 'air';
    d.mods[spec.id] = (MOD_DEFS[kind] || []).map((m) => m.id);
    const crew = {};
    for (const s of CREW_SKILLS) crew[s.id] = CREW_MAX_LEVEL;
    crew.qual = CREW_QUALS.length - 1;
    d.crew[spec.id] = crew;
  }
  d.silver = Math.max(d.silver, 1000000);
  d.rp = Math.max(d.rp, 1000000);
  progress.save();
  try { localStorage.setItem(MAXALL_FLAG, '1'); } catch { /* no storage */ }
  if (location.hash === '#maxall') history.replaceState(null, '', location.pathname + location.search);
}

const app = document.getElementById('app');
const overlay = document.getElementById('overlay');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// AgX (art bible C-27, realism backlog L-02): it keeps a sunlit paint's
// saturation and does not crush a shaded one, where ACES pushed olive drab 26 %
// more saturated and a quarter-lit hull to black. The contrast comes from the
// light rig (L-01), not from the curve. Every battle writes its own exposure
// (preset.light.exposure, solved so the 18 % card lands on sRGB 125) through
// world/scenery.js applyExposure(); this is only the value before the first.
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.3;
// Stated rather than assumed. OutputPass reads this every frame to decide
// whether to encode, and a silent default is not a thing a colour pipeline
// should depend on.
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.classList.add('game');
app.prepend(renderer.domElement);

// The procedural material factory needs a live context to know how much
// anisotropic filtering it may ask for. Textures built before this call get the
// conservative default, so it happens before anything can build one.
setMaterialRenderer(renderer);

// dedicated small renderer for the X-ray hit camera (its canvas lives inside
// #killCamFrame, so it stacks above the sniper scope overlay)
const xrayCanvas = document.getElementById('xrayCanvas');
const xrayRenderer = new THREE.WebGLRenderer({ canvas: xrayCanvas, antialias: true });
xrayRenderer.setPixelRatio(1);

input.init();

const hud = new HUD();
let battle = null;
let paused = false;
let currentMode = 'ground';

// ---------- shell-side battle bookkeeping ----------
// The battle files are meant to keep these books themselves (this.usage /
// this.losses / this.survived / this.elapsed), but the settlement has to be
// correct whether or not they do yet, so the shell keeps a parallel set from
// what it can see: it is the shell that spawns the player and the shell that
// hears about every death.
let playerSpecId = null; // the vehicle the player is in right now
let life = null; // { id, start } — the load-out this life started with
let losses = []; // player vehicles destroyed this battle
let survived = []; // player vehicles that drove home
let usage = []; // ammunition and consumables spent, per life
let elapsed = 0; // fallback match clock
let budget = null; // spawn-point budget for this battle
let awardedPoints = 0; // spawn points this file has already credited
let lastDeath = null; // { canRespawn, kills } for redrawing the spawn screen
let settled = false; // a battle is settled exactly once, however it ended
let shakeWanted = 1; // camera-shake scale the player has asked for
let gfxWanted = null; // graphics tier in force: 'low' | 'medium' | 'high'
let postfx = null; // the battle post-processing chain, built on first frame
let postfxDead = false; // it threw on construction once; do not keep trying
let gradedFor = null; // the battle whose preset the chain's grade (L-07) is set to
let lensWanted = { blur: true, grain: true }; // R3-S, from progress.settings

// ---------- debug flags (P-01) ----------
// ?bench runs the scripted benchmark (src/debug/bench.js), ?calib puts the
// calibration board in front of the player (src/debug/calibration.js). Both
// modules are loaded on demand only; with neither flag in the address nothing
// below changes what the game does.
const DEBUG_FLAGS = (() => {
  try {
    const q = new URLSearchParams(location.search);
    return { bench: q.has('bench'), calib: q.has('calib'), query: q };
  } catch (e) {
    return { bench: false, calib: false, query: null };
  }
})();
// What a debug module may hook: onBattleStart(battle), afterUpdate(battle, dt)
// (camera paths), afterRender(battle) (pixel reads in the same task).
const debugHooks = {};

const fmt = (n) => Math.round(n || 0).toLocaleString('en-US');
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
// '' rather than '0' for an empty cell: a column of zeroes reads as noise.
const money = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : '');
// The overlay is assembled from template strings. Vehicle names and reasons are
// project data rather than anything a player types, but escaping what goes into
// an attribute costs nothing and stops a stray quote from eating the markup.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESC_MAP[c]);

// ---------- overlay helpers ----------
function showOverlay(html) {
  overlay.innerHTML = html;
  overlay.classList.remove('hidden');
}

function hideOverlay() {
  overlay.classList.add('hidden');
  overlay.innerHTML = '';
}

function requestLock() {
  if (!document.pointerLockElement) {
    renderer.domElement.requestPointerLock()?.catch?.(() => {});
  }
}

// The results table, the spawn picker and the pause sliders all need styling
// that style.css does not carry. Injecting it here keeps the stylesheet out of
// this file's ownership and scopes every rule under #overlay, so nothing can
// leak into the HUD or the garage.
(function injectOverlayStyles() {
  if (document.getElementById('shellStyles')) return;
  const el = document.createElement('style');
  el.id = 'shellStyles';
  el.textContent = `
/* the results screen is taller than the old one-line payout; let it scroll,
   and centre it safely so a long table cannot push its own title off the top */
#overlay { overflow-y: auto; padding: 24px 12px; justify-content: safe center; }
#overlay .rsCard {
  width: min(700px, 92vw); text-align: left; padding: 14px 18px 16px;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.14);
}
#overlay .rsCard h4 {
  font-size: 12px; letter-spacing: 4px; color: #8fa0b8; font-weight: 700;
  margin-bottom: 8px;
}
#overlay .rsRow {
  display: grid; grid-template-columns: 1fr 116px 96px; gap: 10px;
  font-size: 13px; color: #cbd5e2; padding: 3px 0; line-height: 1.4;
}
#overlay .rsRow span + span { text-align: right; font-variant-numeric: tabular-nums; }
#overlay .rsHead {
  color: #7d8ba0; font-size: 11px; letter-spacing: 2px;
  border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 4px; margin-bottom: 4px;
}
#overlay .rsSection {
  color: #7d8ba0; font-size: 11px; letter-spacing: 3px; margin-top: 10px;
  border-top: 1px solid rgba(255,255,255,0.09); padding-top: 8px;
}
#overlay .rsGain span:nth-child(2) { color: #ffd257; }
#overlay .rsBill span:nth-child(2) { color: #e08070; }
#overlay .rsRp { color: #6fd0c0; }
#overlay .rsNet {
  border-top: 1px solid rgba(255,255,255,0.22); margin-top: 10px; padding-top: 10px;
  font-size: 16px; font-weight: 700; letter-spacing: 2px; color: #dfe6ef;
}
#overlay .rsNet.win span:nth-child(2) { color: #7fe089; }
#overlay .rsNet.loss span:nth-child(2) { color: #e05040; }
#overlay .rsSub { font-size: 12px; color: #8fa0b8; margin-top: 6px; line-height: 1.5; }
#overlay .rsWarn { color: #e08070; }
#overlay .rsBar { height: 7px; background: rgba(255,255,255,0.1); margin: 8px 0 5px; }
#overlay .rsBar div { height: 100%; background: #6fd0c0; }
#overlay .rsBar.done div { background: #7fe089; }
#overlay .spGrid { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
#overlay button.spCard {
  display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
  padding: 10px 16px; min-width: 168px; letter-spacing: 0;
}
#overlay button.spCard b { font-size: 15px; letter-spacing: 1px; }
#overlay button.spCard small { font-size: 11px; letter-spacing: 2px; color: #8fa0b8; }
#overlay button.spCard .cost { font-size: 12px; letter-spacing: 1px; color: #ffd257; }
#overlay button.spCard:disabled { opacity: 0.42; cursor: not-allowed; }
#overlay button.spCard:disabled:hover { background: rgba(255,255,255,0.08); }
#overlay button.spCard:disabled .cost { color: #e05040; }
#overlay .spPoints { color: #ffd257; font-weight: 700; }
/* ---- quick loadout picker on the spawn screen ----
   The stores strip is a SIBLING of the spawn button, never a child of it: a
   button cannot legally contain a button, and more to the point a click that
   changes what you are carrying must not be able to bubble into a click that
   throws you into the battle. It is drawn as a drawer hanging off the bottom
   of the card — same border, same palette, dimmer ground — so it reads as part
   of that vehicle and not as another row of spawn buttons. */
#overlay .spSlot { display: flex; flex-direction: column; width: 200px; }
#overlay .spSlot > button.spCard { width: 100%; flex: 1 1 auto; }
#overlay .spLoad {
  display: flex; flex-direction: column; align-items: stretch; gap: 5px;
  padding: 7px 10px 8px; text-align: left;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.14); border-top: 0;
}
#overlay .spLoadHead {
  display: flex; justify-content: space-between; align-items: baseline; gap: 6px;
  font-size: 9px; letter-spacing: 2px; color: #7d8ba0;
}
#overlay .spLoadHead em { font-style: normal; letter-spacing: 1px; color: #5f6c7e; }
#overlay .spLoChips { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
#overlay button.spLoChip {
  min-width: 0; padding: 5px 2px; font-size: 9.5px; font-weight: 700;
  letter-spacing: 1px; color: #aab8c9;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.2);
}
#overlay button.spLoChip:hover:not(:disabled) { background: rgba(255,255,255,0.14); }
#overlay button.spLoChip.on {
  background: rgba(240,192,64,0.20); border-color: #f0c040; color: #ffd257;
}
#overlay button.spLoChip.on:hover { background: rgba(240,192,64,0.28); }
#overlay button.spLoChip:disabled { opacity: 0.38; cursor: not-allowed; }
#overlay button.spLoChip:disabled:hover { background: rgba(255,255,255,0.06); }
#overlay .spLoDetail {
  font-size: 10px; line-height: 1.35; color: #8fa0b8; min-height: 27px;
}
#overlay p.spHint {
  font-size: 11px; letter-spacing: 1px; color: #7d8ba0; max-width: 560px;
  margin-top: -8px;
}
#overlay .setRow {
  display: grid; grid-template-columns: 156px 1fr 46px; align-items: center;
  gap: 10px; font-size: 12px; letter-spacing: 2px; color: #aab8c9; padding: 5px 0;
}
#overlay .setRow input { width: 100%; accent-color: #f0c040; }
#overlay .setRow .val { text-align: right; color: #dfe6ef; font-variant-numeric: tabular-nums; }
#overlay .gfxRow { grid-template-columns: 156px 1fr; }
#overlay .gfxBtns { display: flex; gap: 6px; }
#overlay .gfxBtns button {
  flex: 1; padding: 7px 4px; font-size: 11px; letter-spacing: 2px;
}
#overlay .gfxBtns button.on {
  background: rgba(240,192,64,0.20); border-color: #f0c040; color: #ffd257;
}
#overlay .gfxBtns button.on:hover { background: rgba(240,192,64,0.28); }
`;
  document.head.appendChild(el);
})();

// ---------- settings ----------
// One place that pushes the persisted settings into the systems that consume
// them. Called at startup, on every battle start, whenever the garage touches
// its sliders and whenever the pause screen does.
function applySettings() {
  const s = progress.settings || {};
  setVolumes({
    master: clamp(num(s.masterVolume, 0.8), 0, 1),
    effects: clamp(num(s.effectsVolume, 1), 0, 1),
    engines: clamp(num(s.engineVolume, 0.8), 0, 1),
  });
  shakeWanted = clamp(num(s.shakeScale, 1), 0, 2);
  pushShakeScale();
  // contract R3-S: K-02 motion blur (high tier only) and K-01 film grain
  lensWanted = { blur: s.motionBlur !== false, grain: s.filmGrain !== false };
  try {
    postfx?.setLens?.(lensWanted);
  } catch (e) {
    /* a chain without a lens keeps the picture it has */
  }
  applyGraphics(readGraphics());
  // settings lane: key bindings and mouse sensitivity (core/input.js); the
  // probe tells the sensitivity which aim context the battle is in
  input.configure(s);
  input.setAimProbe(() => battle);
}

// ---------- graphics quality ----------
// Audio and shake live in progress.settings, which is where this belongs too —
// but progress.setSetting() rejects any key that is not already in its
// DEFAULT_SETTINGS and coerces everything non-boolean through Number(), so a
// string tier cannot be stored there today and progress.js is not this file's
// to change. So: read progress first, so the day it grows the key it wins
// outright, and otherwise keep the choice next to the save the same way
// progress does. The rest of the game never has to know which one answered.
const GFX_LEVELS = ['low', 'medium', 'high'];
const GFX_KEY = 'steelSkies.graphics';

// A machine with few cores is usually a machine with a weak GPU too — the same
// reasoning, and the same threshold, that ui/garage.js applies to the hangar —
// and the GPU itself is asked as well: Intel integrated graphics is "medium"
// however many cores sit next to it (backlog 1.1).
function defaultGraphics() {
  try {
    return postFXQualityFor({ gpu: gpuNameOf(renderer) });
  } catch (e) {
    return 'medium';
  }
}

// settings lane (wave 4): progress.settings.graphics now holds the choice —
// 'auto' | 'low' | 'medium' | 'high' — and progress.js adopts the old
// GFX_KEY copy once for a save that predates the slot. 'auto' is the
// hardware guess, re-asked every time (it is the GPU, not the save).
function graphicsChoice() {
  const v = (progress.settings || {}).graphics;
  if (v === 'auto' || GFX_LEVELS.includes(v)) return v;
  try {
    const stored = window.localStorage?.getItem(GFX_KEY);
    if (GFX_LEVELS.includes(stored)) return stored;
  } catch (e) {
    /* private mode, blocked storage: fall through to the hardware guess */
  }
  return 'auto';
}

function readGraphics() {
  const c = graphicsChoice();
  return c === 'auto' ? defaultGraphics() : c;
}

function writeGraphics(level) {
  if (level !== 'auto' && !GFX_LEVELS.includes(level)) return;
  try {
    progress.setSetting('graphics', level);
  } catch (e) {
    /* nothing persists this session; the setting still applies to it */
  }
}

// A tier the debug shell (P-01 bench) has pinned: every battle start runs
// applySettings(), which would otherwise put the player's own tier back under
// the bench's feet. Never persisted; null in normal play.
let gfxOverride = null;

function applyGraphics(level) {
  const want = gfxOverride || (GFX_LEVELS.includes(level) ? level : defaultGraphics());
  if (want === gfxWanted) {
    pushMaterialQuality();
    return;
  }
  gfxWanted = want;
  // the composer can change tier mid-frame for free
  try {
    postfx?.setQuality(want);
  } catch (e) {
    /* a chain that cannot retier keeps the one it has */
  }
  pushMaterialQuality();
}

// setMaterialQuality() regenerates every procedural texture and disposes the
// material cache, which is a visible hitch and pulls materials out from under
// meshes a running battle is still drawing. It is free between battles and
// nowhere else, so a change made from the pause screen is held until the battle
// ends — same pattern as pushShakeScale(), which catches up whenever it can.
function pushMaterialQuality() {
  if (!gfxWanted || getMaterialQuality() === gfxWanted) return;
  if (battle && !battle.finished) return;
  // settings lane: a tier picked in the hangar does not pull the cached
  // materials out from under the stage's models; startBattle() pushes it
  // (the garage is hidden by then)
  if (garageShowing()) return;
  setMaterialQuality(gfxWanted);
}

function garageShowing() {
  try {
    return !!garage?.root && !garage.root.classList.contains('hidden');
  } catch (e) {
    return false; // before the garage exists
  }
}

// level: 'auto' | 'low' | 'medium' | 'high'. Persists and applies; the one
// path the pause screen and the hangar settings both use (garage.graphicsApi).
function setGraphics(level) {
  if (level !== 'auto' && !GFX_LEVELS.includes(level)) return;
  writeGraphics(level);
  applyGraphics(level === 'auto' ? defaultGraphics() : level);
}

// ---------- post-processing ----------
// Built on the first frame a battle is drawn rather than beside the renderer,
// because it needs a scene and a camera and the shell does not have either
// until the player has picked a vehicle. Construction is wrapped because
// allocating four full-screen float buffers is exactly the thing a browser
// short of VRAM refuses, and a machine that cannot have the effects must still
// get a playable game.
function ensurePostFX() {
  if (postfxDead || !battle) return null;
  if (!postfx) {
    try {
      postfx = createPostFX(renderer, battle.scene, battle.camera, {
        quality: gfxWanted || defaultGraphics(),
        // P-04: GTAO at half resolution (a soft contact term, upsampled), and
        // the chain's resolution following its measured GPU time so the high
        // tier holds ~12 ms on an integrated GPU at 1080p (the HUD is DOM and
        // never scaled). Off in the hangar, which builds its own chain.
        aoScale: 0.5,
        autoScale: readRenderFloor() < 1,
        targetMs: { high: 12, medium: 8, low: 5 },
        // and the slow tail (p90) under the p95 budgets: 16 / 9 / 6 ms
        tailMs: { high: 14.5, medium: 8.4, low: 5.5 },
        minScale: readRenderFloor(),
      });
      postfx.setLens?.(lensWanted);
    } catch (e) {
      postfx = null;
      postfxDead = true;
      return null;
    }
  }
  // K-02: the player's own vehicle (and 12 m beyond it) is never blurred
  postfx.setMotionSubject?.(battle.player || null);
  // A new battle is a new scene and a new camera. Telling the chain about them
  // is two identity comparisons; rebuilding it would be four buffers.
  postfx.setScene(battle.scene);
  postfx.setCamera(battle.camera);
  // L-07: the grade is a function of the battle's preset, set once per battle.
  if (gradedFor !== battle) {
    gradedFor = battle;
    try {
      postfx.setPreset(battle.preset || activePreset());
    } catch (e) {
      /* an ungraded picture is still the right picture */
    }
  }
  // Inside a battle sight the grade and the lens finish are off, and the
  // sight picture is exactly the chain without them (L-07, K-01).
  postfx.setOptic?.(!!battle.sniper);
  return postfx;
}

function disposePostFX() {
  try {
    postfx?.dispose();
  } catch (e) {
    /* a chain that will not tear down is still a chain we are done with */
  }
  postfx = null;
  gradedFor = null;
}

// Kept separate because a battle may not have built its shake system by the
// time the settings are first read, and the loop can then catch up for free.
function pushShakeScale() {
  const shake = battle?.shake;
  if (!shake || shake.scale === shakeWanted) return;
  if (typeof shake.setScale === 'function') shake.setScale(shakeWanted);
  else if ('scale' in shake) shake.scale = shakeWanted;
}

// The garage writes straight into progress.settings, so watching its own input
// events is cheaper than a callback and leaves garage.js knowing nothing about
// the audio bus.
// Capture phase, so a handler that stops propagation cannot hide the event —
// which also means it runs BEFORE the garage's own (bubble) handler has
// written the new value. Applying on the next task reads the value the click
// or slider just set (a toggle such as R3-S motion blur would otherwise apply
// the old state and stay there until the next battle).
let settingsQueued = false;
const garageSettingsWatcher = (e) => {
  if (settingsQueued || !e.target?.closest?.('#garage')) return;
  settingsQueued = true;
  setTimeout(() => {
    settingsQueued = false;
    applySettings();
  }, 0);
};
document.addEventListener('input', garageSettingsWatcher, true);
document.addEventListener('click', garageSettingsWatcher, true);

// ---------- spawn points ----------
// Prefer whatever budget the battle built for itself; only make one here when
// it did not, so the two can never disagree about what has been spent.
function spawnBudget() {
  const supplied = battle && (battle.spawnBudget || battle.plan?.spawnBudget);
  if (supplied && supplied !== budget) {
    budget = supplied;
    awardedPoints = 0;
  }
  return budget;
}

function spawnCostOf(b, id) {
  if (!b) return 0;
  if (typeof b.cost === 'function') return b.cost(id) || 0;
  return b.spawned?.length ? progress.spawnCost(id) : 0;
}

// Deliberately not budget.spend(): that also enforces the lineup, and a player
// who reached the hangar picker must still be able to pay for what they chose.
function chargeSpawn(b, id) {
  if (!b) return true;
  const cost = spawnCostOf(b, id);
  if (num(b.points, 0) < cost) return false;
  b.points -= cost;
  b.spawned?.push(id);
  return true;
}

// Credit what the player has earned since the last time we looked — but only
// when nobody else is keeping the same books. A battle that banks its own
// income (award() on every kill, assist, cap and hit, or a running total it
// recomputes each frame) has already counted every one of these events, and
// adding our aggregate on top of it doubled the respawn budget: the one number
// the whole spawn economy exists to ration. The battle wins; this is the
// fallback for a mode that supplies none.
function syncSpawnPoints() {
  if (
    battle &&
    (typeof battle.awardSpawnPoints === 'function' ||
      typeof battle.spawnPointsNow === 'function')
  ) {
    return;
  }
  const b = spawnBudget();
  if (!b || typeof progress.spawnPointsFor !== 'function') return;
  let earned = 0;
  try {
    earned = progress.spawnPointsFor({
      kills: battle?.playerKills || 0,
      assists: battle?.playerAssists || 0,
      groundKills: battle?.playerGroundKills || 0,
      caps: battle?.playerCaps || 0,
      hits: battle?.playerHits || 0,
      capTicks: battle?.playerCapTicks || 0,
      minutes: battleSeconds() / 60,
    }) || 0;
  } catch (e) {
    earned = 0;
  }
  if (earned > awardedPoints) {
    b.points += earned - awardedPoints;
    awardedPoints = earned;
  }
}

function battleSeconds() {
  if (Number.isFinite(battle?.elapsed)) return battle.elapsed;
  if (Number.isFinite(battle?.time)) return battle.time;
  return elapsed;
}

// ---------- what the player burned ----------
// A tank carries an ammo map and consumable charges; a plane carries a round
// count plus its ordnance. Snapshot on spawn, subtract on death, and the
// results screen can bill for exactly what was fired.
function captureLoad(entity) {
  if (!entity) return null;
  const snap = { shells: null, stream: 0, bombs: 0, rockets: 0, consumables: null };
  if (entity.ammo && typeof entity.ammo === 'object') {
    snap.shells = { ...entity.ammo };
    snap.stream = num(entity.streamAmmo, 0);
  } else {
    snap.stream = num(entity.ammo, 0);
    snap.bombs = num(entity.bombs, 0);
    snap.rockets = num(entity.rockets, 0);
  }
  if (entity.consumables) snap.consumables = { ...entity.consumables };
  return snap;
}

function spentSince(start, entity) {
  const used = { shells: {}, stream: 0, bombs: 0, rockets: 0, consumables: {} };
  if (!start) return used;
  const now = captureLoad(entity) || start;
  if (start.shells) {
    for (const k of Object.keys(start.shells)) {
      // resupply can hand rounds back, so the delta floors at zero
      const n = Math.max(0, num(start.shells[k], 0) - num(now.shells?.[k], 0));
      if (n) used.shells[k] = n;
    }
  }
  used.stream = Math.max(0, start.stream - now.stream);
  used.bombs = Math.max(0, start.bombs - now.bombs);
  used.rockets = Math.max(0, start.rockets - now.rockets);
  if (start.consumables) {
    const c = now.consumables || start.consumables;
    const kits = Math.max(0, num(start.consumables.repair, 0) - num(c.repair, 0));
    const fpe = Math.max(0, num(start.consumables.fpe, 0) - num(c.fpe, 0));
    const aid = Math.max(0, num(start.consumables.firstAid, 0) - num(c.firstAid, 0));
    if (kits) used.consumables.parts = kits;
    if (fpe) used.consumables.fpe = fpe;
    if (aid) used.consumables.crew = aid;
  }
  return used;
}

function beginLife(specId) {
  playerSpecId = specId || battle?.player?.spec?.id || playerSpecId;
  life = { id: playerSpecId, start: captureLoad(battle?.player) };
}

function closeLife(destroyed) {
  if (!life) return;
  const spent = spentSince(life.start, battle?.player);
  if (life.id) {
    spent.id = life.id;
    usage.push(spent);
    if (destroyed) losses.push(life.id);
    else survived.push(life.id);
  }
  life = null;
}

// ---------- state machine ----------
const garage = new Garage((battleMode, vehicleType, specId) => {
  initAudio();
  applySettings();
  if (battle && battle.player && !battle.player.alive && !battle.finished) {
    // respawn flow: reuse the running battle, but the spawn budget still rules
    const b = spawnBudget();
    const cost = spawnCostOf(b, specId);
    if (b && num(b.points, 0) < cost) {
      const spec = specById(specId);
      showSpawnScreen(
        `${spec?.name || specId} costs ${cost} spawn points and you have ${Math.floor(num(b.points, 0))}.`,
      );
      return;
    }
    doRespawn(specId, vehicleType);
    return;
  }
  startBattle(battleMode, vehicleType, specId);
});
// settings lane: the hangar's GRAPHICS QUALITY row drives the same path the
// pause screen does. A perf lane adding a render scale hangs
// getRenderScale()/setRenderScale(v) here and the hangar shows a row for it.
garage.graphicsApi = {
  levels: ['auto', ...GFX_LEVELS],
  choice: () => graphicsChoice(),
  current: () => gfxWanted || readGraphics(),
  auto: () => defaultGraphics(),
  set: (level) => setGraphics(level),
  // P-04: the hangar's RENDER SCALE row is the lowest resolution share the
  // battle's dynamic resolution may drop to; 100 % pins full resolution.
  getRenderScale: () => readRenderFloor(),
  setRenderScale: (v) => writeRenderFloor(v),
};

// ---------- P-04 render-scale floor ----------
// Per browser (localStorage): it is about this machine's GPU, not the save.
const RSCALE_KEY = 'steelSkies.renderScaleFloor';
const RSCALE_DEFAULT = 0.6;
function readRenderFloor() {
  let v = NaN;
  try {
    v = parseFloat(window.localStorage?.getItem(RSCALE_KEY));
  } catch (e) {
    /* blocked storage: the default */
  }
  return Number.isFinite(v) ? Math.min(1, Math.max(0.5, v)) : RSCALE_DEFAULT;
}
function writeRenderFloor(v) {
  const f = Math.min(1, Math.max(0.5, Math.round(Number(v) * 20) / 20 || RSCALE_DEFAULT));
  try {
    window.localStorage?.setItem(RSCALE_KEY, String(f));
  } catch (e) {
    /* this session only */
  }
  postfx?.setAutoScale?.({ enabled: f < 1, minScale: f });
  return f;
}

function startBattle(battleMode, vehicleType, specId) {
  if (battle) {
    battle.dispose();
    battle = null;
  }
  resetAudio();
  hideOverlay();
  currentMode = battleMode;
  losses = [];
  survived = [];
  usage = [];
  elapsed = 0;
  budget = null;
  awardedPoints = 0;
  lastDeath = null;
  life = null;
  settled = false;
  // the one moment a texture tier can change without pulling materials out from
  // under a battle that is drawing them
  pushMaterialQuality();
  battle =
    battleMode === 'air'
      ? new AirBattle(renderer, specId, hud, onBattleEnd)
      : battleMode === 'combined'
        ? new CombinedBattle(renderer, vehicleType, specId, hud, onBattleEnd)
        : new Battle(renderer, specId, hud, onBattleEnd);
  battle.onPlayerDeath = onPlayerDeath;
  applySettings();
  let b = spawnBudget();
  if (!b) {
    budget = safeBudget(battleMode);
    b = budget;
  }
  // The opening spawn is free, but it still has to go on the books or the first
  // respawn would be free too. spend() also enforces the lineup, so a vehicle
  // picked outside it falls through to the plain charge.
  if (b && !b.spawned?.length && !b.spend?.(specId)) chargeSpawn(b, specId);
  beginLife(specId);
  hud.show();
  paused = false;
  warmShaders(battle);
  requestLock();
  if (debugHooks.onBattleStart) {
    try {
      debugHooks.onBattleStart(battle, battleMode);
    } catch (e) {
      console.warn('[debug] onBattleStart failed:', e);
    }
  }
}

function safeBudget(mode) {
  try {
    return createSpawnBudget(mode);
  } catch (e) {
    return null;
  }
}

// ---------- spawn / respawn screen ----------
function onPlayerDeath(canRespawn, kills) {
  document.exitPointerLock?.();
  hud.setBigMap?.(false); // the tactical map must not sit under the spawn screen
  closeLife(true);
  lastDeath = { canRespawn: !!canRespawn, kills: kills || 0 };
  showSpawnScreen();
}

// Which machines the picker may offer. The budget's roster is a snapshot taken
// when the battle was built, so on its own it can only ever show what
// progress.getLineup() happened to return at that moment — for Combined Arms
// the selected tank and the selected aeroplane and nothing else, which is where
// the two-life ceiling came from. Progress is asked again here and the union is
// offered, so the day getLineup() hands back a fuller roster the extra machines
// appear without a second change; the budget's own roster is widened to match,
// because canSpawn() is what the battle files gate a respawn on. Nothing here
// or below counts the entries — two is not a number this file knows.
function lineupIds(b) {
  const ids = [];
  for (const id of b?.lineup || []) if (id && !ids.includes(id)) ids.push(id);
  let fromProgress = [];
  try {
    fromProgress = progress.getLineup(currentMode) || [];
  } catch (e) {
    fromProgress = [];
  }
  let widened = false;
  for (const id of fromProgress) {
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    widened = true;
  }
  // the vehicle the player is flying right now is always a legal thing to bring
  // back, even if it was never written into a lineup
  if (playerSpecId && !ids.includes(playerSpecId)) ids.push(playerSpecId);
  if (widened && Array.isArray(b?.lineup)) {
    for (const id of fromProgress) {
      if (id && !b.lineup.includes(id)) b.lineup.push(id);
    }
  }
  return ids;
}

// The vehicles the player may bring back, with what each one costs out of the
// running spawn budget. A vehicle already lost this battle is marked spent so
// the picker pushes the player down their lineup — but only while something
// else is still available. Once the lineup is used up, a machine they can
// still afford comes back: spawn points and the battle's own respawn cap are
// the limit, and they are the same limit in every mode.
function spawnOptions(b) {
  const ids = lineupIds(b);
  const kinds = progress.lineupKinds(currentMode);
  const out = [];
  for (const id of ids) {
    const spec = specById(id);
    if (!spec) continue;
    const kind = vehicleKind(spec);
    if (!kinds.includes(kind)) continue;
    const cost = spawnCostOf(b, id);
    out.push({
      id,
      spec,
      kind,
      cost,
      affordable: !b || num(b.points, 0) >= cost,
      spent: !!b?.spawned?.includes(id) && ids.length > 1,
    });
  }
  if (!out.some((o) => o.affordable && !o.spent)) {
    for (const o of out) o.spent = false;
  }
  return out;
}

// ---------- quick loadout picker (aircraft only) ----------
// War Thunder asks what you are carrying at the moment you spawn, not in the
// hangar and certainly not in mid-air. The hangar picker in ui/garage.js stays
// exactly as it is; this is the same three choices offered again on the spawn
// screen, reading and writing the same progress.getLoadout/setLoadout store, so
// whichever surface the player used last is the one that spawns.
//
// Ground vehicles have no loadout in this game — they have an ammunition
// distribution, which is a different screen and a different economy — so this
// is only ever drawn under an o.kind === 'air' card.

// ownedMods() reaches into progress.data, which a half-migrated save can leave
// without the map it expects. A picker is not worth taking the spawn screen
// down over.
function ownedModsSafe(id) {
  try {
    return ownedMods(id) || [];
  } catch (e) {
    return [];
  }
}

function currentLoadout(id) {
  try {
    return progress.getLoadout(id) || 'clean';
  } catch (e) {
    return 'clean';
  }
}

// What this aeroplane may carry, in the order the hangar lists it. Every option
// is always present: one the player cannot take is greyed with the reason
// rather than omitted, because a picker that silently drops half its choices
// reads as a bug and teaches the player nothing about what to research next.
//
// The enabled test is deliberately the same pair of conditions mods.js applies
// at spawn (applyMods: the loadout is only carried when the matching module is
// owned), so the picker can never offer stores the aeroplane would take off
// without.
function loadoutChoices(spec) {
  const owned = ownedModsSafe(spec.id);
  const out = [{
    id: 'clean',
    label: 'CLEAN',
    detail: 'Guns only — best speed, climb and turn.',
    enabled: true,
  }];
  for (const kind of ['bombs', 'rockets']) {
    const label = kind === 'bombs' ? 'BOMBS' : 'ROCKETS';
    const store = spec[kind];
    const count = Math.round(num(store?.count, 0));
    if (!store || count <= 0) {
      out.push({
        id: kind,
        label,
        detail: `No ${kind === 'bombs' ? 'bomb racks' : 'rocket rails'} on this airframe.`,
        enabled: false,
      });
      continue;
    }
    // The radius clause is dropped rather than printed as "0 m" if a future
    // ordnance spec stops carrying one — a stated figure that is wrong is worse
    // than a figure that is not stated.
    const radius = Math.round(num(store.radius, 0));
    const gives = `${count} × ${kind === 'bombs' ? 'bomb' : 'rocket'}${
      radius > 0 ? ` · ${radius} m blast radius` : ''
    }`;
    if (!owned.includes(kind)) {
      out.push({
        id: kind,
        label,
        detail: `${gives}. Research the ${label.toLowerCase()} module in the hangar first.`,
        enabled: false,
      });
      continue;
    }
    out.push({
      id: kind,
      label,
      detail: `${gives}. Costs speed and climb while they are still on the wing.`,
      enabled: true,
    });
  }
  return out;
}

// The choice that will actually be flown. A stored loadout whose module is not
// owned is flown clean by mods.js, so the picker says clean too rather than
// lighting a chip the aeroplane will ignore.
function activeLoadout(spec, choices) {
  const cur = currentLoadout(spec.id);
  return choices.some((c) => c.id === cur && c.enabled) ? cur : 'clean';
}

function loadoutStrip(o) {
  const choices = loadoutChoices(o.spec);
  const active = activeLoadout(o.spec, choices);
  const chips = choices
    .map((c) => `<button class="spLoChip${c.id === active ? ' on' : ''}"
        data-lo="${esc(c.id)}" data-lomv="${esc(o.spec.id)}"
        aria-pressed="${c.id === active ? 'true' : 'false'}"
        title="${esc(c.detail)}"${c.enabled ? '' : ' disabled'}>${esc(c.label)}</button>`)
    .join('');
  const detail = choices.find((c) => c.id === active)?.detail || '';
  return `<div class="spLoad">
      <span class="spLoadHead"><span>LOADOUT</span><em>DOES NOT SPAWN</em></span>
      <div class="spLoChips">${chips}</div>
      <span class="spLoDetail" data-lodetail="${esc(o.spec.id)}">${esc(detail)}</span>
    </div>`;
}

function showSpawnScreen(note = '') {
  const state = lastDeath || { canRespawn: false, kills: battle?.playerKills || 0 };
  syncSpawnPoints();
  const b = spawnBudget();
  const points = b ? Math.floor(num(b.points, 0)) : null;
  const options = state.canRespawn ? spawnOptions(b) : [];
  const available = options.filter((o) => o.affordable && !o.spent);

  // An aircraft the player can actually take this spawn gets the stores drawer
  // under its card. A card that is greyed out (destroyed this battle, or not
  // affordable yet) does not: choosing bombs for an aeroplane you cannot get
  // into is noise, and the hangar still has the picker for that.
  let anyPicker = false;
  const cards = options
    .map((o) => {
      const blocked = o.spent || !o.affordable;
      const label = o.spent
        ? 'DESTROYED'
        : o.cost > 0
          ? `-${o.cost} SP`
          : 'FREE SPAWN';
      const picker = o.kind === 'air' && !blocked ? loadoutStrip(o) : '';
      if (picker) anyPicker = true;
      return `
      <div class="spSlot">
        <button class="spCard" data-spawn="${o.id}"${blocked ? ' disabled' : ''}>
          <b>${o.spec.name}</b>
          <small>${o.kind === 'air' ? 'AIRCRAFT' : 'GROUND'} · BR ${brLabel(brOf(o.spec))}</small>
          <span class="cost">${label}</span>
        </button>${picker}
      </div>`;
    })
    .join('');

  // "you cannot afford it" is only honest if it says what the cheapest thing
  // costs and what the player is actually holding
  const cheapest = options.reduce((lo, o) => (!lo || o.cost < lo.cost ? o : lo), null);
  const broke = cheapest
    ? `${cheapest.spec.name} is the cheapest vehicle in your lineup at ${cheapest.cost} SP and you hold ${points ?? 0}.`
    : 'Your lineup has nothing left that fits this battle — add vehicles in the hangar\'s LINEUP screen.';
  const reason = note
    ? `<p class="rsWarn">${note}</p>`
    : !state.canRespawn
      ? '<p>Your team is out of reserves. Watch the rest of the battle or head back to the hangar.</p>'
      : available.length === 0
        ? `<p class="rsWarn">${broke} Spawn points come back from kills, assists, captures and time survived.</p>`
        : '';

  showOverlay(`
    <h2 class="defeat">VEHICLE DESTROYED</h2>
    <p>Kills this battle: ${state.kills}${
      points === null ? '' : ` · spawn points: <span class="spPoints">${points}</span>`
    }</p>
    ${reason}
    ${cards ? `<div class="spGrid">${cards}</div>` : ''}
    ${
      anyPicker
        ? '<p class="spHint">Stores are chosen here, not in the hangar — the LOADOUT chips only change what the aircraft carries. The vehicle button above them is what spawns you.</p>'
        : ''
    }
    <div class="btnRow">
      ${state.canRespawn ? '<button id="hangarBtn">HANGAR</button>' : ''}
      <button id="spectateBtn">SPECTATE (free camera)</button>
      <button id="quitBtn">LEAVE BATTLE</button>
    </div>
  `);

  overlay.querySelectorAll('[data-spawn]').forEach((btn) => {
    btn.addEventListener('click', () => doRespawn(btn.dataset.spawn));
  });

  // Selecting stores writes the choice and repaints that one card's drawer. It
  // deliberately does NOT respawn and does NOT rebuild the screen: a player
  // trying two loadouts should not watch the whole spawn screen flash, and the
  // spawn button must stay exactly where their cursor left it.
  overlay.querySelectorAll('[data-lo]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.lomv;
      const value = btn.dataset.lo;
      if (!id || !value) return;
      try {
        progress.setLoadout(id, value);
      } catch (e) {
        return;
      }
      const strip = btn.closest('.spLoad');
      if (!strip) return;
      strip.querySelectorAll('[data-lo]').forEach((c) => {
        const on = c === btn;
        c.classList.toggle('on', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      const spec = specById(id);
      const detail = spec
        ? loadoutChoices(spec).find((c) => c.id === value)?.detail || ''
        : '';
      const out = strip.querySelector('[data-lodetail]');
      if (out) out.textContent = detail;
    });
  });
  document.getElementById('hangarBtn')?.addEventListener('click', () => {
    hideOverlay();
    hud.hide();
    garage.show({ subtitle: 'Pick your next vehicle', button: 'RESPAWN', respawn: true });
  });
  document.getElementById('spectateBtn')?.addEventListener('click', () => {
    hideOverlay();
    // free-fly camera to watch allies finish the battle
    battle?.startSpectate?.();
    requestLock();
  });
  document.getElementById('quitBtn')?.addEventListener('click', () => {
    leaveBattle();
  });
}

function doRespawn(specId, vehicleType = null) {
  if (!battle || battle.finished) return;
  const spec = specById(specId);
  const kind = vehicleType || (spec ? vehicleKind(spec) : 'ground');
  const b = spawnBudget();
  const cost = spawnCostOf(b, specId);
  if (b && num(b.points, 0) < cost) {
    showSpawnScreen(`${spec?.name || specId} costs ${cost} spawn points.`);
    return;
  }
  initAudio();
  hideOverlay();
  const before = b?.spawned?.length ?? -1;
  if (currentMode === 'combined') battle.playerRespawn(kind, specId);
  else battle.playerRespawn(specId);
  // only pay if the battle did not already take it out of the same budget
  if (b && (b.spawned?.length ?? -1) === before) chargeSpawn(b, specId);
  beginLife(specId);
  applySettings();
  hud.show();
  requestLock();
}

function onBattleEnd(result) {
  endToResults(result);
}

function leaveBattle() {
  endToResults({
    victory: false,
    kills: battle ? battle.playerKills : 0,
    assists: battle ? battle.playerAssists : 0,
    groundKills: battle ? battle.playerGroundKills || 0 : 0,
    hits: battle ? battle.playerHits || 0 : 0,
    caps: battle ? battle.playerCaps || 0 : 0,
    damage: battle ? battle.playerDamage || 0 : 0,
    quit: true,
  });
}

// ---------- results ----------
function settlementFor(result) {
  const battleLosses = Array.isArray(battle?.losses) ? battle.losses : losses;
  const battleSurvived = Array.isArray(battle?.survived) ? battle.survived : survived;
  // battle.usage is the ledger the battle keeps for itself — the ground one
  // carries a live Tank reference and an opening-charge baseline beside the
  // counts, and its consumables are only reconciled against that baseline when
  // the accessor runs. Reading the raw array billed stale charges on the quit
  // path, where the battle never gets to close its own books. usageForSettle()
  // is the shape settle() documents, so it is asked for first and this file's
  // parallel set is only the last resort it was always meant to be.
  const battleUsage =
    typeof battle?.usageForSettle === 'function'
      ? battle.usageForSettle()
      : Array.isArray(result.usage)
        ? result.usage
        : Array.isArray(battle?.usage)
          ? battle.usage
          : usage;
  try {
    return progress.settle({
      victory: !!result.victory && !result.quit,
      quit: !!result.quit,
      kills: result.kills || 0,
      assists: result.assists || 0,
      groundKills: result.groundKills || 0,
      hits: result.hits || 0,
      caps: result.caps || 0,
      // a unitless damage score, not hit points: 100 is one whole vehicle taken
      // out of the battle, so every mode's number buys the same payout
      damage: num(result.damage ?? battle?.playerDamage, 0),
      seconds: battleSeconds(),
      vehicleId: playerSpecId,
      losses: battleLosses,
      survived: battleSurvived,
      usage: battleUsage,
    });
  } catch (e) {
    // never let a settlement bug swallow the results screen
    return null;
  }
}

function settlementTable(s) {
  const gains = [];
  const bills = [];
  for (const it of s.items || []) {
    if (it.crewXp) continue; // crew XP gets its own line; it is neither currency
    // an expense is a Silver-only debit; the early-leave penalty takes RP too
    if (it.silver < 0 && !it.rp) bills.push(it);
    else gains.push(it);
  }
  const row = (it, cls) => `
    <div class="rsRow ${cls}">
      <span>${it.label}</span>
      <span>${money(it.silver)}</span>
      <span class="rsRp">${money(it.rp)}</span>
    </div>`;
  const netCls = s.net > 0 ? 'win' : s.net < 0 ? 'loss' : '';
  const crew = (s.items || []).find((it) => it.crewXp) || (s.crewXp ? { crewXp: s.crewXp } : null);
  return `
    <div class="rsCard">
      <div class="rsRow rsHead"><span>BATTLE INCOME</span><span>⛁ SILVER</span><span>⚙ RP</span></div>
      ${gains.map((it) => row(it, 'rsGain')).join('')}
      ${
        bills.length
          ? `<div class="rsSection">EXPENSES</div>${bills.map((it) => row(it, 'rsBill')).join('')}`
          : '<div class="rsSection">NO EXPENSES — YOU BROUGHT IT ALL HOME</div>'
      }
      <div class="rsRow rsNet ${netCls}">
        <span>NET RESULT</span>
        <span>${s.net === 0 ? '0' : money(s.net)}</span>
        <span class="rsRp">${money(s.grossRp)}</span>
      </div>
      <div class="rsSub">
        Gross ${fmt(s.gross)} ⛁ · bill ${fmt(s.expenses)} ⛁${
          crew?.crewXp ? ` · crew experience +${fmt(crew.crewXp)} XP` : ''
        }<br>
        ${
          s.net < 0
            ? '<span class="rsWarn">This battle cost more than it paid. Repairs and ammunition are billed whether you win or not.</span><br>'
            : ''
        }
        ${
          s.clamped
            ? `<span class="rsWarn">Silver reserve emptied — ${fmt(s.debt)} ⛁ of the bill was written off.</span><br>`
            : ''
        }
        Balance now ${fmt(progress.data.silver)} ⛁ · ${fmt(progress.data.rp)} ⚙ free RP
      </div>
    </div>`;
}

function researchBlock(s) {
  const r = s.research;
  if (!r) {
    return `<div class="rsCard">
      <h4>RESEARCH</h4>
      <div class="rsSub">No research target selected. All ${fmt(s.grossRp)} ⚙ RP from this battle
      went to your free pool — pick a target in the hangar and three quarters of every battle
      goes straight into the next vehicle.</div>
    </div>`;
  }
  const pct = clamp(Math.round(num(r.pct, 0) * 100), 0, 100);
  const left = Math.max(0, num(r.cost, 0) - num(r.spent, 0));
  return `
    <div class="rsCard">
      <h4>RESEARCH</h4>
      <div class="rsRow"><span>${r.name}</span><span></span><span class="rsRp">+${fmt(r.applied)}</span></div>
      <div class="rsBar${r.done ? ' done' : ''}"><div style="width:${pct}%"></div></div>
      <div class="rsSub">
        ${fmt(r.spent)} / ${fmt(r.cost)} ⚙ RP · ${pct}%
        ${
          r.done
            ? '· <b style="color:#7fe089">RESEARCH COMPLETE — buy it in the hangar</b>'
            : `· ${fmt(left)} RP remaining`
        }
      </div>
    </div>`;
}

function endToResults(result) {
  // the battle can end and the player can quit within the same frame; the
  // economy must only be banked once
  if (settled) return;
  settled = true;
  if (battle) battle.finished = true; // freeze the battle behind the overlay
  document.exitPointerLock?.();
  hud.hide();
  updateEngineSound(0, 0, false);
  // distant reports are scheduled seconds ahead; without this they arrive over
  // the results screen
  resetAudio();
  closeLife(!battle?.player?.alive);

  const assists = result.assists || 0;
  const gk = result.groundKills || 0;
  const hits = result.hits || 0;
  const caps = result.caps || 0;
  const s = settlementFor(result);
  const mins = Math.floor(battleSeconds() / 60);
  const secs = Math.floor(battleSeconds() % 60);

  const title = result.quit
    ? '<h2>BATTLE LEFT</h2>'
    : result.victory
      ? '<h2 class="victory">VICTORY</h2>'
      : '<h2 class="defeat">DEFEAT</h2>';

  const summary = [
    `Vehicles destroyed: ${result.kills || 0}`,
    assists > 0 ? `assists: ${assists}` : '',
    gk > 0 ? `ground targets: ${gk}` : '',
    hits > 0 ? `penetrations: ${hits}` : '',
    caps > 0 ? `captures: ${caps}` : '',
    `time: ${mins}:${String(secs).padStart(2, '0')}`,
  ]
    .filter(Boolean)
    .join(' · ');

  showOverlay(`
    ${title}
    <p>${summary}</p>
    ${s ? settlementTable(s) : '<p class="rsWarn">The settlement could not be computed.</p>'}
    ${s ? researchBlock(s) : ''}
    <div class="btnRow">
      <button class="primary" id="againBtn">TO GARAGE</button>
    </div>
  `);
  document.getElementById('againBtn').addEventListener('click', () => {
    if (battle) {
      battle.dispose();
      battle = null;
    }
    // The garage stands up a second WebGL context for the hangar stage, so the
    // battle's full-screen buffers are given back before that happens rather
    // than held across a screen that cannot use them.
    disposePostFX();
    resetAudio();
    budget = null;
    life = null;
    // out of a battle at last: a graphics change the player made mid-match can
    // finally regenerate the procedural textures without stalling one
    pushMaterialQuality();
    hideOverlay();
    garage.show();
  });
}

// ---------- pause on pointer-lock loss ----------
function settingsSliders() {
  const s = progress.settings || {};
  const row = (key, label, max, fallback) => {
    const v = clamp(num(s[key], fallback), 0, max);
    return `
      <div class="setRow">
        <label>${label}</label>
        <input type="range" min="0" max="${max}" step="0.05" value="${v}" data-set="${key}">
        <span class="val" data-val="${key}">${Math.round((v / max) * 100)}%</span>
      </div>`;
  };
  return `
    <div class="rsCard" style="width:min(460px,92vw)">
      <h4>AUDIO &amp; CAMERA</h4>
      ${row('masterVolume', 'MASTER VOLUME', 1, 0.8)}
      ${row('effectsVolume', 'EFFECTS', 1, 1)}
      ${row('engineVolume', 'ENGINES', 1, 0.8)}
      ${row('shakeScale', 'CAMERA SHAKE', 2, 1)}
    </div>
    ${graphicsPanel()}`;
}

// The graphics tier is three states, not a range, so it gets buttons rather
// than a slider. Same card, same row grid, same #overlay scoping.
function graphicsPanel() {
  const cur = gfxWanted || readGraphics();
  const choice = graphicsChoice();
  const btn = (id, label) =>
    `<button data-gfx="${id}"${choice === id ? ' class="on"' : ''}>${label}</button>`;
  const detail = (choice === 'auto' ? `Auto picks ${cur.toUpperCase()} for this machine. ` : '') + {
    low: 'Straight to the screen. No ambient occlusion, no bloom, smallest textures.',
    medium: 'Bloom and filmic output. Half-size procedural textures.',
    high: 'Ambient occlusion, bloom, filmic output and edge antialiasing.',
  }[cur];
  return `
    <div class="rsCard" style="width:min(460px,92vw)">
      <h4>GRAPHICS</h4>
      <div class="setRow gfxRow">
        <label>QUALITY</label>
        <div class="gfxBtns">
          ${btn('auto', 'AUTO')}${btn('low', 'LOW')}${btn('medium', 'MEDIUM')}${btn('high', 'HIGH')}
        </div>
      </div>
      <div class="rsSub">${detail}<br>
      Texture detail changes when the next battle loads — regenerating it now
      would stall this one.</div>
    </div>`;
}

// The sliders live in three places (garage, pause, and whatever comes next), so
// the binding is one function rather than three copies.
function bindSettingsSliders(root) {
  root.querySelectorAll('[data-set]').forEach((el) => {
    el.addEventListener('input', () => {
      const key = el.dataset.set;
      const max = parseFloat(el.max) || 1;
      progress.setSetting(key, parseFloat(el.value));
      const out = root.querySelector(`[data-val="${key}"]`);
      if (out) out.textContent = `${Math.round((parseFloat(el.value) / max) * 100)}%`;
      applySettings();
    });
  });
  root.querySelectorAll('[data-gfx]').forEach((el) => {
    el.addEventListener('click', () => {
      setGraphics(el.dataset.gfx);
      root.querySelectorAll('[data-gfx]').forEach((b) => {
        b.classList.toggle('on', b.dataset.gfx === graphicsChoice());
      });
      // the blurb under the buttons describes the tier, so it moves with them
      const card = el.closest('.rsCard');
      const sub = card?.querySelector('.rsSub');
      if (sub) {
        const tmp = document.createElement('div');
        tmp.innerHTML = graphicsPanel();
        const fresh = tmp.querySelector('.rsSub');
        if (fresh) sub.innerHTML = fresh.innerHTML;
      }
    });
  });
}

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) {
    paused = false;
    return;
  }
  const inBattle =
    battle && !battle.finished && (battle.player.alive || battle.spectate) &&
    overlay.classList.contains('hidden');
  if (inBattle) {
    paused = true;
    showOverlay(`
      <h2>PAUSED</h2>
      <div class="pauseHelp">${hud.helpPanel.innerHTML}</div>
      ${settingsSliders()}
      <div class="btnRow">
        <button class="primary" id="resumeBtn">RESUME</button>
        <button id="quitBtn2">LEAVE BATTLE</button>
      </div>
    `);
    bindSettingsSliders(overlay);
    document.getElementById('resumeBtn').addEventListener('click', () => {
      hideOverlay();
      paused = false;
      requestLock();
    });
    document.getElementById('quitBtn2').addEventListener('click', () => {
      leaveBattle();
    });
  }
});

// click on canvas re-locks during battle (e.g. after spectating)
renderer.domElement.addEventListener('click', () => {
  initAudio();
  if (
    battle && !battle.finished &&
    (battle.player.alive || battle.spectate) &&
    overlay.classList.contains('hidden')
  ) {
    requestLock();
  }
});

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  // the composer owns its own render targets and has to be told separately, or
  // the whole battle keeps being drawn at the old resolution and stretched
  postfx?.setSize(window.innerWidth, window.innerHeight);
  battle?.resize();
});

// ---------- dev server: no reload in the middle of a battle ----------
// Under `npm run dev` Vite reloads the page whenever ANY source file changes
// (no module here accepts hot updates), so an edit made while somebody is
// playing — or while another agent is testing — threw the battle away
// mid-fight. Vite's client awaits every 'vite:beforeFullReload' listener
// before it reloads, so in dev a reload that arrives during a battle is held
// until the battle is over and the player is back in the hangar, with a small
// tag saying a new build is waiting. A production build has no import.meta.hot
// and drops all of this.
let releaseReload = null;
let reloadTag = null;
function showReloadTag() {
  if (reloadTag || typeof document === 'undefined') return;
  reloadTag = document.createElement('div');
  reloadTag.id = 'devReloadTag';
  reloadTag.textContent = 'NEW BUILD READY · LOADS WHEN YOU LEAVE THE BATTLE';
  reloadTag.style.cssText = [
    'position:fixed', 'right:10px', 'bottom:10px', 'z-index:60',
    'padding:4px 8px', 'font:600 10px/1.2 system-ui,Segoe UI,sans-serif',
    'letter-spacing:1.5px', 'color:#24242a', 'background:rgba(236,230,214,0.92)',
    'border:1px solid #24242a', 'pointer-events:none',
  ].join(';');
  document.body.appendChild(reloadTag);
}
function flushDeferredReload() {
  if (!releaseReload || battle) return;
  const go = releaseReload;
  releaseReload = null;
  go();
}
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', () => {
    if (!battle) return undefined;
    showReloadTag();
    return new Promise((resolve) => {
      const prev = releaseReload;
      releaseReload = () => {
        prev?.();
        resolve();
      };
    });
  });
}

// ---------- P-04 shader warm-up ----------
// The first frame of a battle used to compile every program on the main
// thread in one go: 0.8 s with the browser's shader cache warm, 17-23 s on a
// cold cache (Iris Xe, ANGLE / D3D11), with the page frozen. The battle's
// programs are now compiled with renderer.compileAsync (parallel where the
// browser has KHR_parallel_shader_compile) before its first frame: the battle
// neither updates nor draws until they are ready (so no time passes in it),
// and a tag says what is happening. The few programs compileAsync cannot see
// (shadow depth, the post chain) still build on that first frame. The bench
// drives frames itself and is never held. Capped at 30 s, after which the
// first frame compiles whatever is left, as before.
// Fix round: the warm-up used to compile the wrong variants — before the
// environment map existed and for the canvas rather than the chain's buffer
// — so 61 of ~113 programs were rebuilt synchronously on the first frame
// anyway (10.7 s frozen, cold cache). Now the environment is baked first,
// the scene compiles for the chain's buffer, and the chain's own programs
// are warmed too: the first frame builds 9-13 programs (0.5-0.9 s cold).
const shaderWarm = { battle: null, el: null, t0: 0 };
function warmShaders(b) {
  shaderWarm.battle = null;
  if (!b || !b.scene || !b.camera || typeof renderer.compileAsync !== 'function' || externalDriver) return;
  shaderWarm.battle = b;
  shaderWarm.t0 = performance.now();
  const done = () => {
    if (shaderWarm.battle !== b) return;
    shaderWarm.battle = null;
    if (shaderWarm.el) shaderWarm.el.style.display = 'none';
  };
  // the environment map first: programs compiled without it would all be
  // rebuilt (synchronously) once the first frame bakes it
  warmEnvironment(renderer);
  try {
    // ...and compiled for the target the scene is really drawn into (the
    // chain's buffer on medium/high: tone mapping and output colour space are
    // part of every program), plus the chain's own full-screen programs
    const fx = ensurePostFX();
    const rt = (fx && fx.compileTarget && fx.compileTarget()) || null;
    const prevRT = renderer.getRenderTarget();
    let scenePrograms;
    try {
      renderer.setRenderTarget(rt);
      // compileAsync without its uncaught throws when a battle is left mid-way
      scenePrograms = compileQuietly(renderer, b.scene, b.camera);
    } finally {
      renderer.setRenderTarget(prevRT);
    }
    const chainPrograms = fx && fx.warmUp ? fx.warmUp() : null;
    Promise.all([scenePrograms, chainPrograms]).then(done, done);
  } catch (e) {
    done();
    return;
  }
  setTimeout(done, 30000);
  // only worth a word when it is slow (a cold shader cache)
  setTimeout(() => {
    if (shaderWarm.battle !== b || typeof document === 'undefined') return;
    let el = shaderWarm.el;
    if (!el) {
      el = document.createElement('div');
      el.id = 'shaderWarmTag';
      el.style.cssText = [
        'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)', 'z-index:60',
        'padding:8px 14px', 'font:600 11px/1.35 system-ui,Segoe UI,sans-serif', 'letter-spacing:1.5px',
        'color:#24242a', 'background:rgba(236,230,214,0.94)', 'border:1px solid #24242a', 'pointer-events:none',
      ].join(';');
      el.textContent = 'PREPARING SHADERS…';
      document.body.appendChild(el);
      shaderWarm.el = el;
    }
    el.style.display = 'block';
  }, 600);
}
function shadersWarming() {
  return !!battle && shaderWarm.battle === battle && !externalDriver;
}

// ---------- P-04 frame-rate watchdog ----------
// If a battle runs far over the frame budget for ten seconds (three frames in
// four slower than 28 ms, under ~36 fps), the player is told once per battle
// that a lower graphics tier exists. Nothing is changed for them: the tier is
// theirs (pause menu, GRAPHICS). Pauses, overlays and tab switches (gaps over
// 250 ms) never count.
const PERF_SLOW_MS = 28;
const PERF_WINDOW_MS = 10000;
const perfWatch = { battle: null, t: 0, slow: 0, last: NaN, shown: false, el: null, timer: 0 };
function watchFrameRate(live) {
  const now = performance.now();
  const iv = Number.isFinite(perfWatch.last) ? now - perfWatch.last : NaN;
  perfWatch.last = now;
  if (perfWatch.battle !== battle) {
    perfWatch.battle = battle;
    perfWatch.t = 0;
    perfWatch.slow = 0;
    perfWatch.shown = false;
  }
  if (!live || externalDriver || perfWatch.shown || !(iv > 0) || iv > 250) return;
  perfWatch.t += iv;
  if (iv > PERF_SLOW_MS) perfWatch.slow += iv;
  if (perfWatch.t < PERF_WINDOW_MS) return;
  const share = perfWatch.slow / perfWatch.t;
  perfWatch.t = 0;
  perfWatch.slow = 0;
  if (share < 0.75 || gfxWanted === 'low') return;
  // A slow frame rate the graphics tier cannot fix is not worth a word: the
  // chain found that lowering its resolution did not speed frames up (a rAF
  // cap such as a 30 fps energy saver, no GPU timer), or its GPU timer says
  // the chain is well inside budget at full resolution.
  const st = postfx?.autoScaleState;
  if (st && (st.capped || (st.timer && st.scale >= 1 && st.ema < st.target * 0.8))) return;
  perfWatch.shown = true;
  showPerfToast(gfxWanted === 'high' ? 'MEDIUM' : 'LOW');
}
function showPerfToast(lower) {
  if (typeof document === 'undefined') return;
  let el = perfWatch.el;
  if (!el) {
    el = document.createElement('div');
    el.id = 'perfToast';
    el.setAttribute('role', 'status');
    el.style.cssText = [
      // below the compass, score bars and objective line at the top centre
      'position:fixed', 'left:50%', 'top:max(150px, 21vh)', 'transform:translateX(-50%)', 'z-index:60',
      'max-width:calc(100vw - 32px)', 'padding:6px 12px', 'font:600 11px/1.35 system-ui,Segoe UI,sans-serif',
      'letter-spacing:1.2px', 'color:#24242a', 'background:rgba(236,230,214,0.94)',
      'border:1px solid #24242a', 'pointer-events:none', 'text-align:center',
    ].join(';');
    document.body.appendChild(el);
    perfWatch.el = el;
  }
  el.textContent = `LOW FRAME RATE · TRY GRAPHICS QUALITY ${lower} (ESC › GRAPHICS)`;
  el.style.display = 'block';
  clearTimeout(perfWatch.timer);
  perfWatch.timer = setTimeout(() => {
    el.style.display = 'none';
  }, 9000);
}

// ---------- main loop ----------
// K-05: the game is stepped on the display's interval, not by the raw
// callback delta. The pacer (core/postfx.js createFramePacer) reads the rAF
// timestamp, steps exactly the measured refresh interval when the frame came
// on time and pays any difference back slowly, so a ground point no longer
// judders by the +/-2 ms of scheduling noise THREE.Clock carried (N20). A
// hitch still steps its real length, clamped at 0.05 s as before.
const pacer = createFramePacer();
// debug/bench.js drives frames itself (it must keep running in a hidden pane,
// where rAF is throttled); while it does, the rAF loop only keeps itself alive.
let externalDriver = false;
function loop(ts) {
  requestAnimationFrame(loop);
  if (externalDriver) {
    pacer.reset();
    return;
  }
  frame(pacer.step(ts));
}

function frame(dt) {
  if (releaseReload && !battle) flushDeferredReload();
  if (shadersWarming()) {
    // nothing moves and nothing draws until the battle's programs are in
    input.endFrame();
    return;
  }
  const live = battle && !paused && !battle.finished && overlay.classList.contains('hidden');
  watchFrameRate(live);
  if (live) {
    elapsed += dt;
    pushShakeScale();
    // The tactical map is a shell-level overlay, not a battle feature: handling
    // it here (and eating the key) keeps a battle file's own KeyM binding from
    // toggling it straight back, and it never touches pointer lock.
    if (input.pressed('KeyM')) {
      input.justPressed.delete('KeyM');
      hud.toggleBigMap?.();
    }
  }
  if (battle && !paused) {
    battle.update(dt);
  }
  if (battle && debugHooks.afterUpdate) debugHooks.afterUpdate(battle, dt);
  if (battle) {
    // Post-processing draws the world; the HUD is DOM and a 2D canvas stacked
    // over this one, so nothing in the chain can reach it. When the chain is
    // bypassed (low tier), refused to build or died on a frame, this is the
    // plain renderer.render() the game always had.
    const fx = ensurePostFX();
    if (fx) fx.render(dt);
    else renderer.render(battle.scene, battle.camera);
    if (debugHooks.afterRender) debugHooks.afterRender(battle);
    // X-ray hit camera on its own canvas (top-left, above the scope overlay)
    if (battle.pip && battle.pip.active && battle.xray) {
      const w = Math.round(window.innerWidth * 0.22);
      const h = Math.round((w * 9) / 16);
      if (xrayCanvas.width !== w || xrayCanvas.height !== h) {
        xrayRenderer.setSize(w, h, false);
      }
      xrayRenderer.render(battle.xray.scene, battle.xray.camera);
    }
  }
  input.endFrame();
}

// ---------- the shell, as the debug modules see it ----------
// Only built when a debug flag asks for it. Graphics tiers set through it are
// NOT persisted, so a bench run cannot change the player's own setting.
function debugShell() {
  return {
    renderer,
    hud,
    garage,
    input,
    pacer,
    hooks: debugHooks,
    flags: DEBUG_FLAGS,
    get battle() {
      return battle;
    },
    get postfx() {
      return postfx;
    },
    get graphics() {
      return gfxWanted;
    },
    setGraphics(level) {
      gfxOverride = GFX_LEVELS.includes(level) ? level : null;
      applyGraphics(level);
    },
    restoreGraphics() {
      gfxOverride = null;
      applyGraphics(readGraphics());
    },
    startBattle(mode, vehicleType, specId) {
      garage.hide();
      startBattle(mode, vehicleType, specId);
      return battle;
    },
    endBattle() {
      if (battle) {
        battle.finished = true;
        battle.dispose();
        battle = null;
      }
      disposePostFX();
      resetAudio();
      hideOverlay();
      hud.hide();
      pushMaterialQuality();
    },
    showGarage() {
      garage.show();
    },
    // true: the caller drives frames with frame(dt); false: back to rAF
    setExternalDriver(on) {
      externalDriver = !!on;
      pacer.reset();
    },
    frame(dt) {
      frame(dt);
    },
  };
}

applySettings();
garage.show();
requestAnimationFrame(loop);

if (DEBUG_FLAGS.bench) {
  import('./debug/bench.js')
    .then((m) => m.startBench(debugShell()))
    .catch((e) => console.error('[bench] could not start:', e));
}
if (DEBUG_FLAGS.calib) {
  import('./debug/calibration.js')
    .then((m) => m.startCalibration(debugShell()))
    .catch((e) => console.error('[calib] could not start:', e));
}
