import { chromium } from 'playwright';
const b=await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p=await b.newPage({viewport:{width:1400,height:1000}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text());});
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2500);
for(const t of ['overview','cats','tx','budget','inv','subs','settings']){
  await p.evaluate(x=>go(x),t); await p.waitForTimeout(400);
  const r=await p.evaluate(()=>{ const s=document.querySelector('section:not([hidden])');
    return { видно:!!s, текст:s.textContent.replace(/\s+/g,' ').trim().slice(0,90) }; });
  console.log(t.padEnd(9), r.видно?'ok':'ПУСТО', '|', r.текст);
}
console.log('\nпомилки:', errs.length?errs.slice(0,6):'немає');
await p.screenshot({path:'/tmp/empty.png'});
await b.close();
