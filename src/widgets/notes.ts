/**
 * Notes panel.
 *
 * Loaded on demand from the box window (dynamic `import`) so its code only
 * ships when the widget is enabled. The host owns the store; this module keeps
 * a working copy and debounces writes by ~500 ms. `flush()` commits a pending
 * edit immediately and is called when the window hides or closes.
 */
import { uid, type Note } from '../lib/types';

export interface NotesState {
  notes: Note[];
  activeId: string | null;
}

export interface NotesPanel {
  element: HTMLElement;
  update(state: NotesState): void;
  flush(): void;
  destroy(): void;
}

interface Options {
  getState: () => NotesState;
  onChange: (state: NotesState) => void;
}

const SAVE_DELAY_MS = 500;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function cloneState(state: NotesState): NotesState {
  return {
    notes: state.notes.map((note) => ({ ...note })),
    activeId: state.activeId,
  };
}

/** Title rule: the first line of the body. */
function titleOf(body: string): string {
  const first = body.split(/\r?\n/)[0]?.trim() ?? '';
  return first.slice(0, 80);
}

function displayTitle(note: Note): string {
  return note.title.trim() || 'Untitled';
}

export function createNotesPanel(options: Options): NotesPanel {
  const initial = cloneState(options.getState());
  let notes: Note[] = initial.notes;
  let activeId: string | null = initial.activeId;

  const root = element('div', 'notes-panel');

  const side = element('div', 'notes-side');
  const sideHead = element('div', 'notes-side-head');
  const newButton = element('button', 'notes-btn notes-new');
  newButton.type = 'button';
  newButton.textContent = '+ New';
  const deleteButton = element('button', 'notes-btn notes-delete');
  deleteButton.type = 'button';
  deleteButton.textContent = 'Delete';
  sideHead.append(newButton, deleteButton);

  const list = element('ul', 'notes-list');
  side.append(sideHead, list);

  const editorWrap = element('div', 'notes-editor-wrap');
  const editor = element('textarea', 'notes-editor');
  editor.placeholder = 'Select or create a note, then type…';
  editor.spellcheck = true;
  editor.setAttribute('aria-label', 'Note body');
  editorWrap.append(editor);

  root.append(side, editorWrap);

  let saveTimer: number | undefined;
  let dirty = false;

  const clearTimer = (): void => {
    if (saveTimer !== undefined) {
      window.clearTimeout(saveTimer);
      saveTimer = undefined;
    }
  };

  const commit = (): void => {
    clearTimer();
    if (!dirty) return;
    dirty = false;
    options.onChange({
      notes: notes.map((note) => ({ ...note })),
      activeId,
    });
  };

  const schedule = (): void => {
    dirty = true;
    clearTimer();
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      commit();
    }, SAVE_DELAY_MS) as unknown as number;
  };

  const activeNote = (): Note | undefined =>
    activeId === null ? undefined : notes.find((note) => note.id === activeId);

  const renderList = (): void => {
    list.replaceChildren();

    if (notes.length === 0) {
      const row = element('li');
      const empty = element('p', 'notes-empty');
      empty.textContent = 'No notes yet';
      row.append(empty);
      list.append(row);
    } else {
      for (const note of notes) {
        const row = element('li');
        const button = element('button', 'notes-item');
        button.type = 'button';
        button.textContent = displayTitle(note);
        button.title = displayTitle(note);
        if (note.id === activeId) button.classList.add('is-active');
        button.addEventListener('click', () => select(note.id));
        row.append(button);
        list.append(row);
      }
    }

    deleteButton.disabled = activeId === null;
  };

  const syncEditor = (): void => {
    const note = activeNote();
    editor.disabled = !note;
    editor.value = note?.body ?? '';
    editor.placeholder = note
      ? 'Start typing…'
      : 'Select or create a note, then type…';
  };

  const select = (id: string): void => {
    if (id === activeId) return;
    commit();
    activeId = id;
    renderList();
    syncEditor();
    editor.focus();
    // Remember the selection without waiting for an edit.
    dirty = true;
    schedule();
  };

  newButton.addEventListener('click', () => {
    commit();
    const note: Note = { id: uid('note'), title: '', body: '', updatedAt: Date.now() };
    notes.push(note);
    activeId = note.id;
    renderList();
    syncEditor();
    dirty = true;
    commit();
    editor.focus();
  });

  deleteButton.addEventListener('click', () => {
    const note = activeNote();
    if (!note) return;
    if (!window.confirm(`Delete "${displayTitle(note)}"?`)) return;
    notes = notes.filter((entry) => entry.id !== note.id);
    activeId = notes[0]?.id ?? null;
    renderList();
    syncEditor();
    dirty = true;
    commit();
  });

  editor.addEventListener('input', () => {
    const note = activeNote();
    if (!note) return;
    note.body = editor.value;
    note.title = titleOf(editor.value);
    note.updatedAt = Date.now();
    renderList();
    schedule();
  });

  renderList();
  syncEditor();

  return {
    element: root,
    update(state) {
      // External writes only matter when this panel has nothing buffered.
      if (dirty) return;
      const next = cloneState(state);
      notes = next.notes;
      activeId = next.activeId;
      if (activeId !== null && !notes.some((note) => note.id === activeId)) {
        activeId = notes[0]?.id ?? null;
      }
      renderList();
      syncEditor();
    },
    flush: commit,
    destroy: () => {
      clearTimer();
      root.remove();
    },
  };
}
