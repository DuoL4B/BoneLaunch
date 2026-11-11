//! Puts mods into the game's folders and keeps track of what was put where.
use crate::game::local_low_mods;
use crate::store::Store;
use crate::thunderstore::{now_ms, LOADER_ID};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const STATE: &str = "mods.json";
const TOP_FOLDERS: [&str; 5] = ["Mods", "Plugins", "UserLibs", "UserData", "MelonLoader"];

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Entry {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub local: bool,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(rename = "installedAt", default)]
    pub installed_at: u64,
}

type GameMods = BTreeMap<String, Entry>;
type AllMods = BTreeMap<String, GameMods>;

fn game_key(game_path: &str) -> String {
    game_path.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn load_all(store: &Store) -> AllMods {
    store.read(STATE).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn load(store: &Store, game_path: &str) -> GameMods {
    load_all(store).remove(&game_key(game_path)).unwrap_or_default()
}

fn save(store: &Store, game_path: &str, mods: GameMods) -> Result<(), String> {
    let mut all = load_all(store);
    all.insert(game_key(game_path), mods);
    store.write(STATE, &serde_json::to_value(all).map_err(|e| e.to_string())?)
}

fn friendly(err: io::Error) -> String {
    let locked = matches!(err.raw_os_error(), Some(5) | Some(32) | Some(33));
    if locked || err.kind() == io::ErrorKind::PermissionDenied {
        "A file is in use or protected. Close BONELAB and try again.".into()
    } else {
        err.to_string()
    }
}

/// Turns "game:Mods/Thing.dll" into a real path, refusing anything that escapes its folder.
fn resolve_key(game_path: &str, key: &str) -> Result<PathBuf, String> {
    let (kind, rel) = key.split_once(':').ok_or_else(|| format!("Bad mod file entry: {key}"))?;
    let mut full = if kind == "local" { local_low_mods() } else { PathBuf::from(game_path) };
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(':') || part.contains('\\') {
            return Err(format!("Unsafe path in mod: {rel}"));
        }
        full.push(part);
    }
    Ok(full)
}

fn is_package_file(name: &str) -> bool {
    let n = name.to_lowercase();
    if n == "manifest.json" || n == "icon.png" || n.ends_with(".md") {
        return true;
    }
    ["readme", "changelog", "license"].iter().any(|p| n == *p || n.starts_with(&format!("{p}.")))
}

fn is_toggleable(key: &str) -> bool {
    let k = key.to_lowercase();
    let in_code_folder = ["game:mods/", "game:plugins/", "game:userlibs/"].iter().any(|p| k.starts_with(p));
    (in_code_folder && k.ends_with(".dll")) || (k.starts_with("local:") && k.ends_with("/pallet.json"))
}

/// Decides where each file in a mod zip belongs. `None` means "leave it out".
pub fn plan_routes(names: &[String], is_loader: bool) -> Vec<Option<String>> {
    let clean: Vec<String> = names.iter().map(|n| n.replace('\\', "/").trim_start_matches('/').to_string()).collect();
    let mut pallet_folders: HashSet<String> = HashSet::new();
    for n in &clean {
        let parts: Vec<&str> = n.split('/').collect();
        if parts.len() == 2 && parts[1].eq_ignore_ascii_case("pallet.json") {
            pallet_folders.insert(parts[0].to_string());
        }
    }
    clean
        .iter()
        .map(|n| {
            let parts: Vec<&str> = n.split('/').collect();
            if parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains(':')) {
                return None;
            }
            if parts.len() == 1 {
                if is_package_file(n) {
                    return None;
                }
                return Some(if is_loader { format!("game:{n}") } else { format!("game:Mods/{n}") });
            }
            if let Some(top) = TOP_FOLDERS.iter().find(|t| t.eq_ignore_ascii_case(parts[0])) {
                return Some(format!("game:{}/{}", top, parts[1..].join("/")));
            }
            if is_loader {
                return Some(format!("game:{n}"));
            }
            if pallet_folders.contains(parts[0]) {
                return Some(format!("local:{n}"));
            }
            Some(format!("game:Mods/{n}"))
        })
        .collect()
}

fn prune_empty_dirs(game_path: &str, key: &str) {
    let root = if key.starts_with("local:") { local_low_mods() } else { PathBuf::from(game_path) };
    let Ok(file) = resolve_key(game_path, key) else { return };
    let mut dir = file.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        let Ok(rel) = d.strip_prefix(&root) else { break };
        let depth = rel.components().count();
        if depth == 0 {
            break;
        }
        let name = rel.to_string_lossy();
        if depth == 1 && TOP_FOLDERS.iter().any(|t| t.eq_ignore_ascii_case(&name)) {
            break;
        }
        let empty = fs::read_dir(&d).map(|mut it| it.next().is_none()).unwrap_or(false);
        if !empty || fs::remove_dir(&d).is_err() {
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
}

fn with_suffix(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(".disabled");
    PathBuf::from(s)
}

fn remove_files(game_path: &str, mods: &GameMods, id: &str) -> Result<(), String> {
    let Some(entry) = mods.get(id) else { return Ok(()) };
    let claimed: HashSet<&String> = mods.iter().filter(|(k, _)| k.as_str() != id).flat_map(|(_, e)| e.files.iter()).collect();
    for key in &entry.files {
        if claimed.contains(key) {
            continue;
        }
        let Ok(p) = resolve_key(game_path, key) else { continue };
        for f in [p.clone(), with_suffix(&p)] {
            match fs::remove_file(&f) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(friendly(e)),
            }
        }
        prune_empty_dirs(game_path, key);
    }
    Ok(())
}

fn set_files_enabled(game_path: &str, files: &[String], enabled: bool) -> Result<(), String> {
    for key in files {
        if !is_toggleable(key) {
            continue;
        }
        let on = resolve_key(game_path, key)?;
        let off = with_suffix(&on);
        if enabled && off.exists() {
            if on.exists() {
                fs::remove_file(&off).map_err(friendly)?;
            } else {
                fs::rename(&off, &on).map_err(friendly)?;
            }
        } else if !enabled && on.exists() {
            if off.exists() {
                fs::remove_file(&off).map_err(friendly)?;
            }
            fs::rename(&on, &off).map_err(friendly)?;
        }
    }
    Ok(())
}

/// Unpacks a mod zip into the game. `meta` carries id, name, owner, version, icon, desc, local.
pub fn install(store: &Store, game_path: &str, mut meta: Entry, zip_path: &Path) -> Result<Entry, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Could not open the mod file: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("That file is not a valid zip: {e}"))?;

    let mut indexes = Vec::new();
    let mut names = Vec::new();
    for i in 0..archive.len() {
        let f = archive.by_index(i).map_err(|e| e.to_string())?;
        if !f.is_dir() {
            indexes.push(i);
            names.push(f.name().to_string());
        }
    }
    let routes = plan_routes(&names, meta.id == LOADER_ID);
    let mut jobs: Vec<(usize, String, PathBuf)> = Vec::new();
    for (n, route) in routes.into_iter().enumerate() {
        if let Some(key) = route {
            let dest = resolve_key(game_path, &key)?;
            jobs.push((indexes[n], key, dest));
        }
    }
    if jobs.is_empty() {
        return Err(format!("{} has no files BoneLaunch knows how to install.", meta.name));
    }

    let mut mods = load(store, game_path);
    let previous_enabled = mods.get(&meta.id).map(|e| e.enabled);
    if previous_enabled.is_some() {
        remove_files(game_path, &mods, &meta.id)?;
    }

    for (index, _, dest) in &jobs {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(friendly)?;
        }
        let _ = fs::remove_file(with_suffix(dest));
        let mut src = archive.by_index(*index).map_err(|e| e.to_string())?;
        let mut out = fs::File::create(dest).map_err(friendly)?;
        io::copy(&mut src, &mut out).map_err(friendly)?;
    }

    let mut seen = HashSet::new();
    meta.files = jobs.into_iter().map(|(_, key, _)| key).filter(|k| seen.insert(k.clone())).collect();
    meta.enabled = previous_enabled.unwrap_or(true);
    meta.installed_at = now_ms();
    if !meta.enabled {
        set_files_enabled(game_path, &meta.files, false)?;
    }
    mods.insert(meta.id.clone(), meta.clone());
    save(store, game_path, mods)?;
    Ok(meta)
}

pub fn uninstall(store: &Store, game_path: &str, id: &str) -> Result<(), String> {
    let mut mods = load(store, game_path);
    if !mods.contains_key(id) {
        return Ok(());
    }
    remove_files(game_path, &mods, id)?;
    mods.remove(id);
    save(store, game_path, mods)
}

/// "manual:Mods/Thing.dll" -> the real file, after checking the id is well formed.
pub fn manual_path(game_path: &str, id: &str) -> Result<PathBuf, String> {
    let bad = || format!("Unknown mod: {id}");
    let rest = id.strip_prefix("manual:").ok_or_else(bad)?;
    let (folder, file) = rest.split_once('/').ok_or_else(bad)?;
    let folder_ok = folder.eq_ignore_ascii_case("Mods") || folder.eq_ignore_ascii_case("Plugins");
    if !folder_ok || file.is_empty() || file.contains('/') || file.contains('\\') || !file.to_lowercase().ends_with(".dll") {
        return Err(bad());
    }
    resolve_key(game_path, &format!("game:{rest}"))
}

pub fn set_enabled(store: &Store, game_path: &str, id: &str, enabled: bool) -> Result<(), String> {
    if let Some(rest) = id.strip_prefix("manual:") {
        manual_path(game_path, id)?;
        return set_files_enabled(game_path, &[format!("game:{rest}")], enabled);
    }
    let mut mods = load(store, game_path);
    let entry = mods.get_mut(id).ok_or("That mod is not installed.")?;
    set_files_enabled(game_path, &entry.files, enabled)?;
    entry.enabled = enabled;
    save(store, game_path, mods)
}

fn scan_manual(game_path: &str, mods: &GameMods) -> Vec<Value> {
    let tracked: HashSet<String> = mods.values().flat_map(|e| e.files.iter().map(|k| k.to_lowercase())).collect();
    let mut out = Vec::new();
    for folder in ["Mods", "Plugins"] {
        let Ok(dir) = fs::read_dir(Path::new(game_path).join(folder)) else { continue };
        let mut names: Vec<String> = dir.flatten().filter(|e| e.path().is_file()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for n in names {
            let lower = n.to_lowercase();
            let (dll, enabled) = if lower.ends_with(".dll") {
                (n.clone(), true)
            } else if lower.ends_with(".dll.disabled") {
                (n[..n.len() - ".disabled".len()].to_string(), false)
            } else {
                continue;
            };
            if tracked.contains(&format!("game:{folder}/{dll}").to_lowercase()) {
                continue;
            }
            out.push(json!({
                "id": format!("manual:{folder}/{dll}"),
                "name": &dll[..dll.len() - 4],
                "owner": format!("{folder} folder"),
                "version": "",
                "icon": "",
                "desc": "",
                "enabled": enabled,
                "manual": true
            }));
        }
    }
    out
}

/// Everything shown on the Installed page: tracked mods, then mods added by hand.
pub fn list(store: &Store, game_path: &str) -> Vec<Value> {
    let mods = load(store, game_path);
    let mut out: Vec<Value> = mods
        .values()
        .filter(|e| e.id != LOADER_ID)
        .map(|e| {
            json!({
                "id": e.id, "name": e.name, "owner": e.owner, "version": e.version, "icon": e.icon,
                "desc": e.desc, "local": e.local, "enabled": e.enabled, "installedAt": e.installed_at,
                "fileCount": e.files.len()
            })
        })
        .collect();
    out.extend(scan_manual(game_path, &mods));
    out
}

pub fn apply_enabled(store: &Store, game_path: &str, enabled_ids: &[String]) -> Result<(), String> {
    let want: HashSet<&String> = enabled_ids.iter().collect();
    for m in list(store, game_path) {
        let id = m.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let is_on = m.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        if is_on != want.contains(&id) {
            set_enabled(store, game_path, &id, want.contains(&id))?;
        }
    }
    Ok(())
}

pub fn read_zip_manifest(zip_path: &Path) -> Option<Value> {
    let file = fs::File::open(zip_path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut entry = archive.by_name("manifest.json").ok()?;
    let mut text = String::new();
    io::Read::read_to_string(&mut entry, &mut text).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

pub fn is_tracked(store: &Store, game_path: &str, id: &str) -> bool {
    load(store, game_path).contains_key(id)
}
