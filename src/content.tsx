import React from 'react';
import ReactDOM from 'react-dom/client';
import PoolSidebar from './components/PoolSidebar';
import './content.css';

interface DropPoolItem {
  id: string;
  name: string;
  calendarId: string;
  color?: string;
}

const SIDEBAR_WIDTH   = 280;
const COLLAPSED_WIDTH = 40;
const PIXELS_PER_HOUR = 60; // 1 px = 1 minute

// ── Datekey → Date ────────────────────────────────────────────────────────────
//
// Google Calendar's datekey is NOT a simple days-since-epoch counter.
// Every month boundary adds +2 extra to the key (the transition is +3, not +1).
// Verified: April 30 = 28830, May 1 = 28833 (+3), May 2 = 28834 (+1 normal).
//
// Formula: datekey = jan1_dk(year) + cumulative_days_in_year + 2 × (month − 1)
// Derived base: Jan 1 2026 = 28705

const DAYS_IN_MONTH_NORMAL = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const BASE_YEAR    = 2026;
const BASE_JAN1_DK = 28705;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH_NORMAL[month - 1];
}
function jan1Datekey(year: number): number {
  let dk = BASE_JAN1_DK;
  if (year > BASE_YEAR) {
    for (let y = BASE_YEAR; y < year; y++) dk += (isLeapYear(y) ? 366 : 365) + 24;
  } else if (year < BASE_YEAR) {
    for (let y = BASE_YEAR - 1; y >= year; y--) dk -= (isLeapYear(y) ? 366 : 365) + 24;
  }
  return dk;
}
function monthStartDk(year: number, month: number): number {
  let days = 0;
  for (let m = 1; m < month; m++) days += daysInMonth(year, m);
  return jan1Datekey(year) + days + 2 * (month - 1);
}
function datekeyToDate(datekey: string): Date {
  const dk = parseInt(datekey, 10);
  let year = BASE_YEAR + Math.round((dk - BASE_JAN1_DK) / 389.5);
  for (let i = 0; i < 20; i++) {
    if (dk < jan1Datekey(year))      { year--; continue; }
    if (dk >= jan1Datekey(year + 1)) { year++; continue; }
    break;
  }
  for (let m = 1; m <= 12; m++) {
    const start = monthStartDk(year, m);
    const end   = start + daysInMonth(year, m) - 1;
    if (dk >= start && dk <= end) return new Date(year, m - 1, dk - start + 1);
  }
  console.warn('[WeeklyPool] Unresolvable datekey:', dk);
  return new Date(year, 0, 1);
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
function showPreview(cell: Element, clientY: number, itemName: string, color = '#4285f4'): void {
  const el = getPreview();
  const { snapped } = timeFromDrop(cell, clientY);
  const rect = cell.getBoundingClientRect();
  Object.assign(el.style, {
    top: `${rect.top + snapped}px`, left: `${rect.left + 2}px`,
    width: `${rect.width - 4}px`,  height: `${PIXELS_PER_HOUR}px`,
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
    width: `${rect.width - 4}px`,  height: `${PIXELS_PER_HOUR}px`,
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
    e.preventDefault();
    if (draggingItem) {
      const datekey = cell.getAttribute('data-datekey');
      const date = datekey ? datekeyToDate(datekey) : null;
      if (date) {
        const { hours, minutes } = timeFromDrop(cell, e.clientY);
        const day = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        showTooltip(e.clientX, e.clientY, `${draggingItem.name}  ·  ${day}, ${formatTime(hours, minutes)}`);
        showPreview(cell, e.clientY, draggingItem.name, draggingItem.color);
      }
    }
  });

  document.addEventListener('drop', (e: DragEvent) => {
    const cell = (e.target as Element).closest('[role="gridcell"]');
    if (!cell) return;
    const raw = e.dataTransfer?.getData('poolItem');
    if (!raw) return;
    e.preventDefault();
    hideTooltip();
    // Note: hidePreview() deliberately skipped here — showLoading() takes over the element

    let item: DropPoolItem;
    try { item = JSON.parse(raw); } catch { return; }

    const datekey = cell.getAttribute('data-datekey');
    if (!datekey) { console.warn('[WeeklyPool] No data-datekey on cell', cell); return; }

    const date = datekeyToDate(datekey);
    console.log(`[WeeklyPool] Drop → datekey=${datekey} → ${date.toDateString()}`);

    const { hours, minutes } = timeFromDrop(cell, e.clientY);
    const start = new Date(date); start.setHours(hours, minutes, 0, 0);
    const end   = new Date(start); end.setHours(hours + 1, minutes, 0, 0);

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
