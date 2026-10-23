/**
 * Pomodoro timer panel.
 *
 * Loaded on demand from the box window. The authoritative run state is an
 * absolute `endsAt` timestamp persisted in the store, so hiding the window,
 * sleeping the PC or restarting the app cannot drift the countdown. A single
 * 1 s interval only exists while a session is running and is cleared on pause,
 * finish and hide.
 */
import type { Settings } from '../lib/types';

type PomodoroState = Settings['pomodoro'];
type Mode = PomodoroState['session'];

export interface TimerPanel {
  element: HTMLElement;
  resume(): void;
  suspend(): void;
  destroy(): void;
}

interface Options {
  getState: () => PomodoroState;
  onChange: (patch: Partial<PomodoroState>) => void;
}

const MODE_LABEL: Record<Mode, string> = {
  work: 'Work',
  short: 'Short break',
  long: 'Long break',
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function durationMs(mode: Mode, state: PomodoroState): number {
  const minutes =
    mode === 'work' ? state.work : mode === 'short' ? state.shortBreak : state.longBreak;
  return Math.max(1, Math.round(minutes)) * 60_000;
}

function format(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function createTimerPanel(options: Options): TimerPanel {
  const state = (): PomodoroState => options.getState();

  const root = element('div', 'timer-panel');
  const main = element('div', 'timer-main');

  const head = element('div', 'timer-head');
  const modeLabel = element('span', 'timer-mode');
  const meta = element('span', 'timer-meta');
  const editButton = element('button', 'timer-edit');
  editButton.type = 'button';
  editButton.textContent = 'Edit';
  editButton.title = 'Edit durations';
  head.append(modeLabel, meta, editButton);

  const display = element('div', 'timer-display');
  display.setAttribute('role', 'timer');
  display.setAttribute('aria-live', 'off');

  const bar = element('div', 'timer-bar');
  const barFill = element('div', 'timer-bar-fill');
  bar.append(barFill);

  const controls = element('div', 'timer-controls');
  const startButton = element('button', 'timer-btn timer-primary');
  startButton.type = 'button';
  const resetButton = element('button', 'timer-btn');
  resetButton.type = 'button';
  resetButton.textContent = 'Reset';
  const skipButton = element('button', 'timer-btn');
  skipButton.type = 'button';
  skipButton.textContent = 'Skip';
  controls.append(startButton, resetButton, skipButton);

  main.append(head, display, bar, controls);

  const config = element('div', 'timer-config');
  config.hidden = true;
  const grid = element('div', 'timer-config-grid');

  const workInput = numberField(grid, 'Work', 1, 180);
  const shortInput = numberField(grid, 'Short', 1, 60);
  const longInput = numberField(grid, 'Long', 1, 120);
  const cyclesInput = numberField(grid, 'Long every', 1, 12);

  const doneButton = element('button', 'timer-btn timer-done');
  doneButton.type = 'button';
  doneButton.textContent = 'Done';
  config.append(grid, doneButton);

  root.append(main, config);

  let ticker: number | undefined;
  let audioCtx: AudioContext | null = null;

  const stopTicker = (): void => {
    if (ticker !== undefined) {
      window.clearInterval(ticker);
      ticker = undefined;
    }
  };

  // --------------------------------------------------------------- rendering

  const paint = (remaining: number, current: PomodoroState): void => {
    display.textContent = format(remaining);
    const total = durationMs(current.session, current);
    const fraction = Math.min(1, Math.max(0, remaining / total));
    barFill.style.transform = `scaleX(${fraction.toFixed(4)})`;
    startButton.textContent = current.endsAt === null ? 'Start' : 'Pause';
  };

  const render = (): void => {
    const current = state();
    modeLabel.textContent = MODE_LABEL[current.session];
    meta.textContent = `${current.completed} done`;

    if (current.endsAt === null) {
      paint(current.remainingMs ?? durationMs(current.session, current), current);
      return;
    }

    const remaining = current.endsAt - Date.now();
    if (remaining <= 0) {
      finish();
      return;
    }
    paint(remaining, current);
  };

  const renderConfig = (): void => {
    const current = state();
    workInput.value = String(current.work);
    shortInput.value = String(current.shortBreak);
    longInput.value = String(current.longBreak);
    cyclesInput.value = String(current.cycles);
  };

  // ---------------------------------------------------------------- ticking

  const tick = (): void => {
    const current = state();
    if (current.endsAt === null) {
      stopTicker();
      return;
    }
    const remaining = current.endsAt - Date.now();
    if (remaining <= 0) {
      finish();
      return;
    }
    paint(remaining, current);
  };

  const startTicker = (): void => {
    if (ticker !== undefined) return;
    if (state().endsAt === null) return;
    ticker = window.setInterval(tick, 1000);
    tick();
  };

  // ------------------------------------------------------------------ audio

  const audio = (): AudioContext | null => {
    try {
      if (!audioCtx) {
        const Ctor = window.AudioContext;
        if (!Ctor) return null;
        audioCtx = new Ctor();
      }
      if (audioCtx.state === 'suspended') void audioCtx.resume();
      return audioCtx;
    } catch {
      return null;
    }
  };

  const playChime = (): void => {
    if (!state().sound) return;
    const ctx = audio();
    if (!ctx) return;

    const beep = (): void => {
      const now = ctx.currentTime;
      [880, 1174.66].forEach((frequency, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency;
        const at = now + index * 0.18;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + 0.42);
      });
    };

    if (ctx.state === 'suspended') {
      void ctx.resume().then(beep, () => undefined);
    } else {
      beep();
    }
  };

  const notifyDone = async (body: string): Promise<void> => {
    if (!state().notify) return;
    try {
      const { isPermissionGranted, requestPermission, sendNotification } = await import(
        '@tauri-apps/plugin-notification'
      );
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === 'granted';
      if (!granted) return;
      sendNotification({ title: 'DeskAtTop timer', body });
    } catch (err) {
      console.error('timer notification failed', err);
    }
  };

  // ---------------------------------------------------------------- actions

  function finish(): void {
    const current = state();
    if (current.endsAt === null) {
      stopTicker();
      return;
    }

    stopTicker();
    const finishedMode = current.session;
    const completed =
      finishedMode === 'work' ? current.completed + 1 : current.completed;
    const cycles = Math.max(1, Math.round(current.cycles) || 1);
    const next: Mode =
      finishedMode === 'work'
        ? completed % cycles === 0
          ? 'long'
          : 'short'
        : 'work';

    options.onChange({
      session: next,
      endsAt: null,
      remainingMs: null,
      runningSince: null,
      completed,
    });

    playChime();
    void notifyDone(
      finishedMode === 'work'
        ? 'Work session complete — take a break.'
        : 'Break over — back to work.',
    );

    render();
  }

  const start = (): void => {
    const current = state();
    if (current.endsAt !== null) return;
    if (current.sound) audio();
    const remaining = current.remainingMs ?? durationMs(current.session, current);
    options.onChange({
      endsAt: Date.now() + Math.max(1000, remaining),
      remainingMs: null,
      runningSince: Date.now(),
    });
    render();
    startTicker();
  };

  const pause = (): void => {
    const current = state();
    if (current.endsAt === null) return;
    const remaining = Math.max(0, current.endsAt - Date.now());
    stopTicker();
    if (remaining <= 0) {
      finish();
      return;
    }
    options.onChange({ endsAt: null, remainingMs: remaining, runningSince: null });
    render();
  };

  const reset = (): void => {
    stopTicker();
    options.onChange({ endsAt: null, remainingMs: null, runningSince: null });
    render();
  };

  const skip = (): void => {
    stopTicker();
    const current = state();
    const next: Mode = current.session === 'work' ? 'short' : 'work';
    options.onChange({
      session: next,
      endsAt: null,
      remainingMs: null,
      runningSince: null,
    });
    render();
  };

  startButton.addEventListener('click', () => {
    if (state().endsAt === null) start();
    else pause();
  });
  resetButton.addEventListener('click', reset);
  skipButton.addEventListener('click', skip);

  editButton.addEventListener('click', () => {
    main.hidden = true;
    config.hidden = false;
    renderConfig();
    workInput.focus();
  });
  doneButton.addEventListener('click', () => {
    config.hidden = true;
    main.hidden = false;
    render();
  });

  // ----------------------------------------------------------- config inputs

  const applyConfig = (): void => {
    const current = state();
    const work = clampInt(Number(workInput.value), 1, 180, current.work);
    const shortBreak = clampInt(Number(shortInput.value), 1, 60, current.shortBreak);
    const longBreak = clampInt(Number(longInput.value), 1, 120, current.longBreak);
    const cycles = clampInt(Number(cyclesInput.value), 1, 12, current.cycles);
    workInput.value = String(work);
    shortInput.value = String(shortBreak);
    longInput.value = String(longBreak);
    cyclesInput.value = String(cycles);
    options.onChange({ work, shortBreak, longBreak, cycles });
  };

  // Running sessions keep their absolute end time; idle/paused modes pick up
  // the new durations on the next reset or start.
  for (const input of [workInput, shortInput, longInput, cyclesInput]) {
    input.addEventListener('change', applyConfig);
  }

  // ----------------------------------------------------------------- lifecycle

  render();
  startTicker();

  return {
    element: root,
    resume: () => {
      render();
      startTicker();
    },
    suspend: stopTicker,
    destroy: () => {
      stopTicker();
      if (audioCtx) {
        void audioCtx.close().catch(() => undefined);
        audioCtx = null;
      }
      root.remove();
    },
  };
}

/** Compact labelled number input used by the config view. */
function numberField(
  parent: HTMLElement,
  label: string,
  min: number,
  max: number,
): HTMLInputElement {
  const field = element('label', 'timer-field');
  const text = element('span');
  text.textContent = label;
  const input = element('input', 'timer-number');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  input.inputMode = 'numeric';
  field.append(text, input);
  parent.append(field);
  return input;
}
