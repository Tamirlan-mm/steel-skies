// Which map a ground battle (Ground Domination or Convoy) is fought on.
//
//   'country'  the open rolling country with its village (the map since wave 1)
//   'town'     the market town (world/town.js)
//   'random'   either: the town on TOWN_CHANCE of battles
//
// The hangar's MAP chips write the choice (kept in this browser only — it is a
// convenience, not progress); main.js reads it when it starts a ground battle.
// A battle built without a map (every headless harness) is on the country map,
// exactly as before. globalThis.__STEEL_SKIES_PRESET__ = { map: 'town' } forces
// the next battle's map the way it forces biome / tod / weather.

export const GROUND_MAPS = Object.freeze(['random', 'country', 'town']);
export const MAP_CHIP = Object.freeze({ random: 'RANDOM MAP', country: 'OPEN COUNTRY', town: 'TOWN' });
export const MAP_NAME = Object.freeze({ country: 'Open country', town: 'Market town' });
export const TOWN_CHANCE = 0.4;

const KEY = 'steelskies.groundMap';
let memory = 'random';

export function getMapChoice() {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    if (GROUND_MAPS.includes(v)) return v;
  } catch (e) {
    /* storage blocked: the session value */
  }
  return memory;
}

export function setMapChoice(v) {
  const c = GROUND_MAPS.includes(v) ? v : 'random';
  memory = c;
  try {
    globalThis.localStorage?.setItem(KEY, c);
  } catch (e) {
    /* this session only */
  }
  return c;
}

// The map this battle is actually fought on: 'country' | 'town'.
export function resolveMap(choice = 'country', rng = Math.random) {
  const forced = typeof globalThis !== 'undefined' ? globalThis.__STEEL_SKIES_PRESET__ : null;
  const f = forced && typeof forced === 'object' ? forced.map : null;
  if (f === 'town' || f === 'country') return f;
  if (choice === 'town' || choice === 'country') return choice;
  if (choice === 'random') return rng() < TOWN_CHANCE ? 'town' : 'country';
  return 'country';
}
