/* ═══════════ МІСТ ДО ДЕСКТОПНОЇ ОБОЛОНКИ ═══════════
   Головний скрипт апки синхронний: він читає store.get() просто в тілі
   функцій. Дані ж із диска приходять асинхронно. Щоб не переписувати
   три тисячі рядків на await, робимо навпаки: спершу дочитуємо все, що
   треба, кладемо в window.__BOOT__, і аж тоді запускаємо застосунок —
   зовнішній app.js завантажується лише після цього. Так він працює
   у глобальній області, а CSP не потребує дозволу на довільний код. */
(function () {
  const T = window.__TAURI__;
  const inv = T ? T.core.invoke : null;

  /* Апка має відкриватись і без оболонки — так її зручно перевіряти в
     звичайному браузері. Тоді все лягає в localStorage, як раніше. */
  const fake = {
    mem: JSON.parse(localStorage.getItem('deskState') || '{}'),
    save() { localStorage.setItem('deskState', JSON.stringify(this.mem)); }
  };

  const D = {
    tauri: !!inv,

    state: () => inv ? inv('state_all') : Promise.resolve(fake.mem),
    stateSet: (k, v) => inv ? inv('state_set', { key: k, value: v })
      : (fake.mem[k] = v, fake.save()),
    stateDel: k => inv ? inv('state_del', { key: k })
      : (delete fake.mem[k], fake.save()),

    /* Без оболонки читаємо з localStorage — так апку можна відкрити
       звичайним браузером і перевірити на справжніх даних. */
    raw: () => inv ? inv('raw_all')
      : Promise.resolve(JSON.parse(localStorage.getItem('deskRaw') || 'null')
        || { accounts: [], items: {}, fetched: {}, synced: 0 }),
    legacy: () => inv ? inv('legacy_all')
      : Promise.resolve(JSON.parse(localStorage.getItem('deskLegacy') || 'null')),
    legacyImport: v => inv ? inv('legacy_import', { value: v }) : Promise.resolve(0),
    dir: () => inv ? inv('data_dir') : Promise.resolve('браузер · localStorage'),
    dirDefault: () => inv ? inv('data_default') : Promise.resolve(''),
    dirPeek: p => inv ? inv('data_peek', { path: p }) : Promise.reject('лише в застосунку'),
    dirSet: (p, mode) => inv ? inv('data_set', { path: p || null, mode: mode || 'move' })
      : Promise.reject('лише в застосунку'),
    restart: () => inv ? inv('restart') : location.reload(),
    reveal: n => inv ? inv('reveal', { name: n || null }) : null,
    openUrl: u => inv ? inv('open_url', { url: u }) : window.open(u, '_blank'),
    saveText: (name, text) => inv ? inv('save_text', { name, text }) : Promise.reject('лише в застосунку'),

    version: () => inv ? inv('app_version') : Promise.resolve('—'),
    updSource: () => inv ? inv('update_source') : Promise.resolve(''),
    updCheck: src => inv ? inv('update_check', { source: src || null })
      : Promise.reject('лише в застосунку'),
    updInstall: (src, file) => inv ? inv('update_install', { source: src || null, file })
      : Promise.reject('лише в застосунку'),
    /* Вибір теки — системний діалог ОС, а не наше вікно: тут це доречно,
       бо йдеться про файлову систему, і власного файлового браузера ми
       не пишемо. Якщо плагін не відповість — лишається текстове поле. */
    pickDirT: title => inv
      ? inv('pick_directory', { title })
          .catch(() => null)
      : Promise.resolve(null),

    tokenHas: () => inv ? inv('token_has') : Promise.resolve(false),
    tokenSet: t => inv ? inv('token_set', { token: t }) : Promise.reject('лише в застосунку'),
    tokenClear: () => inv ? inv('token_clear') : Promise.resolve(),
    accounts: () => inv ? inv('accounts_list') : Promise.resolve([]),
    sync: m => inv ? inv('sync', { months: m }) : Promise.reject('лише в застосунку'),
    syncPlan: m => inv ? inv('sync_plan', { months: m }) : Promise.reject('лише в застосунку'),
    syncStop: () => inv ? inv('sync_stop') : null,

    fx: force => inv ? inv('fx', { force: !!force }) : Promise.resolve(null),

    /* Брокери — тільки читання. Ключі живуть у Диспетчері облікових
       даних, сирі дані — у теці апки; фронтенд бачить лише результат. */
    ibkrHas: () => inv ? inv('ibkr_has') : Promise.resolve(false),
    ibkrSet: (t, q) => inv ? inv('ibkr_set', { token: t, queryId: q }) : Promise.reject('лише в застосунку'),
    ibkrClear: () => inv ? inv('ibkr_clear') : Promise.resolve(),
    ibkrSync: () => inv ? inv('ibkr_sync') : Promise.reject('лише в застосунку'),
    ibkrImport: p => inv ? inv('ibkr_import', { path: p }) : Promise.reject('лише в застосунку'),
    ibkrImportClear: () => inv ? inv('ibkr_import_clear') : Promise.resolve(),
    /* Вибір файлу — системний діалог ОС, як і вибір теки: це файлова
       система, власного браузера файлів ми не пишемо. */
    pickXml: () => inv
      ? inv('pick_file', { kind: 'xml' }).catch(() => null)
      : Promise.resolve(null),
    binHas: () => inv ? inv('binance_has') : Promise.resolve(false),
    binSet: (k, s) => inv ? inv('binance_set', { key: k, secret: s }) : Promise.reject('лише в застосунку'),
    binClear: () => inv ? inv('binance_clear') : Promise.resolve(),
    binSync: () => inv ? inv('binance_sync') : Promise.reject('лише в застосунку'),
    invCache: () => inv ? inv('inv_cache') : Promise.resolve(null),
    invCacheSet: v => inv ? inv('inv_cache_set', { value: v }) : Promise.resolve(),
    invRaw: () => inv ? inv('inv_raw')
      : Promise.resolve(JSON.parse(localStorage.getItem('deskInv') || 'null') || { ibkr: null, binance: null }),
    quotesSync: syms => inv ? inv('quotes_sync', { symbols: syms }) : Promise.reject('лише в застосунку'),
    quotesCached: () => inv ? inv('quotes_cached')
      : Promise.resolve(JSON.parse(localStorage.getItem('deskQuotes') || 'null')),
    quoteDetail: (ysym, range) => inv ? inv('quote_detail', { ysym, range }) : Promise.reject('лише в застосунку'),
    quoteNews: (ysym, uk) => inv ? inv('quote_news', { ysym, uk: !!uk }) : Promise.reject('лише в застосунку'),
    quotesToday: symbols => inv ? inv('quotes_today', { symbols }) : Promise.reject('лише в застосунку'),
    logosSync: items => inv ? inv('logos_sync', { items }) : Promise.reject('лише в застосунку'),
    logosCached: () => inv ? inv('logos_cached') : Promise.resolve({}),
    nbuRates: items => inv ? inv('nbu_rates', { items }) : Promise.reject('лише в застосунку'),
    backupRun: dir => inv ? inv('backup_run', { dir: dir || null }) : Promise.reject('лише в застосунку'),
    pickDir: () => inv
      ? inv('pick_directory', { title: 'Виберіть теку для даних' }).catch(() => null)
      : Promise.resolve(null),
    pickStatement: () => inv
      ? inv('pick_file', { kind: 'statement' }).catch(() => null)
      : Promise.resolve(null),
    fileB64: p => inv ? inv('file_b64', { path: p }) : Promise.reject('лише в застосунку'),
    nwAdd: (date, value) => inv ? inv('nw_add', { date, value }) : Promise.resolve(),
    nwAll: () => inv ? inv('nw_all') : Promise.resolve([]),
    cryHistAdd: (date, value) => inv ? inv('cryhist_add', { date, value }) : Promise.resolve(),
    cryHistAll: () => inv ? inv('cryhist_all')
      : Promise.resolve(JSON.parse(localStorage.getItem('deskCryHist') || '[]')),

    onSync: fn => { if (T && T.event) T.event.listen('sync', e => fn(e.payload)); },
    onAutoSync: fn => { if (T && T.event) T.event.listen('auto-synced', e => fn(e.payload)); },
    onAutoIbkr: fn => { if (T && T.event) T.event.listen('auto-ibkr', e => fn(e.payload)); },
    onTraySync: fn => { if (T && T.event) T.event.listen('tray-sync', () => fn()); },

    /* Плагіни звертаємось напряму через IPC, а не через їхні npm-обгортки.
       withGlobalTauri вкладає у сторінку лише ядро API; пакунки плагінів
       треба було б збирати збирачем, якого тут немає. Імена команд —
       ті самі, що обгортки викликають усередині. */
    notify(title, body) {
      if (!inv) return;
      inv('plugin:notification|is_permission_granted')
        .then(ok => ok ? true : inv('plugin:notification|request_permission').then(p => p === 'granted'))
        .then(ok => { if (ok) inv('plugin:notification|notify', { options: { title, body } }); })
        .catch(() => {});
    },

    autostartIs: () => inv ? inv('plugin:autostart|is_enabled').catch(() => false) : Promise.resolve(false),
    autostartOn: () => inv ? inv('plugin:autostart|enable').catch(() => {}) : null,
    autostartOff: () => inv ? inv('plugin:autostart|disable').catch(() => {}) : null
  };
  window.__DESK__ = D;

  function fail(msg) {
    document.body.innerHTML =
      '<div style="font:15px/1.5 system-ui;color:#eee;background:#111;padding:40px;height:100vh">'
      + '<h2 style="color:#C5FF23">Гроші не запустились</h2><pre style="white-space:pre-wrap">'
      + String(msg).replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;') + '</pre></div>';
  }

  (async () => {
    try {
      const [state, raw, legacy, hasToken, dir, invRaw, hasIbkr, hasBin, quotes] = await Promise.all([
        D.state(), D.raw(), D.legacy(), D.tokenHas(), D.dir(),
        D.invRaw().catch(() => null), D.ibkrHas().catch(() => false), D.binHas().catch(() => false),
        D.quotesCached().catch(() => null)
      ]);
      const cryHist = await D.cryHistAll().catch(() => []);
      const logos = await D.logosCached().catch(() => ({}));
      const tx = window.monoNormalize(raw, legacy);
      /* Інвестиції розбираються тут же, при старті: вкладка має відкриватись
         миттєво, з останнього знімка, а свіжі дані дотягуються кнопкою. */
      let invData = null;
      try {
        if (window.invNormalize && invRaw && (invRaw.ibkr || invRaw.binance)) {
          /* Кеш нормалізації: з дворічною історією кожен старт парсив би
             кілька МБ XML. Підпис — часи синхронізацій і кількість
             склеєних файлів; збігся — беремо готове з диска. */
          const sig = JSON.stringify([
            invRaw.ibkr && invRaw.ibkr.fetched || 0,
            (invRaw.ibkr && invRaw.ibkr.extra || []).length,
            invRaw.binance && invRaw.binance.fetched || 0, 2]);
          const cache = await D.invCache().catch(() => null);
          if (cache && cache.sig === sig && cache.data) invData = cache.data;
          else {
            invData = window.invNormalize({
              ibkrXml: invRaw.ibkr
                ? [invRaw.ibkr.xml].concat(invRaw.ibkr.extra || []).filter(Boolean)
                : null,
              binanceRaw: invRaw.binance || null
            });
            invData.fetched = {
              ibkr: invRaw.ibkr && invRaw.ibkr.fetched || 0,
              binance: invRaw.binance && invRaw.binance.fetched || 0
            };
            D.invCacheSet({ sig, data: invData }).catch(() => {});
          }
        }
      } catch (e) { invData = null; }
      window.__BOOT__ = {
        state: state && typeof state === 'object' ? state : {},
        raw, legacy, hasToken, dir, tx,
        inv: invData, hasIbkr, hasBin,
        quotes: quotes && typeof quotes === 'object' ? quotes : null,
        cryHist: Array.isArray(cryHist) ? cryHist : [],
        logos: logos && typeof logos === 'object' ? logos : {},
        meta: { built: new Date().toISOString().slice(0, 10), source: 'Monobank API', n: tx.length }
      };
      /* Парсер може ще не дійти до <script id="appsrc">: наші виклики
         резолвляться в мікрозадачі, тобто раніше, ніж браузер дочитає
         документ. Тому чекаємо на готовність DOM. */
      if (document.readyState === 'loading')
        await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
      const s = document.createElement('script');
      s.src = 'app.js';
      s.onerror = () => fail('Не вдалося завантажити код застосунку. Перевстановіть перевірену збірку.');
      document.body.appendChild(s);
    } catch (e) {
      fail(e && e.stack ? e.stack : e);
    }
  })();
})();
