import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist=path.join(root,'desktop/dist');
const config=JSON.parse(fs.readFileSync(path.join(root,'desktop/src-tauri/tauri.conf.json'),'utf8'));
const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');
const origin='http://127.0.0.1:31459';
const nonce='1234567890123456789';
// Tauri додає nonce до <style> та style-src. Саме цей другий шар
// був відсутній у браузерних пробах і ламав style="..." у готовій апці.
const fixture=process.env.GROSHI_CSP_FIXTURE
  ?JSON.parse(fs.readFileSync(process.env.GROSHI_CSP_FIXTURE,'utf8')):null;
if(fixture)assert.equal(fixture.version,config.version,'Нативний артефакт має відповідати поточній версії');
const nativeHtml=fixture?.html||html.replace(/<style(?=[\s>])/g,`<style nonce="${nonce}"`);
const nativeCsp=fixture?.csp||config.app.security.csp.replace(/style-src\s+([^;]+)/,(_,sources)=>`style-src ${sources} 'nonce-${nonce}'`);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM||undefined});
const snapshots=[];
try{
  for(const native of [false,true]){
    const context=await browser.newContext({viewport:{width:1360,height:900}});
    await context.addInitScript(()=>{
      localStorage.setItem('deskState',JSON.stringify({wizDone:true}));
      // Відображаємо саме десктопні налаштування. IPC відповідає лише
      // штучними даними у пам'яті: файли й облікові дані ОС недоступні.
      const state={wizDone:true};
      window.__unexpectedCommands=[];
      window.__TAURI__={core:{invoke:async(command,args)=>{
        if(command==='state_all')return {...state};
        if(command==='state_set'){state[args.key]=args.value;return;}
        if(command==='state_del'){delete state[args.key];return;}
        if(command==='raw_all')return {accounts:[],items:{},fetched:{},synced:0};
        if(['legacy_all','cryhist_all','nw_all','accounts_list'].includes(command))return [];
        if(['inv_raw','inv_cache','quotes_cached','fx'].includes(command))return null;
        if(command==='logos_cached')return {};
        // На повільному CI встигає спрацювати штатний таймер автобекапу.
        // Відповідь так само штучна, жодних файлів тест не створює.
        if(command==='backup_run')return {files:0,path:'synthetic-backup'};
        if(['token_has','ibkr_has','binance_has','plugin:autostart|is_enabled'].includes(command))return false;
        if(['data_dir','data_default'].includes(command))return 'synthetic-data';
        if(command==='app_version')return 'test';
        if(command==='update_source')return '';
        window.__unexpectedCommands.push(command);throw Error('Неочікувана команда тесту: '+command);
      }},event:{listen:async()=>()=>{}}};
      window.__styleViolations=[];
      document.addEventListener('securitypolicyviolation',e=>{
        if(e.effectiveDirective.startsWith('style-src'))window.__styleViolations.push(e.effectiveDirective);
      });
    });
    const external=[];
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin){external.push(url.origin);return route.abort();}
      const name=path.basename(url.pathname);
      if(name==='index.html')return route.fulfill({status:200,contentType:'text/html',body:native?nativeHtml:html,
        headers:native?{'Content-Security-Policy':nativeCsp}:{}});
      if(!['app.js','desktop.js','mononorm.js','invnorm.js'].includes(name))return route.abort();
      const compiled=native&&fixture?fixture.assets[name]:null;
      if(native&&fixture)assert.ok(compiled,`Нативний артефакт має містити ${name}`);
      return route.fulfill({status:200,contentType:compiled?.mimeType||'application/javascript',
        body:compiled?.body||fs.readFileSync(path.join(dist,name))});
    });
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/index.html');
    await page.waitForFunction(()=>typeof window.go==='function');
    assert.equal(await page.evaluate(()=>window.__DESK__.tauri),true,'Перевіряється десктопний режим');
    await page.evaluate(()=>document.fonts.ready);
    const geometry=[];
    for(const tab of ['overview','cats','tx','budget','inv','subs','settings']){
      await page.evaluate(tab=>go(tab),tab);
      // Порівнюємо завершений стан: проміжні кадри переходу між вкладками
      // залежать від швидкості раннера, а не від дозволів CSP.
      await page.evaluate(async()=>{
        await document.fonts.ready;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        for(const animation of document.getAnimations()){
          if(animation.effect.getTiming().iterations!==Infinity)animation.finish();
        }
      });
      geometry.push(await page.evaluate(()=>Array.from(document.querySelectorAll('[style]')).filter(n=>n.getClientRects().length).map(n=>{
        const s=getComputedStyle(n),r=n.getBoundingClientRect();
        return {tag:n.tagName,id:n.id,display:s.display,gap:s.gap,margin:s.margin,padding:s.padding,width:r.width,height:r.height};
      })));
    }
    await page.evaluate(()=>go2set('src'));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>window.__styleViolations.length),0,
      'Політика готової Tauri-збірки не повинна блокувати наявні стилі');
    await page.evaluate(()=>{
      window.__cspMarker=0;
      document.body.insertAdjacentHTML('beforeend','<img src=x onerror="window.__cspMarker=1">');
      fetch('https://example.invalid/security-probe').catch(()=>{});
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>window.__cspMarker),0,'Дозвіл стилів не дозволяє HTML-обробники');
    assert.deepEqual(external,[],'Дозвіл стилів не відкриває зовнішню мережу');
    assert.deepEqual(errors,[]);
    assert.deepEqual(await page.evaluate(()=>window.__unexpectedCommands),[],'Усі IPC-відповіді є явними тестовими даними');
    fs.mkdirSync(path.join(root,'.test-artifacts'),{recursive:true});
    await page.screenshot({path:path.join(root,'.test-artifacts',native?'native-csp.png':'html-csp.png')});
    snapshots.push(geometry);await context.close();
  }
  assert.deepEqual(snapshots[1],snapshots[0],'Нативний CSP зберігає геометрію всіх семи вкладок');
  console.log(`desktop CSP (${fixture?'вбудовані ресурси Tauri':'модель nonce'}): стилі та геометрія 7 вкладок збережені; сторонній код і мережа заблоковані`);
}finally{await browser.close();}
