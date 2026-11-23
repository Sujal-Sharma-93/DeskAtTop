export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

export function collapsedBounds(anchor: Point, side: number, screen: Bounds): Bounds {
  return {
    x: clamp(anchor.x, screen.x, screen.x + screen.width - side),
    y: clamp(anchor.y, screen.y, screen.y + screen.height - side),
    width: side,
    height: side,
  };
}

export function expandedBounds(
  anchor: Point,
  collapsedSide: number,
  width: number,
  height: number,
  screen: Bounds,
): Bounds {
  const half = Math.max(0, (width - collapsedSide) / 2);
  return {
    x: clamp(anchor.x - half, screen.x, screen.x + screen.width - width),
    y: clamp(anchor.y, screen.y, screen.y + screen.height - height),
    width,
    height,
  };
}

export function boundsFromDrag(bounds: Bounds, collapsedSide: number): Point {
  const half = Math.max(0, (bounds.width - collapsedSide) / 2);
  return { x: bounds.x + half, y: bounds.y };
}

export function lerpBounds(from: Bounds, to: Bounds, t: number): Bounds {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    width: from.width + (to.width - from.width) * t,
    height: from.height + (to.height - from.height) * t,
  };
}
