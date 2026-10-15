// Знімки для ручного порівняння «до/після»: 7 вкладок × 2 теми × 3 ширини.
// Це інструмент, а не сторож: нічого не стверджує, лише пише PNG.
// Запуск: node tests/snap.mjs <мітка>   → .test-artifacts/snap-<мітка>/
// SNAP_DESKTOP=1 — ті самі знімки з десктопної збірки зі штучними
// інвестиціями (tests/helpers/desktop-boot.mjs): у браузерній «Інвестиції»
// показують лише заглушку, справжній екран є тільки в десктопній.
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import {openDesktop} from './helpers/desktop-boot.mjs';
const label = process.argv[2];
const DESKTOP = process.env.SNAP_DESKTOP === '1';
if (!label) { console.error('usage: node tests/snap.mjs <мітка>'); process.exit(2); }
const file = process.env.SNAP_FILE || path.join(root, '.test-artifacts', 'synthetic_app.html');
if (DESKTOP && !fs.existsSync(path.join(root, 'desktop', 'dist', 'app.js'))) {
  console.error('немає desktop/dist/app.js — спершу зібрати: python desktop/build_desktop.py');
  process.exit(2);
}
if (!DESKTOP && !fs.existsSync(file)) {
  console.error(`немає ${file} — спершу зібрати: python app/build_app.py --data .test-artifacts/synthetic.json --out .test-artifacts/synthetic_app.html`);
  process.exit(2);
}
const outDir = path.join(root, '.test-artifacts', `snap-${label}`);
fs.mkdirSync(outDir, {recursive: true});
const WIDTHS = [[1400, 900], [900, 800], [390, 844]];
const TABS = ['overview', 'cats', 'tx', 'budget', 'inv', 'subs', 'settings'];
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const errors = [];
for (const [w, h] of WIDTHS) {
  let ctx, page;
  if (DESKTOP) {
    // Помилки збирає сам помічник із першої миті завантаження.
    let deskErrors;
    ({ctx, page, errors: deskErrors} = await openDesktop(browser, {width: w, height: h}));
    ctx.on('close', () => errors.push(...deskErrors));
  } else {
    ctx = await browser.newContext({viewport: {width: w, height: h}});
    await ctx.addInitScript(() => localStorage.setItem('wizDone', 'true'));
    await ctx.route(/^https?:/, r => r.abort());
    page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => typeof window.go === 'function');
  }
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t; store.set('theme', t); }, theme);
    for (const tab of TABS) {
      await page.evaluate(t => go(t), tab);
      await page.waitForTimeout(900);
      await page.screenshot({path: path.join(outDir, `${theme}-${w}-${tab}.png`)});
      // «Інвестиції» в десктопі — кілька екранів заввишки; верхній кадр
      // показав би лише KPI, тож додатково знімаємо всю сторінку.
      if (DESKTOP && tab === 'inv')
        await page.screenshot({path: path.join(outDir, `${theme}-${w}-inv-full.png`), fullPage: true});
    }
  }
  await ctx.close();
}
await browser.close();
if (errors.length) { console.error('ПОМИЛКИ:', errors.slice(0, 5)); process.exit(1); }
console.log('знімків:', fs.readdirSync(outDir).length, '→', outDir);
