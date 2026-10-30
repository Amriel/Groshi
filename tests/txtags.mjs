// Мітки переказів у картці операції: «борг / квартира / рідним / подарунок».
// Мету переказу людям і зняття готівки з виписки не видно — Порадник
// просив саме її (відгук 30.10.2026). Сторожимо:
//  · чипи є лише в картці витрати «Перекази»/«Готівка»;
//  · клік ставить мітку (aria-pressed, localStorage.txTags, бейдж у рядку),
//    повторний клік знімає;
//  · картка й рядок не зсуваються від кліку (±0.5 px).
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
  const context = await browser.newContext({viewport: {width: 1400, height: 1000}});
  await context.addInitScript(() => localStorage.setItem('wizDone', 'true'));
  await context.route(/^https?:/, r => r.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(app);
  await page.waitForFunction(() => typeof window.go === 'function');
  await page.evaluate(() => go('tx'));
  const ids = await page.evaluate(() => {
    const last = c => [...TX].reverse().find(t => catOf(t) === c && t.dir === 'expense').id;
    return {people: last('Перекази'), food: last('Продукти')};
  });

  const row = page.locator(`.txrow[data-id="${ids.people}"]`);
  await row.click();
  const chips = page.locator('.txtag');
  assert.deepEqual(await chips.allInnerTexts(), ['борг', 'квартира', 'рідним', 'подарунок'], 'чотири мітки');
  const rect = s => page.locator(s).first().evaluate(n => { const r = n.getBoundingClientRect(); return [r.x, r.y + scrollY, r.width, r.height]; });
  const near = (a, b, what) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= 0.5, `${what} зсунувся: ${a} → ${b}`));
  const card0 = await rect('.txdetail'), row0 = await rect(`.txrow[data-id="${ids.people}"]`);

  await chips.filter({hasText: 'борг'}).click();
  await page.locator('.txdetail').screenshot({path: path.join(root, '.test-artifacts', 'txtags-card.png')});
  assert.equal(await chips.filter({hasText: 'борг'}).getAttribute('aria-pressed'), 'true');
  assert.equal(await chips.filter({hasText: 'квартира'}).getAttribute('aria-pressed'), 'false');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('txTags'))), {[ids.people]: 'debt'});
  assert.equal(await row.locator('.txtagb').innerText(), 'борг', 'бейдж у рядку');
  assert.ok(await page.locator('.txdetail').isVisible(), 'клік по чипу не закрив картку');
  near(card0, await rect('.txdetail'), 'картка');
  near(row0, await rect(`.txrow[data-id="${ids.people}"]`), 'рядок');

  await chips.filter({hasText: 'рідним'}).click();
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('txTags'))), {[ids.people]: 'family'}, 'одна мітка на операцію');
  await chips.filter({hasText: 'рідним'}).click();
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('txTags'))), {}, 'повторний клік знімає');
  assert.equal(await row.locator('.txtagb').count(), 0, 'бейдж зник');
  near(card0, await rect('.txdetail'), 'картка');

  await page.keyboard.press('Escape');
  await row.click();                                   // згорнути
  await page.locator(`.txrow[data-id="${ids.food}"]`).click();
  assert.equal(await page.locator('.txdetail .txtag').count(), 0, 'у «Продуктів» міток немає');
  assert.deepEqual(errors, [], 'помилки сторінки');
  console.log('txtags: мітки ставляться, знімаються, нічого не смикається — OK');
  await context.close();
} finally {
  await browser.close();
}
