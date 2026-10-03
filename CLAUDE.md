# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

«Гроші» — особистий фінансовий застосунок (Monobank, IBKR, Binance, підписки,
ФОП, кошториси й рахунки клієнтам). Мова інтерфейсу, коментарів, документації
й відповідей — **українська**.

## Команди

```bash
# Збірка (обидві після БУДЬ-ЯКОЇ зміни шаблону; проби працюють лише зі зібраними файлами)
python app/build_app.py              # → app/Groshi_app.html (браузер, дані вшиті)
python desktop/build_desktop.py      # → desktop/dist/index.html + desktop/dist/app.js

# Проби (Playwright, Chromium)
npm ci && npx playwright install chromium
npm test                             # повний набір, як у CI
node tests/allcheck.mjs              # одна проба; більшість ганяє обидві збірки
CHROMIUM=/path/to/chromium node tests/modal.mjs   # свій Chromium

# Python-тести захисту приватності та збирання
python -m unittest discover -s tests -p 'test_*.py' -v
python scripts/privacy_check.py --staged          # те саме робить pre-commit hook

# Нативна частина (Windows)
cd desktop/src-tauri && cargo test --release --locked
cd desktop && npm ci && npm run build             # інсталятор NSIS
cd desktop && npm run dev                         # tauri dev

# MCP-сервер: самоперевірка читання даних
node mcp/selftest.js
```

Мінімум перед видачею: `allcheck.mjs`, `modal.mjs`, `pjjump.mjs` плюс проба
зміненої поведінки. Тимчасові результати — у `.test-artifacts/`.
Хук `.githooks/pre-commit` має бути підключений: `git config core.hooksPath .githooks`.

## Архітектура

**Один шаблон — дві збірки.** Весь інтерфейс і логіка (~10 тис. рядків HTML/CSS/JS)
живуть в `app/app.template.html`. Підстановки `__GLASSGL__`, `__DESIGNER__`,
`__DATA__`, `__MCCNAME__`, `__META__` заповнюються складачами:

- `app/build_app.py` вшиває `glassgl.js` (WebGL-скло), `designer.js` і дані
  (`dataset.private.json`, якщо є, інакше порожній публічний `dataset.json`)
  в один автономний HTML. Стан — у `localStorage`.
- `desktop/build_desktop.py` робить кілька точкових підмін: `TX` береться з
  `window.__BOOT__`, `store` пише в `state.json` через Tauri (читання синхронне,
  запис із затримкою), додається екран Monobank. Скрипт виноситься в окремий
  `app.js`, бо CSP не допускає inline-скриптів.

Ключова хитрість десктопа: код апки синхронно викликає `store.get()`, тому
`desktop/dist/desktop.js` спершу асинхронно дочитує всі дані з диска в
`window.__BOOT__` і лише тоді завантажує `app.js`. Не переписувати апку на `await`.

У `desktop/dist/` генеруються лише `index.html` і `app.js`. `desktop.js`
(міст: IPC, сповіщення), `mononorm.js` (розбір виписки й категоризація),
`invnorm.js` (розбір Flex XML IBKR і Binance) — вихідний код. `legacy.json` —
порожній seed; непорожній зупиняє збірку.

**Rust-оболонка** (`desktop/src-tauri/src/`): `main.rs` — команди, трей,
автозапуск, синхронізація за розкладом; `mono.rs` — клієнт Monobank (ліміт
1 запит/60 с, вікна по 30 діб, опитування, не вебхук); `ibkr.rs`, `binance.rs`,
`quotes.rs` (Yahoo), `nbu.rs` (курси НБУ); `store.rs` — JSON на диску через
тимчасовий файл; `update.rs` — оновлення з перевіркою Ed25519-підпису
(`update-key.pub`); `native_csp.rs` + `safety.rs` — CSP і захисні перевірки.
Токени — лише в Диспетчері облікових даних Windows.

**MCP** (`mcp/groshi-mcp.js`) — сервер лише для читання даних апки, без
мережевого коду й без коду запису. `mcp/mononorm.js` — копія
`desktop/dist/mononorm.js`; змінюючи одну, синхронізувати другу.

**Приватність.** `scripts/privacy_check.py` блокує коміт приватних файлів
(`*.private.*`, `*_raw.json`, `state.json`, CSV/XML виписок тощо) і секретів;
публічні seed-файли (`dataset.json`, `meta.json`, `legacy.json`) мусять
лишатися порожніми. Проби використовують лише штучні дані.

**CI** (`.github/workflows/build.yml`): privacy + unittest → `npm test` на
Linux → `cargo test` і `desktop-csp.mjs` на Windows → підписаний інсталятор
лише для теґів `v*` / ручного запуску. Версія — у
`desktop/src-tauri/tauri.conf.json`.

## Налаштування Claude Code (`.claude/`)

- Хук `guard.py` блокує запис у згенеровані та приватні файли, системні
  елементи UI в новому тексті й `git add -A`/`.`; `build.py` після правки
  шаблону сам перезбирає обидві версії. Відмова сторожа — правило проєкту,
  а не збій: виправляти підхід, не обходити хук.
- `/release <версія>` — підготовка релізу до підпису; підпис, теґ і пуш — лише
  коли власник прямо попросив випустити саме цю версію; `new-probe` — нова
  проба з реєстрацією; агент `groshi-rules-reviewer` — рецензія диффу на
  правила проєкту перед «готово». Подробиці — §10ґ `docs/РОЗРОБКА.md`.

## Правила проєкту

- **Документація разом із кодом.** Нова можливість, зміна структури даних,
  нове правило чи показове виправлення → розділ у `docs/РОЗРОБКА.md` (з причиною)
  і дата «Оновлено» вгорі. Там же — історія рішень: перш ніж міняти поведінку,
  пошукати, чому її зробили саме так. Таблиця проб у §9 цього файлу частково
  історична (згадує `/tmp/build/`); чинні проби — у `tests/`.
- **Жодного системного вигляду:** не використовувати `prompt/confirm/alert`,
  нативний `<select>`, `<input type="date">`, `<input list>`, системний
  checkbox, атрибут `title`. Заміни: `uiAsk()`/`uiConfirm()`/`uiPick()`,
  `.csel`, `buildCombo()`, `SD`/`DP`, `data-tip` (§5 `РОЗРОБКА.md`).
  `modal.mjs` це сторожить.
- **Нічого не смикається:** перемальовувати на місці замість `innerHTML =`,
  якщо елемент лишається; фіксувати ширину змінного тексту; після змін UI
  звіряти `getBoundingClientRect()` до й після.
- **Збереження файлів** — тільки через `download()`: власний `Blob` +
  `<a download>` у WebView2 мовчки не працює.
- **Коментарі пояснюють чому** (симптом і причина рішення), а не що.
- Наприкінці роботи, якщо потрібні ручні дії, — блок «Що зробити» з точними
  кроками; якщо ні — прямо сказати це.
