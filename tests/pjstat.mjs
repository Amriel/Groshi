import { chromium } from 'playwright';
const b=await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p=await b.newPage({viewport:{width:1400,height:1000}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2200);
await p.evaluate(()=>{
  PROJ.length=0;
  PROJ.push({id:'p1',name:'Лендінг',client:'Nord',status:'active',usd:41.5,tax:0,rate:400,rows:[{task:'Дизайн',type:'d',rate:400,days:12,ot:0,text:''}]});
  PROJ.push({id:'p2',name:'Застосунок',client:'Acme',status:'done',usd:41.5,tax:0,rate:500,rows:[{task:'UI',type:'d',rate:500,days:30,ot:0,text:''}]});
  PJ_VIEW='list'; store.set('projView','list'); pjSave(); go('budget'); renderProjects();
});
await p.waitForTimeout(600);

console.log('чіпи станів у списку:', await p.evaluate(()=>{
  const chips=[...document.querySelectorAll('[data-pjst]')];
  return { чіпів:chips.length, підписи:chips.map(c=>c.textContent.trim()),
    підказка:chips[0]&&chips[0].dataset.tip };
}));

console.log('KPI:', await p.evaluate(()=>
  [...document.querySelectorAll('#pjTotals .kpi')].map(k=>
    k.querySelector('.lbl').textContent+': '+k.querySelector('.val').textContent+' ('+k.querySelector('.sub').textContent+')')));

console.log('випадайка станів:', await p.evaluate(async ()=>{
  const c=[...document.querySelectorAll('[data-pjst]')].find(x=>x.dataset.pjst==='p1');
  c.click(); await new Promise(r=>setTimeout(r,450));
  const rows=[...document.querySelectorAll('#modalPick .pickrow')];
  const out={ варіантів:rows.length, підписи:rows.map(r=>r.textContent.replace(/\s+/g,' ').trim()) };
  rows.find(r=>/Оплачено/.test(r.textContent)).click();
  await new Promise(r=>setTimeout(r,350));
  const pr=PROJ.find(x=>x.id==='p1');
  out.стало = pr.status; out.дата = pr.paidAt||'—';
  out.збережено = (JSON.parse(localStorage.getItem('projects')||'[]').find(x=>x.id==='p1')||{}).status;
  return out;
}));

console.log('клік по рядку відкриває проєкт:', await p.evaluate(async ()=>{
  const row=[...document.querySelectorAll('[data-open]')].find(x=>x.dataset.open==='p2');
  row.querySelector('.nm').click(); await new Promise(r=>setTimeout(r,400));
  return { вид:PJ_VIEW, поточний:PJ_CUR };
}));

console.log('селект у картці має 3 стани:', await p.evaluate(async ()=>{
  const st=el('pjStatus');
  const opts=[...st.options].map(o=>o.value+':'+o.text);
  st.value='paid'; st.dispatchEvent(new Event('change',{bubbles:true}));
  await new Promise(r=>setTimeout(r,400));
  const pr=PROJ.find(x=>x.id==='p2');
  return { опції:opts, стан:pr.status, дата_оплати:pr.paidAt||'—' };
}));

console.log('KPI після оплати:', await p.evaluate(async ()=>{
  PJ_VIEW='list'; store.set('projView','list'); renderProjects();
  await new Promise(r=>setTimeout(r,300));
  return [...document.querySelectorAll('#pjTotals .kpi')].map(k=>
    k.querySelector('.lbl').textContent+': '+k.querySelector('.val').textContent);
}));
await p.screenshot({path:'/tmp/pjstat.png'});
console.log(errs.length?'ПОМИЛКИ: '+errs.slice(0,5).join(' | '):'без помилок');
await b.close();
