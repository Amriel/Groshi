import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const b=await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p=await b.newPage({viewport:{width:1400,height:1000}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text());});
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2500);
for(const t of ['overview','cats','tx','budget','inv','subs', 'advisor', 'settings']){
  await p.evaluate(x=>go(x),t); await p.waitForTimeout(400);
  const r=await p.evaluate(()=>{ const s=document.querySelector('section:not([hidden])');
    return { видно:!!s, текст:s.textContent.replace(/\s+/g,' ').trim().slice(0,90) }; });
  console.log(t.padEnd(9), r.видно?'ok':'ПУСТО', '|', r.текст);
  // Сторож: порожня апка не падає на жодній вкладці. Раніше проба лише друкувала, тож CI лишався зеленим і з винятком у консолі, і з порожньою секцією.
  assert.ok(r.видно, `вкладка «${t}»: немає видимої секції`);
  assert.ok(r.текст.length > 0, `вкладка «${t}»: секція порожня`);
  assert.equal(errs.length, 0, `вкладка «${t}»: помилки консолі/сторінки: ${errs.slice(0,3).join(' | ')}`);
}
console.log('\nпомилки:', errs.length?errs.slice(0,6):'немає');
assert.equal(errs.length, 0, `помилки консолі/сторінки: ${errs.slice(0,3).join(' | ')}`);
await p.screenshot({path:'.test-artifacts/empty.png'});
await b.close();
