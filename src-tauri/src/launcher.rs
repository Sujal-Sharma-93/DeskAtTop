//! Launching the things a launcher box can hold: executables, documents,
//! folders and URLs.

use windows::core::HSTRING;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE;

/// Open `target` with the shell: runs an exe, opens a document in its default
/// app, reveals a folder, or visits a URL.
pub fn open(target: &str) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("empty target".into());
    }
    let verb = HSTRING::from("open");
    let file = HSTRING::from(target);
    // SAFETY: ShellExecuteW is a pure request to the shell; we pass valid,
    // NUL-terminated strings and ignore the (instance) handle it returns.
    let result = unsafe {
        ShellExecuteW(
            None,
            &verb,
            &file,
            None,
            None,
            SW_SHOWNOACTIVATE,
        )
    };
    // ShellExecuteW yields a value > 32 on success.
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!("shell refused to open {target}"))
    }
}
