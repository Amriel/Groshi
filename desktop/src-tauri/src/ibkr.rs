//! Клієнт Interactive Brokers Flex Web Service.
//!
//! ЧОМУ САМЕ FLEX, А НЕ TWS API
//! TWS API вимагає запущеного термінала або IB Gateway на машині й уміє
//! торгувати — для апки, якій треба лише читати звіти, це зайва поверхня
//! ризику. Flex-токен уміє рівно одне: віддати заздалегідь налаштований
//! у Client Portal звіт. Навіть викрадений, він не дасть торкнутись грошей.
//!
//! ЯК ЦЕ ПРАЦЮЄ (двокроково)
//!   1. SendRequest — просимо IB зібрати звіт, у відповідь ReferenceCode;
//!   2. GetStatement — забираємо готовий XML за цим кодом.
//! Між кроками звіт реально формується: 5–30 секунд, у години торгів
//! довше. Поки не готовий, GetStatement віддає ErrorCode 1019 — це не
//! помилка, а «зайдіть пізніше», тож просто чекаємо й повторюємо.
//!
//! XML ТУТ НЕ РОЗБИРАЄТЬСЯ
//! Сирий звіт віддається фронтенду рядком — розбір і категоризація живуть
//! у JS (як у mononorm.js), щоб правила можна було міняти без перезбирання
//! застосунку. У Rust лишається тільки витягання службових тегів статусу.

use std::time::Duration;

const BASE: &str = "https://gdcdyn.interactivebrokers.com/Universal/servlet";
/// Скільки чекати перед першою спробою забрати звіт. Менше 5 с не має
/// сенсу — швидше IB звіти не збирає, а зайвий запит лише зʼїсть ліміт
/// (~1 запит/сек на весь сервіс).
const FIRST_WAIT: u64 = 8;
/// Пауза між повторами, поки IB віддає «ще формується» чи «зайдіть пізніше».
const RETRY_WAIT: u64 = 10;
/// 18 спроб × 10 с ≈ 3 хвилини. Довше означає, що звіт величезний або
/// в IB негаразди — краще чесно здатися, ніж висіти нескінченно.
const MAX_TRIES: u32 = 18;

/// Коди «зайдіть пізніше» — стан сервера IB, а не помилка налаштувань.
/// Перша версія знала лише 1019 і показувала користувачу «Statement could
/// not be generated at this time» як фатальну — хоч IB прямо пише «Please
/// try again shortly». Уся ця сімʼя лікується очікуванням:
///   1001/1009/1021 — звіт зараз не зібрати / сервер перевантажений;
///   1004–1008 — дані (розрахунки, P&L) ще не готові;
///   1018 — забагато запитів з токена (буває одразу після перевірки);
///   1019 — звіт ще формується.
fn transient(code: &str) -> bool {
    matches!(code, "1001" | "1004" | "1005" | "1006" | "1007" | "1008"
                 | "1009" | "1018" | "1019" | "1021")
}

fn client() -> Result<reqwest::Client, String> {
    // Без User-Agent IB мовчки відхиляє запит — заголовок обовʼязковий.
    reqwest::Client::builder()
        // Перенаправлення можуть віддати токени іншому вузлу; API мають фіксовані адреси.
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .timeout(Duration::from_secs(60))
        .user_agent("Groshi/1.0")
        .build()
        .map_err(|e| e.without_url().to_string())
}

/// Витягнути значення тега без повного XML-парсера: службові теги статусу
/// (<Status>, <ErrorCode>...) IB віддає завжди в простому вигляді
/// `<Tag>значення</Tag>`, тож підрядкового пошуку досить.
fn xml_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = start + xml[start..].find(&close)?;
    Some(xml[start..end].trim().to_string())
}

/// МЕРЕЖЕВА помилка reqwest вкладає в текст ПОВНИЙ URL — разом із
/// токеном у query (реальний випадок: користувач побачив свій токен у
/// повідомленні апки). Вилучаємо весь URL: проста заміна токена не
/// знаходить його URL-кодований вигляд.
fn net_err(e: reqwest::Error) -> String {
    let raw = e.without_url().to_string();
    format!(
        "Не вдалося достукатись до IBKR — перевірте інтернет і спробуйте ще раз \
         (якщо повторюється, портал може бути тимчасово недоступний; звіт завжди \
         можна взяти вручну: Run → XML → «Імпортувати XML»). Деталь: {raw}"
    )
}

/// Один GET до Flex-сервісу. Токен їде лише як query-параметр, а всі
/// тексти помилок зачищаються від нього через net_err().
async fn get(path: &str, token: &str, q: &str) -> Result<String, String> {
    let c = client()?;
    let mut tries = 0;
    loop {
        tries += 1;
        let r = c
            .get(format!("{BASE}/{path}"))
            // query(), а не format!() — токен ще й коректно екранується
            .query(&[("t", token), ("q", q), ("v", "3")])
            .send()
            .await;
        match r {
            Ok(resp) => {
                let code = resp.status().as_u16();
                if code == 200 {
                    return resp.text().await.map_err(net_err);
                }
                // 5xx в IB трапляється на нічних вікнах обслуговування —
                // варте кількох повторів, а не одразу помилки користувачу
                if code >= 500 && tries < 3 {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
                return Err(format!("IBKR відповів кодом {code}"));
            }
            Err(e) => {
                if tries < 3 {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
                return Err(net_err(e));
            }
        }
    }
}

/// Людський переклад кодів помилок Flex-сервісу. Оригінальні тексти IB
/// («Statement is not available» тощо) користувачу ні про що не кажуть.
fn human(code: &str, _message: &str) -> String {
    match code {
        "1003" => "Звіт недоступний — перевірте Query ID".into(),
        "1012" | "1013" | "1015" => {
            "Токен недійсний або прострочений — згенеруйте новий у Client Portal".into()
        }
        "1014" => "Query ID не знайдено — перевірте число зі списку Flex Queries".into(),
        "1020" => "IBKR відхилив запит — перевірте токен і Query ID".into(),
        // Сімʼя transient() сюди зазвичай не доходить (її повторюємо
        // самі), але якщо ретраї вичерпано — кажемо чесно й людяно.
        c if transient(c) => "IBKR зараз не може зібрати звіт — тимчасове, спробуйте за кілька хвилин".into(),
        // Навіть ErrorCode може містити довільний текст із токеном.
        _ => "IBKR відхилив запит — перевірте налаштування або спробуйте пізніше".into(),
    }
}

/// Крок 1: попросити IB зібрати звіт. Повертає ReferenceCode, за яким
/// його потім забирати. Тимчасові відмови повторюємо самі: «Please try
/// again shortly» — це інструкція нам, а не текст для користувача.
async fn send_request(token: &str, query_id: &str) -> Result<String, String> {
    let mut tries = 0;
    loop {
        tries += 1;
        let body = get("FlexStatementService.SendRequest", token, query_id).await?;
        let status = xml_tag(&body, "Status").unwrap_or_default();
        if status == "Success" {
            return xml_tag(&body, "ReferenceCode")
                .ok_or_else(|| "IBKR підтвердив запит, але не дав коду звіту".to_string());
        }
        // Status=Fail або Warn — далі має бути пара ErrorCode/ErrorMessage
        let code = xml_tag(&body, "ErrorCode").unwrap_or_default();
        let msg = xml_tag(&body, "ErrorMessage").unwrap_or_default();
        /* «Too many failed attempts» — IB тимчасово прикрив Flex-сервіс за
           серію невдач. Блокування діє на РАХУНОК, а не на токен: свіжий
           токен його не знімає (реальний випадок — людина перегенерувала
           токен і одразу впіймала ту саму відмову). Кожна нова спроба
           продовжує таймер, тому виходимо одразу. Текст «заблокував
           Flex-сервіс» — маркер: ibkr_set по ньому зберігає токен попри
           невдалу перевірку. */
        if msg.contains("Too many failed") {
            return Err("IBKR тимчасово заблокував Flex-сервіс після серії невдалих \
                        спроб. Блокування діє на рахунок, тож новий токен його не \
                        знімає, а кожна нова спроба запускає таймер заново. Зачекайте \
                        годину, НІЧОГО не натискаючи, і спробуйте «Оновити зараз» один \
                        раз — або тягніть звіт без веб-сервісу: у порталі Run на вашому \
                        query → збережіть XML → кнопка «Імпортувати XML».".into());
        }
        if transient(&code) && tries < 6 {
            tokio::time::sleep(Duration::from_secs(15)).await;
            continue;
        }
        if code.is_empty() && msg.is_empty() {
            // Ні статусу, ні помилки — швидше за все, HTML від проксі чи
            // сторінка обслуговування замість XML
            return Err("IBKR відповів незрозуміло — спробуйте пізніше".into());
        }
        return Err(human(&code, &msg));
    }
}

/// Перевірка токена і Query ID: робимо SendRequest і чекаємо ReferenceCode.
/// Якщо IB його дав — токен живий і query існує. Сам звіт не тягнемо:
/// для перевірки налаштувань це зайві пів хвилини очікування.
pub async fn check(token: &str, query_id: &str) -> Result<(), String> {
    send_request(token, query_id).await.map(|_| ())
}

/// Повний цикл: замовити звіт і дочекатись готового XML.
/// Повертає СИРИЙ XML як рядок — розбір на боці фронтенду.
pub async fn fetch(token: &str, query_id: &str) -> Result<String, String> {
    let reference = send_request(token, query_id).await?;

    tokio::time::sleep(Duration::from_secs(FIRST_WAIT)).await;

    let mut tries = 0;
    loop {
        tries += 1;
        let body = get("FlexStatementService.GetStatement", token, &reference).await?;

        // Готовий звіт — це XML з коренем FlexQueryResponse. Перевіряємо
        // саме його: службові відповіді з помилками мають інший корінь,
        // і віддати їх фронтенду як «звіт» означало б тихо зламати розбір.
        if body.contains("<FlexQueryResponse") {
            return Ok(body);
        }

        let code = xml_tag(&body, "ErrorCode").unwrap_or_default();
        // «Ще формується» і вся рідня «зайдіть пізніше» — чекаємо далі
        if transient(&code) {
            if tries >= MAX_TRIES {
                return Err(
                    "IBKR збирає звіт довше трьох хвилин. Це минеться саме — спробуйте ще раз за кілька хвилин."
                        .into(),
                );
            }
            tokio::time::sleep(Duration::from_secs(RETRY_WAIT)).await;
            continue;
        }
        if !code.is_empty() {
            let msg = xml_tag(&body, "ErrorMessage").unwrap_or_default();
            return Err(human(&code, &msg));
        }
        // Не звіт і не помилка — таке буває, коли замість сервісу
        // відповіла сторінка обслуговування
        return Err("IBKR віддав не звіт — спробуйте за кілька хвилин".into());
    }
}

#[cfg(test)]
mod privacy_tests {
    use super::*;

    #[test]
    fn server_error_does_not_echo_credentials() {
        let secret = "synthetic-secret%2F%3F";
        assert!(!human("9999", secret).contains(secret));
        assert!(!human(secret, "").contains(secret));
    }

    #[tokio::test]
    async fn encoded_query_credentials_are_removed_from_transport_errors() {
        // HTTPS-only завершує запит локально: жодного DNS або HTTP до сервера.
        let err = client().unwrap().get("http://example.invalid/flex")
            .query(&[("t", "synthetic secret/?&="), ("q", "synthetic-query")])
            .send().await.unwrap_err();
        assert!(err.url().is_some());
        assert!(err.to_string().contains("synthetic"));
        let message = net_err(err);
        assert!(!message.contains("synthetic"));
        assert!(!message.contains("example.invalid"));
        assert!(!message.contains("t="));
    }
}
