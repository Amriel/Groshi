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

fn valid_currency(ccy: &str) -> bool {
    ccy.len() == 3 && ccy.bytes().all(|b| b.is_ascii_uppercase())
}

/// Фільтрація цифр перетворювала довільний текст на дату; натомість
/// приймаємо лише справжню календарну дату в обумовленому форматі.
fn compact_date(date: &str) -> Option<String> {
    let b = date.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-'
        || !b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
        return None;
    }
    let year: u32 = date[..4].parse().ok()?;
    let month: u32 = date[5..7].parse().ok()?;
    let day: u32 = date[8..].parse().ok()?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if leap { 29 } else { 28 },
        _ => return None,
    };
    if year == 0 || day == 0 || day > days { return None; }
    Some(date.replace('-', ""))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Перенаправлення можуть віддати токени іншому вузлу; API мають фіксовані адреси.
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .timeout(Duration::from_secs(20))
        .user_agent("Groshi/1.0")
        .build()
        .map_err(|e| e.without_url().to_string())
}

/// Один курс: валюта (USD/EUR/…) + дата YYYY-MM-DD → грн за одиницю.
async fn one(c: &reqwest::Client, ccy: &str, date: &str) -> Option<f64> {
    if !valid_currency(ccy) { return None; }
    let compact = compact_date(date)?;
    let r = c.get("https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange")
        .query(&[("valcode", ccy), ("date", compact.as_str()), ("json", "")])
        .send().await.ok()?;
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

#[cfg(test)]
mod privacy_tests {
    use super::*;

    #[test]
    fn currency_cannot_add_query_parameters() {
        assert!(valid_currency("USD"));
        assert!(valid_currency("EUR"));
        for ccy in ["", "usd", " USD", "USD ", "USDT", "USD&secret=x", "USD?x", "USD\n", "€"] {
            assert!(!valid_currency(ccy), "{ccy:?}");
        }
    }

    #[test]
    fn dates_require_exact_format_and_valid_calendar_day() {
        assert_eq!(compact_date("2026-09-10"), Some("20260910".into()));
        assert_eq!(compact_date("2024-02-29"), Some("20240229".into()));
        assert_eq!(compact_date("2000-02-29"), Some("20000229".into()));
        for date in ["20260910", "2026/09/10", "x2026-09-10", "2026-09-10?secret=x", "2026-02-29", "1900-02-29", "2026-04-31", "2026-00-10", "2026-13-10", "2026-01-00", "0000-01-01", "2026-0é-1"] {
            assert_eq!(compact_date(date), None, "{date:?}");
        }
    }

    #[tokio::test]
    async fn invalid_rate_input_is_rejected_before_network() {
        let c = client().unwrap();
        assert_eq!(one(&c, "USD&secret=x", "2026-09-10").await, None);
        assert_eq!(one(&c, "USD", "x2026-09-10").await, None);
    }
}
