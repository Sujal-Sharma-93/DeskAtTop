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
  openTarget,
  resolveIcons,
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
import { applyBoxVars } from './lib/style';
import type { LaunchItem, LauncherBox, TodoItem } from './lib/types';
import type { NotesPanel, NotesState } from './widgets/notes';
import type { TimerPanel } from './widgets/timer';
import type { TodoPanel } from './widgets/todo';

/** How long the panel stays open after the cursor leaves the box. */
const CLOSE_DELAY_MS = 300;

interface IconSlot {
  target: string;
  host: HTMLElement;
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
  const label = itemLabel(item).trim();
  host.textContent = label.charAt(0).toUpperCase() || '?';
  return { target: item.target, host };
}

interface BoxView {
  root: HTMLElement;
  update(box: LauncherBox): void;
  /** Commit buffered writes and stop widget timers (window hidden/closing). */
  flush(): void;
  resume(): void;
}

type BoxTab = 'launcher' | 'todo' | 'notes' | 'timer';

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

/** Render the panel and keep a handle to update it when settings change. */
function render(box: LauncherBox): BoxView {
  const root = element('div', 'box-root');

  const section = element('section', 'launcher-box');
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
  tabs.append(launcherTab, todoTab, notesTab, timerTab);
  bar.append(title, tabs);

  // The panel is always laid out inside the fixed window; only its opacity and
  // transform change, so the window never needs resizing.
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
  panel.append(body, todoHost, notesHost, timerHost);

  section.append(bar, panel);
  root.append(section);
  wireExpand(section, bar, panel);

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
    panel.removeAttribute('inert');
    section.classList.add('is-open');
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

  const setTab = (next: BoxTab): void => {
    if (next === 'todo' && !settings.widgets.todo.enabled) next = 'launcher';
    if (next === 'notes' && !settings.widgets.notes.enabled) next = 'launcher';
    if (next === 'timer' && !settings.widgets.pomodoro.enabled) next = 'launcher';
    // Leaving (or disabling) Notes commits the pending 500 ms edit now.
    if (activeTab === 'notes' && next !== 'notes') notesPanel?.flush();
    activeTab = next;
    launcherTab.classList.toggle('is-active', activeTab === 'launcher');
    todoTab.classList.toggle('is-active', activeTab === 'todo');
    notesTab.classList.toggle('is-active', activeTab === 'notes');
    timerTab.classList.toggle('is-active', activeTab === 'timer');
    launcherTab.setAttribute('aria-selected', String(activeTab === 'launcher'));
    todoTab.setAttribute('aria-selected', String(activeTab === 'todo'));
    notesTab.setAttribute('aria-selected', String(activeTab === 'notes'));
    timerTab.setAttribute('aria-selected', String(activeTab === 'timer'));
    body.hidden = activeTab !== 'launcher';
    todoHost.hidden = activeTab !== 'todo';
    notesHost.hidden = activeTab !== 'notes';
    timerHost.hidden = activeTab !== 'timer';
    if (activeTab === 'todo') void ensureTodo();
    if (activeTab === 'notes') void ensureNotes();
    if (activeTab === 'timer') void ensureTimer();
  };

  const applyWidgets = (): void => {
    const todoEnabled = settings.widgets.todo.enabled;
    const notesEnabled = settings.widgets.notes.enabled;
    const timerEnabled = settings.widgets.pomodoro.enabled;
    todoTab.hidden = !todoEnabled;
    notesTab.hidden = !notesEnabled;
    timerTab.hidden = !timerEnabled;

    if (!todoEnabled || !notesEnabled || !timerEnabled) {
      if (activeTab === 'todo' && !todoEnabled) setTab('launcher');
      if (activeTab === 'notes' && !notesEnabled) setTab('launcher');
      if (activeTab === 'timer' && !timerEnabled) setTab('launcher');
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

  const update = (next: LauncherBox): void => {
    section.dataset.boxId = next.id;
    applyBoxVars(section, next.style);
    title.textContent = next.title || 'Quick Launch';

    const key = next.items
      .map((item) => `${item.id}\u0001${item.kind}\u0001${item.target}\u0001${item.label}`)
      .join('\u0002');
    if (key !== itemsKey) {
      itemsKey = key;
      rebuildPanel(next);
    }
    applyWidgets();
  };

  update(box);
  return {
    root,
    update,
    flush: () => {
      notesPanel?.flush();
      timerPanel?.suspend();
    },
    resume: () => timerPanel?.resume(),
  };
}

/** Hover-expand: the pill opens the panel, leaving the box closes it once. */
function wireExpand(section: HTMLElement, bar: HTMLElement, panel: HTMLElement): void {
  let closeTimer: number | undefined;

  const cancelClose = (): void => {
    if (closeTimer !== undefined) {
      window.clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  };

  const open = (): void => {
    cancelClose();
    if (section.classList.contains('is-open')) return;
    panel.removeAttribute('inert');
    section.classList.add('is-open');
  };

  const closeLater = (): void => {
    cancelClose();
    if (!section.classList.contains('is-open')) return;
    closeTimer = window.setTimeout(() => {
      closeTimer = undefined;
      section.classList.remove('is-open');
      panel.setAttribute('inert', '');
    }, CLOSE_DELAY_MS);
  };

  // Entering the pill opens; anything re-entering the box cancels a pending
  // close; leaving the box arms a single timer that is cancelled on re-enter.
  bar.addEventListener('mouseenter', open);
  section.addEventListener('mouseenter', cancelClose);
  section.addEventListener('mouseleave', closeLater);
}

/** Swap the letter fallbacks for the real shell icons, best effort. */
async function hydrateIcons(slots: IconSlot[]): Promise<void> {
  const targets = [...new Set(slots.map((slot) => slot.target))];
  if (targets.length === 0) return;
  try {
    const icons = await resolveIcons(targets);
    for (const slot of slots) {
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

  const view = render(box);
  app.replaceChildren(view.root);

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
    if (next) view.update(next);
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
