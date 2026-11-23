/**
 * Shared style helpers used by both windows.
 *
 * Colours are stored as CSS colour strings. The launcher box turns them into
 * the `--box-*` custom properties; opacity is folded into the background alpha
 * only so text and icons never fade out with the panel.
 */
import { fontStack, type BehaviorConfig, type LayoutConfig, type TypographyConfig, type WidgetStyle } from './types';

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** True when the browser would accept this as a CSS colour. */
export function isColor(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    return typeof CSS !== 'undefined' && CSS.supports('color', value);
  } catch {
    return false;
  }
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

let canvasCtx: CanvasRenderingContext2D | null = null;
const colorCache = new Map<string, Rgba>();

function scratchContext(): CanvasRenderingContext2D | null {
  if (canvasCtx) return canvasCtx;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    canvasCtx = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    canvasCtx = null;
  }
  return canvasCtx;
}

/** Resolve any valid CSS colour to its sRGB channels (alpha included). */
function parseColor(value: string): Rgba | null {
  if (!isColor(value)) return null;
  const cached = colorCache.get(value);
  if (cached) return cached;
  const ctx = scratchContext();
  if (!ctx) return null;
  try {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000000';
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const parsed = { r, g, b, a: a / 255 };
    colorCache.set(value, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function toHex(rgba: Rgba): string {
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${hex(rgba.r)}${hex(rgba.g)}${hex(rgba.b)}`;
}

/** `#rrggbb` for `<input type="color">`; falls back when the value is bad. */
export function toHexColor(value: string, fallback = '#16182b'): string {
  const rgba = parseColor(value);
  return rgba ? toHex(rgba) : fallback;
}

/**
 * Fold any alpha already present in the background colour into `opacity` and
 * store the colour as opaque hex. Keeps hand-written `rgba(...)` styles
 * (including files from older builds) rendering exactly as before, while
 * making the opacity slider mean the real background alpha. Idempotent.
 */
export function normalizeStyle(style: WidgetStyle): WidgetStyle {
  const base = parseColor(style.bg) ?? { r: 22, g: 24, b: 43, a: 1 };
  const opacity = clampNumber(style.opacity, 0, 100);
  return {
    ...style,
    bg: toHex(base),
    fg: isColor(style.fg) ? style.fg : '#e9eaf2',
    accent: isColor(style.accent) ? style.accent : '#6366f1',
    opacity: Math.round(clampNumber(opacity * base.a, 0, 100)),
    radius: clampNumber(style.radius, 0, 32),
    blur: clampNumber(style.blur, 0, 80),
  };
}

/** Push a widget style onto an element as `--box-*` custom properties. */
export function applyBoxVars(el: HTMLElement, style: WidgetStyle): void {
  const base = parseColor(style.bg) ?? { r: 22, g: 24, b: 43, a: 0.72 };
  const opacity = clampNumber(style.opacity, 0, 100) / 100;
  const alpha = Math.min(1, Math.max(0, base.a * opacity));

  el.style.setProperty('--box-bg', `rgba(${base.r}, ${base.g}, ${base.b}, ${alpha.toFixed(3)})`);
  el.style.setProperty('--box-text', isColor(style.fg) ? style.fg : '#e9eaf2');
  el.style.setProperty('--box-accent', isColor(style.accent) ? style.accent : '#6366f1');
  el.style.setProperty('--box-opacity', opacity.toFixed(3));
  el.style.setProperty('--box-radius', `${clampNumber(style.radius, 0, 32)}px`);
  el.style.setProperty('--box-blur', style.blur > 0 ? `${style.blur}px` : '0px');
}

export function applyNovaVars(
  el: HTMLElement,
  style: WidgetStyle,
  typography: TypographyConfig,
  layout: LayoutConfig,
  behavior: BehaviorConfig,
): void {
  applyBoxVars(el, style);
  el.style.setProperty('--nova-orb-size', `${clampNumber(layout.orbSize, 32, 88)}px`);
  el.style.setProperty('--nova-panel-w', `${clampNumber(layout.panelWidth, 240, 560)}px`);
  el.style.setProperty('--nova-panel-h', `${clampNumber(layout.panelHeight, 160, 480)}px`);
  el.style.setProperty('--nova-pad', `${clampNumber(layout.padding, 4, 18)}px`);
  el.style.setProperty('--nova-gap', `${clampNumber(layout.gap, 2, 16)}px`);
  el.style.setProperty('--nova-font', fontStack(typography.family));
  el.style.setProperty('--nova-font-size', `${clampNumber(typography.size, 10, 20)}px`);
  el.style.setProperty('--nova-font-weight', String(clampNumber(typography.weight, 400, 700)));
  el.style.setProperty('--nova-letter-spacing', `${clampNumber(typography.letterSpacing, -1, 4)}px`);
  el.style.setProperty('--nova-line-height', String(clampNumber(typography.lineHeight, 1, 2)));
  el.classList.toggle('no-motion', !behavior.animations);
}
