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
const CHARGER_BELLY = [{ mesh: 'body', name: 'body_underside', prim: /cha_charger/, box: [[-1.3, 1.0, -0.9], [1.3, 2.9, 1.7]] }];
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
// the abdomen: armor plates ("tail", Butt Armor) over the soft sac (Lower Sac); 0xf4fb223e is the burst sac.
// the torso: the soft body (Upper Sac) under the side plates (two hash meshes, 3 plates each) and a front plate;
// each side's wound mesh shows when that side's armor breaks
const BT_SAC = [[-0.6, 6.0, -1.6], [0.6, 7.4, 2.3]]; // the belly between the legs
const BT_BODY = {
  names: {
    // the flesh under a broken leg plate (Leg Flesh, AV4): a damaged stage, revealed and shootable
    ...Object.fromEntries(['left', 'right'].flatMap((x) => ['front', 'back'].flatMap((z) => ['inner', 'outer_top', 'outer_bottom']
      .map((p) => [`leg_${x}_${z}_${p}_gibs`, `leg_${x}_${z}_${p}_damaged`])))),
    '0x3f868f69': 'torso_left', '0x30fa360a': 'torso_right', torso_gibs_left: 'torso_left_damaged', torso_gibs_right: 'torso_right_damaged', torso_gibs: 'torso_burst' },
  shells: [
    { mesh: '0xf4fb223e', main: '0xf4fb223e', dropLike: 'tail' }, { mesh: 'tail', main: 'tail_sac', rest: 'tail', tipBones: /^spine_lower_4$/ },
    { mesh: 'torso', main: 'torso', rest: 'torso_{side}_plates', halves: true, softBox: BT_SAC }, // Torso Armor (2) is left and right
    // the burst upper sac: only the gore (blobs + the torn belly between the legs); its copy of the armor is dropped
    { mesh: 'torso_burst', main: 'torso_burst', keepPieces: true, softBox: BT_SAC },
  ],
};
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
// the eye: the box sticking out of the middle of the chest plate (the frame around it is armor)
const HULK_EYE = [{ mesh: 'chest', name: 'chest_eye', box: [[-0.17, 2.57, -0.74], [0.17, 2.89, -0.39]] },
  // the heat sink: only the 3x3 grid of vent squares on the back; the frame around it is armor (Main)
  { mesh: 'back', name: 'back', rest: 'back_plates', box: [[-0.48, 2.2, 0.5], [0.48, 3.32, 1.16]] }];
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
  // unnamed: muzzle, muzzle2, cables and a vent; only in the Hulk archives: the Scorcher's flamethrower
  hulkFlamer: 'extra/0x08886d27a6f6db8c.unit.glb',
};
// Automaton bones: head, arm_left/right, leg_left/right, the rest torso
const BOT_BONES = (bone) => {
  const b = bone.toLowerCase();
  if (/(^|_)(head|neck|eye)/.test(b)) return 'head';
  const side = /^(l_|attach_l_)/.test(b) ? 'left' : /^(r_|attach_r_)/.test(b) ? 'right' : '';
  if (side && /(shoulder|elbow|forearm|wrist|collar|finger|index|thumb|hand)/.test(b)) return `arm_${side}`;
  if (side && /(hip|leg|knee|ankle|foot|heel|toe)/.test(b)) return `leg_${side}`;
  return 'torso';
};
Object.assign(GEAR, {
  cLmg: W + 'weapons/conscript_lmg/conscript_lmg.unit.glb',
  cLmgPack: W + 'backpacks/conscript_backpack_lmg/conscript_backpack_lmg.unit.glb',
  cCannon: W + 'weapons/conscript_cannon/conscript_cannon.unit.glb',
  cFlamer: W + 'weapons/conscript_flamer/conscript_flamer.unit.glb',
  cJump: W + 'backpacks/conscript_jumppack/conscript_jumppack.unit.glb',
  sJump: W + 'backpacks/soldier_jumppack/soldier_jumppack.unit.glb',
  tankCannon: 'content/fac_cyborgs/turrets/cyborg_tank_turret_cannon/cyborg_tank_turret_cannon.unit.glb',
  tankAuto: 'content/fac_cyborgs/turrets/cyborg_tank_turret_autocannons/cyborg_tank_turret_autocannons.unit.glb',
  tankRockets: 'content/fac_cyborgs/turrets/cyborg_tank_turret_rocketlauncher/cyborg_tank_turret_rocketlauncher.unit.glb',
  tankMg: 'content/fac_cyborgs/turrets/cyborg_tank_hull_hmg/cyborg_tank_hull_mg.unit.glb',
  walkerCannon: 'content/fac_cyborgs/turrets/cyborg_big_walker_turret_cannon/cyborg_big_walker_turret_cannon.unit.glb',
});
// Scout Strider upper hulls and HMG: unnamed models from its archive (exported by hash into extra/)
const SCOUT_HMG = { src: 'extra/0x2a346bf4552997e2.unit.glb', bone: 'gun_pitch', name: 'hmg', part: 'HMG', offset: [0, 0, 0.3] }; // raised 0.3 m: the barrels come out through the gap in the front plate
// Factory Strider ("cyborg_big_walker_skeleton"): leg pieces by bone
const FS_BONES = (bone) => {
  const b = bone.toLowerCase();
  if (/knee_(front|back)_shield/.test(b)) return 'knee_armor';
  if (/leg_(hip|thigh)/.test(b)) return 'leg_armor';
  if (/leg_(knee|foot|toe)/.test(b)) return 'leg_assembly';
  if (/head/.test(b)) return 'head';
  if (/neck/.test(b)) return 'neck';
  return 'body';
};
const JUMP = { src: GEAR.cJump, bone: 'attach_backpack', name: 'jetpack', part: 'Jetpack' };
const LOADOUT = {
  'factory-strider': [
    { src: GEAR.tankCannon, bone: 'attach_turret', name: 'cannon_turret', part: 'Cannon Turret' },
    { src: 'extra/0x48c91e42b9f16512.unit.glb', bone: 'l_front_turret_attach', name: 'gatling_left', part: 'Fusion Gatling Guns (2)', roll: 'y' },
    { src: 'extra/0x48c91e42b9f16512.unit.glb', bone: 'r_front_turret_attach', name: 'gatling_right', part: 'Fusion Gatling Guns (2)', roll: 'y' },
  ],
  'vox-engine': [
    { src: GEAR.walkerCannon, bone: 'l_cannon_socket', name: 'cannon_left', part: 'Cannons (2)' }, { src: GEAR.walkerCannon, bone: 'r_cannon_socket', name: 'cannon_right', part: 'Cannons (2)' },
    // the miniguns: the Factory Strider's gatling turret on the gattling sockets
    { src: 'extra/0x48c91e42b9f16512.unit.glb', bone: 'l_gattling_socket', name: 'minigun_left', part: 'Miniguns (2)' },
    { src: 'extra/0x48c91e42b9f16512.unit.glb', bone: 'r_gattling_socket', name: 'minigun_right', part: 'Miniguns (2)' },
  ],
  'scout-strider': [{ src: 'extra/0xee00bfe8ff769f70.unit.glb', bone: 'turret', name: 'hull', part: 'Front Plate' }, SCOUT_HMG],
  'reinforced-scout-strider': [
    { src: 'extra/0xd3cd6f0ca83bb51e.unit.glb', bone: 'turret', name: 'hull', part: 'Faceplate' }, SCOUT_HMG,
    // rocket rails on the hull sides, rockets pointing forward (its four meshes are hash-named LODs: keep the best)
    { src: 'extra/0xe5b14182b25f7f7d.unit.glb', bone: 'turret', name: 'rail_left', part: 'Rocket Rails (2)', biggestOnly: true, offset: [-0.49, 0, 0.45] },
    { src: 'extra/0xe5b14182b25f7f7d.unit.glb', bone: 'turret', name: 'rail_right', part: 'Rocket Rails (2)', biggestOnly: true, offset: [0.51, 0, 0.45], roll: 'y' }, // mirrored by flipping on its forward axis, not turned around
  ],
  'mg-raider': [{ src: GEAR.cLmg, bone: 'attach_r_hand', name: 'weapon_right' }, { src: GEAR.cLmgPack, bone: 'attach_backpack', name: 'backpack', part: 'Backpack' }],
  'jet-brigade-mg-raider': [{ src: GEAR.cLmg, bone: 'attach_r_hand', name: 'weapon_right' }, JUMP],
  'rocket-raider': [{ src: GEAR.cCannon, bone: 'attach_r_hand', name: 'weapon_right', part: 'Right Arm' }],
  'incendiary-rocket-raider': [{ src: GEAR.cCannon, bone: 'attach_r_hand', name: 'weapon_right' }],
  'pyro-trooper': [{ src: GEAR.cFlamer, bone: 'attach_r_hand', name: 'weapon_right' }],
  'assault-raider': [JUMP],
  'jet-brigade-trooper': [JUMP],
  'jet-brigade-commissar': [JUMP],
  'jet-brigade-devastator': [{ src: GEAR.rifle, bone: 'attach_r_hand', name: 'weapon_right' }, { src: GEAR.sJump, bone: 'attach_backpack', name: 'jetpack', part: 'Jetpack' }],
  'conflagration-devastator': [{ src: GEAR.shield, bone: 'attach_shield', name: 'shield', part: 'Shield' }],
  'incendiary-mg-devastator': [{ src: GEAR.machinegun, bone: 'attach_r_hand', name: 'weapon_right' }, { src: GEAR.shield, bone: 'attach_shield', name: 'shield', part: 'Shield' }],
  'annihilator-tank': [{ src: GEAR.tankCannon, bone: 'attach_turret', name: 'turret', part: 'Turret Front' }, { src: GEAR.tankMg, bone: 'attach_mg', name: 'hull_mg' }],
  'shredder-tank': [{ src: GEAR.tankAuto, bone: 'attach_turret', name: 'turret', part: 'Turret Front and Sides' }, { src: GEAR.tankMg, bone: 'attach_mg', name: 'hull_mg' }],
  'barrager-tank': [{ src: GEAR.tankRockets, bone: 'attach_turret', name: 'turret', part: 'Launch Tubes' }, { src: GEAR.tankMg, bone: 'attach_mg', name: 'hull_mg' }],
  'war-strider': [{ src: 'extra/0x8372619b2702d743.unit.glb', bone: 'attach_left_gun', name: 'cannon_left', part: 'Fusion Cannons (2)' }, { src: 'extra/0x9ab036439f74c115.unit.glb', bone: 'attach_right_gun', name: 'cannon_right', part: 'Fusion Cannons (2)' }],
  devastator: [{ src: GEAR.rifle, bone: 'attach_r_hand', name: 'weapon_right' }],
  // the gun arm: the body only has the left forearm; the right hand holds the Devastator's gun
  'rocket-devastator': [{ src: GEAR.rifle, bone: 'attach_r_hand', name: 'weapon_right', part: 'Arms (2)' }],
  'heavy-devastator': [{ src: GEAR.machinegun, bone: 'attach_r_hand', name: 'weapon_right' }, { src: GEAR.shield, bone: 'attach_shield', name: 'shield', part: 'Shield' }],
  berserker: [{ src: GEAR.chainsaw, bone: 'attach_l_hand', name: 'chainsaw_left', part: 'Arm (2)' }, { src: GEAR.chainsaw, bone: 'attach_r_hand', name: 'chainsaw_right', part: 'Arm (2)' }],
  'hulk-bruiser': [{ src: GEAR.hulkCannon, bone: 'r_hand_attach', name: 'weapon_right', part: 'Arms (2)' }, { src: GEAR.hulkLauncher, bone: 'l_hand_attach', name: 'weapon_left', part: 'Arms (2)' }],
  // the Obliterator: a rocket launcher on each arm
  'hulk-obliterator': [{ src: GEAR.hulkLauncher, bone: 'r_hand_attach', name: 'weapon_right', part: 'Arms (2)' }, { src: GEAR.hulkLauncher, bone: 'l_hand_attach', name: 'weapon_left', part: 'Arms (2)' }],
  // the Firebomber (wiki): the rotary munition launcher on the right arm, a flamethrower on the left
  'hulk-firebomber': [{ src: GEAR.hulkLauncher, bone: 'r_hand_attach', name: 'weapon_right', part: 'Arms (2)' }, { src: GEAR.hulkFlamer, bone: 'l_hand_attach', name: 'weapon_left', part: 'Arms (2)' }],
  'hulk-scorcher': [{ src: GEAR.hulkSaw, bone: 'l_hand_attach', name: 'weapon_left', part: 'Arms (2)' }, { src: GEAR.hulkFlamer, bone: 'r_hand_attach', name: 'weapon_right', part: 'Arms (2)' }],
};
const HULK_JETPACK = { src: GEAR.hulkJetpack, bone: 'attach_backpack_socket', name: 'jetpack', part: 'Jetpack', rot: [90, 0, 0] }; // stood up on the back, thrusters up (as in game)
LOADOUT['jet-brigade-hulk-bruiser'] = [...LOADOUT['hulk-bruiser'], HULK_JETPACK];
LOADOUT['jet-brigade-hulk-scorcher'] = [...LOADOUT['hulk-scorcher'], HULK_JETPACK];

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
/** Split a skinned mesh into one mesh per bone group: each triangle goes to the group of the bone that
 *  weighs most on its vertices. groupOf(jointName) → piece name. Returns the new piece names. */
function splitByBone(doc, node, groupOf) {
  const mesh = node.getMesh(), skin = node.getSkin();
  if (!skin) return [];
  const jg = skin.listJoints().map((j) => groupOf(j.getName()));
  const buffer = doc.getRoot().listBuffers()[0];
  const parts = new Map();
  for (const prim of mesh.listPrimitives()) {
    const J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0'), I = prim.getIndices();
    if (!J || !W) continue;
    const vg = new Array(J.getCount()), j4 = [], w4 = [];
    for (let v = 0; v < vg.length; v++) {
      J.getElement(v, j4); W.getElement(v, w4);
      let b = 0;
      for (let k = 1; k < w4.length; k++) if (w4[k] > w4[b]) b = k;
      vg[v] = jg[j4[b]] || 'body';
    }
    const n = I ? I.getCount() : prim.getAttribute('POSITION').getCount();
    const tris = new Map();
    for (let t = 0; t + 2 < n; t += 3) {
      const a = I ? I.getScalar(t) : t, b = I ? I.getScalar(t + 1) : t + 1, c = I ? I.getScalar(t + 2) : t + 2;
      const g = vg[b] === vg[c] ? vg[b] : vg[a];
      if (!tris.has(g)) tris.set(g, []);
      tris.get(g).push(a, b, c);
    }
    for (const [g, list] of tris) {
      const p = prim.clone();
      p.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(list)).setBuffer(buffer));
      if (!parts.has(g)) parts.set(g, []);
      parts.get(g).push(p);
    }
  }
  const parent = node.getParentNode();
  const scene = doc.getRoot().listScenes()[0];
  for (const [g, prims] of parts) {
    const m = doc.createMesh(g);
    prims.forEach((p) => m.addPrimitive(p));
    const n = doc.createNode(g).setMesh(m).setSkin(skin).setMatrix(node.getMatrix());
    (parent || scene).addChild(n);
  }
  node.dispose();
  return [...parts.keys()];
}

/** Loose pieces of a primitive (triangles joined by shared vertices or shared positions):
 *  [{ tris: [a, b, c, …], n: vertex count, box: [lo, hi] }], largest first. */
function shellsOf(prim) {
  const P = prim.getAttribute('POSITION'), I = prim.getIndices();
  const n = P.getCount(), par = Int32Array.from({ length: n }, (_, i) => i), v = [0, 0, 0];
  const find = (x) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  const join = (x, y) => { par[find(x)] = find(y); };
  const pos = [], seen = new Map();
  for (let i = 0; i < n; i++) {
    pos.push(P.getElement(i, v).slice());
    const k = v.map((x) => Math.round(x * 1000)).join(',');
    if (seen.has(k)) join(i, seen.get(k)); else seen.set(k, i);
  }
  const m = I ? I.getCount() : n, at = (t) => (I ? I.getScalar(t) : t);
  for (let t = 0; t + 2 < m; t += 3) { join(at(t), at(t + 1)); join(at(t), at(t + 2)); }
  const shells = new Map();
  for (let t = 0; t + 2 < m; t += 3) {
    const r = find(at(t));
    if (!shells.has(r)) shells.set(r, { tris: [], verts: new Set() });
    const sh = shells.get(r);
    for (let k = 0; k < 3; k++) { sh.tris.push(at(t + k)); sh.verts.add(at(t + k)); }
  }
  return [...shells.values()].map(({ tris, verts }) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const i of verts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i][k]); hi[k] = Math.max(hi[k], pos[i][k]); }
    return { tris, n: verts.size, box: [lo, hi] };
  }).sort((a, b) => b.n - a.n);
}
const sameBox = (a, b) => a[0].every((x, k) => Math.abs(x - b[0][k]) < 0.01 && Math.abs(a[1][k] - b[1][k]) < 0.01);

/** Tails in one mesh: the soft body is the largest loose piece (plus crumbs under 2 %), the armor plates
 *  are the other pieces. { mesh, main, rest, prim?, dropLike? }: the body becomes "main", the plates a new
 *  mesh "rest"; with dropLike the plates are dropped instead when they repeat the plates of that mesh
 *  (a damage state that carries its own copy). Only primitives whose material matches prim are cut. */
function splitShells(doc, node, sp, likeBoxes) {
  const buffer = doc.getRoot().listBuffers()[0];
  const mesh = node.getMesh(), restPrims = [];
  for (const prim of mesh.listPrimitives()) {
    if (sp.prim && !sp.prim.test(prim.getMaterial()?.getName() || '')) continue;
    const sh = shellsOf(prim);
    const total = sh.reduce((a, x) => a + x.n, 0);
    const isPlate = (x, i) => (likeBoxes ? likeBoxes.some((b) => sameBox(b, x.box)) : i > 0 && x.n >= total * 0.02);
    let body = sh.filter((x, i) => !isPlate(x, i)).flatMap((x) => x.tris);
    let plates = sh.filter(isPlate).flatMap((x) => x.tris);
    // keepPieces: the loose pieces are part of what stays (gore blobs); the box below only trims the main piece
    const extra = sp.keepPieces ? plates : [];
    if (sp.keepPieces) plates = [];
    // tipBones: the tail tip is welded to the body; its upper half is armored, its underside soft.
    // Tip triangles (by bone) above the tip's mid-height, per slice along the body, go to the plates.
    if (sp.tipBones && !likeBoxes) {
      const skin = node.getSkin(), joints = skin.listJoints(), ibm = skin.getInverseBindMatrices(), m16 = [];
      const mats = joints.map((j, i) => mat4Mul(j.getWorldMatrix(), ibm.getElement(i, m16).slice()));
      const P = prim.getAttribute('POSITION'), J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0');
      const v = [0, 0, 0], j4 = [], w4 = [];
      const info = (i) => {
        P.getElement(i, v); J.getElement(i, j4); W.getElement(i, w4);
        let b = 0; const o = [0, 0, 0];
        for (let k = 0; k < 4; k++) {
          if (w4[k] > w4[b]) b = k;
          if (!w4[k]) continue;
          const m = mats[j4[k]];
          for (let r = 0; r < 3; r++) o[r] += w4[k] * (m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]);
        }
        return { p: o, tip: sp.tipBones.test(joints[j4[b]].getName()) };
      };
      const V = new Map(); const at = (i) => { if (!V.has(i)) V.set(i, info(i)); return V.get(i); };
      const tris = [];
      for (let t = 0; t < body.length; t += 3) {
        const tri = body.slice(t, t + 3).map(at);
        tris.push({ idx: body.slice(t, t + 3), tip: tri.filter((x) => x.tip).length >= 2, c: [0, 1, 2].map((k) => (tri[0].p[k] + tri[1].p[k] + tri[2].p[k]) / 3) });
      }
      // height range of the tip in slices along z (the body's long axis)
      const slice = (z) => Math.round(z / 0.1), lo = new Map(), hi = new Map();
      for (const t of tris) if (t.tip) { const k = slice(t.c[2]); lo.set(k, Math.min(lo.get(k) ?? Infinity, t.c[1])); hi.set(k, Math.max(hi.get(k) ?? -Infinity, t.c[1])); }
      const keep = [];
      for (const t of tris) {
        const k = slice(t.c[2]);
        const upper = t.tip && t.c[1] > lo.get(k) + (sp.tipSplit ?? 0.5) * (hi.get(k) - lo.get(k));
        (upper ? plates : keep).push(...t.idx);
      }
      body = keep;
    }
    if (!plates.length && !sp.softBox) continue;
    // softBox: the armor is welded to the soft body (Bile Titan torso: everything but the small belly between
    // the legs is armored, leg sockets too): only body triangles centred inside the box stay soft
    if (sp.softBox && !likeBoxes) {
      const skin = node.getSkin(), m16 = [];
      const mats = skin.listJoints().map((j, i) => mat4Mul(j.getWorldMatrix(), skin.getInverseBindMatrices().getElement(i, m16).slice()));
      const P = prim.getAttribute('POSITION'), J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0');
      const v = [0, 0, 0], j4 = [], w4 = [], posed = new Map();
      const at = (i) => {
        if (posed.has(i)) return posed.get(i);
        P.getElement(i, v); J.getElement(i, j4); W.getElement(i, w4);
        const o = [0, 0, 0];
        for (let k = 0; k < 4; k++) { if (!w4[k]) continue; const m = mats[j4[k]]; for (let r = 0; r < 3; r++) o[r] += w4[k] * (m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]); }
        posed.set(i, o); return o;
      };
      const keep = [], [lo, hi] = sp.softBox;
      for (let t = 0; t < body.length; t += 3) {
        const tri = [at(body[t]), at(body[t + 1]), at(body[t + 2])];
        const c = [0, 1, 2].map((k) => (tri[0][k] + tri[1][k] + tri[2][k]) / 3);
        (c.every((x, k) => x >= lo[k] && x <= hi[k]) ? keep : plates).push(body[t], body[t + 1], body[t + 2]);
      }
      body = keep;
    }
    body.push(...extra);
    const idx = (list) => doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(list)).setBuffer(buffer);
    if (!likeBoxes) { const p = prim.clone(); p.setIndices(idx(plates)); restPrims.push(p); }
    prim.setIndices(idx(body));
  }
  node.setName(sp.main); mesh.setName(sp.main);
  if (!restPrims.length || !sp.rest) return [];
  const add = (name, prims) => {
    const m = doc.createMesh(name);
    prims.forEach((p) => m.addPrimitive(p));
    const n = doc.createNode(name).setMesh(m).setSkin(node.getSkin()).setMatrix(node.getMatrix());
    (node.getParentNode() || doc.getRoot().listScenes()[0]).addChild(n);
    return name;
  };
  if (!sp.halves) return [add(sp.rest, restPrims)];
  // halves: the plates cut down the middle (x < 0 is left), one per side of a counted part
  const halves = { left: [], right: [] };
  const skin = node.getSkin(), m16 = [];
  const mats = skin.listJoints().map((j, i) => mat4Mul(j.getWorldMatrix(), skin.getInverseBindMatrices().getElement(i, m16).slice()));
  for (const p of restPrims) {
    const P = p.getAttribute('POSITION'), J = p.getAttribute('JOINTS_0'), W = p.getAttribute('WEIGHTS_0'), I = p.getIndices();
    const v = [0, 0, 0], j4 = [], w4 = [];
    const x = (i) => { P.getElement(i, v); J.getElement(i, j4); W.getElement(i, w4); let o = 0; for (let k = 0; k < 4; k++) if (w4[k]) { const m = mats[j4[k]]; o += w4[k] * (m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12]); } return o; };
    const side = { left: [], right: [] };
    for (let t = 0; t + 2 < I.getCount(); t += 3) {
      const tri = [I.getScalar(t), I.getScalar(t + 1), I.getScalar(t + 2)];
      side[x(tri[0]) + x(tri[1]) + x(tri[2]) < 0 ? 'left' : 'right'].push(...tri);
    }
    for (const k of ['left', 'right']) if (side[k].length) { const q = p.clone(); q.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(side[k])).setBuffer(buffer)); halves[k].push(q); }
  }
  return ['left', 'right'].filter((k) => halves[k].length).map((k) => add(sp.rest.replace('{side}', k), halves[k]));
}

/** Cut out the loose pieces that lie inside a box (posed model space): weak spots modelled into a bigger
 *  mesh (the Hulk's eye plate, the War Strider's eye and visor). { mesh, name, box: [lo, hi] } */
function cutBox(doc, node, cut) {
  const skin = node.getSkin(), m16 = [];
  const mats = skin ? skin.listJoints().map((j, i) => mat4Mul(j.getWorldMatrix(), skin.getInverseBindMatrices().getElement(i, m16).slice())) : null;
  const world = node.getWorldMatrix();
  const buffer = doc.getRoot().listBuffers()[0];
  const idx = (list) => doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(list)).setBuffer(buffer);
  const out = [];
  for (const prim of node.getMesh().listPrimitives()) {
    if (cut.prim && !cut.prim.test(prim.getMaterial()?.getName() || '')) continue; // only that material
    const P = prim.getAttribute('POSITION'), J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0');
    const v = [0, 0, 0], j4 = [], w4 = [];
    const posed = (i) => {
      P.getElement(i, v);
      if (!mats || !J) return [0, 1, 2].map((r) => world[r] * v[0] + world[4 + r] * v[1] + world[8 + r] * v[2] + world[12 + r]);
      J.getElement(i, j4); W.getElement(i, w4);
      const o = [0, 0, 0];
      for (let k = 0; k < 4; k++) { if (!w4[k]) continue; const m = mats[j4[k]]; for (let r = 0; r < 3; r++) o[r] += w4[k] * (m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]); }
      return o;
    };
    const inside = [], rest = [];
    for (const sh of shellsOf(prim)) {
      const ok = [...new Set(sh.tris)].every((i) => posed(i).every((x, k) => x >= cut.box[0][k] && x <= cut.box[1][k]));
      (ok ? inside : rest).push(...sh.tris);
    }
    if (!inside.length) continue;
    const p = prim.clone(); p.setIndices(idx(inside)); out.push(p);
    prim.setIndices(idx(rest));
  }
  if (!out.length) { console.warn(`cut ${cut.name}: nothing inside the box`); return []; }
  if (cut.rest) { node.setName(cut.rest); node.getMesh().setName(cut.rest); }
  const m = doc.createMesh(cut.name);
  out.forEach((p) => m.addPrimitive(p));
  const n = doc.createNode(cut.name).setMesh(m).setSkin(skin).setMatrix(node.getMatrix());
  (node.getParentNode() || doc.getRoot().listScenes()[0]).addChild(n);
  return cut.rest ? [cut.name, cut.rest] : [cut.name];
}

/** Bone that weighs most on a skinned mesh overall; for a rigid mesh, the bone nearest its centre. */
function mainBone(node, doc) {
  const skin = node.getSkin();
  if (!skin) {
    const joints = doc ? doc.getRoot().listSkins().flatMap((sk) => sk.listJoints()) : [];
    const pos = node.getMesh().listPrimitives()[0]?.getAttribute('POSITION');
    if (!joints.length || !pos) return null;
    const lo = pos.getMin([]), hi = pos.getMax([]);
    const m = node.getWorldMatrix(), c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const w = [0, 1, 2].map((r) => m[r] * c[0] + m[4 + r] * c[1] + m[8 + r] * c[2] + m[12 + r]);
    let best = null, bd = Infinity;
    for (const j of joints) {
      if (/cull|root|boss|skeleton|culling/i.test(j.getName())) continue;
      const t = j.getWorldTranslation();
      const d = (t[0] - w[0]) ** 2 + (t[1] - w[1]) ** 2 + (t[2] - w[2]) ** 2;
      if (d < bd) { bd = d; best = j.getName(); }
    }
    return best;
  }
  const sum = new Map(), j4 = [], w4 = [];
  for (const prim of node.getMesh().listPrimitives()) {
    const J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0');
    if (!J || !W) continue;
    for (let v = 0; v < J.getCount(); v++) {
      J.getElement(v, j4); W.getElement(v, w4);
      for (let k = 0; k < w4.length; k++) if (w4[k] > 0) sum.set(j4[k], (sum.get(j4[k]) || 0) + w4[k]);
    }
  }
  let best = null, bw = 0;
  for (const [j, w] of sum) if (w > bw) { bw = w; best = j; }
  return best == null ? null : skin.listJoints()[best]?.getName() || null;
}

// bone groups shared by the bugs: head bits, claws, legs by side and position, wings, everything else = body
const BUG_BONES = (bone) => {
  const b = bone.toLowerCase();
  if (/(^|_)(head|jaw|tusk|mouth|tooth|gullet|neck|jugular|mandible|look_at)/.test(b) || /collar_(\d|base)/.test(b)) return 'head';
  const side = /^l_/.test(b) ? 'left' : /^r_/.test(b) ? 'right' : '';
  if (side && /(claw|collar|thumb|wrist|elbow)/.test(b) && !/leg/.test(b)) return `claw_${side}`;
  if (side && /(fore|front).*leg|leg.*(fore|front)|foreleg/.test(b)) return `leg_${side}_front`;
  if (side && /(rear|back|hind).*leg|hindleg/.test(b)) return `leg_${side}_back`;
  if (side && /wing/.test(b)) return `wing_${side}`;
  if (side && /shoulder/.test(b)) return `claw_${side}`;
  return 'body';
};

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

// Bugs split / named by bone: pieces head, claw_left/right, leg_<side>_front/back, wing_left/right, body
const BG = 'content/fac_bugs/';
const bugBody = (main, extra = []) => ({
  boneGroups: BUG_BONES,
  split: { mesh: /^g_body$/, bones: BUG_BONES },
  rules: [...extra, [/^head$/i, 'Head'], [/^(body|g_body)$/i, main]],
});
const HUNTER = bugBody('Main', [[/^claw_/, 'Claws (2)'], [/^leg_/, 'Legs (4)'], [/^wing_/, 'Wings (2)']]);
const STALKER = bugBody('Body Armor', [[/^claw_/, 'Claws (2)'], [/^leg_/, 'Legs (4)'], [/^wing_/, 'Wings']]);
const SCAVENGER = bugBody('Main', [[/^(claw|leg)_/, 'Limbs (6)'], [/^(wing_|butt$)/i, 'Main']]);
// Warriors: the real body is a hash-named skinned mesh; split it too
const warriorBody = (rules) => { const b = bugBody('Main', rules); b.split.skinnedHash = true; return b; };
const WARRIOR = warriorBody([[/^claw_/, 'Claws (2)'], [/^leg_/, 'Legs (4)']]);
const SPEWER = bugBody('Main', [[/^butt$/i, 'Butt'], [/^leg_\w+_front$/, 'Front Legs (2)'], [/^leg_\w+_back$/, 'Rear Legs (2)']]);

const CY = 'content/fac_cyborgs/';
const TROOPER = { split: { mesh: /^body$/, bones: BOT_BONES }, rules: [[/^head$/, 'Head'], [/^arm_/, 'Arms (2)'], [/^leg_/, 'Legs (2)'], [/^(torso|collar_\w+)$/, 'Torso']] };
const trooper = (file, extra = []) => ({ src: CY + 'cha_conscript/' + file, ...TROOPER, rules: [...extra, ...TROOPER.rules] });
const TANK_HULL = [[/^front$/, 'Hull Front'], [/^body_(left|right)$/, 'Hull Sides (2)'], [/^rear$/, 'Engine Bay'], [/^tracks_(left|right)$/, 'Tracks (2)'], [/^udim 0$/, 'Hull Main']];
const tank = (sides) => ({ src: CY + 'vehicles/cyborg_tank/cyborg_tank.unit.glb', boneNames: false, rules: TANK_HULL.map(([re, p]) => [re, p === 'Hull Sides (2)' ? sides : p]) });
const MAIN_ONLY = [[/./, 'Main']];

const SOURCES = {
  // charger butts: the armor plates on top and the soft butt below are pieces of one mesh
  charger: { src: 'content/fac_bugs/cha_charger/cha_charger.unit.glb', cuts: CHARGER_BELLY, shells: [{ mesh: 'butt', main: 'butt', rest: 'butt_plates', tipBones: /^spine4$/ }], rules: CHARGER },
  'charger-behemoth': { src: 'content/fac_bugs/cha_charger_bull/cha_charger_bull.unit.glb', cuts: CHARGER_BELLY, shells: [{ mesh: 'butt', main: 'butt', rest: 'butt_plates', tipBones: /^spine4$/ }], rules: CHARGER },
  // the Rupture's front legs are its digging plates (Frontal Tarsal Plate Armor, AV5)
  'rupture-charger': { src: 'content/fac_bugs/cha_charger_burrower/cha_charger_burrower.unit.glb', cuts: CHARGER_BELLY, shells: [{ mesh: 'butt', main: 'butt', rest: 'butt_plates', tipBones: /^spine4$/ }], rules: [[/^(left|right)_front_leg$/, 'Frontal Tarsal Plate Armor (2)'], ...CHARGER] },
  'caustic-charger': { src: 'content/fac_bugs/cha_charger_acid/cha_charger_acid.unit.glb', cuts: CHARGER_BELLY, shells: [{ mesh: 'butt', main: 'butt', rest: 'butt_plates', prim: /cha_charger/, tipBones: /^spine4$/ }], rules: [[/_blob$/, 'Spore Flesh'], ...CHARGER] },
  'bile-titan': { src: 'content/fac_bugs/cha_strider/cha_strider.unit.glb', ...BT_BODY, rules: BILE_TITAN },
  'spore-burst-bile-titan': { src: 'content/fac_bugs/cha_strider/cha_strider_gloom.unit.glb', ...BT_BODY, rules: BILE_TITAN },
  impaler: {
    src: 'content/fac_bugs/cha_impaler/cha_impaler.unit.glb',
    shells: [{ mesh: 'tail', main: 'tail', rest: 'tail_plates', tipBones: /^spine[56]$/ }],
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
  'rocket-devastator': {
    src: 'content/fac_cyborgs/cha_soldier/cha_soldier_rocket.unit.glb',
    // the unnamed arm meshes: upper arms, shoulder joints, the left forearm with its hand (left is -x)
    names: {
      'g_body 0x09be09cf': 'arm_left_upper', 'g_body 0x0fb1fef6': 'arm_right_upper',
      'g_body 0x7d4e2117': 'arm_left_joint', 'g_body 0x1111bf60': 'arm_right_joint', 'g_body udim 0': 'arm_left_lower',
    },
    rules: [[/^backpack_rockets$/, 'Rockets'], [/^rocket_pods(_whole)?$/, 'Rocket Pods'], [/^arm_(left|right)_/, 'Arms (2)'], ...DEVASTATOR],
  },
  berserker: {
    src: 'content/fac_cyborgs/cha_berserker/cha_berserker.unit.glb',
    rules: [[/^head(_whole)?$/, 'Head'], [/^torso(_whole)?$/, 'Chest'], [/^hip(_whole)?$/, 'Pelvis'], [/^leg_(left|right)(_whole)?$/, 'Leg (2)']],
  },
  // 'lieutenant' is the game's internal name for the Hulk; the Commissar is the conscript commander
  commissar: { src: 'content/fac_cyborgs/cha_conscript_commander/cha_conscript_commander.unit.glb', rules: [[/^head$/, 'Head'], [/^body$/, 'Torso']] },
  'hulk-bruiser': { cuts: HULK_EYE, src: 'content/fac_cyborgs/cha_lieutenant/cha_lieutenant.unit.glb', rules: HULK },
  'hulk-obliterator': { cuts: HULK_EYE, src: 'content/fac_cyborgs/cha_lieutenant/cha_lieutenant.unit.glb', rules: HULK },
  'hulk-firebomber': { cuts: HULK_EYE, src: 'content/fac_cyborgs/cha_lieutenant/cha_lieutenant.unit.glb', rules: HULK },
  'hulk-scorcher': { cuts: HULK_EYE, src: 'content/fac_cyborgs/cha_lieutenant_assault/cha_lieutenant_assault.unit.glb', rules: HULK },
  'jet-brigade-hulk-bruiser': { cuts: HULK_EYE, src: 'content/fac_cyborgs/cha_lieutenant/cha_lieutenant.unit.glb', rules: HULK },
  // the Scorcher body: its right arm is the flamethrower (the Bruiser body has a plain hand there)
  'jet-brigade-hulk-scorcher': { cuts: HULK_EYE, src: 'content/fac_cyborgs/cha_lieutenant_assault/cha_lieutenant_assault.unit.glb', rules: HULK },
  // bugs: one-mesh bodies split by bone; hash-named legs and claws named by bone
  scavenger: { src: BG + 'cha_scavenger/cha_scavenger.unit.glb', ...SCAVENGER },
  'spore-burst-scavenger': { src: BG + 'cha_scavenger/cha_scavenger_gloom.unit.glb', ...SCAVENGER },
  'noxious-scavenger': { src: BG + 'cha_scavenger_defiler/cha_scavenger_defiler.unit.glb', ...SCAVENGER },
  'caustic-spitter': { src: BG + 'cha_scavenger_spitter/cha_scavenger_spitter.unit.glb', ...SCAVENGER },
  pouncer: { src: BG + 'cha_scavenger_predator/cha_scavenger_predator.unit.glb', ...SCAVENGER },
  hunter: { src: BG + 'cha_hunter/cha_hunter.unit.glb', ...HUNTER },
  'predator-hunter': { src: BG + 'cha_hunter/cha_hunter_tier3.unit.glb', ...HUNTER },
  'spore-burst-hunter': { src: BG + 'cha_hunter/cha_hunter_gloom_tier1.unit.glb', ...HUNTER },
  stalker: { src: BG + 'cha_stalker/cha_stalker.unit.glb', ...STALKER },
  'predator-stalker': { src: BG + 'cha_stalker/cha_stalker.unit.glb', ...STALKER },
  shrieker: { src: BG + 'cha_shrieker/cha_shrieker.unit.glb', ...bugBody('Main', [[/^(claw|leg)_/, 'Limbs'], [/^(g_)?wings?(_\w+)?$/, 'Wings (2)']]) },
  warrior: { src: BG + 'cha_warrior/cha_warrior.unit.glb', ...WARRIOR },
  'alpha-warrior': { src: BG + 'cha_warrior/cha_warrior_tier_1.unit.glb', ...WARRIOR },
  'spore-burst-warrior': { src: BG + 'cha_warrior/cha_warrior_gloom_tier_1.unit.glb', ...WARRIOR },
  'caustic-warrior': { src: BG + 'cha_warrior_acid/cha_warrior_acid.unit.glb', ...WARRIOR },
  'rupture-warrior': { src: BG + 'cha_warrior_burrower/cha_warrior_burrower.unit.glb', ...WARRIOR },
  'hive-guard': { src: BG + 'cha_warrior_plus/cha_warrior_plus.unit.glb', ...warriorBody( [[/^claw_/, 'Claws (2)'], [/^leg_\w+_front(_socket)?$/, 'Front Legs (2)'], [/^leg_\w+_back(_socket)?$/, 'Rear Legs (2)']]) },
  'alpha-commander': { src: BG + 'cha_warrior_big/cha_warrior_big_tier2.unit.glb', ...WARRIOR },
  'brood-commander': { src: BG + 'cha_warrior_big/cha_warrior_big.unit.glb', ...WARRIOR },
  'nursing-spewer': { src: BG + 'cha_boomer_nurser/cha_boomer_nurser.unit.glb', ...SPEWER },
  'caustic-spewer': { src: BG + 'cha_boomer/cha_boomer.unit.glb', ...SPEWER },
  'noxious-spewer': { src: BG + 'cha_boomer_defiler/cha_boomer_defiler.unit.glb', ...SPEWER },
  'rupture-spewer': { src: BG + 'cha_boomer_burrower/cha_boomer_burrower.unit.glb', ...SPEWER },
  // automatons
  trooper: trooper('cha_conscript.unit.glb'),
  'mg-raider': trooper('cha_conscript.unit.glb'),
  'jet-brigade-mg-raider': trooper('cha_conscript.unit.glb'),
  'rocket-raider': trooper('cha_conscript.unit.glb', [[/^arm_left$/, 'Left Arm'], [/^arm_right$/, 'Right Arm']]),
  'incendiary-rocket-raider': trooper('cha_conscript.unit.glb'),
  'assault-raider': trooper('cha_conscript.unit.glb'),
  'jet-brigade-trooper': trooper('cha_conscript.unit.glb'),
  'pyro-trooper': trooper('cha_conscript.unit.glb'),
  marauder: trooper('cha_conscript_tier_2.unit.glb'),
  'jet-brigade-commissar': { src: CY + 'cha_conscript_commander/cha_conscript_commander.unit.glb', ...TROOPER },
  // the Scout Strider's pilot is a Commissar body
  'scout-strider-pilot': { src: CY + 'cha_conscript_commander/cha_conscript_commander.unit.glb', ...TROOPER },
  radical: {
    src: CY + 'cha_cyborg_elite/cha_elite_female.unit.glb',
    rules: [[/^head(_whole)?$/, 'Head'], [/^armor_torso$/, 'Torso Circuits'], [/^(left|right)_shoulderpad$/, 'Pauldron'], [/^(left|right)_arm(_whole)?$/, 'Upper Arms (2)'], [/^body(_whole)?$/, 'Main']],
  },
  'jet-brigade-devastator': { src: CY + 'cha_soldier/cha_soldier.unit.glb', rules: DEVASTATOR },
  'conflagration-devastator': { src: CY + 'cha_soldier/cha_soldier_heavy_weapon.unit.glb', rules: [[/^weapon_backpack(_whole)?$/, 'Main'], ...DEVASTATOR] }, // the shield body
  'incendiary-mg-devastator': { src: CY + 'cha_soldier/cha_soldier_heavy_weapon.unit.glb', rules: [[/^weapon_backpack(_whole)?$/, 'Main'], ...DEVASTATOR] }, // the shield body
  'annihilator-tank': tank('Hull Sides (2)'),
  'shredder-tank': tank('Hull Side (2)'),
  'barrager-tank': tank('Hull Sides (2)'),
  'war-strider': {
    // the eye box low on the hull front and the visor block on top (both glow: m_boteye)
    cuts: [
      { mesh: 'body_whole', name: 'body_eye', box: [[0.5, 3.84, -1.86], [0.87, 4.24, -1.58]] },
      { mesh: 'body_whole', name: 'body_visor', box: [[-0.47, 4.47, -0.79], [0.47, 5.21, -0.21]] },
    ],
    src: CY + 'vehicles/cyborg_assault_walker/cyborg_assault_walker.unit.glb',
    rules: [[/^body(_whole)?$/, 'Torso'], [/^(left|right)_leg(_whole)?$/, 'Legs (2)'], [/^(left|right)_rocketpod(_whole)?$/, 'Grenade Launchers (2)'], [/^platform(_whole)?$/, 'Crotch']],
  },
  'scout-strider': { src: CY + 'vehicles/cyborg_walker_scout/cyborg_walker_scout.unit.glb', rules: [[/^[lr]_hip$/, 'Waist'], [/^legs$/, 'Legs (2)'], [/^body$/, 'Main']] },
  'reinforced-scout-strider': { src: CY + 'vehicles/cyborg_walker_scout/cyborg_walker_scout.unit.glb', rules: [[/^[lr]_hip$/, 'Waist'], [/^legs$/, 'Legs (2)'], [/^body$/, 'Main']] },
  gunship: { src: CY + 'vehicles/cyborg_gunship/cyborg_gunship.unit.glb', rules: [[/^body$/, 'Fuselage'], [/^[lr]_front_engine$/, 'Front Thrusters (2)'], [/^[lr]_back_engine$/, 'Rear Thrusters (2)']] },
  dropship: { src: CY + 'vehicles/cyborg_dropship/cyborg_dropship.unit.glb', rules: [[/^body$/, 'Fuselage'], [/thruster$/, 'Thruster (4)']] },
  'vox-engine': {
    src: CY + 'vehicles/cyborg_siege_engine/cyborg_siege_engine.unit.glb',
    // unnamed pieces, matched by shape: the side vents and their damaged states (front is -z, left is -x);
    // 0xda9368a8 is murmur("vent_back_bar_damaged"). Raw names: the hash 0x8dc6adf9 is used twice.
    names: {
      'g_siege_engine 0xda9368a8': 'vent_back_bar_damaged',
      'g_siege_engine 0x2b5e39ae': 'vent_lower_left', 'g_siege_engine 0xe1e29f85': 'vent_lower_left_damaged',
      'g_siege_engine 0xcbf1a9ea': 'vent_lower_right', 'g_siege_engine 0x9ff82b07': 'vent_lower_right_damaged',
      'g_siege_engine 0x63d08f86': 'vent_upper_left', 'g_siege_engine 0xf1a41290': 'vent_upper_left_damaged',
      'g_siege_engine 0x8dc6adf9': 'vent_upper_right', 'g_siege_engine 0xc6f4b828': 'vent_upper_right_damaged',
      'g_rockets 0x8dc6adf9': 'right_rocket_cap',
    },
    hide: ['tracks_static'], // in the damaged group: the broken tracks
    rules: [
      [/^sarcophagus$/, 'Sarcophagus'], [/^torso(_whole)?$/, 'Torso'], [/^(left|right)_rocket(_cap)?$/, 'Missile Launchers (2)'],
      [/^(left|right)_speaker$/, 'Speakers (2)'], [/^(left|right)_flap$/, 'Torso Flaps (2)'], [/^(left|right)_(front|back)_tracks(_whole)?$/, 'Tracks (4)'],
      [/^(left|right)_(front|back)_knee$/, 'Trackpod Latches (4)'], [/^vent_/, 'Vents (6)'], [/^boss_lid$/, 'Hatches (2)'], [/^body(_whole)?$/, 'Undercarriage'],
    ],
  },
  // cyborg_spawner is the Factory Strider (skeleton "cyborg_big_walker_skeleton"); the Fabricator is a building: best guess the bunker
  'automaton-fabricator': { src: 'extra/0x3ce73c30ff7e3146.unit.glb', boneNames: false, rules: MAIN_ONLY },
  'factory-strider': {
    src: CY + 'vehicles/cyborg_spawner/cyborg_spawner.unit.glb',
    boneGroups: FS_BONES,
    // the unnamed leg plates, knee shields and hull pieces, matched by shape (front is -z, left is -x)
    names: {
      'g_body 0x310533ad': 'leg_upper_right_front',
      'g_body 0x1eb59a4b': 'leg_upper_right_front_damaged',
      'g_body 0x2c3b2366': 'leg_lower_right_front',
      'g_body 0xbfccb1d6': 'leg_lower_right_front_damaged',
      'g_body 0x786baaac': 'knee_right_front',
      'g_body 0x8e95c6c4': 'knee_right_front_damaged',
      'g_body 0x26972a16': 'leg_upper_right_back',
      'g_body 0xe6831f1d': 'leg_upper_right_back_damaged',
      'g_body 0xb52f6c2e': 'leg_lower_right_back',
      'g_body 0x55170a50': 'leg_lower_right_back_damaged',
      'g_body 0xe80e4269': 'knee_right_back',
      'g_body 0x59514b2a': 'knee_right_back_damaged',
      'g_body 0x381e23fe': 'leg_upper_left_front',
      'g_body 0xe70581d4': 'leg_upper_left_front_damaged',
      'g_body 0x6b56de64': 'leg_lower_left_front',
      'g_body 0x8725aab5': 'leg_lower_left_front_damaged',
      'g_body 0xa183b2c3': 'knee_left_front',
      'g_body 0x3b80ff88': 'knee_left_front_damaged',
      'g_body 0x2e96058c': 'leg_upper_left_back',
      'g_body 0x9c80bd56': 'leg_upper_left_back_damaged',
      'g_body 0xa38b1f5f': 'leg_lower_left_back',
      'g_body 0x209fd2d9': 'leg_lower_left_back_damaged',
      'g_body 0x7c6adac4': 'knee_left_back',
      'g_body 0xe84be9f0': 'knee_left_back_damaged',
      'g_body 0xa7d0ffed': 'top_right',
      'g_body 0x8aeb874e': 'top_right_damaged',
      'g_body 0xbb57b318': 'top_left',
      'g_body 0xee621fe2': 'top_left_damaged',
      'g_body 0xeb86b86c': 'side_right',
      'g_body 0x28ad2203': 'side_right_damaged',
      'g_body 0x16ce220f': 'side_left',
      'g_body 0xa6f944fb': 'side_left_damaged'
    },
    rules: [
      [/^armor_head(_whole)?$/, 'Head Armor'], [/^(head(_whole)?|head)$/, 'Head Body'], [/^neck(_whole)?$/, 'Neck'],
      [/^armor_front(_whole)?$/, 'Front Armor'], [/^front(_whole)?$/, 'Front Top Armor'], [/^armor_rear(_whole)?$/, 'Rear Armor'],
      [/^engine_rear(_whole)?$/, 'Rear Engine Armor'], [/^body_static$/, 'Main'], [/^(top|side)_(left|right)$/, 'Main'],
      [/^knee_(armor|(left|right)_(front|back))$/, 'Knee Armor (4)'], [/^leg_(armor|(upper|lower)_(left|right)_(front|back))$/, 'Leg Armor (8)'], [/^leg_assembly$/, 'Leg Assembly (4)'], [/^neck$/, 'Neck'], [/^body$/, 'Main'],
    ],
  },
  'cannon-turret': { src: CY + 'turrets/cyborg_turret_command_bunker_hmg/cyborg_turret_command_bunker_hmg.unit.glb', rules: MAIN_ONLY },
  'bunker-turret': { src: CY + 'turrets/cyborg_turret_small_autocannon/cyborg_turret_small_autocannon.unit.glb', rules: MAIN_ONLY },
  'mg-emplacement-light-fusion-cycler': { src: CY + 'emplacements/cyborg_emplacement_mg/cyborg_emplacement_mg.unit.glb', rules: MAIN_ONLY },
  'mg-emplacement-heavy-fusion-repeater': { src: CY + 'emplacements/cyborg_emplacement_hmg/cyborg_emplacement_hmg.unit.glb', rules: MAIN_ONLY },
  'light-voteless': { src: IL + 'cha_corrupted/cha_corrupted.unit.glb', rules: VOTELESS },
  'medium-voteless': { src: IL + 'cha_corrupted/cha_corrupted_v2.unit.glb', rules: VOTELESS },
  'heavy-voteless': { src: IL + 'cha_corrupted/cha_corrupted_v3.unit.glb', rules: VOTELESS },
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
  // the helmeted body-horror unit is the Crusher; the melee exomech is the Veracitor
  crusher: {
    src: IL + 'cha_bodyhorror_helmetguy/cha_bodyhorror_helmetguy.unit.glb',
    rules: [[/^helmet(_whole)?$/, 'Helmet'], [/^head(_whole)?$/, 'Head'], [/^arm_(left|right)(_whole)?$/, 'Arms (2)'], [/^leg_(left|right)(_whole)?$/, 'Legs (2)'], [/^generic(_whole)?$/, 'Torso']],
  },
  // archive clues: the ranged exomech is the Gatekeeper; the Obtruder shares the Watcher's body
  gatekeeper: {
    src: IL + 'cha_exomech_ranged/cha_exomech_ranged.unit.glb',
    rules: [
      [/^cockpit(_whole)?$/, 'Cockpit'], [/^pilot(_whole)?$/, 'Pilot'], [/^shield(_whole)?$/, 'Shield'],
      [/^shoulder_(left|right)(_whole)?$/, 'Shoulder Armor (2)'], [/^bicep_(left|right)(_whole)?$/, 'Arm Armor (2)'],
      [/^arm_(left|right)(_whole)?$/, 'Arms (2)'], [/^generic(_whole)?$/, 'Chassis'],
    ],
  },
  obtruder: {
    src: IL + 'cha_observer/cha_observer.unit.glb',
    rules: [[/^base$/, 'Body'], [/^eye(_whole)?$/, 'Eye'], [/^wing_(top|bottom)(_whole)?$/, 'Vertical Fins (2)'], [/^wing_(left|right)(_whole)?$/, 'Lateral Fins (2)']],
  },
  'warp-ship': { src: 'extra/0x43cca7488df95ad2.unit.glb', rules: MAIN_ONLY },
  'illuminate-overship': { src: 'extra/0xe7074f10233cd0b8.unit.glb', boneNames: false, rules: MAIN_ONLY },
  veracitor: {
    src: IL + 'cha_exomech_melee/cha_exomech_melee.unit.glb',
    rules: [
      [/^cockpit(_whole)?$/, 'Cockpit'], [/^pilot(_whole)?$/, 'Pilot'], [/^shield(_whole)?$/, 'Shield'],
      [/^shoulder_(left|right)(_whole)?$/, 'Shoulders (2)'], [/^bicep_(left|right)(_whole)?$/, 'Upper Arms (2)'],
      [/^arm_(left|right)(_whole)?$/, 'Lower Arms (2)'], [/^generic(_whole)?$/, 'Chassis'],
    ],
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
// "g_champion_LOD1 head" → "head", "corrupted_v3 arm_right_whole" → "arm_right_whole"
const clean = (name) => (name || '').replace(/^(g_\S*|\S+_v\d+)\s+/, '').trim() || name;

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
    const verts = (n) => n.getMesh().listPrimitives().reduce((t, p) => t + p.getAttribute('POSITION').getCount(), 0);
    const biggest = a.biggestOnly ? meshes.reduce((x, y) => (verts(y) > verts(x) ? y : x)) : null;
    for (const n of adoc.getRoot().listNodes()) {
      if (!n.getMesh()) continue;
      if (!meshes.includes(n) || lodOf(n) !== best || (biggest && n !== biggest)) { n.dispose(); continue; }
      // "turret_damaged" or just "destroyed" (the Vox Engine cannon) → keep the state as a suffix
      const sm = /(?:^|_)(damaged?|destroyed|gibs?)$/i.exec(clean(n.getName()));
      const state = sm ? '_' + sm[1] : '';
      n.setName(a.name + state); n.getMesh().setName(a.name + state);
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
    let bone = root.listNodes().find((n) => n.getName() === a.bone);
    if (!bone) { console.warn(`${id}: bone ${a.bone} not found; ${a.name} skipped`); moved.get(aScene)?.dispose(); continue; }
    if (a.offset || a.turn || a.roll || a.rot) {
      const holder = doc.createNode(`${a.name}_mount`).setTranslation(a.offset || [0, 0, 0]);
      if (a.turn) holder.setRotation([0, 0, Math.sin((a.turn * Math.PI) / 360), Math.cos((a.turn * Math.PI) / 360)]);
      if (a.roll) holder.setRotation({ x: [1, 0, 0, 0], y: [0, 1, 0, 0], z: [0, 0, 1, 0] }[a.roll]); // upside down
      if (a.rot) { // [x, y, z] degrees in the bone's frame, applied x then y then z
        const q = (ax, deg) => { const h = (deg * Math.PI) / 360, v = [0, 0, 0, Math.cos(h)]; v[ax] = Math.sin(h); return v; };
        const mul = (a1, b1) => [
          a1[3] * b1[0] + a1[0] * b1[3] + a1[1] * b1[2] - a1[2] * b1[1], a1[3] * b1[1] - a1[0] * b1[2] + a1[1] * b1[3] + a1[2] * b1[0],
          a1[3] * b1[2] + a1[0] * b1[1] - a1[1] * b1[0] + a1[2] * b1[3], a1[3] * b1[3] - a1[0] * b1[0] - a1[1] * b1[1] - a1[2] * b1[2]];
        holder.setRotation(mul(q(2, a.rot[2]), mul(q(1, a.rot[1]), q(0, a.rot[0]))));
      }
      bone.addChild(holder);
      bone = holder;
    }
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
  const bodyMeshes = root.listNodes().filter((n) => n.getMesh() && !/shadow|collision|culling/i.test(n.getName()) && !gearNames.some((g) => n.getName().startsWith(g.name)));
  const bestLod = bodyMeshes.length ? Math.min(...bodyMeshes.map((n) => lodLevel(n.getName()))) : 0;
  const names = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const isGear = gearNames.some((g) => node.getName().startsWith(g.name));
    if (!isGear && (/shadow|collision|culling/i.test(node.getName()) || lodLevel(node.getName()) !== bestLod)) { node.dispose(); continue; }
    const raw = node.getName();
    const n = gearNames.some((a) => raw.startsWith(a.name)) ? raw : cfg.names?.[raw] || cfg.names?.[clean(raw)] || clean(raw);
    node.setName(n);
    mesh.setName(n);
    names.push(n);
  }
  for (const a of root.listAnimations()) a.dispose();

  // hash-named rigid boxes are the game's culling volumes (a dozen points each): not part of the body
  for (const node of root.listNodes()) {
    if (!node.getMesh() || node.getSkin() || !/^0x[0-9a-f]+$/i.test(node.getName())) continue;
    const pts = node.getMesh().listPrimitives().reduce((a, p) => a + (p.getAttribute('POSITION')?.getCount() || 0), 0);
    if (pts <= 36) { names.splice(names.indexOf(node.getName()), 1); node.dispose(); }
  }
  // weak spots inside a bigger mesh, cut out by box
  for (const cut of cfg.cuts || []) {
    const node = root.listNodes().find((x) => x.getMesh() && x.getName() === cut.mesh);
    if (!node) { console.warn(`${id}: no mesh ${cut.mesh} to cut`); continue; }
    const made = cutBox(doc, node, cut);
    if (cut.rest && made.length) names[names.indexOf(cut.mesh)] = cut.rest, made.pop();
    names.push(...made);
  }
  // tails: armor plates and soft body apart (plates of a damage-state copy are dropped)
  if (cfg.shells) {
    const byName = (nm) => root.listNodes().find((x) => x.getMesh() && x.getName() === nm);
    const plateBoxes = (nm) => byName(nm)?.getMesh().listPrimitives().flatMap((p) => shellsOf(p).slice(1).map((x) => x.box)) || [];
    const likes = Object.fromEntries(cfg.shells.filter((sp) => sp.dropLike).map((sp) => [sp.mesh, plateBoxes(sp.dropLike)]));
    for (const sp of cfg.shells) {
      const node = byName(sp.mesh);
      if (!node) { console.warn(`${id}: no mesh ${sp.mesh} to split`); continue; }
      const added = splitShells(doc, node, sp, likes[sp.mesh]);
      names[names.indexOf(sp.mesh)] = sp.main;
      names.push(...added);
    }
  }
  // one-mesh bodies (and, with skinnedHash, hash-named skinned bodies): split by bone into named pieces
  if (cfg.split) {
    const want = (n) => cfg.split.mesh.test(n.getName()) || (cfg.split.skinnedHash && n.getSkin() && /^(0x[0-9a-f]+|udim \d+)$/i.test(n.getName()));
    for (const node of root.listNodes().filter((n) => n.getMesh() && want(n))) {
      const at = names.indexOf(node.getName());
      if (at >= 0) names.splice(at, 1);
      names.push(...splitByBone(doc, node, cfg.split.bones));
    }
  }
  // hash-named meshes (new maps only, so saved maps keep their keys): name them after their main bone
  const mapExists = fs.existsSync(path.join(ROOT, 'models', `${id}.map.json`));
  // (also on rebuilds when the saved map already uses the bone names)
  const mapUsesBones = mapExists && Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'models', `${id}.map.json`), 'utf8')).meshes || {}).some((k) => k.startsWith('b_'));
  if ((!mapExists || mapUsesBones) && cfg.boneNames !== false) {
    const taken = new Set(names);
    for (const node of root.listNodes()) {
      if (!node.getMesh() || !/^(0x[0-9a-f]+|udim \d+)$/i.test(node.getName())) continue;
      const bone = mainBone(node, doc);
      if (!bone) continue;
      let nm = `b_${bone}`, k = 2;
      while (taken.has(nm)) nm = `b_${bone}_${k++}`;
      taken.add(nm);
      names[names.indexOf(node.getName())] = nm;
      node.setName(nm); node.getMesh().setName(nm);
    }
  }

  await doc.transform(
    unpartition(), // merged gear brings its own buffer; a .glb holds one
    prune(),
    dedup({ keepUniqueNames: true }), // two copies of one gear model keep their own names (left / right guns)
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
    // gear damage-state pieces start hidden here too
    for (const n of names) if (gearNames.some((a) => n.startsWith(a.name)) && HIDE.test(n) && !map.hidden.includes(n)) map.hidden.push(n);
    fs.writeFileSync(mapPath, JSON.stringify(map, null, 2) + '\n');
    note = `kept existing map${added.length ? '; added ' + added.join(', ') : ''}`;
  } else if (!fs.existsSync(mapPath)) {
    const map = { enemy: id, meshes: {}, hidden: [] };
    for (const n of names) {
      const key = cfg.boneGroups && n.startsWith('b_') ? cfg.boneGroups(n.slice(2).replace(/_\d+$/, '')) : n;
      const rule = cfg.rules.find(([re]) => re.test(key));
      const gear = gearNames.find((a) => a.name === n && a.part);
      if (!gear && gearNames.some((a) => n.startsWith(a.name)) && HIDE.test(n)) map.hidden.push(n);
      if (gear) map.meshes[n] = gear.part;
      else if (rule) map.meshes[n] = rule[1];
      if (HIDE.test(n) || cfg.hide?.includes(n)) map.hidden.push(n);
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
