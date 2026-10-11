// Where the sidebar sits on Google Calendar's page: the room made for it beside
// Google's layout, and whether Google's own main menu, its left nav, is open
// beside the grid. Like theme.ts and names.ts it uses no class name of
// Google's, only [role="main"] and measured geometry.

import { debugLog } from './debug';

export const SIDEBAR_WIDTH   = 280;
export const COLLAPSED_WIDTH = 40;

const SIDEBAR_ID = 'usuals-sidebar';

// ── Making room ───────────────────────────────────────────────────────────────

// transform: translateX() shifts Google Calendar's root including its own fixed
// children (FAB, top bar) because transform creates a new containing block for
// position:fixed descendants — they shift right along with the container.
export function getGcalRoot(): HTMLElement | null {
  // Walk up from [role="main"] to the direct child of <body>.
  // This is reliable regardless of how many wrapper divs Google Calendar uses.
  const mainEl = document.querySelector<HTMLElement>('[role="main"]');
  if (!mainEl) return null;
  let el: HTMLElement = mainEl;
  while (el.parentElement && el.parentElement.tagName !== 'BODY') {
    el = el.parentElement as HTMLElement;
  }
  if (el.id === SIDEBAR_ID) return null;
  return el;
}

// Google Calendar in Hebrew or Arabic lays its whole page out right to left,
// its menu and nav on the right. The sidebar stays on the left either way, and
// in its own left-to-right order, since its words are English (content.tsx
// sets dir="ltr" on its mount). A root narrowed by the sidebar's width already
// sits against the right edge of a right-to-left page, which leaves the
// sidebar's strip free at the left, so there it is narrowed and not moved. It
// still gets a transform, of nothing, so Google's fixed children keep the root
// as their containing block in both directions.
function pageIsRtl(): boolean {
  return getComputedStyle(document.body).direction === 'rtl';
}

// The root is clipped across, never down. Shifted, anything inside it that is
// wider than the narrowed root (a 100vw element, a fixed child sized to the
// viewport) would reach past the window's right edge, give the page a
// horizontal scrollbar and take that scrollbar's height off the bottom of the
// window. What it clips is off screen or under the sidebar anyway. clip, not
// hidden, so the root does not become a scroll container and Google's sticky
// headers keep sticking to what they did.
export function adjustLayout(collapsed: boolean): void {
  const px = collapsed ? COLLAPSED_WIDTH : SIDEBAR_WIDTH;
  const root = getGcalRoot();
  if (!root) { console.warn('[Usuals] adjustLayout: no root found'); return; }
  const shift = pageIsRtl() ? 0 : px;
  debugLog('adjustLayout: shifting', root.tagName, root.id || root.className.slice(0, 60), 'by', shift, 'px, narrowing by', px, 'px');
  root.style.transform  = `translateX(${shift}px)`;
  root.style.width      = `calc(100% - ${px}px)`;
  root.style.overflowX  = 'clip';
  root.style.transition = 'transform 0.2s ease-in-out, width 0.2s ease-in-out';
}

// Gives Google Calendar back its own layout, for a view the sidebar does not
// show in.
export function resetLayout(): void {
  const root = getGcalRoot();
  if (!root) return;
  root.style.transform  = '';
  root.style.width      = '';
  root.style.overflowX  = '';
  root.style.transition = '';
}

// ── Google's main menu ────────────────────────────────────────────────────────
//
// The ☰ in Google's top bar opens and closes its left nav: the mini month,
// "My calendars" and the rest. Rather than find the button, whose name is in
// the page's language, or the nav, which has only class names to go by, this
// measures the room the nav takes: from the root's start edge to the start
// edge of [role="main"], the grid. Closed, that is at most a margin; open, it
// is the nav's 256 px. Both edges move together with the root's own shift,
// so the sidebar collapsing or opening never changes the reading.
//
// A nav Google draws over the grid, as it does in a narrow window, takes no
// room and reads as closed, which is right: the grid keeps its width.
const NAV_OPEN_MIN_PX = 120;

export function googleNavOpen(): boolean | null {
  const main = document.querySelector<HTMLElement>('[role="main"]');
  const root = getGcalRoot();
  if (!main || !root) return null;
  const m = main.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  const room = pageIsRtl() ? r.right - m.right : m.left - r.left;
  return room >= NAV_OPEN_MIN_PX;
}

// Calls back with the nav's state now and whenever it changes. Opening or
// closing the nav resizes the grid, so a ResizeObserver on [role="main"] hears
// it, frame by frame while Google animates it, and the reading is taken at
// most once a frame. A window resize is heard the same way. Google may draw a
// new [role="main"] for another view, so each reading finds it again and moves
// the observer to it, and a click anywhere, the ☰ included, takes a reading,
// which catches a new one the observer was not yet on. Returns a stop
// function.
export function watchGoogleNav(onChange: (open: boolean) => void): () => void {
  let last: boolean | null = null;
  let frame = 0;
  let observed: Element | null = null;

  const read = () => {
    frame = 0;
    const main = document.querySelector('[role="main"]');
    if (main !== observed) {
      if (observed) observer.unobserve(observed);
      if (main) observer.observe(main);
      observed = main;
    }
    const open = googleNavOpen();
    if (open === null || open === last) return;
    last = open;
    onChange(open);
  };

  const schedule = () => { if (!frame) frame = requestAnimationFrame(read); };
  const observer = new ResizeObserver(schedule);

  window.addEventListener('resize', schedule);
  document.addEventListener('click', schedule, { capture: true, passive: true });
  read();

  return () => {
    observer.disconnect();
    window.removeEventListener('resize', schedule);
    document.removeEventListener('click', schedule, { capture: true });
    if (frame) cancelAnimationFrame(frame);
  };
}
