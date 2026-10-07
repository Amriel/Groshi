import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const b=await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p=await b.newPage({viewport:{width:1400,height:1000}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2000);
const grp = await p.evaluate(()=>{
  PROJ.length=0;
  PROJ.push({id:'p1',name:'Лендінг',client:'Nord',status:'done',usd:41.5,tax:0,rows:[{task:'Дизайн',type:'d',rate:400,days:12,ot:0,text:''}]});
  PROJ.push({id:'p2',name:'Застосунок',client:'Acme',status:'active',usd:41.5,tax:0,rows:[{task:'UI',type:'d',rate:500,days:30,ot:0,text:''}]});
  PJ_VIEW='list'; store.set('projView','list'); pjSave(); go('projects'); renderProjects();
  const g=[...document.querySelectorAll('.pjgrp')];
  const cs=g.length?getComputedStyle(g[0]):null;
  return { груп:g.length, назви:g.map(x=>x.querySelector('.nm').textContent),
    рамка:cs&&cs.borderStyle, радіус:cs&&cs.borderRadius,
    проміжок:g[1]?getComputedStyle(g[1]).marginTop:'—',
    фон_відкритої:g.find(x=>x.classList.contains('open'))?'є':'нема' };
});
console.log('групи проєктів:', grp);
// Сторож: у кошторисах два клієнти дають ≥ 2 візуально розділені групи (рамка, радіус, проміжок між групами).
assert.ok(grp.груп >= 2, `груп проєктів ${grp.груп}, очікувалось ≥ 2 (${JSON.stringify(grp.назви)})`);
assert.ok(grp.рамка && grp.рамка !== 'none', `група без рамки: border-style=${grp.рамка}`);
assert.ok(grp.радіус && parseFloat(grp.радіус) > 0, `група без радіуса: border-radius=${grp.радіус}`);
assert.ok(grp.проміжок !== '—' && parseFloat(grp.проміжок) > 0, `немає проміжку між групами: margin-top=${grp.проміжок}`);
await p.screenshot({path:'.test-artifacts/pjui.png'});
console.log(errs.length?'ПОМИЛКИ: '+errs.slice(0,4).join(' | '):'без помилок');
assert.equal(errs.length, 0, `помилки консолі/сторінки: ${errs.slice(0,3).join(' | ')}`);
await b.close();
