import { chromium } from 'playwright';
import { PNG } from 'pngjs';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const p = await b.newPage({ viewport:{width:1300,height:900}, deviceScaleFactor:1 });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{ if(m.type()==='error') errs.push('console: '+m.text()); });
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2500);
// ГОЛОВНИЙ тест: після перемикання вкладки кадр через 120мс і через 1200мс ІДЕНТИЧНИЙ
const diff=(a,c)=>{ const A=PNG.sync.read(a), C=PNG.sync.read(c); let n=0,mx=0;
  for(let i=0;i<A.data.length;i+=4){ const d=Math.max(Math.abs(A.data[i]-C.data[i]),
    Math.abs(A.data[i+1]-C.data[i+1]), Math.abs(A.data[i+2]-C.data[i+2]));
    if(d>3){ n++; mx=Math.max(mx,d);} } return {пікселівЗмінилось:n, макс:mx}; };
for(const tab of ['cats','tx','subs','settings','overview']){
  await p.evaluate(t=>go(t), tab);
  await p.waitForTimeout(120);
  const a = await p.screenshot();
  await p.waitForTimeout(1100);
  const c = await p.screenshot();
  console.log(tab.padEnd(9), JSON.stringify(diff(a,c)));
}
console.log('час перемикання:', await p.evaluate(()=>{
  const a=performance.now(); go('tx'); return Math.round(performance.now()-a); }), 'мс');
console.log(errs.length?errs.slice(0,4).join('\n'):'no errors');
await b.close();
