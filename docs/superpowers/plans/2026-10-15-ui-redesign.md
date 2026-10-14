# Переробка UI «Грошей» — план виконання

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Розділ «Спільна процедура екрана» (після Задачі 6b) є частиною кожної задачі 7–12: читати його повністю.

**Goal:** Замінити вигляд і навігацію «Грошей» на гібрид Apple + Monobank: бічна панель на десктопі, нижні таби у вузькому вікні, плоскі картки, одна система токенів, без WebGL-скла.

**Architecture:** Один шаблон `app/app.template.html` лишається джерелом правди. Спершу нові токени з аліасами на старі назви (Задача 1), потім видалення скла з плоскою базою (Задача 2), далі каркас (3–5), компоненти (6a/6b), екрани по одному (7–12), графіки (13), зняття аліасів і підсумок (14). Кожна задача закінчується робочою збіркою в обох версіях і зеленими пробами.

**Tech Stack:** HTML/CSS/JS в одному шаблоні; складачі `app/build_app.py` і `desktop/build_desktop.py`; проби Playwright (`tests/*.mjs`), Python `unittest`; Node 18+.

**Spec:** [docs/superpowers/specs/2026-10-15-ui-redesign-design.md](../specs/2026-10-15-ui-redesign-design.md)

## Global Constraints

Кожна задача успадковує ці вимоги.

- Мова інтерфейсу, коментарів, документації й повідомлень комітів — українська. Коментарі пояснюють *чому* (симптом і причину), а не *що*.
- Інтерфейс правиться **лише** в `app/app.template.html`. Файли `app/Groshi_app.html`, `desktop/dist/index.html`, `desktop/dist/app.js` генеруються й руками не редагуються (хук `.claude/hooks/guard.py` їх блокує).
- Після будь-якої правки шаблону — обидві збірки: `python app/build_app.py` і `python desktop/build_desktop.py`. Хук `build.py` перезбирає сам, але результат перевіряти: у виводі немає `Traceback` і `AssertionError`.
- `desktop/build_desktop.py` знаходить місця вставки **точними текстовими якорями** шаблону (`sub(tpl, '<текст>', …)` з `assert count == 1`). Якщо правка зачіпає текст якоря — оновити якір у тій самій задачі. Помилка «якір … знайдено 0 разів» означає саме це.
- Жодного системного вигляду: не вводити `prompt()`, `confirm()`, `alert()`, нативний `<select>`, `<input type="date">`, `<input list>`, системний checkbox, атрибут `title`. Використовувати `uiAsk()`/`uiConfirm()`/`uiPick()`, `.csel`, `buildCombo()`, `SD`, `DP`, `data-tip` і власний checkbox.
- **Ніколи** не робити кольорову смугу збоку картки/рядка/панелі (`border-left` кольором категорії, inset-тінь-смуга) і не тонувати фон усієї картки кольором категорії. Колір категорії — лише в колі-іконці, чипі або крапці.
- Нічого не смикається: перемальовувати на місці замість `innerHTML =`, коли елемент лишається; фіксувати ширину змінного тексту; після змін UI порівнювати `getBoundingClientRect()` до й після.
- `backdrop-filter` не вводиться ніде, навіть на модалках.
- Згенеровані клієнтські рахунки (HTML-документи, що їх відкриває клієнт) **не змінюються**: це не інтерфейс апки.
- Токени/ключі не потрапляють у файли, `localStorage`, журнали й повідомлення. Проби використовують лише штучні дані; у `Data/` і `Backup/` не читати.
- Коміти: адресу співавтора в файлах не писати (хук приватності відхиляє email), її беруть із атрибуції сесії при коміті; лише явні шляхи (`git add <шлях> …`), ніколи `git add -A` або `git add .`. Кожен коміт закінчується рядком `Co-Authored-By: Claude Sonnet 5.5 <адреса з атрибуції сесії>`. Виконавці-сабагенти не комітять: повертають перелік змінених шляхів, комітить головний цикл.
- Розкладки: ширина `<760 px` — нижні таби; `760–999 px` — іконкова панель 64 px; `≥1000 px` — повна панель 220 px (звужувана до 64 px). Нижня панель 56 px + безпечна зона. Радіуси `12 / 18 / 24`. Шрифт лише Onest. Рух 180 мс, `cubic-bezier(.2,.8,.2,1)`, вимикається за `prefers-reduced-motion`.
- Мінімум перед «готово» для кожної задачі: `node tests/allcheck.mjs`, `node tests/modal.mjs`, `node tests/pjjump.mjs`, проба зміненої поведінки, обидві збірки без помилок. Тимчасові результати — у `.test-artifacts/` (ігнорується git).
- Документація змінюється разом із кодом: підсумковий розділ у `docs/РОЗРОБКА.md` і дата «Оновлено» вгорі — Задача 14; задачі 2 і 4 дописують свої розділи одразу.

## Review Focus

Вхідні випадки, які спека мовчки припускає, але жодна проба стандартного набору їх не перевіряє. Кожен має тест у задачі-власниці.

1. **Межі ширини 759/760/999/1000 px.** У жодному з цих значень не видно двох навігацій одночасно й контент не «стрибає». Тест — `tests/nav.mjs` (Задача 4).
2. **Бейдж «Підписки»** (`data-badge`) видно у всіх розкладках: праворуч у повній панелі, на іконці у звуженій і нижній. Тест — `tests/nav.mjs` (Задача 4).
3. **Клавіші `1`–`7` і `/`** працюють у всіх розкладках; у нижній панелі `go('cats')` підсвічує «Ще»; `Esc` закриває меню «Ще». Тест — `tests/nav.mjs` (Задача 4).
4. **390 px: довгі підписи й великі суми.** «Інвестиції» вміщується в слот нижньої панелі; сума `9 999 999,99 ₴` у великій цифрі не виходить за картку; горизонтального скролу сторінки немає. Тест — `tests/overflow.mjs` (Задача 6a).
5. **Тема й рух.** Системна тема застосовується при першому запуску без збереженого вибору; за `prefers-reduced-motion: reduce` переходи миттєві; майстер першого запуску й екран блокування накривають панель (навігація недоступна з клавіатури під модалкою). Тест — `tests/shell-a11y.mjs` (Задача 6b).

---

## Файли: що створюється й змінюється

| Файл | Відповідальність |
|---|---|
| `app/app.template.html` | увесь UI: токени, каркас, компоненти, екрани |
| `app/build_app.py` | складання браузерної версії; після Задачі 0 приймає `--data`/`--out` |
| `desktop/build_desktop.py` | складання десктопної; оновлюються якорі й прибирається скло |
| `tests/helpers/synthetic.mjs` | (нове) штучний набір операцій для знімків і проб |
| `tests/snap.mjs` | (нове) знімки 7 вкладок × 2 теми × 3 ширини |
| `tests/contrast.mjs` | (нове) контраст токенів у обох темах |
| `tests/nav.mjs` | (нове) розкладки навігації, межі ширини, клавіші, меню «Ще» |
| `tests/nostripe.mjs` | (нове) жодних кольорових бічних смуг на видимих елементах |
| `tests/overflow.mjs` | (нове) відсутність горизонтального скролу й виходу сум за картку |
| `tests/shell-a11y.mjs` | (нове) системна тема, reduced-motion, фокус під модалкою |
| `tests/README.md`, `package.json` | реєстрація нових проб, прибирання `glass2`/`v1311` частин |
| `app/glassgl.js`, `app/designer.js`, `tests/glass2.mjs` | **видаляються** (Задача 2) |
| `docs/РОЗРОБКА.md` | розділ про нову систему замість §4 «Скло» |

---

### Task 0: Гілка, штучні дані й знімки «до»

**Files:**
- Modify: `app/build_app.py`
- Create: `tests/helpers/synthetic.mjs`, `tests/snap.mjs`
- Modify: `tests/README.md`

**Interfaces:**
- Produces: `python app/build_app.py --data <json> --out <html>` (без аргументів — як раніше); `node tests/helpers/synthetic.mjs` пише `.test-artifacts/synthetic.json`; `node tests/snap.mjs <мітка>` пише `.test-artifacts/snap-<мітка>/<тема>-<ширина>-<вкладка>.png` зі збірки `.test-artifacts/synthetic_app.html`. Усі наступні задачі їх уживають.

- [ ] **Step 1: Стан репозиторію й гілка**

Run:
```bash
cd /h/AI_Main/Claude/Personal/Expenses/repo && git status --short && git switch -c ui-redesign
```
Expected: `git status --short` порожній (або лише `docs/superpowers/…` файли цього проєкту); гілка `ui-redesign` створена.

- [ ] **Step 2: `build_app.py` приймає `--data` і `--out`**

Замінити весь вміст `app/build_app.py` на:

```python
# Збірка браузерної версії: шаблон + скрипти скла + дані одним HTML-файлом.
#
# Шляхи рахуються від САМОГО СКРИПТА, а не від того, звідки його
# запустили: збірка має однаково працювати і з кореня репозиторію
# (`python3 app/build_app.py`), і зсередини теки, і з CI.
#
# --data / --out потрібні пробам: знімки з наповненим екраном збирають
# окремий HTML зі штучним набором, а приватний dataset.private.json не
# чіпають і публічний Groshi_app.html не перезаписують.
import argparse, json, pathlib
from build_security import script_json, protect_html
H = pathlib.Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument('--data', help='JSON із операціями замість dataset.json / dataset.private.json')
ap.add_argument('--out', help='куди писати HTML замість app/Groshi_app.html')
args = ap.parse_args()
tpl   = (H/'app.template.html').read_text('utf-8')
glass = (H/'glassgl.js').read_text('utf-8')
designer = (H/'designer.js').read_text('utf-8')
data_path = pathlib.Path(args.data) if args.data else (H/'dataset.private.json')
if not data_path.exists():
    data_path = H/'dataset.json'
data  = json.loads(data_path.read_text('utf-8'))
mcc   = json.loads((H/'mcc_names.json').read_text('utf-8'))
meta_path = H/'meta.private.json'
meta  = json.loads((meta_path if meta_path.exists() else H/'meta.json').read_text('utf-8'))
html = (tpl.replace('__GLASSGL__', glass).replace('__DESIGNER__', designer)
           .replace('__DATA__', script_json(data))
           .replace('__MCCNAME__', script_json(mcc))
           .replace('__META__', script_json(meta)))
html = protect_html(html)
out = pathlib.Path(args.out) if args.out else (H/'Groshi_app.html')
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html, encoding='utf-8')
print('built', len(html), out)
```

Run: `python app/build_app.py`
Expected: `built <число> …/app/Groshi_app.html`.

- [ ] **Step 3: Штучний набір**

Створити `tests/helpers/synthetic.mjs`:

```js
// Штучні операції для знімків і проб. Поля повторюють запис, що його
// видає desktop/dist/mononorm.js (amount завжди у гривні й додатний,
// напрямок у dir), тож екрани з даними малюються так само, як зі справжніми.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function syntheticTx(days = 120) {
  const kinds = [
    ['Продукти', 'Супермаркет', '5411', false],
    ['Кафе і ресторани', 'Кава', '5814', false],
    ['Транспорт', 'Таксі', '4121', false],
    ['Підписки', 'Музика', '4899', false],
    ['Зарплата', 'Надходження', '', true],
    ['Фриланс', 'Надходження', '', true],
  ];
  const out = [];
  let n = 0;
  const start = Date.now() - days * 864e5;
  for (let d = 0; d < days; d++) {
    const date = new Date(start + d * 864e5).toISOString().slice(0, 10);
    for (let k = 0; k < 3; k++) {
      const [cat, sub, mcc, income] = kinds[(d * 3 + k) % kinds.length];
      out.push({
        id: 's' + (++n), date, time: `1${k}:00`,
        merchant: `${sub} ${d % 7}`,
        amount: income ? 20000 + (d % 5) * 1500 : 60 + ((d * 37 + k * 91) % 900),
        dir: income ? 'income' : 'expense', conf: 'mono', balance: 50000,
        mcc, cat, sub, account: 'Чорна картка', acctype: 'black',
      });
    }
  }
  return out;
}

// Запуск напряму пише файл; імпорт з інших проб лише дає syntheticTx().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(root, '.test-artifacts');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'synthetic.json'), JSON.stringify(syntheticTx()));
  console.log('synthetic.json:', syntheticTx().length, 'операцій');
}
```

Run: `node tests/helpers/synthetic.mjs`
Expected: `synthetic.json: 360 операцій`.

- [ ] **Step 4: Скрипт знімків**

Створити `tests/snap.mjs`:

```js
// Знімки для ручного порівняння «до/після»: 7 вкладок × 2 теми × 3 ширини.
// Це інструмент, а не сторож: нічого не стверджує, лише пише PNG.
// Запуск: node tests/snap.mjs <мітка>   → .test-artifacts/snap-<мітка>/
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = process.argv[2];
if (!label) { console.error('usage: node tests/snap.mjs <мітка>'); process.exit(2); }
const file = process.env.SNAP_FILE || path.join(root, '.test-artifacts', 'synthetic_app.html');
const outDir = path.join(root, '.test-artifacts', `snap-${label}`);
fs.mkdirSync(outDir, {recursive: true});
const WIDTHS = [[1400, 900], [900, 800], [390, 844]];
const TABS = ['overview', 'cats', 'tx', 'budget', 'inv', 'subs', 'settings'];
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const errors = [];
for (const [w, h] of WIDTHS) {
  const ctx = await browser.newContext({viewport: {width: w, height: h}});
  await ctx.addInitScript(() => localStorage.setItem('wizDone', 'true'));
  await ctx.route(/^https?:/, r => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => typeof window.go === 'function');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t; store.set('theme', t); }, theme);
    for (const tab of TABS) {
      await page.evaluate(t => go(t), tab);
      await page.waitForTimeout(900);
      await page.screenshot({path: path.join(outDir, `${theme}-${w}-${tab}.png`)});
    }
  }
  await ctx.close();
}
await browser.close();
if (errors.length) { console.error('ПОМИЛКИ:', errors.slice(0, 5)); process.exit(1); }
console.log('знімків:', fs.readdirSync(outDir).length, '→', outDir);
```

- [ ] **Step 5: Знімки «до»**

Run:
```bash
python app/build_app.py --data .test-artifacts/synthetic.json --out .test-artifacts/synthetic_app.html && node tests/snap.mjs before
```
Expected: `знімків: 42 → …/snap-before`. Прочитати через Read `…/snap-before/dark-1400-overview.png` і `light-390-tx.png`: на екрані видно операції (не порожній стан) і немає модалки привітання.

- [ ] **Step 6: Запис у `tests/README.md`**

У розділ «Playwright-проби» додати під таблицею абзац:

```markdown
**Знімки, не проби.** `node tests/helpers/synthetic.mjs` пише штучний набір,
`python app/build_app.py --data .test-artifacts/synthetic.json --out
.test-artifacts/synthetic_app.html` збирає з ним окремий HTML, а
`node tests/snap.mjs <мітка>` робить 42 знімки (7 вкладок × 2 теми × 3 ширини)
у `.test-artifacts/snap-<мітка>/`. Це інструмент для порівняння вигляду до й
після змін, він нічого не стверджує й у `npm test` не входить.
```

- [ ] **Step 7: Commit**

```bash
git add app/build_app.py tests/helpers/synthetic.mjs tests/snap.mjs tests/README.md
git commit -m "Знімки зі штучними даними: build_app --data/--out, snap.mjs" -m "Co-Authored-By: Claude Sonnet 5.5 <адреса з атрибуції сесії>"
```

---

### Task 1: Нові токени, один шрифт, аліаси

**Files:**
- Modify: `app/app.template.html` (рядки ≈13–14, 18–73, 1147–1164, 1186–1196)
- Modify: `docs/superpowers/specs/2026-10-15-ui-redesign-design.md` (таблиця токенів)
- Create: `tests/contrast.mjs`
- Modify: `package.json`, `tests/README.md`

**Interfaces:**
- Produces: токени `--bg --surface --surface-2 --surface-3 --border --border-soft --text --text-dim --text-mute --accent --accent-hover --accent-soft --accent-contrast --accent-ink --success --warn --danger --info --radius(18) --radius-sm(12) --radius-lg(24) --radius-pill --ctl --shadow-pop --scrim --ease --dur --nav-w --nav-w-collapsed --tabbar-h --fs-xs…--fs-3xl --font-ui --font-display(=font-ui)`; аліаси старих назв (`--surface-1 --plane --ink --ink-2 --muted --grid --axis --good --crit --serious --bar-exp --bar-inc --s1..--s8`) і тимчасові `--glass-*` (прибираються в Задачі 2).

- [ ] **Step 1: Проба контрасту (спершу падає)**

Створити `tests/contrast.mjs`:

```js
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
```

Run: `node tests/contrast.mjs`
Expected: FAIL (на старих токенах `--accent-ink` не існує → `rgb()` не парситься, або контраст нижчий).

- [ ] **Step 2: Прибрати Geologica**

У `app/app.template.html` видалити два `@font-face` з `font-family:'Geologica'` (рядки 13–14). Лишити два `@font-face` з `'Onest'`.

Run: `grep -c "Geologica" app/app.template.html`
Expected: тільки згадки в CSS-правилах, що задають `--font-display` (будуть замінені в наступному кроці); `@font-face` з Geologica немає: `grep -c "font-family:'Geologica';font-style" app/app.template.html` → `0`.

- [ ] **Step 3: Замінити перший набір токенів**

Замінити блок від коментаря `/* ═══… Токени — з design_handoff_pai_redesign …` до закриття `:root[data-theme="light"]{ … }` (рядки 18–73) на:

```css
/* ══════════════════════════════════════════════════════════════
   Токени. Єдине місце, де живуть кольори, розміри й шрифти; решта
   CSS написана в термінах ролей. Колишній другий набір (`:root:root`,
   «скляний») прибрано: два набори різних шрифтів і кольорів давали
   вигляд, якого не описував жоден із них.
   Контраст тексту ≥ 4,5:1 сторожить tests/contrast.mjs.
   ══════════════════════════════════════════════════════════════ */
:root{
  color-scheme:dark;
  --bg:#0A0A0B; --surface:#151517; --surface-2:#1E1E21; --surface-3:#28282C;
  --border:rgba(255,255,255,.08); --border-soft:rgba(255,255,255,.05);
  --text:#F5F5F7; --text-dim:#A1A1A6; --text-mute:#8E8E93;
  --accent:#C9F24B; --accent-hover:#D6F76B; --accent-soft:rgba(201,242,75,.14);
  --accent-contrast:#16200A; --accent-ink:#C9F24B;
  --accent-line:color-mix(in srgb,var(--accent) 45%,var(--border));
  --success:#34D399; --warn:#FBBF3C; --danger:#FF6B6B; --info:#7AA2FF;
  --radius:18px; --radius-sm:12px; --radius-lg:24px; --radius-pill:999px; --ctl:40px;
  --shadow:none; --shadow-pop:0 12px 40px rgba(0,0,0,.55); --scrim:rgba(0,0,0,.55);
  --ease:cubic-bezier(.2,.8,.2,1); --dur:180ms;
  --nav-w:220px; --nav-w-collapsed:64px; --tabbar-h:56px;
  --fs-xs:11px; --fs-sm:13px; --fs-md:15px; --fs-lg:17px;
  --fs-xl:22px; --fs-2xl:28px; --fs-3xl:40px;
  --font-ui:'Onest',system-ui,-apple-system,'Segoe UI',sans-serif;
  --font-display:var(--font-ui);
  --font-mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;

  /* аліаси старих імен: знімаються екран за екраном, остаточно — Задача 14 */
  --surface-1:var(--surface); --plane:var(--bg);
  --ink:var(--text); --ink-2:var(--text-dim); --muted:var(--text-mute);
  --grid:rgba(255,255,255,.10); --axis:rgba(255,255,255,.42);
  --good:var(--success); --crit:var(--danger); --serious:#EC835A;
  --bar-exp:#7AA2FF; --bar-inc:#A9DE2C;
  /* серії графіків: перевіряються в Задачі 13 */
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
  --s5:#d55181; --s6:#008300; --s7:#9085e9; --s8:#e66767;
  /* тимчасово: ще читає скляний CSS; зникне в Задачі 2 */
  --glass-bg:linear-gradient(180deg,rgba(255,255,255,.075),rgba(255,255,255,.028));
  --glass-bg-h:linear-gradient(180deg,rgba(255,255,255,.13),rgba(255,255,255,.05));
  --glass-br:rgba(255,255,255,.13);
  --glass-in:inset 0 1px 0 rgba(255,255,255,.15);
  --glass-blur:blur(14px) saturate(150%);
}
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#F2F2F7; --surface:#FFFFFF; --surface-2:#F5F5F7; --surface-3:#E8E8ED;
  --border:rgba(0,0,0,.08); --border-soft:rgba(0,0,0,.05);
  --text:#1D1D1F; --text-dim:#48484A; --text-mute:#6E6E73;
  --accent:#B7E03A; --accent-hover:#A8D12C; --accent-soft:rgba(183,224,58,.22);
  --accent-contrast:#16200A; --accent-ink:#3F5E00;
  --success:#12855A; --warn:#A9700A; --danger:#C33B3B; --info:#2E5FBF;
  --shadow-pop:0 12px 40px rgba(0,0,0,.14); --scrim:rgba(0,0,0,.28);
  --grid:rgba(0,0,0,.10); --axis:rgba(0,0,0,.42);
  --bar-exp:#3B6FD4; --bar-inc:#6F9412;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100;
  --s5:#e87ba4; --s6:#008300; --s7:#4a3aa7; --s8:#e34948;
  --glass-bg:linear-gradient(180deg,rgba(255,255,255,.85),rgba(255,255,255,.55));
  --glass-bg-h:linear-gradient(180deg,#fff,rgba(255,255,255,.75));
  --glass-br:rgba(11,11,12,.10);
  --glass-in:inset 0 1px 0 rgba(255,255,255,.9);
}
```

- [ ] **Step 4: Прибрати другий набір токенів**

Видалити два блоки: `:root:root{ color-scheme:dark; … --font-mono:…; }` (≈1147–1164) і `:root:root[data-theme="light"]{ color-scheme:light; … }` (≈1186–1196). Решту `:root:root …` правил (тло, поверхні, кнопки) **не чіпати** — їх прибирає Задача 2.

Run: `grep -n "^:root:root{\|^:root:root\[data-theme=\"light\"\]{" app/app.template.html`
Expected: порожньо.

- [ ] **Step 5: Збірки й проби**

Run:
```bash
python app/build_app.py && python desktop/build_desktop.py && node tests/contrast.mjs && node tests/allcheck.mjs
```
Expected: обидві збірки без `Traceback`; `контраст токенів у двох темах — OK`; allcheck `browser: 7 вкладок… OK` і `desktop: … OK`.

- [ ] **Step 6: Виправити спеку**

У `docs/superpowers/specs/2026-10-15-ui-redesign-design.md` у таблиці токенів замінити рядки `--text-dim`/`--text-mute` на `#A1A1A6`/`#8E8E93` (темна) і `#48484A`/`#6E6E73` (світла), акцент світлої `#B7E03A`, і додати рядок `--accent-ink` — `#C9F24B` / `#3F5E00`. Причина (один рядок під таблицею): початкові значення `--text-mute` не проходили власний критерій ≥ 4,5:1.

- [ ] **Step 7: Реєстрація проби**

У `package.json` у `scripts.test` додати `&& node tests/contrast.mjs` після `node tests/allcheck.mjs`. У `tests/README.md` додати рядок до таблиці:

```markdown
| `contrast.mjs` | контраст текстових токенів ≥ 4,5:1 і статусних ≥ 3:1 у темній і світлій темах | `npm test` |
```

- [ ] **Step 8: Знімки й commit**

Run: `python app/build_app.py --data .test-artifacts/synthetic.json --out .test-artifacts/synthetic_app.html && node tests/snap.mjs t1`
Expected: `знімків: 42`; Read `snap-t1/dark-1400-overview.png`: колір тла й тексту нові, шрифт Onest, інтерфейс ще скляний (це очікувано).

```bash
git add app/app.template.html docs/superpowers/specs/2026-10-15-ui-redesign-design.md tests/contrast.mjs package.json tests/README.md
git commit -m "Нові токени: один набір, Onest, аліаси старих імен, проба контрасту" -m "Co-Authored-By: Claude Sonnet 5.5 <адреса з атрибуції сесії>"
```

---

### Task 2: Видалення скла й плоска база

**Files:**
- Delete: `app/glassgl.js`, `app/designer.js`, `tests/glass2.mjs`
- Modify: `app/build_app.py`, `desktop/build_desktop.py`, `app/app.template.html`, `.claude/hooks/build.py`, `package.json`, `tests/README.md`, `tests/v1311.mjs`, `docs/РОЗРОБКА.md`

**Interfaces:**
- Consumes: токени Задачі 1.
- Produces: плоскі поверхні `.card .det .btn .btn.pri .chip .iconbtn input select textarea .tag code` у кінці CSS-блоку «ДИЗАЙН-СИСТЕМА»; стан `.on` для кнопок (`button.on` — акцентна заливка); у розмітці й JS немає слів `glass`, `__glassNow`, `glowcv`, `lg-flat`, `data-glass`.

- [ ] **Step 1: Складачі без скла**

У `app/build_app.py` видалити рядки `glass = …`, `designer = …` і замінити `html = (tpl.replace('__GLASSGL__', glass).replace('__DESIGNER__', designer)\n           .replace('__DATA__', …` на `html = (tpl.replace('__DATA__', …` (лишити решту ланцюжка).

У `desktop/build_desktop.py` видалити рядки 27–28 (`glass = …`, `designer = …`) і рядок 1040 `tpl = tpl.replace('__GLASSGL__', glass).replace('__DESIGNER__', designer)`.

У `.claude/hooks/build.py` з множини `SOURCES` видалити два рядки `glassgl.js` і `designer.js`.

- [ ] **Step 2: Видалити файли**

```bash
git rm app/glassgl.js app/designer.js tests/glass2.mjs
```

- [ ] **Step 3: Прибрати плейсхолдери й виклики `__glassNow`**

У шаблоні видалити два рядки `__GLASSGL__` і `__DESIGNER__` наприкінці скрипта. Потім одноразовий скрипт (лежить у scratchpad, не в репозиторії) прибирає виклики:

```bash
node -e "
const fs=require('fs');const f='app/app.template.html';let s=fs.readFileSync(f,'utf8');
const n0=(s.match(/__glassNow/g)||[]).length;
s=s.replace(/[ \t]*if\(window\.__glassNow\)\s*(?:window\.)?__glassNow\(\);/g,'');
fs.writeFileSync(f,s);console.log('було',n0,'лишилось',(s.match(/__glassNow/g)||[]).length);"
```
Expected: `було 24 лишилось 0` (число «було» може відрізнятись; «лишилось» — рівно 0). Переглянути `git diff -U0 app/app.template.html | grep '^-' | grep -v glassNow` — не мусить бути жодного зайвого рядка, окрім самих викликів.

- [ ] **Step 4: Прибрати слід курсора й полотно**

У шаблоні:
1. Видалити `<canvas id="glowcv" aria-hidden="true"></canvas>`.
2. Видалити розділ від `/* ═══…═ СЛІД КУРСОРА` до закриття `})();` перед `/* ═══…═ ІНДИКАТОР ВКЛАДОК` включно (≈ 9380–9527).
3. Видалити CSS `#glowcv{…}` і суміжні правила (`#glowcv.on`, `[data-theme="light"] #glowcv…`).

Run: `grep -n "glowcv\|cursorGlow" app/app.template.html`
Expected: порожньо.

- [ ] **Step 5: Прибрати клас `glass` з розмітки**

Одноразовий скрипт знімає токен `glass` з усіх `class="…"` у шаблоні й у складачі десктопа:

```bash
node -e "
const fs=require('fs');
for(const f of ['app/app.template.html','desktop/build_desktop.py']){
  let s=fs.readFileSync(f,'utf8');
  s=s.replace(/class=\"([^\"]*)\"/g,(m,c)=>{const t=c.split(/\s+/).filter(x=>x&&x!=='glass');return 'class=\"'+t.join(' ')+'\"';});
  fs.writeFileSync(f,s);
}"
grep -n "glass" app/app.template.html desktop/build_desktop.py | grep -v "^app/app.template.html:\(9[0-9][0-9]\|1[0-9][0-9][0-9]\)" | head -30
```
Expected: залишки лише в CSS-блоках, що прибираються на Кроці 6, у `classList`/`className`-викликах JS (знайти й виправити вручну: `grep -n "'glass'\|\"glass\"\|\.glass\b" app/app.template.html`), і в коментарях.

Якір `build_desktop.py:125` (`id="phoneBtn" data-tip="Перегляд на телефоні" data-key="P" hidden`) і якорі з `class="btn pri glass"` у вставках десктопа тепер без `glass`; перевірити Кроком 8.

- [ ] **Step 6: Видалити скляний CSS**

Видалити з шаблону (ділянки шукати за маркерами, номери рядків орієнтовні):
- `@property --gx/--gy/--gs` і блоки `.glass, .card, .det, nav.tabs, input, select, textarea{ --gx … }` та їх світла версія (≈75–107);
- дизеринг `body::after{…}` і `:root[data-theme="light"] body::after` (≈109–122);
- «Розсіяне світло» `body::before{…}` і світлу версію (≈141–164);
- стару `body{ background … linear-gradient … fixed; … }` і `:root[data-theme="light"] body{…}` (≈176–193, 218–221) — замінюється Кроком 7;
- `textarea{…}`, `input,select{…}` зі `backdrop-filter` і їх світлі версії (≈198–227) — замінюється Кроком 7;
- розділ `/* ── скло ──… */ .glass{…}` разом із `.glass:hover`, `.glass.on`, `.glass.on:hover`, світлими версіями (≈232–330), `nav.tabs.glass{…}`, `:root[data-theme="light"] nav.tabs.glass{…}`, `nav.tabs.glass > button{…}` (≈332–347);
- «Єдиний перехід для всіх поверхонь зі слідом» (≈1077–1090) разом із `button.glass:active`;
- увесь розділ `/* ══ ДИЗАЙН: LIQUID GLASS (WebGL) ══ */` до кінця файлу стилів: від його коментаря до правила `:root:root .kpi .val{white-space:nowrap}` включно (≈1133–1351).

Не видаляти: `.tab-ind{…}` і `.tab-ind.ready` (≈350–357), `.chip-ind{…}` (≈651–658), `nav.tabs button[data-badge]…` (≈1115–1118), `nav.tabs{position:fixed…}` і `@media(min-width:760px){…}` — вони живуть до Задач 3–5.

Run: `grep -c "backdrop-filter\|glass\|--gx\|lg-flat\|data-glass\|glass-gl" app/app.template.html`
Expected: `0` (якщо лишились згадки в коментарях — переформулювати коментар без слова «скло» або видалити).

- [ ] **Step 7: Плоска база**

У кінець блоку `<style>` (перед закриттям `</style>`) додати:

```css
/* ══════════════════ ДИЗАЙН-СИСТЕМА: плоска база ══════════════════
   Поверхня = різниця тону + тонка межа. Тіней, розмиття й заломлення
   немає: вони давали вигляд, який не відтворювався однаково між
   WebGL і CSS-запасним варіантом, і коштували кадрів під час скролу. */
body{background:var(--bg);color:var(--text);font:var(--fs-md)/1.5 var(--font-ui);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.card,.det{background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:20px 22px;box-shadow:var(--shadow)}
.det{border-radius:var(--radius-lg)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;
  height:var(--ctl);padding:0 16px;border-radius:var(--radius-sm);
  background:var(--surface-2);border:1px solid var(--border);
  color:var(--text);font-size:var(--fs-sm);font-weight:600;
  transition:background var(--dur) var(--ease),color var(--dur) var(--ease),transform var(--dur) var(--ease)}
.btn:hover{background:var(--surface-3)}
.btn:active{transform:scale(.98)}
.btn.pri,button.on{background:var(--accent);border-color:transparent;color:var(--accent-contrast)}
.btn.pri:hover,button.on:hover{background:var(--accent-hover)}
.iconbtn{width:var(--ctl);height:var(--ctl);border-radius:var(--radius-sm);display:grid;place-items:center;
  color:var(--text-dim);background:transparent}
.iconbtn:hover{color:var(--text);background:var(--surface-2)}
.chip{display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:var(--radius-pill);
  font-size:var(--fs-sm);font-weight:500;color:var(--text-dim);background:transparent}
.chip:hover{color:var(--text)}
.chip[aria-pressed="true"]{color:var(--text);font-weight:600;background:var(--surface-3)}
input,select,textarea{font:inherit;color:var(--text);background:var(--surface-2);
  border:1px solid var(--border);border-radius:var(--radius-sm);height:var(--ctl);padding:0 13px;
  transition:border-color var(--dur) var(--ease),box-shadow var(--dur) var(--ease)}
textarea{height:auto;min-height:96px;padding:10px 13px;line-height:1.5;resize:none}
input::placeholder,textarea::placeholder{color:var(--text-mute)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent-line);
  box-shadow:0 0 0 3px var(--accent-soft)}
code{font-family:var(--font-mono);font-size:.92em;background:var(--surface-2);
  border:1px solid var(--border-soft);border-radius:6px;padding:1px 6px}
.tab-ind,.chip-ind{background:var(--surface-3);border-radius:var(--radius-pill)}
nav.tabs{background:var(--surface);border:1px solid var(--border)}
nav.tabs button[aria-current="true"]{color:var(--text)}
#tip,#kbtip{background:var(--surface-3);color:var(--text);border:1px solid var(--border);
  border-radius:var(--radius-sm);box-shadow:var(--shadow-pop)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms !important;animation-duration:.01ms !important}}
```

Це лише безпечна база, щоб екрани не залишились без стилів між задачами; остаточні вигляди приходять у Задачах 3–12.

- [ ] **Step 8: Збірки, `v1311`, реєстри**

`tests/v1311.mjs`: видалити весь блок `/* A. фон під час переїзду шару */` (від коментаря до закриття `}));`), лишити блок B і наступні; оновити коментар у шапці файлу, що проба тепер сторожить лише маскування кошторису й випадайку стану. У `tests/README.md` рядок `v1311.mjs` замінити на:

```markdown
| `v1311.mjs` | маскування кошторису в режимі скріншоту, випадайка стану (частково дублює `scrn`, `pjstat`) | `npm test` |
```
і видалити рядок `glass2.mjs`. У `package.json` видалити `node tests/glass2.mjs && `.

Run:
```bash
python app/build_app.py && python desktop/build_desktop.py
```
Expected: без `AssertionError`. Якщо якір не знайдено — оновити текст якоря в `desktop/build_desktop.py` під нову розмітку (прибраний `glass`).

- [ ] **Step 9: Проби**

Run: `npm test`
Expected: усе зелене. Якщо `scrn.mjs`/`notrans.mjs` падають через зникнення індикатора — перечитати помилку; індикатори `#tabInd`/`#periodInd` лишились, їх логіку не міняли.

- [ ] **Step 10: Документація**

У `docs/РОЗРОБКА.md`: замінити розділ `## 4. Матеріал: скло на WebGL` (від заголовка до розділювача `---` перед `## 5.`) на:

```markdown
## 4. Матеріал: плоскі поверхні (замість WebGL-скла)

Скло прибрано в 1.33. Історія: спершу CSS + SVG `feDisplacementMap`, потім
власний елемент `<glass-gl>` (WebGL, карта освітлення на CPU 280–335 мс,
максимум 26 плит). Воно давало красиву картинку, але: перерахунок кадру під
час скролу коштував сотні мілісекунд, плити не діставались панелям вище
1,4 екрана, а запасна CSS-підкладка виглядала інакше, ніж шейдер, і кожне
перемикання вкладки читалось як спалах.

Тепер поверхня — це різниця тону (`--surface`, `--surface-2`, `--surface-3`)
плюс тонка межа `--border`. `backdrop-filter` не вживається ніде, навіть на
модалках. Видалено: `app/glassgl.js`, `app/designer.js`, плейсхолдери
`__GLASSGL__`/`__DESIGNER__`, слід курсора, проби `glass2.mjs` і частину
`v1311.mjs`. Токенів тепер один набір (раніше два: базовий і `:root:root`).
```
і оновити дату «Оновлено» вгорі файлу.

- [ ] **Step 11: Знімки й commit**

Run: `python app/build_app.py --data .test-artifacts/synthetic.json --out .test-artifacts/synthetic_app.html && node tests/snap.mjs t2`
Read `snap-t2/dark-1400-overview.png`, `light-1400-tx.png`, `dark-390-inv.png`: картки плоскі з межею, текст читається, нічого не накладається (навігація ще стара — це очікувано).

```bash
git add app/app.template.html app/build_app.py desktop/build_desktop.py .claude/hooks/build.py package.json tests/README.md tests/v1311.mjs docs/РОЗРОБКА.md
git commit -m "Скло прибрано: плоскі поверхні, один набір токенів" -m "Co-Authored-By: Claude Sonnet 5.5 <адреса з атрибуції сесії>"
```
(Видалені файли вже в індексі через `git rm`.)

---

### Task 3: Іконки й бічна панель на десктопі

**Files:**
- Modify: `app/app.template.html` (розмітка шапки/навігації, CSS каркаса, JS індикатора й кнопок)

**Interfaces:**
- Consumes: токени й плоска база.
- Produces: SVG-спрайт з символами `#i-overview #i-cats #i-tx #i-budget #i-inv #i-subs #i-more #i-chevron #i-theme #i-eye #i-phone`; розмітка `.shell > aside#side.side` (бренд, `nav.tabs#tabs` із `button[data-tab]`, `.side-foot` із `#phoneBtn #scrnBtn #themeBtn #navToggle`) і `.wrap` праворуч; клас `.collapsed` на `.shell`; `applyShell()`; `slideInd(host, ind, act, both)` (четвертий аргумент — рух по двох осях).

- [ ] **Step 1: Спрайт іконок**

Одразу після відкриття `<body>` додати:

```html
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <defs>
    <symbol id="i-overview" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/></symbol>
    <symbol id="i-cats" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5V12h8.5"/></symbol>
    <symbol id="i-tx" viewBox="0 0 24 24"><path d="M8 6.5h12M8 12h12M8 17.5h12"/><circle cx="4" cy="6.5" r=".8"/><circle cx="4" cy="12" r=".8"/><circle cx="4" cy="17.5" r=".8"/></symbol>
    <symbol id="i-budget" viewBox="0 0 24 24"><rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M8.5 9h7M8.5 13h7M8.5 17h4"/></symbol>
    <symbol id="i-inv" viewBox="0 0 24 24"><path d="M3.5 17l5.5-5.5 4 4 7.5-8"/><path d="M15 7.5h5.5V13"/></symbol>
    <symbol id="i-subs" viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5"/><path d="M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.7L4 15.5"/><path d="M4 20v-4.5h4.5"/></symbol>
    <symbol id="i-more" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/></symbol>
    <symbol id="i-chevron" viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6"/></symbol>
    <symbol id="i-theme" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></symbol>
    <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></symbol>
    <symbol id="i-phone" viewBox="0 0 24 24"><rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10.5 18.5h3"/></symbol>
  </defs>
</svg>
```

- [ ] **Step 2: Нова розмітка каркаса**

Замінити від `<div class="wrap">` через `<header class="top">…</header>` і `<nav class="tabs glass" id="tabs">…</nav>` на:

```html
<div class="shell" id="shell">
<aside class="side" id="side">
  <div class="brand"><span class="logo">₴</span><span class="brand-t nl">Гроші</span></div>
  <nav class="tabs" id="tabs" aria-label="Розділи">
    <span class="tab-ind" id="tabInd" aria-hidden="true"></span>
    <button data-tab="overview" aria-current="true" data-tip="Огляд" data-key="1"><svg class="ic" width="20" height="20"><use href="#i-overview"/></svg><span class="nl">Огляд</span></button>
    <button data-tab="cats" data-tip="Категорії" data-key="2"><svg class="ic" width="20" height="20"><use href="#i-cats"/></svg><span class="nl">Категорії</span></button>
    <button data-tab="tx" data-tip="Операції" data-key="3"><svg class="ic" width="20" height="20"><use href="#i-tx"/></svg><span class="nl">Операції</span></button>
    <button data-tab="budget" data-tip="Кошториси" data-key="4"><svg class="ic" width="20" height="20"><use href="#i-budget"/></svg><span class="nl">Кошториси</span></button>
    <button data-tab="inv" data-tip="Інвестиції" data-key="5"><svg class="ic" width="20" height="20"><use href="#i-inv"/></svg><span class="nl">Інвестиції</span></button>
    <button data-tab="subs" data-tip="Підписки" data-key="6"><svg class="ic" width="20" height="20"><use href="#i-subs"/></svg><span class="nl">Підписки</span></button>
    <button data-tab="settings" data-tip="Ще" data-key="7"><svg class="ic" width="20" height="20"><use href="#i-more"/></svg><span class="nl">Ще</span></button>
  </nav>
  <div class="side-foot">
    <button class="iconbtn" id="phoneBtn" data-tip="Перегляд на телефоні" data-key="P" hidden><svg class="ic" width="18" height="18"><use href="#i-phone"/></svg></button>
    <button class="iconbtn" id="scrnBtn" data-tip="Режим скріншоту: сховати всі суми (S)" data-key="S"><svg class="ic" width="18" height="18"><use href="#i-eye"/></svg></button>
    <button class="iconbtn" id="themeBtn" data-tip="Світла / темна тема" data-key="T"><svg class="ic" width="18" height="18"><use href="#i-theme"/></svg></button>
    <button class="iconbtn" id="navToggle" data-tip="Звузити панель" data-key="["><svg class="ic" width="18" height="18"><use href="#i-chevron"/></svg></button>
  </div>
</aside>
<div class="wrap">
```

Знайти кінець старого `.wrap` (закриття `</div>` перед тим, де було `<canvas id="glowcv">`, тепер перед `<div id="sdp" hidden>`) і додати після нього `</div><!-- /shell -->`.

Скрипт `scrnBtn` пише в `textContent`/`innerHTML` кнопки? Перевірити: `sed -n '9070,9095p' app/app.template.html` (функція `scrnToggle`, рядки ≈9076): якщо вона перезаписує `b.textContent='👁'`/`…`, замінити цей рядок на перемикання `b.classList.toggle('on', SCRN)` — інакше SVG-іконка знищується.

Якір десктопа `id="phoneBtn" data-tip="Перегляд на телефоні" data-key="P" hidden` у `build_desktop.py:125` більше не збігається з розміткою — оновити `sub(...)` під новий текст кнопки (`<button class="iconbtn" id="phoneBtn" data-tip="Перегляд на телефоні" data-key="P" hidden>`), зберігши його призначення.

- [ ] **Step 3: CSS каркаса**

Видалити старі правила навігації й шапки: `header.top`, `.hactions`, `.brand…` (≈631–638), `nav.tabs{position:fixed…}` з усіма `nav.tabs button…` (≈855–867), `@media(min-width:760px){ … }` блок із `nav.tabs…` (≈1064–1075; правило `.wrap{padding:24px}` і `body{padding-bottom:0}` перенести в Задачу 5, поки залишити лише їх у цьому медіа), `nav.tabs button[data-badge]…` (≈1115–1118), `@media(max-width:759px){ … nav.tabs button{font-size:9px…} }` (лише рядок із `nav.tabs`), `nav.tabs:active{transform:none}`, а також правила `nav.tabs{background:…}` і `nav.tabs button[aria-current…]` із плоскої бази Кроку 7 Задачі 2. Додати в кінець `<style>`:

```css
/* ══════════════════ КАРКАС: бічна панель ══════════════════
   Панель окремою колонкою замість верхньої пігулки: сім розділів у ряд
   не вміщались у вузьке вікно й стрибали при зміні ширини. */
.shell{display:grid;grid-template-columns:var(--nav-w) minmax(0,1fr);min-height:100vh;
  transition:grid-template-columns var(--dur) var(--ease)}
.shell.collapsed{grid-template-columns:var(--nav-w-collapsed) minmax(0,1fr)}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:20px;
  padding:18px 12px;background:var(--surface);border-right:1px solid var(--border);overflow:hidden}
.brand{display:flex;align-items:center;gap:10px;padding:0 6px;min-height:40px;
  font-weight:600;font-size:var(--fs-lg);letter-spacing:-.01em;white-space:nowrap}
.brand .logo{width:36px;height:36px;flex:none;border-radius:12px;background:var(--accent);
  color:var(--accent-contrast);display:grid;place-items:center;font-weight:700}
nav.tabs{position:relative;display:flex;flex-direction:column;gap:2px;flex:1;min-height:0}
nav.tabs button{position:relative;z-index:1;display:flex;align-items:center;gap:12px;
  height:var(--ctl);padding:0 12px;border-radius:var(--radius-sm);color:var(--text-dim);
  font-size:var(--fs-md);font-weight:500;text-align:left;white-space:nowrap;
  transition:color var(--dur) var(--ease),background var(--dur) var(--ease)}
nav.tabs button:hover{color:var(--text);background:var(--surface-2)}
nav.tabs button[aria-current="true"]{color:var(--text);font-weight:600;background:none}
nav.tabs button[aria-current="true"] .ic{color:var(--accent-ink)}
nav.tabs button[data-tab="settings"]{margin-top:auto}
.ic{flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.tab-ind,.chip-ind{position:absolute;z-index:0;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;
  background:var(--surface-3);border-radius:var(--radius-sm);
  transition:transform var(--dur) var(--ease),width var(--dur) var(--ease),height var(--dur) var(--ease),opacity var(--dur)}
.tab-ind.ready,.chip-ind.ready{opacity:1}
nav.tabs button[data-badge]:not([data-badge=""])::after{
  content:attr(data-badge);position:absolute;right:10px;top:50%;transform:translateY(-50%);
  min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--warn);color:#151515;
  font-size:var(--fs-xs);font-weight:700;line-height:18px;text-align:center}
.side-foot{display:flex;flex-wrap:wrap;gap:4px;padding:0 2px}
#navToggle .ic{transition:transform var(--dur) var(--ease)}
.shell.collapsed #navToggle .ic{transform:rotate(180deg)}
.shell.collapsed .side{padding-inline:10px}
.shell.collapsed .nl{display:none}
.shell.collapsed nav.tabs button{justify-content:center;padding:0}
.shell.collapsed nav.tabs button[data-badge]:not([data-badge=""])::after{
  right:6px;top:4px;transform:none;min-width:14px;height:14px;line-height:14px;padding:0 3px;font-size:10px}
.shell.collapsed .side-foot{flex-direction:column;align-items:center}
.shell.collapsed .brand{justify-content:center;padding:0}
```

- [ ] **Step 4: JS панелі й індикатора**

Замінити функцію `slideInd` на:

```js
function slideInd(host, ind, act, both){
  if(!act) return;
  const h = host.getBoundingClientRect(), b = act.getBoundingClientRect();
  ind.style.width  = b.width + 'px';
  ind.style.height = b.height + 'px';
  // Бічна панель рухає індикатор по обох осях, рядок періодів — лише по X
  // (його `top` задає CSS): інакше висота рядка додавалась би двічі.
  const y = both ? (b.top - h.top + host.scrollTop) : 0;
  ind.style.transform = `translate(${b.left - h.left + host.scrollLeft}px,${y}px)`;
  requestAnimationFrame(()=>ind.classList.add('ready'));
}
```
У `moveTabIndicator` змінити перший виклик на `slideInd(nav, el('tabInd'), nav.querySelector('button[aria-current="true"]'), true);`. Для `.chip-ind` до цього CSS був `top:2px` — тепер у спільному правилі `top:0`: у блок `.chip-ind{…}` (≈651) прибрати власні `top`, `height`, `border-radius`, `position`, `z-index`, `left`, `width`, `opacity`, `transition` (їх дає спільне правило), лишивши лише коментар про миттєве перемикання; висоту задасть `slideInd` з розміру чипа.

Додати після функції `moveTabIndicator`:

```js
/* Стан панелі: звужена вручну (≥1000 px) або автоматично (<1000 px).
   Зберігається через store, як решта налаштувань. */
const shellEl = el('shell');
function applyShell(){
  const forced = matchMedia('(max-width:999px)').matches;
  shellEl.classList.toggle('collapsed', forced || !!store.get('navCollapsed', false));
  el('navToggle').hidden = forced;
  el('navToggle').dataset.tip = shellEl.classList.contains('collapsed') ? 'Розгорнути панель' : 'Звузити панель';
  requestAnimationFrame(moveTabIndicator);
}
el('navToggle').onclick = ()=>{ store.set('navCollapsed', !store.get('navCollapsed', false)); applyShell(); };
addEventListener('resize', applyShell);
applyShell();
```
Клавіша `[` для звуження: у `keydown` біля `T`/`P` додати `if(k==='['){ const b=el('navToggle'); if(!b.hidden) b.click(); return; }`.

Індикатор слід переміщувати й після завершення переходу ширини: у `applyShell` додати `shellEl.addEventListener('transitionend', moveTabIndicator, {once:true})` перед `requestAnimationFrame`.

- [ ] **Step 5: Збірки й візуальна перевірка**

Run: `python app/build_app.py && python desktop/build_desktop.py && node tests/allcheck.mjs && node tests/scrn.mjs`
Expected: без помилок; `scrn.mjs` проходить (кнопка `scrnBtn` має клас `on`/бейдж як раніше).

Run: `python app/build_app.py --data .test-artifacts/synthetic.json --out .test-artifacts/synthetic_app.html && node tests/snap.mjs t3`
Read `snap-t3/dark-1400-overview.png`: ліворуч панель 220 px з підписами, активний пункт підсвічений, лайм лише на його іконці; `dark-900-tx.png`: панель 64 px іконки; (нижня панель ще стара на 390 px — Задача 4).

- [ ] **Step 6: Commit**

```bash
git add app/app.template.html desktop/build_desktop.py
git commit -m "Каркас: бічна панель з іконками, звуження, SVG-спрайт" -m "Co-Authored-By: Claude Sonnet 5.5 <адреса з атрибуції сесії>"
```

---

### Task 4: Нижні таби, меню «Ще» і проба навігації

**Files:**
- Modify: `app/app.template.html`
- Create: `tests/nav.mjs`
- Modify: `package.json`, `tests/README.md`, `docs/superpowers/specs/2026-10-15-ui-redesign-design.md`

**Interfaces:**
- Consumes: розмітка й `applyShell()` Задачі 3.
- Produces: `NARROW` (MediaQueryList `(max-width:759px)`), `markTabs()` (виставляє `aria-current`), `moreMenu()` (Promise через `uiPick`).

- [ ] **Step 1: Проба навігації (спершу падає)**

Створити `tests/nav.mjs`:

```js
// Каркас: розкладки на межах ширини, клавіші, меню «Ще», звуження панелі.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'app/Groshi_app.html')).href;
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const errors = [];
async function open(width, height = 800) {
  const ctx = await browser.newContext({viewport: {width, height}});
  await ctx.addInitScript(() => localStorage.setItem('wizDone', 'true'));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => typeof window.go === 'function');
  await page.waitForTimeout(300);
  return {ctx, page};
}
const layout = page => page.evaluate(() => {
  const vis = n => !!n && n.offsetParent !== null && getComputedStyle(n).visibility !== 'hidden';
  const btns = [...document.querySelectorAll('#tabs button')].filter(vis).map(b => b.dataset.tab);
  const side = document.getElementById('side').getBoundingClientRect();
  const nav = document.getElementById('tabs').getBoundingClientRect();
  return {btns, sideW: Math.round(side.width), navBottom: Math.round(nav.bottom), vh: innerHeight,
    labels: [...document.querySelectorAll('#tabs .nl')].some(vis),
    navFixed: getComputedStyle(document.getElementById('tabs')).position === 'fixed',
    hscroll: document.documentElement.scrollWidth > innerWidth};
});
try {
  // межі: 759 нижні таби, 760 і 999 іконкова панель, 1000 повна
  const cases = [
    [759, {n: 5, fixed: true}], [760, {n: 7, w: 64, labels: false}],
    [999, {n: 7, w: 64, labels: false}], [1000, {n: 7, w: 220, labels: true}],
    [1400, {n: 7, w: 220, labels: true}],
  ];
  for (const [w, exp] of cases) {
    const {ctx, page} = await open(w);
    const l = await layout(page);
    assert.equal(l.btns.length, exp.n, `${w}px: видимих пунктів ${l.btns.length}, очікувано ${exp.n}`);
    if (exp.fixed) {
      assert.ok(l.navFixed, `${w}px: нижня панель не fixed`);
      assert.ok(Math.abs(l.navBottom - l.vh) <= 1, `${w}px: панель не прилягає до низу`);
      assert.deepEqual(l.btns, ['overview', 'tx', 'inv', 'subs', 'settings'], `${w}px: склад нижньої панелі`);
    } else {
      assert.ok(!l.navFixed, `${w}px: панель мусить бути в потоці`);
      assert.ok(Math.abs(l.sideW - exp.w) <= 2, `${w}px: ширина панелі ${l.sideW}, очікувано ${exp.w}`);
      assert.equal(l.labels, exp.labels, `${w}px: підписи ${l.labels}`);
    }
    assert.ok(!l.hscroll, `${w}px: горизонтальний скрол сторінки`);
    await ctx.close();
  }

  // індикатор повторює активний пункт (десктоп)
  { const {ctx, page} = await open(1400);
    for (const tab of ['overview', 'tx', 'settings']) {
      await page.evaluate(t => go(t), tab); await page.waitForTimeout(500);
      const d = await page.evaluate(() => {
        const a = document.querySelector('#tabs button[aria-current="true"]').getBoundingClientRect();
        const i = document.getElementById('tabInd').getBoundingClientRect();
        return {dy: Math.abs(a.top - i.top), dh: Math.abs(a.height - i.height)};
      });
      assert.ok(d.dy <= 1 && d.dh <= 1, `індикатор поза активним пунктом (${tab}): ${JSON.stringify(d)}`);
    }
    // клавіші 1–7
    await page.keyboard.press('3'); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => S.tab), 'tx', 'клавіша 3 → Операції');
    // звуження зберігається після перезавантаження
    await page.click('#navToggle'); await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => shellEl.classList.contains('collapsed')), 'панель не звузилась');
    await page.reload(); await page.waitForFunction(() => typeof window.go === 'function');
    assert.ok(await page.evaluate(() => shellEl.classList.contains('collapsed')), 'стан звуження не збережено');
    await ctx.close(); }

  // бейдж «Підписки» видно в усіх розкладках
  for (const w of [1400, 900, 390]) {
    const {ctx, page} = await open(w);
    await page.evaluate(() => { el('tabs').querySelector('[data-tab="subs"]').dataset.badge = '3'; });
    const shown = await page.evaluate(() => {
      const b = document.querySelector('#tabs [data-tab="subs"]');
      const c = getComputedStyle(b, '::after');
      return {content: c.content, display: c.display};
    });
    assert.ok(/3/.test(shown.content) && shown.display !== 'none', `${w}px: бейдж не видно (${JSON.stringify(shown)})`);
    await ctx.close();
  }

  // 390: меню «Ще», підсвітка «Ще» для прихованих розділів, Esc
  { const {ctx, page} = await open(390, 844);
    await page.click('#tabs [data-tab="settings"]'); await page.waitForTimeout(300);
    const rows = await page.evaluate(() => [...document.querySelectorAll('#modal .pickrow')].map(r => r.dataset.v));
    assert.deepEqual(rows, ['cats', 'budget', 'settings', 'theme', 'scrn'], 'склад меню «Ще»');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => document.getElementById('modal').hidden), 'Esc не закрив меню «Ще»');
    await page.click('#tabs [data-tab="settings"]'); await page.waitForTimeout(300);
    await page.click('#modal .pickrow[data-v="cats"]'); await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => S.tab), 'cats', 'вибір «Категорії» не відкрив екран');
    assert.equal(await page.evaluate(() => document.querySelector('#tabs [data-tab="settings"]').getAttribute('aria-current')),
      'true', 'у нижній панелі «Ще» не підсвічено для Категорій');
    // клавіша 2 з клавіатури теж підсвічує «Ще»
    await page.evaluate(() => go('tx')); await page.keyboard.press('4'); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.querySelector('#tabs [data-tab="settings"]').getAttribute('aria-current')),
      'true', 'клавіша 4 не підсвітила «Ще»');
    await ctx.close(); }

  assert.deepEqual(errors, [], 'помилки JavaScript: ' + errors.join(' | '));
  console.log('навігація: межі 759/760/999/1000, клавіші, «Ще», звуження — OK');
} finally { await browser.close(); }
```

Run: `node tests/nav.mjs`
Expected: FAIL на `759px: видимих пунктів 7, очікувано 5`.

- [ ] **Step 2: CSS нижньої панелі**

У кінець `<style>` додати:

```css
/* ══════════════════ КАРКАС: нижні таби (<760 px) ══════════════════
   Дві розкладки діють за ОДНИМ медіа-запитом: ширина 759/760 — єдина
   межа, тож двох навігацій одночасно не буває. Категорії й Кошториси
   сховані: вони відкриваються з меню «Ще» (5 слотів — стеля читабельності
   на 360 px). */
@media (max-width:759px){
  .shell{display:block}
  .side{position:static;height:auto;padding:0;border:0;background:none;overflow:visible}
  .side .brand,.side .side-foot{display:none}
  nav.tabs{position:fixed;left:0;right:0;bottom:0;z-index:40;flex-direction:row;gap:0;
    padding:6px 4px calc(env(safe-area-inset-bottom) + var(--fake-safe-bottom,0px) + 6px);
    min-height:calc(var(--tabbar-h) + env(safe-area-inset-bottom) + var(--fake-safe-bottom,0px));
    background:var(--surface);border-top:1px solid var(--border)}
  nav.tabs button{flex:1;min-width:0;flex-direction:column;justify-content:center;gap:3px;
    height:auto;padding:4px 2px;font-size:var(--fs-xs);font-weight:600}
  nav.tabs button .nl{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis}
  nav.tabs button[data-tab="cats"],nav.tabs button[data-tab="budget"]{display:none}
  nav.tabs button[data-tab="settings"]{margin-top:0}
  nav.tabs button[aria-current="true"],nav.tabs button:hover{background:none}
  nav.tabs button[aria-current="true"] .ic{color:var(--accent-ink)}
  .tab-ind{display:none}
  nav.tabs button[data-badge]:not([data-badge=""])::after{
    right:calc(50% - 22px);top:2px;transform:none;min-width:14px;height:14px;line-height:14px;
    padding:0 3px;font-size:10px}
}
```
Правило `.shell.collapsed .nl{display:none}` має спрацьовувати лише ≥760 px: у `applyShell` умова `forced` для `<760` теж дає `collapsed` — тому в нижній панелі підписи сховало б. Виправити: у JS `applyShell` не додавати `collapsed` у вузькому режимі: `shellEl.classList.toggle('collapsed', !NARROW.matches && (forced || !!store.get('navCollapsed', false)));`.

- [ ] **Step 3: JS меню «Ще» і підсвітки**

Перед функцією `go` (≈8707) додати:

```js
/* У нижній панелі лише п'ять слотів, тому Категорії, Кошториси й
   налаштування живуть за «Ще». Тема й режим скріншоту там же: у вузькому
   вікні панелі з кнопками немає, а на телефоні їх не було б ніде. */
const NARROW = matchMedia('(max-width:759px)');
const MORE = new Set(['cats', 'budget', 'settings']);
function markTabs(){
  el('tabs').querySelectorAll('button').forEach(b=>b.setAttribute('aria-current',
    b.dataset.tab===S.tab || (NARROW.matches && b.dataset.tab==='settings' && MORE.has(S.tab))));
}
async function moreMenu(){
  const v = await uiPick({title:'Ще', options:[
    {v:'cats', n:'Категорії'}, {v:'budget', n:'Кошториси'}, {v:'settings', n:'Налаштування'},
    {v:'theme', n:'Тема: світла / темна'}, {v:'scrn', n:'Режим скріншоту'}]});
  if(!v) return;
  if(v==='theme') el('themeBtn').click();
  else if(v==='scrn') scrnToggle();
  else go(v);
}
```
Рядок `el('tabs').querySelectorAll('button').forEach(b=>b.setAttribute('aria-current', b.dataset.tab===S.tab));` (≈8650) замінити на `markTabs();`. Обробник кліків (≈8751) замінити на:

```js
el('tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{
  if(NARROW.matches && b.dataset.tab==='settings') return moreMenu();
  go(b.dataset.tab);
});
NARROW.addEventListener('change', ()=>{ applyShell(); markTabs(); });
```
(`NARROW` оголошено до `applyShell`? `applyShell` стоїть у розділі індикатора пізніше за `go` — порядок виконання скрипта зверху вниз: `NARROW` оголошений раніше, `applyShell` викликається пізніше; ок. Якщо `applyShell` оголошено вище за `NARROW` — перенести оголошення `NARROW` на початок розділу WIRING.)

Рядок `uiPick` повертає `data-v` кнопки; перевірити, що в `uiAsk` кнопки списку мають клас `pickrow` і `data-v` (`sed -n '6430,6445p' app/app.template.html`); якщо клас називається інакше — підставити реальний у `tests/nav.mjs`.

- [ ] **Step 4: Збірки й проба**

Run: `python app/build_app.py && python desktop/build_desktop.py && node tests/nav.mjs`
Expected: `навігація: межі 759/760/999/1000, клавіші, «Ще», звуження — OK`. Якщо падає на порядку/складі — читати повідомлення, виправляти CSS/JS (не послаблювати проби).

- [ ] **Step 5: Повний набір і знімки**

Run: `npm test` (додати `&& node tests/nav.mjs` у `package.json` після `contrast.mjs`) і `python app/build_app.py --data .test-artifacts/synthetic.json --out .test-artifacts/synthetic_app.html && node tests/snap.mjs t4`.
Read `snap-t4/dark-390-overview.png` і `light-390-tx.png`: нижня панель з п'яти пунктів, активний з лаймовою іконкою; контент не ховається за панеллю (відступи доробляє Задача 5).

- [ ] **Step 6: Документація й спека**

У спеці §5 замінити фразу про «індикатор … горизонтальний унизу» на: «У нижніх табах активний пункт позначається кольором іконки й підпису, без рухомої пігулки: на п'яти слотах пігулка не додає ясності, а коштує перерахунку позиції при повороті екрана». У `tests/README.md` додати рядок для `nav.mjs`:

```markdown
| `nav.mjs` | каркас: межі 759/760/999/1000 px, склад нижньої панелі, індикатор, клавіші 1–7, бейдж, меню «Ще», збереження звуження панелі | `npm test` |
```
У `docs/РОЗРОБКА.md` додати розділ «Навігація: бічна панель і нижні таби» (3–5 абзаців: чому панель замість пігулки; чому 5 слотів і «Ще»; чому звуження зберігається через `store`; чому одна межа 759/760) і оновити дату.

- [ ] **Step 7: Commit**

```bash
git add app/app.template.html tests/nav.mjs package.json tests/README.md docs/superpowers/specs/2026-10-15-ui-redesign-design.md docs/РОЗРОБКА.md
git commit -m "Нижні таби, меню «Ще», проба навігації" -m "Co-Authored-By: Claude Sonnet 5.5 <адреса з атрибуції сесії>"
```

---

### Task 5: Сегмент періодів і контентна область

**Files:**
- Modify: `app/app.template.html`

**Interfaces:**
- Consumes: каркас Задач 3–4, `slideInd(…)` для `#periods` (лише X).
- Produces: `.periodbar` як iOS-сегмент; `.wrap` з новими відступами; відступ під нижньою панеллю.

- [ ] **Step 1: CSS**

Видалити `body{…padding:calc(env(safe-area-inset-top)…+ 96px)…}` відступи тіла (залишити лише `overscroll-behavior-y:contain`) і правило `.wrap{max-width:1180px;margin:0 auto;padding:14px}` та `@media(min-width:760px){ .wrap{padding:24px} body{padding-bottom:0} }`. Додати в кінець `<style>`:

```css
/* ══════════════════ Контентна область і період ══════════════════ */
body{overscroll-behavior-y:contain}
.wrap{max-width:1040px;margin:0 auto;padding:28px 32px 48px;min-width:0;
  display:flex;flex-direction:column;gap:18px}
@media (max-width:759px){
  .wrap{padding:calc(env(safe-area-inset-top) + var(--fake-safe-top,0px) + 16px) 16px
    calc(var(--tabbar-h) + env(safe-area-inset-bottom) + var(--fake-safe-bottom,0px) + 24px);gap:14px}
}
.periodbar{position:relative;display:flex;gap:2px;width:max-content;max-width:100%;overflow-x:auto;
  padding:3px;margin:0;background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius-pill);scrollbar-width:none}
.periodbar .chip{position:relative;z-index:1;height:32px}
.periodbar .chip[aria-pressed="true"]{background:none}
.chip-ind{top:3px;border-radius:var(--radius-pill)}
```
(`.chip-ind` явно задає `top:3px`, бо рух лише по X.)

- [ ] **Step 2: Збірки, проби, знімки**

Run: `python app/build_app.py && python desktop/build_desktop.py && node tests/nav.mjs && node tests/period.mjs && node tests/notrans.mjs && node tests/gaps.mjs`
Expected: усе зелене. Якщо `gaps.mjs` падає на «злиплих карток» через `gap:18px` у `.wrap` — картки всередині секцій мають власні відступи; діагностика через друк `tight` у проби, виправляти відступи, а не поріг.

Run: `python app/build_app.py --data .test-artifacts/synthetic.json --out .test-artifacts/synthetic_app.html && node tests/snap.mjs t5` і прочитати `snap-t5/dark-1400-tx.png`, `light-390-overview.png`: період — сегмент із пігулкою, контент не ховається за нижньою панеллю.

- [ ] **Step 3: Commit**

```bash
git add app/app.template.html
git commit -m "Сегмент періодів і контентна область під нову панель" -m "Co-Authored-By: Claude Sonnet 5.5 <адреса з атрибуції сесії>"
```

---

### Task 6a: Компоненти: кнопки, картки, чипи, форми, таблиці, чекбокс

**Files:**
- Modify: `app/app.template.html`
- Create: `tests/nostripe.mjs`, `tests/overflow.mjs`
- Modify: `package.json`, `tests/README.md`

**Interfaces:**
- Consumes: плоска база й токени.
- Produces: словник класів, що ним користуються екрани (Задачі 7–12): `.stack` (колонка з проміжком 12), `.cluster` (ряд із перенесенням, проміжок 8), `.grow`, `.muted`, `.lbl` (мітка 11 px, верхній регістр, `--text-mute`), `.num-lg` (суми 40 px), `.num-md` (суми 22 px), `.dot` (кружок кольору категорії 10 px; колір через `style="background:…"` — **єдиний** дозволений динамічний інлайн-стиль), `.badge-ico` (коло 32 px під іконку категорії), `.tag` (чип-мітка), `.btn.sm`, `.btn.ghost`, `.btn.danger`, `.card.flat` (картка без межі, для вкладених), `.kpi` (плитка показника: `.lbl` + `.num-lg` + `.sub`), `.row` (рядок списку з роздільником `--border-soft`), таблиця `.tablewrap table` у плоскому стилі.

- [ ] **Step 1: Проби стражі (спершу падають на старому)**

Створити `tests/nostripe.mjs`:

```js
// Правило проєкту: жодних кольорових смуг збоку карток, рядків і панелей.
// Для кожного видимого елемента порівнюємо ліву межу з іншими: товста й
// інакше забарвлена ліва межа — це смуга.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.SNAP_FILE || path.join(root, '.test-artifacts', 'synthetic_app.html');
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const bad = [];
try {
  const ctx = await browser.newContext({viewport: {width: 1400, height: 900}});
  await ctx.addInitScript(() => localStorage.setItem('wizDone', 'true'));
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => typeof window.go === 'function');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    for (const tab of ['overview', 'cats', 'tx', 'budget', 'inv', 'subs', 'settings']) {
      await page.evaluate(t => go(t), tab); await page.waitForTimeout(400);
      const hits = await page.evaluate(() => {
        const out = [];
        for (const n of document.querySelectorAll('section:not([hidden]) *, #side *')) {
          if (n.offsetParent === null) continue;
          const c = getComputedStyle(n);
          const lw = parseFloat(c.borderLeftWidth), rw = parseFloat(c.borderRightWidth);
          const stripe = lw >= 2 && c.borderLeftStyle !== 'none' && c.borderLeftColor !== c.borderRightColor
            && c.borderLeftColor !== 'rgba(0, 0, 0, 0)' && rw < lw;
          // inset-тінь без розмиття зі зсувом по X — друга форма смуги
          const inset = /inset\s+-?[1-9]\d*px\s+0px\s+0px/.test(c.boxShadow);
          if (stripe || inset) out.push((n.className || n.tagName).toString().slice(0, 40));
        }
        return out;
      });
      for (const h of hits) bad.push(`${theme}/${tab}: ${h}`);
    }
  }
  assert.deepEqual([...new Set(bad)], [], 'кольорові бічні смуги:\n' + [...new Set(bad)].join('\n'));
  console.log('бічних смуг немає — OK');
} finally { await browser.close(); }
```

Створити `tests/overflow.mjs`:

```js
// 390 px: горизонтального скролу сторінки немає, великі суми не виходять
// за картку, «Інвестиції» вміщується в слот нижньої панелі.
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
    for (const tab of ['overview', 'cats', 'tx', 'budget', 'inv', 'subs', 'settings']) {
      await page.evaluate(t => go(t), tab); await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const h = document.documentElement.scrollWidth > innerWidth;
        const clipped = [...document.querySelectorAll('section:not([hidden]) .card, section:not([hidden]) .det')]
          .filter(c => c.offsetParent !== null)
          .flatMap(c => [...c.querySelectorAll('.num-lg,.num-md,.kpi .val,.amt')]
            .filter(n => n.offsetParent !== null && n.scrollWidth > c.clientWidth + 1)
            .map(n => n.className));
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
  assert.deepEqual(problems, [], 'переповнення на 390 px:\n' + problems.join('\n'));
  console.log('390 px: переповнень немає — OK');
} finally { await browser.close(); }
```
Run обох: `python app/build_app.py --data .test-artifacts/synthetic.json --out .test-artifacts/synthetic_app.html && node tests/nostripe.mjs; node tests/overflow.mjs`
Expected: імовірно FAIL на старих смугах/сумах (фіксується початкова картина). Це базова лінія для Задач 7–12.

- [ ] **Step 2: Словник компонентів**

Видалити з шаблону плоску базу зі Задачі 2 (розділ «ДИЗАЙН-СИСТЕМА: плоска база») і старі правила `.btn`, `.chip`, `.iconbtn`, `.card`, `.det`, `.cardhead`, `.kpi`, `.tag`, `.fieldrow`, `table` (кожне знайти за `grep -n "^\.btn\|^\.chip\|^\.card\|^\.kpi\|^\.tag\|^\.cardhead\|^\.fieldrow\|^table\|^th\b\|^td\b" app/app.template.html` і перенести потрібні розміри в новий блок). Додати в кінець `<style>`:

```css
/* ══════════════════ КОМПОНЕНТИ ══════════════════
   Поверхня — різниця тону + тонка межа; жодних кольорових смуг і
   тонування картки. Колір категорії лише в .dot / .badge-ico / .tag. */
body{background:var(--bg);color:var(--text);font:var(--fs-md)/1.5 var(--font-ui);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,h3{margin:0;font-family:var(--font-display);font-weight:600;letter-spacing:-.01em}
.card,.det{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:20px 22px}
.det{border-radius:var(--radius-lg)}
.card.flat{background:var(--surface-2);border-color:transparent;padding:14px 16px}
.cardhead{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.cardhead h2{font-size:var(--fs-lg);font-weight:600}
.hint,.muted{color:var(--text-mute)}
.lbl{font-size:var(--fs-xs);letter-spacing:.08em;text-transform:uppercase;color:var(--text-mute)}
.num-lg{font-size:var(--fs-3xl);font-weight:600;letter-spacing:-.03em;line-height:1.1;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.num-md{font-size:var(--fs-xl);font-weight:600;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.stack{display:flex;flex-direction:column;gap:12px}
.cluster{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.grow{flex:1;min-width:0}
.kpi{display:flex;flex-direction:column;gap:6px;padding:18px 20px;background:var(--surface);
  border:1px solid var(--border);border-radius:var(--radius)}
.kpi .val{font-size:var(--fs-2xl);font-weight:600;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.kpi .sub{font-size:var(--fs-sm);color:var(--text-mute)}
.dot{width:10px;height:10px;border-radius:50%;flex:none;display:inline-block}
.badge-ico{width:32px;height:32px;border-radius:50%;flex:none;display:grid;place-items:center;
  color:var(--accent-contrast)}
.tag{display:inline-flex;align-items:center;max-width:100%;padding:3px 10px;border-radius:var(--radius-pill);
  font-size:var(--fs-xs);font-weight:600;color:var(--text-dim);background:var(--surface-2);
  border:1px solid var(--border);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:var(--ctl);padding:0 16px;
  border-radius:var(--radius-sm);background:var(--surface-2);border:1px solid var(--border);
  color:var(--text);font-size:var(--fs-sm);font-weight:600;white-space:nowrap;
  transition:background var(--dur) var(--ease),color var(--dur) var(--ease),transform var(--dur) var(--ease)}
.btn:hover{background:var(--surface-3)}
.btn:active{transform:scale(.98)}
.btn:focus-visible,.iconbtn:focus-visible,.chip:focus-visible,nav.tabs button:focus-visible{
  outline:2px solid var(--accent-line);outline-offset:2px}
.btn.pri,button.on{background:var(--accent);border-color:transparent;color:var(--accent-contrast)}
.btn.pri:hover,button.on:hover{background:var(--accent-hover)}
.btn.sm{height:32px;padding:0 12px;font-size:var(--fs-xs)}
.btn.ghost{background:transparent;border-color:transparent;color:var(--text-dim)}
.btn.ghost:hover{background:var(--surface-2);color:var(--text)}
.btn.danger{color:var(--danger)}
.btn[disabled],.btn.disabled{opacity:.45;pointer-events:none}
.iconbtn{width:var(--ctl);height:var(--ctl);border-radius:var(--radius-sm);display:grid;place-items:center;
  color:var(--text-dim);background:transparent}
.iconbtn:hover{color:var(--text);background:var(--surface-2)}
.iconbtn.on{background:var(--accent);color:var(--accent-contrast)}
.chip{display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:var(--radius-pill);
  font-size:var(--fs-sm);font-weight:500;color:var(--text-dim);background:transparent;white-space:nowrap}
.chip:hover{color:var(--text)}
.chip[aria-pressed="true"]{color:var(--text);font-weight:600;background:var(--surface-3)}
input,select,textarea{font:inherit;color:var(--text);background:var(--surface-2);
  border:1px solid var(--border);border-radius:var(--radius-sm);height:var(--ctl);padding:0 13px;
  transition:border-color var(--dur) var(--ease),box-shadow var(--dur) var(--ease)}
textarea{height:auto;min-height:96px;padding:10px 13px;line-height:1.5;resize:none}
input::placeholder,textarea::placeholder{color:var(--text-mute)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent-line);box-shadow:0 0 0 3px var(--accent-soft)}
.row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border-soft)}
.row:last-child{border-bottom:0}
.tablewrap table{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
.tablewrap th{font-size:var(--fs-xs);font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--text-mute);text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
.tablewrap td{padding:11px 10px;border-bottom:1px solid var(--border-soft);font-variant-numeric:tabular-nums}
.tablewrap tr:hover td{background:var(--surface-2)}
code{font-family:var(--font-mono);font-size:.92em;background:var(--surface-2);
  border:1px solid var(--border-soft);border-radius:6px;padding:1px 6px}
```
Власний checkbox (глобальне правило `appearance:none` + коробка й галочка) — перевірити, що його стилі використовують токени: `grep -n "appearance:none" app/app.template.html`; замінити кольори на `var(--surface-2)`/`var(--border)`/`var(--accent)`/`var(--accent-contrast)`, радіус `6px`, розмір 18 px.

- [ ] **Step 3: Реєстрація проб**

У `package.json` додати `&& node tests/nostripe.mjs && node tests/overflow.mjs` в кінець `scripts.test`. **Але** обидві проби читають `.test-artifacts/synthetic_app.html`: додати в `scripts` ключ `"pretest": "node tests/helpers/synthetic.mjs && python app/build_app.py --data .test-artifacts/synthetic.json --out .test-artifacts/synthetic_app.html"`. У `tests/README.md` — два рядки таблиці:

```markdown
| `nostripe.mjs` | жодних кольорових бічних смуг (`border-left`, inset-тінь) на видимих елементах 7 вкладок у двох темах | `npm test` |
| `overflow.mjs` | 390 px: без горизонтального скролу, великі суми у картці, «Інвестиції» у слоті нижньої панелі | `npm test` |
```
У `.github/workflows/build.yml` перевірити крок `npm test`: `pretest` у npm запускається автоматично; Python у CI є (крок unittest), тож додаткових змін не потрібно; переконатися `grep -n "setup-python\|npm test" .github/workflows/build.yml`.

- [ ] **Step 4: Збірки, повний набір, знімки**

Run: `python app/build_app.py && python desktop/build_desktop.py && npm test`
Expected: усе зелене, зокрема `nostripe` і `overflow`. Якщо `nostripe` знаходить смуги — це реальні `border-left`/`box-shadow:inset` у старому CSS екранів: знайти `grep -n "border-left\|inset [0-9]*px 0" app/app.template.html` і видалити (смугу замінити крапкою `.dot` або чипом); перелік хітів зберегти для екранних задач.

Run: `python app/build_app.py --data .test-artifacts/synthetic.json --out .test-artifacts/synthetic_app.html && node tests/snap.mjs t6a` і прочитати `snap-t6a/dark-1400-settings.png`, `light-390-tx.png`.

- [ ] **Step 5: Commit**

```bash
git add app/app.template.html tests/nostripe.mjs tests/overflow.mjs package.json tests/README.md
git commit -m "Компоненти: словник класів, проби смуг і переповнення" -m "Co-Authored-By: Claude Sonnet 5.5 <адреса з атрибуції сесії>"
```

---

### Task 6b: Компоненти: випадайки, календар, модалка, підказка, тост

**Files:**
- Modify: `app/app.template.html`
- Create: `tests/shell-a11y.mjs`
- Modify: `package.json`, `tests/README.md`

**Interfaces:**
- Consumes: словник Задачі 6a.
- Produces: єдиний вигляд для `.csel` і `.cselz`, `buildCombo()`-списку, `#dp`/`#sdp`, `#modal` (`.modalbd`, `#modalYes`, `.pickrow`), `#tip`/`#kbtip`, `#apptoast`, `#pjMsg`; перевірка системної теми й `prefers-reduced-motion`.

- [ ] **Step 1: Проба доступності каркаса (спершу падає)**

Створити `tests/shell-a11y.mjs`:

```js
// Системна тема без збереженого вибору, reduced-motion, фокус під модалкою.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'app/Groshi_app.html')).href;
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
try {
  // 1. системна тема: без збереженого вибору слідуємо prefers-color-scheme
  for (const [scheme, want] of [['light', 'light'], ['dark', 'dark']]) {
    const ctx = await browser.newContext({colorScheme: scheme, viewport: {width: 1200, height: 800}});
    await ctx.addInitScript(() => localStorage.setItem('wizDone', 'true'));
    const page = await ctx.newPage();
    await page.goto(url); await page.waitForFunction(() => typeof window.go === 'function');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), want,
      `системна ${scheme}: застосунок показав іншу тему`);
    await ctx.close();
  }
  // 2. reduced-motion: переходи практично миттєві
  { const ctx = await browser.newContext({reducedMotion: 'reduce', viewport: {width: 1200, height: 800}});
    await ctx.addInitScript(() => localStorage.setItem('wizDone', 'true'));
    const page = await ctx.newPage();
    await page.goto(url); await page.waitForFunction(() => typeof window.go === 'function');
    const dur = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#tabs button')).transitionDuration) * 1000);
    assert.ok(dur <= 1, `reduced-motion: перехід кнопки ${dur} мс`);
    await ctx.close(); }
  // 3. модалка накриває панель і фокус не йде на навігацію
  { const ctx = await browser.newContext({viewport: {width: 1200, height: 800}});
    await ctx.addInitScript(() => localStorage.removeItem('wizDone'));
    const page = await ctx.newPage();
    await page.goto(url); await page.waitForFunction(() => typeof window.go === 'function');
    await page.waitForTimeout(600);
    const st = await page.evaluate(() => {
      const m = document.getElementById('modal');
      if (m.hidden) return {open: false};
      const r = m.getBoundingClientRect(), nav = document.getElementById('side').getBoundingClientRect();
      const z = n => parseInt(getComputedStyle(n).zIndex) || 0;
      return {open: true, covers: r.left <= nav.left && r.right >= nav.right,
        zOk: z(m) > z(document.getElementById('side')) && z(m) > z(document.getElementById('tabs'))};
    });
    assert.ok(st.open, 'майстер першого запуску не відкрився');
    assert.ok(st.covers && st.zOk, 'модалка не накриває панель: ' + JSON.stringify(st));
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      const inNav = await page.evaluate(() => !!document.activeElement.closest('#side'));
      assert.ok(!inNav, 'Tab під модалкою потрапив у навігацію');
    }
    await ctx.close(); }
  console.log('системна тема, reduced-motion, фокус під модалкою — OK');
} finally { await browser.close(); }
```

Run: `node tests/shell-a11y.mjs`
Expected: імовірно FAIL (системна тема не застосовується або `reduced-motion` не знижує `transition-duration` — після Задачі 2 правило є, перевірити; модалка може не мати `z-index` вище панелі).

- [ ] **Step 2: Системна тема**

Рядок `document.documentElement.dataset.theme = store.get('theme','dark');` (≈8756) замінити на:

```js
/* Без збереженого вибору слідуємо системі; явний вибір (кнопка, T) перебиває її. */
document.documentElement.dataset.theme = store.get('theme',
  matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
```

- [ ] **Step 3: CSS випадайок і оверлеїв**

Знайти й перенести на токени (`grep -n "^\.csel\|^\.cselist\|^\.combo\|^\.dp\b\|^#dp\|^#sdp\|^\.modal\|^#modal\|^\.pickrow\|^#tip\|^#kbtip\|#apptoast\|\.pjmsg" app/app.template.html`): кожен список/календар/вікно отримує `background:var(--surface)`, `border:1px solid var(--border)`, `border-radius:var(--radius)`, `box-shadow:var(--shadow-pop)`; затемнення `.modalbd{background:var(--scrim)}`; пункти списків `min-height:40px`, hover `--surface-2`, вибраний пункт — `--surface-3` із галочкою; календар `DP`: комірки радіуса `var(--radius-sm)`, вибраний діапазон `--accent-soft` із краями `--accent`; модалка: `.modal{z-index:100}`, панель вікна `max-width:min(420px,calc(100vw - 32px))`, заголовок `--fs-lg`, кнопки в ряд справа. `#tip`/`#kbtip` — `var(--surface-3)`, `--shadow-pop`, `<kbd>` на `--surface-2`. `appToast` (JS, `cssText`) переписати без інлайн-кольорів: створити елемент із класом `apptoast`, стиль у CSS: `.apptoast{position:fixed;left:50%;bottom:calc(var(--tabbar-h) + 26px);transform:translateX(-50%);background:var(--surface-3);color:var(--text);padding:9px 16px;border-radius:var(--radius-sm);font-size:var(--fs-sm);z-index:99;opacity:0;transition:opacity .25s;pointer-events:none;max-width:80vw;box-shadow:var(--shadow-pop)}`; у JS `n.className='apptoast'` і `n.style.opacity` замінити `n.classList.toggle('on', …)` з CSS `.apptoast.on{opacity:1}`. Знизу на ≥760 px `bottom:26px` (медіа-правило).

Фокус-пастка: `uiAsk` уже перехоплює `keydown` на `document` (`stopPropagation`), але `Tab` не обмежений. Додати у `onKey` обробку: якщо `e.key==='Tab'` — циклічно переводити фокус між `#modal` елементами, що фокусуються (`querySelectorAll('button,input,select,textarea,[tabindex]:not([tabindex="-1"])')` у `#modal`, відфільтрувати `offsetParent===null`). Додатково на відкритті модалки виставити `inert` на `#side` і `.wrap`, на закритті зняти: `el('side').inert = el('shell').querySelector('.wrap').inert = true/false`. (Якщо `inert` вже використовується — не дублювати: `grep -n "inert" app/app.template.html`.)

- [ ] **Step 4: Збірки, проби, знімки**

Run: `python app/build_app.py && python desktop/build_desktop.py && node tests/shell-a11y.mjs && node tests/modal.mjs && node tests/pjjump.mjs && node tests/nav.mjs`
Expected: `shell-a11y` зелений; `modal.mjs` (0 нативних діалогів, 0 `title`) зелений.

Додати `&& node tests/shell-a11y.mjs` у `package.json` і рядок у `tests/README.md`:

```markdown
| `shell-a11y.mjs` | системна тема без збереженого вибору, `prefers-reduced-motion`, модалка накриває панель, `Tab` під модалкою не йде в навігацію | `npm test` |
```
Знімки: відкрити модалку привітання (без `wizDone`), список `.csel`, календар `DP`; зберегти 6 знімків вручну скриптом на місці або Playwright MCP, прочитати: пункти, тіні, межі однакові в обох темах.

- [ ] **Step 5: Commit**

```bash
git add app/app.template.html tests/shell-a11y.mjs package.json tests/README.md
git commit -m "Компоненти: випадайки, календар, модалка, підказка, системна тема" -m "Co-Authored-By: Claude Sonnet 5.5 <адреса з атрибуції сесії>"
```

---

## Спільна процедура екрана (Задачі 7–12)

Кожна екранна задача виконує ці кроки по черзі для **своєї** ділянки шаблону. Ділянку задає задача: HTML-секція `#tab-<id>`, функції рендера й діапазони рядків (шукати за маркерами-коментарями, номери орієнтовні).

**P1. Фіксація «до».** Скласти штучний набір (`python app/build_app.py --data .test-artifacts/synthetic.json --out .test-artifacts/synthetic_app.html`), `node tests/snap.mjs before-<екран>`. Порахувати інлайн-стилі ділянки: `sed -n '<A>,<B>p' app/app.template.html | grep -o 'style="' | wc -l` — число A₀ записати в повідомлення коміту.

**P2. Прибрати інлайн-стилі.** Замінити `style="…"` класами зі словника Задачі 6a (`.stack .cluster .grow .lbl .num-lg .num-md .dot .badge-ico .tag .btn.sm .btn.ghost .card.flat .kpi .row`) або новими класами, названими за роллю (`.ovsec`, `.kpis`), які додаються в CSS-блок «ЕКРАНИ» наприкінці `<style>`. Лишити інлайн лише для справді динамічних значень (ширина смуги прогресу у %, колір `.dot`/`.badge-ico` категорії) з коментарем «чому». Умова: після ділянки інлайн-стилів ≤ 20 % від A₀ і кожен лишений — динамічний.

**P3. Якорі десктопа.** `python desktop/build_desktop.py`: помилка «якір … знайдено N разів» означає, що правка зачепила рядок, який десктопна збірка знаходить точно. Оновити якір у `desktop/build_desktop.py` на новий текст (зберігши зміст вставки) і повторити збірку.

**P4. Смуги й тонування.** `node tests/nostripe.mjs` — 0 хітів. Окремо переглянути `grep -n "background:.*color-mix\|background:.*rgba" <ділянка>` на тонування фону картки кольором категорії й прибрати: колір категорії — лише в `.dot`/`.badge-ico`/`.tag`.

**P5. Aліаси.** Для ділянки замінити використання старих імен токенів на нові: `--ink`→`--text`, `--ink-2`→`--text-dim`, `--muted`→`--text-mute`, `--surface-1`→`--surface`, `--plane`→`--bg`, `--good`→`--success`, `--crit`→`--danger`. Команда-пошук: `sed -n '<A>,<B>p' app/app.template.html | grep -n -- "--ink\|--muted\|--surface-1\|--plane\|--good\|--crit"` — після правки порожньо.

**P6. Верифікація.** Обидві збірки; `node tests/allcheck.mjs && node tests/modal.mjs && node tests/pjjump.mjs && node tests/scrn.mjs && node tests/gaps.mjs && node tests/notrans.mjs && node tests/empty.mjs && node tests/nostripe.mjs && node tests/overflow.mjs`; проба зміненої поведінки екрана (якщо є — вказана в задачі). Потім `node tests/snap.mjs after-<екран>` і Read шести знімків екрана: `dark/light × 1400/900/390`. Звірити зі спекою: плоскі картки, великі суми, колір лише в іконках і чипах, акцент лише на основній дії й активному стані, жодних зрушень при перемиканні теми. Порівняння геометрії: у `page.evaluate` до і після дії екрана (відкрити випадайку, змінити період) зняти `getBoundingClientRect()` ключових блоків і вимагати збігу ±1 px (правило «нічого не смикається»); для екранів із наявною пробою (`pjjump`, `notrans`) вона вже це робить.

**P7. Commit.** `git add app/app.template.html desktop/build_desktop.py` (+ файли проби, якщо додано) → `git commit -m "Екран «<назва>»: <що змінилось>; інлайн-стилів A₀→A₁"` + рядок співавтора.

---

### Task 7: Екран «Огляд»

**Files:** Modify: `app/app.template.html` (секція `<section id="tab-overview">` ≈1773–1850; рендер `renderOverview`/`render` для KPI, `nwCard`, `fcast`, `momCmp`, ФОП-картки; графіки — Задача 13), `desktop/build_desktop.py` (якорь `<div id="ovBalSlot"></div>`, рядок ≈130).

- [ ] **Step 1:** Виконати P1–P7 для секції `#tab-overview`.
- [ ] **Step 2: Специфіка.** Розділи «Скільки є», «Цей місяць», «Робота», «Розбір» отримують заголовки-мітки `.lbl` замість `<div class="ovsec"><h3>` (зберегти id `ovWorkSec`, `ovSync`, бо їх читає JS). Сітки карток `style="grid-template-columns:repeat(auto-fit,minmax(310px,1fr))…"` → клас `.grid-auto` (`display:grid;grid-template-columns:repeat(auto-fit,minmax(min(310px,100%),1fr));gap:12px`). KPI-плитки (`#kpis`, функція, що їх малює) — на клас `.kpi` зі словника; суми — `.num-lg` (капітал) і `.val` (KPI), без `font-family:var(--font-display)` інлайном. Блок капіталу `#nwBody`: головна цифра `.num-lg`, зміна — `.tag` із кольором `--success`/`--danger` на тексті, не на фоні картки. У режимі скріншоту (`body.scrn`) великі цифри мають лишатися замаскованими: після змін `node tests/scrn.mjs` зелений, а у знімку `dark-1400-overview.png` після `scrnToggle(true)` усі суми — крапки.
- [ ] **Step 3: Проба зміненого.** `node tests/scrn.mjs && node tests/period.mjs`; перемкнути тему кнопкою `#themeBtn` і порівняти `getBoundingClientRect` `#kpis` до/після (±1 px).

---

### Task 8: Екрани «Операції» і «Категорії»

**Files:** Modify: `app/app.template.html` (секції `#tab-tx` ≈1864–1911 і `#tab-cats` ≈1851–1863; `renderTx`, дерево категорій `.tw-nm`, фільтри `#q`, `#fCat`, `#fDir`, збережені фільтри `qfSave`, виділення `S.selMode`).

- [ ] **Step 1:** Виконати P1–P7 для двох секцій (один коміт на екран, два коміти).
- [ ] **Step 2: Специфіка.** Рядок операції — `.row` зі `.badge-ico` (іконка/літера категорії; колір — динамічний інлайн-стиль з коментарем), назва й підпис праворуч сума (`.num-md`; дохід `--success`, витрата — основний текст). Групування за датою — заголовок `.lbl` зі сумою дня. Фільтри в один рядок `.cluster`; чипи збережених фільтрів — `.chip`. Рядки дерева категорій: відступ рівня задається `padding-inline-start` (не `border-left`: у старому CSS лінії-напрямні часто були `border-left` — замінити на фон `--surface-2` для вкладеного рівня або відступ). Режим виділення: вибраний рядок — `--surface-2`, чекбокс власний.
- [ ] **Step 3: Проба зміненого.** `node tests/modal.mjs` (обхід вкладок без `title`); додатково у `page.evaluate` відкрити випадайку фільтра `fCat` і переконатись, що її список не виходить за вікно (`getBoundingClientRect().right <= innerWidth`) на 390 px.

---

### Task 9: Екран «Підписки»

**Files:** Modify: `app/app.template.html` (`#tab-subs` ≈2106–2175; `.subrow`, `.subadd`, `renderSubs`, правила ≈1093–1131).

- [ ] **Step 1:** P1–P7.
- [ ] **Step 2: Специфіка.** `.subrow` → `.row` (рядок: назва/мета ліворуч, дата й сума праворуч, дії згруповані `.cluster`); у вузькому вікні правило `@media(max-width:759px){ .subrow … }` лишається гридом (він уже коректний), лише токени. «Скоро спишеться» (`.subrow.soon .nm{color:var(--warn)}`) лишається кольором тексту, не фону. Форма додавання (`.subaddbox`, `.mfields`) — `.stack`/`.cluster`, поля вирівняні по сітці.
- [ ] **Step 3: Проба зміненого.** Бейдж на вкладці «Підписки» (`dataset.badge`, рядок ≈5118) видно у трьох розкладках — `node tests/nav.mjs` зелений.

---

### Task 10: Екран «Інвестиції»

**Files:** Modify: `app/app.template.html` (`#tab-inv` ≈1996–2105; `renderInv` і підфункції ≈7063–8700: групи, платформи, позиції, угоди, дивіденди, графіки ціни), `desktop/build_desktop.py` (якорі вставок десктопа).

- [ ] **Step 1: Штучні дані інвестицій.** Браузерна збірка показує заглушку («підключення живе в застосунку»), тож реальний екран перевіряється лише в десктопній. Побудувати штучний `__BOOT__.inv` без реальних даних: узяти XML-фікстуру з `tests/ibkr-currency.mjs` (вона вже штучна), прогнати через `desktop/dist/invnorm.js` (як це робить проба) і подати результат у `window.__BOOT__.inv` через `addInitScript` за зразком мокінгу IPC у `tests/desktop-csp.mjs` (рядки ≈30–45). Оформити як `tests/helpers/desktop-boot.mjs`, що експортує `async function openDesktop(browser, width)` і повертає `{ctx, page}` з відкритим `desktop/dist/index.html`; додати в `tests/snap.mjs` перемикач `SNAP_DESKTOP=1` для знімків цієї вкладки.
- [ ] **Step 2:** P1–P7 для `#tab-inv` (знімки — у режимі `SNAP_DESKTOP=1`).
- [ ] **Step 3: Специфіка.** Групи, що згортаються, — `.card` із `.cardhead`, стрілка — SVG `#i-chevron` з обертанням; позиції — `.row` із `.badge-ico` (логотип або літера), вартість і зміна праворуч (`--success`/`--danger` лише колір тексту). Перемикачі періоду/режиму (`INVPER`, `INVMODE`) — сегмент (`.periodbar`-подібний). Графік ціни з мітками угод — стилі токенами; палітра — у Задачі 13.
- [ ] **Step 4: Проба зміненого.** `node tests/ibkr-currency.mjs && node tests/desktop-csp.mjs` зелені (CSP не поламано).

---

### Task 11: Екран «Кошториси»

**Files:** Modify: `app/app.template.html` (`#tab-budget` ≈1912–1995; кошторис проєкту ≈5393–5904; журнал і шаблони ≈6839–7047). **Не змінювати** генерацію клієнтських рахунків (≈5905–6295, `#invoice…`) — це клієнтський документ.

- [ ] **Step 1:** P1–P7 для `#tab-budget` і екрана проєкту (`pjOpen`).
- [ ] **Step 2: Специфіка.** Групи клієнтів у списку проєктів (`pjui.mjs`) — розділені відступом і заголовком-міткою, **без смуги**; стан проєкту (`PJ_ST`) — `.tag` із крапкою `.dot`. Рядки кошторису — компактна таблиця `.tablewrap`; поля `#pjRate` тощо — `input` зі словника; у режимі скріншоту розмиті поля лишаються розмитими (`v1311.mjs`).
- [ ] **Step 3: Проба зміненого.** `node tests/pjui.mjs && node tests/pjstat.mjs && node tests/pjlog.mjs && node tests/pjjump.mjs && node tests/v1311.mjs` зелені; згенерований рахунок до і після порівняти побайтово: у `page.evaluate` викликати функцію побудови HTML рахунку для однакового проєкту до змін (зберегти в `.test-artifacts/invoice-before.html` під час P1) і після; `fc .test-artifacts\invoice-before.html .test-artifacts\invoice-after.html` (або `cmp`) — без різниці.

---

### Task 12: Екран «Ще», майстер першого запуску, блокування, перегляд на телефоні

**Files:** Modify: `app/app.template.html` (`#tab-settings` ≈2176–2357; `#lock` ≈1720–1730; майстер першого запуску (`wizDone`); `#phoneOverlay` ≈2384–2400 і `html.phone-inner`), `desktop/build_desktop.py` (великі вставки десктопа: екран Monobank, оновлення, дані, IBKR/Binance — рядки ≈100–380, 556–560).

- [ ] **Step 1:** P1–P7 для `#tab-settings`; внутрішні розділи (`data-sec`) — вкладений навігатор `go2set(sec)`: той самий сегмент, що й період.
- [ ] **Step 2: Специфіка десктопних вставок.** У `build_desktop.py` вставки містять власну розмітку з `style="…"` і `class="btn pri"` — привести до того ж словника; якорі `sub(...)` оновлювати за P3. Статуси підключень (Monobank/IBKR/Binance): крапка `.dot` + текст, не кольорова картка.
- [ ] **Step 3: Блокування й майстер.** `#lock` — центрована картка на `--bg`, поле коду по центру, кнопка `.btn.pri`; майстер — звичайна модалка (`uiAsk`) зі словника; перевірити `shell-a11y.mjs` (модалка накриває панель).
- [ ] **Step 4: Перегляд на телефоні.** `#phoneOverlay` фон `--scrim`, рамка пристрою — `--surface` із радіусом `--radius-lg`; усередині iframe (`#phone-inner`) ширини 360–430 px < 760, тож автоматично показуються нижні таби (перевірка інтеграційна): скрипт відкриває десктопну збірку на 1400 px, натискає `#phoneBtn` і в iframe читає `getComputedStyle(nav).position === 'fixed'`.
- [ ] **Step 5: Проба зміненого.** `node tests/allcheck.mjs && node tests/desktop-csp.mjs && node tests/security.mjs` зелені.

---

### Task 13: Графіки

**Files:** Modify: `app/app.template.html` (CSS токенів `--s1..--s8`, `--grid`, `--axis`, `--bar-exp`, `--bar-inc`; функції графіків: `CHART: monthly bars` ≈2822, `category bars` ≈2896, `MoM trend lines` ≈3000, SVG-утиліти ≈3043; графік ціни в Інвестиціях; `#tip`).

- [ ] **Step 1: Завантажити скіл.** Викликати `Skill` з `dataviz` до будь-яких змін кольорів графіків; прочитати його `references/palette.md` і запустити валідатор палітри зі скіла на новій палітрі.
- [ ] **Step 2: Палітра.** Підібрати `--s1..--s8` і `--bar-exp/--bar-inc` для обох тем так, щоб валідатор скіла (розрізнюваність, контраст ≥ 3:1 до `--surface`, симуляція дальтонізму) проходив; записати фінальні значення в CSS і в розділ `РОЗРОБКА.md`. Значення не вигадувати «на око»: приймання — вивід валідатора.
- [ ] **Step 3: Вигляд.** Стовпчики — заливка без `filter:drop-shadow` (світіння прибрати: воно залишок скляної естетики); сітка `--grid`, осі `--axis`; підписи `--fs-xs` `--text-mute`; радіус стовпчиків 4 px; підказка графіка — `#tip` (Задача 6b). Лінії тренду — 2 px, точки при наведенні.
- [ ] **Step 4: Перевірка.** `node tests/contrast.mjs` (додати пари `--s1..--s8` до `--surface` ≥ 3:1 у обох темах у список `PAIRS`) і знімки Огляду/Категорій у двох темах; `node tests/gaps.mjs && node tests/nostripe.mjs` зелені. Commit.

---

### Task 14: Зняття аліасів, підсумок і повний прохід

**Files:** Modify: `app/app.template.html`, `docs/РОЗРОБКА.md`, `README.md` (кореневий у `repo/`, лише якщо там описано скло), `docs/superpowers/specs/2026-10-15-ui-redesign-design.md` (статус).

- [ ] **Step 1: Лишились аліаси?**

Run:
```bash
grep -n -- "--ink\b\|--ink-2\|--muted\b\|--surface-1\|--plane\|--good\b\|--crit\b\|--serious\|--glass-" app/app.template.html
```
Expected: лише визначення в блоці токенів (аліаси). Якщо є використання поза ним — замінити на нові імена (таблиця P5) і повторити. Потім видалити блок «аліаси старих імен» з `:root` і зі світлої теми (`--serious` лишити, якщо його читає JS: `grep -n "serious" app/app.template.html` — якщо лише CSS, видалити).

- [ ] **Step 2: Залишки інлайн-стилів**

Run: `grep -o 'style="' app/app.template.html | wc -l`
Expected: число суттєво менше за вихідне (знято в Задачі 6 «до» — рахунок записаний у комітах екранів); решта — динамічні значення з коментарем. Переглянути `grep -n 'style="' app/app.template.html | grep -v "width:\|background:\|--"` — кожен лишений — обґрунтований.

- [ ] **Step 3: Повний прохід**

Run:
```bash
python app/build_app.py && python desktop/build_desktop.py && npm test && python -m unittest discover -s tests -p 'test_*.py' -v
```
Expected: усе зелене (`pretest` збирає штучний HTML автоматично).

- [ ] **Step 4: Знімки й ручний огляд**

Run: `python app/build_app.py --data .test-artifacts/synthetic.json --out .test-artifacts/synthetic_app.html && node tests/snap.mjs final`; Read не менш як: `dark-1400-overview`, `light-1400-tx`, `dark-900-cats`, `light-390-overview`, `dark-390-settings`, `light-1400-settings`. Порівняти з `snap-before/` тих самих імен: нова система єдина в обох темах; немає лишків старого вигляду (скляні ефекти, лаймові градієнти, Geologica).

- [ ] **Step 5: Документація**

У `docs/РОЗРОБКА.md` додати розділ «Нова дизайн-система (Apple + Monobank)»: таблиця токенів зі значеннями, правила (плоскі поверхні; колір категорії лише в іконці/чипі/крапці; лайм лише для основної дії й активного стану; один шрифт Onest; радіуси 12/18/24; рух 180 мс; `prefers-reduced-motion`), каркас (220/64/нижня панель 56, межі 759/760/999/1000), чому саме так (історія двох наборів токенів, скла, пігулки-навігації), перелік нових проб і що кожна сторожить, якорі десктопної збірки. Оновити дату «Оновлено». У спеці змінити рядок статусу на «Реалізовано».

- [ ] **Step 6: Commit і гілка**

```bash
git add app/app.template.html docs/РОЗРОБКА.md docs/superpowers/specs/2026-10-15-ui-redesign-design.md README.md
git commit -m "Нова дизайн-система: аліаси зняті, документація, повний прохід" -m "Co-Authored-By: Claude Sonnet 5.5 <адреса з атрибуції сесії>"
git status --short
```
Expected: `git status --short` порожній. Злиття гілки `ui-redesign` і випуск версії — лише за прямим дорученням власника (процедура `/release`).

---

## Самоперевірка плану проти спеки

| Розділ спеки | Де реалізовано |
|---|---|
| §2 рішення (гібрид, B+C, скло, акцент, теми, шрифт) | Задачі 1–5 |
| §3 поточний стан | враховано в Задачах 1, 2 (маркери рядків) |
| §4 токени, типографіка, рух, видалення скла | Задачі 1, 2 |
| §5 каркас: панель, межі, нижні таби, «Ще», період, точки дотику JS | Задачі 3, 4, 5 |
| §6 компоненти й заборони | Задачі 6a, 6b |
| §7 екрани по черзі | Задачі 7–12 |
| §8 графіки (`dataviz`) | Задача 13 |
| §9–10 етапи й перевірка | структура плану; `nav`/`contrast`/`nostripe`/`overflow`/`shell-a11y`; знімки в кожній задачі |
| §11 ризики (моноліт, ширина, складачі, тести) | P2–P3, Задачі 2 і 5, `overflow.mjs` |

**Відхилення від спеки, внесені в самій спеці під час виконання:** значення `--text-dim/--text-mute/--accent` (Задача 1, Крок 6) і відмова від рухомої пігулки в нижніх табах (Задача 4, Крок 6).
