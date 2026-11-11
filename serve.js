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

// Only this machine's own pages may use the server: the Host must be localhost / 127.0.0.1 on this port
// (stops DNS rebinding), and saves must come from one of those origins with the right content type (stops
// other websites open in the browser from writing into models/).
const LOCAL = [`localhost:${port}`, `127.0.0.1:${port}`];
const SAVE_TYPES = { map: 'application/json', model: 'model/gltf-binary' };

http.createServer(async (req, res) => {
  const send = (code, body, type = 'text/plain') => {
    res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };
  if (!LOCAL.includes(String(req.headers.host || '').toLowerCase())) return send(421, 'wrong host');
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(400, 'bad request'); }

  if (req.method === 'POST') {
    const m = /^\/api\/(map|model)\/([a-z0-9-]+)$/.exec(url.pathname);
    if (!m) return send(404, 'not found');
    const origin = String(req.headers.origin || '').toLowerCase();
    if (!LOCAL.some((h) => origin === `http://${h}`)) return send(403, 'forbidden origin');
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== SAVE_TYPES[m[1]]) return send(415, 'wrong content type');
    try {
      fs.mkdirSync(modelsDir, { recursive: true });
      if (m[1] === 'map') {
        const body = await readBody(req, 2 * 1024 * 1024);
        const json = JSON.parse(body.toString('utf8'));
        if (!json || typeof json !== 'object' || Array.isArray(json)) return send(400, 'not a mapping');
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

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(400, 'bad path'); } // malformed %-escapes
  // inside the site folder only (a sibling folder sharing the name prefix doesn't count), and no dot-folders
  // or dot-files (.git, .claude, …)
  let file = path.resolve(root, '.' + path.posix.normalize('/' + rel.replace(/\\/g, '/')));
  if (file !== root && !file.startsWith(root + path.sep)) return send(403, 'forbidden');
  if (path.relative(root, file).split(path.sep).some((seg) => seg.startsWith('.'))) return send(404, 'not found');
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { /* missing: 404 below */ }
  fs.readFile(file, (err, data) => {
    if (err) return send(404, 'not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`HD2 Armor Inspector → http://localhost:${port}`));
