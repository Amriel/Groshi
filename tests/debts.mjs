// Борги, які винні МЕНІ: позначка «борг» на витраті, «Кому», «повернуто»,
// картка «Борги» на Огляді, ручні борги. Власник хоче бачити, хто скільки
// винен; імена людей лишаються на пристрої (у Порадника не йдуть — це
// сторожить advdata.mjs). Сторожимо в обох збірках (браузер і десктоп):
//  · будь-яка витрата має чип «борг»; «Кому» зберігається на виході з поля,
//    бейдж у рядку — «борг · Імʼя» (і «· повернуто»), на місці;
//  · картка «Борги» рахує лише неповернуте; «+ Борг» через uiAsk додає
//    ручний борг, «Змінити» і «Видалити» (з підтвердженням) працюють;
//  · галочка «повернуто» — одне поле на картку операції й картку «Борги»;
//  · зняття мітки прибирає борг і запис у txDebts;
//  · картка операції й рядок не зсуваються (±0.5 px) від галочки.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {openDesktop} from './helpers/desktop-boot.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = pathToFileURL(path.join(root, '.test-artifacts', 'synthetic_app.html')).href;
const shots = path.join(root, '.test-artifacts');

async function run(page, errors, kind, theme) {
  const tag = `${kind}: `;
  await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
  await page.evaluate(() => go('tx'));
  const food = await page.evaluate(() => {
    const t = [...TX].reverse().find(x => catOf(x) === 'Продукти' && x.dir === 'expense');
    return {id: t.id, amount: t.amount};
  });
  const rowSel = `.txrow[data-id="${food.id}"]`;
  const rect = s => page.locator(s).first().evaluate(n => { const r = n.getBoundingClientRect(); return [r.x, r.y + scrollY, r.width, r.height]; });
  const near = (a, b, what) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= 0.5, `${tag}${what} зсунувся: ${a} → ${b}`));
  const store = key => page.evaluate(k => store.get(k, null), key);
  const sumText = () => page.locator('#debtBody .num-lg').innerText();
  const moneyOf = n => page.evaluate(v => money(v), n);
  const openCard = async () => { if (!await page.locator('.txdetail').count()) await page.locator(rowSel).click(); };
  const modal = async (vals) => {
    await page.waitForSelector('#modal.on');
    for (const [i, v] of Object.entries(vals)) { await page.locator(`#mff${i}`).fill(v); }
    await page.waitForTimeout(250);                  // підказка під полем закривається з затримкою
    await page.locator('#modalYes').click();
    await page.waitForFunction(() => !document.querySelector('#modal.on'));
  };

  assert.equal(await store('txDebts'), null, tag + 'чисте сховище');
  await openCard();
  assert.deepEqual(await page.locator('.txdetail .txtag').allInnerTexts(), ['борг'], tag + 'у «Продуктів» один чип');
  assert.equal(await page.locator('.txdetail [data-debtbox]').isHidden(), true, tag + 'без мітки поля «Кому» немає');

  // Мітка → поле «Кому»; рядок не рухається, картка росте лише вниз.
  const row0 = await rect(rowSel), card0 = await rect('.txdetail');
  await page.locator('.txdetail .txtag').click();
  assert.equal(await page.locator('.txdetail [data-debtbox]').isVisible(), true, tag + 'поле «Кому» зʼявилось');
  near(row0, await rect(rowSel), 'рядок після мітки');
  near(card0.slice(0, 3), (await rect('.txdetail')).slice(0, 3), 'картка після мітки');
  assert.equal(await page.locator(`${rowSel} .txtagb`).innerText(), 'борг', tag + 'бейдж без імені');

  // «Кому» зберігається на виході з поля (Enter).
  await page.locator('.txdetail [data-dwho]').fill('Петро');
  await page.locator('.txdetail [data-dwho]').press('Enter');
  assert.equal(await page.locator(`${rowSel} .txtagb`).innerText(), 'борг · Петро');
  assert.deepEqual(await store('txDebts'), {[food.id]: {who: 'Петро', back: false}});
  assert.ok(await page.locator('.txdetail').isVisible(), tag + 'картка не згорнулась');

  // Картка «Борги»: сума = ця витрата, людина в списку.
  await page.evaluate(() => go('overview'));
  assert.equal(await sumText(), await moneyOf(food.amount), tag + 'сума боргів');
  assert.match(await page.locator('#debtBody .debtp').first().innerText(), /Петро/);

  // «+ Борг» → ручний борг на 1000.
  await page.locator('#debtAddBtn').click();
  await modal({0: 'Оля', 1: '1000', 3: 'на таксі'});
  assert.equal(await sumText(), await moneyOf(food.amount + 1000), tag + 'сума з ручним боргом');
  const man = await store('debtsMan');
  assert.equal(man.length, 1);
  assert.deepEqual([man[0].who, man[0].amount, man[0].note, man[0].back, man[0].id.startsWith('dm:')],
    ['Оля', 1000, 'на таксі', false, true]);
  assert.match(man[0].date, /^\d{4}-\d{2}-\d{2}$/);

  // Людину можна розгорнути; перемикання не перемальовує решту.
  const olya = page.locator('#debtBody .debtp', {hasText: 'Оля'});
  await olya.click();
  assert.equal(await page.locator('#debtBody .debtd:not([hidden]) .debti').count(), 1, tag + 'розгорнуто борги Олі');
  assert.match(await page.locator('#debtBody .debtd:not([hidden])').innerText(), /вручну/);
  // Зміна ручного боргу.
  await page.locator('[data-dedit]').click();
  await modal({1: '700'});
  assert.equal(await sumText(), await moneyOf(food.amount + 700), tag + 'сума після «Змінити»');

  // Скріншот картки в поточній темі.
  await page.locator('#debtCard').scrollIntoViewIfNeeded();
  await page.locator('#debtCard').screenshot({path: path.join(shots, `debts-card-${kind}-${theme}.png`)});

  // Галочка «повернуто» в картці операції: одне поле з карткою «Борги».
  await page.evaluate(() => go('tx'));
  await openCard();
  const rowB = await rect(rowSel), cardB = await rect('.txdetail');
  await page.locator('.txdetail [data-dback]').click();
  assert.equal(await page.locator(`${rowSel} .txtagb`).innerText(), 'борг · Петро · повернуто');
  near(rowB, await rect(rowSel), 'рядок після галочки');
  near(cardB, await rect('.txdetail'), 'картка після галочки');
  assert.deepEqual(await store('txDebts'), {[food.id]: {who: 'Петро', back: true}});
  await page.evaluate(() => go('overview'));
  assert.equal(await sumText(), await moneyOf(700), tag + 'повернуте не входить у суму');
  assert.equal(await page.locator('#debtBackBtn').innerText(), 'Повернуті (1)');
  assert.equal(await page.locator('#debtBackList').isHidden(), true, tag + 'повернуті сховані');
  await page.locator('#debtBackBtn').click();
  assert.equal(await page.locator('#debtBackList .debti').count(), 1);
  // Зворотна дія з картки «Борги» повертає суму.
  await page.locator('#debtBackList [data-dback]').click();
  assert.equal(await sumText(), await moneyOf(food.amount + 700), tag + 'сума після зняття галочки');
  assert.equal(await page.locator('#debtBackBtn').count(), 0, tag + 'повернутих немає — кнопки нема');
  assert.deepEqual(await store('txDebts'), {[food.id]: {who: 'Петро', back: false}});

  // Ручний борг повернено — сума без нього.
  // «Оля» вже розгорнута з попереднього кроку: розгорнуте переживає перемальовування.
  await page.locator('#debtBody [data-dback^="dm:"]').click();
  assert.equal(await sumText(), await moneyOf(food.amount), tag + 'сума без повернутого ручного');
  assert.equal(await page.locator('#debtBackBtn').innerText(), 'Повернуті (1)');
  await page.locator('#debtBackList [data-ddel]').click();           // Видалити → підтвердження
  await page.waitForSelector('#modal.on');
  await page.locator('#modalYes').click();
  await page.waitForFunction(() => !document.querySelector('#modal.on'));
  assert.deepEqual(await store('debtsMan'), [], tag + 'ручний борг видалено');

  // Зняття мітки прибирає борг і запис.
  await page.evaluate(() => go('tx'));
  await openCard();
  await page.locator('.txdetail .txtag').click();
  assert.equal(await page.locator(`${rowSel} .txtagb`).count(), 0, tag + 'бейдж зник');
  assert.deepEqual(await store('txDebts'), {}, tag + 'запис боргу видалено');
  assert.equal(await page.locator('.txdetail [data-debtbox]').isHidden(), true);
  near(card0, await rect('.txdetail'), 'картка після зняття мітки');
  await page.evaluate(() => go('overview'));
  assert.match(await page.locator('#debtBody').innerText(), /Боргів немає/);

  // Борг з операції прибирається прямо з картки «Борги»: операція лишається,
  // знімається лише мітка. Галочка й кнопка — в одному рядку (не переносяться).
  await page.evaluate(() => go('tx'));
  await openCard();
  await page.locator('.txdetail .txtag').click();
  await page.evaluate(() => go('overview'));
  await page.locator('#debtBody .debtp').first().click();
  const act = page.locator('#debtBody .debtd:not([hidden]) .dact').first();
  const tops = await act.evaluate(n => [...n.children].map(c => Math.round(c.getBoundingClientRect().top + c.offsetHeight / 2)));
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 2, `${tag}галочка й «Видалити» в одному рядку: ${tops}`);
  await act.locator('[data-ddel]').click();
  await page.waitForSelector('#modal.on');
  assert.match(await page.locator('#modal').innerText(), /Операція лишиться/);
  await page.locator('#modalYes').click();
  await page.waitForFunction(() => !document.querySelector('#modal.on'));
  assert.match(await page.locator('#debtBody').innerText(), /Боргів немає/, tag + 'борг з операції прибрано');
  assert.equal(await page.evaluate(id => txTag(id), food.id), '', tag + 'мітку знято');
  assert.equal(await page.evaluate(id => TX.some(t => t.id === id), food.id), true, tag + 'операція лишилась');

  // Імена не потрапляють у знімок для Порадника.
  const adv = await page.evaluate(() => JSON.stringify(typeof advData === 'function' ? advData() : {}));
  assert.ok(!adv.includes('Петро') && !adv.includes('Оля'), tag + 'імена не йдуть у Порадника');
  assert.deepEqual(errors, [], tag + 'помилки сторінки');
  // Прибираємо за собою, щоб наступна тема починалась з чистого сховища.
  await page.evaluate(() => { store.set('txDebts', null); store.set('debtsMan', null); });
}

const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
try {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({viewport: {width: 1400, height: 1000}});
    await context.addInitScript(() => localStorage.setItem('wizDone', 'true'));
    await context.route(/^https?:/, r => r.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(app);
    await page.waitForFunction(() => typeof window.go === 'function');
    await run(page, errors, 'браузер', theme);
    await context.close();

    const d = await openDesktop(browser, {width: 1400, height: 1000, theme});
    await run(d.page, d.errors, 'десктоп', theme);
    await d.ctx.close();
  }
  console.log('debts: борг, «Кому», «повернуто», картка «Борги», ручні борги — OK (браузер і десктоп, обидві теми)');
} finally {
  await browser.close();
}
