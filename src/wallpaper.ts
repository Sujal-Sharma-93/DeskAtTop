import './styles/tokens.css';
import './styles/wallpaper.css';
import { onShellRestart, reassertWallpaper, wallpaperImage } from './lib/api';
import { initStore, onSettingsChange, settings } from './lib/store.svelte';

const app = document.getElementById('app');
if (!app) throw new Error('#app missing');

const image = document.createElement('img');
image.className = 'wallpaper-image';
image.alt = '';
app.replaceChildren(image);

let lastPath: string | null = null;
let generation = 0;

async function apply(): Promise<void> {
  const path = settings.wallpaper.imageEnabled ? settings.wallpaper.imagePath : null;
  if (path === lastPath) return;
  const current = ++generation;
  if (!path) {
    lastPath = null;
    image.removeAttribute('src');
    return;
  }
  try {
    const src = await wallpaperImage(path);
    if (current !== generation) return;
    image.src = src;
    lastPath = path;
  } catch (err) {
    console.error('wallpaper image failed', err);
  }
}

async function boot(): Promise<void> {
  try {
    await initStore();
  } catch (err) {
    console.error('store unavailable; using defaults', err);
  }
  onSettingsChange(() => {
    void apply();
  });
  await onShellRestart(() => {
    void reassertWallpaper().catch((err) => console.error('wallpaper reassert failed', err));
  });
}

void boot().catch((err) => console.error('wallpaper boot failed', err));
