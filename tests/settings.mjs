// Налаштування: ліва колонка розділів + панелі (каркас, Task 1).
// Ловить: пункти колонки відсутні/зайві в браузері, старий setSec ('src', 'app',
// сміття) веде на порожню панель, перемикання розділу зсуває колонку, при
// перенесенні карток губляться id полів.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

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

try {
  // Лише браузерна збірка: склад колонки в десктопі остаточно зберуть Task 2/4
  // (там з'являються upd і run); тут перевіряємо каркас і міграцію стану.
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
    const navTop = () => page.evaluate(() => document.getElementById('setNav').getBoundingClientRect().y);
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

  assert.deepEqual(errors, [], 'помилки JavaScript або консолі');
  await page.screenshot({path: path.join(output, 'settings-nav.png')});
  console.log('settings: колонка 8 пунктів у браузері, міграція setSec, панелі непорожні, колонка не смикається — OK');
  await context.close();
} finally {
  await browser.close();
}
