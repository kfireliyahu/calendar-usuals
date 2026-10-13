# Usuals

*Works with Google Calendar*

Most of a week is made of things you already do: a workout, a call home, deep work, the groceries. Usuals is a Chrome extension that keeps those usual things in a sidebar beside Google Calendar's week and day, each under the calendar it belongs to, so planning is dragging one onto a time slot, where it becomes a real event.

---

## Features

- **Your usuals** — keep reusable items (tasks, routines, habits) grouped by your Google Calendars
- **Drag-and-drop creation** — drag any item onto the calendar grid; an event is created at the exact time and date you drop it
- **Shift-drop for weekly** — hold Shift while dropping to create a weekly series with no end date; the tooltip and a dashed, ↻-marked preview show it live as Shift goes down or up
- **Undo** — the toast after a drop offers Undo for 5 seconds, paused while the pointer or keyboard focus is on it; it deletes the event, or the whole series for a Shift-drop
- **Schedule without dragging** — each item has a calendar button: Tab to it and press Enter (or click it) to pick the item, then choose a day from the week on screen and a 15-minute start time, or click a time slot in Day or Week view to place it there; Shift-click and the form's repeat choice ("Does not repeat" or "Weekly on" the chosen weekday) work like Shift-drop, and Escape cancels
- **Item templates** — give an item a location, a notification, an event colour and a description, in the fields of Google's event editor; dropping it creates the event fully configured
- **Rename in place** — double-click an item's name; Enter or clicking away commits, Escape cancels
- **Reorder and re-file** — drag an item within its list to reorder it, or onto another calendar's heading (or an empty calendar's row) to move it there
- **Duplicate** — clone a configured item and tweak the copy
- **Time snapping** — drops snap to the nearest 15-minute slot with a live tooltip showing day + time while hovering
- **Loading overlay** — a pulsing placeholder in the calendar's color appears at the drop location and fades out once Google Calendar renders the real event; tracks the column as you scroll
- **A composer like Google's event editor** — the add-item form is always open at the top of the sidebar and reads like Google Calendar's own: a title on an underline with a filled Add button beside it, level with Google's top bar, then the calendar (its colour and name) and the duration as grey dropdowns; Enter adds the item and leaves the caret there for the next one. It never takes focus by itself when the page loads
- **Items look like their events** — each item is drawn as the chip its event will be in the week view: filled with its event colour (or its calendar's), its name and duration in Google's chip type ("workout, 1h"), with text picked for at least 4.5:1 contrast on every colour; its schedule, details and delete buttons show on hover or keyboard focus, and the drag image and the preview on the grid are the same chip
- **Calendar sections** — each calendar with items is a section like Google's "My calendars": its colour, its name and a chevron that folds its items away (the choice syncs with your items); calendars with nothing in them yet are listed once at the end, and clicking one sets the composer to it with the caret in the title, or drag an item onto it. A calendar created, renamed, recoloured or deleted in Google Calendar shows in the sidebar about a second later, without a reload
- **Names as Google shows them** — every calendar goes by the name Google Calendar's own list gives it, your own name for a shared calendar included; the primary calendar shows your account's name, as Google's "My calendars" does, rather than your address (see *Primary calendar's name* below). Names in Hebrew or Arabic, of calendars and of items, run right to left wherever they appear: an item's chip starts at the right edge as Google's chip for it will, text fields follow what is typed, and a name quoted in a toast or the drop tooltip keeps its own order
- **Week and Day view only** — the sidebar shows in Google Calendar's Week view, weekends shown or hidden, and in Day view. In Month, Year, Schedule or a custom view, and in Settings, it hides and gives Google Calendar back its own layout; anything half typed in it is still there when you come back
- **Collapsible sidebar** — collapse to a 40 px icon strip when you need the full screen. While Google Calendar's own main menu (☰) is open, the sidebar steps aside to that strip by itself, so the week is never squeezed between two sidebars; open it from the strip and it stays beside the menu until the menu closes. Header, list and footer always fit the window, whatever its height
- **Follows Google Calendar's theme** — the sidebar, its forms and toasts, and the tooltip, drag preview and loading placeholder it draws on the calendar turn dark whenever Google Calendar is showing its dark theme and light when it is not, going by Google Calendar's own Appearance setting rather than the operating system's; changing it switches them over without a reload. The sidebar sits on the same page colour as Google Calendar's top bar and left nav, read off the page rather than assumed, in Google's typeface and with a thin scrollbar like Google's
- **Syncs across your Chrome profile** — items and hidden categories are saved with `chrome.storage.sync`, so every computer signed into the same Chrome profile sees the same items, and an edit on one shows up on the others (and in other Calendar tabs) without a reload
- **Export and import** — Export in the sidebar's footer saves every usual, with its calendar, its template fields and the folded sections, to a `usuals-<date>.json` file; Import adds a file's usuals back. An import only adds: a usual already in the sidebar is left as it is, so importing the same file twice changes nothing. Usuals for calendars this Google account does not have are kept but not shown, and the toast says how many
- **Persistent storage** — whether the sidebar is collapsed is saved per computer in Chrome local storage, and the items keep a copy there too, so an edit is never lost if it has not reached sync yet

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

To build the Chrome Web Store package:

```bash
npm run package      # outputs release/usuals-<version>.zip
```

`manifest.json` pins the store's public key as `key`, so an unpacked build has the store's extension id (`hkihoifbohighgoackpcinobeabpjnbp`) and signs in with the OAuth client registered against it. The packaged manifest leaves `key` out, since the store supplies its own.

### Load the extension in Chrome

1. Navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `dist/` folder
4. Open [Google Calendar](https://calendar.google.com) — the sidebar appears on the left

The console stays quiet apart from real problems (a failed sync or save, a date the grid cannot be read for, a sidebar that fails to render). For testing, run `localStorage.setItem('usualsDebug', '1')` in DevTools on the Google Calendar tab to also see its traces (layout shifts, each event's time zone, where a drop or a click landed), and `localStorage.removeItem('usualsDebug')` to hide them; no rebuild is needed.

---

## Project structure

```
src/
├── background.ts          # Service worker — OAuth + Google Calendar API calls
├── content.tsx            # Content script — sidebar injection, drag/drop, loading overlay
├── calendarGrid.ts        # Reads Google Calendar's grid — datekeys, day columns, visible days
├── poolItem.ts            # The pool item type and its helpers
├── poolStore.ts           # Loads, saves and live-updates the pool in chrome.storage.sync
├── poolTransfer.ts        # The export file: writing it, and reading and checking one to import
├── theme.ts               # Reads whether Google Calendar is showing its light or dark theme
├── names.ts               # Calendar display names, the primary calendar's name off the page, text direction
├── layout.ts              # Makes room for the sidebar on the page; tells when Google's main menu is open
├── debug.ts               # Testing traces, shown only when localStorage usualsDebug is '1'
├── content.css            # Sidebar styles (Tailwind utilities + wlp-* override classes)
└── components/
    └── PoolSidebar.tsx    # React sidebar component

manifest.json              # Extension manifest v3
vite.config.ts             # Vite build config (two entry points: content + background)
```

---

## Design notes

**CSS `!important` overrides** — Most spacing and layout on sidebar elements comes from named `wlp-*` CSS classes defined in `content.css` with `!important`. This is intentional: Google Calendar's own global stylesheet overrides Tailwind utility classes injected by a content script, so the only reliable way to guarantee padding and margin values is explicit `!important` declarations.

**Tailwind without its theme** — `content.css` imports only Tailwind's utilities, because the theme layer would put its variables and preflight into Google Calendar's page. A utility that reads a theme value (`px-4`, `font-medium`, `text-white`, `rounded-md`) therefore emits no CSS at all, so the sidebar writes those as bracket values instead (`px-[16px]`, `font-[500]`), and every colour as a theme variable (`text-[var(--wlp-text)]`).

**Datekey conversion** — Google Calendar encodes dates as integer "datekeys" (not simple epoch days). A datekey is bit-packed: `((year - 1970) << 9) | (month << 5) | day`, with month and day 1-based — 512 per year, 32 per month, 1 per day (e.g. Apr 30 2026 = 28830, May 1 2026 = 28833). `calendarGrid.ts` unpacks it with shifts and masks. An earlier approximation treated it as days-since-epoch plus a fudge at each month boundary, which drifted by a day or more in any week spanning two months.

**Synced pool** — `poolStore.ts` owns the pool's storage. Chrome sync allows about 100 KB in all but only 8 KB per key, so each item has its own key (`item:<id>`) and each calendar keeps its order as a list of ids (`order:<calendarId>`), next to `hiddenCategories` and a `poolSchema` marker. A long description therefore only weighs on its own item. Writes wait for a pause in editing and start at least 5 s apart, to stay under sync's write limits. Every edit is also copied to `chrome.storage.local` with a note of which keys sync has not accepted yet; if sync refuses the pool for size, the sidebar says so once ("saved on this device only") and keeps working from that copy. On the first run after the update, a pool kept in local storage by an earlier version is copied up to sync once, unless sync already holds a pool from another computer, in which case sync wins and the two are not merged. The old local copy is left in place as a backup. Changes from other computers and tabs arrive through `chrome.storage.onChanged`; a key this tab has edited and not yet sent keeps its edit. Items for calendars that are not in this Google account's list (say, from a different account on another computer) are kept in storage but not shown.

**Theme detection** — Google Calendar has its own Light / Dark / Device default setting, so `prefers-color-scheme` alone is wrong whenever it disagrees with the OS. `theme.ts` reads what the page is painted with instead: it walks up from Google Calendar's `[role="main"]` to the first element with an opaque `background-color` and calls the theme dark if that colour's luminance is low. It relies on no class name or attribute of Google's. It checks again when `<html>` or `<body>` change, when a stylesheet is added, when the OS switches between light and dark, and every few seconds while the tab is visible. The result is a `data-wlp-theme` attribute on the sidebar's mount, the tooltip and the preview, and `content.css` defines every colour as a `--wlp-*` variable for each theme. The sidebar's own background is read the same way, from the top bar (`[role="banner"]`, else `<body>`) up to the first opaque background, and set on the mount as `--wlp-page`; it is used only when it is fully opaque and agrees with the detected theme, and otherwise each theme's constant stands in.

**Primary calendar's name** — The Calendar API names the primary calendar with the account's address until the user renames it, and the account's own name sits behind a profile scope the extension does not ask for. `names.ts` reads it off the page instead, and only when two things agree: a checkbox in Google's calendar list ahead of the first of the user's other calendars (the primary calendar comes first in "My calendars"), and a label on the page that also carries the account's address, which is the name of the Google Account button in the top bar. Only roles, accessible names and document order are used, no class names. If exactly one name passes, it replaces the address and is kept in `chrome.storage.local` for the next load; otherwise the address stays, since a wrong name would be worse. While it has not been found, it looks again at most once a second as the page changes, for when Google's menu opens or draws its list late. A primary calendar the user renamed, or one with its own display name, keeps that name.

**Layout beside Google's** — `layout.ts` makes room by narrowing Google Calendar's root (the child of `<body>` that holds `[role="main"]`) by the sidebar's width and shifting it right with a transform, which also carries Google's fixed top bar and button along; the root is clipped across (`overflow-x: clip`) so nothing in it can push past the window and give the page a horizontal scrollbar. The sidebar is held between the window's top and bottom edges rather than set to `100vh`, which counts such a scrollbar as page and cut the footer off below it. Whether Google's main menu is open is measured, not looked up: the distance from the root's start edge to `[role="main"]`'s is the nav's width when it is open and about nothing when it is closed, read again (at most once a frame) whenever a `ResizeObserver` sees the grid resize. No class name or translated label of Google's is used. On a right-to-left page (Google Calendar in Hebrew or Arabic, its menu on the right) the sidebar stays on the left and in left-to-right order, as its words are English; the narrowed root then already sits against the right edge, so it is not shifted.

**Scroll-tracking overlay** — The loading placeholder uses `position: fixed` but attaches a scroll listener in capture mode that re-reads `getBoundingClientRect()` on the target cell on every scroll event, keeping the overlay pinned to the correct calendar column even as the user scrolls.

---

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Sync items and hidden categories across the user's Chrome profile (`chrome.storage.sync`); keep per-device UI state and a local copy of the pool (`chrome.storage.local`) |
| `identity` | OAuth 2.0 token for Google Calendar API |
| `https://calendar.google.com/*` | Inject the sidebar into Google Calendar |
| `.../auth/calendar.events.owned` | Create events on calendars the user owns |
| `.../auth/calendar.calendarlist.readonly` | Read the calendar list to group items |

The two Calendar scopes are deliberately narrower than the blanket `auth/calendar`
scope. The extension only writes events and reads the calendar list, so it never
asks to read existing events, and never asks to write to a calendar that is merely
shared with the user. Calendars whose `accessRole` is not `owner` cannot be written
to under `calendar.events.owned`.

---

## Privacy

The extension has no server of its own and collects nothing. Items (names, descriptions, locations, colours, reminders, durations) and the list of hidden calendars are stored with `chrome.storage.sync`, so when Chrome sync is turned on they travel through **Chrome Sync, which is operated by Google**, to the other computers signed into the same Chrome profile; with Chrome sync off they stay on the computer. Per-device settings, a local copy of the items and the primary calendar's display name as read off the Google Calendar page stay in `chrome.storage.local`. Events are created and deleted directly with the Google Calendar API.

The full policy is in [PRIVACY.md](PRIVACY.md).

## Support

Usuals is free and has no ads, accounts or tracking. If it saves you time, you can support it through the **Sponsor** button at the top of this repository.

## License

Usuals is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only). You may use, study, change and share it, as long as what you change stays under the same licence.

Bug reports and ideas are welcome as issues; pull requests are not accepted for now. See [CONTRIBUTING.md](CONTRIBUTING.md).

Google Calendar is a trademark of Google LLC. Usuals is not made, endorsed or sponsored by Google.
