/**
 * Settings window.
 *
 * Three sections in a sidebar. The Appearance controls write straight into the
 * shared store; `touch()` publishes the change to the box window immediately
 * (the box listens to the store change event) and debounces the disk write.
 */
import './styles/tokens.css';
import './styles/settings.css';
import { open } from '@tauri-apps/plugin-dialog';
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart';
import {
  applyGlobalTheme,
  setWidgetsVisible,
  syncBoxWindow,
  syncWallpaperWindow,
} from './lib/api';
import { initStore, settings, touch } from './lib/store.svelte';
import {
  DEFAULT_STYLE,
  uid,
  type LaunchKind,
  type LauncherBox,
  type WidgetStyle,
} from './lib/types';
import { clampNumber, isColor, toHexColor } from './lib/style';

type SectionId = 'boxes' | 'widgets' | 'appearance' | 'wallpaper' | 'startup' | 'about';

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'boxes', label: 'Boxes' },
  { id: 'widgets', label: 'Widgets' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'wallpaper', label: 'Wallpaper' },
  { id: 'startup', label: 'Startup' },
  { id: 'about', label: 'About' },
];

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** The box this window edits: Quick Launch, else the first one. */
function currentBox(): LauncherBox | undefined {
  return settings.boxes.find((box) => box.title === 'Quick Launch') ?? settings.boxes[0];
}

interface StyleBinding {
  getStyle: () => WidgetStyle;
  onChange: () => void;
}

function boxStyleBinding(): StyleBinding {
  return {
    // A clone when there is no box keeps mutation harmless; touch() then saves
    // the unchanged settings.
    getStyle: () => currentBox()?.style ?? { ...DEFAULT_STYLE },
    onChange: () => touch(),
  };
}

function panel(title: string, subtitle: string): HTMLElement {
  const section = element('section', 'settings-panel');
  const heading = element('h2', 'panel-title');
  heading.textContent = title;
  const blurb = element('p', 'panel-subtitle');
  blurb.textContent = subtitle;
  section.append(heading, blurb);
  return section;
}

function field(labelText: string, control: HTMLElement): HTMLElement {
  const row = element('div', 'field');
  const label = element('span', 'field-label');
  label.textContent = labelText;
  const host = element('div', 'field-control');
  host.append(control);
  row.append(label, host);
  return row;
}

/**
 * Generic widget-style editor: background, text, accent, opacity, radius and a
 * reset. Pass any widget's `style` so the same controls can be reused for the
 * other widgets later.
 */
function buildStyleControls(binding: StyleBinding): { element: HTMLElement; refresh: () => void } {
  const wrap = element('div', 'style-controls');
  const refreshers: Array<() => void> = [];

  const addColor = (labelText: string, key: 'bg' | 'fg' | 'accent'): void => {
    const input = element('input', 'color-input');
    input.type = 'color';
    input.setAttribute('aria-label', labelText);
    const code = element('span', 'color-code');

    const control = element('div', 'color-control');
    control.append(input, code);

    input.addEventListener('input', () => {
      if (!isColor(input.value)) return;
      const style = binding.getStyle();
      style[key] = input.value;
      code.textContent = input.value.toUpperCase();
      binding.onChange();
    });

    refreshers.push(() => {
      const value = toHexColor(binding.getStyle()[key]);
      input.value = value;
      code.textContent = value.toUpperCase();
    });

    wrap.append(field(labelText, control));
  };

  const addSlider = (
    labelText: string,
    key: 'opacity' | 'radius',
    min: number,
    max: number,
    unit: string,
  ): void => {
    const input = element('input', 'slider-input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.setAttribute('aria-label', labelText);
    const out = element('output', 'slider-value');

    const control = element('div', 'slider-control');
    control.append(input, out);

    input.addEventListener('input', () => {
      const style = binding.getStyle();
      const next = clampNumber(Number(input.value), min, max);
      style[key] = next;
      out.textContent = `${next}${unit}`;
      binding.onChange();
    });

    refreshers.push(() => {
      const value = clampNumber(Number(binding.getStyle()[key]), min, max);
      input.value = String(value);
      out.textContent = `${value}${unit}`;
    });

    wrap.append(field(labelText, control));
  };

  addColor('Background colour', 'bg');
  addColor('Text colour', 'fg');
  addColor('Accent colour', 'accent');
  addSlider('Opacity', 'opacity', 0, 100, '%');
  addSlider('Corner radius', 'radius', 0, 32, 'px');

  const refresh = (): void => {
    for (const update of refreshers) update();
  };

  const reset = element('button', 'btn btn-reset');
  reset.type = 'button';
  reset.textContent = 'Reset to defaults';
  reset.addEventListener('click', () => {
    Object.assign(binding.getStyle(), structuredClone(DEFAULT_STYLE));
    binding.onChange();
    refresh();
  });

  const actions = element('div', 'style-actions');
  actions.append(reset);
  wrap.append(actions);
  refresh();

  return { element: wrap, refresh };
}

/** Automatic name: file/folder basename, or a URL's host. */
function defaultLabel(kind: LaunchKind, target: string): string {
  if (kind === 'url') {
    try {
      return new URL(target).hostname.replace(/^www\./, '') || target;
    } catch {
      return target;
    }
  }
  const parts = target.split(/[\\/]/).filter(Boolean);
  const base = parts[parts.length - 1] || target;
  return kind === 'app' ? base.replace(/\.exe$/i, '') : base;
}

/** File kind for a picked path: executables behave like apps. */
function kindForPath(path: string): LaunchKind {
  return /\.exe$/i.test(path) ? 'app' : 'file';
}

function buildBoxesPanel(): HTMLElement {
  const section = panel(
    'Boxes',
    'Boxes pinned to the desktop. Rename, add, reorder or remove shortcuts here.',
  );

  const box = currentBox();
  if (!box) {
    const empty = element('p', 'empty-note');
    empty.textContent = 'No launcher boxes yet.';
    section.append(empty);
    return section;
  }

  const card = element('div', 'card');
  const heading = element('h3', 'card-title');
  heading.textContent = box.title || 'Quick Launch';

  const titleInput = element('input', 'text-input');
  titleInput.type = 'text';
  titleInput.maxLength = 60;
  titleInput.value = box.title;
  titleInput.setAttribute('aria-label', 'Box title');
  titleInput.placeholder = 'Quick Launch';
  titleInput.addEventListener('input', () => {
    const target = currentBox();
    if (!target) return;
    target.title = titleInput.value;
    touch();
  });

  const itemsHeader = element('div', 'items-header');
  const itemsTitle = element('h4', 'items-title');
  itemsTitle.textContent = 'Items';
  const addButton = element('button', 'btn btn-add');
  addButton.type = 'button';
  addButton.textContent = '+ Add item';
  itemsHeader.append(itemsTitle, addButton);

  /* ------------------------------------------------------------ add form */

  type AddKind = 'file' | 'folder' | 'url';
  let addKind: AddKind = 'file';

  const form = element('div', 'add-form');
  form.hidden = true;

  const kindRow = element('div', 'kind-row');
  const kindButtons = new Map<AddKind, HTMLButtonElement>();
  const kinds: Array<{ id: AddKind; label: string }> = [
    { id: 'file', label: 'App / File' },
    { id: 'folder', label: 'Folder' },
    { id: 'url', label: 'URL' },
  ];

  const targetInput = element('input', 'text-input');
  targetInput.type = 'text';
  targetInput.spellcheck = false;

  const browse = element('button', 'btn btn-browse');
  browse.type = 'button';
  browse.textContent = 'Browse…';

  const targetControl = element('div', 'add-target-control');
  targetControl.append(targetInput, browse);

  const targetRow = field('Path', targetControl);
  // `field()` puts the label first; keep it so the URL mode can retitle it.
  const targetFieldLabel = targetRow.firstElementChild as HTMLElement | null;

  const nameInput = element('input', 'text-input');
  nameInput.type = 'text';
  nameInput.maxLength = 80;
  nameInput.placeholder = 'Defaults to the file or folder name';
  nameInput.setAttribute('aria-label', 'Item name');

  const error = element('p', 'add-error');
  error.hidden = true;

  const showError = (message: string): void => {
    error.textContent = message;
    error.hidden = false;
  };

  const resetForm = (): void => {
    targetInput.value = '';
    nameInput.value = '';
    error.hidden = true;
  };

  const setKind = (kind: AddKind): void => {
    addKind = kind;
    for (const [id, button] of kindButtons) button.classList.toggle('is-active', id === kind);
    if (targetFieldLabel) targetFieldLabel.textContent = kind === 'url' ? 'URL' : 'Path';
    targetInput.placeholder =
      kind === 'url' ? 'https://example.com' : 'C:\\path\\to\\file-or-folder';
    browse.hidden = kind === 'url';
    nameInput.placeholder =
      kind === 'url' ? 'Defaults to the site name' : 'Defaults to the file or folder name';
    error.hidden = true;
  };

  for (const entry of kinds) {
    const button = element('button', 'kind-btn');
    button.type = 'button';
    button.textContent = entry.label;
    button.addEventListener('click', () => setKind(entry.id));
    kindButtons.set(entry.id, button);
    kindRow.append(button);
  }

  browse.addEventListener('click', async () => {
    try {
      const picked = await open({
        multiple: false,
        directory: addKind === 'folder',
        title: addKind === 'folder' ? 'Choose a folder' : 'Choose a file',
      });
      if (typeof picked === 'string') {
        targetInput.value = picked;
        error.hidden = true;
      }
    } catch (err) {
      console.error('file picker failed', err);
      showError('The file picker is unavailable. Type the path manually.');
    }
  });

  const addActions = element('div', 'add-actions');
  const confirm = element('button', 'btn btn-primary');
  confirm.type = 'button';
  confirm.textContent = 'Add';
  const cancel = element('button', 'btn');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  addActions.append(confirm, cancel);

  confirm.addEventListener('click', () => {
    const raw = targetInput.value.trim();
    if (!raw) {
      showError(addKind === 'url' ? 'Enter a URL.' : 'Choose a file or enter a path.');
      return;
    }

    let kind: LaunchKind;
    let target = raw;
    if (addKind === 'url') {
      try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
        target = url.toString();
      } catch {
        showError('Enter a valid http:// or https:// URL.');
        return;
      }
      kind = 'url';
    } else if (addKind === 'folder') {
      kind = 'folder';
    } else {
      kind = kindForPath(raw);
    }

    const latest = currentBox();
    if (!latest) return;
    const label = nameInput.value.trim() || defaultLabel(kind, target);
    latest.items = [
      ...latest.items,
      { id: uid('item'), kind, target, label, icon: null },
    ];
    touch();
    resetForm();
    form.hidden = true;
    refreshItems();
  });

  cancel.addEventListener('click', () => {
    resetForm();
    form.hidden = true;
  });

  addButton.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) {
      setKind(addKind);
      targetInput.focus();
    }
  });

  form.append(field('Type', kindRow), targetRow, field('Name', nameInput), error, addActions);
  setKind('file');

  /* ----------------------------------------------------------- item list */

  const listHost = element('div', 'item-list');

  const moveItem = (id: string, delta: number): void => {
    const latest = currentBox();
    if (!latest) return;
    const index = latest.items.findIndex((entry) => entry.id === id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= latest.items.length) return;
    const items = [...latest.items];
    [items[index], items[next]] = [items[next], items[index]];
    latest.items = items;
    touch();
    refreshItems();
  };

  const refreshItems = (): void => {
    listHost.replaceChildren();
    const target = currentBox();
    if (!target || target.items.length === 0) {
      const empty = element('p', 'empty-note');
      empty.textContent = 'No shortcuts in this box yet. Add one above.';
      listHost.append(empty);
      return;
    }

    target.items.forEach((item, index) => {
      const row = element('div', 'item-row');
      const text = element('div', 'item-text');

      const name = element('input', 'item-name-input');
      name.type = 'text';
      name.maxLength = 80;
      name.value = item.label;
      name.placeholder = defaultLabel(item.kind, item.target);
      name.setAttribute('aria-label', 'Item name');
      name.addEventListener('input', () => {
        const latest = currentBox();
        const entry = latest?.items.find((candidate) => candidate.id === item.id);
        if (!entry) return;
        entry.label = name.value;
        touch();
      });

      const targetText = element('span', 'item-target');
      targetText.textContent = `${item.kind} · ${item.target}`;
      text.append(name, targetText);

      const actions = element('div', 'item-actions');

      const up = element('button', 'btn-icon');
      up.type = 'button';
      up.textContent = '↑';
      up.setAttribute('aria-label', 'Move up');
      up.title = 'Move up';
      up.disabled = index === 0;
      up.addEventListener('click', () => moveItem(item.id, -1));

      const down = element('button', 'btn-icon');
      down.type = 'button';
      down.textContent = '↓';
      down.setAttribute('aria-label', 'Move down');
      down.title = 'Move down';
      down.disabled = index === target.items.length - 1;
      down.addEventListener('click', () => moveItem(item.id, 1));

      const remove = element('button', 'btn btn-remove');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        const latest = currentBox();
        if (!latest) return;
        latest.items = latest.items.filter((entry) => entry.id !== item.id);
        touch();
        refreshItems();
      });

      actions.append(up, down, remove);
      row.append(text, actions);
      listHost.append(row);
    });
  };

  refreshItems();
  card.append(field('Title', titleInput), itemsHeader, form, listHost);
  section.append(card);
  return section;
}

function widgetRow(
  id: 'todo' | 'notes' | 'pomodoro' | 'schedule',
  name: string,
  description: string,
): HTMLElement {
  const row = element('div', 'widget-row');
  const copy = element('div', 'widget-copy');
  const title = element('span', 'widget-name');
  title.textContent = name;
  const desc = element('span', 'widget-desc');
  desc.textContent = description;
  copy.append(title, desc);

  const toggle = element('label', 'toggle');
  const input = element('input', 'toggle-input');
  input.type = 'checkbox';
  input.checked = settings.widgets[id].enabled;
  input.setAttribute('aria-label', `Show the ${name} panel`);
  const track = element('span', 'toggle-track');
  track.setAttribute('aria-hidden', 'true');
  toggle.append(input, track);

  input.addEventListener('change', () => {
    // Store + publish: the box window adds/removes the tab live.
    settings.widgets[id].enabled = input.checked;
    touch();
  });

  row.append(copy, toggle);
  return row;
}

function buildWidgetsPanel(): HTMLElement {
  const section = panel(
    'Widgets',
    'Pick which panels are available in the launcher box title bar.',
  );

  const card = element('div', 'card');
  card.append(
    widgetRow(
      'todo',
      'To-do list',
      'Add, check off and edit tasks inside the box. Uses the same appearance as the launcher.',
    ),
    widgetRow(
      'notes',
      'Notes',
      'Keep multiple plain-text notes with autosave. Uses the same appearance as the launcher.',
    ),
    widgetRow(
      'pomodoro',
      'Timer',
      'Pomodoro timer with work and break sessions. Keeps running while hidden.',
    ),
    widgetRow(
      'schedule',
      'Schedule',
      'Create reminders that trigger popups with Snooze and Dismiss. Runs in Rust.',
    ),
  );
  section.append(card);
  return section;
}

function buildAppearancePanel(): HTMLElement {
  const section = panel(
    'Appearance',
    'Applied to the launcher box as you drag. Changes are saved a moment later.',
  );

  const card = element('div', 'card');
  const heading = element('h3', 'card-title');
  heading.textContent = 'Quick Launch box';
  const controls = buildStyleControls(boxStyleBinding());
  card.append(heading, controls.element);
  section.append(card);
  return section;
}

function wallpaperActive(): boolean {
  return settings.wallpaper.imageEnabled && Boolean(settings.wallpaper.imagePath);
}

async function applyWallpaper(): Promise<void> {
  touch();
  await syncWallpaperWindow(wallpaperActive(), wallpaperActive() ? { kind: 'image' } : null);
}

function buildWallpaperPanel(): HTMLElement {
  const section = panel('Wallpaper', 'Pin a still image behind your desktop icons.');
  const card = element('div', 'card');
  const heading = element('h3', 'card-title');
  heading.textContent = 'Static image';

  const toggleRow = element('div', 'widget-row');
  const toggleCopy = element('div', 'widget-copy');
  const toggleName = element('span', 'widget-name');
  toggleName.textContent = 'Show image wallpaper';
  const toggleDesc = element('span', 'widget-desc');
  toggleDesc.textContent = 'Draws the selected image on the desktop, behind the icons.';
  toggleCopy.append(toggleName, toggleDesc);
  const toggle = element('label', 'toggle');
  const input = element('input', 'toggle-input');
  input.type = 'checkbox';
  input.checked = wallpaperActive();
  input.setAttribute('aria-label', 'Show the static image wallpaper');
  const track = element('span', 'toggle-track');
  track.setAttribute('aria-hidden', 'true');
  toggle.append(input, track);
  toggleRow.append(toggleCopy, toggle);

  const pathText = element('span', 'item-target');
  const choose = element('button', 'btn btn-browse');
  choose.type = 'button';
  choose.textContent = 'Choose…';
  const clear = element('button', 'btn btn-remove');
  clear.type = 'button';
  clear.textContent = 'Clear';
  clear.disabled = !settings.wallpaper.imagePath;
  const pathActions = element('div', 'add-actions');
  pathActions.append(choose, clear);
  const pathControl = element('div', 'add-target-control');
  pathControl.append(pathText, pathActions);

  const refresh = (): void => {
    input.checked = wallpaperActive();
    pathText.textContent = settings.wallpaper.imagePath ?? 'No image selected';
    clear.disabled = !settings.wallpaper.imagePath;
  };
  refresh();

  choose.addEventListener('click', async () => {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        title: 'Choose a wallpaper image',
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }],
      });
      if (typeof picked !== 'string') return;
      settings.wallpaper.imagePath = picked;
      settings.wallpaper.imageEnabled = true;
      refresh();
      await applyWallpaper();
    } catch (err) {
      console.error('wallpaper picker failed', err);
    }
  });

  clear.addEventListener('click', async () => {
    settings.wallpaper.imagePath = null;
    settings.wallpaper.imageEnabled = false;
    refresh();
    await applyWallpaper();
  });

  input.addEventListener('change', async () => {
    if (input.checked && !settings.wallpaper.imagePath) {
      input.checked = false;
      choose.click();
      return;
    }
    settings.wallpaper.imageEnabled = input.checked && Boolean(settings.wallpaper.imagePath);
    refresh();
    await applyWallpaper();
  });

  card.append(heading, toggleRow, field('Image', pathControl));
  section.append(card);
  return section;
}

function buildStartupPanel(): HTMLElement {
  const section = panel('Startup', 'Choose whether DeskAtTop launches with Windows.');
  const card = element('div', 'card');

  const row = element('div', 'widget-row');
  const copy = element('div', 'widget-copy');
  const name = element('span', 'widget-name');
  name.textContent = 'Launch at sign-in';
  const desc = element('span', 'widget-desc');
  desc.textContent = 'Registers DeskAtTop with Windows autostart.';
  copy.append(name, desc);

  const toggle = element('label', 'toggle');
  const input = element('input', 'toggle-input');
  input.type = 'checkbox';
  input.checked = settings.startup.autoStart;
  input.setAttribute('aria-label', 'Launch DeskAtTop at sign-in');
  const track = element('span', 'toggle-track');
  track.setAttribute('aria-hidden', 'true');
  toggle.append(input, track);
  row.append(copy, toggle);

  void isAutostartEnabled()
    .then((enabled) => {
      input.checked = enabled;
      settings.startup.autoStart = enabled;
    })
    .catch((err) => console.error('autostart query failed', err));

  input.addEventListener('change', async () => {
    const wanted = input.checked;
    try {
      if (wanted) await enableAutostart();
      else await disableAutostart();
      settings.startup.autoStart = wanted;
      touch();
    } catch (err) {
      input.checked = !wanted;
      console.error('autostart toggle failed', err);
    }
  });

  card.append(row);
  section.append(card);
  return section;
}

function buildAboutPanel(): HTMLElement {
  const section = panel('About', 'A lightweight desktop customization layer for Windows.');

  const card = element('div', 'card about-card');
  const name = element('p', 'about-name');
  name.textContent = 'DeskAtTop';
  const blurb = element('p', 'about-text');
  blurb.textContent =
    'Quick Launch boxes sit on your desktop. Hover a box title to open its shortcuts. ' +
    'Use the Appearance section to recolour the box; changes are written to settings.json.';
  const meta = element('p', 'about-meta');
  meta.textContent = `Schema v${settings.version}`;
  card.append(name, blurb, meta);
  section.append(card);
  return section;
}

function render(): void {
  const app = document.getElementById('app');
  if (!app) return;

  const shell = element('div', 'settings-shell');

  const sidebar = element('aside', 'settings-sidebar');
  const brand = element('div', 'settings-brand');
  const brandName = element('span', 'brand-name');
  brandName.textContent = 'DeskAtTop';
  const brandTag = element('span', 'brand-tag');
  brandTag.textContent = 'Settings';
  brand.append(brandName, brandTag);

  const nav = element('nav', 'settings-nav');
  const main = element('main', 'settings-main scroll');

  const panels: Record<SectionId, HTMLElement> = {
    boxes: buildBoxesPanel(),
    widgets: buildWidgetsPanel(),
    appearance: buildAppearancePanel(),
    wallpaper: buildWallpaperPanel(),
    startup: buildStartupPanel(),
    about: buildAboutPanel(),
  };

  const buttons = new Map<SectionId, HTMLButtonElement>();

  const select = (id: SectionId): void => {
    for (const [key, button] of buttons) button.classList.toggle('is-active', key === id);
    for (const key of SECTIONS) panels[key.id].hidden = key.id !== id;
    main.scrollTop = 0;
  };

  for (const item of SECTIONS) {
    const button = element('button', 'nav-item');
    button.type = 'button';
    button.textContent = item.label;
    button.addEventListener('click', () => select(item.id));
    buttons.set(item.id, button);
    nav.append(button);
  }

  const footer = element('div', 'settings-footer');
  footer.textContent = 'v0.1.0';

  sidebar.append(brand, nav, footer);
  for (const item of SECTIONS) main.append(panels[item.id]);
  shell.append(sidebar, main);
  app.replaceChildren(shell);

  select('appearance');
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
