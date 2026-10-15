// Журнал рахунків: правка рахунку не множить очікувані надходження.
//
// Симптом, який це ловить: клієнт тричі правив один рахунок, і кожна правка
// діставала новий номер (INV-007, -008, -009). Кожен неоплачений рахунок окремо
// потрапляв у «Має прийти» календаря, тож по одному проєкту очікувалась утричі
// більша сума. Тепер при виставленні рахунку, коли по проєкту вже є
// неоплачений, апка питає: це правка (старий не рахується) чи окремий платіж.
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
    await page.waitForFunction(() => typeof window.invoiceFlow === 'function' && typeof window.calEvents === 'function');

    // Штучні дані. download() підміняємо: файл нікуди не пишемо, лише рахуємо виклики.
    const seed = () => page.evaluate(() => {
      PROJ = [{id: 'p1', client: 'Клієнт А', name: 'Лендінг', status: 'active', rate: 300, tax: 6, usd: 41.5,
        rows: [{id: 'r1', task: 'Дизайн', type: 'Art', rate: 300, days: 8, ot: 1, ind: 0, note: ''}]}];
      PJ_CUR = 'p1'; PJ_VIEW = 'one'; pjSave();
      BIZPROF = [{label: 'Основний', name: 'PE TEST PERSON', tax: '0000000000', addr: 'Ukraine', bank: 'Test Bank',
        iban: 'UA000000000000000000000000000', swift: 'TESTUA2X'}];
      INVCLOG = []; store.set('invcLog', INVCLOG);
      window.__dl = []; window.download = n => { window.__dl.push(n); };
    });
    // Очікувані оплати рахунків у календарі того місяця, на який припадає строк.
    const invcEvents = () => page.evaluate(() => {
      const ym = dstr(dnum(todayISO()) + INVC_DUE()).slice(0, 7);
      return calEvents(ym).filter(e => e.kind === 'invc').map(e => e.text);
    });
    // Виставити рахунок через справжній діалог. answer: null — питання не очікується,
    // 'replace' | 'keep' — кнопка списку, 'esc' — Esc на питанні.
    const issue = async answer => {
      await page.evaluate(() => { window.__r = 'pending'; invoiceFlow(PROJ[0]).then(() => { window.__r = 'done'; }, e => { window.__r = 'err ' + e; }); });
      await page.waitForSelector('#modal:not([hidden]) #modalYes:not([hidden])');
      await page.click('#modalYes');
      if (answer) {
        await page.waitForSelector('#modal:not([hidden]) .pickrow');
        if (answer === 'esc') await page.keyboard.press('Escape');
        else await page.click(`#modal .pickrow[data-v="${answer}"]`);
      }
      await page.waitForFunction(() => window.__r !== 'pending');
      assert.equal(await page.evaluate(() => window.__r), 'done', `${mode}: виставлення впало`);
    };
    const log = () => page.evaluate(() => INVCLOG.map(x => ({no: x.no, pj: x.pj, paid: !!x.paid, void: x.void ? x.void.by || true : null})));

    // ── 1. Перший рахунок: питання нема, у журналі звʼязок із проєктом ──
    await seed();
    await issue(null);
    let l = await log();
    assert.equal(l.length, 1, `${mode}: перший рахунок має лягти в журнал`);
    assert.equal(l[0].pj, 'p1', `${mode}: рахунок не привʼязано до проєкту`);
    assert.equal((await invcEvents()).length, 1, `${mode}: один рахунок — одна очікувана оплата`);

    // ── 2. Правка: «замінити» — старий лишається в журналі, але не рахується ──
    await issue('replace');
    l = await log();
    assert.equal(l.length, 2, `${mode}: замінений рахунок лишається в журналі`);
    assert.equal(l.filter(x => x.void).length, 1, `${mode}: рівно один замінений`);
    assert.equal(l[1].void, l[0].no, `${mode}: замінений має вказувати, ким його замінено`);
    assert.equal((await invcEvents()).length, 1, `${mode}: після правки очікується ОДНА оплата, а не дві`);
    // Третя правка — і знову одна (саме тут було «утричі»).
    await issue('replace');
    assert.equal((await invcEvents()).length, 1, `${mode}: після третьої правки очікується одна оплата`);
    assert.equal((await log()).filter(x => x.void).length, 2, `${mode}: два замінених`);

    // ── 3. «Окремий платіж»: обидва чекають оплати ──
    await issue('keep');
    assert.equal((await invcEvents()).length, 2, `${mode}: два справжні рахунки — дві очікувані оплати`);

    // ── 4. Esc: нічого не змінилося, файл не завантажено, номер не витрачено ──
    const before = await page.evaluate(() => ({n: INVCLOG.length, no: invcNo(), dl: window.__dl.length}));
    await issue('esc');
    const after = await page.evaluate(() => ({n: INVCLOG.length, no: invcNo(), dl: window.__dl.length}));
    assert.deepEqual(after, before, `${mode}: Esc на питанні мав скасувати все`);

    // ── 5. Старі записи без звʼязку з проєктом: «Не рахувати» і назад ──
    await page.evaluate(() => {
      const d = todayISO();
      INVCLOG = ['INV-2099-001', 'INV-2099-002', 'INV-2099-003'].map((no, i) =>
        ({no, date: d, client: 'TEST CLIENT', total: 1000 + i, ccy: 'UAH', paid: null, lang: 'en', biz: ''}));
      // Журнал лежить у списку проєктів, а не в картці одного — відкриваємо список.
      PJ_VIEW = 'list'; store.set('projView', 'list');
      store.set('invcLog', INVCLOG); go('budget'); renderProjects(); renderInvcLog();
    });
    assert.equal((await invcEvents()).length, 3, `${mode}: три незамінені рахунки — три оплати`);
    await page.click('#invcLogList [data-ivoid="0"]');
    await page.click('#invcLogList [data-ivoid="1"]');   // перший вже сірий: кнопка в нього інша
    assert.equal((await invcEvents()).length, 1, `${mode}: «Не рахувати» прибирає рахунок із календаря`);
    const hint = await page.textContent('#invcLogHint');
    assert.match(hint, /1 очікує оплати/, `${mode}: підпис журналу: ${hint}`);
    assert.match(hint, /2 не рахується/, `${mode}: підпис журналу про не враховані: ${hint}`);
    assert.equal(await page.locator('#invcLogList .pjline.void').count(), 2, `${mode}: замінені рядки позначені`);
    await page.click('#invcLogList [data-iunvoid="0"]');
    assert.equal((await invcEvents()).length, 2, `${mode}: «↺» повертає рахунок у очікувані`);

    // ── 6. Нагадування про прострочені й автозвірка оплати не чіпають неврахований ──
    const rec = await page.evaluate(() => {
      const old = dstr(dnum(todayISO()) - 40);
      INVCLOG = [
        {no: 'INV-2099-010', date: old, client: 'TEST CLIENT', total: 777, ccy: 'UAH', paid: null, void: {date: old}, lang: 'en', biz: ''},
        {no: 'INV-2099-011', date: old, client: 'TEST CLIENT', total: 777, ccy: 'UAH', paid: null, lang: 'en', biz: ''}];
      TX.push({id: 'tx-inv', date: todayISO(), time: todayISO() + 'T10:00:00', merchant: 'Надходження', amount: 777,
        dir: 'income', cat: 'Дохід', sub: '', conf: 'test', account: 'Test', acctype: 'white'});
      renderInvcLog();
      return {overdue: invcOverdue().map(x => x.no), paid: INVCLOG.map(x => !!x.paid)};
    });
    assert.deepEqual(rec.overdue.filter(n => n === 'INV-2099-010'), [], `${mode}: замінений у «Неоплачених рахунках»`);
    assert.deepEqual(rec.paid, [false, true], `${mode}: автозвірка має оплатити лише живий рахунок: ${JSON.stringify(rec.paid)}`);

    assert.deepEqual(errors, [], `${mode}: помилки сторінки`);
    console.log(`${mode}: правка рахунку не множить очікувані оплати (замінити/лишити/Esc), «Не рахувати» і «↺», прострочені й автозвірка — OK`);
    await context.close();
  }
} finally {
  await browser.close();
}
