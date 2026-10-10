// The pool item shape and everything that reads it. Both the sidebar (which
// edits items) and the content script (which turns one into a calendar event)
// need this, and they used to keep separate copies of the interface plus their
// own durationOf().
//
// Every field past `calendarId` is optional and every reader treats `undefined`
// as the behaviour that existed before the field did, so items saved by any
// earlier version, whether still in chrome.storage.local or carried into
// chrome.storage.sync by poolStore.ts, keep working without a migration step.

export interface PoolItem {
  id: string;
  name: string;
  calendarId: string;

  durationMin?: number;

  // Template fields — copied onto the event body on drop.
  description?: string;
  location?: string;
  colorId?: string;    // Google Calendar event colorId, "1".."11"
  reminderMin?: number; // popup reminder, minutes before start
}

export const DEFAULT_DURATION_MIN = 60;
export const DURATION_PRESETS = [15, 30, 45, 60, 90, 120];

export function durationOf(item: { durationMin?: number }): number {
  return item.durationMin ?? DEFAULT_DURATION_MIN;
}

export function formatDuration(min: number): string {
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  const mins  = min % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

// ── Event colors ─────────────────────────────────────────────────────────────
//
// Google Calendar's eleven event colors. The API takes the id; the hex is what
// the sidebar swatches, an item's chip and the drag preview draw with, so the
// item and its preview match the event that is about to appear.

export const EVENT_COLORS: { id: string; name: string; hex: string }[] = [
  { id: '1',  name: 'Lavender',  hex: '#7986cb' },
  { id: '2',  name: 'Sage',      hex: '#33b679' },
  { id: '3',  name: 'Grape',     hex: '#8e24aa' },
  { id: '4',  name: 'Flamingo',  hex: '#e67c73' },
  { id: '5',  name: 'Banana',    hex: '#f6bf26' },
  { id: '6',  name: 'Tangerine', hex: '#f4511e' },
  { id: '7',  name: 'Peacock',   hex: '#039be5' },
  { id: '8',  name: 'Graphite',  hex: '#616161' },
  { id: '9',  name: 'Blueberry', hex: '#3f51b5' },
  { id: '10', name: 'Basil',     hex: '#0b8043' },
  { id: '11', name: 'Tomato',    hex: '#d50000' },
];

// An unknown id falls back to the calendar colour rather than to a wrong swatch.
export function eventColorHex(colorId: string | undefined, fallback: string): string {
  if (!colorId) return fallback;
  return EVENT_COLORS.find((c) => c.id === colorId)?.hex ?? fallback;
}

// ── Reminders ────────────────────────────────────────────────────────────────
//
// undefined => leave reminders on the calendar default. 0 is a real value ("at
// start"), so every check here is against undefined, never falsy.

export const REMINDER_PRESETS = [0, 5, 10, 15, 30, 60, 120, 1440];

export function formatReminder(min: number): string {
  if (min === 0)    return 'At start';
  if (min < 60)     return `${min} min before`;
  if (min === 1440) return '1 day before';
  const hours = min / 60;
  return `${hours} hour${hours === 1 ? '' : 's'} before`;
}

// Date.now() alone collides when two items are created inside the same
// millisecond, which duplicating an item makes easy to hit.
export function newItemId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
