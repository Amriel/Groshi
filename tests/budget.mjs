// «Кошториси» після переходу на словник: список, картка проєкту, рахунки клієнтам.
// Сторожить:
//  · інлайн-стилі в #tab-budget — лише flex у сегментів смуги типів (це дані:
//    частка суми), усе інше — класи;
//  · стан проєкту — .tag.pjst із крапкою .dot: колір лише в крапці, текст
//    нейтральний, три стани мають три різні крапки;
//  · на 1400 px таблиця кошторису вміщується в картку без гортання, а на
//    390 px сторінка не отримує горизонтального скролу ні у списку, ні в картці;
//  · ширини колонок таблиці не залежать від числа (table-layout:fixed):
//    ставка 300 → 300000 не зсуває жодної колонки;
//  · фокус клітинки — рамка без 3-пікселевого кільця;
//  · режим скріншоту: у списку немає видимих сум, поля ставки й підсумки розмиті;
//  · КЛІЄНТСЬКІ ДОКУМЕНТИ НЕ ЗМІНЮЮТЬСЯ: рахунок invoiceHtml (мови × акт ×
//    податок × підпис) і файл «Поділитись» дають ті самі байти — звірка за
//    SHA-256. Це не інтерфейс апки, його вигляд бачить клієнт. Якщо шаблон
//    документа змінюють НАВМИСНО — оновити хеші нижче в тому ж коміті.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// Хеші зняті з ДОКУМЕНТІВ ДО Задачі 11 (збірка з коміту перед нею), не з поточного коду.
const HASH = {
  'ua-act-tax':        '9b8fac2c25ca94d994aea8ee8d95d3a395554842a885e42a6059b293866853bb',
  'en-inv-net':        '56a6b1c5fa378499f47384ba6cbdf42cc1830c54b812df23ed819bf9363a110d',
  'both-act-tax':      '62da4ef15f4c01cbf25b926eba852b88fc2e68c7ce8664c46042eb491a9c0ee0',
  'both-act-tax-sign': 'c1cf9bcb1f68ec78bc6a11448900f179e328b570f84d2c0b1b5bd5c2bb68983e',
  'share':             '9884e606f59c71a73f4986b0b003652d046964014698534e85e3bca96c63464b',
};
// 1×1 прозорий PNG — підпис для варіанта рахунку з підписом (штучний).
const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
try {
  for (const mode of ['browser', 'desktop']) {
    const context = await browser.newContext({viewport: {width: 1400, height: 1000}});
    await context.addInitScript(() => {
      localStorage.setItem('wizDone', 'true');
      localStorage.setItem('deskState', JSON.stringify({wizDone: true}));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.route(/^https?:/, r => r.abort());
    await page.goto(pathToFileURL(path.join(root,
      mode === 'browser' ? 'app/Groshi_app.html' : 'desktop/dist/index.html')).href);
    await page.waitForFunction(() => typeof window.pjOpen === 'function' && typeof window.invoiceHtml === 'function');
    const seed = view => page.evaluate(view => {
      PROJ = [
        {id:'p1', client:'Клієнт А', name:'Лендінг', status:'active', rate:300, tax:6, usd:41.5, rows:[
          {id:'r1', task:'Дизайн', type:'Art', rate:300, days:8, ot:1, ind:0, note:'три варіанти'},
          {id:'r2', task:'Розробка', type:'Development', rate:300, days:14, ot:0, ind:0, note:''},
          {id:'r3', task:'Витрати', type:'AI Fee', rate:0, days:0, ot:0, ind:30, note:'підписки й оренда'},
          {id:'r4', task:'Тест-рендери', type:'Other', rate:12, days:10, ot:0, ind:0, unit:'u', note:'поштучно'}]},
        {id:'p2', client:'Клієнт А', name:'Застосунок', status:'done', rate:500, tax:6, usd:41.5, rows:[
          {id:'r5', task:'Інтерфейс', type:'Art', rate:500, days:30, ot:0, ind:0, note:''}]},
        {id:'p3', client:'Клієнт Б', name:'Брендбук', status:'paid', paidAt:'2026-09-30', rate:400, tax:0, usd:41.5, rows:[
          {id:'r6', task:'Логотип', type:'Art', rate:400, days:6, ot:0, ind:0, note:''}]}];
      PJ_FOLD = new Set(); PJ_CUR = 'p1'; PJ_VIEW = view; store.set('projView', view); pjSave();
      go('budget'); renderProjects();
    }, view);

    // ── список: стани, інлайн-стилі ──
    await seed('list');
    const list = await page.evaluate(() => {
      const tags = [...document.querySelectorAll('.tag.pjst')];
      const inline = [...document.querySelectorAll('#tab-budget [style]')].map(n => ({
        ok: n.matches('.pjitem .split > i, .pjbar > i'),
        props: n.getAttribute('style').split(';').filter(Boolean).map(x => x.split(':')[0].trim())}));
      return {
        tags: tags.length,
        dots: new Set(tags.map(t => getComputedStyle(t.querySelector('.dot')).backgroundColor)).size,
        textNeutral: tags.every(t => getComputedStyle(t).color === getComputedStyle(tags[0]).color),
        inline,
      };
    });
    assert.equal(list.tags, 3, `${mode}: по чипу стану на проєкт`);
    assert.equal(list.dots, 3, `${mode}: три стани — три різні крапки`);
    assert.ok(list.textNeutral, `${mode}: текст чипів стану однаковий (колір лише в крапці)`);
    assert.ok(list.inline.length > 0, `${mode}: сегменти смуги типів існують (проба не порожня)`);
    for (const i of list.inline) {
      assert.ok(i.ok && i.props.length === 1 && i.props[0] === 'flex',
        `${mode}: інлайн-стиль поза переліком динамічних: ${JSON.stringify(i)}`);
    }

    // ── 390 px: без горизонтального скролу у списку ──
    await page.setViewportSize({width: 390, height: 844});
    await page.waitForTimeout(250);
    const sw = () => page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(await sw() <= 391, `${mode}: список на 390 px: scrollWidth ${await sw()}`);

    // ── картка проєкту ──
    await seed('one');
    await page.waitForTimeout(250);
    assert.ok(await sw() <= 391, `${mode}: картка проєкту на 390 px: scrollWidth ${await sw()}`);
    await page.setViewportSize({width: 1400, height: 1000});
    await page.waitForTimeout(250);
    const fit = await page.evaluate(() => {
      const t = document.getElementById('pjTable');
      return {scroll: t.scrollWidth, client: t.clientWidth};
    });
    assert.ok(fit.scroll <= fit.client + 1, `${mode}: таблиця на 1400 px гортається (${fit.scroll} > ${fit.client})`);

    // ── колонки не залежать від числа; фокус без кільця ──
    const widths = () => page.evaluate(() => [...document.querySelectorAll('#pjTable thead th')]
      .map(t => Math.round(t.getBoundingClientRect().width)));
    const w0 = await widths();
    const rate = page.locator('tr[data-r="r1"] [data-f="rate"]');
    await rate.focus();
    await page.waitForTimeout(300);
    const ring = await rate.evaluate(n => getComputedStyle(n).boxShadow);
    assert.equal(ring, 'none', `${mode}: фокус клітинки має кільце: ${ring}`);
    await rate.fill('300000'); await rate.press('Tab');
    await page.waitForFunction(() => pjCur().rows[0].rate === 300000);
    assert.deepEqual(await widths(), w0, `${mode}: ширини колонок змінились від числа`);

    // ── режим скріншоту ──
    await seed('list');
    await page.evaluate(() => scrnToggle(true));
    await page.waitForTimeout(300);
    // І «123 $», і «$ 123»: знак валюти буває з обох боків числа (після
    // знака — лише пробіли того ж рядка, без переносу).
    const maskedList = await page.evaluate(() =>
      (document.getElementById('tab-budget').innerText.match(/\d[\d\s.,  ]*\s*[₴$€]|[$€][   ]*\d/g) || []).length);
    assert.equal(maskedList, 0, `${mode}: у списку в режимі скріншоту видно ${maskedList} сум`);
    await seed('one');
    await page.waitForTimeout(300);
    const blur = await page.evaluate(() => ['pjRate', 'pjTax', 'pjUsd'].map(id => getComputedStyle(document.getElementById(id)).filter)
      .concat([...document.querySelectorAll('#pjTable td.num.calc')].map(n => getComputedStyle(n).filter)));
    assert.ok(blur.length > 3 && blur.every(f => f.includes('blur')), `${mode}: не все розмито: ${JSON.stringify(blur)}`);
    await page.evaluate(() => scrnToggle(false));

    // ── клієнтські документи: ті самі байти ──
    const docs = await page.evaluate(PNG1 => {
      const out = {};
      const p = PROJ[0];
      BIZPROF = [{label:'Основний', name:'PE TEST PERSON', tax:'0000000000', addr:'Ukraine', bank:'Test Bank',
                  iban:'UA000000000000000000000000000', swift:'TESTUA2X'}];
      const base = {no:'INV-2026-777', date:'2026-10-05', cname:'TEST CLIENT LIMITED', creg:'HE100200',
                    caddr:'Nicosia, Cyprus', agr:'MSA-1', agrd:'2026-06-26', ccy:'USD', biz:BIZPROF[0]};
      out['ua-act-tax'] = invoiceHtml(p, {...base, lang:'ua', act:true, k:1.06});
      out['en-inv-net'] = invoiceHtml(p, {...base, lang:'en', act:false, k:1});
      out['both-act-tax'] = invoiceHtml(p, {...base, lang:'both', act:true, k:1.06});
      BIZSIGN = PNG1;
      out['both-act-tax-sign'] = invoiceHtml(p, {...base, lang:'both', act:true, k:1.06});
      BIZSIGN = null;
      let shared = null; const orig = window.download;
      window.download = (n, t) => { shared = t; };
      pjShare(p);
      window.download = orig;
      out['share'] = shared.split(new Date().toISOString().slice(0, 10)).join('YYYY-MM-DD');
      return out;
    }, PNG1);
    for (const [k, v] of Object.entries(docs)) {
      assert.ok(v.length > 1000, `${mode}: документ ${k} порожній`);
      assert.equal(sha(v), HASH[k], `${mode}: клієнтський документ «${k}» змінився (SHA-256)`);
    }
    assert.deepEqual(errors, [], `${mode}: помилки сторінки`);
    console.log(`${mode}: стани й крапки, інлайн лише flex, 390/1400 без гортання, колонки стабільні, режим скріншоту, документи клієнту — ті самі байти`);
    await context.close();
  }
} finally {
  await browser.close();
}
