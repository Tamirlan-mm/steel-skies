import * as THREE from 'three';
import { isSharedResource } from '../core/materials.js';
import * as terrainMod from '../world/terrain.js';
import { buildTerrain, terrainHeight, setTerrainSeed } from '../world/terrain.js';
import {
  setupEnvironment,
  setSceneryEffects,
  damagePropsAt,
  crushProps,
  propSegmentHit,
  propBlocksLine,
  disposeScenery,
  clearKeepOuts,
  solidPushOut,
} from '../world/scenery.js';
// a hull is kept out of houses and boulders (resolveTankCollisions): three
// discs along its centreline, the shove for each comes back in hullShove
const hullDisc = new THREE.Vector4();
const hullShove = new THREE.Vector3();
// crushScenery's options, refilled per hull (scenery.js keeps none of them)
const hullCrushOpts = { force: 20, dirX: 0, dirZ: 0 };
// The airfield the user asked for. Same module the air battle flies off, so the
// approach gate, the ground roll and the ground crew behave identically here.
import {
  createAirfield,
  airfieldKeepOut,
  disposeAirfields,
  clearAirfieldRegistry,
  groundHeightAt,
  initPlaneAirfieldState,
  updateAirfieldService,
  updateGroundRoll,
} from '../world/airfield.js';
// The aircraft camera the air battle flies with: rigid on the aeroplane, the
// rotation sprung, the keyboard nose-follow a spring rather than a constant
// rate. Owning it here as well is what keeps a combined-arms sortie from
// juddering and lagging where the same aeroplane in the air battle does not.
import { PlaneCamera } from './planeCamera.js';
import { randomPreset, MAP_PRESETS } from '../world/presets.js';
import { Tank } from '../vehicles/tankEntity.js';
// namespace import as well: the shared penetration forecast (contract F1) is
// still landing in tankEntity.js, and a missing named import would break the
// module link outright rather than degrade
import * as tankMod from '../vehicles/tankEntity.js';
import { TANK_SPECS, shellPenAt } from '../vehicles/tanks.js';
import { Plane } from '../vehicles/planeEntity.js';
import { PLANE_SPECS, displaySpeedKmh } from '../vehicles/planes.js';
import { AAGun } from '../vehicles/groundUnits.js';
import { ShellManager, intersectTanks, clipRayToScenery, barrelIntoWall } from '../combat/ballistics.js';
import { BulletManager } from '../combat/bullets.js';
import { BombManager, blastDamageAt } from '../combat/bombs.js';
import { Effects } from '../combat/effects.js';
import { CameraShake } from '../combat/shake.js';
import { heFillerKg, BLAST_KG } from '../combat/blast.js';
import { TankAI, hasLOS, notifyObjectivesChanged } from '../ai/tankAI.js';
import { PlaneAI } from '../ai/planeAI.js';
import { input } from '../core/input.js';
import {
  sfx,
  sfx3d,
  updateEngineSound,
  updateEngine,
  removeEngine,
  setListener,
  radioCue,
  updateAudio,
  resetAudio,
} from '../core/audio.js';
import { applyMods } from './mods.js';
import {
  progress,
  planBattle,
  createSpawnBudget,
  SPAWN_START,
  SPAWN_AWARDS,
  REWARD,
  DIFFICULTY_MULT,
  rewardMultiplier,
} from './progress.js';
import { pickLineup } from './battleRating.js';
import { XrayView } from '../ui/xray.js';
// K-04: the real gunner's sight per vehicle, its detents and labels
import { opticSteps } from '../ui/hud.js';
import { clamp, lerp, rand, wrapAngle } from '../core/utils.js';

// The terrain mesh is +/-1300: it covers the aircraft limit (MAP_EDGE 1200) and
// both strips, exactly as the air battle's own 2600 mesh does. 277 segments
// keeps the low and medium tiers at 9.39 m quads (high quality raises it).
const MAP_SIZE = 2600;
const TERRAIN_SEGS = 277;
// Scenery scatter square, deliberately NOT derived from MAP_SIZE: the cover
// density inside the tank area stays what it was on the old 1500 m map, and
// the ground around the airfields stays open.
const PROP_AREA = 1350;
// The armour's hard square clamp (tankEntity bound). Nothing about the tank
// fight changed with the bigger mesh; only the airfields moved out past it.
const TANK_BOUND = 700;
// how far inside the clamp the crew start shouting about the edge
const BOUND_WARN = 60;
const TICKETS_MAX = 2700;
const CAP_RADIUS = 25;
const RESPAWN_COST = 150;
const MATCH_TIME = 25 * 60;
const KILL_COST = { tank: 70, plane: 50, ground: 20 };

// Three points, spread along the diagonal so the ground fight has somewhere to
// go and the aircraft have three separate things worth strafing. Holding more
// of them bleeds the other side faster — one point is a stalemate, three is a
// rout, which is what makes a lost flank worth driving across the map for.
const ZONE_LAYOUT = [
  { key: 'A', x: -235, z: -175 },
  { key: 'B', x: 0, z: 0 },
  { key: 'C', x: 235, z: 175 },
];
const ZONE_BLEED = 2.4; // tickets per second, per zone held
const CAP_RATE = 14;

// Airfields. Each strip sits straight behind its own side, OUTSIDE the tank
// clamp, so no tank can ever drive onto the concrete: the old (+/-500, -/+430)
// placement was inside the +/-700 square and the armour could roll across it.
// With the default 150 x 22 strip centred on (-/+1020, 0):
//   concrete     |x| 870..1170 — 170 m outside the tank bound, 30 m inside
//                the aircraft limit (MAP_EDGE 1200), 130 m inside the mesh
//   field AA     at least 190 m outside the tank bound
//   keep-out     the scenery fence stops 125 m outside the bound
//   own armour   245 m from the nearest spawn-line tank to its own concrete
// The strips stay on z = 0 on purpose: terrain.js's ridge bands still add up
// to 16 m of shaped relief at |z| >= 800, but contribute nothing out here.
// The air battle uses the same X on the same mesh size.
const AIRFIELD_X = 1020;
const AIRFIELD_Z = 0;
// aircraft spawn this far past the strip centre, outboard, already airborne
const PLANE_SPAWN_BACK = 120;
// the roaming AA's Z band is |z| 240..ROAM_Z_MAX, clear of the armour spawn
// band (|z| < 190) now that the strips no longer share that flank
const ROAM_Z_MAX = 380;
// Density, not damage, is the half of the AA problem that lives in this file.
// Two guns on the field and two roaming, pushed onto opposite flanks, so a
// bombing run is engaged by one or two guns rather than by the whole battery.
const AIRFIELD_AA = 2;
const ROAM_AA = 2;

// Damage points, in the currency progress.settle() prices at REWARD.damage.
// Shared scale with the ground mode (contract F4): a vehicle you take apart
// yourself is worth about a hundred of these, whoever finally finishes it.
const DMG_PEN = 25;
const DMG_MODULE = 15;
const DMG_CREW = 20;
const DMG_KILL = 60;
// what a whole vehicle taken apart is worth on that scale — used to price
// airframe HP, the one damage figure in this file measured in its own unit
const DMG_VEHICLE = DMG_PEN + DMG_KILL;

// Artillery. A six-second flight time means a moving target simply drives out
// of the beaten zone, and the minimum range stops a panicking crew calling it
// down on their own hull.
const ARTY_MIN_RANGE = 90;
const ARTY_SPREAD = 26;
const ARTY_RADIUS = 11;

// How far the commander's report and the marker ring reach before spec.spotFactor
// is applied to either.
const SCOUT_RANGE = 700;
const MARK_RANGE = 900;

// How opaque the smoke between the player and an enemy has to be drawn before
// nothing on the HUD may point at him any more (effects.smokeOpacityAlong, 0..1;
// a line the game calls blind is drawn at 0.95 or more). Well under that: a
// hull already two-thirds gone into a screen is not a contact worth a marker,
// a lead ring or a penetration verdict, and the HUD must never be the thing
// that shows the player where the smoke is hiding somebody.
const SMOKE_HIDE = 0.6;

// Comfortably above anything terrain.js can build. A ray that starts higher
// than this and is still climbing will never meet the ground, so the aim march
// can decline to look.
const TERRAIN_CEILING = 160;

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
// dedicated temporaries for the wiring added in wave 2, so nothing here can
// stamp on a vector another method is still holding
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
// the bomb sight's lead marker, projected while tmpV2 still holds the impact
const tmpLead = new THREE.Vector3();
// the smoke test's own eye and target points: it is asked from inside loops
// that are already holding tmpV / tmpA
const smokeEye = new THREE.Vector3();
const smokeAt = new THREE.Vector3();
// the X-ray capture runs on every hit the player sees; one matrix lives here
// rather than one per shot
const tmpMat = new THREE.Matrix4();

// terrain.js is allowed to grow a surface table underneath us; until it does,
// every vehicle drives on the map preset's own going.
const terrainSurface =
  typeof terrainMod.terrainSurface === 'function' ? terrainMod.terrainSurface : null;

// A fire mission is a fitted module, not a birthright, so the help panel must
// not advertise a key the vehicle cannot press — a crew that learns T does
// nothing stops trusting the rest of the list too.
function tankHelp(spec) {
  const support = spec && spec.artillerySupport ? 'T — artillery · V — scout' : 'V — scout';
  return `
  <span>W / S — throttle · A / D — steer · Mouse — aim · Shift — sniper</span>
  <span>LMB — fire · Space — machine gun · 1 / 2 / 3 — shell type</span>
  <span>R (hold) — repair · F — extinguisher · G — smoke · H — first aid</span>
  <span>${support} · M — tactical map · Tab — scoreboard</span>
  <span>J (hold) — abandon vehicle · Esc — pause</span>
`;
}
// The edge of the battle area, drawn in the world: a low red curtain standing
// on the terrain along all four sides of the tank clamp, fading upward. The
// hard clamp in tankEntity is what stops the hull; this is what tells the crew
// the wall is there before they grind into it. 4 x 140 x 2 = 1,120 triangles,
// one draw call. Not shared, so dispose()'s scene traversal frees it.
function buildBoundaryCurtain(scene, bound, step = 10, height = 6) {
  const n = Math.round((2 * bound) / step);
  const pos = [];
  const col = [];
  const idx = [];
  const sides = [
    [-bound, -bound, 1, 0],
    [bound, -bound, 0, 1],
    [bound, bound, -1, 0],
    [-bound, bound, 0, -1],
  ];
  let base = 0;
  for (const [x0, z0, dx, dz] of sides) {
    for (let i = 0; i <= n; i++) {
      const x = x0 + dx * i * step;
      const z = z0 + dz * i * step;
      const g = terrainHeight(x, z);
      pos.push(x, g - 0.5, z, x, g + height, z);
      col.push(0.85, 0.12, 0.08, 0.55, 0.85, 0.12, 0.08, 0.0);
    }
    for (let i = 0; i < n; i++) {
      const a = base + 2 * i;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    base += 2 * (n + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Below the smoke-screen volume (effects.js draws its core at -2): a
  // transparent drawn after the smoke composites over it whatever the depth,
  // and a curtain glowing through a screen is a curtain the screen does not hide.
  mesh.renderOrder = -3;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

const PLANE_HELP = `
  <span>Mouse — steer · keys mix in on their axis</span>
  <span>A / D — roll · W / S — pitch (W down) · Q / E — rudder</span>
  <span>Shift / Ctrl — throttle · R — WEP · Z / C — radiator</span>
  <span>V — flaps · G — landing gear · B — airbrake / wheel brakes · X — extinguisher</span>
  <span>LMB — guns · Space — bomb · F — rocket · RMB hold — aim zoom · M — map</span>
  <span>P — cockpit / chase view</span>
  <span>J (hold) — abandon vehicle · Tab — scoreboard · Esc — pause</span>
  <span>Landing: slow below the gear limit, G, landing flaps, gentle descent (under 2.4 m/s)</span>
  <span>On the ground: Q / E steer · B brakes · stop on your own field to repair and rearm</span>
`;

const CREW_LABEL = {
  driver: 'Driver',
  gunner: 'Gunner',
  loader: 'Loader',
  commander: 'Commander',
  radio: 'Radio',
};

// The damage panel rebuilds its DOM whenever the module roster changes, so the
// list has to be the same shape every frame — only the states may move.
const TANK_MODULE_ROWS = [
  ['engine', 'Engine'],
  ['transmission', 'Transmission'],
  ['tracks', 'Tracks'],
  ['breech', 'Gun breech'],
  ['barrel', 'Gun barrel'],
  ['traverse', 'Turret drive'],
  ['elevation', 'Elevation drive'],
  ['radiator', 'Radiator'],
];

const PLANE_MODULE_ROWS = [
  ['engine', 'Engine'],
  ['wings', 'Wings'],
  ['tail', 'Tail'],
  ['controls', 'Controls'],
  ['radiator', 'Oil cooler'],
  ['fuel', 'Fuel tank'],
];

// Combined-arms battle: 5 tanks + 3 planes per side plus AA guns, three
// capture points and shared tickets. The player may spawn in either vehicle
// class and switch class on respawn, which is the whole point of the mode.
export class CombinedBattle {
  constructor(renderer, playerType, playerSpecId, hud, onEnd) {
    this.renderer = renderer;
    this.hud = hud;
    this.onEnd = onEnd;
    this.finished = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      60, window.innerWidth / window.innerHeight, 0.3, 4000,
    );
    // The aircraft camera. While the player flies, camYaw / camPitch (below)
    // are accessors onto its raw aim, exactly as in the air battle; in a tank
    // they are this class's own two numbers and the plane camera sits idle.
    this.planeCam = new PlaneCamera(this.camera, { fov: 60, zoomFov: 22 });
    this.followStrength = 0;

    setTerrainSeed(rand(-3000, 3000), rand(-3000, 3000));
    const preset = randomPreset();
    this.preset = preset;
    this.surfaceKey = 'firm';
    for (const k of Object.keys(MAP_PRESETS)) {
      if (MAP_PRESETS[k] === preset) this.surfaceKey = k;
    }
    this.dustColor = preset.low != null ? preset.low : 0x9a8a68;
    this.scene.add(buildTerrain(MAP_SIZE, TERRAIN_SEGS, preset));

    // THE AIRFIELDS, and they have to be built here — before setupEnvironment —
    // because their footprints go in as scenery keep-outs. Rocks are registered
    // invulnerable, so a boulder scattered onto the concrete could never be
    // cleared and would sit on the runway for the whole match. keepOutDiscs is
    // module state in scenery.js that nothing else empties, so the previous
    // battle's fences are dropped first.
    clearKeepOuts();
    // The solid-ground registry (the platforms aircraft land on and the boxes
    // they can hit) is module state too. dispose() unregisters this battle's
    // fields, but a battle that never got as far as dispose() would leave its
    // strips standing invisibly in the next one.
    clearAirfieldRegistry();
    this.groundUnits = [];
    this.airfields = [];
    for (let team = 0; team < 2; team++) {
      const side = team === 0 ? -1 : 1;
      this.airfields.push(createAirfield(this.scene, {
        team,
        // straight behind the side's own armour, outside the tank clamp
        // (see AIRFIELD_X): team 0 holds -x, so its strip is at (-1020, 0)
        x: side * AIRFIELD_X,
        z: AIRFIELD_Z,
        // the embankment is shaded by the terrain's own palette rule, so it
        // has to be told the palette the terrain was built with — without it
        // every biome got meadow-coloured earthworks
        palette: preset,
        // a takeoff run points across the map, at the other side's half
        heading: team === 0 ? Math.PI / 2 : -Math.PI / 2,
        buildAA: (af, spots) => {
          for (let i = 0; i < AIRFIELD_AA && spots.length; i++) {
            const span = Math.max(1, AIRFIELD_AA - 1);
            const s = spots[Math.round((i * (spots.length - 1)) / span)];
            this.groundUnits.push(new AAGun(this.scene, team, s.x, s.z, 20 + i));
          }
        },
      }));
    }

    // Keep the whole handle, not just the light. `blockers` is the live list
    // the prop registry splices a wall out of the moment it comes down, which
    // is what lets the sight tests below skip the query outright on a map that
    // grew no solid props at all.
    this.scenery = setupEnvironment(this.scene, {
      fogNear: 400,
      fogFar: 2600,
      propArea: PROP_AREA,
      trees: 420,
      rocks: 130,
      houses: 14,
      preset,
      keepOut: airfieldKeepOut(this.airfields),
    });
    this.sun = this.scenery.sun;
    this.blockers = this.scenery.blockers || [];

    this.playerIsPlane = playerType === 'air';

    // ---- capture zones ----
    const ringGeo = new THREE.RingGeometry(CAP_RADIUS - 1.2, CAP_RADIUS, 48);
    ringGeo.rotateX(-Math.PI / 2);
    this.zones = ZONE_LAYOUT.map((z) => {
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: 0xe8d080, transparent: true, opacity: 0.7 }),
      );
      // a ground decal: drawn before the smoke-screen volume (renderOrder -2)
      // so a screen standing on the point hides the ring like the ground
      ring.renderOrder = -3;
      ring.position.set(z.x, terrainHeight(z.x, z.z) + 0.25, z.z);
      this.scene.add(ring);
      return { key: z.key, x: z.x, z: z.z, r: CAP_RADIUS, owner: -1, progress: 0, ring };
    });
    // legacy single-point readouts still want one owner/progress pair; the
    // zone nearest the player is the one worth printing
    this.capRing = this.zones[1].ring;
    this.capOwner = -1;
    this.capProgress = 0;

    // the battle-area edge; applyHudMode shows it to tank crews only
    this.boundary = buildBoundaryCurtain(this.scene, TANK_BOUND);
    this._mapBounds = { minX: -TANK_BOUND, maxX: TANK_BOUND, minZ: -TANK_BOUND, maxZ: TANK_BOUND };
    // the square the armour fights in: the air AI's circuits keep their
    // holding stacks out of it and their gates on their own side of it
    // (ai/planeAI.js rtbGeometry / rtbHoldCentre)
    this.groundBattleBound = TANK_BOUND;

    this.effects = new Effects(this.scene);
    // F6: the prop registry needs an effects sink before it can throw splinters
    setSceneryEffects?.(this.effects);
    const settings = progress.settings || {};
    this.shake = new CameraShake({
      scale: settings.shakeScale != null ? settings.shakeScale : 1,
    });
    this.showDamageLog = settings.showDamageLog !== false;

    // shells draw through the effects' tracer law (X-04): no mesh per shell
    this.shellMgr = new ShellManager(this.scene, this.effects);
    this.bullets = new BulletManager(this.scene);
    this.bombManager = new BombManager(this.scene);
    // The manager stages the whole blast presentation itself now — see the note
    // in bombExplode for why this class no longer draws or voices its own.
    this.bombManager.setBlastContext({
      shake: this.shake, camera: this.camera, sound: true, fx: true,
    });

    this.tanks = [];
    this.planes = [];
    // this.groundUnits and this.airfields are built above, before the scenery
    // scatter — re-initialising them here would orphan the airfield AA.
    this.tankAIs = [];
    this.planeAIs = [];
    this.wrecks = [];
    this.tickets = [TICKETS_MAX, TICKETS_MAX];
    this.respawnQueue = []; // { kind: 'tank'|'plane', team, specId, timer }
    this.time = 0;
    this.elapsed = 0;
    this.playerKills = 0;
    this.playerAirKills = 0;
    this.playerAssists = 0;
    this.playerHits = 0;
    this.playerCaps = 0;
    this.playerGroundKills = 0;
    this.playerDamage = 0;
    this.playerSpawnsUsed = 0;
    this.silverEarned = 0;
    this.rpEarned = 0;
    this.awardsEarned = [];
    this.burnEmit = 0;
    this.hitPopCd = 0;
    this.surfTick = 0;
    // realistic difficulty: friendly fire on, no enemy markers/minimap/pen hints
    // The raw string is kept too: planeEntity.setDifficulty() takes the mode,
    // and every Plane built here has to be handed it or the structural G
    // limiter stays on the arcade setting for both sides.
    this.difficulty = progress.getDifficulty();
    this.realistic = this.difficulty === 'realistic';
    this.spectate = false;
    this.stats = new Map(); // scoreboard: name -> { kills, deaths, ... }
    this.bailTimer = 0;
    this.bailMsgCd = 0;
    this.deathCamKiller = null;
    this.deathCamAngle = 0;
    // X-ray hit camera, shown picture-in-picture on the left (main.js renders it)
    this.pip = { active: false, timer: 0 };
    this.xray = new XrayView();

    this.camYaw = 0;
    this.camPitch = -0.1;
    this.camDist = 14;
    this.sniper = false;
    this.sniperFov = 16;
    this.zoom = false;
    this.fov = 60;
    this.followDelay = 0;
    this.kbTimer = 0;
    this.rumble = 0;

    // ---- consumables, support and awards ----
    this.artStrikes = [];
    this.artCooldown = 0;
    this.artUses = 2;
    this.scoutCooldown = 0;
    this.airWarnCd = 0;
    this.boundMsgCd = 0;
    this.repairMsgCd = 0;
    this.driverDownShown = false;
    this.streak = 0;
    this.firstBlood = false;
    this.wasBurning = false;
    this.awardFlags = { streak3: false, streak5: false, streak7: false };
    this.capHold = 0;
    this.capTickPop = 0;
    // machine-gun income arrives a few Silver at a time; it is banked here and
    // popped once it is worth reading
    this._dripS = 0;
    this._dripR = 0;
    // the vehicle's own reward multiplier, cached because it is a table lookup
    // and the vehicle only changes on respawn
    this._multId = null;
    this._mult = { silver: 1, rp: 1 };

    // ---- economy: what settle() will need at the end ----
    this.usage = [];
    this.usageNow = null;
    this.losses = [];
    this.survived = [];
    this.consSnap = null;
    // reused every frame so the hot loops allocate nothing
    this._mapUnits = [];
    // stamps each unit's smoke verdict (smokeHidden) with the frame it was
    // taken in, so the map, the markers and the lead rings ask it once
    this._smokeFrame = 1;
    this._bulletTargets = [];
    this._collideList = [];
    this._objective = '';
    this._objectiveSig = '';
    this._objectiveT = 0;
    // The managers read these synchronously inside update(), so one bound
    // callback and one options object each is enough for the whole battle —
    // the alternative is four fresh closures and two literals every frame.
    this._onShellImpact = (kind, info) => this.onShellImpact(kind, info);
    this._onShellFlyby = (kind, pos, miss) => this.onShellFlyby(kind, pos, miss);
    this._onBombExplode = (point, bomb) => this.bombExplode(point, bomb);
    // a fuse that never armed: without the hook the round just vanishes in a
    // dirt puff and the pilot never learns why his direct hit did nothing
    this._bombOpts = { onDud: (point, bomb, info) => this.onBombDud(point, bomb, info) };
    // filled by predictImpact for the bomb sight: { time, armed, delayed, height }
    this._sightInfo = { time: 0, armed: true, delayed: false, height: 0 };
    this._onBulletPlane = (target, dmg, shooter, point) =>
      this.onBulletPlane(target, dmg, shooter, point);
    this._onBulletGround = (g, b, point) => this.onBulletGround(g, b, point);
    this._onAAFire = (gun) => {
      sfx3d.mg(gun.position);
      this.effects.mgFlash(gun.position, tmpA.set(0, 1, 0));
    };
    this._shellOpts = { listenerPos: this.camera.position, onFlyby: this._onShellFlyby, player: null };
    this._bulletOpts = { listenerPos: this.camera.position, onFlyby: this._onShellFlyby, player: null };
    this._engineOpts = {
      pos: null, rpm: 0, throttle: 0, type: 'tank', moving: false, shift: false,
    };
    this._matchInfo = { timeLeft: 0, mode: 'Combined Arms', objective: '' };
    this._sniperMarks = [200, 400, 600, 800, 1000].map((R) => ({ px: 0, label: R, range: R }));
    this.spawnTally = {
      kills: 0, assists: 0, groundKills: 0, caps: 0, hits: 0, capTicks: 0,
    };
    this.spawnSpent = 0;
    this.spawnLog = [];

    // ---- matchmaking: both teams drawn against one battle rating ----
    let plan = null;
    try {
      plan = planBattle({
        mode: 'combined',
        kind: this.playerIsPlane ? 'air' : 'ground',
        playerSpecId,
      });
    } catch (err) {
      plan = null;
    }
    this.plan = plan;
    this.spawnBudget = (plan && plan.spawnBudget) || createSpawnBudget('combined');
    const playerSpec = this.playerIsPlane ? PLANE_SPECS[playerSpecId] : TANK_SPECS[playerSpecId];

    for (let team = 0; team < 2; team++) {
      const isPlayerTeam = team === 0;
      // the player fills one slot on his own side, in whichever class he brought
      const tankCount = isPlayerTeam && !this.playerIsPlane ? 4 : 5;
      const planeCount = isPlayerTeam && this.playerIsPlane ? 2 : 3;
      const tankIds = this.rosterFor(plan, 'ground', team, playerSpec, tankCount);
      const planeIds = this.rosterFor(plan, 'air', team, playerSpec, planeCount);
      tankIds.forEach((id, i) => this.spawnTank(id, team, false, i));
      planeIds.forEach((id, i) => this.spawnPlane(id, team, false, i));
      const sideX = team === 0 ? -1 : 1;
      // One gun per flank, forward of the strip and roughly 500 m apart in Z,
      // so an attack run down one side of the map meets one of them rather
      // than both. The old pair drew a random Z each and regularly ended up
      // within a hundred metres of one another.
      const roamZmax = ROAM_Z_MAX;
      for (let i = 0; i < ROAM_AA; i++) {
        const flank = i % 2 === 0 ? -1 : 1;
        this.groundUnits.push(
          new AAGun(
            this.scene, team,
            sideX * rand(340, 460),
            flank * rand(240, roamZmax),
            i,
          ),
        );
      }
    }
    this.player = this.playerIsPlane
      ? this.spawnPlane(playerSpecId, 0, true, 1.5)
      : this.spawnTank(playerSpecId, 0, true, 1.5);
    this.camYaw = this.player.yaw;
    // the same opening framing a respawn gets (playerRespawn): the aircraft
    // chase sits where the air battle's does, 20 m back
    this.camPitch = this.playerIsPlane ? 0 : -0.1;
    this.camDist = this.playerIsPlane ? 20 : 14;
    // a sortie starts with the view snapped onto the nose, springs at rest
    if (this.playerIsPlane) this.planeCam.reset(this.player);
    this.playerDead = false;
    this.playerDeathHandled = false;
    this.deadTimer = 0;

    this.applyHudMode();
  }

  // The view angles. In an aeroplane they are the aircraft camera's raw aim
  // (the mouse integrates into it, the instructor flies at it, a harness can
  // still point it by writing camYaw); on the ground, and for the spectator
  // when the last vehicle was a tank, they are plain fields of this class.
  get camYaw() {
    return this.playerIsPlane && this.planeCam ? this.planeCam.yaw : this._camYaw || 0;
  }

  set camYaw(v) {
    if (this.playerIsPlane && this.planeCam) this.planeCam.yaw = v;
    else this._camYaw = v;
  }

  get camPitch() {
    return this.playerIsPlane && this.planeCam ? this.planeCam.pitch : this._camPitch || 0;
  }

  set camPitch(v) {
    if (this.playerIsPlane && this.planeCam) this.planeCam.pitch = v;
    else this._camPitch = v;
  }

  // The yaw actually on screen: what a compass, the minimap's view cone and a
  // directional damage arc have to be measured against. The aircraft camera's
  // smoothed yaw lags the raw aim by design; the aim zoom looks down the nose.
  viewYaw() {
    if (this.spectate || !this.playerIsPlane || !this.planeCam) return this.camYaw;
    const p = this.player;
    if (this.zoom && p && p.alive) return p.yaw;
    return this.planeCam.viewYaw;
  }

  // BR-matched roster for one team and one vehicle family. planBattle already
  // draws both, but a five-tank side out of a six-vehicle pool wants a wider
  // spread than the default or it fields the same tank three times.
  rosterFor(plan, kind, team, playerSpec, count) {
    const fromPlan = plan
      ? kind === 'air'
        ? team === 0 ? plan.planeAllies : plan.planeEnemies
        : team === 0 ? plan.tankAllies : plan.tankEnemies
      : null;
    if (fromPlan && fromPlan.length >= count) return fromPlan.slice(0, count);
    let ids = fromPlan ? fromPlan.slice() : [];
    try {
      const extra = pickLineup({
        playerSpec,
        kind,
        count: count - ids.length,
        difficulty: progress.getDifficulty(),
        battleBr: plan ? plan.battleBr : undefined,
        spread: kind === 'air' ? 1.3 : 1.0,
      });
      ids = ids.concat(extra);
    } catch (err) {
      // matchmaking is a nicety; a battle that cannot draw a roster still runs
    }
    const pool = kind === 'air' ? PLANE_SPECS : TANK_SPECS;
    const fallback = Object.keys(pool);
    while (ids.length < count) ids.push(fallback[ids.length % fallback.length]);
    return ids.filter((id) => pool[id]).slice(0, count);
  }

  applyHudMode() {
    const hud = this.hud;
    // the ammo stack owns the reload bar now, so the old centre bar stands down
    hud.setReloadVisible(false);
    hud.setCrosshairVisible(!this.playerIsPlane);
    hud.setHelp(
      this.playerIsPlane ? PLANE_HELP : tankHelp(this.player && this.player.spec),
    );
    // switching class must not leave the other class's panel on screen
    hud.setAmmoPanel?.(null);
    hud.setAirPanel?.(null);
    hud.setDamagePanel?.(null);
    hud.setBlackout?.(0);
    hud.setBoundaryWarning?.(0);
    hud.setScopeVisible(false);
    hud.setReflectorSight?.(0, 0, false); // a tank crew has no reflector sight
    hud.setMarker('bombsight', '', 0, 0, '', false);
    hud.setMarker('bomblead', '', 0, 0, '', false);
    // the battle-area curtain is a tank crew's wall; a pilot flies over it
    if (this.boundary) this.boundary.visible = !this.playerIsPlane;
  }

  spawnTank(specId, team, isPlayer, slot = 0) {
    const spec = isPlayer
      ? applyMods(TANK_SPECS[specId], 'ground', { crew: true })
      : TANK_SPECS[specId];
    const name = isPlayer
      ? `You (${spec.name})`
      : `${team === 0 ? 'Ally' : 'Enemy'} ${spec.name}-${slot + 1}`;
    const tank = new Tank(this.scene, spec, team, name, isPlayer);
    tank.bound = TANK_BOUND;
    tank.surface = this.surfaceKey;
    const x = (team === 0 ? -600 : 600) + rand(-25, 25);
    const z = -160 + slot * 80 + rand(-15, 15);
    tank.setPose(x, z, team === 0 ? Math.PI / 2 : -Math.PI / 2);
    this.tanks.push(tank);
    this.stat(tank);
    if (isPlayer) {
      // the player drives the repair key by hand; AI crews keep fixing their own
      tank.autoRepair = false;
      this.beginUsage(spec);
    } else {
      this.tankAIs.push(new TankAI(tank, this));
    }
    return tank;
  }

  // scoreboard entry for a combatant (respawns merge by display name)
  stat(entity) {
    const key = entity.isPlayer ? 'You' : entity.displayName;
    let s = this.stats.get(key);
    if (!s) {
      s = {
        name: key,
        team: entity.team,
        kills: 0,
        deaths: 0,
        assists: 0,
        caps: 0,
        groundKills: 0,
        airKills: 0,
        score: 0,
        vehicle: entity.spec ? entity.spec.name : '',
        isPlayer: !!entity.isPlayer,
      };
      this.stats.set(key, s);
    }
    if (entity.spec) s.vehicle = entity.spec.name;
    return s;
  }

  scoreboardData() {
    const allies = [];
    const enemies = [];
    for (const s of this.stats.values()) (s.team === 0 ? allies : enemies).push(s);
    const cmp = (a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths;
    allies.sort(cmp);
    enemies.sort(cmp);
    return { allies, enemies };
  }

  spawnPlane(specId, team, isPlayer, slot = 0) {
    const spec = isPlayer
      ? applyMods(PLANE_SPECS[specId], 'air', { crew: true })
      : PLANE_SPECS[specId];
    const name = isPlayer
      ? `You (${spec.name})`
      : `${team === 0 ? 'Ally' : 'Enemy'} ${spec.name}-${slot + 1}`;
    const plane = new Plane(this.scene, spec, team, name, isPlayer, this.difficulty);
    // Airborne, over their own strip and pointed the way a departing aircraft
    // leaves it — PLANE_SPAWN_BACK outboard of the strip centre (|x| at most
    // 1170, inside MAP_EDGE) and the yaw is the same expression createAirfield()
    // is given for `heading`, so a spawn reads as a section that has just
    // rotated off the concrete and is heading for the fight.
    const afZ = AIRFIELD_Z;
    const x = (team === 0 ? -1 : 1) * (AIRFIELD_X + PLANE_SPAWN_BACK) + rand(-30, 30);
    const z = afZ + (slot - 1) * 70 + rand(-15, 15);
    plane.setPose(x, terrainHeight(x, z) + 270 + slot * 14, z, team === 0 ? Math.PI / 2 : -Math.PI / 2);
    // planeEntity knows nothing about airfields, so onGround / serviceFrac /
    // rearmTimer / groundYaw are seeded here. Without it the first service tick
    // adds dt to undefined and the repair readout reads NaN% for ever after.
    initPlaneAirfieldState(plane);
    this.planes.push(plane);
    this.stat(plane);
    if (isPlayer) {
      this.beginUsage(spec);
    } else {
      // light fighters fly top cover; everything heavier works the ground
      const role = PLANE_SPECS[specId].klass === 'Light Fighter' ? 'fighter' : 'striker';
      this.planeAIs.push(new PlaneAI(plane, this, role));
    }
    return plane;
  }

  // Everything world/airfield.js needs from this battle. One object, refreshed
  // rather than rebuilt, because it is asked for once per plane per frame.
  afCtx() {
    let ctx = this._afCtx;
    if (!ctx) {
      ctx = {
        airfields: this.airfields,
        hud: this.hud,
        effects: this.effects,
        shake: this.shake,
        input,
        logOn: this.showDamageLog,
        onTakeOff: (plane) => {
          // snap the chase camera back behind the aircraft on rotation
          if (plane === this.player) this.followDelay = 0;
        },
        // The crew turned the aeroplane round (and perhaps towed it to the far
        // end of the runway). The view and the mouse aim were still looking
        // the way it stopped — at its nose from in front, with the instructor
        // told to fly back the way it came the moment it left the ground — so
        // they are put back behind it, a cut that goes with the swing's own.
        // Same hook, same reason as the air battle's.
        onServiced: (plane, af, how) => {
          if (plane === this.player && this.playerIsPlane && how && (how.swung || how.towed)) {
            this.planeCam.reset(plane);
            this.followDelay = 0;
            this.kbTimer = 0;
            this.followStrength = 0;
          }
        },
      };
      this._afCtx = ctx;
    }
    // the player changes on every respawn, so this one field is re-read
    ctx.player = this.playerIsPlane ? this.player : null;
    return ctx;
  }

  // ---- interfaces used by the AIs ----
  requestFire(tank) {
    const desc = tank.tryFire();
    if (!desc) return;
    this.shellMgr.fire(desc);
    const caliber = (desc.shell && desc.shell.caliber) || 75;
    this.effects.muzzleBlast(
      desc.pos, desc.dir, caliber, terrainHeight(desc.pos.x, desc.pos.z),
    );
    sfx3d.fire(desc.pos, { caliber });
    if (tank === this.player) {
      this.shake.add(0.16 + caliber / 380, 0.45);
      if (this.usageNow) {
        this.usageNow.shells[desc.type] = (this.usageNow.shells[desc.type] || 0) + 1;
      }
    } else {
      this.shake.addAt(0.1 + caliber / 500, desc.pos, this.camera.position, 130);
    }
  }

  strafeTargetsFor(team) {
    const out = [];
    for (const t of this.tanks) if (t.alive && t.team !== team) out.push(t);
    for (const g of this.groundUnits) if (g.alive && g.team !== team) out.push(g);
    return out;
  }

  dropBomb(plane) {
    if (!plane.alive || plane.bombs <= 0) return;
    plane.bombs--;
    this.bombManager.drop(plane);
    if (plane === this.player && this.usageNow) this.usageNow.bombs++;
  }

  fireRocket(plane) {
    if (!plane.alive || plane.rockets <= 0) return;
    plane.rockets--;
    this.bombManager.fireRocket(plane);
    sfx3d.fire(plane.position, { caliber: 82, gain: 0.7 });
    if (plane === this.player && this.usageNow) this.usageNow.rockets++;
  }

  distFactor(point) {
    return clamp(1 - point.distanceTo(this.camera.position) / 800, 0.08, 1);
  }

  // ---------------- main update ----------------
  update(dt) {
    if (this.finished) return;
    this.time += dt;
    this.elapsed = this.time;
    this._smokeFrame++;
    if (this.hitPopCd > 0) this.hitPopCd -= dt;
    if (this.artCooldown > 0) this.artCooldown -= dt;
    if (this.scoutCooldown > 0) this.scoutCooldown -= dt;
    if (this.airWarnCd > 0) this.airWarnCd -= dt;
    if (this.boundMsgCd > 0) this.boundMsgCd -= dt;
    this.surfTick -= dt;

    const p = this.player;
    if (p.alive) {
      if (this.playerIsPlane) this.updatePlaneControls(dt);
      else this.updateTankControls(dt);
      this.updateBail(dt);
    } else if (!this.playerDead && !this.playerDeathHandled) {
      this.playerDead = true;
      this.deadTimer = 3.0;
      this.startDeathCam();
    }
    if (this.playerDead) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) {
        this.playerDead = false;
        this.playerDeathHandled = true;
        this.hud.setDeathInfo(null);
        this.onPlayerDeath?.(this.canRespawn(), this.playerKills);
      }
    }
    if (input.pressed('KeyM')) this.hud.toggleBigMap?.();

    for (const ai of this.tankAIs) ai.update(dt);
    for (const ai of this.planeAIs) ai.update(dt);

    // one surface probe per tank a few times a second — plenty for a vehicle
    // that covers ten metres in that time, and far cheaper than per frame
    const resample = terrainSurface && this.surfTick <= 0;
    if (resample) this.surfTick = 0.3;

    for (const tank of this.tanks) {
      const wasAlive = tank.alive;
      const wasBurning = tank.burning;
      if (resample && tank.alive) this.sampleSurface(tank);
      tank.update(dt);
      if (tank.alive) {
        // F6: a moving hull flattens saplings and fences. Only while actually
        // rolling, so a parked tank does not re-query the prop grid every frame.
        if (Math.abs(tank.speed) > 0.5) this.crushScenery(tank);
        const sn = clamp(Math.abs(tank.speed) / Math.max(1, tank.spec.maxSpeed), 0, 1);
        // soft going throws far more of itself into the air than a hard road
        // does, and drag is exactly how soft terrain.js says it is
        const soft = clamp(0.7 + (tank.surfaceDrag != null ? tank.surfaceDrag : 0.06) * 2.4, 0.7, 1.5);
        // + yaw, gauge, track width: the track prints (X-07, contract R2-T)
        this.effects.trackDust(
          tmpA.copy(tank.position), clamp(sn * soft, 0, 1), tank.dustColor || this.dustColor, dt,
          tank.yaw, tank.trackGauge, tank.trackWidth,
        );
        // AV-04: the exhaust coughs on the frame of the rev event
        if (tank.revKick && this.effects.exhaustPuff && tank.exhaustWorld) {
          this.effects.exhaustPuff(tank.exhaustWorld(tmpA), tank.engineKind, tank.revKick);
        }
        // a wrecked powerpack trails smoke long before the vehicle dies, which
        // is how you spot the one that is already hurt
        const engineDead = tank.modules && !tank.modules.engine.ok;
        if (tank.burning || engineDead || tank.crewFrac < 0.4) {
          this.effects.engineSmoke(
            tmpA.copy(tank.position).add(tmpB.set(0, 1.4, -1)),
            tank.burning ? 'fire' : engineDead ? 'heavy' : 'light',
            dt,
          );
        }
      }
      if (wasAlive && !tank.alive) {
        removeEngine('t' + tank.id);
        this.onTankKilled(null, tank);
      }
      if (tank === this.player) this.trackPlayerTankState(wasBurning);
    }

    for (const plane of this.planes) {
      const wasAlive = plane.alive;
      // On the concrete the flight model is stood down and the aeroplane is a
      // bad car — same branch the air battle takes.
      if (plane.onGround) updateGroundRoll(plane, dt, this.afCtx());
      else plane.update(dt);
      if (plane.justExploded) {
        plane.justExploded = false;
        // AV-01: one law for the picture, the sound and the shake
        this.effects.explosion(plane.position.clone(), BLAST_KG.aircraft);
        sfx3d.explosion(plane.position, { size: 1.8, kg: BLAST_KG.aircraft });
        this.shake.addBlast(BLAST_KG.aircraft, plane.position, this.camera.position);
      }
      if (plane.alive) {
        // the approach gate: gear down, slow, level and sinking gently
        updateAirfieldService(plane, dt, this.afCtx());
        this.updatePlaneTrails(plane, dt);
      }
      if (wasAlive && !plane.alive) {
        // The aeroplane's last words — "Undercarriage collapsed — 4.6 m/s",
        // "Hit the hangar", "Belly landing" — are the only explanation the
        // pilot gets, and updatePlaneSystems stops draining once he is dead.
        if (plane === this.player && typeof plane.drainEvents === 'function') {
          const last = plane.drainEvents();
          if (last) {
            for (const e of last) this.hud.incomingMessage?.(e, 'critical', this.showDamageLog);
          }
        }
        removeEngine('p' + plane.id);
        this.onPlaneKilled(plane.lastHitAge < 8 ? plane.lastAttacker : null, plane);
      }
      this.updateGuns(plane, dt);
    }
    this.resolvePlaneCollisions();

    // player weapons
    if (
      p.alive && !this.playerIsPlane && input.locked && input.fireHeld && !p.spec.aa
    ) {
      this.requestFire(p);
    }
    if (!this.playerIsPlane) {
      this.updateTankStream(dt);
      this.updateTankConsumables(dt);
    } else {
      this.updatePlaneSystems(dt);
    }
    if (p.alive && this.playerIsPlane && input.pressed('Space')) this.dropBomb(p);
    if (p.alive && this.playerIsPlane && input.pressed('KeyF')) this.fireRocket(p);

    for (const g of this.groundUnits) {
      g.update(dt, this.planes, this.bullets, this._onAAFire);
    }

    // the flyby guard only arms when the manager knows whose rounds are ours
    this._shellOpts.player = p;
    this._bulletOpts.player = p;
    this.shellMgr.update(dt, this.tanks, this._onShellImpact, this._shellOpts);
    this.bombManager.update(dt, this.tanks, this._onBombExplode, this.effects, this._bombOpts);
    const targets = this._bulletTargets;
    targets.length = 0;
    for (const t of this.tanks) targets.push(t);
    for (const g of this.groundUnits) targets.push(g);
    this.bullets.update(
      dt,
      this.planes,
      this._onBulletPlane,
      this.effects,
      targets,
      this._onBulletGround,
      this._bulletOpts,
    );

    this.resolveTankCollisions();
    this.cleanupWrecks(dt);
    this.updateResupply(dt);
    this.updatePip(dt);
    this.updateSmoke(dt);
    this.updateArtillery(dt);
    this.updateAirThreat();
    this.effects.update(dt);
    this.updateCapture(dt);
    this.updateRespawns(dt);
    this.driveEngines();
    this.shake.update(dt);
    this.updateCamera(dt);
    this.updateHUD();

    // the listener has to sit on the finished camera: everything positional —
    // the speed-of-sound delay, the distance timbre, the panning — keys off it
    this.camera.updateMatrixWorld();
    setListener(this.camera);
    updateAudio();

    this.checkEnd();
    // Sun direction is the preset's; the shadow box is moved by scenery.js from
    // scene.onBeforeRender (updateSunAnchor). Nothing to do here.
  }

  sampleSurface(tank) {
    const s = terrainSurface(tank.position.x, tank.position.z);
    if (!s) return;
    if (s.type) tank.surface = s.type;
    if (s.dustColor != null) tank.dustColor = s.dustColor;
    // Grip and drag are the half of the sample the vehicle's own surface row
    // cannot know: they carry the map preset's gripMul and how soft the going
    // actually is, where the row only knows the name of the ground. Handed
    // over as fields — and through the entity's own door when it has one — so
    // a hull that reads them uses them and one that does not drives as before.
    if (s.grip != null) tank.surfaceGrip = s.grip;
    if (s.drag != null) tank.surfaceDrag = s.drag;
    tank.setSurface?.(s.type, s.grip, s.drag);
  }

  // F6: props the hull can push over go down; a house or a boulder comes back
  // as `blocked`, and the tank loses its momentum against it rather than
  // driving through the wall.
  crushScenery(tank) {
    if (typeof crushProps !== 'function') return;
    // hull weight in tonnes is the crushing force: a Stuart flattens
    // saplings and fences, a Tiger takes the whole treeline
    const fwd = Math.sign(tank.speed || 1);
    hullCrushOpts.force = (tank.spec.mass || 25) * 0.8;
    hullCrushOpts.dirX = Math.sin(tank.yaw) * fwd;
    hullCrushOpts.dirZ = Math.cos(tank.yaw) * fwd;
    try {
      crushProps(tank.position.x, tank.position.z, tank.radius * 0.8, hullCrushOpts);
    } catch (err) {
      // scenery is decoration to a battle that runs without it
    }
    // A house or a boulder (`blocked`) is no speed cut here any more: that
    // circle stood metres off a gable end. resolveTankCollisions stops the
    // hull at the real wall (solidPushOut) and bumps the player's camera.
  }

  // Every living vehicle that is not the player feeds the positional engine
  // pool. This is what lets a tank crew hear the aircraft that is about to
  // work them over, and it is the cheapest threat cue in the game.
  driveEngines() {
    const p = this.player;
    // one options record for the whole pool: updateEngine reads it and copies
    // what it needs before this loop moves on
    const o = this._engineOpts;
    for (const t of this.tanks) {
      if (!t.alive || t === p) continue;
      const shifting = t.shiftTimer > 0;
      o.pos = t.position;
      o.rpm =
        t.rpm != null
          ? t.rpm
          : Math.min(
            1,
            (Math.abs(t.speed) / Math.max(1, t.spec.maxSpeed)) * 0.8 +
              Math.abs(t.throttleInput) * 0.35,
          );
      o.throttle = Math.abs(t.throttleInput);
      o.type = 'tank';
      o.moving = Math.abs(t.speed) > 0.4;
      o.shift = shifting && !t.wasShifting;
      updateEngine('t' + t.id, o);
      t.wasShifting = shifting;
    }
    for (const pl of this.planes) {
      if (pl === p || pl.state === 'dead') continue;
      o.pos = pl.position;
      o.rpm = Math.min(1, pl.speed / Math.max(1, pl.spec.maxSpeed));
      o.throttle = pl.engineOk ? pl.throttle : 0;
      o.type = 'plane';
      o.moving = true;
      o.shift = false;
      updateEngine('p' + pl.id, o);
    }
  }

  // Contrails at height and speed, vapour off the wings under load, and the
  // plume of a hurt engine. All rate-based, so they take the real dt.
  updatePlaneTrails(plane, dt) {
    const sn = plane.speed / Math.max(1, plane.spec.maxSpeed);
    // X-06: contrails only in cold air above ~7.5 km, vapour only at 5 g+ in
    // humid air (planeEntity hooks); the turn buffet stays on g-load alone.
    const trail = plane.contrailStrength ? plane.contrailStrength() : 0;
    if (trail > 0.05) {
      const span = (plane.spec.span || 10) * 0.42;
      this.effects.contrail(
        tmpA.copy(plane.position).addScaledVector(this.wingAxis(plane, tmpB), span),
        trail, dt,
      );
      this.effects.contrail(
        tmpA.copy(plane.position).addScaledVector(this.wingAxis(plane, tmpB), -span),
        trail, dt,
      );
    }
    const vapour = plane.wingVapourStrength ? plane.wingVapourStrength(this.preset) : 0;
    if (vapour > 0.05) this.effects.wingVortex(tmpA.copy(plane.position), vapour, dt);
    const load = plane.gLoad != null ? clamp((Math.abs(plane.gLoad) - 3) / 4, 0, 1) : 0;
    if (load > 0.05 && plane === this.player) this.shake.add(0.04 * load, 0.2);
    if (!plane.engineOk || plane.smoking) {
      this.effects.engineSmoke(
        tmpA.copy(plane.position),
        plane.burning ? 'fire' : plane.engineOk ? 'light' : 'heavy',
        dt,
      );
    }
  }

  wingAxis(plane, out) {
    return out.set(1, 0, 0).applyQuaternion(plane.quat);
  }

  updateGuns(plane, dt) {
    if (plane.gunTimer > 0) plane.gunTimer -= dt;
    if (plane.gunSound > 0) plane.gunSound -= dt;
    if (!plane.alive || !plane.firing || plane.ammo <= 0) {
      if (plane.gunTimer < 0) plane.gunTimer = 0;
      return;
    }
    const mine = plane === this.player;
    while (plane.gunTimer <= 0 && plane.ammo > 0) {
      plane.gunTimer += 1 / plane.spec.gun.rof;
      plane.ammo--;
      const pos = plane.nextMuzzle(tmpV);
      // wing guns are harmonised: they cross at the aircraft's convergence
      // range rather than staring straight ahead forever
      const dir = plane.aimFromMuzzle
        ? plane.aimFromMuzzle(pos, tmpV2)
        : plane.forward(tmpV2);
      this.bullets.fire(pos, dir, plane.spec.gun.speed, plane.spec.gun.dmg, plane, plane.spec.gun.spread);
      this.effects.mgFlash(pos, dir);
      if (mine && this.usageNow) this.usageNow.stream++;
    }
    if (plane.gunSound <= 0) {
      plane.gunSound = 0.11;
      sfx3d.mg(plane.position);
      if (mine) this.shake.add(0.05, 0.16);
    }
  }

  // ---------------- player controls ----------------
  updateTankControls(dt) {
    const p = this.player;
    const sens = 0.0022 * (this.fov / 60);
    // the aim can't dip below / climb above what the gun physically reaches
    const elev = p.spec.gunElev || { min: -0.14, max: 0.38 };
    const maxPitch = p.spec.aa ? 1.4 : elev.max + 0.06;
    const minPitch = elev.min - 0.06;
    this.camYaw = wrapAngle(this.camYaw - input.mouseDX * sens);
    this.camPitch = clamp(this.camPitch - input.mouseDY * sens, minPitch, maxPitch);
    if (input.wheel !== 0) {
      if (this.sniper) {
        // K-04: the wheel steps through the optic's detents (true field,
        // real magnification, labelled aux), widest first
        const steps = opticSteps(p.spec);
        this.sniperStep = clamp((this.sniperStep || 0) + (input.wheel > 0 ? -1 : 1), 0, steps.length - 1);
        this.sniperFov = steps[this.sniperStep].fov;
      } else {
        this.camDist = clamp(this.camDist + input.wheel * 1.5, 8, 24);
      }
    }
    if (input.pressed('ShiftLeft') || input.pressed('ShiftRight')) {
      this.sniper = !this.sniper;
    }
    if (input.pressed('Digit1')) p.setShellType('AP');
    if (input.pressed('Digit2')) p.setShellType('HE');
    if (input.pressed('Digit3')) {
      const special = Object.keys(p.spec.shells)[2];
      if (special) p.setShellType(special);
    }
    p.manualAim = this.sniper;

    p.throttleInput = (input.down('KeyW') ? 1 : 0) + (input.down('KeyS') ? -1 : 0);
    p.steerInput = (input.down('KeyA') ? 1 : 0) + (input.down('KeyD') ? -1 : 0);

    const dir = tmpV.set(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * Math.cos(this.camPitch),
    );
    const origin = tmpV2.copy(this.camera.position);
    const end = tmpV3.copy(origin).addScaledVector(dir, 1400);
    // a wall under the reticle (past the hull) ends the aim ray on its face
    clipRayToScenery(origin, end, p.position);

    this.aimTarget = intersectTanks(this.tanks, origin, end, p);
    // A hull inside a smoke screen is not "under the reticle": the ray finds it
    // straight through the cloud, and the penetration verdict, the rangefinder
    // and the gun marker settling onto it were the HUD drawing the player a
    // picture of a tank the screen was hiding. The aim falls through to the
    // ground behind, exactly as if the smoke were solid.
    if (this.aimTarget && this.smokeVeils(origin, this.aimTarget.hit.point)) {
      this.aimTarget = null;
    }
    if (this.aimTarget) {
      p.aimPoint.copy(this.aimTarget.hit.point);
    } else if (!this.marchToGround(origin, dir, origin.distanceTo(end), p.aimPoint)) {
      p.aimPoint.copy(end);
    }
    this.aimDist = p.position.distanceTo(p.aimPoint);

    // a continuous rumble over rough ground, proportional to how hard the
    // suspension is working rather than to raw speed
    this.rumble -= dt;
    if (this.rumble <= 0 && Math.abs(p.speed) > 1) {
      this.rumble = 0.12;
      const sn = clamp(Math.abs(p.speed) / Math.max(1, p.effMaxSpeed || p.spec.maxSpeed), 0, 1);
      const rough = clamp(Math.abs(p.hullPitchRate || 0) * 2.2, 0, 1);
      this.shake.add(0.012 + sn * 0.03 + rough * 0.05, 0.14);
    }
  }

  // Where the aim ray meets the ground. A coarse march brackets the crossing
  // and a short bisection closes on it, which costs roughly a fifth of the
  // samples the old fixed 240-step walk spent for the same accuracy — and
  // terrainHeight is eight transcendentals plus a road sweep a time.
  marchToGround(origin, dir, maxDist, out) {
    // climbing away from the map above every hill it can build: nothing there
    if (dir.y >= 0 && origin.y > TERRAIN_CEILING) return false;
    if (origin.y <= terrainHeight(origin.x, origin.z)) {
      out.set(origin.x, origin.y + 0.2, origin.z);
      return true;
    }
    const COARSE = 40;
    const step = maxDist / COARSE;
    let prevT = 0;
    for (let i = 1; i <= COARSE; i++) {
      const t = i * step;
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      const z = origin.z + dir.z * t;
      if (y > terrainHeight(x, z)) {
        prevT = t;
        continue;
      }
      // six halvings take the 35 m bracket under a metre, finer than the
      // crosshair can resolve at any range this ray covers
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) * 0.5;
        const mx = origin.x + dir.x * mid;
        const my = origin.y + dir.y * mid;
        const mz = origin.z + dir.z * mid;
        if (my <= terrainHeight(mx, mz)) hi = mid;
        else lo = mid;
      }
      const hx = origin.x + dir.x * hi;
      const hz = origin.z + dir.z * hi;
      out.set(hx, terrainHeight(hx, hz) + 0.2, hz);
      return true;
    }
    return false;
  }

  updatePlaneControls(dt) {
    const p = this.player;
    const pc = this.planeCam;
    // mouse counts go into the aircraft camera's raw aim; the sensitivity
    // follows the field of view actually on screen, zoomed or not
    const sens = 0.0022 * (this.fov / 60);
    if (input.mouseDX !== 0 || input.mouseDY !== 0) this.followDelay = 0.9;
    // A-02: P swaps the chase view and the cockpit; in the cockpit the view
    // banks with the wings, so the mouse is read on the screen
    if (input.pressed('KeyP')) this.cockpit = !this.cockpit;
    if (this.cockpit && p.alive && pc.addMouseScreen) pc.addMouseScreen(input.mouseDX, input.mouseDY, sens);
    else pc.addMouse(input.mouseDX, input.mouseDY, sens);

    if (input.wheel !== 0 && !this.zoom) {
      this.camDist = clamp(this.camDist + input.wheel * 2, 12, 40);
    }
    // entering zoom snaps the aim to the current nose direction
    if (input.rightDown && !this.zoom) pc.aimAlongNose(p);
    this.zoom = input.rightDown;

    const thrIn =
      (input.down('ShiftLeft') || input.down('ShiftRight') ? 1 : 0) -
      (input.down('ControlLeft') || input.down('ControlRight') ? 1 : 0);
    p.throttle = clamp(p.throttle + thrIn * 0.5 * dt, 0, 1);

    // combined controls: keys own their axis, mouse instructor covers the
    // rest; keyboard-only flying releases the instructor entirely
    const kRoll = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const kPitch = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    const kYaw = (input.down('KeyQ') ? 1 : 0) - (input.down('KeyE') ? 1 : 0);
    const keysHeld = kRoll !== 0 || kPitch !== 0 || kYaw !== 0;
    const mouseRecent = this.followDelay > 0;

    if (!keysHeld || mouseRecent) {
      // The mouse flies to exactly where it points. In the keyboard grace the
      // instructor is aimed past any swing the view is still making over the
      // vertical (planeCamera.steerPoint), so letting go of S on the far side
      // of a loop holds the attitude instead of chasing the half-turned view;
      // off the vertical the two points are the same.
      const aim = mouseRecent || typeof pc.steerPoint !== 'function'
        ? pc.aimPoint(p, 600, tmpV3)
        : pc.steerPoint(p, 600, tmpV3);
      p.steerTowards(aim, dt);
    } else {
      p.controls.roll = 0;
      p.controls.pitch = 0;
      p.controls.yaw = 0;
    }
    if (kRoll !== 0) p.controls.roll = kRoll;
    if (kPitch !== 0) p.controls.pitch = kPitch;
    if (kYaw !== 0) p.controls.yaw = kYaw;
    this.kbTimer = keysHeld ? 1.2 : this.kbTimer - dt;

    // The camera chases the nose during keyboard flying — a spring now
    // (planeCamera.followNose), not the old constant angular rate whose start
    // and stop were a step in angular velocity the player felt as a jerk.
    // Only the strength is decided here: the follow itself runs in
    // updateCamera(), after the physics step, so it chases the nose that is
    // about to be drawn rather than last frame's. Full strength while a key is
    // held, then easing out over the 1.2 s grace; the mouse or the aim zoom
    // stand it down.
    this.followDelay -= dt;
    this.followStrength = !this.zoom && this.followDelay <= 0
      ? (keysHeld ? 1 : this.kbTimer > 0 ? 0.55 * Math.min(1, this.kbTimer / 0.5) : 0)
      : 0;
    p.firing = input.locked && input.fireHeld;
  }

  // player-only stream weapons: SPAA autocannon on LMB, coax MG on Space
  updateTankStream(dt) {
    const p = this.player;
    if (p.streamTimer > 0) p.streamTimer -= dt;
    if (p.streamSound > 0) p.streamSound -= dt;
    // C1: the quad 20 mm and the coax need a man in the gunner's seat too
    const canStream =
      typeof p.canFireStream === 'function' ? p.canFireStream() : p.alive && p.streamAmmo > 0;
    if (!canStream || !input.locked) return;
    const isAA = !!p.spec.aa;
    const wpn = isAA ? p.spec.aa : p.spec.mg;
    if (!wpn) return;
    const wantFire = isAA ? input.fireHeld : input.down('Space');
    if (!wantFire) return;
    while (p.streamTimer <= 0 && p.streamAmmo > 0) {
      p.streamTimer += 1 / wpn.rof;
      p.streamAmmo--;
      const pos = p.muzzleWorld(tmpV);
      pos.y -= 0.12;
      const dir = p.gunDirection(tmpV2);
      this.bullets.fire(pos, dir, wpn.speed, wpn.dmg, p, wpn.spread);
      this.effects.mgFlash(pos, dir);
      if (this.usageNow) this.usageNow.stream++;
    }
    if (p.streamSound <= 0) {
      p.streamSound = 0.11;
      sfx3d.mg(p.position);
      this.shake.add(isAA ? 0.07 : 0.045, 0.16);
    }
  }

  // ---------------- tank consumables and support ----------------
  updateTankConsumables(dt) {
    const p = this.player;
    if (!p.alive) return;
    this.syncConsumables(p);

    // Repair is a hold: let go, or move off, or take a hit, and the crew stop.
    // Starting one while rolling would only be cancelled again next frame, so
    // the key says why instead of flickering the repair on and off.
    if (this.repairMsgCd > 0) this.repairMsgCd -= dt;
    if (input.down('KeyR')) {
      if (Math.abs(p.speed) > 0.6) {
        if (p.repairing) p.cancelRepair('moving');
        if (this.repairMsgCd <= 0) {
          this.repairMsgCd = 2.5;
          this.hud.incomingMessage?.('Stop the vehicle to repair', 'warn');
        }
      } else if (!p.repairing) {
        if (p.startRepair()) {
          this.hud.incomingMessage?.(
            `Repairing ${this.moduleLabel(p.repairTarget)}…`, 'info',
          );
        } else if (input.pressed('KeyR')) {
          this.hud.incomingMessage?.('Nothing to repair', 'info');
        }
      }
    } else if (p.repairing) {
      p.cancelRepair('stopped');
    }

    if (input.pressed('KeyF')) {
      if (p.useExtinguisher?.()) {
        this.hud.incomingMessage?.('Fire extinguished', 'info', true);
        radioCue('reload');
      } else if (!p.burning) {
        this.hud.incomingMessage?.('Not on fire', 'info');
      } else {
        this.hud.incomingMessage?.('No extinguisher left', 'warn');
      }
    }

    if (input.pressed('KeyH')) {
      const role = p.useFirstAid?.();
      if (role) {
        this.hud.incomingMessage?.(`${CREW_LABEL[role] || role} patched up`, 'info', true);
        radioCue('reload');
      } else {
        this.hud.incomingMessage?.('First aid unavailable', 'warn');
      }
    }

    if (input.pressed('KeyG')) {
      const s = p.deploySmoke?.();
      if (s) {
        this.effects.smokeScreen(s.pos, s.radius, s.duration);
        this.hud.incomingMessage?.('Smoke deployed', 'info');
      } else {
        this.hud.incomingMessage?.('No smoke grenades', 'warn');
      }
    }

    if (input.pressed('KeyT')) this.callArtillery();
    if (input.pressed('KeyV')) this.scout();
  }

  moduleLabel(key) {
    for (const row of TANK_MODULE_ROWS) if (row[0] === key) return row[1];
    return key || 'module';
  }

  // Charges are spent inside the entity (a repair finishing eats a kit), so the
  // battle watches the counters rather than trying to predict them.
  syncConsumables(p) {
    const c = p.consumables;
    if (!c) return;
    let s = this.consSnap;
    if (!s || s.owner !== p) {
      this.consSnap = {
        owner: p, repair: c.repair, fpe: c.fpe, firstAid: c.firstAid, smoke: c.smoke,
      };
      return;
    }
    const u = this.usageNow && this.usageNow.consumables;
    if (!u) return;
    if (c.repair < s.repair) {
      u.parts += s.repair - c.repair;
      s.repair = c.repair;
    }
    if (c.fpe < s.fpe) {
      u.fpe += s.fpe - c.fpe;
      s.fpe = c.fpe;
    }
    if (c.firstAid < s.firstAid) {
      u.crew += s.firstAid - c.firstAid;
      s.firstAid = c.firstAid;
    }
    if (c.smoke < s.smoke) {
      u.parts += s.smoke - c.smoke;
      s.smoke = c.smoke;
    }
  }

  // How far this crew sees. The Keen Vision skill and the Artillery Support
  // module's observation optics both land on spec.spotFactor, and a commander
  // who is down costs the vehicle the man on the binoculars — the same vision
  // figure the ground battle spots with, so a skill bought in the garage is
  // worth the same in both modes.
  visionFactor() {
    const p = this.player;
    const f = p && p.spec ? p.spec.spotFactor : 1;
    const base = f > 0 ? f : 1;
    return p && p.canScout === false ? base * 0.72 : base;
  }

  // Scouting: the commander marks what he can see for the whole team. Gated on
  // a live commander, which is exactly what canScout means.
  scout() {
    const p = this.player;
    if (!p.alive) return;
    if (p.canScout === false) {
      this.hud.incomingMessage?.('Commander is down — cannot scout', 'warn');
      return;
    }
    if (this.scoutCooldown > 0) {
      this.hud.incomingMessage?.(`Scouting in ${Math.ceil(this.scoutCooldown)}s`, 'info');
      return;
    }
    const eye = this.camera.position;
    // the commander's optics reach as far as his training and his modules say
    const reach = SCOUT_RANGE * (p.spec.spotFactor > 0 ? p.spec.spotFactor : 1);
    let n = 0;
    const mark = (unit) => {
      if (!unit.alive || unit.team === p.team) return;
      const wp = tmpA.set(unit.position.x, unit.position.y + 2, unit.position.z);
      if (eye.distanceTo(wp) > reach) return;
      if (!hasLOS(eye, wp)) return;
      // smoke at the same opacity every marker and every bot is held to: a
      // commander cannot report a hull the screen is hiding from the HUD
      if (this.smokeVeils(eye, wp)) return;
      // F6: a house or a standing treeline is cover from the commander's
      // binoculars too. Only on the scout key, so it costs nothing per frame.
      if (this.propInTheWay(eye, wp)) return;
      unit.spotUntil = this.time + 25;
      // Scouting pays through the assist the mark leads to, not through a
      // Silver pop of its own: settle() has no scouting line, and a number
      // that pops in battle but never appears on the results screen reads as
      // the game short-changing you.
      unit.scoutedBy = p;
      unit.scoutedUntil = this.time + 25;
      n++;
    };
    for (const t of this.tanks) mark(t);
    for (const pl of this.planes) mark(pl);
    for (const g of this.groundUnits) mark(g);
    if (n === 0) {
      this.hud.incomingMessage?.('Nothing in sight to scout', 'info');
      return;
    }
    this.scoutCooldown = 20;
    this.hud.incomingMessage?.(`Scouted ${n} target${n > 1 ? 's' : ''}`, 'info');
    this.award('SCOUT', `${n} target${n > 1 ? 's' : ''} marked`);
    radioCue('reload');
  }

  // Artillery: the radio operator calls it, it takes six seconds to arrive, and
  // it lands where the gunner was looking — not on a moving target.
  callArtillery() {
    const p = this.player;
    if (!p.alive) return;
    // The battery answers vehicles that carry an observer and the radio net to
    // reach it, which is the Artillery Support modification — not every hull
    // with a radio operator sitting in it.
    if (!p.spec.artillerySupport) {
      this.hud.incomingMessage?.('No artillery support fitted to this vehicle', 'warn');
      return;
    }
    if (p.canCallIn === false) {
      this.hud.incomingMessage?.('Radio operator is down', 'warn');
      return;
    }
    if (this.artUses <= 0) {
      this.hud.incomingMessage?.('No artillery support left', 'warn');
      return;
    }
    if (this.artCooldown > 0) {
      this.hud.incomingMessage?.(`Artillery ready in ${Math.ceil(this.artCooldown)}s`, 'info');
      return;
    }
    // an 11 m blast destroys outright inside 3.9 m, so calling it onto your own
    // hull has to be refused rather than merely regretted
    if (p.position.distanceTo(p.aimPoint) < ARTY_MIN_RANGE) {
      this.hud.incomingMessage?.(`Too close — mark beyond ${ARTY_MIN_RANGE} m`, 'warn');
      return;
    }
    // a barrage damages ground units, so a crew parked on the edge must not be
    // able to shell the enemy airfield's AA from inside the clamp
    if (Math.abs(p.aimPoint.x) > TANK_BOUND || Math.abs(p.aimPoint.z) > TANK_BOUND) {
      this.hud.incomingMessage?.('Cannot call artillery outside the battle area', 'warn');
      return;
    }
    this.artUses--;
    this.artCooldown = 80;
    this.artStrikes.push({
      pos: p.aimPoint.clone(),
      delay: 6,
      shots: 14,
      gap: 0.28,
      timer: 0,
      marker: 0,
      warned: false,
      whistled: false,
      shooter: p,
    });
    if (this.usageNow) this.usageNow.consumables.artillery++;
    this.hud.incomingMessage?.('Artillery called — 6 s', 'info', true);
    radioCue('warning');
  }

  updateArtillery(dt) {
    const p = this.player;
    for (let i = this.artStrikes.length - 1; i >= 0; i--) {
      const st = this.artStrikes[i];
      if (st.delay > 0) {
        st.delay -= dt;
        // The six seconds are not dead air: a marker round smokes on the aim
        // point, the shells whistle in, and anyone standing in the beaten zone
        // gets told to move — including the man who called it.
        st.marker -= dt;
        if (st.marker <= 0) {
          st.marker = 0.22;
          this.effects.wreckSmoke?.(tmpA.copy(st.pos).add(tmpB.set(0, 1.2, 0)));
        }
        if (!st.whistled && st.delay <= 2.4) {
          st.whistled = true;
          sfx3d.flyby(st.pos, 900);
        }
        if (
          !st.warned && st.delay <= 3.5 && p.alive &&
          p.position.distanceTo(st.pos) < ARTY_SPREAD + 30
        ) {
          st.warned = true;
          this.hud.incomingMessage?.('INCOMING ARTILLERY — move', 'critical', this.showDamageLog);
          radioCue('warning');
        }
        continue;
      }
      st.timer -= dt;
      while (st.timer <= 0 && st.shots > 0) {
        st.timer += st.gap;
        st.shots--;
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * ARTY_SPREAD;
        const x = st.pos.x + Math.cos(a) * r;
        const z = st.pos.z + Math.sin(a) * r;
        const point = tmpA.set(x, terrainHeight(x, z) + 0.4, z);
        this.artilleryShell(point, st.shooter);
      }
      if (st.shots <= 0 && st.timer <= 0) this.artStrikes.splice(i, 1);
    }
  }

  artilleryShell(point, shooter) {
    // HE in the ground at its real scale (X-02 / AV-01) — no fireball — with
    // one surface record for the dust, the crater and the sound (AV-03)
    const look = this.effects.surfaceAt ? this.effects.surfaceAt(point.x, point.z) : null;
    this.effects.dirtImpact(point, 3, BLAST_KG.artillery, look);
    sfx3d.bomb(point, { size: 2.2, kg: BLAST_KG.artillery, surface: look });
    this.shake.addBlast(BLAST_KG.artillery, point, this.camera.position);
    const radius = ARTY_RADIUS;
    this.blastScenery(point, radius, 3);
    for (const tank of this.tanks) {
      if (!tank.alive) continue;
      if (tank.team === 0 && !this.realistic) continue;
      const res = tank.applyExplosion(point, radius, 'Artillery');
      if (res.result === 'kill' || res.result === 'damaged') {
        this.tagDamage(tank, shooter);
        if (tank === this.player) {
          this.playerHurt(res.events, 'critical', point);
        } else if (shooter === this.player && tank.team !== shooter.team) {
          // realistic lets the barrage hurt your own side; it does not pay you
          // for it
          this.creditHit(res, res.result === 'kill');
        }
      }
      if (res.result === 'kill') this.onTankKilled(shooter, tank);
    }
    for (const g of this.groundUnits) {
      if (!g.alive || (g.team === 0 && !this.realistic)) continue;
      if (g.position.distanceTo(point) < radius + g.radius) {
        this.tagDamage(g, shooter);
        if (g.takeDamage(200)) this.onGroundUnitKilled(shooter, g);
      }
    }
  }

  // ---------------- plane systems ----------------
  updatePlaneSystems(dt) {
    const p = this.player;
    if (!p.alive) return;
    if (input.pressed('KeyG')) {
      p.toggleGear?.();
      // A lever that took but whose legs are waiting for the speed to come
      // down ("Too fast for the gear — it comes down below N km/h"), or a gear
      // that is not there any more, speaks for itself through the aeroplane's
      // own events (drained below); "Gear down" on top of either is a lie.
      if (!p.gearGone && !(p.gear && p.gearHeld)) {
        this.hud.incomingMessage?.(p.gear ? 'Gear down' : 'Gear up', 'info');
      }
    }
    if (input.pressed('KeyV')) {
      p.cycleFlaps?.();
      const names = ['Flaps up', 'Combat flaps', 'Takeoff flaps', 'Landing flaps'];
      this.hud.incomingMessage?.(names[p.flaps || 0] || 'Flaps', 'info');
    }
    if (p.setAirbrake) p.setAirbrake(input.down('KeyB'));
    if (input.pressed('KeyR')) {
      const before = p.wep;
      p.toggleWep?.();
      if (p.wep === before) this.hud.incomingMessage?.('WEP locked out — engine too hot', 'warn');
      else this.hud.incomingMessage?.(p.wep ? 'WEP engaged' : 'WEP off', 'info');
    }
    if (input.pressed('KeyX')) {
      if (p.useExtinguisher?.()) {
        this.hud.incomingMessage?.('Fire extinguished', 'info', true);
        radioCue('reload');
      } else {
        this.hud.incomingMessage?.('No extinguisher available', 'warn');
      }
    }
    if (p.adjustRadiator) {
      if (input.down('KeyC')) p.adjustRadiator(0.6 * dt);
      if (input.down('KeyZ')) p.adjustRadiator(-0.6 * dt);
    }
    // the airframe's own complaints — overspeed, spin, overheating, fuel, the
    // gear held or straining — graded the way the air battle grades them
    const evs = p.drainEvents?.();
    if (evs && evs.length) {
      for (const e of evs) {
        const critical = /wing|fuel|fire|spin|overspeed|pilot|torn|collaps|crash|strike|wrecked/i.test(e);
        this.hud.incomingMessage?.(e, critical ? 'critical' : 'warn', this.showDamageLog);
      }
      radioCue('warning');
    }
  }

  // ---------------- combat resolution ----------------
  onShellFlyby(kind, pos, missDist) {
    if (!pos) return;
    // a rifle-calibre round cracks past; a 75 mm shell tears the air open
    sfx3d.flyby(pos, kind === 'bullet' ? 420 : 800);
    if (missDist != null && missDist < 12) this.shake.addAt(0.18, pos, this.camera.position, 30);
  }

  onShellImpact(kind, info) {
    if (kind === 'ground') {
      const he = info.shell.type === 'HE';
      // AV-03: the round's own surface lookup feeds the dust, the mark and
      // the sound; AV-01: an HE round is its filler's blast
      const look = this.effects.surfaceLook
        ? this.effects.surfaceLook(info.surface, info.point.x, info.point.z) : null;
      const cal = (info.shell.shell && info.shell.shell.caliber) || 75;
      const kg = he ? heFillerKg(cal) : 0;
      this.effects.groundHit(info.point, he ? 2 : 1, look);
      this.effects.dirtImpact(info.point, he ? 3 : 1, kg, look);
      if (he) this.shake.addBlast(kg, info.point, this.camera.position);
      else {
        this.shake.addAt(0.2, info.point, this.camera.position, 120);
        if (!info.prop) sfx3d.groundImpact?.(info.point, { caliber: cal, surface: look || info.surface });
      }
      // F6: solid shot splinters whatever it went through; HE takes the
      // treeline with it
      const splash = he ? info.shell.shell.splash || 5 : 0;
      this.blastScenery(info.point, he ? splash : 1.5, he ? 2.5 : 1);
      if (he) {
        this.applySplash(info.point, info.shell.shell.splash, info.shell.shooter);
        sfx3d.explosion(info.point, { size: splash / 5, kg, surface: look || info.surface });
      }
      return;
    }
    const { shell, target, hit } = info;
    // arcade: friendly shells ping off harmlessly; realistic: friendly fire
    if (!this.realistic && target.team === shell.shooter.team) {
      this.effects.ricochetSparks(hit.point);
      return;
    }
    const result = target.applyHit(hit, shell.shell, shell.type);
    // realistic lets your rounds hurt your own side; it must not pay you for it
    const isPlayerShot = shell.shooter === this.player && target.team !== shell.shooter.team;
    const onPlayer = target === this.player;
    let deflected = false;

    switch (result.result) {
      case 'ricochet':
        this.effects.ricochetSparks(hit.point);
        sfx3d.ricochet(hit.point);
        // C1/F2: hand the damage model's own deflection back to ShellManager,
        // which owns the bounce counters — the round skids the way the armour
        // says it does instead of mirroring off the plate with random jitter
        if (result.deflect) {
          info.deflect = result.deflect;
          deflected = true;
        }
        if (isPlayerShot && !this.playerIsPlane) {
          this.startXray(this.captureXray(target, shell, hit, result, 'ricochet'), 1.6);
          this.hud.hitMessage('Ricochet', 'bad');
        } else if (isPlayerShot) {
          this.hud.hitMessage('Ricochet', 'bad');
        }
        if (onPlayer) {
          this.shake.add(0.28, 0.4);
          this.playerHurt(['Ricochet — no damage'], 'light', hit.point, { quiet: true });
        }
        break;
      case 'nonpen':
        this.effects.impactSparks(hit.point, false);
        sfx3d.nonpen(hit.point);
        if (isPlayerShot) {
          if (!this.playerIsPlane) {
            this.startXray(this.captureXray(target, shell, hit, result, 'nonpen'), 1.6);
          }
          for (const ev of result.events) {
            this.hud.hitMessage(ev, ev === 'Non-penetration' ? 'bad' : 'good');
          }
        }
        if (onPlayer) {
          this.shake.add(0.28, 0.4);
          this.playerHurt(result.events, 'light', hit.point);
        }
        break;
      case 'pen': {
        this.effects.impactSparks(hit.point, true);
        this.effects.spallBurst(hit.point, hit.dir);
        sfx3d.hit(hit.point);
        this.tagDamage(target, shell.shooter);
        target.lastHitXray = this.captureXray(target, shell, hit, result, 'pen');
        if (isPlayerShot) {
          this.creditHit(result, false);
          if (!this.playerIsPlane) this.startXray(target.lastHitXray, 2.4);
          for (const ev of result.events) this.hud.hitMessage(ev, 'good');
        }
        if (onPlayer) {
          this.shake.add(0.5, 0.55);
          this.playerHurt(result.events, 'critical', hit.point);
        }
        break;
      }
      case 'kill':
        this.tagDamage(target, shell.shooter);
        target.lastHitXray = this.captureXray(target, shell, hit, result, 'pen');
        if (isPlayerShot) {
          this.creditHit(result, true);
          if (!this.playerIsPlane) this.startXray(target.lastHitXray, 2.8);
        }
        this.effects.impactSparks(hit.point, true);
        this.effects.spallBurst(hit.point, hit.dir);
        // AV-01: brew-up or ammunition (BLAST_KG) off the one law; X-05 cook-off
        const boomKg = target.exploded ? BLAST_KG.vehicleAmmo : BLAST_KG.vehicle;
        this.effects.explosion(target.position.clone().add(tmpV.set(0, 1.5, 0)), boomKg);
        this.effects.cookOff?.(tmpV.copy(target.position).add(tmpB.set(0, 2.2, 0)));
        sfx3d.explosion(hit.point, { size: target.exploded ? 2.2 : 1.6, kg: boomKg });
        this.shake.addBlast(boomKg, hit.point, this.camera.position);
        if (isPlayerShot) {
          for (const ev of result.events) this.hud.hitMessage(ev, 'good');
          this.hud.hitMessage('Target destroyed', 'kill');
        }
        this.onTankKilled(shell.shooter, target);
        break;
      default:
        break;
    }
    // C1: a ricochet with deflection data is still a shell in flight
    return deflected ? 'continue' : undefined;
  }

  applySplash(point, radius, shooter) {
    for (const tank of this.tanks) {
      if (!tank.alive || tank === shooter) continue;
      if (!this.realistic && shooter && tank.team === shooter.team) continue;
      if (tank.position.distanceTo(point) < radius + tank.radius) {
        if (Math.random() < 0.6) {
          tank.breakModule('tracks');
          if (tank === this.player) this.playerHurt(['Track destroyed'], 'heavy', point);
        }
      }
    }
  }

  onBulletPlane(target, dmg, shooter, point) {
    if (!this.realistic && target.team === shooter.team) return;
    // the shooter-to-impact vector traces the round through the airframe, so a
    // burst from astern takes the tail and the elevator rather than a lottery
    const dir = tmpA.subVectors(point, shooter.position).normalize();
    const res = target.applyDamage(dmg, shooter, point, dir);
    this.effects.impactSparks(point, false);
    const isPlayerShot = shooter === this.player && target.team !== shooter.team;
    if (isPlayerShot) {
      // F4: airframe HP is the one damage figure measured in its own unit —
      // convert the fraction of the aeroplane you shot away into the shared
      // score before it goes anywhere near settle()
      const hp = Math.max(1, target.spec.hp || 100);
      const pts = (DMG_VEHICLE * dmg) / hp;
      this.playerDamage += pts;
      if (res.events.length > 0) {
        this.playerHits++;
        this.awardSpawnPoints({ hits: 1 });
      }
      this.rewardTrickle(
        (res.events.length ? REWARD.silver.hit : 0) + pts * REWARD.silver.damage,
        (res.events.length ? REWARD.rp.hit : 0) + pts * REWARD.rp.damage,
      );
      for (const ev of res.events) this.hud.hitMessage(ev, 'good');
      if (res.events.length === 0 && this.hitPopCd <= 0) {
        this.hitPopCd = 0.6;
        this.hud.hitMessage('Hit', 'bad');
      }
    }
    if (target === this.player) {
      this.shake.add(0.18, 0.3);
      this.playerHurt(res.events.length ? res.events : ['Hit'], 'heavy', point);
    }
    if (res.killed) {
      if (isPlayerShot) this.hud.hitMessage('Target destroyed', 'kill');
      sfx3d.hit(point);
      this.onPlaneKilled(shooter, target);
    }
  }

  onBulletGround(g, b, point) {
    if (!this.realistic && g.team === b.shooter.team) return;
    if (g.isTank) {
      // bullets mostly ping off armor, but thin plates can be hurt
      this.effects.ricochetSparks(point);
      const minArmor = Math.min(g.spec.armor.hull.side, g.spec.armor.hull.top);
      if (minArmor <= 16 && Math.random() < 0.15) {
        this.tagDamage(g, b.shooter);
        if (Math.random() < 0.5) {
          g.breakModule('tracks');
          if (b.shooter === this.player) this.hud.hitMessage('Track destroyed', 'good');
          if (g === this.player) this.playerHurt(['Track destroyed'], 'heavy', point);
        } else {
          const wasAlive = g.alive;
          g.loseCrew(1);
          if (b.shooter === this.player) this.hud.hitMessage('Crew member knocked out', 'good');
          if (g === this.player) this.playerHurt(['Crew member knocked out'], 'critical', point);
          if (wasAlive && !g.alive) {
            if (b.shooter === this.player) this.hud.hitMessage('Target destroyed', 'kill');
            this.onTankKilled(b.shooter, g);
          }
        }
      } else if (g === this.player) {
        this.shake.add(0.06, 0.2);
      }
      return;
    }
    this.effects.impactSparks(point, false);
    this.tagDamage(g, b.shooter);
    if (g.takeDamage(b.dmg)) this.onGroundUnitKilled(b.shooter, g);
  }

  bombExplode(point, bomb) {
    // The fireball, the ground scar, the smoke column, the sound and the camera
    // kick are all staged by BombManager now (setBlastContext in the constructor),
    // scaled by the charge and by the listener distance. Drawing them here as well
    // played every burst twice and voiced it twice at the same scheduled arrival
    // time, which is loud enough to duck the whole mix.
    const radius = bomb.radius;
    const label = bomb.type === 'rocket' ? 'Rocket hit' : 'Bomb hit';
    // C2: only a bomb runs the deterministic blast ladder; rockets keep the
    // legacy model (as do artillery and HE splash, which pass no opts at all)
    const blastOpts = { model: bomb.type === 'bomb' ? 'bomb' : 'legacy' };
    // F6: a 250 kg bomb takes the orchard with the tank that was hiding in it
    this.blastScenery(point, radius * 1.4, 6);
    // one blast can rattle several tanks — pick the best story to replay,
    // rather than restarting the X-ray once per victim
    let showcase = null;
    let showcaseRank = -1;
    // the bomber hears "Near miss" once per bomb, and only when the burst was
    // close to an enemy tank yet did nothing to anything of the enemy's
    let nearMiss = false;
    let didDamage = false;
    const playerBomb = bomb.shooter === this.player;
    for (const tank of this.tanks) {
      if (!tank.alive) continue;
      if (!this.realistic && tank.team === bomb.shooter.team) continue;
      const blast = tank.applyExplosion(point, radius, label, blastOpts);
      const { result, events, modules } = blast;
      // friendly fire in realistic is still friendly fire: no credit for it
      const mine = playerBomb && tank.team !== bomb.shooter.team;
      // a near miss is a BOMB that burst close enough to matter and did not;
      // a rocket is a direct-fire round, and the legacy blast model it uses
      // has no such verdict to give
      if (mine && blast.nearMiss && bomb.type === 'bomb') nearMiss = true;
      if (result === 'kill' || result === 'damaged') {
        this.tagDamage(tank, bomb.shooter);
        tank.lastHitXray = this.captureXrayBlast(tank, point, events, modules);
        // the pilot who dropped it gets the damage report, and so does anyone
        // on the receiving end
        if (mine) {
          didDamage = true;
          this.creditHit(blast, result === 'kill');
        }
        if (tank === this.player) this.playerHurt(events, 'critical', point);
        if (mine || tank === this.player) {
          const rank = (result === 'kill' ? 2 : 0) + (mine ? 1 : 0);
          if (rank > showcaseRank) {
            showcaseRank = rank;
            showcase = { data: tank.lastHitXray, kill: result === 'kill', mine, events };
          }
        }
      }
      if (result === 'kill') {
        if (bomb.shooter === this.player) this.hud.hitMessage('Target destroyed', 'kill');
        this.onTankKilled(bomb.shooter, tank);
      }
    }
    if (showcase) {
      // your bomb on them is YOUR SHOT; one landing on your tank is THIS ARMOUR
      this.startXray(showcase.data, showcase.kill ? 2.8 : 2.2, showcase.mine ? 'shot' : 'armour');
      if (showcase.mine) for (const ev of showcase.events) this.hud.hitMessage(ev, 'good');
    }
    for (const g of this.groundUnits) {
      if (!g.alive) continue;
      if (!this.realistic && g.team === bomb.shooter.team) continue;
      if (g.position.distanceTo(point) < radius + g.radius) {
        this.tagDamage(g, bomb.shooter);
        if (playerBomb && g.team !== bomb.shooter.team) didDamage = true;
        if (g.takeDamage(200)) this.onGroundUnitKilled(bomb.shooter, g);
      }
    }
    for (const pl of this.planes) {
      if (!pl.alive || pl === bomb.shooter) continue;
      if (!this.realistic && pl.team === bomb.shooter.team) continue;
      if (pl.position.distanceTo(point) < radius * 0.8) {
        const res = pl.applyDamage(200, bomb.shooter);
        if (playerBomb && pl.team !== bomb.shooter.team) didDamage = true;
        if (pl === this.player) this.playerHurt(res.events, 'critical', point);
        if (res.killed) this.onPlaneKilled(bomb.shooter, pl);
      }
    }
    if (nearMiss && !didDamage) this.hud.hitMessage('Near miss', 'bad');
  }

  // BombManager's onDud hook. The hook replaces the manager's own dirt puff,
  // so the puff is staged here, and the pilot who released it is told why the
  // round did nothing — a fuse that had no time to arm, not a bad aim.
  onBombDud(point, bomb) {
    if (this.effects && point) {
      if (this.effects.dirtImpact) this.effects.dirtImpact(point, 1);
      else if (this.effects.groundHit) this.effects.groundHit(point, 1);
    }
    if (!bomb || bomb.shooter !== this.player || !this.playerIsPlane) return;
    // once per round, and in one place: the same line in the hit feed and the
    // message stack at once read as two duds
    if (bomb.dudReported) return;
    bomb.dudReported = true;
    const text = bomb.type === 'rocket'
      ? 'Rocket dud — fired too close'
      : 'Bomb dud — released too low to arm';
    this.hud.hitMessage(text, 'bad');
  }

  // ---------------- damage feedback for the player ----------------
  // Every event the damage model produced for the player's own vehicle: the
  // directional arc around the crosshair, the incoming line, the persistent
  // log, the radio blip and the shake. Discarding these was the single biggest
  // hole in the mode.
  playerHurt(events, severity, sourcePos, opts = null) {
    const quiet = opts && opts.quiet;
    if (sourcePos) {
      tmpB.subVectors(sourcePos, this.player.position);
      const bearing = Math.atan2(tmpB.x, tmpB.z);
      this.hud.damageDirection?.(wrapAngle(bearing - this.viewYaw()), severity);
    }
    if (!events || !events.length) return;
    const kind = severity === 'critical' ? 'critical' : severity === 'light' ? 'warn' : 'bad';
    for (const ev of events) {
      this.hud.incomingMessage?.(ev, severity === 'light' ? 'warn' : 'critical');
      if (this.showDamageLog) this.hud.addDamageLog?.(ev, kind);
    }
    if (quiet) return;
    if (severity === 'critical') radioCue(this.criticalEvent(events) ? 'critical' : 'damage');
    else radioCue('damage');
  }

  criticalEvent(events) {
    for (const ev of events) {
      if (/knocked out|destroyed|Fire|ammunition|Ammo|Engine|Driver|Gunner|Loader|Commander/i.test(ev)) {
        return true;
      }
    }
    return false;
  }

  // Fire, module losses and the driver handover are state changes the crew
  // would shout about, so the player hears them even when nothing hit him this
  // frame.
  trackPlayerTankState(wasBurning) {
    const p = this.player;
    if (this.playerIsPlane) return;
    if (p.burning && !wasBurning) {
      this.wasBurning = true;
      this.hud.incomingMessage?.('FIRE! — press F', 'critical', this.showDamageLog);
      radioCue('critical');
      this.shake.add(0.25, 0.5);
    }
    if (!p.burning && wasBurning && p.alive && this.wasBurning) {
      this.wasBurning = false;
      // the award is the reward: settle() has no line for putting a fire out,
      // and Silver that pops here would never reach the results screen
      this.award('FIREFIGHTER', 'Survived a vehicle fire');
    }
    // C1: the entity reports what actually happened to its men. A seat that
    // empties because its man climbed into a more important one is a swap,
    // not a casualty — diffing seat health would announce it as "knocked out".
    // None of this goes anywhere near a hit result's events (crew-kill score).
    const log = p.crewLog;
    if (Array.isArray(log) && log.length) {
      for (let i = 0; i < log.length; i++) this.announceCrewEvent(log[i]);
      log.length = 0;
    }
    // The two seats whose loss stops the vehicle — the driver's (it cannot
    // move) and the gunner's (main gun and coax both silent) — each get one
    // line that counts the replacement down, rewritten in place rather than
    // stacked, so the crew know how long they are a sitting duck or unarmed.
    this.seatCountdown(p, 'driver', p.canDrive === false, 'DRIVER DOWN');
    this.seatCountdown(p, 'gunner', !this.gunnerStaffed(p), 'GUNNER DOWN — guns silent');
  }

  // One empty critical seat: "<TITLE> — N s" while a man climbs across into
  // it, re-sent only when the whole second changes, or "<TITLE>" once when
  // nobody is left who can take it. Keyed, so the HUD replaces its own line.
  seatCountdown(p, role, down, title) {
    const st = this._seatDown || (this._seatDown = { driver: -1, gunner: -1 });
    if (!p.alive || !down) {
      st[role] = -1;
      return;
    }
    let left = 0;
    const sw = typeof p.swapTo === 'function' ? p.swapTo(role) : null;
    if (sw && typeof p.swapSecondsLeft === 'function') left = p.swapSecondsLeft(sw);
    else if (role === 'driver' && p.handover > 0) left = p.handover;
    const secs = left > 0 ? Math.max(1, Math.ceil(left)) : 0;
    if (secs === st[role]) return;
    const first = st[role] === -1;
    st[role] = secs;
    this.hud.incomingMessage?.(
      secs > 0 ? `${title} — ${secs} s` : title,
      'critical', first && this.showDamageLog, `seat-${role}`,
    );
    // no radio cue of its own: the seat only empties with a man killed in it,
    // and that line ("<Role> knocked out") has already sounded this frame
  }

  // true when a man is actually sitting in the gunner's seat (C1); a tank
  // entity without the seat model reads as staffed, as it always did
  gunnerStaffed(p) {
    return p && typeof p.staffed === 'function' ? p.staffed('gunner') : true;
  }

  crewName(role) {
    return CREW_LABEL[role] || role || 'Crew';
  }

  // One crewLog entry (C1) as the line the crew would shout.
  announceCrewEvent(ev) {
    if (!ev || !ev.type) return;
    const hud = this.hud;
    switch (ev.type) {
      case 'killed': {
        const text = `${this.crewName(ev.role)} knocked out`;
        hud.incomingMessage?.(text, 'critical', this.showDamageLog);
        radioCue('critical');
        break;
      }
      case 'swapStart':
        // the seconds are on the countdown line (seatCountdown) for the two
        // seats that matter, and on the crew row's ring for every seat
        hud.incomingMessage?.(
          `${this.crewName(ev.from)} moving to ${this.crewName(ev.to)} seat`,
          'warn', this.showDamageLog,
        );
        break;
      case 'swapDone':
        hud.incomingMessage?.(`${this.crewName(ev.to)} seat manned`, 'info', this.showDamageLog);
        break;
      case 'revived':
        hud.incomingMessage?.(`${this.crewName(ev.role)} back in his seat`, 'info', this.showDamageLog);
        break;
      default:
        break;
    }
  }

  // ---------------- kills / tickets / respawns ----------------
  // record that `attacker` damaged `target`, for assist rewards on death
  // and for the death camera (who killed me)
  tagDamage(target, attacker) {
    if (!attacker || attacker === target) return;
    target.lastAttacker = attacker;
    (target.damagers || (target.damagers = new Set())).add(attacker);
  }

  // hold J to abandon the vehicle and pick a new one without leaving battle
  updateBail(dt) {
    if (this.bailMsgCd > 0) this.bailMsgCd -= dt;
    if (input.down('KeyJ')) {
      this.bailTimer += dt;
      if (this.bailMsgCd <= 0) {
        this.bailMsgCd = 0.6;
        this.hud.incomingMessage?.('Abandoning vehicle…', 'warn');
      }
      if (this.bailTimer >= 1.5) {
        this.bailTimer = 0;
        const p = this.player;
        p.lastAttacker = null; // no killer — crew just left
        if (this.playerIsPlane) {
          p.beginFalling();
          this.onPlaneKilled(null, p);
        } else {
          p.destroy(false);
          this.onTankKilled(null, p);
        }
      }
    } else {
      this.bailTimer = 0;
    }
  }

  startDeathCam() {
    const p = this.player;
    this.shake.reset();
    this.hud.setBlackout?.(0);
    const fresh = p.isAircraft ? p.lastHitAge < 8 : true;
    const k = fresh ? p.lastAttacker : null;
    this.deathCamKiller = k && k !== p ? k : null;
    this.deathCamAngle = rand(0, Math.PI * 2);
    if (this.deathCamKiller) {
      const d = Math.round(p.position.distanceTo(this.deathCamKiller.position));
      this.hud.setDeathInfo(`Destroyed by ${this.deathCamKiller.displayName} · ${d}m`);
    }
    // X-ray of the shot that killed you (tanks only — no X-ray for planes)
    if (!this.playerIsPlane) {
      const hx = p.lastHitXray;
      // H-05: the enemy's shot on you — the ARMOUR perspective, titled so
      if (hx && this.time - hx.time < 2.5) this.startXray(hx, 3.0, 'armour');
    }
  }

  // snapshot the hit in tank-local space for the X-ray camera.
  // `visual` picks the presentation: a stopped shell for ricochet/nonpen.
  captureXray(target, shellRec, hit, result, visual) {
    target.group.updateMatrixWorld(true);
    const inv = tmpMat.copy(target.group.matrixWorld).invert();
    return {
      spec: target.spec,
      turretYaw: target.turretYaw,
      localPoint: hit.point.clone().applyMatrix4(inv),
      localDir: shellRec.vel.clone().normalize().transformDirection(inv),
      events: [...result.events],
      modules: [...(result.modules || [])],
      // The view needs the round itself to know an APHE burst from an APCR
      // dart, the crew states to grey out the men already down, and the real
      // skid vector — in the same local frame as localDir — for a ricochet.
      shell: shellRec.shell,
      shellKind: shellRec.type,
      fuse: hit.fuse || null,
      crewAlive: target.crewStates ? target.crewStates() : target.crewAlive || null,
      deflect: result.deflect && result.deflect.dir
        ? {
          dir: result.deflect.dir.clone().transformDirection(inv),
          energy: result.deflect.energy,
        }
        : null,
      result: visual,
      time: this.time,
    };
  }

  // Bomb or rocket blast: the fragments enter through whichever plate faced the
  // burst, so the X-ray shows them coming from the right side rather than
  // always dropping onto the roof.
  captureXrayBlast(tank, point, events, modules) {
    tank.group.updateMatrixWorld(true);
    const inv = tmpMat.copy(tank.group.matrixWorld).invert();
    const centre = tank.position.clone();
    centre.y += tank.spec.hull.trackH + tank.spec.hull.h * 0.5;
    const travel = centre.clone().sub(point).normalize();
    const entry = centre.addScaledVector(travel, -tank.radius);
    return {
      spec: tank.spec,
      turretYaw: tank.turretYaw,
      localPoint: entry.applyMatrix4(inv),
      localDir: travel.transformDirection(inv),
      events: [...events],
      modules: [...(modules || [])],
      crewAlive: tank.crewStates ? tank.crewStates() : tank.crewAlive || null,
      result: 'pen',
      blast: true,
      time: this.time,
    };
  }

  // perspective (H-05): 'shot' for your own round, 'armour' for one striking you
  startXray(data, duration, perspective = 'shot') {
    data.perspective = perspective;
    this.xray.show(data);
    this.pip.active = true;
    this.pip.timer = duration;
    this.hud.setKillCamVisible(true, perspective);
  }

  updatePip(dt) {
    if (!this.pip.active) return;
    this.pip.timer -= dt;
    this.xray.update(dt);
    if (this.pip.timer <= 0) {
      this.pip.active = false;
      this.hud.setKillCamVisible(false);
    }
  }

  // simple XZ push-apart so tanks can't drive through each other;
  // dead hulls act as immovable obstacles
  resolveTankCollisions() {
    // filled in place: this runs every frame beside the other hot loops that
    // were already careful not to allocate
    const list = this._collideList;
    list.length = 0;
    for (const t of this.tanks) list.push(t);
    for (const w of this.wrecks) if (!w.isAircraft) list.push(w);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const minD = a.radius + b.radius - 0.6;
        const d2 = dx * dx + dz * dz;
        if (d2 >= minD * minD || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const overlap = minD - d;
        const nx = dx / d;
        const nz = dz / d;
        const aMove = a.alive ? 1 : 0;
        const bMove = b.alive ? 1 : 0;
        const total = aMove + bMove;
        if (total === 0) continue;
        a.position.x -= nx * overlap * (aMove / total);
        a.position.z -= nz * overlap * (aMove / total);
        b.position.x += nx * overlap * (bMove / total);
        b.position.z += nz * overlap * (bMove / total);
        if (a.alive) a.speed *= 0.9;
        if (b.alive) b.speed *= 0.9;
      }
    }
    // The shove runs after tank.update()'s own clamp, so a hull pressed against
    // the edge by a neighbour would otherwise end the frame outside the battle
    // area — the airfields are only 170 m beyond it. Back inside, every frame.
    // Before that, out of any house or boulder the hull drove into (a tank
    // parked inside a wall is unhittable and blind now that walls stop rounds
    // and sight lines); only the drive pushing into the wall is lost.
    for (const t of this.tanks) {
      if (!t.alive || typeof solidPushOut !== 'function') continue;
      const hull = t.spec && t.spec.hull;
      const halfW = hull ? hull.w * 0.5 : (t.radius || 2) * 0.5;
      const halfL = hull ? hull.len * 0.5 : (t.radius || 2) * 0.8;
      const along = halfL > halfW ? halfL - halfW : 0;
      const fx = Math.sin(t.yaw);
      const fz = Math.cos(t.yaw);
      let sx = 0;
      let sz = 0;
      for (let k = -1; k <= 1; k++) {
        hullDisc.set(t.position.x + fx * along * k, t.position.y, t.position.z + fz * along * k, halfW);
        if (!solidPushOut(hullDisc, hullShove)) continue;
        t.position.x += hullShove.x;
        t.position.z += hullShove.z;
        sx += hullShove.x;
        sz += hullShove.z;
      }
      // and the gun: a barrel run into a wall holds the hull off it
      // (ballistics.js barrelIntoWall), so a muzzle never sits in masonry
      if (barrelIntoWall(t, hullShove)) {
        t.position.x += hullShove.x;
        t.position.z += hullShove.z;
        sx += hullShove.x;
        sz += hullShove.z;
      }
      if (sx === 0 && sz === 0) continue;
      // the velocity loses its component along the wall normal (head-on: a stop)
      const into = -((fx * sx + fz * sz) / Math.sqrt(sx * sx + sz * sz)) * (t.speed < 0 ? -1 : 1);
      if (into > 0.1) {
        // a real knock against the wall rattles the player's view
        if (t === this.player && Math.abs(t.speed) * into > 2 && this.shake) this.shake.add(0.05, 0.15);
        t.speed *= 1 - into * into;
      }
    }
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const lim = t.bound || TANK_BOUND;
      const p = t.position;
      if (p.x > lim) p.x = lim;
      else if (p.x < -lim) p.x = -lim;
      if (p.z > lim) p.z = lim;
      else if (p.z < -lim) p.z = -lim;
    }
  }

  // old hulls sink into the ground after a while; dead planes despawn
  cleanupWrecks(dt) {
    const sinkTank = (t) => {
      t.wreckAge = (t.wreckAge || 0) + dt;
      if (t.wreckAge > 20) {
        t.group.position.y -= 0.6 * dt;
        const gh = terrainHeight(t.group.position.x, t.group.position.z);
        return t.group.position.y < gh - 3.5;
      }
      return false;
    };
    for (let i = this.tanks.length - 1; i >= 0; i--) {
      const t = this.tanks[i];
      if (t.alive || t === this.player) continue;
      if (sinkTank(t)) {
        this.tanks.splice(i, 1);
        removeEngine('t' + t.id);
        t.dispose();
      }
    }
    for (let i = this.planes.length - 1; i >= 0; i--) {
      const pl = this.planes[i];
      if (pl.state !== 'dead' || pl === this.player) continue;
      pl.wreckAge = (pl.wreckAge || 0) + dt;
      if (pl.wreckAge > 8) {
        this.planes.splice(i, 1);
        removeEngine('p' + pl.id);
        pl.dispose();
      }
    }
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      if (w.isAircraft) {
        w.wreckAge = (w.wreckAge || 0) + dt;
        if (w.wreckAge > 10) {
          this.wrecks.splice(i, 1);
          removeEngine('p' + w.id);
          w.dispose();
        }
      } else if (sinkTank(w)) {
        this.wrecks.splice(i, 1);
        removeEngine('t' + w.id);
        w.dispose();
      }
    }
  }

  // friendly vehicles restock ammo while sitting on one of their own points
  updateResupply(dt) {
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const zone = this.zoneAt(t.position);
      if (!zone || zone.owner !== t.team) {
        t.resupplyT = 0;
        continue;
      }
      t.resupplyT = (t.resupplyT || 0) + dt;
      if (t.resupplyT < 3) continue;
      t.resupplyT -= 3;
      let gained = false;
      for (const k of Object.keys(t.spec.shells || {})) {
        if (t.ammo[k] < t.spec.shells[k].count) {
          t.ammo[k] = Math.min(t.spec.shells[k].count, t.ammo[k] + 2);
          gained = true;
        }
      }
      const maxStream = t.spec.aa ? t.spec.aa.ammo : t.spec.mg ? t.spec.mg.ammo : 0;
      if (t.streamAmmo < maxStream) {
        t.streamAmmo = Math.min(maxStream, t.streamAmmo + Math.ceil(maxStream * 0.1));
        gained = true;
      }
      if (gained && t === this.player) this.hud.incomingMessage?.('Resupplying…', 'info');
    }
  }

  // everyone who damaged the victim (except the killer) earns an assist
  creditAssists(killer, victim) {
    // The man who marked the target shares in what the mark produced. This is
    // where scouting is actually paid: an assist is a line settle() prints,
    // which a scouting bonus of our own invention would not be.
    if (
      victim.scoutedBy && victim.scoutedBy !== killer && victim.team !== victim.scoutedBy.team &&
      victim.scoutedUntil > this.time && (!victim.damagers || !victim.damagers.has(victim.scoutedBy))
    ) {
      const s = this.stat(victim.scoutedBy);
      s.assists++;
      s.score += 40;
      if (victim.scoutedBy === this.player && victim.team === 1) {
        this.playerAssists++;
        this.awardSpawnPoints({ assists: 1 });
        this.hud.hitMessage('Scout assist', 'good');
        this.reward(REWARD.silver.assist, REWARD.rp.assist, true);
      }
      victim.scoutedBy = null;
    }
    if (!victim.damagers) return;
    for (const d of victim.damagers) {
      if (d === killer || d === victim || d.team === victim.team) continue;
      const s = this.stat(d);
      s.assists++;
      s.score += 40;
      if (d === this.player && victim.team === 1) {
        this.playerAssists++;
        this.awardSpawnPoints({ assists: 1 });
        this.hud.hitMessage('Assist', 'good');
        this.reward(REWARD.silver.assist, REWARD.rp.assist, true);
      }
    }
  }

  // capture credit for every capping-team vehicle inside the zone
  creditCapture(zone, team) {
    // The point has just changed hands. Every bot re-plans on its next frame
    // instead of waiting out its 8-14 s planning timer.
    notifyObjectivesChanged(this);
    for (const t of this.tanks) {
      if (!t.alive || t.team !== team) continue;
      if (this.distToZone(t.position, zone) > zone.r) continue;
      const s = this.stat(t);
      s.caps++;
      s.score += 60;
      if (t.isPlayer) {
        this.playerCaps++;
        this.awardSpawnPoints({ caps: 1 });
        this.hud.hitMessage(`Point ${zone.key} captured!`, 'kill');
        this.award('CAPTURE', `Point ${zone.key} taken`);
        this.reward(REWARD.silver.cap, REWARD.rp.cap, true);
      }
    }
  }

  // mid-air collisions are fatal for both planes
  resolvePlaneCollisions() {
    for (let i = 0; i < this.planes.length; i++) {
      const a = this.planes[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < this.planes.length; j++) {
        const b = this.planes[j];
        if (!b.alive) continue;
        const d = a.position.distanceTo(b.position);
        if (d < (a.radius + b.radius) * 0.45) {
          const mid = a.position.clone().lerp(b.position, 0.5);
          const boomKg = 2 * BLAST_KG.aircraft;
          this.effects.explosion(mid, boomKg);
          sfx3d.explosion(mid, { size: 2, kg: boomKg });
          this.shake.addBlast(boomKg, mid, this.camera.position);
          a.explodeNow();
          b.explodeNow();
          a.justExploded = false;
          b.justExploded = false;
          this.onPlaneKilled(b, a);
          this.onPlaneKilled(a, b);
        }
      }
    }
  }

  onTankKilled(killer, victim) {
    this.tickets[victim.team] -= KILL_COST.tank;
    if (killer && killer !== victim) {
      const s = this.stat(killer);
      s.kills++;
      s.groundKills++;
      s.score += 100;
      if (victim.team === 0 && killer.team === 1) killer.avengeMark = this.time;
    }
    const vs = this.stat(victim);
    vs.deaths++;
    removeEngine('t' + victim.id);
    if (killer && killer.isPlayer && victim.team === 1) this.notePlayerKill(killer, victim, 'ground');
    this.creditAssists(killer, victim);
    this.hud.addKillfeed(
      killer ? killer.displayName : 'Fire',
      killer ? killer.team : 1 - victim.team,
      victim.displayName,
      victim.team,
    );
    if (victim.isPlayer) this.notePlayerLoss(victim);
    if (!victim.isPlayer && this.tickets[victim.team] > RESPAWN_COST) {
      this.respawnQueue.push({ kind: 'tank', team: victim.team, specId: victim.spec.id, timer: 7 });
    }
  }

  onPlaneKilled(killer, victim) {
    if (victim.killCredited) return;
    victim.killCredited = true;
    this.tickets[victim.team] -= KILL_COST.plane;
    if (killer && killer !== victim) {
      const s = this.stat(killer);
      s.kills++;
      s.airKills++;
      s.score += 100;
      if (victim.team === 0 && killer.team === 1) killer.avengeMark = this.time;
    }
    const vs = this.stat(victim);
    vs.deaths++;
    removeEngine('p' + victim.id);
    if (killer && killer.isPlayer && victim.team === 1) this.notePlayerKill(killer, victim, 'air');
    this.creditAssists(killer, victim);
    this.hud.addKillfeed(
      killer ? killer.displayName : 'Crash',
      killer ? killer.team : 1 - victim.team,
      victim.displayName,
      victim.team,
    );
    if (victim.isPlayer) this.notePlayerLoss(victim);
    if (!victim.isPlayer && this.tickets[victim.team] > RESPAWN_COST) {
      this.respawnQueue.push({ kind: 'plane', team: victim.team, specId: victim.spec.id, timer: 8 });
    }
  }

  onGroundUnitKilled(killer, g) {
    this.tickets[g.team] -= KILL_COST.ground;
    this.effects.explosion(g.position.clone().add(tmpV.set(0, 1.2, 0)), BLAST_KG.groundTarget);
    sfx3d.explosion(g.position, { size: 1.2, kg: BLAST_KG.groundTarget });
    this.shake.addBlast(BLAST_KG.groundTarget, g.position, this.camera.position);
    if (killer && killer.isPlayer && g.team === 1) {
      this.playerGroundKills++;
      this.awardSpawnPoints({ groundKills: 1 });
      this.reward(REWARD.silver.ground, REWARD.rp.ground, true);
      this.hud.hitMessage('Ground target destroyed', 'kill');
      radioCue('destroyed');
    }
    this.creditAssists(killer, g);
    this.hud.addKillfeed(
      killer ? killer.displayName : 'Fire',
      killer ? killer.team : 1 - g.team,
      g.displayName,
      g.team,
    );
  }

  // Everything that fires when the player takes a vehicle off the board:
  // streaks, the distance award, the avenger, and SPAA shooting down aircraft.
  notePlayerKill(killer, victim, kind) {
    this.playerKills++;
    this.awardSpawnPoints({ kills: 1 });
    if (kind === 'air') this.playerAirKills++;
    this.streak++;
    // settle() prices every kill the same, air or ground, so the pop does too
    this.reward(REWARD.silver.kill, REWARD.rp.kill, true);
    radioCue('destroyed');
    if (!this.firstBlood) {
      this.firstBlood = true;
      this.award('FIRST BLOOD', victim.displayName);
    }
    // same streak ladder as the ground mode — one mode calling three kills a
    // DOUBLE STRIKE and the other ON A ROLL only taught the player nothing
    if (this.streak === 3 && !this.awardFlags.streak3) {
      this.awardFlags.streak3 = true;
      this.award('ON A ROLL', '3 vehicles destroyed');
    }
    if (this.streak === 5 && !this.awardFlags.streak5) {
      this.awardFlags.streak5 = true;
      this.award('RAMPAGE', '5 vehicles destroyed');
    }
    if (this.streak === 7 && !this.awardFlags.streak7) {
      this.awardFlags.streak7 = true;
      this.award('UNSTOPPABLE', '7 vehicles destroyed');
    }
    const dist = killer.position.distanceTo(victim.position);
    if (dist > 800) this.award('SNIPER', `${Math.round(dist)} m`);
    if (victim.avengeMark && this.time - victim.avengeMark < 25) {
      victim.avengeMark = 0;
      this.award('AVENGER', victim.displayName);
    }
    // The two crossover awards this mode exists for, and the only ones the
    // ground battle can never hand out: a tank crew that swats an aeroplane,
    // and a pilot who kills armour.
    if (kind === 'air' && !killer.isAircraft) {
      this.award('AA GUNNER', victim.displayName);
    }
    if (kind === 'ground' && killer.isAircraft) {
      this.award('GROUND ATTACK', victim.displayName);
    }
  }

  notePlayerLoss(victim) {
    this.streak = 0;
    this.awardFlags.streak3 = false;
    this.awardFlags.streak5 = false;
    this.awardFlags.streak7 = false;
    this.wasBurning = false;
    if (victim.spec) this.losses.push(victim.spec.id);
    this.hud.setBlackout?.(0);
    this.hud.setBoundaryWarning?.(0);
    this.hud.setAirPanel?.(null);
    this.hud.setAmmoPanel?.(null);
  }

  award(title, subtitle) {
    this.awardsEarned.push(title);
    this.hud.showAward?.(title, subtitle || '');
  }

  // What settle() will price this vehicle's battle at on top of the REWARD
  // constants. Without it the pops quote a tier-4 crew barely half of what the
  // results screen ends up paying them, and the battle and the settlement are
  // back to naming two different prices for the same kill. Cached: it is a
  // table lookup off the spec, and the spec only changes on respawn.
  vehicleMult() {
    const id = this.player && this.player.spec ? this.player.spec.id : null;
    if (id !== this._multId) {
      this._multId = id;
      let m = null;
      try {
        m = id ? rewardMultiplier(id) : null;
      } catch (err) {
        // an unpriceable vehicle is paid the flat rate rather than nothing
        m = null;
      }
      this._mult = m && m.silver > 0 ? m : { silver: 1, rp: 1 };
    }
    return this._mult;
  }

  // Silver and RP as they are earned. Every number that pops here is a line
  // progress.settle() will actually print at the end — same REWARD constants,
  // same difficulty multiplier — so the battle and the results screen can no
  // longer quote the player two different prices for the same kill.
  reward(silver, rp = 0, showRp = false) {
    const d = DIFFICULTY_MULT[progress.getDifficulty()] || DIFFICULTY_MULT.arcade;
    const v = this.vehicleMult();
    const s = Math.round(silver * (v.silver || 1) * (d.silver || 1));
    const r = Math.round(rp * (v.rp || 1) * (d.rp || 1));
    this.silverEarned += s;
    this.rpEarned += r;
    if (s) this.hud.showReward?.(s, 'SL');
    if (showRp && r) this.hud.showReward?.(r, 'RP');
    return s;
  }

  // Trickle income. A cannon burst pays a few Silver a round and one pop per
  // bullet would bury the killfeed, so it accumulates until it is legible.
  rewardTrickle(silver, rp) {
    this._dripS += silver;
    this._dripR += rp;
    if (this._dripS < 20) return;
    const s = this._dripS;
    const r = this._dripR;
    this._dripS = 0;
    this._dripR = 0;
    this.reward(s, r);
  }

  // Credit the player for a hit that got inside: Silver, the damage points
  // settle() prices at REWARD.damage, and the spawn points that pay for the
  // next vehicle. One scale for shells, bombs and artillery (F4).
  creditHit(result, killed = false) {
    this.playerHits++;
    let pts = killed ? DMG_KILL : DMG_PEN;
    const mods = (result && result.modules) || [];
    for (const ev of (result && result.events) || []) {
      if (/knocked out|crew/i.test(ev)) pts += DMG_CREW;
    }
    pts += Math.min(3, mods.length) * DMG_MODULE;
    this.playerDamage += pts;
    this.awardSpawnPoints({ hits: 1 });
    this.reward(
      REWARD.silver.hit + pts * REWARD.silver.damage,
      REWARD.rp.hit + pts * REWARD.rp.damage,
    );
  }

  // F6: is a solid prop sitting on this sight line? Guarded the same way as
  // the rest of the scenery wiring.
  propInTheWay(from, to) {
    // (no "nothing standing" shortcut any more: ruins, airfield buildings and
    // the woods still block, and the walk is a few cells of typed arrays)
    if (!this.blockers) return false;
    if (typeof propBlocksLine !== 'function') {
      if (typeof propSegmentHit !== 'function') return false;
      try {
        return propSegmentHit(from, to, { includeTrees: true }) !== null;
      } catch (err) {
        return false;
      }
    }
    try {
      return propBlocksLine(from, to, true);
    } catch (err) {
      return false;
    }
  }

  // Same question, asked every frame by the marker loop rather than once on a
  // key press. A house does not move, so each unit keeps its own answer for a
  // quarter of a second instead of walking the prop grid sixty times a second.
  propHidesUnit(unit, from, to) {
    if (!this.blockers) return false;
    if (unit.propBlockAt == null || this.time - unit.propBlockAt > 0.25) {
      unit.propBlockAt = this.time;
      unit.propBlocked = this.propInTheWay(from, to);
    }
    return !!unit.propBlocked;
  }

  // F6: whatever was standing where the round landed. Guarded because the
  // prop registry is a separate module that a battle can run without.
  blastScenery(point, radius, damage) {
    if (typeof damagePropsAt !== 'function' || !point || radius <= 0) return;
    try {
      damagePropsAt(point.x, point.z, radius, damage);
    } catch (err) {
      // scenery is decoration; a failure here must never stop the battle
    }
  }

  // F3: spawn points are credited event by event as they happen. main.js
  // checks for this method and stands down rather than re-crediting the same
  // aggregate out of its own copy of the counters.
  awardSpawnPoints(tally) {
    if (!tally) return;
    const t = this.spawnTally;
    for (const k in tally) {
      if (t[k] != null && tally[k]) t[k] += tally[k];
    }
  }

  // ---------------- spawn points ----------------
  spawnCostOf(specId) {
    if (this.spawnLog.length === 0) return 0;
    try {
      return progress.spawnCost(specId);
    } catch (err) {
      return 60;
    }
  }

  spawnPointsNow() {
    const t = this.spawnTally;
    let earned = 0;
    try {
      earned = progress.spawnPointsFor({
        kills: t.kills,
        assists: t.assists,
        groundKills: t.groundKills,
        caps: t.caps,
        hits: t.hits,
        capTicks: t.capTicks,
        minutes: this.time / 60,
      });
    } catch (err) {
      earned = 0;
    }
    const points = Math.max(0, SPAWN_START + earned - this.spawnSpent);
    // mirrored onto the budget object so main.js and the respawn screen can
    // read one number without knowing where it came from
    this.spawnPoints = points;
    if (this.spawnBudget) this.spawnBudget.points = points;
    return points;
  }

  canSpawnVehicle(specId) {
    return this.spawnPointsNow() >= this.spawnCostOf(specId);
  }

  // What the respawn picker should offer: the lineup, minus anything the
  // player can no longer afford. Null means "no lineup was picked" — the
  // garage falls back to showing everything owned.
  availableSpawns() {
    const roster = this.spawnBudget && this.spawnBudget.lineup;
    if (!roster || !roster.length) return null;
    return roster.filter((id) => this.canSpawnVehicle(id));
  }

  canRespawn() {
    if (this.finished) return false;
    if (this.tickets[0] <= RESPAWN_COST) return false;
    if (this.playerSpawnsUsed >= 3) return false;
    const list = this.availableSpawns();
    if (list) return list.length > 0;
    const id = this.player && this.player.spec ? this.player.spec.id : null;
    return id ? this.canSpawnVehicle(id) : true;
  }

  beginUsage(spec) {
    this.usageNow = {
      id: spec.id,
      shells: {},
      stream: 0,
      bombs: 0,
      rockets: 0,
      consumables: { parts: 0, fpe: 0, crew: 0, artillery: 0 },
    };
    this.usage.push(this.usageNow);
    this.spawnLog.push(spec.id);
    this.consSnap = null;
  }

  playerRespawn(type, specId) {
    this.playerSpawnsUsed++;
    this.spawnSpent += this.spawnCostOf(specId);
    this.playerDeathHandled = false;
    this.deathCamKiller = null;
    this.bailTimer = 0;
    this.shake.reset();
    this.hud.setDeathInfo(null);
    this.hud.clearDamageLog?.();
    if (this.playerIsPlane) {
      const idx = this.planes.indexOf(this.player);
      if (idx >= 0) {
        this.wrecks.push(this.player);
        this.planes.splice(idx, 1);
      }
      removeEngine('p' + this.player.id);
    } else {
      const idx = this.tanks.indexOf(this.player);
      if (idx >= 0) {
        this.wrecks.push(this.player);
        this.tanks.splice(idx, 1);
      }
      removeEngine('t' + this.player.id);
    }
    this.playerIsPlane = type === 'air';
    this.player = this.playerIsPlane
      ? this.spawnPlane(specId, 0, true, 1.5)
      : this.spawnTank(specId, 0, true, 1.5);
    this.camYaw = this.player.yaw;
    this.camPitch = this.playerIsPlane ? 0 : -0.1;
    this.camDist = this.playerIsPlane ? 20 : 14;
    this.sniper = false;
    this.zoom = false;
    this.aimTarget = null;
    // a fresh sortie: the aircraft camera snaps onto the new nose with every
    // spring at rest, and the keyboard follow starts from nothing
    this.followDelay = 0;
    this.kbTimer = 0;
    this.followStrength = 0;
    if (this.playerIsPlane) this.planeCam.reset(this.player);
    this.applyHudMode();
  }

  updateRespawns(dt) {
    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      const r = this.respawnQueue[i];
      r.timer -= dt;
      if (r.timer <= 0) {
        this.respawnQueue.splice(i, 1);
        if (this.tickets[r.team] <= RESPAWN_COST) continue;
        if (r.kind === 'tank') {
          const alive = this.tanks.filter((t) => t.alive && t.team === r.team).length;
          if (alive < 5) this.spawnTank(r.specId, r.team, false, Math.floor(rand(0, 5)));
        } else {
          const alive = this.planes.filter((t) => t.alive && t.team === r.team).length;
          if (alive < 3) this.spawnPlane(r.specId, r.team, false, Math.floor(rand(0, 3)));
        }
      }
    }
  }

  // ---------------- capture points ----------------
  distToZone(pos, zone) {
    return Math.hypot(pos.x - zone.x, pos.z - zone.z);
  }

  zoneAt(pos) {
    for (const z of this.zones) if (this.distToZone(pos, z) <= z.r) return z;
    return null;
  }

  updateCapture(dt) {
    let held0 = 0;
    let held1 = 0;
    for (const zone of this.zones) {
      let allies = 0;
      let enemies = 0;
      for (const t of this.tanks) {
        if (!t.alive) continue;
        if (this.distToZone(t.position, zone) < zone.r) {
          if (t.team === 0) allies++;
          else enemies++;
        }
      }
      if (allies > 0 && enemies === 0 && zone.owner !== 0) {
        zone.progress -= CAP_RATE * dt * Math.min(allies, 3);
        if (zone.progress <= -100) {
          zone.owner = 0;
          zone.progress = -100;
          this.creditCapture(zone, 0);
        }
      } else if (enemies > 0 && allies === 0 && zone.owner !== 1) {
        zone.progress += CAP_RATE * dt * Math.min(enemies, 3);
        if (zone.progress >= 100) {
          zone.owner = 1;
          zone.progress = 100;
          this.creditCapture(zone, 1);
        }
      }
      if (zone.owner === 0) held0++;
      else if (zone.owner === 1) held1++;
      const color = zone.owner === 0 ? 0x5f9fdf : zone.owner === 1 ? 0xdf6a5f : 0xe8d080;
      if (zone.ring.material.color.getHex() !== color) zone.ring.material.color.setHex(color);
    }
    // proportional bleed: the side holding more of the map drains the other
    if (held0 > 0) this.tickets[1] -= ZONE_BLEED * held0 * dt;
    if (held1 > 0) this.tickets[0] -= ZONE_BLEED * held1 * dt;

    // spawn points for actually sitting on a point, not just driving past it
    const p = this.player;
    if (p.alive && !this.playerIsPlane) {
      const z = this.zoneAt(p.position);
      if (z) {
        this.capHold += dt;
        while (this.capHold >= 1) {
          this.capHold -= 1;
          this.awardSpawnPoints({ capTicks: 1 });
          // Holding a point pays in spawn points, not Silver: settle() has no
          // line for it, and popping Silver the results screen never banks is
          // what made the old PAY table read as a lie.
          this.capTickPop += 1;
          if (this.capTickPop >= 5) {
            this.capTickPop = 0;
            this.hud.showReward?.((SPAWN_AWARDS.capTick || 2) * 5, 'SP');
          }
        }
      } else {
        this.capHold = 0;
      }
    }

    // the legacy single-point readout follows whichever zone matters to the
    // player right now: the one he is standing in, else the nearest
    let best = this.zones[0];
    let bestD = Infinity;
    for (const z of this.zones) {
      const d = this.distToZone(p.position, z);
      if (d < bestD) {
        bestD = d;
        best = z;
      }
    }
    this.nearZone = best;
    this.capOwner = best.owner;
    this.capProgress = best.progress;
  }

  // ---------------- combined-arms threat ----------------
  // A tank crew that cannot see the aeroplane still hears it. The positional
  // engine layer does most of this by itself now; the callout is what turns a
  // noise into a decision.
  updateAirThreat() {
    const p = this.player;
    if (this.playerIsPlane || !p.alive || this.airWarnCd > 0) return;
    for (const pl of this.planes) {
      if (!pl.alive || pl.team === p.team) continue;
      tmpA.subVectors(p.position, pl.position);
      const d = tmpA.length();
      if (d > 500 || d < 1) continue;
      tmpA.multiplyScalar(1 / d);
      // only worth a callout if he is actually pointed at us
      if (pl.dir.dot(tmpA) < 0.72) continue;
      this.airWarnCd = 14;
      this.hud.incomingMessage?.('Enemy aircraft — take cover', 'critical', this.showDamageLog);
      this.hud.damageDirection?.(
        wrapAngle(Math.atan2(pl.position.x - p.position.x, pl.position.z - p.position.z) - this.camYaw),
        'light',
      );
      radioCue('warning');
      return;
    }
  }

  updateSmoke(dt) {
    this.burnEmit -= dt;
    if (this.burnEmit > 0) return;
    this.burnEmit = 0.07;
    for (const tank of this.tanks) {
      if (tank.burning) {
        this.effects.burningTick(tmpV.copy(tank.position).add(tmpV2.set(0, 1.6, -1)));
      } else if (!tank.alive && Math.random() < 0.5) {
        this.effects.wreckSmoke(tmpV.copy(tank.position).add(tmpV2.set(0, 1.8, 0)), true);
      }
    }
    for (const plane of this.planes) {
      if (plane.state === 'dead') continue;
      if (plane.burning || plane.state === 'falling') {
        this.effects.burningTick(tmpV.copy(plane.position));
      } else if (plane.smoking || !plane.engineOk) {
        this.effects.wreckSmoke(tmpV.copy(plane.position));
      }
    }
    for (const g of this.groundUnits) {
      if (!g.alive && Math.random() < 0.35) {
        this.effects.wreckSmoke(tmpV.copy(g.position).add(tmpV2.set(0, 1.5, 0)), true);
      }
    }
    for (const w of this.wrecks) {
      if (Math.random() < 0.3) {
        this.effects.wreckSmoke(tmpV.copy(w.position).add(tmpV2.set(0, 1.8, 0)), true);
      }
    }
  }

  // ---------------- end of battle ----------------
  battleResult(extra = null) {
    // bank whatever the bullet drip has not popped yet, so the in-battle
    // total the result carries is the whole of what was earned
    if (this._dripS > 0) {
      this.reward(this._dripS, this._dripR);
      this._dripS = 0;
      this._dripR = 0;
    }
    const survived = [];
    if (this.player && this.player.alive && this.player.spec) survived.push(this.player.spec.id);
    this.survived = survived;
    const result = {
      victory: false,
      kills: this.playerKills,
      airKills: this.playerAirKills,
      assists: this.playerAssists,
      groundKills: this.playerGroundKills,
      hits: this.playerHits,
      caps: this.playerCaps,
      damage: Math.round(this.playerDamage),
      seconds: this.time,
      spawnsUsed: this.playerSpawnsUsed + 1,
      spawnPoints: this.spawnPointsNow(),
      silverInBattle: this.silverEarned,
      rpInBattle: this.rpEarned,
      awards: this.awardsEarned.slice(),
      difficulty: progress.getDifficulty(),
      vehicleId: this.player && this.player.spec ? this.player.spec.id : null,
      losses: this.losses.slice(),
      survived: survived.slice(),
      usage: this.usage.map((u) => ({
        id: u.id,
        shells: { ...u.shells },
        stream: u.stream,
        bombs: u.bombs,
        rockets: u.rockets,
        consumables: { ...u.consumables },
      })),
    };
    if (extra) Object.assign(result, extra);
    return result;
  }

  checkEnd() {
    if (this.finished) return;
    let result = null;
    if (this.tickets[1] <= 0) result = 'victory';
    else if (this.tickets[0] <= 0) result = 'defeat';
    else if (this.time > MATCH_TIME) {
      result = this.tickets[0] >= this.tickets[1] ? 'victory' : 'defeat';
    }
    if (result) {
      this.finished = true;
      // reports still in flight would otherwise arrive over the results screen
      resetAudio();
      this.effects.clearSmokeScreens?.();
      this.hud.setBlackout?.(0);
      this.hud.setBoundaryWarning?.(0);
      this.onEnd(this.battleResult({ victory: result === 'victory' }));
    }
  }

  // free-fly camera to watch the rest of the battle after dying
  startSpectate() {
    this.spectate = true;
    this.specPos = this.camera.position.clone();
    this.shake.reset();
    this.hud.setDeathInfo(null);
    this.hud.incomingMessage?.('Spectating — WASD fly · Space/Ctrl up-down · Shift boost', 'info');
  }

  updateSpectator(dt) {
    const sens = 0.0022;
    this.camYaw = wrapAngle(this.camYaw - input.mouseDX * sens);
    this.camPitch = clamp(this.camPitch - input.mouseDY * sens, -1.4, 1.4);
    const dir = tmpV.set(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * Math.cos(this.camPitch),
    );
    const spd = (input.down('ShiftLeft') || input.down('ShiftRight') ? 320 : 120) * dt;
    if (input.down('KeyW')) this.specPos.addScaledVector(dir, spd);
    if (input.down('KeyS')) this.specPos.addScaledVector(dir, -spd);
    const rx = -Math.cos(this.camYaw);
    const rz = Math.sin(this.camYaw);
    if (input.down('KeyD')) {
      this.specPos.x += rx * spd;
      this.specPos.z += rz * spd;
    }
    if (input.down('KeyA')) {
      this.specPos.x -= rx * spd;
      this.specPos.z -= rz * spd;
    }
    if (input.down('Space')) this.specPos.y += spd;
    if (input.down('ControlLeft') || input.down('ControlRight')) this.specPos.y -= spd;
    // the solid ground, airfield platforms and embankments included: over a
    // strip the fill stands above the hillside the analytic height describes
    this.specPos.y = Math.max(this.specPos.y, groundHeightAt(this.specPos.x, this.specPos.z) + 2);
    this.camera.position.copy(this.specPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(tmpV2.copy(this.specPos).add(dir));
    this.fov = lerp(this.fov, 60, 1 - Math.pow(0.0001, dt));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  // ---------------- camera & HUD ----------------
  updateCamera(dt) {
    if (this.spectate) {
      this.updateSpectator(dt);
      this.shake.apply(this.camera);
      return;
    }
    const p = this.player;
    if (this.playerIsPlane) {
      // Chase, aim zoom and both death cams belong to the shared aircraft
      // camera: rigid on the aeroplane, rotation sprung, no allocation, and
      // shaken last on a pose it rebuilt itself. This runs after every
      // plane.update() / updateGroundRoll() and after shake.update(), so the
      // aeroplane it frames is the one about to be drawn.
      const cam = this.planeCam;
      const st = this._camState || (this._camState = {
        plane: null, zoom: false, dead: false, killer: null, dist: 20, shake: null,
      });
      st.plane = p;
      st.zoom = this.zoom && p.alive;
      st.dead = !p.alive;
      st.killer = this.playerDead ? this.deathCamKiller : null;
      st.dist = this.camDist;
      st.shake = this.shake;
      st.cockpit = !!this.cockpit && p.alive;
      // keyboard flying: the raw aim follows the nose this frame's physics
      // left (strength from updatePlaneControls; a dead pilot's aim is left
      // alone)
      if (p.alive) cam.followNose(dt, p, this.followStrength || 0);
      cam.update(dt, st);
      this.fov = cam.fov;
      return;
    }
    // the aim zoom tilts camera.up toward the aircraft's own near the
    // vertical; a tank crew that took over from that pilot wants the world's
    this.camera.up.set(0, 1, 0);
    const dir = tmpV.set(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * Math.cos(this.camPitch),
    );

    let targetFov = 60;
    if (!p.alive) {
      if (this.deathCamKiller && this.playerDead) {
        // kill cam: slow orbit around whoever destroyed you
        this.deathCamAngle += 0.25 * dt;
        const k = this.deathCamKiller.position;
        const pos = tmpV2.set(
          k.x + Math.sin(this.deathCamAngle) * 22,
          k.y + 9,
          k.z + Math.cos(this.deathCamAngle) * 22,
        );
        pos.y = Math.max(pos.y, terrainHeight(pos.x, pos.z) + 2);
        this.camera.position.sub(this.shake.lastOffset);
        this.camera.position.lerp(pos, 1 - Math.pow(0.001, dt));
        this.camera.lookAt(k.x, k.y + 2, k.z);
      } else {
        // a tank wreck: rise above it (aircraft wrecks are the plane camera's)
        const back = 18;
        const pos = tmpV2.copy(p.position).add(tmpV3.set(-dir.x * back, 13, -dir.z * back));
        pos.y = Math.max(pos.y, terrainHeight(pos.x, pos.z) + 3);
        this.camera.position.sub(this.shake.lastOffset);
        this.camera.position.lerp(pos, 1 - Math.pow(0.001, dt));
        this.camera.lookAt(p.position.x, p.position.y + 2, p.position.z);
      }
    } else if (this.sniper) {
      // K-04: this vehicle's own sight at the chosen detent
      const steps = opticSteps(p.spec);
      this.sniperStep = clamp(this.sniperStep || 0, 0, steps.length - 1);
      targetFov = this.sniperFov = steps[this.sniperStep].fov;
      const eye = p.turretWorldPos(tmpV2).add(tmpV3.set(0, 0.9, 0));
      this.camera.position.copy(eye).addScaledVector(dir, 1.2);
      this.camera.lookAt(eye.addScaledVector(dir, 100));
    } else {
      const anchor = tmpV2.set(p.position.x, p.position.y + 3.2, p.position.z);
      const pos = tmpV3.copy(anchor).addScaledVector(dir, -this.camDist);
      pos.y = Math.max(pos.y, terrainHeight(pos.x, pos.z) + 1.4);
      this.camera.position.copy(pos);
      this.camera.lookAt(anchor.addScaledVector(dir, 40));
    }
    this.fov = lerp(this.fov, targetFov, 1 - Math.pow(0.0001, dt));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    // must be the last thing that touches the camera this frame
    this.shake.apply(this.camera);
  }

  // ---------------- HUD ----------------
  updateHUD() {
    const hud = this.hud;
    const p = this.player;

    hud.updateTickets(
      this.tickets[0], this.tickets[1], TICKETS_MAX, this.capOwner, this.capProgress,
    );
    // the objective line changes on the scale of seconds, not frames
    if (this.time >= this._objectiveT) {
      this._objectiveT = this.time + 0.25;
      this._objective = this.objectiveLine();
      // The spawn balance is the decision this mode turns on — push for one
      // more kill or bank what you have and bring the good vehicle back — and
      // it cannot be made if the number only appears on the respawn screen.
      hud.setSpawnPoints?.(
        this.spawnPointsNow(),
        p && p.spec ? this.spawnCostOf(p.spec.id) : null,
      );
    }
    // one record, rewritten: setMatchInfo reads it and copies out the strings
    const mi = this._matchInfo;
    mi.timeLeft = Math.max(0, MATCH_TIME - this.time);
    mi.objective = this._objective;
    hud.setMatchInfo?.(mi);
    hud.setCompass?.(this.viewYaw(), this.compassMarkers());
    this.drawMap();

    if (this.playerIsPlane) this.updatePlaneHUD();
    else this.updateTankHUD();

    hud.setScoreboard(input.down('Tab') ? this.scoreboardData() : null);
    this.updateMarkers();
  }

  // The top line carries the three things a crew has to know without opening a
  // panel: who holds what, what is left in the racks, and whether the next
  // vehicle is paid for. Rebuilt on its own signature rather than four times a
  // second, because most of the time none of it has moved.
  objectiveLine() {
    const p = this.player;
    const c = (!this.playerIsPlane && p.consumables) || null;
    const sp = this.spawnPointsNow();
    const cost = p && p.spec ? this.spawnCostOf(p.spec.id) : 0;
    const hasArty = !this.playerIsPlane && !!(p && p.spec && p.spec.artillerySupport);
    let sig = '';
    for (const z of this.zones) sig += z.owner + 1;
    sig += `|${sp}|${this.playerIsPlane ? 'a' : 'g'}|${hasArty ? this.artUses : '-'}`;
    sig += `|${Math.ceil(this.artCooldown)}|${Math.ceil(this.scoutCooldown)}`;
    if (c) sig += `|${c.repair || 0}${c.fpe || 0}${c.smoke || 0}${c.firstAid || 0}`;
    if (sig === this._objectiveSig) return this._objective;
    this._objectiveSig = sig;

    let held = 'Zones ';
    for (const z of this.zones) {
      held += `${z.key}${z.owner === 0 ? '+' : z.owner === 1 ? '−' : '·'} `;
    }
    const spTxt = cost > 0 ? `SP ${sp} / ${cost}` : `SP ${sp}`;
    if (this.playerIsPlane) {
      const bombs = p.bombs != null ? p.bombs : 0;
      const rockets = p.rockets != null ? p.rockets : 0;
      return `${held} ·  Bombs ${bombs} · Rockets ${rockets}  ·  ${spTxt}`;
    }
    // no artillery module fitted, no artillery slot on the line: an empty
    // counter reads as a battery that is merely busy
    const arty = !hasArty
      ? ''
      : this.artUses > 0
        ? this.artCooldown > 0 ? `T:${Math.ceil(this.artCooldown)}s ` : `T:${this.artUses} `
        : 'T:— ';
    const scout = this.scoutCooldown > 0 ? `V:${Math.ceil(this.scoutCooldown)}s` : 'V:ready';
    return (
      `${held} ·  R:${c ? c.repair || 0 : 0} F:${c ? c.fpe || 0 : 0} ` +
      `G:${c ? c.smoke || 0 : 0} H:${c ? c.firstAid || 0 : 0} ${arty}${scout}  ·  ${spTxt}`
    );
  }

  compassMarkers() {
    // the three points as bearing pips, coloured by who holds them
    if (!this._compassMarks) {
      this._compassMarks = this.zones.map((z) => ({ bearing: 0, label: z.key, color: '#e8d080' }));
      // Pilots also get their home strip: it sits a kilometre behind the
      // armour now, and fog hides it from the far capture point on about half
      // the maps. A separate list sharing the zone records, so the tank
      // compass keeps exactly its three pips.
      this._homeAirfield = this.airfields.find((a) => a.team === 0) || null;
      this._compassMarksAir = this._compassMarks.concat([
        { bearing: 0, label: 'AF', color: '#5f9fdf' },
      ]);
    }
    const p = this.player.position;
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      const m = this._compassMarks[i];
      m.bearing = Math.atan2(z.x - p.x, z.z - p.z);
      m.color = z.owner === 0 ? '#5f9fdf' : z.owner === 1 ? '#df6a5f' : '#e8d080';
    }
    const af = this._homeAirfield;
    if (this.playerIsPlane && af) {
      const list = this._compassMarksAir;
      list[list.length - 1].bearing = Math.atan2(af.x - p.x, af.z - p.z);
      return list;
    }
    return this._compassMarks;
  }

  drawMap() {
    const p = this.player;
    // realistic mode: the minimap only shows your own team and whatever the
    // commander has scouted
    // — and in either mode an enemy the smoke is hiding from the player is
    // not on it: a dot on the map is a marker by another name
    const mapUnits = this._mapUnits;
    mapUnits.length = 0;
    for (const t of this.tanks) {
      if (t.team === 0) mapUnits.push(t);
      else if ((!this.realistic || t.spotUntil > this.time) && !this.smokeHidden(t)) mapUnits.push(t);
    }
    for (const pl of this.planes) {
      if (pl.team === 0) mapUnits.push(pl);
      else if ((!this.realistic || pl.spotUntil > this.time) && !this.smokeHidden(pl)) mapUnits.push(pl);
    }
    if (!this._mapZones) {
      this._mapZones = this.zones.map((z) => ({
        x: z.x, z: z.z, r: z.r, owner: -1, progress: 0, label: z.key,
      }));
      this._mapSpawns = [
        { x: -620, z: 0, team: 0, r: 120 },
        { x: 620, z: 0, team: 1, r: 120 },
      ];
      // An airfield you cannot find is not an airfield — the strips sit
      // straight behind the armour spawns, outside the tank bound, and this
      // is what tells a pilot where to go home to. Drawn at their real half
      // length (150), so the ring is the runway: it clears the 120 m spawn
      // ring by 130 m and reads as a separate place.
      for (const af of this.airfields) {
        this._mapSpawns.push({ x: af.x, z: af.z, team: af.team, r: af.halfLen });
      }
      this._mapCone = { yaw: 0, fov: 1, range: 260 };
    }
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      const m = this._mapZones[i];
      m.owner = z.owner;
      m.progress = z.progress;
    }
    const cone = this._mapCone;
    cone.yaw = this.viewYaw();
    cone.fov = (this.fov * Math.PI) / 180 * 1.4;
    cone.range = this.playerIsPlane ? 600 : 260;
    // C4: the canvas scale is the whole 2600 m mesh, so both strips fit; a
    // tank crew's minimap zooms back in to the old 1500 m scale (12.67 px per
    // 100 m) around the player, and the playable square is outlined with the
    // ground outside it shaded
    let mo = this._mapOpts;
    if (!mo) {
      mo = this._mapOpts = {
        zones: this._mapZones,
        viewCone: cone,
        spawns: this._mapSpawns,
        bounds: this._mapBounds,
        zoom: 1,
        title: 'Combined Arms',
      };
    }
    mo.zoom = this.playerIsPlane ? 1 : MAP_SIZE / 1500;
    this.hud.drawMinimap(mapUnits, p, this.capOwner, true, MAP_SIZE, mo);
  }

  updateTankHUD() {
    const hud = this.hud;
    const p = this.player;

    hud.setAirPanel?.(null);
    // The edge of the battle area. The clamp in tankEntity is what stops the
    // hull; inside the last BOUND_WARN metres the crew are told first, the
    // curtain in the world brightens, and the HUD warning grows (C4).
    const edge = TANK_BOUND - Math.max(Math.abs(p.position.x), Math.abs(p.position.z));
    const warn = p.alive ? clamp(1 - edge / BOUND_WARN, 0, 1) : 0;
    if (typeof hud.setBoundaryWarning === 'function') {
      hud.setBlackout?.(0);
      hud.setBoundaryWarning(warn);
    } else {
      // an older HUD without the warning: the red wash says the same thing
      hud.setBlackout?.(warn * 0.35, warn > 0);
    }
    if (this.boundary) this.boundary.material.opacity = 0.35 + 0.65 * warn;
    if (warn > 0 && this.boundMsgCd <= 0) {
      this.boundMsgCd = 3;
      hud.incomingMessage?.('Leaving the battle area — turn back', edge < 8 ? 'critical' : 'warn');
    }
    hud.setSpeed(p.speed);
    hud.setMarker('bombsight', '', 0, 0, '', false);
    hud.setMarker('bomblead', '', 0, 0, '', false);
    hud.setAmmoPanel?.(this.tankAmmoPanel(p));
    hud.setDamagePanel?.(p.alive ? this.tankDamagePanel(p) : null);

    if (!p.spec.aa) {
      const ready = p.reload <= 0 && p.modules.breech.ok && this.gunnerStaffed(p);
      const frac = p.reloadFrac != null ? p.reloadFrac : 1 - p.reload / p.spec.reload;
      if (hud.setReload(ready ? 1 : frac, ready) && p.alive) {
        sfx.reloadDone();
        radioCue('reload');
      }
    }

    if (
      !this.realistic &&
      !p.spec.aa && this.aimTarget && this.aimTarget.tank.team !== p.team && p.alive
    ) {
      const hit = this.aimTarget.hit;
      const target = this.aimTarget.tank;
      const shell = p.spec.shells[p.shellType];
      const dist = p.position.distanceTo(hit.point);
      hud.setPenIndicator(this.penVerdict(target, hit, shell, p.shellType, dist));
    } else {
      hud.setPenIndicator(null);
    }

    if (p.alive) {
      const muzzle = p.muzzleWorld(tmpV);
      const gdir = p.gunDirection(tmpV2);
      let dist = Math.max(20, muzzle.distanceTo(p.aimPoint));
      // a wall on the gun line is where the round goes: the marker sits on it
      if (clipRayToScenery(muzzle, tmpV3.copy(muzzle).addScaledVector(gdir, dist))) dist = Math.max(1, muzzle.distanceTo(tmpV3));
      const tof = dist / p.spec.shells[p.shellType].speed;
      const impact = tmpV3.copy(muzzle).addScaledVector(gdir, dist);
      impact.y -= 0.5 * 9.8 * tof * tof;
      const proj = impact.project(this.camera);
      hud.setGunMarker(
        (proj.x * 0.5 + 0.5) * window.innerWidth,
        (-proj.y * 0.5 + 0.5) * window.innerHeight,
        proj.z < 1,
      );
    } else {
      hud.setGunMarker(0, 0, false);
    }

    hud.setMouseAim(0, 0, false);
    // sniper optics overlay: ballistic range marks + rangefinder
    hud.setCrosshairVisible(!this.sniper);
    if (this.sniper && p.alive) {
      const v = p.spec.shells[p.shellType].speed;
      const halfTan = Math.tan((this.fov * Math.PI) / 360);
      // the marks are the same five ranges every frame; only their pixel drop
      // moves, so the array and its rows are rewritten rather than rebuilt
      const marks = this._sniperMarks;
      for (let i = 0; i < marks.length; i++) {
        const R = marks[i].range;
        marks[i].px = ((0.5 * 9.8 * R) / (v * v) / halfTan) * (window.innerHeight / 2);
      }
      // reticle in mils at the CURRENT field of view, labelled with the detent
      const sv = this._scopeView || (this._scopeView = { fov: 60, step: null });
      sv.fov = this.fov;
      sv.step = opticSteps(p.spec)[this.sniperStep || 0] || null;
      hud.updateScope(marks, Math.round(this.aimDist || 0), (60 / this.fov).toFixed(1), sv);
      hud.setScopeVisible(true);
    } else {
      hud.setScopeVisible(false);
    }

    updateEngineSound(
      Math.abs(p.throttleInput),
      p.rpm != null ? p.rpm : Math.abs(p.speed) / p.spec.maxSpeed,
      p.alive,
      'tank',
      p.revKick === 'shift', // AV-04: the clunk on the frame of the puff
    );
  }

  // Contract F1. The crosshair indicator must run the same plate-slope,
  // normalisation and ricochet maths applyHit runs, or it goes green on a
  // T-34 glacis the damage model bounces every single time — the raw spec
  // number ignores hullSlope, the mantlet and normalisation, and hit.angle is
  // the incidence to the axis-aligned collision box, which is ~0 head-on.
  // H-02: the indicator IS the damage model's forecast, ricochet included
  // (its own band in ui/penScale.js); no armour/cos fallback — no forecast,
  // no indicator.
  penVerdict(target, hit, shell, shellType, dist) {
    if (typeof tankMod.penetrationForecast !== 'function') return null;
    try {
      const f = tankMod.penetrationForecast(target, hit, shell, shellType, dist);
      return f && f.verdict ? f.verdict : null;
    } catch (err) {
      return null;
    }
  }

  // Reload comes off reloadFrac, not spec.reload: a wounded loader takes longer
  // than the book figure and the old expression went negative while he did.
  tankAmmoPanel(p) {
    const data = this.hud.buildTankAmmoPanel ? this.hud.buildTankAmmoPanel(p) : null;
    if (!data) return null;
    // C1/C4: no man in the gunner's seat means the gun is silenced, which the
    // panel shows as such rather than as a gun that has merely not reloaded
    const gunner = this.gunnerStaffed(p);
    data.noFireReason = gunner ? null : 'gunner';
    if (data.reloadFrac != null || data.reloadReady != null) {
      const ready = p.reload <= 0 && p.modules.breech.ok && gunner;
      data.reloadReady = ready;
      data.reloadFrac = ready ? 1 : p.reloadFrac != null ? p.reloadFrac : data.reloadFrac;
      data.reloadSeconds = Math.max(0, p.reload);
    }
    return data;
  }

  // Real crew stations and the full module list, rather than the adapter's
  // guess from a survivor count.
  tankDamagePanel(p) {
    if (!this._tankPanel) {
      this._tankPanel = {
        kind: 'tank', name: '', hull: 1, turret: 'ok',
        crew: [], modules: [], consumables: null, fire: false, fireSeconds: 0,
        repairing: false, repairFrac: 0,
      };
    }
    const d = this._tankPanel;
    d.name = p.spec.name;
    const stations = p.crewStations || [];
    // C1: the entity builds the rows itself, swaps included ('moving' /
    // 'leaving' with their progress), so a man climbing between seats is
    // shown as exactly that
    const rows = typeof p.crewPanelRows === 'function' ? p.crewPanelRows(CREW_LABEL) : null;
    if (Array.isArray(rows)) {
      d.crew = rows;
    } else {
      if (d.crew.length !== stations.length || d.crew === this._lastEntityRows) {
        d.crew = stations.map((r) => ({ role: CREW_LABEL[r] || r, state: 'ok' }));
      }
      for (let i = 0; i < stations.length; i++) {
        const h = p.crewAlive ? p.crewAlive[stations[i]] : 1;
        d.crew[i].role = CREW_LABEL[stations[i]] || stations[i];
        d.crew[i].state = h > 0.7 ? 'ok' : h > 0 ? 'damaged' : 'destroyed';
      }
    }
    this._lastEntityRows = Array.isArray(rows) ? rows : null;
    const m = p.modules || {};
    if (d.modules.length !== TANK_MODULE_ROWS.length + 2) {
      d.modules = TANK_MODULE_ROWS.map(([key, label]) => ({
        key, label, state: 'ok', timer: null,
      }));
      d.modules.push({ key: 'ammo', label: 'Ammo rack', state: 'ok', timer: null });
      d.modules.push({ key: 'fuel', label: 'Fuel', state: 'ok', timer: null });
    }
    for (let i = 0; i < TANK_MODULE_ROWS.length; i++) {
      const mod = m[TANK_MODULE_ROWS[i][0]];
      d.modules[i].state = !mod ? 'ok' : mod.ok ? 'ok' : 'destroyed';
      d.modules[i].timer = mod && !mod.ok ? mod.timer : null;
    }
    d.modules[TANK_MODULE_ROWS.length].state =
      m.ammoRack && !m.ammoRack.ok ? 'damaged' : 'ok';
    d.modules[TANK_MODULE_ROWS.length + 1].state = p.burning ? 'destroyed' : 'ok';
    this.fillConsumables(d, p);
    const total = Math.max(1, stations.length);
    d.hull = clamp((p.crew || 0) / total, 0, 1);
    d.turret =
      m.traverse && !m.traverse.ok ? 'destroyed' : m.breech && !m.breech.ok ? 'damaged' : 'ok';
    d.fire = !!p.burning;
    d.fireSeconds = p.burnTimer;
    d.repairing = !!p.repairing;
    d.repairFrac = p.repairFrac || 0;
    return d;
  }

  // Four of the six keys in the help panel command a finite resource, and
  // until this row existed the only way to learn you were out of extinguishers
  // was to press F with the tank already burning. The artillery slot only
  // appears on a vehicle that carries the module, so the panel and the help
  // text agree about which keys do anything.
  fillConsumables(d, p) {
    const wantArty = !!p.spec.artillerySupport;
    const need = wantArty ? 5 : 4;
    if (!d.consumables || d.consumables.length !== need) {
      d.consumables = [
        { key: 'parts', label: 'Parts', count: 0, hint: 'R' },
        { key: 'fpe', label: 'FPE', count: 0, hint: 'F' },
        { key: 'firstAid', label: 'Med', count: 0, hint: 'H' },
        { key: 'smoke', label: 'Smoke', count: 0, hint: 'G' },
      ];
      if (wantArty) {
        d.consumables.push({
          key: 'artillery', label: 'Arty', count: 0, hint: 'T', cooldown: 0, text: null,
        });
      }
    }
    const c = p.consumables || {};
    const rows = d.consumables;
    rows[0].count = c.repair || 0;
    rows[1].count = c.fpe || 0;
    rows[2].count = c.firstAid || 0;
    rows[3].count = c.smoke || 0;
    if (!wantArty) return;
    const cd = Math.max(0, Math.ceil(this.artCooldown));
    rows[4].count = this.artUses;
    rows[4].cooldown = cd;
    // a battery that is loading reads as a countdown, not as a charge you can
    // spend this second
    rows[4].text = cd > 0 && this.artUses > 0 ? `${cd}s` : null;
  }

  updatePlaneHUD() {
    const hud = this.hud;
    const p = this.player;

    hud.setAmmoPanel?.(null);
    hud.setPenIndicator(null);
    hud.setScopeVisible(false);
    hud.setReloadVisible(false);

    const s = p.flightStatus ? p.flightStatus() : null;
    hud.setAirPanel?.(this.planeAirPanel(p, s));
    hud.setDamagePanel?.(
      p.alive || p.state === 'falling' ? this.planeDamagePanel(p, s) : null,
    );
    if (p.alive && s) {
      hud.setBlackout?.(s.redout > 0.001 ? s.redout : s.blackout, s.redout > 0.001);
    } else {
      hud.setBlackout?.(0);
    }

    // in the cockpit the collimated reflector sight is the gun marker (H-03),
    // drawn where the gun line at infinity projects through the final camera
    if (p.alive && this.cockpit && this.planeCam) {
      hud.setGunMarker(0, 0, false);
      const g = this.planeCam.gunLineWorldPoint(p, tmpV).project(this.camera);
      hud.setReflectorSight?.(
        (g.x * 0.5 + 0.5) * window.innerWidth,
        (-g.y * 0.5 + 0.5) * window.innerHeight,
        g.z < 1,
        { fov: this.camera.fov, gunSpeed: p.spec.gun && p.spec.gun.speed },
      );
    } else if (p.alive) {
      hud.setReflectorSight?.(0, 0, false);
      const proj = tmpV.copy(p.position).addScaledVector(p.dir, p.convergence || 500).project(this.camera);
      hud.setGunMarker(
        (proj.x * 0.5 + 0.5) * window.innerWidth,
        (-proj.y * 0.5 + 0.5) * window.innerHeight,
        proj.z < 1,
      );
    } else {
      hud.setReflectorSight?.(0, 0, false);
      hud.setGunMarker(0, 0, false);
    }
    if (p.alive && this.planeCam) {
      const ap = this.planeCam.aimPoint(p, 600, tmpV).project(this.camera);
      hud.setMouseAim(
        (ap.x * 0.5 + 0.5) * window.innerWidth,
        (-ap.y * 0.5 + 0.5) * window.innerHeight,
        ap.z < 1,
      );
    } else {
      hud.setMouseAim(0, 0, false);
    }
    const info = this._sightInfo;
    if (p.alive && p.bombs > 0 && this.bombManager.predictImpact(p, tmpV2, info)) {
      // a release this low goes off on a delay (or, on a manager without the
      // delay fuse, not at all) — the sight says so before the pilot pickles
      const label = info.delayed ? 'DELAY' : info.armed === false ? 'TOO LOW' : '';
      // before the projection below overwrites tmpV2
      this.updateBombLead(tmpV2, info.time);
      const bp = tmpV2.project(this.camera);
      const visible = bp.z < 1 && Math.abs(bp.x) < 1 && Math.abs(bp.y) < 1;
      hud.setMarker(
        'bombsight', 'bomb',
        (bp.x * 0.5 + 0.5) * window.innerWidth,
        (-bp.y * 0.5 + 0.5) * window.innerHeight,
        label, visible,
      );
    } else {
      hud.setMarker('bombsight', '', 0, 0, '', false);
      hud.setMarker('bomblead', '', 0, 0, '', false);
    }
    updateEngineSound(p.throttle, p.speed / p.spec.maxSpeed, p.alive, 'plane');
  }

  // The sight marks a fixed patch of ground, and a tank crossing it at 8-11
  // m/s is 15-40 m further on by the time a bomb gets there — exactly the band
  // where a burst does nothing. When an enemy tank is moving near the predicted
  // impact (by where it is now or where it will be), a lead marker shows where
  // it will be when the bomb lands. Arcade only, like the gun lead circles.
  updateBombLead(impact, fallTime) {
    const hud = this.hud;
    const p = this.player;
    let best = null;
    let bestD = 45;
    let bx = 0;
    let bz = 0;
    if (!this.realistic && fallTime > 0) {
      for (const t of this.tanks) {
        if (!t.alive || t.team === p.team) continue;
        const sp = t.speed || 0;
        if (Math.abs(sp) < 1) continue;
        // a lead mark on a hull inside a screen would be the only thing on
        // screen showing where it is
        if (this.smokeHidden(t)) continue;
        const fx = t.position.x + Math.sin(t.yaw) * sp * fallTime;
        const fz = t.position.z + Math.cos(t.yaw) * sp * fallTime;
        const d = Math.min(
          Math.hypot(t.position.x - impact.x, t.position.z - impact.z),
          Math.hypot(fx - impact.x, fz - impact.z),
        );
        if (d < bestD) {
          bestD = d;
          best = t;
          bx = fx;
          bz = fz;
        }
      }
    }
    if (!best) {
      hud.setMarker('bomblead', '', 0, 0, '', false);
      return;
    }
    const lp = tmpLead.set(bx, terrainHeight(bx, bz) + 1.5, bz).project(this.camera);
    const visible = lp.z < 1 && Math.abs(lp.x) < 1 && Math.abs(lp.y) < 1;
    hud.setMarker(
      'bomblead', 'lead',
      (lp.x * 0.5 + 0.5) * window.innerWidth,
      (-lp.y * 0.5 + 0.5) * window.innerHeight,
      '', visible,
    );
  }

  // The flight model publishes its whole state as one reused snapshot
  // (flightStatus), so the cluster is fed from that — the same fields, in the
  // same units, the air battle hands the same HUD. One record, rewritten.
  planeAirPanel(p, s) {
    if (!this._airPanel) this._airPanel = {};
    const d = this._airPanel;
    // H-04: the dials read in the aircraft's own national units and its own
    // boost gauge, both picked from the spec
    d.spec = p.spec;
    d.alt = Math.max(0, p.position.y);
    d.throttle = p.throttle;
    d.ammo = p.ammo;
    d.bombs = p.bombs;
    d.rockets = p.rockets;
    if (s) {
      // The airspeed tape reads INDICATED airspeed, like the real dial: the
      // gear limit the aeroplane quotes ("comes down below 161 km/h") and the
      // stall it warns of are both indicated figures, so the number on the
      // tape has to be the same kind or the pilot cannot fly to them.
      // (display km/h: planes.js displaySpeedKmh, one scale for every readout)
      d.ias = displaySpeedKmh(s.ias != null ? s.ias : s.speed);
      d.stallSpeed = displaySpeedKmh(s.stallIas != null ? s.stallIas : s.stallSpeed);
      d.vspeed = s.climb;
      d.fuel = p.spec.fuelCapacity > 0 ? s.fuel : null;
      d.engineTemp = s.engineTemp;
      d.wep = !!s.wep;
      d.wepLock = !!s.wepLock;
      d.flaps = s.flaps || 0;
      d.gear = !!s.gear;
      d.airbrake = !!s.airbrake;
      d.gload = s.gLoad;
      d.mach = s.mach;
      d.radiator = s.radiator;
      d.aoa = s.aoa;
      d.slip = s.slip;
      // vStall moves with flaps, altitude and wing damage, so the warning is
      // measured against what the wing will do right now — but a wheel on
      // the ground is not a wing about to let go
      d.stalled = !!(s.stalled || s.spinning ||
        (!s.onGround && s.speed < s.stallSpeed * 1.05));
      // Undercarriage: the lever, where the legs are, held by overspeed, the
      // operating limit in tape units, how far over the extended limit they
      // are being flown, torn off; and wheels on the ground with the brakes.
      d.gearPos = s.gearPos;
      d.gearHeld = !!s.gearHeld;
      d.gearLimit = s.gearLimitKmh;
      d.gearOver = s.gearOver;
      d.gearGone = !!s.gearGone;
      d.onGround = !!s.onGround;
      d.wheelBrake = s.wheelBrake || 0;
      // the structural budget, as the air battle's adapter publishes it
      d.stress = s.stress;
    } else {
      d.ias = displaySpeedKmh(p.speed);
      d.vspeed = p.dir.y * p.speed;
      d.fuel = 1;
      d.engineTemp = 0;
      d.wep = !!p.wep;
      d.flaps = p.flaps || 0;
      d.gear = !!p.gear;
      d.airbrake = !!p.airbrake;
      d.gload = 1;
      d.stalled = p.speed < p.spec.minSpeed * 1.05;
    }
    // the G gauge reads against the wing actually bolted on: a wing that has
    // lost a panel is de-rated by the flight model, so the line is too
    d.maxG = p.spec.maxG > 0 ? (p.wingsOk === false ? p.spec.maxG * 0.55 : p.spec.maxG) : null;
    return d;
  }

  planeDamagePanel(p, s = null) {
    if (!this._planePanel) {
      this._planePanel = {
        kind: 'plane', name: '', hull: 1, turret: 'ok',
        crew: [{ role: 'Pilot', state: 'ok' }],
        modules: PLANE_MODULE_ROWS.map(([key, label]) => ({ key, label, state: 'ok' })),
        // A pilot carries bottles, not a crew with a repair kit, and a fire up
        // here kills far faster than it does on the ground — so the one number
        // that decides whether X is worth pressing belongs on screen.
        consumables: [{ key: 'fpe', label: 'FPE', count: 0, hint: 'X' }],
        fire: false, fireSeconds: 0,
        // hud.js branches on these to draw the service bar over the panel;
        // without them a plane being rearmed on the strip shows nothing at all
        repairing: false, repairFrac: 0,
      };
    }
    const d = this._planePanel;
    const parts = p.parts || {};
    const stateOf = (key) => {
      const q = parts[key];
      if (!q) return 'ok';
      const f = q.max > 0 ? q.hp / q.max : 1;
      return f <= 0 ? 'destroyed' : f < 0.55 ? 'damaged' : 'ok';
    };
    const worst = (...keys) => {
      let out = 'ok';
      for (const k of keys) {
        const st = stateOf(k);
        if (st === 'destroyed') return 'destroyed';
        if (st === 'damaged') out = 'damaged';
      }
      return out;
    };
    d.name = p.spec.name;
    d.hull = p.spec.hp ? clamp(p.hp / p.spec.hp, 0, 1) : 1;
    d.turret = worst('leftWing', 'rightWing');
    d.crew[0].state = parts.pilot ? stateOf('pilot') : p.alive ? 'ok' : 'destroyed';
    d.modules[0].state = stateOf('engine');
    d.modules[1].state = d.turret;
    d.modules[2].state = worst('tail', 'elevator', 'rudder');
    d.modules[3].state = worst('controls', 'aileronL', 'aileronR');
    d.modules[4].state = stateOf('oilCooler');
    d.modules[5].state = p.burning ? 'destroyed' : stateOf('fuelTank');
    const bottles = s && s.extinguishers != null ? s.extinguishers : p.extinguishers;
    d.consumables[0].count = bottles != null ? bottles : 0;
    d.fire = !!p.burning;
    d.fireSeconds = p.burnTimer;
    // Ground crew progress, same fields and same meaning as the tank panel's.
    const frac = Number.isFinite(p.serviceFrac) ? p.serviceFrac : 0;
    d.repairing = !!p.onGround && frac > 0 && frac < 1;
    d.repairFrac = frac;
    return d;
  }

  updateMarkers() {
    const hud = this.hud;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const p = this.player;
    const eye = this.camera.position;
    // one vision figure for the whole sweep: it depends on the player's spec
    // and crew, not on which vehicle is being marked
    const vision = this.visionFactor();

    for (const unit of this.tanks) this.markUnit(unit, p, eye, w, h, vision);
    for (const unit of this.planes) this.markUnit(unit, p, eye, w, h, vision);

    for (const zone of this.zones) {
      const capPos = tmpV.set(zone.x, terrainHeight(zone.x, zone.z) + 8, zone.z);
      const proj = capPos.project(this.camera);
      const capVisible = proj.z < 1 && Math.abs(proj.x) < 1 && Math.abs(proj.y) < 1;
      const cls = zone.owner === 0 ? 'cap ally' : zone.owner === 1 ? 'cap enemy' : 'cap';
      hud.setMarker(
        `cap${zone.key}`, cls,
        (proj.x * 0.5 + 0.5) * w, (-proj.y * 0.5 + 0.5) * h,
        `◈ ${zone.key}`, capVisible,
      );
    }
  }

  markUnit(unit, p, eye, w, h, vision = 1) {
    const hud = this.hud;
    const id = `t${unit.isAircraft ? 'p' : 'g'}${unit.id}`;
    const leadId = `lead${unit.id}`;
    if (!unit.alive || unit === p) {
      hud.setMarker(id, '', 0, 0, '', false);
      if (unit.isAircraft) hud.setMarker(leadId, '', 0, 0, '', false);
      return;
    }
    const wp = tmpV.set(unit.position.x, unit.position.y + (unit.isAircraft ? 6 : 4.5), unit.position.z);
    const dist = eye.distanceTo(wp);
    const scouted = unit.spotUntil > this.time;
    // an aeroplane against open sky is not what optics buy you; ground clutter
    // is, so the crew's vision only stretches the ground reach
    let visible = dist < (unit.isAircraft ? 1700 : MARK_RANGE * vision);
    // realistic: enemies are only marked once somebody has actually scouted them
    if (this.realistic && unit.team !== p.team) visible = scouted;
    if (visible && !unit.isAircraft && unit.team !== p.team && !scouted) {
      visible = dist < 160 || hasLOS(eye, wp);
    }
    // A smoke screen blinds the marker as well as the gunner — whatever the
    // range, and scouted or not: a mark hung over a hull the cloud is hiding
    // is the HUD showing the player exactly what the smoke was thrown to hide.
    if (visible && unit.team !== p.team && this.smokeHidden(unit)) {
      visible = false;
    }
    // F6: so does the village. A hull behind a house is not a contact, however
    // clean the terrain line to it happens to be.
    if (visible && !unit.isAircraft && unit.team !== p.team && !scouted) {
      if (this.propHidesUnit(unit, eye, wp)) visible = false;
    }
    if (visible) {
      const proj = wp.project(this.camera);
      visible = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
      if (visible) {
        const cls = unit.team === p.team ? 'ally' : 'enemy';
        const arrow = cls === 'enemy' ? '▼' : '▽';
        hud.setMarker(
          id, cls,
          (proj.x * 0.5 + 0.5) * w,
          (-proj.y * 0.5 + 0.5) * h,
          `<span class="arrow">${arrow}</span>${Math.round(dist)}m`,
          true,
        );
      } else {
        hud.setMarker(id, '', 0, 0, '', false);
      }
    } else {
      hud.setMarker(id, '', 0, 0, '', false);
    }

    // gunnery lead circles for enemy aircraft — for pilots and SPAA gunners.
    // The Wirbelwind lives on this: without it, hitting a diving fighter with
    // a 20 mm quad is guesswork.
    if (unit.isAircraft) {
      const isAA = !this.playerIsPlane && !!p.spec.aa;
      const gunSpeed = this.playerIsPlane
        ? p.spec.gun.speed
        : isAA
          ? p.spec.aa.speed
          : 0;
      const reach = isAA ? 1400 : 700;
      if (
        !this.realistic && gunSpeed > 0 && p.alive && unit.team !== p.team &&
        p.position.distanceTo(unit.position) < reach && !this.smokeHidden(unit)
      ) {
        const dist2 = p.position.distanceTo(unit.position);
        const tof = dist2 / gunSpeed;
        const lead = tmpV2.copy(unit.position).addScaledVector(unit.dir, unit.speed * tof);
        lead.y += 0.5 * 3 * tof * tof;
        const lp = lead.project(this.camera);
        const leadVisible = lp.z < 1 && Math.abs(lp.x) < 1 && Math.abs(lp.y) < 1;
        hud.setMarker(
          leadId, 'lead',
          (lp.x * 0.5 + 0.5) * w,
          (-lp.y * 0.5 + 0.5) * h,
          isAA ? `${Math.round(dist2)}m` : '', leadVisible,
        );
      } else {
        hud.setMarker(leadId, '', 0, 0, '', false);
      }
    }
  }

  // ---------------- smoke: what the screen hides, the HUD does not show ----
  // How opaque the smoke between two points is drawn, 0..1. The effects
  // module's own integral of the same volume it renders; a build without it
  // falls back to the yes/no sight-line rule.
  smokeOpacity(from, to) {
    const fx = this.effects;
    if (!fx || fx.activeScreens === 0) return 0;
    if (typeof fx.smokeOpacityAlong === 'function') return fx.smokeOpacityAlong(from, to);
    return fx.blocksLineOfSight && fx.blocksLineOfSight(from, to) ? 1 : 0;
  }

  // Is this sight line veiled: blind by the game's rule, or drawn so thick
  // the target is mostly gone (SMOKE_HIDE)?
  smokeVeils(from, to) {
    const fx = this.effects;
    if (!fx || fx.activeScreens === 0) return false;
    if (fx.blocksLineOfSight && fx.blocksLineOfSight(from, to)) return true;
    return this.smokeOpacity(from, to) >= SMOKE_HIDE;
  }

  // Is this unit hidden from the player by smoke right now? Asked from two
  // eyes — the camera, which is what draws the picture, and the crew's own
  // sight (the gunner's optics on a tank, the cockpit on an aeroplane) — and
  // either one being veiled is enough: a third-person camera bobbing over the
  // top of a screen is not the crew seeing through it. A unit counts as hidden
  // when both its body and its top are veiled, so a turret roof poking out
  // above a thin screen still reads as a contact. Cached per unit per frame:
  // the minimap, the marker and the lead ring all ask.
  smokeHidden(unit) {
    if (unit._smokeT === this._smokeFrame) return unit._smokeHid;
    unit._smokeT = this._smokeFrame;
    unit._smokeHid = false;
    const fx = this.effects;
    if (!fx || fx.activeScreens === 0 || !unit.alive) return false;
    const p = this.player;
    let hid = this.smokeHidesFrom(this.camera.position, unit);
    if (!hid && p && p.alive) {
      if (p.isAircraft) smokeEye.copy(p.position);
      else if (typeof p.turretWorldPos === 'function') p.turretWorldPos(smokeEye).y += 0.9;
      else smokeEye.set(p.position.x, p.position.y + 2.2, p.position.z);
      hid = this.smokeHidesFrom(smokeEye, unit);
    }
    unit._smokeHid = hid;
    return hid;
  }

  smokeHidesFrom(eye, unit) {
    const pos = unit.position;
    if (unit.isAircraft) return this.smokeVeils(eye, pos);
    const h = unit.spec && unit.spec.hull;
    // the body: hull centre; the top: the turret roof
    const body = h ? h.trackH + h.h * 0.5 : 1.2;
    const top = h ? h.trackH + h.h + (unit.spec.turret ? unit.spec.turret.h || 0.8 : 0.8) * 0.85 : 2.4;
    if (!this.smokeVeils(eye, smokeAt.set(pos.x, pos.y + body, pos.z))) return false;
    return this.smokeVeils(eye, smokeAt.set(pos.x, pos.y + top, pos.z));
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    resetAudio();
    // F6: resetScenery() deliberately keeps `owned`, so without this every
    // battle's ~570 props leave their geometries and materials on the GPU
    try {
      setSceneryEffects?.(null);
      disposeScenery?.();
      // keepOutDiscs is module state and survives disposeScenery, so a session
      // that moves through a dozen battles would otherwise accumulate a dozen
      // battles' worth of fences and slowly starve the prop scatter
      clearKeepOuts?.();
      this.blockers = null;
      this.scenery = null;
    } catch (err) {
      // a disposal failure must not stop the player leaving the battle
    }
    for (const t of this.tanks) removeEngine('t' + t.id);
    for (const pl of this.planes) removeEngine('p' + pl.id);
    for (const w of this.wrecks) removeEngine((w.isAircraft ? 'p' : 't') + w.id);
    this.shake.reset();
    this.effects.clearSmokeScreens?.();
    this.hud.setAmmoPanel?.(null);
    this.hud.setAirPanel?.(null);
    this.hud.setDamagePanel?.(null);
    this.hud.setBlackout?.(0);
    this.hud.setBoundaryWarning?.(null);
    this.hud.setMarker?.('bomblead', '', 0, 0, '', false);
    this.hud.setMatchInfo?.(null);
    this.hud.setCompass?.(null);
    this.hud.setBigMap?.(false);
    this.hud.setSpawnPoints?.(null);
    this.shellMgr.dispose();
    this.bullets.dispose();
    this.bombManager.dispose();
    // clear() deliberately keeps the ghost cache — that is the point of it —
    // so a battle that is finished with the viewer for good hands the cached
    // hulls back too rather than leaving one per vehicle seen on the GPU
    this.xray.dispose();
    for (const t of this.tanks) t.dispose();
    for (const pl of this.planes) pl.dispose();
    for (const g of this.groundUnits) g.dispose();
    for (const wreck of this.wrecks) wreck.dispose();
    // Before the traverse below, and it matters: the airfield's materials come
    // from the shared, cached procedural factory, and the traverse disposes
    // every material it can reach. dispose() detaches the group from the scene
    // first, so those cached materials survive into the next battle.
    disposeAirfields(this.airfields);
    this._afCtx = null;
    this.scene.traverse((o) => {
      if (o.isMesh || o.isPoints) {
        if (!isSharedResource(o.geometry)) o.geometry?.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material])
            // Skip the shared factory materials: they are cached across
            // battles on purpose, and freeing them here would make every
            // battle transition recompile and re-upload the lot.
            .forEach((m) => { if (!isSharedResource(m)) m.dispose(); });
        }
      }
    });
    this.hud.clearMarkers();
  }
}
