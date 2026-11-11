#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod game;
mod mods;
mod store;
mod thunderstore;

use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use store::{s_bool, s_str, Store};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use thunderstore::{Package, Version, LOADER_ID};

struct AppState {
    store: Store,
    ts: thunderstore::Client,
    game: Mutex<game::Detection>,
    /// One mod job at a time, so files never get written by two jobs at once.
    jobs: tokio::sync::Mutex<()>,
    portable: bool,
    /// True while the window is closed and only the tray icon is left.
    sleeping: AtomicBool,
}

const TRAY_ID: &str = "main";

fn set_tray_visible(app: &AppHandle, visible: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(visible);
    }
}

/// Shows the window, building it again if it was closed to save memory.
fn open_window(app: &AppHandle) {
    let st = app.state::<AppState>();
    st.sleeping.store(false, Ordering::SeqCst);
    set_tray_visible(app, false);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    if let Some(cfg) = app.config().app.windows.first() {
        if let Ok(builder) = WebviewWindowBuilder::from_config(app, cfg) {
            let _ = builder.build();
        }
    }
}

/// Closes the window (and with it the web engine) but keeps BoneLaunch alive in the tray.
fn sleep_in_tray(app: &AppHandle) {
    let st = app.state::<AppState>();
    if st.jobs.try_lock().is_err() {
        return; // a mod is being installed; stay awake
    }
    st.sleeping.store(true, Ordering::SeqCst);
    set_tray_visible(app, true);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.destroy();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open BoneLaunch", true, None::<&str>)?;
    let launch = MenuItem::with_id(app, "launch", "Launch BONELAB", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &launch, &quit])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID).tooltip("BoneLaunch").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "open" => open_window(app),
        "launch" => {
            let st = app.state::<AppState>();
            let found = detect(&st);
            if let Some(active) = found.active {
                let _ = game::launch(&active, &st.store.settings(), false);
            } else {
                open_window(app);
            }
        }
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            open_window(tray.app_handle());
        }
    })
    .build(app)?;
    set_tray_visible(app, false);
    Ok(())
}

/// Portable copies (exe name contains "portable") keep data beside the exe.
fn data_dir() -> (PathBuf, bool) {
    if let Ok(custom) = std::env::var("BONELAUNCH_DATA") {
        return (PathBuf::from(custom), false);
    }
    if let Ok(exe) = std::env::current_exe() {
        let name = exe.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        if name.contains("portable") {
            if let Some(dir) = exe.parent() {
                return (dir.join("BoneLaunchData"), true);
            }
        }
    }
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    (PathBuf::from(base).join("BoneLaunch"), false)
}

fn temp_dir() -> PathBuf {
    let d = std::env::temp_dir().join("BoneLaunch");
    let _ = fs::create_dir_all(&d);
    d
}

fn public_settings(st: &AppState) -> Value {
    let mut s = st.store.settings();
    let path = s_str(&s, "bgImage");
    let mut url = String::new();
    if !path.is_empty() {
        if let Ok(bytes) = fs::read(&path) {
            let mime = match Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
                "png" => "image/png",
                "webp" => "image/webp",
                _ => "image/jpeg",
            };
            url = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
        }
    }
    s["bgUrl"] = Value::String(url);
    s
}

fn detect(st: &AppState) -> game::Detection {
    let found = game::detect(&st.store.settings());
    *st.game.lock().unwrap() = found.clone();
    found
}

fn need_game(st: &AppState) -> Result<game::Install, String> {
    st.game.lock().unwrap().active.clone().ok_or_else(|| "BONELAB was not found. Pick the game folder in Settings.".to_string())
}

fn arg_str(args: &[Value], i: usize) -> String {
    args.get(i).and_then(Value::as_str).unwrap_or("").to_string()
}

fn arg_bool(args: &[Value], i: usize) -> bool {
    args.get(i).and_then(Value::as_bool).unwrap_or(false)
}

struct Plan<'a> {
    by_id: &'a HashMap<&'a str, &'a Package>,
    store: &'a Store,
    game_path: &'a str,
    loader_installed: bool,
    install_deps: bool,
    seen: HashSet<String>,
    queue: Vec<(&'a Package, &'a Version)>,
    missing: Vec<String>,
}

impl<'a> Plan<'a> {
    fn visit(&mut self, pid: &str, version: Option<&str>, root: bool) {
        if !self.seen.insert(pid.to_string()) {
            return;
        }
        let Some(p) = self.by_id.get(pid).copied() else {
            self.missing.push(pid.to_string());
            return;
        };
        if !root {
            let have = if pid == LOADER_ID { self.loader_installed } else { mods::is_tracked(self.store, self.game_path, pid) };
            if have {
                return;
            }
        }
        let picked = version.and_then(|w| p.versions.iter().find(|x| x.v == w)).or_else(|| p.versions.first());
        let Some(v) = picked else { return };
        if self.install_deps {
            for d in &v.deps {
                if let Some(i) = d.rfind('-') {
                    self.visit(&d[..i], None, false);
                }
            }
        }
        self.queue.push((p, v));
    }
}

async fn install_with_deps(app: &AppHandle, st: &AppState, id: &str, version: Option<String>) -> Result<Value, String> {
    let active = need_game(st)?;
    let settings = st.store.settings();
    let catalog = st.ts.packages(&st.store, false).await?;
    let by_id: HashMap<&str, &Package> = catalog.list.iter().map(|p| (p.id.as_str(), p)).collect();

    let mut plan = Plan {
        by_id: &by_id,
        store: &st.store,
        game_path: &active.path,
        loader_installed: game::loader_status(&active.path).installed,
        install_deps: s_bool(&settings, "installDeps"),
        seen: HashSet::new(),
        queue: Vec::new(),
        missing: Vec::new(),
    };
    plan.visit(id, version.as_deref(), true);
    let Plan { queue, missing, .. } = plan;

    let count = queue.len();
    let mut installed: Vec<String> = Vec::new();
    for (i, (p, v)) in queue.into_iter().enumerate() {
        let safe: String = format!("{}-{}.zip", p.id, v.v).chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect();
        let zip_path = temp_dir().join(safe);
        let info = |phase: &str, done: u64, total: u64| json!({ "id": p.id, "name": p.name, "index": i + 1, "count": count, "phase": phase, "done": done, "total": total });

        let _ = app.emit("progress", info("download", 0, v.size));
        let mut last = Instant::now();
        let result = st
            .ts
            .download(&v.url, &zip_path, |done, total| {
                if last.elapsed() > Duration::from_millis(80) {
                    last = Instant::now();
                    let _ = app.emit("progress", info("download", done, if total > 0 { total } else { v.size }));
                }
            })
            .await;
        let result = result.and_then(|_| {
            let _ = app.emit("progress", info("install", 0, 0));
            let meta = mods::Entry {
                id: p.id.clone(),
                name: p.name.clone(),
                owner: p.owner.clone(),
                version: v.v.clone(),
                icon: p.icon.clone(),
                desc: p.desc.clone(),
                ..Default::default()
            };
            mods::install(&st.store, &active.path, meta, &zip_path)
        });
        let _ = fs::remove_file(&zip_path);
        match result {
            Ok(_) => installed.push(p.id.clone()),
            // Some required packages are empty placeholders that only point at
            // their replacement (old BoneLib does this). Nothing to unpack is
            // fine for those; it is only a failure for the mod that was asked for.
            Err(e) if i + 1 < count && e.ends_with(mods::NO_FILES) => {}
            Err(e) => return Err(e),
        }
    }
    let _ = app.emit("progress", json!({ "phase": "done" }));
    Ok(json!({ "installed": installed, "missing": missing }))
}

fn open_path(target: &Path) -> Result<(), String> {
    open::that(target).map_err(|e| format!("Could not open it: {e}"))
}

async fn dispatch(app: &AppHandle, window: &WebviewWindow, st: &AppState, channel: &str, args: &[Value]) -> Result<Value, String> {
    match channel {
        "app:init" => {
            let found = detect(st);
            Ok(json!({
                "settings": public_settings(st),
                "game": found,
                "version": app.package_info().version.to_string(),
                "portable": st.portable,
                "dataDir": st.store.dir.to_string_lossy()
            }))
        }
        "settings:set" => {
            st.store.set_settings(args.first().unwrap_or(&Value::Null))?;
            Ok(public_settings(st))
        }
        "settings:reset" => {
            st.store.reset_settings()?;
            Ok(public_settings(st))
        }

        "game:detect" => Ok(json!(detect(st))),
        "game:running" => Ok(json!(game::is_running())),
        "game:browse" => {
            let Some(dir) = rfd::FileDialog::new().set_title("Pick your BONELAB folder").pick_folder() else {
                return Ok(Value::Null);
            };
            let dir = dir.to_string_lossy().into_owned();
            if game::from_folder(&dir).is_none() {
                return Err("That folder does not contain BONELAB. Pick the folder with the BONELAB .exe in it.".into());
            }
            st.store.set_settings(&json!({ "customGamePath": dir }))?;
            let found = detect(st);
            Ok(json!({ "settings": public_settings(st), "game": found }))
        }
        "game:launch" => {
            let active = need_game(st)?;
            let settings = st.store.settings();
            let no_mods = args.first().and_then(|o| o.get("noMods")).and_then(Value::as_bool).unwrap_or(false);
            let via = game::launch(&active, &settings, no_mods)?;
            match s_str(&settings, "afterLaunch").as_str() {
                "minimize" => {
                    let _ = window.minimize();
                }
                "close" => {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(1500)).await;
                        handle.exit(0);
                    });
                }
                _ => {}
            }
            Ok(json!({ "via": via }))
        }

        "ts:list" => {
            let catalog = st.ts.packages(&st.store, arg_bool(args, 0)).await?;
            serde_json::to_value(&*catalog).map_err(|e| e.to_string())
        }
        "ts:readme" => Ok(json!(st.ts.readme(&arg_str(args, 0), &arg_str(args, 1), &arg_str(args, 2)).await)),

        "mods:list" => Ok(json!(mods::list(&st.store, &need_game(st)?.path))),
        "mods:install" => {
            let _job = st.jobs.lock().await;
            let version = args.get(1).and_then(Value::as_str).map(str::to_string);
            let result = install_with_deps(app, st, &arg_str(args, 0), version).await;
            if result.is_err() {
                let _ = app.emit("progress", json!({ "phase": "done" }));
            }
            result
        }
        "mods:uninstall" => {
            let _job = st.jobs.lock().await;
            let active = need_game(st)?;
            let id = arg_str(args, 0);
            if id.starts_with("manual:") {
                let p = mods::manual_path(&active.path, &id)?;
                let mut disabled = p.clone().into_os_string();
                disabled.push(".disabled");
                for f in [p, PathBuf::from(disabled)] {
                    if f.exists() {
                        trash::delete(&f).map_err(|e| format!("Could not move it to the Recycle Bin: {e}"))?;
                    }
                }
            } else {
                mods::uninstall(&st.store, &active.path, &id)?;
            }
            Ok(Value::Null)
        }
        "mods:toggle" => {
            let _job = st.jobs.lock().await;
            mods::set_enabled(&st.store, &need_game(st)?.path, &arg_str(args, 0), arg_bool(args, 1))?;
            Ok(Value::Null)
        }
        "mods:applyEnabled" => {
            let _job = st.jobs.lock().await;
            let ids: Vec<String> = args.first().and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
            mods::apply_enabled(&st.store, &need_game(st)?.path, &ids)?;
            Ok(Value::Null)
        }
        "mods:installZip" => {
            let _job = st.jobs.lock().await;
            let active = need_game(st)?;
            let Some(zip_path) = rfd::FileDialog::new().set_title("Pick a mod zip").add_filter("Mod zip", &["zip"]).pick_file() else {
                return Ok(Value::Null);
            };
            let manifest = mods::read_zip_manifest(&zip_path).unwrap_or(Value::Null);
            let text = |key: &str| manifest.get(key).and_then(Value::as_str).unwrap_or("").to_string();
            let mut name = text("name");
            if name.is_empty() {
                name = zip_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "mod".into());
            }
            let name: String = name.chars().take(80).collect();
            let safe_id: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect();
            let mut desc = text("description");
            if desc.is_empty() {
                desc = "Installed from a zip file.".into();
            }
            let meta = mods::Entry {
                id: format!("local-{safe_id}"),
                name,
                owner: "From a zip file".into(),
                version: text("version_number"),
                desc: desc.chars().take(300).collect(),
                local: true,
                ..Default::default()
            };
            let entry = mods::install(&st.store, &active.path, meta, &zip_path)?;
            Ok(json!(entry.name))
        }

        "ml:uninstall" => {
            let _job = st.jobs.lock().await;
            let active = need_game(st)?;
            let root = Path::new(&active.path);
            let fail = |_| "Could not remove MelonLoader. Close BONELAB and try again.".to_string();
            mods::uninstall(&st.store, &active.path, LOADER_ID).map_err(fail)?;
            for f in ["version.dll", "dobby.dll"] {
                let p = root.join(f);
                if p.exists() {
                    fs::remove_file(p).map_err(|e| fail(e.to_string()))?;
                }
            }
            let folder = root.join("MelonLoader");
            if folder.exists() {
                fs::remove_dir_all(folder).map_err(|e| fail(e.to_string()))?;
            }
            Ok(Value::Null)
        }

        "open:folder" => {
            let key = arg_str(args, 0);
            let target = match key.as_str() {
                "locallow" => game::local_low_mods(),
                "data" => st.store.dir.clone(),
                other => {
                    let root = PathBuf::from(need_game(st)?.path);
                    match other {
                        "game" => root,
                        "mods" => root.join("Mods"),
                        "plugins" => root.join("Plugins"),
                        "userdata" => root.join("UserData"),
                        "logs" => root.join("MelonLoader"),
                        _ => return Err("Unknown folder.".into()),
                    }
                }
            };
            if matches!(key.as_str(), "mods" | "plugins" | "userdata") {
                let _ = fs::create_dir_all(&target);
            }
            if !target.exists() {
                return Err(format!("That folder does not exist yet: {}", target.display()));
            }
            open_path(&target)?;
            Ok(Value::Null)
        }
        "open:url" => {
            let url = arg_str(args, 0);
            if !url.to_lowercase().starts_with("https://") {
                return Err("Only https links can be opened.".into());
            }
            open::that(url).map_err(|e| format!("Could not open the link: {e}"))?;
            Ok(Value::Null)
        }

        "log:read" => {
            let path = Path::new(&need_game(st)?.path).join("MelonLoader").join("Latest.log");
            let Ok(mut file) = fs::File::open(&path) else { return Ok(json!("")) };
            let size = file.metadata().map(|m| m.len()).unwrap_or(0);
            let len = size.min(200 * 1024);
            let _ = file.seek(SeekFrom::Start(size - len));
            let mut buf = Vec::with_capacity(len as usize);
            let _ = file.take(len).read_to_end(&mut buf);
            Ok(json!(String::from_utf8_lossy(&buf)))
        }

        "bg:pick" => {
            let Some(src) = rfd::FileDialog::new().set_title("Pick a background picture").add_filter("Pictures", &["png", "jpg", "jpeg", "webp"]).pick_file() else {
                return Ok(Value::Null);
            };
            let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "jpg".into());
            if let Ok(dir) = fs::read_dir(&st.store.dir) {
                for old in dir.flatten() {
                    if old.file_name().to_string_lossy().starts_with("background.") {
                        let _ = fs::remove_file(old.path());
                    }
                }
            }
            let dest = st.store.file(&format!("background.{ext}"));
            fs::copy(&src, &dest).map_err(|e| format!("Could not copy the picture: {e}"))?;
            st.store.set_settings(&json!({ "bgImage": dest.to_string_lossy() }))?;
            Ok(public_settings(st))
        }

        "cache:clear" => {
            st.ts.clear_cache(&st.store);
            let _ = fs::remove_dir_all(temp_dir());
            Ok(Value::Null)
        }

        "win:min" => {
            let _ = window.minimize();
            Ok(Value::Null)
        }
        "win:max" => {
            if window.is_maximized().unwrap_or(false) {
                let _ = window.unmaximize();
            } else {
                let _ = window.maximize();
            }
            Ok(Value::Null)
        }
        "win:close" => {
            let _ = window.close();
            Ok(Value::Null)
        }

        other => Err(format!("Unknown request: {other}")),
    }
}

#[tauri::command]
async fn call(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    dispatch(&app, &window, &state, &channel, &args).await
}

fn main() {
    let (dir, portable) = data_dir();
    let state = AppState {
        store: Store::new(dir),
        ts: thunderstore::Client::new(),
        game: Mutex::new(game::Detection::default()),
        jobs: tokio::sync::Mutex::new(()),
        portable,
        sleeping: AtomicBool::new(false),
    };

    // A copy pointed at its own data folder (used for testing) may run beside the normal one.
    let mut builder = tauri::Builder::default();
    if std::env::var("BONELAUNCH_DATA").is_err() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            open_window(app);
        }));
    }
    builder
        .setup(|app| {
            build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Resized(_) = event {
                if window.label() == "main" && window.is_minimized().unwrap_or(false) {
                    let app = window.app_handle();
                    if s_bool(&app.state::<AppState>().store.settings(), "sleepInTray") {
                        sleep_in_tray(app);
                    }
                }
            }
        })
        .manage(state)
        .invoke_handler(tauri::generate_handler![call])
        .build(tauri::generate_context!())
        .expect("BoneLaunch could not start")
        .run(|app, event| {
            // Closing the window to sleep must not quit the app; a real quit carries an exit code.
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() && app.state::<AppState>().sleeping.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}
