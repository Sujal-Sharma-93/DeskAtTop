//! System tray integration: the app's only permanent home, since the overlay
//! has no chrome of its own.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

pub const ID_OPEN_SETTINGS: &str = "open-settings";
pub const ID_TOGGLE_WIDGETS: &str = "toggle-widgets";
pub const ID_QUIT: &str = "quit";

/// Build the tray icon plus its two-item menu.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, ID_OPEN_SETTINGS, "Open Settings", true, Some("Ctrl+Shift+D"))?; // keep as is
    let toggle = MenuItem::with_id(app, ID_TOGGLE_WIDGETS, "Toggle Widgets", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Quit DeskAtTop", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &toggle, &sep, &quit])?;

    let builder = TrayIconBuilder::<R>::with_id("main")
        .icon(icon())
        .tooltip("DeskAtTop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                ID_OPEN_SETTINGS => open_settings(app),
                ID_TOGGLE_WIDGETS => toggle_widgets(app),
                ID_QUIT => {
                    crate::shutdown(app);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left click toggles the menu; double click is a shortcut to the
            // most common action.
            if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = event {
                open_settings(tray.app_handle());
            }
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Down, .. } = event {
                let _ = tray;
            }
        });

    builder.build(app)?;
    Ok(())
}

fn icon() -> Image<'static> {
    // Embedded at compile time so the tray is available before any runtime
    // asset is touched. Tauri's `image-png` feature decodes this.
    Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .expect("embedded tray icon must be a valid PNG")
}

pub fn open_settings<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn toggle_widgets<R: Runtime>(app: &AppHandle<R>) {
    crate::emit_to_all(app, "tray://toggle-widgets", ());
}
