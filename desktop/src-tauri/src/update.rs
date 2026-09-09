//! Підписані оновлення з GitHub, HTTPS-дзеркала або локальної теки.
//! Довіру встановлює вбудований ключ Ed25519: адреса джерела та HTTPS
//! самі по собі не дають права виконувати завантажені байти.

use ed25519_dalek::{Signature, VerifyingKey};
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_INSTALLER: usize = 100 * 1024 * 1024;
const MAX_SIGNATURE: usize = 256;
const MAX_MANIFEST: usize = 1024 * 1024;
const PUBLIC_KEY: &str = include_str!("../update-key.pub");

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

fn from_manifest(txt: &[u8], source: &str) -> Result<Found, String> {
    let v: serde_json::Value =
        serde_json::from_slice(txt).map_err(|_| "latest.json не читається")?;
    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or("У маніфесті немає версії")?
        .to_string();
    let file = v
        .get("file")
        .and_then(|x| x.as_str())
        .ok_or("У маніфесті немає інсталятора")?;
    let file = if source.starts_with("https://") {
        let url = if file.starts_with("https://") {
            https_url(file)?
        } else {
            safe_name(file)?;
            https_url(source)?
                .join(file)
                .map_err(|_| "Некоректна адреса інсталятора")?
        };
        url_name(&url)?;
        url.to_string()
    } else {
        safe_name(file)?;
        file.to_string()
    };
    let cur = current();
    Ok(Found {
        available: newer(&version, &cur),
        current: cur,
        version,
        notes: v
            .get("notes")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .chars()
            .take(600)
            .collect(),
        file,
        source: source.to_string(),
    })
}

// Двокрапка у Windows відкриває альтернативний потік, а зворотна скісна
// може втекти з теки навіть тоді, коли перевірка написана на іншій ОС.
fn safe_name(name: &str) -> Result<(), String> {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty()
        || name.len() > 240
        || !name.to_ascii_lowercase().ends_with(".exe")
        || name.starts_with('.')
        || name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:<>\"|?*%".contains(c))
        || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
    {
        return Err("Недопустиме імʼя інсталятора; потрібен окремий файл .exe".into());
    }
    Ok(())
}

fn https_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "Некоректна HTTPS-адреса")?;
    if !safe_https(&url) {
        return Err("Оновлення дозволені лише через HTTPS без облікових даних".into());
    }
    Ok(url)
}

fn safe_https(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn source_is_remote(src: &str) -> Result<bool, String> {
    if src.starts_with("https://") {
        https_url(src)?;
        return Ok(true);
    }
    if src.contains("://")
        || src.to_ascii_lowercase().starts_with("http:")
        || src.to_ascii_lowercase().starts_with("file:")
    {
        return Err("Використайте HTTPS-адресу або шлях до теки".into());
    }
    Ok(false)
}

fn gh_repo(src: &str) -> Option<(String, String)> {
    let rest = src
        .strip_prefix("github:")
        .or_else(|| src.strip_prefix("https://api.github.com/repos/"))
        .or_else(|| src.strip_prefix("https://github.com/"))
        .or_else(|| src.strip_prefix("github.com/"))?;
    let mut parts = rest.trim_end_matches('/').split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    let valid = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    };
    if valid(owner) && valid(repo) {
        Some((owner.into(), repo.into()))
    } else {
        None
    }
}

fn http(secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Groshi/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(secs))
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !safe_https(attempt.url()) {
                attempt.error("Небезпечне або надто довге перенаправлення оновлення")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

async fn response_bytes(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!("Сервер відповів {}", response.status().as_u16()));
    }
    if response
        .content_length()
        .map(|n| n > max as u64)
        .unwrap_or(false)
    {
        return Err("Файл оновлення перевищує дозволений розмір".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("мережа: {e}"))? {
        if chunk.len() > max.saturating_sub(bytes.len()) {
            return Err("Файл оновлення перевищує дозволений розмір".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn download(url: &reqwest::Url, max: usize) -> Result<Vec<u8>, String> {
    let response = http(300)?
        .get(url.clone())
        .send()
        .await
        .map_err(|e| format!("мережа: {e}"))?;
    response_bytes(response, max).await
}

fn manifest_url(source: &str) -> Result<reqwest::Url, String> {
    let mut url = https_url(source)?;
    if !url.path().to_ascii_lowercase().ends_with(".json") {
        url.set_path(&format!("{}/latest.json", url.path().trim_end_matches('/')));
    }
    Ok(url)
}

fn url_name(url: &reqwest::Url) -> Result<String, String> {
    let encoded = url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .ok_or("В адресі немає імені файлу")?;
    let name = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| "Імʼя інсталятора не є UTF-8")?
        .into_owned();
    safe_name(&name)?;
    Ok(name)
}

fn resolve_installer(source: &str, file: &str) -> Result<reqwest::Url, String> {
    let url = if file.starts_with("https://") {
        https_url(file)?
    } else {
        // URL::join нормалізує ../, тому перевірка відбувається до нього.
        safe_name(file)?;
        manifest_url(source)?
            .join(file)
            .map_err(|_| "Некоректна адреса інсталятора")?
    };
    url_name(&url)?;
    Ok(url)
}

fn signature_url(installer: &reqwest::Url) -> reqwest::Url {
    let mut url = installer.clone();
    url.set_path(&format!("{}.sig", installer.path()));
    url
}

fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| format!("Не вдалося прочитати файл: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Очікувався звичайний файл".into());
    }
    let mut bytes = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > max {
        return Err("Файл оновлення перевищує дозволений розмір".into());
    }
    Ok(bytes)
}

fn local_file(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let path = dir
        .join(name)
        .canonicalize()
        .map_err(|e| format!("Файла «{name}» немає: {e}"))?;
    if path.parent() != Some(dir.as_path()) {
        return Err("Файл оновлення виходить за межі теки".into());
    }
    Ok(path)
}

fn verify(bytes: &[u8], signature: &[u8], public_key: &str) -> Result<(), String> {
    let key: [u8; 32] = hex::decode(public_key.trim())
        .map_err(|_| "Пошкоджений ключ оновлень")?
        .try_into()
        .map_err(|_| "Пошкоджений ключ оновлень")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "Пошкоджений ключ оновлень")?;
    let text = std::str::from_utf8(signature).map_err(|_| "Пошкоджений підпис оновлення")?;
    let signature: [u8; 64] = hex::decode(text.trim())
        .map_err(|_| "Пошкоджений підпис оновлення")?
        .try_into()
        .map_err(|_| "Пошкоджений підпис оновлення")?;
    key.verify_strict(bytes, &Signature::from_bytes(&signature))
        .map_err(|_| "Підпис оновлення не підтверджено. Інсталятор не буде запущено".into())
}

async fn gh_check(owner: &str, repo: &str) -> Result<Found, String> {
    let url = https_url(&format!(
        "https://api.github.com/repos/{owner}/{repo}/releases/latest"
    ))?;
    let r = http(20)?
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("мережа: {e}"))?;
    if r.status().as_u16() == 404 {
        return Err(format!("У {owner}/{repo} ще немає жодного випуску"));
    }
    let bytes = response_bytes(r, MAX_MANIFEST).await?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let version = v
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_start_matches(['v', 'V'])
        .trim()
        .to_string();
    if version.is_empty() {
        return Err("У випуску немає теґа з версією".into());
    }
    let assets = v
        .get("assets")
        .and_then(|v| v.as_array())
        .ok_or("У випуску немає інсталятора")?;
    let signed_exe = |asset: &&serde_json::Value| {
        let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
        safe_name(name).is_ok()
            && assets.iter().any(|a| {
                a.get("name").and_then(|v| v.as_str()) == Some(format!("{name}.sig").as_str())
            })
    };
    let selected = assets
        .iter()
        .filter(signed_exe)
        .find(|a| {
            a.get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .contains("setup")
        })
        .or_else(|| assets.iter().find(signed_exe))
        .ok_or("У випуску ще немає інсталятора з підписом; спробуйте пізніше")?;
    let file = selected
        .get("browser_download_url")
        .and_then(|v| v.as_str())
        .ok_or("Немає адреси інсталятора")?;
    let url = https_url(file)?;
    url_name(&url)?;
    let cur = current();
    Ok(Found {
        available: newer(&version, &cur),
        current: cur,
        version,
        notes: v
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .chars()
            .take(600)
            .collect(),
        file: url.to_string(),
        source: format!("github:{owner}/{repo}"),
    })
}

pub async fn check(source: &str) -> Result<Found, String> {
    let src = source.trim();
    if src.is_empty() {
        return Err("Джерело оновлень не задано".into());
    }
    let remote = source_is_remote(src)?;
    if let Some((owner, repo)) = gh_repo(src) {
        return gh_check(&owner, &repo).await;
    }
    if remote {
        let url = manifest_url(src)?;
        let response = http(20)?
            .get(url)
            .send()
            .await
            .map_err(|e| format!("мережа: {e}"))?;
        // Після перенаправлення відносний файл належить кінцевому маніфесту.
        let effective_url = response.url().to_string();
        let txt = response_bytes(response, MAX_MANIFEST).await?;
        return from_manifest(&txt, &effective_url);
    }
    let dir = PathBuf::from(src);
    if !dir.is_dir() {
        return Err(format!("Теки «{src}» немає"));
    }
    let mut best = if dir.join("latest.json").is_file() {
        let txt = read_bounded(&local_file(&dir, "latest.json")?, MAX_MANIFEST)?;
        let f = from_manifest(&txt, src)?;
        if local_file(&dir, &f.file).is_ok() && local_file(&dir, &format!("{}.sig", f.file)).is_ok()
        {
            Some(f)
        } else {
            None
        }
    } else {
        None
    };
    if let Some((name, version)) = scan(&dir) {
        if best
            .as_ref()
            .map(|b| newer(&version, &b.version))
            .unwrap_or(true)
        {
            let cur = current();
            best = Some(Found {
                available: newer(&version, &cur),
                current: cur,
                version,
                notes: String::new(),
                file: name,
                source: src.into(),
            });
        }
    }
    best.ok_or_else(|| "У теці немає інсталятора з підписом".into())
}

fn scan(dir: &Path) -> Option<(String, String)> {
    let mut best: Option<(String, String)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if safe_name(&name).is_err()
            || local_file(dir, &name).is_err()
            || local_file(dir, &format!("{name}.sig")).is_err()
        {
            continue;
        }
        if let Some(version) = ver_from_name(&name) {
            if best
                .as_ref()
                .map(|(_, b)| newer(&version, b))
                .unwrap_or(true)
            {
                best = Some((name, version));
            }
        }
    }
    best
}

/// Виконуваний файл зʼявляється лише після перевірки саме тих байтів,
/// які записуємо; повторного читання недовіреного джерела немає.
pub async fn fetch(source: &str, file: &str) -> Result<PathBuf, String> {
    let source = source.trim();
    if source.is_empty() {
        return Err("Джерело оновлень не задано".into());
    }
    let remote = source_is_remote(source)?;
    let (name, bytes, signature) = if remote || gh_repo(source).is_some() {
        let url = resolve_installer(source, file)?;
        let name = url_name(&url)?;
        let signature = download(&signature_url(&url), MAX_SIGNATURE).await?;
        let bytes = download(&url, MAX_INSTALLER).await?;
        (name, bytes, signature)
    } else {
        safe_name(file)?;
        let dir = Path::new(source);
        let signature = read_bounded(&local_file(dir, &format!("{file}.sig"))?, MAX_SIGNATURE)?;
        let bytes = read_bounded(&local_file(dir, file)?, MAX_INSTALLER)?;
        (file.to_string(), bytes, signature)
    };
    stage_verified(&name, &bytes, &signature, PUBLIC_KEY)
}

fn stage_verified(
    name: &str,
    bytes: &[u8],
    signature: &[u8],
    public_key: &str,
) -> Result<PathBuf, String> {
    safe_name(name)?;
    verify(bytes, signature, public_key)?;
    let dir = tempfile::Builder::new()
        .prefix("groshi-update-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let path = dir.path().join(name);
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    output.write_all(bytes).map_err(|e| e.to_string())?;
    output.sync_all().map_err(|e| e.to_string())?;
    drop(output);
    // Tauri запускає інсталятор після повернення з fetch, тому теку
    // зберігаємо; незавершені завантаження TempDir видаляє автоматично.
    let _ = dir.keep();
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[tokio::test]
    async fn unsigned_installer_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("Groshi_Setup_99.0.0.exe"),
            b"synthetic installer",
        )
        .unwrap();
        assert!(
            fetch(dir.path().to_str().unwrap(), "Groshi_Setup_99.0.0.exe")
                .await
                .is_err()
        );
    }

    #[test]
    fn exact_bytes_and_signing_key_are_required() {
        let key = SigningKey::from_bytes(&[42; 32]);
        let bytes = b"synthetic installer; never executable";
        let signature = hex::encode(key.sign(bytes).to_bytes());
        let public = hex::encode(key.verifying_key().to_bytes());
        assert!(verify(bytes, signature.as_bytes(), &public).is_ok());
        assert!(verify(b"tampered installer", signature.as_bytes(), &public).is_err());
        let wrong = hex::encode(SigningKey::from_bytes(&[24; 32]).verifying_key().to_bytes());
        assert!(verify(bytes, signature.as_bytes(), &wrong).is_err());
        assert!(verify(bytes, b"00", &public).is_err());
        assert!(verify(bytes, b"", &public).is_err());
    }

    #[test]
    fn signed_bytes_are_staged_unchanged_in_unique_directories() {
        let key = SigningKey::from_bytes(&[42; 32]);
        let bytes = b"Synthetic test payload, never executable";
        let signature = hex::encode(key.sign(bytes).to_bytes());
        let public = hex::encode(key.verifying_key().to_bytes());
        let first = stage_verified("setup.exe", bytes, signature.as_bytes(), &public).unwrap();
        let second = stage_verified("setup.exe", bytes, signature.as_bytes(), &public).unwrap();
        assert_ne!(first.parent(), second.parent());
        assert_eq!(fs::read(&first).unwrap(), bytes);
        assert_eq!(fs::read(&second).unwrap(), bytes);
        assert!(stage_verified("setup.exe", b"tampered", signature.as_bytes(), &public).is_err());
        assert!(stage_verified("../setup.exe", bytes, signature.as_bytes(), &public).is_err());
        for file in [first, second] {
            fs::remove_file(&file).unwrap();
            fs::remove_dir(file.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn accepts_rfc8032_known_vector() {
        let public = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
        let signature = b"e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
        assert!(verify(b"", signature, public).is_ok());
    }

    #[test]
    fn rejects_traversal_windows_streams_and_other_payloads() {
        for file in [
            "../setup.exe",
            "..\\setup.exe",
            "/setup.exe",
            "C:\\setup.exe",
            "setup.exe:stream.exe",
            "setup.cmd",
            "CON.exe",
            "%2e%2e.exe",
            "setup.exe ",
        ] {
            assert!(safe_name(file).is_err(), "{file}");
        }
        assert!(safe_name("Гроші_1.32.0_x64-setup.exe").is_ok());
        assert!(
            resolve_installer("https://example.com/releases/latest.json", "../setup.exe").is_err()
        );
        assert!(resolve_installer("https://example.com", "http://example.com/setup.exe").is_err());
        assert!(
            resolve_installer("https://example.com", "https://example.com/a%2fsetup.exe").is_err()
        );
    }

    #[test]
    fn manifest_relative_files_use_manifest_directory() {
        let url =
            resolve_installer("https://example.com/releases/latest.json", "setup.exe").unwrap();
        assert_eq!(url.as_str(), "https://example.com/releases/setup.exe");
        let url = resolve_installer("https://example.com/releases", "setup.exe").unwrap();
        assert_eq!(url.as_str(), "https://example.com/releases/setup.exe");
        assert_eq!(
            signature_url(&url).as_str(),
            "https://example.com/releases/setup.exe.sig"
        );
    }

    #[test]
    fn redirected_manifest_without_json_extension_resolves_relative_file() {
        let found = from_manifest(
            br#"{"version":"99.0","file":"setup.exe"}"#,
            "https://example.com/api/latest",
        )
        .unwrap();
        assert_eq!(found.file, "https://example.com/api/setup.exe");
    }

    #[tokio::test]
    async fn rejects_http_and_file_urls_before_any_network_access() {
        for source in [
            "http://github.com/owner/repo",
            "http://example.com",
            "file:///C:/tmp",
            "HTTP://example.com",
        ] {
            assert!(check(source).await.is_err());
            assert!(fetch(source, "setup.exe").await.is_err());
        }
        assert!(https_url("https://user:password@example.com/setup.exe").is_err());
        assert!(!safe_https(
            &reqwest::Url::parse("http://example.com/setup.exe").unwrap()
        ));
        let error = http(1)
            .unwrap()
            .get("http://127.0.0.1:1/setup.exe")
            .send()
            .await
            .unwrap_err();
        assert!(
            error.is_builder(),
            "HTTP must be rejected before a connection attempt"
        );
    }

    #[tokio::test]
    async fn directory_manifest_cannot_escape() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("latest.json"),
            br#"{"version":"99.0","file":"../outside.exe"}"#,
        )
        .unwrap();
        assert!(check(dir.path().to_str().unwrap()).await.is_err());
        assert!(fetch(dir.path().to_str().unwrap(), "../outside.exe")
            .await
            .is_err());
    }

    #[test]
    fn local_reads_enforce_limits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("signature");
        fs::write(&path, [0u8; MAX_SIGNATURE + 1]).unwrap();
        assert!(read_bounded(&path, MAX_SIGNATURE).is_err());
    }
}
