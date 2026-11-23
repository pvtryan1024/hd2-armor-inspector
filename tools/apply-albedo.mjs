// Replace models' base colour images with freshly decoded game albedos (saved from filediver .blend exports, one PNG
// per material resource). The older glb exports decoded many of them wrongly (too dark, Terminid colours missing).
// UVs stay as they are; only the image changes.
// usage: node tools/apply-albedo.mjs <albedoDir> [--xfer <dir>] [model ids...]
// --xfer: <dir>/<model>/<resource>.png from bake-transfer.py (the current game colours projected onto this model's own
// UVs, for pieces whose UVs changed since the export) go over the albedo; texels the transfer missed keep the albedo
// (or the old image when there is none).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const xi = args.indexOf('--xfer');
const xferDir = xi >= 0 ? args.splice(xi, 2)[1] : null;
const [dir, ...only] = args;
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const SIZE = 1024;
const toJpeg = (s) => s.removeAlpha().resize(SIZE, SIZE).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
const cache = new Map();
async function jpeg(r, id, oldImg) {
  const key = id + ':' + r;
  if (cache.has(key)) return cache.get(key);
  const name = r.replace(/\//g, '__') + '.png';
  const p = path.join(dir, name);
  const x = xferDir && path.join(xferDir, id, name);
  const base = () => (fs.existsSync(p) ? sharp(p) : oldImg ? sharp(Buffer.from(oldImg)) : null);
  let buf = null;
  if (x && fs.existsSync(x)) {
    const st = await sharp(x).stats();
    if (st.channels[3] && st.channels[3].mean > 1) { // the transfer reached something
      const top = await sharp(x).resize(SIZE, SIZE).png().toBuffer();
      const b = base();
      const under = b ? await b.removeAlpha().resize(SIZE, SIZE).png().toBuffer()
        : await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: '#000' } }).png().toBuffer();
      buf = await sharp(under).composite([{ input: top }]).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    }
  }
  if (!buf && fs.existsSync(p)) buf = await toJpeg(sharp(p));
  cache.set(key, buf);
  return buf;
}
const ids = only.length ? only : fs.readdirSync(path.join(ROOT, 'models')).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4));
for (const id of ids) {
  const file = path.join(ROOT, 'models', id + '.glb');
  const doc = await io.read(file);
  const done = [];
  for (const mat of doc.getRoot().listMaterials()) {
    const tex = mat.getBaseColorTexture();
    if (tex && mat.getBaseColorTextureInfo().getTexCoord() !== 0) continue; // atlas bakes (TEXCOORD_1) stay
    if (!tex) {
      // no colour texture in the export at all (Hunter / Pouncer wings): add one when the game has an albedo for it
      // and the material's meshes have UVs (composite Automaton materials are handled by apply-bakes)
      if (mat.getExtras()?.base_data != null) continue;
      const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).filter((p) => p.getMaterial() === mat);
      if (!prims.length || !prims.every((p) => p.getAttribute('TEXCOORD_0'))) continue;
      const r = (mat.getName() || '').split(' ').pop();
      const buf = await jpeg(r, id, null);
      if (!buf) continue;
      mat.setBaseColorTexture(doc.createTexture(r).setImage(buf).setMimeType('image/jpeg')).setBaseColorFactor([1, 1, 1, 1]);
      done.push(r + ' (added)');
      continue;
    }
    const r = (mat.getName() || '').split(' ').pop();
    const buf = await jpeg(r, id, tex.getImage());
    if (!buf) continue;
    // its own texture, in case another material shares the image
    mat.setBaseColorTexture(doc.createTexture(r).setImage(buf).setMimeType('image/jpeg'));
    done.push(r);
  }
  // metal / roughness maps: decoded too dark as well (roughness far too low: the Illuminate looked wet)
  for (const mat of doc.getRoot().listMaterials()) {
    const tex = mat.getMetallicRoughnessTexture();
    if (!tex || mat.getMetallicRoughnessTextureInfo().getTexCoord() !== 0) continue;
    const r = (mat.getName() || '').split(' ').pop();
    const p = path.join(dir, r.replace(/\//g, '__') + '.mr.png');
    if (!fs.existsSync(p)) continue;
    const buf = await sharp(p).removeAlpha().resize(SIZE, SIZE).jpeg({ quality: 92 }).toBuffer(); // high quality: it is data
    const t2 = doc.createTexture(r + '.mr').setImage(buf).setMimeType('image/jpeg');
    mat.setMetallicRoughnessTexture(t2);
    if (mat.getOcclusionTexture() === tex) mat.setOcclusionTexture(t2); // ORM: R occlusion
    done.push(r + ' (mr)');
  }
  if (!done.length) continue;
  for (const t of doc.getRoot().listTextures()) if (t.listParents().length <= 1) t.dispose();
  await io.write(file, doc);
  console.log(id, done.join(', '), (fs.statSync(file).size / 1e6).toFixed(1) + 'MB');
}
