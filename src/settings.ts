/**
 * Settings window entry point.
 *
 * The starter Quick Launch box lives in the default settings; this window only
 * syncs the launcher box window and renders a placeholder settings page.
 */
import './styles/tokens.css';
import './styles/settings.css';
import { applyGlobalTheme, setWidgetsVisible, syncBoxWindow } from './lib/api';
import { initStore, settings } from './lib/store.svelte';

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
    'The launcher box is running with a Quick Launch box. Full settings arrive in the next step.';

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

  try {
    await syncBoxWindow(true);
    await setWidgetsVisible(true);
  } catch (err) {
    console.error('box sync failed', err);
  }

  render();
}

void boot().catch((err) => console.error('settings boot failed', err));
