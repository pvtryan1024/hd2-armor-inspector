/* HD2 Armor Inspector — damage model + UI.
 * Model (per helldivers.wiki.gg/wiki/Damage):
 *   AP > AV → 100%, AP = AV → 65%, AP < AV → 0 (ricochet)
 *   dealt = floor((std × (1 − durable%) + durableDmg × durable%) × penMult)
 *   a part passes dealt × %ToMain to Main; without overflow the transfer is capped at the part's remaining HP
 *   explosions deal durable damage; ExDR shifts that share from the part straight to Main (ignoring Main's AV)
 *   enemy dies when Main hits 0 or a fatal part is destroyed
 */
(() => {
  'use strict';

  const DATA = window.HD2_DATA || { enemies: [], weapons: [] };
  // Model loading/mapping tools only show when running locally (node serve.js) or with ?edit in the URL.
  const EDITOR = ['localhost', '127.0.0.1'].includes(location.hostname) || /[?&]edit/.test(location.search);
  const MAX_SHOTS = 999;
  const AV_NAMES = ['Unarmored', 'Very Light', 'Light', 'Medium', 'Heavy', 'Tank I', 'Tank II', 'Tank III', 'Tank IV', 'Tank V', 'Tank VI', 'Indestructible'];
  // Impact angle bands from the wiki's Damage page; weapons list one AP per band.
  const ANGLE_BANDS = [
    { name: 'Direct', range: '0–25°', max: 25 },
    { name: 'Slight angle', range: '26–60°', max: 60 },
    { name: 'Large angle', range: '61–80°', max: 80 },
    { name: 'Extreme angle', range: '81–90°', max: 90 },
  ];
  const bandOf = (deg) => ANGLE_BANDS.findIndex((b) => deg <= b.max + 0.5);
  const FACTION_ORDER = ['Terminids', 'Automatons', 'Illuminate'];
  const CAT_ORDER = ['Primary', 'Secondary', 'Throwable', 'Support', 'Eagle', 'Orbital', 'Sentry', 'Emplacement'];
  // shots-to-kill ramp: 1, 2, 3–4, 5–7, 8–12, 13–20, 21+
  const TTK_STEPS = [1, 2, 4, 7, 12, 20, Infinity];
  const TTK_COLORS = ['#1fae63', '#5cc25a', '#a3c94a', '#e0c43a', '#e8962f', '#e0602f', '#c8382f'];

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n == null || Number.isNaN(n) ? '—' : Number.isFinite(n) ? Math.round(n).toLocaleString() : '∞');
  const pct = (f) => (f == null ? '—' : `${Math.round(f * 100)}%`);
  const avName = (av) => (av < 0 ? 'No hitbox' : AV_NAMES[av] ?? `AV${av}`);

  const state = {
    faction: 'all',
    cat: 'all',
    enemyId: null,
    weaponId: null,
    mode: 0,
    explosion: true,
    allPellets: true,
    band: 0, // impact angle band for the body map / tables (3D uses the real angle)
    view: 'all',
    color: 'pen',
    tab: 'parts',
    stageView: 'map', // 'map' | '3d'
    fire: false,
    sim: null,
  };

  /* ---------------- damage engine ---------------- */

  function penMult(ap, av) {
    if (av == null || av < 0 || av >= 11) return null; // no hitbox / indestructible
    if (ap > av) return 1;
    if (ap === av) return 0.65;
    return 0;
  }

  // "Main", or a group pool like "Turret Main" / "Hull Main" on tanks
  function isMainRow(p) { return /(^|\s)main$/i.test(p.name.trim()); }

  function mainPart(enemy) {
    return enemy.parts.find((p) => /^main$/i.test(p.name.trim())) || enemy.parts.find(isMainRow) || null;
  }

  /** Index of the Main pool a part feeds: "Turret Front" → "Turret Main", otherwise plain "Main". */
  function mainIndexFor(enemy, idx) {
    const p = enemy.parts[idx];
    if (isMainRow(p)) return idx;
    const mains = enemy.parts.map((q, i) => (isMainRow(q) ? i : -1)).filter((i) => i >= 0);
    if (!mains.length) return -1;
    const first = p.name.toLowerCase().split(/\s+/)[0];
    const grp = mains.find((i) => enemy.parts[i].name.toLowerCase().startsWith(first + ' '));
    if (grp != null) return grp;
    return mains.find((i) => /^main$/i.test(enemy.parts[i].name.trim())) ?? mains[0];
  }

  /** Projectile AP for an angle band; weapons without angle data keep one AP. */
  function apFor(mode, band) {
    return mode.apAngles?.[band || 0] ?? mode.ap;
  }

  /** Damage a single trigger pull does to one part, before HP caps. */
  function shotDamage(mode, part, enemy, opts) {
    const ap = apFor(mode, opts.band);
    const pellets = opts.allPellets ? Math.max(1, mode.pellets || 1) : 1;
    const m = penMult(ap, part.av);
    const d = part.durable ?? 0;
    const raw = (mode.damage || 0) * (1 - d) + (mode.durable ?? mode.damage ?? 0) * d;
    const proj = m == null || mode.explosionOnly ? 0 : Math.floor(raw * m) * pellets;

    let partEx = 0, mainEx = 0, exMult = null;
    const ex = opts.explosion ? mode.explosion : null;
    if (ex && (ex.damage || ex.durable)) {
      const e = ex.durable ?? ex.damage;
      const exAp = ex.ap ?? 0; // explosions don't care about impact angle
      exMult = penMult(exAp, part.av);
      const exdr = part.exdr ?? 0;
      partEx = exMult == null ? 0 : Math.floor(e * (1 - exdr) * exMult);
      if (!isMainRow(part)) mainEx = Math.floor(e * exdr); // redirected share ignores Main AV
    }
    return { proj, partEx, mainEx, pen: m, exPen: exMult, total: proj + partEx };
  }

  /* Stateful simulation: shared by the shots-to-kill numbers and fire mode.
   * Parts with a count, e.g. "Claws (2)", track each instance; shots hit the first one still standing. */
  function newSim(enemy) {
    return {
      hp: enemy.parts.map((p) => (isMainRow(p) || typeof p.health !== 'number' ? null : Array(p.count || 1).fill(p.health))),
      pool: enemy.parts.map((p) => (isMainRow(p) && typeof p.health === 'number' ? p.health : null)),
      shots: 0,
      dead: null, // { how: 'killed' | 'downed', why, idx }
      log: [],
    };
  }

  function applyShot(sim, enemy, idx, s) {
    const part = enemy.parts[idx];
    const out = { progress: false, toMain: 0, broke: false, dealt: s.total };
    if (sim.dead || part.av < 0 || part.av >= 11) return out;
    sim.shots++;
    const mi = mainIndexFor(enemy, idx);
    const toMain = part.toMain ?? 1;

    if (mi === idx) {
      out.toMain = s.total;
    } else if (sim.hp[idx] == null) {
      out.toMain = s.total * toMain + s.mainEx;
    } else {
      const inst = sim.hp[idx];
      const k = inst.findIndex((h) => h > 0);
      if (k >= 0) {
        const capped = part.overflow ? s.total : Math.min(s.total, inst[k]);
        out.toMain = capped * toMain + s.mainEx;
        inst[k] -= s.total;
        if (s.total > 0) out.progress = true;
        if (inst[k] <= 0) {
          out.broke = true;
          const allGone = inst.every((h) => h <= 0);
          if ((part.fatal === true || part.fatal === 'downs') && (!part.fatalAll || allGone)) {
            sim.dead = { how: part.fatal === 'downs' ? 'downed' : 'killed', why: `${part.name} destroyed`, idx };
          }
        }
      } else {
        // every instance gone: only overflow parts keep feeding Main
        out.toMain = (part.overflow ? s.total * toMain : 0) + s.mainEx;
      }
    }

    if (mi >= 0 && sim.pool[mi] != null && out.toMain > 0) {
      sim.pool[mi] -= out.toMain;
      out.progress = true;
      const mp = enemy.parts[mi];
      if (sim.pool[mi] <= 0 && !sim.dead && (/^main$/i.test(mp.name.trim()) || mp.fatal)) {
        sim.dead = { how: 'killed', why: `${mp.name} health depleted`, idx: mi };
      }
    }
    return out;
  }

  /** Repeated shots into one hitzone until the enemy dies or nothing changes. */
  function simulate(mode, enemy, idx, opts) {
    const part = enemy.parts[idx];
    const s = shotDamage(mode, part, enemy, opts);
    const res = { ...s, killAt: null, breakAt: null, downs: false, perMain: 0, why: '' };
    const sim = newSim(enemy);
    for (let shot = 1; shot <= MAX_SHOTS; shot++) {
      const o = applyShot(sim, enemy, idx, s);
      if (shot === 1) res.perMain = o.toMain;
      if (o.broke && res.breakAt == null) res.breakAt = shot;
      if (sim.dead) {
        res.killAt = shot;
        res.downs = sim.dead.how === 'downed';
        res.why = sim.dead.why;
        break;
      }
      if (!o.progress) break;
    }
    return res;
  }

  function evalEnemy(weapon, modeIdx, enemy, opts) {
    const mode = weapon.modes[modeIdx] || weapon.modes[0];
    return enemy.parts.map((p, i) => ({ part: p, r: simulate(mode, enemy, i, opts) }));
  }


  function visible(part, view) {
    if (view === 'all') return true;
    const loc = (part.location || '').toLowerCase();
    if (!loc || loc.includes('no view')) return true;
    return loc.includes(view);
  }

  function bestOf(results, view) {
    let best = null;
    for (const x of results) {
      if (!visible(x.part, view) || x.r.killAt == null) continue;
      if (!best || x.r.killAt < best.r.killAt || (x.r.killAt === best.r.killAt && x.r.total > best.r.total)) best = x;
    }
    return best;
  }

  /* ---------------- classification for the body map ---------------- */

  function region(name) {
    const n = name.toLowerCase();
    if (/^main$/.test(n)) return 'body';
    if (/head|eye|face|visor|jaw|mandible|brain|mouth|skull|crown|optic|sensor/.test(n)) return 'head';
    if (/leg|foot|feet|hip|thigh|knee|shin|toe|tread|track|wheel/.test(n)) return 'legs';
    if (/vent|heat ?sink|sack|sac\b|butt|abdomen|tail|back|rear|exhaust|inner|underside|belly|weak|core|engine|fuel|tank\b|ass\b|hatch/.test(n)) return 'rear';
    if (/arm|claw|cannon|gun|launcher|weapon|shield|turret|rocket|scythe|blade|pod|hand|fist|chainsaw|flamer|minigun|barrel|wing|tentacle|pincer/.test(n)) return 'arms';
    return 'body';
  }

  /* ---------------- colours ---------------- */

  function penClass(r, part) {
    if (part.av < 0 || part.av >= 11) return 'immune';
    const p = Math.max(r.pen ?? 0, r.partEx > 0 ? (r.exPen ?? 0) : 0);
    if (r.total <= 0 && r.mainEx <= 0) return 'none';
    if (p >= 1) return 'full';
    if (p > 0) return 'half';
    return r.mainEx > 0 ? 'half' : 'none';
  }
  const PEN_VAR = { full: 'var(--pen-full)', half: 'var(--pen-half)', none: 'var(--pen-none)', immune: 'var(--pen-immune)' };
  const PEN_HEX = { full: '#2fbf71', half: '#c2dc35', none: '#e0412f', immune: '#4a525c' };
  const PEN_LABEL = { full: 'Penetrates · 100%', half: 'Reduced · 65%', none: 'Ricochet · 0', immune: 'Immune' };

  function ttkColor(n) {
    if (n == null) return PEN_HEX.immune;
    const i = TTK_STEPS.findIndex((s) => n <= s);
    return TTK_COLORS[i];
  }

  /* ---------------- lookups ---------------- */

  const enemyById = (id) => DATA.enemies.find((e) => e.id === id);
  const weaponById = (id) => DATA.weapons.find((w) => w.id === id);
  const enemy = () => enemyById(state.enemyId);
  const weapon = () => weaponById(state.weaponId);
  const opts = () => ({ explosion: state.explosion, allPellets: state.allPellets, band: state.band });

  /* ---------------- rendering: lists ---------------- */

  function renderFactionTabs() {
    const factions = FACTION_ORDER.filter((f) => DATA.enemies.some((e) => e.faction === f));
    const extra = [...new Set(DATA.enemies.map((e) => e.faction))].filter((f) => !factions.includes(f));
    const all = ['all', ...factions, ...extra];
    $('#factionTabs').innerHTML = all
      .map((f) => `<button data-f="${esc(f)}" class="${state.faction === f ? 'on' : ''}">${f === 'all' ? 'All' : esc(f.replace('Automatons', 'Bots').replace('Terminids', 'Bugs').replace('Illuminate', 'Squids'))}</button>`)
      .join('');
  }

  function renderEnemyList() {
    const q = $('#enemySearch').value.trim().toLowerCase();
    const list = DATA.enemies.filter((e) => (state.faction === 'all' || e.faction === state.faction) && (!q || e.name.toLowerCase().includes(q)));
    const groups = {};
    list.forEach((e) => (groups[e.faction] ||= []).push(e));
    const order = Object.keys(groups).sort((a, b) => (FACTION_ORDER.indexOf(a) + 99) % 99 - (FACTION_ORDER.indexOf(b) + 99) % 99);
    const w = weapon();
    let html = '';
    for (const f of order) {
      if (state.faction === 'all') html += `<li class="group">${esc(f)}</li>`;
      for (const e of groups[f]) {
        let sub = '';
        if (w) {
          const b = bestOf(evalEnemy(w, state.mode, e, opts()), state.view);
          sub = b ? `${b.r.killAt} shot${b.r.killAt > 1 ? 's' : ''}` : 'no kill';
        }
        html += `<li data-id="${esc(e.id)}" class="${e.id === state.enemyId ? 'on' : ''}"><span>${esc(e.name)}${hasModel(e.id) ? ' <span class="badge3d" title="3D model available">3D</span>' : ''}</span><span class="sub">${sub}</span></li>`;
      }
    }
    $('#enemyList').innerHTML = html || '<li class="empty">No enemies match.</li>';
  }

  function renderCatTabs() {
    const cats = CAT_ORDER.filter((c) => DATA.weapons.some((w) => w.category === c));
    const extra = [...new Set(DATA.weapons.map((w) => w.category))].filter((c) => !cats.includes(c));
    $('#catTabs').innerHTML = ['all', ...cats, ...extra]
      .map((c) => `<button data-c="${esc(c)}" class="${state.cat === c ? 'on' : ''}">${c === 'all' ? 'All' : esc(c)}</button>`)
      .join('');
  }

  function renderWeaponList() {
    const q = $('#weaponSearch').value.trim().toLowerCase();
    const list = DATA.weapons.filter((w) => (state.cat === 'all' || w.category === state.cat) && (!q || w.name.toLowerCase().includes(q) || (w.type || '').toLowerCase().includes(q)));
    $('#weaponList').innerHTML =
      list
        .map((w) => {
          const aps = [...new Set(w.modes.map((m) => m.ap))].join('/');
          return `<li data-id="${esc(w.id)}" class="${w.id === state.weaponId ? 'on' : ''}"><span>${esc(w.name)}</span><span class="sub">AP${aps}</span></li>`;
        })
        .join('') || '<li class="empty">No weapons match.</li>';
  }

  function renderWeaponCard() {
    const w = weapon();
    const el = $('#weaponCard');
    if (!w) { el.innerHTML = '<p class="note">Pick a weapon.</p>'; return; }
    const m = w.modes[state.mode] || w.modes[0];
    const ap = apFor(m, state.band);
    const pellets = m.pellets || 1;
    const scale = Array.from({ length: 11 }, (_, av) => {
      const p = penMult(ap, av);
      return `<span class="${p === 1 ? 'full' : p ? 'half' : ''}" title="AV${av} ${AV_NAMES[av]}: ${p === 1 ? '100%' : p ? '65%' : 'ricochet'}">${av}</span>`;
    }).join('');
    const ex = m.explosion;
    el.innerHTML = `
      <div>
        <div class="eyebrow">${esc(w.category)}${w.type ? ' · ' + esc(w.type) : ''}</div>
        <h3>${esc(w.name)}</h3>
        ${w.url ? `<a class="src" style="margin:0" href="${esc(w.url)}" target="_blank" rel="noopener">wiki ↗</a>` : ''}
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Damage</div><div class="v">${fmt(m.damage)}</div></div>
        <div class="stat"><div class="k">Durable</div><div class="v">${fmt(m.durable)}</div></div>
        <div class="stat"><div class="k">AP</div><div class="v">${ap}</div></div>
        ${pellets > 1 ? `<div class="stat"><div class="k">Pellets</div><div class="v">${pellets}</div></div>` : ''}
        ${w.rpm ? `<div class="stat"><div class="k">RPM</div><div class="v">${fmt(w.rpm)}</div></div>` : ''}
        ${w.mag ? `<div class="stat"><div class="k">Mag</div><div class="v">${fmt(w.mag)}</div></div>` : ''}
        ${ex ? `<div class="stat"><div class="k">Expl. dmg</div><div class="v">${fmt(ex.durable ?? ex.damage)}</div></div>
                <div class="stat"><div class="k">Expl. AP</div><div class="v">${ex.ap ?? '—'}</div></div>` : ''}
      </div>
      <div class="angles">
        <div class="ap-caption">AP by impact angle${m.apAngles ? '' : ' <span class="muted">(no angle data — same AP at every angle)</span>'}</div>
        <div class="angle-row">${ANGLE_BANDS.map((b, i) => `<button data-band="${i}" class="${i === state.band ? 'on' : ''}" title="${b.name} (${b.range})"><span>${b.name.replace(' angle', '')}</span><b>${apFor(m, i)}</b><i>${b.range}</i></button>`).join('')}</div>
      </div>
      <div>
        <div class="ap-scale">${scale}</div>
        <div class="ap-caption">Armor this shot defeats at ${ANGLE_BANDS[state.band].name.toLowerCase()} (green = full, yellow-green = 65%, red = ricochet). Body map and tables use this angle; the 3D view uses the real angle from your camera.</div>
      </div>
      <div class="opts">
        ${w.modes.length > 1 ? `<label class="opt">Ammo / mode
          <select id="modeSel">${w.modes.map((mm, i) => `<option value="${i}" ${i === state.mode ? 'selected' : ''}>${esc(mm.name || 'Mode ' + (i + 1))}</option>`).join('')}</select></label>` : ''}
        ${ex ? `<label class="opt">Include explosion (direct hit) <input type="checkbox" id="exChk" ${state.explosion ? 'checked' : ''}></label>` : ''}
        ${pellets > 1 ? `<label class="opt">All ${pellets} pellets hit <input type="checkbox" id="pelChk" ${state.allPellets ? 'checked' : ''}></label>` : ''}
      </div>
      ${m.note || w.note ? `<p class="note">${esc(m.note || w.note)}</p>` : ''}
    `;
  }

  /* ---------------- rendering: stage ---------------- */

  function renderStage() {
    const e = enemy();
    const w = weapon();
    if (!e) return;
    $('#enemyName').textContent = e.name;
    $('#enemyFaction').textContent = e.faction;
    const link = $('#enemyLink');
    link.href = e.url || '#';
    link.style.display = e.url ? '' : 'none';

    renderArchives(e);
    const results = w ? evalEnemy(w, state.mode, e, opts()) : e.parts.map((p) => ({ part: p, r: null }));
    if (!state.sim || state.sim.enemyId !== e.id) resetSim();
    renderSummary(e, w, results);
    renderFireHud(e);
    renderSchematic(e, results);
    publish3d(e, results);
    renderLegend();
    renderPartsTable(e, results);
    if (state.tab === 'rank') renderRankTable(e);
  }

  function renderSummary(e, w, results) {
    const main = mainPart(e);
    const vis = results.filter((x) => visible(x.part, state.view));
    const best = w ? bestOf(results, state.view) : null;
    const penCount = w ? vis.filter((x) => x.r.total > 0 || x.r.mainEx > 0).length : 0;
    const fatalCount = e.parts.filter((p) => p.fatal === true && !isMainRow(p)).length;
    $('#summary').innerHTML = `
      <div class="kpi"><div class="k">Main health</div><div class="v">${fmt(main?.health)}</div><div class="s">${main ? avName(main.av) + ' · AV' + main.av : 'unknown'}</div></div>
      <div class="kpi ${best ? 'good' : w ? 'bad' : ''}"><div class="k">Fastest kill</div><div class="v">${best ? best.r.killAt + (best.r.killAt > 1 ? ' shots' : ' shot') : w ? 'None' : '—'}</div><div class="s">${best ? 'via ' + esc(best.part.name) + (best.r.downs ? ' (downs)' : '') : w ? 'Nothing in view dies to this' : 'Pick a weapon'}</div></div>
      <div class="kpi"><div class="k">Damageable zones</div><div class="v">${w ? `${penCount}/${vis.length}` : vis.length}</div><div class="s">${w ? 'hitzones this weapon hurts' : 'hitzones in view'}</div></div>
      <div class="kpi"><div class="k">Fatal parts</div><div class="v">${fatalCount}</div><div class="s">besides Main</div></div>
    `;
  }

  function renderSchematic(e, results) {
    const zones = { head: [], arms: [], body: [], rear: [], legs: [] };
    results.forEach((x, i) => zones[region(x.part.name)].push({ ...x, i }));
    const maxHP = Math.max(1, ...e.parts.map((p) => (typeof p.health === 'number' ? p.health : 0)));
    for (const [z, items] of Object.entries(zones)) {
      const zoneEl = $(`.z-${z}`);
      zoneEl.classList.toggle('empty', items.length === 0);
      $('.tiles', zoneEl).innerHTML = items
        .map(({ part, r, i }) => {
          const hp = typeof part.health === 'number' ? part.health : maxHP * 0.4;
          const k = Math.sqrt(hp / maxHP);
          const size = `--w:${Math.round(100 + 120 * k)}px;--h:${Math.round(56 + 40 * k)}px;`;
          const vis = visible(part, state.view);
          let color = 'var(--pen-immune)';
          let big = '—', small = '';
          if (r) {
            color = state.color === 'pen' ? PEN_VAR[penClass(r, part)] : ttkColor(r.killAt);
            if (state.color === 'pen') {
              big = r.total > 0 ? fmt(r.total) : r.mainEx > 0 ? fmt(r.mainEx) : '0';
              small = r.total > 0 ? 'dmg/shot' : r.mainEx > 0 ? 'to main' : 'no dmg';
            } else {
              big = r.killAt ?? '✕';
              small = r.killAt ? 'to kill' : r.breakAt ? `breaks ${r.breakAt}` : 'no kill';
            }
          }
          const left = state.fire ? partLeft(i) : null;
          const fatal = part.fatal === true ? '<span class="fatal" title="Destroying this kills">☠ fatal</span>' : part.fatal === 'downs' ? '<span class="fatal" title="Destroying this downs the enemy">☠ downs</span>' : '';
          return `<div class="tile ${vis ? '' : 'dim'} ${left && left.frac <= 0 ? 'gone' : ''}" data-i="${i}" style="--c:${color};${size}">
              <span class="av">AV${part.av}</span>
              <div class="name">${esc(part.name)}</div>
              <div class="row"><span>${typeof part.health === 'number' ? fmt(part.health) + ' HP' : 'Main HP'} ${fatal}</span><span><span class="big">${big}</span> ${small}</span></div>
              ${left ? `<div class="hpbar" title="${esc(left.label)}"><b style="width:${Math.max(0, left.frac * 100)}%"></b></div>` : ''}
            </div>`;
        })
        .join('');
    }
  }

  function renderLegend() {
    if (state.color === 'pen') {
      $('#legend').innerHTML = ['full', 'half', 'none', 'immune'].map((k) => `<span><i style="background:${PEN_VAR[k]}"></i>${PEN_LABEL[k]}</span>`).join('') +
        '<span class="muted">Tile size ≈ part health · ☠ = fatal when destroyed</span>';
    } else {
      $('#legend').innerHTML = `<span>Shots to kill: 1<span class="ramp">${TTK_COLORS.map((c) => `<b style="background:${c}"></b>`).join('')}</span>21+</span>
        <span><i style="background:var(--pen-immune)"></i>Can't kill through this zone</span>`;
    }
  }

  function renderPartsTable(e, results) {
    const w = weapon();
    const head = `<thead><tr>
      <th>Hitzone</th><th class="num">AV</th><th class="num">Health</th><th class="num">Durable</th><th class="num">To main</th><th>Fatal</th><th class="num">ExDR</th>
      ${w ? '<th>Result</th><th class="num">Dmg/shot</th><th class="num">Main/shot</th><th class="num">Break</th><th class="num">Kill</th>' : ''}
    </tr></thead>`;
    const rows = results
      .map(({ part, r }, i) => {
        if (!visible(part, state.view)) return '';
        const pc = r ? penClass(r, part) : null;
        return `<tr data-i="${i}">
          <td>${esc(part.name)}</td>
          <td class="num" title="${esc(avName(part.av))}">${part.av}</td>
          <td class="num">${typeof part.health === 'number' ? fmt(part.health) : '<span class="muted">Main</span>'}</td>
          <td class="num">${pct(part.durable)}</td>
          <td class="num">${isMainRow(part) ? '—' : pct(part.toMain)}${part.overflow ? ' <span class="muted" title="Excess damage overflows to Main">+of</span>' : ''}</td>
          <td>${part.fatal === true ? '<span class="yes">Yes</span>' : part.fatal === 'downs' ? '<span class="yes">Downs</span>' : '<span class="muted">No</span>'}</td>
          <td class="num">${pct(part.exdr)}</td>
          ${r ? `<td><span class="pill ${pc}">${PEN_LABEL[pc]}</span></td>
            <td class="num">${fmt(r.total)}</td>
            <td class="num">${fmt(r.perMain)}</td>
            <td class="num">${r.breakAt ?? '—'}</td>
            <td class="num"><b>${r.killAt ?? '—'}</b></td>` : ''}
        </tr>`;
      })
      .join('');
    $('#partsTable').innerHTML = head + `<tbody>${rows}</tbody>`;
  }

  function renderRankTable(e) {
    const o = opts();
    const rows = [];
    for (const w of DATA.weapons) {
      let best = null;
      w.modes.forEach((m, mi) => {
        const b = bestOf(evalEnemy(w, mi, e, o), state.view);
        if (b && (!best || b.r.killAt < best.b.r.killAt || (b.r.killAt === best.b.r.killAt && b.r.total > best.b.r.total))) best = { b, mi };
      });
      rows.push({ w, best });
    }
    rows.sort((a, b) => (a.best ? a.best.b.r.killAt : 1e9) - (b.best ? b.best.b.r.killAt : 1e9) || (b.best?.b.r.total ?? 0) - (a.best?.b.r.total ?? 0));
    $('#rankTable').innerHTML = `<thead><tr><th>#</th><th>Weapon</th><th>Category</th><th>Mode</th><th>Best hitzone</th><th class="num">Dmg/shot</th><th class="num">Shots to kill</th></tr></thead><tbody>` +
      rows
        .map(({ w, best }, i) => `<tr class="click ${w.id === state.weaponId ? 'hl' : ''}" data-w="${esc(w.id)}" data-m="${best ? best.mi : 0}">
          <td class="num muted">${best ? i + 1 : ''}</td>
          <td>${esc(w.name)}</td><td class="muted">${esc(w.category)}</td>
          <td class="muted">${best && w.modes.length > 1 ? esc(w.modes[best.mi].name) : ''}</td>
          <td>${best ? esc(best.b.part.name) : '<span class="muted">Can’t kill</span>'}</td>
          <td class="num">${best ? fmt(best.b.r.total) : '—'}</td>
          <td class="num"><b style="color:${best ? ttkColor(best.b.r.killAt) : 'var(--dim)'}">${best ? best.b.r.killAt : '—'}</b></td>
        </tr>`)
        .join('') + '</tbody>';
  }

  /** Which game archive holds this enemy's model (from the modding community ID sheet). */
  function renderArchives(e) {
    const el = $('#v3Arch');
    if (!el || location.protocol === 'file:') return;
    if (!e.archives?.length) {
      el.innerHTML = '<p class="muted">No archive ID known for this enemy yet. Search for it in Filediver by name.</p>';
      return;
    }
    const fam = e.archives[0].exact ? '' : ` for the <b>${esc(e.archives[0].name)}</b> family`;
    el.innerHTML = `<p>In Filediver, look in archive${e.archives.length > 1 ? 's' : ''}${fam}:</p>
      <ul>${e.archives.map((a) => `<li><code>${esc(a.id)}</code>${a.note ? ` <span class="muted">${esc(a.note)}</span>` : ''}</li>`).join('')}</ul>`;
  }

  const hasModel = (id) => !!DATA.models?.[id];
  // Like the tank inspector: open straight into 3D when a model exists, unless the user picked a view.
  function autoStageView() {
    if (!state.stagePinned) state.stageView = hasModel(state.enemyId) ? '3d' : 'map';
  }

  /* ---------------- fire mode ---------------- */

  function resetSim() {
    const e = enemy();
    state.sim = e ? { ...newSim(e), enemyId: e.id } : null;
  }

  /** Remaining health of a part in the live simulation, for the HP bars. */
  function partLeft(i) {
    const e = enemy();
    const sim = state.sim;
    const p = e.parts[i];
    if (!sim) return null;
    if (sim.pool[i] != null) return { frac: sim.pool[i] / p.health, label: `${fmt(Math.max(0, sim.pool[i]))} / ${fmt(p.health)}` };
    const inst = sim.hp[i];
    if (!inst) {
      const mi = mainIndexFor(e, i);
      return mi >= 0 && sim.pool[mi] != null ? { frac: sim.pool[mi] / e.parts[mi].health, label: 'uses Main health', main: true } : null;
    }
    const total = p.health * inst.length;
    const sum = inst.reduce((a, h) => a + Math.max(0, h), 0);
    const alive = inst.filter((h) => h > 0).length;
    return { frac: sum / total, label: `${alive}/${inst.length} intact · ${fmt(sum)} HP left`, alive };
  }

  /** hit = { deg } when fired from the 3D view, so the real impact angle picks the AP. */
  function fireAt(i, hit) {
    const e = enemy(), w = weapon();
    if (!e || !w || !state.sim || state.sim.dead) return;
    const mode = w.modes[state.mode] || w.modes[0];
    const part = e.parts[i];
    const band = hit ? bandOf(hit.deg) : state.band;
    const s = shotDamage(mode, part, e, { ...opts(), band });
    const o = applyShot(state.sim, e, i, s);
    state.sim.log.unshift(`#${state.sim.shots} ${part.name}${hit ? ` @ ${Math.round(hit.deg)}°` : ''}: ${s.total > 0 ? fmt(s.total) + ' dmg' : 'ricochet'}${o.toMain > 0 ? `, ${fmt(o.toMain)} to Main` : ''}${o.broke ? ' — destroyed' : ''}`);
    state.sim.log.length = Math.min(state.sim.log.length, 6);
    render();
  }

  function renderFireHud(e) {
    const hud = $('#fireHud');
    const banner = $('#killBanner');
    $('#fireBtn').classList.toggle('on', state.fire);
    if (!state.fire) { hud.classList.add('hidden'); banner.classList.add('hidden'); return; }
    hud.classList.remove('hidden');
    const sim = state.sim;
    const pools = e.parts.map((p, i) => ({ p, i })).filter(({ i }) => sim.pool[i] != null);
    hud.innerHTML = `
      <div class="hud-row">
        <span class="hud-k">Shots fired</span><span class="hud-v">${sim.shots}</span>
        ${pools.map(({ p, i }) => `<span class="hud-k">${esc(p.name)}</span>
          <span class="hpbar wide"><b style="width:${Math.max(0, (sim.pool[i] / p.health) * 100)}%"></b></span>
          <span class="hud-v">${fmt(Math.max(0, sim.pool[i]))}</span>`).join('')}
        <button class="btn ghost sm" id="resetSim">Reset</button>
      </div>
      <div class="hud-log">${sim.log.length ? sim.log.map(esc).join('<br>') : 'Click a hitzone to fire one shot of the selected weapon.'}</div>`;
    if (sim.dead) {
      banner.classList.remove('hidden');
      banner.innerHTML = `<div class="kb-title">${sim.dead.how === 'downed' ? 'Downed' : 'Killed'}</div>
        <div class="kb-sub">${esc(sim.dead.why)} · ${sim.shots} shot${sim.shots > 1 ? 's' : ''}</div>
        <button class="btn" id="resetSim2">Fire again</button>`;
    } else banner.classList.add('hidden');
  }

  /* ---------------- 3D viewer bridge (viewer3d.js listens) ---------------- */

  function publish3d(e, results) {
    const colors = results.map(({ part, r }, i) => {
      if (!r) return PEN_HEX.immune;
      return state.color === 'pen' ? PEN_HEX[penClass(r, part)] : ttkColor(r.killAt);
    });
    const gone = e.parts.map((_, i) => {
      if (!state.fire) return false;
      const l = partLeft(i);
      return !!(l && !l.main && l.frac <= 0);
    });
    const w = weapon();
    const m = w ? w.modes[state.mode] || w.modes[0] : null;
    // projectile AP per angle band; the 3D shader colours each pixel by its own impact angle
    // explosions ignore angle, so with explosions on a part counts as hurt if either AP beats it
    const exAp = state.explosion && m?.explosion ? m.explosion.ap ?? -1 : -1;
    const ap4 = m ? ANGLE_BANDS.map((_, b) => Math.max(m.explosionOnly ? -1 : apFor(m, b), exAp)) : null;
    window.dispatchEvent(new CustomEvent('hd2:update', { detail: {
      enemy: e, colors, gone, fire: state.fire, stageView: state.stageView,
      colorMode: state.color, ap4, avs: e.parts.map((p) => p.av), bands: ANGLE_BANDS,
    } }));
  }

  function partClick(i, hit) {
    if (state.fire) fireAt(i, hit);
  }

  /* ---------------- tooltip ---------------- */

  function showTip(i, x, y, hit) {
    const e = enemy();
    const w = weapon();
    const part = e.parts[i];
    if (!part) return;
    const band = hit ? bandOf(hit.deg) : state.band;
    const mode = w ? w.modes[state.mode] || w.modes[0] : null;
    const r = w ? simulate(mode, e, i, { ...opts(), band }) : null;
    const pc = r ? penClass(r, part) : null;
    let verdict = '';
    if (r) {
      if (pc === 'immune') verdict = 'This zone cannot be damaged.';
      else if (r.killAt) verdict = `Kills in <b>${r.killAt}</b> shot${r.killAt > 1 ? 's' : ''}${r.downs ? ' (downs it)' : r.breakAt === r.killAt && part.fatal === true ? ' by destroying this part' : ' via Main health'}.`;
      else if (r.breakAt) verdict = `Breaks in <b>${r.breakAt}</b> shot${r.breakAt > 1 ? 's' : ''}, but that alone won't kill it.`;
      else if (r.total > 0) verdict = 'Deals damage but can’t kill through this zone.';
      else verdict = 'Ricochets — no damage.';
    }
    const tip = $('#tooltip');
    tip.innerHTML = `<h4>${esc(part.name)}</h4>
      <dl>
        <dt>Armor</dt><dd>AV${part.av} · ${esc(avName(part.av))}</dd>
        ${w ? `<dt>Impact</dt><dd>${hit ? Math.round(hit.deg) + '° · ' : ''}${ANGLE_BANDS[band].name} → AP ${apFor(mode, band)}</dd>` : ''}
        <dt>Health</dt><dd>${typeof part.health === 'number' ? fmt(part.health) : 'uses Main'}</dd>
        <dt>Durable</dt><dd>${pct(part.durable)}</dd>
        ${isMainRow(part) ? '' : `<dt>To Main</dt><dd>${pct(part.toMain)}${part.overflow ? ' (overflow)' : ''}</dd>`}
        <dt>Explosive resist</dt><dd>${pct(part.exdr)}</dd>
        ${part.location ? `<dt>Visible from</dt><dd>${esc(part.location)}</dd>` : ''}
        ${r ? `<dt>Hit result</dt><dd>${PEN_LABEL[pc]}</dd>
        <dt>Dmg / shot</dt><dd>${fmt(r.proj)}${r.partEx ? ' + ' + fmt(r.partEx) + ' expl' : ''}</dd>
        <dt>Main / shot</dt><dd>${fmt(r.perMain)}</dd>` : ''}
      </dl>
      ${verdict ? `<div class="verdict">${verdict}</div>` : ''}`;
    const pad = 14;
    const rect = tip.getBoundingClientRect();
    let left = x + pad, top = y + pad;
    if (left + rect.width > innerWidth - 8) left = x - rect.width - pad;
    if (top + rect.height > innerHeight - 8) top = y - rect.height - pad;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
    tip.classList.add('show');
    $$(`[data-i="${i}"]`).forEach((n) => n.classList.add('hl'));
  }
  function hideTip() {
    $('#tooltip').classList.remove('show');
    $$('.hl[data-i]').forEach((n) => n.classList.remove('hl'));
  }

  /* ---------------- URL state ---------------- */

  function writeHash() {
    const p = new URLSearchParams();
    if (state.enemyId) p.set('e', state.enemyId);
    if (state.weaponId) p.set('w', state.weaponId);
    if (state.mode) p.set('m', state.mode);
    if (!state.explosion) p.set('x', '0');
    if (!state.allPellets) p.set('p', '0');
    if (state.band) p.set('a', state.band);
    if (state.view !== 'all') p.set('v', state.view);
    if (state.color !== 'pen') p.set('c', state.color);
    if (state.stagePinned) p.set('s', state.stageView);
    history.replaceState(null, '', '#' + p.toString());
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('e') && enemyById(p.get('e'))) state.enemyId = p.get('e');
    if (p.get('w') && weaponById(p.get('w'))) state.weaponId = p.get('w');
    state.mode = +p.get('m') || 0;
    state.explosion = p.get('x') !== '0';
    state.allPellets = p.get('p') !== '0';
    state.band = Math.min(3, Math.max(0, +p.get('a') || 0));
    if (['front', 'side', 'rear'].includes(p.get('v'))) state.view = p.get('v');
    if (p.get('c') === 'ttk') state.color = 'ttk';
    if (p.has('s')) { state.stageView = p.get('s') === '3d' ? '3d' : 'map'; state.stagePinned = true; }
  }

  /* ---------------- wiring ---------------- */

  function render() {
    renderFactionTabs();
    renderEnemyList();
    renderCatTabs();
    renderWeaponList();
    renderWeaponCard();
    renderStage();
    $$('#viewTabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
    $$('#colorTabs button').forEach((b) => b.classList.toggle('on', b.dataset.color === state.color));
    $$('#bottomTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
    $('#partsTableWrap').classList.toggle('hidden', state.tab !== 'parts');
    $('#rankTableWrap').classList.toggle('hidden', state.tab !== 'rank');
    $('#stageTabs button').forEach((b) => b.classList.toggle('on', b.dataset.sv === state.stageView));
    $('#schematic').classList.toggle('hidden', state.stageView !== 'map');
    $('#viewer3d').classList.toggle('hidden', state.stageView !== '3d');
    writeHash();
  }

  function bind() {
    $('#factionTabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      state.faction = b.dataset.f; render();
    });
    $('#catTabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      state.cat = b.dataset.c; render();
    });
    $('#enemySearch').addEventListener('input', renderEnemyList);
    $('#weaponSearch').addEventListener('input', renderWeaponList);
    $('#enemyList').addEventListener('click', (ev) => {
      const li = ev.target.closest('li[data-id]'); if (!li) return;
      state.enemyId = li.dataset.id; resetSim(); autoStageView(); render();
    });
    $('#weaponList').addEventListener('click', (ev) => {
      const li = ev.target.closest('li[data-id]'); if (!li) return;
      state.weaponId = li.dataset.id; state.mode = 0; resetSim(); render();
    });
    $('#weaponCard').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-band]'); if (!b) return;
      state.band = +b.dataset.band; render();
    });
    $('#weaponCard').addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.id === 'modeSel') state.mode = +t.value;
      if (t.id === 'exChk') state.explosion = t.checked;
      if (t.id === 'pelChk') state.allPellets = t.checked;
      resetSim();
      render();
    });
    $('#viewTabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      state.view = b.dataset.view; render();
    });
    $('#colorTabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      state.color = b.dataset.color; render();
    });
    $('#bottomTabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      state.tab = b.dataset.tab; render();
    });
    $('#rankTable').addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-w]'); if (!tr) return;
      state.weaponId = tr.dataset.w; state.mode = +tr.dataset.m; state.tab = 'parts'; render();
      scrollTo({ top: 0, behavior: 'smooth' });
    });

    const hoverHost = (sel) => {
      const host = $(sel);
      host.addEventListener('mousemove', (ev) => {
        const n = ev.target.closest('[data-i]');
        if (!n) { hideTip(); return; }
        hideTip();
        showTip(+n.dataset.i, ev.clientX, ev.clientY);
      });
      host.addEventListener('mouseleave', hideTip);
    };
    hoverHost('#schematic');
    hoverHost('#partsTable');

    const clickHost = (sel) => $(sel).addEventListener('click', (ev) => {
      const n = ev.target.closest('[data-i]');
      if (n) partClick(+n.dataset.i);
    });
    clickHost('#schematic');
    clickHost('#partsTable');

    $('#fireBtn').addEventListener('click', () => { state.fire = !state.fire; resetSim(); render(); });
    $('.stage').addEventListener('click', (ev) => {
      if (ev.target.closest('#resetSim, #resetSim2')) { resetSim(); render(); }
    });
    $('#stageTabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      state.stageView = b.dataset.sv; state.stagePinned = true; render();
    });

    $('#shareBtn').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.href); toast('Link copied'); }
      catch { toast('Copy failed — use the address bar'); }
    });
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1600);
  }

  function init() {
    if (!DATA.enemies.length) {
      $('#enemyName').textContent = 'No data loaded';
      $('#summary').innerHTML = '<p class="note">Run <code>node build-data.js</code> to generate data/data.js.</p>';
      return;
    }
    if (location.protocol === 'file:') {
      $('#v3Empty').innerHTML = '<h3>3D needs the local server</h3><p>Browsers block 3D modules on pages opened from disk. In this folder run <code>node serve.js</code>, then open <code>http://localhost:8080</code>.</p>';
      $('#v3Empty').classList.remove('hidden');
    }
    $('#buildInfo').textContent = `${DATA.enemies.length} enemies · ${DATA.weapons.length} weapons · data ${DATA.built || ''}`;
    readHash();
    if (EDITOR) document.body.classList.add('editor');
    state.enemyId ||= (DATA.enemies.find((e) => e.id === 'charger') || DATA.enemies[0]).id;
    autoStageView();
    state.weaponId ||= (DATA.weapons.find((w) => /liberator$/i.test(w.name)) || DATA.weapons[0])?.id ?? null;
    bind();
    render();
  }

  // Exposed for quick console / node checks.
  window.HD2 = {
    simulate, shotDamage, penMult, evalEnemy,
    // used by viewer3d.js
    enemy, tip: showTip, hideTip, click: partClick,
    refresh: () => render(),
  };
  init();
})();
