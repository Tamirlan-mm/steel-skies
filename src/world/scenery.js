import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeVertices, mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  terrainHeight, terrainSlope, terrainFeatures, roadDistanceAt, WORLD_SIZE,
} from './terrain.js';
// terrain.js is being extended in parallel (terrainMeshInfo, the far skirt);
// the namespace import lets this file run against either version of it.
import * as terrainModule from './terrain.js';
import {
  MAP_PRESETS, SKY_SCALE, CASTER_FLOOR, FOG_SCALE_HEIGHT, ENV_GAIN_GLSL, envGainFor, envGroundOf,
} from './presets.js';
import {
  installAtmosphere, makeHeightFog, HEIGHT_FOG_GLSL, CIRRUS_GLSL, makeCirrusUniforms, setCirrus, driftCirrus,
} from '../core/atmosphere.js';
import { hdriFor, loadHDRI, assetStatus, hdriRotationY, assetsEnabled } from '../core/assets.js';
import { cloudVolumeFor, cloudFieldData, setActiveCloudVolume } from './clouds.js';
import { rand } from '../core/utils.js';
import { getMaterialQuality, isSharedResource, markSharedGeometry } from '../core/materials.js';
import { landUseFor, edgePointAt } from './landuse.js';
import { treeArchetypes, floraArchetype, hedgeClumpGeometry, farWoodGeometry } from './flora.js';
import { buildingKit } from './buildings.js';
import { createGroundCover } from './groundcover.js';
// the airfield registry: its buildings are solid to rounds and sight lines
// (airfield.js never imports this file, so no cycle)
import { activeAirfields } from './airfield.js';

// Sky, fog, lights, weather and the dressed landscape: woods, hedgerows,
// orchards, villages, rocks, fences, telegraph lines, distant woodland and the
// grass under the camera. Returns { sun } so the battle can keep the shadow
// camera near the player — plus the prop registry, the blocker list and the
// wind field for anything that wants them.
//
// Every prop lives in ONE instanced (or batched) mesh per part, and a prop that
// gets knocked down is rewritten in place: three thousand trees are still two
// draw calls per species whether they are standing, falling or lying flat.
//
// WHERE THINGS GO comes from world/landuse.js (fields, hedge lines, woods,
// orchards, village lots, pole line), WHAT they look like from flora.js (tree
// species, hedge clumps, far-wood hulls) and buildings.js (village kits). This
// file only places, registers and animates. See the DRESSING section below.
//
// ---------------------------------------------------------------------------
// THE OUTDOOR RIG (what used to be "a flat colour and two lights")
//
//   sky      one Preetham dome (three/examples/jsm/objects/Sky.js) driven from
//            preset.atm, moved with the camera, drawn last among the opaques so
//            it only shades the pixels the world did not already cover.
//   fog      exponential HEIGHT fog (core/atmosphere.js, L-06) at the preset's
//            visibility / 2.5, whose colour is the sky's own horizon
//            radiance, computed on the CPU in presets.js from the same four
//            Preetham numbers the dome is rendering. Aerial perspective only
//            reads as distance when the two agree exactly. It dissolves the
//            7 km skirt, and the driver gives the camera the far plane for it.
//   env      a PMREM built FROM that dome (sun disc off, lit ground below the
//            horizon) and hung on scene.environment, replaced by the preset's
//            CC0 HDRI (assets.js) as soon as that is decoded, so every
//            MeshStandardMaterial gets a real specular response and ambient.
//   light    all levels from preset.light (contract R1-K, L-01): the sun, a
//            hemisphere cut to the ground-bounce share, the IBL level, the
//            AgX exposure and the bloom threshold postfx.js picks up.
//   clouds   one camera-locked dome whose fragment shader intersects the view
//            ray with a horizontal plane and samples a canvas cloud field:
//            a real drifting deck for ONE draw call and ONE material.
//   shadow   one directional light from the sun on the dome (floor 5.7 deg) on
//            a box snapped to its own light-space texels that follows the
//            player, sized from the map and the tier (never the fog), trimmed
//            along the azimuth under a low sun, its edge faded (L-04).
//
// See the CSM note above updateSunAnchor() for why this is a snapped single
// cascade and not three/examples/jsm/csm/CSM.js.

const CELL = 32;             // spatial-hash cell for propsNear (m)
const MAX_PROP_R = 12;       // the largest prop radius, so a query expands by one cell
const FALL_TIME = 0.85;      // seconds a tree takes to go over
const COLLAPSE_TIME = 1.1;   // seconds a building takes to come down

// The sky dome rides with the camera, so its radius only has to be big enough
// that the box never intersects anything: the shader pins it to the far plane.
const SKY_RADIUS = 10000;
const CLOUD_TEX = 256;       // cloud field resolution (generated once per session)

// ---------------------------------------------------------------------------
// Module state. One battle at a time; setupEnvironment resets it.
const props = [];
const falling = [];
const grid = new Map();
const owned = [];            // geometries/materials we created, for disposeScenery
const sceneObjects = [];     // meshes we added to the scene, ditto
const blockerList = [];      // live view of the solid props, kept in step by fellProp
let nextPropId = 1;
// The SOLID set — village buildings (standing, collapsing or in ruins) and
// rocks — kept apart from the main registry in its own dense grid, so the
// per-round segment test never walks the trees, hedges and fences a wood or a
// village street is full of. Each solid is listed in every cell its widest
// possible footprint touches, so a query only opens the cells its own segment
// crosses. Shell-trees and grove screens get a grid of the same shape. See
// "Query storage" and "Solid colliders".
const SG_HALF = 64;            // dense grid cells each side of the origin (x CELL = 2048 m)
const SG_N = SG_HALF * 2;
// the solids' own grid is finer, so a 7 m bullet step opens a cell or two
// holding a house or two, walked cell by cell along the segment
const SCELL = 8;               // m
const SS_HALF = 256;           // cells each side of the origin (x SCELL = 2048 m)
const SS_N = SS_HALF * 2;
const solidGrid = new Array(SS_N * SS_N);
const solidCells = [];         // grid slots in use, so a reset need not sweep 16k slots
const solids = [];             // the solid props, by p.si
let solidStamp = 0;
// Tank spawn strips no solid prop may stand in: [{ x0, x1, z0, z1 }], set per
// battle by setupEnvironment (see spawnStripsFor).
let spawnStrips = [];
let groundCover = null;      // groundcover.js handle for this battle
const purgeables = [];       // merged meshes a late keep-out can blank triangles of
const looseInstances = [];   // unregistered instanced visuals: { mesh, xz }
let effectsHook = null;
let precip = null;
let lastTick = -1e9;
let driverScene = null;      // the scene whose onBeforeRender we wrapped
let driverPrev = null;
let driverPrevAfter = null;
const clockMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// --- environment state -----------------------------------------------------
let sky = null;              // the Preetham dome in the battle scene
let skyUniforms = null;
// the dome's own extra uniforms (addSky): preset sky scale, and the bake mode
// that drops the sun disc and shows lit ground below the horizon (PMREM only)
const skyBake = {
  uSkyScale: { value: SKY_SCALE },
  uBake: { value: 0 },
  uGround: { value: new THREE.Vector3(0.02, 0.02, 0.018) },
  uFogCol: { value: new THREE.Vector3(0.2, 0.22, 0.25) },
};
// S-01 cirrus, drawn by the dome (core/atmosphere.js CIRRUS_GLSL)
const skyCirrus = makeCirrusUniforms();
let clouds = null;           // the camera-locked cloud deck
let cloudUniforms = null;
let cloudTexture = null;     // generated once per session, cover is a uniform
let sunLight = null;
let hemiLight = null;
let envScene = null;         // holds the sky alone while the PMREM is baked
let pmrem = null;
let envTarget = null;
let envDirty = false;
let envFailed = false;
let activeScene = null;
let activePresetRef = null;
let exposure = 0;            // 0 = leave the renderer's exposure alone
let exposureSaved = null;
// --- light lane (R1-A): HDRI image-based light, height fog, camera reach ---
// The height-fog chunks (core/atmosphere.js) must be in ShaderChunk before
// ANY program compiles; this module is evaluated before the first render.
installAtmosphere();
let heightFog = false;       // this battle's fog is the L-06 height law
let hdriId = null;           // the HDRI chosen for this preset (assets.js)
let hdriTex = null;          // its equirect texture (placeholder until loaded)
let hdriSphere = null;       // env-bake-only sphere that draws it
let hdriMix = 0;             // 0 = procedural dome only, 1 = HDRI only
let hdriTarget = 0;          // where hdriMix is heading
let hdriBaked = -1;          // the hdriMix of the PMREM in use
let hdriGain = null;         // presets.envGainFor: the SH gain that calibrates it
let envClock = 0;            // seconds since this environment was set up
const HDRI_FADE = 1.6;       // s, crossfade when the HDRI arrives mid-battle
const HDRI_STEP = 0.2;       // re-bake whenever hdriMix moved this much
const CAMERA_REACH = 8200;   // m: far plane the height fog's far-fade needs

// Shadow rig. `sunDir` is the preset's true sun (used by the sky and the light
// colour); `casterDir` is the same vector with its elevation floored, because a
// shadow cast from eight degrees is a mile long and all aliasing.
const sunDir = new THREE.Vector3(0.5346, 0.8018, 0.2673);
const casterDir = new THREE.Vector3(0.5346, 0.8018, 0.2673);
let shadowHalf = 300;
let shadowHalfY = 300;       // light-space Y half (along the sun azimuth), L-04
let shadowMapSize = 2048;
let sunDist = 900;
let anchorObject = null;     // optional: follow this instead of the render camera
const anchorPos = new THREE.Vector3();

// Keep-out discs. Registered before setupEnvironment (or through opts.keepOut)
// so trees and rocks stop scattering across the airfield strips.
const pendingKeepOuts = [];
const keepOutDiscs = [];

export const wind = { x: 1, z: 0, strength: 0, dir: new THREE.Vector3(1, 0, 0) };
const windUniforms = { time: { value: 0 }, vec: { value: new THREE.Vector2(0, 0) } };

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
// propSegmentHit's answer: one record, refilled per call (see there)
const _segRes = { prop: null, point: _hitPoint, t: 0, normal: new THREE.Vector3(0, 1, 0) };
const _queryA = [];
const _queryB = [];
const _blast = { y: 0, dirX: 0, dirZ: 0 };   // reused opts for sceneryDamageAt
const _push = { dirX: 0, dirZ: 0 };          // reused push vector for damagePropsAt
const NO_CRUSH = { felled: 0, blocked: null };  // shared, never mutated
const _crushRes = { felled: 0, blocked: null };  // crushProps' answer when there is one

// ---------------------------------------------------------------------------
export function setupEnvironment(scene, opts = {}) {
  const {
    fogNear = 260,
    fogFar = 1300,
    propArea = WORLD_SIZE,
    trees = 240,
    rocks = 80,
    houses = 10,
    fences = 5,
    preset = MAP_PRESETS.meadow,
    effects = null,
    // NEW, all optional — every existing caller gets the same signature it had.
    keepOut = null,            // [{ x, z, r }] discs no scattered prop may enter
    spawnKeepOut = null,       // [{ x0, x1, z0, z1 }] tank spawn strips; null = by map
    shadowRadius = 0,          // metres; 0 = from the map and the tier (L-04)
    shadowMapSize: mapSizeOpt = 0,
    fogType = 'auto',          // 'auto' | 'linear' | 'exp2'
    environment = true,        // build the sky-derived PMREM
    skyDome = true,
    cloudLayer = true,
  } = opts;

  // The previous battle's scene has already been thrown away by the time a new
  // one is built (main.js disposes before it constructs), so this is the last
  // chance to hand its buffers back to the driver. resetScenery alone would
  // leave a battle's worth of geometry strongly referenced for the session.
  const carried = pendingKeepOuts.splice(0, pendingKeepOuts.length);
  disposeScenery();
  effectsHook = effects;
  activeScene = scene;
  activePresetRef = preset;

  // Keep-out discs registered before this call survive disposeScenery — they
  // describe the map that is about to be built, not the one being torn down.
  for (const k of carried) pushKeepOut(k);
  if (Array.isArray(keepOut)) for (const k of keepOut) pushKeepOut(k);

  const fogNearMul = preset.fogNearMul ?? 1;
  const fogFarMul = preset.fogFarMul ?? 1;
  const far = fogFar * fogFarMul;

  // --- sun vectors --------------------------------------------------------
  const dir = preset.sunDir || { x: 0.5346, y: 0.8018, z: 0.2673 };
  sunDir.set(dir.x, dir.y, dir.z).normalize();
  // The light that shades the world comes from the sun on the dome (C-23,
  // L-04): the caster keeps a floor only below 5.7 degrees (CASTER_FLOOR), so
  // the dawn (8) and dusk (6) suns light the world from where they are drawn.
  const sy = Math.max(CASTER_FLOOR, sunDir.y);
  const flat = Math.hypot(sunDir.x, sunDir.z) || 1;
  const scaleXZ = Math.sqrt(Math.max(0.0001, 1 - sy * sy)) / flat;
  casterDir.set(sunDir.x * scaleXZ, sy, sunDir.z * scaleXZ).normalize();

  // --- fog, tuned to the sky it sits under --------------------------------
  // preset.horizonRGB is the Preetham horizon evaluated on the CPU from the
  // same numbers the dome renders, in linear radiance — which is the space
  // Fog.color is uploaded in and the space <fog_fragment> mixes in, BEFORE
  // tone mapping. A fully fogged pixel therefore comes out of ACES bit-identical
  // to the sky behind it, which is the whole trick behind aerial perspective.
  const fogColor = new THREE.Color();
  const hz = preset.horizonRGB;
  if (hz) fogColor.setRGB(hz[0], hz[1], hz[2], THREE.LinearSRGBColorSpace);
  else fogColor.setHex(preset.fog ?? 0xb8cfe4);

  // L-06: exponential HEIGHT fog at the preset's compressed visibility (C-30,
  // C-31, C-33), with the far-fade that dissolves the 7 km skirt (C-34). The
  // battle's fogNear / fogFar no longer set the veil; 'linear' / 'exp2' still
  // ask for the old laws explicitly.
  const L = preset.light || null;
  heightFog = fogType === 'auto' || fogType === 'height';
  const wantExp2 = fogType === 'exp2';
  if (heightFog) {
    scene.fog = makeHeightFog(fogColor, L ? L.visibility : 10000, L ? L.fogScaleHeight : FOG_SCALE_HEIGHT);
  } else if (wantExp2) {
    // Linear fog over a 2.6 km air map either hides the ground at 800 m or does
    // nothing at all; exponential-squared keeps the near air clear and still
    // buries the map edge. sqrt(3)/far puts ~95% opacity at the old far plane.
    scene.fog = new THREE.FogExp2(0x000000, Math.sqrt(3) / Math.max(1, far));
    scene.fog.color.copy(fogColor);
  } else {
    scene.fog = new THREE.Fog(0x000000, fogNear * fogNearMul, far);
    scene.fog.color.copy(fogColor);
  }
  // The dome covers every pixel, so this is only insurance for the one frame
  // before it is built and for any camera that culls it — and a Color
  // background costs nothing beyond the clear the renderer does anyway.
  scene.background = fogColor.clone();

  // --- lights --------------------------------------------------------------
  // L-01: the hemisphere light is only the ground-bounce share; the sky comes
  // from the image-based light (preset.light, contract R1-K).
  const hemi = new THREE.HemisphereLight(
    preset.hemiSky ?? 0xcfe4ff, preset.hemiGround, L ? L.hemiIntensity : (preset.hemiIntensity ?? 1.15),
  );
  hemiLight = hemi;
  // bloom only from emitters (L-05): core/postfx.js reads this per frame
  scene.userData.bloomThreshold = L ? L.bloomThreshold : undefined;
  own(scene, hemi);

  const sun = new THREE.DirectionalLight(preset.sunColor ?? 0xfff2dd, preset.sunIntensity ?? 2.6);
  sunLight = sun;
  sun.castShadow = true;
  // Coverage, not crispness, was the bug: nothing past 130 m from the player
  // cast a shadow on a map 1500-2600 m across. The box is sized from how far
  // the map lets you see and the map is snapped to shadow texels every frame,
  // so widening it does not make the edges swim.
  // L-04 / A-30: the box is sized from the map and the tier, NEVER from the
  // fog (the height fog relaxes `far` and used to pin it at a blurry 520 m).
  shadowMapSize = mapSizeOpt > 0 ? mapSizeOpt : shadowSizeForQuality();
  shadowHalf = shadowRadius > 0 ? shadowRadius : shadowHalfFor(propArea, shadowMapSize);
  // Under a low sun the light-space Y axis runs along the sun's azimuth and
  // its ground footprint is 1/sin(elevation) long. Below 12 degrees it is
  // trimmed to a 1 : 1.6 footprint plus a 60 m relief margin, which buys
  // texels along the long shadows instead of spending them on empty ground.
  shadowHalfY = sy < Math.sin(12 * Math.PI / 180)
    ? Math.min(shadowHalf, 1.6 * shadowHalf * sy + 60)
    : shadowHalf;
  // depth must reach the far end of that footprint (it was always enough at noon)
  sunDist = Math.max(shadowHalf * 1.7 + 420, (shadowHalfY / sy) * Math.sqrt(1 - sy * sy) + 250);
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = sunDist * 2;
  sun.shadow.camera.left = -shadowHalf;
  sun.shadow.camera.right = shadowHalf;
  sun.shadow.camera.top = shadowHalfY;
  sun.shadow.camera.bottom = -shadowHalfY;
  // Derived rather than hand-tuned so the numbers stay right when the radius or
  // the map size changes: acne scales with texel size over the depth range.
  // Wave 3b fix: the depth bias was a flat 8 texels — 3.4 m on low (0.43 m
  // texels), 2.0 m on medium — deeper than a tank is tall, so on low
  // a tank cast no shadow at noon and the calibration roof shaded nothing. 8
  // texels is what a grazing sun needs (the ground's light-space depth runs
  // 1 / tan(elevation) texels per texel); a high sun needs 2. So it follows
  // the caster elevation: 2 texels from 45 degrees up, 8 at 14 degrees and
  // below. Noon: 0.29 / 0.51 / 0.86 m (high / medium / low).
  const texel = (shadowHalf * 2) / shadowMapSize;
  const biasTexels = Math.min(8, Math.max(2, 2 / Math.max(0.05, Math.tan(Math.asin(sy)))));
  sun.shadow.bias = -(texel / (sun.shadow.camera.far - sun.shadow.camera.near)) * biasTexels;
  sun.shadow.normalBias = texel * 1.8;
  sun.shadow.camera.updateProjectionMatrix();
  own(scene, sun, sun.target);
  anchorPos.set(0, 0, 0);
  placeSun(anchorPos);

  // Wind: drives the tree sway shader and is there for anything that wants to
  // drift smoke with the weather rather than straight up.
  const wd = preset.windDir ?? 0;
  wind.strength = preset.windStrength ?? 3;
  wind.x = Math.cos(wd);
  wind.z = Math.sin(wd);
  wind.dir.set(wind.x, 0, wind.z);
  const swayAmp = Math.min(wind.strength, 8) * 0.022;
  windUniforms.vec.value.set(wind.x * swayAmp, wind.z * swayAmp);
  windUniforms.time.value = 0;

  // --- sky, clouds, image-based lighting -----------------------------------
  exposure = preset.exposure ?? 0;
  if (skyDome) addSky(scene, preset);
  if (cloudLayer && skyDome) addClouds(scene, preset);
  // S-02: an air battle (far >= 2,000 m: the air and combined maps) publishes
  // the volumetric slab over the same field (world/clouds.js). The post chain
  // draws it on the high tier and hides the deck while it does; on medium and
  // low, or if the pass fails, the deck above is the sky's clouds (S-01).
  const cloudVol = clouds && fogFar >= 2000
    ? cloudVolumeFor(preset, { deck: clouds, field: cloudTexture, uniforms: cloudUniforms })
    : null;
  scene.userData.cloudVolume = cloudVol;
  setActiveCloudVolume(cloudVol);
  // the erosion volume (~150 ms, once per session) while the battle loads
  if (cloudVol && getMaterialQuality() === 'high') cloudVol.ensureNoise();
  envFailed = false;
  envDirty = !!(environment && sky);
  envClock = 0;
  scene.environmentIntensity = envDirty ? envIntensityOf(preset) : 1;
  // No environment at all: the hemisphere light carries the IBL's share too,
  // or every shade would drop to the bare ground bounce.
  if (!envDirty) hemi.intensity = hemiFallbackOf(preset);
  // The HDRI for this biome/hour/weather (assets.js) starts loading now; it
  // replaces the procedural dome as the image-based light once decoded, at
  // the first bake if it is already there, else by a short crossfade.
  hdriId = null; hdriTex = null; hdriMix = 0; hdriTarget = 0; hdriBaked = -1; hdriGain = null;
  // assetsEnabled(): loadHDRI hands back a cached, decoded texture whatever
  // the switch says, so the switch is honoured here (calibration.assets(false))
  if (envDirty && assetsEnabled()) {
    try {
      hdriId = hdriFor(preset.biome || 'meadow', preset.todKey || 'noon', preset.weatherKey || 'clear');
      hdriTex = hdriId ? loadHDRI(hdriId) : null;
    } catch (err) {
      hdriId = null; hdriTex = null;
    }
  }

  // --- the dressed landscape ------------------------------------------------
  // `trees`, `houses` and `fences` used to be scatter counts. The layout now
  // comes from landuse.js (how many woods, lots and fence lines a map has is a
  // property of the biome and the seed), so they survive only as on/off
  // switches; `rocks` is still a count, scaled by the biome.
  const feat = terrainFeatures();
  spawnStrips = spawnStripsFor(propArea, spawnKeepOut);
  const ctx = makeDressContext(scene, preset, propArea, feat);
  if (houses > 0) addVillage(scene, ctx);
  if (trees > 0) addVegetation(scene, ctx);
  if (rocks > 0) addRocks(scene, ctx, Math.round(rocks * (preset.rockFactor ?? 1)));
  if (fences > 0) addFences(scene, ctx);
  addPoles(scene, ctx);
  addDistantWoods(scene, ctx);
  addWeather(scene, preset);
  // Grass last: it reads the lots and woods the props above were laid out
  // from, and the live keep-out list.
  addGroundCover(scene, ctx);
  installDriver(scene);

  return {
    sun,
    hemi,
    wind,
    preset,
    props,
    // Live array: fellProp splices a prop out of it the moment it comes down,
    // so a battle that keeps this reference is never shooting at a wall that
    // is already lying in the road.
    blockers: blockerList,
    update: updateScenery,
    // The destruction API, hung off the handle as well as exported, so a
    // battle file that imports nothing but setupEnvironment can still use it.
    setEffects: setSceneryEffects,
    damageAt: sceneryDamageAt,
    crush: crushProps,
    segmentHit: propSegmentHit,
    blocksLine: propBlocksLine,
    dispose: disposeScenery,
    // --- added by the lighting rig; nothing above changed meaning -----------
    sky,
    clouds,
    // Per-frame entry points. The scene's own onBeforeRender already calls
    // these, so a battle file that does nothing still gets a shadow box that
    // follows it — see updateSunAnchor().
    updateEnvironment,
    updateSunAnchor,
    setSunAnchor,
    refreshEnvironment,
    shadowRadius: shadowHalf,
    shadowMapSize,
    csm: null,       // see the CSM note above updateSunAnchor()
    keepOuts: keepOutDiscs,
    addKeepOut,
  };
}

// 4096 is 64 MB of depth and roughly 0.16 m per texel at the default radius;
// low-end machines get a quarter of that. Reuses the material factory's quality
// knob so there is one graphics setting, not two.
// ---------------------------------------------------------------------------
// The sun, the sky dome, the cloud deck and the image-based light.
//
// Read these together: `sunDir` is where the sun really is (the dome and the
// light colour use it), `casterDir` is the same vector with its elevation
// floored so a dawn shadow is not a mile long, and everything below moves the
// shadow VOLUME around the player without ever touching either direction.
// That distinction is the whole point. The three battle files used to
// overwrite sun.position every frame with a hardcoded (+120,+180,+60), which
// silently threw the preset time of day away and gave dusk an orange sun at a
// midday angle. They should call updateSunAnchor(camera) instead.

// Put the light on its anchor. The anchor is snapped to whole shadow texels
// first: a shadow camera that slides continuously makes every shadow edge in
// the scene crawl as the player drives, and snapping is the standard cure —
// the projection then only moves in whole-texel steps, so the depth samples
// land on the same places frame to frame.
// Each time of day carries its own exposure — a dusk map wants less of it
// than an overcast noon, and without this every preset renders at the one
// global value main.js sets and the whole set looks the same brightness.
// The renderer is shared with the garage, so the original is saved and put
// back by disposeScenery.
function applyExposure(renderer) {
  if (!renderer || !exposure) return;
  if (exposureSaved === null) exposureSaved = renderer.toneMappingExposure;
  if (renderer.toneMappingExposure !== exposure) renderer.toneMappingExposure = exposure;
}

function placeSun(anchor) {
  if (!sunLight) return;
  // Snapped in LIGHT space (L-04): the shadow camera's own x / y axes, the ones
  // Matrix4.lookAt builds from casterDir with up = +Y, each to its own texel
  // (the box is rectangular under a low sun). Snapping world x / z only lines
  // up with the texel grid when the sun happens to sit on a world axis.
  const tx = (shadowHalf * 2) / Math.max(1, shadowMapSize);
  const ty = (shadowHalfY * 2) / Math.max(1, shadowMapSize);
  const zx = casterDir.x;
  const zy = casterDir.y;
  const zz = casterDir.z;
  const xl = Math.hypot(zz, zx) || 1;
  const ax = zz / xl;            // light x = normalize(up x z) = (zz, 0, -zx)
  const az = -zx / xl;
  const bx = zy * az;            // light y = z x (light x)
  const by = zz * ax - zx * az;
  const bz = -zy * ax;
  const u = Math.round((anchor.x * ax + anchor.z * az) / tx) * tx;
  const v = Math.round((anchor.x * bx + anchor.y * by + anchor.z * bz) / ty) * ty;
  const w = anchor.x * zx + anchor.y * zy + anchor.z * zz;
  const sx = ax * u + bx * v + zx * w;
  const sy = by * v + zy * w;
  const sz = az * u + bz * v + zz * w;
  sunLight.target.position.set(sx, sy, sz);
  sunLight.position.set(
    sx + casterDir.x * sunDist,
    sy + casterDir.y * sunDist,
    sz + casterDir.z * sunDist,
  );
  sunLight.target.updateMatrixWorld();
  sunLight.updateMatrixWorld();
}

// Call once per frame with the render camera. This is what the battle files
// should use INSTEAD of writing sun.position themselves.
export function updateSunAnchor(camera) {
  if (!sunLight) return;
  if (anchorObject && anchorObject.position) anchorPos.copy(anchorObject.position);
  else if (camera && camera.position) anchorPos.copy(camera.position);
  else return;
  // Centred on the ground under the viewer, not on the viewer: from a cockpit
  // at 400 m an eye-centred box would spend most of its depth on empty air.
  anchorPos.y = terrainHeight(anchorPos.x, anchorPos.z);
  placeSun(anchorPos);
  if (sky) sky.position.set(anchorPos.x, 0, anchorPos.z);
  if (clouds) {
    clouds.position.set(anchorPos.x, clouds.userData.deckY || 900, anchorPos.z);
    if (cloudUniforms) cloudUniforms.uOrigin.value.set(anchorPos.x, anchorPos.z);
  }
}

// Follow something other than the render camera — a battle that wants the
// shadow volume on the player rather than on a spectator or kill-cam view.
export function setSunAnchor(obj) {
  anchorObject = obj || null;
}

// P-04 caster culling: does a sphere (centre x, y, z, radius r) fall inside
// the sun's shadow box, measured in the light's own x / y axes (the test
// three's shadow frustum makes, so an object this says no to would draw
// nothing into the map anyway)? Lets a caster that lives far from the
// player (an airfield's guns and trucks) leave the shadow pass entirely.
// True when there is no shadow rig.
export function inShadowBox(x, y, z, r = 0) {
  if (!sunLight) return true;
  const zx = casterDir.x;
  const zy = casterDir.y;
  const zz = casterDir.z;
  const xl = Math.hypot(zz, zx) || 1;
  const ax = zz / xl;
  const az = -zx / xl;
  const bx = zy * az;
  const by = zz * ax - zx * az;
  const bz = -zy * ax;
  const dx = x - anchorPos.x;
  const dy = y - anchorPos.y;
  const dz = z - anchorPos.z;
  const u = dx * ax + dz * az;
  const v = dx * bx + dy * by + dz * bz;
  return Math.abs(u) <= shadowHalf + r && Math.abs(v) <= shadowHalfY + r;
}

// Per-frame environment work: drift the clouds, and bake the PMREM when it is
// dirty. It needs the renderer, which scenery.js has no other way of getting,
// so the caller passes it in. Safe to call every frame — the bake only happens
// on the frames where something actually changed.
// P-04: bake the image-based light NOW, before a shader warm-up compiles the
// battle's programs. Every MeshStandardMaterial program depends on whether
// the scene has an environment map; compiled without one (the bake used to
// wait for the first rendered frame), all of them were thrown away and
// rebuilt synchronously on that frame — 67 programs and a 16 s freeze on a
// cold Iris Xe shader cache. No time passes (dt 0).
export function warmEnvironment(renderer) {
  try {
    updateEnvironment(renderer, 0);
    applyExposure(renderer);
  } catch (err) {
    /* the first frame bakes it, as before */
  }
}

export function updateEnvironment(renderer, dt = 0.016) {
  if (cloudUniforms) cloudUniforms.uTime.value += dt;
  driftCirrus(skyCirrus, dt, wind.x, wind.z);
  envClock += dt;
  if (envFailed || !renderer || !sky || !activeScene) return;
  hdriProgress(dt);
  if (!envDirty) return;
  envDirty = false;
  try {
    if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);
    // Bake from a scene holding NOTHING but the dome. Baking the live scene
    // would capture the terrain and every vehicle on it, so a tank parked next
    // to you would light you as though it were a lamp. In the bake the dome
    // drops its sun disc (the DirectionalLight is the sun) and shows the lit
    // ground below the horizon instead of more horizon sky (skyBake uniforms),
    // and the HDRI sphere, once loaded, is drawn over it at hdriMix.
    if (!envScene) envScene = new THREE.Scene();
    const parent = sky.parent;
    envScene.add(sky);
    if (hdriSphere) {
      hdriSphere.visible = hdriMix > 0.001;
      hdriSphere.material.uniforms.uMix.value = hdriMix;
      envScene.add(hdriSphere);
    }
    skyBake.uBake.value = 1;
    const prev = envTarget;
    try {
      envTarget = pmrem.fromScene(envScene, 0.02);
    } finally {
      skyBake.uBake.value = 0;
      if (parent) parent.add(sky);
    }
    if (prev) prev.dispose();
    hdriBaked = hdriMix;
    activeScene.environment = envTarget.texture;
    activeScene.environmentIntensity = envIntensityOf(activePresetRef);
  } catch (err) {
    // A browser that cannot allocate the cube target still gets a playable
    // game, lit by the hemisphere carrying the IBL's share as well.
    envFailed = true;
    if (envTarget) { envTarget.dispose(); envTarget = null; }
    if (activeScene) activeScene.environment = null;
    if (hemiLight) hemiLight.intensity = hemiFallbackOf(activePresetRef);
  }
}

// --- the HDRI image-based light (assets.js) --------------------------------
// The HDRIs are normalised so their upward irradiance is pi (a uniform sky of
// radiance 1) and their sun is clamped out. The sphere scales them to the
// procedural dome's own cosine-weighted mean (light.skyUpLin), so a horizontal
// surface gets exactly the L-01 ambient either way; what the photograph adds
// is the real distribution: a ground below the horizon, clouds, a skyline in
// the reflections. It is rotated so its (removed) sun sits at the game sun.
function hdriProgress(dt) {
  if (hdriTex && hdriTarget === 0) {
    const s = assetStatus(hdriTex);
    if (s === 'ready') {
      if (!buildHdriSphere()) {
        hdriTex = null;
        return;
      }
      hdriTarget = 1;
      // Not baked yet, or only just: swap outright. Later it fades in.
      if (hdriBaked < 0 || envClock < 0.35) {
        hdriMix = 1;
        envDirty = true;
      }
    } else if (s !== 'loading') {
      // headless, disabled or failed: the procedural dome stays the light
      hdriTex = null;
    }
  }
  if (hdriTarget > hdriMix) {
    hdriMix = Math.min(1, hdriMix + Math.max(0, dt) / HDRI_FADE);
    if (hdriMix >= 1 || hdriMix - hdriBaked >= HDRI_STEP) envDirty = true;
  }
}

// Wave 3b fix: the photograph is calibrated to the light block (presets.js
// solveEnvGain): its sky is multiplied by a smooth SH gain and the ground
// below the horizon is the bake's own lit ground, so every normal gets the
// irradiance preset.light predicts (it read up to +/-20 levels off before).
// An HDRI that would need a gain beyond ENV_GAIN_LIMIT does not fit the
// preset; it is not used and the procedural bake stays the light.
function buildHdriSphere() {
  try {
    const preset = activePresetRef || {};
    const L = preset.light;
    const up = L && L.skyUpLin ? L.skyUpLin : null;
    const scale = up ? 0.2126 * up[0] + 0.7152 * up[1] + 0.0722 * up[2] : 0.25;
    const rot = hdriRotationY(hdriId, preset.sunDir || { x: sunDir.x, y: sunDir.y, z: sunDir.z });
    hdriGain = L ? envGainFor(preset, hdriId, hdriTex && hdriTex.image, rot, scale) : null;
    if (!hdriGain || !hdriGain.ok) return false;
    const gainU = hdriGain.coeffs.map((c) => new THREE.Vector3(c[0], c[1], c[2]));
    const ground = envGroundOf(preset);
    if (!hdriSphere) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uHdri: { value: hdriTex },
          uScale: { value: scale },
          uMix: { value: 0 },
          uRot: { value: new THREE.Vector2(Math.cos(rot), Math.sin(rot)) },
          uEnvGain: { value: gainU },
          uEnvGround: { value: new THREE.Vector3(ground[0], ground[1], ground[2]) },
        },
        vertexShader: /* glsl */`
          varying vec3 vDir;
          void main() {
            vec4 wp = modelMatrix * vec4( position, 1.0 );
            vDir = wp.xyz - cameraPosition;
            gl_Position = projectionMatrix * viewMatrix * wp;
            gl_Position.z = gl_Position.w;
          }`,
        // three's equirectUv convention, sampled at R_y(-rot) . dir — the same
        // rotation scene.environmentRotation would apply (hdriRotationY).
        fragmentShader: /* glsl */`
          #include <common>
          uniform sampler2D uHdri;
          uniform float uScale;
          uniform float uMix;
          uniform vec2 uRot;
          uniform vec3 uEnvGround;
          varying vec3 vDir;
          ${ENV_GAIN_GLSL}
          void main() {
            vec3 d = normalize( vDir );
            vec3 h = vec3( d.x * uRot.x - d.z * uRot.y, d.y, d.x * uRot.y + d.z * uRot.x );
            vec2 uv = vec2( atan( h.z, h.x ) * RECIPROCAL_PI2 + 0.5, asin( clamp( h.y, - 1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5 );
            vec3 sky = texture2D( uHdri, uv ).rgb * uScale * ssEnvGain( d );
            gl_FragColor = vec4( mix( sky, uEnvGround, ssEnvGroundMix( d.y ) ), uMix );
          }`,
        side: THREE.BackSide,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      });
      hdriSphere = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
      hdriSphere.frustumCulled = false;
      hdriSphere.renderOrder = -999;
    } else {
      const u = hdriSphere.material.uniforms;
      u.uHdri.value = hdriTex;
      u.uScale.value = scale;
      u.uRot.value.set(Math.cos(rot), Math.sin(rot));
      u.uEnvGain.value = gainU;
      u.uEnvGround.value.set(ground[0], ground[1], ground[2]);
    }
    return true;
  } catch (err) {
    return false;
  }
}

// The battle rig's IBL level (L-01), or the authored one for an old preset.
function envIntensityOf(preset) {
  if (preset && preset.light) return preset.light.envIntensity;
  return preset ? (preset.envIntensity ?? 0.7) : 0.7;
}

// Hemisphere intensity that also carries the IBL's horizontal share, for a
// scene with no environment map (envFailed, environment: false).
function hemiFallbackOf(preset) {
  const L = preset && preset.light;
  if (!L) return preset ? (preset.hemiIntensity ?? 1.15) : 1.15;
  const c = new THREE.Color(preset.hemiSky ?? 0xcfe4ff);
  const yHemi = Math.max(1e-4, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
  const up = L.skyUpLin;
  const yUp = 0.2126 * up[0] + 0.7152 * up[1] + 0.0722 * up[2];
  return L.hemiIntensity + (Math.PI * yUp * L.envIntensity) / yHemi;
}

// L-04: shadow box half-size from the map and the shadow-map size, never the
// fog. Texel = 2 . half / size: 0.146 m on ground maps and 0.166 m on the air
// and combined maps at 4096 (A-30: <= 0.15 / <= 0.17 m). P-04: the high
// tier's 3072 map keeps those texels (0.150 / 0.169 m) on a box 230 / 260 m
// across each way from the player instead of 300 / 340.
function shadowHalfFor(propArea, mapSize) {
  if (mapSize <= 1024) return 220;
  const wide = propArea > 1200;
  if (mapSize >= 4096) return wide ? 340 : 300;
  if (mapSize >= 3072) return wide ? 260 : 230;
  return wide ? 300 : 260;
}

// What the outdoor rig is doing right now, for tests and the debug console.
export function environmentState() {
  return {
    heightFog,
    hdriId,
    hdriStatus: hdriGain && !hdriGain.ok ? 'unfit'
      : hdriTex ? assetStatus(hdriTex) : (hdriSphere ? 'in use' : 'none'),
    // the calibration gain over the sky, per channel (presets.solveEnvGain)
    hdriGain: hdriGain ? { min: hdriGain.gainMin, max: hdriGain.gainMax, ok: hdriGain.ok } : null,
    hdriMix,
    hdriBaked,
    envFailed,
    shadowHalf,
    shadowHalfY,
    shadowMapSize,
    casterElevDeg: (Math.asin(Math.min(1, casterDir.y)) * 180) / Math.PI,
  };
}

// Mark the image-based light stale — call after changing the sky.
export function refreshEnvironment() {
  envDirty = true;
}

// The Preetham dome. Sky.js ships with three and is entirely procedural, so it
// costs no asset. Its uniforms come straight from the preset atm block, and
// SKY_SCALE is shared with presets.js so the CPU-side horizon radiance that
// drives the fog colour and the pixels the dome actually draws cannot drift
// apart. That agreement is what makes distant terrain dissolve into the sky
// instead of ending at a visible line.
function addSky(scene, preset) {
  const atm = preset.atm;
  if (!atm) return;
  const s = new Sky();
  // Big enough to sit outside every camera far plane; it is drawn with depth
  // write off, so the size is only about never being clipped.
  s.scale.setScalar(60000);
  const u = s.material.uniforms;
  u.turbidity.value = atm.turbidity;
  u.rayleigh.value = atm.rayleigh;
  u.mieCoefficient.value = atm.mie;
  u.mieDirectionalG.value = atm.mieG;
  u.sunPosition.value.copy(sunDir);
  if (u.up) u.up.value.set(0, 1, 0);
  // Sky.js renders radiance that assumes no tone mapping. Everything else here
  // goes through ACES, so the dome is scaled to the range presets.js measured
  // the old flat background colours to occupy.
  s.material.toneMapped = true;
  // The preset's own sky scale (SKY_SCALE x rig.sky, L-01), so the dome, the
  // fog colour (presets.horizonRGB) and the PMREM all drop together (C-22).
  skyBake.uSkyScale.value = Number.isFinite(preset.skyScale) ? preset.skyScale : SKY_SCALE;
  const L = preset.light;
  // the lit ground the bake shows below the horizon, in PMREM units (the
  // environment is multiplied by envIntensity on the way out)
  if (L && L.groundLin && L.envIntensity > 0) {
    skyBake.uGround.value.set(L.groundLin[0], L.groundLin[1], L.groundLin[2]).multiplyScalar(1 / L.envIntensity);
  } else {
    skyBake.uGround.value.set(0.02, 0.02, 0.018);
  }
  skyBake.uBake.value = 0;
  // the fog colour (the ring-averaged horizon, presets.horizonRGB): the
  // visible dome melts into it over the lowest 4.6 degrees, so a fully veiled
  // world (the skirt beyond 6.3 km, the ground from altitude) meets the sky
  // with no step on the horizon line at any azimuth (C-34)
  const hz = preset.horizonRGB;
  if (hz) skyBake.uFogCol.value.set(hz[0], hz[1], hz[2]);
  // S-01: the cirrus layer, lit by this preset's light block
  setCirrus(skyCirrus, preset);
  s.material.onBeforeCompile = (shader) => {
    shader.uniforms.uSkyScale = skyBake.uSkyScale;
    shader.uniforms.uSkyBake = skyBake.uBake;
    shader.uniforms.uSkyGround = skyBake.uGround;
    shader.uniforms.uSkyFog = skyBake.uFogCol;
    Object.assign(shader.uniforms, skyCirrus);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float uSkyScale;\nuniform float uSkyBake;\nuniform vec3 uSkyGround;\nuniform vec3 uSkyFog;\n${CIRRUS_GLSL}\nvoid main() {`)
      // L-03 / C-24: the disc is 0.533 deg ACROSS (three draws a 1.07 deg one:
      // its constant is used as a radius). Measured as sin(angle) from the
      // sun direction, which keeps float precision at a quarter of a degree;
      // edge +/- 0.02 deg, about a third of a pixel at 1080p / 60 deg. The
      // PMREM bake drops it: the DirectionalLight is the sun.
      .replace(
        'float sundisk = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta );',
        `float sunSin = length( cross( direction, vSunDirection ) );
			float sundisk = ( 1.0 - smoothstep( 0.004305, 0.004655 + 0.000349, sunSin ) ) * step( 0.0, cosTheta ) * ( 1.0 - uSkyBake );`,
      )
      .replace(
        /gl_FragColor\s*=\s*vec4\(\s*retColor\s*,\s*1\.0\s*\);/,
        `vec3 skyOut = retColor * uSkyScale;
			// S-01 cirrus, seen only (the bake, i.e. the image-based light, leaves it out)
			if ( uSkyBake < 0.5 ) skyOut = ssCirrus( skyOut, direction, vSunDirection );
			// seen: the horizon band is the fog colour; baked: below it is lit ground
			skyOut = mix( skyOut, uSkyFog, ( 1.0 - uSkyBake ) * ( 1.0 - smoothstep( 0.0, 0.08, direction.y ) ) );
			skyOut = mix( skyOut, uSkyGround, uSkyBake * ( 1.0 - smoothstep( - 0.035, 0.0, direction.y ) ) );
			gl_FragColor = vec4( skyOut, 1.0 );`,
      );
  };
  s.material.needsUpdate = true;
  s.renderOrder = -1000;
  s.frustumCulled = false;
  sky = s;
  skyUniforms = u;
  own(scene, s);
}

// A soft cloud sheet on one large plane high above the map: a single draw
// call, no lighting, scrolled by the wind. It is a deck seen from below in a
// ground battle and from above or through in an air battle, which is why it is
// alpha-blended rather than solid and why it does not write depth.
function addClouds(scene, preset) {
  const c = preset.cloud;
  if (!c || c.cover <= 0.02) return;
  if (!cloudTexture) cloudTexture = makeCloudTexture();
  // S-01: lit by the preset's own light block (contract R1-K), not by hex
  // constants, and correct from both sides: from above the sunlit tops, from
  // below the bases with the sun Beer-attenuated through the thickness, a
  // one-step light march toward the sun for self-shadow, a Henyey-Greenstein
  // silver lining on thin edges, the world's height fog over the far deck,
  // and three's tone mapping + colour space chunks so the low tier (no
  // composer, N23) draws it like everything else.
  const L = preset.light;
  const sunLin = L ? L.sunLin : [0.8, 0.76, 0.7];
  const ambLin = L ? L.ambLin : [0.12, 0.14, 0.17];
  const fogCol = new THREE.Color();
  const hz = preset.horizonRGB;
  if (hz) fogCol.setRGB(hz[0], hz[1], hz[2], THREE.LinearSRGBColorSpace);
  else fogCol.setHex(preset.fog ?? 0xb8cfe4);
  cloudUniforms = {
    uMap: { value: cloudTexture },
    uTime: { value: 0 },
    uOrigin: { value: new THREE.Vector2(0, 0) },
    uWind: { value: new THREE.Vector2(wind.x * 0.004, wind.z * 0.004) },
    uCover: { value: c.cover },
    // the cover law (world/clouds.js cloudCoverLaw): the legacy numbers here;
    // an air battle's cloudVolumeFor() moves them to the fraction law
    uWaterLine: { value: 1 - c.cover },
    uEdge: { value: 0.28 },
    uThick: { value: 0.32 },
    uOpacity: { value: c.opacity ?? 0.85 },
    uSunLin: { value: new THREE.Vector3(sunLin[0], sunLin[1], sunLin[2]) },
    uAmbLin: { value: new THREE.Vector3(ambLin[0], ambLin[1], ambLin[2]) },
    uSun: { value: sunDir.clone() },
    uDeckY: { value: c.height ?? 900 },
    uFogColor: { value: new THREE.Vector3(fogCol.r, fogCol.g, fogCol.b) },
    uFogSigma: { value: 3.912 / Math.max(1, L ? L.visibility : 10000) },
    uFogInvH: { value: 1 / (L ? L.fogScaleHeight : FOG_SCALE_HEIGHT) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: cloudUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    vertexShader: /* glsl */`
      varying vec2 vUvC;
      varying vec3 vWorld;
      varying float vViewDepth;
      varying float vCamFar;
      void main() {
        vUvC = uv;
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vWorld = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vViewDepth = - mv.z;
        vCamFar = projectionMatrix[ 2 ][ 3 ] != 0.0 ? projectionMatrix[ 3 ][ 2 ] / ( projectionMatrix[ 2 ][ 2 ] + 1.0 ) : 1e9;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      uniform sampler2D uMap;
      uniform float uTime;
      uniform float uCover;
      uniform float uWaterLine;
      uniform float uEdge;
      uniform float uThick;
      uniform float uOpacity;
      uniform vec2 uWind;
      uniform vec3 uSunLin;
      uniform vec3 uAmbLin;
      uniform vec3 uSun;
      uniform float uDeckY;
      uniform vec3 uFogColor;
      uniform float uFogSigma;
      uniform float uFogInvH;
      varying vec2 vUvC;
      varying vec3 vWorld;
      varying float vViewDepth;
      varying float vCamFar;
      ${HEIGHT_FOG_GLSL}
      // two octaves drifting at different rates, so the deck churns instead
      // of sliding across the sky as one rigid sheet
      float deckDensity( vec2 w ) {
        vec2 uv = w / 2600.0 + uWind * uTime;
        float a = texture2D( uMap, uv ).r;
        float b = texture2D( uMap, uv * 2.17 + vec2( 0.31, 0.57 ) + uWind * uTime * 0.6 ).r;
        return a * 0.65 + b * 0.35;
      }
      void main() {
        // cover raises the water line: at 0.2 only the tallest tops show
        float wl = uWaterLine;
        float d = deckDensity( vWorld.xz );
        float m = smoothstep( wl, wl + uEdge, d );
        if ( m <= 0.003 ) discard;
        // fade towards the rim so the sheet has no visible straight edge
        float rr = length( vUvC - 0.5 ) * 2.0;
        m *= 1.0 - smoothstep( 0.72, 1.0, rr );
        // thickness proxy: how far above the water line this column stands
        float th = clamp( ( d - wl ) / uThick, 0.0, 1.0 );
        // one step toward the sun: the column its light crosses first
        float mu = max( uSun.y, 0.02 );
        vec2 sh = length( uSun.xz ) > 1e-3 ? normalize( uSun.xz ) : vec2( 0.0 );
        float reach = min( 150.0 * sqrt( max( 1.0 - mu * mu, 0.0 ) ) / mu, 600.0 );
        float ts = clamp( ( deckDensity( vWorld.xz + sh * reach ) - wl ) / uThick, 0.0, 1.0 );
        const float ALBEDO = 0.82;
        // tops: a bumpy white surface under the sun, shadowed by taller cloud
        vec3 top = ALBEDO * ( uSunLin * ( ( 0.3 + 0.7 * mu ) * mix( 1.0, exp( - 1.6 * ts ), 0.55 ) ) + uAmbLin );
        // bases: sunlight Beer-attenuated through the column, plus the sky
        // and ground light a grey underside gets
        vec3 base = ALBEDO * ( uSunLin * ( 0.55 * mu * exp( - 2.6 * th ) * exp( - 0.8 * ts ) )
          + uAmbLin * ( 0.5 + 0.35 * ( 1.0 - th ) ) );
        // silver lining: thin edges seen toward the sun, HG phase g = 0.6
        float cv = dot( normalize( vWorld - cameraPosition ), uSun );
        float hg = 0.64 / pow( 1.36 - 1.2 * cv, 1.5 ) / ( 4.0 * PI );
        vec3 lining = uSunLin * ( PI * hg * 0.5 * ( 1.0 - th ) * ( 1.0 - th ) );
        float above = smoothstep( - 40.0, 40.0, cameraPosition.y - uDeckY );
        vec3 col = mix( base + lining, top + 0.4 * lining, above );
        // the world's own height fog (L-06), so the far deck melts into the horizon
        col = mix( col, uFogColor, ssFogVeil( uFogSigma, uFogInvH, cameraPosition, vWorld, vViewDepth, vCamFar ) );
        gl_FragColor = vec4( col, m * uOpacity );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.setScalar(9000);
  mesh.userData.deckY = c.height ?? 900;
  mesh.position.y = mesh.userData.deckY;
  mesh.frustumCulled = false;
  mesh.renderOrder = -900;
  clouds = mesh;
  own(scene, mesh);
}

// Tiling fbm on a canvas. Generated once per session and shared, because it is
// the same cloud shape under every sky — only the cover, colour and drift
// change per preset, and those are uniforms.
function makeCloudTexture(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  // the period-locked value-noise fbm now lives in world/clouds.js, which the
  // S-02 slab and its CPU mirror read too: one field, the same bytes as before
  const field = cloudFieldData(size);
  for (let i = 0; i < size * size; i++) {
    const v = field[i];
    const k = i * 4;
    img.data[k] = v; img.data[k + 1] = v; img.data[k + 2] = v; img.data[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}
function shadowSizeForQuality() {
  const q = typeof getMaterialQuality === 'function' ? getMaterialQuality() : 'high';
  if (q === 'low') return 1024;
  if (q === 'medium') return 2048;
  // P-04: 3072, not 4096, on high. The map is cleared and redrawn every
  // frame, and on an integrated GPU a 4096 map cost 2.3 ms with NO caster in
  // it (the clear and resolve of 16.7 M texels alone), 3.1 ms with the
  // battle's. 3072 keeps the A-30 texel (see shadowHalfFor) on a box 23 %
  // smaller, for 1.3 ms less.
  return 3072;
}

// Add to the scene AND remember it, so disposeScenery can hand the buffers
// back. Everything setupEnvironment puts in the world goes through here.
function own(scene, ...objs) {
  for (let i = 0; i < objs.length; i++) {
    if (!objs[i]) continue;
    sceneObjects.push(objs[i]);
    scene.add(objs[i]);
  }
}

// ---------------------------------------------------------------------------
// Keep-out discs
//
// The old scatter took an `avoid` circle that no caller ever passed, which is
// why trees and rocks grew straight down the middle of both airfield strips.
// This is the registry the callers actually need: a disc list, filled BEFORE
// setupEnvironment (or handed to it as opts.keepOut), that every placement
// routine in this file honours — trees, hedges, buildings, rocks, fences,
// poles, distant woods and the grass.
//
//   import { addKeepOut } from '../world/scenery.js';
//   addKeepOut(-1020, 0, 200);   // team 0 strip, hangars and AA
//   addKeepOut( 1020, 0, 200);
//   this.scenery = setupEnvironment(this.scene, { preset, ... });
//
// All three battle files register their airfields before setupEnvironment
// (opts.keepOut). A disc added AFTER it still works: purgeKeepOut clears what
// is already standing inside it — including the invulnerable rocks, which
// nothing else could ever move off a runway.
function pushKeepOut(k) {
  if (!k) return;
  const r = Number(k.r);
  if (!Number.isFinite(r) || r <= 0) return;
  keepOutDiscs.push({ x: Number(k.x) || 0, z: Number(k.z) || 0, r });
}

export function addKeepOut(x, z, r) {
  const disc = { x, z, r };
  // Before setupEnvironment there is nothing to add to yet, so park it; after,
  // go straight in so a caller can fence off something it built late — and
  // clear whatever the scenery already put inside it, because a disc that only
  // stops FUTURE placement would leave the trees standing on the runway.
  if (activeScene) {
    const before = keepOutDiscs.length;
    pushKeepOut(disc);
    if (keepOutDiscs.length > before) purgeKeepOut(keepOutDiscs[keepOutDiscs.length - 1]);
  } else {
    pendingKeepOuts.push(disc);
  }
  return disc;
}

export function clearKeepOuts() {
  pendingKeepOuts.length = 0;
  keepOutDiscs.length = 0;
}

// Live list, so a caller can see what is fenced off and reuse it for its own
// spawn logic instead of duplicating the numbers.
export function keepOuts() {
  return keepOutDiscs;
}

function inKeepOut(x, z, pad = 0) {
  for (let i = 0; i < keepOutDiscs.length; i++) {
    const k = keepOutDiscs[i];
    const r = k.r + pad;
    const dx = x - k.x;
    const dz = z - k.z;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tank spawn strips
//
// A tank put down on a boulder or inside a farmhouse is stuck before the match
// starts, and rocks and houses are the solid props nothing can push aside. The
// ground battle drops its tanks at x = +/-330 +/- 20, z = -120 + 80 * slot
// +/- 15 (battle.js teamSpawnPose: slots 0-3 and the player's 1.5; slot 4 is
// covered too, for a fifth tank); the combined battle at x = +/-600 +/- 25,
// z = -160 + 80 * slot +/- 15 (combinedBattle.js spawnTank, slots 0-4). The
// air battle puts down no tanks. Rocks and houses keep their own radius plus
// SPAWN_PAD (a hull's half-length) clear of the strip; landuse.js already
// keeps the woods out of the ground battle's. setupEnvironment picks the
// strips from the prop area the battle files pass (ground: the 900 m default,
// combined 1350, air 2400), or takes opts.spawnKeepOut ([{ x0, x1, z0, z1 }],
// [] for none) from a caller that spawns elsewhere.
const SPAWN_PAD = 4;
const GROUND_SPAWN_STRIPS = [
  { x0: -350, x1: -310, z0: -135, z1: 215 },
  { x0: 310, x1: 350, z0: -135, z1: 215 },
];
const COMBINED_SPAWN_STRIPS = [
  { x0: -625, x1: -575, z0: -175, z1: 175 },
  { x0: 575, x1: 625, z0: -175, z1: 175 },
];

function spawnStripsFor(propArea, given) {
  if (Array.isArray(given)) {
    const out = [];
    for (const s of given) {
      if (!s) continue;
      const x0 = Number(s.x0); const x1 = Number(s.x1);
      const z0 = Number(s.z0); const z1 = Number(s.z1);
      if (![x0, x1, z0, z1].every(Number.isFinite)) continue;
      out.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) });
    }
    return out;
  }
  const area = Number(propArea) || WORLD_SIZE;
  if (area <= 1000) return GROUND_SPAWN_STRIPS;
  if (area <= 1600) return COMBINED_SPAWN_STRIPS;
  return [];
}

function inSpawnStrip(x, z, pad = 0) {
  for (let i = 0; i < spawnStrips.length; i++) {
    const s = spawnStrips[i];
    const dx = Math.max(s.x0 - x, 0, x - s.x1);
    const dz = Math.max(s.z0 - z, 0, z - s.z1);
    if (dx * dx + dz * dz <= pad * pad) return true;
  }
  return false;
}

// A building's blocker circle and its built footprint (corners and the middle
// of every side), against the strips.
function houseInSpawnStrip(lot, arch, s) {
  if (!spawnStrips.length) return false;
  const r = Math.min(MAX_PROP_R, Math.max(2, arch.solidR * s));
  if (inSpawnStrip(lot.x, lot.z, r + SPAWN_PAD)) return true;
  const c = Math.cos(lot.yaw);
  const sn = Math.sin(lot.yaw);
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const lx = (u * arch.w * s) / 2;
    const lz = (v * arch.d * s) / 2;
    if (inSpawnStrip(lot.x + c * lx + sn * lz, lot.z - sn * lx + c * lz, SPAWN_PAD)) return true;
  }
  return false;
}

// A disc registered AFTER the scenery was built (addKeepOut on a live battle).
// Everything already standing inside it goes: registered props are hidden and
// dropped from the registry and the blocker list, unregistered instanced
// visuals are collapsed to zero scale, and merged strips (hedge banks, wires)
// lose the triangles that touch the disc. The grass reads the live list
// itself and refills its ring on its next update.
function purgeKeepOut(disc) {
  if (!disc) return;
  for (let i = props.length - 1; i >= 0; i--) {
    const p = props[i];
    const dx = p.x - disc.x;
    const dz = p.z - disc.z;
    const rr = disc.r + (p.r || 0);
    if (dx * dx + dz * dz >= rr * rr) continue;
    removeProp(p, i);
  }
  _m.makeScale(0, 0, 0);
  for (const li of looseInstances) {
    const xz = li.xz;
    let touched = false;
    for (let k = 0; k < xz.length / 2; k++) {
      const dx = xz[2 * k] - disc.x;
      const dz = xz[2 * k + 1] - disc.z;
      if (dx * dx + dz * dz >= disc.r * disc.r) continue;
      li.mesh.setMatrixAt(k, _m);
      touched = true;
    }
    if (touched) li.mesh.instanceMatrix.needsUpdate = true;
  }
  for (const mesh of purgeables) blankTriangles(mesh, disc);
}

function removeProp(p, index) {
  _m.makeScale(0, 0, 0);
  const slots = p.slots || [];
  for (let s = 0; s < slots.length; s++) {
    const sl = slots[s];
    if (sl.mesh.isBatchedMesh) sl.mesh.setVisibleAt(sl.index, false);
    else setSlotMatrix(sl, _m);
  }
  if (p.blocker) {
    const bi = blockerList.indexOf(p.blocker);
    if (bi >= 0) blockerList.splice(bi, 1);
    p.blocker = null;
  }
  p.solid = false;
  p.state = 'down';
  const fi = falling.indexOf(p);
  if (fi >= 0) falling.splice(fi, 1);
  const cell = grid.get(cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL)));
  if (cell) {
    const ci = cell.indexOf(p.pi);
    if (ci >= 0) cell.splice(ci, 1);
  }
  const pi = index ?? props.indexOf(p);
  if (pi >= 0) props.splice(pi, 1);
  removeSolid(p);
  unindexTimber(p);
}

// Degenerate every triangle of an indexed merged mesh that has a vertex inside
// the disc: cheaper and safer than rebuilding the strip.
function blankTriangles(mesh, disc) {
  const g = mesh.geometry;
  const idx = g && g.index;
  const pos = g && g.getAttribute('position');
  if (!idx || !pos) return;
  const r2 = disc.r * disc.r;
  const a = idx.array;
  let touched = false;
  for (let t = 0; t + 2 < a.length; t += 3) {
    let hit = false;
    for (let k = 0; k < 3 && !hit; k++) {
      const v = a[t + k];
      const dx = pos.getX(v) - disc.x;
      const dz = pos.getZ(v) - disc.z;
      if (dx * dx + dz * dz < r2) hit = true;
    }
    if (hit) {
      a[t + 1] = a[t];
      a[t + 2] = a[t];
      touched = true;
    }
  }
  if (touched) idx.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Prop registry
function registerProp(p) {
  p.id = nextPropId++;
  p.state = 'up';
  p.fallT = 0;
  p.fallAx = 0;
  p.fallAz = 1;
  p.blocker = null;
  p.si = -1;
  p.vi = -1;
  // the numbers every query reads, mirrored where a query can read them
  // without boxing (see "Query storage")
  const pi = indexProp(p);
  indexTimber(p);
  if (p.solid) {
    // one entry, held by both the prop and the live blocker list, so removing
    // it when the prop goes down costs a splice rather than a rebuild
    p.blocker = { x: p.x, z: p.z, y: p.y, r: p.r, h: p.h };
    blockerList.push(p.blocker);
    // and the shootable set: a building stays in it after it comes down (its
    // ruin is still in the way), a rock never leaves it
    addSolid(p);
  }
  props.push(p);
  const key = cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
  let cell = grid.get(key);
  if (!cell) {
    cell = [];
    grid.set(key, cell);
  }
  cell.push(pi);
  return p;
}

// (an int32 on purpose: a double key would be boxed for every Map lookup)
function cellKey(cx, cz) {
  return ((cx + 1024) * 4096 + (cz + 1024)) | 0;
}

// Live props whose footprint overlaps a circle. Pass `out` in a hot path — the
// default array is allocated fresh on every call.
export function propsNear(x, z, radius, out = []) {
  out.length = gatherNear(x, z, radius, out);
  return out;
}

// propsNear's walk, into `buf` from index 0: returns how many it found. The
// buffer is never shortened — cutting an array's length to 0 hands its backing
// store back, and a hot caller reusing one array would then grow a new one on
// every call (300 bytes a query, measured) — so entries at and past the count
// are stale: the in-module callers loop to the count.
function gatherNear(x, z, radius, buf) {
  let n = 0;
  if (!props.length) return 0;
  const reach = radius + MAX_PROP_R;
  const cx0 = Math.floor((x - reach) / CELL) | 0;
  const cx1 = Math.floor((x + reach) / CELL) | 0;
  const cz0 = Math.floor((z - reach) / CELL) | 0;
  const cz1 = Math.floor((z + reach) / CELL) | 0;
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const cell = grid.get(cellKey(cx, cz));
      if (!cell) continue;
      for (let i = 0; i < cell.length; i++) {
        // the cell holds registry indices; the numbers come from the typed
        // mirrors, only the state (a tagged value) from the record itself
        const pi = cell[i];
        const dx = PX[pi] - x;
        const dz = PZ[pi] - z;
        const rr = radius + PR[pi];
        if (dx * dx + dz * dz > rr * rr) continue;
        const p = pObj[pi];
        if (p.state === 'down') continue;
        if (n < buf.length) buf[n] = p;
        else buf.push(p);
        n++;
      }
    }
  }
  return n;
}

export function allProps() {
  return props;
}

// Everything a camera or a line-of-sight test should treat as a wall.
export function sceneryBlockers(out = []) {
  out.length = 0;
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    if (p.solid && p.state !== 'down') out.push({ x: p.x, z: p.z, y: p.y, r: p.r, h: p.h });
  }
  return out;
}

export function setSceneryEffects(effects) {
  effectsHook = effects || null;
}

// ---------------------------------------------------------------------------
// Damage
export function damageProp(prop, damage = 1, opts = null) {
  if (!prop || prop.state !== 'up' || prop.invulnerable) return false;
  prop.hp -= damage;
  if (prop.hp > 0) {
    if (effectsHook && effectsHook.treeDebris && prop.kind !== 'rock') {
      effectsHook.treeDebris(_v.set(prop.x, prop.y + prop.h * 0.5, prop.z));
    }
    return false;
  }
  fellProp(prop, opts && opts.dirX, opts && opts.dirZ);
  return true;
}

// Knock a prop over. dirX/dirZ is the push direction; anything falls away from
// whatever hit it, which is what makes a felled treeline read as a shot line.
export function fellProp(prop, dirX, dirZ) {
  if (!prop || prop.state !== 'up' || prop.invulnerable) return false;
  let dx = dirX || 0;
  let dz = dirZ || 0;
  const l = Math.hypot(dx, dz);
  if (l < 1e-4) {
    const a = Math.random() * Math.PI * 2;
    dx = Math.cos(a);
    dz = Math.sin(a);
  } else {
    dx /= l;
    dz /= l;
  }
  // the topple axis is horizontal and square to the push
  prop.fallAx = dz;
  prop.fallAz = -dx;
  prop.fallT = 0;
  prop.hp = 0;
  prop.solid = false;
  prop.state = 'falling';
  if (prop.blocker) {
    const bi = blockerList.indexOf(prop.blocker);
    if (bi >= 0) blockerList.splice(bi, 1);
    prop.blocker = null;
  }

  if (effectsHook) {
    _v.set(prop.x, prop.y + prop.h * 0.35, prop.z);
    if (prop.kind === 'house') effectsHook.dirtImpact?.(_v, 2.4);
    else effectsHook.treeDebris?.(_v);
  }
  // a telegraph pole takes its spans of wire down with it
  if (prop.wireSpans) dropWireSpans(prop);

  // Without a per-frame tick there is nobody to animate the fall, so put it
  // straight on the ground rather than leaving a dead tree standing.
  if (clockMs() - lastTick > 500) {
    prop.fallT = prop.span;
    prop.state = 'down';
    writeProp(prop, 1);
  } else {
    falling.push(prop);
    writeProp(prop, 0);
  }
  return true;
}

// Blast/impact damage over an area. Returns how many props went down.
export function damagePropsAt(x, z, radius, damage, opts = null) {
  const hits = _queryA;
  const count = gatherNear(x, z, radius, hits);
  // opts.y, when given, keeps a bomb that went off at 300 m from flattening the
  // wood underneath it. Left out, the blast is treated as a ground burst.
  const y = opts && typeof opts.y === 'number' ? opts.y : null;
  let felled = 0;
  for (let i = 0; i < count; i++) {
    const p = hits[i];
    if (p.invulnerable) continue;
    if (y !== null && (y > p.y + p.h + radius || y < p.y - radius)) continue;
    const d = Math.hypot(p.x - x, p.z - z);
    const falloff = radius > 0 ? Math.max(0, 1 - d / (radius + p.r)) : 1;
    // one shared push vector rather than an object per prop: a bomb in a wood
    // touches dozens of these and damageProp reads it before it returns
    _push.dirX = (opts && opts.dirX) ?? (p.x - x);
    _push.dirZ = (opts && opts.dirZ) ?? (p.z - z);
    if (damageProp(p, damage * falloff, _push)) felled++;
  }
  return felled;
}

// The one call a battle file needs: "something went off here". Takes a
// Vector3 (or anything with x/y/z) straight from a shell or bomb impact and
// does the finding, the felling and the debris in one go — no knowledge of the
// prop registry required, and safe to call before any prop exists.
//
//   sceneryDamageAt(hit.point, 6, 400)          // HE burst
//   sceneryDamageAt(shell.pos, 0.6, 90, { dirX: v.x, dirZ: v.z })   // solid shot
//
// Returns the number of props knocked down, so a caller can score or ignore it.
export function sceneryDamageAt(point, radius = 4, damage = 120, opts = null) {
  if (!point || !props.length) return 0;
  const r = radius > 0.2 ? radius : 0.2;
  // the burst height comes free with the point, so use it rather than making
  // every caller remember to pass it separately
  _blast.y = opts && typeof opts.y === 'number' ? opts.y : point.y;
  _blast.dirX = opts ? opts.dirX : undefined;
  _blast.dirZ = opts ? opts.dirZ : undefined;
  return damagePropsAt(point.x, point.z, r, damage, _blast);
}

// A hull pushing through the scenery. Small stuff goes flat; a house or a rock
// comes back as `blocked` so the caller can stop the vehicle against it.
export function crushProps(x, z, radius, opts = null) {
  const force = (opts && opts.force) ?? 40;
  const dirX = (opts && opts.dirX) ?? 0;
  const dirZ = (opts && opts.dirZ) ?? 0;
  const hits = _queryB;
  const count = gatherNear(x, z, radius, hits);
  let felled = 0;
  let blocked = null;
  for (let i = 0; i < count; i++) {
    const p = hits[i];
    if (p.state !== 'up') continue;
    if (!p.crushable || p.crushMass > force) {
      if (p.solid && (!blocked || p.r > blocked.r)) blocked = p;
      continue;
    }
    const px = dirX || (p.x - x);
    const pz = dirZ || (p.z - z);
    if (fellProp(p, px, pz)) felled++;
  }
  // Every tank asks this every frame and almost always touches nothing, so the
  // nothing-happened answer is a shared constant rather than fresh garbage —
  // and the something-happened one a reused record (read it before the next
  // call: a tank parked against a wall would otherwise allocate every frame).
  if (!felled && !blocked) return NO_CRUSH;
  _crushRes.felled = felled;
  _crushRes.blocked = blocked;
  return _crushRes;
}

// A hull kept out of the buildings and rocks. `disc` is { x, z, w: radius,
// y: the hull's foot } (a THREE.Vector4 does); every solid whose footprint the
// disc overlaps — a building's wall rectangle, standing or in ruins (the
// stumps are still there), a rock's circle — pushes it clear, in turn. The
// total shove goes into out.x / out.z; returns true if there was one. A solid
// the hull is standing above is not in the way, nor is a boulder whose top is
// less than HULL_RIDE over the hull's foot (the tracks take it). The battles
// call it for three discs along every hull every frame; tankAI.js sweeps it
// ahead of a hull to steer round what would stop it. Allocation-free.
const HULL_RIDE = 0.6;
export function solidPushOut(disc, out) {
  out.x = 0;
  out.z = 0;
  if (!sCount) return false;
  const r = disc.w;
  const y = disc.y;
  let px = disc.x;
  let pz = disc.z;
  let cx0 = Math.floor((px - r) / SCELL) + SS_HALF;
  let cx1 = Math.floor((px + r) / SCELL) + SS_HALF;
  let cz0 = Math.floor((pz - r) / SCELL) + SS_HALF;
  let cz1 = Math.floor((pz + r) / SCELL) + SS_HALF;
  if (cx0 < 0) cx0 = 0; else if (cx0 >= SS_N) cx0 = SS_N - 1;
  if (cx1 < 0) cx1 = 0; else if (cx1 >= SS_N) cx1 = SS_N - 1;
  if (cz0 < 0) cz0 = 0; else if (cz0 >= SS_N) cz0 = SS_N - 1;
  if (cz1 < 0) cz1 = 0; else if (cz1 >= SS_N) cz1 = SS_N - 1;
  if (++solidStamp > 0x3fffffff) {
    SQ.fill(0);
    solidStamp = 1;
  }
  const stamp = solidStamp;
  let moved = false;
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const cell = solidGrid[cx * SS_N + cz];
      if (!cell) continue;
      for (let i = 0; i < cell.length; i++) {
        const si = cell[i];
        if (SQ[si] === stamp) continue;
        SQ[si] = stamp;
        const o = si * SSTRIDE;
        const form = SD[o];
        // a hull rides over what does not stand clear of its tracks: anything
        // it is already standing above, and a boulder lower than HULL_RIDE
        if (!form || y > SD[o + 7] - (form === 1 ? HULL_RIDE : 0.3)) continue;
        const wx = px - SD[o + 1];
        const wz = pz - SD[o + 3];
        if (form === 1) {
          if (solids[si].state !== 'up') continue;
          const rr = r + SD[o + 4];
          const d2 = wx * wx + wz * wz;
          if (d2 >= rr * rr) continue;
          const d = Math.sqrt(d2);
          if (d > 1e-6) {
            px += (wx * (rr - d)) / d;
            pz += (wz * (rr - d)) / d;
          } else {
            px += rr;
          }
          moved = true;
          continue;
        }
        const hx = SD[o + 18];
        const hz = SD[o + 19];
        if (!(hx > 0 && hz > 0)) continue;
        const c = SD[o + 20];
        const sn = SD[o + 21];
        // into the building's yaw frame (the collider's own convention)
        const lx = c * wx - sn * wz;
        const lz = sn * wx + c * wz;
        const qx = lx < -hx ? -hx : lx > hx ? hx : lx;
        const qz = lz < -hz ? -hz : lz > hz ? hz : lz;
        const ex = lx - qx;
        const ez = lz - qz;
        const d2 = ex * ex + ez * ez;
        let mx = 0;
        let mz = 0;
        if (d2 > 1e-12) {
          if (d2 >= r * r) continue;
          const d = Math.sqrt(d2);
          mx = (ex * (r - d)) / d;
          mz = (ez * (r - d)) / d;
        } else {
          // centre inside the walls: out through the nearest side
          const ax = hx - (lx < 0 ? -lx : lx) + r;
          const az = hz - (lz < 0 ? -lz : lz) + r;
          if (ax < az) mx = lx < 0 ? -ax : ax;
          else mz = lz < 0 ? -az : az;
        }
        // and back out to the world
        px += c * mx + sn * mz;
        pz += -sn * mx + c * mz;
        moved = true;
      }
    }
  }
  if (!moved) return false;
  out.x = px - disc.x;
  out.z = pz - disc.z;
  return true;
}

// Nearest prop crossed by a segment p0 -> p1. Shells, bullets, bombs, aim rays
// and sight lines all ask this, so it allocates nothing.
//
//   opts (all optional):
//     null / {}           SOLIDS: buildings (their real shape, ruins included,
//                         see "Solid colliders"), rocks, and the airfield
//                         hangars / tower / revetments / bowsers (a stand-in
//                         prop of kind 'airfield', invulnerable: see
//                         "Airfield buildings")
//     { includeTrees }    the same, plus standing shell-trees by crown radius
//     { treesOnly }       shell-trees alone (a round felling timber it passes)
//
// Returns null, or { prop, point, t, normal }: `t` is 0..1 along the segment,
// `point` the world hit and `normal` the outward world normal of the face
// struck. The record and both vectors are this module's scratch — read them
// before calling again.
export function propSegmentHit(p0, p1, opts = null) {
  const treesOnly = !!(opts && opts.treesOnly);
  const includeTrees = treesOnly || !!(opts && opts.includeTrees);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dz = p1.z - p0.z;
  if (!(Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz))) return null;
  _sq[0] = p0.x; _sq[1] = p0.y; _sq[2] = p0.z;
  _sq[3] = dx; _sq[4] = dy; _sq[5] = dz;
  let best = null;
  let bestT = 2;
  if (!treesOnly && solidSegment()) {
    best = _solidProp;
    bestT = _sq[7];
    _segRes.normal.set(_solidN[0], _solidN[1], _solidN[2]);
  }
  // timber: only what lies in front of the wall can be struck
  if (includeTrees && timberHit(best ? bestT : 1)) {
    best = _timberProp;
    bestT = _sq[7];
    _segRes.normal.set(_cn[0], _cn[1], _cn[2]);
  }
  if (!best) return null;
  _hitPoint.set(p0.x + dx * bestT, p0.y + dy * bestT, p0.z + dz * bestT);
  _segRes.prop = best;
  _segRes.t = bestT;
  return _segRes;
}

// Cheap gameplay query for AI spotting: does a wall or a standing tree sit on
// this sight line? With includeTrees, a wood's interior counts too.
//
// Interior trees are 'grove' props — not shell-hittable, so the 3-8% shell
// lethality propSegmentHit is calibrated to never sees them — and on their own
// they let a spotter look straight through 80 m of forest half the time (only
// the edge trees blocked). Here every standing grove tree the line passes at
// its own height screens a disc of half its crown radius (1-3 m: the stem, the
// low limbs and the brush round it), and the line picks up GROVE_ALPHA of
// opacity per diameter of screen it crosses. At 1 it is blocked. Calibrated on
// random 2.2 m eye-height lines: through >= 80 m of wood 95-99% are
// blocked (meadow / winter / steppe), through 30-80 m 73-89%; lines that only
// clip a wood's edge, or cross none, are as before within 2 points (an
// orchard's rows add a little). Felled trees are 'down' and screen nothing,
// so shelling a wood opens it up.
const GROVE_SCREEN = 0.5;
const GROVE_SCREEN_MIN = 1.0;
const GROVE_SCREEN_MAX = 3.0;
const GROVE_ALPHA = 0.4;

function groveScreenR(p) {
  return clamp((p.crownR || p.r) * GROVE_SCREEN, GROVE_SCREEN_MIN, GROVE_SCREEN_MAX);
}

export function propBlocksLine(from, to, includeTrees = true) {
  // walls, roofs, ruins, rocks and airfield buildings: the same shapes a
  // round meets
  const sx = to.x - from.x;
  const sy = to.y - from.y;
  const sz = to.z - from.z;
  if (!(Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sz))) return false;
  _sq[0] = from.x; _sq[1] = from.y; _sq[2] = from.z;
  _sq[3] = sx; _sq[4] = sy; _sq[5] = sz;
  if (solidSegment()) return true;
  // shell-trees by crown, and the grove screens (see above)
  return includeTrees ? timberScreens() : false;
}

// ---------------------------------------------------------------------------
// Solid colliders
//
// What a round, a bomb, an aim ray or a sight line actually meets. Rocks keep
// their upright cylinder (r, h, now with a lid a plunging round can land on).
// A village building used to be one too — radius solidR, so rounds slipped
// past its corners and down its long walls while an invisible wall stood off
// its gable ends — and it stopped being solid at all the moment it fell.
//
// Each building archetype now carries a COLUMN GRID baked from its own drawn
// geometry, once per session (the kits are session caches, so is this): the
// plan is cut into ~0.2 m columns whose lines fall on the wall planes, and each
// column keeps the lowest and highest point of every wall, roof, chimney, sill
// or shutter face inside it. Columns walled off from the outside — found by a
// flood fill from the grid's border through columns with nothing near the
// ground — are solid down to the footing; the rest (eaves, verges, a coping
// lip) keep only the slab they carry, so a shot still passes under an
// overhang. A second grid is baked from the ruin (shell walls and rubble
// heap), which is what a collapsed building leaves standing: rubble and the
// wall stumps keep stopping rounds below their tops. Faces are binned a few
// millimetres behind themselves so a wall lying on a column line lands in the
// column it encloses, not the one outside it.
//
// A column keeps up to MAXS solid spans (a door step under an eave, a belfry
// floor under its arches, the spire over them). A church's plan is sealed
// slice by slice rather than once at the ground, so an enclosed nave or tower
// shaft is solid while a belfry open on four sides stays open air.
//
// A segment is walked through the grid with a 2-D DDA in the building's own
// frame (one transform, a handful of columns, no allocation), and reports the
// face it entered: a wall's horizontal normal, or for a roof the slope read
// off the neighbouring columns. The frame is the one writeBuilding draws the
// building with, so while it comes down the collider sags and leans with it,
// and then swaps to the ruin grid when the mesh does.
const COLL_CELL = 0.2;      // target column width (m, archetype frame)
const COLL_NUDGE = 0.004;   // faces are binned this far behind themselves
const COLL_LOW = 1.0;       // geometry reaching below this walls a column off
const MAXS = 4;             // solid spans a column keeps
const SPAN2 = MAXS * 2;
const SEAL_SLICE = 0.25;    // a church is sealed in slices this thick (m)
const SEG_CHUNK = 32;       // a long sight line is queried this many metres at a time
// "no limit" for the query loops. Not Infinity: a global read there turned
// the double phis it meets tagged in V8, and every DDA step boxed a number
// (160 bytes of garbage per building query, measured).
const FAR = 1e300;
const HALF_FAR = 5e299;
const collCache = new WeakMap();   // archetype -> { intact, ruin }

// ---------------------------------------------------------------------------
// Query storage
//
// Nothing a per-round query reads is a number on a prop record. The records
// come in half a dozen shapes (tree, grove, hedge, house, rock, pole...), so
// V8 reads them through a megamorphic stub, and a double read that way comes
// back boxed in a fresh 16-byte HeapNumber: 0.3-1.2 KB of garbage per segment
// query, and every round asks twice per substep. So every number a query
// needs is mirrored once, at registration, into typed arrays indexed by a
// small integer the prop carries, and the grids hold those integers:
//   p.pi  PX / PZ / PR    the registry (propsNear: crushing, blasts)
//   p.vi  VD / VK         shell-trees and grove screens (rounds, sight lines)
//   p.si  SD / SB         the solids (buildings, rocks)
// A record is still read for its `state` ('up' / 'falling' / 'down'): a
// tagged value, which costs no allocation.
let PX = new Float64Array(0);
let PZ = new Float64Array(0);
let PR = new Float64Array(0);
const pObj = [];
let pCount = 0;

function growF64(a, n) {
  const b = new Float64Array(n);
  b.set(a);
  return b;
}

function growI32(a, n) {
  const b = new Int32Array(n);
  b.set(a);
  return b;
}

function indexProp(p) {
  const pi = pCount++;
  if (pCount > PX.length) {
    const n = Math.max(1024, PX.length * 2);
    PX = growF64(PX, n);
    PZ = growF64(PZ, n);
    PR = growF64(PR, n);
  }
  PX[pi] = p.x;
  PZ[pi] = p.z;
  PR[pi] = p.r;
  pObj[pi] = p;
  p.pi = pi;
  return pi;
}

// The dense cells (solids and timber share the layout) a box touches, into
// _cr = [cx0, cx1, cz0, cz1]. Registration-time only: the queries inline it.
const _cr = new Int32Array(4);
function cellRange(x0, x1, z0, z1) {
  const a = Math.floor(x0 / CELL) + SG_HALF;
  const b = Math.floor(x1 / CELL) + SG_HALF;
  const c = Math.floor(z0 / CELL) + SG_HALF;
  const d = Math.floor(z1 / CELL) + SG_HALF;
  _cr[0] = a < 0 ? 0 : a >= SG_N ? SG_N - 1 : a;
  _cr[1] = b < 0 ? 0 : b >= SG_N ? SG_N - 1 : b;
  _cr[2] = c < 0 ? 0 : c >= SG_N ? SG_N - 1 : c;
  _cr[3] = d < 0 ? 0 : d >= SG_N ? SG_N - 1 : d;
}

// Timber: every shell-tree (by crown radius, what a round chips) and grove
// tree (by its sight screen, see propBlocksLine), listed in each cell its disc
// touches. VD per entry: x, z, foot (y - 0.5), top, radius.
const VSTRIDE = 5;
let VD = new Float64Array(0);
let VK = new Uint8Array(0);      // 0 gone, 1 shell-tree, 2 grove screen
let VQ = new Int32Array(0);      // per-query stamps (one disc can sit in 4 cells)
const vObj = [];
let vCount = 0;
let vegStamp = 0;
const vegGrid = new Array(SG_N * SG_N);
const vegCells = [];
let _timberProp = null;

function indexTimber(p) {
  const grove = p.kind === 'grove';
  if (!grove && p.kind !== 'tree') return;
  const vi = vCount++;
  if (vCount > VK.length) {
    const n = Math.max(1024, VK.length * 2);
    VD = growF64(VD, n * VSTRIDE);
    const k = new Uint8Array(n);
    k.set(VK);
    VK = k;
    VQ = growI32(VQ, n);
  }
  const r = grove ? groveScreenR(p) : p.crownR || p.r;
  const o = vi * VSTRIDE;
  VD[o] = p.x;
  VD[o + 1] = p.z;
  VD[o + 2] = p.y - 0.5;
  VD[o + 3] = p.y + p.h;
  VD[o + 4] = r;
  VK[vi] = grove ? 2 : 1;
  VQ[vi] = 0;
  vObj[vi] = p;
  p.vi = vi;
  cellRange(p.x - r, p.x + r, p.z - r, p.z + r);
  for (let cx = _cr[0]; cx <= _cr[1]; cx++) {
    for (let cz = _cr[2]; cz <= _cr[3]; cz++) {
      const k = cx * SG_N + cz;
      let cell = vegGrid[k];
      if (!cell) {
        cell = vegGrid[k] = [];
        vegCells.push(k);
      }
      cell.push(vi);
    }
  }
}

function unindexTimber(p) {
  if (!(p.vi >= 0)) return;
  const vi = p.vi;
  const o = vi * VSTRIDE;
  const r = VD[o + 4];
  cellRange(VD[o] - r, VD[o] + r, VD[o + 1] - r, VD[o + 1] + r);
  for (let cx = _cr[0]; cx <= _cr[1]; cx++) {
    for (let cz = _cr[2]; cz <= _cr[3]; cz++) {
      const cell = vegGrid[cx * SG_N + cz];
      if (!cell) continue;
      const i = cell.indexOf(vi);
      if (i >= 0) cell.splice(i, 1);
    }
  }
  VK[vi] = 0;
  p.vi = -1;
}

function clearTimber() {
  for (let i = 0; i < vegCells.length; i++) vegGrid[vegCells[i]] = undefined;
  vegCells.length = 0;
  vObj.length = 0;
  vCount = 0;
}

// Nearest standing shell-tree crown the segment in _sq crosses, no further
// than tMax (0..1). The prop in _timberProp, t in _sq[7], the side the round
// struck in _cn.
function timberHit(tMax) {
  if (!vCount) return false;
  const x0 = _sq[0];
  const y0 = _sq[1];
  const z0 = _sq[2];
  const dx = _sq[3];
  const dy = _sq[4];
  const dz = _sq[5];
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return false;
  const len = Math.sqrt(a);
  const chunks = len > SEG_CHUNK ? Math.ceil(len / SEG_CHUNK) : 1;
  if (++vegStamp > 0x3fffffff) {
    VQ.fill(0);
    vegStamp = 1;
  }
  const stamp = vegStamp;
  let bestT = 2;
  let best = -1;
  for (let k = 0; k < chunks; k++) {
    const ta = k / chunks;
    if (ta > tMax || ta > bestT) break;
    const tb = (k + 1) / chunks;
    const xa = x0 + dx * ta;
    const xb = x0 + dx * tb;
    const za = z0 + dz * ta;
    const zb = z0 + dz * tb;
    let cx0 = Math.floor((xa < xb ? xa : xb) / CELL) + SG_HALF;
    let cx1 = Math.floor((xa > xb ? xa : xb) / CELL) + SG_HALF;
    let cz0 = Math.floor((za < zb ? za : zb) / CELL) + SG_HALF;
    let cz1 = Math.floor((za > zb ? za : zb) / CELL) + SG_HALF;
    if (cx0 < 0) cx0 = 0; else if (cx0 >= SG_N) cx0 = SG_N - 1;
    if (cx1 < 0) cx1 = 0; else if (cx1 >= SG_N) cx1 = SG_N - 1;
    if (cz0 < 0) cz0 = 0; else if (cz0 >= SG_N) cz0 = SG_N - 1;
    if (cz1 < 0) cz1 = 0; else if (cz1 >= SG_N) cz1 = SG_N - 1;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const cell = vegGrid[cx * SG_N + cz];
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const vi = cell[i];
          if (VQ[vi] === stamp) continue;
          VQ[vi] = stamp;
          if (VK[vi] !== 1) continue;
          const o = vi * VSTRIDE;
          const r = VD[o + 4];
          const ox = x0 - VD[o];
          const oz = z0 - VD[o + 1];
          const b = 2 * (ox * dx + oz * dz);
          const c = ox * ox + oz * oz - r * r;
          const disc = b * b - 4 * a * c;
          if (disc < 0) continue;
          const sq = Math.sqrt(disc);
          let t = (-b - sq) / (2 * a);
          if (t < 0) t = (-b + sq) / (2 * a);
          if (t < 0 || t > tMax || t >= bestT) continue;
          const y = y0 + dy * t;
          if (y < VD[o + 2] || y > VD[o + 3]) continue;
          if (vObj[vi].state === 'down') continue;
          bestT = t;
          best = vi;
        }
      }
    }
    if (best >= 0 && bestT <= tb) break;
  }
  if (best < 0) return false;
  // timber is struck on its side
  const o = best * VSTRIDE;
  const nx = x0 - VD[o] + dx * bestT;
  const nz = z0 - VD[o + 1] + dz * bestT;
  const nl = Math.sqrt(nx * nx + nz * nz) || 1;
  _cn[0] = nx / nl;
  _cn[1] = 0;
  _cn[2] = nz / nl;
  _timberProp = vObj[best];
  _sq[7] = bestT;
  return true;
}

// propBlocksLine's timber half on the segment in _sq: a standing shell-tree
// crown blocks outright, grove screens add up (GROVE_ALPHA per diameter).
function timberScreens() {
  if (!vCount) return false;
  const x0 = _sq[0];
  const y0 = _sq[1];
  const z0 = _sq[2];
  const dx = _sq[3];
  const dy = _sq[4];
  const dz = _sq[5];
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return false;
  const len = Math.sqrt(a);
  const chunks = len > SEG_CHUNK ? Math.ceil(len / SEG_CHUNK) : 1;
  if (++vegStamp > 0x3fffffff) {
    VQ.fill(0);
    vegStamp = 1;
  }
  const stamp = vegStamp;
  let screen = 0;
  for (let k = 0; k < chunks; k++) {
    const ta = k / chunks;
    const tb = (k + 1) / chunks;
    const xa = x0 + dx * ta;
    const xb = x0 + dx * tb;
    const za = z0 + dz * ta;
    const zb = z0 + dz * tb;
    let cx0 = Math.floor((xa < xb ? xa : xb) / CELL) + SG_HALF;
    let cx1 = Math.floor((xa > xb ? xa : xb) / CELL) + SG_HALF;
    let cz0 = Math.floor((za < zb ? za : zb) / CELL) + SG_HALF;
    let cz1 = Math.floor((za > zb ? za : zb) / CELL) + SG_HALF;
    if (cx0 < 0) cx0 = 0; else if (cx0 >= SG_N) cx0 = SG_N - 1;
    if (cx1 < 0) cx1 = 0; else if (cx1 >= SG_N) cx1 = SG_N - 1;
    if (cz0 < 0) cz0 = 0; else if (cz0 >= SG_N) cz0 = SG_N - 1;
    if (cz1 < 0) cz1 = 0; else if (cz1 >= SG_N) cz1 = SG_N - 1;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const cell = vegGrid[cx * SG_N + cz];
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const vi = cell[i];
          if (VQ[vi] === stamp) continue;
          VQ[vi] = stamp;
          const kind = VK[vi];
          if (!kind) continue;
          const o = vi * VSTRIDE;
          const r = VD[o + 4];
          const ox = x0 - VD[o];
          const oz = z0 - VD[o + 1];
          const b = 2 * (ox * dx + oz * dz);
          const c = ox * ox + oz * oz - r * r;
          const disc = b * b - 4 * a * c;
          if (disc < 0) continue;
          const sq = Math.sqrt(disc);
          const t0 = (-b - sq) / (2 * a);
          const t1 = (-b + sq) / (2 * a);
          if (kind === 1) {
            const t = t0 >= 0 ? t0 : t1;
            if (t < 0 || t > 1) continue;
            const y = y0 + dy * t;
            if (y < VD[o + 2] || y > VD[o + 3]) continue;
            if (vObj[vi].state === 'down') continue;
            return true;
          }
          const lo = t0 > 0 ? t0 : 0;
          const hi = t1 < 1 ? t1 : 1;
          if (hi <= lo) continue;
          const y = y0 + dy * (lo + hi) * 0.5;
          if (y < VD[o + 2] || y > VD[o + 3]) continue;
          if (vObj[vi].state === 'down') continue;
          screen += (GROVE_ALPHA * (hi - lo) * len) / (2 * r);
          if (screen >= 1) return true;
        }
      }
    }
  }
  return false;
}

// Solids, SSTRIDE doubles each (p.si):
//   [0]       form: 0 gone, 1 upright cylinder (a rock), 2 building on its
//             standing grid, 3 building on its ruin grid
//   [1..3]    frame origin x, y, z (a cylinder's foot centre)
//   [4]       horizontal reach from the origin (a cylinder's radius)
//   [5]       a cylinder's height
//   [6] [7]   the world y range a segment has to overlap
//   [8..16]   a building's world offset -> archetype frame, 3x3 row-major:
//             yaw and scale as placed, then the sag and lean of a collapse
//   [17]      the radius it is listed in the grid by (only ever grows)
//   [18..21]  footprint for hulls: wall half-width, half-depth (world), yaw cos, sin
// SB holds the cell range it is listed in, [cx0, cx1, cz0, cz1].
const SSTRIDE = 22;
let SD = new Float64Array(0);
let SQ = new Int32Array(0);
let SB = new Int32Array(0);
let sCount = 0;
const sIntact = [];               // a building's grids, by si
const sRuin = [];
const _fm = new Float64Array(9);  // a building's forward frame for solidFrame (row-major)

// The segment under test and the answers, in typed scratch rather than in
// arguments and return values: a double handed across a call V8 does not
// inline is boxed, and that was 150 bytes of garbage per query.
//   _sq  world segment  [x0, y0, z0, dx, dy, dz, tMax, tHit]
//   _lr  local ray      [ox, oy, oz, dx, dy, dz, t0, t1, tHit]
//   _cn  the struck face's normal (local, then world), _solidN the winner's
//   _nb  topNormal's four neighbour tops
let _solidProp = null;
const _sq = new Float64Array(8);
const _lr = new Float64Array(9);
const _solidN = new Float64Array(3);
const _cn = new Float64Array(3);
const _nb = new Float64Array(4);
const _clipA = new Float64Array(36);
const _clipB = new Float64Array(36);

function addSolid(p) {
  if (p.si >= 0) return;
  const si = sCount++;
  if (sCount > SQ.length) {
    const n = Math.max(256, SQ.length * 2);
    SD = growF64(SD, n * SSTRIDE);
    SQ = growI32(SQ, n);
    SB = growI32(SB, n * 4);
  }
  solids[si] = p;
  p.si = si;
  SQ[si] = 0;
  SB[si * 4] = 0;
  SB[si * 4 + 1] = -1;
  SB[si * 4 + 2] = 0;
  SB[si * 4 + 3] = -1;
  const o = si * SSTRIDE;
  SD[o + 17] = 0;
  const k = p.coll;
  if (k && k.intact) {
    sIntact[si] = k.intact;
    sRuin[si] = k.ruin || null;
    SD[o + 18] = k.hx * k.s;
    SD[o + 19] = k.hz * k.s;
    SD[o + 20] = k.c;
    SD[o + 21] = k.sn;
    // as placed: yaw and a uniform scale, the frame writeBuilding draws with
    const s = k.s;
    _fm[0] = k.c * s; _fm[1] = 0; _fm[2] = k.sn * s;
    _fm[3] = 0; _fm[4] = s; _fm[5] = 0;
    _fm[6] = -k.sn * s; _fm[7] = 0; _fm[8] = k.c * s;
    solidFrame(si, 2, p.x, k.y, p.z);
    return;
  }
  // a rock (or a building with no grid): the upright cylinder, lid included
  sIntact[si] = null;
  sRuin[si] = null;
  SD[o] = 1;
  SD[o + 1] = p.x;
  SD[o + 2] = p.y;
  SD[o + 3] = p.z;
  SD[o + 4] = p.r;
  SD[o + 5] = p.h;
  SD[o + 6] = p.y - 0.5;
  SD[o + 7] = p.y + p.h;
  SD[o + 18] = 0;
  SD[o + 19] = 0;
  bucketSolid(si, p.r + 0.25);
}

function removeSolid(p) {
  if (!(p.si >= 0)) return;
  unbucketSolid(p.si);
  SD[p.si * SSTRIDE] = 0;
  solids[p.si] = null;
  p.si = -1;
}

// List solid `si` in every cell within R of its origin (after taking it out
// of the cells it was in).
function bucketSolid(si, R) {
  unbucketSolid(si);
  const o = si * SSTRIDE;
  const x = SD[o + 1];
  const z = SD[o + 3];
  const clampS = (c) => (c < 0 ? 0 : c >= SS_N ? SS_N - 1 : c);
  const b = si * 4;
  SB[b] = clampS(Math.floor((x - R) / SCELL) + SS_HALF);
  SB[b + 1] = clampS(Math.floor((x + R) / SCELL) + SS_HALF);
  SB[b + 2] = clampS(Math.floor((z - R) / SCELL) + SS_HALF);
  SB[b + 3] = clampS(Math.floor((z + R) / SCELL) + SS_HALF);
  for (let cx = SB[b]; cx <= SB[b + 1]; cx++) {
    for (let cz = SB[b + 2]; cz <= SB[b + 3]; cz++) {
      const k = cx * SS_N + cz;
      let cell = solidGrid[k];
      if (!cell) {
        cell = solidGrid[k] = [];
        solidCells.push(k);
      }
      cell.push(si);
    }
  }
  SD[o + 17] = R;
}

function unbucketSolid(si) {
  const b = si * 4;
  for (let cx = SB[b]; cx <= SB[b + 1]; cx++) {
    for (let cz = SB[b + 2]; cz <= SB[b + 3]; cz++) {
      const cell = solidGrid[cx * SS_N + cz];
      if (!cell) continue;
      const i = cell.indexOf(si);
      if (i >= 0) cell.splice(i, 1);
    }
  }
  SB[b] = 0;
  SB[b + 1] = -1;
  SB[b + 2] = 0;
  SB[b + 3] = -1;
}

// Building `si` is drawn with the forward frame in _fm (archetype -> world
// offset, row-major) about origin (ox, oy, oz), on its standing grid (form 2)
// or its ruin (3). Stores the inverse the queries use, the reach and the
// height band the frame gives the grid's box, and lists it in more cells if
// a lean has carried it past the radius it was listed by.
function solidFrame(si, form, ox, oy, oz) {
  const G = form === 3 ? sRuin[si] : sIntact[si];
  if (!G) return;
  const m = _fm;
  const a = m[0]; const b = m[1]; const c = m[2];
  const d = m[3]; const e = m[4]; const f = m[5];
  const g = m[6]; const h = m[7]; const i = m[8];
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(det > 1e-12 || det < -1e-12)) return;   // flattened: keep the last frame
  const id = 1 / det;
  const o = si * SSTRIDE;
  SD[o + 8] = A * id; SD[o + 9] = (c * h - b * i) * id; SD[o + 10] = (b * f - c * e) * id;
  SD[o + 11] = B * id; SD[o + 12] = (a * i - c * g) * id; SD[o + 13] = (c * d - a * f) * id;
  SD[o + 14] = C * id; SD[o + 15] = (b * g - a * h) * id; SD[o + 16] = (a * e - b * d) * id;
  SD[o] = form;
  SD[o + 1] = ox;
  SD[o + 2] = oy;
  SD[o + 3] = oz;
  const F = G.f;
  const gx0 = F[0];
  const gz0 = F[1];
  const gx1 = gx0 + F[4] * F[2];
  const gz1 = gz0 + F[5] * F[3];
  let rr = 0;
  let ylo = Infinity;
  let yhi = -Infinity;
  for (let q = 0; q < 8; q++) {
    const lx = q & 1 ? gx1 : gx0;
    const ly = q & 2 ? F[7] : F[6];
    const lz = q & 4 ? gz1 : gz0;
    const wx = a * lx + b * ly + c * lz;
    const wy = d * lx + e * ly + f * lz;
    const wz = g * lx + h * ly + i * lz;
    const r2 = wx * wx + wz * wz;
    if (r2 > rr) rr = r2;
    if (wy < ylo) ylo = wy;
    if (wy > yhi) yhi = wy;
  }
  const reach = Math.sqrt(rr);
  SD[o + 4] = reach;
  SD[o + 6] = oy + ylo - 0.01;
  SD[o + 7] = oy + yhi + 0.01;
  if (reach > SD[o + 17]) bucketSolid(si, reach + (SD[o + 17] > 0 ? 2 : 0.25));
}

function clearSolids() {
  for (let i = 0; i < solidCells.length; i++) solidGrid[solidCells[i]] = undefined;
  solidCells.length = 0;
  solids.length = 0;
  sIntact.length = 0;
  sRuin.length = 0;
  sCount = 0;
}

// ---------------------------------------------------------------------------
// Airfield buildings
//
// world/airfield.js publishes what an aeroplane can hit on a field as world
// boxes (af.obstacles, { name, minX..maxZ }); the rounds, bombs, aim rays and
// sight lines meet the BUILDINGS among them too: the hangars, the control
// tower, the revetment walls and the fuel bowsers. The parked aircraft and the
// windsocks are left out — their boxes are mostly air round a wing or a pole.
// Two shapes are not their box (airfield.js draws them, this follows the
// drawing):
//   hangar         a half-barrel round its long axis, radius min(half width,
//                  height), plus the end wall standing proud of it at the
//                  box's low end (0.6 m thick, 8.4/9 of the height, 16/18 of
//                  the width, as drawn)
//   control tower  the 12 m box steps in: 7 m shaft to 8 m, 8.4 m balcony to
//                  8.5 m, 7.6 m glass to 11.5 m, 9 m roof (widths of the 9 m box)
// The list is re-read whenever the registry changes. Each building hands the
// queries a stand-in prop: kind 'airfield', invulnerable, never felled.
const AF_SOLID_NAMES = { hangar: 1, 'control tower': 1, revetment: 1, 'fuel bowser': 1 };
const HANGAR_WALL_T = 0.6;
const HANGAR_WALL_H = 8.4 / 9;
const HANGAR_WALL_W = 8 / 9;
const TOWER_TIERS = [8, 3.5 / 4.5, 8.5, 4.2 / 4.5, 11.5, 3.8 / 4.5, Infinity, 1];   // up to y: width fraction
const AFP = 8;                   // per primitive: kind (1 box, 2 barrel along x, 3 along z), minX, maxX, minY, maxY, minZ, maxZ, owner
let AFD = new Float64Array(64 * AFP);
let afPrims = 0;
const afOwner = [];              // primitive owner index -> stand-in prop
let AFB = new Float64Array(8 * 8);   // per field: minX, maxX, minY, maxY, minZ, maxZ, first primitive, end
let afFields = 0;
const afSeen = [];
const afSeenObs = [];
const afSeenLen = [];
const afStandIns = new WeakMap();
let _afProp = null;
const _ab = new Float64Array(3);  // slabBox answer: t in, t out, entry axis (-1: began inside)

function afPrim(kind, x0, x1, y0, y1, z0, z1, owner) {
  if ((afPrims + 1) * AFP > AFD.length) AFD = growF64(AFD, AFD.length * 2);
  const o = afPrims * AFP;
  AFD[o] = kind;
  AFD[o + 1] = x0; AFD[o + 2] = x1;
  AFD[o + 3] = y0; AFD[o + 4] = y1;
  AFD[o + 5] = z0; AFD[o + 6] = z1;
  AFD[o + 7] = owner;
  afPrims++;
}

function airfieldStandIn(o, af) {
  let p = afStandIns.get(o);
  if (!p) {
    p = {
      kind: 'airfield', name: o.name, airfield: af,
      x: (o.minX + o.maxX) / 2, z: (o.minZ + o.maxZ) / 2, y: o.minY,
      r: Math.hypot(o.maxX - o.minX, o.maxZ - o.minZ) / 2, h: o.maxY - o.minY,
      hp: Infinity, maxHp: Infinity, state: 'up', solid: true, invulnerable: true,
      crushable: false, crushMass: Infinity, si: -1, vi: -1,
    };
    afStandIns.set(o, p);
  }
  return p;
}

function rebuildAirfieldSolids(list) {
  afSeen.length = 0;
  afSeenObs.length = 0;
  afSeenLen.length = 0;
  afPrims = 0;
  afFields = 0;
  afOwner.length = 0;
  for (let f = 0; f < list.length; f++) {
    const af = list[f];
    const obs = af && af.obstacles;
    afSeen.push(af);
    afSeenObs.push(obs);
    afSeenLen.push(obs ? obs.length : 0);
    if (!obs || !obs.length) continue;
    const first = afPrims;
    let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
    for (const o of obs) {
      if (!o || !AF_SOLID_NAMES[o.name]) continue;
      if (!(o.maxX > o.minX && o.maxY > o.minY && o.maxZ > o.minZ)) continue;
      const owner = afOwner.length;
      afOwner.push(airfieldStandIn(o, af));
      const H = o.maxY - o.minY;
      if (o.name === 'hangar') {
        const alongX = o.maxX - o.minX >= o.maxZ - o.minZ;
        const half = alongX ? (o.maxZ - o.minZ) / 2 : (o.maxX - o.minX) / 2;
        const R = Math.min(half, H);
        if (alongX) {
          const zc = (o.minZ + o.maxZ) / 2;
          afPrim(2, o.minX, o.maxX, o.minY, o.minY + R, zc - R, zc + R, owner);
          afPrim(1, o.minX, o.minX + HANGAR_WALL_T, o.minY, o.minY + R * HANGAR_WALL_H,
            zc - R * HANGAR_WALL_W, zc + R * HANGAR_WALL_W, owner);
        } else {
          const xc = (o.minX + o.maxX) / 2;
          afPrim(3, xc - R, xc + R, o.minY, o.minY + R, o.minZ, o.maxZ, owner);
          afPrim(1, xc - R * HANGAR_WALL_W, xc + R * HANGAR_WALL_W, o.minY, o.minY + R * HANGAR_WALL_H,
            o.minZ, o.minZ + HANGAR_WALL_T, owner);
        }
      } else if (o.name === 'control tower' && H > 10) {
        const xc = (o.minX + o.maxX) / 2;
        const zc = (o.minZ + o.maxZ) / 2;
        const hx = (o.maxX - o.minX) / 2;
        const hz = (o.maxZ - o.minZ) / 2;
        let yb = o.minY;
        for (let k = 0; k < TOWER_TIERS.length; k += 2) {
          const yt = Math.min(o.maxY, o.minY + TOWER_TIERS[k]);
          const w = TOWER_TIERS[k + 1];
          if (yt > yb) afPrim(1, xc - hx * w, xc + hx * w, yb, yt, zc - hz * w, zc + hz * w, owner);
          yb = yt;
        }
      } else {
        afPrim(1, o.minX, o.maxX, o.minY, o.maxY, o.minZ, o.maxZ, owner);
      }
      if (o.minX < x0) x0 = o.minX;
      if (o.maxX > x1) x1 = o.maxX;
      if (o.minY < y0) y0 = o.minY;
      if (o.maxY > y1) y1 = o.maxY;
      if (o.minZ < z0) z0 = o.minZ;
      if (o.maxZ > z1) z1 = o.maxZ;
    }
    if (afPrims === first) continue;
    if ((afFields + 1) * 8 > AFB.length) AFB = growF64(AFB, AFB.length * 2);
    const b = afFields * 8;
    AFB[b] = x0; AFB[b + 1] = x1;
    AFB[b + 2] = y0; AFB[b + 3] = y1;
    AFB[b + 4] = z0; AFB[b + 5] = z1;
    AFB[b + 6] = first;
    AFB[b + 7] = afPrims;
    afFields++;
  }
}

// Re-read the airfield registry if it changed (a field registered, dropped or
// rebuilt): a few identity checks per query otherwise.
function syncAirfields() {
  const list = activeAirfields();
  const n = list.length;
  let same = n === afSeen.length;
  for (let i = 0; same && i < n; i++) {
    const af = list[i];
    const obs = af ? af.obstacles : null;
    if (af !== afSeen[i] || obs !== afSeenObs[i] || (obs ? obs.length : 0) !== afSeenLen[i]) same = false;
  }
  if (!same) rebuildAirfieldSolids(list);
}

// The segment in _sq (t in [0, _sq[6]]) against the box B[k .. k+5] =
// minX, maxX, minY, maxY, minZ, maxZ: true with t in / t out / the entry axis
// in _ab.
function slabBox(B, k) {
  let tn = 0;
  let tf = _sq[6];
  let axis = -1;
  for (let ax = 0; ax < 3; ax++) {
    const p = _sq[ax];
    const d = _sq[3 + ax];
    const lo = B[k + ax * 2];
    const hi = B[k + ax * 2 + 1];
    if (d > 1e-12 || d < -1e-12) {
      let t1 = (lo - p) / d;
      let t2 = (hi - p) / d;
      if (t1 > t2) { const w = t1; t1 = t2; t2 = w; }
      if (t1 > tn) { tn = t1; axis = ax; }
      if (t2 < tf) tf = t2;
      if (tn > tf) return false;
    } else if (p < lo || p > hi) {
      return false;
    }
  }
  _ab[0] = tn;
  _ab[1] = tf;
  _ab[2] = axis;
  return true;
}

// Nearest airfield building on the segment in _sq, no further than tMax: the
// stand-in in _afProp, t in _sq[7], the world normal in _cn.
function airfieldSegment(tMax) {
  syncAirfields();
  if (!afFields) return false;
  const dx = _sq[3];
  const dy = _sq[4];
  const dz = _sq[5];
  let bestT = tMax;
  let best = -1;
  for (let f = 0; f < afFields; f++) {
    const fb = f * 8;
    _sq[6] = bestT;
    if (!slabBox(AFB, fb)) continue;
    const end = AFB[fb + 7] | 0;
    for (let q = AFB[fb + 6] | 0; q < end; q++) {
      const o = q * AFP;
      _sq[6] = bestT;
      if (!slabBox(AFD, o + 1)) continue;
      let t = _ab[0];
      let axis = _ab[2];
      let nx = 0;
      let ny = 0;
      let nz = 0;
      const kind = AFD[o];
      if (kind !== 1) {
        // the barrel: inside the box AND within R of the axis, which runs
        // along the floor of the box (x for kind 2, z for kind 3)
        const R = AFD[o + 4] - AFD[o + 3];
        const ou = kind === 2 ? _sq[2] - (AFD[o + 5] + AFD[o + 6]) * 0.5 : _sq[0] - (AFD[o + 1] + AFD[o + 2]) * 0.5;
        const du = kind === 2 ? dz : dx;
        const ov = _sq[1] - AFD[o + 3];
        const qa = du * du + dy * dy;
        const qb = 2 * (ou * du + ov * dy);
        const qc = ou * ou + ov * ov - R * R;
        let c0 = -FAR;
        let c1 = FAR;
        if (qa > 1e-12) {
          const disc = qb * qb - 4 * qa * qc;
          if (disc < 0) continue;
          const sq = Math.sqrt(disc);
          c0 = (-qb - sq) / (2 * qa);
          c1 = (-qb + sq) / (2 * qa);
        } else if (qc > 0) {
          continue;
        }
        if (c1 < t || c0 > _ab[1]) continue;
        if (c0 > t) {
          t = c0;
          axis = 3;
          const u = (ou + du * t) / R;
          const v = (ov + dy * t) / R;
          if (kind === 2) { nz = u; ny = v; } else { nx = u; ny = v; }
        }
      }
      if (t >= bestT) continue;
      if (axis === 0) nx = dx > 0 ? -1 : 1;
      else if (axis === 1) ny = dy > 0 ? -1 : 1;
      else if (axis === 2) nz = dz > 0 ? -1 : 1;
      else if (axis < 0) {
        // began inside it
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        nx = -dx / l; ny = -dy / l; nz = -dz / l;
      }
      bestT = t;
      best = q;
      _cn[0] = nx;
      _cn[1] = ny;
      _cn[2] = nz;
    }
  }
  if (best < 0) return false;
  _afProp = afOwner[AFD[best * AFP + 7] | 0];
  _sq[7] = bestT;
  return true;
}

// Nearest solid crossed by the segment in _sq (t in [0, 1]). Leaves the prop
// in _solidProp, its t in _sq[7] and the world face normal in _solidN. A
// 600 m sight line only looks at the cells along it and stops at the first
// wall: every
// solid is listed in each SCELL cell it can reach, so the cells are walked in
// the order the segment crosses them and the walk ends at the first cell whose
// exit lies past the best hit. The airfield buildings go first; their t
// bounds the rest.
function solidSegment() {
  const x0 = _sq[0];
  const z0 = _sq[2];
  const dx = _sq[3];
  const dz = _sq[5];
  let bestT = 1;
  let best = null;
  if (airfieldSegment(1)) {
    bestT = _sq[7];
    best = _afProp;
    _solidN[0] = _cn[0];
    _solidN[1] = _cn[1];
    _solidN[2] = _cn[2];
  }
  if (sCount) {
    if (++solidStamp > 0x3fffffff) {
      SQ.fill(0);
      solidStamp = 1;
    }
    const stamp = solidStamp;
    const ya = _sq[1];
    const yb = ya + _sq[4];
    const ylo = ya < yb ? ya : yb;
    const yhi = ya > yb ? ya : yb;
    // a 2-D DDA over the solid grid, cell by cell in the order the segment
    // crosses them, stopping once the best hit lies before the cell's exit
    const gx = x0 / SCELL + SS_HALF;
    const gz = z0 / SCELL + SS_HALF;
    let cx = Math.floor(gx);
    let cz = Math.floor(gz);
    const ex = Math.floor(gx + dx / SCELL);
    const ez = Math.floor(gz + dz / SCELL);
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const adx = dx < 0 ? -dx : dx;
    const adz = dz < 0 ? -dz : dz;
    const tdx = adx > 1e-12 ? SCELL / adx : FAR;
    const tdz = adz > 1e-12 ? SCELL / adz : FAR;
    let tmx = adx > 1e-12 ? ((cx + (dx > 0 ? 1 : 0) - gx) * SCELL) / dx : FAR;
    let tmz = adz > 1e-12 ? ((cz + (dz > 0 ? 1 : 0) - gz) * SCELL) / dz : FAR;
    let steps = (ex > cx ? ex - cx : cx - ex) + (ez > cz ? ez - cz : cz - ez) + 2;
    for (; steps > 0; steps--) {
      const kx = cx < 0 ? 0 : cx >= SS_N ? SS_N - 1 : cx;
      const kz = cz < 0 ? 0 : cz >= SS_N ? SS_N - 1 : cz;
      const cell = solidGrid[kx * SS_N + kz];
      if (cell) {
        for (let i = 0; i < cell.length; i++) {
          const si = cell[i];
          if (SQ[si] === stamp) continue;
          SQ[si] = stamp;
          const o = si * SSTRIDE;
          const form = SD[o];
          if (!form || SD[o + 6] > yhi || SD[o + 7] < ylo) continue;
          _sq[6] = bestT;
          const hit = form === 1 ? hitCylinder(si) : hitBuilding(si);
          if (hit && _sq[7] < bestT) {
            bestT = _sq[7];
            best = solids[si];
            _solidN[0] = _cn[0];
            _solidN[1] = _cn[1];
            _solidN[2] = _cn[2];
          }
        }
      }
      const tExit = tmx < tmz ? tmx : tmz;
      if (bestT <= tExit) break;
      if (tmx < tmz) {
        cx += stepX;
        tmx += tdx;
      } else {
        cz += stepZ;
        tmz += tdz;
      }
    }
  }
  if (!best) return false;
  _solidProp = best;
  _sq[7] = bestT;
  return true;
}

// A rock: the upright cylinder it always was, lid included (and a building
// with no grid, while it stands). Segment in _sq; on a hit, t in _sq[7] and
// the face normal in _cn.
function hitCylinder(si) {
  const o = si * SSTRIDE;
  const px = _sq[0];
  const py = _sq[1];
  const pz = _sq[2];
  const dx = _sq[3];
  const dy = _sq[4];
  const dz = _sq[5];
  const tMax = _sq[6];
  const yb = SD[o + 6];
  const yt = SD[o + 7];
  const y1 = py + dy * tMax;
  if ((py < y1 ? py : y1) > yt || (py > y1 ? py : y1) < yb) return false;
  if (solids[si].state !== 'up') return false;
  const r = SD[o + 4];
  const ox = px - SD[o + 1];
  const oz = pz - SD[o + 3];
  const a = dx * dx + dz * dz;
  const c = ox * ox + oz * oz - r * r;
  let t0 = -FAR;
  let t1 = FAR;
  if (a > 1e-12) {
    const b = 2 * (ox * dx + oz * dz);
    const disc = b * b - 4 * a * c;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    t0 = (-b - sq) / (2 * a);
    t1 = (-b + sq) / (2 * a);
    if (t1 < 0 || t0 > tMax) return false;
  } else if (c > 0) {
    return false;
  }
  if (t0 >= 0) {
    const y = py + dy * t0;
    if (y >= yb && y <= yt) {
      const nx = ox + dx * t0;
      const nz = oz + dz * t0;
      const nl = Math.sqrt(nx * nx + nz * nz) || 1;
      _cn[0] = nx / nl;
      _cn[1] = 0;
      _cn[2] = nz / nl;
      _sq[7] = t0;
      return true;
    }
  } else if (py >= yb && py <= yt) {
    // started inside the stone
    const l = Math.sqrt(a + dy * dy) || 1;
    _cn[0] = -dx / l;
    _cn[1] = -dy / l;
    _cn[2] = -dz / l;
    _sq[7] = 0;
    return true;
  }
  // over the side and down onto the top
  if (dy < 0 && py > yt) {
    const tc = (yt - py) / dy;
    if (tc <= tMax && tc >= t0 && tc <= t1) {
      _cn[0] = 0;
      _cn[1] = 1;
      _cn[2] = 0;
      _sq[7] = tc;
      return true;
    }
  }
  return false;
}

// A building: its standing grid, or its ruin once the collapse has swapped the
// mesh over. World segment (_sq) into the building frame (_lr), DDA, normal
// back out; on a hit, t in _sq[7] and the world normal in _cn.
function hitBuilding(si) {
  const o = si * SSTRIDE;
  const G = SD[o] === 3 ? sRuin[si] : sIntact[si];
  if (!G) return false;
  const dx = _sq[3];
  const dy = _sq[4];
  const dz = _sq[5];
  const tMax = _sq[6];
  const yA = _sq[1];
  const yB = yA + dy * tMax;
  if ((yA < yB ? yA : yB) > SD[o + 7] || (yA > yB ? yA : yB) < SD[o + 6]) return false;
  const ox = _sq[0] - SD[o + 1];
  const oy = yA - SD[o + 2];
  const oz = _sq[2] - SD[o + 3];
  const a2 = dx * dx + dz * dz;
  let tc = a2 > 1e-12 ? -(ox * dx + oz * dz) / a2 : 0;
  if (tc < 0) tc = 0;
  else if (tc > tMax) tc = tMax;
  const qx = ox + dx * tc;
  const qz = oz + dz * tc;
  const reach = SD[o + 4];
  if (qx * qx + qz * qz > reach * reach) return false;
  // into the archetype frame: the inverse of the frame it is drawn with
  const m0 = SD[o + 8]; const m1 = SD[o + 9]; const m2 = SD[o + 10];
  const m3 = SD[o + 11]; const m4 = SD[o + 12]; const m5 = SD[o + 13];
  const m6 = SD[o + 14]; const m7 = SD[o + 15]; const m8 = SD[o + 16];
  _lr[0] = m0 * ox + m1 * oy + m2 * oz;
  _lr[1] = m3 * ox + m4 * oy + m5 * oz;
  _lr[2] = m6 * ox + m7 * oy + m8 * oz;
  _lr[3] = m0 * dx + m1 * dy + m2 * dz;
  _lr[4] = m3 * dx + m4 * dy + m5 * dz;
  _lr[5] = m6 * dx + m7 * dy + m8 * dz;
  _lr[6] = 0;
  _lr[7] = tMax;
  if (!gridRay(G)) return false;
  // a normal goes back out through the inverse's transpose
  const lx = _cn[0];
  const ly = _cn[1];
  const lz = _cn[2];
  const wx = m0 * lx + m3 * ly + m6 * lz;
  const wy = m1 * lx + m4 * ly + m7 * lz;
  const wz = m2 * lx + m5 * ly + m8 * lz;
  const l = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
  _cn[0] = wx / l;
  _cn[1] = wy / l;
  _cn[2] = wz / l;
  _sq[7] = _lr[8];
  return true;
}

// First solid column surface on the local ray in _lr (o + d t, t in [t0, t1]),
// in the grid's own frame. On a hit: true, t in _lr[8], the local outward
// normal in _cn.
function gridRay(G) {
  const ox = _lr[0];
  const oy = _lr[1];
  const oz = _lr[2];
  const dx = _lr[3];
  const dy = _lr[4];
  const dz = _lr[5];
  // the grid's numbers live in a Float64Array (G.f), its spans in G.sp / G.ns
  const F = G.f;
  const gx0 = F[0];
  const gz0 = F[1];
  const csx = F[2];
  const csz = F[3];
  const nx = F[4] | 0;
  const nz = F[5] | 0;
  const gx1 = gx0 + nx * csx;
  const gz1 = gz0 + nz * csz;
  let ta = _lr[6];
  let tb = _lr[7];
  let axis = -1;   // the box face the segment came in through (-1: began inside)
  if (dx > 1e-12 || dx < -1e-12) {
    let tn = (gx0 - ox) / dx;
    let tf = (gx1 - ox) / dx;
    if (tn > tf) { const w = tn; tn = tf; tf = w; }
    if (tn > ta) { ta = tn; axis = 0; }
    if (tf < tb) tb = tf;
  } else if (ox < gx0 || ox > gx1) return false;
  if (dy > 1e-12 || dy < -1e-12) {
    let tn = (F[6] - oy) / dy;
    let tf = (F[7] - oy) / dy;
    if (tn > tf) { const w = tn; tn = tf; tf = w; }
    if (tn > ta) { ta = tn; axis = 1; }
    if (tf < tb) tb = tf;
  } else if (oy < F[6] || oy > F[7]) return false;
  if (dz > 1e-12 || dz < -1e-12) {
    let tn = (gz0 - oz) / dz;
    let tf = (gz1 - oz) / dz;
    if (tn > tf) { const w = tn; tn = tf; tf = w; }
    if (tn > ta) { ta = tn; axis = 2; }
    if (tf < tb) tb = tf;
  } else if (oz < gz0 || oz > gz1) return false;
  if (ta > tb) return false;

  let ix = Math.floor((ox + dx * ta - gx0) / csx);
  let iz = Math.floor((oz + dz * ta - gz0) / csz);
  if (ix < 0) ix = 0; else if (ix >= nx) ix = nx - 1;
  if (iz < 0) iz = 0; else if (iz >= nz) iz = nz - 1;
  const stepX = dx > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const adx = dx < 0 ? -dx : dx;
  const adz = dz < 0 ? -dz : dz;
  const tdx = adx > 1e-12 ? csx / adx : FAR;
  const tdz = adz > 1e-12 ? csz / adz : FAR;
  let tmx = adx > 1e-12 ? (gx0 + (ix + (dx > 0 ? 1 : 0)) * csx - ox) / dx : FAR;
  let tmz = adz > 1e-12 ? (gz0 + (iz + (dz > 0 ? 1 : 0)) * csz - oz) / dz : FAR;
  const sp = G.sp;
  const ns = G.ns;
  let t = ta;
  for (let guard = nx + nz + 4; guard > 0; guard--) {
    const tn = tmx < tmz ? tmx : tmz;
    const te = tn < tb ? tn : tb;
    const i = ix * nz + iz;
    const cnt = ns[i];
    if (cnt) {
      const ya = oy + dy * t;
      const ye = oy + dy * te;
      // up to MAXS solid spans per column (a door step under an eave is two
      // things with air between them); the segment is straight, so whichever
      // span it meets first in this column is the hit
      let th = -1;
      let thSpan = -1;   // the span whose top was struck; -1: a span's underside
      const base = i * SPAN2;
      for (let k = 0; k < cnt; k++) {
        const cb = sp[base + k * 2];
        const ct = sp[base + k * 2 + 1];
        if (ya >= cb && ya <= ct) {
          if (axis === 0) { _cn[0] = -stepX; _cn[1] = 0; _cn[2] = 0; }
          else if (axis === 2) { _cn[0] = 0; _cn[1] = 0; _cn[2] = -stepZ; }
          else if (axis === 1 && dy < 0) topNormal(G, ix, iz, k);
          else if (axis === 1) { _cn[0] = 0; _cn[1] = -1; _cn[2] = 0; }
          else {
            const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            _cn[0] = -dx / l; _cn[1] = -dy / l; _cn[2] = -dz / l;
          }
          _lr[8] = t;
          return true;
        }
        if (ya > ct && ye <= ct) {
          const tt = (ct - oy) / dy;
          if (th < 0 || tt < th) { th = tt; thSpan = k; }
        } else if (ya < cb && ye >= cb) {
          const tt = (cb - oy) / dy;
          if (th < 0 || tt < th) { th = tt; thSpan = -1; }
        }
      }
      if (th >= 0) {
        if (thSpan >= 0) topNormal(G, ix, iz, thSpan);
        else { _cn[0] = 0; _cn[1] = -1; _cn[2] = 0; }
        _lr[8] = th;
        return true;
      }
    }
    if (tn >= tb) return false;
    if (tmx < tmz) {
      ix += stepX;
      if (ix < 0 || ix >= nx) return false;
      t = tmx;
      tmx += tdx;
      axis = 0;
    } else {
      iz += stepZ;
      if (iz < 0 || iz >= nz) return false;
      t = tmz;
      tmz += tdz;
      axis = 2;
    }
  }
  return false;
}

// Roof (or rubble) slope at a column whose span `k` had its top struck, from
// the nearest-matching span tops of its four neighbours (-FAR: an empty one);
// an edge column is read one-sided, a chimney's step is clamped.
function topNormal(G, ix, iz, k) {
  const F = G.f;
  const nx = F[4] | 0;
  const nz = F[5] | 0;
  const sp = G.sp;
  const ns = G.ns;
  const i = ix * nz + iz;
  const c = sp[i * SPAN2 + k * 2 + 1];
  for (let q = 0; q < 4; q++) {
    let j = -1;
    if (q === 0) { if (ix > 0) j = i - nz; }
    else if (q === 1) { if (ix < nx - 1) j = i + nz; }
    else if (q === 2) { if (iz > 0) j = i - 1; }
    else if (iz < nz - 1) j = i + 1;
    // the neighbour's span top nearest this one (-FAR: nothing there)
    let v = -FAR;
    if (j >= 0) {
      const cnt = ns[j];
      let bd = FAR;
      for (let m = 0; m < cnt; m++) {
        const tv = sp[j * SPAN2 + m * 2 + 1];
        const dd = tv > c ? tv - c : c - tv;
        if (dd < bd) {
          bd = dd;
          v = tv;
        }
      }
    }
    _nb[q] = v;
  }
  const l = _nb[0];
  const r = _nb[1];
  const d = _nb[2];
  const u = _nb[3];
  const hl = l > -HALF_FAR;
  const hr = r > -HALF_FAR;
  const hd = d > -HALF_FAR;
  const hu = u > -HALF_FAR;
  const csx = F[2];
  const csz = F[3];
  let gx = hl && hr ? (l - r) / (2 * csx) : hl ? (l - c) / csx : hr ? (c - r) / csx : 0;
  let gz = hd && hu ? (d - u) / (2 * csz) : hd ? (d - c) / csz : hu ? (c - u) / csz : 0;
  gx = gx > 3 ? 3 : gx < -3 ? -3 : gx;
  gz = gz > 3 ? 3 : gz < -3 ? -3 : gz;
  const l2 = Math.sqrt(gx * gx + 1 + gz * gz);
  _cn[0] = gx / l2;
  _cn[1] = 1 / l2;
  _cn[2] = gz / l2;
}

// Keep the part of polygon `src` (n vertices, xyz) on one side of the plane
// coordinate[axis] = value: sign 1 keeps the greater side, -1 the lesser.
// Strictly: a face only touching a column's edge does not land in it.
function clipPoly(src, n, dst, axis, value, sign) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const da = (src[i * 3 + axis] - value) * sign;
    const db = (src[j * 3 + axis] - value) * sign;
    if (da > 0) {
      dst[m * 3] = src[i * 3];
      dst[m * 3 + 1] = src[i * 3 + 1];
      dst[m * 3 + 2] = src[i * 3 + 2];
      m++;
    }
    if ((da > 0) !== (db > 0)) {
      const t = da / (da - db);
      dst[m * 3] = src[i * 3] + (src[j * 3] - src[i * 3]) * t;
      dst[m * 3 + 1] = src[i * 3 + 1] + (src[j * 3 + 1] - src[i * 3 + 1]) * t;
      dst[m * 3 + 2] = src[i * 3 + 2] + (src[j * 3 + 2] - src[i * 3 + 2]) * t;
      m++;
    }
  }
  return m;
}

// One triangle into the columns it covers: each column gets the min / max
// height of the part of the triangle inside it.
function binTri(G, v, ia, ib, ic) {
  let ax = v[ia * 3]; let ay = v[ia * 3 + 1]; let az = v[ia * 3 + 2];
  let bx = v[ib * 3]; let by = v[ib * 3 + 1]; let bz = v[ib * 3 + 2];
  let cx = v[ic * 3]; let cy = v[ic * 3 + 1]; let cz = v[ic * 3 + 2];
  const ux = bx - ax; const uy = by - ay; const uz = bz - az;
  const wx = cx - ax; const wy = cy - ay; const wz = cz - az;
  let nx = uy * wz - uz * wy;
  let ny = uz * wx - ux * wz;
  let nz = ux * wy - uy * wx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-12) return;
  const k = COLL_NUDGE / len;
  nx *= k; ny *= k; nz *= k;
  ax -= nx; ay -= ny; az -= nz;
  bx -= nx; by -= ny; bz -= nz;
  cx -= nx; cy -= ny; cz -= nz;
  const minX = Math.min(ax, bx, cx);
  const maxX = Math.max(ax, bx, cx);
  const minZ = Math.min(az, bz, cz);
  const maxZ = Math.max(az, bz, cz);
  const ix0 = Math.max(0, Math.floor((minX - G.x0) / G.csx));
  const ix1 = Math.min(G.nx - 1, Math.floor((maxX - G.x0) / G.csx));
  const iz0 = Math.max(0, Math.floor((minZ - G.z0) / G.csz));
  const iz1 = Math.min(G.nz - 1, Math.floor((maxZ - G.z0) / G.csz));
  for (let ix = ix0; ix <= ix1; ix++) {
    const x0 = G.x0 + ix * G.csx;
    const x1 = x0 + G.csx;
    for (let iz = iz0; iz <= iz1; iz++) {
      const z0 = G.z0 + iz * G.csz;
      const z1 = z0 + G.csz;
      _clipA[0] = ax; _clipA[1] = ay; _clipA[2] = az;
      _clipA[3] = bx; _clipA[4] = by; _clipA[5] = bz;
      _clipA[6] = cx; _clipA[7] = cy; _clipA[8] = cz;
      let m = clipPoly(_clipA, 3, _clipB, 0, x0, 1);
      if (m) m = clipPoly(_clipB, m, _clipA, 0, x1, -1);
      if (m) m = clipPoly(_clipA, m, _clipB, 2, z0, 1);
      if (m) m = clipPoly(_clipB, m, _clipA, 2, z1, -1);
      if (!m) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = 0; j < m; j++) {
        const y = _clipA[j * 3 + 1];
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      const i = ix * G.nz + iz;
      const list = G.raw[i] || (G.raw[i] = []);
      list.push(lo, hi);
    }
  }
}

// A column's binned pieces [lo, hi, lo, hi, ...], sorted and merged where they
// touch (within COLL_GAP), as a flat list of the same shape.
const COLL_GAP = 0.1;
function columnSpans(list) {
  const n = list.length / 2;
  const order = [];
  for (let k = 0; k < n; k++) order.push(k);
  order.sort((a, b) => list[a * 2] - list[b * 2]);
  const spans = [];
  for (const k of order) {
    const lo = list[k * 2];
    const hi = list[k * 2 + 1];
    const m = spans.length;
    if (m && lo <= spans[m - 1] + COLL_GAP) {
      if (hi > spans[m - 1]) spans[m - 1] = hi;
    } else {
      spans.push(lo, hi);
    }
  }
  return spans;
}

// Store a column's spans in the grid, cut down to MAXS by closing the
// narrowest gaps.
function storeColumn(G, i, spans) {
  while (spans.length > SPAN2) {
    let best = 0;
    for (let j = 1; j * 2 + 2 < spans.length; j++) {
      if (spans[j * 2 + 2] - spans[j * 2 + 1] < spans[best * 2 + 2] - spans[best * 2 + 1]) best = j;
    }
    spans[best * 2 + 1] = Math.max(spans[best * 2 + 1], spans[best * 2 + 3]);
    spans.splice(best * 2 + 2, 2);
  }
  G.ns[i] = spans.length / 2;
  for (let k = 0; k < spans.length; k++) G.sp[i * SPAN2 + k] = spans[k];
}

// Columns enclosed by walls are solid from the footing up; open ones keep
// just what they carry. `cols` holds each column's flat span list (or null:
// nothing drawn there, which stays open air whatever surrounds it).
//   fillRect (a house): walls reaching below COLL_LOW enclose the plan, and
//     everything inside the wall rectangle is filled as well, so an open
//     doorway does not hollow the house out.
//   otherwise (a church): sealed slice by slice, SEAL_SLICE thick — a column
//     is filled over a slice when that slice is walled off from the grid's
//     border at that height, so the nave and the tower shaft are solid while
//     the belfry, open on four sides, stays open between its piers.
function sealColumns(G, cols, hx, hz, fillRect, floorY) {
  const nx = G.nx;
  const nz = G.nz;
  const n = nx * nz;
  const wall = new Uint8Array(n);
  const outside = new Uint8Array(n);
  const queue = new Int32Array(n);
  // flood from the border through the columns `wall` leaves open
  const flood = () => {
    outside.fill(0);
    let head = 0;
    let tail = 0;
    const visit = (i) => {
      if (outside[i] || wall[i]) return;
      outside[i] = 1;
      queue[tail++] = i;
    };
    for (let ix = 0; ix < nx; ix++) {
      visit(ix * nz);
      visit(ix * nz + nz - 1);
    }
    for (let iz = 0; iz < nz; iz++) {
      visit(iz);
      visit((nx - 1) * nz + iz);
    }
    while (head < tail) {
      const i = queue[head++];
      const ix = (i / nz) | 0;
      const iz = i - ix * nz;
      if (ix > 0) visit(i - nz);
      if (ix < nx - 1) visit(i + nz);
      if (iz > 0) visit(i - 1);
      if (iz < nz - 1) visit(i + 1);
    }
  };
  if (fillRect) {
    for (let i = 0; i < n; i++) wall[i] = cols[i] && cols[i][0] < COLL_LOW ? 1 : 0;
    flood();
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const i = ix * nz + iz;
        const c = cols[i];
        if (!c) continue;
        // enclosed and open = the floor plan; a wall column itself (closed)
        // is solid where it is drawn, which for a wall is footing to roof
        let inside = !outside[i] && !wall[i];
        if (!inside) {
          const cx = G.x0 + (ix + 0.5) * G.csx;
          const cz = G.z0 + (iz + 0.5) * G.csz;
          inside = Math.abs(cx) < hx && Math.abs(cz) < hz;
        }
        if (inside) cols[i] = [floorY, c[c.length - 1]];
      }
    }
    return;
  }
  let yTop = floorY;
  for (let i = 0; i < n; i++) {
    const c = cols[i];
    if (c && c[c.length - 1] > yTop) yTop = c[c.length - 1];
  }
  const add = new Array(n);
  for (let y0 = floorY; y0 < yTop; y0 += SEAL_SLICE) {
    const y1 = y0 + SEAL_SLICE;
    for (let i = 0; i < n; i++) {
      const c = cols[i];
      let w = 0;
      if (c) {
        for (let k = 0; k < c.length; k += 2) {
          if (c[k] <= y1 && c[k + 1] >= y0) {
            w = 1;
            break;
          }
        }
      }
      wall[i] = w;
    }
    flood();
    for (let i = 0; i < n; i++) {
      if (!cols[i] || outside[i] || wall[i]) continue;
      (add[i] || (add[i] = [])).push(y0, y1);
    }
  }
  for (let i = 0; i < n; i++) {
    if (add[i]) cols[i] = columnSpans(cols[i].concat(add[i]));
  }
}

// The column grid of one geometry set (archetype frame, unscaled), with its
// lines on the wall planes x = +/-hx, z = +/-hz.
function buildColumnGrid(geos, hx, hz, fillRect) {
  if (!(hx > 0 && hz > 0)) return null;
  let xMin = Infinity; let xMax = -Infinity;
  let yMin = Infinity;
  let zMin = Infinity; let zMax = -Infinity;
  const sets = [];
  for (const g of geos) {
    const pos = g && typeof g.getAttribute === 'function' ? g.getAttribute('position') : null;
    if (!pos || !pos.count) continue;
    const v = new Float64Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      v[i * 3] = x; v[i * 3 + 1] = y; v[i * 3 + 2] = z;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    sets.push({ v, index: g.index ? g.index.array : null, count: pos.count });
  }
  if (!sets.length || !Number.isFinite(xMin + xMax + yMin + zMin + zMax)) return null;
  const nxIn = Math.max(1, Math.round((2 * hx) / COLL_CELL));
  const nzIn = Math.max(1, Math.round((2 * hz) / COLL_CELL));
  const csx = (2 * hx) / nxIn;
  const csz = (2 * hz) / nzIn;
  const kx0 = Math.max(0, Math.ceil((-hx - xMin) / csx - 1e-6));
  const kx1 = Math.max(0, Math.ceil((xMax - hx) / csx - 1e-6));
  const kz0 = Math.max(0, Math.ceil((-hz - zMin) / csz - 1e-6));
  const kz1 = Math.max(0, Math.ceil((zMax - hz) / csz - 1e-6));
  const G = {
    x0: -hx - kx0 * csx, z0: -hz - kz0 * csz, csx, csz,
    nx: kx0 + nxIn + kx1, nz: kz0 + nzIn + kz1,
    // what the queries read, all in typed arrays (see "Query storage"):
    //   f   x0, z0, csx, csz, nx, nz, ymin, ymax, reach
    //   sp  MAXS spans per column, lower first: [lo, hi] * MAXS
    //   ns  spans in use per column
    f: new Float64Array(9), sp: null, ns: null, raw: null,
  };
  const n = G.nx * G.nz;
  G.raw = new Array(n);
  for (const s of sets) {
    const idx = s.index;
    const tris = Math.floor((idx ? idx.length : s.count) / 3);
    for (let t = 0; t < tris; t++) {
      if (idx) binTri(G, s.v, idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
      else binTri(G, s.v, t * 3, t * 3 + 1, t * 3 + 2);
    }
  }
  const cols = new Array(n);
  for (let i = 0; i < n; i++) {
    const list = G.raw[i];
    cols[i] = list && list.length ? columnSpans(list) : null;
  }
  G.raw = null;
  sealColumns(G, cols, hx, hz, fillRect, yMin);
  G.sp = new Float32Array(n * SPAN2);
  G.ns = new Uint8Array(n);
  let yTop = yMin;
  for (let i = 0; i < n; i++) {
    if (!cols[i]) continue;
    storeColumn(G, i, cols[i]);
    const top = G.sp[i * SPAN2 + G.ns[i] * 2 - 1];
    if (top > yTop) yTop = top;
  }
  const gx1 = G.x0 + G.nx * csx;
  const gz1 = G.z0 + G.nz * csz;
  const reach = Math.max(Math.hypot(G.x0, G.z0), Math.hypot(gx1, G.z0), Math.hypot(G.x0, gz1), Math.hypot(gx1, gz1));
  G.f[0] = G.x0;
  G.f[1] = G.z0;
  G.f[2] = csx;
  G.f[3] = csz;
  G.f[4] = G.nx;
  G.f[5] = G.nz;
  G.f[6] = yMin;
  G.f[7] = yTop;
  G.f[8] = reach;
  return G;
}

// Per archetype, once a session: the standing grid and the ruin grid.
function archetypeColliders(arch) {
  let c = collCache.get(arch);
  if (c) return c;
  const plain = arch.role !== 'church';   // a church's plan is a nave and a tower, not one box
  const hx = arch.w / 2;
  const hz = arch.d / 2;
  const parts = arch.parts || {};
  const ruin = arch.ruin || null;
  let intact = null;
  let ruined = null;
  try {
    intact = buildColumnGrid([parts.walls, parts.roof, parts.trim], hx, hz, plain);
    ruined = ruin ? buildColumnGrid([ruin.walls, ruin.rubble], hx, hz, plain) : null;
  } catch (err) {
    console.warn('[scenery] building collider unavailable:', err);
  }
  c = { intact, ruin: ruined };
  collCache.set(arch, c);
  return c;
}

// A placed building's collider: its archetype's grids and the instance frame
// writeBuilding draws it with (origin at the footprint centre, base y, yaw,
// uniform scale).
function buildingCollider(arch, x, z, y, yaw, s) {
  const cg = archetypeColliders(arch);
  if (!cg.intact) return null;
  const reach = Math.max(cg.intact.f[8], cg.ruin ? cg.ruin.f[8] : 0) * s;
  return {
    intact: cg.intact, ruin: cg.ruin,
    x, z, y, s, c: Math.cos(yaw), sn: Math.sin(yaw), reach,
    // the wall rectangle (archetype frame, unscaled): what a hull is kept out of
    hx: arch.w / 2, hz: arch.d / 2,
  };
}

// ---------------------------------------------------------------------------
// Instance writing
//
// One entry point for every mesh kind a slot can live in. A BatchedMesh keeps
// its matrices in a texture and flags the upload itself; an InstancedMesh has
// to be told, and only the sixteen floats that changed are re-sent, so a tree
// falling in a wood of three thousand does not re-upload the whole wood.
function setSlotMatrix(sl, m) {
  const mesh = sl.mesh;
  mesh.setMatrixAt(sl.index, m);
  if (mesh.isBatchedMesh) return;
  const im = mesh.instanceMatrix;
  if (typeof im.addUpdateRange === 'function') im.addUpdateRange(sl.index * 16, 16);
  im.needsUpdate = true;
}

function writeProp(prop, u) {
  const slots = prop.slots;
  if (prop.building) {
    writeBuilding(prop, u);
    return;
  }
  if (prop.kind === 'house') {
    // legacy layout: a box-centred instanced house (kept for any caller that
    // registers one by hand)
    const sink = u * 0.6;
    const tilt = u * 0.2;
    _axis.set(prop.fallAx, 0, prop.fallAz);
    _q.setFromAxisAngle(_axis, tilt);
    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i];
      _q2.set(sl.qx, sl.qy, sl.qz, sl.qw);
      _q3.copy(_q).multiply(_q2);
      const oy = sl.oy * (1 - sink) - (sl.roof ? u * sl.oy * 0.5 : 0);
      _v.set(prop.x, prop.y + oy, prop.z);
      _s.set(sl.sx * (1 + u * 0.14), sl.sy * (1 - sink), sl.sz * (1 + u * 0.14));
      _m.compose(_v, _q3, _s);
      setSlotMatrix(sl, _m);
    }
    return;
  }
  if (prop.kind === 'hedge') {
    // A hull through a hedgerow does not topple it like a tree: the brush is
    // flattened where it stands and leans the way it was pushed, each clump
    // about its own foot, so the gap a tank tore stays a gap in the line.
    _axis.set(prop.fallAx, 0, prop.fallAz);
    _q.setFromAxisAngle(_axis, u * 0.55);
    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i];
      _q2.set(sl.qx, sl.qy, sl.qz, sl.qw);
      _q3.copy(_q).multiply(_q2);
      _v.set(prop.x + (sl.ox || 0), prop.y + sl.oy - u * 0.25, prop.z + (sl.oz || 0));
      _s.set(sl.sx * (1 + u * 0.18), sl.sy * (1 - u * 0.72), sl.sz * (1 + u * 0.18));
      _m.compose(_v, _q3, _s);
      setSlotMatrix(sl, _m);
    }
    return;
  }
  const a = prop.span * u;
  _axis.set(prop.fallAx, 0, prop.fallAz);
  _q.setFromAxisAngle(_axis, a);
  for (let i = 0; i < slots.length; i++) {
    const sl = slots[i];
    _q2.set(sl.qx, sl.qy, sl.qz, sl.qw);
    _q3.copy(_q).multiply(_q2);
    _v2.set(sl.ox || 0, sl.oy, sl.oz || 0).applyQuaternion(_q);
    _v.set(prop.x + _v2.x, prop.y + _v2.y, prop.z + _v2.z);
    _s.set(sl.sx, sl.sy, sl.sz);
    _m.compose(_v, _q3, _s);
    setSlotMatrix(sl, _m);
  }
}

// A village building coming down (kit geometry: origin at the footprint
// centre, base y = 0). For the first half of the collapse the intact building
// sags and leans away from the hit; then, if this three.js can swap an
// instance's geometry (BatchedMesh.setGeometryIdAt, r166+), the walls become
// the kit's ruined shell, the roof its rubble heap and the window/door trim
// disappears, all in place, so the village keeps its burnt-out houses for the
// rest of the battle instead of a row of flattened boxes. The ruin settles a
// hand's breadth into its own debris.
const RUIN_SWAP = 0.5;
const _up = new THREE.Vector3(0, 1, 0);

function writeBuilding(prop, u) {
  const b = prop.building;
  const parts = b.parts;
  const ruin = b.canRuin && u >= RUIN_SWAP;
  if (ruin && !b.ruined) {
    b.ruined = true;
    for (let i = 0; i < parts.length; i++) {
      const pt = parts[i];
      if (pt.ruinGeo !== null && pt.ruinGeo !== undefined) pt.mesh.setGeometryIdAt(pt.index, pt.ruinGeo);
      else pt.mesh.setVisibleAt(pt.index, false);
    }
  }
  if (ruin) {
    _q.setFromAxisAngle(_up, b.yaw);
    _v.set(prop.x, b.y - 0.12, prop.z);
    _s.set(b.s, b.s, b.s);
  } else {
    const sink = u * 0.6;
    _axis.set(prop.fallAx, 0, prop.fallAz);
    _q2.setFromAxisAngle(_axis, u * 0.2);
    _q3.setFromAxisAngle(_up, b.yaw);
    _q.copy(_q2).multiply(_q3);
    _v.set(prop.x, b.y, prop.z);
    _s.set(b.s * (1 + u * 0.1), b.s * (1 - sink), b.s * (1 + u * 0.1));
  }
  _m.compose(_v, _q, _s);
  for (let i = 0; i < parts.length; i++) setSlotMatrix(parts[i], _m);
  // the collider is drawn with the same frame: it sags and leans with the
  // building, then becomes the ruin when the mesh does
  if (prop.si >= 0) {
    frameFromQuat(_q, _s.x, _s.y, _s.z);
    solidFrame(prop.si, ruin && sRuin[prop.si] ? 3 : 2, _v.x, _v.y, _v.z);
  }
}

// _fm = rotation(q) * scale(sx, sy, sz), row-major: the linear part of the
// matrix Matrix4.compose builds from the same three.
function frameFromQuat(q, sx, sy, sz) {
  const x = q.x;
  const y = q.y;
  const z = q.z;
  const w = q.w;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2; const xy = x * y2; const xz = x * z2;
  const yy = y * y2; const yz = y * z2; const zz = z * z2;
  const wx = w * x2; const wy = w * y2; const wz = w * z2;
  _fm[0] = (1 - (yy + zz)) * sx; _fm[1] = (xy - wz) * sy; _fm[2] = (xz + wy) * sz;
  _fm[3] = (xy + wz) * sx; _fm[4] = (1 - (xx + zz)) * sy; _fm[5] = (yz - wx) * sz;
  _fm[6] = (xz - wy) * sx; _fm[7] = (yz + wx) * sy; _fm[8] = (1 - (xx + yy)) * sz;
}

// ---------------------------------------------------------------------------
// Per-frame tick. Wired automatically through scene.onBeforeRender, so felling
// animates and snow falls whether or not a battle file remembers to call it.
export function updateScenery(dt = 0.016, camera = null) {
  lastTick = clockMs();
  const step = dt > 0.25 ? 0.25 : dt;
  windUniforms.time.value += step;

  for (let i = falling.length - 1; i >= 0; i--) {
    const p = falling[i];
    const total = p.kind === 'house' ? COLLAPSE_TIME : FALL_TIME;
    p.fallT += step;
    let u = p.fallT / total;
    if (u >= 1) {
      u = 1;
      p.state = 'down';
      falling.splice(i, 1);
    }
    // ease in: a tree hangs, then goes over fast, which is how they actually go
    writeProp(p, u * u * (3 - 2 * u) * 0.5 + u * u * 0.5);
  }

  // The shadow volume follows the viewer here rather than in the battle files,
  // so a caller that does nothing still gets shadows around itself — and,
  // critically, gets them WITHOUT the old hardcoded sun offset that threw the
  // preset time of day away.
  if (camera) updateSunAnchor(camera);

  // The grass ring follows the camera; it only rebuilds the 4 m cells that
  // entered it, so this is a few hundred microseconds on a moving frame.
  if (groundCover && camera) {
    try {
      groundCover.update(camera);
    } catch (err) {
      // grass is decoration: a fault there must never stop the battle
      console.warn('[scenery] ground cover disabled:', err);
      try { groundCover.dispose(); } catch { /* already gone */ }
      groundCover = null;
    }
  }

  if (precip && camera) {
    precip.position.set(
      Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z),
    );
  }
}

function installDriver(scene) {
  // three calls scene.onBeforeRender once per render, which is the cheapest
  // per-frame hook available without asking every battle file to wire one.
  // Wrapping the same scene twice would tick the fall animation twice a frame,
  // so the hook is installed once and remembered for disposeScenery to undo.
  if (driverScene === scene) return;
  const prev = scene.onBeforeRender;
  driverScene = scene;
  driverPrev = prev;
  let last = clockMs();
  scene.onBeforeRender = function sceneryDriver(renderer, sc, camera, target) {
    const now = clockMs();
    const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
    last = now;
    if (now - lastTick > 8) updateScenery(dt, camera);
    // L-06: the height fog dissolves the 7 km skirt between 6.3 and 7 km; a
    // battle camera built with a 2.5-4 km far plane would cut the world off
    // first, mid-veil, as a hard edge. Runs before three builds the frustum.
    if (heightFog && camera && camera.isPerspectiveCamera && camera.far < CAMERA_REACH) {
      camera.far = CAMERA_REACH;
      camera.updateProjectionMatrix();
    }
    // The image-based light and the preset exposure both need a renderer, and
    // this hook is the only place in scenery.js that ever has one. Driving them
    // here means a battle file that calls nothing still gets a lit sky.
    updateEnvironment(renderer, dt);
    applyExposure(renderer);
    if (typeof prev === 'function') prev.call(this, renderer, sc, camera, target);
  };
}

// ---------------------------------------------------------------------------
// DRESSING (maps.md contract S)
//
// The landscape is laid out, not scattered. landuse.js decides — from the
// terrain seed and the biome, with no Math.random — where the fields, hedge
// lines, woods, orchards, village lots and the telegraph line are; this file
// turns that plan into instances and registers the ones gameplay can touch.
//
//   woods        every wood patch filled with real trees of the biome's
//                species (one crown + one trunk InstancedMesh per species),
//                its rim closed by a mantle of shrubs so the edge reads as a
//                wall of foliage and not a row of bare trunks
//   hedgerows    clumps every 2.6 m along each 'hedge' parcel edge (gaps
//                honoured) on a merged earth bank, a standard tree every
//                25-40 m; the steppe's shelter belts are rows of trees instead
//   rows         roadside poplars, orchards in 6 m rows, a few lone field trees
//   village      the lots, built from the biome's buildings.js kit as one
//                BatchedMesh per kit material (3 draw calls for the village)
//   rocks        clustered on slopes, ridge crests and in woods, not sprinkled
//   fences       along the 'fence' edges (yards, paddocks by the road)
//   poles        the telegraph line along the road, with its wires
//   far woods    cheap woodland hulls from the edge of the dressed square out
//                to 2.5 km, on the terrain's far skirt, so the horizon is
//                closed by trees instead of ending at the mesh border
//   grass        groundcover.js, a camera-centred ring of tufts
//
// Everything honours keepOuts(). Scene-wide costs on the ground map (meadow,
// high): 22 main-pass and 14 shadow-pass draw calls for the whole world half,
// terrain and sky included, about 0.58 M triangles of which 0.26 M cast.

// Registered 'tree' props are what a shell can clip and what blocks an AI
// sight line through a wood edge. The audit measured a random 14 m shell
// segment hitting a prop 3.4% of the time with the old 240 trees; registering
// every one of several thousand trees would push that past 30%. So only the
// trees a shot meets first — wood edges, hedgerow standards, lone field trees,
// roadside rows — are 'tree' props, capped at about 600 on the ground map and
// scaled with the dressed area on the bigger maps, so the density a shell
// meets is the same everywhere. Every other tree is a 'grove' prop: a hull
// still flattens it and a blast still fells it, but shells and sight lines
// ignore it, exactly as they ignore a fence.
const TREE_PROP_CAP = 600;
const GROUND_SQUARE = 888 * 888;     // the ground map's dressed square (m2)
const EDGE_DEPTH = 10;               // metres inside a wood that still count as its edge
const REG_ROLES = { edge: 1, lone: 1, standard: 1, row: 1 };
// What a round at tank height actually meets in a tree is the trunk and the
// lower limbs, not the full spread of the crown 6-8 m up: a 14 m segment that
// clips the canopy's shadow on the ground has gone under the branches. The
// shell radius is therefore a fraction of the crown radius, which is also
// what keeps the hit rate inside the audit's 3-8% band with the edge trees
// registered (measured: see the report in the scratchpad harness).
const SHELL_CROWN = 0.3;
const SHELL_R_MIN = 1.1;
const SHELL_R_MAX = 3.0;

const WOOD_TREE_BUDGET = { low: 2200, medium: 4200, high: 7000 };
// Wood fill. Trees stand on a jittered lattice WOOD_SPACING x the species'
// mean crown radius apart, from WOOD_INSET metres inside the land-use outline
// (the mantle shrubs own the rim). That leaves the canopy about three-quarters
// closed from above, with the odd glade, which is what keeps the meadow inside
// the audit's 8-20% canopy target although landuse.js lets woods take 19% of
// the ground: its cap assumed scenery would leave gaps, and real woods do.
const WOOD_SPACING = 1.5;
const WOOD_INSET = 3.5;
const FOREST_FORM = 0.82;
const HEDGE_STEP = { low: 3.3, medium: 2.9, high: 2.6 };
const BANK_H = 1.2;           // bocage earth bank, metres above the turf (visual only)
const DRESS_LIMIT = 760;     // hedges, woods and orchards stop here on the big maps
const FAR_WOODS_OUT = 2500;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// small deterministic helpers

function makeRng(seed) {
  let a = seed | 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromFeatures(feat) {
  let h = 0x2545f491;
  const mix = (v) => { h = Math.imul(h ^ (Math.round(v * 100) | 0), 0x01000193); h ^= h >>> 13; };
  if (feat && feat.town) { mix(feat.town.x || 0); mix(feat.town.z || 0); }
  for (const p of (feat && feat.road) || []) if (p) { mix(p.x || 0); mix(p.z || 0); }
  return h >>> 0;
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// sRGB hex -> linear triple, decoded by hand (THREE.Color.setHex would do the
// same conversion, but every other colour path in the world modules is
// explicit about it and instance colours are uploaded linear).
function srgbToLin(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function hexLinear(hex, out = [0, 0, 0]) {
  const h = Number.isFinite(hex) ? hex : 0x808080;
  out[0] = srgbToLin((h >> 16) & 255);
  out[1] = srgbToLin((h >> 8) & 255);
  out[2] = srgbToLin(h & 255);
  return out;
}
// byte-wise sRGB mix, the same blend composePreset applies for snow
function mixHex(a, b, t) {
  const k = clamp(t, 0, 1);
  const ch = (s) => Math.round(lerp((a >> s) & 255, (b >> s) & 255, k));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
const SNOW_HEX = 0xe8eef4;
const _c = new THREE.Color();
function linColor(r, g, b) {
  return _c.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
}

function segDist(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = 0;
  if (l2 > 1e-9) {
    t = ((px - ax) * abx + (pz - az) * abz) / l2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const qx = ax + abx * t - px;
  const qz = az + abz * t - pz;
  return Math.sqrt(qx * qx + qz * qz);
}

// Metres inside the nearest capsule of a wood (negative = outside it).
function capsDepth(caps, x, z) {
  let best = -Infinity;
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    const d = c.r - segDist(x, z, c.ax, c.az, c.bx, c.bz);
    if (d > best) best = d;
  }
  return best;
}

function inGaps(t, gaps) {
  if (!gaps) return false;
  for (let i = 0; i < gaps.length; i++) if (t >= gaps[i][0] && t <= gaps[i][1]) return true;
  return false;
}

// Oriented lot rectangle (landuse.js convention: rotation.y = yaw, local +X ->
// world (cos, -sin), local +Z -> (sin, cos), w along X, d along Z).
function inLot(l, x, z, pad) {
  const c = Math.cos(l.yaw);
  const s = Math.sin(l.yaw);
  const dx = x - l.x;
  const dz = z - l.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= l.w / 2 + pad && Math.abs(lz) <= l.d / 2 + pad;
}

function nearLot(ctx, x, z, pad) {
  const lots = ctx.lots;
  for (let i = 0; i < lots.length; i++) {
    const l = lots[i];
    if (Math.abs(l.x - x) > 40 || Math.abs(l.z - z) > 40) continue;
    if (inLot(l, x, z, pad)) return true;
  }
  return false;
}

function biomeOf(preset) {
  if (preset && typeof preset.biome === 'string' && MAP_PRESETS[preset.biome]) return preset.biome;
  for (const k of Object.keys(MAP_PRESETS)) if (MAP_PRESETS[k] === preset) return k;
  return 'meadow';
}

function qualityTier() {
  let q = 'high';
  try { q = getMaterialQuality(); } catch { q = 'high'; }
  return q === 'low' || q === 'medium' ? q : 'high';
}

function safeRead(fn, fallback) {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch (err) {
    console.warn('[scenery] land-use list unavailable:', err);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// The ground the dressing stands on. The main terrain mesh follows
// terrainHeight exactly; beyond it, the far skirt terrain.js hangs off it
// follows its own far-field shape on coarse triangles. Distant woods have to
// sit on what is actually rendered there, so the skirt is sampled from its
// own triangles (bucketed once, lazily) rather than from a formula that could
// drift from the mesh by metres.
function findGround(scene, propArea) {
  let mesh = null;
  const kids = scene && Array.isArray(scene.children) ? scene.children : [];
  for (let i = 0; i < kids.length; i++) {
    const o = kids[i];
    const g = o && o.isMesh ? o.geometry : null;
    if (g && g.attributes && g.attributes.aSurf) { mesh = o; break; }
  }
  let info = null;
  try {
    info = terrainModule.terrainMeshInfo?.() || null;
  } catch {
    info = null;
  }
  let half = NaN;
  if (mesh) {
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (bb) half = Math.min(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z);
  }
  if (!(half > 0) && info && info.half > 0) half = info.half;
  if (!(half > 0)) half = Math.max(WORLD_SIZE, propArea || 0) / 2;

  const skirts = [];
  if (mesh) {
    const s = mesh.userData && mesh.userData.skirt;
    if (s && s.isMesh) skirts.push(s);
    mesh.traverse((c) => {
      if (c !== mesh && c.isMesh && c.geometry && !skirts.includes(c)) skirts.push(c);
    });
  }
  let outer = info && info.skirtOuter > 0 ? info.skirtOuter : 0;
  if (!outer && skirts.length) {
    for (const s of skirts) {
      if (!s.geometry.boundingBox) s.geometry.computeBoundingBox();
      const bb = s.geometry.boundingBox;
      if (bb) outer = Math.max(outer, Math.min(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z));
    }
  }
  // terrain.js can answer "how high is the skirt as drawn" itself
  // (terrainSkirtHeight walks the skirt's own triangles), but only for the
  // LAST terrain it built. That is this battle's when the extents agree;
  // otherwise (a hangar preview built in between, an older terrain.js) the
  // skirt in the scene is bucketed here instead.
  const skirtFn = typeof terrainModule.terrainSkirtHeight === 'function' && info
    && Math.abs((info.half || 0) - half) < 1e-3 ? terrainModule.terrainSkirtHeight : null;
  let tri = null;
  return {
    mesh,
    half,
    outer,
    hasSkirt: skirts.length > 0,
    heightAt(x, z) {
      if (Math.abs(x) <= half && Math.abs(z) <= half) return terrainHeight(x, z);
      if (!skirts.length) return null;
      if (skirtFn) {
        const y = skirtFn(x, z);
        if (Number.isFinite(y)) return y;
      }
      if (!tri) tri = buildTriGrid(skirts, FAR_WOODS_OUT + 300);
      return sampleTriGrid(tri, x, z);
    },
  };
}

const TRI_CELL = 64;
function triKey(cx, cz) {
  return (cx + 4096) * 8192 + (cz + 4096);
}

function buildTriGrid(meshes, lim) {
  const cells = new Map();
  const tris = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.getAttribute('position');
    if (!pos) continue;
    m.updateWorldMatrix(true, false);
    const wp = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      wp[i * 3] = v.x;
      wp[i * 3 + 1] = v.y;
      wp[i * 3 + 2] = v.z;
    }
    const idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const a = idx ? idx.getX(t) : t;
      const b = idx ? idx.getX(t + 1) : t + 1;
      const c = idx ? idx.getX(t + 2) : t + 2;
      const ax = wp[a * 3]; const az = wp[a * 3 + 2];
      const bx = wp[b * 3]; const bz = wp[b * 3 + 2];
      const cx = wp[c * 3]; const cz = wp[c * 3 + 2];
      const x0 = Math.min(ax, bx, cx); const x1 = Math.max(ax, bx, cx);
      const z0 = Math.min(az, bz, cz); const z1 = Math.max(az, bz, cz);
      if (x0 > lim || x1 < -lim || z0 > lim || z1 < -lim) continue;
      const area = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
      if (Math.abs(area) < 1e-6) continue;   // a vertical wall has no height to give
      const ti = tris.length;
      tris.push(ax, wp[a * 3 + 1], az, bx, wp[b * 3 + 1], bz, cx, wp[c * 3 + 1], cz);
      for (let gx = Math.floor(x0 / TRI_CELL); gx <= Math.floor(x1 / TRI_CELL); gx++) {
        for (let gz = Math.floor(z0 / TRI_CELL); gz <= Math.floor(z1 / TRI_CELL); gz++) {
          const k = triKey(gx, gz);
          let list = cells.get(k);
          if (!list) { list = []; cells.set(k, list); }
          list.push(ti);
        }
      }
    }
  }
  return { cells, tris };
}

function sampleTriGrid(tg, x, z) {
  const list = tg.cells.get(triKey(Math.floor(x / TRI_CELL), Math.floor(z / TRI_CELL)));
  if (!list) return null;
  const T = tg.tris;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    const ax = T[o]; const ay = T[o + 1]; const az = T[o + 2];
    const bx = T[o + 3]; const by = T[o + 4]; const bz = T[o + 5];
    const cx = T[o + 6]; const cy = T[o + 7]; const cz = T[o + 8];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
    return l1 * ay + l2 * by + l3 * cy;
  }
  return null;
}

// ---------------------------------------------------------------------------
// One record per battle that every builder below reads.
function makeDressContext(scene, preset, propArea, feat) {
  const biome = biomeOf(preset);
  const quality = qualityTier();
  let lu = null;
  try {
    lu = landUseFor(feat, preset, { terrainHeight, terrainSlope, roadDistanceAt });
  } catch (err) {
    console.warn('[scenery] land use unavailable, dressing a bare map:', err);
    lu = null;
  }
  const ground = findGround(scene, propArea);
  const meshHalf = ground.half;
  const seed = lu && lu.params && Number.isFinite(lu.params.seed) ? lu.params.seed : seedFromFeatures(feat);
  // Three squares. Rocks use the battle's own scatter square (propArea).
  // Hedges, orchards, fences and lone trees are dense where the ground fight
  // is — the prop area, at least the ground map's 900 m — and stop at the edge
  // of the mesh or at DRESS_LIMIT; past that only aircraft see the ground, and
  // the terrain shader's field margins plus the far woods carry the look.
  // Woods are finite shapes landuse.js already placed: they are filled out to
  // DRESS_LIMIT whatever the prop area, so none is cut off with a straight
  // edge where the hedges stop.
  const P = Math.max(60, Math.min((propArea || WORLD_SIZE) / 2, meshHalf - 10));
  const woodHalf = Math.max(60, Math.min(meshHalf - 6, DRESS_LIMIT));
  const dressHalf = Math.max(60, Math.min(woodHalf, Math.max(P, 450)));
  const lots = lu ? safeRead(() => lu.lots, []) : [];
  return {
    biome,
    quality,
    lu,
    feat,
    preset,
    seed,
    ground,
    meshHalf,
    P,
    dressHalf,
    woodHalf,
    // An air battle's prop area is the whole map and nobody drives through
    // its hedges: they are seen from 100 m up and more, so they are laid at a
    // wider step with bigger clumps (35% fewer instances, same silhouette).
    hedgeStepMul: P > DRESS_LIMIT ? 1.35 : 1,
    lots,
    snow: Number(preset.snowCover) || 0,
    rng: makeRng(seed ^ 0x5ce7e5),
    areaScale: Math.max(1, ((dressHalf * 2) ** 2) / GROUND_SQUARE),
  };
}

// The checks every scattered thing makes before it stands somewhere.
function clearSpot(ctx, x, z, road, keep, lot, cap, lim = ctx.dressHalf) {
  if (Math.abs(x) > lim || Math.abs(z) > lim) return false;
  if (cap > 0 && x * x + z * z < cap * cap) return false;
  if (inKeepOut(x, z, keep)) return false;
  if (road > 0 && roadDistanceAt(x, z) < road) return false;
  if (lot >= 0 && nearLot(ctx, x, z, lot)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Vegetation: woods, hedgerows, rows, orchards, lone trees

function vegetationMaterial(rough, sway) {
  // Own material, never the shared mattMaterial cache: applySway patches the
  // shader, and a patch on a cached material leaks into every caller of it.
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: rough, metalness: 0, vertexColors: true,
  });
  if (sway) applySway(m);
  return m;
}

function floraSet(ctx) {
  let list = [];
  try {
    list = treeArchetypes(ctx.biome, ctx.quality);
  } catch (err) {
    console.warn('[scenery] flora unavailable:', err);
    list = [];
  }
  const w = ctx.preset.flora || {};
  for (const a of list) if (Number.isFinite(w[a.key]) && w[a.key] > 0) a.weight = w[a.key];
  return list;
}

function poolFor(type, arches) {
  const wood = arches.filter((a) => a.role === 'wood');
  const pick = (keys) => wood.filter((a) => keys.includes(a.key));
  let pool;
  if (type === 'conifer') pool = pick(['spruce', 'pine']);
  else if (type === 'broadleaf') pool = pick(['oak', 'beech', 'birch']);
  else if (type === 'palm') pool = arches.filter((a) => a.key === 'palm');
  else pool = wood;
  if (!pool.length) pool = wood.length ? wood : arches.filter((a) => a.role !== 'scrub');
  if (!pool.length) pool = arches.slice();
  return pool;
}

function pickWeighted(pool, r) {
  let total = 0;
  for (const a of pool) total += a.weight > 0 ? a.weight : 0.01;
  let k = r * total;
  for (const a of pool) {
    k -= a.weight > 0 ? a.weight : 0.01;
    if (k <= 0) return a;
  }
  return pool[pool.length - 1];
}

function meanCrownR(pool) {
  let s = 0;
  let w = 0;
  for (const a of pool) {
    const ww = a.weight > 0 ? a.weight : 0.01;
    s += ww * a.crownRFactor * (a.heightRange[0] + a.heightRange[1]) * 0.5;
    w += ww;
  }
  return w > 0 ? s / w : 4;
}

function bucketOf(buckets, arch) {
  let b = buckets.get(arch.key);
  if (!b) {
    b = { arch, items: [] };
    buckets.set(arch.key, b);
  }
  return b;
}

function treeItem(ctx, arch, x, z, role, hMul = 1, yOff = 0) {
  const r = ctx.rng;
  const [h0, h1] = arch.heightRange;
  // a little skew to the tall end: a mature wood is mostly full-grown trees
  const h = lerp(h0, h1, Math.sqrt(r())) * hMul;
  return {
    x, z, h, role, yOff,
    yaw: r() * TAU,
    // a crown is never perfectly round in plan: +/-7% between its two axes
    ax: 0.93 + r() * 0.14,
    az: 0.93 + r() * 0.14,
    tint: r(),
    shell: false,
  };
}

function addVegetation(scene, ctx) {
  const arches = floraSet(ctx);
  if (!arches.length) return;
  const buckets = new Map();
  const hedge = { clumps: [], groups: [], runs: [] };
  collectWoods(ctx, arches, buckets, hedge);
  collectHedgerows(ctx, arches, buckets, hedge);
  collectRoadRows(ctx, arches, buckets);
  collectOrchards(ctx, arches, buckets);
  collectLoneTrees(ctx, arches, buckets);
  dropKeepOutCrowns(buckets);
  chooseRegisteredTrees(ctx, buckets);
  buildTreeMeshes(scene, ctx, buckets);
  buildHedges(scene, ctx, hedge);
}

// --- woods -------------------------------------------------------------------
function collectWoods(ctx, arches, buckets, hedge) {
  const woods = ctx.lu && Array.isArray(ctx.lu.woods) ? ctx.lu.woods : [];
  if (!woods.length) return;
  const rng = ctx.rng;
  const lim = ctx.woodHalf;

  // Spacing from the species' real crown size: crowns just touching at the
  // nominal spacing, so a wood reads as one canopy from the air. If the map's
  // woods would need more trees than the quality tier allows, every wood is
  // thinned evenly rather than the last ones dropped.
  const plans = [];
  let estimate = 0;
  for (const w of woods) {
    const caps = Array.isArray(w.caps) ? w.caps.filter((c) => c && c.r > 0) : [];
    if (!caps.length) continue;
    const pool = poolFor(w.type, arches);
    let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
    for (const c of caps) {
      x0 = Math.min(x0, c.ax - c.r, c.bx - c.r);
      x1 = Math.max(x1, c.ax + c.r, c.bx + c.r);
      z0 = Math.min(z0, c.az - c.r, c.bz - c.r);
      z1 = Math.max(z1, c.az + c.r, c.bz + c.r);
    }
    x0 = Math.max(x0, -lim); x1 = Math.min(x1, lim);
    z0 = Math.max(z0, -lim); z1 = Math.min(z1, lim);
    if (x0 >= x1 || z0 >= z1) continue;
    let area = 0;
    for (let x = x0 + 2.5; x < x1; x += 5) {
      for (let z = z0 + 2.5; z < z1; z += 5) if (capsDepth(caps, x, z) >= WOOD_INSET) area += 25;
    }
    if (area <= 0) continue;
    const s = clamp(WOOD_SPACING * meanCrownR(pool), 4.2, 12);
    estimate += area / (s * s);
    plans.push({ w, caps, pool, s, x0, x1, z0, z1 });
  }
  const budget = WOOD_TREE_BUDGET[ctx.quality] || WOOD_TREE_BUDGET.high;
  const thin = estimate > budget ? Math.sqrt(estimate / budget) : 1;
  const mantleStep = ctx.quality === 'low' ? 4.2 : 3.2;

  for (const pl of plans) {
    const s = pl.s * thin;
    const palm = pl.w.type === 'palm';
    for (let gx = Math.floor(pl.x0 / s); gx * s <= pl.x1; gx++) {
      for (let gz = Math.floor(pl.z0 / s); gz * s <= pl.z1; gz++) {
        const x = (gx + 0.5 + (rng() - 0.5) * 0.76) * s;
        const z = (gz + 0.5 + (rng() - 0.5) * 0.76) * s;
        const depth = capsDepth(pl.caps, x, z);
        if (depth < WOOD_INSET) continue;
        if (!clearSpot(ctx, x, z, 8, 3, 3, 50, lim)) continue;
        if (terrainSlope(x, z) > 1.1) continue;
        const arch = pickWeighted(pl.pool, rng());
        const edge = depth < EDGE_DEPTH;
        // edge trees grow lower and spread wider into the light; inside, a
        // broad-crowned species grows forest-form, tall with a narrow crown
        const it = treeItem(ctx, arch, x, z, edge ? 'edge' : 'interior', edge ? 0.82 + 0.18 * rng() : 1);
        if (!edge && arch.crownRFactor > 0.3) { it.ax *= FOREST_FORM; it.az *= FOREST_FORM; }
        bucketOf(buckets, arch).items.push(it);
      }
    }
    if (!palm) woodMantle(ctx, pl.caps, hedge, mantleStep);
  }
}

// A wood's rim is a mantle of shrubs and saplings, not a fence of trunks:
// without it the first metres of every wood are bare poles under a canopy.
// Clumps go just inside the boundary of the union of the wood's capsules,
// walked as straight flanks plus end arcs, skipping stretches inside another
// lobe of the same wood. They share the hedge InstancedMesh (no extra draw
// call) and are registered as hedge props, so a tank breaks into a wood
// through the brush.
function woodMantle(ctx, caps, hedge, step) {
  const rng = ctx.rng;
  for (const c of caps) {
    const dx = c.bx - c.ax;
    const dz = c.bz - c.az;
    const L = Math.hypot(dx, dz);
    const tx = L > 1e-6 ? dx / L : 1;
    const tz = L > 1e-6 ? dz / L : 0;
    const pts = [];   // [x, z, outward nx, nz, newRun]
    if (L > 1) {
      for (const side of [1, -1]) {
        const nx = -tz * side;
        const nz = tx * side;
        let first = true;
        for (let s = 0; s <= L; s += step) {
          pts.push([c.ax + tx * s + nx * c.r, c.az + tz * s + nz * c.r, nx, nz, first]);
          first = false;
        }
      }
    }
    for (const [ex, ez, sx] of [[c.ax, c.az, -1], [c.bx, c.bz, 1]]) {
      if (L <= 1 && sx > 0) break;   // a round lobe: one full circle from the A end
      const base = Math.atan2(tz * sx, tx * sx);
      const sweep = L <= 1 ? TAU : Math.PI;
      const n = Math.max(3, Math.ceil((sweep * c.r) / step));
      for (let k = 0; k <= n; k++) {
        const a = base - sweep / 2 + (sweep * k) / n;
        const nx = Math.cos(a);
        const nz = Math.sin(a);
        pts.push([ex + nx * c.r, ez + nz * c.r, nx, nz, k === 0]);
      }
    }
    let group = null;
    let sinceGroup = 0;
    const flush = () => {
      if (group && group.length) hedge.groups.push(group);
      group = null;
      sinceGroup = 0;
    };
    for (const [px, pz, nx, nz, newRun] of pts) {
      if (newRun) flush();
      if (capsDepth(caps, px, pz) > 0.4) { flush(); continue; }
      const inset = 1.0 + rng() * 0.9;
      const x = px - nx * inset;
      const z = pz - nz * inset;
      if (!clearSpot(ctx, x, z, 7, 2, 2, 45, ctx.woodHalf) || terrainSlope(x, z) > 1.0) { flush(); continue; }
      const w = (2.6 + rng() * 1.8) * (step / 3.2);
      // the shrub's own half-width clear of a keep-out, not just its centre
      if (inKeepOut(x, z, w * 0.55 + 0.3)) { flush(); continue; }
      hedge.clumps.push({
        x, z, y: terrainHeight(x, z) - 0.15,
        sx: w, sy: w * (0.72 + rng() * 0.3), sz: w * (0.8 + rng() * 0.3),
        yaw: rng() * TAU, tint: rng(), mantle: true,
      });
      if (!group) group = [];
      group.push(hedge.clumps.length - 1);
      sinceGroup += step;
      if (sinceGroup >= 10) flush();
    }
    flush();
  }
}

// --- hedgerows ----------------------------------------------------------------
function collectHedgerows(ctx, arches, buckets, hedge) {
  const lu = ctx.lu;
  if (!lu) return;
  const edges = safeRead(() => lu.edges, []);
  if (!edges.length) return;
  const rng = ctx.rng;
  const belt = (lu.params && lu.params.hedgeStyle) === 'belt';
  const step = (HEDGE_STEP[ctx.quality] || 2.6) * ctx.hedgeStepMul;
  const bankH = belt ? 0 : BANK_H;
  const lim = ctx.dressHalf - 1;
  const woodPool = arches.filter((a) => a.role === 'wood');
  const standardPool = belt
    ? arches.filter((a) => a.role === 'row' || a.key === 'birch')
    : (woodPool.filter((a) => a.key === 'oak').length ? woodPool.filter((a) => a.key === 'oak') : woodPool);
  const pt = { x: 0, z: 0 };
  const pa = { x: 0, z: 0 };
  const pb = { x: 0, z: 0 };
  const town = ctx.feat && ctx.feat.town && Number.isFinite(ctx.feat.town.x)
    ? { x: ctx.feat.town.x, z: ctx.feat.town.z, radius: Number(ctx.feat.town.radius) || 0 } : null;

  for (const e of edges) {
    if (!e || e.type !== 'hedge' || !(e.len > step)) continue;
    if (Math.min(e.ax, e.bx) > lim + 20 || Math.max(e.ax, e.bx) < -lim - 20) continue;
    if (Math.min(e.az, e.bz) > lim + 20 || Math.max(e.az, e.bz) < -lim - 20) continue;
    const len = e.len;
    const n = Math.max(1, Math.round(len / step));
    const ds = len / n;
    let run = null;
    const close = () => {
      if (run && run.clumps.length) finishHedgeRun(ctx, run, hedge, buckets, standardPool, belt, bankH);
      run = null;
    };
    for (let k = 0; k < n; k++) {
      const s = (k + 0.5) * ds;
      const t = s / len;
      if (inGaps(t, e.gaps)) { close(); continue; }
      edgePointAt(e, t, pt);
      // landuse.js already gaps the lines off the road, the cap and the
      // village; these repeat it with the clump's lateral jitter allowed for
      if (Math.abs(pt.x) > lim || Math.abs(pt.z) > lim || !clearSpot(ctx, pt.x, pt.z, 14.5, 3, 2, 75.5)
        || (town && Math.hypot(pt.x - town.x, pt.z - town.z) < town.radius + 12.5)) {
        close();
        continue;
      }
      edgePointAt(e, Math.max(0, t - 1.5 / len), pa);
      edgePointAt(e, Math.min(1, t + 1.5 / len), pb);
      let tx = pb.x - pa.x;
      let tz = pb.z - pa.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      if (!run) run = { edge: e, s0: s, s1: s, clumps: [] };
      const lat = (rng() - 0.5) * 0.7;
      const x = pt.x - tz * lat;
      const z = pt.z + tx * lat;
      // 2.5-4 m brush, sized up a little when the low tier spaces it wider
      const w = (2.5 + rng() * 1.5) * (step / 2.6) * (belt ? 1.15 : 1);
      if (inKeepOut(x, z, w * 0.55 + 0.3)) {
        close();
        continue;
      }
      hedge.clumps.push({
        x, z, y: terrainHeight(x, z) + bankH * 0.72 - 0.1,
        sx: w, sy: w * (0.8 + rng() * 0.28), sz: w * (0.85 + rng() * 0.25),
        yaw: rng() * TAU, tint: rng(), s,
      });
      run.clumps.push(hedge.clumps.length - 1);
      run.s1 = s;
    }
    close();
  }
}

// A contiguous stretch of hedge: its 10 m prop groups, its standard trees and
// its earth bank.
function finishHedgeRun(ctx, run, hedge, buckets, standardPool, belt, bankH) {
  const rng = ctx.rng;
  const clumps = hedge.clumps;
  let group = [];
  let gStart = clumps[run.clumps[0]].s;
  for (const ci of run.clumps) {
    if (clumps[ci].s - gStart >= 10 && group.length) {
      hedge.groups.push(group);
      group = [];
      gStart = clumps[ci].s;
    }
    group.push(ci);
  }
  if (group.length) hedge.groups.push(group);

  if (standardPool.length) {
    const e = run.edge;
    const p = { x: 0, z: 0 };
    // Bocage: an oak let grow out of the hedge every 25-40 m, smaller than a
    // wood oak (hedgerow oaks were pollarded and lopped for firewood). Steppe
    // belts are planted rows, a tree every 7-10 m.
    let s = run.s0 + (belt ? 2 + rng() * 4 : 6 + rng() * 14);
    while (s <= run.s1 - 2) {
      edgePointAt(e, s / e.len, p);
      if (clearSpot(ctx, p.x, p.z, 12, 3, 3, 74)) {
        const arch = pickWeighted(standardPool, rng());
        const it = treeItem(ctx, arch, p.x, p.z, 'standard', belt ? 0.9 + rng() * 0.15 : 0.66 + rng() * 0.2, bankH * 0.45);
        bucketOf(buckets, arch).items.push(it);
      }
      s += belt ? 7 + rng() * 3 : 25 + rng() * 15;
    }
  }
  // a lone clump between two gaps gets no bank: a 3 m mound reads as a grave
  if (bankH > 0 && run.clumps.length >= 2) {
    hedge.runs.push({ edge: run.edge, s0: Math.max(0, run.s0 - 1.6), s1: Math.min(run.edge.len, run.s1 + 1.6), h: bankH });
  }
}

// --- roadside rows, orchards, lone trees ------------------------------------
function collectRoadRows(ctx, arches, buckets) {
  const lu = ctx.lu;
  if (!lu) return;
  const list = safeRead(() => lu.roadTrees, []);
  if (!list.length) return;
  const fallbackKey = lu.params && lu.params.roadTreeType;
  for (const r of list) {
    if (!r) continue;
    const key = r.type || fallbackKey;
    const arch = arches.find((a) => a.key === key) || arches.find((a) => a.role === 'row');
    if (!arch) continue;
    if (!clearSpot(ctx, r.x, r.z, 7.5, 3, 2, 60)) continue;
    bucketOf(buckets, arch).items.push(treeItem(ctx, arch, r.x, r.z, 'row', 0.9 + ctx.rng() * 0.12));
  }
}

function collectOrchards(ctx, arches, buckets) {
  const lu = ctx.lu;
  if (!lu) return;
  const list = safeRead(() => lu.orchards, []);
  if (!list.length) return;
  let arch = arches.find((a) => a.role === 'orchard');
  let hMul = 1;
  if (!arch) {
    // no fruit species in this biome's set: the widest broadleaf, kept low
    const wood = arches.filter((a) => a.role === 'wood').sort((a, b) => b.crownRFactor - a.crownRFactor);
    arch = wood[0];
    if (!arch) return;
    hMul = 6 / ((arch.heightRange[0] + arch.heightRange[1]) / 2);
  }
  const rng = ctx.rng;
  const lim = ctx.dressHalf - 8;
  for (const o of list) {
    if (!o || Math.abs(o.x) > lim || Math.abs(o.z) > lim) continue;
    const c = Math.cos(o.yaw);
    const s = Math.sin(o.yaw);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    if (corners.some(([a, b]) => inKeepOut(o.x + c * a * o.w / 2 + s * b * o.d / 2, o.z - s * a * o.w / 2 + c * b * o.d / 2, 4))) continue;
    // cider orchard: rows 6 m apart, trees about 7 m along the row, the odd
    // gap where an old tree came down
    for (let lz = -o.d / 2 + 3; lz <= o.d / 2 - 3; lz += 6) {
      for (let lx = -o.w / 2 + 3.5; lx <= o.w / 2 - 3.5; lx += 7) {
        if (rng() < 0.06) continue;
        const jx = lx + (rng() - 0.5) * 0.9;
        const jz = lz + (rng() - 0.5) * 0.6;
        const x = o.x + c * jx + s * jz;
        const z = o.z - s * jx + c * jz;
        if (!clearSpot(ctx, x, z, 8, 2, 2, 60)) continue;
        bucketOf(buckets, arch).items.push(treeItem(ctx, arch, x, z, 'orchard', hMul));
      }
    }
  }
}

function collectLoneTrees(ctx, arches, buckets) {
  const rng = ctx.rng;
  const lu = ctx.lu;
  const half = ctx.dressHalf - 10;
  if (ctx.biome === 'desert') {
    // Desert: no field trees — low scrub, in loose clumps, all over.
    const scrub = arches.find((a) => a.role === 'scrub');
    if (!scrub) return;
    const qf = ctx.quality === 'low' ? 0.5 : ctx.quality === 'medium' ? 0.75 : 1;
    const want = Math.round(260 * ctx.areaScale * qf);
    let made = 0;
    let guard = 0;
    while (made < want && guard++ < want * 12) {
      const cx = (rng() * 2 - 1) * half;
      const cz = (rng() * 2 - 1) * half;
      const k = rng() < 0.6 ? 3 + Math.floor(rng() * 4) : 1;
      for (let j = 0; j < k && made < want; j++) {
        const x = cx + (j ? (rng() - 0.5) * 14 : 0);
        const z = cz + (j ? (rng() - 0.5) * 14 : 0);
        if (!clearSpot(ctx, x, z, 6, 2, 3, 25) || terrainSlope(x, z) > 0.7) continue;
        bucketOf(buckets, scrub).items.push(treeItem(ctx, scrub, x, z, 'scrub'));
        made++;
      }
    }
    return;
  }
  const pool = arches.filter((a) => a.role === 'wood');
  if (!pool.length) return;
  let woodTrees = 0;
  for (const b of buckets.values()) for (const it of b.items) if (it.role === 'edge' || it.role === 'interior') woodTrees++;
  // a few per square kilometre, never more than ~6% of the trees on the map
  const want = Math.round(clamp(woodTrees * 0.04, 8, 45 * ctx.areaScale));
  const steppe = ctx.biome === 'steppe';
  const placed = [];
  let guard = 0;
  while (placed.length < want && guard++ < want * 40) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    if (!clearSpot(ctx, x, z, 16, 4, 8, 80)) continue;
    if (terrainSlope(x, z) > 0.5) continue;
    if (lu && typeof lu.woodAt === 'function' && lu.woodAt(x, z) > 0.02) continue;
    if (lu && typeof lu.parcelAt === 'function') {
      const p = lu.parcelAt(x, z);
      if (p) {
        // bocage: a lone oak out in the pasture; steppe: by the field edge
        if (p.crop === 1 || p.crop === 3) continue;
        if (!steppe && p.edgeDist < 12) continue;
        if (steppe && p.edgeDist > 8 && p.edgeDist < 900) continue;
      }
    }
    if (placed.some((q) => Math.abs(q[0] - x) < 25 && Math.abs(q[1] - z) < 25)) continue;
    placed.push([x, z]);
    const arch = pickWeighted(pool, rng());
    bucketOf(buckets, arch).items.push(treeItem(ctx, arch, x, z, 'lone', 0.95 + rng() * 0.1));
  }
}

// --- registration --------------------------------------------------------------
// A crown that would hang over a keep-out goes, not just a trunk standing in
// one: every placement above checks its own centre (with a few metres of
// pad), but a 6 m oak crown on the rim of an airfield disc still reaches over
// the embankment the disc was drawn to keep clear.
function dropKeepOutCrowns(buckets) {
  if (!keepOutDiscs.length) return;
  for (const b of buckets.values()) {
    const k = b.arch.crownRFactor;
    b.items = b.items.filter((it) => !inKeepOut(it.x, it.z, k * it.h * Math.max(it.ax, it.az)));
  }
}

function chooseRegisteredTrees(ctx, buckets) {
  // Only the roles the contract names (wood edge within EDGE_DEPTH, lone
  // field trees, hedgerow standards, road rows) ever register as 'tree'; a
  // wood's interior stays 'grove' however few edge trees a biome has, and is
  // what propBlocksLine's foliage screen is for.
  const cand = [];
  for (const b of buckets.values()) for (const it of b.items) if (REG_ROLES[it.role]) cand.push(it);
  // nearest the fighting first: the centre of the map is where shots cross
  cand.sort((p, q) => (p.x * p.x + p.z * p.z) - (q.x * q.x + q.z * q.z));
  const cap = Math.round(TREE_PROP_CAP * ctx.areaScale);
  for (let i = 0; i < cand.length; i++) cand[i].shell = i < cap;
}

function shellRadius(crownR) {
  return clamp(crownR * SHELL_CROWN, SHELL_R_MIN, SHELL_R_MAX);
}

function buildTreeMeshes(scene, ctx, buckets) {
  const snow = ctx.snow;
  const rgb = [0, 0, 0];
  const trunkRgb = [0, 0, 0];
  for (const b of buckets.values()) {
    const items = b.items;
    const n = items.length;
    if (!n) continue;
    const a = b.arch;
    const crownMat = vegetationMaterial(0.86, true);
    const trunkMat = vegetationMaterial(0.95, true);
    owned.push(crownMat, trunkMat);
    const crowns = new THREE.InstancedMesh(a.crownGeo, crownMat, n);
    const trunks = new THREE.InstancedMesh(a.trunkGeo, trunkMat, n);
    crowns.name = `trees:${a.key}:crown`;
    trunks.name = `trees:${a.key}:trunk`;
    crowns.castShadow = trunks.castShadow = true;
    // the instances span the whole map, so the bounds never cull anything,
    // and the sway shader moves vertices the bounds do not know about
    crowns.frustumCulled = trunks.frustumCulled = false;

    // the species' own colour, carried through the snow the preset fell
    hexLinear(mixHex(Number.isFinite(a.crownHex) ? a.crownHex : ctx.preset.crown, SNOW_HEX, snow * 0.45), rgb);
    hexLinear(mixHex(Number.isFinite(a.trunkHex) ? a.trunkHex : ctx.preset.trunk, SNOW_HEX, snow * 0.15), trunkRgb);
    const scrub = a.role === 'scrub';

    for (let i = 0; i < n; i++) {
      const it = items[i];
      const ground = terrainHeight(it.x, it.z);
      // tubes and clumps are open at the bottom: start them a little underground
      const sink = 0.25 + it.h * 0.012 - it.yOff;
      _q.setFromAxisAngle(_up, it.yaw);
      const sx = it.h * it.ax;
      const sz = it.h * it.az;
      _v.set(it.x, ground - sink, it.z);
      _s.set(sx, it.h, sz);
      _m.compose(_v, _q, _s);
      crowns.setMatrixAt(i, _m);
      trunks.setMatrixAt(i, _m);
      // +/-10% in value and a little in hue, so no two crowns in a wood match
      const k = 0.9 + it.tint * 0.2;
      const hue = (it.tint * 7.31) % 1 - 0.5;
      crowns.setColorAt(i, linColor(rgb[0] * k * (1 + hue * 0.1), rgb[1] * k, rgb[2] * k * (1 - hue * 0.12)));
      const kt = 0.92 + ((it.tint * 3.7) % 1) * 0.16;
      trunks.setColorAt(i, linColor(trunkRgb[0] * kt, trunkRgb[1] * kt, trunkRgb[2] * kt));

      const crownR = a.crownRFactor * it.h;
      const trunkR = Math.max(0.1, a.trunkRFactor * it.h);
      const slot = (mesh) => ({
        mesh, index: i, ox: 0, oy: -sink, oz: 0, sx, sy: it.h, sz,
        qx: _q.x, qy: _q.y, qz: _q.z, qw: _q.w,
      });
      registerProp({
        kind: it.shell ? 'tree' : 'grove',
        species: a.key,
        role: it.role,
        x: it.x, z: it.z, y: ground,
        r: scrub ? Math.max(0.4, crownR * 0.7) : Math.max(0.6, trunkR * 1.6),
        crownR: it.shell ? shellRadius(crownR) : crownR,
        h: it.h,
        hp: scrub ? 10 : 30 + 3 * it.h,
        maxHp: scrub ? 10 : 30 + 3 * it.h,
        span: scrub ? Math.PI * 0.5 : Math.PI * 0.46,
        solid: false,
        crushable: true,
        crushMass: scrub ? 2 : 6 + 0.35 * it.h,
        slots: [slot(trunks), slot(crowns)],
      });
    }
    crowns.instanceMatrix.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
    own(scene, trunks, crowns);
  }
}

// --- hedges --------------------------------------------------------------------
function buildHedges(scene, ctx, hedge) {
  const clumps = hedge.clumps;
  if (clumps.length) {
    const mat = vegetationMaterial(0.92, false);
    owned.push(mat);
    const mesh = new THREE.InstancedMesh(hedgeClumpGeometry(), mat, clumps.length);
    mesh.name = 'hedges';
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    // hawthorn and hazel run a touch lighter and yellower than the oaks
    const base = hexLinear(mixHex(ctx.preset.crown, SNOW_HEX, ctx.snow * 0.5));
    const mantleBase = hexLinear(mixHex(ctx.preset.crown, SNOW_HEX, ctx.snow * 0.4));
    for (let i = 0; i < clumps.length; i++) {
      const c = clumps[i];
      _q.setFromAxisAngle(_up, c.yaw);
      _v.set(c.x, c.y, c.z);
      _s.set(c.sx, c.sy, c.sz);
      _m.compose(_v, _q, _s);
      mesh.setMatrixAt(i, _m);
      c.q = [_q.x, _q.y, _q.z, _q.w];
      const k = 0.88 + c.tint * 0.24;
      const b = c.mantle ? mantleBase : base;
      const m = c.mantle ? [0.95, 1, 0.95] : [1.08, 1.1, 0.9];
      mesh.setColorAt(i, linColor(b[0] * m[0] * k, b[1] * m[1] * k, b[2] * m[2] * k));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // which instances are wood-mantle shrubs and which hedgerow brush, for
    // anything (a test, a future AI cover map) that needs to tell them apart
    mesh.userData.mantle = Uint8Array.from(clumps, (c) => (c.mantle ? 1 : 0));

    for (const g of hedge.groups) {
      let cx = 0; let cz = 0;
      for (const ci of g) { cx += clumps[ci].x; cz += clumps[ci].z; }
      cx /= g.length;
      cz /= g.length;
      const cy = terrainHeight(cx, cz);
      let reach = 0;
      let top = 0;
      const slots = [];
      for (const ci of g) {
        const c = clumps[ci];
        reach = Math.max(reach, Math.hypot(c.x - cx, c.z - cz) + c.sx * 0.5);
        top = Math.max(top, c.y + c.sy - cy);
        slots.push({
          mesh, index: ci, ox: c.x - cx, oy: c.y - cy, oz: c.z - cz,
          sx: c.sx, sy: c.sy, sz: c.sz, qx: c.q[0], qy: c.q[1], qz: c.q[2], qw: c.q[3],
        });
      }
      registerProp({
        kind: 'hedge',
        x: cx, z: cz, y: cy,
        r: Math.min(MAX_PROP_R - 0.5, Math.max(1.5, reach)),
        h: Math.max(1, top),
        hp: 40, maxHp: 40,
        span: 0,
        solid: false,
        crushable: true,
        crushMass: 6,
        slots,
      });
    }
    own(scene, mesh);
  }
  if (hedge.runs.length) buildBanks(scene, ctx, hedge.runs);
}

// The earth bank under a bocage hedge: one merged strip for the whole map,
// following the ground across its width so it never floats, its ends sloping
// down into the gaps. Visual only — terrainHeight and the tanks never see it,
// which is why it is kept to the contract's 1.2 m and its foot runs under the
// turf. The outer vertices sit 0.36 m underground 1.45 m out, so the bank
// breaks the surface about 1.25 m either side of the line: 2.5 m across.
function buildBanks(scene, ctx, runs) {
  const OFF = [-1.45, -0.75, 0, 0.75, 1.45];
  const PROF = [-0.3, 0.7, 1, 0.7, -0.3];
  const NS = OFF.length;
  const pos = [];
  const col = [];
  const idx = [];
  const grass = hexLinear(mixHex(ctx.preset.low, SNOW_HEX, ctx.snow * 0.3));
  const dirt = hexLinear(mixHex((ctx.preset.dust && ctx.preset.dust.dirt) || ctx.preset.high, SNOW_HEX, ctx.snow * 0.6));
  const p = { x: 0, z: 0 };
  const pa = { x: 0, z: 0 };
  const pb = { x: 0, z: 0 };
  for (const run of runs) {
    const e = run.edge;
    const L = run.s1 - run.s0;
    if (!(L > 1)) continue;
    const n = Math.max(1, Math.ceil(L / 4));
    const v0 = pos.length / 3;
    for (let k = 0; k <= n; k++) {
      const s = run.s0 + (L * k) / n;
      edgePointAt(e, s / e.len, p);
      edgePointAt(e, Math.max(0, (s - 1.5) / e.len), pa);
      edgePointAt(e, Math.min(1, (s + 1.5) / e.len), pb);
      let tx = pb.x - pa.x;
      let tz = pb.z - pa.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const nx = -tz;
      const nz = tx;
      const taper = clamp(Math.min(s - run.s0, run.s1 - s) / 2.2, 0, 1);
      for (let j = 0; j < NS; j++) {
        const x = p.x + nx * OFF[j];
        const z = p.z + nz * OFF[j];
        const k2 = PROF[j];
        const y = terrainHeight(x, z) + (k2 > 0 ? k2 * run.h * taper : k2 * run.h);
        pos.push(x, y, z);
        const g = k2 >= 1 ? 0.75 : k2 > 0 ? 0.55 : 0.2;   // turf on top, earth showing on the flanks
        col.push(lerp(dirt[0], grass[0], g) * 0.85, lerp(dirt[1], grass[1], g) * 0.85, lerp(dirt[2], grass[2], g) * 0.85);
      }
    }
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < NS - 1; j++) {
        const a = v0 + k * NS + j;
        const b = a + 1;
        const c = a + NS + 1;
        const d = a + NS;
        // (a, b, c): b - a runs across the bank (+normal), c - a along it, so
        // the face normal is normal x tangent = +Y: wound CCW seen from above
        idx.push(a, b, c, a, c, d);
      }
    }
  }
  if (!idx.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true });
  owned.push(geo, mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'hedge-banks';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  purgeables.push(mesh);
  own(scene, mesh);
}

// Tree crowns lean on the wind. The whole thing is one vertex offset driven by
// two shared uniforms, so a swaying forest costs the CPU nothing at all. The
// flora geometry is normalised (base y = 0, height 1, scaled by the instance
// to the tree's height), so the bend grows with the square of the local height
// fraction: the foot of the trunk stays planted and the crown top moves
// 0.15-0.4 m on an 18 m oak. The wind vector is rotated into each instance's
// own frame, so every tree in a wood leans the same way.
function applySway(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWindTime = windUniforms.time;
    sh.uniforms.uWindVec = windUniforms.vec;
    sh.vertexShader = `uniform float uWindTime;\nuniform vec2 uWindVec;\n${sh.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        float swayPhase = instanceMatrix[3].x * 0.14 + instanceMatrix[3].z * 0.11;
        // divided, not normalize()d: a cleared instance has a zero matrix and
        // normalize(vec3(0)) is NaN on some drivers
        vec2 swayAx = instanceMatrix[0].xz / max(length(instanceMatrix[0].xyz), 1e-5);
        vec2 swayAz = instanceMatrix[2].xz / max(length(instanceMatrix[2].xyz), 1e-5);
        vec2 swayWind = vec2(dot(swayAx, uWindVec), dot(swayAz, uWindVec));
      #else
        float swayPhase = 0.0;
        vec2 swayWind = uWindVec;
      #endif
      float swayH = max(position.y, 0.0);
      transformed.xz += swayWind * (swayH * swayH * 0.13) * (0.65 + 0.35 * sin(uWindTime * 1.7 + swayPhase));`,
    );
  };
  mat.customProgramCacheKey = () => 'steelskies-sway-v2';
}

// ---------------------------------------------------------------------------
// The village: the lots landuse.js laid out (church at the centre, houses
// gable-to-street, barns behind, sheds beside, outlying farmsteads), built
// from the biome's buildings.js kit. One THREE.BatchedMesh per kit material,
// so the whole village is three draw calls and three shadow calls, and each
// building is one instance in each — which is what lets a collapse swap the
// walls for the ruined shell in place.
const _kitMinY = new WeakMap();
function archetypeFloor(a) {
  let y = _kitMinY.get(a);
  if (y !== undefined) return y;
  y = 0;
  for (const g of Object.values(a.parts)) {
    if (!g.boundingBox) g.computeBoundingBox();
    if (g.boundingBox) y = Math.min(y, g.boundingBox.min.y);
  }
  _kitMinY.set(a, y);
  return y;
}

function paletteTint(list, base, i) {
  if (!Array.isArray(list) || !list.length || !Number.isFinite(base)) return [1, 1, 1];
  const a = hexLinear(list[i % list.length]);
  const b = hexLinear(base);
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const lr = lum(a) / Math.max(1e-4, lum(b));
  // keep the palette's hue, but only nudge the brightness: the kit texture
  // already carries the material, and the contract asks for tints near 1
  const l = clamp(lr, 0.85, 1.12);
  return [0, 1, 2].map((k) => clamp((a[k] / Math.max(1e-4, b[k])) / lr * l, 0.78, 1.22));
}

function addVillage(scene, ctx) {
  const lots = ctx.lots;
  if (!lots.length) return;
  let kit = null;
  try {
    kit = buildingKit(ctx.preset.architecture || (ctx.lu && ctx.lu.params && ctx.lu.params.style) || 'normandy', ctx.quality);
  } catch (err) {
    console.warn('[scenery] building kit unavailable:', err);
    return;
  }
  if (!kit || !Array.isArray(kit.archetypes) || !kit.archetypes.length) return;
  const lim = Math.min(ctx.meshHalf - 8, 1290);

  const placed = [];
  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i];
    if (!lot || !Number.isFinite(lot.x) || !Number.isFinite(lot.z)) continue;
    if (Math.abs(lot.x) > lim || Math.abs(lot.z) > lim) continue;
    const c = Math.cos(lot.yaw);
    const s = Math.sin(lot.yaw);
    let blocked = inKeepOut(lot.x, lot.z, 4);
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      if (blocked) break;
      const lx = (u * lot.w) / 2;
      const lz = (v * lot.d) / 2;
      blocked = inKeepOut(lot.x + c * lx + s * lz, lot.z - s * lx + c * lz, 4);
    }
    if (blocked) continue;
    const role = lot.role === 'church' ? 'church' : lot.role;
    let cands = kit.archetypes.filter((a) => a.role === role);
    if (!cands.length) cands = kit.archetypes.filter((a) => a.role === 'house');
    if (!cands.length) continue;
    // the archetypes that fit the plot; otherwise the smallest, shrunk to fit
    const fits = cands.filter((a) => a.w <= lot.w + 1.2 && a.d <= lot.d + 1.2);
    const pool = fits.length ? fits : [cands.reduce((m, a) => (a.w * a.d < m.w * m.d ? a : m))];
    const arch = pool[Math.floor(ctx.rng() * pool.length) % pool.length];
    const scale = clamp(Math.min((lot.w + 1.2) / arch.w, (lot.d + 1.2) / arch.d), 0.7, 1);
    // tested after the draw above, so a map with no house in a spawn strip
    // keeps exactly the village it had
    if (houseInSpawnStrip(lot, arch, scale)) continue;
    placed.push({ lot, arch, s: scale, i });
  }
  if (!placed.length) return;

  const canRuin = typeof THREE.BatchedMesh.prototype.setGeometryIdAt === 'function';
  const used = [...new Set(placed.map((p) => p.arch))];
  const PARTS = ['walls', 'roof', 'trim'];
  const RUIN_OF = { walls: 'walls', roof: 'rubble', trim: null };
  const meshes = {};
  const geoIds = {};
  for (const part of PARTS) {
    let vCount = 0;
    let iCount = 0;
    const list = [];
    for (const a of used) {
      const g = a.parts[part];
      const r = canRuin && RUIN_OF[part] ? a.ruin[RUIN_OF[part]] : null;
      for (const geo of [g, r]) {
        if (!geo) continue;
        vCount += geo.getAttribute('position').count;
        iCount += geo.index ? geo.index.count : 0;
        list.push(geo);
      }
    }
    const bm = new THREE.BatchedMesh(placed.length, vCount, iCount, kit.materials[part]);
    bm.name = `village:${part}`;
    bm.castShadow = true;
    bm.receiveShadow = true;
    const ids = new Map();
    for (const a of used) {
      const intact = bm.addGeometry(a.parts[part]);
      const r = canRuin && RUIN_OF[part] ? a.ruin[RUIN_OF[part]] : null;
      ids.set(a, { intact, ruin: r ? bm.addGeometry(r) : null });
    }
    meshes[part] = bm;
    geoIds[part] = ids;
  }

  const pal = ctx.preset.buildingPalette || {};
  for (const p of placed) {
    const { lot, arch, s } = p;
    const c = Math.cos(lot.yaw);
    const sn = Math.sin(lot.yaw);
    // Base height: on a slope, sit the building as high as its own
    // foundations allow without the downhill side floating; kits whose walls
    // start at y = 0 are dug into the uphill side instead.
    let lo = Infinity;
    let hi = -Infinity;
    for (const [u, v] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const lx = (u * arch.w * s) / 2;
      const lz = (v * arch.d * s) / 2;
      const y = terrainHeight(lot.x + c * lx + sn * lz, lot.z - sn * lx + c * lz);
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    const found = Math.max(0, -archetypeFloor(arch) * s);
    const baseY = Math.min(hi, lo + found);
    _q.setFromAxisAngle(_up, lot.yaw);
    _v.set(lot.x, baseY, lot.z);
    _s.set(s, s, s);
    _m.compose(_v, _q, _s);
    const wallT = paletteTint(pal.wall, kit.palette && kit.palette.wall, p.i * 7 + 3);
    const roofT = paletteTint(pal.roof, kit.palette && kit.palette.roof, p.i * 5 + 1);
    const parts = [];
    for (const part of PARTS) {
      const bm = meshes[part];
      const id = geoIds[part].get(arch);
      const inst = bm.addInstance(id.intact);
      bm.setMatrixAt(inst, _m);
      const t = part === 'walls' ? wallT : part === 'roof' ? roofT : [1, 1, 1];
      bm.setColorAt(inst, linColor(t[0], t[1], t[2]));
      parts.push({ mesh: bm, index: inst, ruinGeo: id.ruin });
    }
    const w = arch.w * s;
    const d = arch.d * s;
    registerProp({
      kind: 'house',
      role: lot.role,
      archetype: arch.key,
      x: lot.x, z: lot.z, y: baseY,
      r: Math.min(MAX_PROP_R, Math.max(2, arch.solidR * s)),
      h: arch.h * s,
      hp: 520 + w * d * 6,
      maxHp: 520 + w * d * 6,
      span: 0,
      solid: true,
      crushable: false,
      crushMass: Infinity,
      slots: parts,
      building: { parts, yaw: lot.yaw, s, y: baseY, canRuin, ruined: false },
      // what rounds, bombs, aim rays and sight lines meet: the drawn shape,
      // standing or ruined (see "Solid colliders"); null falls back to r / h
      coll: buildingCollider(arch, lot.x, lot.z, baseY, lot.yaw, s),
    });
  }
  for (const part of PARTS) own(scene, meshes[part]);
}

// ---------------------------------------------------------------------------
// Rocks. Boulders lie where the ground breaks — slopes, ridge crests, in the
// woods — in clusters, not sprinkled evenly over the pasture. Meadow and
// steppe keep about a third of the old count; winter and the desert get
// outcrops of big rock. One displaced icosphere (80 tris) for all of them,
// shared for the session, varied by scale, rotation and colour per instance.
let rockGeoCache = null;
function rockGeometry() {
  if (rockGeoCache) return rockGeoCache;
  let g = new THREE.IcosahedronGeometry(1, 1);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-4);
  const pos = g.getAttribute('position');
  const hash = (x, y, z) => {
    const n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    return n - Math.floor(n);
  };
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // lumpy, a little flattened, with one broken face
    const k = 0.78 + hash(x, y, z) * 0.34 - (y > 0.6 ? 0.12 : 0) - (x > 0.7 ? 0.1 : 0);
    pos.setXYZ(i, x * k, y * k * 0.82, z * k);
    // weathering: darker and mossier toward the ground line
    const ao = 0.62 + 0.38 * clamp((y + 0.4) / 1.2, 0, 1);
    col[i * 3] = ao;
    col[i * 3 + 1] = ao;
    col[i * 3 + 2] = ao;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  rockGeoCache = markSharedGeometry(g);
  return rockGeoCache;
}

function ridgeCrest(feat, x, z) {
  const ridges = feat && Array.isArray(feat.ridges) ? feat.ridges : [];
  if (!ridges.length) return 0;
  const a = Number(feat.axis) || 0;
  const fx = Math.abs(x * Math.cos(a) + z * Math.sin(a));
  let crest = 0;
  for (const rg of ridges) {
    if (!rg || !Number.isFinite(rg.offset) || !(rg.width > 0)) continue;
    crest = Math.max(crest, 1 - Math.min(1, Math.abs(fx - rg.offset) / rg.width));
  }
  return crest;
}

function addRocks(scene, ctx, count) {
  const outcrop = (ctx.preset.rocks && ctx.preset.rocks.mode)
    ? ctx.preset.rocks.mode === 'outcrop'
    : ctx.biome === 'winter' || ctx.biome === 'desert';
  const n = Math.round(count * (!outcrop && (ctx.biome === 'meadow' || ctx.biome === 'steppe') ? 0.35 : 1));
  if (n <= 0) return;
  const rng = ctx.rng;
  const half = Math.max(40, Math.min(ctx.P, ctx.meshHalf - 10) - 20);
  const lu = ctx.lu;
  const rocks = [];
  let guard = 0;
  while (rocks.length < n && guard++ < n * 80) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    if (x * x + z * z < 45 * 45) continue;
    if (inKeepOut(x, z, 8) || roadDistanceAt(x, z) < 10 || nearLot(ctx, x, z, 6)) continue;
    const slope = terrainSlope(x, z);
    const crest = ridgeCrest(ctx.feat, x, z);
    const wood = lu && typeof lu.woodAt === 'function' ? lu.woodAt(x, z) : 0;
    let want = 0.03;
    if (slope > (outcrop ? 0.12 : 0.2)) want = 0.85;
    else if (crest > (outcrop ? 0.5 : 0.65)) want = 0.6;
    else if (wood > 0.5) want = 0.45;
    if (rng() > want) continue;
    const k = 3 + Math.floor(rng() * 7);
    const spread = outcrop ? 4 + rng() * 8 : 3 + rng() * 6;
    for (let j = 0; j < k && rocks.length < n; j++) {
      const rx = x + (j ? (rng() - 0.5) * 2 * spread : 0);
      const rz = z + (j ? (rng() - 0.5) * 2 * spread : 0);
      if (Math.abs(rx) > half + 15 || Math.abs(rz) > half + 15) continue;
      if (inKeepOut(rx, rz, 6) || roadDistanceAt(rx, rz) < 8 || nearLot(ctx, rx, rz, 5)) continue;
      // one big stone and its smaller neighbours
      const big = j === 0 ? 1 : 0.45 + rng() * 0.5;
      const sc = (outcrop ? 1.3 + rng() * 2.2 : 0.55 + rng() * 1.1) * big;
      const rock = {
        x: rx, z: rz,
        sx: sc * (0.8 + rng() * 0.5), sy: sc * (0.55 + rng() * 0.5), sz: sc * (0.8 + rng() * 0.5),
        rx: (rng() - 0.5) * 0.5, ry: rng() * TAU, rz: (rng() - 0.5) * 0.5,
        tint: rng(),
      };
      // Nothing moves a rock, so none may lie where a tank is put down. Tested
      // after every draw for this stone, so the stream (and every map with no
      // rock in a spawn strip) is unchanged.
      if (inSpawnStrip(rx, rz, Math.max(rock.sx, rock.sz) + SPAWN_PAD)) continue;
      rocks.push(rock);
    }
  }
  if (!rocks.length) return;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, vertexColors: true });
  owned.push(mat);
  const mesh = new THREE.InstancedMesh(rockGeometry(), mat, rocks.length);
  mesh.name = 'rocks';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const base = hexLinear(ctx.preset.rockCol);
  const e = new THREE.Euler();
  rocks.forEach((r, i) => {
    const y = terrainHeight(r.x, r.z);
    _q.setFromEuler(e.set(r.rx, r.ry, r.rz));
    _v.set(r.x, y + r.sy * 0.3, r.z);
    _s.set(r.sx, r.sy, r.sz);
    _m.compose(_v, _q, _s);
    mesh.setMatrixAt(i, _m);
    const k = 0.84 + r.tint * 0.3;
    mesh.setColorAt(i, linColor(base[0] * k, base[1] * k * (0.98 + r.tint * 0.04), base[2] * k));
    // Rock is what you go hull-down behind: nothing knocks it over.
    registerProp({
      kind: 'rock',
      x: r.x, z: r.z, y,
      r: Math.max(r.sx, r.sz),
      h: r.sy * 1.3,
      hp: Infinity, maxHp: Infinity,
      span: 0,
      solid: true,
      crushable: false,
      crushMass: Infinity,
      invulnerable: true,
      // never animated (nothing fells a rock), but a late keep-out has to be
      // able to find its instance to clear it off a runway
      slots: [{ mesh, index: i, oy: 0, sx: r.sx, sy: r.sy, sz: r.sz, qx: _q.x, qy: _q.y, qz: _q.z, qw: _q.w }],
    });
  });
  own(scene, mesh);
}

// ---------------------------------------------------------------------------
// Fences along the 'fence' parcel edges: yards round the village, paddocks by
// the road. Worthless as cover, but they show a driver where the ground lies
// and they go down satisfyingly under a hull. Winter fences are three heavy
// log rails; elsewhere a post and two rails.
function addFences(scene, ctx) {
  const lu = ctx.lu;
  if (!lu) return;
  const edges = safeRead(() => lu.edges, []);
  // On the air map (prop area wider than DRESS_LIMIT) a rail is sub-pixel from
  // any height a pilot flies at and no hull drives through it, so the fences
  // stop at the ground map's square: a Nordic winter map otherwise spends
  // ~90k shadow-casting triangles on 2,500 paddock fences nobody sees.
  const lim = (ctx.P > DRESS_LIMIT ? Math.min(ctx.dressHalf, 450) : ctx.dressHalf) - 1;
  const segs = [];
  for (const e of edges) {
    if (!e || e.type !== 'fence' || !Array.isArray(e.pts) || e.pts.length < 4) continue;
    const m = e.pts.length / 2 - 1;
    let prevEnd = -1;
    for (let q = 0; q < m; q++) {
      const tm = (q + 0.5) / m;
      if (inGaps(tm, e.gaps)) continue;
      const x0 = e.pts[2 * q];
      const z0 = e.pts[2 * q + 1];
      const x1 = e.pts[2 * q + 2];
      const z1 = e.pts[2 * q + 3];
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      if (Math.abs(mx) > lim || Math.abs(mz) > lim) continue;
      if (inKeepOut(mx, mz, 3) || roadDistanceAt(x0, z0) < 6 || roadDistanceAt(x1, z1) < 6) continue;
      if (terrainSlope(mx, mz) > 0.75) continue;
      // every segment carries the post at its start; the last one of a run
      // also carries the post that closes it
      const last = segs[segs.length - 1];
      if (last && last.edge === e && prevEnd === q - 1) last.endPost = false;
      segs.push({ x0, z0, x1, z1, edge: e, endPost: true });
      prevEnd = q;
    }
  }
  if (!segs.length) return;
  const winter = ctx.biome === 'winter';
  const nRails = winter ? 3 : 2;
  const postGeo = new THREE.BoxGeometry(0.16, 1.35, 0.16);
  const railGeo = new THREE.BoxGeometry(1, winter ? 0.16 : 0.12, winter ? 0.14 : 0.07);
  // A rail's end caps butt into the posts and are never seen: dropping the
  // +X/-X faces (the first twelve indices of a BoxGeometry) takes a third off
  // the dearest part of a winter map's fences.
  railGeo.setIndex(Array.from(railGeo.index.array.slice(12)));
  railGeo.clearGroups();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  // weathered timber: the biome's bark gone grey
  const wood = hexLinear(mixHex(mixHex(ctx.preset.trunk, 0x8a8478, 0.35), SNOW_HEX, ctx.snow * 0.2));
  mat.color.setRGB(wood[0], wood[1], wood[2], THREE.LinearSRGBColorSpace);
  owned.push(postGeo, railGeo, mat);
  let posts = 0;
  for (const s of segs) posts += s.endPost ? 2 : 1;
  const postMesh = new THREE.InstancedMesh(postGeo, mat, posts);
  const railMesh = new THREE.InstancedMesh(railGeo, mat, segs.length * nRails);
  postMesh.name = 'fence-posts';
  railMesh.name = 'fence-rails';
  postMesh.castShadow = railMesh.castShadow = true;

  let pi = 0;
  segs.forEach((seg, i) => {
    const mx = (seg.x0 + seg.x1) * 0.5;
    const mz = (seg.z0 + seg.z1) * 0.5;
    const y = terrainHeight(mx, mz);
    const len = Math.hypot(seg.x1 - seg.x0, seg.z1 - seg.z0);
    const yaw = Math.atan2(seg.x1 - seg.x0, seg.z1 - seg.z0);
    // the rail box runs along local X, so face it across the segment heading
    _q.setFromAxisAngle(_up, yaw + Math.PI / 2);
    const slots = [];
    const ends = seg.endPost ? [[seg.x0, seg.z0], [seg.x1, seg.z1]] : [[seg.x0, seg.z0]];
    for (const [px, pz] of ends) {
      const py = terrainHeight(px, pz) - y;
      _s.set(1, 1, 1);
      _m.compose(_v.set(px, y + py + 0.6, pz), _q, _s);
      postMesh.setMatrixAt(pi, _m);
      slots.push({ mesh: postMesh, index: pi, ox: px - mx, oy: py + 0.6, oz: pz - mz, sx: 1, sy: 1, sz: 1, qx: _q.x, qy: _q.y, qz: _q.z, qw: _q.w });
      pi++;
    }
    for (let k = 0; k < nRails; k++) {
      const oy = (winter ? 1.12 : 1.05) - k * (winter ? 0.36 : 0.42);
      _s.set(len, 1, 1);
      _m.compose(_v.set(mx, y + oy, mz), _q, _s);
      railMesh.setMatrixAt(i * nRails + k, _m);
      slots.push({ mesh: railMesh, index: i * nRails + k, oy, sx: len, sy: 1, sz: 1, qx: _q.x, qy: _q.y, qz: _q.z, qw: _q.w });
    }
    registerProp({
      kind: 'fence',
      x: mx, z: mz, y,
      r: len * 0.5,
      h: 1.4,
      hp: 14, maxHp: 14,
      span: Math.PI * 0.48,
      solid: false,
      crushable: true,
      crushMass: 2,
      slots,
    });
  });
  own(scene, postMesh, railMesh);
}

// ---------------------------------------------------------------------------
// The telegraph line along the road: a 7 m pole with a crossarm and four
// insulators every 45-55 m (landuse.js pole list), and the wires sagging
// between them in one merged mesh of thin crossed ribbons. A pole is a
// crushable prop; when it goes, the spans either side of it go with it.
let poleGeoCache = null;
function poleGeometry() {
  if (poleGeoCache) return poleGeoCache;
  const wood = [0.085, 0.07, 0.055];     // creosoted pine, linear
  const glass = [0.62, 0.66, 0.6];       // pale green insulator glass
  const paint = (g, c) => {
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const parts = [];
  const pole = new THREE.CylinderGeometry(0.1, 0.13, 7.6, 6, 1, false);
  pole.translate(0, 3.8, 0);
  parts.push(paint(pole, wood));
  const arm = new THREE.BoxGeometry(1.9, 0.11, 0.1);
  arm.translate(0, 7.05, 0);
  parts.push(paint(arm, wood));
  for (const x of [-0.85, -0.35, 0.35, 0.85]) {
    const ins = new THREE.CylinderGeometry(0.045, 0.06, 0.17, 5, 1, false);
    ins.translate(x, 7.19, 0);
    parts.push(paint(ins, glass));
  }
  for (const g of parts) g.deleteAttribute('uv');
  poleGeoCache = markSharedGeometry(mergeGeometries(parts, false));
  for (const g of parts) g.dispose();
  return poleGeoCache;
}

function addPoles(scene, ctx) {
  const lu = ctx.lu;
  if (!lu) return;
  const list = safeRead(() => lu.poles, []);
  const lim = ctx.meshHalf - 5;
  const poles = list.filter((p) => p && Math.abs(p.x) <= lim && Math.abs(p.z) <= lim && !inKeepOut(p.x, p.z, 2));
  if (!poles.length) return;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, vertexColors: true });
  owned.push(mat);
  const mesh = new THREE.InstancedMesh(poleGeometry(), mat, poles.length);
  mesh.name = 'telegraph-poles';
  mesh.castShadow = true;
  const rng = ctx.rng;
  const tops = [];
  const registered = [];
  poles.forEach((p, i) => {
    const y = terrainHeight(p.x, p.z);
    const yaw = Number.isFinite(p.yaw) ? p.yaw : 0;
    // a pole is never quite plumb
    const lean = (rng() - 0.5) * 0.05;
    _q.setFromEuler(new THREE.Euler(lean, yaw, (rng() - 0.5) * 0.05, 'YXZ'));
    _v.set(p.x, y - 0.3, p.z);
    _s.set(1, 1, 1);
    _m.compose(_v, _q, _s);
    mesh.setMatrixAt(i, _m);
    const k = 0.9 + rng() * 0.2;
    mesh.setColorAt(i, linColor(k, k, k));
    // where the four insulators are, for the wires (through the pole's own
    // matrix, lean included, so every wire ends on its insulator)
    tops.push([-0.85, -0.35, 0.35, 0.85].map((ox) => {
      _v2.set(ox, 7.3, 0).applyMatrix4(_m);
      return [_v2.x, _v2.y, _v2.z];
    }));
    registered.push(registerProp({
      kind: 'pole',
      x: p.x, z: p.z, y,
      r: 0.4,
      h: 7.3,
      hp: 30, maxHp: 30,
      span: Math.PI * 0.45,
      solid: false,
      crushable: true,
      crushMass: 5,
      slots: [{ mesh, index: i, ox: 0, oy: -0.3, oz: 0, sx: 1, sy: 1, sz: 1, qx: _q.x, qy: _q.y, qz: _q.z, qw: _q.w }],
      wireSpans: [],
    }));
  });
  own(scene, mesh);
  buildWires(scene, poles, tops, registered);
}

function buildWires(scene, poles, tops, registered) {
  const pos = [];
  const idx = [];
  const SEG = 8;
  const W = 0.022;
  let wires = null;
  for (let i = 0; i + 1 < poles.length; i++) {
    const a = poles[i];
    const b = poles[i + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L > 75 || L < 5) continue;
    const i0 = idx.length;
    const sag = 0.012 * L;
    for (let w = 0; w < 4; w++) {
      // the wire with the same lateral offset on both poles; if the next pole
      // faces the other way round, take its mirrored insulator
      const pa = tops[i][w];
      let pb = tops[i + 1][w];
      const alt = tops[i + 1][3 - w];
      if (Math.hypot(alt[0] - pa[0], alt[2] - pa[2]) < Math.hypot(pb[0] - pa[0], pb[2] - pa[2])) pb = alt;
      const dx = pb[0] - pa[0];
      const dz = pb[2] - pa[2];
      const dl = Math.hypot(dx, dz) || 1;
      const sx = (-dz / dl) * W;
      const sz = (dx / dl) * W;
      const v0 = pos.length / 3;
      for (let k = 0; k <= SEG; k++) {
        const t = k / SEG;
        const x = pa[0] + dx * t;
        const z = pa[2] + dz * t;
        const y = lerp(pa[1], pb[1], t) - sag * 4 * t * (1 - t);
        // a horizontal and a vertical ribbon: visible from the side and above
        pos.push(x - sx, y, z - sz, x + sx, y, z + sz, x, y - W, z, x, y + W, z);
      }
      for (let k = 0; k < SEG; k++) {
        const a0 = v0 + k * 4;
        const b0 = a0 + 4;
        idx.push(a0, a0 + 1, b0 + 1, a0, b0 + 1, b0);
        idx.push(a0 + 2, a0 + 3, b0 + 3, a0 + 2, b0 + 3, b0 + 2);
      }
    }
    const span = [i0, idx.length];
    registered[i].wireSpans.push(span);
    registered[i + 1].wireSpans.push(span);
  }
  if (!idx.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  const mat = new THREE.MeshBasicMaterial({ color: 0x1c1c1a, side: THREE.DoubleSide });
  owned.push(geo, mat);
  wires = new THREE.Mesh(geo, mat);
  wires.name = 'telegraph-wires';
  wires.castShadow = false;
  wires.receiveShadow = false;
  purgeables.push(wires);
  for (const p of registered) p.wireMesh = wires;
  own(scene, wires);
}

function dropWireSpans(prop) {
  const mesh = prop.wireMesh;
  const idx = mesh && mesh.geometry && mesh.geometry.index;
  if (!idx) return;
  const a = idx.array;
  for (const [i0, i1] of prop.wireSpans) {
    for (let t = i0; t < i1; t++) a[t] = a[i0];
  }
  prop.wireSpans.length = 0;
  idx.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Distant woods. Past the dressed square the horizon is closed by woodland
// hulls (flora.js farWoodGeometry, 42 tris each), grouped into woods of two to
// seven, on the far skirt terrain.js hangs off the ground mesh. Visual only:
// not registered, no shadow. On the big maps they also fill the band between
// the dressed square and the mesh edge, which only aircraft (and tanks at the
// clamp) ever see. They are biased toward the near band because in a ground
// battle the fog has swallowed anything past about 1.3 km anyway.

// Where a far-wood hull meets the ground, in hull-local units (flat [x, z]
// pairs): the centre, every base vertex (y = 0) of the shared geometry in
// angular order, and three more points along each base edge, so a dip between
// two rim vertices is caught too. Read once per geometry; a ring of 16 points
// on the unit hull's 0.5 radius if the geometry ever stops having a flat base.
let farRim = null;
let farRimGeo = null;
let farRimReach = 0.5;
function farWoodFootprint(geo) {
  if (farRim && farRimGeo === geo) return farRim;
  const ring = [];
  const pos = geo && geo.getAttribute ? geo.getAttribute('position') : null;
  for (let i = 0; pos && i < pos.count; i++) {
    if (Math.abs(pos.getY(i)) > 1e-5) continue;
    const x = pos.getX(i);
    const z = pos.getZ(i);
    if (!ring.some((p) => Math.abs(p[0] - x) < 1e-5 && Math.abs(p[1] - z) < 1e-5)) ring.push([x, z]);
  }
  if (ring.length < 3) {
    ring.length = 0;
    for (let k = 0; k < 16; k++) ring.push([Math.cos((k / 16) * TAU) * 0.5, Math.sin((k / 16) * TAU) * 0.5]);
  }
  ring.sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
  // four samples per base edge: the skirt's triangles are 20-60 m across, so
  // a hull 30-80 m wide can straddle a fold of the ground between two rim
  // vertices, and the edge's midpoint alone left a hand's breadth of air
  // under one hull in a few hundred
  const out = [0, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    for (let k = 0; k < 4; k++) out.push(lerp(a[0], b[0], k / 4), lerp(a[1], b[1], k / 4));
  }
  // the widest the hull reaches in plan (its rim leans in, so the base ring),
  // for keeping its whole footprint inside FAR_WOODS_OUT
  let reach = 0;
  for (let i = 0; pos && i < pos.count; i++) reach = Math.max(reach, Math.hypot(pos.getX(i), pos.getZ(i)));
  farRimReach = reach > 0 ? reach : 0.5;
  farRim = out;
  farRimGeo = geo;
  return out;
}

function addDistantWoods(scene, ctx) {
  const g = ctx.ground;
  // Where the hulls may start: clear of everything dressed with real trees,
  // at least 150 m beyond the ground map's tank clamp and 100 m beyond the
  // area tanks fight over on a bigger map (combined: prop area +/-675, tanks
  // clamped at +/-700), so no tank ever parks against a 42-triangle wood.
  const playBound = Number(terrainModule.PLAY_BOUND) || 420;
  const inner = Math.max(ctx.woodHalf + 30, ctx.dressHalf + 40, Math.min(ctx.P, 700) + 100, playBound + 150);
  const outer = Math.min(FAR_WOODS_OUT, g.outer > 0 ? Math.max(g.half, g.outer - 150) : FAR_WOODS_OUT);
  if (outer <= inner + 50) return;
  // 300-500 hulls on the high tier (maps.md S1): the open steppe at the
  // bottom of that, the taiga at the top. The desert has no woods to show and
  // gets a few low rocky masses instead, so its horizon stays open.
  const desert = ctx.biome === 'desert';
  const biomeK = { meadow: 1, steppe: 0.55, winter: 1.35, desert: 0.3 }[ctx.biome] ?? 1;
  const qk = ctx.quality === 'low' ? 0.6 : ctx.quality === 'medium' ? 0.8 : 1;
  const full = desert ? 440 * biomeK : clamp(440 * biomeK, 300, 500);
  const want = Math.round(Math.max(90, full * qk));
  const rng = ctx.rng;
  const geo = farWoodGeometry();
  const rim = farWoodFootprint(geo);
  const items = [];
  let guard = 0;
  while (items.length < want && guard++ < want * 6) {
    const r = inner + (outer - inner) * Math.pow(rng(), 1.7);
    const a = rng() * TAU;
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    const k = 2 + Math.floor(rng() * 6);
    const spread = 40 + rng() * 90;
    const ang = rng() * Math.PI;
    for (let j = 0; j < k && items.length < want; j++) {
      // woods are longer than wide, strung out along a slope or a stream
      const along = (rng() - 0.5) * 2 * spread;
      const across = (rng() - 0.5) * spread * 0.5;
      const x = cx + Math.cos(ang) * along - Math.sin(ang) * across;
      const z = cz + Math.sin(ang) * along + Math.cos(ang) * across;
      const cheb = Math.max(Math.abs(x), Math.abs(z));
      const w = desert ? 50 + rng() * 80 : 30 + rng() * 50;
      const d = w * (0.75 + rng() * 0.5);
      const h = desert ? 6 + rng() * 7 : 14 + rng() * 10;
      const yaw = rng() * TAU;
      // the whole footprint, not just the centre, inside the band: a hull
      // centred at 2.49 km used to reach 40 m past the 2.5 km the contract
      // gives the woods
      const foot = farRimReach * Math.max(w, d);
      if (cheb < inner + foot || Math.hypot(x, z) + foot > outer) continue;
      if (inKeepOut(x, z, foot * 1.2 + 25)) continue;
      // The hull stands on the lowest ground under its actual rim (every base
      // vertex of the hull and four points along every base edge, through this
      // instance's own yaw and scale), sunk a little more: sampling inside
      // the rim left a hull on a skirt slope with its downhill edge in the
      // air. Where the ground under one hull falls by more than ~45% of its
      // height the uphill side would be buried past half-way, so that slope
      // is left bare and the wood tries the next spot.
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      let lo = Infinity;
      let hi = -Infinity;
      let ok = true;
      for (let vi = 0; vi < rim.length; vi += 2) {
        const lx = rim[vi] * w;
        const lz = rim[vi + 1] * d;
        const gy = g.heightAt(x + lx * cy + lz * sy, z - lx * sy + lz * cy);
        if (gy === null || !Number.isFinite(gy)) { ok = false; break; }
        if (gy < lo) lo = gy;
        if (gy > hi) hi = gy;
      }
      if (!ok || hi - lo + 0.4 > h * 0.45) continue;
      items.push({ x, z, y: lo - 0.4, w, d, h, yaw, tint: rng() });
    }
  }
  if (!items.length) return;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, vertexColors: true });
  owned.push(mat);
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  mesh.name = 'distant-woods';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // a wood in the haze is darker than the same wood at hand: the canopy is
  // all shadowed interior and no sunlit leaf
  const base = desert
    ? hexLinear(mixHex(ctx.preset.rockCol, 0x5a5040, 0.35))
    : hexLinear(mixHex(ctx.preset.crown, SNOW_HEX, ctx.snow * 0.35));
  const dk = desert ? 0.8 : 0.72;
  const xz = new Float32Array(items.length * 2);
  items.forEach((it, i) => {
    _q.setFromAxisAngle(_up, it.yaw);
    _v.set(it.x, it.y, it.z);
    _s.set(it.w, it.h, it.d);
    _m.compose(_v, _q, _s);
    mesh.setMatrixAt(i, _m);
    const k = dk * (0.88 + it.tint * 0.24);
    mesh.setColorAt(i, linColor(base[0] * k, base[1] * k, base[2] * k));
    xz[i * 2] = it.x;
    xz[i * 2 + 1] = it.z;
  });
  looseInstances.push({ mesh, xz });
  own(scene, mesh);
}

// ---------------------------------------------------------------------------
// Ground cover: groundcover.js builds and owns its mesh; this file creates it
// after the props, ticks it from updateScenery and disposes it with the rest.
function addGroundCover(scene, ctx) {
  try {
    groundCover = createGroundCover(scene, {
      preset: ctx.preset,
      landUse: ctx.lu,
      keepOuts: keepOutDiscs,
      quality: ctx.quality,
      terrainHeight,
      roadDistanceAt,
      features: ctx.feat,
    });
  } catch (err) {
    console.warn('[scenery] ground cover unavailable:', err);
    groundCover = null;
  }
}

// ---------------------------------------------------------------------------
// Weather. Falling snow is a single Points cloud whose motion lives entirely in
// the vertex shader: it costs one draw call and no CPU work per frame.
function addWeather(scene, preset) {
  if (preset.precip !== 'snow') return;
  const n = 900;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3 + 0] = rand(-70, 70);
    pos[i * 3 + 1] = rand(0, 62);
    pos[i * 3 + 2] = rand(-70, 70);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: preset.precipColor ?? 0xffffff,
    size: 0.3,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.95,   // the soft disc averages lower than the old square
    depthWrite: false,
    fog: true,
  });
  // three sizes points from the CANVAS height; the post chain may draw the
  // scene into a smaller target (P-04 render scale), where the same pixel
  // count would cover 1/scale more of the screen. uSnowRS is that target's
  // share of the canvas, read when the cloud is drawn.
  const uSnowRS = { value: 1 };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = windUniforms.time;
    sh.uniforms.uWind = windUniforms.vec;
    sh.uniforms.uSnowRS = uSnowRS;
    sh.vertexShader = `uniform float uTime;\nuniform vec2 uWind;\nuniform float uSnowRS;\n${sh.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      float sx = transformed.x + sin(uTime * 0.6 + transformed.z * 0.25) * 1.4 + uWind.x * uTime * 26.0;
      float sz = transformed.z + cos(uTime * 0.52 + transformed.x * 0.25) * 1.4 + uWind.y * uTime * 26.0;
      transformed.x = mod(sx + 70.0, 140.0) - 70.0;
      transformed.z = mod(sz + 70.0, 140.0) - 70.0;
      transformed.y = mod(transformed.y - uTime * 2.6, 62.0) - 31.0;`,
    ).replace(
      // A flake that passes the lens is a soft blur a few pixels across, not
      // a 50-60 px square: the attenuated size is capped at 3 % of the
      // frame's half-height (11 px at 720p) and the last 2.5 m fade it out.
      '#include <fog_vertex>',
      `#include <fog_vertex>
      vSnowNear = smoothstep(0.5, 2.5, -mvPosition.z);
      gl_PointSize = min(gl_PointSize, scale * 0.03) * uSnowRS;`,
    ).replace('void main() {', 'varying float vSnowNear;\nvoid main() {');
    // round, soft-edged flakes (a point sprite is a square otherwise)
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'varying float vSnowNear;\nvoid main() {').replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec2 snowPc = gl_PointCoord * 2.0 - 1.0;
      float snowR2 = dot(snowPc, snowPc);
      if (snowR2 > 1.0) discard;
      diffuseColor.a *= (1.0 - smoothstep(0.15, 1.0, snowR2)) * vSnowNear;`,
    );
  };
  mat.customProgramCacheKey = () => 'steelskies-snow-round';
  owned.push(geo, mat);
  precip = new THREE.Points(geo, mat);
  precip.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    const h = renderer.domElement && renderer.domElement.height;
    uSnowRS.value = rt && h > 0 ? Math.min(1, rt.height / h) : 1;
  };
  precip.frustumCulled = false;
  precip.renderOrder = 2;
  own(scene, precip);
}

// ---------------------------------------------------------------------------
export function resetScenery() {
  props.length = 0;
  falling.length = 0;
  blockerList.length = 0;
  grid.clear();
  clearSolids();
  clearTimber();
  pObj.length = 0;
  pCount = 0;
  // the query buffers keep stale entries past their counts (gatherNear)
  _queryA.length = 0;
  _queryB.length = 0;
  _crushRes.blocked = null;
  _segRes.prop = null;
  _solidProp = null;
  _timberProp = null;
  _afProp = null;
  // forget the last battle's airfields (the next query re-reads the registry)
  afSeen.length = 0;
  afSeenObs.length = 0;
  afSeenLen.length = 0;
  afOwner.length = 0;
  afPrims = 0;
  afFields = 0;
  nextPropId = 1;
  purgeables.length = 0;
  looseInstances.length = 0;
  precip = null;
  effectsHook = null;
  lastTick = -1e9;
}

// Battle teardown: drop the GPU side of everything setupEnvironment created.
// Safe to call twice, and safe to call before anything has been built — every
// battle's dispose() should call it, and setupEnvironment calls it for the
// battle before this one in case somebody forgot.
export function disposeScenery() {
  // Unhook the per-frame driver first: the scene it is bolted to is on its way
  // out, and a closure that keeps rendering into disposed buffers is worse than
  // no animation at all.
  if (driverScene) {
    if (typeof driverPrev === 'function') driverScene.onBeforeRender = driverPrev;
    else driverScene.onBeforeRender = () => {};
    driverScene = null;
    driverPrev = null;
  }

  // The grass owns its mesh, geometry and material outright.
  if (groundCover) {
    try { groundCover.dispose(); } catch { /* already gone with its scene */ }
    groundCover = null;
  }

  // The instanced meshes hold their own GPU buffers (one matrix attribute per
  // prop type), a BatchedMesh its merged geometry and matrix/colour textures,
  // and the sun a shadow map — none of which the geometry/material list below
  // covers. The flora, rock, pole and building-kit geometry and the kit
  // materials are session caches stamped shared, and are never in `owned`.
  for (let i = 0; i < sceneObjects.length; i++) {
    const o = sceneObjects[i];
    if (!o) continue;
    if (o.parent) o.parent.remove(o);
    if (o.shadow && typeof o.shadow.dispose === 'function') o.shadow.dispose();
    if (typeof o.dispose === 'function') o.dispose();
  }
  sceneObjects.length = 0;

  for (const o of owned) {
    // The prop materials now come from the shared factory cache, which is
    // deliberately reused from one battle to the next. Only free what this
    // scenery actually owns — geometries and any material it built itself.
    if (o && typeof o.dispose === 'function' && !isSharedResource(o)) o.dispose();
  }
  owned.length = 0;

  // The lighting rig holds GPU memory the loops above do not reach: the PMREM
  // render target is a full mip chain, and leaking one per battle would sink a
  // long session.
  if (envTarget) { envTarget.dispose(); envTarget = null; }
  if (pmrem) { pmrem.dispose(); pmrem = null; }
  if (envScene) { envScene.clear(); envScene = null; }
  if (activeScene) activeScene.environment = null;
  // the HDRI texture is an assets.js cache entry (stamped shared): only the
  // sphere that drew it is ours
  if (hdriSphere) { hdriSphere.geometry.dispose(); hdriSphere.material.dispose(); hdriSphere = null; }
  hdriId = null; hdriTex = null; hdriMix = 0; hdriTarget = 0; hdriBaked = -1; hdriGain = null;
  heightFog = false;
  if (sky) { if (sky.material) sky.material.dispose(); if (sky.geometry) sky.geometry.dispose(); }
  if (clouds) { if (clouds.material) clouds.material.dispose(); if (clouds.geometry) clouds.geometry.dispose(); }
  sky = null; skyUniforms = null;
  clouds = null; cloudUniforms = null;
  setActiveCloudVolume(null);
  sunLight = null; hemiLight = null;
  envDirty = false; envFailed = false;
  exposure = 0;
  exposureSaved = null;
  activeScene = null;
  resetScenery();
}
