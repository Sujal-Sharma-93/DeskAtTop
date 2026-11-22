import './styles/tokens.css';
import './styles/popup.css';
import {
  applyGlobalTheme,
  onPopupShow,
  schedDismiss,
  schedSnooze,
  uiError,
  type SchedEvent,
} from './lib/api';
import { initStore, onSettingsChange } from './lib/store.svelte';

const SNOOZE_MINUTES = 5;
const AUTO_DISMISS_MS = 30_000;

const app = document.getElementById('app');
if (!app) throw new Error('#app missing');

const card = document.createElement('section');
card.className = 'popup-card';

const head = document.createElement('header');
head.className = 'popup-head';
const badge = document.createElement('span');
badge.className = 'popup-badge';
badge.textContent = 'Reminder';
const title = document.createElement('h1');
title.className = 'popup-title';
title.textContent = 'Waiting for reminder…';
head.append(badge, title);

const body = document.createElement('p');
body.className = 'popup-body';
const meta = document.createElement('p');
meta.className = 'popup-meta';
meta.textContent = 'Waiting for a scheduled event';

const actions = document.createElement('div');
actions.className = 'popup-actions';
const snooze = document.createElement('button');
snooze.type = 'button';
snooze.className = 'popup-btn popup-snooze';
snooze.textContent = `Snooze ${SNOOZE_MINUTES} min`;
snooze.disabled = true;
const dismiss = document.createElement('button');
dismiss.type = 'button';
dismiss.className = 'popup-btn popup-dismiss';
dismiss.textContent = 'Dismiss';
dismiss.disabled = true;
actions.append(snooze, dismiss);

card.append(head, body, meta, actions);

let current: SchedEvent | null = null;
let autoTimer: number | undefined;

function report(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error('popup action failed', err);
  void uiError(`popup action failed: ${message}`).catch(() => undefined);
}

function clearAuto(): void {
  if (autoTimer !== undefined) {
    window.clearTimeout(autoTimer);
    autoTimer = undefined;
  }
}

function dismissNow(): void {
  clearAuto();
  void schedDismiss().catch(report);
}

function armAuto(): void {
  clearAuto();
  meta.textContent = 'Auto-dismiss in 30s';
  autoTimer = window.setTimeout(() => {
    autoTimer = undefined;
    dismissNow();
  }, AUTO_DISMISS_MS) as unknown as number;
}

snooze.addEventListener('click', () => {
  if (!current) return;
  clearAuto();
  const event = current;
  void schedSnooze(event, SNOOZE_MINUTES)
    .then(() => {
      meta.textContent = `Snoozed ${SNOOZE_MINUTES} min`;
      snooze.disabled = true;
      dismiss.disabled = true;
    })
    .catch(report);
});

dismiss.addEventListener('click', dismissNow);

window.addEventListener('beforeunload', () => {
  clearAuto();
});

async function boot(): Promise<void> {
  try {
    await initStore();
  } catch (err) {
    console.error('store unavailable; using defaults', err);
  }
  applyGlobalTheme();
  onSettingsChange(() => applyGlobalTheme());
  app?.replaceChildren(card);

  try {
    await onPopupShow((event) => {
      current = event;
      document.title = event.title || 'DeskAtTop Reminder';
      title.textContent = event.title || 'Reminder';
      body.textContent = event.body || 'No details';
      snooze.disabled = false;
      dismiss.disabled = false;
      armAuto();
    });
  } catch (err) {
    report(err);
  }
}

void boot().catch(report);
