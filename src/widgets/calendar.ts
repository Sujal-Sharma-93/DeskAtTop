/**
 * Compact monthly calendar.
 *
 * Read-only by design: the full reminder editor stays in the existing Schedule
 * widget. This panel only reflects `settings.schedule.events` so notification,
 * snooze and dismiss behaviour remain owned by the Rust scheduler.
 */
import type { ScheduleEvent } from '../lib/types';

export interface CalendarPanel {
  element: HTMLElement;
  update(events: ScheduleEvent[]): void;
  destroy(): void;
}

interface Options {
  getEvents: () => ScheduleEvent[];
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function matches(event: ScheduleEvent, date: Date): boolean {
  if (!event.enabled) return false;
  const at = new Date(event.at);
  const begins = startOfDay(at);
  const day = startOfDay(date);
  if (day < begins) return false;
  if (event.repeat === 'none') return day === begins;
  if (event.repeat === 'daily') return true;
  if (event.repeat === 'weekly') return at.getDay() === date.getDay();
  return at.getDate() === date.getDate();
}

export function createCalendarPanel(options: Options): CalendarPanel {
  const root = element('div', 'calendar-panel');

  const head = element('div', 'calendar-head');
  const prev = element('button', 'calendar-nav');
  prev.type = 'button';
  prev.textContent = '‹';
  prev.title = 'Previous month';
  prev.setAttribute('aria-label', 'Previous month');
  const month = element('span', 'calendar-month');
  const next = element('button', 'calendar-nav');
  next.type = 'button';
  next.textContent = '›';
  next.title = 'Next month';
  next.setAttribute('aria-label', 'Next month');
  head.append(prev, month, next);

  const weekdays = element('div', 'calendar-weekdays');
  for (const label of WEEKDAYS) {
    const cell = element('span', 'calendar-weekday');
    cell.textContent = label;
    weekdays.append(cell);
  }

  const grid = element('div', 'calendar-grid');
  const summary = element('div', 'calendar-summary');
  root.append(head, weekdays, grid, summary);

  const now = new Date();
  let view = new Date(now.getFullYear(), now.getMonth(), 1);
  let selected = dayKey(now);
  let events: ScheduleEvent[] = options.getEvents();
  const today = dayKey(now);

  const eventsOn = (date: Date): ScheduleEvent[] =>
    events.filter((event) => matches(event, date));

  const render = (): void => {
    month.textContent = new Intl.DateTimeFormat(undefined, {
      month: 'long',
      year: 'numeric',
    }).format(view);

    grid.replaceChildren();
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(view.getFullYear(), view.getMonth(), 1 - offset);

    let selectedEvents: ScheduleEvent[] = [];
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
      const key = dayKey(date);
      const cell = element('button', 'calendar-day');
      cell.type = 'button';
      cell.textContent = String(date.getDate());
      cell.title = new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(date);
      if (date.getMonth() !== view.getMonth()) cell.classList.add('is-other');
      if (key === today) cell.classList.add('is-today');
      if (key === selected) {
        cell.classList.add('is-selected');
        selectedEvents = eventsOn(date);
      }
      if (eventsOn(date).length > 0) {
        const dot = element('span', 'calendar-dot');
        dot.setAttribute('aria-hidden', 'true');
        cell.append(dot);
      }
      cell.addEventListener('click', () => {
        selected = key;
        render();
      });
      grid.append(cell);
    }

    if (selectedEvents.length === 0) {
      summary.textContent = 'No reminders on this day';
    } else {
      summary.textContent = selectedEvents.map((event) => event.title).join(' · ');
    }
  };

  prev.addEventListener('click', () => {
    view = new Date(view.getFullYear(), view.getMonth() - 1, 1);
    render();
  });
  next.addEventListener('click', () => {
    view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
    render();
  });

  render();

  return {
    element: root,
    update(nextEvents) {
      events = nextEvents;
      render();
    },
    destroy: () => root.remove(),
  };
}
