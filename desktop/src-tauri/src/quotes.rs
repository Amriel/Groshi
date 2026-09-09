//! Котирування акцій — Yahoo Finance chart API.
//!
//! ЧОМУ YAHOO
//! Flex-звіт IBKR дає ціну лише на день формування — «динаміка за
//! сьогодні» з нього неможлива. Офіційні фіди котирувань платні або
//! вимагають ключів; chart-endpoint Yahoo відкритий, без ключа, і крім
//! поточної ціни віддає РІК денних закрить одним запитом — рівно те,
//! що треба для спарклайнів, денної зміни і бенчмарку. Це неофіційний
//! API: якщо колись зникне — вкладка просто повернеться до цін зі
//! звіту, нічого не зламається (фронтенд так і влаштований).
//!
//! СИМВОЛИ
//! Тікери поза США Yahoo тримає з суфіксом біржі: HY9H на Франкфурті —
//! «HY9H.F». Тому кожен символ приходить із біржею лістингу з Flex, і
//! ми пробуємо кандидатів по черзі, а вдалий варіант повертаємо у
//! відповіді — фронтенд закешує і наступного разу вгадувати не треба.

use serde_json::{json, Map, Value};
use std::time::Duration;

/// Дані з імпорту й кешу не повинні ставати шляхом або додатковим query.
/// Крапки, дефіси, ^ та = потрібні справжнім символам Yahoo.
fn valid_symbol(symbol: &str) -> bool {
    !symbol.is_empty() && symbol.len() <= 64
        && symbol.bytes().any(|b| b.is_ascii_alphanumeric())
        && symbol.bytes().all(|b| b.is_ascii_alphanumeric() || b".-^=".contains(&b))
}

fn valid_exchange(exchange: &str) -> bool {
    exchange.len() <= 32
        && exchange.bytes().all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
}

fn valid_domain(domain: &str) -> bool {
    domain.len() <= 253 && domain.contains('.') && domain.split('.').all(|label| {
        !label.is_empty() && label.len() <= 63
            && label.as_bytes()[0].is_ascii_alphanumeric()
            && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
            && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

fn valid_range(range: &str) -> bool {
    matches!(range, "1d" | "5d" | "1mo" | "6mo" | "1y" | "5y")
}

fn valid_headline(text: &str) -> bool {
    !text.is_empty() && text.len() <= 2000 && !text.chars().any(char::is_control)
}

fn require_symbol(symbol: &str) -> Result<(), String> {
    if valid_symbol(symbol) { Ok(()) } else { Err("Некоректний символ паперу".into()) }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Перенаправлення можуть віддати токени іншому вузлу; API мають фіксовані адреси.
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .timeout(Duration::from_secs(20))
        // Без браузерного User-Agent Yahoo відповідає 429/403.
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Groshi/1.0")
        .build()
        .map_err(|e| e.without_url().to_string())
}

/// Кандидати Yahoo-символа за біржею лістингу IBKR.
fn candidates(sym: &str, exch: &str) -> Vec<String> {
    let e = exch.to_uppercase();
    let s = sym.to_string();
    match e.as_str() {
        // Європа
        x if x.starts_with("FWB") => vec![format!("{s}.F"), format!("{s}.DE"), s],
        "IBIS" | "IBIS2" | "XETRA" => vec![format!("{s}.DE"), format!("{s}.F"), s],
        "LSE" | "LSEETF" => vec![format!("{s}.L"), s],
        "AEB" => vec![format!("{s}.AS"), s],
        "SBF" => vec![format!("{s}.PA"), s],
        "EBS" | "VIRTX" => vec![format!("{s}.SW"), s],
        "BM" | "BVME" | "BVME.ETF" => vec![format!("{s}.MI"), s],
        "WSE" => vec![format!("{s}.WA"), s],
        // США й усе інше — як є
        _ => vec![s],
    }
}

/// Пара range/interval для chart-endpoint: внутрішньоденні дані Yahoo
/// віддає лише короткими вікнами, тижневі свічки — для пʼяти років.
pub fn granularity(range: &str) -> (&'static str, &'static str) {
    match range {
        "1d" => ("1d", "5m"),
        "5d" => ("5d", "15m"),
        "1mo" => ("1mo", "1d"),
        "6mo" => ("6mo", "1d"),
        "5y" => ("5y", "1wk"),
        _ => ("1y", "1d"),
    }
}

async fn chart_at(c: &reqwest::Client, ysym: &str, range: &str, interval: &str, with_time: bool) -> Option<Value> {
    if !valid_symbol(ysym) || !valid_range(range) || !matches!(interval, "5m" | "15m" | "1d" | "1wk") {
        return None;
    }
    let url = format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{ysym}?range={range}&interval={interval}"
    );
    let r = c.get(&url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let v: Value = r.json().await.ok()?;
    let res = v.get("chart")?.get("result")?.get(0)?.clone();
    let meta = res.get("meta")?;
    let price = meta.get("regularMarketPrice").and_then(|x| x.as_f64())?;
    /* ПАСТКА: chartPreviousClose — це закриття перед ПОЧАТКОМ ДІАПАЗОНУ.
       Для range=1y це ціна рік тому, і «зміна за сьогодні» з неї давала
       +548% (реальний випадок). Вчорашнє закриття надійно береться з
       самого ряду: якщо останній стовпчик — сьогоднішній торговий день,
       то передостанній і є вчора. regularMarketPreviousClose беремо,
       коли він є, — він завжди про вчора. */
    let prev_meta = meta
        .get("regularMarketPreviousClose")
        .and_then(|x| x.as_f64());
    let ts: Vec<i64> = res
        .get("timestamp")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|t| t.as_i64()).collect())
        .unwrap_or_default();
    let closes: Vec<Value> = res
        .get("indicators")?
        .get("quote")?
        .get(0)?
        .get("close")?
        .as_array()?
        .clone();
    // дати як YYYY-MM-DD (для внутрішньоденних — з часом HH:MM);
    // null-закриття (вихідні, перерви біржі) пропускаємо
    let mut dates = Vec::new();
    let mut vals = Vec::new();
    for (i, t) in ts.iter().enumerate() {
        if let Some(v) = closes.get(i).and_then(|x| x.as_f64()) {
            let d = if with_time { chrono_datetime(*t) } else { chrono_date(*t) };
            dates.push(json!(d));
            vals.push(json!((v * 10000.0).round() / 10000.0));
        }
    }
    // вчорашнє закриття: пріоритет — regularMarketPreviousClose; інакше
    // з ряду: остання точка сьогоднішня → передостання, інакше остання
    let prev = prev_meta.or_else(|| {
        let n = vals.len();
        if n < 2 { return None; }
        let last_ts = *ts.last()?;
        let mkt_ts = meta.get("regularMarketTime").and_then(|x| x.as_i64()).unwrap_or(last_ts);
        let same_day = chrono_date(last_ts) == chrono_date(mkt_ts);
        if same_day { vals[n - 2].as_f64() } else { vals[n - 1].as_f64() }
    });
    /* факти про папір: усе, що meta знає, — опційно; чого нема, того
       просто не буде в картці, без помилок */
    let f = |k: &str| meta.get(k).and_then(|x| x.as_f64());
    let s = |k: &str| meta.get(k).and_then(|x| x.as_str()).map(String::from);
    Some(json!({
        "price": price,
        "prev": prev,
        "ccy": meta.get("currency").and_then(|x| x.as_str()).unwrap_or(""),
        "name": s("longName").or_else(|| s("shortName")),
        "exchName": s("fullExchangeName").or_else(|| s("exchangeName")),
        "dayHigh": f("regularMarketDayHigh"),
        "dayLow": f("regularMarketDayLow"),
        "w52High": f("fiftyTwoWeekHigh"),
        "w52Low": f("fiftyTwoWeekLow"),
        "volume": f("regularMarketVolume"),
        "dates": dates,
        "closes": vals,
    }))
}

async fn chart(c: &reqwest::Client, ysym: &str) -> Option<Value> {
    chart_at(c, ysym, "1y", "1d", false).await
}

/// Сьогоднішній рух для НАБОРУ паперів: 5-хвилинні закриття кожного.
/// З них фронтенд складає внутрішньоденну лінію портфеля — NAV з IBKR
/// денний, «динаміку за сьогодні» з нього не зібрати.
pub async fn today(list: Vec<(String, String)>) -> Result<Value, String> {
    for (sym, ysym) in &list {
        require_symbol(sym)?;
        require_symbol(ysym)?;
    }
    let c = client()?;
    let mut out = Map::new();
    for (sym, ysym) in list {
        if let Some(v) = chart_at(&c, &ysym, "1d", "5m", true).await {
            out.insert(sym, json!({
                "dates": v["dates"], "closes": v["closes"],
                "prev": v["prev"], "price": v["price"],
            }));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(json!({
        "quotes": Value::Object(out),
        "fetched": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    }))
}

/// Один папір, один діапазон — для картки акції з перемикачем періодів.
pub async fn detail(ysym: &str, range: &str) -> Result<Value, String> {
    require_symbol(ysym)?;
    if !valid_range(range) { return Err("Некоректний період котирувань".into()); }
    let c = client()?;
    let (r, i) = granularity(range);
    let with_time = r == "1d" || r == "5d";
    chart_at(&c, ysym, r, i, with_time)
        .await
        .map(|mut v| { v["range"] = json!(r); v })
        .ok_or_else(|| "Yahoo не віддав дані за цей період".into())
}

/// Новини за тікером: RSS Yahoo Finance. Розбір навмисно нехитрий —
/// регулярка по <item>: тягнути XML-парсер заради трьох полів зайве.
/// Переклад заголовка українською — відкритий endpoint Google Translate
/// (client=gtx), без ключів. Суворо best-effort: не вийшло — лишається
/// оригінал, жодних помилок користувачу.
async fn tr_uk(c: &reqwest::Client, text: &str) -> Option<String> {
    if !valid_headline(text) { return None; }
    let r = c
        .get("https://translate.googleapis.com/translate_a/single")
        .query(&[("client", "gtx"), ("sl", "en"), ("tl", "uk"), ("dt", "t"), ("q", text)])
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let v: Value = r.json().await.ok()?;
    let mut out = String::new();
    for seg in v.get(0)?.as_array()? {
        if let Some(sg) = seg.get(0).and_then(|x| x.as_str()) {
            out.push_str(sg);
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() { None } else { Some(out) }
}

/// Запасний перекладач: MyMemory (теж без ключа). Google з деяких
/// мереж відповідає капчею — тоді пробуємо тут; не вийшло і тут —
/// заголовок чесно лишається англійським.
async fn tr_uk2(c: &reqwest::Client, text: &str) -> Option<String> {
    if !valid_headline(text) { return None; }
    let r = c
        .get("https://api.mymemory.translated.net/get")
        .query(&[("q", text), ("langpair", "en|uk")])
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let v: Value = r.json().await.ok()?;
    let t = v.get("responseData")?.get("translatedText")?.as_str()?.trim().to_string();
    if t.is_empty() || t.eq_ignore_ascii_case(text) { None } else { Some(t) }
}

pub async fn news(ysym: &str, uk: bool) -> Result<Value, String> {
    require_symbol(ysym)?;
    let c = client()?;
    let r = c.get("https://feeds.finance.yahoo.com/rss/2.0/headline")
        .query(&[("s", ysym), ("region", "US"), ("lang", "en-US")])
        .send().await.map_err(|e| format!("мережа: {}", e.without_url()))?;
    if !r.status().is_success() {
        return Err(format!("Yahoo відповів {}", r.status().as_u16()));
    }
    let body = r.text().await.map_err(|e| e.without_url().to_string())?;
    let mut items = Vec::new();
    for chunk in body.split("<item>").skip(1).take(8) {
        let tag = |t: &str| -> Option<String> {
            let open = format!("<{t}>");
            let close = format!("</{t}>");
            let a = chunk.find(&open)? + open.len();
            let b = a + chunk[a..].find(&close)?;
            let raw = chunk[a..b].trim();
            let raw = raw.strip_prefix("<![CDATA[").and_then(|x| x.strip_suffix("]]>")).unwrap_or(raw);
            Some(raw.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                .replace("&#39;", "'").replace("&quot;", "\""))
        };
        if let (Some(title), Some(link)) = (tag("title"), tag("link")) {
            items.push(json!({
                "title": title,
                "link": link,
                "when": tag("pubDate").unwrap_or_default(),
            }));
        }
    }
    if items.is_empty() {
        return Err("Стрічка новин порожня".into());
    }
    if uk {
        for it in items.iter_mut() {
            if let Some(t) = it.get("title").and_then(|x| x.as_str()).map(String::from) {
                let tr = match tr_uk(&c, &t).await {
                    Some(x) => Some(x),
                    None => tr_uk2(&c, &t).await,
                };
                if let Some(tr) = tr {
                    it["titleUk"] = json!(tr);
                }
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
        }
    }
    Ok(json!(items))
}

/// UNIX-секунди → YYYY-MM-DD HH:MM (UTC; для внутрішньоденного графіка
/// зсув пояса не критичний — важлива форма дня, не хвилина).
fn chrono_datetime(ts: i64) -> String {
    let d = chrono_date(ts);
    let sec = ts.rem_euclid(86400);
    format!("{} {:02}:{:02}", d, sec / 3600, (sec % 3600) / 60)
}

/// UNIX-секунди → YYYY-MM-DD без зовнішніх залежностей.
pub fn chrono_date(ts: i64) -> String {
    let days = ts / 86400;
    // алгоритм civil_from_days (Howard Hinnant), достатній до 2100 року
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Профіль компанії — quoteSummary одним запитом: сектор і домен сайту
/// (assetProfile), фундаментал P/E, капіталізація, дивідендна ставка й
/// дохідність (summaryDetail), EPS (defaultKeyStatistics), дати
/// найближчого дивіденду (calendarEvents). Ендпоінт вередливіший за
/// chart (інколи хоче crumb-підпис) — тому суворо best-effort: не
/// вийшло — цих полів просто не буде, картка їх не покаже.
async fn profile(c: &reqwest::Client, ysym: &str) -> Option<Value> {
    if !valid_symbol(ysym) { return None; }
    let url = format!(
        "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{ysym}\
         ?modules=assetProfile,summaryDetail,defaultKeyStatistics,calendarEvents"
    );
    let r = c.get(&url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let v: Value = r.json().await.ok()?;
    let res = v.get("quoteSummary")?.get("result")?.get(0)?.clone();
    let ap = res.get("assetProfile");
    let sd = res.get("summaryDetail");
    let ks = res.get("defaultKeyStatistics");
    let ce = res.get("calendarEvents");
    // Числа Yahoo загортає в {raw, fmt} — тягнемо raw; голе число теж приймаємо
    let num = |m: Option<&Value>, k: &str| -> Option<f64> {
        let f = m?.get(k)?;
        f.as_f64().or_else(|| f.get("raw").and_then(|x| x.as_f64()))
    };
    let sector = ap
        .and_then(|x| x.get("sector"))
        .and_then(|x| x.as_str())
        .map(String::from);
    // «https://www.microsoft.com/uk-ua» → «microsoft.com»
    let domain = ap
        .and_then(|x| x.get("website"))
        .and_then(|x| x.as_str())
        .map(|w| {
            let w = w.trim_start_matches("https://").trim_start_matches("http://");
            let w = w.strip_prefix("www.").unwrap_or(w);
            w.split('/').next().unwrap_or(w).to_lowercase()
        })
        .filter(|d| valid_domain(d));
    let mut out = Map::new();
    if let Some(s) = sector { out.insert("sector".into(), json!(s)); }
    if let Some(d) = domain { out.insert("domain".into(), json!(d)); }
    if let Some(x) = num(sd, "trailingPE") { out.insert("pe".into(), json!(x)); }
    if let Some(x) = num(sd, "marketCap") { out.insert("cap".into(), json!(x)); }
    if let Some(x) = num(sd, "dividendRate") { out.insert("divRate".into(), json!(x)); }
    if let Some(x) = num(sd, "dividendYield") { out.insert("divYield".into(), json!(x)); }
    if let Some(x) = num(ks, "trailingEps") { out.insert("eps".into(), json!(x)); }
    // дата виплати і екс-дивідендна дата — UNIX-секунди → YYYY-MM-DD
    if let Some(x) = num(ce, "exDividendDate") {
        out.insert("exDate".into(), json!(chrono_date(x as i64)));
    }
    let dd = ce.and_then(|x| x.get("dividendDate"));
    if let Some(x) = dd.and_then(|f| f.as_f64().or_else(|| f.get("raw").and_then(|r| r.as_f64()))) {
        out.insert("payDate".into(), json!(chrono_date(x as i64)));
    }
    Some(Value::Object(out))
}

/// Логотип позиції. Перша версія покладалась на Clearbit — а його
/// безкоштовний Logo API після продажу HubSpot помер, і всі позиції
/// отримували монограми (реальний випадок). Тепер ланцюжок джерел без
/// ключів, ПО ТІКЕРУ насамперед (домен не потрібен): CDN Parqet →
/// набір іконок nvstly на GitHub → (за доменом) Clearbit, раптом
/// оживе → favicon-сервіс Google. Для крипти — свої набори іконок.
/// Байти повертаються data-URL-ом: кеш logos.json працює без мережі.
async fn logo_bytes(c: &reqwest::Client, sym: &str, domain: Option<&str>, kind: &str) -> Option<String> {
    if !valid_symbol(sym) || domain.map(|d| !valid_domain(d)).unwrap_or(false) {
        return None;
    }
    let mut urls: Vec<String> = Vec::new();
    if kind == "crypto" {
        let l = sym.to_lowercase();
        urls.push(format!(
            "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/{l}.png"
        ));
        urls.push(format!(
            "https://raw.githubusercontent.com/nvstly/icons/main/crypto_icons/{}.png",
            sym.to_uppercase()
        ));
    } else {
        let u = sym.to_uppercase();
        urls.push(format!("https://assets.parqet.com/logos/symbol/{u}?format=png&size=100"));
        urls.push(format!(
            "https://raw.githubusercontent.com/nvstly/icons/main/ticker_icons/{u}.png"
        ));
        if let Some(d) = domain {
            urls.push(format!("https://logo.clearbit.com/{d}?size=64"));
            urls.push(format!("https://www.google.com/s2/favicons?domain={d}&sz=64"));
        }
    }
    for url in urls {
        let Ok(r) = c.get(&url).send().await else { continue };
        if !r.status().is_success() {
            continue;
        }
        let mime = r
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("image/png")
            .split(';')
            .next()
            .unwrap_or("image/png")
            .to_string();
        if !mime.starts_with("image/") {
            continue;
        }
        let Ok(b) = r.bytes().await else { continue };
        /* Поріг розміру — різний за джерелом: Parqet і GitHub на
           відсутній тікер чесно віддають 404, тож там досить відсіяти
           огризки (реальний логотип MU — 496 байтів, і плоский поріг
           у 500 його викидав). А favicon-сервіс Google на невідомий
           домен віддає «глобус» ~кілобайт — тому там поріг вищий. */
        let min = if url.contains("google.com/s2") { 700 } else { 120 };
        if b.len() < min {
            continue;
        }
        return Some(format!("data:{mime};base64,{}", b64(&b)));
    }
    None
}

/// Логотипи для набору (symbol, domain?, kind): {sym: dataURL | false}.
/// false — «шукали, не знайшли»: щоб не стукати в мережу щозапуску.
pub async fn logos(list: Vec<(String, Option<String>, String)>) -> Value {
    let Ok(c) = client() else { return json!({}) };
    let mut out = Map::new();
    for (sym, domain, kind) in list {
        match logo_bytes(&c, &sym, domain.as_deref(), &kind).await {
            Some(url) => out.insert(sym, json!(url)),
            None => out.insert(sym, json!(false)),
        };
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Value::Object(out)
}

/// base64 без зовнішнього крейта: 20 рядків проти ще однієї залежності.
pub fn b64(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity((data.len() + 2) / 3 * 4);
    for ch in data.chunks(3) {
        let b = [ch[0], *ch.get(1).unwrap_or(&0), *ch.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        s.push(A[(n >> 18 & 63) as usize] as char);
        s.push(A[(n >> 12 & 63) as usize] as char);
        s.push(if ch.len() > 1 { A[(n >> 6 & 63) as usize] as char } else { '=' });
        s.push(if ch.len() > 2 { A[(n & 63) as usize] as char } else { '=' });
    }
    s
}

/// Тягне історію для набору (symbol, exch, cachedYahoo?) послідовно з
/// короткою паузою: Yahoo не любить черги паралельних запитів з одного IP.
pub async fn fetch(list: Vec<(String, String, Option<String>)>) -> Result<Value, String> {
    // Перевіряємо весь пакет до першого запиту, щоб помилка не дала часткового витоку.
    for (sym, exch, cached) in &list {
        require_symbol(sym)?;
        if !valid_exchange(exch) { return Err("Некоректне позначення біржі".into()); }
        if let Some(ysym) = cached { require_symbol(ysym)?; }
    }
    let c = client()?;
    let mut out = Map::new();
    let mut misses = Vec::new();
    for (sym, exch, cached) in list {
        let mut cands = Vec::new();
        if let Some(y) = cached {
            cands.push(y);
        }
        for c in candidates(&sym, &exch) {
            if !cands.contains(&c) {
                cands.push(c);
            }
        }
        let mut got = None;
        for ysym in &cands {
            if let Some(mut v) = chart(&c, ysym).await {
                v["ysym"] = json!(ysym);
                got = Some(v);
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        match got {
            Some(mut v) => {
                if let Some(ys) = v.get("ysym").and_then(|x| x.as_str()).map(String::from) {
                    if let Some(Value::Object(p)) = profile(&c, &ys).await {
                        for (k, val) in p {
                            v[k] = val;
                        }
                    }
                }
                out.insert(sym, v);
            }
            None => misses.push(sym),
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Ok(json!({
        "quotes": Value::Object(out),
        "misses": misses,
        "fetched": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    }))
}

#[cfg(test)]
mod privacy_tests {
    use super::*;

    #[test]
    fn market_symbols_keep_yahoo_punctuation() {
        for symbol in ["BRK.B", "BRK-B", "^GSPC", "EURUSD=X", "BTC-USD", "HY9H.F", "0700.HK"] {
            assert!(valid_symbol(symbol), "{symbol}");
        }
    }

    #[test]
    fn symbols_reject_url_injection_and_unbounded_data() {
        for symbol in ["", ".", "..", "AAPL/../../x", "AAPL?secret=x", "AAPL&secret=x", "AAPL#x", "AAPL%2Fx", "AAPL\\x", "AAPL\n", " AAPL", "AAPL ", "таємниця"] {
            assert!(!valid_symbol(symbol), "{symbol:?}");
        }
        assert!(!valid_symbol(&"A".repeat(65)));
        assert!(!valid_exchange("NASDAQ&secret=x"));
        assert!(valid_exchange("BVME.ETF"));
        assert!(valid_exchange(""));
    }

    #[test]
    fn logo_domains_are_only_bounded_dns_names() {
        for domain in ["microsoft.com", "investor.example.co.uk", "xn--example-test.com"] {
            assert!(valid_domain(domain));
        }
        for domain in ["", "localhost", "https://example.com", "example.com/path", "example.com?secret=x", "example.com#x", "user@example.com", "example.com:443", "-example.com", "example-.com", "example..com", "example.com.", "example.com\n"] {
            assert!(!valid_domain(domain), "{domain:?}");
        }
        assert!(!valid_domain(&format!("{}.com", "a".repeat(64))));
    }

    #[test]
    fn query_values_reject_silent_rewriting() {
        assert!(valid_range("1y"));
        assert!(!valid_range("1y&secret=x"));
        assert!(!valid_range("unknown"));
        assert!(valid_headline("Company A & B: earnings rise 5%"));
        assert!(!valid_headline("Headline\nsecret"));
        assert!(!valid_headline(&"x".repeat(2001)));
    }

    #[tokio::test]
    async fn invalid_market_input_fails_before_network() {
        assert!(detail("AAPL?secret=x", "1y").await.is_err());
        assert!(detail("AAPL", "unknown").await.is_err());
        assert!(news("AAPL&secret=x", false).await.is_err());
        assert!(today(vec![("AAPL".into(), "AAPL/../../x".into())]).await.is_err());
        assert!(fetch(vec![("AAPL".into(), "NASDAQ".into(), Some("AAPL?secret=x".into()))]).await.is_err());
        let c = client().unwrap();
        assert!(logo_bytes(&c, "AAPL", Some("example.com?secret=x"), "stock").await.is_none());
    }
}
