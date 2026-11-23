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
import { boundsFromDrag, collapsedBounds, expandedBounds, lerpBounds, type Bounds } from './lib/nova-layout';
import { novaFallback, novaIcon } from './lib/nova-icons';
import { NovaMachine } from './lib/nova-state';
import { applyNovaVars } from './lib/style';
import type { LaunchItem, LauncherBox, ScheduleEvent, TodoItem } from './lib/types';
import type { SchedEvent } from './lib/api';
import type { NotesPanel, NotesState } from './widgets/notes';
import type { SchedulePanel } from './widgets/schedule';
import type { TimerPanel } from './widgets/timer';
import type { TodoPanel } from './widgets/todo';

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
}

interface BoxView {
  root: HTMLElement;
  update(box: LauncherBox): void;
  syncSize(force?: boolean): void;
  applyAnchor(x: number | null, y: number | null): void;
  flush(): void;
  resume(): void;
}

type BoxTab = 'launcher' | 'todo' | 'notes' | 'timer' | 'schedule';

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
  for (let ring = 1; ring <= 7; ring += 1) {
    const circle = element('span', 'nova-ring');
    circle.dataset.ring = String(ring);
    orb.append(circle);
  }
  const bar = element('header', 'launcher-title');
  const title = element('span', 'launcher-title-text');
  title.setAttribute('data-tauri-drag-region', '');
  const tabs = element('div', 'launcher-tabs');
  const launcherTab = element('button', 'launcher-tab');
  launcherTab.type = 'button';
  launcherTab.textContent = 'Launcher';
  const todoTab = element('button', 'launcher-tab');
  todoTab.type = 'button';
  todoTab.textContent = 'To-do';
  const notesTab = element('button', 'launcher-tab');
  notesTab.type = 'button';
  notesTab.textContent = 'Notes';
  const timerTab = element('button', 'launcher-tab');
  timerTab.type = 'button';
  timerTab.textContent = 'Timer';
  const scheduleTab = element('button', 'launcher-tab');
  scheduleTab.type = 'button';
  scheduleTab.textContent = 'Schedule';
  tabs.append(launcherTab, todoTab, notesTab, timerTab, scheduleTab);
  const studioButton = element('button', 'nova-studio-button');
  studioButton.type = 'button';
  studioButton.title = 'Open DeskAtTop Studio';
  studioButton.setAttribute('aria-label', 'Open DeskAtTop Studio');
  const studioMark = element('span', 'nova-studio-mark');
  studioMark.setAttribute('aria-hidden', 'true');
  studioButton.append(studioMark);
  bar.append(title, tabs, studioButton);

  const panel = element('div', 'launcher-panel');
  panel.setAttribute('inert', '');
  // The launcher body and the lazily loaded todo widget share the same surface
  // (and therefore the same --box-* variables).
  const body = element('div', 'launcher-body');
  const todoHost = element('div', 'todo-host');
  todoHost.hidden = true;
  const notesHost = element('div', 'notes-host');
  notesHost.hidden = true;
  const timerHost = element('div', 'timer-host');
  timerHost.hidden = true;
  const scheduleHost = element('div', 'schedule-host');
  scheduleHost.hidden = true;
  panel.append(body, todoHost, notesHost, timerHost, scheduleHost);

  section.append(orb, bar, panel);
  root.append(section);
  const expand = wireExpand(section, orb, panel, studioButton);

  let itemsKey = '';
  let slots: IconSlot[] = [];
  let activeTab: BoxTab = 'launcher';
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

  const rebuildPanel = (next: LauncherBox): void => {
    slots = [];
    if (next.items.length === 0) {
      const empty = element('p', 'launcher-empty');
      empty.textContent = 'No shortcuts yet';
      body.replaceChildren(empty);
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
    body.replaceChildren(list);
    void hydrateIcons(slots);
  };

  const openPanel = (): void => {
    expand.open();
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
      todoHost.replaceChildren(todoPanel.element);
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
      notesHost.replaceChildren(notesPanel.element);
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
      timerHost.replaceChildren(timerPanel.element);
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
      scheduleHost.replaceChildren(schedulePanel.element);
    } catch (err) {
      console.error('schedule widget failed to load', err);
    } finally {
      scheduleLoading = false;
    }
  }

  const setTab = (next: BoxTab): void => {
    if (next === 'todo' && !settings.widgets.todo.enabled) next = 'launcher';
    if (next === 'notes' && !settings.widgets.notes.enabled) next = 'launcher';
    if (next === 'timer' && !settings.widgets.pomodoro.enabled) next = 'launcher';
    if (next === 'schedule' && !settings.widgets.schedule.enabled) next = 'launcher';
    // Leaving (or disabling) Notes commits the pending 500 ms edit now.
    if (activeTab === 'notes' && next !== 'notes') notesPanel?.flush();
    activeTab = next;
    launcherTab.classList.toggle('is-active', activeTab === 'launcher');
    todoTab.classList.toggle('is-active', activeTab === 'todo');
    notesTab.classList.toggle('is-active', activeTab === 'notes');
    timerTab.classList.toggle('is-active', activeTab === 'timer');
    scheduleTab.classList.toggle('is-active', activeTab === 'schedule');
    launcherTab.setAttribute('aria-selected', String(activeTab === 'launcher'));
    todoTab.setAttribute('aria-selected', String(activeTab === 'todo'));
    notesTab.setAttribute('aria-selected', String(activeTab === 'notes'));
    timerTab.setAttribute('aria-selected', String(activeTab === 'timer'));
    scheduleTab.setAttribute('aria-selected', String(activeTab === 'schedule'));
    body.hidden = activeTab !== 'launcher';
    todoHost.hidden = activeTab !== 'todo';
    notesHost.hidden = activeTab !== 'notes';
    timerHost.hidden = activeTab !== 'timer';
    scheduleHost.hidden = activeTab !== 'schedule';
    if (activeTab === 'todo') void ensureTodo();
    if (activeTab === 'notes') void ensureNotes();
    if (activeTab === 'timer') void ensureTimer();
    if (activeTab === 'schedule') void ensureSchedule();
  };

  const applyWidgets = (): void => {
    const todoEnabled = settings.widgets.todo.enabled;
    const notesEnabled = settings.widgets.notes.enabled;
    const timerEnabled = settings.widgets.pomodoro.enabled;
    const scheduleEnabled = settings.widgets.schedule.enabled;
    todoTab.hidden = !todoEnabled;
    notesTab.hidden = !notesEnabled;
    timerTab.hidden = !timerEnabled;
    scheduleTab.hidden = !scheduleEnabled;

    if (!todoEnabled || !notesEnabled || !timerEnabled || !scheduleEnabled) {
      if (activeTab === 'todo' && !todoEnabled) setTab('launcher');
      if (activeTab === 'notes' && !notesEnabled) setTab('launcher');
      if (activeTab === 'timer' && !timerEnabled) setTab('launcher');
      if (activeTab === 'schedule' && !scheduleEnabled) setTab('launcher');
    }

    if (todoEnabled) {
      void ensureTodo();
      if (todoPanel) {
        const key = todoSignature(settings.todo.items);
        if (key !== todoKey) {
          todoKey = key;
          todoPanel.update(settings.todo.items);
        }
      }
    }

    if (notesEnabled) {
      void ensureNotes();
      if (notesPanel) {
        const key = notesSignature(settings.notes);
        if (key !== notesKey) {
          notesKey = key;
          notesPanel.update(settings.notes);
        }
      }
    }

    if (timerEnabled) {
      void ensureTimer();
      // No-op unless a session is running; keeps exactly one 1 s interval.
      timerPanel?.resume();
    } else {
      timerPanel?.suspend();
    }

    if (scheduleEnabled) {
      void ensureSchedule();
    }
  };

  launcherTab.addEventListener('click', () => {
    setTab('launcher');
    openPanel();
  });
  todoTab.addEventListener('click', () => {
    setTab('todo');
    openPanel();
  });
  notesTab.addEventListener('click', () => {
    setTab('notes');
    openPanel();
  });
  timerTab.addEventListener('click', () => {
    setTab('timer');
    openPanel();
  });
  scheduleTab.addEventListener('click', () => {
    setTab('schedule');
    openPanel();
  });

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
  };

  update(box);
  return {
    root,
    update,
    syncSize: (force = false) => expand.syncSize(force),
    applyAnchor: (x, y) => expand.applyAnchor(x, y),
    flush: () => {
      notesPanel?.flush();
      timerPanel?.suspend();
    },
    resume: () => timerPanel?.resume(),
  };
}

function wireExpand(
  section: HTMLElement,
  orb: HTMLElement,
  panel: HTMLElement,
  studioButton: HTMLButtonElement,
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
  let lastVisual: Visual = 'collapsed';
  let boundsToken = 0;
  let boundsFrame: number | undefined;
  let boundsAnimating = false;
  let anchorTimer: number | undefined;
  let pointerStart: { x: number; y: number } | null = null;
  let dragMoved = false;

  const collapsedSide = (): number => settings.layout.orbSize + ORB_PADDING * 2;

  const keyFor = (state: Visual, bounds: Bounds): string =>
    `${state}:${bounds.x.toFixed(1)},${bounds.y.toFixed(1)},${bounds.width.toFixed(1)}x${bounds.height.toFixed(1)}`;

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

  const animateBounds = (target: Bounds, immediate: boolean): void => {
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
          const t = Math.min(1, (now - start) / OPEN_MS);
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
            ? expandedBounds(anchor, side, settings.layout.panelWidth, settings.layout.panelHeight, screen)
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

  const syncSize = (force = false): void => {
    if (!initialized) {
      initialize();
      return;
    }
    const side = collapsedSide();
    const target =
      machine.state === 'expanded'
        ? expandedBounds(anchor, side, settings.layout.panelWidth, settings.layout.panelHeight, screen)
        : collapsedBounds(anchor, side, screen);
    const key = keyFor(machine.state, target);
    if (!force && key === lastKey) return;
    lastKey = key;
    animateBounds(target, force || !settings.behavior.animations);
  };

  const applyVisual = (state: Visual): void => {
    const previous = lastVisual;
    section.classList.toggle('is-open', state === 'expanded');
    section.classList.toggle('is-closing', state === 'closing');
    if (state === 'expanded') panel.removeAttribute('inert');
    else panel.setAttribute('inert', '');
    if (state !== 'closing') syncSize(state === 'collapsed' && previous === 'closing');
    lastVisual = state;
  };

  machine = new NovaMachine({
    timers: {
      set: (tick, ms) => window.setTimeout(tick, ms),
      clear: (handle) => window.clearTimeout(handle as number),
    },
    collapseDelay: () => settings.behavior.collapseDelayMs,
    closeAnimationMs: () => (settings.behavior.animations ? CLOSE_MS : 10),
    hoverEnabled: () => settings.behavior.hoverExpand,
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
        anchor = clampAnchor(boundsFromDrag(geometry, side), side, screen);
        persistAnchor();
        const target =
          machine.state === 'expanded'
            ? expandedBounds(anchor, side, settings.layout.panelWidth, settings.layout.panelHeight, screen)
            : collapsedBounds(anchor, side, screen);
        lastKey = keyFor(machine.state, target);
      })
      .catch((err) => console.error('nova geometry failed', err));
  };

  const scheduleAnchorCapture = (): void => {
    if (anchorTimer !== undefined) window.clearTimeout(anchorTimer);
    anchorTimer = window.setTimeout(captureDragAnchor, 60);
  };

  const finishPointer = (): void => {
    machine.interactEnd();
    if (dragMoved) scheduleAnchorCapture();
    pointerStart = null;
    dragMoved = false;
  };

  orb.addEventListener('mouseenter', () => machine.enter());
  section.addEventListener('mouseenter', () => machine.enter());
  section.addEventListener('mouseleave', () => machine.leave());
  section.addEventListener(
    'pointerdown',
    (event) => {
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
      cancelBoundsAnimation();
    }
  });
  window.addEventListener('pointerup', finishPointer);
  window.addEventListener('pointercancel', finishPointer);
  window.addEventListener('blur', () => machine.interactEnd());
  section.addEventListener('focusin', () => machine.focusStart());
  section.addEventListener('focusout', () => machine.focusEnd());
  orb.addEventListener('pointerup', (event) => {
    if (!pointerStart) return;
    const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5;
    if (!moved && !settings.behavior.hoverExpand) machine.open();
  });
  studioButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void openSettingsWindow().catch((err) => console.error('open Studio failed', err));
  });

  return { open: () => machine.open(), syncSize, applyAnchor };
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
