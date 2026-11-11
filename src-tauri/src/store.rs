//! Small JSON files kept in BoneLaunch's data folder.
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;

pub struct Store {
    pub dir: PathBuf,
}

fn defaults() -> Value {
    json!({
        "platform": "auto",
        "customGamePath": "",
        "launchArgs": "",
        "hideConsole": false,
        "mlDebug": false,
        "afterLaunch": "stay",
        "sleepInTray": true,
        "accent": "cyan",
        "bgImage": "",
        "bgDim": 45,
        "bgBlur": 0,
        "reduceMotion": false,
        "view": "grid",
        "showNsfw": false,
        "showDeprecated": false,
        "hideAi": false,
        "checkUpdatesOnStart": true,
        "checkAppUpdates": true,
        "autoUpdateMods": false,
        "installDeps": true,
        "confirmUninstall": true,
        "profiles": {},
        "activeProfile": ""
    })
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        Store { dir }
    }

    pub fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    pub fn read(&self, name: &str) -> Option<Value> {
        let text = fs::read_to_string(self.file(name)).ok()?;
        serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
    }

    pub fn write(&self, name: &str, data: &Value) -> Result<(), String> {
        let target = self.file(name);
        let tmp = self.file(&format!("{name}.tmp"));
        let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        fs::write(&tmp, text).map_err(|e| format!("Could not save {name}: {e}"))?;
        fs::rename(&tmp, &target).map_err(|e| format!("Could not save {name}: {e}"))
    }

    pub fn settings(&self) -> Value {
        let mut merged: Map<String, Value> = defaults().as_object().cloned().unwrap_or_default();
        if let Some(Value::Object(saved)) = self.read("settings.json") {
            for (k, v) in saved {
                merged.insert(k, v);
            }
        }
        Value::Object(merged)
    }

    pub fn set_settings(&self, patch: &Value) -> Result<Value, String> {
        let mut next = self.settings();
        if let (Some(map), Some(p)) = (next.as_object_mut(), patch.as_object()) {
            for (k, v) in p {
                map.insert(k.clone(), v.clone());
            }
        }
        self.write("settings.json", &next)?;
        Ok(next)
    }

    pub fn reset_settings(&self) -> Result<Value, String> {
        self.write("settings.json", &json!({}))?;
        Ok(self.settings())
    }
}

pub fn s_str(settings: &Value, key: &str) -> String {
    settings.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn s_bool(settings: &Value, key: &str) -> bool {
    settings.get(key).and_then(Value::as_bool).unwrap_or(false)
}
