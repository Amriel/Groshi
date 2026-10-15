// Каркас: розкладки на межах ширини, клавіші, меню «Ще», звуження панелі.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'app/Groshi_app.html')).href;
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const errors = [];
async function open(width, height = 800) {
  const ctx = await browser.newContext({viewport: {width, height}});
  await ctx.addInitScript(() => localStorage.setItem('wizDone', 'true'));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => typeof window.go === 'function');
  await page.waitForTimeout(300);
  return {ctx, page};
}
const layout = page => page.evaluate(() => {
  const vis = n => !!n && n.offsetParent !== null && getComputedStyle(n).visibility !== 'hidden';
  const btns = [...document.querySelectorAll('#tabs button')].filter(vis).map(b => b.dataset.tab);
  const side = document.getElementById('side').getBoundingClientRect();
  const nav = document.getElementById('tabs').getBoundingClientRect();
  const shown = [...document.querySelectorAll('#tabs button')].filter(vis);
  return {btns, sideW: Math.round(side.width), navBottom: Math.round(nav.bottom), vh: innerHeight,
    navH: Math.round(nav.height),
    labels: [...document.querySelectorAll('#tabs .nl')].some(vis),
    // підпис кожної видимої кнопки: видимий, непорожній і не обрізаний по висоті
    allLabels: shown.every(b => { const n = b.querySelector('.nl');
      return vis(n) && n.textContent.trim() !== '' && n.scrollHeight <= n.clientHeight + 1 &&
        n.getBoundingClientRect().bottom <= b.getBoundingClientRect().bottom + 0.5; }),
    collapsed: document.getElementById('shell').classList.contains('collapsed'),
    navFixed: getComputedStyle(document.getElementById('tabs')).position === 'fixed',
    hscroll: document.documentElement.scrollWidth > innerWidth};
});
try {
  // межі: 759 нижні таби, 760 і 999 іконкова панель, 1000 повна
  const cases = [
    [759, {n: 5, fixed: true}], [760, {n: 7, w: 64, labels: false}],
    [999, {n: 7, w: 64, labels: false}], [1000, {n: 7, w: 220, labels: true}],
    [1400, {n: 7, w: 220, labels: true}],
  ];
  for (const [w, exp] of cases) {
    const {ctx, page} = await open(w);
    const l = await layout(page);
    assert.equal(l.btns.length, exp.n, `${w}px: видимих пунктів ${l.btns.length}, очікувано ${exp.n}`);
    if (exp.fixed) {
      assert.ok(l.navFixed, `${w}px: нижня панель не fixed`);
      assert.ok(Math.abs(l.navBottom - l.vh) <= 1, `${w}px: панель не прилягає до низу`);
      assert.deepEqual(l.btns, ['overview', 'tx', 'inv', 'subs', 'settings'], `${w}px: склад нижньої панелі`);
      // .collapsed ховає .nl і обнуляє відступи кнопок: у нижній панелі
      // його бути не може, а підписи мусять читатися.
      assert.ok(!l.collapsed, `${w}px: у нижніх табах #shell має клас collapsed`);
      assert.ok(l.allLabels, `${w}px: підписи нижньої панелі сховані, порожні чи обрізані`);
      // 56 px + безпечна зона (у Chromium на десктопі env() = 0)
      assert.ok(Math.abs(l.navH - 56) <= 1, `${w}px: висота нижньої панелі ${l.navH}, очікувано 56`);
    } else {
      assert.ok(!l.navFixed, `${w}px: панель мусить бути в потоці`);
      assert.ok(Math.abs(l.sideW - exp.w) <= 2, `${w}px: ширина панелі ${l.sideW}, очікувано ${exp.w}`);
      assert.equal(l.labels, exp.labels, `${w}px: підписи ${l.labels}`);
    }
    assert.ok(!l.hscroll, `${w}px: горизонтальний скрол сторінки`);
    await ctx.close();
  }

  // індикатор повторює активний пункт (десктоп)
  { const {ctx, page} = await open(1400);
    // Іконкова панель і нижні таби показують лише значок: без aria-label
    // зчитувач екрана озвучив би кнопку порожньою.
    const aria = await page.evaluate(() => {
      const nav = [...document.querySelectorAll('#tabs button')], foot = [...document.querySelectorAll('.side-foot button')];
      return {nav: nav.length, foot: foot.length,
        missing: [...nav, ...foot].filter(b => !(b.getAttribute('aria-label') || '').trim()).map(b => b.dataset.tab || b.id)};
    });
    // кількість — щоб перевірка не пройшла на порожній вибірці
    assert.equal(aria.nav, 7, `кнопок навігації ${aria.nav}, очікувано 7`);
    assert.equal(aria.foot, 4, `кнопок підвалу ${aria.foot}, очікувано 4`);
    assert.deepEqual(aria.missing, [], 'кнопки навігації без aria-label: ' + aria.missing.join(', '));
    for (const tab of ['overview', 'tx', 'settings']) {
      await page.evaluate(t => go(t), tab); await page.waitForTimeout(500);
      const d = await page.evaluate(() => {
        const a = document.querySelector('#tabs button[aria-current="true"]').getBoundingClientRect();
        const i = document.getElementById('tabInd').getBoundingClientRect();
        return {dy: Math.abs(a.top - i.top), dh: Math.abs(a.height - i.height)};
      });
      assert.ok(d.dy <= 1 && d.dh <= 1, `індикатор поза активним пунктом (${tab}): ${JSON.stringify(d)}`);
    }
    // клавіші 1–7 у порядку TABKEYS
    const keys = ['overview', 'cats', 'tx', 'budget', 'inv', 'subs', 'settings'];
    for (let i = 0; i < keys.length; i++) {
      await page.keyboard.press(String(i + 1)); await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => S.tab), keys[i], `клавіша ${i + 1} → ${keys[i]}`);
    }
    // звуження зберігається після перезавантаження
    await page.click('#navToggle'); await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => shellEl.classList.contains('collapsed')), 'панель не звузилась');
    await page.reload(); await page.waitForFunction(() => typeof window.go === 'function');
    assert.ok(await page.evaluate(() => shellEl.classList.contains('collapsed')), 'стан звуження не збережено');
    await ctx.close(); }

  // бейдж «Підписки» видно в усіх розкладках
  for (const w of [1400, 900, 390]) {
    const {ctx, page} = await open(w);
    // той самий шлях, яким бейдж ставить renderSubs()
    await page.evaluate(() => setSubsBadge(3));
    const shown = await page.evaluate(() => {
      const b = document.querySelector('#tabs [data-tab="subs"]');
      const c = getComputedStyle(b, '::after');
      return {content: c.content, display: c.display, label: b.getAttribute('aria-label')};
    });
    assert.ok(/3/.test(shown.content) && shown.display !== 'none', `${w}px: бейдж не видно (${JSON.stringify(shown)})`);
    // aria-label перекриває ::after, тож кількість мусить бути в мітці
    assert.equal(shown.label, 'Підписки, 3 до сплати', `${w}px: мітка «Підписок» без кількості`);
    if (w === 390) {
      await page.evaluate(() => setSubsBadge(0));
      assert.equal(await page.evaluate(() => document.querySelector('#tabs [data-tab="subs"]').getAttribute('aria-label')),
        'Підписки', 'мітка не повернулась до «Підписки» без бейджа');
    }
    await ctx.close();
  }

  // 390: меню «Ще», підсвітка «Ще» для прихованих розділів, Esc
  { const {ctx, page} = await open(390, 844);
    await page.click('#tabs [data-tab="settings"]'); await page.waitForTimeout(300);
    const rows = await page.evaluate(() => [...document.querySelectorAll('#modal .pickrow')].map(r => r.dataset.v));
    assert.deepEqual(rows, ['cats', 'budget', 'settings', 'theme', 'scrn'], 'склад меню «Ще»');
    await page.keyboard.press('Escape');
    // модалка ховається з затримкою 220 мс після анімації — чекаємо стан, а не час
    await page.waitForSelector('#modal', {state: 'hidden', timeout: 2000}).catch(() => {});
    assert.ok(await page.evaluate(() => document.getElementById('modal').hidden), 'Esc не закрив меню «Ще»');
    await page.click('#tabs [data-tab="settings"]'); await page.waitForTimeout(300);
    await page.click('#modal .pickrow[data-v="cats"]'); await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => S.tab), 'cats', 'вибір «Категорії» не відкрив екран');
    assert.equal(await page.evaluate(() => document.querySelector('#tabs [data-tab="settings"]').getAttribute('aria-current')),
      'true', 'у нижній панелі «Ще» не підсвічено для Категорій');
    // клавіша 4 (Кошториси) з клавіатури теж підсвічує «Ще»
    await page.evaluate(() => go('tx')); await page.keyboard.press('4'); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.querySelector('#tabs [data-tab="settings"]').getAttribute('aria-current')),
      'true', 'клавіша 4 не підсвітила «Ще»');
    await ctx.close(); }

  assert.deepEqual(errors, [], 'помилки JavaScript: ' + errors.join(' | '));
  console.log('навігація: межі 759/760/999/1000, клавіші, «Ще», звуження — OK');
} finally { await browser.close(); }
