/**
 * Pointer-driven drag and resize for overlay widgets and launcher boxes.
 *
 * Deliberately implemented on raw pointer events (no HTML5 drag-and-drop) so
 * that a fast flick never outruns the pointer, and so the same code works
 * identically inside a transparent fullscreen overlay.
 *
 * All movement is reported as a pure delta; the caller decides what to do with
 * it and persists the result. Only `transform`/`opacity` are animated by CSS -
 * this module moves elements via `left`/`top` because the widgets are freely
 * positioned, and dragging is a direct-manipulation gesture where a transform
 * would fight the layout the user is seeing.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DragOptions {
  /** Called on every move with the proposed rectangle. */
  onMove: (rect: Rect) => void;
  /** Called once when the gesture finishes (or is cancelled). */
  onEnd?: (rect: Rect) => void;
  onStart?: () => void;
  /** Edges that initiate a resize instead of a move. */
  edges?: readonly Edge[];
  minW?: number;
  minH?: number;
  /** Keep the element inside this box. */
  bounds?: { w: number; h: number };
  /** Resize handles snap to this grid. 0 disables. */
  snap?: number;
}

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const THRESHOLD = 4; // px of movement before a press becomes a drag

/**
 * Attach a drag/resize gesture to `handle`.
 *
 * `rect` is the current geometry; the callback receives updated geometry.
 */
export function draggable(handle: HTMLElement, rect: () => Rect, opts: DragOptions): () => void {
  const edges = opts.edges ?? [];
  const minW = opts.minW ?? 160;
  const minH = opts.minH ?? 80;

  let active = false;
  let startX = 0;
  let startY = 0;
  let origin: Rect = { x: 0, y: 0, w: 0, h: 0 };
  let current: Rect = { x: 0, y: 0, w: 0, h: 0 };
  let pointerId = -1;
  let moved = false;

  const onPointerDown = (e: PointerEvent) => {
    // Never hijack clicks aimed at real controls.
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-no-drag]')) return;
    if (e.detail > 1) return; // ignore double-click spam

    active = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    origin = { ...rect() };
    current = { ...origin };
    pointerId = e.pointerId;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!active || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < THRESHOLD) return;
    if (!moved) {
      moved = true;
      opts.onStart?.();
    }
    e.preventDefault();

    const edge = edgeUnder(e);
    current = applyDelta(origin, dx, dy, edge, minW, minH, opts.bounds, opts.snap ?? 0);
    opts.onMove(current);
  };

  const finish = (e: PointerEvent) => {
    if (!active || e.pointerId !== pointerId) return;
    active = false;
    try {
      handle.releasePointerCapture(pointerId);
    } catch {
      /* pointer already gone */
    }
    if (moved) opts.onEnd?.(current);
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);

  return () => {
    handle.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
  };
}

function edgeUnder(e: PointerEvent): Edge | null {
  const el = e.currentTarget as HTMLElement | null;
  if (!el) return null;
  const edge = el.dataset.edge as Edge | undefined;
  return edge ?? null;
}

function applyDelta(
  o: Rect,
  dx: number,
  dy: number,
  edge: Edge | null,
  minW: number,
  minH: number,
  bounds: { w: number; h: number } | undefined,
  snap: number,
): Rect {
  const next: Rect = { ...o };

  if (edge) {
    if (edge.includes('e')) next.w = Math.max(minW, o.w + dx);
    if (edge.includes('s')) next.h = Math.max(minH, o.h + dy);
    if (edge.includes('w')) {
      // Dragging the west edge moves the origin as well as the width.
      const w = Math.max(minW, o.w - dx);
      next.x = o.x + (o.w - w);
      next.w = w;
    }
    if (edge.includes('n')) {
      const h = Math.max(minH, o.h - dy);
      next.y = o.y + (o.h - h);
      next.h = h;
    }
  } else {
    next.x = o.x + dx;
    next.y = o.y + dy;
  }

  if (snap > 0) {
    if (edge) {
      if (edge.includes('e')) next.w = snapTo(next.w, snap, 0);
      if (edge.includes('s')) next.h = snapTo(next.h, snap, 0);
      if (edge.includes('w')) {
        next.w = snapTo(next.w, snap, 0);
        next.x = o.x + o.w - next.w;
      }
      if (edge.includes('n')) {
        next.h = snapTo(next.h, snap, 0);
        next.y = o.y + o.h - next.h;
      }
    } else {
      next.x = snapTo(next.x, snap, 0);
      next.y = snapTo(next.y, snap, 0);
    }
  }

  if (bounds) {
    next.w = Math.min(next.w, bounds.w);
    next.h = Math.min(next.h, bounds.h);
    next.x = Math.min(Math.max(next.x, 0), Math.max(0, bounds.w - next.w));
    next.y = Math.min(Math.max(next.y, 0), Math.max(0, bounds.h - next.h));
  }
  return next;
}

function snapTo(v: number, grid: number, offset: number): number {
  return Math.round((v - offset) / grid) * grid + offset;
}

/** Resize handles to render for a given edge set. */
export const ALL_EDGES: readonly Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
