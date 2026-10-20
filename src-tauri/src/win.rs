//! Thin, purpose-built wrappers over the Win32 calls needed for the
//! desktop-level window behaviour: z-order, click-through and WorkerW hosting.
//!
//! The safe surface is deliberately tiny so the rest of the app never has to
//! reason about raw handles.

#![cfg(windows)]

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_FROM_FLAGS, MONITORINFO, MONITOR_DEFAULTTONEAREST, MonitorFromWindow};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, FindWindowW, GetClassNameW, GetCursorPos, GetForegroundWindow, GetParent, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, GWL_EXSTYLE, GWL_STYLE, HWND_NOTOPMOST, PostMessageW,
    RegisterWindowMessageW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
    SW_HIDE, SW_SHOWNOACTIVATE, SendMessageTimeoutW, SMTO_ABORTIFHUNG, SetParent, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, WINDOW_EX_STYLE, WS_CHILD, WS_EX_APPWINDOW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};

/// Post an app-defined message to a specific window.
pub fn broadcast(hwnd: HWND, msg: u32) {
    unsafe {
        let _ = PostMessageW(Some(hwnd), msg, WPARAM(0), LPARAM(0));
    }
}

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

/// Undo [`reparent_into_desktop`], restoring an ordinary top-level window.
pub fn detach_from_desktop(hwnd: HWND) {
    unsafe {
        SetParent(hwnd, None).ok();
        let style = (get_style(hwnd, GWL_STYLE) as u32 & !(WS_CHILD.0 as u32)) | WS_POPUP.0 as u32;
        set_style(hwnd, GWL_STYLE, style as isize);
        ShowWindow(hwnd, SW_HIDE);
    }
}

/// Show without activating, parked at the top of the non-topmost band: above
/// the wallpaper and the desktop icons, but below any application window the
/// user has brought forward.
pub fn show_above_desktop(hwnd: HWND, x: i32, y: i32, w: i32, h: i32) {
    unsafe {
        let ex = WINDOW_EX_STYLE(get_style(hwnd, GWL_EXSTYLE) as u32) | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        set_style(hwnd, GWL_EXSTYLE, (ex.0 as isize) & !(WS_EX_APPWINDOW.0 as isize));
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(hwnd, Some(HWND_NOTOPMOST), x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}

/// Re-park the window at the bottom of the normal band. Explorer raises its
/// desktop window whenever the user clicks the wallpaper, which would
/// otherwise bury us; the foreground hook calls this to recover.
pub fn reassert_zorder(hwnd: HWND) {
    // If we live in the desktop band (child of a WorkerW), staying above the
    // icons means re-inserting above DefView - not a top-level raise.
    if let Ok(parent) = unsafe { GetParent(hwnd) } {
        if let Some(name) = class_name(parent) {
            if name == "WorkerW" {
                if let Some(defview) = find_child_defview(parent) {
                    rack_above_icons(hwnd, defview);
                    return;
                }
            }
        }
    }
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

/// Find the WorkerW that actually hosts SHELLDLL_DefView.
pub fn desktop_icons_workerw() -> Option<HWND> {
    unsafe {
        let mut found: Option<HWND> = None;
        let _ = EnumWindows(Some(enum_workerw_has_defview), LPARAM(&mut found as *mut _ as isize));
        found
    }
}

unsafe extern "system" fn enum_workerw_has_defview(h: HWND, l: LPARAM) -> windows::core::BOOL {
    let p = l.0 as *mut Option<HWND>;
    if !p.is_null() {
        if let Some(name) = class_name(h) {
            if name == "WorkerW" {
                let mut flag: bool = false;
                unsafe extern "system" fn check_defview(hwnd2: HWND, lparam2: LPARAM) -> windows::core::BOOL {
                    let p2 = lparam2.0 as *mut bool;
                    if let Some(name2) = class_name(hwnd2) {
                        if name2 == "SHELLDLL_DefView" {
                            if !p2.is_null() {
                                *p2 = true;
                            }
                            return windows::core::BOOL(0);
                        }
                    }
                    BOOL_TRUE
                }
                let _ = EnumChildWindows(Some(h), Some(check_defview), LPARAM(&mut flag as *mut _ as isize));
                if flag {
                    *p = Some(h);
                    return windows::core::BOOL(0);
                }
            }
        }
    }
    BOOL_TRUE
}

pub fn set_above(hwnd: HWND, above_hwnd: HWND) {
    unsafe {
        let _ = SetWindowPos(hwnd, Some(above_hwnd), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

/// Reparent the overlay into the desktop-band WorkerW as a sibling of
/// `SHELLDLL_DefView`, placed directly above it in z-order.
///
/// Result: above the desktop icons, below normal application windows, and
/// part of the shell's desktop layer so it survives Show Desktop (Win+D).
pub fn reparent_above_icons(hwnd: HWND, width: i32, height: i32) -> bool {
    let Some(workerw) = desktop_icons_workerw() else {
        return false;
    };
    let Some(defview) = find_child_defview(workerw) else {
        return false;
    };
    unsafe {
        let ex = WINDOW_EX_STYLE(get_style(hwnd, GWL_EXSTYLE) as u32)
            | WS_EX_NOACTIVATE
            | WS_EX_TOOLWINDOW;
        set_style(
            hwnd,
            GWL_EXSTYLE,
            ((ex.0 as isize) & !(WS_EX_APPWINDOW.0 as isize)),
        );

        if SetParent(hwnd, Some(workerw)).is_err() {
            return false;
        }
        // Cross-process reparent: drop WS_POPUP, add WS_CHILD.
        let style = (get_style(hwnd, GWL_STYLE) as u32 & !(WS_POPUP.0 as u32)) | WS_CHILD.0 as u32;
        set_style(hwnd, GWL_STYLE, style as isize);

        // Insert directly above DefView, so icons stay below us.
        let placed = SetWindowPos(
            hwnd,
            Some(defview),
            0,
            0,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
        .is_ok();

        // Explorer may bury us when it repaints the desktop; re-assert.
        if placed {
            rack_above_icons(hwnd, defview);
        }
        placed
    }
}

/// Re-insert the overlay directly above DefView, recovering after Explorer
/// raises the desktop icon view.
pub fn rack_above_icons(hwnd: HWND, defview: HWND) {
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(defview),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// The `SHELLDLL_DefView` child of a given WorkerW, if present.
pub fn find_child_defview(parent: HWND) -> Option<HWND> {
    unsafe {
        let mut found: Option<HWND> = None;
        unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
            let p = lparam.0 as *mut Option<HWND>;
            if !p.is_null() {
                if let Some(name) = class_name(hwnd) {
                    if name == "SHELLDLL_DefView" {
                        *p = Some(hwnd);
                        return windows::core::BOOL(0);
                    }
                }
            }
            BOOL_TRUE
        }
        let _ = EnumChildWindows(Some(parent), Some(cb), LPARAM(&mut found as *mut _ as isize));
        found
    }
}

pub fn find_defview() -> Option<HWND> {
    unsafe {
        let mut found: Option<HWND> = None;
        unsafe extern "system" fn find_def(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
            let p = lparam.0 as *mut Option<HWND>;
            if let Some(name) = class_name(hwnd) {
                if name == "SHELLDLL_DefView" {
                    if !p.is_null() {
                        *p = Some(hwnd);
                    }
                    return windows::core::BOOL(0);
                }
            }
            BOOL_TRUE
        }
        let _ = EnumWindows(Some(find_def), LPARAM(&mut found as *mut _ as isize));
        found
    }
}


pub fn hide(hwnd: HWND) {
    unsafe {
        ShowWindow(hwnd, SW_HIDE);
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

pub fn cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.ok().map(|_| (p.x, p.y))
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

pub fn foreground_is_desktop() -> bool {
    let fg = unsafe { GetForegroundWindow() };
    if fg.is_invalid() {
        return false;
    }
    matches!(class_name(fg).as_deref(), Some("Progman" | "WorkerW"))
}

pub fn is_our_process_window(hwnd: HWND) -> bool {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid == std::process::id()
}

/// Toggle WS_EX_TRANSPARENT so the whole window becomes click-through.
pub fn set_click_through(hwnd: HWND, on: bool) {
    let cur = WINDOW_EX_STYLE(get_style(hwnd, GWL_EXSTYLE) as u32);
    let next = if on { cur | WS_EX_TRANSPARENT } else { cur & !WS_EX_TRANSPARENT };
    set_style(hwnd, GWL_EXSTYLE, next.0 as isize);
}
