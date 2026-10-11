// The usuals as a file the user keeps. Chrome keeps them per extension id, in
// sync storage and a copy on the computer, and nothing else gets them out: a
// user with Chrome sync off who uninstalls loses them, a pool too big for sync
// lives on one computer only, and a build with another id (the unpacked one
// beside the store's) starts empty. Export writes them all to a JSON file and
// import adds a file's usuals back, through poolStore like any other edit.
//
// The file is meant to be read by people too, so each calendar carries the
// name the sidebar showed for it. Only calendarId decides where an item goes;
// the name is never trusted for that.

import { EVENT_COLORS, MAX_REMINDER_MIN, PoolItem } from './poolItem';
import type { PoolData } from './poolStore';

const FORMAT  = 'usuals-export';
const VERSION = 1;

interface ExportCalendar {
  calendarId: string;
  name?:      string;
  folded?:    boolean;
  items:      PoolItem[];
}

interface ExportFile {
  format:     typeof FORMAT;
  version:    number;
  exportedAt: string;
  calendars:  ExportCalendar[];
}

// ── Export ───────────────────────────────────────────────────────────────────

// Every calendar the pool holds anything for, those of a Google account this
// one cannot see included, so an export is the whole pool and not only what
// is on screen.
export function buildExport(pool: PoolData, names: Record<string, string>): { text: string; count: number } {
  const ids = new Set([...Object.keys(pool.items), ...pool.hidden]);
  const calendars: ExportCalendar[] = [];
  let count = 0;
  for (const calendarId of ids) {
    const items = pool.items[calendarId] ?? [];
    const folded = pool.hidden.includes(calendarId);
    if (items.length === 0 && !folded) continue;
    calendars.push({
      calendarId,
      ...(names[calendarId] ? { name: names[calendarId] } : {}),
      ...(folded ? { folded } : {}),
      items,
    });
    count += items.length;
  }
  const file: ExportFile = { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), calendars };
  return { text: JSON.stringify(file, null, 2) + '\n', count };
}

// usuals-2026-10-11.json, by the computer's date, which is the day the user
// will look for it under.
export function exportFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `usuals-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

// ── Import ───────────────────────────────────────────────────────────────────

// A file can come from anywhere, so every item is rebuilt from the fields a
// PoolItem has, each checked for its type and range; anything else in it is
// dropped. An item that cannot be rebuilt is counted and skipped, not fatal.
const COLOR_IDS = new Set(EVENT_COLORS.map((c) => c.id));
const MAX_DURATION_MIN = 24 * 60;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function wholeIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function cleanItem(raw: unknown, calendarId: string): PoolItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id);
  const name = text(r.name)?.trim();
  if (!id || !name) return null;
  const item: PoolItem = { id, name, calendarId };
  const durationMin = wholeIn(r.durationMin, 1, MAX_DURATION_MIN);
  const reminderMin = wholeIn(r.reminderMin, 0, MAX_REMINDER_MIN);
  if (durationMin !== undefined) item.durationMin = durationMin;
  if (reminderMin !== undefined) item.reminderMin = reminderMin;
  if (text(r.description)) item.description = r.description as string;
  if (text(r.location)) item.location = r.location as string;
  if (typeof r.colorId === 'string' && COLOR_IDS.has(r.colorId)) item.colorId = r.colorId;
  return item;
}

export class ImportError extends Error {}

// Throws ImportError, worded for the toast, when the file is not an export at
// all; returns the usuals it holds and how many items had to be skipped.
export function parseExport(source: string): { pool: PoolData; skipped: number } {
  let file: unknown;
  try {
    file = JSON.parse(source);
  } catch {
    throw new ImportError('That file is not a Usuals export');
  }
  const f = file as Partial<ExportFile> | null;
  if (!f || f.format !== FORMAT || !Array.isArray(f.calendars)) {
    throw new ImportError('That file is not a Usuals export');
  }
  if (typeof f.version !== 'number' || f.version > VERSION) {
    throw new ImportError('That export is from a newer version of Usuals; update it first');
  }

  const pool: PoolData = { items: {}, hidden: [] };
  let skipped = 0;
  for (const cal of f.calendars) {
    const calendarId = text((cal as ExportCalendar | null)?.calendarId);
    if (!calendarId) continue;
    const list = (pool.items[calendarId] ??= []);
    for (const raw of Array.isArray(cal.items) ? cal.items : []) {
      const item = cleanItem(raw, calendarId);
      if (item) list.push(item);
      else skipped++;
    }
    if (cal.folded === true && !pool.hidden.includes(calendarId)) pool.hidden.push(calendarId);
  }
  return { pool, skipped };
}
