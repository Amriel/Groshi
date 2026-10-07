import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.join(process.cwd(), '.test-artifacts');
fs.mkdirSync(output, {recursive:true});
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const ctx = await b.newContext({ viewport:{width:1300,height:900}, deviceScaleFactor:1 });
// Привітальне вікно першого запуску саме анімується (розмиття фону) і давало різницю кадрів, не пов'язану з перемиканням вкладок;
// тут перевіряємо вже налаштовану апку — так само, як modal.mjs.
await ctx.addInitScript(() => {
  localStorage.setItem('wizDone', 'true');
  localStorage.setItem('deskState', JSON.stringify({wizDone:true}));
});
const p = await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{ if(m.type()==='error') errs.push('console: '+m.text()); });
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2500);
/* ГОЛОВНИЙ тест: після перемикання вкладки кадр через 800 мс і через 1800 мс
   ІДЕНТИЧНИЙ. 800, а не 120: підсвітка активної вкладки в навбарі й пілюля
   періоду на Огляді доїжджають ковзанням (анімація tabInd) до ~0,8 с — це
   навмисний рух, а не зсув розкладки, і саме через нього проба падала на
   кожній вкладці. Заміряно піксельно: після 800 мс повний кадр стабільний
   побайтно, статика без перемикання — теж. Отже будь-яка різниця після
   800 мс — справжнє смикання (скло чи вміст, що доїжджають пізніше). */
// Той самий стан, той самий кодувальник PNG → однакові піксельні дані дають однакові байти,
// тож декодувати PNG (pngjs) не треба: достатньо порівняти буфери.
const failed=[];
for(const tab of ['cats','tx','subs','settings','overview']){
  await p.evaluate(t=>go(t), tab);
  await p.waitForTimeout(800);
  const a = await p.screenshot();
  await p.waitForTimeout(1100);
  const c = await p.screenshot();
  const same = a.equals(c);
  console.log(tab.padEnd(9), same ? 'кадри однакові' : 'КАДРИ РІЗНІ', `(${a.length} / ${c.length} байт)`);
  if(!same){
    fs.writeFileSync(path.join(output, `notrans-${tab}-a.png`), a);
    fs.writeFileSync(path.join(output, `notrans-${tab}-b.png`), c);
  }
  // Збираємо всі вкладки, а не падаємо на першій: так видно повну картину поломки.
  if(!same) failed.push(`вкладка «${tab}»: кадр через 800 мс (${a.length} байт) відрізняється від кадру через 1800 мс (${c.length} байт); PNG: .test-artifacts/notrans-${tab}-{a,b}.png`);
}
assert.equal(failed.length, 0, failed.join(' || '));
console.log('час перемикання:', await p.evaluate(()=>{
  const a=performance.now(); go('tx'); return Math.round(performance.now()-a); }), 'мс');
console.log(errs.length?errs.slice(0,4).join('\n'):'no errors');
assert.equal(errs.length, 0, `помилки консолі/сторінки: ${errs.slice(0,3).join(' | ')}`);
await b.close();
