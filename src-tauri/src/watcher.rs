//! A single background thread that owns one hidden window and one message
//! pump, and uses it to observe the system **without any polling loops**:
//!
//! * a `SetWinEventHook` foreground hook to detect fullscreen apps;
//! * `RegisterPowerSettingNotification` for AC/battery transitions;
//! * the `TaskbarCreated` broadcast so a wallpaper layer can re-attach after
//!   Explorer restarts.
//!
//! The observer never touches the launcher box: the box is an ordinary
//! top-level window and there is no click-through logic anywhere in the app.

#![cfg(windows)]

use std::sync::{Mutex, MutexGuard, OnceLock};

use tauri::{AppHandle, Emitter};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::{
    GetSystemPowerStatus, RegisterPowerSettingNotification, SYSTEM_POWER_STATUS,
};
use windows::Win32::System::SystemServices::GUID_ACDC_POWER_SOURCE;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DEVICE_NOTIFY_WINDOW_HANDLE, DispatchMessageW,
    EVENT_SYSTEM_FOREGROUND, GetMessageW, MSG, PBT_POWERSETTINGCHANGE, RegisterClassW,
    TranslateMessage, UnregisterClassW, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
    WM_POWERBROADCAST, WNDCLASSW, WS_EX_TOOLWINDOW,
};

const WM_DESTROY: u32 = 0x0002;
/// `PBT_APPPOWERSTATUSCHANGE` is not surfaced by the bindings.
const PBT_APPPOWERSTATUSCHANGE: usize = 0x000A;

const WATCHER_CLASS: PCWSTR = w!("DeskAtTopWatcher");

static APP: OnceLock<AppHandle> = OnceLock::new();

struct Shared {
    /// Cached last verdicts so we only emit genuine transitions.
    last_fullscreen: Option<bool>,
    last_on_battery: Option<bool>,
}

fn shared() -> MutexGuard<'static, Shared> {
    static SHARED: OnceLock<Mutex<Shared>> = OnceLock::new();
    SHARED
        .get_or_init(|| {
            Mutex::new(Shared {
                last_fullscreen: None,
                last_on_battery: None,
            })
        })
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Start the observer thread. `app` is retained purely to emit events.
pub fn start(app: &AppHandle) {
    let _ = APP.set(app.clone());
    std::thread::Builder::new()
        .name("deskatop-watcher".into())
        .spawn(move || pump())
        .expect("spawn watcher thread");
}

fn pump() {
    unsafe {
        let hmodule = match GetModuleHandleW(PCWSTR::null()) {
            Ok(h) => h,
            Err(_) => return,
        };
        let hinstance = HINSTANCE(hmodule.0);

        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: hinstance,
            lpszClassName: WATCHER_CLASS,
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return;
        }

        // A real (never-shown, zero-sized, no-activate) top-level window is
        // required to receive power notifications and broadcast messages.
        let Ok(hwnd) = CreateWindowExW(
            WS_EX_TOOLWINDOW,
            WATCHER_CLASS,
            WATCHER_CLASS,
            Default::default(),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(hinstance),
            None,
        ) else {
            return;
        };

        // AC / battery transitions.
        RegisterPowerSettingNotification(
            HANDLE(hwnd.0),
            &GUID_ACDC_POWER_SOURCE,
            DEVICE_NOTIFY_WINDOW_HANDLE,
        )
        .ok();

        // Foreground changes -> fullscreen detection.
        let hook: HWINEVENTHOOK = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );

        emit_power_state();

        let mut msg = MSG::default();
        'outer: while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            TranslateMessage(&mut msg);
            DispatchMessageW(&mut msg);
            if msg.message == WM_DESTROY {
                break 'outer;
            }
        }

        let _ = UnhookWinEvent(hook);
        let _ = DestroyWindow(hwnd);
        let _ = UnregisterClassW(WATCHER_CLASS, Some(hinstance));
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == crate::win::shell_restart_message() {
        if let Some(app) = APP.get() {
            let _ = app.emit("shell://restarted", ());
        }
        return LRESULT(0);
    }
    match msg {
        WM_POWERBROADCAST => {
            let reason = wparam.0 as usize;
            if reason == PBT_POWERSETTINGCHANGE as usize || reason == PBT_APPPOWERSTATUSCHANGE {
                emit_power_state();
            }
            LRESULT(1) // allow default processing
        }
        WM_DESTROY => LRESULT(0),
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    _event: u32,
    _hwnd: HWND,
    _idobject: i32,
    _idchild: i32,
    _thread: u32,
    _time: u32,
) {
    let Some(app) = APP.get() else { return };

    let fullscreen = crate::win::foreground_is_fullscreen();

    let changed = {
        let mut guard = shared();
        let changed = guard.last_fullscreen != Some(fullscreen);
        guard.last_fullscreen = Some(fullscreen);
        changed
    };
    if changed {
        let _ = app.emit("env://fullscreen", fullscreen);
    }
}

fn emit_power_state() {
    let Some(app) = APP.get() else { return };
    let mut status = SYSTEM_POWER_STATUS::default();
    let on_battery = if unsafe { GetSystemPowerStatus(&mut status) }.is_ok() {
        // ACLineStatus: 1 = offline (on battery), 0 = online, 255 = unknown.
        status.ACLineStatus == 1
    } else {
        false
    };
    {
        let mut guard = shared();
        if guard.last_on_battery == Some(on_battery) {
            return;
        }
        guard.last_on_battery = Some(on_battery);
    }
    let _ = app.emit("env://on-battery", on_battery);
}
