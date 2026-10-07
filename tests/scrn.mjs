import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const b=await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p=await b.newPage({viewport:{width:1400,height:1000}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto(`file://${process.cwd()}/app/Groshi_app.html`); await p.waitForTimeout(2200);

const digits = async ()=> p.evaluate(()=>{
  const t=document.querySelector('section:not([hidden])').textContent;
  return { цифр:(t.match(/\d/g)||[]).length, крапок:(t.match(/•/g)||[]).length,
    відсотків:(t.match(/\d+[.,]?\d*%/g)||[]).length,
    // суми з валютою: «7 028 ₴», «$41.5», «12 €»; саме їх режим має ховати
    сум:(t.match(/\d[\d\s.,\u00a0\u202f]*\s*[₴$€]/g)||[]).length };
});
let maskedSum=0;
for(const tab of ['overview','cats','tx','inv','subs','budget']){
  await p.evaluate(t=>{ if(SCRN) scrnToggle(false); go(t); }, tab);
  await p.waitForTimeout(400);
  const before=await digits();
  await p.evaluate(()=>scrnToggle(true));
  await p.waitForTimeout(400);
  const after=await digits();
  console.log(tab.padEnd(9), 'до:', JSON.stringify(before), ' після:', JSON.stringify(after));
  // Сторож: після вмикання режиму на вкладці не лишається жодної суми з валютою; крапок-масок не меншає.
  assert.equal(after.сум, 0, `вкладка «${tab}»: у режимі скріншоту видно ${after.сум} сум(и)`);
  assert.ok(after.крапок >= before.крапок, `вкладка «${tab}»: крапок-масок стало менше (${before.крапок} → ${after.крапок})`);
  maskedSum += before.сум;
}
// Сторож від порожньої проби: хоч на одній вкладці до вмикання сум було видно (інакше нічого не довели).
assert.ok(maskedSum > 0, 'жодної суми до вмикання режиму: проба нічого не перевіряє');
const badge = await p.evaluate(()=>({
  бейдж: !el('scrnBadge').hidden, текст: el('scrnBadge').textContent.trim(),
  кнопка: el('scrnBtn').textContent, клас: document.body.classList.contains('scrn') }));
console.log('\nбейдж і кнопка:', badge);
assert.ok(badge.бейдж, 'бейдж режиму скріншоту не показано');
assert.ok(badge.текст.length > 0, 'бейдж режиму скріншоту порожній');
assert.ok(badge.клас, 'на body немає класу scrn');
const off = await p.evaluate(async ()=>{
  document.body.focus();
  scrnToggle(false); await new Promise(r=>setTimeout(r,300));
  const t=document.querySelector('section:not([hidden])').textContent;
  return { крапок:(t.match(/•/g)||[]).length, бейдж_схований: el('scrnBadge').hidden };
});
console.log('вимкнення клавішею:', off);
assert.equal(off.крапок, 0, `після вимкнення лишилось ${off.крапок} крапок-масок`);
assert.ok(off.бейдж_схований, 'після вимкнення бейдж не сховано');
await p.evaluate(()=>{ scrnToggle(true); go('overview'); });
await p.waitForTimeout(700);
await p.screenshot({path:'.test-artifacts/scrn.png'});
console.log(errs.length?'ПОМИЛКИ: '+errs.slice(0,4).join(' | '):'без помилок');
assert.equal(errs.length, 0, `помилки консолі/сторінки: ${errs.slice(0,3).join(' | ')}`);
await b.close();
