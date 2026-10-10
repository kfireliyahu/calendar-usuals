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
    console.warn('[WeeklyPool] Invalid datekey:', datekey);
    return null;
  }

  const year  = DATEKEY_EPOCH_YEAR + (dk >> 9);
  const month = (dk >> 5) & 0b1111; // 1-12
  const day   = dk & 0b11111;       // 1-31

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    console.warn('[WeeklyPool] Unresolvable datekey:', dk, { year, month, day });
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

export const PIXELS_PER_HOUR = 60; // 1 px = 1 minute

// A drop or click offset reads as "minutes since midnight", which only holds
// in the week/day time grid, where a gridcell is one whole day column at
// PIXELS_PER_HOUR (24 h => ~1440 px). Month-view cells and the all-day row are
// also [role="gridcell"] with a datekey, but they are a fraction of that height,
// so the same arithmetic there yields an arbitrary time. Require most of a full
// day's height before trusting the offset.
const TIME_GRID_MIN_HEIGHT = 20 * PIXELS_PER_HOUR;

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
    if (cell.closest('#weekly-life-pool-sidebar') || !isTimeGridCell(cell)) return;
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
    if (minutes === null || !el || el.closest('#weekly-life-pool-sidebar')) continue;
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
