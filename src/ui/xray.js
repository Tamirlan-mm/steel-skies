import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
// Namespace imports on purpose: this file consumes several bindings that only
// arrived with the deeper damage model (FUSE, SPALL, crewRoles, armourFace).
// A named import of a binding a module does not export is a link-time failure
// that takes the whole game down, so everything young is read off the
// namespace and defaulted below.
import * as tanksMod from '../vehicles/tanks.js';
import * as planesMod from '../vehicles/planes.js';
import * as internalsMod from '../combat/internals.js';
// The hangar inspection runs the shot through the battle's own code — the
// collision test, the plate solver and the damage model — on a throwaway
// vehicle, so these are read the same defensive way.
import * as tankEntityMod from '../vehicles/tankEntity.js';
import * as ballisticsMod from '../combat/ballistics.js';
import * as materialsMod from '../core/materials.js';
// H-05: the one penetration vocabulary (hexes, words, glyphs, legend titles)
// shared with the battle HUD. This screen is the ARMOUR perspective.
import { penLegend, penHex, hexToInt, PEN_HEX } from './penScale.js';
// a crew casualty in the hit cam wears the shared "destroyed" red (bible 4.7)
const CREW_HIT = hexToInt(PEN_HEX.red);

const { buildTankMesh } = tanksMod;
const { buildPlaneMesh } = planesMod;
const { buildInternals, MODULE_COLOR } = internalsMod;
// Cached geometry and the shared material factory are stamped by materials.js;
// a teardown here must step over them or it frees them for the battle too.
const isShared = materialsMod.isSharedResource || ((o) => !!(o && o.userData && o.userData.shared));

const armourFace = tanksMod.armourFace || null;
const shellPenAt = tanksMod.shellPenAt
  || ((shell, dist) => (shell.pen || 0) * (1 - (Math.min(dist, 1500) / 1500) * 0.25));
const PEN_SCATTER = tanksMod.PEN_SCATTER ?? 0.05;
const buildPlaneParts = planesMod.buildPlaneParts || null;
const PART_LABELS = planesMod.PART_LABELS || {};
const FUSE = internalsMod.FUSE || { APHE: { dist: 1.15, arm: 8, label: 'Shell explosion' } };
const SPALL = internalsMod.SPALL || {};
const crewRolesOf = internalsMod.crewRoles || null;

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const RED = new THREE.Color(0xff3324);
const SIDE = new THREE.Vector3(1, 0, 0);
const tmpPos = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const basisA = new THREE.Vector3();
const basisB = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpNdc = new THREE.Vector2();

// The names the player reads off a crew pip. The damage model reports the seat
// by role now, so "who did I knock out" is answerable instead of a guess.
const ROLE_LABEL = {
  driver: 'Driver',
  gunner: 'Gunner',
  loader: 'Loader',
  commander: 'Commander',
  radio: 'Radio',
};

// Mirrors of the two tables inside tankEntity.js. They are private there and
// the protection viewer has to agree with the shot it is predicting, so they
// are duplicated rather than guessed — if those numbers move, these follow.
const RICOCHET = {
  AP: [1.19, 1.36],
  APHE: [1.19, 1.36],
  APCR: [1.13, 1.26],
  HEAT: [1.36, 1.48],
  HE: [1.4, 1.52],
};
const NORMALIZATION = { AP: 0.07, APHE: 0.07, APCR: 0.035, HEAT: 0, HE: 0 };

// How the shot reads on the plate, in the order the analysis walks them.
// Colours from ui/penScale.js in the armour perspective (red = the shell gets
// through); overmatch and likely are its PEN and MARGINAL sub-steps.
export const ARMOUR_BANDS = [
  { key: 'overmatch', label: 'Overmatch' },
  { key: 'pen', label: 'Penetration' },
  { key: 'likely', label: 'Likely' },
  { key: 'marginal', label: 'Marginal' },
  { key: 'nonpen', label: 'No penetration' },
  { key: 'ricochet', label: 'Ricochet' },
].map((b) => ({ ...b, color: hexToInt(penHex(b.key, 'armour')) }));
const BAND_COLOR = {};
for (const b of ARMOUR_BANDS) BAND_COLOR[b.key] = b.color;

// Hit-camera timeline. The shell reaches the plate, an APHE round then runs on
// inside before the filler lets go, and only then does the damage land — that
// gap is the whole reason APHE is a different weapon from solid shot.
const T_APPROACH = 0.55;
const T_FUSE = 0.26;
const T_EXIT = 0.28;
const APPROACH_LEN = 4;

// ---------------------------------------------------------------------------
// text labels
//
// Sprite materials are cached and shared across every XrayView: the label
// vocabulary is fixed (five crew roles and the module names internals.js
// defines), so the cache cannot grow without bound and nothing ever has to
// dispose a texture that another view is still drawing.
// ---------------------------------------------------------------------------
const labelCache = new Map();

// ---------------------------------------------------------------------------
// ghost cache
//
// buildTankMesh is around fifty geometry constructions, a merge and half a
// dozen materials, and the hit camera used to run every one of them in the
// frame the shell landed — the single worst moment in the game to stall for.
// A spec's ghost and its internals never change, so they are built once and
// only re-tinted afterwards, exactly the way internals.js already caches its
// module layout.
//
// The entries hold live scene objects, so a ghost can only be mounted in one
// view at a time. Nothing in the game shows two X-ray views at once, and if it
// ever did the second would simply take the ghost — re-parenting, not a crash.
// ---------------------------------------------------------------------------
const ghostCache = new WeakMap();

function labelMaterial(text, color) {
  const key = `${text}|${color}`;
  const hit = labelCache.get(key);
  if (hit !== undefined) return hit;
  let mat = null;
  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (ctx) {
      const font = 'bold 44px system-ui, Segoe UI, sans-serif';
      ctx.font = font;
      const w = Math.ceil(ctx.measureText(text).width) + 26;
      canvas.width = Math.max(32, w);
      canvas.height = 64;
      const c2 = canvas.getContext('2d');
      c2.font = font;
      c2.textAlign = 'center';
      c2.textBaseline = 'middle';
      // a dark plate behind the glyphs, because the label has to stay legible
      // over a bright module box as well as over the empty scene
      c2.fillStyle = 'rgba(6, 10, 14, 0.62)';
      c2.fillRect(0, 8, canvas.width, 48);
      c2.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      c2.lineWidth = 6;
      c2.strokeText(text, canvas.width / 2, 32);
      c2.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      c2.fillText(text, canvas.width / 2, 32);
      const tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      });
      mat.userData.aspect = canvas.width / canvas.height;
    }
  }
  labelCache.set(key, mat);
  return mat;
}

function makeLabel(text, color, height = 0.34) {
  const mat = labelMaterial(text, color);
  if (!mat) return null;
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(height * (mat.userData.aspect || 3), height, 1);
  sprite.renderOrder = 20;
  sprite.frustumCulled = false;
  return sprite;
}

function setLabelColor(entry, color) {
  const mat = labelMaterial(entry.text, color);
  if (!mat) return;
  entry.sprite.material = mat;
  entry.sprite.scale.x = entry.sprite.scale.y * (mat.userData.aspect || 3);
}

// ---------------------------------------------------------------------------
// small geometry helpers
// ---------------------------------------------------------------------------

// A two-vertex line whose endpoints are rewritten in place — the hit camera
// redraws every tracer and fragment each frame and must not allocate to do it.
function makeSegment(color, opacity) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(
    geo,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
  line.frustumCulled = false;
  return line;
}

function setSegment(line, a, b) {
  const p = line.geometry.attributes.position;
  p.array[0] = a.x; p.array[1] = a.y; p.array[2] = a.z;
  p.array[3] = b.x; p.array[4] = b.y; p.array[5] = b.z;
  p.needsUpdate = true;
}

// Orthonormal frame for a plate or a cone, given its normal. Preferring world
// up keeps a panel's long edge horizontal, which is what makes a rectangle
// drawn on a sloped plate look like armour rather than a random quad.
function plateBasis(n, outRight, outUp) {
  const ref = Math.abs(n.y) > 0.94 ? FWD : UP;
  outRight.crossVectors(ref, n).normalize();
  if (outRight.lengthSq() < 1e-6) outRight.set(1, 0, 0);
  outUp.crossVectors(n, outRight).normalize();
}

// X-ray hit analysis: a self-contained mini-scene with a translucent ghost of
// the hit vehicle and its internals drawn straight from combat/internals.js —
// the same boxes the damage model traced through, so what flashes red is
// exactly what broke.
//
// Three presentations: a solid shot flies in along its recorded trajectory and
// either skids off, stops dead or punches through; an APHE round runs on
// inside and bursts at its fuse point, which is where its fragment cone starts;
// and a bomb or rocket gets a shockwave instead, because blast damage does not
// arrive as a single tidy projectile.
//
// The same scene doubles as the garage's protection analysis — see showArmour.
export class XrayView {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0f14);
    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 200);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(4, 8, 6);
    this.scene.add(dir);
    this.root = null;
    this.byKey = {};
    this.flashes = [];
    this.labels = [];
    this.fragments = [];
    // the cached ghost currently mounted, plus everything this view hung off
    // it — the ghost survives clear(), the hangers-on must not
    this.ghostGroup = null;
    this._transient = [];
    this._moduleRecs = null;
    this._ghostSpecs = new Set();
    this.blast = false;
    this.shockwave = null;
    this.burstFlash = null;
    this.shell = null;
    this.trail = null;
    this.skid = null;
    this.entry = new THREE.Vector3();
    this.pathStart = new THREE.Vector3();
    this.pathDir = new THREE.Vector3(0, 0, 1);
    this.deflectDir = new THREE.Vector3();
    this.damageAt = 0.45;
    this.fuseDist = 0;
    this.impactOpen = false; // estimateNormal: struck face is an open turret top
    this.t = 0;

    // --- protection-analysis state (mode === 'armour') ---
    this.mode = 'hit';
    this.plates = [];
    this.partBoxes = [];
    this.partMeshes = [];
    this.pickList = [];
    this.moduleMeshes = [];
    this.turretGroup = null;
    this.spec = null;
    this.kind = 'ground';
    this.stopAtArmor = false;
    this.skidLen = 4;
    this.shellRec = null;
    this.shellKey = null;
    this.range = 500;
    this.turretYaw = 0;
    this.showModules = true;
    this.autoRotate = false;
    this.orbit = { az: -0.95, el: 0.42, dist: 12, target: new THREE.Vector3() };
    this.attackDir = new THREE.Vector3(0, 0, -1);
    this.raycaster = new THREE.Raycaster();
    this.dirty = true;
  }

  clear() {
    // Plates, part boxes and their labels hang off the cached ghost rather than
    // off the root, so they come away by hand — otherwise the disposal walk
    // below would never see them and they would pile up inside the cache.
    for (const o of this._transient) {
      if (o.parent) o.parent.remove(o);
      // sprite materials come out of the shared label cache and outlive any
      // one view, so they are deliberately not disposed
      if (o.isSprite) continue;
      o.geometry?.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    }
    this._transient.length = 0;
    if (this.ghostGroup) {
      if (this.ghostGroup.parent) this.ghostGroup.parent.remove(this.ghostGroup);
      this.ghostGroup = null;
    }
    if (this.root) {
      this.scene.remove(this.root);
      this.root.traverse((o) => {
        // sprite materials are shared out of the label cache and outlive any
        // one view, so they are deliberately not touched here
        if (o.isMesh || o.isLine) {
          o.geometry?.dispose();
          if (o.material) o.material.dispose();
        }
      });
      this.root = null;
    }
    this.byKey = {};
    this.flashes = [];
    this.labels = [];
    this._moduleRecs = null;
    this.fragments = [];
    this.plates = [];
    this.partBoxes = [];
    this.partMeshes = [];
    this.pickList = [];
    this.moduleMeshes = [];
    this.turretGroup = null;
    this.shockwave = null;
    this.burstFlash = null;
    this.shell = null;
    this.trail = null;
    this.skid = null;
    this.spec = null;
    this.mode = 'hit';
    this.blast = false;
    this.fuseDist = 0;
    this.stopAtArmor = false;
  }

  // Hand back everything, cached ghosts included. clear() deliberately keeps
  // the cache — that is the whole point of it — so a screen that is finished
  // with the viewer for good calls this instead.
  dispose(spec = null) {
    this.clear();
    for (const s of spec ? [spec] : this._ghostSpecs) {
      const entry = ghostCache.get(s);
      if (!entry) continue;
      ghostCache.delete(s);
      // The ghost's hull and turret meshes draw the vehicle builder's CACHED
      // geometry — the very buffers every tank of this type in the battle is
      // drawing — so only what this view made for itself goes back. Checked by
      // provenance as well as by stamp: tanks.js stamps its cache container,
      // not the geometries inside it.
      const builder = entry.builderGeos || null;
      entry.group.traverse((o) => {
        if (o.isMesh || o.isLine) {
          if (o.geometry && !isShared(o.geometry) && !(builder && builder.has(o.geometry))) o.geometry.dispose();
          if (o.material && o.material.dispose && !isShared(o.material)) o.material.dispose();
        }
      });
      entry.material.dispose();
    }
    if (spec) this._ghostSpecs.delete(spec);
    else this._ghostSpecs.clear();
  }

  // -------------------------------------------------------------------------
  // hit camera
  // -------------------------------------------------------------------------

  // data: {
  //   spec, turretYaw, localPoint, localDir, events, result, modules, blast,
  //   // all optional, and all degrade to something sensible when absent:
  //   shell,        // the shell record { kind, caliber, pen } that struck
  //   deflect,      // { dir, energy } from applyHit, dir in the SAME local
  //                 // frame localDir was transformed into
  //   crewAlive,    // { role: 0..1 } to colour the crew pips by condition
  //   fuse,         // { dist, label } to override the delay-fuse distance
  // }
  show(data) {
    this.clear();
    this.t = 0;
    this.mode = 'hit';
    this.blast = !!data.blast;
    // H-05: whose shot this is ('shot' = yours; 'armour' = one striking you)
    this.perspective = data.perspective === 'armour' ? 'armour' : 'shot';
    this.root = new THREE.Group();
    const spec = data.spec;
    this.spec = spec;
    this.kind = 'ground';

    const built = this.addGhost(spec, 0.13);
    this.turretYaw = data.turretYaw || 0;
    if (built.turretGroup) built.turretGroup.rotation.y = this.turretYaw;

    const hitKeys = new Set(data.modules || []);
    // the hit camera always shows the internals; only the garage viewer hides
    // them, and that flag is sticky on the instance
    this.showModules = true;
    this.addInternals(spec, built, 0.5, hitKeys, data.crewAlive || null);

    // the damage report now names the modules, so no string sniffing
    for (const key of data.modules || []) {
      const mesh = this.byKey[key];
      if (mesh && !this.flashes.includes(mesh)) this.flashes.push(mesh);
    }

    // dirN lives on the instance rather than in a shared temporary: the plate
    // reconstruction below borrows every module-scope scratch vector there is
    const dirN = this.pathDir.copy(data.localDir);
    if (dirN.lengthSq() < 1e-8) dirN.set(0, 0, -1);
    dirN.normalize();
    this.entry.copy(data.localPoint);

    if (this.blast) this.buildBlast(dirN);
    else this.buildShell(dirN, data);

    this.frameCamera(data, dirN, spec);
    this.scene.add(this.root);
  }

  // Park an object that belongs to this shot inside the cached ghost, so that
  // clear() knows to take it back out again.
  attach(parent, obj) {
    parent.add(obj);
    this._transient.push(obj);
    return obj;
  }

  // The translucent shell of the vehicle everything else is read against —
  // built once per spec and thereafter only re-tinted and re-parented.
  addGhost(spec, opacity) {
    const entry = this.ghostFor(spec);
    entry.material.opacity = opacity;
    this.ghostGroup = entry.group;
    this.turretGroup = entry.turretGroup;
    if (entry.turretGroup) entry.turretGroup.rotation.y = 0;
    this.root.add(entry.group);
    return entry;
  }

  // The cached build. Everything expensive happens here, once.
  ghostFor(spec) {
    this._ghostSpecs.add(spec);
    let entry = ghostCache.get(spec);
    if (entry) return entry;
    const built = spec.hull ? buildTankMesh(spec) : buildPlaneMesh(spec);
    // one material for the whole shell: the ghost is a single flat tint, and a
    // fresh MeshBasicMaterial per mesh was thirty-odd of them for one colour
    const material = new THREE.MeshBasicMaterial({
      color: 0x9ab8d0,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
    });
    const spent = new Set();
    const builderGeos = new Set();
    built.group.traverse((o) => {
      if (!o.isMesh) return;
      if (o.geometry) builderGeos.add(o.geometry);
      const old = o.material;
      o.material = material;
      o.castShadow = false;
      // Materials the builder made for this mesh alone go back; the shared
      // factory's armour and steel are being drawn by the battle at this very
      // moment, and disposing one forced a shader recompile on the frame a
      // shell landed — the stall this cache exists to avoid.
      if (Array.isArray(old)) for (const m of old) spent.add(m);
      else if (old) spent.add(old);
    });
    for (const m of spent) if (m && m.dispose && !isShared(m)) m.dispose();

    entry = {
      group: built.group,
      turretGroup: built.turretGroup || null,
      material,
      builderGeos,
      modules: [],
      moduleMeshes: [],
      byKey: {},
      labels: [],
    };
    this.buildGhostInternals(spec, entry);
    ghostCache.set(spec, entry);
    return entry;
  }

  // Internals, parented to the frame each module is defined in — the turret
  // group already carries the turret's rotation, so no extra maths here.
  // Crew pips carry their role name, which is the point of the panel: a player
  // who loses the gunner and a player who loses the loader are in two very
  // different situations and should be able to see which happened.
  buildGhostInternals(spec, entry) {
    // buildInternals is a hull layout; a plane spec has no hull to lay out
    if (!spec.hull) return;
    for (const m of buildInternals(spec)) {
      const color = MODULE_COLOR[m.kind] ?? 0x8fa0b0;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(m.half.x * 2, m.half.y * 2, m.half.z * 2),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
        }),
      );
      mesh.position.copy(m.pos);
      mesh.userData.baseColor = color;
      mesh.userData.mod = m;
      const parent = m.frame === 'turret' && entry.turretGroup ? entry.turretGroup : entry.group;
      parent.add(mesh);
      entry.byKey[m.key] = mesh;
      entry.moduleMeshes.push(mesh);

      // an edge cage, because a dozen translucent boxes stacked front to back
      // read as one smear without them
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 }),
      );
      edges.position.copy(m.pos);
      edges.frustumCulled = false;
      parent.add(edges);

      // every module gets its label up front and only the ones that matter are
      // shown — building a sprite mid-battle is the thing being avoided here
      const isCrew = m.kind === 'crew';
      const role = isCrew ? m.key.slice(5) : null;
      const text = isCrew ? (ROLE_LABEL[role] || role) : (m.label || m.key);
      const sprite = makeLabel(text, isCrew ? 0xd8e4ee : 0xff8a6a);
      if (sprite) {
        sprite.position.copy(m.pos);
        sprite.position.y += m.half.y + 0.24;
        parent.add(sprite);
        entry.labels.push({ sprite, key: m.key, text, isCrew, role });
      }
      entry.modules.push({ mod: m, mesh, edges, isCrew, role, baseColor: color });
    }
  }

  // Mount step: the boxes already exist, so this only re-tints them for the hit
  // being shown and decides which labels are worth putting on screen.
  addInternals(spec, built, opacity, hitKeys, crewAlive) {
    const entry = built && built.modules ? built : this.ghostFor(spec);
    const show = this.showModules !== false;
    for (const rec of entry.modules) {
      rec.mesh.visible = show;
      rec.edges.visible = show;
      rec.mesh.material.color.setHex(rec.baseColor);
      rec.mesh.material.opacity = rec.isCrew ? Math.min(0.72, opacity + 0.18) : opacity;
      // setCrewState may have repainted this pip during the previous hit; the
      // pulse in update() reads it back, so it starts over from the real colour
      rec.mesh.userData.baseColor = rec.baseColor;
    }
    for (const label of entry.labels) {
      // only name a module once it is the answer to "what did I just break" —
      // labelling all ten at once buries the one that matters
      const hit = !!(hitKeys && hitKeys.has(label.key));
      label.sprite.visible = show && (label.isCrew || hit);
      if (label.isCrew) setLabelColor(label, this.crewLabelColor(label.role, hit, crewAlive));
    }
    this.byKey = entry.byKey;
    this.moduleMeshes = entry.moduleMeshes;
    this.labels = entry.labels;
    this._moduleRecs = entry.modules;
  }

  crewLabelColor(role, hit, crewAlive) {
    if (crewAlive && typeof crewAlive[role] === 'number') {
      if (crewAlive[role] <= 0) return CREW_HIT;
      if (crewAlive[role] < 0.99) return 0xffc45a;
      return hit ? CREW_HIT : 0xbfe6c8;
    }
    return hit ? CREW_HIT : 0xd8e4ee;
  }

  // Repaint one crew pip after the fact. A vehicle that takes a second hit
  // while the panel is still up should show the new casualty, not the one it
  // was built with.
  setCrewState(role, alive) {
    const key = `crew_${role}`;
    const mesh = this.byKey[key];
    const color = alive <= 0 ? CREW_HIT : alive < 0.99 ? 0xffc45a : 0xbfe6c8;
    if (mesh) {
      mesh.userData.baseColor = color;
      if (this.flashes.indexOf(mesh) < 0) mesh.material.color.setHex(color);
    }
    for (const entry of this.labels) {
      if (entry.key === key) setLabelColor(entry, color);
    }
  }

  // Solid shot: a tracer flying in along the recorded path.
  // Ricochets skid off the plate and away, non-penetrations stop dead at it,
  // and a delay-fused round carries on inside to its burst point.
  buildShell(dirN, data) {
    const result = data.result;
    this.pathStart.copy(this.entry).addScaledVector(dirN, -APPROACH_LEN);
    this.stopAtArmor = result === 'ricochet' || result === 'nonpen';

    const kind = this.shellKindOf(data);
    const fuse = data.fuse || FUSE[kind] || null;
    // The model announces an armed fuse by pushing its label into the event
    // list, so the burst is drawn only when the filler actually went off —
    // a round that passed straight through gets no burst, which is correct.
    const armed = !this.stopAtArmor
      && !!fuse && !!fuse.label
      && Array.isArray(data.events)
      && data.events.indexOf(fuse.label) >= 0;
    this.fuseDist = armed ? (fuse.dist || 0) : 0;

    this.shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffe08a }),
    );
    this.shell.frustumCulled = false;
    this.root.add(this.shell);
    this.trail = makeSegment(0xffd873, 0.9);
    this.root.add(this.trail);

    // where the impact happened, drawn as the plate saw it
    this.addImpactMark(dirN, result);

    if (result === 'ricochet') {
      this.buildRicochet(dirN, data);
      this.damageAt = 999; // nothing broke inside; nothing should pulse
    } else if (result === 'nonpen') {
      this.damageAt = 999;
    } else if (armed) {
      tmpB.copy(this.entry).addScaledVector(dirN, this.fuseDist);
      this.burstFlash = new THREE.Mesh(
        new THREE.SphereGeometry(1, 14, 10),
        new THREE.MeshBasicMaterial({
          color: 0xffb648,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
        }),
      );
      this.burstFlash.position.copy(tmpB);
      this.burstFlash.visible = false;
      this.root.add(this.burstFlash);
      const sp = SPALL[kind] || SPALL.APHE || { rays: 5, spread: 0.55 };
      this.buildFragments(tmpB, dirN, Math.max(8, sp.rays * 2), sp.spread, T_APPROACH + T_FUSE, 0.45, 1.1, 2.6);
      this.damageAt = T_APPROACH + T_FUSE;
    } else {
      // solid shot: the spall cone comes off the back of the plate
      const sp = SPALL[kind] || SPALL.AP || { rays: 3, spread: 0.3 };
      tmpB.copy(this.entry).addScaledVector(dirN, 0.12);
      this.buildFragments(tmpB, dirN, Math.max(5, sp.rays * 2), sp.spread, T_APPROACH, 0.4, 0.9, 2.2);
      this.damageAt = T_APPROACH;
    }
  }

  shellKindOf(data) {
    const s = data.shell;
    if (s) {
      if (typeof s === 'string') return s;
      if (s.kind) return s.kind;
      if (s.shell && s.shell.kind) return s.shell.kind;
    }
    return data.shellKind || 'AP';
  }

  // A shell that failed to bite leaves along a reflected path. The damage model
  // hands the real deflection back when the caller passes it through; without
  // it the plate normal is reconstructed from the geometry, which is close
  // enough for a two-second replay.
  buildRicochet(dirN, data) {
    const d = data.deflect && data.deflect.dir ? data.deflect.dir : null;
    if (d && (d.x * d.x + d.y * d.y + d.z * d.z) > 1e-8) {
      this.deflectDir.copy(d).normalize();
    } else {
      this.estimateNormal(data.spec, this.entry, dirN, tmpC);
      this.deflectDir.copy(dirN).addScaledVector(tmpC, -2 * dirN.dot(tmpC)).normalize();
    }
    const energy = data.deflect && typeof data.deflect.energy === 'number'
      ? data.deflect.energy : 0.6;
    this.skidLen = 2.2 + energy * 4.5;
    this.skid = makeSegment(0xbfc8d2, 0.85);
    this.root.add(this.skid);
    // the shower of metal the skid tears off the plate
    this.buildFragments(this.entry, this.deflectDir, 6, 0.55, T_APPROACH, 0.35, 0.5, 1.3);
  }

  // Fragment tracks fanning out of one point along a direction.
  buildFragments(origin, dirN, count, spread, start, dur, minLen, maxLen) {
    basisA.crossVectors(dirN, Math.abs(dirN.y) > 0.9 ? SIDE : UP).normalize();
    basisB.crossVectors(dirN, basisA).normalize();
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const r = Math.tan(spread * Math.sqrt(Math.random()));
      const d = dirN.clone()
        .addScaledVector(basisA, Math.cos(ang) * r)
        .addScaledVector(basisB, Math.sin(ang) * r)
        .normalize();
      const line = makeSegment(0xffb057, 0.85);
      line.visible = false;
      this.root.add(line);
      this.fragments.push({
        line,
        dir: d,
        origin: origin.clone(),
        len: minLen + Math.random() * (maxLen - minLen),
        start,
        dur,
      });
    }
  }

  // A translucent patch lying on the plate that was struck, tinted by what the
  // plate did about it.
  addImpactMark(dirN, result) {
    this.estimateNormal(this.spec, this.entry, dirN, tmpC);
    // In through the top of an open-topped turret there is no plate to mark:
    // a patch lying across the opening drew a roof the vehicle does not have.
    // The tracer still shows where the round came in.
    if (this.impactOpen) return;
    // your own shot: the SHOT perspective of penScale.js; a shot striking you
    // (death cam): the ARMOUR perspective — set per show() from data.perspective
    const color = hexToInt(penHex(result === 'ricochet' ? 'ricochet' : result === 'nonpen' ? 'no' : 'yes', this.perspective || 'shot'));
    const mark = new THREE.Mesh(
      new THREE.RingGeometry(0.16, 0.3, 18),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    tmpQuat.setFromUnitVectors(FWD, tmpC);
    mark.quaternion.copy(tmpQuat);
    mark.position.copy(this.entry).addScaledVector(tmpC, 0.02);
    mark.frustumCulled = false;
    this.root.add(mark);
  }

  // Outward normal of the plate under a hull-local point. The collision volumes
  // are boxes, so the face is whichever one the point sits closest to, and the
  // spec's slope table then lays it over at the right angle.
  // Also leaves `impactOpen` set when that face is the open top of an
  // open-topped turret (no plate there at all).
  estimateNormal(spec, localPoint, localDir, out) {
    out.set(0, 1, 0);
    this.impactOpen = false;
    if (!spec || !spec.hull) return out.copy(localDir).multiplyScalar(-1).normalize();
    const { w, h, len, trackH } = spec.hull;
    const t = spec.turret;
    const pivotY = trackH + h;

    // turret space first: above the hull roof and inside the turret plan
    let isTurret = false;
    tmpA.copy(localPoint);
    if (t && localPoint.y > pivotY - 0.05) {
      const cos = Math.cos(-this.turretYaw);
      const sin = Math.sin(-this.turretYaw);
      const px = localPoint.x;
      const pz = localPoint.z - (t.offZ || 0);
      const tx = px * cos + pz * sin;
      const tz = -px * sin + pz * cos;
      if (Math.abs(tx) <= t.w * 0.7 && Math.abs(tz) <= t.len * 0.8) {
        isTurret = true;
        tmpA.set(tx, localPoint.y - pivotY, tz);
      }
    }

    const dims = isTurret
      ? { hw: t.w / 2, y0: 0, y1: t.h, hl: t.len / 2 }
      : { hw: w / 2, y0: trackH, y1: trackH + h, hl: len / 2 };
    const dx = dims.hw - Math.abs(tmpA.x);
    const dz = dims.hl - Math.abs(tmpA.z);
    const dyTop = Math.abs(dims.y1 - tmpA.y);
    let zone = 'side';
    if (dyTop < dx && dyTop < dz) zone = 'top';
    else if (dz < dx) zone = tmpA.z >= 0 ? 'front' : 'rear';
    this.impactOpen = isOpenTop(spec, isTurret, zone);

    // the direction has to be in the same frame as the point for the side
    // plates, which is the one case where the lay depends on which way the
    // round is travelling
    tmpB.copy(localDir);
    if (isTurret) {
      const cos = Math.cos(-this.turretYaw);
      const sin = Math.sin(-this.turretYaw);
      tmpB.set(localDir.x * cos + localDir.z * sin, localDir.y, -localDir.x * sin + localDir.z * cos);
    }

    const slopes = isTurret
      ? (spec.armor && spec.armor.turretSlope) : (spec.armor && spec.armor.hullSlope);
    const slope = slopes ? (slopes[zone] || 0) : 0;
    plateNormalLocal(zone, slope, tmpB, out);

    if (isTurret && this.turretYaw) {
      const cos = Math.cos(this.turretYaw);
      const sin = Math.sin(this.turretYaw);
      out.set(out.x * cos + out.z * sin, out.y, -out.x * sin + out.z * cos);
    }
    return out.normalize();
  }

  // Bomb / rocket: an expanding shockwave at the point of burst plus a cone of
  // fragments driven into the hull.
  buildBlast(dirN) {
    this.shockwave = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xff8c3a,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        wireframe: true,
      }),
    );
    this.shockwave.position.copy(this.entry);
    this.root.add(this.shockwave);
    this.buildFragments(this.entry, dirN, 14, 0.75, 0, 0.5, 2.5, 6);
    this.damageAt = 0.3;
  }

  // Side-on camera, perpendicular to the incoming path. The centre is pushed a
  // little further in for a delay-fused round so the burst point is in shot
  // rather than half off the edge of a 22%-width panel.
  frameCamera(data, dirN, spec) {
    const hull = spec.hull || { w: spec.span || 8, h: 1.4, len: spec.len || 8, trackH: 0 };
    const { w, h, len, trackH } = hull;
    const lead = this.blast ? 0.6 : 0.6 + this.fuseDist * 0.7;
    const center = data.localPoint.clone().addScaledVector(dirN, lead);
    center.y = Math.max(center.y, trackH + h * 0.5);
    const side = new THREE.Vector3().crossVectors(dirN, UP);
    if (side.lengthSq() < 0.05) side.set(1, 0, 0);
    side.normalize();
    const dist = Math.max(len, w) * 1.05 + 2.5;
    this.camera.position.copy(center).addScaledVector(side, dist);
    this.camera.position.y += 2.2;
    this.camera.lookAt(center);
  }

  update(dt) {
    if (!this.root) return;
    this.t += dt;

    if (this.mode === 'armour') {
      this.updateArmour(dt);
      return;
    }

    if (this.blast) this.updateBlast();
    else this.updateShell();
    this.updateFragments();

    // once the damage has arrived, wrecked modules pulse red
    if (this.t > this.damageAt) {
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 9);
      for (const m of this.flashes) {
        m.material.color.set(m.userData.baseColor).lerp(RED, pulse);
        m.material.opacity = 0.75;
      }
    }
  }

  updateShell() {
    const t = this.t;
    const approach = Math.min(1, t / T_APPROACH);
    tmpPos.copy(this.pathStart).addScaledVector(this.pathDir, approach * APPROACH_LEN);

    if (approach < 1) {
      this.shell.position.copy(tmpPos);
      setSegment(this.trail, this.pathStart, tmpPos);
      return;
    }

    setSegment(this.trail, this.pathStart, this.entry);

    if (this.fuseDist > 0) {
      // inside the vehicle now: the round runs on, dimming as it goes, and the
      // burst is what ends it
      const fu = Math.min(1, (t - T_APPROACH) / T_FUSE);
      tmpPos.copy(this.entry).addScaledVector(this.pathDir, fu * this.fuseDist);
      this.shell.position.copy(tmpPos);
      this.shell.material.color.setHex(fu < 1 ? 0xffb44a : 0xff7a30);
      this.shell.visible = fu < 1;
      if (this.burstFlash) {
        const bu = (t - T_APPROACH - T_FUSE) / 0.3;
        if (bu >= 0) {
          this.burstFlash.visible = bu < 1;
          this.burstFlash.scale.setScalar(0.12 + Math.min(1, bu) * 0.85);
          this.burstFlash.material.opacity = 0.8 * (1 - Math.min(1, bu));
        }
      }
      return;
    }

    if (this.skid) {
      // deflected: away it goes, slowing as it tumbles
      const su = Math.min(1, (t - T_APPROACH) / 0.5);
      const eased = 1 - (1 - su) * (1 - su);
      tmpPos.copy(this.entry).addScaledVector(this.deflectDir, eased * this.skidLen);
      this.shell.position.copy(tmpPos);
      this.shell.material.color.setHex(0xd8dee4);
      setSegment(this.skid, this.entry, tmpPos);
      this.skid.material.opacity = 0.85 * (1 - 0.55 * su);
      this.shell.visible = su < 1;
      return;
    }

    if (this.stopAtArmor) {
      this.shell.position.copy(this.entry);
      this.shell.material.color.setHex(0x9a9a9a);
      return;
    }

    // clean penetration: the shot carries on through and out of frame
    const th = Math.min(1, (t - T_APPROACH) / T_EXIT);
    tmpPos.copy(this.entry).addScaledVector(this.pathDir, th * 3.5);
    this.shell.position.copy(tmpPos);
    this.shell.visible = th < 1;
  }

  updateFragments() {
    for (const f of this.fragments) {
      const u = (this.t - f.start) / f.dur;
      if (u <= 0) continue;
      const p = Math.min(1, u);
      f.line.visible = true;
      tmpPos.copy(f.origin).addScaledVector(f.dir, p * f.len);
      setSegment(f.line, f.origin, tmpPos);
      f.line.material.opacity = 0.85 * (1 - 0.65 * p);
    }
  }

  updateBlast() {
    // the wave swells and fades in the first third of a second
    const wave = Math.min(1, this.t / 0.35);
    const s = 0.15 + wave * 2.4;
    this.shockwave.scale.setScalar(s);
    this.shockwave.material.opacity = 0.5 * (1 - wave);
    this.shockwave.visible = wave < 1;
  }

  // -------------------------------------------------------------------------
  // protection analysis
  //
  // The same mini-scene, driven from the garage instead of from a hit: the
  // vehicle stands still and every plate the camera can see is coloured by
  // what the selected shell would do to it from exactly this angle. It is the
  // difference between learning the armour model and guessing at it.
  // -------------------------------------------------------------------------

  // opts: { kind, shell, range, turretYaw, azimuth, elevation, showModules }
  showArmour(spec, opts = {}) {
    this.clear();
    this.t = 0;
    this.mode = 'armour';
    this.spec = spec;
    this.kind = opts.kind || (spec.hull ? 'ground' : 'air');
    this.root = new THREE.Group();
    this.turretYaw = opts.turretYaw ?? 0;
    this.range = opts.range ?? 500;
    this.showModules = opts.showModules !== false;

    const built = this.addGhost(spec, this.kind === 'ground' ? 0.1 : 0.14);
    if (built.turretGroup) built.turretGroup.rotation.y = this.turretYaw;

    if (this.kind === 'ground') {
      // always mounted now that they are cached — addInternals honours
      // showModules itself, so the toggle has something to turn back on
      this.addInternals(spec, built, 0.22, null, null);
      this.buildPlates(spec, built);
      this.setShell(opts.shell || this.firstShellKey(spec));
    } else {
      this.buildPartBoxes(spec, built);
    }

    const size = this.kind === 'ground'
      ? Math.max(spec.hull.len, spec.hull.w)
      : Math.max(spec.span || 10, spec.len || 9);
    this.orbit.dist = size * 1.5 + 2;
    this.orbit.az = opts.azimuth ?? -0.95;
    this.orbit.el = opts.elevation ?? 0.4;
    this.orbit.target.set(
      0,
      this.kind === 'ground' ? spec.hull.trackH + spec.hull.h * 0.7 : 0,
      0,
    );
    this.applyOrbit();
    this.scene.add(this.root);
    return this;
  }

  firstShellKey(spec) {
    if (!spec.shells) return null;
    // the vehicle's default round is the one it actually carries most of
    let best = null;
    let bestCount = -1;
    for (const key of Object.keys(spec.shells)) {
      const c = spec.shells[key].count || 0;
      if (c > bestCount) { bestCount = c; best = key; }
    }
    return best || Object.keys(spec.shells)[0] || null;
  }

  // One coloured panel per armour face, laid over at the plate's real slope so
  // a glacis looks like a glacis. Thickness and lay come from armourFace, the
  // very function the penetration model calls, so the viewer cannot drift out
  // of agreement with the game.
  buildPlates(spec, built) {
    const { w, h, len, trackH } = spec.hull;
    const t = spec.turret;

    const add = (frame, isTurret, zone, sample, sampleDir, width, dims) => {
      const normal = new THREE.Vector3();
      let thickness = 0;
      let slope = 0;
      let face = zone;
      if (armourFace) {
        const r = armourFace(spec, isTurret, zone, sample, sampleDir, normal);
        thickness = r.thickness;
        slope = r.slope || 0;
        face = r.face || zone;
      } else {
        const set = isTurret ? spec.armor.turret : spec.armor.hull;
        thickness = set[zone === 'bottom' ? 'top' : zone] ?? set.side ?? 25;
        const slopes = isTurret ? spec.armor.turretSlope : spec.armor.hullSlope;
        slope = slopes ? (slopes[zone] || 0) : 0;
        plateNormalLocal(zone, slope, sampleDir, normal);
      }
      normal.normalize();

      // `upright`: the panel is DRAWN standing on its box face while it is
      // still judged on the laid normal (see the open-topped turret below)
      const drawN = dims.upright ? tmpC.set(normal.x, 0, normal.z).normalize() : normal;
      plateBasis(drawN, tmpA, tmpB);
      const height = dims.height;
      const geo = new THREE.PlaneGeometry(width, height);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0x808080,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      tmpMat.makeBasis(tmpA, tmpB, drawN);
      mesh.quaternion.setFromRotationMatrix(tmpMat);
      mesh.position.copy(dims.center).addScaledVector(drawN, 0.035);
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x0b1016, transparent: true, opacity: 0.7 }),
      );
      edges.quaternion.copy(mesh.quaternion);
      edges.position.copy(mesh.position);
      edges.frustumCulled = false;

      const parent = frame === 'turret' && built.turretGroup ? built.turretGroup : built.group;
      this.attach(parent, mesh);
      this.attach(parent, edges);

      // The top of an open-topped turret is an opening, not a plate: nothing
      // is drawn there (a panel across it closed the tub the ghost shows open,
      // and its 0 mm read as a red NO PENETRATION lid), but the face stays
      // pickable so a probe into the tub reports what the damage model does —
      // the round meets no armour — instead of the hull roof under the floor.
      const open = isOpenTop(spec, isTurret, zone);
      if (open) {
        mesh.material.visible = false;
        edges.material.visible = false;
      }

      const rec = {
        mesh,
        edges,
        frame,
        zone,
        face,
        isTurret,
        open,
        thickness,
        slope,
        label: plateLabel(isTurret, face, zone, spec),
        normalLocal: normal.clone(),
        normalWorld: normal.clone(),
        calc: {
          impact: 0, effective: thickness, los: thickness, pen: 0,
          ratio: 0, band: 'nonpen', ricochet: 0, overmatch: false, facing: 0,
        },
      };
      mesh.userData.plate = rec;
      this.plates.push(rec);
      return rec;
    };

    // --- hull ---
    const hs = { front: 0, side: 0, rear: 0 };
    const hSl = spec.armor.hullSlope || {};
    for (const k of Object.keys(hs)) hs[k] = ((hSl[k] || 0) * Math.PI) / 180;
    const hFrontLift = (h * Math.tan(hs.front)) / 2;
    const hRearLift = (h * Math.tan(hs.rear)) / 2;
    const hSideLift = (h * Math.tan(hs.side)) / 2;
    const midY = trackH + h / 2;

    add('hull', false, 'front', tmpV3(0, midY, len / 2), tmpV3(0, 0, -1), w, {
      height: h / Math.cos(hs.front),
      center: tmpV3(0, midY, len / 2 - hFrontLift),
    });
    add('hull', false, 'rear', tmpV3(0, midY, -len / 2), tmpV3(0, 0, 1), w, {
      height: h / Math.cos(hs.rear),
      center: tmpV3(0, midY, -len / 2 + hRearLift),
    });
    for (const side of [1, -1]) {
      add('hull', false, 'side', tmpV3(side * w / 2, midY, 0), tmpV3(-side, 0, 0), len, {
        height: h / Math.cos(hs.side),
        center: tmpV3(side * (w / 2 - hSideLift), midY, 0),
      });
    }
    add('hull', false, 'top', tmpV3(0, trackH + h, 0), tmpV3(0, -1, 0), w, {
      height: len,
      center: tmpV3(0, trackH + h, 0),
    });

    // --- turret, in turret space (y measured from the ring) ---
    if (t) {
      const ts = { front: 0, side: 0, rear: 0 };
      const tSl = spec.armor.turretSlope || {};
      for (const k of Object.keys(ts)) ts[k] = ((tSl[k] || 0) * Math.PI) / 180;
      // An open-topped tub's walls are drawn UPRIGHT on the box faces, still
      // coloured by their laid normal. Its real plates lean out to a belt and
      // back in to the rim (tanks.js flakTub), so a box face is their average
      // line; one panel laid back 26 degrees over the full height instead met
      // its neighbours half a metre inside the rim — a hipped lid over the
      // opening the ghost shows.
      const open = turretOpenTop(spec);
      const tMid = t.h / 2;
      const tFrontLift = open ? 0 : (t.h * Math.tan(ts.front)) / 2;
      const tRearLift = open ? 0 : (t.h * Math.tan(ts.rear)) / 2;
      const tSideLift = open ? 0 : (t.h * Math.tan(ts.side)) / 2;
      const wallH = (s) => (open ? t.h : t.h / Math.cos(s));

      // the cheek is sampled off to one side so armourFace does not resolve it
      // to the gun shield
      add('turret', true, 'front', tmpV3(t.w * 0.42, tMid, t.len / 2), tmpV3(0, 0, -1), t.w, {
        height: wallH(ts.front),
        center: tmpV3(0, tMid, t.len / 2 - tFrontLift),
        upright: open,
      });
      // ...and the mantlet dead centre, sitting proud of the plate behind it.
      // Only where there is one: an open-topped SPAA has no gun shield, and a
      // second panel of identical thickness would just z-fight the first.
      if (spec.armor.mantlet) {
        const mant = add('turret', true, 'front', tmpV3(0, tMid, t.len / 2), tmpV3(0, 0, -1), t.w * 0.48, {
          height: (t.h * 0.7) / Math.cos(ts.front),
          center: tmpV3(0, tMid, t.len / 2 - tFrontLift + 0.05),
        });
        mant.mesh.renderOrder = 5;
      }

      add('turret', true, 'rear', tmpV3(0, tMid, -t.len / 2), tmpV3(0, 0, 1), t.w, {
        height: wallH(ts.rear),
        center: tmpV3(0, tMid, -t.len / 2 + tRearLift),
        upright: open,
      });
      for (const side of [1, -1]) {
        add('turret', true, 'side', tmpV3(side * t.w / 2, tMid, 0), tmpV3(-side, 0, 0), t.len, {
          height: wallH(ts.side),
          center: tmpV3(side * (t.w / 2 - tSideLift), tMid, 0),
          upright: open,
        });
      }
      // on an open-topped turret this face is the opening: kept for picking
      // and drawn as nothing (see `open` in add)
      add('turret', true, 'top', tmpV3(0, t.h, 0), tmpV3(0, -1, 0), t.w, {
        height: t.len,
        center: tmpV3(0, t.h, 0),
      });
    }

    this.refreshPlateNormals();
  }

  // Aircraft have no armour worth the name, so the same viewer shows what a
  // burst would actually be hitting: the component boxes the damage model
  // resolves rounds against, sized and labelled.
  buildPartBoxes(spec, built) {
    if (!buildPlaneParts) return;
    const layout = buildPlaneParts(spec);
    const seen = new Set();
    for (const b of layout.boxes) {
      const hpMax = (layout.hp && layout.hp[b.part]) || 0;
      const color = partColor(b.part);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(b.half[0] * 2, b.half[1] * 2, b.half[2] * 2),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.32,
          depthWrite: false,
        }),
      );
      mesh.position.set(b.pos[0], b.pos[1], b.pos[2]);
      mesh.frustumCulled = false;
      const rec = { mesh, part: b.part, label: b.label || PART_LABELS[b.part] || b.part, hp: hpMax };
      mesh.userData.part = rec;
      this.attach(built.group, mesh);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }),
      );
      edges.position.copy(mesh.position);
      edges.frustumCulled = false;
      this.attach(built.group, edges);

      // one label per part, not per box — a wing is three boxes
      if (!seen.has(b.part)) {
        seen.add(b.part);
        const sprite = makeLabel(rec.label, 0xd8e4ee, 0.3);
        if (sprite) {
          sprite.position.set(b.pos[0], b.pos[1] + b.half[1] + 0.28, b.pos[2]);
          this.attach(built.group, sprite);
          this.labels.push({ sprite, key: b.part, text: rec.label });
        }
      }
      this.partBoxes.push(rec);
      this.partMeshes.push(mesh);
    }
  }

  // Plate normals in world space, recomputed whenever the turret moves.
  refreshPlateNormals() {
    if (!this.root) return;
    this.root.updateMatrixWorld(true);
    for (const p of this.plates) {
      const parent = p.mesh.parent;
      if (parent) {
        parent.getWorldQuaternion(tmpQuat);
        p.normalWorld.copy(p.normalLocal).applyQuaternion(tmpQuat).normalize();
      } else {
        p.normalWorld.copy(p.normalLocal);
      }
    }
    this.dirty = true;
  }

  setTurretYaw(rad) {
    this.turretYaw = rad;
    if (this.turretGroup) this.turretGroup.rotation.y = rad;
    this.refreshPlateNormals();
    return this;
  }

  setShell(keyOrShell) {
    const spec = this.spec;
    if (!spec) return this;
    let rec = null;
    let key = null;
    if (keyOrShell && typeof keyOrShell === 'object') {
      rec = keyOrShell;
      key = rec.kind || null;
    } else if (spec.shells && keyOrShell && spec.shells[keyOrShell]) {
      key = keyOrShell;
      rec = spec.shells[keyOrShell];
    }
    this.shellKey = key;
    this.shellRec = rec;
    this.dirty = true;
    return this;
  }

  setRange(metres) {
    this.range = Math.max(0, metres || 0);
    this.dirty = true;
    return this;
  }

  setShowModules(on) {
    this.showModules = !!on;
    // the edge cages and the crew labels go with the boxes — hiding the boxes
    // alone left a wireframe skeleton floating in an empty hull
    for (const rec of this._moduleRecs || []) {
      rec.mesh.visible = this.showModules;
      rec.edges.visible = this.showModules;
    }
    for (const label of this.labels) {
      if (label.isCrew) label.sprite.visible = this.showModules;
    }
    this.dirty = true;
    return this;
  }

  orbitBy(dAz, dEl) {
    this.orbit.az += dAz;
    this.orbit.el = Math.max(-1.35, Math.min(1.35, this.orbit.el + dEl));
    this.autoRotate = false;
    this.applyOrbit();
    return this;
  }

  zoomBy(factor) {
    this.orbit.dist = Math.max(3, Math.min(90, this.orbit.dist * factor));
    this.applyOrbit();
    return this;
  }

  applyOrbit() {
    const o = this.orbit;
    const ce = Math.cos(o.el);
    this.camera.position.set(
      o.target.x + Math.sin(o.az) * ce * o.dist,
      o.target.y + Math.sin(o.el) * o.dist,
      o.target.z + Math.cos(o.az) * ce * o.dist,
    );
    this.camera.lookAt(o.target);
    this.camera.updateMatrixWorld();
    // the shot always comes from where the player is looking from, exactly as
    // it would if they were sitting behind the gun
    this.attackDir.copy(o.target).sub(this.camera.position).normalize();
    this.dirty = true;
  }

  updateArmour(dt) {
    if (this.autoRotate) {
      this.orbit.az += dt * 0.35;
      this.applyOrbit();
    }
    if (!this.dirty) return;
    this.dirty = false;
    if (this.kind !== 'ground') return;
    for (const p of this.plates) this.evaluatePlate(p);
  }

  // What this shell does to this plate from this angle. Everything the garage
  // prints comes out of here, and it deliberately mirrors Tank.applyHit step
  // for step: overmatch, then the ricochet check, then normalisation, then the
  // line-of-sight thickness against the shell's penetration at range.
  evaluatePlate(p) {
    const c = p.calc;
    const shell = this.shellRec;
    c.facing = -this.attackDir.dot(p.normalWorld);
    const visible = c.facing > 0.02;
    p.mesh.visible = visible;
    p.edges.visible = visible;
    if (!visible || !shell) {
      if (!shell) {
        p.mesh.material.color.setHex(0x6a7885);
        p.mesh.material.opacity = 0.4;
      }
      return;
    }

    const kind = shell.kind || 'AP';
    const caliber = shell.caliber || 75;
    c.impact = Math.acos(Math.min(1, Math.max(0, c.facing)));
    if (p.open) {
      // no plate: every round goes straight in (applyHit, effArmor 0)
      c.overmatch = false;
      c.ricochet = 0;
      c.los = 0;
      c.effective = 0;
      c.pen = shellPenAt(shell, kind === 'HE' || kind === 'HEAT' ? 0 : this.range);
      c.ratio = Infinity;
      c.band = 'pen';
      return;
    }
    c.overmatch = caliber >= p.thickness * 3;
    const [rStart, rAlways] = RICOCHET[kind] || RICOCHET.AP;
    c.ricochet = c.overmatch ? 0
      : Math.min(1, Math.max(0, (c.impact - rStart) / Math.max(1e-4, rAlways - rStart)));

    const norm = c.overmatch ? c.impact : (NORMALIZATION[kind] ?? 0.05);
    const effAngle = Math.max(0, c.impact - norm);
    c.los = p.thickness / Math.max(0.2, Math.cos(c.impact));
    c.effective = p.thickness / Math.max(0.2, Math.cos(effAngle));
    c.pen = shellPenAt(shell, kind === 'HE' || kind === 'HEAT' ? 0 : this.range);
    // nothing to beat is a certain penetration, not a ratio of zero
    c.ratio = c.effective > 0 ? c.pen / c.effective : (c.pen > 0 ? Infinity : 0);

    if (c.ricochet >= 0.5) c.band = 'ricochet';
    else if (c.overmatch && c.ratio >= 1) c.band = 'overmatch';
    else if (c.ratio >= 1 + PEN_SCATTER * 2) c.band = 'pen';
    else if (c.ratio >= 1) c.band = 'likely';
    else if (c.ratio >= 1 - PEN_SCATTER * 2) c.band = 'marginal';
    else c.band = 'nonpen';

    p.mesh.material.color.setHex(BAND_COLOR[c.band]);
    // a plate seen edge-on is nearly invisible anyway; fading it keeps the
    // panel honest about how little of it the shot can actually see
    p.mesh.material.opacity = 0.32 + 0.42 * Math.min(1, c.facing * 1.6);
  }

  // Raycast the panel under a normalised device coordinate. Returns a plain
  // readout object (reused-free, one small object per call) or null.
  probe(ndcX, ndcY) {
    if (!this.root || this.mode !== 'armour') return null;
    tmpNdc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(tmpNdc, this.camera);

    if (this.kind !== 'ground') {
      const hits = this.raycaster.intersectObjects(this.partMeshes, false);
      if (!hits.length) return null;
      const rec = hits[0].object.userData.part;
      return { kind: 'part', part: rec.part, label: rec.label, hp: rec.hp };
    }

    const meshes = this.pickList;
    meshes.length = 0;
    for (const p of this.plates) if (p.mesh.visible) meshes.push(p.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const p = hits[0].object.userData.plate;
    const c = p.calc;
    return {
      kind: 'plate',
      label: p.label,
      face: p.face,
      zone: p.zone,
      isTurret: p.isTurret,
      open: !!p.open,
      thickness: p.thickness,
      slope: p.slope,
      impactDeg: (c.impact * 180) / Math.PI,
      los: c.los,
      effective: c.effective,
      pen: c.pen,
      ratio: c.ratio,
      band: c.band,
      ricochet: c.ricochet,
      overmatch: c.overmatch,
      shell: this.shellKey,
      range: this.range,
    };
  }

  // Every plate as a table row, for a garage screen that would rather print
  // the numbers than have the player hunt for them with the mouse.
  armourRows() {
    const rows = [];
    for (const p of this.plates) {
      rows.push({
        label: p.label,
        thickness: p.thickness,
        slope: p.slope,
        effective: p.calc.effective,
        band: p.calc.band,
        visible: p.mesh.visible,
        open: !!p.open,
      });
    }
    return rows;
  }

  legend() {
    return ARMOUR_BANDS.map((b) => ({
      key: b.key,
      label: b.label,
      css: `#${b.color.toString(16).padStart(6, '0')}`,
    }));
  }
}

// Local helper so buildPlates never depends on tanks.js exporting plateNormal.
function plateNormalLocal(zone, slopeDeg, localDir, out) {
  if (tanksMod.plateNormal) return tanksMod.plateNormal(zone, slopeDeg, localDir, out);
  const s = ((slopeDeg || 0) * Math.PI) / 180;
  const c = Math.cos(s);
  const y = Math.sin(s);
  if (zone === 'front') return out.set(0, y, c);
  if (zone === 'rear') return out.set(0, y, -c);
  if (zone === 'top') return out.set(0, 1, 0);
  if (zone === 'bottom') return out.set(0, -1, 0);
  return out.set(localDir && localDir.x > 0 ? -c : c, y, 0);
}

const scratchVecs = [];
let scratchAt = 0;
// A tiny ring of vectors for the plate builder, which needs a handful of
// throwaway points per call and runs once per vehicle, never per frame.
function tmpV3(x, y, z) {
  if (scratchVecs.length < 16) scratchVecs.push(new THREE.Vector3());
  const v = scratchVecs[scratchAt % scratchVecs.length];
  scratchAt++;
  return v.set(x, y, z);
}

// An open-topped turret — the Wirbelwind's tub — has walls and no roof. The
// damage model keeps a closed collision box round it and calls the missing
// roof a 0 mm 'top' face that every round passes straight through, so which
// turret is open is read off the spec, never off the box: the shape flag the
// mesh builder obeys (tanks.js builds no roof for it), or a turret roof rated
// at no armour at all. Every view here then shows that face as the opening it
// is — no roof panel, no "Turret roof" label, no struck-plate ring on it.
export function turretOpenTop(spec) {
  if (!spec || !spec.hull) return false;
  const top = spec.armor && spec.armor.turret ? spec.armor.turret.top : undefined;
  return !!(spec.shape && spec.shape.openTurret) || top === 0;
}

// Is this (part, zone) the open top of an open-topped turret?
function isOpenTop(spec, isTurret, zone) {
  return !!isTurret && zone === 'top' && turretOpenTop(spec);
}

// `spec` is optional: given, the top of an open-topped turret reads as what it
// is rather than as a roof.
function plateLabel(isTurret, face, zone, spec = null) {
  if (spec && isOpenTop(spec, isTurret, zone)) return 'Open top';
  const where = isTurret ? 'Turret' : 'Hull';
  const what = face === 'mantlet' ? 'mantlet'
    : face === 'cheek' ? 'cheek'
      : zone === 'top' ? 'roof' : zone;
  return `${where} ${what}`;
}

const PART_TINT = {
  engine: 0xd08040,
  oilCooler: 0x54c8bc,
  fuelTank: 0xe07050,
  pilot: 0x58d068,
  controls: 0x9aa4b0,
  leftWing: 0x6fb0d8,
  rightWing: 0x6fb0d8,
  aileronL: 0xa08cd8,
  aileronR: 0xa08cd8,
  tail: 0xc2cad2,
  elevator: 0xa08cd8,
  rudder: 0xa08cd8,
};
function partColor(part) {
  return PART_TINT[part] ?? 0x8fa0b0;
}

// ---------------------------------------------------------------------------
// ArmourAnalysis — the garage-side wrapper: an XrayView in protection mode
// plus its own renderer, its own canvas and mouse handling.
//
// garage.js owns no part of this. It only has to construct one, append
// viewer.canvas (or the whole widget createArmourPanel returns) and call
// dispose() when the screen goes away.
// ---------------------------------------------------------------------------
export class ArmourAnalysis {
  constructor(opts = {}) {
    this.width = opts.width || 460;
    this.height = opts.height || 280;
    this.view = new XrayView();
    this.renderer = null;
    this.canvas = null;
    this.running = false;
    this.raf = 0;
    this.lastT = 0;
    this.onReadout = opts.onReadout || null;
    this.disposed = false;
    this.pendingDraw = true;

    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      this.renderer.setPixelRatio(Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
      this.renderer.setSize(this.width, this.height, false);
      this.canvas = this.renderer.domElement;
      this.canvas.style.width = '100%';
      this.canvas.style.display = 'block';
      this.canvas.style.cursor = 'grab';
    } catch (err) {
      // no WebGL (or too many live contexts): the panel still builds, it just
      // has nothing to draw into, and the numbers below it still work
      this.renderer = null;
      this.canvas = typeof document !== 'undefined' ? document.createElement('div') : null;
    }
    this.view.camera.aspect = this.width / this.height;
    this.view.camera.updateProjectionMatrix();
    this.bindInput();
  }

  setVehicle(spec, kind = 'ground', opts = {}) {
    this.view.showArmour(spec, { kind, ...opts });
    // deliberately still: the player is reading numbers off a plate, and a
    // model that keeps turning under the cursor makes that impossible
    this.view.autoRotate = opts.autoRotate === true;
    this.pendingDraw = true;
    this.render();
    return this;
  }

  setShell(key) { this.view.setShell(key); this.render(); return this; }
  setRange(m) { this.view.setRange(m); this.render(); return this; }
  setTurretYaw(r) { this.view.setTurretYaw(r); this.render(); return this; }
  setShowModules(on) { this.view.setShowModules(on); this.render(); return this; }
  legend() { return this.view.legend(); }
  rows() { return this.view.armourRows(); }

  setSize(w, h) {
    this.width = w;
    this.height = h;
    if (this.renderer) this.renderer.setSize(w, h, false);
    this.view.camera.aspect = w / Math.max(1, h);
    this.view.camera.updateProjectionMatrix();
    this.render();
    return this;
  }

  bindInput() {
    if (!this.canvas || !this.canvas.addEventListener) return;
    let dragging = false;
    let lx = 0;
    let ly = 0;
    this.onDown = (e) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      this.canvas.style.cursor = 'grabbing';
      if (this.canvas.setPointerCapture && e.pointerId !== undefined) {
        try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* not captureable */ }
      }
    };
    this.onMove = (e) => {
      if (dragging) {
        this.view.orbitBy((e.clientX - lx) * -0.008, (e.clientY - ly) * 0.006);
        lx = e.clientX;
        ly = e.clientY;
        this.render();
        return;
      }
      this.emitReadout(e);
    };
    this.onUp = () => {
      dragging = false;
      this.canvas.style.cursor = 'grab';
    };
    this.onWheel = (e) => {
      e.preventDefault();
      this.view.zoomBy(e.deltaY > 0 ? 1.1 : 0.91);
      this.render();
    };
    this.onLeave = () => {
      dragging = false;
      if (this.onReadout) this.onReadout(null);
    };
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  emitReadout(e) {
    if (!this.onReadout || !this.canvas.getBoundingClientRect) return;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
    this.onReadout(this.view.probe(x, y));
  }

  // The protection view is a still life: redraw only when something actually
  // changed, so a garage screen left open is not burning a GPU frame budget
  // on an identical picture sixty times a second.
  render(dt = 0) {
    if (this.disposed) return;
    const draw = this.pendingDraw || this.view.mode !== 'armour'
      || this.view.dirty || this.view.autoRotate;
    this.view.update(dt);
    if (draw && this.renderer) {
      this.renderer.render(this.view.scene, this.view.camera);
      this.pendingDraw = false;
    }
  }

  start() {
    if (this.running || this.disposed || typeof requestAnimationFrame !== 'function') return this;
    this.running = true;
    this.lastT = 0;
    const step = (now) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(step);
      const dt = this.lastT ? Math.min(0.05, (now - this.lastT) / 1000) : 0.016;
      this.lastT = now;
      this.render(dt);
    };
    this.raf = requestAnimationFrame(step);
    return this;
  }

  stop() {
    this.running = false;
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = 0;
    return this;
  }

  dispose() {
    this.stop();
    this.disposed = true;
    if (this.canvas && this.canvas.removeEventListener) {
      this.canvas.removeEventListener('pointerdown', this.onDown);
      this.canvas.removeEventListener('pointermove', this.onMove);
      this.canvas.removeEventListener('pointerup', this.onUp);
      this.canvas.removeEventListener('pointerleave', this.onLeave);
      this.canvas.removeEventListener('wheel', this.onWheel);
    }
    // the garage may open and close this panel dozens of times, so its ghosts
    // go back too rather than sitting in the cache for a screen that is gone
    this.view.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      // free the WebGL context outright: the garage may open and close this
      // panel dozens of times and browsers cap live contexts hard
      const ext = this.renderer.getContext && this.renderer.getContext();
      const lose = ext && ext.getExtension && ext.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      this.renderer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// createArmourPanel — a complete, self-styled widget garage.js can drop in.
//
//   const panel = createArmourPanel(spec, { kind: 'ground' });
//   someContainer.appendChild(panel.el);
//   panel.start();          // begins the render loop
//   ...
//   panel.dispose();        // on leaving the screen
//
// Styling is inline on purpose: style.css belongs to another agent and this
// widget must not need a line of it.
// ---------------------------------------------------------------------------
export function createArmourPanel(spec, opts = {}) {
  if (typeof document === 'undefined') return null;
  const kind = opts.kind || (spec.hull ? 'ground' : 'air');
  const el = document.createElement('div');
  el.className = 'xrayArmourPanel';
  el.style.cssText = [
    'background:#0b0f14', 'border:1px solid #23303c', 'border-radius:6px',
    'padding:10px', 'color:#c8d6e2',
    'font:12px/1.35 system-ui, Segoe UI, sans-serif',
    'width:100%', 'box-sizing:border-box',
  ].join(';');

  const title = document.createElement('div');
  title.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px';
  const name = document.createElement('strong');
  name.textContent = `${spec.name || spec.id} — PROTECTION ANALYSIS`;
  name.style.cssText = 'letter-spacing:.06em;font-size:12px;color:#e6eef6';
  const hint = document.createElement('span');
  hint.textContent = 'drag to orbit · wheel to zoom';
  hint.style.cssText = 'font-size:10px;color:#6b7d8c';
  title.appendChild(name);
  title.appendChild(hint);
  el.appendChild(title);

  const viewer = new ArmourAnalysis({
    width: opts.width || 460,
    height: opts.height || 280,
    onReadout: (r) => { readout.textContent = formatReadout(r, kind); },
  });
  if (viewer.canvas) {
    viewer.canvas.style.borderRadius = '4px';
    el.appendChild(viewer.canvas);
  }

  const readout = document.createElement('div');
  readout.style.cssText = 'min-height:32px;margin-top:6px;font-size:11px;color:#9fb3c4';
  readout.textContent = kind === 'ground'
    ? 'Point at a plate to read its effective thickness.'
    : 'Point at a component to read its structure.';

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px';

  if (kind === 'ground' && spec.shells) {
    const chips = [];
    const pick = (key) => {
      viewer.setShell(key);
      for (const c of chips) {
        const on = c.dataset.shell === key;
        c.style.background = on ? '#1f4d75' : '#141c24';
        c.style.color = on ? '#dceaf6' : '#8fa3b3';
      }
    };
    for (const key of Object.keys(spec.shells)) {
      const s = spec.shells[key];
      const chip = document.createElement('button');
      chip.dataset.shell = key;
      chip.textContent = `${s.kind || key} ${s.caliber || ''}`.trim();
      chip.style.cssText = [
        'border:1px solid #2b3a48', 'background:#141c24', 'color:#8fa3b3',
        'border-radius:3px', 'padding:3px 8px', 'cursor:pointer',
        'font:11px system-ui, Segoe UI, sans-serif',
      ].join(';');
      chip.addEventListener('click', () => pick(key));
      chips.push(chip);
      controls.appendChild(chip);
    }

    const rangeWrap = document.createElement('label');
    rangeWrap.style.cssText = 'display:flex;align-items:center;gap:6px;margin-left:auto;font-size:11px';
    const rangeVal = document.createElement('span');
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '2000';
    range.step = '50';
    range.value = String(opts.range ?? 500);
    range.style.width = '120px';
    rangeVal.textContent = `${range.value} m`;
    range.addEventListener('input', () => {
      rangeVal.textContent = `${range.value} m`;
      viewer.setRange(Number(range.value));
    });
    rangeWrap.appendChild(range);
    rangeWrap.appendChild(rangeVal);
    controls.appendChild(rangeWrap);

    viewer.setVehicle(spec, kind, { range: Number(range.value), ...opts });
    pick(viewer.view.shellKey || Object.keys(spec.shells)[0]);
  } else {
    viewer.setVehicle(spec, kind, opts);
  }

  el.appendChild(readout);
  el.appendChild(controls);

  if (kind === 'ground') {
    const legend = document.createElement('div');
    legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;font-size:10px;color:#8fa3b3';
    for (const b of viewer.legend()) {
      const item = document.createElement('span');
      item.style.cssText = 'display:flex;align-items:center;gap:4px';
      const swatch = document.createElement('i');
      swatch.style.cssText = `width:9px;height:9px;border-radius:2px;background:${b.css};display:inline-block`;
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(b.label));
      legend.appendChild(item);
    }
    el.appendChild(legend);
  }

  return {
    el,
    viewer,
    start: () => viewer.start(),
    stop: () => viewer.stop(),
    setVehicle: (s, k, o) => viewer.setVehicle(s, k || kind, o || {}),
    dispose: () => {
      viewer.dispose();
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}

function formatReadout(r, kind) {
  if (!r) {
    return kind === 'ground'
      ? 'Point at a plate to read its effective thickness.'
      : 'Point at a component to read its structure.';
  }
  if (r.kind === 'part') return `${r.label} — ${r.hp ? `${r.hp} structure` : 'structure'}`;
  if (r.open) {
    return `${r.label}: no roof plate — ${r.shell || 'any shell'} goes straight in → PENETRATION`;
  }
  const verdict = r.band === 'ricochet' ? 'RICOCHET'
    : r.band === 'overmatch' ? 'OVERMATCH'
      : r.band === 'pen' ? 'PENETRATION'
        : r.band === 'likely' ? 'LIKELY PENETRATION'
          : r.band === 'marginal' ? 'MARGINAL'
            : 'NO PENETRATION';
  return `${r.label}: ${Math.round(r.thickness)} mm at ${Math.round(r.impactDeg)}° `
    + `→ ${Math.round(r.effective)} mm effective · ${r.shell || 'shell'} `
    + `${Math.round(r.pen)} mm at ${r.range} m → ${verdict}`
    + (r.ricochet > 0 && r.ricochet < 0.5 ? ` (${Math.round(r.ricochet * 100)}% ricochet chance)` : '');
}

// ===========================================================================
// HANGAR INSPECTION — X-RAY and PROTECTION ANALYSIS on the hangar stage
//
// Any vehicle in the tree, researched or not, can be opened up from the main
// hangar. Nothing the player reads here is a second opinion: every number comes
// out of the code the battle runs.
//   - where each module sits and what it soaks: combat/internals.js
//   - which plate a round finds: ballistics.js intersectTank, the very test a
//     flying shell makes against the collision boxes
//   - how that plate lies and how thick it is: tanks.js armourFace
//   - the verdict: tankEntity.js penetrationForecast, i.e. solvePlate, the
//     solver applyHit runs
//   - the outcome distribution: Tank.applyHit itself, run on throwaway vehicles
//     that are never rendered and never touch a battle.
// If a figure here ever disagrees with a battle, the battle code moved and this
// file read the new numbers — there is no table of its own to drift.
// ===========================================================================

const TankClass = tankEntityMod.Tank || null;
const penetrationForecast = tankEntityMod.penetrationForecast || null;
const intersectTank = ballisticsMod.intersectTank || null;
const traceInternals = internalsMod.traceInternals || null;
const RESIST = internalsMod.RESIST || {};
const MODULE_REPAIR = internalsMod.MODULE_REPAIR || {};
// Bindings that may not exist in every version of the module are read through
// a computed key: a static read of a binding a module does not export (yet) is
// a bundler warning on every build.
const optionalExport = (ns, name) => ns[name];
// The bursting charge (APHE / HE): every man within reach of the burst is hurt,
// whichever way he sits, and a burst in the engine bay goes into the powerpack
// instead — resolvePenetration's FILLER step, same table, same helpers.
const FILLER = internalsMod.FILLER || {};
const crewWithin = internalsMod.crewWithin || null;
const inEngineBay = optionalExport(internalsMod, 'inEngineBay') || null;
const engineBayWithin = optionalExport(internalsMod, 'engineBayWithin') || null;
// applyModuleDamage's odds for one hit of `energy` mm: a man knocked out
// rather than wounded, a component wrecked, a fuel cell setting the tank alight
function hitOdds(kind, energy) {
  if (kind === 'crew') return { p: clampN(energy / 22, 0.15, 1), what: 'KO' };
  if (kind === 'fuel') return { p: 0.55, what: 'fire' };
  if (kind === 'traverse' || kind === 'elevation') return { p: clampN(energy / 18, 0.35, 1), what: 'out' };
  if (kind === 'barrel') return { p: clampN(energy / 90, 0.1, 0.55), what: 'out' };
  if (kind === 'engine' || kind === 'transmission' || kind === 'radiator' || kind === 'breech') {
    return { p: clampN(energy / 10, 0.3, 1), what: 'out' };
  }
  return { p: 1, what: 'hit' };
}
// Overpressure an HE burst on the plate is worth per metre of splash radius.
// It is private to tankEntity.js (BLAST_PEN); read off the namespace if it is
// ever exported, otherwise mirrored here with the value it carries today.
const HE_BLAST_PEN = optionalExport(tankEntityMod, 'BLAST_PEN') ?? 9;

const SVGNS = 'http://www.w3.org/2000/svg';
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// sRGB hex -> 0..1 sRGB triple, decoded by hand. THREE.Color would hand back
// LINEAR components, and the buffers these go into are shown exactly as written.
function srgb(hex, out = [0, 0, 0]) {
  out[0] = ((hex >> 16) & 255) / 255;
  out[1] = ((hex >> 8) & 255) / 255;
  out[2] = (hex & 255) / 255;
  return out;
}
const cssHex = (hex) => `#${(hex >>> 0).toString(16).padStart(6, '0')}`;

// ---------------------------------------------------------------------------
// colour scales
// ---------------------------------------------------------------------------

// Plate thickness (mm) at each evenly spaced stop of the heat-map legend.
// Uneven on purpose: every vehicle in the tree lives between 10 and 160 mm, and
// a linear 0-250 scale spent half its colours on armour nobody carries.
export const THICKNESS_STOPS = [0, 15, 30, 45, 60, 80, 100, 130, 160, 200, 250];
// The plasma map, run bright to dark: thin plate glows, thick plate sinks into
// the background. Perceptually even and legible to every common form of colour
// blindness, which the usual red-to-green thickness scale is not.
const THICKNESS_RAMP = [
  0xf0f921, 0xfcce25, 0xfca636, 0xf2844b, 0xe16462, 0xcc4778,
  0xb12a90, 0x8f0da4, 0x6a00a8, 0x4a03a0, 0x2c0594,
];
const _ra = [0, 0, 0];
const _rb = [0, 0, 0];
export function thicknessColor(mm, out = [0, 0, 0]) {
  const S = THICKNESS_STOPS;
  const v = Math.max(0, mm || 0);
  if (v >= S[S.length - 1]) return srgb(THICKNESS_RAMP[S.length - 1], out);
  let i = 0;
  while (i < S.length - 2 && v >= S[i + 1]) i++;
  const f = (v - S[i]) / (S[i + 1] - S[i]);
  srgb(THICKNESS_RAMP[i], _ra);
  srgb(THICKNESS_RAMP[i + 1], _rb);
  // interpolated in sRGB, exactly as the CSS gradient on the legend is
  out[0] = _ra[0] + (_rb[0] - _ra[0]) * f;
  out[1] = _ra[1] + (_rb[1] - _ra[1]) * f;
  out[2] = _ra[2] + (_rb[2] - _ra[2]) * f;
  return out;
}
export function thicknessGradientCss() {
  const n = THICKNESS_RAMP.length - 1;
  return `linear-gradient(90deg, ${THICKNESS_RAMP.map((c, i) => `${cssHex(c)} ${((i / n) * 100).toFixed(1)}%`).join(', ')})`;
}

// What the selected shell does to the plate under each point, in the four
// verdicts penetrationForecast hands the arcade HUD. Red / yellow / green read
// as danger to the vehicle being inspected; ricochet gets its own cool tone
// because "it bounces" is a different lesson from "it stops".
// (H-05) The protection analysis is the ARMOUR perspective of the shared
// vocabulary: same words, glyphs and hexes as the HUD, mapping swapped, and
// the legend carries its subject title (PEN_LEGEND_TITLE).
const PEN_ARMOUR = penLegend('armour');
export const PEN_LEGEND_TITLE = PEN_ARMOUR.title;
export const PEN_LEGEND = PEN_ARMOUR.rows.map((r) => ({
  key: r.verdict, label: r.word, color: r.color, glyph: r.glyph,
}));
const PEN_COLOR = {};
for (const p of PEN_LEGEND) PEN_COLOR[p.key] = p.color;
// geometry the battle's collision boxes do not cover — a gun barrel, a stowage
// bin — is not armour: a round aimed at it carries on to whatever box is behind
const NOT_ARMOUR = 0x3b4653;

// ---------------------------------------------------------------------------
// module vocabulary
// ---------------------------------------------------------------------------

const IX_KINDS = {
  crew: { label: 'Crew', color: 0x5fd47a },
  ammo: { label: 'Ammunition', color: 0xe6c449 },
  fuel: { label: 'Fuel tanks', color: 0xe24f3d },
  engine: { label: 'Engine', color: 0xe68a35 },
  transmission: { label: 'Transmission', color: 0xc46fae },
  breech: { label: 'Gun breech', color: 0xa9b6c4 },
  barrel: { label: 'Gun barrel', color: 0x7d8a97 },
  traverse: { label: 'Turret drive', color: 0x55a9e4 },
  elevation: { label: 'Elevation drive', color: 0x9c88e4 },
  radiator: { label: 'Radiator', color: 0x45c6b6 },
  // aircraft
  pilot: { label: 'Pilot', color: 0x5fd47a },
  fuelTank: { label: 'Fuel tanks', color: 0xe24f3d },
  oilCooler: { label: 'Oil / coolant radiator', color: 0x45c6b6 },
  controls: { label: 'Control runs', color: 0xa9b6c4 },
  plate: { label: 'Armour plate', color: 0x8d9db0 },
  structure: { label: 'Airframe structure', color: 0x7a8ea4 },
};
const TANK_KIND_ORDER = ['crew', 'ammo', 'fuel', 'engine', 'transmission', 'breech', 'barrel', 'traverse', 'elevation', 'radiator'];
const PLANE_KIND_ORDER = ['pilot', 'plate', 'engine', 'fuelTank', 'oilCooler', 'controls', 'structure'];
const KIND_PRIORITY = { crew: 6, pilot: 6, ammo: 5, fuel: 5, fuelTank: 5, engine: 4, transmission: 3, breech: 3, oilCooler: 3, barrel: 1, traverse: 2, elevation: 2, radiator: 2, controls: 1, plate: 2 };

const IX_ROLE = {
  driver: 'Driver', gunner: 'Gunner', loader: 'Loader', commander: 'Commander', radio: 'Radio operator',
};
const IX_ROLE_ORDER = ['driver', 'gunner', 'loader', 'commander', 'radio'];
// What losing the man costs, as tankEntity.recomputeCrew applies it.
const ROLE_DUTY = {
  driver: 'Drives. Seat empty: the vehicle cannot move until someone takes over.',
  gunner: 'Lays and fires the gun. Seat empty: no traverse and no fire.',
  loader: 'Feeds the gun. Seat empty: reloading takes twice as long.',
  commander: 'Directs the crew and spots. Lost: traverse, elevation and speed drop 20%.',
  radio: 'Works the set. Lost: no support can be called in.',
};
// What breaking the module costs, as tankEntity applies it.
const KIND_EFFECT = {
  engine: 'Knocked out: 25% power. A hit here sets the tank alight one time in five.',
  transmission: 'Knocked out: 40% power.',
  fuel: 'Holed: the tank catches fire more often than not (55%).',
  ammo: 'Struck: can detonate and destroy the vehicle — bursting shells set it off most readily.',
  breech: 'Knocked out: the gun cannot fire.',
  barrel: 'Damaged: shot dispersion ×8.',
  traverse: 'Knocked out: the turret is jammed.',
  elevation: 'Knocked out: elevation slows to 15%.',
  radiator: 'Knocked out: the engine overheats.',
};
const PLANE_EFFECT = {
  engine: 'Destroyed: no thrust, and a 45% chance of fire. Lesser hits can start an oil leak.',
  oilCooler: 'Holed: oil leaks away and the engine overheats.',
  fuelTank: 'Holed: fuel leaks, with a {fire}% chance of fire.',
  pilot: 'Knocked out: the aircraft is lost.',
  controls: 'Cut: the control cables are severed.',
  leftWing: 'Shattered: lift lost on that side. Lose both and a wing tears off.',
  rightWing: 'Shattered: lift lost on that side. Lose both and a wing tears off.',
  tail: 'Shot away: the aircraft is lost.',
  elevator: 'Shot away: pitch authority lost.',
  rudder: 'Shot away: yaw authority lost.',
  aileronL: 'Shot away: roll authority lost.',
  aileronR: 'Shot away: roll authority lost.',
};
const PLANE_INTERNAL = new Set(['engine', 'oilCooler', 'fuelTank', 'pilot', 'controls']);

// ---------------------------------------------------------------------------
// callout layout
//
// Labels sit in two columns at the edges of the 3D view with leader lines in
// to what they name — the way a cutaway drawing is annotated — so no label ever
// lies on top of the model or of another label. Pure function, so the layout
// rules can be tested without a browser.
//
//   items: [{ id, x, y, w, priority }]   anchor in screen px, label width
//   box:   { left, right, top, bottom, h, gap, margin }
// Returns one record per item: { id, side, x, y, w, h, ax, ay, visible }.
// Visible labels never overlap each other and never leave the box; when a
// column cannot hold them all, the least important are dropped, not stacked.
// ---------------------------------------------------------------------------
export function layoutCallouts(items, box) {
  const h = box.h ?? 20;
  const gap = box.gap ?? 4;
  const margin = box.margin ?? 12;
  const { left, right, top, bottom } = box;
  const out = [];
  const width = right - left;
  let maxW = 0;
  for (const it of items) maxW = Math.max(maxW, it.w || 0);
  const two = width >= 2 * (margin + maxW) + 24;
  const mid = (left + right) / 2;
  const cols = { L: [], R: [] };
  const fitW = two ? maxW : Math.max(0, width - 2 * margin);
  // A box too narrow for a readable plate (a window squeezed to a sliver, the
  // panel wider than the stage) shows no callouts rather than labels hanging
  // out past its edges; the hover tooltip still names everything.
  const cap = fitW >= 40 ? Math.max(0, Math.floor((bottom - top + gap) / (h + gap))) : 0;
  for (const it of items) {
    const rec = {
      id: it.id, ax: it.x, ay: it.y, w: Math.min(it.w || 0, fitW), h,
      side: two && it.x >= mid ? 'R' : 'L', x: 0, y: 0, visible: true,
      priority: it.priority ?? 0,
    };
    cols[rec.side].push(rec);
    out.push(rec);
  }
  if (two) {
    // an overfull column hands its most central labels across before anything
    // is dropped — the leader gets longer, the information survives
    const move = (from, to) => {
      while (cols[from].length > cap && cols[to].length < cap) {
        let best = 0;
        let bestD = Infinity;
        cols[from].forEach((r, i) => {
          const d = Math.abs(r.ax - mid);
          if (d < bestD) { bestD = d; best = i; }
        });
        const r = cols[from].splice(best, 1)[0];
        r.side = to;
        cols[to].push(r);
      }
    };
    move('L', 'R');
    move('R', 'L');
  }
  for (const side of ['L', 'R']) {
    let col = cols[side];
    if (col.length > cap) {
      col.sort((a, b) => a.priority - b.priority || b.ay - a.ay);
      for (const r of col.splice(0, col.length - cap)) r.visible = false;
    }
    col = col.sort((a, b) => a.ay - b.ay);
    // down the column: as close to the anchor as the label above allows...
    let prev = -Infinity;
    for (const r of col) {
      r.y = Math.max(top, r.ay - h / 2, prev + gap);
      prev = r.y + h;
    }
    // ...then back up from the floor, which can only ever open gaps
    let next = Infinity;
    for (let i = col.length - 1; i >= 0; i--) {
      const r = col[i];
      r.y = Math.min(r.y, bottom - h, next - gap - h);
      next = r.y;
    }
    for (const r of col) r.x = side === 'L' ? left + margin : right - margin - r.w;
  }
  return out;
}

// Callout width in px, as style.css draws .ixCall: 10px bold caps tracked
// 1.2px, an 8px swatch and a 6px gap, 8px padding and a 1px border each side.
// Measured once per string on a 2D canvas in the page's own font — a DOM
// measurement per label per frame would force a layout each time, and the old
// fixed per-letter guess ran up to 20px short in Segoe UI Bold, which cut
// "COMMANDER" down to "COMMAN…". Without a canvas, a per-letter allowance wide
// enough for the widest caps stands in.
const CALL_CHROME = 2 + 16 + 8 + 6;
const CALL_TRACKING = 1.2;
// a column's distance from the edge of the 3D area (layoutLabels' margin)
const CALL_MARGIN = 14;
const CALL_FONT_FALLBACK = "'Segoe UI', 'Roboto', sans-serif";
const callWidths = new Map();
let callCtx;
function calloutWidth(text, family = CALL_FONT_FALLBACK) {
  const caps = String(text).toUpperCase();
  const key = `${family}|${caps}`;
  let w = callWidths.get(key);
  if (w !== undefined) return w;
  let ink = 0;
  try {
    if (callCtx === undefined) {
      callCtx = typeof document !== 'undefined' && document.createElement
        ? document.createElement('canvas').getContext('2d') : null;
    }
    if (callCtx) {
      callCtx.font = `700 10px ${family}`;
      ink = callCtx.measureText(caps).width;
    }
  } catch {
    callCtx = null;
  }
  if (!(ink > 0)) ink = caps.length * 7.6;
  // +2: sub-pixel advances and the odd kerning pair, never a clipped letter
  w = Math.ceil(CALL_CHROME + ink + CALL_TRACKING * caps.length + 2);
  if (callWidths.size > 600) callWidths.clear();
  callWidths.set(key, w);
  return w;
}

// ---------------------------------------------------------------------------
// procedural module models
//
// The damage model's modules are boxes, and the X-ray is honest about that —
// hovering one outlines its exact box — but a stack of coloured boxes does not
// read as the inside of a tank. Each kind therefore gets a model built to fit
// inside its own box: a seated man, a rack of rounds, a V-12, a cross-drive.
// ---------------------------------------------------------------------------

const _m4 = new THREE.Matrix4();
const _q4 = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _p3 = new THREE.Vector3();
const _s3 = new THREE.Vector3();

function put(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _q4.setFromEuler(_eu.set(rx, ry, rz));
  _m4.compose(_p3.set(x, y, z), _q4, _s3.set(sx, sy, sz));
  geo.applyMatrix4(_m4);
  return geo;
}

// Every primitive used below carries position, normal and uv, so a whole model
// merges into one draw call. mergeGeometries also insists that either every
// part is indexed or none is, and RoundedBoxGeometry is the one that is not —
// a mixed set is flattened first.
function fuse(parts) {
  if (parts.length === 1) return parts[0];
  let list = parts;
  if (parts.some((p) => !p.index) && parts.some((p) => p.index)) {
    list = parts.map((p) => {
      if (!p.index) return p;
      const flat = p.toNonIndexed();
      p.dispose();
      return flat;
    });
  }
  const out = mergeGeometries(list, false);
  for (const p of list) p.dispose();
  if (!out) throw new Error('xray: module parts would not merge');
  return out;
}

// Vertex colour for a multi-coloured part. These feed a lit material, which
// works in linear space, so here THREE.Color's linear decode is the right one.
function tint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}

// A man in his seat, facing +Z, fitted INSIDE the crew box. Seat and body are
// two parts so the seat can stay a dark fitting while the man carries the
// colour.
//
// Inside, not merely scaled to it: the hover outline is the damage box, and
// hover asks the drawn model first, so a knee or a boot standing out of the
// box would name a crewman where a round finds nobody. The seated figure is
// 0.82 m from seat back to toes but only 1.14 m tall, and a turret crew box is
// barely 0.65 m deep — scaled by height alone the legs stood 20 cm out of the
// front of it. So the box height sets the scale, a shallower or narrower box
// squeezes the figure on that axis by up to CREW_SQUEEZE, and past that the
// whole man is drawn smaller (feet on the floor) rather than flattened. The
// figure is centred fore and aft and across, with a centimetre of air inside
// every face.
const CREW_SQUEEZE = 0.78;
const CREW_ROOM = 0.98;
function crewParts(half) {
  const body = fuse([
    put(new THREE.BoxGeometry(0.36, 0.15, 0.44), 0, 0.41, 0.12),
    put(new THREE.BoxGeometry(0.3, 0.38, 0.13), 0, 0.2, 0.33),
    put(new THREE.BoxGeometry(0.3, 0.08, 0.22), 0, 0.04, 0.4),
    put(new THREE.CapsuleGeometry(0.155, 0.24, 4, 10), 0, 0.71, -0.1, -0.12),
    put(new THREE.BoxGeometry(0.46, 0.11, 0.22), 0, 0.88, -0.09),
    put(new THREE.BoxGeometry(0.085, 0.3, 0.085), 0.215, 0.73, 0.03, -0.75),
    put(new THREE.BoxGeometry(0.085, 0.3, 0.085), -0.215, 0.73, 0.03, -0.75),
    put(new THREE.SphereGeometry(0.1, 12, 9), 0, 1.0, -0.07),
    put(new THREE.SphereGeometry(0.122, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), 0, 1.02, -0.07),
  ]);
  const seat = fuse([
    put(new THREE.BoxGeometry(0.44, 0.06, 0.42), 0, 0.3, -0.04),
    put(new THREE.BoxGeometry(0.44, 0.46, 0.06), 0, 0.56, -0.28),
    put(new THREE.CylinderGeometry(0.03, 0.03, 0.27, 6), 0, 0.14, -0.04),
  ]);
  // the pair's own extent at unit scale, measured rather than hand-copied so
  // a change to the figure cannot quietly push it out of the box again
  body.computeBoundingBox();
  seat.computeBoundingBox();
  const bb = body.boundingBox.clone().union(seat.boundingBox);
  body.boundingBox = null;
  seat.boundingBox = null;
  const fx = (half.x * 2 * CREW_ROOM) / (bb.max.x - bb.min.x);
  const fy = (half.y * 2 * CREW_ROOM) / (bb.max.y - bb.min.y);
  const fz = (half.z * 2 * CREW_ROOM) / (bb.max.z - bb.min.z);
  const s = Math.min(1.2, fy, fx / CREW_SQUEEZE, fz / CREW_SQUEEZE);
  const sx = Math.min(s, fx);
  const sz = Math.min(s, fz);
  const ox = (-(bb.min.x + bb.max.x) / 2) * sx;
  const oy = -half.y * CREW_ROOM - bb.min.y * s;
  const oz = (-(bb.min.z + bb.max.z) / 2) * sz;
  put(body, ox, oy, oz, 0, 0, 0, sx, s, sz);
  put(seat, ox, oy, oz, 0, 0, 0, sx, s, sz);
  return [{ geo: body, mat: 'kind' }, { geo: seat, mat: 'fixture' }];
}

// Racked rounds: one shell model instanced over a grid that fills the stowage
// box, laid along its longest horizontal side. Brass case, steel body, and the
// ballistic cap painted the way ammunition is painted.
function ammoParts(half, caliber) {
  const d = clampN((caliber * 1.3) / 1000, 0.035, 0.15);
  let L = clampN((caliber * 8.5) / 1000, 0.25, 1.05);
  const alongX = half.x > half.z;
  const along = 2 * (alongX ? half.x : half.z);
  const across = 2 * (alongX ? half.z : half.x);
  if (L > along * 0.94) L = along * 0.94;
  // the rack's floor tray and end stop sit inside the box too, and the rounds
  // stack on the tray rather than through it
  const tray = Math.min(0.015, half.y * 0.1);
  const rise = 2 * half.y - tray;
  const nAlong = Math.max(1, Math.floor((along * 0.96) / (L + 0.03)));
  let nAcross = Math.max(1, Math.floor((across * 0.92) / (d * 1.12)));
  let nUp = Math.max(1, Math.floor((rise * 0.92) / (d * 1.12)));
  while (nAlong * nAcross * nUp > 140 && nUp > 1) nUp--;
  while (nAlong * nAcross * nUp > 140 && nAcross > 1) nAcross--;
  const r = d / 2;
  const round = fuse([
    tint(put(new THREE.CylinderGeometry(r, r * 1.04, L * 0.6, 10), 0, 0, -L * 0.2, Math.PI / 2), 0xc9a24c),
    tint(put(new THREE.CylinderGeometry(r * 0.74, r * 0.8, L * 0.24, 10), 0, 0, L * 0.22, Math.PI / 2), 0x5d636b),
    tint(put(new THREE.ConeGeometry(r * 0.74, L * 0.16, 10), 0, 0, L * 0.42, Math.PI / 2), 0x8b4a3a),
  ]);
  const instances = [];
  const stepA = along / nAlong;
  const stepC = across / nAcross;
  const stepU = rise / nUp;
  for (let a = 0; a < nAlong; a++) {
    for (let c = 0; c < nAcross; c++) {
      for (let u = 0; u < nUp; u++) {
        const pa = -along / 2 + stepA * (a + 0.5);
        const pc = -across / 2 + stepC * (c + 0.5);
        const pu = -half.y + tray + stepU * (u + 0.5);
        const m = new THREE.Matrix4();
        if (alongX) m.makeRotationY(Math.PI / 2).setPosition(pa, pu, pc);
        else m.makeTranslation(pc, pu, pa);
        instances.push(m);
      }
    }
  }
  const trayW = alongX ? along : across;
  const trayD = alongX ? across : along;
  const wall = 0.012;
  const rack = fuse([
    put(new THREE.BoxGeometry(trayW * 0.99, tray, trayD * 0.99), 0, -half.y + tray / 2, 0),
    put(new THREE.BoxGeometry(alongX ? wall : trayW * 0.99, half.y * 2 * 0.99, alongX ? trayD * 0.99 : wall),
      alongX ? -trayW / 2 + wall / 2 : 0, 0, alongX ? 0 : -trayD / 2 + wall / 2),
  ]);
  return [{ geo: round, mat: 'vertex', instances }, { geo: rack, mat: 'fixture' }];
}

// A fuel cell with its filler neck and two strapping bands. The neck stands
// on the cell's top, so the cell is drawn that much lower and shorter: neck
// and all stay inside the damage box (a cap poking out of the top of the box
// used to be hoverable where no cell is).
function fuelParts(half) {
  const H = half.y * 2;
  const up = Math.min(0.035, H * 0.08);
  const w = half.x * 2 * 0.94;
  const hh = (H - up) * 0.95;
  const d = half.z * 2 * 0.94;
  const yc = -up / 2;
  const r = Math.min(w, hh, d) * 0.18;
  const rn = Math.min(0.05, w * 0.2, d * 0.2);
  const top = yc + hh / 2;
  const parts = [
    put(new RoundedBoxGeometry(w, hh, d, 2, r), 0, yc, 0),
    // seated 1 cm into the cell, its cap `up` above the cell top
    put(new THREE.CylinderGeometry(rn * 0.9, rn, up + 0.01, 10), w * 0.2, top + (up - 0.01) / 2, d * 0.3),
  ];
  for (const z of [-d * 0.28, d * 0.28]) parts.push(put(new THREE.BoxGeometry(w * 1.04, hh * 1.04, 0.035), 0, yc, z));
  return [{ geo: fuse(parts), mat: 'kind' }];
}

function vEngineParts(half) {
  const { x: hx, y: hy, z: hz } = half;
  const parts = [put(new THREE.BoxGeometry(hx * 1.7, hy * 0.9, hz * 1.84), 0, -hy * 0.42, 0)];
  for (const s of [-1, 1]) {
    parts.push(put(new THREE.BoxGeometry(hx * 0.62, hy, hz * 1.72), s * hx * 0.36, hy * 0.18, 0, 0, 0, -s * 0.5));
    parts.push(put(new THREE.BoxGeometry(hx * 0.46, hy * 0.18, hz * 1.76), s * hx * 0.62, hy * 0.66, 0, 0, 0, -s * 0.5));
    parts.push(put(new THREE.CylinderGeometry(hy * 0.08, hy * 0.08, hz * 1.6, 8), s * hx * 0.86, -hy * 0.02, 0, Math.PI / 2));
  }
  const rr = Math.min(hx, hy);
  parts.push(put(new THREE.CylinderGeometry(rr * 0.62, rr * 0.62, hz * 0.14, 24), 0, -hy * 0.2, -hz * 0.9, Math.PI / 2));
  parts.push(put(new THREE.CylinderGeometry(rr * 0.3, rr * 0.3, hz * 0.12, 16), 0, -hy * 0.1, hz * 0.94, Math.PI / 2));
  parts.push(put(new THREE.CylinderGeometry(hy * 0.1, hy * 0.1, hz * 1.6, 8), 0, hy * 0.5, 0, Math.PI / 2));
  return [{ geo: fuse(parts), mat: 'kind' }];
}

function radialEngineParts(half) {
  const R = Math.min(half.x, half.y);
  const hz = half.z;
  const parts = [
    put(new THREE.CylinderGeometry(R * 0.36, R * 0.36, hz * 0.5, 18), 0, 0, hz * 0.2, Math.PI / 2),
    put(new THREE.CylinderGeometry(R * 0.28, R * 0.38, hz * 0.6, 18), 0, 0, hz * 0.7, Math.PI / 2),
    put(new THREE.CylinderGeometry(R * 0.5, R * 0.5, hz * 0.7, 14), 0, 0, -hz * 0.5, Math.PI / 2),
  ];
  const n = 9;
  const len = R * 0.6;
  const rc = R * 0.13;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rad = R * 0.36 + len / 2;
    parts.push(put(new THREE.CylinderGeometry(rc, rc * 1.1, len, 10),
      Math.cos(a) * rad, Math.sin(a) * rad, hz * 0.2, 0, 0, a - Math.PI / 2));
  }
  return [{ geo: fuse(parts), mat: 'kind' }];
}

function transmissionParts(half) {
  const { x: hx, y: hy, z: hz } = half;
  const parts = [
    put(new THREE.BoxGeometry(hx * 1.2, hy * 1.2, hz * 1.6), 0, -hy * 0.12, 0),
    put(new THREE.CylinderGeometry(hy * 0.2, hy * 0.2, hx * 1.96, 10), 0, hy * 0.05, 0, 0, 0, Math.PI / 2),
  ];
  for (const s of [-1, 1]) {
    parts.push(put(new THREE.CylinderGeometry(hy * 0.5, hy * 0.5, hx * 0.26, 18), s * hx * 0.83, 0, 0, 0, 0, Math.PI / 2));
    parts.push(put(new THREE.CylinderGeometry(hy * 0.38, hy * 0.38, hx * 0.16, 16), s * hx * 0.56, 0, 0, 0, 0, Math.PI / 2));
  }
  return [{ geo: fuse(parts), mat: 'kind' }];
}

function breechParts(half) {
  const { x: hx, y: hy, z: hz } = half;
  const R = Math.min(hx, hy);
  const parts = [
    put(new THREE.BoxGeometry(hx * 1.4, hy * 1.2, hz * 0.8), 0, 0, -hz * 0.3),
    put(new THREE.CylinderGeometry(R * 0.55, R * 0.55, hz * 0.5, 16), 0, 0, hz * 0.25, Math.PI / 2),
    put(new THREE.BoxGeometry(hx * 1.8, hy * 0.06, hz * 0.9), 0, -hy * 0.9, -hz * 0.5),
  ];
  for (const s of [-1, 1]) {
    parts.push(put(new THREE.CylinderGeometry(hy * 0.14, hy * 0.14, hz * 1.84, 10), s * hx * 0.6, hy * 0.5, 0, Math.PI / 2));
  }
  return [{ geo: fuse(parts), mat: 'kind' }];
}

function barrelParts(half, caliber) {
  const r = clampN((caliber / 1000) * 1.05, 0.03, Math.min(half.x, half.y) * 0.95);
  return [{
    geo: put(new THREE.CylinderGeometry(r * 0.8, r, half.z * 2 * 0.98, 16), 0, 0, 0, Math.PI / 2),
    mat: 'kind',
  }];
}

function traverseParts(half) {
  const { x: hx, y: hy, z: hz } = half;
  const R = Math.min(hx, hz);
  return [{
    geo: fuse([
      put(new THREE.CylinderGeometry(R * 0.4, R * 0.4, hy * 1.3, 14), 0, hy * 0.15, 0),
      put(new THREE.CylinderGeometry(R * 0.5, R * 0.5, hy * 0.25, 14), 0, hy * 0.85, 0),
      put(new THREE.CylinderGeometry(R * 0.9, R * 0.9, hy * 0.28, 22), 0, -hy * 0.75, 0),
    ]),
    mat: 'kind',
  }];
}

function elevationParts(half) {
  const { x: hx, y: hy, z: hz } = half;
  return [{
    geo: fuse([
      put(new THREE.CylinderGeometry(hy * 0.9, hy * 0.9, hx * 0.5, 16, 1, false, 0, 1.8), 0, -hy * 0.1, 0, 0, 0, Math.PI / 2),
      put(new THREE.BoxGeometry(hx * 0.9, hy * 0.8, hz * 0.9), hx * 0.4, 0, 0),
      put(new THREE.TorusGeometry(hy * 0.45, 0.018, 6, 18), -hx * 0.8, 0, -hz * 0.3, 0, Math.PI / 2, 0),
    ]),
    mat: 'kind',
  }];
}

// Engine-deck radiator: a core with its fin stack standing on top.
function radiatorParts(half) {
  const { x: hx, y: hy, z: hz } = half;
  const parts = [put(new THREE.BoxGeometry(hx * 1.88, hy * 0.8, hz * 1.8), 0, -hy * 0.4, 0)];
  const n = Math.max(8, Math.min(28, Math.floor((hx * 2) / 0.07)));
  for (let i = 0; i < n; i++) {
    const x = -hx * 0.94 + (hx * 1.88 * (i + 0.5)) / n;
    parts.push(put(new THREE.BoxGeometry(0.012, hy * 0.7, hz * 1.76), x, hy * 0.35, 0));
  }
  return [{ geo: fuse(parts), mat: 'kind' }];
}

// Aircraft cooler: the matrix faces the airflow, so the fins run fore and aft.
function coolerParts(half) {
  const { x: hx, y: hy, z: hz } = half;
  const R = Math.min(hx, hy);
  const parts = [put(new THREE.BoxGeometry(hx * 1.7, hy * 1.7, hz * 0.5), 0, 0, 0)];
  const n = Math.max(6, Math.min(20, Math.floor((hy * 2) / 0.05)));
  for (let i = 0; i < n; i++) {
    const y = -hy * 0.85 + (hy * 1.7 * (i + 0.5)) / n;
    parts.push(put(new THREE.BoxGeometry(hx * 1.76, 0.008, hz * 0.9), 0, y, 0));
  }
  parts.push(put(new THREE.CylinderGeometry(R * 0.85, R * 0.55, hz * 1.1, 16, 1, true), 0, 0, -hz * 0.4, Math.PI / 2));
  return [{ geo: fuse(parts), mat: 'kind' }];
}

function controlsParts(half) {
  const { x: hx, y: hy, z: hz } = half;
  const parts = [];
  for (const [x, y] of [[hx * 0.5, -hy * 0.3], [-hx * 0.5, -hy * 0.3], [0, hy * 0.5]]) {
    parts.push(put(new THREE.CylinderGeometry(0.012, 0.012, hz * 1.9, 6), x, y, 0, Math.PI / 2));
  }
  parts.push(put(new THREE.BoxGeometry(hx * 1.2, 0.05, 0.1), 0, -hy * 0.3, hz * 0.85));
  parts.push(put(new THREE.BoxGeometry(hx * 1.2, 0.05, 0.1), 0, -hy * 0.3, -hz * 0.85));
  return [{ geo: fuse(parts), mat: 'kind' }];
}

// ---------------------------------------------------------------------------
// shaders
//
// Both derive the facet normal from screen-space derivatives of the view
// position, the same construction three's own flat shading uses: the vehicle
// geometry is faceted plate anyway, and it means the shaders depend on nothing
// but `position` and an attribute of their own. GLSL ES 3.0 clean: float
// literals throughout, no int-to-float promotion, no dynamic indexing, ASCII
// only (comments included — some drivers reject anything else).
//
// Two guards neither the stubbed tests nor a quick look would catch: a facet
// seen exactly edge-on has parallel derivatives, and normalize() of their
// zero cross product is NaN; and two unit vectors can dot to a hair over 1.0,
// where pow() of the negative base 1 - facing is undefined (NaN on most GPUs).
// A NaN alpha blends to a black speck, so the normal falls back to the view
// axis and the base is clamped at zero.
// ---------------------------------------------------------------------------

const IX_FACET_NORMAL = /* glsl */`
vec3 ixFacetNormal(vec3 viewPos) {
  vec3 c = cross(dFdx(viewPos), dFdy(viewPos));
  float l = length(c);
  return l > 1e-12 ? c / l : vec3(0.0, 0.0, 1.0);
}
`;

const IX_GHOST_VS = /* glsl */`
varying vec3 vViewPosition;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`;

// X-ray film: nearly clear where the surface faces the viewer, bright along the
// silhouette — the outline of the hull is what the eye reads the inside against.
const IX_GHOST_FS = /* glsl */`
uniform vec3 uColor;
uniform vec3 uRimColor;
uniform float uBase;
uniform float uRimAlpha;
varying vec3 vViewPosition;
${IX_FACET_NORMAL}
void main() {
  vec3 n = ixFacetNormal(vViewPosition);
  vec3 v = normalize(vViewPosition);
  float facing = abs(dot(n, v));
  float rim = pow(max(1.0 - facing, 0.0), 2.2);
  vec3 col = mix(uColor, uRimColor, rim);
  gl_FragColor = vec4(col, uBase + uRimAlpha * rim);
}
`;

const IX_HEAT_VS = /* glsl */`
attribute vec3 aHeat;
varying vec3 vHeat;
varying vec3 vViewPosition;
void main() {
  vHeat = aHeat;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`;

// The heat colour is written as-is (sRGB, no tone mapping) so the plate on
// screen is the exact colour of its legend swatch; the light only shapes it.
const IX_HEAT_FS = /* glsl */`
uniform vec3 uLightDir;
uniform float uAlpha;
varying vec3 vHeat;
varying vec3 vViewPosition;
${IX_FACET_NORMAL}
void main() {
  vec3 n = ixFacetNormal(vViewPosition);
  vec3 v = normalize(vViewPosition);
  if (dot(n, v) < 0.0) n = -n;
  float diff = max(dot(n, uLightDir), 0.0);
  float shade = 0.66 + 0.4 * diff;
  float rim = pow(max(1.0 - abs(dot(n, v)), 0.0), 3.0);
  vec3 col = vHeat * shade + vec3(rim * 0.16);
  gl_FragColor = vec4(min(col, vec3(1.0)), uAlpha);
}
`;

// ---------------------------------------------------------------------------
// heat-map tessellation
//
// The heat map is one colour per triangle, read at its centroid. A hull side
// is two triangles six metres long, yet the angle a camera ray meets it at —
// and with it the verdict — changes along its length, and a collision box can
// end halfway across a fender. Longest-edge bisection of every triangle bigger
// than a HEAT_PATCH-sized patch colours big plates in patches about a forearm
// across, so a click lands on the colour it was promised. Slivers (a track
// run's edge, a weld bead) and the small parts are left alone: splitting them
// multiplied the triangle count sevenfold for nothing anyone could see.
// Each split keeps the parent's winding, so the faces stay front-facing.
// ---------------------------------------------------------------------------
const HEAT_PATCH = 0.4;
function subdivideTriangles(src, mw, maxLen) {
  const out = [];
  const e = mw.elements;
  // world-space image of a local edge: the linear part of the matrix only
  const wv = (x, y, z, o) => {
    o[0] = e[0] * x + e[4] * y + e[8] * z;
    o[1] = e[1] * x + e[5] * y + e[9] * z;
    o[2] = e[2] * x + e[6] * y + e[10] * z;
    return o;
  };
  const u = [0, 0, 0];
  const v = [0, 0, 0];
  const w = [0, 0, 0];
  const max2 = maxLen * maxLen;
  // a patch is at most half a maxLen square
  const maxArea2 = (maxLen * maxLen * 0.5) ** 2;
  const stack = [];
  for (let t = 0; t < src.length; t += 9) {
    stack.push([src[t], src[t + 1], src[t + 2], src[t + 3], src[t + 4], src[t + 5], src[t + 6], src[t + 7], src[t + 8], 0]);
    while (stack.length) {
      const q = stack.pop();
      const [ax, ay, az, bx, by, bz, cx, cy, cz, depth] = q;
      wv(bx - ax, by - ay, bz - az, u);
      wv(cx - bx, cy - by, cz - bz, v);
      wv(ax - cx, ay - cy, az - cz, w);
      const ab = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
      const bc = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
      const ca = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
      const m = Math.max(ab, bc, ca);
      // (2 x area)^2 from |u x v|
      const nx = u[1] * v[2] - u[2] * v[1];
      const ny = u[2] * v[0] - u[0] * v[2];
      const nz = u[0] * v[1] - u[1] * v[0];
      const area2 = (nx * nx + ny * ny + nz * nz) / 4;
      // depth cap: nothing halves its way down forever
      if (m <= max2 || area2 <= maxArea2 || depth >= 9) {
        out.push(ax, ay, az, bx, by, bz, cx, cy, cz);
        continue;
      }
      const d = depth + 1;
      if (m === ab) {
        const mx = (ax + bx) / 2; const my = (ay + by) / 2; const mz = (az + bz) / 2;
        stack.push([ax, ay, az, mx, my, mz, cx, cy, cz, d], [mx, my, mz, bx, by, bz, cx, cy, cz, d]);
      } else if (m === bc) {
        const mx = (bx + cx) / 2; const my = (by + cy) / 2; const mz = (bz + cz) / 2;
        stack.push([ax, ay, az, bx, by, bz, mx, my, mz, d], [ax, ay, az, mx, my, mz, cx, cy, cz, d]);
      } else {
        const mx = (cx + ax) / 2; const my = (cy + ay) / 2; const mz = (cz + az) / 2;
        stack.push([ax, ay, az, bx, by, bz, mx, my, mz, d], [mx, my, mz, bx, by, bz, cx, cy, cz, d]);
      }
    }
  }
  return new Float32Array(out);
}

// ---------------------------------------------------------------------------
// heat-map seams
//
// Bisection alone still leaves triangles lying across a plate seam: a turret
// cheek facet running on below the turret's collision box, a fender facet over
// the edge of the hull box, a gun-shield facet half on the mantlet. Its
// centroid ray names one plate while a round through its lower edge flies
// under the turret box and is judged on the hull roof — the map painted 248 mm
// of turret side green over 26 mm of roof that a click there pierced. So
// before bisection every triangle near a collision box is cut along that box's
// six faces, and the turret front along armourFace's own gun-shield rectangle,
// each in its box's frame. A cut keeps the parent's winding.
//
// The seam on screen still drifts off the cut wherever the drawn surface
// stands off the box face it belongs to — a sloped glacis behind the upright
// front of its box, a cast turret inside its box — because which face a ray
// enters there depends on the angle it arrives at; and a verdict can change
// in the middle of one plate (an HE blast beats it below one angle of
// incidence and not above). No fixed tessellation can follow either, so
// paintHeat follows them per view. The rays through a triangle's centroid and
// its corners are judged (heatSeamCode finds the plate with plain slab
// arithmetic, and a verdict is solved once per plate and angle and then
// looked up); where a corner tells a different colour, seamPieces cuts the
// triangle along the seam it finds by bisecting the corner-to-corner edges,
// checks the cut really follows the seam, colours each piece from its own
// centroid ray, and the pieces are shown in place of the triangle (a pool of
// spare triangles at the end of each heat geometry). Cuts lean a few
// millimetres towards the side that may be over-drawn, and a piece still
// crossing a seam at the depth limit takes the most penetrable verdict its
// samples found — the map is never green over a spot a round goes through.
// While the camera is swinging the paint is rough (centroids only); the
// frame it settles on is cut in full.
// ---------------------------------------------------------------------------
const HEAT_SEAM_MARGIN = 0.3;
// corner samples sit this fraction of the way back towards the centroid, so
// a corner lying on a cut plane still names the plate on its own side
const HEAT_INSET = 0.04;
// how many times a piece is cut again while it still straddles a seam
const HEAT_SEAM_DEPTH = 3;
// bisection steps along an edge: 1/256 of it, a millimetre and a half on a
// 0.4 m patch (well inside HEAT_SEAM_BIAS); walked this fraction of the way
// in from the edge
const HEAT_SEAM_STEPS = 8;
const HEAT_SEAM_EDGE = 0.004;
// a triangle that would need more pieces than this stays whole
const HEAT_SEAM_PIECES = 16;
// how far (m) a cut leans into the class that may be over-drawn: more than
// the bow of a curved seam across a patch-sized piece seen from the hangar
const HEAT_SEAM_BIAS = 0.006;
// Which side of a seam a cut leans into, penetration view (class = verdict
// rank + 1). Green must never cover a spot a round goes through, so a green
// piece is the one that gives way, even to not-armour (a round passing a
// fitting goes on to whatever plate is behind it); otherwise the more
// penetrable verdict takes the margin.
const SEAM_GROW = [0, 0, -1, 2, 3, 4];
// most penetrable wins where a piece's samples still disagree
const PEN_RANK = { none: 0, no: 1, ricochet: 2, maybe: 3, yes: 4 };
const PEN_KEYS = ['none', 'no', 'ricochet', 'maybe', 'yes'];

// The analyst's collision boxes as plain numbers: the world -> box-frame
// matrix (column-major elements, the throwaway vehicle never moves), the box,
// and on the turret the gun-shield rectangle armourFace tests.
function heatBoxes(an, spec) {
  const out = [];
  const t = an && an.tank;
  if (!t) return out;
  const parts = [[t.hullBox, an.invHull, false], [t.turretBox, an.invTurret, true]];
  for (const [box, inv, isTurret] of parts) {
    if (!box) continue;
    const tt = spec.turret;
    const shield = isTurret && tt && spec.armor && (spec.armor.mantlet || spec.armor.turretCheek);
    out.push({
      e: inv.elements.slice(),
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
      turret: isTurret,
      shield: shield ? { x: tt.w * 0.24, y0: tt.h * 0.16, y1: tt.h * 0.86 } : null,
    });
  }
  return out;
}

// The planes to cut along, each with the region of its box's frame it cuts in.
function heatCuts(boxes) {
  const cuts = [];
  const m = HEAT_SEAM_MARGIN;
  boxes.forEach((b, f) => {
    const lo = [b.min[0] - m, b.min[1] - m, b.min[2] - m];
    const hi = [b.max[0] + m, b.max[1] + m, b.max[2] + m];
    for (let a = 0; a < 3; a++) {
      cuts.push({ f, axis: a, value: b.min[a], lo, hi });
      cuts.push({ f, axis: a, value: b.max[a], lo, hi });
    }
    if (b.shield) {
      // across the turret front only; a gun shield stands well proud of it
      const flo = [lo[0], lo[1], b.max[2] - m];
      const fhi = [hi[0], hi[1], b.max[2] + 2 * m];
      cuts.push({ f, axis: 0, value: -b.shield.x, lo: flo, hi: fhi });
      cuts.push({ f, axis: 0, value: b.shield.x, lo: flo, hi: fhi });
      cuts.push({ f, axis: 1, value: b.shield.y0, lo: flo, hi: fhi });
      cuts.push({ f, axis: 1, value: b.shield.y1, lo: flo, hi: fhi });
    }
  });
  return cuts;
}

// Fan a convex polygon (flat xyz list, in order) into triangles, same winding.
function fanInto(poly, out) {
  const n = poly.length / 3;
  for (let i = 1; i < n - 1; i++) {
    out.push(
      poly[0], poly[1], poly[2],
      poly[i * 3], poly[i * 3 + 1], poly[i * 3 + 2],
      poly[i * 3 + 3], poly[i * 3 + 4], poly[i * 3 + 5],
    );
  }
}

// Cut a mesh-local triangle soup (9 floats a triangle) along every plane in
// `cuts`; `mats[f]` takes mesh-local points into box frame f (column-major
// elements). Sutherland-Hodgman, both halves at once: the frames are affine,
// so a point interpolated along an edge in mesh space is the same point in
// the box frame.
function splitAtSeams(src, mats, cuts) {
  let cur = src;
  const q = new Float64Array(9);
  const d = [0, 0, 0];
  // the part's own bounds in each box frame: a cut whose plane misses them,
  // or whose region does, is not walked at all (a road wheel never meets the
  // turret's planes)
  const lo = mats.map(() => [Infinity, Infinity, Infinity]);
  const hi = mats.map(() => [-Infinity, -Infinity, -Infinity]);
  for (let f = 0; f < mats.length; f++) {
    const e = mats[f];
    const l = lo[f];
    const h = hi[f];
    for (let v = 0; v < src.length; v += 3) {
      for (let a = 0; a < 3; a++) {
        const p = e[a] * src[v] + e[4 + a] * src[v + 1] + e[8 + a] * src[v + 2] + e[12 + a];
        if (p < l[a]) l[a] = p;
        if (p > h[a]) h[a] = p;
      }
    }
  }
  for (const cut of cuts) {
    const e = mats[cut.f];
    const ax = cut.axis;
    const bl = lo[cut.f];
    const bh = hi[cut.f];
    if (!(cut.value > bl[ax] && cut.value < bh[ax])) continue;
    if (bl[0] > cut.hi[0] || bh[0] < cut.lo[0] || bl[1] > cut.hi[1] || bh[1] < cut.lo[1]
      || bl[2] > cut.hi[2] || bh[2] < cut.lo[2]) continue;
    const out = [];
    for (let t = 0; t < cur.length; t += 9) {
      for (let k = 0; k < 3; k++) {
        const x = cur[t + k * 3];
        const y = cur[t + k * 3 + 1];
        const z = cur[t + k * 3 + 2];
        q[k * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
        q[k * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        q[k * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      let near = true;
      for (let a = 0; a < 3 && near; a++) {
        const mn = Math.min(q[a], q[3 + a], q[6 + a]);
        const mx = Math.max(q[a], q[3 + a], q[6 + a]);
        if (mn > cut.hi[a] || mx < cut.lo[a]) near = false;
      }
      let pos = 0;
      let neg = 0;
      for (let k = 0; k < 3; k++) {
        let dk = q[k * 3 + ax] - cut.value;
        if (Math.abs(dk) < 1e-6) dk = 0;
        d[k] = dk;
        if (dk > 0) pos++;
        else if (dk < 0) neg++;
      }
      if (!near || !pos || !neg) {
        for (let k = 0; k < 9; k++) out.push(cur[t + k]);
        continue;
      }
      const P = [];
      const N = [];
      for (let k = 0; k < 3; k++) {
        const k2 = (k + 1) % 3;
        const a = t + k * 3;
        const b = t + k2 * 3;
        if (d[k] >= 0) P.push(cur[a], cur[a + 1], cur[a + 2]);
        if (d[k] <= 0) N.push(cur[a], cur[a + 1], cur[a + 2]);
        if ((d[k] > 0 && d[k2] < 0) || (d[k] < 0 && d[k2] > 0)) {
          const s = d[k] / (d[k] - d[k2]);
          const x = cur[a] + (cur[b] - cur[a]) * s;
          const y = cur[a + 1] + (cur[b + 1] - cur[a + 1]) * s;
          const z = cur[a + 2] + (cur[b + 2] - cur[a + 2]) * s;
          P.push(x, y, z);
          N.push(x, y, z);
        }
      }
      fanInto(P, out);
      fanInto(N, out);
    }
    cur = out;
  }
  return cur instanceof Float32Array ? cur : new Float32Array(cur);
}

// Cut one heat triangle along the seams the camera sees across it.
// `T` is a piece in barycentric coordinates of its base triangle (9 numbers:
// three corners of u, v, w). `ctx.at(u, v, w)` is the class of the ray through
// that point (what the colour there would be — see paintHeat), `ctx.grow(a,
// b)` says which of two classes a cut should lean towards (+1 a, -1 b, 0
// neither), `ctx.len(A, ia, B, ib)` is the world distance between the
// barycentric points at A[ia] and B[ib], and `ctx.leaf(T, worst)` receives
// each finished piece (`worst`
// true when it still straddles a seam at the depth limit). `known[j]` is what
// an earlier cut already says about corner j: -1 nothing (ask its ray), -2 it
// lies on the cut and the class beyond is the far corner's (its own ray is a
// coin toss, so it is not asked), or the class found just beyond the cut — a
// third one, between the cut and the far corner, which this piece must then
// cut out in turn.
//
// Corners in two classes is the usual case — one seam, crossing the two edges
// out of the odd corner — and the piece is cut there into a triangle and a
// quad, whose halves are looked at again; corners all in one class with the
// centroid in another (a band or an island) are quartered instead. Seen in
// perspective, a seam at a fixed angle of incidence is a curve, not a line, so
// each cut is leaned HEAT_SEAM_BIAS towards the class that must not be
// under-drawn (a penetrating patch never shrinks into a green one).
const SEAM_ASK = [-1, -1, -1];
function seamPieces(T, depth, ctx, known = SEAM_ASK) {
  const k = 1 - HEAT_INSET;
  const gu = (T[0] + T[3] + T[6]) / 3;
  const gv = (T[1] + T[4] + T[7]) / 3;
  const gw = (T[2] + T[5] + T[8]) / 3;
  const k0 = ctx.at(gu, gv, gw);
  // corner classes: asked at the inset corner, or as an earlier cut found
  // them; a corner on a cut (-2) takes no part
  const kc = [-2, -2, -2];
  let used = 0;
  let same = true;
  for (let j = 0; j < 3; j++) {
    const kn = known[j];
    if (kn === -2) continue;
    kc[j] = kn >= 0 ? kn
      : ctx.at(gu + (T[j * 3] - gu) * k, gv + (T[j * 3 + 1] - gv) * k, gw + (T[j * 3 + 2] - gw) * k);
    used++;
    if (kc[j] !== k0) same = false;
  }
  if (same) {
    ctx.leaf(T, false);
    return;
  }
  if (depth >= HEAT_SEAM_DEPTH) {
    ctx.leaf(T, true);
    return;
  }
  // the odd corner out when the other two agree; otherwise any corner in
  // another class from a neighbour — its cut leaves a quad, cut next
  let lone = -1;
  if (used === 3) {
    if (kc[1] === kc[2] && kc[0] !== kc[1]) lone = 0;
    else if (kc[0] === kc[2] && kc[1] !== kc[0]) lone = 1;
    else if (kc[0] === kc[1] && kc[2] !== kc[0]) lone = 2;
    else if (kc[0] !== kc[1]) lone = 0;
  } else if (used === 2) {
    const a = kc[0] === -2 ? 1 : 0;
    const b = kc[2] === -2 ? 1 : 2;
    if (kc[a] !== kc[b]) lone = a;
  }
  if (lone >= 0) {
    const L = lone;
    const M = (lone + 1) % 3;
    const N = (lone + 2) % 3;
    // Where along the edge from L the class stops being L's, and what it is
    // just beyond. Walked a hair inside the edge (an edge can lie on a cut
    // plane, where the slab test is a coin toss), to 1/256 of its length,
    // then leaned to the safe side.
    const e = 1 - HEAT_SEAM_EDGE;
    const cross = (to) => {
      const au = gu + (T[L * 3] - gu) * e;
      const av = gv + (T[L * 3 + 1] - gv) * e;
      const aw = gw + (T[L * 3 + 2] - gw) * e;
      const du = gu + (T[to * 3] - gu) * e - au;
      const dv = gv + (T[to * 3 + 1] - gv) * e - av;
      const dw = gw + (T[to * 3 + 2] - gw) * e - aw;
      let lo = 0;
      let hi = 1;
      let kHi = kc[to];
      for (let s = 0; s < HEAT_SEAM_STEPS; s++) {
        const m = (lo + hi) / 2;
        const c = ctx.at(au + du * m, av + dv * m, aw + dw * m);
        if (c === kc[L]) lo = m;
        else {
          hi = m;
          kHi = c;
        }
      }
      if (hi >= 1) return { s: 1, beyond: kc[to] };
      const lean = ctx.grow(kc[L], kHi);
      const ds = lean ? HEAT_SEAM_BIAS / Math.max(1e-6, ctx.len(T, L * 3, T, to * 3)) : 0;
      const s = lean > 0 ? Math.min(1, hi + ds) : lean < 0 ? Math.max(0, lo - ds) : (lo + hi) / 2;
      return { s, beyond: kHi };
    };
    const c1 = cross(M);
    const c2 = cross(N);
    const P1 = [0, 0, 0];
    const P2 = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      P1[a] = T[L * 3 + a] + (T[M * 3 + a] - T[L * 3 + a]) * c1.s;
      P2[a] = T[L * 3 + a] + (T[N * 3 + a] - T[L * 3 + a]) * c2.s;
    }
    if (c1.s > 0 && c1.s < 1 && c2.s > 0 && c2.s < 1 && !seamFollowsChord(T, L, M, N, P1, P2, kc[L], c1.beyond === c2.beyond ? c1.beyond : -1, ctx)) {
      quarterPieces(T, depth, ctx, known, kc);
      return;
    }
    const tl = T.slice(L * 3, L * 3 + 3);
    const tm = T.slice(M * 3, M * 3 + 3);
    const tn = T.slice(N * 3, N * 3 + 3);
    // what each new piece knows of its corners: L's side of a cut is L's
    // class; the far side is skipped when it is the far corner's class, and
    // carried when a third class lies between
    const kL = known[L] === -2 ? -2 : kc[L];
    const kM = known[M] === -2 ? -2 : kc[M];
    const kN = known[N] === -2 ? -2 : kc[N];
    const near1 = c1.s < 1 ? kc[L] : kM;
    const near2 = c2.s < 1 ? kc[L] : kN;
    const far1 = c1.s < 1 ? (c1.beyond === kc[M] ? -2 : c1.beyond) : kM;
    const far2 = c2.s < 1 ? (c2.beyond === kc[N] ? -2 : c2.beyond) : kN;
    const pieces = [
      [[...tl, ...P1, ...P2], [kL, near1, near2]],
      [[...P1, ...tm, ...tn], [far1, kM, kN]],
      [[...P1, ...tn, ...P2], [far1, kN, far2]],
    ];
    // L, M, N keep the piece's cyclic order, so every cut keeps its winding;
    // a seam passing through a corner leaves a sliver of no area, dropped
    for (const [P, kn] of pieces) {
      const area = (P[3] - P[0]) * (P[7] - P[1]) - (P[6] - P[0]) * (P[4] - P[1]);
      if (Math.abs(area) > 1e-9) seamPieces(P, depth + 1, ctx, kn);
    }
    return;
  }
  quarterPieces(T, depth, ctx, known, kc);
}

// Midpoint quartering, for a seam no single straight cut follows. Corners
// keep what is known of them; the new midpoints are asked.
function quarterPieces(T, depth, ctx, known, kc) {
  const mid = (p, q) => [(T[p * 3] + T[q * 3]) / 2, (T[p * 3 + 1] + T[q * 3 + 1]) / 2, (T[p * 3 + 2] + T[q * 3 + 2]) / 2];
  const ab = mid(0, 1);
  const bc = mid(1, 2);
  const ca = mid(2, 0);
  const k0n = known[0] === -2 ? -2 : kc[0];
  const k1n = known[1] === -2 ? -2 : kc[1];
  const k2n = known[2] === -2 ? -2 : kc[2];
  seamPieces([...T.slice(0, 3), ...ab, ...ca], depth + 1, ctx, [k0n, -1, -1]);
  seamPieces([...ab, ...T.slice(3, 6), ...bc], depth + 1, ctx, [-1, k1n, -1]);
  seamPieces([...ca, ...bc, ...T.slice(6, 9)], depth + 1, ctx, [-1, -1, k2n]);
  seamPieces([...ab, ...bc, ...ca], depth + 1, ctx, SEAM_ASK);
}

// Does the seam really run along the straight cut P1-P2? Seen in
// perspective it is a curve, and where a plate seam meets a verdict seam it
// has a corner, which a chord between its two edge crossings cuts across —
// the bulge then hides inside a piece whose own corners all agree. So a
// quarter, half and three quarters of the way along the chord, a point just
// to L's side must be L's class and a point just to the far side the far
// class (`far`, or -1 when the two crossings found different ones), each
// further from the chord than the cut was leaned.
function seamFollowsChord(T, L, M, N, P1, P2, near, far, ctx) {
  const F = [0, 0, 0];
  for (let a = 0; a < 3; a++) F[a] = (T[M * 3 + a] + T[N * 3 + a]) / 2;
  const Q = [0, 0, 0];
  for (const t of [0.25, 0.5, 0.75]) {
    for (let a = 0; a < 3; a++) Q[a] = P1[a] + (P2[a] - P1[a]) * t;
    for (const [to, io, want] of [[T, L * 3, near], [F, 0, far]]) {
      if (want < 0) continue;
      const d = ctx.len(Q, 0, to, io);
      const f = Math.min(0.45, Math.max(0.08, (HEAT_SEAM_BIAS * 2) / Math.max(1e-6, d)));
      if (ctx.at(Q[0] + (to[io] - Q[0]) * f, Q[1] + (to[io + 1] - Q[1]) * f, Q[2] + (to[io + 2] - Q[2]) * f) !== want) return false;
    }
  }
  return true;
}

// Which plate a ray from the camera through world point q is judged on, as a
// small integer: the box it enters first, through which face, and on the
// turret front whether it is on the gun shield — 0 when it enters no box, or
// only further than `sMax` (in units of camera-to-q) along. `cams[f]` is the
// camera in box f's frame. The slab walk is ballistics.js's segmentVsBox
// (axis order, strict comparisons, the hull winning a tie), without its
// allocations: this runs four times for every painted triangle. The winning
// entry is left in _seamHit (box, face, and the ray in that box's frame).
const _seamHit = { f: -1, axis: 0, sign: 0, t: 0, ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0 };
function heatSeamCode(boxes, cams, qx, qy, qz, sMax) {
  let best = Infinity;
  let code = 0;
  _seamHit.f = -1;
  for (let f = 0; f < boxes.length; f++) {
    const b = boxes[f];
    const e = b.e;
    const o = cams[f];
    const bx = e[0] * qx + e[4] * qy + e[8] * qz + e[12];
    const by = e[1] * qx + e[5] * qy + e[9] * qz + e[13];
    const bz = e[2] * qx + e[6] * qy + e[10] * qz + e[14];
    let tmin = 0;
    let tmax = sMax;
    let axis = -1;
    let sign = 0;
    let miss = false;
    for (let a = 0; a < 3; a++) {
      const oa = o[a];
      const da = (a === 0 ? bx : a === 1 ? by : bz) - oa;
      if (Math.abs(da) < 1e-12) {
        if (oa < b.min[a] || oa > b.max[a]) { miss = true; break; }
        continue;
      }
      let t1 = (b.min[a] - oa) / da;
      let t2 = (b.max[a] - oa) / da;
      let s = -1;
      if (t1 > t2) {
        const w = t1;
        t1 = t2;
        t2 = w;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = a;
        sign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) { miss = true; break; }
    }
    if (miss || axis < 0 || !(tmin < best)) continue;
    best = tmin;
    let c = 1 + axis * 2 + (sign > 0 ? 1 : 0) + f * 8;
    if (b.shield && axis === 2 && sign > 0) {
      const px = o[0] + (bx - o[0]) * tmin;
      const py = o[1] + (by - o[1]) * tmin;
      if (Math.abs(px) < b.shield.x && py > b.shield.y0 && py < b.shield.y1) c += 32;
    }
    code = c;
    const S = _seamHit;
    S.f = f;
    S.axis = axis;
    S.sign = sign;
    S.t = tmin;
    S.ox = o[0];
    S.oy = o[1];
    S.oz = o[2];
    S.dx = bx - o[0];
    S.dy = by - o[1];
    S.dz = bz - o[2];
  }
  return code;
}

const _jp = new THREE.Vector3();
const _jd = new THREE.Vector3();
const _jn = new THREE.Vector3();
const ZONE_OF = [['side', 'side'], ['bottom', 'top'], ['rear', 'front']];
// The plate behind the entry heatSeamCode just found (its `code`), exactly as
// plateOf and solvePlate read it: armourFace at the entry point in the struck
// part's frame, and the incidence of the line of flight on the laid plate.
// Everything armourFace returns is fixed by the code — box, face, gun shield
// or not; even a side plate's lean only depends on which side was entered —
// so it is asked once per code and kept in `plates`. Writes { thickness,
// cos } into `out`: the cosine of the angle of incidence.
function heatPlateOf(boxes, spec, code, plates, out) {
  const S = _seamHit;
  let p = plates[code];
  if (!p) {
    _jd.set(S.dx, S.dy, S.dz).normalize();
    _jp.set(S.ox + S.dx * S.t, S.oy + S.dy * S.t, S.oz + S.dz * S.t);
    const zone = ZONE_OF[S.axis][S.sign > 0 ? 1 : 0];
    const r = armourFace(spec, boxes[S.f].turret, zone, _jp, _jd, _jn);
    p = plates[code] = { thickness: r.thickness, nx: _jn.x, ny: _jn.y, nz: _jn.z };
  }
  const len = Math.sqrt(S.dx * S.dx + S.dy * S.dy + S.dz * S.dz) || 1;
  out.thickness = p.thickness;
  out.cos = clampN(Math.abs(S.dx * p.nx + S.dy * p.ny + S.dz * p.nz) / len, 0, 1);
  return out;
}

// ---------------------------------------------------------------------------
// resource ledger
//
// Everything the inspector makes for itself goes through here, so closing it
// gives back exactly what it took — the vehicle builders' cached geometry and
// the shared material factory are never on it and are never touched.
// ---------------------------------------------------------------------------
class Ledger {
  constructor() {
    this.geos = new Set();
    this.mats = new Set();
  }
  g(geo) { if (geo) this.geos.add(geo); return geo; }
  m(mat) { if (mat) this.mats.add(mat); return mat; }
  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.geos.clear();
    this.mats.clear();
  }
  get size() { return this.geos.size + this.mats.size; }
}

// ---------------------------------------------------------------------------
// ShotAnalyst — the battle's damage code, run on a vehicle nobody will see
// ---------------------------------------------------------------------------

const _sa = {
  lp: new THREE.Vector3(), ld: new THREE.Vector3(), n: new THREE.Vector3(),
  a: new THREE.Vector3(), b: new THREE.Vector3(), d: new THREE.Vector3(), p: new THREE.Vector3(),
};

export class ShotAnalyst {
  constructor(spec) {
    this.spec = spec;
    // A Tank needs a scene to add itself to. This one is never rendered, so the
    // vehicle in it costs a dozen Object3Ds over cached geometry and nothing on
    // the GPU — and it is never disposed, because its geometry is the shared
    // per-spec cache every tank of this type draws from.
    this.scene = new THREE.Scene();
    this.tank = TankClass ? new TankClass(this.scene, spec, 1, 'Analysis') : null;
    this.invHull = new THREE.Matrix4();
    this.invTurret = new THREE.Matrix4();
    if (this.tank) {
      this.tank.group.updateMatrixWorld(true);
      this.invHull.copy(this.tank.group.matrixWorld).invert();
      this.invTurret.copy(this.tank.turretGroup.matrixWorld).invert();
    }
  }

  // ballistics.js's own segment test against the collision boxes, plus the
  // fields ShellManager stamps on a first impact before calling applyHit.
  hitSegment(p0, p1, dist = 0, kind = null) {
    if (!this.tank || !intersectTank) return null;
    const hit = intersectTank(this.tank, p0, p1);
    if (!hit) return null;
    hit.dist = dist;
    hit.penMul = 1;
    hit.fuse = kind ? FUSE[kind] || null : null;
    hit.burstPoint = hit.fuse ? hit.point.clone().addScaledVector(hit.dir, hit.fuse.dist) : null;
    return hit;
  }

  castRay(origin, dir, dist = 0, kind = null, len = 120) {
    _sa.b.copy(origin).addScaledVector(dir, len);
    return this.hitSegment(origin, _sa.b, dist, kind);
  }

  // The plate under a hit, exactly as solvePlate reads it: armourFace in the
  // struck part's own frame, incidence against the laid plate normal.
  plateOf(hit, out = {}) {
    const inv = hit.isTurret ? this.invTurret : this.invHull;
    const lp = _sa.lp.copy(hit.point).applyMatrix4(inv);
    const ld = _sa.ld.copy(hit.dir).transformDirection(inv).normalize();
    const r = armourFace
      ? armourFace(this.spec, hit.isTurret, hit.zone, lp, ld, _sa.n)
      : { thickness: 0, slope: 0, face: hit.zone };
    const impact = Math.acos(clampN(Math.abs(ld.dot(_sa.n)), 0, 1));
    out.thickness = r.thickness;
    out.slope = r.slope || 0;
    out.face = r.face || hit.zone;
    out.zone = hit.zone;
    out.isTurret = hit.isTurret;
    out.impact = impact;
    out.los = r.thickness / Math.max(0.2, Math.cos(impact));
    // the top of an open-topped turret is the opening, not a 0 mm roof
    out.open = isOpenTop(this.spec, hit.isTurret, hit.zone);
    out.label = plateLabel(hit.isTurret, out.face, hit.zone, this.spec);
    // world normal: the throwaway vehicle stands at the origin with its turret
    // trained dead ahead, so only the turret's offset separates the frames
    out.normal = (out.normal || new THREE.Vector3()).copy(_sa.n);
    return out;
  }

  // The deterministic forecast: penetrationForecast's verdict, corrected for
  // the two cases it does not cover (forecastVerdict below).
  verdict(hit, shell, key) {
    if (!penetrationForecast) return 'no';
    const f = penetrationForecast(this.tank, hit, shell, key, hit.dist);
    return forecastVerdict(f, shell.kind || key, shell);
  }

  // Everything one test shot does on average: the plate solution, the path of
  // the shell body through the internals (no scatter roll — the average round),
  // and the reach of its spall cone sampled evenly instead of with five dice.
  analyse(origin, dir, shell, key, dist) {
    const kind = shell.kind || key || 'AP';
    const hit = this.castRay(origin, dir, dist, kind);
    if (!hit) return { miss: true };
    const plate = this.plateOf(hit, {});
    const f = penetrationForecast
      ? penetrationForecast(this.tank, hit, shell, key, dist)
      : { effArmor: plate.los, effPen: shellPenAt(shell, dist), ricochetChance: 0, verdict: 'no' };
    const forecast = {
      effArmor: f.effArmor, effPen: f.effPen, ricochetChance: f.ricochetChance, verdict: f.verdict,
    };
    const caliber = shell.caliber || 75;
    const overmatch = caliber >= plate.thickness * 3;
    let mode = null;
    let budget = 0;
    if (forecast.effPen >= forecast.effArmor) {
      mode = 'pen';
      budget = forecast.effPen - forecast.effArmor;
    }
    const blastPen = kind === 'HE' ? heBlastPen(shell) : 0;
    // An HE round bursts on the plate whenever its roll falls short of piercing
    // it, and heOverpressure then lets the blast in. When piercing is not
    // certain and the blast is worth more than the shell's own penetration,
    // the burst is the shot worth drawing: a marginal piercing reaches nothing
    // (budget ~0) while half the real rounds fall back to the bigger blast.
    if (kind === 'HE' && blastPen >= forecast.effArmor && (mode !== 'pen'
      || (forecast.effPen * (1 - PEN_SCATTER) < forecast.effArmor && blastPen >= forecast.effPen))) {
      mode = 'overpressure';
      budget = blastPen - forecast.effArmor;
    }
    const verdict = forecastVerdict(forecast, kind, shell);

    const traceKind = mode === 'overpressure' ? 'HE' : kind;
    const fuse = FUSE[traceKind];
    const armed = !!mode && !!fuse && budget > (fuse.arm || 0);
    const fuseDist = armed ? fuse.dist : Infinity;
    // the throwaway vehicle's hull frame IS world space (origin, no yaw)
    const entry = hit.point.clone();
    const path = mode && traceInternals
      ? traceInternals(this.spec, entry, hit.dir, 0, budget, fuseDist)
      : [];

    let stopT = 0;
    if (mode) {
      if (armed) stopT = fuseDist;
      else {
        let left = budget;
        stopT = -1;
        for (const h of path) {
          left -= RESIST[h.kind] ?? 0;
          if (left <= 0) { stopT = h.t + 0.12; break; }
        }
        if (stopT < 0) stopT = this.exitDistance(hit) + 0.25;
      }
    }

    // Where the fragments come from: the back of the plate, or the burst point
    // of a delay fuse. A round that has already left the vehicle when its fuse
    // runs out bursts in the open — resolvePenetration (insideArmour) stops at
    // the body's own trace then, with no spall and no blast.
    const burst = entry.clone();
    if (armed) burst.addScaledVector(hit.dir, fuseDist);
    const burstInside = !armed || !this.tank || typeof this.tank.insideArmour !== 'function'
      || this.tank.insideArmour(burst);
    let spall = null;
    let filler = null;
    if (mode && burstInside) {
      const sp = SPALL[traceKind] || SPALL.AP || { rays: 3, spread: 0.3, energy: 0.55, range: 1.8 };
      spall = this.spallCone(burst, hit.dir, budget * (sp.energy ?? 0.5), sp);
      if (armed) filler = this.fillerBurst(burst, traceKind, caliber);
    }

    return {
      miss: false, hit, plate, forecast, verdict, overmatch, kind, key, shell, dist,
      mode, budget, blastPen, armed, fuseDist: armed ? fuseDist : 0, burstInside,
      entry, path, stopT, spall, filler,
    };
  }

  // The bursting charge going off, as resolvePenetration applies it: within
  // `range + caliber * perMm` of the burst (nearest surface of each box, any
  // direction) it strikes every crewman in the fighting compartment — or, for a
  // burst in the engine bay, the engine, radiator and fuel cells instead (the
  // bulkhead keeps it from the men) — with an energy falling linearly to
  // nothing at the edge of that reach; under FILLER.min it is spent. Each box
  // it reaches is struck for certain; the only roll is the one applyModuleDamage
  // makes on any hit (hitOdds): a man knocked out or wounded, a part wrecked or
  // not, a fuel cell alight or not.
  fillerBurst(burst, kind, caliber) {
    const fill = FILLER[kind];
    if (!fill || !crewWithin || !(caliber > 0)) return null;
    const reach = fill.range + caliber * fill.perMm;
    const e0 = caliber * fill.energy;
    const bay = !!(inEngineBay && engineBayWithin && inEngineBay(this.spec, burst));
    const near = bay ? engineBayWithin(this.spec, burst, reach) : crewWithin(this.spec, burst, 0, reach);
    const hits = [];
    for (const c of near) {
      const energy = e0 * (1 - c.d / reach);
      if (energy < fill.min) continue;
      const o = hitOdds(c.kind, energy);
      hits.push({ key: c.key, kind: c.kind, label: c.label, d: c.d, energy, odds: o.p, what: o.what });
    }
    hits.sort((x, y) => x.d - y.d);
    return { origin: burst.clone(), reach, e0, bay, hits };
  }

  // Distance from the entry point to where the round leaves the box it struck.
  exitDistance(hit) {
    const box = hit.isTurret ? this.tank.turretBox : this.tank.hullBox;
    const inv = hit.isTurret ? this.invTurret : this.invHull;
    const o = _sa.a.copy(hit.point).applyMatrix4(inv);
    const d = _sa.d.copy(hit.dir).transformDirection(inv).normalize();
    let tmax = Infinity;
    for (const ax of ['x', 'y', 'z']) {
      if (Math.abs(d[ax]) < 1e-9) continue;
      const t1 = (box.min[ax] - o[ax]) / d[ax];
      const t2 = (box.max[ax] - o[ax]) / d[ax];
      tmax = Math.min(tmax, Math.max(t1, t2));
    }
    return Number.isFinite(tmax) ? Math.max(0.3, tmax) : 3;
  }

  // The spall cone, sampled on a sunflower spiral with the same radial law
  // coneDirections draws from (tan(spread * sqrt(u))), so the share of the cone
  // that reaches a module is the chance one fragment does; the game throws
  // `rays` fragments, so the module is reached with 1 - (1 - share)^rays.
  spallCone(burst, dir, budget, sp) {
    const K = 96;
    const counts = new Map();
    const a = _sa.a.crossVectors(dir, Math.abs(dir.y) > 0.9 ? SIDE : UP).normalize();
    const b = _sa.p.crossVectors(dir, a).normalize();
    const rays = [];
    for (let i = 0; i < K; i++) {
      const u = (i + 0.5) / K;
      const ang = i * GOLDEN;
      const r = Math.tan((sp.spread ?? 0.3) * Math.sqrt(u));
      const d = dir.clone()
        .addScaledVector(a, Math.cos(ang) * r)
        .addScaledVector(b, Math.sin(ang) * r)
        .normalize();
      rays.push(d);
      if (!traceInternals) continue;
      const hits = traceInternals(this.spec, burst, d, 0, budget, sp.range ?? Infinity);
      const seen = new Set();
      for (const h of hits) {
        if (seen.has(h.key)) continue;
        seen.add(h.key);
        const rec = counts.get(h.key) || { key: h.key, kind: h.kind, label: h.label, n: 0 };
        rec.n++;
        counts.set(h.key, rec);
      }
    }
    const nRays = sp.rays ?? 3;
    const hits = [...counts.values()].map((c) => {
      const share = c.n / K;
      return { ...c, share, prob: 1 - Math.pow(1 - share, nRays) };
    }).sort((x, y) => y.prob - x.prob);
    return {
      origin: burst.clone(), dir: dir.clone(), spread: sp.spread ?? 0.3,
      range: sp.range ?? 2, rays: nRays, budget, samples: rays, hits,
    };
  }

  // One real shot on a factory-fresh vehicle: Tank.applyHit, unedited, on a
  // copy of the hit record. Returns what the battle would have reported and the
  // state the vehicle was left in.
  simulateOnce(hit, shell, key) {
    if (!TankClass) return null;
    const t = new TankClass(this.scene, this.spec, 1, 'Analysis');
    this.scene.remove(t.group);
    const h = {
      ...hit,
      point: hit.point.clone(),
      dir: hit.dir.clone(),
      normal: hit.normal ? hit.normal.clone() : undefined,
      burstPoint: hit.burstPoint ? hit.burstPoint.clone() : null,
    };
    const res = t.applyHit(h, shell, key);
    const broken = [];
    for (const k of Object.keys(t.modules)) if (!t.modules[k].ok) broken.push(k);
    const killed = [];
    const wounded = [];
    for (const role of t.crewStations) {
      const v = t.crewAlive[role];
      if (v <= 0) killed.push(role);
      else if (v < 1) wounded.push(role);
    }
    return {
      result: res.result,
      modules: res.modules || [],
      events: res.events || [],
      broken, killed, wounded,
      destroyed: !t.alive,
      exploded: !!t.exploded,
      burning: !!t.burning,
    };
  }

  // The outcome distribution over `n` real shots at the same spot.
  simulate(hit, shell, key, n = 240) {
    const st = {
      n, pen: 0, kill: 0, ricochet: 0, nonpen: 0, destroyed: 0, detonation: 0, fire: 0,
      modules: {}, killed: {}, wounded: {},
    };
    if (!TankClass) return st;
    for (let i = 0; i < n; i++) {
      const o = this.simulateOnce(hit, shell, key);
      if (!o) break;
      if (o.result === 'kill') st.kill++;
      else if (o.result === 'pen') st.pen++;
      else if (o.result === 'ricochet') st.ricochet++;
      else st.nonpen++;
      if (o.destroyed) st.destroyed++;
      if (o.exploded) st.detonation++;
      if (o.burning) st.fire++;
      for (const k of o.broken) st.modules[k] = (st.modules[k] || 0) + 1;
      for (const r of o.killed) st.killed[r] = (st.killed[r] || 0) + 1;
      for (const r of o.wounded) st.wounded[r] = (st.wounded[r] || 0) + 1;
    }
    return st;
  }
}

function heBlastPen(shell) {
  const radius = shell.splash || Math.max(2, (shell.caliber || 75) * 0.05);
  return radius * HE_BLAST_PEN;
}

// penetrationForecast's verdict, plus the two cases it does not cover:
//  - a face with no plate at all (the Wirbelwind's open-topped turret is 0 mm):
//    the forecast's ratio comes out as 0 and reads "no", while applyHit lets
//    every round straight in — the heat map painted the open roof green;
//  - an HE round that cannot pierce still bursts on the plate, and
//    heOverpressure lets the blast in when it beats the armour.
function forecastVerdict(f, kind, shell) {
  if (!(f.effArmor > 0)) return 'yes';
  if (kind === 'HE' && f.verdict !== 'yes' && heBlastPen(shell) >= f.effArmor) return 'yes';
  return f.verdict;
}

// Which plate a module sits behind — the nearest face of its own part — and
// what that plate is worth square on. "Armour where relevant" in the tooltip.
function nearestPlate(spec, mod) {
  if (!spec.hull || !armourFace) return null;
  const isTurret = mod.frame === 'turret';
  const p = mod.pos;
  let faces;
  if (isTurret) {
    const t = spec.turret;
    faces = [
      ['front', t.len / 2 - p.z, new THREE.Vector3(p.x, p.y, t.len / 2), new THREE.Vector3(0, 0, -1)],
      ['rear', p.z + t.len / 2, new THREE.Vector3(p.x, p.y, -t.len / 2), new THREE.Vector3(0, 0, 1)],
      ['side', t.w / 2 - Math.abs(p.x), new THREE.Vector3(Math.sign(p.x || 1) * t.w / 2, p.y, p.z), new THREE.Vector3(-Math.sign(p.x || 1), 0, 0)],
      ['top', t.h - p.y, new THREE.Vector3(p.x, t.h, p.z), new THREE.Vector3(0, -1, 0)],
    ];
  } else {
    const { w, h, len, trackH } = spec.hull;
    faces = [
      ['front', len / 2 - p.z, new THREE.Vector3(p.x, p.y, len / 2), new THREE.Vector3(0, 0, -1)],
      ['rear', p.z + len / 2, new THREE.Vector3(p.x, p.y, -len / 2), new THREE.Vector3(0, 0, 1)],
      ['side', w / 2 - Math.abs(p.x), new THREE.Vector3(Math.sign(p.x || 1) * w / 2, p.y, p.z), new THREE.Vector3(-Math.sign(p.x || 1), 0, 0)],
      ['top', trackH + h - p.y, new THREE.Vector3(p.x, trackH + h, p.z), new THREE.Vector3(0, -1, 0)],
    ];
  }
  faces.sort((a, b) => a[1] - b[1]);
  const [zone, , point, dir] = faces[0];
  const r = armourFace(spec, isTurret, zone, point, dir, new THREE.Vector3());
  return {
    label: plateLabel(isTurret, r.face || zone, zone, spec),
    thickness: r.thickness,
    slope: r.slope || 0,
    open: isOpenTop(spec, isTurret, zone),
  };
}

// Where a seat is, in words. +X is the vehicle's LEFT (tanks.js plateNormal).
function seatWhere(mod) {
  const part = mod.frame === 'turret' ? 'turret' : 'hull';
  const fb = mod.pos.z > 0.15 ? 'front' : mod.pos.z < -0.15 ? 'rear' : 'centre';
  const lr = mod.pos.x > 0.1 ? 'left' : mod.pos.x < -0.1 ? 'right' : '';
  return `${part}, ${fb}${lr ? ` ${lr}` : ''}`;
}

const MODULE_NAMES = {
  engine: 'Engine', transmission: 'Transmission', tracks: 'Tracks', breech: 'Gun breech',
  barrel: 'Gun barrel', traverse: 'Turret drive', elevation: 'Elevation drive',
  radiator: 'Radiator', ammoRack: 'Ammo rack',
};

function moduleName(key, kind, label) {
  if (kind === 'crew' && key && key.startsWith('crew_')) return IX_ROLE[key.slice(5)] || label || key;
  return (IX_KINDS[kind] && kind !== 'ammo' && kind !== 'fuel' ? IX_KINDS[kind].label : label) || key;
}

function maxCaliber(spec) {
  let c = 0;
  for (const s of Object.values(spec.shells || {})) c = Math.max(c, s.caliber || 0);
  return c || 75;
}

const pct = (x) => `${Math.round((x || 0) * 100)}%`;

// Square-on worth of every plate the spec describes, for the X-ray side panel.
function armourTable(spec) {
  const a = spec.armor || { hull: {}, turret: {} };
  const hs = a.hullSlope || {};
  const ts = a.turretSlope || {};
  const top = spec.shape && spec.shape.turret === 'casemate' ? 'Casemate' : 'Turret';
  const rows = [
    ['Hull front', a.hull.front, hs.front || 0],
    ['Hull side', a.hull.side, hs.side || 0],
    ['Hull rear', a.hull.rear, hs.rear || 0],
    ['Hull roof', a.hull.top, 0],
    [`${top} ${a.turretCheek ? 'cheek' : 'front'}`, a.turretCheek || a.turret.front, ts.front || 0],
  ];
  if (a.mantlet) rows.push(['Gun mantlet', a.mantlet, a.mantletSlope || 0]);
  rows.push([`${top} side`, a.turret.side, ts.side || 0]);
  rows.push([`${top} rear`, a.turret.rear, ts.rear || 0]);
  // an open-topped turret has no roof row to give: its top is the opening
  const open = turretOpenTop(spec);
  rows.push(open ? [`${top} top`, 0, 0, true] : [`${top} roof`, a.turret.top, 0]);
  return rows.map(([label, mm, slope, isOpen = false]) => ({
    label, mm: mm || 0, slope, open: isOpen,
    los: (mm || 0) / Math.max(0.2, Math.cos((slope * Math.PI) / 180)),
  }));
}

const _iv = new THREE.Vector3();
const _iw = new THREE.Vector3();
const _iq = new THREE.Quaternion();
const _ndc = new THREE.Vector2();
const _hp = [0, 0, 0];

// ---------------------------------------------------------------------------
// HangarInspector — the stage takeover
//
//   const ix = new HangarInspector({
//     host,            // the element to cover (the hangar stage)
//     spec, kind,      // the vehicle, 'ground' | 'air'
//     mode,            // 'xray' | 'armour'
//     shells,          // [{ label, items: [{ id, key, shell, label }] }]
//     defaultShell,    // an item id
//     title: { name, sub },
//     onExit,          // the exit button and Esc
//     ownRenderer,     // false when someone else will call renderFrame()
//   });
//   hangar.setOverlay(ix)   — or ix.start() when it owns its renderer
//   ix.dispose()            — everything it made goes back
//
// Rendering is driven from outside: renderFrame(renderer, dt, w, h) draws one
// frame with whatever renderer it is handed. The hangar passes its own, so the
// inspection never asks the browser for another WebGL context.
// ---------------------------------------------------------------------------
export class HangarInspector {
  constructor(opts = {}) {
    const spec = opts.spec;
    if (!spec) throw new Error('HangarInspector needs a spec');
    this.spec = spec;
    this.kind = opts.kind || (spec.hull ? 'ground' : 'air');
    this.isTank = this.kind === 'ground' && !!spec.hull;
    this.mode = this.isTank && opts.mode === 'armour' ? 'armour' : 'xray';
    this.view = ['pen', 'los', 'nominal'].includes(opts.view) ? opts.view : 'pen';
    this.title = opts.title || { name: spec.name || spec.id, sub: '' };
    this.onExit = typeof opts.onExit === 'function' ? opts.onExit : null;
    this.range = clampN(opts.range ?? 500, 10, 2000);
    this.labelsOn = opts.labels !== false;
    this.simCount = opts.simCount ?? 240;
    this.hidden = new Set();
    this.res = new Ledger();
    this.disposed = false;

    // shell catalogue: whatever the caller offers, and the vehicle's own rounds
    // when it offers nothing
    this.shellGroups = Array.isArray(opts.shells) && opts.shells.length ? opts.shells : [];
    if (!this.shellGroups.length && spec.shells) {
      this.shellGroups = [{
        label: spec.name || spec.id,
        items: Object.keys(spec.shells).map((k) => ({
          id: `self:${k}`, key: k, shell: spec.shells[k], label: shellLabel(k, spec.shells[k]),
        })),
      }];
    }
    this.shellIndex = new Map();
    for (const g of this.shellGroups) for (const it of g.items) this.shellIndex.set(it.id, { ...it, group: g.label });
    this.shellId = this.shellIndex.has(opts.defaultShell)
      ? opts.defaultShell
      : (this.shellIndex.keys().next().value || null);

    this.W = 0;
    this.H = 0;
    this.panelW = 300;
    this.barH = 46;
    this.legendH = 44;
    this.frame = 0;
    this.drag = null;
    this.hoverReq = null;
    this.hoverInfo = null;
    this.shot = null;
    this.heatDirty = true;
    this.heatRough = false;
    this.layoutDirty = true;
    this.camDirty = true;
    this.callouts = [];
    this.calloutKey = '';
    this.raycaster = new THREE.Raycaster();

    this.analyst = this.isTank && TankClass ? new ShotAnalyst(spec) : null;
    this.buildScene();
    this.el = null;
    this.buildDom(opts.host || null);
    this.renderer = null;
    this.ownRenderer = false;
    this.raf = 0;
    if (opts.ownRenderer) this.makeRenderer();
    this.applyMode();
  }

  // -------------------------------------------------------------------------
  // scene
  // -------------------------------------------------------------------------

  buildScene() {
    const spec = this.spec;
    const scene = new THREE.Scene();
    this.scene = scene;
    scene.background = new THREE.Color(0x0a0f15);
    this.camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.05, 600);
    // Lit for shape, not for mood: the module colours are a key, so the light
    // has to leave each hue recognisable on its shadowed side too.
    this.hemi = new THREE.HemisphereLight(0xd6e6ff, 0x1c242e, 1.7);
    this.keyLight = new THREE.DirectionalLight(0xfff4e6, 2.1);
    this.keyLight.position.set(6, 10, 7);
    this.rimLight = new THREE.DirectionalLight(0x8fb8ff, 1.0);
    this.rimLight.position.set(-7, 4, -8);
    scene.add(this.hemi, this.keyLight, this.rimLight);
    this.keyDir = this.keyLight.position.clone().normalize();
    this.world = new THREE.Group();
    scene.add(this.world);

    this.unitBox = this.res.g(new THREE.BoxGeometry(1, 1, 1));
    this.proxyMat = this.res.m(new THREE.MeshBasicMaterial({ visible: false }));
    this.edgeCache = new Map();

    this.buildGhost();
    this.buildSilhouetteSample();
    this.modules = [];
    this.kindMats = new Map();
    this.pickList = [];
    if (this.isTank) this.buildTankModules();
    else this.buildPlaneModules();
    if (this.isTank && this.analyst) this.buildHeatModel();

    // frame everything around the ghost's own bounds
    const box = new THREE.Box3().setFromObject(this.ghost);
    if (box.isEmpty()) box.set(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 2.5, 3));
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    this.radius = Math.max(1.5, 0.5 * size.length());
    this.floorY = this.isTank ? 0 : box.min.y - 0.35;
    this.home = { az: 0.78, el: this.isTank ? 0.3 : 0.36, dist: this.radius * 3, target: centre.clone() };
    this.orbit = { az: this.home.az, el: this.home.el, dist: this.home.dist };
    this.goal = { az: this.home.az, el: this.home.el, dist: this.home.dist };
    this.target = centre.clone();
    this.userZoomed = false;
    this.buildFloor();
    this.buildHighlight();
  }

  edgesFor(geo) {
    let e = this.edgeCache.get(geo);
    if (!e) {
      // 28 degrees: plate seams and the turret outline, not every facet of a
      // road wheel
      e = this.res.g(new THREE.EdgesGeometry(geo, 28));
      this.edgeCache.set(geo, e);
    }
    return e;
  }

  // The vehicle as X-ray film. The builder's meshes keep their cached geometry
  // (shared, never disposed here) and are only re-dressed in our materials.
  buildGhost() {
    const spec = this.spec;
    const built = this.isTank ? buildTankMesh(spec, null, null) : buildPlaneMesh(spec, null, null);
    this.built = built;
    this.ghost = built.group;
    this.world.add(this.ghost);
    const c = srgb(0x7fa6c8);
    const r = srgb(0xcfe6ff);
    this.ghostMat = this.res.m(new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Vector3(c[0], c[1], c[2]) },
        uRimColor: { value: new THREE.Vector3(r[0], r[1], r[2]) },
        uBase: { value: 0.045 },
        uRimAlpha: { value: 0.42 },
      },
      vertexShader: IX_GHOST_VS,
      fragmentShader: IX_GHOST_FS,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    this.ghostEdgeMat = this.res.m(new THREE.LineBasicMaterial({
      color: 0x9fd0ff, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false,
    }));
    this.ghostMeshes = [];
    built.group.traverse((o) => { if (o.isMesh) this.ghostMeshes.push(o); });
    for (const m of this.ghostMeshes) {
      m.material = this.ghostMat;
      m.castShadow = false;
      m.receiveShadow = false;
      m.renderOrder = 4;
      const lines = new THREE.LineSegments(this.edgesFor(m.geometry), this.ghostEdgeMat);
      lines.renderOrder = 5;
      m.add(lines);
    }
    this.ghost.updateMatrixWorld(true);
  }

  // A few thousand points off the vehicle's own surface, in world space (it
  // never moves), so the camera can be fitted to its real outline and not
  // only to its bounding sphere. Hidden parts (a propeller blur disc) are not
  // part of the outline.
  buildSilhouetteSample() {
    const pts = [];
    const v = new THREE.Vector3();
    for (const m of this.ghostMeshes) {
      let shown = true;
      for (let o = m; o; o = o.parent) if (!o.visible) shown = false;
      const pos = m.geometry && m.geometry.attributes.position;
      if (!shown || !pos) continue;
      const step = Math.max(1, Math.floor(pos.count / 240));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        pts.push(v.x, v.y, v.z);
      }
    }
    this.silPts = new Float32Array(pts);
  }

  kindMat(kind) {
    let m = this.kindMats.get(kind);
    if (!m) {
      const col = (IX_KINDS[kind] && IX_KINDS[kind].color) || 0x8fa0b0;
      // unlit-tone colours: the hue on screen has to match its legend chip
      m = this.res.m(new THREE.MeshStandardMaterial({
        color: col, roughness: 0.55, metalness: 0.12, emissive: col, emissiveIntensity: 0.16, toneMapped: false,
      }));
      this.kindMats.set(kind, m);
    }
    return m;
  }

  fixtureMat() {
    if (!this._fixture) {
      this._fixture = this.res.m(new THREE.MeshStandardMaterial({
        color: 0x3a4552, roughness: 0.8, metalness: 0.1, toneMapped: false,
      }));
    }
    return this._fixture;
  }

  vertexMat(kind) {
    const key = `v:${kind}`;
    let m = this.kindMats.get(key);
    if (!m) {
      const col = (IX_KINDS[kind] && IX_KINDS[kind].color) || 0xffffff;
      m = this.res.m(new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.2,
        emissive: col, emissiveIntensity: 0.1, toneMapped: false,
      }));
      this.kindMats.set(key, m);
    }
    return m;
  }

  // One module: its model (fitted inside its damage box), an invisible proxy
  // that IS its damage box for picking, and the record the UI reads.
  addModule(rec) {
    const group = new THREE.Group();
    group.position.copy(rec.pos);
    for (const part of rec.parts || []) {
      this.res.g(part.geo);
      const mat = part.mat === 'fixture' ? this.fixtureMat()
        : part.mat === 'vertex' ? this.vertexMat(rec.kind) : this.kindMat(rec.kind);
      let mesh;
      if (part.instances) {
        mesh = new THREE.InstancedMesh(part.geo, mat, part.instances.length);
        part.instances.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.instanceMatrix.needsUpdate = true;
      } else {
        mesh = new THREE.Mesh(part.geo, mat);
      }
      mesh.renderOrder = 1;
      mesh.userData.ixRec = rec;
      group.add(mesh);
    }
    rec.parent.add(group);
    const proxy = new THREE.Mesh(this.unitBox, this.proxyMat);
    proxy.position.copy(rec.pos);
    proxy.scale.set(rec.half.x * 2, rec.half.y * 2, rec.half.z * 2);
    proxy.userData.ix = rec;
    rec.parent.add(proxy);
    rec.group = group;
    rec.proxy = proxy;
    this.modules.push(rec);
    this.pickList.push(proxy);
    return rec;
  }

  buildTankModules() {
    const spec = this.spec;
    const caliber = maxCaliber(spec);
    const tg = this.built.turretGroup || this.ghost;
    for (const m of buildInternals(spec)) {
      const half = m.half;
      let parts;
      switch (m.kind) {
        case 'crew': parts = crewParts(half); break;
        case 'ammo': parts = ammoParts(half, caliber); break;
        case 'fuel': parts = fuelParts(half); break;
        case 'engine': parts = vEngineParts(half); break;
        case 'transmission': parts = transmissionParts(half); break;
        case 'breech': parts = breechParts(half); break;
        case 'barrel': parts = barrelParts(half, caliber); break;
        case 'traverse': parts = traverseParts(half); break;
        case 'elevation': parts = elevationParts(half); break;
        case 'radiator': parts = radiatorParts(half); break;
        default: parts = [{ geo: new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2), mat: 'kind' }];
      }
      const role = m.kind === 'crew' ? m.key.slice(5) : null;
      this.addModule({
        key: m.key, kind: m.kind, label: m.label, role, mod: m,
        half: m.half, pos: m.pos, frame: m.frame,
        parent: m.frame === 'turret' ? tg : this.ghost,
        parts, internal: true,
      });
    }
  }

  buildPlaneModules() {
    const spec = this.spec;
    const layout = planesMod.buildPlaneParts ? planesMod.buildPlaneParts(spec) : { boxes: [], hp: {} };
    const hp = layout.hp || spec.parts || {};
    const radial = spec.look && spec.look.engine === 'radial';
    let pilotBox = null;
    layout.boxes.forEach((b, i) => {
      const internal = PLANE_INTERNAL.has(b.part);
      const half = new THREE.Vector3(b.half[0], b.half[1], b.half[2]);
      const pos = new THREE.Vector3(b.pos[0], b.pos[1], b.pos[2]);
      let parts = null;
      if (internal) {
        if (b.part === 'engine') parts = radial ? radialEngineParts(half) : vEngineParts(half);
        else if (b.part === 'oilCooler') parts = coolerParts(half);
        else if (b.part === 'fuelTank') parts = fuelParts(half);
        else if (b.part === 'pilot') {
          parts = crewParts(half);
          parts.push({
            geo: put(new THREE.CylinderGeometry(0.014, 0.018, 0.42, 6), 0, -half.y + 0.25, half.z * 0.38, 0.35),
            mat: 'fixture',
          });
          pilotBox = { half, pos };
        } else if (b.part === 'controls') parts = controlsParts(half);
      }
      this.addModule({
        key: `${b.part}#${i}`, part: b.part, kind: internal ? b.part : 'structure',
        label: b.label || PART_LABELS[b.part] || b.part, hp: hp[b.part] || 0,
        half, pos, frame: 'airframe', parent: this.ghost, parts, internal,
      });
    });
    // The seat-back plate is what Cockpit Armour buys and the Il-2's whole
    // reason to exist. The damage model carries it as pilot structure (HP),
    // not as a plate a round is tested against, and the tooltip says so.
    if (pilotBox && (spec.pilotArmour || (spec.look && spec.look.armoured))) {
      const half = new THREE.Vector3(pilotBox.half.x * 0.95, pilotBox.half.y * 0.85, 0.02);
      const pos = pilotBox.pos.clone();
      pos.z -= pilotBox.half.z * 0.62;
      this.addModule({
        key: 'plate#pilot', part: 'plate', kind: 'plate', label: 'Armoured seat back',
        hp: hp.pilot || 0, half, pos, frame: 'airframe', parent: this.ghost,
        parts: [{ geo: new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2), mat: 'kind' }],
        internal: true,
      });
    }
  }

  // The protection model: the same vehicle, its own triangle soup, one colour
  // per triangle written by the battle's solver.
  buildHeatModel() {
    const built = buildTankMesh(this.spec, null, null);
    this.heatBuilt = built;
    this.heatGroup = built.group;
    this.world.add(built.group);
    built.group.updateMatrixWorld(true);
    this.heatMat = this.res.m(new THREE.ShaderMaterial({
      uniforms: {
        uLightDir: { value: new THREE.Vector3(0.4, 0.8, 0.4) },
        uAlpha: { value: 1 },
      },
      vertexShader: IX_HEAT_VS,
      fragmentShader: IX_HEAT_FS,
      // always in the transparent pass so the shot view can fade it without a
      // recompile; at alpha 1 with depth writes on it draws as a solid
      transparent: true,
      depthWrite: true,
    }));
    this.heatEdgeMat = this.res.m(new THREE.LineBasicMaterial({
      color: 0x0b1016, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false,
    }));
    this.heat = [];
    // the plate seams the triangles are cut along (see heatCuts)
    this.heatBoxList = heatBoxes(this.analyst, this.spec);
    const cuts = heatCuts(this.heatBoxList);
    const boxMats = this.heatBoxList.map((bx) => new THREE.Matrix4().fromArray(bx.e));
    const toBox = new THREE.Matrix4();
    const meshes = [];
    built.group.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (const mesh of meshes) {
      const src = mesh.geometry;
      const sp = src.attributes.position;
      const idx = src.index;
      const nv = idx ? idx.count : sp.count;
      const nSrc = Math.floor(nv / 3);
      const flat = new Float32Array(nSrc * 9);
      for (let i = 0; i < nSrc * 3; i++) {
        const vi = idx ? idx.getX(i) : i;
        flat[i * 3] = sp.getX(vi);
        flat[i * 3 + 1] = sp.getY(vi);
        flat[i * 3 + 2] = sp.getZ(vi);
      }
      const mats = boxMats.map((m) => toBox.multiplyMatrices(m, mesh.matrixWorld).elements.slice());
      const seamed = cuts.length ? splitAtSeams(flat, mats, cuts) : flat;
      const base = subdivideTriangles(seamed, mesh.matrixWorld, HEAT_PATCH);
      const nTri = base.length / 9;
      // the base triangles, then a pool of spares for the pieces paintHeat
      // cuts seam-crossing triangles into (drawn only as far as drawRange)
      const cap = nTri + Math.max(256, nTri);
      const positions = new Float32Array(cap * 9);
      positions.set(base, 0);
      // spares parked on the first vertex, so they never widen the bounds
      for (let v = nTri * 3; v < cap * 3; v++) positions.set(base.subarray(0, 3), v * 3);
      const geo = this.res.g(new THREE.BufferGeometry());
      const posAttr = new THREE.BufferAttribute(positions, 3);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', posAttr);
      const attr = new THREE.BufferAttribute(new Float32Array(cap * 9), 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aHeat', attr);
      geo.setDrawRange(0, nTri * 3);
      geo.computeBoundingSphere();
      const edges = this.edgesFor(src);
      mesh.geometry = geo;
      mesh.material = this.heatMat;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 3;
      const lines = new THREE.LineSegments(edges, this.heatEdgeMat);
      lines.renderOrder = 4;
      mesh.add(lines);
      // base corners, centroids and facet normals in world space, once: the
      // vehicle never moves, only the camera does. `cen` and `nrm` describe
      // whatever is drawn in each slot (a seam piece shows its own centroid
      // and its parent's normal); `bcen` stays the base triangle's.
      const wv = new Float32Array(nTri * 9);
      const bcen = new Float32Array(nTri * 3);
      const cen = new Float32Array(cap * 3);
      const nrm = new Float32Array(cap * 3);
      const mw = mesh.matrixWorld;
      for (let t = 0; t < nTri; t++) {
        a.fromArray(base, t * 9).applyMatrix4(mw);
        b.fromArray(base, t * 9 + 3).applyMatrix4(mw);
        c.fromArray(base, t * 9 + 6).applyMatrix4(mw);
        a.toArray(wv, t * 9);
        b.toArray(wv, t * 9 + 3);
        c.toArray(wv, t * 9 + 6);
        bcen[t * 3] = cen[t * 3] = (a.x + b.x + c.x) / 3;
        bcen[t * 3 + 1] = cen[t * 3 + 1] = (a.y + b.y + c.y) / 3;
        bcen[t * 3 + 2] = cen[t * 3 + 2] = (a.z + b.z + c.z) / 3;
        b.sub(a);
        c.sub(a);
        b.cross(c).normalize();
        nrm[t * 3] = b.x;
        nrm[t * 3 + 1] = b.y;
        nrm[t * 3 + 2] = b.z;
      }
      // a mirrored part winds the other way round, and three flips the face
      // it culls to match
      const facing = mw.determinant() < 0 ? -1 : 1;
      // Corners welded (to a hundredth of a millimetre, through a spatial
      // hash): neighbouring triangles share their corners, so the seam check
      // asks each corner's ray once per paint rather than once for every
      // triangle around it.
      const nCorner = nTri * 3;
      const vid = new Int32Array(nCorner);
      const qv = new Int32Array(nCorner * 3);
      const size = 1 << Math.max(4, Math.ceil(Math.log2(nCorner * 2)));
      const head = new Int32Array(size).fill(-1);
      const chain = new Int32Array(nCorner);
      let welded = 0;
      for (let v = 0; v < nCorner; v++) {
        const xi = Math.round(wv[v * 3] * 1e5);
        const yi = Math.round(wv[v * 3 + 1] * 1e5);
        const zi = Math.round(wv[v * 3 + 2] * 1e5);
        qv[v * 3] = xi;
        qv[v * 3 + 1] = yi;
        qv[v * 3 + 2] = zi;
        const h = (Math.imul(xi, 73856093) ^ Math.imul(yi, 19349663) ^ Math.imul(zi, 83492791)) & (size - 1);
        let id = -1;
        for (let c = head[h]; c >= 0; c = chain[c]) {
          if (qv[c * 3] === xi && qv[c * 3 + 1] === yi && qv[c * 3 + 2] === zi) {
            id = vid[c];
            break;
          }
        }
        if (id < 0) {
          id = welded++;
          chain[v] = head[h];
          head[h] = v;
        }
        vid[v] = id;
      }
      this.heat.push({
        mesh, attr, pos: posAttr, base, wv, bcen, cen, nrm, n: nTri, cap, facing,
        split: [], used: 0,
        vid, vcls: new Int16Array(welded), vval: new Float32Array(welded), vstamp: new Int32Array(welded),
      });
    }
  }

  // A technical floor: a metre grid fading into the dark, and a pool of cold
  // light under the vehicle so it does not float in a void.
  buildFloor() {
    const R = Math.max(8, Math.ceil(this.radius * 2.2));
    const bg = new THREE.Color(0x0a0f15);
    const minor = new THREE.Color(0x2b3a4a);
    const major = new THREE.Color(0x3f5670);
    const pos = [];
    const col = [];
    const tmp = new THREE.Color();
    const push = (x, z, isMajor) => {
      const f = Math.max(0, 1 - Math.pow(Math.hypot(x, z) / R, 1.4));
      tmp.copy(bg).lerp(isMajor ? major : minor, f);
      pos.push(x, 0, z);
      col.push(tmp.r, tmp.g, tmp.b);
    };
    for (let i = -R; i <= R; i++) {
      const isMajor = i % 5 === 0;
      for (let j = -R; j < R; j++) {
        push(i, j, isMajor); push(i, j + 1, isMajor);
        push(j, i, isMajor); push(j + 1, i, isMajor);
      }
    }
    const geo = this.res.g(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const grid = new THREE.LineSegments(geo, this.res.m(new THREE.LineBasicMaterial({
      vertexColors: true, toneMapped: false,
    })));
    grid.position.y = this.floorY;
    grid.renderOrder = 0;
    this.world.add(grid);

    const disc = this.res.g(new THREE.CircleGeometry(this.radius * 1.15, 48));
    disc.rotateX(-Math.PI / 2);
    const dp = disc.attributes.position;
    const dc = new Float32Array(dp.count * 4);
    const glow = new THREE.Color(0x24405e);
    for (let i = 0; i < dp.count; i++) {
      const rr = Math.hypot(dp.getX(i), dp.getZ(i)) / (this.radius * 1.15);
      dc[i * 4] = glow.r;
      dc[i * 4 + 1] = glow.g;
      dc[i * 4 + 2] = glow.b;
      dc[i * 4 + 3] = Math.max(0, 1 - rr) * 0.55;
    }
    disc.setAttribute('color', new THREE.BufferAttribute(dc, 4));
    const pool = new THREE.Mesh(disc, this.res.m(new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, toneMapped: false,
    })));
    pool.position.y = this.floorY + 0.005;
    pool.renderOrder = 0;
    this.world.add(pool);
  }

  buildHighlight() {
    this.hlBox = new THREE.Mesh(this.unitBox, this.res.m(new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false, toneMapped: false,
    })));
    // the twelve edges of the unit box, shared by the hover outline and every
    // module a test shot marks
    this.unitEdges = this.res.g(new THREE.EdgesGeometry(this.unitBox));
    this.hlEdges = new THREE.LineSegments(this.unitEdges,
      this.res.m(new THREE.LineBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false,
      })));
    this.hlBox.renderOrder = 8;
    this.hlEdges.renderOrder = 9;
    this.hlBox.visible = false;
    this.hlEdges.visible = false;
    this.world.add(this.hlBox, this.hlEdges);
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  buildDom(host) {
    this.host = host;
    if (!host || typeof document === 'undefined' || !document.createElement) return;
    const mk = (tag, cls) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      return e;
    };
    const root = mk('div', 'ixRoot');
    const svg = document.createElementNS ? document.createElementNS(SVGNS, 'svg') : mk('div');
    svg.setAttribute('class', 'ixLeaders');
    const labels = mk('div', 'ixLabels');
    const hit = mk('div', 'ixHit');
    const bar = mk('div', 'ixBar');
    const panel = mk('aside', 'ixPanel');
    const legend = mk('div', 'ixLegend');
    const tip = mk('div', 'ixTip');
    tip.style.display = 'none';
    root.appendChild(svg);
    root.appendChild(labels);
    root.appendChild(hit);
    root.appendChild(bar);
    root.appendChild(panel);
    root.appendChild(legend);
    root.appendChild(tip);
    host.appendChild(root);
    this.el = { root, svg, labels, hit, bar, panel, legend, tip };

    this.onUiClick = (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-ix]') : null;
      if (t) this.command(t.getAttribute('data-ix'));
    };
    this.onUiInput = (e) => {
      const t = e.target;
      if (!t || !t.getAttribute) return;
      if (t.getAttribute('data-ixsel') === 'shell') this.setShell(t.value);
      else if (t.getAttribute('data-ixrange') === 'range') this.setRange(Number(t.value), e.type === 'change');
    };
    root.addEventListener('click', this.onUiClick);
    root.addEventListener('input', this.onUiInput);
    root.addEventListener('change', this.onUiInput);

    this.onDown = (e) => {
      if (e.button !== undefined && e.button !== 0 && e.button !== 2) return;
      const p = this.localXY(e);
      this.drag = { id: e.pointerId, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: 0, button: e.button || 0 };
      if (hit.setPointerCapture && e.pointerId !== undefined) {
        try { hit.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      }
      hit.classList.add('drag');
      this.setHover(null);
    };
    this.onMove = (e) => {
      const p = this.localXY(e);
      if (this.drag && e.pointerId === this.drag.id) {
        const dx = p.x - this.drag.x;
        const dy = p.y - this.drag.y;
        this.drag.x = p.x;
        this.drag.y = p.y;
        this.drag.moved += Math.abs(dx) + Math.abs(dy);
        if (this.drag.moved > 4) this.orbitBy(dx, dy);
        return;
      }
      this.hoverReq = p;
    };
    this.onUp = (e) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      const d = this.drag;
      this.drag = null;
      hit.classList.remove('drag');
      if (hit.releasePointerCapture && e.pointerId !== undefined) {
        try { hit.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      }
      if (d.moved <= 4 && d.button === 0) {
        this.clickAt(d.sx, d.sy);
        // a touch screen has no hover: a tap is how a tooltip is asked for
        this.hoverReq = { x: d.sx, y: d.sy };
      }
    };
    this.onLeave = () => {
      if (this.drag) return;
      this.hoverReq = null;
      this.setHover(null);
    };
    this.onWheel = (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY > 0 ? 1.12 : 1 / 1.12);
    };
    this.onDbl = (e) => {
      e.preventDefault();
      this.resetView();
    };
    this.onCtx = (e) => e.preventDefault();
    hit.addEventListener('pointerdown', this.onDown);
    hit.addEventListener('pointermove', this.onMove);
    hit.addEventListener('pointerup', this.onUp);
    hit.addEventListener('pointercancel', this.onUp);
    hit.addEventListener('pointerleave', this.onLeave);
    hit.addEventListener('wheel', this.onWheel, { passive: false });
    hit.addEventListener('dblclick', this.onDbl);
    hit.addEventListener('contextmenu', this.onCtx);
  }

  localXY(e) {
    const r = this.el && this.el.root.getBoundingClientRect ? this.el.root.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: (e.clientX || 0) - r.left, y: (e.clientY || 0) - r.top };
  }

  command(cmd) {
    if (!cmd) return;
    if (cmd === 'exit') {
      if (this.onExit) this.onExit();
      return;
    }
    if (cmd.startsWith('mode:')) this.setMode(cmd.slice(5));
    else if (cmd.startsWith('view:')) this.setView(cmd.slice(5));
    else if (cmd.startsWith('kind:')) this.toggleKind(cmd.slice(5));
    else if (cmd === 'labels') this.setLabels(!this.labelsOn);
    else if (cmd === 'reset') this.resetView();
    else if (cmd === 'clearshot') this.clearShot();
  }

  // Panel and bar sizes as laid out by style.css. A measurement that makes no
  // sense (a detached element, a test stub) falls back to the CSS defaults.
  measure() {
    const W = this.W;
    const pw = this.el ? this.el.panel.offsetWidth : 0;
    this.panelW = pw > 120 && pw < W * 0.6 ? pw : W >= 1100 ? 300 : W >= 860 ? 272 : 248;
    const bh = this.el ? this.el.bar.offsetHeight : 0;
    this.barH = bh > 20 && bh < 120 ? bh : 46;
    const lh = this.el ? this.el.legend.offsetHeight : 0;
    this.legendH = lh > 0 && lh < 200 ? lh + 12 : 44;
    // the panel and bar may have changed width with the window (style.css
    // media blocks)
    this.fitSeg();
    this.fitBar();
    this.camera.aspect = W / Math.max(1, this.H);
    // Centre the model in the part of the stage the panel does not cover: the
    // frustum is shifted rather than the canvas shrunk, so the stage keeps one
    // canvas at one size whatever the panel does.
    this.camera.setViewOffset(W, this.H, this.panelW / 2, -this.barH / 2, W, this.H);
    this.camera.updateProjectionMatrix();
    this.refit();
    if (this.frame === 0) this.orbit.dist = this.home.dist * 1.08;
  }

  // The starting distance: the bounding-sphere fit, then backed off as far as
  // the callout columns need (roomForLabels). A view the player zoomed is left
  // where it is.
  refit() {
    if (!this.W || !this.H) return;
    const fit = this.roomForLabels(this.fitDistance());
    this.home.dist = fit;
    if (!this.userZoomed) this.goal.dist = fit;
  }

  // The sphere fit keeps the vehicle clear of the bar, the panel and the legend
  // from every angle, but not of the two strips the callouts stand in. At the
  // starting view the vehicle's real outline (silPts) is kept out of them, with
  // the camera backed off only as far as that takes — on a 1366 px stage or
  // wider the sphere fit already leaves the room, so only a ~1024 px window
  // ever pays for it. Orbiting or zooming afterwards can still bring a hull
  // edge under a label: that view is the player's choice.
  roomForLabels(dist) {
    if (this.mode !== 'xray' || !this.labelsOn || !this.silPts || !this.silPts.length) return dist;
    // every callout the X-ray can show, hidden kinds included, so switching a
    // legend chip never moves the camera
    const hidden = this.hidden;
    this.hidden = new Set();
    const items = this.calloutItems();
    this.hidden = hidden;
    let maxW = 0;
    for (const it of items) maxW = Math.max(maxW, this.callW(it.text));
    if (!maxW) return dist;
    const freeW = this.W - this.panelW;
    // label column + leader elbow + a little air between it and the hull
    const allowed = freeW / 2 - (CALL_MARGIN + maxW + 14);
    // a stage so narrow the columns could never clear the vehicle: do not
    // shrink it to a postage stamp trying
    if (allowed < freeW * 0.2) return dist;
    const cam = this.fitCam || (this.fitCam = new THREE.PerspectiveCamera());
    cam.copy(this.camera, false);
    const cx = freeW / 2;
    const p = this.silPts;
    let d = dist;
    for (let k = 0; k < 5; k++) {
      this.placeCamera(cam, this.home.az, this.home.el, d);
      let ext = 0;
      for (let i = 0; i < p.length; i += 3) {
        _iv.set(p[i], p[i + 1], p[i + 2]).project(cam);
        ext = Math.max(ext, Math.abs(((_iv.x + 1) / 2) * this.W - cx));
      }
      if (ext <= allowed + 0.5) break;
      // perspective: backing off shrinks the near side a little less than the
      // ratio, so overshoot by a hair and converge from outside
      d *= (ext / allowed) * 1.01;
    }
    return d;
  }

  fitDistance() {
    const W = Math.max(1, this.W);
    const H = Math.max(1, this.H);
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    const visW = Math.max(0.2, (W - this.panelW) / W);
    const visH = Math.max(0.2, (H - this.barH - this.legendH) / H);
    const t = Math.min(tanV * visH, tanV * (W / H) * visW);
    return (this.radius / Math.sin(Math.atan(t))) * 1.02;
  }

  // -------------------------------------------------------------------------
  // camera
  // -------------------------------------------------------------------------

  orbitBy(dx, dy) {
    this.goal.az -= dx * 0.0065;
    this.goal.el = clampN(this.goal.el + dy * 0.005, -0.2, 1.42);
  }

  zoomBy(f) {
    this.userZoomed = true;
    this.goal.dist = clampN(this.goal.dist * f, this.radius * 1.1, this.radius * 8);
  }

  resetView() {
    this.userZoomed = false;
    this.goal.az = this.home.az;
    this.goal.el = this.home.el;
    this.goal.dist = this.home.dist;
  }

  placeCamera(cam, az, el, dist) {
    const ce = Math.cos(el);
    cam.position.set(
      this.target.x + Math.sin(az) * ce * dist,
      this.target.y + Math.sin(el) * dist,
      this.target.z + Math.cos(az) * ce * dist,
    );
    cam.lookAt(this.target);
    cam.updateMatrixWorld();
  }

  applyCamera() {
    const o = this.orbit;
    this.placeCamera(this.camera, o.az, o.el, o.dist);
    if (this.heatMat) {
      this.heatMat.uniforms.uLightDir.value.copy(this.keyDir)
        .transformDirection(this.camera.matrixWorldInverse);
    }
  }

  rayAt(x, y) {
    _ndc.set((x / Math.max(1, this.W)) * 2 - 1, -((y / Math.max(1, this.H)) * 2 - 1));
    this.raycaster.setFromCamera(_ndc, this.camera);
    return this.raycaster.ray;
  }

  // -------------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------------

  // One frame, drawn with whatever renderer the caller hands in (the hangar's,
  // so no second WebGL context is ever needed), at the caller's CSS size.
  renderFrame(renderer, dt = 1 / 60, w = 0, h = 0) {
    if (this.disposed) return;
    this.update(dt, w || this.W || 1280, h || this.H || 720);
    if (renderer) renderer.render(this.scene, this.camera);
  }

  update(dt, w, h) {
    const W = Math.max(1, w | 0);
    const H = Math.max(1, h | 0);
    if (W !== this.W || H !== this.H) {
      this.W = W;
      this.H = H;
      this.measure();
      this.camDirty = true;
    }
    const k = 1 - Math.exp(-Math.max(0, dt) * 14);
    let moved = false;
    for (const key of ['az', 'el', 'dist']) {
      const dv = this.goal[key] - this.orbit[key];
      if (Math.abs(dv) > 1e-4) {
        this.orbit[key] += dv * k;
        moved = true;
      } else {
        this.orbit[key] = this.goal[key];
      }
    }
    // an orbit written from outside (a test, a scripted view) counts as a move
    const ap = this.appliedOrbit;
    if (!ap || ap.az !== this.orbit.az || ap.el !== this.orbit.el || ap.dist !== this.orbit.dist) moved = true;
    if (moved || this.camDirty) {
      this.applyCamera();
      this.appliedOrbit = { az: this.orbit.az, el: this.orbit.el, dist: this.orbit.dist };
      this.camDirty = false;
      this.layoutDirty = true;
      if (this.mode === 'armour') this.heatDirty = true;
    }
    if (this.hoverReq) {
      const p = this.hoverReq;
      this.hoverReq = null;
      this.doHover(p.x, p.y);
    }
    if (this.mode === 'armour' && (this.heatDirty || this.heatRough) && this.heat) {
      // while the camera is still swinging every other frame is plenty, and
      // the seams are left uncut (paintHeat's rough pass); the frame it
      // settles on is always repainted in full
      if (!moved) {
        this.paintHeat();
        this.heatDirty = false;
        this.heatRough = false;
      } else if ((this.frame & 1) === 0) {
        this.paintHeat(true);
        this.heatDirty = false;
        this.heatRough = true;
      }
    }
    this.tickShot(dt);
    if (this.layoutDirty) {
      this.layoutDirty = false;
      this.layoutLabels();
    }
    this.frame++;
  }

  makeRenderer() {
    if (!this.el || typeof window === 'undefined') return;
    try {
      const r = new THREE.WebGLRenderer({ antialias: true });
      r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      const c = r.domElement;
      c.className = 'ixCanvas';
      this.el.root.insertBefore(c, this.el.root.firstChild || null);
      this.renderer = r;
      this.ownRenderer = true;
    } catch {
      // no context to be had: the panels and the numbers still work
      this.renderer = null;
      this.ownRenderer = false;
    }
  }

  // Own render loop — only used when no hangar renderer was available.
  start() {
    if (!this.ownRenderer || !this.renderer || this.raf || typeof requestAnimationFrame !== 'function') return this;
    let last = 0;
    const step = (now) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(step);
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      const w = this.el.root.clientWidth | 0;
      const h = this.el.root.clientHeight | 0;
      if (w <= 0 || h <= 0) return;
      const cv = this.renderer.domElement;
      const pr = this.renderer.getPixelRatio();
      if (Math.abs(cv.width - w * pr) > 1 || Math.abs(cv.height - h * pr) > 1) this.renderer.setSize(w, h, false);
      this.renderFrame(this.renderer, dt, w, h);
    };
    this.raf = requestAnimationFrame(step);
    return this;
  }

  // -------------------------------------------------------------------------
  // modes
  // -------------------------------------------------------------------------

  setMode(mode) {
    const next = mode === 'armour' && this.isTank && this.analyst ? 'armour' : 'xray';
    if (next === this.mode && this._applied) return;
    this.mode = next;
    this.clearShot(true);
    this.applyMode();
  }

  applyMode() {
    this._applied = true;
    const armour = this.mode === 'armour';
    for (const m of this.ghostMeshes) m.visible = !armour;
    if (this.heatGroup) this.heatGroup.visible = armour;
    this.syncModuleVisibility();
    this.heatDirty = true;
    this.layoutDirty = true;
    this.setHover(null);
    this.renderBar();
    this.renderPanel();
    this.renderLegend();
    // the X-ray's callout columns want room the heat map does not
    this.refit();
  }

  syncModuleVisibility() {
    const armour = this.mode === 'armour';
    for (const r of this.modules) {
      const show = armour ? !!this.shot && r.internal : r.internal && !this.hidden.has(r.kind);
      if (r.group) r.group.visible = show;
    }
  }

  setView(v) {
    if (!['pen', 'los', 'nominal'].includes(v) || v === this.view) return;
    this.view = v;
    this.heatDirty = true;
    this.renderPanel();
    this.renderLegend();
  }

  setShell(id) {
    if (!this.shellIndex.has(id) || id === this.shellId) return;
    this.shellId = id;
    this.heatDirty = true;
    if (this.shot) this.refire();
    this.renderPanel();
  }

  setRange(m, commit = true) {
    const v = clampN(Math.round(m || 0), 10, 2000);
    this.range = v;
    this.heatDirty = true;
    if (this.el) {
      // the readouts next to the slider update live; the panel itself is only
      // rebuilt on release, or the slider would be torn out from under the drag
      const out = this.el.panel.querySelector ? this.el.panel.querySelector('[data-ixout="range"]') : null;
      if (out) out.textContent = `${v} m`;
      const pen = this.el.panel.querySelector ? this.el.panel.querySelector('[data-ixout="pen"]') : null;
      if (pen) pen.innerHTML = this.penLine();
    }
    if (commit) {
      if (this.shot) this.refire();
      this.renderPanel();
    }
  }

  setLabels(on) {
    this.labelsOn = !!on;
    this.layoutDirty = true;
    this.renderBar();
    this.refit();
  }

  toggleKind(kind) {
    if (this.hidden.has(kind)) this.hidden.delete(kind);
    else this.hidden.add(kind);
    this.syncModuleVisibility();
    this.layoutDirty = true;
    this.setHover(null);
    this.renderLegend();
    this.renderPanel();
  }

  currentShell() {
    return this.shellId ? this.shellIndex.get(this.shellId) || null : null;
  }

  // -------------------------------------------------------------------------
  // protection heat map
  // -------------------------------------------------------------------------

  // One colour per triangle, out of the battle's own functions: the ray a shell
  // fired from here at that triangle would fly, the box it would strike, the
  // plate armourFace says is there, and the verdict penetrationForecast gives.
  // Triangles the collision boxes do not cover are painted as not-armour.
  // A triangle whose corner rays tell a different colour from its centroid's
  // (a seam crossing it as seen from here — see heatSeamCode) is shown as the
  // pieces seamPieces cuts it into, each coloured from its own centroid ray.
  // `rough` (the camera still swinging): centroids only, no seams.
  paintHeat(rough = false) {
    const an = this.analyst;
    if (!an || !this.heat) return;
    const view = this.view;
    const cam = this.camera.position;
    const sh = this.currentShell();
    const pt = new THREE.Vector3();
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const plate = {};
    const none = srgb(NOT_ARMOUR, [0, 0, 0]);
    const penCol = {};
    for (const p of PEN_LEGEND) penCol[p.key] = srgb(p.color, [0, 0, 0]);
    let painted = 0;
    const range = this.range;
    // The hit a round fired from the camera through world point (x, y, z)
    // takes: the box is struck before the point (the point is on or inside
    // the armour), or within a few centimetres past it (a mantlet or a fender
    // standing proud of the box); anything further out is a fitting the
    // collision volumes do not include, and is no hit.
    const strike = (x, y, z) => {
      pt.set(x, y, z);
      p0.copy(cam);
      dir.copy(pt).sub(cam);
      const L = dir.length();
      if (L < 1e-6) return null;
      dir.multiplyScalar(1 / L);
      p1.copy(pt).addScaledVector(dir, 2.5);
      const segLen = L + 2.5;
      const tC = L / segLen;
      const hit = an.hitSegment(p0, p1, range, null);
      return hit && (hit.t <= tC + 1e-6 || (hit.t - tC) * segLen < 0.45) ? hit : null;
    };
    // ...and the plate a round through it would really end on, however far
    // behind: what a click there reports, and where a real shot goes on to
    // after passing through a fitting
    const strikeFar = (x, y, z) => {
      pt.set(x, y, z);
      p0.copy(cam);
      dir.copy(pt).sub(cam);
      const L = dir.length();
      if (L < 1e-6) return null;
      dir.multiplyScalar(1 / L);
      p1.copy(pt).addScaledVector(dir, 120);
      return an.hitSegment(p0, p1, range, null);
    };
    // seams: the camera in each collision box's frame, and the code of the
    // ray through a world point (heatSeamCode)
    const boxes = view !== 'pen' || sh ? this.heatBoxList || [] : [];
    const cams = boxes.map((b) => {
      const e = b.e;
      return [
        e[0] * cam.x + e[4] * cam.y + e[8] * cam.z + e[12],
        e[1] * cam.x + e[5] * cam.y + e[9] * cam.z + e[13],
        e[2] * cam.x + e[6] * cam.y + e[10] * cam.z + e[14],
      ];
    });
    const codeAt = (x, y, z, far = false) => {
      const dx = x - cam.x;
      const dy = y - cam.y;
      const dz = z - cam.z;
      const sMax = far ? 1e9 : 1 + 0.45 / Math.max(1e-6, Math.sqrt(dx * dx + dy * dy + dz * dz));
      return heatSeamCode(boxes, cams, x, y, z, sMax);
    };
    // A verdict depends on nothing but the plate and the angle the round
    // meets it at (with the shell and the range fixed): penetrationForecast is
    // asked once per plate and per 1/4096 of the cosine of incidence (a
    // hundredth of a degree off the grazing end, where the verdict turns),
    // along a real ray, and the answer kept until the shell or the range
    // changes — the camera can swing as it likes.
    const tag = `${this.shellId}|${range}`;
    if (!this.heatVerdicts || this.heatVerdicts.tag !== tag) this.heatVerdicts = { tag, byCode: [] };
    const byCode = this.heatVerdicts.byCode;
    if (!this.heatPlates) this.heatPlates = [];
    const plates = this.heatPlates;
    const fast = boxes.length > 0 && !!armourFace;
    let lastCode = 0;
    // The colour of the ray through (x, y, z) into `out`; returns -1 for no
    // armour, else what the colour shows: the verdict's PEN_RANK, or the
    // thickness in mm. `far`: judged on whatever box it ends on, however far
    // behind the point. (lastCode: that ray's seam code, on the fast path.)
    const judge = (x, y, z, out, far = false) => {
      let rgb = none;
      let rank = -1;
      if (fast) {
        const code = codeAt(x, y, z, far);
        lastCode = code;
        if (code) {
          heatPlateOf(boxes, this.spec, code, plates, plate);
          rank = 0;
          if (view !== 'pen') {
            rank = view === 'nominal' ? plate.thickness : plate.thickness / Math.max(0.2, plate.cos);
            rgb = thicknessColor(rank, out);
          } else if (sh) {
            // verdict table per code, one slot per 1/4096 of the cosine:
            // 0 unknown, else PEN_RANK + 1
            const bins = byCode[code] || (byCode[code] = new Int8Array(4097));
            const bin = Math.round(plate.cos * 4096);
            let v = bins[bin];
            if (!v) {
              const hit = far ? strikeFar(x, y, z) : strike(x, y, z);
              const key = hit ? an.verdict(hit, sh.shell, sh.key) : null;
              if (key) v = bins[bin] = (PEN_RANK[key] || 0) + 1;
            }
            if (v) {
              rank = v - 1;
              rgb = penCol[PEN_KEYS[rank]] || none;
            } else rank = -1;
          }
        }
      } else {
        const hit = far ? strikeFar(x, y, z) : strike(x, y, z);
        if (hit) {
          rank = 0;
          if (view !== 'pen') {
            an.plateOf(hit, plate);
            rank = view === 'nominal' ? plate.thickness : plate.los;
            rgb = thicknessColor(rank, out);
          } else if (sh) {
            const key = an.verdict(hit, sh.shell, sh.key);
            rgb = penCol[key] || none;
            rank = PEN_RANK[key] || 0;
          }
        }
      }
      if (rgb !== out) {
        out[0] = rgb[0];
        out[1] = rgb[1];
        out[2] = rgb[2];
      }
      return rank;
    };
    const W = new Float64Array(9);
    const leaves = [];
    const probe = [0, 0, 0];
    // What a seam separates: in the penetration view the verdict itself — a
    // high-explosive round's blast beats a plate below one angle and not
    // above it, so a verdict can change in the middle of one plate — and in
    // the thickness views the plate (seam code).
    const ctx = {
      at: (u, v, w) => {
        const x = u * W[0] + v * W[3] + w * W[6];
        const y = u * W[1] + v * W[4] + w * W[7];
        const z = u * W[2] + v * W[5] + w * W[8];
        return view === 'pen' ? judge(x, y, z, probe) + 1 : codeAt(x, y, z);
      },
      grow: (a, b) => {
        if (view !== 'pen') return 0;
        const d = (SEAM_GROW[a] ?? 0) - (SEAM_GROW[b] ?? 0);
        return d > 0 ? 1 : d < 0 ? -1 : 0;
      },
      // world distance between two barycentric points (arrays, at offsets)
      len: (A, ia, B, ib) => {
        let d2 = 0;
        for (let a = 0; a < 3; a++) {
          const d = (B[ib] - A[ia]) * W[a] + (B[ib + 1] - A[ia + 1]) * W[3 + a]
            + (B[ib + 2] - A[ia + 2]) * W[6 + a];
          d2 += d * d;
        }
        return Math.sqrt(d2);
      },
      leaf: (T, worst) => { leaves.push(T, worst); },
    };
    const BASE = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    // this paint's mark on the welded corners it has judged
    const stamp = (this.heatStamp = (((this.heatStamp || 0) + 1) & 0x3fffffff) || 1);
    const ki = 1 - HEAT_INSET;
    const rgb = [0, 0, 0];
    const tmp = [0, 0, 0];
    const leafRgb = [];
    const leafPt = [0, 0, 0];
    // world point of a barycentric point of the base triangle in W
    const toWorld = (u, v, w, o) => {
      o[0] = u * W[0] + v * W[3] + w * W[6];
      o[1] = u * W[1] + v * W[4] + w * W[7];
      o[2] = u * W[2] + v * W[5] + w * W[8];
      return o;
    };
    // The most penetrable answer at a point, for a piece that has to be one
    // colour over more than one plate: where the ray passes a fitting (no
    // armour within reach) a round goes on to the plate behind, and that
    // plate's verdict is the one that counts. Raises `out`/the returned rank.
    const worse = (x, y, z, rank, out) => {
      let r = judge(x, y, z, tmp);
      if (r < 0) r = judge(x, y, z, tmp, true);
      if (r > rank) {
        out[0] = tmp[0];
        out[1] = tmp[1];
        out[2] = tmp[2];
        return r;
      }
      return rank;
    };
    // Colour one seam piece: its centroid ray — or, still straddling a seam at
    // the depth limit, in the penetration view the most penetrable answer of
    // fifteen rays spread over it, so a strip of thin roof between two
    // samples cannot hide under a green piece.
    const colourLeaf = (T, worst, out) => {
      const gu = (T[0] + T[3] + T[6]) / 3;
      const gv = (T[1] + T[4] + T[7]) / 3;
      const gw = (T[2] + T[5] + T[8]) / 3;
      toWorld(gu, gv, gw, leafPt);
      let rank = judge(leafPt[0], leafPt[1], leafPt[2], out);
      if (worst && view === 'pen') {
        for (let a = 0; a <= 4; a++) {
          for (let b = 0; a + b <= 4; b++) {
            const c3 = 4 - a - b;
            const u = (a * T[0] + b * T[3] + c3 * T[6]) / 4;
            const v = (a * T[1] + b * T[4] + c3 * T[7]) / 4;
            const w = (a * T[2] + b * T[5] + c3 * T[8]) / 4;
            toWorld(gu + (u - gu) * ki, gv + (v - gv) * ki, gw + (w - gw) * ki, leafPt);
            rank = worse(leafPt[0], leafPt[1], leafPt[2], rank, out);
          }
        }
      }
      return rank;
    };
    // Every view reads the plate a round fired from the camera through that
    // triangle would strike — NOMINAL too, so whatever colour the cursor is on
    // is the plate a click there reports (asked along the surface normal
    // instead, a face near the edge of a collision box named a different plate
    // than the shot did). So every view is repainted when the camera moves, and
    // a face turned away from the camera is culled by the GPU (heatMat draws
    // front faces only): asking the solver about it would be wasted — half the
    // triangles, half the cost. It is painted the moment the camera brings it
    // round.
    for (const rec of this.heat) {
      const arr = rec.attr.array;
      const pos = rec.pos.array;
      const nr = rec.nrm;
      const bc = rec.bcen;
      const wv = rec.wv;
      // put back the triangles last paint showed as pieces
      const moved = rec.split.length > 0;
      for (const i of rec.split) {
        for (let k = 0; k < 9; k++) pos[i * 9 + k] = rec.base[i * 9 + k];
        rec.cen[i * 3] = bc[i * 3];
        rec.cen[i * 3 + 1] = bc[i * 3 + 1];
        rec.cen[i * 3 + 2] = bc[i * 3 + 2];
      }
      rec.split.length = 0;
      rec.used = 0;
      for (let i = 0; i < rec.n; i++) {
        const k = i * 3;
        const cx = bc[k];
        const cy = bc[k + 1];
        const cz = bc[k + 2];
        const s = (cam.x - cx) * nr[k] + (cam.y - cy) * nr[k + 1] + (cam.z - cz) * nr[k + 2];
        if (s * rec.facing <= 0) continue;
        const value = judge(cx, cy, cz, rgb);
        // A seam is worth cutting along only where the colour changes: in the
        // penetration view any corner with another verdict; in the thickness
        // views a corner on another plate, 4 mm or more apart.
        let seam = false;
        if (boxes.length && !rough) {
          const k0 = fast ? lastCode : codeAt(cx, cy, cz);
          for (let j = 0; j < 3 && !seam; j++) {
            // each welded corner is judged once a paint
            const id = rec.vid[i * 3 + j];
            if (rec.vstamp[id] !== stamp) {
              rec.vstamp[id] = stamp;
              rec.vval[id] = judge(wv[i * 9 + j * 3], wv[i * 9 + j * 3 + 1], wv[i * 9 + j * 3 + 2], tmp);
              rec.vcls[id] = fast ? lastCode : codeAt(wv[i * 9 + j * 3], wv[i * 9 + j * 3 + 1], wv[i * 9 + j * 3 + 2]);
            }
            let vj = rec.vval[id];
            let other = view === 'pen' ? vj !== value : rec.vcls[id] !== k0;
            if (!other) continue;
            // A corner can sit exactly on a seam (a cut plane meets a box
            // edge there), where its ray is a coin toss: the same corner a
            // hair inside this triangle has the last word.
            const x = cx + (wv[i * 9 + j * 3] - cx) * ki;
            const y = cy + (wv[i * 9 + j * 3 + 1] - cy) * ki;
            const z = cz + (wv[i * 9 + j * 3 + 2] - cz) * ki;
            vj = judge(x, y, z, tmp);
            if (view === 'pen') other = vj !== value;
            else other = (fast ? lastCode : codeAt(x, y, z)) !== k0;
            if (other) seam = view === 'pen' || vj < 0 || value < 0 ? vj !== value : Math.abs(vj - value) > 4;
          }
          if (seam) for (let j = 0; j < 9; j++) W[j] = wv[i * 9 + j];
        }
        const o = i * 9;
        if (!seam) {
          if (value >= 0) painted++;
          for (let v = 0; v < 3; v++) {
            arr[o + v * 3] = rgb[0];
            arr[o + v * 3 + 1] = rgb[1];
            arr[o + v * 3 + 2] = rgb[2];
          }
          continue;
        }
        leaves.length = 0;
        seamPieces(BASE, 0, ctx);
        const nLeaf = leaves.length / 2;
        if (nLeaf > HEAT_SEAM_PIECES || rec.n + rec.used + nLeaf - 1 > rec.cap) {
          // A seam too ragged to follow (a gun barrel's sliver facets along
          // the edge of reach), or no spare triangles left this paint: the
          // triangle stays whole, in the most penetrable colour any piece
          // of it shows — or, in the thickness views, its centroid's.
          if (value >= 0) painted++;
          if (view === 'pen') {
            let rank = -2;
            for (let l = 0; l < nLeaf; l++) {
              const T = leaves[l * 2];
              toWorld((T[0] + T[3] + T[6]) / 3, (T[1] + T[4] + T[7]) / 3, (T[2] + T[5] + T[8]) / 3, leafPt);
              rank = worse(leafPt[0], leafPt[1], leafPt[2], rank, rgb);
            }
          }
          for (let v = 0; v < 3; v++) {
            arr[o + v * 3] = rgb[0];
            arr[o + v * 3 + 1] = rgb[1];
            arr[o + v * 3 + 2] = rgb[2];
          }
          continue;
        }
        let bestRank = -2;
        for (let l = 0; l < nLeaf; l++) {
          const out = leafRgb[l] || (leafRgb[l] = [0, 0, 0]);
          const r = colourLeaf(leaves[l * 2], leaves[l * 2 + 1], out);
          if (r > bestRank) bestRank = r;
        }
        if (bestRank >= 0) painted++;
        rec.split.push(i);
        for (let l = 0; l < nLeaf; l++) {
          const slot = l === 0 ? i : rec.n + rec.used++;
          const T = leaves[l * 2];
          const so = slot * 9;
          for (let v = 0; v < 3; v++) {
            const u = T[v * 3];
            const vv = T[v * 3 + 1];
            const w = T[v * 3 + 2];
            for (let a = 0; a < 3; a++) {
              pos[so + v * 3 + a] = u * rec.base[o + a] + vv * rec.base[o + 3 + a] + w * rec.base[o + 6 + a];
              arr[so + v * 3 + a] = leafRgb[l][a];
            }
          }
          toWorld((T[0] + T[3] + T[6]) / 3, (T[1] + T[4] + T[7]) / 3, (T[2] + T[5] + T[8]) / 3, leafPt);
          rec.cen[slot * 3] = leafPt[0];
          rec.cen[slot * 3 + 1] = leafPt[1];
          rec.cen[slot * 3 + 2] = leafPt[2];
          nr[slot * 3] = nr[k];
          nr[slot * 3 + 1] = nr[k + 1];
          nr[slot * 3 + 2] = nr[k + 2];
        }
      }
      // only what is drawn goes up to the GPU (one range from the start,
      // widened to cover any upload still pending from a paint not drawn)
      const upTo = (rec.n + rec.used) * 9;
      for (const at of moved || rec.split.length ? [rec.attr, rec.pos] : [rec.attr]) {
        const pending = at.updateRanges.length ? at.updateRanges[0].count : 0;
        at.clearUpdateRanges();
        at.addUpdateRange(0, Math.max(pending, upTo));
        at.needsUpdate = true;
      }
      rec.mesh.geometry.setDrawRange(0, (rec.n + rec.used) * 3);
    }
    this.lastPainted = painted;
    return painted;
  }

  // -------------------------------------------------------------------------
  // hover
  // -------------------------------------------------------------------------

  doHover(x, y) {
    if (this.drag) return;
    if (x > this.W - this.panelW || y < this.barH) {
      this.setHover(null);
      return;
    }
    this.setHover(this.probe(x, y), x, y);
  }

  // What is under a screen point: a module (X-ray), or the plate a round fired
  // from the camera through that point would strike (both modes).
  probe(x, y) {
    const ray = this.rayAt(x, y);
    if (this.mode === 'xray') {
      this.world.updateMatrixWorld();
      // What is drawn under the cursor answers first. The module models are
      // opaque and sit inside their damage boxes, so a box that lies wholly
      // inside a bigger one (the Il-2's seat-back plate in the pilot's box) is
      // still reachable wherever it shows; the box picked is then the one the
      // eye was on, not whichever box the ray happened to enter first.
      const models = [];
      for (const r of this.modules) {
        if (!r.internal || !r.group || this.hidden.has(r.kind)) continue;
        for (const m of r.group.children) models.push(m);
      }
      const seen = this.raycaster.intersectObjects(models, false);
      if (seen.length && seen[0].object.userData.ixRec) return { type: 'module', rec: seen[0].object.userData.ixRec };
      // Between the models the damage boxes themselves answer — the airframe's
      // structure boxes have no model at all.
      const list = this.pickList.filter((p) => {
        const r = p.userData.ix;
        return r && !this.hidden.has(r.kind);
      });
      const hits = this.raycaster.intersectObjects(list, false);
      if (hits.length) {
        // inside a wing box sits a fuel cell; the cell is the answer
        const inner = hits.find((h) => h.object.userData.ix.internal);
        return { type: 'module', rec: (inner || hits[0]).object.userData.ix };
      }
      if (!this.isTank || !this.analyst) return null;
      const onModel = this.raycaster.intersectObjects(this.ghostMeshes, false);
      if (!onModel.length) return null;
    }
    if (!this.analyst) return null;
    const sh = this.currentShell();
    const hit = this.analyst.castRay(ray.origin, ray.direction, this.range, sh ? (sh.shell.kind || sh.key) : null);
    if (!hit) return null;
    const plate = this.analyst.plateOf(hit, {});
    const info = { type: 'plate', plate, hit };
    if (this.mode === 'armour' && this.view === 'pen' && sh && penetrationForecast) {
      const f = penetrationForecast(this.analyst.tank, hit, sh.shell, sh.key, this.range);
      info.forecast = { effArmor: f.effArmor, effPen: f.effPen, ricochetChance: f.ricochetChance };
      info.verdict = this.analyst.verdict(hit, sh.shell, sh.key);
      info.shell = sh;
    }
    return info;
  }

  setHover(info, x = 0, y = 0) {
    this.hoverInfo = info;
    const rec = info && info.type === 'module' ? info.rec : null;
    if (rec) {
      rec.proxy.updateWorldMatrix(true, false);
      rec.proxy.matrixWorld.decompose(_iv, _iq, _iw);
      for (const o of [this.hlBox, this.hlEdges]) {
        o.position.copy(_iv);
        o.quaternion.copy(_iq);
        o.scale.copy(_iw);
        o.visible = true;
      }
      const col = (IX_KINDS[rec.kind] && IX_KINDS[rec.kind].color) || 0xffffff;
      this.hlEdges.material.color.setHex(col);
      this.hlBox.material.color.setHex(col);
    } else {
      this.hlBox.visible = false;
      this.hlEdges.visible = false;
    }
    if (!this.el) return;
    const tip = this.el.tip;
    if (!info) {
      tip.style.display = 'none';
      return;
    }
    tip.innerHTML = info.type === 'module' ? this.moduleTip(info.rec) : this.plateTip(info);
    tip.style.display = 'block';
    // beside the cursor, kept inside the 3D area and clear of the panel
    const tw = tip.offsetWidth > 40 && tip.offsetWidth < 400 ? tip.offsetWidth : 250;
    const th = tip.offsetHeight > 20 && tip.offsetHeight < 400 ? tip.offsetHeight : 130;
    const maxX = this.W - this.panelW - tw - 8;
    let tx = x + 18;
    if (tx > maxX) tx = x - tw - 18;
    let ty = y + 16;
    if (ty + th > this.H - 8) ty = Math.max(this.barH + 6, y - th - 12);
    tip.style.transform = `translate(${Math.max(6, Math.round(tx))}px, ${Math.round(ty)}px)`;
  }

  moduleTip(rec) {
    const col = cssHex((IX_KINDS[rec.kind] && IX_KINDS[rec.kind].color) || 0xffffff);
    const kindLabel = (IX_KINDS[rec.kind] && IX_KINDS[rec.kind].label) || rec.kind;
    const rows = [];
    let note = '';
    let name = rec.label;
    let sub = kindLabel.toUpperCase();
    if (this.isTank) {
      if (rec.kind === 'crew') {
        name = IX_ROLE[rec.role] || rec.label;
        sub = `CREW · ${seatWhere(rec.mod).toUpperCase()}`;
        note = ROLE_DUTY[rec.role] || '';
      } else {
        name = moduleName(rec.key, rec.kind, rec.label);
        note = KIND_EFFECT[rec.kind] || '';
      }
      rows.push(['Soaks', `${RESIST[rec.kind] ?? '—'} mm of penetration`]);
      const rep = MODULE_REPAIR[rec.kind];
      if (rep) rows.push(['Field repair', `${Math.round(rep * (this.spec.repairFactor || 1))} s, full crew`]);
      const np = nearestPlate(this.spec, rec.mod);
      if (np && rec.kind !== 'barrel') {
        rows.push(['Behind', np.open ? `${np.label} · no roof plate`
          : `${np.label} · ${Math.round(np.thickness)} mm${np.slope ? ` at ${Math.round(np.slope)}°` : ''}`]);
      }
      rows.push(['Size', `${(rec.half.x * 2).toFixed(2)} × ${(rec.half.y * 2).toFixed(2)} × ${(rec.half.z * 2).toFixed(2)} m`]);
      if (rec.kind === 'crew') note += ' Fewer than two men left standing and the vehicle is lost.';
    } else {
      const part = rec.part;
      sub = rec.kind === 'structure' ? 'AIRFRAME STRUCTURE' : kindLabel.toUpperCase();
      if (rec.hp) rows.push(['Structure', `${rec.hp} HP`]);
      if (part === 'plate') {
        note = this.spec.pilotArmour
          ? 'Cockpit Armour: the damage model doubles the pilot\'s HP rather than testing a separate plate.'
          : 'The armoured shell is modelled as the pilot\'s and engine\'s high HP, not as a separate plate.';
      } else {
        note = (PLANE_EFFECT[part] || '').replace('{fire}', String(Math.round((this.spec.fireRisk || 0) * 100)));
        if (part === 'pilot' && this.spec.pilotArmour) note += ' Armoured seat: HP doubled.';
      }
    }
    return `<div class="ixTipHead"><i style="background:${col}"></i><b>${escHtml(name)}</b></div>
      <small>${escHtml(sub)}</small>
      <dl>${rows.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`).join('')}</dl>
      ${note ? `<p>${escHtml(note)}</p>` : ''}`;
  }

  plateTip(info) {
    const p = info.plate;
    // the open top of an open-topped turret: no plate, so no angle to read
    const rows = p.open ? [['Armour', 'none · the turret has no roof']] : [
      ['Nominal', `${Math.round(p.thickness)} mm${p.slope ? `, laid at ${Math.round(p.slope)}°` : ''}`],
      ['Impact angle', `${Math.round((p.impact * 180) / Math.PI)}°`],
      ['Along the line', `${Math.round(p.los)} mm`],
    ];
    let verdict = '';
    if (info.forecast && info.shell) {
      const f = info.forecast;
      rows.push(['Effective', `${Math.round(f.effArmor)} mm (normalised)`]);
      rows.push([info.shell.shell.kind || info.shell.key, `${Math.round(f.effPen)} mm at ${this.range} m`]);
      if (f.ricochetChance > 0) rows.push(['Ricochet', pct(f.ricochetChance)]);
      const L = PEN_LEGEND.find((x) => x.key === info.verdict);
      if (L) verdict = `<div class="ixTipVerdict" style="--c:${cssHex(L.color)}">${escHtml(L.label.toUpperCase())}</div>`;
    }
    return `<div class="ixTipHead"><i style="background:${cssHex(0x8d9db0)}"></i><b>${escHtml(p.label)}</b></div>
      <small>${p.open ? 'OPEN-TOPPED TURRET' : 'ARMOUR PLATE'}${this.mode === 'armour' ? ' · CLICK TO FIRE A TEST SHOT' : ''}</small>
      <dl>${rows.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`).join('')}</dl>${verdict}`;
  }

  // -------------------------------------------------------------------------
  // test shot
  // -------------------------------------------------------------------------

  clickAt(x, y) {
    if (this.mode !== 'armour' || !this.analyst) return null;
    if (x > this.W - this.panelW || y < this.barH) return null;
    const ray = this.rayAt(x, y);
    return this.fireShot(ray.origin.clone(), ray.direction.clone());
  }

  // Fire along a world-space ray: the deterministic analysis, a few hundred
  // real applyHit calls for the odds, and the picture of it all.
  fireShot(origin, dir) {
    const sh = this.currentShell();
    if (!this.analyst || !sh) return null;
    const a = this.analyst.analyse(origin, dir, sh.shell, sh.key, this.range);
    this.clearShot(true);
    if (a.miss) {
      this.renderPanel();
      return a;
    }
    const stats = this.analyst.simulate(a.hit, sh.shell, sh.key, this.simCount);
    // a shot owns its own ledger: replacing it gives back exactly what it made
    // and never the inspector's shared unit box or materials
    this.shot = { a, stats, shell: sh, ray: { origin: origin.clone(), dir: dir.clone() }, t: 0, res: new Ledger() };
    this.shot.group = this.buildShotVisual(a, this.shot.res);
    this.applyShotLook(true);
    this.syncModuleVisibility();
    this.layoutDirty = true;
    this.renderPanel();
    return this.shot;
  }

  refire() {
    if (!this.shot) return;
    const { origin, dir } = this.shot.ray;
    this.fireShot(origin, dir);
  }

  clearShot(quiet = false) {
    if (this.shot) {
      if (this.shot.group) this.world.remove(this.shot.group);
      if (this.shot.res) this.shot.res.dispose();
      this.shot = null;
    }
    this.applyShotLook(false);
    this.syncModuleVisibility();
    this.layoutDirty = true;
    if (!quiet) this.renderPanel();
  }

  applyShotLook(on) {
    if (!this.heatMat) return;
    this.heatMat.uniforms.uAlpha.value = on ? 0.2 : 1;
    this.heatMat.depthWrite = !on;
    if (this.heatEdgeMat) this.heatEdgeMat.opacity = on ? 0.18 : 0.45;
  }

  buildShotVisual(a, R) {
    const g = new THREE.Group();
    const basic = (hex, opacity = 1, extra = {}) => R.m(new THREE.MeshBasicMaterial({
      color: hex, transparent: true, opacity, depthWrite: false, toneMapped: false, ...extra,
    }));
    // beams grow from their start point, so the animation can scale them
    const beam = (from, to, r, mat) => {
      const len = from.distanceTo(to);
      if (len < 1e-4) return null;
      const geo = R.g(new THREE.CylinderGeometry(r, r, len, 10, 1, true));
      geo.translate(0, len / 2, 0);
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(from);
      m.quaternion.setFromUnitVectors(UP, _iv.copy(to).sub(from).normalize());
      m.renderOrder = 10;
      g.add(m);
      return m;
    };
    const entry = a.entry;
    const dir = a.hit.dir;
    const start = entry.clone().addScaledVector(dir, -Math.min(10, this.orbit.dist * 0.6));
    const approach = beam(start, entry, 0.02, basic(0xffd36a, 0.95));
    const headGeo = R.g(new THREE.SphereGeometry(0.07, 12, 8));
    const head = new THREE.Mesh(headGeo, basic(0xfff0b8, 1));
    head.position.copy(start);
    head.renderOrder = 11;
    g.add(head);

    const vCol = (PEN_LEGEND.find((p) => p.key === a.verdict) || PEN_LEGEND[2]).color;
    const n = a.plate.normal.clone().normalize();
    const ring = new THREE.Mesh(R.g(new THREE.RingGeometry(0.11, 0.19, 32)), basic(vCol, 0.95, { side: THREE.DoubleSide }));
    ring.quaternion.setFromUnitVectors(FWD, n);
    ring.position.copy(entry).addScaledVector(n, 0.015);
    ring.renderOrder = 11;
    ring.visible = false;
    // the struck-plate ring marks a plate; in through an open turret top there
    // is none, and a ring lying across the opening drew a roof (the tracer
    // still shows where the round came in)
    if (!a.plate.open) g.add(ring);

    let inner = null;
    let deflect = null;
    let burst = null;
    let cone = null;
    let fan = null;
    if (a.verdict === 'ricochet' || (!a.mode && a.forecast.ricochetChance > 0.5)) {
      const r = dir.clone().addScaledVector(n, -2 * dir.dot(n)).normalize();
      deflect = beam(entry, entry.clone().addScaledVector(r, 3.5), 0.016, basic(0x9fb8d8, 0.85));
    }
    let blast = null;
    if (a.mode) {
      inner = beam(entry, entry.clone().addScaledVector(dir, Math.max(0.05, a.stopT)), 0.03, basic(0xff7a2e, 0.95));
      if (a.armed && a.burstInside) {
        burst = new THREE.Mesh(R.g(new THREE.SphereGeometry(0.24, 16, 12)), basic(0xffb648, 0.55));
        burst.position.copy(entry).addScaledVector(dir, a.fuseDist);
        burst.renderOrder = 11;
        g.add(burst);
      } else if (a.armed) {
        // the fuse ran out after the round had left: a cold mark where it went
        const fizzle = new THREE.Mesh(R.g(new THREE.SphereGeometry(0.07, 10, 8)), basic(0x8a96a6, 0.9));
        fizzle.position.copy(entry).addScaledVector(dir, a.fuseDist);
        fizzle.renderOrder = 11;
        g.add(fizzle);
      }
      // the bursting charge's reach: every man whose box it touches is hurt
      if (a.filler && a.filler.hits.length) {
        blast = new THREE.Mesh(R.g(new THREE.SphereGeometry(a.filler.reach, 28, 18)),
          basic(0xffc46a, 0, { side: THREE.DoubleSide }));
        blast.position.copy(a.filler.origin);
        blast.renderOrder = 9;
        blast.visible = false;
        g.add(blast);
      }
      if (a.spall) {
        const s = a.spall;
        const h = s.range;
        const geo = R.g(new THREE.ConeGeometry(Math.tan(s.spread) * h, h, 32, 1, true));
        geo.translate(0, -h / 2, 0);
        cone = new THREE.Mesh(geo, basic(0xff9a3a, 0.1, { side: THREE.DoubleSide }));
        cone.position.copy(s.origin);
        cone.quaternion.setFromUnitVectors(_iw.set(0, -1, 0), s.dir);
        cone.renderOrder = 9;
        g.add(cone);
        const pts = [];
        for (const d of s.samples) {
          if (pts.length > 64 * 6) break;
          pts.push(s.origin.x, s.origin.y, s.origin.z,
            s.origin.x + d.x * h, s.origin.y + d.y * h, s.origin.z + d.z * h);
        }
        const fg = R.g(new THREE.BufferGeometry());
        fg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        fan = new THREE.LineSegments(fg, R.m(new THREE.LineBasicMaterial({
          color: 0xffb35a, transparent: true, opacity: 0.0, depthWrite: false, toneMapped: false,
        })));
        fan.renderOrder = 10;
        g.add(fan);
      }
    }

    // the modules the round reaches, solid; those its spall can reach, by odds
    const hl = [];
    const mark = (key, hex, opacity) => {
      const rec = this.modules.find((r) => r.key === key);
      if (!rec) return;
      rec.proxy.updateWorldMatrix(true, false);
      rec.proxy.matrixWorld.decompose(_iv, _iq, _iw);
      const box = new THREE.Mesh(this.unitBox, basic(hex, opacity * 0.35));
      const edge = new THREE.LineSegments(this.unitEdges, R.m(new THREE.LineBasicMaterial({
        color: hex, transparent: true, opacity: Math.min(1, opacity + 0.25), depthTest: false, toneMapped: false,
      })));
      for (const o of [box, edge]) {
        o.position.copy(_iv);
        o.quaternion.copy(_iq);
        o.scale.copy(_iw).multiplyScalar(1.03);
        o.visible = false;
        o.renderOrder = 12;
        g.add(o);
        hl.push(o);
      }
    };
    // red is certain — the shell body's path and the men inside the burst's
    // reach — amber is the spall, as bright as its odds
    const marked = new Set();
    for (const h of a.path) {
      marked.add(h.key);
      mark(h.key, 0xff4a3a, 0.95);
    }
    if (a.filler) {
      for (const f of a.filler.hits) {
        if (marked.has(f.key)) continue;
        marked.add(f.key);
        mark(f.key, 0xff4a3a, 0.95);
      }
    }
    if (a.spall) {
      for (const s of a.spall.hits) {
        if (marked.has(s.key) || s.prob < 0.05) continue;
        mark(s.key, 0xffb03a, 0.35 + 0.6 * s.prob);
      }
    }
    g.userData.anim = { approach, head, start, entry, ring, inner, deflect, burst, blast, cone, fan, hl };
    if (approach) approach.scale.y = 0.001;
    if (inner) inner.scale.y = 0.001;
    if (deflect) deflect.scale.y = 0.001;
    if (burst) burst.visible = false;
    if (cone) cone.visible = false;
    this.world.add(g);
    return g;
  }

  // The shot plays out in a little under a second: tracer in, plate struck,
  // path through the vehicle, then the spall opening and the damage lighting up.
  tickShot(dt) {
    if (!this.shot || !this.shot.group) return;
    const s = this.shot;
    if (s.t > 1.6) return;
    s.t += dt;
    const A = s.group.userData.anim;
    const t = s.t;
    const tIn = Math.min(1, t / 0.32);
    if (A.approach) A.approach.scale.y = Math.max(0.001, tIn);
    A.head.position.lerpVectors(A.start, A.entry, tIn);
    A.head.visible = tIn < 1;
    A.ring.visible = tIn >= 1;
    const tPath = clampN((t - 0.32) / 0.3, 0, 1);
    if (A.inner) A.inner.scale.y = Math.max(0.001, tPath);
    if (A.deflect) A.deflect.scale.y = Math.max(0.001, tPath);
    if (A.burst) {
      const b = clampN((t - 0.62) / 0.25, 0, 1);
      A.burst.visible = b > 0 && b < 1;
      A.burst.scale.setScalar(0.3 + b * 1.4);
      A.burst.material.opacity = 0.6 * (1 - b);
    }
    const tSp = clampN((t - 0.62) / 0.35, 0, 1);
    if (A.cone) {
      A.cone.visible = tSp > 0;
      A.cone.material.opacity = 0.1 * tSp;
    }
    if (A.fan) A.fan.material.opacity = 0.32 * tSp;
    if (A.blast) {
      // the overpressure swells out to its reach and stays there as a faint shell
      A.blast.visible = tSp > 0;
      A.blast.scale.setScalar(Math.max(0.05, tSp));
      A.blast.material.opacity = 0.075 + 0.1 * (1 - tSp);
    }
    const show = t > 0.62;
    for (const o of A.hl) o.visible = show;
  }

  // -------------------------------------------------------------------------
  // callouts
  // -------------------------------------------------------------------------

  calloutItems() {
    if (!this.labelsOn) return [];
    const items = [];
    if (this.mode === 'armour') {
      if (!this.shot || !this.shot.a || this.shot.a.miss) return items;
      const a = this.shot.a;
      // one callout per module: the shell body's path first, then the men the
      // bursting charge reaches, then the spall odds
      const named = new Set();
      a.path.forEach((h, i) => {
        const rec = this.modules.find((r) => r.key === h.key);
        named.add(h.key);
        if (rec) items.push({ id: `p:${h.key}`, text: `${i + 1} · ${moduleName(h.key, h.kind, h.label)}`, color: 0xff6a4a, anchors: [rec.group], priority: 10 - i * 0.1 });
      });
      if (a.filler) {
        for (const f of a.filler.hits) {
          if (named.has(f.key)) continue;
          named.add(f.key);
          const rec = this.modules.find((r) => r.key === f.key);
          if (rec) items.push({ id: `b:${f.key}`, text: `Burst · ${moduleName(f.key, f.kind, f.label)}`, color: 0xff6a4a, anchors: [rec.group], priority: 8 + f.odds });
        }
      }
      if (a.spall) {
        for (const s of a.spall.hits) {
          if (named.has(s.key) || s.prob < 0.05) continue;
          const rec = this.modules.find((r) => r.key === s.key);
          if (rec) items.push({ id: `s:${s.key}`, text: `${pct(s.prob)} · ${moduleName(s.key, s.kind, s.label)}`, color: 0xffb03a, anchors: [rec.group], priority: 5 + s.prob });
        }
      }
      return items;
    }
    if (this.isTank) {
      for (const role of IX_ROLE_ORDER) {
        if (this.hidden.has('crew')) break;
        const rec = this.modules.find((r) => r.key === `crew_${role}`);
        if (rec) items.push({ id: rec.key, text: IX_ROLE[role], color: IX_KINDS.crew.color, anchors: [rec.group], priority: KIND_PRIORITY.crew });
      }
      for (const kind of TANK_KIND_ORDER) {
        if (kind === 'crew' || this.hidden.has(kind)) continue;
        const list = this.modules.filter((r) => r.kind === kind);
        if (!list.length) continue;
        const base = IX_KINDS[kind].label;
        items.push({
          id: `k:${kind}`, text: list.length > 1 && kind !== 'fuel' ? `${base} ×${list.length}` : base,
          color: IX_KINDS[kind].color, anchors: list.map((r) => r.group), priority: KIND_PRIORITY[kind] || 1,
        });
      }
    } else {
      for (const kind of PLANE_KIND_ORDER) {
        if (kind === 'structure' || this.hidden.has(kind)) continue;
        const list = this.modules.filter((r) => r.kind === kind);
        if (!list.length) continue;
        // callouts name the fitting this aircraft actually has, in as few
        // letters as will do it — every one of them costs model width on a
        // narrow stage (roomForLabels); the legend keeps the general name
        let base = IX_KINDS[kind].label;
        if (kind === 'plate') base = 'Seat armour';
        else if (kind === 'oilCooler') {
          const radial = this.spec.look && this.spec.look.engine === 'radial';
          base = radial ? 'Oil cooler' : list.length > 1 ? 'Radiators' : 'Radiator';
        }
        items.push({
          id: `k:${kind}`, text: base, color: IX_KINDS[kind].color,
          anchors: list.map((r) => r.group), priority: KIND_PRIORITY[kind] || 1,
        });
      }
    }
    return items;
  }

  syncCalloutDom(items) {
    const key = items.map((i) => `${i.id}|${i.text}`).join(';');
    if (key === this.calloutKey) return;
    this.calloutKey = key;
    if (!this.el) {
      this.callouts = items.map((it) => ({ it, label: null, path: null }));
      return;
    }
    const { labels, svg } = this.el;
    labels.innerHTML = '';
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (svg.children && svg.children.length) svg.children.length = 0;
    this.callouts = items.map((it) => {
      const label = document.createElement('div');
      label.className = 'ixCall';
      label.innerHTML = `<i style="background:${cssHex(it.color)}"></i><span>${escHtml(it.text)}</span>`;
      labels.appendChild(label);
      const path = document.createElementNS ? document.createElementNS(SVGNS, 'path') : document.createElement('div');
      path.setAttribute('stroke', cssHex(it.color));
      svg.appendChild(path);
      return { it, label, path };
    });
  }

  // The font the callouts are really set in (the page's, inherited), read
  // once the root is in the document; the stylesheet's own stack until then.
  calloutFamily() {
    if (this._callFamily) return this._callFamily;
    let fam = '';
    try {
      if (this.el && typeof getComputedStyle === 'function' && this.el.root.isConnected !== false) {
        fam = String(getComputedStyle(this.el.root).fontFamily || '');
      }
    } catch {
      fam = '';
    }
    if (!fam) return CALL_FONT_FALLBACK;
    this._callFamily = fam;
    return fam;
  }

  // A callout's width as the page will really set it. The canvas figure
  // (calloutWidth) is exact only while the browser draws 10px text at 10px: a
  // browser with a minimum font size (12px is a common setting, and the
  // default in some locales) draws the DOM text larger than any canvas
  // measures it, and every label came out cut short ("LOA…", "GUN BRE…"). So
  // each string is also laid out once in a hidden .ixCall probe and the wider
  // of the two is used. One forced layout per new string, cached for the
  // inspector's life; a probe reading that cannot be a real layout (detached,
  // hidden, a test stub reporting the whole stage) is ignored.
  callW(text) {
    const est = calloutWidth(text, this.calloutFamily());
    const dom = this.domCallW(text, est);
    return dom > est ? dom : est;
  }

  domCallW(text, est) {
    const key = String(text);
    const cache = this._callDom || (this._callDom = new Map());
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    // a page that cannot be measured right now (hidden, detached) is asked
    // again a second later, not on every frame; one whose probe reads as wide
    // as the whole stage is not laying anything out and is not asked again
    if (this._callDomOff || this.frame < (this._callDomRetry || 0)) return 0;
    const root = this.el && this.el.root;
    if (!root || typeof document === 'undefined' || !document.createElement || root.isConnected === false) return 0;
    let w = 0;
    let ow = 0;
    let rw = 0;
    try {
      let probe = this._callProbe;
      if (!probe || probe.parentNode !== root) {
        probe = document.createElement('div');
        probe.className = 'ixCall ixProbe';
        probe.setAttribute('aria-hidden', 'true');
        probe.innerHTML = '<i></i><span></span>';
        root.appendChild(probe);
        this._callProbe = probe;
      }
      probe.lastChild.textContent = key;
      // offsetWidth is whole layout px, unaffected by any scale on the page;
      // +1 covers the fraction it rounds away
      ow = Number(probe.offsetWidth) || 0;
      rw = Number(root.offsetWidth) || 0;
      if (ow > CALL_CHROME && ow < rw - 1 && ow < est * 2) w = ow + 1;
    } catch {
      w = 0;
    }
    if (w > 0) {
      if (cache.size > 400) cache.clear();
      cache.set(key, w);
    } else if (rw > 0 && ow >= rw - 1) {
      this._callDomOff = true;
    } else {
      this._callDomRetry = this.frame + 60;
    }
    return w;
  }

  layoutLabels() {
    const items = this.calloutItems();
    this.syncCalloutDom(items);
    const W = this.W;
    const H = this.H;
    if (!W || !H) return [];
    const proj = [];
    for (const c of this.callouts) {
      const pts = [];
      for (const a of c.it.anchors) {
        if (!a) continue;
        a.getWorldPosition(_iv);
        _iv.project(this.camera);
        if (_iv.z > 1 || _iv.z < -1) continue;
        pts.push([((_iv.x + 1) / 2) * W, ((1 - _iv.y) / 2) * H]);
      }
      c.pts = pts;
      if (!pts.length) continue;
      let ax = 0;
      let ay = 0;
      for (const p of pts) { ax += p[0]; ay += p[1]; }
      proj.push({ id: c.it.id, x: ax / pts.length, y: ay / pts.length, w: this.callW(c.it.text), priority: c.it.priority });
    }
    const area = {
      left: 0, right: W - this.panelW, top: this.barH + 8, bottom: H - this.legendH - 6, h: 20, gap: 5, margin: CALL_MARGIN,
    };
    const placed = layoutCallouts(proj, area);
    const byId = new Map(placed.map((p) => [p.id, p]));
    this.lastLayout = placed;
    if (this.el) this.el.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    for (const c of this.callouts) {
      const p = byId.get(c.it.id);
      if (!c.label) continue;
      if (!p || !p.visible) {
        c.label.style.display = 'none';
        c.path.setAttribute('d', '');
        continue;
      }
      c.label.style.display = 'flex';
      c.label.style.width = `${p.w}px`;
      c.label.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      c.label.classList.toggle('right', p.side === 'R');
      const sx = p.side === 'L' ? p.x + p.w : p.x;
      const sy = p.y + p.h / 2;
      const kx = p.side === 'L' ? sx + 10 : sx - 10;
      let d = '';
      for (const [px, py] of c.pts) d += `M${sx.toFixed(1)} ${sy.toFixed(1)}L${kx.toFixed(1)} ${sy.toFixed(1)}L${px.toFixed(1)} ${py.toFixed(1)}`;
      c.path.setAttribute('d', d);
    }
    return placed;
  }

  // -------------------------------------------------------------------------
  // panel, bar, legend
  // -------------------------------------------------------------------------

  renderBar() {
    if (!this.el) return;
    const t = this.title || {};
    this.el.bar.innerHTML = `
      <button class="ixBack" data-ix="exit" title="Back to the hangar (Esc)"><span>&#8249;</span> HANGAR</button>
      <div class="ixName"><b>${escHtml(t.name || this.spec.name || '')}</b><small>${escHtml(t.sub || '')}</small></div>
      <div class="ixModes">
        <button class="${this.mode === 'xray' ? 'active' : ''}" data-ix="mode:xray">X-RAY</button>
        <button class="${this.mode === 'armour' ? 'active' : ''}" data-ix="mode:armour" ${this.isTank && this.analyst ? '' : 'disabled title="Aircraft carry no armour plate in the damage model"'}>PROTECTION ANALYSIS</button>
      </div>
      <span class="ixHelp">DRAG · ORBIT &nbsp; WHEEL · ZOOM<span class="ixHelpOpt"> &nbsp; DOUBLE-CLICK · RESET</span>${this.mode === 'armour' ? ' &nbsp; CLICK · TEST SHOT' : ''}</span>
      <button class="ixTool${this.labelsOn ? ' on' : ''}" data-ix="labels" title="Show or hide the callouts">LABELS</button>
      <button class="ixTool" data-ix="reset" title="Back to the starting view (double-click)">RESET VIEW</button>
      <button class="ixClose" data-ix="exit" title="Close (Esc)">&#10005;</button>`;
    this.fitBar();
  }

  // The vehicle's name and subtitle come before the control help: when the
  // bar cannot show all three uncut (a 1366 px window in PROTECTION mode with
  // a long subtitle, or any browser minimum font size), the help line goes.
  fitBar() {
    const bar = this.el && this.el.bar;
    if (!bar || !bar.classList || typeof bar.querySelectorAll !== 'function') return;
    bar.classList.remove('tight');
    try {
      for (const e of Array.from(bar.querySelectorAll('.ixName b, .ixName small, .ixHelp'))) {
        const sw = Number(e.scrollWidth);
        const cw = Number(e.clientWidth);
        if (sw > 0 && cw >= 0 && sw > cw + 0.5) {
          bar.classList.add('tight');
          break;
        }
      }
    } catch {
      bar.classList.remove('tight');
    }
  }

  renderLegend() {
    if (!this.el) return;
    let html = '';
    if (this.mode === 'xray') {
      const order = this.isTank ? TANK_KIND_ORDER : PLANE_KIND_ORDER;
      const present = order.filter((k) => this.modules.some((r) => r.kind === k));
      html = present.map((k) => {
        const off = this.hidden.has(k);
        const lbl = k === 'plate' ? 'Armour' : k === 'structure' ? 'Structure (hover)' : IX_KINDS[k].label;
        return `<button class="ixChip${off ? ' off' : ''}" data-ix="kind:${k}" title="${off ? 'Show' : 'Hide'} ${escHtml(lbl)}">
          <i style="background:${cssHex(IX_KINDS[k].color)}"></i>${escHtml(lbl.toUpperCase())}</button>`;
      }).join('');
    } else if (this.view === 'pen') {
      html = `<span class="ixChip static"><b>${PEN_LEGEND_TITLE}</b></span>`
        + PEN_LEGEND.map((p) => `<span class="ixChip static"><i style="background:${cssHex(p.color)}"></i>${p.glyph} ${p.label.toUpperCase()}</span>`).join('')
        + `<span class="ixChip static"><i style="background:${cssHex(NOT_ARMOUR)}"></i>NOT ARMOUR</span>`;
    } else {
      const S = THICKNESS_STOPS;
      html = `<div class="ixScale">
        <span>${this.view === 'nominal' ? 'NOMINAL THICKNESS' : 'THICKNESS ALONG THE LINE OF SIGHT'} · MM</span>
        <div class="ixRamp" style="background:${thicknessGradientCss()}"></div>
        <div class="ixTicks">${S.map((v, i) => `<i style="left:${((i / (S.length - 1)) * 100).toFixed(1)}%">${i === S.length - 1 ? `${v}+` : v}</i>`).join('')}</div>
      </div><span class="ixChip static"><i style="background:${cssHex(NOT_ARMOUR)}"></i>NOT ARMOUR</span>`;
    }
    this.el.legend.innerHTML = html;
    if (this.W) {
      const lh = this.el.legend.offsetHeight;
      this.legendH = lh > 0 && lh < 200 ? lh + 12 : 44;
    }
    this.layoutDirty = true;
  }

  penLine() {
    const sh = this.currentShell();
    if (!sh) return '';
    const kind = sh.shell.kind || sh.key;
    const range = kind === 'HE' || kind === 'HEAT' ? 0 : this.range;
    let s = `<b>${Math.round(shellPenAt(sh.shell, range))} mm</b> at ${this.range} m · ${escHtml(kind)} ${sh.shell.caliber || ''} mm`;
    if (kind === 'HE') s += ` · overpressure ${Math.round(heBlastPen(sh.shell))} mm on contact`;
    if (kind === 'HE' || kind === 'HEAT') s += ' · does not fall off with range';
    return s;
  }

  renderPanel() {
    if (!this.el) return;
    const spec = this.spec;
    let html = '';
    if (this.mode === 'xray') {
      html += `<section class="ixCard"><h4>X-RAY</h4>
        <p class="ixHint">${this.isTank
    ? 'Every component sits where the damage model puts it. Hover one for what it soaks and what losing it costs; hover the hull for the plate in front of you.'
    : 'Every component sits where the damage model puts it. Hover one for its structure and what losing it costs.'}</p></section>`;
      if (this.isTank) {
        const crew = IX_ROLE_ORDER.map((r) => this.modules.find((m) => m.key === `crew_${r}`)).filter(Boolean);
        html += `<section class="ixCard"><h4>CREW <b>${crew.length}</b></h4>${crew.map((m) => `
          <div class="ixRow"><i style="background:${cssHex(IX_KINDS.crew.color)}"></i><span>${escHtml(IX_ROLE[m.role])}</span><em>${escHtml(seatWhere(m.mod))}</em></div>`).join('')}
          ${crew.length < 5 ? '<p class="ixHint">No radio operator: the commander works the set.</p>' : ''}</section>`;
        const comp = TANK_KIND_ORDER.filter((k) => k !== 'crew').map((k) => {
          const n = this.modules.filter((m) => m.kind === k).length;
          if (!n) return '';
          return `<div class="ixRow${this.hidden.has(k) ? ' off' : ''}" data-ix="kind:${k}"><i style="background:${cssHex(IX_KINDS[k].color)}"></i><span>${escHtml(IX_KINDS[k].label)}${n > 1 ? ` ×${n}` : ''}</span><em>soaks ${RESIST[k] ?? '—'} mm</em></div>`;
        }).join('');
        html += `<section class="ixCard"><h4>COMPONENTS</h4>${comp}</section>`;
        html += `<section class="ixCard"><h4>ARMOUR <b>NOMINAL · SQUARE ON</b></h4>${armourTable(spec).map((r) => `
          <div class="ixRow ixArm"><span>${escHtml(r.label)}</span><em>${r.open ? 'open · no roof' : `${Math.round(r.mm)} mm${r.slope ? ` · ${Math.round(r.slope)}°` : ''}`}</em><b>${r.open ? '0' : Math.round(r.los)}</b></div>`).join('')}
          <p class="ixHint">The right-hand figure is what the plate is worth to a level shot from straight ahead of it. PROTECTION ANALYSIS shows every other angle.${turretOpenTop(spec) ? ' The turret is open-topped: anything that comes in over the rim meets no armour at all.' : ''}</p></section>`;
      } else {
        const hp = spec.parts || {};
        const order = ['pilot', 'engine', 'fuelTank', 'oilCooler', 'controls', 'leftWing', 'rightWing', 'aileronL', 'aileronR', 'tail', 'elevator', 'rudder'];
        html += `<section class="ixCard"><h4>STRUCTURE <b>${spec.hp || ''} HP AIRFRAME</b></h4>${order.filter((k) => hp[k]).map((k) => {
          const kind = PLANE_INTERNAL.has(k) ? k : 'structure';
          return `<div class="ixRow"><i style="background:${cssHex(IX_KINDS[kind].color)}"></i><span>${escHtml(PART_LABELS[k] || k)}</span><b>${hp[k]} HP</b></div>`;
        }).join('')}
          <p class="ixHint">Fire risk ${Math.round((spec.fireRisk || 0) * 100)}% when a tank is holed.${spec.pilotArmour ? ' Cockpit Armour fitted: pilot HP doubled.' : ''} Aircraft carry no armour plate or ammunition boxes in the damage model — their protection is the structure each component can absorb.</p></section>`;
      }
    } else {
      // each button carries a short form too, for a browser whose minimum
      // font size will not let the full labels share a narrow card (fitSeg)
      html += `<section class="ixCard"><h4>VIEW</h4><div class="ixSeg">
        <button class="${this.view === 'pen' ? 'active' : ''}" data-ix="view:pen" title="Penetration map for the selected shell"><span class="ixL">PENETRATION</span><span class="ixS">PEN.</span></button>
        <button class="${this.view === 'los' ? 'active' : ''}" data-ix="view:los" title="Thickness along the line of sight"><span class="ixL">THICKNESS</span><span class="ixS">THICK.</span></button>
        <button class="${this.view === 'nominal' ? 'active' : ''}" data-ix="view:nominal" title="Nominal plate thickness"><span class="ixL">NOMINAL</span><span class="ixS">NOM.</span></button></div>
        <p class="ixHint">${this.view === 'pen'
    ? 'Every plate coloured by what the selected shell does to it from where you are looking — slope, normalisation, overmatch and the ricochet curve included.'
    : this.view === 'los'
      ? 'Effective thickness along your line of sight: the plate divided by the cosine of the angle you see it at.'
      : 'Plate thickness as rolled, whatever the angle.'}</p></section>`;
      const opts = this.shellGroups.map((g) => `<optgroup label="${escHtml(g.label)}">${g.items.map((it) => `<option value="${escHtml(it.id)}"${it.id === this.shellId ? ' selected' : ''}>${escHtml(it.label)}</option>`).join('')}</optgroup>`).join('');
      html += `<section class="ixCard"><h4>SHELL</h4>
        <select class="ixSelect" data-ixsel="shell">${opts}</select>
        <div class="ixRange"><label>RANGE</label><input type="range" min="10" max="2000" step="10" value="${this.range}" data-ixrange="range"><b data-ixout="range">${this.range} m</b></div>
        <div class="ixStat" data-ixout="pen">${this.penLine()}</div></section>`;
      html += this.shotHtml();
    }
    this.el.panel.innerHTML = html;
    this.fitSeg();
  }

  // The VIEW buttons' full labels fit every panel width in style.css as long
  // as the browser sets 9.5px text at 9.5px. One that enforces a minimum font
  // size draws them wider than the card, so then — and only then — the row
  // switches to its short labels (one forced layout per panel render/resize).
  fitSeg() {
    const panel = this.el && this.el.panel;
    const seg = panel && typeof panel.querySelector === 'function' ? panel.querySelector('.ixSeg') : null;
    if (!seg || !seg.classList) return;
    seg.classList.remove('tight');
    try {
      for (const b of Array.from(seg.children || [])) {
        const sw = Number(b.scrollWidth);
        const cw = Number(b.clientWidth);
        if (sw > 0 && cw > 0 && sw > cw + 0.5) {
          seg.classList.add('tight');
          break;
        }
      }
    } catch {
      seg.classList.remove('tight');
    }
  }

  shotHtml() {
    const s = this.shot;
    if (!s) {
      return `<section class="ixCard ixShot"><h4>TEST SHOT</h4>
        <p class="ixHint">Click anywhere on the vehicle to fire the selected shell along your line of sight. The result is worked out by the same code a battle runs, then repeated ${this.simCount} times on a fresh vehicle for the odds.</p></section>`;
    }
    const a = s.a;
    const st = s.stats;
    const L = PEN_LEGEND.find((p) => p.key === a.verdict) || PEN_LEGEND[2];
    const head = a.mode === 'overpressure' ? 'OVERPRESSURE' : L.label.toUpperCase();
    const kv = a.plate.open ? [
      ['Plate', `${a.plate.label} · none`],
      ['Effective', '0 mm · no roof to beat'],
      ['Penetration', `${Math.round(a.forecast.effPen)} mm at ${a.dist} m`],
    ] : [
      ['Plate', a.plate.label],
      ['Nominal', `${Math.round(a.plate.thickness)} mm${a.plate.slope ? `, laid at ${Math.round(a.plate.slope)}°` : ''}`],
      ['Impact angle', `${Math.round((a.plate.impact * 180) / Math.PI)}°`],
      ['Effective', `${Math.round(a.forecast.effArmor)} mm${a.overmatch ? ' (overmatched)' : ''}`],
      ['Penetration', `${Math.round(a.forecast.effPen)} mm at ${a.dist} m ±${Math.round(PEN_SCATTER * 100)}%`],
    ];
    if (a.forecast.ricochetChance > 0) kv.push(['Ricochet chance', pct(a.forecast.ricochetChance)]);
    if (a.kind === 'HE') kv.push(['Overpressure', `${Math.round(a.blastPen)} mm on contact`]);
    let path = '';
    if (a.mode) {
      const items = a.path.map((h, i) => `<li><span>${i + 1}</span>${escHtml(moduleName(h.key, h.kind, h.label))}<em>arrives with ${Math.round(h.energy)} mm</em></li>`).join('');
      let fuseNote = '';
      if (a.armed && a.burstInside) {
        fuseNote = `Delay fuse: the filler bursts ${a.fuseDist.toFixed(2)} m behind the plate and the spall is thrown from there.`;
      } else if (a.armed) {
        fuseNote = `Delay fuse: ${a.fuseDist.toFixed(2)} m is beyond the far side — the round is out of the vehicle before the filler goes off, so only its own path is struck.`;
      }
      const quiet = !items && !(a.filler && a.filler.hits.length)
        ? ' If no fragment finds anything either, one time in four a crewman is still concussed.' : '';
      path = `<h5>SHELL PATH</h5>${items ? `<ol class="ixPath">${items}</ol>` : `<p class="ixHint">Passes between the modules without striking one.${quiet}</p>`}
        ${fuseNote ? `<p class="ixHint">${fuseNote}</p>` : ''}`;
      if (a.filler && a.filler.hits.length) {
        path += `<h5>BURSTING CHARGE · ${a.filler.reach.toFixed(2)} M REACH${a.filler.bay ? ' · ENGINE BAY' : ''}</h5>${a.filler.hits.map((h) => `
          <div class="ixOdds"><span>${escHtml(moduleName(h.key, h.kind, h.label))}</span><div><i style="width:${Math.round(h.odds * 100)}%"></i></div><b>${pct(h.odds)} ${h.what}</b></div>`).join('')}
          <p class="ixHint">${a.filler.bay
    ? 'It goes off in the engine bay: the bulkhead spares the crew and the powerpack takes it. The bar is the chance each part is wrecked, or a fuel cell set alight.'
    : 'Every man inside the reach is hurt; the bar is the chance he is knocked out rather than wounded.'}</p>`;
      }
      if (a.spall && a.spall.hits.length) {
        path += `<h5>SPALL · ${a.spall.rays} FRAGMENTS · ${Math.round(a.spall.budget)} MM EACH</h5>${a.spall.hits.slice(0, 7).map((h) => `
          <div class="ixOdds"><span>${escHtml(moduleName(h.key, h.kind, h.label))}</span><div><i style="width:${Math.round(h.prob * 100)}%"></i></div><b>${pct(h.prob)}</b></div>`).join('')}`;
      }
    } else {
      path = `<p class="ixHint">${a.verdict === 'ricochet' ? 'The shell skids off the plate.' : 'The plate holds: an average round of this kind stops here.'}${a.verdict === 'maybe' ? ' Round-to-round scatter still gets through on some shots — see the odds below.' : ''}</p>`;
    }
    const n = Math.max(1, st.n);
    const bar = (label, v, cls = '') => `<div class="ixOdds ${cls}"><span>${escHtml(label)}</span><div><i style="width:${Math.round((v / n) * 100)}%"></i></div><b>${pct(v / n)}</b></div>`;
    let sim = `<h5>OVER ${st.n} SHOTS ON A FRESH VEHICLE</h5>
      ${bar('Penetrated', st.pen + st.kill, 'red')}
      ${bar('Vehicle destroyed', st.destroyed, 'red')}
      ${st.detonation ? bar('Ammo detonation', st.detonation, 'red') : ''}
      ${st.fire ? bar('Set on fire', st.fire, 'amber') : ''}
      ${st.ricochet ? bar('Ricochet', st.ricochet, 'blue') : ''}
      ${st.nonpen ? bar('Stopped', st.nonpen, 'green') : ''}`;
    const mods = Object.entries(st.modules).sort((x, y) => y[1] - x[1]);
    if (mods.length) sim += `<h5>MODULES KNOCKED OUT</h5>${mods.slice(0, 6).map(([k, v]) => bar(MODULE_NAMES[k] || k, v, 'amber')).join('')}`;
    const crew = IX_ROLE_ORDER.filter((r) => st.killed[r] || st.wounded[r]);
    if (crew.length) {
      sim += `<h5>CREW</h5>${crew.map((r) => `<div class="ixOdds"><span>${escHtml(IX_ROLE[r])}</span><div><i style="width:${Math.round(((st.killed[r] || 0) / n) * 100)}%"></i><i class="w" style="width:${Math.round(((st.wounded[r] || 0) / n) * 100)}%"></i></div><b>${pct((st.killed[r] || 0) / n)} KO</b></div>`).join('')}
        <p class="ixHint">Solid: knocked out. Pale: wounded (${crew.map((r) => `${IX_ROLE[r]} ${pct((st.wounded[r] || 0) / n)}`).join(', ')}).</p>`;
    }
    return `<section class="ixCard ixShot"><h4>TEST SHOT <button class="ixMini" data-ix="clearshot">CLEAR</button></h4>
      <div class="ixVerdict" style="--c:${cssHex(L.color)}">${head}</div>
      <dl class="ixKv">${kv.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`).join('')}</dl>
      ${path}${sim}</section>`;
  }

  // -------------------------------------------------------------------------
  // teardown
  // -------------------------------------------------------------------------

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.shot) {
      if (this.shot.group) this.world.remove(this.shot.group);
      if (this.shot.res) this.shot.res.dispose();
    }
    this.shot = null;
    if (this.el) {
      const { root, hit } = this.el;
      root.removeEventListener('click', this.onUiClick);
      root.removeEventListener('input', this.onUiInput);
      root.removeEventListener('change', this.onUiInput);
      hit.removeEventListener('pointerdown', this.onDown);
      hit.removeEventListener('pointermove', this.onMove);
      hit.removeEventListener('pointerup', this.onUp);
      hit.removeEventListener('pointercancel', this.onUp);
      hit.removeEventListener('pointerleave', this.onLeave);
      hit.removeEventListener('wheel', this.onWheel);
      hit.removeEventListener('dblclick', this.onDbl);
      hit.removeEventListener('contextmenu', this.onCtx);
      if (root.parentNode) root.parentNode.removeChild(root);
    }
    // Only what the ledger holds goes back: the vehicle meshes draw the
    // builders' cached geometry, which the next battle is about to need.
    this.res.dispose();
    this.edgeCache.clear();
    this.kindMats.clear();
    this.scene.clear();
    if (this.ownRenderer && this.renderer) {
      this.renderer.dispose();
      const gl = this.renderer.getContext && this.renderer.getContext();
      const lose = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
    this.renderer = null;
    this.analyst = null;
    this.modules = [];
    this.pickList = [];
    this.heat = null;
    this.callouts = [];
    this._callProbe = null;
    this._callDom = null;
    this.el = null;
  }
}

function shellLabel(key, s) {
  return `${key}${s.kind && s.kind !== key ? ` (${s.kind})` : ''} · ${s.caliber || '?'} mm · ${s.pen || 0} mm pen`;
}

// The shell list the protection analysis offers: the player's own gun first,
// as fitted, then every round of every tank in the tree.
export function inspectorShellCatalogue(tankSpecs, own = null) {
  const groups = [];
  if (own && own.shells) {
    groups.push({
      label: `Your gun — ${own.name || own.id}`,
      items: Object.keys(own.shells).map((k) => ({
        id: `own:${k}`, key: k, shell: own.shells[k], label: shellLabel(k, own.shells[k]),
      })),
    });
  }
  for (const s of Object.values(tankSpecs || {})) {
    if (!s.shells) continue;
    groups.push({
      label: s.name || s.id,
      items: Object.keys(s.shells).map((k) => ({
        id: `${s.id}:${k}`, key: k, shell: s.shells[k], label: shellLabel(k, s.shells[k]),
      })),
    });
  }
  return groups;
}
