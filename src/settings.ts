/**
 * Settings window entry point.
 *
 * Step A: seed a starter launcher box, create the desktop overlays so the
 * overlay shell becomes visible, and render a placeholder settings page.
 */
import './styles/tokens.css';
import './styles/settings.css';
import { applyGlobalTheme, setWidgetsVisible, syncOverlays } from './lib/api';
import { flush, initStore, settings } from './lib/store.svelte';
import { DEFAULT_STYLE, uid, type LauncherBox } from './lib/types';

function starterBox(): LauncherBox {
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
  };
}

function render(): void {
  const app = document.getElementById('app');
  if (!app) return;

  const page = document.createElement('main');
  page.className = 'settings';

  const card = document.createElement('section');
  card.className = 'settings-card';

  const title = document.createElement('h1');
  title.textContent = 'DeskAtTop';

  const blurb = document.createElement('p');
  blurb.textContent =
    'The overlay is running with one empty launcher box. Full settings arrive in the next step.';

  const meta = document.createElement('div');
  meta.className = 'settings-meta';

  const boxes = document.createElement('span');
  boxes.textContent = `${settings.boxes.length} launcher box${settings.boxes.length === 1 ? '' : 'es'}`;

  const layer = document.createElement('span');
  layer.textContent = `layer: ${settings.theme.layer}`;

  meta.append(boxes, layer);
  card.append(title, blurb, meta);
  page.append(card);
  app.replaceChildren(page);
}

async function boot(): Promise<void> {
  try {
    await initStore();
  } catch (err) {
    console.error('store unavailable; using in-memory defaults', err);
  }
  applyGlobalTheme();

  if (settings.boxes.length === 0) {
    settings.boxes.push(starterBox());
    try {
      await flush();
    } catch {
      /* store not writable; the overlay still renders from memory */
    }
  }

  try {
    await syncOverlays(true, settings.theme.layer);
    await setWidgetsVisible(true);
  } catch (err) {
    console.error('overlay sync failed', err);
  }

  render();
}

void boot().catch((err) => console.error('settings boot failed', err));
