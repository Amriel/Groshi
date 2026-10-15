// Контраст токенів у обох темах. Значення в CSS — початкові; сторож
// не дає їм тихо опуститись нижче читабельного, коли хтось «підкрутить» колір.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = 4.5, NONTEXT = 3;
// Поверхні, на яких у апці лежить текст: тло сторінки, картка, поле/рядок
// під наведенням і спливні підказки (#tip, .qlab — на --surface-3).
const SURF = ['--bg', '--surface', '--surface-2', '--surface-3'];
const PAIRS = [
  ['--text', '--bg', TEXT], ['--text', '--surface', TEXT],
  ['--text-dim', '--bg', TEXT], ['--text-dim', '--surface', TEXT],
  // --text-mute стоїть і в підказках (--surface-3), і в полях (--surface-2):
  // світле #6E6E73 на --surface-3 мало лише 4,15:1.
  ...SURF.map(s => ['--text-mute', s, TEXT]),
  ['--accent-contrast', '--accent', TEXT],
  ['--accent-ink', '--bg', TEXT], ['--accent-ink', '--surface', TEXT],
  // Статусні кольори — це ще й ДРІБНИЙ текст (12,5/11 px: «▲ 4%», «скоро»,
  // «+3,2%» у підказці курсора), тому 4,5:1 на кожній поверхні, де він буває.
  // Світлі --warn (#A9700A, 4,19) і --success (#12855A, 3,80 на --surface-3)
  // цього не тримали.
  ...['--success', '--warn', '--danger'].flatMap(c => SURF.map(s => [c, s, TEXT])),
  // --info тексту не має (лише крапка .dot.info) — як непозначка ≥ 3:1.
  ['--info', '--surface', NONTEXT],
  // кнопка небезпечної дії у вікні: текст кольору --bg на заливці --danger
  ['--bg', '--danger', TEXT],
  // бейдж-лічильник у панелі й бейдж режиму скріншоту: темний текст на бурштині
  ['--on-warn', '--warn-fill', TEXT],
  // Серії графіків і стовпчики «Витрати/Надходження» на картці — це позначки,
  // не текст: ≥ 3:1 (скіл dataviz, перевірка 5). Розрізнюваність і дальтонізм
  // перевіряє валідатор скіла, а не ця проба (команду й вивід див. у
  // .superpowers/sdd/2026-10-15-ui-redesign/task-13-report.md).
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(i => [`--s${i}`, '--surface', NONTEXT]),
  ['--bar-exp', '--surface', NONTEXT], ['--bar-inc', '--surface', NONTEXT],
];
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(root, 'app/Groshi_app.html')).href);
  await page.waitForFunction(() => typeof window.go === 'function');
  const bad = [];
  for (const theme of ['dark', 'light']) {
    const res = await page.evaluate(([theme, pairs]) => {
      document.documentElement.dataset.theme = theme;
      // Обчислений колір буває rgb()/rgba() або, для color-mix(), color(srgb 0..1).
      // Невідомий формат — помилка, а не «нуль»: інакше пара з нерозібраним
      // кольором мала б нульову яскравість і могла б пройти хибно.
      const rgb = s => {
        let m = s.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/);
        if (m) return m.slice(1, 4).map(Number);
        m = s.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)/);
        if (m) return m.slice(1, 4).map(x => Number(x) * 255);
        throw new Error('невідомий формат кольору: ' + s);
      };
      const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
        return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
      const ratio = (a, b) => { a = lum(a); b = lum(b);
        return Math.round((Math.max(a, b) + .05) / (Math.min(a, b) + .05) * 100) / 100; };
      // Токен мусить ІСНУВАТИ: перейменований токен у var() дає порожнє
      // значення, color успадковує колір тексту body — і пара «проходить».
      const rootCS = getComputedStyle(document.documentElement);
      const missing = [...new Set(pairs.flatMap(([fg, bg]) => [fg, bg]))]
        .filter(v => rootCS.getPropertyValue(v).trim() === '');
      const probe = document.createElement('i'); document.body.appendChild(probe);
      const get = v => { probe.style.color = `var(${v})`; return rgb(getComputedStyle(probe).color); };
      const out = pairs.map(([fg, bg, min]) => ({fg, bg, min, r: ratio(get(fg), get(bg))}));
      probe.remove();
      // Літера на кольоровому колі категорії (.badge-ico.c1–.c8): заливку
      // й колір літери беремо з самого елемента — частину слотів CSS
      // зсуває color-mix, частину пише білою. Зміна палітри --s1..--s8 без
      // перегляду цих правил має падати тут.
      for (let i = 1; i <= 8; i++) {
        const b = document.createElement('span');
        b.className = `badge-ico c${i}`; b.textContent = 'А';
        document.body.appendChild(b);
        const cs = getComputedStyle(b);
        out.push({fg: `.badge-ico.c${i} літера`, bg: 'заливка', min: 4.5,
          r: ratio(rgb(cs.color), rgb(cs.backgroundColor))});
        b.remove();
      }
      return {missing, out};
    }, [theme, PAIRS]);
    for (const v of res.missing) bad.push(`${theme}: токена ${v} немає`);
    for (const x of res.out) if (x.r < x.min) bad.push(`${theme}: ${x.fg} на ${x.bg} = ${x.r} < ${x.min}`);
    console.log(`${theme}: ${res.out.length} пар, найменше — ` +
      res.out.reduce((a, x) => (x.r / x.min < a.r / a.min ? x : a)).fg + ' ' +
      res.out.reduce((a, x) => (x.r / x.min < a.r / a.min ? x : a)).r);
  }
  assert.deepEqual(bad, [], 'контраст токенів:\n' + bad.join('\n'));
  console.log('контраст токенів у двох темах — OK');
} finally { await browser.close(); }
