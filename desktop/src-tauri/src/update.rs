//! Оновлення застосунку.
//!
//! ЧОМУ НЕ ШТАТНИЙ tauri-plugin-updater
//! Він вимагає підписаних збірок і власного сервера з маніфестом та
//! ключами. Нічого з цього тут немає й не планується. Натомість збірки
//! лежать у Релізах GitHub — їх туди кладе сам GitHub Actions за тегом.
//!
//! Джерелом може бути що завгодно з трьох, і воно розпізнається за
//! виглядом рядка:
//!   1. **репозиторій GitHub** — `github:owner/repo` або просто адреса
//!      `https://github.com/owner/repo`. Питаємо Releases API про
//!      останній НЕчерновий випуск і беремо з нього `.exe`. Це основний
//!      шлях і значення за замовчуванням.
//!   2. **HTTPS-адреса з `latest.json`** — для власного дзеркала.
//!   3. **тека** (локальна чи мережева) — для збірок «з рук» і для
//!      роботи без інтернету. Спершу `latest.json`, а як його немає —
//!      сканування за іменами `*Setup*<версія>.exe`: рятує від
//!      найпоширенішої помилки, коли новий exe поклали, а маніфест
//!      забули оновити.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
pub struct Found {
    pub available: bool,
    pub current: String,
    pub version: String,
    pub notes: String,
    pub file: String,   // імʼя файлу або повний URL
    pub source: String, // де знайшли
}

pub fn current() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Порівняння версій за числами, а не рядком: "1.10.0" більша за "1.9.0",
/// хоча як текст — менша.
pub fn newer(a: &str, b: &str) -> bool {
    let p = |s: &str| -> Vec<u32> {
        s.split(|c: char| !c.is_ascii_digit())
            .filter(|x| !x.is_empty())
            .filter_map(|x| x.parse().ok())
            .collect()
    };
    let (x, y) = (p(a), p(b));
    for i in 0..x.len().max(y.len()) {
        let (u, v) = (*x.get(i).unwrap_or(&0), *y.get(i).unwrap_or(&0));
        if u != v {
            return u > v;
        }
    }
    false
}

/// Витягнути версію з імені файлу: Groshi_Setup_1.2.0.exe, Гроші_1.2.0_x64-setup.exe
fn ver_from_name(name: &str) -> Option<String> {
    let low = name.to_lowercase();
    if !low.ends_with(".exe") || !low.contains("setup") {
        return None;
    }
    let mut best: Option<String> = None;
    let bytes: Vec<char> = name.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == '.') {
                i += 1;
            }
            let s: String = bytes[start..i].iter().collect();
            let s = s.trim_matches('.').to_string();
            if s.contains('.') && s.split('.').count() >= 2 {
                if best.as_ref().map(|b| newer(&s, b)).unwrap_or(true) {
                    best = Some(s);
                }
            }
        } else {
            i += 1;
        }
    }
    best
}

fn from_manifest(txt: &str, source: &str) -> Option<Found> {
    let v: serde_json::Value = serde_json::from_str(txt).ok()?;
    let version = v.get("version")?.as_str()?.to_string();
    let file = v.get("file").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let notes = v.get("notes").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let cur = current();
    Some(Found {
        available: newer(&version, &cur),
        current: cur,
        version,
        notes,
        file,
        source: source.to_string(),
    })
}

/// GitHub-джерело: `github:owner/repo`, `https://github.com/owner/repo`
/// (з `.git`, `/releases`, `/releases/latest` чи без) або вже готовий
/// `https://api.github.com/repos/owner/repo`. Повертає (owner, repo).
fn gh_repo(src: &str) -> Option<(String, String)> {
    let s = src.trim().trim_end_matches('/');
    let rest = if let Some(r) = s.strip_prefix("github:") {
        r
    } else if let Some(r) = s.strip_prefix("https://api.github.com/repos/") {
        r
    } else if let Some(r) = s.strip_prefix("https://github.com/") {
        r
    } else if let Some(r) = s.strip_prefix("http://github.com/") {
        r
    } else if let Some(r) = s.strip_prefix("github.com/") {
        r
    } else {
        return None;
    };
    let mut it = rest.split('/');
    let owner = it.next()?.trim();
    let repo = it.next()?.trim().trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// GitHub відмовляє запитам без User-Agent (403), тому клієнт спільний
/// і завжди підписаний. Таймаут окремий: перевірка має або відповісти,
/// або чесно сказати «мережа», а не висіти.
fn http(secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Groshi/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(secs))
        .build()
        .map_err(|e| e.to_string())
}

async fn gh_check(owner: &str, repo: &str) -> Result<Found, String> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
    let r = http(20)?
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("мережа: {e}"))?;
    /* 404 тут — це не поломка: так відповідає і репозиторій без жодного
       випуску, і приватний репозиторій без токена. Обидва випадки
       людина може виправити сама, тож кажемо про них словами. */
    if r.status().as_u16() == 404 {
        return Err(format!("У {owner}/{repo} ще немає жодного випуску"));
    }
    if !r.status().is_success() {
        return Err(format!("GitHub відповів {}", r.status().as_u16()));
    }
    let txt = r.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;

    let tag = v.get("tag_name").and_then(|x| x.as_str()).unwrap_or("");
    let version = tag.trim_start_matches(['v', 'V']).trim().to_string();
    if version.is_empty() {
        return Err("У випуску немає теґа з версією".into());
    }

    /* Інсталятор шукаємо серед вкладень. Збірка на GitHub Actions
       триває хвилин десять, і випуск деякий час існує ПОРОЖНІМ —
       без цієї гілки людина бачила б «є оновлення», яке не ставиться. */
    let file = v
        .get("assets")
        .and_then(|a| a.as_array())
        .and_then(|arr| {
            let exe = |x: &serde_json::Value| {
                x.get("name")
                    .and_then(|n| n.as_str())
                    .map(|n| n.to_lowercase().ends_with(".exe"))
                    .unwrap_or(false)
            };
            arr.iter()
                .find(|x| exe(x) && x.get("name").and_then(|n| n.as_str())
                    .map(|n| n.to_lowercase().contains("setup")).unwrap_or(false))
                .or_else(|| arr.iter().find(|x| exe(x)))
                .and_then(|x| x.get("browser_download_url"))
                .and_then(|u| u.as_str())
                .map(String::from)
        })
        .unwrap_or_default();
    if file.is_empty() {
        return Err(format!(
            "Випуск {version} є, але інсталятора в ньому ще немає — збірка триває, спробуйте за кілька хвилин"
        ));
    }

    let notes = v
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .chars()
        .take(600)
        .collect::<String>();
    let cur = current();
    Ok(Found {
        available: newer(&version, &cur),
        current: cur,
        version,
        notes,
        file,
        source: format!("github:{owner}/{repo}"),
    })
}

pub async fn check(source: &str) -> Result<Found, String> {
    let src = source.trim();
    if src.is_empty() {
        return Err("Джерело оновлень не задано".into());
    }

    if let Some((owner, repo)) = gh_repo(src) {
        return gh_check(&owner, &repo).await;
    }

    if src.starts_with("https://") || src.starts_with("http://") {
        let base = src.trim_end_matches('/');
        let url = if base.to_lowercase().ends_with(".json") {
            base.to_string()
        } else {
            format!("{base}/latest.json")
        };
        let r = http(20)?.get(&url).send().await.map_err(|e| format!("мережа: {e}"))?;
        if !r.status().is_success() {
            return Err(format!("{} відповів {}", url, r.status().as_u16()));
        }
        let txt = r.text().await.map_err(|e| e.to_string())?;
        return from_manifest(&txt, &url).ok_or_else(|| "latest.json не читається".to_string());
    }

    let dir = PathBuf::from(src);
    if !dir.is_dir() {
        return Err(format!("Теки «{src}» немає"));
    }

    let cur = current();

    /* 1) маніфест. Він НЕ останнє слово: поруч може лежати новіший
       інсталятор, а `latest.json` лишитись від позаминулої збірки —
       реальний випадок, у теці був 1.31.4, а маніфест казав 1.31.1, і
       апка чесно відповідала «уже найновіша». Тому маніфест і скан
       порівнюються, і виграє більша версія. */
    let man = dir.join("latest.json");
    let mut best: Option<Found> = None;
    if man.is_file() {
        if let Ok(txt) = fs::read_to_string(&man) {
            if let Some(mut f) = from_manifest(&txt, src) {
                // маніфест може брехати й про імʼя — перевіряємо, що файл є
                if f.file.is_empty() || !dir.join(&f.file).is_file() {
                    if let Some((name, _)) = scan(&dir) {
                        f.file = name;
                    }
                }
                if !f.file.is_empty() && dir.join(&f.file).is_file() {
                    best = Some(f);
                }
            }
        }
    }

    // 2) що насправді лежить у теці
    if let Some((name, ver)) = scan(&dir) {
        let take = best.as_ref().map(|b| newer(&ver, &b.version)).unwrap_or(true);
        if take {
            best = Some(Found {
                available: newer(&ver, &cur),
                current: cur.clone(),
                version: ver,
                notes: String::new(),
                file: name,
                source: src.to_string(),
            });
        }
    }
    if let Some(f) = best {
        return Ok(f);
    }
    Err("У теці немає інсталятора".into())
}

fn scan(dir: &Path) -> Option<(String, String)> {
    let mut best: Option<(String, String)> = None;
    for e in fs::read_dir(dir).ok()? {
        let e = match e {
            Ok(x) => x,
            Err(_) => continue,
        };
        let name = e.file_name().to_string_lossy().to_string();
        if let Some(v) = ver_from_name(&name) {
            if best.as_ref().map(|(_, b)| newer(&v, b)).unwrap_or(true) {
                best = Some((name, v));
            }
        }
    }
    best
}

/// Покласти інсталятор у тимчасову теку й запустити. Копія потрібна,
/// бо інсталятор може лежати на мережевому диску або на носії, який
/// зникне посеред установлення.
pub async fn fetch(source: &str, file: &str) -> Result<PathBuf, String> {
    /* `file` від GitHub — це повний URL вкладення, а не імʼя. Взяти
       його в імʼя тимчасового файлу не можна: у Windows двокрапка й
       скісні в імені заборонені, і запис падав би на рівному місці.
       Тому беремо тільки останній сегмент і чистимо решту. */
    let name: String = file
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("setup.exe")
        .chars()
        .map(|c| if c.is_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    let name = if name.is_empty() { "setup.exe".to_string() } else { name };
    let tmp = std::env::temp_dir().join(format!("groshi-update-{name}"));

    if file.starts_with("http") || source.starts_with("http") || gh_repo(source).is_some() {
        let url = if file.starts_with("http") {
            file.to_string()
        } else {
            format!("{}/{}", source.trim_end_matches('/'), file)
        };
        let r = http(300)?.get(&url).send().await.map_err(|e| format!("мережа: {e}"))?;
        if !r.status().is_success() {
            return Err(format!("не вдалося завантажити: {}", r.status().as_u16()));
        }
        let bytes = r.bytes().await.map_err(|e| e.to_string())?;
        fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    } else {
        let from = PathBuf::from(source).join(file);
        if !from.is_file() {
            return Err(format!("Файла «{file}» немає"));
        }
        fs::copy(&from, &tmp).map_err(|e| e.to_string())?;
    }
    Ok(tmp)
}
