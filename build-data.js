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
// "Factory Strider (Armor Broken)" is the same strider with its plates off: fold the parts it adds
// (the circuits under the front, side and rear armor) into the Factory Strider and drop the separate entry.
for (const [into, from] of [['Factory Strider', 'Factory Strider (Armor Broken)']]) {
  const a = enemies.find((e) => e.name === into), bi = enemies.findIndex((e) => e.name === from);
  if (!a || bi < 0) continue;
  for (const p of enemies[bi].parts) {
    const name = p.name.replace(/\s*\(broken [^)]*\)$/i, '');
    if (!a.parts.some((q) => q.name === name)) a.parts.push({ ...p, name });
  }
  enemies.splice(bi, 1);
}
// left off the list on purpose
for (const name of ['Cognitive Disruptor', 'Scout Strider Pilot']) { // the pilot rides on (and is shot on) the Scout Strider
  const i = enemies.findIndex((e) => e.name === name);
  if (i >= 0) enemies.splice(i, 1);
}
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
  // the scraped field is the wiki's "Overflow Cap?" column: Yes = Main transfer capped at the part's HP.
  // The app's `overflow` means the opposite (excess damage spills into Main), so flip it.
  if (typeof q.overflow === 'boolean') q.overflow = !q.overflow;
  // Constitution "500 [-0/s]": a second pool after the part's health runs out; the part stays hittable
  // (and keeps feeding Main) until it's gone. A negative rate drains it on its own (bleeding out).
  const con = /^\s*([\d,]+)\s*\[\s*(-?[\d,]+)\s*\/s\]/.exec(q.constitution || '');
  if (con) { q.cons = Number(con[1].replace(/,/g, '')); q.bleed = Math.min(0, Number(con[2].replace(/,/g, ''))); }
  const m =/\((\d+)\)\s*$/.exec(q.name);
  q.count = q.count || (m ? +m[1] : 1);
  return q;
};
// Armor that must be destroyed before the part under it can be hit (time to kill strips it first)
const LIMB = ['Limb Armor (8)', 'Limb Armor'];
const COVERS = [
  { enemy: /overseer/i, parts: { 'Torso': ['Chest Armor'], 'Right Arm': LIMB, 'Left Arm': LIMB, 'Legs (2)': LIMB } },
  { enemy: /^agitator$/i, parts: { 'Head': ['Helmet'], 'Torso': ['Torso Armor'], 'Upper Arms (2)': ['Pauldrons (2)'] } },
  // head body, neck and leg assemblies can be hit with the armor on; only the circuits hide under plates
  { enemy: /^factory strider$/i, parts: { 'Circuits Front': ['Front Armor'], 'Side Circuits (2)': ['Side Armor (2)'], 'Rear Circuits': ['Rear Armor'] } },
  // bugs: a broken torso plate opens the Inner Flesh, a broken leg plate the Leg Flesh
  { enemy: /charger/i, parts: { 'Inner Flesh': ['Torso Armor (2)'], 'Leg Flesh (4)': ['Front Leg Armor (2)'] } },
  { enemy: /^impaler$/i, parts: { 'Inner Flesh': ['Torso Armor (2)'], 'Leg Flesh (4)': ['Leg Armor (4)'] } },
  { enemy: /bile titan/i, parts: { 'Inner Flesh': ['Torso Armor (2)'], 'Front Left Leg Flesh': ['Leg Armor (12)'], 'Leg Flesh (3)': ['Leg Armor (12)'] } },
];

// What a projectile reaches after over-penetrating a part (inner hitboxes aren't meshes in the models).
// Charger butt → Inner Flesh is the wiki's own overpenetration example.
const BEHIND = [{ enemy: /charger/i, parts: { 'Butt': 'Inner Flesh' } }];

// Wiki location fixes: where a hitzone really faces when the wiki table disagrees with the game
const LOCATION_FIX = [{ enemy: /hulk/i, part: /^heatsink$/i, location: 'Rear, Side' }];

// Armor that never breaks: still passes its % to Main, but never exposes anything
const INDESTRUCTIBLE = [{ enemy: /hive guard/i, part: /armou?r|plate/i }];

// a part under two plates: either one breaking exposes it (Rupture Charger: the leg flesh runs under the upper
// arm's Front Leg Armor and under the Frontal Tarsal Plate of the ground segment)
// the wiki's "No (Downs)": destroying the part (constitution included) downs the enemy, and anything that
// damages it after that finishes it. Verified in game:
// - Dropship: a single thruster destroyed brings it down
// allBroken: every piece's health gone also downs it, constitution or not
const DOWNS = [{ enemy: /^dropship$/i, part: /^thruster/i }];
// Hulk legs (verified in game): a leg whose 500 health is gone is "broken" (damaged-leg model, still hittable,
// damage goes into its 500 constitution); with the constitution gone too it's "destroyed" (no hitbox, nothing
// hurts it). One leg destroyed leaves Main at 1 HP (unless the overflow already emptied Main: Recoilless, Spear);
// both legs broken kills the Hulk (killAllBroken).
const MAIN_TO_ON_GONE = [{ enemy: /hulk/i, part: /^legs\b/i, value: 1, killAllBroken: true }];
const ALSO_COVERED = [{ enemy: /^Rupture Charger$/, parts: { 'Leg Flesh (4)': 'Frontal Tarsal Plate Armor (2)' } }];
enemies.forEach((e) => {
  e.parts = (e.parts || []).map(normPart);
  for (const c of DOWNS) if (c.enemy.test(e.name)) e.parts.forEach((p) => { if (c.part.test(p.name)) { p.fatal = 'downs'; if (c.allBroken) p.downsAllBroken = true; } });
  for (const c of MAIN_TO_ON_GONE) if (c.enemy.test(e.name)) e.parts.forEach((p) => { if (c.part.test(p.name)) { p.fatal = false; p.mainToOnGone = c.value; if (c.killAllBroken) p.killAllBroken = true; } });
  for (const c of ALSO_COVERED) if (c.enemy.test(e.name)) e.parts.forEach((p) => { if (c.parts[p.name]) p.alsoCoveredBy = c.parts[p.name]; });
  for (const c of BEHIND) if (c.enemy.test(e.name)) e.parts.forEach((p) => { if (c.parts[p.name]) p.behind = c.parts[p.name]; });
  for (const c of LOCATION_FIX) if (c.enemy.test(e.name)) e.parts.forEach((p) => { if (c.part.test(p.name)) p.location = c.location; });
  for (const c of INDESTRUCTIBLE) if (c.enemy.test(e.name)) e.parts.forEach((p) => { if (c.part.test(p.name)) p.indestructible = true; });
  for (const c of COVERS) {
    if (!c.enemy.test(e.name)) continue;
    for (const p of e.parts) {
      const cover = (c.parts[p.name] || []).find((n) => e.parts.some((q) => q.name === n));
      if (cover) p.coveredBy = cover;
    }
  }
  // Everyone else: "Leg Flesh" sits under "Leg Armor", "Tentacle Flesh" under "Tentacle Armor";
  // Inner Flesh / Internals sit under the torso, back or carapace plate
  if (!/broken/i.test(e.name)) for (const p of e.parts) {
    if (p.coveredBy || !/\b(inner|internals?|flesh)\b/i.test(p.name)) continue;
    if (/tentacle/i.test(p.name)) { p.open = true; continue; } // Impaler tentacles are their own hitzones, not under the tentacle armor
    const armor = e.parts.filter((q) => /\barmou?r\b|\bplates?\b|carapace/i.test(q.name) && !/weak ?spot/i.test(q.name));
    const words = p.name.toLowerCase().match(/[a-z]+/g).filter((w) => !/^(inner|internals?|exposed|flesh|front|rear|left|right)$/.test(w));
    let cover = words.length ? armor.find((q) => words.every((w) => q.name.toLowerCase().includes(w))) : null;
    if (!cover && /\b(inner|internals?)\b/i.test(p.name) && !words.length)
      cover = ['torso', 'dorsal', 'carapace'].map((k) => armor.find((q) => q.name.toLowerCase().includes(k))).find(Boolean);
    if (cover) p.coveredBy = cover.name;
  }
  // "Inner Flesh", "Internals", "Leg Flesh"…: behind armor until it breaks
  if (!/broken/i.test(e.name)) e.parts.forEach((p) => { if (p.coveredBy) return; // its plate gets stripped first instead
    if (p.open) { delete p.open; return; }
    if (/\b(inner|internals?|flesh)\b/i.test(p.name)) p.hidden = true;
    // undersides aren't armored over, just hard to get an angle on
    else if (/\bunderside\b/i.test(p.name)) p.hidden = 'angle';
  });
});

// Stagger Force needed to stagger (interrupt) each enemy, from the wiki's Stagger page
const STAGGER = {
  1: ['Caustic Spitter', 'Pouncer', 'Scavenger', 'Spore Burst Scavenger', /voteless/i],
  10: ['Assault Raider', 'Brawler', 'Commissar', 'Incendiary Rocket Raider', 'Jet Brigade Commissar', 'Jet Brigade MG Raider', 'Jet Brigade Trooper', 'MG Raider', 'Marauder', 'Pyro Trooper', 'Rocket Raider', 'Trooper'],
  15: ['Hunter', 'Predator Hunter', 'Spore Burst Hunter'],
  20: ['Alpha Warrior', 'Caustic Warrior', 'Hive Guard', 'Rupture Warrior', 'Spore Burst Warrior', 'Warrior', 'Agitator', 'Radical'],
  25: ['Alpha Commander', 'Brood Commander'],
  30: ['Caustic Spewer', 'Nursing Spewer', 'Predator Stalker', 'Rupture Spewer', 'Stalker', 'Berserker', 'Conflagration Devastator', 'Devastator', 'Heavy Devastator',
    'Incendiary MG Devastator', 'Jet Brigade Devastator', 'Reinforced Scout Strider', 'Rocket Devastator', 'Scout Strider', 'Elevated Overseer'],
  35: ['Crescent Overseer', 'Overseer'],
  38: ['Dragonroach', 'Charger', 'Charger Behemoth', 'Rupture Charger', 'Caustic Charger'],
  40: ['Hulk Bruiser', 'Hulk Firebomber', 'Hulk Obliterator', 'Hulk Scorcher', 'Jet Brigade Hulk Bruiser', 'Jet Brigade Hulk Scorcher', 'War Strider', 'Gatekeeper', 'Harvester', 'Veracitor'],
  45: ['Fleshmob'],
  50: ['Impaler', 'Bile Titan', 'Spore Burst Bile Titan'],
};
enemies.forEach((e) => {
  for (const [t, names] of Object.entries(STAGGER)) {
    const base = e.name.replace(/\s*\((armor )?broken\)$/i, ''); // broken variants stagger like the original
    if (names.some((n) => (typeof n === 'string' ? n === base : n.test(base)))) e.stagger = +t;
  }
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

// Stagger and push forces per weapon mode, gathered from each weapon page's "Special Effects" (data/forces.json)
const forcesPath = path.join(dir, 'forces.json');
let forceModes = 0;
if (fs.existsSync(forcesPath)) {
  const forces = JSON.parse(fs.readFileSync(forcesPath, 'utf8'));
  weapons.forEach((w) => {
    const f = forces[w.id];
    if (!f || !f.modes) return;
    const list = Object.values(f.modes);
    (w.modes || []).forEach((m) => {
      const v = f.modes[m.name] || (list.length === 1 ? list[0] : null);
      if (!v) return;
      if (v.stagger != null) m.stagger = v.stagger;
      if (v.push != null) m.push = v.push;
      if (v.demolition != null) m.demolition = v.demolition; // demolition force: what structures it can destroy
      if (m.explosion) {
        if (v.exStagger != null) m.explosion.stagger = v.exStagger;
        if (v.exPush != null) m.explosion.push = v.exPush;
        if (v.exDemolition != null) m.explosion.demolition = v.exDemolition;
      }
      if (m.stagger != null || m.explosion?.stagger != null) forceModes++;
    });
  });
}

// Charge weapons (data/charge.json): the weapon card gets a charge-time slider instead of the mode list.
const chargePath = path.join(dir, 'charge.json');
if (fs.existsSync(chargePath)) {
  const charge = JSON.parse(fs.readFileSync(chargePath, 'utf8'));
  for (const [id, c] of Object.entries(charge)) {
    if (id.startsWith('_')) continue;
    const w = weapons.find((x) => x.id === id);
    if (!w) { console.warn(`charge.json: no weapon ${id}`); continue; }
    const bad = c.steps.filter((s) => !w.modes.some((m) => m.name === s.mode));
    if (bad.length) { console.warn(`charge.json: ${id} has no mode ${bad.map((s) => s.mode).join(', ')}`); continue; }
    w.charge = c;
  }
}

// Reload times (data/reload.json, from each weapon page's infobox): a full reload, used by time to kill once
// the shots needed run past one magazine.
const reloadPath = path.join(dir, 'reload.json');
if (fs.existsSync(reloadPath)) {
  const reload = JSON.parse(fs.readFileSync(reloadPath, 'utf8'));
  let n = 0;
  for (const w of weapons) {
    const r = reload[w.id];
    if (r && typeof r.reload === 'number' && r.reload > 0) { w.reload = r.reload; n++; }
  }
  console.log(`reload: ${n} weapons with a reload time`);
}

// Shrapnel (wiki: AC-8 P2, shared by the Autocannon's flak shell and the Eruptor's explosion): 30 fragments
// of 110 / 35 durable, AP 3/3/2/0 by angle. The flak shell itself is 150/150 AP2 with a proximity fuse
// (it bursts even when the shell would glance off). Both send their fragments out in every direction
// (a full sphere from the burst; the user's in-game call, over patch 1.002.201's "180-ish arc" for the Eruptor).
const AC8_P2 = { count: 30, damage: 110, durable: 35, apAngles: [3, 3, 2, 0], ballistics: { velocity: 30, caliber: 10, mass: 100, drag: 0.4, penSlowdown: 0.25 } };
const SHRAPNEL = [
  { id: 'ac-8-autocannon', mode: 'Flak', set: { damage: 150, durable: 150, ap: 2, apAngles: [2, 2, 2, 0], pellets: 1, proximity: true }, shrapnel: { ...AC8_P2, spread: 'sphere' } },
  { id: 'r-36-eruptor', mode: 'Standard', shrapnel: { ...AC8_P2, spread: 'sphere' } },
];
for (const r of SHRAPNEL) {
  const m = weapons.find((w) => w.id === r.id)?.modes.find((x) => x.name === r.mode);
  if (!m) { console.warn(`shrapnel: ${r.id} / ${r.mode} not found`); continue; }
  Object.assign(m, r.set || {}, { shrapnel: r.shrapnel });
}

// Display names: drop the "A/" (sentry) and "E/" (emplacement) prefixes; ids stay the same so links keep working
weapons.forEach((w) => {
  if (['Sentry', 'Emplacement'].includes(w.category)) w.name = w.name.replace(/^[AE]\//, '');
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

console.log(`stagger: ${enemies.filter((e) => e.stagger != null).length} enemies with a threshold, ${forceModes} weapon modes with forces`);

// Translations: translations/*.csv (type, english, where, then a column per language: korean, chinese,
// japanese, … with a "<language> review" column beside each for drafts awaiting approval); empty cells stay English
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const LANG_COLS = { korean: 'ko', chinese: 'zh', 'simplified chinese': 'zh', 'traditional chinese': 'zh-hant', japanese: 'ja',
  german: 'de', french: 'fr', spanish: 'es', italian: 'it', russian: 'ru', ukrainian: 'uk' };
const i18n = {};
const trDir = path.join(__dirname, 'translations');
if (fs.existsSync(trDir)) {
  for (const f of fs.readdirSync(trDir)) {
    if (!/\.csv$/i.test(f)) continue;
    const rows = parseCsv(fs.readFileSync(path.join(trDir, f), 'utf8').replace(/^\ufeff/, ''));
    const head = rows.shift().map((h) => h.trim().toLowerCase());
    const en = head.indexOf('english');
    if (en < 0) continue;
    head.forEach((h, c) => {
      const lang = LANG_COLS[h];
      if (!lang) return; // type, where, review columns
      const dict = (i18n[lang] ||= {});
      let n = 0;
      for (const r of rows) if (r[en]?.trim() && r[c]?.trim()) { dict[r[en].trim()] = r[c].trim(); n++; }
      console.log(`translations: ${f} ${h} — ${n} of ${rows.length} filled in`);
    });
  }
}

const out = {
  built: new Date().toISOString().slice(0, 10),
  i18n,
  models,
  thumbs,
  wthumbs,
  enemies: uniq(enemies),
  weapons: uniq(weapons).filter((w) => Array.isArray(w.modes) && w.modes.length),
};
fs.writeFileSync(path.join(dir, 'data.js'), 'window.HD2_DATA = ' + JSON.stringify(out) + ';\n');
console.log(`enemies: ${out.enemies.length}, weapons: ${out.weapons.length}, modes with angle AP: ${angleModes}, ballistics: ${ballisticModes}, blast radii: ${radiusModes}, beam: ${beamModes}, dot: ${dotModes}`);
