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
  applyThemeVars,
  onTrayToggle,
  openTarget,
  uiError,
  uiReady,
} from './lib/api';
import { showBootMessage } from './boot-guard';
import { initStore, settings } from './lib/store.svelte';
import type { LauncherBox } from './lib/types';

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

function render(box: LauncherBox): HTMLElement {
  const root = element('div', 'box-root');

  const section = element('section', 'launcher-box');
  section.dataset.boxId = box.id;
  applyThemeVars(section, box.style);

  const bar = element('header', 'launcher-title');
  bar.setAttribute('data-tauri-drag-region', '');
  const title = element('span', 'launcher-title-text');
  title.setAttribute('data-tauri-drag-region', '');
  title.textContent = box.title || 'Quick Launch';
  bar.append(title);

  const body = element('div', 'launcher-body');
  if (box.items.length === 0) {
    const empty = element('p', 'launcher-empty');
    empty.textContent = 'No shortcuts yet';
    body.append(empty);
  } else {
    const list = element('ul', 'launcher-items');
    for (const item of box.items) {
      const row = element('li');
      const button = element('button', 'launcher-item');
      button.type = 'button';
      button.textContent = item.label || item.target;
      button.addEventListener('click', () => {
        void openTarget(item.target).catch((err) => console.error('open failed', err));
      });
      row.append(button);
      list.append(row);
    }
    body.append(list);
  }

  section.append(bar, body);
  root.append(section);

  return root;
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

  const root = render(box);
  app.replaceChildren(root);

  const unlisten = onTrayToggle(() => {
    hidden = !hidden;
    root.style.display = hidden ? 'none' : '';
  });

  window.addEventListener('beforeunload', () => {
    void unlisten.then((off) => off());
  });
}

void boot().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('box boot failed', err);
  showBootMessage(`boot failed: ${msg}`);
  void uiError(`boot failed: ${msg}`).catch(() => undefined);
});
