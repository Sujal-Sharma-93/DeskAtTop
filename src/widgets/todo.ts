/**
 * To-do panel.
 *
 * Loaded on demand from the box window (dynamic `import`) so its code only
 * ships when the widget is enabled. It never touches the store directly; the
 * host passes `getItems` / `onChange` so there stays exactly one store writer.
 */
import { uid, type TodoItem } from '../lib/types';

export interface TodoPanel {
  element: HTMLElement;
  update(items: TodoItem[]): void;
  destroy(): void;
}

interface Options {
  getItems: () => TodoItem[];
  onChange: (items: TodoItem[]) => void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function createTodoPanel(options: Options): TodoPanel {
  const root = element('div', 'todo-panel');

  const form = element('form', 'todo-add');
  const input = element('input', 'todo-input');
  input.type = 'text';
  input.placeholder = 'Add a task and press Enter';
  input.maxLength = 200;
  input.setAttribute('aria-label', 'New task');
  const add = element('button', 'todo-add-btn');
  add.type = 'submit';
  add.textContent = 'Add';
  add.setAttribute('aria-label', 'Add task');
  form.append(input, add);

  const list = element('ul', 'todo-list');
  const footer = element('div', 'todo-footer');
  const count = element('span', 'todo-count');
  const clearDone = element('button', 'todo-clear');
  clearDone.type = 'button';
  clearDone.textContent = 'Clear done';
  footer.append(count, clearDone);

  const commit = (items: TodoItem[]): void => {
    options.onChange(items);
  };

  const addItem = (): void => {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    const items = options.getItems();
    items.push({ id: uid('todo'), text, done: false, createdAt: Date.now() });
    input.value = '';
    commit(items);
    render(items);
    input.focus();
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    addItem();
  });

  let editingId: string | null = null;

  const startEdit = (item: TodoItem, text: HTMLElement): void => {
    if (editingId) return;
    editingId = item.id;
    const editor = element('input', 'todo-edit');
    editor.type = 'text';
    editor.value = item.text;
    editor.maxLength = 200;
    editor.setAttribute('aria-label', 'Edit task');

    let finished = false;
    const finish = (save: boolean): void => {
      if (finished) return;
      finished = true;
      editingId = null;
      if (save) {
        const value = editor.value.trim();
        const items = options.getItems();
        const target = items.find((entry) => entry.id === item.id);
        if (target) {
          if (value) {
            target.text = value;
            commit(items);
          } else {
            // An emptied task is treated as a delete.
            options.onChange(items.filter((entry) => entry.id !== item.id));
          }
        }
      }
      render(options.getItems());
    };

    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    editor.addEventListener('blur', () => finish(true));

    text.replaceWith(editor);
    editor.focus();
    editor.select();
  };

  const render = (items: TodoItem[]): void => {
    list.replaceChildren();

    for (const item of items) {
      const row = element('li', 'todo-item');
      if (item.done) row.classList.add('is-done');

      const check = element('input', 'todo-check');
      check.type = 'checkbox';
      check.checked = item.done;
      check.setAttribute('aria-label', item.done ? 'Mark as not done' : 'Mark as done');
      check.addEventListener('change', () => {
        const latest = options.getItems();
        const target = latest.find((entry) => entry.id === item.id);
        if (!target) return;
        target.done = check.checked;
        commit(latest);
        render(latest);
      });

      const text = element('span', 'todo-text');
      text.textContent = item.text;
      text.title = 'Double-click to edit';
      text.addEventListener('dblclick', () => startEdit(item, text));

      const remove = element('button', 'todo-remove');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Delete task');
      remove.title = 'Delete';
      remove.addEventListener('click', () => {
        const latest = options.getItems().filter((entry) => entry.id !== item.id);
        options.onChange(latest);
        render(latest);
      });

      row.append(check, text, remove);
      list.append(row);
    }

    const remaining = items.filter((item) => !item.done).length;
    count.textContent = `${remaining} left`;
    clearDone.disabled = !items.some((item) => item.done);
  };

  clearDone.addEventListener('click', () => {
    const latest = options.getItems().filter((item) => !item.done);
    options.onChange(latest);
    render(latest);
  });

  root.append(form, list, footer);
  render(options.getItems());

  return {
    element: root,
    update: render,
    destroy: () => {
      root.remove();
    },
  };
}
