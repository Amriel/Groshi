// Порівняння з попереднім періодом і «Витрати в середньому» на неповному
// періоді. Сторожить ваду 03.10.2026: «Місяць» на третій день порівнювався
// з усім вереснем («▼ 98%») і показував витрати трьох днів як «на місяць».
// Лише десктопна збірка: там межі дат перераховує bootDates() після зміни TX.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({executablePath:process.env.CHROMIUM || undefined});
const ctx = await browser.newContext({viewport:{width:1400,height:1000}});
await ctx.addInitScript(()=>{localStorage.setItem('deskState',JSON.stringify({wizDone:true}));});
await ctx.route(/^https?:/, r=>r.abort());
const page = await ctx.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
await page.goto(pathToFileURL(path.join(ROOT,'desktop/dist/index.html')).href);
await page.waitForFunction(()=>typeof window.go==='function');
const res = await page.evaluate(()=>{
  const out={};
  const tx=(id,date,amount)=>({id,date,merchant:'M',category:'Їжа',subcategory:'Кафе',dir:'expense',amount:amount,mcc:5814});
  const setData = list => { TX.length=0; TX.push(...list); bootDates(); };
  // вересень: по 100 щодня (3000), жовтень 1–3: по 100 (300)
  const sep=[...Array(30)].map((_,i)=>tx('s'+i,`2026-09-${String(i+1).padStart(2,'0')}`,100));
  setData([...sep, tx('o1','2026-10-01',100), tx('o2','2026-10-02',100), tx('o3','2026-10-03',100)]);
  S.period='1m'; go('overview');
  out.partial = { range: prevRange(), kpi: el('kpis').innerText };
  // повний вересень → серпень повністю
  setData(sep.concat([...Array(31)].map((_,i)=>tx('a'+i,`2026-08-${String(i+1).padStart(2,'0')}`,100))));
  S.period='1m'; go('overview');
  out.full = { range: prevRange(), kpi: el('kpis').innerText };
  // 31 березня → кінець лютого
  setData([tx('m','2026-03-31',100), tx('f','2026-02-28',100)]);
  out.mar = prevRange();
  // 3 місяці з неповним останнім
  setData([...sep, tx('o1','2026-10-03',100), tx('a1','2026-08-15',100)]);
  S.period='3m'; go('overview');
  out.q = { range: prevRange(), kpi: el('kpis').innerText };
  return out;
});
assert.deepEqual(res.partial.range, ['2026-09-01','2026-09-03']);
assert.match(res.partial.kpi, /0% до 1 вер – 3 вер/);
assert.match(res.partial.kpi, /на день · за 3 дн/);
assert.deepEqual(res.full.range, ['2026-08-01','2026-08-31']);
assert.match(res.full.kpi, /на місяць/);
assert.deepEqual(res.mar, ['2026-02-01','2026-02-28']);
assert.deepEqual(res.q.range, ['2026-05-01','2026-07-03']);
assert.deepEqual(errors, []);
await browser.close();
console.log('desktop: «Місяць» 1–3 жовт. проти 1–3 вер., повний місяць проти повного, середнє — денне на неповному');
