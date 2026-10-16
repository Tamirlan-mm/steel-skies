import * as THREE from 'three';
import { isSharedResource } from '../core/materials.js';
import { buildTerrain, terrainHeight, setTerrainSeed } from '../world/terrain.js';
import {
  setupEnvironment, setSceneryEffects, damagePropsAt, disposeScenery, clearKeepOuts,
} from '../world/scenery.js';
// The strip, the approach gate, the ground-handling model and the ground crew
// all live in world/airfield.js now, shared with the combined battle so the two
// cannot drift apart.
import {
  createAirfield,
  airfieldKeepOut,
  disposeAirfields,
  initPlaneAirfieldState,
  updateAirfieldService,
  updateGroundRoll,
  homeAirfield,
  groundHeightAt,
  airfieldAtPoint,
} from '../world/airfield.js';
// The aircraft camera (chase, aim zoom, death cams), shared with the combined
// battle so the two cannot drift apart.
import { PlaneCamera } from './planeCamera.js';
import { randomPreset } from '../world/presets.js';
import { Plane } from '../vehicles/planeEntity.js';
import { PLANE_SPECS, displaySpeedKmh } from '../vehicles/planes.js';
import { AAGun, Truck } from '../vehicles/groundUnits.js';
import { BulletManager } from '../combat/bullets.js';
import { BombManager, blastDamageAt } from '../combat/bombs.js';
import { Effects } from '../combat/effects.js';
import { CameraShake } from '../combat/shake.js';
import { BLAST_KG } from '../combat/blast.js';
import { PlaneAI } from '../ai/planeAI.js';
import { input } from '../core/input.js';
import {
  sfx3d,
  updateEngineSound,
  updateEngine,
  removeEngine,
  setListener,
  radioCue,
  updateAudio,
  resetAudio,
  setVolumes,
} from '../core/audio.js';
import { applyMods } from './mods.js';
import { progress, planBattle, REWARD } from './progress.js';
import { clamp, lerp, rand, wrapAngle, moveToward } from '../core/utils.js';

const TICKETS_MAX = 1500;
const KILL_COST = 100;
const RESPAWN_COST = 150;
const GROUND_TICKETS = 25; // an AA battery or a supply truck
const COLUMN_TICKETS = 20;
const BASE_TICKETS = 350; // a depot is worth a third of a squadron
const MATCH_TIME = 20 * 60;
const AIR_WORLD = 2600; // air map is ~3x the ground map
const MAX_SPAWNS = 4;

// Airfield geometry, the approach gate, the ground roll and the ground crew are
// all in world/airfield.js — STRIP_HALF_LEN and friends live there.
const AIRFIELD_X = 1020; // strip centres, mirrored either side of the origin
// Four guns firing at one bomber was the measured killer, so the field battery
// is a pair — the roaming guns are the density, this is the deterrent.
const AIRFIELD_AA = 2;
const ROAM_AA = 3;

const COLUMN_SIZE = 4;
const COLUMN_SPACING = 22;
const COLUMN_SPEED = 15;
const COLUMN_WAVE_GAP = 80;
const COLUMN_DPS = 1.6; // per vehicle, against a depot it has reached

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
const tmpV4 = new THREE.Vector3();

const DEPOT_HP = 800;
// AA guns and trucks are built without a maxHp of their own, so the damage
// score needs a stand-in pool for them.
const SOFT_TARGET_HP = 20;

// ---------------------------------------------------------------------------
// ground objectives
// ---------------------------------------------------------------------------

// A supply depot: the thing bombs are carried for. It quacks exactly like the
// existing ground units (alive / team / position / radius / takeDamage) so the
// bullet manager, the bomb blast loop and the striker AI all find it for free.
class Depot {
  constructor(scene, team, x, z) {
    this.scene = scene;
    this.team = team;
    this.isGroundUnit = true;
    this.isBase = true;
    this.alive = true;
    this.hp = DEPOT_HP;
    this.maxHp = DEPOT_HP;
    this.radius = 17;
    this.displayName = team === 0 ? 'Ally Depot' : 'Enemy Depot';

    const wall = new THREE.MeshLambertMaterial({ color: 0x7d7461, flatShading: true });
    const roof = new THREE.MeshLambertMaterial({ color: 0x4a4b42, flatShading: true });
    const drum = new THREE.MeshLambertMaterial({ color: 0x5c6a4a, flatShading: true });
    this.materials = [wall, roof, drum];
    this.geometries = [];

    this.group = new THREE.Group();
    const shed = (w, h, d, px, pz, rot) => {
      const g = new THREE.BoxGeometry(w, h, d);
      this.geometries.push(g);
      const m = new THREE.Mesh(g, wall);
      m.position.set(px, h / 2, pz);
      m.rotation.y = rot;
      const rg = new THREE.BoxGeometry(w * 1.08, 0.5, d * 1.08);
      this.geometries.push(rg);
      const r = new THREE.Mesh(rg, roof);
      r.position.set(px, h + 0.25, pz);
      r.rotation.y = rot;
      this.group.add(m, r);
    };
    shed(13, 5.5, 8, 0, 0, 0);
    shed(9, 4.2, 6, -11, 8, 0.35);
    shed(7, 3.6, 6, 12, -7, -0.3);
    const barrel = new THREE.CylinderGeometry(0.8, 0.8, 1.9, 8);
    this.geometries.push(barrel);
    for (let i = 0; i < 9; i++) {
      const b = new THREE.Mesh(barrel, drum);
      b.position.set(-9 - (i % 3) * 2, 0.95, -8 + Math.floor(i / 3) * 2.2);
      this.group.add(b);
    }
    this.group.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.group.position.set(x, terrainHeight(x, z), z);
    this.group.rotation.y = rand(0, Math.PI);
    scene.add(this.group);
  }

  get position() {
    return this.group.position;
  }

  get hpFrac() {
    return clamp(this.hp / this.maxHp, 0, 1);
  }

  update() {}

  takeDamage(dmg) {
    if (!this.alive) return false;
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.alive = false;
      this.group.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material = o.material.clone();
          o.material.color.multiplyScalar(0.25);
        }
      });
      return true;
    }
    return false;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}

// One vehicle of a supply column, walking a straight route from its own depot
// to the enemy's. Reaching the far end is not a win condition on its own — it
// parks and starts taking the depot apart, which is the clock the strike
// aircraft are flying against.
class ColumnVehicle {
  constructor(scene, team, index, from, to, heavy) {
    this.scene = scene;
    this.team = team;
    this.isGroundUnit = true;
    this.isColumn = true;
    this.alive = true;
    this.hp = heavy ? 34 : 20;
    this.maxHp = this.hp;
    this.radius = 2.6;
    this.arrived = false;
    this.displayName = `${team === 0 ? 'Ally' : 'Enemy'} Column-${index + 1}`;

    this.from = from.clone();
    this.dirX = to.x - from.x;
    this.dirZ = to.z - from.z;
    const len = Math.hypot(this.dirX, this.dirZ) || 1;
    this.dirX /= len;
    this.dirZ /= len;
    this.routeLen = Math.max(1, len - 42); // stop short: they shell the depot
    this.travelled = -index * COLUMN_SPACING;

    const body = new THREE.MeshLambertMaterial({
      color: heavy ? 0x55603f : 0x6e6a58,
      flatShading: true,
    });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2f2f2b, flatShading: true });
    const teamMat = new THREE.MeshBasicMaterial({ color: team === 0 ? 0x4f8fd0 : 0xd05f4f });
    this.materials = [body, dark, teamMat];
    this.geometries = [];

    this.group = new THREE.Group();
    const push = (geo, mat, x, y, z) => {
      this.geometries.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      this.group.add(m);
      return m;
    };
    if (heavy) {
      push(new THREE.BoxGeometry(2.6, 0.9, 4.6), body, 0, 0.75, 0);
      push(new THREE.BoxGeometry(1.7, 0.7, 2.0), body, 0, 1.5, -0.2);
      push(new THREE.CylinderGeometry(0.1, 0.12, 2.6, 6), dark, 0, 1.55, 1.5).rotation.x =
        Math.PI / 2;
      push(new THREE.BoxGeometry(2.7, 0.24, 4.7), teamMat, 0, 1.92, -0.2);
    } else {
      push(new THREE.BoxGeometry(1.7, 1.1, 2.6), body, 0, 1.05, -0.6);
      push(new THREE.BoxGeometry(1.6, 0.9, 1.2), body, 0, 0.95, 1.3);
      push(new THREE.BoxGeometry(1.5, 0.5, 4.0), dark, 0, 0.45, 0);
      push(new THREE.BoxGeometry(1.72, 0.2, 2.6), teamMat, 0, 1.62, -0.6);
    }
    this.group.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    scene.add(this.group);
    this.place();
  }

  get position() {
    return this.group.position;
  }

  place() {
    const t = Math.max(0, this.travelled);
    const x = this.from.x + this.dirX * t;
    const z = this.from.z + this.dirZ * t;
    this.group.position.set(x, terrainHeight(x, z), z);
    this.group.rotation.y = Math.atan2(this.dirX, this.dirZ);
  }

  update(dt) {
    if (!this.alive || this.arrived) return;
    this.travelled += COLUMN_SPEED * dt;
    if (this.travelled >= this.routeLen) {
      this.travelled = this.routeLen;
      this.arrived = true;
    }
    this.place();
  }

  takeDamage(dmg) {
    if (!this.alive) return false;
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.alive = false;
      this.group.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material = o.material.clone();
          o.material.color.multiplyScalar(0.3);
        }
      });
      return true;
    }
    return false;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}

export class AirBattle {
  constructor(renderer, playerSpecId, hud, onEnd) {
    this.renderer = renderer;
    this.hud = hud;
    this.onEnd = onEnd;
    this.finished = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      60, window.innerWidth / window.innerHeight, 0.3, 4000,
    );
    // Owns the raw mouse aim (camYaw / camPitch below are its accessors), the
    // smoothing, and every pose the camera takes while there is an aircraft
    // to watch. The free-fly spectator is still this class's own.
    this.planeCam = new PlaneCamera(this.camera, { fov: 60, zoomFov: 22 });

    setTerrainSeed(rand(-3000, 3000), rand(-3000, 3000));
    const preset = randomPreset();
    this.preset = preset;
    this.scene.add(buildTerrain(AIR_WORLD, 170, preset));

    // The airfields have to exist BEFORE the scenery is scattered: their
    // footprints go in as keep-out discs, and rocks are registered
    // invulnerable, so a boulder that lands on the concrete is there for the
    // whole match. keepOutDiscs is module state in scenery.js and nothing else
    // clears it, so the previous battle's fences go first.
    clearKeepOuts();
    this.groundUnits = [];
    this.airfields = [];
    for (let team = 0; team < 2; team++) this.airfields.push(this.buildAirfield(team));

    this.sun = setupEnvironment(this.scene, {
      fogNear: 500,
      fogFar: 3000,
      propArea: AIR_WORLD - 200,
      trees: 520,
      rocks: 150,
      houses: 18,
      preset,
      keepOut: airfieldKeepOut(this.airfields),
    }).sun;

    this.effects = new Effects(this.scene);
    // the scenery fells itself when something knocks a tree over; it needs our
    // particle system to throw the debris
    if (typeof setSceneryEffects === 'function') setSceneryEffects(this.effects);
    this.shake = new CameraShake({ scale: progress.getSetting('shakeScale') ?? 1 });
    this.bullets = new BulletManager(this.scene);
    this.bombManager = new BombManager(this.scene);
    // The manager stages the whole blast presentation itself now — see the note
    // in bombExplode for why this class no longer draws or voices its own.
    this.bombManager.setBlastContext({
      shake: this.shake, camera: this.camera, sound: true, fx: true,
    });
    setVolumes({
      master: progress.getSetting('masterVolume'),
      effects: progress.getSetting('effectsVolume'),
      engines: progress.getSetting('engineVolume'),
    });
    this.logOn = progress.getSetting('showDamageLog') !== false;

    this.planes = [];
    this.ais = [];
    // this.groundUnits and this.airfields are built above, before the scenery
    // scatter — do not re-initialise them here or the airfield AA is orphaned.
    this.depots = [];
    this.columnTimer = [COLUMN_WAVE_GAP * 0.35, COLUMN_WAVE_GAP * 0.35];
    this.columnWave = [0, 0];
    this.tickets = [TICKETS_MAX, TICKETS_MAX];
    this.respawnQueue = [];
    this.time = 0;
    this.elapsed = 0;
    this.playerKills = 0;
    this.playerAssists = 0;
    this.playerHits = 0;
    this.playerGroundKills = 0;
    this.playerCaps = 0;
    this.playerDamage = 0;
    this.playerSpawnsUsed = 0;
    this.killStreak = 0;
    this.firstBloodTaken = false;
    this.trailEmit = 0;
    this.hitPopCd = 0;
    // Kept as the raw string as well as the boolean: planeEntity.setDifficulty
    // takes the mode, and every Plane built here — player and bot alike — has
    // to get it or the structural G limiter never leaves arcade.
    this.difficulty = progress.getDifficulty();
    this.realistic = this.difficulty === 'realistic';
    this.spectate = false;
    this.stats = new Map(); // scoreboard: name -> { kills, deaths, ... }
    this.bailTimer = 0;
    this.bailMsgCd = 0;
    this.deathCamKiller = null;
    this.deathCamAngle = 0;

    // what main.js needs to settle the battle into an itemised payout
    this.usage = [];
    this.losses = [];
    this.survived = [];

    // warning and callout debounce — a radio that never shuts up is noise
    this.warnSix = 0;
    this.warnGround = 0;
    this.warnStall = 0;
    this.warnAmmo = 0;
    this.warnHurt = 0;
    this.rumbleCd = 0;
    this.wepLockWarned = false;
    this.radAuto = true;
    this.mapZoom = 1;

    this._mapUnits = [];
    this._airExtra = {};
    this._zones = [
      { x: 0, z: 0, r: 30, owner: 0, progress: 0, label: 'A' },
      { x: 0, z: 0, r: 30, owner: 1, progress: 0, label: 'B' },
    ];
    this._spawnMarks = [];
    this._cone = { yaw: 0, fov: 1.1, range: 600 };
    this._mapOpts = {
      zones: this._zones,
      viewCone: this._cone,
      spawns: this._spawnMarks,
      title: 'AIR BATTLE',
    };
    this._compassMarks = [
      { bearing: null, label: 'B', color: '#df6a5f' },
      { bearing: null, label: 'H', color: '#5f9fdf' },
    ];

    // BR-matched rosters instead of a hardcoded squadron: the enemy flight is
    // drawn against what the player actually brought.
    const plan = planBattle({ mode: 'air', kind: 'air', playerSpecId });
    this.plan = plan;
    this.spawnBudget = plan.spawnBudget;

    for (let team = 0; team < 2; team++) {
      const sideX = team === 0 ? -1 : 1;
      // Spread the roaming battery far enough apart that one bombing pass is
      // engaged by one gun, not by the whole side. Each gun gets its own slice
      // of the depth band and its own slice of the frontage, so two of them
      // cannot end up sharing a hilltop.
      for (let i = 0; i < ROAM_AA; i++) {
        const depth = 430 + (i / ROAM_AA) * 420 + rand(0, 420 / ROAM_AA);
        const lane = -560 + (i / ROAM_AA) * 1120;
        this.groundUnits.push(
          new AAGun(
            this.scene, team, sideX * depth, lane + rand(0, 1120 / ROAM_AA), i,
          ),
        );
      }
      for (let i = 0; i < 3; i++) {
        this.groundUnits.push(
          new Truck(this.scene, team, 430, (team === 0 ? 0 : Math.PI) + i * 0.5, i),
        );
      }
      const depot = new Depot(this.scene, team, sideX * 980, team === 0 ? 300 : -300);
      this.depots.push(depot);
      this.groundUnits.push(depot);
    }
    for (const af of this.airfields) {
      this._spawnMarks.push({ x: af.x, z: af.z, team: af.team, r: 150 });
    }
    this._mapOpts.title = `AIR BATTLE · BR ${plan.battleBr.toFixed(1)} · ${plan.bracket.label}`;

    this.camDist = 20;
    this.zoom = false;
    this.fov = 60;

    this.player = this.spawnPlane(playerSpecId, 0, true, 1.5);
    this.planeCam.reset(this.player);
    // the first sortie is free but it still counts, so the second one is not
    this.spawnBudget.spawned.push(this.player.spec.id);
    this.playerSpawnsUsed = 1;
    plan.allies.slice(0, 3).forEach((id, i) => this.spawnPlane(id, 0, false, i));
    plan.enemies.forEach((id, i) => this.spawnPlane(id, 1, false, i));

    this.playerDead = false;
    this.deadTimer = 0;
    this.followDelay = 0;
    this.kbTimer = 0;
    this.followStrength = 0;

    hud.setReloadVisible(false);
    hud.setCrosshairVisible(false); // the yellow nose marker is the gunsight
    hud.setAmmoPanel(null); // a previous tank spawn's shell stack is not ours
    hud.setHelp(`
      <span>Mouse — steer · keys mix in on their axis</span>
      <span>A / D — roll · W / S — pitch (W down) · Q / E — rudder</span>
      <span>Shift / Ctrl — throttle · R — WEP · C — radiator mode</span>
      <span>[ / ] — radiator close / open (manual mode only)</span>
      <span>V — flaps · G — landing gear · B — airbrake / wheel brakes · X — extinguisher</span>
      <span>LMB — fire · Space — bomb · F — rocket</span>
      <span>RMB hold — aim zoom · P — cockpit / chase view · M — map · Tab — scoreboard</span>
      <span>J (hold) — bail out · Esc — pause</span>
      <span>Landing: slow below the gear limit, G, landing flaps, gentle descent (under 2.4 m/s)</span>
      <span>On the ground: Q / E steer · B brakes · stop on your own field to repair and rearm</span>
    `);
  }

  // The raw mouse aim lives in the aircraft camera; these keep the old field
  // names working for everything that reads or writes them (the spectator,
  // the minimap cone, respawn, test harnesses that fly by pointing the view).
  get camYaw() {
    return this.planeCam ? this.planeCam.yaw : 0;
  }

  set camYaw(v) {
    if (this.planeCam) this.planeCam.yaw = v;
  }

  get camPitch() {
    return this.planeCam ? this.planeCam.pitch : 0;
  }

  set camPitch(v) {
    if (this.planeCam) this.planeCam.pitch = v;
  }

  // ---------------- setup ----------------

  // One strip per team, from the shared module. The slab, the markings, the
  // hangars, the tower, the blast pens and the windsocks are all its business
  // now; this method only says where the field goes and how many guns defend it.
  buildAirfield(team) {
    return createAirfield(this.scene, {
      team,
      x: team === 0 ? -AIRFIELD_X : AIRFIELD_X,
      z: 0,
      // the embankment is shaded with the terrain's own palette rule, so it
      // has to know the palette the terrain was built with
      palette: this.preset,
      // takeoff run points straight at the other side, as before
      heading: team === 0 ? Math.PI / 2 : -Math.PI / 2,
      buildAA: (af, spots) => {
        // The AA that makes the strip a place you can actually go home to.
        // Cut from four to two: the guns themselves were rebalanced, but four
        // of them firing together still shot a bomber down before it could aim.
        // Take the spots from opposite corners so the pair cannot both cover
        // the same approach.
        for (let i = 0; i < AIRFIELD_AA && spots.length; i++) {
          const span = Math.max(1, AIRFIELD_AA - 1);
          const s = spots[Math.round((i * (spots.length - 1)) / span)];
          this.groundUnits.push(new AAGun(this.scene, team, s.x, s.z, 10 + i));
        }
      },
    });
  }

  spawnPlane(specId, team, isPlayer, slot = 0) {
    // player vehicles get their purchased modifications and trained crew
    const spec = isPlayer
      ? applyMods(PLANE_SPECS[specId], 'air', { crew: true })
      : PLANE_SPECS[specId];
    const name = isPlayer
      ? `You (${spec.name})`
      : `${team === 0 ? 'Ally' : 'Enemy'} ${spec.name}-${slot + 1}`;
    const plane = new Plane(this.scene, spec, team, name, isPlayer, this.difficulty);
    const x = (team === 0 ? -800 : 800) + rand(-30, 30);
    const z = -140 + slot * 90 + rand(-15, 15);
    const y = terrainHeight(x, z) + 260 + slot * 14;
    plane.setPose(x, y, z, team === 0 ? Math.PI / 2 : -Math.PI / 2);
    // harmonisation: the garage may have set a personal convergence range
    const conv = progress.data && progress.data.convergence
      ? progress.data.convergence[spec.id]
      : null;
    if (conv > 0) plane.convergence = conv;
    // onGround / serviceFrac / rearmTimer / groundYaw — planeEntity knows
    // nothing about airfields, so the landing state is seeded here or the first
    // service tick reads undefined and the HUD prints NaN%.
    initPlaneAirfieldState(plane);
    this.planes.push(plane);
    this.stat(plane);
    if (!isPlayer) {
      // somebody has to work the ground war, and the armoured attackers are
      // built for it — everyone else flies top cover
      const striker = spec.klass === 'Attacker' || (spec.bombs && slot === 2);
      this.ais.push(new PlaneAI(plane, this, striker ? 'striker' : 'fighter'));
    }
    return plane;
  }

  // scoreboard entry for a combatant (respawns merge by display name)
  stat(entity) {
    const key = entity.isPlayer ? 'You' : entity.displayName;
    let s = this.stats.get(key);
    if (!s) {
      s = {
        name: key,
        team: entity.team,
        vehicle: entity.spec ? entity.spec.name : '—',
        kills: 0,
        airKills: 0,
        groundKills: 0,
        deaths: 0,
        assists: 0,
        caps: 0,
        isPlayer: !!entity.isPlayer,
      };
      this.stats.set(key, s);
    } else if (entity.spec) {
      s.vehicle = entity.spec.name;
    }
    return s;
  }

  scoreOf(s) {
    return s.airKills * 100 + s.groundKills * 50 + s.assists * 40 + s.caps * 120;
  }

  scoreboardData() {
    const allies = [];
    const enemies = [];
    for (const s of this.stats.values()) {
      s.score = this.scoreOf(s);
      (s.team === 0 ? allies : enemies).push(s);
    }
    const cmp = (a, b) => b.score - a.score || a.deaths - b.deaths;
    allies.sort(cmp);
    enemies.sort(cmp);
    return { allies, enemies };
  }

  // ---------------- economy bookkeeping ----------------

  usageFor(id) {
    for (const u of this.usage) if (u.id === id) return u;
    const u = {
      id,
      shells: {},
      stream: 0,
      bombs: 0,
      rockets: 0,
      consumables: { parts: 0, fpe: 0, crew: 0 },
    };
    this.usage.push(u);
    return u;
  }

  // Every silver-earning action pops on the crosshair AND is banked for the
  // results screen, so what the player sees in the fight is what they get.
  earn(silver, rp) {
    if (silver > 0) this.hud.showReward(Math.round(silver), 'SL');
    if (rp > 0) this.hud.showReward(Math.round(rp), 'RP');
  }

  // The damage score the results screen bills against (contract F4): unitless,
  // and calibrated so that removing one whole vehicle from the battle is worth
  // 100. Half a fighter's structure is 50, whatever the raw numbers behind it —
  // otherwise a cannon armed for aircraft would out-earn a bomb load simply by
  // counting in bigger units.
  creditDamage(target, dmg) {
    if (!target || !(dmg > 0)) return;
    const pool =
      target.maxHp || (target.spec ? target.spec.hp : 0) || SOFT_TARGET_HP;
    this.playerDamage += 100 * clamp(dmg / Math.max(1, pool), 0, 1);
  }

  // The persistent record beside the transient pop-ups: what the pilot reads
  // after the fact to work out how the sortie went wrong.
  log(text, kind = 'info') {
    if (this.logOn) this.hud.addDamageLog?.(text, kind);
  }

  awardSpawnPoints(events) {
    const gained = this.spawnBudget ? this.spawnBudget.award(events) : 0;
    return gained;
  }

  get spawnPoints() {
    return this.spawnBudget ? Math.round(this.spawnBudget.points) : 0;
  }

  minSpawnCost() {
    const list =
      this.spawnBudget && this.spawnBudget.lineup.length
        ? this.spawnBudget.lineup
        : [this.player.spec.id];
    let min = Infinity;
    for (const id of list) min = Math.min(min, progress.spawnCost(id));
    return min === Infinity ? 0 : min;
  }

  // What the aeroplane the pilot is sitting in would cost to bring back. The
  // chip goes amber against this, so the pilot can see the moment one more pass
  // stops being a gamble and starts being a walk home.
  nextSpawnCost() {
    if (!this.spawnBudget) return null;
    const id = this.player && this.player.spec ? this.player.spec.id : null;
    if (!id) return null;
    return typeof this.spawnBudget.cost === 'function'
      ? this.spawnBudget.cost(id)
      : progress.spawnCost(id);
  }

  canPlayerRespawn() {
    if (this.finished) return false;
    if (this.tickets[0] <= RESPAWN_COST) return false;
    if (this.playerSpawnsUsed >= MAX_SPAWNS) return false;
    return this.spawnPoints >= this.minSpawnCost();
  }

  // ---------------- main update ----------------
  update(dt) {
    if (this.finished) return;
    this.time += dt;
    this.elapsed = this.time;
    if (this.hitPopCd > 0) this.hitPopCd -= dt;
    if (this.rumbleCd > 0) this.rumbleCd -= dt;
    if (this.warnSix > 0) this.warnSix -= dt;
    if (this.warnGround > 0) this.warnGround -= dt;
    if (this.warnStall > 0) this.warnStall -= dt;
    if (this.warnAmmo > 0) this.warnAmmo -= dt;
    if (this.warnHurt > 0) this.warnHurt -= dt;
    if (this.spawnBudget) {
      this.spawnBudget.points += dt * (12 / 60); // SPAWN_AWARDS.perMinute, prorated
    }

    if (this.player.alive) {
      this.updatePlayerControls(dt);
      this.updateBail(dt);
    } else if (!this.playerDead && !this.playerDeathHandled) {
      this.playerDead = true;
      this.deadTimer = 3.0;
      this.startDeathCam();
    }
    if (input.pressed('KeyM')) this.hud.toggleBigMap();
    if (this.playerDead) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) {
        this.playerDead = false;
        this.playerDeathHandled = true;
        this.hud.setDeathInfo(null);
        this.onPlayerDeath?.(this.canPlayerRespawn(), this.playerKills);
      }
    }

    for (const ai of this.ais) ai.update(dt);

    for (const plane of this.planes) {
      const wasAlive = plane.alive;
      if (plane.onGround) updateGroundRoll(plane, dt, this.afCtx());
      else plane.update(dt);
      if (plane.justExploded) {
        plane.justExploded = false;
        // AV-01: one law for the picture, the sound and the shake
        this.effects.explosion(plane.position.clone(), BLAST_KG.aircraft);
        sfx3d.explosion(plane.position, { size: 1.6, kg: BLAST_KG.aircraft });
        this.shake.addBlast(BLAST_KG.aircraft, plane.position, this.camera.position);
        removeEngine(`p${plane.id}`);
      }
      if (wasAlive && !plane.alive) {
        // The aeroplane's last words — "Undercarriage collapsed — 4.6 m/s",
        // "Hit the hangar", "Belly landing" — are the only explanation the
        // pilot gets, and updatePlayerWarnings stops draining once he is dead.
        if (plane === this.player) {
          const last = plane.drainEvents();
          if (last) for (const e of last) this.hud.incomingMessage(e, 'critical', this.logOn);
        }
        // crash / stall-in / burn-out without bullet credit
        this.onPlaneKilled(
          plane.lastHitAge < 8 ? plane.lastAttacker : null,
          plane,
        );
      }
      this.updateGuns(plane, dt);
      if (plane.alive) {
        updateAirfieldService(plane, dt, this.afCtx());
        this.updatePlaneEffects(plane, dt);
        if (plane !== this.player) {
          updateEngine(`p${plane.id}`, {
            pos: plane.position,
            rpm: Math.min(1, plane.speed / plane.spec.maxSpeed),
            throttle: plane.throttle,
            type: 'plane',
            moving: true,
          });
        }
      }
    }
    this.resolvePlaneCollisions();
    this.updatePlayerWarnings(dt);

    // player ordnance release
    if (this.player.alive && input.pressed('Space')) this.dropBomb(this.player);
    if (this.player.alive && input.pressed('KeyF')) this.fireRocket(this.player);

    for (const g of this.groundUnits) {
      if (g instanceof AAGun) {
        g.update(dt, this.planes, this.bullets, (gun) => {
          sfx3d.mg(gun.position);
          this.effects.mgFlash(
            tmpV.copy(gun.position).add(tmpV2.set(0, 1.8, 0)),
            tmpV3.set(Math.sin(gun.yawG), Math.sin(gun.pitchG), Math.cos(gun.yawG)),
          );
        });
      } else {
        g.update(dt);
      }
    }
    this.updateGroundWar(dt);

    this.bombManager.update(dt, null, (point, bomb) => this.bombExplode(point, bomb), this.effects);

    this.bullets.update(
      dt,
      this.planes,
      (target, dmg, shooter, point) => this.onBulletHit(target, dmg, shooter, point),
      this.effects,
      this.groundUnits,
      (g, b, point) => this.onBulletGround(g, b, point),
    );

    this.updateRearm(dt);
    this.cleanupWrecks(dt);
    this.updateTrails(dt);
    this.effects.update(dt);
    this.updateRespawns(dt);
    this.shake.update(dt);
    this.updateCamera(dt);
    // the listener rides the camera, and the camera was written directly, so
    // the world matrix has to be refreshed before the forward vector is read
    this.camera.updateMatrixWorld();
    setListener(this.camera);
    updateAudio();
    this.updateHUD();
    this.checkEnd();
    // The sun direction comes from the map preset and the shadow volume is
    // anchored by scenery.js's own onBeforeRender hook (updateSunAnchor).
    // Writing sun.position here is what used to hang a dusk sun at midday.
  }

  updatePlayerControls(dt) {
    const p = this.player;
    const sens = 0.0022 * (this.fov / 60);
    if (input.mouseDX !== 0 || input.mouseDY !== 0) this.followDelay = 0.9;
    // A-02: P swaps the chase view and the cockpit; in the cockpit the view
    // banks with the wings, so the mouse is read on the screen
    if (input.pressed('KeyP')) this.cockpit = !this.cockpit;
    if (this.cockpit && p.alive) {
      this.planeCam.addMouseScreen(input.mouseDX, input.mouseDY, sens);
    } else {
      this.camYaw = wrapAngle(this.camYaw - input.mouseDX * sens);
      this.camPitch = clamp(this.camPitch - input.mouseDY * sens, -1.35, 1.35);
    }

    if (input.wheel !== 0) {
      // the wheel zooms the tactical map while it is open, otherwise it is the
      // chase camera's dolly
      if (this.hud.bigMapVisible) {
        this.mapZoom = clamp((this.mapZoom || 1) - input.wheel * 0.5, 1, 4);
        this.hud.setMinimapZoom(this.mapZoom);
      } else if (!this.zoom) {
        this.camDist = clamp(this.camDist + input.wheel * 2, 12, 40);
      }
    }
    // entering zoom snaps the aim to the current nose direction
    if (input.rightDown && !this.zoom) this.planeCam.aimAlongNose(p);
    this.zoom = input.rightDown;

    // throttle on Shift (up) / Ctrl (down)
    const thrIn =
      (input.down('ShiftLeft') || input.down('ShiftRight') ? 1 : 0) -
      (input.down('ControlLeft') || input.down('ControlRight') ? 1 : 0);
    p.throttle = clamp(p.throttle + thrIn * 0.5 * dt, 0, 1);
    this.updateSystemKeys(p, dt);

    // Mouse and keyboard work TOGETHER: held keys always own their axis;
    // the mouse instructor drives the remaining axes while the mouse is
    // active. Flying keyboard-only (mouse idle) the instructor stands down
    // completely so it never fights a manoeuvre — moving the mouse blends
    // it back in instantly.
    const kRoll = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const kPitch = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    const kYaw = (input.down('KeyQ') ? 1 : 0) - (input.down('KeyE') ? 1 : 0);
    const keysHeld = kRoll !== 0 || kPitch !== 0 || kYaw !== 0;
    const mouseRecent = this.followDelay > 0; // mouse moved in the last 0.9s

    if (!keysHeld || mouseRecent) {
      // The mouse flies to exactly where it points. In the keyboard grace the
      // instructor is aimed past any swing the view is still making over the
      // vertical (planeCamera.steerPoint), so letting go of S on the far side
      // of a loop holds the attitude instead of chasing the half-turned view;
      // off the vertical the two points are the same to the bit.
      const aim = mouseRecent
        ? this.planeCam.aimPoint(p, 600, tmpV3)
        : this.planeCam.steerPoint(p, 600, tmpV3);
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

    // The camera chases the nose during keyboard flying. It used to do that at
    // a constant angular rate, which is a step in angular velocity at both
    // ends — the jerk players felt every time they let go of a key. It is a
    // spring now (planeCamera.followNose): it starts from rest, settles without
    // overshoot, and lets go just as gently when the strength drops to zero.
    this.followDelay -= dt;
    // full strength while a key is held, then easing out over the 1.2 s grace.
    // Only the strength is decided here: the follow itself runs in
    // updateCamera(), after the physics step, so it chases the nose that is
    // about to be drawn rather than last frame's — a whole frame of turn (a
    // degree at a keyboard turn rate) that used to sit in the lag for nothing.
    this.followStrength = !this.zoom && this.followDelay <= 0
      ? (keysHeld ? 1 : this.kbTimer > 0 ? 0.55 * Math.min(1, this.kbTimer / 0.5) : 0)
      : 0;
    p.firing = input.locked && input.fireHeld;
  }

  // Gear, flaps, airbrake, WEP, the bottle and the radiator: the switches that
  // decide whether the aeroplane is still an aeroplane at the end of the sortie.
  updateSystemKeys(p, dt) {
    const hud = this.hud;
    if (input.pressed('KeyG')) {
      p.toggleGear();
      // A lever that took but whose legs are waiting for the speed to come
      // down, or a gear that is not there any more, speaks for itself through
      // the aeroplane's own events (drained in updatePlayerWarnings).
      if (!p.gearGone && !(p.gear && p.gearHeld)) {
        hud.incomingMessage(p.gear ? 'Gear down' : 'Gear up', 'info');
      }
    }
    if (input.pressed('KeyV')) {
      p.cycleFlaps();
      hud.incomingMessage(['Flaps up', 'Combat flaps', 'Takeoff flaps', 'Landing flaps'][p.flaps], 'info');
    }
    p.setAirbrake(input.down('KeyB'));
    if (input.pressed('KeyR')) {
      const was = p.wep;
      p.toggleWep();
      if (p.wep === was) hud.incomingMessage('WEP locked out — engine too hot', 'warn');
      else hud.incomingMessage(p.wep ? 'WEP engaged' : 'WEP off', p.wep ? 'warn' : 'info');
    }
    if (input.pressed('KeyX')) {
      if (p.useExtinguisher()) {
        this.usageFor(p.spec.id).consumables.fpe++;
        hud.incomingMessage('Fire extinguished', 'info', this.logOn);
        radioCue('reload');
        this.hud.showAward('FIREFIGHTER', 'Fire beaten out in the air');
      } else {
        hud.incomingMessage(
          p.extinguishers > 0 ? 'Nothing burning' : 'Extinguisher spent',
          'warn',
        );
      }
    }
    if (input.pressed('KeyC')) {
      this.radAuto = !this.radAuto;
      hud.incomingMessage(
        this.radAuto ? 'Radiator: AUTO' : 'Radiator: MANUAL — [ and ] move the flap',
        'info',
      );
    }
    if (this.radAuto) {
      // hold the engine just under the temperature that starts cooking it, and
      // pay the drag for it only when the engine is actually hot
      const want = clamp((p.engineTemp - 0.55) * 3.4, 0.12, 1);
      p.setRadiator(moveToward(p.radiator, want, 0.45 * dt));
    } else {
      const rad =
        (input.down('BracketRight') ? 1 : 0) - (input.down('BracketLeft') ? 1 : 0);
      if (rad !== 0) p.adjustRadiator(rad * 0.5 * dt);
    }
  }

  updateGuns(plane, dt) {
    if (plane.gunTimer > 0) plane.gunTimer -= dt;
    if (plane.gunSound > 0) plane.gunSound -= dt;
    if (!plane.alive || !plane.firing || plane.ammo <= 0) {
      if (plane.gunTimer < 0) plane.gunTimer = 0;
      return;
    }
    const isPlayer = plane === this.player;
    while (plane.gunTimer <= 0 && plane.ammo > 0) {
      plane.gunTimer += 1 / plane.spec.gun.rof;
      plane.ammo--;
      const pos = plane.nextMuzzle(tmpV);
      // wing guns are harmonised: every muzzle aims at the convergence point
      // rather than straight ahead, which is the whole reason they hit
      const dir = plane.aimFromMuzzle(pos, tmpV2);
      this.bullets.fire(pos, dir, plane.spec.gun.speed, plane.spec.gun.dmg, plane, plane.spec.gun.spread);
      this.effects.mgFlash(pos, dir);
      if (isPlayer) {
        this.usageFor(plane.spec.id).stream++;
        plane.shakeRounds = (plane.shakeRounds || 0) + 1;
        if (plane.shakeRounds >= 4) {
          plane.shakeRounds = 0;
          this.shake.add(0.05, 0.16);
        }
      }
    }
    if (plane.gunSound <= 0) {
      plane.gunSound = 0.11;
      sfx3d.mg(plane.position);
    }
    if (isPlayer && plane.ammo <= 0 && this.warnAmmo <= 0) {
      this.warnAmmo = 6;
      this.hud.incomingMessage(
        this.realistic ? 'Out of ammunition — land to rearm' : 'Out of ammunition',
        'warn',
      );
    }
  }

  // ---------------- damage ----------------

  onBulletHit(target, dmg, shooter, point) {
    if (!this.realistic && target.team === shooter.team) return;
    // the shooter-to-impact line is a good stand-in for the round's path, and
    // it is what lets a burst from astern take the tail rather than the nose
    const dir = tmpV3.subVectors(point, shooter.position).normalize();
    const res = target.applyDamage(dmg, shooter, point, dir);
    this.effects.impactSparks(point, false);
    const isPlayerShot = shooter === this.player;

    if (isPlayerShot) {
      this.creditDamage(target, dmg);
      if (res.events.length > 0) {
        this.playerHits++;
        // the battle banks its own spawn points now — a crippling hit is worth
        // the same here as it is on the ground, and nobody else credits it
        if (target.team !== this.player.team) this.awardSpawnPoints({ hits: 1 });
      }
      for (const ev of res.events) this.hud.hitMessage(ev, 'good');
      if (res.events.length === 0 && this.hitPopCd <= 0) {
        this.hitPopCd = 0.6;
        this.hud.hitMessage('Hit', 'bad');
      }
      if (res.events.length > 0) this.earn(REWARD.silver.hit, REWARD.rp.hit);
    }
    if (target === this.player) this.onPlayerHurt(res.events, shooter.position, dmg);

    if (res.killed) {
      if (isPlayerShot) this.hud.hitMessage('Target destroyed', 'kill');
      sfx3d.hit(point);
      this.onPlaneKilled(shooter, target);
    }
  }

  // Everything the player's own aeroplane suffers, surfaced. Discarding these
  // events was the single biggest hole in the old feedback loop: the aeroplane
  // fell apart and the pilot was told nothing.
  onPlayerHurt(events, sourcePos, dmg) {
    const hud = this.hud;
    sfx3d.hit(this.player.position);
    if (sourcePos) {
      tmpV4.subVectors(sourcePos, this.player.position);
      const bearing = Math.atan2(tmpV4.x, tmpV4.z);
      const severity = events && events.length ? 'critical' : dmg > 8 ? 'heavy' : 'light';
      hud.damageDirection(wrapAngle(bearing - this.viewYaw()), severity);
    }
    this.shake.add(clamp(0.18 + dmg * 0.035, 0.18, 0.7), 0.5);
    if (events && events.length) {
      for (const ev of events) hud.incomingMessage(ev, 'critical', this.logOn);
      radioCue('critical');
      this.warnHurt = 0.6;
    } else if (this.warnHurt <= 0) {
      // a burst is one event to the pilot, not forty
      this.warnHurt = 0.6;
      radioCue('damage');
      hud.incomingMessage('Taking hits', 'warn', this.logOn);
    }
  }

  strafeTargetsFor(team) {
    return this.groundUnits.filter((g) => g.alive && g.team !== team);
  }

  dropBomb(plane) {
    if (!plane.alive || plane.bombs <= 0) return;
    plane.bombs--;
    this.bombManager.drop(plane);
    if (plane === this.player) this.usageFor(plane.spec.id).bombs++;
  }

  fireRocket(plane) {
    if (!plane.alive || plane.rockets <= 0) return;
    plane.rockets--;
    this.bombManager.fireRocket(plane);
    sfx3d.fire(plane.position, { caliber: 82 });
    if (plane === this.player) {
      this.usageFor(plane.spec.id).rockets++;
      this.shake.add(0.12, 0.25);
    }
  }

  bombExplode(point, bomb) {
    // The fireball, the ground scar, the smoke column, the sound and the camera
    // kick are all staged by BombManager now (setBlastContext in the constructor),
    // scaled by the charge and by the listener distance. Drawing them here as well
    // played every burst twice and voiced it twice at the same scheduled arrival
    // time, which is loud enough to duck the whole mix.
    const radius = bomb.radius;
    const rocket = bomb.type === 'rocket';
    // The scenery goes with it: a bomb flattens the treeline and takes a shed
    // apart, a rocket only clears the trees. The felled ring is the mark a
    // strike aircraft leaves on the map long after the smoke has gone.
    if (typeof damagePropsAt === 'function') {
      damagePropsAt(point.x, point.z, radius * (rocket ? 1.2 : 1.6), rocket ? 220 : 700);
    }
    for (const g of this.groundUnits) {
      if (!g.alive) continue;
      if (!this.realistic && g.team === bomb.shooter.team) continue;
      const d = g.position.distanceTo(point);
      if (d < radius + g.radius) {
        // Per unit, from its own distance: a flat number over a 36 m radius
        // wipes a whole battery out with one bomb. (This used to be computed
        // once above the loop from a `g` that did not exist yet, which threw on
        // every impact and meant no bomb or rocket damaged anything here.)
        const dmg = blastDamageAt(bomb, d);
        this.tagDamage(g, bomb.shooter);
        if (bomb.shooter === this.player) this.creditDamage(g, dmg);
        if (g.takeDamage(dmg)) this.onGroundUnitKilled(bomb.shooter, g);
      }
    }
    for (const pl of this.planes) {
      if (!pl.alive || pl === bomb.shooter) continue;
      if (!this.realistic && pl.team === bomb.shooter.team) continue;
      if (pl.position.distanceTo(point) < radius * 0.8) {
        if (bomb.shooter === this.player) this.creditDamage(pl, 200);
        const res = pl.applyDamage(200, bomb.shooter);
        if (pl === this.player) this.onPlayerHurt(res.events, point, 40);
        if (res.killed) this.onPlaneKilled(bomb.shooter, pl);
      }
    }
  }

  onBulletGround(g, b, point) {
    if (!this.realistic && g.team === b.shooter.team) return;
    this.effects.impactSparks(point, false);
    this.effects.dirtImpact(point, 0.6);
    this.tagDamage(g, b.shooter);
    if (b.shooter === this.player) this.creditDamage(g, b.dmg);
    if (g.takeDamage(b.dmg)) this.onGroundUnitKilled(b.shooter, g);
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
          removeEngine(`p${a.id}`);
          removeEngine(`p${b.id}`);
          if (a === this.player || b === this.player) {
            this.hud.incomingMessage('Mid-air collision', 'critical', this.logOn);
          }
          this.onPlaneKilled(b, a);
          this.onPlaneKilled(a, b);
        }
      }
    }
  }

  tagDamage(target, attacker) {
    if (!attacker || attacker === target) return;
    target.lastAttacker = attacker;
    (target.damagers || (target.damagers = new Set())).add(attacker);
  }

  // hold J to bail out and pick a new plane without leaving battle
  updateBail(dt) {
    if (this.bailMsgCd > 0) this.bailMsgCd -= dt;
    if (input.down('KeyJ')) {
      this.bailTimer += dt;
      if (this.bailMsgCd <= 0) {
        this.bailMsgCd = 0.6;
        this.hud.incomingMessage('Bailing out…', 'warn');
      }
      if (this.bailTimer >= 1.5) {
        this.bailTimer = 0;
        const p = this.player;
        p.lastAttacker = null; // no killer — the pilot just left
        p.beginFalling();
        this.onPlaneKilled(null, p);
      }
    } else {
      this.bailTimer = 0;
    }
  }

  startDeathCam() {
    const p = this.player;
    const k = p.lastHitAge < 8 ? p.lastAttacker : null;
    this.deathCamKiller = k && k !== p ? k : null;
    this.deathCamAngle = rand(0, Math.PI * 2);
    this.shake.reset();
    this.hud.setBlackout(0);
    if (this.deathCamKiller) {
      const d = Math.round(p.position.distanceTo(this.deathCamKiller.position));
      this.hud.setDeathInfo(`Destroyed by ${this.deathCamKiller.displayName} · ${d}m`);
    }
  }

  // despawn dead planes and stale player wrecks
  cleanupWrecks(dt) {
    for (let i = this.planes.length - 1; i >= 0; i--) {
      const pl = this.planes[i];
      if (pl.state !== 'dead' || pl === this.player) continue;
      pl.wreckAge = (pl.wreckAge || 0) + dt;
      if (pl.wreckAge > 8) {
        this.planes.splice(i, 1);
        removeEngine(`p${pl.id}`);
        pl.dispose();
      }
    }
    if (this.wrecks) {
      for (let i = this.wrecks.length - 1; i >= 0; i--) {
        const w = this.wrecks[i];
        w.wreckAge = (w.wreckAge || 0) + dt;
        if (w.wreckAge > 10) {
          this.wrecks.splice(i, 1);
          removeEngine(`p${w.id}`);
          w.dispose();
        }
      }
    }
    // burnt-out column vehicles are cleared so a long battle does not end up
    // dragging thirty wrecks through every bullet test
    for (let i = this.groundUnits.length - 1; i >= 0; i--) {
      const g = this.groundUnits[i];
      if (!g.isColumn || g.alive) continue;
      g.deadAge = (g.deadAge || 0) + dt;
      if (g.deadAge > 25) {
        this.groundUnits.splice(i, 1);
        g.dispose();
      }
    }
  }

  // everyone who damaged the victim (except the killer) earns an assist
  creditAssists(killer, victim) {
    if (!victim.damagers) return;
    for (const d of victim.damagers) {
      if (d === killer || d === victim || d.team === victim.team) continue;
      if (!d.isAircraft) continue; // an AA battery does not want a scoreboard row
      this.stat(d).assists++;
      if (d === this.player && victim.team === 1) {
        this.playerAssists++;
        this.hud.hitMessage('Assist', 'good');
        this.earn(REWARD.silver.assist, REWARD.rp.assist);
        this.awardSpawnPoints({ assists: 1 });
      }
    }
  }

  onGroundUnitKilled(killer, g) {
    const base = !!g.isBase;
    this.tickets[g.team] -= base
      ? BASE_TICKETS
      : g.isColumn
        ? COLUMN_TICKETS
        : GROUND_TICKETS;
    if (killer && killer !== g && killer.isAircraft) {
      const ks = this.stat(killer);
      ks.groundKills++;
      if (base) ks.caps++;
    }
    this.creditAssists(killer, g);
    const boomKg = base ? BLAST_KG.base : BLAST_KG.groundTarget;
    this.effects.explosion(g.position.clone().add(tmpV.set(0, 1.2, 0)), boomKg);
    sfx3d.explosion(g.position, { size: base ? 2.6 : 1.2, kg: boomKg });
    this.shake.addBlast(boomKg, g.position, this.camera.position);
    if (base) {
      // a burning depot is a landmark for the rest of the battle
      this.effects.smokeScreen(g.position.clone().add(tmpV.set(0, 3, 0)), 22, 120);
    }
    if (killer && killer.isPlayer && g.team === 1) {
      this.playerGroundKills++;
      this.log(`${g.displayName} destroyed`, 'good');
      if (base) {
        this.playerCaps++;
        this.hud.showAward('DEPOT DESTROYED', g.displayName);
        this.earn(REWARD.silver.cap, REWARD.rp.cap);
        this.awardSpawnPoints({ caps: 1 });
      } else {
        this.earn(REWARD.silver.ground, REWARD.rp.ground);
        this.awardSpawnPoints({ groundKills: 1 });
      }
      radioCue('destroyed');
    }
    this.hud.addKillfeed(
      killer ? killer.displayName : 'Fire',
      killer ? killer.team : 1 - g.team,
      g.displayName,
      g.team,
    );
    if (base && g.team === 0) {
      this.hud.incomingMessage('Our depot has been destroyed', 'critical', this.logOn);
      radioCue('warning');
    }
  }

  onPlaneKilled(killer, victim) {
    if (victim.killCredited) return;
    victim.killCredited = true;
    removeEngine(`p${victim.id}`);
    this.tickets[victim.team] -= KILL_COST;
    if (killer && killer !== victim && killer.isAircraft) {
      const ks = this.stat(killer);
      ks.kills++;
      ks.airKills++;
    }
    this.stat(victim).deaths++;
    // an aircraft that just killed one of ours is a marked man for 25 seconds
    if (killer && victim.team === 0 && !killer.isPlayer) killer.avengeUntil = this.time + 25;
    if (killer && killer.isPlayer && victim.team === 1) {
      this.playerKills++;
      this.onPlayerKill(victim);
    }
    this.creditAssists(killer, victim);
    if (victim === this.player) {
      this.killStreak = 0;
      this.losses.push(victim.spec.id);
      this.hud.setBlackout(0);
      radioCue('destroyed');
      this.log(
        killer && killer !== victim
          ? `Shot down by ${killer.displayName}`
          : 'Aircraft lost',
        'critical',
      );
    }
    this.hud.addKillfeed(
      killer ? killer.displayName : 'Crash',
      killer ? killer.team : 1 - victim.team,
      victim.displayName,
      victim.team,
    );
    if (!victim.isPlayer && this.tickets[victim.team] > RESPAWN_COST) {
      this.respawnQueue.push({ team: victim.team, specId: victim.spec.id, timer: 7 });
    }
  }

  // Awards, money and spawn points for a kill the player earned.
  onPlayerKill(victim) {
    const hud = this.hud;
    this.killStreak++;
    const dist = this.player.position.distanceTo(victim.position);
    radioCue('destroyed');
    this.log(`${victim.displayName} shot down · ${Math.round(dist)}m`, 'good');
    this.earn(REWARD.silver.kill, REWARD.rp.kill);
    this.awardSpawnPoints({ kills: 1 });
    if (!this.firstBloodTaken) {
      this.firstBloodTaken = true;
      hud.showAward('FIRST BLOOD', 'First kill of the battle');
    }
    if (dist > 800) hud.showAward('SNIPER', `${Math.round(dist)} m`);
    if (victim.avengeUntil && victim.avengeUntil > this.time) {
      hud.showAward('AVENGER', `Avenged ${victim.displayName}'s last victim`);
    }
    if (this.killStreak === 3) hud.showAward('KILL STREAK', 'Three in a row');
    else if (this.killStreak === 5) hud.showAward('ON FIRE', 'Five without dying');
    else if (this.killStreak === 7) hud.showAward('TERROR OF THE SKY', 'Seven without dying');
  }

  playerRespawn(specId) {
    const id = specId || this.player.spec.id;
    const cost = this.spawnBudget ? this.spawnBudget.cost(id) : 0;
    if (this.spawnBudget) {
      this.spawnBudget.points -= cost;
      this.spawnBudget.spawned.push(id);
    }
    this.playerSpawnsUsed++;
    this.playerDeathHandled = false;
    this.deathCamKiller = null;
    this.bailTimer = 0;
    this.wepLockWarned = false; // a fresh engine is not the old one's lockout
    this.shake.reset();
    this.hud.setDeathInfo(null);
    this.hud.setBlackout(0);
    this.hud.clearDamageLog();
    const idx = this.planes.indexOf(this.player);
    if (idx >= 0) {
      this.wrecks = this.wrecks || [];
      this.wrecks.push(this.player);
      this.planes.splice(idx, 1);
    }
    this.player = this.spawnPlane(id, 0, true, 1.5);
    this.planeCam.reset(this.player);
    this.zoom = false;
    if (cost > 0) this.hud.incomingMessage(`Spawn cost ${cost} points`, 'info');
  }

  updateRespawns(dt) {
    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      const r = this.respawnQueue[i];
      r.timer -= dt;
      if (r.timer <= 0) {
        this.respawnQueue.splice(i, 1);
        if (this.tickets[r.team] > RESPAWN_COST) {
          this.spawnPlane(r.specId, r.team, false, Math.floor(rand(0, 4)));
        }
      }
    }
  }

  // ---------------- airfield: landing, repair, rearm, takeoff ----------------

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
        logOn: this.logOn,
        // the battle owns the chase camera: snap it back behind the aircraft
        // the moment it rotates, exactly as the old private takeOff() did
        onTakeOff: (plane) => {
          if (plane === this.player) this.followDelay = 0;
        },
        // The crew turned the aeroplane round (and perhaps towed it to the far
        // end of the runway). The view and the mouse aim were still looking
        // the way it stopped — at its nose from in front, with the instructor
        // told to fly back the way it came the moment it left the ground — so
        // they are put back behind it, a cut that goes with the swing's own.
        onServiced: (plane, af, how) => {
          if (plane === this.player && how && (how.swung || how.towed)) this.planeCam.reset(plane);
        },
      };
      this._afCtx = ctx;
    }
    // the player changes on every respawn, so this one field is re-read
    ctx.player = this.player;
    return ctx;
  }

  // ---------------- ground war ----------------

  updateGroundWar(dt) {
    for (const g of this.groundUnits) {
      if (!g.isColumn || !g.alive || !g.arrived) continue;
      const depot = this.depots[1 - g.team];
      if (!depot || !depot.alive) continue;
      if (depot.takeDamage(COLUMN_DPS * dt)) this.onGroundUnitKilled(null, depot);
    }
    for (let team = 0; team < 2; team++) {
      this.columnTimer[team] -= dt;
      if (this.columnTimer[team] > 0) continue;
      // a fresh wave only rolls once the last one is gone or has arrived
      let live = 0;
      for (const g of this.groundUnits) {
        if (g.isColumn && g.team === team && g.alive && !g.arrived) live++;
      }
      if (live > 0) {
        this.columnTimer[team] = 8;
        continue;
      }
      this.columnTimer[team] = COLUMN_WAVE_GAP;
      this.spawnColumn(team);
    }
  }

  spawnColumn(team) {
    const target = this.depots[1 - team];
    if (!target || !target.alive) return;
    const wave = this.columnWave[team]++;
    const from = new THREE.Vector3(
      (team === 0 ? -1 : 1) * 700,
      0,
      target.position.z * 0.35 + (wave % 2 === 0 ? 60 : -60),
    );
    for (let i = 0; i < COLUMN_SIZE; i++) {
      this.groundUnits.push(
        new ColumnVehicle(this.scene, team, i, from, target.position, i === 0),
      );
    }
    if (team === 1) {
      this.hud.incomingMessage('Enemy column moving on our depot', 'warn');
    }
  }

  // ---------------- per-plane effects and warnings ----------------

  updatePlaneEffects(plane, dt) {
    const spec = plane.spec;
    // a damaged engine trails before it dies, and a fire is visible from the
    // other side of the map — both are how a pilot picks the wounded one out
    if (plane.burning) {
      this.effects.engineSmoke(
        tmpV.copy(plane.position).addScaledVector(plane.dir, 0.5),
        'fire',
        dt,
      );
    } else if (!plane.engineOk) {
      this.effects.engineSmoke(
        tmpV.copy(plane.position).addScaledVector(plane.dir, -1),
        'heavy',
        dt,
      );
    } else if (plane.smoking) {
      this.effects.engineSmoke(
        tmpV.copy(plane.position).addScaledVector(plane.dir, -1),
        'light',
        dt,
      );
    } else if (plane.hp < spec.hp * 0.34) {
      this.effects.engineSmoke(tmpV.copy(plane.position), 'light', dt);
    }
    if (plane.onGround) return;

    const half = spec.span * 0.5;
    const sn = plane.speed / spec.maxSpeed;
    // contrails only where physics allows (X-06): cold, high air above ~7.5 km
    // (planeEntity.contrailStrength), so never at this map's ~1 km ceiling.
    {
      const strength = plane.contrailStrength ? plane.contrailStrength() : 0;
      if (strength > 0.05) {
        this.effects.contrail(
          tmpV.set(half, 0, 0).applyQuaternion(plane.quat).add(plane.position),
          strength,
          dt,
        );
        this.effects.contrail(
          tmpV.set(-half, 0, 0).applyQuaternion(plane.quat).add(plane.position),
          strength,
          dt,
        );
      }
    }
    // wingtip vapour under load: the visible edge of the turn the wing is
    // actually managing
    // (X-06: only at 5 g and up, and only in humid air — planeEntity.wingVapourStrength)
    const vapour = plane.wingVapourStrength ? plane.wingVapourStrength(this.preset) : 0;
    const load = clamp((Math.abs(plane.gLoad) - 3.2) / 3.5, 0, 1) * clamp(sn, 0, 1);
    if (vapour > 0.05) {
      this.effects.wingVortex(
        tmpV.set(half * 0.92, 0, 0).applyQuaternion(plane.quat).add(plane.position),
        vapour,
        dt,
      );
      this.effects.wingVortex(
        tmpV.set(-half * 0.92, 0, 0).applyQuaternion(plane.quat).add(plane.position),
        vapour,
        dt,
      );
    }
    // the buffet of a hard turn is felt whether or not the air shows it
    if (load > 0.05) {
      if (plane === this.player && this.rumbleCd <= 0) {
        this.rumbleCd = 0.09;
        this.shake.add(0.05 * load, 0.2);
      }
    }
  }

  // Everything the aeroplane wants to tell its own pilot, plus the two things
  // only the battle can see: the ground coming up and the bandit behind.
  updatePlayerWarnings(dt) {
    const p = this.player;
    if (!p.alive) return;
    const evs = p.drainEvents();
    if (evs) {
      for (const e of evs) {
        const critical = /wing|fuel|fire|spin|overspeed|pilot/i.test(e);
        this.hud.incomingMessage(e, critical ? 'critical' : 'warn', this.logOn);
      }
      radioCue('warning');
    }
    if (p.onGround) return;

    // WEP does not fail loudly: the engine takes the boost away by itself, and
    // without this the pilot only learns of it by wondering why the aeroplane
    // stopped accelerating.
    if (p.wepLock && !this.wepLockWarned) {
      this.wepLockWarned = true;
      this.hud.incomingMessage('WEP locked out — engine overheating', 'warn', this.logOn);
      radioCue('warning');
    } else if (!p.wepLock && this.wepLockWarned) {
      this.wepLockWarned = false;
      this.hud.incomingMessage('WEP available again', 'info');
    }

    if (p.stalled && this.warnStall <= 0) {
      this.warnStall = 4;
      this.hud.incomingMessage(p.spinning ? 'SPIN — unload and opposite rudder' : 'STALL', 'warn');
      radioCue('warning');
    }

    // ground proximity: three seconds of the current flight path, against the
    // solid ground (an airfield's platform and embankment stand on the terrain).
    // An aeroplane on approach — wheels down and locked, slowed to circuit
    // speed, descending gently — is SUPPOSED to be near the ground, and a
    // "PULL UP" on every finals is how a warning teaches pilots to ignore it.
    const lookX = p.position.x + p.vel.x * 3;
    const lookZ = p.position.z + p.vel.z * 3;
    const lookY = p.position.y + p.vel.y * 3;
    const landing = p.gearPos >= 1 && p.ias < p.gearLim.vle * 1.15 && p.vel.y > -6;
    if (!landing && lookY - groundHeightAt(lookX, lookZ) < 60 && p.vel.y < -5) {
      if (this.warnGround <= 0) {
        this.warnGround = 2.5;
        this.hud.incomingMessage('PULL UP', 'critical');
        radioCue('warning');
      }
    }

    // somebody on the six: within gun range, behind, and pointing at you
    if (this.warnSix <= 0) {
      for (const other of this.planes) {
        if (!other.alive || other.team === p.team) continue;
        const d = other.position.distanceTo(p.position);
        if (d > 520) continue;
        tmpV.subVectors(p.position, other.position).normalize();
        if (tmpV.dot(other.dir) < 0.93) continue; // not tracking us
        if (tmpV.dot(p.dir) < 0.2) continue; // he is behind us, not ahead
        this.warnSix = 8;
        this.hud.incomingMessage('Bandit on your six!', 'warn');
        radioCue('warning');
        break;
      }
    }
  }

  // Arcade lets a fighter top its belts up in the air after a lull; realistic
  // makes you go home for it. That is the whole difference between the modes.
  //
  // The AI flies home for its ammunition now (ai/planeAI.js, the RTB
  // circuit), so it is topped up here only when it has no field to go home
  // to (plane._rtbHome false): then a long dry spell stands in for the
  // sortie that is not simulated.
  updateRearm(dt) {
    for (const plane of this.planes) {
      if (!plane.alive || plane.onGround) continue;
      if (this.realistic && plane === this.player) continue;
      // an AI with a field to go home to does now: its crew rearm it there
      // (ai/planeAI.js sets the flag; the fallback keeps this top-up)
      if (plane !== this.player && plane._rtbHome) continue;
      if (plane.firing) {
        plane.rearmTimer = 0;
        continue;
      }
      plane.rearmTimer = (plane.rearmTimer || 0) + dt;
      const wait = this.realistic ? 55 : 13;
      if (plane.rearmTimer < wait) continue;
      plane.rearmTimer = 0;
      const max = plane.spec.gun.ammo;
      if (plane.ammo >= max) continue;
      plane.ammo = Math.min(max, plane.ammo + Math.ceil(max * (this.realistic ? 1 : 0.25)));
      if (plane === this.player) {
        this.hud.incomingMessage('Belts topped up', 'info');
        radioCue('reload');
      }
    }
  }

  updateTrails(dt) {
    this.trailEmit -= dt;
    if (this.trailEmit > 0) return;
    this.trailEmit = 0.06;
    for (const plane of this.planes) {
      if (plane.state === 'dead') continue;
      if (plane.state === 'falling') this.effects.burningTick(tmpV.copy(plane.position));
    }
    for (const g of this.groundUnits) {
      if (!g.alive && Math.random() < 0.35) {
        this.effects.wreckSmoke(tmpV.copy(g.position).add(tmpV2.set(0, 1.5, 0)), true);
      }
    }
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
      this.endBattle(result === 'victory', false);
    }
  }

  endBattle(victory, quit) {
    // whatever the player is still sitting in drove home; everything else in
    // this.losses was left in a field somewhere
    if (this.player && this.player.alive) this.survived.push(this.player.spec.id);
    resetAudio();
    updateEngineSound(0, 0, false, 'plane');
    this.hud.setBlackout(0);
    this.hud.setMatchInfo(null);
    this.effects.clearSmokeScreens();
    this.onEnd({
      victory,
      quit,
      kills: this.playerKills,
      assists: this.playerAssists,
      groundKills: this.playerGroundKills,
      hits: this.playerHits,
      caps: this.playerCaps,
      damage: Math.round(this.playerDamage),
      seconds: this.time,
      vehicleId: this.player.spec.id,
      losses: this.losses.slice(),
      survived: this.survived.slice(),
      usage: this.usage,
      difficulty: this.realistic ? 'realistic' : 'arcade',
      spawnPoints: this.spawnPoints,
      spawnsUsed: this.playerSpawnsUsed,
      br: this.plan ? this.plan.br : null,
      battleBr: this.plan ? this.plan.battleBr : null,
      bracket: this.plan ? this.plan.bracket : null,
      mode: 'air',
    });
  }

  // free-fly camera to watch the rest of the battle after dying
  startSpectate() {
    this.spectate = true;
    this.specPos = this.camera.position.clone();
    this.shake.reset();
    this.hud.setDeathInfo(null);
    this.hud.hitMessage('Spectating — WASD fly · Space/Ctrl up-down · Shift boost', 'good');
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
    const spd = (input.down('ShiftLeft') || input.down('ShiftRight') ? 500 : 200) * dt;
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
    this.specPos.y = Math.max(this.specPos.y, groundHeightAt(this.specPos.x, this.specPos.z) + 3);
    this.camera.position.copy(this.specPos);
    this.camera.lookAt(tmpV2.copy(this.specPos).add(dir));
    this.fov = lerp(this.fov, 60, 1 - Math.pow(0.0001, dt));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  // The yaw the view is looking along — what a directional damage arc has to
  // be measured against.
  viewYaw() {
    if (this.spectate) return this.camYaw;
    if (this.zoom && this.player.alive) return this.player.yaw;
    return this.planeCam.viewYaw;
  }

  // ---------------- camera & HUD ----------------
  updateCamera(dt) {
    if (this.spectate) {
      this.updateSpectator(dt);
      this.shake.apply(this.camera);
      return;
    }
    // Chase, aim zoom and the two death cams are the shared aircraft camera's:
    // rigid on the aircraft, rotation sprung, no allocation, and shaken last on
    // a pose it rebuilt itself (see planeCamera.js for why each of those
    // matters). This runs after every plane.update() in update(), so the
    // aircraft it frames is the one about to be drawn.
    const p = this.player;
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
    // keyboard flying: the raw aim follows the nose this frame's physics left
    // (strength from updatePlayerControls; a dead pilot's aim is left alone)
    if (p.alive) cam.followNose(dt, p, this.followStrength || 0);
    cam.update(dt, st);
    this.fov = cam.fov;
  }

  updateHUD() {
    const hud = this.hud;
    const p = this.player;
    const showing = p.alive || p.state === 'falling';

    hud.updateTickets(this.tickets[0], this.tickets[1], TICKETS_MAX, -1, 0, 'DOGFIGHT');
    // one object, refilled: the HUD reads it and keeps nothing
    const mi = this._matchInfo || (this._matchInfo = { timeLeft: 0, mode: '', objective: '' });
    mi.timeLeft = Math.max(0, MATCH_TIME - this.time);
    mi.mode = this.realistic ? 'Air Realistic' : 'Air Arcade';
    mi.objective = this.objectiveLine();
    hud.setMatchInfo(mi);
    hud.setCompass(p.yaw, this.compassMarkers());
    // The spawn budget is the whole point of a lineup — push for one more pass
    // or bank what you have — and it cannot be weighed from the death screen,
    // which is the only place it used to appear. Ground battle shows the same
    // chip for the same reason.
    hud.setSpawnPoints?.(this.spawnPoints, this.nextSpawnCost());
    this.drawMap();

    // Instruments. The flight model publishes its whole state as one reused
    // snapshot, so the panel is fed from that rather than from a hand-picked
    // nine fields — the two names the HUD spells differently are mapped here,
    // and the rest rides along for whatever the panel grows next.
    if (showing) {
      const x = this._airExtra;
      const st = typeof p.flightStatus === 'function' ? p.flightStatus() : null;
      if (st) {
        x.vspeed = st.climb;
        x.fuel = p.spec.fuelCapacity > 0 ? st.fuel : null;
        x.engineTemp = st.engineTemp;
        x.wep = st.wep;
        x.gload = st.gLoad;
        x.flaps = st.flaps;
        x.gear = st.gear;
        x.airbrake = st.airbrake;
        // vStall moves with flaps, altitude and wing damage, so the warning is
        // measured against what the wing will actually do right now rather
        // than against the number on the spec sheet
        x.stalled = st.stalled || st.spinning || st.speed < st.stallSpeed * 1.05;
        // The airspeed tape reads INDICATED airspeed, like the real dial: the
        // gear limit the aeroplane quotes ("comes down below 152 km/h") and the
        // stall it warns of are both indicated figures, so the number on the
        // tape has to be the same kind or the pilot cannot fly to them.
        // (display km/h: planes.js displaySpeedKmh, the one scale every
        // airspeed the player reads goes through)
        x.ias = displaySpeedKmh(st.ias);
        x.stallSpeed = displaySpeedKmh(st.stallIas);
        x.wepLock = st.wepLock;
        x.mach = st.mach;
        x.radiator = st.radiator;
        x.aoa = st.aoa;
        x.slip = st.slip;
        // Undercarriage state for a gear indicator: the lever, where the legs
        // are, held by overspeed, the limit in tape units, how far over the
        // extended limit, torn off; and whether the wheels are on the ground
        // with the brakes on. hud.js may draw any of these; none is required.
        x.gearPos = st.gearPos;
        x.gearHeld = st.gearHeld;
        x.gearLimit = st.gearLimitKmh;
        x.gearOver = st.gearOver;
        x.gearGone = st.gearGone;
        x.onGround = st.onGround;
        x.wheelBrake = st.wheelBrake;
      } else {
        x.vspeed = p.vel.y;
        x.fuel = p.spec.fuelCapacity > 0 ? p.fuel / p.spec.fuelCapacity : null;
        x.engineTemp = p.engineTemp;
        x.wep = p.wep;
        x.gload = p.gLoad;
        x.flaps = p.flaps;
        x.gear = p.gear;
        x.airbrake = p.airbrake;
        x.stalled = p.stalled || p.spinning;
      }
      hud.setAirPanel(hud.buildPlaneAirPanel(p, x));
    } else {
      hud.setAirPanel(null);
    }
    hud.setDamagePanel(showing ? this.damagePanelData(p) : null);
    hud.setAmmoPanel(null);
    hud.setBlackout(p.redout > 0.01 ? p.redout : p.blackout, p.redout > 0.01);
    hud.setPenIndicator(null);
    hud.setReload(1, false);

    // bomb sight: predicted impact point of a drop right now
    if (p.alive && p.bombs > 0 && this.bombManager.predictImpact(p, tmpV2)) {
      const bp = tmpV2.project(this.camera);
      const visible = bp.z < 1 && Math.abs(bp.x) < 1 && Math.abs(bp.y) < 1;
      hud.setMarker(
        'bombsight', 'bomb',
        (bp.x * 0.5 + 0.5) * window.innerWidth,
        (-bp.y * 0.5 + 0.5) * window.innerHeight,
        '', visible,
      );
    } else {
      hud.setMarker('bombsight', '', 0, 0, '', false);
    }

    // where the nose actually points (plane lags behind the mouse). In the
    // cockpit the collimated reflector sight is the gun marker (H-03): it
    // goes where the gun line at infinity projects through the final, shaken
    // camera, so it cannot leave the guns.
    if (p.alive && this.cockpit) {
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
      const proj = tmpV.copy(p.position).addScaledVector(p.dir, 500).project(this.camera);
      hud.setGunMarker(
        (proj.x * 0.5 + 0.5) * window.innerWidth,
        (-proj.y * 0.5 + 0.5) * window.innerHeight,
        proj.z < 1,
      );
    } else {
      hud.setReflectorSight?.(0, 0, false);
      hud.setGunMarker(0, 0, false);
    }
    // where the mouse is flying it: a white ring on the instructor's aim point
    if (p.alive) {
      const ap = this.planeCam.aimPoint(p, 600, tmpV).project(this.camera);
      hud.setMouseAim(
        (ap.x * 0.5 + 0.5) * window.innerWidth,
        (-ap.y * 0.5 + 0.5) * window.innerHeight,
        ap.z < 1,
      );
    } else {
      hud.setMouseAim(0, 0, false);
    }

    hud.setScoreboard(input.down('Tab') ? this.scoreboardData() : null);
    this.updateMarkers();
    updateEngineSound(
      Math.min(1, p.throttle * (p.wep ? 1.12 : 1)),
      p.speed / p.spec.maxSpeed,
      p.alive,
      'plane',
    );
  }

  objectiveLine() {
    const mine = this.depots[0];
    const theirs = this.depots[1];
    if (theirs && !theirs.alive && mine && mine.alive) return 'Enemy depot destroyed — hunt the squadron';
    if (mine && !mine.alive) return 'Our depot is gone — destroy theirs to even it up';
    const p = this.player;
    if (p.alive && p.serviceFrac > 0 && p.serviceFrac < 1) return 'Servicing — hold position';
    if (p.alive && p.onGround) {
      if (p.serviceFrac >= 1) return 'Serviced — line up, full throttle, and take off';
      if (p.speed > 1.5) return 'Brakes (B) — stop on your own field to be serviced';
      const field = airfieldAtPoint(p.position.x, p.position.z);
      if (!field || field.team !== p.team) return 'Not on your own field — no ground crew here';
    }
    if (p.alive && (p.hp < p.spec.hp * 0.4 || p.ammo <= 0)) {
      return 'Land on your strip to repair and rearm';
    }
    return 'Destroy the enemy squadron and their depot';
  }

  compassMarkers() {
    const p = this.player;
    const marks = this._compassMarks;
    const enemy = this.depots[1];
    const home = homeAirfield(this.airfields, p.team);
    marks[0].bearing = enemy && enemy.alive
      ? Math.atan2(enemy.position.x - p.position.x, enemy.position.z - p.position.z)
      : null;
    marks[1].bearing = Math.atan2(home.x - p.position.x, home.z - p.position.z);
    return marks; // a null bearing is skipped by the tape, not drawn at zero
  }

  // The airframe, station by station. Built once and mutated afterwards: the
  // HUD only rebuilds its DOM when the roster changes, and it should not be
  // handed a freshly allocated roster sixty times a second.
  damagePanelData(p) {
    let d = this._dmgData;
    if (!d) {
      d = this._dmgData = {
        kind: 'plane',
        name: p.spec.name,
        hull: 1,
        turret: 'ok',
        crew: [{ role: 'Pilot', state: 'ok' }],
        modules: [
          { key: 'engine', label: 'Engine', state: 'ok' },
          { key: 'radiator', label: 'Oil cooler', state: 'ok' },
          { key: 'wings', label: 'Wings', state: 'ok' },
          { key: 'elevator', label: 'Elevator', state: 'ok' },
          { key: 'rudder', label: 'Rudder', state: 'ok' },
          { key: 'tail', label: 'Tail', state: 'ok' },
          { key: 'controls', label: 'Controls', state: 'ok' },
          { key: 'fuel', label: 'Fuel', state: 'ok', text: '' },
        ],
        // A pilot has no repair crew and no medic — he has bottles, and a fire
        // he cannot beat out is the way most of these aeroplanes end. The row
        // is allocated once and its count mutated, because the HUD rebuilds its
        // charges strip whenever the key list changes underneath it.
        consumables: [{ key: 'fpe', label: 'FPE', hint: 'F', count: 0 }],
        fire: false,
        fireSeconds: 0,
        repairing: false,
        repairFrac: 0,
      };
    }
    const st = (frac) => (frac > 0.7 ? 'ok' : frac > 0 ? 'damaged' : 'destroyed');
    const wings = Math.min(p.partFrac('leftWing'), p.partFrac('rightWing'));
    const surf = Math.min(p.partFrac('aileronL'), p.partFrac('aileronR'));
    const m = d.modules;
    d.name = p.spec.name;
    d.hull = clamp(p.hp / p.spec.hp, 0, 1);
    d.turret = p.ripped ? 'destroyed' : st(wings);
    d.crew[0].state = p.pilotOut ? 'destroyed' : p.blackout > 0.5 ? 'damaged' : 'ok';
    m[0].state = st(p.partFrac('engine'));
    m[1].state = st(p.partFrac('oilCooler'));
    m[2].state = p.ripped ? 'destroyed' : st(wings);
    m[3].state = st(p.partFrac('elevator'));
    m[4].state = st(p.partFrac('rudder'));
    m[5].state = st(p.partFrac('tail'));
    m[6].state = st(Math.min(p.partFrac('controls'), surf));
    m[7].state =
      p.fuel <= 0 ? 'destroyed' : p.fuelLeak > 0 ? 'damaged' : st(p.partFrac('fuelTank'));
    m[7].text = `${Math.round((p.fuel / Math.max(1, p.spec.fuelCapacity)) * 100)}%`;
    // the flight model publishes the bottle count in its own snapshot, so the
    // panel reads it from there rather than reaching past it into the field
    const snap = typeof p.flightStatus === 'function' ? p.flightStatus() : null;
    const bottles = snap && snap.extinguishers != null ? snap.extinguishers : p.extinguishers;
    d.consumables[0].count = Math.max(0, Math.round(bottles || 0));
    d.fire = !!p.burning;
    d.fireSeconds = p.burnTimer;
    d.repairing = !!p.onGround && p.serviceFrac > 0 && p.serviceFrac < 1;
    d.repairFrac = p.serviceFrac;
    return d;
  }

  drawMap() {
    const p = this.player;
    const units = this._mapUnits;
    units.length = 0;
    for (const pl of this.planes) {
      if (!pl.alive) continue;
      if (this.realistic && pl.team !== p.team && pl !== p) continue;
      units.push(pl);
    }
    for (const g of this.groundUnits) {
      if (!g.alive || g.isBase) continue;
      if (this.realistic && g.team !== p.team && !g.isColumn) continue;
      units.push(g);
    }

    // the two depots are the map's real furniture: ownership fill plus a ring
    // that reads as remaining integrity
    for (let i = 0; i < 2; i++) {
      const d = this.depots[i];
      const z = this._zones[i];
      if (!d) continue;
      z.x = d.position.x;
      z.z = d.position.z;
      z.owner = d.alive ? d.team : -1;
      z.progress = (d.team === 0 ? -1 : 1) * d.hpFrac * 100;
      z.label = d.team === 0 ? 'A' : 'B';
    }
    this._cone.yaw = this.viewYaw();
    this._cone.fov = ((this.fov * Math.PI) / 180) * 1.4;
    this._cone.range = this.zoom ? 1200 : 620;
    this.hud.drawMinimap(units, p, -1, false, AIR_WORLD, this._mapOpts);
  }

  updateMarkers() {
    const hud = this.hud;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const p = this.player;

    for (const plane of this.planes) {
      // ids and labels are cached on the aeroplane: building two template
      // strings per aircraft per frame was a steady trickle of garbage
      const id = plane._mkId || (plane._mkId = `t${plane.id}`);
      const leadId = plane._leadId || (plane._leadId = `lead${plane.id}`);
      if (!plane.alive || plane === p) {
        hud.setMarker(id, '', 0, 0, '', false);
        hud.setMarker(leadId, '', 0, 0, '', false);
        continue;
      }
      // realistic: enemy planes carry no markers
      if (this.realistic && plane.team !== p.team) {
        hud.setMarker(id, '', 0, 0, '', false);
        hud.setMarker(leadId, '', 0, 0, '', false);
        continue;
      }
      const wp = tmpV.copy(plane.position);
      wp.y += 6;
      const dist = p.position.distanceTo(plane.position);
      const proj = wp.project(this.camera);
      const onScreen = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
      if (onScreen && dist < 1700) {
        const cls = plane.team === p.team ? 'ally' : 'enemy';
        const arrow = cls === 'enemy' ? '▼' : '▽';
        const shown = Math.round(dist);
        if (plane._mkDist !== shown) {
          plane._mkDist = shown;
          plane._mkHtml = `<span class="arrow">${arrow}</span>${shown}m`;
        }
        hud.setMarker(
          id, cls,
          (proj.x * 0.5 + 0.5) * w,
          (-proj.y * 0.5 + 0.5) * h,
          plane._mkHtml,
          true,
        );
      } else {
        hud.setMarker(id, '', 0, 0, '', false);
      }

      // lead circle: arcade only, and it sits at the convergence solution
      if (!this.realistic && p.alive && plane.team !== p.team && dist < 700) {
        const tof = dist / p.spec.gun.speed;
        const lead = tmpV2
          .copy(plane.position)
          .addScaledVector(plane.dir, plane.speed * tof);
        lead.y += 0.5 * 3 * tof * tof;
        const lp = lead.project(this.camera);
        const leadVisible = lp.z < 1 && Math.abs(lp.x) < 1 && Math.abs(lp.y) < 1;
        hud.setMarker(
          leadId, 'lead',
          (lp.x * 0.5 + 0.5) * w,
          (-lp.y * 0.5 + 0.5) * h,
          '',
          leadVisible,
        );
      } else {
        hud.setMarker(leadId, '', 0, 0, '', false);
      }
    }

    // ground objectives get a marker of their own so a bomber can find them
    for (const d of this.depots) {
      const id = `depot${d.team}`;
      if (!d.alive) {
        hud.setMarker(id, '', 0, 0, '', false);
        continue;
      }
      const wp = tmpV.copy(d.position);
      wp.y += 12;
      const dist = p.position.distanceTo(d.position);
      const proj = wp.project(this.camera);
      const visible = proj.z < 1 && Math.abs(proj.x) < 1.05 && Math.abs(proj.y) < 1.05;
      hud.setMarker(
        id,
        d.team === p.team ? 'ally' : 'enemy',
        (proj.x * 0.5 + 0.5) * w,
        (-proj.y * 0.5 + 0.5) * h,
        `<span class="arrow">◆</span>${Math.round(d.hpFrac * 100)}% · ${Math.round(dist)}m`,
        visible && dist < 2400,
      );
    }
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    resetAudio();
    this.bullets.dispose();
    this.bombManager.dispose();
    for (const g of this.groundUnits) g.dispose();
    for (const plane of this.planes) {
      removeEngine(`p${plane.id}`);
      plane.dispose();
    }
    if (this.wrecks) {
      for (const w of this.wrecks) {
        removeEngine(`p${w.id}`);
        w.dispose();
      }
    }
    // Before the scene traverse below: the airfield's materials come from the
    // shared, cached procedural factory, and the traverse would dispose them
    // out from under the next battle. dispose() detaches the group first, so
    // the traverse never sees them.
    disposeAirfields(this.airfields);
    this._afCtx = null;
    this.effects.clearSmokeScreens();
    // the scenery keeps its own buffers and a reference to our effects system;
    // both outlive the scene graph unless it is told to let go
    if (typeof disposeScenery === 'function') disposeScenery();
    // ...and its keep-out list, which is module state that survives both
    // disposeScenery() and the next setupEnvironment()
    if (typeof clearKeepOuts === 'function') clearKeepOuts();
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
    this.hud.setAirPanel(null);
    this.hud.setDamagePanel(null);
    this.hud.setMatchInfo(null);
    this.hud.setCompass(null);
    this.hud.setSpawnPoints?.(null);
    this.hud.setBlackout(0);
    this.hud.setBigMap(false);
  }
}
