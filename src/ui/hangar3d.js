import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { buildTankMesh } from '../vehicles/tanks.js';
import {
  createPhotoRig, createPostFX, createFramePacer, postFXQualityFor, gpuNameOf,
} from '../core/postfx.js';
import * as planesMod from '../vehicles/planes.js';
import * as materialsMod from '../core/materials.js';
import { buildTerrain, terrainHeight } from '../world/terrain.js';
import { MAP_PRESETS, TIMES_OF_DAY, WEATHERS, composePreset } from '../world/presets.js';

// The live hangar stage: one small Three.js scene behind the garage panels with
// the selected vehicle parked on a concrete hardstand, a landscape around it and
// a camera on a slow turntable.
//
// It is deliberately a *neighbour* of the battle renderer, never a client of it.
// Two things in particular are avoided on purpose:
//   - randomPreset() and setTerrainSeed() both write module-global state that
//     the battle reads back, so the menu picks its mood with composePreset()
//     instead and samples whatever heightmap layout happens to be loaded.
//   - setupEnvironment() calls disposeScenery() and installs a global update
//     driver, so a hangar built through it would tear down a battle's props.
// The backdrop below is therefore its own, much cheaper, scattering.
//
// L-09: the stage is lit and photographed exactly like a battle at the same
// preset — the battle's sun (with its caster floor), ground-bounce
// hemisphere, sky-dome PMREM (the preset's HDRI once decoded), height fog,
// AgX at the preset exposure (core/postfx.js createPhotoRig) — through the
// battle's own post chain (createPostFX at its medium tier: OutputPass, the
// L-07 grade and the K-01 finish; see HANGAR_POST for what the stage leaves
// out and why), plus the stage's K-03 depth of field and FXAA. No studio
// lights.
// The X-ray / protection overlay (N25) is NOT drawn through that chain: while
// a view owns the stage, the composer is skipped and the view draws straight
// to the canvas, so its hand-encoded legend colours are never tone mapped or
// encoded a second time.

const PAD_HX = 11;        // hardstand half-extents (m) — sized for the widest
const PAD_HZ = 8.5;       // aeroplane in the game with room to walk around it
const SEAM_SPACING = 3.5; // metres between the slab's poured panel joints
const AUTO_RATE = 0.087;  // automatic orbit, rad/s (about 5 degrees per second)
// The stage's post chain (see buildPost). L-09, wave 3d: the battle's chain
// at its MEDIUM tier on every stage tier that has a composer (render ->
// OutputPass -> finish: the L-07 grade and the K-01 lens), plus two passes the
// stage adds itself (installStagePasses): K-03 depth of field before
// OutputPass and FXAA after it. No bloom (L-05 blooms emitters only; the stage
// has none). No GTAO: at half resolution its upsampled occlusion haloed every
// silhouette and darkened the calibration board 4.1-4.3 levels on high (the
// L-09 card accept is +/-3), and at full resolution it cost 4.9 ms of a 1.1 MP
// frame on Iris Xe, more than the whole budget below allows. The vehicle's
// contact darkening comes from the 2048 sun shadow and the contact disc.
const HANGAR_POST = Object.freeze({ bloom: false });
// stage tier -> the battle chain tier it runs ('low' draws straight to the
// MSAA canvas, exactly as a low battle does)
const STAGE_POST_TIER = Object.freeze({ low: 'low', medium: 'medium', high: 'medium' });

// L-09 GPU budget: <= 4 ms at 1080p on the reference GPU (backlog 1.1: GTX
// 1650M / RTX 3050 Laptop / Radeon 680M, 3-5 TFLOPS). Iris Xe (~2 TFLOPS,
// 68 GB/s) is 1.6x (680M) to 3x (3050) slower than that class, so the stage
// is tiered until its HIGH frame holds <= 6.4 ms on Iris Xe at a full-HD
// window. Measured there (wave 3d, frozen build, timer queries around the
// stage's own update(), GPU kept busy, medians of interleaved blocks):
//   high   (forced)   meadow-noon-clear 11.0 -> 5.0 ms, winter-dusk 10.4 -> 4.1
//   medium (Iris Xe)  meadow 9.7 -> 5.5 ms (0.8 MP), winter-dusk 7.4 -> 3.9
// with the K-03 depth of field (0.36-0.65 ms) and FXAA included, i.e. about
// 3.2 ms on a 680M and 2.3 on a 1650M for the heaviest mood. What it costs is the
// scene draw, and two thirds of that was the battle's terrain shader shading
// pixels that the slab and the vehicle then covered: three sorts opaque
// draws by material id before depth, so the ground (and the full-screen sky
// dome under it) went first. They now draw last (STAGE_ORDER) and early-Z
// rejects what is hidden. Then the drawing buffer is capped per tier
// (STAGE_MAX_PIXELS; the browser upscales the canvas past it) and the sun's
// shadow map is redrawn only every SHADOW_EVERY frames or when something
// casting it changed. A static cap, not a GPU-timer loop: an integrated GPU
// clocks down under a light load, a timer then reads long, and a loop chasing
// it spirals the stage down to its floor.
const STAGE_MAX_PIXELS = { low: 0.5e6, medium: 0.8e6, high: 0.9e6 };
// opaque draw order on the stage: everything else (vehicle, slab, backdrop) 0
const STAGE_ORDER = Object.freeze({ terrain: 1, sky: 2 });
// The turret's idle sweep turns at most 0.03 rad/s and the props are a blur:
// a shadow four frames old is the same shadow. A new vehicle, the swap
// turntable and a tier change redraw it at once (shadowDirty).
const SHADOW_EVERY = 4;

// ---------------------------------------------------------------------------
// K-03 depth of field: subtle, on the live stage only
// ---------------------------------------------------------------------------
// Focus is the vehicle's bounding sphere: everything inside it is in focus
// (circle of confusion 0, so the machine is sharp across its whole depth),
// and beyond it the blur grows as a thin lens does, toward DOF_INF_FRAC of
// the frame height at infinity. The backlog asks for "50 mm f/4" AND a
// treeline 150-300 m away blurred 3-6 px with the vehicle sharp: a physical
// f/4 focused at the 12-20 m the stage frames from gives 1.2-1.6 px at
// infinity on a 1080 px frame, and any physical aperture big enough for 3-6 px
// would blur the near end of a tank. The sphere-wide focus band keeps both
// promises: at 1/180 of the frame height (4.5 px at infinity on the 814 px
// stage of a full-HD window) the treeline lands at 3.3-4.3 px of blur-disc
// diameter from the Il-2 to the Stuart at their framing distances, the
// vehicle at exactly 0 (t_stage.mjs, hangar lane). The foreground
// in front of the sphere gets the mirror law at DOF_NEAR_GAIN of the far one
// (rare: only a zoomed-in or steep camera sees ground nearer than the
// sphere). The focus distance is the sphere centre's depth on the camera
// axis, which the turntable orbit keeps constant: the focus never breathes.
export const DOF_INF_FRAC = 1 / 180;
export const DOF_NEAR_GAIN = 0.75;
export const DOF_TAPS = 16;
const DOF_MIN_RADIUS = 0.25; // px: below this a pixel is copied, not gathered

// Signed circle-of-confusion DIAMETER in pixels for view depth z (m): > 0
// behind the focus band, < 0 in front of it, 0 inside. The shader's twin.
export function dofCoc(z, nearEdge, farEdge, cocMax, nearGain = DOF_NEAR_GAIN) {
  if (!(z > 0)) return 0;
  if (z > farEdge) return cocMax * (1 - farEdge / z);
  if (z < nearEdge && nearEdge > 0) return -Math.min(cocMax, cocMax * nearGain * (nearEdge / z - 1));
  return 0;
}

const _dofCam = new THREE.Vector3();
const _dofFwd = new THREE.Vector3();
const _dofRel = new THREE.Vector3();

// The focus band [near, far] (m of view depth) of a sphere for a camera.
export function dofFocus(camera, centre, radius, out = {}) {
  camera.updateMatrixWorld();
  _dofCam.setFromMatrixPosition(camera.matrixWorld);
  _dofFwd.set(0, 0, -1).transformDirection(camera.matrixWorld);
  const s = _dofRel.copy(centre).sub(_dofCam).dot(_dofFwd);
  const r = Math.max(0, radius || 0);
  out.focus = s;
  out.near = Math.max(camera.near, s - r);
  out.far = Math.max(out.near, s + r);
  return out;
}

// Unit-disc Vogel spiral, unrolled into the gather (no loop, no uniforms).
function dofTapsGLSL(n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const a = i * 2.399963229728653;
    lines.push(`    dofTap(vec2(${(Math.cos(a) * r).toFixed(5)}, ${(Math.sin(a) * r).toFixed(5)}), r0, c0, acc, wsum);`);
  }
  return lines.join('\n');
}

const DOF_VS = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

// colour + signed CoC (px) into one half-float target. Reading the shared
// depth here is safe: this target has no depth attachment (the composer's
// buffers do, so the gather below never samples it - P-02 feedback rule).
const DOF_PREP_FS = /* glsl */`
  #include <packing>
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform float uNear;
  uniform float uFar;
  uniform vec4 uFocus;   // near edge (m), far edge (m), CoC at infinity (px), near gain
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D( tDiffuse, vUv );
    float d = texture2D( tDepth, vUv ).x;
    float z = d >= 1.0 ? 1.0e6 : - perspectiveDepthToViewZ( d, uNear, uFar );
    float coc = 0.0;
    if ( z > uFocus.y ) coc = uFocus.z * ( 1.0 - uFocus.y / z );
    else if ( z < uFocus.x ) coc = - min( uFocus.z, uFocus.z * uFocus.w * ( uFocus.x / max( z, 1.0e-3 ) - 1.0 ) );
    gl_FragColor = vec4( c.rgb, coc );
  }
`;

// Scatter-as-gather over a disc of the pixel's own radius: a tap counts only
// where ITS blur disc reaches this pixel, so the sharp vehicle (CoC 0) never
// bleeds into the blurred ground behind it, and an in-focus pixel is copied.
const DOF_GATHER_FS = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void dofTap( vec2 k, float r0, vec4 c0, inout vec3 acc, inout float wsum ) {
    vec2 o = k * r0;
    vec4 s = texture2D( tSrc, vUv + o * uTexel );
    float w = clamp( abs( s.a ) * 0.5 - length( o ) + 0.5, 0.0, 1.0 );
    acc += s.rgb * w;
    wsum += w;
  }
  void main() {
    vec4 c0 = texture2D( tSrc, vUv );
    float r0 = abs( c0.a ) * 0.5;
    if ( r0 < ${DOF_MIN_RADIUS.toFixed(2)} ) {
      gl_FragColor = vec4( c0.rgb, 1.0 );
      return;
    }
    vec3 acc = c0.rgb;
    float wsum = 1.0;
${dofTapsGLSL(DOF_TAPS)}
    gl_FragColor = vec4( acc / wsum, 1.0 );
  }
`;

function dofMaterial(name, uniforms, fragmentShader) {
  return new THREE.ShaderMaterial({
    name,
    uniforms,
    vertexShader: DOF_VS,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

// One composer pass, two draws: prep into its own target, gather into the
// composer's write buffer with no clear (that buffer's depth is the frame's
// shared depth and must survive to the end of the chain, P-02). Linear HDR
// in and out: it sits before OutputPass, so highlights spread with their real
// energy and the K-01 grain lands on top of the blur, sharp, as on film.
class StageDofPass extends Pass {
  constructor(stage) {
    super();
    this.stage = stage;
    this.needsSwap = true;
    this.__kind = 'dof';
    this.w = 1;
    this.h = 1;
    this.target = null; // allocated on first use
    this.band = { focus: 0, near: 0, far: 0 };
    this.lastCocMax = 0;
    this.prep = new FullScreenQuad(dofMaterial('StageDofPrep', {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uNear: { value: 0.5 },
      uFar: { value: 8200 },
      uFocus: { value: new THREE.Vector4() },
    }, DOF_PREP_FS));
    this.gather = new FullScreenQuad(dofMaterial('StageDofGather', {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2(1, 1) },
    }, DOF_GATHER_FS));
  }

  // EffectComposer skips a pass whose `enabled` is false. Asked every frame,
  // also when the calibration board draws the chain without update(): no
  // subject on the stage (the board shot hides it), no depth, no blur.
  get enabled() {
    const st = this.stage;
    return !!(st && st.dofWanted());
  }

  set enabled(v) { /* derived; see the getter */ }

  setSize(w, h) {
    this.w = Math.max(1, w | 0);
    this.h = Math.max(1, h | 0);
    if (this.target) this.target.setSize(this.w, this.h);
    this.gather.material.uniforms.uTexel.value.set(1 / this.w, 1 / this.h);
  }

  render(renderer, writeBuffer, readBuffer) {
    const st = this.stage;
    const cam = st.camera;
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(this.w, this.h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    }
    dofFocus(cam, st.focusCentre, st.focusRadius, this.band);
    const cocMax = DOF_INF_FRAC * this.h;
    this.lastCocMax = cocMax;
    const pu = this.prep.material.uniforms;
    pu.tDiffuse.value = readBuffer.texture;
    pu.tDepth.value = st.postfx ? st.postfx.depthTexture : null;
    pu.uNear.value = cam.near;
    pu.uFar.value = cam.far;
    pu.uFocus.value.set(this.band.near, this.band.far, cocMax, DOF_NEAR_GAIN);
    this.gather.material.uniforms.tSrc.value = this.target.texture;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.setRenderTarget(this.target);
      this.prep.render(renderer);
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.gather.render(renderer);
    } finally {
      renderer.autoClear = autoClear;
    }
  }

  dispose() {
    if (this.target) this.target.dispose();
    this.target = null;
    this.prep.material.dispose();
    this.prep.dispose();
    this.gather.material.dispose();
    this.gather.dispose();
  }
}

// FXAA on the display-referred frame, as the battle's high chain runs it
// for the stage before (postfx 'fxaa'), with no depth clear (P-02).
function makeStageFxaa() {
  const fx = new ShaderPass(FXAAShader);
  fx.__kind = 'fxaa';
  fx.material.depthTest = false;
  fx.material.depthWrite = false;
  fx.setSize = (w, h) => fx.uniforms.resolution.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  const base = fx.render.bind(fx);
  fx.render = (renderer, writeBuffer, readBuffer, dt, mask) => {
    if (fx.renderToScreen) return base(renderer, writeBuffer, readBuffer, dt, mask);
    const d = renderer.autoClearDepth;
    const s = renderer.autoClearStencil;
    renderer.autoClearDepth = false;
    renderer.autoClearStencil = false;
    try {
      return base(renderer, writeBuffer, readBuffer, dt, mask);
    } finally {
      renderer.autoClearDepth = d;
      renderer.autoClearStencil = s;
    }
  };
  return fx;
}
const QUALITY_ORDER = ['low', 'medium', 'high'];
const IDLE_RESUME = 2.0;  // seconds after the mouse lets go before the orbit resumes
const BASE_PITCH = 0.2;   // a low, slightly heroic three-quarter angle
const FOV = 32;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

const { buildPlaneMesh } = planesMod;
// Both read off their namespaces: the gear rig and the shared-resource stamp are
// young exports, and the hangar is not worth losing to a renamed one.
const setPlaneGear = planesMod.setPlaneGear || null;
const isShared = materialsMod.isSharedResource
  || ((o) => !!(o && o.userData && o.userData.shared));

// Module-scope temporaries. The render loop runs sixty times a second behind a
// menu the player may leave open for a long time; it must not create garbage.
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _target = new THREE.Vector3();
const _vtx = new THREE.Vector3();

// The bounds of what is actually drawn, from the vertices themselves. Box3's
// quick path transforms each mesh's local box, which for a fuselage pitched
// nose-up on its tailwheel comes out half a metre deeper than the aeroplane —
// and the slab is placed under that phantom, leaving the wheels in the air. It
// also counts the hidden bomb fit the builder makes alongside the rocket one.
function visibleBounds(root, out) {
  out.makeEmpty();
  root.updateWorldMatrix(true, true);
  const walk = (o) => {
    if (!o.visible) return;
    if (o.isMesh && o.geometry && o.geometry.attributes.position) {
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        _vtx.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        out.expandByPoint(_vtx);
      }
    }
    for (const c of o.children) walk(c);
  };
  walk(root);
  return out;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(t) {
  const p = clamp(t, 0, 1);
  return p * p * (3 - 2 * p);
}

// Deterministic RNG so a given mood always lays its treeline out the same way.
// The mood itself is rolled once per page load; the scatter under it is not.
function rngFrom(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pickWeighted(keys, weightOf, rng) {
  let total = 0;
  for (const k of keys) total += Math.max(0, weightOf(k));
  if (total <= 0) return keys[0];
  let r = rng() * total;
  for (const k of keys) {
    r -= Math.max(0, weightOf(k));
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

// One mood for the whole session. Rolling it per Hangar3D would be fine today —
// the garage only ever builds one — but a re-entered menu that changed biome
// every time would read as a bug rather than as variety.
function pickStageMood() {
  const rng = Math.random;
  const biome = pickWeighted(Object.keys(MAP_PRESETS), () => 1, rng);
  // Golden hours flatter a parked vehicle far more than flat midday light, so
  // the hangar weights them up where a battle weights midday up.
  const todWeights = { dawn: 2.4, noon: 1.4, dusk: 2.4, overcast: 0.8 };
  const tod = pickWeighted(Object.keys(TIMES_OF_DAY), (k) => todWeights[k] ?? 1, rng);
  // Whatever the biome's own weather table allows, minus the thickest fog:
  // the menu wants a sense of place, not a white-out.
  const bias = MAP_PRESETS[biome].weather || {};
  const weatherWeights = { clear: 3, haze: 1.4, overcast: 1, snow: 0.5 };
  const weather = pickWeighted(
    Object.keys(WEATHERS),
    (k) => (bias[k] ?? 1) * (weatherWeights[k] ?? 1),
    rng,
  );
  return composePreset(biome, tod, weather);
}

const STAGE = pickStageMood();

// ---------------------------------------------------------------------------
// Stage dressing
// ---------------------------------------------------------------------------

// Highest and lowest ground under the slab's footprint. The hardstand is poured
// level and kerbed down into the hillside, which is both how a real one is built
// and the only way a flat slab never has terrain poking through it.
function padLevels() {
  let hi = -1e9;
  let lo = 1e9;
  for (let i = -4; i <= 4; i++) {
    for (let j = -3; j <= 3; j++) {
      const h = terrainHeight((i / 4) * (PAD_HX + 1), (j / 3) * (PAD_HZ + 1));
      if (h > hi) hi = h;
      if (h < lo) lo = h;
    }
  }
  return { top: hi + 0.3, bottom: lo - 1.2 };
}

// Distance in metres from (x, z) to the nearest poured joint.
function seamDistance(x, z) {
  const dx = Math.abs(((x / SEAM_SPACING) % 1 + 1.5) % 1 - 0.5) * SEAM_SPACING;
  const dz = Math.abs(((z / SEAM_SPACING) % 1 + 1.5) % 1 - 0.5) * SEAM_SPACING;
  return dx < dz ? dx : dz;
}

function buildHardstand(top, bottom, preset) {
  const group = new THREE.Group();

  // 0.25 m cells: fine enough that a joint reads as a line rather than as a
  // stripe, coarse enough that the whole slab is still one cheap static mesh.
  const geo = new THREE.PlaneGeometry(PAD_HX * 2, PAD_HZ * 2, 88, 68);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;

  const base = new THREE.Color(0x8d8f88).lerp(new THREE.Color(preset.low), 0.14);
  const joint = base.clone().multiplyScalar(0.68);
  const grime = new THREE.Color(preset.dust?.dirt ?? 0x9a8a68).multiplyScalar(0.6);
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    c.copy(base);

    // poured joints
    const seam = clamp(1 - seamDistance(x, z) / 0.34, 0, 1);
    c.lerp(joint, seam * 0.75);

    // Track scuffs: two bands of rubbed concrete where everything that has ever
    // parked here put its tracks down, heaviest in the middle of the slab.
    const band = clamp(1 - Math.abs(Math.abs(x) - 1.45) / 0.62, 0, 1);
    const along = clamp(1 - Math.abs(z) / (PAD_HZ * 0.82), 0, 1);
    c.lerp(grime, band * along * 0.42);

    // Worn edges: the kerb line is where dirt creeps onto the concrete and where
    // the corners have been chipped off by fifty years of steel.
    const edge = Math.max(Math.abs(x) / PAD_HX, Math.abs(z) / PAD_HZ);
    c.lerp(grime, smoothstep((edge - 0.74) / 0.26) * 0.55);

    const n = Math.sin(x * 5.3) * Math.sin(z * 6.7) * 0.018;
    colors[i * 3 + 0] = c.r + n;
    colors[i * 3 + 1] = c.g + n;
    colors[i * 3 + 2] = c.b + n;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // Standard, not Lambert: only the standard model takes the image-based light
  // (scene.environment), and without it the slab's shade would get the bare
  // ground bounce — a third of what the battle rig gives it.
  const slabMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const slab = new THREE.Mesh(geo, slabMat);
  slab.position.y = top;
  slab.receiveShadow = true;
  group.add(slab);

  // The kerb: a plain block whose top sits just under the slab, wider than it so
  // its shoulder reads as a lip rather than as a coplanar seam that z-fights.
  const depth = Math.max(1.5, top - bottom);
  const kerbGeo = new THREE.BoxGeometry(PAD_HX * 2 + 0.5, depth, PAD_HZ * 2 + 0.5);
  const kerbMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x8d8f88).lerp(new THREE.Color(preset.low), 0.3).multiplyScalar(0.72),
    flatShading: true,
    roughness: 0.95,
    metalness: 0,
  });
  const kerb = new THREE.Mesh(kerbGeo, kerbMat);
  kerb.position.y = top - 0.02 - depth / 2;
  kerb.receiveShadow = true;
  group.add(kerb);

  return { group, materials: [slabMat, kerbMat], geometries: [geo, kerbGeo] };
}

// A soft dark disc under the hull. The key light already casts a real shadow;
// this is the contact darkening a 1024-pixel shadow map cannot resolve, and it
// is one draw call because the falloff lives in a four-component colour
// attribute rather than in a texture.
function buildContactShadow() {
  const geo = new THREE.CircleGeometry(1, 40);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    colors[i * 4 + 3] = (1 - r) * 0.5;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  return { mesh, geo, mat };
}

// Treeline and boulders on the ground beyond the pad. Instanced, so the whole
// backdrop costs two draw calls no matter how thick the wood is.
function buildBackdrop(preset, rng) {
  const parts = [];
  const geometries = [];
  const materials = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();

  const place = (minR, maxR) => {
    const a = rng() * Math.PI * 2;
    const r = minR + (maxR - minR) * Math.sqrt(rng());
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  };

  const treeCount = Math.round(150 * (preset.treeFactor ?? 1));
  if (treeCount > 0) {
    const crownGeo = new THREE.ConeGeometry(0.42, 1, 6);
    crownGeo.translate(0, 0.62, 0);
    const crownMat = new THREE.MeshStandardMaterial({
      color: preset.crown, flatShading: true, roughness: 0.9, metalness: 0,
    });
    const trunkGeo = new THREE.CylinderGeometry(0.055, 0.08, 0.34, 5);
    trunkGeo.translate(0, 0.17, 0);
    const trunkMat = new THREE.MeshStandardMaterial({
      color: preset.trunk, flatShading: true, roughness: 0.95, metalness: 0,
    });
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, treeCount);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    for (let i = 0; i < treeCount; i++) {
      const { x, z } = place(26, 190);
      const h = 4 + rng() * 6;
      p.set(x, terrainHeight(x, z) - 0.3, z);
      q.setFromAxisAngle(WORLD_UP, rng() * Math.PI * 2);
      s.set(h * (0.75 + rng() * 0.4), h, h * (0.75 + rng() * 0.4));
      m.compose(p, q, s);
      crowns.setMatrixAt(i, m);
      trunks.setMatrixAt(i, m);
    }
    crowns.castShadow = true;
    crowns.instanceMatrix.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;
    parts.push(crowns, trunks);
    geometries.push(crownGeo, trunkGeo);
    materials.push(crownMat, trunkMat);
  }

  const rockCount = Math.round(34 * (preset.rockFactor ?? 1));
  if (rockCount > 0) {
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({
      color: preset.rockCol, flatShading: true, roughness: 0.9, metalness: 0,
    });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
    for (let i = 0; i < rockCount; i++) {
      const { x, z } = place(22, 150);
      const r = 0.7 + rng() * 1.8;
      p.set(x, terrainHeight(x, z) - r * 0.35, z);
      q.setFromAxisAngle(WORLD_UP, rng() * Math.PI * 2);
      s.set(r, r * (0.5 + rng() * 0.5), r * (0.7 + rng() * 0.6));
      m.compose(p, q, s);
      rocks.setMatrixAt(i, m);
    }
    rocks.castShadow = true;
    rocks.instanceMatrix.needsUpdate = true;
    parts.push(rocks);
    geometries.push(rockGeo);
    materials.push(rockMat);
  }

  return { parts, geometries, materials };
}

// A taildragger's resting attitude. Everything below is sized from it, so a
// nine-metre Spitfire and a twelve-metre Il-2 both stand on all three wheels
// instead of one of them hanging in the air.
const PARK_PITCH = 0.185;

// The undercarriage the flight model has no use for and buildPlaneMesh therefore
// never draws. On a runway an aeroplane is always in the air; on a hardstand it
// has to be standing on something.
function buildLandingGear(spec) {
  const span = spec.span || 11;
  const len = spec.len || 9;
  const group = new THREE.Group();
  const strutMat = new THREE.MeshStandardMaterial({
    color: 0x3a3e44, flatShading: true, roughness: 0.55, metalness: 0.5,
  });
  const tyreMat = new THREE.MeshStandardMaterial({
    color: 0x24262a, flatShading: true, roughness: 0.9, metalness: 0,
  });
  const strutGeo = new THREE.CylinderGeometry(0.07, 0.09, 1, 6);
  strutGeo.translate(0, -0.5, 0);
  const tyreGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.2, 12);
  tyreGeo.rotateZ(Math.PI / 2);
  const tailStrutGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.6, 5);
  tailStrutGeo.translate(0, -0.3, 0);
  const tailTyreGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.12, 8);
  tailTyreGeo.rotateZ(Math.PI / 2);

  // The tailwheel is fixed and the main legs are however long they need to be
  // to hold the nose PARK_PITCH above it over this airframe's wheelbase.
  const legLen = 0.32 + len * Math.tan(PARK_PITCH) * 0.54;
  for (const sign of [-1, 1]) {
    const strut = new THREE.Mesh(strutGeo, strutMat);
    strut.position.set(sign * span * 0.17, -0.34, len * 0.1);
    strut.scale.y = legLen;
    strut.rotation.z = sign * 0.1;
    group.add(strut);
    const tyre = new THREE.Mesh(tyreGeo, tyreMat);
    tyre.position.set(sign * span * 0.17 + sign * 0.13, -0.34 - legLen, len * 0.1);
    group.add(tyre);
  }
  const tailStrut = new THREE.Mesh(tailStrutGeo, strutMat);
  tailStrut.position.set(0, -0.22, -len * 0.44);
  group.add(tailStrut);
  const tailTyre = new THREE.Mesh(tailTyreGeo, tyreMat);
  tailTyre.position.set(0, -0.85, -len * 0.44);
  group.add(tailTyre);

  group.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });

  return {
    group,
    geometries: [strutGeo, tyreGeo, tailStrutGeo, tailTyreGeo],
    materials: [strutMat, tyreMat],
  };
}

// Give back what the stage owns and nothing else. The vehicle builders hand out
// meshes over a per-spec geometry cache and the shared material factory — the
// same buffers and programs every battle draws — so `keep` lists the geometry
// that came from a builder (tanks.js stamps only its cache container as shared,
// not the geometries inside it), and anything materials.js stamped is skipped.
function disposeTree(root, keep = null) {
  root.traverse((o) => {
    if (o.isMesh || o.isLine || o.isPoints || o.isInstancedMesh) {
      const g = o.geometry;
      if (g && !isShared(g) && !(keep && keep.has(g))) g.dispose?.();
      const mat = o.material;
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const mm of mats) if (mm && !isShared(mm)) mm.dispose?.();
    }
  });
}

// The attitude a taildragger rests at on its own wheels: the nose-up pitch that
// puts the bottoms of the main tyres and the tailwheel on one level. Solved from
// the real undercarriage the plane builder draws, so every type sits on all
// three of its wheels however long its legs are. Null when the gear is missing.
function restingPitch(group) {
  const main = group.getObjectByName('gearMainLTyre') || group.getObjectByName('gearMainRTyre');
  const tail = group.getObjectByName('gearTailTyre');
  if (!main || !tail) return null;
  group.rotation.x = 0;
  group.updateMatrixWorld(true);
  const bm = new THREE.Box3().setFromObject(main);
  const bt = new THREE.Box3().setFromObject(tail);
  if (bm.isEmpty() || bt.isEmpty()) return null;
  const cm = bm.getCenter(new THREE.Vector3());
  const ct = bt.getCenter(new THREE.Vector3());
  // a tyre is a disc in the YZ plane, so its lowest point is the hub minus its
  // radius whatever the pitch
  const rm = (bm.max.y - bm.min.y) / 2;
  const rt = (bt.max.y - bt.min.y) / 2;
  const gap = (a) => (cm.y * Math.cos(a) - cm.z * Math.sin(a) - rm)
    - (ct.y * Math.cos(a) - ct.z * Math.sin(a) - rt);
  let lo = -0.5;
  let hi = 0.15;
  if (gap(lo) * gap(hi) > 0) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (gap(lo) * gap(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
export class Hangar3D {
  constructor(canvas) {
    this.canvas = canvas || null;
    this.dead = true;          // stays true until a renderer actually exists
    this.running = false;
    this.frame = 0;
    this.lastMs = 0;
    this.clockS = 0;

    this.spec = null;
    this.kind = null;
    this.built = null;         // whatever the vehicle builder returned
    this.modelRoot = null;
    this.gear = null;
    this.fadeMats = [];        // materials the swap transition drives
    this.swapT = 1;
    this.padTop = 0;           // slab level, replaced once the stage is built

    this.yaw = 0.9;
    this.pitch = BASE_PITCH;
    this.dist = 18;
    this.distTarget = 18;
    this.fitDist = 18;
    this.idle = 0;             // seconds of user control still owed
    this.dragging = false;
    this.pointerId = -1;
    this.lastPx = 0;
    this.lastPy = 0;

    this.pixelCap = 2;
    this.shadowSize = 2048;
    this.quality = 'high';
    // L-09 budget (STAGE_MAX_PIXELS): the drawing buffer's scale under the cap
    this.renderScale = 1;
    this.gpuName = '';
    this.rig = null;           // the battle light rig (createPhotoRig)
    this.postfx = null;        // the battle post chain (createPostFX)
    // K-03: the focus sphere (world centre, radius) of the vehicle on the
    // stage, and the stage's own passes in that chain (installStagePasses)
    this.focusCentre = new THREE.Vector3(0, 1.4, 0);
    this.focusRadius = 0;
    this.dofOn = true;
    this.dofPass = null;
    this.aaPass = null;
    // K-01 / R3-S: the player's Film grain toggle (garage settings). The
    // stage never takes motion blur: its orbit is a menu, not a shot.
    this.lensGrain = true;
    // L-09: the shadow map's redraw cadence (SHADOW_EVERY, shadowDirty)
    this.shadowTick = 0;
    this.shadowDirty = true;
    this.shadowSig = '';
    this.renderStamp = -1;
    // A view that takes the stage over (the garage's X-ray and protection
    // analysis): while set, each frame is drawn by it, with this renderer.
    this.overlay = null;

    if (!this.canvas) return;

    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    } catch (err) {
      // A second WebGL context is not always available — the browser caps them,
      // and the thumbnail renderer plus the battle renderer may already hold
      // two. The menu is fully usable with a dead canvas, so say nothing.
      this.renderer = null;
      return;
    }

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.renderer.setPixelRatio(Math.min(dpr, this.pixelCap));
    this.gpuName = gpuNameOf(this.renderer);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // AgX at the stage preset's battle exposure (L-02, L-09): set by the rig.
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    // The far plane a battle camera gets (scenery.js CAMERA_REACH): the
    // height fog dissolves the terrain's 7 km skirt between 6.3 and 7 km, so
    // the hangar horizon is the battle horizon, not a cut at 1.4 km.
    this.camera = new THREE.PerspectiveCamera(FOV, 1.6, 0.5, 8200);

    this.buildStage();
    this.buildPost();
    this.attachInput();
    this.resize();
    this.dead = false;
  }

  // The composed preset the stage is lit with (L-09), for the calibration
  // card and anyone who wants to start a battle in the same light.
  get stagePreset() {
    return STAGE;
  }

  // The battle's post chain on this renderer (HANGAR_POST, STAGE_POST_TIER).
  // Built once; a quality change re-tiers it. A chain that will not build
  // leaves the plain render path. `over` lets the calibration / bench rebuild
  // it to compare (the old chain is handed back first).
  buildPost(over = {}) {
    if (this.postfx) {
      try {
        this.postfx.dispose();
      } catch (err) {
        /* replaced regardless */
      }
      this.postfx = null;
    }
    try {
      this.postfx = createPostFX(this.renderer, this.scene, this.camera, {
        quality: STAGE_POST_TIER[this.quality] || 'medium',
        preset: STAGE,
        ...HANGAR_POST,
        ...over,
      });
    } catch (err) {
      this.postfx = null;
    }
    if (this.postfx) {
      this.installStagePasses();
      this.applyLens();
    }
  }

  // K-03 DOF before OutputPass, FXAA after it, in whatever chain the battle
  // module builds at this tier. The chain hands its pass list to a hook after
  // every (re)build (setPassHook, which the bench also uses to time passes);
  // the stage keeps that hook for itself and chains anybody else's behind it,
  // so a re-tier or a bench run never loses the two passes.
  installStagePasses() {
    const fx = this.postfx;
    if (!fx || typeof fx.setPassHook !== 'function') return;
    if (!this.dofPass) this.dofPass = new StageDofPass(this);
    if (!this.aaPass) this.aaPass = makeStageFxaa();
    const set = fx.setPassHook.bind(fx);
    let outer = null;
    const mine = (passes) => {
      this.spliceStagePasses(passes);
      if (outer) outer(passes);
    };
    fx.setPassHook = (fn) => {
      outer = typeof fn === 'function' ? fn : null;
      set(mine);
    };
    set(mine);
  }

  // Idempotent: the hook runs again on every rebuild and every setPassHook.
  spliceStagePasses(passes) {
    if (!Array.isArray(passes)) return;
    for (const p of [this.dofPass, this.aaPass]) {
      const i = passes.indexOf(p);
      if (i >= 0) passes.splice(i, 1);
    }
    const out = passes.findIndex((p) => p && p.__kind === 'output');
    if (out < 0) return;
    const v = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.dofPass.setSize(v.x, v.y);
    passes.splice(out, 0, this.dofPass);
    // a chain that brought its own edge filter keeps it
    if (!passes.some((p) => p && (p.__kind === 'fxaa' || p.__kind === 'smaa'))) {
      this.aaPass.setSize(v.x, v.y);
      passes.splice(out + 2, 0, this.aaPass);
    }
  }

  // K-03: is there a subject to focus on, through a chain that has depth?
  dofWanted() {
    return !!(this.dofOn && !this.dead && !this.overlay && this.modelRoot && this.modelRoot.visible
      && this.focusRadius > 0 && this.postfx && this.postfx.depthTexture);
  }

  // R3-S: { grain: bool } from the garage settings (progress.settings
  // .filmGrain). blur is ignored on purpose: the stage never blurs.
  setLens(o = {}) {
    if (o && o.grain !== undefined) this.lensGrain = o.grain !== false;
    this.applyLens();
  }

  applyLens() {
    try {
      this.postfx?.setLens?.({ grain: this.lensGrain });
    } catch (err) {
      /* a chain without a lens keeps the picture it has */
    }
  }

  // -------------------------------------------------------------------------
  buildStage() {
    const preset = STAGE;
    const rng = rngFrom(hashString(preset.id) ^ 0x5eed);

    // ---- the battle rig (L-09) ----
    // Sun, hemisphere, sky dome, the dome's PMREM (then the HDRI), height fog
    // in the horizon colour, the preset's AgX exposure and bloom threshold:
    // everything a battle on this preset would build, from the same numbers.
    this.rig = createPhotoRig(this.renderer, this.scene, preset, { hdri: true });

    const levels = padLevels();
    this.padTop = levels.top;

    // Ground: the project's own heightmap, at a fraction of a battle's density.
    // Nothing here writes the terrain seed, so whatever layout the last battle
    // left loaded is what the hangar looks out over — which is fine, and is one
    // fewer piece of global state the menu can corrupt.
    this.terrain = buildTerrain(560, 72, preset);
    this.terrain.castShadow = false;
    this.scene.add(this.terrain);
    // L-09 budget (STAGE_ORDER): the ground and the dome after the vehicle,
    // the slab and the backdrop, so early-Z drops the pixels those cover
    // (measured 2.8 ms of a 1.1 MP Iris Xe frame for the ground, 0.45 for the
    // dome). Opaque only; no blending depends on the order.
    this.terrain.renderOrder = STAGE_ORDER.terrain;
    if (this.terrain.userData.skirt) this.terrain.userData.skirt.renderOrder = STAGE_ORDER.terrain;
    if (this.rig.sky) this.rig.sky.renderOrder = STAGE_ORDER.sky;

    this.backdrop = buildBackdrop(preset, rng);
    for (const part of this.backdrop.parts) this.scene.add(part);

    this.pad = buildHardstand(levels.top, levels.bottom, preset);
    this.scene.add(this.pad.group);

    this.contact = buildContactShadow();
    this.contact.mesh.position.y = levels.top + 0.012;
    this.contact.mesh.visible = false;
    this.scene.add(this.contact.mesh);

    // ---- the sun's shadow ----
    // The light is the battle's: the sun on the dome with the battle's caster
    // floor (5.7 degrees), so a dawn hangar gets dawn's long shadows. The box
    // stays on the slab; its depth range starts 20 m sunward of the vehicle,
    // so the backdrop trees and rocks (26 m and further out) never throw the
    // vehicle into shade under a low sun — the hangar is a portrait, the
    // treeline is scenery.
    this.key = this.rig.sun;
    this.hemi = this.rig.hemi;
    const SUN_DIST = 40;
    this.key.target.position.set(0, levels.top + 1, 0);
    this.key.position.copy(this.rig.casterDir).multiplyScalar(SUN_DIST).add(this.key.target.position);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(this.shadowSize, this.shadowSize);
    this.key.shadow.camera.near = SUN_DIST - 20;
    this.key.shadow.camera.far = SUN_DIST + 30;
    this.key.shadow.camera.left = -14;
    this.key.shadow.camera.right = 14;
    this.key.shadow.camera.top = 14;
    this.key.shadow.camera.bottom = -14;
    // texel 28 m / map: the bias derivation scenery.js uses for the battle
    const texel = 28 / this.shadowSize;
    this.key.shadow.bias = -(texel / 50) * 8;
    this.key.shadow.normalBias = texel * 1.8;
    this.key.shadow.camera.updateProjectionMatrix();
    this.key.target.updateMatrixWorld();
    this.key.updateMatrixWorld();
  }

  // -------------------------------------------------------------------------
  attachInput() {
    const el = this.canvas;
    this.onDown = (e) => {
      if (this.dragging) return;
      this.dragging = true;
      this.pointerId = e.pointerId;
      this.lastPx = e.clientX;
      this.lastPy = e.clientY;
      this.idle = IDLE_RESUME;
      // Pointer capture keeps the drag on this canvas: the class is not allowed
      // to hang listeners on window, and a drag that dies at the canvas edge is
      // worse than no drag at all.
      if (el.setPointerCapture) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch (err) {
          // capture is a nicety; the drag still works inside the canvas
        }
      }
    };
    this.onMove = (e) => {
      if (!this.dragging || e.pointerId !== this.pointerId) return;
      const dx = e.clientX - this.lastPx;
      const dy = e.clientY - this.lastPy;
      this.lastPx = e.clientX;
      this.lastPy = e.clientY;
      this.yaw -= dx * 0.007;
      this.pitch = clamp(this.pitch + dy * 0.004, 0.04, 0.85);
      this.idle = IDLE_RESUME;
    };
    this.onUp = (e) => {
      if (e.pointerId !== this.pointerId) return;
      this.dragging = false;
      this.pointerId = -1;
      this.idle = IDLE_RESUME;
      if (el.releasePointerCapture) {
        try {
          el.releasePointerCapture(e.pointerId);
        } catch (err) {
          // already released with the pointer
        }
      }
    };
    this.onWheel = (e) => {
      e.preventDefault();
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.distTarget = clamp(
        this.distTarget * (1 + step * 0.0011),
        this.fitDist * 0.55,
        this.fitDist * 2.1,
      );
      this.idle = IDLE_RESUME;
    };

    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
  }

  detachInput() {
    const el = this.canvas;
    if (!el || !this.onDown) return;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointercancel', this.onUp);
    el.removeEventListener('wheel', this.onWheel);
    this.onDown = null;
  }

  // -------------------------------------------------------------------------
  setVehicle(spec, kind) {
    if (this.dead || !spec) return;
    const air = kind === 'air' || (!spec.hull && spec.span != null);
    const asKind = air ? 'air' : 'ground';
    if (this.spec === spec && this.kind === asKind) return;

    // (The environment map stays for the life of the stage: it used to be
    // disposed here, on the very first vehicle, which left every metal surface
    // in the hangar with nothing to reflect. dispose() hands it back.)
    this.clearVehicle();
    this.spec = spec;
    this.kind = asKind;

    let built;
    try {
      built = air
        ? buildPlaneMesh(spec, null, null)
        : buildTankMesh(spec, null, null);
    } catch (err) {
      // A spec the builder cannot read must not take the menu down with it.
      this.spec = null;
      this.kind = null;
      return;
    }
    this.built = built;
    // everything the builder handed over draws from its per-spec cache
    this.builderGeos = new Set();
    built.group.traverse((o) => { if (o.geometry) this.builderGeos.add(o.geometry); });

    // The vehicle hangs under a root the swap transition can rotate without
    // fighting the idle animations inside the builder's own hierarchy.
    const root = new THREE.Group();
    root.add(built.group);

    if (air) {
      // Parked on its own undercarriage — the legs the builder draws for the
      // battle, lowered — and pitched until all three tyres touch. Only a build
      // without a gear rig falls back on the stand-in legs below.
      let pitch = null;
      if (setPlaneGear) {
        try {
          setPlaneGear(built, 1);
          pitch = restingPitch(built.group);
        } catch (err) {
          pitch = null;
        }
      }
      if (pitch === null) {
        if (setPlaneGear) {
          try { setPlaneGear(built, 0); } catch (err) { /* no rig at all */ }
        }
        this.gear = buildLandingGear(spec);
        built.group.add(this.gear.group);
        pitch = -PARK_PITCH;
      }
      // Negative pitch is nose-up in this frame. A fighter sitting nose-high on
      // its tailwheel is most of what makes it look parked rather than dropped.
      built.group.rotation.x = pitch;
    }

    this.scene.add(root);
    this.modelRoot = root;

    // Sit whatever came back on the slab, measured rather than assumed: the
    // tank builder puts its origin at ground level, the plane builder puts its
    // origin on the thrust line, and the gear moves that again.
    root.updateMatrixWorld(true);
    visibleBounds(root, _box);
    _box.getSize(_size);
    _box.getCenter(_center);
    root.position.y = this.padTop - _box.min.y;

    this.modelHeight = _size.y;
    this.modelCenterY = this.padTop + (_center.y - _box.min.y) * 0.92;
    this.modelRadius = 0.5 * Math.hypot(_size.x, _size.z);
    // K-03: the bounding sphere, where the root now stands (the swap turns
    // the root about its own vertical axis, which the sphere does not mind)
    this.focusCentre.set(_center.x, this.padTop + (_center.y - _box.min.y), _center.z);
    this.focusRadius = 0.5 * _size.length();
    this.shadowDirty = true;

    // An ellipse under the plan-form rather than a circle round the bounding
    // sphere: a circle big enough for a Mustang's span would run off the slab.
    this.contact.mesh.visible = true;
    this.contact.mesh.scale.set(
      clamp(_size.x * 0.55, 1.6, PAD_HX * 0.9),
      1,
      clamp(_size.z * 0.55, 1.6, PAD_HZ * 0.9),
    );

    // Collect the fresh materials so the swap can fade them in. They belong to
    // this build alone — the builders make new ones every call — so writing
    // opacity here can never leak into a battle's meshes.
    this.fadeMats.length = 0;
    root.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || m.userData.hangarBase !== undefined) continue;
        m.userData.hangarBase = m.opacity;
        m.userData.hangarWasTransparent = m.transparent;
        this.fadeMats.push(m);
      }
    });

    this.swapT = 0;
    this.refit();
  }

  clearVehicle() {
    // A swap interrupted half way must not leave the factory's shared armour
    // and steel half transparent for the battle that draws them next.
    this.finishFade();
    if (this.modelRoot) {
      this.scene.remove(this.modelRoot);
      disposeTree(this.modelRoot, this.builderGeos);
      this.modelRoot = null;
    }
    // The stand-in gear's geometries and materials are ours and shared between
    // its own meshes, so disposeTree has already handed them back.
    this.gear = null;
    this.builderGeos = null;
    this.built = null;
    this.fadeMats.length = 0;
    if (this.contact) this.contact.mesh.visible = false;
    this.focusRadius = 0;
    this.shadowDirty = true;
  }

  // The distance at which this vehicle fills the frame at the current aspect.
  refit() {
    if (this.dead || !this.modelRoot) return;
    const aspect = this.camera.aspect || 1.6;
    const tanV = Math.tan((FOV * Math.PI) / 360);
    const halfW = this.modelRadius || 4;
    const halfH = (this.modelHeight || 3) * 0.5;
    const needV = (halfH * 1.9) / tanV;
    const needH = (halfW * 1.25) / (tanV * aspect);
    const prev = this.fitDist || 1;
    const zoom = clamp(this.distTarget / prev, 0.55, 2.1);
    this.fitDist = Math.max(needV, needH, 8) + halfW;
    if (this.swapT < 1) {
      // A new vehicle is framed from scratch: a Stuart's distance on a Mustang
      // would put half the aeroplane outside the stage.
      this.distTarget = this.fitDist;
      this.dist = this.fitDist * 1.06;
    } else {
      // A window resize keeps whatever dolly the player is holding.
      this.distTarget = this.fitDist * zoom;
    }
  }

  // -------------------------------------------------------------------------
  setQuality(level) {
    if (this.dead) return;
    // L-09 (wave 3c): never above what this machine's GPU gets in battle
    // (postFXQualityFor with the WebGL renderer string: Intel integrated
    // graphics is "medium"); garage.js asks by core count alone
    let want = QUALITY_ORDER.includes(level) ? level : 'high';
    try {
      const cap = postFXQualityFor({ gpu: this.gpuName || gpuNameOf(this.renderer) });
      if (QUALITY_ORDER.indexOf(want) > QUALITY_ORDER.indexOf(cap)) want = cap;
    } catch {
      /* keep the requested tier */
    }
    const low = want === 'low';
    this.quality = want;
    this.pixelCap = low ? 1 : 2;
    // a 28 m box: 2.7 cm texels at 1024 still out-resolve the PCF blur below high
    this.shadowSize = want === 'high' ? 2048 : 1024;
    this.applyPixelRatio();
    if (this.key.shadow.mapSize.x !== this.shadowSize) {
      this.key.shadow.mapSize.set(this.shadowSize, this.shadowSize);
      const texel = 28 / this.shadowSize;
      this.key.shadow.bias = -(texel / 50) * 8;
      this.key.shadow.normalBias = texel * 1.8;
      // The map is allocated lazily from mapSize, so the old one has to go back
      // before the next render or the change is ignored for the session.
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    this.shadowDirty = true;
    // the battle chain at the stage's chain tier (STAGE_POST_TIER): low draws
    // straight to the canvas; a rebuild re-runs the stage's pass hook
    try {
      this.postfx?.setQuality(STAGE_POST_TIER[this.quality] || 'medium');
    } catch (err) {
      /* the chain keeps the tier it has */
    }
    this.resize();
  }

  // device pixels x the tier's cap, then scaled under STAGE_MAX_PIXELS (L-09)
  applyPixelRatio() {
    if (!this.renderer) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const base = Math.min(dpr, this.pixelCap);
    const w = (this.canvas && this.canvas.clientWidth) | 0;
    const h = (this.canvas && this.canvas.clientHeight) | 0;
    const px = w * h * base * base;
    const cap = STAGE_MAX_PIXELS[this.quality] || STAGE_MAX_PIXELS.high;
    this.renderScale = px > cap ? Math.sqrt(cap / px) : 1;
    const ratio = base * this.renderScale;
    if (Math.abs(this.renderer.getPixelRatio() - ratio) > 1e-4) this.renderer.setPixelRatio(ratio);
  }

  // the stage's pixel budget at work (debug: __calib.stage.budget)
  get budget() {
    const el = this.renderer ? this.renderer.domElement : null;
    const dp = this.dofPass;
    return {
      quality: this.quality,
      chain: this.postfx ? this.postfx.getQuality() : 'none',
      scale: +this.renderScale.toFixed(3),
      buffer: el ? [el.width, el.height] : null,
      maxPixels: STAGE_MAX_PIXELS[this.quality] || STAGE_MAX_PIXELS.high,
      shadowEvery: SHADOW_EVERY,
      dof: dp ? {
        on: this.dofWanted(),
        focus: +dp.band.focus.toFixed(2),
        near: +dp.band.near.toFixed(2),
        far: +dp.band.far.toFixed(2),
        cocMaxPx: +dp.lastCocMax.toFixed(2),
      } : null,
      grain: this.lensGrain,
      gpu: this.gpuName || '',
    };
  }

  resize() {
    if (!this.renderer) return;
    const w = this.canvas.clientWidth | 0;
    const h = this.canvas.clientHeight | 0;
    if (w <= 0 || h <= 0) return;
    // the pixel cap follows the canvas size (L-09)
    this.applyPixelRatio();
    this.renderer.setSize(w, h, false);
    this.postfx?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.refit();
  }

  // -------------------------------------------------------------------------
  start() {
    if (this.dead || this.running) return;
    this.running = true;
    this.lastMs = 0;
    // K-05, as in battle: the turntable is stepped on the display's interval
    // (the rAF timestamp, the measured refresh interval, the scheduling noise
    // paid back slowly), so the slow orbit does not judder. Clamped at both
    // ends as before: a tab restored after a minute advances 0.1 s, and a
    // clock that steps backwards steps nothing.
    if (!this.pacer) this.pacer = createFramePacer({ maxStep: 0.1 });
    this.pacer.reset();
    const tick = (ms) => {
      if (!this.running) return;
      this.frame = requestAnimationFrame(tick);
      this.lastMs = ms;
      this.update(this.pacer.step(ms));
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastMs = 0;
    this.dragging = false;
    this.pointerId = -1;
    // the materials being faded belong to the shared factory, and the battle
    // that is about to start draws with them
    this.finishFade();
  }

  // Snap the swap transition to its end: opacity and transparency back to what
  // the materials had. Safe to call at any time.
  finishFade() {
    if (this.swapT >= 1) return;
    this.swapT = 1;
    for (const m of this.fadeMats) {
      m.opacity = m.userData.hangarBase;
      m.transparent = m.userData.hangarWasTransparent;
    }
    if (this.modelRoot) this.modelRoot.rotation.y = 0;
  }

  // Hand the stage to another view (or back, with null). The loop, the canvas
  // and the renderer stay this class's; the view only draws the frames.
  setOverlay(view) {
    this.overlay = view && typeof view.renderFrame === 'function' ? view : null;
    if (this.overlay) {
      this.dragging = false;
      this.pointerId = -1;
      this.finishFade();
    }
  }

  update(dt) {
    if (this.dead) return;
    this.clockS += dt;

    // A canvas nobody can see is not worth drawing, but document.hidden is the
    // wrong way to ask: an embedded webview or an offscreen pane reports hidden
    // while it is perfectly well composited, and the stage then never draws a
    // single frame. Browsers already stop calling requestAnimationFrame in a
    // genuinely backgrounded tab, so the size check below is the only guard the
    // loop actually needs.
    const w = this.canvas.clientWidth | 0;
    const h = this.canvas.clientHeight | 0;
    if (w <= 0 || h <= 0) return;
    const buf = this.renderer.domElement;
    const ratio = this.renderer.getPixelRatio();
    if (Math.abs(buf.width - w * ratio) > 1 || Math.abs(buf.height - h * ratio) > 1) {
      this.resize();
    }

    if (this.overlay) {
      // N25: the view draws straight to the canvas with its own hand-encoded,
      // toneMapped:false materials. The composer is skipped altogether (the
      // vehicle is an X-ray now, not paint), so OutputPass never touches the
      // overlay and its legend colours land on screen as authored.
      try {
        this.renderer.setRenderTarget(null);
        this.overlay.renderFrame(this.renderer, dt, w, h);
      } catch (err) {
        // a broken overlay must not take the stage down: drop it, carry on
        this.overlay = null;
      }
      return;
    }

    // ---- swap transition: the turntable settling, not a cut ----
    if (this.swapT < 1) {
      // the vehicle turns under the sun: its shadow follows every frame
      this.shadowDirty = true;
      this.swapT = Math.min(1, this.swapT + dt / 0.75);
      const e = smoothstep(this.swapT);
      if (this.modelRoot) this.modelRoot.rotation.y = (1 - e) * -0.65;
      for (const m of this.fadeMats) {
        m.transparent = true;
        m.opacity = m.userData.hangarBase * e;
      }
      if (this.swapT >= 1) {
        for (const m of this.fadeMats) {
          m.opacity = m.userData.hangarBase;
          m.transparent = m.userData.hangarWasTransparent;
        }
        if (this.modelRoot) this.modelRoot.rotation.y = 0;
      }
    }

    // ---- camera ----
    if (this.idle > 0) {
      this.idle -= dt;
    } else if (!this.dragging) {
      this.yaw += AUTO_RATE * dt;
      // Ease back to the house angle once the player has stopped playing with it
      const k = 1 - Math.exp(-dt * 1.6);
      this.pitch += (BASE_PITCH - this.pitch) * k;
      this.distTarget += (this.fitDist - this.distTarget) * k;
    }
    this.dist += (this.distTarget - this.dist) * (1 - Math.exp(-dt * 3.4));

    _target.set(0, this.modelCenterY ?? this.padTop + 1.4, 0);
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      _target.x + Math.sin(this.yaw) * cp * this.dist,
      _target.y + Math.sin(this.pitch) * this.dist,
      _target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    this.camera.lookAt(_target);

    // ---- idle animation ----
    const built = this.built;
    if (built) {
      if (built.props) {
        // A cold engine turning over in the breeze, not a running one
        for (let i = 0; i < built.props.length; i++) built.props[i].rotation.z += dt * 1.4;
      }
      if (built.turretGroup) {
        built.turretGroup.rotation.y = Math.sin(this.clockS * 0.21) * 0.15;
      }
      if (built.gunGroup) {
        built.gunGroup.rotation.x = Math.sin(this.clockS * 0.15) * 0.03 + 0.02;
      }
    }

    // L-09 budget: the shadow map is redrawn on a cadence (SHADOW_EVERY) or
    // when a caster moved for real. Only for this loop's own frames: anyone
    // drawing the stage another way (the calibration board, which also moves
    // the shadow box) gets three's every-frame default back.
    const sm = this.renderer.shadowMap;
    this.shadowTick = (this.shadowTick + 1) % SHADOW_EVERY;
    // a map drawn by someone else's frame (a widened calibration box, say)
    // is not this loop's map: the box it was drawn for is the signature
    const sc = this.key.shadow.camera;
    const kp = this.key.position;
    const sig = `${sc.left},${sc.right},${sc.top},${sc.bottom},${sc.near},${sc.far},${kp.x},${kp.y},${kp.z},${this.key.shadow.mapSize.x}`;
    if (sig !== this.shadowSig || !this.key.shadow.map) this.shadowDirty = true;
    this.shadowSig = sig;
    // ...and a draw nobody here made since this loop's last frame (the board
    // shot puts its box back before this frame looks) counts as one too
    const info = this.renderer.info && this.renderer.info.render;
    if (info && info.frame !== this.renderStamp) this.shadowDirty = true;
    const shadowDue = this.shadowDirty || this.shadowTick === 0;
    this.shadowDirty = false;
    try {
      // the HDRI swap and the IBL (re)bake, on the frames that need one
      this.rig?.update();
      sm.autoUpdate = false;
      sm.needsUpdate = shadowDue;
      if (this.postfx) this.postfx.render(dt);
      else this.renderer.render(this.scene, this.camera);
      if (info) this.renderStamp = info.frame;
    } catch (err) {
      // A lost context is fatal to the stage but not to the menu around it.
      this.dead = true;
      this.stop();
    } finally {
      if (this.renderer) sm.autoUpdate = true;
    }
  }

  // -------------------------------------------------------------------------
  dispose() {
    this.stop();
    this.detachInput();
    if (!this.renderer) {
      this.dead = true;
      return;
    }
    this.clearVehicle();

    if (this.terrain) {
      this.scene.remove(this.terrain);
      this.terrain.geometry.dispose();
      this.terrain.material.dispose();
      this.terrain = null;
    }
    if (this.backdrop) {
      for (const part of this.backdrop.parts) {
        this.scene.remove(part);
        part.dispose?.();
      }
      for (const g of this.backdrop.geometries) g.dispose();
      for (const m of this.backdrop.materials) m.dispose();
      this.backdrop = null;
    }
    if (this.pad) {
      this.scene.remove(this.pad.group);
      for (const g of this.pad.geometries) g.dispose();
      for (const m of this.pad.materials) m.dispose();
      this.pad = null;
    }
    if (this.contact) {
      this.scene.remove(this.contact.mesh);
      this.contact.geo.dispose();
      this.contact.mat.dispose();
      this.contact = null;
    }
    this.overlay = null;
    try {
      this.postfx?.dispose();
    } catch (err) {
      /* going away regardless */
    }
    this.postfx = null;
    // the stage's own passes (installStagePasses): the chain does not know them
    for (const p of [this.dofPass, this.aaPass]) {
      try {
        p?.dispose();
      } catch (err) {
        /* going away regardless */
      }
    }
    this.dofPass = null;
    this.aaPass = null;
    // the rig hands back its lights, the shadow map, the dome and the PMREM
    // target (a full mip chain); the HDRI texture is assets.js's, shared
    this.rig?.dispose();
    this.rig = null;
    this.key = null;
    this.hemi = null;
    this.scene.environment = null;
    this.scene.clear();

    this.renderer.dispose();
    const gl = this.renderer.getContext && this.renderer.getContext();
    const lose = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.dead = true;
  }
}

export default Hangar3D;
