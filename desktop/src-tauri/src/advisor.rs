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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

use crate::App;

const HIST_FILE: &str = "advisor_chats.json";
const MAX_PROMPT: usize = 200_000;
const STDERR_TAIL: usize = 2000;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Один процес за раз. Номер запуску потрібен, щоб потік-читач старого запуску
/// (після «Зупинити») не забрав дитину нового запуску зі слота.
#[derive(Default)]
pub struct Advisor {
    slot: Arc<Mutex<Option<(u64, Child)>>>,
    seq: AtomicU64,
}

#[derive(Deserialize)]
pub struct AskReq {
    pub conv: String,
    pub prompt: String,
    pub system: String,
    pub session: Option<String>,
    pub model: Option<String>,
}

fn no_window(c: &mut Command) {
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

fn find_in_path(path: &str, base: &str) -> Option<PathBuf> {
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

fn node_found() -> bool {
    find_in_path(&std::env::var("PATH").unwrap_or_default(), "node").is_some()
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

fn emit(app: &tauri::AppHandle, conv: &str, kind: &str, text: &str) {
    let _ = app.emit("advisor", json!({"conv": conv, "kind": kind, "text": text}));
}

fn safe_token(s: &str, extra: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

fn kill_tree(child: &mut Child) {
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
    *slot = Some((id, child));
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
        if let Some((_, mut child)) = mine {
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
    let taken = adv.slot.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some((_, mut child)) = taken { kill_tree(&mut child); }
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

    #[test]
    fn safe_tokens() {
        assert!(safe_token("0a-b_c", "-_"));
        assert!(!safe_token("--model", "-_"));
        assert!(!safe_token("a b", "-_"));
    }
}
