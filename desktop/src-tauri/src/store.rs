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
