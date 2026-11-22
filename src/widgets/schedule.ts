/**
 * Schedule reminders panel.
 *
 * Loaded on demand from the box window. Events are stored in the shared
 * settings store; the Rust scheduler owns the timing and fires popups via
 * the existing `schedule://fire` event. The frontend only manages the list
 * and delegates to the existing `sched_replace`, `sched_snooze`, `sched_dismiss`
 * commands.
 */
import { uid } from '../lib/types';
import {
  schedReplace,
  type SchedEvent,
} from '../lib/api';

export interface SchedulePanel {
  element: HTMLElement;
  destroy(): void;
}

interface Options {
  getEvents: () => SchedEvent[];
  onChange: (events: SchedEvent[]) => void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function formatDateTime(at: number): string {
  const d = new Date(at);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hour}:${minute}`;
}

function repeatLabel(repeat: SchedEvent['repeat']): string {
  switch (repeat) {
    case 'daily':
      return 'Daily';
    case 'weekly':
      return 'Weekly';
    case 'monthly':
      return 'Monthly';
    default:
      return 'Once';
  }
}

export function createSchedulePanel(options: Options): SchedulePanel {
  let events: SchedEvent[] = options.getEvents();

  const root = element('div', 'schedule-panel');

  // Add event form
  const form = element('form', 'schedule-form');
  const titleInput = element('input', 'schedule-title');
  titleInput.type = 'text';
  titleInput.placeholder = 'Event title';
  titleInput.required = true;

  const datetimeInput = element('input', 'schedule-datetime');
  datetimeInput.type = 'datetime-local';
  datetimeInput.required = true;

  const repeatSelect = element('select', 'schedule-repeat');
  repeatSelect.innerHTML = `
    <option value="none">Once</option>
    <option value="daily">Daily</option>
    <option value="weekly">Weekly</option>
    <option value="monthly">Monthly</option>
  `;
  repeatSelect.value = 'none';

  const addButton = element('button', 'schedule-add');
  addButton.type = 'submit';
  addButton.textContent = 'Add';

  form.append(titleInput, datetimeInput, repeatSelect, addButton);

  // Event list
  const list = element('ul', 'schedule-list');

  root.append(form, list);

  const render = (): void => {
    list.replaceChildren();

    if (events.length === 0) {
      const empty = element('li', 'schedule-empty');
      empty.textContent = 'No reminders yet';
      list.append(empty);
      return;
    }

    // Sort by upcoming time
    const sorted = [...events].sort((a, b) => {
      const aTime = a.snoozed_until ?? a.at;
      const bTime = b.snoozed_until ?? b.at;
      return aTime - bTime;
    });

    for (const ev of sorted) {
      const li = element('li', 'schedule-item');
      li.dataset.id = ev.id;

      const info = element('div', 'schedule-info');
      const title = element('span', 'schedule-event-title');
      title.textContent = ev.title;
      const meta = element('span', 'schedule-event-meta');
      const when = ev.snoozed_until ?? ev.at;
      meta.textContent = `${formatDateTime(when)} · ${repeatLabel(ev.repeat)}`;
      if (ev.snoozed_until) meta.textContent += ' (snoozed)';
      info.append(title, meta);

      const actions = element('div', 'schedule-actions');
      const editBtn = element('button', 'schedule-edit');
      editBtn.type = 'button';
      editBtn.textContent = 'Edit';
      const deleteBtn = element('button', 'schedule-delete');
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Delete';
      actions.append(editBtn, deleteBtn);

      li.append(info, actions);
      list.append(li);

      // Edit handler
      editBtn.addEventListener('click', () => startEdit(ev, li));

      // Delete handler
      deleteBtn.addEventListener('click', () => {
        if (!window.confirm(`Delete "${ev.title}"?`)) return;
        events = events.filter((e) => e.id !== ev.id);
        save();
      });
    }
  };

  // Inline edit
  let editingId: string | null = null;

  const startEdit = (ev: SchedEvent, li: HTMLLIElement): void => {
    if (editingId) return;

    editingId = ev.id;
    const formEl = element('form', 'schedule-edit-form');
    const titleEdit = element('input', 'schedule-title');
    titleEdit.type = 'text';
    titleEdit.value = ev.title;
    titleEdit.required = true;

    const datetimeEdit = element('input', 'schedule-datetime');
    datetimeEdit.type = 'datetime-local';
    datetimeEdit.value = new Date(ev.at).toISOString().slice(0, 16);
    datetimeEdit.required = true;

    const repeatEdit = element('select', 'schedule-repeat');
    repeatEdit.innerHTML = `
      <option value="none">Once</option>
      <option value="daily">Daily</option>
      <option value="weekly">Weekly</option>
      <option value="monthly">Monthly</option>
    `;
    repeatEdit.value = ev.repeat;

    const saveBtn = element('button', 'schedule-save');
    saveBtn.type = 'submit';
    saveBtn.textContent = 'Save';
    const cancelBtn = element('button', 'schedule-cancel');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';

    formEl.append(titleEdit, datetimeEdit, repeatEdit, saveBtn, cancelBtn);
    li.replaceChildren(formEl);

    const finish = () => {
      editingId = null;
      render();
    };

    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const newTitle = titleEdit.value.trim();
      const newAt = new Date(datetimeEdit.value).getTime();
      const newRepeat = datetimeEdit.value ? (repeatEdit.value as SchedEvent['repeat']) : 'none';
      if (!newTitle || !datetimeEdit.value) return;
      events = events.map((e) =>
        e.id === ev.id
          ? { ...e, title: newTitle, at: newAt, repeat: newRepeat }
          : e
      );
      save();
      finish();
    });

    cancelBtn.addEventListener('click', finish);
    titleEdit.focus();
  };

  // Add new event
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    const at = new Date(datetimeInput.value).getTime();
    const repeat = repeatSelect.value as SchedEvent['repeat'];
    if (!title || !datetimeInput.value) return;

    const newEvent: SchedEvent = {
      id: uid('sched'),
      title,
      body: '',
      at,
      repeat,
      snoozed_until: null,
      enabled: true,
    };
    events = [...events, newEvent];
    save();
    form.reset();
  });

  const save = async (): Promise<void> => {
    options.onChange(events);
    await schedReplace(events);
  };

  // Listen for Rust scheduler dismiss/snooze events to refresh the list?
  // The scheduler fires events on the Rust side; the frontend list is only
  // updated when the user adds/edits/deletes. The popup handles snooze/dismiss.
  // No need to listen for schedule://fire here.

  render();

  return {
    element: root,
    destroy: () => root.remove(),
  };
}