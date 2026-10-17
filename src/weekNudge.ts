// The pill that points the way to Week view. The sidebar hides in every view
// but Week and Day (calendarGrid.ts, isWeekOrDayView), so someone whose
// Calendar opens in Month view would otherwise see no sign of Usuals at all,
// nor of anything they added to it. In Month, Year, Schedule and custom views
// a small pill at the bottom left of the window, where the sidebar would be,
// says so and offers a button to the same date in Week view. It never
// navigates by itself, and once dismissed it stays dismissed on this computer.
//
// It is position: fixed and appended to <body>, outside Google's root, so it
// takes no room in Google's layout and moves nothing.

import { Theme } from './theme';
import { isWeekOrDayView } from './calendarGrid';

const NUDGE_ID = 'wlp-week-nudge';
const DISMISSED_KEY = 'weekNudgeDismissed';

// The views it shows in, named as Google names them in the path after /r/
// (see isWeekOrDayView): Schedule is /r/agenda, and a custom view is
// /r/customday. Settings, the full event editor, search and anything else
// Google adds later are left alone, since none of them is a calendar the user
// could be expecting the sidebar beside.
const NUDGE_VIEWS = /^(month|year|agenda|custom)/;

// A bare /r opens the user's default view, which only the grid gives away,
// and the grid is drawn a moment after the path changes: until then it reads
// as "not Week or Day". The pill waits this long into a view before showing,
// so it does not flash up on the way into a Week view that is still drawing.
const SETTLE_MS = 1000;
const VIEW_CHECK_MS = 500;

function viewSegments(): { base: string[]; view: string | undefined; date: string[] } | null {
  const parts = location.pathname.split('/');
  const r = parts.indexOf('r');
  if (r === -1) return null;
  let rest = parts.slice(r + 1).filter(Boolean);
  const view = rest[0] && !/^\d/.test(rest[0]) ? rest[0] : undefined;
  if (view) rest = rest.slice(1);
  return { base: parts.slice(0, r + 1), view, date: rest.slice(0, 3) };
}

function wantsNudge(): boolean {
  const seg = viewSegments();
  if (!seg) return false;
  if (seg.view && !NUDGE_VIEWS.test(seg.view)) return false;
  return !isWeekOrDayView();
}

// Week view of the date the current view is on, /r/week/2026/10/17, keeping
// whatever comes before /r/ (the /u/1/ of a second signed-in account). A view
// whose path names no date is showing today, which is what a bare /r/week
// opens on.
export function weekViewUrl(): string {
  const seg = viewSegments();
  if (!seg) return 'https://calendar.google.com/calendar/r/week';
  const { base, date } = seg;
  const dated = date.length === 3 && date.every((p) => /^\d+$/.test(p));
  return [...base, 'week', ...(dated ? date : [])].join('/') + location.search;
}

// ── The element ───────────────────────────────────────────────────────────────

let nudgeEl: HTMLElement | null = null;

function getNudge(theme: Theme, onDismiss: () => void): HTMLElement {
  if (nudgeEl) return nudgeEl;
  const el = document.createElement('div');
  el.id = NUDGE_ID;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Usuals');
  el.setAttribute('data-wlp-theme', theme);
  // English words, in their own order on a right-to-left page, as the sidebar.
  el.dir = 'ltr';
  el.style.display = 'none';

  const text = document.createElement('span');
  text.className = 'wlp-nudge-text';
  text.textContent = 'Usuals works in Week and Day view';

  // A real link, so it can also be opened in a new tab; its address is set
  // each time the pill shows, for the date on screen then.
  const go = document.createElement('a');
  go.className = 'wlp-nudge-go';
  go.textContent = 'Open Week view';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'wlp-nudge-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.title = 'Dismiss';
  close.textContent = '×';
  close.addEventListener('click', onDismiss);

  el.append(text, go, close);
  document.body.appendChild(el);
  nudgeEl = el;
  return el;
}

export function setWeekNudgeTheme(theme: Theme): void {
  nudgeEl?.setAttribute('data-wlp-theme', theme);
}

// ── Watching the view ─────────────────────────────────────────────────────────

// Its own watch rather than watchWeekOrDayView's, which only reports Week or
// Day against everything else, so it would not hear about a move from Month
// view into Settings, where the pill has to go.
export function watchWeekNudge(currentTheme: () => Theme): void {
  const hasStorage = typeof chrome !== 'undefined' && !!chrome.storage?.local;
  // Unknown until storage answers, and nothing is shown before then, so a
  // dismissed pill never flashes on load. Without storage the dismissal only
  // lasts for the page.
  let dismissed: boolean | null = hasStorage ? null : false;
  let wantedSince: number | null = null;

  const hide = () => { if (nudgeEl) nudgeEl.style.display = 'none'; };

  const dismiss = () => {
    dismissed = true;
    hide();
    // A reloaded extension leaves this script orphaned, and then the call
    // throws rather than rejects; the pill is hidden for this page either way.
    try {
      if (hasStorage) chrome.storage.local.set({ [DISMISSED_KEY]: true }).catch(() => {});
    } catch { /* see above */ }
  };

  const check = () => {
    if (dismissed !== false || !wantsNudge()) { wantedSince = null; hide(); return; }
    const now = performance.now();
    if (wantedSince === null) wantedSince = now;
    if (now - wantedSince < SETTLE_MS) return;
    const el = getNudge(currentTheme(), dismiss);
    el.querySelector<HTMLAnchorElement>('.wlp-nudge-go')!.href = weekViewUrl();
    el.style.display = '';
  };

  if (hasStorage) {
    chrome.storage.local.get(DISMISSED_KEY).then((stored) => {
      dismissed = stored[DISMISSED_KEY] === true;
      check();
    }).catch(() => { dismissed = false; });
    // A dismissal in another Calendar tab takes this one's pill away too.
    chrome.storage.local.onChanged.addListener((changes) => {
      if (changes[DISMISSED_KEY]?.newValue === true) { dismissed = true; hide(); }
    });
  }

  window.navigation?.addEventListener('currententrychange', check);
  setInterval(check, VIEW_CHECK_MS);
  check();
}
