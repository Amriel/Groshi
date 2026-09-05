import { chromium } from 'playwright';
const b=await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p=await b.newPage({viewport:{width:1400,height:950}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2200);

/* A. фон під час переїзду шару */
console.log('фон при скролі:', await p.evaluate(async ()=>{
  go('tx'); el('qAll').checked=true; S.limit=400; renderTx();
  await new Promise(r=>setTimeout(r,700));
  const cs=getComputedStyle(document.body);
  const gg=document.querySelector('glass-gl');
  let hiddenFrames=0, checks=0;
  for(let i=0;i<14;i++){ scrollBy(0,900); await new Promise(r=>setTimeout(r,16));
    checks++; if(gg.canvas.style.visibility==='hidden') hiddenFrames++; }
  return { css_підкладка: /linear-gradient/.test(cs.backgroundImage),
    прикріплена: cs.backgroundAttachment, кадрів_без_полотна: hiddenFrames+'/'+checks };
}));

/* B. кошторис у режимі скріншоту */
console.log('кошторис масковано:', await p.evaluate(async ()=>{
  PROJ.length=0;
  PROJ.push({id:'p9',name:'Проєкт',client:'Клієнт',status:'done',usd:45,tax:6,rate:300,
    rows:[{id:'r1',task:'Man',type:'Generation',rate:53,days:110,ot:0,ind:0,note:''}]});
  PJ_VIEW='list'; store.set('projView','list'); pjSave(); go('budget');
  await new Promise(r=>setTimeout(r,400));
  scrnToggle(true); await new Promise(r=>setTimeout(r,400));
  const list=document.querySelector('#tab-budget').textContent.replace(/\s+/g,' ');
  pjOpen('p9'); await new Promise(r=>setTimeout(r,500));
  const card=document.querySelector('#tab-budget').textContent.replace(/\s+/g,' ');
  const blurred=getComputedStyle(document.querySelector('#pjRate')).filter;
  return { список_без_доларів: !/\$\s?\d/.test(list), приклад_списку:(list.match(/\$[^\s]*/g)||[]).slice(0,3),
    картка_без_доларів: !/\$\s?\d/.test(card), приклад_картки:(card.match(/\$[^\s]*/g)||[]).slice(0,3),
    поля_розмиті: blurred };
}));

/* C. випадайка станів */
console.log('випадайка стану:', await p.evaluate(async ()=>{
  scrnToggle(false);
  PJ_VIEW='list'; store.set('projView','list'); renderProjects();
  await new Promise(r=>setTimeout(r,400));
  document.querySelector('[data-pjst]').click();
  await new Promise(r=>setTimeout(r,450));
  const rows=[...document.querySelectorAll('#modalPick .pickrow')];
  const out={ заголовок: el('modalT').textContent, варіантів: rows.length,
    підписи: rows.map(r=>r.textContent.replace(/\s+/g,' ').trim()) };
  const paid=rows.find(r=>/Оплачено/.test(r.textContent)); paid.click();
  await new Promise(r=>setTimeout(r,400));
  out.стало = PROJ[0].status; out.дата = PROJ[0].paidAt||'—';
  return out;
}));
console.log(errs.length?'ПОМИЛКИ: '+errs.slice(0,4).join(' | '):'без помилок');
await b.close();
