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

export type WidgetId =
  | 'todo'
  | 'notes'
  | 'pomodoro'
  | 'schedule'
  | 'launcher'
  | 'weather'
  | 'calendar'
  | 'clock';

export interface WidgetState {
  enabled: boolean;
  style: WidgetStyle;
  /** Position within the bounded workspace canvas, in canvas px. */
  x: number;
  y: number;
  w: number;
  h: number;
  minimized: boolean;
  maximized: boolean;
}

/** Migration marker for the bounded workspace layout. */
export const FLOATING_LAYOUT_VERSION = 4;
export const FLOATING_BASE = { w: 704, h: 880 } as const;
export const WORKSPACE_GAP = 12;
export const WORKSPACE_GRID = 4;
export const WIDGET_HEADER_HEIGHT = 28;

export interface FloatingFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WidgetLimits {
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
}

/** Per-widget resize limits chosen to keep content readable. */
export const WIDGET_LIMITS: Record<WidgetId, WidgetLimits> = {
  launcher: { minW: 240, minH: 56, maxW: 1200, maxH: 180 },
  todo: { minW: 260, minH: 180, maxW: 560, maxH: 640 },
  pomodoro: { minW: 260, minH: 140, maxW: 520, maxH: 320 },
  schedule: { minW: 260, minH: 180, maxW: 560, maxH: 640 },
  clock: { minW: 220, minH: 88, maxW: 420, maxH: 200 },
  weather: { minW: 220, minH: 88, maxW: 420, maxH: 220 },
  notes: { minW: 220, minH: 148, maxW: 520, maxH: 560 },
  calendar: { minW: 260, minH: 220, maxW: 520, maxH: 520 },
};

/**
 * Deliberate two-column grid on a 704x880 canvas.
 * Outer margin=20, column gutter=12, vertical gap=12.
 */
export const FLOATING_FRAMES: Record<WidgetId, FloatingFrame> = {
  launcher: { x: 20, y: 0, w: 660, h: 72 },
  todo: { x: 20, y: 84, w: 348, h: 280 },
  pomodoro: { x: 20, y: 376, w: 348, h: 160 },
  schedule: { x: 20, y: 548, w: 348, h: 300 },
  clock: { x: 380, y: 84, w: 300, h: 108 },
  weather: { x: 380, y: 204, w: 300, h: 108 },
  notes: { x: 380, y: 324, w: 300, h: 228 },
  calendar: { x: 380, y: 564, w: 300, h: 284 },
};

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
  /** Wallpaper to return to when the user restores the Windows desktop image. */
  systemPreviousPath: string | null;
  /** Last image explicitly applied to the Windows desktop. */
  systemAppliedPath: string | null;
}

export interface TypographyConfig {
  /** Base text size in px. */
  size: number;
  /** Key of FONT_OPTIONS. */
  family: string;
  weight: number;
  letterSpacing: number;
  lineHeight: number;
}

export interface LayoutConfig {
  /** Diameter of NOVA's collapsed circle in px. */
  orbSize: number;
  panelWidth: number;
  panelHeight: number;
  padding: number;
  gap: number;
  /** Migration marker for the floating-card geometry stored in `widgets`. */
  floatingVersion: number;
}

export interface BehaviorConfig {
  hoverExpand: boolean;
  collapseDelayMs: number;
  animations: boolean;
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
  typography: TypographyConfig;
  layout: LayoutConfig;
  behavior: BehaviorConfig;
  /** Preferred collapsed NOVA position in logical desktop pixels. */
  nova: { x: number | null; y: number | null };
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

function widget(id: WidgetId, over: Partial<WidgetState> = {}): WidgetState {
  return {
    enabled: id !== 'launcher',
    style: { ...DEFAULT_STYLE },
    ...FLOATING_FRAMES[id],
    minimized: false,
    maximized: false,
    ...over,
  };
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
  theme: { preset: 'midnight', mode: 'dark', accent: '#60a5fa', layer: 'above' },
  startup: { autoStart: true, startHidden: true },
  widgets: {
    todo: widget('todo'),
    notes: widget('notes'),
    pomodoro: widget('pomodoro'),
    schedule: widget('schedule'),
    launcher: widget('launcher'),
    weather: widget('weather'),
    calendar: widget('calendar'),
    clock: widget('clock'),
  },
  boxes: [starterBox()],
  todo: { items: [] },
  notes: { notes: [], activeId: null },
  pomodoro: { work: 25, shortBreak: 5, longBreak: 15, cycles: 4, sound: true, notify: true, remainingMs: null, runningSince: null, endsAt: null, session: 'work', completed: 0 },
  schedule: { events: [] },
  wallpaper: {
    imageEnabled: false,
    imagePath: null,
    liveEnabled: false,
    livePath: null,
    pauseOnFullscreen: true,
    pauseOnBattery: true,
    systemPreviousPath: null,
    systemAppliedPath: null,
  },
  typography: { size: 13, family: 'system', weight: 500, letterSpacing: 0, lineHeight: 1.4 },
  layout: {
    orbSize: 46,
    panelWidth: 720,
    panelHeight: 936,
    padding: 8,
    gap: 6,
    floatingVersion: FLOATING_LAYOUT_VERSION,
  },
  behavior: { hoverExpand: true, collapseDelayMs: 5000, animations: true },
  nova: { x: null, y: null },
};

export const FONT_OPTIONS: Array<{ id: string; label: string; stack: string }> = [
  { id: 'system', label: 'System UI', stack: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif" },
  { id: 'segoe', label: 'Segoe UI', stack: "'Segoe UI', system-ui, sans-serif" },
  { id: 'arial', label: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
  { id: 'georgia', label: 'Georgia', stack: 'Georgia, serif' },
  { id: 'mono', label: 'Monospace', stack: "'Cascadia Code', Consolas, monospace" },
];

export function fontStack(id: string): string {
  return FONT_OPTIONS.find((option) => option.id === id)?.stack ?? FONT_OPTIONS[0].stack;
}

/** Presets applied to `theme`; widgets keep their own colours by default. */
export interface ThemePreset {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  accent: string;
  surface: string;
  text: string;
  opacity: number;
  radius: number;
}

export const PRESETS: ThemePreset[] = [
  { id: 'dark-glass', name: 'Dark Glass', mode: 'dark', accent: '#8b5cf6', surface: '#10131f', text: '#f4f5fb', opacity: 72, radius: 16 },
  { id: 'light', name: 'Light', mode: 'light', accent: '#2563eb', surface: '#f7f8fc', text: '#1b1d2a', opacity: 88, radius: 12 },
  { id: 'midnight', name: 'Midnight Blue', mode: 'dark', accent: '#60a5fa', surface: '#0f1b33', text: '#e8f0ff', opacity: 78, radius: 18 },
  { id: 'warm', name: 'Warm', mode: 'light', accent: '#b45309', surface: '#faf3e8', text: '#2f251b', opacity: 86, radius: 20 },
];

export function presetById(id: string): ThemePreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
