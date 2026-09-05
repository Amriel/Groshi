//! Офіційні курси НБУ на конкретні дати.
//!
//! НАВІЩО
//! Податки рахуються у гривні за курсом НБУ на дату КОЖНОЇ операції
//! (так вимагає ПКУ), а розклад прибутку «папери проти курсу» потребує
//! курсу на дату кожного поповнення. Сьогоднішній курс тут не годиться.
//!
//! ДЖЕРЕЛО
//! Відкритий API НБУ, без ключів:
//!   https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange
//!     ?valcode=USD&date=20260827&json
//! Курс історичний і вже ніколи не зміниться — тому кеш (nbu_rates.json)
//! вічний: раз стягнули дату — більше не питаємо.

use serde_json::{json, Map, Value};
use std::time::Duration;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Groshi/1.0")
        .build()
        .map_err(|e| e.to_string())
}

/// Один курс: валюта (USD/EUR/…) + дата YYYY-MM-DD → грн за одиницю.
async fn one(c: &reqwest::Client, ccy: &str, date: &str) -> Option<f64> {
    let compact: String = date.chars().filter(|ch| ch.is_ascii_digit()).collect();
    if compact.len() != 8 {
        return None;
    }
    let url = format!(
        "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode={ccy}&date={compact}&json"
    );
    let r = c.get(&url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let v: Value = r.json().await.ok()?;
    v.get(0)?.get("rate")?.as_f64()
}

/// Курси для набору (ccy, date). Ключ відповіді — "USD:2026-08-27".
/// Відсутній курс (вихідний у майбутньому, помилка мережі) просто не
/// потрапляє у відповідь — фронтенд сам вирішує, чим його замінити.
pub async fn rates(list: Vec<(String, String)>) -> Value {
    let Ok(c) = client() else { return json!({}) };
    let mut out = Map::new();
    for (ccy, date) in list {
        if let Some(r) = one(&c, &ccy, &date).await {
            out.insert(format!("{ccy}:{date}"), json!(r));
        }
        // НБУ ліміти не документує, але сотня запитів чергою — неввічливо
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    Value::Object(out)
}
