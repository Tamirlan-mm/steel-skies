// CONVOY — a ground mode (wave 5). One side escorts a column of lorries down
// the map's road from its own end to the far edge, the other side lies in wait
// along the way. Built on Ground Domination (game/battle.js): the same tanks,
// shells, spotting, respawns, tickets and settlement; what changes is the
// objective, the spawns and what the AI is told to go and do.
//
//   * five lorries leave the escort's end of the terrain road (terrain.js
//     features.road; on the town map that road is the main street) at walking
//     pace, keep station, pull out round a wreck or a hull parked in the lane,
//     and stop for neither fire nor anything else;
//   * two lorries through and the escort wins; four burned (so that two can
//     no longer arrive) and the ambush wins; tickets bleed as usual (KILL_COST a tank, TRUCK_TICKETS a lorry,
//     either way) and a team on zero tickets loses; at the time limit the
//     convoy has failed;
//   * the ambush spawns well ahead of the column and off to one flank, the
//     escort with and then behind the column;
//   * AI: both teams' plans are handed moving objectives (TankAI setObjectives)
//     — the escort a point ahead of the lead lorry and one on the ambush flank,
//     the ambush its firing positions ahead of the column and, once the column
//     is in reach, the column itself. tankAI.js targets the lorries through
//     battle.softTargets (they duck-type a hull and carry targetPriority).
//
// The player is always team 0; which role team 0 plays is rolled per battle
// (opts.role = 'escort' | 'ambush' forces it). Rewards: lorries the player
// destroys are ground kills, lorries delivered while the player's side is the
// escort are `convoyTrucks` (progress.settle), riding with the column pays the
// zone-control tick.

import * as THREE from 'three';
import { Battle } from './battle.js';
import { Truck } from '../vehicles/groundUnits.js';
import { terrainHeight, terrainFeatures } from '../world/terrain.js';
import { propSegmentHit, solidPushOut } from '../world/scenery.js';
import { REWARD } from './progress.js';
import { sfx3d, radioCue } from '../core/audio.js';
import { BLAST_KG } from '../combat/blast.js';
import { clamp, rand } from '../core/utils.js';

export const CONVOY = Object.freeze({
  trucks: 5,
  need: 2,             // lorries through for the escort; burn trucks - need + 1 (4) for the ambush
  spacing: 17,         // m between lorries
  speed: 5.0,          // m/s on the road (18 km/h)
  startS: 24,          // m along the route the lead... rear lorry starts
  endMargin: 26,       // m short of the road's end counts as through
  tickets: 1600,
  truckTickets: 240,
  matchTime: 13 * 60,
  hp: 105,
  // what one round does to a lorry: solid shot punches clean through the
  // soft body (ten to stop it — engine, cab, driver), a high-explosive shell
  // wrecks it in five, a machine gun in about two hundred and fifty rounds
  apDamage: 11,
  heDamage: 22,
  mgFactor: 0.35,   // of a bullet's damage to a hull: rifle-calibre rounds through sheet steel and canvas
});

const LANE_MAX = 6.5;      // m either side of the crown a lorry will pull out
const LOOK = 12;           // m ahead a lorry checks its lane
const BYPASS_AFTER = 1.2;  // s blocked before it pulls out
const AMBUSH_OFF = 150;    // m off the road the ambush spawns
const AMBUSH_AHEAD = 0.66; // of the route: where the ambush spawns at the start
const OBJ_EVERY = 2;       // s between objective refreshes
const OBJ_MOVE = 28;       // m an objective may drift before it is re-issued
const SMOKE_CD = 25;       // s: a lorry under fire screens itself this often
const MARK_FOR = 15;       // s an ambusher who hit a lorry stays the escort's first target
const ESCORT_TICK = 60;    // m from a live lorry that counts as riding escort
const TRUCK_PRIORITY = 40; // m of range a lorry is worth over a tank to an ambusher
const TRUCK_ENGAGE = 380;  // m: the AI does not waste rounds on a lorry further off

const tmpV = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const disc = new THREE.Vector4();
const shove = new THREE.Vector3();

// ---------------------------------------------------------------------------
// the route

function routeOf(points, reverse) {
  const pts = points.map((p) => ({ x: p.x, z: p.z }));
  if (reverse) pts.reverse();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const total = cum[cum.length - 1];
  const at = (s, out = {}) => {
    const S = clamp(s, 0, total);
    let i = 0;
    while (i < pts.length - 2 && cum[i + 1] < S) i++;
    const a = pts[i];
    const b = pts[i + 1];
    const L = cum[i + 1] - cum[i] || 1;
    const f = (S - cum[i]) / L;
    out.x = a.x + (b.x - a.x) * f;
    out.z = a.z + (b.z - a.z) * f;
    out.tx = (b.x - a.x) / L;
    out.tz = (b.z - a.z) / L;
    // left normal
    out.nx = -out.tz;
    out.nz = out.tx;
    return out;
  };
  return { pts, cum, total, at };
}

// ---------------------------------------------------------------------------
// a lorry that drives the route

const TRUCK_SPEC = Object.freeze({
  id: 'convoy_truck',
  name: 'Lorry',
  klass: 'Truck',
  hull: { w: 2.2, len: 6.0, h: 1.3, trackH: 0.45 },
  turret: { w: 1.6 },
  armor: {
    hull: { front: 6, side: 4, rear: 4, top: 2 },
    turret: { front: 4, side: 4, rear: 4, top: 0 },
  },
});

class ConvoyTruck extends Truck {
  constructor(scene, team, index, route, s) {
    super(scene, team, 100, 0, index);
    this.route = route;
    this.s = s;
    this.lat = 0;
    this.latTarget = 0;
    this.speed = 0;
    this.yaw = 0;
    this.turretYaw = 0;
    this.blockedFor = 0;
    this.clearFor = 0;
    this.arrived = false;
    this.hp = CONVOY.hp;
    this.spec = TRUCK_SPEC;
    this.targetPriority = TRUCK_PRIORITY;
    this.engageRange = TRUCK_ENGAGE;
    this.displayName = `Convoy lorry ${index + 1}`;
    this.name = this.displayName;
    this.id = `lorry${index}`;
    this.isTruck = true;
    this.group.rotation.order = 'YXZ';
    this.p = {};
    this.place();
  }

  turretWorldPos(out) {
    return out.set(this.position.x, this.position.y + 1.6, this.position.z);
  }

  // Truck.update calls this every frame it is alive; the constructor of the
  // base class calls it before the route exists (and gets nothing).
  place() {
    if (!this.route) return;
    const p = this.route.at(this.s, this.p);
    const x = p.x + p.nx * this.lat;
    const z = p.z + p.nz * this.lat;
    const y = terrainHeight(x, z);
    // heading: along the road, turned by the drift across it
    const drift = this.speed > 0.3 ? clamp((this.latTarget - this.lat) * 0.25, -0.35, 0.35) : 0;
    const yaw = Math.atan2(p.tx, p.tz) + drift;
    this.yaw = yaw;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const hf = terrainHeight(x + fx * 2.2, z + fz * 2.2);
    const hb = terrainHeight(x - fx * 2.2, z - fz * 2.2);
    this.group.position.set(x, y, z);
    this.group.rotation.set(-Math.atan2(hf - hb, 4.4), yaw, 0, 'YXZ');
  }
}

// ---------------------------------------------------------------------------

export class ConvoyBattle extends Battle {
  constructor(renderer, playerSpecId, hud, onEnd, opts = {}) {
    super(renderer, playerSpecId, hud, onEnd, { ...opts, mode: 'convoy' });
  }

  get matchTime() {
    return CONVOY.matchTime;
  }

  // Battle's constructor calls this before the zones and the spawns.
  prepareMode() {
    const role = this.modeOpts.role === 'escort' || this.modeOpts.role === 'ambush'
      ? this.modeOpts.role
      : Math.random() < 0.5 ? 'escort' : 'ambush';
    this.playerRole = role;
    this.escortTeam = role === 'escort' ? 0 : 1;
    this.ambushTeam = 1 - this.escortTeam;
    this.tickets = [CONVOY.tickets, CONVOY.tickets];
    this.ticketsMax = CONVOY.tickets;
    this.modeLabel = this.town ? 'Town Convoy' : 'Convoy';

    // the route runs from the escort's end of the road (team 0 spawns at -x)
    const road = terrainFeatures().road || [];
    const first = road[0];
    const last = road[road.length - 1];
    const escortSign = this.escortTeam === 0 ? -1 : 1;
    const reverse = first && last ? Math.sign(last.x) === escortSign : false;
    this.route = routeOf(road, reverse);
    // the ambush lies off one flank: whichever side has more room on the map
    const mid = this.route.at(this.route.total * AMBUSH_AHEAD);
    const room = (side) => {
      const x = mid.x + mid.nx * side * AMBUSH_OFF;
      const z = mid.z + mid.nz * side * AMBUSH_OFF;
      return Math.max(Math.abs(x), Math.abs(z));
    };
    this.ambushSide = room(1) <= room(-1) ? 1 : -1;
    if (Math.random() < 0.35 && room(-this.ambushSide) < 395) this.ambushSide = -this.ambushSide;

    this.trucks = [];
    for (let i = 0; i < CONVOY.trucks; i++) {
      // index 0 leads
      const s = CONVOY.startS + (CONVOY.trucks - 1 - i) * CONVOY.spacing;
      this.trucks.push(new ConvoyTruck(this.scene, this.escortTeam, i, this.route, s));
    }
    this.softTargets = this.trucks;
    this.bulletTargets = [];
    this.trucksThrough = 0;
    this.trucksLost = 0;
    this.playerTrucks = 0;   // delivered while the player's side escorted
    this.objSeq = 0;
    this.objT = 0;
    this.objPub = [null, null];
    this.escortTickT = 0;
  }

  // nothing to capture: the lorries are the objective
  buildZones() {
    this.zones = [];
    this.capOwner = -1;
    this.capProgress = 0;
    this.allyZones = 0;
    this.enemyZones = 0;
  }

  afterSpawns() {
    this.refreshObjectives(true);
    this.notify(this.playerRole === 'escort'
      ? `Escort the convoy — get ${CONVOY.need} lorries through`
      : `Ambush the convoy — burn ${CONVOY.trucks - CONVOY.need + 1} lorries before ${CONVOY.need} get through`, 'info');
  }

  // ---- spawns ----
  leadS() {
    let s = 0;
    for (const t of this.trucks) if (t.alive && !t.arrived) s = Math.max(s, t.s);
    return s || CONVOY.startS;
  }

  rearS() {
    let s = Infinity;
    for (const t of this.trucks) if (t.alive && !t.arrived) s = Math.min(s, t.s);
    return Number.isFinite(s) ? s : this.leadS();
  }

  teamSpawnPose(team, slot) {
    const R = this.route;
    if (!R) return super.teamSpawnPose(team, slot);
    const k = Math.floor(slot) || 0;
    let s;
    let lat;
    if (team === this.escortTeam) {
      // with the column at the start, behind it afterwards
      const base = this.time > 1 ? Math.max(12, this.rearS() - 45) : CONVOY.startS + CONVOY.spacing * 2;
      s = base - k * 13 + (slot % 1 ? 6 : 0);
      lat = (k % 2 ? 1 : -1) * (9 + (k % 3) * 3);
    } else {
      const ahead = this.time > 1
        ? Math.min(R.total - 70, this.leadS() + 240)
        : R.total * AMBUSH_AHEAD;
      s = ahead + (k - 1.5) * 28;
      lat = this.ambushSide * (AMBUSH_OFF + rand(-12, 12));
    }
    const p = R.at(clamp(s, 8, R.total - 8));
    let x = clamp(p.x + p.nx * lat, -400, 400);
    let z = clamp(p.z + p.nz * lat, -400, 400);
    // never in a house or a wood's rock: step along until the spot is clear
    for (let i = 0; i < 12; i++) {
      disc.set(x, terrainHeight(x, z), z, 3.2);
      if (!solidPushOut(disc, shove)) break;
      x = clamp(x + shove.x + p.tx * 4, -400, 400);
      z = clamp(z + shove.z + p.tz * 4, -400, 400);
    }
    // face down the road (escort) or toward it (ambush)
    const yaw = team === this.escortTeam
      ? Math.atan2(p.tx, p.tz)
      : Math.atan2(p.x - x, p.z - z);
    return { x, z, yaw };
  }

  // ---- objectives for the AI ----
  // Moving points with fresh keys whenever they move on, so every crew on the
  // side re-plans (TankAI keeps its hold point while the key is unchanged).
  objectivesFor(team) {
    const R = this.route;
    const lead = this.leadS();
    const rear = this.rearS();
    const out = [];
    if (team === this.escortTeam) {
      const a = R.at(Math.min(R.total - 10, lead + 40));
      const side = this.objSeq % 2 ? 1 : -1;
      out.push({ key: `E${this.objSeq}`, x: a.x + a.nx * side * 14, z: a.z + a.nz * side * 14, r: 24, owner: -1 });
      const m = R.at((lead + rear) / 2);
      out.push({ key: `F${this.objSeq}`, x: m.x + m.nx * this.ambushSide * 45, z: m.z + m.nz * this.ambushSide * 45, r: 28, owner: -1 });
    } else {
      // firing positions ahead of the column; once it is close, the column
      const near = this.nearestAmbusherTo(lead);
      if (near < 230) {
        const m = R.at((lead + rear) / 2);
        out.push({ key: `K${this.objSeq}`, x: m.x + m.nx * this.ambushSide * 30, z: m.z + m.nz * this.ambushSide * 30, r: 30, owner: -1 });
      }
      const h = R.at(Math.min(R.total - 40, lead + 170));
      out.push({ key: `H${this.objSeq}`, x: h.x + h.nx * this.ambushSide * 60, z: h.z + h.nz * this.ambushSide * 60, r: 26, owner: -1 });
      const g = R.at(Math.min(R.total - 30, lead + 110));
      out.push({ key: `G${this.objSeq}`, x: g.x - g.nx * this.ambushSide * 50, z: g.z - g.nz * this.ambushSide * 50, r: 24, owner: -1 });
    }
    for (const o of out) {
      o.x = clamp(o.x, -405, 405);
      o.z = clamp(o.z, -405, 405);
    }
    return out;
  }

  nearestAmbusherTo(s) {
    const p = this.route.at(s, tmpC);
    let best = Infinity;
    for (const t of this.tanks) {
      if (!t.alive || t.team !== this.ambushTeam) continue;
      best = Math.min(best, Math.hypot(t.position.x - p.x, t.position.z - p.z));
    }
    return best;
  }

  refreshObjectives(force = false) {
    for (const team of [0, 1]) {
      const next = this.objectivesFor(team);
      const pub = this.objPub[team];
      let stale = force || !pub || pub.length !== next.length;
      if (!stale) {
        for (let i = 0; i < next.length; i++) {
          if (next[i].key[0] !== pub[i].key[0] || Math.hypot(next[i].x - pub[i].x, next[i].z - pub[i].z) > OBJ_MOVE) {
            stale = true;
            break;
          }
        }
      }
      if (!stale) continue;
      this.objSeq++;
      for (const o of next) o.key = o.key[0] + this.objSeq;
      this.objPub[team] = next;
      // one bot per team carries the override to the whole team's plan
      const ai = this.ais.find((a) => a.tank.team === team && a.tank.alive) || this.ais.find((a) => a.tank.team === team);
      if (ai) ai.setObjectives(next);
    }
  }

  spawnTank(specId, team, isPlayer, slot = 0) {
    const tank = super.spawnTank(specId, team, isPlayer, slot);
    // a fresh crew (a respawn) joins the plan its side was given
    if (!isPlayer && this.objPub && this.objPub[team]) {
      const ai = this.ais[this.ais.length - 1];
      if (ai && ai.tank === tank) ai.setObjectives(this.objPub[team]);
    }
    return tank;
  }

  // ---- the frame ----
  update(dt) {
    if (this.finished) return;
    // the bullet manager is handed the lorries alongside the tanks
    const bt = this.bulletTargets;
    bt.length = 0;
    for (const t of this.tanks) bt.push(t);
    for (const t of this.trucks) if (t.alive && !t.arrived) bt.push(t);
    this.sweepShellsAtTrucks(dt);
    super.update(dt);
    if (this.finished) return;
    this.driveConvoy(dt);
    for (const t of this.tanks) {
      if (t.priorityUntil && this.time > t.priorityUntil) {
        t.targetPriority = 0;
        t.priorityUntil = 0;
      }
    }
    this.objT -= dt;
    if (this.objT <= 0) {
      this.objT = OBJ_EVERY;
      this.refreshObjectives(false);
    }
  }

  // Rounds meet a lorry before ShellManager moves them this frame: a straight
  // sweep over the step (gravity drop is millimetres at 60 Hz) against each
  // lorry's capsule, with a wall in front of it taking the round first.
  sweepShellsAtTrucks(dt) {
    const shells = this.shellMgr && this.shellMgr.shells;
    if (!shells || !shells.length) return;
    for (let i = shells.length - 1; i >= 0; i--) {
      const s = shells[i];
      const p0 = s.pos;
      tmpA.copy(s.pos).addScaledVector(s.vel, dt);
      tmpA.y -= 4.9 * dt * dt;
      let hitTruck = null;
      let hitT = Infinity;
      for (const t of this.trucks) {
        if (!t.alive || t.arrived) continue;
        if (s.shooter && s.shooter.team === t.team && !this.realistic) continue;
        const c = t.position;
        // broad phase
        const segLen = p0.distanceTo(tmpA);
        if (tmpV.set(c.x, c.y + 1.2, c.z).distanceTo(p0) > segLen + 5) continue;
        const n = Math.max(2, Math.ceil(segLen / 0.45));
        const fx = Math.sin(t.yaw);
        const fz = Math.cos(t.yaw);
        for (let k = 0; k <= n; k++) {
          const f = k / n;
          const x = p0.x + (tmpA.x - p0.x) * f;
          const y = p0.y + (tmpA.y - p0.y) * f;
          const z = p0.z + (tmpA.z - p0.z) * f;
          // capsule axis: 2.2 m forward, 2.1 m back, 1.25 m up
          const dx = x - c.x;
          const dz = z - c.z;
          const along = clamp(dx * fx + dz * fz, -2.1, 2.2);
          const qx = c.x + fx * along;
          const qz = c.z + fz * along;
          const qy = c.y + 1.25;
          const d2 = (x - qx) ** 2 + (y - qy) ** 2 + (z - qz) ** 2;
          if (d2 <= 1.2 * 1.2) {
            if (f < hitT) {
              hitT = f;
              hitTruck = t;
            }
            break;
          }
        }
      }
      if (!hitTruck) continue;
      const point = tmpB.copy(p0).lerp(tmpA, hitT);
      // a wall, a roof or a rock between the round and the lorry stops it
      if (propSegmentHit(p0, point, null)) continue;
      this.shellMgr.retire(s);
      shells.splice(i, 1);
      this.effects.impactSparks(point, true);
      const he = s.kind === 'HE' || s.kind === 'HEAT';
      this.hitTruck(hitTruck, s.shooter, he ? CONVOY.heDamage : CONVOY.apDamage, point);
    }
  }

  hitTruck(truck, shooter, dmg, point = null) {
    if (!truck.alive || truck.arrived) return;
    if (shooter) this.tagDamage(truck, shooter);
    // the column screens itself: the driver throws a smoke pot on the side
    // the fire is coming from
    if (this.time - (truck.smokeAt ?? -1e9) > SMOKE_CD && this.effects.smokeScreen) {
      truck.smokeAt = this.time;
      const p = truck.position;
      let ox = 0;
      let oz = 0;
      if (shooter && shooter.position) {
        const dx = shooter.position.x - p.x;
        const dz = shooter.position.z - p.z;
        const l = Math.hypot(dx, dz) || 1;
        ox = (dx / l) * 7;
        oz = (dz / l) * 7;
      }
      this.effects.smokeScreen(tmpC.set(p.x + ox, terrainHeight(p.x + ox, p.z + oz), p.z + oz), 10, 22);
    }
    // and whoever did it becomes the escort's first concern (tankAI reads
    // targetPriority off any target)
    if (shooter && shooter.spec && !shooter.isTruck && shooter.team !== truck.team) {
      shooter.targetPriority = 90;
      shooter.priorityUntil = this.time + MARK_FOR;
    }
    if (shooter === this.player && truck.team !== this.player.team) {
      this.playerHits++;
      this.hud.hitMessage?.('Hit — lorry', 'good');
    }
    if (truck.takeDamage(dmg)) this.onTruckKilled(shooter || truck.lastAttacker || null, truck);
    else if (point) this.effects.ricochetSparks(point);
  }

  onTruckKilled(killer, truck) {
    this.trucksLost++;
    this.tickets[truck.team] -= CONVOY.truckTickets;
    const pos = tmpV.copy(truck.position);
    pos.y += 1.2;
    this.effects.explosion(pos.clone(), BLAST_KG.groundTarget);
    this.effects.wreckSmoke?.(truck.position.clone(), false);
    sfx3d.explosion(truck.position, { size: 1.2, kg: BLAST_KG.groundTarget });
    this.shake.addBlast(BLAST_KG.groundTarget, truck.position, this.camera.position);
    if (killer && killer.isPlayer && truck.team !== this.player.team) {
      this.playerGroundKills++;
      this.awardSpawnPoints({ groundKills: 1 });
      this.reward(REWARD.silver.ground, REWARD.rp.ground, true);
      this.hud.hitMessage?.('Lorry destroyed', 'kill');
      radioCue('destroyed');
    }
    this.creditAssists(killer, truck);
    this.hud.addKillfeed(
      killer ? killer.displayName : 'Fire',
      killer ? killer.team : 1 - truck.team,
      truck.displayName,
      truck.team,
    );
    const left = CONVOY.trucks - this.trucksLost - this.trucksThrough;
    if (truck.team === this.player.team) this.notify(`Lorry lost — ${left} still on the road`, 'warn');
    else this.notify(`Lorry burning — ${Math.max(0, CONVOY.trucks - CONVOY.need + 1 - this.trucksLost)} more to stop them`, 'good');
  }

  // HE and the barrage burst over lorries as well as tanks
  explosiveDamage(point, radius, shooter, label, soundSize, kg = 0, surface = null) {
    super.explosiveDamage(point, radius, shooter, label, soundSize, kg, surface);
    if (!this.trucks) return;
    for (const t of this.trucks) {
      if (!t.alive || t.arrived) continue;
      if (!this.realistic && shooter && t.team === shooter.team) continue;
      if (t.position.distanceTo(point) > radius + t.radius) continue;
      this.hitTruck(t, shooter, CONVOY.heDamage);
    }
  }

  // MG rounds on a lorry (the bullet manager reports soft targets here)
  onBulletTank(g, b, point) {
    if (g && g.isTruck) {
      if (!this.realistic && b.shooter && b.shooter.team === g.team) return;
      this.effects.impactSparks(point, false);
      this.hitTruck(g, b.shooter, (b.dmg || 1) * CONVOY.mgFactor, null);
      return;
    }
    super.onBulletTank(g, b, point);
  }

  // ---- the column ----
  driveConvoy(dt) {
    const R = this.route;
    const live = this.trucks;
    let ahead = null;
    for (let i = 0; i < live.length; i++) {
      const t = live[i];
      if (!t.alive || t.arrived) continue;
      // keep station on the lorry in front (index order = road order)
      let want = CONVOY.speed;
      if (ahead) {
        const gap = ahead.s - t.s;
        if (gap < CONVOY.spacing * 0.7) want = 0;
        else if (gap < CONVOY.spacing) want = CONVOY.speed * ((gap - CONVOY.spacing * 0.7) / (CONVOY.spacing * 0.3));
        else if (gap > CONVOY.spacing * 1.6) want = CONVOY.speed * 1.15;
      }
      // anything in the lane: a hull, a wreck, a burning lorry
      const block = this.laneBlocked(t, t.lat, LOOK);
      if (block) {
        want = 0;
        t.blockedFor += dt;
        if (t.blockedFor > BYPASS_AFTER && Math.abs(t.latTarget - t.lat) < 0.3) {
          for (const off of [4.5, -4.5, 6.5, -6.5]) {
            const lane = clamp(t.lat + off, -LANE_MAX, LANE_MAX);
            if (Math.abs(lane - t.lat) < 3) continue;
            if (!this.laneBlocked(t, lane, LOOK + 6) && this.laneFree(t, lane)) {
              t.latTarget = lane;
              t.clearFor = 0;
              break;
            }
          }
        }
      } else {
        t.blockedFor = 0;
        // back onto the crown once the way there is clear for a while
        if (t.latTarget !== 0) {
          t.clearFor += dt;
          if (t.clearFor > 3 && !this.laneBlocked(t, 0, LOOK + 8) && this.laneFree(t, 0)) t.latTarget = 0;
        }
      }
      // pull out at a walking pace, and creep while doing it
      if (Math.abs(t.latTarget - t.lat) > 0.05) {
        const step = Math.sign(t.latTarget - t.lat) * Math.min(Math.abs(t.latTarget - t.lat), 1.4 * dt);
        t.lat += step;
        if (want === 0 && block) want = 1.2;
      }
      const acc = want > t.speed ? 1.2 : 3.5;
      t.speed += clamp(want - t.speed, -acc * dt, acc * dt);
      if (t.speed < 0) t.speed = 0;
      t.s += t.speed * dt;
      t.update(dt);
      if (t.s >= R.total - CONVOY.endMargin) this.onTruckThrough(t);
      ahead = t;
    }
    // dead lorries still need their shadow gate run
    for (const t of live) if (!t.alive) t.update(dt);

    // hulls are kept out of the lorries (and a lorry is no ram: it waits)
    for (const tank of this.tanks) {
      if (!tank.alive) continue;
      for (const t of live) {
        if (t.arrived) continue;
        const dx = tank.position.x - t.position.x;
        const dz = tank.position.z - t.position.z;
        const minD = (tank.radius || 3) * 0.75 + 2.0;
        const d2 = dx * dx + dz * dz;
        if (d2 >= minD * minD || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (minD - d) / d;
        tank.position.x += dx * push;
        tank.position.z += dz * push;
        tank.speed *= 0.6;
      }
    }

    // riding with the column is the escort's zone control
    const p = this.player;
    if (p.alive && p.team === this.escortTeam && this.nearTruck(p.position, ESCORT_TICK)) {
      this.escortTickT += dt;
      if (this.escortTickT >= 5) {
        this.escortTickT -= 5;
        this.playerCapTicks++;
        this.reward(REWARD.silver.capTick, REWARD.rp.capTick);
        this.awardSpawnPoints({ capTicks: 1 });
      }
    } else {
      this.escortTickT = 0;
    }
  }

  nearTruck(pos, range) {
    for (const t of this.trucks) {
      if (!t.alive || t.arrived) continue;
      if (Math.hypot(t.position.x - pos.x, t.position.z - pos.z) < range) return true;
    }
    return false;
  }

  // Is something standing in this lorry's lane (`lat`) within `look` metres?
  laneBlocked(truck, lat, look) {
    const R = this.route;
    const p = R.at(truck.s, tmpC);
    const ox = p.x + p.nx * lat;
    const oz = p.z + p.nz * lat;
    const test = (x, z, r) => {
      const dx = x - ox;
      const dz = z - oz;
      const along = dx * p.tx + dz * p.tz;
      if (along < 1.5 || along > look + 3) return false;
      const across = Math.abs(dx * p.nx + dz * p.nz);
      return across < 1.4 + r;
    };
    for (const t of this.tanks) {
      if (!t.alive && !t.killCounted) continue;
      if (test(t.position.x, t.position.z, 1.7)) return true;
    }
    for (const w of this.wrecks || []) if (test(w.position.x, w.position.z, 1.7)) return true;
    for (const t of this.trucks) {
      if (t === truck || t.arrived) continue;
      // a live lorry ahead in the same lane is station keeping, not a block
      if (t.alive && Math.abs(t.lat - lat) < 2.5) continue;
      if (test(t.position.x, t.position.z, 1.2)) return true;
    }
    return false;
  }

  // the bypass lane itself: no house wall or boulder in it
  laneFree(truck, lat) {
    const R = this.route;
    for (const d of [3, 8, 13]) {
      const p = R.at(truck.s + d, tmpC);
      const x = p.x + p.nx * lat;
      const z = p.z + p.nz * lat;
      disc.set(x, terrainHeight(x, z), z, 1.4);
      if (solidPushOut(disc, shove)) return false;
    }
    return true;
  }

  onTruckThrough(t) {
    t.arrived = true;
    t.speed = 0;
    t.group.visible = false;
    this.trucksThrough++;
    this.tickets[1 - t.team] -= CONVOY.truckTickets;
    if (t.team === this.player.team) {
      this.playerTrucks++;
      this.reward(REWARD.silver.cap, REWARD.rp.cap, true);
      this.notify(`Lorry through — ${this.trucksThrough} of ${CONVOY.need}`, 'good');
    } else {
      this.notify(`A lorry got through — ${this.trucksThrough} of ${CONVOY.need}`, 'warn');
    }
  }

  // no capture points: the HUD's objective line, and nothing else
  updateCapture() {
    this.capOwner = -1;
    this.capProgress = 0;
  }

  checkEnd() {
    if (this.finished) return;
    const escortWon = this.trucksThrough >= CONVOY.need;
    const ambushWon = this.trucksLost > CONVOY.trucks - CONVOY.need;
    if (escortWon || ambushWon) {
      const winner = escortWon ? this.escortTeam : this.ambushTeam;
      // the tickets carry the result for Battle.checkEnd
      this.tickets[1 - winner] = Math.min(this.tickets[1 - winner], 0);
      this.tickets[winner] = Math.max(this.tickets[winner], 1);
    } else if (this.time > this.matchTime) {
      // the convoy did not make it in time
      this.tickets[this.escortTeam] = Math.min(this.tickets[this.escortTeam], 0);
      this.tickets[this.ambushTeam] = Math.max(this.tickets[this.ambushTeam], 1);
    }
    super.checkEnd();
  }

  battleResult(extra = {}) {
    return super.battleResult({
      convoyTrucks: this.playerTrucks,
      convoy: { role: this.playerRole, through: this.trucksThrough, lost: this.trucksLost },
      ...extra,
    });
  }

  refreshObjectiveText() {
    const sig = `${this.trucksThrough}|${this.trucksLost}`;
    if (sig === this.objSig) return;
    this.objSig = sig;
    const left = CONVOY.trucks - this.trucksThrough - this.trucksLost;
    this.zoneLabel = `▶${this.trucksThrough} ✖${this.trucksLost} · ${left}`;
    this.objText = this.playerRole === 'escort'
      ? `Escort the convoy — ${this.trucksThrough}/${CONVOY.need} through, ${this.trucksLost} lost`
      : `Ambush the convoy — ${this.trucksLost}/${CONVOY.trucks - CONVOY.need + 1} burned, ${this.trucksThrough} through`;
  }

  mapOptions() {
    const o = super.mapOptions();
    if (!this._convoySpawns) {
      const s0 = this.route.at(CONVOY.startS + CONVOY.spacing * 2);
      const sa = this.route.at(this.route.total * AMBUSH_AHEAD);
      this._convoySpawns = [
        { x: s0.x, z: s0.z, team: this.escortTeam, r: 45 },
        { x: sa.x + sa.nx * this.ambushSide * AMBUSH_OFF, z: sa.z + sa.nz * this.ambushSide * AMBUSH_OFF, team: this.ambushTeam, r: 60 },
      ];
      const end = this.route.at(this.route.total - CONVOY.endMargin);
      o.zones = [{ x: end.x, z: end.z, r: 20, owner: this.escortTeam, progress: 0, label: 'EXIT' }];
    }
    o.spawns = this._convoySpawns;
    return o;
  }

  mapUnits() {
    const list = super.mapUnits();
    for (const t of this.trucks) {
      if (!t.alive || t.arrived) continue;
      // the column is never hidden: the escort knows where it is and the
      // ambush can hear it (and there is a road)
      list.push(t);
    }
    return list;
  }

  compassMarkers() {
    const p = this.player;
    const list = this.compassPips || (this.compassPips = [{ bearing: 0, label: 'CONVOY', color: '' }]);
    const m = list[0];
    let best = null;
    let bd = Infinity;
    for (const t of this.trucks) {
      if (!t.alive || t.arrived) continue;
      const d = Math.hypot(t.position.x - p.position.x, t.position.z - p.position.z);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    if (best) m.bearing = Math.atan2(best.position.x - p.position.x, best.position.z - p.position.z);
    m.color = this.escortTeam === 0 ? '#5f9fdf' : '#df6a5f';
    return list;
  }

  updateMarkers() {
    super.updateMarkers();
    const hud = this.hud;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const t of this.trucks) {
      const id = t._markId || (t._markId = `cv${t.id}`);
      if (!t.alive || t.arrived) {
        hud.setMarker(id, '', 0, 0, '', false);
        continue;
      }
      const wp = tmpV.set(t.position.x, t.position.y + 4, t.position.z);
      const proj = wp.project(this.camera);
      const friendly = t.team === this.player.team;
      // simulator: the column stays on the map (it is the objective), but an
      // enemy lorry carries no on-screen tag
      const vis = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1 &&
        (friendly || !this.simulator);
      const dist = Math.round(this.camera.position.distanceTo(t.position));
      if (t._markDist !== dist) {
        t._markDist = dist;
        t._markText = `${friendly ? '▽' : '▼'} LORRY ${dist} m`;
      }
      hud.setMarker(id, friendly ? 'ally' : 'enemy', (proj.x * 0.5 + 0.5) * w, (-proj.y * 0.5 + 0.5) * h, t._markText, vis);
    }
  }

  convoyStats() {
    return {
      role: this.playerRole,
      through: this.trucksThrough,
      lost: this.trucksLost,
      lead: Math.round(this.leadS()),
      total: Math.round(this.route.total),
      speeds: this.trucks.map((t) => (t.arrived ? 'A' : t.alive ? t.speed.toFixed(1) : 'X')).join(','),
    };
  }

  dispose() {
    for (const t of this.trucks || []) t.dispose();
    super.dispose();
  }
}
