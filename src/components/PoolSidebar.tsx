import React, { useState, useEffect, useRef } from 'react';
import {
  PoolItem,
  DEFAULT_DURATION_MIN,
  DURATION_PRESETS,
  EVENT_COLORS,
  REMINDER_UNITS,
  MAX_REMINDER_MIN,
  DEFAULT_REMINDER_MIN,
  ReminderUnit,
  durationOf,
  eventColorHex,
  formatDuration,
  newItemId,
  reminderUnitMin,
  splitReminder,
} from '../poolItem';
import { formatTime, gridZoneLabels, isSameDay, visibleTimeGridDays } from '../calendarGrid';
import { calendarNow, setPrimaryTimeZone } from '../calendarZone';
import { loadPool, mergePool, onSyncFull, savePool, subscribePool } from '../poolStore';
import { ImportError, buildExport, exportFileName, parseExport } from '../poolTransfer';
import { chipTextOn } from '../theme';
import { CalendarListEntry, displayName, isolate, needsPageName, textDirection, watchCalendarList, watchPrimaryName } from '../names';
import { watchGoogleNav } from '../layout';

// hidden is the stored name, kept so every synced pool reads as before: it
// now means the calendar's section is folded to its title row, which is what
// the old "Hide category" became when hiding moved into the section's chevron.
interface PoolCategory {
  calendarId: string;
  name: string;
  color: string;
  items: PoolItem[];
  hidden?: boolean;
}

// The event a drop just created, as content.tsx sends it with 'created'.
interface UndoTarget {
  itemName: string;
  eventId: string;
  calendarId: string;
  recurring: boolean;
  itemId?: string;
}

// The undo target lives on the toast itself, so any newer toast — the next
// drop's "Adding…" included — takes the Undo button away with it, and only
// the latest drop is ever undoable.
interface Toast {
  message: string;
  type: 'info' | 'success' | 'error';
  undo?: UndoTarget;
}

const UNDO_WINDOW_MS = 5000;

// Coming back to the tab fetches the calendar list again, no more often than this.
const VISIBLE_REFETCH_MS = 60 * 1000;

// A toast does not count down while the pointer is over it or focus is inside
// it: five seconds is short for someone tabbing to Undo or listening to a
// screen reader. Once they leave it gets at least this long again, so it never
// vanishes the instant the pointer moves off.
const TOAST_RESUME_MIN_MS = 2000;

// Store users never see the README, so the sidebar's footer is how they find
// the project page. manifest.json's homepage_url repeats it, because JSON
// cannot import a constant; change both together.
const HOMEPAGE_URL = 'https://kfireliyahu.com/calendar-usuals';

// Where a reorder drag would land: the category the item would end up in and
// the index it would be inserted at (items.length means "after the last one").
interface DropTarget {
  calendarId: string;
  index: number;
}

// Shape of what this device keeps in chrome.storage.local: how this screen has
// the sidebar laid out. The pool itself syncs between machines and belongs to
// poolStore.ts. Every key is optional because storage is empty on a fresh
// install, so each read needs a fallback.
//
// primaryCalendarName is the primary calendar's name as Google's own list
// showed it last time it could be read (names.ts), so the sidebar has it at
// once on the next load, even with Google's menu closed. It is kept with the
// calendar's id, and only used for that calendar.
interface StoredState {
  sidebarCollapsed?: boolean;
  primaryCalendarName?: PrimaryName;
}

interface PrimaryName {
  calendarId: string;
  name: string;
}

// What the sidebar needs to look for the primary calendar's name on the page:
// its id, which is the account's address, and the names of the calendars
// listed with it.
interface PrimaryLookup {
  calendarId: string;
  otherNames: string[];
}

// Said once per page, the first time Chrome Sync refuses the pool for size.
// Nothing is lost: the pool keeps saving on this device.
const SYNC_FULL_MESSAGE = 'Pool too large to sync — saved on this device only';
const SYNC_FULL_HOLD_MS = 8000;

// Reorder rides on its own dataTransfer type. A pool drag sets both types, so
// one drag creates an event over the calendar grid and reorders over the
// sidebar, and neither drop handler can be fooled by the other's payload.
const REORDER_TYPE = 'poolreorder';

// After the extension is reloaded or updated, the sidebar already on this page
// keeps running, but its chrome.* calls throw "Extension context invalidated".
// One thrown from an effect makes React unmount the whole sidebar and leaves
// Google Calendar shifted right of an empty gap, so those calls check first.
function extensionAlive(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
}

function isReorderDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).some((t) => t.toLowerCase() === REORDER_TYPE);
}

// A dragover handled by an item or a header must not then be cleared by the
// container's own handler, which fires afterwards on the way up.
function markHandled(e: React.DragEvent): void {
  (e.nativeEvent as DragEvent & { wlpHandled?: boolean }).wlpHandled = true;
}
function wasHandled(e: React.DragEvent): boolean {
  return (e.nativeEvent as DragEvent & { wlpHandled?: boolean }).wlpHandled === true;
}

// What the pointer carries in a drag is a picture of the chip as it rests,
// the event-to-be, rather than of the row as it is at that moment: under the
// pointer, so with its controls showing, and faded by then as the row left
// behind. The picture is taken of a copy, held off screen for the moment the
// browser needs it, at the size of the row and from the point it was grabbed.
// A select's choice is a property the copy does not carry, so it is set again.
function setChipDragImage(e: React.DragEvent<HTMLElement>): void {
  const row = e.currentTarget;
  const rect = row.getBoundingClientRect();
  const copy = row.cloneNode(true) as HTMLElement;
  copy.className = 'wlp-item wlp-item-ghost';
  copy.style.width = `${rect.width}px`;
  const selects = row.querySelectorAll('select');
  copy.querySelectorAll('select').forEach((s, i) => { s.value = selects[i].value; });
  row.parentElement?.appendChild(copy);
  e.dataTransfer.setDragImage(copy, e.clientX - rect.left, e.clientY - rect.top);
  setTimeout(() => copy.remove(), 0);
}

// The durations a duration select offers. A stored value outside the presets
// still has to appear as an option, or the select would quietly display a
// duration the item does not have.
function durationOptions(value: number): number[] {
  return DURATION_PRESETS.includes(value)
    ? DURATION_PRESETS
    : [...DURATION_PRESETS, value].sort((a, b) => a - b);
}

// Compact duration control. A native <select> so it stays keyboard accessible
// without a custom dropdown; content.css strips the arrow to fit the 280px rail.
// title is only a tooltip for the pointer; label is the select's accessible
// name, and says which item it belongs to, since every row has one.
const DurationSelect: React.FC<{
  value: number;
  label: string;
  onChange: (min: number) => void;
}> = ({ value, label, onChange }) => {
  const options = durationOptions(value);

  return (
    <select
      value={value}
      title="Duration"
      aria-label={label}
      onChange={(e) => onChange(Number(e.target.value))}
      // Pool item rows are draggable: without this, pressing the select would
      // start a drag instead of opening the menu.
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
      className="wlp-duration"
    >
      {options.map((min) => (
        <option key={min} value={min}>{formatDuration(min)}</option>
      ))}
    </select>
  );
};

// ── Event-editor fields ──────────────────────────────────────────────────────
//
// A select drawn as one of the grey fields in Google's event editor, such as
// its calendar choice ("Pat Doe ▾") or "Does not repeat ▾": the
// browser's arrow gives way to Google's ▾, and an optional dot in front shows
// a colour. It stays a native <select>, so arrow keys, type-to-find, Escape
// and the accessible name all come from the browser, and its open list is
// drawn above the page rather than clipped by the panel it sits in. The open
// list cannot show the dots, which only the closed field has. content.css,
// .wlp-gselect and .wlp-gfield, has the look.
//
// dotOnly draws just the dot and the ▾, as the editor's event colour field
// does: the choice's name is still the select's value, so a screen reader and
// type-to-find have it, but it is not painted.
const FieldSelect: React.FC<{
  value: string | number;
  label: string;
  onChange: (value: string) => void;
  dot?: string;
  dotOnly?: boolean;
  title?: string;
  className?: string;
  autoFocus?: boolean;
  onFocus?: () => void;
  children: React.ReactNode;
}> = ({ value, label, onChange, dot, dotOnly, title, className, autoFocus, onFocus, children }) => (
  <span
    className={`wlp-gselect${dot ? ' wlp-gselect-has-dot' : ''}${dotOnly ? ' wlp-gselect-dot-only' : ''}${
      className ? ` ${className}` : ''
    }`}
  >
    {dot && <span aria-hidden="true" className="wlp-gselect-dot" style={{ backgroundColor: dot }} />}
    <select
      value={value}
      title={title}
      aria-label={label}
      autoFocus={autoFocus}
      onFocus={onFocus}
      onChange={(e) => onChange(e.target.value)}
      className="wlp-gfield"
    >
      {children}
    </select>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="wlp-gselect-caret">
      <path d="M7 10l5 5 5-5z"/>
    </svg>
  </span>
);

// ── Item template panel ──────────────────────────────────────────────────────
//
// Everything an item carries beyond its name and duration. Collapsed by
// default: the pool is meant to be scannable at 280px, so these fields never
// sit on the always-visible row.
//
// Laid out as the "Event details" of Google's event editor: an icon column on
// the left, then location, the notification, the event colour beside the
// calendar, and the description, each a grey field. Every change is saved as
// it is made, as before, so there is no Save button. A quiet "Saved" by the
// Duplicate button says so, since a panel with no Save button otherwise gives
// no sign that anything was kept (M8 U23).

const DetailsIcon: React.FC<{ path: string }> = ({ path }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="wlp-details-icon">
    <path d={path}/>
  </svg>
);

const ICON_LOCATION = 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z';
const ICON_BELL = 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z';
const ICON_CALENDAR = 'M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-1V1h-2zm3 18H5V8h14v11z';
const ICON_NOTES = 'M14 17H4v2h10v-2zm6-8H4v2h16V9zM4 15h16v-2H4v2zM4 5v2h16V5H4z';

// The editor's notification row, "30 | minutes ▾ | ×", for reminderMin. An
// item with no reminderMin leaves the event on the calendar's own default
// notifications, which is not the same as none, so that state shows "Add
// notification" rather than an empty row; × goes back to it. Google's first
// field, Notification or Email, is left out: the sidebar only ever sets a
// popup, and the row would not fit the rail with it.
//
// The count and unit are kept here while they are typed, so 60 in minutes
// stays "60 minutes" rather than jumping to "1 hours" under the caret. They
// are read again from the item when its reminder changes elsewhere, another
// machine or tab, and when the field is left holding something that was not
// stored, empty or past the four weeks the Calendar API allows.
//
// onChange is told when a change came from typing in the count, so the panel
// can wait for a pause before it says "Saved".
const NotificationRow: React.FC<{
  item: PoolItem;
  onChange: (patch: Partial<PoolItem>, typing?: boolean) => void;
}> = ({ item, onChange }) => {
  const min = item.reminderMin;
  const [count, setCount] = useState(() => String(min === undefined ? DEFAULT_REMINDER_MIN : splitReminder(min).count));
  const [unit, setUnit] = useState<ReminderUnit>(() => (min === undefined ? 'minutes' : splitReminder(min).unit));
  const countRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // Adding a notification and removing it each replace the control that was
  // clicked, so focus is moved to the one that takes its place.
  const focusNext = useRef<'count' | 'add' | null>(null);

  const shows = (c: string, u: ReminderUnit) => c.trim() !== '' && Number(c) * reminderUnitMin(u) === min;

  const showStored = () => {
    if (min === undefined) return;
    const s = splitReminder(min);
    setCount(String(s.count));
    setUnit(s.unit);
  };

  useEffect(() => {
    if (!shows(count, unit)) showStored();
  }, [min]);

  useEffect(() => {
    if (focusNext.current === 'count') countRef.current?.focus();
    if (focusNext.current === 'add')   addRef.current?.focus();
    focusNext.current = null;
  });

  const store = (c: string, u: ReminderUnit, typing = false) => {
    const n = Number(c);
    if (c.trim() === '' || !Number.isInteger(n) || n < 0) return;
    onChange({ reminderMin: Math.min(n * reminderUnitMin(u), MAX_REMINDER_MIN) }, typing);
  };

  const add = () => {
    focusNext.current = 'count';
    setCount(String(DEFAULT_REMINDER_MIN));
    setUnit('minutes');
    onChange({ reminderMin: DEFAULT_REMINDER_MIN });
  };

  const remove = () => {
    focusNext.current = 'add';
    onChange({ reminderMin: undefined });
  };

  return (
    <div className="wlp-details-row">
      <DetailsIcon path={ICON_BELL} />
      {min === undefined ? (
        <button
          ref={addRef}
          type="button"
          onClick={add}
          aria-label={`Add notification for ${item.name}`}
          title="Until you add one, the event gets the calendar’s default notifications"
          className="wlp-btn-text"
        >
          Add notification
        </button>
      ) : (
        <>
          <input
            ref={countRef}
            type="number"
            inputMode="numeric"
            min={0}
            max={Math.floor(MAX_REMINDER_MIN / reminderUnitMin(unit))}
            step={1}
            value={count}
            aria-label={`Notification for ${item.name}`}
            title="How long before the event"
            onChange={(e) => { setCount(e.target.value); store(e.target.value, unit, true); }}
            onBlur={() => { if (!shows(count, unit)) showStored(); }}
            className="wlp-gfield wlp-notify-count"
          />
          <FieldSelect
            value={unit}
            label={`Notification unit for ${item.name}`}
            onChange={(v) => { const u = v as ReminderUnit; setUnit(u); store(count, u); }}
          >
            {REMINDER_UNITS.map((u) => (
              <option key={u.unit} value={u.unit}>{u.unit}</option>
            ))}
          </FieldSelect>
          <button
            type="button"
            onClick={remove}
            aria-label={`Use the default notification for ${item.name}`}
            title="Use the calendar’s default notifications"
            className="wlp-btn-icon"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </>
      )}
    </div>
  );
};

// How long "Saved" stays, fade included, and how long typing in a text field
// has to pause before it shows.
const SAVED_SHOW_MS         = 1500;
const SAVED_TYPING_PAUSE_MS = 800;

const ItemDetails: React.FC<{
  item: PoolItem;
  categoryName: string;
  categoryColor: string;
  onChange: (patch: Partial<PoolItem>) => void;
  onDuplicate: () => void;
}> = ({ item, categoryName, categoryColor, onChange, onDuplicate }) => {
  // A colorId this version does not know still has to be a choice, or the
  // select would show "Calendar colour" for an item that sends another.
  const knownColor = !item.colorId || EVENT_COLORS.some((c) => c.id === item.colorId);

  // "Saved" shows as soon as updateItem has the change: the effect that runs
  // on the same render writes it to this device's copy of the pool, and sync
  // follows within seconds (poolStore.ts), so there is no later moment that
  // would be truer to wait for. A pick from a select, or adding or removing
  // the notification, says it at once. A text field, the notification's count
  // among them, stores on every key, so it waits for typing to pause, or for
  // focus to leave the field, rather than flickering with each letter. Only
  // changes made here say it, not an edit that arrives from another machine.
  // savedKey restarts the fade when a second change comes while the first
  // "Saved" is still showing.
  const [saved, setSaved] = useState(false);
  const [savedKey, setSavedKey] = useState(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSaved = () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setSaved(true);
    setSavedKey((k) => k + 1);
    hideTimer.current = setTimeout(() => setSaved(false), SAVED_SHOW_MS);
  };

  const change = (patch: Partial<PoolItem>, typing = false) => {
    onChange(patch);
    if (!typing) { showSaved(); return; }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(showSaved, SAVED_TYPING_PAUSE_MS);
  };

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, []);

  return (
    // Focus leaving any field brings forward a "Saved" that typing was
    // waiting on; React's onBlur bubbles, so one handler covers them all.
    <div className="wlp-item-details" onBlur={() => { if (typingTimer.current) showSaved(); }}>
      <div className="wlp-details-row">
        <DetailsIcon path={ICON_LOCATION} />
        <input
          type="text"
          dir="auto"
          placeholder="Add location"
          aria-label={`Location for ${item.name}`}
          value={item.location ?? ''}
          onChange={(e) => change({ location: e.target.value }, true)}
          className="wlp-gfield"
        />
      </div>

      <NotificationRow item={item} onChange={change} />

      {/* The editor's calendar and colour pair: the calendar is shown, not
          chosen, since an item changes calendar by being dragged into
          another section; the colour is the editor's "● ▾". No colorId means
          "whatever colour the calendar uses", which is what every item did
          before this panel existed, and a change repaints the chip at once. */}
      <div className="wlp-details-row">
        <DetailsIcon path={ICON_CALENDAR} />
        <span dir="auto" className="wlp-details-calendar" title={categoryName}>{categoryName}</span>
        <FieldSelect
          value={item.colorId ?? ''}
          label={`Colour for ${item.name}`}
          title="Event colour"
          dot={eventColorHex(item.colorId, categoryColor)}
          dotOnly
          onChange={(v) => change({ colorId: v === '' ? undefined : v })}
          className="wlp-color-select"
        >
          <option value="">Calendar colour</option>
          {!knownColor && <option value={item.colorId}>Colour {item.colorId}</option>}
          {EVENT_COLORS.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </FieldSelect>
      </div>

      <div className="wlp-details-row wlp-details-row-top">
        <DetailsIcon path={ICON_NOTES} />
        <textarea
          rows={3}
          dir="auto"
          placeholder="Add description"
          aria-label={`Description for ${item.name}`}
          value={item.description ?? ''}
          onChange={(e) => change({ description: e.target.value }, true)}
          className="wlp-gfield"
        />
      </div>

      <div className="wlp-details-actions">
        {/* Always in the panel, empty at rest, so a screen reader is already
            watching it when "Saved" is put in, and says it without moving
            focus. Removing the text after the fade is not announced. */}
        <span role="status" aria-live="polite" className="wlp-details-saved">
          {saved && (
            <span key={savedKey} className="wlp-details-saved-mark">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
              Saved
            </span>
          )}
        </span>
        <button type="button" onClick={onDuplicate} title="Duplicate item" className="wlp-btn-text">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/>
          </svg>
          Duplicate
        </button>
      </div>
    </div>
  );
};

// ── Schedule form ────────────────────────────────────────────────────────────
//
// The way to put an item on the calendar without dragging it. It offers the
// days the time grid is showing, so it schedules into the week the user is
// looking at, and falls back to the coming seven days when there is no time
// grid to read (month or schedule view). Whatever it picks goes through the
// same create path as a drop.
//
// "Today" and "now" are Google Calendar's, read in the zone its grid is drawn
// in, so the form agrees with the grid when that is not the computer's zone.
// They are read once per render, as new Date() was, and handed down.

const QUARTER_HOURS = Array.from({ length: 24 * 4 }, (_, i) => i * 15);
const LAST_START_MIN = QUARTER_HOURS[QUARTER_HOURS.length - 1];

function scheduleDays(today: Date): Date[] {
  const shown = visibleTimeGridDays();
  if (shown.length > 0) return shown;
  return Array.from({ length: 7 }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
}

function defaultDay(days: Date[], today: Date): Date {
  return days.find((d) => isSameDay(d, today)) ?? days[0];
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// The weekday is dropped for today so the label still fits the 280px rail.
function dayLabel(d: Date, today: Date): string {
  return isSameDay(d, today)
    ? `Today, ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// The weekly option says which weekday the series falls on, as Google's
// "Weekly on Sunday" does: a weekly RRULE repeats on the start's weekday.
// Written in English, like every other label here.
function repeatLabel(d: Date | undefined): string {
  return d ? `Weekly on ${d.toLocaleDateString('en-US', { weekday: 'long' })}` : 'Weekly';
}

// The soonest quarter hour that has not started yet. Late in the evening that
// would be tomorrow, which the day choice says otherwise, so it stops at the
// last slot of the day instead of wrapping.
function nextQuarterHour(nowMin: number): number {
  return Math.min(Math.ceil(nowMin / 15) * 15, LAST_START_MIN);
}

const ScheduleForm: React.FC<{
  id: string;
  item: PoolItem;
  onSchedule: (date: Date, startMin: number, recurring: boolean) => void;
  onCancel: () => void;
}> = ({ id, item, onSchedule, onCancel }) => {
  const now = calendarNow(gridZoneLabels());
  const [days, setDays] = useState(() => scheduleDays(now.date));
  const [dayValue, setDayValue] = useState(() => dayKey(defaultDay(days, now.date)));
  const [startMin, setStartMin] = useState(() => nextQuarterHour(now.minutes));
  const [recurring, setRecurring] = useState(false);

  // Google Calendar can move to another week while the form is open, so the
  // days are read again each time the day choice gets focus. The chosen day
  // survives when the new week still shows it.
  const refreshDays = () => {
    const today = calendarNow(gridZoneLabels()).date;
    const next = scheduleDays(today);
    setDays(next);
    if (!next.some((d) => dayKey(d) === dayValue)) setDayValue(dayKey(defaultDay(next, today)));
  };

  const submit = () => {
    const date = days.find((d) => dayKey(d) === dayValue);
    if (date) onSchedule(date, startMin, recurring);
  };

  return (
    <form
      id={id}
      aria-label={`Schedule ${item.name}`}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      // Browsers only submit on Enter from a text field, and this form has
      // none, so Enter on any of its selects schedules too. A button
      // keeps its own Enter, so Cancel still cancels. A held Enter is ignored:
      // the press that picked the item would otherwise repeat into the day
      // choice it focused and schedule straight away.
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.repeat || (e.target as HTMLElement).tagName === 'BUTTON') return;
        e.preventDefault();
        submit();
      }}
      className="wlp-schedule"
    >
      {/* The editor's date row: the day and the start time as grey fields,
          then "Does not repeat ▾" under them. No captions over the fields, as
          the editor has none; each select is still named Day and Start. */}
      <div className="wlp-schedule-row">
        <FieldSelect
          autoFocus
          value={dayValue}
          label="Day"
          onFocus={refreshDays}
          onChange={setDayValue}
          className="wlp-schedule-day"
        >
          {days.map((d) => (
            <option key={dayKey(d)} value={dayKey(d)}>{dayLabel(d, now.date)}</option>
          ))}
        </FieldSelect>
        <FieldSelect
          value={startMin}
          label="Start"
          onChange={(v) => setStartMin(Number(v))}
        >
          {QUARTER_HOURS.map((min) => (
            <option key={min} value={min}>{formatTime(Math.floor(min / 60), min % 60)}</option>
          ))}
        </FieldSelect>
      </div>
      {/* It replaces the Repeat weekly box and creates the same series, an
          RRULE with no end, which repeats on the chosen day's weekday; the
          option says which, and follows the day choice. */}
      <div className="wlp-schedule-row">
        <FieldSelect
          value={recurring ? 'weekly' : 'none'}
          label="Repeat"
          onChange={(v) => setRecurring(v === 'weekly')}
        >
          <option value="none">Does not repeat</option>
          <option value="weekly">{repeatLabel(days.find((d) => dayKey(d) === dayValue))}</option>
        </FieldSelect>
      </div>
      <p className="wlp-schedule-hint">Or click a time slot. Shift-click repeats weekly.</p>
      <div className="wlp-schedule-actions">
        <button type="button" onClick={onCancel} className="wlp-btn-text">Cancel</button>
        <button type="submit" className="wlp-btn-filled">Schedule</button>
      </div>
    </form>
  );
};

const PoolSidebar: React.FC = () => {
  const [categories, setCategories] = useState<PoolCategory[]>([]);
  const [newItemName, setNewItemName] = useState('');
  const [newItemCategory, setNewItemCategory] = useState('');
  const [newItemDuration, setNewItemDuration] = useState(DEFAULT_DURATION_MIN);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [layoutReady, setLayoutReady] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [besideNav, setBesideNav] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [primaryLookup, setPrimaryLookup] = useState<PrimaryLookup | null>(null);
  const primaryName = useRef<PrimaryName | null>(null);
  const collapsedReady = useRef(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const focusToggle = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastDeadline = useRef(0);
  const toastRemaining = useRef<number | null>(null);
  const toastArea = useRef<HTMLDivElement>(null);
  const cancelledRename = useRef(false);
  const scheduleButtons = useRef(new Map<string, HTMLButtonElement>());
  const importInput = useRef<HTMLInputElement>(null);

  // Hover and focus are read from the DOM when needed rather than tracked from
  // enter and leave events: the toast's content is swapped out from under the
  // pointer and the focus (Undo replaces itself with "Removing…"), and a
  // missed leave would otherwise hold a toast on screen for good.
  const toastEngaged = () => {
    const el = toastArea.current;
    return el !== null && (el.matches(':hover') || el.contains(document.activeElement));
  };

  const startToastTimer = (ms: number) => {
    toastTimer.current = setTimeout(() => setToast(null), ms);
    toastDeadline.current = Date.now() + ms;
  };

  // One timer for every toast source, so a pending clear from an earlier toast
  // cannot wipe a newer one. A toast that arrives under the pointer or focus
  // starts out paused.
  const showToast = (message: string, type: Toast['type'], holdMs = 3000, undo?: UndoTarget) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
    toastRemaining.current = null;
    setToast({ message, type, undo });
    if (holdMs <= 0) return;
    if (toastEngaged()) toastRemaining.current = holdMs;
    else startToastTimer(holdMs);
  };

  const pauseToast = () => {
    if (!toastTimer.current) return;
    clearTimeout(toastTimer.current);
    toastTimer.current = null;
    toastRemaining.current = Math.max(0, toastDeadline.current - Date.now());
  };

  // Deferred a tick because a leave or blur is often a move to another part of
  // the toast, and by then :hover and activeElement say where it ended up.
  const resumeToast = () => {
    setTimeout(() => {
      if (toastRemaining.current === null || toastEngaged()) return;
      const ms = Math.max(toastRemaining.current, TOAST_RESUME_MIN_MS);
      toastRemaining.current = null;
      startToastTimer(ms);
    }, 0);
  };

  // Deletes the event the last drop created. A recurring event's id is the
  // series, so its Undo removes every instance, and the toast says so.
  // Undo replaces itself with "Removing…", and a focused element that goes
  // away leaves focus on the page body, so a keyboard user is moved first: to
  // the item's schedule button, the natural place to try again, or to the
  // toast region when that row is gone. A click focuses the button too, but
  // not :focus-visible, and a pointer user is left alone.
  //
  // On the toast region, focus holds every toast that follows, the way it
  // does on Undo itself, until it moves on.
  const keepUndoFocus = (button: HTMLElement, target: UndoTarget) => {
    if (!button.matches(':focus-visible')) return;
    const row = target.itemId ? scheduleButtons.current.get(target.itemId) : undefined;
    (row ?? toastArea.current)?.focus();
  };

  const undoDrop = (target: UndoTarget, button: HTMLElement) => {
    keepUndoFocus(button, target);
    const fail = (err?: string) => showToast(err ?? 'Failed to remove event', 'error', 5000);
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
      fail('Extension reloaded - refresh the page');
      return;
    }

    const name = isolate(target.itemName);
    showToast(`Removing "${name}"…`, 'info', 0);
    try {
      chrome.runtime.sendMessage(
        { type: 'DELETE_EVENT', data: { calendarId: target.calendarId, eventId: target.eventId } },
        (response) => {
          if (chrome.runtime.lastError) { fail(chrome.runtime.lastError.message); return; }
          if (!response?.success)       { fail(response?.error); return; }
          showToast(
            target.recurring ? `Weekly series "${name}" removed` : `"${name}" removed`,
            'success'
          );
          document.dispatchEvent(new CustomEvent('poolEventRemoved', { detail: { eventId: target.eventId } }));
        }
      );
    } catch {
      // sendMessage throws rather than reporting when the extension was
      // reloaded underneath this page.
      fail('Extension reloaded - refresh the page');
    }
  };

  // ── Collapsed state ──────────────────────────────────────────────────────────
  //
  // collapsed is the user's choice, kept on this device. What shows can differ
  // from it while Google's own main menu is open: the pool then steps aside to
  // its strip, so the week is not squeezed between two sidebars, and Google's
  // nav takes nearly the room the pool gives up, so the grid barely moves
  // while the two swap. One sidebar at a time, as Google's own side panels
  // are. Opening the pool from the strip while the menu is open keeps it open
  // beside the menu until the menu closes. None of that is saved: when the
  // menu closes, the user's own choice shows again.

  const shownCollapsed = collapsed || (navOpen && !besideNav);

  // Earlier versions also kept whether the add form was open, under formOpen.
  // The composer no longer closes, so that key is never read, and it is
  // removed so a closed form stored long ago leaves nothing behind.
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    chrome.storage.local.get<StoredState>('sidebarCollapsed', (result) => {
      collapsedReady.current = true;
      setCollapsed(result.sidebarCollapsed === true);
      setLayoutReady(true);
    });
    chrome.storage.local.remove('formOpen');
  }, []);

  useEffect(() => {
    if (!collapsedReady.current) return;
    if (extensionAlive()) {
      chrome.storage.local.set({ sidebarCollapsed: collapsed });
    }
  }, [collapsed]);

  // content.tsx makes room on the page for what shows. The menu can be read
  // as open before the stored choice arrives, so this also runs once that
  // arrives, even when what shows has not changed.
  useEffect(() => {
    if (!layoutReady) return;
    document.dispatchEvent(new CustomEvent('poolSidebarToggle', { detail: { collapsed: shownCollapsed } }));
  }, [shownCollapsed, layoutReady]);

  // A change of the menu, either way, ends an opening of the pool beside it.
  // If focus was in the sidebar, it is about to lose the control it was on,
  // so it is given the toggle that takes that control's place.
  useEffect(() => watchGoogleNav((open) => {
    if (sidebarRef.current?.contains(document.activeElement)) focusToggle.current = true;
    setNavOpen(open);
    setBesideNav(false);
  }), []);

  // Showing the strip ends a pick, as the schedule form it was in is gone.
  useEffect(() => {
    if (shownCollapsed) setPickedId(null);
  }, [shownCollapsed]);

  // Hiding or showing the sidebar removes the button that did it, and focus
  // with it, so focus goes to the button now in its place: the strip's
  // chevron, or the header's. Only when focus was in fact lost, so a change of
  // the menu that leaves the sidebar as it was never pulls focus out of the
  // field being typed in.
  useEffect(() => {
    if (!focusToggle.current) return;
    focusToggle.current = false;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (shownCollapsed ? showButton : hideButton).current?.focus();
  });

  const showSidebar = () => {
    focusToggle.current = true;
    setCollapsed(false);
    if (navOpen) setBesideNav(true);
  };

  const hideSidebar = () => {
    focusToggle.current = true;
    setCollapsed(true);
  };

  // ── Drop toast listener ──────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: Event) => {
      const { type, itemName, error: err, recurring, event } = (e as CustomEvent).detail;
      // The name is isolated so a Hebrew one keeps its own order without
      // turning the English sentence around it.
      const name = isolate(itemName);
      if (type === 'creating') {
        showToast(`Adding "${name}"${recurring ? ' weekly' : ''}…`, 'info', 0);

      } else if (type === 'created') {
        const message = recurring ? `"${name}" added, repeats weekly` : `"${name}" added!`;
        // Without an id there is nothing to delete, so the toast is the old one.
        if (event) showToast(message, 'success', UNDO_WINDOW_MS, { itemName, ...event });
        else       showToast(message, 'success');
      } else if (type === 'error') {
        showToast(err ?? 'Failed to create event', 'error', 5000);
      }
    };
    document.addEventListener('poolEvent', handler);
    return () => {
      document.removeEventListener('poolEvent', handler);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // Any end to a drag clears the insertion marker. dragend alone is not enough:
  // it does not fire on the source row when the drop lands outside the sidebar.
  useEffect(() => {
    const clear = () => { setDropTarget(null); setDraggingId(null); };
    document.addEventListener('poolDragEnd', clear);
    document.addEventListener('drop', clear);
    return () => {
      document.removeEventListener('poolDragEnd', clear);
      document.removeEventListener('drop', clear);
    };
  }, []);


  // ── Picked item ──────────────────────────────────────────────────────────────
  //
  // Picking an item opens its schedule form and, at the same time, lets a click
  // on the time grid place it (content.tsx does the placing). Only one item is
  // picked at a time; picking it again, Escape, a drag or collapsing the
  // sidebar puts it back.

  // Focus returns to the item's schedule button only when it was in the form,
  // so an Escape pressed while working in Google Calendar does not pull focus
  // into the sidebar.
  const closePick = (id: string) => {
    const returnFocus = document.activeElement?.closest('.wlp-schedule') != null;
    setPickedId(null);
    if (returnFocus) scheduleButtons.current.get(id)?.focus();
  };

  // The content script creates the event the same way a drop does, so the
  // toast, Undo and the weekly wording all follow without anything here.
  const scheduleItem = (item: PoolItem, color: string, date: Date, startMin: number, recurring: boolean) => {
    document.dispatchEvent(new CustomEvent('poolScheduleItem', {
      detail: {
        item: { ...item, color },
        date,
        hours: Math.floor(startMin / 60),
        minutes: startMin % 60,
        recurring,
      },
    }));
    closePick(item.id);
  };

  // Tells the content script what a click on the grid would place, with the
  // calendar colour a drag would carry. Deleting the item or folding its
  // calendar's section ends the pick rather than leaving an invisible item
  // armed.
  useEffect(() => {
    let payload: (PoolItem & { color: string }) | null = null;
    for (const cat of categories) {
      const item = cat.hidden ? undefined : cat.items.find((i) => i.id === pickedId);
      if (item) payload = { ...item, color: cat.color };
    }
    if (pickedId && !payload) { setPickedId(null); return; }
    document.dispatchEvent(new CustomEvent('poolPickChange', { detail: { item: payload } }));
  }, [pickedId, categories]);

  // Escape is caught on window in the capture phase so it works wherever focus
  // is, Google Calendar's own widgets included. It is not stopped, so whatever
  // Google Calendar does with Escape still happens.
  useEffect(() => {
    if (!pickedId) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closePick(pickedId); };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [pickedId]);

  // A click on the grid used the pick up, or the view left Week and Day view.
  useEffect(() => {
    const done = () => setPickedId(null);
    document.addEventListener('poolPickDone', done);
    return () => document.removeEventListener('poolPickDone', done);
  }, []);

  // ── Calendar fetch ───────────────────────────────────────────────────────────
  //
  // The list is fetched when the sidebar mounts and again whenever Google's own
  // list changes (below). The first fetch shows the loading and error states.
  // A later one is quiet: if it fails the list stays as it was, and a calendar
  // still in the list keeps its items, its fold and the composer's choice of
  // it, so a refresh never disturbs what is being done in the sidebar.

  const fetchCalendars = (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setFetchError(null);
    }
    const fail = (message: string) => {
      if (quiet) { console.warn('[Usuals] Could not refresh the calendar list:', message); return; }
      setFetchError(message);
      setLoading(false);
    };

    if (typeof chrome === 'undefined' || !chrome.runtime) {
      fail('Chrome extension API not available');
      return;
    }
    if (!extensionAlive()) {
      fail('Extension reloaded - refresh the page');
      return;
    }

    chrome.runtime.sendMessage({ type: 'LIST_CALENDARS' }, (response) => {
      if (chrome.runtime.lastError) {
        fail(chrome.runtime.lastError.message ?? 'Failed to connect');
        return;
      }
      if (!response?.success) {
        fail(response?.error ?? 'Failed to fetch calendars');
        return;
      }

      // The primary calendar's zone is the user's Calendar time zone, which
      // the grid is drawn in and every event is created in (calendarZone.ts).
      const items: CalendarListEntry[] = response.data.items ?? [];
      setPrimaryTimeZone(items.find((cal) => cal.primary)?.timeZone);

      // The calendar.events.owned scope can only write to calendars the user
      // owns. A merely subscribed calendar — shared, team, holidays — would
      // render as a drop target and then 403 on drop, so it never becomes a
      // category.
      const entries = items.filter((cal) => cal.accessRole === 'owner');

      // Every calendar goes by the name Google's own list gives it. The
      // primary one may only have its address from the API, so its name is
      // looked for on the page, and until it is found (or if it never is)
      // the address stands. A name found on an earlier load is used at once.
      const primary = entries.find(needsPageName);
      const nameOf = (cal: CalendarListEntry) =>
        primaryName.current?.calendarId === cal.id ? primaryName.current.name : displayName(cal);
      const lookup = primary ? {
        calendarId: primary.id,
        otherNames: items.filter((cal) => cal !== primary && !cal.hidden).map(displayName),
      } : null;
      // An unchanged lookup keeps the watcher it already started.
      setPrimaryLookup((prev) =>
        prev && lookup && prev.calendarId === lookup.calendarId
          && prev.otherNames.join('\n') === lookup.otherNames.join('\n') ? prev : lookup
      );

      // Items stored under a calendar that is not in this list, say one from
      // the Google account another machine is signed into, are not shown but
      // stay in storage: poolStore only replaces the calendars passed to it.
      loadPool().then(
        (pool) => {
          setCategories((prev) => {
            const kept = new Map(prev.map((cat) => [cat.calendarId, cat]));
            return entries.map((cal): PoolCategory => {
              const old = quiet ? kept.get(cal.id) : undefined;
              return {
                calendarId: cal.id,
                name: nameOf(cal),
                color: cal.backgroundColor ?? '#4285f4',
                items: old ? old.items : pool.items[cal.id] ?? [],
                hidden: old ? old.hidden : pool.hidden.includes(cal.id),
              };
            });
          });
          setNewItemCategory((current) => {
            if (quiet && entries.some((cal) => cal.id === current)) return current;
            const firstVisible = entries.find((cal) => !pool.hidden.includes(cal.id));
            return (firstVisible ?? entries[0])?.id ?? '';
          });
          setLoaded(true);
          setLoading(false);
          setFetchError(null);
        },
        (err) => fail(`Could not read the pool: ${err instanceof Error ? err.message : String(err)}`)
      );
    });
  };

  useEffect(() => { fetchCalendars(); }, []);

  // A calendar created, deleted, renamed or recoloured in Google Calendar shows
  // in Google's own list, which names.ts watches. Coming back to the tab also
  // fetches again, at most once a minute, for a change made in another tab or
  // on a phone while this one was in the background.
  useEffect(() => {
    let lastVisibleFetch = Date.now();
    const stop = watchCalendarList(() => fetchCalendars(true));
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastVisibleFetch < VISIBLE_REFETCH_MS) return;
      lastVisibleFetch = Date.now();
      fetchCalendars(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  // The primary calendar's name, from this device's last reading and then
  // from the page (names.ts, watchPrimaryName), which keeps looking until
  // Google's list is there to read. A fresh reading replaces the stored one.
  useEffect(() => {
    if (!primaryLookup) return;
    const { calendarId, otherNames } = primaryLookup;
    let active = true;

    const apply = (name: string) => {
      if (!active) return;
      primaryName.current = { calendarId, name };
      setCategories((prev) =>
        prev.map((cat) => (cat.calendarId === calendarId && cat.name !== name ? { ...cat, name } : cat))
      );
    };

    if (extensionAlive()) {
      chrome.storage.local.get<StoredState>('primaryCalendarName', (result) => {
        const stored = result.primaryCalendarName;
        if (stored?.calendarId === calendarId && primaryName.current?.calendarId !== calendarId) apply(stored.name);
      });
    }

    const stop = watchPrimaryName(calendarId, otherNames, (name) => {
      apply(name);
      if (extensionAlive()) chrome.storage.local.set({ primaryCalendarName: { calendarId, name } });
    });
    return () => { active = false; stop(); };
  }, [primaryLookup]);

  // Only persist when loaded and non-empty to avoid wiping items on auth hiccups.
  // poolStore compares against what it holds, so a render that changed nothing
  // in the pool, including one that applied another machine's edit, writes
  // nothing.
  useEffect(() => {
    if (!loaded || categories.length === 0) return;
    const items: Record<string, PoolItem[]> = {};
    const hidden: string[] = [];
    categories.forEach((cat) => {
      items[cat.calendarId] = cat.items;
      if (cat.hidden) hidden.push(cat.calendarId);
    });
    savePool({ items, hidden });
  }, [categories, loaded]);

  // An edit on another machine or in another Calendar tab. Only items and the
  // hidden flags are replaced; rows are keyed by item id, so an open rename,
  // details panel or schedule form stays open through a change to some other
  // item. An item deleted elsewhere takes its own open form with it, and a
  // pick on it ends as it would for a local delete.
  useEffect(() => {
    const stopChanges = subscribePool((pool) => {
      setCategories((prev) =>
        prev.map((cat) => ({
          ...cat,
          items: pool.items[cat.calendarId] ?? [],
          hidden: pool.hidden.includes(cat.calendarId),
        }))
      );
    });
    const stopSyncFull = onSyncFull(() => showToast(SYNC_FULL_MESSAGE, 'info', SYNC_FULL_HOLD_MS));
    return () => { stopChanges(); stopSyncFull(); };
  }, []);

  // ── Export and import ────────────────────────────────────────────────────────
  //
  // The whole pool to a JSON file, and a file's usuals back in (poolTransfer.ts).
  // An import only adds: usuals already here, by id, are left as they are.

  const exportUsuals = () => {
    loadPool().then(
      (pool) => {
        const names = Object.fromEntries(categories.map((cat) => [cat.calendarId, cat.name]));
        const { text, count } = buildExport(pool, names);
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = exportFileName();
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        showToast(`Exported ${count} usual${count === 1 ? '' : 's'}`, 'success');
      },
      (err) => showToast(`Could not export: ${err instanceof Error ? err.message : String(err)}`, 'error', 5000)
    );
  };

  const importUsuals = async (file: File) => {
    try {
      const { pool, skipped } = parseExport(await file.text());
      const added = mergePool(pool);
      const shown = new Set(categories.map((cat) => cat.calendarId));
      const elsewhere = added.filter((item) => !shown.has(item.calendarId)).length;
      const parts = [
        added.length === 0 ? 'Nothing new to import' : `Imported ${added.length} usual${added.length === 1 ? '' : 's'}`,
      ];
      if (elsewhere > 0) parts.push(`${elsewhere} for calendars this account doesn't have, kept but not shown`);
      if (skipped > 0) parts.push(`${skipped} unreadable, skipped`);
      showToast(parts.join(' · '), added.length > 0 ? 'success' : 'info', 6000);
    } catch (err) {
      const message = err instanceof ImportError ? err.message
        : `Could not import: ${err instanceof Error ? err.message : String(err)}`;
      showToast(message, 'error', 6000);
    }
  };

  // ── Item management ──────────────────────────────────────────────────────────

  // A calendar that receives an item, from the form or a drag, unfolds, so
  // the item the user just placed is on screen rather than folded away.
  const addItem = () => {
    if (!newItemName.trim() || !newItemCategory) return;
    setCategories((prev) =>
      prev.map((cat) =>
        cat.calendarId === newItemCategory
          ? {
              ...cat,
              hidden: false,
              items: [
                ...cat.items,
                {
                  id: newItemId(),
                  name: newItemName.trim(),
                  calendarId: newItemCategory,
                  durationMin: newItemDuration,
                },
              ],
            }
          : cat
      )
    );
    setNewItemName('');
    inputRef.current?.focus();
  };

  // One updater for every per-item field, so duration, rename and the template
  // panel do not each need their own walk over the category array.
  const updateItem = (id: string, patch: Partial<PoolItem>) => {
    setCategories((prev) =>
      prev.map((cat) => ({
        ...cat,
        items: cat.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      }))
    );
  };

  const deleteItem = (id: string) => {
    setCategories((prev) =>
      prev.map((cat) => ({ ...cat, items: cat.items.filter((item) => item.id !== id) }))
    );
    if (expandedId === id) setExpandedId(null);
    if (editingId  === id) setEditingId(null);
  };

  // The copy lands directly under the original and keeps every template field —
  // configure one item well, then clone it. The name gets a suffix because two
  // identically named items resolve each other's drop placeholder.
  const duplicateItem = (id: string) => {
    setCategories((prev) =>
      prev.map((cat) => {
        const index = cat.items.findIndex((item) => item.id === id);
        if (index === -1) return cat;
        const copy = { ...cat.items[index], id: newItemId(), name: `${cat.items[index].name} copy` };
        const items = [...cat.items];
        items.splice(index + 1, 0, copy);
        return { ...cat, items };
      })
    );
  };

  // Array order is the persisted order, so a move is just a splice — no schema
  // change. Dropping an item into its own gap is a no-op rather than a move
  // into the slot that opens up once it is removed.
  const moveItem = (id: string, toCalendarId: string, toIndex: number) => {
    setCategories((prev) => {
      const source = prev.find((cat) => cat.items.some((item) => item.id === id));
      if (!source) return prev;
      const fromIndex = source.items.findIndex((item) => item.id === id);
      const moved = source.items[fromIndex];

      const sameCategory = source.calendarId === toCalendarId;
      if (sameCategory && (toIndex === fromIndex || toIndex === fromIndex + 1)) return prev;
      const insertAt = sameCategory && fromIndex < toIndex ? toIndex - 1 : toIndex;

      return prev.map((cat) => {
        const items = cat.items.filter((item) => item.id !== id);
        if (cat.calendarId !== toCalendarId) {
          return items.length === cat.items.length ? cat : { ...cat, items };
        }
        const at = Math.max(0, Math.min(insertAt, items.length));
        return {
          ...cat,
          hidden: false,
          items: [...items.slice(0, at), { ...moved, calendarId: toCalendarId }, ...items.slice(at)],
        };
      });
    });
  };

  // Folds or unfolds a calendar's section. The flag syncs with the pool, as
  // hiding a calendar did, so a section folded on one computer is folded on
  // the others.
  const toggleSection = (calendarId: string) => {
    setCategories((prev) =>
      prev.map((cat) =>
        cat.calendarId === calendarId ? { ...cat, hidden: !cat.hidden } : cat
      )
    );
  };

  // An empty calendar's row sets the composer to that calendar and puts the
  // caret in its title, so adding the first item to it is one click and then
  // typing. That, and adding an item, which leaves the caret there for the
  // next one, are the only times the sidebar puts focus in the title: on load
  // it is left alone, so opening Google Calendar never takes the keyboard
  // away from Google's page.
  const startAddTo = (calendarId: string) => {
    setNewItemCategory(calendarId);
    inputRef.current?.focus();
  };

  // ── Rename ───────────────────────────────────────────────────────────────────

  const startRename = (item: PoolItem) => {
    cancelledRename.current = false;
    setEditingId(item.id);
    setEditingName(item.name);
  };

  // Enter and blur both commit, Escape does not. The flag is a ref rather than
  // state because unmounting the focused input can fire blur with the closure
  // from the render before Escape, which would otherwise commit the edit anyway.
  const cancelRename = () => {
    cancelledRename.current = true;
    setEditingId(null);
  };

  const commitRename = () => {
    if (!editingId || cancelledRename.current) return;
    const name = editingName.trim();
    if (name) updateItem(editingId, { name });
    setEditingId(null);
  };

  // ── Reorder drag ─────────────────────────────────────────────────────────────

  // Which half of the row the pointer is in decides whether the item lands
  // before or after it.
  const handleRowDragOver = (e: React.DragEvent, calendarId: string, index: number) => {
    if (!isReorderDrag(e)) return;
    e.preventDefault();
    markHandled(e);
    const rect = e.currentTarget.getBoundingClientRect();
    setDropTarget({
      calendarId,
      index: e.clientY > rect.top + rect.height / 2 ? index + 1 : index,
    });
  };

  // Aiming at a category itself — its header or its empty space — means "put it
  // in this calendar", which reassigns calendarId when it came from another one.
  const handleCategoryDragOver = (e: React.DragEvent, calendarId: string) => {
    if (!isReorderDrag(e)) return;
    e.preventDefault();
    markHandled(e);
    setDropTarget({ calendarId, index: 0 });
  };

  const handleListDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('poolReorder');
    if (!raw || !dropTarget) return;
    // The document-level drop listener creates calendar events. It already
    // ignores anything outside a gridcell, and stopping here keeps that true
    // however the sidebar's own drop zones grow.
    e.preventDefault();
    e.stopPropagation();
    try {
      const { id } = JSON.parse(raw) as { id: string };
      moveItem(id, dropTarget.calendarId, dropTarget.index);
    } catch {
      // Malformed payload — drop nothing rather than move the wrong item.
    }
    setDropTarget(null);
  };

  // ── Shared styles ────────────────────────────────────────────────────────────

  const sidebarCls = `wlp-sidebar flex flex-col z-[1000] overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] ${
    shownCollapsed ? 'w-[40px]' : 'w-[280px]'
  }`;

  const iconBtnCls =
    'wlp-icon-btn w-[28px] h-[28px] flex items-center justify-center rounded-full text-[var(--wlp-text-secondary)] cursor-pointer border-none bg-transparent hover:bg-[var(--wlp-hover)] transition-colors duration-150 shrink-0';

  const toastColors: Record<Toast['type'], string> = {
    info:    'bg-[var(--wlp-info-bg)] text-[var(--wlp-info-text)] border-[var(--wlp-info-border)]',
    success: 'bg-[var(--wlp-success-bg)] text-[var(--wlp-success-text)] border-[var(--wlp-success-border)]',
    error:   'bg-[var(--wlp-error-bg)] text-[var(--wlp-error-text)] border-[var(--wlp-error-border)]',
  };

  const renderToast = (t: Toast) => (
    <div
      className={`px-[16px] py-[9px] text-[12px] border-b flex items-center gap-[10px] ${toastColors[t.type]} [animation:wlp-fadein_200ms_ease]`}
    >
      <span className="flex-1 min-w-[0]">{t.message}</span>
      {t.undo && (
        <button
          onClick={(e) => undoDrop(t.undo!, e.currentTarget)}
          title={t.undo.recurring ? 'Remove the whole weekly series' : 'Remove this event'}
          className="wlp-toast-undo"
        >
          Undo
        </button>
      )}
    </div>
  );

  // Calendars with items get a section each, in Google's order; the empty
  // ones are gathered at the end as one quiet group of rows, rather than each
  // printing its own "No items yet" between the sections that have something.
  // Every calendar stays a choice in the form, a folded one included.
  const filledCategories = categories.filter((c) => c.items.length > 0);
  const emptyCategories  = categories.filter((c) => c.items.length === 0);
  const selectedCategory = categories.find((c) => c.calendarId === newItemCategory);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div ref={sidebarRef} className={sidebarCls}>

      {/* ── Collapsed strip ─────────────────────────────────────────────────── */}
      {shownCollapsed ? (
        <div className="flex flex-col items-center pt-[8px]">
          <button
            ref={showButton}
            onClick={showSidebar}
            title="Show Usuals"
            aria-label="Show Usuals"
            className={iconBtnCls}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/>
            </svg>
          </button>
        </div>
      ) : (
        /* ── Expanded view ────────────────────────────────────────────────── */
        <div className="wlp-column w-[280px]">

          {/* Header: the composer's first row, with the chevron that hides the
              sidebar at its end. There is no title and no "New item" button:
              the composer is always open, so its title is what the sidebar
              opens with, in a 64 px band level with Google Calendar's own top
              bar beside it, as "Add title" heads Google's event editor. The
              chevron shares that row rather than taking one of its own, which
              would be a band of nothing else. Until the calendars are loaded
              there is nothing to add to, and the chevron stands alone at the
              end. */}
          <div className="wlp-header">
            {!loading && !fetchError && (
              <>
                <div className="wlp-title-field">
                  <input
                    ref={inputRef}
                    type="text"
                    dir="auto"
                    placeholder="Add title"
                    aria-label="Title of new item"
                    aria-describedby="wlp-form-hint"
                    value={newItemName}
                    onChange={(e) => setNewItemName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addItem()}
                    className="wlp-title-input"
                  />
                  {newItemName && (
                    <button
                      onClick={() => { setNewItemName(''); inputRef.current?.focus(); }}
                      tabIndex={-1}
                      title="Clear"
                      aria-label="Clear"
                      className="wlp-input-clear"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                      </svg>
                    </button>
                  )}
                </div>
                <button
                  onClick={addItem}
                  disabled={!newItemName.trim()}
                  title="Add (Enter)"
                  aria-label="Add item"
                  className="wlp-btn-filled"
                >
                  Add
                </button>
              </>
            )}
            {/* Collapse sidebar */}
            <button
              ref={hideButton}
              onClick={hideSidebar}
              title="Hide sidebar"
              aria-label="Hide sidebar"
              className={`${iconBtnCls} wlp-header-hide`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/>
              </svg>
            </button>
          </div>

          {/* Loading */}
          {loading && (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-[13px] text-[var(--wlp-text-secondary)]">Loading…</p>
            </div>
          )}

          {/* Error */}
          {!loading && fetchError && (
            <div className="p-[16px] flex flex-col gap-[12px]">
              <p className="text-[13px] text-[var(--wlp-danger)]">{fetchError}</p>
              <button
                onClick={() => fetchCalendars()}
                className="px-[12px] py-[8px] bg-[var(--wlp-primary)] text-[var(--wlp-on-primary)] border-none rounded-[6px] text-[13px] font-[500] cursor-pointer hover:bg-[var(--wlp-primary-hover)] transition-colors duration-150"
              >
                Retry
              </button>
            </div>
          )}

          {/* Content (loaded) */}
          {!loading && !fetchError && (
            <>
              {/* The rest of the composer, in the words of Google's event
                  editor: under the title, the calendar and the duration as
                  grey fields. Always shown. In a window too short for it and
                  the list it gives way (.wlp-column) and scrolls rather than
                  cut off; the title row above stays in the header. */}
              <div className="wlp-composer wlp-scroll">

                {/* The calendar as Google's editor chooses one: a grey field
                    with the calendar's colour and its name. It replaces a
                    cloud of chips that grew a line for every few calendars.
                    Every calendar is a choice, a folded one included, and an
                    empty calendar's row sets it (startAddTo). */}
                <div className="wlp-form-row">
                  {categories.length > 0 && (
                    <FieldSelect
                      value={newItemCategory}
                      label="Calendar of new item"
                      title={selectedCategory?.name}
                      dot={selectedCategory?.color}
                      onChange={setNewItemCategory}
                      className="wlp-form-calendar"
                    >
                      {categories.map((cat) => (
                        <option key={cat.calendarId} value={cat.calendarId} dir="auto">{cat.name}</option>
                      ))}
                    </FieldSelect>
                  )}
                  <FieldSelect
                    value={newItemDuration}
                    label="Duration of new item"
                    title="Duration"
                    onChange={(v) => setNewItemDuration(Number(v))}
                  >
                    {durationOptions(newItemDuration).map((min) => (
                      <option key={min} value={min}>{formatDuration(min)}</option>
                    ))}
                  </FieldSelect>
                </div>

                {/* The two modifiers nothing else on screen mentions, kept
                    short and in the hint grey so they read as a footnote. */}
                <p id="wlp-form-hint" className="wlp-form-hint">
                  Shift-drop repeats weekly · Enter on an item’s calendar icon schedules it
                </p>

              </div>

              {/* Toast. A screen reader only announces a live region that was
                  already in the page when its text changed, so the status
                  region stays mounted and empty between toasts. An error goes
                  in a role="alert" instead, which is announced on insertion and
                  interrupts, since it means the event was not created. Both
                  sit in one plain wrapper that pauses the toast's timer. It
                  can take focus, though Tab never stops on it, for when Undo
                  has removed itself and the item's row is gone. */}
              <div
                ref={toastArea}
                tabIndex={-1}
                onMouseEnter={pauseToast}
                onMouseLeave={resumeToast}
                onFocus={pauseToast}
                onBlur={resumeToast}
                className="wlp-toast-area shrink-0"
              >
                <div role="status" aria-live="polite" aria-atomic="true">
                  {toast && toast.type !== 'error' && renderToast(toast)}
                </div>
                {toast && toast.type === 'error' && (
                  <div role="alert">{renderToast(toast)}</div>
                )}
              </div>

              {/* Category list */}
              <div
                className="wlp-scroll wlp-list py-[12px]"
                onDragOver={(e) => { if (isReorderDrag(e) && !wasHandled(e)) setDropTarget(null); }}
                onDrop={handleListDrop}
              >
                {filledCategories.map((category) => {
                  const open = !category.hidden;
                  const listId = `wlp-section-${category.calendarId}`;
                  return (
                    <div key={category.calendarId} className="wlp-cat-group">
                      {/* The section's title row, like "My calendars" in Google's
                          nav: the whole row is the disclosure button, inside the
                          heading so a screen reader can still jump between
                          calendars by heading. Its name is the calendar's name,
                          and aria-expanded says whether its items are showing.
                          It is also where a drag aims to put an item in this
                          calendar, folded or not. */}
                      <div
                        className={`wlp-cat-header${
                          !open && dropTarget?.calendarId === category.calendarId ? ' wlp-drop-into' : ''
                        }`}
                        onDragOver={(e) => handleCategoryDragOver(e, category.calendarId)}
                      >
                        <h3 className="wlp-cat-heading">
                          <button
                            type="button"
                            onClick={() => toggleSection(category.calendarId)}
                            aria-expanded={open}
                            aria-controls={open ? listId : undefined}
                            title={open ? 'Fold this calendar' : 'Show this calendar’s items'}
                            className="wlp-cat-toggle"
                          >
                            <span
                              aria-hidden="true"
                              className="wlp-cat-marker"
                              style={{ backgroundColor: category.color }}
                            />
                            <span dir="auto" className="wlp-cat-title">{category.name}</span>
                            {/* Folded, the row still says how much is inside. */}
                            {!open && (
                              <span className="wlp-cat-count">
                                <span className="sr-only">, </span>
                                {category.items.length}
                                <span className="sr-only">{category.items.length === 1 ? ' item' : ' items'}</span>
                              </span>
                            )}
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="wlp-cat-chevron">
                              <path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/>
                            </svg>
                          </button>
                        </h3>
                      </div>
                      {open && (
                        <div id={listId} className="wlp-items-list flex flex-col">
                          {category.items.map((item, index) => {
                            const editing  = editingId  === item.id;
                            const expanded = expandedId === item.id;
                            const picked   = pickedId   === item.id;
                            const scheduleFormId = `wlp-schedule-${item.id}`;
                            // The chip is drawn in the colour the event will
                            // have, its own colorId else the calendar's.
                            const chipColor = eventColorHex(item.colorId, category.color);
                            const aimedHere = dropTarget?.calendarId === category.calendarId;
                            const dropBefore = aimedHere && dropTarget!.index === index;
                            const dropAfter  = aimedHere &&
                              dropTarget!.index === index + 1 &&
                              index === category.items.length - 1;
                            return (
                              <div
                                key={item.id}
                                className={`wlp-item-wrap${dropBefore ? ' wlp-drop-before' : ''}${dropAfter ? ' wlp-drop-after' : ''}`}
                                onDragOver={(e) => handleRowDragOver(e, category.calendarId, index)}
                              >
                                <div
                                  // A draggable ancestor swallows the caret and text
                                  // selection, so the row stops being draggable while
                                  // its name is being edited.
                                  draggable={!editing}
                                  onDragStart={(e) => {
                                    const payload = { ...item, color: category.color };
                                    e.dataTransfer?.setData('poolItem', JSON.stringify(payload));
                                    // Its own type: a calendar drop reads poolItem, a
                                    // sidebar drop reads this, and neither can pick up
                                    // the other's payload by accident.
                                    e.dataTransfer?.setData('poolReorder', JSON.stringify({ id: item.id }));
                                    setDraggingId(item.id);
                                    setChipDragImage(e);
                                    // A drag is its own way of scheduling, and a pick
                                    // left armed would place a second event on the
                                    // next click.
                                    setPickedId(null);
                                    document.dispatchEvent(new CustomEvent('poolDragStart', { detail: { item: payload } }));
                                  }}
                                  onDragEnd={() => {
                                    setDraggingId(null);
                                    setDropTarget(null);
                                    document.dispatchEvent(new CustomEvent('poolDragEnd'));
                                  }}
                                  // The chip runs in its name's direction, as
                                  // Google's does: a Hebrew name starts at the
                                  // right edge with ", 1h" to its left, and the
                                  // controls unfold on the left. Worked out here
                                  // rather than with dir="auto", which would read
                                  // the duration's "1h" past the name's own
                                  // dir="auto" and always say left to right.
                                  dir={textDirection(item.name)}
                                  // An open schedule form or details panel keeps
                                  // the row's controls showing, so the one that
                                  // opened it stays where the pointer left it.
                                  className={`wlp-item${draggingId === item.id ? ' wlp-item-dragging' : ''}${
                                    picked ? ' wlp-item-picked' : ''
                                  }${picked || expanded ? ' wlp-item-active' : ''}`}
                                  style={{
                                    '--wlp-chip':      chipColor,
                                    '--wlp-chip-text': chipTextOn(chipColor),
                                  } as React.CSSProperties}
                                >
                                  {editing ? (
                                    <input
                                      autoFocus
                                      // Rename usually means replace, not append:
                                      // without this the caret lands at the end and
                                      // typing extends the old name.
                                      onFocus={(e) => e.currentTarget.select()}
                                      dir="auto"
                                      value={editingName}
                                      aria-label={`Rename ${item.name}`}
                                      onChange={(e) => setEditingName(e.target.value)}
                                      onBlur={commitRename}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter')  commitRename();
                                        if (e.key === 'Escape') cancelRename();
                                      }}
                                      className="wlp-item-rename"
                                    />
                                  ) : (
                                    <span
                                      dir="auto"
                                      onDoubleClick={() => startRename(item)}
                                      title={`${item.name} — drag onto the calendar (hold Shift to repeat weekly), double-click to rename`}
                                      className="wlp-item-name"
                                    >
                                      {item.name}
                                    </span>
                                  )}
                                  {/* "workout, 1h", the way Google's chip reads
                                      "workout, 10:30am": the duration follows the
                                      name as secondary text, and is still the
                                      select that changes it. */}
                                  <span aria-hidden="true" className="wlp-item-sep">,</span>
                                  <DurationSelect
                                    value={durationOf(item)}
                                    label={`Duration of ${item.name}`}
                                    onChange={(min) => updateItem(item.id, { durationMin: min })}
                                  />
                                  {/* The row's controls show on hover and whenever
                                      focus is in the row, as Google's nav shows its
                                      row actions, so at rest the chip is just the
                                      event. They are folded to no width rather than
                                      removed, so Tab still stops on each of them,
                                      and focus anywhere in the row unfolds them. */}
                                  <div className="wlp-item-actions">
                                    {/* The no-drag way to schedule. A real button, so
                                        Tab reaches it and Enter or Space picks the item,
                                        and a pointer user who cannot drag can click it
                                        and then click a time on the grid. */}
                                    <button
                                      ref={(el) => {
                                        if (el) scheduleButtons.current.set(item.id, el);
                                        else    scheduleButtons.current.delete(item.id);
                                      }}
                                      type="button"
                                      onClick={() => setPickedId(picked ? null : item.id)}
                                      aria-label={`Schedule ${item.name}`}
                                      aria-expanded={picked}
                                      aria-controls={picked ? scheduleFormId : undefined}
                                      title={picked ? 'Cancel scheduling (Esc)' : 'Schedule without dragging (Enter)'}
                                      className={`wlp-item-btn wlp-item-schedule${picked ? ' wlp-item-btn-on' : ''}`}
                                    >
                                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-1V1h-2zm3 18H5V8h14v11z"/>
                                      </svg>
                                    </button>
                                    {/* A pencil, Google's edit icon, rather than
                                        the chevron it was: a chevron read as
                                        "more" and not as the way to change the
                                        item's location, notification, colour and
                                        description (M8 U23). Its filled state
                                        says the panel is open. */}
                                    <button
                                      type="button"
                                      onClick={() => setExpandedId(expanded ? null : item.id)}
                                      title={expanded ? 'Close details' : 'Edit details'}
                                      aria-label={`Edit details of ${item.name}`}
                                      aria-expanded={expanded}
                                      className={`wlp-item-btn wlp-item-expand${expanded ? ' wlp-item-btn-on' : ''}`}
                                    >
                                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                                      </svg>
                                    </button>
                                    <button
                                      onClick={() => deleteItem(item.id)}
                                      title="Delete"
                                      aria-label={`Delete ${item.name}`}
                                      className="wlp-item-btn wlp-item-delete"
                                    >
                                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                                {picked && (
                                  <ScheduleForm
                                    id={scheduleFormId}
                                    item={item}
                                    onSchedule={(date, startMin, recurring) =>
                                      scheduleItem(item, category.color, date, startMin, recurring)
                                    }
                                    onCancel={() => closePick(item.id)}
                                  />
                                )}
                                {expanded && (
                                  <ItemDetails
                                    item={item}
                                    categoryName={category.name}
                                    categoryColor={category.color}
                                    onChange={(patch) => updateItem(item.id, patch)}
                                    onDuplicate={() => duplicateItem(item.id)}
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {categories.length === 0 && (
                  <p className="px-[16px] pt-[20px] text-[13px] text-[var(--wlp-text-secondary)]">No calendars found.</p>
                )}

                {/* Calendars with nothing in them yet, under one quiet line
                    instead of a "No items yet" each. A row is a button that
                    sets the composer to that calendar, and a drop target
                    that takes a dragged item into it, which unfolds it into
                    a section of its own above. There is nothing in one to
                    fold, so a row has no chevron; a calendar folded before it
                    emptied comes back unfolded when it gets an item. */}
                {emptyCategories.length > 0 && (
                  <div role="group" aria-labelledby="wlp-empty-caption" className="wlp-empty-group">
                    <p id="wlp-empty-caption" className="wlp-empty-caption">
                      No items yet
                    </p>
                    {emptyCategories.map((cat) => (
                      <button
                        key={cat.calendarId}
                        type="button"
                        onClick={() => startAddTo(cat.calendarId)}
                        onDragOver={(e) => handleCategoryDragOver(e, cat.calendarId)}
                        aria-label={`Add an item to ${cat.name}`}
                        title={`Add an item to ${cat.name}, or drag one here`}
                        className={`wlp-empty-row${
                          dropTarget?.calendarId === cat.calendarId ? ' wlp-drop-into' : ''
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className="wlp-cat-marker"
                          style={{ backgroundColor: cat.color }}
                        />
                        <span dir="auto" className="wlp-empty-name">{cat.name}</span>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="wlp-empty-add">
                          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                        </svg>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Footer. Last in the column, so it sits at the bottom under the
              scrolling list; its auto top margin keeps it there while the
              list is replaced by the loading or error state. The collapsed
              strip has no room for it and does not get one. */}
          <footer className="wlp-footer">
            {loaded && (
              <span className="wlp-footer-actions">
                <button type="button" onClick={exportUsuals} className="wlp-footer-link" title="Save all your usuals to a file">
                  Export
                </button>
                <span aria-hidden="true" className="wlp-footer-dot">·</span>
                <button type="button" onClick={() => importInput.current?.click()} className="wlp-footer-link" title="Add the usuals from an exported file">
                  Import
                </button>
                <input
                  ref={importInput}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Cleared so choosing the same file again still fires.
                    e.target.value = '';
                    if (file) importUsuals(file);
                  }}
                />
              </span>
            )}
            <a
              href={HOMEPAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="wlp-footer-link"
            >
              About · Support<span aria-hidden="true"> ↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </footer>
        </div>
      )}
    </div>
  );
};

export default PoolSidebar;
