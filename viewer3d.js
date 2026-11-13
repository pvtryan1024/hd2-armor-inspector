/* 3D hitzone viewer. Loads models/<enemy-id>.glb plus an optional models/<enemy-id>.map.json that
 * links mesh names to wiki hitzone names. Meshes are coloured with the same penetration / shots-to-kill
 * colours as the body map. "Edit hitzones" lets you click meshes and assign them to parts by hand.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const HD2 = window.HD2;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SERVED = location.protocol.startsWith('http');
const UNMAPPED = new THREE.Color('#39414b');
const OTHER_PART = new THREE.Color('#8b949e'); // editing: meshes of the parts that aren't selected

const host = $('#v3Canvas');
const status = (t) => { $('#v3Status').textContent = t; };

/* ---------- scene ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 2000);
camera.position.set(4, 3, 6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x1a1f26, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(5, 10, 7);
scene.add(sun);
const rim = new THREE.DirectionalLight(0xffe710, 0.6);
rim.position.set(-6, 4, -8);
scene.add(rim);
const grid = new THREE.GridHelper(40, 40, 0x323c47, 0x1d242c);
scene.add(grid);
// the ground around the enemy's feet: with an explosive weapon in Fire mode a press there is a ground shot
// (the blast goes up into the enemy); everywhere else, and with any other weapon, a press rotates the camera
const ground = new THREE.Group();
const groundDisc = new THREE.Mesh(new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffe710, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide }));
const groundRing = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 96).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffe710, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
ground.add(groundDisc, groundRing);
ground.visible = false;
scene.add(ground);
const groundActive = () => !!(current && !editing && lastDetail?.fire && lastDetail.explosive);

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);

const hpCard = document.createElement('div');
hpCard.className = 'v3-hpcard hidden';
host.appendChild(hpCard);
const hpAt = new THREE.Vector3();
let hpKey = '';

function updateHpCard() {
  const hp = lastDetail?.fire && !editing ? lastDetail.hitHp : null;
  const pt = lastDetail?.hit?.point;
  if (!hp || !pt || !current) { hpCard.classList.add('hidden'); return; }
  const key = JSON.stringify(hp);
  if (key !== hpKey) {
    hpKey = key;
    const bar = hp.cons != null ? `<div class="hpbar cons"><b style="width:${hp.cons * 100}%"></b></div>`
      : `<div class="hpbar${hp.main ? ' main' : ''}"><b style="width:${hp.frac * 100}%"></b></div>`;
    hpCard.innerHTML = `<div class="hc-name">${hp.name}</div>${hp.gone ? '' : bar}<div class="hc-text${hp.gone ? ' gone' : ''}">${hp.text}</div>`;
  }
  hpAt.fromArray(pt).project(camera);
  if (hpAt.z > 1) { hpCard.classList.add('hidden'); return; } // behind the camera
  const w = host.clientWidth, h = host.clientHeight;
  hpCard.style.left = `${((hpAt.x + 1) / 2) * w}px`;
  const top = ((1 - hpAt.y) / 2) * h;
  hpCard.style.top = `${top}px`;
  hpCard.classList.toggle('below', top - hpCard.offsetHeight - 22 < 4);
  hpCard.classList.remove('hidden');
}

(function loop() {
  requestAnimationFrame(loop);
  if (host.offsetParent === null) return; // hidden tab: skip work
  controls.update();
  renderer.render(scene, camera);
})();

/* ---------- model state ---------- */
// Draco + meshopt so compressed models (gltf-transform optimize) load too
const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
const EDITOR = document.body.classList.contains('editor');
const KNOWN = window.HD2_DATA?.models || {};
const cache = new Map(); // enemyId -> { root, meshes: [{ key, mesh }], map: { meshes: {key: partName}, hidden: [] } }
let current = null;      // cache entry on screen
let currentId = null;
let lastDetail = null;
let editing = false;
let selectedKey = null;
let showTex = false;

// "Torso_Armor_1", "Leg Flesh.003", "Head_LOD0#2" → "torsoarmor", "legflesh", "head"
const norm = (s) => String(s || '').toLowerCase()
  .replace(/#\d+$/, '').replace(/\(\d+\)/g, '')
  .replace(/([._ -]?lod\d+)$/i, '').replace(/[._ -]\d+$/, '')
  .replace(/[^a-z0-9]/g, '');

/** A mesh the map marks "not a hitzone" (null): drawn, but no hitbox at all, so shots, blasts and shrapnel
 *  pass through it (the Caustic Charger's spores). Unassigned meshes (no entry) still block. */
function noHitbox(entry, key) {
  const m = entry?.map.meshes || {};
  return (key in m ? m[key] : m[key.replace(/(_d+|#d+)$/, '')]) === null;
}

function partIndexFor(entry, key) {
  const parts = lastDetail?.enemy.parts || [];
  // a multi-material mesh loads as numbered sub-meshes ("wing_left_1"): fall back to its own name
  const name = key in entry.map.meshes ? entry.map.meshes[key] : entry.map.meshes[key.replace(/(_\d+|#\d+)$/, '')];
  if (name === null) return -1; // explicitly marked "not a hitzone"
  // an unmapped "_damaged" mesh is the same hitzone as its intact mesh ("leg_left_damaged" → "leg_left")
  if (name === undefined && /_damaged?$/i.test(primOf(key))) {
    const b = primOf(key).replace(/_damaged?$/i, '');
    if (entry.map.meshes[b]) return parts.findIndex((p) => p.name === entry.map.meshes[b]);
  }
  if (name) {
    const i = parts.findIndex((p) => p.name === name);
    if (i >= 0) return i;
  }
  // auto-link meshes already named after a wiki part
  const n = norm(key);
  return n ? parts.findIndex((p) => norm(p.name) === n) : -1;
}

const VARIANT = /_(damaged?|gibs?|destroyed|hurt)$/i;
// a mesh with several materials loads as numbered sub-meshes ("right_front_leg_1", "_2"): same piece
const primOf = (key) => key.replace(/_\d+$/, '');
// "head_whole" (intact, Automaton models) and "head_destroyed" are the same piece as "head"
const baseOf = (key) => primOf(key).replace(VARIANT, '').replace(/_whole$/i, '');
const stageOf = (key) => { const p = primOf(key); return /_damaged?$/i.test(p) ? 1 : /_(gibs?|destroyed)$/i.test(p) ? 2 : /_hurt$/i.test(p) ? 3 : 0; };

/** Which piece of a counted part a mesh is: pieces ordered by base name (left before right), so a
 *  mesh and its _damaged / _gib versions always count as the same piece. */
function instanceFor(entry, key, i) {
  const n = lastDetail?.enemy.parts[i]?.count || 1;
  if (n < 2) return null;
  const bases = [...new Set(entry.meshes.map((m) => m.key).filter((k) => partIndexFor(entry, k) === i).map(baseOf))].sort();
  // pieces in several bits (Overseer upper + lower leg, a Warrior leg in 3 segments): side and position
  // in the name decide the piece (l/left, r/right × front/fore, back/rear/hind)
  const tok = (b) => {
    const side = /(^|_)(l|left)(_|$)/i.test(b) ? 'l' : /(^|_)(r|right)(_|$)/i.test(b) ? 'r' : '';
    const pos = /(front|fore)/i.test(b) ? 'f' : /(back|rear|hind)/i.test(b) ? 'b' : '';
    return side ? side + pos : '';
  };
  if (bases.length > n && bases.every((b) => tok(b))) {
    const keys = [...new Set(bases.map(tok))].sort();
    if (keys.length === n) return keys.indexOf(tok(baseOf(key)));
  }
  const at = bases.indexOf(baseOf(key));
  return at < 0 ? null : at % n;
}

/** Freeze a skinned mesh in its current pose as a plain mesh. The exports are skinned (and their positions
 *  quantized), so the raw geometry is not where the mesh is drawn; picking, bounds and blast distances
 *  need the posed shape. The models never animate, so nothing is lost. */
function bakeSkin(sm) {
  const g = sm.geometry;
  const pos = g.attributes.position, nor = g.attributes.normal;
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  sm.skeleton.update();
  const bones = sm.skeleton.boneMatrices; // bone.matrixWorld × boneInverse, packed
  const P = new Float32Array(pos.count * 3), N = nor ? new Float32Array(nor.count * 3) : null;
  const m = new THREE.Matrix4(), b = new THREE.Matrix4(), v = new THREE.Vector3(), n = new THREE.Vector3(), nm3 = new THREE.Matrix3();
  for (let i = 0; i < pos.count; i++) {
    m.multiplyScalar(0).elements.fill(0);
    for (let j = 0; j < 4; j++) {
      const w = sw.getComponent(i, j);
      if (!w) continue;
      b.fromArray(bones, si.getComponent(i, j) * 16);
      for (let e = 0; e < 16; e++) m.elements[e] += b.elements[e] * w;
    }
    m.premultiply(sm.bindMatrixInverse).multiply(sm.bindMatrix);
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    P.set([v.x, v.y, v.z], i * 3);
    if (N) {
      n.fromBufferAttribute(nor, i).applyMatrix3(nm3.getNormalMatrix(m)).normalize();
      N.set([n.x, n.y, n.z], i * 3);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  if (N) out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  for (const k of Object.keys(g.attributes)) if (/^(uv|uv\d|color)/.test(k)) out.setAttribute(k, g.attributes[k]);
  if (g.index) out.setIndex(g.index);
  out.groups = g.groups;
  const mesh = new THREE.Mesh(out, sm.material);
  mesh.name = sm.name;
  mesh.position.copy(sm.position); mesh.quaternion.copy(sm.quaternion); mesh.scale.copy(sm.scale);
  sm.parent.add(mesh);
  sm.parent.remove(sm);
  return mesh;
}

function prepare(root) {
  root.updateMatrixWorld(true);
  const skinned = [];
  root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  skinned.forEach(bakeSkin);
  const meshes = [];
  const seen = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    let key = o.name || 'mesh';
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    if (n) key = `${key}#${n + 1}`;
    o.userData.key = key;
    o.geometry.computeBoundsTree();
    o.userData.orig = o.material;
    o.userData.hz = hitzoneMaterial();
    meshes.push({ key, mesh: o });
  });
  return meshes;
}

function frame() {
  if (!current) return;
  const box = new THREE.Box3();
  current.meshes.forEach(({ mesh }) => { if (mesh.visible) box.expandByObject(mesh); });
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z) || 1;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(r * 0.9, r * 0.5, r * 1.3));
  camera.near = r / 200; camera.far = r * 50; camera.updateProjectionMatrix();
  grid.position.y = box.min.y;
  grid.scale.setScalar(Math.max(0.1, r / 8));
  ground.position.set(center.x, box.min.y + 0.002, center.z);
  ground.scale.setScalar(Math.max(size.x, size.z) / 2 + 2); // its footprint plus 2 m
}

function show(entry) {
  if (current) { scene.remove(current.root); current.colliders?.forEach((c) => c.mesh.removeFromParent()); }
  current = entry;
  selectedKey = null;
  $('#v3Empty').classList.toggle('hidden', !!entry);
  $('#v3Id').textContent = currentId || '';
  if (!entry) { $('#v3Legend').classList.add('hidden'); status(SERVED ? '' : 'Open via "node serve.js" to auto-load models'); renderEditor(); return; }
  scene.add(entry.root);
  entry.colliders?.forEach((c) => scene.add(c.mesh));
  applyHidden();
  frame();
  paint();
  renderEditor();
  const linked = entry.meshes.filter(({ key }) => partIndexFor(entry, key) >= 0).length;
  status(`${entry.meshes.length} meshes · ${linked} linked to hitzones`);
}

/** Each piece with variants shows one mesh at a time, only for itself (never its partner):
 *  intact → stripped ("<name>_damaged": the flesh under the plate, shootable)
 *         → destroyed ("<name>_gib" / "_destroyed": grey remains, no hitbox).
 *  Outside fire mode every piece shows intact; the editor shows the map's own hidden list. */
const GIB = ['_gib', '_gibs', '_destroyed'];
/** Health gone but constitution left (Hulk legs): still a hitbox, drawn as its damaged mesh. */
function pieceBroken(key) {
  const i = partIndexFor(current, key);
  if (i < 0 || !lastDetail?.fire || !lastDetail.brokenInst?.[i]) return false;
  const k = instanceFor(current, key, i);
  return !!lastDetail.brokenInst[i][k ?? 0];
}
function pieceGone(key) {
  const i = partIndexFor(current, key);
  if (i < 0 || !lastDetail?.fire) return false;
  const k = instanceFor(current, key, i);
  return !!(k != null && lastDetail.goneInst?.[i] ? lastDetail.goneInst[i][k] : lastDetail.gone[i]);
}
function swapBroken() {
  if (!current || editing) return;
  const hidden = new Set(current.map.hidden);
  // group every mesh by piece: intact meshes, its _damaged meshes, its _gib / _destroyed meshes, and the
  // other half of a split mesh ("butt_plates" over "butt", "tail_sac", "chest_eye", "body_visor"): it goes with the piece's
  // remains, and plates also go when their own hitzone breaks (a sac waits for its burst replacement)
  const ATTACHED = /_(plates|sac|eye|visor)$/i;
  const vanishIdx = new Set((current.map.vanish || []).map((n) => (lastDetail?.enemy.parts || []).findIndex((p) => p.name === n)).filter((i) => i >= 0));
  const groups = new Map();
  for (const m of current.meshes) {
    const st = stageOf(m.key);
    if (st === 3) continue; // "_hurt": not used
    const att = st === 0 && ATTACHED.test(primOf(m.key));
    const b = baseOf(m.key).replace(ATTACHED, '');
    if (!groups.has(b)) groups.set(b, [[], [], [], []]);
    groups.get(b)[att ? 3 : st].push(m);
  }
  for (const [intact, dmg, gib, attached] of groups.values()) {
    for (const m of attached) if (!hidden.has(m.key)) m.mesh.visible = !(/_plates$/i.test(primOf(m.key)) && pieceGone(m.key));
    if (!dmg.length && !gib.length) continue;
    // the piece's own plate: intact meshes of its hitzone (a spore blob of another hitzone stays put)
    // (a "vanish" part sharing the mesh, like the spore coat on the Caustic Charger's head, never decides it)
    const linked = intact.filter((m) => !hidden.has(m.key) && partIndexFor(current, m.key) >= 0 && !vanishIdx.has(partIndexFor(current, m.key)));
    if (!linked.length) continue;
    const i = partIndexFor(current, linked[0].key);
    const mine = linked.filter((m) => partIndexFor(current, m.key) === i);
    // stage 0 intact · 1 stripped (flesh of another hitzone showing) · 2 destroyed
    let stage = 0;
    if (pieceGone(mine[0].key)) {
      // any damaged sub-mesh that is another live hitzone reveals it (the rest of them show as remains)
      stage = dmg.some((d) => { const di = partIndexFor(current, d.key); return di >= 0 && di !== i && !pieceGone(d.key); }) ? 1 : 2;
    }
    // broken (health gone, constitution left): the damaged mesh takes over as the same live hitzone
    const broken = stage === 0 && dmg.length && pieceBroken(mine[0].key) && partIndexFor(current, dmg[0].key) === i;
    const remains = stage === 2 ? (gib.length ? gib : dmg.length ? dmg : null) : null;
    for (const m of mine) { m.mesh.visible = (stage === 0 && !broken) || (stage === 2 && !remains); m.mesh.userData.remains = stage === 2 && !remains; }
    for (const m of dmg) {
      const di = partIndexFor(current, m.key), live = di >= 0 && di !== i && !pieceGone(m.key);
      m.mesh.visible = stage === 1 || broken || remains === dmg;
      m.mesh.userData.revealed = stage === 1 && live;
      m.mesh.userData.remains = remains === dmg || (stage === 1 && !live);
    }
    for (const m of gib) { m.mesh.visible = remains === gib; m.mesh.userData.remains = remains === gib; m.mesh.userData.revealed = false; }
    // keepsHitbox (Hulk legs): what's left of a destroyed piece still stops rounds and blasts, taking no damage
    const keep = !!lastDetail?.enemy.parts[i]?.keepsHitbox;
    for (const m of [...mine, ...dmg, ...gib]) m.mesh.userData.deadHitbox = keep && !!m.mesh.userData.remains && m.mesh.visible;
    if (stage === 2) for (const m of attached) m.mesh.visible = false;
  }
  // map "vanish": [part…]: those parts leave nothing behind (Caustic Charger spore sacs): each piece disappears
  // when its health runs out, a mesh of the whole part once every piece is gone
  for (const name of current.map.vanish || []) {
    const i = (lastDetail?.enemy.parts || []).findIndex((p) => p.name === name);
    if (i < 0 || !lastDetail?.fire) continue;
    for (const m of current.meshes) {
      if (partIndexFor(current, m.key) !== i) continue;
      const k = instanceFor(current, m.key, i);
      const inst = lastDetail.goneInst?.[i];
      if (k != null && inst ? inst[k] : lastDetail.gone[i]) m.mesh.visible = false;
    }
  }
  // map "opens": [{ mesh, part, pieces }]: a lid that opens (disappears, letting shots through) once all those
  // pieces of that part are gone: the Vox Engine's hatch lids, each over its three vents
  for (const o of current.map.opens || []) {
    const i = (lastDetail?.enemy.parts || []).findIndex((p) => p.name === o.part);
    const inst = lastDetail?.fire && i >= 0 ? lastDetail.goneInst?.[i] : null;
    const open = !!inst && o.pieces.every((k) => inst[k]);
    for (const m of current.meshes) {
      if (primOf(m.key) !== o.mesh && m.key !== o.mesh) continue;
      if (!o.hinge) { m.mesh.visible = !open && !current.map.hidden.includes(m.key); continue; }
      // hinge: { at: [x, y, z], axis: [x, y, z], angle }: the lid swings open about that line (model space)
      // instead of vanishing; swung up it no longer covers the hatch
      const mesh = m.mesh;
      mesh.userData.base ??= mesh.matrix.clone();
      const M = mesh.userData.base.clone();
      if (open) {
        const [x, y, z] = o.hinge.at;
        M.multiply(new THREE.Matrix4().makeTranslation(x, y, z))
          .multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...(o.hinge.axis || [1, 0, 0])).normalize(), THREE.MathUtils.degToRad(o.hinge.angle)))
          .multiply(new THREE.Matrix4().makeTranslation(-x, -y, -z));
      }
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(M);
      mesh.matrixWorldNeedsUpdate = true;
    }
  }
  // map "after": { mesh: { part, replaces: [mesh…] } }: a mesh that takes over from others once a part dies
  // (Bile Titan: the burst-sac butt replaces the butt when the Lower Sac pops), while those still show intact
  const parts = lastDetail?.enemy.parts || [];
  for (const [key, rule] of Object.entries(current.map.after || {})) {
    const pi = parts.findIndex((p) => p.name === rule.part);
    const dead = !!(lastDetail?.fire && pi >= 0 && lastDetail.gone[pi]);
    const live = current.meshes.filter((m) => (rule.replaces || []).includes(primOf(m.key)) && m.mesh.visible && !m.mesh.userData.remains);
    const on = dead && live.length > 0;
    // mapped to another live hitzone it is that hitzone, revealed (the burst Lower Sac is the Underside, which
    // feeds Main); otherwise it shows as remains of the dead part (grey, no hitbox)
    for (const m of current.meshes) {
      if (primOf(m.key.replace(/#\d+$/, '')) !== key) continue;
      const mi = partIndexFor(current, m.key);
      const live = mi >= 0 && mi !== pi && !lastDetail.gone[mi];
      m.mesh.visible = on;
      m.mesh.userData.remains = on && !live;
      m.mesh.userData.revealed = on && live;
    }
    if (on) live.forEach((m) => { m.mesh.visible = false; });
  }
}

function applyHidden() {
  const hidden = new Set(current?.map.hidden || []);
  current?.meshes.forEach(({ key, mesh }) => { mesh.visible = !hidden.has(key); });
}

function parseGlb(buf) {
  return new Promise((res, rej) => loader.parse(buf, '', res, rej));
}

async function loadForEnemy(id) {
  currentId = id;
  if (cache.has(id)) { show(cache.get(id)); return; }
  show(null);
  if (!SERVED) return;
  if (!EDITOR && !KNOWN[id]) return; // published site: only request models that exist
  $('#v3Empty').classList.add('hidden');
  status('Loading model…');
  try {
    const gltf = await new Promise((res, rej) => loader.load(`models/${encodeURIComponent(id)}.glb`, res,
      (p) => { if (currentId === id && p.total) status(`Loading model… ${Math.round((p.loaded / p.total) * 100)}%`); }, rej));
    let map = { meshes: {}, hidden: [] };
    const m = await fetch(`models/${encodeURIComponent(id)}.map.json`, { cache: 'no-store' }).catch(() => null);
    if (m && m.ok) map = { meshes: {}, hidden: [], ...(await m.json()) };
    const entry = { root: gltf.scene, meshes: prepare(gltf.scene), map };
    cache.set(id, entry);
    if (currentId === id) { show(entry); buildColliders(entry); }
  } catch (err) {
    if (currentId !== id) return;
    // a 404 just means no model yet
    if (String(err?.message || err).includes('404')) { status(''); $('#v3Empty').classList.remove('hidden'); return; }
    console.error(err);
    status('Failed to load model — see console');
    $('#v3Empty').classList.remove('hidden');
  }
}

/* ---------- colouring ----------
 * In penetration mode every pixel picks its own AP from the angle between the camera ray and the
 * surface normal (same bands as the weapon card), then compares it with the part's AV — like the
 * tank inspector, rotating the model changes what penetrates. Shots-to-kill mode uses flat colours. */
const PEN = { full: new THREE.Color('#2fbf71'), half: new THREE.Color('#c2dc35'), none: new THREE.Color('#e0412f'), immune: new THREE.Color('#4a525c') };

function hitzoneMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: UNMAPPED, roughness: 0.55, metalness: 0.1, transparent: true });
  const u = {
    uAP: { value: new THREE.Vector4() },
    uMax: { value: new THREE.Vector3(25, 60, 80) },
    uAV: { value: 0 },
    uAngle: { value: 0 },
    uFlat: { value: new THREE.Color() },
    uFull: { value: PEN.full }, uHalf: { value: PEN.half }, uNone: { value: PEN.none }, uImmune: { value: PEN.immune },
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec4 uAP; uniform vec3 uMax; uniform float uAV; uniform float uAngle;
        uniform vec3 uFlat; uniform vec3 uFull; uniform vec3 uHalf; uniform vec3 uNone; uniform vec3 uImmune;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          #ifdef FLAT_SHADED
            vec3 hzN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
          #else
            vec3 hzN = normalize(vNormal);
          #endif
          float hzDeg = degrees(acos(clamp(abs(dot(hzN, normalize(vViewPosition))), 0.0, 1.0)));
          float hzAP = hzDeg <= uMax.x ? uAP.x : hzDeg <= uMax.y ? uAP.y : hzDeg <= uMax.z ? uAP.z : uAP.w;
          vec3 hzCol = uFlat;
          if (uAngle > 0.5) {
            if (uAV < -0.5 || uAV > 10.5) hzCol = uImmune;
            else if (hzAP > uAV + 0.5) hzCol = uFull;
            else if (hzAP > uAV - 0.5) hzCol = uHalf;
            else hzCol = uNone;
          }
          diffuseColor.rgb = hzCol;
        }`);
  };
  mat.customProgramCacheKey = () => 'hd2-hitzone';
  return mat;
}

// editing with a mesh selected: how see-through every other part is
const DIM = 0.12;
function paint() {
  if (!current || !lastDetail) return;
  const { colors, gone, goneInst, colorMode, ap4, avs, bands } = lastDetail;
  applyHidden();
  swapBroken();
  ground.visible = groundActive();
  const angleMode = colorMode === 'pen' && !!ap4;
  // editing: only the selected mesh's part keeps its colour; the other parts go plain grey
  const selPart = editing && selectedKey ? partIndexFor(current, selectedKey) : -1;
  for (const { key, mesh } of current.meshes) {
    if (showTex && !editing) { mesh.material = mesh.userData.orig; continue; }
    const i = partIndexFor(current, key);
    const mat = mesh.userData.hz;
    const u = mat.userData.u;
    mesh.material = mat;
    if (mesh.userData.remains && !editing) { // what's left of a destroyed piece: visible, but no hitbox
      u.uAngle.value = 0;
      u.uFlat.value.copy(UNMAPPED);
      mat.opacity = 0.4;
    } else if (i >= 0 && editing && i !== selPart) {
      u.uAngle.value = 0;
      u.uFlat.value.copy(OTHER_PART);
      mat.opacity = selectedKey ? DIM : 1; // see-through while a mesh is selected, so the selected part stands out
    } else if (i >= 0) {
      u.uAngle.value = angleMode ? 1 : 0;
      u.uFlat.value.set(colors[i]);
      if (ap4) u.uAP.value.set(...ap4);
      u.uAV.value = avs[i];
      const k = goneInst?.[i] ? instanceFor(current, key, i) : null;
      mat.opacity = (k != null ? goneInst[i][k] : gone[i]) ? 0.15 : 1;
      // map glass: a see-through part (the Grounded Warp Ship's shield bubble), still hit by shots
      if (current.map.glass?.includes(lastDetail.enemy.parts[i]?.name)) mat.opacity = Math.min(mat.opacity, 0.3);
    } else {
      u.uAngle.value = 0;
      u.uFlat.value.copy(UNMAPPED);
      mat.opacity = editing ? (selectedKey && key !== selectedKey ? DIM : 0.9) : 0.5;
    }
    if (bands) u.uMax.value.set(bands[0].max, bands[1].max, bands[2].max);
    mat.depthWrite = mat.opacity >= 1;
    mat.emissive.set(editing && key === selectedKey ? 0xffe710 : 0x000000);
    mat.emissiveIntensity = editing && key === selectedKey ? 0.6 : 0;
  }
  const lg = $('#v3Legend');
  lg.classList.toggle('hidden', !angleMode || editing || showTex);
  if (angleMode) {
    lg.innerHTML = `Colours follow the impact angle from your camera<br>` +
      bands.map((b, k) => `${b.name.replace(' angle', '')} ${b.range}: <b>AP ${ap4[k]}</b>`).join(' · ');
  }
}

/* ---------- inner hitboxes ----------
 * Invisible shapes for hitboxes that have no mesh (e.g. a Charger's Inner Flesh), saved in the map as
 * colliders: [{ part, from: [x,y,z], to: [x,y,z], radius }], or a box: { part, shape: 'box', centre, size }.
 * Normally only over-penetrating shots look for them; direct: true also takes plain shots (the Barrager's
 * launch tubes, reached through the openings at the front and back of its pod). detonate: true is a trigger
 * plane: an explosive round or grenade goes off on it instead of glancing off what's behind (inside the
 * Fabricator's vents); other weapons, blasts and shrapnel pass through it.
 * Without a saved one, a Charger-style model gets a cylinder from its head to its butt. Shown as a
 * wireframe while editing hitzones. */
const colliderMat = new THREE.MeshBasicMaterial({ color: 0xffe710, wireframe: true, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthTest: false });

function defaultColliders(entry) {
  const parts = lastDetail?.enemy.parts || [];
  const inner = parts.find((p) => /^inner flesh$/i.test(p.name));
  // the intact head / butt, including numbered sub-meshes ("head_1", "head_2" on multi-material models)
  const box = (name) => {
    const b = new THREE.Box3();
    entry.meshes.forEach(({ key, mesh }) => { if (primOf(key) === name) b.expandByObject(mesh); });
    return b.isEmpty() ? null : b.getCenter(new THREE.Vector3());
  };
  const a = box('head'), b = box('butt');
  if (!inner || !a || !b) return [];
  const from = a.clone().lerp(b, 0.15), to = a.clone().lerp(b, 0.85); // trimmed so it stays inside the body
  return [{ part: inner.name, from: from.toArray(), to: to.toArray(), radius: +(a.distanceTo(b) * 0.2).toFixed(3), auto: true }];
}

function buildColliders(entry) {
  if (entry.colliders) entry.colliders.forEach((c) => c.mesh.removeFromParent());
  const defs = entry.map.colliders?.length ? entry.map.colliders : defaultColliders(entry);
  entry.colliders = defs.map((c) => {
    let mesh;
    if (c.shape === 'box') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(...c.size), colliderMat);
      mesh.position.fromArray(c.centre);
    } else {
      const from = new THREE.Vector3().fromArray(c.from), to = new THREE.Vector3().fromArray(c.to);
      const len = from.distanceTo(to);
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(c.radius, c.radius, len, 16, 1), colliderMat);
      mesh.position.copy(from).lerp(to, 0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    }
    mesh.userData.key = c.part; // a mesh named after a part links to it
    mesh.renderOrder = 20;
    mesh.userData.collider = c;
    scene.add(mesh);
    return { def: c, mesh };
  });
  showColliders();
}
/** Colliders that take plain shots and blasts (direct: true), with their matrices current. */
const directColliders = () => (current?.colliders || []).filter((c) => c.def.direct).map((c) => { c.mesh.updateMatrixWorld(); return c.mesh; });
/** Trigger planes explosive rounds go off on (detonate: true); none for other weapons. */
const detonators = () => (lastDetail?.explosive ? (current?.colliders || []).filter((c) => c.def.detonate).map((c) => { c.mesh.updateMatrixWorld(); return c.mesh; }) : []);
const showColliders = () => current?.colliders?.forEach(({ mesh }) => { mesh.visible = editing; });

/** Over-penetration target along the shot: the first inner hitbox the ray passes through behind the impact. */
const thruRay = new THREE.Raycaster();
/** Overpenetration follows the shot's own path: the next hitzone piece along the line after the struck one
 *  (another part's mesh, a revealed flesh mesh, or an invisible inner collider), with its distance past the
 *  impact. Whether the round actually gets through is the cleave rule's call (app.js overpen). The struck
 *  piece's own meshes (its back side) are passed over; meshes that aren't hitzones don't stop it. */
function thruAlong(h) {
  if (!current) return null;
  const dir = h.point.clone().sub(h.origin).normalize();
  thruRay.set(h.point.clone().addScaledVector(dir, 1e-3), dir);
  thruRay.far = Infinity;
  const i0 = partIndexFor(current, h.mesh.userData.key), k0 = instanceFor(current, h.mesh.userData.key, i0);
  const live = current.meshes.map((m) => m.mesh).filter((m) => m.userData.deadHitbox || (m.visible && m.material.opacity > 0.2 && !m.userData.remains && !noHitbox(current, m.userData.key)));
  const cols = (current.colliders || []).filter((c) => !c.def.detonate).map((c) => c.mesh);
  const vis = cols.map((m) => m.visible);
  cols.forEach((m) => { m.visible = true; });
  const hits = thruRay.intersectObjects([...live, ...cols], false).sort((a, b) => a.distance - b.distance);
  cols.forEach((m, i) => { m.visible = vis[i]; });
  const parts = lastDetail?.enemy.parts || [];
  for (const x of hits) {
    let idx, k = null;
    if (x.object.userData.collider) idx = parts.findIndex((p) => p.name === x.object.userData.collider.part);
    else { idx = partIndexFor(current, x.object.userData.key); if (idx >= 0) k = instanceFor(current, x.object.userData.key, idx); }
    if (idx < 0 || (idx === i0 && k === k0)) continue;
    if (x.distance < 0.02) continue; // overlapping the struck surface (spores grown on the butt): not behind it
    return { idx, k, d: x.distance };
  }
  return null;
}

/* ---------- explosions ----------
 * Blast rays leave the impact point along a dodecahedron's 20 corners, 12 face centres and 30 edge midpoints (62, evenly spread). Each ray ends at
 * the first hitzone it meets inside the outer radius; that piece takes blast damage at that distance (full
 * inside the inner radius, falling off out to the outer). A ray that meets nothing does nothing, and parts
 * shielded by others aren't reached. A piece hit by several rays counts once, at its nearest distance. */
const PHI = (1 + Math.sqrt(5)) / 2;
const DODECA = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) DODECA.push(new THREE.Vector3(x, y, z));
for (const a of [-1, 1]) for (const b of [-1, 1]) {
  DODECA.push(new THREE.Vector3(0, a / PHI, b * PHI), new THREE.Vector3(a / PHI, b * PHI, 0), new THREE.Vector3(a * PHI, 0, b / PHI));
}
// tripled for smaller gaps: + the 12 face centres and the 30 edge midpoints (62 evenly spread rays)
{
  const corners = DODECA.slice();
  const edge = Math.min(...corners.flatMap((p, i) => corners.slice(i + 1).map((q) => p.distanceTo(q))));
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      if (Math.abs(corners[i].distanceTo(corners[j]) - edge) < 1e-6) DODECA.push(corners[i].clone().add(corners[j]));
    }
  }
  for (const [x, y, z] of [[0, 1, PHI], [0, -1, PHI], [0, 1, -PHI], [0, -1, -PHI], [1, PHI, 0], [-1, PHI, 0], [1, -PHI, 0], [-1, -PHI, 0], [PHI, 0, 1], [-PHI, 0, 1], [PHI, 0, -1], [-PHI, 0, -1]]) {
    DODECA.push(new THREE.Vector3(x, y, z)); // icosahedron corners = dodecahedron face centres
  }
}
DODECA.forEach((v) => v.normalize());
const blastRay = new THREE.Raycaster();
blastRay.firstHitOnly = true;

/** Evenly spread directions (Fibonacci sphere). */
function fibDirs(n) {
  const out = [], ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y);
    out.push(new THREE.Vector3(Math.cos(i * ga) * r, y, Math.sin(i * ga) * r));
  }
  return out;
}
/** Shrapnel: one ray per fragment from the burst, each hitting the first piece in its way at its own angle.
 *  "surface" spread (Eruptor): a half sphere pointing into the surface that was hit; "sphere" (flak): all round. */
function shrapnelHits(h, spec) {
  if (!spec?.count) return null;
  const into = h.ground ? new THREE.Vector3(0, 1, 0) : h.normal.clone().negate();
  let dirs;
  if (spec.spread === 'surface') {
    dirs = fibDirs(spec.count * 2).filter((d) => d.dot(into) > 0).slice(0, spec.count);
  } else dirs = fibDirs(spec.count);
  const targets = [...current.meshes.map((m) => m.mesh).filter((m) => m.userData.deadHitbox || (m.visible && m.material.opacity > 0.2 && !m.userData.remains && !noHitbox(current, m.userData.key))), ...directColliders()];
  const origin = h.point.clone().addScaledVector(h.normal, 0.02);
  const out = [];
  blastRay.far = spec.range || 7;
  for (const dir of dirs) {
    blastRay.set(origin, dir);
    const first = blastRay.intersectObjects(targets, false)[0];
    if (!first) continue;
    const idx = partIndexFor(current, first.object.userData.key);
    if (idx < 0) continue;
    let deg = 0;
    if (first.face) {
      const fnrm = first.face.normal.clone().applyMatrix3(nm.getNormalMatrix(first.object.matrixWorld)).normalize();
      deg = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(fnrm.dot(dir)))));
    }
    out.push({ idx, k: instanceFor(current, first.object.userData.key, idx), d: first.distance, deg });
  }
  return out;
}

/** Pellets (shotguns, the Variable's rounds): one ray per pellet, parallel to the shot. The first pellet goes where
 *  the cursor is; the rest land uniformly inside the spread cone, 5 cm radius at 20 m (spec.dist = the range
 *  setting), around it. Each pellet hits the first piece in its way at its own angle; one that hits nothing misses. */
const PELLET_R20 = 0.05;
function pelletHits(h, spec) {
  if (!(spec?.count > 1) || h.ground) return null;
  const dir = h.point.clone().sub(h.origin).normalize();
  const rad = PELLET_R20 * Math.max(0, spec.dist || 0) / 20;
  // two directions across the shot
  const u = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  const v = new THREE.Vector3().crossVectors(dir, u);
  const targets = [...current.meshes.map((m) => m.mesh).filter((m) => m.userData.deadHitbox || (m.visible && m.material.opacity > 0.2 && !m.userData.remains && !noHitbox(current, m.userData.key))), ...directColliders()];
  const parts = lastDetail?.enemy.parts || [];
  const out = [];
  blastRay.far = Infinity;
  for (let n = 0; n < spec.count; n++) {
    const r = n === 0 ? 0 : rad * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
    const off = u.clone().multiplyScalar(r * Math.cos(a)).addScaledVector(v, r * Math.sin(a));
    blastRay.set(h.origin.clone().add(off), dir);
    const first = blastRay.intersectObjects(targets, false).sort((x, y) => x.distance - y.distance)[0];
    const at = h.point.clone().add(off).toArray();
    if (!first) { out.push({ idx: -1, k: null, deg: 0, at }); continue; }
    let idx, k = null;
    if (first.object.userData.collider) idx = parts.findIndex((p) => p.name === first.object.userData.collider.part);
    else { idx = partIndexFor(current, first.object.userData.key); if (idx >= 0) k = instanceFor(current, first.object.userData.key, idx); }
    let deg = 0;
    if (first.face) {
      const fnrm = first.face.normal.clone().applyMatrix3(nm.getNormalMatrix(first.object.matrixWorld)).normalize();
      deg = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(fnrm.dot(dir)))));
    }
    out.push({ idx, k, deg, at: first.point.toArray(), revealed: !!first.object.userData.revealed });
  }
  return out;
}

/** Pieces an explosion reaches: every piece with surface inside the outer radius that the blast can see.
 *  A piece counts when a straight line from the blast centre reaches it (its closest point, or one of a
 *  spread of points on its surface) before any other mesh; it takes the blast at the distance of its
 *  nearest such point. Each piece of a counted part once. In game a 500 kg under a Bile Titan's belly
 *  reaches the legs, claws and sacs and kills it; one landing on its back mostly meets the back plates.
 *  A plate the impact breaks is not measured again: the model is a hollow shell, and in game the flesh
 *  under the plate fills that spot (it takes the explosion itself, see applyHit in app.js). */
const BLAST_SAMPLES = 24; // surface points tried per mesh besides its closest point
function blastHits(h, outer, inner = 0) {
  const out = new Map(); // "part:piece" -> { idx, k, d }
  if (!(outer > 0)) return [];
  const centre = h.point.clone().addScaledVector(h.normal, 0.01); // just off the surface that was struck
  // destroyed pieces: no hitbox (a dead hitbox, like a destroyed Hulk leg, still blocks the blast but isn't hurt)
  const live = (m) => m.userData.deadHitbox || (m.visible && m.material.opacity > 0.2 && !m.userData.remains && !noHitbox(current, m.userData.key));
  // what the blast can hit, and what blocks it; direct colliders too (the Barrager's launch tubes)
  const meshes = [...current.meshes.map((m) => m.mesh).filter(live), ...directColliders()];
  const pieceOf = (m) => { const i = partIndexFor(current, m.userData.key); return i < 0 ? null : `${i}:${instanceFor(current, m.userData.key, i)}`; };
  const local = new THREE.Vector3(), hitAt = { point: new THREE.Vector3() }, dir = new THREE.Vector3(), v3 = new THREE.Vector3();
  // can the blast see point p of this piece? (nothing else in the way; non-hitzone meshes block too)
  const sees = (p, id) => {
    const len = dir.copy(p).sub(centre).length();
    if (len < 1e-4) return true;
    blastRay.set(centre, dir.divideScalar(len));
    blastRay.far = len + 1e-3;
    const first = blastRay.intersectObjects(meshes, false)[0];
    return !first || first.distance >= len - 0.02 || pieceOf(first.object) === id;
  };
  for (const mesh of meshes) {
    if (mesh.userData.deadHitbox) continue;
    const idx = partIndexFor(current, mesh.userData.key);
    if (idx < 0) continue; // not a hitzone (still blocks)
    const id = pieceOf(mesh);
    mesh.updateMatrixWorld();
    let near;
    const pts = [];
    if (mesh.userData.collider) { // a box collider: its closest point, then points across its faces
      const box = new THREE.Box3().setFromObject(mesh);
      near = box.clampPoint(centre, new THREE.Vector3());
      if (near.distanceTo(centre) > outer) continue;
      pts.push(near);
      for (const fx of [0, 0.25, 0.5, 0.75, 1]) for (const fy of [0, 0.5, 1]) for (const fz of [0, 0.5, 1]) {
        const q = new THREE.Vector3(box.min.x + (box.max.x - box.min.x) * fx, box.min.y + (box.max.y - box.min.y) * fy, box.min.z + (box.max.z - box.min.z) * fz);
        if (q.distanceTo(centre) <= outer) pts.push(q);
      }
    } else {
      local.copy(centre);
      mesh.worldToLocal(local);
      if (!mesh.geometry.boundsTree?.closestPointToPoint(local, hitAt)) continue;
      near = mesh.localToWorld(hitAt.point.clone());
      if (near.distanceTo(centre) > outer) continue;
      // candidate points, nearest first: the closest point, then a spread of the mesh's vertices in range
      pts.push(near);
      const pos = mesh.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / BLAST_SAMPLES));
      for (let i = 0; i < pos.count; i += step) { v3.fromBufferAttribute(pos, i); mesh.localToWorld(v3); if (v3.distanceTo(centre) <= outer) pts.push(v3.clone()); }
    }
    pts.sort((p, q) => p.distanceTo(centre) - q.distanceTo(centre));
    // explosion verification (lastDetail.exvm): 'outer' lets the inner radius reach a piece without line of sight,
    // 'none' both radii; 'all' (default) needs it everywhere
    const exvm = lastDetail?.exvm || 'all';
    const free = (p) => exvm === 'none' || (exvm === 'outer' && p.distanceTo(centre) <= inner);
    const seen = pts.find((p) => free(p) || sees(p, id));
    if (!seen) continue;
    const d = seen.distanceTo(centre);
    const k = instanceFor(current, mesh.userData.key, idx);
    if (!out.has(id) || d < out.get(id).d) out.set(id, { idx, k, d });
  }
  return [...out.values()];
}

/** What destroying the struck piece uncovers (its "_damaged" flesh): if the impact breaks it, the explosion
 *  lands on exactly that piece (the leg flesh under this leg's plate). */
function brokenView(h) {
  const i = partIndexFor(current, h.mesh.userData.key), k = instanceFor(current, h.mesh.userData.key, i);
  const gone = new Set(current.meshes.filter(({ key }) => partIndexFor(current, key) === i && instanceFor(current, key, i) === k).map((m) => m.mesh));
  const bases = new Set([...gone].map((m) => baseOf(m.userData.key)));
  const revealed = current.meshes.filter(({ key }) => stageOf(key) === 1 && bases.has(baseOf(key)) && partIndexFor(current, key) >= 0).map((m) => m.mesh);
  return { gone, revealed };
}

/* ---------- picking ---------- */
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;
const ptr = new THREE.Vector2();
const nm = new THREE.Matrix3();
function pick(ev) {
  if (!current) return null;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  // use where things are now, not where they were last drawn (the camera keeps gliding after a drag)
  camera.updateMatrixWorld();
  current.root.updateMatrixWorld();
  ray.setFromCamera(ptr, camera);
  const direct = [...directColliders(), ...detonators()];
  const hits = ray.intersectObjects([...current.meshes.map((m) => m.mesh).filter((m) => m.visible), ...direct], false).sort((a, b) => a.distance - b.distance);
  // destroyed parts have no hitbox: the shot goes through to whatever is behind them
  const hit = hits.find((h) => h.object.userData.collider || h.object.userData.deadHitbox || (h.object.material.opacity > 0.2 && !h.object.userData.remains && !noHitbox(current, h.object.userData.key)));
  if (groundActive()) {
    ground.updateMatrixWorld();
    // one-sided: only a shot coming down from above lands on the ground; from below it passes through
    const g = ray.ray.direction.y < 0 && ray.ray.origin.y > ground.position.y ? ray.intersectObject(groundDisc, false)[0] : null;
    if (g && (!hit || g.distance < hit.distance)) {
      const up = new THREE.Vector3(0, 1, 0);
      const deg = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(up.dot(ray.ray.direction)))));
      return { ground: true, deg, point: g.point.clone(), normal: up, origin: ray.ray.origin.clone() };
    }
  }
  if (!hit) return null;
  let deg = 0;
  let n = ray.ray.direction.clone().negate();
  if (hit.face) {
    n = hit.face.normal.clone().applyMatrix3(nm.getNormalMatrix(hit.object.matrixWorld)).normalize();
    if (n.dot(ray.ray.direction) > 0) n.negate(); // face the shooter
    deg = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(n.dot(ray.ray.direction)))));
  }
  return { mesh: hit.object, deg, point: hit.point.clone(), normal: n, origin: ray.ray.origin.clone() };
}

// Press on the model = aim a shot there (the camera holds still); press on empty space = rotate the camera.
// Runs in the capture phase so it can switch OrbitControls off before they see the press.
let press = null;
let missAt = null;
renderer.domElement.parentElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || ev.target !== renderer.domElement) return;
  const h = pick(ev);
  press = h ? { x: ev.clientX, y: ev.clientY, h } : null;
  missAt = h ? null : [ev.clientX, ev.clientY];
  controls.enabled = !press;
}, true);
window.addEventListener('pointerup', (ev) => {
  if (missAt && Math.hypot(ev.clientX - missAt[0], ev.clientY - missAt[1]) < 4 && lastDetail?.fire) status('Missed: no part of the model under the cursor');
  missAt = null;
  if (!press) return;
  const p = press;
  press = null;
  controls.enabled = true;
  if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 40) return; // dragged well away: cancel the shot
  shoot(p.h);
});
let hoverEv = null;
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (ev.buttons) { HD2.hideTip(); return; }
  if (!hoverEv) requestAnimationFrame(() => { const e = hoverEv; hoverEv = null; hover(e); });
  hoverEv = ev;
});
function hover(ev) {
  const h = pick(ev);
  if (!h || h.ground) { HD2.hideTip(); return; }
  const i = partIndexFor(current, h.mesh.userData.key);
  if (editing) { status(`${h.mesh.userData.key}${i >= 0 ? ' → ' + lastDetail.enemy.parts[i].name : ' (unassigned)'}`); return; }
  HD2.hideTip();
  if (i >= 0) HD2.tip(i, ev.clientX, ev.clientY, { deg: h.deg });
}
renderer.domElement.addEventListener('pointerleave', () => HD2.hideTip());
/** Parts whose inside the explosion goes off in (map "inside": [{ part, centre, size }] boxes, model space):
 *  the Fabricator's vents only fall to a blast inside the duct, not one on its lid or outer wall. The blast
 *  centre is the impact point, a few cm off the surface it hit. */
function insideParts(h) {
  const boxes = current?.map?.inside;
  if (!boxes?.length) return [];
  const at = h.point.clone().addScaledVector(h.normal, 0.05);
  return [...new Set(boxes.filter((b) => [0, 1, 2].every((k) => Math.abs(at.getComponent(k) - b.centre[k]) <= b.size[k] / 2)).map((b) => b.part))];
}
function shoot(h) {
  if (h.ground) { // only the explosion (and shrapnel) reaches the enemy
    const blast = blastHits(h, lastDetail?.radii?.outer, lastDetail?.radii?.inner);
    const said = HD2.hit({ ground: true, idx: -1, k: null, blastHits: blast, inside: insideParts(h), shrapHits: shrapnelHits(h, lastDetail?.shrapnel), deg: h.deg, point: h.point.toArray(), normal: h.normal.toArray(), origin: h.origin.toArray() });
    if (said) status(said);
    return;
  }
  if (editing) {
    selectedKey = h.mesh.userData.key; renderEditor(); paint();
    if (lastDetail?.fire) status(`Editing hitzones: click selects "${selectedKey}". Turn off "Edit hitzones" to fire.`);
    return;
  }
  const i = partIndexFor(current, h.mesh.userData.key);
  if (i < 0) { status(`"${h.mesh.userData.key}" isn't linked to a hitzone yet (grey). Assign it in "Edit hitzones".`); return; }
  // blast rays from the impact point (the result of every press shows in the status line)
  const blast = blastHits(h, lastDetail?.radii?.outer, lastDetail?.radii?.inner);
  const bv = brokenView(h);
  // which piece of each part breaking the struck piece uncovers (the leg flesh under this leg's plate)
  const revealedK = {};
  for (const m of bv.revealed) { const ri = partIndexFor(current, m.userData.key); if (ri >= 0 && !(ri in revealedK)) revealedK[ri] = instanceFor(current, m.userData.key, ri); }
  const parts = {};
  for (const b of blast) if (parts[b.idx] == null || b.d < parts[b.idx]) parts[b.idx] = b.d;
  const said = HD2.hit({ idx: i, k: instanceFor(current, h.mesh.userData.key, i), blastHits: blast, inside: insideParts(h), detonate: !!h.mesh.userData.collider?.detonate, revealedK, shrapHits: shrapnelHits(h, lastDetail?.shrapnel), pelletHits: pelletHits(h, lastDetail?.pellets), thru: thruAlong(h), revealed: !!h.mesh.userData.revealed, dead: !!h.mesh.userData.deadHitbox, deg: h.deg, parts, point: h.point.toArray(), normal: h.normal.toArray(), origin: h.origin.toArray() });
  if (said) status(said);
}

/* ---------- shot visuals: ray, impact marker, explosion radii ---------- */
const shotGroup = new THREE.Group();
shotGroup.renderOrder = 10;
scene.add(shotGroup);
const fx = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
const unitSphere = new THREE.SphereGeometry(1, 48, 24);

function drawShot(hit, blast) {
  shotGroup.children.forEach((c) => { if (c.material) c.material.dispose(); if (c.geometry && c.geometry !== unitSphere) c.geometry.dispose(); });
  shotGroup.clear();
  if (!hit || !current) return;
  const p = new THREE.Vector3().fromArray(hit.point);
  const o = new THREE.Vector3().fromArray(hit.origin);
  const n = new THREE.Vector3().fromArray(hit.normal);
  const size = new THREE.Box3().setFromObject(current.root).getSize(new THREE.Vector3()).length() || 1;

  // ray from where the camera was when you clicked; rotate away to see it
  const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([o, p]), new THREE.LineBasicMaterial({ color: 0xffe710, transparent: true, opacity: 0.9, depthTest: false }));
  const normal = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, p.clone().addScaledVector(n, size * 0.08)]), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
  const dot = new THREE.Mesh(unitSphere, new THREE.MeshBasicMaterial({ color: 0xffe710, depthTest: false }));
  dot.scale.setScalar(size * 0.008);
  dot.position.copy(p);
  [ray, normal, dot].forEach((m) => { m.renderOrder = 12; shotGroup.add(m); });

  // a ricochet: the round glances off, mirrored about the surface normal (grey, with an arrowhead)
  if (hit.ricochet && !hit.ground && !hit.covered) {
    const d = p.clone().sub(o).normalize();
    const r = d.clone().addScaledVector(n, -2 * d.dot(n)).normalize();
    const len = size * 0.45;
    const end = p.clone().addScaledVector(r, len);
    const glance = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, end]), new THREE.LineBasicMaterial({ color: 0xa7b0ba, transparent: true, opacity: 0.9, depthTest: false }));
    const head = new THREE.Mesh(new THREE.ConeGeometry(size * 0.012, size * 0.04, 12), new THREE.MeshBasicMaterial({ color: 0xa7b0ba, depthTest: false }));
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), r);
    head.position.copy(end);
    [glance, head].forEach((m) => { m.renderOrder = 12; shotGroup.add(m); });
  }

  if (blast) {
    // inner radius: translucent red; outer: orange shells fading out toward the edge
    if (blast.inner > 0) {
      const inner = new THREE.Mesh(unitSphere, fx(0xff2a1a, 0.32));
      inner.scale.setScalar(blast.inner);
      inner.position.copy(p);
      inner.renderOrder = 11;
      shotGroup.add(inner);
    }
    const SHELLS = 8;
    if (blast.outer > blast.inner) {
      for (let k = 1; k <= SHELLS; k++) {
        const r = blast.inner + ((blast.outer - blast.inner) * k) / SHELLS;
        const shell = new THREE.Mesh(unitSphere, fx(0xff8a1f, 0.16 * (1 - (k - 1) / SHELLS) ** 1.5));
        shell.scale.setScalar(r);
        shell.position.copy(p);
        shell.renderOrder = 11;
        shotGroup.add(shell);
      }
    }
  }
}

/* ---------- hitzone editor ---------- */
function renderEditor() {
  const ed = $('#v3Editor');
  $('#v3Edit').classList.toggle('on', editing);
  $('#v3Save').classList.toggle('hidden', !editing || !current);
  ed.classList.toggle('hidden', !editing || !current);
  if (!editing || !current) return;
  const parts = lastDetail?.enemy.parts || [];
  const selIdx = selectedKey ? partIndexFor(current, selectedKey) : -1;
  const hidden = new Set(current.map.hidden);
  ed.innerHTML = `
    <div class="ed-head">
      <b>${selectedKey ? esc(selectedKey) : 'Click a mesh'}</b>
      ${selectedKey ? `
        <select id="edPart">
          <option value="">— not a hitzone —</option>
          ${parts.map((p, i) => `<option value="${esc(p.name)}" ${i === selIdx ? 'selected' : ''}>${esc(p.name)} (AV${p.av})</option>`).join('')}
        </select>
        <label class="opt"><span>Hide this mesh (LODs, shadows…)</span><input type="checkbox" id="edHide" ${hidden.has(selectedKey) ? 'checked' : ''}></label>
        <button class="btn ghost sm" id="edNext">Next unassigned →</button>` : '<span class="note">Rotate with left-drag, pan with right-drag, zoom with the wheel.</span>'}
    </div>
    <ul>${current.meshes.map(({ key }) => {
      const i = partIndexFor(current, key);
      return `<li data-k="${esc(key)}" class="${key === selectedKey ? 'on' : ''}"><span>${hidden.has(key) ? '<s>' + esc(key) + '</s>' : esc(key)}</span><span class="tag ${i < 0 ? 'none' : ''}">${i >= 0 ? esc(parts[i].name) : '—'}</span></li>`;
    }).join('')}</ul>`;
}

$('#v3Editor').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-k]');
  if (li) { selectedKey = li.dataset.k; renderEditor(); paint(); return; }
  if (ev.target.id === 'edNext') {
    const next = current.meshes.find(({ key }) => partIndexFor(current, key) < 0 && !current.map.hidden.includes(key) && key !== selectedKey);
    if (next) { selectedKey = next.key; renderEditor(); paint(); }
  }
});
$('#v3Editor').addEventListener('change', (ev) => {
  if (!selectedKey) return;
  if (ev.target.id === 'edPart') {
    if (ev.target.value) current.map.meshes[selectedKey] = ev.target.value;
    else current.map.meshes[selectedKey] = null; // explicit "not a hitzone" beats auto-linking
  }
  if (ev.target.id === 'edHide') {
    const set = new Set(current.map.hidden);
    ev.target.checked ? set.add(selectedKey) : set.delete(selectedKey);
    current.map.hidden = [...set];
    applyHidden();
  }
  renderEditor();
  paint();
});

$('#v3Edit').addEventListener('click', () => {
  editing = !editing;
  showColliders();
  if (editing) HD2.hideTip();
  renderEditor();
  paint();
});

$('#v3Save').addEventListener('click', async () => {
  if (!current) return;
  // inner hitboxes are saved too (the auto-placed ones become fixed once saved)
  const colliders = (current.colliders || []).map(({ def }) => (def.shape === 'box' ? { part: def.part, shape: 'box', centre: def.centre, size: def.size, ...(def.direct ? { direct: true } : {}), ...(def.detonate ? { detonate: true } : {}) }
    : { part: def.part, from: def.from.map((v) => +(+v).toFixed(4)), to: def.to.map((v) => +(+v).toFixed(4)), radius: def.radius, ...(def.direct ? { direct: true } : {}) }));
  const body = JSON.stringify({ enemy: currentId, meshes: current.map.meshes, hidden: current.map.hidden, ...(current.map.after ? { after: current.map.after } : {}), ...(current.map.vanish ? { vanish: current.map.vanish } : {}), ...(current.map.glass ? { glass: current.map.glass } : {}), ...(current.map.opens ? { opens: current.map.opens } : {}), ...(colliders.length ? { colliders } : {}), ...(current.map.inside ? { inside: current.map.inside } : {}) }, null, 2);
  if (SERVED) {
    try {
      const r = await fetch(`api/map/${encodeURIComponent(currentId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (r.ok) { status(`Saved models/${currentId}.map.json`); return; }
    } catch { /* fall through to download */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  a.download = `${currentId}.map.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  status(`Downloaded ${currentId}.map.json — put it in models/`);
});

$('#v3Reset').addEventListener('click', frame);
$('#v3Tex').addEventListener('change', (ev) => { showTex = ev.target.checked; paint(); });

$('#v3File').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file || !currentId) return;
  const id = currentId;
  status(`Loading ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    const gltf = await parseGlb(buf);
    const prev = cache.get(id);
    const entry = { root: gltf.scene, meshes: prepare(gltf.scene), map: prev?.map || { meshes: {}, hidden: [] } };
    cache.set(id, entry);
    if (currentId === id) show(entry);
    if (SERVED && file.name.toLowerCase().endsWith('.glb')) {
      const r = await fetch(`api/model/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: buf }).catch(() => null);
      if (r && r.ok) status(`Saved as models/${id}.glb · ${entry.meshes.length} meshes`);
    }
  } catch (err) {
    console.error(err);
    status('Could not read that file — see console');
  }
});

/* ---------- link to app.js ---------- */
window.addEventListener('hd2:update', (ev) => {
  lastDetail = ev.detail;
  if (ev.detail.enemy.id !== currentId) { drawShot(null); loadForEnemy(ev.detail.enemy.id); }
  else { paint(); if (editing) renderEditor(); drawShot(ev.detail.hit, ev.detail.blast); }
  updateHpCard(); // right away, e.g. Reset hides it without waiting for the next frame
  if (ev.detail.stageView === '3d') requestAnimationFrame(resize);
});
HD2.refresh();

// the health card follows the camera every frame (started last: it reads state declared further up)
(function hpLoop() {
  requestAnimationFrame(hpLoop);
  if (host.offsetParent !== null) updateHpCard();
})();
