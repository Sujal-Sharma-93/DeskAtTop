//! DeskAtTop - a lightweight desktop customization layer.
//!
//! Window topology:
//!   * `box-main`    the launcher box itself: one small borderless,
//!                   transparent top-level window that paints the Quick
//!                   Launch panel and fills its own frame. It is an ordinary
//!                   window - no full-screen overlay, no click-through, and it
//!                   is never registered with the watcher.
//!   * `wallpaper-*` a static-image or muted-video layer. Reparented into
//!                   Explorer's `WorkerW` so it renders *behind* the desktop
//!                   icons.
//!   * `popup`       a small always-on-top reminder window for the schedule.
//!   * `settings`    a normal window, hidden until asked for.
//!
//! Everything stateful lives in the single JSON store owned by
//! `tauri-plugin-store`; the Rust side only keeps transient handles.

mod icons;
mod launcher;
mod png;
mod scheduler;
mod tray;
mod watcher;
mod wallpaper;
mod win;

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::MacosLauncher;

static QUITTING: AtomicBool = AtomicBool::new(false);
static BOX_CREATING: AtomicBool = AtomicBool::new(false);
static BOX_CREATED: AtomicBool = AtomicBool::new(false);

/// The launcher box window: label, size and screen position.
const BOX_LABEL: &str = "box-main";
const BOX_W: f64 = 64.0;
const BOX_H: f64 = 64.0;
const BOX_X: f64 = 80.0;
const BOX_Y: f64 = 80.0;

/// Transient, non-persisted runtime state.
#[derive(Default)]
pub struct AppState {
    /// Whether launcher boxes / widgets are currently on screen.
    pub widgets_visible: AtomicBool,
    /// Live wallpaper is temporarily suspended (fullscreen app, or battery).
    pub live_suspended: AtomicBool,
    /// Whether the live wallpaper is enabled at all.
    pub live_enabled: AtomicBool,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            startup_log(&format!(
                "single-instance: duplicate pid={} focusing existing",
                std::process::id()
            ));
            if let Some(w) = app.get_webview_window(BOX_LABEL) {
                let _ = w.set_focus();
            }
            if let Some(w) = app.get_webview_window("settings") {
                let _ = w.set_focus();
            }
            startup_log("single-instance: focus done");
        }))
        .manage(AppState::default())
        .manage(scheduler::Sched::default())
        .invoke_handler(tauri::generate_handler![
            open_target,
            extract_icons,
            sync_box_window,
            resize_box,
            box_geometry,
            set_box_bounds,
            sync_wallpaper_window,
            wallpaper_image,
            set_desktop_wallpaper,
            set_live_suspended,
            reassert_wallpaper,
            set_widgets_visible,
            open_settings_window,
            ui_error,
            scheduler::sched_replace,
            scheduler::sched_snooze,
            scheduler::sched_dismiss,
            scheduler::sched_clear,
            scheduler::local_parts,
            exit_app,
            ui_ready,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            startup_log(&format!("setup: begin pid={}", std::process::id()));

            let dev_url = handle
                .config()
                .build
                .dev_url
                .as_ref()
                .map(|u| u.to_string())
                .unwrap_or_else(|| "<none: embedded dist>".to_string());
            startup_log(&format!("dev url: {dev_url}"));

            startup_log("setup: box begin");
            sync_box_window_impl(&handle, true)?;
            startup_log("setup: box done");

            startup_log("setup: watcher begin");
            watcher::start(&handle);
            startup_log("setup: watcher done");

            startup_log("setup: tray begin");
            tray::build(&handle)?;
            startup_log("setup: tray done");

            startup_log("setup done");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build DeskAtTop")
            .run(|app, event| {
                if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if !QUITTING.load(Ordering::Relaxed) {
                    // Closing the settings window must not end the session;
                    // the tray is the app's real home.
                    api.prevent_exit();
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                scheduler::dismiss(app);
            }
        });
}

// ------------------------------------------------------------------ commands

#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    launcher::open(&target)
}

#[derive(Serialize)]
struct IconResult {
    path: String,
    /// `data:image/png;base64,...`, or `None` when no icon could be read.
    data: Option<String>,
}

#[tauri::command]
fn extract_icons(paths: Vec<String>) -> Vec<IconResult> {
    paths
        .into_iter()
        .map(|path| {
            let data = icons::icon_png(&path).ok().map(|png| {
                format!(
                    "data:image/png;base64,{}",
                    base64_encode(&png)
                )
            });
            IconResult { path, data }
        })
        .collect()
}

/// Create / destroy the launcher-box window.
///
/// The box is an ordinary top-level window: borderless, transparent, without
/// a taskbar entry and never focused by the app itself. It is deliberately
/// *not* registered with the watcher, so there is no click-through logic
/// anywhere in this path and the desktop keeps receiving its clicks.
pub(crate) fn webview_data_dir(app: &AppHandle, label: &str) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app local data dir: {e}"))?;
    Ok(base.join(label).join("webview"))
}

fn saved_nova_position(app: &AppHandle) -> Option<(f64, f64)> {
    let dir = app.path().app_config_dir().ok()?;
    let text = std::fs::read_to_string(dir.join("settings.json")).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&text).ok()?;
    let nova = doc.get("settings")?.get("nova")?;
    let x = nova.get("x")?.as_f64()?;
    let y = nova.get("y")?.as_f64()?;
    if x.is_finite() && y.is_finite() {
        Some((x, y))
    } else {
        None
    }
}

fn clamp_start_position(app: &AppHandle, x: f64, y: f64) -> (f64, f64) {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return (x, y);
    };
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return (x, y);
    }
    let work = monitor.work_area();
    let left = work.position.x as f64 / scale;
    let top = work.position.y as f64 / scale;
    let right = left + work.size.width as f64 / scale;
    let bottom = top + work.size.height as f64 / scale;
    (
        clamp_f64(x, left, right - BOX_W),
        clamp_f64(y, top, bottom - BOX_H),
    )
}

fn sync_box_window_impl(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if !enabled {
        startup_log("box destroy: begin");
        if let Some(w) = app.get_webview_window(BOX_LABEL) {
            let _ = w.destroy();
        }
        BOX_CREATED.store(false, Ordering::Release);
        BOX_CREATING.store(false, Ordering::Release);
        startup_log("box destroy: done");
        return Ok(());
    }
    if BOX_CREATED.load(Ordering::Acquire) || app.get_webview_window(BOX_LABEL).is_some() {
        startup_log("box create: skipped, already present");
        return Ok(());
    }
    if BOX_CREATING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        startup_log("box create: skipped, creation in progress");
        return Ok(());
    }
    startup_log("box create: guard acquired");

    let (start_x, start_y) = match saved_nova_position(app) {
        Some((x, y)) => {
            startup_log(&format!("box create: saved nova position {x:.0},{y:.0}"));
            clamp_start_position(app, x, y)
        }
        None => (BOX_X, BOX_Y),
    };
    startup_log("box create: builder begin");
    let data_dir = match webview_data_dir(app, BOX_LABEL) {
        Ok(dir) => dir,
        Err(e) => {
            BOX_CREATING.store(false, Ordering::Release);
            return Err(e);
        }
    };
    startup_log(&format!("box create: data dir {data_dir:?}"));
    let builder = WebviewWindowBuilder::new(app, BOX_LABEL, WebviewUrl::App("index.html".into()))
        .title("DeskAtTop")
        .inner_size(BOX_W, BOX_H)
        .position(start_x, start_y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(false)
        .skip_taskbar(true)
        .focusable(true)
        .visible(true)
        .data_directory(data_dir);
    startup_log("box create: builder ready");

    startup_log("box create: build begin");
    let _window = match builder.build() {
        Ok(window) => window,
        Err(e) => {
            BOX_CREATING.store(false, Ordering::Release);
            return Err(format!("{BOX_LABEL}: {e}"));
        }
    };
    BOX_CREATED.store(true, Ordering::Release);
    BOX_CREATING.store(false, Ordering::Release);
    startup_log("box create: build ok");
    startup_log("box create: show skipped, visible in builder");
    startup_log("box create: win32 calls none");
    startup_log("box create: done");

    Ok(())
}

/// Frontend entry point: show or hide the launcher box.
#[tauri::command]
fn sync_box_window(app: AppHandle, enabled: bool) -> Result<(), String> {
    sync_box_window_impl(&app, enabled)
}

#[tauri::command]
fn resize_box(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("invalid box size".to_string());
    }
    let window = app
        .get_webview_window(BOX_LABEL)
        .ok_or_else(|| "box window missing".to_string())?;
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct BoxRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Serialize)]
struct BoxGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    screen: BoxRect,
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    if max < min {
        min
    } else {
        value.clamp(min, max)
    }
}

fn read_box_geometry(window: &tauri::WebviewWindow) -> Result<BoxGeometry, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no current monitor".to_string())?;
    let work = monitor.work_area();
    let screen = BoxRect {
        x: work.position.x as f64 / scale,
        y: work.position.y as f64 / scale,
        width: work.size.width as f64 / scale,
        height: work.size.height as f64 / scale,
    };
    let position = window
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let size = window.inner_size().map_err(|e| e.to_string())?;
    Ok(BoxGeometry {
        x: position.x,
        y: position.y,
        width: size.width as f64,
        height: size.height as f64,
        screen,
    })
}

#[tauri::command]
fn box_geometry(app: AppHandle) -> Result<BoxGeometry, String> {
    let window = app
        .get_webview_window(BOX_LABEL)
        .ok_or_else(|| "box window missing".to_string())?;
    read_box_geometry(&window)
}

#[tauri::command]
fn set_box_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<BoxGeometry, String> {
    if !x.is_finite() || !y.is_finite() || !width.is_finite() || !height.is_finite() {
        return Err("invalid box bounds".to_string());
    }
    if width <= 0.0 || height <= 0.0 {
        return Err("invalid box size".to_string());
    }
    let window = app
        .get_webview_window(BOX_LABEL)
        .ok_or_else(|| "box window missing".to_string())?;
    let screen = read_box_geometry(&window)?.screen;
    let next_x = clamp_f64(x, screen.x, screen.x + screen.width - width);
    let next_y = clamp_f64(y, screen.y, screen.y + screen.height - height);
    window
        .set_position(tauri::LogicalPosition::new(next_x, next_y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    read_box_geometry(&window)
}

#[derive(Deserialize)]
pub struct WallpaperSpec {
    /// `image` (static) or `video` (live).
    pub kind: String,
}

#[tauri::command]
fn sync_wallpaper_window(app: AppHandle, state: tauri::State<'_, AppState>, enabled: bool, spec: Option<WallpaperSpec>) -> Result<(), String> {
    startup_log(&format!("wallpaper sync: begin enabled={enabled}"));
    state.live_enabled.store(enabled, Ordering::Relaxed);
    if !enabled {
        // Fully release: destroy the window so the webview, the decoder and
        // the video element are all released with it.
        wallpaper::destroy_wallpaper_windows(&app);
        state.live_suspended.store(false, Ordering::Relaxed);
        startup_log("wallpaper sync: destroyed");
        return Ok(());
    }
    let spec = spec.unwrap_or(WallpaperSpec { kind: "image".into() });
    let result = wallpaper::create_wallpaper_windows(&app, &spec.kind);
    match &result {
        Ok(()) => startup_log("wallpaper sync: created"),
        Err(e) => startup_log(&format!("wallpaper sync failed: {e}")),
    }
    result
}

#[tauri::command]
fn wallpaper_image(path: String) -> Result<String, String> {
    let data = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{}", base64_encode(&data)))
}

#[tauri::command]
fn set_desktop_wallpaper(path: String) -> Result<Option<String>, String> {
    if path.is_empty() {
        return win::set_wallpaper("");
    }
    let path = std::path::Path::new(&path);
    if !path.is_absolute() {
        return Err("Choose an image file from disk.".to_string());
    }
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "tif" | "tiff"
    ) {
        return Err("Windows supports PNG, JPEG, GIF, BMP, WebP and TIFF images.".to_string());
    }
    let metadata = std::fs::metadata(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if !metadata.is_file() {
        return Err("That path is not an image file.".to_string());
    }
    win::set_wallpaper(&path.to_string_lossy())
}

#[tauri::command]
fn set_live_suspended(app: AppHandle, state: tauri::State<'_, AppState>, suspended: bool) {
    state.live_suspended.store(suspended, Ordering::Relaxed);
    emit_to_all(&app, "wallpaper://suspend", suspended);
}

#[tauri::command]
fn reassert_wallpaper(app: AppHandle) {
    wallpaper::reassert(&app);
}

#[tauri::command]
fn set_widgets_visible(state: tauri::State<'_, AppState>, visible: bool) {
    state.widgets_visible.store(visible, Ordering::Relaxed);
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    tray::open_settings(&app);
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    shutdown(&app);
}

/// Startup probe: proves the overlay webview finished booting.
#[tauri::command]
fn ui_ready(app: AppHandle) {
    startup_log("overlay ready");
    startup_log("deferred windows: begin");
    tauri::async_runtime::spawn(async move {
        match wallpaper::create_popup_window(&app) {
            Ok(()) => startup_log("deferred popup: ok"),
            Err(e) => startup_log(&format!("deferred popup: {e}")),
        }
        startup_log("deferred windows: done");
    });
}

/// Diagnostics: the frontend reports its own failures here so they end up in
/// the startup log next to the Rust-side traces.
#[tauri::command]
fn ui_error(message: String) {
    startup_log(&format!("ui error: {message}"));
}

fn startup_log(line: &str) {
    use std::io::Write;
    let Ok(appdata) = std::env::var("APPDATA") else { return };
    let dir = std::path::Path::new(&appdata).join("com.deskattop.desk");
    let _ = std::fs::create_dir_all(&dir);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("startup.log"))
    {
        let _ = writeln!(f, "{line} {stamp}");
    }
}

pub fn shutdown<R: tauri::Runtime>(app: &AppHandle<R>) {
    QUITTING.store(true, Ordering::Relaxed);
    scheduler::dismiss(app);
    app.exit(0);
}

pub fn emit_to_all<R: tauri::Runtime>(app: &AppHandle<R>, event: &str, payload: impl Serialize + Clone) {
    if let Err(e) = app.emit(event, payload) {
        eprintln!("emit {event} failed: {e}");
    }
}

// ------------------------------------------------------------------- helpers

/// Standard base64 for the icon payloads (no extra crate for 4 KB of data).
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64_encode;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
