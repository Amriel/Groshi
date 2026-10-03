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
    // Майстер знайомства перекрив би інтерфейс — пропускаємо його в обох сховищах.
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

    // ПЕРЕВІРКА — замінити: дія людини + assert на результат.
    // Приклад заміру «нічого не смикається»:
    //   const before = await page.locator('#x').boundingBox();
    //   ...дія...
    //   const after = await page.locator('#x').boundingBox();
    //   assert.deepEqual(after, before, `${mode}: елемент не зрушив`);

    assert.deepEqual(errors, [], `${mode}: помилки JavaScript або консолі`);
    console.log(`${mode}: <що доведено> — OK`);
    await context.close();
  }
} finally {
  await browser.close();
}
