//! «Порадник» через Anthropic Messages API (сирий HTTP: офіційного Rust SDK немає). Ключ лежить
//! лише в Диспетчері облікових даних і потрапляє тільки в заголовок `x-api-key`: ні в помилки,
//! ні в події, ні в `Debug` (структури з ключем не існує — він передається як `&str`).
//! MCP тут стартує зі знеособленням: у хмару йдуть лише псевдоніми.
//!
//! Історія лише дописується: цикл повертає вебвʼю подією `state` повні асистентські `content`
//! (з `thinking`, `server_tool_use`, `web_search_tool_result`, `fallback`) і `tool_result`-повідомлення —
//! вебвʼю надсилає їх назад без змін.

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::State;

use crate::advisor::{emit, find_node, RunGuard};
use crate::advisor_local::{client, wait, Sink, SseEvent, SseLines, ToolExec, Wait, IDLE, MAX_LINE_BUF, MAX_MESSAGES, MAX_TEXT};
use crate::advisor_mcp::{Mcp, McpTool};
use crate::App;

pub const API_BASE: &str = "https://api.anthropic.com";
const DEFAULT_MODEL: &str = "claude-opus-5-5";
const MAX_STEPS: usize = 8;
const MAX_TOKENS: u64 = 32_000;
const MAX_KEY_LEN: usize = 400;
/// Історія росте разом із `thinking` і результатами пошуку, тому ліміт на неї окремий і більший за MAX_TEXT.
const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;
const KEY_USER: &str = "anthropic-key";
const VERSION: &str = "2023-06-01";
const BETA: &str = "server-side-fallback-2026-07-01";

// ───────────────────────────── тіло запиту

/// Тіло `POST /v1/messages`. Свідомо БЕЗ `thinking`, `budget_tokens`, `temperature`, `tool_choice`:
/// глибиною керує `output_config.effort`, а примусовий вибір інструмента вимикає міркування.
pub fn api_body(model: &str, system: &str, messages: &[Value], tools: &[McpTool]) -> Value {
    let mut t: Vec<Value> = tools.iter()
        .map(|x| json!({"name": x.name, "description": x.description, "input_schema": x.input_schema}))
        .collect();
    t.push(json!({"type": "web_search_20260209", "name": "web_search", "max_uses": 5}));
    json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "stream": true,
        "system": system,
        "messages": messages,
        "tools": t,
        "output_config": {"effort": "medium"},
        "fallbacks": "default",
        // Автоматичне кешування префікса: кожен раунд інструментів перенадсилає Opus усю історію,
        // без кешу її вартість росте квадратично.
        "cache_control": {"type": "ephemeral"},
    })
}

// ───────────────────────────── розбір SSE Messages API

struct Block { v: Value, json: String }

/// Збирає повний `content` асистента зі стріму. Блок зберігається так, як прийшов у
/// `content_block_start`, і лише доповнюється дельтами: невідомі типи блоків і дельт не губляться,
/// тож відправлений назад ход збігається з отриманим.
#[derive(Default)]
pub struct MsgStream {
    blocks: Vec<(u64, Block)>,
    stop_reason: Option<String>,
    complete: bool,
    text_emitted: bool,
}

impl MsgStream {
    fn block(&mut self, index: u64) -> Option<&mut Block> {
        self.blocks.iter_mut().rev().find(|(i, _)| *i == index).map(|(_, b)| b)
    }

    /// Один `data:`-рядок. Зламаний JSON і невідомі події пропускаються (протокол росте).
    pub fn feed(&mut self, data: &str, sink: Sink) -> Result<(), String> {
        let Ok(ev) = serde_json::from_str::<Value>(data) else { return Ok(()) };
        let index = ev["index"].as_u64().unwrap_or(0);
        match ev["type"].as_str() {
            Some("content_block_start") => {
                let b = ev["content_block"].clone();
                if !b.is_object() { return Ok(()); }
                // Без розділювача текст до й після пошуку чи інструмента зліплюється в одне слово.
                if b["type"] == "text" && self.text_emitted { sink("text", "\n\n"); }
                self.blocks.push((index, Block { v: b, json: String::new() }));
            }
            Some("content_block_delta") => {
                let d = &ev["delta"];
                let mut emit_text = None;
                if let Some(b) = self.block(index) {
                    match d["type"].as_str() {
                        Some("text_delta") => {
                            let t = d["text"].as_str().unwrap_or("");
                            let cur = b.v["text"].as_str().unwrap_or("").to_string();
                            b.v["text"] = Value::String(cur + t);
                            if !t.is_empty() { emit_text = Some(t.to_string()); }
                        }
                        Some("input_json_delta") => {
                            b.json.push_str(d["partial_json"].as_str().unwrap_or(""));
                            if b.json.len() > MAX_TEXT { return Err("Аргументи інструмента завеликі".into()); }
                        }
                        Some("thinking_delta") => {
                            let cur = b.v["thinking"].as_str().unwrap_or("").to_string();
                            b.v["thinking"] = Value::String(cur + d["thinking"].as_str().unwrap_or(""));
                        }
                        Some("signature_delta") => {
                            let cur = b.v["signature"].as_str().unwrap_or("").to_string();
                            b.v["signature"] = Value::String(cur + d["signature"].as_str().unwrap_or(""));
                        }
                        // Цитати з веб-пошуку належать текстовому блоку й мають повернутись назад.
                        Some("citations_delta") => {
                            if !b.v["citations"].is_array() { b.v["citations"] = json!([]); }
                            if let Some(a) = b.v["citations"].as_array_mut() { a.push(d["citation"].clone()); }
                        }
                        _ => {}
                    }
                }
                if let Some(t) = emit_text { self.text_emitted = true; sink("text", &t); }
            }
            Some("content_block_stop") => {
                let mut search = None;
                if let Some(b) = self.block(index) {
                    if !b.json.is_empty() {
                        match serde_json::from_str::<Value>(&b.json) {
                            Ok(v) if v.is_object() => b.v["input"] = v,
                            _ => return Err("Некоректні аргументи інструмента у відповіді".into()),
                        }
                    }
                    if b.v["type"] == "server_tool_use" && b.v["name"] == "web_search" {
                        search = Some(b.v["input"]["query"].as_str().unwrap_or("").to_string());
                    }
                }
                if let Some(q) = search { sink("tool", &format!("WebSearch: {q}")); }
            }
            Some("message_delta") => {
                if let Some(r) = ev["delta"]["stop_reason"].as_str() { self.stop_reason = Some(r.to_string()); }
            }
            Some("message_stop") => self.complete = true,
            Some("error") => {
                // Сирий текст помилки не пересилаємо; тип — з короткого переліку, решта — загальна.
                let kind = ev["error"]["type"].as_str().unwrap_or("");
                return Err(match kind {
                    "overloaded_error" => "Сервіс Anthropic перевантажений, спробуйте пізніше".to_string(),
                    "rate_limit_error" => "Ліміт запитів, спробуйте пізніше".to_string(),
                    "authentication_error" | "permission_error" => "Ключ API не підійшов".to_string(),
                    _ => "Сервіс Anthropic повернув помилку".to_string(),
                });
            }
            _ => {}
        }
        Ok(())
    }

    /// Повний `content`. Порожні текстові блоки відкидаються: API відхиляє їх у вхідній історії.
    pub fn content(&self) -> Vec<Value> {
        self.blocks.iter().map(|(_, b)| b.v.clone())
            .filter(|v| !(v["type"] == "text" && v["text"].as_str().unwrap_or("").is_empty()))
            .collect()
    }

    pub fn stop_reason(&self) -> Option<&str> { self.stop_reason.as_deref() }
    pub fn is_complete(&self) -> bool { self.complete }
}

// ───────────────────────────── HTTP

/// Текст помилки за кодом. Тіло відповіді не показуємо: воно може відлунювати частину запиту.
fn http_error(code: u16) -> String {
    match code {
        401 | 403 => "Ключ API не підійшов".into(),
        429 => "Ліміт запитів, спробуйте пізніше".into(),
        500..=599 => "Сервіс Anthropic недоступний".into(),
        // Історія лише дописується, тож завелика чи зіпсована розмова не виправиться повтором.
        c @ (400 | 413) => format!("Anthropic відхилив запит (HTTP {c}) — почніть нову розмову"),
        c => format!("Anthropic повернув HTTP {c}"),
    }
}

fn key_header(key: &str) -> Result<reqwest::header::HeaderValue, String> {
    let mut v = reqwest::header::HeaderValue::from_str(key).map_err(|_| "Ключ API містить недопустимі символи".to_string())?;
    // Чутливе значення не друкується навіть у Debug запиту.
    v.set_sensitive(true);
    Ok(v)
}

fn url(base: &str, tail: &str) -> String { format!("{}/{}", base.trim_end_matches('/'), tail) }

/// Один запит-стрім. `Ok(None)` — скасовано.
async fn stream_turn(c: &reqwest::Client, base: &str, key: &str, body: &Value, text_emitted: bool, cancel: &AtomicBool, sink: Sink<'_>) -> Result<Option<MsgStream>, String> {
    let req = c.post(url(base, "v1/messages"))
        .header("x-api-key", key_header(key)?)
        .header("anthropic-version", VERSION)
        .header("anthropic-beta", BETA)
        .json(body);
    let mut resp = match wait(req.send(), cancel, IDLE).await {
        Wait::Cancelled => return Ok(None),
        Wait::Idle => return Err("Anthropic не відповідає".into()),
        Wait::Done(Ok(r)) => r,
        Wait::Done(Err(_)) => return Err("Не вдалося зʼєднатися з Anthropic".into()),
    };
    if !resp.status().is_success() { return Err(http_error(resp.status().as_u16())); }
    let mut sse = SseLines::default();
    let mut ms = MsgStream { text_emitted, ..Default::default() };
    'read: loop {
        match wait(resp.chunk(), cancel, IDLE).await {
            Wait::Cancelled => return Ok(None),
            Wait::Idle => return Err("Anthropic мовчить понад 120 с".into()),
            Wait::Done(Err(_)) => return Err("Зʼєднання з Anthropic перервано".into()),
            Wait::Done(Ok(None)) => break,
            Wait::Done(Ok(Some(b))) => {
                for ev in sse.push(&b) {
                    if let SseEvent::Data(d) = ev { ms.feed(&d, &mut *sink)?; }
                    if ms.is_complete() { break 'read; }
                }
                if sse.pending() > MAX_LINE_BUF { return Err("Відповідь Anthropic некоректна".into()); }
            }
        }
    }
    // Закрите посеред відповіді зʼєднання для клієнта — чистий кінець тіла; лише `message_stop` робить відповідь повною.
    if !ms.is_complete() { return Err("Зʼєднання перервано до кінця відповіді".into()); }
    Ok(Some(ms))
}

/// `server_tool_use` без `web_search_tool_result` з тим самим `tool_use_id`.
fn has_unanswered_server_tool(content: &[Value]) -> bool {
    content.iter().filter(|b| b["type"] == "server_tool_use").any(|b| {
        !content.iter().any(|r| r["type"] == "web_search_tool_result" && r["tool_use_id"] == b["id"])
    })
}

/// Цикл «стрім → інструменти → стрім». Події `text`/`tool`/`state`/`error` ідуть у `sink`;
/// `done` тут НЕ шлеться: його після звільнення слота надсилає охоронець. «Стоп» — тихо, без `state`.
pub async fn run_api(
    base_url: &str, key: &str, model: &str, system: &str, messages: &[Value],
    exec: &mut dyn ToolExec, tools: &[McpTool], cancel: &AtomicBool, sink: Sink<'_>,
) {
    if let Err(e) = run_inner(base_url, key, model, system, messages, exec, tools, cancel, &mut *sink).await {
        sink("error", &e);
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_inner(
    base: &str, key: &str, model: &str, system: &str, messages: &[Value],
    exec: &mut dyn ToolExec, tools: &[McpTool], cancel: &AtomicBool, sink: Sink<'_>,
) -> Result<(), String> {
    let c = client()?;
    let mut msgs: Vec<Value> = messages.to_vec();
    // Лише нове за цей запуск: старі ходи вебвʼю вже має й не редагує.
    let mut added: Vec<Value> = vec![];
    // Прапорець «текст уже був» живе між раундами: інакше текст після виклику інструмента
    // зліпиться з попереднім без розділювача.
    let mut text_emitted = false;

    // До MAX_STEPS раундів продовження; наступний запит дає моделі шанс відповісти.
    for round in 0..=MAX_STEPS {
        let body = api_body(model, system, &msgs, tools);
        let Some(ms) = stream_turn(&c, base, key, &body, text_emitted, cancel, &mut *sink).await? else { return Ok(()) };
        text_emitted = ms.text_emitted;
        let reason = ms.stop_reason().unwrap_or("").to_string();
        if reason == "refusal" { return Err("Модель відмовилась відповідати".into()); }
        let content = ms.content();
        if content.is_empty() { return Err("Модель повернула порожню відповідь".into()); }
        let has_client_tool = content.iter().any(|b| b["type"] == "tool_use");
        let assistant = json!({"role": "assistant", "content": content});

        match reason.as_str() {
            "end_turn" | "stop_sequence" | "max_tokens" => {
                // Обрізаний на виклику інструмента хід без tool_result зламав би всю подальшу історію.
                if has_client_tool { return Err("Відповідь обрізано: вичерпано ліміт довжини".into()); }
                // Серверний пошук без результату: у append-only історії такий хід назавжди давав би 400.
                if has_unanswered_server_tool(&content) { return Err("Відповідь обірвалась на пошуку — спробуйте ще раз".into()); }
                added.push(assistant);
                sink("state", &Value::Array(added).to_string());
                return Ok(());
            }
            "tool_use" | "pause_turn" => {
                if round == MAX_STEPS { return Err("Забагато кроків інструментів".into()); }
                msgs.push(assistant.clone());
                added.push(assistant);
                if reason == "pause_turn" { continue; }
                let mut results: Vec<Value> = vec![];
                // `server_tool_use` виконує сервер: tool_result на нього не надсилається.
                let calls: Vec<Value> = msgs.last().and_then(|m| m["content"].as_array()).map(|a| {
                    a.iter().filter(|b| b["type"] == "tool_use").cloned().collect()
                }).unwrap_or_default();
                if calls.is_empty() { return Err("Некоректна відповідь: немає викликів інструментів".into()); }
                for b in &calls {
                    if cancel.load(Ordering::SeqCst) { return Ok(()); }
                    let name = b["name"].as_str().unwrap_or("");
                    sink("tool", name);
                    let args = if b["input"].is_object() { b["input"].clone() } else { json!({}) };
                    // Mcp::call блокує потік (до 30 с): block_in_place не дає зупинити решту рантайму.
                    let (text, is_err) = match tokio::task::block_in_place(|| exec.call(name, &args)) {
                        Ok((t, false)) => (t, false),
                        Ok((t, true)) => (format!("Помилка інструмента: {t}"), true),
                        Err(e) => (format!("Помилка інструмента: {e}"), true),
                    };
                    let mut r = json!({"type": "tool_result", "tool_use_id": b["id"], "content": text});
                    if is_err { r["is_error"] = Value::Bool(true); }
                    results.push(r);
                }
                let user = json!({"role": "user", "content": results});
                msgs.push(user.clone());
                added.push(user);
            }
            other => {
                let r: String = other.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(40).collect();
                return Err(format!("Відповідь завершилась нештатно ({r})"));
            }
        }
    }
    Ok(())
}

// ───────────────────────────── ключ

/// Перевірка ключа до збереження: `GET /v1/models?limit=1`. Ключ відсікається за довжиною/символами
/// ще до мережі. Помилки — фіксовані рядки, без тіла відповіді й без ключа.
async fn check_key(base: &str, key: &str) -> Result<(), String> {
    if key.is_empty() { return Err("Порожній ключ".into()); }
    if key.len() > MAX_KEY_LEN { return Err("Ключ задовгий".into()); }
    let hv = key_header(key)?;
    let c = client()?;
    let resp = c.get(url(base, "v1/models?limit=1"))
        .header("x-api-key", hv).header("anthropic-version", VERSION)
        .timeout(std::time::Duration::from_secs(15))
        .send().await.map_err(|_| "Не вдалося зʼєднатися з Anthropic".to_string())?;
    match resp.status().as_u16() {
        200 => Ok(()),
        401 | 403 => Err("Ключ API не підійшов".into()),
        c => Err(format!("Не вдалося перевірити ключ: HTTP {c}")),
    }
}

/// Перевіряє й лише за 200 викликає `store`. Окремо від команди, щоб тест не торкався keyring.
async fn key_set_with(base: &str, key: &str, store: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
    let key = key.trim();
    check_key(base, key).await?;
    store(key)
}

#[tauri::command]
pub fn advisor_key_has() -> bool {
    crate::broker_entry(KEY_USER).and_then(|e| e.get_password().map_err(|_| String::new())).is_ok()
}

/// Ґейт ДО мережі: перевірка ключа — це запит до api.anthropic.com, тож без дозволу `advisor`
/// вона не має відбутися (вимкнений Порадник не ходить у хмару навіть заради ключа).
async fn key_set_gated(gate: Result<(), String>, base: &str, key: &str, store: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
    gate?;
    key_set_with(base, key, store).await
}

#[tauri::command]
pub async fn advisor_key_set(app: State<'_, App>, key: String) -> Result<(), String> {
    key_set_gated(crate::require_advisor(&app.st), API_BASE, &key, |k| {
        crate::broker_entry(KEY_USER)?.set_password(k).map_err(|_| "Не вдалося зберегти ключ у Диспетчері облікових даних".to_string())
    }).await
}

#[tauri::command]
pub fn advisor_key_clear() -> Result<(), String> {
    // Мовчимо лише про «запису немає»; інакше ключ лишився б у сховищі, а людина б думала, що видалений.
    match crate::broker_entry(KEY_USER)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Не вдалося видалити ключ із Диспетчера облікових даних".into()),
    }
}

// ───────────────────────────── команда

#[derive(Deserialize)]
pub struct ApiReq {
    pub conv: String,
    /// Масив Messages API (знеособлений): `{role, content}`, де `content` — рядок або масив блоків.
    pub messages: Value,
    pub system: String,
    pub model: Option<String>,
}

fn valid_model(m: &str) -> bool {
    !m.is_empty() && m.len() <= 100 && m.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
}

/// Перевірка історії з вебвʼю до мережі: лише ролі user/assistant, останнє — від користувача.
fn check_messages(v: &Value) -> Result<Vec<Value>, String> {
    let a = v.as_array().filter(|a| !a.is_empty()).ok_or("Некоректна історія розмови")?;
    if a.len() > MAX_MESSAGES { return Err("Розмова задовга — почніть нову".into()); }
    if v.to_string().len() > MAX_HISTORY_BYTES { return Err("Розмова завелика".into()); }
    if a.iter().any(|m| !matches!(m["role"].as_str(), Some("user" | "assistant")) || !(m["content"].is_string() || m["content"].is_array())) {
        return Err("Некоректне повідомлення в історії".into());
    }
    if a.last().map(|m| m["role"] != "user").unwrap_or(true) { return Err("Остання репліка має бути від користувача".into()); }
    Ok(a.clone())
}

#[tauri::command]
pub fn advisor_api_ask(handle: tauri::AppHandle, app: State<App>, req: ApiReq) -> Result<(), String> {
    use tauri::Manager;
    crate::require_advisor(&app.st)?;
    let model = req.model.as_deref().map(str::trim).filter(|m| !m.is_empty()).unwrap_or(DEFAULT_MODEL).to_string();
    if !valid_model(&model) { return Err("Некоректна назва моделі".into()); }
    if req.system.len() > MAX_TEXT { return Err("Інструкція або зведення завеликі".into()); }
    let messages = check_messages(&req.messages)?;

    let key = crate::broker_entry(KEY_USER)?.get_password().map_err(|_| "Ключ API не збережено".to_string())?;
    let node = find_node().ok_or("Node.js не знайдено")?;
    let res = handle.path().resource_dir().map_err(|e| e.to_string())?;
    let js = res.join("mcp").join("groshi-mcp.js");
    let js = std::path::PathBuf::from(js.to_string_lossy().trim_start_matches(r"\\?\"));
    let dir = app.st.dir.clone();

    let (id, cancel) = app.adv.claim_http()?;
    let (conv, system) = (req.conv, req.system);
    let guard = {
        let (h, c) = (handle.clone(), conv.clone());
        RunGuard::new(app.adv.clone_slot(), id, Box::new(move |k, t| emit(&h, &c, k, t)))
    };
    tauri::async_runtime::spawn(async move {
        let mut sink = |k: &str, t: &str| emit(&handle, &conv, k, t);
        // Зі знеособленням (pseudo=true): у хмару йдуть лише псевдоніми.
        let started = tauri::async_runtime::spawn_blocking(move || {
            let mut m = Mcp::start(&node, &js, &dir, true)?;
            let t = m.tools()?;
            Ok::<_, String>((m, t))
        }).await;
        let mut mcp = match started {
            Ok(Ok(p)) => Some(p),
            Ok(Err(e)) => { sink("error", &format!("Не вдалося запустити MCP: {e}")); None }
            Err(_) => { sink("error", "Не вдалося запустити MCP"); None }
        };
        if let Some((m, t)) = mcp.as_mut() {
            run_api(API_BASE, &key, &model, &system, &messages, m as &mut dyn ToolExec, t.as_slice(), &cancel, &mut sink).await;
        }
        // Drop Mcp вбиває node; робимо це поза рантаймом, бо taskkill блокує.
        let _ = tauri::async_runtime::spawn_blocking(move || drop(mcp)).await;
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

    const SECRET: &str = "sk-test-SECRET";

    fn tools() -> Vec<McpTool> {
        vec![McpTool { name: "groshi_status".into(), description: "статус".into(), input_schema: json!({"type":"object"}) }]
    }

    #[test]
    fn body_has_required_values_and_no_forbidden() {
        let b = api_body(DEFAULT_MODEL, "sys", &[json!({"role":"user","content":"hi"})], &tools());
        assert_eq!(b["model"], "claude-opus-5-5");
        assert_eq!(b["stream"], true);
        assert_eq!(b["max_tokens"], 32000);
        assert_eq!(b["fallbacks"], "default");
        assert_eq!(b["cache_control"], json!({"type": "ephemeral"}));
        assert_eq!(b["output_config"], json!({"effort": "medium"}));
        assert_eq!(b["system"], "sys");
        let t = b["tools"].as_array().unwrap();
        assert_eq!(t[0], json!({"name":"groshi_status","description":"статус","input_schema":{"type":"object"}}));
        assert_eq!(t[1], json!({"type":"web_search_20260209","name":"web_search","max_uses":5}));
        for k in ["thinking", "temperature", "tool_choice", "budget_tokens"] {
            assert!(b.get(k).is_none() && !b.to_string().contains(&format!("\"{k}\"")), "{k}");
        }
    }

    fn ev(t: &str, v: Value) -> String { format!("event: {t}\ndata: {v}\n\n") }
    fn start(i: u64, block: Value) -> String { ev("content_block_start", json!({"type":"content_block_start","index":i,"content_block":block})) }
    fn delta(i: u64, d: Value) -> String { ev("content_block_delta", json!({"type":"content_block_delta","index":i,"delta":d})) }
    fn stop_block(i: u64) -> String { ev("content_block_stop", json!({"type":"content_block_stop","index":i})) }
    fn end(reason: &str) -> String {
        ev("message_delta", json!({"type":"message_delta","delta":{"stop_reason":reason}}))
            + &ev("message_stop", json!({"type":"message_stop"}))
    }
    fn begin() -> String { ev("message_start", json!({"type":"message_start","message":{"id":"m","content":[]}})) + &ev("ping", json!({"type":"ping"})) }
    fn text_reply(t: &str) -> String {
        begin() + &start(0, json!({"type":"text","text":""})) + &delta(0, json!({"type":"text_delta","text":t})) + &stop_block(0) + &end("end_turn")
    }
    fn tool_reply() -> String {
        begin()
            + &start(0, json!({"type":"thinking","thinking":"","signature":""}))
            + &delta(0, json!({"type":"thinking_delta","thinking":"Думаю"}))
            + &delta(0, json!({"type":"signature_delta","signature":"SIG=="}))
            + &stop_block(0)
            + &start(1, json!({"type":"tool_use","id":"toolu_1","name":"groshi_status","input":{}}))
            + &delta(1, json!({"type":"input_json_delta","partial_json":"{\"x\""}))
            + &delta(1, json!({"type":"input_json_delta","partial_json":":1}"}))
            + &stop_block(1)
            + &end("tool_use")
    }

    fn feed_all(s: &str, ms: &mut MsgStream, sink: Sink) {
        let mut sse = SseLines::default();
        for e in sse.push(s.as_bytes()) {
            if let SseEvent::Data(d) = e { ms.feed(&d, &mut *sink).unwrap(); }
        }
    }

    #[test]
    fn msgstream_collects_full_content() {
        let fixture = begin()
            + &start(0, json!({"type":"thinking","thinking":"","signature":""}))
            + &delta(0, json!({"type":"thinking_delta","thinking":"Дум"}))
            + &delta(0, json!({"type":"thinking_delta","thinking":"аю"}))
            + &delta(0, json!({"type":"signature_delta","signature":"SIG=="}))
            + &stop_block(0)
            + &start(1, json!({"type":"text","text":""}))
            + &delta(1, json!({"type":"text_delta","text":"При"}))
            + &delta(1, json!({"type":"text_delta","text":"віт"}))
            + &stop_block(1)
            + &start(2, json!({"type":"server_tool_use","id":"srv_1","name":"web_search","input":{}}))
            + &delta(2, json!({"type":"input_json_delta","partial_json":"{\"query\":\"курс\"}"}))
            + &stop_block(2)
            + &start(3, json!({"type":"web_search_tool_result","tool_use_id":"srv_1","content":[{"type":"web_search_result","url":"https://example.org","encrypted_content":"E"}]}))
            + &stop_block(3)
            + &start(4, json!({"type":"fallback","from":"a","to":"b"}))
            + &stop_block(4)
            + &start(5, json!({"type":"tool_use","id":"toolu_1","name":"market","input":{}}))
            + &delta(5, json!({"type":"input_json_delta","partial_json":"{\"sym"}))
            + &delta(5, json!({"type":"input_json_delta","partial_json":"bol\":\"X\"}"}))
            + &stop_block(5)
            + &ev("future_event", json!({"type":"future_event"}))
            + &end("tool_use");
        let seen = Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        let mut sink = move |k: &str, t: &str| s2.lock().unwrap().push((k.to_string(), t.to_string()));
        let mut ms = MsgStream::default();
        feed_all(&fixture, &mut ms, &mut sink);
        assert!(ms.is_complete());
        assert_eq!(ms.stop_reason(), Some("tool_use"));
        let c = ms.content();
        assert_eq!(c.len(), 6);
        assert_eq!(c[0], json!({"type":"thinking","thinking":"Думаю","signature":"SIG=="}));
        assert_eq!(c[1], json!({"type":"text","text":"Привіт"}));
        assert_eq!(c[2], json!({"type":"server_tool_use","id":"srv_1","name":"web_search","input":{"query":"курс"}}));
        assert_eq!(c[3]["type"], "web_search_tool_result");
        assert_eq!(c[3]["content"][0]["encrypted_content"], "E");
        assert_eq!(c[4], json!({"type":"fallback","from":"a","to":"b"}));
        assert_eq!(c[5]["input"], json!({"symbol":"X"}));
        let seen = seen.lock().unwrap();
        let kinds: Vec<&str> = seen.iter().map(|e| e.0.as_str()).collect();
        assert_eq!(kinds, ["text", "text", "tool"]);
        assert_eq!(seen[2].1, "WebSearch: курс");
    }

    #[test]
    fn msgstream_keeps_citations_and_drops_empty_text() {
        let f = begin()
            + &start(0, json!({"type":"text","text":""}))
            + &stop_block(0)
            + &start(1, json!({"type":"text","text":"","citations":null}))
            + &delta(1, json!({"type":"text_delta","text":"Так"}))
            + &delta(1, json!({"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://example.org"}}))
            + &stop_block(1)
            + &end("end_turn");
        let mut sink = |_: &str, _: &str| {};
        let mut ms = MsgStream::default();
        feed_all(&f, &mut ms, &mut sink);
        let c = ms.content();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0]["citations"][0]["url"], "https://example.org");
    }

    #[test]
    fn msgstream_error_event_hides_raw_text() {
        let mut ms = MsgStream::default();
        let mut sink = |_: &str, _: &str| {};
        let e = ms.feed(&json!({"type":"error","error":{"type":"overloaded_error","message":SECRET}}).to_string(), &mut sink).unwrap_err();
        assert!(!e.contains(SECRET) && e.contains("перевантажений"), "{e}");
    }

    // ---- мок-сервер ----

    /// Запит мока: заголовки (малими літерами) і тіло JSON (Null для GET).
    type Seen = Arc<Mutex<Vec<(String, Value)>>>;

    fn read_request(s: &mut TcpStream) -> (String, Value) {
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
        let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
        (head, serde_json::from_slice(&buf[head_end..head_end + len]).unwrap_or(Value::Null))
    }

    /// Кожне зʼєднання отримує наступну заготовку (статус, тіло); після неї сокет закривається.
    fn mock(replies: Vec<(u16, String)>) -> (String, Seen) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        let seen: Seen = Arc::new(Mutex::new(vec![]));
        let seen2 = seen.clone();
        std::thread::spawn(move || {
            for (code, body) in replies {
                let Ok((mut s, _)) = l.accept() else { return };
                let r = read_request(&mut s);
                seen2.lock().unwrap().push(r);
                let _ = s.write_all(format!("HTTP/1.1 {code} X\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}").as_bytes());
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
        });
        (base, seen)
    }

    struct Fake { calls: Vec<(String, Value)> }
    impl ToolExec for Fake {
        fn call(&mut self, n: &str, a: &Value) -> Result<(String, bool), String> { self.calls.push((n.into(), a.clone())); Ok(("результат".into(), false)) }
    }

    type Events = Arc<Mutex<Vec<(String, String)>>>;
    fn collect() -> (Events, impl FnMut(&str, &str) + Send) {
        let ev: Events = Arc::new(Mutex::new(vec![]));
        let e2 = ev.clone();
        (ev, move |k: &str, t: &str| e2.lock().unwrap().push((k.to_string(), t.to_string())))
    }
    fn user() -> Vec<Value> { vec![json!({"role":"user","content":"Привіт"})] }

    async fn run(base: &str, fake: &mut Fake, cancel: &AtomicBool) -> Vec<(String, String)> {
        let (ev, mut sink) = collect();
        run_api(base, SECRET, DEFAULT_MODEL, "sys", &user(), fake, &tools(), cancel, &mut sink).await;
        let v = ev.lock().unwrap().clone();
        v
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn plain_answer_streams_text_then_state() {
        let (base, seen) = mock(vec![(200, text_reply("Готово"))]);
        let mut fake = Fake { calls: vec![] };
        let ev = run(&base, &mut fake, &AtomicBool::new(false)).await;
        let kinds: Vec<&str> = ev.iter().map(|e| e.0.as_str()).collect();
        assert_eq!(kinds, ["text", "state"]);
        assert_eq!(ev[0].1, "Готово");
        let st: Value = serde_json::from_str(&ev[1].1).unwrap();
        assert_eq!(st, json!([{"role":"assistant","content":[{"type":"text","text":"Готово"}]}]));
        let (head, body) = &seen.lock().unwrap()[0];
        assert!(head.contains("post /v1/messages"));
        assert!(head.contains(&format!("x-api-key: {}", SECRET.to_lowercase())));
        assert!(head.contains("anthropic-version: 2023-06-01"));
        assert!(head.contains("anthropic-beta: server-side-fallback-2026-07-01"));
        assert_eq!(body["stream"], true);
        assert!(!body.to_string().contains(SECRET), "ключ не в тілі");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tool_round_sends_assistant_content_unchanged_and_one_result_message() {
        let (base, seen) = mock(vec![(200, tool_reply()), (200, text_reply("Підсумок"))]);
        let mut fake = Fake { calls: vec![] };
        let ev = run(&base, &mut fake, &AtomicBool::new(false)).await;
        let kinds: Vec<&str> = ev.iter().map(|e| e.0.as_str()).collect();
        assert_eq!(kinds, ["tool", "text", "state"]);
        assert_eq!(ev[0].1, "groshi_status");
        assert_eq!(fake.calls, vec![("groshi_status".to_string(), json!({"x":1}))]);
        let second = &seen.lock().unwrap()[1].1;
        let m = second["messages"].as_array().unwrap();
        assert_eq!(m.len(), 3);
        assert_eq!(m[1], json!({"role":"assistant","content":[
            {"type":"thinking","thinking":"Думаю","signature":"SIG=="},
            {"type":"tool_use","id":"toolu_1","name":"groshi_status","input":{"x":1}}]}));
        assert_eq!(m[2], json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"результат"}]}));
        // state: assistant(tool_use), user(tool_result), assistant(text) — рівно один раз.
        let st: Value = serde_json::from_str(&ev[2].1).unwrap();
        assert_eq!(st.as_array().unwrap().len(), 3);
        assert_eq!(st[0], m[1]);
        assert_eq!(st[1], m[2]);
        assert_eq!(ev.iter().filter(|e| e.0 == "state").count(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn auth_error_hides_key_everywhere() {
        let body = format!(r#"{{"type":"error","error":{{"type":"authentication_error","message":"invalid x-api-key {SECRET}"}}}}"#);
        let (base, _) = mock(vec![(401, body)]);
        let mut fake = Fake { calls: vec![] };
        let ev = run(&base, &mut fake, &AtomicBool::new(false)).await;
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].0, "error");
        assert!(ev[0].1.contains("Ключ API не підійшов"));
        assert!(!format!("{ev:?}").contains(SECRET));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn key_set_rejects_401_without_leaking_or_storing() {
        let (base, _) = mock(vec![(401, format!("{{\"message\":\"{SECRET}\"}}"))]);
        let stored = Arc::new(Mutex::new(false));
        let s2 = stored.clone();
        let err = key_set_with(&base, &format!("  {SECRET} "), move |_| { *s2.lock().unwrap() = true; Ok(()) }).await.unwrap_err();
        assert!(err.contains("Ключ API не підійшов"), "{err}");
        assert!(!err.contains(SECRET));
        assert!(!*stored.lock().unwrap(), "на 401 ключ не зберігається");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn key_set_stores_trimmed_on_200_and_sends_header() {
        let (base, seen) = mock(vec![(200, "{\"data\":[]}".into())]);
        let got = Arc::new(Mutex::new(String::new()));
        let g2 = got.clone();
        key_set_with(&base, &format!("  {SECRET}\n"), move |k| { *g2.lock().unwrap() = k.into(); Ok(()) }).await.unwrap();
        assert_eq!(*got.lock().unwrap(), SECRET);
        let head = seen.lock().unwrap()[0].0.clone();
        assert!(head.contains("get /v1/models?limit=1"));
        assert!(head.contains(&format!("x-api-key: {}", SECRET.to_lowercase())));
        assert!(head.contains("anthropic-version: 2023-06-01"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn key_set_gate_blocks_before_network() {
        let (base, seen) = mock(vec![(200, "{\"data\":[]}".into())]);
        let stored = Arc::new(Mutex::new(false));
        let s2 = stored.clone();
        let err = key_set_gated(crate::advisor::advisor_gate(false), &base, SECRET, move |_| { *s2.lock().unwrap() = true; Ok(()) }).await.unwrap_err();
        assert_eq!(err, "Увімкніть Порадника в Ще → Підключення");
        assert!(seen.lock().unwrap().is_empty(), "без дозволу жодного запиту в мережу");
        assert!(!*stored.lock().unwrap());
        key_set_gated(crate::advisor::advisor_gate(true), &base, SECRET, |_| Ok(())).await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn key_set_other_status_and_bad_input() {
        let (base, _) = mock(vec![(500, String::new())]);
        let e = key_set_with(&base, SECRET, |_| Ok(())).await.unwrap_err();
        assert_eq!(e, "Не вдалося перевірити ключ: HTTP 500");
        // Порожній і задовгий відсікаються до мережі: адреса недосяжна, але помилка — про ключ.
        let dead = "http://127.0.0.1:1";
        assert_eq!(key_set_with(dead, "   ", |_| Ok(())).await.unwrap_err(), "Порожній ключ");
        assert_eq!(key_set_with(dead, &"k".repeat(401), |_| Ok(())).await.unwrap_err(), "Ключ задовгий");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn http_status_mapping_and_refusal() {
        for (code, want) in [(403, "Ключ API не підійшов"), (429, "Ліміт запитів, спробуйте пізніше"), (503, "Сервіс Anthropic недоступний"),
            (400, "Anthropic відхилив запит (HTTP 400) — почніть нову розмову"), (413, "Anthropic відхилив запит (HTTP 413) — почніть нову розмову")] {
            let (base, _) = mock(vec![(code, "сире тіло помилки".into())]);
            let ev = run(&base, &mut Fake { calls: vec![] }, &AtomicBool::new(false)).await;
            assert_eq!(ev, vec![("error".to_string(), want.to_string())]);
        }
        let refusal = begin() + &start(0, json!({"type":"text","text":""})) + &delta(0, json!({"type":"text_delta","text":"Ні"})) + &stop_block(0) + &end("refusal");
        let (base, _) = mock(vec![(200, refusal)]);
        let ev = run(&base, &mut Fake { calls: vec![] }, &AtomicBool::new(false)).await;
        assert_eq!(ev.last().unwrap(), &("error".to_string(), "Модель відмовилась відповідати".to_string()));
        assert!(!ev.iter().any(|e| e.0 == "state"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pause_turn_resends_assistant_turn() {
        let paused = begin()
            + &start(0, json!({"type":"server_tool_use","id":"srv_1","name":"web_search","input":{}}))
            + &delta(0, json!({"type":"input_json_delta","partial_json":"{\"query\":\"q\"}"}))
            + &stop_block(0) + &end("pause_turn");
        let (base, seen) = mock(vec![(200, paused), (200, text_reply("Далі"))]);
        let mut fake = Fake { calls: vec![] };
        let ev = run(&base, &mut fake, &AtomicBool::new(false)).await;
        assert!(fake.calls.is_empty(), "на server_tool_use tool_result не надсилається");
        let kinds: Vec<&str> = ev.iter().map(|e| e.0.as_str()).collect();
        assert_eq!(kinds, ["tool", "text", "state"]);
        assert_eq!(ev[0].1, "WebSearch: q");
        let m = seen.lock().unwrap()[1].1["messages"].clone();
        assert_eq!(m.as_array().unwrap().len(), 2);
        assert_eq!(m[1]["role"], "assistant");
        assert_eq!(m[1]["content"][0]["type"], "server_tool_use");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dropped_stream_is_error_without_state() {
        // Тіло без message_stop: обрив посеред відповіді.
        let cut = begin() + &start(0, json!({"type":"text","text":""})) + &delta(0, json!({"type":"text_delta","text":"Поча"}));
        let (base, _) = mock(vec![(200, cut)]);
        let ev = run(&base, &mut Fake { calls: vec![] }, &AtomicBool::new(false)).await;
        assert_eq!(ev[0].0, "text");
        assert_eq!(ev.last().unwrap().0, "error");
        assert!(!ev.iter().any(|e| e.0 == "state"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn endless_tool_calls_stop_after_eight_steps() {
        let (base, seen) = mock((0..MAX_STEPS + 2).map(|_| (200, tool_reply())).collect());
        let mut fake = Fake { calls: vec![] };
        let ev = run(&base, &mut fake, &AtomicBool::new(false)).await;
        let last = ev.last().unwrap();
        assert_eq!(last.0, "error");
        assert!(last.1.contains("Забагато кроків"), "{}", last.1);
        assert_eq!(fake.calls.len(), MAX_STEPS);
        assert_eq!(seen.lock().unwrap().len(), MAX_STEPS + 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_is_silent() {
        let (base, _) = mock(vec![(200, text_reply("x"))]);
        let ev = run(&base, &mut Fake { calls: vec![] }, &AtomicBool::new(true)).await;
        assert!(ev.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn max_tokens_after_unanswered_search_is_error_without_state() {
        let cut = begin()
            + &start(0, json!({"type":"server_tool_use","id":"srv_1","name":"web_search","input":{}}))
            + &delta(0, json!({"type":"input_json_delta","partial_json":"{\"query\":\"q\"}"}))
            + &stop_block(0) + &end("max_tokens");
        let (base, _) = mock(vec![(200, cut)]);
        let ev = run(&base, &mut Fake { calls: vec![] }, &AtomicBool::new(false)).await;
        assert_eq!(ev.last().unwrap(), &("error".to_string(), "Відповідь обірвалась на пошуку — спробуйте ще раз".to_string()));
        assert!(!ev.iter().any(|e| e.0 == "state"));
    }

    #[test]
    fn answered_search_is_complete() {
        let c = vec![
            json!({"type":"server_tool_use","id":"s1","name":"web_search","input":{}}),
            json!({"type":"web_search_tool_result","tool_use_id":"s1","content":[]}),
        ];
        assert!(!has_unanswered_server_tool(&c));
        assert!(has_unanswered_server_tool(&c[..1]));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn separator_between_text_of_different_rounds() {
        let first = begin()
            + &start(0, json!({"type":"text","text":""})) + &delta(0, json!({"type":"text_delta","text":"Один"})) + &stop_block(0)
            + &start(1, json!({"type":"tool_use","id":"t1","name":"groshi_status","input":{}})) + &stop_block(1)
            + &end("tool_use");
        let (base, _) = mock(vec![(200, first), (200, text_reply("Два"))]);
        let ev = run(&base, &mut Fake { calls: vec![] }, &AtomicBool::new(false)).await;
        let texts: Vec<&str> = ev.iter().filter(|e| e.0 == "text").map(|e| e.1.as_str()).collect();
        assert_eq!(texts, ["Один", "\n\n", "Два"]);
    }

    #[test]
    fn too_long_history_has_own_message() {
        let many: Vec<Value> = (0..=MAX_MESSAGES).map(|_| json!({"role":"user","content":"a"})).collect();
        assert_eq!(check_messages(&Value::Array(many)).unwrap_err(), "Розмова задовга — почніть нову");
    }

    #[test]
    fn messages_validation() {
        assert!(check_messages(&json!([{"role":"user","content":"a"}])).is_ok());
        assert!(check_messages(&json!([])).is_err());
        assert!(check_messages(&json!([{"role":"system","content":"a"}])).is_err());
        assert!(check_messages(&json!([{"role":"assistant","content":"a"}])).is_err());
        assert!(check_messages(&json!({"role":"user"})).is_err());
        assert!(valid_model("claude-opus-5-5") && !valid_model("a b") && !valid_model(""));
    }
}
