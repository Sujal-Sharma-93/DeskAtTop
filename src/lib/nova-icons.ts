import type { LaunchItem, LaunchKind } from './types';

function wrapped(paths: string): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const NOTEBOOK = wrapped(
  '<path d="M6 3.5h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2.5 2.5 0 0 1-2.5-2.5V6A2.5 2.5 0 0 1 6 3.5Z"/>' +
    '<path d="M6 3.5v17"/><path d="M9 8h6M9 12h6M9 16h4"/>' +
    '<path d="m16 14.4 2-2 2.2 2.2-2 2-2.9.7.7-2.9Z"/>',
);

const CALCULATOR = wrapped(
  '<rect x="5" y="3" width="14" height="18" rx="2.5"/>' +
    '<path d="M8 7h8M8 11h2M14 11h2M8 15h2M14 15h2M8 19h2M14 19h2"/>',
);

const FOLDER_OPEN = wrapped(
  '<path d="M3 8.5A2 2 0 0 1 5 6.5h4l2 2h6a2 2 0 0 1 2 2v1"/>' +
    '<path d="M3.5 10.5h17l-2 8a2 2 0 0 1-2 1.5H6a2 2 0 0 1-2-1.5l-.5-8Z"/>',
);

const APP = wrapped(
  '<rect x="4" y="4" width="7" height="7" rx="1.8"/>' +
    '<rect x="13" y="4" width="7" height="7" rx="1.8"/>' +
    '<rect x="4" y="13" width="7" height="7" rx="1.8"/>' +
    '<path d="M16.5 13v8M12.5 17h8"/>',
);

const FILE = wrapped(
  '<path d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/>' +
    '<path d="M14 3v5h4M9 12h6M9 16h6"/>',
);

const GLOBE = wrapped(
  '<circle cx="12" cy="12" r="8.5"/>' +
    '<path d="M3.5 12h17M12 3.5c2.3 2.3 3.5 5.2 3.5 8.5S14.3 18.2 12 20.5c-2.3-2.3-3.5-5.2-3.5-8.5S9.7 5.8 12 3.5Z"/>',
);

export function novaIcon(item: LaunchItem): string | null {
  const target = item.target.replace(/\\/g, '/').toLowerCase();
  const name = target.split('/').pop() ?? '';
  if (name === 'notepad.exe' || name === 'notepad') return NOTEBOOK;
  if (name === 'calc.exe' || name === 'calculator.exe') return CALCULATOR;
  if (
    item.kind === 'folder' &&
    (name === 'documents' || item.label.trim().toLowerCase() === 'documents')
  ) {
    return FOLDER_OPEN;
  }
  return null;
}

export function novaFallback(kind: LaunchKind): string {
  if (kind === 'folder') return FOLDER_OPEN;
  if (kind === 'url') return GLOBE;
  if (kind === 'file') return FILE;
  return APP;
}
