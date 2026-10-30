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
} finally {
  await browser.close();
}
