# Порадник · етапи 2–3 (локальна модель + API Anthropic) — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** у вкладці «Порадник» з'являються ще два способи підключення: локальна модель (LM Studio, OpenAI-сумісний API на localhost) і API Anthropic з ключем у Диспетчері облікових даних; обидва користуються тими самими інструментами MCP «Гроші».

**Architecture:** Rust запускає наш MCP-сервер (`node <resources>/mcp/groshi-mcp.js`) як дочірній процес і сам крутить цикл «модель → інструмент → модель» (до 8 кроків). Локальний спосіб — `POST /v1/chat/completions` зі стрімом (SSE) і `tools` у форматі OpenAI, MCP без знеособлення. API — `POST https://api.anthropic.com/v1/messages` зі стрімом, нашими інструментами, серверним веб-пошуком і MCP із `GROSHI_PSEUDO=1`. Події — ті самі `"advisor"` `{conv, kind, text}`; вкладка вибирає спосіб для нової розмови.

**Tech Stack:** Rust (reqwest 0.12 без нових фіч: `Response::chunk()`, tokio, serde_json, keyring), Node MCP (без змін протоколу), vanilla JS у шаблоні, Playwright, cargo test з мок-HTTP-сервером на `std::net::TcpListener`.

**Spec:** `docs/superpowers/specs/2026-10-17-poradnyk-design.md` (§4.2, §4.4 B/C, §4.4а, §5, §6, §7). Етап 1 — `docs/superpowers/plans/2026-10-18-poradnyk-stage1.md`, уже в `main`.

## Global Constraints

- Нових crate-ів не додавати; стрім читати через `reqwest::Response::chunk()`. CSP у `tauri.conf.json` не змінюється, `native_csp.rs` зелений. Мережа й процеси — лише з Rust.
- **Ключ API** — лише Диспетчер облікових даних (`broker_entry("anthropic-key")`); жодна команда його не повертає; він не потрапляє в події, журнали, помилки, файли, JS.
- **Локальна адреса** — лише `http://` або `https://` на `localhost`, `127.0.0.1`, `[::1]`; інше → помилка «лише локальна адреса». Без редиректів (`Policy::none()`).
- **Хмарні способи** (Claude Code і API) працюють лише коли увімкнено сервіс `advisor` у `privacyServices` (Rust: `require_service(&st, "advisor")`; UI: рядок у `PRIVACY_OPTIONS`). Локальний — без цього перемикача.
- MCP для API запускається з `GROSHI_PSEUDO=1`; для локальної моделі — без нього (дані не виходять з машини). Текст питань і зведення для API — через `groshiPseudo.hide`, відповідь — через `reveal`.
- Один запуск порадника за раз на всі способи; «Стоп» зупиняє будь-який.
- Цикл інструментів — не більше 8 кроків; далі — подія `error` «забагато кроків».
- Модель API за замовчуванням `claude-opus-5-5`, `output_config.effort: "medium"`, `max_tokens: 32000`, стрім; веб-пошук `{"type":"web_search_20260209","name":"web_search","max_uses":5}`; заголовки `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-beta: server-side-fallback-2026-07-01` + тіло `"fallbacks":"default"`. Не надсилати `thinking:{type:"disabled"}`, `budget_tokens`, `temperature`, примусовий `tool_choice`.
- **Історія API тільки дописується**: асистентські повідомлення зберігаються повними масивами `content` (зокрема `thinking`, `server_tool_use`, `web_search_tool_result`, `fallback`) і надсилаються назад без змін; старі ходи не редагуються. Зберігається знеособлена форма (як пішла в API).
- Жодного системного вигляду; без кольорових смуг; потік дописується на місці (правила етапу 1).
- Коментарі українською, пояснюють чому. Сабагенти не комітять.

## Review Focus

1. Ключ API не з'являється ніде, крім заголовка `x-api-key`: ні в `Err(...)`, ні в подіях, ні в `Debug`-виводі. Тест у Task 3.
2. Локальна адреса з редиректом або з userinfo-трюком (`localhost`, далі `@` і чужий хост) відхиляється. Тест у Task 2.
3. Обрив стріму посеред відповіді (сервер закрив з'єднання) → подія `error`, слот звільнено, наступний запит працює. Тест у Task 2 (мок).
4. Модель зациклилась на інструментах → після 8 кроків `error`, MCP-процес убито. Тест у Task 2.
5. Перемикання способу посеред розмови неможливе; нова розмова іншим способом не тягне історію попередньої. Тест у Task 4.

---

### Task 1: MCP-клієнт у Rust

**Files:**
- Create: `desktop/src-tauri/src/advisor_mcp.rs`
- Modify: `desktop/src-tauri/src/main.rs` (`mod advisor_mcp;`)

**Interfaces:**
- Consumes: шлях до `mcp/groshi-mcp.js` у ресурсах і пошук `node` — як в `advisor.rs` (винести спільні функції, якщо там приватні).
- Produces:
  - `pub struct Mcp` з `pub fn start(node: &Path, script: &Path, data_dir: &Path, pseudo: bool) -> Result<Mcp, String>` (initialize + `notifications/initialized`), `pub fn tools(&mut self) -> Result<Vec<McpTool>, String>`, `pub fn call(&mut self, name: &str, args: &Value) -> Result<(String, bool /*is_error*/), String>`, `Drop` убиває процес (дерево на Windows — як `kill_tree`).
  - `pub struct McpTool { pub name: String, pub description: String, pub input_schema: Value }`.
  - Таймаут відповіді на виклик — 30 с → `Err`.

- [ ] **Step 1: Тести (`#[cfg(test)]`):** на штучній теці (створити в `std::env::temp_dir()` порожню теку) реальний `node` + `mcp/groshi-mcp.js` з дерева репозиторію (`CARGO_MANIFEST_DIR/../../mcp`): `tools()` повертає 11 імен і містить `market`; `call("groshi_status", {})` → текст з «Тека даних: прихована» при `pseudo=true` і без нього при `false`; `call("nope", {})` → `Err` або `is_error`. Якщо `node` не знайдено — тест друкує «пропущено: немає node» і проходить.
- [ ] **Step 2:** `cargo test --release --locked advisor_mcp` → FAIL.
- [ ] **Step 3:** Реалізувати (рядковий JSON-RPC через stdin/stdout, окремий потік читання з каналом, `CREATE_NO_WINDOW`).
- [ ] **Step 4:** PASS; увесь `cargo test` зелений.

### Task 2: Локальна модель (LM Studio)

**Files:**
- Create: `desktop/src-tauri/src/advisor_local.rs`
- Modify: `desktop/src-tauri/src/advisor.rs` (спільний слот/стоп, якщо потрібно), `desktop/src-tauri/src/main.rs` (команди)

**Interfaces:**
- Consumes: `Mcp` (Task 1); `emit` подій `"advisor"` і слот одного запуску з `advisor.rs`.
- Produces (Tauri-команди):
  - `advisor_local_models(url: String) -> Result<Vec<String>, String>` — `GET {url}/models`, поле `data[].id`;
  - `advisor_local_ask(req: LocalReq) -> Result<(), String>`, `LocalReq = { conv: String, messages: Vec<{role, content}>, system: String, url: String, model: String, tools: bool }` — повертається одразу, далі події `text` / `tool` / `done` / `error`.
- Чисті функції для тестів: `pub fn local_url(url: &str) -> Result<reqwest::Url, String>`; `pub struct SseLines` (буферизований розбір `data: …` з чанків, `[DONE]`); `fn openai_tools(tools: &[McpTool]) -> Value` (`{type:"function", function:{name, description, parameters}}`); накопичення `delta.tool_calls[i].function.arguments` за індексом.

Поведінка: системне повідомлення = `system`; історія `messages`; при `tools=true` — `tools` з MCP (без знеособлення), цикл: стрім → якщо `finish_reason=="tool_calls"`, для кожного виклику подія `tool` (назва), `Mcp::call`, повідомлення `{role:"tool", tool_call_id, content}` → новий запит; до 8 кроків. При `tools=false` MCP не запускається. Між чанками — таймаут 120 с. «Стоп» перериває читання й убиває MCP.

- [ ] **Step 1: Тести:**
  - `local_url`: приймає `http://localhost:1234/v1`, `http://127.0.0.1:1234/v1`, `http://[::1]:1234/v1`; відхиляє `http://192.168.1.5:1234`, `https://api.openai.com/v1`, адресу з userinfo (`localhost` + `@` + чужий хост; рядок складати в тесті через `format!`, щоб сторож приватності не бачив пошти), `file:///c:/x`;
  - `SseLines`: чанки, розрізані посеред рядка, дають ті самі події; `data: [DONE]` завершує;
  - накопичення двох частин `arguments` одного `tool_calls[0]` дає валідний JSON;
  - мок-сервер (`TcpListener` на `127.0.0.1:0`, відповідає SSE): (а) звичайна відповідь → події `text…`, `done`; (б) перша відповідь `tool_calls` `groshi_status`, друга — текст → є подія `tool`, далі `text`, `done` (з реальним MCP, або пропуск без node); (в) сервер шле `tool_calls` щоразу → після 8 кроків `error`; (г) сервер рве з'єднання посеред стріму → `error`, слот вільний (наступний `ask` приймається).
- [ ] **Step 2:** FAIL → **Step 3:** реалізувати → **Step 4:** PASS, `cargo test` зелений.

### Task 3: API Anthropic

**Files:**
- Create: `desktop/src-tauri/src/advisor_api.rs`
- Modify: `desktop/src-tauri/src/main.rs` (команди; `require_service(&st, "advisor")` також у `advisor_cc_ask`), `tests/test_privacy_check.py` лише якщо треба

**Interfaces:**
- Consumes: `Mcp` (Task 1, `pseudo=true`), слот/події з `advisor.rs`, `broker_entry` з `main.rs`.
- Produces:
  - `advisor_key_has() -> bool`; `advisor_key_set(key: String) -> Result<(), String>` — перевіряє ключ `GET https://api.anthropic.com/v1/models?limit=1` (200 → зберегти; 401 → «Ключ не підійшов»; інше → «Не вдалося перевірити ключ: HTTP <код>»); `advisor_key_clear()`.
  - `advisor_api_ask(req: ApiReq) -> Result<(), String>`, `ApiReq = { conv: String, messages: Value /*масив Messages API, знеособлений*/, system: String, model: Option<String> }`. Події: `text`, `tool`, `done`, `error`, плюс **`state`** — у `text` JSON-масив повідомлень, які треба дописати в історію розмови (асистентські `content` повністю + `tool_result`-повідомлення), рівно один раз перед `done`.
- Чисті функції: `fn api_body(model, system, messages, tools) -> Value` (значення з Global Constraints; наші інструменти як `{name, description, input_schema}` + web_search); `struct MsgStream` — розбір SSE Messages API (`message_start`, `content_block_start` з `text`/`tool_use`/`server_tool_use`/`web_search_tool_result`/`thinking`/`fallback`, `content_block_delta` з `text_delta`/`input_json_delta`/`thinking_delta`/`signature_delta`, `content_block_stop`, `message_delta` зі `stop_reason`, `error`), що збирає повний `content` асистента.

Поведінка циклу: `stop_reason=="tool_use"` → для кожного нашого `tool_use` подія `tool`, `Mcp::call`, один user-повідомлення з усіма `tool_result` (`is_error` для помилок) → повтор; `pause_turn` → повтор з тим самим асистентським ходом; `refusal` → `error` «Модель відмовилась відповідати»; `max_tokens` → дописати й `done`; до 8 кроків. `web_search` (`server_tool_use`) → подія `tool` з `WebSearch: <query>`. HTTP 401/403 → `error` «Ключ API не підійшов», 429 → «Ліміт запитів, спробуйте пізніше», 5xx → «Сервіс Anthropic недоступний»; тіло помилки не пересилати сирим.

- [ ] **Step 1: Тести:**
  - `api_body`: модель за замовчуванням `claude-opus-5-5`, `stream:true`, `fallbacks:"default"`, `output_config.effort:"medium"`, інструмент `web_search_20260209` з `max_uses:5`; немає `thinking`, `temperature`, `tool_choice`;
  - `MsgStream` на фікстурі (текст + `tool_use` з двома `input_json_delta` + `thinking` із `signature_delta`) → повний `content` з `tool_use.input` як об'єкт і незміненим `thinking`;
  - мок-сервер Messages API (адреса API — параметр функції циклу, у командах — константа): (а) текст → `text`, `state`, `done`; (б) `tool_use` `groshi_status` → другий запит містить асистентський `content` без змін і `tool_result` з тим самим `tool_use_id`; (в) 401 → `error` з «Ключ API не підійшов», а рядок ключа (`sk-test-SECRET`) не трапляється в жодній події й у `Err`;
  - `advisor_cc_ask`/`advisor_api_ask` при вимкненому `advisor` → `Err` з «Увімкніть Порадника в Ще → Підключення» (тест на рівні функції-перевірки).
- [ ] **Step 2:** FAIL → **Step 3:** реалізувати → **Step 4:** PASS, `cargo test` зелений.

### Task 4: Міст і вкладка: вибір способу, налаштування, історія

**Files:**
- Modify: `desktop/dist/desktop.js`, `app/app.template.html`, `tests/advisor.mjs`, `tests/helpers/desktop-boot.mjs` (за потреби)

**Interfaces:**
- Consumes: команди Tasks 2–3.
- Produces у `__DESK__`: `advisorLocalModels(url)`, `advisorLocalAsk(req)`, `advisorApiAsk(req)`, `advisorKeyHas()`, `advisorKeySet(key)`, `advisorKeyClear()`.
- Шаблон: `PRIVACY_OPTIONS` += `['advisor','Порадник у хмарі','Anthropic (Claude Code або API): ваші питання, знеособлене зведення витрат і портфеля; назви клієнтів, проєктів і платників приховано.']`; `ADV_PROMPT_LOCAL` — додаток до інструкції за §5 специфікації (суворий формат: короткі розділи, таблиця цифр, спершу перечитати зведення, приклади добрих відповідей на три головні питання, без довгих міркувань); розмова отримує поле `provider: 'cc'|'local'|'api'` і для `api` — `api: []` (знеособлені повідомлення, лише дописуються з події `state`).

Поведінка:
- Перемикач способу (`.csel`: «Claude Code», «Локальна модель», «API Anthropic») у шапці; змінює спосіб лише для нової/порожньої розмови; у розмові з повідомленнями показується як бейдж, недоступний для зміни.
- Бейдж приватності: `cc`/`api` → «хмара · назви приховано»; `local` → «локально».
- `cc` і `api` при вимкненому `advisor` → картка «Порадник у хмарі вимкнено» з кнопкою «Увімкнути» (вмикає той самий ключ, що й «Ще → Підключення») замість поля вводу.
- `local`: зведення й питання **без** `hide`; `system = ADV_PROMPT (або власна) + ADV_PROMPT_LOCAL + зведення`; `messages` — історія розмови як `{role, content}` (текст); налаштування: адреса (за замовчуванням `http://localhost:1234/v1`), модель (`buildCombo` зі списку `advisorLocalModels`, кнопка «Оновити список»), власний checkbox «З інструментами» (за замовчуванням увімкнено). Сервер недоступний → підказка «Запустіть сервер у LM Studio (Developer → Start Server) або `lms server start`».
- `api`: `messages = conv.api.concat([{role:'user', content: hide(питання)}])`, `system = hide(інструкція + зведення)`; подія `state` дописує масив у `conv.api` (і питання користувача теж); відображення через `reveal`. Налаштування: «Ключ API: збережено / не збережено», кнопки «Зберегти ключ…» (`uiAsk` з полем; значення одразу в `advisorKeySet`, ніде не зберігається в JS-стані) і «Видалити ключ» (`uiConfirm`); модель (поле, порожнє = `claude-opus-5-5`).
- Підпис під відповіддю: «Claude Code · …», «LM Studio · <модель>», «API · <модель>».

- [ ] **Step 1: Проба `tests/advisor.mjs` (дописати):**
  - вибір «Локальна модель» у новій розмові → `advisorLocalAsk` отримує `req.system` зі справжньою назвою клієнта (немає `hide`) і бейдж «локально»; після першого повідомлення перемикач способу недоступний;
  - «API Anthropic» з вимкненим `advisor` → картка вимкнення, поле вводу сховане; «Увімкнути» → поле видно;
  - API: `req.system`/`req.messages` без «Альфа»; фейк шле `state` з двома повідомленнями → `__hist` містить їх у `api`; друге питання надсилає `messages` = попередні 3 + нове (тільки дописування);
  - «Зберегти ключ…» викликає `advisorKeySet` із введеним значенням, а значення не з'являється ні в `__hist`, ні в `localStorage`, ні в DOM після закриття вікна;
  - нова розмова іншим способом не містить історії попередньої.
- [ ] **Step 2:** FAIL → **Step 3:** реалізувати; обидві збірки + synthetic pretest → **Step 4:** `advisor.mjs`, `nav.mjs`, `allcheck.mjs`, `modal.mjs`, `nostripe.mjs`, `overflow.mjs`, `contrast.mjs` → PASS.

### Task 5: Документація й повний прогін

**Files:** `docs/РОЗРОБКА.md` (§10й доповнити етапами 2–3: архітектура циклу, чому історія API лише дописується, чому `advisor` у «Підключеннях», чому локальна адреса лише localhost, відкриті питання живої перевірки), `tests/README.md`, `README.md` (рядок про три способи), `CLAUDE.md` (нові модулі Rust).

- [ ] **Step 1:** Документація.
- [ ] **Step 2:** `npm test`, `python -m unittest discover -s tests -p "test_*.py" -v`, `cargo test --release --locked` — усе зелене; підсумки — у звіт.
