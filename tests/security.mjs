import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({executablePath:process.env.CHROMIUM || undefined});
const results=[];
try {
  for (const mode of ['browser','desktop']) {
    // Обходимо CSP лише тут, щоб довести екранування незалежно від другого захисного шару.
    const ctx = await browser.newContext({bypassCSP:true});
    await ctx.route(/^https?:/,r=>r.abort());
    const page=await ctx.newPage();
    await page.goto(pathToFileURL(path.join(root,mode==='browser'?'app/Groshi_app.html':'desktop/dist/index.html')).href);
    await page.waitForFunction(()=>typeof window.invSet==='function');
    if(mode==='browser')await page.addScriptTag({path:path.join(root,'desktop/dist/invnorm.js')});
    const normalized = await page.evaluate(()=>{
      window.__securityMarker=0;
      const xml=currency=>`<FlexQueryResponse><FlexStatements><FlexStatement currency="USD"><OpenPositions><OpenPosition symbol="TEST" description="Штучна позиція" assetCategory="STK" position="2" markPrice="10" costBasisPrice="5" currency="${currency}"/></OpenPositions></FlexStatement></FlexStatements></FlexQueryResponse>`;
      const good=window.invNormalize({ibkrXml:xml('USD')});
      const bad=window.invNormalize({ibkrXml:xml('&lt;img src=x onerror=window.__securityMarker=42&gt;')});
      window.invSet(bad);go('inv');
      return {validQty:good.pos[0]?.qty, validValue:good.pos[0]?.value, unsafeAccepted:bad.pos.some(p=>/[<>]/.test(p.ccy))};
    });
    await page.waitForTimeout(150);
    assert.equal(normalized.validQty,2);
    assert.equal(normalized.validValue,20);
    assert.equal(await page.evaluate(()=>window.__securityMarker),0,`${mode}: XML виконав код`);
    assert.equal(normalized.unsafeAccepted,false,`${mode}: небезпечну валюту прийнято`);
    await page.evaluate(()=>{
      // Старий кеш має лишатися безпечним навіть без повторного нормалізування XML.
      window.invSet({pos:[{src:'ibkr',symbol:'TEST',kind:'stock',name:'Тест',qty:1,price:10,value:10,ccy:'<img src=x onerror=window.__securityMarker=43>'}],ivt:[],navh:[],warn:[]});
      go('inv');
    });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(()=>window.__securityMarker),0,`${mode}: кеш виконав код`);
    const invoice=await page.evaluate(()=>invoiceHtml({rows:[]},{lang:'en',biz:{name:'Тест'},no:'TEST',date:'<img src=x onerror="window.invoiceMarker=1">',ccy:'<img src=x onerror="window.invoiceMarker=1">'}));
    const exported=await ctx.newPage();
    await exported.setContent(invoice);
    await exported.waitForTimeout(100);
    assert.equal(await exported.evaluate(()=>window.invoiceMarker||0),0,`${mode}: експорт інвойсу виконав код`);
    assert.equal(await exported.locator('img[onerror]').count(),0,'поля експортованого документа мають бути текстом');
    assert.ok(invoice.includes('Content-Security-Policy'),'експорт має власну CSP');
    await exported.close();
    const csv=await page.evaluate(()=>{
      let result=''; download=(name,text)=>{result=text;};
      TX.push({date:periodRange()[0],merchant:'=1+1',category:'Тест',subcategory:'Тест',dir:'out',amount:12,mcc:0});
      document.getElementById('expCsv').click();
      return result;
    });
    assert.ok(csv.includes('"\'=1+1"'),`${mode}: CSV не має виконувати текст як формулу`);
    results.push(`${mode}: XML та кеш безпечні, звичайний звіт зберіг суми`);
    await ctx.close();
  }
  for (const mode of ['browser','desktop']) {
    const ctx=await browser.newContext();
    const requests=[];await ctx.route(/^https?:/,r=>{requests.push(r.request().url());return r.abort();});
    const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(pathToFileURL(path.join(root,mode==='browser'?'app/Groshi_app.html':'desktop/dist/index.html')).href);
    await page.waitForFunction(()=>typeof window.go==='function');
    for(const t of ['overview','cats','tx','budget','inv','subs','settings'])await page.evaluate(t=>go(t),t);
    await page.evaluate(()=>{
      window.__securityMarker=0;
      document.body.insertAdjacentHTML('beforeend','<img src=x onerror=window.__securityMarker=44>');
      fetch('https://example.invalid/privacy-probe').catch(()=>{});
    });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(()=>window.__securityMarker),0,`${mode}: CSP дозволяє inline-обробники`);
    assert.deepEqual(requests,[],`${mode}: CSP пропустила зовнішній запит`);
    assert.deepEqual(errors,[]);
    results.push(`${mode}: CSP блокує код і мережу, 7 вкладок працюють`);
    await ctx.close();
  }
  const privacyContext=await browser.newContext();
  await privacyContext.addInitScript(()=>{
    // Playwright запускає цей callback також у вкладеному iframe та при
    // reload. Підготовка тесту має записати лише початковий стан головної
    // сторінки й більше не втручатися у перевірку збереження дозволів.
    if(window!==window.top)return;
    const state=JSON.parse(localStorage.getItem('deskState')||'{}');
    if(state.wizDone!==true)localStorage.setItem('deskState',JSON.stringify({...state,wizDone:true}));
  });
  const privacyPage=await privacyContext.newPage();
  await privacyPage.clock.install();
  await privacyPage.goto(pathToFileURL(path.join(root,'desktop/dist/index.html')).href);
  await privacyPage.waitForFunction(()=>typeof window.go==='function');
  // Перевіряємо також повільний запуск: таймер знайомства вже мав спрацювати.
  await privacyPage.clock.runFor(1600);
  assert.equal(await privacyPage.locator('#modal.on').count(),0,'підготовлений сценарій приватності не має відкривати майстер знайомства');
  await privacyPage.evaluate(()=>go2set('src'));
  assert.equal(await privacyPage.locator('[data-privacy]').count(),5,'мають бути 5 явних дозволів');
  assert.equal(await privacyPage.locator('[data-privacy][aria-pressed="true"]').count(),0,'типово необов’язкові запити вимкнені');
  const button=privacyPage.locator('[data-privacy="quotes"]');
  const before=await button.boundingBox();
  await button.click();
  assert.equal(await button.getAttribute('aria-pressed'),'true');
  const after=await button.boundingBox();
  assert.deepEqual(after,before,'перемикач приватності не змінює розмір або положення');
  fs.mkdirSync(path.join(root,'.test-artifacts'),{recursive:true});
  await privacyPage.locator('#privacyCard').screenshot({path:path.join(root,'.test-artifacts/privacy.png')});
  assert.equal(await privacyPage.evaluate(()=>JSON.parse(localStorage.getItem('deskState')).privacyServices?.quotes),true,
    'дозвіл записано у сховище перед перезавантаженням');
  await privacyPage.reload();
  await privacyPage.waitForFunction(()=>typeof window.go==='function');
  assert.equal(await privacyPage.evaluate(()=>JSON.parse(localStorage.getItem('deskState')).privacyServices?.quotes),true,
    'перезавантаження зберегло запис у сховищі');
  assert.equal(await privacyPage.evaluate(()=>window.__BOOT__.state.privacyServices?.quotes),true,
    'десктопний міст завантажив збережений дозвіл');
  assert.equal(await privacyPage.locator('[data-privacy="quotes"]').getAttribute('aria-pressed'),'true','дозвіл збережено');
  await privacyPage.evaluate(()=>{
    window.__DESK__.tauri=true;
    window.__privacyWrites=[];
    // Відповідь контролює тест: швидкість CI й годинник сторінки не мають
    // визначати, чи встиг запис завершитися до перевірки результату.
    const saved=new Promise(resolve=>{window.__releasePrivacySave=resolve;});
    window.__DESK__.stateSet=async(k,v)=>{if(k==='privacyServices'){window.__privacyWrites.push(v);await saved;}};
    const news=document.querySelector('[data-privacy="news"]');
    const onClick=news.onclick;
    news.onclick=function(event){
      window.__privacyClickDone=onClick.call(this,event);
      return window.__privacyClickDone;
    };
    news.click();
    document.querySelector('[data-privacy="logos"]').click();
  });
  // Навіть після довгого очікування дозвіл не змінюється без підтвердження.
  await privacyPage.clock.runFor(1000);
  assert.equal(await privacyPage.locator('[data-privacy]:disabled').count(),5,'на час запису заблоковано всі перемикачі');
  assert.equal(await privacyPage.locator('[data-privacy="news"]').getAttribute('aria-pressed'),'false','дозвіл не ввімкнено до підтвердження запису');
  assert.deepEqual(await privacyPage.evaluate(()=>window.__privacyWrites),[{quotes:true,news:true}],'другий клік не починає конкуруючий запис');
  await privacyPage.evaluate(async()=>{
    window.__releasePrivacySave();
    await window.__privacyClickDone;
  });
  assert.equal(await privacyPage.locator('[data-privacy="quotes"]').getAttribute('aria-pressed'),'true');
  assert.equal(await privacyPage.locator('[data-privacy="news"]').getAttribute('aria-pressed'),'true','паралельний клік не скасовує попередній дозвіл');
  assert.equal(await privacyPage.locator('[data-privacy="logos"]').getAttribute('aria-pressed'),'false','заблокований клік не змінює інший дозвіл');
  assert.equal(await privacyPage.locator('[data-privacy]:disabled').count(),0,'після запису перемикачі знову доступні');
  results.push('desktop: дозволи зберігаються, конкуруючий клік заблоковано до завершення запису');
  await privacyContext.close();
  console.log(results.join('\n'));
} finally {await browser.close();}
