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
    await context.addInitScript(() => {
      localStorage.setItem('wizDone', 'true');
      localStorage.setItem('deskState', JSON.stringify({wizDone:true}));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if(message.type()==='error') errors.push(message.text()); });
    await context.route(/^https?:/, route => route.abort());
    await page.goto(pathToFileURL(path.join(root,
      mode==='browser' ? 'app/Groshi_app.html' : 'desktop/dist/index.html')).href);
    await page.waitForFunction(() => typeof window.go==='function');
    for (const tab of ['overview','cats','tx','budget','inv','subs','settings']) {
      await page.evaluate(value => go(value), tab);
      await page.locator(`#tab-${tab}`).waitFor({state:'visible'});
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('section[id^="tab-"]')]
        .filter(node => !node.hidden).length), 1, `${mode}: відкрита рівно одна вкладка`);
    }
    await page.evaluate(() => go('budget'));
    const oldTheme = await page.locator('html').getAttribute('data-theme');
    await page.locator('#themeBtn').click();
    assert.notEqual(await page.locator('html').getAttribute('data-theme'), oldTheme,
      `${mode}: кнопка змінила тему`);
    await page.screenshot({path:path.join(output, `allcheck-${mode}-projects.png`)});
    await page.evaluate(() => { S.period='custom'; go('overview'); });
    await page.locator('#dpOpen').click();
    await page.locator('#dp').waitFor({state:'visible'});
    await page.screenshot({path:path.join(output, `allcheck-${mode}-dates.png`)});
    assert.deepEqual(errors, [], `${mode}: помилки JavaScript або консолі`);
    console.log(`${mode}: 7 вкладок, тема й вибір періоду — OK`);
    await context.close();
  }
} finally {
  await browser.close();
}
