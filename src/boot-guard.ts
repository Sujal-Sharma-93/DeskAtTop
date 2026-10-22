/**
 * Boot guard.
 *
 * Loaded before `main.ts` and deliberately free of any project import, so it
 * still runs when the main module graph fails to resolve or throws. It
 * reports uncaught errors and rejected promises into the page (and, when the
 * Tauri bridge is reachable, into the startup log).
 */

const STATUS_ID = 'boot-status';

function statusNode(): HTMLElement | null {
  return document.getElementById(STATUS_ID);
}

/** Write a diagnostic line into the page. */
export function showBootMessage(message: string): void {
  const node = statusNode();
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

async function reportToRust(message: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('ui_error', { message });
  } catch {
    // The bridge is optional: the page text is the primary channel.
  }
}

function publish(message: string): void {
  showBootMessage(message);
  void reportToRust(message);
}

window.addEventListener('error', (event) => {
  const where = event.filename ? ` (${event.filename}:${event.lineno})` : '';
  publish(`error: ${event.message || 'unknown'}${where}`);
});

window.addEventListener('unhandledrejection', (event) => {
  publish(`rejected: ${describe(event.reason)}`);
});
