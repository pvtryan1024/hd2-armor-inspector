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

function instanceFor(entry, key, i) {
  const n = lastDetail?.enemy.parts[i]?.count || 1;
  if (n < 2) return null;
  const same = entry.meshes.map((m) => m.key).filter((k) => partIndexFor(entry, k) === i).sort();
  const at = same.indexOf(key);
  return at < 0 ? null : at % n;
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
  camera.position.copy(center).add(new THREE.Vector3(r * 1.5, r * 0.8, r * 2.1));
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
  if (!entry) { $('#v3Legend').classList.add('hidden'); status(SERVED ? '' : 'Open via "node serve.js" to auto-load models'); renderEditor(); return; }
  scene.add(entry.root);
  applyHidden();
  frame();
  paint();
  renderEditor();
  const linked = entry.meshes.filter(({ key }) => partIndexFor(entry, key) >= 0).length;
  status(`${entry.meshes.length} meshes · ${linked} linked to hitzones`);
}

/** Fire mode: once a piece breaks, hide it and show its "<name>_damaged" mesh (the flesh under a plate). */
function swapBroken() {
  if (!current || !lastDetail?.fire || editing) return;
  const byKey = new Map(current.meshes.map((m) => [m.key, m.mesh]));
  const hidden = new Set(current.map.hidden);
  for (const { key, mesh } of current.meshes) {
    const v = byKey.get(`${key}_damaged`);
    if (!v || hidden.has(key)) continue;
    const i = partIndexFor(current, key);
    if (i < 0) continue;
    const k = instanceFor(current, key, i);
    const broken = !!(k != null && lastDetail.goneInst?.[i] ? lastDetail.goneInst[i][k] : lastDetail.gone[i]);
    mesh.visible = !broken;
    v.visible = broken;
    v.userData.revealed = broken;
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
    if (i >= 0) {
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

/* ---------- picking ---------- */
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
const nm = new THREE.Matrix3();
function pick(ev) {
  if (!current) return null;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hits = ray.intersectObjects(current.meshes.map((m) => m.mesh).filter((m) => m.visible), false);
  // destroyed parts have no hitbox: the shot goes through to whatever is behind them
  const hit = hits.find((h) => h.object.material.opacity > 0.2);
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

let downAt = null;
renderer.domElement.addEventListener('pointerdown', (ev) => { downAt = [ev.clientX, ev.clientY]; });
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (ev.buttons) { HD2.hideTip(); return; }
  const h = pick(ev);
  if (!h) { HD2.hideTip(); return; }
  const i = partIndexFor(current, h.mesh.userData.key);
  if (editing) { status(`${h.mesh.userData.key}${i >= 0 ? ' → ' + lastDetail.enemy.parts[i].name : ' (unassigned)'}`); return; }
  HD2.hideTip();
  if (i >= 0) HD2.tip(i, ev.clientX, ev.clientY, { deg: h.deg });
});
renderer.domElement.addEventListener('pointerleave', () => HD2.hideTip());
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return; // it was a drag
  const h = pick(ev);
  if (!h) return;
  if (editing) {
    selectedKey = h.mesh.userData.key; renderEditor(); paint();
    if (lastDetail?.fire) status(`Editing hitzones: click selects "${selectedKey}". Turn off "Edit hitzones" to fire.`);
    return;
  }
  const i = partIndexFor(current, h.mesh.userData.key);
  if (i < 0) { status(`"${h.mesh.userData.key}" isn't linked to a hitzone yet (grey). Assign it in "Edit hitzones".`); return; }
  // distance from the impact to every hitzone, for blast damage (nearest point of each mesh's bounds)
  const parts = {};
  for (const { key, mesh } of current.meshes) {
    if (!mesh.visible) continue;
    const k = partIndexFor(current, key);
    if (k < 0) continue;
    const d = new THREE.Box3().setFromObject(mesh).distanceToPoint(h.point);
    if (parts[k] == null || d < parts[k]) parts[k] = d;
  }
  HD2.hit({ idx: i, k: instanceFor(current, h.mesh.userData.key, i), revealed: !!h.mesh.userData.revealed, deg: h.deg, parts, point: h.point.toArray(), normal: h.normal.toArray(), origin: h.origin.toArray() });
});

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
  if (ev.detail.enemy.id !== currentId) { drawShot(null); loadForEnemy(ev.detail.enemy.id); }
  else { paint(); if (editing) renderEditor(); drawShot(ev.detail.hit, ev.detail.blast); }
  if (ev.detail.stageView === '3d') requestAnimationFrame(resize);
});
HD2.refresh();
