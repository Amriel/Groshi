# Налаштування за зразком PC Monitor — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вкладка «Налаштування» з лівою колонкою розділів (пошук, групи, іконки, бейдж «Оновлення») і правою панеллю з групами рядків замість чотирьох чипів і купи карток.

**Architecture:** Шаблон `app/app.template.html` отримує каркас: ліву колонку `#setNav` (будується з JS-масиву `SETSECS`) і порожні панелі `.setpane[data-sec]`; наявні картки переїжджають у панелі, прості налаштування стають рядками `.setrow` у групах `.setgrp`. Десктопні вставки `desktop/build_desktop.py` кладуться в панелі через маркери-коментарі. `SETSEC`/`setSec`/`go2set()` лишаються єдиним станом і точкою входу.

**Tech Stack:** один HTML-шаблон (ванільний JS/CSS), Python-складачі, Playwright-проби (`node tests/*.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-31-settings-redesign-design.md` — читати разом із планом.

## Global Constraints

- Жодних нативних `select`/`checkbox`-вигляду/`<input type="date">`/`<input list>` у новому тексті/атрибута `title`/`prompt|confirm|alert`; лише `.csel`, `buildCombo()`, `uiAsk/uiConfirm/uiPick`, `data-tip`. Хук `.claude/hooks/guard.py` це блокує — відмова сторожа = міняти підхід.
- Без кольорових смуг збоку (`border-left` кольором, inset-тінь-смуга) і без тонування фону карток/рядків; колір — лише квадратик іконки, бейдж, `.dot`.
- Токени лише з `:root`; світла тема (`data-theme="light"`) має тримати контраст.
- «Нічого не смикається»: перемальовувати на місці; перемикання розділу, перевірка оновлень, пошук не зсувають ліву колонку (звіряти `getBoundingClientRect()` до/після).
- Усі наявні `id` полів зберігаються.
- Після кожної зміни шаблону/складача: `python app/build_app.py` і `python desktop/build_desktop.py` (хук `build.py` робить це сам після правки шаблону, але `pretest` збирає синтетичну версію лише в `npm test`; для одиночної проби спершу `npm run pretest`).
- Коментарі — українською, пояснюють «чому».
- `tests/invcstat.mjs` НЕ чіпати.
- Сабагенти не комітять і не роблять `git add`; повертають список змінених шляхів. Коміт — лише коли власник попросить, явними шляхами.
- Випуск — лише на пряме прохання власника.

## Review Focus

1. **Старий `setSec` у стані** (`'src'`, `'app'`, сміття) — апка відкривається на розумному розділі, а не на порожній панелі. → тест у Task 1.
2. **Браузерна збірка** — пунктів «Оновлення» і «Запуск і синхронізація» немає; «Брокери й біржі» показують нотатку; жодна панель не порожня. → Task 1/2.
3. **Застарілий бейдж**: `updAvail` з версією, що вже стоїть, або перевірка «найновіша» — бейджа й крапки немає. → Task 4.
4. **Пошук без збігів / з великими літерами / з апострофом** (`’` vs `'`) — «Нічого не знайдено», без винятків; регістр не важливий. → Task 5.
5. **390 px**: `go2set('adv')` з вкладки Порадника відкриває розділ, «‹ Налаштування» повертає список, горизонтального прокручування немає. → Task 5.

---

## Карта файлів

- `app/app.template.html` — CSS блоку «КОМПОНЕНТИ» (`.setnav`, `.setgrp`, `.setrow`, `.sw`, `.setpane`, `.sethero`), розмітка `#tab-settings` (≈2394–2669), JS розділів (≈10943–10976), автоперевірка оновлень (≈10908–10923), `PRIVACY_OPTIONS`/`privacyUi` (≈11181–11205), виклики `go2set` (≈7891, 9298, 10548, 11140), текст майстра (≈11153).
- `desktop/build_desktop.py` — `MONO_HTML` (≈211–288), `INV_HTML` (≈296–376), якорі вставок (≈291, 379), `updWire`/`updRun` (≈520–593), `goMono`/`onTraySync` (≈113, 506).
- `tests/settings.mjs` — нова проба (через скіл `new-probe`: реєстрація в `package.json` `test`, `tests/README.md`, `docs/РОЗРОБКА.md`).
- `tests/helpers/desktop-boot.mjs` — відповідь на `update_check` (фікстура `window.__updFixture`).
- `tests/advdata.mjs:162`, `tests/advisor.mjs:556` — нові селектори.
- `README.md:73`, `mcp/README.md:139`, `mcp/selftest.js:35`, `docs/РОЗРОБКА.md` (≈1057–1061, ≈3205, новий розділ, дата «Оновлено»).

## Спільні інтерфейси (визначає Task 1, решта користується)

```js
// Порядок = порядок у лівій колонці; grp — номер заокругленої групи.
// desk:true — розділ існує лише в десктопі (у браузері пункт не малюється).
const SETSECS = [
  {k:'upd',   n:'Оновлення',              grp:1, ico:'upd',   c:'--s1', desk:true},
  {k:'bank',  n:'Банки',                  grp:2, ico:'bank',  c:'--s6'},
  {k:'inv',   n:'Брокери й біржі',        grp:2, ico:'inv',   c:'--s3'},
  {k:'rules', n:'Категорії і правила',    grp:3, ico:'rules', c:'--s4'},
  {k:'notif', n:'Сповіщення',             grp:3, ico:'notif', c:'--s2'},
  {k:'loc',   n:'Валюта і мова',          grp:3, ico:'loc',   c:'--s7'},
  {k:'priv',  n:'Приватність і замок',    grp:4, ico:'priv',  c:'--s5'},
  {k:'run',   n:'Запуск і синхронізація', grp:4, ico:'run',   c:null,  desk:true},
  {k:'data',  n:'Дані і бекап',           grp:4, ico:'data',  c:'--s8'},
  {k:'adv',   n:'Порадник',               grp:5, ico:'adv',   c:'--s1'},
];
function setSecsVisible(): Array<typeof SETSECS[0]>   // з урахуванням isDesk()
function setSecNorm(k: string): string                // міграція: src→bank, app→(desk?'upd':'data'), невідоме→перший видимий
function setSecApply(): void                          // малює #setNav на місці, показує .setpane[data-sec=SETSEC]
function go2set(sec: string): void                    // як зараз + setSecNorm + на вузькому відкриває панель
function updPending(): boolean                        // Task 4; Task 1 робить заглушку () => false
```

Розмітка: `#tab-settings > .setwrap > nav#setNav.setnav[aria-label="Розділи налаштувань"]` + `div.setmain > section.setpane[data-sec=k]` (кожна з `h2.setttl` і `p.setsub`). Пункт: `button.setit[data-sec=k][aria-current="page"|absent]` з `span.setico`, `span.setn`, `span.setcnt` (лише `upd`) і шевроном. Пошук: `input#setQ.setin` (без `type=search`).

---

### Task 1: Каркас — ліва колонка, панелі, стан, перенесення карток шаблону

**Files:**
- Modify: `app/app.template.html` (CSS ≈1753–1763; розмітка ≈2394–2669; JS ≈10943–10976; виклики `go2set` ≈7891, 9298, 11140)
- Create: `tests/settings.mjs` (через скіл `new-probe`)
- Modify: `tests/advdata.mjs:162`, `tests/advisor.mjs:556`

**Interfaces:**
- Produces: усе з «Спільних інтерфейсів», CSS-класи `.setwrap .setnav .setit .setico .setn .setcnt .setmain .setpane .setttl .setsub`, `updPending()` = заглушка `false`.

- [ ] **Step 1: Створити пробу `tests/settings.mjs` (скіл `new-probe`), браузерна частина, 1400×900:**

```js
// 1) склад колонки в браузері
await page.evaluate(() => { localStorage.setItem('setSec', '"src"'); });  // старе значення
await page.reload(); await page.evaluate(() => go('settings'));
assert.deepEqual(await page.$$eval('#setNav .setit', b => b.map(x => x.dataset.sec)),
  ['bank','inv','rules','notif','loc','priv','data','adv'], 'браузер: без upd і run');
assert.equal(await page.evaluate(() => SETSEC), 'bank', 'міграція src→bank');
// 2) app → data у браузері, сміття → перший видимий
for (const [old, exp] of [['app','data'], ['zzz','bank']]) { /* setSec=old, reload, go('settings') */ assert.equal(SETSEC, exp); }
// 3) кожна видима панель непорожня, рівно одна панель видима
// 4) клік по пункту rules → aria-current="page" на ньому, видно #workCats і #rBody; ліва колонка не зсунулась (rect до/після, |Δ|<0.5)
// 5) усі старі id на місці: rMatch rAdd excl moveMode workCats baseCcy privacyOptions pvImport pinBtn pinIdle invcDueDays alertPct divNotifyCk newsUk bkNow bkDir bkAuto expCsv expJson reset quality advSetNote
// 6) #setSeg відсутній
```

- [ ] **Step 2: `npm run pretest && node tests/settings.mjs`** — Expected: FAIL (`#setNav` не знайдено).
- [ ] **Step 3: Каркас у шаблоні.** Замінити `#setSeg` на `.setwrap` з `#setNav` і `.setmain`; створити 10 `.setpane` з заголовками й підзаголовками (тексти — стислі, напр. «Банки» / «Звідки апка бере операції»); перенести картки шаблону в панелі за таблицею спеки (`srcNote`→`bank` з текстом лише про Monobank і ПриватБанк; нова нотатка `invNote` у `inv`: «Interactive Brokers і Binance підключаються в застосунку»; Валюта, Мова → `loc`; Сповіщення інвестицій, Рахунки клієнтам → `notif`; Приватність, Замок → `priv`; ПриватБанк → `bank`; Бекап, Дані, Якість → `data`; правила → `rules`; Порадник → `adv`). Атрибут `data-sec` з карток прибрати (видимість тепер на рівні панелі); логіку `advsc`/`advSetNote`/`srcNote`/`invNote` за `isDesk` зберегти. Додати маркери `<!-- desk:upd -->`, `<!-- desk:bank -->`, `<!-- desk:inv -->`, `<!-- desk:run -->`, `<!-- desk:data -->` у відповідні панелі (у `bank` — перед ПриватБанком; у `data` — першим). Панелі `upd` і `run` у браузері не показуються.
- [ ] **Step 4: JS.** `SETSECS`, `setSecsVisible`, `setSecNorm`, `setSecApply` (колонку малювати один раз і далі лише міняти `aria-current`/бейдж — без `innerHTML =` на кожен `render()`), `go2set` через `setSecNorm`. Іконки — інлайн-SVG білим штрихом у `.setico` з фоном `var(c)` (для `run` — `var(--surface-3)`); `.setcnt` прихований, коли `!updPending()`. Колонка ~300 px, панель — решта, `max-width` ~760 px.
- [ ] **Step 5: Перевести виклики:** `data-invgo`/`data-invgo2` (≈7891, 9298) → `go2set('inv')`; майстер `wizDone` (≈11140) → `go2set('bank')`; `advGear` — `'adv'` як є.
- [ ] **Step 6: Оновити старі проби:** `tests/advdata.mjs:162` → `page.locator('#setNav .setit[data-sec="rules"]').click()`; `tests/advisor.mjs:556` → `document.querySelector('#setNav .setit[data-sec="adv"]').getAttribute('aria-current') === 'page'`.
- [ ] **Step 7: Перевірка:** `npm run pretest && node tests/settings.mjs && node tests/advdata.mjs && node tests/advisor.mjs && node tests/modal.mjs && node tests/nostripe.mjs && node tests/overflow.mjs` — Expected: усі OK.

---

### Task 2: Десктопні вставки в панелі

**Files:**
- Modify: `desktop/build_desktop.py` (≈113, 211–293, 296–381, 506)
- Modify: `tests/settings.mjs` (десктопна частина через `openDesktop` з `tests/helpers/desktop-boot.mjs`)

**Interfaces:**
- Consumes: маркери `<!-- desk:* -->` з Task 1, `go2set`, `SETSECS`.
- Produces: панелі `upd`/`run` у десктопі непорожні; блок теки з даними має `id="dirBlock"` (для Task 3).

- [ ] **Step 1: Тест (десктоп, 1400×900):**

```js
const {page, errors} = await openDesktop(browser, {width: 1400});
await page.evaluate(() => go('settings'));
assert.deepEqual(await page.$$eval('#setNav .setit', b => b.map(x => x.dataset.sec)),
  ['upd','bank','inv','rules','notif','loc','priv','run','data','adv']);
// панель bank містить #monoTok і #pvImport; inv — #ibkrTok і #binKey; upd — #updCheck і #updSrc;
// run — #autoStart, #autoSync, #quietFrom; data — #openDir, #dirPick, #bkNow; #invNote і #srcNote приховані
// setSec='app' у стані → SETSEC==='upd'
assert.deepEqual(errors, []);
```

- [ ] **Step 2: Запуск** — Expected: FAIL (вставки ще перед «Дані»).
- [ ] **Step 3: `build_desktop.py`.** Monobank → маркер `desk:bank`; IBKR+Binance → `desk:inv`; «Оновлення» → `desk:upd`; «Застосунок» розрізати: автозапуск/автосинк/IBKR/тиша → `desk:run`, тека з даними (`openDir dirPick dirReset dirPath dirFiles` + примітка про перенос) у `<div id="dirBlock">` → `desk:data`. Прибрати `data-sec` з карток вставок. `sub()` має падати, якщо маркер не знайдено (як зараз). `goMono` і `onTraySync` → `go2set('bank')`.
- [ ] **Step 4: Запуск** `python desktop/build_desktop.py && node tests/settings.mjs && node tests/desktop-csp.mjs && node tests/security.mjs` — Expected: OK.

---

### Task 3: Рядки, групи й перемикач

**Files:**
- Modify: `app/app.template.html` (CSS «КОМПОНЕНТИ»; розмітка панелей `notif loc priv data rules`(лише «Перекази»); `PRIVACY_OPTIONS`/`privacyUi` ≈11189–11205)
- Modify: `desktop/build_desktop.py` (панель `run`, `#dirBlock`)
- Modify: `tests/settings.mjs`

**Interfaces:**
- Produces: `.setgrp` (підпис `.setgcap` + заокруглений контейнер), `.setrow` (`.setrn` назва, `.setrd` опис, керування справа), `.setfoot` (примітка внизу панелі), перемикач `.sw`: `input[type=checkbox].sw[role=switch]` або `button.sw[role=switch][aria-pressed]`.

- [ ] **Step 1: Тест:** для `#bkAuto #divNotifyCk #newsUk #autoStart`(десктоп) — `classList.contains('sw')`, `role==='switch'`; клік змінює `.checked` і пише стан як раніше (`bkAuto`, `newsUk` у `localStorage`); `[data-privacy]` — рівно 6, кожен `role=switch`, клік перемикає `aria-pressed`; у видимих `.setrow`/`.setgrp` `getComputedStyle(...).backgroundColor` дорівнює фону `.setgrp` (без тонування); `#moveMode` — `.csel`, як зараз.
- [ ] **Step 2: Запуск** — Expected: FAIL.
- [ ] **Step 3: CSS компонентів** за макетом: група — `var(--surface)`, радіус `--radius-sm`, роздільник між рядками 1 px `var(--border)` з відступом зліва; підпис — `--fs-xs`, капс, `--text-mute`; `.sw` 44×26, вимкнено `--surface-3`, увімкнено `--accent` з кружком `--accent-contrast`; фокус — `outline` `--accent-line`; `:active` без зсуву розміру.
- [ ] **Step 4: Розмітка рядками** (сенс абзаців `.setlead` — в описах рядків або `.setfoot`; попередження «це не шифрування», «забутий код — видалити `pinHash`», про 8 копій бекапу, про перенос теки й «не відкривати на двох машинах» — зберегти дослівно за змістом):
  - `notif`: «Рух позиції від ±… %» (`alertPct`), «День виплати дивідендів» (`divNotifyCk`), «Нагадувати про рахунок після … днів» (`invcDueDays`);
  - `loc`: «Валюта показу» (`baseCcy`), «Перекладати заголовки новин» (`newsUk`);
  - `priv`: група «ЗОВНІШНІ СЕРВІСИ» — 6 рядків `PRIVACY_OPTIONS` з `button.sw[data-privacy]` замість «Увімкнути/Вимкнути»; група «ЗАМОК» — «Код на вхід» (`pinBtn`), «Блокувати після … хв» (`pinIdle`);
  - `data`: група «ТЕКА З ДАНИМИ» (`#dirBlock`, десктоп), «БЕКАП» (`bkNow`, `bkDir`, `bkAuto`, `bkMsg`), «ЕКСПОРТ» (`expCsv`, `expJson`), «СКИНУТИ» (`reset`, `dataInfo`); «Якість даних» лишається карткою;
  - `rules`: «Перекази між своїми рахунками» — рядок з `moveMode` + довгий опис у `.setfoot`; редактор правил, «Не рахується», «Робочі витрати» — картки як є;
  - `run` (десктоп): «Запускати з Windows» (`autoStart` `.sw`), «Оновлювати самому» (`autoSync`), «Брокер IBKR» (`autoIbkr`), «Нічна тиша з … до …» (`quietFrom`, `quietTo`), `autoSyncInfo` — описом рядка.
  - `bank`/`inv`/`adv` — картки як є (лише вирівняти під панель).
- [ ] **Step 5: Запуск** `npm run pretest && node tests/settings.mjs && node tests/modal.mjs && node tests/contrast.mjs && node tests/nostripe.mjs && node tests/security.mjs && node tests/shell-a11y.mjs` — Expected: OK.

---

### Task 4: Розділ «Оновлення» — картка-стан, бейдж, перемикач

**Files:**
- Modify: `desktop/build_desktop.py` (розмітка «Оновлення», `updWire`/`updRun` ≈520–593)
- Modify: `app/app.template.html` (автоперевірка ≈10908–10923, `updPending`, крапка шестерні в основній навігації)
- Modify: `tests/helpers/desktop-boot.mjs` (команда `update_check` → `window.__updFixture` або виняток `window.__updError`; `update_install` → `window.__updInstalled = args`)
- Modify: `tests/settings.mjs`

**Interfaces:**
- Consumes: `.setgrp/.setrow/.sw` (Task 3), `privacyToggle(key)`, `privacyAllowed(key)`, `D.updCheck(src)`, `D.updInstall(src,file)`, `D.version()`.
- Produces: `updPending(): boolean` (true, якщо `store.get('updAvail')?.version` є і ≠ поточна версія, яку `updWire` кешує в `window.__appVer`); `updAvailSet(r|null)`; `#updHero` (фіксована `min-height`, вміст міняється на місці: `#updHeroBadge`, `#updHeroTitle`, `#updHeroMeta`, `#updHeroBtn`).

- [ ] **Step 1: Тести (десктоп):**

```js
// a) updAvail={version:'9.9.9'} у стані → .setit[data-sec=upd] .setcnt видимий з «1»; на шестерні основної навігації крапка видима
// b) __updFixture={available:false, current:'test', version:'test'} → клік «Перевірити» → #updHeroBadge «Найновіша»; updAvail скинуто; бейдж і крапка зникли
// c) __updFixture={available:true, current:'test', version:'9.9.9', file:'x.exe', notes:'n'} → бейдж «Нова версія», #updHeroTitle «Гроші 9.9.9», кнопка «Встановити й перезапустити»; клік → uiConfirm → «Встановити» → __updInstalled.file==='x.exe'
// d) __updError='мережа' → .dot.warn і текст «мережа»
// e) rect #updHero і #setNav однакові в станах a–d (|Δ|<0.5)
// f) перемикач «Перевіряти оновлення» (#updAuto, button.sw без data-privacy) перемикає privacyAllowed('updates'); [data-privacy="updates"] у «Приватності» показує той самий стан
// g) updAvail.version === 'test' (поточна) → бейджа немає
```

- [ ] **Step 2: Запуск** — Expected: FAIL.
- [ ] **Step 3: Розмітка «Оновлення»** за спекою й макетом: `#updHero`; група «АВТОМАТИЧНО» — «Перевіряти оновлення» (`#updAuto`); група «ВРУЧНУ» — «Перевірити зараз» (`#updCheck`, опис «Остання перевірка: …» з `updLastCheck`), «Звідки брати оновлення» (показ джерела; «Змінити» розкриває в рядку поле `#updSrc` і `#updPick`); `.setfoot` «Дані, підписки й токени лишаються на місці — оновлюється тільки програма.» `#updBox` прибрати, нотатки релізу — `.setfoot` під карткою.
- [ ] **Step 4: Логіка:** `updRun` пише `updLastCheck`, викликає `updAvailSet(r.available ? r : null)` і малює стан у `#updHero`; встановлення — той самий `uiConfirm` і `D.updInstall`. Автоперевірка в шаблоні теж викликає `updAvailSet`; тост → «Доступна версія X — Налаштування → Оновлення» з переходом `go2set('upd')`, якщо тост уміє дію (інакше лише текст). `updAvailSet` перемальовує `.setcnt` і крапку шестерні на місці. `#updAuto` → `privacyToggle('updates')`; `privacyUi` оновлює і його.
- [ ] **Step 5: Запуск** `python desktop/build_desktop.py && node tests/settings.mjs && node tests/nav.mjs && node tests/desktop-csp.mjs && node tests/security.mjs` — Expected: OK.

---

### Task 5: Пошук і вузький екран

**Files:**
- Modify: `app/app.template.html` (JS розділів, CSS `@media` для `.setwrap`)
- Modify: `tests/settings.mjs`

**Interfaces:**
- Consumes: `SETSECS`, `setSecApply`, `go2set`.
- Produces: `setSearch(q: string): void`; `SETOPEN: boolean` (вузький: показано панель, а не список); кнопка `#setBack` «‹ Налаштування».

- [ ] **Step 1: Тести:**

```js
// 1400: #setQ «БЕКАП» → видно лише .setit[data-sec=data]; «шифрування» → priv; «zzzz» → #setNone «Нічого не знайдено», усі пункти приховані; «комп'ютер» і «комп’ютер» дають однаковий результат; порожній → усі; rect #setNav.width незмінний
// 390×844 (браузер і десктоп): go('settings') → видно #setNav, панелі приховані; клік .setit[data-sec=loc] → видно панель loc і #setBack, #setNav прихований; #setBack → назад до списку
// 390: go2set('adv') → одразу панель adv
// 390 і 768: document.documentElement.scrollWidth <= innerWidth
```

- [ ] **Step 2: Запуск** — Expected: FAIL.
- [ ] **Step 3: Пошук.** Індекс на пункт = назва + `textContent` `.setttl .setrn .setrd .cardhead h2` його панелі, нормалізований (`toLowerCase`, `’`→`'`); будується при першому вводі. Фільтр ховає пункти й порожні групи; ліва колонка фіксованої ширини.
- [ ] **Step 4: Вузький екран** (`max-width: 859px`): одна колонка; `SETOPEN=false` — лише список; клік по пункту / `go2set` — `SETOPEN=true`, лише панель і `#setBack`. Перехід — без зсувів сусідів (без анімації ширини).
- [ ] **Step 5: Запуск** `npm run pretest && node tests/settings.mjs && node tests/overflow.mjs && node tests/nav.mjs && node tests/shell-a11y.mjs` — Expected: OK.

---

### Task 6: Тексти, документація, повний прогін, огляд власником

**Files:**
- Modify: `app/app.template.html` (≈11153 текст майстра), `README.md:73`, `mcp/README.md:139`, `mcp/selftest.js:35`, `docs/РОЗРОБКА.md`, `tests/README.md`

- [ ] **Step 1:** Замінити «Ще/Налаштування → Апка і дані → …» на нові шляхи: замок — «Налаштування → Приватність і замок», тека з даними — «Налаштування → Дані і бекап → Показати теку з даними», бекапи — «Дані і бекап». `grep -rn "Апка і дані" --exclude-dir=Archive --exclude-dir=dist .` → 0 збігів поза історичними розділами `РОЗРОБКА.md`.
- [ ] **Step 2:** `docs/РОЗРОБКА.md`: новий розділ «Налаштування: ліва колонка розділів» (причина — власник шукав оновлення; склад `SETSECS`, міграція `setSec`, маркери `desk:*`, `updAvail`/`updPending`, пошук, вузький екран, компоненти `.setgrp/.setrow/.sw`); у ≈1057–1061 і ≈3205 — примітка «замінено, див. …»; дата «Оновлено».
- [ ] **Step 3:** Повний прогін: `python app/build_app.py && python desktop/build_desktop.py && npm test && python -m unittest discover -s tests -p "test_*.py"` — Expected: усе зелене (якщо падає лише `invcstat.mjs` — це чужа задача; повідомити, не чіпати).
- [ ] **Step 4:** Рецензія агентом `groshi-rules-reviewer` на весь дифф; виправити зауваження.
- [ ] **Step 5:** Знімки для власника (десктоп 1400 темна/світла: «Оновлення» з новою версією, «Приватність і замок», «Дані і бекап»; 390 — список і розділ) у `.test-artifacts/settings-*.png`; показати власнику. Готово = власник затвердив вигляд.
