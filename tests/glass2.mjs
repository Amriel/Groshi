import { chromium } from 'playwright';
const b=await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p=await b.newPage({viewport:{width:1400,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2200);
await p.evaluate(()=>{ go('tx'); el('qAll').checked=true; S.limit=400; renderTx(); });
await p.waitForTimeout(900);

console.log('коалесція під час скролу:', await p.evaluate(async ()=>{
  const gg=document.querySelector('glass-gl');
  let draws=0; const o=gg.draw.bind(gg); gg.draw=function(){ draws++; return o(); };
  const start=draws;
  /* безперервний скрол — як рух колесом */
  for(let i=0;i<20;i++){ scrollBy(0,600); await new Promise(r=>setTimeout(r,16)); }   // темп реального колеса
  const during=draws-start;
  await new Promise(r=>setTimeout(r,400));
  const after=draws-start;
  return { кадрів_під_час_скролу: during, кадрів_після_зупинки: after-during,
    видно: gg.canvas.style.visibility!=='hidden' };
}));

console.log('привиди:', await p.evaluate(async ()=>{
  const gg=document.querySelector('glass-gl');
  let draws=0; const o=gg.draw.bind(gg); gg.draw=function(){ draws++; return o(); };
  let jumps=0, ghosts=0, prev=parseInt(gg.style.top||0);
  for(let i=0;i<25;i++){
    const d0=draws; scrollBy(0,900);
    await new Promise(r=>requestAnimationFrame(r));
    const top=parseInt(gg.style.top||0);
    if(top!==prev){ jumps++; if(gg.canvas.style.visibility!=='hidden' && draws===d0) ghosts++; }
    prev=top;
  }
  await new Promise(r=>setTimeout(r,500));
  return { стрибків:jumps, привидів:ghosts, видно_після:gg.canvas.style.visibility!=='hidden' };
}));

/* Кошториси: плита не має стояти вище за свою картку */
console.log('кошториси — збіг плит:', await p.evaluate(async ()=>{
  PROJ.length=0;
  PROJ.push({id:'p1',name:'Лендінг',client:'Nord',status:'done',usd:41.5,tax:0,rows:[{task:'Дизайн',type:'d',rate:400,days:12,ot:0,text:''}]});
  PROJ.push({id:'p2',name:'Застосунок',client:'Acme',status:'active',usd:41.5,tax:0,rows:[{task:'UI',type:'d',rate:500,days:30,ot:0,text:''}]});
  PJ_VIEW='list'; store.set('projView','list'); pjSave();
  scrollTo(0,0); go('projects');
  await new Promise(r=>setTimeout(r,600));
  /* розкриваємо групу — висота картки міняється БЕЗ зміни розмітки сусідів */
  const h=document.querySelector('.pjgrph'); if(h) h.click();
  await new Promise(r=>setTimeout(r,500));
  const cards=[...document.querySelectorAll('section:not([hidden]) .card')].filter(c=>!c.hidden&&c.offsetParent);
  const rects=cards.map(c=>{const b=c.getBoundingClientRect();return {y:Math.round(b.top),h:Math.round(b.height),t:(c.querySelector('h2')||{}).textContent||''};});
  /* перекриття карток між собою — ознака, що щось стоїть не на місці */
  let overlap=0;
  for(let i=0;i<rects.length;i++) for(let j=i+1;j<rects.length;j++){
    const a=rects[i],c=rects[j];
    if(a.y < c.y+c.h && c.y < a.y+a.h) overlap++;
  }
  return { карток:cards.length, перекриттів:overlap,
    ro_підписка: !!document.querySelector('.card')._roOn };
}));
console.log(errs.length?'ПОМИЛКИ: '+errs.slice(0,4).join(' | '):'без помилок');
await b.close();
