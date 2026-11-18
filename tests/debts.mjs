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
//  · картка операції й рядок не зсуваються (±0.5 px) від галочки;
//  · режим «Вибрати» в картці «Борги»: галочки data-dsel (не data-dback, що
//    позначив би борг повернутим) замість «повернуто/Змінити/Видалити»,
//    розгортання через прапорець (після виходу — як було), висота рядків і
//    шапка не міняються, позначення не перемальовує картку, «Видалити
//    вибрані (N)» фіксованої ширини, клік по людині позначає всі її борги,
//    одне підтвердження на все, «Скасувати»/відмова нічого не міняють.
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

  // Режим вибору кількох боргів. Сховище тут порожнє: створюємо три борги —
  // з операції, ручний неповернутий і ручний повернутий.
  await page.evaluate(id => {
    setTxTag(id, 'debt'); setTxDebt(id, {who: 'Петро'}); syncTagUi(id);
    DEBTM = [{id: 'dm:1', who: 'Петро', amount: 500, date: '2026-11-01', note: '', back: false},
             {id: 'dm:2', who: 'Оля', amount: 300, date: '2026-11-02', note: '', back: true}];
    // Попередні кроки лишили розгорнутість (повернуті відкривали) — починаємо зі згорнутого.
    DEBT_UI.open.clear(); DEBT_UI.back = false;
    saveDebtsMan(); renderDebts();
  }, food.id);
  const snap = () => page.evaluate(() => JSON.stringify([store.get('txDebts', null), store.get('debtsMan', null), TXTAG]));
  const sel = page.locator('#debtSelBtn');
  const dd = page.locator('#debtBody .debtd[data-dd]');
  const rowHs = () => page.locator('#debtBody .debti').evaluateAll(a => a.map(n => n.getBoundingClientRect().height));
  const lab = id => page.locator(`#debtBody label:has([data-dsel="${id}"])`);
  const delW = async () => (await rect('#debtSelDel'))[2];
  assert.equal(await page.locator('[data-dsel]').count(), 0, tag + 'до режиму галочок вибору нема');
  assert.equal(await sel.isVisible(), true, tag + '«Вибрати» є, коли є борги');
  assert.equal(await sel.getAttribute('aria-pressed'), 'false');
  const before = await snap();

  // Вхід: рядки не міняють висоту, шапка не зсувається.
  await page.locator('#debtBody .debtp', {hasText: 'Петро'}).click();            // розгорнули Петра
  const hs0 = await rowHs(), hint0 = await rect('#debtCard .cardhead .hint');
  const add0 = await rect('#debtAddBtn'), sel0 = await rect('#debtSelBtn');
  assert.equal(hs0.filter(h => h > 0).length, 2, tag + 'видно два борги Петра (решта згорнута й має висоту 0)');
  await sel.click();
  assert.equal(await sel.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-dsel]').count(), 3, tag + 'галочок стільки, скільки боргів');
  assert.equal(await page.locator('#debtBody [data-dback], #debtBody [data-ddel], #debtBody [data-dedit]').count(), 0,
    tag + 'у режимі вибору «повернуто»/«Змінити»/«Видалити» зникають');
  assert.equal(await page.locator('#debtBackList').isVisible(), true, tag + 'повернуті відкриті');
  assert.equal(await dd.evaluateAll(a => a.every(n => !n.hidden)), true, tag + 'усі люди розгорнуті');
  const hs1 = await rowHs();
  hs0.forEach((h, i) => h > 0 && assert.ok(Math.abs(h - hs1[i]) <= 0.5, `${tag}рядок ${i} змінив висоту: ${h} → ${hs1[i]}`));
  near(hint0, await rect('#debtCard .cardhead .hint'), 'підказка «вам винні»');
  near(add0, await rect('#debtAddBtn'), '«+ Борг»');
  near(sel0, await rect('#debtSelBtn'), '«Вибрати»');
  // Повторне «Вибрати» = вихід; розгорнутість як була (Петро відкритий, повернуті закриті).
  await sel.click();
  assert.equal(await sel.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('[data-dsel]').count(), 0);
  assert.equal(await page.locator('#debtBackList').isHidden(), true, tag + 'повернуті знову закриті');
  assert.equal(await page.locator('#debtBody .debtp[aria-expanded="true"]').count(), 1);

  // «Скасувати»: дані ті самі, режим вимкнено, розгорнутість як до входу (Петро згорнуто).
  await page.locator('#debtBody .debtp', {hasText: 'Петро'}).click();
  assert.equal(await page.locator('#debtBody .debtd:not([hidden]) .debti').count(), 0);
  await sel.click();
  await lab(food.id).click();
  await page.locator('#debtSelCancel').click();
  assert.equal(await page.evaluate(() => DEBT_UI.sel), false, tag + 'режим вимкнено');
  assert.equal(await page.locator('[data-dsel]').count(), 0);
  assert.equal(await page.locator('#debtBody .debtd:not([hidden]) .debti').count(), 0, tag + 'Петро лишився згорнутим');
  assert.equal(await page.locator('#debtBackList').isHidden(), true);
  assert.equal(await snap(), before, tag + '«Скасувати» не міняє даних');

  // Позначення: без перемальовування, без зміни «повернуто», кнопка не міняє ширину.
  await sel.click();
  await page.evaluate(() => { document.querySelector('#debtBody .debti').__mark = 1; });
  assert.equal(await page.locator('#debtSelDel').isDisabled(), true, tag + 'при N=0 кнопка вимкнена');
  const w0 = await delW();
  await lab(food.id).click();
  assert.equal(await page.locator('#debtSelDel').innerText(), 'Видалити вибрані (1)');
  const w1 = await delW();
  await lab('dm:1').click();
  const w2 = await delW();
  assert.ok(Math.abs(w0 - w1) <= 0.5 && Math.abs(w1 - w2) <= 0.5, `${tag}«Видалити вибрані» міняє ширину: ${w0}, ${w1}, ${w2}`);
  assert.equal(await page.locator('#debtSelDel').isDisabled(), false);
  assert.equal(await page.evaluate(() => document.querySelector('#debtBody .debti').__mark), 1, tag + 'позначення не перемальовує картку');
  assert.equal(await snap(), before, tag + 'позначення не міняє «повернуто» й даних');
  // Рядок людини позначає всі її борги, повторний клік знімає.
  await lab(food.id).click(); await lab('dm:1').click();
  assert.equal(await page.locator('#debtSelDel').innerText(), 'Видалити вибрані (0)');
  const pet = page.locator('#debtBody .debtp', {hasText: 'Петро'});
  await pet.click();
  assert.equal(await page.locator('[data-dsel]:checked').count(), 2, tag + 'клік по людині позначив усі її борги');
  assert.equal(await page.evaluate(() => DEBT_UI.open.size), 0, tag + 'у режимі вибору люди не згортаються');
  await pet.click();
  assert.equal(await page.locator('[data-dsel]:checked').count(), 0, tag + 'другий клік зняв усі');
  await pet.click();
  assert.equal(await page.locator('#debtSelDel').innerText(), 'Видалити вибрані (2)');
  // Кнопки внизу в одному рядку й не вилазять за картку — і в реальній сітці, і у вузькій (320 px).
  const fit = async (what) => {
    const r = await page.evaluate(() => {
      const c = document.querySelector('#debtCard').getBoundingClientRect();
      const q = s => document.querySelector(s).getBoundingClientRect();
      const kids = ['#debtSelDel', '#debtSelCancel', '#debtSelBtn', '#debtAddBtn'].map(q);
      return {right: c.right, left: c.left, kids: kids.map(k => [k.left, k.right]), mid: kids.slice(0, 2).map(k => (k.top + k.bottom) / 2)};
    });
    r.kids.forEach(([l, rr]) => assert.ok(l >= r.left - 0.5 && rr <= r.right + 0.5, `${tag}${what}: кнопка за межами картки ${JSON.stringify(r)}`));
    assert.ok(Math.abs(r.mid[0] - r.mid[1]) <= 1, `${tag}${what}: «Видалити вибрані» і «Скасувати» не в одному рядку`);
  };
  await fit('сітка Огляду');
  await page.evaluate(() => { document.querySelector('#debtCard').style.cssText += ';width:320px;max-width:320px'; });
  await fit('картка 320 px');
  await page.evaluate(() => { document.querySelector('#debtCard').style.width = ''; document.querySelector('#debtCard').style.maxWidth = ''; });
  await page.locator('#debtCard').scrollIntoViewIfNeeded();
  await page.locator('#debtCard').screenshot({path: path.join(shots, `debts-select-${kind}-${theme}.png`)});

  // Відмова в підтвердженні нічого не міняє і режим лишає.
  await page.locator('#debtSelDel').click();
  await page.waitForSelector('#modal.on');
  const mt = await page.locator('#modal').innerText();
  assert.match(mt, /2 борги/, tag + 'у вікні кількість');
  assert.ok(mt.includes(await moneyOf(food.amount + 500)), tag + 'у вікні сума');
  assert.match(mt, /назавжди/);
  assert.match(mt, /операції лишаться/);
  await page.locator('#modalNo').click();
  await page.waitForFunction(() => !document.querySelector('#modal.on'));
  assert.equal(await page.evaluate(() => DEBT_UI.sel), true, tag + 'після відмови режим лишився');
  assert.equal(await page.locator('[data-dsel]:checked').count(), 2);
  assert.equal(await snap(), before, tag + 'відмова не міняє даних');
  // Підтвердження: операція + ручний зникають одним махом, третій лишається.
  await page.locator('#debtSelDel').click();
  await page.waitForSelector('#modal.on');
  await page.locator('#modalYes').click();
  await page.waitForFunction(() => !document.querySelector('#modal.on'));
  assert.deepEqual(await page.evaluate(() => debtItems().map(i => i.id)), ['dm:2'], tag + 'лишився лише третій борг');
  assert.equal(await page.evaluate(id => TX.some(t => t.id === id), food.id), true, tag + 'операція лишилась');
  assert.equal(await page.evaluate(id => txTag(id), food.id), '', tag + 'мітку знято');
  assert.equal(await page.evaluate(() => DEBT_UI.sel), false, tag + 'режим вимкнено');
  assert.equal(await page.locator('[data-dsel]').count(), 0);
  assert.deepEqual((await store('debtsMan')).map(m => m.id), ['dm:2']);
  await page.evaluate(() => { DEBTM = []; saveDebtsMan(); renderDebts(); });
  assert.equal(await sel.isHidden(), true, tag + 'без боргів «Вибрати» ховається');

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
