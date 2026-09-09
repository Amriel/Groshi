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
    await page.waitForFunction(() => typeof window.pjOpen==='function');
    await page.evaluate(() => {
      PROJ=[{id:'synthetic-project',client:'Приклад',name:'Проба кошторису',status:'active',
        rate:300,tax:6,usd:45,rows:[
          {id:'synthetic-row-1',task:'Дизайн',type:'Art',rate:300,days:8,ot:0,ind:0,note:''},
          {id:'synthetic-row-2',task:'Розробка',type:'Development',rate:300,days:14,ot:0,ind:0,note:''},
          {id:'synthetic-row-3',task:'Витрати',type:'AI Fee',rate:0,days:0,ot:0,ind:30,note:''}
        ]}];
      PJ_CUR='synthetic-project';PJ_VIEW='one';pjSave();go('budget');
    });
    const row = page.locator('tr[data-r="synthetic-row-1"]');
    const rate = row.locator('[data-f="rate"]');
    const typeButton = row.locator('.cselb');
    await row.waitFor({state:'visible'});
    await rate.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = () => page.evaluate(() => [...document.querySelectorAll('#pjTable tr[data-r]')]
      .map(node => {
        const r=node.getBoundingClientRect();
        return {id:node.dataset.r,x:r.x,y:r.y,width:r.width,height:r.height};
      }));
    const before = await bounds();
    await page.evaluate(() => { window.__projectRow=document.querySelector('tr[data-r="synthetic-row-1"]'); });
    await rate.fill('450');
    await rate.press('Tab');
    await page.waitForFunction(() => pjCur().rows[0].rate===450);
    assert.equal(await page.evaluate(() => window.__projectRow===document.querySelector('tr[data-r="synthetic-row-1"]')),
      true, `${mode}: редагування зберігає сам DOM-рядок`);
    assert.deepEqual(await bounds(), before, `${mode}: редагування ставки не рухає рядки`);
    assert.equal(await page.evaluate(() => pjUSD(pjCur(),pjCur().rows[0])), 3600,
      `${mode}: зміна ставки перерахувала суму`);

    const buttonBefore = await typeButton.boundingBox();
    await typeButton.click();
    const menu = page.locator('.cselm:visible');
    await menu.waitFor({state:'visible'});
    assert.deepEqual(await bounds(), before, `${mode}: відкриття меню не рухає рядки`);
    assert.deepEqual(await typeButton.boundingBox(), buttonBefore, `${mode}: кнопка не стрибає`);
    const box = await menu.boundingBox();
    assert.ok(box && box.width>0 && box.height>0 && box.x>=0 && box.y>=0
      && box.x+box.width<=1400 && box.y+box.height<=1000,
    `${mode}: меню цілком у межах вікна`);
    await page.screenshot({path:path.join(output, `pjjump-${mode}.png`)});
    await menu.getByRole('button', {name:'Розробка', exact:true}).click();
    await page.waitForFunction(() => pjCur().rows[0].type==='Development');
    assert.deepEqual(await bounds(), before, `${mode}: вибір довшого типу не рухає рядки`);
    assert.deepEqual(await typeButton.boundingBox(), buttonBefore, `${mode}: довший тип не розширює кнопку`);
    assert.equal(await menu.count(), 0, `${mode}: після вибору меню закривається`);
    assert.deepEqual(errors, [], `${mode}: помилки кошторису`);
    console.log(`${mode}: ставка й тип змінені, рядки та кнопка — 0 px зсуву, меню у вікні`);
    await context.close();
  }
} finally {
  await browser.close();
}
