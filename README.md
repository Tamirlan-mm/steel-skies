# Steel Skies

An original browser game about WWII combined-arms combat: six tanks and five aircraft, a sloped-armour penetration model, crew roles, a velocity-vector flight model and positional audio. It is built with [three.js](https://threejs.org) and Vite and is plain JavaScript.

**Play:** the GitHub Pages build of this repository (Settings → Pages).

## Modes

- **Ground Assault**: tank battle for capture points.
- **Dogfight**: air battle with airfields, landing and rearming.
- **Combined Arms**: tanks and aircraft on one map.

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:5173. Use `npm run build` for a static build in `dist/`; it runs from any sub-path.

## Controls (defaults, rebindable in the hangar's SETTINGS)

- **Tank:** WASD to drive, mouse to aim, LMB to fire, Shift for the sniper view, 1/2/3 to pick the shell type.
- **Aircraft:** fly by mouse aim; A/D roll, W/S pitch, Q/E rudder, Shift/Ctrl throttle. G is the gear, V the flaps, Space drops a bomb, F fires a rocket.
- **Common:** M map, Tab scoreboard, Esc pause.

## Credits

- The vehicles are modelled in code.
- Textures and HDRIs come from [Poly Haven](https://polyhaven.com) and [ambientCG](https://ambientcg.com) (CC0).
- Sound effects come from Freesound, Kenney and US-Government recordings (CC0 / public domain).
- The full per-file list is in [`public/media/CREDITS.md`](public/media/CREDITS.md) and [`public/media/sfx/CREDITS.md`](public/media/sfx/CREDITS.md).

Vehicle names and markings are historical. Nothing in this project is taken from any other game.
