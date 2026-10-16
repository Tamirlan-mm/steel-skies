import * as THREE from 'three';
import { isSharedResource } from '../core/materials.js';
import { buildTerrain, terrainHeight, setTerrainSeed, WORLD_SIZE } from '../world/terrain.js';
import * as terrainNS from '../world/terrain.js';
import {
  setupEnvironment, disposeScenery, damagePropsAt, crushProps,
  propBlocksLine, clearKeepOuts, solidPushOut,
} from '../world/scenery.js';
import { randomPreset, MAP_PRESETS } from '../world/presets.js';
import { Tank } from '../vehicles/tankEntity.js';
// The penetration forecast is a wave-2 addition to tankEntity.js. A namespace
// import survives its absence; a named one would fail to link.
import * as tankNS from '../vehicles/tankEntity.js';
import { TANK_SPECS, shellPenAt, surfaceProps } from '../vehicles/tanks.js';
import { ShellManager, intersectTanks, clipRayToScenery, barrelIntoWall } from '../combat/ballistics.js';
import { BulletManager } from '../combat/bullets.js';
import { Effects } from '../combat/effects.js';
import { CameraShake } from '../combat/shake.js';
import { heFillerKg, BLAST_KG } from '../combat/blast.js';
import { TankAI, hasLOS, notifyObjectivesChanged } from '../ai/tankAI.js';
import { input } from '../core/input.js';
import {
  sfx, sfx3d, updateEngineSound, updateEngine, removeEngine,
  setListener, radioCue, updateAudio, resetAudio, setVolumes,
} from '../core/audio.js';
import { applyMods } from './mods.js';
import { progress, planBattle, REWARD, DIFFICULTY_MULT } from './progress.js';
import { XrayView } from '../ui/xray.js';
// K-04: the real gunner's sight per vehicle, its detents and labels
import { opticSteps } from '../ui/hud.js';
import { clamp, lerp, rand, wrapAngle } from '../core/utils.js';

const TICKETS_MAX = 2100;
const KILL_COST = 70;
const RESPAWN_COST = 150;
const MATCH_TIME = 20 * 60;

// Domination layout. The three points are placed symmetrically about the world
// origin, which is also the point reflection that maps one spawn onto the
// other — so neither team is nearer to any of them. A is the flat middle the
// heightmap already levels off, B and C sit out on the flanks where a light
// tank can get to them first and a heavy cannot.
const ZONE_LAYOUT = [
  { key: 'A', x: 0, z: 0, r: 26 },
  { key: 'B', x: -70, z: -200, r: 23 },
  { key: 'C', x: 70, z: 200, r: 23 },
];
const CAP_RATE = 13;          // capture % per second for one vehicle in the ring
const CAP_DECAY = 0.35;       // how fast an abandoned capture bar runs back down
const BLEED_PER_ZONE = 3.4;   // tickets a second the enemy loses for each point held
const CAP_TICKET_BONUS = 60;  // one-off ticket punch for taking a point

// Spotting. In realistic an enemy carries no marker until somebody on the team
// actually sees him, so these are the numbers that decide whether you are being
// looked at or merely looked toward.
const SPOT_BASE = 420;        // metres a quiet, stationary vehicle is picked out at
const SPOT_MEMORY = 2.4;      // seconds a mark survives after line of sight is lost
const MARK_FADE = 4;          // H-06: then the HUD marker decays (dimmed) this long more
const SPOT_ALLY_RANGE = 300;  // allies report what they see, but only close in
const SCOUT_RANGE = 540;
const SCOUT_DURATION = 20;
const SCOUT_COOLDOWN = 12;

// Artillery. Long cooldown, few charges, and a delay long enough that a moving
// target simply drives out of it — it is an area-denial weapon, not a sniper.
const ARTY_DELAY = 9;
const ARTY_COOLDOWN = 75;
const ARTY_SHELLS = 16;
const ARTY_SPREAD = 34;       // metres the barrage is scattered over
const ARTY_RADIUS = 11;       // blast radius of one shell
const ARTY_MIN_RANGE = 90;    // no calling it down on your own hull

// Damage points, in the currency progress.settle() prices at REWARD.damage.
// Deliberately smaller than the per-kill award: damage is what pays for a
// battle where you softened everything up and somebody else finished it.
//
// F4: one whole vehicle taken apart is DMG_PEN + DMG_KILL — creditHit pays the
// penetration and onTankKilled pays the kill for the same killing round — which
// is 85 before the crew and module bonuses lift a real takedown to roughly a
// hundred. combinedBattle.js spends the same four numbers and names that sum
// DMG_VEHICLE, so the two files already agree and neither needs adjusting.
const DMG_PEN = 25;
const DMG_MODULE = 15;
const DMG_CREW = 20;
const DMG_KILL = 60;

// Destructible scenery. The numbers are read against the prop hit points
// scenery.js hands out: a tree is 26-60, a fence 14, a house 520 and up, and a
// rock is invulnerable — so a shell fells what it clips, chips at a house and
// stops dead against stone, and a hull shoves anything light flat.
const PROP_HULL_FORCE = 45;   // crush mass a moving tank pushes aside
const PROP_BLAST_DMG = 12;    // blast damage per metre of radius, at the centre
const PROP_CRUSH_PERIOD = 0.2;

// Time on the battlefield is itself worth spawn points. progress.spawnPointsFor
// rounds its answer, so the accrual is paid out in quarter-minute slices: at
// SPAWN_AWARDS.perMinute that is a whole number of points every time and the
// budget never drifts the way a rounded per-frame fraction would.
const SP_SLICE_MINUTES = 0.25;
const SP_SLICE_SECONDS = SP_SLICE_MINUTES * 60;

// Firm going, for a surface record built before terrain.js has classified the
// square under the tracks.
const SURF_BASE_DRAG = 0.06;

const SCOUT_SILVER = 90;
const SCOUT_RP = 30;
const SCOUT_ASSIST_SILVER = 130;
const SCOUT_ASSIST_RP = 45;
const CAP_TICK_SILVER = 22;

const ZONE_COLOR = { ally: 0x5f9fdf, enemy: 0xdf6a5f, neutral: 0xe8d080 };

// How opaque the smoke between the player and an enemy has to be drawn before
// nothing on the HUD may point at him (effects.smokeOpacityAlong, 0..1; a line
// the game calls blind is drawn at 0.95 or more). A hull already two-thirds
// gone into a screen is not a contact worth a marker, a minimap dot or a
// penetration verdict: the HUD must never be what shows the player where the
// smoke is hiding somebody.
const SMOKE_HIDE = 0.6;
const ROLE_LABEL = {
  driver: 'Driver', gunner: 'Gunner', loader: 'Loader',
  commander: 'Commander', radio: 'Radio',
};
const roleLabel = (role) => ROLE_LABEL[role] || role;

// Crew contract (tankEntity.js): staffed(role) says a living man is actually
// sitting in the seat, not climbing across into it. Guarded so a Tank built
// before those methods existed still answers sensibly.
function seatStaffed(tank, role) {
  if (typeof tank.staffed === 'function') return tank.staffed(role);
  if (role === 'driver') return tank.canDrive !== false;
  const st = tank.crewStations;
  if (!tank.crewAlive || !st || !st.includes(role)) return true;
  return tank.crewAlive[role] > 0;
}
function canFireStream(tank) {
  if (typeof tank.canFireStream === 'function') return tank.canFireStream();
  return !!tank.alive && seatStaffed(tank, 'gunner') && tank.streamAmmo > 0;
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
// Spotting runs inside the per-frame loops that already own tmpV*, so it keeps
// its own pair rather than trusting the call order not to change.
const spotEye = new THREE.Vector3();
const spotAt = new THREE.Vector3();
// and the smoke verdict (smokeHidden) its own pair as well: it is asked from
// inside the marker and minimap loops
const smokeEye = new THREE.Vector3();
const smokeAt = new THREE.Vector3();
const artyV = new THREE.Vector3();
// Reused by the hull's scenery shove: scenery.js keeps none of the option
// objects it is handed.
const scenCrushOpts = { force: PROP_HULL_FORCE, dirX: 0, dirZ: 0 };
// Houses and boulders are walls to a hull (pushTanksOutOfScenery): the hull is
// three discs along its centreline, each its half-width across, and the push
// for each comes back in hullShove.
const hullDisc = new THREE.Vector4();
const hullShove = new THREE.Vector3();

// tankEntity.js looks its physics row up by the surface NAME. A record that
// stringifies to that name therefore indexes the table exactly as the bare
// string did, while carrying the live grip and drag alongside for a drivetrain
// that reads them. Shared by every vehicle's record — it closes over nothing.
function surfaceName() {
  return this.type;
}

export class Battle {
  constructor(renderer, playerSpecId, hud, onEnd) {
    this.renderer = renderer;
    this.hud = hud;
    this.onEnd = onEnd;
    this.finished = false;
    this.startSpecId = playerSpecId;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      60, window.innerWidth / window.innerHeight, 0.3, 2500,
    );

    setTerrainSeed(rand(-3000, 3000), rand(-3000, 3000));
    const preset = randomPreset();
    this.preset = preset;
    // the drivetrain wants the preset's id, not its display name, and the dust
    // wants its ground tint — both are read straight off the table
    this.surfaceKey =
      Object.keys(MAP_PRESETS).find((k) => MAP_PRESETS[k] === preset) || 'firm';
    this.dustColor = preset.low != null ? preset.low : 0x9a8a68;
    // terrain.js may or may not have grown per-square surfaces yet; feature-
    // detect once instead of guarding every call site
    this.terrainSurface =
      typeof terrainNS.terrainSurface === 'function' ? terrainNS.terrainSurface : null;
    this.scene.add(buildTerrain(WORLD_SIZE, 130, preset));
    // the effects pool has to exist before the scenery does: felling a tree
    // throws splinters, and scenery.js only calls the hook it was handed here
    this.effects = new Effects(this.scene);
    // F6: the handle carries far more than the sun — the live list of solid
    // props, and the same sight/destruction helpers this file imports by name.
    // Throwing it away was what left spotting able to see through a farmhouse.
    // keepOutDiscs is module state in scenery.js and neither disposeScenery()
    // nor setupEnvironment() empties it, so an airfield fenced off by a battle
    // earlier in this session would still be starving this map's prop scatter.
    // The ground battle has no airfield of its own; it just wants a clean slate.
    clearKeepOuts();
    this.scenery = setupEnvironment(this.scene, { preset, effects: this.effects });
    this.sun = this.scenery.sun;
    // Live array: fellProp splices an entry out the moment the wall it belongs
    // to comes down, so an empty list means there is genuinely nothing standing
    // that could block a sight line and the grid query can be skipped entirely.
    this.blockers = this.scenery.blockers || [];
    // wave-2 addition to tankEntity.js: the same plate maths applyHit runs, so
    // the HUD indicator and the damage model can never disagree again
    this.penForecast =
      typeof tankNS.penetrationForecast === 'function' ? tankNS.penetrationForecast : null;
    // shells draw through the effects' tracer law (X-04): no mesh per shell
    this.shellMgr = new ShellManager(this.scene, this.effects);
    this.bullets = new BulletManager(this.scene);
    this.shake = new CameraShake();
    const shakeScale = progress.getSetting ? progress.getSetting('shakeScale') : 1;
    if (shakeScale != null) this.shake.setScale(clamp(Number(shakeScale), 0, 1));
    this.showDamageLog =
      progress.getSetting ? progress.getSetting('showDamageLog') !== false : true;
    if (setVolumes && progress.settings) {
      setVolumes({
        master: progress.settings.masterVolume,
        effects: progress.settings.effectsVolume,
        engines: progress.settings.engineVolume,
      });
    }

    this.tanks = [];
    this.ais = [];
    this.tickets = [TICKETS_MAX, TICKETS_MAX];
    this.buildZones();
    this.respawnQueue = [];  // { team, specId, timer }
    this.time = 0;
    this.elapsed = 0;
    this.playerKills = 0;
    this.playerAssists = 0;
    this.playerGroundKills = 0; // this mode fields no soft targets; kept for main.js
    this.playerHits = 0;
    this.playerCaps = 0;
    this.playerScouts = 0;
    this.playerDamage = 0;
    this.playerSpawnsUsed = 0;
    this.playerCapTicks = 0;
    this.earnedSilver = 0;
    this.earnedRp = 0;
    this.burnEmit = 0;
    // realistic difficulty: friendly fire on, no free markers, spotting matters
    this.realistic = progress.getDifficulty() === 'realistic';
    this.spectate = false;
    this.stats = new Map(); // scoreboard: name -> { kills, deaths, ... }
    this.bailTimer = 0;
    this.bailMsgCd = 0;
    this.deathCamKiller = null;
    this.deathCamAngle = 0;
    // X-ray hit camera, shown picture-in-picture on the left (main.js renders it)
    this.pip = { active: false, timer: 0 };
    this.xray = new XrayView();

    // ---- economy bookkeeping the results screen settles ----
    this.usage = [];      // one record per vehicle the player has spawned
    this.losses = [];     // spec ids of the player's vehicles destroyed
    this.awardsEarned = [];
    this.streak = 0;
    this.firstBlood = false;
    this.firePutOut = false;

    // ---- spotting / scouting / artillery ----
    this.spotted = new Map(); // enemy tank id -> { until, scout, scoutBy }
    this.spotTimer = 0;
    this.scoutCd = 0;
    this.artyCd = 0;
    this.artyCharges = 2;
    this.artyStrike = null;
    this.repairKeyHeld = false;
    this.msgCd = 0;
    this.rumbleT = 0;
    this.capTickT = 0;
    this.spTimeT = 0;

    // camera state
    this.camYaw = Math.PI;   // player spawns facing +Z? set after spawn
    this.camPitch = -0.1;
    this.camDist = 14;
    this.sniper = false;
    this.sniperFov = 16;
    this.fov = 60;

    // BR-matched rosters: the enemy team is drawn against what the player
    // actually brought instead of the same four tanks every battle
    const plan = planBattle({ mode: 'ground', kind: 'ground', playerSpecId });
    this.plan = plan;
    this.spawnBudget = plan.spawnBudget;

    // spawn player + allies (team 0) facing the cap, enemies (team 1) opposite
    this.player = this.spawnTank(playerSpecId, 0, true);
    plan.allies.slice(0, 3).forEach((id, i) => this.spawnTank(id, 0, false, i + 1));
    plan.enemies.forEach((id, i) => this.spawnTank(id, 1, false, i));

    this.camYaw = this.player.yaw;
    this.playerDead = false;
    this.deadTimer = 0;

    // The projectile managers are fed the same option objects and the same
    // callbacks every frame; rebuilding them sixty times a second was pure
    // garbage. `player` is refreshed on respawn, not reallocated.
    this.impactCb = (kind, info) => this.onImpact(kind, info);
    this.bulletHitCb = (g, b, point) => this.onBulletTank(g, b, point);
    const flyby = (k, pos) => sfx3d.flyby(pos, 700);
    this.shellOpts = {
      listenerPos: this.camera.position,
      onFlyby: flyby,
      player: this.player,
    };
    this.bulletOpts = {
      listenerPos: this.camera.position,
      onFlyby: flyby,
      player: this.player,
    };

    // the rich HUD carries its own reload bar inside the ammo stack; the old
    // centre bar is only kept alive for a HUD that predates it
    this.richHud = typeof hud.setAmmoPanel === 'function';
    hud.setReloadVisible(!this.richHud);
    hud.setCrosshairVisible(true);
    hud.setAirPanel?.(null);
    hud.setBlackout?.(0);
    hud.setMatchInfo?.({ mode: 'Ground Domination', timeLeft: MATCH_TIME });
    this.refreshHelp();
  }

  // Whether the vehicle in the player's hands can call the battery at all. The
  // Artillery Support modification is what buys the observer and the radio net
  // behind him; mods.js sets the flag when it is researched and fitted.
  get hasArtillery() {
    return !!(this.player && this.player.spec && this.player.spec.artillerySupport);
  }

  // Rebuilt on every spawn: the lineup can put the player in a vehicle whose
  // modification list is nothing like the last one's, and a key listed in the
  // help panel that answers "not fitted" is worse than no key at all.
  refreshHelp() {
    const arty = this.hasArtillery ? ' · T — artillery' : '';
    this.hud.setHelp(`
      <span>W / S — throttle · A / D — steer · Mouse — aim · LMB — fire</span>
      <span>Space — machine gun · Shift — sniper view · Scroll — zoom</span>
      <span>1 / 2 / 3 — shell types · R (hold) — repair · F — extinguisher</span>
      <span>G — smoke grenade · H — first aid · V — scout${arty}</span>
      <span>M — tactical map · Tab — scoreboard · J (hold) — abandon · Esc — pause</span>
    `);
  }

  // ---------------- capture zones ----------------
  buildZones() {
    this.zones = ZONE_LAYOUT.map((def) => {
      const z = {
        key: def.key,
        x: def.x,
        z: def.z,
        r: def.r,
        owner: -1,       // -1 neutral, 0 allies, 1 enemies
        cap: 0,          // 0..100 toward capTeam
        capTeam: -1,
        allies: 0,
        enemies: 0,
        contested: false,
        pos: new THREE.Vector3(def.x, terrainHeight(def.x, def.z), def.z),
      };
      z.ring = this.makeZoneRing(z, z.r - 1.4, z.r, 0.7);
      z.progressRing = this.makeZoneRing(z, z.r + 0.7, z.r + 2.3, 0.9);
      z.progressRing.visible = false;
      this.scene.add(z.ring, z.progressRing);
      return z;
    });
    // legacy single-point fields, still read by the HUD's five-argument minimap
    // call and by anything that has not been taught about three zones
    this.capOwner = -1;
    this.capProgress = 0;
  }

  // A ring decal that follows the ground instead of hovering over it — B and C
  // sit out on the slopes where a flat disc would sink into the hillside.
  makeZoneRing(zone, inner, outer, opacity) {
    const geo = new THREE.RingGeometry(inner, outer, 64);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const baseY = zone.pos.y;
    for (let i = 0; i < pos.count; i++) {
      const wx = zone.x + pos.getX(i);
      const wz = zone.z + pos.getZ(i);
      pos.setY(i, terrainHeight(wx, wz) - baseY + 0.3);
    }
    pos.needsUpdate = true;
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: ZONE_COLOR.neutral,
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.copy(zone.pos);
    // A ground decal, so it sorts with the other ground decals: before the
    // smoke-screen volume (effects.js draws its core at -2). At 2 it was
    // composited after the smoke whatever the depth, and a capture ring
    // glowed straight through a screen standing on the point.
    mesh.renderOrder = -3;
    return mesh;
  }

  teamSpawnPose(team, slot) {
    const baseX = team === 0 ? -330 : 330;
    const z = -120 + slot * 80 + rand(-15, 15);
    const yaw = team === 0 ? Math.PI / 2 : -Math.PI / 2; // face toward center
    return { x: baseX + rand(-20, 20), z, yaw };
  }

  spawnTank(specId, team, isPlayer, slot = 0) {
    // player vehicles get their purchased modifications and their trained crew
    const spec = isPlayer
      ? applyMods(TANK_SPECS[specId], 'ground', { crew: true })
      : TANK_SPECS[specId];
    const name = isPlayer
      ? `You (${spec.name})`
      : `${team === 0 ? 'Ally' : 'Enemy'} ${spec.name}-${slot + 1}`;
    const tank = new Tank(this.scene, spec, team, name, isPlayer);
    const pose = this.teamSpawnPose(team, isPlayer ? 1.5 : slot);
    tank.setPose(pose.x, pose.z, pose.yaw);
    tank.surface = this.surfaceKey;
    this.tanks.push(tank);
    this.stat(tank);
    if (isPlayer) {
      // the player drives his own repairs from the R key, the AI crews keep
      // fixing their own tracks the way they always did
      tank.autoRepair = false;
      tank.usage = this.beginUsage(tank);
      this.snapshotPlayer(tank);
    } else {
      this.ais.push(new TankAI(tank, this));
    }
    return tank;
  }

  // ---------------- economy bookkeeping ----------------
  // One record per vehicle the player spawns: the shells out of the racks, the
  // belt rounds and the consumables burned. progress.settle() bills all three.
  beginUsage(tank) {
    const c = tank.consumables || {};
    const rec = {
      id: tank.spec.id,
      shells: {},
      stream: 0,
      consumables: { parts: 0, fpe: 0, crew: 0, artillery: 0 },
      base: { repair: c.repair || 0, fpe: c.fpe || 0, firstAid: c.firstAid || 0 },
      tank,
    };
    this.usage.push(rec);
    return rec;
  }

  // Consumables are spent inside the entity (a repair finishing eats a kit), so
  // the bill is read back by difference rather than hooked at every call site.
  // The fire mission is the exception and must stay one: no vehicle field
  // counts it down, so callArtillery() increments the slot where the charge is
  // actually spent — do not add artillery to the difference pass below, it
  // would overwrite that count with a zero.
  syncUsage(tank) {
    const rec = tank && tank.usage;
    if (!rec || !tank.consumables) return;
    const c = tank.consumables;
    rec.consumables.parts = Math.max(0, rec.base.repair - (c.repair || 0));
    rec.consumables.fpe = Math.max(0, rec.base.fpe - (c.fpe || 0));
    rec.consumables.crew = Math.max(0, rec.base.firstAid - (c.firstAid || 0));
  }

  // main.js's settlementFor() reads losses/survived/usage straight off the
  // battle object and only falls back to its own books per missing field, so
  // ground battles were billing maintenance from two ledgers at once. It also
  // reads them on the quit path, where battleResult() never runs — hence a
  // derived list rather than one filled in at the end.
  get survived() {
    return this.player && this.player.alive ? [this.player.spec.id] : [];
  }

  usageForSettle() {
    return this.usage.map((u) => ({
      id: u.id,
      shells: { ...u.shells },
      stream: u.stream,
      consumables: { ...u.consumables },
    }));
  }

  // Silver and RP as they are earned, so the player watches the battle pay for
  // itself. The same events add up into the result object main.js settles.
  reward(silver, rp, showRp = false) {
    const d = DIFFICULTY_MULT[progress.getDifficulty()] || DIFFICULTY_MULT.arcade;
    const s = Math.round(silver * (d.silver || 1));
    const r = Math.round(rp * (d.rp || 1));
    this.earnedSilver += s;
    this.earnedRp += r;
    if (s) this.hud.showReward?.(s, 'SL');
    if (showRp && r) this.hud.showReward?.(r, 'RP');
    return s;
  }

  award(title, subtitle = '') {
    this.awardsEarned.push(title);
    this.hud.showAward?.(title, subtitle);
  }

  spawnPoints() {
    return this.spawnBudget ? Math.max(0, Math.round(this.spawnBudget.points)) : 0;
  }

  spawnCostFor(specId) {
    const b = this.spawnBudget;
    if (!b) return 0;
    return b.spawned.length === 0 ? 0 : progress.spawnCost(specId);
  }

  canSpawnVehicle(specId) {
    const b = this.spawnBudget;
    if (!b) return true;
    return b.points >= this.spawnCostFor(specId);
  }

  // The budget's own spend() also enforces the garage lineup; the respawn
  // screen already decides what the player may take, so this only charges.
  chargeSpawn(specId) {
    const b = this.spawnBudget;
    if (!b) return 0;
    const cost = this.spawnCostFor(specId);
    b.points = Math.max(0, b.points - cost);
    b.spawned.push(specId);
    return cost;
  }

  awardSpawnPoints(events) {
    this.spawnBudget?.award?.(events);
  }

  // F3: main.js used to top the budget up from a running total that included
  // SPAWN_AWARDS.perMinute, and now stands aside for any battle that awards its
  // own points — so the time-based accrual has to live here or a long ground
  // battle simply stops paying for the vehicles it costs you. Paid a slice at a
  // time as the minutes pass, never banked to the end, because the whole point
  // of the budget is the decision it forces while you are still driving.
  updateSpawnIncome(dt) {
    if (!this.spawnBudget) return;
    this.spTimeT += dt;
    while (this.spTimeT >= SP_SLICE_SECONDS) {
      this.spTimeT -= SP_SLICE_SECONDS;
      this.awardSpawnPoints({ minutes: SP_SLICE_MINUTES });
    }
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
        groundKills: 0,
        airKills: 0,
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

  scoreboardData() {
    const allies = [];
    const enemies = [];
    for (const s of this.stats.values()) {
      s.score = s.kills * 100 + s.assists * 40 + s.caps * 60;
      (s.team === 0 ? allies : enemies).push(s);
    }
    const cmp = (a, b) => b.score - a.score || a.deaths - b.deaths;
    allies.sort(cmp);
    enemies.sort(cmp);
    return { allies, enemies };
  }

  requestFire(tank) {
    // an empty gunner's seat is a silent gun (canFire says so too; this is the
    // belt to its braces while the entity side is in flux)
    if (!seatStaffed(tank, 'gunner')) return;
    const desc = tank.tryFire();
    if (!desc) return;
    this.shellMgr.fire(desc);
    const cal = (desc.shell && desc.shell.caliber) || 75;
    if (this.effects.muzzleBlast) {
      this.effects.muzzleBlast(desc.pos, desc.dir, cal, terrainHeight(desc.pos.x, desc.pos.z));
    } else {
      this.effects.muzzleFlash(desc.pos, desc.dir);
    }
    sfx3d.fire(desc.pos, { caliber: cal });
    // firing is the loudest thing a tank does — it makes you visible
    tank.lastFired = this.time;
    if (tank === this.player) {
      this.shake.add(0.16 + cal / 380, 0.45);
      const rec = tank.usage;
      if (rec) rec.shells[desc.type] = (rec.shells[desc.type] || 0) + 1;
    } else {
      this.shake.addAt(0.1 + cal / 500, desc.pos, this.camera.position, 130);
    }
  }

  // ---------------- main update ----------------
  update(dt) {
    if (this.finished) return;
    this.time += dt;
    this.elapsed = this.time;
    // stamps each tank's smoke verdict (smokeHidden) with the frame it was
    // taken in
    this._smokeFrame = (this._smokeFrame || 0) + 1;
    if (this.msgCd > 0) this.msgCd -= dt;
    if (this.scoutCd > 0) this.scoutCd -= dt;
    if (this.artyCd > 0) this.artyCd -= dt;
    this.updateSpawnIncome(dt);

    if (this.player.alive) {
      this.updatePlayerControls(dt);
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
        this.handlePlayerDeath();
      }
    }

    for (const ai of this.ais) ai.update(dt);
    for (const tank of this.tanks) {
      const wasAlive = tank.alive;
      tank.update(dt, this.surfaceFor(tank, dt));
      if (wasAlive && !tank.alive) {
        removeEngine('t' + tank.id);
        // burned out / bled out without a shooter credit
        this.onTankKilled(tank.lastAttacker || null, tank);
      } else if (tank.alive) {
        this.driveVehicleSound(tank, dt);
        this.crushScenery(tank, dt);
      }
      // only the player's crew log is read out; nobody else's may grow forever
      if (tank !== this.player && tank.crewLog && tank.crewLog.length > 32) {
        tank.crewLog.length = 0;
      }
    }

    // player fire input (SPAA fires its stream on LMB instead of shells)
    if (this.player.alive && input.locked && input.fireHeld && !this.player.spec.aa) {
      this.requestFire(this.player);
    }
    this.updateTankStream(dt);

    this.shellMgr.update(dt, this.tanks, this.impactCb, this.shellOpts);
    // (rounds meet the walls, rocks and trees inside ShellManager's own substep
    // loop now, before the tanks — combat/ballistics.js "Scenery in the line
    // of fire" — so there is no frame-boundary scenery sweep here any more)
    this.bullets.update(
      dt, [], null, this.effects, this.tanks, this.bulletHitCb, this.bulletOpts,
    );
    this.resolveTankCollisions();
    this.cleanupWrecks(dt);
    this.updateResupply(dt);
    this.updateBurning(dt);
    this.updateArtillery(dt);
    this.updateSpotting(dt);
    this.watchPlayerState(dt);
    this.effects.update(dt);
    this.updateCapture(dt);
    this.updateRespawns(dt);
    this.updatePip(dt);
    this.shake.update(dt);
    this.updateCamera(dt);
    this.updateHUD(dt);

    // The 3D mix keys off the listener, so it goes last: the camera has been
    // placed, shaken and had lookAt applied by now, and updateMatrixWorld makes
    // sure the forward vector audio derives is this frame's, not last frame's.
    this.camera.updateMatrixWorld();
    setListener(this.camera);
    updateAudio();

    this.checkEnd();

    // The shadow volume follows the viewer, but the sun DIRECTION belongs to
    // the map preset — scenery.js drives updateSunAnchor() from the scene's own
    // onBeforeRender, so writing sun.position here would only throw the time of
    // day away and put a dusk sun at a midday angle.
  }

  // Every living vehicle that is not the player drives a positional engine
  // voice; the player keeps the dedicated non-positional one. Dust is thrown by
  // everybody, the player included.
  driveVehicleSound(tank, dt) {
    const spec = tank.spec;
    if (tank !== this.player) {
      const rpm = tank.rpm != null
        ? tank.rpm
        : Math.min(1, (Math.abs(tank.speed) / (spec.maxSpeed || 12)) * 0.8
          + Math.abs(tank.throttleInput) * 0.35);
      const shifted = tank.audGear !== tank.gear;
      tank.audGear = tank.gear;
      updateEngine('t' + tank.id, {
        pos: tank.position,
        rpm,
        throttle: Math.abs(tank.throttleInput),
        type: 'tank',
        moving: Math.abs(tank.speed) > 0.4,
        shift: shifted && tank.shiftTimer > 0,
      });
    }
    const sn = Math.abs(tank.speed) / (spec.maxSpeed || 12);
    // any motion at all: the dust gates itself on speed, the track prints
    // (X-07: yaw, gauge, track width) are laid at a crawl too
    if (sn > 0.004) {
      this.effects.trackDust?.(tmpV.copy(tank.position), sn, tank.dustTint || this.dustColor, dt,
        tank.yaw, tank.trackGauge, tank.trackWidth);
    }
    // AV-04: the exhaust coughs on the frame of the rev event — the same
    // gear change the engine voice above was told about
    if (tank.revKick && this.effects.exhaustPuff && tank.exhaustWorld) {
      this.effects.exhaustPuff(tank.exhaustWorld(tmpV), tank.engineKind, tank.revKick);
    }
  }

  // A hull shoves the light scenery flat — saplings and fences go over, stone
  // and masonry do not. The grid query is cheap, but there is still no point
  // running it for sixteen vehicles every frame: nothing a tank can flatten
  // gets out of the way inside a fifth of a second.
  crushScenery(tank, dt) {
    if (Math.abs(tank.speed) < 0.5) return;
    tank.crushT = (tank.crushT || 0) - dt;
    if (tank.crushT > 0) return;
    tank.crushT = PROP_CRUSH_PERIOD;
    const fwd = tank.speed < 0 ? -1 : 1;
    scenCrushOpts.dirX = Math.sin(tank.yaw) * fwd;
    scenCrushOpts.dirZ = Math.cos(tank.yaw) * fwd;
    crushProps(tank.position.x, tank.position.z, (tank.radius || 2) * 0.9, scenCrushOpts);
  }

  // C2: terrain.js may expose per-square surfaces. Sampling it every frame for
  // sixteen vehicles is wasted work — the ground under a tank does not change
  // twice a second — so each vehicle caches its own and re-samples on a timer.
  surfaceFor(tank, dt) {
    if (!this.terrainSurface) return this.surfaceKey;
    tank.surfT = (tank.surfT || 0) - dt;
    if (tank.surfT <= 0) {
      tank.surfT = 0.5;
      // terrainSurface writes into a module-scope scratch record unless it is
      // handed somewhere to write, and this one is kept across frames
      const s = this.terrainSurface(
        tank.position.x, tank.position.z, tank.surfSample || (tank.surfSample = {}),
      );
      if (s) {
        tank.surface = s.type || this.surfaceKey;
        if (s.dustColor != null) tank.dustTint = s.dustColor;
        this.describeSurface(tank, s);
      }
    }
    return tank.surfaceInfo || tank.surface || this.surfaceKey;
  }

  // F5: the grip and rolling drag terrain.js measures under the tracks used to
  // die here — only the type name and the dust tint ever reached the vehicle,
  // so a battle fought in the rain drove exactly like a dry one.
  //
  // The physics rows in tanks.js stay authoritative for a named surface (their
  // own table says so when the two disagree), but they cannot know about the
  // weather, which is where the preset's grip multiplier lives. Dividing the
  // terrain's grip back through its own unmodified row leaves exactly that
  // multiplier, and it lands on the two numbers a greasy field actually spoils:
  // what the tracks can put down, and what they can steer with.
  describeSurface(tank, s) {
    const base = surfaceProps(s.type);
    const table = terrainNS.SURFACE_TABLE ? terrainNS.SURFACE_TABLE[s.type] : null;
    const weather = table && table.grip && s.grip != null
      ? clamp(s.grip / table.grip, 0.5, 1.2)
      : 1;
    let rec = tank.surfaceInfo;
    if (!rec) {
      rec = tank.surfaceInfo = {
        type: this.surfaceKey, grip: 1, drag: SURF_BASE_DRAG,
        top: 1, steer: 1, roll: 1, toString: surfaceName,
      };
    }
    rec.type = s.type || this.surfaceKey;
    rec.drag = s.drag != null ? s.drag : SURF_BASE_DRAG;
    rec.grip = base.grip * weather;
    rec.steer = base.steer * weather;
    rec.top = base.top;
    rec.roll = base.roll;
    return rec;
  }

  updatePlayerControls(dt) {
    const p = this.player;

    // camera orbit from mouse; sensitivity scales down when zoomed in
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
    // in the optics there is no auto-compensation — hold over with the marks
    p.manualAim = this.sniper;

    this.updateConsumables(dt);

    // drive (increasing yaw turns left on screen, so A is +1)
    p.throttleInput = (input.down('KeyW') ? 1 : 0) + (input.down('KeyS') ? -1 : 0);
    p.steerInput = (input.down('KeyA') ? 1 : 0) + (input.down('KeyD') ? -1 : 0);

    // aim ray from camera through screen center
    const dir = tmpV.set(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * Math.cos(this.camPitch),
    );
    const origin = tmpV2.copy(this.camera.position);
    const end = tmpV3.copy(origin).addScaledVector(dir, 1400);
    // A wall or a rock under the reticle ends the ray on its face, so the gun
    // converges on the house the player is looking at instead of on a tank
    // (or the field) behind it. Only past the hull: the chase camera may be
    // sitting behind a house the gun itself is clear of.
    clipRayToScenery(origin, end, p.position);
    const rayLen = origin.distanceTo(end);

    // nearest tank under the reticle, else terrain, else the wall or far point
    this.aimTarget = intersectTanks(this.tanks, origin, end, p);
    // A hull inside a smoke screen is not "under the reticle": the ray finds
    // it straight through the cloud, and the penetration verdict, the
    // rangefinder and the gun marker settling onto it were the HUD drawing the
    // player a picture of a tank the screen was hiding. The aim falls through
    // to the ground behind, exactly as if the smoke were solid.
    if (this.aimTarget && this.smokeVeils(origin, this.aimTarget.hit.point)) {
      this.aimTarget = null;
    }
    if (this.aimTarget) {
      p.aimPoint.copy(this.aimTarget.hit.point);
    } else {
      let hitGround = false;
      const steps = Math.max(8, Math.ceil((240 * rayLen) / 1400));
      for (let i = 1; i <= steps; i++) {
        const t = (i / steps) * rayLen;
        const px = origin.x + dir.x * t;
        const py = origin.y + dir.y * t;
        const pz = origin.z + dir.z * t;
        if (py <= terrainHeight(px, pz)) {
          p.aimPoint.set(px, terrainHeight(px, pz) + 0.2, pz);
          hitGround = true;
          break;
        }
      }
      if (!hitGround) p.aimPoint.copy(end);
    }
    this.aimDist = p.position.distanceTo(p.aimPoint);

    // a continuous low rumble over rough ground: not an event, just the ride
    this.rumbleT -= dt;
    if (this.rumbleT <= 0) {
      this.rumbleT = 0.14;
      const sn = Math.min(1, Math.abs(p.speed) / (p.spec.maxSpeed || 12));
      if (sn > 0.08) {
        const rough = Math.min(1, Math.abs(p.hullPitchRate || 0) * 1.6 + sn * 0.5);
        this.shake.add(0.016 + 0.05 * rough * sn, 0.16);
      }
    }
  }

  // Short throttled line for the things the player does rather than suffers.
  notify(text, severity = 'info') {
    if (this.hud.incomingMessage) this.hud.incomingMessage(text, severity);
    else this.hud.hitMessage(text, severity === 'critical' ? 'bad' : 'good');
  }

  // ---------------- consumables, scouting, artillery ----------------
  updateConsumables(dt) {
    const p = this.player;

    // R held keeps the crew on the job; letting go or driving off stops them.
    // The entity cancels the repair every frame the vehicle is rolling, so the
    // restart below must not announce itself again each time it does.
    const repairHeld = input.down('KeyR');
    if (repairHeld) {
      if (!p.repairing) {
        if (p.startRepair?.()) {
          if (p.repairTarget !== this.repairMsgFor) {
            this.repairMsgFor = p.repairTarget;
            this.notify(`Repairing ${this.moduleLabel(p.repairTarget)}…`, 'info');
          }
        } else if (this.msgCd <= 0) {
          this.msgCd = 1.4;
          this.notify('Nothing to repair', 'info');
        }
      }
      if (p.repairInterrupt === 'moving' && this.msgCd <= 0) {
        this.msgCd = 2.2;
        this.notify('Stop the vehicle to work on it', 'warn');
      }
    } else {
      if (this.repairKeyHeld && p.repairing) p.cancelRepair?.('stopped');
      this.repairMsgFor = null;
    }
    this.repairKeyHeld = repairHeld;

    if (input.pressed('KeyF')) {
      if (p.useExtinguisher?.()) {
        // the award is for the fire you put out, not the one that burned itself
        // out around you, so the credit is taken here and spent on the edge
        this.firePutOut = true;
        this.notify('Fire extinguished', 'good');
        this.effects.flash?.(tmpV.copy(p.position).add(tmpV2.set(0, 1.4, 0)), 0.4, 0xdddddd, 14);
        radioCue('reload');
      } else if (p.burning) {
        this.notify('No extinguisher left — smother it, and stop moving', 'critical');
      } else {
        this.notify('Nothing is burning', 'info');
      }
    }

    if (input.pressed('KeyG')) {
      const smoke = p.deploySmoke?.();
      if (smoke) {
        this.effects.smokeScreen?.(smoke.pos, smoke.radius, smoke.duration);
        this.notify('Smoke out', 'good');
      } else {
        this.notify('No smoke grenades left', 'info');
      }
    }

    if (input.pressed('KeyH')) {
      const role = p.useFirstAid?.();
      if (role) {
        this.notify(`${ROLE_LABEL[role] || role} patched up`, 'good');
        radioCue('reload');
      } else {
        this.notify('No first-aid kit, or nobody to treat', 'info');
      }
    }

    if (input.pressed('KeyV')) this.tryScout();
    if (input.pressed('KeyT')) this.callArtillery();
    if (input.pressed('KeyM')) this.hud.toggleBigMap?.();
  }

  moduleLabel(key) {
    switch (key) {
      case 'engine': return 'engine';
      case 'transmission': return 'transmission';
      case 'tracks': return 'tracks';
      case 'breech': return 'gun breech';
      case 'barrel': return 'gun barrel';
      case 'traverse': return 'turret drive';
      case 'elevation': return 'elevation drive';
      case 'radiator': return 'radiator';
      default: return key || 'module';
    }
  }

  // Line of sight the whole battle agrees on: terrain, then the standing
  // masonry and stone, then smoke.
  //
  // F4: the houses and boulders that stop a shell dead have to stop a spotting
  // report too, or a marker hangs in the air on the far side of the wall the
  // round just bounced off. Trees and fences are deliberately transparent here
  // for the same reason they are transparent to a shell — they are felled, not
  // stopped, and cover you can drive a round through is not cover you can hide
  // behind. The walls are the buildings' real shapes (a ruin's stumps and
  // rubble included, which is why this no longer waits on the live blocker
  // list: a flattened village still hides a hull lying behind its rubble).
  canSee(from, to) {
    if (!hasLOS(from, to)) return false;
    if (propBlocksLine(from, to, false)) return false;
    if (this.effects.blocksLineOfSight && this.effects.blocksLineOfSight(from, to)) return false;
    return true;
  }

  // How loud a vehicle is being, as a multiplier on the range it is picked out
  // at. Standing still in cover is genuinely hard to see; a burning tank that
  // just fired while flat out is visible from most of the map.
  signature(tank) {
    let s = 1;
    s += 0.4 * Math.min(1, Math.abs(tank.speed) / (tank.spec.maxSpeed || 12));
    if (tank.lastFired != null && this.time - tank.lastFired < 3) s += 0.55;
    if (tank.burning) s += 0.7;
    return s;
  }

  mark(tank, duration, scout = false, scoutBy = null) {
    const until = this.time + duration;
    let rec = this.spotted.get(tank.id);
    if (!rec) {
      rec = { until, scout, scoutBy };
      this.spotted.set(tank.id, rec);
      return rec;
    }
    if (rec.until <= this.time) {
      // a lapsed record only kept for the H-06 marker fade: start afresh
      rec.scout = false;
      rec.scoutBy = null;
    }
    if (until > rec.until) rec.until = until;
    if (scout) {
      rec.scout = true;
      rec.scoutBy = scoutBy;
    }
    return rec;
  }

  // Arcade keeps the old always-marked behaviour; realistic only marks what the
  // team can actually see, and smoke really does hide a vehicle.
  isSpotted(tank) {
    if (!this.realistic) return true;
    if (!tank || tank.team === 0) return true;
    const rec = this.spotted.get(tank.id);
    return !!rec && rec.until > this.time;
  }

  updateSpotting(dt) {
    this.spotTimer -= dt;
    if (this.spotTimer > 0) return;
    this.spotTimer = 0.25;

    // prune first so a dead enemy's mark cannot outlive him. H-06: a lapsed
    // record is kept MARK_FADE s more so the HUD can decay the mark (dimmed);
    // isSpotted() and the scout assist still read `until`, so a fading mark
    // is not a spotting.
    for (const [id, rec] of this.spotted) {
      if (rec.until + MARK_FADE <= this.time) this.spotted.delete(id);
    }
    if (!this.realistic) return;

    const p = this.player;
    if (p.alive) p.turretWorldPos(spotEye).y += 0.9;
    else spotEye.copy(this.camera.position);
    const vision = (p.spec.spotFactor || 1) * (p.canScout === false ? 0.72 : 1);

    for (const t of this.tanks) {
      if (!t.alive || t.team === 0) continue;
      spotAt.set(t.position.x, t.position.y + 1.6, t.position.z);
      const sig = this.signature(t);
      let seen =
        spotEye.distanceTo(spotAt) < SPOT_BASE * vision * sig && this.canSee(spotEye, spotAt);
      if (!seen) {
        // allies call out what they see, but only what is close to them
        for (const a of this.tanks) {
          if (!a.alive || a.team !== 0 || a === p) continue;
          if (a.position.distanceTo(t.position) > SPOT_ALLY_RANGE * sig) continue;
          tmpV.set(a.position.x, a.position.y + 1.6, a.position.z);
          if (this.canSee(tmpV, spotAt)) {
            seen = true;
            break;
          }
        }
      }
      if (seen) this.mark(t, SPOT_MEMORY);
    }
  }

  // The light tank's job. A scouted vehicle is marked for the whole team for
  // twenty seconds and pays out again if somebody kills it while the mark holds.
  tryScout() {
    const p = this.player;
    if (!p.alive) return;
    if (this.scoutCd > 0) {
      this.notify(`Scout report ready in ${Math.ceil(this.scoutCd)} s`, 'info');
      return;
    }
    if (p.canScout === false) {
      this.notify('Commander is out — nobody on the optics', 'critical');
      return;
    }
    const tgt = this.aimTarget && this.aimTarget.tank;
    if (!tgt || !tgt.alive || tgt.team === p.team) {
      this.notify('No enemy under the sight', 'info');
      return;
    }
    p.turretWorldPos(spotEye).y += 0.9;
    spotAt.set(tgt.position.x, tgt.position.y + 1.6, tgt.position.z);
    // the commander's optics and a trained eye both extend the report range
    const range = SCOUT_RANGE * (p.spec.spotFactor || 1)
      * (p.spec.klass === 'Light Tank' ? 1.25 : 1);
    if (spotEye.distanceTo(spotAt) > range) {
      this.notify('Target is beyond reporting range', 'info');
      return;
    }
    if (!this.canSee(spotEye, spotAt)) {
      this.notify('No clear line of sight', 'info');
      return;
    }
    this.scoutCd = SCOUT_COOLDOWN;
    this.mark(tgt, SCOUT_DURATION, true, p);
    this.playerScouts++;
    this.notify(`Scouted ${tgt.displayName}`, 'good');
    this.reward(SCOUT_SILVER, SCOUT_RP, true);
    this.awardSpawnPoints({ hits: 1 });
    radioCue('warning');
  }

  callArtillery() {
    const p = this.player;
    if (!p.alive) return;
    // F3: the fire mission is the Artillery Support modification, not a free
    // key every hull is born with. mods.js sets the flag; without it there is
    // nobody on the other end of the radio.
    if (!this.hasArtillery) {
      this.notify('No artillery support fitted — research the modification', 'info');
      return;
    }
    if (this.artyStrike) {
      this.notify('A strike is already on the way', 'info');
      return;
    }
    if (this.artyCd > 0) {
      this.notify(`Battery reloading — ${Math.ceil(this.artyCd)} s`, 'info');
      return;
    }
    if (this.artyCharges <= 0) {
      this.notify('No fire missions left', 'info');
      return;
    }
    if (p.canCallIn === false) {
      this.notify('Radio operator is out — cannot call in', 'critical');
      return;
    }
    const point = p.aimPoint.clone();
    point.y = terrainHeight(point.x, point.z);
    if (point.distanceTo(p.position) < ARTY_MIN_RANGE) {
      this.notify('Too close to your own position', 'critical');
      return;
    }
    this.artyCharges--;
    this.artyCd = ARTY_COOLDOWN;
    const rec = p.usage;
    if (rec) rec.consumables.artillery++;
    this.artyStrike = {
      point,
      timer: ARTY_DELAY,
      fired: 0,
      next: 0,
      smoke: 0,
      whistled: false,
      shooter: p,
    };
    this.notify(`Fire mission out — rounds in ${ARTY_DELAY} s`, 'warn');
    radioCue('warning');
  }

  updateArtillery(dt) {
    const a = this.artyStrike;
    if (!a) return;
    if (a.timer > 0) {
      a.timer -= dt;
      // a marker round burning on the aim point, so both sides can see it coming
      a.smoke -= dt;
      if (a.smoke <= 0) {
        a.smoke = 0.22;
        this.effects.wreckSmoke?.(
          artyV.set(a.point.x + rand(-2.5, 2.5), a.point.y + 1.2, a.point.z + rand(-2.5, 2.5)),
        );
      }
      if (a.timer <= 2.4 && !a.whistled) {
        a.whistled = true;
        sfx3d.flyby(a.point, 260);
        if (this.player.alive && this.player.position.distanceTo(a.point) < ARTY_SPREAD + 30) {
          this.notify('INCOMING ARTILLERY', 'critical');
          radioCue('warning');
        }
      }
      return;
    }
    a.next -= dt;
    if (a.next > 0) return;
    a.next = 0.2 + Math.random() * 0.2;
    a.fired++;
    const ang = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * ARTY_SPREAD;
    const px = a.point.x + Math.cos(ang) * r;
    const pz = a.point.z + Math.sin(ang) * r;
    artyV.set(px, terrainHeight(px, pz) + 0.15, pz);
    sfx3d.flyby(artyV, 240);
    // HE in the ground at its real scale (X-02 / AV-01): one surface record
    // for the dust, the crater and the sound (AV-03); no fireball
    const artyLook = this.effects.surfaceAt ? this.effects.surfaceAt(px, pz) : null;
    this.effects.groundHit(artyV, 3, artyLook);
    this.effects.dirtImpact?.(artyV, 3.2, BLAST_KG.artillery, artyLook);
    this.explosiveDamage(artyV, ARTY_RADIUS, a.shooter, 'Artillery', 2.2, BLAST_KG.artillery, artyLook);
    if (a.fired >= ARTY_SHELLS) this.artyStrike = null;
  }

  // hold J to abandon the vehicle and pick a new one without leaving battle
  updateBail(dt) {
    if (this.bailMsgCd > 0) this.bailMsgCd -= dt;
    if (input.down('KeyJ')) {
      this.bailTimer += dt;
      if (this.bailMsgCd <= 0) {
        this.bailMsgCd = 0.6;
        this.notify('Abandoning vehicle…', 'critical');
      }
      if (this.bailTimer >= 1.5) {
        this.bailTimer = 0;
        const p = this.player;
        p.lastAttacker = null; // no killer — crew just left
        p.destroy(false);
        removeEngine('t' + p.id);
        this.onTankKilled(null, p);
      }
    } else {
      this.bailTimer = 0;
    }
  }

  // free-fly camera to watch the rest of the battle after dying
  startSpectate() {
    this.spectate = true;
    this.specPos = this.camera.position.clone();
    this.hud.setDeathInfo(null);
    this.notify('Spectating — WASD fly · Space/Ctrl up-down · Shift boost', 'info');
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
    const spd =
      (input.down('ShiftLeft') || input.down('ShiftRight') ? 190 : 75) * dt;
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
    this.specPos.y = Math.max(
      this.specPos.y,
      terrainHeight(this.specPos.x, this.specPos.z) + 2,
    );
    this.camera.position.copy(this.specPos);
    this.camera.lookAt(tmpV2.copy(this.specPos).add(dir));
    this.fov = lerp(this.fov, 60, 1 - Math.pow(0.0001, dt));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  startDeathCam() {
    // a shake begun a moment before the cut must not ride into the new view
    this.shake.reset();
    const k = this.player.lastAttacker;
    this.deathCamKiller = k && k !== this.player ? k : null;
    this.deathCamAngle = rand(0, Math.PI * 2);
    if (this.deathCamKiller) {
      const d = Math.round(this.player.position.distanceTo(this.deathCamKiller.position));
      this.hud.setDeathInfo(`Destroyed by ${this.deathCamKiller.displayName} · ${d}m`);
    }
    // X-ray of the shot that killed you, alongside the killer view
    const hx = this.player.lastHitXray;
    // H-05: the enemy's shot on you — the ARMOUR perspective, titled so
    if (hx && this.time - hx.time < 2.5) this.startXray(hx, 3.0, 'armour');
  }

  // simple XZ push-apart so tanks can't drive through each other;
  // dead hulls act as immovable obstacles
  resolveTankCollisions() {
    const list = this.wrecks ? [...this.tanks, ...this.wrecks] : this.tanks;
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
    this.pushTanksOutOfScenery();
  }

  // A house or a boulder is a wall to a hull. Without this a tank could drive
  // straight into a building, and with the buildings now solid to every round
  // and sight line it then sat in there unhittable and blind, its own shots
  // bursting at the muzzle. Each living hull is put back outside the wall
  // rectangle (or the rock) it overlaps, and only the part of its drive that
  // pushes into the wall is lost — so it slides along a wall, and an AI that
  // keeps ramming one stalls and backs off (TankAI.updateStuck).
  pushTanksOutOfScenery() {
    for (let i = 0; i < this.tanks.length; i++) {
      const t = this.tanks[i];
      if (!t.alive) continue;
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
      // and the gun: a barrel run into a wall (driving at it, or traversed
      // into it) holds the hull off by the length that went in, so a muzzle
      // never sits inside the masonry its own rounds would burst in
      if (barrelIntoWall(t, hullShove)) {
        t.position.x += hullShove.x;
        t.position.z += hullShove.z;
        sx += hullShove.x;
        sz += hullShove.z;
      }
      if (sx === 0 && sz === 0) continue;
      // the drive into the wall is what is lost: the hull's velocity loses
      // its component along the wall normal, and what is left of it along
      // the hull's own heading is speed * (1 - cos^2). Head-on that is a
      // stop (and an AI that keeps ramming reads as stuck and backs off);
      // at a glancing angle it scrapes along.
      const len = Math.sqrt(sx * sx + sz * sz);
      const into = -((fx * sx + fz * sz) / len) * (t.speed < 0 ? -1 : 1);
      if (into > 0.1) {
        // a real knock against the wall rattles the player's view
        if (t === this.player && Math.abs(t.speed) * into > 2 && this.shake) this.shake.add(0.05, 0.15);
        t.speed *= 1 - into * into;
      }
    }
  }

  // old hulls sink into the ground after a while and get removed
  cleanupWrecks(dt) {
    const sink = (t) => {
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
      if (sink(t)) {
        this.tanks.splice(i, 1);
        removeEngine('t' + t.id);
        this.spotted.delete(t.id);
        this.hud.setMarker(`t${t.id}`, '', 0, 0, '', false);
        t.dispose();
      }
    }
    if (this.wrecks) {
      for (let i = this.wrecks.length - 1; i >= 0; i--) {
        const w = this.wrecks[i];
        if (sink(w)) {
          this.wrecks.splice(i, 1);
          removeEngine('t' + w.id);
          w.dispose();
        }
      }
    }
  }

  // friendly vehicles restock ammo while sitting on a point their team holds
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
      // a resupply point is also where the crew top their kits back up
      if (t.consumables) {
        const cons = t.spec.consumables || {};
        if (t.consumables.repair < (cons.repair ?? 2)) {
          t.consumables.repair++;
          if (t.usage) t.usage.base.repair++;
          gained = true;
        }
      }
      if (gained && t === this.player) this.notify('Resupplying…', 'good');
    }
  }

  zoneAt(pos) {
    for (const z of this.zones) {
      const dx = pos.x - z.x;
      const dz = pos.z - z.z;
      if (dx * dx + dz * dz <= z.r * z.r) return z;
    }
    return null;
  }

  // Where a vehicle on this team ought to be heading: the nearest point it does
  // not already hold, with a held point weighted as if it were nearly twice as
  // far so a crew only falls back to defending when there is nothing to take.
  // tankAI.js is another agent's file, so this is exposed, not called.
  objectiveFor(team, from = null, out = new THREE.Vector3()) {
    const origin = from || (this.zones.length ? this.zones[0].pos : null);
    let best = this.zones[0];
    let bestD = Infinity;
    for (const z of this.zones) {
      const d = origin ? Math.hypot(z.x - origin.x, z.z - origin.z) : 0;
      const w = d * (z.owner === team ? 1.9 : 1) + (z.contested ? -60 : 0);
      if (w < bestD) {
        bestD = w;
        best = z;
      }
    }
    return best ? out.set(best.x, terrainHeight(best.x, best.z), best.z) : out.set(0, 0, 0);
  }

  handlePlayerDeath() {
    const affordable = this.canSpawnVehicle(this.player.spec.id)
      || (this.spawnBudget && this.spawnBudget.available().length > 0);
    const canRespawn =
      this.tickets[0] > RESPAWN_COST && affordable && !this.finished;
    this.onPlayerDeath?.(canRespawn, this.playerKills, {
      spawnPoints: this.spawnPoints(),
      spawnCost: this.spawnCostFor(this.player.spec.id),
      available: this.spawnBudget ? this.spawnBudget.available() : [],
    });
  }

  playerRespawn(specId) {
    this.playerSpawnsUsed++;
    this.playerDeathHandled = false;
    this.deathCamKiller = null;
    this.bailTimer = 0;
    this.streak = 0;
    this.firePutOut = false;
    this.hud.setDeathInfo(null);
    this.hud.clearDamageLog?.();
    this.hud.setBlackout?.(0);
    this.shake.reset();
    const cost = this.chargeSpawn(specId);
    // move the old vehicle out of tanks[] but leave the wreck visible;
    // it gets disposed with the battle
    const idx = this.tanks.indexOf(this.player);
    if (idx >= 0) {
      this.tanks.splice(idx, 1);
      this.wrecks = this.wrecks || [];
      this.wrecks.push(this.player);
    }
    removeEngine('t' + this.player.id);
    this.syncUsage(this.player);
    this.player = this.spawnTank(specId, 0, true, 1.5);
    // the flyby guard keys off identity, so the new hull has to be the one the
    // projectile managers know about or the player hears his own rounds again
    this.shellOpts.player = this.player;
    this.bulletOpts.player = this.player;
    this.camYaw = this.player.yaw;
    this.sniper = false;
    // the new hull's modification list is its own, so the key list is rebuilt
    this.refreshHelp();
    if (cost > 0) this.notify(`Spawn cost ${cost} SP · ${this.spawnPoints()} left`, 'info');
  }

  // ---------------- combat resolution ----------------
  onImpact(kind, info) {
    if (kind === 'ground') {
      const isHe = info.shell.type === 'HE';
      // info.prop: the round stopped on a wall or a rock (ShellManager), and
      // info.point is on its face. Solid shot rings off the masonry and
      // throws more of it; HE simply bursts there, splash and all.
      const wall = !!info.prop;
      // AV-03: the round's own surface lookup decides the dust, the mark and
      // the sound together. AV-01: an HE round is its filler's blast.
      const look = this.effects.surfaceLook
        ? this.effects.surfaceLook(info.surface, info.point.x, info.point.z) : null;
      const cal = (info.shell.shell && info.shell.shell.caliber) || 75;
      const kg = isHe ? heFillerKg(cal) : 0;
      this.effects.groundHit(info.point, isHe ? 2 : 1, look);
      this.effects.dirtImpact?.(info.point, isHe ? 3 : wall ? 2 : 1, kg, look);
      if (wall && !isHe) sfx3d.nonpen(info.point);
      else if (!isHe) sfx3d.groundImpact?.(info.point, { caliber: cal, surface: look || info.surface });
      if (!isHe) this.shake.addAt(0.2, info.point, this.camera.position, 120);
      if (isHe) {
        const splash = info.shell.shell.splash;
        this.explosiveDamage(
          info.point, splash, info.shell.shooter, 'High-explosive', splash / 5, kg, look || info.surface,
        );
      }
      return null;
    }

    const { shell, target, hit } = info;
    // arcade: friendly shells ping off harmlessly; realistic: friendly fire
    if (!this.realistic && target.team === shell.shooter.team) {
      this.effects.ricochetSparks(hit.point);
      return null;
    }
    const result = target.applyHit(hit, shell.shell, shell.type);
    const isPlayerShot = shell.shooter === this.player;
    const onPlayer = target === this.player;

    switch (result.result) {
      case 'ricochet':
        this.effects.ricochetSparks(hit.point);
        sfx3d.ricochet(hit.point);
        if (isPlayerShot) {
          this.startXray(this.captureXray(target, shell, hit, result, 'ricochet'), 1.6);
          this.hud.hitMessage('Ricochet', 'bad');
        }
        if (onPlayer) {
          this.shake.add(0.28, 0.4);
          this.playerHitFeedback(result, shell.shooter, 'light');
        }
        // C1: hand the damage model's own deflection back on the info record —
        // that is the field ShellManager reads — so the round skids off the way
        // the armour says it does. The bounce and ricochet counters belong to
        // ShellManager.deflect(); counting them here as well halved the budget.
        if (result.deflect) {
          info.deflect = result.deflect;
          return 'continue';
        }
        break;
      case 'nonpen':
        this.effects.impactSparks(hit.point, false);
        sfx3d.nonpen(hit.point);
        if (isPlayerShot) {
          this.startXray(this.captureXray(target, shell, hit, result, 'nonpen'), 1.6);
          for (const ev of result.events) {
            this.hud.hitMessage(ev, ev === 'Non-penetration' ? 'bad' : 'good');
          }
        }
        if (onPlayer) {
          this.shake.add(0.28, 0.4);
          this.playerHitFeedback(result, shell.shooter, 'heavy');
        }
        break;
      case 'pen': {
        this.effects.impactSparks(hit.point, true);
        this.effects.spallBurst?.(hit.point, hit.dir);
        sfx3d.hit(hit.point);
        this.tagDamage(target, shell.shooter);
        target.lastHitXray = this.captureXray(target, shell, hit, result, 'pen');
        if (isPlayerShot) {
          this.creditHit(target, result);
          this.startXray(target.lastHitXray, 2.4);
          for (const ev of result.events) this.hud.hitMessage(ev, 'good');
        }
        if (onPlayer) {
          this.shake.add(0.5, 0.55);
          this.playerHitFeedback(result, shell.shooter, 'critical');
        }
        break;
      }
      case 'kill': {
        this.tagDamage(target, shell.shooter);
        target.lastHitXray = this.captureXray(target, shell, hit, result, 'pen');
        if (isPlayerShot) {
          this.creditHit(target, result);
          this.startXray(target.lastHitXray, 2.8);
        }
        this.effects.impactSparks(hit.point, true);
        // AV-01: a hulk brewing up, or its ammunition going (BLAST_KG), drawn,
        // voiced and felt off the one law; X-05: the rounds cooking off
        const boomKg = target.exploded ? BLAST_KG.vehicleAmmo : BLAST_KG.vehicle;
        this.effects.explosion(
          target.position.clone().add(tmpV.set(0, 1.5, 0)), boomKg,
        );
        this.effects.cookOff?.(tmpV.copy(target.position).add(tmpV2.set(0, 2.2, 0)));
        sfx3d.explosion(target.position, { size: target.exploded ? 2.4 : 1.6, kg: boomKg });
        this.shake.addBlast(boomKg, target.position, this.camera.position);
        if (isPlayerShot) {
          for (const ev of result.events) this.hud.hitMessage(ev, 'good');
          this.hud.hitMessage('Target destroyed', 'kill');
        }
        if (onPlayer) this.playerHitFeedback(result, shell.shooter, 'critical');
        removeEngine('t' + target.id);
        this.onTankKilled(shell.shooter, target, hit.dist);
        break;
      }
      default:
        break;
    }
    return null;
  }

  // F1. The old indicator divided the RAW spec thickness by the cosine of the
  // incidence to the axis-aligned collision box, which knows nothing about the
  // plate's own lay, the mantlet or normalisation — so it showed green on a
  // T-34 glacis (45 mm to the HUD, 80.5 mm to the damage model) that every
  // round bounced off. Ask the damage model instead, and only fall back to the
  // old estimate on a build where tankEntity.js has not grown the forecast yet.
  // H-02: the indicator IS the damage model's forecast, ricochet included
  // (the HUD has its own RICOCHET band now, ui/penScale.js). There is no
  // armour/cos fallback any more: no forecast means no indicator, never a
  // second opinion the damage model does not hold.
  penVerdict(target, hit, shell, dist) {
    if (!this.penForecast) return null;
    try {
      const f = this.penForecast(target, hit, shell, this.player.shellType, dist);
      return f && f.verdict ? f.verdict : null;
    } catch (err) {
      // one bad frame must not take the battle with it; stop asking
      this.penForecast = null;
      return null;
    }
  }

  // Everything the player's own vehicle suffers, made visible: the arc pointing
  // at whoever did it, the line, the log, the radio and the shake.
  playerHitFeedback(result, shooter, severity) {
    const hud = this.hud;
    const p = this.player;
    const src = shooter && shooter.position ? shooter.position : shooter;
    if (src && hud.damageDirection) {
      const ang = wrapAngle(
        Math.atan2(src.x - p.position.x, src.z - p.position.z) - this.camYaw,
      );
      hud.damageDirection(ang, severity);
    }
    const sev = severity === 'critical' ? 'critical' : severity === 'heavy' ? 'warn' : 'info';
    const logKind = severity === 'critical' ? 'critical' : 'warn';
    const events = result && result.events ? result.events : [];
    for (const ev of events) {
      if (hud.incomingMessage) hud.incomingMessage(ev, sev);
      else hud.hitMessage(ev, 'bad');
      if (this.showDamageLog) hud.addDamageLog?.(ev, logKind);
    }
    if (severity === 'critical') {
      radioCue(events.length > 1 ? 'critical' : 'damage');
    }
    // the shot also unsettles the gunner
    p.addShake?.(severity === 'critical' ? 1.4 : 0.7);
  }

  // Credit the player for a hit that got inside: silver, damage points for the
  // settlement, and the spawn points that pay for the next vehicle.
  creditHit(target, result) {
    this.playerHits++;
    let pts = DMG_PEN;
    const mods = result.modules || [];
    for (const ev of result.events || []) {
      if (/knocked out|crew/i.test(ev)) pts += DMG_CREW;
    }
    pts += Math.min(3, mods.length) * DMG_MODULE;
    this.playerDamage += pts;
    this.reward(REWARD.silver.hit + pts * REWARD.silver.damage, REWARD.rp.hit);
    this.awardSpawnPoints({ hits: 1 });
  }

  // player-only stream weapons: SPAA autocannon on LMB, coax MG on Space
  updateTankStream(dt) {
    const p = this.player;
    if (p.streamTimer > 0) p.streamTimer -= dt;
    if (p.streamSound > 0) p.streamSound -= dt;
    // canFireStream: alive, a gunner in his seat, and rounds on the belt
    if (!input.locked || !canFireStream(p)) return;
    const isAA = !!p.spec.aa;
    const wpn = isAA ? p.spec.aa : p.spec.mg;
    if (!wpn) return;
    const wantFire = isAA ? input.fireHeld : input.down('Space');
    if (!wantFire) return;
    let fired = 0;
    while (p.streamTimer <= 0 && p.streamAmmo > 0) {
      p.streamTimer += 1 / wpn.rof;
      p.streamAmmo--;
      fired++;
      const pos = p.muzzleWorld(tmpV);
      pos.y -= 0.12; // coax sits just below the main tube
      const dir = p.gunDirection(tmpV2);
      this.bullets.fire(pos, dir, wpn.speed, wpn.dmg, p, wpn.spread);
      this.effects.mgFlash?.(pos, dir);
      // the one-shot layer throttles and culls itself, so this is safe at full
      // rate of fire and needs no gate of its own
      sfx3d.mg(pos);
    }
    if (fired) {
      p.lastFired = this.time;
      if (p.usage) p.usage.stream += fired;
      this.streamShake = (this.streamShake || 0) + fired;
      if (this.streamShake >= 4) {
        this.streamShake = 0;
        this.shake.add(0.05, 0.16);
      }
    }
  }

  // record that `attacker` damaged `target`, for assist rewards on its death
  // and for the death camera (who killed me)
  tagDamage(target, attacker) {
    if (!attacker || attacker === target) return;
    target.lastAttacker = attacker;
    (target.damagers || (target.damagers = new Set())).add(attacker);
  }

  // snapshot the hit in tank-local space for the X-ray camera.
  // `visual` picks the presentation: a stopped shell for ricochet/nonpen.
  captureXray(target, shellRec, hit, result, visual) {
    target.group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(target.group.matrixWorld).invert();
    const kind = (shellRec.shell && shellRec.shell.kind) || shellRec.type;
    return {
      spec: target.spec,
      turretYaw: target.turretYaw,
      localPoint: hit.point.clone().applyMatrix4(inv),
      localDir: shellRec.vel.clone().normalize().transformDirection(inv),
      events: [...result.events],
      modules: [...(result.modules || [])],
      result: visual,
      time: this.time,
      // Without these the view draws every hit as a plain AP round: no APHE
      // burst, no HEAT jet, no spall cone, and a mirrored guess where the real
      // skid was already computed. The deflection goes into the same local
      // frame localDir is in, which is what xray.js documents.
      shell: shellRec.shell,
      blast: kind === 'HE',
      deflect: result.deflect && result.deflect.dir
        ? {
          dir: result.deflect.dir.clone().transformDirection(inv),
          energy: result.deflect.energy,
        }
        : null,
      crewAlive: target.crewAlive ? { ...target.crewAlive } : null,
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

  // everyone who damaged the victim (except the killer) earns an assist
  creditAssists(killer, victim) {
    if (!victim.damagers) return;
    for (const d of victim.damagers) {
      if (d === killer || d === victim || d.team === victim.team) continue;
      this.stat(d).assists++;
      if (d === this.player && victim.team === 1) {
        this.playerAssists++;
        this.hud.hitMessage('Assist', 'good');
        this.reward(REWARD.silver.assist, REWARD.rp.assist, true);
        this.awardSpawnPoints({ assists: 1 });
      }
    }
  }

  // capture credit for every capping-team vehicle inside the zone
  creditCapture(zone, team) {
    for (const t of this.tanks) {
      if (!t.alive || t.team !== team) continue;
      const dx = t.position.x - zone.x;
      const dz = t.position.z - zone.z;
      if (dx * dx + dz * dz > zone.r * zone.r) continue;
      this.stat(t).caps++;
      if (t.isPlayer) {
        this.playerCaps++;
        this.hud.hitMessage(`Point ${zone.key} captured!`, 'kill');
        this.award('CAPTURE', `Point ${zone.key} taken`);
        this.reward(REWARD.silver.cap, REWARD.rp.cap, true);
        this.awardSpawnPoints({ caps: 1 });
      }
    }
  }

  onZoneOwnerChanged(zone, team, neutralised) {
    const mine = team === 0;
    if (neutralised) {
      if (mine) this.hud.hitMessage(`Point ${zone.key} neutralised`, 'good');
      else this.notify(`Point ${zone.key} neutralised`, 'warn');
      // A point going neutral is as much a change of objective as one being
      // taken, so the bots re-plan off this branch too.
      notifyObjectivesChanged(this);
      return;
    }
    this.tickets[1 - team] -= CAP_TICKET_BONUS;
    // both sides get the scoreboard credit; only the player gets paid for it
    this.creditCapture(zone, team);
    if (!mine) {
      this.notify(`Point ${zone.key} lost`, 'critical');
      if (this.showDamageLog) this.hud.addDamageLog?.(`Point ${zone.key} lost`, 'warn');
      radioCue('warning');
    }
    // Without this every bot waits out its 8-14 s planning timer before it
    // notices the map changed under it.
    notifyObjectivesChanged(this);
  }

  onBulletTank(g, b, point) {
    this.effects.ricochetSparks(point);
    // only thin armor cares about bullets
    const minArmor = Math.min(g.spec.armor.hull.side, g.spec.armor.hull.top);
    if (minArmor <= 16 && Math.random() < 0.15) {
      this.tagDamage(g, b.shooter);
      const fromPlayer = b.shooter === this.player;
      if (Math.random() < 0.5) {
        g.breakModule('tracks');
        if (fromPlayer) {
          this.hud.hitMessage('Track destroyed', 'good');
          this.playerDamage += DMG_MODULE;
        }
        if (g === this.player) this.playerHitFeedback({ events: ['Track destroyed'] }, b.shooter, 'heavy');
      } else {
        const wasAlive = g.alive;
        g.loseCrew(1);
        if (fromPlayer) {
          this.hud.hitMessage('Crew member knocked out', 'good');
          this.playerDamage += DMG_CREW;
        }
        if (g === this.player) {
          this.playerHitFeedback({ events: ['Crew member knocked out'] }, b.shooter, 'critical');
        }
        if (wasAlive && !g.alive) {
          if (fromPlayer) this.hud.hitMessage('Target destroyed', 'kill');
          removeEngine('t' + g.id);
          this.onTankKilled(b.shooter, g);
        }
      }
    }
  }

  // One shared blast solver for HE splash and for the artillery barrage, so the
  // two behave identically and both credit the man who called them. The visual
  // belongs to the caller — a shell in the dirt and a battery firing for effect
  // do not look the same.
  // kg / surface (optional, AV-01 / AV-03): the charge in kg of TNT and the
  // impact's surface record — the sound and the shake then come from the
  // blast law and the ground, like the picture.
  explosiveDamage(point, radius, shooter, label, soundSize, kg = 0, surface = null) {
    if (soundSize) sfx3d.explosion(point, { size: soundSize, kg, surface });
    if (kg > 0) this.shake.addBlast(kg, point, this.camera.position);
    else this.shake.addAt(0.6, point, this.camera.position, 150, 0.65);
    // the same blast takes the fence line and the hedgerow with it
    damagePropsAt(point.x, point.z, radius, radius * PROP_BLAST_DMG);
    for (const tank of this.tanks) {
      if (!tank.alive || tank === shooter) continue;
      if (!this.realistic && shooter && tank.team === shooter.team) continue;
      if (tank.position.distanceTo(point) > radius + tank.radius) continue;
      const wasAlive = tank.alive;
      let res = null;
      if (tank.applyExplosion) {
        res = tank.applyExplosion(point, radius, label);
      } else if (Math.random() < 0.6) {
        tank.breakModule('tracks');
        res = { result: 'damaged', events: ['Track destroyed'], modules: [] };
      }
      if (!res || res.result === 'none' || res.result === 'dead') continue;
      if (shooter) this.tagDamage(tank, shooter);
      if (tank === this.player) {
        this.playerHitFeedback(res, point, res.result === 'kill' ? 'critical' : 'heavy');
        this.shake.add(res.result === 'kill' ? 0.9 : 0.45, 0.55);
      } else if (shooter === this.player) {
        for (const ev of res.events || []) this.hud.hitMessage(ev, 'good');
        this.playerDamage += res.result === 'kill' ? DMG_KILL : DMG_MODULE;
      }
      if (wasAlive && !tank.alive) {
        removeEngine('t' + tank.id);
        this.onTankKilled(shooter || null, tank);
      }
    }
  }

  // kept for anything that still calls the old name
  applySplash(point, radius, shooter) {
    this.explosiveDamage(point, radius, shooter, 'High-explosive', 0);
  }

  onTankKilled(killer, victim, range = 0) {
    // artillery, fire and a shell can all reach the same vehicle in one frame
    if (victim.killCounted) return;
    victim.killCounted = true;

    this.tickets[victim.team] -= KILL_COST;
    if (killer && killer !== victim) this.stat(killer).kills++;
    this.stat(victim).deaths++;
    if (killer && killer !== victim && victim.team === 0) {
      // remembered for the AVENGER award: this man just killed one of ours
      killer.lastAllyKill = this.time;
    }
    if (killer && killer.isPlayer && victim.team === 1) {
      this.playerKills++;
      this.streak++;
      this.playerDamage += DMG_KILL;
      this.stat(killer).groundKills++;
      this.reward(REWARD.silver.kill, REWARD.rp.kill, true);
      this.awardSpawnPoints({ kills: 1 });
      this.grantKillAwards(victim, range);
      radioCue('destroyed');
    }
    // a scout report that led to somebody else's kill still pays the scout
    const mark = this.spotted.get(victim.id);
    if (mark && mark.until > this.time && mark.scout && mark.scoutBy === this.player && killer !== this.player
      && killer && killer.team === 0) {
      this.notify('Scout assist', 'good');
      this.reward(SCOUT_ASSIST_SILVER, SCOUT_ASSIST_RP, true);
      this.awardSpawnPoints({ assists: 1 });
    }
    this.spotted.delete(victim.id);
    this.creditAssists(killer, victim);
    this.hud.addKillfeed(
      killer ? killer.displayName : 'Fire',
      killer ? killer.team : 1 - victim.team,
      victim.displayName,
      victim.team,
    );
    if (victim === this.player) {
      this.streak = 0;
      this.syncUsage(victim);
      this.losses.push(victim.spec.id);
      if (this.showDamageLog) this.hud.addDamageLog?.('Vehicle destroyed', 'critical');
    }
    // queue AI replacement
    if (!victim.isPlayer && this.tickets[victim.team] > RESPAWN_COST) {
      this.respawnQueue.push({ team: victim.team, specId: victim.spec.id, timer: 6 });
    }
  }

  grantKillAwards(victim, range) {
    if (!this.firstBlood) {
      this.firstBlood = true;
      this.award('FIRST BLOOD', victim.displayName);
    }
    if (this.streak === 3) this.award('ON A ROLL', '3 vehicles destroyed');
    else if (this.streak === 5) this.award('RAMPAGE', '5 vehicles destroyed');
    else if (this.streak === 7) this.award('UNSTOPPABLE', '7 vehicles destroyed');
    if (range > 800) this.award('SNIPER', `${Math.round(range)} m`);
    if (victim.lastAllyKill != null && this.time - victim.lastAllyKill < 20) {
      this.award('AVENGER', victim.displayName);
    }
    // No aircraft fly in this mode, but a tank that ever downs one earns it.
    // tankEntity.js sets isTank; planeEntity.js sets no flag at all, so the
    // test has to be the absence of the tank marker, not a plane marker.
    if (!victim.isTank) this.award('AA GUNNER', victim.displayName);
  }

  updateBurning(dt) {
    // the damaged-engine plume is rate-based and wants the real dt, so it runs
    // outside the coarse particle tick below
    for (const tank of this.tanks) {
      if (!tank.alive || !this.effects.engineSmoke) continue;
      const engineDead = tank.modules && !tank.modules.engine.ok;
      if (!engineDead && !tank.burning) continue;
      this.effects.engineSmoke(
        tmpV.copy(tank.position).add(tmpV2.set(0, 1.4, -1)),
        tank.burning ? 'fire' : engineDead ? 'heavy' : 'light',
        dt,
      );
    }

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
    if (this.wrecks) {
      for (const w of this.wrecks) {
        if (Math.random() < 0.4) {
          this.effects.wreckSmoke(tmpV.copy(w.position).add(tmpV2.set(0, 1.8, 0)), true);
        }
      }
    }
  }

  // ---------------- player state watch ----------------
  // Fire, artillery and a shell that killed a crewman all change the same
  // state, so the crew callouts are driven from a snapshot diff rather than
  // hooked at every damage site — nothing can slip through unreported.
  snapshotPlayer(tank) {
    const modules = {};
    for (const k of Object.keys(tank.modules || {})) modules[k] = tank.modules[k].ok;
    const crew = {};
    for (const role of tank.crewStations || []) crew[role] = tank.crewAlive[role];
    // anything logged before the player took the seat is not news
    if (Array.isArray(tank.crewLog)) tank.crewLog.length = 0;
    this.pState = {
      modules,
      crew,
      burning: !!tank.burning,
      repairTarget: null,
      handoverMsg: 0,
    };
  }

  watchPlayerState(dt) {
    const p = this.player;
    const st = this.pState;
    if (!p || !p.alive || !st) return;

    for (const k of Object.keys(st.modules)) {
      const ok = p.modules[k] ? p.modules[k].ok : true;
      if (ok === st.modules[k]) continue;
      st.modules[k] = ok;
      const label = this.moduleLabel(k);
      if (!ok) {
        const text = `${label[0].toUpperCase()}${label.slice(1)} knocked out`;
        this.notify(text, 'critical');
        if (this.showDamageLog) this.hud.addDamageLog?.(text, 'critical');
        radioCue('critical');
      } else {
        const text = `${label[0].toUpperCase()}${label.slice(1)} repaired`;
        this.notify(text, 'good');
        if (this.showDamageLog) this.hud.addDamageLog?.(text, 'good');
        radioCue('reload');
      }
    }

    // Crew callouts come from the entity's own event log. A health diff cannot
    // tell a man killed in his seat from a man who just left it for a more
    // important one, and would call a finished swap a "knocked out".
    const log = p.crewLog;
    if (Array.isArray(log)) {
      for (let i = 0; i < log.length; i++) this.announceCrewEvent(log[i]);
      log.length = 0;
    } else {
      // pre-crewLog entity: seats never change hands, so the diff is honest
      for (const role of Object.keys(st.crew)) {
        const h = p.crewAlive[role];
        const was = st.crew[role];
        st.crew[role] = h;
        if (h <= 0 && was > 0) this.announceCrewEvent({ type: 'killed', role });
        else if (h > 0 && was <= 0) this.announceCrewEvent({ type: 'revived', role });
      }
    }

    if (!!p.burning !== st.burning) {
      st.burning = !!p.burning;
      if (st.burning) {
        this.notify('FIRE! Stop and put it out', 'critical');
        if (this.showDamageLog) this.hud.addDamageLog?.('Fire in the fighting compartment', 'critical');
        radioCue('warning');
        this.shake.add(0.35, 0.6);
      } else {
        this.notify('Fire out', 'good');
        if (this.firePutOut) this.award('FIREFIGHTER', 'Fire out, still fighting');
        this.firePutOut = false;
      }
    }

    // the driver's seat is empty and somebody is climbing across into it
    if (p.canDrive === false && p.handover > 0) {
      st.handoverMsg -= dt;
      if (st.handoverMsg <= 0) {
        st.handoverMsg = 1;
        this.notify(`DRIVER DOWN — ${Math.ceil(p.handover)} s`, 'critical');
      }
    }
  }

  // One crewLog entry -> one player message. These never go near a hit
  // result's events: any string there with "crew" in it pays crew-kill score.
  announceCrewEvent(ev) {
    if (!ev) return;
    switch (ev.type) {
      case 'killed': {
        const text = `${roleLabel(ev.role)} knocked out`;
        this.notify(text, 'critical');
        if (this.showDamageLog) this.hud.addDamageLog?.(text, 'critical');
        radioCue('critical');
        break;
      }
      case 'swapStart':
        this.notify(`${roleLabel(ev.from)} moving to ${roleLabel(ev.to)} seat`, 'warn');
        break;
      case 'swapDone':
        this.notify(`${roleLabel(ev.to)} seat manned`, 'good');
        break;
      case 'revived':
        this.notify(`${roleLabel(ev.role)} back in his seat`, 'good');
        break;
      default:
        break;
    }
  }

  // ---------------- objective ----------------
  updateCapture(dt) {
    let allyZones = 0;
    let enemyZones = 0;
    let playerZone = null;

    for (const z of this.zones) {
      z.allies = 0;
      z.enemies = 0;
      for (const t of this.tanks) {
        if (!t.alive) continue;
        const dx = t.position.x - z.x;
        const dz = t.position.z - z.z;
        if (dx * dx + dz * dz > z.r * z.r) continue;
        if (t.team === 0) z.allies++;
        else z.enemies++;
        if (t === this.player) playerZone = z;
      }
      z.contested = z.allies > 0 && z.enemies > 0;
      const holder = z.allies > 0 && z.enemies === 0
        ? 0
        : z.enemies > 0 && z.allies === 0 ? 1 : -1;

      if (holder >= 0 && holder !== z.owner) {
        const n = Math.min(holder === 0 ? z.allies : z.enemies, 3);
        const step = CAP_RATE * dt * (1 + (n - 1) * 0.55);
        if (z.capTeam === holder || z.cap <= 0) {
          z.capTeam = holder;
          z.cap += step;
          if (z.cap >= 100) {
            z.cap = 0;
            if (z.owner === -1) {
              z.owner = holder;
              this.onZoneOwnerChanged(z, holder, false);
            } else {
              // taking an enemy point is two jobs: break it, then hold it
              z.owner = -1;
              this.onZoneOwnerChanged(z, holder, true);
            }
          }
        } else {
          // somebody else's progress on the bar has to be pushed back first
          z.cap = Math.max(0, z.cap - step);
          if (z.cap <= 0) z.capTeam = -1;
        }
      } else if (!z.contested) {
        z.cap = Math.max(0, z.cap - CAP_RATE * CAP_DECAY * dt);
        if (z.cap <= 0) z.capTeam = -1;
      }

      if (z.owner === 0) allyZones++;
      else if (z.owner === 1) enemyZones++;

      const col = z.owner === 0 ? ZONE_COLOR.ally
        : z.owner === 1 ? ZONE_COLOR.enemy : ZONE_COLOR.neutral;
      if (z.ring.material.color.getHex() !== col) z.ring.material.color.setHex(col);
      const frac = z.cap / 100;
      if (frac > 0.004) {
        z.progressRing.visible = true;
        const pc = z.capTeam === 0 ? ZONE_COLOR.ally : ZONE_COLOR.enemy;
        if (z.progressRing.material.color.getHex() !== pc) {
          z.progressRing.material.color.setHex(pc);
        }
        // RingGeometry indexes segment by segment, so a draw range is a free
        // progress arc — no geometry is rebuilt for it
        z.progressRing.geometry.setDrawRange(0, Math.max(1, Math.round(frac * 64)) * 6);
      } else if (z.progressRing.visible) {
        z.progressRing.visible = false;
      }
    }

    this.allyZones = allyZones;
    this.enemyZones = enemyZones;
    // Bleed is proportional: one point is a trickle, all three drains a team in
    // about three and a half minutes on its own.
    if (allyZones) this.tickets[1] -= BLEED_PER_ZONE * allyZones * dt;
    if (enemyZones) this.tickets[0] -= BLEED_PER_ZONE * enemyZones * dt;

    // standing on the objective is itself worth something
    if (playerZone && this.player.alive) {
      this.capTickT += dt;
      if (this.capTickT >= 5) {
        this.capTickT -= 5;
        this.playerCapTicks++;
        this.reward(CAP_TICK_SILVER, 8);
        this.awardSpawnPoints({ capTicks: 1 });
      }
    } else {
      this.capTickT = 0;
    }

    // keep the legacy single-point readouts pointing at A
    const a = this.zones[0];
    this.capOwner = a.owner;
    this.capProgress = a.capTeam === 0 ? -a.cap : a.cap;
  }

  updateRespawns(dt) {
    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      const r = this.respawnQueue[i];
      r.timer -= dt;
      if (r.timer <= 0) {
        this.respawnQueue.splice(i, 1);
        if (this.tickets[r.team] > RESPAWN_COST) {
          this.spawnTank(r.specId, r.team, false, Math.floor(rand(0, 4)));
        }
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
    if (!result) return;
    this.finished = true;
    // reports still in flight would otherwise arrive over the results screen
    resetAudio();
    this.effects.clearSmokeScreens?.();
    this.shake.reset();
    this.hud.setBlackout?.(0);
    this.onEnd(this.battleResult({ victory: result === 'victory' }));
  }

  // Everything progress.settle() needs, in the shape it documents.
  battleResult(extra = {}) {
    for (const rec of this.usage) this.syncUsage(rec.tank);
    return {
      victory: false,
      quit: false,
      mode: 'ground',
      kills: this.playerKills,
      assists: this.playerAssists,
      groundKills: this.playerGroundKills,
      hits: this.playerHits,
      caps: this.playerCaps,
      damage: Math.round(this.playerDamage),
      seconds: this.time,
      vehicleId: this.player ? this.player.spec.id : this.startSpecId,
      losses: this.losses.slice(),
      survived: this.survived,
      usage: this.usageForSettle(),
      difficulty: progress.getDifficulty(),
      spawnsUsed: this.playerSpawnsUsed,
      spawnPoints: this.spawnPoints(),
      scouts: this.playerScouts,
      capTicks: this.playerCapTicks,
      awards: this.awardsEarned.slice(),
      shownSilver: this.earnedSilver,
      shownRp: this.earnedRp,
      zones: { allies: this.allyZones || 0, enemies: this.enemyZones || 0 },
      ...extra,
    };
  }

  // ---------------- camera & HUD ----------------
  updateCamera(dt) {
    if (this.spectate) {
      this.updateSpectator(dt);
      this.shake.apply(this.camera);
      return;
    }
    const p = this.player;
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
        // lerp from the unshaken position so the cut converges exactly
        this.camera.position.sub(this.shake.lastOffset);
        this.camera.position.lerp(pos, 1 - Math.pow(0.001, dt));
        this.camera.lookAt(k.x, k.y + 2, k.z);
      } else {
        // death cam: rise above the wreck
        const pos = tmpV2.copy(p.position).add(tmpV3.set(-dir.x * 18, 12, -dir.z * 18));
        this.camera.position.sub(this.shake.lastOffset);
        this.camera.position.lerp(pos, 1 - Math.pow(0.001, dt));
        this.camera.lookAt(p.position.x, p.position.y + 2, p.position.z);
      }
    } else if (this.sniper) {
      // K-04: this vehicle's own sight at the chosen detent (a respawn in
      // another tank re-reads its optic)
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
    // must be last: every branch above rebuilds the camera from scratch, so
    // nothing accumulates and the shake is never overwritten
    this.shake.apply(this.camera);
  }

  // Compact objective readouts. Both only change when a point changes hands, so
  // they are rebuilt on that signature rather than sixty times a second.
  refreshObjectiveText() {
    let sig = '';
    for (const z of this.zones) sig += z.owner + 1;
    if (sig === this.objSig) return;
    this.objSig = sig;
    let label = '';
    for (const z of this.zones) {
      label += `${z.key}${z.owner === 0 ? '✚' : z.owner === 1 ? '✖' : '·'} `;
    }
    this.zoneLabel = label.trim();
    const held = this.allyZones || 0;
    const theirs = this.enemyZones || 0;
    this.objText = held === this.zones.length
      ? 'Every point held — bleed them out'
      : held === 0 && theirs > 0
        ? `Retake a point — they hold ${theirs}`
        : `Capture and hold A · B · C — you hold ${held} of ${this.zones.length}`;
  }

  // The minimap payload is rebuilt in place: the HUD reads it every frame and
  // reallocating three zone objects sixty times a second is a waste.
  mapOptions() {
    const p = this.player;
    let o = this.mapOpts;
    if (!o) {
      o = this.mapOpts = {
        zones: this.zones.map((z) => ({ x: z.x, z: z.z, r: z.r, owner: -1, progress: 0, label: z.key })),
        viewCone: { yaw: 0, fov: 1.2, range: 260 },
        spawns: [
          { x: -330, z: 0, team: 0, r: 70 },
          { x: 330, z: 0, team: 1, r: 70 },
        ],
        title: this.plan && this.plan.bracket
          ? `Ground Domination · BR ${this.plan.br} · bracket ${this.plan.bracket.label}`
          : 'Ground Domination',
      };
    }
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      const d = o.zones[i];
      d.owner = z.owner;
      d.progress = z.capTeam === 0 ? -z.cap : z.cap;
    }
    o.viewCone.yaw = p.alive ? p.yaw + p.turretYaw : this.camYaw;
    o.viewCone.fov = (this.fov * Math.PI) / 180 * 1.4;
    o.viewCone.range = this.sniper ? 520 : 260;
    return o;
  }

  // Units the minimap may show. Realistic hides an enemy nobody has eyes on.
  // And in either mode an enemy the smoke is hiding from the player is not on
  // it: a dot on the map is a marker by another name.
  mapUnits() {
    const list = this.mapUnitList || (this.mapUnitList = []);
    list.length = 0;
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (t.team === 0) list.push(t);
      else if (this.isSpotted(t) && !this.smokeHidden(t)) list.push(t);
    }
    return list;
  }

  updateHUD(dt) {
    const hud = this.hud;
    const p = this.player;

    this.refreshObjectiveText();
    hud.updateTickets(
      this.tickets[0], this.tickets[1], TICKETS_MAX,
      this.capOwner, this.capProgress, this.zoneLabel,
    );
    hud.drawMinimap(this.mapUnits(), p, this.capOwner, true, WORLD_SIZE, this.mapOptions());
    hud.setSpeed(p.speed);
    if (hud.setMatchInfo) {
      const mi = this.matchInfo || (this.matchInfo = { timeLeft: 0, mode: 'Ground Domination', objective: '' });
      mi.timeLeft = Math.max(0, MATCH_TIME - this.time);
      mi.objective = this.objText;
      hud.setMatchInfo(mi);
    }
    hud.setCompass?.(p.yaw, this.compassMarkers());

    // panels are rebuilt a few times a second, not every frame: the HUD only
    // repaints on change and a per-frame payload is pure garbage
    this.panelT = (this.panelT || 0) - dt;
    const repaint = this.panelT <= 0;
    if (repaint) this.panelT = 0.1;

    // The spawn-point balance is the decision the whole lineup system exists to
    // create — push for one more kill or bank what you have — so it belongs on
    // screen while the player is still alive, not only on the death screen.
    if (repaint) {
      hud.setSpawnPoints?.(this.spawnPoints(), this.spawnCostFor(p.spec.id));
    }

    if (this.richHud) {
      if (repaint) {
        hud.setAmmoPanel(this.ammoPanelData(p));
        hud.setDamagePanel(p.alive ? this.damagePanelData(p) : null);
      }
    } else if (p.spec.aa) {
      hud.setAmmoLabel(`AA GUN ×${p.streamAmmo}`);
      hud.setReloadVisible(false);
      hud.setStatus(p.alive ? p : null);
    } else {
      hud.setShell(p.shellType, p.ammo, p.streamAmmo);
      hud.setStatus(p.alive ? p : null);
    }

    // the reload click is still driven from setReload, whose return value is the
    // "just became ready" edge the ammo panel's own bar does not report
    if (!p.spec.aa) {
      // the "ready" click waits for a gunner as well as a loaded breech
      const ready = p.reload <= 0 && p.modules.breech.ok && seatStaffed(p, 'gunner');
      const frac = p.reloadFrac != null
        ? p.reloadFrac
        : 1 - p.reload / (p.reloadTotal || p.spec.reload);
      if (hud.setReload(ready ? 1 : clamp(frac, 0, 1), ready) && p.alive) {
        sfx.reloadDone();
        radioCue('reload');
      }
    }

    // penetration indicator vs whatever is under the reticle (arcade only);
    // see penVerdict for why it is not computed here any more
    if (
      !this.realistic &&
      !p.spec.aa && this.aimTarget && this.aimTarget.tank.team !== p.team && p.alive
    ) {
      const hit = this.aimTarget.hit;
      const target = this.aimTarget.tank;
      const shell = p.spec.shells[p.shellType];
      const dist = p.position.distanceTo(hit.point);
      hud.setPenIndicator(this.penVerdict(target, hit, shell, dist));
    } else {
      hud.setPenIndicator(null);
    }

    // gun-convergence marker: where the barrel actually points
    // (also shown in sniper view — the turret lags behind the mouse)
    if (p.alive) {
      const muzzle = p.muzzleWorld(tmpV);
      const gdir = p.gunDirection(tmpV2);
      let dist = Math.max(20, muzzle.distanceTo(p.aimPoint));
      // a wall on the gun line takes the round there, so that is where the
      // marker goes — the player sees the house he is about to hit
      const gunEnd = tmpV3.copy(muzzle).addScaledVector(gdir, dist);
      if (clipRayToScenery(muzzle, gunEnd)) dist = Math.max(1, muzzle.distanceTo(gunEnd));
      // predicted shell impact point (with gravity drop), so the marker
      // converges onto the crosshair when the gun is laid
      const tof = dist / p.spec.shells[p.shellType].speed;
      const impact = tmpV3.copy(muzzle).addScaledVector(gdir, dist);
      impact.y -= 0.5 * 9.8 * tof * tof;
      const proj = impact.project(this.camera);
      const visible = proj.z < 1;
      hud.setGunMarker(
        (proj.x * 0.5 + 0.5) * window.innerWidth,
        (-proj.y * 0.5 + 0.5) * window.innerHeight,
        visible,
      );
    } else {
      hud.setGunMarker(0, 0, false);
    }

    // sniper optics overlay: ballistic range marks + rangefinder
    hud.setCrosshairVisible(!this.sniper);
    if (this.sniper && p.alive) {
      const v = p.spec.shells[p.shellType].speed;
      const halfTan = Math.tan((this.fov * Math.PI) / 360);
      const marks = [200, 400, 600, 800, 1000].map((R) => ({
        px: ((0.5 * 9.8 * R) / (v * v) / halfTan) * (window.innerHeight / 2),
        label: R,
      }));
      // the reticle is drawn in mils at the camera's CURRENT field of view,
      // and labelled with the optic detent it is on (H-02, K-04)
      const sv = this._scopeView || (this._scopeView = { fov: 60, step: null });
      sv.fov = this.fov;
      sv.step = opticSteps(p.spec)[this.sniperStep || 0] || null;
      hud.updateScope(marks, Math.round(this.aimDist || 0), (60 / this.fov).toFixed(1), sv);
      hud.setScopeVisible(true);
    } else {
      hud.setScopeVisible(false);
    }

    hud.setScoreboard(input.down('Tab') ? this.scoreboardData() : null);

    this.updateMarkers();
    this.syncUsage(p);

    // the player keeps the dedicated non-positional engine voice, now fed by
    // the real drivetrain rather than a speed fraction
    updateEngineSound(
      Math.abs(p.throttleInput),
      p.rpm != null ? p.rpm : Math.abs(p.speed) / p.spec.maxSpeed,
      p.alive,
      'tank',
      p.revKick === 'shift', // AV-04: the clunk on the frame of the puff
    );
  }

  compassMarkers() {
    const p = this.player;
    let list = this.compassPips;
    if (!list) {
      list = this.compassPips = this.zones.map((z) => ({ bearing: 0, label: z.key, color: '' }));
    }
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      const m = list[i];
      m.bearing = Math.atan2(z.x - p.position.x, z.z - p.position.z);
      m.color = z.owner === 0 ? '#5f9fdf' : z.owner === 1 ? '#df6a5f' : '#e8d080';
    }
    return list;
  }

  ammoPanelData(p) {
    // an entry with no rounds carried is not a shell type the vehicle has, it
    // is a hole in the spec table — do not give it a row
    const keys = Object.keys(p.spec.shells || {})
      .filter((k) => (p.spec.shells[k].count || 0) > 0);
    let d = this.ammoPayload;
    if (!d || d.vehicle !== p.id) {
      d = this.ammoPayload = {
        vehicle: p.id,
        shells: keys.map((k, i) => ({
          key: k,
          label: k,
          kind: p.spec.shells[k].kind || k,
          count: 0,
          selected: false,
          hint: i + 1,
        })),
        mg: null,
        reloadFrac: 0,
        reloadReady: false,
        reloadSeconds: 0,
        noFireReason: null,
      };
      const maxStream = p.spec.aa ? p.spec.aa.ammo : p.spec.mg ? p.spec.mg.ammo : 0;
      if (maxStream > 0) d.mg = { count: 0, label: p.spec.aa ? 'AA' : 'MG' };
      if (!d.shells.length && maxStream > 0) {
        // an SPAA carries no main-gun rounds — the belt is the weapon
        d.shells.push({ key: 'AA', label: 'AA', kind: 'HE', count: 0, selected: true, hint: '1' });
        d.mg = null;
        d.beltOnly = true;
      }
    }
    // an empty gunner's seat silences the gun outright — it is not "reloading"
    const gunnerIn = seatStaffed(p, 'gunner');
    d.noFireReason = gunnerIn ? null : 'gunner';
    if (d.beltOnly) {
      d.shells[0].count = p.streamAmmo;
      d.reloadFrac = null;
      d.reloadReady = null;
      return d;
    }
    for (const s of d.shells) {
      s.count = p.ammo[s.key] || 0;
      s.selected = p.shellType === s.key;
    }
    if (d.mg) d.mg.count = p.streamAmmo;
    const ready = p.reload <= 0 && p.modules.breech.ok && gunnerIn;
    d.reloadReady = ready;
    d.reloadFrac = ready
      ? 1
      : clamp(p.reloadFrac != null ? p.reloadFrac : 1 - p.reload / (p.reloadTotal || p.spec.reload), 0, 1);
    d.reloadSeconds = Math.max(0, p.reload);
    return d;
  }

  damagePanelData(p) {
    let d = this.dmgPayload;
    if (!d || d.vehicle !== p.id) {
      const stations = (p.crewStations && p.crewStations.length)
        ? p.crewStations
        : ['driver', 'gunner', 'loader', 'commander'].slice(0, p.spec.crew || 4);
      const mods = [];
      const push = (key, label, hudKey) => {
        if (p.modules && p.modules[key]) mods.push({ key: hudKey || key, label, state: 'ok', timer: null, src: key });
      };
      push('engine', 'Engine');
      push('transmission', 'Transmission');
      push('tracks', 'Tracks');
      push('breech', 'Gun breech');
      push('barrel', 'Gun barrel');
      push('traverse', 'Turret drive');
      push('elevation', 'Elevation drive');
      push('radiator', 'Radiator');
      mods.push({ key: 'ammo', label: 'Ammo rack', state: 'ok', timer: null, src: 'ammoRack' });
      mods.push({ key: 'fuel', label: 'Fuel', state: 'ok', timer: null, src: null });
      d = this.dmgPayload = {
        vehicle: p.id,
        kind: 'tank',
        name: p.spec.name,
        hull: 1,
        turret: 'ok',
        stations,
        crew: stations.map((r) => ({ role: roleLabel(r), key: r, state: 'ok' })),
        modules: mods,
        // Four of the six keys in the help panel command a finite resource and
        // nothing on screen counted them; the only way to learn you were out of
        // extinguishers was to press F while the tank was already burning.
        consumables: [
          { key: 'parts', label: 'Parts', count: 0, hint: 'R' },
          { key: 'fpe', label: 'FPE', count: 0, hint: 'F' },
          { key: 'firstAid', label: 'Med', count: 0, hint: 'H' },
          { key: 'smoke', label: 'Smoke', count: 0, hint: 'G' },
        ],
        fire: false,
        fireSeconds: 0,
        repairing: false,
        repairFrac: 0,
      };
      // the fire mission only earns a row on a hull that can actually call it,
      // for the same reason the key drops out of the help panel
      if (this.hasArtillery) {
        d.consumables.push({ key: 'artillery', label: 'Arty', count: 0, hint: 'T', cooldown: 0 });
      }
    }
    // The entity builds the rows itself once it knows about seat swaps
    // (moving/leaving, swap progress); the health ladder is the fallback.
    const rows = typeof p.crewPanelRows === 'function' ? p.crewPanelRows(ROLE_LABEL) : null;
    if (Array.isArray(rows) && rows.length) {
      d.crew = rows;
    } else {
      for (let i = 0; i < d.stations.length; i++) {
        const h = p.crewAlive ? p.crewAlive[d.stations[i]] : 1;
        const row = d.crew[i];
        if (!row) continue;
        row.state = h > 0.7 ? 'ok' : h > 0 ? 'damaged' : 'destroyed';
        row.health = h;
      }
    }
    for (const m of d.modules) {
      if (m.src === 'ammoRack') {
        m.state = p.modules.ammoRack && !p.modules.ammoRack.ok ? 'damaged' : 'ok';
        continue;
      }
      if (m.src === null) {
        m.state = p.burning ? 'destroyed' : 'ok';
        continue;
      }
      const mod = p.modules[m.src];
      m.state = mod.ok ? 'ok' : 'destroyed';
      m.timer = mod.ok ? null : mod.timer;
    }
    const cons = p.consumables || {};
    d.consumables[0].count = cons.repair || 0;
    d.consumables[1].count = cons.fpe || 0;
    d.consumables[2].count = cons.firstAid || 0;
    d.consumables[3].count = cons.smoke || 0;
    const arty = d.consumables[4];
    if (arty) {
      arty.count = this.artyCharges;
      arty.cooldown = Math.max(0, Math.ceil(this.artyCd));
    }
    d.hull = p.crewStations && p.crewStations.length
      ? clamp(p.crew / p.crewStations.length, 0, 1)
      : 1;
    d.turret = p.modules.traverse && !p.modules.traverse.ok
      ? 'destroyed'
      : p.modules.breech && !p.modules.breech.ok ? 'damaged' : 'ok';
    d.fire = !!p.burning;
    d.fireSeconds = p.burnTimer;
    d.repairing = !!p.repairing;
    d.repairFrac = p.repairFrac || 0;
    return d;
  }

  updateMarkers() {
    const hud = this.hud;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const eye = this.player.alive
      ? this.player.turretWorldPos(tmpV2).add(tmpV3.set(0, 0.8, 0))
      : this.camera.position;

    for (const tank of this.tanks) {
      const id = `t${tank.id}`;
      if (!tank.alive || tank === this.player) {
        hud.setMarker(id, '', 0, 0, '', false);
        continue;
      }
      const wp = tmpV.set(tank.position.x, tank.position.y + 4.5, tank.position.z);
      const dist = eye.distanceTo(wp);
      const friendly = tank.team === this.player.team;
      let visible = dist < 900;
      let scouted = false;
      let stale = false;
      if (visible && !friendly) {
        if (this.realistic) {
          // realistic: only what the team has actually seen carries a marker,
          // and smoke takes it away again. H-06: the mark decays rather than
          // blinking out — dimmed (stale) for MARK_FADE s after the spotting
          // memory lapses, so it is gone 5-10 s after line of sight is lost
          const rec = this.spotted.get(tank.id);
          const left = rec ? rec.until - this.time : -Infinity;
          visible = !!rec && left > -MARK_FADE;
          stale = visible && left < SPOT_MEMORY - 0.4; // refresh is every 0.25 s + a frame
          scouted = visible && !!rec.scout;
        } else {
          // a hull close enough to hear is marked over a crest it is behind
          visible = dist < 160 || hasLOS(eye, wp);
        }
        // ...but never through smoke: not up close, not spotted a moment ago,
        // not scouted. A mark hung over a hull the cloud is hiding is the HUD
        // showing the player exactly what the smoke was thrown to hide.
        if (visible && this.smokeHidden(tank)) visible = false;
      }
      if (visible) {
        const proj = wp.project(this.camera);
        visible = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
        if (visible) {
          const cls = friendly ? 'ally' : stale ? 'enemy stale' : 'enemy';
          const arrow = friendly ? '▽' : scouted ? '◈' : '▼';
          hud.setMarker(
            id, cls,
            (proj.x * 0.5 + 0.5) * w,
            (-proj.y * 0.5 + 0.5) * h,
            `<span class="arrow">${arrow}</span>${Math.round(dist)}m`,
            true,
          );
          continue;
        }
      }
      hud.setMarker(id, '', 0, 0, '', false);
    }

    // one marker per capture point, plus the artillery aim point while it flies
    for (const z of this.zones) {
      const cp = tmpV.set(z.x, terrainHeight(z.x, z.z) + 8, z.z);
      const proj = cp.project(this.camera);
      const vis = proj.z < 1 && Math.abs(proj.x) < 1 && Math.abs(proj.y) < 1;
      const mark = z.owner === 0 ? '◈' : z.owner === 1 ? '◆' : '◇';
      hud.setMarker(
        `zone${z.key}`, 'cap',
        (proj.x * 0.5 + 0.5) * w, (-proj.y * 0.5 + 0.5) * h,
        `${mark} ${z.key}`, vis,
      );
    }
    if (this.artyStrike) {
      const ap = tmpV.copy(this.artyStrike.point);
      ap.y += 6;
      const proj = ap.project(this.camera);
      const vis = proj.z < 1 && Math.abs(proj.x) < 1 && Math.abs(proj.y) < 1;
      const secs = Math.max(0, Math.ceil(this.artyStrike.timer));
      hud.setMarker(
        'arty', 'cap',
        (proj.x * 0.5 + 0.5) * w, (-proj.y * 0.5 + 0.5) * h,
        secs > 0 ? `✷ ARTY ${secs}s` : '✷ ARTY', vis,
      );
    } else {
      hud.setMarker('arty', '', 0, 0, '', false);
    }
  }

  smokeBlocks(from, to) {
    return !!(this.effects.blocksLineOfSight && this.effects.blocksLineOfSight(from, to));
  }

  // ---------------- smoke: what the screen hides, the HUD does not show ----
  // How opaque the smoke between two points is drawn, 0..1 — the effects
  // module's own integral of the very volume it renders. A build without it
  // falls back to the yes/no sight-line rule.
  smokeOpacity(from, to) {
    const fx = this.effects;
    if (!fx || fx.activeScreens === 0) return 0;
    if (typeof fx.smokeOpacityAlong === 'function') return fx.smokeOpacityAlong(from, to);
    return this.smokeBlocks(from, to) ? 1 : 0;
  }

  // Is this sight line veiled: blind by the game's rule, or drawn so thick the
  // target is mostly gone (SMOKE_HIDE)?
  smokeVeils(from, to) {
    const fx = this.effects;
    if (!fx || fx.activeScreens === 0) return false;
    if (this.smokeBlocks(from, to)) return true;
    return this.smokeOpacity(from, to) >= SMOKE_HIDE;
  }

  // Is this tank hidden from the player by smoke right now? Asked from two
  // eyes — the camera, which is what draws the picture (the sight in sniper
  // view, the chase camera otherwise), and the gunner's own optics on the
  // turret — and either being veiled is enough: a chase camera bobbing over
  // the top of a screen is not the crew seeing through it. A tank counts as
  // hidden when both its hull and its turret roof are veiled, so a roof poking
  // out above a thin screen still reads as a contact. Cached per tank per
  // frame: the minimap and the marker both ask.
  smokeHidden(tank) {
    if (tank._smokeT === this._smokeFrame) return tank._smokeHid;
    tank._smokeT = this._smokeFrame;
    tank._smokeHid = false;
    const fx = this.effects;
    if (!fx || fx.activeScreens === 0 || !tank.alive) return false;
    let hid = this.smokeHidesFrom(this.camera.position, tank);
    const p = this.player;
    if (!hid && p && p.alive) {
      p.turretWorldPos(smokeEye).y += 0.9;
      hid = this.smokeHidesFrom(smokeEye, tank);
    }
    tank._smokeHid = hid;
    return hid;
  }

  smokeHidesFrom(eye, tank) {
    const pos = tank.position;
    const h = tank.spec && tank.spec.hull;
    const body = h ? h.trackH + h.h * 0.5 : 1.2;
    const top = h ? h.trackH + h.h + (tank.spec.turret ? tank.spec.turret.h || 0.8 : 0.8) * 0.85 : 2.4;
    if (!this.smokeVeils(eye, smokeAt.set(pos.x, pos.y + body, pos.z))) return false;
    return this.smokeVeils(eye, smokeAt.set(pos.x, pos.y + top, pos.z));
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    resetAudio();
    for (const t of this.tanks) removeEngine('t' + t.id);
    if (this.wrecks) for (const w of this.wrecks) removeEngine('t' + w.id);
    this.effects.clearSmokeScreens?.();
    this.shake.reset();
    this.shellMgr.dispose();
    this.bullets.dispose();
    // F7: clear() deliberately keeps the ghost cache alive so a second hit on
    // the same vehicle does not rebuild it — only dispose() hands those meshes
    // and their materials back
    this.xray.dispose();
    // resetScenery() deliberately keeps the geometry it owns, so without this
    // every battle leaves its 240-520 trees resident on the GPU forever. Taken
    // off the handle when there is one, so a scenery module that ever hands
    // back something battle-local is freed through its own door.
    if (this.scenery && typeof this.scenery.dispose === 'function') this.scenery.dispose();
    else disposeScenery();
    clearKeepOuts();
    this.blockers = [];
    for (const t of this.tanks) t.dispose();
    if (this.wrecks) for (const w of this.wrecks) w.dispose();
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
    this.hud.setAmmoPanel?.(null);
    this.hud.setDamagePanel?.(null);
    this.hud.setAirPanel?.(null);
    this.hud.setMatchInfo?.(null);
    this.hud.setCompass?.(null);
    this.hud.setBlackout?.(0);
    this.hud.setBigMap?.(false);
  }
}
