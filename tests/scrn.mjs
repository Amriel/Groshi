import { chromium } from 'playwright';
const b=await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p=await b.newPage({viewport:{width:1400,height:1000}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2200);

const digits = async ()=> p.evaluate(()=>{
  const t=document.querySelector('section:not([hidden])').textContent;
  return { цифр:(t.match(/\d/g)||[]).length, крапок:(t.match(/•/g)||[]).length,
    відсотків:(t.match(/\d+[.,]?\d*%/g)||[]).length };
});
for(const tab of ['overview','cats','tx','inv','subs','budget']){
  await p.evaluate(t=>{ if(SCRN) scrnToggle(false); go(t); }, tab);
  await p.waitForTimeout(400);
  const before=await digits();
  await p.evaluate(()=>scrnToggle(true));
  await p.waitForTimeout(400);
  const after=await digits();
  console.log(tab.padEnd(9), 'до:', JSON.stringify(before), ' після:', JSON.stringify(after));
}
console.log('\nбейдж і кнопка:', await p.evaluate(()=>({
  бейдж: !el('scrnBadge').hidden, текст: el('scrnBadge').textContent.trim(),
  кнопка: el('scrnBtn').textContent, клас: document.body.classList.contains('scrn') })));
console.log('вимкнення клавішею:', await p.evaluate(async ()=>{
  document.body.focus();
  scrnToggle(false); await new Promise(r=>setTimeout(r,300));
  const t=document.querySelector('section:not([hidden])').textContent;
  return { крапок:(t.match(/•/g)||[]).length, бейдж_схований: el('scrnBadge').hidden };
}));
await p.evaluate(()=>{ scrnToggle(true); go('overview'); });
await p.waitForTimeout(700);
await p.screenshot({path:'/tmp/scrn.png'});
console.log(errs.length?'ПОМИЛКИ: '+errs.slice(0,4).join(' | '):'без помилок');
await b.close();
