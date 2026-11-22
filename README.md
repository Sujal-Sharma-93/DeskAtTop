# DeskAtTop

DeskAtTop is a lightweight Windows desktop customization app built with Tauri 2, Svelte and TypeScript. It provides a small launcher box on the desktop with quick shortcuts, productivity widgets, reminders, live appearance controls, and an optional static image wallpaper behind desktop icons.

## Features

- Hover-expand Quick Launch box with drag support
- Add, rename, reorder and remove app/file/folder/URL shortcuts
- To-do, notes, Pomodoro timer and schedule reminder widgets
- Schedule reminders with popup, snooze and dismiss actions
- Theme presets plus live colour, opacity and radius controls
- Static image wallpaper layer that keeps desktop icons clickable
- Settings for autostart and widget visibility
- Settings JSON export/import via clipboard

## Requirements

- Windows 10 or 11
- Node.js 20+ and npm
- Rust with the MSVC toolchain (`x86_64-pc-windows-msvc`)
- Visual Studio Build Tools with **Desktop development with C++**
- WebView2 Runtime (usually preinstalled on Windows 10/11)

## Run locally

```powershell
npm install
npm run tauri dev
```

Run commands from the project root. Do not launch the debug executable directly: the dev build expects the Vite server started by `npm run tauri dev`.

## Build release

```powershell
npm run tauri build
```

The standalone executable is written to `src-tauri\target\release\desk-at-top.exe` and the NSIS installer to `src-tauri\target\release\bundle\nsis\`.

## Notes

Release builds embed the frontend, so the standalone executable does not need the Vite dev server. Generated output (`dist/`), dependencies (`node_modules/`), build artifacts (`src-tauri/target/`) and log files are ignored by Git.
