import * as THREE from 'three';
import { buildTankMesh } from '../vehicles/tanks.js';
import { buildPlaneMesh } from '../vehicles/planes.js';
import { composePreset } from '../world/presets.js';
import { createPhotoRig } from '../core/postfx.js';
import { isSharedResource } from '../core/materials.js';
// Namespace import: the rating module is young, and a thumbnail is not worth
// taking the garage down over if one of its exports is ever renamed.
import * as brMod from '../game/battleRating.js';

// Procedural "photos" for the garage cards: each vehicle mesh is rendered
// once into a small offscreen canvas and cached as a data URL.
//
// H-08 option A: the photo is taken under the battle rig (core/postfx.js
// createPhotoRig) at one fixed preset — meadow, noon, clear — so a card shows
// the paint the battle will show: the battle sun and ground-bounce
// hemisphere, the noon dome's PMREM for the sky, AgX at that preset's
// exposure. No studio lights, no studio environment map. The sun keeps the noon
// elevation but is turned to come over the camera's right shoulder, so the
// side the card shows is the lit one. The background stays transparent (the
// card's own CSS shows through), so neither the dome nor the fog is drawn.
let renderer = null;
let scene = null;
let camera = null;
let rig = null;
let webglDead = false;
const cache = new Map();
const badgeCache = new Map();
const THUMB_PRESET = composePreset('meadow', 'noon', 'clear');

const DEFAULT_W = 300;
const DEFAULT_H = 160;

// Three-quarter front view, high enough to read the deck and the turret roof.
// Kept as a direction and fitted to the vehicle's own bounding sphere, so a
// six-metre Stuart and an eleven-metre P-51 both fill the frame instead of the
// small one swimming in it.
const VIEW_DIR = new THREE.Vector3(0.62, 0.34, 0.72).normalize();

function ensure() {
  if (renderer || webglDead) return;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(DEFAULT_W, DEFAULT_H);
    renderer.setClearColor(0x000000, 0);
    scene = new THREE.Scene();
    // The camera looks back along VIEW_DIR, so "over its right shoulder" is
    // VIEW_DIR's azimuth turned 35 degrees clockwise seen from above.
    const camYaw = Math.atan2(VIEW_DIR.x, VIEW_DIR.z);
    rig = createPhotoRig(renderer, scene, THUMB_PRESET, {
      dome: false,
      fog: false,
      background: false,
      hdri: false,
      sunAzimuth: camYaw - (35 * Math.PI) / 180,
      sunDistance: 30,
    });
    // a metal has no diffuse term, so the environment has to exist before
    // the first card is drawn, or every barrel and track renders black
    rig.bake();
    camera = new THREE.PerspectiveCamera(30, DEFAULT_W / DEFAULT_H, 0.1, 200);
  } catch (err) {
    // headless, no GPU, or the browser has run out of live WebGL contexts —
    // the garage must still draw its cards, so fall back to a flat plate
    webglDead = true;
    renderer = null;
  }
}

const fitX = new THREE.Vector3();
const fitY = new THREE.Vector3();
const fitV = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// The distance along VIEW_DIR at which the whole vehicle lands inside the
// frustum, measured against the real vertices rather than a bounding volume.
// A sphere is mostly empty air around something this long and flat, and even
// the box's corners are air — fitting either would push the camera back far
// enough to shrink the vehicle into the middle of an empty card.
function fitDistance(group, center, cam) {
  const vFov = (cam.fov * Math.PI) / 180;
  const tanV = Math.tan(vFov / 2);
  const tanH = tanV * cam.aspect;
  fitX.crossVectors(WORLD_UP, VIEW_DIR).normalize();
  if (fitX.lengthSq() < 1e-6) fitX.set(1, 0, 0);
  fitY.crossVectors(VIEW_DIR, fitX).normalize();

  let d = 0;
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    const pos = (o.isMesh || o.isLine || o.isPoints)
      && o.geometry && o.geometry.attributes && o.geometry.attributes.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      fitV.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).sub(center);
      const depth = fitV.dot(VIEW_DIR);
      const need = Math.max(
        Math.abs(fitV.dot(fitX)) / tanH,
        Math.abs(fitV.dot(fitY)) / tanV,
      ) + depth;
      if (need > d) d = need;
    }
  });
  return Math.max(d, 0.5);
}

// Build the right mesh for the vehicle. `kind` is what the garage passes, but
// the spec itself is the better authority: a plane has a span and no hull.
function buildFor(spec, kind) {
  const air = kind === 'air' || (!spec.hull && spec.span != null);
  // Same reasoning as the hangar: a vehicle card is not a battlefield.
  return air ? buildPlaneMesh(spec, null, null) : buildTankMesh(spec, null, null);
}

// Give back only what this build made for itself. The vehicle builders hand
// out geometry from a per-spec cache and materials from the shared factory —
// the same buffers and programs every battle and the hangar draw — and
// disposing those here made every other renderer re-upload and recompile them
// (the same rule as the hangar's disposeTree). The geometry is never ours.
function disposeGroup(group) {
  group.traverse((o) => {
    if (o.isMesh || o.isLine || o.isPoints) {
      const m = o.material;
      const mats = Array.isArray(m) ? m : [m];
      for (const mm of mats) if (mm && !isSharedResource(mm)) mm.dispose?.();
    }
  });
}

// Render one vehicle into the shared WebGL canvas and hand that canvas back
// (or null when there is nothing to draw with). The caller turns it into a
// data URL, either straight off the GL canvas or through a 2d composite.
function renderVehicle(spec, kind, w, h) {
  ensure();
  if (!renderer) return null;

  let built;
  try {
    built = buildFor(spec, kind);
  } catch (err) {
    return null;
  }
  const group = built.group;
  scene.add(group);

  const box = new THREE.Box3().setFromObject(group);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() * 0.5;

  if (renderer.domElement.width !== w || renderer.domElement.height !== h) {
    renderer.setSize(w, h, false);
  }
  camera.aspect = w / h;
  const dist = fitDistance(group, center, camera) * 1.04;
  camera.position.copy(center).addScaledVector(VIEW_DIR, dist);
  camera.near = Math.max(0.1, dist - radius * 1.6);
  camera.far = dist + radius * 3;
  camera.updateProjectionMatrix();
  camera.lookAt(center);

  let ok = true;
  try {
    renderer.render(scene, camera);
  } catch (err) {
    ok = false;
  }

  scene.remove(group);
  disposeGroup(group);
  return ok ? renderer.domElement : null;
}

function make2d(w, h) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c.getContext && c.getContext('2d') ? c : null;
}

// A flat card with the vehicle's initials — never pretty, but it keeps the
// garage laid out correctly when there is no GPU to draw a real one.
function drawPlaceholder(ctx, spec, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#243240');
  g.addColorStop(1, '#131b23');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#6f8496';
  ctx.font = `bold ${Math.round(h * 0.3)}px system-ui, Segoe UI, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials(spec), w / 2, h / 2);
}

function initials(spec) {
  const name = spec.name || spec.id || '?';
  return name.split(/[\s-]+/).slice(0, 2).map((s) => s[0] || '').join('').toUpperCase();
}

// ---------------------------------------------------------------------------
// Battle Rating badge
//
// The rating is derived from the stat block, so it moves whenever a vehicle is
// rebalanced — which is exactly why it is drawn rather than authored. Cheap: a
// 2d canvas, cached by rating, shared between every card that rates the same.
// ---------------------------------------------------------------------------
function brValue(spec) {
  try {
    if (typeof brMod.brOf === 'function') return brMod.brOf(spec);
  } catch (err) {
    // a spec the rating curve cannot read is not worth a broken card
  }
  return null;
}

// Rungs of the ladder, tinted the way the garage tints tiers: low BR cool,
// top BR hot, so a glance at a row of cards sorts itself.
function brColor(br) {
  if (br == null) return '#6f8496';
  if (br < 1.7) return '#6fb0d8';
  if (br < 2.7) return '#58d068';
  if (br < 3.7) return '#e8d060';
  if (br < 5.0) return '#e0902c';
  return '#e05a44';
}

// Draw the badge into any 2d context at (x, y), `w` wide. Used both by the
// standalone badge image and by the corner stamp on a thumbnail, so the two
// can never drift apart.
function drawBadge(ctx, x, y, w, br) {
  const h = w * (26 / 78);
  const s = w / 78;
  const accent = brColor(br);
  roundRect(ctx, x + s, y + s, w - 2 * s, h - 2 * s, 4 * s);
  ctx.fillStyle = 'rgba(9, 14, 19, 0.86)';
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.4 * s;
  ctx.stroke();
  // the accent bar reads as a rung on the ladder even before the digits do
  ctx.fillStyle = accent;
  ctx.fillRect(x + 4 * s, y + h / 2 - 6 * s, 3 * s, 12 * s);
  ctx.fillStyle = '#e6eef6';
  ctx.font = `bold ${12 * s}px system-ui, Segoe UI, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`BR ${br.toFixed(1)}`, x + 12 * s, y + h / 2 + s * 0.5);
}

// A standalone badge image, for a card that wants it as its own element.
export function vehicleBadge(spec, opts = {}) {
  const br = opts.br != null ? opts.br : brValue(spec);
  if (br == null) return '';
  const scale = opts.scale || 2;
  const key = `${br.toFixed(1)}|${scale}`;
  const hit = badgeCache.get(key);
  if (hit !== undefined) return hit;

  const c = make2d(78 * scale, 26 * scale);
  if (!c) return '';
  drawBadge(c.getContext('2d'), 0, 0, 78 * scale, br);
  const url = c.toDataURL('image/png');
  badgeCache.set(key, url);
  return url;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

// The call the garage already makes. Unchanged: same two arguments, same
// cache, same data URL. `opts` is additive — { width, height, badge }.
export function vehicleThumb(spec, kind, opts = null) {
  const w = (opts && opts.width) || DEFAULT_W;
  const h = (opts && opts.height) || DEFAULT_H;
  const badge = !!(opts && opts.badge);
  const key = `${kind || 'ground'}:${spec.id || spec.name}:${w}x${h}${badge ? ':br' : ''}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const gl = renderVehicle(spec, kind, w, h);
  const br = badge ? ((opts && opts.br != null) ? opts.br : brValue(spec)) : null;
  let url = '';

  if (gl && br == null) {
    // the plain path is exactly what it always was: straight off the GL canvas
    try {
      url = gl.toDataURL('image/png');
    } catch (err) {
      url = '';
    }
  } else {
    // anything that needs compositing goes through a 2d canvas. Drawing a
    // canvas into a canvas is synchronous, which an Image() round trip is not.
    const c = make2d(w, h);
    if (c) {
      const ctx = c.getContext('2d');
      if (gl) ctx.drawImage(gl, 0, 0, w, h);
      else drawPlaceholder(ctx, spec, w, h);
      if (br != null) {
        const bw = Math.min(w * 0.42, 78);
        drawBadge(ctx, w - bw - 6, h - bw * (26 / 78) - 6, bw, br);
      }
      url = c.toDataURL('image/png');
    }
  }

  cache.set(key, url);
  return url;
}

// Convenience for a card that wants the rating burned into the picture.
export function vehicleThumbBadged(spec, kind, opts = {}) {
  return vehicleThumb(spec, kind, { ...opts, badge: true });
}

// Drop one vehicle (after a modification changes its look) or the lot.
export function clearThumbCache(specOrId = null) {
  if (!specOrId) {
    cache.clear();
    return;
  }
  const id = typeof specOrId === 'string' ? specOrId : specOrId.id;
  for (const key of [...cache.keys()]) {
    if (key.includes(`:${id}:`)) cache.delete(key);
  }
}

// Give the WebGL context back. The garage never needs to, but a screen that
// opens a second renderer (the protection analysis) may want the headroom.
export function disposeThumbs() {
  try {
    rig?.dispose();
  } catch (err) {
    /* going away regardless */
  }
  rig = null;
  if (renderer) {
    renderer.dispose();
    const gl = renderer.getContext && renderer.getContext();
    const lose = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }
  renderer = null;
  scene = null;
  camera = null;
  cache.clear();
}
