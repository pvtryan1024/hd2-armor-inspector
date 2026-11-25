// Give the pieces (nodes) whose name matches a pattern a plain material of their own, by name. The viewer styles
// materials by name: one called like the War Strider's eye ("m_boteye textures/bot_emissive") glows red with
// Original materials on.
// usage: node tools/set-material.mjs "<node regex>" "<material name>" <model ids...>
// e.g.   node tools/set-material.mjs "^chest_eye$" "m_boteye textures/bot_emissive" hulk-bruiser hulk-scorcher
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [pattern, name, ...ids] = process.argv.slice(2);
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const re = new RegExp(pattern, 'i');
for (const id of ids) {
  const file = path.join(ROOT, 'models', id + '.glb');
  const doc = await io.read(file);
  const root = doc.getRoot();
  const mat = root.listMaterials().find((m) => m.getName() === name) || doc.createMaterial(name).setBaseColorFactor([1, 1, 1, 1]);
  let n = 0;
  for (const node of root.listNodes()) {
    if (!re.test(node.getName()) || !node.getMesh()) continue;
    for (const p of node.getMesh().listPrimitives()) { p.setMaterial(mat); n++; }
  }
  if (!n) { console.warn(`${id}: no piece matches ${pattern}`); continue; }
  await io.write(file, doc);
  console.log(id, n, 'primitive(s) ->', name, (fs.statSync(file).size / 1e6).toFixed(1) + 'MB');
}
