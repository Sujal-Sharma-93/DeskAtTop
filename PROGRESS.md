# PROGRESS

## Known-good facts
- MSVC toolchain works.
- Do NOT use MinGW.
- Do NOT restore `.cargo/config.toml.bak`.
- Do NOT retry cross-process reparenting into WorkerW.
- LSP is configured.
- **Run via `npm run tauri dev` (project root, `%USERPROFILE%\.cargo\bin` on PATH). NEVER launch `src-tauri\target\debug\desk-at-top.exe` standalone** - the build has no `custom-protocol` feature, so the exe always embeds `devUrl` (`http://localhost:5183`) and needs the Vite dev server.
- No `custom-protocol` feature was added: the Stage-2 Cargo.toml change was explicitly REJECTED; dev-mode + `tauri dev` is the sanctioned way to run.
- Rebuild is incremental (~1-2 s) once `target/debug` is warm; a cold build+link takes ~3 min.
- Overlay uses the top-level "above" approach: single `overlay-0`, class `Tauri Window`, title `DeskAtTop`, no parent, `ex=TOOLWINDOW|NOACTIVATE|WS_EX_TRANSPARENT`, `WS_EX_APPWINDOW` removed by `win::show_above_desktop` - never a child of `WorkerW`.
- Dead experiment code removed from `win.rs`: `reparent_above_icons`, `detach_from_desktop`, `find_defview`, `desktop_icons_workerw`, `enum_workerw_has_defview` (no callers; `apply_layer`'s `"behind"` branch and `reparent_into_desktop` remain for the wallpaper path).
- `net::ERR_CONNECTION_REFUSED` on `http://localhost:5183` (Stage 1) is expected ONLY when the exe is run without Vite.

## Current problem
- Stage 2 ran `npm run tauri dev` 5 times (attempts 1-5). Result: **intermittent startup deadlock, ~3 of 5 runs hang the whole app.**
- Exact error text (hung runs): no stdout/stderr/panic; cargo reports `error: process didn't exit successfully: 'target\debug\desk-at-top.exe' (exit code: 0xffffffff)` only because the process is killed. In-run symptom measured with `SendMessageTimeout(WM_NULL, SMTO_ABORTIFHUNG, 1500ms)`:
  `ping=HUNG class='Tauri Window' title='DeskAtTop Settings' / 'DeskAtTop Reminder' / 'DeskAtTop' (x2) / 'tray_icon_app'` - only the watcher thread window (`DeskAtTopWatcher`) answers.
- Hang signature: TWO raw `DeskAtTop` overlay windows exist (`ex=0x08040110`, i.e. `WS_EX_APPWINDOW` still set) -> `apply_layer`/`show_above_desktop` never ran; overlay webview stays at `about:blank`; every frontend `invoke` never resolves (settings + popup pages render an empty `<body>`, `plugin:window|get_all_windows` and `sync_overlays` time out). Consistent with `sync_overlays_impl` being called from `tauri::RunEvent::Ready` (lib.rs:95-98, main thread) - creating webviews from the Ready callback intermittently blocks the event loop.
- Working runs (2 of 5): app fully responsive, one top-level overlay, tray icon present, pages load from Vite.
- Quick Launch box never shows 3 items: the settings webview boots before the overlay exists and `settings.ts:13-24` seeds a box with `items: []`, which is persisted; `main.ts:110-113` only seeds its 3-item starter (Notepad/Calculator/Documents) when `boxes.length === 0`, so the overlay renders "No shortcuts yet" (verified via DOM in the working run, and via `%APPDATA%\com.deskattop.desk\settings.json` in every run).
- Tray icon exists in every run (class `tray_icon_app`); the Quit test could not be completed because the hung runs never processed the menu, and the successful run was torn down before the tray-menu Quit simulation was executed.
- Environment note: enabling `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` (CDP) is NOT the cause - the deadlock occurred with and without it.

## Stages done
- Stage 0: killed leftover processes, `git init` + checkpoint commit ("checkpoint: before crash fix", `6d08655`), created this file.
- Stage 1: diagnosed only. Found the stale exe + dev-URL build; committed `973ebf9`.
- Stage 2: killed leftovers, freed port 5183, confirmed/removed WorkerW-reparent leftovers in `win.rs`, rebuilt via `npm run tauri dev` (no Cargo.toml change), verified by running. Overlay is top-level "above" when the app starts; hit an intermittent startup deadlock and the empty-starter-box seeding issue; stopped after 5 attempts. Teardown done (app stopped, port 5183 free).

## Next stage
- Stage 3 (fix, then re-verify): (1) create the overlay windows in `.setup()` instead of `tauri::RunEvent::Ready` (or otherwise off the Ready callback) so startup cannot deadlock; (2) make the overlay seed the 3 default items (Notepad/Calculator/Documents) regardless of the empty box written by `settings.ts`, or stop `settings.ts` seeding `items: []`; (3) re-run `npm run tauri dev` several times, confirm every run is responsive, the box shows 3 items, and tray Quit leaves no `desk-at-top.exe`.

## Pivot: one small window per box (DONE, verified by the user)
- The full-screen `overlay-0` approach is gone. The app now creates ONE small borderless transparent window `box-main` (300x220 @ 80,80) that paints the Quick Launch panel; `wallpaper-*`, `popup` and `settings` are unchanged. No click-through, no z-order hacks, `box-main` is not registered with the watcher. Desktop icons stay clickable.
- **Root cause of the blank box window:** `src/lib/types.ts` declared `let counter = 0` *below* `DEFAULT_SETTINGS`, which evaluates `starterBox()` -> `uid()` at module load, so the module died with `ReferenceError: Cannot access 'counter' before initialization`. Fix: the id generator is declared above every top-level use. Lesson: before blaming Rust/Tauri, check the page first (the window can exist, be visible and still paint nothing).
- ACL (checked in the tauri 2.12.0 source, `src/webview/mod.rs:2085`): app commands are only ACL-checked when the app declares an app manifest, when the command is a plugin command, or when the origin is remote. `src-tauri/build.rs` now declares an app manifest with all 16 commands and `capabilities/default.json` allows them explicitly (`allow-<command>`), so the allowlist is explicit instead of implicit.
- Diagnostics kept: `%APPDATA%\com.deskattop.desk\startup.log` records `dev url:`, `box url:`, `box visible:`, `setup done`, `overlay ready`; the `ui_error` command pushes frontend JS errors into that log; `index.html` renders a visible "DeskAtTop loading..." card and `src/boot-guard.ts` installs `error`/`unhandledrejection` handlers, so a broken module graph is visible instead of an empty transparent window.
- How to run: `npm run tauri dev` from the project root (Vite on port 5183 + the app). **Never launch `src-tauri\target\debug\desk-at-top.exe` alone** - there is no `custom-protocol` feature, so the exe embeds `devUrl` and needs the Vite server.
- Rules that work: fix the frontend first (hot reload, no rebuild), keep Rust edits in one batch, run `cargo check` once per batch, and keep the budget at ~25 minutes with no dev-run/wait loops from the agent (the user runs the app and reports).

## Verified state
- `cargo check` clean (8 pre-existing warnings); `npm run check` shows only the 5 pre-existing `vite.config.ts` errors (missing `@types/node`); `npm run build:fast` clean.
- User-verified: the box shows the 3 starter items, desktop icons are clickable.

## Step B: hover-expand (DONE)
- The collapsed `box-main` shows only the title pill; hovering the pill opens the item panel (3-column icon grid, real shell icons via `resolveIcons`, letter fallback), leaving the box closes it after `CLOSE_DELAY_MS` (300 ms). Panel is laid out inside the fixed window (opacity/transform only) and `inert` while collapsed, so the window is never resized.
- `npm run build:fast` clean.
- Known issue: the transparent area under the collapsed box still belongs to the window and blocks clicks through to the desktop there. Fix later with a Rust window resize (shrink the window to the pill height when collapsed, restore on expand).

## Step C: settings window with live colors/opacity/radius (DONE)
- Sidebar sections: Boxes, Appearance, About. Plain CSS, no new dependencies, no polling.
- Appearance edits the Quick Launch box style (background / text / accent colours, opacity 0-100, radius 0-32, reset). Built as a reusable `buildStyleControls(binding)` so other widgets can reuse it later.
- Live path: `touch()` serialises an in-memory snapshot with `store.set` immediately (fires plugin-store `onKeyChange` in the box window) and debounces `store.save()` to disk by 300 ms. Each window re-applies via `onSettingsChange`; the box updates vars/title/items in place.
- Box surface now reads `--box-bg`, `--box-text`, `--box-accent`, `--box-opacity`, `--box-radius` (plus `--box-blur`). `--box-bg` is computed as rgba with the opacity folded into the alpha only, so text/icons stay readable.
- Validation: sliders clamp, colours checked with `CSS.supports`, radius clamped 0-32. `normalizeStyle()` folds legacy `rgba()` background alpha into `opacity` and stores opaque hex, so old files keep their look and the slider is idempotent.
- `npm run build:fast` clean; `npm run check` still only the 5 pre-existing `vite.config.ts` errors.

## Step D: add, remove and reorder items with file/folder/URL pickers (DONE)
- Boxes > "+ Add item" opens an inline form with three type buttons: App/File, Folder, URL. App/File and Folder use the existing Tauri dialog plugin (`@tauri-apps/plugin-dialog` `open`); the plugin was already registered in Rust and `dialog:allow-open` was already in `capabilities/default.json`, so no Rust/capability change was needed. The path field also accepts manual input, and a picker failure falls back to typing the path.
- Name defaults to the file/folder basename (URL: hostname, `.exe` stripped for apps) and is editable inline on every item. Icons are still resolved lazily by the box window through the existing `extract_icons` command.
- Reorder with ↑/↓ per item (edges disabled), Remove per item. Add/reorder/edit/remove call `touch()` so the box updates live.
- Validation: empty path/URL rejected, URL must parse as http(s). Manual filesystem paths are not existence-checked (no fs plugin); dialog-picked paths are real.
- `npm run build:fast` clean; `npm run check` still only the 5 pre-existing `vite.config.ts` errors.

## Step E: to-do widget inside the box window (DONE)
- No new Rust window. The title pill now has a small tab row (Launcher | To-do); both panels share the same `box-main` surface and hover-expand behaviour. Tabs live outside the inert panel, so they work while collapsed and clicking one opens the panel.
- To-do features: add on Enter (or Add), check/uncheck, delete, double-click to edit (Enter saves, Escape cancels, empty text deletes), strike-through on done, and an "n left" counter plus a "Clear done" action.
- Data lives in `settings.todo` in the existing store; every mutation calls `touch()`, which publishes immediately and debounces the disk save by 300 ms.
- The to-do panel inherits `--box-bg`, `--box-text`, `--box-accent`, `--box-opacity`, `--box-radius` from the box surface, so the existing Appearance controls style it too.
- Settings has a new Widgets section with a To-do on/off toggle (`settings.widgets.todo.enabled`). Off hides the tab live and switches back to Launcher if needed.
- Lazy: `src/widgets/todo.ts` is a dynamic `import()` from `main.ts`; Vite emits it as a separate `todo-*.js` chunk, fetched only when the widget is enabled. No timers or polling in the widget.
- `npm run build:fast` clean; `npm run check` still only the 5 pre-existing `vite.config.ts` errors.

## Step F: notes widget inside the box window (DONE)
- Third tab, `Notes`, follows the same pattern as To-do: added to the box title pill, lazy-loaded via `import('./widgets/notes')` (separate `notes-*.js` chunk), and gated by a Settings > Widgets toggle (`settings.widgets.notes.enabled`).
- Layout: note list on the left (title = first line of the body, "Untitled" when empty) and a plain-text textarea on the right. Buttons: New and Delete (Delete asks for confirmation). No save button.
- Autosave: edits update a local working copy and debounce the store write by 500 ms. The timer only exists while an edit is pending, so the widget is idle otherwise. Switching notes, switching tabs, hiding the box via the tray toggle, `visibilitychange`, and `beforeunload` all flush the pending edit immediately; the flush path also forces the store's disk write via `flush()` so nothing is lost.
- Data lives in `settings.notes` in the existing store key (`{ notes, activeId }`), with `uid('note')` ids and `updatedAt` timestamps. No new dependencies.
- The panel reads `--box-*` variables from the box surface, so Appearance settings restyle the notes list and editor along with everything else.
- `npm run build:fast` clean (emits `notes-*.js`); `npm run check` still only the 5 pre-existing `vite.config.ts` errors.

## Step G: pomodoro timer widget inside the box window (DONE)
- Fourth tab, `Timer`, lazy-loaded via `import('./widgets/timer')` (separate `timer-*.js` chunk), gated by Settings > Widgets toggle (`settings.widgets.pomodoro.enabled`).
- Modes: Work, Short break, Long break. Durations editable (defaults 25/5/15 min) and "sessions before long break" editable (default 4). Controls: Start, Pause, Reset, Skip. Big mm:ss display with a thin progress bar; animations use transform only.
- Timing is absolute: the store keeps `endsAt` (Unix ms). Remaining time is computed from it on each tick, so it stays accurate when hidden/slept; a single `setInterval` of 1 s runs only while `endsAt` is set and is cleared on pause, finish, hide or disable. No timers when idle.
- On completion, a short two-tone chime is generated with the Web Audio API (no audio files). If notifications are enabled and the `notification` plugin is available/granted, a system notification is sent via `@tauri-apps/plugin-notification`; if not available/denied, it is skipped with no Rust or capability changes. The session counter advances on completed work sessions and the next mode follows the "long every N" rule.
- Running state (mode, `endsAt`, `remainingMs`, `runningSince`, counts) is persisted in `settings.pomodoro`, so a restart does not lose a running timer. Durations can be edited while idle or while showing the config panel without restarting a running session unless reset/start is used.
- Panel reads `--box-*` variables; hide/visibility/beforeunload stop the timer and flush; showing the box resumes it.
- `npm run build:fast` clean; `npm run check` still only the 5 pre-existing `vite.config.ts` errors.

## Step H: schedule reminders widget inside the box window (DONE)
- Fifth tab, `Schedule`, lazy-loaded via `import('./widgets/schedule')` (separate `schedule-*.js` chunk), gated by Settings > Widgets toggle (`settings.widgets.schedule.enabled`).
- Add event form: title, date/time (datetime-local), repeat (None, Daily, Weekly, Monthly). Events are stored in `settings.schedule.events` and synced to the Rust scheduler via `sched_replace` on every change.
- List shows upcoming events sorted by time, with Edit and Delete per row. Inline editing reuses the same form controls.
- The Rust scheduler (in `scheduler.rs`) owns timing: it arms `tokio::sleep` tasks per event, handles repeats in local wall-clock time (survives DST), and fires the existing `schedule://fire` event which shows the popup window (`popup` label) with Snooze/Dismiss buttons. The frontend does no polling.
- Popup uses existing commands: `sched_snooze` (re-arms with `snoozed_until`), `sched_dismiss` (closes popup, clears snooze). No new Rust code or capabilities needed.
- Data in its own key `settings.schedule.events` (array of `ScheduleEvent`). No new dependencies.
- Same `--box-*` CSS variables as other widgets.
- `npm run build:fast` clean (emits `schedule-*.js`); `npm run check` still only the 5 pre-existing `vite.config.ts` errors.

## Step I: box resize + startup deadlock fix (DONE)
- Committed as `31603da feat: resize box, startup fix`; `dist/` stays ignored by `.gitignore`.
- `box-main` now shrinks to the collapsed pill height and restores on expand via the `resize_box` command. The invoke is fire-and-forget with try/catch, a 24 px minimum-height guard, and size/position logging (`box resize expand/collapse/sync`).
- Setup order is now: log `setup: begin` -> `dev url` -> box creation -> watcher -> tray -> `setup done`. Popup creation was removed from setup and happens from a spawned task after the box's `ui_ready`. No autostart call was in setup.
- `wallpaper sync: begin/created/destroyed` and `deferred popup: ok` log lines were added so the next user run can show exactly where a stall happens.
- `cargo check` clean (8 pre-existing warnings); the generated `src-tauri/gen/schemas/*.json` files were refreshed.

## Step J: theme presets + settings backup (DONE)
- Settings > Appearance now has four one-click presets: Dark Glass, Light, Midnight Blue, Warm. Each sets `theme.preset/mode/accent` plus the Quick Launch box `bg/fg/accent/opacity/radius`, calls `touch()`, and re-applies the global theme live.
- Preset definitions live in `src/lib/types.ts`; existing sliders/colour pickers still work and stay in sync through `onSettingsChange`.
- Settings > About now has JSON export/import. There is no `@tauri-apps/plugin-fs` dependency and no fs capability, so the sanctioned fallback is used: Copy JSON writes to the clipboard (and leaves a selectable copy in the text area), Paste JSON reads the clipboard, and Import JSON validates before applying.
- Validation is in `parseImportedSettings()`: schema version, theme, startup, widgets, boxes/items, to-do, notes, pomodoro, schedule events and wallpaper are all checked before any state is replaced. Invalid JSON reports an inline error and leaves the current settings untouched.
- A valid import calls `replaceAll()`, then individually refreshes theme, box, widgets, scheduler, wallpaper and autostart; a failed refresh is reported inline instead of breaking the box.
- `npm run check` still reports only the 5 pre-existing errors; `npm run build:fast` clean (new `settings-*.js`/`settings-*.css` chunks).

## Startup hang: separate WebView2 data directories (DONE, user-verified)
- Symptom: intermittent blank white "Not Responding" window; `startup.log` stopped after `setup: box begin`, meaning `WebviewWindowBuilder::build()` was hanging before `setup: box done`.
- Fix: every webview now gets an explicit per-label data directory: `webview_data_dir()` resolves `<app_local_data_dir>/<label>/webview`, used by `box-main`, popup and wallpaper windows; the config-created hidden `settings` window uses `dataDirectory: "webview"`. This avoids WebView2 user-data-folder lock contention between windows.
- Removed synchronous post-build calls from box setup: `window.url()`, `window.show()` and `window.is_visible()`. The builder's `.visible(true)` handles showing; no blocking call remains after `build()` on the main thread.
- Added precise setup diagnostics: `box create: builder begin / data dir … / builder ready / build begin / build ok / show skipped / win32 calls none / done` plus destroy logs.
- No direct Win32 call exists in the box creation path; `win.rs` is used only by the watcher and wallpaper layers, so any Win32 wait would be internal to Tauri/wry `build()`.
- User-tested: 3 launches OK, title drag works, hover expand works. `cargo check` clean (8 pre-existing warnings).

## v0.1.0 COMPLETE (user-verified)
- Release build finished successfully: `src-tauri\target\release\desk-at-top.exe` (3.85 MB) and `src-tauri\target\release\bundle\nsis\DeskAtTop_0.1.0_x64-setup.exe` (1.35 MiB).
- Standalone release exe was launched from `src-tauri\target\release` with no Vite listener on port 5183; `startup.log` reached `overlay ready`, confirming the frontend is embedded. The launched PID was stopped by PID.
- User installed the NSIS installer and verified: app works, title drag works, hover expand works, items show correctly, and autostart works.
- `dist/` remains ignored; the release artifacts are build outputs and are not committed.

## v0.1.1 COMPLETE (user-verified)
- Commit `3b9c6ed fix: single instance + idempotent box creation` added `tauri-plugin-single-instance`, an idempotent `box-main` creation guard, and PID logging on `setup: begin`.
- User installed the v0.1.1 build and verified: one box, no freeze, and no double window.
- Release build finished successfully; installer: `src-tauri\target\release\bundle\nsis\DeskAtTop_0.1.0_x64-setup.exe` (1,420,462 bytes / 1.35 MiB). The installer is not committed.
- `build-release-background.ps1` was a temporary helper created for the background release build; its path was printed before cleanup and the file is absent.
