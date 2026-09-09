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
    assert.deepEqual(errors, [], `${mode}: помилки модального вікна`);
    assert.deepEqual(nativeDialogs, [], `${mode}: нативні діалоги не викликалися`);
    console.log(`${mode}: скасування, підтвердження, фокус і послідовні вікна — OK`);
    await context.close();
  }
} finally {
  await browser.close();
}
