//! Talks to Thunderstore's BONELAB community.
use crate::store::Store;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const LIST_URL: &str = "https://thunderstore.io/c/bonelab/api/v1/package/";
const CACHE: &str = "packages.json";
const MAX_AGE_MS: u64 = 30 * 60 * 1000;
pub const LOADER_ID: &str = "LavaGang-MelonLoader";

#[derive(Deserialize)]
struct RawVersion {
    #[serde(default)]
    description: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    version_number: String,
    #[serde(default)]
    dependencies: Vec<String>,
    #[serde(default)]
    download_url: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    date_created: String,
    #[serde(default)]
    website_url: Option<String>,
    #[serde(default)]
    file_size: u64,
}

#[derive(Deserialize)]
struct RawPackage {
    #[serde(default)]
    name: String,
    #[serde(default)]
    full_name: String,
    #[serde(default)]
    owner: String,
    #[serde(default)]
    package_url: String,
    #[serde(default)]
    date_created: String,
    #[serde(default)]
    date_updated: String,
    #[serde(default)]
    rating_score: i64,
    #[serde(default)]
    is_pinned: bool,
    #[serde(default)]
    is_deprecated: bool,
    #[serde(default)]
    has_nsfw_content: bool,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    versions: Vec<RawVersion>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Version {
    pub v: String,
    pub url: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub deps: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Package {
    pub id: String,
    pub name: String,
    pub owner: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub icon: String,
    pub version: String,
    #[serde(default)]
    pub deps: Vec<String>,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub rating: i64,
    #[serde(default)]
    pub cats: Vec<String>,
    #[serde(default)]
    pub updated: String,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub nsfw: bool,
    #[serde(default)]
    pub deprecated: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub site: String,
    #[serde(default)]
    pub versions: Vec<Version>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Catalog {
    #[serde(rename = "fetchedAt")]
    pub fetched_at: u64,
    #[serde(default)]
    pub offline: bool,
    pub list: Vec<Package>,
}

fn slim(p: RawPackage) -> Option<Package> {
    let first = p.versions.first()?;
    Some(Package {
        id: p.full_name,
        name: p.name,
        owner: p.owner,
        desc: first.description.clone(),
        icon: first.icon.clone(),
        version: first.version_number.clone(),
        deps: first.dependencies.clone(),
        downloads: p.versions.iter().map(|v| v.downloads).sum(),
        rating: p.rating_score,
        cats: p.categories,
        updated: p.date_updated,
        created: p.date_created,
        nsfw: p.has_nsfw_content,
        deprecated: p.is_deprecated,
        pinned: p.is_pinned,
        size: first.file_size,
        url: p.package_url,
        site: first.website_url.clone().unwrap_or_default(),
        versions: p
            .versions
            .iter()
            .take(20)
            .map(|v| Version {
                v: v.version_number.clone(),
                url: v.download_url.clone(),
                size: v.file_size,
                date: v.date_created.clone(),
                deps: v.dependencies.clone(),
            })
            .collect(),
    })
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub struct Client {
    pub http: reqwest::Client,
    memory: Mutex<Option<Arc<Catalog>>>,
}

impl Client {
    pub fn new() -> Self {
        let http = reqwest::Client::builder().user_agent("BoneLaunch").build().unwrap_or_default();
        Client { http, memory: Mutex::new(None) }
    }

    fn remember(&self, catalog: Catalog) -> Arc<Catalog> {
        let arc = Arc::new(catalog);
        *self.memory.lock().unwrap() = Some(arc.clone());
        arc
    }

    pub async fn packages(&self, store: &Store, force: bool) -> Result<Arc<Catalog>, String> {
        let fresh = |c: &Catalog| now_ms().saturating_sub(c.fetched_at) < MAX_AGE_MS;
        let in_memory = self.memory.lock().unwrap().clone();
        if !force {
            if let Some(c) = in_memory.as_ref().filter(|c| fresh(c)) {
                return Ok(c.clone());
            }
        }
        let cached: Option<Catalog> = match &in_memory {
            Some(c) => Some((**c).clone()),
            None => store.read(CACHE).and_then(|v| serde_json::from_value(v).ok()),
        };
        if !force {
            if let Some(c) = cached.as_ref().filter(|c| fresh(c)) {
                return Ok(self.remember(c.clone()));
            }
        }

        let fetched: Result<Vec<RawPackage>, String> = async {
            let res = self.http.get(LIST_URL).send().await.map_err(|e| e.to_string())?;
            if !res.status().is_success() {
                return Err(format!("Thunderstore answered {}", res.status().as_u16()));
            }
            res.json::<Vec<RawPackage>>().await.map_err(|e| e.to_string())
        }
        .await;

        match fetched {
            Ok(raw) => {
                let catalog = Catalog { fetched_at: now_ms(), offline: false, list: raw.into_iter().filter_map(slim).collect() };
                if let Ok(v) = serde_json::to_value(&catalog) {
                    let _ = store.write(CACHE, &v);
                }
                Ok(self.remember(catalog))
            }
            Err(err) => match cached {
                Some(mut c) => {
                    c.offline = true;
                    Ok(self.remember(c))
                }
                None => Err(format!("Could not reach Thunderstore. Check your internet connection. ({err})")),
            },
        }
    }

    pub async fn readme(&self, owner: &str, name: &str, version: &str) -> String {
        let safe = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
        if !safe(owner) || !safe(name) || !safe(version) {
            return String::new();
        }
        let url = format!("https://thunderstore.io/api/experimental/package/{owner}/{name}/{version}/readme/");
        let Ok(res) = self.http.get(url).send().await else { return String::new() };
        if !res.status().is_success() {
            return String::new();
        }
        let Ok(data) = res.json::<serde_json::Value>().await else { return String::new() };
        data.get("markdown").and_then(|m| m.as_str()).unwrap_or("").chars().take(20000).collect()
    }

    pub async fn download(&self, url: &str, dest: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
        if !url.starts_with("https://thunderstore.io/") {
            return Err("Refusing to download from an unknown address.".into());
        }
        let mut res = self.http.get(url).send().await.map_err(|e| format!("Download failed ({e})"))?;
        if !res.status().is_success() {
            return Err(format!("Download failed ({})", res.status().as_u16()));
        }
        let total = res.content_length().unwrap_or(0);
        let mut out = fs::File::create(dest).map_err(|e| format!("Could not save the download: {e}"))?;
        let mut done = 0u64;
        while let Some(chunk) = res.chunk().await.map_err(|e| format!("Download interrupted ({e})"))? {
            out.write_all(&chunk).map_err(|e| format!("Could not save the download: {e}"))?;
            done += chunk.len() as u64;
            progress(done, total);
        }
        Ok(())
    }

    pub fn clear_cache(&self, store: &Store) {
        *self.memory.lock().unwrap() = None;
        let _ = fs::remove_file(store.file(CACHE));
    }
}
