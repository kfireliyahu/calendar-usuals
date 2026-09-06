import React, { useState, useEffect, useRef } from 'react';

interface PoolItem {
  id: string;
  name: string;
  calendarId: string;
  durationMin?: number;
}

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
}

interface Toast {
  message: string;
  type: 'info' | 'success' | 'error';
}

// Items saved before durations existed have no durationMin, so it is read through
// durationOf() everywhere rather than off the field directly.
const DEFAULT_DURATION_MIN = 60;
const DURATION_PRESETS = [15, 30, 45, 60, 90, 120];

function durationOf(item: PoolItem): number {
  return item.durationMin ?? DEFAULT_DURATION_MIN;
}

function formatDuration(min: number): string {
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  const mins  = min % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

// Shape of what we keep in chrome.storage.local. Every key is optional because
// storage is empty on a fresh install, so each read needs a fallback.
interface StoredState {
  poolItems?: Record<string, PoolItem[]>;
  hiddenCategories?: string[];
  sidebarCollapsed?: boolean;
  formOpen?: boolean;
}

// Compact duration control. A native <select> so it stays keyboard accessible
// without a custom dropdown; content.css strips the arrow to fit the 280px rail.
const DurationSelect: React.FC<{
  value: number;
  onChange: (min: number) => void;
}> = ({ value, onChange }) => {
  // A stored value outside the presets still has to appear as an option, or the
  // select would quietly display a duration the item does not have.
  const options = DURATION_PRESETS.includes(value)
    ? DURATION_PRESETS
    : [...DURATION_PRESETS, value].sort((a, b) => a - b);

  return (
    <select
      value={value}
      title="Duration"
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
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);
  const collapsedReady = useRef(false);
  const formReady = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One timer for every toast source, so a pending clear from an earlier toast
  // cannot wipe a newer one.
  const showToast = (message: string, type: Toast['type'], holdMs = 3000) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, type });
    if (holdMs > 0) toastTimer.current = setTimeout(() => setToast(null), holdMs);
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
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ sidebarCollapsed: collapsed });
    }
    document.dispatchEvent(new CustomEvent('poolSidebarToggle', { detail: { collapsed } }));
  }, [collapsed]);

  useEffect(() => {
    if (!formReady.current) return;
    if (typeof chrome !== 'undefined' && chrome.storage) {
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
      const { type, itemName, error: err } = (e as CustomEvent).detail;
      if (type === 'creating') {
        showToast(`Adding "${itemName}"…`, 'info', 0);

      } else if (type === 'created') {
        showToast(`"${itemName}" added!`, 'success');
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


  // ── Calendar fetch ───────────────────────────────────────────────────────────

  const fetchCalendars = () => {
    setLoading(true);
    setFetchError(null);

    if (typeof chrome === 'undefined' || !chrome.runtime) {
      setFetchError('Chrome extension API not available');
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

      const entries: CalendarListEntry[] = response.data.items ?? [];

      chrome.storage.local.get<StoredState>(['poolItems', 'hiddenCategories'], (result) => {
        const stored: Record<string, PoolItem[]> = result.poolItems ?? {};
        const hiddenIds: string[] = result.hiddenCategories ?? [];
        const newCategories: PoolCategory[] = entries.map((cal) => ({
          calendarId: cal.id,
          name: cal.summary,
          color: cal.backgroundColor ?? '#4285f4',
          items: stored[cal.id] ?? [],
          hidden: hiddenIds.includes(cal.id),
        }));
        setCategories(newCategories);
        const firstVisible = newCategories.find((c) => !c.hidden);
        setNewItemCategory((firstVisible ?? newCategories[0])?.calendarId ?? '');
        setLoaded(true);
        setLoading(false);
      });
    });
  };

  useEffect(() => { fetchCalendars(); }, []);

  // Only persist when loaded and non-empty to avoid wiping items on auth hiccups.
  useEffect(() => {
    if (!loaded || categories.length === 0) return;
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    const poolItems: Record<string, PoolItem[]> = {};
    const hiddenCategories: string[] = [];
    categories.forEach((cat) => {
      poolItems[cat.calendarId] = cat.items;
      if (cat.hidden) hiddenCategories.push(cat.calendarId);
    });
    chrome.storage.local.set({ poolItems, hiddenCategories });
  }, [categories, loaded]);

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
                  id: Date.now().toString(),
                  name: newItemName,
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

  const setItemDuration = (id: string, durationMin: number) => {
    setCategories((prev) =>
      prev.map((cat) => ({
        ...cat,
        items: cat.items.map((item) => (item.id === id ? { ...item, durationMin } : item)),
      }))
    );
  };

  const deleteItem = (id: string) => {
    setCategories((prev) =>
      prev.map((cat) => ({ ...cat, items: cat.items.filter((item) => item.id !== id) }))
    );
  };

  const toggleCategoryHidden = (calendarId: string) => {
    setCategories((prev) =>
      prev.map((cat) =>
        cat.calendarId === calendarId ? { ...cat, hidden: !cat.hidden } : cat
      )
    );
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

  const sidebarCls = `wlp-sidebar fixed left-0 top-0 h-screen border-r border-[#dadce0]/60 flex flex-col z-[1000] overflow-hidden transition-[width] duration-200 ease-in-out ${
    collapsed ? 'w-[40px]' : 'w-[280px]'
  }`;

  const iconBtnCls =
    'w-7 h-7 flex items-center justify-center rounded-full text-[#5f6368] cursor-pointer border-none bg-transparent hover:bg-[#f1f3f4] transition-colors duration-150 shrink-0';

  const toastColors: Record<Toast['type'], string> = {
    info:    'bg-[#e8f0fe] text-[#1a73e8] border-[#c5d8fc]',
    success: 'bg-[#e6f4ea] text-[#188038] border-[#b6dfc2]',
    error:   'bg-[#fce8e6] text-[#d33427] border-[#f5c6c3]',
  };

  const visibleCategories = categories.filter((c) => !c.hidden);
  const hiddenCategories  = categories.filter((c) =>  c.hidden);
  const selectedCategory  = visibleCategories.find((c) => c.calendarId === newItemCategory);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className={sidebarCls}>

      {/* ── Collapsed strip ─────────────────────────────────────────────────── */}
      {collapsed ? (
        <div className="flex flex-col items-center pt-2">
          <button
            onClick={() => setCollapsed(false)}
            title="Show Weekly Pool"
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
          <div className="wlp-header flex items-center justify-between border-b border-[#dadce0] shrink-0">
            <div className="flex items-center gap-[9px]">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
                <rect x="3" y="6" width="18" height="15" rx="2" stroke="#4285f4" strokeWidth="1.8" fill="none"/>
                <path d="M3 10h18" stroke="#4285f4" strokeWidth="1.8"/>
                <path d="M8 3v4M16 3v4" stroke="#4285f4" strokeWidth="1.8" strokeLinecap="round"/>
                <circle cx="8" cy="15" r="1.1" fill="#4285f4"/>
                <circle cx="12" cy="15" r="1.1" fill="#4285f4"/>
                <circle cx="16" cy="15" r="1.1" fill="#4285f4"/>
              </svg>
              <h2 className="m-0 text-[14px] font-medium text-[#202124] tracking-[0.1px]">
                Weekly Pool
              </h2>
            </div>
            <div className="flex items-center gap-[2px]">
              {/* Toggle form */}
              <button
                onClick={() => setFormOpen((v) => !v)}
                title={formOpen ? 'Hide input' : 'Add items'}
                className={iconBtnCls}
                style={{ color: formOpen ? '#4285f4' : undefined }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                </svg>
              </button>
              {/* Collapse sidebar */}
              <button
                onClick={() => setCollapsed(true)}
                title="Hide sidebar"
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
              <p className="text-[13px] text-[#5f6368]">Loading…</p>
            </div>
          )}

          {/* Error */}
          {!loading && fetchError && (
            <div className="p-4 flex flex-col gap-3">
              <p className="text-[13px] text-[#d33427]">{fetchError}</p>
              <button
                onClick={fetchCalendars}
                className="px-3 py-2 bg-[#4285f4] text-white border-none rounded-md text-[13px] font-medium cursor-pointer hover:bg-[#3367d6] transition-colors duration-150"
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
                  borderBottom: '1px solid rgba(218,220,224,0.6)',
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
                              '--chip-border': sel ? cat.color : '#e8eaed',
                              '--chip-color':  sel ? '#fff'    : '#5f6368',
                            } as React.CSSProperties}
                          >
                            <span
                              className="wlp-cat-chip-dot"
                              style={{ backgroundColor: sel ? 'rgba(255,255,255,0.75)' : cat.color }}
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
                      className="[font-family:inherit] placeholder-[#9aa0a6]"
                    />
                    {newItemName && (
                      <button
                        onClick={() => { setNewItemName(''); inputRef.current?.focus(); }}
                        tabIndex={-1}
                        title="Clear"
                        className="wlp-input-clear"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                      </button>
                    )}
                    <DurationSelect value={newItemDuration} onChange={setNewItemDuration} />
                    <button
                      onClick={addItem}
                      disabled={!newItemName.trim()}
                      title="Add (Enter)"
                      className="wlp-input-add"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                      </svg>
                    </button>
                  </div>

                </div>
              </div>

              {/* Toast */}
              {toast && (
                <div
                  className={`px-4 py-[9px] text-[12px] border-b shrink-0 ${toastColors[toast.type]} [animation:wlp-fadein_200ms_ease]`}
                >
                  {toast.message}
                </div>
              )}

              {/* Category list */}
              <div className="flex-1 overflow-y-auto py-3">
                {visibleCategories.map((category) => (
                  <div key={category.calendarId} className="wlp-cat-group">
                    <div
                      className="wlp-cat-header flex items-center gap-[7px]"
                      onMouseEnter={() => setHoveredCategory(category.calendarId)}
                      onMouseLeave={() => setHoveredCategory(null)}
                    >
                      <span
                        className="w-[10px] h-[10px] rounded-full shrink-0"
                        style={{ backgroundColor: category.color }}
                      />
                      <h3 className="flex-1 m-0 text-[11px] font-semibold text-[#5f6368] uppercase tracking-[0.6px]">
                        {category.name}
                      </h3>
                      <button
                        onClick={() => toggleCategoryHidden(category.calendarId)}
                        title="Hide category"
                        style={{ opacity: hoveredCategory === category.calendarId ? 1 : 0 }}
                        className="shrink-0 bg-transparent border-none cursor-pointer p-0 text-[#9aa0a6] transition-all duration-150 hover:text-[#5f6368]"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
                        </svg>
                      </button>
                    </div>
                    <div className="wlp-items-list flex flex-col">
                      {category.items.map((item) => (
                        <div
                          key={item.id}
                          draggable
                          onDragStart={(e) => {
                            const payload = { ...item, color: category.color };
                            e.dataTransfer?.setData('poolItem', JSON.stringify(payload));
                            document.dispatchEvent(new CustomEvent('poolDragStart', { detail: { item: payload } }));
                          }}
                          onDragEnd={() =>
                            document.dispatchEvent(new CustomEvent('poolDragEnd'))
                          }
                          className="wlp-item group flex items-center justify-between bg-white border border-[#e8eaed] rounded-[6px] text-[13px] text-[#202124] cursor-grab select-none transition-all duration-150 hover:border-[#c5c9ce] hover:shadow-[0_1px_4px_rgba(0,0,0,0.1)] active:cursor-grabbing active:opacity-70"
                          style={{ borderLeft: `3px solid ${category.color}` }}
                        >
                          <span className="flex-1 truncate">{item.name}</span>
                          <DurationSelect
                            value={durationOf(item)}
                            onChange={(min) => setItemDuration(item.id, min)}
                          />
                          <button
                            onClick={() => deleteItem(item.id)}
                            title="Remove"
                            className="opacity-0 group-hover:opacity-100 shrink-0 bg-transparent border-none text-[17px] leading-none text-[#bdc1c6] cursor-pointer p-0 ml-2 transition-all duration-150 hover:text-[#d33427] hover:scale-110"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      {category.items.length === 0 && (
                        <p className="px-4 py-1 text-[12px] text-[#9aa0a6] italic">
                          No items yet
                        </p>
                      )}
                    </div>
                  </div>
                ))}
                {visibleCategories.length === 0 && hiddenCategories.length === 0 && (
                  <p className="px-5 pt-5 text-[13px] text-[#5f6368]">No calendars found.</p>
                )}

                {/* Hidden categories restore strip */}
                {hiddenCategories.length > 0 && (
                  <div className="wlp-hidden-strip border-t border-[#dadce0]/60">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.6px] text-[#9aa0a6] mb-2">
                      Hidden ({hiddenCategories.length})
                    </p>
                    {hiddenCategories.map((cat) => (
                      <div key={cat.calendarId} className="wlp-hidden-row flex items-center gap-2">
                        <span className="w-[8px] h-[8px] rounded-full shrink-0 opacity-40" style={{ backgroundColor: cat.color }} />
                        <span className="flex-1 text-[12px] text-[#9aa0a6] truncate">{cat.name}</span>
                        <button
                          onClick={() => toggleCategoryHidden(cat.calendarId)}
                          title="Show category"
                          className="shrink-0 bg-transparent border-none cursor-pointer p-0 text-[#9aa0a6] hover:text-[#5f6368] transition-colors duration-150"
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
        </div>
      )}
    </div>
  );
};

export default PoolSidebar;
