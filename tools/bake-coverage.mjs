// Bake check: share of each baked material's TEXCOORD_1 vertices that land on baked texels; lists models under 90%.
// usage: node tools/bake-coverage.mjs <bakeDir>
import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
const [bakeDir] = process.argv.slice(2);
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const img = {};
async function alphaOf(r) {
  if (img[r] !== undefined) return img[r];
  const p = `${bakeDir}/${r.replace(/\//g, '__')}.png`;
  if (!fs.existsSync(p)) return (img[r] = null);
  const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return (img[r] = { data, w: info.width });
}
for (const f of fs.readdirSync('models').filter((x) => x.endsWith('.glb'))) {
  const doc = await io.read('models/' + f);
  const st = {};
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const uv = p.getAttribute('TEXCOORD_1'); const m = p.getMaterial(); if (!uv || !m) continue;
    const r = m.getName().split(' ').pop(); const A = await alphaOf(r); if (!A) continue;
    const s = (st[r] ||= [0, 0]); const a = [];
    for (let i = 0; i < uv.getCount(); i++) { uv.getElement(i, a); const x = Math.min(A.w - 1, Math.floor(a[0] * A.w)), y = Math.min(A.w - 1, Math.floor(a[1] * A.w)); s[1]++; if (A.data[(y * A.w + x) * 4 + 3] > 0) s[0]++; }
  }
  const bad = Object.entries(st).filter(([, [h, n]]) => h / n < 0.9).map(([r, [h, n]]) => `${r} ${(100 * h / n).toFixed(0)}%`);
  if (bad.length) console.log(f, bad.join(' | '));
}
console.log('done');
