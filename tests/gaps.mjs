import { chromium } from 'playwright';
const b=await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p=await b.newPage({viewport:{width:1400,height:1000}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2200);
/* дані для Кошторисів */
await p.evaluate(()=>{
  PROJ.length=0;
  PROJ.push({id:'p1',name:'Лендінг',client:'Nord',status:'done',usd:41.5,tax:0,rows:[{task:'Дизайн',type:'d',rate:400,days:12,ot:0,text:''}]});
  PROJ.push({id:'p2',name:'Застосунок',client:'Acme',status:'active',usd:41.5,tax:0,rows:[{task:'UI',type:'d',rate:500,days:30,ot:0,text:''}]});
  PJ_VIEW='list'; store.set('projView','list'); pjSave();
  store.set('bizProfiles',[{label:'Основний USD',name:'PE IVANOV IVAN',iban:'UA000000000000000000000000'}]);
  store.set('clients',{Acme:{full:'ACME LIMITED',reg:'HE100200',ccy:'USD'}});
});
/* мінімальні зазори між сусідніми картками на кожній вкладці */
for(const t of ['overview','cats','tx','budget','inv','subs','settings']){
  const r=await p.evaluate(async tab=>{
    go(tab); await new Promise(r=>setTimeout(r,500));
    const sec=document.querySelector('section:not([hidden])');
    const cards=[...sec.querySelectorAll('.card')].filter(c=>!c.hidden&&c.offsetParent&&c.getBoundingClientRect().height>10);
    const rects=cards.map(c=>({r:c.getBoundingClientRect(),n:(c.querySelector('h2')||{}).textContent||c.className}));
    rects.sort((a,b)=>a.r.top-b.r.top);
    const tight=[];
    for(let i=1;i<rects.length;i++){
      const prev=rects[i-1], cur=rects[i];
      /* поруч по горизонталі (в одному ряду грида) — не рахуємо */
      const sameRow = Math.abs(prev.r.top-cur.r.top) < 6;
      if(sameRow) continue;
      const gap = Math.round(cur.r.top - prev.r.bottom);
      if(gap < 8) tight.push({між:[prev.n.slice(0,22), cur.n.slice(0,22)], зазор:gap});
    }
    return { карток:cards.length, злиплих:tight.length, деталі:tight.slice(0,4) };
  }, t);
  console.log(t.padEnd(10), JSON.stringify(r));
}
console.log(errs.length?'ПОМИЛКИ: '+errs.slice(0,4).join(' | '):'без помилок');
await b.close();
