// Гроші — десктопна версія.
// Вікно з інтерфейсом, дані на диску, банк напряму, без жодного сервера.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod binance;
mod ibkr;
mod mono;
mod nbu;
mod quotes;
mod safety;
mod store;
mod update;

#[cfg(test)]
mod native_csp;

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use store::Store;
use tauri_plugin_dialog::DialogExt;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State, WindowEvent,
};

const KEYRING_SERVICE: &str = "Groshi";
const KEYRING_USER: &str = "monobank-token";

struct App {
    st: Arc<Store>,
    base: std::path::PathBuf,   // стандартна тека; там же лежить покажчик
    grants: Mutex<safety::Grants>,

    busy: Arc<Mutex<bool>>, // синхронізація одна за раз: ліміт банку спільний
    stop: Arc<std::sync::atomic::AtomicBool>, // «Зупинити» під час довгої історії
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

fn service_enabled(st: &Store, name: &str) -> bool {
    st.state().get("privacyServices").and_then(|v| v.get(name)).and_then(|v| v.as_bool()) == Some(true)
}

fn require_service(st: &Store, name: &str) -> Result<(), String> {
    if service_enabled(st, name) { Ok(()) }
    else { Err("Цей зовнішній сервіс вимкнено в налаштуваннях приватності".into()) }
}

fn validate_backup_preference(app: &App, value: &Value) -> Result<(), String> {
    let dir = value.as_str().ok_or("Потрібен шлях до теки резервних копій")?;
    if !dir.is_empty() {
        app.grants.lock().map_err(|_| "Дозволи тек недоступні")?
            .directory(std::path::Path::new(dir))?;
    }
    Ok(())
}

#[tauri::command]
async fn pick_file(handle: tauri::AppHandle, app: State<'_, App>, kind: String) -> Result<Option<String>, String> {
    let kind = safety::FileKind::parse(&kind)?;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle.dialog().file().add_filter("Файл імпорту", kind.extensions()).blocking_pick_file()
    }).await.map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let path = app.grants.lock().map_err(|_| "Дозволи файлів недоступні")?.add_file(&path, kind)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
async fn pick_directory(handle: tauri::AppHandle, app: State<'_, App>, title: Option<String>) -> Result<Option<String>, String> {
    let title = title.unwrap_or_else(|| "Виберіть теку".into());
    if title.len() > 200 || title.chars().any(char::is_control) { return Err("Некоректний заголовок діалогу".into()); }
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle.dialog().file().set_title(title).blocking_pick_folder()
    }).await.map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let path = app.grants.lock().map_err(|_| "Дозволи тек недоступні")?.add_directory(&path)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// ─────────────────────────────── токен

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}
fn token_get() -> Result<String, String> {
    entry()?.get_password().map_err(|_| "Токен не збережено".to_string())
}

#[tauri::command]
fn token_has() -> bool {
    token_get().is_ok()
}

/// Токен зберігається лише після того, як банк його прийняв: інакше в
/// сховище лягав би мотлох, а помилку було б видно аж під час синхронізації.
#[tauri::command]
async fn token_set(token: String) -> Result<Value, String> {
    let t = token.trim().to_string();
    if t.is_empty() {
        return Err("Порожній токен".into());
    }
    let (acc, owner) = mono::accounts(&t).await?;
    entry()?.set_password(&t).map_err(|e| e.to_string())?;
    Ok(json!({ "accounts": acc, "owner": owner }))
}

#[tauri::command]
fn token_clear() -> Result<(), String> {
    let e = entry()?;
    let _ = e.delete_credential();
    Ok(())
}

// ─────────────────────────────── брокери: тільки читання
//
// Ключі живуть там само, де токен банку: Диспетчер облікових даних
// Windows. У файли не потрапляють ніколи. Пара значень (токен+queryId в
// IBKR, ключ+секрет у Binance) зберігається одним записом через \n —
// два записи в keyring означали б два шанси розсинхронізуватись.

fn broker_entry(user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, user).map_err(|e| e.to_string())
}
fn broker_get(user: &str) -> Result<(String, String), String> {
    let raw = broker_entry(user)?
        .get_password()
        .map_err(|_| "Ключ не збережено".to_string())?;
    let mut it = raw.splitn(2, '\n');
    let a = it.next().unwrap_or("").to_string();
    let b = it.next().unwrap_or("").to_string();
    Ok((a, b))
}

#[tauri::command]
fn ibkr_has() -> bool {
    broker_get("ibkr-flex").is_ok()
}

/// Зберігаємо після того, як IBKR прийняв токен і знайшов звіт — так
/// само, як token_set робить із банком. ВИНЯТОК: «Too many failed
/// attempts». Це блокування РАХУНКУ, а не вирок токену: якщо відмовити
/// у збереженні, людина застрягає в колі — новий токен не зберігся,
/// апка ганяє старий, кожна спроба продовжує блок (реальний випадок).
/// Тому при блокуванні токен зберігаємо, а перевірку відкладаємо:
/// повертаємо {deferred, msg}, і фронтенд НЕ тягне звіт одразу.
#[tauri::command]
async fn ibkr_set(token: String, query_id: String) -> Result<Value, String> {
    let t = token.trim();
    let q = query_id.trim();
    if t.is_empty() || q.is_empty() {
        return Err("Потрібні і токен, і Query ID".into());
    }
    let save = || {
        broker_entry("ibkr-flex")
            .and_then(|e| e.set_password(&format!("{t}\n{q}")).map_err(|e| e.to_string()))
    };
    match ibkr::check(t, q).await {
        Ok(()) => {
            save()?;
            Ok(json!({ "ok": true }))
        }
        Err(e) if e.contains("заблокував Flex-сервіс") => {
            save()?;
            Ok(json!({ "deferred": true, "msg": e }))
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn ibkr_clear() -> Result<(), String> {
    let _ = broker_entry("ibkr-flex")?.delete_credential();
    Ok(())
}

/// «Оновити зараз» пише свіжий 365-денний звіт у головний слот, а
/// імпортовані XML за старіші періоди (extra) ЗБЕРІГАЄ — вони і є
/// глибока історія, веб-сервіс її не віддає.
#[tauri::command]
async fn ibkr_sync(app: State<'_, App>) -> Result<Value, String> {
    let (t, q) = broker_get("ibkr-flex")?;
    let xml = ibkr::fetch(&t, &q).await?;
    let prev = app.st.read("ibkr_raw.json");
    let extra = prev.get("extra").cloned().unwrap_or(json!([]));
    let out = json!({ "xml": xml, "fetched": now(), "extra": extra });
    app.st.write("ibkr_raw.json", &out)?;
    Ok(json!({ "fetched": now(), "bytes": out["xml"].as_str().map(|s| s.len()).unwrap_or(0) }))
}

/// Імпорт XML руками. Flex-звіт обмежений 365 днями, а інвестують
/// роками — тому імпортовані файли НАКОПИЧУЮТЬСЯ (extra), а не
/// замінюють один одного: у порталі можна зробити запит за кожен
/// старіший рік і склеїти всю історію. Перший файл (коли головного
/// слоту ще нема) стає головним; однаковий вміст не дублюється.
#[tauri::command]
fn ibkr_import(app: State<App>, path: String) -> Result<Value, String> {
    let path = app.grants.lock().map_err(|_| "Дозволи файлів недоступні")?
        .consume_file(std::path::Path::new(&path), safety::FileKind::Xml)?;
    let xml = String::from_utf8(safety::read_import(&path)?)
        .map_err(|_| "XML має бути у кодуванні UTF-8".to_string())?;
    if !xml.contains("<FlexQueryResponse") {
        return Err("Це не Flex-звіт IBKR: у файлі немає FlexQueryResponse. \
                    Потрібен XML, який портал віддає кнопкою Run на вашому query.".into());
    }
    let prev = app.st.read("ibkr_raw.json");
    let main = prev.get("xml").and_then(|x| x.as_str()).unwrap_or("");
    let mut extra: Vec<Value> = prev
        .get("extra")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let out;
    if main.is_empty() {
        out = json!({ "xml": xml, "fetched": now(), "imported": true, "extra": extra });
    } else {
        if main != xml && !extra.iter().any(|e| e.as_str() == Some(xml.as_str())) {
            extra.push(json!(xml));
        }
        if extra.len() > 10 {
            let cut = extra.len() - 10;
            extra.drain(..cut);          // стеля: 10 додаткових файлів
        }
        out = json!({
            "xml": main, "fetched": prev.get("fetched").cloned().unwrap_or(json!(now())),
            "imported": prev.get("imported").cloned().unwrap_or(json!(false)),
            "extra": extra,
        });
    }
    app.st.write("ibkr_raw.json", &out)?;
    let n = out.get("extra").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
    Ok(json!({ "fetched": now(), "extra": n }))
}

/// Прибрати всі імпортовані додаткові XML, лишивши головний звіт.
#[tauri::command]
fn ibkr_import_clear(app: State<App>) -> Result<(), String> {
    let mut prev = app.st.read("ibkr_raw.json");
    if let Some(o) = prev.as_object_mut() {
        o.remove("extra");
        return app.st.write("ibkr_raw.json", &prev);
    }
    Ok(())
}

#[tauri::command]
fn binance_has() -> bool {
    broker_get("binance-key").is_ok()
}

/// Перевірка прав ідЕ ДО збереження: ключ із торгівлею чи виведенням
/// сюди не потрапить узагалі.
#[tauri::command]
async fn binance_set(key: String, secret: String) -> Result<Value, String> {
    let k = key.trim();
    let s = secret.trim();
    if k.is_empty() || s.is_empty() {
        return Err("Потрібні і ключ, і секрет".into());
    }
    let perms = binance::check(k, s).await?;
    broker_entry("binance-key")?
        .set_password(&format!("{k}\n{s}"))
        .map_err(|e| e.to_string())?;
    Ok(perms)
}

#[tauri::command]
fn binance_clear() -> Result<(), String> {
    let _ = broker_entry("binance-key")?.delete_credential();
    Ok(())
}

#[tauri::command]
async fn binance_sync(app: State<'_, App>) -> Result<Value, String> {
    let (k, s) = broker_get("binance-key")?;
    let data = binance::fetch(&k, &s).await?;
    app.st.write("binance_raw.json", &data)?;
    Ok(json!({ "fetched": now() }))
}

/// Котирування Yahoo для акцій: фронтенд передає символи з біржею
/// лістингу і закешованим Yahoo-імʼям; результат лягає у quotes.json,
/// щоб вкладка відкривалась зі свіжими цінами і без мережі.
#[tauri::command]
async fn quotes_sync(app: State<'_, App>, symbols: Vec<Value>) -> Result<Value, String> {
    require_service(&app.st, "quotes")?;
    let list: Vec<(String, String, Option<String>)> = symbols
        .iter()
        .filter_map(|s| {
            let sym = s.get("sym")?.as_str()?.to_string();
            let exch = s.get("exch").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let ysym = s.get("ysym").and_then(|x| x.as_str()).map(String::from);
            Some((sym, exch, ysym))
        })
        .collect();
    if list.is_empty() {
        return Err("Немає символів для котирувань".into());
    }
    let out = quotes::fetch(list).await?;
    app.st.write("quotes.json", &out)?;
    Ok(out)
}

#[tauri::command]
fn quotes_cached(app: State<App>) -> Value {
    let v = app.st.read("quotes.json");
    if v.is_object() { v } else { Value::Null }
}

/// Картка акції: один символ, один діапазон (1d/5d/1mo/6mo/1y/5y).
#[tauri::command]
async fn quote_detail(app: State<'_, App>, ysym: String, range: String) -> Result<Value, String> {
    require_service(&app.st, "quotes")?;
    quotes::detail(&ysym, &range).await
}

#[tauri::command]
async fn quote_news(app: State<'_, App>, ysym: String, uk: Option<bool>) -> Result<Value, String> {
    require_service(&app.st, "news")?;
    quotes::news(&ysym, uk.unwrap_or(false) && service_enabled(&app.st, "translation")).await
}

/// Внутрішньоденний рух набору паперів — для вікна «Сьогодні» у динаміці.
#[tauri::command]
async fn quotes_today(app: State<'_, App>, symbols: Vec<Value>) -> Result<Value, String> {
    require_service(&app.st, "quotes")?;
    let list: Vec<(String, String)> = symbols
        .iter()
        .filter_map(|s| {
            let sym = s.get("sym")?.as_str()?.to_string();
            let ysym = s.get("ysym").and_then(|x| x.as_str()).unwrap_or(&sym).to_string();
            Some((sym, ysym))
        })
        .collect();
    if list.is_empty() {
        return Err("Немає символів".into());
    }
    quotes::today(list).await
}

/// Курси НБУ на дати операцій — для податків (ПКУ вимагає курс НБУ на
/// дату КОЖНОЇ операції) і розкладу прибутку «папери проти курсу».
/// Історичний курс не змінюється ніколи, тому кеш nbu_rates.json
/// вічний: тягнемо лише дати, яких у ньому ще немає.
#[tauri::command]
async fn nbu_rates(app: State<'_, App>, items: Vec<Value>) -> Result<Value, String> {
    let cur = app.st.read("nbu_rates.json");
    let mut map = cur.as_object().cloned().unwrap_or_default();
    let list: Vec<(String, String)> = items
        .iter()
        .filter_map(|s| {
            let ccy = s.get("ccy")?.as_str()?.to_uppercase();
            let date = s.get("date")?.as_str()?.to_string();
            Some((ccy, date))
        })
        .filter(|(c, d)| !map.contains_key(&format!("{c}:{d}")))
        .collect();
    if !list.is_empty() {
        if let Value::Object(got) = nbu::rates(list).await {
            for (k, v) in got {
                map.insert(k, v);
            }
        }
        app.st.write("nbu_rates.json", &Value::Object(map.clone()))?;
    }
    Ok(Value::Object(map))
}

/// Прочитати вибраний користувачем файл як base64 — для імпорту виписки
/// ПриватБанку: CSV звідти буває у windows-1251, тож текстом читати не
/// можна, а розкодовує фронтенд (TextDecoder знає всі кодування).
#[tauri::command]
fn file_b64(app: State<App>, path: String) -> Result<String, String> {
    let path = app.grants.lock().map_err(|_| "Дозволи файлів недоступні")?
        .consume_file(std::path::Path::new(&path), safety::FileKind::Statement)?;
    let bytes = safety::read_import(&path)?;
    Ok(quotes::b64(&bytes))
}

/// Зберегти експорт у «Завантаження». Автозапуск HTML/CSV може виконати
/// активний вміст поза обмеженнями WebView, тому відкриває файл сама людина.
/// НАВІЩО: браузерний шлях `<a download>` + Blob у WebView2 мовчки
/// заблокований — «Створити рахунок» і всі експорти в десктопі
/// закінчувались нічим (реальний випадок). Rust пише файл сам.
#[tauri::command]
fn save_text(app_handle: tauri::AppHandle, name: String, text: String) -> Result<String, String> {
    let dir = app_handle
        .path()
        .download_dir()
        .map_err(|e| format!("тека «Завантаження»: {e}"))?;
    let path = safety::save_export(&dir, &name, &text)?;
    Ok(path.to_string_lossy().to_string())
}

/// Логотипи компаній: домен приходить із профілю Yahoo (quotes_sync),
/// картинка тягнеться раз і лягає data-URL-ом у logos.json — далі
/// вкладка малює їх без мережі. false у кеші означає «шукали, нема»,
/// щоб не повторювати марні запити щозапуску.
#[tauri::command]
async fn logos_sync(app: State<'_, App>, items: Vec<Value>) -> Result<Value, String> {
    require_service(&app.st, "logos")?;
    let cur = app.st.read("logos.json");
    let mut map = cur.as_object().cloned().unwrap_or_default();
    // Знайдені логотипи не перекачуються; давні невдачі (false) —
    // пробуються знову: джерела з часом міняються (Clearbit помер,
    // Parqet зʼявився), і «не знайшли тоді» не означає «нема тепер».
    let list: Vec<(String, Option<String>, String)> = items
        .iter()
        .filter_map(|s| {
            let sym = s.get("sym")?.as_str()?.to_string();
            let dom = s.get("domain").and_then(|x| x.as_str()).map(String::from);
            let kind = s.get("kind").and_then(|x| x.as_str()).unwrap_or("stock").to_string();
            Some((sym, dom, kind))
        })
        .filter(|(sym, _, _)| !map.get(sym).and_then(|v| v.as_str()).map(safety::raster_data_url).unwrap_or(false))
        .collect();
    if !list.is_empty() {
        if let Value::Object(got) = quotes::logos(list).await {
            for (k, v) in got {
                let safe = v.as_str().map(safety::raster_data_url).unwrap_or(false);
                map.insert(k, if safe { v } else { json!(false) });
            }
        }
    }
    let v = Value::Object(map);
    app.st.write("logos.json", &v)?;
    Ok(v)
}

/// Бекап даних: копія всіх JSON-файлів у теку `backup-РРРР-ММ-ДД`.
/// Без архіватора — файли й так дрібні, а теку можна відкрити оком.
/// Тримаємо 8 останніх: старіші тихо прибираються.
#[tauri::command]
fn backup_run(app: State<App>, dir: Option<String>) -> Result<Value, String> {
    let target_root = match dir.filter(|d| !d.is_empty()) {
        Some(d) => app.grants.lock().map_err(|_| "Дозволи тек недоступні")?.directory(std::path::Path::new(&d))?,
        None => {
            let root = safety::directory(&app.st.dir)?.join("backups");
            safety::reject_links(&root)?;
            if !root.exists() { std::fs::create_dir(&root).map_err(|e| e.to_string())?; }
            safety::directory(&root)?
        }
    };
    safety::check_data_dir(&app.st.dir)?;
    let day = quotes::chrono_date(now());
    let (target, copied, bytes) = safety::write_backup(&app.st.dir, &target_root, &format!("backup-{day}"))?;
    safety::prune_backups(&target_root)?;
    Ok(json!({
        "path": target.to_string_lossy(),
        "files": copied,
        "bytes": bytes,
    }))
}

#[tauri::command]
fn logos_cached(app: State<App>) -> Value {
    let v = app.st.read("logos.json");
    if v.is_object() { v } else { json!({}) }
}

/// Щоденний знімок вартості крипти: біржа не віддає NAV назад у часі,
/// тож історію апка накопичує сама — один запис на день, назавжди.
#[tauri::command]
fn cryhist_add(app: State<App>, date: String, value: f64) -> Result<(), String> {
    let v = app.st.read("cry_hist.json");
    let mut arr = v.as_array().cloned().unwrap_or_default();
    if let Some(last) = arr.iter_mut().rev().find(|e| e.get("date").and_then(|d| d.as_str()) == Some(date.as_str())) {
        // того ж дня — оновлюємо значення (ціни рухаються)
        *last = json!({"date": date, "value": value});
    } else {
        arr.push(json!({"date": date, "value": value}));
    }
    app.st.write("cry_hist.json", &Value::Array(arr))
}

#[tauri::command]
fn cryhist_all(app: State<App>) -> Value {
    let v = app.st.read("cry_hist.json");
    if v.is_array() { v } else { json!([]) }
}

/// Знімок капіталу за день: банк + інвестиції + готівка одним рядком.
/// Пишеться раз на день (повторний виклик того ж дня оновлює запис —
/// увечері цифра точніша за ранкову). За рік з цього виходить графік,
/// якого з жодного окремого джерела не скласти.
#[tauri::command]
fn nw_add(app: State<App>, date: String, value: Value) -> Result<(), String> {
    let v = app.st.read("networth.json");
    let mut arr = v.as_array().cloned().unwrap_or_default();
    let mut row = value.clone();
    if let Some(o) = row.as_object_mut() {
        o.insert("date".into(), json!(date));
    }
    if let Some(last) = arr
        .iter_mut()
        .rev()
        .find(|e| e.get("date").and_then(|d| d.as_str()) == Some(date.as_str()))
    {
        *last = row;
    } else {
        arr.push(row);
    }
    // тримаємо 5 років щоденних знімків — далі файл нікому не потрібен
    if arr.len() > 1900 {
        let cut = arr.len() - 1900;
        arr.drain(0..cut);
    }
    app.st.write("networth.json", &Value::Array(arr))
}

#[tauri::command]
fn nw_all(app: State<App>) -> Value {
    let v = app.st.read("networth.json");
    if v.is_array() { v } else { json!([]) }
}

/// Кеш нормалізованих інвестданих: із дворічною історією апка на
/// кожен старт парсила б кілька МБ XML — кеш із підписом сирих файлів
/// пропускає розбір, коли нічого не мінялось.
#[tauri::command]
fn inv_cache(app: State<App>) -> Value {
    let v = app.st.read("inv_cache.json");
    if v.is_object() { v } else { Value::Null }
}

#[tauri::command]
fn inv_cache_set(app: State<App>, value: Value) -> Result<(), String> {
    app.st.write("inv_cache.json", &value)
}

/// Сирі дані обох брокерів для фронтенду — розбирає їх invnorm.js.
#[tauri::command]
fn inv_raw(app: State<App>) -> Value {
    let ib = app.st.read("ibkr_raw.json");
    let bn = app.st.read("binance_raw.json");
    json!({
        "ibkr": if ib.is_object() { ib } else { Value::Null },
        "binance": if bn.is_object() { bn } else { Value::Null },
    })
}

// ─────────────────────────────── дані

#[tauri::command]
fn state_all(app: State<App>) -> Value {
    app.st.state()
}

#[tauri::command]
fn state_set(app: State<App>, key: String, value: Value) -> Result<(), String> {
    if key == "backupDir" { validate_backup_preference(&app, &value)?; }
    app.st.state_set(&key, value)
}

#[tauri::command]
fn state_del(app: State<App>, key: String) -> Result<(), String> {
    app.st.state_del(&key)
}

#[tauri::command]
fn state_replace(app: State<App>, value: Value) -> Result<(), String> {
    if let Some(dir) = value.get("backupDir") { validate_backup_preference(&app, dir)?; }
    app.st.state_replace(value)
}

#[tauri::command]
fn raw_all(app: State<App>) -> Value {
    let v = app.st.read("mono_raw.json");
    if v.is_object() {
        v
    } else {
        json!({"accounts": [], "items": {}, "fetched": {}, "synced": 0})
    }
}

#[tauri::command]
fn legacy_all(app: State<App>) -> Value {
    app.st.read("legacy.json")
}

/// Одноразовий імпорт знімка з Notion: старі операції лишаються в апці,
/// поки банк не віддасть той самий період.
#[tauri::command]
fn legacy_import(app: State<App>, value: Value) -> Result<usize, String> {
    let n = value.as_array().map(|a| a.len()).unwrap_or(0);
    app.st.write("legacy.json", &value)?;
    Ok(n)
}

/// Посилання відкриваємо у СИСТЕМНОМУ браузері, а не у вікні апки:
/// на сторінці банку вхід через Дію та QR, і вбудований webview для
/// цього і незручний, і зайвий ризик.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = safety::external_url(&url)?;
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())
}

/* ── ДЕ ЛЕЖАТЬ ДАНІ ───────────────────────────────────────────────
   За замовчуванням — %APPDATA%\Гроші. Але дані мають пережити
   перевстановлення апки й бути в теці, яку синхронізує хмара, тож
   місце можна змінити.

   Сам шлях зберігається НЕ в state.json — той лежить у теці, яку ми
   шукаємо, і вийшло б замкнене коло. Для цього є окремий крихітний
   покажчик `location.json` у стандартній теці; його ніхто не переносить. */
fn pointer(base: &std::path::Path) -> std::path::PathBuf {
    base.join("location.json")
}

fn write_pointer(base: &std::path::Path, value: &Value) -> Result<(), String> {
    safety::write_atomic(&pointer(base), &serde_json::to_vec(value).map_err(|e| e.to_string())?)
}

fn resolve_dir(base: &std::path::Path) -> Result<(std::path::PathBuf, Option<String>), String> {
    let path = pointer(base);
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((base.to_path_buf(), None)),
        Err(error) => return Err(format!("Не вдалося прочитати налаштоване місце даних: {error}")),
        Ok(_) => (),
    }
    let value = safety::read_import(&path).and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string()))
        .map_err(|error| format!("Не вдалося прочитати налаштоване місце даних: {error}"))?;
    let configured = value.get("dir").and_then(|v| v.as_str()).filter(|dir| !dir.is_empty())
        .ok_or("У покажчику відсутній шлях до даних; запуск зупинено, щоб не створити іншу історію")?;
    let current = safety::directory(std::path::Path::new(configured))
        .map_err(|error| format!("Налаштована тека даних недоступна. Підключіть диск або відновіть доступ і запустіть застосунок знову: {error}"))?;
    let Some(pending) = value.get("pending") else { return Ok((current, None)) };
    let migrate = || -> Result<std::path::PathBuf, String> {
        let source = pending.get("source").and_then(|v| v.as_str()).ok_or("Не вказано початкову теку перенесення")?;
        if safety::directory(std::path::Path::new(source))? != safety::directory(&current)? {
            return Err("Початкова тека перенесення змінилася".into());
        }
        let target = pending.get("target").and_then(|v| v.as_str()).ok_or("Не вказано цільову теку перенесення")?;
        let target = safety::directory(std::path::Path::new(target))?;
        let mode = pending.get("mode").and_then(|v| v.as_str()).ok_or("Не вказано спосіб перенесення")?;
        safety::copy_migration(&current, &target, mode)?;
        // Нове місце стає чинним лише після успішної копії всіх файлів.
        write_pointer(base, &json!({"dir": target.to_string_lossy()}))?;
        Ok(target)
    };
    match migrate() {
        Ok(target) => {
            let error = if pending.get("mode").and_then(|v| v.as_str()) != Some("adopt") {
                safety::remove_migrated_sources(&current, &target).err()
                    .map(|e| format!("Дані перенесено, але частина старих копій залишилася: {e}"))
            } else { None };
            Ok((target, error))
        }
        Err(error) => Ok((current, Some(format!("Теку не змінено; дані збережено на попередньому місці: {error}")))),
    }
}

#[derive(Serialize)]
struct Moved {
    dir: String,
    copied: usize,
    removed: usize,
    used_existing: bool,
    pending: bool,
}

/// Що лежить у теці, куди збираємось переїхати. Питати про це ПЕРЕД
/// переїздом важливо: інакше довелося б або мовчки затирати чужі дані,
/// або мовчки кидати свої.
#[derive(Serialize)]
struct Peek {
    has_data: bool,
    writable: bool,
}

#[tauri::command]
fn data_peek(app: State<App>, path: String) -> Result<Peek, String> {
    let p = app.grants.lock().map_err(|_| "Дозволи тек недоступні")?.directory(std::path::Path::new(&path))?;
    safety::check_data_dir(&p)?;
    Ok(Peek { has_data: safety::DATA_FILES.iter().any(|f| p.join(f).is_file()), writable: safety::writable(&p)? })
}

#[tauri::command]
fn data_dir(app: State<App>) -> String {
    app.st.dir.to_string_lossy().to_string()
}

#[tauri::command]
fn data_default(app: State<App>) -> String {
    app.base.to_string_lossy().to_string()
}

/// `path == None` — повернутись до стандартної теки.
///
/// `mode`:
///   `move`      перенести поточні дані (копія + видалення старих) — типово;
///   `adopt`     лишити те, що вже лежить у цільовій теці, свої не чіпати;
///   `overwrite` перенести поверх того, що там є.
///
/// План виконується під час наступного запуску, доки Store ще не відкрито:
/// інакше зміни, зроблені після копіювання й до перезапуску, загубилися б.
#[tauri::command]
fn data_set(app: State<App>, path: Option<String>, mode: Option<String>) -> Result<Moved, String> {
    let target = match path.as_deref().filter(|s| !s.is_empty()) {
        Some(p) => app.grants.lock().map_err(|_| "Дозволи тек недоступні")?.directory(std::path::Path::new(p))?,
        None => app.base.clone(),
    };
    let mode = mode.as_deref().unwrap_or("move");
    let (source, target) = safety::migration_paths(&app.st.dir, &target, mode)?;
    if !safety::writable(&target)? { return Err("Тека недоступна для запису".into()); }
    if mode == "move" && safety::DATA_FILES.iter().any(|name| target.join(name).exists()) {
        return Err("У теці вже є дані — виберіть підключення або заміну".into());
    }
    let used_existing = mode == "adopt";
    // До перезапуску Store продовжує писати у source, тому зараз лише плануємо.
    write_pointer(&app.base, &json!({"dir": source.to_string_lossy(), "pending": {
        "source": source.to_string_lossy(), "target": target.to_string_lossy(), "mode": mode,
    }}))?;
    Ok(Moved {
        dir: target.to_string_lossy().to_string(),
        copied: 0,
        removed: 0,
        used_existing,
        pending: true,
    })
}

/// Перезапуск потрібен тому, що всі дані читаються один раз під час
/// старту: підмінити теку на ходу означало б перезбирати півапки.
#[tauri::command]
fn restart(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
fn reveal(app: State<App>, name: Option<String>) -> Result<(), String> {
    let p = match name {
        Some(n) => safety::data_path(&app.st.dir, &n)?,
        None => safety::directory(&app.st.dir)?,
    };
    tauri_plugin_opener::reveal_item_in_dir(&p).map_err(|e| e.to_string())
}

// ─────────────────────────────── синхронізація

#[derive(Serialize, Clone)]
struct SyncDone {
    added: usize,
    total: usize,
    synced: i64,
    accounts: usize,
    stopped: bool,
    skipped: usize,
}

/// `months` — скільки історії тягнути. Звичайне оновлення — 0: тоді
/// береться проміжок від останнього успішного запиту мінус доба (щоб
/// підхопити операції, які банк дописав заднім числом після холду).
#[tauri::command]
async fn sync(
    window: tauri::Window,
    app: State<'_, App>,
    months: i64,
) -> Result<SyncDone, String> {
    {
        let mut b = app.busy.lock().unwrap();
        if *b {
            return Err("Синхронізація вже триває".into());
        }
        *b = true;
    }
    let st = app.st.clone();
    let busy = app.busy.clone();
    let stop = app.stop.clone();
    stop.store(false, std::sync::atomic::Ordering::Relaxed);
    let res = sync_inner(&window, st, stop, months).await;
    *busy.lock().unwrap() = false;
    res
}

fn picked_ids(st: &Store) -> Vec<String> {
    st.state()
        .get("monoAccounts")
        .and_then(|v| v.as_array().cloned())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn pick<'a>(accs: &'a [mono::Account], picked: &[String]) -> Vec<&'a mono::Account> {
    accs.iter()
        .filter(|a| {
            if picked.is_empty() {
                a.kind != "jar" && a.currency == 980
            } else {
                picked.contains(&a.id)
            }
        })
        .collect()
}

/// Вікна для одного рахунку, від НАЙСВІЖІШОГО до найдавнішого.
///
/// Порядок важливий. Раніше йшли від старого до нового, і перші свіжі
/// операції зʼявлялись аж наприкінці — тобто після години очікування.
/// Тепер перше ж вікно приносить останній місяць, а глибина набирається
/// потім; зупинити можна будь-якої миті, уже завантажене лишиться.
fn plan_windows(raw: &Value, acc: &str, months: i64, to: i64) -> Vec<(i64, i64)> {
    let newest = raw
        .get("newest").and_then(|v| v.get(acc)).and_then(|v| v.as_i64())
        .or_else(|| raw.get("fetched").and_then(|v| v.get(acc)).and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let oldest = raw.get("oldest").and_then(|v| v.get(acc)).and_then(|v| v.as_i64()).unwrap_or(0);

    let mut out: Vec<(i64, i64)> = Vec::new();

    // 1) свіже: від останнього успішного запиту до зараз (мінус доба —
    //    холди банк дописує заднім числом)
    let head_from = if newest > 0 { newest - 86_400 } else { to - mono::WINDOW };
    for w in mono::windows(head_from.min(to), to) {
        out.push(w);
    }
    out.reverse(); // найсвіжіше першим

    // 2) глибина: докопуємось назад від найдавнішого, що вже маємо
    if months > 0 {
        let target = to - months * 30 * 86_400;
        let mut edge = if oldest > 0 { oldest } else { head_from.min(to) };
        while edge > target {
            let from = (edge - mono::WINDOW).max(target);
            out.push((from, edge));
            edge = from;
        }
    }
    out
}

async fn sync_inner<E: Emitter<tauri::Wry>>(
    window: &E,
    st: Arc<Store>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    months: i64,
) -> Result<SyncDone, String> {
    let token = token_get()?;
    let tick = |stage: &str, account: &str, done: usize, total: usize, added: usize, wait: u64| {
        let _ = window.emit(
            "sync",
            mono::Progress {
                stage: stage.into(),
                account: account.into(),
                done,
                total,
                added,
                wait,
            },
        );
    };

    tick("рахунки", "", 0, 0, 0, 0);
    let (accs, owner) = mono::accounts(&token).await?;

    let mut raw = st.read("mono_raw.json");
    if !raw.is_object() {
        raw = json!({"accounts": [], "items": {}, "fetched": {}, "synced": 0});
    }
    raw["accounts"] = serde_json::to_value(&accs).unwrap();
    if !owner.is_empty() { raw["owner"] = json!(owner); }

    // Які рахунки тягнути: якщо людина нічого не обирала — усі гривневі
    // картки й ФОП. Банки й валютні зазвичай не потрібні щодня.
    let picked = picked_ids(&st);
    let targets = pick(&accs, &picked);
    if targets.is_empty() {
        return Err("Не обрано жодного рахунку".into());
    }

    let to = now();

    /* Вікна зшиваються ШАРАМИ: спершу найсвіжіше вікно кожного рахунку,
       потім друге кожного, і так далі. Так уже за перші кілька хвилин
       видно останній місяць по всіх рахунках, а не повна історія одного
       й порожнеча по решті. */
    let per: Vec<(String, String, Vec<(i64, i64)>)> = targets
        .iter()
        .map(|a| (a.id.clone(), a.title.clone(), plan_windows(&raw, &a.id, months, to)))
        .collect();
    let depth = per.iter().map(|(_, _, v)| v.len()).max().unwrap_or(0);
    let mut jobs: Vec<(String, String, i64, i64, usize)> = Vec::new();
    for layer in 0..depth {
        for (id, title, ws) in &per {
            if let Some(w) = ws.get(layer) {
                jobs.push((id.clone(), title.clone(), w.0, w.1, layer));
            }
        }
    }

    let total = jobs.len();
    let mut added = 0usize;
    let mut first = true;
    let mut stopped = false;
    /* Рахунок, який мовчить три вікна поспіль, глибше не копаємо: у
       більшості людей половина карток і банок роками без руху, а кожне
       порожнє вікно — це втрачена хвилина. */
    let mut silence: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut skipped: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (i, (acc_id, title, from, till, layer)) in jobs.iter().enumerate() {
        if stop.load(std::sync::atomic::Ordering::Relaxed) { stopped = true; break; }
        if *layer > 0 && skipped.contains(acc_id) { continue; }

        // Банк дозволяє один запит на 60 секунд. Перший іде одразу,
        // далі — з паузою, під час якої показуємо зворотний відлік:
        // мовчазне очікування виглядає як зависання.
        if !first {
            for left in (0..mono::REQ_GAP).rev() {
                if stop.load(std::sync::atomic::Ordering::Relaxed) { break; }
                tick("пауза", title, i, total, added, left);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            if stop.load(std::sync::atomic::Ordering::Relaxed) { stopped = true; break; }
        }
        first = false;

        tick("виписка", title, i, total, added, 0);
        let items = mono::statement(&token, acc_id, *from, *till).await?;
        let got = items.len();

        let arr = raw["items"]
            .as_object_mut()
            .unwrap()
            .entry(acc_id.clone())
            .or_insert_with(|| Value::Array(vec![]));
        let list = arr.as_array_mut().unwrap();
        let mut have: std::collections::HashSet<String> = list
            .iter()
            .filter_map(|x| x.get("id").and_then(|v| v.as_str()).map(String::from))
            .collect();
        for it in items {
            let id = it.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if id.is_empty() || have.contains(&id) {
                continue;
            }
            have.insert(id);
            list.push(it);
            added += 1;
        }

        // межі завантаженого: newest тягнеться вперед, oldest — назад
        let nw = raw.get("newest").and_then(|v| v.get(acc_id)).and_then(|v| v.as_i64()).unwrap_or(0);
        if *till > nw { raw["newest"][acc_id] = json!(*till); }
        let od = raw.get("oldest").and_then(|v| v.get(acc_id)).and_then(|v| v.as_i64()).unwrap_or(i64::MAX);
        if *from < od { raw["oldest"][acc_id] = json!(*from); }
        raw["fetched"][acc_id] = json!(*till);          // сумісність зі старим полем

        let e = silence.entry(acc_id.clone()).or_insert(0);
        if got == 0 { *e += 1; } else { *e = 0; }
        if *e >= 3 { skipped.insert(acc_id.clone()); }

        st.write("mono_raw.json", &raw)?;
    }

    raw["synced"] = json!(to);
    st.write("mono_raw.json", &raw)?;

    let total_items: usize = raw["items"]
        .as_object()
        .map(|o| o.values().filter_map(|v| v.as_array()).map(|a| a.len()).sum())
        .unwrap_or(0);

    tick("готово", "", total, total, added, 0);
    Ok(SyncDone { added, total: total_items, synced: to, accounts: targets.len(),
                  stopped, skipped: skipped.len() })
}

/* Курси лежать в окремому файлі, а не в state.json: той пише фронтенд,
   і два автори одного файлу — це гонка, у якій хтось обовʼязково
   загубить чужу зміну. */
#[tauri::command]
async fn fx(app: State<'_, App>, force: Option<bool>) -> Result<Value, String> {
    let st = app.st.clone();
    let cached = st.read("fx.json");
    let at = cached.get("at").and_then(|v| v.as_i64()).unwrap_or(0);
    let fresh = now() - at < 3600;
    if !force.unwrap_or(false) && fresh && cached.get("rates").map_or(false, |r| r.is_object()) {
        return Ok(cached);
    }
    match mono::currency().await {
        Ok(list) => {
            let mut m = serde_json::Map::new();
            for (k, v) in list {
                m.insert(k, json!(v));
            }
            let out = json!({ "at": now(), "rates": Value::Object(m) });
            st.write("fx.json", &out)?;
            Ok(out)
        }
        // Свіжого курсу немає — краще старий, ніж нічого
        Err(e) => {
            if cached.get("rates").map_or(false, |r| r.is_object()) {
                let mut c = cached.clone();
                c["stale"] = json!(e);
                Ok(c)
            } else {
                Err(e)
            }
        }
    }
}

#[tauri::command]
async fn accounts_list() -> Result<Vec<mono::Account>, String> {
    let token = token_get()?;
    mono::accounts(&token).await.map(|(a, _)| a)
}

/// Скільки запитів і скільки це часу — рахуємо ДО того, як людина
/// натисне «почати». Півтори години очікування без попередження — це
/// не «повільно», це «зламалось».
#[derive(Serialize, Clone)]
struct Plan {
    requests: usize,
    seconds: u64,
    accounts: usize,
}

#[tauri::command]
async fn sync_plan(app: State<'_, App>, months: i64) -> Result<Plan, String> {
    let token = token_get()?;
    let (accs, _) = mono::accounts(&token).await?;
    let raw = app.st.read("mono_raw.json");
    let picked = picked_ids(&app.st);
    let targets = pick(&accs, &picked);
    let mut n = 0usize;
    for a in &targets {
        n += plan_windows(&raw, &a.id, months, now()).len();
    }
    Ok(Plan {
        requests: n,
        seconds: if n > 1 { (n as u64 - 1) * mono::REQ_GAP } else { 0 },
        accounts: targets.len(),
    })
}

#[tauri::command]
fn sync_stop(app: State<App>) {
    app.stop.store(true, std::sync::atomic::Ordering::Relaxed);
}

// ─────────────────────────────── оновлення

/* Тека, куди складаються збірки. Це не «магічний шлях у коді»: значення
   лише пропонується в налаштуваннях, і будь-яке інше — тека чи URL —
   перебиває його. */
/* Звідки беруться нові збірки. Релізи GitHub — бо саме туди їх кладе
   збірка за тегом, і це єдине джерело, доступне з будь-якого компʼютера.
   Це не «магічний шлях у коді»: значення лише пропонується в
   налаштуваннях, і будь-яке інше — інший репозиторій, адреса з
   latest.json або тека — перебиває його. */
const DEFAULT_SRC: &str = "github:Amriel/Groshi";

fn upd_source(st: &Store) -> String {
    st.state()
        .get("updSource")
        .and_then(|v| v.as_str().map(String::from))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SRC.to_string())
}

#[tauri::command]
fn app_version() -> String {
    update::current()
}

#[tauri::command]
fn update_source(app: State<App>) -> String {
    upd_source(&app.st)
}

#[tauri::command]
async fn update_check(app: State<'_, App>, source: Option<String>) -> Result<update::Found, String> {
    require_service(&app.st, "updates")?;
    let src = source
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| upd_source(&app.st));
    update::check(&src).await
}

/// Копіюємо інсталятор у тимчасову теку, запускаємо й виходимо: NSIS не
/// може переписати файли застосунку, поки той тримає їх відкритими.
#[tauri::command]
async fn update_install(
    app: tauri::AppHandle,
    st: State<'_, App>,
    source: Option<String>,
    file: String,
) -> Result<(), String> {
    require_service(&st.st, "updates")?;
    let src = source
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| upd_source(&st.st));
    let path = update::fetch(&src, &file).await?;

    #[cfg(target_os = "windows")]
    std::process::Command::new(&path)
        .spawn()
        .map_err(|e| format!("не вдалося запустити інсталятор: {e}"))?;
    #[cfg(not(target_os = "windows"))]
    let _ = &path;

    // Дати інсталятору піднятись, і аж тоді звільнити файли.
    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
    app.exit(0);
    Ok(())
}

// ─────────────────────────────── саме оновлення за розкладом

/* Апка й так живе у треї заради нагадувань — гріх не використати це,
   щоб вона сама забирала з банку нове. Тік раз на хвилину, а рішення
   ухвалюється за годинником: так налаштування діє одразу, а не з
   наступного циклу, і сон комп'ютера нічого не ламає — прокинувшись,
   апка бачить, що час минув, і робить запит. */
fn auto_sync(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // не смикати банк у перші секунди після запуску: людина щойно
        // відкрила вікно, хай спершу все намалюється
        tokio::time::sleep(std::time::Duration::from_secs(90)).await;
        loop {
            {
                let st = app.state::<App>();
                let every = st.st.state().get("autoSyncMin")
                    .and_then(|v| v.as_i64()).unwrap_or(0);
                let last = st.st.state().get("autoSyncLast")
                    .and_then(|v| v.as_i64()).unwrap_or(0);
                let busy = *st.busy.lock().unwrap();
                /* Тихі години: вночі банк смикати нема сенсу — операцій
                   нема, а трафік і батарея витрачаються. Вікно задає
                   людина (типово 23:00–08:00); від=до вимикає паузу. */
                let qf = st.st.state().get("autoQuietFrom")
                    .and_then(|v| v.as_i64()).unwrap_or(23);
                let qt = st.st.state().get("autoQuietTo")
                    .and_then(|v| v.as_i64()).unwrap_or(8);
                /* Локальна година: chrono тут не підключений, а зсув
                   часового поясу фронт кладе у стан при старті
                   (getTimezoneOffset) — цього досить. */
                let tz = st.st.state().get("autoTzMin")
                    .and_then(|v| v.as_i64()).unwrap_or(120);
                let hour = ((now() + tz * 60) / 3600).rem_euclid(24);
                let quiet = if qf == qt { false }
                    else if qf < qt { hour >= qf && hour < qt }
                    else { hour >= qf || hour < qt };
                let due = every > 0 && !quiet && now() - last >= every * 60;

                if due && !busy && token_get().is_ok() {
                    let store = st.st.clone();
                    let stop = st.stop.clone();
                    *st.busy.lock().unwrap() = true;
                    stop.store(false, std::sync::atomic::Ordering::Relaxed);
                    let busy_flag = st.busy.clone();
                    drop(st);

                    let win = app.get_webview_window("main");
                    let res = match &win {
                        Some(w) => sync_inner(w, store.clone(), stop, 0).await,
                        None => Err("вікна немає".into()),
                    };
                    *busy_flag.lock().unwrap() = false;

                    /* Час записуємо у будь-якому разі. Інакше при мертвій
                       мережі апка гатила б у банк щохвилини. */
                    let _ = store.state_set("autoSyncLast", json!(now()));
                    match res {
                        Ok(d) => {
                            let _ = app.emit("auto-synced", &d);
                            if d.added > 0 {
                                let _ = store.state_set("autoSyncErr", json!(""));
                            }
                        }
                        Err(e) => { let _ = store.state_set("autoSyncErr", json!(e)); }
                    }
                }
            }
            /* Брокер окремим розкладом: Flex-звіт денний, тягнути його
               щогодини безглуздо, а IBKR ще й блокує токен за надто
               часті запити. Типово вимкнено; вмикається годинами. */
            {
                let st = app.state::<App>();
                let evh = st.st.state().get("autoIbkrH")
                    .and_then(|v| v.as_i64()).unwrap_or(0);
                let last = st.st.state().get("autoIbkrLast")
                    .and_then(|v| v.as_i64()).unwrap_or(0);
                let due = evh > 0 && now() - last >= evh * 3600;
                let store = st.st.clone();
                drop(st);
                if due {
                    if let Ok((t, q)) = broker_get("ibkr-flex") {
                        let _ = store.state_set("autoIbkrLast", json!(now()));
                        match ibkr::fetch(&t, &q).await {
                            Ok(xml) => {
                                let prev = store.read("ibkr_raw.json");
                                let extra = prev.get("extra").cloned().unwrap_or(json!([]));
                                let out = json!({ "xml": xml, "fetched": now(), "extra": extra });
                                if store.write("ibkr_raw.json", &out).is_ok() {
                                    let _ = store.state_set("autoIbkrErr", json!(""));
                                    let _ = app.emit("auto-ibkr", &json!({ "fetched": now() }));
                                }
                            }
                            Err(e) => { let _ = store.state_set("autoIbkrErr", json!(e)); }
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}

// ─────────────────────────────── запуск

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--tray"]),
        ))
        .setup(|app| {
            let base = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            std::fs::create_dir_all(&base).ok();
            let (dir, migration_error) = resolve_dir(&base)?;
            safety::check_data_dir(&dir)?;
            let st = Arc::new(Store::new(dir));
            if let Some(error) = migration_error { st.state_set("migrationError", json!(error))?; }
            else { st.state_del("migrationError")?; }
            let mut grants = safety::Grants::default();
            grants.add_directory(&base)?;
            grants.add_directory(&st.dir)?;
            // Лише шлях, уже налаштований під час старту; state_set не може додати довільну теку.
            if let Some(dir) = st.state().get("backupDir").and_then(|v| v.as_str()) {
                if !dir.is_empty() { let _ = grants.add_directory(std::path::Path::new(dir)); }
            }

            /* Публічна збірка містить порожній початковий файл: приватна
               історія з’являється лише після явного імпорту користувача.
               Наявну історію під час запуску не перезаписуємо. */
            if !st.path("legacy.json").exists() {
                const SEED: &str = include_str!("../../dist/legacy.json");
                if let Ok(v) = serde_json::from_str::<Value>(SEED) {
                    let _ = st.write("legacy.json", &v);
                }
            }
            app.manage(App { st: st.clone(), base: base.clone(), grants: Mutex::new(grants), busy: Arc::new(Mutex::new(false)),
                             stop: Arc::new(std::sync::atomic::AtomicBool::new(false)) });

            // Трей: апка живе далі після закриття вікна, інакше нагадування
            // про підписки не мають шансу спрацювати.
            let show = MenuItem::with_id(app, "show", "Відкрити", true, None::<&str>)?;
            let sync_i = MenuItem::with_id(app, "sync", "Оновити з банку", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Вийти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &sync_i, &quit])?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Гроші")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "sync" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = w.emit("tray-sync", ());
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = ev {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Запуск за розкладом Windows додає --tray: тоді вікно не
            // показуємо, апка просто сидить у треї й оновлює дані.
            auto_sync(app.handle().clone());

            if std::env::args().any(|a| a == "--tray") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|w, ev| {
            // Хрестик ховає вікно, а не вбиває апку. Вихід — через трей.
            if let WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            token_has,
            token_set,
            token_clear,
            state_all,
            state_set,
            state_del,
            state_replace,
            raw_all,
            legacy_all,
            legacy_import,
            data_dir,
            data_default,
            data_peek,
            data_set,
            restart,
            reveal,
            open_url,
            app_version,
            update_source,
            update_check,
            update_install,
            sync,
            sync_plan,
            sync_stop,
            accounts_list,
            fx,
            ibkr_has,
            ibkr_set,
            ibkr_clear,
            ibkr_sync,
            ibkr_import,
            ibkr_import_clear,
            quotes_sync,
            quotes_cached,
            logos_sync,
            logos_cached,
            nbu_rates,
            file_b64,
            pick_file,
            pick_directory,
            backup_run,
            save_text,
            quote_detail,
            quote_news,
            quotes_today,
            cryhist_add,
            cryhist_all,
            binance_has,
            binance_set,
            binance_clear,
            binance_sync,
            inv_raw,
            inv_cache,
            inv_cache_set,
            nw_add,
            nw_all
        ])
        .run(tauri::generate_context!())
        .expect("не вдалося запустити застосунок");
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture { root: PathBuf, base: PathBuf, source: PathBuf, target: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("groshi-migration-test-{}-{}", std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
            std::fs::create_dir(&root).unwrap();
            let root = std::fs::canonicalize(root).unwrap();
            let base = root.join("base"); let source = root.join("source"); let target = root.join("target");
            for dir in [&base, &source, &target] { std::fs::create_dir(dir).unwrap(); }
            Self { root, base, source, target }
        }
        fn schedule(&self) {
            write_pointer(&self.base, &json!({"dir": self.source.to_string_lossy(), "pending": {
                "source": self.source.to_string_lossy(), "target": self.target.to_string_lossy(), "mode": "move",
            }})).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let temp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
            if self.root.parent() == Some(temp.as_path()) && self.root.file_name().unwrap().to_string_lossy().starts_with("groshi-migration-test-") {
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }
    }

    #[test]
    fn pending_move_includes_changes_made_after_scheduling() {
        let fixture = Fixture::new();
        for name in safety::DATA_FILES { std::fs::write(fixture.source.join(name), b"before scheduling").unwrap(); }
        fixture.schedule();
        assert!(!fixture.target.join("state.json").exists());
        std::fs::write(fixture.source.join("state.json"), b"changed before restart").unwrap();
        let (dir, error) = resolve_dir(&fixture.base).unwrap();
        assert_eq!(dir, fixture.target);
        assert!(error.is_none());
        assert_eq!(std::fs::read(dir.join("state.json")).unwrap(), b"changed before restart");
        for name in safety::DATA_FILES { assert!(dir.join(name).exists()); assert!(!fixture.source.join(name).exists()); }
        let value: Value = serde_json::from_slice(&std::fs::read(pointer(&fixture.base)).unwrap()).unwrap();
        assert!(value.get("pending").is_none());
    }

    #[test]
    fn failed_pending_move_keeps_current_pointer_and_source_data() {
        let fixture = Fixture::new();
        std::fs::write(fixture.source.join("state.json"), b"source settings").unwrap();
        fixture.schedule();
        std::fs::write(fixture.target.join("state.json"), b"other settings").unwrap();
        let (dir, error) = resolve_dir(&fixture.base).unwrap();
        assert_eq!(dir, fixture.source);
        assert!(error.is_some());
        assert_eq!(std::fs::read(fixture.source.join("state.json")).unwrap(), b"source settings");
        assert_eq!(std::fs::read(fixture.target.join("state.json")).unwrap(), b"other settings");
        let value: Value = serde_json::from_slice(&std::fs::read(pointer(&fixture.base)).unwrap()).unwrap();
        assert!(value.get("pending").is_some());
    }

    #[test]
    fn missing_custom_directory_blocks_startup_without_creating_alternate_data() {
        let fixture = Fixture::new();
        let missing = fixture.root.join("disconnected-drive");
        write_pointer(&fixture.base, &json!({"dir": missing.to_string_lossy()})).unwrap();
        let original = std::fs::read(pointer(&fixture.base)).unwrap();
        assert!(resolve_dir(&fixture.base).is_err());
        assert!(!missing.exists());
        for name in safety::DATA_FILES { assert!(!fixture.base.join(name).exists()); }
        assert_eq!(std::fs::read(pointer(&fixture.base)).unwrap(), original);
        std::fs::create_dir(&missing).unwrap();
        assert_eq!(resolve_dir(&fixture.base).unwrap().0, missing);
    }

    #[test]
    fn only_absent_pointer_uses_default_directory() {
        let fixture = Fixture::new();
        assert_eq!(resolve_dir(&fixture.base).unwrap().0, fixture.base);
        write_pointer(&fixture.base, &json!({"dir": ""})).unwrap();
        assert!(resolve_dir(&fixture.base).is_err());
        write_pointer(&fixture.base, &json!({"unexpected": true})).unwrap();
        assert!(resolve_dir(&fixture.base).is_err());
    }
}
