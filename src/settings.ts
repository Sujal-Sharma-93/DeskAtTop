/**
 * DeskAtTop Studio.
 *
 * The Studio controls write straight into the shared store; `touch()` publishes
 * changes to NOVA immediately and debounces the disk write.
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
  schedReplace,
  setDesktopWallpaper,
  setWidgetsVisible,
  syncBoxWindow,
  syncWallpaperWindow,
  toSchedEvent,
  wallpaperImage,
} from './lib/api';
import {
  exportJson,
  flush,
  initStore,
  onSettingsChange,
  parseImportedSettings,
  replaceAll,
  settings,
  touch,
} from './lib/store.svelte';
import {
  DEFAULT_STYLE,
  FONT_OPTIONS,
  PRESETS,
  uid,
  type LaunchKind,
  type LauncherBox,
  type Settings,
  type ThemePreset,
  type WidgetStyle,
} from './lib/types';
import { applyNovaVars, clampNumber, isColor, toHexColor } from './lib/style';

type SectionId = 'appearance' | 'typography' | 'layout' | 'wallpaper' | 'behavior' | 'general';

const refreshers: Array<() => void> = [];

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'typography', label: 'Typography' },
  { id: 'layout', label: 'Layout & Dimensions' },
  { id: 'wallpaper', label: 'Wallpaper' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'general', label: 'General' },
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

function applyPreset(preset: ThemePreset): void {
  settings.theme.preset = preset.id;
  settings.theme.mode = preset.mode;
  settings.theme.accent = preset.accent;
  const style = boxStyleBinding().getStyle();
  style.bg = preset.surface;
  style.fg = preset.text;
  style.accent = preset.accent;
  style.opacity = preset.opacity;
  style.radius = preset.radius;
  touch();
  applyGlobalTheme();
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
    key: 'opacity' | 'radius' | 'blur',
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
  addSlider('Glass blur', 'blur', 0, 40, 'px');

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
    'Main colours, glass and theme presets for NOVA. Changes apply live.',
  );

  const controls = buildStyleControls(boxStyleBinding());

  const presetCard = element('div', 'card');
  const presetHeading = element('h3', 'card-title');
  presetHeading.textContent = 'Theme presets';
  const presetRow = element('div', 'preset-row');
  const presetButtons = new Map<string, HTMLButtonElement>();
  for (const preset of PRESETS) {
    const button = element('button', 'btn preset-btn');
    button.type = 'button';
    button.textContent = preset.name;
    button.addEventListener('click', () => {
      applyPreset(preset);
      refreshPresets();
      controls.refresh();
    });
    presetButtons.set(preset.id, button);
    presetRow.append(button);
  }
  const refreshPresets = (): void => {
    for (const [id, button] of presetButtons) {
      button.classList.toggle('is-active', id === settings.theme.preset);
    }
  };
  refreshPresets();
  refreshers.push(refreshPresets, () => controls.refresh());
  presetCard.append(presetHeading, presetRow);

  const card = element('div', 'card');
  const heading = element('h3', 'card-title');
  heading.textContent = 'Quick Launch box';
  card.append(heading, controls.element);
  section.append(presetCard, card);
  return section;
}

interface Control<T> {
  element: HTMLElement;
  refresh: (value: T) => void;
}

function sliderControl(
  labelText: string,
  value: number,
  min: number,
  max: number,
  step: number,
  format: (value: number) => string,
  onChange: (value: number) => void,
): Control<number> {
  const input = element('input', 'slider-input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.setAttribute('aria-label', labelText);
  const out = element('output', 'slider-value');
  const control = element('div', 'slider-control');
  control.append(input, out);
  input.addEventListener('input', () => {
    const next = clampNumber(Number(input.value), min, max);
    out.textContent = format(next);
    onChange(next);
  });
  const refresh = (next: number): void => {
    const value = clampNumber(next, min, max);
    input.value = String(value);
    out.textContent = format(value);
  };
  refresh(value);
  return { element: field(labelText, control), refresh };
}

function selectControl(
  labelText: string,
  options: Array<{ id: string; label: string }>,
  value: string,
  onChange: (value: string) => void,
): Control<string> {
  const select = element('select', 'select-input');
  for (const option of options) {
    const node = element('option');
    node.value = option.id;
    node.textContent = option.label;
    select.append(node);
  }
  select.setAttribute('aria-label', labelText);
  select.addEventListener('change', () => onChange(select.value));
  const refresh = (next: string): void => {
    select.value = options.some((option) => option.id === next) ? next : options[0].id;
  };
  refresh(value);
  return { element: field(labelText, select), refresh };
}

function toggleControl(
  name: string,
  description: string,
  value: boolean,
  onChange: (value: boolean) => void,
): Control<boolean> {
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
  input.checked = value;
  input.setAttribute('aria-label', name);
  const track = element('span', 'toggle-track');
  track.setAttribute('aria-hidden', 'true');
  toggle.append(input, track);
  input.addEventListener('change', () => onChange(input.checked));
  row.append(copy, toggle);
  return {
    element: row,
    refresh: (next: boolean) => {
      input.checked = next;
    },
  };
}

function buildTypographyPanel(): HTMLElement {
  const section = panel('Typography', 'Type scale and font choices used throughout NOVA.');
  const card = element('div', 'card');
  const family = selectControl('Font family', FONT_OPTIONS, settings.typography.family, (value) => {
    settings.typography.family = value;
    touch();
  });
  const size = sliderControl(
    'Text size',
    settings.typography.size,
    10,
    20,
    1,
    (value) => `${value}px`,
    (value) => {
      settings.typography.size = value;
      touch();
    },
  );
  const weight = selectControl(
    'Font weight',
    [
      { id: '400', label: 'Regular' },
      { id: '500', label: 'Medium' },
      { id: '600', label: 'Semibold' },
      { id: '700', label: 'Bold' },
    ],
    String(settings.typography.weight),
    (value) => {
      settings.typography.weight = Number(value);
      touch();
    },
  );
  const spacing = sliderControl(
    'Letter spacing',
    settings.typography.letterSpacing,
    -1,
    3,
    0.1,
    (value) => `${value.toFixed(1)}px`,
    (value) => {
      settings.typography.letterSpacing = value;
      touch();
    },
  );
  const line = sliderControl(
    'Line height',
    settings.typography.lineHeight,
    1,
    1.8,
    0.05,
    (value) => value.toFixed(2),
    (value) => {
      settings.typography.lineHeight = value;
      touch();
    },
  );
  const preview = element('p', 'type-preview');
  preview.textContent = 'NOVA — Quick Launch 0123456789';
  card.append(family.element, size.element, weight.element, spacing.element, line.element, preview);
  section.append(card);
  refreshers.push(() => {
    family.refresh(settings.typography.family);
    size.refresh(settings.typography.size);
    weight.refresh(String(settings.typography.weight));
    spacing.refresh(settings.typography.letterSpacing);
    line.refresh(settings.typography.lineHeight);
  });
  return section;
}

function buildLayoutPanel(): HTMLElement {
  const section = panel(
    'Layout & Dimensions',
    'Sizing for the collapsed circle and the expanded launcher panel.',
  );
  const card = element('div', 'card');
  const orbSize = sliderControl(
    'NOVA circle size',
    settings.layout.orbSize,
    32,
    88,
    1,
    (value) => `${value}px`,
    (value) => {
      settings.layout.orbSize = value;
      touch();
    },
  );
  const panelWidth = sliderControl(
    'Panel width',
    settings.layout.panelWidth,
    240,
    560,
    4,
    (value) => `${value}px`,
    (value) => {
      settings.layout.panelWidth = value;
      touch();
    },
  );
  const panelHeight = sliderControl(
    'Panel height',
    settings.layout.panelHeight,
    160,
    480,
    4,
    (value) => `${value}px`,
    (value) => {
      settings.layout.panelHeight = value;
      touch();
    },
  );
  const padding = sliderControl(
    'Internal padding',
    settings.layout.padding,
    4,
    18,
    1,
    (value) => `${value}px`,
    (value) => {
      settings.layout.padding = value;
      touch();
    },
  );
  const gap = sliderControl(
    'Internal gap',
    settings.layout.gap,
    2,
    16,
    1,
    (value) => `${value}px`,
    (value) => {
      settings.layout.gap = value;
      touch();
    },
  );
  const radius = sliderControl(
    'Corner radius',
    currentBox()?.style.radius ?? DEFAULT_STYLE.radius,
    0,
    32,
    1,
    (value) => `${value}px`,
    (value) => {
      const box = currentBox();
      if (!box) return;
      box.style.radius = value;
      touch();
    },
  );
  card.append(
    orbSize.element,
    panelWidth.element,
    panelHeight.element,
    padding.element,
    gap.element,
    radius.element,
  );
  section.append(card);
  refreshers.push(() => {
    orbSize.refresh(settings.layout.orbSize);
    panelWidth.refresh(settings.layout.panelWidth);
    panelHeight.refresh(settings.layout.panelHeight);
    padding.refresh(settings.layout.padding);
    gap.refresh(settings.layout.gap);
    radius.refresh(currentBox()?.style.radius ?? DEFAULT_STYLE.radius);
  });
  return section;
}

function buildBehaviorPanel(): HTMLElement {
  const section = panel('Behavior', 'How NOVA responds to the pointer.');
  const card = element('div', 'card');
  const hover = toggleControl(
    'Hover to expand',
    'Open the panel when the pointer enters NOVA. When off, click the circle to open it.',
    settings.behavior.hoverExpand,
    (value) => {
      settings.behavior.hoverExpand = value;
      touch();
    },
  );
  const delay = sliderControl(
    'Collapse delay',
    settings.behavior.collapseDelayMs,
    1000,
    15000,
    500,
    (value) => `${(value / 1000).toFixed(1)}s`,
    (value) => {
      settings.behavior.collapseDelayMs = value;
      touch();
    },
  );
  const animations = toggleControl(
    'Animations',
    'Use the smooth expand and collapse transition.',
    settings.behavior.animations,
    (value) => {
      settings.behavior.animations = value;
      touch();
    },
  );
  card.append(hover.element, delay.element, animations.element);
  section.append(card);
  refreshers.push(() => {
    hover.refresh(settings.behavior.hoverExpand);
    delay.refresh(settings.behavior.collapseDelayMs);
    animations.refresh(settings.behavior.animations);
  });
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
  const section = panel(
    'Wallpaper',
    'Choose a still image, preview it, and apply it to the Windows desktop.',
  );
  const card = element('div', 'card');
  const heading = element('h3', 'card-title');
  heading.textContent = 'Static image';

  const layer = toggleControl(
    'Desktop image layer',
    'Draws the selected image behind desktop icons. This is separate from the Windows wallpaper.',
    wallpaperActive(),
    (value) => {
      if (value && !settings.wallpaper.imagePath) {
        choose.click();
        return;
      }
      settings.wallpaper.imageEnabled = value && Boolean(settings.wallpaper.imagePath);
      void applyWallpaper();
    },
  );

  const pathText = element('span', 'item-target');
  const choose = element('button', 'btn btn-browse');
  choose.type = 'button';
  choose.textContent = 'Choose…';
  const clear = element('button', 'btn btn-remove');
  clear.type = 'button';
  clear.textContent = 'Clear';
  const pathActions = element('div', 'add-actions');
  pathActions.append(choose, clear);
  const pathControl = element('div', 'add-target-control');
  pathControl.append(pathText, pathActions);

  const previewFrame = element('div', 'wallpaper-preview-frame');
  const preview = element('img', 'wallpaper-preview');
  preview.alt = 'Selected wallpaper preview';
  preview.hidden = true;
  const previewEmpty = element('p', 'wallpaper-preview-empty');
  previewEmpty.textContent = 'Choose an image to see a preview.';
  previewFrame.append(preview, previewEmpty);

  const apply = element('button', 'btn btn-primary');
  apply.type = 'button';
  apply.textContent = 'Set as Windows wallpaper';
  const restore = element('button', 'btn');
  restore.type = 'button';
  restore.textContent = 'Restore previous';
  const wallpaperActions = element('div', 'add-actions');
  wallpaperActions.append(restore, apply);

  const status = element('p', 'backup-status');
  status.setAttribute('role', 'status');
  const setStatus = (message: string, error = false): void => {
    status.textContent = message;
    status.classList.toggle('is-error', error);
  };

  let previewPath: string | null = null;
  let generation = 0;
  const loadPreview = async (): Promise<void> => {
    const path = settings.wallpaper.imagePath;
    if (path === previewPath) return;
    const current = ++generation;
    if (!path) {
      previewPath = null;
      preview.removeAttribute('src');
      preview.hidden = true;
      previewEmpty.hidden = false;
      return;
    }
    try {
      const src = await wallpaperImage(path);
      if (current !== generation) return;
      preview.src = src;
      preview.hidden = false;
      previewEmpty.hidden = true;
      previewPath = path;
    } catch (err) {
      console.error('wallpaper preview failed', err);
      if (current !== generation) return;
      preview.removeAttribute('src');
      preview.hidden = true;
      previewEmpty.hidden = false;
      previewPath = null;
      setStatus('The selected image could not be previewed.', true);
    }
  };

  const refresh = (): void => {
    layer.refresh(wallpaperActive());
    pathText.textContent = settings.wallpaper.imagePath ?? 'No image selected';
    clear.disabled = !settings.wallpaper.imagePath;
    apply.disabled = !settings.wallpaper.imagePath;
    restore.disabled = settings.wallpaper.systemPreviousPath === null;
    void loadPreview();
  };

  choose.addEventListener('click', async () => {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        title: 'Choose a wallpaper image',
        filters: [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'] },
        ],
      });
      if (typeof picked !== 'string') return;
      settings.wallpaper.imagePath = picked;
      settings.wallpaper.imageEnabled = true;
      setStatus('Image selected. Apply it to the Windows desktop when you are ready.');
      refresh();
      await applyWallpaper();
    } catch (err) {
      console.error('wallpaper picker failed', err);
      setStatus('The image picker is unavailable.', true);
    }
  });

  clear.addEventListener('click', async () => {
    settings.wallpaper.imagePath = null;
    settings.wallpaper.imageEnabled = false;
    setStatus('Image selection cleared. The Windows wallpaper was not changed.');
    refresh();
    await applyWallpaper();
  });

  apply.addEventListener('click', async () => {
    const path = settings.wallpaper.imagePath;
    if (!path) return;
    apply.disabled = true;
    try {
      const previous = await setDesktopWallpaper(path);
      if (settings.wallpaper.systemPreviousPath === null && previous !== null && previous !== path) {
        settings.wallpaper.systemPreviousPath = previous;
      }
      settings.wallpaper.systemAppliedPath = path;
      touch();
      await flush();
      setStatus('Windows wallpaper applied. The previous image is saved for restore.');
    } catch (err) {
      console.error('wallpaper apply failed', err);
      setStatus(err instanceof Error ? err.message : 'Could not apply the wallpaper.', true);
    } finally {
      refresh();
    }
  });

  restore.addEventListener('click', async () => {
    const previous = settings.wallpaper.systemPreviousPath;
    if (previous === null) return;
    restore.disabled = true;
    try {
      await setDesktopWallpaper(previous);
      settings.wallpaper.systemAppliedPath = null;
      settings.wallpaper.systemPreviousPath = null;
      touch();
      await flush();
      setStatus('Previous Windows wallpaper restored.');
    } catch (err) {
      console.error('wallpaper restore failed', err);
      setStatus(err instanceof Error ? err.message : 'Could not restore the wallpaper.', true);
    } finally {
      refresh();
    }
  });

  card.append(heading, layer.element, field('Image', pathControl), previewFrame, wallpaperActions, status);
  section.append(card);
  refresh();
  refreshers.push(refresh);
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

async function applyImported(next: Settings): Promise<string[]> {
  await replaceAll(next);
  const failures: string[] = [];
  const attempt = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      console.error(`${label} failed`, err);
      failures.push(label);
    }
  };
  applyGlobalTheme();
  await attempt('box sync', () => syncBoxWindow(true));
  await attempt('widget sync', () => setWidgetsVisible(true));
  await attempt('schedule sync', () => schedReplace(settings.schedule.events.map(toSchedEvent)));
  const active = settings.wallpaper.imageEnabled && Boolean(settings.wallpaper.imagePath);
  await attempt('wallpaper sync', () => syncWallpaperWindow(active, active ? { kind: 'image' } : null));
  await attempt('autostart sync', () =>
    settings.startup.autoStart ? enableAutostart() : disableAutostart(),
  );
  return failures;
}

function buildBackupCard(): HTMLElement {
  const card = element('div', 'card about-card');
  const heading = element('h3', 'card-title');
  heading.textContent = 'Backup';
  const note = element('p', 'about-text');
  note.textContent =
    'No filesystem plugin is installed, so export copies JSON to the clipboard and import reads it from the box below.';
  const json = element('textarea', 'json-input');
  json.rows = 8;
  json.spellcheck = false;
  json.setAttribute('aria-label', 'Settings JSON');
  json.placeholder = 'Paste exported settings JSON here';

  const actions = element('div', 'add-actions');
  const copy = element('button', 'btn');
  copy.type = 'button';
  copy.textContent = 'Copy JSON';
  const paste = element('button', 'btn');
  paste.type = 'button';
  paste.textContent = 'Paste JSON';
  const importButton = element('button', 'btn btn-primary');
  importButton.type = 'button';
  importButton.textContent = 'Import JSON';
  actions.append(copy, paste, importButton);

  const status = element('p', 'backup-status');
  status.setAttribute('role', 'status');
  const setStatus = (message: string, error = false): void => {
    status.textContent = message;
    status.classList.toggle('is-error', error);
  };

  copy.addEventListener('click', async () => {
    const data = exportJson();
    json.value = data;
    try {
      await navigator.clipboard.writeText(data);
      setStatus('Settings JSON copied to clipboard.');
    } catch {
      setStatus('Clipboard unavailable; the JSON is selected below so you can copy it manually.');
      json.focus();
      json.select();
    }
  });

  paste.addEventListener('click', async () => {
    try {
      const data = await navigator.clipboard.readText();
      if (!data.trim()) {
        setStatus('The clipboard is empty.', true);
        return;
      }
      json.value = data.trim();
      setStatus('JSON pasted. Review it, then choose Import JSON.');
    } catch {
      setStatus('Clipboard read failed. Paste the JSON into the box below.', true);
      json.focus();
    }
  });

  importButton.addEventListener('click', async () => {
    const raw = json.value.trim();
    if (!raw) {
      setStatus('Paste settings JSON first.', true);
      return;
    }
    let next: Settings;
    try {
      next = await parseImportedSettings(raw);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Invalid settings JSON.', true);
      return;
    }
    try {
      const failures = await applyImported(next);
      setStatus(
        failures.length === 0
          ? 'Settings imported and applied.'
          : `Settings imported; live refresh failed for: ${failures.join(', ')}.`,
        failures.length > 0,
      );
    } catch (err) {
      console.error('settings import failed', err);
      setStatus('Import failed; the current settings were left unchanged.', true);
    }
  });

  card.append(heading, note, json, actions, status);
  return card;
}

function buildAboutPanel(): HTMLElement {
  const section = panel('About', 'A lightweight desktop customization layer for Windows.');

  const card = element('div', 'card about-card');
  const name = element('p', 'about-name');
  name.textContent = 'DeskAtTop';
  const blurb = element('p', 'about-text');
  blurb.textContent =
    'NOVA floats on your desktop and expands into the launcher. This Studio is the home for ' +
    'customisation; changes are written to settings.json.';
  const meta = element('p', 'about-meta');
  meta.textContent = `Schema v${settings.version}`;
  card.append(name, blurb, meta);
  section.append(card, buildBackupCard());
  return section;
}

function buildGeneralPanel(): HTMLElement {
  const section = panel(
    'General',
    'Launcher contents, widgets, Windows startup and settings backup.',
  );
  const stack = element('div', 'general-stack');
  stack.append(buildBoxesPanel(), buildWidgetsPanel(), buildStartupPanel(), buildAboutPanel());
  section.append(stack);
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
  brandTag.textContent = 'Studio';
  brand.append(brandName, brandTag);

  const nav = element('nav', 'settings-nav');
  const main = element('main', 'settings-main scroll');

  const panels: Record<SectionId, HTMLElement> = {
    appearance: buildAppearancePanel(),
    typography: buildTypographyPanel(),
    layout: buildLayoutPanel(),
    wallpaper: buildWallpaperPanel(),
    behavior: buildBehaviorPanel(),
    general: buildGeneralPanel(),
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
  footer.textContent = `Studio · schema v${settings.version}`;

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
  const applyVars = (): void => {
    applyGlobalTheme();
    const box = currentBox();
    if (box) {
      applyNovaVars(
        document.documentElement,
        box.style,
        settings.typography,
        settings.layout,
        settings.behavior,
      );
    }
  };
  applyVars();

  try {
    await syncBoxWindow(true);
    await setWidgetsVisible(true);
  } catch (err) {
    console.error('box sync failed', err);
  }

  render();
  onSettingsChange(() => {
    applyVars();
    for (const refresh of refreshers) refresh();
  });
}

void boot().catch((err) => console.error('settings boot failed', err));
