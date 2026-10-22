//! Thin, purpose-built wrappers over the Win32 calls needed for the
//! desktop-level window behaviour: the wallpaper layer's WorkerW hosting and
//! the foreground-window probes.
//!
//! The safe surface is deliberately tiny so the rest of the app never has to
//! reason about raw handles.

#![cfg(windows)]

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_FROM_FLAGS, MONITORINFO, MONITOR_DEFAULTTONEAREST, MonitorFromWindow};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowW, GetClassNameW, GetForegroundWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, GWL_EXSTYLE, GWL_STYLE,
    RegisterWindowMessageW, SWP_NOACTIVATE, SWP_NOZORDER,
    SWP_SHOWWINDOW, SendMessageTimeoutW, SMTO_ABORTIFHUNG, SetParent, SetWindowLongPtrW,
    SetWindowPos, WINDOW_EX_STYLE, WS_CHILD, WS_EX_APPWINDOW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
};

/// Broadcast by Explorer to all top-level windows when the shell restarts.
pub fn shell_restart_message() -> u32 {
    unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) }
}

/// Undocumented Explorer message that spawns the extra `WorkerW` sitting
/// *behind* the desktop icon view. This is the classic hook point for
/// wallpaper layers.
const MSG_CREATE_WORKERW: u32 = 0x052C;

/// Find the `WorkerW` that hosts the desktop icon view, creating it if needed.
pub fn desktop_icon_workerw() -> Option<HWND> {
    unsafe {
        let progman = FindWindowW(w!("Progman"), windows::core::PCWSTR::null()).ok()?;

        let mut behind: usize = 0;
        SendMessageTimeoutW(
            progman,
            MSG_CREATE_WORKERW,
            WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            1000,
            Some(&mut behind),
        );
        if behind != 0 {
            return Some(HWND(behind as *mut core::ffi::c_void));
        }

        // Fall back to the last WorkerW in z-order: Explorer parents
        // SHELLDLL_DefView to the final one it created.
        let mut ctx: (Option<HWND>, Option<HWND>) = (None, None);
        let _ = EnumWindows(Some(enum_workerw), LPARAM(&mut ctx as *mut _ as isize));
        let (first, last) = ctx;
        first.or(last).or(Some(progman))
    }
}

// EnumWindows callbacks must return BOOL(1) to continue.
const BOOL_TRUE: windows::core::BOOL = windows::core::BOOL(1);

/// Collects the first and last `WorkerW` windows seen while enumerating.
unsafe extern "system" fn enum_workerw(h: HWND, l: LPARAM) -> windows::core::BOOL {
    let p = l.0 as *mut (Option<HWND>, Option<HWND>);
    if !p.is_null() {
        if let Some(name) = class_name(h) {
            if name == "WorkerW" {
                let entry = &mut *p;
                if entry.0.is_none() {
                    entry.0 = Some(h);
                }
                entry.1 = Some(h);
            }
        }
    }
    BOOL_TRUE
}

pub fn class_name(hwnd: HWND) -> Option<String> {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    if n == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..n as usize]))
}

fn get_style(hwnd: HWND, index: windows::Win32::UI::WindowsAndMessaging::WINDOW_LONG_PTR_INDEX) -> isize {
    unsafe { GetWindowLongPtrW(hwnd, index) }
}

fn set_style(hwnd: HWND, index: windows::Win32::UI::WindowsAndMessaging::WINDOW_LONG_PTR_INDEX, value: isize) {
    unsafe {
        SetWindowLongPtrW(hwnd, index, value);
    }
}

/// Become a child of the Explorer's `WorkerW`, i.e. render as part of the
/// desktop underneath the icon view.
pub fn reparent_into_desktop(hwnd: HWND, parent: HWND, width: i32, height: i32) -> bool {
    unsafe {
        let ex = WINDOW_EX_STYLE(get_style(hwnd, GWL_EXSTYLE) as u32)
            | WS_EX_NOACTIVATE
            | WS_EX_TOOLWINDOW
            | WS_EX_LAYERED;
        set_style(hwnd, GWL_EXSTYLE, (ex.0 as isize) & !(WS_EX_APPWINDOW.0 as isize));

        if SetParent(hwnd, Some(parent)).is_err() {
            return false;
        }
        // A cross-process reparent must drop WS_POPUP or the shell skips it.
        let style = (get_style(hwnd, GWL_STYLE) as u32 & !(WS_POPUP.0 as u32)) | WS_CHILD.0 as u32;
        set_style(hwnd, GWL_STYLE, style as isize);

        SetWindowPos(hwnd, None, 0, 0, width, height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW)
            .is_ok()
    }
}

pub fn monitor_rect(hwnd: HWND) -> Option<RECT> {
    let monitor: MONITOR_FROM_FLAGS = MONITOR_DEFAULTTONEAREST;
    let hm = unsafe { MonitorFromWindow(hwnd, monitor) };
    if hm.is_invalid() {
        return None;
    }
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetMonitorInfoW(hm, &mut info) }.as_bool() {
        Some(info.rcMonitor)
    } else {
        None
    }
}

const TOLERANCE: i32 = 4;

/// Heuristic fullscreen test: does the foreground window cover its whole
/// monitor? Shell surfaces are excluded because they legitimately do.
pub fn foreground_is_fullscreen() -> bool {
    let fg = unsafe { GetForegroundWindow() };
    if fg.is_invalid() || is_our_process_window(fg) {
        return false;
    }
    if let Some(name) = class_name(fg) {
        if matches!(
            name.as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Button" | "TaskListThumbnailWnd"
        ) {
            return false;
        }
    }
    let mut wr = RECT::default();
    if unsafe { GetWindowRect(fg, &mut wr) }.is_err() {
        return false;
    }
    let Some(mr) = monitor_rect(fg) else { return false };
    wr.left <= mr.left + TOLERANCE
        && wr.top <= mr.top + TOLERANCE
        && wr.right >= mr.right - TOLERANCE
        && wr.bottom >= mr.bottom - TOLERANCE
}

pub fn is_our_process_window(hwnd: HWND) -> bool {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid == std::process::id()
}
