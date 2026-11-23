// Bake layout: for every material (resource = last word of its name) in models/*.glb, the UDIM tiles its
// triangles use (tile = floor(u) + 10*floor(v) of the triangle centre). usage: node tools/bake-layout.mjs tiles.json users.json
// (then make layout.json: {resource: {tiles, grid: ceil(sqrt(n)), size}}; see tools/bake-hd2-shader.py)
import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
await MeshoptDecoder.ready;
const res = (n) => n.split(' ').pop();
const tiles = {};
for (const f of fs.readdirSync('models').filter((x) => x.endsWith('.glb'))) {
  const doc = await io.read('models/' + f);
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const m = p.getMaterial(); if (!m || m.getBaseColorTexture() || m.getExtras()?.base_data == null) continue;
    const uv = p.getAttribute('TEXCOORD_0'); if (!uv) { console.log('no uv', f, m.getName()); continue; }
    const idx = p.getIndices(); const n = idx ? idx.getCount() : uv.getCount(); const a = [], b = [], c = [];
    const t = (tiles[res(m.getName())] ||= new Set());
    for (let i = 0; i < n; i += 3) {
      let su = 0, sv = 0;
      for (let k = 0; k < 3; k++) { const v = idx ? idx.getScalar(i + k) : i + k; uv.getElement(v, a); su += a[0]; sv += a[1]; }
      t.add(Math.floor(su / 3) + 10 * Math.floor(sv / 3));
    }
  }
}
const out = Object.fromEntries(Object.entries(tiles).map(([k, v]) => [k, [...v].sort((x, y) => x - y)]));
fs.writeFileSync(process.argv[2], JSON.stringify(out));
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(50), v.join(','));
