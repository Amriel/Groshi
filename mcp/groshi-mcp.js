#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Гроші · MCP-сервер

   Дає Claude доступ до даних застосунку «Гроші» — READ ONLY.

   Чому саме так:
   • Жодних залежностей. `node groshi-mcp.js` — і все; ніякого npm
     install, нічого ламатися при оновленні Node.
   • Читає ТІ САМІ JSON-файли, що пише апка (%APPDATA%\ua.groshi.desktop).
     Нічого не пише — сервер фізично не має коду запису, тож зіпсувати
     дані апки він не може навіть помилково.
   • Токенів не торкається: Monobank, IBKR і Binance лежать у Диспетчері
     облікових даних Windows, а не у файлах. Сервер їх не бачить і не
     шукає — і не має жодного мережевого коду взагалі.

   Інвестиції беруться з inv_cache.json — нормалізованого зрізу, який
   апка пише сама. Розбір сирого IBKR XML тут неможливий: він потребує
   DOMParser, якого в Node немає. Практичний наслідок один: щоб сервер
   побачив свіжі дані брокера, апку треба хоч раз відкрити після
   синхронізації (вона перезапише кеш).
   ═══════════════════════════════════════════════════════════════════ */

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

/* ── де лежать дані ────────────────────────────────────────────────
   Порядок: змінна оточення (для нестандартних установок) → тека Tauri
   → location.json усередині неї (людина могла перенести дані на інший
   диск кнопкою «Змінити теку»). */
function dataDir() {
  const env = process.env.GROSHI_DIR;
  if (env && fs.existsSync(env)) return follow(env);
  const app = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'share'));
  for (const name of ['ua.groshi.desktop', 'Groshi', 'groshi']) {
    const p = path.join(app, name);
    if (fs.existsSync(p)) return follow(p);
  }
  return follow(path.join(app, 'ua.groshi.desktop'));
}
function follow(base) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(base, 'location.json'), 'utf8'));
    if (v && v.dir && fs.existsSync(v.dir)) return v.dir;
  } catch (e) { /* покажчика немає — це норма */ }
  return base;
}
const DIR = dataDir();

/* Кеш за mtime: апка може писати файли просто зараз, а перечитувати
   кілька МБ на кожен виклик — марно. */
const _cache = new Map();
function readJson(name, dflt) {
  const p = path.join(DIR, name);
  try {
    const st = fs.statSync(p);
    const hit = _cache.get(name);
    if (hit && hit.mtime === st.mtimeMs) return hit.val;
    const val = JSON.parse(fs.readFileSync(p, 'utf8'));
    _cache.set(name, { mtime: st.mtimeMs, val });
    return val;
  } catch (e) { return dflt; }
}

/* ── нормалізація операцій ─────────────────────────────────────────
   Використовуємо ТОЙ САМИЙ mononorm.js, що й апка (лежить поруч із цим
   файлом): парування переказів між своїми рахунками, дедуп, курси —
   усе вже вирішено там, і другої реалізації бути не повинно. */
let monoNorm = null;
function loadMono() {
  if (monoNorm !== null) return monoNorm;
  try {
    global.window = global.window || {};
    require(path.join(__dirname, 'mononorm.js'));
    monoNorm = global.window.monoNormalize || false;
  } catch (e) { monoNorm = false; }
  return monoNorm;
}
let _tx = null;
function txAll() {
  if (_tx) return _tx;
  const raw = readJson('mono_raw.json', null);
  const legacy = readJson('legacy.json', null);
  const fn = loadMono();
  if (!fn || !raw) return (_tx = []);
  try { _tx = fn(raw, legacy) || []; } catch (e) { _tx = []; }
  /* Ручні категорії з апки мають головувати над банківськими: людина
     вже виправила те, що банк вгадав неправильно. */
  const st = state();
  const over = st.txCats || {};
  for (const t of _tx) {
    const o = over[t.id];
    if (Array.isArray(o) && o[0]) { t.category = o[0]; if (o[1]) t.sub = o[1]; }
  }
  return _tx;
}
const state = () => readJson('state.json', {}) || {};
const invCache = () => {
  const c = readJson('inv_cache.json', null);
  return (c && c.data) ? c.data : null;
};
const quotes = () => {
  const q = readJson('quotes.json', null);
  return (q && q.quotes) ? q : { quotes: {}, fetched: 0 };
};

/* Курс долара: живого курсу банку у файлах немає, тож беремо
   найсвіжіший курс НБУ. Для «скільки це в гривні» цього достатньо;
   для податкових розрахунків апка все одно бере курс на дату. */
function ccyRate(ccy) {
  if (!ccy || ccy === 'UAH') return { rate: 1, date: '' };
  const nb = readJson('nbu_rates.json', {}) || {};
  const pre = ccy.toUpperCase() + ':';
  let best = null, bestD = '';
  for (const k of Object.keys(nb)) {
    if (!k.startsWith(pre)) continue;
    const d = k.slice(pre.length);
    if (d > bestD) { bestD = d; best = nb[k]; }
  }
  return { rate: best, date: bestD };
}
const usdRate = () => ccyRate('USD');
/* Усе зводимо до долара: портфель мультивалютний (акції в USD, ETF в
   євро, крипта в USDT), і без спільної одиниці частки й концентрація
   були б неправдою. Міст — курси НБУ: інших у файлах немає. */
const NO_RATE = new Set();
function toUsd(value, ccy) {
  if (value == null) return null;
  const c = (ccy || 'USD').toUpperCase();
  if (c === 'USD') return value;
  const u = usdRate().rate;
  const r = ccyRate(c).rate;
  /* Курсу немає (апка ще не тягнула НБУ по цій валюті) — рахуємо один
     до одного і чесно кажемо про це у виводі. Занулити позицію було б
     гірше: вона зникла б із часток і концентрації, і портфель виглядав
     би не таким, який він є. */
  if (!u || !r) { NO_RATE.add(c); return value; }
  return value * r / u;          // валюта → грн → долар
}

/* ── дрібні помічники ─────────────────────────────────────────────── */
const n2 = n => (Math.round(n * 100) / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n0 = n => Math.round(n).toLocaleString('uk-UA');
const pct = n => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1) + '%';
const today = () => new Date().toISOString().slice(0, 10);
const dnum = s => { const [y, m, d] = String(s).split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const dstr = n => new Date(n * 864e5).toISOString().slice(0, 10);
const ago = ts => {
  if (!ts) return 'невідомо';
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  if (m < 60) return m + ' хв тому';
  if (m < 1440) return Math.round(m / 60) + ' год тому';
  return Math.round(m / 1440) + ' дн. тому';
};

/* ── позиції з цінами ─────────────────────────────────────────────── */
function positions() {
  const inv = invCache();
  if (!inv || !Array.isArray(inv.pos)) return { pos: [], ivt: [], navh: [], fetched: {} };
  const Q = quotes().quotes;
  const pos = inv.pos.map(p => {
    const q = Q[p.symbol] || null;
    const price = q && q.price != null ? q.price : p.price;
    const value = p.qty != null && price != null ? p.qty * price : p.value;
    const cost = p.avgCost != null && p.qty != null ? p.avgCost * p.qty : null;
    return {
      ...p, price, value, cost,
      pnl: value != null && cost != null ? value - cost : null,
      pnlPct: value != null && cost && cost > 0 ? (value / cost - 1) * 100 : null,
      dayPct: q && q.price && q.prev ? (q.price / q.prev - 1) * 100 : null,
      sector: q && q.sector || null, pe: q && q.pe != null ? q.pe : null,
      cap: q && q.cap || null, divRate: q && q.divRate || null,
      divYield: q && q.divYield || null, payDate: q && q.payDate || null,
      name: q && q.name || p.name || null,
      w52Low: q && q.w52Low || null, w52High: q && q.w52High || null,
    };
  });
  return { pos, ivt: inv.ivt || [], navh: inv.navh || [], fetched: inv.fetched || {} };
}
const isCash = p => p.kind === 'cash';
const inUah = (p, r) => {
  if (p.value == null) return null;
  const k = p.ccy === 'UAH' ? 1 : (p.ccy === 'USD' || !p.ccy ? r : null);
  return k ? p.value * k : null;
};

/* ═══════════════════ ІНСТРУМЕНТИ ═══════════════════ */
const T = {};

T.groshi_status = {
  desc: 'Що бачить сервер: тека з даними, свіжість кожного джерела, обсяги. Кликати першим, якщо щось виглядає порожнім або застарілим.',
  schema: { type: 'object', properties: {} },
  run() {
    const inv = invCache(), q = quotes(), tx = txAll(), st = state();
    const nw = readJson('networth.json', []) || [];
    const raw = readJson('mono_raw.json', null);
    const L = [`Тека даних: ${DIR}`];
    L.push(`Файли: ${fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith('.json')).join(', ') : 'теки немає'}`);
    L.push('');
    L.push(`Операції: ${tx.length}${tx.length ? ` (${tx[0].date} … ${tx[tx.length - 1].date})` : ''}`
      + (loadMono() ? '' : '  ⚠ mononorm.js не знайдено поруч із сервером — операції недоступні'));
    L.push(`Банк синхронізовано: ${raw && raw.synced ? ago(raw.synced) : 'невідомо'}`);
    L.push(`Рахунки: ${raw && raw.accounts ? raw.accounts.length : 0}`);
    L.push(`Інвестиції: ${inv ? `${(inv.pos || []).length} позицій, ${(inv.ivt || []).length} операцій, ${(inv.navh || []).length} точок NAV` : '⚠ inv_cache.json немає — відкрийте апку раз після синхронізації'}`);
    if (inv && inv.fetched) L.push(`  IBKR: ${ago(inv.fetched.ibkr)} · Binance: ${inv.fetched.binance ? ago(inv.fetched.binance) : 'не підключено'}`);
    L.push(`Котирування: ${Object.keys(q.quotes).length} тікерів, оновлені ${ago(q.fetched)}`);
    L.push(`Знімки капіталу: ${nw.length}${nw.length ? ` (з ${nw[0].date})` : ''}`);
    L.push(`Підписки: ${(st.subsMan || []).length} вручну + ${Object.keys(st.subsOn || {}).length} підтверджених`);
    L.push(`Рахунки клієнтам у журналі: ${(st.invcLog || []).length}`);
    const r = usdRate();
    L.push(`Курс USD для перерахунку: ${r.rate ? r.rate.toFixed(2) + ' (НБУ на ' + r.date + ')' : 'немає — суми будуть у валюті інструмента'}`);
    return L.join('\n');
  }
};

T.portfolio = {
  desc: 'Повний зріз портфеля: кожна позиція з кількістю, середньою ціною входу, поточною ціною, прибутком, часткою, сектором і дивідендами; підсумки, готівка, концентрація, розподіл за секторами й валютами. Головний інструмент для аналізу.',
  schema: {
    type: 'object',
    properties: {
      include_thesis: { type: 'boolean', description: 'Додати мої записані тези по позиціях (нащо тримаю, коли вийду). Типово так.' }
    }
  },
  run(a) {
    const { pos, fetched } = positions();
    if (!pos.length) return 'Інвестиційних даних немає. Відкрийте апку після синхронізації з брокером — вона перезапише inv_cache.json.';
    const r = usdRate().rate;
    const st = state(), th = st.invThesis || {};
    const secs = pos.filter(p => !isCash(p) && p.kind !== 'crypto');
    const cry = pos.filter(p => p.kind === 'crypto');
    const cash = pos.filter(isCash);
    const totV = p => toUsd(p.value || 0, p.ccy) || 0;   // усе в USD-еквіваленті за курсами НБУ
    const total = [...secs, ...cry].reduce((s, p) => s + totV(p), 0);
    const cashTot = cash.reduce((s, p) => s + totV(p), 0);

    const L = [];
    L.push(`ПОРТФЕЛЬ (дані брокера ${ago(fetched.ibkr)}${fetched.binance ? `, Binance ${ago(fetched.binance)}` : ''}, ціни ${ago(quotes().fetched)})`);
    L.push(`Разом активів: ${n0(total)} $${r ? ` ≈ ${n0(total * r)} ₴` : ''}`
      + (cashTot ? ` · вільні кошти на брокері: ${n0(cashTot)} $` : ''));
    const cost = secs.reduce((s, p) => s + (p.cost || 0), 0);
    const val = secs.reduce((s, p) => s + (p.value || 0), 0);
    if (cost > 0) L.push(`Папери: вкладено ${n0(cost)} $ → зараз ${n0(val)} $ (${pct((val / cost - 1) * 100)}, ${val - cost >= 0 ? '+' : '−'}${n0(Math.abs(val - cost))} $)`);
    L.push('');

    const row = p => {
      const parts = [`${p.symbol}${p.name ? ` (${p.name})` : ''}`];
      const bits = [];
      if (p.qty != null) bits.push(`${p.qty} шт.`);
      if (p.avgCost != null) bits.push(`вхід ${n2(p.avgCost)}`);
      if (p.price != null) bits.push(`зараз ${n2(p.price)}`);
      if (p.value != null) bits.push(`${n0(p.value)} ${p.ccy || '$'}`);
      if (total > 0) bits.push(`${(totV(p) / total * 100).toFixed(1)}% портфеля`);
      if (p.pnlPct != null) bits.push(`P&L ${pct(p.pnlPct)} (${p.pnl >= 0 ? '+' : '−'}${n0(Math.abs(p.pnl))})`);
      if (p.dayPct != null) bits.push(`за день ${pct(p.dayPct)}`);
      if (p.sector) bits.push(p.sector);
      if (p.divYield) {
        const yoc = p.divRate && p.avgCost ? ` / на вкладене ${(p.divRate / p.avgCost * 100).toFixed(1)}%` : '';
        bits.push(`дивіденди ${(p.divYield * 100).toFixed(1)}%${yoc}`);
      }
      if (p.pe != null) bits.push(`P/E ${p.pe.toFixed(1)}`);
      if (p.w52Low && p.w52High && p.price)
        bits.push(`52т ${n2(p.w52Low)}–${n2(p.w52High)} (${((p.price - p.w52Low) / (p.w52High - p.w52Low) * 100).toFixed(0)}% діапазону)`);
      parts.push('  ' + bits.join(' · '));
      if (a && a.include_thesis !== false && th[p.symbol]) parts.push(`  теза: ${th[p.symbol]}`);
      return parts.join('\n');
    };

    if (secs.length) {
      L.push('ПАПЕРИ:');
      L.push(secs.slice().sort((x, y) => totV(y) - totV(x)).map(row).join('\n'));
      L.push('');
    }
    if (cry.length) {
      L.push('КРИПТА:');
      L.push(cry.slice().sort((x, y) => totV(y) - totV(x)).map(row).join('\n'));
      L.push('');
    }
    if (cash.length) {
      L.push('ГОТІВКА НА РАХУНКУ БРОКЕРА: '
        + cash.map(p => `${n0(p.value)} ${p.ccy}`).join(', '));
      L.push('');
    }

    /* Концентрація — те, заради чого зазвичай і дивляться на портфель. */
    const sorted = [...secs, ...cry].sort((x, y) => totV(y) - totV(x));
    if (sorted.length && total > 0) {
      const top = k => sorted.slice(0, k).reduce((s, p) => s + totV(p), 0) / total * 100;
      L.push(`КОНЦЕНТРАЦІЯ: найбільша позиція ${sorted[0].symbol} ${(totV(sorted[0]) / total * 100).toFixed(1)}%`
        + ` · топ-3 ${top(3).toFixed(0)}% · топ-5 ${top(5).toFixed(0)}% · всього позицій ${sorted.length}`);
    }
    const by = (key, label) => {
      const m = {};
      for (const p of [...secs, ...cry]) {
        const k = p[key] || 'невідомо';
        m[k] = (m[k] || 0) + totV(p);
      }
      const rows = Object.entries(m).sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `${k} ${(v / total * 100).toFixed(0)}%`);
      if (rows.length > 1) L.push(`${label}: ${rows.join(' · ')}`);
    };
    if (total > 0) { by('sector', 'СЕКТОРИ'); by('ccy', 'ВАЛЮТИ'); by('country', 'КРАЇНИ'); }

    /* Цілі ребалансу й watchlist — те, з чим порівнювати фактичні
       частки, коли просять пораду «що докупити». */
    const tgt = st.invTargets || {};
    const tk = Object.keys(tgt).filter(k => tgt[k]);
    if (tk.length && total > 0) {
      L.push('\nЦІЛЬОВІ ЧАСТКИ (задані в апці) проти фактичних:');
      for (const k of tk) {
        const p = pos.find(x => x.symbol === k);
        const now = p ? totV(p) / total * 100 : 0;
        const diff = now - tgt[k];
        L.push(`  ${k}: ціль ${tgt[k]}% · зараз ${now.toFixed(1)}% · `
          + (Math.abs(diff) < 1 ? 'у нормі' : diff > 0 ? `перевага ${diff.toFixed(1)} п.п.` : `бракує ${Math.abs(diff).toFixed(1)} п.п.`));
      }
    }
    const watch = st.invWatch || [];
    if (watch.length) {
      L.push('\nWATCHLIST (стежу, але не куплено):');
      for (const w of watch) {
        const q = quotes().quotes[w.sym];
        L.push(`  ${w.sym}${q && q.price ? ` — ${n2(q.price)}` : ''}${w.target ? ` · чекаю ціну ${w.target}` : ''}`);
      }
    }

    const noPrice = pos.filter(p => !isCash(p) && p.price == null);
    if (noPrice.length) L.push(`\n⚠ Без свіжої ціни: ${noPrice.map(p => p.symbol).join(', ')} — оновіть ціни в апці.`);
    if (NO_RATE.size) L.push(`⚠ Немає курсу НБУ для ${[...NO_RATE].join(', ')} — ці суми враховано як долари 1:1, частки трохи зміщені.`);
    return L.join('\n');
  }
};

T.portfolio_performance = {
  desc: 'Дохідність портфеля: TWR і річними за період, XIRR за весь час, максимальна просадка, внески й зняття, крива вартості. Для питань «як я насправді йду» і «чи обганяю ринок».',
  schema: {
    type: 'object',
    properties: {
      period: { type: 'string', description: 'ytd | 1m | 3m | 6m | 1y | 2y | all (типово all)' }
    }
  },
  run(a) {
    const { navh, ivt } = positions();
    if (!navh.length) return 'Історії вартості немає (navh порожній). Потрібен Flex-звіт IBKR із розділом Change in NAV.';
    const per = (a && a.period) || 'all';
    const last = navh[navh.length - 1].date;
    const from = per === 'all' ? navh[0].date
      : per === 'ytd' ? last.slice(0, 4) + '-01-01'
        : dstr(dnum(last) - ({ '1m': 30, '3m': 91, '6m': 182, '1y': 365, '2y': 730 }[per] || 365));
    const win = navh.filter(n => n.date >= from);
    if (win.length < 2) return `За період ${per} лише ${win.length} точок — замало.`;

    const flows = ivt.filter(t => (t.type === 'deposit' || t.type === 'withdraw') && t.date >= from)
      .map(t => ({ date: t.date, v: (t.type === 'deposit' ? 1 : -1) * t.amount }));
    const netF = flows.reduce((s, f) => s + f.v, 0);
    const V0 = win[0].value, V1 = win[win.length - 1].value;
    const days = Math.max(1, dnum(win[win.length - 1].date) - dnum(win[0].date));
    /* Модифікований Дітц — той самий метод, що в апці: внески зважуються
       за часом, який вони реально пробули в портфелі. */
    const wsum = flows.reduce((s, f) => s + f.v * (dnum(win[win.length - 1].date) - dnum(f.date)) / days, 0);
    const denom = V0 + wsum;
    const twr = denom > 0 ? (V1 - V0 - netF) / denom : null;
    const ann = twr != null && twr > -1 && days >= 28 ? Math.pow(1 + twr, 365 / days) - 1 : null;

    let peak = win[0].value, mdd = 0;
    for (const n of win) { if (n.value > peak) peak = n.value; if (peak > 0) mdd = Math.min(mdd, n.value / peak - 1); }

    /* XIRR за весь час — грошовозважена: враховує, КОЛИ заведено гроші. */
    let xirr = null;
    const cfAll = ivt.filter(t => t.type === 'deposit' || t.type === 'withdraw')
      .map(t => ({ d: dnum(t.date), v: (t.type === 'deposit' ? -1 : 1) * t.amount }));
    if (cfAll.length) {
      cfAll.push({ d: dnum(navh[navh.length - 1].date), v: navh[navh.length - 1].value });
      const t0 = cfAll[0].d;
      const npv = rr => cfAll.reduce((s, c) => s + c.v / Math.pow(1 + rr, (c.d - t0) / 365), 0);
      let lo = -0.95, hi = 4;
      if (npv(lo) * npv(hi) < 0) {
        for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; (npv(lo) * npv(mid) <= 0 ? hi = mid : lo = mid); }
        xirr = (lo + hi) / 2;
      }
    }

    const L = [`ДОХІДНІСТЬ (${per}, ${win[0].date} … ${win[win.length - 1].date}, ${days} дн.)`];
    L.push(`Вартість: ${n0(V0)} → ${n0(V1)} $`);
    L.push(`Внески за період: ${netF >= 0 ? '+' : '−'}${n0(Math.abs(netF))} $${netF < 0 ? ' (зняття)' : ''}`);
    L.push(`Чистий результат (без внесків): ${V1 - V0 - netF >= 0 ? '+' : '−'}${n0(Math.abs(V1 - V0 - netF))} $`);
    if (twr != null) L.push(`TWR за період: ${pct(twr * 100)}${ann != null ? ` · річними ${pct(ann * 100)}` : ''}`);
    if (xirr != null) L.push(`XIRR за весь час: ${pct(xirr * 100)} річних (грошовозважена — враховує, коли саме заводились гроші)`);
    L.push(`Максимальна просадка в цьому вікні: ${(mdd * 100).toFixed(1)}%`);

    /* Крива — рідко, але рівно: місяцями, щоб було видно форму. */
    const step = Math.max(1, Math.floor(win.length / 14));
    L.push('\nКрива вартості:');
    for (let i = 0; i < win.length; i += step) L.push(`  ${win[i].date}  ${n0(win[i].value)} $`);
    if ((win.length - 1) % step) L.push(`  ${win[win.length - 1].date}  ${n0(V1)} $`);
    return L.join('\n');
  }
};

T.portfolio_trades = {
  desc: 'Угоди: купівлі й продажі з фільтрами, реалізований прибуток по роках і частка прибуткових продажів. Для питань «як я торгую» і «що дала активність понад просто тримати».',
  schema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Тільки по цьому тікеру' },
      since: { type: 'string', description: 'Від дати РРРР-ММ-ДД' },
      limit: { type: 'number', description: 'Скільки останніх угод показати (типово 40)' }
    }
  },
  run(a) {
    const { ivt } = positions();
    a = a || {};
    let rows = ivt.filter(t => t.type === 'buy' || t.type === 'sell');
    if (a.symbol) rows = rows.filter(t => (t.symbol || '').toUpperCase() === a.symbol.toUpperCase());
    if (a.since) rows = rows.filter(t => t.date >= a.since);
    if (!rows.length) return 'Угод за цими умовами немає.';
    const lim = a.limit || 40;
    const L = [`УГОДИ: ${rows.length}${a.symbol ? ` по ${a.symbol}` : ''}${a.since ? ` з ${a.since}` : ''}`];

    const byYear = {};
    for (const t of ivt.filter(t => t.type === 'sell')) {
      const y = t.date.slice(0, 4);
      const b = byYear[y] = byYear[y] || { n: 0, win: 0, pnl: 0 };
      b.n++; if (t.pnl > 0) b.win++; b.pnl += (t.pnl || 0);
    }
    const years = Object.keys(byYear).sort();
    if (years.length) {
      L.push('\nРеалізований результат (закриті угоди):');
      for (const y of years) {
        const b = byYear[y];
        L.push(`  ${y}: ${b.pnl >= 0 ? '+' : '−'}${n0(Math.abs(b.pnl))} $ · продажів ${b.n} · прибуткових ${Math.round(b.win / b.n * 100)}%`);
      }
    }
    L.push(`\nОстанні ${Math.min(lim, rows.length)}:`);
    for (const t of rows.slice(-lim).reverse()) {
      L.push(`  ${t.date}  ${t.type === 'buy' ? 'купив ' : 'продав'} ${t.symbol}  ${t.qty} × ${n2(t.price)} = ${n0(t.amount)} ${t.ccy || '$'}`
        + (t.type === 'sell' && t.pnl ? `  P&L ${t.pnl >= 0 ? '+' : '−'}${n0(Math.abs(t.pnl))}` : '')
        + (t.note ? `  (${t.note})` : ''));
    }
    return L.join('\n');
  }
};

T.portfolio_dividends = {
  desc: 'Дивіденди: отримані по роках і тікерах, а також прогноз на наступні 12 місяців за поточними ставками. Для питань про пасивний дохід і дивідендну частину стратегії.',
  schema: { type: 'object', properties: {} },
  run() {
    const { pos, ivt } = positions();
    const divs = ivt.filter(t => t.type === 'div');
    const L = [];
    if (divs.length) {
      const byY = {}, byS = {};
      for (const d of divs) {
        const y = d.date.slice(0, 4);
        byY[y] = (byY[y] || 0) + d.amount;
        byS[d.symbol] = (byS[d.symbol] || 0) + d.amount;
      }
      L.push('ОТРИМАНІ ДИВІДЕНДИ (до податків):');
      for (const y of Object.keys(byY).sort()) L.push(`  ${y}: ${n0(byY[y])} $`);
      L.push('\nПо тікерах за весь час:');
      for (const [s, v] of Object.entries(byS).sort((a, b) => b[1] - a[1]))
        L.push(`  ${s}: ${n0(v)} $`);
      const tax = ivt.filter(t => t.type === 'tax').reduce((s, t) => s + t.amount, 0);
      if (tax) L.push(`\nУтримано податку у джерела за весь час: ${n0(tax)} $`);
    } else L.push('Отриманих дивідендів у звіті немає.');

    const fwd = pos.filter(p => p.divRate && p.qty).map(p => ({
      s: p.symbol, y: p.qty * p.divRate, yield: p.divYield, pay: p.payDate,
      yoc: p.avgCost ? p.divRate / p.avgCost * 100 : null
    })).sort((a, b) => b.y - a.y);
    if (fwd.length) {
      const tot = fwd.reduce((s, x) => s + x.y, 0);
      L.push(`\nПРОГНОЗ НА 12 МІСЯЦІВ за поточними ставками: ${n0(tot)} $ (${n0(tot / 12)} $/міс)`);
      for (const f of fwd) L.push(`  ${f.s}: ${n0(f.y)} $/рік`
        + (f.yield ? ` · дохідність ${(f.yield * 100).toFixed(1)}%` : '')
        + (f.yoc ? ` · на вкладене ${f.yoc.toFixed(1)}%` : '')
        + (f.pay ? ` · найближча виплата ${f.pay}` : ''));
      L.push('Прогноз лінійний: ставка × кількість. Скорочення чи підвищення дивідендів він не передбачає.');
    }
    return L.join('\n');
  }
};

T.position = {
  desc: 'Одна позиція детально: кількість, середня ціна, поточна, прибуток, фундаментал, дивіденди, усі мої угоди по ній і моя записана теза. Для розбору конкретного паперу.',
  schema: {
    type: 'object',
    properties: { symbol: { type: 'string', description: 'Тікер, напр. MSFT або BTC' } },
    required: ['symbol']
  },
  run(a) {
    const sym = String((a && a.symbol) || '').toUpperCase();
    const { pos, ivt } = positions();
    const p = pos.find(x => (x.symbol || '').toUpperCase() === sym);
    const ops = ivt.filter(t => (t.symbol || '').toUpperCase() === sym);
    if (!p && !ops.length) return `Позиції чи операцій по ${sym} немає.`;
    const L = [`${sym}${p && p.name ? ` — ${p.name}` : ''}`];
    if (p) {
      if (p.qty != null) L.push(`Кількість: ${p.qty}`);
      if (p.avgCost != null) L.push(`Середня ціна входу: ${n2(p.avgCost)} ${p.ccy || '$'}`);
      if (p.price != null) L.push(`Поточна ціна: ${n2(p.price)}${p.dayPct != null ? ` (за день ${pct(p.dayPct)})` : ''}`);
      if (p.value != null) L.push(`Вартість позиції: ${n0(p.value)} ${p.ccy || '$'}`);
      if (p.pnl != null) L.push(`Нереалізований P&L: ${p.pnl >= 0 ? '+' : '−'}${n0(Math.abs(p.pnl))} (${pct(p.pnlPct)})`);
      const f = [];
      if (p.sector) f.push(p.sector);
      if (p.country) f.push(p.country);
      if (p.pe != null) f.push(`P/E ${p.pe.toFixed(1)}`);
      if (p.cap) f.push(`капіталізація ${(p.cap / 1e9).toFixed(1)} млрд`);
      if (p.w52Low && p.w52High) f.push(`52 тижні ${n2(p.w52Low)}–${n2(p.w52High)}`);
      if (f.length) L.push('Фундаментал: ' + f.join(' · '));
      if (p.divRate) L.push(`Дивіденди: ${n2(p.divRate)}/рік`
        + (p.divYield ? ` · ${(p.divYield * 100).toFixed(1)}% до ціни` : '')
        + (p.avgCost ? ` · ${(p.divRate / p.avgCost * 100).toFixed(1)}% на вкладене` : '')
        + (p.payDate ? ` · виплата ${p.payDate}` : ''));
      const th = (state().invThesis || {})[p.symbol];
      if (th) L.push(`Моя теза: ${th}`);
    } else L.push('(позиції зараз немає — папір закритий)');
    if (ops.length) {
      L.push(`\nМої операції (${ops.length}):`);
      for (const t of ops.slice(-30)) L.push(`  ${t.date}  ${t.type}  ${t.qty != null ? t.qty + ' × ' : ''}${t.price != null ? n2(t.price) : ''} = ${n0(t.amount)} ${t.ccy || '$'}`
        + (t.pnl ? ` · P&L ${t.pnl >= 0 ? '+' : '−'}${n0(Math.abs(t.pnl))}` : ''));
    }
    return L.join('\n');
  }
};

T.money_flow = {
  desc: 'Гроші поза брокером: доходи й витрати по місяцях, скільки в середньому лишається, баланси рахунків, капітал і його динаміка. Потрібно, щоб радити суму регулярного внеску без ризику залишитись без подушки.',
  schema: {
    type: 'object',
    properties: { months: { type: 'number', description: 'Скільки останніх місяців показати (типово 6)' } }
  },
  run(a) {
    const tx = txAll();
    const months = (a && a.months) || 6;
    const L = [];
    const raw = readJson('mono_raw.json', null);
    const CCY = { 980: 'UAH', 840: 'USD', 978: 'EUR', 985: 'PLN', 826: 'GBP' };
    if (raw && raw.accounts) {
      L.push('БАЛАНСИ РАХУНКІВ:');
      for (const acc of raw.accounts)
        L.push(`  ${acc.title || acc.type || acc.id}: ${n2(acc.balance)} ${CCY[acc.currency] || acc.currency}`);
      L.push('');
    }
    const nw = readJson('networth.json', []) || [];
    if (nw.length) {
      const l = nw[nw.length - 1], f = nw[0];
      L.push(`КАПІТАЛ (знімок ${l.date}): ${n0(l.total)} ₴`
        + ` — рахунки ${n0(l.bank)}, інвестиції ${n0(l.inv)}, інше ${n0(l.other)}`);
      if (nw.length > 1) L.push(`  від ${f.date}: ${l.total - f.total >= 0 ? '+' : '−'}${n0(Math.abs(l.total - f.total))} ₴ за ${dnum(l.date) - dnum(f.date)} дн.`);
      L.push('');
    }
    if (!tx.length) return L.join('\n') + '\nОперацій немає (mononorm.js поруч із сервером?).';

    const by = {};
    for (const t of tx) {
      const m = t.date.slice(0, 7);
      const b = by[m] = by[m] || { inc: 0, exp: 0 };
      if (t.dir === 'income' && !t.refund) b.inc += t.amount;
      else if (t.dir === 'expense') b.exp += t.amount;
    }
    const keys = Object.keys(by).sort().slice(-months);
    L.push(`ДОХОДИ Й ВИТРАТИ (останні ${keys.length} міс., у гривні):`);
    for (const k of keys) {
      const b = by[k];
      L.push(`  ${k}: +${n0(b.inc)} / −${n0(b.exp)} → ${b.inc - b.exp >= 0 ? '+' : '−'}${n0(Math.abs(b.inc - b.exp))}`);
    }
    /* Поточний місяць неповний — у середнє його не беремо, інакше воно
       завжди виглядало б краще за правду. */
    const full = keys.filter(k => k !== today().slice(0, 7));
    if (full.length) {
      const ai = full.reduce((s, k) => s + by[k].inc, 0) / full.length;
      const ae = full.reduce((s, k) => s + by[k].exp, 0) / full.length;
      L.push(`\nУ середньому за ${full.length} повних міс.: дохід ${n0(ai)} ₴, витрати ${n0(ae)} ₴, лишається ${n0(ai - ae)} ₴/міс`);
      const r = usdRate().rate;
      if (r && ai - ae > 0) L.push(`Це ≈ ${n0((ai - ae) / r)} $ на місяць — стеля регулярного внеску до подушки безпеки.`);
    }
    return L.join('\n');
  }
};

T.transactions = {
  desc: 'Пошук операцій банку з фільтрами (період, напрямок, рахунок, текст, сума). Для перевірки конкретних витрат чи надходжень.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Текст: мерчант, коментар, контрагент' },
      from: { type: 'string', description: 'Від РРРР-ММ-ДД' },
      to: { type: 'string', description: 'До РРРР-ММ-ДД' },
      direction: { type: 'string', description: 'income | expense' },
      account: { type: 'string', description: 'Назва рахунку (частково)' },
      min: { type: 'number' }, max: { type: 'number' },
      limit: { type: 'number', description: 'Типово 50' }
    }
  },
  run(a) {
    a = a || {};
    let rows = txAll();
    if (!rows.length) return 'Операцій немає.';
    if (a.from) rows = rows.filter(t => t.date >= a.from);
    if (a.to) rows = rows.filter(t => t.date <= a.to);
    if (a.direction) rows = rows.filter(t => t.dir === a.direction);
    if (a.account) rows = rows.filter(t => (t.account || '').toLowerCase().includes(a.account.toLowerCase()));
    if (a.min != null) rows = rows.filter(t => t.amount >= a.min);
    if (a.max != null) rows = rows.filter(t => t.amount <= a.max);
    if (a.query) {
      const q = a.query.toLowerCase();
      rows = rows.filter(t => [t.merchant, t.comment, t.counterName, t.category, t.account]
        .some(x => x && String(x).toLowerCase().includes(q)));
    }
    if (!rows.length) return 'За цими умовами нічого не знайдено.';
    const sum = rows.reduce((s, t) => s + (t.dir === 'income' ? t.amount : -t.amount), 0);
    const lim = a.limit || 50;
    const L = [`Знайдено ${rows.length} операцій, підсумок ${sum >= 0 ? '+' : '−'}${n0(Math.abs(sum))} ₴`];
    for (const t of rows.slice(0, lim))
      L.push(`  ${t.date}  ${t.dir === 'income' ? '+' : '−'}${n2(t.amount)} ₴  ${t.merchant || t.counterName || ''}`
        + (t.category ? ` · ${t.category}` : '') + (t.account ? ` · ${t.account}` : '')
        + (t.currency && t.opAmount ? ` · ${t.opAmount} ${t.currency}` : ''));
    if (rows.length > lim) L.push(`  … ще ${rows.length - lim}`);
    return L.join('\n');
  }
};

T.subscriptions = {
  desc: 'Підписки: підтверджені й додані вручну, суми на місяць і на рік, дати найближчих списань.',
  schema: { type: 'object', properties: {} },
  run() {
    const st = state();
    const man = st.subsMan || [], on = st.subsOn || {};
    const PD = { week: 7, '2weeks': 14, month: 30.4375, quarter: 91.31, half: 182.62, year: 365.25 };
    const PN = { week: 'щотижня', '2weeks': 'раз на 2 тижні', month: 'щомісяця', quarter: 'щокварталу', half: 'раз на пів року', year: 'щороку' };
    const list = man.map(m => ({ ...m, src: 'вручну' }));
    for (const [k, v] of Object.entries(on)) {
      const name = k.split('|')[0];
      list.push({ merchant: v.merchant || name, amount: v.amount, period: v.period || 'month',
        last: v.last, ccy: v.ccy, famt: v.famt, src: 'знайдена апкою', note: v.note });
    }
    if (!list.length) return 'Підписок не збережено.';
    let perM = 0;
    const L = ['ПІДПИСКИ:'];
    for (const s of list) {
      const d = PD[s.period] || 30.4375;
      const amt = s.amount || 0;
      perM += amt * 30.4375 / d;
      L.push(`  ${s.merchant}: ${n0(amt)} ₴ ${PN[s.period] || s.period}`
        + (s.ccy && s.ccy !== 'UAH' && s.famt ? ` (${s.famt} ${s.ccy})` : '')
        + (s.last ? ` · останнє ${s.last}` : '') + ` · ${s.src}`
        + (s.note ? ` · ${s.note}` : ''));
    }
    L.push(`\nРазом: ${n0(perM)} ₴/міс · ${n0(perM * 12)} ₴/рік`);
    return L.join('\n');
  }
};

T.fop_and_invoices = {
  desc: 'ФОП і рахунки клієнтам: надходження по кварталах, ЄП і ВЗ до сплати, дедлайни, виставлені рахунки та які з них ще не оплачені.',
  schema: {
    type: 'object',
    properties: { year: { type: 'string', description: 'Рік, типово поточний' } }
  },
  run(a) {
    const st = state(), cfg = st.fopCfg || null;
    const Y = (a && a.year) || today().slice(0, 4);
    const L = [];
    const accs = cfg && cfg.accs && cfg.accs.length ? cfg.accs : null;
    const tx = txAll().filter(t => t.dir === 'income' && t.date.slice(0, 4) === Y
      && (accs ? accs.includes(t.account) : /фоп/i.test(t.account || '')));
    if (!cfg) L.push('Картка «Податки ФОП» в апці не налаштована — ставки нижче взято типові (ЄП 5%, ВЗ 1%).');
    const c = cfg || { mode: 'pct', pct: 5, vz: 1, esv: 0 };
    const qs = [0, 1, 2, 3].map(q => {
      const inc = tx.filter(t => Math.floor(+t.date.slice(5, 7) / 3.001) === q).reduce((s, t) => s + t.amount, 0);
      return { q, inc,
        ep: c.mode === 'fix' ? (c.epMo || 0) * 3 : inc * (c.pct || 0) / 100,
        vz: c.mode === 'fix' ? (c.vzMo || 0) * 3 : inc * (c.vz || 0) / 100 };
    });
    L.push(`ФОП ${Y}${accs ? ` (рахунки: ${accs.join(', ')})` : ''}:`);
    let tot = 0, tep = 0, tvz = 0;
    for (const q of qs) {
      if (!q.inc) continue;
      tot += q.inc; tep += q.ep; tvz += q.vz;
      L.push(`  Q${q.q + 1}: дохід ${n0(q.inc)} ₴ → ЄП ${n0(q.ep)} ₴ · ВЗ ${n0(q.vz)} ₴`);
    }
    L.push(`  Разом: дохід ${n0(tot)} ₴ · податків ${n0(tep + tvz + (c.esv || 0) * 12)} ₴`
      + (c.esv ? ` (з ЄСВ ${n0((c.esv || 0) * 12)} ₴)` : ''));
    /* Ліміт 3 групи змінюється щороку — свідомо не зашитий у код,
       щоб не показувати застаріле число як факт. */
    L.push('  (річний ліміт доходу для 3 групи змінюється — звіряйте з чинним на цей рік)');

    const log = st.invcLog || [];
    if (log.length) {
      const un = log.filter(x => !x.paid);
      L.push(`\nРАХУНКИ КЛІЄНТАМ: ${log.length} у журналі, ${un.length} без оплати`);
      for (const x of log.slice(0, 15)) {
        const d = Math.floor((Date.now() - new Date(x.date + 'T12:00:00')) / 864e5);
        L.push(`  ${x.no} · ${x.client} · ${n2(x.total)} ${x.ccy} · ${x.date} · `
          + (x.paid ? `оплачено ${x.paid.date}` : `ЧЕКАЄ ${d} дн.`));
      }
    }
    return L.join('\n');
  }
};

/* ═══════════════════ ПРОТОКОЛ MCP (stdio, JSON-RPC 2.0) ═══════════════════
   Без SDK: обмін — рядки JSON у stdin/stdout. Так сервер запускається
   голим `node groshi-mcp.js` на будь-якій машині з Node 18+, без npm
   install і без ризику, що оновлення пакета щось зламає. */
const TOOLS = Object.entries(T).map(([name, t]) => ({
  name, description: t.desc, inputSchema: t.schema
}));

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'groshi', version: '1.0.0' }
    }});
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params && params.name;
    const t = T[name];
    if (!t) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Немає такого інструмента: ' + name } });
    try {
      const text = t.run((params && params.arguments) || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } });
    } catch (e) {
      /* Помилку віддаємо як результат, а не як збій протоколу: клієнт
         покаже її мені, і я зможу пояснити людині, що не так. */
      return send({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: 'Помилка інструмента: ' + (e && e.message || e) + '\nТека даних: ' + DIR }],
        isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Метод не підтримується: ' + method } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch (e) { continue; }
    try { handle(req); } catch (e) {
      if (req && req.id !== undefined)
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(e && e.message || e) } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
