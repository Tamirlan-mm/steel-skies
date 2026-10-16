# Steel Skies — sound effect credits

Every recording in this folder is either **CC0 1.0** (public domain dedication) or a
**public-domain US Government work** re-published under CC0. No attribution is legally
required for any of them; the authors are credited here anyway, with thanks.
Nothing here comes from a commercial game or another game's files.

Retrieval: Freesound sounds were taken from Freesound's public HQ preview (128 kbps MP3,
downloadable without an account) after checking on each sound's own page that its licence
is CC0. A CC0 tag on Freesound is the uploader's own statement; where a page gave reason to
doubt it the sound was replaced (see "Replaced" below). Kenney assets come from the official
pack download on kenney.nl (CC0, licence file inside the pack).

## Processing

- **All files:** trimmed, high-passed (25–60 Hz), summed to mono, 44.1 kHz MP3.
  Because the Freesound sources are themselves 128 kbps previews, every file is a second
  lossy generation; one-shots are encoded at 128 kbps CBR from float masters to keep that
  loss small, loops at 96 kbps, ambience beds at 64 kbps.
- **True peak:** ≤ -1.0 dBTP on every file, measured on the encoded MP3 with ffmpeg
  `ebur128=peak=true` (worst file: -1.0 dBTP).
- **One-shots are loudness-matched within each family.** Short transients cannot be
  measured with gated integrated LUFS (most are under 0.4 s), so each take is measured
  with a K-weighted short-term figure: the mean of its loudest 100 ms and 200 ms windows
  (unpadded and padded) and its loudest 400 ms window. Every take of a family is set to the
  same value (family spread ≤ 0.1 LU on that figure; ≤ 2.2 LU on any single window length),
  so a randomly picked take never jumps out or drops away. Each family's level is the
  loudest its peakiest take allows under the -1 dBTP ceiling, so families sit at different
  file levels; the per-family gains in `SG` (`src/core/audio.js`) set the in-game balance.

  | Family (code bank) | Takes | Level (K-weighted short-term, LUFS) |
  |---|---|---|
  | cannon_near | cannon_near_1…4 | -13.3 |
  | cannon_far | cannon_far_1…3 | -15.7 |
  | mg | mg_1…4 | -14.5 |
  | explosion | explosion_1, explosion_2 | -16.0 |
  | bomb | bomb_1…3 | -13.1 |
  | clang | clang_1…4 | -22.1 |
  | pen | pen_1…3 | -20.4 |
  | ricochet | ricochet_1…4 | -21.5 |
  | crack | whiz_1, whiz_3 | -16.0 |
  | whiz | whiz_2 | -13.5 |
  | breech | breech_1…3 | -19.5 |

  The hit families (clang, pen, ricochet) sit low because some of their takes are
  10–20 ms metallic clicks with a very high crest factor.
- **Loops:** engine loops -18 LUFS integrated, ambience beds -22…-28 LUFS integrated.
  Loops were cut from the steadiest stretch of the source, crossfaded at the loop point,
  and carry 4096 samples of circular padding on both ends (loop region = 0.09288 s … loop end,
  see `SAMPLE_LOOPS` in `src/core/audio.js`) so they loop seamlessly whatever MP3 decoder plays them.

Build scripts and the processing manifest live outside the repo (audio lane scratchpad).

## Sources

| File(s) | Source title | Author | Source URL | Licence | Notes |
|---|---|---|---|---|---|
| tank_idle, tank_run | tank_engine.wav | monosfera | https://freesound.org/people/monosfera/sounds/572294/ | CC0 1.0 | idle loop from 15.4 s, revved loop from 44.7 s |
| tank_tracks | t26_moving_01.wav (Soviet T-26 light tank moving) | greatmganga | https://freesound.org/people/greatmganga/sounds/329800/ | CC0 1.0 | engine + tracks, loop from 1.7 s |
| plane_prop | Airplane inside ambient - cessna 414. condenser .mp3 | Daveshu88 | https://freesound.org/people/Daveshu88/sounds/325845/ | CC0 1.0 | steady piston drone at cruise, loop from 1.0 s |
| plane_exhaust | merlin engine.wav (Rolls-Royce Merlin on a static display) | squashy555 | https://freesound.org/people/squashy555/sounds/276597/ | CC0 1.0 | exhaust crackle, loop from 52.6 s |
| amb_wind | Strong wind | lextrack | https://freesound.org/people/lextrack/sounds/344887/ | CC0 1.0 | loop from 4.5 s |
| amb_battle | Gunfire | qubodup | https://freesound.org/people/qubodup/sounds/205588/ | CC0 1.0 (US Government video, public domain) | low-passed 1.1 kHz, echoes + levelled to read as a distant battle |
| cannon_near_1, cannon_near_2 | Tank Shots | qubodup | https://freesound.org/people/qubodup/sounds/239135/ | CC0 1.0 (US Government video, public domain) | shots at 3.49 s and 8.59 s |
| cannon_near_3 | Cannon Shot | qubodup | https://freesound.org/people/qubodup/sounds/187767/ | CC0 1.0 (US Government video, public domain) | second shot |
| cannon_near_4 | Artillery Gunfire | qubodup | https://freesound.org/people/qubodup/sounds/239137/ | CC0 1.0 (US Government video, public domain) | first shot |
| cannon_far_1…3 | Distant Tank Shots | qubodup | https://freesound.org/people/qubodup/sounds/184275/ | CC0 1.0 (US Government video, public domain) | three distant reports |
| mg_1, mg_2, mg_3 | 50 Cal MG | qubodup | https://freesound.org/people/qubodup/sounds/239138/ | CC0 1.0 (US Government video, public domain) | single rounds cut from two bursts |
| mg_4 | 50 Caliber MG | qubodup | https://freesound.org/people/qubodup/sounds/183656/ | CC0 1.0 (US Government video, public domain) | last round of a burst |
| explosion_1 | Explosion | qubodup | https://freesound.org/people/qubodup/sounds/182429/ | CC0 1.0 (US Government video, public domain) | |
| explosion_2 | Explosive 1 v1 [DOD 130303] | qubodup | https://freesound.org/people/qubodup/sounds/182432/ | CC0 1.0 (US DoD video, public domain) | |
| bomb_1 | Explosion with debris - authentic. 4kg TNT (land-mine demolition) | sidohzen | https://freesound.org/people/sidohzen/sounds/165808/ | CC0 1.0 | main blast from 2.17 s |
| bomb_2, bomb_3 | Artillery Shots | qubodup | https://freesound.org/people/qubodup/sounds/182822/ | CC0 1.0 (US Government videos, public domain) | two heavy howitzer reports, from 7.39 s and 38.60 s |
| clang_1 | Anvil - Lokomo 125 kg - Hammer on 6mm steel 1 time short | ldezem | https://freesound.org/people/ldezem/sounds/386130/ | CC0 1.0 | |
| clang_2 | Metal Plate Hit 6 | loganzsound | https://freesound.org/people/loganzsound/sounds/784157/ | CC0 1.0 | |
| clang_3 | Anvil Hit 2 | michorvath | https://freesound.org/people/michorvath/sounds/270588/ | CC0 1.0 | |
| clang_4 | Impact Sounds pack: impactPlate_heavy_002 | Kenney (kenney.nl) | https://kenney.nl/assets/impact-sounds | CC0 1.0 | |
| pen_1 | Debris Falling on Tank 1 (debris on 1/4" steel plate) | Richard27 | https://freesound.org/people/Richard27/sounds/530209/ | CC0 1.0 | third impact |
| pen_2 | novasound400.wav (high-speed bullet hitting 1 cm steel plate) | vumseplutten1709 | https://freesound.org/people/vumseplutten1709/sounds/372185/ | CC0 1.0 | impact at 28.97 s |
| pen_3 | Impact Sounds pack: impactMetal_heavy_001 | Kenney (kenney.nl) | https://kenney.nl/assets/impact-sounds | CC0 1.0 | |
| ricochet_1, ricochet_2 | incoming Ricochets .wav | rakurka | https://freesound.org/people/rakurka/sounds/187533/ | CC0 1.0 | |
| ricochet_3, ricochet_4 | ricochet.mp3 | cedarstudios | https://freesound.org/people/cedarstudios/sounds/148840/ | CC0 1.0 | |
| whiz_1, whiz_3 | Real Steel Chain-whip (Multiple cracks) | modusmogulus | https://freesound.org/people/modusmogulus/sounds/791469/ | CC0 1.0 | a whip crack is a real small sonic boom; used as the supersonic round's crack |
| whiz_2 | Fly-by whiz SFX (subsonic) | modusmogulus | https://freesound.org/people/modusmogulus/sounds/789222/ | CC0 1.0 | |
| breech_1, breech_2, breech_3 | Impact Sounds pack: impactPlate_heavy_001, _003, _004 | Kenney (kenney.nl) | https://kenney.nl/assets/impact-sounds | CC0 1.0 | the breech slamming shut when the gun has reloaded; played pitched down |

## Replaced

- **plane_prop** was previously cut from "Prop Plane" by Mozfoo
  (https://freesound.org/people/Mozfoo/sounds/440163/, tagged CC0). A comment on that page
  links, without explanation, to a track of the commercial Sound Ideas library, so the upload
  may not be the uploader's own recording. It was replaced on 2026-10-15 and is no longer used.

Licence texts: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/ ·
Kenney licence — "Creative Commons Zero, CC0" (License.txt in the pack).
