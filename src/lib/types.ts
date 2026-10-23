/** Shared data model. Mirrors what is persisted in settings.json. */

export const SETTINGS_FILE = 'settings.json';
export const SCHEMA_VERSION = 1;

/** Every widget exposes the same four style knobs, stored per widget. */
export interface WidgetStyle {
  /** CSS colour for the widget body. */
  bg: string;
  /** Text colour. */
  fg: string;
  /** Accent used for highlights, checkmarks, focus rings. */
  accent: string;
  /** 0-100. */
  opacity: number;
  /** Corner radius in px. */
  radius: number;
  /** Optional backdrop blur in px. */
  blur: number;
}

export type WidgetId = 'todo' | 'notes' | 'pomodoro' | 'schedule' | 'launcher';

export interface WidgetState {
  enabled: boolean;
  style: WidgetStyle;
  /** Position within its overlay window, in logical px. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LaunchKind = 'app' | 'file' | 'folder' | 'url';

export interface LaunchItem {
  id: string;
  kind: LaunchKind;
  /** Filesystem path for app/file/folder, or the URL for `url`. */
  target: string;
  label: string;
  /** `data:image/png;base64,...` extracted by the Rust side. */
  icon: string | null;
}

export interface LauncherBox {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  /** Panel height when expanded. */
  h: number;
  style: WidgetStyle;
  items: LaunchItem[];
  /** Start expanded instead of collapsed to the title bar. */
  pinned: boolean;
  /** Set once the one-time starter-item migration has been applied to this box. */
  seeded?: boolean;
}

export interface WallpaperConfig {
  /** Static image layer. */
  imageEnabled: boolean;
  imagePath: string | null;
  /** Live (muted, looping) video layer. */
  liveEnabled: boolean;
  livePath: string | null;
  /** Pause automatically when a fullscreen app has focus. */
  pauseOnFullscreen: boolean;
  /** Pause automatically while on battery. */
  pauseOnBattery: boolean;
}

export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';

export interface ScheduleEvent {
  id: string;
  title: string;
  body: string;
  /** Unix milliseconds. */
  at: number;
  repeat: Repeat;
  /** Set once the occurrence has been shown, so it is not re-armed. */
  firedAt: number | null;
  enabled: boolean;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
}

export interface PomodoroConfig {
  /** Minutes. */
  work: number;
  shortBreak: number;
  longBreak: number;
  /** Work sessions before a long break. */
  cycles: number;
  sound: boolean;
  notify: boolean;
}

export interface Settings {
  version: number;
  theme: {
    preset: string;
    /** `dark` | `light` */
    mode: 'dark' | 'light';
    accent: string;
    /** Overlay z-order relative to the desktop icon view. */
    layer: 'above' | 'behind';
  };
  startup: {
    autoStart: boolean;
    startHidden: boolean;
  };
  widgets: Record<WidgetId, WidgetState>;
  boxes: LauncherBox[];
  todo: { items: TodoItem[] };
  notes: { notes: Note[]; activeId: string | null };
  pomodoro: PomodoroConfig & {
    /** Persisted so a reload does not lose the run. */
    remainingMs: number | null;
    runningSince: number | null;
    /** Absolute Unix-ms end time while running; null when paused/idle. */
    endsAt: number | null;
    session: 'work' | 'short' | 'long';
    completed: number;
  };
  schedule: { events: ScheduleEvent[] };
  wallpaper: WallpaperConfig;
}

export const DEFAULT_STYLE: WidgetStyle = {
  /** Opaque base colour; `opacity` supplies the surface alpha. */
  bg: '#16182b',
  fg: '#e9eaf2',
  accent: '#6366f1',
  opacity: 72,
  radius: 14,
  blur: 14,
};

function widget(over: Partial<WidgetState> = {}): WidgetState {
  return { enabled: false, style: { ...DEFAULT_STYLE }, x: 40, y: 40, w: 300, h: 320, ...over };
}

let counter = 0;
/** Short, collision-resistant enough for a single-user desktop app. */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 0xffff;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** The three starter shortcuts, defined once for defaults and migration. */
export function starterItems(folder = ''): LaunchItem[] {
  return [
    { id: uid('item'), kind: 'app', target: 'notepad.exe', label: 'Notepad', icon: null },
    { id: uid('item'), kind: 'app', target: 'calc.exe', label: 'Calculator', icon: null },
    {
      id: uid('item'),
      kind: folder ? 'folder' : 'app',
      target: folder ? `${folder}\\Documents` : 'explorer.exe',
      label: 'Documents',
      icon: null,
    },
  ];
}

/**
 * The default Quick Launch box. It starts empty and unseeded so the store
 * migration can fill it with the starter items (and the real Documents
 * folder) exactly once.
 */
export function starterBox(): LauncherBox {
  return {
    id: uid('box'),
    title: 'Quick Launch',
    x: 80,
    y: 80,
    w: 260,
    h: 180,
    style: { ...DEFAULT_STYLE },
    items: [],
    pinned: true,
    seeded: false,
  };
}

export const DEFAULT_SETTINGS: Settings = {
  version: SCHEMA_VERSION,
  theme: { preset: 'midnight', mode: 'dark', accent: '#6366f1', layer: 'above' },
  startup: { autoStart: true, startHidden: true },
  widgets: {
    todo: widget({ x: 40, y: 40, w: 290, h: 340 }),
    notes: widget({ x: 360, y: 40, w: 320, h: 340 }),
    pomodoro: widget({ x: 40, y: 420, w: 290, h: 210 }),
    schedule: widget({ x: 710, y: 40, w: 300, h: 300 }),
    launcher: widget({ x: 40, y: 40, w: 400, h: 400 }),
  },
  boxes: [starterBox()],
  todo: { items: [] },
  notes: { notes: [], activeId: null },
  pomodoro: { work: 25, shortBreak: 5, longBreak: 15, cycles: 4, sound: true, notify: true, remainingMs: null, runningSince: null, endsAt: null, session: 'work', completed: 0 },
  schedule: { events: [] },
  wallpaper: { imageEnabled: false, imagePath: null, liveEnabled: false, livePath: null, pauseOnFullscreen: true, pauseOnBattery: true },
};

/** Presets applied to `theme`; widgets keep their own colours by default. */
export interface ThemePreset {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  accent: string;
  surface: string;
  text: string;
}

export const PRESETS: ThemePreset[] = [
  { id: 'midnight', name: 'Midnight', mode: 'dark', accent: '#6366f1', surface: '#16182b', text: '#e9eaf2' },
  { id: 'graphite', name: 'Graphite', mode: 'dark', accent: '#64748b', surface: '#1c1f24', text: '#e6e8ec' },
  { id: 'nord', name: 'Nord', mode: 'dark', accent: '#88c0d0', surface: '#2e3440', text: '#eceff4' },
  { id: 'dracula', name: 'Dracula', mode: 'dark', accent: '#bd93f9', surface: '#282a36', text: '#f8f8f2' },
  { id: 'forest', name: 'Forest', mode: 'dark', accent: '#4ade80', surface: '#14231c', text: '#e7f5ec' },
  { id: 'sunset', name: 'Sunset', mode: 'dark', accent: '#fb7185', surface: '#2a1a20', text: '#fdecef' },
  { id: 'daylight', name: 'Daylight', mode: 'light', accent: '#2563eb', surface: '#f7f8fc', text: '#1b1d2a' },
  { id: 'parchment', name: 'Parchment', mode: 'light', accent: '#b45309', surface: '#faf6ef', text: '#2b241c' },
];

export function presetById(id: string): ThemePreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
