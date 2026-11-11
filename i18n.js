/* Page translation. Translations live in translations/*.csv (english → a column per language, filled in by
 * hand) and are built into data.js as HD2_DATA.i18n[lang]. With a language picked, every text node and
 * title/placeholder whose text matches an English entry is swapped one-to-one; entries with {n} match
 * any number in that spot. Text without a translation stays in English. The flags (bottom left) switch
 * language; the choice is remembered and links can carry it (#…&lang=ko). Without either, the browser's
 * preferred language picks it (ko / zh / ja, else English). */
(() => {
  'use strict';

  const DICTS = window.HD2_DATA?.i18n || {};
  const LANGS = [
    { id: 'en', label: 'English (US)', flag: flagUS() },
    { id: 'ko', label: '한국어', flag: flagKR() },
    { id: 'zh', label: '简体中文', flag: flagCN() },
    { id: 'zh-hant', label: '繁體中文', flag: flagHK() },
    { id: 'ja', label: '日本語', flag: flagJP() },
    { id: 'de', label: 'Deutsch', flag: tricolour(['#000', '#dd0000', '#ffce00'], 'h') },
    { id: 'fr', label: 'Français', flag: tricolour(['#0055a4', '#fff', '#ef4135'], 'v') },
    { id: 'es', label: 'Español', flag: tricolour(['#aa151b', '#f1bf00', '#f1bf00', '#aa151b'], 'h') },
    { id: 'it', label: 'Italiano', flag: tricolour(['#009246', '#fff', '#ce2b37'], 'v') },
    { id: 'uk', label: 'Українська', flag: tricolour(['#0057b7', '#ffd700'], 'h') },
    { id: 'ru', label: 'Русский', flag: tricolour(['#fff', '#0039a6', '#d52b1e'], 'h') },
  ];
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('lang');
  let saved = null;
  try { saved = localStorage.getItem('hd2-lang'); } catch { /* storage blocked */ }
  // first visit: the browser's preferred languages (its UI / region setting), first one we have, e.g.
  // ko-KR → ko, zh-CN / zh-TW → zh, ja-JP → ja; anything else stays English
  const fromBrowser = () => {
    for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language || '']) {
      const t = String(tag).toLowerCase(), base = t.split('-')[0];
      if (base === 'en') return 'en';
      // Chinese: Traditional for Taiwan / Hong Kong / Macau or an explicit Hant script, else Simplified
      if (base === 'zh') return /-(hant|tw|hk|mo)\b/.test(t) ? 'zh-hant' : 'zh';
      if (LANGS.some((l) => l.id === base)) return base;
    }
    return 'en';
  };
  const lang = LANGS.some((l) => l.id === fromHash) ? fromHash : LANGS.some((l) => l.id === saved) ? saved : fromBrowser();
  document.documentElement.lang = lang;

  // ---- language switch (bottom left)
  const bar = document.createElement('div');
  bar.className = 'lang-switch';
  // the current language first (highlighted), then the rest in order (Ukrainian before Russian)
  bar.innerHTML = [...LANGS.filter((l) => l.id === lang), ...LANGS.filter((l) => l.id !== lang)].map((l) => `<button type="button" data-lang="${l.id}" class="${l.id === lang ? 'on' : ''}" title="${l.label}" aria-label="${l.label}">${l.flag.replace('<svg ', `<svg preserveAspectRatio="${['en', 'zh'].includes(l.id) ? 'xMinYMid' : 'xMidYMid'} slice" `)}</button>`).join('');
  bar.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-lang]');
    if (!b || b.dataset.lang === lang) return;
    try { localStorage.setItem('hd2-lang', b.dataset.lang); } catch { /* storage blocked */ }
    const p = new URLSearchParams(location.hash.slice(1));
    p.delete('lang');
    location.hash = p.toString();
    location.reload(); // the page is rebuilt in English and translated again from scratch
  });
  document.body.appendChild(bar);

  const dict = lang === 'en' ? null : DICTS[lang];
  if (!dict) return;

  // exact entries, and {n} patterns compiled to regexes (longest first so specific ones win)
  const exact = new Map();
  const patterns = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [en, tr] of Object.entries(dict)) {
    if (!tr) continue;
    if (en.includes('{n}')) {
      const re = new RegExp('^' + en.split('{n}').map(esc).join('(\\d[\\d,.]*)') + '$');
      patterns.push({ re, tr, len: en.length });
    } else exact.set(en, tr);
  }
  patterns.sort((a, b) => b.len - a.len);

  function translate(text) {
    const core = text.replace(/\s+/g, ' ').trim();
    if (!core || !/[A-Za-z]/.test(core)) return null;
    let out = exact.get(core);
    if (out == null) {
      for (const p of patterns) {
        const m = p.re.exec(core);
        if (m) { let i = 1; out = p.tr.replace(/\{n\}/g, () => m[i++] ?? ''); break; }
      }
    }
    if (out == null) return null;
    const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
    return lead + out + trail;
  }

  const ATTRS = ['title', 'placeholder', 'aria-label'];
  function walk(root) {
    if (root.nodeType === Node.TEXT_NODE) { fixText(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE || /^(SCRIPT|STYLE|CANVAS|SVG)$/i.test(root.tagName)) return;
    fixAttrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) {
      if (n.nodeType === Node.TEXT_NODE) fixText(n);
      else fixAttrs(n);
    }
  }
  function fixText(n) {
    const p = n.parentElement;
    if (!p || /^(SCRIPT|STYLE)$/.test(p.tagName)) return;
    const t = translate(n.nodeValue);
    if (t != null && t !== n.nodeValue) n.nodeValue = t;
  }
  function fixAttrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute?.(a);
      if (!v) continue;
      const t = translate(v);
      if (t != null && t !== v) el.setAttribute(a, t);
    }
  }

  // the app re-renders often: translate whatever it puts on the page
  let busy = false;
  const mo = new MutationObserver((list) => {
    if (busy) return;
    busy = true;
    for (const m of list) {
      if (m.type === 'characterData') fixText(m.target);
      else if (m.type === 'attributes') fixAttrs(m.target);
      else m.addedNodes.forEach(walk);
    }
    mo.takeRecords(); // our own edits
    busy = false;
  });
  walk(document.body);
  document.title = translate(document.title) || document.title;
  mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });

  // ---- flags (inline SVG, simplified)
  function flagUS() {
    const stripes = Array.from({ length: 13 }, (_, i) => (i % 2 ? '' : `<rect y="${i * 10}" width="190" height="10" fill="#b22234"/>`)).join('');
    return `<svg viewBox="0 0 190 130" width="26" height="18" aria-hidden="true"><rect width="190" height="130" fill="#fff"/>${stripes}<rect width="76" height="70" fill="#3c3b6e"/>`
      + Array.from({ length: 20 }, (_, i) => `<circle cx="${8 + (i % 5) * 15}" cy="${8 + Math.floor(i / 5) * 17}" r="2.6" fill="#fff"/>`).join('') + '</svg>';
  }
  function flagCN() {
    // a five-pointed star: outer radius r, centre (x, y), turned by rot degrees
    const star = (x, y, r, rot) => {
      const pts = Array.from({ length: 10 }, (_, i) => {
        const a = ((i * 36 + rot - 90) * Math.PI) / 180, rr = i % 2 ? r * 0.382 : r;
        return `${(x + rr * Math.cos(a)).toFixed(1)},${(y + rr * Math.sin(a)).toFixed(1)}`;
      });
      return `<polygon points="${pts.join(' ')}" fill="#ffde00"/>`;
    };
    return `<svg viewBox="0 0 30 20" width="26" height="18" aria-hidden="true"><rect width="30" height="20" fill="#de2910"/>`
      + star(5, 5, 3, 0) + star(10, 2, 1, 23) + star(12, 4, 1, 46) + star(12, 7, 1, 70) + star(10, 9, 1, 21) + '</svg>';
  }
  /** Plain striped flags: colours top to bottom ('h') or left to right ('v'). */
  function tricolour(cols, dir) {
    const n = cols.length;
    return '<svg viewBox="0 0 30 20" width="26" height="18" aria-hidden="true">' + cols.map((c, i) => (dir === 'h'
      ? `<rect y="${(20 / n) * i}" width="30" height="${20 / n + 0.1}" fill="${c}"/>`
      : `<rect x="${(30 / n) * i}" width="${30 / n + 0.1}" height="20" fill="${c}"/>`)).join('') + '</svg>';
  }
  function flagHK() {
    // red with a white five-petal bauhinia (simplified)
    const petal = 'M0 0C-1.6-1.2-2.4-3.6-1.2-5.6C-.2-6.9 1.6-6.9 2.2-5.6C1-4.8.4-3.2 1.4-1.9C.9-1.1.4-.5 0 0Z';
    const petals = Array.from({ length: 5 }, (_, i) => `<path d="${petal}" fill="#fff" transform="rotate(${i * 72 + 18})"/>`).join('');
    return `<svg viewBox="0 0 30 20" width="26" height="18" aria-hidden="true"><rect width="30" height="20" fill="#de2910"/><g transform="translate(15 10.4) scale(1.15)">${petals}</g></svg>`;
  }
  function flagJP() {
    return '<svg viewBox="0 0 30 20" width="26" height="18" aria-hidden="true"><rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="6" fill="#bc002d"/></svg>';
  }
  function flagKR() {
    // trigram bars (gun, gon, gam, ri): solid = full bar, broken = two halves
    const tri = (cx, cy, rot, bars) => `<g transform="translate(${cx} ${cy}) rotate(${rot})">${bars.map((solid, i) => {
      const y = -10 + i * 8;
      return solid ? `<rect x="-12" y="${y}" width="24" height="5" fill="#000"/>` : `<rect x="-12" y="${y}" width="10.5" height="5" fill="#000"/><rect x="1.5" y="${y}" width="10.5" height="5" fill="#000"/>`;
    }).join('')}</g>`;
    return `<svg viewBox="0 0 180 120" width="26" height="18" aria-hidden="true"><rect width="180" height="120" fill="#fff"/>`
      + `<g transform="translate(90 60) rotate(33.7)"><circle r="30" fill="#0047a0"/><path d="M-30 0a30 30 0 0 1 60 0a15 15 0 0 1-30 0a15 15 0 0 0-30 0" fill="#cd2e3a"/></g>`
      + tri(40, 27, -56.3, [1, 1, 1]) + tri(140, 93, -56.3, [0, 0, 0]) + tri(140, 27, 56.3, [0, 1, 0]) + tri(40, 93, 56.3, [1, 0, 1])
      + '</svg>';
  }
})();
