# Порадник · етап 1 (основа + Claude Code) — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** вкладка «Порадник» у десктопних «Грошах», де власник ставить питання про витрати й інвестиції, а відповідає його Claude Code за підпискою на даних застосунку зі знеособленими NDA-назвами та з веб-пошуком.

**Architecture:** MCP «Гроші» ділиться на чисту бібліотеку інструментів (`mcp/tools.js`) і stdio-обгортку; знеособлювач `mcp/pseudo.js` спільний для MCP і вебвʼю. Rust (`advisor.rs`) запускає встановлений `claude -p` зі стрімом JSON, лише з нашим MCP і `WebSearch`, і пересилає події у вебвʼю. Вкладка складає зведення з `TX` тими ж функціями, що й «Огляд», знеособлює його, а відповідь показує зі справжніми назвами.

**Tech Stack:** Tauri 2 / Rust (tokio, serde_json, std::process), Node 18+ без залежностей (MCP), vanilla JS у `app/app.template.html`, Playwright-проби, Python unittest.

**Spec:** `docs/superpowers/specs/2026-10-17-poradnyk-design.md`. Етапи 2 (локальна модель) і 3 (API) — окремі плани після приймання цього етапу.

## Global Constraints

- Мова інтерфейсу, коментарів, документації — українська; коментарі пояснюють **чому**.
- Жодного системного вигляду: не `prompt/confirm/alert`, не нативний `<select>`/checkbox, не `title`. Лише `uiAsk/uiConfirm/uiPick`, `.csel`, `buildCombo`, `data-tip`, власний checkbox.
- Жодних кольорових смуг збоку карток і тонованого фону карток; колір — лише в `.dot`/`.badge-ico`/`.tag`.
- Нічого не смикається: потік дописується в останнє повідомлення на місці, без `innerHTML =` усього списку.
- Інтерфейс змінюється лише в `app/app.template.html`; після правки — `python app/build_app.py` і `python desktop/build_desktop.py`.
- CSP у `tauri.conf.json` не змінюється; `native_csp.rs` лишається зеленим. Мережа й процеси — лише з Rust.
- MCP не отримує ні мережевого коду, ні коду запису.
- Запущений `claude`: інструменти лише `mcp__groshi__*` і `WebSearch`; `WebFetch`, файли, термінал, субагенти, скіли, інші MCP — заборонені явно.
- Для хмари підміняються: імена платників у надходженнях на рахунки ФОП; назви клієнтів (`clientsDB` ключі/`name`, `invcLog[].client`, `projects[].client`), назви проєктів (`projects[].name`), ЄДРПОУ (`clientsDB[].reg`), IBAN клієнтів, номери рахунків (`invcLog[].no`). Суми — **не** підміняються. Перекази приватним людям поза ФОП — **не** підміняються.
- Спосіб підключення закріплений за розмовою.
- Сабагенти не комітять; коміт — main loop, явними шляхами (у робочій копії є чужі незакомічені зміни в `app/app.template.html`, `docs/РОЗРОБКА.md`, `tests/nav.mjs` — їх не чіпати й не додавати).
- Після нової можливості — розділ у `docs/РОЗРОБКА.md` з причиною й дата «Оновлено».

## Review Focus

1. Назва клієнта з різним написанням («ТОВ "Альфа"», «Альфа ТОВ», «альфа») — має дати той самий псевдонім і не просочитись. Тест у Task 2.
2. Назва клієнта як частина довшого слова («Альфа» всередині «Альфабанк») — не повинна ламати чужі слова. Тест у Task 2.
3. `claude` не встановлено, не залогінено або впав посеред відповіді — вкладка показує зрозуміле повідомлення, кнопка «Стоп» зникає, наступне питання працює. Тест у Task 4 (Rust: відсутній бінарник) і Task 6 (проба: подія `error`).
4. Дуже довга відповідь / таблиця Markdown з `<script>` у тексті моделі — рендер екранує HTML. Тест у Task 6.
5. Друге питання, поки йде перше, і перемикання вкладки під час потоку — одна відповідь за раз, потік не губиться. Тест у Task 6.

---

### Task 1: Розділити MCP на бібліотеку інструментів і stdio-обгортку

**Files:**
- Create: `mcp/tools.js`
- Modify: `mcp/groshi-mcp.js` (лишається лише протокол, рядки ~706–764)
- Test: `tests/mcp_tools.mjs`

**Interfaces:**
- Produces: `require('./tools.js')` → `{ T, DIR, state, txAll }`, де `T[name] = { desc, schema, run(args) → string }`. Модуль **не** читає stdin при імпорті.
- `groshi-mcp.js` поводиться для Claude Desktop так само: ті самі 10 інструментів, той самий вивід.

- [ ] **Step 1: Написати тест `tests/mcp_tools.mjs`**
  - імпорт `mcp/tools.js` через `createRequire` із `GROSHI_DIR=.test-artifacts/mcp-empty` (порожня тека) завершується без зависання (процес виходить сам за ≤2 с — запускати в дочірньому `node -e`);
  - `Object.keys(T).length === 10` і містить `groshi_status`, `transactions`, `fop_and_invoices`;
  - stdio-обгортка: `initialize` → `tools/list` повертає 10 інструментів (як у `mcp/selftest.js`).
- [ ] **Step 2:** `node tests/mcp_tools.mjs` → FAIL (`tools.js` немає).
- [ ] **Step 3:** Перенести все до `const TOOLS = …` у `tools.js`, додати `module.exports = { T, DIR, state, txAll }`; у `groshi-mcp.js` — `const { T, DIR } = require('./tools.js')` і протокол.
- [ ] **Step 4:** `node tests/mcp_tools.mjs` → PASS; `node mcp/selftest.js` → «Усе на місці».
- [ ] **Step 5:** Додати `node tests/mcp_tools.mjs` у `npm test` (`package.json`) і рядок у `tests/README.md`; в `mcp/README.md` — що сервер тепер два файли поруч (`groshi-mcp.js` + `tools.js`).

### Task 2: Знеособлювач `mcp/pseudo.js`

**Files:**
- Create: `mcp/pseudo.js`
- Modify: `mcp/groshi-mcp.js` (обгортка `tools/call`)
- Test: `tests/pseudo.mjs`

**Interfaces:**
- Consumes: `state`, `txAll` з Task 1.
- Produces (UMD: `module.exports` у Node і `window.groshiPseudo` у вебвʼю):
  - `buildDict(state: object, tx: Tx[]) → Dict`, `Dict = { pairs: Array<[real: string, alias: string]> }`, відсортовані від довшого `real` до коротшого;
  - `hide(text: string, dict: Dict) → string`;
  - `reveal(text: string, dict: Dict) → string`;
  - `alias(kind: 'client'|'project'|'payer'|'id', real: string) → string`.
- У `groshi-mcp.js`: якщо `process.env.GROSHI_PSEUDO === '1'`, текст кожного `tools/call` проходить `hide(text, buildDict(state(), txAll()))`. Словник кешується до зміни mtime `state.json`/`mono_raw.json`.

Правила (зі специфікації §6):
- Псевдонім стабільний без зберігання: `alias(kind, real)` = префікс (`Клієнт`/`Проєкт`/`Платник`/`Реквізит`) + пробіл + 4 символи base32 від FNV-1a-32 нормалізованого `real`. Нормалізація: нижній регістр, лапки `"«»'ʼ` прибрати, слова `тов|фоп|пп|llc|ltd|inc` прибрати, пробіли стиснути.
- Джерела `real`: ключі й `name` у `clientsDB`, `invcLog[].client`, `projects[].client`, `projects[].name` → клієнт/проєкт; `clientsDB[].reg`, IBAN-и (`UA\d{27}`) з `clientsDB`, `invcLog[].no` → `id`; `counterName`/`merchant` надходжень (`dir==='income'`) на рахунки ФОП (`acctype === 'fop'` — перевірити назву поля в `mononorm.js`) → платник.
- `hide` замінює всі варіанти написання (оригінал, без лапок, без «ТОВ/ФОП» спереду чи ззаду), регістронезалежно, лише на межах слова (`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`, прапор `u`).
- Ігнорувати `real` коротші за 3 символи та службові назви (`Клієнт`, `Новий проєкт`, `PJ_NOCLIENT`).

- [ ] **Step 1: Тест `tests/pseudo.mjs`** на штучному стані: `clientsDB = { 'ТОВ "Альфа Груп"': { name: 'ТОВ "Альфа Груп"', reg: '12345678' } }`, `projects = [{ client: 'ТОВ "Альфа Груп"', name: 'Ребрендинг Омега' }]`, `invcLog = [{ no: 'INV-2026-007', client: 'ТОВ "Альфа Груп"', total: 1200 }]`, tx з надходженням ФОП від `'ALFA GROUP LLC'`.
  - `hide('Рахунок INV-2026-007 для ТОВ «Альфа Груп» по проєкту Ребрендинг Омега: 1200 USD', d)` не містить `Альфа`, `Омега`, `INV-2026-007`, але містить `1200 USD`;
  - `hide('альфа груп', d) === hide('Альфа Груп', d)` (однаковий псевдонім);
  - `hide('Альфабанк', d) === 'Альфабанк'` (межа слова), якщо в словнику є `Альфа` як окремий клієнт;
  - `hide('ALFA GROUP LLC +50000', d)` не містить `ALFA`;
  - `hide('Переказ Петро 2000', d) === 'Переказ Петро 2000'`;
  - `reveal(hide(s, d), d)` повертає канонічні назви (з `clientsDB[].name`/`projects[].name`);
  - `alias('client', 'ТОВ "Альфа Груп"') === alias('client', 'альфа груп')`.
- [ ] **Step 2:** `node tests/pseudo.mjs` → FAIL.
- [ ] **Step 3:** Реалізувати `mcp/pseudo.js` і гілку `GROSHI_PSEUDO` в обгортці.
- [ ] **Step 4:** PASS. Додатковий кейс у тому ж тесті: запуск `groshi-mcp.js` з `GROSHI_PSEUDO=1` і `GROSHI_DIR` на штучній теці (`state.json` з даними вище) → вивід `fop_and_invoices` не містить `Альфа`.
- [ ] **Step 5:** `npm test` += `node tests/pseudo.mjs`; `tests/README.md`.

### Task 3: Інструмент `market` (кешовані ринкові дані)

**Files:**
- Modify: `mcp/tools.js`
- Test: `tests/mcp_tools.mjs` (доповнити)

**Interfaces:**
- Produces: `T.market = { desc, schema: { type:'object', properties: {} }, run() → string }`.

Читає лише файли теки даних: `quotes.json` (котирування паперів портфеля й `fetched`), `nbu_rates.json`/`fx.json` (курси UAH). Вивід: «Станом на <дата fetched>», курси USD/EUR, зміна за день по паперах портфеля, якщо є. Немає файлів → «Ринкових даних у кеші немає — відкрийте вкладку Інвестиції». Мережі немає.

- [ ] **Step 1:** Тест: на штучній теці з `quotes.json` `{ fetched: <ts>, quotes: { AAPL: { price: 200, prev: 190 } } }` (структуру перевірити за `quotes.rs`) вивід містить `Станом на` і `AAPL`; на порожній — `немає`.
- [ ] **Step 2:** FAIL → **Step 3:** реалізувати → **Step 4:** PASS (`tools/list` тепер 11 — оновити очікування Task 1).

### Task 4: Rust — модуль `advisor.rs` (запуск Claude Code, потік, стоп, історія)

**Files:**
- Create: `desktop/src-tauri/src/advisor.rs`
- Modify: `desktop/src-tauri/src/main.rs` (`mod advisor;`, стан, `invoke_handler`), `desktop/src-tauri/tauri.conf.json` (`bundle.resources`: `../../mcp/groshi-mcp.js`, `tools.js`, `pseudo.js`, `mononorm.js` → тека `mcp/`), `scripts/privacy_check.py` (шаблон `advisor_chats.json`), `tests/test_privacy_check.py`

**Interfaces:**
- Produces (Tauri-команди):
  - `advisor_cc_probe() → { found: bool, path: Option<String>, version: Option<String>, node: bool }`
  - `advisor_cc_ask(req: AskReq) → Result<(), String>`, `AskReq = { conv: String, prompt: String, system: String, session: Option<String>, model: Option<String> }` — повертається одразу, далі події;
  - `advisor_stop()` — вбиває поточний процес;
  - `advisor_hist_all() → Value` / `advisor_hist_set(v: Value)` — файл `advisor_chats.json` у теці даних через наявний `Store` (атомарний запис).
- Подія `"advisor"`: `{ conv: String, kind: "text"|"tool"|"session"|"done"|"error", text: String }` (`session` несе `session_id` у `text`; `tool` — коротка назва інструмента/запиту).
- Чиста функція для тестів: `fn cc_args(cfg_path: &str, sys_path: &str, session: Option<&str>, model: Option<&str>) -> Vec<String>`.

Рішення:
- `cc_args` містить: `-p`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--tools WebSearch`, `--allowedTools mcp__groshi__* WebSearch`, `--strict-mcp-config`, `--mcp-config <cfg_path>`, `--system-prompt-file <sys_path>`, `--setting-sources ""` (перевірити, що вхід за підпискою лишається; інакше прибрати й лишити запис у РОЗРОБКА.md за §4.4 специфікації), `--disable-slash-commands`, за наявності `--resume <session>`, `--model <model>`. Питання — у stdin, не аргументом (довжина й лапки).
- Робоча тека процесу: `<тека даних>/advisor/` (порожня, створюється).
- MCP-конфіг пишеться в `<тека даних>/advisor/mcp.json`: `{"mcpServers":{"groshi":{"command":"node","args":["<resource_dir>/mcp/groshi-mcp.js"],"env":{"GROSHI_DIR":"<тека даних>","GROSHI_PSEUDO":"1"}}}}`.
- Пошук `claude`: `where claude` / PATH, далі `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Anthropic.ClaudeCode_*\claude.exe`, `%APPDATA%\npm\claude.cmd`. Пошук `node` — PATH.
- Розбір stream-json: `stream_event` з `content_block_delta.text_delta` → `text`; `assistant` з `tool_use` → `tool` (`name` + `input.query` для WebSearch); `system/init` або `result` → `session` (`session_id`); `result.is_error` або ненульовий код виходу → `error` з останніми рядками stderr; кінець → `done`.
- Один процес за раз (`Mutex<Option<Child>>`); новий `ask`, поки йде попередній → `Err("Порадник ще відповідає")`.
- Процес без вікна консолі (`CREATE_NO_WINDOW` на Windows).

- [ ] **Step 1: cargo-тести в `advisor.rs`:**
  - `cc_args(...)` містить `"--strict-mcp-config"`, `"--tools"` одразу перед `"WebSearch"`, не містить `"WebFetch"` і `"Bash"`; з `session=Some("abc")` містить `["--resume","abc"]`;
  - розбір: рядок `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Привіт"}}}` → `kind=text, text=Привіт`; рядок `result` з `session_id` → `session`; `is_error:true` → `error`;
  - `find_claude` з PATH без claude і порожніми теками → `None`.
- [ ] **Step 2:** `cd desktop/src-tauri && cargo test --release --locked advisor` → FAIL.
- [ ] **Step 3:** Реалізувати; зареєструвати команди; ресурси в `tauri.conf.json`; шаблон у `privacy_check.py`.
- [ ] **Step 4:** `cargo test --release --locked` — усе зелене, включно з `native_csp`; `python -m unittest discover -s tests -p 'test_*.py'` — зелене.
- [ ] **Step 5 (ручна смок-перевірка main loop):** `npm run dev` у `desktop/`, з консолі вебвʼю `__TAURI__.core.invoke('advisor_cc_ask', {req:{conv:'t',prompt:'Скільки в мене підписок?',system:'Відповідай коротко.'}})` — приходять події `tool` (groshi) → `text` → `done`; запит «прочитай файл C:\\Windows\\win.ini» не виконується.

### Task 5: Міст `desktop.js` і заглушка браузера

**Files:**
- Modify: `desktop/dist/desktop.js`, `desktop/build_desktop.py` (якщо треба підключити `pseudo.js` у `index.html` так само, як `mononorm.js`), копія `mcp/pseudo.js` → `desktop/dist/pseudo.js` (сторож рівності за зразком `tests/test_mononorm_sync.py`: `tests/test_pseudo_sync.py`)

**Interfaces:**
- Produces у `window.__DESK__`: `advisorProbe()`, `advisorAsk(req)`, `advisorStop()`, `advisorHist()`, `advisorHistSet(v)`, `onAdvisor(cb)` (обгортка `T.event.listen('advisor', e => cb(e.payload))`). У браузерній збірці `__DESK__` немає — вкладка це перевіряє.
- `window.groshiPseudo` доступний у десктопі до завантаження `app.js`.

- [ ] **Step 1:** `tests/test_pseudo_sync.py` → FAIL (копії немає).
- [ ] **Step 2:** Копія + методи моста → PASS; `python desktop/build_desktop.py` без помилок; `node tests/desktop-csp.mjs` зелене.

### Task 6: Вкладка «Порадник» у шаблоні

**Files:**
- Modify: `app/app.template.html` (навігація `#tabs` ~1787, нова `<section id="tab-advisor" hidden>`, іконка `#i-advisor`, `TABKEYS` ~10003, регекс клавіш `1–8` ~10020, довідка ~10043, `render()`), `tests/nav.mjs` (8 пунктів)
- Test: `tests/advisor.mjs`

**Interfaces:**
- Consumes: міст Task 5, `groshiPseudo` Task 2, наявні `isSpend/spendAmt/isIncome/catOf`, `money()`, `uiConfirm`, `.csel`.
- Produces у шаблоні:
  - `ADV_PROMPT_DEFAULT: string` — стандартна інструкція (текст — за §5 специфікації; зміст пунктів дослівно звідти, включно з: цифри спершу; не вигадувати сум; «для підсумків довіряй зведенню»; псевдоніми не коментувати; інвестиції — варіанти з ризиками й застереженням «не ліцензована порада»; пошукові запити без особистих даних; дата «станом на»; ігнорувати сторонні правила роботи);
  - `advDigest(): string` — зведення за 3 останні повні місяці з поточними налаштуваннями: витрати за місяць і середнє, топ-8 категорій із сумами й зміною до попереднього місяця, підписки ₴/міс, доходи, склад портфеля й частки (з `inv`), дата;
  - `advMd(text): string` — безпечний Markdown (екранування до розмітки; заголовки, списки, жирний, таблиці, код);
  - стан у сховищі: `advisorPrompt` (власна інструкція або `null`), `advisorModel`.
- Розмова: `{ id, title, provider: 'cc', session, created, msgs: [{ role, text, model, tools: string[] }] }`, зберігається через `advisorHistSet`.

Поведінка:
- Вкладка перед «Ще», клавіша `7`, «Ще» — `8`.
- Браузерна збірка: картка «Порадник доступний лише в десктопній версії».
- `advisorProbe` не знайшов `claude`/`node` → картка з кроками встановлення (без системних діалогів).
- Порожня розмова — три кнопки: «Куди йдуть гроші», «Як скоротити витрати», «Що з портфелем і ринком».
- Відправка: `system = hide(prompt + '\n\n' + advDigest())`, `prompt = hide(питання)`; текст подій `text` дописується в останнє повідомлення через `reveal` (накопичувати сирий текст, `reveal` на весь буфер, оновлювати один вузол); `tool` → рядок «дивлюсь: …»; `session` → зберегти в розмову; `done/error` → кнопка «Стоп» ховається.
- Бейдж «хмара · назви приховано» у шапці розмови; підпис моделі під відповіддю.
- Налаштування — розкривний блок у вкладці: модель (порожньо = за замовчуванням), інструкція (textarea + «Повернути стандартну»).
- Список розмов: відкрити, видалити (`uiConfirm`).

- [ ] **Step 1: Проба `tests/advisor.mjs`** (за зразком наявних проб, обидві збірки):
  - браузерна збірка: вкладка `advisor` відкривається клавішею `7`, видно текст «лише в десктопній версії»;
  - десктопна збірка з підробленим мостом (після завантаження підмінити `window.__DESK__.advisor*`; фейковий `advisorAsk` записує `req` і віддає через `onAdvisor` події `tool`, три `text`, `done`):
    - клік «Куди йдуть гроші» → `req.system` містить `Станом на` й суму витрат місяця, яка дорівнює сумі в «Огляді» за той самий місяць на штучних даних;
    - штучний стан з клієнтом `ТОВ "Альфа Груп"`: `req.system` і `req.prompt` (питання «скільки заплатила Альфа Груп?») не містять `Альфа`; у відображеній відповіді, де фейк повернув псевдонім, видно `Альфа Груп`;
    - `getBoundingClientRect()` шапки й поля вводу до та після потоку однакові;
    - подія `text` з `<script>alert(1)</script>` рендериться текстом (немає елемента `script` у списку повідомлень);
    - подія `error` → видно повідомлення, «Стоп» прихований, друге питання відправляється;
    - друге відправлення під час потоку блокується (кнопка неактивна), перемикання на «Огляд» і назад — відповідь дописана повністю.
- [ ] **Step 2:** `node tests/advisor.mjs` → FAIL.
- [ ] **Step 3:** Реалізувати; `python app/build_app.py && python desktop/build_desktop.py`.
- [ ] **Step 4:** `node tests/advisor.mjs`, `node tests/nav.mjs`, `node tests/allcheck.mjs`, `node tests/modal.mjs`, `node tests/pjjump.mjs`, `node tests/nostripe.mjs`, `node tests/overflow.mjs`, `node tests/contrast.mjs` → PASS; `npm test` += `advisor.mjs`.

### Task 7: Документація й приймання етапу

**Files:**
- Modify: `docs/РОЗРОБКА.md` (новий розділ «Порадник» + дата), `tests/README.md`, `mcp/README.md`, `README.md` (рядок про вкладку)

- [ ] **Step 1:** Розділ у РОЗРОБКА.md: навіщо; архітектура (tools.js/pseudo.js/advisor.rs); правила знеособлення й чому без зберігання словника; прапорці `claude` і що перевірено щодо ізоляції від глобального CLAUDE.md; чому `WebFetch` заборонено.
- [ ] **Step 2:** Повний прогін: `npm test`, `python -m unittest discover -s tests -p 'test_*.py' -v`, `cargo test --release --locked`.
- [ ] **Step 3 (власник):** у `npm run dev` поставити три головні питання; переконатися, що відповідь із цифрами, які збігаються з «Оглядом», і що в питанні про ринок є «станом на».
