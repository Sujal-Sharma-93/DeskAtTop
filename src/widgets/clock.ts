/**
 * Live local clock.
 *
 * The timer is aligned to the next second boundary and only exists while the
 * expanded workspace is visible. No polling loop runs while NOVA is collapsed.
 */
export interface ClockPanel {
  element: HTMLElement;
  resume(): void;
  suspend(): void;
  destroy(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function createClockPanel(): ClockPanel {
  const root = element('div', 'clock-panel');
  const time = element('div', 'clock-time');
  time.setAttribute('role', 'timer');
  const day = element('div', 'clock-day');
  const date = element('div', 'clock-date');
  root.append(time, day, date);

  let timer: number | undefined;

  const paint = (): void => {
    const now = new Date();
    const nextTime = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(now);
    if (time.textContent !== nextTime) time.textContent = nextTime;

    const nextDay = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(now);
    if (day.textContent !== nextDay) day.textContent = nextDay;

    const nextDate = new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(now);
    if (date.textContent !== nextDate) date.textContent = nextDate;
  };

  const schedule = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    const delay = 1000 - (Date.now() % 1000) + 8;
    timer = window.setTimeout(() => {
      timer = undefined;
      paint();
      schedule();
    }, delay) as unknown as number;
  };

  paint();

  return {
    element: root,
    resume: schedule,
    suspend: () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    },
    destroy: () => {
      if (timer !== undefined) window.clearTimeout(timer);
      root.remove();
    },
  };
}
