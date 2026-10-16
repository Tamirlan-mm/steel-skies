// Map biome presets, plus the time of day and the weather rolled on top of one.
// A random preset + random heightmap seed is picked for every battle; the biome
// decides what the ground is made of, the hour decides where the sun sits and
// the weather decides how far you can see through it.
//
// This module deliberately imports nothing — terrain.js reads the active preset
// to classify its surfaces, so it has to sit at the bottom of the graph.

//
// COLOUR CALIBRATION. The terrain shader divides every layer texture by its own
// mean, so `low` / `high` / `rock` ARE the ground albedo, and the crown, wall
// and roof hexes are what the materials reflect. Every hex below was solved for
// a real-world linear (Rec.709) luminance with the hexLum() the map audit uses:
//   pasture 0.10-0.15   wheat / stubble 0.25-0.35   plough 0.07-0.12
//   broadleaf crown 0.05-0.09   conifer crown 0.03-0.06   steppe grass 0.18-0.26
//   limestone wall 0.30-0.45   log wall 0.06-0.12   whitewash 0.55-0.70
//   slate roof 0.05-0.08   clay tile 0.10-0.15   thatch 0.15-0.25
// The old meadow was 0.213 — dry-August straw, not Normandy grass in June.
//
// LAND-USE BLOCKS (maps.md contract P). Read-only data for world/landuse.js,
// flora.js, buildings.js, groundcover.js, terrain.js and scenery.js; composePreset
// passes every block through by reference, so treat them as immutable.
//   landuse: {
//     cell: [w, d]        parcel column width along a row, row depth (metres)
//     warp                sinusoidal domain-warp amplitude (m) — irregular fields
//     hedgeChance         0..1, share of eligible parcel edges that become hedge
//     crops: { pasture, wheat, stubble, plough, fallow }   relative weights
//     woods: { count, r: [min, max], types: [...'broadleaf'|'conifer'|'mixed'|'palm'] }
//     orchardChance       0..1, share of parcels that are orchard (crop 5)
//     // optional hints, safe to ignore:
//     fields              false = no visible parcel pattern at all (desert)
//     fenceChance         0..1, share of non-hedge edges that get a fence
//     roadTrees           archetype key for trees lining the road, or null
//     hedgeStyle          'bocage' (bank + brush) | 'belt' (wide tree shelter belt)
//   }
//   flora: { <archetype key>: weight }   keys from flora.js: oak beech poplar birch
//                                        spruce pine fruit palm scrub
//   architecture: 'normandy' | 'izba' | 'khata' | 'desert' | 'nordic'
//   buildingPalette: { wall: [hex...], roof: [hex...], trim: hex }
//   grass: { density (x the quality tier's count), height (m), color, dryColor }
//   cropCols: [pasture, wheat, stubble, plough, fallow, orchard grass] — the
//     crop index order of LANDUSE_GLSL; cropCols[0] equals `low`, so the terrain's
//     cropCols[i] / cropCols[0] multiplier leaves pasture exactly as the ground is.
//   rocks: { mode: 'cluster' | 'outcrop' }   optional hint for scenery placement

export const MAP_PRESETS = {
  // Normandy bocage, June-July: a patchwork of small irregular pastures and
  // cereal plots, every one ringed by a hedgerow on an earth bank, cider
  // orchards by the farms, oak/beech copses, poplar-lined lanes, grey limestone
  // farmhouses under slate with a church tower in the village.
  meadow: {
    name: 'Bocage',
    low: 0x4e6e32, high: 0x68693c, rock: 0x77776f,
    sky: 0x9fc3e8, fog: 0xb8cfe4,
    trunk: 0x6b4f33, crown: 0x355228, rockCol: 0x81817a,
    hemiGround: 0x4e5e34,
    treeFactor: 1, rockFactor: 1,
    // ground make-up: what the biome turns into away from slopes and hollows
    groundType: 'grass', hollowType: 'dirt',
    dust: { grass: 0x8a7050, dirt: 0x9a8a68, sand: 0xc0a878, snow: 0xeef3f7, rock: 0x9c968c },
    wind: 3.2, snowLine: 999,
    weather: { clear: 5, overcast: 3, snow: 0.4, haze: 1.6 },
    landuse: {
      cell: [125, 95], warp: 12, hedgeChance: 0.85,
      crops: { pasture: 0.5, wheat: 0.18, stubble: 0.07, plough: 0.1, fallow: 0.15 },
      woods: { count: 5, r: [45, 90], types: ['broadleaf', 'mixed'] },
      orchardChance: 0.1,
      fields: true, fenceChance: 0.1, roadTrees: 'poplar', hedgeStyle: 'bocage',
    },
    flora: { oak: 0.4, beech: 0.2, poplar: 0.2, fruit: 0.2 },
    architecture: 'normandy',
    buildingPalette: {
      //      Caen limestone, ochre limestone, grey granite
      wall: [0xb1aa8b, 0xb19d78, 0x9a9992],
      //      slate, dark slate, Pays d'Auge clay tile
      roof: [0x464b53, 0x3f4347, 0x8f5436],
      trim: 0x47392e,
    },
    grass: { density: 1, height: 0.45, color: 0x4f7133, dryColor: 0x8b815b },
    //        pasture   wheat     stubble   plough    fallow    orchard grass
    cropCols: [0x4e6e32, 0xa8944f, 0x9f8f65, 0x67513d, 0x6f6f43, 0x4a6730],
    rocks: { mode: 'cluster' },
  },
  desert: {
    name: 'Desert',
    low: 0xc4a56b, high: 0xa9834e, rock: 0x8f7a58,
    sky: 0xcfdae6, fog: 0xe0d2b4,
    trunk: 0x7a6748, crown: 0x545d36, rockCol: 0x9d8a6b,
    hemiGround: 0x8a7a55,
    treeFactor: 0.25, rockFactor: 1.8,
    groundType: 'sand', hollowType: 'sand',
    dust: { grass: 0xbba377, dirt: 0xc9ad7c, sand: 0xd8bb84, snow: 0xeef3f7, rock: 0xa8977a },
    wind: 4.6, snowLine: 999,
    weather: { clear: 6, overcast: 1.2, snow: 0, haze: 4 },
    // North Africa: no fields and no hedges. A parcel cell far larger than any
    // map means no parcel edge crosses the playable area, and every crop is
    // pasture with cropCols all equal to `low`, so the ground shows no pattern.
    // Trees only at a couple of small palm oases; scrub elsewhere.
    landuse: {
      cell: [6000, 6000], warp: 0, hedgeChance: 0,
      crops: { pasture: 1, wheat: 0, stubble: 0, plough: 0, fallow: 0 },
      woods: { count: 2, r: [16, 28], types: ['palm'] },
      orchardChance: 0,
      fields: false, fenceChance: 0, roadTrees: null, hedgeStyle: 'bocage',
    },
    flora: { palm: 0.4, scrub: 0.6 },
    architecture: 'desert',
    buildingPalette: {
      //      limestone plaster, mud brick, whitewash
      wall: [0xb4a585, 0xab946f, 0xcec8ba],
      //      flat earthen roof, darker
      roof: [0xa48c6c, 0x97815b],
      trim: 0x463a2e,
    },
    grass: { density: 0.1, height: 0.6, color: 0x646440, dryColor: 0x998b67 },
    cropCols: [0xc4a56b, 0xc4a56b, 0xc4a56b, 0xc4a56b, 0xc4a56b, 0xc4a56b],
    rocks: { mode: 'outcrop' },
  },
  winter: {
    name: 'Winter',
    low: 0xe3e9ee, high: 0xcdd6de, rock: 0x8b939c,
    sky: 0xa9c2dc, fog: 0xdae2ea,
    trunk: 0x4c3b2c, crown: 0x26422e, rockCol: 0x808790,
    hemiGround: 0x9fb0c0,
    // Karelia: spruce and pine forest closes every horizon, and granite
    // outcrops and glacial boulders break through the snow.
    treeFactor: 1.5, rockFactor: 1.3,
    groundType: 'snow', hollowType: 'snow',
    dust: { grass: 0xdfe7ee, dirt: 0xbfae94, sand: 0xd8bb84, snow: 0xeef3f7, rock: 0x9aa2ab },
    wind: 2.4, snowLine: -4,
    weather: { clear: 3, overcast: 4, snow: 4, haze: 1 },
    // Forest clearings rather than farmland: small hay meadows and rye plots
    // under snow, split by log fences, never hedges. Seven large conifer woods
    // (about 30% canopy after the cap, road and village are cut out).
    landuse: {
      cell: [170, 120], warp: 8, hedgeChance: 0,
      crops: { pasture: 0.45, wheat: 0, stubble: 0.25, plough: 0.1, fallow: 0.2 },
      woods: { count: 7, r: [90, 140], types: ['conifer', 'mixed'] },
      orchardChance: 0,
      fields: true, fenceChance: 0.35, roadTrees: null, hedgeStyle: 'bocage',
    },
    flora: { spruce: 0.5, pine: 0.35, birch: 0.15 },
    architecture: 'nordic',
    buildingPalette: {
      //      weathered grey log, falu red boards, brown log
      wall: [0x58544d, 0x7f2e20, 0x5f4939],
      //      shingle, tarred plank
      roof: [0x4a463f, 0x42413c],
      trim: 0x393939,
    },
    // dead stalks poking through the snow
    grass: { density: 0.25, height: 0.55, color: 0x867b5c, dryColor: 0x9a906a },
    // everything is under snow: the parcels differ by what shows through it
    //        pasture   (wheat)   stubble   plough    fallow    orchard
    cropCols: [0xe3e9ee, 0xdbdbd1, 0xd6d4c9, 0xccd2d9, 0xd8d9d4, 0xdde2e6],
    rocks: { mode: 'outcrop' },
  },
  // Eastern front in July (Kursk, Prokhorovka): open rolling steppe of
  // sun-bleached grass and ripe wheat in fields hundreds of metres across,
  // birch and poplar shelter belts along some field edges, oak copses in the
  // ravines, chalk showing on the steep banks, and villages of whitewashed
  // thatched khatas strung along the road.
  steppe: {
    name: 'Steppe',
    low: 0x8a8351, high: 0x796b4a, rock: 0x999587,
    sky: 0xa6c3e0, fog: 0xcbd3d6,
    trunk: 0x6c5f51, crown: 0x40592d, rockCol: 0x969081,
    hemiGround: 0x7a734e,
    treeFactor: 0.45, rockFactor: 0.4,
    groundType: 'grass', hollowType: 'dirt',
    dust: { grass: 0x9c8a62, dirt: 0xae9a74, sand: 0xcdb88c, snow: 0xeef3f7, rock: 0xb2ad9d },
    wind: 4.2, snowLine: 999,
    weather: { clear: 5, overcast: 2.2, snow: 0.25, haze: 2.6 },
    landuse: {
      cell: [420, 260], warp: 4, hedgeChance: 0.1,
      crops: { pasture: 0.18, wheat: 0.36, stubble: 0.14, plough: 0.12, fallow: 0.2 },
      woods: { count: 4, r: [28, 60], types: ['broadleaf', 'mixed'] },
      orchardChance: 0.04,
      fields: true, fenceChance: 0.05, roadTrees: 'poplar', hedgeStyle: 'belt',
    },
    flora: { birch: 0.45, poplar: 0.35, oak: 0.2 },
    architecture: 'khata',
    buildingPalette: {
      //      whitewash, lime-blue whitewash, weathered whitewash
      wall: [0xd5d1c7, 0xc9cccb, 0xcac5b7],
      //      thatch, old grey thatch
      roof: [0x8e7955, 0x79705b],
      trim: 0x443a2f,
    },
    grass: { density: 1.2, height: 0.7, color: 0x8a7e4e, dryColor: 0x979768 },
    //        pasture   wheat     stubble   chernozem fallow    orchard grass
    cropCols: [0x8a8351, 0xb2974f, 0xa0926a, 0x574c40, 0x77754a, 0x62683a],
    rocks: { mode: 'cluster' },
  },
};

// ---------------------------------------------------------------------------
// Time of day. `noon` reproduces the historical look exactly — same sun vector,
// colour and intensity the scene has always had — so an unchanged battle file
// that happens to roll noon renders byte-for-byte what it did yesterday.
// Elevation and azimuth are degrees; azimuth 0 is +Z, positive toward +X.
// `atm` is the Preetham daylight model's four knobs, read by world/scenery.js to
// drive three/examples/jsm/objects/Sky.js and by skyRadiance() below to work out
// what colour the horizon actually is. Turbidity is how much dust is in the air
// (2 = alpine, 12 = industrial murk), rayleigh scales the blue of the sky dome,
// mie the white glare around the sun and mieDirectionalG how tightly that glare
// hugs it. `cloud` is the drifting deck (its colours now come from the light
// block, see S-01; the hexes are kept for anything still reading them).
//
// LIGHT CALIBRATION (realism backlog L-01/L-02/L-03, wave R1). The hour no
// longer authors a sun colour or a tone-mapping exposure by hand:
//   sun       null = derived from the elevation through sunCCT() (Planckian,
//             art bible 4.5 table). Only the grey day keeps a hex: that is the
//             sun seen THROUGH cloud, not a function of its height.
//   sunLum    the sun's luminance, Y(sunColor) x sunIntensity. It is held at the
//             value the hour had before the colour was derived, so the measured
//             L-01 ratios stand; sunIntensity is solved from it.
//   exposure  solved per composed preset by lightBlock() so an 18 % card under
//             the dominant light lands on sRGB 125 (110 under a low sun) after
//             AgX — see composePreset().
//   envIntensity / hemiIntensity  the AUTHORED levels. The battle rig scales
//             them by the weather's `rig` factors (sky/hemi/ibl, L-01 table)
//             and publishes the result in preset.light; the plain fields keep
//             their old meaning for the hangar studio rig (until L-09).
export const TIMES_OF_DAY = {
  dawn: {
    name: 'Dawn',
    // was sun 0xffd2a0 x 1.55 (3,922 K): the derived 8-degree sun is 3,800 K
    elev: 8, azim: 104, sun: null, sunLum: 1.0833, sunIntensity: 1.55,
    hemiSky: 0xc2d6f2, hemiIntensity: 0.95,
    skyTint: 0xf0b98e, skyMix: 0.42,
    fogTint: 0xe6c7a6, fogMix: 0.4,
    groundTint: 0xd8b48c, groundMix: 0.16,
    fogNearMul: 0.62, fogFarMul: 0.72,
    atm: { turbidity: 5.5, rayleigh: 2.7, mie: 0.010, mieG: 0.845 },
    cloud: { cover: 0.28, lit: 0xffd9b8, dark: 0x8c7a86, height: 900 },
    exposure: 1.14, envIntensity: 0.72,
    weight: 1.1,
  },
  noon: {
    name: 'Midday',
    // was sun 0xfff2dd x 2.6 (5,419 K)
    elev: 53.4, azim: 63.4, sun: null, sunLum: 2.3396, sunIntensity: 2.6,
    hemiSky: 0xcfe4ff, hemiIntensity: 1.15,
    skyTint: 0xffffff, skyMix: 0,
    fogTint: 0xffffff, fogMix: 0,
    groundTint: 0xffffff, groundMix: 0,
    fogNearMul: 1, fogFarMul: 1,
    atm: { turbidity: 2.6, rayleigh: 1.5, mie: 0.005, mieG: 0.80 },
    // 850 m (was 1,150): every aeroplane is held under y = 1,000 m
    // (planeEntity), so a deck above that was never seen from above — the
    // S-01 lit tops only exist for a player who can climb over them. Fair-
    // weather cumulus bases of 600-900 m are an ordinary humid lowland noon.
    cloud: { cover: 0.22, lit: 0xffffff, dark: 0x9aa8b8, height: 850 },
    exposure: 1.10, envIntensity: 0.70,
    weight: 2.2,
  },
  dusk: {
    name: 'Dusk',
    // was sun 0xff9d5c x 1.35 (2,404 K, art bible G20: too red for 6 degrees)
    elev: 6, azim: -118, sun: null, sunLum: 0.6230, sunIntensity: 1.35,
    hemiSky: 0x9fb4d8, hemiIntensity: 0.8,
    skyTint: 0xe07a48, skyMix: 0.5,
    fogTint: 0xcf8a63, fogMix: 0.46,
    groundTint: 0xc98a5e, groundMix: 0.2,
    fogNearMul: 0.7, fogFarMul: 0.78,
    atm: { turbidity: 7.0, rayleigh: 3.1, mie: 0.012, mieG: 0.865 },
    cloud: { cover: 0.30, lit: 0xffb583, dark: 0x6e5f74, height: 880 },
    // envIntensity 0.63 (was 0.74, wave 3c): with the light block modelling
    // the PMREM lobe three really lights with (pmremLobe), the sun-facing
    // dusk card's lit:shadow was 3.75 at meadow-dusk-clear, under the L-01
    // 4-8; the old figure only met it through the cosine model's error
    exposure: 1.16, envIntensity: 0.63,
    weight: 1.1,
  },
  overcast: {
    name: 'Grey day',
    // sun through cloud (7,070 K): authored, not derived from the elevation
    elev: 44, azim: 22, sun: 0xdde3ea, sunIntensity: 0.9,
    // a grey day is lit by the whole dome: no ambient cut (L-01 table, last row)
    rig: { sky: 1.0, hemi: 1.0, ibl: 1.0 },
    hemiSky: 0xc8d2dc, hemiIntensity: 1.6,
    skyTint: 0x9aa5b0, skyMix: 0.55,
    fogTint: 0xa9b3bd, fogMix: 0.5,
    groundTint: 0x9fa8b0, groundMix: 0.14,
    fogNearMul: 0.8, fogFarMul: 0.7,
    atm: { turbidity: 10, rayleigh: 0.75, mie: 0.020, mieG: 0.74 },
    cloud: { cover: 0.62, lit: 0xc9d0d7, dark: 0x7b848e, height: 700 },
    exposure: 1.06, envIntensity: 0.80,
    weight: 1.4,
  },
};

// Weather sits on top of the hour. It never touches the sun *vector* — only how
// much of it arrives and how far the eye carries — so nothing here can make the
// shadow camera move, which is what keeps it free.
//
//   rig          L-01 factors (realism backlog table, measured with
//                l01table.mjs): `sky` scales the dome, the fog colour and the
//                PMREM baked from them; `hemi` shrinks the hemisphere light to
//                the ground-bounce share; `ibl` scales the image-based light.
//                The grey-day hour overrides them with its own (no cut).
//   visibilityKm the REAL meteorological visibility. The game draws it at
//                1 / FOG_COMPRESSION (art bible C-31), so clear 25 km reads as
//                10 km of air over a 1-3 km map.
export const WEATHERS = {
  clear: {
    name: 'Clear',
    rig: { sky: 0.75, hemi: 0.18, ibl: 0.45 },
    visibilityKm: 25,
    sunMul: 1, hemiMul: 1,
    fogNearMul: 1, fogFarMul: 1,
    fogTint: 0xffffff, fogMix: 0,
    skyTint: 0xffffff, skyMix: 0,
    turbidityAdd: 0, rayleighMul: 1, mieMul: 1,
    cloudAdd: 0, cloudOpacity: 0.85, exposureMul: 1, envMul: 1,
    // S-01: the thin ice layer 7 km up (core/atmosphere.js CIRRUS_GLSL):
    // share of the sky it covers, and its vertical optical depth
    cirrus: { cover: 0.34, tau: 0.16 },
    precip: 'none', snowCover: 0, gripMul: 1, windMul: 1,
  },
  overcast: {
    name: 'Overcast',
    // thin overcast, sun still visible (L-01 row "noon + overcast weather")
    rig: { sky: 1.0, hemi: 0.6, ibl: 0.8 },
    visibilityKm: 16.25,
    sunMul: 0.42, hemiMul: 1.4,
    fogNearMul: 0.78, fogFarMul: 0.6,
    fogTint: 0xa8b2bb, fogMix: 0.45,
    skyTint: 0x8f9aa4, skyMix: 0.5,
    turbidityAdd: 6, rayleighMul: 0.5, mieMul: 2.0,
    cloudAdd: 0.34, cloudOpacity: 0.96, exposureMul: 0.95, envMul: 1.05,
    precip: 'none', snowCover: 0, gripMul: 0.96, windMul: 1.3,
  },
  snow: {
    name: 'Light snow',
    rig: { sky: 1.0, hemi: 1.0, ibl: 1.0 },
    visibilityKm: 4,
    sunMul: 0.5, hemiMul: 1.3,
    fogNearMul: 0.5, fogFarMul: 0.42,
    fogTint: 0xd6dee6, fogMix: 0.6,
    skyTint: 0xb8c2cb, skyMix: 0.55,
    turbidityAdd: 5, rayleighMul: 0.55, mieMul: 2.2,
    cloudAdd: 0.40, cloudOpacity: 0.98, exposureMul: 0.97, envMul: 1.05,
    precip: 'snow', snowCover: 0.8, gripMul: 0.88, windMul: 1.1,
  },
  haze: {
    name: 'Haze',
    rig: { sky: 0.75, hemi: 0.25, ibl: 0.55 },
    visibilityKm: 10,
    sunMul: 0.86, hemiMul: 1.1,
    fogNearMul: 0.42, fogFarMul: 0.66,
    fogTint: 0xd9cdb2, fogMix: 0.32,
    skyTint: 0xd8cfbb, skyMix: 0.3,
    turbidityAdd: 6, rayleighMul: 0.85, mieMul: 1.6,
    cloudAdd: 0.10, cloudOpacity: 0.8, exposureMul: 1, envMul: 1,
    // a milky veil rather than streaks
    cirrus: { cover: 0.5, tau: 0.1 },
    precip: 'none', snowCover: 0, gripMul: 1, windMul: 0.7,
  },
};

// ---------------------------------------------------------------------------
// Colour helpers. Everything here is a packed 0xRRGGBB int, because that is what
// buildTerrain and the scenery materials already take.
function mixHex(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16)
    | (Math.round(ag + (bg - ag) * t) << 8)
    | Math.round(ab + (bb - ab) * t);
}

function scaleHex(c, m) {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * m));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * m));
  const b = Math.min(255, Math.round((c & 255) * m));
  return (r << 16) | (g << 8) | b;
}

export { mixHex as mixColor, scaleHex as scaleColor };

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Preetham daylight, on the CPU.
//
// This is a line-for-line port of the fragment shader in
// three/examples/jsm/objects/Sky.js, minus the solar disc. It exists so the fog
// colour, the background clear colour and the ambient tints can be *the same
// numbers the sky dome is about to render*, computed the instant a preset is
// composed and without a GPU, a render target or a pixel readback. Aerial
// perspective only reads as distance when the fog and the horizon agree, and
// the old hand-picked fog hex could not agree with a sky that did not exist yet.
//
// The result is LINEAR radiance, pre-tone-mapping — exactly the space
// THREE.Fog.color is uploaded in, so it drops straight into
// fog.color.setRGB(r, g, b, LinearSRGBColorSpace) and a fully fogged pixel comes
// out of ACES identical to the sky behind it.
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF_ANGLE = 1.6110731556870734;   // pi / 1.95, the earth-shadow hack
const STEEPNESS = 1.5;
const SUN_EE = 1000;
const RAYLEIGH_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;
const THREE_OVER_16PI = 0.05968310365946075;
const ONE_OVER_4PI = 0.07957747154594767;
const NIGHT_BIAS = [0, 0.0003, 0.00075];

// Preetham is authored for the three.js sky demo, which renders it at
// toneMappingExposure 0.5. This game runs near 1.1 because everything else in
// it is lit for that, so the sky is scaled down here instead of pulling the
// whole frame's exposure with it. Measured: at 0.25 a clear midday zenith lands
// on sRGB 129,158,185 and the horizon on 201,209,210, which is the range the
// old flat background colours occupied. The scale is applied to the CPU
// radiance below AND handed to the sky shader as uSkyScale, so the dome and the
// fog can never drift apart.
//
// SKY_SCALE is the BASE. Each composed preset carries its own `skyScale`
// (SKY_SCALE x the weather's rig.sky, L-01), which is what the dome, the fog
// colour and the PMREM actually use; skyRadiance(preset, ...) applies it.
export const SKY_SCALE = 0.25;

// Real visibility is drawn at 1/2.5 (art bible C-31), and the aerosol that
// makes the haze thins out with height on this scale (C-33, L-06).
export const FOG_COMPRESSION = 2.5;
export const FOG_SCALE_HEIGHT = 1200;

// The lowest the shadow-casting light may go (sin of 5.7 degrees, L-04 /
// C-23). Both presets with a low sun (dawn 8, dusk 6) sit above it, so the
// world is lit from exactly the sun on the dome. scenery.js reads it.
export const CASTER_FLOOR = 0.10;

// Everything the fragment shader gets as a varying, worked out once per sky.
function skyState(atm, sunDir, scale = SKY_SCALE) {
  const sunUp = Math.max(-1, Math.min(1, sunDir.y));
  const sunE = SUN_EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(sunUp)) / STEEPNESS)));
  // Sky.js feeds a unit sun vector, so sunPosition.y / 450000 is ~0 and this
  // lands on 1. Kept in full anyway: it is what sets the final gamma.
  const sunfade = 1 - Math.min(1, Math.max(0, 1 - Math.exp(sunDir.y / 450000)));
  const rayleighCoefficient = atm.rayleigh - (1 - sunfade);
  const c = 0.2 * atm.turbidity * 1e-17;
  const betaR = [];
  const betaM = [];
  for (let i = 0; i < 3; i++) {
    betaR[i] = TOTAL_RAYLEIGH[i] * rayleighCoefficient;
    betaM[i] = 0.434 * c * MIE_CONST[i] * atm.mie;
  }
  return { sunE, sunfade, betaR, betaM, g: atm.mieG, sun: sunDir, scale };
}

// Linear radiance looking along (dx, dy, dz). The direction need not be
// normalised. `out` is reused when given, because the ring average below calls
// this a dozen times per preset.
function skyLook(st, dx, dy, dz, out = [0, 0, 0]) {
  const len = Math.hypot(dx, dy, dz) || 1;
  const x = dx / len;
  const y = dy / len;
  const z = dz / len;

  const zenithAngle = Math.acos(Math.max(0, y));
  const inv = 1 / (Math.cos(zenithAngle)
    + 0.15 * ((93.885 - (zenithAngle * 180) / Math.PI) ** -1.253));
  const sR = RAYLEIGH_ZENITH * inv;
  const sM = MIE_ZENITH * inv;

  const cosTheta = x * st.sun.x + y * st.sun.y + z * st.sun.z;
  const rPhase = THREE_OVER_16PI * (1 + (cosTheta * 0.5 + 0.5) ** 2);
  const g2 = st.g * st.g;
  const mPhase = ONE_OVER_4PI * ((1 - g2) / ((1 - 2 * st.g * cosTheta + g2) ** 1.5));
  // how much of the sky is looking straight down the barrel of a low sun
  const sunsetMix = Math.min(1, Math.max(0, (1 - st.sun.y) ** 5));
  const gamma = 1 / (1.2 + 1.2 * st.sunfade);

  for (let i = 0; i < 3; i++) {
    const fex = Math.exp(-(st.betaR[i] * sR + st.betaM[i] * sM));
    const scatter = st.sunE * ((st.betaR[i] * rPhase + st.betaM[i] * mPhase)
      / (st.betaR[i] + st.betaM[i]));
    let lin = (scatter * (1 - fex)) ** 1.5;
    lin *= 1 + (Math.sqrt(Math.max(0, scatter * fex)) - 1) * sunsetMix;
    const tex = (lin + 0.1 * fex) * 0.04 + NIGHT_BIAS[i];
    out[i] = (Math.max(0, tex) ** gamma) * st.scale;
  }
  return out;
}

// Public: linear sky radiance for a composed preset, so anything that needs to
// match the sky (fog, muzzle-flash falloff, a minimap backdrop) can ask for the
// real number instead of guessing a hex. Uses the preset's own sky scale.
export function skyRadiance(preset, dx, dy, dz, out = [0, 0, 0]) {
  const atm = (preset && preset.atm) || TIMES_OF_DAY.noon.atm;
  const dir = (preset && preset.sunDir) || { x: 0.53, y: 0.80, z: 0.27 };
  const scale = preset && Number.isFinite(preset.skyScale) ? preset.skyScale : SKY_SCALE;
  return skyLook(skyState(atm, dir, scale), dx, dy, dz, out);
}

// Cosine-weighted mean sky radiance (linear RGB) seen by a surface with
// normal n: E(n) / pi over the UPPER hemisphere only (the dome below the
// horizon is the ground, which the light block adds separately). Midpoint
// rule on a 24 x 48 (zenith x azimuth) grid; 0.3 % from a 64 x 128 grid.
function cosSkyRGB(st, nx, ny, nz) {
  const NT = 24;
  const NP = 48;
  const acc = [0, 0, 0];
  const tmp = [0, 0, 0];
  const dT = (Math.PI / 2) / NT;
  const dP = (Math.PI * 2) / NP;
  for (let i = 0; i < NT; i++) {
    const th = (i + 0.5) * dT;
    const s = Math.sin(th);
    const c = Math.cos(th);
    for (let j = 0; j < NP; j++) {
      const ph = (j + 0.5) * dP;
      const dx = s * Math.cos(ph);
      const dz = s * Math.sin(ph);
      const cw = dx * nx + c * ny + dz * nz;
      if (cw <= 0) continue;
      skyLook(st, dx, c, dz, tmp);
      const w = cw * s;
      acc[0] += tmp[0] * w;
      acc[1] += tmp[1] * w;
      acc[2] += tmp[2] * w;
    }
  }
  const k = (dT * dP) / Math.PI;
  return [acc[0] * k, acc[1] * k, acc[2] * k];
}

// What three r170 actually lights a diffuse surface with from the PMREM
// (wave 3c fix). getIBLIrradiance() is NOT the cosine-weighted mean of the
// environment: it reads textureCubeUV at roughness 1, i.e. mip -2, the last
// of PMREMGenerator's extra levels, whose blur is a spherical Gaussian of
// sigma 0.582 rad (EXTRA_LOD_SIGMA). That lobe is narrower than a cosine, so
// under a low sun a card facing the bright sunward horizon got ~25 % more
// image-based light than the cosine model said, and a horizontal one ~10 %
// less (measured in the browser on desert dusk: white card, IBL only, H 0.88-
// 0.94 x and V 1.18-1.29 x the cosine model; this lobe: within 1-3.5 %).
// Integrated over the WHOLE bake (sky above, the 2-degree blend, the lit
// ground below), returned as the lobe mean of the sky part and the lobe
// weight of the ground part (the ground is the light block's own output, so
// lightBlock() closes the loop).
export const PMREM_SIGMA = 0.582;
function bakeGroundT(y) {
  return 1 - smooth01((y + 0.035) / 0.035);
}
function pmremLobe(st, nx, ny, nz) {
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  // a tangent frame around n
  let ax = Math.abs(ny) < 0.9 ? 0 : 1;
  let ay = Math.abs(ny) < 0.9 ? 1 : 0;
  let az = 0;
  let t1x = ay * nz - az * ny;
  let t1y = az * nx - ax * nz;
  let t1z = ax * ny - ay * nx;
  const tl = Math.hypot(t1x, t1y, t1z) || 1;
  t1x /= tl; t1y /= tl; t1z /= tl;
  const t2x = ny * t1z - nz * t1y;
  const t2y = nz * t1x - nx * t1z;
  const t2z = nx * t1y - ny * t1x;
  const NT = 40;
  const NP = 48;
  const thMax = Math.min(Math.PI, 3.5 * PMREM_SIGMA);
  const dT = thMax / NT;
  const dP = (Math.PI * 2) / NP;
  const k2 = 1 / (2 * PMREM_SIGMA * PMREM_SIGMA);
  const sky = [0, 0, 0];
  const tmp = [0, 0, 0];
  let tw = 0;
  let wsum = 0;
  for (let i = 0; i < NT; i++) {
    const th = (i + 0.5) * dT;
    const s = Math.sin(th);
    const c = Math.cos(th);
    const w = Math.exp(-th * th * k2) * s;
    for (let j = 0; j < NP; j++) {
      const ph = (j + 0.5) * dP;
      const cp = Math.cos(ph) * s;
      const sp = Math.sin(ph) * s;
      const dx = nx * c + t1x * cp + t2x * sp;
      const dy = ny * c + t1y * cp + t2y * sp;
      const dz = nz * c + t1z * cp + t2z * sp;
      const t = bakeGroundT(dy);
      if (t < 1) {
        skyLook(st, dx, dy, dz, tmp);
        sky[0] += tmp[0] * (1 - t) * w;
        sky[1] += tmp[1] * (1 - t) * w;
        sky[2] += tmp[2] * (1 - t) * w;
      }
      tw += t * w;
      wsum += w;
    }
  }
  return { sky: sky.map((v) => v / wsum), ground: tw / wsum };
}

// ---------------------------------------------------------------------------
// Sun colour by elevation (L-03, art bible 4.5). Planckian locus (Kim et al.
// 2002) -> XYZ -> linear sRGB, normalised to a maximum of 1, so 6,500 K is
// close to white and a 6-degree sun is ~3,250 K (#ffbb75-ish), not the
// 2,400 K the old dusk hex was.
const CCT_KNOTS = [
  // elevation (deg), K
  [0, 2300], [2, 2600], [4, 2950], [5, 3080], [6, 3250], [7, 3480], [8, 3800],
  [10, 4000], [12, 4200], [15, 4450], [20, 4750], [25, 4950], [30, 5100],
  [40, 5330], [53.4, 5420], [60, 5480], [90, 5600],
];

export function sunCCT(elevDeg) {
  const e = Math.max(0, Math.min(90, elevDeg));
  for (let i = 1; i < CCT_KNOTS.length; i++) {
    const [e1, k1] = CCT_KNOTS[i];
    if (e <= e1) {
      const [e0, k0] = CCT_KNOTS[i - 1];
      return k0 + ((k1 - k0) * (e - e0)) / Math.max(1e-6, e1 - e0);
    }
  }
  return CCT_KNOTS[CCT_KNOTS.length - 1][1];
}

// Linear-sRGB colour of a Planckian radiator, max channel 1.
export function planckianLinear(K) {
  const T = Math.max(1667, Math.min(25000, K));
  const t = 1e3 / T;
  const x = T <= 4000
    ? -0.2661239 * t ** 3 - 0.2343589 * t ** 2 + 0.8776956 * t + 0.179910
    : -3.0258469 * t ** 3 + 2.1070379 * t ** 2 + 0.2226347 * t + 0.240390;
  let y;
  if (T <= 2222) y = -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683;
  else if (T <= 4000) y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
  const X = x / y;
  const Z = (1 - x - y) / y;
  const r = 3.2404542 * X - 1.5371385 - 0.4985314 * Z;
  const g = -0.9692660 * X + 1.8760108 + 0.0415560 * Z;
  const b = 0.0556434 * X - 0.2040259 + 1.0572252 * Z;
  const m = Math.max(r, g, b);
  return [Math.max(0, r / m), Math.max(0, g / m), Math.max(0, b / m)];
}

export function planckianHex(K) {
  return linearToHex(planckianLinear(K));
}

// McCamy (1992) CCT of a packed sRGB hex: the test the art bible uses.
export function mccamyCCT(hex) {
  const [r, g, b] = hexToLinear(hex);
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
  const s = X + Y + Z || 1;
  const n = (X / s - 0.3320) / (0.1858 - Y / s);
  return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
}

function srgbToLinear(byte) {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexToLinear(hex) {
  return [srgbToLinear((hex >> 16) & 255), srgbToLinear((hex >> 8) & 255), srgbToLinear(hex & 255)];
}

const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ---------------------------------------------------------------------------
// AgX, line for line with three r170 (tonemapping_pars_fragment), so the
// exposure can be solved on the CPU against the same curve the GPU applies.
const AGX_S2R = [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]];
const AGX_R2S = [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]];
const AGX_IN = [[0.856627153315983, 0.137318972929847, 0.11189821299995],
  [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
  [0.0482516061458583, 0.101439036467562, 0.811302368396859]];
const AGX_OUT = [[1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
  [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
  [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]];
// GLSL mat3(vec3 a, vec3 b, vec3 c) has a, b, c as COLUMNS
const colMul = (m, v) => [0, 1, 2].map((r) => m[0][r] * v[0] + m[1][r] * v[1] + m[2][r] * v[2]);
const agxCurve = (x) => {
  const x2 = x * x;
  const x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
};

// Linear scene RGB -> display-referred linear sRGB (before the sRGB encode).
export function agxToneMap(rgb, exposure = 1) {
  let v = colMul(AGX_IN, colMul(AGX_S2R, rgb.map((c) => c * exposure)));
  v = v.map((c) => Math.min(1, Math.max(0, (Math.log2(Math.max(c, 1e-10)) + 12.47393) / (4.026069 + 12.47393))));
  v = colMul(AGX_OUT, v.map(agxCurve)).map((c) => Math.max(0, c) ** 2.2);
  return colMul(AGX_R2S, v).map((c) => Math.min(1, Math.max(0, c)));
}

export function srgbByte(lin) {
  const x = Math.min(1, Math.max(0, lin));
  return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055) * 255);
}

// The exposure that renders a grey of scene radiance L to sRGB `target`.
export function solveAgXExposure(L, target = 125) {
  let lo = 0.02;
  let hi = 50;
  for (let i = 0; i < 48; i++) {
    const m = Math.sqrt(lo * hi);
    if (srgbByte(agxToneMap([L, L, L], m)[1]) < target) lo = m;
    else hi = m;
  }
  return Math.sqrt(lo * hi);
}

// ---------------------------------------------------------------------------
// The light block (contract R1-K). Everything a Lambert card sees under this
// preset's battle rig, in LINEAR, scene-referred radiance per unit albedo —
// the same numbers three r170 produces: a sun term E.cos/pi, a hemisphere
// term I.mix(ground, sky)/pi and an IBL term envIntensity x the cosine-
// weighted mean of the PMREM (getIBLIrradiance = pi.env, BRDF_Lambert = 1/pi).
// The PMREM's lower half is the lit ground (scenery.js bakes it that way,
// and the HDRIs carry a real one), so a vertical card gets half its IBL from
// the sky and half as ground bounce.
//
//   sunLin [r,g,b]   sun-normal card, sun term only
//   ambLin [r,g,b]   horizontal card in full shade (hemi + IBL)
//   whiteLitH        luminance of a white horizontal card in sun
//   whiteLitV        the same, vertical and facing the sun's azimuth
//   bloomThreshold   1.15 x 0.85 x max(whiteLitH, whiteLitV)  (L-05, C-28)
//   visibility       V_game, metres (C-31)
//   fogScaleHeight   metres (C-33)
// plus the rig the battle builds from it (read by scenery.js and nobody else
// needs them): exposure, skyScale, hemiIntensity, envIntensity, casterElev,
// groundLin, ratioH, ratioV, cards.
function lightBlock(o) {
  const sunRGB = hexToLinear(o.sunHex).map((c) => c * o.sunIntensity);
  const sunLin = sunRGB.map((c) => c / Math.PI);
  const casterY = Math.max(CASTER_FLOOR, o.sunDir.y);
  const casterH = Math.sqrt(Math.max(0, 1 - casterY * casterY));

  const hemiI = o.hemiIntensity * o.rig.hemi;
  const envI = o.envIntensity * o.rig.ibl;
  const hs = hexToLinear(o.hemiSky);
  const hg = hexToLinear(o.hemiGround);
  const flat = Math.hypot(o.sunDir.x, o.sunDir.z) || 1;
  const vx = o.sunDir.x / flat;
  const vz = o.sunDir.z / flat;

  // the cosine mean of the dome straight up: the HDRI's plain scale (PMREM
  // units, skyUpLin); the cards themselves are lit through the PMREM lobe
  const skyUp = cosSkyRGB(o.st, 0, 1, 0);
  const lobeUp = pmremLobe(o.st, 0, 1, 0);
  const lobeV = pmremLobe(o.st, vx, 0, vz);
  const ground = hexToLinear(o.groundHex);
  // The bake's ground is ground x litH (scene-referred; / envI in PMREM
  // units), and litH holds the IBL the up-lobe takes from that ground:
  //   ambH = hemi + envI.sky_up + w_up.ground.(sun.cy + ambH)
  const ambH = [0, 1, 2].map((i) => ((hs[i] * hemiI) / Math.PI + lobeUp.sky[i] * envI
    + lobeUp.ground * ground[i] * sunLin[i] * casterY) / Math.max(0.05, 1 - lobeUp.ground * ground[i]));
  const litH = [0, 1, 2].map((i) => sunLin[i] * casterY + ambH[i]);
  // the lit ground the lower half of the environment holds, scene-referred
  const groundLin = [0, 1, 2].map((i) => ground[i] * litH[i]);
  const ambV = [0, 1, 2].map((i) => ((hs[i] + hg[i]) * 0.5 * hemiI) / Math.PI
    + lobeV.sky[i] * envI + lobeV.ground * groundLin[i]);
  const litV = [0, 1, 2].map((i) => sunLin[i] * casterH + ambV[i]);

  const whiteLitH = lumOf(litH);
  const whiteLitV = lumOf(litV);
  const lowSun = o.sunDir.y < Math.sin(15 * DEG);
  const card = 0.18 * (lowSun ? whiteLitV : whiteLitH);
  const exposure = solveAgXExposure(card, lowSun ? 110 : 125);
  const frz = (a) => Object.freeze(a.map((c) => +c.toFixed(6)));
  return Object.freeze({
    sunLin: frz(sunLin),
    ambLin: frz(ambH),
    whiteLitH: +whiteLitH.toFixed(6),
    whiteLitV: +whiteLitV.toFixed(6),
    bloomThreshold: +(1.15 * 0.85 * Math.max(whiteLitH, whiteLitV)).toFixed(4),
    visibility: o.visibility,
    fogScaleHeight: FOG_SCALE_HEIGHT,
    // --- the rig itself (scenery.js) ---
    exposure: +exposure.toFixed(4),
    skyScale: o.skyScale,
    hemiIntensity: +hemiI.toFixed(5),
    envIntensity: +envI.toFixed(5),
    skyUpLin: frz(skyUp),            // PMREM units: cosine mean of the dome, n = up
    groundLin: frz(groundLin),
    ambVLin: frz(ambV),
    casterElev: Math.asin(casterY),
    lowSun,
    ratioH: +(whiteLitH / lumOf(ambH)).toFixed(3),
    ratioV: +(whiteLitV / lumOf(ambV)).toFixed(3),
  });
}

// ---------------------------------------------------------------------------
// HDRI calibrated to the light block (wave 3b fix).
//
// The light block above models the PROCEDURAL environment bake: the Preetham
// dome above the horizon, a uniform lit ground (groundLin / envIntensity)
// below it, blended over the last 2 degrees (scenery.js addSky, bake mode).
// The CC0 photographs that replace it as the image-based light distribute
// their light differently — a bright horizon ring, a dark or bright ground —
// and were matched to it in horizontal irradiance only: vertical and shaded
// cards then read up to +/-20 sRGB levels off the prediction (verifier), so
// the numbers X-01, S-01 and the L-07 grade are derived from did not describe
// the rendered world.
//
// So the bake keeps the photograph's SKY and takes the ground below the
// horizon from the light block, as the procedural bake does (the world under
// the vehicle is the battle's own terrain, not the photographer's field — a
// snow battle under a soil HDRI would otherwise be lit from brown ground):
//     env(d) = mix( g(d) . HDRI(d), groundLin / envIntensity, t(d.y) )
// t the bake's own 2-degree horizon blend. A Lambert surface's image-based
// light depends on the environment's spherical-harmonic bands 0-2 alone (the
// cosine lobe passes ~99 % of irradiance through them), so the sky gain
//     g(d) = exp( sum_j a_j . Y_j(d) )      (per channel, 9 coefficients)
// is solved (Newton) so the nine SH moments of env equal those of the
// procedural bake. Every normal then gets the light block's irradiance; what
// the photograph adds is its high-frequency part: clouds and skyline in the
// reflections.
//
// envBakeRadiance()  the procedural bake, linear, PMREM units (no envIntensity)
// envGroundOf()      its ground radiance (the bake's uGround)
// solveEnvGain()     the coefficients for one HDRI + preset + rotation
// ENV_GAIN_GLSL      vec3 ssEnvGain( vec3 dir ), reading uniform uEnvGain[9],
//                    and float ssEnvGroundMix( float dirY )
const SH_K = [0.282095, 0.488603, 1.092548, 0.315392, 0.546274];
function shBasis(x, y, z, out) {
  out[0] = SH_K[0];
  out[1] = SH_K[1] * y;
  out[2] = SH_K[1] * z;
  out[3] = SH_K[1] * x;
  out[4] = SH_K[2] * x * y;
  out[5] = SH_K[2] * y * z;
  out[6] = SH_K[3] * (3 * y * y - 1);
  out[7] = SH_K[2] * x * z;
  out[8] = SH_K[4] * (x * x - z * z);
  return out;
}

export const ENV_GAIN_GLSL = /* glsl */`
	uniform vec3 uEnvGain[ 9 ];
	vec3 ssEnvGain( vec3 d ) {
		vec3 a = uEnvGain[ 0 ] * ${SH_K[0].toFixed(6)}
			+ uEnvGain[ 1 ] * ( ${SH_K[1].toFixed(6)} * d.y )
			+ uEnvGain[ 2 ] * ( ${SH_K[1].toFixed(6)} * d.z )
			+ uEnvGain[ 3 ] * ( ${SH_K[1].toFixed(6)} * d.x )
			+ uEnvGain[ 4 ] * ( ${SH_K[2].toFixed(6)} * d.x * d.y )
			+ uEnvGain[ 5 ] * ( ${SH_K[2].toFixed(6)} * d.y * d.z )
			+ uEnvGain[ 6 ] * ( ${SH_K[3].toFixed(6)} * ( 3.0 * d.y * d.y - 1.0 ) )
			+ uEnvGain[ 7 ] * ( ${SH_K[2].toFixed(6)} * d.x * d.z )
			+ uEnvGain[ 8 ] * ( ${SH_K[4].toFixed(6)} * ( d.x * d.x - d.z * d.z ) );
		return exp( clamp( a, vec3( - 6.0 ), vec3( 6.0 ) ) );
	}
	float ssEnvGroundMix( float y ) {
		return 1.0 - smoothstep( - 0.035, 0.0, y );
	}
`;

// The procedural bake's ground below the horizon, in PMREM units.
export function envGroundOf(preset) {
  const L = preset && preset.light;
  return L && L.groundLin && L.envIntensity > 0
    ? [L.groundLin[0] / L.envIntensity, L.groundLin[1] / L.envIntensity, L.groundLin[2] / L.envIntensity]
    : [0.02, 0.02, 0.018];
}
const groundMix = (y) => 1 - smooth01((y + 0.035) / 0.035);

// The procedural bake's radiance along (x, y, z), linear, before envIntensity.
export function envBakeRadiance(preset, x, y, z, out = [0, 0, 0]) {
  skyRadiance(preset, x, y, z, out);
  const g = envGroundOf(preset);
  const len = Math.hypot(x, y, z) || 1;
  const t = groundMix(y / len);
  for (let i = 0; i < 3; i++) out[i] += (g[i] - out[i]) * t;
  return out;
}
function smooth01(u) {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  return t * t * (3 - 2 * t);
}

// IEEE half -> float
function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 5.960464477539063e-8;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

// An equirect image -> a GW x GH grid of cell means (row 0 = nadir, three's
// equirectUv with flipY false) and each cell's solid angle.
//   img: { width, height, data } with data a Uint16Array of RGBA halves (the
//   assets.js HDRI texture image) or a Float32Array of RGB / RGBA (channels).
function gridOf(img, GW, GH) {
  const W = img.width;
  const H = img.height;
  const data = img.data;
  const half = data instanceof Uint16Array;
  const ch = img.channels || (data.length >= W * H * 4 ? 4 : 3);
  const acc = new Float64Array(GW * GH * 3);
  const wsum = new Float64Array(GW * GH);
  for (let j = 0; j < H; j++) {
    const lat = ((j + 0.5) / H - 0.5) * Math.PI;
    const w = Math.cos(lat);
    const gj = Math.min(GH - 1, Math.floor(((j + 0.5) / H) * GH));
    for (let i = 0; i < W; i++) {
      const gi = Math.min(GW - 1, Math.floor(((i + 0.5) / W) * GW));
      const p = (j * W + i) * ch;
      let r = half ? halfToFloat(data[p]) : data[p];
      let g = half ? halfToFloat(data[p + 1]) : data[p + 1];
      let b = half ? halfToFloat(data[p + 2]) : data[p + 2];
      if (!(r >= 0 && r < 65504)) r = 0;
      if (!(g >= 0 && g < 65504)) g = 0;
      if (!(b >= 0 && b < 65504)) b = 0;
      const c = gj * GW + gi;
      acc[c * 3] += r * w;
      acc[c * 3 + 1] += g * w;
      acc[c * 3 + 2] += b * w;
      wsum[c] += w;
    }
  }
  const rgb = new Float64Array(GW * GH * 3);
  const omega = new Float64Array(GW * GH);
  for (let gj = 0; gj < GH; gj++) {
    const lat = ((gj + 0.5) / GH - 0.5) * Math.PI;
    const dOm = Math.cos(lat) * (Math.PI / GH) * ((2 * Math.PI) / GW);
    for (let gi = 0; gi < GW; gi++) {
      const c = gj * GW + gi;
      const k = wsum[c] > 0 ? 1 / wsum[c] : 0;
      rgb[c * 3] = acc[c * 3] * k;
      rgb[c * 3 + 1] = acc[c * 3 + 1] * k;
      rgb[c * 3 + 2] = acc[c * 3 + 2] * k;
      omega[c] = dOm;
    }
  }
  return { rgb, omega };
}

// Solve a 9x9 system in place (Gaussian elimination, partial pivoting).
function solve9(A, b) {
  const n = 9;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
    if (Math.abs(A[p * n + c]) < 1e-300) return false;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = t; }
      const t = b[c]; b[c] = b[p]; b[p] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * b[k];
    b[r] = s / A[r * n + r];
  }
  return true;
}

//   preset  a composed preset (its light block and sky)
//   img     the HDRI image (see gridOf)
//   rot     radians, the sphere's rotation (assets.js hdriRotationY)
//   scale   the plain scale the sphere already applies (light.skyUpLin lum.)
// -> { coeffs: [[r, g, b] x 9], ground: [r, g, b], gainMin, gainMax (over the
//      sky), residual, iterations }
//    coeffs all zero (gain 1) when the image is unusable.
export function solveEnvGain(preset, img, rot = 0, scale = 1, opts = {}) {
  const GW = opts.gridW || 64;
  const GH = opts.gridH || 32;
  const zero = () => ({ coeffs: Array.from({ length: 9 }, () => [0, 0, 0]), ground: envGroundOf(preset), gainMin: [1, 1, 1], gainMax: [1, 1, 1], residual: 1, iterations: 0 });
  if (!img || !img.data || !(img.width > 0) || !(img.height > 0)) return zero();
  const { rgb, omega } = gridOf(img, GW, GH);
  const N = GW * GH;
  const Y = new Float64Array(N * 9);
  const Lp = new Float64Array(N * 3);
  const skyW = new Float64Array(N);    // 1 - the ground blend
  const ground = envGroundOf(preset);
  const tmpY = new Float64Array(9);
  const tmpL = [0, 0, 0];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let gj = 0; gj < GH; gj++) {
    const lat = ((gj + 0.5) / GH - 0.5) * Math.PI;
    const hy = Math.sin(lat);
    const cl = Math.cos(lat);
    for (let gi = 0; gi < GW; gi++) {
      const phi = ((gi + 0.5) / GW - 0.5) * 2 * Math.PI;
      const hx = cl * Math.cos(phi);
      const hz = cl * Math.sin(phi);
      // the sphere samples the image at h = R_y(-rot) d  =>  d = R_y(rot) h
      const dx = hx * c + hz * s;
      const dz = -hx * s + hz * c;
      const k = gj * GW + gi;
      shBasis(dx, hy, dz, tmpY);
      for (let i = 0; i < 9; i++) Y[k * 9 + i] = tmpY[i];
      envBakeRadiance(preset, dx, hy, dz, tmpL);
      skyW[k] = 1 - groundMix(hy);
      Lp[k * 3] = tmpL[0];
      Lp[k * 3 + 1] = tmpL[1];
      Lp[k * 3 + 2] = tmpL[2];
    }
  }
  const coeffs = Array.from({ length: 9 }, () => [0, 0, 0]);
  const gainMin = [1, 1, 1];
  const gainMax = [1, 1, 1];
  let worst = 0;
  let iters = 0;
  const A = new Float64Array(81);
  const F = new Float64Array(9);
  const t = new Float64Array(9);
  const a = new Float64Array(9);
  const trial = new Float64Array(9);
  const g = new Float64Array(N);
  const moments = (coef, ch, out, J) => {
    out.fill(0);
    if (J) J.fill(0);
    for (let k = 0; k < N; k++) {
      let e = 0;
      for (let i = 0; i < 9; i++) e += coef[i] * Y[k * 9 + i];
      e = e > 6 ? 6 : e < -6 ? -6 : e;
      const v = Math.exp(e) * rgb[k * 3 + ch] * scale * skyW[k] * omega[k];
      g[k] = Math.exp(e);
      for (let i = 0; i < 9; i++) {
        const yi = Y[k * 9 + i] * v;
        out[i] += yi;
        if (J) for (let j = i; j < 9; j++) J[i * 9 + j] += yi * Y[k * 9 + j];
      }
    }
    if (J) for (let i = 0; i < 9; i++) for (let j = 0; j < i; j++) J[i * 9 + j] = J[j * 9 + i];
  };
  const norm = (v) => Math.sqrt(v.reduce((q, x) => q + x * x, 0));
  for (let ch = 0; ch < 3; ch++) {
    t.fill(0);
    // what the gained sky has to supply: the bake minus the ground it keeps
    for (let k = 0; k < N; k++) {
      const sky = Lp[k * 3 + ch] - (1 - skyW[k]) * ground[ch];
      for (let i = 0; i < 9; i++) t[i] += Y[k * 9 + i] * sky * omega[k];
    }
    a.fill(0);
    moments(a, ch, F, null);
    if (!(F[0] > 0) || !(t[0] > 0)) continue;
    a[0] = Math.log(t[0] / F[0]) / SH_K[0];
    const tn = norm(t);
    let res = Infinity;
    for (let it = 0; it < 30; it++) {
      moments(a, ch, F, A);
      for (let i = 0; i < 9; i++) F[i] -= t[i];
      res = norm(F) / tn;
      iters++;
      if (res < 1e-6) break;
      const d = Float64Array.from(F, (x) => -x);
      if (!solve9(A, d)) break;
      // damped: halve the step until the residual drops
      let step = 1;
      let ok = false;
      for (let h = 0; h < 8; h++) {
        for (let i = 0; i < 9; i++) trial[i] = a[i] + step * d[i];
        moments(trial, ch, F, null);
        for (let i = 0; i < 9; i++) F[i] -= t[i];
        if (norm(F) / tn < res) { ok = true; break; }
        step *= 0.5;
      }
      if (!ok) break;
      a.set(trial);
    }
    moments(a, ch, F, null);
    // the range over the sky only (the gain is not used under the ground)
    let lo = Infinity;
    let hi = 0;
    for (let k = 0; k < N; k++) {
      if (skyW[k] < 0.5) continue;
      if (g[k] < lo) lo = g[k];
      if (g[k] > hi) hi = g[k];
    }
    for (let i = 0; i < 9; i++) coeffs[i][ch] = a[i];
    gainMin[ch] = lo;
    gainMax[ch] = hi;
    for (let i = 0; i < 9; i++) F[i] -= t[i];
    worst = Math.max(worst, norm(F) / tn);
  }
  return { coeffs, ground, gainMin, gainMax, residual: worst, iterations: iters };
}

// Cached solve for the battle and the hangar (one per HDRI, preset, rotation
// and image size; ~20 ms each). `ok` is false when the photograph needs a gain
// beyond ENV_GAIN_LIMIT anywhere in its sky to carry the light block: such an
// HDRI does not fit the preset (an overcast photograph under a dawn sun) and
// the procedural bake stays the image-based light.
export const ENV_GAIN_LIMIT = 32;
const envGainCache = new Map();
export function envGainFor(preset, hdriId, img, rot = 0, scale = 1) {
  if (!preset || !img || !img.data) return null;
  const key = `${hdriId}|${preset.id}|${rot.toFixed(5)}|${scale.toFixed(6)}|${img.width}x${img.height}`;
  let r = envGainCache.get(key);
  if (!r) {
    const sol = solveEnvGain(preset, img, rot, scale);
    const hi = Math.max(...sol.gainMax);
    const lo = Math.min(...sol.gainMin);
    r = Object.freeze({ ...sol, ok: sol.residual < 1e-3 && hi <= ENV_GAIN_LIMIT && lo >= 1 / ENV_GAIN_LIMIT });
    if (envGainCache.size > 64) envGainCache.clear();
    envGainCache.set(key, r);
  }
  return r;
}

// The horizon is not one colour — it is bright toward the sun and deep away
// from it — so the fog takes the ring average, which is what a player panning
// the turret actually integrates.
function horizonRing(st, elevDeg = 2) {
  const y = Math.sin(elevDeg * DEG);
  const r = Math.cos(elevDeg * DEG);
  const acc = [0, 0, 0];
  const tmp = [0, 0, 0];
  const N = 12;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    skyLook(st, Math.cos(a) * r, y, Math.sin(a) * r, tmp);
    acc[0] += tmp[0];
    acc[1] += tmp[1];
    acc[2] += tmp[2];
  }
  return [acc[0] / N, acc[1] / N, acc[2] / N];
}

// Linear 0..1 triple -> packed sRGB hex, for the fields that are still ints.
function linearToHex(c) {
  const enc = (v) => {
    const x = Math.min(1, Math.max(0, v));
    const s = x <= 0.0031308 ? x * 12.92 : 1.055 * (x ** (1 / 2.4)) - 0.055;
    return Math.round(s * 255);
  };
  return (enc(c[0]) << 16) | (enc(c[1]) << 8) | enc(c[2]);
}

export { linearToHex as skyColorToHex };

function pickWeighted(entries, rng) {
  let total = 0;
  for (const e of entries) total += e.w;
  if (total <= 0) return entries[0].k;
  let r = rng() * total;
  for (const e of entries) {
    r -= e.w;
    if (r <= 0) return e.k;
  }
  return entries[entries.length - 1].k;
}

// ---------------------------------------------------------------------------
// A composed preset is a plain object carrying every field the old presets had
// (so buildTerrain and setupEnvironment keep working untouched) plus the light,
// fog and surface data the new systems read.
export function composePreset(biomeKey = 'meadow', todKey = 'noon', weatherKey = 'clear') {
  const biome = MAP_PRESETS[biomeKey] || MAP_PRESETS.meadow;
  const tod = TIMES_OF_DAY[todKey] || TIMES_OF_DAY.noon;
  const wx = WEATHERS[weatherKey] || WEATHERS.clear;

  const skyMixed = mixHex(mixHex(biome.sky, tod.skyTint, tod.skyMix), wx.skyTint, wx.skyMix);
  const fogMixed = mixHex(mixHex(biome.fog, tod.fogTint, tod.fogMix), wx.fogTint, wx.fogMix);

  // The ground palette carries the hour's colour cast as well, because vertex
  // colours are the only per-surface tint a Lambert material gives us for free.
  const gt = tod.groundTint;
  const gm = tod.groundMix;
  const snow = wx.snowCover;
  const tint = (c) => mixHex(mixHex(c, gt, gm), 0xe8eef4, snow * 0.55);

  const elev = tod.elev * DEG;
  const azim = tod.azim * DEG;
  const ce = Math.cos(elev);
  const sunDir = { x: ce * Math.sin(azim), y: Math.sin(elev), z: ce * Math.cos(azim) };

  const dust = Object.assign({}, biome.dust);
  if (snow > 0.2) {
    for (const k of Object.keys(dust)) dust[k] = mixHex(dust[k], 0xeef3f7, snow * 0.7);
  }

  // --- atmosphere: the hour's Preetham knobs, thickened by the weather -------
  const tatm = tod.atm || TIMES_OF_DAY.noon.atm;
  const atm = {
    turbidity: tatm.turbidity + (wx.turbidityAdd ?? 0),
    rayleigh: Math.max(0.15, tatm.rayleigh * (wx.rayleighMul ?? 1)),
    mie: tatm.mie * (wx.mieMul ?? 1),
    mieG: tatm.mieG,
  };
  // --- the battle rig (L-01): the grey-day hour lights from the whole dome,
  // otherwise the weather decides how much of the sky is ambient
  const rig = tod.rig || wx.rig || WEATHERS.clear.rig;
  const skyScale = SKY_SCALE * rig.sky;
  // --- the sun (L-03): colour from the elevation, luminance held per hour
  const sunHex = tod.sun != null ? tod.sun : planckianHex(sunCCT(tod.elev));
  const sunBase = tod.sunLum != null
    ? tod.sunLum / Math.max(1e-6, lumOf(hexToLinear(sunHex)))
    : tod.sunIntensity;
  const sunIntensity = sunBase * wx.sunMul;
  // Everything below is the sky evaluated, not the sky guessed. horizon is what
  // the fog has to be; zenith drives the hemisphere light's sky colour and the
  // ambient tint that survives when image-based lighting is unavailable.
  const st = skyState(atm, sunDir, skyScale);
  const horizon = horizonRing(st, 2);
  const zenith = skyLook(st, 0, 1, 0);
  const sunward = skyLook(st, sunDir.x, Math.max(0.03, sunDir.y * 0.35), sunDir.z);

  const tcl = tod.cloud || TIMES_OF_DAY.noon.cloud;
  const cloud = {
    cover: Math.min(0.97, tcl.cover + (wx.cloudAdd ?? 0)),
    lit: mixHex(tcl.lit, 0xffffff, snow * 0.3),
    dark: tcl.dark,
    height: tcl.height,
    opacity: wx.cloudOpacity ?? 0.85,
  };
  // S-01 cirrus: none under an overcast (weather or the grey-day hour), where
  // the deck and the grey dome already close the sky
  const ci = tod === TIMES_OF_DAY.overcast ? null : wx.cirrus;
  const cirrus = Object.freeze({
    cover: ci ? ci.cover : 0,
    tau: ci ? ci.tau : 0,
  });

  const groundBounce = mixHex(tint(biome.low), tint(biome.rock), 0.35);
  const hemiGround = mixHex(biome.hemiGround, 0xe8eef4, snow * 0.5);
  const visibility = Math.round((wx.visibilityKm ?? 25) * 1000 / FOG_COMPRESSION);
  const light = lightBlock({
    sunHex,
    sunIntensity,
    sunDir,
    hemiSky: tod.hemiSky,
    hemiGround,
    hemiIntensity: tod.hemiIntensity * wx.hemiMul,
    envIntensity: (tod.envIntensity ?? 0.7) * (wx.envMul ?? 1),
    rig,
    st,
    skyScale,
    groundHex: groundBounce,
    visibility,
  });

  return {
    // identity
    id: `${biomeKey}-${todKey}-${weatherKey}`,
    biome: biomeKey,
    todKey,
    weatherKey,
    name: biome.name,
    label: `${biome.name} · ${tod.name}${wx.precip === 'none' && weatherKey === 'clear' ? '' : ` · ${wx.name}`}`,
    // --- fields the existing code already reads ---
    low: tint(biome.low),
    high: tint(biome.high),
    rock: tint(biome.rock),
    sky: skyMixed,
    fog: fogMixed,
    trunk: biome.trunk,
    crown: mixHex(biome.crown, 0xe8eef4, snow * 0.45),
    rockCol: tint(biome.rockCol),
    hemiGround,
    treeFactor: biome.treeFactor,
    rockFactor: biome.rockFactor,
    // --- lighting ---
    sunColor: sunHex,
    sunIntensity,
    sunDir,
    sunElev: elev,
    hemiSky: tod.hemiSky,
    hemiIntensity: tod.hemiIntensity * wx.hemiMul,
    // --- atmosphere: multipliers, so a battle file's own fog distances stand ---
    fogNearMul: tod.fogNearMul * wx.fogNearMul,
    fogFarMul: tod.fogFarMul * wx.fogFarMul,
    precip: wx.precip,
    precipColor: mixHex(0xffffff, skyMixed, 0.25),
    // --- ground make-up, read by terrain.terrainSurface ---
    groundType: biome.groundType,
    hollowType: biome.hollowType,
    snowCover: snow,
    snowLine: biome.snowLine,
    gripMul: wx.gripMul,
    dust,
    // --- wind, for drifting smoke and swaying trees ---
    windStrength: biome.wind * wx.windMul,
    windDir: 0,   // filled in by randomPreset; a fixed preset blows down +X
    tod,
    weather: wx,

    // --- sky dome, image-based lighting and the drifting cloud deck ----------
    // ADDED, never replacing: `sky` and `fog` above still hold the flat hexes
    // the old renderer and ui/hangar3d.js read, so nothing that ignores these
    // fields changes behaviour.
    atm,                                   // turbidity / rayleigh / mie / mieG
    // linear (pre-tone-mapping) radiance, ready for Fog.color.setRGB(...)
    horizonRGB: horizon,
    zenithRGB: zenith,
    sunwardRGB: sunward,
    // the same three as packed sRGB ints, for anything still working in hex
    horizonHex: linearToHex(horizon),
    zenithHex: linearToHex(zenith),
    // the ground bounce the lower half of the sky dome fades to, so metal does
    // not reflect blue sky from underneath
    groundBounce,
    cloud,
    cirrus,
    // AgX exposure solved for the card (L-02); applyExposure() writes it
    exposure: light.exposure,
    // AUTHORED ambient level (hangar). The battle uses light.envIntensity.
    envIntensity: (tod.envIntensity ?? 0.7) * (wx.envMul ?? 1),
    // the dome / fog / PMREM scale this preset is drawn at (SKY_SCALE x rig.sky)
    skyScale,
    // contract R1-K: frozen, linear, scene-referred (see lightBlock)
    light,

    // --- land use, vegetation, buildings, ground cover (maps.md contract P) --
    // Passed through BY REFERENCE and untinted: these are albedo and layout
    // data, and the systems reading them apply snow and the hour themselves.
    // landUseFor() memoises on preset.biome, so the identity is stable too.
    landuse: biome.landuse,
    flora: biome.flora,
    architecture: biome.architecture,
    buildingPalette: biome.buildingPalette,
    grass: biome.grass,
    cropCols: biome.cropCols,
    rocks: biome.rocks,
  };
}

// The preset the current battle is fighting on. terrain.js needs it to know
// whether the ground under a track is sand, snow or grass, and it has no other
// way of being told without changing buildTerrain's signature.
let active = composePreset('meadow', 'noon', 'clear');

export function activePreset() {
  return active;
}

export function setActivePreset(preset) {
  if (preset && typeof preset === 'object') active = preset;
  return active;
}

// Roll a biome, an hour and the weather. Signature is unchanged — no argument
// gives a fully random map, exactly as before — and the result is registered as
// the active preset so terrain.js classifies its surfaces to match.
export function randomPreset(opts = {}) {
  // Test hook: set globalThis.__STEEL_SKIES_PRESET__ = { biome, tod, weather }
  // (any subset) in the console and the next battle is fought on it. Inert
  // unless set; the calibration screenshots are taken this way.
  const forced = typeof globalThis !== 'undefined' ? globalThis.__STEEL_SKIES_PRESET__ : null;
  if (forced && typeof forced === 'object') opts = { ...forced, ...opts };
  const rng = opts.rng || Math.random;
  const keys = Object.keys(MAP_PRESETS);
  const biomeKey = opts.biome && MAP_PRESETS[opts.biome]
    ? opts.biome
    : keys[Math.floor(rng() * keys.length)];

  const todKey = opts.tod && TIMES_OF_DAY[opts.tod]
    ? opts.tod
    : pickWeighted(Object.keys(TIMES_OF_DAY).map((k) => ({ k, w: TIMES_OF_DAY[k].weight })), rng);

  let weatherKey = opts.weather;
  if (!weatherKey || !WEATHERS[weatherKey]) {
    const bias = MAP_PRESETS[biomeKey].weather;
    const table = Object.keys(WEATHERS).map((k) => ({ k, w: bias[k] ?? 1 }));
    // a grey day is already overcast; do not also roll a clear sky under it
    if (todKey === 'overcast') {
      for (const e of table) if (e.k === 'clear') e.w = 0;
    }
    weatherKey = pickWeighted(table, rng);
  }

  const preset = composePreset(biomeKey, todKey, weatherKey);
  preset.windDir = rng() * Math.PI * 2;
  setActivePreset(preset);
  return preset;
}
