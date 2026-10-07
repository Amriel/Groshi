//! Дані на диску.
//!
//! Усе лежить простими JSON-файлами в теці застосунку — щоб їх можна було
//! відкрити блокнотом, покласти в бекап чи в хмару без жодного експорту.
//! Бази даних тут не треба: обсяг — тисячі записів, а не мільйони.
//!
//!   %APPDATA%\Groshi\
//!     mono_raw.json   сирі відповіді банку, як прийшли. Ніколи не
//!                     переписуються «розумнішою» версією: якщо завтра
//!                     зміниться категоризація, історію перебирати не треба.
//!     state.json      налаштування інтерфейсу, підписки, примітки, кошториси
//!     legacy.json     одноразовий імпорт старого знімка з Notion

use serde_json::{json, Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Store {
    pub dir: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        Store { dir, lock: Mutex::new(()) }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    pub fn read(&self, name: &str) -> Value {
        let _g = self.lock.lock().unwrap();
        read_json(&self.path(name))
    }

    /// Запис через тимчасовий файл і перейменування. Якщо світло згасне
    /// посеред запису, старий файл лишиться цілим, а не обрізаним.
    pub fn write(&self, name: &str, v: &Value) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        write_json(&self.path(name), v)
    }

    pub fn state(&self) -> Value {
        let v = self.read("state.json");
        if v.is_object() { v } else { json!({}) }
    }

    pub fn state_set(&self, key: &str, val: Value) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        let p = self.path("state.json");
        let mut cur = read_json(&p);
        if !cur.is_object() {
            cur = Value::Object(Map::new());
        }
        cur.as_object_mut().unwrap().insert(key.to_string(), val);
        write_json(&p, &cur)
    }

    pub fn state_del(&self, key: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        let p = self.path("state.json");
        let mut cur = read_json(&p);
        if let Some(o) = cur.as_object_mut() {
            o.remove(key);
            return write_json(&p, &cur);
        }
        Ok(())
    }

    /// Замінити стан цілком — потрібно для імпорту з браузерної версії.
    pub fn state_replace(&self, v: Value) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        write_json(&self.path("state.json"), &v)
    }
}

fn read_json(p: &Path) -> Value {
    match fs::read_to_string(p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

fn write_json(p: &Path, v: &Value) -> Result<(), String> {
    let tmp = p.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let s = serde_json::to_vec(v).map_err(|e| e.to_string())?;
        f.write_all(&s).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, p).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().to_path_buf());
        (d, s)
    }

    #[test]
    fn write_then_read_roundtrip() {
        let (_d, s) = store();
        let v = json!({"a": 1, "b": [1, 2, "x"], "ж": "їжак"});
        s.write("x.json", &v).unwrap();
        assert_eq!(s.read("x.json"), v);
    }

    #[test]
    fn missing_file_reads_null() {
        let (_d, s) = store();
        assert_eq!(s.read("nope.json"), Value::Null);
    }

    #[test]
    fn corrupt_json_reads_null_not_panic() {
        // Обрізаний/зіпсований файл не має валити апку при старті.
        let (_d, s) = store();
        fs::write(s.path("bad.json"), b"{\"a\": [1, 2").unwrap();
        assert_eq!(s.read("bad.json"), Value::Null);
    }

    #[test]
    fn state_set_on_empty_store_creates_object() {
        let (_d, s) = store();
        s.state_set("k", json!(5)).unwrap();
        assert_eq!(s.state(), json!({"k": 5}));
    }

    #[test]
    fn state_set_keeps_other_keys() {
        // Симптом, який ловимо: запис одного налаштування стирає решту стану.
        let (_d, s) = store();
        s.state_set("a", json!(1)).unwrap();
        s.state_set("b", json!(2)).unwrap();
        assert_eq!(s.state(), json!({"a": 1, "b": 2}));
    }

    #[test]
    fn state_set_over_non_object_resets_to_object() {
        // Якщо state.json містить не об'єкт (масив/сміття), set не падає, а починає з чистого.
        let (_d, s) = store();
        s.write("state.json", &json!([1, 2])).unwrap();
        s.state_set("a", json!(1)).unwrap();
        assert_eq!(s.state(), json!({"a": 1}));
    }

    #[test]
    fn state_returns_empty_object_when_missing() {
        let (_d, s) = store();
        assert_eq!(s.state(), json!({}));
    }

    #[test]
    fn state_del_removes_only_that_key() {
        let (_d, s) = store();
        s.state_set("a", json!(1)).unwrap();
        s.state_set("b", json!(2)).unwrap();
        s.state_del("a").unwrap();
        assert_eq!(s.state(), json!({"b": 2}));
    }

    #[test]
    fn state_del_without_file_is_ok_and_creates_nothing() {
        let (_d, s) = store();
        s.state_del("a").unwrap();
        assert!(!s.path("state.json").exists());
    }

    #[test]
    fn state_replace_overwrites_wholesale() {
        let (_d, s) = store();
        s.state_set("old", json!(1)).unwrap();
        s.state_replace(json!({"new": 2})).unwrap();
        assert_eq!(s.state(), json!({"new": 2}));
    }

    #[test]
    fn write_leaves_no_tmp_file() {
        let (d, s) = store();
        s.write("x.json", &json!({"a": 1})).unwrap();
        let tmps: Vec<_> = fs::read_dir(d.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "tmp").unwrap_or(false))
            .collect();
        assert!(tmps.is_empty(), "лишився тимчасовий файл: {tmps:?}");
    }

    #[test]
    fn stale_tmp_does_not_affect_read_and_is_overwritten_by_next_write() {
        // Імітація обриву живлення посеред запису: tmp зі сміттям поруч із
        // цілим файлом. Читання має віддати старий вміст, наступний запис — перетерти tmp.
        let (_d, s) = store();
        let old = json!({"v": "old"});
        s.write("x.json", &old).unwrap();
        let tmp = s.path("x.tmp");
        fs::write(&tmp, b"{\"v\": \"half-wri").unwrap();

        assert_eq!(s.read("x.json"), old);

        let new = json!({"v": "new"});
        s.write("x.json", &new).unwrap();
        assert_eq!(s.read("x.json"), new);
        assert!(!tmp.exists());
    }
}
