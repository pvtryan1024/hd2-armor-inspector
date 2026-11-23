// Write a model without meshopt compression (for tools that can't read it, e.g. Blender).
// usage: node tools/plain-glb.mjs in.glb out.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { dequantize } from '@gltf-transform/functions';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const [inp, out] = process.argv.slice(2);
const doc = await io.read(inp);
await doc.transform(dequantize());
for (const e of doc.getRoot().listExtensionsUsed()) if (/meshopt|quantization|KHR_materials_/i.test(e.extensionName)) e.dispose(); // KHR_materials_*: Blender's importer fails on iridescence
await io.write(out, doc);
