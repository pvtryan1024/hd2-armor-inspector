// Put baked colour atlases (Blender, filediver's accurate HD2 shader, one atlas per material resource with a cell
// per UDIM tile) into the site's models as their base colour.
// usage: node tools/apply-bakes.mjs <bakeDir> <layout.json> [model ids...]
// For each primitive whose material resource (last word of the material name) has <bakeDir>/<resource>.png:
// TEXCOORD_1 = the atlas position of TEXCOORD_0 (tile of each triangle → its cell), baseColorTexture = the atlas
// (JPEG) on texCoord 1. Composite-shader materials also lose their normalTexture (it is packed base_data, not a
// normal map).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [bakeDir, layoutPath, ...only] = process.argv.slice(2);
const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const res = (n) => (n || '').split(' ').pop();
const jpgCache = new Map();
async function atlasJpeg(r) {
  if (jpgCache.has(r)) return jpgCache.get(r);
  const p = path.join(bakeDir, r.replace(/\//g, '__') + '.png');
  if (!fs.existsSync(p)) { jpgCache.set(r, null); return null; }
  const L = layout[r];
  const out = L.grid >= 3 ? 2048 : 1024; // a cell keeps at least ~340 px
  // unbaked (transparent) texels: filled with the blurred colour of the baked ones around them (push-pull), so a
  // face the bake missed shows its neighbours' colour instead of black
  const { data, info } = await sharp(p).ensureAlpha().resize(out, out).raw().toBuffer({ resolveWithObject: true });
  const N = out * out, pre = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) { const al = data[i * 4 + 3] / 255; for (let c = 0; c < 3; c++) pre[i * 4 + c] = Math.round(data[i * 4 + c] * al); pre[i * 4 + 3] = data[i * 4 + 3]; }
  let fill = data;
  for (const sigma of [4, 16, 64]) {
    const bl = await sharp(pre, { raw: { width: out, height: out, channels: 4 } }).blur(sigma).raw().toBuffer();
    const f2 = Buffer.from(fill);
    for (let i = 0; i < N; i++) { if (f2[i * 4 + 3] === 255) continue; const al = bl[i * 4 + 3]; if (al < 2) continue; for (let c = 0; c < 3; c++) f2[i * 4 + c] = Math.min(255, Math.round(bl[i * 4 + c] * 255 / al)); f2[i * 4 + 3] = 255; }
    fill = f2;
  }
  const buf = await sharp(fill, { raw: { width: out, height: out, channels: 4 } }).flatten({ background: '#000' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  jpgCache.set(r, buf);
  return buf;
}

const ids = only.length ? only : fs.readdirSync(path.join(ROOT, 'models')).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4));
for (const id of ids) {
  const file = path.join(ROOT, 'models', id + '.glb');
  const doc = await io.read(file);
  const root = doc.getRoot();
  const texFor = new Map();
  let n = 0;
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    const r = res(mat?.getName());
    const L = layout[r];
    if (!L) continue;
    if (mat.getBaseColorTexture() && mat.getExtras()?.base_data == null) continue; // keeps its own colour texture
    const jpg = await atlasJpeg(r);
    if (!jpg) continue;
    const uv = prim.getAttribute('TEXCOORD_0');
    if (!uv) continue;
    const idx = prim.getIndices();
    const count = uv.getCount();
    const out = new Float32Array(count * 2).fill(-1);
    const tri = idx ? idx.getCount() : count;
    const a = [], G = L.grid;
    for (let i = 0; i < tri; i += 3) {
      const vs = [0, 1, 2].map((k) => (idx ? idx.getScalar(i + k) : i + k));
      let su = 0, sv = 0;
      const uvs = vs.map((v) => { uv.getElement(v, a); su += a[0]; sv += a[1]; return [a[0], a[1]]; });
      const fu = Math.floor(su / 3), fv = Math.floor(sv / 3);
      const c = L.tiles.indexOf(fu + 10 * fv);
      if (c < 0) continue;
      const cx = c % G, cy = Math.floor(c / G);
      vs.forEach((v, k) => { if (out[v * 2] < 0) { out[v * 2] = (cx + uvs[k][0] - fu) / G; out[v * 2 + 1] = (cy + uvs[k][1] - fv) / G; } });
    }
    for (let i = 0; i < out.length; i++) if (out[i] < 0) out[i] = 0;
    prim.setAttribute('TEXCOORD_1', doc.createAccessor().setType('VEC2').setArray(out).setBuffer(root.listBuffers()[0]));
    if (!texFor.has(mat)) {
      // a material can be on primitives of other resources' meshes only by name, so each material gets its own copy
      const m2 = mat.clone();
      const tex = doc.createTexture(r).setImage(jpg).setMimeType('image/jpeg');
      m2.setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, 1]);
      m2.getBaseColorTextureInfo().setTexCoord(1);
      if (mat.getExtras()?.base_data != null) m2.setNormalTexture(null);
      texFor.set(mat, m2);
    }
    prim.setMaterial(texFor.get(mat));
    n++;
  }
  if (!n) continue;
  for (const m of texFor.keys()) if (!m.listParents().some((p) => p.propertyType === 'Primitive')) m.dispose();
  for (const t of root.listTextures()) if (t.listParents().length <= 1) t.dispose(); // unused (only the root)
  await io.write(file, doc);
  console.log(id, n, 'primitives,', texFor.size, 'materials,', (fs.statSync(file).size / 1e6).toFixed(1), 'MB');
}
