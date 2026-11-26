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
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { homeDir } from '@tauri-apps/api/path';
import {
  DEFAULT_SETTINGS,
  DEFAULT_STYLE,
  FLOATING_FRAMES,
  FLOATING_LAYOUT_VERSION,
  MAX_IMPORT_BYTES,
  MAX_STRING_LENGTH,
  WORKSPACE_GRID,
  WIDGET_LIMITS,
  SCHEMA_VERSION,
  SETTINGS_FILE,
  FONT_OPTIONS,
  PRESETS,
  isImportableLaunchTarget,
  isSafeIcon,
  isSafeWallpaperRef,
  isValidLaunchTarget,
  starterItems,
  uid,
  type BehaviorConfig,
  type LaunchItem,
  type LaunchKind,
  type LayoutConfig,
  type Repeat,
  type Settings,
  type TypographyConfig,
  type WallpaperConfig,
} from './types';
import { clampNumber, isColor, normalizeStyle } from './style';

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

function importKind(kind: unknown): LaunchKind | null {
  if (kind === 'app' || kind === 'file' || kind === 'folder' || kind === 'url') return kind;
  if (kind === 'exe') return 'app';
  if (kind === 'dir') return 'folder';
  return null;
}

function migrateItem(raw: unknown, strict = false): LaunchItem | null {
  const item = (raw ?? {}) as Partial<LaunchItem>;
  const kind = migrateKind(item.kind);
  if (typeof item.target !== 'string') return null;
  const targetValid = strict
    ? isImportableLaunchTarget(kind, item.target)
    : isValidLaunchTarget(kind, item.target);
  if (!targetValid) return null;
  const id = typeof item.id === 'string' && item.id.length <= 160 ? item.id : uid('item');
  const label = typeof item.label === 'string' && item.label.length <= 200 ? item.label : '';
  return { id, kind, target: item.target, label, icon: isSafeIcon(item.icon) };
}

/**
 * One-time migration for legacy files:
 *
 * * items stored with the old `exe` / `dir` kinds become `app` / `folder`;
 * * a Quick Launch box that was saved empty gets the starter items and is
 *   marked seeded forever, so a box the user empties later stays empty.
 */
function migrateBoxes(
  boxes: Settings['boxes'],
  folder: string,
  strict = false,
): Settings['boxes'] {
  return boxes.map((box) => {
    if (!box || typeof box !== 'object') return box;
    const rawItems = Array.isArray(box.items) ? box.items : [];
    const items = rawItems
      .map((raw) => migrateItem(raw, strict))
      .filter((item): item is LaunchItem => item !== null);
    const style = normalizeStyle({ ...DEFAULT_STYLE, ...(box.style ?? {}) });
    const title = typeof box.title === 'string' && box.title.length <= 120 ? box.title : 'Box';
    if (items.length > 0) {
      return { ...box, title, style, items, seeded: true };
    }
    if (!strict && title === 'Quick Launch' && box.seeded !== true) {
      return { ...box, title, style, items: starterItems(folder), seeded: true };
    }
    return { ...box, title, style, items, seeded: true };
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
    panelWidth: Math.round(clampNumber(raw.panelWidth, 240, 1440)),
    panelHeight: Math.round(clampNumber(raw.panelHeight, 160, 1000)),
    padding: Math.round(clampNumber(raw.padding, 4, 18)),
    gap: Math.round(clampNumber(raw.gap, 2, 16)),
    floatingVersion:
      typeof raw.floatingVersion === 'number' && Number.isFinite(raw.floatingVersion)
        ? Math.round(raw.floatingVersion)
        : FLOATING_LAYOUT_VERSION,
  };
}

function normalizeBehavior(raw: BehaviorConfig): BehaviorConfig {
  return {
    hoverExpand: typeof raw.hoverExpand === 'boolean' ? raw.hoverExpand : true,
    collapseDelayMs: Math.round(clampNumber(raw.collapseDelayMs, 500, 30000)),
    animations: typeof raw.animations === 'boolean' ? raw.animations : true,
  };
}

function normalizeTheme(raw: unknown, base: Settings['theme']): Settings['theme'] {
  const source = isObj(raw) ? raw : {};
  const preset = PRESETS.some((p) => p.id === source.preset)
    ? (source.preset as string)
    : base.preset;
  return {
    preset,
    mode: source.mode === 'dark' || source.mode === 'light' ? source.mode : base.mode,
    accent: isColor(source.accent) ? source.accent : base.accent,
    layer: source.layer === 'above' || source.layer === 'behind' ? source.layer : base.layer,
  };
}

function normalizeStartup(raw: unknown, base: Settings['startup']): Settings['startup'] {
  const source = isObj(raw) ? raw : {};
  return {
    autoStart: typeof source.autoStart === 'boolean' ? source.autoStart : base.autoStart,
    startHidden: typeof source.startHidden === 'boolean' ? source.startHidden : base.startHidden,
  };
}

function normalizeNova(raw: unknown): Settings['nova'] {
  const coordinate = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
  const source = isObj(raw) ? raw : {};
  return { x: coordinate(source.x), y: coordinate(source.y) };
}

function normalizeWallpaper(raw: WallpaperConfig): WallpaperConfig {
  const safe = (value: unknown): string | null => (isSafeWallpaperRef(value) ? value : null);
  const imagePath = safe(raw.imagePath);
  const livePath = safe(raw.livePath);
  return {
    imageEnabled: Boolean(raw.imageEnabled) && imagePath !== null,
    imagePath,
    liveEnabled: Boolean(raw.liveEnabled) && livePath !== null,
    livePath,
    pauseOnFullscreen: typeof raw.pauseOnFullscreen === 'boolean' ? raw.pauseOnFullscreen : true,
    pauseOnBattery: typeof raw.pauseOnBattery === 'boolean' ? raw.pauseOnBattery : true,
    systemPreviousPath: safe(raw.systemPreviousPath),
    systemAppliedPath: safe(raw.systemAppliedPath),
  };
}

function boundedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function boundedId(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 ? value : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeTodo(raw: unknown, base: Settings['todo']): Settings['todo'] {
  const source = isObj(raw) ? raw : {};
  const items = Array.isArray(source.items)
    ? source.items.slice(0, 500).map((value) => {
        const item = isObj(value) ? value : {};
        return {
          id: boundedId(item.id, uid('todo')),
          text: boundedText(item.text, 1000),
          done: Boolean(item.done),
          createdAt: Math.round(finiteNumber(item.createdAt, Date.now())),
        };
      })
    : [];
  return { ...base, items };
}

function normalizeNotes(raw: unknown, base: Settings['notes']): Settings['notes'] {
  const source = isObj(raw) ? raw : {};
  const notes = Array.isArray(source.notes)
    ? source.notes.slice(0, 500).map((value) => {
        const note = isObj(value) ? value : {};
        return {
          id: boundedId(note.id, uid('note')),
          title: boundedText(note.title, 300),
          body: boundedText(note.body, 20000),
          updatedAt: Math.round(finiteNumber(note.updatedAt, Date.now())),
        };
      })
    : [];
  const activeId =
    typeof source.activeId === 'string' && notes.some((note) => note.id === source.activeId)
      ? source.activeId
      : null;
  return { ...base, notes, activeId };
}

function normalizePomodoro(
  raw: unknown,
  base: Settings['pomodoro'],
): Settings['pomodoro'] {
  const source = isObj(raw) ? raw : {};
  const session =
    source.session === 'work' || source.session === 'short' || source.session === 'long'
      ? source.session
      : base.session;
  const nullable = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
  return {
    work: Math.round(clampNumber(finiteNumber(source.work, base.work), 1, 180)),
    shortBreak: Math.round(clampNumber(finiteNumber(source.shortBreak, base.shortBreak), 1, 60)),
    longBreak: Math.round(clampNumber(finiteNumber(source.longBreak, base.longBreak), 1, 90)),
    cycles: Math.round(clampNumber(finiteNumber(source.cycles, base.cycles), 1, 12)),
    sound: typeof source.sound === 'boolean' ? source.sound : base.sound,
    notify: typeof source.notify === 'boolean' ? source.notify : base.notify,
    remainingMs: nullable(source.remainingMs),
    runningSince: nullable(source.runningSince),
    endsAt: nullable(source.endsAt),
    session,
    completed: Math.max(0, Math.round(finiteNumber(source.completed, base.completed))),
  };
}

function normalizeSchedule(raw: unknown, base: Settings['schedule']): Settings['schedule'] {
  const source = isObj(raw) ? raw : {};
  const events = Array.isArray(source.events)
    ? source.events.slice(0, 500).map((value) => {
        const event = isObj(value) ? value : {};
        const repeat: Repeat =
          event.repeat === 'daily' || event.repeat === 'weekly' || event.repeat === 'monthly'
            ? event.repeat
            : 'none';
        return {
          id: boundedId(event.id, uid('event')),
          title: boundedText(event.title, 500),
          body: boundedText(event.body, 2000),
          at: Math.round(finiteNumber(event.at, Date.now())),
          repeat,
          firedAt:
            typeof event.firedAt === 'number' && Number.isFinite(event.firedAt)
              ? Math.round(event.firedAt)
              : null,
          enabled: Boolean(event.enabled),
        };
      })
    : [];
  return { ...base, events };
}

function snapGrid(value: number): number {
  return Math.round(value / WORKSPACE_GRID) * WORKSPACE_GRID;
}

/** Merge a partial/older document onto the defaults so upgrades are safe. */
function reconcile(input: unknown, folder: string, strict = false): Settings {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!input || typeof input !== 'object') return base;
  const raw = input as Record<string, unknown>;

  const out: Settings = { ...base };
  if (raw.version !== SCHEMA_VERSION) out.version = SCHEMA_VERSION;
  const migrateFloating =
    !isObj(raw.layout) ||
    (raw.layout as Record<string, unknown>).floatingVersion !== FLOATING_LAYOUT_VERSION;

  out.theme = normalizeTheme(raw.theme, base.theme);
  out.startup = normalizeStartup(raw.startup, base.startup);
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
      const limits = WIDGET_LIMITS[key];
      merged.x = snapGrid(Math.max(0, Math.round(clampNumber(merged.x, 0, 4096))));
      merged.y = snapGrid(Math.max(0, Math.round(clampNumber(merged.y, 0, 4096))));
      merged.w = snapGrid(Math.round(clampNumber(merged.w, limits.minW, limits.maxW)));
      merged.h = snapGrid(Math.round(clampNumber(merged.h, limits.minH, limits.maxH)));
      merged.minimized = Boolean(merged.minimized);
      merged.maximized = Boolean(merged.maximized);
      if (migrateFloating) {
        Object.assign(merged, FLOATING_FRAMES[key]);
        merged.minimized = false;
        merged.maximized = false;
      }
      out.widgets[key] = merged as never;
    }
  }
  out.boxes = migrateBoxes(
    Array.isArray(raw.boxes) ? (raw.boxes as Settings['boxes']) : base.boxes,
    folder,
    strict,
  );
  out.todo = normalizeTodo(raw.todo, base.todo);
  out.notes = normalizeNotes(raw.notes, base.notes);
  out.pomodoro = normalizePomodoro(raw.pomodoro, base.pomodoro);
  out.schedule = normalizeSchedule(raw.schedule, base.schedule);
  out.wallpaper = normalizeWallpaper({
    ...base.wallpaper,
    ...(isObj(raw.wallpaper) ? (raw.wallpaper as object) : {}),
  } as WallpaperConfig);
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
  out.layout.floatingVersion = FLOATING_LAYOUT_VERSION;

  return out;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function migrateWallpaperRefs(raw: Record<string, unknown>): Promise<{
  value: Record<string, unknown>;
  changed: boolean;
}> {
  const out = { ...raw };
  let changed = false;
  for (const key of ['imagePath', 'systemPreviousPath', 'systemAppliedPath'] as const) {
    const value = out[key];
    if (typeof value === 'string' && value.length > 0 && !isSafeWallpaperRef(value)) {
      changed = true;
      try {
        out[key] = await invoke<string>('import_wallpaper_image', { path: value });
      } catch {
        out[key] = null;
      }
    }
  }
  if (
    typeof out.livePath === 'string' &&
    out.livePath.length > 0 &&
    !isSafeWallpaperRef(out.livePath)
  ) {
    out.livePath = null;
    changed = true;
  }
  return { value: out, changed };
}

/** Load the store. Call once per window before rendering. */
export async function initStore(): Promise<Settings> {
  store = await load(SETTINGS_FILE, { autoSave: false });
  const saved = await store.get<unknown>('settings');
  const folder = await homeFolder();
  const wallpaperMigration =
    isObj(saved) && isObj(saved.wallpaper) ? await migrateWallpaperRefs(saved.wallpaper) : null;
  const prepared =
    wallpaperMigration && isObj(saved)
      ? { ...saved, wallpaper: wallpaperMigration.value }
      : saved;
  const next = reconcile(prepared, folder);
  const savedBoxes = isObj(saved) ? saved.boxes : undefined;
  const boxesChanged = JSON.stringify(next.boxes) !== JSON.stringify(savedBoxes);
  const wallpaperChanged = wallpaperMigration?.changed === true;
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
  if (saved === undefined || saved === null || boxesChanged || wallpaperChanged) {
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
  Object.assign(settings, reconcile(next, await homeFolder(), true));
  notify();
  await flush();
}

/** Serialise for the export feature. */
export function exportJson(): string {
  return JSON.stringify(settings, null, 2);
}

export interface ImportResult {
  settings: Settings;
  warnings: string[];
}

function validateImportValue(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): void {
  if (depth > 32) throw new Error('Settings JSON is too deeply nested.');
  state.nodes += 1;
  if (state.nodes > 30_000) throw new Error('Settings JSON is too large.');
  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
    throw new Error('Settings JSON contains an oversized value.');
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Error('Settings JSON contains too many items.');
    for (const child of value) validateImportValue(child, state, depth + 1);
    return;
  }
  if (isObj(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key.length > 120) throw new Error('Settings JSON contains an oversized key.');
      validateImportValue(child, state, depth + 1);
    }
  }
}

export async function parseImportedSettings(text: string): Promise<ImportResult> {
  if (text.length > MAX_IMPORT_BYTES) throw new Error('Settings JSON is too large.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  validateImportValue(raw, { nodes: 0 });
  if (!isObj(raw)) throw new Error('Settings must be a JSON object.');
  if (raw.version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version (expected ${SCHEMA_VERSION}).`);
  }
  if (!isObj(raw.theme)) throw new Error('Missing theme settings.');
  const theme = raw.theme;
  if (theme.mode !== 'dark' && theme.mode !== 'light') throw new Error('Invalid theme mode.');
  if (typeof theme.preset !== 'string' || !PRESETS.some((p) => p.id === theme.preset)) {
    throw new Error('Invalid theme preset.');
  }
  if (!isColor(theme.accent)) throw new Error('Invalid theme accent.');
  if (theme.layer !== 'above' && theme.layer !== 'behind') throw new Error('Invalid overlay layer.');
  if (!isObj(raw.startup)) throw new Error('Missing startup settings.');
  if (typeof raw.startup.autoStart !== 'boolean' || typeof raw.startup.startHidden !== 'boolean') {
    throw new Error('Invalid startup settings.');
  }
  if (!isObj(raw.widgets)) throw new Error('Missing widget settings.');
  if (!Array.isArray(raw.boxes)) throw new Error('Missing launcher boxes.');
  if (raw.boxes.length === 0 || raw.boxes.length > 100) {
    throw new Error('Invalid launcher box count.');
  }
  const warnings: string[] = [];
  let skippedItems = 0;
  for (const box of raw.boxes) {
    if (!isObj(box) || typeof box.id !== 'string' || typeof box.title !== 'string') {
      throw new Error('Invalid launcher box.');
    }
    if (box.id.length > 160 || box.title.length > 120 || box.items === undefined) continue;
    if (!Array.isArray(box.items) || box.items.length > 200) {
      throw new Error('Invalid launcher items.');
    }
    for (const item of box.items) {
      if (!isObj(item)) {
        skippedItems += 1;
        continue;
      }
      const kind = importKind(item.kind);
      if (
        kind === null ||
        typeof item.target !== 'string' ||
        !isImportableLaunchTarget(kind, item.target) ||
        (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 200))
      ) {
        skippedItems += 1;
        continue;
      }
      if (item.icon !== undefined && isSafeIcon(item.icon) === null && item.icon !== null) {
        item.icon = null;
      }
    }
  }
  if (skippedItems > 0) {
    warnings.push(`${skippedItems} unsupported launcher item(s) were skipped.`);
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
  if (raw.wallpaper !== undefined) {
    if (!isObj(raw.wallpaper)) throw new Error('Invalid wallpaper settings.');
    const wallpaper = raw.wallpaper as Record<string, unknown>;
    const wallpaperFields = ['imagePath', 'livePath', 'systemPreviousPath', 'systemAppliedPath'];
    if (
      wallpaperFields.some(
        (key) =>
          typeof wallpaper[key] === 'string' && !isSafeWallpaperRef(wallpaper[key]),
      )
    ) {
      warnings.push('Wallpaper paths must be chosen again after import.');
    }
  }
  if (raw.typography !== undefined && !isObj(raw.typography)) throw new Error('Invalid typography settings.');
  if (raw.layout !== undefined && !isObj(raw.layout)) throw new Error('Invalid layout settings.');
  if (raw.behavior !== undefined && !isObj(raw.behavior)) throw new Error('Invalid behavior settings.');
  return { settings: reconcile(raw, await homeFolder(), true), warnings };
}

/** Label of the window we are running inside. */
export function currentLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return 'unknown';
  }
}
