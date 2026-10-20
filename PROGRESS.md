# PROGRESS

## Known-good facts
- MSVC toolchain works.
- Do NOT use MinGW.
- Do NOT restore `.cargo/config.toml.bak`.
- Do NOT retry cross-process reparenting into WorkerW.
- LSP is configured.
- The app does NOT actually crash: `target\debug\desk-at-top.exe` starts, stays alive, responds, exit code never reached (must be killed). No panic text on stdout/stderr.
- Event Viewer has no crash (1000/1001) entry for desk-at-top.exe; only a historical `Application Hang` (Event 1002, 10/20/2026 19:02:24: "The program desk-at-top.exe version 0.1.0.0 stopped interacting with Windows and was closed ... Hang type: Unknown").
- `src-tauri\Cargo.toml` has NO `[features]` section, so `tauri/custom-protocol` is never enabled -> `tauri-build::is_dev()` = true (`cargo:dev=true`) -> codegen embeds `build.devUrl` instead of `dist`.
- Evidence in the binary: string `localhost:5183` FOUND, `tauri.localhost` NOT FOUND.
- `src-tauri\src\lib.rs` (mtime 19:35:41) is NEWER than `target\debug\desk-at-top.exe` (mtime 18:42:24) -> the exe is a stale build from an older lib.rs.
- `win.rs` (18:39:03) is older than the exe -> win.rs in the exe matches current source.

## Current problem
- Stage 1 diagnosis (no code changed). Two independent faults:
  1. **Stale binary / WorkerW reparent still compiled in.** Window timeline of a live run: overlay `Tauri Window` "DeskAtTop" is created top-level at t~0.58s (`style=0x14CB0000 ex=0x08040110`), then at t~0.92s it becomes a **child of Explorer's `WorkerW`** (`style=...CHILD VIS, no WS_POPUP`, `ex=TOOLWINDOW|NOACTIVATE|WS_EX_TRANSPARENT`, **no `WS_EX_LAYERED`**) -> style signature matches `win::reparent_above_icons()` (win.rs:219), not `reparent_into_desktop()` (which sets `WS_EX_LAYERED`). Current source never calls it (dead code), so the exe was built from the pre-fix lib.rs. Once inside WorkerW it is no longer a top-level window, so it never shows as a normal window -> "overlay never appears".
  2. **Dev-mode build -> pages never load.** All three webviews (settings, popup, overlay) navigate to `http://localhost:5183/` and fail: exact error `net::ERR_CONNECTION_REFUSED` (CDP `Network.loadingFailed type=Document`), then `navigate -> chrome-error://chromewebdata/`, title `localhost`. No Vite dev server is running, so no frontend JS ever executes (settings.ts `syncOverlays(...)` never runs).

### Exact error text
- stdout: (empty) | stderr: (empty) | panic: none | exit code: none (process alive >20s, killed manually)
- WebView2 (CDP): `loadingFailed type=Document error=net::ERR_CONNECTION_REFUSED canceled=false` then `navigate -> chrome-error://chromewebdata/`
- Event Viewer (historical): `Application Hang` 1002 - `The program desk-at-top.exe version 0.1.0.0 stopped interacting with Windows and was closed ... Hang type: Unknown`

### What the failed WorkerW reparent experiment left behind
- `win.rs:219 reparent_above_icons()` - dead (no callers in source, but present in the stale exe).
- `win.rs:128 detach_from_desktop()` - dead (would have been the undo).
- `win.rs:300 find_defview()` - dead; `desktop_icons_workerw()` / `find_child_defview()` / `rack_above_icons()` only reachable from the dead path + `reassert_zorder()`.
- `lib.rs:253 apply_layer` `layer == "behind"` branch + `win::reparent_into_desktop` (still used by `wallpaper.rs:98`), `reassert_zorder()` WorkerW branch (watcher.rs:354).
- `desktop_icon_workerw()` sends undocumented `0x052C` to Progman -> ~13 stray `WorkerW` windows now exist in Explorer for this session.
- Workspace scratch files from the experiment: `chk.py`, `find_def.py`, `fix.py` (raw `SetParent`), `src-tauri/.cargo/config.toml.bak`, `.vscode/settings.json.bak`, `err.txt`, `out.txt`.
- Pre-existing LSP errors (not ours, in `src/main.ts`): `process` not typed, `LaunchKind` type mismatch on `'exe'`/`'dir'` literals.

## Stages done
- Stage 0: killed leftover `desk-at-top.exe` / `node` / `cargo` processes, `git init` + checkpoint commit ("checkpoint: before crash fix", `6d08655`), created this file.
- Stage 1: diagnosed only (no code changes). Ran the exe, checked Event Viewer, read `lib.rs` Ready handler / overlay creation / `apply_layer` / `watcher::start`, traced windows with EnumWindows + WebView2 CDP, found both faults above, committed.

## Next stage
- Stage 2 (fix, then verify): add the standard `[features] custom-protocol = ["tauri/custom-protocol"]` + `default = ["custom-protocol"]` to `src-tauri/Cargo.toml`, rebuild with MSVC so the exe embeds `dist` (not `devUrl`) and picks up the current `lib.rs` (layer `"above"`), then launch and confirm a top-level `overlay-0` window with loaded UI.
