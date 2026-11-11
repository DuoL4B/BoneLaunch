//! mod.io mods: the "pallet" folders BONELAB keeps under LocalLow.
//!
//! BoneLaunch does not talk to mod.io (that needs an account key). People use
//! the "Manual download" button on mod.io and BoneLaunch unpacks the zip into
//! the right folder, lists what is there, and can switch mods off by moving
//! them into a side folder the game does not look at.
use crate::game::local_low_mods;
use crate::store::Store;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const OFF_FOLDER: &str = "ModsOff-BoneLaunch";
const SEEN: &str = "modio-zips.json";
const MAX_ZIPS: usize = 40;

fn off_dir() -> PathBuf {
    local_low_mods().parent().map(|p| p.join(OFF_FOLDER)).unwrap_or_else(|| PathBuf::from(OFF_FOLDER))
}

fn is_pallet_file(name: &str) -> bool {
    name.to_lowercase().ends_with("pallet.json")
}

fn friendly(err: io::Error) -> String {
    let locked = matches!(err.raw_os_error(), Some(5) | Some(32) | Some(33));
    if locked || err.kind() == io::ErrorKind::PermissionDenied {
        "A file is in use or protected. Close BONELAB and try again.".into()
    } else {
        err.to_string()
    }
}

/// A folder name we are willing to create or move: one plain path piece.
fn safe_name(name: &str) -> Result<&str, String> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with('.')
        || name.ends_with(' ')
        || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c));
    if bad {
        Err(format!("That is not a usable mod folder name: {name}"))
    } else {
        Ok(name)
    }
}

/// Reads title, author and version from a pallet folder. None when it is not a mod.
fn read_meta(dir: &Path) -> Option<Value> {
    let pallet = fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| p.is_file() && is_pallet_file(&p.file_name().unwrap_or_default().to_string_lossy()))?;
    let folder = dir.file_name()?.to_string_lossy().into_owned();
    let mut meta = json!({ "folder": folder, "title": folder, "author": "", "version": "", "barcode": folder });
    let small_enough = fs::metadata(&pallet).map(|m| m.len() < 16 * 1024 * 1024).unwrap_or(false);
    if small_enough {
        if let Some(v) = fs::read_to_string(&pallet).ok().and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok()) {
            let root = v.pointer("/root/ref").and_then(Value::as_str).unwrap_or("1");
            if let Some(obj) = v.get("objects").and_then(|o| o.get(root)) {
                for key in ["title", "author", "version", "barcode"] {
                    if let Some(s) = obj.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                        meta[key] = Value::String(s.chars().take(120).collect());
                    }
                }
            }
        }
    }
    Some(meta)
}

fn scan(dir: &Path, enabled: bool, out: &mut Vec<Value>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(mut meta) = read_meta(&path) {
            meta["enabled"] = Value::Bool(enabled);
            out.push(meta);
        }
    }
}

pub fn list() -> Vec<Value> {
    let mut out = Vec::new();
    scan(&local_low_mods(), true, &mut out);
    scan(&off_dir(), false, &mut out);
    out.sort_by_key(|m| m.get("title").and_then(Value::as_str).unwrap_or("").to_lowercase());
    out
}

/// Moves a mod folder (and the game's ".manifest" note beside it) between the live and switched-off folders.
pub fn set_enabled(folder: &str, enabled: bool) -> Result<(), String> {
    let folder = safe_name(folder)?;
    let (from, to) = if enabled { (off_dir(), local_low_mods()) } else { (local_low_mods(), off_dir()) };
    if !from.join(folder).is_dir() {
        return if to.join(folder).is_dir() { Ok(()) } else { Err("That mod is no longer there.".into()) };
    }
    fs::create_dir_all(&to).map_err(friendly)?;
    if to.join(folder).exists() {
        fs::remove_dir_all(to.join(folder)).map_err(friendly)?;
    }
    fs::rename(from.join(folder), to.join(folder)).map_err(friendly)?;
    let note = format!("{folder}.manifest");
    if from.join(&note).is_file() {
        let _ = fs::remove_file(to.join(&note));
        let _ = fs::rename(from.join(&note), to.join(&note));
    }
    Ok(())
}

/// Sends a mod folder to the Recycle Bin.
pub fn remove(folder: &str) -> Result<(), String> {
    let folder = safe_name(folder)?;
    let mut found = false;
    for base in [local_low_mods(), off_dir()] {
        for name in [folder.to_string(), format!("{folder}.manifest")] {
            let p = base.join(name);
            if p.exists() {
                trash::delete(&p).map_err(|e| format!("Could not move it to the Recycle Bin: {e}"))?;
                found = true;
            }
        }
    }
    if found {
        Ok(())
    } else {
        Err("That mod is no longer there.".into())
    }
}

/// Unpacks every pallet found in a mod.io zip into the game's Mods folder. Returns the mod titles.
pub fn install_zip(store: &Store, zip_path: &Path) -> Result<Vec<String>, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Could not open the zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("That file is not a valid zip: {e}"))?;
    let names: Vec<(usize, String)> = (0..archive.len())
        .filter_map(|i| {
            let f = archive.by_index(i).ok()?;
            (!f.is_dir()).then(|| (i, f.name().replace('\\', "/").trim_start_matches('/').to_string()))
        })
        .collect();

    // Each pallet file marks the top of one mod: (path inside the zip, folder name to create).
    let mut roots: BTreeSet<(String, String)> = BTreeSet::new();
    for (_, name) in &names {
        let parts: Vec<&str> = name.split('/').collect();
        let last = parts[parts.len() - 1];
        if !is_pallet_file(last) {
            continue;
        }
        let root = parts[..parts.len() - 1].join("/");
        let folder = if parts.len() > 1 {
            parts[parts.len() - 2].to_string()
        } else {
            let stem = &last[..last.len() - "pallet.json".len()];
            let stem = stem.trim_end_matches('.');
            if stem.is_empty() {
                zip_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "mod".into())
            } else {
                stem.to_string()
            }
        };
        roots.insert((root, safe_name(&folder)?.to_string()));
    }
    if roots.is_empty() {
        return Err("This zip has no pallet file, so it is not a mod.io mod for BONELAB. If it is a code mod, use \"Install from zip\" on the Installed page.".into());
    }

    let mods_dir = local_low_mods();
    let mut titles = Vec::new();
    for (root, folder) in roots {
        let dest = mods_dir.join(&folder);
        for old in [dest.clone(), off_dir().join(&folder)] {
            if old.exists() {
                fs::remove_dir_all(&old).map_err(friendly)?;
            }
        }
        let prefix = if root.is_empty() { String::new() } else { format!("{root}/") };
        for (index, name) in &names {
            let Some(rel) = name.strip_prefix(&prefix) else { continue };
            let mut target = dest.clone();
            for part in rel.split('/') {
                if part.is_empty() || part == "." || part == ".." || part.contains(':') {
                    return Err(format!("Unsafe path in the zip: {name}"));
                }
                target.push(part);
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(friendly)?;
            }
            let mut src = archive.by_index(*index).map_err(|e| e.to_string())?;
            let mut out = fs::File::create(&target).map_err(friendly)?;
            io::copy(&mut src, &mut out).map_err(friendly)?;
        }
        let title = read_meta(&dest).and_then(|m| m.get("title").and_then(Value::as_str).map(str::to_string)).unwrap_or(folder);
        titles.push(title);
    }

    remember_zip(store, zip_path);
    Ok(titles)
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn seen(store: &Store) -> Map<String, Value> {
    store.read(SEEN).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

/// Notes that a zip was installed, so it stops being offered.
fn remember_zip(store: &Store, zip_path: &Path) {
    let mut map = seen(store);
    map.retain(|p, _| Path::new(p).exists());
    map.insert(zip_path.to_string_lossy().into_owned(), json!(modified_ms(zip_path)));
    let _ = store.write(SEEN, &Value::Object(map));
}

pub fn downloads_dir() -> PathBuf {
    if std::env::var("BONELAUNCH_DATA").is_ok() {
        if let Ok(p) = std::env::var("BONELAUNCH_DOWNLOADS") {
            return PathBuf::from(p);
        }
    }
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into())).join("Downloads")
}

/// Recent zips in Downloads that hold a BONELAB pallet and have not been installed yet.
pub fn scan_downloads(store: &Store) -> Vec<Value> {
    let done = seen(store);
    let Ok(entries) = fs::read_dir(downloads_dir()) else { return Vec::new() };
    let mut zips: Vec<(u64, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false))
        .map(|p| (modified_ms(&p), p))
        .collect();
    zips.sort_by(|a, b| b.0.cmp(&a.0));
    zips.truncate(MAX_ZIPS);

    let mut out = Vec::new();
    for (modified, path) in zips {
        let key = path.to_string_lossy().into_owned();
        if done.get(&key).and_then(Value::as_u64) == Some(modified) {
            continue;
        }
        let Ok(file) = fs::File::open(&path) else { continue };
        let Ok(archive) = zip::ZipArchive::new(file) else { continue };
        if !archive.file_names().any(|n| is_pallet_file(n.rsplit(['/', '\\']).next().unwrap_or(n))) {
            continue;
        }
        out.push(json!({
            "path": key,
            "name": path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            "size": fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            "modified": modified
        }));
    }
    out
}
