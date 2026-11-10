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
  hpCard.style.top = `${((1 - hpAt.y) / 2) * h}px`;
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

function partIndexFor(entry, key) {
  const parts = lastDetail?.enemy.parts || [];
  const name = entry.map.meshes[key];
  if (name === null) return -1; // explicitly marked "not a hitzone"
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
  const side = (b) => (/(^|_)left(_|$)/i.test(b) ? 0 : /(^|_)right(_|$)/i.test(b) ? 1 : -1);
  if (n === 2 && bases.length > 2 && bases.every((b) => side(b) >= 0)) return side(baseOf(key));
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
function pieceGone(key) {
  const i = partIndexFor(current, key);
  if (i < 0 || !lastDetail?.fire) return false;
  const k = instanceFor(current, key, i);
  return !!(k != null && lastDetail.goneInst?.[i] ? lastDetail.goneInst[i][k] : lastDetail.gone[i]);
}
function swapBroken() {
  if (!current || editing) return;
  const hidden = new Set(current.map.hidden);
  // group every mesh by piece: intact meshes, its _damaged meshes, its _gib / _destroyed meshes
  const groups = new Map();
  for (const m of current.meshes) {
    const st = stageOf(m.key);
    if (st === 3) continue; // "_hurt": not used
    const b = baseOf(m.key);
    if (!groups.has(b)) groups.set(b, [[], [], []]);
    groups.get(b)[st].push(m);
  }
  for (const [intact, dmg, gib] of groups.values()) {
    if (!dmg.length && !gib.length) continue;
    // the piece's own plate: intact meshes of its hitzone (a spore blob of another hitzone stays put)
    const linked = intact.filter((m) => !hidden.has(m.key) && partIndexFor(current, m.key) >= 0);
    if (!linked.length) continue;
    const i = partIndexFor(current, linked[0].key);
    const mine = linked.filter((m) => partIndexFor(current, m.key) === i);
    // stage 0 intact · 1 stripped (flesh of another hitzone showing) · 2 destroyed
    let stage = 0;
    if (pieceGone(mine[0].key)) {
      const di = dmg.length ? partIndexFor(current, dmg[0].key) : -1;
      stage = dmg.length && di >= 0 && di !== i && !pieceGone(dmg[0].key) ? 1 : 2;
    }
    const remains = stage === 2 ? (gib.length ? gib : dmg.length ? dmg : null) : null;
    for (const m of mine) { m.mesh.visible = stage === 0 || (stage === 2 && !remains); m.mesh.userData.remains = stage === 2 && !remains; }
    for (const m of dmg) { m.mesh.visible = stage === 1 || remains === dmg; m.mesh.userData.revealed = stage === 1; m.mesh.userData.remains = remains === dmg; }
    for (const m of gib) { m.mesh.visible = remains === gib; m.mesh.userData.remains = remains === gib; m.mesh.userData.revealed = false; }
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

function paint() {
  if (!current || !lastDetail) return;
  const { colors, gone, goneInst, colorMode, ap4, avs, bands } = lastDetail;
  applyHidden();
  swapBroken();
  const angleMode = colorMode === 'pen' && !!ap4;
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
    } else if (i >= 0) {
      u.uAngle.value = angleMode ? 1 : 0;
      u.uFlat.value.set(colors[i]);
      if (ap4) u.uAP.value.set(...ap4);
      u.uAV.value = avs[i];
      const k = goneInst?.[i] ? instanceFor(current, key, i) : null;
      mat.opacity = (k != null ? goneInst[i][k] : gone[i]) ? 0.15 : 1;
    } else {
      u.uAngle.value = 0;
      u.uFlat.value.copy(UNMAPPED);
      mat.opacity = editing ? 0.9 : 0.5;
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
 * colliders: [{ part, from: [x,y,z], to: [x,y,z], radius }]. Only over-penetrating shots look for them.
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
    const from = new THREE.Vector3().fromArray(c.from), to = new THREE.Vector3().fromArray(c.to);
    const len = from.distanceTo(to);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(c.radius, c.radius, len, 16, 1), colliderMat);
    mesh.position.copy(from).lerp(to, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    mesh.renderOrder = 20;
    mesh.userData.collider = c;
    scene.add(mesh);
    return { def: c, mesh };
  });
  showColliders();
}
const showColliders = () => current?.colliders?.forEach(({ mesh }) => { mesh.visible = editing; });

/** Over-penetration target along the shot: the first inner hitbox the ray passes through behind the impact. */
const thruRay = new THREE.Raycaster();
function innerAlong(h) {
  if (!current?.colliders?.length) return null;
  thruRay.set(h.origin, h.point.clone().sub(h.origin).normalize());
  const meshes = current.colliders.map((c) => c.mesh);
  const vis = meshes.map((m) => m.visible);
  meshes.forEach((m) => { m.visible = true; });
  const hits = thruRay.intersectObjects(meshes, false);
  meshes.forEach((m, i) => { m.visible = vis[i]; });
  const dist = h.point.distanceTo(h.origin);
  const hit = hits.find((x) => x.distance > dist - 1e-3);
  if (!hit) return null;
  const parts = lastDetail?.enemy.parts || [];
  const idx = parts.findIndex((p) => p.name === hit.object.userData.collider.part);
  return idx >= 0 ? { idx, d: hit.distance - dist } : null;
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
  const into = h.normal.clone().negate();
  let dirs;
  if (spec.spread === 'surface') {
    dirs = fibDirs(spec.count * 2).filter((d) => d.dot(into) > 0).slice(0, spec.count);
  } else dirs = fibDirs(spec.count);
  const targets = current.meshes.map((m) => m.mesh).filter((m) => m.visible && m.material.opacity > 0.2 && !m.userData.remains);
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

function blastHits(h, outer) {
  const out = new Map(); // "part:piece" -> { idx, k, d }
  if (!(outer > 0)) return [];
  const targets = current.meshes.map((m) => m.mesh).filter((m) => m.visible && m.material.opacity > 0.2 && !m.userData.remains);
  const origin = h.point.clone().addScaledVector(h.normal, 0.01); // just off the surface that was struck
  blastRay.far = outer;
  for (const dir of DODECA) {
    blastRay.set(origin, dir);
    const first = blastRay.intersectObjects(targets, false)[0];
    if (!first) continue; // this line hit nothing
    const idx = partIndexFor(current, first.object.userData.key);
    if (idx < 0) continue; // a mesh that isn't a hitzone still stops the line
    const k = instanceFor(current, first.object.userData.key, idx);
    const id = `${idx}:${k}`;
    if (!out.has(id) || first.distance < out.get(id).d) out.set(id, { idx, k, d: first.distance });
  }
  return [...out.values()];
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
  const hits = ray.intersectObjects(current.meshes.map((m) => m.mesh).filter((m) => m.visible), false);
  // destroyed parts have no hitbox: the shot goes through to whatever is behind them
  const hit = hits.find((h) => h.object.material.opacity > 0.2 && !h.object.userData.remains);
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
  if (!h) { HD2.hideTip(); return; }
  const i = partIndexFor(current, h.mesh.userData.key);
  if (editing) { status(`${h.mesh.userData.key}${i >= 0 ? ' → ' + lastDetail.enemy.parts[i].name : ' (unassigned)'}`); return; }
  HD2.hideTip();
  if (i >= 0) HD2.tip(i, ev.clientX, ev.clientY, { deg: h.deg });
}
renderer.domElement.addEventListener('pointerleave', () => HD2.hideTip());
function shoot(h) {
  if (editing) {
    selectedKey = h.mesh.userData.key; renderEditor(); paint();
    if (lastDetail?.fire) status(`Editing hitzones: click selects "${selectedKey}". Turn off "Edit hitzones" to fire.`);
    return;
  }
  const i = partIndexFor(current, h.mesh.userData.key);
  if (i < 0) { status(`"${h.mesh.userData.key}" isn't linked to a hitzone yet (grey). Assign it in "Edit hitzones".`); return; }
  // blast rays from the impact point (the result of every press shows in the status line)
  const blast = blastHits(h, lastDetail?.blast?.outer);
  const parts = {};
  for (const b of blast) if (parts[b.idx] == null || b.d < parts[b.idx]) parts[b.idx] = b.d;
  const said = HD2.hit({ idx: i, k: instanceFor(current, h.mesh.userData.key, i), blastHits: blast, shrapHits: shrapnelHits(h, lastDetail?.shrapnel), thru: innerAlong(h), revealed: !!h.mesh.userData.revealed, deg: h.deg, parts, point: h.point.toArray(), normal: h.normal.toArray(), origin: h.origin.toArray() });
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
  const colliders = (current.colliders || []).map(({ def }) => ({ part: def.part, from: def.from.map((v) => +(+v).toFixed(4)), to: def.to.map((v) => +(+v).toFixed(4)), radius: def.radius }));
  const body = JSON.stringify({ enemy: currentId, meshes: current.map.meshes, hidden: current.map.hidden, ...(colliders.length ? { colliders } : {}) }, null, 2);
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
      const r = await fetch(`api/model/${encodeURIComponent(id)}`, { method: 'POST', body: buf }).catch(() => null);
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
