/**
 * Single JSON store access.
 *
 * `tauri-plugin-store` owns one file (`settings.json`) in the app config dir.
 * We read it once at boot into a Svelte 5 rune-backed reactive object, mutate it
 * in place, and let a debounced autosave flush it back. No window ever writes
 * the file directly, so there is a single writer and no cross-window races
 * beyond the store plugin's own change events.
 */
import { load, getStore, type Store } from '@tauri-apps/plugin-store';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { DEFAULT_SETTINGS, SCHEMA_VERSION, SETTINGS_FILE, type Settings } from './types';

/** Reactive, app-wide settings object. Mutate directly; autosave follows. */
export const settings = $state<Settings>(structuredClone(DEFAULT_SETTINGS));

let store: Store | null = null;
let saveTimer: number | undefined;
let dirty = false;

/** Merge a partial/older document onto the defaults so upgrades are safe. */
function reconcile(input: unknown): Settings {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!input || typeof input !== 'object') return base;
  const raw = input as Record<string, unknown>;

  const out: Settings = { ...base };
  if (raw.version !== SCHEMA_VERSION) out.version = SCHEMA_VERSION;

  if (isObj(raw.theme)) {
    out.theme = { ...base.theme, ...(raw.theme as object) } as Settings['theme'];
  }
  if (isObj(raw.startup)) {
    out.startup = { ...base.startup, ...(raw.startup as object) } as Settings['startup'];
  }
  if (isObj(raw.widgets)) {
    const w = raw.widgets as Record<string, unknown>;
    for (const key of Object.keys(base.widgets) as (keyof Settings['widgets'])[]) {
      const incoming = w[key];
      if (!isObj(incoming)) continue;
      const fallback = base.widgets[key];
      const merged = { ...fallback, ...(incoming as object) } as Settings['widgets'][typeof key];
      // Style objects must be complete so CSS variables are never undefined.
      merged.style = { ...fallback.style, ...((incoming as { style?: object }).style ?? {}) };
      out.widgets[key] = merged as never;
    }
  }
  if (Array.isArray(raw.boxes)) out.boxes = raw.boxes as Settings['boxes'];
  if (isObj(raw.todo) && Array.isArray((raw.todo as { items?: unknown }).items)) {
    out.todo = raw.todo as Settings['todo'];
  }
  if (isObj(raw.notes)) out.notes = { ...base.notes, ...(raw.notes as object) } as Settings['notes'];
  if (isObj(raw.pomodoro)) out.pomodoro = { ...base.pomodoro, ...(raw.pomodoro as object) } as Settings['pomodoro'];
  if (isObj(raw.schedule) && Array.isArray((raw.schedule as { events?: unknown }).events)) {
    out.schedule = raw.schedule as Settings['schedule'];
  }
  if (isObj(raw.wallpaper)) out.wallpaper = { ...base.wallpaper, ...(raw.wallpaper as object) } as Settings['wallpaper'];

  return out;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Load the store. Call once per window before rendering. */
export async function initStore(): Promise<Settings> {
  store = await load(SETTINGS_FILE, { autoSave: false });
  const saved = await store.get<unknown>('settings');
  Object.assign(settings, reconcile(saved));

  // Another window (usually the settings window) may write while we are open.
  // plugin-store 2.x exposes onKeyChange / onChange — there is no onDidChange.
  await store.onKeyChange<unknown>('settings', (next) => {
    if (next === undefined) return;
    // Only adopt if we are not mid-edit with unsaved local changes.
    if (dirty) return;
    Object.assign(settings, reconcile(next));
  });

  // Persist the very first run so the file always exists and the tray /
  // autostart logic has something to read.
  if (saved === undefined || saved === null) {
    await flush();
  }
  return settings;
}

/** Mark dirty and schedule a write. */
export function touch(): void {
  dirty = true;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flush(), 220) as unknown as number;
}

/** Write immediately. */
export async function flush(): Promise<void> {
  if (!store) return;
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  dirty = false;
  await store.set('settings', JSON.parse(JSON.stringify(settings)));
  await store.save();
}

export async function replaceAll(next: Settings): Promise<void> {
  Object.assign(settings, reconcile(next));
  await flush();
}

/** Serialise for the export feature. */
export function exportJson(): string {
  return JSON.stringify(settings, null, 2);
}

/** Label of the window we are running inside. */
export function currentLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return 'unknown';
  }
}
