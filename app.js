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
  const DEFAULT_RANGE = 30; // metres; a typical engagement distance
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
  // time-to-kill ramp in seconds: instant, ≤0.5, ≤1, ≤2, ≤4, ≤8, longer
  const TTK_STEPS = [0.01, 0.5, 1, 2, 4, 8, Infinity];
  const TTK_COLORS = ['#1fae63', '#5cc25a', '#a3c94a', '#e0c43a', '#e8962f', '#e0602f', '#c8382f'];

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n == null || Number.isNaN(n) ? '—' : Number.isFinite(n) ? Math.round(n).toLocaleString() : '∞');
  const pct = (f) => (f == null ? '—' : `${Math.round(f * 100)}%`);
  const avName = (av) => (av < 0 ? 'No hitbox' : AV_NAMES[av] ?? `AV${av}`);

  const state = {
    faction: null, // null = faction picker
    cat: null, // null = weapon category picker
    enemyId: null,
    weaponId: null,
    mode: 0,
    explosion: true,
    allPellets: true,
    allShrap: false, // body map: shrapnel fragments all on the struck part (off: the 3D view traces them)
    dist: DEFAULT_RANGE, // range to target in metres (drag falloff)
    hit: null, // last shot placed on the 3D model: { idx, deg, parts: { partIdx: distance from impact } }
    band: 0, // impact angle band for the body map / tables (3D uses the real angle)
    view: 'all',
    color: 'pen',
    tab: 'parts',
    stageView: 'map', // 'map' | '3d'
    fire: true, // fire mode is the default view
    showInner: false, // treat inner parts as already exposed
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
    // tanks: weapons on top belong to the turret; tracks, engine and anything else unnamed to the hull
    const pool = (re) => mains.find((i) => re.test(enemy.parts[i].name));
    if (/launch tube|cannon|barrel|heatsink/i.test(p.name) && pool(/^turret/i) != null) return pool(/^turret/i);
    if (pool(/^hull/i) != null) return pool(/^hull/i);
    return mains.find((i) => /^main$/i.test(enemy.parts[i].name.trim())) ?? mains[0];
  }

  /** Projectile AP for an angle band; weapons without angle data keep one AP. */
  function apFor(mode, band) {
    return mode.apAngles?.[band || 0] ?? mode.ap;
  }

  /** Damage a single trigger pull does to one part, before HP caps. */
  /** Velocity falloff from the wiki's simplified drag formula (ignores gravity):
   *  mult = 1 − 0.75 × (1 − e^(−2·D·x)),  D ≈ 0.0004712389 × caliber² × Cd / mass */
  function rangeMult(mode, dist) {
    const b = mode.ballistics;
    if (!dist || !b || !b.drag || !b.caliber || !b.mass) return 1;
    const D = (0.0004712389 * b.caliber * b.caliber * b.drag) / b.mass;
    return 1 - 0.75 * (1 - Math.exp(-2 * D * dist));
  }

  /* Overpenetration (wiki "Cleave"): the projectile goes on through a part if its AP beats the part's AV
   * both before and after paying a cost of AV + 1/2/3 (durable 0–24% / 25–75% / 76–100%); breakable armor
   * plates also need AP ≥ 3 × AV. It continues with the AP that's left into the part behind (p.behind).
   * Projectiles lose speed (penetration slowdown) and with it damage, on the range-falloff curve;
   * beams carry full damage. */
  const cleaveCost = (p) => p.av + ((p.durable ?? 0) >= 0.76 ? 3 : (p.durable ?? 0) >= 0.25 ? 2 : 1);
  function overpen(mode, enemy, idx, s, opts, target) {
    const p = enemy.parts[idx];
    const behind = target !== undefined ? (target == null ? null : enemy.parts[target]?.name) : p.behind;
    if (!behind || !(s.proj > 0) || mode.explosionOnly) return null;
    const ap = s.ap;
    if (!(ap > p.av)) return null;
    if (ARMOR_RE.test(p.name) && p.av > 0 && ap < 3 * p.av) return null;
    const left = ap - cleaveCost(p);
    if (!(left > p.av)) return null;
    const j = enemy.parts.findIndex((q) => q.name === behind);
    if (j < 0) return null;
    const s2 = shotDamage({ ...mode, ap: left, apAngles: null, explosion: null }, enemy.parts[j], enemy, { ...opts, explosion: false, exDist: 0 });
    // speed lost going through → damage lost (projectiles only)
    const b = mode.ballistics, slow = !mode.beam && b?.penSlowdown ? 1 - b.penSlowdown : 1;
    if (slow < 1 && s2.proj > 0) {
      const D = b.drag && b.caliber && b.mass ? (0.0004712389 * b.caliber * b.caliber * b.drag) / b.mass : 0;
      const v = Math.exp(-D * (opts.dist || 0)); // speed left after drag, as a fraction
      const curve = (r) => 1 - 0.75 * (1 - r * r);
      const f = curve(v * slow) / curve(v);
      const proj = Math.floor(s2.proj * f);
      Object.assign(s2, { proj, total: proj + s2.partEx });
    }
    return s2.total > 0 ? { idx: j, s: s2, ap: left } : null;
  }

  /** Explosion strength at a distance from the blast centre: full inside the inner radius, falling off
   *  to 0 at the outer radius (quick: 1 − x, slow: 1 − x²), with AP −1 in the outer ring (min 2). */
  function blastAt(ex, dist) {
    const inner = ex.inner ?? ex.innerRadius ?? null;
    const outer = ex.outer ?? ex.outerRadius ?? null;
    const ap = ex.ap ?? 0;
    if (!dist || inner == null || dist <= inner) return { mult: 1, ap };
    if (outer == null || dist >= outer) return { mult: 0, ap };
    const x = (dist - inner) / (outer - inner);
    return { mult: ex.falloff === 'slow' ? 1 - x * x : 1 - x, ap: ex.apOuter ?? (ap > 2 ? Math.max(2, ap - 1) : ap) };
  }

  /** Damage one hit does to one part, before HP caps.
   *  opts: band (impact angle), dist (range, metres), exDist (part's distance from the blast; 0 = direct hit),
   *  noProj (part only caught in the blast). */
  function shotDamage(mode, part, enemy, opts) {
    const ap = apFor(mode, opts.band);
    const pellets = opts.allPellets ? Math.max(1, mode.pellets || 1) : 1;
    const m = penMult(ap, part.av);
    const d = part.durable ?? 0;
    const raw = ((mode.damage || 0) * (1 - d) + (mode.durable ?? mode.damage ?? 0) * d) * rangeMult(mode, opts.dist);
    const proj = m == null || mode.explosionOnly || opts.noProj ? 0 : Math.floor(raw * m) * pellets;

    let partEx = 0, mainEx = 0, exMult = null;
    // an explosive round that ricochets doesn't go off (explosion-only weapons always do)
    const ricochet = !mode.explosionOnly && !mode.proximity && !opts.noProj && (mode.damage || 0) > 0 && !m;
    const ex = opts.explosion && !ricochet ? mode.explosion : null;
    if (ex && (ex.damage || ex.durable)) {
      const blast = blastAt(ex, opts.exDist || 0);
      const e = (ex.durable ?? ex.damage) * blast.mult;
      exMult = blast.mult > 0 ? penMult(blast.ap, part.av) : 0;
      const exdr = part.exdr ?? 0;
      partEx = exMult == null ? 0 : Math.floor(e * (1 - exdr) * exMult);
      // redirected share skips Main's ExDR but still needs AP ≥ Main's AV
      const main = mainPart(enemy);
      if (!isMainRow(part) && (!main || blast.ap >= main.av)) mainEx = Math.floor(e * exdr);
    }
    let shrap = 0;
    if (mode.shrapnel && opts.allShrap && !opts.noProj && !opts.noShrap && !ricochet && opts.explosion !== false) {
      const f = shotDamage(shrapnelMode(mode), part, enemy, { ...opts, noShrap: true, explosion: false });
      shrap = f.proj * mode.shrapnel.count;
    }
    return { proj: proj + shrap, partEx, mainEx, pen: opts.noProj ? null : m, exPen: exMult, total: proj + shrap + partEx, ap, range: rangeMult(mode, opts.dist), ricochet, shrap };
  }

  /** One shrapnel fragment of a mode, as a projectile of its own. */
  const shrapnelMode = (mode) => ({ name: 'shrapnel', damage: mode.shrapnel.damage, durable: mode.shrapnel.durable, ap: mode.shrapnel.apAngles[0],
    apAngles: mode.shrapnel.apAngles, pellets: 1, explosion: null, ballistics: mode.shrapnel.ballistics });

  /* Stateful simulation: shared by the shots-to-kill numbers and fire mode.
   * Parts with a count, e.g. "Claws (2)", track each instance; shots hit the first one still standing. */
  /** A part's constitution: extra pool after its health is gone, during which it can still be hit. */
  const consOf = (p) => (p.indestructible ? 0 : p.cons || 0);
  /** Gone for good: health and constitution both used up, so the hitbox is gone too. */
  const instGone = (p, h) => h <= -consOf(p);
  const partGone = (sim, enemy, idx) => !!sim.hp[idx] && sim.hp[idx].every((h) => instGone(enemy.parts[idx], h));
  const bleedNote = (p) => (p.cons && p.bleed < 0 ? ` (bleeds out in ${fmtTime(p.cons / -p.bleed)})` : '');

  function newSim(enemy) {
    return {
      hp: enemy.parts.map((p) => (isMainRow(p) || typeof p.health !== 'number' ? null : Array(p.count || 1).fill(p.health))),
      pool: enemy.parts.map((p) => (isMainRow(p) && typeof p.health === 'number' ? p.health : null)),
      shots: 0,
      dead: null, // { how: 'killed' | 'downed', why, idx }
      log: [],
    };
  }

  function applyShot(sim, enemy, idx, s, extra, want) {
    const part = enemy.parts[idx];
    const out = { progress: false, toMain: 0, broke: false, dealt: s.total };
    if (sim.dead || part.av < 0 || part.av >= 11) return out;
    if (!extra) sim.shots++; // blast damage to other parts belongs to the same shot
    const mi = mainIndexFor(enemy, idx);
    const toMain = part.toMain ?? 0; // "-" on the wiki: nothing reaches Main (shields, jetpacks, mounted guns)

    if (mi === idx) {
      out.toMain = s.total;
    } else if (sim.hp[idx] == null) {
      out.toMain = s.total * toMain + s.mainEx;
    } else {
      const inst = sim.hp[idx];
      const cons = consOf(part);
      const k = want != null ? (instGone(part, inst[want]) ? -1 : want) : inst.findIndex((h) => !instGone(part, h));
      if (k >= 0) {
        const wasUp = inst[k] > 0;
        const capped = part.overflow ? s.total : Math.min(s.total, inst[k] + cons);
        out.toMain = capped * toMain + s.mainEx;
        if (part.indestructible) {
          if (out.toMain > 0) out.progress = true;
          return feedMain();
        }
        inst[k] -= s.total;
        if (s.total > 0) out.progress = true;
        if (wasUp && inst[k] <= 0) out.broke = true;
        // fatal parts: with a bleed rate the enemy is done once the part breaks (it bleeds out);
        // with constitution that doesn't drain, it has to be shot through the constitution too
        const fatalNow = cons && !(part.bleed < 0) ? instGone(part, inst[k]) : out.broke;
        if (fatalNow && (part.fatal === true || part.fatal === 'downs')) {
          const allDown = inst.every((h) => (cons && !(part.bleed < 0) ? instGone(part, h) : h <= 0));
          if (!part.fatalAll || allDown) {
            sim.dead = { how: part.fatal === 'downs' ? 'downed' : 'killed', why: `${part.name} destroyed${bleedNote(part)}`, idx };
          }
        }
      } else {
        // this one (or every one) is gone: only overflow parts keep feeding Main
        out.toMain = (part.overflow ? s.total * toMain : 0) + s.mainEx;
      }
    }

    return feedMain();
    function feedMain() {
      if (mi >= 0 && sim.pool[mi] != null && out.toMain > 0) {
        sim.pool[mi] -= out.toMain;
        out.progress = true;
        const mp = enemy.parts[mi];
        if (sim.pool[mi] <= 0 && !sim.dead && (/^main$/i.test(mp.name.trim()) || mp.fatal)) {
          sim.dead = { how: 'killed', why: `${mp.name} health depleted${bleedNote(mp)}`, idx: mi };
        }
      }
      return out;
    }
  }

  /** One shot with both impact and explosion, in the order the game does it: the impact lands first and
   *  changes the state (a plate it breaks is gone), then the explosion is worked out against that new state:
   *  - the struck piece still has a hitbox (or no health of its own, like Main): the explosion hits it too
   *  - the impact broke a plate that covers another part: the explosion lands on that part instead
   *    (Charger Behemoth leg: the AC-8's AP 3 blast can't hurt the AV 4 plate, but it hits the exposed AV 2
   *    flesh; verified in game: AC-8 kills in 8 where AMR needs 9 and Railgun 7 like the simulation, so surplus
   *    damage itself never carries over)
   *  - the impact destroyed the piece and nothing is under it: the explosion meets the destroyed piece
   *    (only an overflow part still passes damage on to Main)
   *  Plain rounds and explosion-only weapons are applied in one go. o.combined: the old all-at-once sum. */
  function applyHit(sim, enemy, idx, s, mode, o, extra, want) {
    const ex = o.explosion && mode.explosion && !s.ricochet && s.proj > 0;
    if (!ex || o.combined) return applyShot(sim, enemy, idx, s, extra, want);
    const part = enemy.parts[idx];
    const inst = sim.hp[idx];
    const k = inst ? (want != null ? want : inst.findIndex((h) => !instGone(part, h))) : -1;
    // 1. impact
    const out = applyShot(sim, enemy, idx, { ...s, partEx: 0, mainEx: 0, total: s.proj }, extra, k >= 0 ? k : want);
    if (sim.dead) return out;
    // 2. explosion, against what is there now
    const stripped = inst && k >= 0 && instGone(part, inst[k]);
    const under = stripped ? enemy.parts.findIndex((q) => q.coveredBy === part.name || q.alsoCoveredBy === part.name) : -1;
    let o2;
    if (under >= 0) {
      const sx = shotDamage(mode, enemy.parts[under], enemy, { ...o, noProj: true, exDist: 0 });
      o2 = applyShot(sim, enemy, under, sx, true, o.revealedK?.[under] ?? undefined); // the piece under this plate (3D)
      out.under = { idx: under, dealt: sx.total, broke: o2.broke, toMain: o2.toMain };
    } else {
      o2 = applyShot(sim, enemy, idx, { ...s, proj: 0, total: s.partEx }, true, k >= 0 ? k : want);
    }
    out.toMain += o2.toMain;
    out.progress = out.progress || o2.progress;
    out.broke = out.broke || o2.broke;
    return out;
  }
  /** Flame and gas weapons in fire mode: a click is one second of spraying. The spray's own hit lands on the
   *  part clicked (applied like a shot), and a second of the burn / gas (dot.dps) goes to Main, as the
   *  time-to-kill numbers count it, if its AP gets through Main's armor. Returns the log text. */
  const DOT_CLICK = 1;
  function dotSecond(sim, enemy, mode) {
    const dot = mode.dot, main = mainPart(enemy), mi = enemy.parts.indexOf(main);
    if (!dot || sim.dead || mi < 0 || typeof main.health !== 'number') return '';
    const pen = penMult(dot.ap, main.av) || 0;
    if (!pen) return ` · ${dot.label} can't get through Main's armor (AP ${dot.ap} vs AV ${main.av})`;
    const dmg = Math.floor(dot.dps * DOT_CLICK * pen);
    applyShot(sim, enemy, mi, { proj: 0, partEx: 0, mainEx: 0, total: dmg }, true);
    return ` + ${DOT_CLICK} s ${dot.label.toLowerCase()}: ${fmt(dmg)} to Main`;
  }

  /** Log text for the explosion that went on into the part under a broken plate. */
  const underNote = (enemy, o) => (o.under ? ` → explosion on the ${enemy.parts[o.under.idx].name} beneath: ${fmt(o.under.dealt)} dmg${o.under.broke ? ', destroyed' : ''}` : '');

  /** Repeated shots into one hitzone until the enemy dies or nothing changes. */
  function simulate(mode, enemy, idx, opts) {
    const part = enemy.parts[idx];
    const s = shotDamage(mode, part, enemy, opts);
    const res = { ...s, killAt: null, breakAt: null, downs: false, perMain: 0, why: '', strip: null };
    const sim = newSim(enemy);
    let shot0 = 0;
    // armored part: shoot the plate until it breaks; its damage to Main carries over
    const ci = part.coveredBy && !opts.exposeAll ? enemy.parts.findIndex((p) => p.name === part.coveredBy) : -1;
    if (ci >= 0) {
      const sc = shotDamage(mode, enemy.parts[ci], enemy, opts);
      for (;;) {
        if (shot0 >= MAX_SHOTS) return res;
        const o = applyHit(sim, enemy, ci, sc, mode, opts);
        shot0++;
        if (sim.dead) { res.killAt = shot0; res.downs = sim.dead.how === 'downed'; res.why = sim.dead.why; res.strip = { part: part.coveredBy, shots: shot0 }; return res; }
        if (o.broke) break;
        if (!o.progress) return res; // can't get through the armor
      }
      res.strip = { part: part.coveredBy, shots: shot0 };
    }
    const thru = overpen(mode, enemy, idx, s, opts);
    for (let n = 1; shot0 + n <= MAX_SHOTS; n++) {
      const shot = shot0 + n;
      const o = applyHit(sim, enemy, idx, s, mode, opts);
      if (thru && !sim.dead) { const o2 = applyShot(sim, enemy, thru.idx, thru.s, true); o.toMain += o2.toMain; o.progress = o.progress || o2.progress; }
      if (n === 1) res.perMain = o.toMain;
      if (o.broke && res.breakAt == null) res.breakAt = shot;
      if (sim.dead) {
        res.killAt = shot;
        res.downs = sim.dead.how === 'downed';
        res.why = sim.dead.why;
        break;
      }
      if (!o.progress) break;
      if (partGone(sim, enemy, idx)) break; // destroyed (constitution too): no hitbox left to shoot
    }
    return res;
  }

  /* Time to kill.
   *  shot: (shots − 1) × 60 / RPM, first shot at t = 0, reloads not included
   *  beam: damage listed per second, applied in 0.1 s ticks
   *  dot:  flame / gas sprays; the burn or gas cloud hits Main only and must beat Main's AV */
  const BEAM_TICK = 0.1;
  function fireModel(weapon, mode) {
    if (mode.dot) return { kind: 'dot', ...mode.dot };
    if (mode.beam) return { kind: 'beam' };
    const rpm = mode.rpm ?? weapon.rpm;
    return { kind: 'shot', interval: rpm ? 60 / rpm : null };
  }

  function evalEnemy(weapon, modeIdx, enemy, opts) {
    const mode = weapon.modes[modeIdx] || weapon.modes[0];
    const fm = fireModel(weapon, mode);
    const main = mainPart(enemy);
    const tickMode = fm.kind === 'beam'
      ? { ...mode, damage: mode.damage * BEAM_TICK, durable: (mode.durable ?? mode.damage) * BEAM_TICK, explosion: null }
      : null;
    return enemy.parts.map((p, i) => {
      const r = simulate(mode, enemy, i, opts);
      r.kind = fm.kind;
      if (fm.kind === 'shot') {
        r.ttk = r.killAt == null ? null : r.killAt === 1 ? 0 : fm.interval ? (r.killAt - 1) * fm.interval : null;
        r.reload = !!(r.killAt && weapon.mag && r.killAt > weapon.mag);
      } else if (fm.kind === 'beam') {
        const t = simulate(tickMode, enemy, i, opts);
        r.ttk = t.killAt == null ? null : t.killAt * BEAM_TICK;
        r.killAt = null;
        r.why = t.why;
      } else {
        const pen = main && typeof main.health === 'number' && p.av >= 0 && p.av < 11 ? penMult(fm.ap, main.av) : 0;
        r.ttk = pen ? main.health / (fm.dps * pen) : null;
        r.killAt = null;
        r.why = pen ? `${fm.label} on Main health` : '';
      }
      return { part: p, r };
    });
  }

  /** Sort key: time to kill when known, otherwise shot count after every timed kill. */
  const killKey = (r) => (r.ttk != null ? r.ttk : r.killAt != null ? 1e4 + r.killAt : null);
  const isOneShot = (r) => r.kind === 'shot' && r.killAt === 1;
  const ONE_SHOT = '<span class="one-shot">One shot</span>';
  const ttkHtml = (r) => (isOneShot(r) ? ONE_SHOT : fmtTime(r.ttk));
  const fmtTime = (t) => (t == null ? '—' : t < 10 ? `${t.toFixed(2)} s` : `${t.toFixed(1)} s`);
  const shotsLabel = (r) => (r.kind === 'beam' ? 'beam' : r.kind === 'dot' ? 'burn' : r.killAt != null ? `${r.killAt} shot${r.killAt > 1 ? 's' : ''}` : '');


  function visible(part, view) {
    if (view === 'all') return true;
    const loc = (part.location || '').toLowerCase();
    if (!loc || loc.includes('no view')) return true;
    return loc.includes(view);
  }

  /* Inner parts sit behind armor. They count once the "inner parts exposed" toggle is on, or in fire
   * mode once covering armor is destroyed: armor sharing a body word ("Leg Internals" → leg armor),
   * otherwise any armor plate. */
  const ARMOR_RE = /armou?r|plate|carapace|shell/i;
  function coverFor(enemy, idx) {
    const words = enemy.parts[idx].name.toLowerCase().match(/[a-z]+/g).filter((w) => !/^(inner|internals?|exposed|flesh)$/.test(w));
    const armor = enemy.parts.map((p, i) => i).filter((i) => ARMOR_RE.test(enemy.parts[i].name));
    const near = armor.filter((i) => words.some((w) => enemy.parts[i].name.toLowerCase().includes(w)));
    return near.length ? near : armor;
  }
  const coverTag = (p, open) => (open ? 'armor off' : `🛡 ${esc(p.coveredBy.replace(/\s*\(\d+\)$/, ''))}`);
  const hiddenTag = (p, open) => (p.hidden === 'angle' ? 'hard to reach' : open ? 'exposed' : '🔒 covered');

  function isExposed(enemy, idx, sim = null, k = null) {
    const p = enemy.parts[idx];
    if ((!p.hidden && !p.coveredBy) || state.showInner) return true;
    if (p.hidden === 'angle') return !!sim; // a shot you actually placed reached it
    if (p.coveredBy && !p.hidden) {
      if (!sim) return true; // time to kill already includes stripping the plate
      // under two plates (alsoCoveredBy): either one broken exposes it
      const ai = p.alsoCoveredBy ? enemy.parts.findIndex((q) => q.name === p.alsoCoveredBy) : -1;
      if (ai >= 0 && sim.hp[ai]?.some((h) => h <= 0)) return true;
      const ci = enemy.parts.findIndex((q) => q.name === p.coveredBy);
      const hp = sim.hp[ci];
      if (ci < 0 || !hp) return true;
      const n = p.count || 1; // each piece has its own plates: 2 plates per piece when there are twice as many
      if (k != null && hp.length % n === 0) { const r = hp.length / n; return hp.slice(k * r, (k + 1) * r).some((h) => h <= 0); }
      return hp.some((h) => h <= 0);
    }
    if (!sim) return false;
    return coverFor(enemy, idx).some((i) => sim.hp[i] && sim.hp[i].some((h) => h <= 0));
  }

  function bestOf(results, view) {
    // "Main" is a health pool, not something you can aim at; use it only when nothing else kills
    const reachable = results.filter((x) => !x.part.hidden || state.showInner);
    results = reachable;
    const aimable = results.filter((x) => !isMainRow(x.part) && killKey(x.r) != null);
    let best = null;
    for (const x of aimable.length ? aimable : results) {
      const k = killKey(x.r);
      if (!visible(x.part, view) || k == null) continue;
      const bk = best && killKey(best.r);
      if (!best || k < bk || (k === bk && x.r.total > best.r.total)) best = x;
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
    if (n >= 1e4) return TTK_COLORS[TTK_COLORS.length - 1]; // kill known only in shots
    const i = TTK_STEPS.findIndex((s) => n <= s);
    return TTK_COLORS[i];
  }

  /* ---------------- lookups ---------------- */

  const enemyById = (id) => DATA.enemies.find((e) => e.id === id);
  const weaponById = (id) => DATA.weapons.find((w) => w.id === id);
  const enemy = () => enemyById(state.enemyId);
  const weapon = () => weaponById(state.weaponId);
  const opts = () => ({ explosion: state.explosion, allPellets: state.allPellets, allShrap: state.allShrap, band: state.band, dist: state.dist, exposeAll: state.showInner });

  /* ---------------- rendering: lists ---------------- */

  // Faction picker → enemy list, like choosing a nation before a tank.
  const FACTION_INFO = {
    Terminids: { short: 'Bugs', color: '#ffb901', blurb: 'Bugs' },
    Automatons: { short: 'Bots', color: '#ff6161', blurb: 'Bots' },
    Illuminate: { short: 'Squids', color: '#cd8aea', blurb: 'Squids' },
  };
  // faction emblems in images/factions/ (community traces by Dogo314)
  const FACTION_ICON = Object.fromEntries(Object.keys(FACTION_INFO).map((f) => [f, `<img src="images/factions/${f.toLowerCase()}.svg" alt="">`]));
  const factionColor = (f) => FACTION_INFO[f]?.color || 'var(--accent)';

  function thumbHtml(e) {
    if (DATA.thumbs?.[e.id]) return `<img class="thumb" src="images/enemies/${esc(e.id)}.png" alt="" loading="lazy" width="36" height="36">`;
    const initials = e.name.split(/\s+/).filter((w) => !w.startsWith('(')).slice(0, 2).map((w) => w[0]).join('');
    return `<span class="thumb ph" style="--fc:${factionColor(e.faction)}">${esc(initials)}</span>`;
  }

  function renderFactionTabs() {
    const head = $('#factionTabs');
    if (!state.faction) { head.innerHTML = ''; head.classList.add('hidden'); return; }
    head.classList.remove('hidden');
    head.innerHTML = `<button class="back" data-f="" title="Back to factions">← Factions</button>
      <span class="fac-chip" style="--fc:${factionColor(state.faction)}">${FACTION_ICON[state.faction] || ''}${esc(state.faction)}</span>`;
  }

  function renderEnemyList() {
    const q = $('#enemySearch').value.trim().toLowerCase();
    const list$ = $('#enemyList');
    if (!state.faction && !q) {
      const factions = [...FACTION_ORDER, ...new Set(DATA.enemies.map((e) => e.faction))].filter((f, i, arr) => arr.indexOf(f) === i && DATA.enemies.some((e) => e.faction === f));
      list$.innerHTML = factions.map((f) => `<li class="fac-card" data-f="${esc(f)}" style="--fc:${factionColor(f)}">
          <span class="fac-icon">${FACTION_ICON[f] || ''}</span>
          <span class="fac-text"><b>${esc(f)}</b><i>${esc(FACTION_INFO[f]?.blurb || '')} · ${DATA.enemies.filter((e) => e.faction === f).length} enemies</i></span>
          <span class="fac-go">›</span>
        </li>`).join('');
      return;
    }
    const list = DATA.enemies.filter((e) => (!state.faction || q || e.faction === state.faction) && (!q || e.name.toLowerCase().includes(q)));
    list$.innerHTML = list.map((e) => `<li data-id="${esc(e.id)}" class="enemy ${e.id === state.enemyId ? 'on' : ''}">
        ${thumbHtml(e)}
        <span class="en-name">${esc(e.name)}${q && !state.faction ? ` <i class="muted">${esc(FACTION_INFO[e.faction]?.short || e.faction)}</i>` : ''}</span>
        ${hasModel(e.id) ? '<span class="badge3d" title="3D model available">3D</span>' : ''}
      </li>`).join('') || '<li class="empty">No enemies match.</li>';
  }

  // Weapon category picker → weapon list, mirroring the faction picker.
  const CAT_INFO = {
    Primary: { blurb: 'Rifles, shotguns, energy', icon: 'ar-23-liberator' },
    Secondary: { blurb: 'Sidearms and melee', icon: 'p-4-senator' },
    Throwable: { blurb: 'Grenades and throwables', icon: 'g-6-frag' },
    Support: { blurb: 'Support weapon stratagems', icon: 'gr-8-recoilless-rifle' },
    Eagle: { blurb: 'Eagle airstrikes', icon: 'eagle-500kg-bomb' },
    Orbital: { blurb: 'Orbital strikes', icon: 'orbital-railcannon-strike' },
    Sentry: { blurb: 'Automated sentries', icon: 'a-ac-8-autocannon-sentry' },
    Emplacement: { blurb: 'Manned emplacements', icon: 'e-mg-101-hmg-emplacement' },
  };

  function weaponThumbHtml(w, cls = 'wthumb') {
    const ext = DATA.wthumbs?.[w.id];
    if (ext) return `<img class="${cls}${ext === 'svg' ? ' strat' : ''}" src="images/weapons/${esc(w.id)}.${ext}" alt="" loading="lazy">`;
    return `<span class="${cls} ph">${esc((w.name.match(/^[A-Z0-9/-]+/) || [w.name.slice(0, 3)])[0].slice(0, 6))}</span>`;
  }

  function renderCatTabs() {
    const head = $('#catTabs');
    if (!state.cat) { head.innerHTML = ''; head.classList.add('hidden'); return; }
    head.classList.remove('hidden');
    head.innerHTML = `<button class="back" data-c="" title="Back to categories">← Categories</button>
      <span class="fac-chip cat-chip">${esc(state.cat)}</span>`;
  }

  function renderWeaponList() {
    const q = $('#weaponSearch').value.trim().toLowerCase();
    const el = $('#weaponList');
    el.classList.toggle('cat-grid', !state.cat && !q);
    if (!state.cat && !q) {
      const cats = [...CAT_ORDER, ...new Set(DATA.weapons.map((w) => w.category))].filter((c, i, arr) => arr.indexOf(c) === i && DATA.weapons.some((w) => w.category === c));
      el.innerHTML = cats.map((c) => {
        const rep = weaponById(CAT_INFO[c]?.icon) || DATA.weapons.find((w) => w.category === c);
        return `<li class="cat-card" data-c="${esc(c)}">
          <span class="cat-icon">${weaponThumbHtml(rep, 'cat-img')}</span>
          <span class="cat-name"><b>${esc(c)}</b><i>${DATA.weapons.filter((w) => w.category === c).length}</i></span>
        </li>`;
      }).join('');
      return;
    }
    const list = DATA.weapons.filter((w) => (!state.cat || q || w.category === state.cat) && (!q || w.name.toLowerCase().includes(q) || (w.type || '').toLowerCase().includes(q)));
    el.innerHTML = list.map((w) => {
      const aps = [...new Set(w.modes.map((m) => m.ap))].join('/');
      return `<li data-id="${esc(w.id)}" class="weapon ${w.id === state.weaponId ? 'on' : ''}">
        ${weaponThumbHtml(w)}
        <span class="en-name">${esc(w.name)}${q && !state.cat ? ` <i class="muted">${esc(w.category)}</i>` : ''}</span>
        <span class="sub">AP${aps}</span>
      </li>`;
    }).join('') || '<li class="empty">No weapons match.</li>';
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
        ${ex && (ex.inner ?? ex.innerRadius) != null ? `<div class="stat"><div class="k">Radius</div><div class="v">${ex.inner ?? ex.innerRadius}/${ex.outer ?? ex.outerRadius ?? '?'}m</div></div>` : ''}
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
      <div class="range">
        <label class="opt">Range <b id="distVal">${state.dist} m</b></label>
        <input type="range" id="distSlider" min="0" max="200" step="5" value="${state.dist}">
        <div class="ap-caption">${m.ballistics?.drag ? `Projectile damage at ${state.dist} m: <b>${Math.round(rangeMult(m, state.dist) * 100)}%</b> (drag falloff)` : m.ballistics ? 'No drag: no falloff over range' : '<span class="muted">No ballistics data: range has no effect</span>'}</div>
      </div>
      <div class="opts">
        ${w.modes.length > 1 ? `<label class="opt">Ammo / mode
          <select id="modeSel">${w.modes.map((mm, i) => `<option value="${i}" ${i === state.mode ? 'selected' : ''}>${esc(mm.name || 'Mode ' + (i + 1))}</option>`).join('')}</select></label>` : ''}
        ${ex ? `<label class="opt">Include explosion (direct hit) <input type="checkbox" id="exChk" ${state.explosion ? 'checked' : ''}></label>` : ''}
        ${pellets > 1 ? `<label class="opt">All ${pellets} pellets hit <input type="checkbox" id="pelChk" ${state.allPellets ? 'checked' : ''}></label>` : ''}
        ${m.shrapnel ? `<label class="opt" title="Body map and time to kill: count every fragment on the struck part (an upper bound). The 3D view traces each fragment instead.">All ${m.shrapnel.count} shrapnel hit the part <input type="checkbox" id="shrapChk" ${state.allShrap ? 'checked' : ''}></label>` : ''}
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
    renderShotPanel(e);
    publish3d(e, results);
    renderLegend();
    renderPartsTable(e, results);
    const tabKey = JSON.stringify([state.tab, e.id, state.view, state.showInner, state.explosion, state.allPellets, state.band, state.dist, state.weaponId]);
    if (tabKey !== lastTabKey) {
      lastTabKey = tabKey;
      if (state.tab === 'rank') renderRankTable(e);
      if (state.tab === 'real') renderRealTable(e);
    }
  }

  function renderSummary(e, w, results) {
    const main = mainPart(e);
    const vis = results.filter((x) => visible(x.part, state.view));
    const best = w ? bestOf(results, state.view) : null;
    const penCount = w ? vis.filter((x) => x.r.total > 0 || x.r.mainEx > 0).length : 0;
    const fatalCount = e.parts.filter((p) => p.fatal === true && !isMainRow(p)).length;
    $('#summary').innerHTML = `
      <div class="kpi"><div class="k">Main health</div><div class="v">${fmt(main?.health)}</div><div class="s">${main ? avName(main.av) + ' · AV' + main.av : 'unknown'}</div></div>
      <div class="kpi ${best ? 'good' : w ? 'bad' : ''}"><div class="k">Time to kill</div><div class="v">${best ? (isOneShot(best.r) ? ONE_SHOT : best.r.ttk != null ? fmtTime(best.r.ttk) : shotsLabel(best.r)) : w ? 'None' : '—'}</div><div class="s">${best ? (isOneShot(best.r) ? fmt(best.r.total) + ' dmg · ' : best.r.ttk != null ? shotsLabel(best.r) + ' · ' : '') + (best.r.kind === 'dot' ? esc(best.r.why) : 'via ' + esc(best.part.name)) + (best.r.downs ? ' (downs)' : '') + (best.r.reload ? ' · needs reload' : '') : w ? 'Nothing in view dies to this' : 'Pick a weapon'}</div></div>
      <div class="kpi"><div class="k">Damageable zones</div><div class="v">${w ? `${penCount}/${vis.length}` : vis.length}</div><div class="s">${w ? 'hitzones this weapon hurts' : 'hitzones in view'}</div></div>
      <div class="kpi"><div class="k">Fatal parts</div><div class="v">${fatalCount}</div><div class="s">besides Main</div></div>
    `;
  }

  function renderSchematic(e, results) {
    const zones = { head: [], arms: [], body: [], rear: [], legs: [] };
    results.forEach((x, i) => {
      const n = x.part.count || 1;
      if (n >= 2 && n <= 4) for (let k = 0; k < n; k++) zones[region(x.part.name)].push({ ...x, i, k, n });
      else zones[region(x.part.name)].push({ ...x, i });
    });
    const maxHP = Math.max(1, ...e.parts.map((p) => (typeof p.health === 'number' ? p.health : 0)));
    for (const [z, items] of Object.entries(zones)) {
      const zoneEl = $(`.z-${z}`);
      zoneEl.classList.toggle('empty', items.length === 0);
      $('.tiles', zoneEl).innerHTML = items
        .map(({ part, r, i, k: inst, n }) => {
          const hp = typeof part.health === 'number' ? part.health : maxHP * 0.4;
          const k = Math.sqrt(hp / maxHP);
          const size = `--w:${Math.round(100 + 120 * k)}px;--h:${Math.round(56 + 40 * k)}px;`;
          const vis = visible(part, state.view);
          let color = 'var(--pen-immune)';
          let big = '—', small = '';
          if (r) {
            color = state.color === 'pen' ? PEN_VAR[penClass(r, part)] : ttkColor(killKey(r));
            if (state.color === 'pen') {
              big = r.total > 0 ? fmt(r.total) : r.mainEx > 0 ? fmt(r.mainEx) : '0';
              small = r.total > 0 ? 'dmg/shot' : r.mainEx > 0 ? 'to main' : 'no dmg';
            } else {
              big = isOneShot(r) ? ONE_SHOT : r.ttk != null ? fmtTime(r.ttk) : r.killAt ?? '✕';
              small = isOneShot(r) ? `${fmt(r.total)} dmg` : r.ttk != null ? shotsLabel(r) + (r.reload ? ' +reload' : '') : r.killAt ? 'shots (no RPM)' : r.breakAt ? `breaks ${r.breakAt}` : 'no kill';
            }
          }
          let left = state.fire ? partLeft(i) : null;
          if (left && inst != null && left.segs) {
            const c = left.csegs?.[inst];
            left = { ...left, frac: left.segs[inst], segs: [left.segs[inst]], csegs: [c], gone: left.gones[inst],
              label: left.segs[inst] > 0 ? (part.indestructible ? 'Indestructible' : `${fmt(left.segs[inst] * part.health)} HP left`)
                : c > 0 ? `Broken · ${fmt(c * part.cons)} constitution left` : 'Destroyed' };
          }
          const fatal = part.fatal === true ? '<span class="fatal" title="Destroying this kills">☠ fatal</span>' : part.fatal === 'downs' ? '<span class="fatal" title="Destroying this downs the enemy">☠ downs</span>' : '';
          const covered = !isExposed(e, i, state.fire ? state.sim : null, inst);
          return `<div class="tile ${vis ? '' : 'dim'} ${covered ? 'covered' : ''} ${left && (left.gone ?? left.frac <= 0) ? 'gone' : left?.csegs?.some((c) => c != null) && left.csegs.every((c, n) => c != null || left.gones?.[n]) ? 'on-cons' : ''}" data-i="${i}"${inst != null ? ` data-k="${inst}"` : ''} style="--c:${color};${size}" ${covered ? 'title="Behind armor: break the armor first"' : ''}>
              ${part.hidden ? `<span class="inner-tag">${hiddenTag(part, !covered)}</span>` : part.coveredBy ? `<span class="inner-tag">${coverTag(part, state.fire && isExposed(e, i, state.sim, inst))}</span>` : ''}
              <span class="av">AV${part.av}</span>
              <div class="name">${inst != null ? `${esc(part.name.replace(/\s*\(\d+\)$/, ''))} <span class="muted">${inst + 1}/${n}</span>` : esc(part.name)}</div>
              <div class="row"><span>${part.indestructible ? 'Indestructible' : typeof part.health === 'number' ? fmt(part.health) + ' HP' : 'Main HP'} ${fatal}</span><span><span class="big">${big}</span> ${small}</span></div>
              ${left ? `<div class="hpbars" title="${esc(left.label)}">${(left.segs || [left.frac]).map((f, n) => left.csegs?.[n] != null
                ? `<div class="hpbar cons"><b style="width:${Math.max(0, left.csegs[n] * 100)}%"></b></div>`
                : `<div class="hpbar"><b style="width:${Math.max(0, f * 100)}%"></b></div>`).join('')}</div>` : ''}
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
      $('#legend').innerHTML = `<span>Time to kill: instant<span class="ramp">${TTK_COLORS.map((c) => `<b style="background:${c}"></b>`).join('')}</span>8 s+</span>
        <span class="muted">From RPM; first shot at 0 s, reloads not included</span>
        <span><i style="background:var(--pen-immune)"></i>Can't kill through this zone</span>`;
    }
  }

  function renderPartsTable(e, results) {
    const w = weapon();
    const head = `<thead><tr>
      <th>Hitzone</th><th class="num">AV</th><th class="num">Health</th><th class="num">Durable</th><th class="num">To main</th><th>Fatal</th><th class="num">ExDR</th>
      ${w ? '<th>Result</th><th class="num">Dmg/shot</th><th class="num">Main/shot</th><th class="num">Break</th><th class="num">Shots</th><th class="num">TTK</th>' : ''}
    </tr></thead>`;
    const rows = results
      .map(({ part, r }, i) => {
        if (!visible(part, state.view)) return '';
        const pc = r ? penClass(r, part) : null;
        return `<tr data-i="${i}">
          <td>${esc(part.name)}${part.hidden ? ` <span class="inner-tag inline">${hiddenTag(part, isExposed(e, i, state.fire ? state.sim : null))}</span>` : part.coveredBy ? ` <span class="inner-tag inline">${coverTag(part, state.fire && isExposed(e, i, state.sim))}</span>` : ''}</td>
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
            <td class="num">${r.kind === 'shot' ? r.killAt ?? '—' : shotsLabel(r)}${r.strip ? ` <span class="muted" title="Includes shots to destroy ${esc(r.strip.part)}">(${r.strip.shots} armor)</span>` : ''}</td>
            <td class="num"><b>${ttkHtml(r)}${r.reload ? '<span class="muted" title="More shots than one magazine">*</span>' : ''}</b></td>` : ''}
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
        if (b && (!best || killKey(b.r) < killKey(best.b.r) || (killKey(b.r) === killKey(best.b.r) && b.r.total > best.b.r.total))) best = { b, mi };
      });
      rows.push({ w, best });
    }
    const one = (x) => (x.best && isOneShot(x.best.b.r) ? 0 : 1);
    rows.sort((a, b) => one(a) - one(b)
      || (one(a) === 0 ? b.best.b.r.total - a.best.b.r.total : 0)
      || (a.best ? killKey(a.best.b.r) : 1e9) - (b.best ? killKey(b.best.b.r) : 1e9)
      || (b.best?.b.r.total ?? 0) - (a.best?.b.r.total ?? 0));
    $('#rankTable').innerHTML = `<thead><tr><th>#</th><th>Weapon</th><th>Category</th><th>Mode</th><th>Best hitzone</th><th class="num">Dmg/shot</th><th class="num">Shots</th><th class="num">Time to kill</th></tr></thead><tbody>` +
      rows
        .map(({ w, best }, i) => `<tr class="click ${w.id === state.weaponId ? 'hl' : ''}" data-w="${esc(w.id)}" data-m="${best ? best.mi : 0}">
          <td class="num muted">${best ? i + 1 : ''}</td>
          <td>${esc(w.name)}</td><td class="muted">${esc(w.category)}</td>
          <td class="muted">${best && w.modes.length > 1 ? esc(w.modes[best.mi].name) : ''}</td>
          <td>${best ? esc(best.b.part.name) : '<span class="muted">Can’t kill</span>'}</td>
          <td class="num">${best ? fmt(best.b.r.total) : '—'}</td>
          <td class="num">${best ? shotsLabel(best.b.r) : '—'}</td>
          <td class="num"><b style="color:${best ? ttkColor(killKey(best.b.r)) : 'var(--dim)'}">${best ? ttkHtml(best.b.r) : '—'}${best?.b.r.reload ? '*' : ''}</b></td>
        </tr>`)
        .join('') + '</tbody>';
  }

  /** Fastest and slowest kill over every reachable, killing hitzone in view, and their midpoint.
   *  Times when the weapon has them; otherwise shot counts (ranked after timed weapons). */
  function spreadOf(results, view) {
    const ok = results.filter((x) => visible(x.part, view) && (!x.part.hidden || state.showInner) && killKey(x.r) != null);
    const aim = ok.filter((x) => !isMainRow(x.part));
    const zones = aim.length ? aim : ok;
    if (!zones.length) return null;
    const timed = zones.every((x) => x.r.ttk != null);
    const val = (x) => (timed ? x.r.ttk : x.r.killAt);
    let lo = zones[0], hi = zones[0];
    for (const x of zones) {
      if (val(x) < val(lo) || (val(x) === val(lo) && x.r.total > lo.r.total)) lo = x;
      if (val(x) > val(hi)) hi = x;
    }
    return { lo, hi, mid: (val(lo) + val(hi)) / 2, timed, n: zones.length };
  }

  function renderRealTable(e) {
    const o = opts();
    const rows = [];
    for (const w of DATA.weapons) {
      let best = null;
      w.modes.forEach((m, mi) => {
        const sp = spreadOf(evalEnemy(w, mi, e, o), state.view);
        if (!sp) return;
        const key = sp.timed ? sp.mid : 1e4 + sp.mid;
        if (!best || key < best.key) best = { ...sp, mi, key };
      });
      rows.push({ w, best });
    }
    // ties (e.g. one-shots everywhere) go to the harder-hitting weapon
    rows.sort((a, b) => (a.best ? a.best.key : Infinity) - (b.best ? b.best.key : Infinity) || (b.best?.hi.r.total ?? 0) - (a.best?.hi.r.total ?? 0));
    const val = (sp, x) => (isOneShot(x.r) ? ONE_SHOT : sp.timed ? fmtTime(x.r.ttk) : shotsLabel(x.r));
    const mid = (sp) => {
      if (isOneShot(sp.lo.r) && isOneShot(sp.hi.r)) return ONE_SHOT;
      return sp.timed ? fmtTime(sp.mid) : `~${Math.ceil(sp.mid)} shots`;
    };
    $('#realTable').innerHTML = `<thead><tr><th>#</th><th>Weapon</th><th>Category</th><th>Mode</th>
        <th>Fastest</th><th class="num">TTK</th><th>Slowest</th><th class="num">TTK</th><th class="num">Real life</th></tr></thead><tbody>` +
      rows.map(({ w, best: sp }, i) => `<tr class="click ${w.id === state.weaponId ? 'hl' : ''}" data-w="${esc(w.id)}" data-m="${sp ? sp.mi : 0}">
          <td class="num muted">${sp ? i + 1 : ''}</td>
          <td>${esc(w.name)}</td><td class="muted">${esc(w.category)}</td>
          <td class="muted">${sp && w.modes.length > 1 ? esc(w.modes[sp.mi].name) : ''}</td>
          ${sp ? `<td>${esc(sp.lo.part.name)}</td><td class="num">${val(sp, sp.lo)}</td>
            <td>${esc(sp.hi.part.name)}</td><td class="num">${val(sp, sp.hi)}</td>
            <td class="num"><b style="color:${ttkColor(sp.key)}">${mid(sp)}</b></td>`
          : '<td colspan="5" class="muted">Can’t kill</td>'}
        </tr>`).join('') + '</tbody>';
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
    state.sim = e ? { ...newSim(e), enemyId: e.id, time: 0, last: null, weapons: new Set(), swaps: 0 } : null;
  }
  /** Changing weapon in fire mode keeps the damage done so far, so loadouts can be mixed. */
  function swapWeapon() {
    const sim = state.sim;
    if (!state.fire || !sim || !sim.shots || sim.dead) { resetSim(); return; }
    const w = weapon();
    sim.log.unshift(`— switched to ${w.name}${w.modes.length > 1 ? ` (${(w.modes[state.mode] || w.modes[0]).name})` : ''} —`);
    sim.log.length = Math.min(sim.log.length, 8);
  }
  /** Before each fired shot: advance the clock by the weapon's fire interval and note which weapon fired. */
  function shotClock() {
    const sim = state.sim, w = weapon();
    const key = `${w.id}:${state.mode}`;
    const fm = fireModel(w, w.modes[state.mode] || w.modes[0]);
    if (fm?.kind === 'dot') sim.time += DOT_CLICK; // a flame / gas click is a second of spraying
    else if (sim.last === key) sim.time += fm && fm.kind === 'shot' && fm.interval ? fm.interval : 0;
    if (sim.last && sim.last !== key) sim.swaps++;
    sim.last = key;
    sim.weapons.add(w.id);
    return sim.weapons.size > 1 ? `[${w.name.replace(/^\S+-\d+\S*\s+/, '')}] ` : '';
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
    if (p.indestructible) return { frac: 1, segs: inst.map(() => 1), gones: inst.map(() => false), gone: false, label: 'Indestructible', alive: inst.length };
    const cons = consOf(p);
    const csegs = inst.map((h) => (cons && h <= 0 ? Math.max(0, cons + h) / cons : null));
    const gones = inst.map((h) => instGone(p, h));
    const consLeft = inst.reduce((a, h) => a + (cons && h <= 0 ? Math.max(0, cons + h) : 0), 0);
    return { frac: sum / total, segs: inst.map((h) => Math.max(0, h) / p.health), csegs, gones, gone: gones.every(Boolean),
      label: `${alive}/${inst.length} intact · ${fmt(sum)} HP left${consLeft > 0 ? ` · ${fmt(consLeft)} constitution left` : ''}`, alive };
  }

  /** hit = { deg } when fired from the 3D view, so the real impact angle picks the AP. */
  /** Stagger needs damage that lands with Stagger Force ≥ the enemy's threshold (no build-up between hits);
   *  a staggered enemy is shoved back by the Push Force. Explosions bring their own forces. */
  function forceNote(mode, enemy, s, blast) {
    const st = Math.max(mode.explosionOnly ? -1 : mode.stagger ?? -1, blast ? mode.explosion?.stagger ?? -1 : -1);
    const push = Math.max(mode.explosionOnly ? -1 : mode.push ?? -1, blast ? mode.explosion?.push ?? -1 : -1);
    if (st < 0) return '';
    if (!(s.total > 0 || s.mainEx > 0)) return '';
    const thr = enemy.stagger;
    if (thr == null) return ` · stagger ${st} (no threshold listed)`;
    if (st < thr) return ` · no stagger (${st} < ${thr})`;
    return ` [[Staggered]] ${st} ≥ ${thr}${push > 0 ? ` [[Pushed]] force ${push}` : ''}`;
  }

  function fireAt(i, hit, k) {
    const e = enemy(), w = weapon();
    if (!e || !w || !state.sim || state.sim.dead) return;
    const mode = w.modes[state.mode] || w.modes[0];
    const part = e.parts[i];
    // destroyed parts have no hitbox anymore
    const left = partLeft(i);
    if (left && !left.main && (k != null && left.gones ? left.gones[k] : left.gone ?? left.frac <= 0)) return;
    if (!isExposed(e, i, state.sim, k)) {
      state.sim.log.unshift(part.coveredBy && !part.hidden
        ? `${part.name} is under ${part.coveredBy} — break it first`
        : `${part.name} is behind armor — break the armor first (or turn on "Covered parts: exposed")`);
      state.sim.log.length = Math.min(state.sim.log.length, 8);
      render();
      return;
    }
    const band = hit ? bandOf(hit.deg) : state.band;
    const s = shotDamage(mode, part, e, { ...opts(), band });
    const tag = shotClock();
    const o = applyHit(state.sim, e, i, s, mode, { ...opts(), band }, false, k);
    const thru = !state.sim.dead ? overpen(mode, e, i, s, { ...opts(), band }) : null;
    const o2 = thru ? applyShot(state.sim, e, thru.idx, thru.s, true) : null;
    const dotNote = dotSecond(state.sim, e, mode);
    const label = k != null && (part.count || 1) > 1 ? `${part.name.replace(/\s*\(\d+\)$/, '')} ${k + 1}/${part.count}` : part.name;
    state.sim.log.unshift(`#${state.sim.shots} ${tag}${label}${hit ? ` @ ${Math.round(hit.deg)}°` : ''}: ${s.total > 0 ? fmt(s.total) + ' dmg' : 'ricochet'}${o.toMain > 0 ? `, ${fmt(o.toMain)} to Main` : ''}${o.broke ? ' — destroyed' : ''}${underNote(e, o)}${dotNote}${thru ? ` → through into ${e.parts[thru.idx].name} (AP ${thru.ap}): ${fmt(thru.s.total)} dmg${o2.toMain > 0 ? `, ${fmt(o2.toMain)} to Main` : ''}${o2.broke ? ' — destroyed' : ''}` : ''}${state.sim.dead ? '' : forceNote(mode, e, s, state.explosion)}`);
    state.sim.log.length = Math.min(state.sim.log.length, 8);
    render();
  }

  /** Elapsed time for the shots fired so far, from the weapon's RPM. */
  function fireElapsed(shots) {
    const sim = state.sim;
    if (!sim || shots < 2 || !sim.time) return '';
    return `<span class="hud-k">Elapsed</span><span class="hud-v">${fmtTime(sim.time)}${sim.swaps ? ` <span class="muted" title="Time to switch weapons isn't included">+${sim.swaps} swap${sim.swaps > 1 ? 's' : ''}</span>` : ''}</span>`;
  }

  function renderFireHud(e) {
    const hud = $('#fireHud');
    const banner = $('#killBanner');
    $('#fireBtn').classList.toggle('on', state.fire);
    if (!state.fire) { hud.classList.add('hidden'); banner.classList.add('hidden'); return; }
    hud.classList.remove('hidden');
    const sim = state.sim;
    const pools = e.parts.map((p, i) => ({ p, i })).filter(({ i }) => sim.pool[i] != null);
    // dead some other way than this pool running out (a fatal part destroyed): say so next to its health
    const deadAt = sim.dead && sim.dead.idx != null && sim.pool[sim.dead.idx] == null ? mainIndexFor(e, sim.dead.idx) : -1;
    const deadTag = (i) => (i === deadAt || (deadAt < 0 && sim.dead && sim.pool[sim.dead.idx] == null && i === pools[0]?.i)
      ? `<span class="hud-dead">☠ ${sim.dead.how === 'downed' ? 'Downed' : 'Killed'}: ${esc(sim.dead.why)}</span>` : '');
    hud.innerHTML = `
      <div class="hud-row">
        <span class="hud-k">Shots fired</span><span class="hud-v">${sim.shots}</span>${fireElapsed(sim.shots)}
        ${pools.map(({ p, i }) => `<span class="hud-k">${esc(p.name)}</span>
          <span class="hpbar wide"><b style="width:${Math.max(0, (sim.pool[i] / p.health) * 100)}%"></b></span>
          <span class="hud-v">${fmt(Math.max(0, sim.pool[i]))}</span>${deadTag(i)}`).join('')}
        <button class="btn ghost sm" id="resetSim">Reset</button>
      </div>
      <div class="hud-log">${sim.log.length ? sim.log.map((l) => esc(l).replace(/\[\[(\w+)\]\]/g, '<span class="force-tag">$1</span>')).join('<br>') : 'Click a hitzone to fire one shot of the selected weapon.'}</div>`;
    if (sim.dead) {
      banner.classList.remove('hidden');
      banner.innerHTML = `<div class="kb-title">${sim.dead.how === 'downed' ? 'Downed' : 'Killed'}</div>
        <div class="kb-sub">${esc(sim.dead.why)} · ${sim.shots} shot${sim.shots > 1 ? 's' : ''}</div>
        <button class="btn" id="resetSim2">Fire again</button>`;
    } else banner.classList.add('hidden');
  }

  /* ---------------- shots placed on the 3D model ---------------- */

  /** Explosion radii of the current mode, when explosions are on and the wiki lists them. */
  function blastRadii(mode) {
    const ex = state.explosion ? mode?.explosion : null;
    if (!ex || !(ex.damage || ex.durable)) return null;
    const inner = ex.inner ?? ex.innerRadius, outer = ex.outer ?? ex.outerRadius;
    if (inner == null && outer == null) return null;
    return { inner: inner ?? 0, outer: outer ?? inner, shockwave: ex.shockwave ?? null };
  }

  /** Damage from one shot at a 3D impact point: the struck part takes projectile + full blast, other parts
   *  inside the outer radius take falloff blast, and Main gets the redirected share only once per blast. */
  function resolveHit(hit) {
    const e = enemy(), w = weapon();
    if (!e || !w || !hit) return null;
    const mode = w.modes[state.mode] || w.modes[0];
    const band = bandOf(hit.deg);
    const o = { ...opts(), band };
    if (hit.ground) return resolveGround(hit, mode, band, o);
    const rows = [{ idx: hit.idx, dist: 0, direct: true, s: shotDamage(mode, e.parts[hit.idx], e, { ...o, exDist: 0, noShrap: true }) }];
    // 3D shots: the next piece along the shot's path (hit.thru from the viewer), if the cleave rule lets it through
    const thru0 = overpen(mode, e, hit.idx, rows[0].s, o, 'thru' in hit ? hit.thru?.idx ?? null : undefined);
    const thru = thru0 ? { ...thru0, k: hit.thru?.k ?? null } : null;
    const radii = rows[0].s.ricochet ? null : blastRadii(mode); // a ricochet means no blast at all
    if (radii) {
      // pieces reached by the blast rays (3D view); the struck piece already took the full blast
      const reached = hit.blastHits || Object.entries(hit.parts || {}).map(([k, d]) => ({ idx: +k, k: null, d }));
      for (const b of reached) {
        if ((b.idx === hit.idx && (b.k == null || b.k === hit.k)) || b.d > radii.outer) continue;
        const sx = shotDamage(mode, e.parts[b.idx], e, { ...o, noProj: true, exDist: b.d });
        rows.push({ idx: b.idx, k: b.k, dist: b.d, s: sx }); // listed even when the armor stops it
      }
      const top = Math.max(0, ...rows.map((r) => r.s.mainEx));
      let used = false;
      rows.forEach((r) => {
        if (!used && top > 0 && r.s.mainEx === top) used = true;
        else r.s = { ...r.s, mainEx: 0 };
      });
    }
    // shrapnel: each fragment ray hits one piece at its own angle; fragments on the same piece add up
    let shrap = null;
    if (mode.shrapnel && state.explosion && !rows[0].s.ricochet && hit.shrapHits) {
      const fm = shrapnelMode(mode), by = new Map();
      for (const f of hit.shrapHits) {
        const sf = shotDamage(fm, e.parts[f.idx], e, { ...o, band: bandOf(f.deg), dist: f.d, explosion: false, noShrap: true });
        const id = `${f.idx}:${f.k}`;
        const acc = by.get(id) || { idx: f.idx, k: f.k, n: 0, s: { proj: 0, partEx: 0, mainEx: 0, total: 0 } };
        acc.n++; acc.s.proj += sf.proj; acc.s.total += sf.total;
        by.set(id, acc);
      }
      shrap = { count: mode.shrapnel.count, hit: hit.shrapHits.length, rows: [...by.values()] };
    }
    return { mode, band, rows, radii, thru, shrap };
  }

  /** A shot into the ground next to the enemy (3D view): no part is struck, so only the explosion counts:
   *  every piece the blast rays reach takes falloff damage (Main's share once per blast), plus shrapnel. */
  function resolveGround(hit, mode, band, o) {
    const e = enemy();
    const radii = blastRadii(mode);
    const rows = [];
    if (radii) {
      for (const b of hit.blastHits || []) {
        if (b.d > radii.outer) continue;
        rows.push({ idx: b.idx, k: b.k, dist: b.d, s: shotDamage(mode, e.parts[b.idx], e, { ...o, noProj: true, exDist: b.d }) });
      }
      rows.sort((a, b) => a.dist - b.dist);
      const top = Math.max(0, ...rows.map((r) => r.s.mainEx));
      let used = false;
      rows.forEach((r) => {
        if (!used && top > 0 && r.s.mainEx === top) used = true;
        else r.s = { ...r.s, mainEx: 0 };
      });
    }
    let shrap = null;
    if (mode.shrapnel && state.explosion && hit.shrapHits) {
      const fm = shrapnelMode(mode), by = new Map();
      for (const f of hit.shrapHits) {
        const sf = shotDamage(fm, e.parts[f.idx], e, { ...o, band: bandOf(f.deg), dist: f.d, explosion: false, noShrap: true });
        const id = `${f.idx}:${f.k}`;
        const acc = by.get(id) || { idx: f.idx, k: f.k, n: 0, s: { proj: 0, partEx: 0, mainEx: 0, total: 0 } };
        acc.n++; acc.s.proj += sf.proj; acc.s.total += sf.total;
        by.set(id, acc);
      }
      shrap = { count: mode.shrapnel.count, hit: hit.shrapHits.length, rows: [...by.values()] };
    }
    return { mode, band, rows, radii, thru: null, shrap, ground: true };
  }

  function placeGround(hit) {
    state.hit = hit;
    const res = resolveHit(hit);
    if (!res?.radii && !res?.shrap) { render(); return 'Ground: no explosion with this weapon, nothing happens'; }
    if (state.fire && state.sim && !state.sim.dead) {
      const e = enemy(), notes = [];
      const tag = shotClock();
      state.sim.shots++;
      let n = 0;
      for (const r of res.rows) {
        if (state.sim.dead) break;
        if (r.s.total > 0 || r.s.mainEx > 0) n++;
        const o = applyShot(state.sim, e, r.idx, r.s, true, r.k ?? undefined);
        if (o.broke) notes.push(`${pieceName(e.parts[r.idx], r.k)} destroyed`);
      }
      if (res.shrap) {
        for (const f of res.shrap.rows) {
          if (state.sim.dead || !(f.s.total > 0)) continue;
          const of = applyShot(state.sim, e, f.idx, f.s, true, f.k ?? undefined);
          if (of.broke) notes.push(`${pieceName(e.parts[f.idx], f.k)} destroyed by shrapnel`);
        }
        notes.push(`shrapnel ${res.shrap.hit}/${res.shrap.count} hit`);
      }
      state.sim.log.unshift(`#${state.sim.shots} ${tag}ground: ${res.rows.length ? `blast reached ${res.rows.length} part${res.rows.length > 1 ? 's' : ''}, ${n} damaged` : 'blast reached nothing'}${notes.length ? ' — ' + notes.join(', ') : ''}`);
      state.sim.log.length = Math.min(state.sim.log.length, 8);
      render();
      return `Fired #${state.sim.shots}: ground, blast reached ${res.rows.length} part${res.rows.length === 1 ? '' : 's'}`;
    }
    render();
    if (state.fire && state.sim?.dead) return 'Enemy is already down. Press Reset or "Fire again" to keep shooting.';
    return state.fire ? '' : 'Shot inspected. Turn on Fire mode to deal damage.';
  }

  /** "Torso Armor 2/2" for one piece of a counted part, the plain name otherwise. */
  const pieceName = (p, k) => (k != null && (p.count || 1) > 1 ? `${p.name.replace(/\s*\(\d+\)$/, '')} ${k + 1}/${p.count}` : p.name);

  function placeHit(hit) {
    if (hit.ground) return placeGround(hit);
    const e0 = enemy();
    if (state.fire && state.sim && e0) {
      const l = partLeft(hit.idx); // that piece is destroyed: no hitbox (the viewer normally shoots past it)
      if (l && !l.main && (hit.k != null && l.gones ? l.gones[hit.k] : l.gone)) return `Ignored: ${pieceName(e0.parts[hit.idx], hit.k)} is already destroyed`;
    }
    if (e0 && !hit.revealed && !isExposed(e0, hit.idx, state.fire ? state.sim : null, hit.k)) hit = { ...hit, covered: true };
    state.hit = hit;
    if (hit.covered) {
      if (state.fire && state.sim && !state.sim.dead) {
        state.sim.log.unshift(`${e0.parts[hit.idx].name} is behind armor — break the armor first`);
        state.sim.log.length = Math.min(state.sim.log.length, 8);
      }
      render();
      return `Blocked: ${e0.parts[hit.idx].name} is behind armor`;
    }
    const res = resolveHit(hit);
    if (res) state.hit = { ...state.hit, ricochet: !!res.rows[0].s.ricochet };
    if (res && state.fire && state.sim && !state.sim.dead) {
      const e = enemy();
      const notes = [];
      const tag = shotClock();
      let mainShared = false; // Main's redirected share comes once per blast
      res.rows.forEach((r, k) => {
        const piece = k === 0 ? hit.k : r.k;
        if (k > 0 && mainShared && r.s.mainEx) r = { ...r, s: { ...r.s, mainEx: 0 } };
        const o = k === 0 ? applyHit(state.sim, e, r.idx, r.s, res.mode, { ...opts(), band: res.band, revealedK: hit.revealedK }, false, piece ?? undefined)
          : applyShot(state.sim, e, r.idx, r.s, true, piece ?? undefined);
        if (o.broke) notes.push(`${pieceName(e.parts[r.idx], piece)} destroyed`);
        if (o.under) notes.push(underNote(e, o).replace(/^ → /, ''));
        // the impact broke a plate and the flesh under it took the explosion: that already sent Main its share
        if (k === 0 && o.under) mainShared = true;
        if (k === 0 && res.shrap && !state.sim.dead) { // shrapnel fragments, each piece once with its total
          for (const f of res.shrap.rows) {
            if (state.sim.dead || !(f.s.total > 0)) continue;
            const of = applyShot(state.sim, e, f.idx, f.s, true, f.k ?? undefined);
            if (of.broke) notes.push(`${pieceName(e.parts[f.idx], f.k)} destroyed by shrapnel`);
          }
          notes.push(`shrapnel ${res.shrap.hit}/${res.shrap.count} hit`);
        }
        if (k === 0 && res.thru && !state.sim.dead) { // over-penetration into the part behind
          const o2 = applyShot(state.sim, e, res.thru.idx, res.thru.s, true, res.thru.k ?? undefined);
          notes.push(`through into ${pieceName(e.parts[res.thru.idx], res.thru.k)} (AP ${res.thru.ap}): ${fmt(res.thru.s.total)} dmg${o2.broke ? ', destroyed' : ''}`);
        }
      });
      const dotNote = dotSecond(state.sim, e, res.mode);
      if (dotNote) notes.push(dotNote.replace(/^ [+·] /, ''));
      const d = res.rows[0];
      state.sim.log.unshift(`#${state.sim.shots} ${tag}${pieceName(e.parts[d.idx], hit.k)} @ ${Math.round(hit.deg)}°: ${d.s.total > 0 ? fmt(d.s.total) + ' dmg' : 'ricochet'}${(() => { const n = res.rows.slice(1).filter((r) => r.s.partEx > 0 || r.s.mainEx > 0).length; return n ? ` + blast on ${n} part${n > 1 ? 's' : ''}` : ''; })()}${notes.length ? ' — ' + notes.join(', ') : ''}${state.sim.dead ? '' : forceNote(res.mode || weapon().modes[state.mode] || weapon().modes[0], e, d.s, state.explosion)}`);
      state.sim.log.length = Math.min(state.sim.log.length, 8);
      render();
      return `Fired #${state.sim.shots}: ${pieceName(e.parts[d.idx], hit.k)} @ ${Math.round(hit.deg)}°`;
    }
    render();
    if (state.fire && state.sim?.dead) return 'Enemy is already down. Press Reset or "Fire again" to keep shooting.';
    return state.fire ? '' : 'Shot inspected. Turn on Fire mode to deal damage.';
  }

  function renderShotPanel(e) {
    const el = $('#shotPanel');
    if (state.stageView === '3d' && state.hit?.covered) {
      el.classList.remove('hidden');
      el.innerHTML = `<button class="sp-close" id="shotClose" title="Clear shot">×</button>
        <div class="sp-title">${esc(e.parts[state.hit.idx].name)}</div>
        <div class="sp-verdict" style="--c:var(--pen-immune)">Behind armor</div>
        <div class="sp-hint">Inner and flesh parts can only be hit once the armor over them is destroyed. Break it in Fire mode, or turn on "Covered parts: exposed".</div>`;
      return;
    }
    const res = state.stageView === '3d' ? resolveHit(state.hit) : null;
    if (!res) { el.classList.add('hidden'); return; }
    if (res.ground) {
      el.classList.remove('hidden');
      el.innerHTML = `
        <button class="sp-close" id="shotClose" title="Clear shot">×</button>
        <div class="sp-title">Ground</div>
        <div class="sp-sub">Impact on the ground: only the explosion reaches the enemy</div>
        ${res.radii ? `<div class="sp-blast"><b>Blast</b> ${res.radii.inner}m inner / ${res.radii.outer}m outer
          ${res.rows.length ? '<ul>' + res.rows.map((r) => `<li><span>${esc(pieceName(e.parts[r.idx], r.k))} <i>${r.dist.toFixed(1)}m</i></span><span>${r.s.partEx > 0 ? fmt(r.s.partEx) : '<span class="muted" title="The blast AP does not beat this armor">0 · armor holds</span>'}</span></li>`).join('') + '</ul>' : '<div class="muted">No hitzone reached by the blast</div>'}
          ${res.rows.some((r) => r.s.mainEx) ? `<div class="muted">+${fmt(res.rows.reduce((a, r) => a + r.s.mainEx, 0))} redirected to Main (once per blast)</div>` : ''}</div>` : '<div class="muted">This weapon has no explosion: a ground hit does nothing</div>'}
        ${res.shrap ? `<div class="sp-blast"><b>Shrapnel</b> ${res.shrap.hit} of ${res.shrap.count} fragments hit${res.shrap.rows.length ? '<ul>' + res.shrap.rows.map((r) => `<li><span>${esc(pieceName(e.parts[r.idx], r.k))} <i>×${r.n}</i></span><span>${r.s.total > 0 ? fmt(r.s.total) : '<span class="muted">0 · armor holds</span>'}</span></li>`).join('') + '</ul>' : ''}</div>` : ''}
        ${state.fire ? '' : '<div class="sp-hint">Turn on Fire mode to apply shots.</div>'}`;
      return;
    }
    el.classList.remove('hidden');
    const d = res.rows[0];
    const part = e.parts[d.idx];
    const pc = penClass(d.s, part);
    const main = d.s.proj > 0 || d.s.partEx > 0 ? simulate(res.mode, e, d.idx, { ...opts(), band: res.band }).perMain : 0;
    const blastRows = res.rows.slice(1);
    const mainOnce = res.rows.reduce((a, r) => a + r.s.mainEx, 0);
    el.innerHTML = `
      <button class="sp-close" id="shotClose" title="Clear shot">×</button>
      <div class="sp-title">${esc(part.name)}</div>
      <div class="sp-sub">${Math.round(state.hit.deg)}° · ${ANGLE_BANDS[res.band].name} · AP ${d.s.ap} vs AV ${part.av}</div>
      <div class="sp-verdict" style="--c:${PEN_VAR[pc]}">${PEN_LABEL[pc]}</div>
      <dl>
        <dt>Projectile</dt><dd>${fmt(d.s.proj)}${state.dist && d.s.range < 1 ? ` <span class="muted">(${Math.round(d.s.range * 100)}% at ${state.dist} m)</span>` : ''}</dd>
        ${res.radii || d.s.partEx ? `<dt>Explosion</dt><dd>${fmt(d.s.partEx)}</dd>` : ''}
        <dt>Total to part</dt><dd><b>${fmt(d.s.total)}</b></dd>
        <dt>To Main</dt><dd>${fmt(main)}</dd>
      </dl>
      ${d.s.ricochet && res.mode.explosion && state.explosion ? '<div class="muted">Ricocheted: the round did not explode</div>' : ''}
      ${res.shrap ? `<div class="sp-blast"><b>Shrapnel</b> ${res.shrap.hit} of ${res.shrap.count} fragments hit${res.shrap.rows.length ? '<ul>' + res.shrap.rows.map((r) => `<li><span>${esc(pieceName(e.parts[r.idx], r.k))} <i>×${r.n}</i></span><span>${r.s.total > 0 ? fmt(r.s.total) : '<span class="muted">0 · armor holds</span>'}</span></li>`).join('') + '</ul>' : ''}</div>` : ''}
      ${res.radii ? `<div class="sp-blast"><b>Blast</b> ${res.radii.inner}m inner / ${res.radii.outer}m outer
        ${blastRows.length ? '<ul>' + blastRows.map((r) => `<li><span>${esc(pieceName(e.parts[r.idx], r.k))} <i>${r.dist.toFixed(1)}m</i></span><span>${r.s.partEx > 0 ? fmt(r.s.partEx) : '<span class="muted" title="The blast AP does not beat this armor">0 · armor holds</span>'}</span></li>`).join('') + '</ul>' : '<div class="muted">No other hitzone reached by the blast</div>'}
        ${mainOnce ? `<div class="muted">+${fmt(mainOnce)} redirected to Main (once per blast)</div>` : ''}</div>` : ''}
      ${state.fire ? '' : '<div class="sp-hint">Turn on Fire mode to apply shots. Change weapon or range to compare on this spot.</div>'}`;
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
      return !!(l && !l.main && (l.gone ?? l.frac <= 0));
    });
    const goneInst = e.parts.map((_, i) => (state.fire ? partLeft(i)?.gones || null : null));
    // fire mode: remaining health of the piece hit last, for the floating card on the 3D model
    let hitHp = null;
    if (state.fire && state.sim && state.hit && !state.hit.covered && !state.hit.ground) {
      const p = e.parts[state.hit.idx], l = partLeft(state.hit.idx);
      const k = state.hit.k ?? ((p.count || 1) === 1 ? 0 : null); // a single part reads like one piece
      if (l) {
        const one = k != null && l.segs;
        const frac = one ? l.segs[k] : l.frac;
        const cons = one ? l.csegs?.[k] : null;
        const gone = !l.main && (one ? l.gones?.[k] : l.gone);
        hitHp = {
          name: pieceName(p, state.hit.k), frac: Math.max(0, frac), cons, gone, main: !!l.main,
          text: l.main ? `uses Main · ${fmt(Math.max(0, frac * e.parts[mainIndexFor(e, state.hit.idx)].health))} left`
            : gone ? 'Destroyed'
            : cons != null ? `Broken · ${fmt(cons * p.cons)} constitution`
            : one ? `${fmt(frac * p.health)} / ${fmt(p.health)} HP` : l.label,
        };
      }
    }
    const w = weapon();
    const m = w ? w.modes[state.mode] || w.modes[0] : null;
    // projectile AP per angle band; the 3D shader colours each pixel by its own impact angle
    // explosions ignore angle, so with explosions on a part counts as hurt if either AP beats it
    const exAp = state.explosion && m?.explosion ? m.explosion.ap ?? -1 : -1;
    const ap4 = m ? ANGLE_BANDS.map((_, b) => Math.max(m.explosionOnly ? -1 : apFor(m, b), exAp)) : null;
    window.dispatchEvent(new CustomEvent('hd2:update', { detail: {
      shrapnel: m?.shrapnel && state.explosion ? { count: m.shrapnel.count, spread: m.shrapnel.spread, range: blastRadii(m)?.outer || 7 } : null,
      enemy: e, colors, gone, goneInst, hitHp, fire: state.fire, stageView: state.stageView,
      colorMode: state.color, ap4, avs: e.parts.map((p) => p.av), bands: ANGLE_BANDS,
      hit: state.hit, blast: state.hit?.ricochet ? null : blastRadii(m), radii: blastRadii(m), explosive: !!(blastRadii(m) || (m?.shrapnel && state.explosion)),
    } }));
  }

  function partClick(i, hit, k) {
    if (state.fire) fireAt(i, hit, k);
  }

  /* ---------------- tooltip ---------------- */

  function showTip(i, x, y, hit) {
    const e = enemy();
    const w = weapon();
    const part = e.parts[i];
    if (!part) return;
    const band = hit ? bandOf(hit.deg) : state.band;
    const mode = w ? w.modes[state.mode] || w.modes[0] : null;
    const r = w ? evalEnemy(w, state.mode, e, { ...opts(), band })[i].r : null;
    const pc = r ? penClass(r, part) : null;
    let verdict = '';
    if (r) {
      if (pc === 'immune') verdict = 'This zone cannot be damaged.';
      else if (r.ttk != null && r.kind !== 'shot') verdict = `Kills in <b>${fmtTime(r.ttk)}</b> (${r.kind === 'beam' ? 'continuous beam' : esc(r.why)}).`;
      else if (r.strip && r.killAt) verdict = `Kills in <b>${r.killAt}</b> shots${r.ttk != null ? ` (<b>${fmtTime(r.ttk)}</b>)` : ''}: <b>${r.strip.shots}</b> to break ${esc(r.strip.part)}, then ${r.killAt - r.strip.shots} into ${esc(part.name)}. Armor damage to Main counts.`;
      else if (isOneShot(r)) verdict = `<b>One shot</b> kill (${fmt(r.total)} dmg)${r.downs ? ' — downs it' : part.fatal === true && r.breakAt === 1 ? ' by destroying this part' : ''}.`;
      else if (r.killAt) verdict = `Kills in <b>${r.killAt}</b> shot${r.killAt > 1 ? 's' : ''}${r.ttk != null ? ` (<b>${fmtTime(r.ttk)}</b>)` : ''}${r.downs ? ' (downs it)' : r.breakAt === r.killAt && part.fatal === true ? ' by destroying this part' : ' via Main health'}.`;
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
    if (state.dist !== DEFAULT_RANGE) p.set('d', state.dist);
    if (state.view !== 'all') p.set('v', state.view);
    if (state.color !== 'pen') p.set('c', state.color);
    if (state.stagePinned) p.set('s', state.stageView);
    if (state.showInner) p.set('in', '1');
    if (!state.fire) p.set('f', '0');
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
    state.dist = p.has('d') ? Math.min(200, Math.max(0, +p.get('d') || 0)) : DEFAULT_RANGE;
    if (['front', 'side', 'rear'].includes(p.get('v'))) state.view = p.get('v');
    if (p.get('c') === 'ttk') state.color = 'ttk';
    state.showInner = p.get('in') === '1';
    state.fire = p.get('f') !== '0';
    if (p.has('s')) { state.stageView = p.get('s') === '3d' ? '3d' : 'map'; state.stagePinned = true; }
  }

  /* ---------------- wiring ---------------- */

  let lastTabKey = null; // rankings are rebuilt only when their inputs change

  function render(keepCard) {
    renderFactionTabs();
    renderEnemyList();
    renderCatTabs();
    renderWeaponList();
    if (!keepCard) renderWeaponCard();
    else if (weapon()) { // dragging the range slider: refresh only its caption so the drag isn't interrupted
      const m = weapon().modes[state.mode] || weapon().modes[0];
      const cap = $('#distSlider')?.parentElement.querySelector('.ap-caption');
      if (cap && m.ballistics?.drag) cap.innerHTML = `Projectile damage at ${state.dist} m: <b>${Math.round(rangeMult(m, state.dist) * 100)}%</b> (drag falloff)`;
    }
    renderStage();
    $$('#viewTabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
    $$('#colorTabs button').forEach((b) => b.classList.toggle('on', b.dataset.color === state.color));
    $$('#bottomTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
    $('#partsTableWrap').classList.toggle('hidden', state.tab !== 'parts');
    $('#rankTableWrap').classList.toggle('hidden', state.tab !== 'rank');
    $('#realTableWrap').classList.toggle('hidden', state.tab !== 'real');
    $$('#stageTabs button').forEach((b) => b.classList.toggle('on', b.dataset.sv === state.stageView));
    const hasInner = enemy()?.parts.some((p) => p.hidden || p.coveredBy);
    $('#innerBtn').classList.toggle('hidden', !hasInner);
    $('#innerBtn').classList.toggle('on', state.showInner);
    $('#innerBtn').textContent = state.showInner ? 'Covered parts: exposed' : 'Covered parts: hidden';
    $('#schematic').classList.toggle('hidden', state.stageView !== 'map');
    $('#viewer3d').classList.toggle('hidden', state.stageView !== '3d');
    writeHash();
  }

  let distTimer = null;
  function bind() {
    $('#factionTabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      state.faction = b.dataset.f || null; render();
    });
    $('#catTabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      state.cat = b.dataset.c || null; render();
    });
    $('#enemySearch').addEventListener('input', renderEnemyList);
    $('#weaponSearch').addEventListener('input', renderWeaponList);
    $('#enemyList').addEventListener('click', (ev) => {
      const card = ev.target.closest('li[data-f]');
      if (card) { state.faction = card.dataset.f; render(); return; }
      const li = ev.target.closest('li[data-id]'); if (!li) return;
      state.enemyId = li.dataset.id; state.hit = null;
      state.faction = enemyById(li.dataset.id).faction;
      if ($('#enemySearch').value) $('#enemySearch').value = '';
      resetSim(); autoStageView(); render();
    });
    $('#weaponList').addEventListener('click', (ev) => {
      const card = ev.target.closest('li[data-c]');
      if (card) { state.cat = card.dataset.c; render(); return; }
      const li = ev.target.closest('li[data-id]'); if (!li) return;
      state.weaponId = li.dataset.id; state.mode = 0;
      state.cat = weaponById(li.dataset.id).category;
      if ($('#weaponSearch').value) $('#weaponSearch').value = '';
      swapWeapon(); render();
    });
    $('#weaponCard').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-band]'); if (!b) return;
      state.band = +b.dataset.band; render();
    });
    $('#weaponCard').addEventListener('input', (ev) => {
      if (ev.target.id !== 'distSlider') return;
      state.dist = +ev.target.value;
      $('#distVal').textContent = state.dist + ' m';
      clearTimeout(distTimer);
      distTimer = setTimeout(() => render(true), 120);
    });
    $('#weaponCard').addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.id === 'modeSel') state.mode = +t.value;
      if (t.id === 'exChk') state.explosion = t.checked;
      if (t.id === 'pelChk') state.allPellets = t.checked;
      if (t.id === 'shrapChk') state.allShrap = t.checked;
      swapWeapon();
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
    const pickRow = (ev) => {
      const tr = ev.target.closest('tr[data-w]'); if (!tr) return;
      state.weaponId = tr.dataset.w; state.mode = +tr.dataset.m; state.cat = weaponById(tr.dataset.w).category;
      state.tab = 'parts'; render();
      scrollTo({ top: 0, behavior: 'smooth' });
    };
    $('#rankTable').addEventListener('click', pickRow);
    $('#realTable').addEventListener('click', pickRow);

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
      if (n) partClick(+n.dataset.i, null, n.dataset.k != null ? +n.dataset.k : undefined);
    });
    clickHost('#schematic');
    clickHost('#partsTable');

    $('#fireBtn').addEventListener('click', () => { state.fire = !state.fire; resetSim(); render(); });
    $('#innerBtn').addEventListener('click', () => { state.showInner = !state.showInner; render(); });
    $('.stage').addEventListener('click', (ev) => {
      if (ev.target.closest('#resetSim, #resetSim2')) { resetSim(); state.hit = null; render(); } // clears the shot ray, panel and health card too
      if (ev.target.closest('#shotClose')) { state.hit = null; render(); }
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
    if (state.enemyId) state.faction = enemyById(state.enemyId).faction; // shared link: open its faction
    if (state.weaponId) state.cat = weaponById(state.weaponId).category;
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
    enemy, tip: showTip, hideTip, click: partClick, hit: placeHit,
    refresh: () => render(),
  };
  init();
})();
