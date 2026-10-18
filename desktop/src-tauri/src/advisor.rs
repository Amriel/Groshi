//! «Порадник»: запуск встановленого Claude Code (`claude -p`, вхід за підпискою користувача)
//! з доступом лише до нашого MCP «Гроші» (тільки читання, імена під NDA приховані) та WebSearch.
//! Вивід потоком іде у вебвʼю подіями `advisor`; історія чатів лежить у `advisor_chats.json`.
//!
//! Безпека: процес не повинен отримати ні файлів, ні терміналу, ні WebFetch, ні чужих MCP.
//! Тому кілька незалежних замків у `cc_args`: `--tools WebSearch` (вбудований набір),
//! `--allowedTools` (білий список), `--strict-mcp-config` (лише наш MCP), `--restricted`,
//! `--setting-sources ""`.

use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

use crate::App;

const HIST_FILE: &str = "advisor_chats.json";
const MAX_PROMPT: usize = 200_000;
const STDERR_TAIL: usize = 2000;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Активний запуск: процес Claude Code або HTTP-цикл (локальна модель, API). Слот один на всі
/// способи, щоб «Стоп» і «один запуск за раз» не залежали від способу.
pub(crate) enum Run {
    Cli(Child),
    /// Прапорець скасування, який перевіряє сам цикл; слот звільняє він же.
    Http(Arc<AtomicBool>),
}

pub(crate) type Slot = Arc<Mutex<Option<(u64, Run)>>>;

/// Один запуск за раз. Номер запуску потрібен, щоб потік-читач старого запуску
/// (після «Зупинити») не забрав чужий запуск зі слота.
#[derive(Default)]
pub struct Advisor {
    slot: Slot,
    seq: AtomicU64,
}

impl Advisor {
    /// Займає слот під HTTP-цикл; повертає номер запуску й прапорець скасування.
    pub(crate) fn claim_http(&self) -> Result<(u64, Arc<AtomicBool>), String> {
        let mut g = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_some() { return Err("Порадник ще відповідає".into()); }
        let id = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        *g = Some((id, Run::Http(cancel.clone())));
        Ok((id, cancel))
    }

    pub(crate) fn clone_slot(&self) -> Slot { self.slot.clone() }
}

/// Звільняє слот, якщо він ще за запуском `id`.
pub(crate) fn release_slot(slot: &Slot, id: u64) {
    let mut g = slot.lock().unwrap_or_else(|e| e.into_inner());
    if g.as_ref().map(|(i, _)| *i) == Some(id) { *g = None; }
}

/// Сповіщення вебвʼю з RAII-охоронця: (kind, text).
pub(crate) type Notify = Box<dyn Fn(&str, &str) + Send + Sync>;

/// RAII-охоронець слота HTTP-запуску. Без нього раннє повернення чи відкинутий future лишили б слот
/// зайнятим назавжди («Порадник ще відповідає»), а вкладку — без `done`. Створюється одразу після
/// `claim_http`; нормальний кінець — `finish()`, будь-який інший вихід шле `error`.
/// Паніку в релізі він НЕ покриває: профіль має `panic = "abort"` (процес падає цілком); у dev/тестах покриває.
/// Порядок завжди «слот вільний → done»: щойно вкладка отримала `done`, новий запит уже приймається.
pub(crate) struct RunGuard { slot: Slot, id: u64, notify: Notify, finished: bool }

impl RunGuard {
    pub(crate) fn new(slot: Slot, id: u64, notify: Notify) -> Self {
        RunGuard { slot, id, notify, finished: false }
    }

    /// Запуск дійшов до кінця сам: `Drop` надішле лише `done`.
    pub(crate) fn finish(mut self) { self.finished = true; }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        release_slot(&self.slot, self.id);
        if !self.finished { (self.notify)("error", "Порадник завершився несподівано"); }
        (self.notify)("done", "");
    }
}

/// Хмарні способи працюють лише за увімкненого сервісу `advisor`. Окрема функція (а не загальний
/// `require_service`), бо тут людині треба підказати, ДЕ це ввімкнути, а не показати загальне
/// «сервіс вимкнено»; чистий bool — щоб перевірка тестувалась без Store.
pub(crate) fn advisor_gate(enabled: bool) -> Result<(), String> {
    if enabled { Ok(()) } else { Err("Увімкніть Порадника в Налаштуваннях → Порадник".into()) }
}

#[derive(Deserialize)]
pub struct AskReq {
    pub conv: String,
    pub prompt: String,
    pub system: String,
    pub session: Option<String>,
    pub model: Option<String>,
}

pub(crate) fn no_window(c: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Без цього кожен запуск блимає чорним вікном консолі.
        c.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = c;
}

/// Аргументи `claude`. Питання передається через stdin, не аргументом (довжина й лапки).
pub fn cc_args(cfg_path: &str, sys_path: &str, session: Option<&str>, model: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = [
        "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        // Вбудований набір інструментів — лише пошук в інтернеті: жодних файлів, терміналу, WebFetch.
        "--tools", "WebSearch",
        // Білий список: MCP «Гроші» (усі його інструменти лише читають) і пошук.
        "--allowedTools", "mcp__groshi__*", "WebSearch",
        // Лише наш MCP; конфіги користувача/проєкту ігноруються.
        "--strict-mcp-config", "--mcp-config", cfg_path,
        "--system-prompt-file", sys_path,
        // Не підтягувати налаштування, хуки й дозволи користувача: чужі settings.json
        // могли б розширити доступ.
        "--setting-sources", "",
        "--disable-slash-commands",
        // Додатковий пояс: прибирає інструменти запуску коду й WebFetch, якщо щось просочиться.
        "--restricted",
    ].iter().map(|s| s.to_string()).collect();
    if let Some(s) = session { a.push("--resume".into()); a.push(s.into()); }
    if let Some(m) = model { a.push("--model".into()); a.push(m.into()); }
    a
}

/// Подія для вебвʼю: (kind, text).
pub type Ev = (&'static str, String);

/// Стан розбору одного запуску: потрібен, щоб відділити текстові блоки між собою і щоб знати,
/// чи дійшли часткові дельти (інакше відповідь у `result` загубилась би).
#[derive(Default)]
pub struct StreamState { emitted_text: bool }

/// Розбір одного рядка stream-json. Невідомі й зламані рядки мовчки пропускаються:
/// формат CLI може рости, а падати через новий тип події не можна.
pub fn parse_line(line: &str, st: &mut StreamState) -> Vec<Ev> {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return vec![] };
    let s = |x: &Value| x.as_str().unwrap_or("").to_string();
    match v.get("type").and_then(|t| t.as_str()) {
        Some("stream_event") => {
            let ev = &v["event"];
            // Без розділювача два текстові блоки (до й після інструмента) зліплюються в одне слово.
            if ev["type"] == "content_block_start" && ev["content_block"]["type"] == "text" && st.emitted_text {
                return vec![("text", "\n\n".to_string())];
            }
            let d = &ev["delta"];
            if ev["type"] == "content_block_delta" && d["type"] == "text_delta" {
                let t = s(&d["text"]);
                if !t.is_empty() { st.emitted_text = true; return vec![("text", t)]; }
            }
            vec![]
        }
        Some("assistant") => v["message"]["content"].as_array().map(|blocks| {
            blocks.iter().filter(|b| b["type"] == "tool_use").map(|b| {
                let name = s(&b["name"]);
                let q = s(&b["input"]["query"]);
                ("tool", if q.is_empty() { name } else { format!("{name}: {q}") })
            }).collect()
        }).unwrap_or_default(),
        Some("system") if v["subtype"] == "init" => {
            let id = s(&v["session_id"]);
            if id.is_empty() { vec![] } else { vec![("session", id)] }
        }
        Some("result") => {
            if v["is_error"] == true {
                let t = s(&v["result"]);
                return vec![("error", if t.is_empty() { "Порадник повернув помилку".into() } else { t })];
            }
            let mut out: Vec<Ev> = vec![];
            // Часткові дельти могли не прийти (інша версія CLI): тоді єдине місце з відповіддю — `result`.
            let full = s(&v["result"]);
            if !st.emitted_text && !full.is_empty() { st.emitted_text = true; out.push(("text", full)); }
            let id = s(&v["session_id"]);
            if !id.is_empty() { out.push(("session", id)); }
            out
        }
        _ => vec![],
    }
}

fn exe_names(base: &str) -> Vec<String> {
    if cfg!(windows) { vec![format!("{base}.exe"), format!("{base}.cmd")] } else { vec![base.to_string()] }
}

pub(crate) fn find_in_path(path: &str, base: &str) -> Option<PathBuf> {
    for dir in std::env::split_paths(path) {
        for n in exe_names(base) {
            let p = dir.join(&n);
            if p.is_file() { return Some(p); }
        }
    }
    None
}

/// `claude` у PATH, далі типові місця встановлення (WinGet, npm): у застосунку з трею PATH часто урізаний.
pub fn find_claude(path: &str, local_appdata: Option<&Path>, appdata: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = find_in_path(path, "claude") { return Some(p); }
    if let Some(la) = local_appdata {
        if let Ok(rd) = std::fs::read_dir(la.join("Microsoft").join("WinGet").join("Packages")) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with("Anthropic.ClaudeCode_") {
                    let p = e.path().join("claude.exe");
                    if p.is_file() { return Some(p); }
                }
            }
        }
    }
    if let Some(ad) = appdata {
        let p = ad.join("npm").join("claude.cmd");
        if p.is_file() { return Some(p); }
    }
    None
}

fn find_claude_env() -> Option<PathBuf> {
    let path = std::env::var("PATH").unwrap_or_default();
    let la = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let ad = std::env::var_os("APPDATA").map(PathBuf::from);
    find_claude(&path, la.as_deref(), ad.as_deref())
}

/// `node` у PATH: його ж шукає і вбудований MCP-клієнт (advisor_mcp).
pub(crate) fn find_node() -> Option<PathBuf> {
    find_in_path(&std::env::var("PATH").unwrap_or_default(), "node")
}

fn node_found() -> bool {
    find_node().is_some()
}

/// Вміст mcp.json: наш MCP під іменем `groshi` (звідси префікс `mcp__groshi__`).
pub fn mcp_config(resource_dir: &Path, data_dir: &Path) -> Value {
    // Tauri віддає шлях з префіксом `\\?\`; у конфігу він зайвий.
    let js = resource_dir.join("mcp").join("groshi-mcp.js");
    let js = js.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    json!({"mcpServers": {"groshi": {
        "command": "node",
        "args": [js],
        "env": {"GROSHI_DIR": data_dir.to_string_lossy(), "GROSHI_PSEUDO": "1"}
    }}})
}

#[tauri::command]
pub async fn advisor_cc_probe() -> Value {
    tauri::async_runtime::spawn_blocking(|| {
        let found = find_claude_env();
        let version = found.as_ref().and_then(|p| {
            let mut c = Command::new(p);
            c.arg("--version");
            no_window(&mut c);
            let o = c.output().ok()?;
            let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        });
        json!({"found": found.is_some(), "path": found.map(|p| p.to_string_lossy().to_string()),
               "version": version, "node": node_found()})
    }).await.unwrap_or_else(|_| json!({"found": false, "path": null, "version": null, "node": false}))
}

/// Запускає зовнішню програму без вікна й чекає не довше за `limit`. Без таймауту завислий `claude`/`lms`
/// тримав би кнопку в UI вічно. Код виходу перевіряється: інакше невдалий `lms server start` виглядав би
/// успіхом. Вивід збирають окремі потоки в спільні буфери, а завершення визначає `try_wait`, а не EOF каналу:
/// демон, що успадкував канал (`lms server start`), тримав би його відкритим і блокував читання.
pub(crate) fn run_capture(path: &Path, args: &[&str], limit: std::time::Duration) -> Result<String, String> {
    let mut cmd = Command::new(path);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    fn drain<R: Read + Send + 'static>(mut r: R) -> (Arc<Mutex<Vec<u8>>>, Arc<AtomicBool>) {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let done = Arc::new(AtomicBool::new(false));
        let (b, d) = (buf.clone(), done.clone());
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = r.read(&mut chunk) {
                if n == 0 { break; }
                b.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&chunk[..n]);
            }
            d.store(true, Ordering::SeqCst);
        });
        (buf, done)
    }
    let (out, out_done) = drain(child.stdout.take().ok_or("Немає виводу")?);
    let (err, err_done) = drain(child.stderr.take().ok_or("Немає виводу")?);
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) => break st,
            None if start.elapsed() >= limit => { kill_tree(&mut child); return Err("Час очікування вичерпано".into()); }
            None => std::thread::sleep(std::time::Duration::from_millis(30)),
        }
    };
    // Короткий запас, щоб дочитати хвіст виводу; далі віддаємо те, що встигло зібратись.
    let grace = std::time::Instant::now();
    while !(out_done.load(Ordering::SeqCst) && err_done.load(Ordering::SeqCst))
        && grace.elapsed() < std::time::Duration::from_millis(300) {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let text = |b: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&b.lock().unwrap_or_else(|e| e.into_inner())).to_string();
    if status.success() { return Ok(text(&out)); }
    let e = text(&err);
    let line = e.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let snippet: String = line.chars().take(120).collect();
    Err(if snippet.is_empty() { format!("Команда завершилась з кодом {}", status.code().unwrap_or(-1)) } else { snippet })
}

/// Лише `loggedIn` і `authMethod`: вивід `claude auth status --json` може містити пошту й організацію,
/// а вебвʼю (і журнал його помилок) їх бачити не мусить.
pub fn parse_cc_auth(json_text: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(json_text.trim()).map_err(|_| "Некоректна відповідь Claude Code".to_string())?;
    let logged_in = v.get("loggedIn").and_then(Value::as_bool).unwrap_or(false);
    let method: String = v.get("authMethod").and_then(Value::as_str).unwrap_or("").chars().take(40).collect();
    Ok(json!({"logged_in": logged_in, "method": method}))
}

/// Рядок для `cmd /c`, що відкриває видиме вікно консолі з інтерактивним входом. Заголовок у лапках
/// після `start` обовʼязковий: без нього `start` прийняв би шлях у лапках за заголовок і нічого б не запустив.
/// Шлях іде в лапках вручну (raw_arg): звичайний аргумент Rust бере в лапки лише шлях із пробілами, і `&`
/// чи `^` дійшли б до cmd.exe голими (розбили б команду); `%` cmd розкриває навіть у лапках, тож відхиляємо
/// і його, і саму лапку.
pub fn cc_login_line(claude: &Path) -> Result<String, String> {
    let p = claude.to_string_lossy();
    if p.contains('"') || p.contains('%') { return Err("Шлях до Claude Code містить недопустимі символи".into()); }
    Ok(format!("/c start \"Вхід у Claude Code\" \"{p}\" auth login"))
}

#[tauri::command]
pub async fn advisor_cc_auth(app: State<'_, App>) -> Result<Value, String> {
    crate::require_advisor(&app.st)?;
    tauri::async_runtime::spawn_blocking(|| {
        let claude = find_claude_env().ok_or("Claude Code не знайдено")?;
        let out = run_capture(&claude, &["auth", "status", "--json"], std::time::Duration::from_secs(15))?;
        parse_cc_auth(&out)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn advisor_cc_login(app: State<'_, App>) -> Result<(), String> {
    crate::require_advisor(&app.st)?;
    // Пошук claude обходить теки диска: не на потоці команд.
    tauri::async_runtime::spawn_blocking(|| {
        let claude = find_claude_env().ok_or("Claude Code не знайдено")?;
        let line = cc_login_line(&claude)?;
        let mut cmd = Command::new("cmd");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.raw_arg(&line);
        }
        #[cfg(not(windows))]
        cmd.args(line.split_whitespace());
        no_window(&mut cmd);
        // Не чекаємо: вхід інтерактивний, людина завершує його у вікні консолі.
        cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

pub(crate) fn emit(app: &tauri::AppHandle, conv: &str, kind: &str, text: &str) {
    let _ = app.emit("advisor", json!({"conv": conv, "kind": kind, "text": text}));
}

fn safe_token(s: &str, extra: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

pub(crate) fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        // child.kill() прибив би лише claude.exe, а node-процес MCP міг би лишитись.
        let mut c = Command::new("taskkill");
        c.args(["/T", "/F", "/PID", &child.id().to_string()]);
        no_window(&mut c);
        let _ = c.output();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command]
pub fn advisor_cc_ask(handle: tauri::AppHandle, app: State<App>, req: AskReq) -> Result<(), String> {
    crate::require_advisor(&app.st)?;
    if req.prompt.trim().is_empty() { return Err("Порожнє питання".into()); }
    if req.prompt.len() > MAX_PROMPT || req.system.len() > MAX_PROMPT { return Err("Питання завелике".into()); }
    // Значення йдуть в аргументи claude: початковий «-» дозволив би підсунути чужий прапорець.
    if let Some(s) = &req.session { if !safe_token(s, "-_") { return Err("Некоректний ідентифікатор сесії".into()); } }
    if let Some(m) = &req.model { if !safe_token(m, "-_.[]") { return Err("Некоректна назва моделі".into()); } }

    let claude = find_claude_env().ok_or("Claude Code не знайдено")?;
    if !node_found() { return Err("Node.js не знайдено".into()); }
    let res = handle.path().resource_dir().map_err(|e| e.to_string())?;
    let data = app.st.dir.clone();
    // Порожня робоча тека: навіть якби якийсь інструмент просочився, тут нічого читати.
    let wd = data.join("advisor");
    std::fs::create_dir_all(&wd).map_err(|e| e.to_string())?;
    let cfg = wd.join("mcp.json");
    let sys = wd.join("system.md");

    let adv = &app.adv;
    let mut slot = adv.slot.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() { return Err("Порадник ще відповідає".into()); }

    let cfg_json = serde_json::to_vec_pretty(&mcp_config(&res, &data)).map_err(|e| e.to_string())?;
    std::fs::write(&cfg, cfg_json).map_err(|e| e.to_string())?;
    std::fs::write(&sys, &req.system).map_err(|e| e.to_string())?;
    let args = cc_args(&cfg.to_string_lossy(), &sys.to_string_lossy(), req.session.as_deref(), req.model.as_deref());

    let mut cmd = Command::new(&claude);
    cmd.args(&args).current_dir(&wd)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Не вдалося запустити Claude Code: {e}"))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let id = adv.seq.fetch_add(1, Ordering::SeqCst) + 1;
    *slot = Some((id, Run::Cli(child)));
    drop(slot);

    let prompt = req.prompt;
    std::thread::spawn(move || {
        if let Some(mut si) = stdin { let _ = si.write_all(prompt.as_bytes()); }
    });
    let tail = Arc::new(Mutex::new(String::new()));
    let tail_w = tail.clone();
    let err_thread = stderr.map(|mut se| std::thread::spawn(move || {
        let mut raw = Vec::new();
        let _ = se.read_to_end(&mut raw);
        let buf = String::from_utf8_lossy(&raw).to_string();
        let start = buf.char_indices().rev().nth(STDERR_TAIL).map(|(i, _)| i).unwrap_or(0);
        if let Ok(mut t) = tail_w.lock() { *t = buf[start..].trim().to_string(); }
    }));

    let slot = adv.slot.clone();
    let conv = req.conv;
    std::thread::spawn(move || {
        let mut had_error = false;
        let mut st = StreamState::default();
        if let Some(so) = stdout {
            for line in BufReader::new(so).lines() {
                let Ok(line) = line else { break };
                for (kind, text) in parse_line(&line, &mut st) {
                    if kind == "error" { had_error = true; }
                    emit(&handle, &conv, kind, &text);
                }
            }
        }
        if let Some(t) = err_thread { let _ = t.join(); }
        // Слот порожній або чужий — процес забрав «Зупинити»: це не помилка.
        let mine = {
            // Отруєний м'ютекс не мусить лишити вкладку без `done`: дані слота самі по собі цілі.
            let mut g = slot.lock().unwrap_or_else(|e| e.into_inner());
            if g.as_ref().map(|(i, _)| *i) == Some(id) { g.take() } else { None }
        };
        if let Some((_, Run::Cli(mut child))) = mine {
            let code = child.wait().ok().and_then(|s| s.code());
            if code != Some(0) && !had_error {
                let t = tail.lock().map(|t| t.clone()).unwrap_or_default();
                let msg = if t.is_empty() {
                    format!("Claude Code завершився з кодом {}", code.map(|c| c.to_string()).unwrap_or("?".into()))
                } else { t };
                emit(&handle, &conv, "error", &msg);
            }
        }
        emit(&handle, &conv, "done", "");
    });
    Ok(())
}

#[tauri::command]
pub fn advisor_stop(app: State<App>) {
    kill_running(&app.adv);
}

/// Зупинка дерева `claude`; викликається і при виході з апки, інакше node-процес MCP та claude
/// пережили б закриття вікна й тримали б файли теки даних.
pub fn kill_running(adv: &Advisor) {
    let mut g = adv.slot.lock().unwrap_or_else(|e| e.into_inner());
    match g.take() {
        Some((_, Run::Cli(mut child))) => kill_tree(&mut child),
        // HTTP-цикл сам зупиниться між чанками, прибере MCP і звільнить слот; поки він
        // це робить, слот лишається зайнятим, щоб новий запуск не злетівся зі старим.
        Some((id, Run::Http(cancel))) => { cancel.store(true, Ordering::SeqCst); *g = Some((id, Run::Http(cancel))); }
        None => {}
    }
}

#[tauri::command]
pub fn advisor_hist_all(app: State<App>) -> Value {
    let v = app.st.read(HIST_FILE);
    if v.is_null() { json!({}) } else { v }
}

#[tauri::command]
pub fn advisor_hist_set(app: State<App>, v: Value) -> Result<(), String> {
    app.st.write(HIST_FILE, &v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(a: &[String], s: &str) -> usize { a.iter().position(|x| x == s).unwrap() }

    #[test]
    fn args_lock_down_tools() {
        let a = cc_args("c.json", "s.md", None, None);
        assert!(a.contains(&"--strict-mcp-config".to_string()));
        assert_eq!(a[pos(&a, "--tools") + 1], "WebSearch");
        assert!(!a.iter().any(|x| x.contains("WebFetch") || x.contains("Bash")));
        assert_eq!(a[pos(&a, "--setting-sources") + 1], "");
        assert!(!a.contains(&"--resume".to_string()) && !a.contains(&"--model".to_string()));
        assert_eq!(a[pos(&a, "--mcp-config") + 1], "c.json");
        assert_eq!(a[pos(&a, "--system-prompt-file") + 1], "s.md");
    }

    #[test]
    fn args_resume_and_model() {
        let a = cc_args("c", "s", Some("abc"), Some("sonnet"));
        assert_eq!(a[pos(&a, "--resume") + 1], "abc");
        assert_eq!(a[pos(&a, "--model") + 1], "sonnet");
    }

    #[test]
    fn parse_text_delta() {
        let l = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Привіт"}}}"#;
        assert_eq!(parse_line(l, &mut StreamState::default()), vec![("text", "Привіт".to_string())]);
    }

    #[test]
    fn parse_result_session_and_error() {
        let ok = r#"{"type":"result","is_error":false,"session_id":"abc","result":"x"}"#;
        // Дельт у цьому запуску не було → відповідь береться з result (п. 5).
        assert_eq!(parse_line(ok, &mut StreamState::default()), vec![("text", "x".to_string()), ("session", "abc".to_string())]);
        let bad = r#"{"type":"result","is_error":true,"session_id":"abc","result":"Збій"}"#;
        assert_eq!(parse_line(bad, &mut StreamState::default()), vec![("error", "Збій".to_string())]);
        assert!(parse_line("не json", &mut StreamState::default()).is_empty());
    }

    fn run(lines: &[&str]) -> Vec<Ev> {
        let mut st = StreamState::default();
        lines.iter().flat_map(|l| parse_line(l, &mut st)).collect()
    }

    #[test]
    fn text_blocks_are_separated() {
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#;
        let d1 = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Один"}}}"#;
        let d2 = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Два"}}}"#;
        // Перший блок без розділювача, другий — з ним.
        let evs = run(&[start, d1, start, d2]);
        let texts: Vec<&str> = evs.iter().map(|e| e.1.as_str()).collect();
        assert_eq!(texts, ["Один", "\n\n", "Два"]);
    }

    #[test]
    fn result_text_only_without_deltas() {
        let d = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Привіт"}}}"#;
        let r = r#"{"type":"result","is_error":false,"session_id":"s","result":"Привіт"}"#;
        assert_eq!(run(&[d, r]), vec![("text", "Привіт".to_string()), ("session", "s".to_string())]);
        assert_eq!(run(&[r]), vec![("text", "Привіт".to_string()), ("session", "s".to_string())]);
    }

    #[test]
    fn parse_fixture_stream() {
        let s = include_str!("fixtures/cc_stream_sample.jsonl");
        let evs = run(&s.lines().collect::<Vec<_>>());
        let kinds: Vec<&str> = evs.iter().map(|e| e.0).collect();
        assert_eq!(kinds, ["session", "tool", "text", "session"]);
        assert_eq!(evs[1].1, "WebSearch: курс долара сьогодні");
        let e = include_str!("fixtures/cc_auth_error.jsonl");
        let evs = run(&e.lines().collect::<Vec<_>>());
        assert_eq!(evs[0].0, "error");
    }

    #[test]
    fn find_claude_nothing() {
        let t = std::env::temp_dir().join(format!("groshi-adv-{}", std::process::id()));
        let (a, b, p) = (t.join("la"), t.join("ad"), t.join("path"));
        for d in [&a, &b, &p] { std::fs::create_dir_all(d).unwrap(); }
        assert_eq!(find_claude(p.to_str().unwrap(), Some(&a), Some(&b)), None);
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn mcp_config_shape() {
        let c = mcp_config(Path::new(r"C:\res"), Path::new(r"C:\data"));
        assert_eq!(c["mcpServers"]["groshi"]["env"]["GROSHI_PSEUDO"], "1");
        assert_eq!(c["mcpServers"]["groshi"]["env"]["GROSHI_DIR"], r"C:\data");
        assert!(c["mcpServers"]["groshi"]["args"][0].as_str().unwrap().ends_with("groshi-mcp.js"));
    }

    fn recorder() -> (Arc<Mutex<Vec<String>>>, Notify) {
        let ev = Arc::new(Mutex::new(vec![]));
        let e2 = ev.clone();
        (ev, Box::new(move |k: &str, _: &str| e2.lock().unwrap().push(k.to_string())))
    }

    #[test]
    fn guard_dropped_unfinished_frees_slot_and_reports() {
        let adv = Advisor::default();
        let (id, _) = adv.claim_http().unwrap();
        let (ev, notify) = recorder();
        let g = RunGuard::new(adv.clone_slot(), id, notify);
        assert!(adv.claim_http().is_err());
        drop(g);
        assert!(adv.claim_http().is_ok(), "слот вільний після drop");
        assert_eq!(*ev.lock().unwrap(), ["error", "done"]);
    }

    #[test]
    fn guard_survives_panic() {
        let adv = Advisor::default();
        let (id, _) = adv.claim_http().unwrap();
        let (ev, notify) = recorder();
        let g = RunGuard::new(adv.clone_slot(), id, notify);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || { let _g = g; panic!("збій задачі"); }));
        assert!(r.is_err());
        assert!(adv.claim_http().is_ok());
        assert_eq!(*ev.lock().unwrap(), ["error", "done"]);
    }

    #[test]
    fn guard_finished_sends_only_done() {
        let adv = Advisor::default();
        let (id, _) = adv.claim_http().unwrap();
        let (ev, notify) = recorder();
        RunGuard::new(adv.clone_slot(), id, notify).finish();
        assert!(adv.claim_http().is_ok());
        assert_eq!(*ev.lock().unwrap(), ["done"]);
    }

    #[test]
    fn cc_auth_keeps_only_two_fields() {
        let raw = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"user@example.com","orgName":"Org"}"#;
        let v = parse_cc_auth(raw).unwrap();
        assert_eq!(v, json!({"logged_in": true, "method": "claude.ai"}));
        assert!(!v.to_string().contains("example.com"));
        assert_eq!(parse_cc_auth(r#"{"loggedIn":false}"#).unwrap(), json!({"logged_in": false, "method": ""}));
        assert!(parse_cc_auth("not json").is_err());
    }

    #[test]
    fn cc_login_line_quotes_path() {
        let l = cc_login_line(Path::new("C:/Tools & Co/a^b (x)/claude.exe")).unwrap();
        assert_eq!(l, "/c start \"Вхід у Claude Code\" \"C:/Tools & Co/a^b (x)/claude.exe\" auth login");
        assert!(cc_login_line(Path::new("C:/100%/claude.exe")).is_err());
        assert!(cc_login_line(Path::new("C:/a\"b/claude.exe")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn run_capture_reports_failure_and_success() {
        let cmd = Path::new("cmd");
        let e = run_capture(cmd, &["/c", "exit", "3"], std::time::Duration::from_secs(10)).unwrap_err();
        assert!(e.contains('3'), "{e}");
        let e = run_capture(cmd, &["/c", "echo boom 1>&2 & exit 1"], std::time::Duration::from_secs(10)).unwrap_err();
        assert_eq!(e, "boom");
        assert_eq!(run_capture(cmd, &["/c", "echo hi"], std::time::Duration::from_secs(10)).unwrap().trim(), "hi");
    }

    #[test]
    fn advisor_gate_message() {
        assert!(advisor_gate(true).is_ok());
        assert_eq!(advisor_gate(false).unwrap_err(), "Увімкніть Порадника в Налаштуваннях → Порадник");
    }

    #[test]
    fn safe_tokens() {
        assert!(safe_token("0a-b_c", "-_"));
        assert!(!safe_token("--model", "-_"));
        assert!(!safe_token("a b", "-_"));
    }
}
