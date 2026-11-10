// Merges data/*.json into data/data.js so index.html works when opened directly from disk.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'data');
const read = (f) => {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) { console.warn('missing', f); return []; }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};

const enemies = [
  ...read('terminids.json'),
  ...read('automatons.json'),
  ...read('illuminate.json'),
];
const weapons = [
  ...read('weapons-primary-secondary.json'),
  ...read('weapons-support.json'),
];

// De-duplicate ids so URL state stays unambiguous.
const uniq = (list) => {
  const seen = new Map();
  return list.map((x) => {
    let id = x.id;
    const n = seen.get(id) || 0;
    seen.set(id, n + 1);
    if (n) id = `${id}-${n + 1}`;
    return { ...x, id };
  });
};

// Smooth over wiki table quirks so the app only sees one shape.
const normPart = (p) => {
  const q = { ...p };
  // "Yes (Downs)" sometimes lands in the Constitution column on the wiki
  if (!q.fatal && /yes\s*\(downs\)/i.test(q.constitution || '')) q.fatal = 'downs';
  if (/both/i.test(q.fatalNote || '')) q.fatalAll = true; // fatal only once every instance is destroyed
  if (q.health === 'infinite') q.health = 1e12;
  if (typeof q.health === 'string' && q.health !== 'main') q.health = Number(q.health.replace(/[^\d.]/g, '')) || 'main';
  if (q.health == null) q.health = 'main';
  if (typeof q.av !== 'number') q.av = Number(q.av);
  if (Number.isNaN(q.av)) q.av = -1;
  const m = /\((\d+)\)\s*$/.exec(q.name);
  q.count = q.count || (m ? +m[1] : 1);
  return q;
};
enemies.forEach((e) => {
  e.parts = (e.parts || []).map(normPart);
  // "Inner Flesh", "Internals"…: behind armor until it breaks
  if (!/broken/i.test(e.name)) e.parts.forEach((p) => { if (/\b(inner|internals?)\b/i.test(p.name)) p.hidden = true; });
});

// Game archive IDs per enemy, from the HD2 modding community's ID sheet (Enemies & NPC IDs tab),
// so you know which archive to open in Filediver. The CSV holds four side-by-side column groups.
const ARCHIVE_ALIASES = {
  'charger bull': 'charger behemoth', 'havester (tripod)': 'harvester', 'dragon': 'dragonroach',
  'bile spitter': 'caustic spitter', 'bile spewer': 'caustic spewer', 'bile warrior': 'caustic warrior',
  'spore charger': 'caustic charger', 'drop ship': 'dropship', 'vox/siege engine': 'vox engine',
  'overseers (un/armored)': 'overseer', 'overseer + weapon': 'overseer', 'overship': 'illuminate overship',
};
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const archives = [];
const csvPath = path.join(dir, 'archive-ids.csv');
if (fs.existsSync(csvPath)) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8')).slice(1);
  // groups start at columns 0, 4, 8 (archive, name, notes); skip the NPC group at 12
  for (const r of rows) for (const c of [0, 4, 8]) {
    const id = (r[c] || '').trim(), name = (r[c + 1] || '').trim();
    if (/^[0-9a-f]{16}$/i.test(id) && name && name !== 'TBD') archives.push({ id, name, note: (r[c + 2] || '').trim() });
  }
}
const low = (s) => s.toLowerCase().trim();
enemies.forEach((e) => {
  const en = low(e.name).replace(/\s*\(.*\)$/, ''); // "Factory Strider (Armor Broken)" → base unit
  const exact = archives.filter((a) => (ARCHIVE_ALIASES[low(a.name)] || low(a.name)) === en);
  // fall back to the family archive: "Hulk Bruiser" → "Hulk", "Heavy Devastator" → "Devastator"
  const family = exact.length ? [] : archives.filter((a) => new RegExp(`\\b${low(a.name).replace(/[^a-z ]/g, '')}\\b`).test(en) && low(a.name).length > 3);
  const found = exact.length ? exact : family;
  if (found.length) e.archives = found.map((a) => ({ id: a.id, name: a.name, note: a.note, exact: !!exact.length }));
});

// Per-impact-angle AP from the weapon pages: { weaponId: { modeName: [direct, slight, large, extreme] } }
const apAngles = {};
for (const f of ['ap-angles-primary.json', 'ap-angles-support.json']) {
  const p = path.join(dir, f);
  if (fs.existsSync(p)) Object.assign(apAngles, JSON.parse(fs.readFileSync(p, 'utf8')));
}
let angleModes = 0;
weapons.forEach((w) => {
  const a = apAngles[w.id];
  if (!a) return;
  (w.modes || []).forEach((m) => {
    const v = a[m.name] || (w.modes.length === 1 ? Object.values(a)[0] : null);
    if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number')) { m.apAngles = v; angleModes++; }
  });
});

// Projectile ballistics (drag falloff) and explosion radii: { weaponId: { modeName: { velocity, caliber, mass, drag, ..., explosion } } }
const ballistics = {};
for (const f of ['ballistics-primary.json', 'ballistics-support.json']) {
  const p = path.join(dir, f);
  if (fs.existsSync(p)) Object.assign(ballistics, JSON.parse(fs.readFileSync(p, 'utf8')));
}
let ballisticModes = 0, radiusModes = 0;
weapons.forEach((w) => {
  const b = ballistics[w.id];
  if (!b) return;
  (w.modes || []).forEach((m) => {
    const v = b[m.name] || (w.modes.length === 1 ? Object.values(b)[0] : null);
    if (!v) return;
    const { explosion, ...proj } = v;
    // Eagles and orbitals fall from the sky, so range to the target doesn't apply
    if (!['Eagle', 'Orbital'].includes(w.category) && (proj.caliber || proj.drag != null || proj.velocity)) { m.ballistics = proj; ballisticModes++; }
    if (explosion && m.explosion) {
      const ex = m.explosion;
      ex.inner = explosion.inner ?? ex.inner ?? ex.innerRadius ?? null;
      ex.outer = explosion.outer ?? ex.outer ?? ex.outerRadius ?? null;
      if (explosion.shockwave != null) ex.shockwave = explosion.shockwave;
      if (explosion.falloff) ex.falloff = String(explosion.falloff).toLowerCase();
      if (explosion.apOuter != null) ex.apOuter = explosion.apOuter;
      if (ex.ap == null && explosion.ap != null) ex.ap = explosion.ap;
      if (ex.inner != null || ex.outer != null) radiusModes++;
    }
  });
});

// How each mode deals damage over time, for time-to-kill:
//   beam: damage is listed per second (continuous lasers)
//   dot:  flame and gas sprays/grenades; their burn or gas damage per second hits Main only
// DPS values come from the wiki notes recorded with each weapon.
const DOT = [
  { id: /^flam-40-flamethrower$/, mode: 'Spray', label: 'Burning', dps: 100, ap: 4 },
  { id: /^flam-66-torcher$/, label: 'Burning', dps: 150, ap: 4 },
  { id: /^p-72-crisper$/, label: 'Burning', dps: 150, ap: 4 },
  { id: /^b-flam-80-cremator$/, mode: 'Spray', label: 'Flames', dps: 225, ap: 4 },
  { id: /stoker$/, mode: 'Flamethrower', label: 'Burning', dps: 150, ap: 4 },
  { id: /^g-10-incendiary$/, label: 'Burning', dps: 100, ap: 4 },
  { id: /^g-13-incendiary-impact$/, label: 'Burning', dps: 100, ap: 4 },
  { id: /^tx-41-sterilizer$/, mode: 'Spray', label: 'Gas', dps: 30, ap: null },
  { id: /^g-4-gas$/, label: 'Gas', dps: 25, ap: 6 },
];
let beamModes = 0, dotModes = 0;
weapons.forEach((w) => {
  (w.modes || []).forEach((m) => {
    const note = `${m.note || ''} ${w.note || ''}`;
    if (!w.rpm && !m.rpm && /damage per second/i.test(note)) { m.beam = true; beamModes++; }
    const d = DOT.find((x) => x.id.test(w.id) && (!x.mode || x.mode === m.name));
    if (d) { m.dot = { label: d.label, dps: d.dps, ap: d.ap ?? m.apAngles?.[0] ?? m.ap }; dotModes++; }
  });
});

// Which enemies have a 3D model in models/, so the site can badge them and skip pointless requests.
const modelsDir = path.join(__dirname, 'models');
const models = {};
if (fs.existsSync(modelsDir)) {
  for (const f of fs.readdirSync(modelsDir)) {
    const m = /^([a-z0-9-]+)\.glb$/.exec(f);
    if (!m) continue;
    // the box-built test model from tools/make-test-glb.js stays local-only
    if (fs.readFileSync(path.join(modelsDir, f)).subarray(0, 2048).toString('latin1').includes('hd2-armor test')) continue;
    const mb = fs.statSync(path.join(modelsDir, f)).size / 1048576;
    if (mb > 50) console.warn(`models/${f} is ${mb.toFixed(0)} MB — compress it (see README) before publishing`);
    models[m[1]] = { mapped: fs.existsSync(path.join(modelsDir, `${m[1]}.map.json`)), mb: +mb.toFixed(2) };
  }
}

// Enemy preview thumbnails in images/enemies/<id>.png (made by tools/make-thumbs.ps1 from the wiki's enemy icons)
const thumbsDir = path.join(__dirname, 'images', 'enemies');
const thumbs = {};
if (fs.existsSync(thumbsDir)) for (const f of fs.readdirSync(thumbsDir)) { const m = /^([a-z0-9-]+).png$/.exec(f); if (m) thumbs[m[1]] = 1; }

// Weapon thumbnails in images/weapons/<id>.png (renders) or .svg (stratagem icons)
const wthumbsDir = path.join(__dirname, 'images', 'weapons');
const wthumbs = {};
if (fs.existsSync(wthumbsDir)) for (const f of fs.readdirSync(wthumbsDir)) { const m = /^([a-z0-9-]+).(png|svg)$/.exec(f); if (m) wthumbs[m[1]] = m[2]; }

const out = {
  built: new Date().toISOString().slice(0, 10),
  models,
  thumbs,
  wthumbs,
  enemies: uniq(enemies),
  weapons: uniq(weapons).filter((w) => Array.isArray(w.modes) && w.modes.length),
};
fs.writeFileSync(path.join(dir, 'data.js'), 'window.HD2_DATA = ' + JSON.stringify(out) + ';\n');
console.log(`enemies: ${out.enemies.length}, weapons: ${out.weapons.length}, modes with angle AP: ${angleModes}, ballistics: ${ballisticModes}, blast radii: ${radiusModes}, beam: ${beamModes}, dot: ${dotModes}`);
