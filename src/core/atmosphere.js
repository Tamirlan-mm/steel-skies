import * as THREE from 'three';

// Global shader-chunk overrides for the outdoor atmosphere (realism backlog
// L-06 and L-04 step 3; risk rule 5: EVERY chunk override lives in this file
// and is re-verified on any three.js upgrade — written against r170).
//
// 1. EXPONENTIAL HEIGHT FOG (art bible C-30..C-34).
//    The medium has extinction sigma(h) = sigma0 . exp(-h / H). Along the
//    straight camera -> fragment segment its optical depth has a closed form,
//        tau = sigma0 . d . exp(-h0/H) . (1 - exp(-x)) / x,   x = (h1 - h0) / H
//    (the limit 1 - x/2 + x^2/6 near x = 0), and the veil is 1 - exp(-tau).
//    sigma0 = 3.912 / V_game, V_game = V_real / 2.5, H = 1,200 m.
//    Two fades close it off:
//      - beyond 6.3 km of horizontal distance the veil is forced to 1 by
//        7.0 km, so the terrain skirt's outer edge (7 km) always dissolves
//        into the horizon colour (C-34 1.1 amendment);
//      - within the last 14 % of the camera's far plane the same, so a camera
//        whose far plane is short never shows a clipped edge.
//
//    NO NEW UNIFORMS. The law rides on THREE.Fog's own carriers:
//        fog.near = -sigma0   (NEGATIVE: that sign is what selects this law)
//        fog.far  = 1 / H
//    A Fog with near >= 0 keeps three's linear law bit for bit (the hangar's
//    95 m / 460 m stage fog), and FogExp2 is untouched. Build the fog with
//    makeHeightFog() rather than by hand.
//
//    The include TOKENS are unchanged, so every onBeforeCompile that anchors on
//    <fog_vertex> / <fog_fragment> (effects.js VEIL_VS, the smoke core, the
//    terrain material) picks the law up with no edit. The vertex chunk needs
//    `mvPosition` in scope, exactly as three's own did.
//
// 2. SHADOW-BOX EDGE FADE (L-04). getShadow() fades to "lit" over the outer
//    12 % of the shadow camera's square, so the line where the shadow map ends
//    is never visible. Point-light shadows are not touched.
//
// 3. FOG BEFORE TONE MAPPING (wave 3b fix, L-06 / C-34 on the low tier).
//    three's built-in shaders run <tonemapping_fragment>, then
//    <colorspace_fragment>, then <fog_fragment>: the fog colour (linear
//    scene radiance) is mixed into a pixel that is already tone mapped and
//    sRGB-encoded whenever the material draws straight to the canvas — the
//    low tier, which has no composer. Far terrain then missed the dome by
//    ~10 levels (verifier: 162,175,178 against 172,179,181). The fog is now
//    applied at the top of <tonemapping_fragment>, in linear light, and
//    <fog_fragment> stands down when that happened (SS_FOG_APPLIED). On a
//    composer buffer neither tone mapping nor encoding runs in the material,
//    so the order changes nothing there. A shader that includes
//    <fog_fragment> without <tonemapping_fragment> before it keeps the old
//    placement; one without <fog_pars_fragment> is left alone (SS_FOG_PARS).
//
// installAtmosphere() must run before the first program is compiled: three
// caches programs by material parameters, not by chunk text, so a program
// compiled with the stock chunks would be reused. world/scenery.js calls it at
// module evaluation, which precedes any render.

export const FAR_FADE_START = 6300;   // m, horizontal
export const FAR_FADE_END = 7000;
export const CAM_FADE_START = 0.86;   // x camera.far, view depth
export const CAM_FADE_END = 0.98;
export const SHADOW_EDGE_FADE = 0.88; // fade over |coord - .5| * 2 in [0.88, 1]

const FOG_PARS_VERTEX = /* glsl */`
#ifdef USE_FOG

	varying float vFogDepth;
	varying vec4 vFogWorld;

#endif
`;

// World position from the view-space position with no matrix inverse:
// mv = R.w + t  =>  w = R^T (mv - t), and v * M is M^T v in GLSL. w carries
// the camera's far plane (perspective: P[3][2] / (P[2][2] + 1)).
const FOG_VERTEX = /* glsl */`
#ifdef USE_FOG

	vFogDepth = - mvPosition.z;
	vFogWorld.xyz = ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
	vFogWorld.w = projectionMatrix[ 2 ][ 3 ] != 0.0 ? projectionMatrix[ 3 ][ 2 ] / ( projectionMatrix[ 2 ][ 2 ] + 1.0 ) : 1e9;

#endif
`;

// Shared with the cloud deck (world/scenery.js), which applies the same law
// in its own ShaderMaterial.
export const HEIGHT_FOG_GLSL = /* glsl */`
	float ssFogTau( float sigma0, float invH, float d, float h0, float h1 ) {
		float x = ( h1 - h0 ) * invH;
		float f = abs( x ) < 1e-3 ? 1.0 - 0.5 * x + x * x / 6.0 : ( 1.0 - exp( - x ) ) / x;
		return sigma0 * d * exp( - h0 * invH ) * f;
	}
	float ssFogVeil( float sigma0, float invH, vec3 cam, vec3 p, float viewDepth, float camFar ) {
		vec3 ray = p - cam;
		float veil = 1.0 - exp( - ssFogTau( sigma0, invH, length( ray ), cam.y, p.y ) );
		float edge = smoothstep( ${FAR_FADE_START.toFixed(1)}, ${FAR_FADE_END.toFixed(1)}, length( ray.xz ) );
		float clip = smoothstep( ${CAM_FADE_START.toFixed(3)}, ${CAM_FADE_END.toFixed(3)}, viewDepth / max( camFar, 1.0 ) );
		return 1.0 - ( 1.0 - veil ) * ( 1.0 - edge ) * ( 1.0 - clip );
	}
`;

// 4. CIRRUS (S-01: "a thin cirrus plane at 6-8 km gives the sky depth").
//    Not a mesh: a plane 7 km up would sit beyond the battle camera's
//    far-plane fade (0.86 x 8,200 m) for most of the sky. The layer is drawn
//    INSIDE the sky dome's shader (world/scenery.js addSky and its copy in
//    core/postfx.js), along the view ray: streaks of value noise stretched
//    along the upper wind, fibres across them, faded out below 17 degrees so
//    the horizon band (the fog colour, C-34) is untouched. The dome's PMREM
//    bake leaves it out (uSkyBake), so the image-based light and therefore
//    the light block's calibration (R1-K) do not see it.
//    Lit by the light block (contract R1-K), in the deck's units (sunLin =
//    E_sun / pi): single scattering, ice phase = Henyey-Greenstein g 0.75
//    plus an isotropic sixth, plus half the ambient, over the slant optical
//    depth tau / sin(elevation).
//      uCirrus     x cover 0..1, y vertical optical depth, zw drift (km)
//      uCirrusSun  preset.light.sunLin     uCirrusAmb  preset.light.ambLin
export const CIRRUS_HEIGHT = 7000;     // m
export const CIRRUS_DRIFT = 0.02;      // km/s along the surface wind
export const CIRRUS_GLSL = /* glsl */`
	uniform vec4 uCirrus;
	uniform vec3 uCirrusSun;
	uniform vec3 uCirrusAmb;
	float ssCirHash( vec2 c ) {
		vec3 q = fract( vec3( c.xyx ) * 0.1031 );
		q += dot( q, q.yzx + 33.33 );
		return fract( ( q.x + q.y ) * q.z );
	}
	float ssCirNoise( vec2 x ) {
		vec2 i = floor( x );
		vec2 f = x - i;
		vec2 u = f * f * ( 3.0 - 2.0 * f );
		return mix( mix( ssCirHash( i ), ssCirHash( i + vec2( 1.0, 0.0 ) ), u.x ),
			mix( ssCirHash( i + vec2( 0.0, 1.0 ) ), ssCirHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
	}
	// how much of the layer is along d (0..1)
	float ssCirrusCover( vec3 d ) {
		if ( uCirrus.x <= 0.0 || d.y < 0.06 ) return 0.0;
		vec2 q = d.xz * ( ${(CIRRUS_HEIGHT / 1000).toFixed(1)} / d.y ) + uCirrus.zw;
		vec2 r = vec2( dot( q, vec2( 0.8, 0.6 ) ), dot( q, vec2( - 0.6, 0.8 ) ) );
		vec2 s = vec2( r.x * 0.11, r.y * 0.85 );
		float n = 0.55 * ssCirNoise( s ) + 0.3 * ssCirNoise( s * 2.17 + vec2( 1.7, 9.2 ) )
			+ 0.15 * ssCirNoise( s * 4.9 + vec2( 5.3, 2.1 ) );
		float m = smoothstep( 1.0 - uCirrus.x, 1.0 - uCirrus.x + 0.3, n );
		m *= 0.7 + 0.3 * ssCirNoise( vec2( r.x * 0.5, r.y * 7.0 ) );
		return m * smoothstep( 0.06, 0.3, d.y );
	}
	// the sky radiance behind the layer -> what reaches the eye
	vec3 ssCirrus( vec3 sky, vec3 d, vec3 sunDir ) {
		float m = ssCirrusCover( d );
		if ( m <= 0.0 ) return sky;
		float tau = uCirrus.y * m / max( d.y, 0.15 );
		float cv = clamp( dot( d, sunDir ), - 1.0, 1.0 );
		float hg = 0.4375 / pow( max( 1.5625 - 1.5 * cv, 1e-3 ), 1.5 );
		float phase = ( 0.83 * hg + 0.17 ) * 0.0795775;
		vec3 scat = uCirrusSun * ( 3.1415927 * phase ) + 0.5 * uCirrusAmb;
		float a = 1.0 - exp( - tau );
		return sky * ( 1.0 - a ) + scat * a;
	}
`;

export function makeCirrusUniforms() {
  return {
    uCirrus: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCirrusSun: { value: new THREE.Vector3(0, 0, 0) },
    uCirrusAmb: { value: new THREE.Vector3(0, 0, 0) },
  };
}

// The sun the layer is lit by, from the light block's ground-level sunLin:
//   * 7 km up, the beam has crossed only the top 41 % of the air mass, so it
//     is CIRRUS_SUN_TAU x airmass x 0.59 less extinguished (Kasten-Young
//     airmass): x1.1-1.2 at noon, x3-4 for a 6-8 degree sun — why cirrus
//     glows long after the ground is in dusk light;
//   * x CIRRUS_SKY_K: the dome is drawn at ~2.5 x a physical sky against the
//     sun (zenith / sunLin 0.26 in green at a clear noon, 0.06-0.13 real),
//     and the layer is seen against it, so it carries the same convention.
export const CIRRUS_SUN_TAU = [0.13, 0.18, 0.28];   // R, G, B vertical extinction
export const CIRRUS_SKY_K = 2.5;
export function cirrusSunOf(L, sunY) {
  const e = Math.asin(Math.max(0.0, Math.min(1, sunY)));
  const deg = (e * 180) / Math.PI;
  const m = 1 / (Math.sin(e) + 0.50572 * Math.pow(deg + 6.07995, -1.6364));
  return [0, 1, 2].map((i) => L.sunLin[i] * CIRRUS_SKY_K
    * Math.min(5, Math.exp(CIRRUS_SUN_TAU[i] * m * 0.59)));
}

// preset.cirrus (presets.js composePreset) and the light block into them;
// no light block (an old preset): no cirrus
export function setCirrus(u, preset) {
  const c = preset && preset.cirrus;
  const L = preset && preset.light;
  const on = !!(c && L && L.sunLin && c.cover > 0 && c.tau > 0);
  u.uCirrus.value.set(on ? c.cover : 0, on ? c.tau : 0, 0, 0);
  if (on) {
    const s = cirrusSunOf(L, preset.sunDir ? preset.sunDir.y : 0.5);
    u.uCirrusSun.value.set(s[0], s[1], s[2]);
    u.uCirrusAmb.value.set(L.ambLin[0], L.ambLin[1], L.ambLin[2]);
  }
  return on;
}

// the layer drifts with the wind (dir x, z), wrapped well inside float range
export function driftCirrus(u, dt, wx = 1, wz = 0) {
  const v = u.uCirrus.value;
  if (!(v.x > 0) || !(dt > 0)) return;
  v.z = (v.z + wx * CIRRUS_DRIFT * dt) % 4096;
  v.w = (v.w + wz * CIRRUS_DRIFT * dt) % 4096;
}

const FOG_PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG

	#define SS_FOG_PARS
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec4 vFogWorld;

	#ifdef FOG_EXP2

		uniform float fogDensity;

	#else

		// fogNear < 0: height fog, sigma0 = -fogNear, fogFar = 1 / H
		// (core/atmosphere.js). fogNear >= 0: three's linear fog.
		uniform float fogNear;
		uniform float fogFar;
${HEIGHT_FOG_GLSL}
	#endif

#endif
`;

const FOG_APPLY = /* glsl */`
	#ifdef FOG_EXP2

		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );

	#else

		float fogFactor = fogNear < 0.0
			? ssFogVeil( - fogNear, fogFar, cameraPosition, vFogWorld.xyz, vFogDepth, vFogWorld.w )
			: smoothstep( fogNear, fogFar, vFogDepth );

	#endif

	gl_FragColor.rgb = mix( gl_FragColor.rgb, SS_FOG_COLOR, fogFactor );
`;

// (defines SS_FOG_APPLIED too: a custom shader that includes <fog_fragment>
// BEFORE <tonemapping_fragment> must not be fogged a second time there)
const FOG_FRAGMENT = /* glsl */`
#if defined( USE_FOG ) && ! defined( SS_FOG_APPLIED )
	#define SS_FOG_APPLIED
	#define SS_FOG_COLOR fogColor
${FOG_APPLY}
	#undef SS_FOG_COLOR
#endif
`;

// three r170's own <tonemapping_fragment>, with the fog in front of it.
// The fog colour: three uploads fogColor in the OUTPUT colour space when it
// draws to the canvas (WebGLMaterials.refreshFogUniforms ->
// getUnlitUniformColorSpace: its own <fog_fragment> mixes after encoding),
// and in linear when it draws to a render target. This mix is in linear
// light, so a canvas draw (the low tier) decodes it first — undecoded, the
// sRGB-encoded horizon fogged the low tier about 2x (measured: the dark
// calibration chips +4 to +8 levels at desert dusk, the far terrain brighter
// than the dome). linearToOutputTexel(0.5) tells the two apart, and the
// compiler folds the test away.
const TONEMAPPING_FRAGMENT = /* glsl */`
#if defined( USE_FOG ) && defined( SS_FOG_PARS ) && ! defined( SS_FOG_APPLIED )
	#define SS_FOG_APPLIED
	{
		vec3 ssFogLin = linearToOutputTexel( vec4( 0.5 ) ).r > 0.6
			? sRGBTransferEOTF( vec4( fogColor, 1.0 ) ).rgb : fogColor;
		#define SS_FOG_COLOR ssFogLin
${FOG_APPLY}
		#undef SS_FOG_COLOR
	}
#endif
#if defined( TONE_MAPPING )

	gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );

#endif
`;
const TONEMAPPING_R170 = `
#if defined( TONE_MAPPING )

	gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );

#endif
`;

const SHADOW_RETURN = 'return mix( 1.0, shadow, shadowIntensity );';
const SHADOW_RETURN_FADED = `float ssEdge = max( abs( shadowCoord.x - 0.5 ), abs( shadowCoord.y - 0.5 ) ) * 2.0;
		shadow = mix( shadow, 1.0, smoothstep( ${SHADOW_EDGE_FADE.toFixed(2)}, 1.0, ssEdge ) );
		${SHADOW_RETURN}`;

// 5. CLOUD SHADOWS ON THE GROUND (S-03).
//    The sun is dimmed where the S-01 / S-02 cloud field stands between it
//    and the fragment: the fragment's world position (vFogWorld, the height
//    fog's own varying, so no new varying) is carried up the caster direction
//    to the deck height and the deck's density is read there with the deck's
//    own law (ssDeckDensity is THE field function; the deck shader in
//    world/scenery.js calls it too, so the shadows drift with the clouds and
//    cover what they cover). Transmittance T = 1 - k . opacity . m, with m the
//    deck's alpha mask (smoothstep(waterLine, waterLine + edge, d)); it fades
//    out over the last 150 m below the deck so nothing above it is shaded.
//    Applied to directional light 0 (the battle sun) in <lights_fragment_begin>.
//
//    Uniforms ride on ShaderLib (lambert / phong / standard / physical / toon),
//    whose uniform objects every built-in material CLONES at compile time.
//    cloneUniforms copies a value only when it is a three Vector / Color /
//    Texture; the values here are plain {x, y, z, w} objects and an
//    un-flagged view of the field texture, so every program shares them by
//    reference and one write per frame reaches every material. Tiers
//    (backlog 4.3): ssCloudA.x for every lit material (high), ssCloudA.y for
//    the terrain only (medium: terrain.js defines SS_CLOUD_TERRAIN), low 0.
//      ssCloudA  x k all, y k terrain, z water line, w edge
//      ssCloudB  xy field drift (uv units, = the deck's uWind . uTime), z deck y, w deck opacity
//      ssCloudC  xy caster xz / caster y (the projection), zw unused
export const CLOUD_SHADOW_K = 0.85;      // transmittance under a full cloud: 0.15
export const CLOUD_SHADOW_FADE = 150;    // m below the deck where the shadow fades out
export const CLOUD_DECK_PERIOD = 2600;   // m: the field tile (world/clouds.js CLOUD_FIELD_PERIOD)
export const CLOUD_DECK_GLSL = /* glsl */`
	float ssDeckDensity( sampler2D map, vec2 w, vec2 drift ) {
		vec2 uv = w / ${CLOUD_DECK_PERIOD.toFixed(1)} + drift;
		float a = texture2D( map, uv ).r;
		float b = texture2D( map, uv * 2.17 + vec2( 0.31, 0.57 ) + drift * 0.6 ).r;
		return a * 0.65 + b * 0.35;
	}
`;
const CLOUD_SHADOW_PARS = /* glsl */`
#if defined( USE_FOG ) && defined( SS_FOG_PARS ) && ! defined( SS_CLOUD_PARS )
	#define SS_CLOUD_PARS
	uniform sampler2D ssCloudMap;
	uniform vec4 ssCloudA;
	uniform vec4 ssCloudB;
	uniform vec4 ssCloudC;
	#ifndef SS_DECK_DENSITY
	#define SS_DECK_DENSITY
${CLOUD_DECK_GLSL}
	#endif
	float ssCloudShadow( vec3 p, float k ) {
		if ( k <= 0.0 ) return 1.0;
		float up = ssCloudB.z - p.y;
		if ( up <= 0.0 ) return 1.0;
		float d = ssDeckDensity( ssCloudMap, p.xz + ssCloudC.xy * up, ssCloudB.xy );
		float m = smoothstep( ssCloudA.z, ssCloudA.z + ssCloudA.w, d );
		return 1.0 - k * ssCloudB.w * m * smoothstep( 0.0, ${CLOUD_SHADOW_FADE.toFixed(1)}, up );
	}
#endif
`;
const LIGHT_DIR_INFO = 'getDirectionalLightInfo( directionalLight, directLight );';
const LIGHT_DIR_INFO_CLOUD = `${LIGHT_DIR_INFO}
		#if defined( SS_CLOUD_PARS ) && ( UNROLLED_LOOP_INDEX == 0 )
		#ifdef SS_CLOUD_TERRAIN
		directLight.color *= ssCloudShadow( vFogWorld.xyz, max( ssCloudA.x, ssCloudA.y ) );
		#else
		directLight.color *= ssCloudShadow( vFogWorld.xyz, ssCloudA.x );
		#endif
		#endif`;

// the shared values (see above); plain objects on purpose
const cloudA = { x: 0, y: 0, z: 1, w: 0.28 };
const cloudB = { x: 0, y: 0, z: 900, w: 0.85 };
const cloudC = { x: 0, y: 0, z: 0, w: 0 };
let cloudWrap = null;
const cloudState = { field: null };
export const cloudShadowUniforms = {
  ssCloudMap: { value: null },
  ssCloudA: { value: cloudA },
  ssCloudB: { value: cloudB },
  ssCloudC: { value: cloudC },
};
// An un-flagged view of a texture (isTexture false), so cloneUniforms keeps
// the reference. The renderer reads every other field through the prototype.
// Own pieces, so it is a texture of its own to the renderer and not a shadow
// of the original's bookkeeping:
//  * _listeners: the renderer's 'dispose' listener binds to the view itself,
//    so the original's dispose no longer reaches it and the view's own
//    dispose (disposeCloudShadowField) releases the view's GPU slot;
//  * version: the original's live version plus a bias, so needsUpdate on the
//    original re-uploads the view as well, and re-pointing the view at a new
//    field always moves its version forward (never back to a stale number).
function wrapTexture(tex) {
  const w = Object.create(tex);
  let bias = 0;
  Object.defineProperty(w, 'isTexture', { value: false, writable: true });
  Object.defineProperty(w, '_listeners', { value: {}, writable: true });
  Object.defineProperty(w, 'version', {
    configurable: true,
    get() { return Object.getPrototypeOf(this).version + bias; },
    set(v) { bias += v - (Object.getPrototypeOf(this).version + bias); },
  });
  Object.defineProperty(w, 'repoint', {
    value(next) {
      const before = Object.getPrototypeOf(this).version + bias;
      Object.setPrototypeOf(this, next);
      bias = 0;
      if (next.version <= before) bias = before + 1 - next.version;
    },
  });
  return w;
}
// The field the deck draws (world/scenery.js makeCloudTexture). Swapping the
// field later re-points the view and forces an upload.
export function setCloudShadowField(tex) {
  if (!tex || !tex.isTexture) return false;
  cloudState.field = tex;
  if (!cloudWrap) {
    cloudWrap = wrapTexture(tex);
  } else if (Object.getPrototypeOf(cloudWrap) !== tex) {
    cloudWrap.repoint(tex);
  }
  cloudShadowUniforms.ssCloudMap.value = cloudWrap;
  return true;
}
// Releases the view's GPU texture (the renderer's dispose listener on the
// view). Only for a session teardown that also drops the field: the deck's
// field is generated once per session, so battles keep the view.
export function disposeCloudShadowField() {
  clearCloudShadow();
  if (cloudWrap) {
    try { cloudWrap.dispatchEvent({ type: 'dispose' }); } catch { /* no renderer yet */ }
  }
  cloudWrap = null;
  cloudState.field = null;
  cloudShadowUniforms.ssCloudMap.value = null;
}
// Per battle: strengths per tier, the deck's law, height and opacity, the
// caster direction. Anything left out keeps its value.
export function setCloudShadow(o = {}) {
  if (Number.isFinite(o.all)) cloudA.x = Math.max(0, o.all);
  if (Number.isFinite(o.terrain)) cloudA.y = Math.max(0, o.terrain);
  if (Number.isFinite(o.waterLine)) cloudA.z = o.waterLine;
  if (Number.isFinite(o.edge)) cloudA.w = Math.max(1e-3, o.edge);
  if (Number.isFinite(o.deckY)) cloudB.z = o.deckY;
  if (Number.isFinite(o.opacity)) cloudB.w = o.opacity;
  if (o.sun) {
    const sy = Math.max(0.05, o.sun.y);
    cloudC.x = o.sun.x / sy;
    cloudC.y = o.sun.z / sy;
  }
  return cloudShadowState();
}
// the field drift in uv units (the deck's uWind . uTime), every frame
export function setCloudShadowDrift(dx, dz) {
  cloudB.x = Number.isFinite(dx) ? dx : 0;
  cloudB.y = Number.isFinite(dz) ? dz : 0;
}
export function clearCloudShadow() {
  cloudA.x = 0;
  cloudA.y = 0;
}
export function cloudShadowState() {
  return {
    all: cloudA.x, terrain: cloudA.y, waterLine: cloudA.z, edge: cloudA.w,
    driftX: cloudB.x, driftZ: cloudB.y, deckY: cloudB.z, opacity: cloudB.w,
    projX: cloudC.x, projZ: cloudC.y, field: cloudState.field,
    shared: !!cloudWrap && cloudShadowUniforms.ssCloudMap.value === cloudWrap,
  };
}
// The JS twin of ssCloudShadow, given a density function d(x, z, driftX,
// driftZ) (world/clouds.js deckDensityAt). k = the strength the material sees.
export function cloudShadowJS(density, x, y, z, k = cloudA.x) {
  if (!(k > 0)) return 1;
  const up = cloudB.z - y;
  if (up <= 0) return 1;
  const d = density(x + cloudC.x * up, z + cloudC.y * up, cloudB.x, cloudB.y);
  const m = smooth(cloudA.z, cloudA.z + cloudA.w, d);
  return 1 - k * cloudB.w * m * smooth(0, CLOUD_SHADOW_FADE, up);
}
const SHADOW_LIBS = ['lambert', 'phong', 'standard', 'physical', 'toon'];

let installed = false;

export function installAtmosphere() {
  if (installed) return true;
  const C = THREE.ShaderChunk;
  if (!C || typeof C.fog_fragment !== 'string') return false;
  C.fog_pars_vertex = FOG_PARS_VERTEX;
  C.fog_vertex = FOG_VERTEX;
  C.fog_pars_fragment = FOG_PARS_FRAGMENT;
  C.fog_fragment = FOG_FRAGMENT;
  // only over the chunk this was written against (a three upgrade that
  // changes it keeps the old fog placement rather than losing tone mapping)
  if (typeof C.tonemapping_fragment === 'string'
    && C.tonemapping_fragment.replace(/\s+/g, ' ').trim() === TONEMAPPING_R170.replace(/\s+/g, ' ').trim()) {
    C.tonemapping_fragment = TONEMAPPING_FRAGMENT;
  }
  // Only getShadow (directional + spot), which comes before getPointShadow
  // in the chunk; String.replace with a string swaps the first match only.
  const sm = C.shadowmap_pars_fragment;
  const at = typeof sm === 'string' ? sm.indexOf(SHADOW_RETURN) : -1;
  const pt = typeof sm === 'string' ? sm.indexOf('getPointShadow') : -1;
  if (at >= 0 && (pt < 0 || at < pt)) C.shadowmap_pars_fragment = sm.replace(SHADOW_RETURN, SHADOW_RETURN_FADED);
  // S-03: the uniforms on every lit built-in shader, then the chunks. Only
  // over the r170 text (a three upgrade without the anchor keeps no shadows
  // rather than a broken shader).
  const lib = THREE.ShaderLib;
  let libsOk = !!lib;
  if (lib) {
    if (!cloudWrap) {
      // a 1 x 1 stand-in until the deck's field arrives (setCloudShadowField)
      const ph = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      ph.needsUpdate = true;
      ph.userData = { shared: true };   // markShared (core/materials.js) without the import
      cloudWrap = wrapTexture(ph);
      cloudShadowUniforms.ssCloudMap.value = cloudWrap;
    }
    for (const k of SHADOW_LIBS) {
      if (lib[k] && lib[k].uniforms) Object.assign(lib[k].uniforms, cloudShadowUniforms);
      else if (k !== 'standard') libsOk = false;
    }
  }
  if (libsOk && typeof C.lights_pars_begin === 'string' && typeof C.lights_fragment_begin === 'string'
    && C.lights_fragment_begin.includes(LIGHT_DIR_INFO)) {
    C.lights_pars_begin = `${C.lights_pars_begin}\n${CLOUD_SHADOW_PARS}`;
    C.lights_fragment_begin = C.lights_fragment_begin.replace(LIGHT_DIR_INFO, LIGHT_DIR_INFO_CLOUD);
  }
  installed = true;
  return true;
}

export function atmosphereInstalled() {
  return installed;
}

// A THREE.Fog carrying the height-fog law (see the header).
export function makeHeightFog(color, visibility, scaleHeight = 1200) {
  const fog = new THREE.Fog(0x000000, -sigmaFor(visibility), 1 / Math.max(1, scaleHeight));
  if (color) fog.color.copy(color);
  fog.userData = { heightFog: true, visibility, scaleHeight };
  return fog;
}

export function sigmaFor(visibility) {
  return 3.912 / Math.max(1, visibility);
}

export function isHeightFog(fog) {
  return !!(fog && fog.isFog && fog.near < 0);
}

// ---------------------------------------------------------------------------
// The same maths in JS, for the headless tests and for anything that wants to
// know what the fog will do to a point (sight lines, the cloud deck tests).
export function fogTau(sigma0, invH, d, h0, h1) {
  const x = (h1 - h0) * invH;
  const f = Math.abs(x) < 1e-3 ? 1 - 0.5 * x + (x * x) / 6 : (1 - Math.exp(-x)) / x;
  return sigma0 * d * Math.exp(-h0 * invH) * f;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// cam / p: {x, y, z}; viewDepth and camFar optional (no clip fade without them)
export function heightFogVeil(sigma0, invH, cam, p, viewDepth = 0, camFar = 1e9) {
  const dx = p.x - cam.x;
  const dy = p.y - cam.y;
  const dz = p.z - cam.z;
  const d = Math.hypot(dx, dy, dz);
  const veil = 1 - Math.exp(-fogTau(sigma0, invH, d, cam.y, p.y));
  const edge = smooth(FAR_FADE_START, FAR_FADE_END, Math.hypot(dx, dz));
  const clip = smooth(CAM_FADE_START, CAM_FADE_END, viewDepth / Math.max(camFar, 1));
  return 1 - (1 - veil) * (1 - edge) * (1 - clip);
}
