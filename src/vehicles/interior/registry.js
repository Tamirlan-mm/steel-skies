// The per-vehicle interior registry (wave 6, interior framework).
//
// Kept apart from index.js on purpose: index.js eagerly imports every
// per-vehicle file (import.meta.glob), and every per-vehicle file imports
// defineTankInterior from HERE. Were the registry in index.js, the vehicle
// files would run before index.js's own body and hit the Map in its temporal
// dead zone.
//
// A per-vehicle file, src/vehicles/interior/<specId>.js:
//
//   import { defineTankInterior } from './registry.js';
//   export default defineTankInterior('sherman76', (spec, base) => ({
//     stations: { driver: { device: { type: 'periscope' } }, ... },
//     breech: { type: 'vertical', recoilLength: 0.30, ... },
//     layout: { racks: [...], seats: [...], radio: {...}, ... },
//     devices: { ... },
//     colors: { wall: 0xd8d2bf, ... },
//   }));
//
// `fn(spec, base)` gets the tank spec and the DEFAULTS the framework derived
// for it (index.js resolveTankInterior), and returns only what it wants to
// change; the result is deep-merged over the defaults (plain objects merge
// key by key, arrays and everything else replace). It may also be a plain
// object instead of a function.

const TANK_INTERIORS = new Map();

export function defineTankInterior(id, fn) {
  if (typeof id !== 'string' || !id) throw new Error('defineTankInterior: id must be a spec id');
  TANK_INTERIORS.set(id, fn);
  return { id, define: fn };
}

export function tankInteriorDefinition(id) {
  return TANK_INTERIORS.get(id) || null;
}

export function definedTankInteriors() {
  return [...TANK_INTERIORS.keys()];
}

// Deep merge for the override objects: plain objects merge, everything else
// (arrays, numbers, vectors written as arrays, null) replaces. `null` in the
// override REMOVES the key (e.g. `loader: null` drops a station).
export function mergeDef(base, over) {
  if (over === undefined) return base;
  if (!isPlain(base) || !isPlain(over)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    const v = over[k];
    if (v === null) delete out[k];
    else out[k] = mergeDef(base[k], v);
  }
  return out;
}

function isPlain(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
}
