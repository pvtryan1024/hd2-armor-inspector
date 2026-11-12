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
  const EDITOR = ['localhost', '127.0.0.1'].includes(location.hostname) || /[?&]edit\b/.test(location.search);
  const MAX_SHOTS = 999;
  const DEFAULT_RANGE = 20; // metres; the baseline engagement distance for drag falloff
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
  const SLOTS = ['Primary', 'Secondary', 'Throwable', 'Support']; // the loadout box
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
    rankCat: null, // ranking tabs: only this weapon category (null = all)
    slot: null, // highlighted loadout slot
    loadout: loadLoadout(), // { Primary: weaponId, Secondary, Throwable, Support }
    charge: {}, // charge weapons: { weaponId: seconds } (missing = full charge)
  };

  /* ---------- charge weapons (Epoch, Purifier, Railgun, Loyalist): a charge-time slider replaces the mode list ---------- */
  // w.charge (data/charge.json): { min, max, points: [[s, mult]], steps: [{ at, mode, ref }] }. The weapon keeps its
  // wiki modes in w.chargeModes; w.modes becomes one mode rebuilt for the chosen charge time, so every view uses it.
  const chargeOf = (w) => (w && w.charge ? state.charge[w.id] ?? w.charge.max : null);
  function chargeMult(c, t) {
    const p = c.points;
    if (t <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) {
      if (t <= p[i][0]) { const [t0, m0] = p[i - 1], [t1, m1] = p[i]; return m0 + (m1 - m0) * (t - t0) / (t1 - t0); }
    }
    return p[p.length - 1][1];
  }
  function chargeMode(w, t) {
    const c = w.charge;
    const step = c.steps.filter((x) => t >= x.at - 1e-9).pop() || c.steps[0];
    const base = w.chargeModes.find((m) => m.name === step.mode);
    const mult = chargeMult(c, t), k = mult / step.ref;
    return { ...base, name: `${t.toFixed(2)} s`, damage: base.damage * k, durable: (base.durable ?? base.damage) * k, chargeTime: t, chargeMult: mult, chargeStep: step.mode };
  }
  function setCharge(w, t) {
    if (!w || !w.charge) return;
    t = Math.min(w.charge.max, Math.max(w.charge.min, Math.round(t * 100) / 100));
    if (t === w.charge.max) delete state.charge[w.id]; else state.charge[w.id] = t;
    w.modes = [chargeMode(w, t)];
  }

  DATA.weapons.forEach((w) => { if (w.charge) { w.chargeModes = w.modes; setCharge(w, w.charge.max); } });

  /* ---------- loadout: one weapon per slot, remembered in this browser ---------- */
  function loadLoadout() {
    try { const v = JSON.parse(localStorage.getItem('hd2-loadout') || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }
  function saveLoadout() { try { localStorage.setItem('hd2-loadout', JSON.stringify(state.loadout)); } catch { /* storage blocked */ } }
  /** Pick a weapon (list, rankings): it becomes the current one and fills its category's loadout slot. */
  function chooseWeapon(id, mode = 0) {
    const w = weaponById(id);
    if (!w) return;
    state.weaponId = id; state.mode = mode; state.cat = w.category;
    if (SLOTS.includes(w.category)) { state.loadout[w.category] = id; state.slot = w.category; saveLoadout(); }
  }

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

  /** Every explosion a mode sets off at once (the Solo Silo: an impact blast and the main blast). */
  const exList = (mode) => (mode?.explosion ? [mode.explosion, ...(mode.extraExplosions || [])] : []);

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

    let partEx = 0, exMult = null;
    const mainExBy = []; // Main's redirected share, per explosion (each blast gives it once)
    // an explosive round that ricochets doesn't go off (explosion-only weapons always do)
    const ricochet = !mode.explosionOnly && !mode.proximity && !opts.noProj && (mode.damage || 0) > 0 && !m;
    if (opts.explosion && !ricochet) exList(mode).forEach((ex, j) => {
      mainExBy[j] = 0;
      if (!(ex.damage || ex.durable)) return;
      const blast = blastAt(ex, opts.exDist || 0);
      const e = (ex.durable ?? ex.damage) * blast.mult;
      const pm = blast.mult > 0 ? penMult(blast.ap, part.av) : 0;
      if (pm != null && (exMult == null || pm > exMult)) exMult = pm;
      const exdr = part.exdr ?? 0;
      partEx += pm == null ? 0 : Math.floor(e * (1 - exdr) * pm);
      // redirected share skips Main's ExDR but still needs AP ≥ Main's AV
      const main = mainPart(enemy);
      if (blast.mult > 0 && !isMainRow(part) && (!main || blast.ap >= main.av)) mainExBy[j] = Math.floor(e * exdr);
    });
    const mainEx = mainExBy.reduce((x, y) => x + y, 0);
    // demolition: a structure part (the Fabricator) is destroyed outright by enough demolition force, from the
    // round itself (direct hit) or an explosion that reaches it; demolitionBlast parts (its vents) only by explosions
    let demo = false;
    if (part.demolition && !ricochet) {
      if (!part.demolitionBlast && !opts.noProj && !mode.explosionOnly && m != null && (mode.demolition || 0) >= part.demolition) demo = true;
      // demolitionInside (the vents): the explosion has to go off inside the part. The 3D view says which parts
      // the blast centre is inside (opts.inside); without a position (body map, tables) aiming at the part
      // means getting the explosive in, so a direct hit counts
      const inside = !part.demolitionInside || (opts.inside ? opts.inside.includes(part.name) : !opts.noProj && !opts.exDist);
      if (opts.explosion && inside) for (const ex of exList(mode)) if ((ex.demolition || 0) >= part.demolition && blastAt(ex, opts.exDist || 0).mult > 0) demo = true;
    }
    // throwKill (the Vox Engine's open hatches): any throwable landing on it or going off inside it kills
    if (part.throwKill && mode.throwable && (opts.inside ? opts.inside.includes(part.name) : true)) demo = 'throw';
    let shrap = 0;
    if (mode.shrapnel && opts.allShrap && !opts.noProj && !opts.noShrap && !ricochet && opts.explosion !== false) {
      const f = shotDamage(shrapnelMode(mode), part, enemy, { ...opts, noShrap: true, explosion: false });
      shrap = f.proj * mode.shrapnel.count;
    }
    return { proj: proj + shrap, partEx, mainEx, mainExBy, demo, pen: opts.noProj ? null : m, exPen: exMult, total: proj + shrap + partEx, ap, range: rangeMult(mode, opts.dist), ricochet, shrap };
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
  /** The piece repeated shots go to: the first one still standing. Where breaking every piece kills (Hulk legs),
   *  move on to a piece that still has health once this one is broken, rather than shooting through its constitution. */
  const nextPiece = (p, inst) => { const up = p.killAllBroken ? inst.findIndex((h) => h > 0) : -1; return up >= 0 ? up : inst.findIndex((h) => !instGone(p, h)); };
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
    if (s.demo && part.fatal) {
      sim.dead = { how: 'killed', why: s.demo === 'throw' ? 'a throwable went off inside an open hatch' : `${part.name} destroyed by demolition force`, idx };
      return Object.assign(out, { progress: true, broke: true });
    }
    const mi = mainIndexFor(enemy, idx);
    const toMain = part.toMain ?? 0; // "-" on the wiki: nothing reaches Main (shields, jetpacks, mounted guns)

    if (mi === idx) {
      out.toMain = s.total;
    } else if (sim.hp[idx] == null) {
      out.toMain = s.total * toMain + s.mainEx;
    } else {
      const inst = sim.hp[idx];
      const cons = consOf(part);
      const k = want != null ? (instGone(part, inst[want]) ? -1 : want) : nextPiece(part, inst);
      if (k >= 0) {
        const wasUp = inst[k] > 0;
        const capped = part.overflow ? s.total : Math.min(s.total, inst[k] + cons);
        out.toMain = capped * toMain + s.mainEx;
        if (part.indestructible) {
          if (out.toMain > 0) out.progress = true;
          return feedMain();
        }
        const wasGone = instGone(part, inst[k]);
        inst[k] -= s.total;
        if (s.total > 0) out.progress = true;
        // mainToOnGone (Hulk legs): shot through, the enemy is left hanging with Main at that much health
        if (!wasGone && instGone(part, inst[k])) out.gone = true; // hitbox gone (constitution used up too)
        if (part.mainToOnGone != null && out.gone) out.clampTo = part.mainToOnGone;
        // goneWith: parts whose hitbox goes with this piece (a Devastator's shoulder with its arm, the shield with
        // the arm holding it), without taking any damage
        if (out.gone) enemy.parts.forEach((q, qi) => {
          const gw = q.goneWith;
          if (!gw || gw.part !== part.name || !sim.hp[qi] || (gw.inst != null && gw.inst !== k)) return;
          // pieces: those pieces of it (the Overseer's left-arm plates); else the same piece, or its only one
          for (const j of gw.pieces || [gw.inst != null ? 0 : k]) {
            if (j >= sim.hp[qi].length || instGone(q, sim.hp[qi][j])) continue;
            sim.hp[qi][j] = -consOf(q) - 1;
            (out.alsoGone ||= []).push(pieceName(q, gw.inst != null && !gw.pieces ? undefined : j));
          }
        });
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
        // every piece broken (health gone, constitution or not) downs / kills it too: both Hulk legs kill
        if (!sim.dead && (part.downsAllBroken || part.killAllBroken) && inst.every((h) => h <= 0)) {
          const nm = part.name.replace(/\s*\(\d+\)$/, '');
          sim.dead = { how: part.killAllBroken ? 'killed' : 'downed', why: inst.length === 2 ? `both ${nm} broken` : `every ${nm} piece broken`, idx };
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
      // after this shot's own damage to Main: still alive, so Main drops to what's left hanging
      if (out.clampTo != null && !sim.dead && mi >= 0 && sim.pool[mi] != null && sim.pool[mi] > out.clampTo) {
        sim.pool[mi] = out.clampTo;
        sim.hanging = `Main left at ${fmt(out.clampTo)} HP`;
        out.progress = true;
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
    const k = inst ? (want != null ? want : nextPiece(part, inst)) : -1;
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
    out.gone = out.gone || o2.gone;
    if (o2.alsoGone) out.alsoGone = [...(out.alsoGone || []), ...o2.alsoGone];
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

  /** Log text for a piece this shot broke or destroyed: with constitution (Hulk legs) "broken" means its health
   *  is gone but it can still be hit; "destroyed" means the constitution is gone too. */
  const brokeNote = (p, k, o) => `${pieceName(p, k)} ${consOf(p) && !o.gone ? 'broken' : 'destroyed'}${o.alsoGone?.length ? ` (${o.alsoGone.join(', ')} gone with it)` : ''}`;
  /** Log text for a part that left Main hanging (once, then cleared). */
  const hangNote = (sim) => { const t = sim.hanging; sim.hanging = null; return t ? ` — ${t}` : ''; };
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
   *  shot: (shots − 1) × 60 / RPM, first shot at t = 0, plus a full reload for every magazine emptied
 *        (reloads = ceil(shots / mag) − 1, reload time from the weapon's wiki page); weapons that load one round
 *        at a time instead add one round's reload for every shot past the magazine
   *  beam: damage listed per second, applied in 0.1 s ticks
   *  dot:  flame / gas sprays; the burn or gas cloud hits Main only and must beat Main's AV */
  const BEAM_TICK = 0.1;
  function fireModel(weapon, mode) {
    if (mode.dot) return { kind: 'dot', ...mode.dot };
    if (mode.beam) return { kind: 'beam' };
    const rpm = mode.rpm ?? weapon.rpm;
    // a charged shot waits for its charge; a heat weapon (Quasar) waits out its cooldown between shots
    const t = weapon.cooldown || (rpm ? 60 / rpm : 0) + (mode.chargeTime || 0);
    // a mode with its own magazine (an underbarrel launcher or shotgun) also has its own reload
    const own = mode.mag != null;
    return { kind: 'shot', interval: t || null, rpm, mag: own ? mode.mag : weapon.mag, reload: own ? mode.reload : weapon.reload,
      reloadRound: own ? mode.reloadRound : weapon.reloadRound, ammoKey: own ? `${weapon.id}:${mode.name}` : weapon.id,
      burst: !own && weapon.burst && rpm ? weapon.burst : null };
  }

  /** Time for n shots: (n − 1) × interval + reloads × reload time. Without a fire interval it is only known when
   *  every gap is a reload (single-shot launchers). reloadUnknown: it needs a reload we have no time for. */
  function shotTime(weapon, fm, n) {
    if (n == null) return { t: null, reloads: 0 };
    if (n <= 1) return { t: 0, reloads: 0 };
    if (fm.reloadRound && fm.mag) { // round-by-round loading: one round's reload per shot past the magazine
      const rounds = Math.max(0, n - fm.mag);
      return fm.interval || !rounds ? { t: fm.interval ? (n - 1) * fm.interval + rounds * fm.reloadRound : null, reloads: rounds, rounds: true } : { t: null, reloads: rounds, rounds: true };
    }
    const reloads = fm.mag ? Math.max(0, Math.ceil(n / fm.mag) - 1) : 0;
    const rl = fm.reload;
    if (fm.burst) { // bursts: shots 60/RPM apart inside a burst, a charge before every burst after the first
      const g = 60 / fm.rpm, k = n - 1, b = Math.floor(k / fm.burst.size), j = k % fm.burst.size;
      const t = b * ((fm.burst.size - 1) * g + fm.burst.charge) + j * g;
      return reloads && !rl ? { t, reloads, reloadUnknown: true } : { t: t + reloads * (rl || 0), reloads };
    }
    if (reloads && !rl) return { t: fm.interval ? (n - 1) * fm.interval : null, reloads, reloadUnknown: true };
    if (fm.interval) return { t: (n - 1) * fm.interval + reloads * (rl || 0), reloads };
    return { t: n - 1 === reloads ? reloads * rl : null, reloads };
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
        const st = shotTime(weapon, fm, r.killAt);
        r.ttk = r.killAt == null ? null : st.t;
        r.reloads = st.reloads;
        r.roundReload = !!st.rounds;
        r.reload = !!st.reloadUnknown; // needs more than one magazine and the reload time is unknown (*)
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
  const reloadsLabel = (r) => (r.reload ? ' +reload' : !r.reloads ? '' : r.roundReload ? ` · ${r.reloads} round${r.reloads > 1 ? 's' : ''} loaded` : ` · ${r.reloads} reload${r.reloads > 1 ? 's' : ''}`);
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
      // coverPieces: the plates over each piece, listed (the Overseer's limbs)
      // (coverAll: every one of them has to be gone: the Vox Engine's hatch lid opens once all its vents are)
      if (p.coverPieces) { const list = p.coverPieces[k ?? 0] || []; return p.coverAll ? list.every((j) => instGone(enemy.parts[ci], hp[j])) : list.some((j) => hp[j] <= 0); }
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

  /* Difficulty variants: the wiki lists some enemies' stats per difficulty (Warrior / Hunter health from
   * Challenging up, Caustic Spewer armor from Extreme up). Those enemies get e.variants [weaker, stronger];
   * the stronger one is the default, and e.parts is whichever is picked. */
  const VARIANT_FIELDS = [
    { key: 'healthChallenging', field: 'health', weak: 'Weaker: Trivial–Medium', strong: 'Stronger: Challenging and up' },
    { key: 'avExtreme', field: 'av', weak: 'Weaker: Medium–Hard', strong: 'Stronger: Extreme and up' },
  ];
  function setupVariants() {
    for (const e of DATA.enemies) {
      const vf = VARIANT_FIELDS.find((v) => e.parts.some((p) => p[v.key] != null));
      if (!vf) continue;
      const strong = e.parts.map((p) => (p[vf.key] != null ? { ...p, [vf.field]: p[vf.key] } : { ...p }));
      e.variants = [{ label: vf.weak, parts: e.parts }, { label: vf.strong, parts: strong }];
      setVariant(e, 1);
    }
  }
  function setVariant(e, i) {
    if (!e?.variants?.[i]) return;
    e.variant = i;
    e.parts = e.variants[i].parts;
  }
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
        <div class="stat"><div class="k">Damage</div><div class="v" id="statDmg">${fmt(m.damage)}</div></div>
        <div class="stat"><div class="k">Durable</div><div class="v" id="statDur">${fmt(m.durable)}</div></div>
        <div class="stat"><div class="k">AP</div><div class="v">${ap}</div></div>
        ${pellets > 1 ? `<div class="stat"><div class="k">Pellets</div><div class="v">${pellets}</div></div>` : ''}
        ${m.rpm ?? w.rpm ? `<div class="stat"><div class="k">RPM</div><div class="v">${fmt(m.rpm ?? w.rpm)}</div></div>` : ''}
        ${w.cooldown ? `<div class="stat"><div class="k">Cooldown</div><div class="v">${w.cooldown} s</div></div>` : ''}
        ${m.mag ?? w.mag ? `<div class="stat"><div class="k">Mag</div><div class="v">${fmt(m.mag ?? w.mag)}</div></div>` : ''}
        ${exList(m).map((x, j, all) => { const n = all.length > 1 ? ` ${j + 1}` : ''; return `
          ${(x.inner ?? x.innerRadius) != null ? `<div class="stat"><div class="k">Radius${n}</div><div class="v">${x.inner ?? x.innerRadius}/${x.outer ?? x.outerRadius ?? '?'}m</div></div>` : ''}
          <div class="stat"><div class="k">Expl.${n} dmg</div><div class="v">${fmt(x.durable ?? x.damage)}</div></div>
          <div class="stat"><div class="k">Expl.${n} AP</div><div class="v">${x.ap ?? '—'}</div></div>`; }).join('')}
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
      ${w.charge ? `<div class="range charge">
        <label class="opt">Charge time <b id="chargeVal">${m.chargeTime.toFixed(2)} s</b></label>
        <input type="range" id="chargeSlider" min="${w.charge.min}" max="${w.charge.max}" step="0.01" value="${m.chargeTime}">
        <div class="ap-caption"><span>Projectile damage multiplier:</span> <b id="chargeMult">×${m.chargeMult.toFixed(2)}</b> · <span>Fires:</span> <b>${esc(m.chargeStep)}</b></div>
        <p class="note">${esc(w.charge.note || '')}</p>
      </div>` : ''}
      <div class="opts">
        ${w.modes.length > 1 ? `<label class="opt">Ammo / mode
          <select id="modeSel">${w.modes.map((mm, i) => `<option value="${i}" ${i === state.mode ? 'selected' : ''}>${esc(mm.name || 'Mode ' + (i + 1))}</option>`).join('')}</select></label>` : ''}
        ${ex ? `<label class="opt">Include explosion (direct hit) <input type="checkbox" id="exChk" ${state.explosion ? 'checked' : ''}></label>` : ''}
        ${pellets > 1 ? `<label class="opt">All ${pellets} pellets hit <input type="checkbox" id="pelChk" ${state.allPellets ? 'checked' : ''}></label>` : ''}
        ${m.shrapnel ? `<label class="opt" title="Body map and time to kill: count every fragment on the struck part (an upper bound). The 3D view traces each fragment instead.">All ${m.shrapnel.count} shrapnel hit the part <input type="checkbox" id="shrapChk" ${state.allShrap ? 'checked' : ''}></label>` : ''}
      </div>
      ${!w.charge && (m.note || w.note) ? `<p class="note">${esc(m.note || w.note)}</p>` : ''}
    `;
  }

  /* ---------------- rendering: stage ---------------- */

  function renderStage() {
    const e = enemy();
    const w = weapon();
    if (!e) return;
    $('#enemyName').textContent = e.name;
    const vsel = $('#enemyVariant');
    vsel.hidden = !e.variants;
    if (e.variants) {
      const html = e.variants.map((v, i) => `<option value="${i}"${i === e.variant ? ' selected' : ''}>${esc(v.label)}</option>`).join('');
      if (vsel.dataset.for !== e.id) { vsel.innerHTML = html; vsel.dataset.for = e.id; }
      vsel.value = String(e.variant);
    }
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
    const tabKey = JSON.stringify([state.tab, e.id, e.variant, state.view, state.showInner, state.explosion, state.allPellets, state.band, state.dist, state.weaponId, state.rankCat, state.charge]);
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
              small = isOneShot(r) ? `${fmt(r.total)} dmg` : r.ttk != null ? shotsLabel(r) + reloadsLabel(r) : r.killAt ? 'shots (no RPM)' : r.breakAt ? `breaks ${r.breakAt}` : 'no kill';
            }
          }
          let left = state.fire ? partLeft(i) : null;
          if (left && inst != null && left.segs) {
            const c = left.csegs?.[inst];
            left = { ...left, frac: left.segs[inst], segs: [left.segs[inst]], csegs: [c], gone: left.gones[inst],
              label: left.segs[inst] > 0 ? (part.indestructible ? 'Indestructible' : `${fmt(left.segs[inst] * part.health)} HP left`)
                : c > 0 ? `Broken · ${fmt(c * part.cons)} constitution left` : 'Destroyed' };
          }
          const fatal = part.killAllBroken ? '<span class="fatal" title="Breaking every piece kills">☠ all broken</span>' : part.fatal === true ? '<span class="fatal" title="Destroying this kills">☠ fatal</span>' : part.fatal === 'downs' ? '<span class="fatal" title="Destroying this downs the enemy">☠ downs</span>' : '';
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
        <span class="muted">From RPM; first shot at 0 s, plus reloads</span>
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
            <td class="num"><b>${ttkHtml(r)}${r.reload ? '<span class="muted" title="More shots than one magazine; reload time unknown">*</span>' : ''}</b>${r.reloads && !r.reload ? `<div class="muted small">${reloadsLabel(r).replace(' · ', '')}</div>` : ''}</td>` : ''}
        </tr>`;
      })
      .join('');
    $('#partsTable').innerHTML = head + `<tbody>${rows}</tbody>`;
  }

  function renderLoadout() {
    $('#loadout').innerHTML = SLOTS.map((cat) => {
      const w = weaponById(state.loadout[cat]);
      return `<button type="button" class="slot ${state.slot === cat ? 'on' : ''}" data-slot="${esc(cat)}" title="${esc(w ? w.name : cat)}">
        ${w ? weaponThumbHtml(w) : '<span class="slot-empty">+</span>'}
        <span class="slot-cat">${esc(cat)}</span>
        ${w ? `<span class="slot-name">${esc(w.name)}</span>` : ''}
      </button>`;
    }).join('');
  }
  /** Ranking tabs: a weapon-category filter (All, Primary, …). */
  function renderRankCats() {
    const el = $('#rankCats');
    el.classList.toggle('hidden', state.tab !== 'rank' && state.tab !== 'real');
    const cats = CAT_ORDER.filter((c) => DATA.weapons.some((w) => w.category === c));
    el.innerHTML = [null, ...cats].map((c) => `<button type="button" data-rc="${esc(c || '')}" class="${(state.rankCat || null) === c ? 'on' : ''}">${esc(c || 'All')}</button>`).join('');
  }
  const rankWeapons = () => DATA.weapons.filter((w) => !state.rankCat || w.category === state.rankCat);

  /** Both ranking tables face the enemy from the front: rear-only and hard-to-reach hitzones don't count. */
  const frontal = (results) => results.filter((x) => visible(x.part, 'front') && x.part.hidden !== 'angle');
  /** Best kill from any side (hard-to-reach parts included): how weapons that can't kill from the front are ordered. */
  const anySide = (results) => bestOf(results.map((x) => (x.part.hidden === 'angle' ? { ...x, part: { ...x.part, hidden: false } } : x)), 'all');
  const better = (b, best) => b && (!best || killKey(b.r) < killKey(best.b.r) || (killKey(b.r) === killKey(best.b.r) && b.r.total > best.b.r.total));

  function renderRankTable(e) {
    const o = opts();
    const rows = [];
    for (const w of rankWeapons()) {
      let best = null, any = null;
      w.modes.forEach((m, mi) => {
        const res = evalEnemy(w, mi, e, o);
        const b = bestOf(frontal(res), 'front');
        if (better(b, best)) best = { b, mi };
        const a = anySide(res);
        if (better(a, any)) any = { b: a, mi };
      });
      rows.push({ w, best, any: best ? null : any });
    }
    const one = (x) => (x.best && isOneShot(x.best.b.r) ? 0 : 1);
    rows.sort((a, b) => (a.best ? 0 : 1) - (b.best ? 0 : 1)
      || (!a.best ? (a.any ? killKey(a.any.b.r) : 1e9) - (b.any ? killKey(b.any.b.r) : 1e9) : 0)
      || one(a) - one(b)
      || (one(a) === 0 ? b.best.b.r.total - a.best.b.r.total : 0)
      || (a.best ? killKey(a.best.b.r) : 1e9) - (b.best ? killKey(b.best.b.r) : 1e9)
      || (b.best?.b.r.total ?? 0) - (a.best?.b.r.total ?? 0));
    $('#rankTable').innerHTML = `<thead><tr><th>#</th><th>Weapon</th><th>Category</th><th>Mode</th><th>Best hitzone</th><th class="num">Dmg/shot</th><th class="num">Shots</th><th class="num">Time to kill</th></tr></thead><tbody>` +
      rows
        .map(({ w, best, any }, i) => `<tr class="click ${w.id === state.weaponId ? 'hl' : ''}" data-w="${esc(w.id)}" data-m="${best ? best.mi : any ? any.mi : 0}">
          <td class="num muted">${best ? i + 1 : ''}</td>
          <td>${esc(w.name)}</td><td class="muted">${esc(w.category)}</td>
          <td class="muted">${best && w.modes.length > 1 ? esc(w.modes[best.mi].name) : ''}</td>
          <td>${best ? esc(best.b.part.name) : any ? `<span class="muted">Can’t kill from the front</span> · ${esc(any.b.part.name)} <span class="muted">${isOneShot(any.b.r) ? ONE_SHOT : any.b.r.ttk != null ? fmtTime(any.b.r.ttk) : shotsLabel(any.b.r)}</span>` : '<span class="muted">Can’t kill</span>'}</td>
          <td class="num">${best ? fmt(best.b.r.total) : '—'}</td>
          <td class="num">${best ? shotsLabel(best.b.r) : '—'}</td>
          <td class="num"><b style="color:${best ? ttkColor(killKey(best.b.r)) : 'var(--dim)'}">${best ? ttkHtml(best.b.r) : '—'}${best?.b.r.reload ? '*' : ''}</b></td>
        </tr>`)
        .join('') + '</tbody>';
  }

  /** Fastest and slowest kill over every reachable, killing hitzone in view, and their midpoint.
   *  Times when the weapon has them; otherwise shot counts (ranked after timed weapons). */
  const WORST_X = 4; // real-life worst case when some reachable hitzone can't be damaged: this many × the best case
  const LEAN = 0.75; // real life sits this far from the best case toward the worst
  const lean = (a, b) => a + (b - a) * LEAN;
  function spreadOf(results, view, w, mode) {
    const reach = frontal(results).filter((x) => !x.part.hidden || state.showInner);
    const ok = reach.filter((x) => killKey(x.r) != null);
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
    // worst case: a reachable hitzone this weapon can't damage at all (you miss the weak points); a made-up rule:
    // it then takes WORST_X × the best case's shots (× its time for beams and sprays)
    const blocked = reach.filter((x) => !isMainRow(x.part) && x.part.av >= 0 && x.part.av < 11 && !(x.r.total > 0) && !(x.r.mainEx > 0));
    if (blocked.length && w && mode) {
      const big = blocked.reduce((a, x) => ((typeof x.part.health === 'number' ? x.part.health : 0) > (typeof a.part.health === 'number' ? a.part.health : 0) ? x : a));
      const fm = fireModel(w, mode);
      const shots = lo.r.killAt != null ? lo.r.killAt * WORST_X : null;
      const st = shots != null ? shotTime(w, fm, shots) : null;
      const ttk = shots != null ? st.t : lo.r.ttk != null ? lo.r.ttk * WORST_X : null;
      const worst = { part: big.part, r: { kind: lo.r.kind, killAt: shots, ttk, total: 0, reloads: st?.reloads || 0, roundReload: !!st?.rounds, reload: !!st?.reloadUnknown }, x3: true };
      const t2 = timed && ttk != null;
      const v = (x) => (t2 ? x.r.ttk : x.r.killAt);
      if (t2 || (shots != null && lo.r.killAt != null)) return { lo, hi: worst, mid: lean(v(lo), v(worst)), timed: t2, n: zones.length };
    }
    return { lo, hi, mid: lean(val(lo), val(hi)), timed, n: zones.length };
  }

  function renderRealTable(e) {
    const o = opts();
    const rows = [];
    for (const w of rankWeapons()) {
      let best = null, any = null;
      w.modes.forEach((m, mi) => {
        const res = evalEnemy(w, mi, e, o);
        const a = anySide(res);
        if (better(a, any)) any = { b: a, mi };
        const sp = spreadOf(res, 'front', w, m);
        if (!sp) return;
        const key = sp.timed ? sp.mid : 1e4 + sp.mid;
        if (!best || key < best.key) best = { ...sp, mi, key };
      });
      rows.push({ w, best, any: best ? null : any });
    }
    // can't kill from the front: "almost impossible", last, by their best time from any side;
    // ties (e.g. one-shots everywhere) go to the harder-hitting weapon
    const impKey = (x) => (x.any ? killKey(x.any.b.r) : 1e9);
    rows.sort((a, b) => (a.best ? 0 : 1) - (b.best ? 0 : 1)
      || (a.best ? a.best.key - b.best.key : impKey(a) - impKey(b))
      || (b.best?.hi.r.total ?? 0) - (a.best?.hi.r.total ?? 0));
    const val = (sp, x) => (isOneShot(x.r) ? ONE_SHOT : sp.timed ? fmtTime(x.r.ttk) : shotsLabel(x.r));
    const mid = (sp) => {
      if (isOneShot(sp.lo.r) && isOneShot(sp.hi.r)) return ONE_SHOT;
      return sp.timed ? fmtTime(sp.mid) : `~${Math.ceil(sp.mid)} shots`;
    };
    $('#realTable').innerHTML = `<thead><tr><th>#</th><th>Weapon</th><th>Category</th><th>Mode</th>
        <th>Fastest</th><th class="num">TTK</th><th>Slowest</th><th class="num">TTK</th><th class="num">Real life</th></tr></thead><tbody>` +
      rows.map(({ w, best: sp, any }, i) => `<tr class="click ${w.id === state.weaponId ? 'hl' : ''}" data-w="${esc(w.id)}" data-m="${sp ? sp.mi : any ? any.mi : 0}">
          <td class="num muted">${sp ? i + 1 : ''}</td>
          <td>${esc(w.name)}</td><td class="muted">${esc(w.category)}</td>
          <td class="muted">${sp && w.modes.length > 1 ? esc(w.modes[sp.mi].name) : ''}</td>
          ${sp ? `<td>${esc(sp.lo.part.name)}</td><td class="num">${val(sp, sp.lo)}</td>
            <td>${esc(sp.hi.part.name)}${sp.hi.x3 ? ` <span class="muted" title="This weapon can’t damage it: worst case = ${WORST_X}× the best case">(no damage: ${WORST_X}×)</span>` : ''}</td><td class="num">${val(sp, sp.hi)}</td>
            <td class="num"><b style="color:${ttkColor(sp.key)}">${mid(sp)}</b></td>`
          : any ? `<td>${esc(any.b.part.name)} <span class="muted">(not from the front)</span></td><td class="num">${isOneShot(any.b.r) ? ONE_SHOT : any.b.r.ttk != null ? fmtTime(any.b.r.ttk) : shotsLabel(any.b.r)}</td><td></td><td></td><td class="num"><b style="color:var(--dim)">Almost impossible</b></td>`
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
    sim.log.unshift(`— switched to ${w.name}${w.modes.length > 1 || w.charge ? ` (${(w.modes[state.mode] || w.modes[0]).name})` : ''} —`);
    sim.log.length = Math.min(sim.log.length, 8);
  }
  /** Before each fired shot: advance the clock by the weapon's fire interval and note which weapon fired. */
  function shotClock() {
    const sim = state.sim, w = weapon();
    const key = `${w.id}:${state.mode}:${chargeOf(w) ?? ''}`;
    const fm = fireModel(w, w.modes[state.mode] || w.modes[0]);
    if (fm?.kind === 'dot') sim.time += DOT_CLICK; // a flame / gas click is a second of spraying
    else if (sim.last === key && fm?.burst) { // burst weapon: a charge before each new burst
      sim.burstN = (sim.burstN || 0) + 1;
      sim.time += sim.burstN % fm.burst.size === 0 ? fm.burst.charge : 60 / fm.rpm;
    } else if (sim.last === key) sim.time += fm && fm.kind === 'shot' && fm.interval ? fm.interval : 0;
    if (sim.last !== key) sim.burstN = 0;
    if (fm?.kind === 'shot' && fm.mag && (fm.reload || fm.reloadRound)) { // a reload once the magazine is empty (each magazine its own)
      sim.ammo ||= {};
      const ak = fm.ammoKey;
      if ((sim.ammo[ak] || 0) >= fm.mag) {
        if (fm.reloadRound) sim.time += fm.reloadRound; // load just the one round for this shot
        else { sim.time += fm.reload; sim.ammo[ak] = 0; }
        sim.reloads = (sim.reloads || 0) + 1;
      }
      sim.ammo[ak] = (sim.ammo[ak] || 0) + 1;
    }
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
    state.sim.log.unshift(`#${state.sim.shots} ${tag}${label}${hit ? ` @ ${Math.round(hit.deg)}°` : ''}: ${s.total > 0 ? fmt(s.total) + ' dmg' : s.demo ? 'demolished' : s.ricochet ? 'ricochet' : 'no damage'}${o.toMain > 0 ? `, ${fmt(o.toMain)} to Main` : ''}${o.broke || o.gone ? ` — ${consOf(part) && !o.gone ? 'broken' : 'destroyed'}` : ''}${o.alsoGone?.length ? ` (${o.alsoGone.join(', ')} gone with it)` : ''}${hangNote(state.sim)}${underNote(e, o)}${dotNote}${thru ? ` → through into ${e.parts[thru.idx].name} (AP ${thru.ap}): ${fmt(thru.s.total)} dmg${o2.toMain > 0 ? `, ${fmt(o2.toMain)} to Main` : ''}${o2.broke ? ' — destroyed' : ''}` : ''}${state.sim.dead ? '' : forceNote(mode, e, s, state.explosion)}`);
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
  /** The blast's reach for the 3D view: the explosion that reaches furthest (its radii are drawn). */
  function blastRadii(mode) {
    if (!state.explosion) return null;
    let best = null;
    for (const ex of exList(mode)) {
      if (!(ex.damage || ex.durable)) continue;
      const inner = ex.inner ?? ex.innerRadius, outer = ex.outer ?? ex.outerRadius;
      if (inner == null && outer == null) continue;
      const r = { inner: inner ?? 0, outer: outer ?? inner, shockwave: ex.shockwave ?? null };
      if (!best || r.outer > best.outer) best = r;
    }
    return best;
  }

  /** Main takes each explosion's redirected share once: per explosion, only the row with the biggest share
   *  keeps it (ties: the first row, the struck piece or the nearest). */
  function onceMain(rows) {
    const n = Math.max(0, ...rows.map((r) => r.s.mainExBy?.length || 0));
    const keep = rows.map(() => []);
    for (let j = 0; j < n; j++) {
      const top = Math.max(0, ...rows.map((r) => r.s.mainExBy?.[j] || 0));
      const at = top > 0 ? rows.findIndex((r) => (r.s.mainExBy?.[j] || 0) === top) : -1;
      rows.forEach((r, i) => { keep[i][j] = i === at ? top : 0; });
    }
    rows.forEach((r, i) => { r.s = { ...r.s, mainExBy: keep[i], mainEx: keep[i].reduce((x, y) => x + y, 0) }; });
  }

  /** Damage from one shot at a 3D impact point: the struck part takes projectile + full blast, other parts
   *  inside the outer radius take falloff blast, and Main gets the redirected share only once per blast. */
  function resolveHit(hit) {
    const e = enemy(), w = weapon();
    if (!e || !w || !hit) return null;
    const mode = w.modes[state.mode] || w.modes[0];
    const band = bandOf(hit.deg);
    const o = { ...opts(), band, ...(hit.inside ? { inside: hit.inside } : {}) };
    if (hit.ground) return resolveGround(hit, mode, band, o);
    // a round that went off on a trigger plane (inside the Fabricator's vents): no impact, only its explosion
    const rows = [{ idx: hit.idx, dist: 0, direct: true, s: shotDamage(mode, e.parts[hit.idx], e, { ...o, exDist: 0, noShrap: true, ...(hit.detonate ? { noProj: true } : {}) }) }];
    // 3D shots: the next piece along the shot's path (hit.thru from the viewer), if the cleave rule lets it through
    const thru0 = hit.detonate ? null : overpen(mode, e, hit.idx, rows[0].s, o, 'thru' in hit ? hit.thru?.idx ?? null : undefined);
    const thru = thru0 ? { ...thru0, k: hit.thru?.k ?? null } : null;
    const radii = rows[0].s.ricochet ? null : blastRadii(mode); // a ricochet means no blast at all
    if (radii) {
      // pieces reached by the blast rays (3D view); the struck piece already took the full blast
      const reached = hit.blastHits || Object.entries(hit.parts || {}).map(([k, d]) => ({ idx: +k, k: null, d }));
      for (const b of reached) {
        if ((b.idx === hit.idx && (b.k == null || b.k === hit.k)) || b.d > radii.outer) continue;
        if (!blastReaches(e, b)) continue; // still under its plate
        const sx = shotDamage(mode, e.parts[b.idx], e, { ...o, noProj: true, exDist: b.d });
        rows.push({ idx: b.idx, k: b.k, dist: b.d, s: sx }); // listed even when the armor stops it
      }
      onceMain(rows);
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

  /** The 3D blast isn't stopped by the enemy's own plating (viewer3d blastHits), so a part still covered by
   *  armor (fire mode: its plate not broken yet) is left out here instead. */
  const blastReaches = (e, b) => !state.fire || !state.sim || isExposed(e, b.idx, state.sim, b.k);

  /** A shot into the ground next to the enemy (3D view): no part is struck, so only the explosion counts:
   *  every piece the blast rays reach takes falloff damage (Main's share once per blast), plus shrapnel. */
  function resolveGround(hit, mode, band, o) {
    const e = enemy();
    const radii = blastRadii(mode);
    const rows = [];
    if (radii) {
      for (const b of hit.blastHits || []) {
        if (b.d > radii.outer || !blastReaches(e, b)) continue;
        rows.push({ idx: b.idx, k: b.k, dist: b.d, s: shotDamage(mode, e.parts[b.idx], e, { ...o, noProj: true, exDist: b.d }) });
      }
      rows.sort((a, b) => a.dist - b.dist);
      onceMain(rows);
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
    state.hit = { ...state.hit, blast: res?.radii || null };
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
        if (o.broke || o.gone) notes.push(brokeNote(e.parts[r.idx], r.k, o));
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
    if (res) state.hit = { ...state.hit, ricochet: !!res.rows[0].s.ricochet, blast: res.radii || null };
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
        if (o.broke || o.gone) notes.push(brokeNote(e.parts[r.idx], piece, o));
        if (state.sim.hanging) notes.push(hangNote(state.sim).replace(/^ — /, ''));
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
      state.sim.log.unshift(`#${state.sim.shots} ${tag}${pieceName(e.parts[d.idx], hit.k)} @ ${Math.round(hit.deg)}°: ${d.s.total > 0 ? fmt(d.s.total) + ' dmg' : d.s.demo ? 'demolished' : d.s.ricochet ? 'ricochet' : 'no damage'}${(() => { const n = res.rows.slice(1).filter((r) => r.s.partEx > 0 || r.s.mainEx > 0).length; return n ? ` + blast on ${n} part${n > 1 ? 's' : ''}` : ''; })()}${notes.length ? ' — ' + notes.join(', ') : ''}${state.sim.dead ? '' : forceNote(res.mode || weapon().modes[state.mode] || weapon().modes[0], e, d.s, state.explosion)}`);
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
      // pieces with constitution whose health is gone but which still have a hitbox (Hulk legs): the 3D view
      // swaps in their damaged mesh
      brokenInst: e.parts.map((p, i) => (state.fire && consOf(p) && state.sim?.hp[i] ? state.sim.hp[i].map((h) => h <= 0 && !instGone(p, h)) : null)),
      enemy: e, colors, gone, goneInst, hitHp, fire: state.fire, stageView: state.stageView,
      colorMode: state.color, ap4, avs: e.parts.map((p) => p.av), bands: ANGLE_BANDS,
      hit: state.hit, blast: state.hit?.blast || null, radii: blastRadii(m), explosive: !!(blastRadii(m) || (m?.shrapnel && state.explosion)),
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
    if (enemy()?.variants && enemy().variant !== 1) p.set('ev', enemy().variant);
    if (state.mode) p.set('m', state.mode);
    if (weapon()?.charge && state.charge[state.weaponId] != null) p.set('ch', state.charge[state.weaponId]);
    if (!state.explosion) p.set('x', '0');
    if (!state.allPellets) p.set('p', '0');
    if (state.band) p.set('a', state.band);
    if (state.dist !== DEFAULT_RANGE) p.set('d', state.dist);
    if (state.view !== 'all') p.set('v', state.view);
    if (state.color !== 'pen') p.set('c', state.color);
    if (state.stagePinned) p.set('s', state.stageView);
    if (state.showInner) p.set('in', '1');
    if (!state.fire) p.set('f', '0');
    if (state.rankCat) p.set('rc', state.rankCat);
    const lang = new URLSearchParams(location.hash.slice(1)).get('lang'); // the language picker's (i18n.js)
    if (lang) p.set('lang', lang);
    history.replaceState(null, '', '#' + p.toString());
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('e') && enemyById(p.get('e'))) state.enemyId = p.get('e');
    if (p.get('w') && weaponById(p.get('w'))) state.weaponId = p.get('w');
    if (p.has('ev')) setVariant(enemyById(state.enemyId), +p.get('ev'));
    state.mode = +p.get('m') || 0;
    const cw = weaponById(state.weaponId);
    if (cw?.charge) {
      const old = p.has('m') ? cw.chargeModes[state.mode] : null; // a link from before the slider: m picked a charge mode
      const at = p.has('ch') ? +p.get('ch') : old ? cw.charge.steps.find((x) => x.mode === old.name)?.at : null;
      if (at != null && Number.isFinite(at)) setCharge(cw, at);
      state.mode = 0;
    }
    state.explosion = p.get('x') !== '0';
    state.allPellets = p.get('p') !== '0';
    state.band = Math.min(3, Math.max(0, +p.get('a') || 0));
    state.dist = p.has('d') ? Math.min(200, Math.max(0, +p.get('d') || 0)) : DEFAULT_RANGE;
    if (['front', 'side', 'rear'].includes(p.get('v'))) state.view = p.get('v');
    if (p.get('c') === 'ttk') state.color = 'ttk';
    state.showInner = p.get('in') === '1';
    state.fire = p.get('f') !== '0';
    if (p.has('s')) { state.stageView = p.get('s') === '3d' ? '3d' : 'map'; state.stagePinned = true; }
    state.rankCat = CAT_ORDER.includes(p.get('rc')) ? p.get('rc') : null;
  }

  /* ---------------- wiring ---------------- */

  let lastTabKey = null; // rankings are rebuilt only when their inputs change

  function render(keepCard) {
    renderFactionTabs();
    renderEnemyList();
    renderLoadout();
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
    renderRankCats();
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
    // 3 s after an enemy is picked the target box goes back to the faction cards (not while the pointer is on it)
    let backTimer = 0;
    const backToFactions = () => {
      clearTimeout(backTimer);
      backTimer = setTimeout(() => {
        if ($('.enemies-panel').matches(':hover')) { backToFactions(); return; }
        if ($('#enemySearch').value) return;
        state.faction = null; renderFactionTabs(); renderEnemyList();
      }, 3000);
    };
    $('#enemySearch').addEventListener('input', () => { clearTimeout(backTimer); renderEnemyList(); });
    $('#enemyVariant').addEventListener('change', (ev) => { setVariant(enemy(), +ev.target.value); resetSim(); writeHash(); render(); });
    // the same for the weapon picker: back to the category cards 3 s after a weapon is picked
    let wBackTimer = 0;
    const backToCategories = () => {
      clearTimeout(wBackTimer);
      wBackTimer = setTimeout(() => {
        if ($('.weapons-panel .list').matches(':hover') || $('#catTabs').matches(':hover')) { backToCategories(); return; }
        if ($('#weaponSearch').value) return;
        state.cat = null; renderCatTabs(); renderWeaponList(); $('#weaponList').scrollTop = 0;
      }, 3000);
    };
    $('#weaponSearch').addEventListener('input', () => { clearTimeout(wBackTimer); renderWeaponList(); });
    $('#enemyList').addEventListener('click', (ev) => {
      const card = ev.target.closest('li[data-f]');
      if (card) { clearTimeout(backTimer); state.faction = card.dataset.f; render(); return; }
      const li = ev.target.closest('li[data-id]'); if (!li) return;
      state.enemyId = li.dataset.id; state.hit = null;
      state.faction = enemyById(li.dataset.id).faction;
      if ($('#enemySearch').value) $('#enemySearch').value = '';
      resetSim(); autoStageView(); render();
      backToFactions();
    });
    $('#weaponList').addEventListener('click', (ev) => {
      const card = ev.target.closest('li[data-c]');
      if (card) { clearTimeout(wBackTimer); state.cat = card.dataset.c; render(); return; }
      const li = ev.target.closest('li[data-id]'); if (!li) return;
      chooseWeapon(li.dataset.id);
      if ($('#weaponSearch').value) $('#weaponSearch').value = '';
      swapWeapon(); render();
      backToCategories();
    });
    // loadout slot: highlight it, send the weapon picker back to its start (the category cards), and switch to
    // the weapon in it, if any
    $('#loadout').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-slot]'); if (!b) return;
      const cat = b.dataset.slot;
      state.slot = cat; state.cat = null;
      if ($('#weaponSearch').value) $('#weaponSearch').value = '';
      const id = state.loadout[cat];
      if (weaponById(id) && id !== state.weaponId) { state.weaponId = id; state.mode = 0; swapWeapon(); }
      render();
      $('#weaponList').scrollTop = 0;
    });
    $('#rankCats').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-rc]'); if (!b) return;
      state.rankCat = b.dataset.rc || null; render();
    });
    $('#weaponCard').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-band]'); if (!b) return;
      state.band = +b.dataset.band; render();
    });
    $('#weaponCard').addEventListener('input', (ev) => {
      if (ev.target.id === 'chargeSlider') {
        const w = weapon();
        const before = w.modes[0].chargeStep;
        setCharge(w, +ev.target.value);
        const m = w.modes[0];
        $('#chargeVal').textContent = m.chargeTime.toFixed(2) + ' s';
        $('#chargeMult').textContent = '×' + m.chargeMult.toFixed(2);
        $('#statDmg').textContent = fmt(m.damage);
        $('#statDur').textContent = fmt(m.durable);
        clearTimeout(distTimer);
        distTimer = setTimeout(() => { if (m.chargeStep !== before) renderWeaponCard(); render(true); }, 120);
        return;
      }
      if (ev.target.id !== 'distSlider') return;
      state.dist = +ev.target.value;
      $('#distVal').textContent = state.dist + ' m';
      clearTimeout(distTimer);
      distTimer = setTimeout(() => render(true), 120);
    });
    $('#weaponCard').addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.id === 'chargeSlider') { renderWeaponCard(); writeHash(); return; } // released: explosion stats may have switched
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
      chooseWeapon(tr.dataset.w, +tr.dataset.m);
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
    setupVariants();
    readHash();
    if (state.enemyId) state.faction = enemyById(state.enemyId).faction; // shared link: open its faction
    if (state.weaponId) state.cat = weaponById(state.weaponId).category;
    if (EDITOR) document.body.classList.add('editor');
    state.enemyId ||= (DATA.enemies.find((e) => e.id === 'charger') || DATA.enemies[0]).id;
    autoStageView();
    state.weaponId ||= (DATA.weapons.find((w) => /liberator$/i.test(w.name)) || DATA.weapons[0])?.id ?? null;
    for (const k of Object.keys(state.loadout)) if (!SLOTS.includes(k) || weaponById(state.loadout[k])?.category !== k) delete state.loadout[k];
    const w0 = weaponById(state.weaponId);
    if (w0 && SLOTS.includes(w0.category)) { if (!state.loadout[w0.category]) state.loadout[w0.category] = w0.id; if (state.loadout[w0.category] === w0.id) state.slot = w0.category; }
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
