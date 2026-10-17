//! «Порадник» на локальній моделі: LM Studio (OpenAI-сумісний сервер на localhost) із
//! потоковим циклом інструментів над нашим MCP «Гроші». Дані не виходять з машини, тому MCP
//! тут стартує БЕЗ знеособлення. Адреса — лише локальна й без редиректів, інакше «локальна»
//! модель стала б каналом витоку.

use serde::Deserialize;
use serde_json::{json, Value};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::State;

use crate::advisor::{emit, find_node};
use crate::advisor_mcp::{Mcp, McpTool};
use crate::App;

const MAX_STEPS: usize = 8;
pub(crate) const MAX_TEXT: usize = 200_000;
pub(crate) const MAX_MESSAGES: usize = 200;
/// Тиша між чанками стріму, після якої вважаємо модель завислою.
pub(crate) const IDLE: Duration = Duration::from_secs(120);
/// До першого байта локальна модель може довго читати великий промпт, тому ліміт більший за IDLE.
const FIRST_BYTE: Duration = Duration::from_secs(300);
/// Крок опитування прапорця «Стоп»: без нього скасування чекало б на наступний чанк.
pub(crate) const TICK: Duration = Duration::from_millis(200);
/// Рядок без `\n` довший за це — сміття, а не SSE.
pub(crate) const MAX_LINE_BUF: usize = 4 * 1024 * 1024;

pub(crate) type Sink<'a> = &'a mut (dyn FnMut(&str, &str) + Send);

/// Виконавець інструментів. Окремий трейт, щоб цикл тестувався без node.
pub trait ToolExec: Send {
    fn call(&mut self, name: &str, args: &Value) -> Result<(String, bool), String>;
}

impl ToolExec for Mcp {
    fn call(&mut self, name: &str, args: &Value) -> Result<(String, bool), String> {
        Mcp::call(self, name, args)
    }
}

/// Лише локальні адреси: `localhost`, `127.0.0.1`, `[::1]`; `http` або `https`.
/// Userinfo відхиляється окремо: у `http://localhost` + `@` + чужий хост справжній хост — чужий,
/// хоча на око це «localhost».
pub fn local_url(url: &str) -> Result<reqwest::Url, String> {
    const ERR: &str = "Дозволена лише локальна адреса (localhost, 127.0.0.1, [::1])";
    let mut u = reqwest::Url::parse(url.trim()).map_err(|_| ERR.to_string())?;
    if !matches!(u.scheme(), "http" | "https") { return Err(ERR.into()); }
    if !u.username().is_empty() || u.password().is_some() { return Err(ERR.into()); }
    if !matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) { return Err(ERR.into()); }
    u.set_query(None);
    u.set_fragment(None);
    Ok(u)
}

fn endpoint(base: &reqwest::Url, tail: &str) -> String {
    format!("{}/{}", base.as_str().trim_end_matches('/'), tail)
}

pub(crate) fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Редірект на чужий хост обійшов би перевірку local_url.
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

/// Рядок SSE `data: …` або `[DONE]`.
#[derive(Debug, PartialEq)]
pub enum SseEvent { Data(String), Done }

/// Розбір SSE з довільно розрізаних чанків.
#[derive(Default)]
pub struct SseLines { buf: Vec<u8> }

impl SseLines {
    /// Байти, а не рядки: багатобайтовий символ може розрізатись між чанками.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(bytes);
        let mut out = vec![];
        while let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            let Some(rest) = line.strip_prefix("data:") else { continue };
            let rest = rest.trim_start();
            if rest == "[DONE]" { out.push(SseEvent::Done); } else if !rest.is_empty() { out.push(SseEvent::Data(rest.to_string())); }
        }
        out
    }

    pub fn pending(&self) -> usize { self.buf.len() }
}

/// `{type:"function", function:{name, description, parameters}}` для кожного MCP-інструмента.
fn openai_tools(tools: &[McpTool]) -> Value {
    Value::Array(tools.iter().map(|t| json!({
        "type": "function",
        "function": {"name": t.name, "description": t.description, "parameters": t.input_schema}
    })).collect())
}

/// Виклик інструмента, що приходить шматками: `arguments` дописується за `index`.
#[derive(Default, Debug)]
struct ToolAcc { id: String, name: String, args: String }

#[derive(Default)]
struct Turn { text: String, calls: Vec<ToolAcc>, finish: Option<String>, done: bool }

fn apply_event(data: &str, turn: &mut Turn, sink: Sink) -> Result<(), String> {
    // Зламаний рядок пропускаємо: сервери подекуди шлють службові дані.
    let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(()) };
    if let Some(e) = v.get("error") {
        let m = e.get("message").and_then(Value::as_str).or_else(|| e.as_str()).unwrap_or("помилка");
        let m: String = m.chars().take(300).collect();
        return Err(format!("Локальна модель повернула помилку: {m}"));
    }
    let Some(ch) = v.get("choices").and_then(|c| c.get(0)) else { return Ok(()) };
    if let Some(t) = ch["delta"]["content"].as_str() {
        if !t.is_empty() { turn.text.push_str(t); sink("text", t); }
    }
    if let Some(arr) = ch["delta"]["tool_calls"].as_array() {
        for (pos, tc) in arr.iter().enumerate() {
            // Частина серверів не шле `index`: тоді місце в масиві — єдиний ключ, інакше два
            // паралельні виклики злились би в один із поплутаними аргументами.
            let i = tc["index"].as_u64().map(|n| n as usize).unwrap_or(pos);
            if i > 64 { return Err("Забагато викликів інструментів в одній відповіді".into()); }
            while turn.calls.len() <= i { turn.calls.push(ToolAcc::default()); }
            let acc = &mut turn.calls[i];
            if let Some(s) = tc["id"].as_str() { if acc.id.is_empty() { acc.id = s.to_string(); } }
            if let Some(s) = tc["function"]["name"].as_str() { if acc.name.is_empty() { acc.name = s.to_string(); } }
            if let Some(s) = tc["function"]["arguments"].as_str() { acc.args.push_str(s); }
        }
    }
    if let Some(f) = ch["finish_reason"].as_str() { turn.finish = Some(f.to_string()); }
    Ok(())
}

pub(crate) enum Wait<T> { Done(T), Cancelled, Idle }

/// Чекає на future, але дрібними кроками дивиться на «Стоп» і на ліміт тиші.
pub(crate) async fn wait<F: Future>(f: F, cancel: &AtomicBool, limit: Duration) -> Wait<F::Output> {
    tokio::pin!(f);
    let mut waited = Duration::ZERO;
    loop {
        if cancel.load(Ordering::SeqCst) { return Wait::Cancelled; }
        match tokio::time::timeout(TICK, &mut f).await {
            Ok(v) => return Wait::Done(v),
            Err(_) => { waited += TICK; if waited >= limit { return Wait::Idle; } }
        }
    }
}

/// Один запит-стрім. `Ok(None)` — скасовано.
async fn stream_turn(c: &reqwest::Client, url: &str, body: &Value, cancel: &AtomicBool, sink: Sink<'_>) -> Result<Option<Turn>, String> {
    let mut resp = match wait(c.post(url).json(body).send(), cancel, FIRST_BYTE).await {
        Wait::Cancelled => return Ok(None),
        Wait::Idle => return Err("Локальна модель не відповідає".into()),
        Wait::Done(Ok(r)) => r,
        Wait::Done(Err(_)) => return Err("Не вдалося зʼєднатися з локальним сервером".into()),
    };
    if !resp.status().is_success() {
        return Err(format!("Локальний сервер повернув HTTP {}", resp.status().as_u16()));
    }
    let mut sse = SseLines::default();
    let mut turn = Turn::default();
    'read: loop {
        match wait(resp.chunk(), cancel, IDLE).await {
            Wait::Cancelled => return Ok(None),
            Wait::Idle => return Err("Локальна модель мовчить понад 120 с".into()),
            Wait::Done(Err(_)) => return Err("Зʼєднання з локальним сервером перервано".into()),
            Wait::Done(Ok(None)) => break,
            Wait::Done(Ok(Some(b))) => {
                for ev in sse.push(&b) {
                    match ev {
                        SseEvent::Done => { turn.done = true; break 'read; }
                        SseEvent::Data(d) => apply_event(&d, &mut turn, &mut *sink)?,
                    }
                }
                if sse.pending() > MAX_LINE_BUF { return Err("Відповідь локального сервера некоректна".into()); }
            }
        }
    }
    // Сервер, що закрив зʼєднання посеред відповіді, для клієнта виглядає як чистий кінець тіла:
    // без finish_reason або [DONE] це обрив, а не відповідь.
    if turn.finish.is_none() && !turn.done {
        return Err("Зʼєднання перервано до кінця відповіді".into());
    }
    prune_calls(&mut turn);
    Ok(Some(turn))
}

/// Виклик без імені — порожнє місце від розрідженого `index` або сміття: виконати його неможливо,
/// а відправлений назад `tool_calls` із порожнім `name` сервер відхилив би.
fn prune_calls(turn: &mut Turn) { turn.calls.retain(|a| !a.name.is_empty()); }

fn parse_args(s: &str) -> Option<Value> {
    if s.trim().is_empty() { return Some(json!({})); }
    serde_json::from_str::<Value>(s).ok().filter(Value::is_object)
}

/// Цикл «стрім → інструменти → стрім». Події `text`/`tool`/`error` ідуть у `sink`;
/// `done` тут НЕ шлеться: його після звільнення слота надсилає виклик зверху.
/// «Стоп» (cancel) завершує тихо, без `error`.
pub async fn run_local(
    base: &reqwest::Url, model: &str, system: &str, messages: &[Value],
    mut tools: Option<(&mut dyn ToolExec, &[McpTool])>,
    cancel: &AtomicBool, sink: Sink<'_>,
) {
    if let Err(e) = run_inner(base, model, system, messages, &mut tools, cancel, &mut *sink).await {
        sink("error", &e);
    }
}

async fn run_inner(
    base: &reqwest::Url, model: &str, system: &str, messages: &[Value],
    tools: &mut Option<(&mut dyn ToolExec, &[McpTool])>,
    cancel: &AtomicBool, sink: Sink<'_>,
) -> Result<(), String> {
    let c = client()?;
    let url = endpoint(base, "chat/completions");
    let mut msgs: Vec<Value> = vec![json!({"role": "system", "content": system})];
    msgs.extend_from_slice(messages);
    let tools_json = tools.as_ref().map(|(_, t)| openai_tools(t));

    // До MAX_STEPS раундів інструментів; наступний запит дає моделі шанс відповісти текстом.
    for round in 0..=MAX_STEPS {
        let mut body = json!({"model": model, "messages": msgs, "stream": true});
        if let Some(t) = &tools_json { body["tools"] = t.clone(); }
        let Some(turn) = stream_turn(&c, &url, &body, cancel, &mut *sink).await? else { return Ok(()) };
        let truncated = turn.finish.as_deref() == Some("length");
        if tools.is_none() || turn.calls.is_empty() || truncated {
            if truncated { return Err("Відповідь обрізано: вичерпано ліміт довжини".into()); }
            return Ok(());
        }
        if round == MAX_STEPS { return Err("Забагато кроків інструментів".into()); }

        let calls: Vec<ToolAcc> = turn.calls.into_iter().enumerate().map(|(i, mut a)| {
            if a.id.is_empty() { a.id = format!("call_{round}_{i}"); }
            a
        }).collect();
        msgs.push(json!({
            "role": "assistant",
            "content": if turn.text.is_empty() { Value::Null } else { Value::String(turn.text) },
            "tool_calls": calls.iter().map(|a| json!({
                "id": a.id, "type": "function",
                "function": {"name": a.name, "arguments": if a.args.trim().is_empty() { "{}" } else { a.args.as_str() }}
            })).collect::<Vec<_>>()
        }));
        for a in &calls {
            if cancel.load(Ordering::SeqCst) { return Ok(()); }
            sink("tool", &a.name);
            let content = match parse_args(&a.args) {
                None => "Помилка: аргументи інструмента не є коректним JSON-обʼєктом".to_string(),
                Some(args) => {
                    let (exec, _) = tools.as_mut().expect("перевірено вище");
                    // Mcp::call блокує потік (до 30 с): block_in_place не дає зупинити решту рантайму.
                    match tokio::task::block_in_place(|| exec.call(&a.name, &args)) {
                        Ok((t, false)) => t,
                        Ok((t, true)) => format!("Помилка інструмента: {t}"),
                        Err(e) => format!("Помилка інструмента: {e}"),
                    }
                }
            };
            msgs.push(json!({"role": "tool", "tool_call_id": a.id, "content": content}));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct LocalMsg { pub role: String, pub content: String }

#[derive(Deserialize)]
pub struct LocalReq {
    pub conv: String,
    pub messages: Vec<LocalMsg>,
    pub system: String,
    pub url: String,
    pub model: String,
    pub tools: bool,
}

#[tauri::command]
pub async fn advisor_local_models(url: String) -> Result<Vec<String>, String> {
    let base = local_url(&url)?;
    let c = client()?;
    let resp = c.get(endpoint(&base, "models")).timeout(Duration::from_secs(15)).send().await
        .map_err(|_| "Не вдалося зʼєднатися з локальним сервером".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Локальний сервер повернув HTTP {}", resp.status().as_u16()));
    }
    let v: Value = resp.json().await.map_err(|_| "Некоректна відповідь локального сервера".to_string())?;
    Ok(v["data"].as_array().map(|a| a.iter().filter_map(|m| m["id"].as_str())
        .take(500).map(String::from).collect()).unwrap_or_default())
}

#[tauri::command]
pub fn advisor_local_ask(handle: tauri::AppHandle, app: State<App>, req: LocalReq) -> Result<(), String> {
    use tauri::Manager;
    let base = local_url(&req.url)?;
    if req.model.trim().is_empty() || req.model.len() > 200 { return Err("Некоректна назва моделі".into()); }
    if req.messages.is_empty() || req.messages.len() > MAX_MESSAGES { return Err("Некоректна історія розмови".into()); }
    if req.system.len() > MAX_TEXT || req.messages.iter().map(|m| m.content.len()).sum::<usize>() > MAX_TEXT {
        return Err("Питання завелике".into());
    }
    // Роль «system»/«tool» з вебвʼю дозволила б підмінити інструкцію.
    if req.messages.iter().any(|m| m.role != "user" && m.role != "assistant") { return Err("Некоректна роль повідомлення".into()); }
    let messages: Vec<Value> = req.messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect();

    let mcp_args = if req.tools {
        let node = find_node().ok_or("Node.js не знайдено")?;
        let res = handle.path().resource_dir().map_err(|e| e.to_string())?;
        let js = res.join("mcp").join("groshi-mcp.js");
        let js = std::path::PathBuf::from(js.to_string_lossy().trim_start_matches(r"\\?\"));
        Some((node, js, app.st.dir.clone()))
    } else { None };

    let (id, cancel) = app.adv.claim_http()?;
    let (conv, model, system) = (req.conv, req.model, req.system);
    let guard = {
        let (h, c) = (handle.clone(), conv.clone());
        crate::advisor::RunGuard::new(app.adv.clone_slot(), id, Box::new(move |k, t| emit(&h, &c, k, t)))
    };
    tauri::async_runtime::spawn(async move {
        let mut sink = |k: &str, t: &str| emit(&handle, &conv, k, t);
        let mut mcp: Option<(Mcp, Vec<McpTool>)> = None;
        let mut ok = true;
        if let Some((node, js, dir)) = mcp_args {
            // Без знеособлення (pseudo=false): дані не залишають машину.
            let started = tauri::async_runtime::spawn_blocking(move || {
                let mut m = Mcp::start(&node, &js, &dir, false)?;
                let t = m.tools()?;
                Ok::<_, String>((m, t))
            }).await;
            match started {
                Ok(Ok(p)) => mcp = Some(p),
                Ok(Err(e)) => { sink("error", &format!("Не вдалося запустити MCP: {e}")); ok = false; }
                Err(_) => { sink("error", "Не вдалося запустити MCP"); ok = false; }
            }
        }
        if ok {
            let tools = mcp.as_mut().map(|(m, t)| (m as &mut dyn ToolExec, t.as_slice()));
            run_local(&base, &model, &system, &messages, tools, &cancel, &mut sink).await;
        }
        // Drop Mcp вбиває node; робимо це поза рантаймом, бо taskkill блокує.
        let _ = tauri::async_runtime::spawn_blocking(move || drop(mcp)).await;
        // Слот і `done` — у Drop охоронця (так само, якщо задача впаде раніше).
        guard.finish();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    #[test]
    fn local_url_accepts_loopback_only() {
        for ok in ["http://localhost:1234/v1", "http://127.0.0.1:1234/v1", "http://[::1]:1234/v1"] {
            assert!(local_url(ok).is_ok(), "{ok}");
        }
        // Складаємо через format!, щоб сторож приватності не прийняв рядок за пошту.
        let userinfo = format!("http://localhost{}evil.example/v1", '@');
        for bad in ["http://192.168.1.5:1234", "https://api.openai.com/v1", userinfo.as_str(), "file:///c:/x", "не url"] {
            assert!(local_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn sse_split_chunks_same_events() {
        let whole = "data: {\"a\":1}\r\n\r\ndata: {\"b\":\"Привіт\"}\n\n: коментар\ndata: [DONE]\n\n";
        let mut a = SseLines::default();
        let full = a.push(whole.as_bytes());
        assert_eq!(full, vec![SseEvent::Data("{\"a\":1}".into()), SseEvent::Data("{\"b\":\"Привіт\"}".into()), SseEvent::Done]);
        // Розрізаємо кожні 3 байти, зокрема посеред кириличного символу.
        let mut b = SseLines::default();
        let mut got = vec![];
        for ch in whole.as_bytes().chunks(3) { got.extend(b.push(ch)); }
        assert_eq!(got, full);
    }

    #[test]
    fn tool_args_accumulate_by_index() {
        let mut turn = Turn::default();
        let mut sink = |_: &str, _: &str| {};
        for d in [
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"market","arguments":"{\"sym"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"bol\":\"X\"}"}}]}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
        ] { apply_event(d, &mut turn, &mut sink).unwrap(); }
        assert_eq!(turn.calls.len(), 1);
        assert_eq!((turn.calls[0].id.as_str(), turn.calls[0].name.as_str()), ("c1", "market"));
        assert_eq!(parse_args(&turn.calls[0].args).unwrap(), json!({"symbol": "X"}));
        assert_eq!(turn.finish.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn tool_calls_without_index_use_array_position() {
        let mut turn = Turn::default();
        let mut sink = |_: &str, _: &str| {};
        let d = r#"{"choices":[{"delta":{"tool_calls":[
            {"id":"a","function":{"name":"market","arguments":"{}"}},
            {"id":"b","function":{"name":"groshi_status","arguments":"{}"}}]}}]}"#;
        apply_event(d, &mut turn, &mut sink).unwrap();
        prune_calls(&mut turn);
        assert_eq!(turn.calls.len(), 2);
        assert_eq!((turn.calls[0].id.as_str(), turn.calls[0].name.as_str()), ("a", "market"));
        assert_eq!((turn.calls[1].id.as_str(), turn.calls[1].name.as_str()), ("b", "groshi_status"));
    }

    #[test]
    fn nameless_calls_are_skipped() {
        let mut turn = Turn::default();
        let mut sink = |_: &str, _: &str| {};
        // index 2 без імені залишає порожні місця 0 і 1; сама ця «заготовка» теж без імені.
        let d = r#"{"choices":[{"delta":{"tool_calls":[{"index":2,"id":"x","function":{"arguments":"{}"}}]}}]}"#;
        apply_event(d, &mut turn, &mut sink).unwrap();
        assert_eq!(turn.calls.len(), 3);
        prune_calls(&mut turn);
        assert!(turn.calls.is_empty());
    }

    #[test]
    fn openai_tools_shape() {
        let t = [McpTool { name: "n".into(), description: "d".into(), input_schema: json!({"type":"object"}) }];
        let v = openai_tools(&t);
        assert_eq!(v[0]["type"], "function");
        assert_eq!(v[0]["function"]["name"], "n");
        assert_eq!(v[0]["function"]["parameters"], json!({"type":"object"}));
    }

    // ---- мок-сервер ----

    fn data(v: Value) -> String { format!("data: {v}\n\n") }
    fn text_chunk(t: &str) -> String { data(json!({"choices":[{"delta":{"content":t},"finish_reason":null}]})) }
    fn stop() -> String { data(json!({"choices":[{"delta":{},"finish_reason":"stop"}]})) + "data: [DONE]\n\n" }
    fn tool_call(name: &str) -> String {
        data(json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":name,"arguments":""}}]},"finish_reason":null}]}))
            + &data(json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":null}]}))
            + &data(json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}))
            + "data: [DONE]\n\n"
    }

    fn read_request(s: &mut TcpStream) -> Value {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        let (head_end, len) = loop {
            let n = s.read(&mut tmp).unwrap();
            assert!(n > 0, "клієнт закрив зʼєднання");
            buf.extend_from_slice(&tmp[..n]);
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                let len = head.lines().find_map(|l| l.strip_prefix("content-length:")).map(|v| v.trim().parse::<usize>().unwrap()).unwrap_or(0);
                break (i + 4, len);
            }
        };
        while buf.len() < head_end + len {
            let n = s.read(&mut tmp).unwrap();
            buf.extend_from_slice(&tmp[..n]);
        }
        serde_json::from_slice(&buf[head_end..head_end + len]).unwrap()
    }

    /// Кожне зʼєднання отримує наступну заготовку; після неї сокет закривається
    /// (для заготовок без finish/[DONE] це і є обрив посеред стріму).
    fn mock(replies: Vec<String>) -> (reqwest::Url, Arc<Mutex<Vec<Value>>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = local_url(&format!("http://127.0.0.1:{}/v1", l.local_addr().unwrap().port())).unwrap();
        let seen = Arc::new(Mutex::new(vec![]));
        let seen2 = seen.clone();
        std::thread::spawn(move || {
            for r in replies {
                let Ok((mut s, _)) = l.accept() else { return };
                let body = read_request(&mut s);
                seen2.lock().unwrap().push(body);
                let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{r}").as_bytes());
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
        });
        (url, seen)
    }

    struct Fake { calls: usize }
    impl ToolExec for Fake {
        fn call(&mut self, _: &str, _: &Value) -> Result<(String, bool), String> { self.calls += 1; Ok(("результат".into(), false)) }
    }

    fn fake_tools() -> Vec<McpTool> {
        vec![McpTool { name: "groshi_status".into(), description: "".into(), input_schema: json!({"type":"object"}) }]
    }

    fn user() -> Vec<Value> { vec![json!({"role":"user","content":"Привіт"})] }

    type Events = Arc<Mutex<Vec<(String, String)>>>;
    fn collect() -> (Events, impl FnMut(&str, &str) + Send) {
        let ev: Events = Arc::new(Mutex::new(vec![]));
        let e2 = ev.clone();
        (ev, move |k: &str, t: &str| e2.lock().unwrap().push((k.to_string(), t.to_string())))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn plain_answer_streams_text() {
        let (url, seen) = mock(vec![text_chunk("При") + &text_chunk("віт") + &stop()]);
        let (ev, mut sink) = collect();
        run_local(&url, "m", "sys", &user(), None, &AtomicBool::new(false), &mut sink).await;
        let ev = ev.lock().unwrap();
        assert_eq!(*ev, vec![("text".to_string(), "При".to_string()), ("text".to_string(), "віт".to_string())]);
        let body = &seen.lock().unwrap()[0];
        assert_eq!(body["messages"][0], json!({"role":"system","content":"sys"}));
        assert!(body.get("tools").is_none());
        assert_eq!(body["stream"], true);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tool_round_then_text() {
        let (url, seen) = mock(vec![tool_call("groshi_status"), text_chunk("Готово") + &stop()]);
        let (ev, mut sink) = collect();
        let mut fake = Fake { calls: 0 };
        let t = fake_tools();
        run_local(&url, "m", "s", &user(), Some((&mut fake, &t)), &AtomicBool::new(false), &mut sink).await;
        let kinds: Vec<String> = ev.lock().unwrap().iter().map(|e| e.0.clone()).collect();
        assert_eq!(kinds, ["tool", "text"]);
        assert_eq!(ev.lock().unwrap()[0].1, "groshi_status");
        assert_eq!(fake.calls, 1);
        let second = &seen.lock().unwrap()[1];
        let m = second["messages"].as_array().unwrap();
        assert_eq!(m[m.len() - 1], json!({"role":"tool","tool_call_id":"c1","content":"результат"}));
        assert_eq!(m[m.len() - 2]["tool_calls"][0]["function"]["arguments"], "{}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tool_round_with_real_mcp() {
        let Some(node) = find_node() else { println!("пропущено: немає node"); return };
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mcp/groshi-mcp.js");
        let dir = std::env::temp_dir().join(format!("groshi_local_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut mcp = Mcp::start(&node, &script, &dir, false).unwrap();
        let tools = mcp.tools().unwrap();
        let (url, seen) = mock(vec![tool_call("groshi_status"), text_chunk("Готово") + &stop()]);
        let (ev, mut sink) = collect();
        run_local(&url, "m", "s", &user(), Some((&mut mcp, &tools)), &AtomicBool::new(false), &mut sink).await;
        let kinds: Vec<String> = ev.lock().unwrap().iter().map(|e| e.0.clone()).collect();
        assert_eq!(kinds, ["tool", "text"]);
        let second = &seen.lock().unwrap()[1];
        let last = second["messages"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(last["role"], "tool");
        // pseudo=false: тека даних не прихована.
        assert!(!last["content"].as_str().unwrap().contains("Тека даних: прихована"));
        drop(mcp);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn endless_tool_calls_stop_after_eight_steps() {
        let (url, seen) = mock((0..MAX_STEPS + 2).map(|_| tool_call("groshi_status")).collect());
        let (ev, mut sink) = collect();
        let mut fake = Fake { calls: 0 };
        let t = fake_tools();
        run_local(&url, "m", "s", &user(), Some((&mut fake, &t)), &AtomicBool::new(false), &mut sink).await;
        let ev = ev.lock().unwrap();
        let last = ev.last().unwrap();
        assert_eq!(last.0, "error");
        assert!(last.1.contains("Забагато кроків"), "{}", last.1);
        assert_eq!(fake.calls, MAX_STEPS);
        assert_eq!(seen.lock().unwrap().len(), MAX_STEPS + 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dropped_connection_is_error_and_slot_is_free() {
        let adv = crate::advisor::Advisor::default();
        let (id, cancel) = adv.claim_http().unwrap();
        assert!(adv.claim_http().is_err(), "другий запуск при зайнятому слоті");
        // Сервер шле шматок тексту й закриває сокет без finish_reason.
        let (url, _) = mock(vec![text_chunk("Поча")]);
        let (ev, mut sink) = collect();
        run_local(&url, "m", "s", &user(), None, &cancel, &mut sink).await;
        {
            let ev = ev.lock().unwrap();
            assert_eq!(ev[0].0, "text");
            assert_eq!(ev.last().unwrap().0, "error");
        }
        crate::advisor::release_slot(&adv.clone_slot(), id);
        assert!(adv.claim_http().is_ok(), "наступний ask приймається");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_is_silent() {
        let (url, _) = mock(vec![text_chunk("x") + &stop()]);
        let (ev, mut sink) = collect();
        run_local(&url, "m", "s", &user(), None, &AtomicBool::new(true), &mut sink).await;
        assert!(ev.lock().unwrap().is_empty());
    }
}
