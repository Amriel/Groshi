// Десктопна збірка зі штучними інвестиціями — для знімків і проб вкладки
// «Інвестиції». У браузерній збірці вкладка показує лише заглушку
// («підключення живе в застосунку»), тож справжній екран (групи, позиції,
// графік, дивіденди, податки) можна побачити тільки в десктопній, де
// window.__BOOT__.inv заповнює міст desktop.js.
//
// Тому тут підмінено IPC Tauri, як у tests/desktop-csp.mjs, але відповіді
// не порожні: inv_raw віддає штучний Flex XML (продовження фікстури з
// tests/ibkr-currency.mjs) і штучні баланси Binance, а нормалізує їх
// справжній desktop/dist/invnorm.js — тим самим шляхом, що в застосунку.
// Жодних реальних даних: рахунок U0000000, тікери TST*, круглі числа;
// Data/ і Backup/ не читаються. Дати рахуються від сьогодні, щоб «за
// 12 місяців» і «Рік» завжди мали що показати.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {syntheticTx} from './synthetic.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = path.join(root, 'desktop', 'dist');
const origin = 'http://127.0.0.1:31461';
const DAY = 864e5;

const iso = ms => new Date(ms).toISOString().slice(0, 10);
const ymd = ms => iso(ms).replaceAll('-', '');

// Детерміновані «коливання» замість Math.random: знімки до й після мусять
// малювати той самий графік, інакше порівнювати нічого.
const wave = i => Math.sin(i / 6) * 0.03 + Math.sin(i / 17) * 0.05;

export function syntheticFlexXml(now = Date.now()) {
  const d = n => ymd(now - n * DAY);
  const nav = [];
  // Вартість росте з 9000 до ~11000 USD, із двома поповненнями по 1000.
  for (let i = 200; i >= 1; i--) {
    // Поповнення входить у вартість у день зарахування (≤, а не <): інакше
    // «Чистий дохід» малював би день-провал там, де гроші лише переїхали.
    const base = 9000 + (200 - i) * 6 + (i <= 120 ? 1000 : 0) + (i <= 40 ? 1000 : 0);
    nav.push(`<EquitySummaryInBase reportDate="${d(i)}" total="${Math.round(base * (1 + wave(i)))}"/>`);
  }
  const div = (id, sym, n, amt) =>
    `<CashTransaction transactionID="TEST-D${id}" type="Dividends" symbol="${sym}" dateTime="${d(n)};120000" amount="${amt}" currency="USD" description="${sym} cash dividend"/>`
    + `<CashTransaction transactionID="TEST-W${id}" type="Withholding Tax" symbol="${sym}" dateTime="${d(n)};120000" amount="-${(amt * 0.15).toFixed(2)}" currency="USD" description="${sym} withholding"/>`;
  return `<FlexQueryResponse><FlexStatements><FlexStatement accountId="U0000000" currency="USD" toDate="${d(1)}">
  <OpenPositions>
    <OpenPosition symbol="TSTA" description="Synthetic Alpha Corp" assetCategory="STK" position="10" markPrice="150" costBasisPrice="120" currency="USD" listingExchange="NASDAQ"/>
    <OpenPosition symbol="TSTB" description="Synthetic Beta Inc" assetCategory="STK" position="20" markPrice="50" costBasisPrice="55" currency="USD" listingExchange="NYSE"/>
    <OpenPosition symbol="TETF" description="Synthetic World ETF" assetCategory="STK" position="30" markPrice="100" costBasisPrice="90" currency="USD" listingExchange="ARCA"/>
  </OpenPositions>
  <Trades>
    <Trade transactionID="TEST-1" symbol="TSTA" tradeDate="${d(180)}" buySell="BUY" quantity="12" tradePrice="120" currency="USD" ibCommission="-1" issuerCountryCode="US"/>
    <Trade transactionID="TEST-2" symbol="TSTB" tradeDate="${d(150)}" buySell="BUY" quantity="20" tradePrice="55" currency="USD" ibCommission="-1" issuerCountryCode="US"/>
    <Trade transactionID="TEST-3" symbol="TETF" tradeDate="${d(110)}" buySell="BUY" quantity="30" tradePrice="90" currency="USD" ibCommission="-1" issuerCountryCode="IE"/>
    <Trade transactionID="TEST-4" symbol="TSTA" tradeDate="${d(60)}" buySell="SELL" quantity="-2" tradePrice="140" currency="USD" ibCommission="-1" fifoPnlRealized="40" issuerCountryCode="US"/>
  </Trades>
  <CashTransactions>
    <CashTransaction transactionID="TEST-P1" type="Deposits/Withdrawals" dateTime="${d(120)};100000" amount="1000" currency="USD" description="Synthetic deposit"/>
    <CashTransaction transactionID="TEST-P2" type="Deposits/Withdrawals" dateTime="${d(40)};100000" amount="1000" currency="USD" description="Synthetic deposit"/>
    ${div(1, 'TSTA', 170, 10)}${div(2, 'TETF', 100, 20)}${div(3, 'TSTA', 80, 10)}${div(4, 'TETF', 10, 20)}
  </CashTransactions>
  ${nav.join('\n  ')}
  <CashReport><CashReportCurrency currency="BASE_SUMMARY" endingCash="700"/><CashReportCurrency currency="USD" endingCash="500"/><CashReportCurrency currency="EUR" endingCash="200"/></CashReport>
</FlexStatement></FlexStatements></FlexQueryResponse>`;
}

export function syntheticBinance(now = Date.now()) {
  return {
    account: {balances: [{asset: 'BTC', free: '0.05', locked: '0'}, {asset: 'USDT', free: '300', locked: '0'}]},
    earnFlexible: [{asset: 'ETH', totalAmount: '0.5'}],
    funding: [],
    prices: {BTCUSDT: {p: '60000', chg: '1.5'}, ETHUSDT: {p: '3000', chg: '-2'}},
    trades: {BTC: [{id: 1, time: now - 90 * DAY, qty: '0.05', quoteQty: '2500', price: '50000', isBuyer: true}]},
    fetched: Math.floor(now / 1000) - 3600,
  };
}

// Рік денних закрить для картки акції (графік ціни з мітками угод).
function closes(now, start, end) {
  const dates = [], cs = [];
  for (let i = 250; i >= 0; i--) {
    dates.push(iso(now - i * DAY));
    cs.push(Math.round((start + (end - start) * (250 - i) / 250) * (1 + wave(i) / 2) * 100) / 100);
  }
  return {dates, closes: cs};
}

export function syntheticQuotes(now = Date.now()) {
  const q = (sym, name, price, prev, start, extra = {}) => ({
    ysym: sym, name, price, prev, ccy: 'USD', ...closes(now, start, price),
    w52Low: Math.round(start * 0.9), w52High: Math.round(price * 1.1), ...extra,
  });
  return {
    // Свіжий час: інакше invActions сам побіг би оновлювати ціни.
    fetched: Math.floor(now / 1000),
    quotes: {
      // payDate у майбутньому — щоб «Очікується» під дивідендами мав рядок.
      TSTA: q('TSTA', 'Synthetic Alpha Corp', 152, 150, 110, {sector: 'Technology', pe: 20, cap: 2e11, eps: 7.5,
        divRate: 4, divYield: 0.026, payDate: iso(now + 20 * DAY)}),
      TSTB: q('TSTB', 'Synthetic Beta Inc', 49, 50, 60, {sector: 'Healthcare'}),
      TETF: q('TETF', 'Synthetic World ETF', 101, 100, 85),
      SPY: q('SPY', 'Synthetic benchmark', 500, 498, 420),
    },
  };
}

// Справжній 1×1 PNG: перевіряє гілку «логотип», решта рядків — монограми.
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Відкриває desktop/dist/index.html зі штучними даними.
 * state — додаткові ключі сховища (напр. clientsDB для проби Порадника).
 * @returns {Promise<{ctx, page, errors: string[]}>}
 */
export async function openDesktop(browser, {width, height = 900, theme = 'dark', state: extraState = {}} = {}) {
  const now = Date.now();
  const boot = {
    xml: syntheticFlexXml(now), binance: syntheticBinance(now), quotes: syntheticQuotes(now),
    tx: syntheticTx(), theme, logo: LOGO, extraState, fetched: Math.floor(now / 1000) - 7200,
  };
  const ctx = await browser.newContext({viewport: {width, height}});
  await ctx.addInitScript(b => {
    // Ціль, watchlist (з котируванням і без), цільова частка й теза —
    // інакше гілки renderInvGoal/renderInvWatch/мітки цілі не малювались би
    // жодного разу і помилку в них не побачила б жодна проба.
    const state = {wizDone: true, theme: b.theme,
      invGoal: {target: 1000000, monthly: 10000, rate: 10, infl: 3, years: 20},
      invWatch: [{sym: 'TSTB', target: 45}, {sym: 'TSTX', target: null}],
      invTargets: {TSTA: 30}, invThesis: {TSTA: 'Штучна теза для перевірки'},
      ...b.extraState};
    // Курс задаємо одразу: без рахунків Monobank balRender не тягне fx,
    // і всі суми інвестицій у гривні були б нулями.
    window.FX_NOW = {USD: 40, EUR: 45};
    window.__unexpectedCommands = [];
    const nbu = items => Object.fromEntries((items || []).map(i =>
      [`${i.ccy}:${i.date}`, i.ccy === 'EUR' ? 45 : 40]));
    window.__TAURI__ = {core: {invoke: async (command, args) => {
      if (command === 'state_all') return {...state};
      if (command === 'state_set') { state[args.key] = args.value; return; }
      if (command === 'state_del') { delete state[args.key]; return; }
      if (command === 'raw_all') return {accounts: [], items: {}, fetched: {}, synced: 0};
      // Операції — той самий штучний набір, що й у браузерних знімках;
      // mononorm пропускає їх як «давні» записи без змін.
      if (command === 'legacy_all') return b.tx;
      if (['cryhist_all', 'nw_all', 'accounts_list'].includes(command)) return [];
      if (command === 'inv_raw') return {ibkr: {xml: b.xml, extra: [], fetched: b.fetched}, binance: b.binance};
      if (command === 'inv_cache') return null;
      // Записи на диск — без наслідків. nw_add — денна точка історії
      // капіталу (nwKick), щойно капітал більший за нуль: зі штучними
      // інвестиціями так буває на «Огляді», який обходить snap.mjs.
      if (['inv_cache_set', 'cryhist_add', 'nw_add'].includes(command)) return;
      // Знімок для MCP: зберігаємо, щоб проба advdata.mjs бачила, що й скільки разів писалось.
      if (command === 'advice_cache_set') { (window.__advSnaps = window.__advSnaps || []).push(args.value); return; }
      if (command === 'quotes_cached') return b.quotes;
      if (command === 'logos_cached') return {TSTA: b.logo};
      // Курс НБУ на кожну запитану дату: порожня відповідь змусила б
      // invNbuKick питати знову після кожного render().
      if (command === 'nbu_rates') return nbu(args && args.items);
      if (command === 'quotes_today') return {fetched: Math.floor(Date.now() / 1000), quotes: {}};
      if (command === 'fx') return {rates: {USD: 40, EUR: 45}, at: Math.floor(Date.now() / 1000), stale: false};
      if (command === 'backup_run') return {files: 0, path: 'synthetic-backup'};
      if (['token_has', 'plugin:autostart|is_enabled'].includes(command)) return false;
      // Ключі «є», щоб у «Платформах» стояли кнопки оновлення.
      if (['ibkr_has', 'binance_has'].includes(command)) return true;
      if (['data_dir', 'data_default'].includes(command)) return 'synthetic-data';
      if (command === 'app_version') return 'test';
      if (command === 'update_source') return '';
      // Оновлення: проба задає відповідь через window.__updFixture або помилку через
      // window.__updError (рядок, як віддає Rust); встановлення лише записує аргументи.
      if (command === 'update_check') {
        if (window.__updError) throw window.__updError;
        return window.__updFixture || {available: false, current: 'test', version: 'test'};
      }
      if (command === 'update_install') { window.__updInstalled = args; return; }
      window.__unexpectedCommands.push(command);
      throw Error('Неочікувана команда фікстури: ' + command);
    }}, event: {listen: async () => () => {}}};
  }, boot);
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    const name = path.basename(url.pathname);
    if (name === 'index.html')
      return route.fulfill({status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(dist, 'index.html'))});
    if (!['app.js', 'desktop.js', 'mononorm.js', 'pseudo.js', 'invnorm.js'].includes(name)) return route.abort();
    return route.fulfill({status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(dist, name))});
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/index.html');
  await page.waitForFunction(() => typeof window.go === 'function' && window.__BOOT__);
  await page.evaluate(() => document.fonts.ready);
  return {ctx, page, errors};
}
