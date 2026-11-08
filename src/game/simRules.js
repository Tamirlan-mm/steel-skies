// SIMULATOR battles (wave 8): the third battle difficulty next to arcade and
// realistic, and the single place its rules live.
//
// Simulator is realistic and then some. Every rule realistic already has —
// friendly fire, no free enemy markers, no lead indicator or penetration
// chevron, the realistic flight model and tank physics — comes from reading
// `isRealisticRules(difficulty)` where the battles used to compare against the
// string 'realistic'. On top of that:
//   - the player only ever looks from inside: tank crew stations (commander,
//     driver, gunner sight / look-around, loader, radio operator) and the
//     aircraft cockpit; no third-person or chase camera while alive (the death
//     cam and spectating stay);
//   - the HUD shows what a crew would know: no enemy markers at all (spotted
//     or not), ally tags only close in, a minimap with the player, friendlies
//     and the objectives only, the damage/status panels dimmed;
//   - the bots see the way a buttoned-up crew sees (BotVision below), so a
//     player in first person is not out-spotted by an AI with eyes on stalks.
//     That covers what they can know about the HUMAN and how well they shoot
//     at him (playerOnly); bot against bot stays at realistic pace, so the
//     battle around him keeps moving. No bot prefers him for being the player.
//
// The flag on a battle is `battle.simulator` (boolean); `battle.realistic` is
// true in simulator too. Anything that is not exactly 'simulator' or
// 'realistic' is arcade, as before.

export const DIFFICULTIES = ['arcade', 'realistic', 'simulator'];
export const DIFF_LABEL = { arcade: 'Arcade', realistic: 'Realistic', simulator: 'Simulator' };
// the match-info line ("Ground Simulator", "Air Simulator")
export const DIFF_WORD = DIFF_LABEL;

export function normDifficulty(d) {
  return DIFFICULTIES.includes(d) ? d : 'arcade';
}

export function isSimulator(d) {
  return d === 'simulator';
}

// realistic rules apply (friendly fire, no free markers, realistic physics)
export function isRealisticRules(d) {
  return d === 'realistic' || d === 'simulator';
}

// what planeEntity.setDifficulty() takes: it only knows 'realistic' / arcade
export function flightModelOf(d) {
  return isRealisticRules(d) ? 'realistic' : 'arcade';
}

// ---------------------------------------------------------------------------
// WHO FOUGHT WHOM (simulator rosters)
// ---------------------------------------------------------------------------
// A simulator battle is one real front of the war, chosen from the nation the
// player brought. Team 0 is always the player's side, whichever side that is.
//   USSR               Eastern Front: Soviets against Germans
//   USA / Britain      Western Front: Americans and British against Germans
//   Germany            either front, drawn per battle
//   Japan              Pacific: Japanese against Americans and British. Japan
//                      has no tank in the game, so a Zero in a combined battle
//                      gets German armour as the Axis ground force (the one
//                      unhistorical pairing left).
const FRONTS = {
  east: { label: 'Eastern Front', axis: ['Germany'], allies: ['USSR'] },
  west: { label: 'Western Front', axis: ['Germany'], allies: ['USA', 'Britain'] },
  pacific: { label: 'Pacific', axis: ['Japan'], allies: ['USA', 'Britain'] },
};

// { label, own: [nations], enemy: [nations] }. For a nation the game does not
// know: null (the battle falls back to the ordinary mixed roster).
export function frontText(front) {
  return `${front.label}: ${front.own.join(' + ')} against ${front.enemy.join(' + ')}`;
}

export function frontFor(nation, rng = Math.random) {
  if (nation === 'USSR') return { label: FRONTS.east.label, own: FRONTS.east.allies, enemy: FRONTS.east.axis };
  if (nation === 'USA' || nation === 'Britain') return { label: FRONTS.west.label, own: FRONTS.west.allies, enemy: FRONTS.west.axis };
  if (nation === 'Japan') return { label: FRONTS.pacific.label, own: FRONTS.pacific.axis, enemy: FRONTS.pacific.allies };
  if (nation === 'Germany') {
    const f = rng() < 0.5 ? FRONTS.east : FRONTS.west;
    return { label: f.label, own: f.axis, enemy: f.allies };
  }
  return null;
}

// HUD rules for simulator (the battles read these)
export const SIM_HUD = {
  allyMarkerRange: 260,     // m: a friendly is tagged only this close (tanks)
  allyMarkerRangeAir: 900,  // m: a friendly aeroplane
  panelOpacity: 0.28,       // damage / status panels, as in a crew station
};

// ---------------------------------------------------------------------------
// BOT VISION
// ---------------------------------------------------------------------------
// Occlusion is the battle's own (terrain, walls, smoke); this decides whether
// a crew that COULD see a target actually picks it out, how long it takes them
// to recognise it and react, and when they lose it again. One BotVision per
// bot, keyed by target object. It is fed only targets the caller has already
// found in line of sight (observe) and is told about the rest (unseen), so
// nothing here can ever give a bot knowledge of a target it has not seen.
//
// Detection is a Poisson process on each sight line: rate
//   lambda = RATE * size * motion * firing * conceal * (1 - d / R)^1.3
// per second while the line is open, for d < R. R itself scales with the same
// signature terms (a firing, moving, big target is picked out further away).
// After detection a recognition delay of 1.5..4 s (longer with range) has to
// pass before the bot engages. A target out of sight for LOSE seconds is
// forgotten and has to be found again from scratch.
export const SIM_VISION = {
  tank: {
    range: 850,          // m: full signature; x buttoned x still gives ~470 m
    rate: 1.1,           // 1/s near zero range
    buttoned: 0.8,       // bots are always treated as buttoned up
    stillFactor: 0.7,    // a stationary target
    movingFactor: 1.15,  // flat out
    firingFactor: 1.4,   // fired in the last 3 s (flash, dust, smoke)
    burningFactor: 1.5,
    foliageFactor: 0.3,  // seen only through trees / a hedge
    attackerFactor: 1.6, // the hull that just hit us: the crew look for it
    recogMin: 1.5,
    recogMax: 4.0,
    lose: 3.5,           // s out of sight before the contact is dropped
    aimNear: 1.45,       // a crew's error even close in (realistic = 1)
    aimFar: 0.9,         // extra aim error per 400 m beyond 200 m
    // The rules below are what actually moved deaths in the full-battle A/B
    // (wave 8; duels had improved, battles had not: nearly all shots are
    // inside 300 m, where a detection roll is over in a second or two).
    playerOnly: true,    // the limits apply to what bots can know about the
    //                      human. Bot against bot stays at realistic pace, so
    //                      the battle around him does not slow down and his
    //                      own side keeps killing at its usual rate.
    arcFront: 0.5,       // cos: within 60 deg of the gun the crew are looking
    arcRear: 0.3,        // dead astern of the turret (flanking pays)
    bracket: [2.4, 1.8, 1.35], // aim error of the 1st, 2nd, 3rd round at this
    //                      target: a real crew ranges in, the first round is
    //                      rarely the one that hits
    layDelay: [0.8, 2.2],// s on top of the reaction: traverse order, lay, fire
  },
  air: {
    range: 1400,         // m: a fighter against the sky
    rate: 0.6,
    coneCos: Math.cos((105 * Math.PI) / 180), // the pilot's search field
    rearFactor: 0.22,    // checking six: possible, but rarely
    belowFactor: 0.55,   // under the nose / wing
    firingFactor: 1.5,
    attackerFactor: 2.5,
    trackRange: 2000,    // a known bandit is kept in sight this far
    trackRearRange: 700, // ... but out of the search field only this far:
    //                      break away from him and he has to find you again
    playerOnly: true,    // as tank.playerOnly
    recogMin: 1.5,
    recogMax: 3.0,
    lose: 4.0,
    aimMult: 4.5,        // looser gunnery from a pilot with no lead computer
    //                      (held about a second at a time: planeAI attackAir)
    aimFloor: 250,       // m: and he is no better than this even close in
  },
  // a field AA gun's crew against the player's aeroplane (simAAPlanes)
  aa: {
    range: 1100,
    rate: 0.45,
    recogMin: 1.5,
    recogMax: 3.5,
    lose: 4.0,
    trackMax: 7,         // s on one track before the layers lose him
    gap: [3, 7],         // s before they start looking again
  },
  // aircraft looking at the ground (strikers, the player's tank)
  ground: {
    range: 1500,
    rate: 0.6,
    lose: 6.0,
    recogMin: 1.5,
    recogMax: 3.5,
  },
};

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Tank-size factor: a Tiger is easier to pick out than a Stuart. ~1 for a
// Sherman-sized hull (frontal area about 2.6 x 2.7 m).
export function sizeFactor(spec) {
  const h = spec && spec.hull;
  if (!h) return 1;
  const area = (h.w || 2.6) * ((h.h || 1.6) + (h.trackH || 0.9) + (spec.turret && spec.turret.h ? spec.turret.h : 0.7));
  return Math.max(0.7, Math.min(1.35, Math.sqrt(area / 8.5)));
}

export class BotVision {
  constructor(kind = 'tank') {
    this.kind = kind;
    this.cfg = SIM_VISION[kind] || SIM_VISION.tank;
    this.clock = 0;
    this.contacts = new Map(); // target -> contact
    // tallies, for tests
    this.detections = 0;
  }

  // advance the vision clock (call once per bot frame or per sweep with the
  // elapsed time)
  tick(dt) {
    this.clock += dt;
  }

  _get(target) {
    let c = this.contacts.get(target);
    if (!c) {
      c = { detected: false, detectedAt: 0, recogAt: 0, lastSeen: -1e9, x: 0, y: 0, z: 0, seenNow: false };
      this.contacts.set(target, c);
    }
    return c;
  }

  // The caller found `target` in line of sight at distance d. `mult` is the
  // product of the signature terms (detectMult) and `dt` the time since this
  // target was last offered. Returns true once the contact is detected.
  observe(target, d, mult, dt) {
    const cfg = this.cfg;
    const c = this._get(target);
    const R = cfg.range * Math.max(0.2, mult);
    if (!c.detected) {
      if (d < R) {
        const lam = cfg.rate * Math.max(0.15, Math.min(2.5, mult)) * Math.pow(1 - d / R, 1.3);
        if (Math.random() < 1 - Math.exp(-lam * Math.max(0, dt))) {
          c.detected = true;
          c.detectedAt = this.clock;
          const f = clamp01(d / R);
          c.recogAt = this.clock + Math.max(cfg.recogMin, Math.min(cfg.recogMax,
            cfg.recogMin + (cfg.recogMax - cfg.recogMin) * f + rnd(-0.3, 0.3)));
          this.detections++;
        }
      }
    }
    if (c.detected) {
      c.lastSeen = this.clock;
      c.seenNow = true;
      const p = target.position;
      if (p) {
        c.x = p.x;
        c.y = p.y;
        c.z = p.z;
      }
    }
    return c.detected;
  }

  // keep an already-detected contact alive without a detection roll (an
  // aeroplane the pilot is turning his head to follow)
  track(target) {
    const c = this.contacts.get(target);
    if (!c || !c.detected) return false;
    c.lastSeen = this.clock;
    c.seenNow = true;
    const p = target.position;
    if (p) {
      c.x = p.x;
      c.y = p.y;
      c.z = p.z;
    }
    return true;
  }

  // the target is not in sight this sweep
  unseen(target) {
    const c = this.contacts.get(target);
    if (!c) return;
    c.seenNow = false;
    if (c.detected && this.clock - c.lastSeen > this.cfg.lose) this.contacts.delete(target);
  }

  // detected, recognised, and seen within the last LOSE seconds
  knows(target) {
    const c = this.contacts.get(target);
    return !!c && c.detected && this.clock >= c.recogAt && this.clock - c.lastSeen <= this.cfg.lose;
  }

  detected(target) {
    const c = this.contacts.get(target);
    return !!c && c.detected && this.clock - c.lastSeen <= this.cfg.lose;
  }

  // seconds still to wait before engaging (0 when recognised)
  recognitionLeft(target) {
    const c = this.contacts.get(target);
    if (!c || !c.detected) return Infinity;
    return Math.max(0, c.recogAt - this.clock);
  }

  seenNow(target) {
    const c = this.contacts.get(target);
    return !!c && c.detected && c.seenNow;
  }

  // where the target was last seen (null if never)
  lastKnown(target, out) {
    const c = this.contacts.get(target);
    if (!c || !c.detected) return null;
    return out.set(c.x, c.y, c.z);
  }

  forget(target) {
    this.contacts.delete(target);
  }

  // One sweep over the opposition: beginSweep(), observe()/track() every
  // target in sight, endSweep() — which forgets whatever has been out of
  // sight for LOSE seconds (and the dead).
  beginSweep() {
    for (const c of this.contacts.values()) c.seenNow = false;
  }

  endSweep() {
    for (const [t, c] of this.contacts) {
      if (!t || t.alive === false) this.contacts.delete(t);
      else if (!c.seenNow && (!c.detected || this.clock - c.lastSeen > this.cfg.lose)) this.contacts.delete(t);
    }
  }

  // drop contacts on dead / removed targets
  prune() {
    for (const t of this.contacts.keys()) {
      if (!t || t.alive === false) this.contacts.delete(t);
    }
  }
}

// The aeroplanes a field AA gun (vehicles/groundUnits.js AAGun) can pick a track
// from this frame: everything but the player, who has to be picked out first and
// is lost again after a while. Hand this to AAGun.update() in place of the list.
export function simAAPlanes(gun, planes, dt) {
  const cfg = SIM_VISION.aa;
  const vis = gun._simVis || (gun._simVis = new BotVision('aa'));
  const list = gun._simList || (gun._simList = []);
  list.length = 0;
  vis.tick(dt);
  for (let i = 0; i < planes.length; i++) {
    const pl = planes[i];
    if (!pl.isPlayer) {
      list.push(pl);
      continue;
    }
    if (!pl.alive || pl.team === gun.team) continue;
    vis.observe(pl, gun.position.distanceTo(pl.position), pl.firing ? 1.4 : 1, dt);
    if (vis.knows(pl)) list.push(pl);
  }
  if (gun.target && gun.target.isPlayer) {
    gun._simTrack = (gun._simTrack || 0) + dt;
    if (gun._simTrack > cfg.trackMax && gun.dropTrack) {
      vis.forget(gun.target);
      gun.dropTrack(rnd(cfg.gap[0], cfg.gap[1]));
      gun._simTrack = 0;
    }
  } else gun._simTrack = 0;
  return list;
}

// Signature multiplier of a ground target seen by a tank crew.
//   now: battle time (tank.lastFired is in it); opts: { foliage, smokeVeil,
//   attacker }
export function tankDetectMult(target, now, opts = {}) {
  const cfg = SIM_VISION.tank;
  let m = cfg.buttoned * sizeFactor(target.spec);
  const vmax = (target.spec && target.spec.maxSpeed) || 12;
  const sp = Math.min(1, Math.abs(target.speed || 0) / vmax);
  m *= cfg.stillFactor + (cfg.movingFactor - cfg.stillFactor) * Math.min(1, sp * 2.5);
  if (target.lastFired != null && now - target.lastFired < 3) m *= cfg.firingFactor;
  if (target.burning) m *= cfg.burningFactor;
  if (opts.foliage) m *= cfg.foliageFactor;
  // where the crew are looking: opts.arc = cos(gun line, bearing to target)
  if (opts.arc != null && opts.arc < cfg.arcFront) {
    m *= cfg.arcRear + (1 - cfg.arcRear) * clamp01((opts.arc + 1) / (cfg.arcFront + 1));
  }
  if (opts.smokeVeil) m *= 1 - 0.85 * clamp01(opts.smokeVeil);
  if (opts.attacker) m *= cfg.attackerFactor;
  return m;
}

// Signature multiplier of an aeroplane seen by a pilot (dir: the observer's
// unit nose vector, rel: target minus observer, d: |rel|).
export function airDetectMult(observerDir, rel, d, target, opts = {}) {
  const cfg = SIM_VISION.air;
  const inv = 1 / Math.max(1, d);
  const c = (observerDir.x * rel.x + observerDir.y * rel.y + observerDir.z * rel.z) * inv;
  let m = 1;
  if (c < cfg.coneCos) m *= cfg.rearFactor;
  // well below the observer and ahead-ish: under the nose and the wing root
  const down = -rel.y * inv;
  if (down > 0.55 && c > 0.2) m *= cfg.belowFactor;
  const span = target.spec && (target.spec.wingspan || target.spec.span);
  if (span) m *= Math.max(0.75, Math.min(1.5, span / 11.5));
  if (target.firing) m *= cfg.firingFactor;
  if (opts.attacker) m *= cfg.attackerFactor;
  return m;
}

// Extra aim error of a tank gunner at range in simulator (multiplier >= 1).
export function simAimMult(dist) {
  const c = SIM_VISION.tank;
  return c.aimNear + c.aimFar * Math.max(0, dist - 200) / 400;
}

// Extra error of the n-th round fired at this target (0 = the first).
export function simBracketMult(rounds) {
  const b = SIM_VISION.tank.bracket;
  return rounds < b.length ? b[rounds] : 1;
}
