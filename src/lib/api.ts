/** Typed wrappers around the Rust commands, so components never import `@tauri-apps/api` command plumbing directly. */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { currentLabel, settings } from './store.svelte';
import { presetById, type LaunchItem, type Repeat, type Settings } from './types';

// ------------------------------------------------------------------- windows

export function thisWindow() {
  return getCurrentWebviewWindow();
}

/** Physical pixels per logical pixel for this window's monitor. */
export async function physicalScale(): Promise<number> {
  try {
    return await getCurrentWebviewWindow().scaleFactor();
  } catch {
    return 1;
  }
}

// ------------------------------------------------------------------ commands

export function openTarget(target: string): Promise<void> {
  return invoke<void>('open_target', { target });
}

export interface IconResult {
  path: string;
  data: string | null;
}

export function extractIcons(paths: string[]): Promise<IconResult[]> {
  return invoke<IconResult[]>('extract_icons', { paths });
}

export interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function setHitRegions(label: string, rects: HitRect[]): Promise<void> {
  return invoke<void>('set_hit_regions', { label, rects });
}

export function setOverlayPassThrough(on: boolean): Promise<void> {
  return invoke<void>('set_overlay_pass_through', { on });
}

export function syncOverlays(enabled: boolean, layer: 'above' | 'behind'): Promise<void> {
  return invoke<void>('sync_overlays', { enabled, layer });
}

export function syncWallpaperWindow(
  enabled: boolean,
  spec: { kind: 'image' | 'video' } | null,
): Promise<void> {
  return invoke<void>('sync_wallpaper_window', { enabled, spec });
}

export function setLiveSuspended(suspended: boolean): Promise<void> {
  return invoke<void>('set_live_suspended', { suspended });
}

export function reassertWallpaper(): Promise<void> {
  return invoke<void>('reassert_wallpaper');
}

export function setWidgetsVisible(visible: boolean): Promise<void> {
  return invoke<void>('set_widgets_visible', { visible });
}

export function openSettingsWindow(): Promise<void> {
  return invoke<void>('open_settings_window');
}

export function exitApp(): Promise<void> {
  return invoke<void>('exit_app');
}

// ----------------------------------------------------------------- scheduler

export interface SchedEvent {
  id: string;
  title: string;
  body: string;
  at: number;
  repeat: Repeat;
  snoozed_until: number | null;
  enabled: boolean;
}

/** Map our camelCase events onto the snake_case shape Rust expects. */
export function toSchedEvent(e: Settings['schedule']['events'][number]): SchedEvent {
  return {
    id: e.id,
    title: e.title,
    body: e.body,
    at: e.at,
    repeat: e.repeat,
    snoozed_until: null,
    enabled: e.enabled,
  };
}

export function schedReplace(events: SchedEvent[]): Promise<void> {
  return invoke<void>('sched_replace', { events });
}

export function schedSnooze(event: SchedEvent, minutes: number): Promise<void> {
  return invoke<void>('sched_snooze', { event, minutes });
}

export function schedDismiss(): Promise<void> {
  return invoke<void>('sched_dismiss');
}

export function schedClear(): Promise<void> {
  return invoke<void>('sched_clear');
}

export interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

export function localParts(at: number): Promise<LocalParts> {
  return invoke<LocalParts>('local_parts', { at });
}

// -------------------------------------------------------------------- events

export interface EnvState {
  fullscreen: boolean;
  onBattery: boolean;
}

/** Subscribe to fullscreen / battery changes. Returns an unsubscribe fn. */
export function watchEnvironment(cb: (s: EnvState) => void): UnlistenFn[] {
  const out: UnlistenFn[] = [];
  const state: EnvState = { fullscreen: false, onBattery: false };
  void listen<boolean>('env://fullscreen', (e) => {
    state.fullscreen = e.payload;
    cb({ ...state });
  }).then((u) => out.push(u));
  void listen<boolean>('env://on-battery', (e) => {
    state.onBattery = e.payload;
    cb({ ...state });
  }).then((u) => out.push(u));
  return () => out.forEach((u) => u());
}

export function onShellRestart(cb: () => void): Promise<UnlistenFn> {
  return listen('shell://restarted', () => cb());
}

export function onWallpaperSuspend(cb: (suspended: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>('wallpaper://suspend', (e) => cb(e.payload));
}

export function onTrayToggle(cb: () => void): Promise<UnlistenFn> {
  return listen('tray://toggle-widgets', () => cb());
}

export function broadcastToAll(event: string, payload?: unknown): Promise<void> {
  return emit(event, payload).then(() => undefined);
}

// ------------------------------------------------------------------- theming

/**
 * Push theme + widget styles into CSS custom properties.
 *
 * The overlay sets these on each widget element (inline custom properties) so
 * per-widget colours win over the global preset without needing extra classes.
 */
export function applyThemeVars(el: HTMLElement, style: Settings['widgets']['todo']['style']): void {
  el.style.setProperty('--w-bg', style.bg);
  el.style.setProperty('--w-fg', style.fg);
  el.style.setProperty('--w-accent', style.accent);
  el.style.setProperty('--w-opacity', String(style.opacity / 100));
  el.style.setProperty('--w-radius', `${style.radius}px`);
  el.style.setProperty('--w-blur', style.blur > 0 ? `${style.blur}px` : '0px');
}

export function applyGlobalTheme(): void {
  const p = presetById(settings.theme.preset);
  const root = document.documentElement;
  root.dataset.theme = settings.theme.mode;
  root.style.setProperty('--dat-accent', settings.theme.accent || p.accent);
  root.style.setProperty('--dat-accent-soft', p.accent);
  root.style.setProperty('--dat-text', p.text);
  root.style.setProperty('--dat-surface', p.surface);
  root.style.setProperty('--dat-border', settings.theme.mode === 'light' ? 'rgba(20,22,40,0.14)' : 'rgba(255,255,255,0.14)');
}

// --------------------------------------------------------------------- icons

const iconCache = new Map<string, string>();

/** Extract (and memoise) shell icons for a set of targets. */
export async function resolveIcons(targets: string[]): Promise<Map<string, string>> {
  const missing = targets.filter((t) => !iconCache.has(t));
  if (missing.length) {
    const results = await extractIcons(missing);
    for (const r of results) {
      if (r.data) iconCache.set(r.path, r.data);
    }
  }
  const out = new Map<string, string>();
  for (const t of targets) {
    const v = iconCache.get(t);
    if (v) out.set(t, v);
  }
  return out;
}

export function cacheIcon(target: string, data: string): void {
  iconCache.set(target, data);
}

/** Human label for a launch item when the user has not renamed it. */
export function itemLabel(item: LaunchItem): string {
  if (item.label) return item.label;
  const t = item.target;
  if (item.kind === 'url') {
    try {
      return new URL(t).hostname.replace(/^www\./, '');
    } catch {
      return t;
    }
  }
  const parts = t.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || t;
}
