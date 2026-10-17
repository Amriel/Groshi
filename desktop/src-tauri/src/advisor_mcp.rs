// Мінімальний MCP-клієнт (JSON-RPC по рядках через stdio) до нашого read-only Node-сервера.
// Навіщо: у режимах «локальна модель» та Anthropic API цикл інструментів веде сам застосунок,
// тож йому потрібно самому запитувати tools/list і викликати tools/call.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use crate::advisor::{kill_tree, no_window};

/// Скільки чекаємо відповідь на один запит; після цього — Err, а не вічне зависання циклу.
const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

pub struct Mcp {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    next_id: u64,
}

impl Mcp {
    pub fn start(node: &Path, script: &Path, data_dir: &Path, pseudo: bool) -> Result<Mcp, String> {
        let mut c = Command::new(node);
        c.arg(script)
            .env("GROSHI_DIR", data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // stderr не читаємо: заповнений канал заблокував би node.
            .stderr(Stdio::null());
        // Явно в обох напрямках: успадковане з середовища GROSHI_PSEUDO не має вмикати режим саме.
        if pseudo { c.env("GROSHI_PSEUDO", "1"); } else { c.env_remove("GROSHI_PSEUDO"); }
        no_window(&mut c);
        let mut child = c.spawn().map_err(|e| format!("Не вдалося запустити MCP: {e}"))?;
        let stdin = child.stdin.take().ok_or("MCP: немає stdin")?;
        let stdout = child.stdout.take().ok_or("MCP: немає stdout")?;
        // Окремий потік, бо read_line не має таймауту; канал дає recv_timeout.
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                    if tx.send(v).is_err() { break; }
                }
            }
        });
        // Drop убʼє процес і при ранній помилці рукостискання.
        let mut m = Mcp { child, stdin, rx, next_id: 1 };
        m.request("initialize", json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "groshi-advisor", "version": "1"}
        }))?;
        m.notify("notifications/initialized")?;
        Ok(m)
    }

    fn write(&mut self, v: &Value) -> Result<(), String> {
        let mut s = v.to_string();
        s.push('\n');
        self.stdin.write_all(s.as_bytes()).and_then(|_| self.stdin.flush())
            .map_err(|e| format!("MCP: запис не вдався: {e}"))
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        self.write(&json!({"jsonrpc": "2.0", "method": method}))
    }

    /// Повертає `result`; відповідь JSON-RPC з `error` — Err. Повідомлення без нашого id пропускаємо.
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        let deadline = Instant::now() + REPLY_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(v) if v.get("id").and_then(Value::as_u64) == Some(id) => {
                    if let Some(e) = v.get("error") {
                        let m = e.get("message").and_then(Value::as_str).unwrap_or("помилка MCP");
                        return Err(m.to_string());
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => return Err("MCP: таймаут відповіді".into()),
                Err(RecvTimeoutError::Disconnected) => return Err("MCP: процес завершився".into()),
            }
        }
    }

    pub fn tools(&mut self) -> Result<Vec<McpTool>, String> {
        let r = self.request("tools/list", json!({}))?;
        let arr = r.get("tools").and_then(Value::as_array).ok_or("MCP: немає списку інструментів")?;
        Ok(arr.iter().filter_map(|t| Some(McpTool {
            name: t.get("name")?.as_str()?.to_string(),
            description: t.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
            input_schema: t.get("inputSchema").cloned().unwrap_or_else(|| json!({"type": "object"})),
        })).collect())
    }

    /// (текст, is_error). Збій протоколу (невідомий інструмент) — Err.
    pub fn call(&mut self, name: &str, args: &Value) -> Result<(String, bool), String> {
        let r = self.request("tools/call", json!({"name": name, "arguments": args}))?;
        let text = r.get("content").and_then(Value::as_array).map(|a| {
            a.iter().filter_map(|c| c.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")
        }).unwrap_or_default();
        Ok((text, r.get("isError").and_then(Value::as_bool).unwrap_or(false)))
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        // На Windows node міг би пережити простий kill — тому дерево.
        kill_tree(&mut self.child);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// (node, скрипт, порожня тека даних) або None, якщо node немає.
    fn setup(tag: &str) -> Option<(PathBuf, PathBuf, PathBuf)> {
        let Some(node) = crate::advisor::find_node() else {
            println!("пропущено: немає node");
            return None;
        };
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mcp/groshi-mcp.js");
        let dir = std::env::temp_dir().join(format!("groshi_mcp_test_{tag}_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Some((node, script, dir))
    }

    #[test]
    fn lists_eleven_tools_with_market() {
        let Some((node, script, dir)) = setup("list") else { return };
        let mut m = Mcp::start(&node, &script, &dir, true).unwrap();
        let t = m.tools().unwrap();
        assert_eq!(t.len(), 11);
        assert!(t.iter().any(|x| x.name == "market"));
        assert!(t.iter().all(|x| x.input_schema.is_object()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_hides_dir_only_in_pseudo() {
        let Some((node, script, dir)) = setup("status") else { return };
        let mut p = Mcp::start(&node, &script, &dir, true).unwrap();
        let (t, err) = p.call("groshi_status", &json!({})).unwrap();
        assert!(!err);
        assert!(t.contains("Тека даних: прихована"), "{t}");
        drop(p);
        let mut n = Mcp::start(&node, &script, &dir, false).unwrap();
        let (t, _) = n.call("groshi_status", &json!({})).unwrap();
        assert!(!t.contains("Тека даних: прихована"), "{t}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_tool_is_error() {
        let Some((node, script, dir)) = setup("nope") else { return };
        let mut m = Mcp::start(&node, &script, &dir, true).unwrap();
        match m.call("nope", &json!({})) {
            Err(_) => {}
            Ok((_, is_err)) => assert!(is_err),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
