# Weekly Life Pool

A Chrome extension that adds a planning sidebar to Google Calendar. Keep a pool of recurring activities organized by calendar, then drag them onto any time slot to instantly create events.

---

## Features

- **Activity pool** — store reusable items (tasks, routines, habits) grouped by your Google Calendars
- **Drag-and-drop creation** — drag any item onto the calendar grid; an event is created at the exact time and date you drop it
- **Shift-drop for weekly** — hold Shift while dropping to create a weekly series with no end date; the tooltip and a dashed, ↻-marked preview show it live as Shift goes down or up
- **Undo** — the toast after a drop offers Undo for 5 seconds, paused while the pointer or keyboard focus is on it; it deletes the event, or the whole series for a Shift-drop
- **Schedule without dragging** — each item has a calendar button: Tab to it and press Enter (or click it) to pick the item, then choose a day from the week on screen and a 15-minute start time, or click a time slot in Day or Week view to place it there; Shift-click and the form's Repeat weekly box work like Shift-drop, and Escape cancels
- **Item templates** — give an item a description, location, event colour and reminder; dropping it creates the event fully configured
- **Rename in place** — double-click an item's name; Enter or clicking away commits, Escape cancels
- **Reorder and re-file** — drag an item within its list to reorder it, or onto another calendar's heading to move it there
- **Duplicate** — clone a configured item and tweak the copy
- **Time snapping** — drops snap to the nearest 15-minute slot with a live tooltip showing day + time while hovering
- **Loading overlay** — a pulsing placeholder in the calendar's color appears at the drop location and fades out once Google Calendar renders the real event; tracks the column as you scroll
- **Category chips** — quickly switch which calendar an item belongs to before adding it
- **Hide categories** — collapse calendars you don't need to reduce sidebar noise; state survives page refresh
- **Collapsible sidebar** — collapse to a 40 px icon strip when you need the full screen
- **Collapsible input form** — toggle the add-item form open/closed with the pencil icon; preference is saved
- **Persistent storage** — pool items, hidden categories, and all UI state are saved to Chrome local storage

---

## How it works

```
Google Calendar page
└── Content script (content.tsx)
    ├── Injects the React sidebar into the page
    │   └── Sends DELETE_EVENT when the toast's Undo is pressed
    ├── Shifts Google Calendar's layout right to make room
    ├── Listens for drops, and for clicks while an item is picked, over calendar cells
    └── Sends CREATE_EVENT for a drop, a click-to-place or the schedule form

Background service worker (background.ts)
├── Authenticates with Google via chrome.identity (OAuth 2.0)
├── Fetches the user's calendar list  →  LIST_CALENDARS
├── Creates events via Google Calendar API v3 and returns the id  →  CREATE_EVENT
└── Deletes an event (the whole series if recurring)  →  DELETE_EVENT
```

Dropping an item, clicking a time slot while it is picked, and its schedule form all take the same path. The content script:
1. Shows a pulsing event-shaped placeholder at the chosen slot (when that day is on screen)
2. Asks the background worker to create the event via the Calendar API, which answers with the new event's id
3. Watches the calendar DOM with a `MutationObserver` for a chip whose `data-eventid` resolves to that id, falling back to a name match after a short grace period
4. Fades the placeholder out once the real event appears (12 s fallback timeout)

Undo in the toast sends `DELETE_EVENT` with that id, and clears the placeholder if the event never rendered.

---

## Tech stack

| Layer | Library / Tool |
|---|---|
| UI | React 19, TypeScript |
| Styling | Tailwind CSS v4 + custom `wlp-*` CSS classes with `!important` |
| Build | Vite 8 + `@tailwindcss/vite` |
| Extension APIs | `chrome.storage`, `chrome.identity`, `chrome.runtime` |
| Calendar API | Google Calendar API v3 |

---

## Getting started

### Prerequisites

- Node.js 18+
- A Google Cloud project with the **Google Calendar API** enabled and an OAuth 2.0 client ID configured for a Chrome extension

### Install and build

```bash
npm install
npm run build        # outputs to dist/
```

For development with automatic rebuilds on save:

```bash
npm run watch
```

### Load the extension in Chrome

1. Navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `dist/` folder
4. Open [Google Calendar](https://calendar.google.com) — the sidebar appears on the left

---

## Project structure

```
src/
├── background.ts          # Service worker — OAuth + Google Calendar API calls
├── content.tsx            # Content script — sidebar injection, drag/drop, loading overlay
├── calendarGrid.ts        # Reads Google Calendar's grid — datekeys, day columns, visible days
├── content.css            # Sidebar styles (Tailwind utilities + wlp-* override classes)
└── components/
    └── PoolSidebar.tsx    # React sidebar component

manifest.json              # Extension manifest v3
vite.config.ts             # Vite build config (two entry points: content + background)
```

---

## Design notes

**CSS `!important` overrides** — All spacing and layout classes on sidebar elements use named `wlp-*` CSS classes defined in `content.css` with `!important`. This is intentional: Google Calendar's own global stylesheet overrides Tailwind utility classes injected by a content script, so the only reliable way to guarantee padding and margin values is explicit `!important` declarations.

**Datekey conversion** — Google Calendar encodes dates as integer "datekeys" (not simple epoch days). A datekey is bit-packed: `((year - 1970) << 9) | (month << 5) | day`, with month and day 1-based — 512 per year, 32 per month, 1 per day (e.g. Apr 30 2026 = 28830, May 1 2026 = 28833). `calendarGrid.ts` unpacks it with shifts and masks. An earlier approximation treated it as days-since-epoch plus a fudge at each month boundary, which drifted by a day or more in any week spanning two months.

**Scroll-tracking overlay** — The loading placeholder uses `position: fixed` but attaches a scroll listener in capture mode that re-reads `getBoundingClientRect()` on the target cell on every scroll event, keeping the overlay pinned to the correct calendar column even as the user scrolls.

---

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Persist pool items, hidden categories, and UI state |
| `identity` | OAuth 2.0 token for Google Calendar API |
| `https://calendar.google.com/*` | Inject the sidebar into Google Calendar |
| `.../auth/calendar.events.owned` | Create events on calendars the user owns |
| `.../auth/calendar.calendarlist.readonly` | Read the calendar list to group pool items |

The two Calendar scopes are deliberately narrower than the blanket `auth/calendar`
scope. The extension only writes events and reads the calendar list, so it never
asks to read existing events, and never asks to write to a calendar that is merely
shared with the user. Calendars whose `accessRole` is not `owner` cannot be written
to under `calendar.events.owned`.

---

## Support

Weekly Life Pool is free and has no ads, accounts or tracking. If it saves you time, you can support it through the **Sponsor** button at the top of this repository.

## License

Weekly Life Pool is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only). You may use, study, change and share it, as long as what you change stays under the same licence.
