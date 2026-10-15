// Операції: під сумою — дублікат у другій валюті (гривня → долар, долар → гривня).
//
// Що ловить: у списку була лише гривня; щоб побачити суму в доларах, треба було
// рахувати самому. Дублікат має: з'являтись лише коли відомий курс (вигадувати
// його гірше, ніж мовчати), не повторювати оригінал валютного рахунку, не
// збільшувати висоту рядка й ховатися в режимі скріншоту разом з усіма сумами.
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
const norm = s => s.replace(/[\s  ]+/g, ' ').trim();
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
    await page.waitForFunction(() => typeof window.renderTx === 'function');

    // Чотири операції на сьогодні: гривневі витрата й надходження, покупка з
    // доларового рахунку (оригінал уже в $) і з євро (оригінал у €, дублікат у $).
    await page.evaluate(() => {
      const d = todayISO();
      const base = {date: d, conf: 'test', balance: 0, mcc: '', sub: '', account: 'Test', acctype: 'black'};
      TX.push({...base, id: 'u1', time: d + 'T10:00:00', merchant: 'Кава', amount: 800, dir: 'expense', cat: 'Кафе'});
      TX.push({...base, id: 'u2', time: d + 'T11:00:00', merchant: 'Оплата', amount: 4000, dir: 'income', cat: 'Дохід'});
      TX.push({...base, id: 'u3', time: d + 'T12:00:00', merchant: 'Сервіс USD', amount: 800, dir: 'expense', cat: 'Софт',
               accCcy: 'USD', accAmount: 20, accRate: 40});
      TX.push({...base, id: 'u4', time: d + 'T13:00:00', merchant: 'Сервіс EUR', amount: 450, dir: 'expense', cat: 'Софт',
               accCcy: 'EUR', accAmount: 10, accRate: 45});
      invalidate();
      setRange('2000-01-01', '2100-01-01');      // увесь період: пушнуті операції поза «Місяцем» не загубились
      go('tx');
    });
    const sub = id => page.evaluate(id => {
      const r = document.querySelector(`.txrow[data-id="${id}"]`);
      const e = r && r.querySelector('.tx-amt .ccy');
      return {main: r ? r.querySelector('.tx-amt').firstChild.textContent : null,
              sub: e ? e.textContent : null, tip: e ? e.dataset.tip || '' : '', h: r ? Math.round(r.getBoundingClientRect().height) : 0};
    }, id);

    // ── курс відомий: дублікат у $ з копійками ──
    await page.evaluate(() => { window.FX_NOW = {USD: 40, EUR: 45}; renderTx(); });
    let u1 = await sub('u1'), u2 = await sub('u2'), u3 = await sub('u3'), u4 = await sub('u4');
    assert.equal(norm(u1.sub || ''), '≈ 20,00 $', `${mode}: дублікат гривневої витрати: «${u1.sub}»`);
    assert.equal(norm(u2.sub || ''), '≈ 100,00 $', `${mode}: дублікат надходження: «${u2.sub}»`);
    assert.equal(norm(u3.sub || ''), '20,00 $', `${mode}: рахунок уже в $ — лише оригінал, без повтору: «${u3.sub}»`);
    assert.equal(norm(u4.sub || ''), '10,00 € · ≈ 11,25 $', `${mode}: євро: оригінал і дублікат одним рядком: «${u4.sub}»`);
    assert.match(u1.tip, /40,00/, `${mode}: підказка має називати курс: «${u1.tip}»`);
    assert.equal(u3.tip, '', `${mode}: без дубліката підказки нема`);

    // ── висота рядка не росте через дублікат ──
    const withDup = u1.h;
    await page.evaluate(() => { window.FX_NOW = undefined; renderTx(); });
    u1 = await sub('u1');
    assert.equal(u1.sub, null, `${mode}: без курсу дубліката нема (вигадувати курс гірше, ніж мовчати)`);
    assert.equal(u1.h, withDup, `${mode}: дублікат змінив висоту рядка: ${withDup} → ${u1.h}`);

    // ── базова валюта $: дублікат у гривні ──
    await page.evaluate(() => { window.FX_NOW = {USD: 40, EUR: 45}; BASE = 'USD'; renderTx(); });
    u1 = await sub('u1');
    assert.match(norm(u1.main), /^−20,00/, `${mode}: головна сума у $: «${u1.main}»`);
    assert.equal(norm(u1.sub || ''), '≈ 800,00 ₴', `${mode}: дублікат у гривні: «${u1.sub}»`);
    await page.evaluate(() => { BASE = 'UAH'; renderTx(); });

    // ── режим скріншоту ховає й дублікат ──
    await page.evaluate(() => scrnToggle(true));
    await page.waitForTimeout(300);
    const leak = await page.evaluate(() =>
      [...document.querySelectorAll('.txrow .tx-amt .ccy')].map(e => e.textContent).filter(t => /\d/.test(t)));
    assert.deepEqual(leak, [], `${mode}: у режимі скріншоту видно суми в дублікатах: ${JSON.stringify(leak)}`);
    await page.evaluate(() => scrnToggle(false));

    // ── 390 px: без горизонтального скролу ──
    await page.setViewportSize({width: 390, height: 844});
    await page.waitForTimeout(250);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(sw <= 391, `${mode}: список на 390 px гортається вбік: ${sw}`);

    assert.deepEqual(errors, [], `${mode}: помилки сторінки`);
    console.log(`${mode}: дублікат у $ (з копійками, без повтору оригіналу, лише за відомого курсу), висота рядка та 390 px не змінились, режим скріншоту ховає — OK`);
    await context.close();
  }
} finally {
  await browser.close();
}
