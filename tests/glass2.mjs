import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const b=await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p=await b.newPage({viewport:{width:1400,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2200);
await p.evaluate(()=>{ go('tx'); el('qAll').checked=true; S.limit=400; renderTx(); });
await p.waitForTimeout(900);

const coal = await p.evaluate(async ()=>{
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
});
console.log('коалесція під час скролу:', coal);
// Сторож: скло не малює кадр під час руху (малює лише після зупинки) і лишається видимим.
assert.equal(coal.кадрів_під_час_скролу, 0, `скло намалювало ${coal.кадрів_під_час_скролу} кадр(ів) під час скролу`);
assert.ok(coal.видно, 'скляний шар схований після скролу');

const ghost = await p.evaluate(async ()=>{
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
});
console.log('привиди:', ghost);
// Сторож: ні в одному зсуві плити під час скролу не лишається «привида» (зсув без перемальовування і без приховування).
assert.equal(ghost.привидів, 0, `привиди скла: ${ghost.привидів} з ${ghost.стрибків} стрибків`);
assert.ok(ghost.видно_після, 'скляний шар схований після зупинки скролу');

/* Кошториси: плита не має стояти вище за свою картку */
const plates = await p.evaluate(async ()=>{
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
});
console.log('кошториси — збіг плит:', plates);
// Сторож: картки в Кошторисах не накладаються (плита не стоїть вище за свою картку).
assert.equal(plates.перекриттів, 0, `Кошториси: ${plates.перекриттів} перекриттів карток`);
console.log(errs.length?'ПОМИЛКИ: '+errs.slice(0,4).join(' | '):'без помилок');
assert.equal(errs.length, 0, `помилки консолі/сторінки: ${errs.slice(0,3).join(' | ')}`);
await b.close();
