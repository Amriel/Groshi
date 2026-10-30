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
  assert.equal(await page.evaluate(() => document.querySelectorAll('.setwrap > :not(.setnav):not(.setmain)').length), 0, 'браузер: у .setwrap лише nav і main');
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
      upd: ['updCheck','updSrc'],
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
    assert.equal(await dp.evaluate(() => document.querySelectorAll('.setwrap > :not(.setnav):not(.setmain)').length), 0, 'десктоп: у .setwrap лише nav і main');
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
  await page.screenshot({path: path.join(output, 'settings-nav.png')});
  console.log('settings: 8 пунктів у браузері, 10 у десктопі з вставками у своїх панелях, міграція setSec, глибокі посилання, значок run — OK');
  await context.close();
} finally {
  await browser.close();
}
