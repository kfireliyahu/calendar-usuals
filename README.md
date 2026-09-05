# Weekly Life Pool

A Chrome extension that adds a planning sidebar to Google Calendar. Keep a pool of recurring activities organized by calendar, then drag them onto any time slot to instantly create events.

---

## Features

- **Activity pool** — store reusable items (tasks, routines, habits) grouped by your Google Calendars
- **Drag-and-drop creation** — drag any item onto the calendar grid; an event is created at the exact time and date you drop it
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
    ├── Shifts Google Calendar's layout right to make room
    ├── Listens for drag events over calendar cells
    └── Sends CREATE_EVENT to the background worker on drop

Background service worker (background.ts)
├── Authenticates with Google via chrome.identity (OAuth 2.0)
├── Fetches the user's calendar list  →  LIST_CALENDARS
└── Creates events via Google Calendar API v3  →  CREATE_EVENT
```

When you drop an item the content script:
1. Shows a pulsing event-shaped placeholder at the drop position
2. Asks the background worker to create the event via the Calendar API
3. Watches the calendar DOM with a `MutationObserver` for the new event element
4. Fades the placeholder out once the real event appears (12 s fallback timeout)

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
├── content.css            # Sidebar styles (Tailwind utilities + wlp-* override classes)
└── components/
    └── PoolSidebar.tsx    # React sidebar component

manifest.json              # Extension manifest v3
vite.config.ts             # Vite build config (two entry points: content + background)
```

---

## Design notes

**CSS `!important` overrides** — All spacing and layout classes on sidebar elements use named `wlp-*` CSS classes defined in `content.css` with `!important`. This is intentional: Google Calendar's own global stylesheet overrides Tailwind utility classes injected by a content script, so the only reliable way to guarantee padding and margin values is explicit `!important` declarations.

**Datekey conversion** — Google Calendar encodes dates as integer "datekeys" (not simple epoch days). A datekey is bit-packed: `((year - 1970) << 9) | (month << 5) | day`, with month and day 1-based — 512 per year, 32 per month, 1 per day (e.g. Apr 30 2026 = 28830, May 1 2026 = 28833). `content.tsx` unpacks it with shifts and masks. An earlier approximation treated it as days-since-epoch plus a fudge at each month boundary, which drifted by a day or more in any week spanning two months.

**Scroll-tracking overlay** — The loading placeholder uses `position: fixed` but attaches a scroll listener in capture mode that re-reads `getBoundingClientRect()` on the target cell on every scroll event, keeping the overlay pinned to the correct calendar column even as the user scrolls.

---

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Persist pool items, hidden categories, and UI state |
| `identity` | OAuth 2.0 token for Google Calendar API |
| `https://calendar.google.com/*` | Inject the sidebar into Google Calendar |
| `https://www.googleapis.com/auth/calendar` | Create events and list calendars |
