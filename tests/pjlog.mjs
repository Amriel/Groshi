/* Журнал кошторису й кнопка «Поділитись».

   Журнал: дрібні правки одного сеансу мають злипатись в ОДИН запис із
   останньою ціною, а події (створення, стан, рахунок) — лишатись
   окремими й закривати сеанс. Раніше злипались тільки правки одного
   поля за 90 секунд, і чверть години підрахунку лишала десяток рядків.

   «Поділитись»: файл кошторису має йти через download(). Власний
   Blob + <a download> у WebView2 мовчки не спрацьовує — кнопка
   натискалась, і не відбувалось нічого. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({executablePath:process.env.CHROMIUM || undefined});
try {
  for (const mode of ['browser','desktop']) {
    const context = await browser.newContext({viewport:{width:1400,height:1000}});
    await context.addInitScript(() => {
      localStorage.setItem('wizDone', 'true');
      localStorage.setItem('deskState', JSON.stringify({wizDone:true}));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route(/^https?:/, route => route.abort());
    await page.goto(pathToFileURL(path.join(root,
      mode==='browser' ? 'app/Groshi_app.html' : 'desktop/dist/index.html')).href);
    await page.waitForFunction(() => typeof window.pjLog==='function');

    // ── сеанс підрахунку: сім правок поспіль → один запис ──
    const log = await page.evaluate(() => {
      PROJ = [{id:'synthetic-project', client:'Приклад', name:'Проба кошторису',
               status:'active', rate:300, tax:6, usd:45, rows:[]}];
      const p = PROJ[0]; PJ_CUR = p.id; PJ_VIEW = 'one';
      pjLog(p, 'Проєкт створено', true);
      p.rate = 350; pjLog(p, 'Ставка: 300 → 350');
      p.rate = 400; pjLog(p, 'Ставка: 350 → 400');
      p.rows.push({id:'synthetic-row-1', task:'Дизайн', type:'Development',
                   rate:400, days:2, ot:0, ind:0, note:''});
      pjLog(p, 'Додано рядок');
      pjLog(p, 'Дизайн · дні: 1 → 2');
      pjLog(p, 'Дизайн · дні: 2 → 5');
      p.tax = 5; pjLog(p, 'Податок: 6 → 5');
      p.usd = 46; pjLog(p, 'Курс ₴: 45 → 46');
      const batch = p.log[p.log.length-1];
      const afterEdits = p.log.length;
      p.status = 'done'; pjLog(p, 'Стан: Чекає оплати', true);
      p.rate = 500; pjLog(p, 'Ставка: 400 → 500');
      return {afterEdits, n:batch.n, txt:batch.txt,
              priceIsLast: batch.price === Math.round(pjSum(p, pjTax)),
              total:p.log.length, texts:p.log.map(x=>x.txt)};
    });
    assert.equal(log.afterEdits, 2, `${mode}: сім правок після створення — один запис`);
    assert.equal(log.n, 7, `${mode}: у пакеті полічено всі правки`);
    assert.match(log.txt, /7 змін$/, `${mode}: у тексті пакета видно кількість`);
    assert.ok(log.priceIsLast, `${mode}: ціна пакета — остання, а не проміжна`);
    assert.equal(log.total, 4, `${mode}: подія закриває сеанс, наступна правка — новий запис`);
    assert.equal(log.texts[2], 'Стан: Чекає оплати', `${mode}: подія лишилась окремим записом`);

    // ── пауза довша за вікно починає новий запис ──
    const paused = await page.evaluate(() => {
      const p = {id:'p-pause', name:'Пауза', client:'—', status:'active',
                 rate:300, tax:6, usd:45, rows:[]};
      pjLog(p, 'Ставка: 300 → 350');
      p.log[0].t = new Date(Date.now() - 11*60*1000).toISOString();
      pjLog(p, 'Ставка: 350 → 400');
      return p.log.length;
    });
    assert.equal(paused, 2, `${mode}: правка через 11 хвилин — окремий запис`);

    // ── старий журнал без ознаки пакета не переписується ──
    const legacy = await page.evaluate(() => {
      const p = {id:'p-legacy', name:'Старий', client:'—', status:'active',
                 rate:300, tax:6, usd:45, rows:[],
                 log:[{t:new Date().toISOString(), txt:'Ставка: 200 → 300', price:1000}]};
      pjLog(p, 'Ставка: 300 → 400');
      return {count:p.log.length, first:p.log[0].txt};
    });
    assert.equal(legacy.count, 2, `${mode}: старий запис не поглинає нову правку`);
    assert.equal(legacy.first, 'Ставка: 200 → 300', `${mode}: старий запис не змінено`);

    // ── «Поділитись» іде через download() ──
    const share = await page.evaluate(async () => {
      const calls = [];
      const original = window.download;
      window.download = (name, text, type) => calls.push({name, type,
        hasTotal:/Разом/.test(text||''), hasName:/Проба кошторису/.test(text||'')});
      PJ_CUR = 'synthetic-project'; PJ_VIEW = 'one'; go('budget'); renderProjects();
      await new Promise(r => setTimeout(r, 200));
      el('pjShare').click();
      await new Promise(r => setTimeout(r, 200));
      window.download = original;
      return calls;
    });
    assert.equal(share.length, 1, `${mode}: «Поділитись» кличе download() рівно раз`);
    assert.match(share[0].name, /\.html$/, `${mode}: файл кошторису — .html`);
    assert.ok(share[0].hasTotal && share[0].hasName, `${mode}: у файлі назва проєкту й підсумок`);

    // ── у застосунку файл пише Rust, а не <a download> ──
    const desk = await page.evaluate(async () => {
      const original = window.__DESK__;
      const saved = [];
      window.__DESK__ = {tauri:true, saveText:(name, text) => {
        saved.push({name, bytes:(text||'').length}); return Promise.resolve('C:\\Downloads\\' + name); }};
      pjShare(pjCur());
      await new Promise(r => setTimeout(r, 200));
      window.__DESK__ = original;
      return saved;
    });
    assert.equal(desk.length, 1, `${mode}: у застосунку кошторис пише saveText`);
    assert.ok(desk[0].bytes > 500, `${mode}: у saveText пішов непорожній файл`);

    assert.deepEqual(errors, [], `${mode}: помилки журналу або кошторису`);
    console.log(`${mode}: сім правок → один запис, події окремо, «Поділитись» через download()`);
    await context.close();
  }
} finally {
  await browser.close();
}
