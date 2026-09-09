//! Клієнт Binance API — лише читання.
//!
//! ЧОМУ ЛИШЕ ЧИТАННЯ
//! Апці потрібно знати «скільки там лежить», а не торгувати. Тому ключ
//! перевіряється на вході: якщо на ньому увімкнено торгівлю, виведення чи
//! перекази — відмовляємось працювати й кажемо, які саме права зайві.
//! Так навіть викрадений з диска ключ не дасть зловмиснику більше, ніж
//! подивитись баланси.
//!
//! ЧОМУ ЧАС БЕРЕТЬСЯ У СЕРВЕРА
//! Підписані запити Binance несуть timestamp і відхиляються, якщо він
//! розійшовся з серверним більше ніж на recvWindow. Локальний годинник
//! десктопа пливе (сон, віртуалки, ручне переведення), тож на початку
//! кожного fetch/check тягнемо /api/v3/time і далі рахуємо не «свій час»,
//! а «свій час + поправка». Поправка, а не один зафіксований timestamp,
//! бо між ретраями минають десятки секунд — застиглий timestamp випав би
//! з десятисекундного вікна.
//!
//! ЛІМІТИ БІРЖІ
//! Binance рахує вагу запитів за хвилину; при перевищенні віддає 429, а
//! за ігнорування 429 — банить IP (418). Тому на обидва коди чекаємо
//! стільки, скільки просить Retry-After, і лише потім пробуємо ще.

use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use sha2::Sha256;

const BASE: &str = "https://api.binance.com";
/// Максимум, який дозволяє Binance для simple-earn — менше сторінок,
/// менше запитів, менша витрачена вага ліміту.
const PAGE: usize = 100;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Перенаправлення можуть віддати токени іншому вузлу; API мають фіксовані адреси.
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .timeout(Duration::from_secs(30))
        .user_agent("Groshi/1.0")
        .build()
        .map_err(|e| e.without_url().to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Рядок-число з відповіді біржі. Binance віддає суми рядками, щоб не
/// втрачати точність у JSON, — для фільтра «ненульове» досить f64.
fn num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::String(s)) => s.parse().unwrap_or(0.0),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Поправка «серверний час − локальний». Додається до локального
/// годинника перед кожним підписом.
async fn time_offset(c: &reqwest::Client) -> Result<i64, String> {
    let v = call(c, None, false, "/api/v3/time", "", 0).await?;
    let server = v
        .get("serverTime")
        .and_then(|x| x.as_i64())
        .ok_or_else(|| "Біржа не віддала свій час".to_string())?;
    Ok(server - now_ms())
}

fn sign(secret: &str, query: &str) -> Result<String, String> {
    /* HMAC приймає ключ будь-якої довжини, тож помилка тут практично
       неможлива — але панікувати через зіпсований секрет усе одно не
       можна: це шлях, куди потрапляє введене користувачем. */
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| "Секрет не годиться для підпису".to_string())?;
    mac.update(query.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// Один запит до біржі з ретраями. `auth = Some((key, secret))` — запит
/// підписується; timestamp рахується заново на кожну спробу, бо між
/// спробами могло минути більше, ніж recvWindow.
///
/// У повідомленнях про помилки — лише HTTP-код:
/// ані ключ, ані секрет, ані підписаний URL туди не потрапляють.
async fn call(
    c: &reqwest::Client,
    auth: Option<(&str, &str)>,
    post: bool,
    path: &str,
    extra: &str,
    offset: i64,
) -> Result<Value, String> {
    let mut tries = 0;
    loop {
        tries += 1;

        let url = match auth {
            Some((_, secret)) => {
                let ts = now_ms() + offset;
                /* recvWindow 10 с — щедріше за типові 5: десктоп може
                   прокинутись зі сну посеред запиту, а безпеки ширше
                   вікно не послаблює, бо ключ і так лише на читання. */
                let query = if extra.is_empty() {
                    format!("timestamp={ts}&recvWindow=10000")
                } else {
                    format!("{extra}&timestamp={ts}&recvWindow=10000")
                };
                let sig = sign(secret, &query)?;
                format!("{BASE}{path}?{query}&signature={sig}")
            }
            None => {
                if extra.is_empty() {
                    format!("{BASE}{path}")
                } else {
                    format!("{BASE}{path}?{extra}")
                }
            }
        };

        let mut req = if post { c.post(&url) } else { c.get(&url) };
        if let Some((key, _)) = auth {
            req = req.header("X-MBX-APIKEY", key);
        }

        let r = req.send().await.map_err(|e| {
            // Вилучаємо весь URL, щоб підпис не залежав від способу кодування.
            let m = e.without_url().to_string();
            format!("Binance недоступний — перевірте інтернет. Деталь: {m}")
        })?;
        let code = r.status().as_u16();
        // Retry-After читається до того, як тіло поглине відповідь
        let wait = r
            .headers()
            .get("retry-after")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(60);
        let body = r.text().await.unwrap_or_default();

        // Binance кладе власний код помилки в тіло — HTTP-статус
        // буває 400 навіть для «ключ не той», тож дивимось і туди.
        let api_code = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v.get("code").and_then(|x| x.as_i64()));

        if code == 401 || code == 403 || api_code == Some(-2015) || api_code == Some(-2014) {
            return Err("Ключ відхилено Binance. Перевірте ключ і секрет.".into());
        }

        match code {
            200 => {
                return serde_json::from_str(&body)
                    .map_err(|_| "Відповідь біржі не читається".to_string())
            }
            // 429 — ліміт ваги, 418 — попередження перед баном за
            // ігнорування 429. В обох випадках єдине правильне — чекати.
            418 | 429 => {
                if tries > 3 {
                    return Err("Біржа тримає ліміт запитів. Спробуйте за кілька хвилин.".into());
                }
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
            c if c >= 500 => {
                if tries > 3 {
                    return Err(format!("Біржа відповіла {c}"));
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            _ => return Err(format!("Біржа відповіла {code}")),
        }
    }
}

/// Перевірка ключа: тягне його права й відмовляється працювати, якщо
/// ключ уміє щось, крім читання. Повертає сирі права — інтерфейс показує
/// їх користувачеві, щоб було видно, що саме апка про ключ знає.
pub async fn check(key: &str, secret: &str) -> Result<Value, String> {
    let c = client()?;
    let offset = time_offset(&c).await?;
    let v = call(
        &c,
        Some((key, secret)),
        false,
        "/sapi/v1/account/apiRestrictions",
        "",
        offset,
    )
    .await?;

    if v.get("enableReading").and_then(|x| x.as_bool()) != Some(true) {
        return Err("Ключ не має права читання (enableReading). Такий ключ марний для апки.".into());
    }

    /* Права перевіряються білим списком безпечних полів, а не чорним
       списком небезпечних: Binance час від часу додає нові дозволи, і
       невідомий увімкнений дозвіл має лякати, а не прослизати. */
    let safe = [
        "enableReading",
        "ipRestrict",
        "createTime",
        "tradingAuthorityExpirationTime",
    ];
    let mut extra: Vec<&str> = Vec::new();
    if let Some(obj) = v.as_object() {
        for (name, val) in obj {
            if val == &Value::Bool(true) && !safe.contains(&name.as_str()) {
                extra.push(name.as_str());
            }
        }
    }
    if !extra.is_empty() {
        // Назви невідомих полів теж надходять із мережі й можуть повторити ключ.
        return Err("Ключ має зайві права. Апці потрібне лише читання — створіть ключ, \
             де ввімкнено тільки «Enable Reading».".into());
    }

    Ok(v)
}

/// Усі сторінки одного simple-earn ендпоінта. Біржа не каже, скільки
/// сторінок буде, — гортаємо, поки віддає повні.
async fn earn_pages(
    c: &reqwest::Client,
    key: &str,
    secret: &str,
    path: &str,
    offset: i64,
) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut current = 1;
    loop {
        let v = call(
            c,
            Some((key, secret)),
            false,
            path,
            &format!("current={current}&size={PAGE}"),
            offset,
        )
        .await?;
        let rows = v
            .get("rows")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        let n = rows.len();
        out.extend(rows);
        if n < PAGE {
            break;
        }
        current += 1;
        // Понад 5000 позицій — це вже не портфель, а збій пагінації.
        // Запобіжник, щоб глюк біржі не закрутив нас у вічний цикл.
        if current > 50 {
            break;
        }
    }
    Ok(out)
}

/// Повний знімок акаунту для читання: спот, накопичення (simple earn),
/// funding-гаманець і ціни в USDT для всього, що знайшлося.
pub async fn fetch(key: &str, secret: &str) -> Result<Value, String> {
    let c = client()?;
    let offset = time_offset(&c).await?;

    // ── спот ────────────────────────────────────────────────────────
    let mut account = call(&c, Some((key, secret)), false, "/api/v3/account", "", offset).await?;
    /* /api/v3/account перелічує сотні активів з нульовими балансами —
       зберігати це немає сенсу, тож лишаємо тільки те, що реально є.
       Заразом збираємо перелік активів для запиту цін нижче. */
    let mut assets: HashSet<String> = HashSet::new();
    let balances: Vec<Value> = account
        .get("balances")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|b| num(b.get("free")) + num(b.get("locked")) > 0.0)
        .collect();
    for b in &balances {
        if let Some(a) = b.get("asset").and_then(|x| x.as_str()) {
            assets.insert(a.to_string());
        }
    }
    if let Some(obj) = account.as_object_mut() {
        obj.insert("balances".into(), Value::Array(balances));
    }

    // ── накопичення ─────────────────────────────────────────────────
    let flexible = earn_pages(&c, key, secret, "/sapi/v1/simple-earn/flexible/position", offset).await?;
    let locked = earn_pages(&c, key, secret, "/sapi/v1/simple-earn/locked/position", offset).await?;
    for p in flexible.iter().chain(locked.iter()) {
        if let Some(a) = p.get("asset").and_then(|x| x.as_str()) {
            assets.insert(a.to_string());
        }
    }

    // ── funding-гаманець ────────────────────────────────────────────
    // Так, це POST — так у Binance влаштовано читання funding-балансу.
    let funding_raw = call(
        &c,
        Some((key, secret)),
        true,
        "/sapi/v1/asset/get-funding-asset",
        "",
        offset,
    )
    .await?;
    let funding: Vec<Value> = funding_raw
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|f| num(f.get("free")) + num(f.get("locked")) + num(f.get("freeze")) > 0.0)
        .collect();
    for f in &funding {
        if let Some(a) = f.get("asset").and_then(|x| x.as_str()) {
            assets.insert(a.to_string());
        }
    }

    // ── ціни ────────────────────────────────────────────────────────
    /* Тягнути ціни по одній парі — по запиту на актив; всі разом — один
       публічний запит без підпису, і хай навіть у відповіді дві тисячі
       пар, відфільтрувати їх локально дешевше, ніж ходити по мережі.
       Цікавлять лише <актив>USDT для того, що реально лежить в акаунті;
       сам USDT пари до себе не має — його курс і так одиниця. */
    /* 24-годинна статистика замість голої ціни: та сама вартість
       запиту, але на додачу — добова зміна у відсотках, і вкладка
       може показати «BTC ▲2,3% сьогодні» без жодного зайвого походу. */
    let tickers = call(&c, None, false, "/api/v3/ticker/24hr", "", 0).await?;
    let mut prices = Map::new();
    for t in tickers.as_array().unwrap_or(&vec![]) {
        let symbol = match t.get("symbol").and_then(|x| x.as_str()) {
            Some(s) => s,
            None => continue,
        };
        let base = match symbol.strip_suffix("USDT") {
            Some(b) => b,
            None => continue,
        };
        if !assets.contains(base) {
            continue;
        }
        let price = num(t.get("lastPrice"));
        if price <= 0.0 {
            continue;
        }
        prices.insert(symbol.to_string(), json!({
            "p": price,
            "chg": num(t.get("priceChangePercent")),
        }));
    }

    // ── угоди спота ─────────────────────────────────────────────────
    // myTrades працює лише по конкретній парі, тож питаємо {актив}USDT
    // для кожного наявного активу; стейбли — котирувальна нога, їх не
    // питаємо. Читаючого ключа для цього досить. Без угод журнал крипти
    // порожній, а мітки і історія купівель — неможливі.
    let stables = ["USDT", "USDC", "DAI", "FDUSD", "BUSD", "TUSD"];
    let mut trades = Map::new();
    for a in assets.iter().filter(|a| !stables.contains(&a.as_str())).take(15) {
        let pair = format!("{a}USDT");
        if let Ok(v) = call(
            &c, Some((key, secret)), false, "/api/v3/myTrades",
            &format!("symbol={pair}&limit=500"), offset,
        ).await {
            if v.as_array().map(|x| !x.is_empty()).unwrap_or(false) {
                trades.insert(a.clone(), v);
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    Ok(json!({
        "account": account,
        "earnFlexible": flexible,
        "earnLocked": locked,
        "funding": funding,
        "prices": Value::Object(prices),
        "trades": Value::Object(trades),
        "fetched": now_ms() / 1000,
    }))
}
