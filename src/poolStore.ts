// Where the pool is kept. Pool items and hidden categories are the user's own
// content, so they live in chrome.storage.sync and follow the Chrome profile to
// every machine it is signed into. Whether the sidebar is collapsed or the add
// form is open is about one screen, so that stays in chrome.storage.local and
// in the sidebar. This module is the only code that reads or writes the pool,
// which keeps the quota handling, the migration and the live updates in one
// place rather than spread through PoolSidebar.tsx.

import { PoolItem, newItemId } from './poolItem';

// What the sidebar works with: each calendar's items in display order, and the
// calendars it hides.
export interface PoolData {
  items: Record<string, PoolItem[]>;
  hidden: string[];
}

// ── Layout ───────────────────────────────────────────────────────────────────
//
// chrome.storage.sync allows about 100 KB in all, but only 8 KB per key and 512
// keys. The old layout, one poolItems object, put every free-text description
// in a single value, which passes 8 KB long before the pool is anywhere near
// 100 KB. One key per calendar only moves that wall to a busy calendar. So
// every item gets a key of its own, which only a description several pages
// long can outgrow, and each calendar keeps its order as a list of ids:
//
//   item:<id>           one PoolItem
//   order:<calendarId>  the ids shown under that calendar, in display order
//   hiddenCategories    the calendar ids the sidebar hides
//   poolSchema          1; says sync holds a pool, even one emptied since
//
// It also keeps writes small and separate: a rename writes one item, not the
// whole pool, and two machines that edit different items both keep their edit.
// A reorder writes only that calendar's order list.

type Entries = Record<string, unknown>;

const ITEM_PREFIX    = 'item:';
const ORDER_PREFIX   = 'order:';
const HIDDEN_KEY     = 'hiddenCategories';
const SCHEMA_KEY     = 'poolSchema';
const SCHEMA_VERSION = 1;

function isPoolKey(key: string): boolean {
  return key.startsWith(ITEM_PREFIX) || key.startsWith(ORDER_PREFIX) || key === HIDDEN_KEY || key === SCHEMA_KEY;
}

// The pool as it was kept before sync, in chrome.storage.local. This version
// reads it once, to migrate, and never writes it again, so it stays behind as
// a backup of the pool from before the update.
const LEGACY_ITEMS_KEY  = 'poolItems';
const LEGACY_HIDDEN_KEY = 'hiddenCategories';

// This device's copy of the pool, in chrome.storage.local, rewritten on every
// edit. `unsynced` names the keys whose value sync does not have yet: an edit
// still waiting for its debounced write, or one sync refused for quota. On the
// next load those keys win over sync, so neither a tab closed mid-debounce nor
// a pool too big to sync loses an edit.
const MIRROR_KEY = 'poolMirror';

interface Mirror {
  entries: Entries;
  unsynced: string[];
}

// ── Comparing values ─────────────────────────────────────────────────────────

// Values are compared by content, with object keys sorted, because an item that
// went through a spread and one read back from storage can list the same fields
// in a different order. Undefined fields drop out, as they do in storage.
function canonical(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

// undefined means "no such key", never a stored value.
function setEntry(entries: Entries, key: string, value: unknown): void {
  if (value === undefined) delete entries[key];
  else entries[key] = value;
}

function poolEntries(all: Entries): Entries {
  const entries: Entries = {};
  for (const [key, value] of Object.entries(all)) if (isPoolKey(key)) entries[key] = value;
  return entries;
}

// ── Entries ↔ PoolData ───────────────────────────────────────────────────────

// Sync can deliver another machine's write in pieces, so an item can arrive
// before the order list that names it, or a move can show it in two lists for
// a moment. Every item is still shown exactly once: in the list that matches
// its calendarId if more than one names it, and otherwise at the end of its
// calendarId's list. Ids whose item has not arrived, or was deleted, are
// skipped.
function toPoolData(entries: Entries): PoolData {
  const byId = new Map<string, PoolItem>();
  const orders: [string, string[]][] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (key.startsWith(ITEM_PREFIX) && value && typeof value === 'object') {
      byId.set(key.slice(ITEM_PREFIX.length), value as PoolItem);
    } else if (key.startsWith(ORDER_PREFIX) && Array.isArray(value)) {
      orders.push([key.slice(ORDER_PREFIX.length), value as string[]]);
    }
  }

  const placed = new Map<string, string>();
  for (const [calendarId, ids] of orders) {
    for (const id of ids) {
      const item = byId.get(id);
      if (!item) continue;
      const claimed = placed.get(id);
      if (claimed === undefined || (claimed !== item.calendarId && calendarId === item.calendarId)) {
        placed.set(id, calendarId);
      }
    }
  }

  const items: Record<string, PoolItem[]> = {};
  for (const [calendarId, ids] of orders) {
    const list = (items[calendarId] ??= []);
    for (const id of new Set(ids)) if (placed.get(id) === calendarId) list.push(byId.get(id)!);
  }
  const orphans = [...byId.keys()].filter((id) => !placed.has(id)).sort();
  for (const id of orphans) {
    const item = byId.get(id)!;
    (items[item.calendarId] ??= []).push(item);
  }

  const hidden = entries[HIDDEN_KEY];
  return { items, hidden: Array.isArray(hidden) ? (hidden as string[]) : [] };
}

// The old poolItems object keyed items by the calendar they were shown under,
// so that key becomes the order list and each item keeps its own calendarId
// untouched: the pool looks and drops exactly as it did. Two items sharing an
// id would collapse into one key, so a repeat gets a fresh id instead.
function entriesFromLegacy(poolItems: unknown, hidden: unknown): Entries {
  const entries: Entries = {};
  const seen = new Set<string>();
  if (poolItems && typeof poolItems === 'object') {
    for (const [calendarId, list] of Object.entries(poolItems as Record<string, PoolItem[]>)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const ids: string[] = [];
      for (const original of list) {
        const item = seen.has(original.id) ? { ...original, id: newItemId() } : original;
        seen.add(item.id);
        ids.push(item.id);
        entries[ITEM_PREFIX + item.id] = item;
      }
      entries[ORDER_PREFIX + calendarId] = ids;
    }
  }
  if (Array.isArray(hidden) && hidden.length > 0) entries[HIDDEN_KEY] = hidden;
  if (Object.keys(entries).length > 0) entries[SCHEMA_KEY] = SCHEMA_VERSION;
  return entries;
}

// Folds what the sidebar shows into the stored entries. The sidebar only knows
// the calendars this Google account owns, so a calendar it does not pass keeps
// its items and its hidden flag: with another account signed in on another
// machine, those belong to calendars this one cannot see. Returns null when
// nothing changed, which is also how a change that came in from sync, and was
// handed to the sidebar, is kept from being written straight back.
function applyShown(entries: Entries, shown: PoolData): Entries | null {
  const current = toPoolData(entries);
  const next: Entries = { ...entries };

  const kept = new Set<string>();
  for (const [calendarId, items] of Object.entries(current.items)) {
    if (!(calendarId in shown.items)) items.forEach((item) => kept.add(item.id));
  }
  for (const [calendarId, items] of Object.entries(shown.items)) {
    const ids = items.map((item) => item.id);
    if (!same(ids, (current.items[calendarId] ?? []).map((item) => item.id))) {
      setEntry(next, ORDER_PREFIX + calendarId, ids.length > 0 ? ids : undefined);
    }
    for (const item of items) {
      kept.add(item.id);
      if (!same(item, entries[ITEM_PREFIX + item.id])) next[ITEM_PREFIX + item.id] = item;
    }
  }
  for (const key of Object.keys(next)) {
    if (key.startsWith(ITEM_PREFIX) && !kept.has(key.slice(ITEM_PREFIX.length))) delete next[key];
  }

  const hidden = [
    ...current.hidden.filter((id) => !(id in shown.items) || shown.hidden.includes(id)),
    ...shown.hidden.filter((id) => !current.hidden.includes(id)),
  ];
  setEntry(next, HIDDEN_KEY, hidden.length > 0 ? hidden : undefined);

  if (same(next, entries)) return null;
  // Only real content marks sync as holding a pool. Writing the marker for an
  // empty first load would make a second machine with an older local pool
  // think sync had won, and hide that pool.
  next[SCHEMA_KEY] = SCHEMA_VERSION;
  return next;
}

// ── State ────────────────────────────────────────────────────────────────────

// `synced` is what chrome.storage.sync holds as far as this tab knows, and
// `desired` is what the tab wants it to hold. Every write is the difference
// between the two, so a key that differs is an edit not yet sent.
let synced:  Entries = {};
let desired: Entries = {};
let loading: Promise<PoolData> | null = null;
let loaded = false;

const changeListeners   = new Set<(pool: PoolData) => void>();
const syncFullListeners = new Set<() => void>();
let toldSyncFull = false;

function unsyncedKeys(): string[] {
  const keys = new Set([...Object.keys(desired), ...Object.keys(synced)]);
  return [...keys].filter((key) => !same(desired[key], synced[key]));
}

// Orphaned after an extension reload, the page's chrome.storage calls throw.
// There is nothing left to save to then, and the next page load starts over.
function extensionAlive(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
}

function writeMirror(): void {
  if (!extensionAlive()) return;
  const mirror: Mirror = { entries: desired, unsynced: unsyncedKeys() };
  chrome.storage.local.set({ [MIRROR_KEY]: mirror }).catch((err) => {
    console.warn('[Usuals] Could not save the pool on this device:', err);
  });
}

// ── Writing to sync ──────────────────────────────────────────────────────────
//
// Sync allows about 120 writes a minute and 1800 an hour, and typing in a
// description changes the pool on every key. Writes wait for a short pause,
// but never longer than FLUSH_MAX_WAIT_MS, and start at least FLUSH_GAP_MS
// apart. A flush is at most two writes (a remove, then a set), so editing
// nonstop stays under 24 a minute, inside the hourly limit as well. The local
// mirror is written on every edit, so the wait never risks the edit itself.

const FLUSH_DELAY_MS    = 1500;
const FLUSH_MAX_WAIT_MS = 10_000;
const FLUSH_GAP_MS      = 5000;
const RETRY_MS          = 60_000;

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSince = 0;
let lastFlushAt  = 0;
let retryAt      = 0;
let flushing     = false;

function scheduleFlush(delay = FLUSH_DELAY_MS): void {
  const now = Date.now();
  if (!pendingSince) pendingSince = now;
  const at = Math.max(
    Math.min(now + delay, pendingSince + FLUSH_MAX_WAIT_MS),
    lastFlushAt + FLUSH_GAP_MS,
    retryAt,
  );
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, Math.max(0, at - now));
}

// Chrome names the limit it hit in the message, e.g. "QUOTA_BYTES_PER_ITEM
// quota exceeded". A size limit will fail again until the pool shrinks, while
// MAX_WRITE_OPERATIONS_PER_MINUTE (or _PER_HOUR) passes with time.
function isSizeQuotaError(message: string): boolean {
  return /QUOTA_BYTES|MAX_ITEMS/.test(message);
}

async function flush(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  // The running flush looks again when it finishes.
  if (flushing || !extensionAlive()) return;

  const removed = Object.keys(synced).filter((key) => !(key in desired));
  const changed: Entries = {};
  for (const [key, value] of Object.entries(desired)) {
    if (!same(value, synced[key])) changed[key] = value;
  }
  pendingSince = 0;
  if (removed.length === 0 && Object.keys(changed).length === 0) return;

  flushing = true;
  lastFlushAt = Date.now();
  let full = false;
  try {
    // Removing first frees room for the set, when an edit both drops a long
    // item and adds a new one.
    if (removed.length > 0) {
      await chrome.storage.sync.remove(removed);
      removed.forEach((key) => delete synced[key]);
    }
    if (Object.keys(changed).length > 0) {
      await chrome.storage.sync.set(changed);
      Object.assign(synced, changed);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[Usuals] Could not sync the pool:', message);
    full = isSizeQuotaError(message);
    if (full) tellSyncFull();
    else      retryAt = Date.now() + RETRY_MS;
  }
  flushing = false;

  // Records which keys sync still lacks, so a reload keeps them from the mirror.
  writeMirror();
  // A pool that is too big is not retried on a timer; the next edit tries
  // again, which is also the edit that may have made it small enough.
  if (!full && unsyncedKeys().length > 0) scheduleFlush();
}

function tellSyncFull(): void {
  if (toldSyncFull) return;
  toldSyncFull = true;
  syncFullListeners.forEach((listener) => listener());
}

// A tab being closed or put away gets its pending edit out now rather than
// after the debounce it may not live to see.
function flushIfHidden(): void {
  if (document.visibilityState !== 'hidden' || !flushTimer || Date.now() < retryAt) return;
  flush();
}

// ── Changes from elsewhere ───────────────────────────────────────────────────
//
// onChanged fires for another machine's edits, another Calendar tab's, and this
// tab's own writes. An echo of this tab's write is a value `desired` already
// has, so it changes nothing. A key this tab has edited and not yet sent keeps
// this tab's value, which goes out with the next flush; every other key takes
// the incoming value. The sidebar hears only about real changes.

function onSyncChanged(changes: { [key: string]: chrome.storage.StorageChange }): void {
  let changed = false;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (!isPoolKey(key)) continue;
    const unsent = !same(desired[key], synced[key]);
    setEntry(synced, key, newValue);
    if (unsent || same(desired[key], newValue)) continue;
    setEntry(desired, key, newValue);
    changed = true;
  }
  if (!changed) return;
  const pool = toPoolData(desired);
  changeListeners.forEach((listener) => listener(pool));
}

// ── Public API ───────────────────────────────────────────────────────────────

// Reads the pool once per page. Which copy wins:
//   1. Keys this device changed and never got into sync, from its mirror. The
//      rest comes from sync, so another machine's edits to other items stand.
//   2. Otherwise sync, whenever it holds a pool, even if this device still has
//      an older local one: the first machine to update has already moved its
//      pool up, and the two are not merged.
//   3. Otherwise the pool from before sync, which becomes the first write.
//
// Once read, it answers with the pool as it is now, edits since included.
export function loadPool(): Promise<PoolData> {
  if (loaded) return Promise.resolve(toPoolData(desired));
  loading ??= readPool().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

async function readPool(): Promise<PoolData> {
  if (loaded) return toPoolData(desired);
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) {
    throw new Error('Chrome storage API not available');
  }

  const [all, local] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get([MIRROR_KEY, LEGACY_ITEMS_KEY, LEGACY_HIDDEN_KEY]),
  ]);
  synced = poolEntries(all);
  const mirror = local[MIRROR_KEY] as Mirror | undefined;

  if (mirror && Array.isArray(mirror.unsynced) && mirror.unsynced.length > 0) {
    desired = { ...synced };
    for (const key of mirror.unsynced) setEntry(desired, key, mirror.entries?.[key]);
  } else if (SCHEMA_KEY in synced) {
    desired = { ...synced };
  } else {
    desired = entriesFromLegacy(local[LEGACY_ITEMS_KEY], local[LEGACY_HIDDEN_KEY]);
  }

  loaded = true;
  chrome.storage.sync.onChanged.addListener(onSyncChanged);
  document.addEventListener('visibilitychange', flushIfHidden);
  if (unsyncedKeys().length > 0) {
    writeMirror();
    scheduleFlush(0);
  }
  return toPoolData(desired);
}

// Called with what the sidebar shows after any change. Nothing is written
// before loadPool has finished, so an empty sidebar can never stand in for a
// pool that has not been read yet.
export function savePool(shown: PoolData): void {
  if (!loaded) return;
  const next = applyShown(desired, shown);
  if (!next) return;
  desired = next;
  writeMirror();
  scheduleFlush();
}

// Adds the items of an imported file (poolTransfer.ts) to the pool. An item
// whose id the pool already has is left as it is, so importing a file twice,
// or into the pool it came from, adds nothing and changes nothing. New items
// go at the end of their calendar's list, a calendar folded in the file is
// folded here too, and the sidebar hears of it as it would of an edit from
// another machine. Returns the items that were added.
export function mergePool(incoming: PoolData): PoolItem[] {
  if (!loaded) throw new Error('The pool has not loaded yet');
  const current = toPoolData(desired);
  const next: Entries = { ...desired };
  const present = new Set(
    Object.keys(desired).filter((key) => key.startsWith(ITEM_PREFIX)).map((key) => key.slice(ITEM_PREFIX.length))
  );

  const added: PoolItem[] = [];
  for (const [calendarId, items] of Object.entries(incoming.items)) {
    const fresh = items.filter((item) => !present.has(item.id));
    if (fresh.length === 0) continue;
    for (const item of fresh) {
      next[ITEM_PREFIX + item.id] = item;
      present.add(item.id);
    }
    next[ORDER_PREFIX + calendarId] = [...(current.items[calendarId] ?? []).map((item) => item.id), ...fresh.map((item) => item.id)];
    added.push(...fresh);
  }
  const hidden = [...new Set([...current.hidden, ...incoming.hidden])];
  setEntry(next, HIDDEN_KEY, hidden.length > 0 ? hidden : undefined);

  if (same(next, desired)) return added;
  next[SCHEMA_KEY] = SCHEMA_VERSION;
  desired = next;
  writeMirror();
  scheduleFlush();
  const pool = toPoolData(desired);
  changeListeners.forEach((listener) => listener(pool));
  return added;
}

// Called with the whole pool after an edit made on another machine or in
// another tab, or an import.
export function subscribePool(listener: (pool: PoolData) => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

// Called once per page, the first time sync refuses the pool for size. The
// pool keeps working from this device's copy and every edit tries sync again.
export function onSyncFull(listener: () => void): () => void {
  syncFullListeners.add(listener);
  return () => { syncFullListeners.delete(listener); };
}
