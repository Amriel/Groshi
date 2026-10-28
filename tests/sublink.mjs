// Нова підписка просто з картки операції.
//
// Симптом, який це ловить: «Привʼязати до підписки» в картці операції вміло
// лише вибрати з уже наявних підписок, а без жодної підписки відсилало на іншу
// вкладку — «спершу додайте свою». Назва, сума, валюта й дата при цьому вже є
// в самій операції. Тепер у списку є «Нова підписка з цієї операції», а без
// підписок форма відкривається одразу; створена підписка привʼязана до операції.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, '.test-artifacts'), {recursive: true});
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
try {
  for (const mode of ['browser', 'desktop']) {
    const context = await browser.newContext({viewport: {width: 1400, height: 1000}});
    await context.addInitScript(() => {
      localStorage.setItem('wizDone', 'true');
      localStorage.setItem('deskState', JSON.stringify({wizDone: true}));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.route(/^https?:/, r => r.abort());
    await page.goto(pathToFileURL(path.join(root,
      mode === 'browser' ? 'app/Groshi_app.html' : 'desktop/dist/index.html')).href);
    await page.waitForFunction(() => typeof window.linkTxToSub === 'function' && typeof window.renderTx === 'function');

    // Дві операції: гривнева й з доларового рахунку. Підписок — жодної.
    await page.evaluate(() => {
      const d = todayISO();
      const base = {date: d, conf: 'test', balance: 0, mcc: '', sub: '', account: 'Test', acctype: 'black', dir: 'expense'};
      TX.push({...base, id: 's1', time: d + 'T10:00:00', merchant: 'Хостинг Тест', amount: 600, cat: 'Софт'});
      TX.push({...base, id: 's2', time: d + 'T11:00:00', merchant: 'Сервіс USD Тест', amount: 800, cat: 'Софт',
               accCcy: 'USD', accAmount: 20, accRate: 40});
      SUBS_MAN = []; SUBS_ON = {}; SUBS_OFF = new Set(); saveSubs(); invalidateSubs();
      window.FX_NOW = {USD: 40, EUR: 45};
      invalidate(); setRange('2000-01-01', '2100-01-01'); go('tx');
    });
    const modalFields = () => page.evaluate(() => {
      const m = document.querySelector('#modal:not([hidden])'); if (!m) return null;
      // Поля форми нумеровані (#mff0…), ключ видно лише з підпису — читаємо за ним.
      const byLbl = {'Назва': 'nm', 'Сума': 'amt', 'Валюта списання': 'ccy', 'Період': 'per', 'Категорія': 'cat'};
      const f = {};
      m.querySelectorAll('.modalf').forEach(l => {
        const k = byLbl[l.querySelector('span').textContent] || (l.querySelector('span').textContent.startsWith('Наступне') ? 'next' : null);
        if (k) f[k] = l.querySelector('input').value; });
      return {title: el('modalT').textContent, fields: f,
              picks: [...m.querySelectorAll('.pickrow')].map(r => r.dataset.v)};
    });
    const start = id => page.evaluate(id => { window.__r = 'pending';
      linkTxToSub(id).then(() => { window.__r = 'done'; }, e => { window.__r = 'err ' + e; }); }, id);
    const finish = async () => { await page.waitForFunction(() => window.__r !== 'pending');
      assert.equal(await page.evaluate(() => window.__r), 'done', `${mode}: linkTxToSub впав`); };

    // ── 1. Без підписок: одразу форма, заповнена з операції ──
    await start('s1');
    await page.waitForSelector('#modal:not([hidden]) #modalYes:not([hidden])');
    let m = await modalFields();
    assert.ok(m && !m.picks.length, `${mode}: без підписок має відкритись форма, а не глухий кут: ${JSON.stringify(m)}`);
    assert.equal(m.fields.nm, 'Хостинг Тест', `${mode}: назва з операції: ${JSON.stringify(m.fields)}`);
    assert.equal(m.fields.amt, '600', `${mode}: сума з операції: ${JSON.stringify(m.fields)}`);
    assert.equal(m.fields.ccy, 'UAH', `${mode}: валюта гривневої операції`);
    await page.click('#modalYes');
    await finish();
    let subs = await page.evaluate(() => subsMine().map(s => ({merchant: s.merchant, amount: s.amount, ccy: s.ccy, period: s.period, tx: subTxIds(s)})));
    assert.equal(subs.length, 1, `${mode}: підписка створена: ${JSON.stringify(subs)}`);
    assert.equal(subs[0].merchant, 'Хостинг Тест', `${mode}: назва підписки`);
    assert.equal(subs[0].amount, 600, `${mode}: сума підписки в гривні`);
    assert.equal(subs[0].period, 'month', `${mode}: типовий період — місяць`);
    assert.deepEqual(subs[0].tx, ['s1'], `${mode}: операція привʼязана до нової підписки`);
    assert.equal(await page.evaluate(() => (subOfTx(TX.find(t => t.id === 's1')) || {}).merchant), 'Хостинг Тест',
      `${mode}: картка операції знає свою підписку`);
    assert.equal(await page.evaluate(() => store.get('subsMan', []).length), 1, `${mode}: підписку збережено`);

    // ── 2. Є підписки: у списку і наявна, і «нова з цієї операції»; валюта — з рахунку ──
    await start('s2');
    await page.waitForSelector('#modal:not([hidden]) .pickrow');
    m = await modalFields();
    assert.ok(m.picks.includes('__new'), `${mode}: у списку має бути пункт «нова підписка»: ${JSON.stringify(m.picks)}`);
    assert.equal(m.picks.length, 2, `${mode}: наявна підписка + «нова»: ${JSON.stringify(m.picks)}`);
    await page.click('#modal .pickrow[data-v="__new"]');
    await page.waitForSelector('#modal:not([hidden]) #modalYes:not([hidden])');
    m = await modalFields();
    assert.equal(m.fields.nm, 'Сервіс USD Тест', `${mode}: назва з операції`);
    assert.equal(m.fields.amt, '20', `${mode}: сума в валюті рахунку, а не гривневий еквівалент: ${JSON.stringify(m.fields)}`);
    assert.equal(m.fields.ccy, 'USD', `${mode}: валюта з рахунку`);
    await page.click('#modalYes');
    await finish();
    subs = await page.evaluate(() => subsMine().map(s => ({merchant: s.merchant, famt: s.famt, ccy: s.ccy, tx: subTxIds(s)})));
    const usd = subs.find(s => s.merchant === 'Сервіс USD Тест');
    assert.ok(usd, `${mode}: доларова підписка створена: ${JSON.stringify(subs)}`);
    assert.equal(usd.famt, 20, `${mode}: сума у валюті збережена`);
    assert.equal(usd.ccy, 'USD', `${mode}: валюта збережена`);
    assert.deepEqual(usd.tx, ['s2'], `${mode}: операція привʼязана`);

    // ── 3. Esc у формі: нічого не створено ──
    await page.evaluate(() => { TX.push({...TX.find(t => t.id === 's1'), id: 's3', merchant: 'Третя Тест'}); invalidate(); renderTx(); });
    await start('s3');
    await page.waitForSelector('#modal:not([hidden]) .pickrow');
    await page.click('#modal .pickrow[data-v="__new"]');
    await page.waitForSelector('#modal:not([hidden]) #modalYes:not([hidden])');
    await page.keyboard.press('Escape');
    await finish();
    assert.equal(await page.evaluate(() => subsMine().length), 2, `${mode}: Esc не створює підписку`);
    assert.equal(await page.evaluate(() => subOfTx(TX.find(t => t.id === 's3'))), null, `${mode}: Esc не привʼязує`);

    // ── 4. Привʼязка до наявної працює, як і раніше ──
    await start('s3');
    await page.waitForSelector('#modal:not([hidden]) .pickrow');
    const key = await page.evaluate(() => subsMine().find(s => s.merchant === 'Хостинг Тест').key);
    await page.click(`#modal .pickrow[data-v="${key}"]`);
    await finish();
    assert.equal(await page.evaluate(() => (subOfTx(TX.find(t => t.id === 's3')) || {}).merchant), 'Хостинг Тест',
      `${mode}: привʼязка до наявної підписки`);

    // ── 5. Вкладка «Підписки» показує створене ──
    await page.evaluate(() => go('subs'));
    const mineTxt = await page.textContent('#subMine');
    assert.match(mineTxt, /Хостинг Тест/, `${mode}: нова підписка у «Моїх підписках»`);
    assert.match(mineTxt, /Сервіс USD Тест/, `${mode}: доларова підписка у «Моїх підписках»`);

    // ── 6. Редагування й форма «Додати» працюють після винесення спільної формули дати ──
    await page.evaluate(() => { window.__r = 'pending';
      subEdit(subsMine().find(s => s.merchant === 'Хостинг Тест').key).then(() => { window.__r = 'done'; }, e => { window.__r = 'err ' + e; }); });
    await page.waitForSelector('#modal:not([hidden]) #modalYes:not([hidden])');
    await page.evaluate(() => { [...document.querySelectorAll('.modalf')].forEach(l => {
      if (l.querySelector('span').textContent.startsWith('Наступне')) l.querySelector('input').value = '15.03.2099'; }); });
    await page.click('#modalYes');
    await finish();
    const edited = await page.evaluate(() => SUBS_MAN.find(s => s.merchant === 'Хостинг Тест').last);
    // Щомісяця: «наступне» 15.03.2099 → останнє 2099-02-15 (календарний місяць, не 30 днів);
    // операція s1 на сьогодні старіша, тож не переважує.
    assert.equal(edited, '2099-02-15', `${mode}: дата дд.мм.рррр розібрана, last = наступне − місяць: ${edited}`);
    await page.evaluate(() => {
      el('mName').value = 'Оренда Тест'; el('mAmt').value = '1000';
      el('mPer').value = 'month'; el('mAdd').click();
    });
    const rent = await page.evaluate(() => SUBS_MAN.find(s => s.merchant === 'Оренда Тест'));
    assert.ok(rent && rent.amount === 1000 && /^\d{4}-\d{2}-\d{2}$/.test(rent.last),
      `${mode}: форма «Додати» працює, last порахований: ${JSON.stringify(rent)}`);

    assert.deepEqual(errors, [], `${mode}: помилки сторінки`);
    console.log(`${mode}: нова підписка з картки операції (без підписок — одразу форма; у списку — пункт «нова»; валюта з рахунку; Esc; наявна привʼязка; вкладка «Підписки»; редагування й «Додати» зі спільною формулою дати) — OK`);
    await context.close();
  }
} finally {
  await browser.close();
}
