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
- **Time-to-kill view**: hitzones coloured by time to kill. Guns use `(shots − 1) × 60 / RPM` with the first shot at 0 s, plus a full reload (from each weapon page's infobox, `data/reload.json`) for every magazine emptied: `reloads = ceil(shots / mag) − 1`. Weapons that load one round at a time (Punisher, Senator, Deadeye…) add one round's reload for every shot past the magazine instead. A * or "+reload" marks kills that need more than one magazine when the reload time is unknown. Fire mode's clock adds the reload too. Beams (Scythe, Laser Cannon…) apply their per-second damage in 0.1 s ticks. Flame and gas weapons use their burn/gas damage per second on Main health, which has to beat Main's armor. This underestimates flamethrowers, because flame particles on limbs aren't modelled.
- **Shot inspection (3D)**: click the model to place a shot. A ray is drawn from the camera to the impact point, and a panel shows the impact angle, AP vs AV, the result (penetrate / 65% / ricochet) and the damage. Change weapon, mode or range and the panel recomputes for the same spot.
- **Range**: the slider applies the wiki's drag falloff, `1 − 0.75 × (1 − e^(−2·D·x))` with `D ≈ 0.0004712389 × caliber² × Cd / mass`, to projectile damage. It starts at 20 m, and the body map, time to kill and both ranking tables all use it. Explosions and Eagle/orbital strikes aren't affected.
- **Charge weapons** (Epoch, Purifier, Railgun, Loyalist): a charge-time slider runs from the minimum charge to full charge. Projectile damage follows the wiki's charge multipliers (linear between the listed points), and the projectile and explosion switch at the wiki's charge thresholds. Time to kill includes the charge time of every shot. Settings are in `data/charge.json`.
- **Explosions**: a click with an explosive weapon draws the inner radius (translucent red) and the outer radius (orange, fading toward the edge). Every hitzone inside the blast takes falloff damage (quick `1 − x`, slow `1 − x²` for the 500kg), with AP −1 in the outer ring, and Main takes the redirected share only once per blast.
- **Fire mode**: click hitzones to shoot one at a time; HP bars drop, and a KILLED / DOWNED banner shows when Main runs out or a fatal part is destroyed.
- **Best weapons vs target**: every weapon ranked for the selected enemy on its best hitzone (best case).
- **Real life case**: for each weapon, the midpoint between the best case (fastest kill, weak points in reach) and the worst case (slowest kill, weak points missed). If the weapon can't damage some reachable hitzones at all, the worst case is 4× the best case's shots, timed with the same RPM and reload rule.
- **Copy link**: the URL stores enemy, weapon, mode and options.

## Adding your own 3D models

1. Extract the enemy model to `.glb`, e.g. with [filediver](https://github.com/xypwn/filediver).
2. Optional but recommended: open it in Blender, split it into separate objects per hitzone (Edit Mode → select faces → `P` → Selection) and name each object after the wiki part (`Head`, `Butt`, `Leg Flesh`…). Names that match a wiki part link automatically. Export as glTF Binary (`.glb`).
3. Save it as `models/<enemy-id>.glb`. The id is shown in the 3D view's empty state and in the URL (`#e=charger`). You can also use **Load .glb** in the 3D view; with `serve.js` running it is copied into `models/` for you.
4. Click **Edit hitzones**, click each mesh, and choose its wiki part from the dropdown. Hide LOD/shadow meshes with the checkbox. **Save mapping** writes `models/<enemy-id>.map.json`.

**Which game files the site's models came from:** [models/SOURCES.md](models/SOURCES.md) (and `models/sources.csv`) lists, for every enemy, the body unit (a `content/…` path or a `0x…` unit hash), the gear units hung on its bones with the hitzone each counts as, and the matching archive IDs. Regenerate it with `node tools/list-sources.mjs` after changing `tools/prep-model.mjs`.

`node tools/make-test-glb.js` writes a box-built test Charger to `models/charger.glb`. It's tagged as a test model, so `build-data.js` never publishes it; overwrite it with a real model.

**Game assets.** The 3D models in `models/` and the enemy and weapon images in `images/` were extracted from Helldivers 2. They are the property of Arrowhead Game Studios and Sony Interactive Entertainment. They are included only so this free, non-commercial fan tool can show them, and no ownership or license is claimed over them. They are not covered by this project's own license, and must not be reused for commercial purposes. If you are a rights holder and want anything removed, open an issue and it will be taken down. Donations (Buy Me a Coffee) only cover hosting costs; they don't pay for, and give no rights to, any game asset.

## Damage model

From the wiki's Damage page:
- `dealt = floor((damage × (1 − durable%) + durableDamage × durable%) × penMult)`, with penMult 1 / 0.65 / 0.
- Parts pass `dealt × %ToMain` to Main, capped at the part's remaining HP unless the part overflows.
- Explosions deal durable damage. ExDR moves that share from the part straight to Main.
- Death happens when Main reaches 0 or a fatal part is destroyed. Tanks use their Turret Main and Hull Main pools.

Not modelled: gravity drop and penetration slowdown, bleed-out time, and limbs exposing flesh after their armor breaks. Expect a few percent error.
