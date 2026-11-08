import * as THREE from 'three';

// Where each tank's gunner's sight really looks out (wave 8, user item 6).
//
// `x, y` in the GUN frame (tank.gunGroup: origin on the trunnions, +Z along the
// bore, +X LEFT, +Y up): the objective's offset from the bore axis. The
// telescopes of the period are coaxial, carried on the gun's own cradle, so the
// aperture elevates with the gun. z is not stated: it is found once per tank by
// a ray along the bore (the objective looks out of the mantlet's face, so the
// camera sits just in front of the outside model's armour).
//
// WHAT IS MEASURED, WHAT IS SOURCED, WHAT IS NOT (research 2026-11-08).
// No dimensioned drawing of any of these mantlets was found. So x, y are MEASURED
// off published frontal photographs (Wikimedia Commons, file names below): pixels
// between the bore and the sight port, scaled by the barrel's width and the hull's
// published width at that depth, cross-checked against the mantlet's width. Good to
// about +-0.04 m on a square-on photo, worse where `basis` says oblique. These are
// the REAL offsets from the bore, not fits to the game's outside model, which may
// not have a hole there. Elevated guns in the photos make y the least sure number.
//   tiger      Two holes in the LEFT of the mantlet (tiger1.info/EN/Telescope-holes.html).
//              "TigerTank1Bovington.jpg", square-on: their midpoint 95 px left of
//              the bore, mantlet 332 px = 1.49 m -> 0.42; oblique "Tiger 131
//              front-left2 2017 Bovington" -> 0.38. y +15 px -> +0.07.
//   panther    TZF 12a on A and G (TM-E 30-451, lonesentry.com); gunner left of the
//              breech (Wikipedia). "Panzerkampfwagen V Ausf. D and G.jpg", both
//              tanks square-on: the port nearer the gun, tank's left, 0.25-0.29.
//   t34        TSh-16 (military-review.com); gunner left of the gun
//              (historyofwar.org T-34-85). "T-34-85 Tank at the Imperial War Museum
//              London.jpg", slightly oblique: the two ports average 59 px x 4 mm/px.
//   su100      TSh-19, gunner left of the gun (military-review.com "SU-100 outside
//              and inside", en.wikipedia SU-100). "SU-100 M1944 Front View
//              2017-12-24.jpg", square-on: 82 px at 3.75 mm/px, level with the bore.
//   is2        TSh-17; "narrow opening for the telescopic sight just to the left of
//              the gun", gunner left (weaponsandwarfare.com, IS-2). Only oblique
//              close-ups measured ("Mantlet left, IS-2, AHM, 2024-04-28.jpg"): the
//              weakest number here, +-0.08.
//   stuart     Telescope left of the 37 mm, coax right (afvdatabase.com M3 Stuart).
//              "M3A1 Stuart in the Bovington Tank Museum (front).jpg" and "M3-A1
//              Stuart.jpg", oblique: on a 0.19 m radius ball, 37 deg off the bore.
//   sherman76  M71D (theshermantank.com fire control); on the M34A1 the telescope is
//              right of the gun, the .30 left (theshermantank.com small arms page),
//              taken as the same on the M62, gunner right. "JGSDF M4A3E8 front view
//              at Camp Tsuchiura September 28, 2025.jpg", square-on: ports at +-77 px,
//              shield 272 px = 1.14 m; 27 px above the bore.
//   pershing   M71C beside the M10F (afvdatabase.com M26, gunner right front).
//              "T26E3-M26A1 Pershing photo1.JPG", square-on: 90 px x 4.3 mm/px.
//   cromwell   NOT sourced: neither the side nor the sight. "No. 39" and the
//              right-hand gunner come from general knowledge and cromwell.js; the
//              internal mantlet hides the port on the only photos found.
//   wirbelwind The Flakvierling's sight sits on the mount's centreline ahead of the
//              gunner's seat. Its height is a fit, and the sources disagree on the
//              sight itself (Flakvisier 40; Linealvisier; Schwebekreisvisier +
//              Erdzielfernrohr 3x8 on the Pz IV AA vehicles, tankarchives.com).
//              'Flakvisier 38' matches ui/hud.js; reflector class is the sourced part.
export const SIGHTS = Object.freeze({
  tiger: { name: 'TZF 9b', x: 0.4, y: 0.07, type: 'telescope', basis: 'photo square-on + oblique; side sourced' },
  panther: { name: 'TZF 12a', x: 0.27, y: 0.03, type: 'telescope', basis: 'photo square-on; type sourced' },
  wirbelwind: { name: 'Flakvisier 38', x: 0, y: 0.42, z: -0.35, type: 'reflector', basis: 'fit; sources disagree on the sight' },
  t34: { name: 'TSh-16', x: 0.24, y: 0.02, type: 'telescope', basis: 'photo near square-on; type + side sourced' },
  is2: { name: 'TSh-17', x: 0.3, y: 0.05, type: 'telescope', basis: 'photo oblique only; type + side sourced' },
  su100: { name: 'TSh-19', x: 0.3, y: 0, type: 'telescope', basis: 'photo square-on; type + side sourced' },
  stuart: { name: 'M70D', x: 0.12, y: 0.02, type: 'telescope', basis: 'photo oblique; side sourced on the M3A1' },
  sherman76: { name: 'M71D', x: -0.3, y: 0.1, type: 'telescope', basis: 'photo square-on (M4A3E8); type sourced, side from the M34A1' },
  pershing: { name: 'M71C', x: -0.39, y: 0.09, type: 'telescope', basis: 'photo square-on; type + gunner side sourced' },
  cromwell: { name: 'No. 39', x: -0.2, y: 0.02, type: 'telescope', basis: 'UNSOURCED estimate' },
});

const FALLBACK = { x: 0.2, y: 0.03, type: 'telescope' };

const _ray = new THREE.Raycaster();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

function outsideMeshes(tank) {
  const list = [];
  if (!tank.group || typeof tank.group.traverse !== 'function') return list;
  const recoil = tank.gunGroup && tank.gunGroup.userData ? tank.gunGroup.userData.recoilGroup : null;
  tank.group.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const m = o.material;
    if (!m || m.colorWrite === false || m.visible === false) return;
    if (o.name === 'contactShadow' || o.name === 'shadowProxy') return;
    if (recoil && o.parent === recoil) return; // the barrel and its brake: not an obstacle (see below)
    list.push(o);
  });
  return list;
}

// The aperture, gun frame: [x, y, z]. Cached on the tank.
export function sightAperture(tank) {
  if (tank._sightAp) return tank._sightAp;
  const s = (tank.spec && SIGHTS[tank.spec.id]) || FALLBACK;
  let z = s.z;
  if (!Number.isFinite(z)) {
    z = 0.35;
    try {
      const meshes = outsideMeshes(tank);
      const g = tank.gunGroup;
      g.updateWorldMatrix(true, false);
      const R = 3;
      _o.set(s.x, s.y, R).applyMatrix4(g.matrixWorld);
      _d.set(0, 0, -1).transformDirection(g.matrixWorld);
      _ray.set(_o, _d);
      _ray.near = 0;
      _ray.far = R + 1.2;
      const hits = meshes.length ? _ray.intersectObjects(meshes, false) : [];
      if (hits.length) z = R - hits[0].distance + 0.04;
    } catch (e) {
      /* a stub model: the default stands */
    }
  }
  tank._sightAp = [s.x, s.y, z];
  return tank._sightAp;
}

/**
 * The gunner's sight origin in the world (the sniper camera and the aim ray
 * start here). The reticle's line of sight runs from this point; the gun lays
 * on whatever that line hits (battle.js aimPoint), so the parallax between the
 * objective and the bore closes at the aim point at every range, with no
 * separate zeroing range to get wrong.
 */
export function gunSightOrigin(tank, out) {
  const g = tank && tank.gunGroup;
  if (!g) return out.set(0, 0, 0);
  const a = sightAperture(tank);
  g.updateWorldMatrix(true, false);
  return out.set(a[0], a[1], a[2]).applyMatrix4(g.matrixWorld);
}

/**
 * The outside model while the player looks through the sight: not drawn. A real
 * objective focused at infinity sees nothing of a barrel 20 cm beside it (it is
 * a blur across the whole aperture), and the view may lead a turret still
 * traversing.
 *
 * tank.group.visible itself must stay true: combat/ballistics.js intersectTank
 * treats an invisible group as a tank that is not there, so hiding the root made
 * the player unhittable. The root's children are hidden instead: their matrices
 * still update, and the hit boxes never depended on them. Called every frame, so
 * a child added while the sight is up is hidden too; only what this function hid
 * is shown again.
 */
export function sightHidesOwnTank(tank, on) {
  const g = tank && tank.group;
  if (!g || !g.children) return;
  if (on) {
    const hidden = tank._sightHidden || (tank._sightHidden = []);
    for (const c of g.children) {
      if (c.visible) {
        c.visible = false;
        hidden.push(c);
      }
    }
  } else if (tank._sightHidden) {
    for (const c of tank._sightHidden) c.visible = true;
    tank._sightHidden = null;
  }
}
