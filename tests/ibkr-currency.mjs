import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist=path.join(root,'desktop/dist');
const origin='http://127.0.0.1:31460';
// Усі дані штучні. Підсумок повторює доларовий залишок: урахування
// обох рядків помилково перетворило б 25 доларів готівки на 50.
const xml=`<FlexQueryResponse><FlexStatements><FlexStatement accountId="TEST" currency="USD" toDate="20260913">
  <OpenPositions><OpenPosition symbol="TEST" description="Synthetic stock" assetCategory="STK" position="2" markPrice="100" costBasisPrice="90" currency="USD"/></OpenPositions>
  <Trades><Trade transactionID="TEST-1" symbol="TEST" tradeDate="20260912" buySell="BUY" quantity="2" tradePrice="90" currency="USD"/></Trades>
  <CashTransactions/>
  <EquitySummaryInBase reportDate="20260913" total="225"/>
  <CashReport><CashReportCurrency currency="BASE_SUMMARY" endingCash="25"/><CashReportCurrency currency="USD" endingCash="25"/></CashReport>
</FlexStatement></FlexStatements></FlexQueryResponse>`;
const currencyWarning='IBKR: некоректний код валюти — звіт пропущено.';
const escapeAttribute=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const positionCurrency=value=>xml.replace('costBasisPrice="90" currency="USD"',`costBasisPrice="90" currency="${escapeAttribute(value)}"`);

const browser=await chromium.launch({executablePath:process.env.CHROMIUM||undefined});
try{
  const context=await browser.newContext();
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage();
  await page.addScriptTag({path:path.join(dist,'invnorm.js')});
  const normalize=input=>page.evaluate(ibkrXml=>window.invNormalize({ibkrXml}),input);

  await test('Підсумок IBKR зберігає позиції, угоди та історію вартості без подвоєння грошей',async()=>{
    const data=await normalize(xml);
    assert.deepEqual(data.warn,[]);
    assert.deepEqual(data.pos.map(p=>({symbol:p.symbol,kind:p.kind,qty:p.qty,value:p.value,ccy:p.ccy})),[
      {symbol:'TEST',kind:'stock',qty:2,value:200,ccy:'USD'},
      {symbol:'USD',kind:'cash',qty:1,value:25,ccy:'USD'}
    ]);
    assert.deepEqual(data.ivt.map(t=>({symbol:t.symbol,type:t.type,date:t.date,qty:t.qty,amount:t.amount,ccy:t.ccy})),[
      {symbol:'TEST',type:'buy',date:'2026-09-12',qty:2,amount:180,ccy:'USD'}
    ]);
    assert.deepEqual(data.navh,[{date:'2026-09-13',value:225,ccy:'USD'}]);
    assert.equal(data.pos.reduce((sum,p)=>sum+p.value,0),225);
  });

  await test('Звичайні коди валют зберігають попередні допустимі межі',async()=>{
    for(const currency of ['USD','EUR','USDT','A12','ABCDEFGHIJ']){
      const data=await normalize(positionCurrency(currency));
      assert.deepEqual(data.warn,[],currency);
      assert.equal(data.pos[0].ccy,currency);
    }
  });

  await test('Некоректні валюти відхиляють увесь звіт до накопичення записів',async()=>{
    for(const currency of ['<img src=x>','USD" onmouseover="x','USD&EUR','usd','ABCDEFGHIJK','USD_TEST','US','BASE_SUMMARY']){
      const data=await normalize(positionCurrency(currency));
      assert.deepEqual(data,{pos:[],ivt:[],navh:[],warn:[currencyWarning]},currency);
    }
    for(const currency of ['BASE_OTHER','BASE_SUMMARY_EXTRA','base_summary']){
      const data=await normalize(xml.replace('currency="BASE_SUMMARY"',`currency="${currency}"`));
      assert.deepEqual(data,{pos:[],ivt:[],navh:[],warn:[currencyWarning]},currency);
    }
  });
  await context.close();

  await test('Запуск десктопа відновлює порожній старий кеш зі збереженого XML без зміни сирих даних',async()=>{
    const startup=await browser.newContext();
    try{
      const external=[];
      await startup.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.origin!==origin){external.push(url.href);return route.abort();}
        if(url.pathname==='/index.html')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'});
        // Справжні міст десктопа й нормалізатор перевіряють відновлення кешу.
        // Інтерфейс підмінено, щоб його таймери не зверталися до нативних API.
        if(url.pathname==='/app.js')return route.fulfill({contentType:'application/javascript',body:'window.__testAppLoaded=true;'});
        return route.abort();
      });
      const bootPage=await startup.newPage();
      const errors=[];
      bootPage.on('pageerror',error=>errors.push(error.message));
      await bootPage.goto(origin+'/index.html');
      await bootPage.evaluate(xml=>{
        const raw={ibkr:{xml,extra:[],fetched:123},binance:null};
        const oldCache={sig:JSON.stringify([123,0,0,2]),data:{pos:[],ivt:[],navh:[],warn:['synthetic old failure']}};
        window.__testRaw=raw;
        window.__testRawBefore=JSON.stringify(raw);
        window.__testCacheWrites=[];
        window.__testUnexpectedCommands=[];
        window.monoNormalize=()=>[];
        window.__TAURI__={core:{invoke:async(command,args)=>{
          if(command==='state_all')return {};
          if(command==='raw_all')return {accounts:[],items:{},fetched:{},synced:0};
          if(command==='legacy_all'||command==='quotes_cached')return null;
          if(command==='cryhist_all')return [];
          if(command==='logos_cached')return {};
          if(['token_has','ibkr_has','binance_has'].includes(command))return false;
          if(command==='data_dir')return 'synthetic-data';
          if(command==='inv_raw')return raw;
          if(command==='inv_cache')return oldCache;
          if(command==='inv_cache_set'){window.__testCacheWrites.push(args.value);return;}
          window.__testUnexpectedCommands.push(command);
          throw Error('Неочікувана нативна команда: '+command);
        }}};
      },xml);
      await bootPage.addScriptTag({path:path.join(dist,'invnorm.js')});
      await bootPage.addScriptTag({path:path.join(dist,'desktop.js')});
      await bootPage.waitForFunction(()=>window.__BOOT__&&window.__testAppLoaded);
      const result=await bootPage.evaluate(()=>({
        inv:window.__BOOT__.inv,writes:window.__testCacheWrites,
        rawBefore:window.__testRawBefore,rawAfter:JSON.stringify(window.__testRaw),
        unexpected:window.__testUnexpectedCommands
      }));
      assert.deepEqual(result.inv.warn,[],'Стара кешована відмова не повинна приховувати збережений звіт');
      assert.deepEqual(result.inv.pos.map(p=>({symbol:p.symbol,value:p.value})),[
        {symbol:'TEST',value:200},{symbol:'USD',value:25}
      ]);
      assert.equal(result.inv.ivt.length,1);
      assert.deepEqual(result.inv.navh,[{date:'2026-09-13',value:225,ccy:'USD'}]);
      assert.equal(result.writes.length,1,'Відновлені результати мають замінити застарілий кеш');
      assert.notEqual(result.writes[0].sig,JSON.stringify([123,0,0,2]));
      assert.deepEqual(result.writes[0].data,result.inv);
      assert.equal(result.rawAfter,result.rawBefore,'Відновлення має зберегти сирий XML');

      // Оновлення після синхронізації також пише кеш: його підпис має
      // збігатися зі стартовим, інакше наступний запуск знову парситиме XML.
      // Виконуємо справжню функцію зі згенерованого застосунку без решти UI.
      const appSource=fs.readFileSync(path.join(dist,'app.js'),'utf8');
      const reloadSource=appSource.match(/async function invReload\(\)\{[\s\S]*?(?=function brokerStates\()/)?.[0];
      assert.ok(reloadSource,'У згенерованому застосунку має бути функція оновлення інвестицій');
      await bootPage.evaluate(()=>{
        window.D=window.__DESK__;
        window.invSet=data=>{window.__testReloaded=data;};
      });
      await bootPage.addScriptTag({content:reloadSource});
      await bootPage.evaluate(()=>invReload());
      const reload=await bootPage.evaluate(()=>({
        writes:window.__testCacheWrites,data:window.__testReloaded,
        raw:JSON.stringify(window.__testRaw),unexpected:window.__testUnexpectedCommands
      }));
      assert.equal(reload.writes.length,2,'Оновлення інвестицій має записати свіжий кеш');
      assert.equal(reload.writes[1].sig,result.writes[0].sig,'Запуск та оновлення повинні використовувати сумісний кеш');
      assert.deepEqual(reload.writes[1].data,result.inv);
      assert.deepEqual(reload.data,result.inv,'Оновлені дані мають потрапити до інтерфейсу');
      assert.equal(reload.raw,result.rawBefore,'Оновлення має зберегти сирий XML');
      assert.deepEqual(reload.unexpected,[]);
      assert.deepEqual(result.unexpected,[]);
      assert.deepEqual(external,[]);
      assert.deepEqual(errors,[]);
    }finally{await startup.close();}
  });
}finally{await browser.close();}
