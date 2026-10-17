/* ═══════════════════════════════════════════════════════════════════
   Гроші · знеособлювач для хмарної моделі («Порадник»)

   NDA-імена (клієнти ФОП, проєкти, номери рахунків, платники) не мають
   потрапляти в хмарну модель. hide() міняє їх на стабільні псевдоніми,
   reveal() повертає справжні назви у відповіді.

   UMD без залежностей і без Node-API в ядрі: той самий файл підключає
   вебвʼю апки як window.groshiPseudo. Псевдонім рахується з самого імені
   (FNV-1a-32), тому нічого не зберігається і однакове ім'я завжди дає
   однаковий псевдонім між сесіями.
   ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.groshiPseudo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREFIX = { client: 'Клієнт', project: 'Проєкт', payer: 'Платник', id: 'Реквізит' };
  /* 32 символи без I, O, 0, 1 (їх плутають); 5 біт на символ → 6 символів = 30 біт хешу (4 = 20 біт давали б колізії вже на сотнях імен). */
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const QUOTES = /["«»'ʼ]/g;
  const LB = '(?<![\\p{L}\\p{N}])', RB = '(?![\\p{L}\\p{N}])';
  const LEGAL = new RegExp(LB + '(?:тов|фоп|пп|llc|ltd|inc)\\.?' + RB, 'giu');
  /* Службові назви апки: це не імена клієнтів, їх ховати немає сенсу (і вони зіпсували б текст). */
  const SERVICE = ['клієнт', 'новий проєкт', 'pj_noclient'];

  const squash = s => s.replace(/\s+/g, ' ').trim();
  function norm(s) { return squash(String(s).toLowerCase().replace(QUOTES, '').replace(LEGAL, ' ')); }

  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function alias(kind, real) {
    let h = fnv1a(norm(real)), c = '';
    for (let i = 0; i < 6; i++) { c += ALPHA[h & 31]; h >>>= 5; }
    return PREFIX[kind] + ' ' + c;
  }

  /* «Рахунок ФОП» — те саме правило, що в fop_and_invoices (mcp/tools.js):
     явний перелік рахунків із налаштувань, інакше назва містить «ФОП» або вид рахунку fop. */
  function isFopTx(state, t) {
    const cfg = state && state.fopCfg, accs = cfg && cfg.accs;
    if (Array.isArray(accs) && accs.length) return accs.includes(t.account);
    return /фоп/i.test(t.account || '') || t.acctype === 'fop';
  }

  /* Написання, які можуть зустрітися в тексті: оригінал, без лапок, без ТОВ/ФОП. */
  function variants(real) {
    const v1 = squash(real), v2 = squash(v1.replace(QUOTES, '')), v3 = squash(v2.replace(LEGAL, ' '));
    return [v1, v2, v3];
  }

  function buildDict(state, tx) {
    state = state || {};
    const seen = new Map();   // lower(variant) → [real, alias]
    const ctx = new Map();    // «слабкі» числові id: ховаються лише поруч із №/#/ЄДРПОУ/код
    const back = {};          // alias → канонічна назва
    const add = (kind, real, canonical) => {
      if (typeof real !== 'string') return;
      real = squash(real);
      const n = norm(real);
      if (n.length < 3 || SERVICE.includes(n)) return;
      const al = alias(kind, real);
      /* Номер рахунку — довільний текст: `1200` чи `2026` збігся б із сумою або роком усюди (межі
         слова не рятують: «-», пробіл, «₴» не літери). Тому id без літер і коротший за 8 цифр
         (ЄДРПОУ = 8, IBAN = 27 — їх безпечно ховати скрізь) ховаємо лише після маркера. */
      const weak = kind === 'id' && !/\p{L}/u.test(real) && real.replace(/\D/g, '').length < 8;
      const seen_ = weak ? ctx : seen;
      if (!back[al]) back[al] = canonical || real;
      for (const v of variants(real)) {
        if (v.length < 3 || SERVICE.includes(v.toLowerCase())) continue;
        const k = v.toLowerCase();
        if (!seen_.has(k)) seen_.set(k, [v, al]);
      }
    };

    const cdb = state.clientsDB || {};
    for (const key of Object.keys(cdb)) {
      const c = cdb[key] || {};
      const canon = typeof c.name === 'string' && c.name ? c.name : key;
      add('client', key, canon);
      if (c.name) add('client', c.name, canon);
      if (c.reg) add('id', String(c.reg));
      /* IBAN-и шукаємо у всіх полях запису: де саме апка їх тримає, може змінитись. */
      for (const m of JSON.stringify(c).match(/UA\d{27}/g) || []) add('id', m);
    }
    for (const x of state.invcLog || []) {
      if (x && x.client) add('client', x.client);
      if (x && x.no) add('id', String(x.no));
    }
    for (const p of state.projects || []) {
      if (!p) continue;
      if (p.client) add('client', p.client);
      if (p.name) add('project', p.name);
    }
    /* Платник — відправник надходження на рахунок ФОП. Власні перекази («Між рахунками»)
       пропускаємо: там «платник» — сам власник, а не клієнт. */
    for (const t of tx || []) {
      if (!t || t.dir !== 'income' || !isFopTx(state, t)) continue;
      if ((t.category || t.cat) === 'Між рахунками') continue;
      add('payer', t.counterName); add('payer', t.merchant);
    }

    const pairs = [...seen.values()].sort((a, b) => b[0].length - a[0].length);
    const weakPairs = [...ctx.values()].sort((a, b) => b[0].length - a[0].length);
    return { pairs, ctx: weakPairs, back };
  }

  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /* Один прохід по тексту однією альтернацією: послідовні заміни перечіплювали б уже вставлені
     псевдоніми. Пробіли в імені — будь-яка кількість пробілів у тексті. */
  function replacer(items, fallback, pre) {
    if (!items.length) return null;
    const map = new Map(items.map(([k, v]) => [squash(k).toLowerCase(), v]));
    const re = new RegExp((pre || '') + LB + '(?:' + items.map(([k]) => esc(squash(k)).replace(/ /g, '\\s+')).join('|') + ')' + RB, 'giu');
    return text => text.replace(re, m => map.get(squash(m).toLowerCase()) || fallback(m));
  }
  /* Маркери, після яких числовий id вважаємо номером, а не сумою/роком. Навмисно без «рахунок»:
     «рахунок 1200 USD» — це сума. Lookbehind змінної довжини дозволяє «№ 12», «#12», «ЄДРПОУ: 12». */
  const CTX_PRE = String.raw`(?<=(?:№|#|єдрпоу|код)[ :.]{0,3})`;
  /* Збіг без запису в мапі (Unicode-згортання регістру в RegExp і toLowerCase розходяться,
     напр. «ſ»/«s») не лишаємо як є: це справжнє ім'я, яке піде в хмару. Закрита відмова. */
  const HIDDEN = '[приховано]';
  const cached = (dict, key, make) =>
    dict[key] || (Object.defineProperty(dict, key, { value: make() }), dict[key]);
  function hide(text, dict) {
    text = String(text == null ? '' : text);
    if (!dict || !dict.pairs) return text;
    const f = cached(dict, '_hide', () => replacer(dict.pairs, () => HIDDEN));
    const g = cached(dict, '_hideCtx', () => replacer(dict.ctx || [], () => HIDDEN, CTX_PRE));
    if (f) text = f(text);
    return g ? g(text) : text;
  }
  function reveal(text, dict) {
    text = String(text == null ? '' : text);
    if (!dict || !dict.back) return text;
    const f = cached(dict, '_reveal', () => replacer(Object.entries(dict.back), m => m));
    return f ? f(text) : text;
  }
  /* Модель бачить лише псевдоніми й підставляє їх в аргументи (query: «Клієнт AB3D»);
     інструмент шукає за справжнім ім'ям, тож рядки в аргументах розкриваємо до виклику. */
  function revealArgs(v, dict) {
    if (typeof v === 'string') return reveal(v, dict);
    if (Array.isArray(v)) return v.map(x => revealArgs(x, dict));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = revealArgs(v[k], dict);
      return o;
    }
    return v;
  }

  return { buildDict, hide, reveal, revealArgs, alias, isFopTx, _replacer: replacer };
});
