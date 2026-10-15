// «Інвестиції» в десктопній збірці зі штучними даними (tests/helpers/desktop-boot.mjs).
// Браузерна збірка показує на цій вкладці лише заглушку, тож без цієї
// проби справжній екран (групи, рядки позицій, сегменти, податки) не
// перевіряла жодна проба. Сторожить:
//  · вкладка видима, у групах є рядки позицій .invrow, 0 помилок сторінки
//    і жодної неочікуваної IPC-команди;
//  · 390 px: без горизонтального скролу сторінки (до Задачі 10 рядок із
//    чотирма колонками виштовхував суму за картку й сторінку до 430 px);
//  · інлайн-стилі в #tab-inv — лише динамічні з переліку нижче;
//  · кольорових бічних смуг немає (той самий розбір, що в nostripe.mjs);
//  · сегменти перемикаються через aria-pressed, група згортається;
//  · режим скріншоту ховає суми й кількості (scrn.mjs бачить лише заглушку);
//  · «нічого не смикається»: перша група й шапка графіка стоять на місці
//    після зміни теми й режиму графіка.
// Падає, якщо будь-яка з цих умов порушена: наприклад, повернутий
// style="color:…" у рядку, рядок, ширший за 390 px, або виняток у renderInv.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {openDesktop} from './helpers/desktop-boot.mjs';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');

// Дозволені інлайн-стилі: селектор → властивості. Усе це дані (частка,
// висота стовпчика, положення курсора), а не оформлення.
const ALLOW = [
  ['.ivb .bar > i', ['width']],          // частка в розподілі й дивідендах
  ['.ivtgt', ['left']],                  // мітка цільової частки
  ['.dvrow .c > i', ['height']],         // висота стовпчика дивідендів
  ['.meter > i', ['width']],             // прогрес до цілі
  ['.invtrack > i', ['width']],          // реалізований результат за рік
  ['.qline', ['left', 'opacity']],       // курсор графіка — за мишею
  ['.qlab', ['left', 'opacity']],
];

const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const problems = [];
const wait = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
// Спільна перевірка поточного стану вкладки: видимість, рядки, інлайн-
// стилі з переліку, бічні смуги, горизонтальний скрол.
async function check(page, tag) {
  const r = await page.evaluate(allow => {
    const sec = document.getElementById('tab-inv');
    const rows = [...sec.querySelectorAll('.invgrp .invrow')].filter(n => n.offsetParent !== null).length;
    const badStyles = [...sec.querySelectorAll('[style]')].flatMap(n => {
      const hit = allow.find(([sel]) => n.matches(sel));
      const props = [...n.style].map(p => p.replace(/^(\w+)-.*/, '$1'));
      if (!hit) return [`${n.tagName}.${n.className} style="${n.getAttribute('style')}"`];
      const extra = props.filter(p => !hit[1].includes(p));
      return extra.length ? [`${hit[0]}: зайве ${extra.join(',')}`] : [];
    });
    const stripes = [];
    for (const n of sec.querySelectorAll('*')) {
      if (n.offsetParent === null) continue;
      const c = getComputedStyle(n);
      const lw = parseFloat(c.borderLeftWidth), rw = parseFloat(c.borderRightWidth);
      if (lw >= 2 && c.borderLeftStyle !== 'none' && c.borderLeftColor !== c.borderRightColor
        && c.borderLeftColor !== 'rgba(0, 0, 0, 0)' && rw < lw) stripes.push(String(n.className));
      const layers = c.boxShadow === 'none' ? [] : c.boxShadow.split(/,(?![^(]*\))/);
      if (layers.some(l => {
        if (!/\binset\b/.test(l)) return false;
        const px = (l.replace(/rgba?\([^)]*\)|color\([^)]*\)/g, '').match(/-?[\d.]+px/g) || []).map(parseFloat);
        return Math.abs(px[0] || 0) >= 1 && (px[1] || 0) === 0 && (px[2] || 0) === 0;
      })) stripes.push(String(n.className));
    }
    return {visible: !sec.hidden && sec.offsetParent !== null, rows, badStyles, stripes,
      hscroll: document.documentElement.scrollWidth > innerWidth};
  }, ALLOW);
  if (!r.visible) problems.push(`${tag}: вкладка не видима`);
  if (r.rows < 1) problems.push(`${tag}: у групах немає жодного рядка позиції`);
  for (const s of new Set(r.badStyles)) problems.push(`${tag}: інлайн-стиль поза переліком: ${s}`);
  for (const s of new Set(r.stripes)) problems.push(`${tag}: бічна смуга: ${s}`);
  if (r.hscroll) problems.push(`${tag}: горизонтальний скрол сторінки`);
}
try {
  for (const width of [1400, 390]) {
    const {ctx, page, errors} = await openDesktop(browser, {width, height: width < 760 ? 844 : 900});
    await page.evaluate(() => go('inv'));
    await page.waitForTimeout(500);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      await wait(page);
      await check(page, `${width}/${theme}`);
    }

    // Кожен стан кожного перемикача — інакше гілки рендера, які фікстура
    // за замовчуванням не малює (сектори, країни, валюти, «Активи»,
    // «Сьогодні», «Крипта»), могли б кинути виняток непоміченими.
    const STATES = [
      ['INVALLOC', 'sect'], ['INVALLOC', 'ctry'], ['INVALLOC', 'ccy'], ['INVALLOC', 'pos'],
      ['INVDIVV', 'a'], ['INVDIVV', 'm'], ['INVDIVP', 'all'], ['INVDIVP', '12'],
      ['INVPER', '1d'], ['INVPER', 'all'], ['INVSEG', 'cry'], ['INVSEG', 'sec'],
    ];
    for (const [k, v] of STATES) {
      await page.evaluate(([k, v]) => { globalThis.__invSet = new Function('v', `${k} = v; renderInv();`); __invSet(v); }, [k, v]);
      await page.waitForTimeout(150);
      await check(page, `${width}/${k}=${v}`);
    }
    // Гілки з даними зі стану фікстури: ціль, watchlist, мітка цілі, «Очікується».
    const seen = await page.evaluate(() => ({
      goal: !!document.querySelector('#invGoal .meter.lg') && !!document.querySelector('#invGoal .invhsvg'),
      watch: document.querySelectorAll('#invWatchList .invrow').length,
      del: document.querySelectorAll('#invWatchList .invdel').length,
      tgt: !!document.querySelector('#invAlloc .ivtgt'),
      next: document.querySelectorAll('#invDivNext .invmini').length,
    }));
    if (!seen.goal) problems.push(`${width}: ціль не намалювала прогрес і «Далекий обрій»`);
    if (seen.watch < 2 || seen.del < 2) problems.push(`${width}: watchlist: рядків ${seen.watch}, кнопок ✕ ${seen.del}, очікувалось 2`);
    if (!seen.tgt) problems.push(`${width}: немає мітки цільової частки в «Розподілі»`);
    if (seen.next < 1) problems.push(`${width}: немає рядка «Очікується» під дивідендами`);

    // Розгорнута позиція (графік ціни з мітками угод, журнал) теж без
    // смуг і переповнення — і з тими самими правилами інлайн-стилів.
    await page.evaluate(() => document.querySelector('#invPos .invrow[data-invsym="TSTA"]').click());
    await wait(page);
    const det = await page.evaluate(() => ({
      open: !!document.querySelector('#invPos .invdet .invqsvg'),
      hscroll: document.documentElement.scrollWidth > innerWidth,
    }));
    if (!det.open) problems.push(`${width}: картка позиції TSTA не розгорнулась із графіком ціни`);
    if (det.hscroll) problems.push(`${width}: розгорнута позиція дає горизонтальний скрол`);

    // Режим скріншоту: жодної суми з валютою й жодної кількості «10 ×».
    const scrn = await page.evaluate(async () => {
      scrnToggle(true);
      await new Promise(r => setTimeout(r, 200));
      // innerText — лише видимий текст: схована панель «Крипти» зберігає
      // розмітку попереднього показу, але на знімок екрана не потрапляє, а
      // при поверненні на неї render() малює її вже з масками.
      const t = document.getElementById('tab-inv').innerText;
      // Друга половина — «Крипта»: її суми малює окрема функція.
      INVSEG = 'cry'; renderInv();
      const t2 = t + '\n' + document.getElementById('tab-inv').innerText;
      INVSEG = 'sec'; renderInv();
      const out = {sums: t2.match(/\d[\d\s.,]*\s*[₴$€]/g) || [], qty: t2.match(/\d+(?:[.,]\d+)?\s*×/g) || []};
      scrnToggle(false);
      return out;
    });
    if (scrn.sums.length) problems.push(`${width}: у режимі скріншоту видно суми: ${scrn.sums.slice(0, 3).join(' | ')}`);
    if (scrn.qty.length) problems.push(`${width}: у режимі скріншоту видно кількості: ${scrn.qty.slice(0, 3).join(' | ')}`);
    await page.evaluate(() => { INVOPEN = null; renderInv(); });

    if (width === 1400) {
      // Сегменти: стан — aria-pressed, а не лаймовий .on.
      const seg = await page.evaluate(async () => {
        const q = s => document.querySelector(s);
        // Відсутній елемент — null (стара розмітка без груп-карток): проба має
        // назвати проблему, а не впасти з TypeError.
        const rect = n => { if (!n) return null; const r = n.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
        const click = s => { const n = q(s); if (n) n.click(); };
        const geo = () => ({grp: rect(q('#invPos .invgrp')), head: rect(q('#invPos .invgh')),
          nav: rect(q('#invNavCard .cardhead'))});
        const g0 = geo();
        document.documentElement.dataset.theme = 'dark';
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const gTheme = geo();
        click('#invModeSeg [data-imode="value"]');
        const gMode = geo();
        click('#invPerSeg [data-iper="30"]');
        const gPer = geo();
        const pressed = [...document.querySelectorAll('#invPerSeg .chip')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.iper);
        const lime = [...document.querySelectorAll('#tab-inv .periodbar .chip.on')].length;
        click('#invPerSeg [data-iper="all"]');
        click('#invModeSeg [data-imode="profit"]');
        click('#invPos .invgh');
        const g1 = q('#invPos .invgrp');
        const shut = !!g1 && g1.classList.contains('shut') && !g1.querySelector('.invrow');
        click('#invPos .invgh');
        click('#invSeg [data-iseg="cry"]');
        const cry = document.querySelectorAll('#invPosC .invgrp .invrow').length;
        click('#invSeg [data-iseg="sec"]');
        return {g0, gTheme, gMode, gPer, pressed, lime, shut, cry};
      });
      const near = (a, b) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= 1);
      for (const k of ['grp', 'head', 'nav']) {
        if (!near(seg.g0[k], seg.gTheme[k])) problems.push(`зміна теми зсунула ${k}: ${seg.g0[k]} → ${seg.gTheme[k]}`);
        if (!near(seg.g0[k], seg.gMode[k])) problems.push(`зміна режиму графіка зсунула ${k}: ${seg.g0[k]} → ${seg.gMode[k]}`);
      }
      if (!near(seg.g0.nav, seg.gPer.nav)) problems.push(`зміна періоду зсунула шапку графіка: ${seg.g0.nav} → ${seg.gPer.nav}`);
      if (seg.pressed.join() !== '30') problems.push(`сегмент періоду: натиснуто ${seg.pressed.join() || 'нічого'}, очікувалось 30`);
      if (seg.lime) problems.push(`сегменти екрана мають клас .on (${seg.lime}) — лаймовий стан основної дії`);
      if (!seg.shut) problems.push('група позицій не згорнулась');
      if (seg.cry < 1) problems.push('у розділі «Крипта» немає рядків монет');
      console.log('геометрія (left, top, w, h) до / тема / режим / період:',
        JSON.stringify({grp: [seg.g0.grp, seg.gTheme.grp, seg.gMode.grp, seg.gPer.grp],
          head: [seg.g0.head, seg.gTheme.head, seg.gMode.head, seg.gPer.head]}));
    }

    const unexpected = await page.evaluate(() => window.__unexpectedCommands);
    if (unexpected.length) problems.push(`${width}: неочікувані IPC-команди: ${unexpected.join(', ')}`);
    for (const e of errors) problems.push(`${width}: помилка сторінки: ${e}`);
    await ctx.close();
  }
  assert.deepEqual(problems, [], 'Інвестиції (десктоп):\n' + problems.join('\n'));
  console.log('Інвестиції (десктоп, 1400/390, дві теми): рядки, сегменти, інлайн-стилі, смуги, 390 px, режим скріншоту — OK');
} finally { await browser.close(); }
