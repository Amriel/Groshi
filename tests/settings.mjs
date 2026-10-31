// Налаштування: ліва колонка розділів + панелі (каркас, Task 1).
// Ловить: пункти колонки відсутні/зайві в браузері, старий setSec ('src', 'app',
// сміття) веде на порожню панель, перемикання розділу зсуває колонку, при
// перенесенні карток губляться id полів.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {openDesktop} from './helpers/desktop-boot.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-artifacts');
fs.mkdirSync(output, {recursive:true});
const browser = await chromium.launch({executablePath:process.env.CHROMIUM || undefined});

const IDS = ['rMatch','rAdd','excl','moveMode','workCats','baseCcy','privacyOptions','pvImport','pinBtn',
  'pinIdle','invcDueDays','alertPct','divNotifyCk','newsUk','bkNow','bkDir','bkAuto','expCsv','expJson',
  'reset','quality','advSetNote'];
const BROWSER_SECS = ['bank','inv','rules','notif','loc','priv','data','adv'];


// ── Перемикачі й рядки (Task 3) ────────────────────────────────────
// Перемикач — той самий input[type=checkbox] (id, .checked, onchange не змінились)
// + клас .sw і role=switch; дозволи приватності — button.sw[data-privacy].
const SW_PANE = {divNotifyCk: 'notif', newsUk: 'loc', bkAuto: 'data', autoStart: 'run'};
// Координати від початку документа: клік скролить сторінку, і viewport-рамка помилково «зсувається».
const docBox = loc => loc.evaluate(e => { const r = e.getBoundingClientRect();
  return {x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height}; });
async function checkSwitches(pg, ids, label) {
  for (const id of ids) {
    await pg.evaluate(s => go2set(s), SW_PANE[id]);
    const info = await pg.evaluate(i => { const e = document.getElementById(i);
      return {sw: e.classList.contains('sw'), role: e.getAttribute('role'), type: e.type,
        name: e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby')).textContent.trim()}; }, id);
    assert.deepEqual([info.sw, info.role, info.type], [true, 'switch', 'checkbox'], `${label}: #${id} — перемикач`);
    assert.ok(info.name, `${label}: #${id} має доступну назву`);
    const loc = pg.locator('#' + id);
    const b0 = await docBox(loc);
    const was = await loc.isChecked();
    await loc.click();
    assert.equal(await loc.isChecked(), !was, `${label}: клік змінює #${id}`);
    assert.deepEqual(await docBox(loc), b0, `${label}: перемикач #${id} не змінює розмір/положення`);
    assert.deepEqual([b0.width, b0.height], [44, 26], `${label}: #${id} 44×26`);
    await loc.click();
    assert.equal(await loc.isChecked(), was, `${label}: повторний клік повертає #${id}`);
  }
}
// Рядки й групи не тонуються: фон рядка прозорий або дорівнює фону групи.
async function checkRowsFlat(pg, sec, label) {
  await pg.evaluate(s => go2set(s), sec);
  const r = await pg.evaluate(() => {
    const vis = e => e.offsetParent !== null;
    const rows = [...document.querySelectorAll('.setpane:not([hidden]) .setrow')].filter(vis);
    const grps = [...document.querySelectorAll('.setpane:not([hidden]) .setgrp')].filter(vis);
    return {n: rows.length, g: grps.length,
      gbg: [...new Set(grps.map(g => getComputedStyle(g).backgroundColor))],
      rbg: [...new Set(rows.map(x => getComputedStyle(x).backgroundColor))],
      stripe: rows.concat(grps).filter(x => { const c = getComputedStyle(x);
        return parseFloat(c.borderLeftWidth) > 0 || /inset/.test(c.boxShadow); }).length};
  });
  assert.ok(r.n > 0 && r.g > 0, `${label}/${sec}: є групи й рядки`);
  assert.equal(r.gbg.length, 1, `${label}/${sec}: усі групи одного кольору`);
  for (const c of r.rbg) assert.ok(c === 'rgba(0, 0, 0, 0)' || c === r.gbg[0], `${label}/${sec}: рядок без тонування (${c} проти ${r.gbg[0]})`);
  assert.equal(r.stripe, 0, `${label}/${sec}: без смуг збоку`);
}

// ── Пошук і вузький екран (Task 5) ─────────────────────────────────
const shownSecs = pg => pg.$$eval('#setNav .setit', b => b.filter(x => x.offsetParent !== null && !x.hidden).map(x => x.dataset.sec));
async function checkSearch(pg, label, all) {
  await pg.evaluate(() => go2set('rules'));
  assert.equal(await pg.locator('#setQ').getAttribute('type'), null, `${label}: без type=search`);
  assert.equal(await pg.locator('#setQ').getAttribute('placeholder'), 'Пошук налаштувань', `${label}: плейсхолдер`);
  assert.ok(await pg.locator('#setQ').getAttribute('aria-label'), `${label}: aria-label`);
  assert.equal(await pg.locator('.setside h1').textContent(), 'Налаштування', `${label}: заголовок колонки`);
  const geo = () => pg.evaluate(() => ['setNav', 'setQ'].map(i => { const r = document.getElementById(i).getBoundingClientRect(); return [r.x, r.y + scrollY, r.width]; }));
  const g0 = await geo();
  const type = async q => { await pg.locator('#setQ').fill(q); };
  await type('БЕКАП');
  assert.deepEqual(await shownSecs(pg), ['data'], `${label}: «БЕКАП» → лише data`);
  assert.equal(await pg.locator('#setNone').isVisible(), false);
  await pg.screenshot({path: path.join(output, 'settings-search-1400.png')});
  await type('шифрування');
  assert.deepEqual(await shownSecs(pg), ['priv'], `${label}: «шифрування» → лише priv`);
  await type('zzzz');
  assert.deepEqual(await shownSecs(pg), [], `${label}: «zzzz» → пунктів немає`);
  assert.equal((await pg.locator('#setNone').textContent()).trim(), 'Нічого не знайдено');
  assert.equal(await pg.locator('#setNone').isVisible(), true);
  assert.equal(await pg.locator('#setNav .setnavg:visible').count(), 0, `${label}: порожні групи сховано`);
  await type("комп'ютер"); const a = await shownSecs(pg);
  await type('комп\u2019ютер'); const b = await shownSecs(pg);
  assert.deepEqual(a, b, `${label}: апостроф ' і \u2019 однакові`);
  assert.ok(a.length > 0, `${label}: «комп'ютер» щось знаходить`);
  assert.deepEqual(await geo(), g0, `${label}: пошук не зсуває колонку й поле`);
  await type('зй'); await pg.locator('#setQ').press('Escape');
  assert.equal(await pg.locator('#setQ').inputValue(), '', `${label}: Escape чистить`);
  assert.deepEqual(await shownSecs(pg), all, `${label}: порожній запит → усі`);
  assert.deepEqual(await geo(), g0, `${label}: після очищення колонка на місці`);
  // фільтр переживає render()
  await type('бекап'); await pg.evaluate(() => render());
  assert.deepEqual(await shownSecs(pg), ['data'], `${label}: render() не скидає фільтр`);
  await type('');
  // перший видимий пункт групи не має роздільника зверху
  await type('шифрування');
  assert.equal(await pg.evaluate(() => getComputedStyle(document.querySelector('#setNav .setit:not([hidden])'), '::before').content), 'none', `${label}: без роздільника над першим видимим`);
  await type('');
}
async function checkNarrow(pg, label) {
  const flat = () => pg.evaluate(() => ({
    nav: document.getElementById('setNav').offsetParent !== null,
    panes: [...document.querySelectorAll('#tab-settings .setpane')].filter(p => p.offsetParent !== null).map(p => p.dataset.sec),
    back: !!document.getElementById('setBack') && document.getElementById('setBack').offsetParent !== null,
    sw: document.documentElement.scrollWidth <= innerWidth, sy: scrollY}));
  await pg.evaluate(() => go('overview'));
  await pg.evaluate(() => scrollTo(0, 0));
  // телефон: налаштування відкриваються з меню «Ще»
  await pg.click('#tabs [data-tab="settings"]'); await pg.waitForTimeout(300);
  await pg.click('#modal .pickrow[data-v="settings"]'); await pg.waitForTimeout(400);
  let f = await flat();
  assert.deepEqual([f.nav, f.panes, f.back], [true, [], false], `${label}: спершу лише список`);
  assert.ok(f.sw, `${label}: без горизонтального скролу (список)`);
  await pg.screenshot({path: path.join(output, 'settings-narrow-list-390.png')});
  await pg.evaluate(() => scrollTo(0, 300));
  await pg.locator('#setNav .setit[data-sec="loc"]').click();
  f = await flat();
  assert.deepEqual([f.nav, f.panes, f.back], [false, ['loc'], true], `${label}: клік → панель loc і #setBack`);
  assert.ok(f.sw && f.sy < 5, `${label}: панель зверху, без горизонтального скролу (${f.sy})`);
  assert.equal(await pg.locator('#setBack').textContent(), '\u2039 Налаштування');
  await pg.screenshot({path: path.join(output, 'settings-narrow-pane-390.png')});
  await pg.evaluate(() => scrollTo(0, 200));
  await pg.locator('#setBack').click();
  f = await flat();
  assert.deepEqual([f.nav, f.panes, f.back], [true, [], false], `${label}: «‹ Налаштування» → список`);
  assert.ok(f.sy < 5, `${label}: список зверху (${f.sy})`);
  await pg.locator('#setQ').fill('бекап');
  assert.deepEqual(await shownSecs(pg), ['data'], `${label}: пошук на вузькому`);
  await pg.locator('#setQ').fill('');
  // глибоке посилання одразу відкриває панель
  await pg.evaluate(() => go('overview'));
  await pg.evaluate(() => go2set('adv'));
  f = await flat();
  assert.deepEqual([f.nav, f.panes, f.back], [false, ['adv'], true], `${label}: go2set('adv') → одразу панель`);
  assert.ok(f.sw, `${label}: adv без горизонтального скролу`);
  // звичайний вхід знову показує список
  await pg.evaluate(() => { go('overview'); go('settings'); });
  f = await flat();
  assert.deepEqual([f.nav, f.panes], [true, []], `${label}: звичайний вхід → список`);
}

try {
  // Браузерна збірка: каркас і міграція стану. Десктоп — окремий блок нижче.
  const context = await browser.newContext({viewport:{width:1400,height:900}});
  await context.addInitScript(() => {
    localStorage.setItem('wizDone', 'true');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
  await context.route(/^https?:/, r => r.abort());
  const url = pathToFileURL(path.join(root, '.test-artifacts/synthetic_app.html')).href;

  async function openWith(old) {
    await page.goto(url); await page.waitForFunction(() => typeof window.go==='function');
    await page.evaluate(v => { sessionStorage.clear(); localStorage.setItem('setSec', JSON.stringify(v)); }, old);
    await page.reload(); await page.waitForFunction(() => typeof window.go==='function');
    await page.evaluate(() => go('settings'));
    await page.waitForSelector('#tab-settings:not([hidden])');
  }

  // 1) склад колонки в браузері + міграція src→bank
  await openWith('src');
  assert.deepEqual(await page.$$eval('#setNav .setit', b => b.map(x => x.dataset.sec)),
    BROWSER_SECS, 'браузер: без upd і run');
  assert.equal(await page.evaluate(() => SETSEC), 'bank', 'міграція src→bank');
  assert.equal(await page.locator('#setSeg').count(), 0, '#setSeg прибрано');

  // 2) app → data, сміття → перший видимий
  for (const [old, exp] of [['app','data'], ['zzz','bank'], ['upd','bank']]) {
    await openWith(old);
    assert.equal(await page.evaluate(() => SETSEC), exp, `міграція ${old}→${exp}`);
  }

  // 3) кожна видима панель непорожня, рівно одна панель видима
  await openWith('src');
  for (const k of BROWSER_SECS) {
    await page.evaluate(s => go2set(s), k);
    const r = await page.evaluate(() => {
      const vis = [...document.querySelectorAll('#tab-settings .setpane')].filter(p => !p.hidden && p.offsetParent !== null);
      const p = vis[0];
      return {n: vis.length, sec: p && p.dataset.sec,
        content: !!p && [...p.children].some(c => !c.matches('.setttl,.setsub') && !c.hidden && c.offsetHeight > 0),
        ttl: p && p.querySelector('.setttl').textContent.trim(), sub: p && p.querySelector('.setsub').textContent.trim()};
    });
    assert.equal(r.n, 1, `${k}: видима рівно одна панель`);
    assert.equal(r.sec, k);
    assert.ok(r.content, `${k}: панель має видимий вміст`);
    assert.ok(r.ttl && r.sub, `${k}: заголовок і підзаголовок`);
  }

  // 3б) структура: кожна панель у .setmain, id із даних/бекапу — у своїх панелях, чужі не бачать
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.setpane')].filter(p => p.parentElement.className !== 'setmain').length), 0, 'браузер: кожна .setpane у .setmain');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.setwrap > :not(.setside):not(.setmain)').length), 0, 'браузер: у .setwrap лише .setside і .setmain');
  for (const [k, ids] of Object.entries({bank: ['pvImport'], data: ['bkNow','expCsv','quality'], rules: ['workCats'], priv: ['privacyOptions']})) {
    assert.deepEqual(await page.evaluate(([k, ids]) => ids.filter(i => document.getElementById(i).closest('.setpane')?.dataset.sec !== k), [k, ids]), [], `браузер: id ${k} у своїй панелі`);
  }
  await page.evaluate(() => go2set('loc'));
  assert.equal(await page.locator('#bkNow').isVisible(), false, 'браузер: #bkNow не видно в чужій панелі');

  // 4) клік по rules: aria-current, вміст, колонка не зсунулась
  await page.evaluate(() => go2set('bank'));
  const nav = () => page.evaluate(() => { const r = document.getElementById('setNav').getBoundingClientRect();
    return [...document.querySelectorAll('#setNav .setit')].map(b => { const q = b.getBoundingClientRect(); return [q.x,q.y,q.width,q.height]; })
      .concat([[r.x,r.y,r.width,r.height]]); });
  const before = await nav();
  await page.locator('#setNav .setit[data-sec="rules"]').click();
  const after = await nav();
  before.forEach((b,i) => b.forEach((v,j) => assert.ok(Math.abs(v-after[i][j]) < 0.5, 'ліва колонка не зсунулась')));
  assert.equal(await page.getAttribute('#setNav .setit[data-sec="rules"]', 'aria-current'), 'page');
  assert.equal(await page.locator('#setNav [aria-current="page"]').count(), 1);
  assert.ok(await page.locator('#workCats').isVisible() && await page.locator('#rBody').isVisible(), 'rules: видно workCats і rBody');
  assert.equal(await page.evaluate(() => SETSEC), 'rules');
  // колонка будується один раз: вузол кнопки переживає render()
  await page.evaluate(() => { window.__b = document.querySelector('#setNav .setit[data-sec="rules"]'); render(); });
  assert.ok(await page.evaluate(() => window.__b === document.querySelector('#setNav .setit[data-sec="rules"]')), 'render() не перебудовує колонку');

  // 4б) липка колонка: гортаємо довгу панель, клікаємо коротку — документ стискається,
  // прокрутка клампиться, і нелипка колонка стрибнула б відносно вікна. Обидві теми.
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await page.evaluate(() => go2set('rules'));
    await page.evaluate(() => scrollTo(0, 200));
    await page.waitForFunction(() => scrollY > 100);
    const navTop = () => page.evaluate(() => document.querySelector('.setside').getBoundingClientRect().y);
    const y0 = await navTop();
    await page.locator('#setNav .setit[data-sec="loc"]').click();
    const y1 = await navTop();
    assert.ok(Math.abs(y0 - y1) < 0.5, `${theme}: колонка зсунулась ${y0} → ${y1}`);
    assert.ok(y1 >= 0 && y1 < 40, `${theme}: колонка в межах вікна (${y1})`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; go2set('rules'); });

  // 5) усі старі id на місці
  const missing = await page.evaluate(ids => ids.filter(i => !document.getElementById(i)), IDS);
  assert.deepEqual(missing, [], 'втрачені id');

  // 6) updPending — заглушка
  assert.equal(await page.evaluate(() => updPending()), false);
  assert.equal(await page.locator('#setNav .setcnt:visible').count(), 0, 'бейдж сховано');

  // 7) перемикачі, рядки, дозволи приватності (браузер)
  await checkSwitches(page, ['divNotifyCk','newsUk','bkAuto'], 'браузер');
  await page.evaluate(() => go2set('loc'));
  await page.locator('#newsUk').click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('newsUk'))), false, 'newsUk пишеться у сховище');
  await page.locator('#newsUk').click();
  await page.evaluate(() => go2set('data'));
  await page.locator('#bkAuto').click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('backupAuto'))), false, 'backupAuto пишеться у сховище');
  await page.locator('#bkAuto').click();
  await page.evaluate(() => go2set('priv'));
  assert.equal(await page.locator('[data-privacy]').count(), 6, 'рівно 6 [data-privacy]');
  assert.deepEqual(await page.$$eval('[data-privacy]', b => b.map(x => [x.tagName, x.classList.contains('sw'), x.getAttribute('role'), !!x.getAttribute('aria-label'), x.textContent.trim()])),
    Array(6).fill(['BUTTON', true, 'switch', true, '']), 'дозволи — button.sw[role=switch] з назвою без тексту');
  {
    const q = page.locator('[data-privacy="quotes"]');
    const b0 = await docBox(q);
    const was = await q.getAttribute('aria-pressed');
    await q.click();
    assert.notEqual(await q.getAttribute('aria-pressed'), was, 'клік перемикає aria-pressed');
    assert.deepEqual(await docBox(q), b0, 'дозвіл не змінює розмір');
    await q.click();
    assert.equal(await q.getAttribute('aria-pressed'), was);
  }
  for (const id of ['moveMode', 'baseCcy'])
    assert.equal(await page.locator('#' + id).evaluate(e => !!e.closest('.csel') && e.closest('.setrow') !== null), true, `#${id} — .csel усередині рядка`);
  for (const t of ['dark', 'light']) {
    await page.evaluate(x => { document.documentElement.dataset.theme = x; }, t);
    for (const sec of ['notif', 'loc', 'priv', 'data', 'rules']) await checkRowsFlat(page, sec, 'браузер ' + t);
    for (const sec of ['priv', 'data', 'notif']) {
      await page.evaluate(x => go2set(x), sec);
      await page.locator('.setpane:not([hidden])').screenshot({path: path.join(output, `settings-${sec}-${t}.png`)});
    }
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; go2set('rules'); });
  // Попередження з абзаців не загубились.
  assert.equal(await page.evaluate(() => {
    const t = id => document.getElementById(id).closest('.setpane').textContent;
    return [['bkNow','8 останніх копій'], ['pinBtn','не шифрування'], ['pinBtn','pinHash'], ['moveMode','лише перекази між власними рахунками']]
      .filter(([i, w]) => !t(i).includes(w)).length; }), 0, 'попередження збережено в панелях');

  // ── Пошук і вузький екран (браузер) ────────────────────────────────
  await openWith('src');
  await checkSearch(page, 'браузер/1400', BROWSER_SECS);
  await page.setViewportSize({width: 390, height: 844});
  await checkNarrow(page, 'браузер/390');
  for (const w of [390, 768]) {
    await page.setViewportSize({width: w, height: 900});
    for (const k of BROWSER_SECS) {
      await page.evaluate(s => go2set(s), k);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${w}: ${k} без горизонтального скролу`);
    }
    await page.evaluate(() => { go('overview'); go('settings'); });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${w}: список без горизонтального скролу`);
  }
  // 760–859: вже одна колонка (дві колонки — від 860)
  await page.setViewportSize({width: 800, height: 900});
  await page.evaluate(() => go2set('loc'));
  assert.deepEqual(await page.evaluate(() => [document.getElementById('setNav').offsetParent !== null, document.querySelectorAll('#tab-settings .setpane:not([hidden])').length, document.getElementById('setBack').offsetParent !== null]), [false, 1, true], '800: одна колонка');
  await page.setViewportSize({width: 1400, height: 900});
  assert.deepEqual(await page.evaluate(() => [document.getElementById('setNav').offsetParent !== null, document.getElementById('setBack').offsetParent !== null]), [true, false], '1400: дві колонки, кнопки «назад» немає');

  assert.deepEqual(errors, [], 'помилки JavaScript або консолі');

  // ── Десктоп (1400×900): вставки лежать у своїх панелях ──────────────
  {
    const {ctx, page: dp, errors: derr} = await openDesktop(browser, {width: 1400, state: {setSec: 'app'}});
    // setSec='app' зі старого стану → 'upd' (міграція)
    await dp.evaluate(() => go('settings'));
    await dp.waitForSelector('#tab-settings:not([hidden])');
    assert.equal(await dp.evaluate(() => SETSEC), 'upd', 'десктоп: app → upd');
    assert.deepEqual(await dp.$$eval('#setNav .setit', b => b.map(x => x.dataset.sec)),
      ['upd','bank','inv','rules','notif','loc','priv','run','data','adv'], 'десктоп: 10 пунктів');
    // Що має бути ВИДНО в кожній панелі.
    const SHOWN = {
      upd: ['updCheck','updHeroBtn','updAuto'],
      bank: ['monoTok','pvImport'],
      inv: ['ibkrTok','binKey'],
      run: ['autoStart','autoSync','quietFrom'],
      data: ['openDir','dirPick','bkNow','dirBlock'],
    };
    for (const [k, ids] of Object.entries(SHOWN)) {
      await dp.evaluate(s => go2set(s), k);
      assert.equal(await dp.evaluate(() => SETSEC), k);
      const r = await dp.evaluate(ids => ({
        vis: [...document.querySelectorAll('#tab-settings .setpane')].filter(p => !p.hidden && p.offsetParent !== null).map(p => p.dataset.sec),
        ids: Object.fromEntries(ids.map(i => { const e = document.getElementById(i); return [i, !!e && e.offsetParent !== null && !e.closest('[hidden]')]; })),
      }), ids);
      assert.deepEqual(r.vis, [k], `${k}: видима одна панель`);
      for (const i of ids) assert.ok(r.ids[i], `${k}: #${i} видно`);
      assert.deepEqual(await dp.evaluate(ids => ids.filter(i => document.getElementById(i).closest('.setpane')?.dataset.sec !== SETSEC), ids), [], `${k}: усі id усередині своєї панелі`);
    }
    assert.equal(await dp.evaluate(() => [...document.querySelectorAll('.setpane')].filter(p => p.parentElement.className !== 'setmain').length), 0, 'десктоп: кожна .setpane у .setmain');
    assert.equal(await dp.evaluate(() => document.querySelectorAll('.setwrap > :not(.setside):not(.setmain)').length), 0, 'десктоп: у .setwrap лише .setside і .setmain');
    await dp.evaluate(() => go2set('loc'));
    assert.equal(await dp.locator('#bkNow').isVisible(), false, 'десктоп: #bkNow не видно в чужій панелі');
    // Тека даних — всередині #dirBlock у панелі data, а автозапуск — у run.
    assert.equal(await dp.evaluate(() => ['openDir','dirPick','dirReset','dirPath','dirFiles']
      .every(i => document.getElementById(i).closest('#dirBlock') && document.getElementById(i).closest('.setpane').dataset.sec === 'data')), true, 'тека → data/#dirBlock');
    assert.equal(await dp.evaluate(() => !document.getElementById('autoStart').closest('#dirBlock')
      && document.getElementById('autoStart').closest('.setpane').dataset.sec === 'run'), true, 'автозапуск → run');
    // Примітки браузерної збірки приховані, мертвих data-sec на картках немає.
    assert.equal(await dp.evaluate(() => el('invNote').hidden && el('srcNote').hidden), true, 'invNote і srcNote приховані');
    assert.equal(await dp.locator('#tab-settings .card[data-sec]').count(), 0, 'жодної картки з data-sec');
    assert.equal(await dp.evaluate(() => { const a = [...document.querySelectorAll('[id]')].map(e => e.id); return a.length - new Set(a).size; }), 0, 'без дублікатів id');
    // Панель з одними прихованими примітками не вважається непорожньою.
    assert.equal(await dp.evaluate(() => {
      const pane = document.createElement('section'); pane.className = 'setpane'; pane.dataset.sec = 'zz';
      pane.innerHTML = '<h2 class="setttl">t</h2><p class="setsub">s</p><div class="card" id="zzn" hidden></div>';
      document.querySelector('#tab-settings .setmain').appendChild(pane);
      const r = setPaneHasContent('zz'); pane.remove(); return r; }), false, 'setPaneHasContent ігнорує приховане');

    // Глибокі посилання. Тригери goMono / onTraySync / майстер / [data-invgo*]
    // важко запустити в фікстурі (потрібні порожні TX, трей, перший запуск, відсутні
    // ключі), тому: (1) у зібраному коді саме ці виклики ведуть у 'bank'/'inv', і
    // (2) go2set із цими аргументами приземляється на панель із потрібною карткою.
    const built = fs.readFileSync(path.join(root, 'desktop', 'dist', 'app.js'), 'utf8')
      + fs.readFileSync(path.join(root, 'desktop', 'dist', 'index.html'), 'utf8');
    assert.ok(!/go2set\('(src|app)'\)/.test(built), 'жодних go2set(src|app)');
    assert.ok(/gm\.onclick = \(\)=>go2set\('bank'\)/.test(built), 'goMono → bank');
    assert.ok(/onTraySync\(\(\)=>\{ go2set\('bank'\)/.test(built), 'onTraySync → bank');
    assert.ok(/\[data-invgo\]'\)\.forEach\(g=>g\.onclick=\(\)=>go2set\('inv'\)\)/.test(built), 'data-invgo → inv');
    assert.ok(/\[data-invgo2\]'\); if\(g2\) g2\.onclick = \(\)=>go2set\('inv'\)/.test(built), 'data-invgo2 → inv');
    assert.ok(/go2set\('bank'\); store\.set\('wizDone'/.test(built), 'майстер → bank');
    for (const [name, sec, id] of [['goMono / onTraySync / майстер', 'bank', 'monoTok'], ['invgo / invgo2', 'inv', 'ibkrTok']]) {
      await dp.evaluate(() => go2set('rules'));
      await dp.evaluate(s => go2set(s), sec);
      assert.equal(await dp.evaluate(() => SETSEC), sec, `${name}: панель ${sec}`);
      assert.ok(await dp.locator('#' + id).isVisible(), `${name}: #${id} видно`);
    }

    // Перемикачі й рядки в десктопі. autoStart: стаб IPC, щоб клік не лишив «неочікуваної команди».
    await dp.evaluate(() => { window.__DESK__.autostartOn = () => {}; window.__DESK__.autostartOff = () => {}; });
    await checkSwitches(dp, ['divNotifyCk','newsUk','bkAuto','autoStart'], 'десктоп');
    assert.equal(await dp.locator('[data-privacy]').count(), 6, 'десктоп: рівно 6 [data-privacy]');
    for (const t of ['dark', 'light']) {
      await dp.evaluate(x => { document.documentElement.dataset.theme = x; }, t);
      for (const sec of ['run', 'data', 'priv']) await checkRowsFlat(dp, sec, 'десктоп ' + t);
      for (const sec of ['run', 'data', 'priv']) {
        await dp.evaluate(x => go2set(x), sec);
        await dp.locator('.setpane:not([hidden])').screenshot({path: path.join(output, `settings-desk-${sec}-${t}.png`)});
      }
    }
    await dp.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    // Картки «Застосунок» немає, лишилися групи; autoSyncInfo — опис рядка, тека — у #dirBlock.
    assert.equal(await dp.evaluate(() => /Застосунок/.test([...document.querySelectorAll('.setpane[data-sec="run"] h2:not(.setttl)')].map(x => x.textContent).join())), false, 'run: без картки «Застосунок»');
    assert.equal(await dp.evaluate(() => document.getElementById('autoSyncInfo').closest('.setrow') !== null), true, 'autoSyncInfo — опис рядка');
    assert.equal(await dp.evaluate(() => ['autoSync','autoIbkr'].every(i => document.getElementById(i).closest('.csel'))), true, 'autoSync/autoIbkr — .csel');
    assert.equal(await dp.evaluate(() => document.getElementById('dirBlock').querySelectorAll('.setrow').length >= 2), true, '#dirBlock складається з рядків');

    // Значок «Запуск»: фон не збігається з поверхнею колонки/сторінки в обох темах
    // і тримає ≥ 3:1 під білим штрихом.
    for (const theme of ['dark', 'light']) {
      await dp.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      const c = await dp.evaluate(() => ({
        ico: getComputedStyle(document.querySelector('#setNav .setit[data-sec="run"] .setico')).backgroundColor,
        grp: getComputedStyle(document.querySelector('.setnavg')).backgroundColor,
        page: getComputedStyle(document.body).backgroundColor }));
      assert.notEqual(c.ico, c.grp, `${theme}: значок run ≠ поверхня колонки`);
      assert.notEqual(c.ico, c.page, `${theme}: значок run ≠ тло сторінки`);
      const lum = rgb => { const v = rgb.match(/\d+/g).slice(0,3).map(n => { n /= 255; return n <= .03928 ? n/12.92 : ((n+.055)/1.055)**2.4; }); return .2126*v[0]+.7152*v[1]+.0722*v[2]; };
      const ratio = 1.05 / (lum(c.ico) + .05);
      assert.ok(ratio >= 3, `${theme}: білий штрих на значку run ≥ 3:1 (${ratio.toFixed(2)})`);
      const gr = (lum(c.ico) + .05), gs = (lum(c.grp) + .05);
      const sq = Math.max(gr, gs) / Math.min(gr, gs);
      assert.ok(sq >= 3, `${theme}: квадрат run проти поверхні колонки ≥ 3:1 (${sq.toFixed(2)})`);
    }
    await dp.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    assert.deepEqual(derr, [], 'десктоп: помилки JavaScript');
    assert.deepEqual(await dp.evaluate(() => window.__unexpectedCommands), [], 'десктоп: неочікувані команди IPC');
    await ctx.close();
  }

  // ── Розділ «Оновлення» (Task 4): картка-стан, бейдж, перемикач ─────────
  {
    const rectOf = (pg, sel) => pg.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect();
      return [r.x + scrollX, r.y + scrollY, r.width, r.height]; }, sel);
    const same = (a, b, m) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 0.5, `${m}: ${a} → ${b}`));
    const badge = pg => pg.evaluate(() => document.getElementById('updHeroBadge').textContent.trim());
    const pend = pg => pg.evaluate(() => ({
      cnt: (() => { const c = document.querySelector('#setNav .setcnt'); return c && !c.hidden && c.offsetParent !== null ? c.textContent.trim() : null; })(),
      dot: (() => { const d = document.querySelector('#tabs [data-tab="settings"] .navdot'); return !!d && !d.hidden && d.offsetParent !== null; })(),
      av: store.get('updAvail', null) }));
    const {ctx, page: up, errors: uerr} = await openDesktop(browser, {width: 1400, state: {setSec: 'upd', updAvail: {version: '9.9.9'}}});
    await up.evaluate(() => go('settings'));
    await up.waitForSelector('#updHero');
    // a) збережена знайдена версія → «1» у колонці, крапка на шестерні, картка «Нова версія»
    await up.waitForFunction(() => !document.querySelector('#setNav .setcnt').hidden);
    let st = await pend(up);
    assert.equal(st.cnt, '1', 'a: бейдж «1» на пункті Оновлення');
    assert.equal(st.dot, true, 'a: крапка на шестерні');
    assert.equal(await badge(up), 'Нова версія', 'a: картка — нова версія');
    assert.equal(await up.locator('#updHeroTitle').textContent(), 'Гроші 9.9.9');
    assert.equal(await up.evaluate(() => document.querySelector('#tabs [data-tab="settings"] .navdot').getAttribute('aria-hidden')), 'true', 'крапка aria-hidden');
    const heroA = await rectOf(up, '#updHero'), navA = await rectOf(up, '#setNav');
    const gearA = await rectOf(up, '#tabs [data-tab="settings"]');
    const gcapSel = '.setpane[data-sec="upd"] .setgcap';
    const gcapA = await rectOf(up, gcapSel);
    // e) картка, перший підпис групи, колонка й шестерня не рухаються в жодному стані
    const chk = async m => { same(heroA, await rectOf(up, '#updHero'), m + ': #updHero');
      same(navA, await rectOf(up, '#setNav'), m + ': #setNav');
      same(gcapA, await rectOf(up, gcapSel), m + ': перший .setgcap');
      same(gearA, await rectOf(up, '#tabs [data-tab="settings"]'), m + ': кнопка шестерні'); };
    // b) «найновіша» скидає updAvail, бейдж і крапка зникають
    await up.evaluate(() => { window.__updFixture = {available: false, current: 'test', version: 'test'}; });
    await up.locator('#updCheck').click();
    await up.waitForFunction(() => document.getElementById('updHeroBadge').textContent.trim() === 'Найновіша');
    st = await pend(up);
    assert.deepEqual([st.cnt, st.dot, st.av], [null, false, null], 'b: бейдж, крапка й updAvail скинуті');
    await chk('e/b');
    assert.ok(await up.evaluate(() => /Остання перевірка: (сьогодні|\d)/.test(document.getElementById('updLastTxt').textContent)), 'b: «Остання перевірка» оновлено');
    // c) нова версія → кнопка встановлення → uiConfirm → update_install з файлом
    await up.evaluate(() => { window.__updFixture = {available: true, current: 'test', version: '9.9.9', file: 'x.exe', notes: 'n'}; });
    await up.locator('#updCheck').click();
    await up.waitForFunction(() => document.getElementById('updHeroBadge').textContent.trim() === 'Нова версія');
    assert.equal(await up.locator('#updHeroTitle').textContent(), 'Гроші 9.9.9');
    assert.equal(await up.locator('#updHeroBtn').textContent(), 'Встановити й перезапустити');
    assert.equal((await pend(up)).cnt, '1', 'c: бейдж повернувся');
    assert.equal(await up.locator('#updNotes').isVisible(), true, 'c: нотатки релізу під карткою');
    await chk('e/c');
    await up.locator('#updHeroBtn').click();
    await up.getByRole('button', {name: 'Встановити', exact: true}).click();
    await up.waitForFunction(() => window.__updInstalled);
    assert.equal(await up.evaluate(() => window.__updInstalled.file), 'x.exe', 'c: update_install отримав файл');
    // d) помилка перевірки — крапка warn і текст
    // У застосунку інсталятор закриває апку; фікстура лишає її живою, тож знімаємо стан «Готую…».
    await up.evaluate(() => { UPD.st = 'idle'; updHeroUi(); });
    await up.evaluate(() => { window.__updError = 'мережа ' + 'дуже довга помилка '.repeat(11); });
    await up.locator('#updCheck').click();
    await up.waitForSelector('#updHero .dot.warn');
    assert.ok((await up.locator('#updHero').textContent()).includes('мережа'), 'd: текст помилки в картці');
    await chk('e/d');
    await up.evaluate(() => { window.__updError = null; });
    // 3) джерело в полі змінилось після перевірки: встановлення не викликається, перевірка — так
    await up.evaluate(() => { window.__updFixture = {available: false, current: 'test', version: 'test'}; window.__updInstalled = undefined; window.__updChecks = [];
      store.set('updAvail', {version: '9.9.9', file: 'x.exe', notes: '', source: 'github:A/B', at: Date.now()}); UPD.st = 'idle'; updBadgeUi(); updHeroUi();
      document.getElementById('updSrc').value = 'github:C/D'; });
    await up.locator('#updHeroBtn').click();
    await up.waitForFunction(() => window.__updChecks.length > 0);
    assert.equal(await up.evaluate(() => window.__updInstalled), undefined, 'інше джерело: update_install не викликано');
    assert.equal(await up.evaluate(() => window.__updChecks[0].source), 'github:C/D', 'інше джерело: перевірка з новим джерелом');
    // та сама перевірка скинула бейдж; повертаємо стан для наступних кроків
    await up.evaluate(() => { document.getElementById('updSrc').value = ''; });
    // f) перемикач «Перевіряти оновлення» = той самий дозвіл, що в «Приватності»
    assert.equal(await up.locator('[data-privacy]').count(), 6, 'f: рівно 6 [data-privacy] (#updAuto без атрибута)');
    assert.equal(await up.evaluate(() => document.getElementById('updAuto').hasAttribute('data-privacy')), false);
    const sw = up.locator('#updAuto');
    assert.deepEqual(await sw.evaluate(e => [e.tagName, e.classList.contains('sw'), e.getAttribute('role')]), ['BUTTON', true, 'switch']);
    const was = await sw.getAttribute('aria-pressed');
    const sb = await docBox(sw);
    await sw.click();
    await up.waitForFunction(w => document.getElementById('updAuto').getAttribute('aria-pressed') !== w && !document.getElementById('updAuto').disabled, was);
    assert.equal(await up.evaluate(() => privacyAllowed('updates')), was !== 'true', 'f: перемикач міняє privacyAllowed("updates")');
    assert.equal(await up.evaluate(() => document.querySelector('[data-privacy="updates"]').getAttribute('aria-pressed')), await sw.getAttribute('aria-pressed'), 'f: «Приватність» показує той самий стан');
    assert.deepEqual(await docBox(sw), sb, 'f: перемикач не змінює розмір');
    // фокус: на ввімкненому перемикачі лише контур, без inset-тіні --accent-line
    if (await sw.getAttribute('aria-pressed') !== 'true') { await sw.click(); await up.waitForFunction(() => document.getElementById('updAuto').getAttribute('aria-pressed') === 'true' && !document.getElementById('updAuto').disabled); }
    await up.keyboard.press('Tab'); await sw.focus();
    const fv = await sw.evaluate(e => ({m: e.matches(':focus-visible'), sh: getComputedStyle(e).boxShadow}));
    assert.equal(fv.m, true, 'фокус клавіатурний'); assert.equal(fv.sh, 'none', 'ввімкнений .sw у фокусі без inset-тіні');
    // доступність: кожен .sw має aria-describedby на наявний опис
    await up.evaluate(() => go2set('priv'));
    assert.deepEqual(await up.evaluate(() => [...document.querySelectorAll('.sw')].filter(e => { const d = e.getAttribute('aria-describedby'); return !d || !document.getElementById(d) || !document.getElementById(d).textContent.trim(); }).map(e => e.id || e.dataset.privacy)), [], 'десктоп: кожен .sw має aria-describedby');
    // джерело: «Змінити» розкриває поле й «Обрати теку» в рядку
    await up.evaluate(() => go2set('upd'));
    assert.equal(await up.locator('#updSrc').isVisible(), false, 'поле джерела згорнуте');
    await up.locator('#updSrcEdit').click();
    assert.ok(await up.locator('#updSrc').isVisible() && await up.locator('#updPick').isVisible(), '«Змінити» розкриває #updSrc і #updPick');
    assert.deepEqual(uerr, [], 'оновлення: помилки JavaScript');
    assert.deepEqual(await up.evaluate(() => window.__unexpectedCommands), [], 'оновлення: неочікувані команди IPC');
    await ctx.close();
    // e) те саме на ~480 px (кнопка окремим рядком) і з довгою помилкою: нічого не стрибає
    {
      const {ctx: c3, page: p3} = await openDesktop(browser, {width: 480, state: {setSec: 'upd', updAvail: {version: '9.9.9', file: 'x.exe', notes: 'н '.repeat(300), source: ''}}});
      await p3.evaluate(() => go2set('upd')); await p3.waitForSelector('#updHero');
      await p3.waitForFunction(() => window.__appVer === 'test' && !document.querySelector('#setNav .setcnt').hidden);
      // Нижня панель fixed: її координати міряємо у вікні, решту — від початку документа.
      const sels = ['#updHero', '#setNav', gcapSel];
      const gearV = () => p3.evaluate(() => { const r = document.querySelector('#tabs [data-tab="settings"]').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
      const snap = async () => [...await Promise.all(sels.map(s => rectOf(p3, s))), await gearV()];
      const base3 = await snap();
      const step = async (m, fx, err) => {
        await p3.evaluate(([f, e]) => { window.__updFixture = f; window.__updError = e; }, [fx, err]);
        await p3.locator('#updCheck').click();
        await p3.waitForFunction(() => !document.getElementById('updCheck').disabled);
        (await snap()).forEach((r, i) => same(base3[i], r, `480/${m}: ${sels[i] || 'шестерня'}`));
      };
      await step('ok', {available: false, current: 'test', version: 'test'}, null);
      await step('new', {available: true, current: 'test', version: '9.9.9', file: 'x.exe', notes: 'n'}, null);
      await step('err', null, 'мережа ' + 'x'.repeat(200));
      assert.ok((await p3.locator('#updHero').textContent()).includes('мережа'), '480: текст помилки в картці');
      await c3.close();
    }
    // g) поточна версія в updAvail — бейджа немає
    {
      const {ctx: c2, page: p2} = await openDesktop(browser, {width: 1400, state: {setSec: 'upd', updAvail: {version: 'test'}}});
      await p2.evaluate(() => go('settings')); await p2.waitForSelector('#updHero');
      await p2.waitForFunction(() => window.__appVer === 'test');
      st = await pend(p2);
      assert.deepEqual([st.cnt, st.dot], [null, false], 'g: застарілого бейджа й крапки немає');
      assert.notEqual(await badge(p2), 'Нова версія', 'g: картка не «нова версія»');
      await c2.close();
    }
    // Звичайний вхід у «Налаштування» з очікуваною новою версією відкриває «Оновлення»;
    // без неї лишається збережений розділ.
    for (const [upd, exp] of [[{version: '9.9.9', notes: ''}, 'upd'], [null, 'loc']]) {
      const {ctx: c3, page: p3} = await openDesktop(browser, {width: 1400, state: upd ? {setSec: 'loc', updAvail: upd} : {setSec: 'loc'}});
      await p3.waitForFunction(() => window.__appVer);
      await p3.evaluate(() => go('settings'));
      assert.equal(await p3.evaluate(() => SETSEC), exp, `вхід у налаштування: ${upd ? 'є' : 'немає'} оновлення → ${exp}`);
      await c3.close();
    }
    // «Дані і бекап»: список файлів компактний — «Бекап» видно на першому екрані.
    {
      const {ctx: c6, page: p6} = await openDesktop(browser, {width: 1400, height: 900, state: {setSec: 'data'}});
      await p6.evaluate(() => go('settings')); await p6.waitForSelector('#dirFiles .dirrow');
      await p6.evaluate(() => scrollTo(0, 0));
      const top = await p6.evaluate(() => document.querySelector('#bkCard .setgcap').getBoundingClientRect().top);
      const vh = await p6.evaluate(() => innerHeight);
      assert.ok(top < vh, `data: підпис групи «Бекап» на першому екрані (top ${Math.round(top)} < ${vh})`);
      await c6.close();
    }
    // Пошук і вузький екран (десктоп)
    {
      const {ctx: c4, page: p4, errors: e4} = await openDesktop(browser, {width: 1400});
      await p4.evaluate(() => go('settings')); await p4.waitForSelector('#tab-settings:not([hidden])');
      await checkSearch(p4, 'десктоп/1400', ['upd','bank','inv','rules','notif','loc','priv','run','data','adv']);
      assert.deepEqual(e4, [], 'десктоп/1400 пошук: помилки');
      await c4.close();
    }
    {
      const {ctx: c5, page: p5, errors: e5} = await openDesktop(browser, {width: 390, height: 844});
      await checkNarrow(p5, 'десктоп/390');
      assert.deepEqual(e5, [], 'десктоп/390: помилки');
      await c5.close();
    }
  }
  await page.screenshot({path: path.join(output, 'settings-nav.png')});
  console.log('settings: пошук, вузький екран, 8 пунктів у браузері, 10 у десктопі з вставками у своїх панелях, міграція setSec, глибокі посилання, значок run — OK');
  await context.close();
} finally {
  await browser.close();
}
