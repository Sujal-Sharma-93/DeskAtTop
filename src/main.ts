/**
 * Overlay entry point.
 *
 * Step A: paint one empty launcher box on the transparent desktop overlay and
 * keep the native hit-region watcher in sync so clicks only land on the box.
 */
import './styles/tokens.css';
import './styles/overlay.css';
import {
  applyGlobalTheme,
  applyThemeVars,
  onTrayToggle,
  setHitRegions,
  setWidgetsVisible,
  thisWindow,
} from './lib/api';
import { initStore, settings, touch } from './lib/store.svelte';
import { DEFAULT_STYLE, uid, type LauncherBox } from './lib/types';

const STARTER_BOX = { w: 260, h: 180, x: 80, y: 80 };

function starterBox(): LauncherBox {
  const folder = process.env.USERPROFILE || '';
  return {
    id: uid('box'),
    title: 'Quick Launch',
    x: STARTER_BOX.x,
    y: STARTER_BOX.y,
    w: STARTER_BOX.w,
    h: STARTER_BOX.h,
    style: { ...DEFAULT_STYLE },
    items: [
      { id: uid('item'), label: 'Notepad', target: 'notepad.exe', kind: 'exe' },
      { id: uid('item'), label: 'Calculator', target: 'calc.exe', kind: 'exe' },
      { id: uid('item'), label: 'Documents', target: folder ? `${folder}\\Documents` : 'explorer.exe', kind: folder ? 'dir' : 'exe' },
    ],
    pinned: true,
  };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function render(boxes: LauncherBox[]): HTMLElement {
  const root = element('div', 'overlay');

  for (const box of boxes) {
    const section = element('section', 'launcher-box');
    section.dataset.boxId = box.id;
    section.style.left = `${box.x}px`;
    section.style.top = `${box.y}px`;
    section.style.width = `${box.w}px`;
    section.style.height = `${box.h}px`;
    applyThemeVars(section, box.style);

    const bar = element('header', 'launcher-title');
    const title = element('span');
    title.textContent = box.title || 'Launcher';
    bar.append(title);

    const body = element('div', 'launcher-body');
    if (box.items.length === 0) {
      const empty = element('p', 'launcher-empty');
      empty.textContent = 'No shortcuts yet';
      body.append(empty);
    }

    section.append(bar, body);
    root.append(section);
  }

  return root;
}

/** Convert CSS layout rectangles into physical screen pixels for the watcher. */
async function reportHitRegions(root: HTMLElement): Promise<void> {
  const win = thisWindow();
  const [origin, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
  const rects = Array.from(root.querySelectorAll<HTMLElement>('.launcher-box')).map((node) => {
    const r = node.getBoundingClientRect();
    return {
      x: Math.round(origin.x + r.left * scale),
      y: Math.round(origin.y + r.top * scale),
      w: Math.round(r.width * scale),
      h: Math.round(r.height * scale),
    };
  });
  await setHitRegions(win.label, rects);
}

async function boot(): Promise<void> {
  try {
    await initStore();
  } catch (err) {
    console.error('store unavailable; using in-memory defaults', err);
  }
  applyGlobalTheme();

  const app = document.getElementById('app');
  if (!app) return;

  // The settings window normally seeds the store; this keeps a lone overlay
  // usable (and visible) if it ever loads first.
  if (settings.boxes.length === 0) {
    settings.boxes.push(starterBox());
    touch();
  }

  let hidden = false;
  const root = render(settings.boxes);
  app.replaceChildren(root);

  const refresh = () => {
    if (hidden) return;
    void reportHitRegions(root).catch((err) => console.error('hit regions failed', err));
  };

  refresh();
  window.setTimeout(refresh, 400);
  window.addEventListener('resize', refresh);

  const unlisten = onTrayToggle(() => {
    hidden = !hidden;
    root.style.display = hidden ? 'none' : '';
    void setWidgetsVisible(!hidden);
    if (hidden) {
      void setHitRegions(thisWindow().label, []);
    } else {
      refresh();
    }
  });

  window.addEventListener('beforeunload', () => {
    void unlisten.then((off) => off());
  });
}

void boot().catch((err) => console.error('overlay boot failed', err));
