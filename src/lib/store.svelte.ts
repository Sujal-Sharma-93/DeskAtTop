/**
 * Single JSON store access.
 *
 * `tauri-plugin-store` owns one file (`settings.json`) in the app config dir.
 * We read it once at boot into a Svelte 5 rune-backed reactive object, mutate it
 * in place, and let a debounced autosave flush it back. No window ever writes
 * the file directly, so there is a single writer and no cross-window races
 * beyond the store plugin's own change events.
 */
import { load, type Store } from '@tauri-apps/plugin-store';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { homeDir } from '@tauri-apps/api/path';
import {
  DEFAULT_SETTINGS,
  DEFAULT_STYLE,
  SCHEMA_VERSION,
  SETTINGS_FILE,
  starterItems,
  uid,
  type LaunchItem,
  type LaunchKind,
  type Settings,
} from './types';
import { normalizeStyle } from './style';

/** Reactive, app-wide settings object. Mutate directly; autosave follows. */
export const settings = $state<Settings>(structuredClone(DEFAULT_SETTINGS));

let store: Store | null = null;
let saveTimer: number | undefined;
let dirty = false;

type SettingsListener = (next: Settings) => void;
const listeners = new Set<SettingsListener>();

/** Subscribe to every adopted settings change in this window. */
export function onSettingsChange(cb: SettingsListener): () => void {
  listeners.add(cb);
  cb(settings);
  return () => listeners.delete(cb);
}

function notify(): void {
  for (const cb of listeners) {
    try {
      cb(settings);
    } catch (err) {
      console.error('settings listener failed', err);
    }
  }
}

/** Legacy kind names written by older builds. */
function migrateKind(kind: unknown): LaunchKind {
  switch (kind) {
    case 'app':
    case 'file':
    case 'folder':
    case 'url':
      return kind;
    case 'exe':
      return 'app';
    case 'dir':
      return 'folder';
    default:
      return 'app';
  }
}

/** Normalise one persisted item: legacy kinds, missing ids and labels. */
function migrateItem(raw: unknown): LaunchItem {
  const item = (raw ?? {}) as Partial<LaunchItem>;
  return {
    id: item.id ?? uid('item'),
    kind: migrateKind(item.kind),
    target: String(item.target ?? ''),
    label: String(item.label ?? ''),
    icon: item.icon ?? null,
  };
}

/**
 * One-time migration for legacy files:
 *
 * * items stored with the old `exe` / `dir` kinds become `app` / `folder`;
 * * a Quick Launch box that was saved empty gets the starter items and is
 *   marked seeded forever, so a box the user empties later stays empty.
 */
function migrateBoxes(boxes: Settings['boxes'], folder: string): Settings['boxes'] {
  return boxes.map((box) => {
    if (!box || typeof box !== 'object') return box;
    const items = Array.isArray(box.items) ? box.items.map(migrateItem) : [];
    const style = normalizeStyle({ ...DEFAULT_STYLE, ...(box.style ?? {}) });
    if (items.length > 0) {
      return { ...box, style, items, seeded: true };
    }
    if (box.title === 'Quick Launch' && box.seeded !== true) {
      return { ...box, style, items: starterItems(folder), seeded: true };
    }
    return { ...box, style, items, seeded: true };
  });
}

/** The user's home directory, used for the Documents shortcut. */
async function homeFolder(): Promise<string> {
  try {
    return await homeDir();
  } catch {
    return '';
  }
}

/** Merge a partial/older document onto the defaults so upgrades are safe. */
function reconcile(input: unknown, folder: string): Settings {
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
      merged.style = normalizeStyle({
        ...fallback.style,
        ...((incoming as { style?: object }).style ?? {}),
      });
      out.widgets[key] = merged as never;
    }
  }
  out.boxes = migrateBoxes(
    Array.isArray(raw.boxes) ? (raw.boxes as Settings['boxes']) : base.boxes,
    folder,
  );
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
  const folder = await homeFolder();
  const next = reconcile(saved, folder);
  const savedBoxes = isObj(saved) ? saved.boxes : undefined;
  const boxesChanged = JSON.stringify(next.boxes) !== JSON.stringify(savedBoxes);
  Object.assign(settings, next);
  notify();

  // Another window (usually the settings window) may write while we are open.
  // plugin-store 2.x exposes onKeyChange / onChange — there is no onDidChange.
  await store.onKeyChange<unknown>('settings', (next) => {
    if (next === undefined) return;
    // Only adopt if we are not mid-edit with unsaved local changes.
    if (dirty) return;
    Object.assign(settings, reconcile(next, folder));
    notify();
  });

  // Persist the very first run so the file always exists and the tray /
  // autostart logic has something to read. A migrated file is written back so
  // the seeded flag survives the next launch.
  if (saved === undefined || saved === null || boxesChanged) {
    await flush();
  }
  return settings;
}

let publishChain: Promise<void> = Promise.resolve();

/** Serialise in-memory snapshots so other windows never see stale state. */
function publish(): void {
  const current = store;
  if (!current) return;
  const snapshot = JSON.parse(JSON.stringify(settings));
  publishChain = publishChain
    .then(() => current.set('settings', snapshot))
    .catch((err) => console.error('settings publish failed', err));
}

/**
 * Push the new state to every window immediately (the store change event is
 * what makes slider changes live), then debounce the disk write.
 */
export function touch(delay = 300): void {
  dirty = true;
  publish();
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flush(), delay) as unknown as number;
}

/** Write immediately. */
export async function flush(): Promise<void> {
  if (!store) return;
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  dirty = false;
  await publishChain;
  await store.set('settings', JSON.parse(JSON.stringify(settings)));
  await store.save();
}

export async function replaceAll(next: Settings): Promise<void> {
  Object.assign(settings, reconcile(next, await homeFolder()));
  notify();
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
