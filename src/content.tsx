import React from 'react';
import ReactDOM from 'react-dom/client';
import PoolSidebar from './components/PoolSidebar';
import { PoolItem, durationOf, eventColorHex } from './poolItem';
import './content.css';

// What crosses the drag: the stored item plus the colour of the calendar it
// lives in, which the sidebar knows and storage does not.
type DropPoolItem = PoolItem & { color?: string };

const SIDEBAR_WIDTH   = 280;
const COLLAPSED_WIDTH = 40;
const PIXELS_PER_HOUR = 60; // 1 px = 1 minute

const FALLBACK_COLOR = '#4285f4';

// An item with its own colorId will render in that colour once Google Calendar
// draws it, so the preview and the loading placeholder use it too.
function previewColor(item: DropPoolItem): string {
  return eventColorHex(item.colorId, item.color ?? FALLBACK_COLOR);
}

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

const DATEKEY_EPOCH_YEAR = 1970;

function datekeyToDate(datekey: string): Date | null {
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
function findDatekey(cell: Element): string | null {
  const el = cell.closest('[data-datekey]');
  return el ? el.getAttribute('data-datekey') : null;
}
function dateFromCell(cell: Element): Date | null {
  const datekey = findDatekey(cell);
  return datekey ? datekeyToDate(datekey) : null;
}

// ── Layout ────────────────────────────────────────────────────────────────────

// transform: translateX() shifts Google Calendar's root including its own fixed
// children (FAB, top bar) because transform creates a new containing block for
// position:fixed descendants — they shift right along with the container.
function getGcalRoot(): HTMLElement | null {
  // Walk up from [role="main"] to the direct child of <body>.
  // This is reliable regardless of how many wrapper divs Google Calendar uses.
  const mainEl = document.querySelector<HTMLElement>('[role="main"]');
  if (!mainEl) return null;
  let el: HTMLElement = mainEl;
  while (el.parentElement && el.parentElement.tagName !== 'BODY') {
    el = el.parentElement as HTMLElement;
  }
  if (el.id === 'weekly-life-pool-sidebar') return null;
  return el;
}

function adjustLayout(collapsed: boolean): void {
  const px = collapsed ? COLLAPSED_WIDTH : SIDEBAR_WIDTH;
  const root = getGcalRoot();
  if (!root) { console.warn('[WeeklyPool] adjustLayout: no root found'); return; }
  console.log('[WeeklyPool] adjustLayout: shifting', root.tagName, root.id || root.className.slice(0, 60), 'by', px, 'px');
  root.style.transform  = `translateX(${px}px)`;
  root.style.width      = `calc(100% - ${px}px)`;
  root.style.transition = 'transform 0.2s ease-in-out, width 0.2s ease-in-out';
}

// ── Time helper ───────────────────────────────────────────────────────────────

// timeFromDrop reads a drop offset as "minutes since midnight", which only holds
// in the week/day time grid, where a gridcell is one whole day column at
// PIXELS_PER_HOUR (24 h => ~1440 px). Month-view cells and the all-day row are
// also [role="gridcell"] with a datekey, but they are a fraction of that height,
// so the same arithmetic there yields an arbitrary time. Require most of a full
// day's height before trusting the offset.
const TIME_GRID_MIN_HEIGHT = 20 * PIXELS_PER_HOUR;

function isTimeGridCell(cell: Element): boolean {
  return cell.getBoundingClientRect().height >= TIME_GRID_MIN_HEIGHT;
}

function timeFromDrop(cell: Element, clientY: number): { hours: number; minutes: number; snapped: number } {
  const pixelY = clientY - cell.getBoundingClientRect().top;
  const snapped = Math.round(pixelY / 15) * 15;
  return {
    hours:   Math.max(0, Math.min(23, Math.floor(snapped / 60))),
    minutes: snapped % 60,
    snapped,
  };
}
function formatTime(hours: number, minutes: number): string {
  const period = hours < 12 ? 'AM' : 'PM';
  const h = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${h}:${minutes.toString().padStart(2, '0')} ${period}`;
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
    Object.assign(tooltipEl.style, {
      position: 'fixed', zIndex: '10001', pointerEvents: 'none',
      background: '#202124', color: '#fff', padding: '8px 12px',
      borderRadius: '6px', fontSize: '13px',
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
    Object.assign(previewEl.style, {
      position: 'fixed', zIndex: '9999', pointerEvents: 'none',
      background: 'rgba(66,133,244,0.2)', border: '2px solid rgba(66,133,244,0.55)',
      borderRadius: '2px', fontSize: '12px',
      fontFamily: "'Roboto', -apple-system, sans-serif",
      color: '#1a73e8', fontWeight: '500', padding: '2px 6px',
      overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
      boxSizing: 'border-box', display: 'none',
    });
    document.body.appendChild(previewEl);
  }
  return previewEl;
}
function showPreview(cell: Element, clientY: number, item: DropPoolItem): void {
  const el = getPreview();
  const { snapped } = timeFromDrop(cell, clientY);
  const rect = cell.getBoundingClientRect();
  const color = previewColor(item);
  // 1 px = 1 min in the time grid, so the block's pixel height is its duration.
  Object.assign(el.style, {
    top: `${rect.top + snapped}px`, left: `${rect.left + 2}px`,
    width: `${rect.width - 4}px`,  height: `${durationOf(item)}px`,
    display: 'block', opacity: '1', animation: 'none',
    background: color + '33',
    border: `2px solid ${color}`,
    borderRadius: '2px', color, padding: '2px 6px',
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

function showLoading(cell: Element, clientY: number, item: DropPoolItem): void {
  const el        = getPreview();
  const { snapped } = timeFromDrop(cell, clientY);
  const rect      = cell.getBoundingClientRect();
  const calColor  = previewColor(item);

  loadingCell    = cell;
  loadingSnapped = snapped;

  Object.assign(el.style, {
    top: `${rect.top + snapped}px`, left: `${rect.left + 2}px`,
    width: `${rect.width - 4}px`,  height: `${durationOf(item)}px`,
    display: 'block', opacity: '1',
    background: calColor, border: 'none', borderRadius: '4px',
    padding: '4px 8px', fontSize: '12px', fontWeight: '500',
    color: '#fff', boxSizing: 'border-box',
    overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
    animation: 'wlp-event-loading 1.1s ease-in-out infinite',
    transition: 'opacity 0.35s ease',
  });
  el.textContent = item.name;
  isLoading = true;

  // Keep the overlay anchored to the cell as the user scrolls
  const onScroll = () => applyLoadingPosition();
  document.addEventListener('scroll', onScroll, true);
  loadingScrollCleanup = () => document.removeEventListener('scroll', onScroll, true);
}

function hideLoading(fadeOut = false): void {
  isLoading   = false;
  loadingCell = null;
  loadingScrollCleanup?.();
  loadingScrollCleanup = null;

  const el = previewEl;
  if (!el) return;
  if (fadeOut) {
    el.style.animation = 'none';
    el.style.opacity   = '0';
    setTimeout(() => {
      if (!el) return;
      el.style.display   = 'none';
      el.style.opacity   = '1';
      el.style.animation = 'none';
    }, 350);
  } else {
    el.style.display   = 'none';
    el.style.animation = 'none';
  }
}

function waitForEvent(itemName: string): void {
  if (eventObserver) { eventObserver.disconnect(); eventObserver = null; }
  if (eventTimeout)  { clearTimeout(eventTimeout);  eventTimeout  = null; }

  const root = document.querySelector('[role="main"]') ?? document.body;

  // Fallback: give up after 12 s
  eventTimeout = setTimeout(() => {
    eventObserver?.disconnect();
    eventObserver = null;
    hideLoading(true);
  }, 12000);

  eventObserver = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.closest?.('#weekly-life-pool-sidebar')) continue;
        if ((el.textContent ?? '').includes(itemName)) {
          clearTimeout(eventTimeout!);
          eventObserver!.disconnect();
          eventObserver = null;
          eventTimeout  = null;
          hideLoading(true);
          return;
        }
      }
    }
  });

  eventObserver.observe(root, { childList: true, subtree: true });
}

// ── Custom events ─────────────────────────────────────────────────────────────

function dispatchPoolEvent(type: 'creating' | 'created' | 'error', itemName: string, error?: string): void {
  document.dispatchEvent(new CustomEvent('poolEvent', { detail: { type, itemName, error } }));
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
function sendToBackground(message: unknown, onResponse: (response: any) => void): boolean {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return false;
  try {
    chrome.runtime.sendMessage(message, onResponse);
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
function eventBody(item: DropPoolItem, start: Date, end: Date): Record<string, unknown> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body: Record<string, unknown> = {
    summary:    item.name,
    calendarId: item.calendarId,
    start: { dateTime: start.toISOString(), timeZone },
    end:   { dateTime: end.toISOString(),   timeZone },
  };

  if (item.description?.trim()) body.description = item.description.trim();
  if (item.location?.trim())    body.location    = item.location.trim();
  if (item.colorId)             body.colorId     = item.colorId;
  // 0 is a valid reminder ("at start"), so this checks for undefined, not falsy.
  if (item.reminderMin !== undefined) {
    body.reminders = {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: item.reminderMin }],
    };
  }

  return body;
}

// ── Drop listeners ────────────────────────────────────────────────────────────

let draggingItem: DropPoolItem | null = null;

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
    if (draggingItem) {
      const date = dateFromCell(cell);
      if (date) {
        const { hours, minutes } = timeFromDrop(cell, e.clientY);
        const duration = durationOf(draggingItem);
        const day = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        showTooltip(e.clientX, e.clientY, `${draggingItem.name}  ·  ${day}, ${formatRange(hours, minutes, duration)}`);
        showPreview(cell, e.clientY, draggingItem);
      }
    }
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
    const start = new Date(date); start.setHours(hours, minutes, 0, 0);
    // Millisecond arithmetic rather than setHours(h + n): it reads the same way
    // for any duration and rolls into the next day correctly.
    const end   = new Date(start.getTime() + durationOf(item) * 60_000);

    // Show pulsing placeholder at the exact drop position immediately
    showLoading(cell, e.clientY, item);

    dispatchPoolEvent('creating', item.name);
    const sent = sendToBackground(
      { type: 'CREATE_EVENT', data: eventBody(item, start, end) },
      (response) => {
        if (response?.success) {
          dispatchPoolEvent('created', item.name);
          // Watch for GCal to render the event, then fade out the placeholder
          waitForEvent(item.name);
        } else {
          dispatchPoolEvent('error', item.name, response?.error);
          hideLoading(true);
        }
      }
    );

    if (!sent) {
      dispatchPoolEvent('error', item.name, 'Extension reloaded - refresh the page');
      hideLoading(true);
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function injectSidebar(): void {
  const mainEl = document.querySelector<HTMLElement>('[role="main"]');
  if (!mainEl) { setTimeout(injectSidebar, 500); return; }
  if (document.getElementById('weekly-life-pool-sidebar')) return;

  const sidebarEl = document.createElement('div');
  sidebarEl.id = 'weekly-life-pool-sidebar';
  document.body.insertBefore(sidebarEl, document.body.firstChild);

  try {
    ReactDOM.createRoot(sidebarEl).render(<PoolSidebar />);
    setupListeners();
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get('sidebarCollapsed', (r) => adjustLayout(r.sidebarCollapsed === true));
    } else {
      adjustLayout(false);
    }
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
