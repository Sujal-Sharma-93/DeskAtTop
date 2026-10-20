//! The wallpaper layer: one non-interactive window per monitor, reparented
//! into Explorer's `WorkerW` so it renders behind the desktop icons.
//!
//! Creating these windows lazily (and destroying them when the feature is
//! switched off) is what "fully release video resources when off" means in
//! practice - the WebView2 instance, the media element and the decoder all go
//! away with the window.

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

const POPUP_W: f64 = 380.0;
const POPUP_H: f64 = 190.0;

fn is_wallpaper(label: &str) -> bool {
    label.starts_with("wallpaper-")
}

/// Create (or leave alone) the wallpaper windows for every monitor.
pub fn create_wallpaper_windows(app: &AppHandle, kind: &str) -> Result<(), String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("cannot enumerate monitors: {e}"))?;

    // A kind change means the layer's DOM must be rebuilt, so drop and redo.
    destroy_wallpaper_windows(app);

    for (i, monitor) in monitors.iter().enumerate() {
        let label = format!("wallpaper-{i}");
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let pos = monitor.position();
        let url = format!("index.html?layer=wallpaper&kind={kind}");

        WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
            .title("DeskAtTop Wallpaper")
            .inner_size(
                (size.width as f64 / scale).round(),
                (size.height as f64 / scale).round(),
            )
            .position(pos.x as f64 / scale, pos.y as f64 / scale)
            .decorations(false)
            .transparent(false)
            .shadow(false)
            .resizable(false)
            .always_on_top(false)
            .skip_taskbar(true)
            .focusable(false)
            .visible(false)
            .build()
            .map_err(|e| format!("wallpaper {i}: {e}"))?;
    }

    // The webview needs at least one paint before the WorkerW reparent sticks,
    // so attach on the next tick of the event loop.
    let app = app.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        attach_all(&handle);
    });
    let _ = app;
    Ok(())
}

pub fn destroy_wallpaper_windows(app: &AppHandle) {
    let labels: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|k| is_wallpaper(k))
        .cloned()
        .collect();
    for label in labels {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.destroy();
        }
    }
}

/// Re-attach every wallpaper window to the (possibly new) `WorkerW`.
pub fn reassert(app: &AppHandle) {
    attach_all(app);
}

fn attach_all(app: &AppHandle) {
    let Some(workerw) = crate::win::desktop_icon_workerw() else {
        eprintln!("wallpaper: could not locate WorkerW");
        return;
    };
    let monitors = match app.available_monitors() {
        Ok(m) => m,
        Err(_) => return,
    };
    for (i, monitor) in monitors.iter().enumerate() {
        let label = format!("wallpaper-{i}");
        let Some(window) = app.get_webview_window(&label) else { continue };
        let Ok(hwnd) = window.hwnd() else { continue };
        let size = monitor.size();
        if crate::win::reparent_into_desktop(hwnd, workerw, size.width as i32, size.height as i32) {
            let _ = window.set_position(PhysicalPosition::new(0, 0));
        }
    }
}

/// The small always-on-top reminder window used by the schedule widget.
pub fn create_popup_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("popup").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "popup", WebviewUrl::App("index.html?layer=popup".into()))
        .title("DeskAtTop Reminder")
        .inner_size(POPUP_W, POPUP_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .visible(false)
        .build()
        .map_err(|e| format!("popup window: {e}"))?;
    Ok(())
}

/// Used by the overlay to ask the popup to show a specific event.
pub fn show_popup(app: &AppHandle, payload: serde_json::Value) {
    if let Some(w) = app.get_webview_window("popup") {
        let _ = w.emit("popup://show", payload);
        let _ = w.show();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }
}
