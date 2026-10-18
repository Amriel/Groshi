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
    /// Глибина міркування (`--effort`); лише з білого списку `EFFORTS`.
    pub effort: Option<String>,
}

/// Рівні effort, які знає CLI (`--effort`) і API (`output_config.effort`). Значення йде в аргумент
/// процесу й у тіло запиту, тому приймаємо лише ці п'ять, а не «безпечні символи».
pub(crate) const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

pub(crate) fn valid_effort(s: &str) -> bool { EFFORTS.contains(&s) }

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
pub fn cc_args(cfg_path: &str, sys_path: &str, session: Option<&str>, model: Option<&str>, effort: Option<&str>) -> Vec<String> {
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
    if let Some(e) = effort { a.push("--effort".into()); a.push(e.into()); }
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
            if let Some(u) = usage_event(&v) { out.push(("usage", u)); }
            out
        }
        Some("rate_limit_event") => limits_event(&v["rate_limit_info"]).map(|l| vec![("limits", l)]).unwrap_or_default(),
        _ => vec![],
    }
}

/// Лічильники з `result`. Лише числа: текст із відповіді CLI (назви моделей, ідентифікатори) у
/// подію не потрапляє. Нуль у всіх полях — подію не шлемо, щоб вкладка не малювала порожній підпис.
fn usage_event(v: &Value) -> Option<String> {
    let u = &v["usage"];
    let n = |x: &Value| x.as_u64().unwrap_or(0);
    let (input, output) = (n(&u["input_tokens"]), n(&u["output_tokens"]));
    let (cache_read, cache_write) = (n(&u["cache_read_input_tokens"]), n(&u["cache_creation_input_tokens"]));
    let cost = v["total_cost_usd"].as_f64().filter(|c| c.is_finite() && *c >= 0.0).unwrap_or(0.0);
    let turns = n(&v["num_turns"]);
    if input + output + cache_read + cache_write == 0 && cost == 0.0 { return None; }
    Some(json!({"input": input, "output": output, "cache_read": cache_read, "cache_write": cache_write,
                "cost_usd": cost, "turns": turns}).to_string())
}

/// `rate_limit_event.rate_limit_info` → `{type, status, utilization, resets_at}`. Тип і статус беремо лише з
/// відомих переліків: невідомі значення CLI вкладка не вміє підписати, тож краще пропустити, ніж показати сміття.
/// Поля можуть бути відсутні (тоді `null`), `utilization` обмежено до 0..1.
fn limits_event(info: &Value) -> Option<String> {
    let t = info["rateLimitType"].as_str().filter(|t| ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"].contains(t))?;
    let status = info["status"].as_str().filter(|s| ["allowed", "allowed_warning", "rejected"].contains(s))?;
    // Формат ще не бачено вживу, тож нормалізуємо: відсотки (1..100) замість частки й мілісекунди замість секунд.
    let util = info["utilization"].as_f64().filter(|u| u.is_finite())
        .map(|u| if u > 1.0 && u <= 100.0 { u / 100.0 } else { u }.clamp(0.0, 1.0));
    let resets = info["resetsAt"].as_f64().filter(|r| r.is_finite() && *r > 0.0)
        .map(|r| if r > 1e12 { r / 1000.0 } else { r } as u64);
    Some(json!({"type": t, "status": status, "utilization": util, "resets_at": resets}).to_string())
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

type Ver = (u32, u32, u32);

/// Перша група `N.N.N` у виводі `claude --version` («2.1.268 (Claude Code)»). Хвіст на кшталт
/// `-beta` чи суфікс збірки відкидається: порівнюємо лише числа.
pub fn parse_cli_version(s: &str) -> Option<Ver> {
    for tok in s.split_whitespace() {
        let t = tok.trim_start_matches(|c: char| c == 'v' || c == 'V' || c == '(');
        let mut it = t.splitn(3, '.');
        let num = |x: Option<&str>| -> Option<u32> {
            let x = x?;
            let d: String = x.chars().take_while(char::is_ascii_digit).collect();
            if d.is_empty() { None } else { d.parse().ok() }
        };
        if let (Some(a), Some(b), Some(c)) = (num(it.next()), num(it.next()), num(it.next())) {
            return Some((a, b, c));
        }
    }
    None
}

/// Найновіша копія. Порядок у зрізі = пріоритет за рівних версій (PATH/WinGet перед копією Claude Desktop:
/// її може підмінити оновлення десктопа). Невідома версія — найнижча; серед самих невідомих лишається перша.
pub fn pick_newest(cands: &[(PathBuf, Option<Ver>)]) -> Option<PathBuf> {
    let mut best: Option<&(PathBuf, Option<Ver>)> = None;
    for c in cands {
        if best.map_or(true, |b| c.1 > b.1) { best = Some(c); }
    }
    best.map(|b| b.0.clone())
}

/// Звідки копія, без повного шляху в UI: "winget" | "npm" | "desktop" | "path".
pub fn cc_source(p: &Path) -> &'static str {
    let s = p.to_string_lossy().to_lowercase().replace('\\', "/");
    // WinGet portable кладе в PATH символьне посилання Links\claude.exe: це та сама WinGet-копія.
    if s.contains("/winget/packages/anthropic.claudecode_") || s.contains("/winget/links/") { "winget" }
    else if s.contains("/claude/claude-code/") { "desktop" }
    else if s.ends_with("/npm/claude.cmd") { "npm" }
    else { "path" }
}

/// Усі наявні копії з версією, якщо її видно зі шляху (Claude Desktop кладе в теку `<версія>`).
/// Порядок: PATH, WinGet, npm, Claude Desktop.
fn claude_candidates(path: &str, local_appdata: Option<&Path>, appdata: Option<&Path>) -> Vec<(PathBuf, Option<Ver>)> {
    let mut v: Vec<(PathBuf, Option<Ver>)> = Vec::new();
    // Символьне посилання з PATH розкриваємо: інакше Links\claude.exe виглядав би окремою копією «PATH».
    if let Some(p) = find_in_path(path, "claude") { v.push((resolve_link(&p), None)); }
    if let Some(la) = local_appdata {
        if let Ok(rd) = std::fs::read_dir(la.join("Microsoft").join("WinGet").join("Packages")) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with("Anthropic.ClaudeCode_") {
                    let p = e.path().join("claude.exe");
                    if p.is_file() { v.push((p, None)); }
                }
            }
        }
    }
    if let Some(ad) = appdata {
        let p = ad.join("npm").join("claude.cmd");
        if p.is_file() { v.push((p, None)); }
        // <версія>\<хеш>\claude.exe: на один рівень глибше за теку версії.
        if let Ok(rd) = std::fs::read_dir(ad.join("Claude").join("claude-code")) {
            for e in rd.flatten() {
                let Some(ver) = parse_dir_version(&e.file_name().to_string_lossy()) else { continue };
                let Ok(sub) = std::fs::read_dir(e.path()) else { continue };
                for h in sub.flatten() {
                    let p = h.path().join("claude.exe");
                    // Порожній claude.exe лишається від перерваного розпакування: це не копія.
                    if std::fs::metadata(&p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false) { v.push((p, Some(ver))); }
                }
            }
        }
    }
    v
}

/// Шлях без символьних посилань і без префікса `\\?\` (його додає canonicalize на Windows). Не вдалось — як є.
pub fn resolve_link(p: &Path) -> PathBuf {
    match std::fs::canonicalize(p) {
        Ok(c) => PathBuf::from(c.to_string_lossy().trim_start_matches(r"\\?\").to_string()),
        Err(_) => p.to_path_buf(),
    }
}

/// Тека версії Claude Desktop — рівно `N.N.N`: з будь-яким суфіксом (`2.1.299-old`) це не наша копія.
pub fn parse_dir_version(name: &str) -> Option<Ver> {
    let p: Vec<&str> = name.split('.').collect();
    if p.len() != 3 || p.iter().any(|x| x.is_empty() || !x.chars().all(|c| c.is_ascii_digit())) { return None; }
    Some((p[0].parse().ok()?, p[1].parse().ok()?, p[2].parse().ok()?))
}

/// Без дублів за шляхом (без урахування регістру): один файл у PATH і в теці WinGet запускаємо один раз.
pub fn dedup_cands(c: &mut Vec<(PathBuf, Option<Ver>)>) {
    let mut seen = std::collections::HashSet::new();
    c.retain(|x| seen.insert(x.0.to_string_lossy().to_lowercase()));
}

/// Копія, яку можна оновити з апки: winget > npm > PATH, без Claude Desktop — незалежно від того, яка копія
/// найновіша й обрана для запуску. Інакше за пари «WinGet 2.1.268 + Desktop 2.1.299» WinGet-копію не оновлювали б ніколи.
pub fn pick_updatable(c: &[(PathBuf, Option<Ver>)]) -> Option<usize> {
    let rank = |p: &Path| match cc_source(p) { "winget" => Some(0), "npm" => Some(1), "path" => Some(2), _ => None };
    let mut best: Option<(usize, i32)> = None;
    for (i, x) in c.iter().enumerate() {
        if let Some(r) = rank(&x.0) { if best.map_or(true, |b| r < b.1) { best = Some((i, r)); } }
    }
    best.map(|b| b.0)
}

/// `winget` у PATH, інакше псевдонім застосунку з WindowsApps (у PATH трею його часто немає).
fn winget_program() -> String {
    if find_in_path(&std::env::var("PATH").unwrap_or_default(), "winget").is_some() { return "winget".into(); }
    if let Some(la) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(la).join("Microsoft").join("WindowsApps").join("winget.exe");
        if p.is_file() { return p.to_string_lossy().to_string(); }
    }
    "winget".into()
}

#[derive(Clone)]
struct Found { path: PathBuf, source: &'static str, version: Option<Ver>, upd: Option<(PathBuf, &'static str, Option<Ver>)> }

/// Пошук обходить теки диска й запускає `--version` кожної копії, тож результат живе до кінця роботи
/// застосунку; `advisor_cc_update` скидає його, бо після оновлення копія стає новішою.
static FOUND: Mutex<Option<Found>> = Mutex::new(None);

fn found_env() -> Option<Found> {
    if let Some(f) = FOUND.lock().ok().and_then(|g| g.clone()) { return Some(f); }
    let path = std::env::var("PATH").unwrap_or_default();
    let la = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let ad = std::env::var_os("APPDATA").map(PathBuf::from);
    let mut c = claude_candidates(&path, la.as_deref(), ad.as_deref());
    // Один і той самий файл може лежати і в PATH, і в теці WinGet: `--version` двічі не запускаємо.
    dedup_cands(&mut c);
    for x in c.iter_mut() {
        if x.1.is_none() {
            x.1 = run_output(&x.0, &["--version"], std::time::Duration::from_secs(10)).ok()
                .and_then(|(_, _, out, _)| parse_cli_version(&out));
        }
    }
    let best = pick_newest(&c)?;
    let version = c.iter().find(|x| x.0 == best).and_then(|x| x.1);
    let upd = pick_updatable(&c).map(|i| (c[i].0.clone(), cc_source(&c[i].0), c[i].1));
    let f = Found { source: cc_source(&best), path: best, version, upd };
    if let Ok(mut g) = FOUND.lock() { *g = Some(f.clone()); }
    Some(f)
}

fn find_claude_env() -> Option<PathBuf> { found_env().map(|f| f.path) }

fn reset_found() { if let Ok(mut g) = FOUND.lock() { *g = None; } }

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
        // Явна перевірка (відкриття Порадника, «Оновити список») читає диск наново: після оновлення копія вже інша.
        reset_found();
        let f = found_env();
        let version = f.as_ref().and_then(|f| f.version).map(|(a, b, c)| format!("{a}.{b}.{c}"));
        let upd = f.as_ref().and_then(|f| f.upd.clone());
        json!({"found": f.is_some(), "path": f.as_ref().map(|f| f.path.to_string_lossy().to_string()),
               "version": version, "source": f.as_ref().map(|f| f.source), "node": node_found(),
               "upd_source": upd.as_ref().map(|u| u.1), "upd_version": upd.as_ref().and_then(|u| u.2).map(|(a, b, c)| format!("{a}.{b}.{c}"))})
    }).await.unwrap_or_else(|_| json!({"found": false, "path": null, "version": null, "source": null, "node": false,
                                      "upd_source": null, "upd_version": null}))
}

/// Запускає зовнішню програму без вікна й чекає не довше за `limit`. Без таймауту завислий `claude`/`lms`
/// тримав би кнопку в UI вічно. Код виходу перевіряється: інакше невдалий `lms server start` виглядав би
/// успіхом. Вивід збирають окремі потоки в спільні буфери, а завершення визначає `try_wait`, а не EOF каналу:
/// демон, що успадкував канал (`lms server start`), тримав би його відкритим і блокував читання.
pub(crate) fn run_capture(path: &Path, args: &[&str], limit: std::time::Duration) -> Result<String, String> {
    let (ok, code, out, err) = run_output(path, args, limit)?;
    if ok { return Ok(out); }
    let line = err.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let snippet: String = line.chars().take(120).collect();
    Err(if snippet.is_empty() { format!("Команда завершилась з кодом {code}") } else { snippet })
}

/// Те саме, що `run_capture`, але повертає вивід за будь-якого коду виходу: `(успіх, код, stdout, stderr)`.
/// Потрібно для `claude auth status`: без входу він навмисно виходить з кодом 1, хоча друкує правильний JSON,
/// і «код ≠ 0 — помилка» показувало «Стан входу невідомий» замість «Не увійдено».
pub(crate) fn run_output(path: &Path, args: &[&str], limit: std::time::Duration) -> Result<(bool, i32, String, String), String> {
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
    Ok((status.success(), status.code().unwrap_or(-1), text(&out), text(&err)))
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
        let (ok, code, out, _) = run_output(&claude, &["auth", "status", "--json"], std::time::Duration::from_secs(15))?;
        // Без входу код виходу 1, але JSON правильний — довіряємо JSON, а код показуємо лише коли JSON немає.
        parse_cc_auth(&out).map_err(|e| if ok { e } else { format!("{e} (код {code})") })
    }).await.map_err(|e| e.to_string())?
}

/// Службовий запит `initialize` протоколу stream-json: у відповіді є живий список моделей цього облікового запису
/// (CLI не має для цього окремої команди). Ім'я `request_id` фіксоване — за ним відрізняємо потрібний рядок.
const MODELS_REQ: &str = r#"{"type":"control_request","request_id":"models","request":{"subtype":"initialize"}}"#;

fn clip(v: &Value, n: usize) -> String { v.as_str().unwrap_or("").chars().take(n).collect() }

/// З рядка `control_response` бере ЛИШЕ `models[]` і з кожної моделі `{value, name, description, efforts}`.
/// У тій самій відповіді лежать `account` (пошта, організація), `commands`, `agents`, шляхи: вебвʼю і
/// журнал його помилок їх бачити не мусять, тому все інше відкидається тут, а не в UI.
/// Модель із непридатним для аргументу `--model` значенням пропускається: вибрати її було б неможливо.
pub fn parse_cc_models(line: &str) -> Option<Vec<Value>> { models_line(line)?.ok() }

/// None — рядок не наш; Some(Err) — наш `control_response`, але без `models` (напр. subtype "error"):
/// чекати далі марно, тож чекачу одразу віддається помилка замість 20 с мовчання.
fn models_line(line: &str) -> Option<Result<Vec<Value>, String>> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v["type"] != "control_response" || v["response"]["request_id"] != "models" { return None; }
    let Some(models) = v["response"]["response"]["models"].as_array() else {
        return Some(Err("Claude Code не віддав список моделей".into()));
    };
    Some(Ok(models.iter().filter_map(|m| {
        let value = clip(&m["value"], 120);
        if !safe_token(&value, "-_.[]") { return None; }
        let name = clip(&m["displayName"], 120);
        // Haiku не має ні supportsEffort, ні списку: порожній масив = «effort не підтримується».
        let efforts: Vec<&str> = if m["supportsEffort"] == true {
            EFFORTS.iter().copied().filter(|e| m["supportedEffortLevels"].as_array().is_some_and(|a| a.iter().any(|x| x == e))).collect()
        } else { vec![] };
        Some(json!({"value": value, "name": if name.is_empty() { value.clone() } else { name },
                    "description": clip(&m["description"], 120), "efforts": efforts}))
    }).collect()))
}

/// Запускає `claude` у порожній теці порадника, шле `initialize` і чекає рядок з моделями. stdin тримаємо
/// відкритим до відповіді: на EOF CLI виходить, не встигнувши відповісти. Читання йде окремим потоком,
/// бо `lines()` блокує, а таймаут мусить спрацювати навіть коли CLI мовчить.
fn cc_models_blocking(claude: &Path, wd: &Path) -> Result<Vec<Value>, String> {
    let mut cmd = Command::new(claude);
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
              "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands"])
        .current_dir(wd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Не вдалося запустити Claude Code: {e}"))?;
    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<Value>, String>>();
    if let Some(so) = stdout {
        std::thread::spawn(move || {
            for line in BufReader::new(so).lines() {
                let Ok(line) = line else { break };
                if let Some(m) = models_line(&line) { let _ = tx.send(m); break; }
            }
        });
    }
    if let Some(si) = stdin.as_mut() {
        let _ = si.write_all(MODELS_REQ.as_bytes());
        let _ = si.write_all(b"\n");
        let _ = si.flush();
    }
    let res = rx.recv_timeout(std::time::Duration::from_secs(20));
    kill_tree(&mut child);
    drop(stdin);
    res.map_err(|_| "Claude Code не відповів".to_string())?
}

#[tauri::command]
pub async fn advisor_cc_models(app: State<'_, App>) -> Result<Vec<Value>, String> {
    crate::require_advisor(&app.st)?;
    // Та сама порожня тека, що й у запусків: навіть якби щось просочилось, читати там нічого.
    let wd = app.st.dir.join("advisor");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&wd).map_err(|e| e.to_string())?;
        let claude = find_claude_env().ok_or("Claude Code не знайдено")?;
        cc_models_blocking(&claude, &wd)
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

/// Рядок для `cmd /c start` з оновленням: WinGet-копію оновлює `winget`, npm- і PATH-копію — сам `claude update`.
/// Копію Claude Desktop оновлює той застосунок, тож тут відмова. Шлях перевіряється так само, як у `cc_login_line`.
pub fn cc_update_line(claude: &Path, source: &str) -> Result<String, String> {
    match source {
        "winget" => Ok("/c start \"Оновлення Claude Code\" winget upgrade --id Anthropic.ClaudeCode -e".to_string()),
        "npm" | "path" => {
            let p = claude.to_string_lossy();
            if p.contains('"') || p.contains('%') { return Err("Шлях до Claude Code містить недопустимі символи".into()); }
            Ok(format!("/c start \"Оновлення Claude Code\" \"{p}\" update"))
        }
        "desktop" => Err("Цю копію оновлює застосунок Claude Desktop".into()),
        _ => Err("Невідоме джерело Claude Code".into()),
    }
}

/// Видиме вікно консолі, як у `advisor_cc_login`. Без `require_advisor`: команда нічого не шле до Anthropic
/// про дані, лише оновлює програму на комп'ютері.
#[tauri::command]
pub async fn advisor_cc_update() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let f = found_env().ok_or("Claude Code не знайдено")?;
        let (up, us, _) = f.upd.clone().ok_or("Цю копію оновлює застосунок Claude Desktop")?;
        let line = cc_update_line(&up, us)?;
        reset_found();
        let mut cmd = Command::new("cmd");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.raw_arg(&line);
        }
        #[cfg(not(windows))]
        cmd.args(line.split_whitespace());
        no_window(&mut cmd);
        cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

/// Команда тихого оновлення (без вікна): прапорці winget вимикають будь-які запитання, інакше процес без консолі
/// завис би на «погодьтеся з умовами» до таймауту. Копію Claude Desktop оновлює той застосунок — `None`.
pub fn autoupdate_cmd(source: &str, claude: &Path) -> Option<(String, Vec<String>)> {
    match source {
        "winget" => Some(("winget".into(), ["upgrade", "--id", "Anthropic.ClaudeCode", "-e", "--silent",
            "--disable-interactivity", "--accept-source-agreements", "--accept-package-agreements"]
            .iter().map(|x| x.to_string()).collect())),
        "npm" | "path" => Some((claude.to_string_lossy().to_string(), vec!["update".into()])),
        _ => None,
    }
}

/// Коди winget «оновлень немає» — не помилка: UPDATE_NOT_APPLICABLE 0x8A15002B, INSTALL_TECHNOLOGY/PACKAGE_ALREADY_INSTALLED 0x8A150061.
pub fn winget_no_update(code: i32) -> bool {
    code == 0x8A15_002Bu32 as i32 || code == 0x8A15_0061u32 as i32
}

/// Тихе оновлення у фоні. Нічого про дані користувача не шле, тож без `require_advisor`.
#[tauri::command]
pub async fn advisor_cc_autoupdate() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let f = found_env().ok_or("Claude Code не знайдено")?;
        let fmt = |v: Option<Ver>| v.map(|(a, b, c)| format!("{a}.{b}.{c}"));
        let Some((up, us, uv)) = f.upd.clone() else {
            return Ok(json!({"updated": false, "skipped": "desktop"}));
        };
        let Some((mut prog, args)) = autoupdate_cmd(us, &up) else {
            return Ok(json!({"updated": false, "skipped": "desktop"}));
        };
        if prog == "winget" { prog = winget_program(); }
        let a: Vec<&str> = args.iter().map(String::as_str).collect();
        // Причина (запуск/таймаут) лишається в тексті, але коротка й без шляхів.
        let (ok, code, _, _) = run_output(Path::new(&prog), &a, std::time::Duration::from_secs(300))
            .map_err(|e| format!("Не вдалося оновити Claude Code: {}", clip(&Value::String(e.replace(&*prog, "…")), 60)))?;
        if !ok && !(us == "winget" && winget_no_update(code)) {
            return Err(format!("Не вдалося оновити Claude Code (код {code})"));
        }
        reset_found();
        let n = found_env();
        let to = n.as_ref().and_then(|n| n.upd.as_ref()).and_then(|u| u.2);
        Ok(json!({"updated": to > uv && to.is_some(), "from": fmt(uv), "to": fmt(to)}))
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
    if let Some(e) = &req.effort { if !valid_effort(e) { return Err("Некоректний рівень effort".into()); } }

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
    let args = cc_args(&cfg.to_string_lossy(), &sys.to_string_lossy(), req.session.as_deref(), req.model.as_deref(), req.effort.as_deref());

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
        let a = cc_args("c.json", "s.md", None, None, None);
        assert!(a.contains(&"--strict-mcp-config".to_string()));
        assert_eq!(a[pos(&a, "--tools") + 1], "WebSearch");
        assert!(!a.iter().any(|x| x.contains("WebFetch") || x.contains("Bash")));
        assert_eq!(a[pos(&a, "--setting-sources") + 1], "");
        assert!(!a.contains(&"--resume".to_string()) && !a.contains(&"--model".to_string()) && !a.contains(&"--effort".to_string()));
        assert_eq!(a[pos(&a, "--mcp-config") + 1], "c.json");
        assert_eq!(a[pos(&a, "--system-prompt-file") + 1], "s.md");
    }

    #[test]
    fn args_resume_and_model() {
        let a = cc_args("c", "s", Some("abc"), Some("sonnet"), None);
        assert_eq!(a[pos(&a, "--resume") + 1], "abc");
        assert_eq!(a[pos(&a, "--model") + 1], "sonnet");
    }

    #[test]
    fn args_effort_only_when_given() {
        let a = cc_args("c", "s", None, None, Some("xhigh"));
        assert_eq!(a[pos(&a, "--effort") + 1], "xhigh");
        assert!(!cc_args("c", "s", None, None, None).contains(&"--effort".to_string()));
    }

    #[test]
    fn effort_whitelist() {
        for e in ["low", "medium", "high", "xhigh", "max"] { assert!(valid_effort(e), "{e}"); }
        for e in ["", "LOW", "--model", "high ", "ultra", "medium;x"] { assert!(!valid_effort(e), "{e}"); }
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
    fn cli_version_parse() {
        assert_eq!(parse_cli_version("2.1.268 (Claude Code)"), Some((2, 1, 268)));
        assert_eq!(parse_cli_version("claude v2.1.302-beta\n"), Some((2, 1, 302)));
        assert_eq!(parse_cli_version("2.1.295"), Some((2, 1, 295)));
        assert_eq!(parse_cli_version("немає версії 2.1"), None);
        assert_eq!(parse_cli_version(""), None);
    }

    #[test]
    fn pick_newest_by_semver_then_priority() {
        let c = |n: &str, v: Option<Ver>| (PathBuf::from(n), v);
        // 2.1.302 > 2.1.99 за числами, а не за рядками
        let l = [c("winget", Some((2, 1, 99))), c("desktop", Some((2, 1, 302)))];
        assert_eq!(pick_newest(&l), Some(PathBuf::from("desktop")));
        // рівні версії: перший у списку (PATH/WinGet) попереду копії Claude Desktop
        let l = [c("path", Some((2, 1, 299))), c("desktop", Some((2, 1, 299)))];
        assert_eq!(pick_newest(&l), Some(PathBuf::from("path")));
        // невідома версія найнижча, навіть якщо стоїть першою
        let l = [c("path", None), c("desktop", Some((0, 0, 1)))];
        assert_eq!(pick_newest(&l), Some(PathBuf::from("desktop")));
        // самі невідомі: перша
        assert_eq!(pick_newest(&[c("a", None), c("b", None)]), Some(PathBuf::from("a")));
        assert_eq!(pick_newest(&[]), None);
    }

    #[test]
    fn cc_source_by_path() {
        // Корінь профілю нейтральний (D:\Profile): сторож приватності не пропускає шляхів до тек користувачів.
        assert_eq!(cc_source(Path::new(r"D:\Profile\AppData\Local\Microsoft\WinGet\Packages\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\claude.exe")), "winget");
        assert_eq!(cc_source(Path::new(r"D:\Profile\AppData\Roaming\Claude\claude-code\2.1.299\abc\claude.exe")), "desktop");
        assert_eq!(cc_source(Path::new(r"D:\Profile\AppData\Roaming\npm\claude.cmd")), "npm");
        assert_eq!(cc_source(Path::new(r"C:\Tools\claude.exe")), "path");
    }

    #[test]
    fn candidates_read_desktop_version_from_dir() {
        let t = std::env::temp_dir().join(format!("groshi-adv-cand-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        let (ad, p) = (t.join("ad"), t.join("path"));
        for (v, h) in [("2.1.295", "aaa"), ("2.1.299", "bbb")] {
            let d = ad.join("Claude").join("claude-code").join(v).join(h);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("claude.exe"), b"MZ").unwrap();
        }
        std::fs::create_dir_all(&p).unwrap();
        let c = claude_candidates(p.to_str().unwrap(), None, Some(&ad));
        let mut vs: Vec<_> = c.iter().map(|x| x.1).collect();
        vs.sort();
        assert_eq!(vs, vec![Some((2, 1, 295)), Some((2, 1, 299))]);
        let best = pick_newest(&c).unwrap();
        assert!(best.to_string_lossy().contains("2.1.299"));
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn winget_links_is_winget_and_dedups() {
        let l = Path::new(r"D:\Profile\AppData\Local\Microsoft\WinGet\Links\claude.exe");
        assert_eq!(cc_source(l), "winget");
        let mut c = vec![(PathBuf::from(r"D:\Profile\Tools\Claude.exe"), None), (PathBuf::from(r"d:\profile\tools\claude.EXE"), None),
                         (PathBuf::from(r"D:\Profile\Other\claude.exe"), None)];
        dedup_cands(&mut c);
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn strict_dir_versions() {
        assert_eq!(parse_dir_version("2.1.299"), Some((2, 1, 299)));
        assert_eq!(parse_dir_version("2.1.299-old"), None);
        assert_eq!(parse_dir_version("2.1.299.bak"), None);
        assert_eq!(parse_dir_version("2.1"), None);
        assert_eq!(parse_dir_version("v2.1.299"), None);
    }

    #[test]
    fn desktop_candidates_skip_empty_and_suffixed() {
        let t = std::env::temp_dir().join(format!("groshi-adv-cand2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        let ad = t.join("ad");
        for (v, body) in [("2.1.295", &b"MZ"[..]), ("2.1.299", &b""[..]), ("2.1.300-old", &b"MZ"[..])] {
            let d = ad.join("Claude").join("claude-code").join(v).join("h");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("claude.exe"), body).unwrap();
        }
        let c = claude_candidates("", None, Some(&ad));
        assert_eq!(c.iter().map(|x| x.1).collect::<Vec<_>>(), vec![Some((2, 1, 295))]);
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn updatable_copy_ignores_desktop_and_prefers_winget() {
        let w = r"D:\Profile\AppData\Local\Microsoft\WinGet\Packages\Anthropic.ClaudeCode_x\claude.exe";
        let d = r"D:\Profile\AppData\Roaming\Claude\claude-code\2.1.299\h\claude.exe";
        let n = r"D:\Profile\AppData\Roaming\npm\claude.cmd";
        let c = vec![(PathBuf::from(d), Some((2, 1, 299))), (PathBuf::from(n), Some((2, 1, 200))), (PathBuf::from(w), Some((2, 1, 268)))];
        assert_eq!(pick_updatable(&c), Some(2));
        assert_eq!(pick_newest(&c), Some(PathBuf::from(d)));
        assert_eq!(pick_updatable(&c[..2]), Some(1));
        assert_eq!(pick_updatable(&c[..1]), None);
    }

    #[test]
    fn autoupdate_commands() {
        let (p, a) = autoupdate_cmd("winget", Path::new("D:/x/claude.exe")).unwrap();
        assert_eq!(p, "winget");
        assert_eq!(a.join(" "), "upgrade --id Anthropic.ClaudeCode -e --silent --disable-interactivity --accept-source-agreements --accept-package-agreements");
        let (p, a) = autoupdate_cmd("npm", Path::new("D:/Tools/claude.cmd")).unwrap();
        assert_eq!((p.as_str(), a), ("D:/Tools/claude.cmd", vec!["update".to_string()]));
        assert!(autoupdate_cmd("path", Path::new("D:/a/claude.exe")).is_some());
        assert!(autoupdate_cmd("desktop", Path::new("D:/d/claude.exe")).is_none());
    }

    #[test]
    fn winget_no_update_codes() {
        assert!(winget_no_update(-1978335189));
        assert!(winget_no_update(-1978335135));
        assert!(!winget_no_update(1));
        assert!(!winget_no_update(0));
    }

    #[test]
    fn cc_update_lines() {
        let w = cc_update_line(Path::new("C:/x/claude.exe"), "winget").unwrap();
        assert_eq!(w, "/c start \"Оновлення Claude Code\" winget upgrade --id Anthropic.ClaudeCode -e");
        let n = cc_update_line(Path::new("C:/Tools & Co/claude.cmd"), "npm").unwrap();
        assert_eq!(n, "/c start \"Оновлення Claude Code\" \"C:/Tools & Co/claude.cmd\" update");
        assert!(cc_update_line(Path::new("C:/a/claude.exe"), "path").unwrap().ends_with("\"C:/a/claude.exe\" update"));
        assert!(cc_update_line(Path::new("C:/100%/claude.exe"), "path").is_err());
        assert!(cc_update_line(Path::new("C:/a\"b/claude.exe"), "npm").is_err());
        assert!(cc_update_line(Path::new("C:/d/claude.exe"), "desktop").unwrap_err().contains("Claude Desktop"));
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

    /// `claude auth status` без входу виходить з кодом 1, але друкує JSON — його треба розібрати, а не вважати збоєм.
    #[cfg(windows)]
    #[test]
    fn auth_status_json_survives_exit_code_1() {
        // JSON через файл: лапки в аргументі `echo` cmd.exe віддав би з екрануванням Rust.
        let p = std::env::temp_dir().join("groshi_auth_status_test.json");
        std::fs::write(&p, r#"{"loggedIn":false,"authMethod":"none"}"#).unwrap();
        let line = format!("type {} & exit 1", p.display()); // без лапок: Rust екранував би їх для cmd
        let (ok, code, out, _) = run_output(Path::new("cmd"), &["/c", &line], std::time::Duration::from_secs(10)).unwrap();
        let _ = std::fs::remove_file(&p);
        assert!(!ok);
        assert_eq!(code, 1);
        let v = parse_cc_auth(&out).unwrap();
        assert_eq!(v["logged_in"], false);
        assert_eq!(v["method"], "none");
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

    #[test]
    fn model_values_pass_safe_token() {
        for m in ["default", "opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"] { assert!(safe_token(m, "-_.[]"), "{m}"); }
        assert!(!safe_token("--model", "-_.[]"));
    }

    // Штучна відповідь initialize: `account` з поштою має зникнути безслідно.
    const MODELS_LINE: &str = r#"{"type":"control_response","response":{"subtype":"success","request_id":"models",
      "response":{"commands":[{"name":"secret-cmd"}],"account":{"email":"user@example.com","organization":"Example Org"},
      "models":[
        {"value":"default","resolvedModel":"claude-x","displayName":"Default (recommended)","description":"Model X · Best","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"],"supportsFastMode":true},
        {"value":"haiku","displayName":"Haiku","description":"Fast"},
        {"value":"--bad","displayName":"Bad"}
      ]}}}"#;

    #[test]
    fn cc_models_keep_only_public_fields() {
        let m = parse_cc_models(MODELS_LINE).unwrap();
        assert!(!serde_json::to_string(&m).unwrap().contains("example"), "пошта не мусить вижити");
        assert_eq!(m.len(), 2, "модель з небезпечним value відкинуто");
        assert_eq!(m[0], json!({"value":"default","name":"Default (recommended)","description":"Model X · Best",
            "efforts":["low","medium","high","xhigh","max"]}));
        assert_eq!(m[1], json!({"value":"haiku","name":"Haiku","description":"Fast","efforts":[]}));
    }

    #[test]
    fn rate_limit_event_normalises_percent_and_millis() {
        let l = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","resetsAt":1790000000000,"utilization":42}}"#;
        let v: Value = serde_json::from_str(&parse_line(l, &mut StreamState::default())[0].1).unwrap();
        assert_eq!(v["resets_at"], 1790000000u64);
        assert_eq!(v["utilization"], 0.42);
        let l = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","utilization":1}}"#;
        assert_eq!(serde_json::from_str::<Value>(&parse_line(l, &mut StreamState::default())[0].1).unwrap()["utilization"], 1.0);
    }

    #[test]
    fn models_response_without_models_is_error_not_silence() {
        let l = r#"{"type":"control_response","response":{"subtype":"error","request_id":"models","error":"x"}}"#;
        assert_eq!(models_line(l), Some(Err("Claude Code не віддав список моделей".to_string())));
        assert!(parse_cc_models(l).is_none());
        assert!(models_line(r#"{"type":"system"}"#).is_none());
    }

    #[test]
    fn cc_models_other_lines_are_none() {
        assert!(parse_cc_models(r#"{"type":"system","subtype":"init"}"#).is_none());
        assert!(parse_cc_models(r#"{"type":"control_response","response":{"request_id":"other","response":{"models":[]}}}"#).is_none());
        assert!(parse_cc_models("не json").is_none());
        assert!(parse_cc_models(r#"{"type":"control_response","response":{"request_id":"models","response":{}}}"#).is_none());
    }

    #[test]
    fn cc_models_clip_long_strings() {
        let long = "ж".repeat(300);
        let l = json!({"type":"control_response","response":{"request_id":"models","response":{"models":[
            {"value":"m","displayName":long,"description":long}]}}}).to_string();
        let m = parse_cc_models(&l).unwrap();
        assert_eq!(m[0]["name"].as_str().unwrap().chars().count(), 120);
        assert_eq!(m[0]["description"].as_str().unwrap().chars().count(), 120);
    }

    #[test]
    fn rate_limit_event_becomes_limits() {
        let l = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"five_hour","resetsAt":1790000000,"utilization":0.42,"isUsingOverage":false}}"#;
        let ev = parse_line(l, &mut StreamState::default());
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].0, "limits");
        let v: Value = serde_json::from_str(&ev[0].1).unwrap();
        assert_eq!(v, json!({"type":"five_hour","status":"allowed_warning","utilization":0.42,"resets_at":1790000000}));
    }

    #[test]
    fn rate_limit_event_tolerates_missing_and_unknown() {
        let no_util = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"seven_day"}}"#;
        let v: Value = serde_json::from_str(&parse_line(no_util, &mut StreamState::default())[0].1).unwrap();
        assert_eq!(v, json!({"type":"seven_day","status":"allowed","utilization":null,"resets_at":null}));
        let rej = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1790000000,"utilization":170}}"#;
        let v: Value = serde_json::from_str(&parse_line(rej, &mut StreamState::default())[0].1).unwrap();
        assert_eq!(v["utilization"], 1.0);
        for bad in [r#"{"type":"rate_limit_event"}"#,
                    r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"weird"}}"#,
                    r#"{"type":"rate_limit_event","rate_limit_info":{"status":"?","rateLimitType":"five_hour"}}"#] {
            assert!(parse_line(bad, &mut StreamState::default()).is_empty(), "{bad}");
        }
    }

    #[test]
    fn result_emits_usage_with_numbers_only() {
        let l = r#"{"type":"result","is_error":false,"session_id":"abc","result":"x","total_cost_usd":0.0421,"num_turns":3,"duration_ms":900,
          "usage":{"input_tokens":120,"output_tokens":80,"cache_read_input_tokens":3000,"cache_creation_input_tokens":50,"service_tier":"standard"}}"#;
        let ev = parse_line(l, &mut StreamState::default());
        let u = ev.iter().find(|e| e.0 == "usage").expect("usage");
        let v: Value = serde_json::from_str(&u.1).unwrap();
        assert_eq!(v, json!({"input":120,"output":80,"cache_read":3000,"cache_write":50,"cost_usd":0.0421,"turns":3}));
        // result без usage і вартості не дає порожньої події.
        let plain = r#"{"type":"result","is_error":false,"session_id":"abc","result":"x"}"#;
        assert!(!parse_line(plain, &mut StreamState::default()).iter().any(|e| e.0 == "usage"));
    }
}
