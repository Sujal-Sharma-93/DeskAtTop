/**
 * Launcher box entry point.
 *
 * The box is its own small window (`box-main`): this page paints exactly one
 * panel, fills the window, and the title bar drags the window around.
 */
import './styles/tokens.css';
import './styles/overlay.css';
import {
  applyGlobalTheme,
  itemLabel,
  onTrayToggle,
  openSettingsWindow,
  openTarget,
  getBoxGeometry,
  onWindowMoved,
  resolveIcons,
  setBoxBounds,
  syncWallpaperWindow,
  uiError,
  uiReady,
} from './lib/api';
import { showBootMessage } from './boot-guard';
import {
  flush as flushStore,
  initStore,
  onSettingsChange,
  settings,
  touch,
} from './lib/store.svelte';
import type { Rect } from './lib/drag';
import { boundsFromDrag, collapsedBounds, expandedBounds, lerpBounds, type Bounds } from './lib/nova-layout';
import { novaFallback, novaIcon } from './lib/nova-icons';
import { NovaMachine } from './lib/nova-state';
import { applyNovaVars } from './lib/style';
import {
  FLOATING_BASE,
  FLOATING_FRAMES,
  WIDGET_HEADER_HEIGHT,
  WIDGET_LIMITS,
  WORKSPACE_GAP,
  WORKSPACE_GRID,
  type LaunchItem,
  type LauncherBox,
  type ScheduleEvent,
  type TodoItem,
  type WidgetId,
} from './lib/types';
import type { SchedEvent } from './lib/api';
import type { CalendarPanel } from './widgets/calendar';
import type { ClockPanel } from './widgets/clock';
import type { NotesPanel, NotesState } from './widgets/notes';
import type { SchedulePanel } from './widgets/schedule';
import type { TimerPanel } from './widgets/timer';
import type { TodoPanel } from './widgets/todo';
import type { WeatherPanel } from './widgets/weather';

interface IconSlot {
  target: string;
  host: HTMLElement;
  curated: boolean;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** The panel this window shows: the Quick Launch box, else the first one. */
function pickBox(boxes: LauncherBox[]): LauncherBox | undefined {
  return boxes.find((b) => b.title === 'Quick Launch') ?? boxes[0];
}

/** One fallback tile glyph; replaced by the real shell icon once extracted. */
function tileIcon(item: LaunchItem): IconSlot {
  const host = element('span', 'launcher-item-icon');
  host.setAttribute('aria-hidden', 'true');
  const curated = novaIcon(item);
  if (curated) {
    host.classList.add('is-curated');
    host.innerHTML = curated;
    return { target: item.target, host, curated: true };
  }
  if (item.icon) {
    const img = element('img');
    img.alt = '';
    img.src = item.icon;
    host.append(img);
    return { target: item.target, host, curated: true };
  }
  host.classList.add('is-nova');
  host.innerHTML = novaFallback(item.kind);
  return { target: item.target, host, curated: false };
}

interface ExpandController {
  open(): void;
  syncSize(force?: boolean): void;
  applyAnchor(x: number | null, y: number | null): void;
  targetSize(): { width: number; height: number };
  isExpanded(): boolean;
}

interface CardView {
  id: WidgetId;
  root: HTMLElement;
  handle: HTMLElement;
  body: HTMLElement;
  minimizeButton: HTMLButtonElement;
  maximizeButton: HTMLButtonElement;
  rect: Rect | null;
}

const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type ResizeEdge = (typeof RESIZE_EDGES)[number];
const LAYOUT_ORDER: WidgetId[] = [
  'launcher',
  'clock',
  'weather',
  'notes',
  'calendar',
  'todo',
  'pomodoro',
  'schedule',
];

interface BoxView {
  root: HTMLElement;
  update(box: LauncherBox): void;
  syncSize(force?: boolean): void;
  applyAnchor(x: number | null, y: number | null): void;
  flush(): void;
  resume(): void;
}

/** Stable signature so unrelated settings changes do not rebuild the list. */
function todoSignature(items: TodoItem[]): string {
  return items
    .map((item) => `${item.id}\u0001${item.done ? 1 : 0}\u0001${item.text}`)
    .join('\u0002');
}

function notesSignature(state: NotesState): string {
  const notes = state.notes
    .map((note) => `${note.id}\u0001${note.updatedAt}`)
    .join('\u0002');
  return `${state.activeId ?? ''}\u0003${notes}`;
}

function toSchedEvent(ev: ScheduleEvent): SchedEvent {
  return {
    id: ev.id,
    title: ev.title,
    body: ev.body,
    at: ev.at,
    repeat: ev.repeat,
    snoozed_until: null,
    enabled: ev.enabled,
  };
}

function fromSchedEvent(ev: SchedEvent): ScheduleEvent {
  return {
    id: ev.id,
    title: ev.title,
    body: ev.body,
    at: ev.at,
    repeat: ev.repeat,
    firedAt: null,
    enabled: ev.enabled,
  };
}
function render(box: LauncherBox): BoxView {
  const root = element('div', 'box-root');
  const section = element('section', 'launcher-box');

  const orb = element('div', 'nova-orb');
  orb.setAttribute('data-tauri-drag-region', '');
  const flipDirections = Math.random() < 0.5;
  for (let ring = 1; ring <= 3; ring += 1) {
    const circle = element('span', 'nova-ring');
    circle.dataset.ring = String(ring);
    const tick = element('span', 'nova-tick');
    tick.dataset.ring = String(ring);
    const clockwise = (ring % 2 === 1) !== flipDirections;
    tick.style.setProperty('--tick-direction', clockwise ? 'normal' : 'reverse');
    orb.append(circle, tick);
  }

  const bar = element('header', 'launcher-title');
  const title = element('span', 'launcher-title-text');
  title.setAttribute('data-tauri-drag-region', '');
  const studioButton = element('button', 'nova-studio-button');
  studioButton.type = 'button';
  studioButton.title = 'Open DeskAtTop Studio';
  studioButton.setAttribute('aria-label', 'Open DeskAtTop Studio');
  const studioMark = element('span', 'nova-studio-mark');
  studioMark.setAttribute('aria-hidden', 'true');
  studioButton.append(studioMark);
  bar.append(title, studioButton);

  const workspace = element('div', 'launcher-workspace');
  workspace.setAttribute('inert', '');
  workspace.tabIndex = 0;
  workspace.setAttribute('aria-label', 'Widget workspace');
  const canvas = element('div', 'workspace-canvas');
  const grid = element('div', 'workspace-grid');
  grid.setAttribute('aria-hidden', 'true');
  const preview = element('div', 'placement-preview');
  preview.hidden = true;
  canvas.append(grid, preview);
  workspace.append(canvas);
  section.append(orb, bar, workspace);
  root.append(section);

  let todoPanel: TodoPanel | null = null;
  let todoLoading = false;
  let todoKey = '';
  let notesPanel: NotesPanel | null = null;
  let notesLoading = false;
  let notesKey = '';
  let timerPanel: TimerPanel | null = null;
  let timerLoading = false;
  let schedulePanel: SchedulePanel | null = null;
  let scheduleLoading = false;
  let weatherPanel: WeatherPanel | null = null;
  let calendarPanel: CalendarPanel | null = null;
  let clockPanel: ClockPanel | null = null;

  const expand = wireExpand(section, orb, workspace, studioButton, (state) => {
    if (state === 'expanded') clockPanel?.resume();
    else clockPanel?.suspend();
  });

  const cards = new Map<WidgetId, CardView>();
  const bounds: { w: number; h: number } = { w: FLOATING_BASE.w, h: FLOATING_BASE.h };
  let zIndex = 10;
  let maximizedId: WidgetId | null = null;

  const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);

  const snap = (value: number): number => Math.round(value / WORKSPACE_GRID) * WORKSPACE_GRID;

  const gridClamp = (value: number, min: number, max: number): number => {
    const upper = Math.floor(max / WORKSPACE_GRID) * WORKSPACE_GRID;
    if (upper < min) return min;
    return clamp(snap(value), min, upper);
  };

  const canvasMetrics = (): { w: number; h: number } => {
    const w = snap(Math.max(FLOATING_BASE.w, Math.round(workspace.clientWidth || FLOATING_BASE.w)));
    const h = snap(Math.max(FLOATING_BASE.h, Math.round(workspace.clientHeight || FLOATING_BASE.h)));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    return { w, h };
  };

  const clampRect = (rect: Rect, w: number, h: number): Rect => ({
    x: Math.round(clamp(rect.x, 0, Math.max(0, w - rect.w))),
    y: Math.round(clamp(rect.y, 0, Math.max(0, h - rect.h))),
    w: Math.round(clamp(rect.w, 1, w)),
    h: Math.round(clamp(rect.h, 1, h)),
  });

  const isVisible = (id: WidgetId): boolean =>
    (id === 'launcher' || settings.widgets[id].enabled) &&
    (maximizedId === null || maximizedId === id);

  const overlaps = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.w + WORKSPACE_GAP &&
    a.x + a.w + WORKSPACE_GAP > b.x &&
    a.y < b.y + b.h + WORKSPACE_GAP &&
    a.y + a.h + WORKSPACE_GAP > b.y;

  const otherRects = (id: WidgetId): Rect[] =>
    [...cards.values()]
      .filter((card) => card.id !== id && !card.root.hidden && card.rect && isVisible(card.id))
      .map((card) => card.rect as Rect);

  const isFree = (id: WidgetId, rect: Rect): boolean =>
    !otherRects(id).some((other) => overlaps(rect, other));

  /** Nearest non-overlapping, in-bounds, grid-snapped placement. */
  const findValidRect = (id: WidgetId, desired: Rect, metrics = canvasMetrics()): Rect | null => {
    const base = clampRect(
      {
        ...desired,
        x: gridClamp(desired.x, 0, metrics.w - Math.max(WORKSPACE_GRID, desired.w)),
        y: gridClamp(desired.y, 0, metrics.h - Math.max(WORKSPACE_GRID, desired.h)),
        w: snap(Math.max(WORKSPACE_GRID, desired.w)),
        h: snap(Math.max(WORKSPACE_GRID, desired.h)),
      },
      metrics.w,
      metrics.h,
    );
    const seen = new Set<string>();
    const candidates: Rect[] = [];
    const add = (x: number, y: number): void => {
      const rect = clampRect(
        {
          ...base,
          x: gridClamp(x, 0, metrics.w - base.w),
          y: gridClamp(y, 0, metrics.h - base.h),
        },
        metrics.w,
        metrics.h,
      );
      const key = `${rect.x}:${rect.y}:${rect.w}:${rect.h}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(rect);
    };

    add(base.x, base.y);
    for (const other of otherRects(id)) {
      add(other.x - base.w - WORKSPACE_GAP, base.y);
      add(other.x + other.w + WORKSPACE_GAP, base.y);
      add(base.x, other.y - base.h - WORKSPACE_GAP);
      add(base.x, other.y + other.h + WORKSPACE_GAP);
      add(other.x - base.w - WORKSPACE_GAP, other.y - base.h - WORKSPACE_GAP);
      add(other.x + other.w + WORKSPACE_GAP, other.y + other.h + WORKSPACE_GAP);
    }
    for (let ring = 1; ring <= 12; ring += 1) {
      for (let oy = -ring; oy <= ring; oy += 1) {
        for (let ox = -ring; ox <= ring; ox += 1) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== ring) continue;
          add(base.x + ox * WORKSPACE_GRID * 4, base.y + oy * WORKSPACE_GRID * 4);
        }
      }
    }
    candidates.sort((a, b) => {
      const da = (a.x - base.x) ** 2 + (a.y - base.y) ** 2;
      const db = (b.x - base.x) ** 2 + (b.y - base.y) ** 2;
      return da - db;
    });
    return candidates.find((rect) => isFree(id, rect)) ?? null;
  };

  const showPreview = (rect: Rect | null, valid = true): void => {
    if (!rect) {
      preview.hidden = true;
      return;
    }
    preview.hidden = false;
    preview.style.left = `${Math.round(rect.x)}px`;
    preview.style.top = `${Math.round(rect.y)}px`;
    preview.style.width = `${Math.round(rect.w)}px`;
    preview.style.height = `${Math.round(rect.h)}px`;
    preview.classList.toggle('is-invalid', !valid);
  };

  const applyCardRect = (card: CardView, rect: Rect): void => {
    card.rect = { ...rect };
    card.root.style.left = `${Math.round(rect.x)}px`;
    card.root.style.top = `${Math.round(rect.y)}px`;
    card.root.style.width = `${Math.round(rect.w)}px`;
    card.root.style.height = `${Math.round(rect.h)}px`;
  };

  const persistCard = (card: CardView, includeSize = false): void => {
    if (!card.rect) return;
    const state = settings.widgets[card.id];
    const changed =
      state.x !== card.rect.x ||
      state.y !== card.rect.y ||
      (includeSize && (state.w !== card.rect.w || state.h !== card.rect.h));
    if (!changed) return;
    state.x = card.rect.x;
    state.y = card.rect.y;
    if (includeSize) {
      state.w = card.rect.w;
      state.h = card.rect.h;
    }
    touch(0);
  };

  const raiseCard = (card: CardView): void => {
    zIndex += 1;
    card.root.style.zIndex = String(zIndex);
  };

  function syncCardControls(card: CardView): void {
    const state = settings.widgets[card.id];
    card.root.dataset.minimized = String(state.minimized);
    card.root.dataset.maximized = String(state.maximized);
    card.minimizeButton.textContent = state.minimized ? '▴' : '▾';
    card.minimizeButton.title = state.minimized ? 'Restore widget' : 'Minimize widget';
    card.minimizeButton.setAttribute('aria-label', card.minimizeButton.title);
    card.maximizeButton.textContent = state.maximized ? '❐' : '□';
    card.maximizeButton.title = state.maximized ? 'Restore widget size' : 'Maximize widget';
    card.maximizeButton.setAttribute('aria-label', card.maximizeButton.title);
  }

  const attachCardDrag = (card: CardView): void => {
    let active = false;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let origin: Rect | null = null;
    let candidate: Rect | null = null;

    card.handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.detail > 1) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-no-drag], button, input, textarea, select, a, label')) return;
      if (!card.rect || settings.widgets[card.id].maximized) return;
      active = true;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      origin = { ...card.rect };
      candidate = null;
      canvas.classList.add('is-aligning');
      raiseCard(card);
      event.preventDefault();
    });

    window.addEventListener('pointermove', (event) => {
      if (!active || event.pointerId !== pointerId || !origin) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.hypot(dx, dy) < 3) return;
      const desired = clampRect(
        { ...origin, x: origin.x + dx, y: origin.y + dy },
        bounds.w,
        bounds.h,
      );
      candidate = findValidRect(card.id, desired, bounds);
      showPreview(candidate ?? desired, Boolean(candidate));
      event.preventDefault();
    });

    const finish = (event: PointerEvent): void => {
      if (!active || event.pointerId !== pointerId) return;
      active = false;
      pointerId = -1;
      const accepted = candidate;
      candidate = null;
      showPreview(null);
      canvas.classList.remove('is-aligning');
      if (accepted && origin) {
        applyCardRect(card, accepted);
        persistCard(card);
      }
      origin = null;
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    card.root.addEventListener('focusin', () => raiseCard(card));
  };

  const attachResize = (card: CardView): void => {
    let active = false;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let origin: Rect | null = null;
    let edge: ResizeEdge = 'se';
    let candidate: Rect | null = null;

    card.root.addEventListener('pointerdown', (event) => {
      const handle = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-resize]');
      if (!handle || event.button !== 0 || event.detail > 1) return;
      const state = settings.widgets[card.id];
      if (!card.rect || state.minimized || state.maximized) return;
      active = true;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      origin = { ...card.rect };
      edge = handle.dataset.resize as ResizeEdge;
      candidate = null;
      canvas.classList.add('is-aligning');
      raiseCard(card);
      event.preventDefault();
    });

    window.addEventListener('pointermove', (event) => {
      if (!active || event.pointerId !== pointerId || !origin) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      const limits = WIDGET_LIMITS[card.id];
      const o = origin;
      let { x, y, w, h } = o;
      if (edge.includes('e')) {
        w = gridClamp(o.w + dx, limits.minW, Math.min(limits.maxW, bounds.w - o.x));
      }
      if (edge.includes('s')) {
        h = gridClamp(o.h + dy, limits.minH, Math.min(limits.maxH, bounds.h - o.y));
      }
      if (edge.includes('w')) {
        w = gridClamp(o.w - dx, limits.minW, Math.min(limits.maxW, o.x + o.w));
        x = o.x + o.w - w;
      }
      if (edge.includes('n')) {
        h = gridClamp(o.h - dy, limits.minH, Math.min(limits.maxH, o.y + o.h));
        y = o.y + o.h - h;
      }
      const next = clampRect({ x, y, w, h }, bounds.w, bounds.h);
      candidate = isFree(card.id, next) ? next : null;
      showPreview(candidate ?? next, Boolean(candidate));
      event.preventDefault();
    });

    const finish = (event: PointerEvent): void => {
      if (!active || event.pointerId !== pointerId) return;
      active = false;
      pointerId = -1;
      const accepted = candidate;
      candidate = null;
      showPreview(null);
      canvas.classList.remove('is-aligning');
      if (accepted) {
        applyCardRect(card, accepted);
        persistCard(card, true);
      }
      origin = null;
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  function toggleMinimize(card: CardView): void {
    const state = settings.widgets[card.id];
    if (state.maximized) {
      state.maximized = false;
      if (maximizedId === card.id) maximizedId = null;
    }
    state.minimized = !state.minimized;
    touch(0);
    layoutCards();
  }

  function toggleMaximize(card: CardView): void {
    const state = settings.widgets[card.id];
    if (state.maximized) {
      state.maximized = false;
      if (maximizedId === card.id) maximizedId = null;
    } else {
      if (maximizedId) settings.widgets[maximizedId].maximized = false;
      state.minimized = false;
      state.maximized = true;
      maximizedId = card.id;
      raiseCard(card);
    }
    touch(0);
    layoutCards();
  }

  const createCard = (id: WidgetId, label: string): CardView => {
    const cardRoot = element('section', `glass-card card-${id}`);
    cardRoot.dataset.card = id;
    const handle = element('header', 'card-handle');
    const grip = element('span', 'card-grip');
    grip.setAttribute('aria-hidden', 'true');
    const heading = element('h2', 'card-title');
    heading.textContent = label;
    const spacer = element('span', 'card-title-spacer');
    const maximizeButton = element('button', 'card-control');
    maximizeButton.type = 'button';
    maximizeButton.textContent = '□';
    const minimizeButton = element('button', 'card-control');
    minimizeButton.type = 'button';
    minimizeButton.textContent = '▾';
    handle.append(grip, heading, spacer, maximizeButton, minimizeButton);
    const body = element('div', 'card-body');
    cardRoot.append(handle, body);
    for (const edge of RESIZE_EDGES) {
      const gripHandle = element('span', 'resize-handle');
      gripHandle.dataset.resize = edge;
      cardRoot.append(gripHandle);
    }
    canvas.append(cardRoot);
    const card: CardView = {
      id,
      root: cardRoot,
      handle,
      body,
      minimizeButton,
      maximizeButton,
      rect: null,
    };
    cards.set(id, card);
    maximizeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleMaximize(card);
    });
    minimizeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleMinimize(card);
    });
    attachCardDrag(card);
    attachResize(card);
    return card;
  };

  const launcherCard = createCard('launcher', 'Quick Launch');
  createCard('clock', 'Date & Time');
  createCard('weather', 'Weather');
  createCard('notes', 'Notes');
  createCard('pomodoro', 'Timer');
  createCard('schedule', 'Schedule');
  createCard('todo', 'To-do');
  createCard('calendar', 'Calendar');
  const savedMaximized = LAYOUT_ORDER.find((id) => settings.widgets[id].maximized) ?? null;
  for (const id of LAYOUT_ORDER) {
    settings.widgets[id].maximized = id === savedMaximized;
    if (id === savedMaximized) settings.widgets[id].minimized = false;
  }
  maximizedId = savedMaximized;
  const cardBody = (id: WidgetId): HTMLElement => {
    const card = cards.get(id);
    if (!card) throw new Error(`missing card: ${id}`);
    return card.body;
  };

  function layoutCards(): void {
    const metrics = canvasMetrics();
    bounds.w = metrics.w;
    bounds.h = metrics.h;
    for (const card of cards.values()) {
      syncCardControls(card);
      card.rect = null;
    }
    for (const id of LAYOUT_ORDER) {
      const card = cards.get(id);
      if (!card) continue;
      const state = settings.widgets[id];
      if (!isVisible(id)) {
        card.root.hidden = true;
        continue;
      }
      card.root.hidden = false;
      const limits = WIDGET_LIMITS[id];
      const minW = Math.min(limits.minW, metrics.w);
      const minH = Math.min(limits.minH, metrics.h);
      let w = clamp(Math.round(state.w), minW, Math.min(limits.maxW, metrics.w));
      let h = clamp(Math.round(state.h), minH, Math.min(limits.maxH, metrics.h));
      let x = state.x;
      let y = state.y;
      if (state.maximized) {
        x = 20;
        y = 20;
        w = metrics.w - 40;
        h = metrics.h - 40;
      } else if (state.minimized) {
        h = WIDGET_HEADER_HEIGHT;
      }
      const desired = clampRect({ x, y, w, h }, metrics.w, metrics.h);
      const placed =
        findValidRect(id, desired, metrics) ??
        findValidRect(id, { ...FLOATING_FRAMES[id], w: desired.w, h: desired.h }, metrics) ??
        findValidRect(id, FLOATING_FRAMES[id], metrics) ??
        clampRect(FLOATING_FRAMES[id], metrics.w, metrics.h);
      applyCardRect(card, placed);
    }
  }

  window.addEventListener('resize', () => layoutCards());

  let itemsKey = '';
  let slots: IconSlot[] = [];

  const rebuildPanel = (next: LauncherBox): void => {
    slots = [];
    if (next.items.length === 0) {
      const empty = element('p', 'launcher-empty');
      empty.textContent = 'No shortcuts yet';
      launcherCard.body.replaceChildren(empty);
      return;
    }

    const list = element('ul', 'launcher-items');
    for (const item of next.items) {
      const row = element('li');
      const button = element('button', 'launcher-item');
      button.type = 'button';
      button.title = item.label || item.target;

      const slot = tileIcon(item);
      slots.push(slot);

      const label = element('span', 'launcher-item-label');
      label.textContent = itemLabel(item);
      button.append(slot.host, label);
      button.addEventListener('click', () => {
        void openTarget(item.target).catch((err) => console.error('open failed', err));
      });
      row.append(button);
      list.append(row);
    }
    launcherCard.body.replaceChildren(list);
    void hydrateIcons(slots);
  };

  async function ensureTodo(): Promise<void> {
    if (todoPanel || todoLoading) return;
    if (!settings.widgets.todo.enabled) return;
    todoLoading = true;
    try {
      // Dynamic import: the widget chunk is only fetched when it is enabled.
      const mod = await import('./widgets/todo');
      if (!settings.widgets.todo.enabled) return;
      todoPanel = mod.createTodoPanel({
        getItems: () => settings.todo.items,
        onChange: (items) => {
          settings.todo.items = items;
          todoKey = todoSignature(items);
          touch();
        },
      });
      cardBody('todo').replaceChildren(todoPanel.element);
      todoKey = todoSignature(settings.todo.items);
      todoPanel.update(settings.todo.items);
    } catch (err) {
      console.error('todo widget failed to load', err);
    } finally {
      todoLoading = false;
    }
  }

  async function ensureNotes(): Promise<void> {
    if (notesPanel || notesLoading) return;
    if (!settings.widgets.notes.enabled) return;
    notesLoading = true;
    try {
      // Dynamic import: the notes chunk is only fetched when enabled.
      const mod = await import('./widgets/notes');
      if (!settings.widgets.notes.enabled) return;
      notesPanel = mod.createNotesPanel({
        getState: () => settings.notes,
        onChange: (state) => {
          settings.notes = state;
          notesKey = notesSignature(state);
          touch();
        },
      });
      cardBody('notes').replaceChildren(notesPanel.element);
      notesKey = notesSignature(settings.notes);
      notesPanel.update(settings.notes);
    } catch (err) {
      console.error('notes widget failed to load', err);
    } finally {
      notesLoading = false;
    }
  }

  async function ensureTimer(): Promise<void> {
    if (timerPanel || timerLoading) return;
    if (!settings.widgets.pomodoro.enabled) return;
    timerLoading = true;
    try {
      // Dynamic import: the timer chunk is only fetched when enabled.
      const mod = await import('./widgets/timer');
      if (!settings.widgets.pomodoro.enabled) return;
      timerPanel = mod.createTimerPanel({
        getState: () => settings.pomodoro,
        onChange: (patch) => {
          Object.assign(settings.pomodoro, patch);
          touch();
        },
      });
      cardBody('pomodoro').replaceChildren(timerPanel.element);
    } catch (err) {
      console.error('timer widget failed to load', err);
    } finally {
      timerLoading = false;
    }
  }

  async function ensureSchedule(): Promise<void> {
    if (schedulePanel || scheduleLoading) return;
    if (!settings.widgets.schedule.enabled) return;
    scheduleLoading = true;
    try {
      // Dynamic import: the schedule chunk is only fetched when enabled.
      const mod = await import('./widgets/schedule');
      if (!settings.widgets.schedule.enabled) return;
      schedulePanel = mod.createSchedulePanel({
        getEvents: () => settings.schedule.events.map(toSchedEvent),
        onChange: (events) => {
          settings.schedule.events = events.map(fromSchedEvent);
          touch();
        },
      });
      cardBody('schedule').replaceChildren(schedulePanel.element);
    } catch (err) {
      console.error('schedule widget failed to load', err);
    } finally {
      scheduleLoading = false;
    }
  }

  async function ensureWeather(): Promise<void> {
    if (weatherPanel) return;
    if (!settings.widgets.weather.enabled) return;
    try {
      const mod = await import('./widgets/weather');
      if (!settings.widgets.weather.enabled) return;
      weatherPanel = mod.createWeatherPanel();
      cardBody('weather').replaceChildren(weatherPanel.element);
    } catch (err) {
      console.error('weather widget failed to load', err);
    }
  }

  async function ensureCalendar(): Promise<void> {
    if (calendarPanel) return;
    if (!settings.widgets.calendar.enabled) return;
    try {
      const mod = await import('./widgets/calendar');
      if (!settings.widgets.calendar.enabled) return;
      calendarPanel = mod.createCalendarPanel({
        getEvents: () => settings.schedule.events,
      });
      cardBody('calendar').replaceChildren(calendarPanel.element);
    } catch (err) {
      console.error('calendar widget failed to load', err);
    }
  }

  async function ensureClock(): Promise<void> {
    if (clockPanel) return;
    if (!settings.widgets.clock.enabled) return;
    try {
      const mod = await import('./widgets/clock');
      if (!settings.widgets.clock.enabled) return;
      clockPanel = mod.createClockPanel();
      cardBody('clock').replaceChildren(clockPanel.element);
    } catch (err) {
      console.error('clock widget failed to load', err);
    }
  }

  const applyWidgets = (): void => {
    for (const card of cards.values()) card.root.hidden = !isVisible(card.id);

    // Commit a buffered note edit as soon as its card is hidden.
    if (!settings.widgets.notes.enabled) notesPanel?.flush();

    if (settings.widgets.todo.enabled) {
      void ensureTodo();
      if (todoPanel) {
        const key = todoSignature(settings.todo.items);
        if (key !== todoKey) {
          todoKey = key;
          todoPanel.update(settings.todo.items);
        }
      }
    }

    if (settings.widgets.notes.enabled) {
      void ensureNotes();
      if (notesPanel) {
        const key = notesSignature(settings.notes);
        if (key !== notesKey) {
          notesKey = key;
          notesPanel.update(settings.notes);
        }
      }
    }

    if (settings.widgets.pomodoro.enabled) {
      void ensureTimer();
      // No-op unless a session is running; keeps exactly one 1 s interval.
      timerPanel?.resume();
    } else {
      timerPanel?.suspend();
    }

    if (settings.widgets.schedule.enabled) {
      void ensureSchedule();
    }

    if (settings.widgets.weather.enabled) void ensureWeather();
    if (settings.widgets.calendar.enabled) {
      void ensureCalendar();
      calendarPanel?.update(settings.schedule.events);
    }
    if (settings.widgets.clock.enabled) {
      void ensureClock();
      if (expand.isExpanded()) clockPanel?.resume();
      else clockPanel?.suspend();
    }

    layoutCards();
  };

  const update = (next: LauncherBox): void => {
    section.dataset.boxId = next.id;
    applyNovaVars(section, next.style, settings.typography, settings.layout, settings.behavior);
    title.textContent = next.title || 'Quick Launch';

    const key = next.items
      .map((item) => `${item.id}\u0001${item.kind}\u0001${item.target}\u0001${item.label}`)
      .join('\u0002');
    if (key !== itemsKey) {
      itemsKey = key;
      rebuildPanel(next);
    }
    applyWidgets();
    expand.syncSize();
    layoutCards();
  };

  update(box);
  return {
    root,
    update,
    syncSize: (force = false) => {
      expand.syncSize(force);
      layoutCards();
    },
    applyAnchor: (x, y) => expand.applyAnchor(x, y),
    flush: () => {
      notesPanel?.flush();
      timerPanel?.suspend();
      clockPanel?.suspend();
    },
    resume: () => {
      timerPanel?.resume();
      if (expand.isExpanded()) clockPanel?.resume();
    },
  };
}

function wireExpand(
  section: HTMLElement,
  orb: HTMLElement,
  panel: HTMLElement,
  studioButton: HTMLButtonElement,
  onVisual: (state: 'collapsed' | 'expanded' | 'closing') => void,
): ExpandController {
  type Visual = 'collapsed' | 'expanded' | 'closing';
  const ORB_PADDING = 9;
  const OPEN_MS = 260;
  const CLOSE_MS = 420;
  let machine: NovaMachine;
  let initialized = false;
  let anchor = { x: 0, y: 0 };
  let screen: Bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  let lastKey = '';
  let boundsToken = 0;
  let boundsFrame: number | undefined;
  let boundsAnimating = false;
  let anchorTimer: number | undefined;
  let nativeMoveTimer: number | undefined;
  let nativeDragArmed = false;
  let nativeDragActive = false;
  let nativeDragIdleTimer: number | undefined;
  let captureRetries = 0;
  let pointerStart: { x: number; y: number } | null = null;
  let dragMoved = false;

  const collapsedSide = (): number => settings.layout.orbSize + ORB_PADDING * 2;

  /** Saved panel dimensions are honoured, with a readable minimum that fits the screen. */
  const expandedSize = (): { width: number; height: number } => {
    const maxWidth = Math.max(360, screen.width - 16);
    const maxHeight = Math.max(300, screen.height - 16);
    return {
      width: Math.min(Math.max(settings.layout.panelWidth, 720), maxWidth),
      height: Math.min(Math.max(settings.layout.panelHeight, 600), maxHeight),
    };
  };

  const keyFor = (state: Visual, bounds: Bounds): string =>
    `${state}:${bounds.x.toFixed(1)},${bounds.y.toFixed(1)},${bounds.width.toFixed(1)}x${bounds.height.toFixed(1)}`;

  const expandedTarget = (): Bounds => {
    const size = expandedSize();
    return expandedBounds(anchor, collapsedSide(), size.width, size.height, screen);
  };

  const clampAnchor = (point: { x: number; y: number }, side: number, area: Bounds): { x: number; y: number } => {
    const bounds = collapsedBounds(point, side, area);
    return { x: bounds.x, y: bounds.y };
  };

  const cancelBoundsAnimation = (): void => {
    boundsToken += 1;
    if (boundsFrame !== undefined) {
      cancelAnimationFrame(boundsFrame);
      boundsFrame = undefined;
    }
    boundsAnimating = false;
  };

  const persistAnchor = (): void => {
    const x = Math.round(anchor.x);
    const y = Math.round(anchor.y);
    if (settings.nova.x === x && settings.nova.y === y) return;
    settings.nova = { x, y };
    touch(0);
  };

  const animateBounds = (target: Bounds, immediate: boolean, duration = OPEN_MS): void => {
    const token = ++boundsToken;
    if (boundsFrame !== undefined) {
      cancelAnimationFrame(boundsFrame);
      boundsFrame = undefined;
    }
    if (immediate) {
      boundsAnimating = false;
      void setBoxBounds(target)
        .then((geometry) => {
          if (token === boundsToken) screen = geometry.screen;
        })
        .catch((err) => console.error('nova bounds failed', err));
      return;
    }
    boundsAnimating = true;
    void getBoxGeometry()
      .then((from) => {
        if (token !== boundsToken) return;
        screen = from.screen;
        const start = performance.now();
        const tick = (now: number): void => {
          if (token !== boundsToken) return;
          const t = Math.min(1, (now - start) / duration);
          const eased = 1 - Math.pow(1 - t, 3);
          void setBoxBounds(lerpBounds(from, target, eased))
            .then((geometry) => {
              if (token === boundsToken) screen = geometry.screen;
            })
            .catch((err) => console.error('nova bounds failed', err))
            .finally(() => {
              if (token !== boundsToken) return;
              if (t < 1) {
                boundsFrame = requestAnimationFrame(tick);
              } else {
                boundsFrame = undefined;
                boundsAnimating = false;
              }
            });
        };
        boundsFrame = requestAnimationFrame(tick);
      })
      .catch((err) => {
        boundsAnimating = false;
        console.error('nova geometry failed', err);
      });
  };

  const initialize = (): void => {
    initialized = true;
    void getBoxGeometry()
      .then((geometry) => {
        screen = geometry.screen;
        const side = collapsedSide();
        const saved = settings.nova;
        const hasSaved =
          typeof saved.x === 'number' && Number.isFinite(saved.x) &&
          typeof saved.y === 'number' && Number.isFinite(saved.y);
        anchor = clampAnchor(
          hasSaved ? { x: saved.x as number, y: saved.y as number } : { x: geometry.x, y: geometry.y },
          side,
          screen,
        );
        const target =
          machine.state === 'expanded'
            ? expandedTarget()
            : collapsedBounds(anchor, side, screen);
        lastKey = keyFor(machine.state, target);
        void setBoxBounds(target)
          .then((actual) => {
            screen = actual.screen;
          })
          .catch((err) => console.error('nova restore failed', err));
      })
      .catch((err) => {
        initialized = false;
        console.error('nova geometry failed', err);
      });
  };

  const syncSize = (force = false, duration = OPEN_MS): void => {
    if (!initialized) {
      initialize();
      return;
    }
    const side = collapsedSide();
    const visual = machine.state === 'closing' ? 'collapsed' : machine.state;
    const target =
      visual === 'expanded'
        ? expandedTarget()
        : collapsedBounds(anchor, side, screen);
    const key = keyFor(visual, target);
    if (!force && key === lastKey) return;
    lastKey = key;
    animateBounds(target, force || !settings.behavior.animations, duration);
  };

  const applyVisual = (state: Visual): void => {
    section.classList.toggle('is-open', state === 'expanded');
    section.classList.toggle('is-closing', state === 'closing');
    if (state === 'expanded') panel.removeAttribute('inert');
    else panel.setAttribute('inert', '');
    if (state === 'closing') syncSize(false, CLOSE_MS);
    else syncSize();
    onVisual(state);
  };

  machine = new NovaMachine({
    timers: {
      set: (tick, ms) => window.setTimeout(tick, ms),
      clear: (handle) => window.clearTimeout(handle as number),
    },
    collapseDelay: () => settings.behavior.collapseDelayMs,
    closeAnimationMs: () => (settings.behavior.animations ? CLOSE_MS : 10),
    hoverEnabled: () => false,
    onChange: applyVisual,
  });

  const applyAnchor = (x: number | null, y: number | null): void => {
    if (!initialized || x === null || y === null) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    anchor = clampAnchor({ x, y }, collapsedSide(), screen);
    lastKey = '';
    syncSize(true);
  };

  const captureDragAnchor = (): void => {
    if (boundsAnimating) {
      anchorTimer = window.setTimeout(captureDragAnchor, OPEN_MS + 80);
      return;
    }
    anchorTimer = undefined;
    void getBoxGeometry()
      .then((geometry) => {
        screen = geometry.screen;
        const side = collapsedSide();
        const midResize =
          Math.abs(geometry.width - side) > 2 &&
          Math.abs(geometry.width - expandedSize().width) > 2;
        if (midResize && captureRetries < 10) {
          captureRetries += 1;
          anchorTimer = window.setTimeout(captureDragAnchor, 80);
          return;
        }
        anchor = clampAnchor(boundsFromDrag(geometry, side), side, screen);
        persistAnchor();
        const target =
          machine.state === 'expanded'
            ? expandedTarget()
            : collapsedBounds(anchor, side, screen);
        lastKey = keyFor(machine.state, target);
      })
      .catch((err) => console.error('nova geometry failed', err));
  };

  const scheduleNativeCapture = (): void => {
    if (!nativeDragActive) return;
    cancelBoundsAnimation();
    if (anchorTimer !== undefined) {
      window.clearTimeout(anchorTimer);
      anchorTimer = undefined;
    }
    if (nativeDragIdleTimer !== undefined) window.clearTimeout(nativeDragIdleTimer);
    nativeDragIdleTimer = window.setTimeout(() => {
      nativeDragActive = false;
      nativeDragArmed = false;
      nativeDragIdleTimer = undefined;
      machine.interactEnd();
    }, 600);
    if (nativeMoveTimer !== undefined) window.clearTimeout(nativeMoveTimer);
    captureRetries = 0;
    nativeMoveTimer = window.setTimeout(() => {
      nativeMoveTimer = undefined;
      captureDragAnchor();
    }, 120);
  };

  const finishPointer = (): void => {
    machine.interactEnd();
    pointerStart = null;
    dragMoved = false;
    nativeDragArmed = false;
    if (nativeDragActive && nativeMoveTimer === undefined) {
      if (nativeDragIdleTimer !== undefined) window.clearTimeout(nativeDragIdleTimer);
      nativeDragIdleTimer = window.setTimeout(() => {
        nativeDragActive = false;
        nativeDragIdleTimer = undefined;
      }, 200);
    }
  };

  orb.addEventListener('mouseenter', () => machine.enter());
  section.addEventListener('mouseenter', () => machine.enter());
  section.addEventListener('mouseleave', () => machine.leave());
  section.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as HTMLElement | null;
      nativeDragArmed = Boolean(target?.closest('[data-tauri-drag-region]'));
      nativeDragActive = false;
      if (nativeDragIdleTimer !== undefined) {
        window.clearTimeout(nativeDragIdleTimer);
        nativeDragIdleTimer = undefined;
      }
      pointerStart = { x: event.clientX, y: event.clientY };
      dragMoved = false;
      machine.interactStart();
    },
    true,
  );
  window.addEventListener('pointermove', (event) => {
    if (!pointerStart || dragMoved) return;
    if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4) {
      dragMoved = true;
      if (nativeDragArmed) nativeDragActive = true;
      cancelBoundsAnimation();
    }
  });
  window.addEventListener('pointerup', finishPointer);
  window.addEventListener('pointercancel', finishPointer);
  void onWindowMoved(() => {
    if (nativeDragArmed) nativeDragActive = true;
    scheduleNativeCapture();
  }).catch((err) => console.error('nova move listener failed', err));
  window.addEventListener('blur', () => machine.interactEnd());
  section.addEventListener('focusin', () => machine.focusStart());
  section.addEventListener('focusout', () => machine.focusEnd());
  orb.addEventListener('pointerup', (event) => {
    if (!pointerStart) return;
    const moved = dragMoved || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5;
    if (!moved) machine.open();
  });
  studioButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void openSettingsWindow().catch((err) => console.error('open Studio failed', err));
  });

  return {
    open: () => machine.open(),
    syncSize,
    applyAnchor,
    targetSize: expandedSize,
    isExpanded: () => machine.state === 'expanded',
  };
}


/** Swap the letter fallbacks for the real shell icons, best effort. */
async function hydrateIcons(slots: IconSlot[]): Promise<void> {
  const targets = [...new Set(slots.filter((slot) => !slot.curated).map((slot) => slot.target))];
  if (targets.length === 0) return;
  try {
    const icons = await resolveIcons(targets);
    for (const slot of slots) {
      if (slot.curated) continue;
      const data = icons.get(slot.target);
      if (!data) continue;
      const img = document.createElement('img');
      img.alt = '';
      img.src = data;
      slot.host.replaceChildren(img);
    }
  } catch (err) {
    console.error('icon extraction failed', err);
  }
}

async function boot(): Promise<void> {
  // Probe first: the log must show whether the page loaded at all, even if
  // the store or the rest of the boot fails.
  try {
    await uiReady();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('ui_ready failed', err);
    showBootMessage(`ui_ready failed: ${msg}`);
    void uiError(`ui_ready failed: ${msg}`).catch(() => undefined);
  }

  try {
    await initStore();
  } catch (err) {
    console.error('store unavailable; using in-memory defaults', err);
  }
  applyGlobalTheme();

  const app = document.getElementById('app');
  if (!app) return;

  let hidden = false;
  const box = pickBox(settings.boxes);
  if (!box) {
    const empty = element('p', 'launcher-empty');
    empty.textContent = 'No launcher box';
    app.replaceChildren(empty);
    return;
  }

  applyNovaVars(document.documentElement, box.style, settings.typography, settings.layout, settings.behavior);
  const view = render(box);
  app.replaceChildren(view.root);
  view.syncSize(true);

  const wallpaperOn = settings.wallpaper.imageEnabled && Boolean(settings.wallpaper.imagePath);
  void syncWallpaperWindow(wallpaperOn, wallpaperOn ? { kind: 'image' } : null).catch((err) =>
    console.error('wallpaper sync failed', err),
  );

  // Commit buffered widget edits and force the debounced store write to disk.
  const persist = (): void => {
    view.flush();
    void flushStore();
  };

  // The settings window writes the shared store; every change arrives here as
  // a store event, so the panel updates live while a slider is dragged.
  const offSettings = onSettingsChange(() => {
    applyGlobalTheme();
    const next = pickBox(settings.boxes);
    if (next) {
      applyNovaVars(document.documentElement, next.style, settings.typography, settings.layout, settings.behavior);
      view.applyAnchor(settings.nova.x, settings.nova.y);
      view.update(next);
    }
  });

  const unlisten = onTrayToggle(() => {
    hidden = !hidden;
    view.root.style.display = hidden ? 'none' : '';
    if (hidden) persist();
    else view.resume();
  });

  const onVisibility = (): void => {
    if (document.hidden) persist();
    else view.resume();
  };
  document.addEventListener('visibilitychange', onVisibility);

  window.addEventListener('beforeunload', () => {
    persist();
    document.removeEventListener('visibilitychange', onVisibility);
    offSettings();
    void unlisten.then((off) => off());
  });
}

void boot().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('box boot failed', err);
  showBootMessage(`boot failed: ${msg}`);
  void uiError(`boot failed: ${msg}`).catch(() => undefined);
});
