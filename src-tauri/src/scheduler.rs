//! Schedule reminders.
//!
//! Occurrences are armed in Rust so they keep firing even when the overlay
//! webview is throttled or hidden, and so one `tokio::sleep` per event
//! replaces any kind of polling loop. Repeating events advance in *local*
//! wall-clock time, so a 09:00 daily reminder stays at 09:00 across DST.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
use windows::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    None,
    Daily,
    Weekly,
    Monthly,
}

fn default_repeat() -> Repeat {
    Repeat::None
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    /// Unix milliseconds of the first occurrence.
    pub at: i64,
    #[serde(default = "default_repeat")]
    pub repeat: Repeat,
    /// Unix milliseconds the user snoozed this occurrence until, if any.
    #[serde(default)]
    pub snoozed_until: Option<i64>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
struct FirePayload {
    id: String,
    title: String,
    body: String,
    /// When this occurrence came due.
    due: i64,
    /// When the next occurrence is, or `None` for a one-shot.
    next: Option<i64>,
}

// ---------------------------------------------------------------- time maths

/// Convert unix seconds to a local `(y, m, d, hh, mm, ss)` tuple.
pub fn to_local(secs: i64) -> (i64, i64, i64, i64, i64, i64) {
    // SAFETY: both calls write into buffers we own.
    unsafe {
        let mut utc = SYSTEMTIME::default();
        let ft = FILETIME {
            dwLowDateTime: (secs as u64 & 0xFFFF_FFFF) as u32,
            dwHighDateTime: ((secs as u64) >> 32) as u32,
        };
        if FileTimeToSystemTime(&ft, &mut utc).is_err() {
            return (1970, 1, 1, 0, 0, 0);
        }
        let mut local = SYSTEMTIME::default();
        if SystemTimeToTzSpecificLocalTime(None, &utc, &mut local).is_err() {
            return from_systemtime(&utc);
        }
        from_systemtime(&local)
    }
}

fn from_systemtime(st: &SYSTEMTIME) -> (i64, i64, i64, i64, i64, i64) {
    (
        st.wYear as i64,
        st.wMonth as i64,
        st.wDay as i64,
        st.wHour as i64,
        st.wMinute as i64,
        st.wSecond as i64,
    )
}

fn systemtime_to_secs(st: &SYSTEMTIME) -> i64 {
    days_from_civil(st.wYear as i64, st.wMonth as i64, st.wDay as i64) * 86_400
        + st.wHour as i64 * 3600
        + st.wMinute as i64 * 60
        + st.wSecond as i64
}

/// Convert a local wall-clock time back to unix seconds.
///
/// The UTC offset depends on the instant, so we resolve it by fixed-point
/// iteration; two passes are enough for every real timezone.
fn from_local(y: i64, m: i64, d: i64, hh: i64, mm: i64, ss: i64) -> i64 {
    let naive = unix_from_civil(y, m, d, hh, mm, ss);
    let mut guess = naive;
    for _ in 0..3 {
        let off = to_local(guess);
        let resolved = systemtime_to_secs(&SYSTEMTIME {
            wYear: off.0 as u16,
            wMonth: off.1 as u16,
            wDay: off.2 as u16,
            wHour: off.3 as u16,
            wMinute: off.4 as u16,
            wSecond: off.5 as u16,
            ..Default::default()
        });
        let offset = resolved - guess;
        let next = naive - offset;
        if next == guess {
            return guess;
        }
        guess = next;
    }
    guess
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

/// Step a local calendar date forward, clamping the day to the target month.
fn step_date(y: i64, m: i64, d: i64, days: i64, clamp: bool) -> (i64, i64, i64) {
    if !clamp {
        let z = days_from_civil(y, m, d) + days;
        return civil_from_days(z);
    }
    let ny = if m == 12 { y + 1 } else { y };
    let nm = if m == 12 { 1 } else { m + 1 };
    (ny, nm, d.min(days_in_month(ny, nm)))
}

/// Advance a unix-ms timestamp by one `repeat` step in local time.
fn advance(from: i64, repeat: Repeat) -> Option<i64> {
    if repeat == Repeat::None {
        return None;
    }
    let (y, m, d, hh, mm, ss) = to_local(from.div_euclid(1000));
    let (ny, nm, nd) = match repeat {
        Repeat::Daily => step_date(y, m, d, 1, true),
        Repeat::Weekly => step_date(y, m, d, 7, false),
        Repeat::Monthly => step_date(y, m, d, 1, true),
        Repeat::None => return None,
    };
    Some(from_local(ny, nm, nd, hh, mm, ss) * 1000)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn unix_from_civil(y: i64, m: i64, d: i64, hh: i64, mm: i64, ss: i64) -> i64 {
    days_from_civil(y, m, d) * 86_400 + hh * 3600 + mm * 60 + ss
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ------------------------------------------------------------------ scheduler

struct CancelFlag(Arc<Mutex<bool>>);

impl CancelFlag {
    fn is_cancelled(&self) -> bool {
        self.0.lock().map(|c| *c).unwrap_or(true)
    }
}

impl Drop for CancelFlag {
    fn drop(&mut self) {
        if let Ok(mut c) = self.0.lock() {
            *c = true;
        }
    }
}

/// Armed events plus their cancellation flags. Managed by Tauri so every
/// command mutates the same instance.
#[derive(Default)]
pub struct Sched {
    flags: Mutex<HashMap<String, CancelFlag>>,
}

impl Sched {
    /// Replace the armed set. Cancels everything currently sleeping, then
    /// re-arms from `events`.
    pub fn replace(&self, app: &AppHandle, events: Vec<Event>) {
        // Dropping the flags first stops the sleeping tasks promptly.
        {
            let mut guard = self.flags.lock().unwrap_or_else(|e| e.into_inner());
            guard.clear();
        }
        for ev in events.into_iter().filter(|e| e.enabled) {
            self.arm(app, ev);
        }
    }

    /// Re-arm a single event (used by snooze, which must not disturb others).
    pub fn arm(&self, app: &AppHandle, ev: Event) {
        let flag = Arc::new(Mutex::new(false));
        {
            let mut guard = self.flags.lock().unwrap_or_else(|e| e.into_inner());
            guard.insert(ev.id.clone(), CancelFlag(flag.clone()));
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            run_event(app, ev, flag).await;
        });
    }

    pub fn clear(&self) {
        let mut guard = self.flags.lock().unwrap_or_else(|e| e.into_inner());
        guard.clear();
    }
}

async fn run_event(app: AppHandle, mut ev: Event, flag: Arc<Mutex<bool>>) {
    let cancel = || flag.lock().map(|c| *c).unwrap_or(true);
    loop {
        let mut due = ev.snoozed_until.unwrap_or(ev.at);

        // Wait in <=30 s slices so a suspend/resume or an edit is noticed
        // promptly instead of overshooting by hours.
        loop {
            if cancel() {
                return;
            }
            let now = now_ms();
            if due <= now {
                break;
            }
            tokio::time::sleep(Duration::from_millis((due - now).min(30_000) as u64)).await;
            if cancel() {
                return;
            }
            if now_ms() >= due {
                break;
            }
        }
        if cancel() {
            return;
        }
        // A clock jump must not fire an occurrence twice in a row.
        if now_ms() + 1_500 < due {
            continue;
        }

        let next = advance(due, ev.repeat);
        ev.snoozed_until = None;
        let _ = app.emit(
            "schedule://fire",
            FirePayload { id: ev.id.clone(), title: ev.title.clone(), body: ev.body.clone(), due, next },
        );
        show_popup(&app, &ev);

        match next {
            Some(n) => {
                if n <= due {
                    return; // defensive: never spin
                }
                ev.at = n;
                due = n;
            }
            None => {
                // One-shot: drop the arming flag but keep the event data in
                // the store (the frontend persists `fired` separately).
                {
                    let state = app.state::<Sched>();
                    let mut guard = state.flags.lock().unwrap_or_else(|e| e.into_inner());
                    guard.remove(&ev.id);
                }
                return;
            }
        }
    }
}

fn show_popup(app: &AppHandle, ev: &Event) {
    if let Some(w) = app.get_webview_window("popup") {
        let _ = w.emit("popup://show", ev);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn sched_replace(app: AppHandle, sched: State<'_, Sched>, events: Vec<Event>) {
    sched.replace(&app, events);
}

#[tauri::command]
pub fn sched_snooze(app: AppHandle, sched: State<'_, Sched>, event: Event, minutes: i64) {
    if let Some(w) = app.get_webview_window("popup") {
        let _ = w.hide();
    }
    let mut ev = event;
    ev.snoozed_until = Some(now_ms() + minutes.clamp(1, 24 * 60) * 60_000);
    sched.arm(&app, ev);
}

/// Hide the popup without going through the command layer (used at shutdown).
pub fn dismiss<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("popup") {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn sched_dismiss(app: AppHandle) {
    dismiss(&app);
}

#[tauri::command]
pub fn sched_clear(sched: State<'_, Sched>) {
    sched.clear();
}

/// Local wall-clock parts for a timestamp, so the UI can prefill date/time
/// inputs without shipping a date library to the frontend.
#[derive(Serialize)]
pub struct LocalParts {
    pub y: i64,
    pub mo: i64,
    pub d: i64,
    pub h: i64,
    pub mi: i64,
}

#[tauri::command]
pub fn local_parts(at: i64) -> LocalParts {
    let (y, mo, d, h, mi, _) = to_local(at.div_euclid(1000));
    LocalParts { y, mo, d, h, mi }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_ms(y: i64, m: i64, d: i64, hh: i64, mm: i64) -> i64 {
        from_local(y, m, d, hh, mm, 0) * 1000
    }

    #[test]
    fn local_roundtrip_preserves_wall_clock() {
        let t = local_ms(2026, 3, 1, 9, 0);
        assert_eq!(to_local(t / 1000), (2026, 3, 1, 9, 0, 0));
    }

    #[test]
    fn daily_keeps_wall_clock_time() {
        let start = local_ms(2026, 3, 1, 9, 0);
        let next = advance(start, Repeat::Daily).unwrap();
        assert_eq!(next - start, 86_400_000);
        assert_eq!(to_local(next / 1000), (2026, 3, 2, 9, 0, 0));
    }

    #[test]
    fn monthly_clamps_to_short_month() {
        let start = local_ms(2026, 1, 31, 8, 15);
        let next = advance(start, Repeat::Monthly).unwrap();
        assert_eq!(to_local(next / 1000), (2026, 2, 28, 8, 15, 0));
    }

    #[test]
    fn monthly_handles_leap_february() {
        let start = local_ms(2024, 1, 31, 8, 0);
        let next = advance(start, Repeat::Monthly).unwrap();
        assert_eq!(to_local(next / 1000), (2024, 2, 29, 8, 0, 0));
    }

    #[test]
    fn monthly_crosses_year_end() {
        let start = local_ms(2026, 12, 15, 8, 0);
        let next = advance(start, Repeat::Monthly).unwrap();
        assert_eq!(to_local(next / 1000), (2027, 1, 15, 8, 0, 0));
    }

    #[test]
    fn weekly_adds_seven_days() {
        let start = local_ms(2026, 9, 28, 7, 30);
        let next = advance(start, Repeat::Weekly).unwrap();
        assert_eq!(to_local(next / 1000), (2026, 10, 5, 7, 30, 0));
    }

    #[test]
    fn one_shot_has_no_next() {
        assert_eq!(advance(local_ms(2026, 1, 1, 0, 0), Repeat::None), None);
    }

    #[test]
    fn daily_across_spring_forward_stays_at_wall_clock() {
        // 2026-03-08 is the US DST change; 09:00 must stay 09:00.
        let start = local_ms(2026, 3, 7, 9, 0);
        let next = advance(start, Repeat::Daily).unwrap();
        assert_eq!(to_local(next / 1000), (2026, 3, 8, 9, 0, 0));
    }
}
