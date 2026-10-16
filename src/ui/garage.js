import { TANK_SPECS } from '../vehicles/tanks.js';
import { PLANE_SPECS, displaySpeedKmh } from '../vehicles/planes.js';
import {
  progress, CREW_SKILLS, CREW_QUALS, CREW_MAX_LEVEL, LINEUP_MAX, SPAWN_START,
  specById,
} from '../game/progress.js';
import {
  MOD_TREE, MOD_TIER_COUNT, modStatus, buyModule, applyMods,
  ownedMods, specialShellKey, ammoDistribution, tierGate,
} from '../game/mods.js';
import { brOf, brLabel, brBracket, vehicleKind } from '../game/battleRating.js';
import { vehicleThumb } from './thumbs.js';
import { HangarInspector, inspectorShellCatalogue } from './xray.js';
import { input, ACTIONS, GROUPS, keyLabel } from '../core/input.js';

// ---- settings lane (wave 4): graphics, mouse and controls in the hangar ----
const GFX_DETAIL = {
  auto: 'Asks this machine: integrated graphics or a few CPU cores get the lighter tier.',
  low: 'Straight to the screen: no ambient occlusion, no bloom, smallest textures, 1x pixels. For weak laptops.',
  medium: 'Bloom and filmic output, half-size procedural textures. The balanced choice.',
  high: 'Ambient occlusion, bloom, filmic output, edge antialiasing and motion blur. Needs a real GPU.',
};
const AUDIO_KEYS = ['masterVolume', 'effectsVolume', 'engineVolume', 'shakeScale',
  'showDamageLog', 'motionBlur', 'filmGrain'];
const SENS_ROWS = [
  ['sensTank', 'TANK AIM', 'Turret and camera with the mouse, third-person view.'],
  ['sensTankZoom', 'TANK SNIPER SIGHT', 'Inside the gun sight (Shift). The game already slows it with the zoom.'],
  ['sensAir', 'AIRCRAFT MOUSE AIM', 'The mouse-aim marker the aircraft flies toward, and the cockpit look.'],
  ['sensAirZoom', 'AIRCRAFT AIM ZOOM', 'While the aim zoom (RMB) is held.'],
];
const SENS_RESET = ['sensTank', 'sensTankZoom', 'sensAir', 'sensAirZoom', 'invertYTank', 'invertYAir'];
const GROUP_TITLE = { tank: 'Tank', air: 'Aircraft', common: 'Common' };
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The hangar: the whole main menu, laid out around the vehicle rather than
// around a list of it.
//
//   top bar     — nav, the primary action dead centre, the three balances
//   left rail   — collapse, and the class filters for the research row
//   stage       — the live 3D hangar, with the viewed vehicle named over it,
//                 and the X-RAY / PROTECTION inspection that takes it over
//   right column— battle, vehicle, research, crew, modifications, ammunition
//   bottom dock — nation tabs, the research row, family and screen tabs
//
// Every progression surface the old centred-column garage carried is still
// here; it moved into the margins instead of stacking down the page. The crew,
// lineup and settings screens float over the stage as an overlay so the shell
// never scrolls. X-RAY and PROTECTION ANALYSIS are not overlays: they take the
// stage itself over (see xray.js HangarInspector), drawing with the hangar's
// own renderer, and the research row folds away while they are up.
//
// The stage is drawn by src/ui/hangar3d.js, which is loaded lazily and treated
// as entirely optional — a browser that has run out of WebGL contexts leaves a
// dead canvas behind and every other pixel of this menu still works.

const VERSION = 'Steel Skies 0.1.0';

const fmt = (n) => Math.round(n).toLocaleString('en-US');

// Stat bars are a fraction of a reference vehicle, not of an absolute ceiling,
// so a best-in-class number legitimately comes out above 1 (the Zero pitches
// 1.8 rad/s against a 1.35 reference = 133%). Left unclamped that became a
// width:133% fill, and at a narrow right column it pushed the card 30px wide
// and the overflow guard sliced the ends off every label beside it.
const statPct = (ratio) => Math.max(0, Math.min(100, Math.round((ratio || 0) * 100)));

// Anything that reaches an attribute goes through this; vehicle blurbs are
// prose and prose eventually contains a quote character.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const MODE_LABEL = { ground: 'Ground', air: 'Air', combined: 'Combined Arms' };
const MODE_CHIP = { ground: 'GROUND ASSAULT', air: 'DOGFIGHT', combined: 'COMBINED ARMS' };
const MODE_ORDER = ['ground', 'air', 'combined'];
const DIFF_LABEL = { arcade: 'Arcade', realistic: 'Realistic' };

const SCREEN_TITLE = {
  crew: 'CREW',
  lineup: 'BATTLE LINEUP',
  settings: 'SETTINGS',
  community: 'COMMUNITY',
  help: 'CONTROLS',
};

// Screens that take over the stage. 'vehicles' is the hangar itself.
const OVERLAY_SCREENS = Object.keys(SCREEN_TITLE);

const NATIONS = [
  { id: 'all', name: 'ALL' },
  { id: 'USA', name: 'USA' },
  { id: 'Germany', name: 'GERMANY' },
  { id: 'USSR', name: 'USSR' },
  { id: 'Britain', name: 'BRITAIN' },
  { id: 'Japan', name: 'JAPAN' },
];

// The rail filters. Every class in the game lands in exactly one of them, and
// a filter only appears while its own family is the one being browsed.
const CLASS_FILTERS = [
  { id: 'light', label: 'LIGHT', kind: 'ground', match: (k) => k === 'Light Tank' },
  { id: 'medium', label: 'MEDIUM', kind: 'ground', match: (k) => k === 'Medium Tank' || k === 'Battle Tank' },
  { id: 'heavy', label: 'HEAVY', kind: 'ground', match: (k) => k === 'Heavy Tank' || k === 'Tank Destroyer' },
  { id: 'spaa', label: 'SPAA', kind: 'ground', match: (k) => k === 'SPAA' },
  { id: 'fighter', label: 'FIGHTER', kind: 'air', match: (k) => k.indexOf('Fighter') >= 0 || k === 'Air Superiority' },
  { id: 'attacker', label: 'ATTACKER', kind: 'air', match: (k) => k === 'Attacker' },
];

// ---------------------------------------------------------------------------
// procedural glyphs — every icon in the menu is a path, so the game still ships
// with no image files and no icon font
// ---------------------------------------------------------------------------

const svg = (box, body, cls = '') =>
  `<svg class="gxIco ${cls}" viewBox="${box}" aria-hidden="true">${body}</svg>`;

const ICON = {
  menu: svg('0 0 16 16', '<rect x="2" y="3" width="12" height="1.7"/><rect x="2" y="7.2" width="12" height="1.7"/><rect x="2" y="11.4" width="12" height="1.7"/>'),
  gear: svg('0 0 16 16', '<path d="M8 5.4A2.6 2.6 0 1 0 8 10.6 2.6 2.6 0 0 0 8 5.4zm0 1.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/><path d="M7.1 1.4h1.8l.3 1.6 1.2.5 1.3-.9 1.3 1.3-.9 1.3.5 1.2 1.6.3v1.8l-1.6.3-.5 1.2.9 1.3-1.3 1.3-1.3-.9-1.2.5-.3 1.6H7.1l-.3-1.6-1.2-.5-1.3.9-1.3-1.3.9-1.3-.5-1.2-1.6-.3V7.1l1.6-.3.5-1.2-.9-1.3 1.3-1.3 1.3.9 1.2-.5z"/>'),
  help: svg('0 0 16 16', '<path d="M8 1.2A6.8 6.8 0 1 0 8 14.8 6.8 6.8 0 0 0 8 1.2zm0 1.6a5.2 5.2 0 1 1 0 10.4A5.2 5.2 0 0 1 8 2.8z"/><path d="M7.2 11h1.6v1.5H7.2zm.8-7.2c1.5 0 2.5.9 2.5 2.2 0 1-.5 1.5-1.3 2.1-.5.4-.6.6-.6 1.1v.3H7.2v-.5c0-.9.3-1.4 1-1.9.6-.4.8-.7.8-1.1 0-.5-.4-.9-1-.9s-1.1.4-1.1 1.1H5.4c0-1.4 1-2.4 2.6-2.4z"/>'),
  chevron: svg('0 0 8 12', '<path d="M2 1l5 5-5 5V1z"/>', 'gxChev'),
  collapse: svg('0 0 16 16', '<path d="M6.6 3.2 7.7 4.3 4 8l3.7 3.7-1.1 1.1L1.8 8z"/><path d="M12.6 3.2 13.7 4.3 10 8l3.7 3.7-1.1 1.1L7.8 8z"/>'),
  expand: svg('0 0 16 16', '<path d="M9.4 3.2 8.3 4.3 12 8l-3.7 3.7 1.1 1.1L14.2 8z"/><path d="M3.4 3.2 2.3 4.3 6 8l-3.7 3.7 1.1 1.1L8.2 8z"/>'),
  lock: svg('0 0 12 14', '<path d="M6 0a3.2 3.2 0 0 0-3.2 3.2V5H2v9h8V5H9.2V3.2A3.2 3.2 0 0 0 6 0zm0 1.6c.9 0 1.6.7 1.6 1.6V5H4.4V3.2c0-.9.7-1.6 1.6-1.6z"/>'),
  silver: svg('0 0 14 14', '<path d="M7 .8A6.2 6.2 0 1 0 7 13.2 6.2 6.2 0 0 0 7 .8zm0 1.7a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"/><path d="M7 4.1 8 6.1l2.2.3-1.6 1.5.4 2.2L7 9.1l-2 1 .4-2.2L3.8 6.4 6 6.1z"/>', 'k-silver'),
  rp: svg('0 0 14 14', '<path d="M7 4.6A2.4 2.4 0 1 0 7 9.4 2.4 2.4 0 0 0 7 4.6zm0 1.5a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z"/><path d="M6.2 1h1.6l.3 1.4 1.1.4 1.2-.8 1.1 1.1-.8 1.2.4 1.1 1.4.3v1.6l-1.4.3-.4 1.1.8 1.2-1.1 1.1-1.2-.8-1.1.4-.3 1.4H6.2l-.3-1.4-1.1-.4-1.2.8-1.1-1.1.8-1.2-.4-1.1L1.5 7.8V6.2l1.4-.3.4-1.1-.8-1.2 1.1-1.1 1.2.8 1.1-.4z"/>', 'k-rp'),
  crew: svg('0 0 14 14', '<path d="M7 1.4a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM2.2 12.6c0-2.6 2.1-4.4 4.8-4.4s4.8 1.8 4.8 4.4z"/>', 'k-crew'),
  // a viewfinder round a core: looking inside
  xray: svg('0 0 16 16', '<path d="M1.5 1.5h4.2v1.6H3.1v2.6H1.5zM10.3 1.5h4.2v4.2h-1.6V3.1h-2.6zM1.5 10.3h1.6v2.6h2.6v1.6H1.5zM12.9 10.3h1.6v4.2h-4.2v-1.6h2.6z"/><path d="M8 4.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zm0 1.5a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8z"/>'),
  // a plate in section: protection
  shield: svg('0 0 16 16', '<path d="M8 1 2.2 3.1v4.3c0 3.5 2.4 6.3 5.8 7.6 3.4-1.3 5.8-4.1 5.8-7.6V3.1zm0 1.8 4.2 1.4v3.2c0 2.6-1.7 4.8-4.2 5.9z"/>'),
};

// Generic national markings — a roundel, a bar cross and a star, drawn from
// primitives. They stand for the five nations in the tree, nothing else.
const NATION_MARK = {
  all: svg('0 0 24 24', '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2.4a6.6 6.6 0 1 1 0 13.2 6.6 6.6 0 0 1 0-13.2z"/><circle cx="12" cy="12" r="3.2"/>'),
  USA: svg('0 0 24 24', '<path d="M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2zm0 2a7.6 7.6 0 1 1 0 15.2 7.6 7.6 0 0 1 0-15.2z"/><path d="M12 5.6l1.9 5h5.1l-4.1 3.2 1.6 5.1-4.5-3.2-4.5 3.2 1.6-5.1L5 10.6h5.1z"/>'),
  Germany: svg('0 0 24 24', '<path d="M9.6 2h4.8v7.6H22v4.8h-7.6V22H9.6v-7.6H2V9.6h7.6z"/>'),
  USSR: svg('0 0 24 24', '<path d="M12 2.2l2.7 7.2h7.5l-6.1 4.6 2.4 7.4L12 16.7l-6.5 4.7 2.4-7.4-6.1-4.6h7.5z"/>'),
  Britain: svg('0 0 24 24', '<path d="M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2zm0 1.9a7.7 7.7 0 1 1 0 15.4 7.7 7.7 0 0 1 0-15.4z"/><path d="M12 6.6a5.4 5.4 0 1 0 0 10.8 5.4 5.4 0 0 0 0-10.8zm0 1.9a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z"/><circle cx="12" cy="12" r="2.2"/>'),
  Japan: svg('0 0 24 24', '<path d="M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2zm0 2.2a7.4 7.4 0 1 1 0 14.8 7.4 7.4 0 0 1 0-14.8z"/><circle cx="12" cy="12" r="5"/>'),
};

// Class silhouettes for the rail. Side-on for the ground vehicles, plan view
// for the aircraft, which is how anyone reads them at 20 pixels.
const CLASS_ICON = {
  light: svg('0 0 26 16', '<path d="M2 11h22v3H2z"/><path d="M5 7h13v3H5z"/><path d="M9 4h6v3H9z"/><path d="M14 5h9v1.4h-9z"/>'),
  medium: svg('0 0 26 16', '<path d="M1 11h24v3.4H1z"/><path d="M3 7h18v3.6H3z"/><path d="M8 3.4h8V7H8z"/><path d="M13 4.4h12v1.6H13z"/>'),
  heavy: svg('0 0 26 16', '<path d="M1 10.4h24v4.2H1z"/><path d="M2 6h21v4H2z"/><path d="M7 2.2h10V6H7z"/><path d="M12 3.2h13v1.9H12z"/>'),
  spaa: svg('0 0 26 16', '<path d="M2 11h22v3.4H2z"/><path d="M5 7.4h14v3.2H5z"/><path d="M8.6 2h1.5v5.2H8.6zm2.8 0h1.5v5.2h-1.5zm2.8 0h1.5v5.2h-1.5z"/>'),
  fighter: svg('0 0 26 16', '<path d="M12.2 1h1.6l1 5.2 9.2 2.4v1.7l-9.2-1.3v3.1l3 1.6V15l-4.8-1.4L8.2 15v-1.3l3-1.6V9l-9.2 1.3V8.6L11.2 6.2z"/>'),
  attacker: svg('0 0 26 16', '<path d="M11.6 1h2.8l1.1 5.4 8.5 2.2v2l-8.5-1.1.2 3.3 2.8 1.5V15l-5.4-1.3L7.7 15v-.7l2.8-1.5.2-3.3L2.2 10.6v-2l8.5-2.2z"/><path d="M4.4 7.2h3v2.2h-3zm14.2 0h3v2.2h-3z"/>'),
};

export class Garage {
  constructor(onStart) {
    this.root = document.getElementById('garage');
    this.onStart = onStart; // (battleMode, vehicleType, specId)
    this.battleMode = progress.data.battleMode || 'ground';
    this.mode = this.battleMode === 'air' ? 'air' : 'ground';
    this.respawnLock = false;
    // 'vehicles' | 'crew' | 'lineup' | 'settings' | 'community' | 'help'
    // ('armour' is still accepted by setScreen and opens the stage inspection)
    this.screen = 'vehicles';
    this.crewVehicle = null; // which vehicle the crew screen shows
    this.inspector = null; // HangarInspector while X-RAY / PROTECTION is up
    this.inspectId = '';
    this.nation = 'all';
    this.classFilter = null;
    this.collapsed = false;
    this.viewed = null; // the vehicle on the stage; not always the one you own
    this.subtitle = 'Select your vehicle';
    this.buttonLabel = 'TO BATTLE';
    this.hangar = null; // Hangar3D, once it has loaded and succeeded
    this.hangarKey = ''; // last vehicle handed to it, so we do not reload it
    this.hangarRunning = false;
    this.disposed = false;
    this.root.classList.add('gx');
    this.buildSkeleton();
  }

  // ---------------------------------------------------------------------------
  // data helpers
  // ---------------------------------------------------------------------------

  allowedTabs() {
    if (this.battleMode === 'ground') return ['ground'];
    if (this.battleMode === 'air') return ['air'];
    return ['ground', 'air'];
  }

  specsFor(mode) {
    const specs = Object.values(mode === 'ground' ? TANK_SPECS : PLANE_SPECS);
    return specs.sort((a, b) => a.tier - b.tier || brOf(a) - brOf(b));
  }

  // The research row after the rail and the nation tabs have had their say.
  filteredSpecs() {
    const filter = CLASS_FILTERS.find((c) => c.id === this.classFilter);
    return this.specsFor(this.mode).filter((s) => {
      if (this.nation !== 'all' && s.nation !== this.nation) return false;
      if (filter && filter.kind === this.mode && !filter.match(s.klass || '')) return false;
      return true;
    });
  }

  // The vehicle the stage, the hero line and the right column are describing.
  // Usually the one selected for battle; a locked machine can be inspected
  // without owning it, which is the whole point of a research tree.
  viewedSpec() {
    if (this.viewed) {
      const spec = specById(this.viewed);
      // a vehicle held over from the other family would put a Spitfire on the
      // stage while the tank tree is showing
      if (spec && vehicleKind(spec) === this.mode) return spec;
    }
    return specById(progress.getSelected(this.mode)) || this.specsFor(this.mode)[0] || null;
  }

  battleSpec() {
    return specById(progress.getSelected(this.mode));
  }

  // ---------------------------------------------------------------------------
  // skeleton
  // ---------------------------------------------------------------------------

  buildSkeleton() {
    this.root.innerHTML = `
      <header class="gxTop">
        <div class="gxTopL">
          <button class="gxGlyph" data-act="collapse" title="Hide the panels and look at the vehicle">${ICON.menu}</button>
          <button class="gxTopNav" data-screen="vehicles">BATTLES</button>
          <button class="gxTopNav" data-screen="community">COMMUNITY</button>
        </div>
        <div class="gxTopC">
          <button id="battleBtn">TO BATTLE</button>
          <div class="gxStrip">
            <span id="gxModeStrip"></span>
            <small id="garageSubtitle">Select your vehicle</small>
          </div>
        </div>
        <div class="gxTopR">
          <span class="gxCur" id="balSilver" title="Silver — vehicles, modifications and the repair bill"></span>
          <span class="gxCur" id="balRp" title="Research Points — the tree and its modifications"></span>
          <span class="gxCur" id="balCrew" title="Crew XP — skills, spent per vehicle"></span>
          <button class="gxGlyph" data-screen="settings" title="Settings">${ICON.gear}</button>
          <button class="gxGlyph" data-screen="help" title="Controls">${ICON.help}</button>
        </div>
        <span class="gxVersion">${VERSION}</span>
      </header>

      <nav class="gxRail" id="gxRail"></nav>

      <section class="gxStage" id="gxStage">
        <canvas id="hangarCanvas"></canvas>
        <div class="gxStageTools" id="gxStageTools">
          <button class="gxInspectBtn" data-inspect="xray"
            title="X-RAY — crew, ammunition, fuel, engine and every module where the damage model puts it">${ICON.xray}<span>X-RAY</span></button>
          <button class="gxInspectBtn" data-inspect="armour"
            title="PROTECTION ANALYSIS — armour thickness, and what any shell does to it from any angle">${ICON.shield}<span>PROTECTION</span></button>
        </div>
        <div class="gxHero" id="gxHero"></div>
      </section>

      <aside class="gxRight" id="gxRight"></aside>

      <div class="gxOverlay hidden" id="gxOverlay">
        <div class="gxOverlayHead">
          <h3 id="gxOverlayTitle">CREW</h3>
          <button class="gxGlyph" data-act="closeoverlay" title="Back to the hangar">${ICON.expand}</button>
        </div>
        <div class="gxOverlayBody" id="gxOverlayBody"></div>
      </div>

      <footer class="gxDock">
        <div class="gxNations" id="gxNations"></div>
        <div class="gxResearchWrap"><div class="gxResearchRow" id="gxResearchRow"></div></div>
        <div class="gxBottomBar">
          <div class="gxFam">
            <button class="modeTab" data-modetab="ground">TANKS</button>
            <button class="modeTab" data-modetab="air">PLANES</button>
          </div>
          <div class="gxScreens">
            <button class="gxScreenTab" data-screen="vehicles">HANGAR</button>
            <button class="gxScreenTab" data-screen="crew">CREW</button>
            <button class="gxScreenTab" data-inspect="xray">X-RAY</button>
            <button class="gxScreenTab" data-inspect="armour">PROTECTION</button>
            <button class="gxScreenTab" data-screen="lineup">LINEUP</button>
            <button class="gxScreenTab" data-screen="settings">SETTINGS</button>
          </div>
          <div class="gxLineupSum" id="gxLineupSum"></div>
        </div>
      </footer>
    `;

    this.root.querySelector('#battleBtn').addEventListener('click', () => {
      this.hide();
      this.onStart(this.battleMode, this.mode, progress.getSelected(this.mode));
    });
    // one delegated listener per event: every panel below is rebuilt from
    // scratch on each render, and re-binding a hundred buttons each time is
    // both slower and easier to get wrong
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('input', (e) => this.onInput(e));

    // The inspection follows the stage canvas on its own (the hangar hands it
    // the canvas size every frame), so a resize only has to reach the hangar.
    this.onResize = () => this.callHangar('resize');
    window.addEventListener('resize', this.onResize);
    // Esc leaves the inspection, the way the button does
    this.onKey = (e) => {
      if (e.key !== 'Escape' || !this.inspector || this.root.classList.contains('hidden')) return;
      e.preventDefault();
      this.closeInspector();
    };
    window.addEventListener('keydown', this.onKey);
    this.listening = null; // settings lane: the logical code a key box is waiting for
    this.bindPending = null; // { code, phys, conflicts } | { message }
    this.installBindCapture();

    this.buildRail();
    this.buildNations();
    this.initHangar();
    this.render();
  }

  buildRail() {
    const rail = this.root.querySelector('#gxRail');
    const filters = CLASS_FILTERS
      .map((c) => `<button class="gxRailBtn gxClassBtn" data-class="${c.id}"
        title="${c.label} — show only these">${CLASS_ICON[c.id]}</button>`)
      .join('');
    rail.innerHTML = `
      <button class="gxRailBtn" data-act="collapse" id="gxCollapseBtn"
        title="Hide the panels and look at the vehicle">${ICON.collapse}</button>
      <span class="gxRailSep"></span>
      ${filters}`;
  }

  buildNations() {
    const el = this.root.querySelector('#gxNations');
    el.innerHTML = NATIONS
      .map((n) => `<button class="gxNation" data-nation="${n.id}" title="${n.name}">
        ${NATION_MARK[n.id]}<span>${n.name}</span></button>`)
      .join('');
  }

  // ---------------------------------------------------------------------------
  // the live 3D stage
  // ---------------------------------------------------------------------------

  // hangar3d.js is loaded lazily and every call into it is guarded: a second
  // WebGL context is exactly the thing a browser refuses when it is short of
  // them, and a menu that dies with its background is a menu nobody can use.
  initHangar() {
    const canvas = this.root.querySelector('#hangarCanvas');
    if (!canvas) return;
    import('./hangar3d.js')
      .then((mod) => {
        const Ctor = mod && mod.Hangar3D;
        if (!Ctor || this.disposed) return;
        this.hangar = new Ctor(canvas);
        // the player's GRAPHICS QUALITY choice; AUTO keeps the old guess (a
        // machine with few cores is usually a machine with a weak GPU too)
        this.callHangar('setQuality', this.hangarTier());
        this.syncHangarLens();
        this.hangarKey = '';
        this.syncHangar();
        if (!this.root.classList.contains('hidden')) this.startHangar();
      })
      .catch(() => {
        // no hangar module, or it threw on load: the stage stays empty
        this.hangar = null;
      });
  }

  callHangar(method, ...args) {
    if (!this.hangar || typeof this.hangar[method] !== 'function') return null;
    try {
      return this.hangar[method](...args);
    } catch {
      return null;
    }
  }

  startHangar() {
    if (!this.hangar || this.hangarRunning) return;
    this.hangarRunning = true;
    this.callHangar('resize');
    this.callHangar('start');
  }

  stopHangar() {
    if (!this.hangar || !this.hangarRunning) return;
    this.hangarRunning = false;
    this.callHangar('stop');
  }

  syncHangar() {
    const spec = this.viewedSpec();
    if (!spec) return;
    const kind = this.mode === 'air' ? 'air' : 'ground';
    const key = `${kind}:${spec.id}`;
    if (key === this.hangarKey) return;
    this.hangarKey = key;
    this.callHangar('setVehicle', spec, kind);
  }

  // ---------------------------------------------------------------------------
  // render
  // ---------------------------------------------------------------------------

  // Rebuild every surface, then sync the chrome around them. An open
  // inspection survives this: it lives on the stage, not in any panel rebuilt
  // here, and it draws with the hangar's renderer rather than a context of its
  // own.
  render() {
    this.renderResearchRow();
    this.renderRight();
    this.renderHero();
    this.renderOverlay();
    this.refresh();
    this.syncHangar();
  }

  // -------------------------------------------------------------------------
  // inspection — X-RAY and PROTECTION ANALYSIS over the stage
  // -------------------------------------------------------------------------

  // The vehicle on the stage, as it would actually be fielded: a researched
  // one with its modifications (improved rounds, a doubled pilot, a faster
  // repair crew), anything else as the tree describes it.
  inspectSpec(base, kind) {
    if (!progress.isOwned(base.id)) return base;
    try {
      return applyMods(base, kind) || base;
    } catch {
      return base;
    }
  }

  // The rounds the protection analysis can fire: the player's own selected tank
  // first, as fitted, then every shell of every tank in the tree.
  shellCatalogue() {
    let own = null;
    const sel = specById(progress.getSelected('ground'));
    if (sel && sel.hull) own = this.inspectSpec(sel, 'ground');
    const groups = inspectorShellCatalogue(TANK_SPECS, own);
    let def = null;
    if (own && own.shells) {
      // the round the gun carries most of is the one it fires most
      let best = -1;
      for (const k of Object.keys(own.shells)) {
        const c = own.shells[k].count || 0;
        if (c > best) { best = c; def = `own:${k}`; }
      }
    }
    return { groups, def };
  }

  openInspector(mode) {
    const base = this.viewedSpec();
    if (!base) return;
    const kind = this.mode === 'air' ? 'air' : 'ground';
    const want = kind === 'ground' && mode === 'armour' ? 'armour' : 'xray';
    const id = `${kind}:${base.id}`;
    if (this.inspector && this.inspectId === id) {
      this.inspector.setMode(want);
      this.refresh();
      return;
    }
    this.closeInspector(true);
    if (OVERLAY_SCREENS.includes(this.screen)) {
      this.screen = 'vehicles';
      this.renderOverlay();
    }
    const spec = this.inspectSpec(base, kind);
    const owned = progress.isOwned(base.id);
    const { groups, def } = this.shellCatalogue();
    const stage = this.root.querySelector('#gxStage');
    // The stage canvas and its renderer are the hangar's; the inspection draws
    // through them, so it never asks the browser for a WebGL context. Only a
    // hangar that failed to start leaves it to make its own.
    const shared = this.hangar && !this.hangar.dead && this.hangar.renderer ? this.hangar : null;
    this.root.classList.add('gxInspecting');
    try {
      this.inspector = new HangarInspector({
        host: stage,
        spec,
        kind,
        mode: want,
        shells: groups,
        defaultShell: def,
        title: {
          name: base.name,
          sub: `${base.klass || ''} · ${base.nation || ''} · BR ${brLabel(brOf(base))} · TIER ${base.tier}${owned ? ' · AS FITTED' : ' · NOT RESEARCHED'}`,
        },
        onExit: () => this.closeInspector(),
        ownRenderer: !shared,
      });
    } catch (err) {
      console.warn('[garage] inspection could not open:', err);
      this.inspector = null;
      this.root.classList.remove('gxInspecting');
      this.refresh();
      return;
    }
    this.inspectId = id;
    if (shared) {
      this.callHangar('setOverlay', this.inspector);
      this.startHangar();
      this.callHangar('resize');
    } else {
      this.inspector.start();
    }
    this.refresh();
  }

  closeInspector(silent = false) {
    if (!this.inspector) return;
    this.callHangar('setOverlay', null);
    try {
      this.inspector.dispose();
    } catch {
      /* it is going away regardless */
    }
    this.inspector = null;
    this.inspectId = '';
    this.root.classList.remove('gxInspecting');
    this.callHangar('resize');
    if (!silent) this.refresh();
  }

  // -------------------------------------------------------------------------
  // stat blocks — unchanged numbers, new home
  // -------------------------------------------------------------------------

  statRows(s, mode) {
    if (mode === 'ground') {
      const fire = statPct(s.shells.AP.pen / 156);
      const arm = statPct(s.armor.hull.front / 115);
      const mob = statPct(s.maxSpeed / 18);
      return `
      <div class="statRow"><label>FIREPOWER</label><div class="bar"><div style="width:${fire}%"></div></div></div>
      <div class="statRow"><label>ARMOR</label><div class="bar"><div style="width:${arm}%"></div></div></div>
      <div class="statRow"><label>MOBILITY</label><div class="bar"><div style="width:${mob}%"></div></div></div>
      <div class="numbers">
        Gun: ${s.shells.AP.pen} mm pen · ${s.reload.toFixed(1)}s reload<br>
        Armor: ${s.armor.hull.front} / ${s.armor.hull.side} / ${s.armor.hull.rear} mm<br>
        Top speed: ${Math.round(s.maxSpeed * 3.6)} km/h · Crew: ${s.crew}
      </div>`;
    }
    const fire = statPct((s.gun.dmg * s.gun.rof) / 68);
    const agi = statPct(s.pitchRate / 1.35);
    const spd = statPct(s.maxSpeed / 88);
    return `
    <div class="statRow"><label>FIREPOWER</label><div class="bar"><div style="width:${fire}%"></div></div></div>
    <div class="statRow"><label>AGILITY</label><div class="bar"><div style="width:${agi}%"></div></div></div>
    <div class="statRow"><label>SPEED</label><div class="bar"><div style="width:${spd}%"></div></div></div>
    <div class="numbers">
      Guns: ${(s.gun.dmg * s.gun.rof).toFixed(0)} dmg/s · ${s.gun.ammo} rounds<br>
      Top speed: ${Math.round(displaySpeedKmh(s.maxSpeed))} km/h IAS · Airframe: ${s.hp} HP
      ${s.bombs ? `<br>Bombs: ${s.bombs.count} × ${s.bombs.radius}m blast` : ''}
    </div>`;
  }

  // Battle Rating, crew training and the two bills the vehicle brings with it.
  badgeRow(s) {
    const crewLvl = progress.crewTotalLevel(s.id);
    const maxLvl = CREW_SKILLS.length * CREW_MAX_LEVEL;
    const qual = progress.crewQual(s.id);
    const repair = progress.repairCost(s, true);
    return `<div class="gxBadges">
      <span class="gxBr" title="Battle Rating — matchmaking bracket ${brBracket(brOf(s)).label}">BR ${brLabel(brOf(s))}</span>
      <span class="gxCrewTag" title="Trained crew skill levels and qualification">CREW ${crewLvl}/${maxLvl}${qual ? ` · ${CREW_QUALS[qual].name.toUpperCase()}` : ''}</span>
      <span class="gxCostTag" title="Repair bill if this vehicle is destroyed · spawn point cost">REPAIR ${fmt(repair)} ⛁ · SP ${progress.spawnCost(s)}</span>
    </div>`;
  }

  // The whole modification tree for one vehicle: one row per tier, each row
  // locked shut until enough of the tier above it is installed.
  modsRow(s, mode) {
    const has = ownedMods(s.id);
    const special = mode === 'ground' ? specialShellKey(s) : null;
    let html = '';
    for (let t = 1; t <= MOD_TIER_COUNT; t++) {
      const defs = MOD_TREE[mode][t - 1].filter((m) => m.id !== 'shell3' || special);
      if (!defs.length) continue;
      const gate = tierGate(s.id, mode, t);
      const head = gate.unlocked
        ? '<em class="open">OPEN</em>'
        : `<em>NEEDS ${gate.need - gate.have} MORE FROM TIER ${t - 1}</em>`;
      const chips = defs
        .map((m) => {
          const st = modStatus(s, mode, m);
          const got = has.includes(m.id);
          const label = m.id === 'shell3' ? special : m.name;
          const title = got
            ? `${m.name} — ${m.desc} (installed)`
            : st.tierUnlocked
              ? `${m.name} — ${m.desc} · ${fmt(st.cost.rp)} RP + ${fmt(st.cost.silver)} ⛁`
              : `${m.name} — locked until tier ${t - 1} is ${gate.need} deep`;
          return `<button class="modChip${got ? ' got' : ''}${st.tierUnlocked ? '' : ' gxShut'}"
            data-mod="${m.id}" data-mv="${s.id}" title="${esc(title)}"
            ${got || st.buyable ? '' : 'disabled'}>${esc(label)}</button>`;
        })
        .join('');
      html += `<div class="modsRow gxTier">
        <span class="gxTierHead"><span>TIER ${t}</span>${head}</span>${chips}</div>`;
    }
    return html;
  }

  // pre-battle shell loadout: distribute rounds across unlocked shell types
  ammoRows(s) {
    const dist = ammoDistribution(s);
    const keys = Object.keys(dist);
    const total = keys.reduce((a, k) => a + dist[k], 0);
    const bill = keys.reduce((a, k) => a + progress.shellCost(s, k) * dist[k], 0);
    const rows = keys
      .map(
        (k) => `<div class="ammoRow"><span>${k}</span>
        <button class="ammoBtn" data-mv="${s.id}" data-shell="${k}" data-d="-5">−</button>
        <b>${dist[k]}</b>
        <button class="ammoBtn" data-mv="${s.id}" data-shell="${k}" data-d="5">+</button></div>`,
      )
      .join('');
    return `<div class="ammoBox">${rows}<div class="ammoTotal">TOTAL ${total} / ${s.ammoCap} · FULL LOAD ${fmt(bill)} ⛁</div></div>`;
  }

  // weapon loadout selector for planes (bombs/rockets need their module)
  loadoutRow(s) {
    const has = ownedMods(s.id);
    const cur = progress.getLoadout(s.id);
    const opt = (id, label, enabled) =>
      `<button class="modChip loChip${cur === id ? ' got' : ''}"
        data-lo="${id}" data-mv="${s.id}"
        title="${enabled ? 'Select loadout' : 'Research the module first'}"
        ${enabled ? '' : 'disabled'}>${label}</button>`;
    return `<div class="modsRow">${opt('clean', 'CLEAN', true)}${opt('bombs', 'BOMBS', has.includes('bombs'))}${opt('rockets', 'RKT', has.includes('rockets'))}</div>`;
  }

  // Research bar, target button and the purchase for a vehicle not owned yet.
  researchRow(s) {
    const prog = progress.researchProgress(s);
    const researchable = progress.isResearchable(s);
    const blocked = progress.researchBlockedBy(s);
    const isTarget = progress.getResearchTarget() === s.id;
    if (!researchable) {
      return `<div class="gxResearch">
        <div class="gxBar"><div style="width:0%"></div></div>
        <div class="gxLine gxLocked"><span>${esc(blocked || 'Locked')}</span><span>LOCKED</span></div>
      </div>`;
    }
    const bar = `<div class="gxResearch">
      <div class="gxBar"><div style="width:${Math.round(prog.pct * 100)}%"></div></div>
      <div class="gxLine"><span>${fmt(prog.spent)} / ${fmt(prog.cost)} RP</span><span>${Math.round(prog.pct * 100)}%</span></div>
      ${prog.done ? '' : `<button class="gxTargetBtn${isTarget ? ' active' : ''}" data-target="${s.id}">${isTarget ? '★ RESEARCHING — 75% OF RP' : 'RESEARCH THIS'}</button>`}
    </div>`;
    const canBuy = progress.canAfford(s);
    const btn = `<button class="unlockBtn" data-unlock="${s.id}" ${canBuy ? '' : 'disabled'}>
        ${prog.done ? 'PURCHASE' : 'UNLOCK'} — ${fmt(s.price.silver)} ⛁${prog.done ? '' : ` · ${fmt(progress.researchRemaining(s))} RP`}
      </button>`;
    return bar + btn;
  }

  // -------------------------------------------------------------------------
  // bottom dock — the research row
  // -------------------------------------------------------------------------

  renderResearchRow() {
    const row = this.root.querySelector('#gxResearchRow');
    const mode = this.mode;
    const list = this.filteredSpecs();
    if (!list.length) {
      row.innerHTML = '<div class="gxEmpty">No vehicles match this filter.</div>';
      return;
    }
    const viewed = this.viewedSpec();
    const selected = progress.getSelected(mode);
    row.innerHTML = list.map((s) => {
      if (!s.price) progress.ensureOwned(s.id);
      const owned = progress.isOwned(s.id);
      const prog = owned ? null : progress.researchProgress(s);
      const researchable = progress.isResearchable(s);
      const isTarget = progress.getResearchTarget() === s.id;
      let foot;
      if (owned) {
        foot = `<span class="gxVOwned">${s.id === selected ? 'IN BATTLE' : 'IN HANGAR'}</span>`;
      } else if (!researchable) {
        foot = `<span class="gxVLock">${ICON.lock}${esc(progress.researchBlockedBy(s) || 'LOCKED')}</span>`;
      } else {
        foot = `<span class="gxVCost">${fmt(s.price.silver)} ⛁ · ${fmt(progress.researchRemaining(s))} RP</span>
          <button class="gxVAct${isTarget ? ' active' : ''}" data-target="${s.id}"
            title="Send 75% of every battle's RP into this vehicle">${isTarget ? '★ RESEARCHING' : 'RESEARCH'}</button>`;
      }
      const bar = owned ? '' :
        `<div class="gxVBar"><div style="width:${Math.round((prog ? prog.pct : 0) * 100)}%"></div></div>`;
      return `<div class="gxVCard${owned ? '' : ' locked'}${viewed && viewed.id === s.id ? ' viewed' : ''}${s.id === selected ? ' selected' : ''}"
        data-pick="${s.id}" title="${esc(s.name)} — ${esc(s.desc || '')}">
        <img class="gxVThumb" src="${vehicleThumb(s, mode)}" alt="${esc(s.name)}">
        <span class="gxVName">${esc(s.name)}</span>
        <span class="gxVMeta"><i class="gxVBr">BR ${brLabel(brOf(s))}</i><i>TIER ${s.tier}</i></span>
        ${bar}
        <span class="gxVFoot">${foot}</span>
      </div>`;
    }).join('');
  }

  // -------------------------------------------------------------------------
  // stage hero
  // -------------------------------------------------------------------------

  renderHero() {
    const hero = this.root.querySelector('#gxHero');
    const s = this.viewedSpec();
    if (!s) {
      hero.innerHTML = '';
      return;
    }
    const owned = progress.isOwned(s.id);
    hero.innerHTML = `
      <div class="gxHeroTop">
        <span class="gxHeroName">${esc(s.name)}</span>
        <span class="gxBr gxHeroBr" title="Matchmaking bracket ${brBracket(brOf(s)).label}">BR ${brLabel(brOf(s))}</span>
      </div>
      <div class="gxHeroSub">${esc(s.klass || '')} · ${esc(s.nation || '')} · TIER ${s.tier}${owned ? '' : ' · NOT RESEARCHED'}</div>
      <div class="gxHeroDesc">${esc(s.desc || '')}</div>`;
  }

  // -------------------------------------------------------------------------
  // right column
  // -------------------------------------------------------------------------

  card(title, body, opts = {}) {
    const act = opts.act ? ` data-act="${opts.act}"` : '';
    return `<div class="gxCard${opts.act ? ' clickable' : ''}"${act}${opts.title ? ` title="${esc(opts.title)}"` : ''}>
      <div class="gxCardHead"><span>${title}</span>${opts.note ? `<b>${opts.note}</b>` : ''}${ICON.chevron}</div>
      <div class="gxCardBody">${body}</div>
    </div>`;
  }

  renderRight() {
    const col = this.root.querySelector('#gxRight');
    const s = this.viewedSpec();
    const mode = this.mode;
    const cards = [];

    // ---- current battle ----
    const battleSpec = this.battleSpec();
    const br = battleSpec ? brOf(battleSpec) : 1;
    const bracket = brBracket(br);
    const diff = progress.getDifficulty();
    const modeChips = MODE_ORDER
      .map((m) => `<button class="bmChip" data-bm="${m}"${this.respawnLock ? ' disabled' : ''}>${MODE_CHIP[m]}</button>`)
      .join('');
    const diffChips = ['arcade', 'realistic']
      .map((d) => `<button class="bmChip diffChip" data-diff="${d}"${this.respawnLock ? ' disabled' : ''}>${d.toUpperCase()}</button>`)
      .join('');
    cards.push(this.card('CURRENT BATTLE', `
      <div class="gxBattleLine"><b>${MODE_LABEL[this.battleMode]} ${DIFF_LABEL[diff]}</b></div>
      <div class="gxHint">Matchmaking bracket BR ${bracket.label}${this.respawnLock ? ' · locked for this battle' : ''}</div>
      <div class="gxChips">${modeChips}</div>
      <div class="gxChips">${diffChips}</div>`,
    { act: this.respawnLock ? null : 'cyclemode', title: 'Click to cycle the battle mode' }));

    if (s) {
      // ---- the vehicle itself ----
      cards.push(this.card('VEHICLE', `
        <div class="gxCardTitle">${esc(s.name)}</div>
        ${this.badgeRow(s)}
        ${this.statRows(s, mode)}`));

      // ---- research ----
      const targetId = progress.getResearchTarget();
      let researchBody;
      if (!progress.isOwned(s.id)) {
        researchBody = `<div class="gxCardTitle">${esc(s.name)}</div>${this.researchRow(s)}`;
      } else if (targetId) {
        const t = specById(targetId);
        const prog = progress.researchProgress(t);
        researchBody = `<div class="gxCardTitle">${esc(t.name)}</div>
          <div class="gxHint">TIER ${t.tier} · BR ${brLabel(brOf(t))} · ${esc(t.nation || '')}</div>
          <div class="gxResearch">
            <div class="gxBar"><div style="width:${Math.round(prog.pct * 100)}%"></div></div>
            <div class="gxLine"><span>${fmt(prog.spent)} / ${fmt(prog.cost)} RP</span><span>${Math.round(prog.pct * 100)}%</span></div>
          </div>
          <div class="gxHint">Purchase costs ${fmt(t.price.silver)} ⛁ once the bar fills. 75% of the RP you earn goes here.</div>
          <button class="gxTargetBtn active" data-target="${t.id}">★ STOP RESEARCHING</button>`;
      } else {
        researchBody = `<div class="gxHint">No research target. Pick a locked vehicle in the row below and press RESEARCH — three quarters of every battle's RP goes into it, and the rest stays free for modifications.</div>`;
      }
      cards.push(this.card('RESEARCH', researchBody));

      // ---- crew ----
      const crewLvl = progress.crewTotalLevel(s.id);
      const maxLvl = CREW_SKILLS.length * CREW_MAX_LEVEL;
      const qual = progress.crewQual(s.id);
      cards.push(this.card('CREW', `
        <div class="gxCardTitle">CREW ${crewLvl} / ${maxLvl}</div>
        <div class="gxBar"><div style="width:${statPct(crewLvl / maxLvl)}%;background:var(--gx-green)"></div></div>
        <div class="gxHint">${CREW_QUALS[qual].name} qualification · ${fmt(progress.data.crewXp)} Crew XP unspent</div>`,
      { act: 'screen:crew', note: CREW_QUALS[qual].name.toUpperCase(), title: 'Open the crew screen' }));

      // ---- modifications ----
      if (progress.isOwned(s.id)) {
        const has = ownedMods(s.id);
        const special = mode === 'ground' ? specialShellKey(s) : null;
        let installed = 0;
        let total = 0;
        for (let t = 1; t <= MOD_TIER_COUNT; t++) {
          // the same filter the tree itself uses, so the count on the header
          // can never disagree with the chips underneath it
          const defs = MOD_TREE[mode][t - 1].filter((m) => m.id !== 'shell3' || special);
          total += defs.length;
          for (const m of defs) if (has.includes(m.id)) installed++;
        }
        cards.push(this.card('MODIFICATIONS', `
          <div class="gxBar"><div style="width:${total ? Math.round((installed / total) * 100) : 0}%"></div></div>
          <div class="gxHint">${installed} of ${total} installed — each tier opens once the one above it is deep enough.</div>
          ${this.modsRow(s, mode)}`, { note: `${installed}/${total}` }));

        if (mode === 'air') {
          cards.push(this.card('LOADOUT', `
            <div class="gxHint">Bombs and rockets cost speed and need their module researched first.</div>
            ${this.loadoutRow(s)}`));
        } else if (s.ammoCap) {
          cards.push(this.card('AMMUNITION', `
            <div class="gxHint">Distribute ${s.ammoCap} rounds. You pay for what you fire, not what you carry.</div>
            ${this.ammoRows(s)}`));
        }
      }
    }

    col.innerHTML = cards.join('');
  }

  // -------------------------------------------------------------------------
  // overlay screens
  // -------------------------------------------------------------------------

  renderOverlay() {
    const overlay = this.root.querySelector('#gxOverlay');
    const body = this.root.querySelector('#gxOverlayBody');
    const title = this.root.querySelector('#gxOverlayTitle');
    const on = OVERLAY_SCREENS.includes(this.screen);
    overlay.classList.toggle('hidden', !on);
    if (!on) {
      body.innerHTML = '';
      return;
    }
    title.textContent = SCREEN_TITLE[this.screen];
    if (this.screen === 'crew') this.renderCrew(body);
    else if (this.screen === 'lineup') this.renderLineup(body);
    else if (this.screen === 'settings') this.renderSettings(body);
    else if (this.screen === 'community') this.renderCommunity(body);
    else this.renderHelp(body);
  }

  crewSubject() {
    const owned = progress.ownedSpecs(this.mode);
    if (this.crewVehicle) {
      const spec = specById(this.crewVehicle);
      if (spec && owned.includes(spec)) return spec;
    }
    const viewed = this.viewedSpec();
    if (viewed && owned.includes(viewed)) return viewed;
    const sel = specById(progress.getSelected(this.mode));
    return sel && owned.includes(sel) ? sel : owned[0] || null;
  }

  renderCrew(panel) {
    const spec = this.crewSubject();
    if (!spec) {
      panel.innerHTML = '<div class="gxCard"><div class="gxCardHead"><span>CREW</span></div><div class="gxCardBody"><div class="gxHint">No vehicles of this type in the hangar yet.</div></div></div>';
      return;
    }
    const owned = progress.ownedSpecs(this.mode);
    const picker = owned
      .map((s) => `<button class="gxPick${s.id === spec.id ? ' active' : ''}" data-crewveh="${s.id}">
        ${esc(s.name)}<small>CREW ${progress.crewTotalLevel(s.id)} · BR ${brLabel(brOf(s))}</small></button>`)
      .join('');
    const crew = progress.crewSkills(spec.id);
    const rows = CREW_SKILLS.map((skill) => {
      const lvl = progress.crewLevel(spec.id, skill.id);
      const cost = progress.crewTrainCost(spec.id, skill.id);
      const pips = Array.from({ length: CREW_MAX_LEVEL },
        (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
      // the real applied figure, qualification included, not the listed step
      const pct = Math.round(Math.abs(crew[skill.key] - 1) * 100);
      const effect = lvl
        ? `${skill.dir > 0 ? '+' : '−'}${pct}% now`
        : 'untrained';
      const label = cost == null
        ? 'MAXED'
        : `TRAIN — ${fmt(cost)} XP`;
      return `<div class="gxRow">
        <span class="gxName">${skill.name}</span>
        <span class="gxPips">${pips}</span>
        <span class="gxDesc">${skill.desc} · <b>${effect}</b></span>
        <button class="gxBuy${cost == null ? ' done' : ''}" data-skill="${skill.id}" data-mv="${spec.id}"
          ${cost != null && progress.data.crewXp >= cost ? '' : 'disabled'}>${label}</button>
      </div>`;
    }).join('');
    const qual = progress.crewQualCost(spec.id);
    const qualRow = qual
      ? `<div class="gxRow">
          <span class="gxName">Qualification</span>
          <span class="gxPips">${CREW_QUALS.map((_, i) => `<i class="${i <= crew.qual ? 'on' : ''}"></i>`).join('')}</span>
          <span class="gxDesc">${crew.qualName} — trained skills are worth
            ${Math.round((1 + (CREW_QUALS[crew.qual].boost || 0)) * 100)}% of their listed value.
            ${qual.name} needs ${qual.minLevel} skill levels (${progress.crewTotalLevel(spec.id)} trained).</span>
          <button class="gxBuy" data-qual="${spec.id}" ${progress.canQualifyCrew(spec.id) ? '' : 'disabled'}>
            ${qual.name.toUpperCase()} — ${fmt(qual.silver)} ⛁${qual.rp ? ` · ${fmt(qual.rp)} RP` : ''}
          </button>
        </div>`
      : `<div class="gxRow">
          <span class="gxName">Qualification</span>
          <span class="gxPips">${CREW_QUALS.map(() => '<i class="on"></i>').join('')}</span>
          <span class="gxDesc">Ace crew — trained skills are worth
            ${Math.round((1 + CREW_QUALS[CREW_QUALS.length - 1].boost) * 100)}% of their listed value.</span>
          <button class="gxBuy done" disabled>ACE</button>
        </div>`;
    panel.innerHTML = `
      <div class="gxCard">
        <div class="gxCardHead"><span>CREW SLOT</span></div>
        <div class="gxCardBody">
          <div class="gxHint">Crew XP is earned every battle and spent per vehicle. A trained crew is worth more than most modifications — and unlike a modification, it never gets shot off.</div>
          <div class="gxPicker">${picker}</div>
        </div>
      </div>
      <div class="gxCard">
        <div class="gxCardHead"><span>${esc(spec.name.toUpperCase())}</span><b>${progress.crewTotalLevel(spec.id)} / ${CREW_SKILLS.length * CREW_MAX_LEVEL} LEVELS</b></div>
        <div class="gxCardBody">
          <div class="gxHint">
            Traverse ×${crew.traverse.toFixed(2)} · Reload ×${crew.reload.toFixed(2)} ·
            Mobility ×${crew.mobility.toFixed(2)} · Repair ×${crew.repair.toFixed(2)} ·
            Spotting ×${crew.vision.toFixed(2)}${crew.crewBonus ? ` · +${crew.crewBonus} crew` : ''}
          </div>
          ${qualRow}
          ${rows}
        </div>
      </div>`;
  }

  renderLineup(panel) {
    const mode = this.battleMode;
    const kinds = progress.lineupKinds(mode);
    const chosen = progress.data.lineups[mode] || [];
    const effective = progress.getLineup(mode);
    let budget = 0;
    for (const id of effective) budget += progress.spawnCost(specById(id));
    const groups = kinds.map((kind) => {
      const chips = progress.ownedSpecs(kind).map((s) => {
        const on = chosen.includes(s.id);
        const full = !on && chosen.length >= LINEUP_MAX;
        return `<button class="gxPick${on ? ' active' : ''}" data-lineup="${s.id}" ${full ? 'disabled' : ''}>
          ${esc(s.name)}<small>BR ${brLabel(brOf(s))} · ${progress.spawnCost(s)} SP · REPAIR ${fmt(progress.repairCost(s, true))}</small>
        </button>`;
      }).join('');
      return `<div class="gxCard">
        <div class="gxCardHead"><span>${kind === 'air' ? 'AIRCRAFT' : 'GROUND VEHICLES'}</span></div>
        <div class="gxCardBody"><div class="gxPicker">${chips || '<span class="gxHint">Nothing owned yet.</span>'}</div></div>
      </div>`;
    }).join('');
    const slots = Array.from({ length: LINEUP_MAX }, (_, i) => {
      const id = effective[i];
      const spec = id ? specById(id) : null;
      return `<span class="gxSlot">${i + 1}. ${spec ? `<b>${esc(spec.name)}</b> (${progress.spawnCost(spec)} SP)` : '— empty —'}</span>`;
    }).join('');
    panel.innerHTML = `
      <div class="gxCard">
        <div class="gxCardHead"><span>BATTLE LINEUP — ${mode.toUpperCase()}</span><b>${budget} SP</b></div>
        <div class="gxCardBody">
          <div class="gxHint">Take up to ${LINEUP_MAX} vehicles into a battle. You spawn with ${SPAWN_START} spawn points and each vehicle costs its own slice of them; kills, captures and damage buy the next spawn. Leave the lineup empty to take only your selected vehicle.</div>
          <div class="gxSlots">${slots}</div>
          <div class="gxHint">First spawn budget ${SPAWN_START} SP · full lineup costs ${budget} SP to field</div>
          <button class="gxTargetBtn gxNarrow" data-act="lineupclear">CLEAR LINEUP</button>
        </div>
      </div>
      ${groups}`;
  }

  renderSettings(panel) {
    const s = progress.settings;
    const slider = (key, label, max = 1) => `
      <div class="gxSet">
        <label>${label}</label>
        <input type="range" min="0" max="${max}" step="0.05" value="${s[key]}" data-set="${key}">
        <span class="gxVal" data-val="${key}">${Math.round((s[key] / max) * 100)}%</span>
      </div>`;
    // contract R3-S: booleans, default on; main.js applySettings() hands them
    // to the battle's postfx.setLens, the hangar stage takes the grain itself
    const toggle = (key, label, act, desc) => {
      const on = s[key] !== false;
      return `
      <div class="gxSet">
        <label>${label}</label>
        <button class="gxToggle${on ? ' on' : ''}" data-act="${act}" aria-pressed="${on}">${on ? 'ON' : 'OFF'}</button>
        <span class="gxDesc">${desc}</span>
      </div>`;
    };
    panel.innerHTML = `
      ${this.graphicsCardHtml()}
      <div class="gxCard">
        <div class="gxCardHead"><span>SETTINGS</span></div>
        <div class="gxCardBody">
          <div class="gxHint">Stored with your progress, so they survive a reload.</div>
          ${slider('masterVolume', 'MASTER VOLUME')}
          ${slider('effectsVolume', 'EFFECTS VOLUME')}
          ${slider('engineVolume', 'ENGINE VOLUME')}
          ${slider('shakeScale', 'CAMERA SHAKE', 2)}
          <div class="gxSet">
            <label>DAMAGE LOG</label>
            <button class="gxToggle${s.showDamageLog ? ' on' : ''}" data-act="toggledmg">
              ${s.showDamageLog ? 'SHOWN' : 'HIDDEN'}
            </button>
            <span class="gxDesc">Print every penetration, module hit and crew loss to the killfeed.</span>
          </div>
          ${toggle('motionBlur', 'MOTION BLUR', 'toggleblur',
    'Camera blur on fast pans, on the high graphics tier only. Your own vehicle and the gun sight always stay sharp.')}
          ${toggle('filmGrain', 'FILM GRAIN', 'togglegrain',
    'A fine, steady grain over the picture, in battle and on the hangar stage. Always off inside a sight.')}
          <button class="gxTargetBtn gxNarrow" data-act="resetsettings">RESET TO DEFAULTS</button>
        </div>
      </div>
      ${this.mouseCardHtml()}
      ${this.controlsCardHtml()}
      <div class="gxCard">
        <div class="gxCardHead"><span>SERVICE RECORD</span></div>
        <div class="gxCardBody">
          <div class="gxHint">
            Battles ${progress.data.stats.battles} · Victories ${progress.data.stats.wins} ·
            Vehicles destroyed ${progress.data.stats.kills} · Vehicles lost ${progress.data.stats.deaths}<br>
            Silver earned ${fmt(progress.data.stats.earned)} ⛁ · Silver spent ${fmt(progress.data.stats.spent)} ⛁
          </div>
        </div>
      </div>`;
  }

  // ---- settings lane: GRAPHICS QUALITY -----------------------------------
  // main.js hangs graphicsApi on the garage (set/choice/current/auto, and a
  // render scale once a perf lane adds one); without it the choice is only
  // persisted and the next battle's applySettings() picks it up.
  gfxChoice() {
    try {
      const c = this.graphicsApi?.choice?.();
      if (c) return c;
    } catch (e) { /* fall through */ }
    const v = (progress.settings || {}).graphics;
    return ['auto', 'low', 'medium', 'high'].includes(v) ? v : 'auto';
  }

  // The stage's own tier: an explicit choice is taken as it is (hangar3d.js
  // still caps it at what the GPU gets in battle); AUTO keeps the stage's old
  // guess — few cores, light stage.
  hangarTier() {
    const c = this.gfxChoice();
    if (c !== 'auto') return c;
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 8;
    return cores <= 4 ? 'low' : 'high';
  }

  setGraphicsChoice(level) {
    if (this.graphicsApi?.set) this.graphicsApi.set(level);
    else progress.setSetting('graphics', level);
    this.callHangar('setQuality', this.hangarTier());
  }

  graphicsCardHtml() {
    const choice = this.gfxChoice();
    let auto = '';
    try {
      auto = this.graphicsApi?.auto?.() || '';
    } catch (e) { auto = ''; }
    const btn = (id, label) =>
      `<button class="gxPick${choice === id ? ' active' : ''}" data-gfx="${id}" aria-pressed="${choice === id}">${label}</button>`;
    const autoNote = choice === 'auto' && auto ? ` Picks <b>${escHtml(auto.toUpperCase())}</b> here.` : '';
    const api = this.graphicsApi;
    let scaleRow = '';
    if (api && typeof api.getRenderScale === 'function' && typeof api.setRenderScale === 'function') {
      let v = 1;
      try { v = Number(api.getRenderScale()) || 1; } catch (e) { v = 1; }
      scaleRow = `
          <div class="gxSet gxSetWrap">
            <label>RENDER SCALE</label>
            <input type="range" min="0.5" max="1" step="0.05" value="${v}" data-rscale="1">
            <span class="gxVal" data-val="renderScale">${Math.round(v * 100)}%</span>
          </div>`;
    }
    return `
      <div class="gxCard gxSettingsCard">
        <div class="gxCardHead"><span>GRAPHICS QUALITY</span></div>
        <div class="gxCardBody">
          <div class="gxSet gxSetWrap">
            <label>QUALITY</label>
            <div class="gxGfxBtns">
              ${btn('auto', 'AUTO')}${btn('low', 'LOW')}${btn('medium', 'MEDIUM')}${btn('high', 'HIGH')}
            </div>
          </div>
          <div class="gxHint gxGfxDesc">${GFX_DETAIL[choice] || ''}${autoNote}
          Applies to the hangar now and to the next battle; the pause screen has the same switch.</div>${scaleRow}
        </div>
      </div>`;
  }

  // ---- settings lane: MOUSE -----------------------------------------------
  mouseCardHtml() {
    const s = progress.settings || {};
    const rows = SENS_ROWS.map(([key, label, desc]) => {
      const v = Number.isFinite(Number(s[key])) ? Number(s[key]) : 1;
      return `
          <div class="gxSet gxSetWrap">
            <label>${label}</label>
            <input type="range" min="0.25" max="3" step="0.05" value="${v}" data-set="${key}" data-fmt="x">
            <span class="gxVal" data-val="${key}">${v.toFixed(2)}x</span>
            <span class="gxDesc">${desc}</span>
          </div>`;
    }).join('');
    const inv = (key, label) => {
      const on = s[key] === true;
      return `
          <div class="gxSet gxSetWrap">
            <label>${label}</label>
            <button class="gxToggle${on ? ' on' : ''}" data-act="toggleinv" data-key="${key}" aria-pressed="${on}">${on ? 'INVERTED' : 'NORMAL'}</button>
            <span class="gxDesc">Mouse forward ${on ? 'looks down' : 'looks up'}.</span>
          </div>`;
    };
    return `
      <div class="gxCard gxSettingsCard">
        <div class="gxCardHead"><span>MOUSE</span></div>
        <div class="gxCardBody">
          <div class="gxHint">1.00x is the game's own feel. Lower is slower, higher is faster.</div>
          ${rows}
          ${inv('invertYTank', 'INVERT Y — TANK')}
          ${inv('invertYAir', 'INVERT Y — AIRCRAFT')}
          <button class="gxTargetBtn gxNarrow" data-act="resetsens">RESET MOUSE</button>
        </div>
      </div>`;
  }

  // ---- settings lane: CONTROLS --------------------------------------------
  controlsCardHtml() {
    const listening = this.listening || null;
    const pending = this.bindPending || null;
    const groups = GROUPS.map((g) => {
      const rows = ACTIONS.filter((a) => a[g.id]).map((a) => {
        const phys = input.bindingOf(a.code);
        const changed = phys !== a.code;
        const others = GROUPS.filter((o) => o.id !== g.id && a[o.id])
          .map((o) => `${GROUP_TITLE[o.id]}: ${a[o.id]}`);
        const isListening = listening === a.code;
        const keyText = isListening ? 'PRESS A KEY…' : escHtml(keyLabel(phys));
        return `
            <div class="gxKeyRow${changed ? ' changed' : ''}">
              <span class="gxKeyName">${escHtml(a[g.id])}${others.length ? `<small>also ${escHtml(others.join(' · '))}</small>` : ''}</span>
              <button class="gxKeyBtn${isListening ? ' listening' : ''}" data-act="rebind" data-code="${a.code}"${isListening ? ' data-listen="1"' : ''} title="Click, then press a key or a mouse button on this box">${keyText}</button>
            </div>`;
      }).join('');
      return `
          <div class="gxKeyGroup">
            <div class="gxKeyGroupHead">${g.title}</div>
            ${rows}
          </div>`;
    }).join('');
    let note = '';
    if (pending && pending.conflicts) {
      const names = pending.conflicts.map((c) => {
        const a = ACTIONS.find((x) => x.code === c);
        return escHtml(a ? (a.tank || a.air || a.common) : c);
      }).join(', ');
      note = `
          <div class="gxKeyNote warn">
            <span><b>${escHtml(keyLabel(pending.phys))}</b> is already on ${names}. Swap them, so that takes
            <b>${escHtml(keyLabel(input.bindingOf(pending.code)))}</b>?</span>
            <button class="gxPick" data-act="bindswap">SWAP</button>
            <button class="gxPick" data-act="bindcancel">CANCEL</button>
          </div>`;
    } else if (pending && pending.message) {
      note = `<div class="gxKeyNote"><span>${escHtml(pending.message)}</span></div>`;
    } else if (listening) {
      note = `<div class="gxKeyNote"><span>Press a key, or click a mouse button on the highlighted box. Esc cancels.</span></div>`;
    }
    return `
      <div class="gxCard gxSettingsCard" id="gxControls">
        <div class="gxCardHead"><span>CONTROLS</span></div>
        <div class="gxCardBody">
          <div class="gxHint">Click a key to change it. A key both vehicle classes use is one binding,
          so moving it moves it for both. The help panel in battle shows your keys. Esc (pause),
          the mouse wheel and Right Shift / Right Ctrl (second keys for Shift / Ctrl while those
          stay put) are fixed.</div>
          ${note}
          <div class="gxKeyGroups">${groups}</div>
          <button class="gxTargetBtn gxNarrow" data-act="resetcontrols">RESET CONTROLS</button>
        </div>
      </div>`;
  }

  // keydown / mousedown while a key box is listening (capture phase on the
  // window, so neither the game's input nor the inspector's Esc sees it)
  installBindCapture() {
    this.onBindKey = (e) => {
      if (!this.listening) return;
      if (this.screen !== 'settings' || this.root.classList.contains('hidden')) {
        this.listening = null; // the sheet it was listening on is gone
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.code === 'Escape') {
        this.listening = null;
        this.bindPending = null;
        this.renderKeepScroll();
        return;
      }
      this.tryBind(this.listening, e.code);
    };
    this.onBindMouse = (e) => {
      if (!this.listening) return;
      if (this.screen !== 'settings' || this.root.classList.contains('hidden')) {
        this.listening = null;
        return;
      }
      const box = e.target && e.target.closest ? e.target.closest('[data-listen]') : null;
      if (!box) {
        // a click anywhere else cancels and goes on to do what it does; the
        // box is reset in place (a full render would eat that click)
        const was = this.listening;
        this.listening = null;
        this.bindPending = null;
        const old = this.root.querySelector(`[data-listen][data-code="${was}"]`);
        if (old) {
          old.classList.remove('listening');
          old.removeAttribute('data-listen');
          old.textContent = keyLabel(input.bindingOf(was));
        }
        const note = this.root.querySelector('#gxControls .gxKeyNote');
        if (note) note.remove();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      this.swallowClickUntil = Date.now() + 600;
      this.tryBind(this.listening, `Mouse${e.button}`);
    };
    this.onBindSwallow = (e) => {
      if (!(this.swallowClickUntil > Date.now())) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'click' || e.type === 'auxclick') this.swallowClickUntil = Date.now() + 50;
    };
    window.addEventListener('keydown', this.onBindKey, true);
    window.addEventListener('mousedown', this.onBindMouse, true);
    for (const t of ['mouseup', 'click', 'auxclick', 'contextmenu']) {
      window.addEventListener(t, this.onBindSwallow, true);
    }
  }

  tryBind(code, phys, swap = false) {
    const r = input.rebind(code, phys, { swap });
    if (r.ok) {
      progress.setSetting('controls', input.serializeBindings());
      this.listening = null;
      this.bindPending = null;
    } else if (r.reason === 'conflict') {
      this.listening = null;
      this.bindPending = { code, phys, conflicts: r.conflicts };
    } else {
      this.bindPending = { message: `${keyLabel(phys)} cannot be bound — Esc, the Windows key and F5 / F11 / F12 belong to the browser. Press another key.` };
    }
    this.renderKeepScroll();
  }

  // the overlay body is one element whose contents are rebuilt; hold its
  // scroll so a rebind deep in the list does not jump the sheet to the top
  renderKeepScroll() {
    const body = this.root.querySelector('#gxOverlayBody');
    const top = body ? body.scrollTop : 0;
    this.render();
    if (body) body.scrollTop = top;
  }

  renderCommunity(panel) {
    const owned = progress.data.owned.length;
    const total = Object.keys(TANK_SPECS).length + Object.keys(PLANE_SPECS).length;
    panel.innerHTML = `
      <div class="gxCard">
        <div class="gxCardHead"><span>STEEL SKIES</span><b>${VERSION}</b></div>
        <div class="gxCardBody">
          <div class="gxHint">An original browser combined-arms game: six ground vehicles and five aircraft
          across five nations, a sloped-armour penetration model, functional crew roles, positional audio and
          a velocity-vector flight model. The vehicles are modelled in code; ground, buildings and lighting use
          photo-scanned CC0 textures and HDRIs, and the battle sounds are CC0 / public-domain recordings.</div>
        </div>
      </div>
      <div class="gxCard">
        <div class="gxCardHead"><span>SERVICE RECORD</span></div>
        <div class="gxCardBody">
          <div class="gxHint">
            Hangar ${owned} / ${total} vehicles · ${progress.data.stats.battles} battles ·
            ${progress.data.stats.wins} victories · ${progress.data.stats.kills} vehicles destroyed
          </div>
        </div>
      </div>
      <div class="gxCard">
        <div class="gxCardHead"><span>CREDITS</span></div>
        <div class="gxCardBody">
          <div class="gxHint">Built with Three.js and the Web Audio API. Textures and HDRIs: Poly Haven and
          ambientCG (CC0). Sounds: Freesound, Kenney and US-Government recordings (CC0 / public domain);
          the full list is in media/CREDITS.md and media/sfx/CREDITS.md. Vehicle names and markings are
          historical; nothing here is taken from any other game.</div>
        </div>
      </div>`;
  }

  renderHelp(panel) {
    const rows = [
      ['W / S', 'Throttle — forward and back'],
      ['A / D', 'Steer, or roll in the air'],
      ['Mouse', 'Aim · LMB fires the main gun'],
      ['Shift', 'Sniper view'],
      ['1 / 2 / 3', 'Select shell type'],
      ['M', 'Tactical map'],
      ['Tab', 'Scoreboard'],
      ['Esc', 'Pause'],
    ];
    panel.innerHTML = `
      <div class="gxCard">
        <div class="gxCardHead"><span>CONTROLS</span></div>
        <div class="gxCardBody">
          ${rows.map(([k, v]) => `<div class="gxRow"><span class="gxName">${k}</span><span class="gxDesc">${v}</span></div>`).join('')}
        </div>
      </div>
      <div class="gxCard">
        <div class="gxCardHead"><span>HOW A BATTLE PAYS</span></div>
        <div class="gxCardBody">
          <div class="gxHint">Silver pays for vehicles, modifications and the repair bill your losses leave
          behind — it is the only currency that can go down. Research Points climb the tree: three quarters of
          them flow into whatever you set as your research target, and the rest stay free for modifications.
          Crew XP buys skills, one vehicle at a time.</div>
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    let el;

    if ((el = t.closest('[data-unlock]'))) {
      const spec = specById(el.dataset.unlock);
      if (spec && progress.unlock(spec)) {
        progress.setSelected(this.mode, spec.id);
        this.viewed = spec.id;
        this.render();
      }
      return;
    }
    if ((el = t.closest('[data-target]'))) {
      const id = el.dataset.target;
      progress.setResearchTarget(progress.getResearchTarget() === id ? null : id);
      this.render();
      return;
    }
    if ((el = t.closest('[data-mod]'))) {
      const spec = specById(el.dataset.mv);
      if (!spec) return;
      if (ownedMods(spec.id).includes(el.dataset.mod)) return;
      if (buyModule(spec, this.mode, el.dataset.mod)) this.render();
      return;
    }
    if ((el = t.closest('[data-lo]'))) {
      progress.setLoadout(el.dataset.mv, el.dataset.lo);
      this.render();
      return;
    }
    if ((el = t.closest('[data-shell]'))) {
      const spec = specById(el.dataset.mv);
      if (!spec) return;
      const key = el.dataset.shell;
      const d = parseInt(el.dataset.d, 10);
      const dist = ammoDistribution(spec);
      const total = Object.values(dist).reduce((a, b) => a + b, 0);
      let next = dist[key] + d;
      if (d > 0) next = dist[key] + Math.min(d, spec.ammoCap - total);
      next = Math.max(0, next);
      progress.setAmmoCount(spec.id, key, next);
      this.render();
      return;
    }
    if ((el = t.closest('[data-skill]'))) {
      if (progress.trainCrew(el.dataset.mv, el.dataset.skill)) this.render();
      return;
    }
    if ((el = t.closest('[data-qual]'))) {
      if (progress.qualifyCrew(el.dataset.qual)) this.render();
      return;
    }
    if ((el = t.closest('[data-lineup]'))) {
      progress.toggleLineup(this.battleMode, el.dataset.lineup);
      this.render();
      return;
    }
    if ((el = t.closest('[data-crewveh]'))) {
      this.crewVehicle = el.dataset.crewveh;
      this.render();
      return;
    }
    if ((el = t.closest('[data-inspect]'))) {
      if (el.disabled) return;
      this.openInspector(el.dataset.inspect);
      return;
    }
    if ((el = t.closest('[data-screen]'))) {
      if (this.respawnLock && el.dataset.screen !== 'vehicles') return;
      this.setScreen(el.dataset.screen);
      return;
    }
    if ((el = t.closest('[data-diff]'))) {
      if (this.respawnLock) return;
      progress.setDifficulty(el.dataset.diff);
      this.render();
      return;
    }
    if ((el = t.closest('[data-bm]'))) {
      if (this.respawnLock) return;
      this.setBattleMode(el.dataset.bm);
      return;
    }
    if ((el = t.closest('[data-modetab]'))) {
      if (!this.allowedTabs().includes(el.dataset.modetab)) return;
      this.mode = el.dataset.modetab;
      this.viewed = null;
      this.classFilter = null;
      this.render();
      return;
    }
    if ((el = t.closest('[data-nation]'))) {
      this.nation = el.dataset.nation;
      this.render();
      return;
    }
    if ((el = t.closest('[data-class]'))) {
      this.classFilter = this.classFilter === el.dataset.class ? null : el.dataset.class;
      this.render();
      return;
    }
    if ((el = t.closest('[data-pick]'))) {
      const id = el.dataset.pick;
      this.viewed = id;
      if (progress.isOwned(id)) progress.setSelected(this.mode, id);
      this.render();
      return;
    }
    // last, because a whole card can carry an action while the controls inside
    // it carry their own — the specific ones above must get first refusal
    if ((el = t.closest('[data-gfx]'))) {
      this.setGraphicsChoice(el.dataset.gfx);
      this.renderKeepScroll();
      return;
    }
    if ((el = t.closest('[data-act]'))) this.doAct(el.dataset.act, el);
  }

  doAct(act, el = null) {
    if (act.startsWith('screen:')) {
      if (this.respawnLock) return;
      this.setScreen(act.slice(7));
      return;
    }
    if (act === 'collapse') {
      this.collapsed = !this.collapsed;
      this.root.classList.toggle('gxCollapsed', this.collapsed);
      const btn = this.root.querySelector('#gxCollapseBtn');
      if (btn) btn.innerHTML = this.collapsed ? ICON.expand : ICON.collapse;
      this.callHangar('resize');
      return;
    }
    if (act === 'closeoverlay') {
      this.setScreen('vehicles');
      return;
    }
    if (act === 'cyclemode') {
      if (this.respawnLock) return;
      const next = MODE_ORDER[(MODE_ORDER.indexOf(this.battleMode) + 1) % MODE_ORDER.length];
      this.setBattleMode(next);
      return;
    }
    if (act === 'lineupclear') {
      progress.setLineup(this.battleMode, []);
      this.render();
      return;
    }
    if (act === 'toggledmg') {
      progress.setSetting('showDamageLog', !progress.settings.showDamageLog);
      this.render();
      return;
    }
    // R3-S: the battle picks these up through main.js (it watches this
    // menu's clicks); the stage's own chain is told here
    if (act === 'toggleblur' || act === 'togglegrain') {
      const key = act === 'toggleblur' ? 'motionBlur' : 'filmGrain';
      progress.setSetting(key, progress.settings[key] === false);
      this.syncHangarLens();
      this.render();
      return;
    }
    if (act === 'resetsettings') {
      // only the card the button sits in: graphics, mouse and controls keep
      progress.resetSettings(AUDIO_KEYS);
      this.syncHangarLens();
      this.render();
      return;
    }
    // ---- settings lane ----
    if (act === 'rebind') {
      const code = el.dataset.code;
      this.bindPending = null;
      this.listening = this.listening === code ? null : code;
      this.renderKeepScroll();
      return;
    }
    if (act === 'bindswap') {
      const p = this.bindPending;
      if (p && p.code && p.phys) this.tryBind(p.code, p.phys, true);
      return;
    }
    if (act === 'bindcancel') {
      this.bindPending = null;
      this.listening = null;
      this.renderKeepScroll();
      return;
    }
    if (act === 'resetcontrols') {
      input.resetBindings();
      progress.setSetting('controls', input.serializeBindings());
      this.bindPending = null;
      this.listening = null;
      this.renderKeepScroll();
      return;
    }
    if (act === 'resetsens') {
      progress.resetSettings(SENS_RESET);
      this.renderKeepScroll();
      return;
    }
    if (act === 'toggleinv') {
      const key = el.dataset.key;
      progress.setSetting(key, progress.settings[key] !== true);
      this.renderKeepScroll();
    }
  }

  // K-01 grain on the stage follows the player's Film grain setting (the
  // stage never takes motion blur: hangar3d.js ignores it)
  syncHangarLens() {
    const s = progress.settings || {};
    this.callHangar('setLens', { grain: s.filmGrain !== false });
  }

  onInput(e) {
    const el = e.target;
    if (el && el.dataset && el.dataset.rscale) {
      // a perf lane's render scale, through main.js graphicsApi
      const v = parseFloat(el.value);
      try { this.graphicsApi?.setRenderScale?.(v); } catch (err) { /* keep */ }
      const out = this.root.querySelector('[data-val="renderScale"]');
      if (out) out.textContent = `${Math.round(v * 100)}%`;
      return;
    }
    if (!el || !el.dataset || !el.dataset.set) return;
    const key = el.dataset.set;
    progress.setSetting(key, parseFloat(el.value));
    const max = parseFloat(el.max) || 1;
    const out = this.root.querySelector(`[data-val="${key}"]`);
    if (out && el.dataset.fmt === 'x') out.textContent = `${parseFloat(el.value).toFixed(2)}x`;
    else if (out) out.textContent = `${Math.round((parseFloat(el.value) / max) * 100)}%`;
  }

  setBattleMode(mode) {
    this.battleMode = mode;
    progress.setBattleMode(mode);
    if (!this.allowedTabs().includes(this.mode)) {
      this.mode = this.allowedTabs()[0];
      this.viewed = null;
    }
    this.render();
  }

  setScreen(screen) {
    // 'armour' was the old protection overlay; it is the stage inspection now
    if (screen === 'armour') {
      this.openInspector('armour');
      return;
    }
    // any other screen, the hangar included, is a step out of the inspection
    if (this.inspector) this.closeInspector(true);
    if (this.screen === screen) {
      this.refresh();
      return;
    }
    this.screen = screen;
    this.render();
    if (!this.root.classList.contains('hidden')) this.startHangar();
  }

  // -------------------------------------------------------------------------
  // chrome
  // -------------------------------------------------------------------------

  refresh() {
    const q = (sel) => this.root.querySelector(sel);

    q('#balSilver').innerHTML = `${ICON.silver}<b>${fmt(progress.data.silver)}</b><i>Silver</i>`;
    q('#balRp').innerHTML = `${ICON.rp}<b>${fmt(progress.data.rp)}</b><i>RP</i>`;
    q('#balCrew').innerHTML = `${ICON.crew}<b>${fmt(progress.data.crewXp)}</b><i>Crew XP</i>`;

    const spec = this.battleSpec();
    const br = spec ? brOf(spec) : 1;
    q('#gxModeStrip').textContent =
      `${MODE_LABEL[this.battleMode]} ${DIFF_LABEL[progress.getDifficulty()]} Battles · BR ${brLabel(br)}`;
    q('#gxModeStrip').title = `Matchmaking bracket ${brBracket(br).label}`;
    q('#garageSubtitle').textContent = this.subtitle;
    q('#battleBtn').textContent = this.buttonLabel;

    this.root.querySelectorAll('[data-diff]').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.diff === progress.getDifficulty());
    });
    this.root.querySelectorAll('[data-bm]').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.bm === this.battleMode);
    });
    this.root.querySelectorAll('[data-screen]').forEach((btn) => {
      const s = btn.dataset.screen;
      btn.classList.toggle('active', !this.inspector && (s === this.screen ||
        (s === 'vehicles' && !OVERLAY_SCREENS.includes(this.screen))));
      // during a respawn the only screen that means anything is the hangar
      btn.disabled = this.respawnLock && s !== 'vehicles';
    });
    // inspection: looking costs nothing, so it stays open during a respawn too;
    // aircraft have no armour plate to analyse
    const inspecting = this.inspector ? this.inspector.mode : null;
    this.root.querySelectorAll('[data-inspect]').forEach((btn) => {
      const m = btn.dataset.inspect;
      btn.classList.toggle('active', inspecting === m);
      const noArmour = m === 'armour' && this.mode === 'air';
      btn.disabled = noArmour;
      if (btn.dataset.title === undefined) btn.dataset.title = btn.title || '';
      btn.title = noArmour
        ? 'Aircraft carry no armour plate in the damage model — X-RAY shows what protects them'
        : btn.dataset.title;
    });

    const allowed = this.allowedTabs();
    this.root.querySelectorAll('[data-modetab]').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.modetab === this.mode);
      tab.disabled = !allowed.includes(tab.dataset.modetab);
    });

    // nation tabs: a nation with nothing in this family is not a choice
    this.root.querySelectorAll('[data-nation]').forEach((btn) => {
      const id = btn.dataset.nation;
      const count = id === 'all'
        ? this.specsFor(this.mode).length
        : this.specsFor(this.mode).filter((s) => s.nation === id).length;
      btn.classList.toggle('active', id === this.nation);
      btn.disabled = count === 0;
      btn.classList.toggle('empty', count === 0);
    });

    this.root.querySelectorAll('[data-class]').forEach((btn) => {
      const def = CLASS_FILTERS.find((c) => c.id === btn.dataset.class);
      const mine = def && def.kind === this.mode;
      btn.classList.toggle('hidden', !mine);
      btn.classList.toggle('active', this.classFilter === btn.dataset.class);
    });

    // lineup summary, bottom right
    const lineup = progress.getLineup(this.battleMode);
    let sp = 0;
    for (const id of lineup) sp += progress.spawnCost(specById(id));
    q('#gxLineupSum').innerHTML = lineup.length
      ? `<span>LINEUP</span><i>${lineup.map((id) => esc(specById(id)?.name || id)).join(' · ')}</i><b>${sp} SP</b>`
      : '<span>LINEUP</span><i>single vehicle</i>';

    // respawn: the battle is already running, so its mode is not up for debate
    this.root.classList.toggle('gxRespawn', this.respawnLock);
  }

  // -------------------------------------------------------------------------
  // public API — exactly what main.js has always called
  // -------------------------------------------------------------------------

  show({ subtitle = 'Select your vehicle', button = 'TO BATTLE', respawn = false } = {}) {
    this.respawnLock = respawn;
    if (respawn) this.screen = 'vehicles';
    if (!this.allowedTabs().includes(this.mode)) {
      this.mode = this.allowedTabs()[0];
      this.viewed = null;
    }
    this.subtitle = subtitle;
    this.buttonLabel = button;
    this.root.classList.remove('hidden');
    this.render();
    const row = this.root.querySelector('#gxResearchRow');
    if (row) row.scrollLeft = 0;
    // settings may have changed elsewhere (the pause screen) since last time
    this.syncHangarLens();
    this.callHangar('setQuality', this.hangarTier());
    this.startHangar();
  }

  hide() {
    // a hidden garage must not keep a WebGL context and a RAF loop alive while
    // the battle is asking the renderer for one of its own
    this.closeInspector(true);
    this.stopHangar();
    this.root.classList.add('hidden');
  }

  // Nothing calls this today; it exists so a future shell can tear the menu
  // down without leaking the hangar's renderer.
  dispose() {
    this.disposed = true;
    this.closeInspector(true);
    this.stopHangar();
    this.callHangar('dispose');
    this.hangar = null;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keydown', this.onBindKey, true);
    window.removeEventListener('mousedown', this.onBindMouse, true);
    for (const t of ['mouseup', 'click', 'auxclick', 'contextmenu']) {
      window.removeEventListener(t, this.onBindSwallow, true);
    }
  }
}
