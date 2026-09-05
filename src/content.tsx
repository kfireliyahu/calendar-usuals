import React from 'react';
import ReactDOM from 'react-dom/client';
import PoolSidebar from './components/PoolSidebar';
import './content.css';

interface DropPoolItem {
  id: string;
  name: string;
  calendarId: string;
  color?: string;
  durationMin?: number;
  description?: string;
  location?: string;
  repeat?: { freq: string; interval?: number };
}

const SIDEBAR_WIDTH   = 280;
const COLLAPSED_WIDTH = 40;
const PIXELS_PER_HOUR = 60; // 1 px = 1 minute

// Items saved before durations existed have no durationMin, so every read goes
// through here rather than reading the field directly.
const DEFAULT_DURATION_MIN = 60;
function durationOf(item: { durationMin?: number }): number {
  return item.durationMin ?? DEFAULT_DURATION_MIN;
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
function showPreview(cell: Element, clientY: number, itemName: string, color = '#4285f4', durationMin = DEFAULT_DURATION_MIN): void {
  const el = getPreview();
  const { snapped } = timeFromDrop(cell, clientY);
  const rect = cell.getBoundingClientRect();
  // 1 px = 1 min in the time grid, so the block's pixel height is its duration.
  Object.assign(el.style, {
    top: `${rect.top + snapped}px`, left: `${rect.left + 2}px`,
    width: `${rect.width - 4}px`,  height: `${durationMin}px`,
    display: 'block', opacity: '1', animation: 'none',
    background: color + '33',
    border: `2px solid ${color}`,
    borderRadius: '2px', color, padding: '2px 6px',
  });
  el.textContent = itemName;
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
  const calColor  = item.color ?? '#4285f4';

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

function dispatchPoolEvent(type: 'creating' | 'created' | 'capturing' | 'error', itemName: string, error?: string): void {
  document.dispatchEvent(new CustomEvent('poolEvent', { detail: { type, itemName, error } }));
}

// ── Capturing an existing calendar event into the pool ───────────────────────
//
// Google Calendar's event chips carry internal, undocumented ids, and it is not
// safe to assume they use HTML5 drag-and-drop at all - Google may drive their
// dragging from raw pointer events, in which case dragstart/drop never fire.
// So the capture is driven by mousedown/mouseup, which happen either way, and
// the event is identified through the Calendar API by day + title + start time
// rather than by scraping an id. The dragstart/drop path is wired up too, so the
// gesture also works if the chips are native draggables.

const CHIP_SELECTOR = '[data-eventid], [data-eventchip]';
const SIDEBAR_ID = 'weekly-life-pool-sidebar';

interface CapturedChip {
  title: string;
  date: Date;
  startMin: number | null;
}

let pendingChip: CapturedChip | null = null;

function isInsideSidebar(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.(`#${SIDEBAR_ID}`);
}

function getSidebar(): HTMLElement | null {
  return document.getElementById(SIDEBAR_ID);
}

// Chip text is "7:00am Gym" or similar, and aria-label usually leads with the
// title before a comma. Strip clock fragments so what is left can be matched
// against the event's real summary.
function stripTimes(text: string): string {
  return text
    .replace(/\d{1,2}(:\d{2})?\s*(–|—|-|to)\s*\d{1,2}(:\d{2})?\s*(am|pm)?/gi, ' ')
    .replace(/\d{1,2}:\d{2}\s*(am|pm)?/gi, ' ')
    .replace(/\d{1,2}\s*(am|pm)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chipTitle(chip: Element): string {
  const label = chip.getAttribute('aria-label') ?? '';
  const raw = label || chip.textContent || '';
  return stripTimes(label ? raw.split(',')[0] : raw);
}

// A chip is positioned within its day column, so its distance from the top of
// that column is its start time in minutes - the same 1 px = 1 min relationship
// the drop handler relies on.
function chipStartMinute(chip: Element): number | null {
  const column = chip.closest('[data-datekey]');
  if (!column || !isTimeGridCell(column)) return null;
  const offset = chip.getBoundingClientRect().top - column.getBoundingClientRect().top;
  if (!Number.isFinite(offset) || offset < 0) return null;
  return Math.round(offset);
}

function readChip(target: EventTarget | null): CapturedChip | null {
  const chip = (target as Element | null)?.closest?.(CHIP_SELECTOR);
  if (!chip || isInsideSidebar(chip)) return null;

  const date = dateFromCell(chip);
  const title = chipTitle(chip);
  if (!date || !title) return null;

  return { title, date, startMin: chipStartMinute(chip) };
}

function setSidebarArmed(armed: boolean): void {
  getSidebar()?.classList.toggle('wlp-capture-target', armed);
}

// Hand the chip to the background worker, which finds the real event and returns
// only the reusable parts of it - never the date it happened to be on.
function captureChip(chip: CapturedChip): void {
  const dayStart = new Date(chip.date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd   = new Date(dayStart);  dayEnd.setDate(dayEnd.getDate() + 1);

  dispatchPoolEvent('capturing', chip.title);

  chrome.runtime.sendMessage(
    {
      type: 'RESOLVE_EVENT',
      data: {
        dayStartISO: dayStart.toISOString(),
        dayEndISO:   dayEnd.toISOString(),
        title:       chip.title,
        startMin:    chip.startMin,
      },
    },
    (response) => {
      if (response?.success) {
        document.dispatchEvent(new CustomEvent('poolCapture', { detail: response.data }));
      } else {
        dispatchPoolEvent('error', chip.title, response?.error ?? 'Could not read that event');
      }
    }
  );
}

function setupCapture(): void {
  document.addEventListener('mousedown', (e) => {
    // Purely observational: preventing the default here would break Google
    // Calendar's own click and drag handling.
    pendingChip = readChip(e.target);
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!pendingChip) return;
    setSidebarArmed(isInsideSidebar(e.target));
  }, true);

  document.addEventListener('mouseup', (e) => {
    const chip = pendingChip;
    pendingChip = null;
    setSidebarArmed(false);
    if (chip && isInsideSidebar(e.target)) captureChip(chip);
  }, true);

  // Native drag path, in case the chips are real HTML5 draggables.
  document.addEventListener('dragstart', (e) => {
    if (isInsideSidebar(e.target)) return; // our own pool items
    pendingChip = readChip(e.target) ?? pendingChip;
  }, true);

  document.addEventListener('dragover', (e: DragEvent) => {
    if (!pendingChip || !isInsideSidebar(e.target)) return;
    e.preventDefault(); // accept the drop
    setSidebarArmed(true);
  });

  document.addEventListener('drop', (e: DragEvent) => {
    const chip = pendingChip;
    if (!chip || !isInsideSidebar(e.target)) return;
    e.preventDefault();
    pendingChip = null;
    setSidebarArmed(false);
    captureChip(chip);
  });
}

function rruleFor(repeat: { freq: string; interval?: number }): string {
  const interval = repeat.interval && repeat.interval > 1 ? `;INTERVAL=${repeat.interval}` : '';
  return `RRULE:FREQ=${repeat.freq}${interval}`;
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
    const cell = (e.target as Element).closest('[role="gridcell"]');
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
        showPreview(cell, e.clientY, draggingItem.name, draggingItem.color, duration);
      }
    }
  });

  document.addEventListener('drop', (e: DragEvent) => {
    const cell = (e.target as Element).closest('[role="gridcell"]');
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
    chrome.runtime.sendMessage(
      {
        type: 'CREATE_EVENT',
        data: {
          summary:    item.name,
          calendarId: item.calendarId,
          start: { dateTime: start.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          end:   { dateTime: end.toISOString(),   timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          ...(item.description ? { description: item.description } : {}),
          ...(item.location    ? { location:    item.location }    : {}),
          ...(item.repeat      ? { recurrence: [rruleFor(item.repeat)] } : {}),
        },
      },
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
    setupCapture();
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
