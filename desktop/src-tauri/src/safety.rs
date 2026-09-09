//! Межі файлових команд: шлях із JavaScript сам собою не є дозволом.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const MAX_IMPORT: u64 = 20_000_000;
pub const DATA_FILES: [&str; 12] = [
    "state.json", "mono_raw.json", "legacy.json", "ibkr_raw.json",
    "binance_raw.json", "quotes.json", "logos.json", "cry_hist.json",
    "nbu_rates.json", "inv_cache.json", "networth.json", "fx.json",
];
const BACKUP_MARKER: &str = ".groshi-backup";
const BACKUP_VERSION: &[u8] = b"Groshi backup v1\n";

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum FileKind { Xml, Statement }

impl FileKind {
    pub fn parse(kind: &str) -> Result<Self, String> {
        match kind {
            "xml" => Ok(Self::Xml),
            "statement" => Ok(Self::Statement),
            _ => Err("Невідомий тип імпорту".into()),
        }
    }

    pub fn extensions(self) -> &'static [&'static str] {
        match self { Self::Xml => &["xml"], Self::Statement => &["csv", "xls", "xlsx"] }
    }
}

#[derive(Default)]
pub struct Grants {
    files: HashSet<(PathBuf, FileKind)>,
    directories: HashSet<PathBuf>,
}

impl Grants {
    pub fn add_file(&mut self, path: &Path, kind: FileKind) -> Result<PathBuf, String> {
        let path = regular_file(path)?;
        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !kind.extensions().contains(&extension.as_str()) {
            return Err("Файл має невідповідне розширення".into());
        }
        // Не накопичуємо давні дозволи на читання після наступного вибору.
        self.files.clear();
        self.files.insert((path.clone(), kind));
        Ok(path)
    }

    pub fn consume_file(&mut self, path: &Path, kind: FileKind) -> Result<PathBuf, String> {
        let path = regular_file(path)?;
        if !self.files.remove(&(path.clone(), kind)) {
            return Err("Спочатку виберіть цей файл у діалозі імпорту".into());
        }
        Ok(path)
    }

    pub fn add_directory(&mut self, path: &Path) -> Result<PathBuf, String> {
        let path = directory(path)?;
        self.directories.insert(path.clone());
        Ok(path)
    }

    pub fn directory(&self, path: &Path) -> Result<PathBuf, String> {
        let path = directory(path)?;
        if !self.directories.contains(&path) {
            return Err("Спочатку виберіть цю теку в діалозі".into());
        }
        Ok(path)
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junction та інші reparse points теж можуть вивести за межі дозволеної теки.
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    false
}

pub fn reject_links(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Потрібен абсолютний шлях без переходів до батьківської теки".into());
    }
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() { continue; }
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if is_link(&metadata) => return Err("Посилання на файли й теки не підтримуються".into()),
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("Не вдалося перевірити шлях: {e}")),
        }
    }
    Ok(())
}

pub fn directory(path: &Path) -> Result<PathBuf, String> {
    reject_links(path)?;
    let path = fs::canonicalize(path).map_err(|e| format!("Тека недоступна: {e}"))?;
    if !fs::metadata(&path).map_err(|e| e.to_string())?.is_dir() {
        return Err("Потрібна тека".into());
    }
    Ok(path)
}

pub fn regular_file(path: &Path) -> Result<PathBuf, String> {
    reject_links(path)?;
    let path = fs::canonicalize(path).map_err(|e| format!("Файл недоступний: {e}"))?;
    if !fs::metadata(&path).map_err(|e| e.to_string())?.is_file() {
        return Err("Потрібен звичайний файл".into());
    }
    Ok(path)
}

pub fn read_import(path: &Path) -> Result<Vec<u8>, String> {
    let path = regular_file(path)?;
    let file = File::open(path).map_err(|e| format!("Не вдалося прочитати файл: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_IMPORT {
        return Err("Файл завеликий для імпорту (понад 20 МБ) або не є звичайним файлом".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMPORT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_IMPORT { return Err("Файл завеликий для імпорту (понад 20 МБ)".into()); }
    Ok(bytes)
}

pub fn external_url(raw: &str) -> Result<reqwest::Url, String> {
    if raw.chars().any(char::is_control) || raw.trim() != raw || raw.contains('\\') {
        return Err("Некоректне посилання".into());
    }
    let authority = raw.split_once("://").map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or(""));
    if authority.map(|a| a.contains('@')).unwrap_or(true) {
        return Err("Посилання не повинно містити облікових даних".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "Некоректне посилання".to_string())?;
    if url.scheme() != "https" || url.host_str().filter(|h| !h.is_empty()).is_none()
        || !url.username().is_empty() || url.password().is_some() {
        return Err("Дозволені лише HTTPS-посилання без облікових даних".into());
    }
    Ok(url)
}

pub fn raster_data_url(value: &str) -> bool {
    if value.len() > 3_000_000 { return false; }
    let Some((prefix, data)) = value.split_once(',') else { return false };
    ["data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64", "data:image/gif;base64", "data:image/x-icon;base64"]
        .iter().any(|mime| prefix.eq_ignore_ascii_case(mime))
        && !data.is_empty() && data.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b) || b.is_ascii_whitespace())
}

pub fn export_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 180 || name.ends_with(['.', ' '])
        || name.chars().any(|c| c.is_control() || "/\\:*?\"<>|".contains(c)) {
        return false;
    }
    let Some((stem, extension)) = name.rsplit_once('.') else { return false };
    if stem.is_empty() || !["html", "csv", "txt", "json", "ics"].contains(&extension.to_ascii_lowercase().as_str()) {
        return false;
    }
    let base = name.split('.').next().unwrap_or("").trim_end_matches(' ').to_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].contains(&base.as_str()) { return false; }
    !["COM", "LPT"].iter().any(|prefix| {
        base.strip_prefix(prefix).map(|n| ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&n)).unwrap_or(false)
    })
}

pub fn save_export(dir: &Path, name: &str, text: &str) -> Result<PathBuf, String> {
    if !export_name(name) { return Err("Неприпустиме ім’я або розширення експорту".into()); }
    let dir = directory(dir)?;
    let (stem, extension) = name.rsplit_once('.').unwrap();
    for number in 0..1000 {
        let leaf = if number == 0 { name.to_string() } else { format!("{stem} ({number}).{extension}") };
        let path = dir.join(leaf);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(text.as_bytes()).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Не вдалося зберегти експорт: {e}")),
        }
    }
    Err("Забагато експортів з однаковим ім’ям".into())
}

/// Відомі імена та перевірка без переходу за посиланням застосовуються і до відсутніх файлів.
pub fn data_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !DATA_FILES.contains(&name) { return Err("Невідомий файл даних".into()); }
    let dir = directory(dir)?;
    let path = dir.join(name);
    reject_links(&path)?;
    if path.exists() && !path.is_file() { return Err("Замість файла даних знайдено теку".into()); }
    Ok(path)
}

pub fn check_data_dir(dir: &Path) -> Result<(), String> {
    for name in DATA_FILES {
        let path = data_path(dir, name)?;
        // Store пише через .tmp; наявне посилання тут теж неприйнятне.
        let temporary = path.with_extension("tmp");
        reject_links(&temporary)?;
        if temporary.exists() && !temporary.is_file() { return Err("Некоректний тимчасовий файл даних".into()); }
    }
    Ok(())
}

pub fn writable(dir: &Path) -> Result<bool, String> {
    let dir = directory(dir)?;
    for number in 0..100 {
        let probe = dir.join(format!(".groshi-probe-{}-{number}", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&probe) {
            Ok(file) => { drop(file); fs::remove_file(probe).map_err(|e| e.to_string())?; return Ok(true); }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Ok(false),
        }
    }
    Ok(false)
}

fn replace_file(path: &Path, write: impl FnOnce(&mut File) -> std::io::Result<()>) -> Result<(), String> {
    reject_links(path)?;
    let parent = directory(path.parent().ok_or("Файл не має батьківської теки")?)?;
    let mut temporary = None;
    for number in 0..1000 {
        let p = parent.join(format!(".groshi-write-{}-{number}.tmp", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(file) => { temporary = Some((p, file)); break; }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    let (temp, mut file) = temporary.ok_or("Не вдалося створити тимчасовий файл")?;
    let result = write(&mut file).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = result { let _ = fs::remove_file(&temp); return Err(error.to_string()); }
    if let Err(error) = reject_links(path) { let _ = fs::remove_file(&temp); return Err(error); }
    if let Err(error) = fs::rename(&temp, path) { let _ = fs::remove_file(&temp); return Err(error.to_string()); }
    Ok(())
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    replace_file(path, |file| file.write_all(bytes))
}

pub fn copy_file(source: &Path, destination: &Path) -> Result<(), String> {
    let source = regular_file(source)?;
    let mut file = File::open(source).map_err(|e| e.to_string())?;
    replace_file(destination, |target| std::io::copy(&mut file, target).map(|_| ()))
}

pub fn same_bytes(first: &Path, second: &Path) -> Result<bool, String> {
    let mut first = File::open(regular_file(first)?).map_err(|e| e.to_string())?;
    let mut second = File::open(regular_file(second)?).map_err(|e| e.to_string())?;
    if first.metadata().map_err(|e| e.to_string())?.len() != second.metadata().map_err(|e| e.to_string())?.len() { return Ok(false); }
    let mut a = [0; 8192];
    let mut b = [0; 8192];
    loop {
        let na = first.read(&mut a).map_err(|e| e.to_string())?;
        let nb = second.read(&mut b).map_err(|e| e.to_string())?;
        if na != nb || a[..na] != b[..nb] { return Ok(false); }
        if na == 0 { return Ok(true); }
    }
}

pub fn migration_paths(source: &Path, target: &Path, mode: &str) -> Result<(PathBuf, PathBuf), String> {
    if !["move", "adopt", "overwrite"].contains(&mode) { return Err("Невідомий спосіб зміни теки".into()); }
    let source = directory(source)?;
    let target = directory(target)?;
    if source.starts_with(&target) || target.starts_with(&source) {
        return Err("Теки даних мають бути окремими й не вкладеними одна в одну".into());
    }
    check_data_dir(&source)?;
    check_data_dir(&target)?;
    Ok((source, target))
}

pub fn copy_migration(source: &Path, target: &Path, mode: &str) -> Result<(), String> {
    let (source, target) = migration_paths(source, target, mode)?;
    if mode == "adopt" { return Ok(()); }
    // Увесь конфліктний набір перевіряємо до першого запису. Однакові файли
    // дозволяють безпечно продовжити копіювання після попереднього збою.
    for name in DATA_FILES {
        let from = data_path(&source, name)?;
        let to = data_path(&target, name)?;
        if mode == "move" && to.exists() && (!from.exists() || !same_bytes(&from, &to)?) {
            return Err("У цільовій теці вже є інші дані — виберіть спосіб перенесення знову".into());
        }
    }
    if mode == "overwrite" && DATA_FILES.iter().any(|name| target.join(name).exists()) {
        // Заміна має давати точну копію джерела. Старі файли призначення,
        // яких немає у джерелі, не можна підмішати до чужого портфеля.
        // Перед будь-якою зміною зберігаємо повний попередній набір окремо.
        let backups = target.join("backups");
        reject_links(&backups)?;
        if !backups.exists() { fs::create_dir(&backups).map_err(|e| e.to_string())?; }
        let backups = directory(&backups)?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let previous = backups.join(format!("before-migration-{stamp}"));
        fs::create_dir(&previous).map_err(|e| e.to_string())?;
        for name in DATA_FILES {
            let from = data_path(&target, name)?;
            if from.exists() { copy_file(&from, &data_path(&previous, name)?)?; }
        }
    }
    for name in DATA_FILES {
        let from = data_path(&source, name)?;
        let to = data_path(&target, name)?;
        if from.exists() { copy_file(&from, &to)?; }
    }
    if mode == "overwrite" {
        for name in DATA_FILES {
            let from = data_path(&source, name)?;
            let to = data_path(&target, name)?;
            if !from.exists() && to.exists() { fs::remove_file(to).map_err(|e| e.to_string())?; }
        }
    }
    Ok(())
}

pub fn remove_migrated_sources(source: &Path, target: &Path) -> Result<(), String> {
    for name in DATA_FILES {
        let from = data_path(source, name)?;
        let to = data_path(target, name)?;
        if from.exists() && to.exists() && same_bytes(&from, &to)? {
            fs::remove_file(from).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn backup_name(name: &str) -> bool {
    let Some(date) = name.strip_prefix("backup-") else { return false };
    let b = date.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-'
        || !b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) { return false; }
    let year: u32 = date[..4].parse().unwrap_or(0);
    let month: u32 = date[5..7].parse().unwrap_or(0);
    let day: u32 = date[8..].parse().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month { 1|3|5|7|8|10|12 => 31, 4|6|9|11 => 30, 2 => if leap {29} else {28}, _ => 0 };
    year > 0 && day > 0 && day <= days
}

pub fn owned_backup(root: &Path, path: &Path) -> bool {
    let Ok(root) = directory(root) else { return false };
    let Ok(path) = directory(path) else { return false };
    if path.parent() != Some(root.as_path()) || !path.file_name().and_then(|n| n.to_str()).map(backup_name).unwrap_or(false) { return false; }
    snapshot_contents(&path)
}

fn snapshot_contents(path: &Path) -> bool {
    let Ok(path) = directory(path) else { return false };
    let marker = path.join(BACKUP_MARKER);
    if regular_file(&marker).is_err() { return false; }
    let Ok(file) = File::open(&marker) else { return false };
    let mut bytes = Vec::new();
    if file.take(64).read_to_end(&mut bytes).is_err() || bytes != BACKUP_VERSION { return false; }
    let Ok(mut entries) = fs::read_dir(&path) else { return false };
    entries.all(|entry| entry.ok().map(|entry| {
        let name = entry.file_name();
        let known = name.to_str().map(|n| n == BACKUP_MARKER || DATA_FILES.contains(&n)).unwrap_or(false);
        known && regular_file(&entry.path()).is_ok()
    }).unwrap_or(false))
}

fn remove_snapshot(root: &Path, path: &Path) -> Result<(), String> {
    let root = directory(root)?;
    let path = directory(path)?;
    if path.parent() != Some(root.as_path()) || !snapshot_contents(&path) {
        return Err("Тека не є власною резервною копією застосунку".into());
    }
    for name in DATA_FILES {
        let file = data_path(&path, name)?;
        if file.exists() { fs::remove_file(file).map_err(|e| e.to_string())?; }
    }
    fs::remove_file(path.join(BACKUP_MARKER)).map_err(|e| e.to_string())?;
    fs::remove_dir(path).map_err(|e| e.to_string())
}

/// Новий знімок збирається окремо: видалені вихідні файли не оживають
/// у повторній копії за той самий день, а збій читання не псує попередню.
pub fn write_backup(source: &Path, root: &Path, name: &str) -> Result<(PathBuf, u32, u64), String> {
    if !backup_name(name) { return Err("Некоректна дата резервної копії".into()); }
    let source = directory(source)?;
    check_data_dir(&source)?;
    let root = directory(root)?;
    let target = root.join(name);
    reject_links(&target)?;
    if source.starts_with(&target) { return Err("Резервна копія не може замінити поточну теку даних".into()); }
    if target.exists() && !owned_backup(&root, &target) { return Err("Тека резервної копії вже існує й не належить застосунку".into()); }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let stage = root.join(format!(".groshi-backup-stage-{stamp}"));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let staged = || -> Result<(u32, u64), String> {
        let mut marker = OpenOptions::new().write(true).create_new(true).open(stage.join(BACKUP_MARKER)).map_err(|e| e.to_string())?;
        marker.write_all(BACKUP_VERSION).and_then(|_| marker.sync_all()).map_err(|e| e.to_string())?;
        let mut files = 0; let mut bytes = 0;
        for name in DATA_FILES {
            let from = data_path(&source, name)?;
            if from.exists() {
                let to = data_path(&stage, name)?;
                copy_file(&from, &to)?;
                files += 1;
                bytes += fs::metadata(to).map_err(|e| e.to_string())?.len();
            }
        }
        Ok((files, bytes))
    };
    let (files, bytes) = match staged() {
        Ok(result) => result,
        Err(error) => { let _ = remove_snapshot(&root, &stage); return Err(error); }
    };
    let previous = root.join(format!(".groshi-backup-previous-{stamp}"));
    reject_links(&previous)?;
    if previous.exists() { return Err("Тека попередньої копії вже існує".into()); }
    let had_previous = target.exists();
    if had_previous {
        if !owned_backup(&root, &target) { let _ = remove_snapshot(&root, &stage); return Err("Попередня резервна копія змінилася".into()); }
        fs::rename(&target, &previous).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&stage, &target) {
        if had_previous {
            if let Err(restore) = fs::rename(&previous, &target) {
                return Err(format!("Не вдалося завершити копіювання: {error}. Попередній знімок збережено в {}: {restore}", previous.display()));
            }
        }
        let _ = remove_snapshot(&root, &stage);
        return Err(error.to_string());
    }
    if had_previous { remove_snapshot(&root, &previous)?; }
    Ok((target, files, bytes))
}

#[cfg(test)]
pub fn prepare_backup(root: &Path, name: &str) -> Result<PathBuf, String> {
    if !backup_name(name) { return Err("Некоректна дата резервної копії".into()); }
    let root = directory(root)?;
    let target = root.join(name);
    reject_links(&target)?;
    if target.exists() {
        if !owned_backup(&root, &target) { return Err("Тека резервної копії вже існує й не належить застосунку".into()); }
    } else {
        fs::create_dir(&target).map_err(|e| e.to_string())?;
        let mut file = OpenOptions::new().write(true).create_new(true).open(target.join(BACKUP_MARKER)).map_err(|e| e.to_string())?;
        file.write_all(BACKUP_VERSION).map_err(|e| e.to_string())?;
    }
    Ok(target)
}

pub fn prune_backups(root: &Path) -> Result<(), String> {
    let root = directory(root)?;
    let mut old: Vec<PathBuf> = fs::read_dir(&root).map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| owned_backup(&root, path)).collect();
    old.sort();
    let remove = old.len().saturating_sub(8);
    for path in old.into_iter().take(remove) {
        if !owned_backup(&root, &path) { continue; }
        // Не рекурсивне видалення: невідомий файл чи вкладена тека зупиняють очищення.
        for name in DATA_FILES {
            let file = data_path(&path, name)?;
            if file.exists() { fs::remove_file(file).map_err(|e| e.to_string())?; }
        }
        fs::remove_file(path.join(BACKUP_MARKER)).map_err(|e| e.to_string())?;
        fs::remove_dir(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("groshi-safety-test-{}-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn dir(&self, name: &str) -> PathBuf { let path = self.0.join(name); fs::create_dir(&path).unwrap(); path }
        fn file(&self, name: &str, bytes: &[u8]) -> PathBuf { let path = self.0.join(name); fs::write(&path, bytes).unwrap(); path }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let root = fs::canonicalize(std::env::temp_dir()).unwrap();
            if self.0.parent() == Some(root.as_path()) && self.0.file_name().unwrap().to_string_lossy().starts_with("groshi-safety-test-") {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn urls_reject_credentials_shell_schemes_and_control_characters() {
        assert!(external_url("https://example.com/news?id=1&lang=uk").is_ok());
        for url in ["file:///c:/secret", "javascript:alert(1)", "https://user:secret@example.com", "https://@example.com", "https://example.com\n", " https://example.com", "https://", "https:\\example.com"] {
            assert!(external_url(url).is_err(), "{url:?}");
        }
    }

    #[test]
    fn exports_reject_executables_reserved_names_and_path_escapes() {
        for name in ["рахунок.html", "звіт 2026.csv", "copy.JSON", "normalcalendar.ics"] { assert!(export_name(name)); }
        for name in ["", "../report.txt", "C:\\report.txt", "report.cmd", "report.html.exe", "CON.txt", "nul.JSON", "LPT1.csv", "COM².txt", "report.txt ", "report.txt.", "bad\n.txt", "a:stream.txt", ".txt"] {
            assert!(!export_name(name), "{name:?}");
        }
    }

    #[test]
    fn export_never_overwrites_existing_file() {
        let temp = Temp::new();
        let original = temp.file("report.html", b"original");
        let second = save_export(&temp.0, "report.html", "new").unwrap();
        assert_ne!(original, second);
        assert_eq!(fs::read(original).unwrap(), b"original");
        assert_eq!(fs::read(second).unwrap(), b"new");
    }

    #[test]
    fn file_grant_is_path_kind_specific_and_single_use() {
        let temp = Temp::new();
        let xml = temp.file("statement.xml", b"synthetic xml");
        let other = temp.file("other.xml", b"other");
        let mut grants = Grants::default();
        assert!(grants.consume_file(&xml, FileKind::Xml).is_err());
        grants.add_file(&xml, FileKind::Xml).unwrap();
        assert!(grants.consume_file(&other, FileKind::Xml).is_err());
        assert!(grants.consume_file(&xml, FileKind::Statement).is_err());
        assert!(grants.consume_file(&xml, FileKind::Xml).is_ok());
        assert!(grants.consume_file(&xml, FileKind::Xml).is_err());
        assert!(grants.add_file(&xml, FileKind::Statement).is_err());
    }

    #[test]
    fn directory_grants_do_not_authorize_siblings_or_children() {
        let temp = Temp::new();
        let allowed = temp.dir("allowed");
        let other = temp.dir("other");
        let child = allowed.join("child"); fs::create_dir(&child).unwrap();
        let mut grants = Grants::default();
        grants.add_directory(&allowed).unwrap();
        assert!(grants.directory(&allowed).is_ok());
        assert!(grants.directory(&other).is_err());
        assert!(grants.directory(&child).is_err());
        assert!(grants.directory(&allowed.join("..")).is_err());
    }

    #[test]
    fn import_reads_only_regular_files_with_size_limit() {
        let temp = Temp::new();
        let small = temp.file("small.csv", b"synthetic");
        assert_eq!(read_import(&small).unwrap(), b"synthetic");
        assert!(read_import(&temp.0).is_err());
        let large = temp.file("large.csv", b"");
        File::options().write(true).open(&large).unwrap().set_len(MAX_IMPORT + 1).unwrap();
        assert!(read_import(&large).is_err());
    }

    #[test]
    fn all_data_files_move_and_only_verified_sources_are_removed() {
        let temp = Temp::new();
        let source = temp.dir("source"); let target = temp.dir("target");
        assert_eq!(DATA_FILES.len(), 12);
        for name in DATA_FILES { fs::write(source.join(name), format!("synthetic {name}")).unwrap(); }
        copy_migration(&source, &target, "move").unwrap();
        for name in DATA_FILES { assert!(same_bytes(&source.join(name), &target.join(name)).unwrap()); }
        fs::write(source.join("state.json"), b"changed after copy").unwrap();
        remove_migrated_sources(&source, &target).unwrap();
        assert!(source.join("state.json").exists());
        assert!(!source.join("fx.json").exists());
        assert!(target.join("inv_cache.json").exists());
        assert!(target.join("networth.json").exists());
    }

    #[test]
    fn migration_conflict_does_not_overwrite_existing_data() {
        let temp = Temp::new(); let source = temp.dir("source"); let target = temp.dir("target");
        fs::write(source.join("state.json"), b"source").unwrap();
        fs::write(target.join("state.json"), b"destination").unwrap();
        assert!(copy_migration(&source, &target, "move").is_err());
        assert_eq!(fs::read(target.join("state.json")).unwrap(), b"destination");
        copy_migration(&source, &target, "adopt").unwrap();
        assert_eq!(fs::read(target.join("state.json")).unwrap(), b"destination");
        assert!(migration_paths(&source, &source, "move").is_err());
        assert!(migration_paths(&temp.0, &target, "move").is_err());
    }

    #[test]
    fn overwrite_preserves_previous_data_without_mixing_absent_source_files() {
        let temp = Temp::new(); let source = temp.dir("source"); let target = temp.dir("target");
        fs::write(source.join("state.json"), b"new settings").unwrap();
        fs::write(target.join("state.json"), b"old settings").unwrap();
        fs::write(target.join("ibkr_raw.json"), b"unrelated old portfolio").unwrap();
        copy_migration(&source, &target, "overwrite").unwrap();
        assert_eq!(fs::read(target.join("state.json")).unwrap(), b"new settings");
        assert!(!target.join("ibkr_raw.json").exists());
        let previous = fs::read_dir(target.join("backups")).unwrap().next().unwrap().unwrap().path();
        assert_eq!(fs::read(previous.join("state.json")).unwrap(), b"old settings");
        assert_eq!(fs::read(previous.join("ibkr_raw.json")).unwrap(), b"unrelated old portfolio");
    }

    #[test]
    fn backup_pruning_preserves_unowned_folders_and_unknown_files() {
        let temp = Temp::new();
        let unowned = temp.dir("backup-2000-01-01"); fs::write(unowned.join("state.json"), b"keep").unwrap();
        let unrelated = temp.dir("backup-personal"); fs::write(unrelated.join("notes.txt"), b"keep").unwrap();
        let altered = prepare_backup(&temp.0, "backup-2001-01-01").unwrap(); fs::write(altered.join("notes.txt"), b"keep").unwrap();
        for day in 1..=10 { let path = prepare_backup(&temp.0, &format!("backup-2026-09-{day:02}")).unwrap(); fs::write(path.join("state.json"), b"synthetic").unwrap(); }
        prune_backups(&temp.0).unwrap();
        assert!(unowned.join("state.json").exists()); assert!(unrelated.join("notes.txt").exists()); assert!(altered.join("notes.txt").exists());
        assert!(!temp.0.join("backup-2026-09-01").exists());
        assert!(!temp.0.join("backup-2026-09-02").exists());
        assert!(temp.0.join("backup-2026-09-03").exists());
        assert!(!backup_name("backup-2026-02-30"));
        assert!(!backup_name("backup-2026-09-01-extra"));
        assert!(prepare_backup(&temp.0, "backup-2000-01-01").is_err());
    }

    #[test]
    fn repeated_daily_backup_does_not_keep_removed_broker_files() {
        let temp = Temp::new(); let source = temp.dir("source"); let root = temp.dir("backups");
        fs::write(source.join("state.json"), b"first state").unwrap();
        fs::write(source.join("ibkr_raw.json"), b"old portfolio").unwrap();
        let (target, files, _) = write_backup(&source, &root, "backup-2026-09-10").unwrap();
        assert_eq!(files, 2);
        fs::remove_file(source.join("ibkr_raw.json")).unwrap();
        fs::write(source.join("state.json"), b"new state").unwrap();
        let (_, files, bytes) = write_backup(&source, &root, "backup-2026-09-10").unwrap();
        assert_eq!(files, 1); assert_eq!(bytes, 9);
        assert_eq!(fs::read(target.join("state.json")).unwrap(), b"new state");
        assert!(!target.join("ibkr_raw.json").exists());
        assert!(owned_backup(&root, &target));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }

    #[test]
    fn invalid_new_snapshot_preserves_previous_daily_backup() {
        let temp = Temp::new(); let source = temp.dir("source"); let root = temp.dir("backups");
        fs::write(source.join("state.json"), b"last valid state").unwrap();
        let (target, _, _) = write_backup(&source, &root, "backup-2026-09-10").unwrap();
        fs::write(source.join("state.json"), b"new state").unwrap();
        fs::create_dir(source.join("ibkr_raw.json")).unwrap();
        assert!(write_backup(&source, &root, "backup-2026-09-10").is_err());
        assert_eq!(fs::read(target.join("state.json")).unwrap(), b"last valid state");
        assert!(owned_backup(&root, &target));
    }

    #[cfg(windows)]
    #[test]
    fn locked_source_cannot_damage_previous_daily_backup() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = Temp::new(); let source = temp.dir("source"); let root = temp.dir("backups");
        fs::write(source.join("state.json"), b"last valid state").unwrap();
        let (target, _, _) = write_backup(&source, &root, "backup-2026-09-10").unwrap();
        fs::write(source.join("state.json"), b"new state").unwrap();
        let blocked = source.join("ibkr_raw.json"); fs::write(&blocked, b"locked synthetic portfolio").unwrap();
        let lock = OpenOptions::new().read(true).share_mode(0).open(&blocked).unwrap();
        assert!(write_backup(&source, &root, "backup-2026-09-10").is_err());
        drop(lock);
        assert_eq!(fs::read(target.join("state.json")).unwrap(), b"last valid state");
        assert!(owned_backup(&root, &target));
    }

    #[test]
    fn reveal_names_and_logo_cache_reject_untrusted_paths_and_svg() {
        let temp = Temp::new();
        assert!(data_path(&temp.0, "state.json").is_ok());
        assert!(data_path(&temp.0, "../state.json").is_err());
        assert!(data_path(&temp.0, "run.exe").is_err());
        assert!(raster_data_url("data:image/png;base64,YWJj"));
        assert!(!raster_data_url("data:image/svg+xml;base64,YWJj"));
        assert!(!raster_data_url("https://example.com/logo.png"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_grant_reads_or_redirect_data_writes() {
        let temp = Temp::new(); let actual = temp.file("actual.csv", b"private");
        let link = temp.0.join("linked.csv"); std::os::unix::fs::symlink(&actual, &link).unwrap();
        assert!(Grants::default().add_file(&link, FileKind::Statement).is_err());
        std::os::unix::fs::symlink(&actual, temp.0.join("state.json")).unwrap();
        assert!(check_data_dir(&temp.0).is_err());
    }
}
