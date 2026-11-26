/// Declares the app's own commands to the ACL.
///
/// Without an app manifest Tauri skips the permission check for app
/// commands, so a typo in a command name silently ships a dead button.
/// With the manifest every command must be allowed explicitly by
/// `capabilities/default.json` (`allow-<command>`), which makes the
/// allowlist explicit and auditable.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "open_target",
            "extract_icons",
            "sync_box_window",
            "resize_box",
            "box_geometry",
            "set_box_bounds",
            "sync_wallpaper_window",
            "import_wallpaper_image",
            "wallpaper_image",
            "set_desktop_wallpaper",
            "set_live_suspended",
            "reassert_wallpaper",
            "set_widgets_visible",
            "open_settings_window",
            "ui_error",
            "sched_replace",
            "sched_snooze",
            "sched_dismiss",
            "sched_clear",
            "local_parts",
            "exit_app",
            "ui_ready",
        ])),
    )
    .expect("failed to run tauri-build");
}
