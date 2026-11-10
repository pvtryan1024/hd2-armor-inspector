// Writes models/charger.glb: a crude box-built Charger whose node names match the wiki hitzones,
// so the 3D viewer can be tested before real models exist. Replace it with your own model.
const fs = require('fs');
const path = require('path');

// [name, center xyz, size xyz]   (+z = front)
const boxes = [
  ['Head', [0, 1.1, 2.2], [1.2, 1.0, 1.0]],
  ['Torso Armor', [-0.45, 1.5, 0.9], [0.8, 0.9, 1.6]],
  ['Torso Armor', [0.45, 1.5, 0.9], [0.8, 0.9, 1.6]],
  ['Underside', [0, 0.8, 0.6], [1.4, 0.3, 2.0]],
  ['Rear Armor Plates', [0, 1.6, -0.6], [1.6, 0.8, 1.2]],
  ['Butt', [0, 1.3, -1.8], [1.5, 1.3, 1.4]],
  ['Claws', [-0.8, 0.9, 2.6], [0.3, 0.4, 1.2]],
  ['Claws', [0.8, 0.9, 2.6], [0.3, 0.4, 1.2]],
  ['Front Leg Armor', [-1.0, 0.9, 1.3], [0.4, 0.6, 0.4]],
  ['Front Leg Armor', [1.0, 0.9, 1.3], [0.4, 0.6, 0.4]],
  ['Rear Leg Armor', [-1.0, 0.9, -0.6], [0.4, 0.6, 0.4]],
  ['Rear Leg Armor', [1.0, 0.9, -0.6], [0.4, 0.6, 0.4]],
  ['Leg Flesh', [-1.1, 0.3, 1.3], [0.25, 0.6, 0.25]],
  ['Leg Flesh', [1.1, 0.3, 1.3], [0.25, 0.6, 0.25]],
  ['Leg Flesh', [-1.1, 0.3, -0.6], [0.25, 0.6, 0.25]],
  ['Leg Flesh', [1.1, 0.3, -0.6], [0.25, 0.6, 0.25]],
];

// unit cube, 24 verts (flat normals)
const faces = [
  [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
  [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
  [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
  [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
  [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
  [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
];
const pos = [], nrm = [], idx = [];
faces.forEach(([n, vs], f) => {
  vs.forEach((v) => { pos.push(...v.map((c) => c * 0.5)); nrm.push(...n); });
  const b = f * 4;
  idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
});
const posBuf = Buffer.from(new Float32Array(pos).buffer);
const nrmBuf = Buffer.from(new Float32Array(nrm).buffer);
const idxBuf = Buffer.from(new Uint16Array(idx).buffer);
const bin = Buffer.concat([posBuf, nrmBuf, idxBuf]);

const gltf = {
  asset: { version: '2.0', generator: 'hd2-armor test' },
  scene: 0,
  scenes: [{ nodes: boxes.map((_, i) => i) }],
  nodes: boxes.map(([name, t, s]) => ({ name, mesh: 0, translation: t, scale: s })),
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.45, 0.4, 0.35, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
  buffers: [{ byteLength: bin.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
    { buffer: 0, byteOffset: posBuf.length, byteLength: nrmBuf.length, target: 34962 },
    { buffer: 0, byteOffset: posBuf.length + nrmBuf.length, byteLength: idxBuf.length, target: 34963 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
    { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
  ],
};

const pad = (b, ch) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, ch)]);
const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
const binP = pad(bin, 0);
const header = Buffer.alloc(12);
header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + binP.length, 8);
const chunk = (b, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.write(type, 4); return Buffer.concat([h, b]); };
const out = path.join(__dirname, '..', 'models', 'charger.glb');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, chunk(json, 'JSON'), chunk(binP, 'BIN\0')]));
console.log('wrote', out);
