//! Finds BONELAB on this PC (Steam or Meta) and launches it.
use crate::store::{s_bool, s_str};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

const STEAM_APPID: &str = "1592190";
const STEAM_EXE: &str = "BONELAB_Steam_Windows64.exe";
const META_EXE: &str = "BONELAB_Oculus_Windows64.exe";
const META_FOLDER: &str = "stress-level-zero-inc-bonelab";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Clone, Default)]
pub struct Loader {
    pub installed: bool,
    pub version: String,
}

#[derive(Serialize, Clone, Default)]
pub struct Install {
    pub platform: String,
    pub path: String,
    pub exe: String,
    pub build: String,
    #[serde(rename = "steamExe")]
    pub steam_exe: String,
    pub custom: bool,
    pub loader: Loader,
}

#[derive(Serialize, Clone, Default)]
pub struct Detection {
    pub installs: Vec<Install>,
    pub active: Option<Install>,
    #[serde(rename = "localLow")]
    pub local_low: String,
}

fn normalize(p: &str) -> PathBuf {
    PathBuf::from(p.trim().replace('/', "\\").trim_end_matches('\\'))
}

/// Reads `"key"   "value"` from Valve's text format.
fn vdf_values(text: &str, key: &str) -> Vec<String> {
    let needle = format!("\"{}\"", key.to_lowercase());
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if !t.to_lowercase().starts_with(&needle) {
            continue;
        }
        let rest = &t[needle.len()..];
        if let (Some(a), Some(b)) = (rest.find('"'), rest.rfind('"')) {
            if b > a {
                out.push(rest[a + 1..b].replace("\\\\", "\\"));
            }
        }
    }
    out
}

fn find_steam() -> Option<Install> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam") {
        if let Ok(p) = key.get_value::<String, _>("SteamPath") {
            roots.push(normalize(&p));
        }
    }
    roots.push(PathBuf::from("C:\\Program Files (x86)\\Steam"));
    roots.push(PathBuf::from("C:\\Program Files\\Steam"));

    for root in roots {
        if !root.exists() {
            continue;
        }
        let mut libs = vec![root.clone()];
        if let Ok(vdf) = fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
            libs.extend(vdf_values(&vdf, "path").iter().map(|p| normalize(p)));
        }
        for lib in libs {
            let manifest = lib.join("steamapps").join(format!("appmanifest_{STEAM_APPID}.acf"));
            let Ok(acf) = fs::read_to_string(&manifest) else { continue };
            let install_dir = vdf_values(&acf, "installdir").into_iter().next().unwrap_or_else(|| "BONELAB".into());
            let build = vdf_values(&acf, "buildid").into_iter().next().unwrap_or_default();
            let dir = lib.join("steamapps").join("common").join(install_dir);
            if dir.join(STEAM_EXE).exists() {
                let steam_exe = root.join("steam.exe");
                return Some(Install {
                    platform: "steam".into(),
                    path: dir.to_string_lossy().into_owned(),
                    exe: STEAM_EXE.into(),
                    build,
                    steam_exe: if steam_exe.exists() { steam_exe.to_string_lossy().into_owned() } else { String::new() },
                    ..Default::default()
                });
            }
        }
    }
    None
}

fn find_meta() -> Option<Install> {
    let mut libs: Vec<PathBuf> = Vec::new();
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Oculus VR, LLC\\Oculus\\Libraries") {
        for name in key.enum_keys().flatten() {
            if let Ok(sub) = key.open_subkey(&name) {
                if let Ok(p) = sub.get_value::<String, _>("OriginalPath") {
                    libs.push(normalize(&p));
                }
            }
        }
    }
    libs.push(PathBuf::from("C:\\Program Files\\Oculus\\Software"));
    libs.push(PathBuf::from("C:\\Program Files\\Meta Horizon\\Software"));
    for lib in libs {
        for dir in [lib.join("Software").join(META_FOLDER), lib.join(META_FOLDER)] {
            if dir.join(META_EXE).exists() {
                return Some(Install {
                    platform: "meta".into(),
                    path: dir.to_string_lossy().into_owned(),
                    exe: META_EXE.into(),
                    ..Default::default()
                });
            }
        }
    }
    None
}

pub fn from_folder(dir: &str) -> Option<Install> {
    if dir.trim().is_empty() {
        return None;
    }
    let p = normalize(dir);
    let (platform, exe) = if p.join(STEAM_EXE).exists() {
        ("steam", STEAM_EXE)
    } else if p.join(META_EXE).exists() {
        ("meta", META_EXE)
    } else {
        return None;
    };
    Some(Install {
        platform: platform.into(),
        path: p.to_string_lossy().into_owned(),
        exe: exe.into(),
        custom: true,
        ..Default::default()
    })
}

/// Pulls "1.2.3" out of a longer version string.
fn clean_version(v: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    for c in v.chars() {
        if c.is_ascii_digit() {
            cur.push(c);
        } else if c == '.' && !cur.is_empty() {
            parts.push(std::mem::take(&mut cur));
        } else if !cur.is_empty() || !parts.is_empty() {
            break;
        }
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    if parts.len() >= 3 {
        parts[..3].join(".")
    } else {
        String::new()
    }
}

/// Reads the ProductVersion text stored inside a DLL's version block.
fn dll_version(path: &Path) -> String {
    let Ok(bytes) = fs::read(path) else { return String::new() };
    let needle: Vec<u8> = "ProductVersion".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let Some(pos) = bytes.windows(needle.len()).position(|w| w == needle.as_slice()) else {
        return String::new();
    };
    let mut i = pos + needle.len();
    while i + 1 < bytes.len() && bytes[i] == 0 && bytes[i + 1] == 0 {
        i += 2;
    }
    let mut units = Vec::new();
    while i + 1 < bytes.len() && units.len() < 64 {
        let u = u16::from_le_bytes([bytes[i], bytes[i + 1]]);
        if u == 0 {
            break;
        }
        units.push(u);
        i += 2;
    }
    clean_version(&String::from_utf16_lossy(&units))
}

pub fn loader_status(game_path: &str) -> Loader {
    let root = Path::new(game_path);
    if !root.join("version.dll").exists() || !root.join("MelonLoader").is_dir() {
        return Loader::default();
    }
    let mut dll = root.join("MelonLoader").join("net6").join("MelonLoader.dll");
    if !dll.exists() {
        dll = root.join("MelonLoader").join("net35").join("MelonLoader.dll");
    }
    Loader { installed: true, version: if dll.exists() { dll_version(&dll) } else { String::new() } }
}

pub fn local_low_mods() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
    PathBuf::from(home).join("AppData").join("LocalLow").join("Stress Level Zero").join("BONELAB").join("Mods")
}

pub fn detect(settings: &Value) -> Detection {
    let steam = find_steam();
    let meta = find_meta();
    let custom = from_folder(&s_str(settings, "customGamePath"));
    let mut active = if custom.is_some() {
        custom
    } else {
        match s_str(settings, "platform").as_str() {
            "steam" => steam.clone(),
            "meta" => meta.clone(),
            _ => steam.clone().or_else(|| meta.clone()),
        }
    };
    if let Some(a) = active.as_mut() {
        a.loader = loader_status(&a.path);
    }
    Detection {
        installs: [steam, meta].into_iter().flatten().collect(),
        active,
        local_low: local_low_mods().to_string_lossy().into_owned(),
    }
}

pub fn is_running() -> bool {
    let out = Command::new("tasklist")
        .args(["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq BONELAB*"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match out {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout).to_lowercase();
            text.contains("bonelab_steam_windows64.exe") || text.contains("bonelab_oculus_windows64.exe")
        }
        Err(_) => false,
    }
}

fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut has = false;
    for c in s.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

/// Starts the game. Returns "steam" or "exe" depending on how it was started.
pub fn launch(game: &Install, settings: &Value, no_mods: bool) -> Result<&'static str, String> {
    let mut args: Vec<String> = Vec::new();
    if no_mods {
        args.push("--no-mods".into());
    }
    if s_bool(settings, "hideConsole") {
        args.push("--melonloader.hideconsole".into());
    }
    if s_bool(settings, "mlDebug") {
        args.push("--melonloader.debug".into());
    }
    args.extend(split_args(&s_str(settings, "launchArgs")));

    let via_steam = game.platform == "steam" && !game.steam_exe.is_empty() && !game.custom;
    let exe = if via_steam { PathBuf::from(&game.steam_exe) } else { Path::new(&game.path).join(&game.exe) };
    let mut cmd = Command::new(&exe);
    if via_steam {
        cmd.arg("-applaunch").arg(STEAM_APPID);
    }
    cmd.args(&args);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn().map_err(|e| format!("Could not start the game: {e}"))?;
    Ok(if via_steam { "steam" } else { "exe" })
}
