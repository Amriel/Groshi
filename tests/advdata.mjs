// Дані для Порадника: підсумки, зведення, знімок.
//  · «Між рахунками» й «Інвестиції» не входять ні у витрати, ні в доходи
//    в ЖОДНОМУ режимі moveMode (рішення власника 30.10.2026: серпень
//    показував 1,49 млн, з них 898 тис. — перекази між власними рахунками);
//  · у режимі «count» перекази людям і готівка рахуються витратами.
// Штучні дані: .test-artifacts/synthetic_app.html (збирає `npm test` у pretest).
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {openDesktop} from './helpers/desktop-boot.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = pathToFileURL(path.join(root, '.test-artifacts', 'synthetic_app.html')).href;

const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
try {
  for (const mode of ['count', 'skip', 'hide']) {
    const context = await browser.newContext({viewport: {width: 1400, height: 1000}});
    await context.addInitScript(m => {
      localStorage.setItem('wizDone', 'true');
      localStorage.setItem('moveMode', JSON.stringify(m));
    }, mode);
    await context.route(/^https?:/, r => r.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(app);
    await page.waitForFunction(() => typeof window.go === 'function');
    const r = await page.evaluate(() => {
      const by = c => TX.filter(t => catOf(t) === c);
      const leak = ['Між рахунками', 'Інвестиції'].flatMap(by)
        .filter(t => isSpend(t) || isIncome(t) || isRefund(t)).length;
      return {
        leak,
        never: ['Між рахунками', 'Інвестиції'].map(c => by(c).length),
        people: by('Перекази').filter(isSpend).length, peopleAll: by('Перекази').length,
        cash: by('Готівка').filter(isSpend).length, cashAll: by('Готівка').length,
      };
    });
    assert.ok(r.never.every(n => n > 0), `${mode}: у штучних даних є обидві категорії`);
    assert.equal(r.leak, 0, `${mode}: «Між рахунками»/«Інвестиції» потрапили в підсумки`);
    if (mode === 'count') {
      assert.equal(r.people, r.peopleAll, 'count: перекази людям — витрати');
      assert.equal(r.cash, r.cashAll, 'count: готівка — витрати');
    } else {
      assert.equal(r.people + r.cash, 0, `${mode}: перекази людям і готівка поза підсумками, як і раніше`);
    }
    assert.deepEqual(errors, [], `${mode}: помилки сторінки`);
    console.log(`advdata ${mode}: підсумки — OK`);
    await context.close();
  }

  /* advData() — одне джерело для зведення й знімка: місяці дорівнюють
     «Огляду», категорії мають ознаки регулярності, мітки й види операцій
     доходять до даних. */
  {
    const context = await browser.newContext({viewport: {width: 1400, height: 1000}});
    await context.addInitScript(() => {
      localStorage.setItem('wizDone', 'true');
      localStorage.setItem('moveMode', '"count"');
      // Ручна підписка: у штучних даних підтверджених немає, а «найближче
      // списання» має дійти до зведення.
      const last = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
      localStorage.setItem('subsMan', JSON.stringify([{key: 'man:1', merchant: 'Хмарка', amount: 300,
        period: 'month', last, ccy: 'UAH', famt: 0, cat: 'Підписки', txIds: [], note: ''}]));
    });
    await context.route(/^https?:/, r => r.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(app);
    await page.waitForFunction(() => typeof window.go === 'function');
    const r = await page.evaluate(() => {
      const people = [...TX].reverse().find(t => catOf(t) === 'Перекази');
      setTxTag(people.id, 'debt');
      const D = advData(), dg = advDigest();
      const monthOk = D.months.map(m => {
        const rows = TX.filter(t => t.date.slice(0, 7) === m.ym && !isHidMove(t));
        return Math.abs(m.exp - sum(rows, 'expense')) < 0.01 && Math.abs(m.inc - sum(rows, 'income')) < 0.01;
      });
      const live = D.subs.filter(s => s.live).reduce((a, s) => a + s.perMonth, 0);
      const inv = TX.find(t => catOf(t) === 'Інвестиції'), mv = TX.find(t => catOf(t) === 'Між рахунками');
      const food = D.cats.find(c => c.k === 'Продукти');
      return {
        full: D.months.filter(m => m.full).length, monthOk, dg,
        firstYm: (d => d.endsWith('-01') ? d.slice(0, 7) : ymAdd(d.slice(0, 7), 1))(TX.map(t => t.date).sort()[0]), fullYms: D.months.filter(m => m.full).map(m => m.ym),
        subsLine: 'Підписки: ' + fmt0_(live / baseK()),
        tag: (D.tags.debt || {})[people.date.slice(0, 7)], tagWant: people.amount,
        kinds: [D.tx[inv.id]?.k, D.tx[mv.id]?.k, D.tx[people.id]?.tag],
        food: food && {n: food.n, med: food.med, months: Object.keys(food.byM).length, top: food.top.length,
          want: D.months.filter(m => m.full && TX.some(t => t.date.startsWith(m.ym) && catOf(t) === 'Продукти')).length},
        moves: D.months.some(m => m.moves > 0), invest: D.months.some(m => m.invest > 0),
      };
    });
    /* Штучні дані — ~4 місяці, і почалися не першого числа: місяці до
       початку даних і сам перший обрізаний місяць не можуть іти в середнє,
       інакше «звичайний місяць» занижено вдвічі. */
    assert.ok(r.full > 0 && r.full <= 6, 'повних місяців 1–6: ' + r.full);
    assert.ok(r.fullYms.every(ym => ym >= r.firstYm), 'повний місяць раніше за дані: ' + r.fullYms);
    assert.ok(r.monthOk.every(Boolean), 'витрати/доходи місяців = «Огляд»: ' + r.monthOk);
    assert.ok(r.dg.includes(r.subsLine), `у зведенні «${r.subsLine}»`);
    for (const s of ['Категорії по місяцях', 'Між рахунками', 'Відкладено в інвестиції', 'Найближчі списання', 'Як читати ці дані', 'борг'])
      assert.ok(r.dg.includes(s), `у зведенні нема «${s}»`);
    assert.equal(r.tag, r.tagWant, 'мітка «борг» підсумована за місяць');
    assert.deepEqual(r.kinds, ['invest', 'move', 'debt'], 'види операцій і мітка в tx');
    assert.ok(r.food && r.food.n === r.food.want && r.food.n > 0 && r.food.months === r.full && r.food.top > 0, 'ознаки категорії: ' + JSON.stringify(r.food));
    assert.ok(r.moves && r.invest, 'рядки руху між рахунками й інвестицій');
    assert.deepEqual(errors, [], 'advData: помилки сторінки');
    /* Режим count: перекази людям і готівка вже у витратах — рядок місяця
       мусить це казати, інакше модель, що складає колонки, порахує їх двічі. */
    assert.match(r.dg, /^- \d{4}-\d{2} .*перекази людям [^;]*\(у витратах\)/m, 'count: «(у витратах)» у рядку місяця');
    /* Підказка режиму не бреше: «Між рахунками» й «Інвестиції» не рахуються ніколи. */
    const hint = await page.evaluate(() => { moveHint(); return el('moveHint').textContent; });
    assert.ok(!/скрізь/.test(hint) && /людям/.test(hint), 'підказка режиму count: ' + hint);
    console.log('advdata: advData() і зведення — OK');
    await context.close();
  }

  /* Дата знімка — день запису, а не запуску: апка живе в треї тижнями, і
     після півночі MCP інакше кричав би «знімок застарів» на щойно записаний. */
  {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('wizDone', 'true'));
    await context.route(/^https?:/, r => r.abort());
    const page = await context.newPage();
    await page.clock.install({time: new Date()});
    await page.goto(app);
    await page.waitForFunction(() => typeof window.go === 'function');
    const d0 = await page.evaluate(() => advData().today);
    await page.clock.fastForward('25:00:00');
    const d1 = await page.evaluate(() => [advData().today, new Date().toISOString().slice(0, 10)]);
    assert.notEqual(d1[0], d0, 'today у знімку не зсунувся через добу');
    assert.equal(d1[0], d1[1], 'today = поточна дата');
    console.log('advdata: дата знімка — день запису — OK');
    await context.close();
  }

  /* Робочі категорії (ФОП): власник орендує GPU й софт для роботи, тож
     Порадник має рахувати їх окремо від особистих. «Огляд» не змінюється —
     розподіл бачить лише Порадник. Без збереженого вибору робоча — «AI та
     софт»; перемикач у налаштуваннях міняє набір на місці. */
  {
    const context = await browser.newContext({viewport: {width: 1400, height: 1000}});
    await context.addInitScript(() => {
      localStorage.setItem('wizDone', 'true');
      localStorage.setItem('moveMode', '"count"');
    });
    await context.route(/^https?:/, r => r.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(app);
    await page.waitForFunction(() => typeof window.go === 'function');
    assert.deepEqual(await page.evaluate(() => [...WORK]), ['AI та софт'], 'типово робоча — «AI та софт»');

    await page.evaluate(() => go('settings'));
    await page.locator('button.chip[data-sec="rules"]').click();
    const chip = page.locator('#workCats .chip', {hasText: 'Продукти'});
    const box0 = await page.locator('#workCats').boundingBox();
    await chip.click();
    assert.equal(await chip.getAttribute('aria-pressed'), 'true', 'чип натиснуто');
    assert.ok(JSON.parse(await page.evaluate(() => localStorage.getItem('workCats'))).includes('Продукти'), 'збережено');
    const box1 = await page.locator('#workCats').boundingBox();
    assert.ok(Math.abs(box0.y - box1.y) < 0.5 && Math.abs(box0.height - box1.height) < 0.5, 'перелік не зсунувся');
    assert.match(await page.locator('#workHint').innerText(), /2 категорії/, 'підказка рахує обрані');

    const r = await page.evaluate(() => {
      const D = advData(), dg = advDigest();
      const ok = D.months.map(m => {
        const rows = TX.filter(t => t.date.slice(0, 7) === m.ym && !isHidMove(t) && inSpend(t));
        const w = rows.filter(t => ['Продукти', 'AI та софт'].includes(catOf(t))).reduce((a, t) => a + spendAmt(t), 0);
        return Math.abs(m.work - w) < 0.01;
      });
      return {ok, work: D.work, flag: (D.cats.find(c => c.k === 'Продукти') || {}).work,
        food: D.months.some(m => m.work > 0), dg,
        ov: sum(TX.filter(t => t.date.slice(0, 7) === D.months[D.months.length - 1].ym && !isHidMove(t)), 'expense'),
        ovWant: D.months[D.months.length - 1].exp};
    });
    assert.ok(r.ok.every(Boolean) && r.food, 'робочі витрати місяця = сума робочих категорій: ' + r.ok);
    assert.deepEqual(r.work.sort(), ['AI та софт', 'Продукти'], 'перелік робочих у даних');
    assert.equal(r.flag, true, 'категорія позначена робочою');
    assert.equal(r.ov, r.ovWant, '«Огляд» не змінився');
    assert.match(r.dg, /^- \d{4}-\d{2} .*робочі \(ФОП\) [^;]+; особисті /m, 'рядок місяця: робочі й особисті');
    assert.match(r.dg, /^\| Продукти \(ФОП\) \|/m, 'таблиця позначає робочу категорію');

    await chip.click();
    assert.equal(await chip.getAttribute('aria-pressed'), 'false', 'повторний клік знімає');
    assert.deepEqual(errors, [], 'робочі категорії: помилки сторінки');
    console.log('advdata: робочі категорії (ФОП) — OK');
    await context.close();
  }

  /* Порожня апка (свіжа установка): зведення й дані не падають. */
  {
    const dir = path.join(root, '.test-artifacts');
    fs.writeFileSync(path.join(dir, 'empty.json'), '[]');
    execFileSync('python', [path.join(root, 'app', 'build_app.py'), '--data', path.join(dir, 'empty.json'),
      '--out', path.join(dir, 'empty_app.html')], {stdio: 'ignore'});
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('wizDone', 'true'));
    await context.route(/^https?:/, r => r.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(dir, 'empty_app.html')).href);
    await page.waitForFunction(() => typeof window.go === 'function');
    const ok = await page.evaluate(() => { const D = advData(); advDigest(); return Array.isArray(D.months) && Array.isArray(D.cats); });
    assert.ok(ok, 'порожні дані: advData() повертає масиви');
    assert.deepEqual(errors, [], 'порожні дані: помилки сторінки');
    console.log('advdata: порожня апка — OK');
    await context.close();
  }

  /* Десктоп пише знімок advice_cache.json для MCP: один раз після старту
     й по одному разу після кожної правки, що змінює підсумки (debounce —
     серія правок не дає серії записів). */
  {
    const {ctx, page, errors} = await openDesktop(browser, {width: 1400});
    const snaps = () => page.evaluate(() => (window.__advSnaps || []).length);
    await page.waitForTimeout(3500);
    assert.equal(await snaps(), 1, 'після старту — рівно один запис знімка');
    const v = await page.evaluate(() => window.__advSnaps[0]);
    assert.equal(v.v, 1, 'версія формату');
    assert.ok(v.months.length > 0 && v.cats.length > 0 && Object.keys(v.tx).length > 0, 'знімок не порожній');
    assert.ok(v.built && v.today && v.app, 'built/today/app');
    await page.evaluate(() => { const t = TX.find(x => catOf(x) === 'Перекази'); setTxTag(t.id, 'gift'); });
    await page.waitForTimeout(2600);
    assert.equal(await snaps(), 2, 'мітка — ще один запис');
    assert.ok(Object.values(await page.evaluate(() => window.__advSnaps[1].tx)).some(r => r.tag === 'gift'), 'мітка в знімку');
    await page.evaluate(() => { RULES.push({match: 'Таксі', cat: 'Транспорт'}); store.set('rules', RULES); store.set('rules', RULES); });
    await page.waitForTimeout(2600);
    assert.equal(await snaps(), 3, 'дві правки поспіль — один запис');
    await page.evaluate(() => go('cats'));
    await page.waitForTimeout(2600);
    assert.equal(await snaps(), 3, 'перемикання вкладки знімок не пише');
    assert.deepEqual(await page.evaluate(() => window.__unexpectedCommands), [], 'неочікувані IPC-команди');
    assert.deepEqual(errors, [], 'десктоп: помилки сторінки');
    console.log('advdata: десктоп пише знімок — OK');
    await ctx.close();
  }
} finally {
  await browser.close();
}
