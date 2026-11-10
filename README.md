# HD2 Armor Inspector

Armor penetration and damage calculator for Helldivers 2, styled after the World of Tanks armor inspector.
Enemy hitzones and weapon stats come from https://helldivers.wiki.gg/.

**License note:** the wiki is licensed CC BY-NC-SA 4.0, so the files in `data/` are shared under the same license. Credit the wiki, keep the site non-commercial (no ads or paid features), and keep the data under that license.

## Running

| What | How |
|---|---|
| Quick look (no 3D) | Double-click `index.html` |
| Full site with 3D + saving | `node serve.js` then open http://localhost:8080 |
| After editing anything in `data/*.json` | `node build-data.js` |

## Features

- **Target / Weapon panels**: search and filter 104 enemies and 155 weapons (primaries, secondaries, throwables, support weapons, Eagles, orbitals, sentries).
- **Penetration view**: every hitzone coloured green (AP > AV, 100%), yellow-green (AP = AV, 65%), red (ricochet).
- **Impact angle**: weapons have four AP values (Direct 0–25°, Slight 26–60°, Large 61–80°, Extreme 81–90°). The 3D view colours every pixel by its real angle to the camera, like the tank inspector, and fire-mode clicks in 3D use the angle where you clicked. The body map and tables use the angle picked in the weapon card.
- **Shots-to-kill view**: hitzones coloured by how many shots kill through them.
- **Fire mode**: click hitzones to shoot one at a time; HP bars drop, and a KILLED / DOWNED banner shows when Main runs out or a fatal part is destroyed.
- **Best weapons vs target**: every weapon ranked for the selected enemy.
- **Copy link**: the URL stores enemy, weapon, mode and options.

## Adding your own 3D models

1. Extract the enemy model to `.glb`, e.g. with [filediver](https://github.com/xypwn/filediver).
2. Optional but recommended: open it in Blender, split it into separate objects per hitzone (Edit Mode → select faces → `P` → Selection) and name each object after the wiki part (`Head`, `Butt`, `Leg Flesh`…). Names that match a wiki part link automatically. Export as glTF Binary (`.glb`).
3. Save it as `models/<enemy-id>.glb`. The id is shown in the 3D view's empty state and in the URL (`#e=charger`). You can also use **Load .glb** in the 3D view; with `serve.js` running it is copied into `models/` for you.
4. Click **Edit hitzones**, click each mesh, and choose its wiki part from the dropdown. Hide LOD/shadow meshes with the checkbox. **Save mapping** writes `models/<enemy-id>.map.json`.

`node tools/make-test-glb.js` writes a box-built test Charger to `models/charger.glb`. It's tagged as a test model, so `build-data.js` never publishes it; overwrite it with a real model.

Extracted game assets belong to Arrowhead. Keep them local and don't redistribute them.

## Damage model

From the wiki's Damage page:
- `dealt = floor((damage × (1 − durable%) + durableDamage × durable%) × penMult)`, with penMult 1 / 0.65 / 0.
- Parts pass `dealt × %ToMain` to Main, capped at the part's remaining HP unless the part overflows.
- Explosions deal durable damage. ExDR moves that share from the part straight to Main.
- Death happens when Main reaches 0 or a fatal part is destroyed. Tanks use their Turret Main and Hull Main pools.

Not modelled: explosion falloff, bleed-out time, and limbs exposing flesh after their armor breaks. Expect a few percent error.
