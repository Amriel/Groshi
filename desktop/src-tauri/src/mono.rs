//! Клієнт Monobank personal API.
//!
//! ЧОМУ ОПИТУВАННЯ, А НЕ ВЕБХУК
//! Вебхук вимагає постійно доступного HTTPS-адреса й того, щоб токен лежав
//! на сервері. Це десктопна апка на одній машині — сервера немає й не буде.
//! Банк віддає виписку одразу, тож опитування раз на кілька хвилин дає ту
//! саму свіжість без жодної інфраструктури.
//!
//! ЛІМІТИ БАНКУ (документовані)
//!   · не частіше ніж 1 запит на 60 секунд — і на client-info, і на statement;
//!   · вікно виписки — не більше 31 доби + 1 година (2 682 000 с).
//! Тому історія тягнеться вікнами по 30 діб із паузою між запитами, а
//! звичайне оновлення бере лише останні дні.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const BASE: &str = "https://api.monobank.ua";
/// Банк дає рівно 31 добу + 1 годину. Беремо 31 добу: на рік це 12 вікон
/// замість 13, тобто на одну хвилину очікування менше на кожному рахунку.
pub const WINDOW: i64 = 31 * 86_400;
const GAP: u64 = 62; // ліміт 60 с; +2 с щоб не впертись у межу через дрейф годинника

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub title: String,
    pub kind: String,   // black / white / fop / platinum / iron / jar
    pub currency: i64,
    pub balance: f64,
    pub iban: String,
    pub masked: Vec<String>,
    /// Цільова сума банки (грн). Тільки для kind=jar і тільки коли
    /// власник її поставив — фронтенд малює прогрес до цілі.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub stage: String,
    pub account: String,
    pub done: usize,
    pub total: usize,
    pub added: usize,
    pub wait: u64,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Groshi/1.0")
        .build()
        .map_err(|e| e.to_string())
}

async fn get(token: &str, path: &str) -> Result<Value, String> {
    let c = client()?;
    let mut tries = 0;
    loop {
        tries += 1;
        let r = c
            .get(format!("{BASE}{path}"))
            .header("X-Token", token)
            .send()
            .await
            .map_err(|e| format!("мережа: {e}"))?;
        let code = r.status().as_u16();
        let body = r.text().await.unwrap_or_default();
        match code {
            200 => {
                return serde_json::from_str(&body)
                    .map_err(|e| format!("відповідь банку не читається: {e}"))
            }
            401 | 403 => return Err("Токен відхилено банком. Перевірте його в налаштуваннях.".into()),
            // 429 — впертись у ліміт це нормально: чекаємо й пробуємо ще
            429 => {
                if tries > 5 {
                    return Err("Банк тримає ліміт запитів. Спробуйте за кілька хвилин.".into());
                }
                tokio::time::sleep(Duration::from_secs(GAP)).await;
            }
            _ => {
                if tries > 3 {
                    return Err(format!("Банк відповів {code}: {}", trim(&body)));
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

fn trim(s: &str) -> String {
    let t: String = s.chars().take(200).collect();
    t
}

/// Рахунки й банки. Дає ще й імена, щоб у списку операцій було видно,
/// звідки саме пішли гроші.
pub async fn accounts(token: &str) -> Result<(Vec<Account>, String), String> {
    let v = get(token, "/personal/client-info").await?;
    /* Імʼя власника потрібне, щоб упізнати переказ самому собі: банк у
       такій операції пише в counterName саме його, і без цього знання
       зарахування виглядає як дохід ззовні. */
    let owner = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut out = Vec::new();

    if let Some(list) = v.get("accounts").and_then(|x| x.as_array()) {
        for a in list {
            let kind = a.get("type").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let ccy = a.get("currencyCode").and_then(|x| x.as_i64()).unwrap_or(980);
            let iban = a.get("iban").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let masked: Vec<String> = a
                .get("maskedPan")
                .and_then(|x| x.as_array())
                .map(|v| v.iter().filter_map(|s| s.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let title = format!(
                "{} {}",
                match kind.as_str() {
                    "black" => "Чорна",
                    "white" => "Біла",
                    "platinum" => "Платинум",
                    "iron" => "Айрон",
                    "fop" => "ФОП",
                    "yellow" => "Жовта",
                    _ => "Рахунок",
                },
                ccy_name(ccy)
            );
            out.push(Account {
                id: a.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                title,
                kind,
                currency: ccy,
                balance: a.get("balance").and_then(|x| x.as_i64()).unwrap_or(0) as f64 / 100.0,
                iban,
                masked,
                goal: None,
            });
        }
    }
    if let Some(list) = v.get("jars").and_then(|x| x.as_array()) {
        for j in list {
            out.push(Account {
                id: j.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                title: format!("Банка «{}»", j.get("title").and_then(|x| x.as_str()).unwrap_or("")),
                kind: "jar".into(),
                currency: j.get("currencyCode").and_then(|x| x.as_i64()).unwrap_or(980),
                balance: j.get("balance").and_then(|x| x.as_i64()).unwrap_or(0) as f64 / 100.0,
                iban: String::new(),
                masked: vec![],
                goal: j
                    .get("goal")
                    .and_then(|x| x.as_i64())
                    .filter(|g| *g > 0)
                    .map(|g| g as f64 / 100.0),
            });
        }
    }
    Ok((out, owner))
}

fn ccy_name(c: i64) -> &'static str {
    match c {
        980 => "₴",
        840 => "$",
        978 => "€",
        985 => "zł",
        826 => "£",
        _ => "",
    }
}

/// Виписка одного рахунку за проміжок. Повертає сирі елементи як є —
/// розбір і категоризація живуть в інтерфейсі, щоб правила можна було
/// міняти без перезбирання застосунку.
pub async fn statement(token: &str, account: &str, from: i64, to: i64) -> Result<Vec<Value>, String> {
    let v = get(token, &format!("/personal/statement/{account}/{from}/{to}")).await?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

/// Курси валют банку. Ендпоінт публічний — токен не потрібен, і це
/// добре: курс потрібен навіть тоді, коли банк ще не підключено.
/// Ліміт — один запит на 5 хвилин, тож відповідь кешуємо на годину.
pub async fn currency() -> Result<Vec<(String, f64)>, String> {
    let c = client()?;
    let r = c
        .get(format!("{BASE}/bank/currency"))
        .send()
        .await
        .map_err(|e| format!("мережа: {e}"))?;
    if r.status().as_u16() == 429 {
        return Err("Курси щойно запитували — банк дає їх раз на 5 хвилин".into());
    }
    if !r.status().is_success() {
        return Err(format!("Банк відповів {}", r.status().as_u16()));
    }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for it in v.as_array().unwrap_or(&vec![]) {
        // цікавлять лише пари «валюта → гривня»
        if it.get("currencyCodeB").and_then(|x| x.as_i64()) != Some(980) {
            continue;
        }
        let a = match it.get("currencyCodeA").and_then(|x| x.as_i64()) {
            Some(x) => x,
            None => continue,
        };
        let name = match ccy_code(a) {
            Some(n) => n,
            None => continue,
        };
        /* Купівля й продаж — це те, за чим міняють. Для оцінки «скільки
           це в гривні» чесніша середина; якщо банк дав лише крос-курс
           (так буває для рідших валют), беремо його. */
        let buy = it.get("rateBuy").and_then(|x| x.as_f64());
        let sell = it.get("rateSell").and_then(|x| x.as_f64());
        let rate = match (buy, sell) {
            (Some(b), Some(s)) if b > 0.0 && s > 0.0 => (b + s) / 2.0,
            _ => match it.get("rateCross").and_then(|x| x.as_f64()) {
                Some(c) if c > 0.0 => c,
                _ => continue,
            },
        };
        out.push((name.to_string(), (rate * 10000.0).round() / 10000.0));
    }
    if out.is_empty() {
        return Err("Банк не віддав жодного курсу".into());
    }
    Ok(out)
}

fn ccy_code(c: i64) -> Option<&'static str> {
    Some(match c {
        840 => "USD", 978 => "EUR", 985 => "PLN", 826 => "GBP",
        756 => "CHF", 124 => "CAD", 392 => "JPY", 203 => "CZK",
        _ => return None,
    })
}

/// Розбиття проміжку на вікна, які банк погодиться віддати.
pub fn windows(from: i64, to: i64) -> Vec<(i64, i64)> {
    let mut out = Vec::new();
    let mut a = from;
    while a < to {
        let b = (a + WINDOW).min(to);
        out.push((a, b));
        a = b;
    }
    if out.is_empty() {
        out.push((from, to));
    }
    out
}

pub const REQ_GAP: u64 = GAP;
