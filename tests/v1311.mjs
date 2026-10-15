// Сторож 1.31.1. Блок A (фон під час переїзду скляного шару) прибрано разом
// зі склом у 1.33; проба тепер сторожить лише маскування кошторису в режимі
// скріншоту (B) і випадайку стану проєкту (C). Літери блоків лишено, щоб
// посилання в історії РОЗРОБКА.md не розійшлись.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const b=await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p=await b.newPage({viewport:{width:1400,height:950}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
// Майстер першого запуску займає те саме модальне вікно, що й uiAsk: без
// цього прапорця випадайка стану не відкриється, а проба впаде на chips[0].
await p.addInitScript(() => { localStorage.setItem('wizDone','true'); });
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2200);

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
// Блоки B і C лише друкують: помилка сторінки чи консолі — єдине, що тут
// валить пробу (без цього рядка вона проходила б і з винятком у renderProjects).
assert.equal(errs.length, 0, 'помилки сторінки/консолі: ' + errs.slice(0, 4).join(' | '));
