//! A single background thread that owns one hidden window and one message
//! pump, and uses it to observe the system **without any polling loops**:
//!
//! * raw input (`RIDEV_INPUTSINK`) for cursor movement, so the fullscreen
//!   overlay can flip between click-through and interactive exactly when the
//!   pointer enters or leaves a widget;
//! * a `SetWinEventHook` foreground hook to detect fullscreen apps and to
//!   re-assert our z-order after Explorer raises the desktop window;
//! * `RegisterPowerSettingNotification` for AC/battery transitions;
//! * the `TaskbarCreated` broadcast so a wallpaper layer can re-attach after
//!   Explorer restarts.
//!
//! Everything the frontend wants to tell us arrives over an mpsc channel and
//! is applied on the message thread, so the hot path stays lock-light.

#![cfg(windows)]

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
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
use windows::Win32::UI::Input::{RegisterRawInputDevices, RAWINPUTDEVICE, RIDEV_INPUTSINK};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DEVICE_NOTIFY_WINDOW_HANDLE, DispatchMessageW,
    EVENT_SYSTEM_FOREGROUND, GetMessageW, MSG, PBT_POWERSETTINGCHANGE, RegisterClassW,
    TranslateMessage, UnregisterClassW, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_APP,
    WM_INPUT, WM_POWERBROADCAST, WNDCLASSW, WS_EX_TOOLWINDOW,
};

/// Physical-screen rectangle, in pixels.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }
}

/// Messages from the app threads into the watcher thread.
pub enum Update {
    /// A window (overlay or wallpaper layer) came into existence.
    AddWindow { label: String, hwnd: isize },
    /// A window went away; stop touching its styles.
    RemoveWindow { label: String },
    /// Replace the clickable regions of a window, in physical pixels.
    SetRects { label: String, rects: Vec<Rect> },
    /// Globally force click-through (used when widgets are toggled off).
    SetPassThrough { on: bool },
}

struct Overlay {
    hwnd: HWND,
    rects: Vec<Rect>,
    /// Last applied click-through state, so we only touch styles on change.
    pass_through: bool,
}

struct Shared {
    overlays: HashMap<String, Overlay>,
    global_pass_through: bool,
    /// Cached last verdicts so we only emit genuine transitions.
    last_fullscreen: Option<bool>,
    last_on_battery: Option<bool>,
}

impl Shared {
    fn apply_cursor(&mut self) {
        let Some((cx, cy)) = crate::win::cursor_pos() else { return };
        for overlay in self.overlays.values_mut() {
            let should_pass = self.global_pass_through
                || !overlay.rects.iter().any(|r| r.contains(cx, cy));
            if should_pass != overlay.pass_through {
                overlay.pass_through = should_pass;
                crate::win::set_click_through(overlay.hwnd, should_pass);
            }
        }
    }
}

// Raw window handles are shared across threads here; every access goes through
// the `Mutex`, so the `Send`/`Sync` promise holds.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

static SHARED: OnceLock<Mutex<Shared>> = OnceLock::new();

fn shared() -> MutexGuard<'static, Shared> {
    SHARED
        .get_or_init(|| {
            Mutex::new(Shared {
                overlays: HashMap::new(),
                global_pass_through: false,
                last_fullscreen: None,
                last_on_battery: None,
            })
        })
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

const WM_WAKE: u32 = WM_APP + 1;
const WM_DESTROY: u32 = 0x0002;
/// `PBT_APMPOWERSTATUSCHANGE` is not surfaced by the bindings.
const PBT_APMPOWERSTATUSCHANGE: usize = 0x000A;

const WATCHER_CLASS: PCWSTR = w!("DeskAtTopWatcher");
/// The watcher's message-only window, stored as a raw `isize` so it can live in
/// a `static` without a `Send`/`Sync` wrapper.
static MESSAGE_WINDOW: OnceLock<isize> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Handle used by the rest of the app to push updates into the watcher.
#[derive(Clone)]
pub struct Watcher {
    tx: Sender<Update>,
}

impl Watcher {
    pub fn send(&self, update: Update) {
        if self.tx.send(update).is_err() {
            return; // watcher thread is gone
        }
        // Nudge the pump so queued changes are applied immediately instead of
        // waiting for the next mouse movement.
        if let Some(h) = MESSAGE_WINDOW.get() {
            crate::win::broadcast(HWND(*h as *mut core::ffi::c_void), WM_WAKE);
        }
    }

    pub fn add_window(&self, label: &str, hwnd: isize) {
        self.send(Update::AddWindow { label: label.to_string(), hwnd });
    }

    pub fn remove_window(&self, label: &str) {
        self.send(Update::RemoveWindow { label: label.to_string() });
    }

    pub fn set_rects(&self, label: &str, rects: Vec<Rect>) {
        self.send(Update::SetRects { label: label.to_string(), rects });
    }

    pub fn set_pass_through(&self, on: bool) {
        self.send(Update::SetPassThrough { on });
    }
}

/// Start the watcher thread. `app` is retained purely to emit events.
pub fn start(app: &AppHandle) -> Watcher {
    let _ = APP.set(app.clone());
    let (tx, rx) = mpsc::channel::<Update>();

    std::thread::Builder::new()
        .name("deskatop-watcher".into())
        .spawn(move || pump(rx))
        .expect("spawn watcher thread");

    Watcher { tx }
}

fn pump(rx: Receiver<Update>) {
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
        let _ = MESSAGE_WINDOW.set(hwnd.0 as isize);

        // Raw mouse input with INPUTSINK keeps receiving moves even when the
        // overlay itself is click-through - this is what removes any need for
        // a polling loop.
        RegisterRawInputDevices(
            &[RAWINPUTDEVICE {
                usUsagePage: 0x01, // HID
                usUsage: 0x02,      // mouse
                dwFlags: RIDEV_INPUTSINK,
                hwndTarget: hwnd,
            }],
            std::mem::size_of::<RAWINPUTDEVICE>() as u32,
        )
        .ok();

        // AC / battery transitions.
        RegisterPowerSettingNotification(
            HANDLE(hwnd.0),
            &GUID_ACDC_POWER_SOURCE,
            DEVICE_NOTIFY_WINDOW_HANDLE,
        )
        .ok();

        // Foreground changes -> fullscreen detection + z-order recovery.
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
        drain(&rx, &mut shared());
        shared().apply_cursor();

        let mut msg = MSG::default();
        'outer: while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
            if msg.message == WM_DESTROY {
                break 'outer;
            }
            drain(&rx, &mut shared());
            shared().apply_cursor();
        }

        let _ = UnhookWinEvent(hook);
        let _ = DestroyWindow(hwnd);
        let _ = UnregisterClassW(WATCHER_CLASS, Some(hinstance));
    }
}

fn drain(rx: &Receiver<Update>, guard: &mut Shared) {
    while let Ok(update) = rx.try_recv() {
        match update {
            Update::AddWindow { label, hwnd } => {
                let hwnd = HWND(hwnd as *mut core::ffi::c_void);
                crate::win::set_click_through(hwnd, true);
                guard.overlays.insert(label, Overlay { hwnd, rects: Vec::new(), pass_through: true });
            }
            Update::RemoveWindow { label } => {
                guard.overlays.remove(&label);
            }
            Update::SetRects { label, rects } => {
                if let Some(o) = guard.overlays.get_mut(&label) {
                    o.rects = rects;
                }
            }
            Update::SetPassThrough { on } => {
                guard.global_pass_through = on;
            }
        }
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == crate::win::shell_restart_message() {
        if let Some(app) = APP.get() {
            let _ = app.emit("shell://restarted", ());
        }
        return LRESULT(0);
    }
    match msg {
        // Draining happens right after dispatch in the pump loop.
        WM_WAKE | WM_INPUT => {
            shared().apply_cursor();
            LRESULT(0)
        }
        WM_POWERBROADCAST => {
            let reason = wparam.0 as usize;
            if reason == PBT_POWERSETTINGCHANGE as usize || reason == PBT_APMPOWERSTATUSCHANGE {
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
    let desktop = crate::win::foreground_is_desktop();

    let changed = {
        let mut guard = shared();
        let changed = guard.last_fullscreen != Some(fullscreen);
        guard.last_fullscreen = Some(fullscreen);
        changed
    };
    if changed {
        let _ = app.emit("env://fullscreen", fullscreen);
    }

    // Explorer raises its desktop window on every click of the wallpaper,
    // which buries a non-reparented overlay. Put ourselves back in line.
    if desktop {
        reassert_overlay_zorder(app);
    }
}

fn reassert_overlay_zorder(app: &AppHandle) {
    use tauri::Manager;
    let windows: Vec<_> = app.webview_windows().into_iter().collect();
    for (label, w) in windows {
        if !label.starts_with("overlay-") {
            continue;
        }
        if let Ok(hwnd) = w.hwnd() {
            crate::win::reassert_zorder(hwnd);
        }
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
