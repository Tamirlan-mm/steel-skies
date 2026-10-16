import * as THREE from 'three';
import { agxToneMap, srgbByte } from '../world/presets.js';
import { terrainHeight } from '../world/terrain.js';
import { gradeFor, LENS } from '../core/postfx.js';
import { heightFogVeil, sigmaFor } from '../core/atmosphere.js';
import { setAssetsEnabled } from '../core/assets.js';
import { environmentState, propsNear } from '../world/scenery.js';
import {
  hexToLinear, PAINT_US_OD, PAINT_UK_SCC15, PAINT_SU_4BO, PAINT_DE_DUNKELGELB, PAINT_WHITEWASH,
} from '../core/materials.js';

// P-01 calibration card (?calib=1).
//
// A board 6 m in front of the player's spawn holding an 18 % grey card, a white
// card (Y 0.85), the four nation paint chips (US OD, British SCC 15, Soviet 4BO,
// German Dunkelgelb) and the winter whitewash. Each chip is shown twice over:
// a HORIZONTAL face and a face turned to the sun's azimuth (VERTICAL), and each
// of those has a SHADED twin under a roof that takes the sun and nothing else
// (three's image-based light is unshadowed, so the shaded card sees exactly the
// open-shade ambient of the light block, preset.light.ambLin / ambVLin).
//
// Everything the board shows can be predicted on the CPU from the same preset
// numbers the renderer is given: Lambert cards (no specular) under the sun and
// the light block's ambient, the height fog to the camera, AgX at the preset
// exposure, the L-07 grade and the K-01 vignette at the chip's screen position.
// predictBoard() does that; window.__calib.sample() renders one frame, reads
// the canvas under every chip and returns both, so the +/- 2 sRGB levels
// accept line is one console call, not a screenshot to eyeball.
//
//   window.__calib.view()     lock the camera on the board (sunward side, 45 deg)
//   window.__calib.free()     give the camera back to the battle
//   window.__calib.sample()   -> { rows: [{ id, face, lit, predicted, measured, d,
//                                devignetted, grain }], maxAbs, frame, env }
//   window.__calib.board      the board's chips and their world positions
//   window.__calib.hangar({hold}) the same board on the hangar slab through the
//                             hangar chain (L-09); res.keys -> force a battle
//                             onto the hangar's preset; hangarDone() removes it
//   window.__calib.compare(a, b)  chip-by-chip difference of two samples
//                             (vignette divided out), e.g. hangar vs battle
//   window.__calib.stats()    whole-frame mean HSV saturation (L-07 overcast)
//   window.__calib.assets(false)  battles started afterwards are lit by the
//                             procedural dome only (no HDRI): what the
//                             prediction models exactly
//
// The board stands on the nearest level spot with no prop on it, its roof or
// the view pose (findClearSpot), out of the player's own shadow.

export const CALIB_CHIPS = Object.freeze([
  { id: 'grey18', label: '18% GREY', lin: [0.18, 0.18, 0.18] },
  { id: 'white', label: 'WHITE Y0.85', lin: [0.85, 0.85, 0.85] },
  { id: 'us_od', label: 'US OD', hex: PAINT_US_OD },
  { id: 'uk_scc15', label: 'UK SCC15', hex: PAINT_UK_SCC15 },
  { id: 'su_4bo', label: 'SU 4BO', hex: PAINT_SU_4BO },
  { id: 'de_dunkelgelb', label: 'DE DUNKELGELB', hex: PAINT_DE_DUNKELGELB },
  { id: 'whitewash', label: 'WHITEWASH', hex: PAINT_WHITEWASH },
]);

const CARD = 0.6;          // m, square cards
const PITCH = 0.75;        // m between chip columns
const BLOCK_GAP = 1.5;     // m between the lit block and the shaded block
const H_HEIGHT = 0.5;      // m, horizontal card above the board base
const V_CENTRE = 1.45;     // m, centre of the sun-facing card
const ROOF_Y = 4.0;        // m, the shading roof (above every camera sight line)
const FRONT = 6;           // m in front of the player

const albedoOf = (chip) => (chip.lin ? chip.lin.slice() : hexToLinear(chip.hex));

// The sun's azimuth as a horizontal unit vector (S) and the axis along the
// board (A = up x S), from the caster direction the battle's light uses.
function boardAxes(preset) {
  const L = preset.light;
  const sd = preset.sunDir || { x: 0.53, y: 0.8, z: 0.27 };
  const flat = Math.hypot(sd.x, sd.z) || 1;
  const S = new THREE.Vector3(sd.x / flat, 0, sd.z / flat);
  const A = new THREE.Vector3(S.z, 0, -S.x);
  const elev = L && Number.isFinite(L.casterElev) ? L.casterElev : Math.asin(Math.max(0.1, sd.y));
  return { S, A, elev };
}

// The board, built in world space around `origin` (a Vector3 on the ground).
//   opts.shadowTexel  metres per shadow-map texel where the board stands: the
//                     roof's margins grow with it (wave 3b fix: on low, 0.43 m
//                     texels and the soft PCF edge lit the shaded twins)
export function buildCalibrationBoard(preset, origin, opts = {}) {
  const { S, A, elev } = boardAxes(preset);
  const group = new THREE.Group();
  group.name = 'calibrationBoard';
  const geos = [];
  const mats = [];
  const cardGeo = new THREE.PlaneGeometry(CARD, CARD);
  geos.push(cardGeo);
  const chips = [];
  const n = CALIB_CHIPS.length;
  const blockW = (n - 1) * PITCH;
  // lit block on -A, shaded block on +A
  // the shadow-map texel sets how soft the roof's shadow edge is: the blocks
  // move apart and the roof grows with it (wave 3b fix, see opts.shadowTexel)
  const texel = Number.isFinite(opts.shadowTexel) ? Math.max(0, opts.shadowTexel) : 0;
  const blockGap = BLOCK_GAP + 4 * texel;
  const blockCentre = (lit) => (lit ? -1 : 1) * (blockW / 2 + blockGap / 2);
  const baseY = origin.y;
  const quatH = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  // a plane faces +Z; turn +Z onto S for the sun-facing card
  const quatV = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), S);
  for (const lit of [true, false]) {
    CALIB_CHIPS.forEach((chip, i) => {
      // Lambert and nothing else: no specular lobe, so the card is exactly
      // the light block's albedo x irradiance / pi
      const mat = new THREE.MeshPhysicalMaterial({
        roughness: 1,
        metalness: 0,
        specularIntensity: 0,
        side: THREE.FrontSide,
      });
      const a = albedoOf(chip);
      mat.color.setRGB(a[0], a[1], a[2], THREE.LinearSRGBColorSpace);
      mats.push(mat);
      const along = blockCentre(lit) + (i - (n - 1) / 2) * PITCH;
      for (const face of ['H', 'V']) {
        const m = new THREE.Mesh(cardGeo, mat);
        const p = origin.clone().addScaledVector(A, along);
        if (face === 'H') {
          p.y = baseY + H_HEIGHT;
          m.quaternion.copy(quatH);
        } else {
          p.y = baseY + V_CENTRE;
          m.quaternion.copy(quatV);
        }
        m.position.copy(p);
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData.calib = { id: chip.id, face, lit };
        group.add(m);
        chips.push({ id: chip.id, label: chip.label, face, lit, albedo: a, mesh: m, world: p.clone() });
      }
    });
  }
  // The roof over the shaded block: horizontal, ROOF_Y above the base,
  // shifted sunward so its shadow lands on both the horizontal cards (at
  // H_HEIGHT) and the sun-facing ones (V_CENTRE +/- CARD/2), with margin.
  const t = Math.max(0.05, Math.tan(elev));
  // PCF's soft edge and the normal-offset lookup both reach a few texels
  const margin = 0.2 + 3 * texel;
  const near = (ROOF_Y - (V_CENTRE + CARD / 2 + 0.15)) / t - CARD / 2 - margin;
  const far = (ROOF_Y - (H_HEIGHT - 0.1)) / t + CARD / 2 + margin;
  const roofDepth = Math.max(0.5, far - near);
  const roofWidth = blockW + CARD + 2 * (0.3 + 1.5 * texel);
  const roofGeo = new THREE.BoxGeometry(roofWidth, 0.05, roofDepth);
  geos.push(roofGeo);
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.9, metalness: 0 });
  mats.push(roofMat);
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.castShadow = true;
  roof.receiveShadow = true;
  roof.position.copy(origin)
    .addScaledVector(A, blockCentre(false))
    .addScaledVector(S, (near + far) / 2);
  roof.position.y = baseY + ROOF_Y;
  // local X along the board (A), Y up, Z along the sun's azimuth: A x up = S,
  // so (A, up, S) is a proper rotation. (A, up, -S) is a reflection, which
  // setFromRotationMatrix cannot represent — the roof came out axis-aligned
  // and shaded nothing.
  roof.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(A, new THREE.Vector3(0, 1, 0), S));
  group.add(roof);

  return {
    group,
    chips,
    origin: origin.clone(),
    S,
    A,
    dispose() {
      group.parent?.remove(group);
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

// Scene radiance (linear, before fog) of a chip under the preset's light block.
export function chipRadiance(preset, albedo, face, lit) {
  const L = preset.light;
  const cy = Math.sin(L.casterElev);
  const ch = Math.cos(L.casterElev);
  const amb = face === 'H' ? L.ambLin : (L.ambVLin || L.ambLin);
  const sunK = lit ? (face === 'H' ? cy : ch) : 0;
  return [0, 1, 2].map((i) => albedo[i] * (L.sunLin[i] * sunK + amb[i]));
}

// The sRGB bytes the board should show for each chip, given where the camera
// is (fog) and where on screen the chip lands (vignette).
//   opts.camera     THREE.Camera (for the fog path and the vignette)
//   opts.aspect     width / height
//   opts.grade      apply the L-07 grade (default true)
//   opts.vignette   apply the K-01 vignette (default true)
export function predictBoard(preset, board, opts = {}) {
  const L = preset.light;
  const grade = opts.grade === false ? null : gradeFor(preset);
  const fogCol = preset.horizonRGB || [0.5, 0.5, 0.5];
  const sigma = sigmaFor(L.visibility);
  const invH = 1 / L.fogScaleHeight;
  const cam = opts.camera || null;
  const aspect = opts.aspect || 16 / 9;
  const ndc = new THREE.Vector3();
  return board.chips.map((c) => {
    const rad = chipRadiance(preset, c.albedo, c.face, c.lit);
    let veil = 0;
    let vig = 1;
    if (cam) {
      cam.updateMatrixWorld();
      const viewDepth = -c.world.clone().applyMatrix4(cam.matrixWorldInverse).z;
      veil = heightFogVeil(sigma, invH, cam.position, c.world, viewDepth, cam.far);
      ndc.copy(c.world).project(cam);
      if (opts.vignette !== false) {
        const dx = ndc.x * 0.5 * aspect;
        const dy = ndc.y * 0.5;
        const r2 = (dx * dx + dy * dy) / (0.25 * (aspect * aspect + 1));
        vig = 1 - LENS.vignette * r2;
      }
    }
    const scene = rad.map((v, i) => v * (1 - veil) + fogCol[i] * veil);
    let disp = agxToneMap(scene, L.exposure);
    if (grade && !grade.identity) {
      const m = grade.matrix;
      disp = [0, 1, 2].map((r) => Math.max(0, m[r * 3] * disp[0] + m[r * 3 + 1] * disp[1] + m[r * 3 + 2] * disp[2]));
    }
    disp = disp.map((v) => v * vig);
    return {
      id: c.id,
      face: c.face,
      lit: c.lit,
      srgb: disp.map((v) => srgbByte(v)),
      veil: +veil.toFixed(4),
      vignette: +vig.toFixed(4),
      ndc: [ndc.x, ndc.y],
    };
  });
}

// ---------------------------------------------------------------------------
// reading the canvas
// ---------------------------------------------------------------------------

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// A measured sRGB byte with the K-01 vignette divided back out (in linear
// light, where it was applied): what the chip would read at screen centre.
// That is what the hangar and the battle are compared on (L-09), because the
// same chip lands at a different screen position in each.
export function devignette(byte, vig) {
  if (!(vig > 0)) return byte;
  return srgbByte(toLin(byte / 255) / vig);
}

// HSV saturation of an sRGB byte triple
function hsvSat(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx > 0 ? (mx - mn) / mx : 0;
}

// Reads the drawing buffer under every chip of `board` — call it in the same
// task as the render, before the browser presents (no preserveDrawingBuffer).
//   o.graded / o.vignetted   whether the frame went through the L-07 / K-01
//                            finish (false on the low tier and in optics)
function measureBoard(gl, camera, preset, board, o = {}) {
  const W = gl.drawingBufferWidth;
  const H = gl.drawingBufferHeight;
  const pred = predictBoard(preset, board, {
    camera, aspect: W / H, grade: o.graded !== false, vignette: o.vignetted !== false,
  });
  const px = new Uint8Array(4 * 9 * 9);
  const corner = new THREE.Vector3();
  const rows = pred.map((p, ci) => {
    const sx = Math.round((p.ndc[0] * 0.5 + 0.5) * W);
    const sy = Math.round((p.ndc[1] * 0.5 + 0.5) * H);
    // The patch has to stay inside the card: a horizontal card seen from 30
    // degrees up is a third as tall as it is wide, and a 9 px patch on an
    // 11 px card reads the ground around it. Sized from the card's inner half
    // as projected (3..9 px, odd).
    let n = 9;
    const mesh = board.chips[ci] && board.chips[ci].mesh;
    if (mesh) {
      mesh.updateMatrixWorld();
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const [u, v] of [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]]) {
        corner.set(u, v, 0).applyMatrix4(mesh.matrixWorld).project(camera);
        const X = (corner.x * 0.5 + 0.5) * W;
        const Y = (corner.y * 0.5 + 0.5) * H;
        x0 = Math.min(x0, X); x1 = Math.max(x1, X);
        y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
      }
      const size = Math.floor(Math.min(x1 - x0, y1 - y0));
      n = Math.max(3, Math.min(9, size % 2 ? size : size - 1));
    }
    const half = n >> 1;
    const count = n * n;
    let measured = null;
    let grain = null;
    if (sx > 5 && sy > 5 && sx < W - 5 && sy < H - 5) {
      gl.readPixels(sx - half, sy - half, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const acc = [0, 0, 0];
      let ys = 0;
      let yy = 0;
      for (let i = 0; i < count; i++) {
        acc[0] += px[i * 4];
        acc[1] += px[i * 4 + 1];
        acc[2] += px[i * 4 + 2];
        const y = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
        ys += y;
        yy += y * y;
      }
      measured = acc.map((v) => +(v / count).toFixed(1));
      // spatial sigma of the luma over the patch: on a flat card that is the
      // K-01 grain (plus any shading gradient across a few px)
      const m = ys / count;
      grain = +Math.sqrt(Math.max(0, yy / count - m * m)).toFixed(2);
    }
    const d = measured ? measured.map((v, i) => +(v - p.srgb[i]).toFixed(1)) : null;
    const flat = measured ? measured.map((v) => devignette(v, p.vignette)) : null;
    return {
      id: p.id, face: p.face, lit: p.lit, predicted: p.srgb, measured, d, devignetted: flat, grain,
      veil: p.veil, vignette: p.vignette, screen: [sx, H - sy], patch: n,
    };
  });
  let maxAbs = 0;
  for (const row of rows) if (row.d) for (const v of row.d) maxAbs = Math.max(maxAbs, Math.abs(v));
  return { preset: preset.id, exposure: preset.light.exposure, rows, maxAbs, size: [W, H] };
}

// Whole-frame statistics of the drawing buffer (same task as the render):
// mean HSV saturation (L-07 overcast accept), mean luma, and the corner /
// centre luma of the frame (K-01 vignette, meaningful on a uniform view).
function frameStats(gl, step = 4) {
  const W = gl.drawingBufferWidth;
  const H = gl.drawingBufferHeight;
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sat = 0;
  let lum = 0;
  let n = 0;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4;
      sat += hsvSat(px[i], px[i + 1], px[i + 2]);
      lum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      n++;
    }
  }
  const patch = (cx, cy) => {
    let s = 0;
    let c = 0;
    for (let y = Math.max(0, cy - 8); y < Math.min(H, cy + 8); y++) {
      for (let x = Math.max(0, cx - 8); x < Math.min(W, cx + 8); x++) {
        const i = (y * W + x) * 4;
        s += toLin(px[i] / 255) * 0.2126 + toLin(px[i + 1] / 255) * 0.7152 + toLin(px[i + 2] / 255) * 0.0722;
        c++;
      }
    }
    return s / Math.max(1, c);
  };
  const centre = patch(W >> 1, H >> 1);
  const corners = [patch(8, 8), patch(W - 9, 8), patch(8, H - 9), patch(W - 9, H - 9)];
  const corner = corners.reduce((a, b) => a + b, 0) / 4;
  return {
    size: [W, H],
    meanSaturation: +(sat / n).toFixed(4),
    meanLuma: +(lum / n).toFixed(2),
    cornerOverCentre: centre > 0 ? +(corner / centre).toFixed(4) : null,
  };
}

// Where the board can stand: level ground with no prop (tree, wall, rock,
// building) on the board, its roof, the view pose or the sight lines between,
// and clear of the player's vehicle and its shadow. Searched outward from 6 m
// in front of the player; the first clear spot wins. A wood right at the
// spawn otherwise hides half the chips (meadow) and a slope buries the low
// cards. origin.userData says what was found.
function findClearSpot(preset, player, texel = 0) {
  const { S, A, elev } = boardAxes(preset);
  const yaw = Number.isFinite(player.yaw) ? player.yaw : 0;
  const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const pp = player.position;
  const viewDir = S.clone().multiplyScalar(Math.SQRT1_2).addScaledVector(A, -Math.SQRT1_2);
  // the board's half-length as buildCalibrationBoard lays it out (its block
  // gap grows by 4 shadow texels, wave 3c), probed every metre: a 2 m probe
  // step let a hump between probes stand 8-12 cm over the stand bases
  const halfW = ((CALIB_CHIPS.length - 1) * PITCH) + (BLOCK_GAP + 4 * Math.max(0, texel)) / 2 + CARD;
  const probe = [];
  // along the board, and a strip sunward of it for the roof
  for (let a = -halfW; a <= halfW + 0.01; a += 1) {
    for (const sOff of [-1, 0, 1.5, 4]) probe.push([a, sOff, sOff === 0 ? 1.5 : 3]);
  }
  // the view pose and the sight lines toward it
  for (const t of [0.35, 0.65, 1]) {
    probe.push([viewDir.dot(A) * 10 * t, viewDir.dot(S) * 10 * t, 3]);
  }
  const at = (o, a, sOff) => [o.x + A.x * a + S.x * sOff, o.z + A.z * a + S.z * sOff];
  let near;
  try {
    near = (x, z, r) => propsNear(x, z, r).length;
  } catch {
    near = () => 0;
  }
  const tryAt = (o) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [a, sOff, r] of probe) {
      const [x, z] = at(o, a, sOff);
      if (near(x, z, r) > 0) return null;
      if (Math.abs(sOff) <= 1.5) {
        const y = terrainHeight(x, z);
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      if (Math.hypot(x - pp.x, z - pp.z) < 7) return null;
    }
    if (hi - lo > 0.5) return null;
    // not in the player's own shadow: a 3 m vehicle sunward of the board
    // throws its shadow 3 / tan(elevation) metres across it
    const rel = new THREE.Vector3(pp.x - o.x, 0, pp.z - o.z);
    const along = rel.dot(S);
    if (along > 0 && Math.abs(rel.dot(A)) < halfW + 4 && along < 3 / Math.max(0.05, Math.tan(elev)) + 6) return null;
    if (!sunClear(o, hi)) return null;
    return hi;
  };
  // The lit block must see the sun (wave 3c): under a 6-8 degree sun a 10 m
  // tree throws its shadow 70-95 m and a low rise further still, and on
  // meadow dawn / dusk boards the whole lit block stood in such a shadow
  // (-10 to -60 levels). March the sun ray from the low cards of the lit
  // block (both ends and the middle) until it clears 35 m: terrain above the
  // ray, or a prop whose top is, rejects the spot.
  const tanE = Math.tan(Math.max(0.03, elev));
  const litMid = -(((CALIB_CHIPS.length - 1) * PITCH) / 2 + (BLOCK_GAP + 4 * Math.max(0, texel)) / 2);
  const litHalf = ((CALIB_CHIPS.length - 1) * PITCH) / 2 + CARD / 2;
  const sunReach = Math.min(450, (35 - H_HEIGHT) / tanE);
  const sunClear = (o, base) => {
    for (const a of [litMid - litHalf, litMid, litMid + litHalf]) {
      for (let d = 1.5; d <= sunReach; d += 3) {
        const x = o.x + A.x * a + S.x * d;
        const z = o.z + A.z * a + S.z * d;
        const ry = base + H_HEIGHT + d * tanE;
        if (terrainHeight(x, z) > ry - 0.05) return false;
        let ps;
        try {
          ps = propsNear(x, z, 1.5);
        } catch {
          ps = [];
        }
        for (const p of ps) {
          const foot = Number.isFinite(p.y) ? p.y : terrainHeight(p.x, p.z);
          if (foot + (Number.isFinite(p.h) ? p.h : 8) > ry) return false;
        }
      }
    }
    return true;
  };
  const dists = [6, 10, 15, 22, 30, 40, 55, 70, 90, 115, 140, 170];
  for (const d of dists) {
    for (let k = 0; k < 24; k++) {
      const ang = Math.atan2(fwd.x, fwd.z) + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 12);
      const o = new THREE.Vector3(pp.x + Math.sin(ang) * d, 0, pp.z + Math.cos(ang) * d);
      const top = tryAt(o);
      if (top !== null) {
        o.y = top;
        o.userData = { clear: true, distance: d };
        return o;
      }
    }
  }
  const o = pp.clone().addScaledVector(fwd, FRONT);
  o.y = terrainHeight(o.x, o.z);
  o.userData = { clear: false, distance: FRONT };
  return o;
}

// ---------------------------------------------------------------------------
// the ?calib=1 hook
// ---------------------------------------------------------------------------
export function startCalibration(shell) {
  const state = {
    board: null,
    battle: null,
    lock: false,
    pending: [],
    hideUnits: false,          // sample(): leave the units out of the measured frame
    hidden: [],                // ... and these were hidden for it
    hangarBoard: null,
  };

  function place(battle) {
    if (state.board) state.board.dispose();
    state.board = null;
    state.battle = battle;
    const p = battle && battle.player;
    if (!p || !p.position || !battle.preset || !battle.preset.light) return;
    const envNow = environmentState();
    const texel = envNow && envNow.shadowMapSize > 0
      ? (2 * Math.max(envNow.shadowHalf || 0, envNow.shadowHalfY || 0)) / envNow.shadowMapSize : 0;
    const origin = findClearSpot(battle.preset, p, texel);
    state.spot = origin.userData;
    state.board = buildCalibrationBoard(battle.preset, origin, { shadowTexel: texel });
    battle.scene.add(state.board.group);
  }

  function chain() {
    const fx = shell.postfx;
    const battle = state.battle;
    const optic = !!(battle && battle.sniper);
    const graded = !!(fx && fx.running) && !optic;
    return { graded, vignetted: graded, quality: fx ? fx.getQuality() : 'low' };
  }

  function measure() {
    const b = state.board;
    const battle = state.battle;
    if (!b || !battle) return null;
    const gl = shell.renderer.getContext();
    const c = chain();
    const res = measureBoard(gl, battle.camera, battle.preset, b, c);
    return {
      where: 'battle',
      ...res,
      preset: battle.preset.id,
      keys: { biome: battle.preset.biome, tod: battle.preset.todKey, weather: battle.preset.weatherKey },
      quality: c.quality,
      graded: c.graded,
      spot: state.spot || null,
      env: (() => { try { return environmentState(); } catch { return null; } })(),
      frame: frameStats(gl),
    };
  }

  // ---- the hangar (L-09): the same board on the hangar slab, the same pose,
  // photographed through the hangar's own chain
  function hangarStage() {
    const g = shell.garage;
    const h = g && g.hangar;
    return h && !h.dead && h.renderer && h.scene && h.camera ? h : null;
  }

  function sampleHangar(opts = {}) {
    const h = hangarStage();
    if (!h) return null;
    // hold: stop the stage loop so the board shot stays on the canvas for a
    // screenshot (hangarDone() restarts it)
    if (opts.hold && h.running) {
      h.stop();
      state.heldHangar = h;
    }
    const preset = h.stagePreset || (h.rig && h.rig.preset);
    if (!preset || !preset.light) return null;
    if (!state.hangarBoard) {
      const origin = new THREE.Vector3(0, h.padTop || 0, 0);
      state.hangarBoard = buildCalibrationBoard(preset, origin);
      h.scene.add(state.hangarBoard.group);
    }
    const b = state.hangarBoard;
    const cam = h.camera;
    const saved = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov };
    const model = h.modelRoot || null;
    const modelVis = model ? model.visible : true;
    if (model) model.visible = false;
    // the backdrop trees and rocks would throw their long low-sun shadows
    // across the board once the shadow box is widened (below)
    const backdrop = (h.backdrop && h.backdrop.parts) || [];
    const backVis = backdrop.map((o) => o.visible);
    for (const o of backdrop) o.visible = false;
    // The hangar's shadow box is a portrait box (+/- 14 m, casters from 20 m
    // sunward at most); the board's roof sits up to 37 m sunward under a 6
    // degree sun. For the shot the box is widened to the board's needs — a
    // coarser texel, which flat cards do not care about — and put back after.
    const key = h.key && h.key.shadow ? h.key : null;
    const sc = key ? key.shadow.camera : null;
    const savedShadow = sc ? {
      near: sc.near, far: sc.far, left: sc.left, right: sc.right, top: sc.top, bottom: sc.bottom, pos: key.position.clone(),
      bias: key.shadow.bias, normalBias: key.shadow.normalBias,
    } : null;
    let res = null;
    try {
      if (key) {
        const tgt = key.target.position;
        const dir = key.position.clone().sub(tgt).normalize();
        key.position.copy(tgt).addScaledVector(dir, 120);
        sc.near = 1;
        sc.far = 240;
        sc.left = -40;
        sc.right = 40;
        sc.top = 40;
        sc.bottom = -40;
        // the battle's bias law for this texel and depth range
        const texel = 80 / Math.max(1, key.shadow.mapSize.x);
        key.shadow.bias = -(texel / (sc.far - sc.near)) * 8;
        key.shadow.normalBias = texel * 1.8;
        sc.updateProjectionMatrix();
        key.updateMatrixWorld();
      }
      // the battle camera's 60 degrees, so the whole board is in frame
      cam.fov = 60;
      cam.updateProjectionMatrix();
      viewPoseFor(b, cam);
      h.rig?.update();
      const fx = h.postfx;
      if (fx) fx.render(0);
      else h.renderer.render(h.scene, cam);
      const graded = !!(fx && fx.running);
      const gl = h.renderer.getContext();
      res = {
        where: 'hangar',
        ...measureBoard(gl, cam, preset, b, { graded, vignetted: graded }),
        keys: { biome: preset.biome, tod: preset.todKey, weather: preset.weatherKey },
        quality: fx ? fx.getQuality() : 'low',
        graded,
        hdri: h.rig ? h.rig.hdri : null,
        frame: frameStats(gl),
      };
    } finally {
      if (model) model.visible = modelVis;
      backdrop.forEach((o, i) => { o.visible = backVis[i]; });
      cam.position.copy(saved.pos);
      cam.quaternion.copy(saved.quat);
      cam.fov = saved.fov;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      if (key && savedShadow) {
        Object.assign(sc, {
          near: savedShadow.near, far: savedShadow.far, left: savedShadow.left, right: savedShadow.right, top: savedShadow.top, bottom: savedShadow.bottom,
        });
        key.shadow.bias = savedShadow.bias;
        key.shadow.normalBias = savedShadow.normalBias;
        sc.updateProjectionMatrix();
        key.position.copy(savedShadow.pos);
        key.updateMatrixWorld();
      }
    }
    return res;
  }

  function removeHangarBoard() {
    if (state.hangarBoard) state.hangarBoard.dispose();
    state.hangarBoard = null;
  }

  shell.hooks.onBattleStart = (battle) => {
    try {
      place(battle);
    } catch (e) {
      console.warn('[calib] board not placed:', e);
    }
  };
  shell.hooks.afterUpdate = (battle) => {
    if (battle !== state.battle) {
      // a respawn or a new battle that did not go through startBattle
      place(battle);
    }
    if (state.lock && state.board) viewPoseFor(state.board, battle.camera);
    if (state.hideUnits && state.pending.length) {
      for (const key of ['tanks', 'planes', 'groundUnits']) {
        const list = battle[key];
        if (!Array.isArray(list)) continue;
        for (const u of list) {
          const o = u && (u.group || u.mesh || u.root);
          if (o && o.isObject3D && o.visible) {
            o.visible = false;
            state.hidden.push(o);
          }
        }
      }
    }
  };
  shell.hooks.afterRender = () => {
    if (!state.pending.length) return;
    const res = measure();
    const waiting = state.pending.splice(0, state.pending.length);
    for (const w of waiting) w(res);
  };

  const api = {
    get board() {
      return state.board ? state.board.chips.map((c) => ({ id: c.id, face: c.face, lit: c.lit, world: c.world.toArray() })) : null;
    },
    view() {
      state.lock = true;
      return !!state.board;
    },
    free() {
      state.lock = false;
    },
    // Render a frame now (rAF may be throttled in a hidden pane) and read the
    // canvas under every chip in the same task, before it is presented.
    //
    // Emitters anywhere in the frame (an AI tank's muzzle flash, a fire)
    // bloom onto the board: one distant flash measured +15 levels on the dark
    // shaded chips at desert dusk (wave 3c). The chips themselves sit under
    // the bloom threshold by construction (L-05: 1.15 x 0.85 x the brightest
    // white card), so the measured frame leaves the bloom pass out unless
    // opts.bloom is true; res.bloom says which it was.
    sample(opts = {}) {
      return new Promise((resolve) => {
        const fx = shell.postfx;
        let bp = null;
        try {
          bp = !opts.bloom && fx && fx.composer
            ? fx.composer.passes.find((p) => p.__kind === 'bloom' && p.enabled) || null : null;
        } catch {
          bp = null;
        }
        if (bp) bp.enabled = false;
        // Vehicles move: an allied tank that drove sunward of the board after
        // it was placed threw a 21 m dawn shadow over the lit chips (-30 to
        // -88 levels on one meadow-dawn board, wave 3c). The measured frame
        // leaves every unit out (opts.units true keeps them).
        // (hidden in afterUpdate, after the battle's own visibility pass)
        if (!opts.units) state.hideUnits = true;
        state.pending.push((res) => {
          if (bp) bp.enabled = true;
          const hid = state.hidden.length;
          for (const o of state.hidden) o.visible = true;
          state.hidden.length = 0;
          state.hideUnits = false;
          if (res) {
            res.bloom = !bp;
            res.units = !hid;
          }
          resolve(res);
        });
        if (opts.render !== false) shell.frame(0);
      });
    },
    predict() {
      const b = state.board;
      const battle = state.battle;
      if (!b || !battle) return null;
      return predictBoard(battle.preset, b, { camera: battle.camera });
    },
    // L-09: the board on the hangar slab (the vehicle hidden for the shot),
    // photographed through the hangar chain. Returns the same rows as
    // sample(), plus the hangar preset's keys so a battle can be forced onto
    // it: globalThis.__STEEL_SKIES_PRESET__ = res.keys.
    hangar(opts) {
      return sampleHangar(opts);
    },
    // Photo assets (the HDRI image-based light among them) on or off for
    // battles started after the call: off, the battle is lit by the
    // procedural dome alone, which is exactly what predictBoard() models.
    assets(on) {
      return setAssetsEnabled(on !== false);
    },
    // the Hangar3D instance (debug console access), or null
    get stage() {
      return hangarStage();
    },
    get shell() {
      return shell;
    },
    hangarDone() {
      removeHangarBoard();
      if (state.heldHangar && !state.heldHangar.dead) state.heldHangar.start();
      state.heldHangar = null;
    },
    // Compare two sample results chip by chip on the devignetted bytes.
    compare(a, b) {
      if (!a || !b) return null;
      const key = (r) => `${r.id}:${r.face}:${r.lit ? 'lit' : 'shade'}`;
      const mb = new Map(b.rows.map((r) => [key(r), r]));
      let maxAbs = 0;
      const rows = a.rows.map((r) => {
        const o = mb.get(key(r));
        if (!r.devignetted || !o || !o.devignetted) return { chip: key(r), d: null };
        const d = r.devignetted.map((v, i) => v - o.devignetted[i]);
        for (const v of d) maxAbs = Math.max(maxAbs, Math.abs(v));
        return { chip: key(r), a: r.devignetted, b: o.devignetted, d };
      });
      return { rows, maxAbs };
    },
    // whole-frame statistics of the next battle frame (mean HSV saturation,
    // corner/centre luma)
    stats() {
      return new Promise((resolve) => {
        state.pending.push(() => resolve(frameStats(shell.renderer.getContext())));
        shell.frame(0);
      });
    },
  };
  window.__calib = api;
  console.log('[calib] calibration board armed: start a battle, then __calib.view() and await __calib.sample(); __calib.hangar() samples the hangar stage');
  return api;
}

// sunward side, 45 degrees toward the lit block, high enough to see the
// horizontal cards, every sight line under the shading roof
export function viewPoseFor(b, camera) {
  if (!b) return;
  const dir = b.S.clone().multiplyScalar(Math.SQRT1_2).addScaledVector(b.A, -Math.SQRT1_2);
  const target = b.origin.clone();
  target.y += 1.0;
  camera.position.copy(b.origin).addScaledVector(dir, 10);
  camera.position.y = b.origin.y + 6;
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  camera.updateMatrixWorld();
}
