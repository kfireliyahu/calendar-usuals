// Which time zone Google Calendar draws its grid in, and turning a time read
// off that grid into the instant the Calendar API needs.
//
// The grid is drawn in the user's Calendar time zone (Settings → General →
// Time zone), which need not be the computer's. A drop at 10:00 on the grid
// means 10:00 in that zone, so building the start with the browser's own Date
// arithmetic and sending the browser's zone puts the event off by however far
// apart the two are. Everything here works from a wall-clock time (a date and
// an hour and minute) and a zone, with Intl doing the zone arithmetic.
//
// This module reads nothing from the page and imports nothing, so it can be
// checked in Node on its own. What the grid says about its zone is read by
// gridZoneLabels() in calendarGrid.ts and passed in.

export type CalendarZone =
  | { kind: 'iana'; id: string }
  // Only the grid's label is known: a fixed offset, in minutes east of UTC.
  | { kind: 'offset'; minutes: number };

// The start or end of an events.insert body.
export interface EventDateTime {
  dateTime: string;
  timeZone: string;
}

const MINUTE_MS = 60_000;
const DAY_MS    = 24 * 60 * MINUTE_MS;

// ── The primary calendar's zone ───────────────────────────────────────────────
//
// The primary calendar's timeZone, from the calendar list the sidebar already
// fetches, is the user's Calendar time zone. Reading Settings directly would
// need another OAuth scope, and this does not. The sidebar sets it once the
// list arrives; until then, and if the list has no primary entry, it is null.

let primaryTimeZone: string | null = null;

export function setPrimaryTimeZone(zone: string | undefined): void {
  primaryTimeZone = zone && isKnownZone(zone) ? zone : null;
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ── Offsets ───────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

// h23 rather than hour12: false, which some Chrome versions answer with "24"
// for midnight.
function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(zone, f);
  }
  return f;
}

function isKnownZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

// Two names for one zone, such as Asia/Calcutta and Asia/Kolkata, resolve to
// the same name in the browser's own time zone data.
function sameZone(a: string, b: string): boolean {
  return a === b || formatterFor(a).resolvedOptions().timeZone === formatterFor(b).resolvedOptions().timeZone;
}

interface WallClock {
  year: number; month: number; day: number;
  hours: number; minutes: number; seconds: number;
}

function wallClockIn(zone: string, ms: number): WallClock {
  const parts = formatterFor(zone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hours: get('hour'), minutes: get('minute'), seconds: get('second'),
  };
}

// Minutes east of UTC that the zone's clocks show at an instant.
export function offsetAt(zone: string, ms: number): number {
  const w = wallClockIn(zone, ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hours, w.minutes, w.seconds);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE_MS);
}

// ── Wall clock ↔ instant ──────────────────────────────────────────────────────

// The instant a wall-clock time in a zone names. Twice a year in a zone with
// DST that is not one instant: an hour that repeats has two, and an hour the
// clocks skip has none. These are resolved the way JavaScript's own Date
// resolves local time, the earlier of two and an hour later for a skipped
// time, so when the zone is the browser's the result is exactly what
// `new Date(y, m, d, h, min)` gives. Real zones change offset at most once a
// day, so the offsets a day either side are the only two it can have.
export function wallToInstant(zone: CalendarZone, year: number, month: number, day: number, hours: number, minutes: number): number {
  const wall = Date.UTC(year, month - 1, day, hours, minutes);
  if (zone.kind === 'offset') return wall - zone.minutes * MINUTE_MS;

  const before = offsetAt(zone.id, wall - DAY_MS);
  const after  = offsetAt(zone.id, wall + DAY_MS);
  const fits = [before, after]
    .map((offset) => wall - offset * MINUTE_MS)
    .filter((ms, i) => offsetAt(zone.id, ms) === (i === 0 ? before : after));
  if (fits.length > 0) return Math.min(...fits);
  return wall - before * MINUTE_MS;
}

function wallClockAt(zone: CalendarZone, ms: number): WallClock {
  if (zone.kind === 'iana') return wallClockIn(zone.id, ms);
  const d = new Date(ms + zone.minutes * MINUTE_MS);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hours: d.getUTCHours(), minutes: d.getUTCMinutes(), seconds: d.getUTCSeconds(),
  };
}

// ── The grid's label ──────────────────────────────────────────────────────────

// Week and Day view print their zone above the hour labels as "GMT+03" or
// "GMT-05:30". Other languages may write UTC, a bare GMT for zero, or a true
// minus sign, and right-to-left pages wrap it in direction marks.
const ZONE_LABEL = /^(?:GMT|UTC)(?:([+\-−])(\d{1,2})(?::?(\d{2}))?)?$/;
const INVISIBLE  = /[\s‎‏‪-‮⁦-⁩]/g;

// Minutes east of UTC, or null when the text is not a zone label.
export function parseZoneLabel(text: string): number | null {
  const m = text.replace(INVISIBLE, '').match(ZONE_LABEL);
  if (!m) return null;
  if (!m[1]) return 0;
  const hours = Number(m[2]);
  const mins  = m[3] ? Number(m[3]) : 0;
  if (hours > 14 || mins >= 60) return null;
  return (m[1] === '+' ? 1 : -1) * (hours * 60 + mins);
}

// ── Choosing the zone ─────────────────────────────────────────────────────────

// The label prints one offset, but which day it is for is Google's choice:
// in a week where the clocks change, it can only be right for part of it, and
// it may describe today rather than the week on screen. So a zone agrees with
// it if the zone shows that offset at some point in the week either side of
// the time being scheduled, or of now. Two zones that both pass then differ
// at most in when their clocks change, and the primary calendar's is trusted
// for that.
const LABEL_WINDOW_DAYS = 7;

function agreesWithLabel(zone: string, label: number, aroundMs: number, nowMs: number): boolean {
  for (const centre of [aroundMs, nowMs]) {
    for (let k = -LABEL_WINDOW_DAYS; k <= LABEL_WINDOW_DAYS; k++) {
      if (offsetAt(zone, centre + k * DAY_MS) === label) return true;
    }
  }
  return false;
}

// The zone the grid is drawn in, around an instant. A named zone is wanted
// wherever one can be had, because it is also the zone a weekly series is
// expanded in, and only a named zone keeps its instances at the same clock
// time when DST starts or ends.
//
// - The primary calendar's zone, when the grid's label agrees with it, or
//   when no label could be read (month view, or Google moved it).
// - Otherwise the browser's zone, when the label agrees with that.
// - Otherwise the label alone, as a fixed offset.
// - With neither a label nor a primary calendar, the browser's zone, which is
//   what every event was created in before this module existed.
//
// When the primary calendar's zone is the browser's under another name, the
// browser's name is used, so a user whose two zones match gets the same
// request, byte for byte, as before. `labels` comes nearest the grid first;
// with a secondary zone shown there are two.
export function resolveCalendarZone(labels: number[], aroundMs: number, nowMs = Date.now()): CalendarZone {
  const browser = browserTimeZone();
  const primary = primaryTimeZone && !sameZone(primaryTimeZone, browser) ? primaryTimeZone : null;
  const agrees = (zone: string) => labels.some((label) => agreesWithLabel(zone, label, aroundMs, nowMs));

  if (labels.length === 0) return { kind: 'iana', id: primary ?? browser };
  if (primaryTimeZone && agrees(primaryTimeZone)) return { kind: 'iana', id: primary ?? browser };
  if (agrees(browser)) return { kind: 'iana', id: browser };
  return { kind: 'offset', minutes: labels[0] };
}

// ── What the rest of the extension asks ───────────────────────────────────────

// Etc/GMT names are POSIX-style, so their sign is the inverse of the offset's:
// Etc/GMT-3 is three hours east of UTC. They exist only for whole hours from
// -12 to +14.
function etcZoneFor(minutes: number): string | null {
  if (minutes % 60 !== 0 || minutes < -12 * 60 || minutes > 14 * 60) return null;
  const hours = minutes / 60;
  return hours === 0 ? 'Etc/GMT' : `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
}

// RFC 3339 with the offset written out, so the request reads as the grid did.
function withOffset(ms: number, minutes: number): string {
  const w = wallClockAt({ kind: 'offset', minutes }, ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sign = minutes < 0 ? '-' : '+';
  const abs  = Math.abs(minutes);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hours)}:${pad(w.minutes)}:${pad(w.seconds)}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// The start and end of an event at a grid time. `date` is a day as
// calendarGrid.ts carries it: only its local year, month and day are read.
// The end is the start plus the duration in real minutes, so a block that
// runs past midnight, or across a change of the clocks, lasts as long as the
// item says.
export function eventTimes(
  date: Date,
  hours: number,
  minutes: number,
  durationMin: number,
  labels: number[],
): { start: EventDateTime; end: EventDateTime; zone: CalendarZone } {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const zone  = resolveCalendarZone(labels, Date.UTC(year, month - 1, day, hours, minutes));
  const start = wallToInstant(zone, year, month, day, hours, minutes);
  const end   = start + durationMin * MINUTE_MS;

  if (zone.kind === 'iana') {
    return {
      start: { dateTime: new Date(start).toISOString(), timeZone: zone.id },
      end:   { dateTime: new Date(end).toISOString(),   timeZone: zone.id },
      zone,
    };
  }

  // The offset in dateTime is what places the event; timeZone is what a weekly
  // series is expanded in, and the API requires one. A whole-hour offset has an
  // Etc/GMT name that holds it all year. A half-hour one has none, so the
  // primary calendar's zone, or else the browser's, stands in: the first event
  // is still at the grid's time, but a series follows that zone's clocks and
  // can move an hour against the grid when they change.
  const timeZone = etcZoneFor(zone.minutes) ?? primaryTimeZone ?? browserTimeZone();
  return {
    start: { dateTime: withOffset(start, zone.minutes), timeZone },
    end:   { dateTime: withOffset(end,   zone.minutes), timeZone },
    zone,
  };
}

// Today and the time of day as Google Calendar shows them, for the schedule
// form's day list and its default start. `date` is a day in calendarGrid.ts's
// form, comparable with isSameDay; `minutes` counts from midnight and keeps
// the seconds as a fraction.
export function calendarNow(labels: number[], nowMs = Date.now()): { date: Date; minutes: number } {
  const w = wallClockAt(resolveCalendarZone(labels, nowMs, nowMs), nowMs);
  return {
    date: new Date(w.year, w.month - 1, w.day),
    minutes: w.hours * 60 + w.minutes + w.seconds / 60,
  };
}
