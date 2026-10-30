// Стан проєкту йде за рахунком.
//
// Симптом, який це ловить: у журналі шість живих рахунків («6 очікує оплати»),
// а картка «Чекає оплати» на тому ж екрані показує «$0 · усе оплачено» — вона
// рахує проєкти за p.status, а виставлення рахунку стану не торкалось.
// Тепер живий рахунок тримає проєкт у «чекає оплати», оплата останнього
// живого — переводить в «оплачено», зняття позначки — назад; старі рахунки
// підтягуються одноразово при запуску.
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
    // Дані «з минулої версії»: проєкти в роботі, рахунки по них уже виставлені.
    await context.addInitScript(() => {
      // Скрипт іде на кожне завантаження; після reload сіяти вдруге не можна,
      // інакше проба перевіряла б не одноразовість, а власний посів.
      if (localStorage.getItem('deskState')) return;
      const row = {id: 'r1', task: 'Дизайн', type: 'Art', rate: 300, days: 8, ot: 0, ind: 0, note: ''};
      const seed = {};
      seed.projects = [
        {id: 'p1', client: 'Клієнт А', name: 'Лендінг', status: 'active', rate: 300, tax: 0, usd: 41.5, rows: [row]},
        {id: 'p2', client: 'Клієнт Б', name: 'Застосунок', status: 'active', rate: 300, tax: 0, usd: 41.5, rows: [row]},
        {id: 'p3', client: 'Клієнт В', name: 'Без рахунку', status: 'active', rate: 300, tax: 0, usd: 41.5, rows: [row]},
        {id: 'p4', client: 'Клієнт Г', name: 'Давно оплачений', status: 'paid', paidAt: '2099-01-01', rate: 300, tax: 0, usd: 41.5, rows: [row]},
      ];
      seed.invcLog = [
        {no: 'INV-2099-002', pj: 'p1', date: '2099-01-02', client: 'A LTD', total: 2400, ccy: 'USD', paid: null, lang: 'en', biz: ''},
        {no: 'INV-2099-001', pj: 'p1', date: '2099-01-01', client: 'A LTD', total: 2300, ccy: 'USD', paid: null, void: {date: '2099-01-02', by: 'INV-2099-002'}, lang: 'en', biz: ''},
        {no: 'INV-2099-003', pj: 'p2', date: '2099-01-03', client: 'B LTD', total: 99600, ccy: 'UAH', paid: null, lang: 'en', biz: ''},
        {no: 'INV-2099-006', pj: 'p4', date: '2098-12-01', client: 'D LTD', total: 10, ccy: 'USD', paid: null, lang: 'en', biz: ''},
        {no: 'INV-2099-004', date: '2099-01-04', client: 'OLD', total: 500, ccy: 'USD', paid: null, lang: 'en', biz: ''},
      ];
      seed.projView = 'list'; seed.wizDone = true;
      // Браузер читає окремі ключі, десктоп — один deskState: сіємо обидва.
      for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, JSON.stringify(v));
      localStorage.setItem('deskState', JSON.stringify(seed));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.route(/^https?:/, r => r.abort());
    await page.goto(pathToFileURL(path.join(root,
      mode === 'browser' ? 'app/Groshi_app.html' : 'desktop/dist/index.html')).href);
    await page.waitForFunction(() => typeof window.renderInvcLog === 'function' && typeof window.go === 'function');
    await page.evaluate(() => { go('budget'); PJ_VIEW = 'list'; renderProjects(); });

    const st = () => page.evaluate(() => Object.fromEntries(PROJ.map(p => [p.id, (p.status || 'active') + (p.paidAt ? '@' + p.paidAt : '')])));
    const kpi = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#pjTotals .kpi')]
      .map(k => [k.querySelector('.lbl').textContent, k.querySelector('.val').textContent + ' · ' + k.querySelector('.sub').textContent])));
    const chip = id => page.evaluate(id => document.querySelector(`[data-pjst="${id}"]`).textContent.trim(), id);
    const idx = no => page.evaluate(no => INVCLOG.findIndex(x => x.no === no), no);

    // ── 1. Старі рахунки підтягнули стани; картка більше не «$0» ──
    let s = await st();
    assert.equal(s.p1, 'done', `${mode}: проєкт із живим рахунком має чекати оплати: ${JSON.stringify(s)}`);
    assert.equal(s.p2, 'done', `${mode}: гривневий рахунок теж тримає проєкт у «чекає»: ${JSON.stringify(s)}`);
    assert.equal(s.p3, 'active', `${mode}: проєкт без рахунку не чіпаємо: ${JSON.stringify(s)}`);
    assert.equal(s.p4, 'paid@2099-01-01', `${mode}: оплачений чіпом проєкт із невідміченим рахунком не чіпаємо, дата лишається: ${JSON.stringify(s)}`);
    let k = await kpi();
    assert.doesNotMatch(k['Чекає оплати'], /^\$0 ·/, `${mode}: картка «Чекає оплати»: ${k['Чекає оплати']}`);
    assert.match(k['Чекає оплати'], /Лендінг/, `${mode}: у підписі — назви проєктів: ${k['Чекає оплати']}`);
    assert.match(k['У роботі'], /1 проєкт/, `${mode}: у роботі лишився один: ${k['У роботі']}`);
    assert.equal(await chip('p1'), 'Чекає оплати', `${mode}: чіп у рядку і картка кажуть одне`);
    // Десктоп пише state із затримкою (400 мс) і в один ключ, браузер — одразу
    // в окремий. Чекаємо, доки запис СПРАВДІ з'явиться, а не фіксовані 900 мс:
    // на повільному CI-раннері цього не вистачало, і 31.10.2026 проба впала
    // на main, хоча код проєктів не мінявся (перезапуск — зелений).
    const disk = (k, m) => page.evaluate(([k, m]) => m === 'browser' ? JSON.parse(localStorage.getItem(k))
      : (JSON.parse(localStorage.getItem('deskState')) || {})[k], [k, m]);
    const p1Disk = async () => ((await disk('projects', mode)) || []).find(p => p.id === 'p1')?.status;
    const until = async (get, want) => {          // до 5 с, кожні 100 мс
      for (let i = 0; i < 50 && (await get()) !== want; i++) await page.waitForTimeout(100);
      return get();
    };
    assert.equal(await until(p1Disk, 'done'), 'done', `${mode}: підтягнутий стан збережено`);
    // Одноразовість: повернули «в роботі» руками — після перезавантаження не стрибає назад.
    await page.evaluate(() => { PROJ.find(p => p.id === 'p1').status = 'active'; pjSave(); });
    assert.equal(await until(p1Disk, 'active'), 'active', `${mode}: ручний стан збережено`);
    // Перед reload — сам прапорець одноразовості на диску. Якщо колись він не
    // запишеться, проба скаже саме це, а не «стан стрибнув назад».
    assert.equal(await until(() => disk('invcStSync', mode), true), true, `${mode}: прапорець invcStSync збережено`);
    await page.reload();
    await page.waitForFunction(() => typeof window.renderInvcLog === 'function');
    assert.equal((await st()).p1, 'active', `${mode}: вирівнювання станів має бути одноразовим`);
    await page.evaluate(() => { go('budget'); PJ_VIEW = 'list'; renderProjects(); });

    // ── 2. «Оплачено» в журналі → проєкт оплачений із датою; картки перемальовані ──
    await page.click(`#invcLogList [data-ipay="${await idx('INV-2099-003')}"]`);
    s = await st();
    assert.match(s.p2, /^paid@\d{4}-\d{2}-\d{2}$/, `${mode}: оплата останнього живого рахунку → «оплачено» з датою: ${s.p2}`);
    k = await kpi();
    assert.match(k['Оплачено'], /2 проєкт/, `${mode}: картка «Оплачено» перемальована: ${k['Оплачено']}`);
    assert.equal(await chip('p2'), 'Оплачено', `${mode}: чіп p2`);

    // ── 3. «↺» зняти оплату → знову чекає ──
    await page.click(`#invcLogList [data-iunpay="${await idx('INV-2099-003')}"]`);
    assert.equal((await st()).p2, 'done', `${mode}: зняття позначки повертає «чекає оплати»`);

    // ── 4. Оплата одного з двох живих рахунків проєкту — ще чекаємо ──
    await page.evaluate(() => { INVCLOG.unshift({no: 'INV-2099-005', pj: 'p2', date: '2099-01-05', client: 'B LTD', total: 100, ccy: 'USD', paid: null, lang: 'en', biz: ''});
      store.set('invcLog', INVCLOG); renderInvcLog(); });
    await page.click(`#invcLogList [data-ipay="${await idx('INV-2099-005')}"]`);
    assert.equal((await st()).p2, 'done', `${mode}: аванс оплачено, залишок живий — проєкт ще чекає`);
    await page.click(`#invcLogList [data-ipay="${await idx('INV-2099-003')}"]`);
    assert.match((await st()).p2, /^paid@/, `${mode}: оплачено обидва — проєкт оплачений`);

    // ── 5. «Не рахувати» / «↺» стану не міняють; рахунок без проєкту — теж ──
    await page.evaluate(() => { PROJ.find(p => p.id === 'p1').status = 'done'; pjSave(); renderProjects(); });
    await page.click(`#invcLogList [data-ivoid="${await idx('INV-2099-002')}"]`);
    assert.equal((await st()).p1, 'done', `${mode}: заміна рахунку стан не чіпає`);
    await page.click(`#invcLogList [data-iunvoid="${await idx('INV-2099-002')}"]`);
    assert.equal((await st()).p1, 'done', `${mode}: повернення рахунку стан не чіпає`);
    const before = await st();
    await page.click(`#invcLogList [data-ipay="${await idx('INV-2099-004')}"]`);
    assert.deepEqual(await st(), before, `${mode}: рахунок без pj нічого не міняє`);

    // ── 6. Автозвірка з банком теж переводить проєкт в «оплачено» (на дату зарахування) ──
    await page.evaluate(() => {
      const inv = INVCLOG.find(x => x.no === 'INV-2099-002');
      inv.paid = null; inv.date = dstr(dnum(todayISO()) - 10);   // зарахування шукається від дати рахунку
      PROJ.find(p => p.id === 'p1').status = 'done'; pjSave();
      TX.push({id: 'tx-inv', date: todayISO(), time: todayISO() + 'T10:00:00', merchant: 'Надходження', amount: 2400,
        dir: 'income', cat: 'Дохід', sub: '', conf: 'test', account: 'Test', acctype: 'white'});
      window.FX_NOW = {USD: 1};               // курс 1:1, щоб сума збіглась
      store.set('invcLog', INVCLOG); renderProjects();
    });
    s = await st();
    assert.equal(s.p1, 'paid@' + await page.evaluate(() => todayISO()), `${mode}: автозвірка → «оплачено» на дату зарахування: ${s.p1}`);
    k = await kpi();
    assert.match(k['Оплачено'], /3 проєкт/, `${mode}: картка після автозвірки: ${k['Оплачено']}`);

    // ── 7. Виставлення рахунку з картки проєкту → «чекає оплати», селект оновлено ──
    await page.evaluate(() => {
      BIZPROF = [{label: 'Основний', name: 'PE TEST PERSON', tax: '0000000000', addr: 'Ukraine', bank: 'Test Bank',
        iban: 'UA000000000000000000000000000', swift: 'TESTUA2X'}];
      window.download = () => {};
      PJ_CUR = 'p3'; PJ_VIEW = 'one'; store.set('projView', 'one'); renderProjects();
      window.__r = 'pending'; invoiceFlow(PROJ.find(p => p.id === 'p3')).then(() => { window.__r = 'done'; }, e => { window.__r = 'err ' + e; });
    });
    await page.waitForSelector('#modal:not([hidden]) #modalYes:not([hidden])');
    await page.click('#modalYes');
    await page.waitForFunction(() => window.__r !== 'pending');
    assert.equal(await page.evaluate(() => window.__r), 'done', `${mode}: виставлення впало`);
    assert.equal((await st()).p3, 'done', `${mode}: виставлений рахунок → проєкт чекає оплати`);
    assert.equal(await page.inputValue('#pjStatus'), 'done', `${mode}: селект «Стан» у картці показує новий стан`);

    assert.deepEqual(errors, [], `${mode}: помилки сторінки`);
    console.log(`${mode}: стан проєкту йде за рахунком (вирівнювання старих, оплачено/↺, аванс+залишок, автозвірка, виставлення) — OK`);
    await context.close();
  }
} finally {
  await browser.close();
}
