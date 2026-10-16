import * as THREE from 'three';
import { markShared } from '../core/materials.js';
import { HEIGHT_FOG_GLSL, heightFogVeil } from '../core/atmosphere.js';

// S-02: the volumetric cloud slab of the air battles (realism backlog 3.6).
//
// WHAT IT IS
// The S-01 deck (world/scenery.js addClouds) is one alpha-blended plane: right
// from far away, flat the moment an aeroplane climbs to it. On the high tier an
// air battle's sky is instead a SLAB of real volume, ray-marched by the post
// chain (core/postfx.js, the 'clouds' pass) at reduced resolution against the
// frame's depth (P-02) and composited before bloom and tone mapping. The deck
// is hidden while the pass runs and comes back on medium and low, or the
// moment the pass cannot run (S-01 is the fallback on every tier).
//
// ONE FIELD, TWO RENDERERS
// Where the clouds are is S-01's own canvas field (cloudFieldData, the tile
// scenery.js makeCloudTexture uploads), read with S-01's two drifting octaves
// and S-01's cover law, so a tier switch keeps every cloud where it was. The
// slab only adds what a plane cannot have:
//   * columns: the field's "thickness proxy" (S-01 th) sets how tall a column
//     stands, 35-100 % of the slab, flat-based, round-topped;
//   * a 64^3 RG8 Worley-fbm volume (generated once per session, ~150 ms,
//     stamped shared) erodes the edges into billows (R) and wisps (G).
//
// THE ALTITUDE BAND (the slab must be flyable, not decorative)
// Every aeroplane is held under y = 1,000 m (planeEntity) and the AI under
// 640 m (planeAI CEILING); the terrain is within +/-30 m of zero. The slab
// therefore straddles the S-01 deck height h: top = min(h + 80, 940) m, base =
// max(h - 230, 640) m. Midday 640-930 m, dawn 670-940, dusk 650-940, the grey
// day a 140 m stratus layer 640-780. The player can fly under the bases, into
// the towers and 60 m over the highest tops; the AI's band stays clear (it
// does not yet see clouds: cloudOpticalDepth below is the API for that).
//
// LIGHT (contract R1-K, in the deck's units: sunLin = E_sun / pi)
//   J = sunLin . ( K_ms . exp(-k_ms tau_sun) . powder
//                + pi . K_ss . HG(cos, 0.75) . exp(-tau_sun) )
//     + K_amb . mix(ambBase, ambTop, height share)
// tau_sun is a two-step light march toward the sun across the column above
// the sample. The first term is the multiply-scattered light (a soft,
// sun-facing "Lambert" response, ms extinction share 0.25), the second the
// single-scattered forward lobe (the silver lining), the last the sky from
// above / the ground bounce from below. K_ms is calibrated so a thick top seen
// from above matches the S-01 deck's top (t_clouds.mjs). Integrated with the
// energy-conserving step S += T.J.(1 - exp(-sigma.dt)) (Hillaire 2016).
// Extinction CLOUD_SIGMA = 0.08 / m at density 1: the densest 300 m chord
// through a meadow-noon core passes ~1e-6 (t_clouds.mjs; accept <= 5 %).
//
// The post chain jitters each ray's first step (interleaved gradient noise)
// and resolves the dither with a 3x3 depth-aware tent at the march
// resolution (core/postfx.js CLOUD_DENOISE_FS) before the upsample.
//
// GLSL and the JS mirror (cloudDensityAt, marchCloudCPU) are kept line for
// line in step; t_clouds.mjs checks the S-02 acceptance numbers on the mirror.

export const CLOUD_FIELD_PERIOD = 2600;   // m: the S-01 field tile (scenery deckDensity)
export const CLOUD_FIELD_SIZE = 256;
export const CLOUD_NOISE_SIZE = 64;       // voxels per side of the erosion volume
export const CLOUD_NOISE_PERIOD = 900;    // m per noise tile
export const CLOUD_SIGMA = 0.08;          // extinction at density 1 (1 / m)
export const SLAB_TOP_MAX = 940;          // m, 60 m under the 1,000 m ceiling
export const SLAB_BASE_MIN = 640;         // m, the AI ceiling
export const CLOUD_STEPS = 16;            // coarse steps per ray (x4 finer inside cloud)
export const CLOUD_ITER = 44;             // loop budget: 16 coarse + refinement
// inside cloud: 1.2 % of the distance, 3-40 m (10 m at 800 m). One coarse
// step through a core is optically opaque, so marching it coarse would slice
// every cloud surface into contour bands along the ray.
export const CLOUD_FINE_REL = 0.012;
// the sun path a sample is never credited less than: its column overhead at
// this mean density (under a high sun; the two light taps can leave a
// rounded top early and light a base as if it had no cloud over it)
export const CLOUD_COLUMN_K = 0.3;
export const CLOUD_FINE_MIN = 3;
export const CLOUD_FINE_MAX = 40;
export const CLOUD_FAR = 7000;            // m horizontal: the fog's far fade ends here
export const CLOUD_MAX_PIXELS = 300000;   // march target cap (half res up to ~1.2 MP)
// K_ms, K_ss, K_amb, ms extinction share (calibrated in t_clouds.mjs)
// (K_ms 0.75: a thick top seen from above at meadow-noon-clear = 1.03 x the
// S-01 deck's top; bases from below 2.8x darker than tops)
export const CLOUD_LIGHT_K = Object.freeze([0.75, 0.3, 0.82, 0.35]);

const NOISE_RATE = 0.0025;                 // noise tiles per second of vertical churn

// ---------------------------------------------------------------------------
// The S-01 field: tiling 5-octave value-noise fbm. scenery.js makeCloudTexture
// uploads exactly these bytes (its canvas wrote them before this file existed).
const fieldCache = new Map();
export function cloudFieldData(size = CLOUD_FIELD_SIZE) {
  const hit = fieldCache.get(size);
  if (hit) return hit;
  const out = new Uint8ClampedArray(size * size);
  const h = (x, y) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const lerp = (a, b, k) => a + (b - a) * k;
  const fade = (k) => k * k * (3 - 2 * k);
  // period-locked value noise, so the sheet tiles without a seam
  const noise = (x, y, per) => {
    const xi = Math.floor(x); const yi = Math.floor(y);
    const xf = fade(x - xi); const yf = fade(y - yi);
    const w = (a, b) => h(((a % per) + per) % per, ((b % per) + per) % per);
    return lerp(lerp(w(xi, yi), w(xi + 1, yi), xf),
      lerp(w(xi, yi + 1), w(xi + 1, yi + 1), xf), yf);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0; let amp = 0.5; let f = 4; let norm = 0;
      for (let o = 0; o < 5; o++) {
        sum += amp * noise((x / size) * f, (y / size) * f, f);
        norm += amp;
        amp *= 0.5;
        f *= 2;
      }
      out[y * size + x] = Math.max(0, Math.min(1, sum / norm)) * 255;
    }
  }
  fieldCache.set(size, out);
  return out;
}

// ---------------------------------------------------------------------------
// THE COVER LAW. S-01 reads its field as d = 0.65 a + 0.35 b (two octaves of
// the tile) and draws cloud where d > 1 - cover, over a soft edge of 0.28 and
// a thickness ramp of 0.32. But the normalised 5-octave fbm is not spread over
// 0..1: d lies in ~0.2-0.75 (p50 0.52), so that law put 0 % of a clear noon
// sky (cover 0.22) under cloud, 0.7 % of dawn's and 2 % of dusk's - the clear
// presets had no deck at all, only cirrus. The fraction law reads `cover` as
// what it was authored as, the share of the sky under cloud:
//   wl    = Q(1 - cover)             the quantile of d (sampled once)
//   thick = max(0.03, Q(0.998) - wl) d above wl at which a column is full height
//   edge  = 0.45 thick               the soft rim
// The air battles use it for the slab AND their S-01 deck (cloudVolumeFor
// writes it into the deck's uniforms); ground battles keep the legacy law.
let dQuantiles = null;
function fieldQuantiles() {
  if (dQuantiles) return dQuantiles;
  const fd = cloudFieldData();
  const fs = Math.round(Math.sqrt(fd.length));
  const n = 256;
  const arr = new Float32Array(n * n);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const v = (j + 0.5) / n;
      arr[k++] = 0.65 * fieldTap(fd, fs, u, v) + 0.35 * fieldTap(fd, fs, u * 2.17 + 0.31, v * 2.17 + 0.57);
    }
  }
  arr.sort();
  dQuantiles = arr;
  return arr;
}
function quantile(q) {
  const a = fieldQuantiles();
  const x = Math.min(1, Math.max(0, q)) * (a.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  return i + 1 < a.length ? a[i] + (a[i + 1] - a[i]) * f : a[i];
}
export function cloudCoverLaw(cover, legacy = false) {
  const c = Math.min(0.995, Math.max(0, Number(cover) || 0));
  if (legacy) return { wl: 1 - c, edge: 0.28, thick: 0.32 };
  const wl = quantile(1 - c);
  const thick = Math.max(0.03, quantile(0.998) - wl);
  return { wl, edge: 0.45 * thick, thick };
}
// the share of the field above a water line (the law's own check)
export function cloudCoverShare(wl) {
  const a = fieldQuantiles();
  let lo = 0; let hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= wl) lo = m + 1; else hi = m; }
  return 1 - lo / a.length;
}

// ---------------------------------------------------------------------------
// The erosion volume: periodic Worley F1 at 4, 8 and 16 cells per tile.
//   R = 0.625 (1-W4) + 0.25 (1-W8) + 0.125 (1-W16)   billows
//   G = 0.625 (1-W8) + 0.375 (1-W16)                  wisps
// each remapped to its own 0..1 range.
function mulberry32(a) {
  let s = a >>> 0;
  return function rnd() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function worleyF1(N, cells, seed) {
  const rnd = mulberry32(seed);
  const C = cells;
  const n3 = C * C * C;
  const fx = new Float32Array(n3);
  const fy = new Float32Array(n3);
  const fz = new Float32Array(n3);
  for (let i = 0; i < n3; i++) { fx[i] = rnd(); fy[i] = rnd(); fz[i] = rnd(); }
  const s = C / N;
  // per axis: the cell of each voxel and its three wrapped neighbours
  const cellOf = new Int32Array(N);
  const pos = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos[i] = (i + 0.5) * s; cellOf[i] = Math.floor(pos[i]); }
  const wrap = (c) => ((c % C) + C) % C;
  const out = new Float32Array(N * N * N);
  let o = 0;
  for (let z = 0; z < N; z++) {
    const pz = pos[z]; const cz = cellOf[z];
    for (let y = 0; y < N; y++) {
      const py = pos[y]; const cy = cellOf[y];
      for (let x = 0; x < N; x++) {
        const px = pos[x]; const cx = cellOf[x];
        let best = 1e9;
        for (let dz = -1; dz <= 1; dz++) {
          const zz = cz + dz; const wz = wrap(zz) * C;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = cy + dy; const wy = (wz + wrap(yy)) * C;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = cx + dx;
              const idx = wy + wrap(xx);
              const qx = xx + fx[idx] - px;
              const qy = yy + fy[idx] - py;
              const qz = zz + fz[idx] - pz;
              const d2 = qx * qx + qy * qy + qz * qz;
              if (d2 < best) best = d2;
            }
          }
        }
        out[o++] = Math.sqrt(best);
      }
    }
  }
  return out;
}

let noiseCache = null;
// { data: Uint8Array (RG, x fastest), size, texture (Data3DTexture, shared), ms }
export function cloudNoise(size = CLOUD_NOISE_SIZE) {
  if (noiseCache && noiseCache.size === size) return noiseCache;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const w4 = worleyF1(size, 4, 0x51a7e);
  const w8 = worleyF1(size, 8, 0x0c10d);
  const w16 = worleyF1(size, 16, 0x7e57a);
  const n = size * size * size;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  let rMin = 1e9; let rMax = -1e9; let gMin = 1e9; let gMax = -1e9;
  for (let i = 0; i < n; i++) {
    const a = 0.625 * (1 - w4[i]) + 0.25 * (1 - w8[i]) + 0.125 * (1 - w16[i]);
    const b = 0.625 * (1 - w8[i]) + 0.375 * (1 - w16[i]);
    r[i] = a; g[i] = b;
    if (a < rMin) rMin = a; if (a > rMax) rMax = a;
    if (b < gMin) gMin = b; if (b > gMax) gMax = b;
  }
  const data = new Uint8Array(n * 2);
  const rs = 255 / Math.max(1e-6, rMax - rMin);
  const gs = 255 / Math.max(1e-6, gMax - gMin);
  for (let i = 0; i < n; i++) {
    data[i * 2] = Math.round((r[i] - rMin) * rs);
    data[i * 2 + 1] = Math.round((g[i] - gMin) * gs);
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  markShared(tex);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  noiseCache = { data, size, texture: tex, ms: t1 - t0 };
  return noiseCache;
}

export function cloudNoiseReady() {
  return !!noiseCache;
}

// ---------------------------------------------------------------------------
// The slab for a composed preset (null: no deck, so no slab).
export function cloudSlabFor(preset) {
  const c = preset && preset.cloud;
  if (!c || !(c.cover > 0.02)) return null;
  const h = Number.isFinite(c.height) ? c.height : 900;
  const top = Math.min(h + 80, SLAB_TOP_MAX);
  const base = Math.min(Math.max(h - 230, SLAB_BASE_MIN), top - 120);
  return Object.freeze({ base, top, deck: h, cover: c.cover });
}

// The descriptor world/scenery.js hangs on scene.userData.cloudVolume for an
// air battle; core/postfx.js reads it every frame. Time, wind and cover are
// S-01's own uniform objects (ctx.uniforms = the deck's), so both drift as one.
//   ctx = { deck, field (the deck's CanvasTexture), uniforms }
export function cloudVolumeFor(preset, ctx = {}) {
  const slab = cloudSlabFor(preset);
  if (!slab) return null;
  const L = preset.light || null;
  const sunLin = L ? L.sunLin.slice() : [0.8, 0.76, 0.7];
  const ambLin = L ? L.ambLin.slice() : [0.12, 0.14, 0.17];
  const groundLin = L && L.groundLin ? L.groundLin.slice() : ambLin.map((c) => c * 0.3);
  const gLum = 0.2126 * groundLin[0] + 0.7152 * groundLin[1] + 0.0722 * groundLin[2];
  const sd = preset.sunDir || { x: 0.5346, y: 0.8018, z: 0.2673 };
  const sl = Math.hypot(sd.x, sd.y, sd.z) || 1;
  const hz = preset.horizonRGB || [0.62, 0.7, 0.8];
  const u = ctx.uniforms || {};
  // the fraction law, into the deck as well, so medium/low draw the same sky
  const law = cloudCoverLaw(slab.cover);
  if (u.uWaterLine) u.uWaterLine.value = law.wl;
  if (u.uEdge) u.uEdge.value = law.edge;
  if (u.uThick) u.uThick.value = law.thick;
  const vol = {
    kind: 'S-02',
    slab,
    law,
    deck: ctx.deck || null,
    field: ctx.field || null,
    fieldData: cloudFieldData(),
    timeU: u.uTime || { value: 0 },
    windU: u.uWind || { value: new THREE.Vector2(0.004, 0) },
    sigma: CLOUD_SIGMA,
    sunDir: [sd.x / sl, sd.y / sl, sd.z / sl],
    sunLin,
    // the sky over a top; under a base half the sky the S-01 deck gives its
    // bases plus a quarter of the (greyed) ground bounce: the column over a
    // base hides most of the dome, the ground it sees is grass-dark
    // (lum(groundLin) ~ lum(ambLin) at noon, so a full bounce would light a
    // base as brightly as the sky lights a top)
    ambTop: ambLin,
    ambBase: [0, 1, 2].map((i) => 0.5 * ambLin[i] + 0.25 * (0.6 * gLum + 0.4 * groundLin[i])),
    lightK: CLOUD_LIGHT_K.slice(),
    fogColor: [hz[0], hz[1], hz[2]],
    fogSigma: 3.912 / Math.max(1, L ? L.visibility : 10000),
    fogInvH: 1 / Math.max(1, L ? L.fogScaleHeight : 1200),
    noise: null,
    ensureNoise() {
      if (!this.noise) this.noise = cloudNoise();
      return this.noise;
    },
  };
  return vol;
}

// The field and noise offsets at the volume's current time (uv / uvw units).
export function cloudDrift(vol, out = {}) {
  const t = vol.timeU.value || 0;
  const w = vol.windU.value;
  const wx = w ? w.x : 0;
  const wz = w ? w.y : 0;
  out.fx = wx * t;
  out.fz = wz * t;
  const k = CLOUD_FIELD_PERIOD / CLOUD_NOISE_PERIOD;
  out.nx = (out.fx * k) % 1;
  out.ny = (t * NOISE_RATE) % 1;
  out.nz = (out.fz * k) % 1;
  return out;
}

// The volume a battle has published (scenery.js), for gameplay queries.
let activeVolume = null;
export function setActiveCloudVolume(vol) {
  activeVolume = vol || null;
}
export function activeCloudVolume() {
  return activeVolume;
}

// ---------------------------------------------------------------------------
// GLSL. The density and light functions are shared by every caller of the
// slab; the march is one full-screen fragment program (core/postfx.js).
export const CLOUD_DENSITY_GLSL = /* glsl */`
	uniform sampler2D uField;
	uniform highp sampler3D uNoise;
	uniform vec3 uLaw;
	uniform float uBase;
	uniform float uTop;
	uniform float uSigma;
	uniform vec2 uCloudDrift;
	uniform vec3 uNoiseDrift;
	float ssCloudField( vec2 xz, float lod ) {
		vec2 uv = xz * ${(1 / CLOUD_FIELD_PERIOD).toPrecision(8)} + uCloudDrift;
		float a = textureLod( uField, uv, lod ).r;
		float b = textureLod( uField, uv * 2.17 + vec2( 0.31, 0.57 ) + uCloudDrift * 0.6, lod ).r;
		return a * 0.65 + b * 0.35;
	}
	// col.x: the height share within this column (0 at its base, 1 at its
	// top), col.y: metres from the sample up to the column top
	float ssCloudDensityH( vec3 p, float lod, out vec2 col ) {
		col = vec2( 0.0 );
		if ( p.y <= uBase || p.y >= uTop ) return 0.0;
		float d = ssCloudField( p.xz, lod );
		// uLaw = ( water line, soft edge, thickness ramp ): cloudCoverLaw()
		float m = smoothstep( uLaw.x, uLaw.x + uLaw.y, d );
		if ( m <= 0.0 ) return 0.0;
		float th = clamp( ( d - uLaw.x ) / uLaw.z, 0.0, 1.0 );
		// thin columns start higher and stop lower: no one planar base
		float colBase = uBase + ( uTop - uBase ) * 0.18 * ( 1.0 - th );
		// the top keeps rising to the field's very peak (no plateau)
		float colTop = uBase + ( uTop - uBase ) * ( 0.3 + 0.7 * clamp( ( d - uLaw.x ) / ( 1.35 * uLaw.z ), 0.0, 1.0 ) );
		float hf = ( p.y - colBase ) / ( colTop - colBase );
		col = vec2( hf, colTop - p.y );
		if ( hf <= 0.0 || hf >= 1.0 ) return 0.0;
		float shape = m * smoothstep( 0.0, 0.15, hf ) * ( 1.0 - smoothstep( 0.65, 1.0, hf ) );
		vec2 n = textureLod( uNoise, p * ${(1 / CLOUD_NOISE_PERIOD).toPrecision(8)} + uNoiseDrift, 0.0 ).rg;
		// billows: deeper toward the top (cauliflower), shallower at the base
		float e = ( 1.0 - n.r ) * mix( 0.5, 0.7, hf );
		float rho = clamp( ( shape - e ) / ( 1.0 - e ), 0.0, 1.0 );
		return clamp( rho - ( 1.0 - n.g ) * 0.25 * ( 1.0 - rho ), 0.0, 1.0 );
	}
	float ssCloudDensity( vec3 p, float lod ) {
		vec2 col;
		return ssCloudDensityH( p, lod, col );
	}
`;

export const CLOUD_LIGHT_GLSL = /* glsl */`
	uniform vec3 uSunDir;
	uniform vec3 uSunLin;
	uniform vec3 uAmbTop;
	uniform vec3 uAmbBase;
	uniform vec4 uLightK;
	float ssCloudHG( float c, float g ) {
		float g2 = g * g;
		return ( 1.0 - g2 ) / ( 12.566371 * pow( max( 1.0 + g2 - 2.0 * g * c, 1e-4 ), 1.5 ) );
	}
	float ssCloudLightTau( vec3 p ) {
		float D = clamp( ( uTop - p.y ) / max( uSunDir.y, 0.15 ), 30.0, 600.0 );
		float r = ssCloudDensity( p + uSunDir * ( 0.25 * D ), 0.0 ) + ssCloudDensity( p + uSunDir * ( 0.75 * D ), 0.0 );
		return uSigma * r * 0.5 * D;
	}
	// col: the column (ssCloudDensityH): the sky lights the
	// column's top, the ground bounce its base
	vec3 ssCloudJ( vec3 p, float rho, float cosT, vec2 col ) {
		// the march toward the sun, floored by the column overhead under a
		// high sun (two light taps can step out of a rounded top early)
		float tauL = max( ssCloudLightTau( p ), uSigma * ${CLOUD_COLUMN_K.toFixed(3)} * col.y / max( uSunDir.y, 0.15 ) * smoothstep( 0.3, 0.8, uSunDir.y ) );
		float ms = exp( - uLightK.w * tauL );
		float ss = exp( - tauL );
		float powder = 1.0 - exp( - rho * uSigma * 40.0 );
		float pw = mix( 1.0, powder, 0.3 * ( 1.0 - cosT ) );
		vec3 amb = mix( uAmbBase, uAmbTop, clamp( col.x, 0.0, 1.0 ) );
		return uSunLin * ( uLightK.x * ms * pw + 3.1415927 * uLightK.y * ssCloudHG( cosT, 0.75 ) * ss ) + uLightK.z * amb;
	}
`;

// Output: rgb = in-scattered radiance (linear, scene-referred, fogged),
// a = transmittance. tDepth is the LOW-RES min view depth (m; >= 60,000 sky).
const MARCH_VS = /* glsl */`
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = vec4( position.xy, 0.0, 1.0 );
	}
`;

const MARCH_FS = /* glsl */`
	#include <common>
	uniform sampler2D tDepth;
	uniform mat4 uInvProj;
	uniform mat4 uCamWorld;
	uniform vec3 uCamPos;
	uniform float uCamFar;
	uniform float uPixAngle;
	uniform vec3 uFogColor;
	uniform float uFogSigma;
	uniform float uFogInvH;
	varying vec2 vUv;
	${HEIGHT_FOG_GLSL}
	${CLOUD_DENSITY_GLSL}
	${CLOUD_LIGHT_GLSL}
	void main() {
		vec2 ndc = vUv * 2.0 - 1.0;
		vec4 vp = uInvProj * vec4( ndc, 1.0, 1.0 );
		vec3 rv = vp.xyz / vp.w;
		float fwd = - rv.z / length( rv );
		vec3 rd = normalize( mat3( uCamWorld ) * rv );
		float zv = texture2D( tDepth, vUv ).r;
		float tEnd = min( zv > 60000.0 ? 1e9 : zv / max( fwd, 1e-4 ), 0.98 * uCamFar / max( fwd, 1e-4 ) );
		float hz = length( rd.xz );
		if ( hz > 1e-4 ) tEnd = min( tEnd, ${CLOUD_FAR.toFixed(1)} / hz );
		float t0 = 0.0;
		float t1 = - 1.0;
		if ( abs( rd.y ) < 1e-6 ) {
			if ( uCamPos.y > uBase && uCamPos.y < uTop ) t1 = tEnd;
		} else {
			float ta = ( uBase - uCamPos.y ) / rd.y;
			float tb = ( uTop - uCamPos.y ) / rd.y;
			t0 = max( min( ta, tb ), 0.0 );
			t1 = min( max( ta, tb ), tEnd );
		}
		if ( t1 <= t0 + 0.5 ) {
			gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
			return;
		}
		float L = t1 - t0;
		// interleaved gradient noise: a blue-noise-like offset per pixel
		float j = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
		// long paths (inside the slab, toward the horizon) put their steps
		// near the camera: quadratic spacing, first step L / N^2
		float k = smoothstep( 600.0, 4000.0, L );
		float cosT = dot( rd, uSunDir );
		vec3 S = vec3( 0.0 );
		float T = 1.0;
		float tw = 0.0;
		float ws = 0.0;
		// Coarse steps (1/16 of the path, quadratic for long paths) through
		// clear air. The first sample that finds cloud bisects back toward
		// the last empty one (4 taps: the surface to 1/16 of a coarse step)
		// and the march goes on from there in fine steps (1.2 % of the
		// distance, 3-40 m) until four come back empty. One coarse step
		// through a core is optically opaque: marched coarse, a cloud surface
		// is sliced into contour bands; restarted from the coarse step's
		// start, it is found at a depth that follows the per-pixel jitter.
		float x = 0.0;
		float tc = t0;
		float tLast = t0;
		bool fine = false;
		int empty = 0;
		for ( int i = 0; i < ${CLOUD_ITER}; i ++ ) {
			float dt;
			float t;
			float x1 = x;
			if ( fine ) {
				dt = clamp( ${CLOUD_FINE_REL.toFixed(4)} * tc, ${CLOUD_FINE_MIN.toFixed(1)}, ${CLOUD_FINE_MAX.toFixed(1)} );
				t = tc + dt * j;
				if ( t >= t1 ) break;
			} else {
				float xm = x + j * ${(1 / CLOUD_STEPS).toPrecision(8)};
				if ( xm >= 1.0 ) break;
				x1 = min( x + ${(1 / CLOUD_STEPS).toPrecision(8)}, 1.0 );
				dt = t0 + L * mix( x1, x1 * x1, k ) - tc;
				t = t0 + L * mix( xm, xm * xm, k );
			}
			vec3 p = uCamPos + rd * t;
			float lod = max( 0.0, log2( max( t * uPixAngle, 1e-3 ) * ${(CLOUD_FIELD_SIZE / CLOUD_FIELD_PERIOD).toPrecision(8)} ) );
			vec2 col;
			float rho = ssCloudDensityH( p, lod, col );
			if ( rho > 0.002 ) {
				if ( ! fine ) {
					float lo = tLast;
					float hi = t;
					for ( int b = 0; b < 4; b ++ ) {
						float mid = 0.5 * ( lo + hi );
						vec2 cb;
						if ( ssCloudDensityH( uCamPos + rd * mid, lod, cb ) > 0.002 ) hi = mid;
						else lo = mid;
					}
					tc = lo;
					fine = true;
					empty = 0;
					continue;
				}
				empty = 0;
				float a = exp( - uSigma * rho * dt );
				float w = T * ( 1.0 - a );
				S += ssCloudJ( p, rho, cosT, col ) * w;
				tw += t * w;
				ws += w;
				T *= a;
				if ( T < 0.01 ) break;
			} else {
				tLast = t;
				if ( fine ) {
					empty ++;
					if ( empty >= 4 ) {
						// back to the coarse grid from here on
						fine = false;
						float s = clamp( ( tc + dt - t0 ) / L, 0.0, 1.0 );
						x = k < 1e-4 ? s : ( - ( 1.0 - k ) + sqrt( ( 1.0 - k ) * ( 1.0 - k ) + 4.0 * k * s ) ) / ( 2.0 * k );
						tc += dt;
						continue;
					}
				}
			}
			tc += dt;
			x = x1;
		}
		if ( ws > 0.0 ) {
			// the world's own height fog (L-06) at the cloud's mean distance
			float tm = tw / ws;
			float v = ssFogVeil( uFogSigma, uFogInvH, uCamPos, uCamPos + rd * tm, tm * fwd, uCamFar );
			S = S * ( 1.0 - v ) + uFogColor * ( v * ( 1.0 - T ) );
		}
		gl_FragColor = vec4( S, T );
	}
`;

export function makeCloudMarchMaterial() {
  const mat = new THREE.ShaderMaterial({
    name: 'S02CloudMarch',
    uniforms: {
      tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uCamFar: { value: 8200 },
      uPixAngle: { value: 0.002 },
      uFogColor: { value: new THREE.Vector3(0.6, 0.7, 0.8) },
      uFogSigma: { value: 0.0004 },
      uFogInvH: { value: 1 / 1200 },
      uField: { value: null },
      uNoise: { value: null },
      uLaw: { value: new THREE.Vector3(0.6, 0.06, 0.14) },
      uBase: { value: 640 },
      uTop: { value: 930 },
      uSigma: { value: CLOUD_SIGMA },
      uCloudDrift: { value: new THREE.Vector2() },
      uNoiseDrift: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunLin: { value: new THREE.Vector3(1, 1, 1) },
      uAmbTop: { value: new THREE.Vector3(0.2, 0.2, 0.2) },
      uAmbBase: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
      uLightK: { value: new THREE.Vector4(...CLOUD_LIGHT_K) },
    },
    vertexShader: MARCH_VS,
    fragmentShader: MARCH_FS,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  return mat;
}

const _drift = {};
// Push one frame's state into the march material. lowH: the march target's
// height in pixels (the field's mip level follows the pixel footprint).
export function updateCloudMarch(mat, vol, camera, lowDepth, lowH) {
  const u = mat.uniforms;
  const noise = vol.ensureNoise();
  u.tDepth.value = lowDepth;
  u.uInvProj.value.copy(camera.projectionMatrixInverse);
  u.uCamWorld.value.copy(camera.matrixWorld);
  u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
  u.uCamFar.value = camera.far;
  const fov = camera.isPerspectiveCamera ? (camera.fov * Math.PI) / 180 / Math.max(1e-3, camera.zoom || 1) : 1;
  u.uPixAngle.value = fov / Math.max(1, lowH);
  u.uFogColor.value.set(vol.fogColor[0], vol.fogColor[1], vol.fogColor[2]);
  u.uFogSigma.value = vol.fogSigma;
  u.uFogInvH.value = vol.fogInvH;
  u.uField.value = vol.field;
  u.uNoise.value = noise.texture;
  u.uLaw.value.set(vol.law.wl, vol.law.edge, vol.law.thick);
  u.uBase.value = vol.slab.base;
  u.uTop.value = vol.slab.top;
  u.uSigma.value = vol.sigma;
  cloudDrift(vol, _drift);
  u.uCloudDrift.value.set(_drift.fx, _drift.fz);
  u.uNoiseDrift.value.set(_drift.nx, _drift.ny, _drift.nz);
  u.uSunDir.value.set(vol.sunDir[0], vol.sunDir[1], vol.sunDir[2]);
  u.uSunLin.value.set(vol.sunLin[0], vol.sunLin[1], vol.sunLin[2]);
  u.uAmbTop.value.set(vol.ambTop[0], vol.ambTop[1], vol.ambTop[2]);
  u.uAmbBase.value.set(vol.ambBase[0], vol.ambBase[1], vol.ambBase[2]);
  const k = vol.lightK;
  u.uLightK.value.set(k[0], k[1], k[2], k[3]);
}

// ---------------------------------------------------------------------------
// JS mirror (tests, gameplay). Sampling as WebGL does it: bilinear / trilinear
// at level 0 with REPEAT, texel centres at (i + 0.5) / N.
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// The field is uploaded as scenery.js's CanvasTexture, flipY true: texture v
// reads canvas row (1 - v), so the mirror does too.
function fieldTap(data, size, u, v) {
  const x = u * size - 0.5;
  const y = (1 - v) * size - 0.5;
  const x0 = Math.floor(x); const y0 = Math.floor(y);
  const fx = x - x0; const fy = y - y0;
  const w = (i) => ((i % size) + size) % size;
  const xa = w(x0); const xb = w(x0 + 1); const ya = w(y0) * size; const yb = w(y0 + 1) * size;
  const a = data[ya + xa] + (data[ya + xb] - data[ya + xa]) * fx;
  const b = data[yb + xa] + (data[yb + xb] - data[yb + xa]) * fx;
  return (a + (b - a) * fy) / 255;
}

function noiseTap(noise, u, v, w, out) {
  const N = noise.size;
  const d = noise.data;
  const x = u * N - 0.5; const y = v * N - 0.5; const z = w * N - 0.5;
  const x0 = Math.floor(x); const y0 = Math.floor(y); const z0 = Math.floor(z);
  const fx = x - x0; const fy = y - y0; const fz = z - z0;
  const wr = (i) => ((i % N) + N) % N;
  const xs = [wr(x0), wr(x0 + 1)]; const ys = [wr(y0), wr(y0 + 1)]; const zs = [wr(z0), wr(z0 + 1)];
  let r = 0; let g = 0;
  for (let k = 0; k < 2; k++) {
    const wz = k ? fz : 1 - fz;
    for (let j = 0; j < 2; j++) {
      const wy = j ? fy : 1 - fy;
      for (let i = 0; i < 2; i++) {
        const wgt = wz * wy * (i ? fx : 1 - fx);
        const idx = ((zs[k] * N + ys[j]) * N + xs[i]) * 2;
        r += wgt * d[idx]; g += wgt * d[idx + 1];
      }
    }
  }
  out.r = r / 255; out.g = g / 255;
  return out;
}

const _n = { r: 0, g: 0 };
const _h = { hf: 0, above: 0 };
// Density 0..1 at a world point (vol defaults to the active battle's).
// Without the erosion volume (not built: medium/low) the column shape alone.
// hOut.hf receives the column height share (ssCloudDensityH).
export function cloudDensityAt(x, y, z, vol = activeVolume, drift = null, hOut = _h) {
  hOut.hf = 0;
  hOut.above = 0;
  if (!vol) return 0;
  const s = vol.slab;
  if (y <= s.base || y >= s.top) return 0;
  const dr = drift || cloudDrift(vol, _drift);
  const fd = vol.fieldData;
  const fs = Math.round(Math.sqrt(fd.length));
  const u = x / CLOUD_FIELD_PERIOD + dr.fx;
  const v = z / CLOUD_FIELD_PERIOD + dr.fz;
  const a = fieldTap(fd, fs, u, v);
  const b = fieldTap(fd, fs, u * 2.17 + 0.31 + dr.fx * 0.6, v * 2.17 + 0.57 + dr.fz * 0.6);
  const d = a * 0.65 + b * 0.35;
  const law = vol.law;
  const m = smooth(law.wl, law.wl + law.edge, d);
  if (m <= 0) return 0;
  const th = clamp01((d - law.wl) / law.thick);
  const colBase = s.base + (s.top - s.base) * 0.18 * (1 - th);
  const colTop = s.base + (s.top - s.base) * (0.3 + 0.7 * clamp01((d - law.wl) / (1.35 * law.thick)));
  const hf = (y - colBase) / (colTop - colBase);
  hOut.hf = hf;
  hOut.above = colTop - y;
  if (hf <= 0 || hf >= 1) return 0;
  const shape = m * smooth(0, 0.15, hf) * (1 - smooth(0.65, 1, hf));
  const noise = vol.noise;
  if (!noise) return shape;
  noiseTap(noise, x / CLOUD_NOISE_PERIOD + dr.nx, y / CLOUD_NOISE_PERIOD + dr.ny, z / CLOUD_NOISE_PERIOD + dr.nz, _n);
  const e = (1 - _n.r) * (0.5 + 0.2 * hf);
  const rho = clamp01((shape - e) / (1 - e));
  return clamp01(rho - (1 - _n.g) * 0.25 * (1 - rho));
}

// Optical depth of the slab along a segment (AI line of sight: transmittance
// is exp(-tau); tau >= 3 hides what is behind, as C-50 does for smoke).
export function cloudOpticalDepth(ax, ay, az, bx, by, bz, vol = activeVolume, steps = 32) {
  if (!vol) return 0;
  const s = vol.slab;
  if ((ay <= s.base && by <= s.base) || (ay >= s.top && by >= s.top)) return 0;
  const dr = cloudDrift(vol, {});
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  if (!(len > 0)) return 0;
  let tau = 0;
  for (let i = 0; i < steps; i++) {
    const f = (i + 0.5) / steps;
    tau += cloudDensityAt(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f, vol, dr);
  }
  return tau * vol.sigma * (len / steps);
}

function hg(c, g) {
  const g2 = g * g;
  return (1 - g2) / (12.566371 * Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-4), 1.5));
}

// The march of one ray, as the GLSL does it (lod 0). opts: { jitter = 0.5,
// steps = CLOUD_STEPS, tEnd = Infinity (scene depth along the ray, m) }.
// Returns { rgb (fog not applied unless opts.fog), T, tMean }.
export function marchCloudCPU(vol, ro, rd, opts = {}) {
  const s = vol.slab;
  const steps = opts.steps || CLOUD_STEPS;
  const j = opts.jitter ?? 0.5;
  const dl = Math.hypot(rd.x, rd.y, rd.z) || 1;
  const dx = rd.x / dl; const dy = rd.y / dl; const dz = rd.z / dl;
  let tEnd = Number.isFinite(opts.tEnd) ? opts.tEnd : 1e9;
  const hz = Math.hypot(dx, dz);
  if (hz > 1e-4) tEnd = Math.min(tEnd, CLOUD_FAR / hz);
  let t0 = 0; let t1 = -1;
  if (Math.abs(dy) < 1e-6) {
    if (ro.y > s.base && ro.y < s.top) t1 = tEnd;
  } else {
    const ta = (s.base - ro.y) / dy;
    const tb = (s.top - ro.y) / dy;
    t0 = Math.max(Math.min(ta, tb), 0);
    t1 = Math.min(Math.max(ta, tb), tEnd);
  }
  const out = { rgb: [0, 0, 0], T: 1, tMean: 0 };
  if (t1 <= t0 + 0.5) return out;
  const L = t1 - t0;
  const k = smooth(600, 4000, L);
  const cosT = dx * vol.sunDir[0] + dy * vol.sunDir[1] + dz * vol.sunDir[2];
  const dr = cloudDrift(vol, {});
  const K = vol.lightK;
  const sd = vol.sunDir;
  const sig = vol.sigma;
  let T = 1; let tw = 0; let ws = 0;
  const S = [0, 0, 0];
  const hcol = { hf: 0, above: 0 };
  const iters = opts.iter || CLOUD_ITER;
  let x = 0; let tc = t0; let tLast = t0; let fine = false; let empty = 0;
  const hb = { hf: 0, above: 0 };
  const mixq = (q) => q + (q * q - q) * k;
  for (let i = 0; i < iters; i++) {
    let dt; let t; let x1 = x;
    if (fine) {
      dt = Math.min(CLOUD_FINE_MAX, Math.max(CLOUD_FINE_MIN, CLOUD_FINE_REL * tc));
      t = tc + dt * j;
      if (t >= t1) break;
    } else {
      const xm = x + j / steps;
      if (xm >= 1) break;
      x1 = Math.min(x + 1 / steps, 1);
      dt = t0 + L * mixq(x1) - tc;
      t = t0 + L * mixq(xm);
    }
    const px = ro.x + dx * t; const py = ro.y + dy * t; const pz = ro.z + dz * t;
    const rho = cloudDensityAt(px, py, pz, vol, dr, hcol);
    const hgt = clamp01(hcol.hf);
    const colAbove = hcol.above;
    if (rho > 0.002 && !fine) {
      let lo = tLast; let hi = t;
      for (let b = 0; b < 4; b++) {
        const mid = 0.5 * (lo + hi);
        if (cloudDensityAt(ro.x + dx * mid, ro.y + dy * mid, ro.z + dz * mid, vol, dr, hb) > 0.002) hi = mid;
        else lo = mid;
      }
      tc = lo;
      fine = true;
      empty = 0;
      continue;
    }
    if (!(rho > 0.002)) {
      tLast = t;
      if (fine && ++empty >= 4) {
        fine = false;
        const sq = Math.min(1, Math.max(0, (tc + dt - t0) / L));
        x = k < 1e-4 ? sq : (-(1 - k) + Math.sqrt((1 - k) * (1 - k) + 4 * k * sq)) / (2 * k);
        tc += dt;
        continue;
      }
      tc += dt;
      x = x1;
      continue;
    }
    empty = 0;
    tc += dt;
    x = x1;
    {
      const D = Math.min(600, Math.max(30, (s.top - py) / Math.max(sd[1], 0.15)));
      const r = cloudDensityAt(px + sd[0] * 0.25 * D, py + sd[1] * 0.25 * D, pz + sd[2] * 0.25 * D, vol, dr)
        + cloudDensityAt(px + sd[0] * 0.75 * D, py + sd[1] * 0.75 * D, pz + sd[2] * 0.75 * D, vol, dr);
      const tauL = Math.max(sig * r * 0.5 * D, sig * CLOUD_COLUMN_K * colAbove / Math.max(sd[1], 0.15) * smooth(0.3, 0.8, sd[1]));
      const ms = Math.exp(-K[3] * tauL);
      const ss = Math.exp(-tauL);
      const powder = 1 - Math.exp(-rho * sig * 40);
      const pw = 1 + (powder - 1) * 0.3 * (1 - cosT);
      const sunK = K[0] * ms * pw + Math.PI * K[1] * hg(cosT, 0.75) * ss;
      const a = Math.exp(-sig * rho * dt);
      const w = T * (1 - a);
      for (let c = 0; c < 3; c++) {
        const amb = vol.ambBase[c] + (vol.ambTop[c] - vol.ambBase[c]) * hgt;
        S[c] += (vol.sunLin[c] * sunK + K[2] * amb) * w;
      }
      tw += t * w; ws += w;
      T *= a;
      if (T < 0.01) break;
    }
  }
  out.T = T;
  out.tMean = ws > 0 ? tw / ws : 0;
  if (opts.fog && ws > 0) {
    const tm = out.tMean;
    const v = heightFogVeil(vol.fogSigma, vol.fogInvH, ro, { x: ro.x + dx * tm, y: ro.y + dy * tm, z: ro.z + dz * tm });
    for (let c = 0; c < 3; c++) S[c] = S[c] * (1 - v) + vol.fogColor[c] * v * (1 - T);
  }
  out.rgb = S;
  return out;
}
