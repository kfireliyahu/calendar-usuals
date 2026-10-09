// Which theme Google Calendar is showing, so the sidebar and everything the
// content script draws on the page can match it.
//
// Google Calendar has its own Light / Dark / Device default setting (Settings
// → Appearance), so prefers-color-scheme alone gets it wrong whenever the two
// disagree: "Light" in Google Calendar on a dark OS, or "Dark" on a light one.
// What matters is what the page is actually painted with, so that is what this
// reads. It assumes as little as it can about Google's DOM:
//
// - The calendar sits in an element with role="main" (content.tsx relies on
//   this too). Google paints its theme's background on that element or on one
//   of its ancestors, up to <html>. No class name, attribute or stylesheet of
//   Google's is relied on, because none of them is documented and any of them
//   can change.
// - A dark theme is a dark background. The first ancestor that paints a
//   mostly opaque background decides: dark if its luminance is low.
// - If nothing up the chain paints a background, the browser canvas shows,
//   which is white unless <html> asks for a dark color-scheme.

export type Theme = 'light' | 'dark';

type Rgba = [r: number, g: number, b: number, a: number];

// Below this, white text has more contrast on the colour than near-black text
// does (contrast with #fff equals contrast with #000 at about 0.18). Google's
// light backgrounds are near 1 and its dark greys near 0.01, so the exact cut
// only matters for a page that is neither.
const DARK_BELOW_LUMINANCE = 0.18;

// A background this see-through is mostly showing what is under it, so the
// walk carries on to the parent.
const OPAQUE_ENOUGH = 0.5;

// ── Reading colours ───────────────────────────────────────────────────────────

// Chrome reports a computed background-color as rgb() or rgba() for any colour
// written in sRGB, which is what Google uses today. Calendar and event colours
// arrive as #rrggbb. The canvas fallback covers a colour Google might one day
// write as oklch() or color(), which Chrome reports in that form instead.
const HEX_PATTERN = /^#([0-9a-f]{6})$/i;
const RGB_PATTERN = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i;

let probe: CanvasRenderingContext2D | null | undefined;

export function parseColor(css: string): Rgba | null {
  const hex = css.trim().match(HEX_PATTERN);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [n >> 16, (n >> 8) & 0xff, n & 0xff, 1];
  }
  const m = css.trim().match(RGB_PATTERN);
  if (m) {
    const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
    return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
  }
  if (typeof CSS === 'undefined' || !CSS.supports('color', css)) return null;
  if (probe === undefined) {
    probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  }
  if (!probe) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

// WCAG relative luminance, 0 for black to 1 for white.
export function relativeLuminance([r, g, b]: Rgba): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// ── Text on a data colour ─────────────────────────────────────────────────────

const LIGHT_TEXT = '#ffffff';
const DARK_TEXT  = '#202124';

// White text on a calendar or event colour, as Google Calendar draws its own
// event chips, unless the colour is so light that white falls below 3:1
// (Banana, Sage, Flamingo, the pastel calendar colours); then near-black, which
// beats white by far on all of those. The colour is the same in both themes,
// so the choice is too.
const MIN_LIGHT_TEXT_CONTRAST = 3;

export function readableTextOn(color: string): string {
  const parsed = parseColor(color);
  if (!parsed) return LIGHT_TEXT;
  const contrastWithWhite = 1.05 / (relativeLuminance(parsed) + 0.05);
  return contrastWithWhite >= MIN_LIGHT_TEXT_CONTRAST ? LIGHT_TEXT : DARK_TEXT;
}

// ── Detecting the theme ───────────────────────────────────────────────────────

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

export function detectTheme(): Theme {
  const start = document.querySelector('[role="main"]') ?? document.body;
  for (let el: Element | null = start; el; el = el.parentElement) {
    const color = parseColor(getComputedStyle(el).backgroundColor);
    if (color && color[3] >= OPAQUE_ENOUGH) {
      return relativeLuminance(color) < DARK_BELOW_LUMINANCE ? 'dark' : 'light';
    }
  }

  // Nothing painted: the canvas shows, and its colour follows the root's
  // color-scheme. "light dark" means the browser picks by the OS setting.
  const scheme = getComputedStyle(document.documentElement).colorScheme;
  const allowsDark  = /\bdark\b/.test(scheme);
  const allowsLight = /\blight\b/.test(scheme);
  if (allowsDark && !allowsLight) return 'dark';
  if (allowsDark && darkQuery().matches) return 'dark';
  return 'light';
}

// ── Watching for a change ─────────────────────────────────────────────────────

// Mutations come in bursts, and the check reads computed styles, so a burst
// costs one check at most this long after it starts.
const RECHECK_DELAY_MS = 150;

// Google can switch theme in ways no observer here would see, such as a class
// on some wrapper deep inside its app. The theme is also read again this often
// while the tab is visible; the check is a handful of getComputedStyle calls.
const RECHECK_POLL_MS = 3000;

// Calls apply with the current theme straight away, then again whenever it
// changes. It never calls apply twice in a row with the same theme.
//
// What can change it: Google toggling a class or style on <html> or <body>,
// replacing the app's root under <body>, adding or swapping a stylesheet in
// <head>, and, under "Device default", the OS switching between light and
// dark, which only Google's reaction to it would otherwise reveal.
export function watchTheme(apply: (theme: Theme) => void): void {
  let current = detectTheme();
  apply(current);

  let pending: ReturnType<typeof setTimeout> | null = null;
  const recheck = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const next = detectTheme();
      if (next === current) return;
      current = next;
      apply(next);
    }, RECHECK_DELAY_MS);
  };

  const observer = new MutationObserver(recheck);
  observer.observe(document.documentElement, { attributes: true });
  observer.observe(document.body, { attributes: true, childList: true });
  if (document.head) observer.observe(document.head, { childList: true });

  darkQuery().addEventListener('change', recheck);

  setInterval(() => {
    if (document.visibilityState === 'visible') recheck();
  }, RECHECK_POLL_MS);
}
