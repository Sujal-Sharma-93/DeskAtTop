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
