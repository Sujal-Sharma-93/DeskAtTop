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
  FONT_OPTIONS,
  starterItems,
  uid,
  type BehaviorConfig,
  type LaunchItem,
  type LaunchKind,
  type LayoutConfig,
  type Settings,
  type TypographyConfig,
  type WallpaperConfig,
} from './types';
import { clampNumber, normalizeStyle } from './style';

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

function normalizeTypography(raw: TypographyConfig): TypographyConfig {
  return {
    size: Math.round(clampNumber(raw.size, 10, 20)),
    family: FONT_OPTIONS.some((option) => option.id === raw.family) ? raw.family : 'system',
    weight: Math.round(clampNumber(raw.weight, 400, 700) / 100) * 100,
    letterSpacing: clampNumber(raw.letterSpacing, -1, 4),
    lineHeight: clampNumber(raw.lineHeight, 1, 2),
  };
}

function normalizeLayout(raw: LayoutConfig): LayoutConfig {
  return {
    orbSize: Math.round(clampNumber(raw.orbSize, 32, 88)),
    panelWidth: Math.round(clampNumber(raw.panelWidth, 240, 560)),
    panelHeight: Math.round(clampNumber(raw.panelHeight, 160, 480)),
    padding: Math.round(clampNumber(raw.padding, 4, 18)),
    gap: Math.round(clampNumber(raw.gap, 2, 16)),
  };
}

function normalizeBehavior(raw: BehaviorConfig): BehaviorConfig {
  return {
    hoverExpand: typeof raw.hoverExpand === 'boolean' ? raw.hoverExpand : true,
    collapseDelayMs: Math.round(clampNumber(raw.collapseDelayMs, 500, 30000)),
    animations: typeof raw.animations === 'boolean' ? raw.animations : true,
  };
}

function normalizeNova(raw: unknown): Settings['nova'] {
  const coordinate = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
  const source = isObj(raw) ? raw : {};
  return { x: coordinate(source.x), y: coordinate(source.y) };
}

function normalizeWallpaper(raw: WallpaperConfig): WallpaperConfig {
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value : null;
  return {
    imageEnabled: Boolean(raw.imageEnabled),
    imagePath: text(raw.imagePath),
    liveEnabled: Boolean(raw.liveEnabled),
    livePath: text(raw.livePath),
    pauseOnFullscreen: typeof raw.pauseOnFullscreen === 'boolean' ? raw.pauseOnFullscreen : true,
    pauseOnBattery: typeof raw.pauseOnBattery === 'boolean' ? raw.pauseOnBattery : true,
    systemPreviousPath:
      typeof raw.systemPreviousPath === 'string' ? raw.systemPreviousPath : null,
    systemAppliedPath: text(raw.systemAppliedPath),
  };
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
  if (isObj(raw.wallpaper)) {
    out.wallpaper = normalizeWallpaper({ ...base.wallpaper, ...(raw.wallpaper as object) } as WallpaperConfig);
  }
  if (isObj(raw.typography)) {
    out.typography = normalizeTypography({ ...base.typography, ...(raw.typography as object) } as TypographyConfig);
  }
  if (isObj(raw.layout)) {
    out.layout = normalizeLayout({ ...base.layout, ...(raw.layout as object) } as LayoutConfig);
  }
  if (isObj(raw.behavior)) {
    out.behavior = normalizeBehavior({ ...base.behavior, ...(raw.behavior as object) } as BehaviorConfig);
  }
  if (raw.nova !== undefined) out.nova = normalizeNova(raw.nova);

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

export async function parseImportedSettings(text: string): Promise<Settings> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!isObj(raw)) throw new Error('Settings must be a JSON object.');
  if (raw.version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version (expected ${SCHEMA_VERSION}).`);
  }
  if (!isObj(raw.theme)) throw new Error('Missing theme settings.');
  const theme = raw.theme;
  if (theme.mode !== 'dark' && theme.mode !== 'light') throw new Error('Invalid theme mode.');
  if (typeof theme.preset !== 'string' || typeof theme.accent !== 'string') {
    throw new Error('Invalid theme colours.');
  }
  if (theme.layer !== 'above' && theme.layer !== 'behind') throw new Error('Invalid overlay layer.');
  if (!isObj(raw.startup)) throw new Error('Missing startup settings.');
  if (typeof raw.startup.autoStart !== 'boolean' || typeof raw.startup.startHidden !== 'boolean') {
    throw new Error('Invalid startup settings.');
  }
  if (!isObj(raw.widgets)) throw new Error('Missing widget settings.');
  if (!Array.isArray(raw.boxes)) throw new Error('Missing launcher boxes.');
  if (raw.boxes.length === 0) throw new Error('At least one launcher box is required.');
  for (const box of raw.boxes) {
    if (!isObj(box) || typeof box.id !== 'string' || typeof box.title !== 'string') {
      throw new Error('Invalid launcher box.');
    }
    if (box.items !== undefined && !Array.isArray(box.items)) {
      throw new Error('Invalid launcher items.');
    }
  }
  if (raw.todo !== undefined) {
    if (!isObj(raw.todo) || (raw.todo.items !== undefined && !Array.isArray(raw.todo.items))) {
      throw new Error('Invalid to-do settings.');
    }
  }
  if (raw.notes !== undefined) {
    if (!isObj(raw.notes) || (raw.notes.notes !== undefined && !Array.isArray(raw.notes.notes))) {
      throw new Error('Invalid notes settings.');
    }
  }
  if (raw.pomodoro !== undefined && !isObj(raw.pomodoro)) throw new Error('Invalid timer settings.');
  if (raw.schedule !== undefined) {
    if (!isObj(raw.schedule)) throw new Error('Invalid schedule settings.');
    const events = raw.schedule.events;
    if (events !== undefined) {
      if (!Array.isArray(events)) throw new Error('Invalid schedule events.');
      for (const event of events) {
        if (
          !isObj(event) ||
          typeof event.id !== 'string' ||
          typeof event.title !== 'string' ||
          typeof event.body !== 'string' ||
          typeof event.at !== 'number' ||
          !Number.isFinite(event.at) ||
          typeof event.enabled !== 'boolean'
        ) {
          throw new Error('Invalid schedule event.');
        }
        if (event.repeat !== 'none' && event.repeat !== 'daily' && event.repeat !== 'weekly' && event.repeat !== 'monthly') {
          throw new Error('Invalid schedule repeat value.');
        }
      }
    }
  }
  if (raw.wallpaper !== undefined && !isObj(raw.wallpaper)) throw new Error('Invalid wallpaper settings.');
  if (raw.typography !== undefined && !isObj(raw.typography)) throw new Error('Invalid typography settings.');
  if (raw.layout !== undefined && !isObj(raw.layout)) throw new Error('Invalid layout settings.');
  if (raw.behavior !== undefined && !isObj(raw.behavior)) throw new Error('Invalid behavior settings.');
  return reconcile(raw, await homeFolder());
}

/** Label of the window we are running inside. */
export function currentLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return 'unknown';
  }
}
