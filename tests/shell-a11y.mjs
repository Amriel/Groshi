// Системна тема без збереженого вибору, reduced-motion, фокус під модалкою,
// замок (PIN) поверх відкритого вікна.
// Кожен блок має контрольну умову, без якої він пройшов би порожньо:
// тема перевіряється в ОБОХ схемах (жорсткий 'dark' провалює світлу),
// reduced-motion порівнюється зі звичайним контекстом (180 мс), а модалка
// спершу мусить реально відкритися й тримати фокус, перш ніж рахувати Tab.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'app/Groshi_app.html')).href;
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const errors = [];
async function open(opts, init) {
  const ctx = await browser.newContext({viewport: {width: 1200, height: 800}, ...opts});
  await ctx.addInitScript(init || (() => localStorage.setItem('wizDone', 'true')));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await page.waitForFunction(() => typeof window.go === 'function');
  return {ctx, page};
}
const theme = page => page.evaluate(() => document.documentElement.dataset.theme);
// Де зараз фокус: у вікні, у панелі, у контенті чи деінде.
const where = page => page.evaluate(() => {
  const a = document.activeElement;
  return {modal: !!a.closest('#modal'), side: !!a.closest('#side'), wrap: !!a.closest('.wrap'),
    tag: a.tagName + (a.id ? '#' + a.id : '')};
});
const inertState = page => page.evaluate(() => ({
  side: document.getElementById('side').inert, wrap: document.querySelector('#shell .wrap').inert}));
const modalOpen = page => page.waitForFunction(() => {
  const m = document.getElementById('modal'); return !m.hidden && m.classList.contains('on'); },
  null, {timeout: 5000});
// Кадр після кожного Tab: обробники фокуса апки відкладають роботу на rAF
// (виділення числового поля), і без цього проба міряла б стан посеред кадру.
const frame = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));
const tab = async (page, key = 'Tab') => { await page.keyboard.press(key); await frame(page); };
const themeIs = (page, want, timeout = 3000) => page.waitForFunction(w => document.documentElement.dataset.theme === w,
  want, {timeout}).then(() => true, () => false);
const modalClosed = page => page.waitForFunction(() => document.getElementById('modal').hidden,
  null, {timeout: 5000});
try {
  // 1. системна тема: без збереженого вибору слідуємо prefers-color-scheme
  for (const [scheme, want] of [['light', 'light'], ['dark', 'dark']]) {
    const {ctx, page} = await open({colorScheme: scheme});
    assert.equal(await theme(page), want, `системна ${scheme}: застосунок показав іншу тему`);
    await ctx.close();
  }
  // 1б. явний вибір перебиває систему
  { const {ctx, page} = await open({colorScheme: 'light'}, () => {
      localStorage.setItem('wizDone', 'true'); localStorage.setItem('theme', '"dark"'); });
    assert.equal(await theme(page), 'dark', 'збережений вибір «темна» не переміг світлу систему');
    await ctx.close(); }
  // 1в. зміна теми ОС на ходу: без збереженого вибору — слідом, з вибором — ні
  { const {ctx, page} = await open({colorScheme: 'light'});
    assert.equal(await theme(page), 'light');
    await page.emulateMedia({colorScheme: 'dark'});
    assert.ok(await themeIs(page, 'dark'), 'зміна теми ОС не підхопилась без збереженого вибору');
    assert.equal(await page.evaluate(() => localStorage.getItem('theme')), null,
      'стеження за ОС не сміє записувати вибір — інакше воно вимкнеться саме');
    // кнопка теми — явний вибір: записується й зупиняє стеження
    await page.click('#themeBtn');
    assert.equal(await theme(page), 'light');
    assert.equal(await page.evaluate(() => localStorage.getItem('theme')), '"light"',
      'кнопка теми не зберегла явний вибір');
    await page.emulateMedia({colorScheme: 'light'});
    await page.emulateMedia({colorScheme: 'dark'});
    // чекаємо «неправильного» значення: якщо воно так і не настало — вибір устояв
    assert.ok(!(await themeIs(page, 'dark', 600)), 'зміна теми ОС перебила явний вибір користувача');
    await ctx.close(); }
  // 2. reduced-motion: переходи практично миттєві (контроль — звичайний контекст)
  const tabDur = page => page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('#tabs button')).transitionDuration) * 1000);
  { const {ctx, page} = await open({});
    const dur = await tabDur(page);
    assert.ok(dur >= 100, `контроль: без reduced-motion перехід кнопки ${dur} мс — проба нічого б не міряла`);
    await ctx.close(); }
  { const {ctx, page} = await open({reducedMotion: 'reduce'});
    const dur = await tabDur(page);
    assert.ok(dur <= 1, `reduced-motion: перехід кнопки ${dur} мс`);
    await ctx.close(); }
  // 3. модалка накриває панель і фокус не йде ні в навігацію, ні в контент
  { const {ctx, page} = await open({}, () => localStorage.removeItem('wizDone'));
    // майстер стартує через 1,4 с — чекаємо саме відкриття, а не фіксований час
    await modalOpen(page).catch(() => { throw new Error('майстер першого запуску не відкрився'); });
    await page.waitForTimeout(80);   // rAF: фокус на «Гаразд» ставиться після показу
    const st = await page.evaluate(() => {
      const m = document.getElementById('modal');
      const r = m.getBoundingClientRect(), nav = document.getElementById('side').getBoundingClientRect();
      const z = n => parseInt(getComputedStyle(n).zIndex) || 0;
      return {covers: r.left <= nav.left && r.right >= nav.right && r.top <= nav.top && r.bottom >= nav.bottom,
        zOk: z(m) > z(document.getElementById('side')) && z(m) > z(document.getElementById('tabs')),
        title: document.getElementById('modalT').textContent};
    });
    assert.ok(st.covers && st.zOk, 'модалка не накриває панель: ' + JSON.stringify(st));
    assert.match(st.title, /Вітаю/, 'відкрилось не вікно майстра: ' + st.title);
    assert.ok((await where(page)).modal, 'фокус після відкриття не у вікні: ' + JSON.stringify(await where(page)));
    assert.deepEqual(await inertState(page), {side: true, wrap: true}, 'панель і контент під вікном не inert');
    const seen = new Set();
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await tab(page, key);
      const w = await where(page);
      assert.ok(!w.side, `${key} під модалкою потрапив у навігацію (${w.tag})`);
      assert.ok(!w.wrap, `${key} під модалкою потрапив у контент (${w.tag})`);
      assert.ok(w.modal, `${key} вивів фокус із вікна (${w.tag})`);
      seen.add(w.tag);
    }
    // у вікні привітання дві кнопки — пастка мусить ходити по колу між ними
    assert.ok(seen.has('BUTTON#modalYes') && seen.has('BUTTON#modalNo'),
      'Tab не ходить по колу між кнопками вікна: ' + [...seen].join(','));
    // вікно слідом за вікном: Enter → крок 2; inert не сміє злетіти між ними
    await page.focus('#modalYes');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Крок 2/.test(document.getElementById('modalT').textContent),
      null, {timeout: 3000});
    await modalOpen(page);
    assert.deepEqual(await inertState(page), {side: true, wrap: true}, 'друге вікно поспіль лишилось без inert');
    // Esc закриває майстер — inert знято, панель знову доступна з клавіатури
    await page.keyboard.press('Escape');
    await modalClosed(page);
    assert.deepEqual(await inertState(page), {side: false, wrap: false}, 'inert лишився після Esc');
    const back = await page.evaluate(() => { const b = document.getElementById('themeBtn'); b.focus();
      return document.activeElement === b; });
    assert.ok(back, 'після закриття вікна кнопка панелі не фокусується');
    // решта шляхів закриття: тло, «Гаразд», «Скасувати»; і відмова другому вікну поверх першого
    for (const how of ['#modalBd', '#modalYes', '#modalNo']) {
      await page.evaluate(() => { window.__r = 'чекаю'; uiAsk({title: 'Проба', value: 'x'}).then(v => window.__r = v); });
      await modalOpen(page);
      // друге вікно поверх першого повертає null одразу — і не сміє зняти inert першого
      assert.equal(await page.evaluate(() => uiAsk({title: 'Зайве'})), null);
      assert.deepEqual(await inertState(page), {side: true, wrap: true}, 'відмова другому вікну зняла inert першого');
      for (let i = 0; i < 4; i++) {
        await tab(page);
        assert.ok((await where(page)).modal, `Tab у вікні з полем вивів фокус назовні (${how}, крок ${i})`);
      }
      await page.click(how, {position: how === '#modalBd' ? {x: 5, y: 5} : undefined});
      await modalClosed(page);
      assert.deepEqual(await inertState(page), {side: false, wrap: false}, `inert лишився після закриття через ${how}`);
    }
    await ctx.close(); }
  // 4. редактор рядків із випадайкою: Tab іде рядок за рядком і не зупиняється
  //    на схованому <select> (носієві значення .csel) — інакше пастка
  //    відкидала фокус на початок вікна, і другий рядок ставав недосяжним.
  { const {ctx, page} = await open({});
    await page.evaluate(() => { uiAsk({title: 'Рядки', rows: {cols: [{key: 't', kind: 'text'},
      {key: 'n', kind: 'num'}, {key: 'c', kind: 'select', options: ['UAH', 'USD']}],
      value: [{t: 'a', n: '1', c: 'UAH'}, {t: 'b', n: '2', c: 'USD'}]}}); });
    await modalOpen(page); await page.waitForTimeout(80);
    const steps = [];
    for (let i = 0; i < 8; i++) {
      steps.push(await page.evaluate(() => { const a = document.activeElement, r = a.closest('.mrrow');
        return {tag: a.tagName, cls: a.className, row: r ? [...r.parentNode.children].indexOf(r) : -1}; }));
      await tab(page);
    }
    assert.ok(!steps.some(s => s.tag === 'SELECT'), 'Tab зупинився на схованому select: ' + JSON.stringify(steps));
    assert.deepEqual(steps.map(s => s.row), [0, 0, 0, 0, 1, 1, 1, 1],
      'Tab не йде рядок за рядком (поле, сума, валюта, хрестик): ' + JSON.stringify(steps));
    assert.ok(steps.some(s => s.cls.includes('cselb')), 'кнопка випадайки валюти недосяжна з клавіатури');
    // Два «Tab» за один кадр: відкладене виділення числового поля не сміє
    // тягнути фокус назад (select() у Chromium переносить фокус). Детерміновано,
    // без покладання на швидкість headless.
    const back = await page.evaluate(async () => {
      const num = document.querySelector('.mrrow input.mrc-n'), del = document.querySelector('.mrrow .mrdel');
      num.focus(); del.focus();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return document.activeElement === del ? 'ok' : document.activeElement.className;
    });
    assert.equal(back, 'ok', 'відкладений select() повернув фокус на числове поле');
    // Вибір валюти мишею: фокус лишається на кнопці випадайки, наступний Tab — далі в рядку
    const row0 = page.locator('.mrrow').first();
    await row0.locator('.cselb').click();
    await page.locator('.cselm:not([hidden]) .cselo').nth(1).click();
    assert.ok(await page.evaluate(() => document.activeElement.classList.contains('cselb')),
      'після вибору мишею фокус не повернувся на кнопку випадайки');
    await tab(page);
    assert.ok(await page.evaluate(() => document.activeElement.classList.contains('mrdel') &&
      [...document.querySelectorAll('.mrrow')].indexOf(document.activeElement.closest('.mrrow')) === 0),
      'Tab після вибору мишею пішов не на хрестик того ж рядка');
    await page.keyboard.press('Escape'); await modalClosed(page);
    await ctx.close(); }
  // 5. замок поверх відкритого вікна: блокування за бездіяльністю настає
  //    будь-коли, зокрема з відкритою модалкою. Під замком каркас і вікно
  //    inert, Esc не закриває вікно, гарячі клавіші не перемикають вкладку
  //    (фокус навмисно НЕ в полі коду: інакше обробник клавіш пропустив би
  //    натискання як введення в поле й проба нічого б не перевірила);
  //    правильний код знімає inert, і вікно знову живе.
  { const {ctx, page} = await open({});
    // Код — штучний, хешується власною функцією апки (сіль + SHA-256).
    const PIN = '1234';
    await page.evaluate(async pin => {
      const salt = '00112233aabbccdd';
      store.set('pinSalt', salt); store.set('pinHash', await pinHash(pin, salt));
    }, PIN);
    const lockState = () => page.evaluate(() => ({
      lock: !document.getElementById('lockScreen').hidden,
      shell: document.getElementById('shell').inert, modal: document.getElementById('modal').inert,
      open: !document.getElementById('modal').hidden, tab: S.tab}));
    await page.evaluate(() => go('overview'));
    await page.evaluate(() => { window.__r = 'чекаю'; uiAsk({title: 'Проба замка', value: 'x'}).then(v => window.__r = v); });
    await modalOpen(page);
    await page.evaluate(() => pinLock());
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'lockPin',
      null, {timeout: 3000});
    let st = await lockState();
    assert.deepEqual([st.lock, st.shell, st.modal], [true, true, true], 'під замком каркас і вікно не inert: ' + JSON.stringify(st));
    // фокус поза полем коду — як після кліку по тлу замка
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Escape'); await frame(page);
    await page.keyboard.press('3'); await frame(page);
    st = await lockState();
    assert.ok(st.open, 'Esc під замком закрив вікно, якого людина не бачить');
    assert.equal(await page.evaluate(() => window.__r), 'чекаю', 'вікно під замком отримало відповідь');
    assert.equal(st.tab, 'overview', `гаряча клавіша «3» під замком перемкнула вкладку на ${st.tab}`);
    // неправильний код — замок стоїть; правильний — inert знято, вікно відкрите й у фокусі
    await page.fill('#lockPin', '0000'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => /не підходить/.test(document.getElementById('lockMsg').textContent),
      null, {timeout: 3000});
    assert.ok((await lockState()).lock, 'неправильний код зняв замок');
    await page.fill('#lockPin', PIN); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('lockScreen').hidden, null, {timeout: 3000});
    st = await lockState();
    assert.deepEqual([st.shell, st.modal, st.open], [false, false, true], 'після коду inert лишився або вікно зникло: ' + JSON.stringify(st));
    assert.ok((await where(page)).modal, 'після розблокування фокус не повернувся у вікно');
    // вікно знову керується клавішами: Esc закриває його
    await page.keyboard.press('Escape'); await modalClosed(page);
    assert.equal(await page.evaluate(() => window.__r), null, 'Esc після розблокування не скасував вікно');
    await ctx.close(); }
  assert.deepEqual(errors, [],'помилки сторінки: ' + errors.join(' | '));
  console.log('системна тема, reduced-motion, фокус під модалкою, замок над вікном — OK');
} finally { await browser.close(); }
