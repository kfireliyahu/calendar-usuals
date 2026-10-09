import React, { useState, useEffect, useRef } from 'react';
import {
  PoolItem,
  DEFAULT_DURATION_MIN,
  DURATION_PRESETS,
  EVENT_COLORS,
  REMINDER_PRESETS,
  durationOf,
  eventColorHex,
  formatDuration,
  formatReminder,
  hasTemplate,
  newItemId,
} from '../poolItem';
import { formatTime, isSameDay, visibleTimeGridDays } from '../calendarGrid';
import { loadPool, onSyncFull, savePool, subscribePool } from '../poolStore';
import { readableTextOn } from '../theme';

interface PoolCategory {
  calendarId: string;
  name: string;
  color: string;
  items: PoolItem[];
  hidden?: boolean;
}

interface CalendarListEntry {
  id: string;
  summary: string;
  backgroundColor?: string;
  accessRole?: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
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

// A toast does not count down while the pointer is over it or focus is inside
// it: five seconds is short for someone tabbing to Undo or listening to a
// screen reader. Once they leave it gets at least this long again, so it never
// vanishes the instant the pointer moves off.
const TOAST_RESUME_MIN_MS = 2000;

// Store users never see the README, so the sidebar's footer is how they find
// the project page. manifest.json's homepage_url repeats it, because JSON
// cannot import a constant; change both together.
const HOMEPAGE_URL = 'https://kfireliyahu.com/weekly-life-pool';

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
interface StoredState {
  sidebarCollapsed?: boolean;
  formOpen?: boolean;
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

// Compact duration control. A native <select> so it stays keyboard accessible
// without a custom dropdown; content.css strips the arrow to fit the 280px rail.
// title is only a tooltip for the pointer; label is the select's accessible
// name, and says which item it belongs to, since every row has one.
const DurationSelect: React.FC<{
  value: number;
  label: string;
  onChange: (min: number) => void;
}> = ({ value, label, onChange }) => {
  // A stored value outside the presets still has to appear as an option, or the
  // select would quietly display a duration the item does not have.
  const options = DURATION_PRESETS.includes(value)
    ? DURATION_PRESETS
    : [...DURATION_PRESETS, value].sort((a, b) => a - b);

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

// ── Item template panel ──────────────────────────────────────────────────────
//
// Everything an item carries beyond its name and duration. Collapsed by
// default: the pool is meant to be scannable at 280px, so these fields never
// sit on the always-visible row.

const ItemDetails: React.FC<{
  item: PoolItem;
  categoryColor: string;
  onChange: (patch: Partial<PoolItem>) => void;
  onDuplicate: () => void;
}> = ({ item, categoryColor, onChange, onDuplicate }) => (
  <div className="wlp-item-details">
    <textarea
      rows={2}
      placeholder="Description"
      aria-label={`Description for ${item.name}`}
      value={item.description ?? ''}
      onChange={(e) => onChange({ description: e.target.value })}
      className="wlp-field"
    />
    <input
      type="text"
      placeholder="Location"
      aria-label={`Location for ${item.name}`}
      value={item.location ?? ''}
      onChange={(e) => onChange({ location: e.target.value })}
      className="wlp-field"
    />

    <div className="wlp-swatches">
      {/* No colorId means "whatever colour the calendar uses", which is what
          every item did before this panel existed. */}
      <button
        type="button"
        title="Calendar colour"
        aria-label="Calendar colour"
        aria-pressed={!item.colorId}
        onClick={() => onChange({ colorId: undefined })}
        className={`wlp-swatch${item.colorId ? '' : ' wlp-swatch-on'}`}
        style={{ backgroundColor: categoryColor }}
      />
      {EVENT_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          title={c.name}
          aria-label={c.name}
          aria-pressed={item.colorId === c.id}
          onClick={() => onChange({ colorId: c.id })}
          className={`wlp-swatch${item.colorId === c.id ? ' wlp-swatch-on' : ''}`}
          style={{ backgroundColor: c.hex }}
        />
      ))}
    </div>

    <div className="wlp-details-row">
      <select
        title="Reminder"
        aria-label={`Reminder for ${item.name}`}
        value={item.reminderMin === undefined ? '' : String(item.reminderMin)}
        onChange={(e) =>
          onChange({ reminderMin: e.target.value === '' ? undefined : Number(e.target.value) })
        }
        className="wlp-field wlp-details-select"
      >
        <option value="">Default reminder</option>
        {REMINDER_PRESETS.map((min) => (
          <option key={min} value={min}>{formatReminder(min)}</option>
        ))}
      </select>
      <button type="button" onClick={onDuplicate} title="Duplicate item" className="wlp-dup-btn">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/>
        </svg>
        Duplicate
      </button>
    </div>
  </div>
);

// ── Schedule form ────────────────────────────────────────────────────────────
//
// The way to put an item on the calendar without dragging it. It offers the
// days the time grid is showing, so it schedules into the week the user is
// looking at, and falls back to the coming seven days when there is no time
// grid to read (month or schedule view). Whatever it picks goes through the
// same create path as a drop.

const QUARTER_HOURS = Array.from({ length: 24 * 4 }, (_, i) => i * 15);
const LAST_START_MIN = QUARTER_HOURS[QUARTER_HOURS.length - 1];

function scheduleDays(): Date[] {
  const shown = visibleTimeGridDays();
  if (shown.length > 0) return shown;
  const now = new Date();
  return Array.from({ length: 7 }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
}

function defaultDay(days: Date[]): Date {
  const today = new Date();
  return days.find((d) => isSameDay(d, today)) ?? days[0];
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// The weekday is dropped for today so the label still fits the 280px rail.
function dayLabel(d: Date): string {
  return isSameDay(d, new Date())
    ? `Today, ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// The soonest quarter hour that has not started yet. Late in the evening that
// would be tomorrow, which the day choice says otherwise, so it stops at the
// last slot of the day instead of wrapping.
function nextQuarterHour(now = new Date()): number {
  const minutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  return Math.min(Math.ceil(minutes / 15) * 15, LAST_START_MIN);
}

const ScheduleForm: React.FC<{
  id: string;
  item: PoolItem;
  onSchedule: (date: Date, startMin: number, recurring: boolean) => void;
  onCancel: () => void;
}> = ({ id, item, onSchedule, onCancel }) => {
  const [days, setDays] = useState(scheduleDays);
  const [dayValue, setDayValue] = useState(() => dayKey(defaultDay(days)));
  const [startMin, setStartMin] = useState(() => nextQuarterHour());
  const [recurring, setRecurring] = useState(false);

  // Google Calendar can move to another week while the form is open, so the
  // days are read again each time the day choice gets focus. The chosen day
  // survives when the new week still shows it.
  const refreshDays = () => {
    const next = scheduleDays();
    setDays(next);
    if (!next.some((d) => dayKey(d) === dayValue)) setDayValue(dayKey(defaultDay(next)));
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
      // none, so Enter on the selects or the checkbox schedules too. A button
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
      <div className="wlp-schedule-row">
        <label className="wlp-schedule-field">
          <span className="wlp-schedule-label">Day</span>
          <select
            autoFocus
            value={dayValue}
            onFocus={refreshDays}
            onChange={(e) => setDayValue(e.target.value)}
            className="wlp-field"
          >
            {days.map((d) => (
              <option key={dayKey(d)} value={dayKey(d)}>{dayLabel(d)}</option>
            ))}
          </select>
        </label>
        <label className="wlp-schedule-field wlp-schedule-time">
          <span className="wlp-schedule-label">Start</span>
          <select
            value={startMin}
            onChange={(e) => setStartMin(Number(e.target.value))}
            className="wlp-field"
          >
            {QUARTER_HOURS.map((min) => (
              <option key={min} value={min}>{formatTime(Math.floor(min / 60), min % 60)}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="wlp-schedule-repeat">
        <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
        Repeat weekly
      </label>
      <p className="wlp-schedule-hint">Or click a time in Day or Week view. Shift-click repeats weekly.</p>
      <div className="wlp-schedule-actions">
        <button type="button" onClick={onCancel} className="wlp-schedule-btn">Cancel</button>
        <button type="submit" className="wlp-schedule-btn wlp-schedule-btn-primary">Schedule</button>
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
  const [formOpen, setFormOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const collapsedReady = useRef(false);
  const formReady = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastDeadline = useRef(0);
  const toastRemaining = useRef<number | null>(null);
  const toastArea = useRef<HTMLDivElement>(null);
  const cancelledRename = useRef(false);
  const scheduleButtons = useRef(new Map<string, HTMLButtonElement>());

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

    showToast(`Removing "${target.itemName}"…`, 'info', 0);
    try {
      chrome.runtime.sendMessage(
        { type: 'DELETE_EVENT', data: { calendarId: target.calendarId, eventId: target.eventId } },
        (response) => {
          if (chrome.runtime.lastError) { fail(chrome.runtime.lastError.message); return; }
          if (!response?.success)       { fail(response?.error); return; }
          showToast(
            target.recurring ? `Weekly series "${target.itemName}" removed` : `"${target.itemName}" removed`,
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

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    chrome.storage.local.get<StoredState>(['sidebarCollapsed', 'formOpen'], (result) => {
      collapsedReady.current = true;
      formReady.current = true;
      setCollapsed(result.sidebarCollapsed === true);
      if (result.formOpen === false) setFormOpen(false);
    });
  }, []);

  useEffect(() => {
    if (!collapsedReady.current) return;
    if (extensionAlive()) {
      chrome.storage.local.set({ sidebarCollapsed: collapsed });
    }
    document.dispatchEvent(new CustomEvent('poolSidebarToggle', { detail: { collapsed } }));
  }, [collapsed]);

  useEffect(() => {
    if (!formReady.current) return;
    if (extensionAlive()) {
      chrome.storage.local.set({ formOpen });
    }
  }, [formOpen]);

  // Focus input when form opens
  useEffect(() => {
    if (formOpen) setTimeout(() => inputRef.current?.focus(), 50);
  }, [formOpen]);

  // ── Drop toast listener ──────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: Event) => {
      const { type, itemName, error: err, recurring, event } = (e as CustomEvent).detail;
      if (type === 'creating') {
        showToast(`Adding "${itemName}"${recurring ? ' weekly' : ''}…`, 'info', 0);

      } else if (type === 'created') {
        const message = recurring ? `"${itemName}" added, repeats weekly` : `"${itemName}" added!`;
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
  // calendar colour a drag would carry. Deleting the item or hiding its
  // calendar ends the pick rather than leaving an invisible item armed.
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

  // A click on the grid used the pick up.
  useEffect(() => {
    const done = () => setPickedId(null);
    document.addEventListener('poolPickDone', done);
    return () => document.removeEventListener('poolPickDone', done);
  }, []);

  // ── Calendar fetch ───────────────────────────────────────────────────────────

  const fetchCalendars = () => {
    setLoading(true);
    setFetchError(null);

    if (typeof chrome === 'undefined' || !chrome.runtime) {
      setFetchError('Chrome extension API not available');
      setLoading(false);
      return;
    }
    if (!extensionAlive()) {
      setFetchError('Extension reloaded - refresh the page');
      setLoading(false);
      return;
    }

    chrome.runtime.sendMessage({ type: 'LIST_CALENDARS' }, (response) => {
      if (chrome.runtime.lastError) {
        setFetchError(chrome.runtime.lastError.message ?? 'Failed to connect');
        setLoading(false);
        return;
      }
      if (!response?.success) {
        setFetchError(response?.error ?? 'Failed to fetch calendars');
        setLoading(false);
        return;
      }

      // The calendar.events.owned scope can only write to calendars the user
      // owns. A merely subscribed calendar — shared, team, holidays — would
      // render as a drop target and then 403 on drop, so it never becomes a
      // category.
      const entries: CalendarListEntry[] = (response.data.items ?? []).filter(
        (cal: CalendarListEntry) => cal.accessRole === 'owner'
      );

      // Items stored under a calendar that is not in this list, say one from
      // the Google account another machine is signed into, are not shown but
      // stay in storage: poolStore only replaces the calendars passed to it.
      loadPool().then(
        (pool) => {
          const newCategories: PoolCategory[] = entries.map((cal) => ({
            calendarId: cal.id,
            name: cal.summary,
            color: cal.backgroundColor ?? '#4285f4',
            items: pool.items[cal.id] ?? [],
            hidden: pool.hidden.includes(cal.id),
          }));
          setCategories(newCategories);
          const firstVisible = newCategories.find((c) => !c.hidden);
          setNewItemCategory((firstVisible ?? newCategories[0])?.calendarId ?? '');
          setLoaded(true);
          setLoading(false);
        },
        (err) => {
          setFetchError(`Could not read the pool: ${err instanceof Error ? err.message : String(err)}`);
          setLoading(false);
        }
      );
    });
  };

  useEffect(() => { fetchCalendars(); }, []);

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

  // ── Item management ──────────────────────────────────────────────────────────

  const addItem = () => {
    if (!newItemName.trim() || !newItemCategory) return;
    setCategories((prev) =>
      prev.map((cat) =>
        cat.calendarId === newItemCategory
          ? {
              ...cat,
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
          items: [...items.slice(0, at), { ...moved, calendarId: toCalendarId }, ...items.slice(at)],
        };
      });
    });
  };

  const toggleCategoryHidden = (calendarId: string) => {
    setCategories((prev) =>
      prev.map((cat) =>
        cat.calendarId === calendarId ? { ...cat, hidden: !cat.hidden } : cat
      )
    );
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

  // If selected dropdown category gets hidden, reset to first visible
  useEffect(() => {
    const isHidden = categories.find((c) => c.calendarId === newItemCategory)?.hidden;
    if (isHidden) {
      const first = categories.find((c) => !c.hidden);
      if (first) setNewItemCategory(first.calendarId);
    }
  }, [categories]);

  // ── Shared styles ────────────────────────────────────────────────────────────

  const sidebarCls = `wlp-sidebar fixed left-0 top-0 h-screen border-r border-[var(--wlp-divider)] flex flex-col z-[1000] overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] ${
    collapsed ? 'w-[40px]' : 'w-[280px]'
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

  const visibleCategories = categories.filter((c) => !c.hidden);
  const hiddenCategories  = categories.filter((c) =>  c.hidden);
  const selectedCategory  = visibleCategories.find((c) => c.calendarId === newItemCategory);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className={sidebarCls}>

      {/* ── Collapsed strip ─────────────────────────────────────────────────── */}
      {collapsed ? (
        <div className="flex flex-col items-center pt-[8px]">
          <button
            onClick={() => setCollapsed(false)}
            title="Show Weekly Pool"
            aria-label="Show Weekly Pool"
            className={iconBtnCls}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/>
            </svg>
          </button>
        </div>
      ) : (
        /* ── Expanded view ────────────────────────────────────────────────── */
        <div className="flex flex-col h-full w-[280px]">

          {/* Header */}
          <div className="wlp-header flex items-center justify-between border-b border-[var(--wlp-border)] shrink-0">
            <div className="flex items-center gap-[9px]">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 text-[var(--wlp-accent)]">
                <rect x="3" y="6" width="18" height="15" rx="2" stroke="currentColor" strokeWidth="1.8" fill="none"/>
                <path d="M3 10h18" stroke="currentColor" strokeWidth="1.8"/>
                <path d="M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                <circle cx="8" cy="15" r="1.1" fill="currentColor"/>
                <circle cx="12" cy="15" r="1.1" fill="currentColor"/>
                <circle cx="16" cy="15" r="1.1" fill="currentColor"/>
              </svg>
              <h2 className="m-[0] text-[14px] font-[500] text-[var(--wlp-text)] tracking-[0.1px]">
                Weekly Pool
              </h2>
            </div>
            <div className="flex items-center gap-[2px]">
              {/* Toggle form */}
              <button
                onClick={() => setFormOpen((v) => !v)}
                title={formOpen ? 'Hide input' : 'Add items'}
                aria-label="Add items"
                aria-expanded={formOpen}
                className={iconBtnCls}
                style={{ color: formOpen ? 'var(--wlp-accent)' : undefined }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                </svg>
              </button>
              {/* Collapse sidebar */}
              <button
                onClick={() => { setPickedId(null); setCollapsed(true); }}
                title="Hide sidebar"
                aria-label="Hide sidebar"
                className={iconBtnCls}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/>
                </svg>
              </button>
            </div>
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
                onClick={fetchCalendars}
                className="px-[12px] py-[8px] bg-[var(--wlp-primary)] text-[var(--wlp-on-primary)] border-none rounded-[6px] text-[13px] font-[500] cursor-pointer hover:bg-[var(--wlp-primary-hover)] transition-colors duration-150"
              >
                Retry
              </button>
            </div>
          )}

          {/* Content (loaded) */}
          {!loading && !fetchError && (
            <>
              {/* Add item form — always in DOM, animated via max-height/opacity */}
              <div
                style={{
                  maxHeight: formOpen ? '300px' : '0',
                  opacity: formOpen ? 1 : 0,
                  overflow: 'hidden',
                  pointerEvents: formOpen ? undefined : 'none',
                  transition: 'max-height 0.22s ease, opacity 0.15s ease',
                  borderBottom: '1px solid var(--wlp-divider)',
                  flexShrink: 0,
                }}
              >
                <div className="wlp-form">

                  {/* Category chips — only when >1 visible calendar */}
                  {visibleCategories.length > 1 && (
                    <div className="wlp-cat-chips">
                      {visibleCategories.map((cat) => {
                        const sel = newItemCategory === cat.calendarId;
                        return (
                          <button
                            key={cat.calendarId}
                            onClick={() => setNewItemCategory(cat.calendarId)}
                            title={cat.name}
                            className="wlp-cat-chip"
                            style={{
                              '--chip-bg':     sel ? cat.color : 'transparent',
                              '--chip-border': sel ? cat.color : 'var(--wlp-border-subtle)',
                              '--chip-color':  sel ? readableTextOn(cat.color) : 'var(--wlp-text-secondary)',
                            } as React.CSSProperties}
                          >
                            <span
                              className="wlp-cat-chip-dot"
                              // On a selected chip the dot takes the text colour,
                              // which readableTextOn picked for this calendar.
                              style={sel ? { backgroundColor: 'currentColor', opacity: 0.75 } : { backgroundColor: cat.color }}
                            />
                            <span className="truncate">{cat.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Input row */}
                  <div className="wlp-input-row">
                    {/* Single-category color indicator */}
                    {visibleCategories.length === 1 && selectedCategory && (
                      <span
                        className="wlp-input-color-dot"
                        style={{ backgroundColor: selectedCategory.color }}
                      />
                    )}
                    <input
                      ref={inputRef}
                      type="text"
                      placeholder="New item…"
                      value={newItemName}
                      onChange={(e) => setNewItemName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addItem()}
                      className="[font-family:inherit] placeholder-[var(--wlp-text-muted)]"
                    />
                    {newItemName && (
                      <button
                        onClick={() => { setNewItemName(''); inputRef.current?.focus(); }}
                        tabIndex={-1}
                        title="Clear"
                        aria-label="Clear"
                        className="wlp-input-clear"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                      </button>
                    )}
                    <DurationSelect value={newItemDuration} label="Duration of new item" onChange={setNewItemDuration} />
                    <button
                      onClick={addItem}
                      disabled={!newItemName.trim()}
                      title="Add (Enter)"
                      aria-label="Add item"
                      className="wlp-input-add"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                      </svg>
                    </button>
                  </div>

                  {/* The two modifiers nothing else on screen mentions. */}
                  <p className="wlp-form-hint">
                    Hold Shift as you drop to repeat weekly · Enter on an item's calendar icon schedules it
                  </p>

                </div>
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
                className="flex-1 overflow-y-auto py-[12px]"
                onDragOver={(e) => { if (isReorderDrag(e) && !wasHandled(e)) setDropTarget(null); }}
                onDrop={handleListDrop}
              >
                {visibleCategories.map((category) => (
                  <div key={category.calendarId} className="wlp-cat-group">
                    <div
                      className="wlp-cat-header flex items-center gap-[7px]"
                      onDragOver={(e) => handleCategoryDragOver(e, category.calendarId)}
                    >
                      <span
                        className="w-[10px] h-[10px] rounded-full shrink-0"
                        style={{ backgroundColor: category.color }}
                      />
                      <h3 className="flex-1 m-[0] text-[11px] font-[600] text-[var(--wlp-text-secondary)] uppercase tracking-[0.6px]">
                        {category.name}
                      </h3>
                      <button
                        onClick={() => toggleCategoryHidden(category.calendarId)}
                        title="Hide category"
                        aria-label={`Hide ${category.name}`}
                        className="wlp-cat-hide shrink-0 bg-transparent border-none cursor-pointer p-[0] text-[var(--wlp-text-muted)] transition-all duration-150 hover:text-[var(--wlp-text-secondary)]"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
                        </svg>
                      </button>
                    </div>
                    <div className="wlp-items-list flex flex-col">
                      {category.items.map((item, index) => {
                        const editing  = editingId  === item.id;
                        const expanded = expandedId === item.id;
                        const picked   = pickedId   === item.id;
                        const scheduleFormId = `wlp-schedule-${item.id}`;
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
                              className={`wlp-item group flex items-center justify-between bg-[var(--wlp-surface-raised)] border border-[var(--wlp-border-subtle)] rounded-[6px] text-[13px] text-[var(--wlp-text)] cursor-grab select-none transition-all duration-150 hover:border-[var(--wlp-border-hover)] hover:shadow-[0_1px_4px_rgba(0,0,0,0.1)] active:cursor-grabbing${
                                draggingId === item.id ? ' opacity-40' : ''
                              }${picked ? ' wlp-item-picked' : ''}`}
                              style={{ borderLeft: `3px solid ${eventColorHex(item.colorId, category.color)}` }}
                            >
                              {editing ? (
                                <input
                                  autoFocus
                                  // Rename usually means replace, not append:
                                  // without this the caret lands at the end and
                                  // typing extends the old name.
                                  onFocus={(e) => e.currentTarget.select()}
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
                                  onDoubleClick={() => startRename(item)}
                                  title={`${item.name} — drag onto the calendar (hold Shift to repeat weekly), double-click to rename`}
                                  className="flex-1 truncate"
                                >
                                  {item.name}
                                </span>
                              )}
                              <DurationSelect
                                value={durationOf(item)}
                                label={`Duration of ${item.name}`}
                                onChange={(min) => updateItem(item.id, { durationMin: min })}
                              />
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
                                className={`wlp-item-schedule${picked ? ' wlp-item-schedule-on' : ''}`}
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-1V1h-2zm3 18H5V8h14v11z"/>
                                </svg>
                              </button>
                              <button
                                onClick={() => setExpandedId(expanded ? null : item.id)}
                                title={expanded ? 'Hide details' : 'Edit details'}
                                aria-label={`Details for ${item.name}`}
                                aria-expanded={expanded}
                                className={`wlp-item-expand${hasTemplate(item) ? ' wlp-item-expand-on' : ''}`}
                                style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                                </svg>
                              </button>
                              <button
                                onClick={() => deleteItem(item.id)}
                                title="Delete"
                                aria-label={`Delete ${item.name}`}
                                className="wlp-item-delete opacity-0 group-hover:opacity-100 focus-visible:opacity-100 shrink-0 bg-transparent border-none text-[17px] leading-none text-[var(--wlp-icon-faint)] cursor-pointer p-[0] ml-[4px] transition-all duration-150 hover:text-[var(--wlp-danger)] hover:scale-110"
                              >
                                ×
                              </button>
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
                                categoryColor={category.color}
                                onChange={(patch) => updateItem(item.id, patch)}
                                onDuplicate={() => duplicateItem(item.id)}
                              />
                            )}
                          </div>
                        );
                      })}
                      {category.items.length === 0 && (
                        <p
                          onDragOver={(e) => handleCategoryDragOver(e, category.calendarId)}
                          className={`wlp-empty px-[16px] py-[4px] text-[12px] text-[var(--wlp-text-muted)] italic${
                            dropTarget?.calendarId === category.calendarId ? ' wlp-drop-empty' : ''
                          }`}
                        >
                          No items yet
                        </p>
                      )}
                    </div>
                  </div>
                ))}
                {visibleCategories.length === 0 && hiddenCategories.length === 0 && (
                  <p className="px-[20px] pt-[20px] text-[13px] text-[var(--wlp-text-secondary)]">No calendars found.</p>
                )}

                {/* Hidden categories restore strip */}
                {hiddenCategories.length > 0 && (
                  <div className="wlp-hidden-strip border-t border-[var(--wlp-divider)]">
                    <p className="text-[11px] font-[600] uppercase tracking-[0.6px] text-[var(--wlp-text-muted)] mb-[8px]">
                      Hidden ({hiddenCategories.length})
                    </p>
                    {hiddenCategories.map((cat) => (
                      <div key={cat.calendarId} className="wlp-hidden-row flex items-center gap-[8px]">
                        <span className="w-[8px] h-[8px] rounded-full shrink-0 opacity-40" style={{ backgroundColor: cat.color }} />
                        <span className="flex-1 text-[12px] text-[var(--wlp-text-muted)] truncate">{cat.name}</span>
                        <button
                          onClick={() => toggleCategoryHidden(cat.calendarId)}
                          title="Show category"
                          aria-label={`Show ${cat.name}`}
                          className="wlp-cat-show shrink-0 bg-transparent border-none cursor-pointer p-[0] text-[var(--wlp-text-muted)] hover:text-[var(--wlp-text-secondary)] transition-colors duration-150"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                          </svg>
                        </button>
                      </div>
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
