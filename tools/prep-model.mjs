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
import { prune, dedup, textureCompress, meshopt, mergeDocuments, unpartition } from '@gltf-transform/functions';
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

// Hulk body (internally "lieutenant"); the eye (Head) has no mesh of its own, assign it in the editor
const HULK = [
  [/^arm_(left|right)$/, 'Arms (2)'],
  [/^leg_(left|right)$/, 'Legs (2)'],
  [/^back$/, 'Heatsink'],
  [/^(chest|torso)$/, 'Main'],
];

// Gear that's a separate model in the game, merged onto the body's attachment bone.
// name: the mesh name in the result (and in the map); part: the hitzone it gets, if any.
const W = 'content/fac_cyborgs/equipment/';
const GEAR = {
  rifle: W + 'weapons/soldier_standard_rifle/soldier_standard_rifle.unit.glb',
  machinegun: W + 'weapons/soldier_machinegun/soldier_machinegun.unit.glb',
  shield: W + 'weapons/soldier_shield/soldier_shield.unit.glb',
  chainsaw: W + 'weapons/soldier_chainsaw/soldier_chainsaw.unit.glb',
  hulkCannon: W + 'weapons/lieutenant_cannon/lieutenant_cannon.unit.glb',
  hulkLauncher: W + 'weapons/lieutenant_launcher/lieutenant_launcher.unit.glb',
  hulkSaw: W + 'weapons/lieutenant_saw/lieutenant_saw.unit.glb',
  hulkJetpack: W + 'backpacks/lieutenant_jetpack/lieutenant_jetpack.unit.glb',
};
const LOADOUT = {
  devastator: [{ src: GEAR.rifle, bone: 'attach_r_hand', name: 'weapon_right' }],
  'heavy-devastator': [{ src: GEAR.machinegun, bone: 'attach_r_hand', name: 'weapon_right' }, { src: GEAR.shield, bone: 'attach_shield', name: 'shield', part: 'Shield' }],
  berserker: [{ src: GEAR.chainsaw, bone: 'attach_l_hand', name: 'chainsaw_left', part: 'Arm (2)' }, { src: GEAR.chainsaw, bone: 'attach_r_hand', name: 'chainsaw_right', part: 'Arm (2)' }],
  'hulk-bruiser': [{ src: GEAR.hulkCannon, bone: 'r_hand_attach', name: 'weapon_right', part: 'Arms (2)' }, { src: GEAR.hulkLauncher, bone: 'l_hand_attach', name: 'weapon_left', part: 'Arms (2)' }],
  'hulk-scorcher': [{ src: GEAR.hulkSaw, bone: 'l_hand_attach', name: 'weapon_left', part: 'Arms (2)' }],
};
LOADOUT['jet-brigade-hulk-bruiser'] = [...LOADOUT['hulk-bruiser'], { src: GEAR.hulkJetpack, bone: 'attach_backpack_socket', name: 'jetpack', part: 'Jetpack' }];
LOADOUT['jet-brigade-hulk-scorcher'] = [...LOADOUT['hulk-scorcher'], { src: GEAR.hulkJetpack, bone: 'attach_backpack_socket', name: 'jetpack', part: 'Jetpack' }];

// 4×4 column-major helpers for placing gear
function mat4Invert(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det, (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det, (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det, (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det, (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ];
}
function mat4Mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const isUnder = (n, anc) => { for (let p = n.getParentNode(); p; p = p.getParentNode()) if (p === anc) return true; return false; };

// Illuminate
const VOTELESS = [
  [/^head(_whole)?$/, 'Head'],
  [/^arm_(left|right)(_whole)?$/, 'Upper Arms (2)'],
  [/^leg_(left|right)(_whole)?$/, 'Legs'],
  [/^body(_whole)?$/, 'Main'],
];
const OVERSEER = [
  [/^head(_jet)?$/, 'Head'],
  [/^torso$/, 'Chest Armor'],
  [/^hip$/, 'Crotch Armor'],
  [/^(arm|leg)_(left|right)_(upper|lower)_armor$/, 'Limb Armor (8)'],
  [/^arm_right(_(upper|lower|whole))?$/, 'Right Arm'],
  [/^arm_left(_(upper|lower|whole))?$/, 'Left Arm'],
  [/^leg_(left|right)(_(upper|lower|whole))?$/, 'Legs (2)'],
  [/^jetpack$/, 'Jetpack'],
];
// the Elevated / Crescent Overseer list their limb plates as one "Limb Armor" hitzone
const OVERSEER_1 = OVERSEER.map(([re, p]) => [re, p === 'Limb Armor (8)' ? 'Limb Armor' : p]);
const IL = 'content/fac_illuminate/';

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
  // 'lieutenant' is the game's internal name for the Hulk; the Commissar is the conscript commander
  commissar: { src: 'content/fac_cyborgs/cha_conscript_commander/cha_conscript_commander.unit.glb', rules: [[/^head$/, 'Head'], [/^body$/, 'Torso']] },
  'hulk-bruiser': { src: 'content/fac_cyborgs/cha_lieutenant/cha_lieutenant.unit.glb', rules: HULK },
  'hulk-obliterator': { src: 'content/fac_cyborgs/cha_lieutenant/cha_lieutenant.unit.glb', rules: HULK },
  'hulk-firebomber': { src: 'content/fac_cyborgs/cha_lieutenant/cha_lieutenant.unit.glb', rules: HULK },
  'hulk-scorcher': { src: 'content/fac_cyborgs/cha_lieutenant_assault/cha_lieutenant_assault.unit.glb', rules: HULK },
  'jet-brigade-hulk-bruiser': { src: 'content/fac_cyborgs/cha_lieutenant/cha_lieutenant.unit.glb', rules: HULK },
  'jet-brigade-hulk-scorcher': { src: 'content/fac_cyborgs/cha_lieutenant/cha_lieutenant.unit.glb', rules: HULK },
  'light-voteless': { src: IL + 'cha_corrupted/cha_corrupted.unit.glb', rules: VOTELESS },
  'medium-voteless': { src: IL + 'cha_corrupted/cha_corrupted_v2.unit.glb', rules: VOTELESS },
  'heavy-voteless': { src: IL + 'cha_bodyhorror_helmetguy/cha_bodyhorror_helmetguy.unit.glb', rules: [[/^helmet(_whole)?$/, 'Head'], [/^generic(_whole)?$/, 'Main'], ...VOTELESS] },
  overseer: { src: IL + 'cha_illuminate_guy_staff/cha_illuminate_guy_staff.unit.glb', rules: OVERSEER },
  'elevated-overseer': { src: IL + 'cha_jet_champion/cha_jet_champion.unit.glb', rules: OVERSEER_1 },
  'crescent-overseer': { src: IL + 'cha_beamer_champion/cha_beamer_champion.unit.glb', rules: [[/^beamer_champion_pack/, 'Backpack'], ...OVERSEER_1] },
  watcher: {
    src: IL + 'cha_observer/cha_observer.unit.glb',
    rules: [[/^base$/, 'Body'], [/^eye(_whole)?$/, 'Eye'], [/^wing_top(_whole)?$/, 'Upper Fin'], [/^wing_bottom(_whole)?$/, 'Lower Fin'], [/^wing_(left|right)(_whole)?$/, 'Side Fins (2)']],
  },
  fleshmob: {
    src: IL + 'cha_meatglue/cha_meatglue.unit.glb',
    rules: [
      [/^(head|front_face|back_face|left_front_face|right_front_face)_mask$/, 'Head Chunks (6)'],
      [/^(stomach|lower_back)_mask$/, 'Stomach Chunks (2)'],
      [/^(left|right|upper_left|upper_right)_arm_mask$/, 'Arms (4)'],
      [/^(left|right)_leg_mask$/, 'Legs (2)'],
    ],
  },
  harvester: {
    src: IL + 'cha_tripod/cha_tripod.unit.glb',
    rules: [[/^body_(left|right)(_whole)?$/, 'Carapace (2)'], [/^body_front(_whole)?$/, 'Chassis']],
  },
  crusher: {
    src: IL + 'cha_exomech_melee/cha_exomech_melee.unit.glb',
    rules: [[/^cockpit(_whole)?$/, 'Helmet'], [/^pilot(_whole)?$/, 'Head'], [/^arm_(left|right)(_whole)?$/, 'Arms (2)'], [/^generic(_whole)?$/, 'Torso']],
  },
  wretch: {
    src: IL + 'cha_bodyhorror_bladed/cha_bodyhorror_bladed.unit.glb',
    rules: [[/^head(_whole)?$/, 'Head'], [/^arm_(left|right)(_whole)?$/, 'Arms (4)'], [/^leg_(left|right)(_whole)?$/, 'Legs (2)'], [/^generic(_whole)?$/, 'Main']],
  },
  leviathan: {
    src: IL + 'vehicles/illuminate_war_machine/illuminate_war_machine.unit.glb',
    rules: [
      [/^seg0_center(_whole)?$/, 'Front Vertebra'], [/^seg1_center(_whole)?$/, 'Forward-Middle Vertebra'],
      [/^seg2_center(_whole)?$/, 'Rearward-Middle Vertebra'], [/^seg3_center(_whole)?$/, 'Rear Vertebra'],
      [/^seg4(_whole)?$/, 'Tail'], [/^rotator(_whole)?$/, 'Warp Disc'],
    ],
  },
  stingray: { src: IL + 'vehicles/illuminate_attack_ship/illuminate_attack_ship.unit.glb', rules: [[/^g_ias$/, 'Main'], [/^ias$/, 'Main']] },
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
const HIDE = /_(damaged|gibs?|destroyed|hurt|split|stump|damage|gore\w*)($|_)/i;  // alternate states of a piece ("torso_destroyed_lower" too)
const clean = (name) => (name || '').replace(/^g_\S*\s+/, '').trim() || name;

async function prep(id) {
  const cfg = SOURCES[id];
  if (!cfg) throw new Error(`No source listed for "${id}" in tools/prep-model.mjs`);
  const src = path.join(EXPORTS, cfg.src);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.read(src);
  const root = doc.getRoot();

  // gear: merge each attachment model in and hang its content on the body's attachment bone
  const gearNames = [];
  for (const a of LOADOUT[id] || []) {
    const adoc = await io.read(path.join(EXPORTS, a.src));
    // keep the most detailed copy: some gear only ships a lower LOD (the Berserker chainsaw has just LOD1)
    const lodOf = (n) => +(/LOD(\d)$/i.exec(n.getName())?.[1] ?? 0);
    const meshes = adoc.getRoot().listNodes().filter((n) => n.getMesh() && !/shadow|collision|culling/i.test(n.getName()));
    const best = Math.min(...meshes.map(lodOf));
    for (const n of adoc.getRoot().listNodes()) {
      if (!n.getMesh()) continue;
      if (!meshes.includes(n) || lodOf(n) !== best) { n.dispose(); continue; }
      n.setName(a.name); n.getMesh().setName(a.name);
    }
    const aScene = adoc.getRoot().listScenes()[0];
    // its skeleton sits under its own axis-conversion node; the bone is already in the game's axes
    const conv = adoc.getRoot().listNodes().find((n) => /FbxAxisSystem/i.test(n.getName())) || aScene.listChildren()[0];
    // its meshes sit outside that node (in converted axes): note where they go relative to it
    const toConv = mat4Invert(conv.getWorldMatrix());
    // (skinned ones too: they follow their skeleton, but must stay in the scene)
    const loose = adoc.getRoot().listNodes().filter((n) => n.getMesh() && !isUnder(n, conv))
      .map((n) => ({ n, local: mat4Mul(toConv, n.getWorldMatrix()) }));
    const moved = mergeDocuments(doc, adoc);
    const bone = root.listNodes().find((n) => n.getName() === a.bone);
    if (!bone) { console.warn(`${id}: bone ${a.bone} not found; ${a.name} skipped`); moved.get(aScene)?.dispose(); continue; }
    const mConv = moved.get(conv);
    for (const child of mConv.listChildren()) { mConv.removeChild(child); bone.addChild(child); }
    for (const { n, local } of loose) {
      const m = moved.get(n);
      m.getParentNode()?.removeChild(m);
      m.setMatrix(local);
      bone.addChild(m);
    }
    moved.get(aScene).dispose();
    gearNames.push(a);
  }
  if (gearNames.length) doc.getRoot().listScenes().slice(1).forEach((sc) => sc.dispose());

  // keep the most detailed level present (the Overseers only ship LOD1: "g_champion_LOD1 head")
  const lodLevel = (n) => +(/LOD(\d)/i.exec(n) || [0, 0])[1];
  const bodyMeshes = root.listNodes().filter((n) => n.getMesh() && !/shadow|collision|culling/i.test(n.getName()) && !gearNames.some((g) => g.name === n.getName()));
  const bestLod = bodyMeshes.length ? Math.min(...bodyMeshes.map((n) => lodLevel(n.getName()))) : 0;
  const names = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const isGear = gearNames.some((g) => g.name === node.getName());
    if (!isGear && (/shadow|collision|culling/i.test(node.getName()) || lodLevel(node.getName()) !== bestLod)) { node.dispose(); continue; }
    const n = gearNames.some((a) => a.name === node.getName()) ? node.getName() : clean(node.getName());
    node.setName(n);
    mesh.setName(n);
    names.push(n);
  }
  for (const a of root.listAnimations()) a.dispose();

  await doc.transform(
    unpartition(), // merged gear brings its own buffer; a .glb holds one
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
  if (fs.existsSync(mapPath) && gearNames.length) {
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const added = [];
    for (const a of gearNames) if (a.part && !(a.name in map.meshes)) { map.meshes[a.name] = a.part; added.push(`${a.name} → ${a.part}`); }
    fs.writeFileSync(mapPath, JSON.stringify(map, null, 2) + '\n');
    note = `kept existing map${added.length ? '; added ' + added.join(', ') : ''}`;
  } else if (!fs.existsSync(mapPath)) {
    const map = { enemy: id, meshes: {}, hidden: [] };
    for (const n of names) {
      const rule = cfg.rules.find(([re]) => re.test(n));
      const gear = gearNames.find((a) => a.name === n && a.part);
      if (gear) map.meshes[n] = gear.part;
      else if (rule) map.meshes[n] = rule[1];
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
