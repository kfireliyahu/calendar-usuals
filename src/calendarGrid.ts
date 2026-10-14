// Reading Google Calendar's own grid: which date a cell is, whether it is part
// of the day/week time grid, and which days that grid is showing. The content
// script needs this to turn a drop or a click into a time, and the sidebar's
// schedule form needs it to offer the days that are on screen, so it lives
// here rather than in either of them.

import { parseZoneLabel } from './calendarZone';

// ── Datekey → Date ────────────────────────────────────────────────────────────
//
// Google Calendar's data-datekey is a bit-packed date, NOT a day counter:
//
//   datekey = ((year - 1970) << 9) | (month << 5) | day     (month and day 1-based)
//
// i.e. 512 per year, 32 per month, 1 per day. Spot checks:
//   Jan  1 2026 = 28672 + 32  + 1  = 28705
//   Apr 30 2026 = 28672 + 128 + 30 = 28830
//   May  1 2026 = 28672 + 160 + 1  = 28833
//   Sep  6 2026 = 28672 + 288 + 6  = 28966
//
// The old "days since epoch + 2 per month boundary" approximation drifted by a
// day or more inside any week that crossed a month, and could land in the wrong
// month/year entirely.
//
// The Date returned is a day, not an instant: local midnight of that date, so
// its getFullYear(), getMonth() and getDate() read the date back. The date is
// the grid's, in Google Calendar's time zone, which need not be the browser's,
// so nothing should treat it as a moment in time; calendarZone.ts turns a day
// and a time on the grid into one.

const DATEKEY_EPOCH_YEAR = 1970;

export function datekeyToDate(datekey: string): Date | null {
  const dk = parseInt(datekey, 10);
  if (!Number.isFinite(dk) || dk <= 0) {
    console.warn('[Usuals] Invalid datekey:', datekey);
    return null;
  }

  const year  = DATEKEY_EPOCH_YEAR + (dk >> 9);
  const month = (dk >> 5) & 0b1111; // 1-12
  const day   = dk & 0b11111;       // 1-31

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    console.warn('[Usuals] Unresolvable datekey:', dk, { year, month, day });
    return null;
  }

  return new Date(year, month - 1, day);
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
function daysInMonth(year: number, month: number): number {
  const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month === 2 && isLeapYear(year) ? 29 : DAYS[month - 1];
}

// The datekey usually lives on the [role="gridcell"] itself, but in some views
// (all-day row, month grid) it sits on an ancestor, so walk up to find it.
export function findDatekey(cell: Element): string | null {
  const el = cell.closest('[data-datekey]');
  return el ? el.getAttribute('data-datekey') : null;
}
export function dateFromCell(cell: Element): Date | null {
  const datekey = findDatekey(cell);
  return datekey ? datekeyToDate(datekey) : null;
}

// ── Time grid ─────────────────────────────────────────────────────────────────

// In the week/day time grid a gridcell is one whole day column, midnight to
// midnight, so its height over the minutes in a day is how many pixels Google
// draws a minute. That is often 1 (an hour 60 px tall), but Google draws hours
// shorter for some accounts and screens, so it is measured, never assumed: a
// drop's offset, the preview's height and the placeholder's all go through it.
const MINUTES_PER_DAY = 24 * 60;

export function pixelsPerMinute(cell: Element): number {
  return cell.getBoundingClientRect().height / MINUTES_PER_DAY;
}

// Month-view cells and the all-day row are also [role="gridcell"] with a
// datekey, but they are a fraction of a day column's height, so the same
// arithmetic there yields an arbitrary time. The floor is well under the
// shortest hours Google draws and well over those cells, so a short time grid
// still counts and they still do not.
const TIME_GRID_MIN_HEIGHT = 24 * 16;

export function isTimeGridCell(cell: Element): boolean {
  return cell.getBoundingClientRect().height >= TIME_GRID_MIN_HEIGHT;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

// Every day column of the time grid on screen. The height check also keeps out
// the mini month in Google Calendar's own side panel, whose day cells are
// gridcells too.
function timeGridCells(): { cell: Element; date: Date }[] {
  const found: { cell: Element; date: Date }[] = [];
  document.querySelectorAll('[role="gridcell"]').forEach((cell) => {
    if (cell.closest('#usuals-sidebar') || !isTimeGridCell(cell)) return;
    const date = dateFromCell(cell);
    if (date) found.push({ cell, date });
  });
  return found;
}

// The days the time grid is showing, earliest first, or an empty list when
// there is no time grid (month view, schedule view, a settings page).
export function visibleTimeGridDays(): Date[] {
  const days: Date[] = [];
  for (const { date } of timeGridCells()) {
    if (!days.some((d) => isSameDay(d, date))) days.push(date);
  }
  return days.sort((a, b) => a.getTime() - b.getTime());
}

// The day column for a date, so an event scheduled without a drop can still
// get its loading placeholder when that day is on screen.
export function timeGridCellFor(date: Date): Element | null {
  return timeGridCells().find((c) => isSameDay(c.date, date))?.cell ?? null;
}

// ── Which view is showing ─────────────────────────────────────────────────────
//
// The extension works in Week and Day view alone. Google Calendar names the
// view in the path, after /r/: /r/week/2026/10/11, /r/day/2026/10/11, and
// /r/month, /r/year, /r/agenda and /r/customday for the others; its settings
// and full event editor are /r/settings and /r/eventedit. Weekends hidden or
// not, Week view is /r/week. A bare /r opens whichever view the user chose as
// the default in Google's settings, which the path does not name, so there
// the grid itself is read: one day column, seven, or Monday to Friday. A
// custom view of five or seven days that starts where a week would is the one
// thing that reads as a week there and is not.
export function isWeekOrDayView(): boolean {
  const parts = location.pathname.split('/');
  const r = parts.indexOf('r');
  const view = r === -1 ? undefined : parts[r + 1];
  if (view === 'week' || view === 'day') return true;
  if (view && !/^\d/.test(view)) return false;
  return gridShowsWeekOrDay();
}

const DAY_MS = 24 * 60 * 60 * 1000;

function gridShowsWeekOrDay(): boolean {
  const days = visibleTimeGridDays();
  if (days.length === 1 || days.length === 7) return true;
  // Rounded, as a DST change inside the week makes one day 23 or 25 hours.
  return days.length === 5
    && days[0].getDay() === 1
    && Math.round((days[4].getTime() - days[0].getTime()) / DAY_MS) === 4;
}

// Calls back with whether Week or Day view is showing, now and whenever that
// changes.
// Google Calendar changes view without loading a page, through the History
// API, which a content script cannot hook. Chrome's Navigation API reports
// those changes as they happen, and a check twice a second catches the rest,
// such as a bare /r whose grid is drawn only after the path has changed.
const VIEW_CHECK_MS = 500;

export function watchWeekOrDayView(onChange: (shown: boolean) => void): void {
  let last: boolean | null = null;
  const check = () => {
    const shown = isWeekOrDayView();
    if (shown === last) return;
    last = shown;
    onChange(shown);
  };
  window.navigation?.addEventListener('currententrychange', check);
  setInterval(check, VIEW_CHECK_MS);
  check();
}

// ── The grid's time zone label ────────────────────────────────────────────────
//
// Week and Day view print the zone the grid is drawn in at the top of the
// column of hour labels, as "GMT+03", and a second one beside it when a
// secondary zone is shown. It is found by what it says and where it sits, not
// by Google's class names: a short text that parses as an offset, lying in the
// gutter beside the first day column, within the width two hour columns take.
// Text on the far side of the gutter (Google's own side panel) or in a day
// column (an event called "UTC") is out of reach. Right-to-left pages put the
// gutter on the right.
const GUTTER_MAX_PX = 150;

// Minutes east of UTC, nearest the grid first, or an empty list when the time
// grid is not showing or no label could be read.
export function gridZoneLabels(): number[] {
  const grid = timeGridCells();
  if (grid.length === 0) return [];
  const rects = grid.map(({ cell }) => cell.getBoundingClientRect());
  const rtl = getComputedStyle(grid[0].cell).direction === 'rtl';
  const edge = rtl ? Math.max(...rects.map((r) => r.right)) : Math.min(...rects.map((r) => r.left));

  const found: { minutes: number; distance: number }[] = [];
  const root = document.querySelector('[role="main"]') ?? document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    if (text.length > 16) continue;
    const minutes = parseZoneLabel(text);
    const el = node.parentElement;
    if (minutes === null || !el || el.closest('#usuals-sidebar')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) continue;
    const distance = rtl ? rect.left - edge : edge - rect.right;
    if (distance >= -1 && distance <= GUTTER_MAX_PX) found.push({ minutes, distance });
  }
  return found.sort((a, b) => a.distance - b.distance).map((f) => f.minutes);
}

export function formatTime(hours: number, minutes: number): string {
  const period = hours < 12 ? 'AM' : 'PM';
  const h = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${h}:${minutes.toString().padStart(2, '0')} ${period}`;
}
