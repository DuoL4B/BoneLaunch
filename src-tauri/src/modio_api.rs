//! Optional: talks to mod.io's API with the user's own key, for the built-in Browse tab.
//!
//! The key travels as a query parameter (that is how mod.io's API takes it), so
//! errors are always reported without the request address.
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::Path;

const API: &str = "https://api.mod.io/v1";
const PAGE: u64 = 30;

async fn get(http: &reqwest::Client, path: &str, key: &str, extra: &[(&str, String)]) -> Result<Value, String> {
    let res = http
        .get(format!("{API}{path}"))
        .query(&[("api_key", key)])
        .query(extra)
        .header("Accept", "application/json")
        .header("X-Modio-Platform", "windows")
        .send()
        .await
        .map_err(|e| format!("Could not reach mod.io. ({})", e.without_url()))?;
    match res.status().as_u16() {
        200..=299 => res.json().await.map_err(|e| format!("mod.io sent something BoneLaunch could not read. ({})", e.without_url())),
        401 | 403 => Err("mod.io did not accept that key. Check it in Settings.".into()),
        429 => Err("mod.io asked BoneLaunch to slow down. Try again in a minute.".into()),
        code => Err(format!("mod.io answered with error {code}.")),
    }
}

/// Checks the key works and finds BONELAB's id on mod.io.
pub async fn find_game(http: &reqwest::Client, key: &str) -> Result<u64, String> {
    let v = get(http, "/games", key, &[("name_id", "bonelab".to_string())]).await?;
    v.pointer("/data/0/id").and_then(Value::as_u64).ok_or_else(|| "The key works, but mod.io did not list BONELAB for it.".to_string())
}

fn slim(m: &Value) -> Value {
    let text = |p: &str| m.pointer(p).and_then(Value::as_str).unwrap_or("").to_string();
    let num = |p: &str| m.pointer(p).and_then(Value::as_u64).unwrap_or(0);
    json!({
        "id": num("/id"),
        "name": text("/name"),
        "summary": text("/summary").chars().take(220).collect::<String>(),
        "author": text("/submitted_by/username"),
        "logo": text("/logo/thumb_320x180"),
        "downloads": num("/stats/downloads_total"),
        "rating": text("/stats/ratings_display_text"),
        "updated": num("/date_updated") * 1000,
        "url": text("/profile_url"),
        "size": num("/modfile/filesize"),
        "version": text("/modfile/version"),
        "mature": num("/maturity_option") != 0
    })
}

pub async fn search(http: &reqwest::Client, key: &str, game: u64, q: &str, sort: &str, offset: u64, show_mature: bool) -> Result<Value, String> {
    let sort = match sort {
        "downloads" => "-downloads_total",
        "newest" => "-date_live",
        "updated" => "-date_updated",
        "name" => "name",
        _ => "-popular",
    };
    let mut extra = vec![("_limit", PAGE.to_string()), ("_offset", offset.to_string()), ("_sort", sort.to_string())];
    if !q.trim().is_empty() {
        extra.push(("_q", q.trim().chars().take(80).collect()));
    }
    let v = get(http, &format!("/games/{game}/mods"), key, &extra).await?;
    let all: Vec<Value> = v.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
    let fetched = all.len() as u64;
    let mods: Vec<Value> = all.iter().map(slim).filter(|m| show_mature || !m["mature"].as_bool().unwrap_or(false)).collect();
    Ok(json!({
        "mods": mods,
        "total": v.get("result_total").and_then(Value::as_u64).unwrap_or(0),
        "next": offset + fetched,
        "more": fetched == PAGE
    }))
}

/// Finds the Windows download for a mod: (address, size in bytes).
pub async fn windows_file(http: &reqwest::Client, key: &str, game: u64, mod_id: u64) -> Result<(String, u64), String> {
    let m = get(http, &format!("/games/{game}/mods/{mod_id}"), key, &[]).await?;
    let mut file = m.get("modfile").cloned().unwrap_or(Value::Null);
    let platforms = m.get("platforms").and_then(Value::as_array).cloned().unwrap_or_default();
    let windows = platforms.iter().find(|p| p.get("platform").and_then(Value::as_str) == Some("windows"));
    if !platforms.is_empty() && windows.is_none() {
        return Err("This mod has no Windows version, only one for the standalone headset.".into());
    }
    if let Some(live) = windows.and_then(|p| p.get("modfile_live")).and_then(Value::as_u64) {
        if file.get("id").and_then(Value::as_u64) != Some(live) {
            file = get(http, &format!("/games/{game}/mods/{mod_id}/files/{live}"), key, &[]).await?;
        }
    }
    let url = file.pointer("/download/binary_url").and_then(Value::as_str).unwrap_or("").to_string();
    if url.is_empty() {
        return Err("mod.io has no downloadable file for this mod.".into());
    }
    Ok((url, file.get("filesize").and_then(Value::as_u64).unwrap_or(0)))
}

pub async fn download(http: &reqwest::Client, url: &str, dest: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "mod.io gave a download address BoneLaunch could not read.".to_string())?;
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let trusted = ["mod.io", "modapi.io", "modcdn.io"].iter().any(|d| host == *d || host.ends_with(&format!(".{d}")));
    if parsed.scheme() != "https" || !trusted {
        return Err("Refusing to download from an address that is not mod.io.".into());
    }
    let mut res = http.get(parsed).send().await.map_err(|e| format!("The download failed. ({})", e.without_url()))?;
    if !res.status().is_success() {
        return Err(format!("The download failed. ({})", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(0);
    let mut out = fs::File::create(dest).map_err(|e| format!("Could not save the download: {e}"))?;
    let mut done = 0u64;
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("The download was interrupted. ({})", e.without_url()))? {
        out.write_all(&chunk).map_err(|e| format!("Could not save the download: {e}"))?;
        done += chunk.len() as u64;
        progress(done, total);
    }
    Ok(())
}
