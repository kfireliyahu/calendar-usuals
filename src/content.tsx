import React from 'react';
import ReactDOM from 'react-dom/client';
import PoolSidebar from './components/PoolSidebar';
import { PoolItem, durationOf, eventColorHex } from './poolItem';
import { dateFromCell, findDatekey, formatTime, gridZoneLabels, isTimeGridCell, timeGridCellFor } from './calendarGrid';
import { EventDateTime, eventTimes } from './calendarZone';
import { PageLook, Theme, chipTextOn, watchTheme } from './theme';
import { isolate } from './names';
import { adjustLayout } from './layout';
import './content.css';

// What crosses the drag: the stored item plus the colour of the calendar it
// lives in, which the sidebar knows and storage does not.
type DropPoolItem = PoolItem & { color?: string };

const FALLBACK_COLOR = '#4285f4';

// An item with its own colorId will render in that colour once Google Calendar
// draws it, so the preview and the loading placeholder use it too.
function previewColor(item: DropPoolItem): string {
  return eventColorHex(item.colorId, item.color ?? FALLBACK_COLOR);
}

// ── Theme ─────────────────────────────────────────────────────────────────────

// The sidebar's mount and the tooltip and preview below are the only elements
// the extension adds to the page, and content.css keys every colour off this
// attribute on them. The tooltip and preview are created lazily, so each picks
// up the current theme when it is made.
//
// The page surface goes on the sidebar's mount alone, as --wlp-page, which
// content.css paints the sidebar with in place of its own constant. The
// tooltip and preview sit over the grid, not beside the nav, and never use it.
let currentTheme: Theme = 'light';

function applyTheme({ theme, surface }: PageLook): void {
  currentTheme = theme;
  const sidebarEl = document.getElementById('weekly-life-pool-sidebar');
  for (const el of [sidebarEl, tooltipEl, previewEl]) {
    el?.setAttribute('data-wlp-theme', theme);
  }
  if (surface) sidebarEl?.style.setProperty('--wlp-page', surface);
  else sidebarEl?.style.removeProperty('--wlp-page');
}

// ── Time helper ───────────────────────────────────────────────────────────────

// Only meaningful on a time-grid cell (see isTimeGridCell), where 1 px below
// the cell's top is one minute past midnight. A drop and a click-to-place both
// read their time through here, so they snap identically. The time is the
// grid's wall clock, in Google Calendar's time zone, and the tooltip shows it
// as read; eventTimes() is what turns it into an instant.
//
// Rounding to the nearest slot sends the bottom 7.5 minutes of a column to
// 24:00, which is the next day. They belong to the day's last slot, so the
// start is clamped to 23:45 here, once, and the preview, the tooltip and the
// created event all read the same clamped value.
const LAST_SLOT_MIN = 24 * 60 - 15;

function timeFromDrop(cell: Element, clientY: number): { hours: number; minutes: number; snapped: number } {
  const pixelY = clientY - cell.getBoundingClientRect().top;
  const snapped = Math.max(0, Math.min(LAST_SLOT_MIN, Math.round(pixelY / 15) * 15));
  return {
    hours:   Math.floor(snapped / 60),
    minutes: snapped % 60,
    snapped,
  };
}

// "7:00 - 8:30 AM" when both ends share a meridiem, "11:30 AM - 12:15 PM" when
// they do not. Wraps past midnight for a block that runs into the next day.
function formatRange(hours: number, minutes: number, durationMin: number): string {
  const endTotal = (hours * 60 + minutes + durationMin) % (24 * 60);
  const endHours = Math.floor(endTotal / 60);
  const endMins  = endTotal % 60;
  const start = formatTime(hours, minutes);
  const end   = formatTime(endHours, endMins);
  const samePeriod = (hours < 12) === (endHours < 12);
  return `${samePeriod ? start.replace(/ [AP]M$/, '') : start} - ${end}`;
}

// ── Hover tooltip ─────────────────────────────────────────────────────────────

let tooltipEl: HTMLElement | null = null;
function getTooltip(): HTMLElement {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'wlp-drop-tooltip';
    tooltipEl.setAttribute('data-wlp-theme', currentTheme);
    // An English line with the name isolated in it, so it reads left to right
    // on a right-to-left page too, as the sidebar does.
    tooltipEl.dir = 'ltr';
    Object.assign(tooltipEl.style, {
      position: 'fixed', zIndex: '10001', pointerEvents: 'none',
      padding: '8px 12px', borderRadius: '6px', fontSize: '13px',
      fontFamily: "'Roboto', -apple-system, sans-serif",
      whiteSpace: 'nowrap', boxShadow: '0 4px 6px rgba(0,0,0,0.15)', display: 'none',
    });
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}
function showTooltip(x: number, y: number, text: string): void {
  const el = getTooltip();
  el.textContent = text;
  el.style.left = `${x + 18}px`;
  el.style.top  = `${y - 14}px`;
  el.style.display = 'block';
}
function hideTooltip(): void { if (tooltipEl) tooltipEl.style.display = 'none'; }

// ── Event preview block ───────────────────────────────────────────────────────

let previewEl: HTMLElement | null = null;
function getPreview(): HTMLElement {
  if (!previewEl) {
    previewEl = document.createElement('div');
    previewEl.id = 'wlp-event-preview';
    previewEl.setAttribute('data-wlp-theme', currentTheme);
    // It only ever holds an item's name, so it takes the name's direction: a
    // Hebrew one starts at the right, as Google's own chip for it will.
    previewEl.dir = 'auto';
    Object.assign(previewEl.style, {
      position: 'fixed', zIndex: '9999', pointerEvents: 'none',
      borderRadius: '4px', fontSize: '12px', lineHeight: '16px',
      // The sidebar's typeface, so the preview reads as the chip it came from.
      fontFamily: "'Google Sans', Roboto, Arial, sans-serif",
      fontWeight: '500',
      overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
      boxSizing: 'border-box', display: 'none',
    });
    document.body.appendChild(previewEl);
  }
  return previewEl;
}
// The preview is the item's chip in the sidebar laid on the grid: the same
// colour, text colour, type and corners, so what is dragged, what is about to
// land and the event Google then draws all look alike. It is lifted off the
// grid with Google's elevation shadow, which also tells it from the loading
// placeholder, a flat block that pulses.
//
// A recurring drop commits a series that repeats forever, so the preview has
// to look different the moment Shift goes down: content.css dashes its border
// in the text colour and adds a repeat glyph while the class is on. The solid
// border in the chip's own colour is there so that dashing it does not change
// the block's size.
function showPreview(cell: Element, clientY: number, item: DropPoolItem, recurring: boolean): void {
  const el = getPreview();
  cancelFade();
  el.classList.remove('wlp-preview-loading');
  el.classList.toggle('wlp-preview-recurring', recurring);
  const { snapped } = timeFromDrop(cell, clientY);
  const rect = cell.getBoundingClientRect();
  const color = previewColor(item);
  // 1 px = 1 min in the time grid, so the block's pixel height is its duration.
  Object.assign(el.style, {
    top: `${rect.top + snapped}px`, left: `${rect.left + 2}px`,
    width: `${rect.width - 4}px`,  height: `${durationOf(item)}px`,
    display: 'block', opacity: '1', animation: 'none',
    background: color,
    border: `1px solid ${color}`,
    borderRadius: '4px', color: chipTextOn(color), padding: '2px 8px',
    boxShadow: '0 1px 3px 0 rgba(60, 64, 67, 0.3), 0 4px 8px 3px rgba(60, 64, 67, 0.15)',
  });
  el.textContent = item.name;
}
function hidePreview(): void {
  if (isLoading) return; // don't clobber the loading overlay
  if (previewEl) previewEl.style.display = 'none';
}

// ── Drop loading overlay ──────────────────────────────────────────────────────

let isLoading          = false;
let loadingCell:       Element | null = null;
let loadingSnapped:    number = 0;
let loadingScrollCleanup: (() => void) | null = null;
let eventObserver:     MutationObserver | null = null;
let eventTimeout:      ReturnType<typeof setTimeout> | null = null;

function applyLoadingPosition(): void {
  if (!previewEl || !loadingCell) return;
  const rect = loadingCell.getBoundingClientRect();
  previewEl.style.top   = `${rect.top  + loadingSnapped}px`;
  previewEl.style.left  = `${rect.left + 2}px`;
  previewEl.style.width = `${rect.width - 4}px`;
}

// Takes the start as minutes past midnight rather than a pointer position, so
// the schedule form, which has no pointer, can anchor a placeholder too.
function showLoading(cell: Element, startMin: number, item: DropPoolItem, recurring: boolean): void {
  const el        = getPreview();
  cancelFade();
  // The placeholder keeps the repeat glyph but not the dashed border.
  el.classList.add('wlp-preview-loading');
  el.classList.toggle('wlp-preview-recurring', recurring);
  const rect      = cell.getBoundingClientRect();
  const calColor  = previewColor(item);

  loadingCell    = cell;
  loadingSnapped = startMin;

  Object.assign(el.style, {
    top: `${rect.top + startMin}px`, left: `${rect.left + 2}px`,
    width: `${rect.width - 4}px`,  height: `${durationOf(item)}px`,
    display: 'block', opacity: '1',
    background: calColor, border: 'none', borderRadius: '4px', boxShadow: 'none',
    padding: '4px 8px', fontSize: '12px', fontWeight: '500',
    color: chipTextOn(calColor), boxSizing: 'border-box',
    overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
    animation: 'wlp-event-loading 1.1s ease-in-out infinite',
    transition: 'opacity 0.35s ease',
  });
  el.textContent = item.name;
  isLoading = true;

  // Keep the overlay anchored to the cell as the user scrolls. A second
  // placement can start while the first is still pulsing, and the element is
  // shared, so the earlier listener is removed rather than left behind for
  // the life of the page.
  loadingScrollCleanup?.();
  const onScroll = () => applyLoadingPosition();
  document.addEventListener('scroll', onScroll, true);
  loadingScrollCleanup = () => document.removeEventListener('scroll', onScroll, true);
}

// The fade's last step hides the element, which by then may be showing the
// next drag's preview or the next placement's placeholder. Anything that shows
// the element again cancels it.
let fadeTimer: ReturnType<typeof setTimeout> | null = null;

function cancelFade(): void {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
}

function hideLoading(fadeOut = false): void {
  isLoading   = false;
  loadingCell = null;
  loadingScrollCleanup?.();
  loadingScrollCleanup = null;

  const el = previewEl;
  if (!el) return;
  cancelFade();
  if (fadeOut) {
    el.style.animation = 'none';
    el.style.opacity   = '0';
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      el.style.display   = 'none';
      el.style.opacity   = '1';
      el.style.animation = 'none';
    }, 350);
  } else {
    el.style.display   = 'none';
    el.style.animation = 'none';
  }
}

// ── Finding the created event ─────────────────────────────────────────────────
//
// Google Calendar puts a data-eventid on every event chip it renders. It is
// believed to be base64url of "<eventId> <calendarId>" with the padding
// stripped (the same string as the eid in an event's htmlLink), and on some
// views it may be the bare event id. A recurring event renders one chip per
// instance, whose id is "<eventId>_<instant>". Every form is accepted, and
// anything that does not decode simply fails to match.

function decodeBase64Url(value: string): string | null {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  } catch {
    return null;
  }
}

function isSameEvent(id: string, eventId: string): boolean {
  return id === eventId || id.startsWith(`${eventId}_`);
}

function chipIsEvent(dataEventId: string, eventId: string): boolean {
  if (isSameEvent(dataEventId, eventId)) return true;
  const decoded = decodeBase64Url(dataEventId);
  return decoded !== null && isSameEvent(decoded.split(' ')[0], eventId);
}

function containsEventChip(el: Element, eventId: string): boolean {
  const chips = el.matches('[data-eventid]')
    ? [el, ...Array.from(el.querySelectorAll('[data-eventid]'))]
    : Array.from(el.querySelectorAll('[data-eventid]'));
  return chips.some((chip) => chipIsEvent(chip.getAttribute('data-eventid') ?? '', eventId));
}

// Matching on the name alone lets any other event with the same name resolve
// the placeholder, typically when Google Calendar re-renders the column the
// new event is about to appear in. So a name match only resolves it after this
// long without an id match, which keeps today's behaviour on any view where the
// id cannot be read, at the cost of a slightly later fade there.
const NAME_MATCH_GRACE_MS = 1500;
const EVENT_WAIT_TIMEOUT_MS = 12000;

let waitingForEventId: string | null = null;
let nameMatchTimer:    ReturnType<typeof setTimeout> | null = null;

function stopWaiting(): void {
  eventObserver?.disconnect();
  eventObserver = null;
  if (eventTimeout)   { clearTimeout(eventTimeout);   eventTimeout   = null; }
  if (nameMatchTimer) { clearTimeout(nameMatchTimer); nameMatchTimer = null; }
  waitingForEventId = null;
}

function resolvePlaceholder(): void {
  stopWaiting();
  hideLoading(true);
}

function waitForEvent(eventId: string | undefined, itemName: string): void {
  stopWaiting();
  waitingForEventId = eventId ?? null;

  const root = document.querySelector('[role="main"]') ?? document.body;

  // Fallback: give up after 12 s
  eventTimeout = setTimeout(resolvePlaceholder, EVENT_WAIT_TIMEOUT_MS);

  // Google Calendar can learn about the event before our response comes back,
  // in which case its chip is already on screen and no mutation will follow.
  if (eventId && containsEventChip(root, eventId)) { resolvePlaceholder(); return; }

  eventObserver = new MutationObserver((mutations) => {
    let nameSeen = false;
    for (const mut of mutations) {
      // A chip that is recycled rather than re-created only changes its attribute.
      const nodes = mut.type === 'attributes' ? [mut.target] : Array.from(mut.addedNodes);
      for (const node of nodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.closest?.('#weekly-life-pool-sidebar')) continue;
        if (eventId && containsEventChip(el, eventId)) { resolvePlaceholder(); return; }
        if (mut.type === 'childList' && (el.textContent ?? '').includes(itemName)) nameSeen = true;
      }
    }
    // The whole batch is checked for the id first: a re-render usually adds the
    // new chip and its same-named neighbours together.
    if (!nameSeen) return;
    if (!eventId) { resolvePlaceholder(); return; }
    if (!nameMatchTimer) nameMatchTimer = setTimeout(resolvePlaceholder, NAME_MATCH_GRACE_MS);
  });

  eventObserver.observe(root, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['data-eventid'],
  });
}

// ── Custom events ─────────────────────────────────────────────────────────────

// What the sidebar needs to undo a drop. It rides on 'created' next to
// itemName, which every event type still carries. itemId tells the sidebar
// which row to return keyboard focus to once Undo has removed itself.
interface CreatedEvent {
  eventId:    string;
  calendarId: string;
  recurring:  boolean;
  itemId:     string;
}

function dispatchPoolEvent(
  type: 'creating' | 'created' | 'error',
  itemName: string,
  extra: { error?: string; recurring?: boolean; event?: CreatedEvent } = {},
): void {
  document.dispatchEvent(new CustomEvent('poolEvent', { detail: { type, itemName, ...extra } }));
}

// ── Shared helpers ────────────────────────────────────────────────────────────

// An event target is not always an Element: dragging or dropping over text hands
// back a text node, which has no closest(). Resolving to the parent element
// rather than bailing out keeps a drop aimed at text working.
function closestFrom(target: EventTarget | null, selector: string): Element | null {
  const node = target as Node | null;
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return el?.closest(selector) ?? null;
}

// Reloading the extension orphans any content script already on the page:
// chrome.runtime.id becomes undefined and sendMessage throws "Extension context
// invalidated". Surface that as a failed send rather than an uncaught error.
//
// A send that does reach Chrome can still go unanswered, for instance when the
// service worker is stopped mid-request. The callback then gets no response
// and the reason only in lastError, which Chrome also reports as an error on
// the extensions page when nothing reads it, so it is turned into a failed
// response carrying that reason.
function sendToBackground(message: unknown, onResponse: (response: any) => void): boolean {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return false;
  try {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      onResponse(lastError ? { success: false, error: lastError.message } : response);
    });
    return true;
  } catch {
    return false;
  }
}

// ── Event body ────────────────────────────────────────────────────────────────

// An item's template fields map one-to-one onto events.insert, so a drop
// produces the event the user would otherwise have typed by hand. Every field
// is omitted when the item does not set it: an empty `location` is a real value
// to the API, and sending `reminders` at all turns off the calendar's defaults.
//
// A Shift-drop adds a weekly RRULE with no UNTIL or COUNT, so the series runs
// until the user ends it. The API rejects a recurring event whose start and end
// carry no timeZone, and it is also the zone the weekly instances are expanded
// in, so they stay at the same wall-clock time across a DST change. That zone
// is the one the grid is drawn in, which eventTimes() works out.
function eventBody(item: DropPoolItem, start: EventDateTime, end: EventDateTime, recurring: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary:    item.name,
    calendarId: item.calendarId,
    start,
    end,
  };

  if (item.description?.trim()) body.description = item.description.trim();
  if (item.location?.trim())    body.location    = item.location.trim();
  if (item.colorId)             body.colorId     = item.colorId;
  if (recurring)                body.recurrence  = ['RRULE:FREQ=WEEKLY'];
  // 0 is a valid reminder ("at start"), so this checks for undefined, not falsy.
  if (item.reminderMin !== undefined) {
    body.reminders = {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: item.reminderMin }],
    };
  }

  return body;
}

// ── Creating an event from an item ────────────────────────────────────────────

// The one way an item becomes an event. A drop, a click while an item is
// picked and the sidebar's schedule form all end here, so the event body, the
// toast sequence ('creating', then 'created' with Undo, or 'error') and the
// weekly wording cannot drift apart between them.
//
// The anchor is the day column the placeholder pulses in. The schedule form
// can name a day that is not on screen, and then there is nothing to anchor
// it to: the toast alone reports progress, and nothing waits for the chip,
// because starting a wait would cancel the one a pending drop placeholder is
// relying on, and the end of this wait would then fade that placeholder.
function createFromItem(
  item: DropPoolItem,
  date: Date,
  hours: number,
  minutes: number,
  recurring: boolean,
  anchor: Element | null,
): void {
  // The grid's date and time are wall-clock time in Google Calendar's zone,
  // not the browser's, so the zone is worked out before they become instants.
  const { start, end, zone } = eventTimes(date, hours, minutes, durationOf(item), gridZoneLabels());
  console.log('[WeeklyPool] Calendar time zone →', zone, start.dateTime);

  // Show the pulsing placeholder at the chosen slot immediately
  if (anchor) showLoading(anchor, hours * 60 + minutes, item, recurring);
  const fail = (error?: string) => {
    dispatchPoolEvent('error', item.name, { error });
    if (anchor) hideLoading(true);
  };

  dispatchPoolEvent('creating', item.name, { recurring });
  const sent = sendToBackground(
    { type: 'CREATE_EVENT', data: eventBody(item, start, end, recurring) },
    (response) => {
      if (response?.success) {
        const { id, calendarId } = response.data ?? {};
        dispatchPoolEvent('created', item.name, {
          recurring,
          event: id && calendarId ? { eventId: id, calendarId, recurring, itemId: item.id } : undefined,
        });
        // Watch for GCal to render the event, then fade out the placeholder
        if (anchor) waitForEvent(id, item.name);
      } else {
        fail(response?.error);
      }
    }
  );

  if (!sent) fail('Extension reloaded - refresh the page');
}

// ── Placement hint ────────────────────────────────────────────────────────────

// The tooltip and preview block shown over the time grid, both while dragging
// and while a picked item follows the pointer, so a click places exactly what a
// drop at the same spot would. The preview element doubles as the loading
// placeholder, so while one is pulsing only the tooltip follows the pointer:
// redrawing the element would move the placeholder off its event.
function showPlacementHint(cell: Element, clientX: number, clientY: number, item: DropPoolItem, recurring: boolean): void {
  const date = dateFromCell(cell);
  if (!date) return;
  const { hours, minutes } = timeFromDrop(cell, clientY);
  const day = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const repeats = recurring ? '  ·  ↻ repeats weekly' : '';
  // The name is isolated so a Hebrew one does not reorder the day and time.
  showTooltip(clientX, clientY, `${isolate(item.name)}  ·  ${day}, ${formatRange(hours, minutes, durationOf(item))}${repeats}`);
  if (!isLoading) showPreview(cell, clientY, item, recurring);
}

// ── Picked item (click-to-place) ──────────────────────────────────────────────
//
// Picking an item in the sidebar is the way to schedule without dragging.
// While one is picked, a click on the time grid places it where a drop there
// would, and Shift-click makes it weekly as Shift-drop does. The sidebar owns
// which item is picked and reports it with poolPickChange; this script reports
// back with poolPickDone once a click has used the pick up.

let pickedItem: DropPoolItem | null = null;

// Where the pointer last was while an item is picked, so the hint can be
// redrawn when Shift changes or the grid scrolls under a pointer that has not
// moved, neither of which fires a mousemove.
let lastPointer: { target: EventTarget | null; x: number; y: number; shift: boolean } | null = null;

// A double-click is two clicks. The first places the item, and the second
// would reach Google Calendar's own click-to-create and open its quick-create
// dialog on top of the new event, so clicks on the time grid this soon after
// a place are swallowed too.
const PLACE_SETTLE_MS = 500;
let settleUntil = 0;

function refreshPickedHint(): void {
  if (!pickedItem || !lastPointer) return;
  const { target, x, y, shift } = lastPointer;
  const cell = closestFrom(target, '[role="gridcell"]');
  if (!cell) { hideTooltip(); hidePreview(); return; }
  if (!isTimeGridCell(cell)) {
    hidePreview();
    showTooltip(x, y, 'Switch to Day or Week view to place here');
    return;
  }
  showPlacementHint(cell, x, y, pickedItem, shift);
}

function clearPick(): void {
  pickedItem  = null;
  lastPointer = null;
  hideTooltip();
  hidePreview();
}

function placePicked(cell: Element, e: MouseEvent): void {
  const item = pickedItem;
  const date = dateFromCell(cell);
  if (!item || !date) { console.warn('[WeeklyPool] Could not resolve a date for cell', cell); return; }
  console.log(`[WeeklyPool] Place → datekey=${findDatekey(cell)} → ${date.toDateString()}`);

  const { hours, minutes } = timeFromDrop(cell, e.clientY);
  clearPick();
  settleUntil = performance.now() + PLACE_SETTLE_MS;
  document.dispatchEvent(new CustomEvent('poolPickDone'));
  // Shift is read from the click itself, as a drop reads it from the release.
  createFromItem(item, date, hours, minutes, e.shiftKey, cell);
}

// What the sidebar's schedule form sends. It names a day and a time but has
// no pointer, so the placeholder can only go in that day's column if the time
// grid is showing it.
interface ScheduleRequest {
  item:      DropPoolItem;
  date:      Date;
  hours:     number;
  minutes:   number;
  recurring: boolean;
}

// ── Listeners ─────────────────────────────────────────────────────────────────

let draggingItem: DropPoolItem | null = null;

// Every event of a press on the time grid, not just the click: Google Calendar
// begins its own click-to-create (and drag-to-create) on the press, so letting
// that through would open its quick-create dialog over our event.
const GRID_PRESS_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'];

function setupListeners(): void {
  document.addEventListener('poolDragStart', (e: Event) => {
    draggingItem = (e as CustomEvent).detail.item as DropPoolItem;
  });
  document.addEventListener('poolDragEnd', () => {
    draggingItem = null; hideTooltip(); hidePreview();
  });
  document.addEventListener('poolSidebarToggle', (e: Event) => {
    adjustLayout((e as CustomEvent).detail.collapsed as boolean);
  });
  // An Undo inside the window can delete the event before Google Calendar ever
  // renders it, and then nothing would resolve the placeholder until timeout.
  document.addEventListener('poolEventRemoved', (e: Event) => {
    if ((e as CustomEvent).detail.eventId === waitingForEventId) resolvePlaceholder();
  });

  const isPoolDrag = (e: DragEvent) =>
    e.dataTransfer?.types.some((t) => t.toLowerCase() === 'poolitem') ?? false;

  document.addEventListener('dragover', (e: DragEvent) => {
    if (!isPoolDrag(e)) return;
    const cell = closestFrom(e.target, '[role="gridcell"]');
    if (!cell) { hideTooltip(); hidePreview(); return; }
    // Deliberately no preventDefault() outside the time grid: without it the
    // browser refuses the drop, so the user gets a "no drop" cursor and the
    // tooltip below explains where to aim instead.
    if (!isTimeGridCell(cell)) {
      hidePreview();
      if (draggingItem) showTooltip(e.clientX, e.clientY, 'Switch to Day or Week view to drop here');
      return;
    }
    e.preventDefault();
    // dragover keeps firing while the pointer is still, so pressing or
    // releasing Shift mid-drag updates this without a mouse move.
    if (draggingItem) showPlacementHint(cell, e.clientX, e.clientY, draggingItem, e.shiftKey);
  });

  document.addEventListener('drop', (e: DragEvent) => {
    const cell = closestFrom(e.target, '[role="gridcell"]');
    if (!cell) return;
    const raw = e.dataTransfer?.getData('poolItem');
    if (!raw) return;
    if (!isTimeGridCell(cell)) return;
    e.preventDefault();
    hideTooltip();
    // Note: hidePreview() deliberately skipped here — showLoading() takes over the element

    let item: DropPoolItem;
    try { item = JSON.parse(raw); } catch { return; }

    const date = dateFromCell(cell);
    if (!date) { console.warn('[WeeklyPool] Could not resolve a date for cell', cell); return; }
    console.log(`[WeeklyPool] Drop → datekey=${findDatekey(cell)} → ${date.toDateString()}`);

    const { hours, minutes } = timeFromDrop(cell, e.clientY);
    // Read from the drop itself rather than the last dragover, so what is
    // created is whatever the key says at the moment of release.
    createFromItem(item, date, hours, minutes, e.shiftKey, cell);
  });

  // ── Click-to-place ──

  document.addEventListener('poolPickChange', (e: Event) => {
    const item = (e as CustomEvent).detail.item as DropPoolItem | null;
    if (item) {
      pickedItem = item;
      refreshPickedHint();
    } else if (pickedItem) {
      clearPick();
    }
  });

  // On window in the capture phase, like the press handling below, so nothing
  // Google Calendar does with mousemove on the grid can hide it from us.
  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!pickedItem) return;
    lastPointer = { target: e.target, x: e.clientX, y: e.clientY, shift: e.shiftKey };
    refreshPickedHint();
  }, { capture: true, passive: true });

  const onShift = (e: KeyboardEvent) => {
    if (e.key !== 'Shift' || !pickedItem || !lastPointer) return;
    lastPointer.shift = e.type === 'keydown';
    refreshPickedHint();
  };
  window.addEventListener('keydown', onShift, true);
  window.addEventListener('keyup',   onShift, true);
  document.addEventListener('scroll', refreshPickedHint, { capture: true, passive: true });

  // Capturing on window runs ahead of anything Google Calendar listens with on
  // the document or the grid. Nothing is touched unless an item is picked (or
  // was placed a moment ago) and the press is a primary-button one on a time
  // grid cell, so Google Calendar's own click-to-create, its event popovers and
  // its right-click menu all work as usual the rest of the time.
  const onGridPress = (e: MouseEvent) => {
    if (!pickedItem && performance.now() > settleUntil) return;
    if (e.button !== 0) return;
    const cell = closestFrom(e.target, '[role="gridcell"]');
    if (!cell || !isTimeGridCell(cell)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && pickedItem) placePicked(cell, e);
  };
  for (const type of GRID_PRESS_EVENTS) {
    window.addEventListener(type, onGridPress as EventListener, true);
  }

  // ── Schedule form ──

  document.addEventListener('poolScheduleItem', (e: Event) => {
    const { item, date, hours, minutes, recurring } = (e as CustomEvent).detail as ScheduleRequest;
    createFromItem(item, date, hours, minutes, recurring, timeGridCellFor(date));
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function injectSidebar(): void {
  const mainEl = document.querySelector<HTMLElement>('[role="main"]');
  if (!mainEl) { setTimeout(injectSidebar, 500); return; }
  if (document.getElementById('weekly-life-pool-sidebar')) return;

  const sidebarEl = document.createElement('div');
  sidebarEl.id = 'weekly-life-pool-sidebar';
  // Its words are English, so it keeps its own left-to-right order when Google
  // Calendar is in a right-to-left language; names in it still take their own
  // direction (names.ts). layout.ts says where it sits on such a page.
  sidebarEl.dir = 'ltr';
  document.body.insertBefore(sidebarEl, document.body.firstChild);
  // Before the first render, so the sidebar never flashes light on a dark page.
  watchTheme(applyTheme);

  try {
    ReactDOM.createRoot(sidebarEl).render(<PoolSidebar />);
    setupListeners();
    // The sidebar says how wide it is once it has read the stored choice and
    // whether Google's main menu is open (poolSidebarToggle), so the page is
    // shifted once, to the right width, rather than to the stored one first.
    // Without storage it never reads one, so it is laid out open here.
    if (typeof chrome === 'undefined' || !chrome.storage) adjustLayout(false);
    console.log('[WeeklyPool] Sidebar injected.');
  } catch (err) {
    console.error('[WeeklyPool] Failed to render sidebar:', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectSidebar);
} else {
  setTimeout(injectSidebar, 500);
}
