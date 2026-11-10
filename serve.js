// Tiny local server: serves the site and lets the 3D editor save models and hitzone mappings into models/.
// Usage: node serve.js [port]   → http://localhost:8080
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const modelsDir = path.join(root, 'models');
const port = Number(process.argv[2]) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8',
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body, type = 'text/plain') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };

  if (req.method === 'POST') {
    const m = /^\/api\/(map|model)\/([a-z0-9-]+)$/.exec(url.pathname);
    if (!m) return send(404, 'not found');
    try {
      fs.mkdirSync(modelsDir, { recursive: true });
      if (m[1] === 'map') {
        const body = await readBody(req, 2 * 1024 * 1024);
        const json = JSON.parse(body.toString('utf8'));
        fs.writeFileSync(path.join(modelsDir, `${m[2]}.map.json`), JSON.stringify(json, null, 2));
      } else {
        const body = await readBody(req, 500 * 1024 * 1024);
        if (body.slice(0, 4).toString('ascii') !== 'glTF') return send(400, 'not a .glb file');
        fs.writeFileSync(path.join(modelsDir, `${m[2]}.glb`), body);
      }
      console.log(`saved models/${m[2]}${m[1] === 'map' ? '.map.json' : '.glb'}`);
      return send(200, 'ok');
    } catch (err) {
      return send(400, String(err.message || err));
    }
  }

  let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) return send(403, 'forbidden');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) return send(404, 'not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`HD2 Armor Inspector → http://localhost:${port}`));
