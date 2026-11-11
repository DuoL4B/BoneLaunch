//! Keeps BoneLaunch itself up to date from the project's GitHub releases.
//!
//! A release counts as an update when it has a file named
//! `BoneLaunch-Setup-<version>.exe` (or `BoneLaunch-Portable-<version>.exe`
//! for portable copies) with a version newer than the running one.
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::Path;

pub const REPO: &str = "DuoL4B/BoneLaunch";

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: String,
    pub name: String,
    pub size: u64,
    #[serde(skip)]
    pub url: String,
    #[serde(skip)]
    pub sha256: String,
}

fn parse(v: &str) -> Vec<u64> {
    v.trim_start_matches('v').split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect()
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (a, b) = (parse(candidate), parse(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// "BoneLaunch-Setup-1.2.0.exe" -> "1.2.0" when the file is the kind we want.
fn version_from_name(name: &str, portable: bool) -> Option<String> {
    let prefix = if portable { "BoneLaunch-Portable-" } else { "BoneLaunch-Setup-" };
    let version = name.strip_prefix(prefix)?.strip_suffix(".exe")?;
    let ok = !version.is_empty() && version.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    ok.then(|| version.to_string())
}

pub async fn check(http: &reqwest::Client, current: &str, portable: bool) -> Result<Option<UpdateInfo>, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let res = http
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not check for updates. ({e})"))?;
    if res.status().as_u16() == 404 {
        return Ok(None); // no releases published yet
    }
    if !res.status().is_success() {
        return Err(format!("Could not check for updates. (GitHub answered {})", res.status().as_u16()));
    }
    let release: Value = res.json().await.map_err(|e| format!("Could not read the update information. ({e})"))?;
    let notes: String = release.get("body").and_then(Value::as_str).unwrap_or("").chars().take(600).collect();
    let allowed = format!("https://github.com/{REPO}/releases/download/");

    let mut best: Option<UpdateInfo> = None;
    for asset in release.get("assets").and_then(Value::as_array).into_iter().flatten() {
        let text = |k: &str| asset.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let name = text("name");
        let Some(version) = version_from_name(&name, portable) else { continue };
        let url = text("browser_download_url");
        if !url.starts_with(&allowed) || !is_newer(&version, current) {
            continue;
        }
        if best.as_ref().map(|b| is_newer(&version, &b.version)).unwrap_or(true) {
            best = Some(UpdateInfo {
                version,
                notes: notes.clone(),
                name,
                size: asset.get("size").and_then(Value::as_u64).unwrap_or(0),
                url,
                sha256: text("digest").strip_prefix("sha256:").unwrap_or("").to_lowercase(),
            });
        }
    }
    Ok(best)
}

/// Downloads the update and checks it against the fingerprint GitHub published for it.
pub async fn download(http: &reqwest::Client, info: &UpdateInfo, dest: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let mut res = http.get(&info.url).send().await.map_err(|e| format!("The update download failed. ({e})"))?;
    if !res.status().is_success() {
        return Err(format!("The update download failed. ({})", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(info.size);
    let mut out = fs::File::create(dest).map_err(|e| format!("Could not save the update: {e}"))?;
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("The update download was interrupted. ({e})"))? {
        out.write_all(&chunk).map_err(|e| format!("Could not save the update: {e}"))?;
        hasher.update(&chunk);
        done += chunk.len() as u64;
        progress(done, total);
    }
    drop(out);
    let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    let size_wrong = info.size > 0 && done != info.size;
    let hash_wrong = !info.sha256.is_empty() && got != info.sha256;
    if size_wrong || hash_wrong {
        let _ = fs::remove_file(dest);
        return Err("The downloaded update did not match what GitHub published, so it was thrown away. Try again later.".into());
    }
    Ok(())
}
