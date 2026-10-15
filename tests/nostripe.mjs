// Правило проєкту: жодних кольорових смуг збоку карток, рядків і панелей.
// Для кожного видимого елемента порівнюємо ліву межу з іншими: товста й
// інакше забарвлена ліва межа — це смуга.
// Відомі сліпі плями (смугу в такій формі проба НЕ побачить — їх ловить
// рецензія й ручний огляд знімків): псевдоелементи ::before/::after
// (getComputedStyle самого елемента їх не містить); outline; градієнт у
// background-image (linear-gradient із різкою межею); окремий вузький
// елемент position:fixed/absolute поза section і #side; правила лише для
// вузьких екранів — проба ганяє тільки 1400 px.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.SNAP_FILE || path.join(root, '.test-artifacts', 'synthetic_app.html');
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const bad = [];
try {
  const ctx = await browser.newContext({viewport: {width: 1400, height: 900}});
  await ctx.addInitScript(() => localStorage.setItem('wizDone', 'true'));
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => typeof window.go === 'function');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    for (const tab of ['overview', 'cats', 'tx', 'budget', 'inv', 'subs', 'settings']) {
      await page.evaluate(t => go(t), tab); await page.waitForTimeout(400);
      const hits = await page.evaluate(() => {
        const out = [];
        for (const n of document.querySelectorAll('section:not([hidden]) *, #side *')) {
          if (n.offsetParent === null) continue;
          const c = getComputedStyle(n);
          const lw = parseFloat(c.borderLeftWidth), rw = parseFloat(c.borderRightWidth);
          const stripe = lw >= 2 && c.borderLeftStyle !== 'none' && c.borderLeftColor !== c.borderRightColor
            && c.borderLeftColor !== 'rgba(0, 0, 0, 0)' && rw < lw;
          // inset-тінь без розмиття зі зсувом по X — друга форма смуги.
          // Chromium віддає обчислену тінь як «колір X Y blur spread inset»:
          // слово inset стоїть у КІНЦІ шару, тож регулярка «inset X 0 0» за
          // текстом CSS-джерела тут ніколи б не спрацювала. Розбираємо шари.
          const layers = c.boxShadow === 'none' ? [] : c.boxShadow.split(/,(?![^(]*\))/);
          const inset = layers.some(l => {
            if (!/\binset\b/.test(l)) return false;
            const px = (l.replace(/rgba?\([^)]*\)|color\([^)]*\)/g, '').match(/-?[\d.]+px/g) || []).map(parseFloat);
            const [x = 0, y = 0, blur = 0] = px;
            return Math.abs(x) >= 1 && y === 0 && blur === 0;
          });
          if (stripe || inset) out.push((n.className || n.tagName).toString().slice(0, 40));
        }
        return out;
      });
      for (const h of hits) bad.push(`${theme}/${tab}: ${h}`);
    }
  }
  assert.deepEqual([...new Set(bad)], [], 'кольорові бічні смуги:\n' + [...new Set(bad)].join('\n'));
  console.log('бічних смуг немає — OK');
} finally { await browser.close(); }
