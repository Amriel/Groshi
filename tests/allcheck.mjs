import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const p = await b.newPage({ viewport:{width:1400,height:1000} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(1800);
for(const t of ['overview','cats','tx','budget','subs','settings']){
  await p.evaluate(x=>go(x), t); await p.waitForTimeout(500);
}
await p.evaluate(()=>{ go('budget'); S.budSeg='proj'; render(); }); await p.waitForTimeout(600);
await p.click('#themeBtn'); await p.waitForTimeout(800);
await p.screenshot({path:'/tmp/Q1-light-proj.png'});
await p.evaluate(()=>{ S.period='custom'; render(); }); await p.waitForTimeout(400);
await p.evaluate(()=>go('overview')); await p.waitForTimeout(400);
await p.click('#dpOpen'); await p.waitForTimeout(600);
await p.screenshot({path:'/tmp/Q2-light-dp.png'});
console.log(errs.length?errs.slice(0,5).join('\n'):'no errors');
await b.close();
