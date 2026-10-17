import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-artifacts');
fs.mkdirSync(output, {recursive:true});
const browser = await chromium.launch({executablePath:process.env.CHROMIUM || undefined});
try {
  for (const mode of ['browser', 'desktop']) {
    const context = await browser.newContext({viewport:{width:1400,height:1000}});
    // Перше знайомство відкриває власне вікно за таймером; тут перевіряємо вже налаштовану апку.
    await context.addInitScript(() => {
      localStorage.setItem('wizDone', 'true');
      localStorage.setItem('deskState', JSON.stringify({wizDone:true}));
    });
    const page = await context.newPage();
    const errors = [], nativeDialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
    await context.route(/^https?:/, route => route.abort());
    await page.goto(pathToFileURL(path.join(root,
      mode==='browser' ? 'app/Groshi_app.html' : 'desktop/dist/index.html')).href);
    await page.waitForFunction(() => typeof window.uiAsk==='function');
    const open = async (confirm=false) => {
      await page.locator('#themeBtn').focus();
      await page.evaluate(isConfirm => {
        window.__modalResult = 'pending';
        const options = {title:'Синтетична проба', value:'Початковий текст'};
        (isConfirm ? uiConfirm(options) : uiAsk(options)).then(value => { window.__modalResult=value; });
      }, confirm);
      await page.locator('#modal.on').waitFor({state:'visible'});
    };
    const result = async expected => {
      await page.waitForFunction(() => window.__modalResult!=='pending');
      assert.equal(await page.evaluate(() => window.__modalResult), expected);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'themeBtn',
        `${mode}: після модального вікна фокус повертається до джерела`);
      await page.locator('#modal').waitFor({state:'hidden'});
    };
    for (const action of ['button','escape','backdrop']) {
      await open();
      await page.locator('#modalI').fill('Незбережений текст');
      if(action==='button') await page.locator('#modalNo').click();
      else if(action==='escape') await page.keyboard.press('Escape');
      else await page.locator('#modalBd').click({position:{x:5,y:5}});
      await result(null);
    }
    await open();
    await page.locator('#modalI').fill('  Збережений текст  ');
    await page.keyboard.press('Enter');
    await result('Збережений текст');
    await open(true);
    assert.equal(await page.locator('#modalFW').isVisible(), false,
      `${mode}: підтвердження не показує зайвого поля`);
    await page.screenshot({path:path.join(output, `modal-${mode}.png`)});
    await page.locator('#modalNo').click();
    await result(false);
    await open(true);
    await page.locator('#modalYes').click();
    await result(true);

    // Друге вікно відкривається до старого таймера приховування: саме так працюють інвойси.
    await page.evaluate(() => {
      window.__modalResult='pending';
      uiAsk({title:'Перше вікно',value:'перше'}).then(() =>
        uiAsk({title:'Друге вікно',value:'друге'})).then(value => { window.__modalResult=value; });
    });
    await page.locator('#modalYes').click();
    await page.waitForFunction(() => document.getElementById('modalT').textContent==='Друге вікно');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#modal').isVisible(), true, `${mode}: друге вікно не зникло`);
    await page.locator('#modalNo').click();
    await page.waitForFunction(() => window.__modalResult===null);
    /* Сторож «жодного системного вигляду». Симптом: два атрибути `title`
       (стовпчики року в «Огляді» і плашка бенчмарка в «Інвестиціях») прожили
       кілька релізів, бо ця проба перевіряла лише власні діалоги, а решту UI
       ніхто не обходив. Тому проходимо всі вкладки на даних, за яких ці
       елементи справді малюються, і після кожної шукаємо [title] (крім
       <iframe>), <input type="date"> та <input list>. */
    await page.evaluate(() => {
      const y = new Date().getFullYear();
      TX.length = 0;
      for (const m of ['01','02','03'])
        TX.push({date:`${y}-${m}-10`, merchant:'Кафе', category:'Їжа', subcategory:'Кафе',
          dir:'expense', amount:100*(+m), mcc:0});
      INV = {pos:[{src:'ibkr', symbol:'AAPL', name:'Apple', kind:'stock', qty:10, price:100,
          value:1000, ccy:'USD', avgCost:90}], ivt:[],
        navh:[{date:`${y}-01-01`, value:1000, ccy:'USD'}, {date:`${y}-02-01`, value:1100, ccy:'USD'}],
        fetched:{}};
      QUOTES = {fetched:Date.now()/1000,
        quotes:{SPY:{price:500, prev:499, dates:[`${y}-01-01`, `${y}-02-01`], closes:[450, 500]}}};
    });
    const nativeLooks = () => page.evaluate(() => [
      ...[...document.querySelectorAll('[title]')].filter(n => n.tagName!=='IFRAME')
        .map(n => `${n.tagName.toLowerCase()}[title="${n.getAttribute('title')}"]${n.id?'#'+n.id:''}${
          typeof n.className==='string' && n.className ? '.'+n.className.trim().replace(/\s+/g,'.') : ''}`),
      ...[...document.querySelectorAll('input[type="date"], input[list]')]
        .map(n => `input${n.id?'#'+n.id:''}[${n.getAttribute('type')||'list'}]`)]);
    // Приховані вкладки лишаються в DOM, тому той самий порушник видно на кожній: рахуємо його раз.
    const violators = [];
    for (const tab of ['overview','cats','tx','budget','inv','subs', 'advisor', 'settings']) {
      await page.evaluate(value => { go(value); render(); }, tab);
      await page.locator(`#tab-${tab}`).waitFor({state:'visible'});
      for (const item of await nativeLooks())
        if (!violators.some(v => v.endsWith(` ${item}`))) violators.push(`${tab}: ${item}`);
    }
    assert.deepEqual(violators, [], `${mode}: системний title/date/list у вкладках: ${violators.join('; ')}`);
    // Охоронна перевірка самої проби: без цих елементів сторож нічого не бачив би.
    await page.evaluate(() => go('overview'));
    assert.ok(await page.locator('#yearSum .ybars > div[data-tip]').count() > 0,
      `${mode}: стовпчики року справді намальовані — сторож їх бачить`);
    await page.evaluate(() => go('inv'));
    assert.equal(await page.locator('[data-bench]').count(), 1,
      `${mode}: плашка бенчмарка справді намальована — сторож її бачить`);
    assert.deepEqual(errors, [], `${mode}: помилки модального вікна`);
    assert.deepEqual(nativeDialogs, [], `${mode}: нативні діалоги не викликалися`);
    console.log(`${mode}: скасування, підтвердження, фокус і послідовні вікна — OK`);
    await context.close();
  }
} finally {
  await browser.close();
}
