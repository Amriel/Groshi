// Контраст токенів у обох темах. Значення в CSS — початкові; сторож
// не дає їм тихо опуститись нижче читабельного, коли хтось «підкрутить» колір.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = 4.5, NONTEXT = 3;
const PAIRS = [
  ['--text', '--bg', TEXT], ['--text', '--surface', TEXT],
  ['--text-dim', '--bg', TEXT], ['--text-dim', '--surface', TEXT],
  ['--text-mute', '--bg', TEXT], ['--text-mute', '--surface', TEXT],
  ['--accent-contrast', '--accent', TEXT], ['--accent-ink', '--surface', TEXT],
  ['--success', '--surface', NONTEXT], ['--warn', '--surface', NONTEXT],
  ['--danger', '--surface', NONTEXT], ['--info', '--surface', NONTEXT],
];
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(root, 'app/Groshi_app.html')).href);
  await page.waitForFunction(() => typeof window.go === 'function');
  const bad = [];
  for (const theme of ['dark', 'light']) {
    const ratios = await page.evaluate(([theme, pairs]) => {
      document.documentElement.dataset.theme = theme;
      const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
        return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
      const probe = document.createElement('i'); document.body.appendChild(probe);
      const get = v => { probe.style.color = `var(${v})`; return rgb(getComputedStyle(probe).color); };
      const out = pairs.map(([fg, bg, min]) => {
        const a = lum(get(fg)), b = lum(get(bg));
        const r = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        return {fg, bg, min, r: Math.round(r * 100) / 100};
      });
      probe.remove(); return out;
    }, [theme, PAIRS]);
    for (const x of ratios) if (x.r < x.min) bad.push(`${theme}: ${x.fg} на ${x.bg} = ${x.r} < ${x.min}`);
  }
  assert.deepEqual(bad, [], 'контраст токенів:\n' + bad.join('\n'));
  console.log('контраст токенів у двох темах — OK');
} finally { await browser.close(); }
