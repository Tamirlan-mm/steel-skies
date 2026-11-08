// The per-aircraft cockpit registry (wave 6, cockpit framework). Kept apart
// from index.js for the same reason as interior/registry.js: index.js eagerly
// imports every per-type file, and those files import from HERE.
//
// A per-type file, src/vehicles/cockpit/<specId>.js:
//
//   import { defineCockpit } from './registry.js';
//   export default defineCockpit('p51', (spec, base) => ({
//     eye: [0, 0.71, 0.45],
//     canopy: { arches: [...], bars: [...], sills: {...} },
//     panel: { z, y, w, h, tilt, instruments: [{ kind: 'ias', u, v, r }, ...] },
//     coaming: { ... },
//     gunsight: { type: 'k14', pos: [0, 0.62, 0.95], ... },
//     stick: { ... },
//     colors: { ... },
//   }));
//
// `fn(spec, base)` gets the plane spec and the framework's derived defaults
// (cockpit/index.js deriveCockpit) and returns what it changes; merged with
// interior/registry.js mergeDef (objects merge, arrays replace, null removes).

const COCKPITS = new Map();

export function defineCockpit(id, fn) {
  if (typeof id !== 'string' || !id) throw new Error('defineCockpit: id must be a plane spec id');
  COCKPITS.set(id, fn);
  return { id, define: fn };
}

export function cockpitDefinition(id) {
  return COCKPITS.get(id) || null;
}

export function definedCockpits() {
  return [...COCKPITS.keys()];
}
