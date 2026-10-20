//! DeskAtTop - a lightweight desktop customization layer.
//!
//! Window topology:
//!   * `overlay-*`   one transparent, click-through-if-idle window per monitor,
//!                   sized to the monitor and never focused. This is where
//!                   launcher boxes and the productivity widgets live.
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

use watcher::Rect;

static QUITTING: AtomicBool = AtomicBool::new(false);

/// Transient, non-persisted runtime state.
#[derive(Default)]
pub struct AppState {
    pub watcher: std::sync::OnceLock<watcher::Watcher>,
    /// Whether launcher boxes / widgets are currently on screen.
    pub widgets_visible: AtomicBool,
    /// Live wallpaper is temporarily suspended (fullscreen app, or battery).
    pub live_suspended: AtomicBool,
    /// Whether the live wallpaper is enabled at all.
    pub live_enabled: AtomicBool,
}

impl AppState {
    fn watcher(&self) -> Option<&watcher::Watcher> {
        self.watcher.get()
    }
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
        .manage(AppState::default())
        .manage(scheduler::Sched::default())
        .invoke_handler(tauri::generate_handler![
            open_target,
            extract_icons,
            set_hit_regions,
            set_overlay_pass_through,
            sync_overlays,
            sync_wallpaper_window,
            set_live_suspended,
            reassert_wallpaper,
            set_widgets_visible,
            open_settings_window,
            scheduler::sched_replace,
            scheduler::sched_snooze,
            scheduler::sched_dismiss,
            scheduler::sched_clear,
            scheduler::local_parts,
            exit_app,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let w = watcher::start(&handle);
            let _ = app.state::<AppState>().watcher.set(w);
            tray::build(&handle)?;
            wallpaper::create_popup_window(&handle)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build DeskAtTop")
            .run(|app, event| {
                if matches!(&event, tauri::RunEvent::Ready) {
                    let state = app.state::<AppState>();
                    let _ = sync_overlays_impl(app, state.inner(), true, "above");
                }
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

/// Clickable regions of one overlay window, in **physical** screen pixels.
#[tauri::command]
fn set_hit_regions(state: tauri::State<'_, AppState>, label: String, rects: Vec<Rect>) {
    if let Some(w) = state.watcher() {
        w.set_rects(&label, rects);
    }
}

#[tauri::command]
fn set_overlay_pass_through(state: tauri::State<'_, AppState>, on: bool) {
    if let Some(w) = state.watcher() {
        w.set_pass_through(on);
    }
}

/// Create / destroy / re-layer the per-monitor overlay windows.
#[tauri::command]
fn sync_overlays(app: AppHandle, state: tauri::State<'_, AppState>, enabled: bool, layer: String) -> Result<(), String> {
    sync_overlays_impl(&app, state.inner(), enabled, &layer)
}

fn sync_overlays_impl<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    enabled: bool,
    layer: &str,
) -> Result<(), String> {
    let existing: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|k| k.starts_with("overlay-"))
        .cloned()
        .collect();

    if !enabled {
        for label in existing {
            if let Some(w) = state.watcher() {
                w.remove_window(&label);
            }
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.destroy();
            }
        }
        return Ok(());
    }

    let monitors = app
        .available_monitors()
        .map_err(|e| format!("cannot enumerate monitors: {e}"))?;

    // Drop overlays for monitors that disappeared.
    for label in &existing {
        let idx: Option<usize> = label.strip_prefix("overlay-").and_then(|s| s.parse().ok());
        match idx {
            Some(i) if i < monitors.len() => {}
            _ => {
                if let Some(w) = state.watcher() {
                    w.remove_window(label);
                }
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.destroy();
                }
            }
        }
    }

    for (i, monitor) in monitors.iter().enumerate() {
        let label = format!("overlay-{i}");
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let pos = monitor.position();
        let w = (size.width as f64 / scale).round();
        let h = (size.height as f64 / scale).round();

        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
            .title("DeskAtTop")
            .inner_size(w, h)
            .position(pos.x as f64 / scale, pos.y as f64 / scale)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(false)
            .skip_taskbar(true)
            .focusable(false)
            .visible(true)
            .build()
            .map_err(|e| format!("overlay {i}: {e}"))?;

        apply_layer(&window, layer, pos.x, pos.y, size.width as i32, size.height as i32);

        if let (Some(hwnd), Some(state)) = (window.hwnd().ok(), state.watcher()) {
            state.add_window(&label, hwnd.0 as isize);
        }
    }

    Ok(())
}

fn apply_layer<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    layer: &str,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) {
    let Ok(hwnd) = window.hwnd() else { return };
    if layer == "behind" {
        if let Some(workerw) = win::desktop_icon_workerw() {
            win::reparent_into_desktop(hwnd, workerw, width, height);
        }
    } else {
        win::show_above_desktop(hwnd, x, y, width, height);
    }
}

#[derive(Deserialize)]
pub struct WallpaperSpec {
    /// `image` (static) or `video` (live).
    pub kind: String,
}

#[tauri::command]
fn sync_wallpaper_window(app: AppHandle, state: tauri::State<'_, AppState>, enabled: bool, spec: Option<WallpaperSpec>) -> Result<(), String> {
    state.live_enabled.store(enabled, Ordering::Relaxed);
    if !enabled {
        // Fully release: destroy the window so the webview, the decoder and
        // the video element are all released with it.
        wallpaper::destroy_wallpaper_windows(&app);
        state.live_suspended.store(false, Ordering::Relaxed);
        return Ok(());
    }
    let spec = spec.unwrap_or(WallpaperSpec { kind: "image".into() });
    wallpaper::create_wallpaper_windows(&app, &spec.kind)
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
    if let Some(w) = state.watcher() {
        // With no widgets on screen the overlay must never intercept a click.
        w.set_pass_through(!visible);
    }
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    tray::open_settings(&app);
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    shutdown(&app);
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
