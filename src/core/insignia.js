import * as THREE from 'three';
import { markShared, srgbToLinear, linearToSrgb } from './materials.js';

// National markings and stencil numerals (realism backlog V-09, contract R2-I).
//
//   insigniaAtlas() -> { texture, rect(name), names, width, height, data }
//     rect(name) -> { u0, v0, u1, v1, aspect } in texture uv (v = 0 at the
//     BOTTOM row: the data is not flipped), aspect = cell height / width.
//   Names: us_star, us_star_bar, raf_b, raf_a1, raf_fin, de_balkenkreuz,
//   jp_hinomaru, su_star, digit_0 ... digit_9, plus the tank set's
//   us_star_white (a plain white star) and solid (a white block: recognition
//   panels, turret bands, the vision-block glass).
//
// Everything is drawn here from geometry: circles, polygons and stroked
// segments, rasterised in JS with adaptive 4x4 supersampling into an sRGB
// RGBA buffer. No fonts, no image files, no canvas (so it renders identically
// in the headless test harness and in the browser). The colours are written as
// sRGB BYTES straight from the hex tables below; they never pass through
// THREE.Color (bible C-03).
//
// Historical scope (bible V-40/V-41). The set is what the eleven machines of
// the roster carried in their stated years: the US star (1942-43) and the
// star-and-bar with the insignia-blue surround (from September 1943), the RAF
// type B and type A.1 roundels and the 1940-42 fin flash, the Balkenkreuz,
// the hinomaru and the Soviet star. The German tail marking of the period is
// deliberately absent — as is customary in games, and as the art bible
// requires (V-41). No glyph in this file depicts it, and none may be added.

const W = 1024;
const H = 512;

// sRGB hex per paint. Each is a dull, matt service paint, not a flag colour,
// and each sits inside the bible's albedo floor and ceiling (C-01: linear Y
// 0.020-0.85; painted black >= 0.025). Weathered whites stay at whitewash
// level (Y ~0.56) rather than fresh-snow bright.
export const INSIGNIA_PAINT = Object.freeze({
  white: 0xc6c7c2,      // insignia white, weathered            Y ~0.56
  usBlue: 0x1f2d4d,     // US insignia blue (FS 15044 family)    Y ~0.027
  rafRed: 0x7e2a28,     // RAF dull roundel red                  Y ~0.062
  rafBlue: 0x2d3e64,    // RAF dull roundel blue                 Y ~0.049
  rafYellow: 0xc9a23a,  // RAF roundel / ID yellow               Y ~0.385
  deBlack: 0x2c2d2f,    // RLM 22 black, the bible's painted-black floor
  jpRed: 0xa33a2e,      // hinomaru red                          Y ~0.110
  suRed: 0xa3332c,      // Soviet star red                       Y ~0.10
});
// The roughness every marking is drawn at, wherever it is drawn: matt service
// paint, never a gloss sticker (bible V-40 test: insignia roughness >= 0.5).
export const INSIGNIA_ROUGHNESS = 0.6;

const P = INSIGNIA_PAINT;
function rgbOf(hex) {
  return [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255)];
}

// ---------------------------------------------------------------------------
// primitives: each returns (x, y) -> bool in glyph units
// ---------------------------------------------------------------------------
const disc = (cx, cy, r) => (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const any = (...fs) => (x, y) => fs.some((f) => f(x, y));
const minus = (a, b) => (x, y) => a(x, y) && !b(x, y);

function poly(pts) {
  // (outside the box no crossing count can be odd, so the reject is exact)
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of pts) {
    x0 = Math.min(x0, px); y0 = Math.min(y0, py);
    x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  }
  const n = pts.length;
  const P = new Float64Array(n * 2);
  pts.forEach(([px, py], i) => {
    P[i * 2] = px;
    P[i * 2 + 1] = py;
  });
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = P[i * 2];
      const yi = P[i * 2 + 1];
      const xj = P[j * 2];
      const yj = P[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

// A regular five-pointed star, one point straight up, outer radius R. The
// inner radius of a true pentagram star is R * 0.381966.
function starPts(cx, cy, R) {
  const r = R * 0.381966;
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? R : r;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return pts;
}
const star = (cx, cy, R) => poly(starPts(cx, cy, R));

// A stroke: the set of points within w/2 of a polyline (round caps and joins).
function stroke(pts, w) {
  const hw = w * 0.5;
  const h2 = hw * hw;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of pts) {
    x0 = Math.min(x0, px - hw); y0 = Math.min(y0, py - hw);
    x1 = Math.max(x1, px + hw); y1 = Math.max(y1, py + hw);
  }
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      // cheap reject on the segment's own box
      if ((x < ax - hw && x < bx - hw) || (x > ax + hw && x > bx + hw)
        || (y < ay - hw && y < by - hw) || (y > ay + hw && y > by + hw)) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const L = dx * dx + dy * dy;
      let t = L > 0 ? ((x - ax) * dx + (y - ay) * dy) / L : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + dx * t - x;
      const ey = ay + dy * t - y;
      if (ex * ex + ey * ey <= h2) return true;
    }
    return false;
  };
}
// arc centreline from angle a0 to a1 (radians, either direction), as points
function arc(cx, cy, rx, ry, a0, a1, n = 24) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}
const D = Math.PI / 180;

// ---------------------------------------------------------------------------
// the glyphs: painted bottom layer first, the last layer that covers a point
// wins. `box` is the glyph's extent in its own units, mapped onto its cell.
// ---------------------------------------------------------------------------

// US star-and-bar, from September 1943: an insignia-blue disc of radius R with
// a white star whose points touch it, white bars one radius long and half a
// radius deep each side with their top edges in line with the star's
// horizontal points, and the whole outlined in insignia blue R/8 wide.
function starAndBar() {
  const R = 1;
  const b = R / 8;
  const top = R * Math.sin(18 * D);           // the horizontal points' tips
  const barY0 = top - R * 0.5;
  const barX = 2 * R;
  const bars = rect(-barX, barY0, barX, top);
  const outline = any(disc(0, 0, R + b), rect(-barX - b, barY0 - b, barX + b, top + b));
  return {
    box: [-barX - b * 1.6, -R - b * 1.6, barX + b * 1.6, R + b * 1.6],
    layers: [
      [outline, P.usBlue],
      [bars, P.white],
      [disc(0, 0, R), P.usBlue],
      [star(0, 0, R), P.white],
    ],
  };
}

const GLYPHS = {
  us_star_bar: starAndBar,
  // 1942-43: the white star in a blue disc, no bars
  us_star: () => ({
    box: [-1.06, -1.06, 1.06, 1.06],
    layers: [[disc(0, 0, 1), P.usBlue], [star(0, 0, 0.995), P.white]],
  }),
  // the plain white star on US ground vehicles
  us_star_white: () => ({
    box: [-1.06, -1.06, 1.06, 1.06],
    layers: [[star(0, 0, 1), P.white]],
  }),
  // RAF type B (upper wings, 1941-42): blue ring, red centre, 2:5
  raf_b: () => ({
    box: [-1.06, -1.06, 1.06, 1.06],
    layers: [[disc(0, 0, 1), P.rafBlue], [disc(0, 0, 0.4), P.rafRed]],
  }),
  // RAF type A.1 (fuselage): yellow, blue, white, red at 7:5:3:1
  raf_a1: () => ({
    box: [-1.06, -1.06, 1.06, 1.06],
    layers: [
      [disc(0, 0, 1), P.rafYellow],
      [disc(0, 0, 5 / 7), P.rafBlue],
      [disc(0, 0, 3 / 7), P.white],
      [disc(0, 0, 1 / 7), P.rafRed],
    ],
  }),
  // 1940-42 fin flash, 24 in wide x 27 in high, three equal stripes. Image
  // LEFT is the leading edge (red), which is how the shader maps it on both
  // sides of the fin.
  raf_fin: () => ({
    box: [-0.04, -0.045, 3.04, 3.42],
    layers: [
      [rect(0, 0, 1, 3.375), P.rafRed],
      [rect(1, 0, 2, 3.375), P.white],
      [rect(2, 0, 3, 3.375), P.rafBlue],
    ],
  }),
  // The Balkenkreuz: a black cross with white flanks along every arm, the
  // arm ends flush. Arm width 1, white flank 0.45, overall 6.
  de_balkenkreuz: () => ({
    box: [-3.12, -3.12, 3.12, 3.12],
    layers: [
      [any(rect(-0.95, -3, 0.95, 3), rect(-3, -0.95, 3, 0.95)), P.white],
      [any(rect(-0.5, -3, 0.5, 3), rect(-3, -0.5, 3, 0.5)), P.deBlack],
    ],
  }),
  // the plain red hinomaru of the 1941-42 grey-green Zero
  jp_hinomaru: () => ({
    box: [-1.06, -1.06, 1.06, 1.06],
    layers: [[disc(0, 0, 1), P.jpRed]],
  }),
  // the Soviet red star with a thin white outline
  su_star: () => ({
    box: [-1.06, -1.06, 1.06, 1.06],
    layers: [[star(0, 0, 1), P.white], [star(0, -0.012, 0.86), P.suRed]],
  }),
  solid: () => ({
    box: [0, 0, 1, 1],
    layers: [[rect(-1, -1, 2, 2), P.white]],
  }),
};

// Stencil numerals (art bible H-02 allows stencil lettering on vehicles
// only): strokes 0.9 wide on a 4 x 6 body, each glyph broken by the bridges a
// cut stencil needs to hold its counters in.
const SW = 0.9;
const bridgeV = (x, y, h = 0.42) => rect(x - 0.17, y - h, x + 0.17, y + h);
const bridgeH = (x, y, w = 0.42) => rect(x - w, y - 0.17, x + w, y + 0.17);
const DIGITS = {
  0: minus(stroke(arc(2, 3, 1.5, 2.45, 0, 2 * Math.PI, 40), SW), any(bridgeV(2, 5.45), bridgeV(2, 0.55))),
  1: any(stroke([[2.35, 0.3], [2.35, 5.7]], SW), stroke([[2.35, 5.7], [1.05, 4.75]], SW)),
  2: any(
    stroke(arc(2, 4.25, 1.4, 1.35, 165 * D, -35 * D, 22), SW),
    stroke([[3.15, 3.45], [0.65, 0.55]], SW),
    stroke([[0.65, 0.5], [3.45, 0.5]], SW),
  ),
  3: minus(any(
    stroke(arc(2, 4.45, 1.3, 1.15, 155 * D, -90 * D, 22), SW),
    stroke(arc(2, 1.62, 1.42, 1.2, 90 * D, -155 * D, 22), SW),
  ), bridgeH(1.5, 3.3, 0.38)),
  4: minus(any(
    stroke([[2.75, 5.7], [0.55, 1.9]], SW),
    stroke([[0.55, 1.9], [3.6, 1.9]], SW),
    stroke([[2.75, 4.6], [2.75, 0.3]], SW),
  ), bridgeV(2.75, 2.65, 0.3)),
  5: any(
    stroke([[3.4, 5.6], [1.0, 5.6], [0.85, 3.45]], SW),
    stroke(arc(2, 1.85, 1.5, 1.55, 125 * D, -150 * D, 24), SW),
  ),
  6: minus(any(
    stroke([[3.05, 5.55], [1.75, 5.45], [0.95, 4.55], [0.6, 3.1], [0.6, 1.8]], SW),
    stroke(arc(2, 1.75, 1.42, 1.4, 0, 2 * Math.PI, 36), SW),
  ), bridgeH(2.0, 3.15, 0.25)),
  7: any(stroke([[0.5, 5.6], [3.5, 5.6]], SW), stroke([[3.5, 5.6], [1.45, 0.3]], SW)),
  8: minus(any(
    stroke(arc(2, 4.45, 1.25, 1.1, 0, 2 * Math.PI, 32), SW),
    stroke(arc(2, 1.65, 1.45, 1.3, 0, 2 * Math.PI, 32), SW),
  ), any(bridgeH(0.75, 4.45, 0.3), bridgeH(3.25, 4.45, 0.3), bridgeH(0.55, 1.65, 0.3), bridgeH(3.45, 1.65, 0.3))),
  9: null, // the 6 turned through 180 degrees, below
};
DIGITS[9] = (x, y) => DIGITS[6](4 - x, 6 - y);
for (let d = 0; d <= 9; d++) {
  const f = DIGITS[d];
  GLYPHS[`digit_${d}`] = () => ({ box: [-0.25, -0.2, 4.25, 6.2], layers: [[f, P.white]] });
}

// ---------------------------------------------------------------------------
// layout: [name, x, y, w, h] in pixels, y from the BOTTOM row
// ---------------------------------------------------------------------------
// a cell `h` pixels tall with the width its glyph's box asks for
function widthFor(name, h) {
  const [x0, y0, x1, y1] = GLYPHS[name]().box;
  return Math.round(h * ((x1 - x0) / (y1 - y0)));
}
function layout() {
  const cells = [];
  const sbH = 208;
  const sbW = widthFor('us_star_bar', sbH);
  cells.push(['us_star_bar', 0, H - sbH, sbW, sbH]);
  const sq = 196;
  let x = sbW + 6;
  for (const n of ['us_star', 'raf_b', 'raf_a1']) {
    cells.push([n, x, H - sq, sq, sq]);
    x += sq + 6;
  }
  x = 0;
  const y2 = H - sbH - 6 - sq;
  for (const n of ['de_balkenkreuz', 'jp_hinomaru', 'su_star', 'us_star_white']) {
    cells.push([n, x, y2, sq, sq]);
    x += sq + 6;
  }
  const finW = widthFor('raf_fin', sq);
  cells.push(['raf_fin', x, y2, finW, sq]);
  x += finW + 6;
  cells.push(['solid', x, y2 + sq - 32, 32, 32]);
  const dh = y2 - 6 - 4;
  const dw = widthFor('digit_0', dh);
  for (let d = 0; d <= 9; d++) cells.push([`digit_${d}`, 4 + d * (dw + 6), 4, dw, dh]);
  for (const [n, cx, cy, cw, ch] of cells) {
    if (cx < 0 || cy < 0 || cx + cw > W || cy + ch > H) throw new Error(`insignia atlas: ${n} overflows`);
  }
  return cells;
}

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i / 255);

// The atlas is painted once, synchronously, on the first marked build (the
// first hangar view), so it is written to be cheap: each pixel corner is
// evaluated once and shared by the four pixels around it, a layer test runs
// top-down and stops at the first hit, and the edge bleed only visits the
// fringe it grows. The bytes are identical to the plain per-pixel version.
// the glyph rectangles, from the layout alone (the same numbers paintAtlas
// derives while it paints)
function rectsOf() {
  const rects = {};
  for (const [name, x0, y0, w, h] of layout()) {
    rects[name] = {
      u0: x0 / W, v0: y0 / H, u1: (x0 + w) / W, v1: (y0 + h) / H,
      aspect: h / w, px: [x0, y0, w, h],
    };
  }
  return rects;
}

function paintAtlas() {
  const data = new Uint8Array(W * H * 4);
  const rects = {};
  const sub = [0.125, 0.375, 0.625, 0.875];
  for (const [name, x0, y0, w, h] of layout()) {
    const g = GLYPHS[name]();
    const [bx0, by0, bx1, by1] = g.box;
    const fs = g.layers.map(([f]) => f);
    const cols = g.layers.map(([, hex]) => rgbOf(hex));
    // the bytes of a texel wholly inside one layer
    const bytes = cols.map((c) => c.map((v) => Math.round(linearToSrgb(v) * 255)));
    const top = fs.length - 1;
    const sx = (bx1 - bx0) / w;
    const sy = (by1 - by0) / h;
    // the index of the last layer covering (px, py) in cell pixels, or -1
    const at = (px, py) => {
      const gx = bx0 + px * sx;
      const gy = by0 + py * sy;
      for (let k = top; k >= 0; k--) if (fs[k](gx, gy)) return k;
      return -1;
    };
    // the shared corner lattice, (w + 1) x (h + 1)
    const cw = w + 1;
    const corner = new Int8Array(cw * (h + 1));
    for (let py = 0; py <= h; py++) for (let px = 0; px <= w; px++) corner[py * cw + px] = at(px, py);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        // adaptive: the centre and four corners agreeing means no edge here
        const c0 = at(px + 0.5, py + 0.5);
        const q = py * cw + px;
        const i = ((y0 + py) * W + (x0 + px)) * 4;
        if (corner[q] === c0 && corner[q + 1] === c0 && corner[q + cw] === c0 && corner[q + cw + 1] === c0) {
          if (c0 >= 0) {
            const by = bytes[c0];
            data[i] = by[0];
            data[i + 1] = by[1];
            data[i + 2] = by[2];
            data[i + 3] = 255;
          } else {
            // linearToSrgb(0) is 0: an empty texel stays all zeros
          }
        } else {
          let r = 0;
          let gg = 0;
          let b = 0;
          let a = 0;
          for (const ty of sub) {
            for (const tx of sub) {
              const k = at(px + tx, py + ty);
              if (k < 0) continue;
              const c = cols[k];
              r += c[0];
              gg += c[1];
              b += c[2];
              a += 1;
            }
          }
          if (a > 0) {
            r /= a;
            gg /= a;
            b /= a;
          }
          a /= 16;
          data[i] = Math.round(linearToSrgb(r) * 255);
          data[i + 1] = Math.round(linearToSrgb(gg) * 255);
          data[i + 2] = Math.round(linearToSrgb(b) * 255);
          data[i + 3] = Math.round(a * 255);
        }
      }
    }
    rects[name] = {
      u0: x0 / W, v0: y0 / H, u1: (x0 + w) / W, v1: (y0 + h) / H,
      aspect: h / w, px: [x0, y0, w, h],
    };
  }
  // Bleed each glyph's edge colour into its transparent texels, so linear
  // filtering and the mip chain never pull black into a fringe. Four passes,
  // each giving an empty interior texel the colour of its first filled
  // neighbour (in the order below) as the pass found them. Only a texel next
  // to one filled in the previous pass can change in the next, so after one
  // full scan each pass visits just the fringe it grew.
  const filled = new Uint8Array(W * H);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    filled[p] = data[i + 3] > 0 || (data[i] | data[i + 1] | data[i + 2]) !== 0 ? 1 : 0;
  }
  const NB = [1, -1, W, -W, W + 1, -W - 1, -W + 1, W - 1];
  const interior = (p) => {
    const x = p % W;
    const y = (p - x) / W;
    return x >= 1 && x < W - 1 && y >= 1 && y < H - 1;
  };
  // the first pass scans every interior texel (cand null), later ones the fringe
  let cand = null;
  const bleed = (p, grew) => {
    for (let k = 0; k < 8; k++) {
      const q = p + NB[k];
      if (filled[q] !== 1) continue;
      const i = p * 4;
      const j = q * 4;
      data[i] = data[j];
      data[i + 1] = data[j + 1];
      data[i + 2] = data[j + 2];
      grew.push(p);
      return;
    }
  };
  for (let pass = 0; pass < 4; pass++) {
    const grew = [];
    if (!cand) {
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1, p = y * W + 1; x < W - 1; x++, p++) if (!filled[p]) bleed(p, grew);
      }
    } else {
      for (const p of cand) if (!filled[p]) bleed(p, grew);
    }
    // A texel bled in this pass counts as filled from the next pass on —
    // unless the colour it took was black, which the plain scan would not
    // have counted either, so it stays a candidate.
    const next = [];
    const lit = [];
    for (const p of grew) {
      const i = p * 4;
      if ((data[i] | data[i + 1] | data[i + 2]) !== 0) {
        if (!filled[p]) lit.push(p);
        filled[p] = 1;
      } else {
        next.push(p);
      }
    }
    for (const p of lit) {
      for (let k = 0; k < 8; k++) {
        const q = p + NB[k];
        if (!filled[q] && interior(q)) next.push(q);
      }
    }
    cand = next;
  }
  return { data, rects };
}

// P-04: the painted bytes are kept in localStorage between sessions, run-
// length coded (~150 kB as base64 instead of 2 MB), under a signature of the
// glyph and layout code, so only the first session ever pays the ~0.6 s
// paint; every later one decodes it in a few milliseconds. Anything that
// does not decode to exactly W x H texels under the same signature is
// repainted (and the copy replaced). Storage that refuses (private mode, a
// full quota) just means painting every session, as before.
const ATLAS_KEY = 'steelSkies.insigniaAtlas';
function atlasSignature() {
  let src = `${W}x${H}|${paintAtlas}|${layout}`;
  for (const k of Object.keys(GLYPHS)) src += `|${k}:${GLYPHS[k]}`;
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = (Math.imul(h, 33) ^ src.charCodeAt(i)) >>> 0;
  return `v1:${src.length}:${h.toString(36)}`;
}
function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
function encodeAtlas(data) {
  const px = new Uint32Array(data.buffer, data.byteOffset, W * H);
  const counts = [];
  const values = [];
  for (let i = 0; i < px.length;) {
    let j = i + 1;
    while (j < px.length && px[j] === px[i] && j - i < 65535) j++;
    counts.push(j - i);
    values.push(px[i]);
    i = j;
  }
  const n = counts.length;
  const buf = new Uint8Array(4 + n * 6);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, n, true);
  for (let k = 0; k < n; k++) {
    dv.setUint16(4 + k * 2, counts[k], true);
    dv.setUint32(4 + n * 2 + k * 4, values[k], true);
  }
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
function decodeAtlas(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  if (buf.length < 4) return null;
  const dv = new DataView(buf.buffer);
  const n = dv.getUint32(0, true);
  if (buf.length !== 4 + n * 6) return null;
  const data = new Uint8Array(W * H * 4);
  const px = new Uint32Array(data.buffer);
  let at = 0;
  for (let k = 0; k < n; k++) {
    const c = dv.getUint16(4 + k * 2, true);
    if (at + c > px.length) return null;
    px.fill(dv.getUint32(4 + n * 2 + k * 4, true), at, at + c);
    at += c;
  }
  return at === px.length ? data : null;
}
function cachedAtlas() {
  const st = storage();
  if (!st || typeof atob !== 'function') return null;
  try {
    const raw = st.getItem(ATLAS_KEY);
    if (!raw) return null;
    const cut = raw.indexOf('|');
    if (cut < 0 || raw.slice(0, cut) !== atlasSignature()) return null;
    return decodeAtlas(raw.slice(cut + 1));
  } catch {
    return null;
  }
}
function storeAtlas(data) {
  const st = storage();
  if (!st || typeof btoa !== 'function') return;
  try {
    st.setItem(ATLAS_KEY, `${atlasSignature()}|${encodeAtlas(data)}`);
  } catch {
    /* quota or blocked storage: paint again next session */
  }
}

let atlas = null;
export function insigniaAtlas() {
  if (atlas) return atlas;
  let data = cachedAtlas();
  const rects = rectsOf();
  if (!data) {
    data = paintAtlas().data;
    storeAtlas(data);
  }
  const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.name = 'insignia atlas';
  texture.needsUpdate = true;
  markShared(texture);
  atlas = {
    texture,
    width: W,
    height: H,
    data,
    names: Object.keys(rects),
    rect(name) {
      return rects[name] || null;
    },
  };
  return atlas;
}

// CPU read-back of the atlas at (u, v) of one glyph's own cell (0..1 each),
// nearest texel: sRGB bytes + alpha. For tests and the CPU twins.
export function insigniaTexel(name, u, v) {
  const a = insigniaAtlas();
  const r = a.rect(name);
  if (!r) return null;
  const [x0, y0, w, h] = r.px;
  const x = Math.min(w - 1, Math.max(0, Math.floor(u * w))) + x0;
  const y = Math.min(h - 1, Math.max(0, Math.floor(v * h))) + y0;
  const i = (y * W + x) * 4;
  return [a.data[i], a.data[i + 1], a.data[i + 2], a.data[i + 3]];
}
