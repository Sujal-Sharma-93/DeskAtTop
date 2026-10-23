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
import { initStore, onSettingsChange, settings } from './lib/store.svelte';
import { applyBoxVars } from './lib/style';
import type { LaunchItem, LauncherBox } from './lib/types';

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
}

/** Render the panel and keep a handle to update it when settings change. */
function render(box: LauncherBox): BoxView {
  const root = element('div', 'box-root');

  const section = element('section', 'launcher-box');
  const bar = element('header', 'launcher-title');
  bar.setAttribute('data-tauri-drag-region', '');
  const title = element('span', 'launcher-title-text');
  title.setAttribute('data-tauri-drag-region', '');
  bar.append(title);

  // The panel is always laid out inside the fixed window; only its opacity and
  // transform change, so the window never needs resizing.
  const panel = element('div', 'launcher-panel');
  panel.setAttribute('inert', '');

  let itemsKey = '';
  let slots: IconSlot[] = [];

  const rebuildPanel = (next: LauncherBox): void => {
    slots = [];
    if (next.items.length === 0) {
      const empty = element('p', 'launcher-empty');
      empty.textContent = 'No shortcuts yet';
      panel.replaceChildren(empty);
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
    panel.replaceChildren(list);
    void hydrateIcons(slots);
  };

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
  };

  section.append(bar, panel);
  root.append(section);
  wireExpand(section, bar, panel);
  update(box);

  return { root, update };
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
  });

  window.addEventListener('beforeunload', () => {
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
