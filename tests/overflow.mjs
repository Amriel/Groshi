// 390 px: горизонтального скролу сторінки немає, великі суми не виходять
// за картку, «Інвестиції» вміщується в слот нижньої панелі.
// Плюс три окремі випадки: (а) довгий «найближче» у плитці Підписок,
// (б) відступ рядка власного періоду, (в) тост і бейдж над нижньою панеллю.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.SNAP_FILE || path.join(root, '.test-artifacts', 'synthetic_app.html');
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
try {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}});
  await ctx.addInitScript(() => localStorage.setItem('wizDone', 'true'));
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => typeof window.go === 'function');
  const problems = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    for (const tab of ['overview', 'cats', 'tx', 'budget', 'inv', 'subs', 'advisor', 'settings']) {
      await page.evaluate(t => go(t), tab); await page.waitForTimeout(400);
      // Правий край суми (з урахуванням тексту, що вилазить із її власної
      // коробки при nowrap) порівнюється з правим краєм ВМІСТУ картки —
      // без падингу й рамки. Колишнє «scrollWidth суми > clientWidth картки»
      // не бачило суми, вужчої за картку, але зсунутої за її край.
      // Пропускаються суми всередині власного прокручуваного або обрізаного
      // контейнера (широка таблиця гортається вбік — це задумано) і ті, що
      // самі обрізають текст (overflow:hidden з «…»).
      const r = await page.evaluate(() => {
        const h = document.documentElement.scrollWidth > innerWidth;
        const clipped = [...document.querySelectorAll('section:not([hidden]) .card, section:not([hidden]) .det')]
          .filter(c => c.offsetParent !== null)
          .flatMap(c => {
            const cs = getComputedStyle(c), cr = c.getBoundingClientRect();
            const right = cr.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
            return [...c.querySelectorAll('.num-lg,.num-md,.kpi .val,.amt')]
              .filter(n => {
                if (n.offsetParent === null) return false;
                for (let a = n.parentElement; a && a !== c; a = a.parentElement)
                  if (getComputedStyle(a).overflowX !== 'visible') return false;
                const nr = n.getBoundingClientRect();
                const w = getComputedStyle(n).overflowX === 'visible' ? Math.max(nr.width, n.scrollWidth) : nr.width;
                return nr.left + w > right + 1;
              })
              .map(n => `${n.className} (${n.textContent.trim().slice(0, 24)})`);
          });
        return {h, clipped};
      });
      if (r.h) problems.push(`${theme}/${tab}: горизонтальний скрол сторінки`);
      for (const c of r.clipped) problems.push(`${theme}/${tab}: сума «${c}» ширша за картку`);
    }
  }
  // найгірший випадок: найбільша сума в великій цифрі
  await page.evaluate(() => go('overview'));
  const worst = await page.evaluate(() => {
    const n = document.querySelector('.kpi .val, .num-lg'); if (!n) return null;
    n.textContent = '9 999 999,99 ₴';
    const c = n.closest('.card, .kpi'); return {nw: n.scrollWidth, cw: c ? c.clientWidth : innerWidth};
  });
  if (worst && worst.nw > worst.cw + 1) problems.push(`9 999 999,99 ₴ не вміщується: ${worst.nw} > ${worst.cw}`);
  // «Інвестиції» у слоті нижньої панелі
  const slot = await page.evaluate(() => {
    const b = document.querySelector('#tabs [data-tab="inv"]'), s = b.querySelector('.nl');
    return {sw: s.scrollWidth, cw: b.clientWidth};
  });
  if (slot.sw > slot.cw + 1) problems.push(`«Інвестиції» ширша за слот: ${slot.sw} > ${slot.cw}`);

  // (а) Підписки: у .kpi .val живуть вкладені підписи (renderSubs: «найближче»
  // з <div class="sub">, «активних» з <span class="muted">). .val має
  // white-space:nowrap, і якщо підпис його успадкує, довгий продавець
  // розпирає плитку й сторінку. Розмітка — та сама, що малює renderSubs.
  await page.evaluate(() => go('subs')); await page.waitForTimeout(300);
  const subs = await page.evaluate(() => {
    const vals = [...document.querySelectorAll('#subTotals .kpi .val')];
    if (vals.length < 4) return {missing: vals.length};
    vals[3].innerHTML = 'через 3 дні<div class="sub">Netflix Premium Family · 1 299 ₴</div>';
    vals[2].innerHTML = '12 <span class="muted">+3 зупинених Netflix Premium Family</span>';
    return {
      vals: vals.slice(2, 4).map(v => ({sw: v.scrollWidth, cw: v.clientWidth})),
      h: document.documentElement.scrollWidth > innerWidth,
    };
  });
  if (subs.missing !== undefined) problems.push(`Підписки: плиток KPI ${subs.missing}, очікувалось ≥ 4`);
  else {
    subs.vals.forEach((v, i) => {
      if (v.sw > v.cw + 1) problems.push(`Підписки: підпис у плитці ${i + 3} розпирає .val: ${v.sw} > ${v.cw}`);
    });
    if (subs.h) problems.push('Підписки: довгий «найближче» дає горизонтальний скрол сторінки');
  }

  // (б) Свій період: між сегментом і рядком дат рівно 10 px (gap #periodWrap).
  // Раніше рядок мав власний margin і проміжок подвоювався.
  const prevPeriod = await page.evaluate(() => S.period);
  const gap = await page.evaluate(async () => {
    S.period = 'custom'; go('overview');
    await new Promise(r => setTimeout(r, 300));
    const bar = document.querySelector('.periodbar'), row = document.getElementById('customRange');
    if (!bar || !row || row.hidden || row.offsetParent === null) return null;
    return row.getBoundingClientRect().top - bar.getBoundingClientRect().bottom;
  });
  if (gap === null) problems.push('свій період: рядок #customRange не показався');
  else if (Math.abs(gap - 10) > 1) problems.push(`свій період: проміжок сегмент→рядок ${gap.toFixed(1)} px, очікувалось 10`);
  await page.evaluate(p => { S.period = p; go('overview'); }, prevPeriod);

  // (в) Тост і бейдж режиму скріншоту — над нижньою панеллю, а не під нею.
  const float = await page.evaluate(async () => {
    appToast('x'); scrnToggle(true);
    await new Promise(r => setTimeout(r, 100));
    const tabsTop = document.getElementById('tabs').getBoundingClientRect().top;
    const t = document.getElementById('apptoast'), b = document.getElementById('scrnBadge');
    const out = {tabsTop, toast: t ? t.getBoundingClientRect().bottom : null,
      badge: b && !b.hidden ? b.getBoundingClientRect().bottom : null};
    scrnToggle(false);
    return out;
  });
  if (float.toast === null) problems.push('тост не зʼявився');
  else if (float.toast > float.tabsTop + 0.5) problems.push(`тост під нижньою панеллю: низ ${float.toast} > ${float.tabsTop}`);
  if (float.badge === null) problems.push('бейдж режиму скріншоту не зʼявився');
  else if (float.badge > float.tabsTop + 0.5) problems.push(`бейдж під нижньою панеллю: низ ${float.badge} > ${float.tabsTop}`);

  assert.deepEqual(problems, [], 'переповнення на 390 px:\n' + problems.join('\n'));
  console.log('390 px: переповнень немає — OK');
} finally { await browser.close(); }
