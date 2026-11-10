/* 3D hitzone viewer. Loads models/<enemy-id>.glb plus an optional models/<enemy-id>.map.json that
 * links mesh names to wiki hitzone names. Meshes are coloured with the same penetration / shots-to-kill
 * colours as the body map. "Edit hitzones" lets you click meshes and assign them to parts by hand.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

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

function prepare(root) {
  const meshes = [];
  const seen = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    let key = o.name || 'mesh';
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    if (n) key = `${key}#${n + 1}`;
    o.userData.key = key;
    o.userData.orig = o.material;
    o.userData.hz = new THREE.MeshStandardMaterial({ color: UNMAPPED, roughness: 0.55, metalness: 0.1, transparent: true });
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
  camera.position.copy(center).add(new THREE.Vector3(r * 1.1, r * 0.6, r * 1.6));
  camera.near = r / 200; camera.far = r * 50; camera.updateProjectionMatrix();
  grid.position.y = box.min.y;
  grid.scale.setScalar(Math.max(0.1, r / 8));
}

function show(entry) {
  if (current) scene.remove(current.root);
  current = entry;
  selectedKey = null;
  $('#v3Empty').classList.toggle('hidden', !!entry);
  $('#v3Id').textContent = currentId || '';
  if (!entry) { status(SERVED ? '' : 'Open via "node serve.js" to auto-load models'); renderEditor(); return; }
  scene.add(entry.root);
  applyHidden();
  frame();
  paint();
  renderEditor();
  const linked = entry.meshes.filter(({ key }) => partIndexFor(entry, key) >= 0).length;
  status(`${entry.meshes.length} meshes · ${linked} linked to hitzones`);
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
    if (currentId === id) show(entry);
  } catch (err) {
    if (currentId !== id) return;
    // a 404 just means no model yet
    if (String(err?.message || err).includes('404')) { status(''); $('#v3Empty').classList.remove('hidden'); return; }
    console.error(err);
    status('Failed to load model — see console');
    $('#v3Empty').classList.remove('hidden');
  }
}

/* ---------- colouring ---------- */
function paint() {
  if (!current || !lastDetail) return;
  const { colors, gone } = lastDetail;
  for (const { key, mesh } of current.meshes) {
    if (showTex && !editing) { mesh.material = mesh.userData.orig; continue; }
    const i = partIndexFor(current, key);
    const mat = mesh.userData.hz;
    mesh.material = mat;
    if (i >= 0) {
      mat.color.set(colors[i]);
      mat.opacity = gone[i] ? 0.15 : 1;
    } else {
      mat.color.copy(UNMAPPED);
      mat.opacity = editing ? 0.9 : 0.5;
    }
    mat.depthWrite = mat.opacity >= 1;
    mat.emissive.set(editing && key === selectedKey ? 0xffe710 : 0x000000);
    mat.emissiveIntensity = editing && key === selectedKey ? 0.6 : 0;
  }
}

/* ---------- picking ---------- */
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
function pick(ev) {
  if (!current) return null;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hits = ray.intersectObjects(current.meshes.map((m) => m.mesh).filter((m) => m.visible), false);
  // skip see-through destroyed parts so you can shoot what's behind them
  const hit = hits.find((h) => h.object.material.opacity > 0.2) || hits[0];
  return hit ? hit.object : null;
}

let downAt = null;
renderer.domElement.addEventListener('pointerdown', (ev) => { downAt = [ev.clientX, ev.clientY]; });
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (ev.buttons) { HD2.hideTip(); return; }
  const m = pick(ev);
  if (!m) { HD2.hideTip(); return; }
  const i = partIndexFor(current, m.userData.key);
  if (editing) { status(`${m.userData.key}${i >= 0 ? ' → ' + lastDetail.enemy.parts[i].name : ' (unassigned)'}`); return; }
  HD2.hideTip();
  if (i >= 0) HD2.tip(i, ev.clientX, ev.clientY);
});
renderer.domElement.addEventListener('pointerleave', () => HD2.hideTip());
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return; // it was a drag
  const m = pick(ev);
  if (!m) return;
  if (editing) { selectedKey = m.userData.key; renderEditor(); paint(); return; }
  const i = partIndexFor(current, m.userData.key);
  if (i >= 0) HD2.click(i);
});

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
  if (editing) HD2.hideTip();
  renderEditor();
  paint();
});

$('#v3Save').addEventListener('click', async () => {
  if (!current) return;
  const body = JSON.stringify({ enemy: currentId, meshes: current.map.meshes, hidden: current.map.hidden }, null, 2);
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
  if (ev.detail.enemy.id !== currentId) loadForEnemy(ev.detail.enemy.id);
  else { paint(); if (editing) renderEditor(); }
  if (ev.detail.stageView === '3d') requestAnimationFrame(resize);
});
HD2.refresh();
