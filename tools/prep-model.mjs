// Shrink a Filediver unit export for the web and write a starting hitzone map.
//
//   node tools/prep-model.mjs <enemy-id> [more ids...]      (sources are listed in SOURCES below)
//
// Output: models/<id>.glb (meshopt-compressed, textures ≤1024 px JPEG) and, unless one already exists,
// models/<id>.map.json with meshes pre-assigned from the game's part names. Damaged / gib variants
// start hidden so they don't overlap the intact pieces; check and fix the rest in the 3D editor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, textureCompress, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPORTS = process.env.HD2_UNITS || 'C:/Users/rjsta/Downloads/hd2-units';

// Charger family: same skeleton and part names
const CHARGER = [
  [/^head$/, 'Head'],
  [/^side_(left|right)$/, 'Torso Armor (2)'],
  [/^butt$/, 'Butt'],
  [/^claw_(left|right)$/, 'Claws (2)'],
  [/^(left|right)_front_leg$/, 'Front Leg Armor (2)'],
  [/^(left|right)_back_leg$/, 'Rear Leg Armor (2)'],
  // hidden until the plate above them breaks
  [/^side_(left|right)_damaged$/, 'Inner Flesh'],
  [/^(left|right)_(front|back)_leg_damaged$/, 'Leg Flesh (4)'],
  [/^head_damaged$/, 'Head'],
];

// Bile Titans: 3 armor plates per leg (inner, outer top, outer bottom); the tail is the butt armor
const BILE_TITAN = [
  [/^head$/, 'Head'],
  [/^torso$/, 'Torso Armor (2)'],
  [/^tail$/, 'Butt Armor'],
  [/^claw_(left|right)$/, 'Claws (2)'],
  [/^leg_(left|right)_(front|back)_(inner|outer_top|outer_bottom)$/, 'Leg Armor (12)'],
  [/^head_damaged$/, 'Head'],
];

// Automaton "soldier" body shared by the Devastators (intact pieces end in _whole)
const DEVASTATOR = [
  [/^head(_whole)?$/, 'Head'],
  [/^torso(_whole)?$/, 'Torso'],
  [/^hip(_whole)?$/, 'Pelvis'],
  [/^leg_(left|right)(_whole)?$/, 'Legs (2)'],
  [/^shoulder_(left|right)$/, 'Shoulders (2)'],
];

const SOURCES = {
  charger: { src: 'content/fac_bugs/cha_charger/cha_charger.unit.glb', rules: CHARGER },
  'charger-behemoth': { src: 'content/fac_bugs/cha_charger_bull/cha_charger_bull.unit.glb', rules: CHARGER },
  // the Rupture's front legs are its digging plates (Frontal Tarsal Plate Armor, AV5)
  'rupture-charger': { src: 'content/fac_bugs/cha_charger_burrower/cha_charger_burrower.unit.glb', rules: [[/^(left|right)_front_leg$/, 'Frontal Tarsal Plate Armor (2)'], ...CHARGER] },
  'caustic-charger': { src: 'content/fac_bugs/cha_charger_acid/cha_charger_acid.unit.glb', rules: [[/_blob$/, 'Spore Flesh (6)'], ...CHARGER] },
  'bile-titan': { src: 'content/fac_bugs/cha_strider/cha_strider.unit.glb', rules: BILE_TITAN },
  'spore-burst-bile-titan': { src: 'content/fac_bugs/cha_strider/cha_strider_gloom.unit.glb', rules: BILE_TITAN },
  impaler: {
    src: 'content/fac_bugs/cha_impaler/cha_impaler.unit.glb',
    rules: [
      [/^head$/, 'Head'],
      [/^head_shield$/, 'Crest Armor'],
      [/^(left|middle|right)_tentacle$/, 'Tentacle Armor (3)'],
      [/^torso$/, 'Torso Armor (2)'],
      [/^leg_(left|right)_(front|back)$/, 'Leg Armor (4)'],
      [/^leg_(left|right)_(front|back)_damaged$/, 'Leg Flesh (4)'],
      [/^tail$/, 'Rear Armor Plates'],
      [/^tail_damaged$/, 'Butt'],
    ],
  },
  dragonroach: {
    src: 'content/fac_bugs/cha_dragon/cha_dragon.unit.glb',
    rules: [
      [/^head(_whole)?$/, 'Head'],
      [/^claw_(left|right)(_whole)?$/, 'Claws (2)'],
      [/^body_(left|right)(_whole)?$/, 'Carapace (2)'],
      [/^stomach(_whole)?$/, 'Abdomen Armor'],
      [/^stomach_damaged$/, 'Abdomen Innards'],
    ],
  },
  devastator: { src: 'content/fac_cyborgs/cha_soldier/cha_soldier.unit.glb', rules: DEVASTATOR },
  'heavy-devastator': { src: 'content/fac_cyborgs/cha_soldier/cha_soldier_heavy_weapon.unit.glb', rules: [[/^weapon_backpack(_whole)?$/, 'Backpack'], ...DEVASTATOR] },
  'rocket-devastator': { src: 'content/fac_cyborgs/cha_soldier/cha_soldier_rocket.unit.glb', rules: [[/^backpack_rockets$/, 'Rockets'], [/^rocket_pods(_whole)?$/, 'Rocket Pods'], ...DEVASTATOR] },
  berserker: {
    src: 'content/fac_cyborgs/cha_berserker/cha_berserker.unit.glb',
    rules: [[/^head(_whole)?$/, 'Head'], [/^torso(_whole)?$/, 'Chest'], [/^hip(_whole)?$/, 'Pelvis'], [/^leg_(left|right)(_whole)?$/, 'Leg (2)']],
  },
  commissar: {
    src: 'content/fac_cyborgs/cha_lieutenant/cha_lieutenant.unit.glb',
    rules: [[/^arm_(left|right)$/, 'Arms (2)'], [/^leg_(left|right)$/, 'Legs (2)'], [/^(chest|torso|back)$/, 'Torso']],
  },
  agitator: {
    src: 'content/fac_cyborgs/cha_cyborg_elite/cha_cyborg_elite_rusher.unit.glb',
    rules: [
      [/^armor_head$/, 'Helmet'],
      [/^armor_torso$/, 'Torso Armor'],
      [/^head(_whole)?$/, 'Head'],
      [/^body(_whole)?$/, 'Torso'],
      [/^(left|right)_shoulderpad$/, 'Pauldrons (2)'],
      [/^(left|right)_arm(_whole)?$/, 'Upper Arms (2)'],
    ],
  },
};

const DROP = /shadow|collision|culling|_lod[1-9]\b|LOD[1-9]$/i;          // not needed on the web
const HIDE = /_(damaged|gibs?|destroyed|hurt|split|stump|gore\w*)($|_)/i;  // alternate states of a piece ("torso_destroyed_lower" too)
const clean = (name) => (name || '').replace(/^g_\S*\s+/, '').trim() || name;

async function prep(id) {
  const cfg = SOURCES[id];
  if (!cfg) throw new Error(`No source listed for "${id}" in tools/prep-model.mjs`);
  const src = path.join(EXPORTS, cfg.src);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.read(src);
  const root = doc.getRoot();

  const names = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (DROP.test(node.getName())) { node.dispose(); continue; }
    const n = clean(node.getName());
    node.setName(n);
    mesh.setName(n);
    names.push(n);
  }
  for (const a of root.listAnimations()) a.dispose();

  await doc.transform(
    prune(),
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'jpeg', resize: [1024, 1024], quality: 80 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  root.listAssets?.();
  doc.getRoot().getAsset().generator = 'hd2-armor tools/prep-model.mjs';

  const out = path.join(ROOT, 'models', `${id}.glb`);
  await io.write(out, doc);

  const mapPath = path.join(ROOT, 'models', `${id}.map.json`);
  let note = 'kept existing map';
  if (!fs.existsSync(mapPath)) {
    const map = { enemy: id, meshes: {}, hidden: [] };
    for (const n of names) {
      const rule = cfg.rules.find(([re]) => re.test(n));
      if (rule) map.meshes[n] = rule[1];
      if (HIDE.test(n)) map.hidden.push(n);
    }
    fs.writeFileSync(mapPath, JSON.stringify(map, null, 2) + '\n');
    const unassigned = names.filter((n) => !map.meshes[n] && !map.hidden.includes(n));
    note = `map: ${Object.keys(map.meshes).length} assigned, ${map.hidden.length} hidden, unassigned: ${unassigned.join(', ') || 'none'}`;
  }
  const mb = (f) => (fs.statSync(f).size / 1048576).toFixed(1);
  console.log(`${id}: ${mb(src)} MB → ${mb(out)} MB, ${names.length} meshes; ${note}`);
}

const ids = process.argv.slice(2);
if (!ids.length) { console.log(`usage: node tools/prep-model.mjs <id>...\nknown: ${Object.keys(SOURCES).join(', ')}`); process.exit(1); }
for (const id of ids) await prep(id);
