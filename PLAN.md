# Weekly Life Pool — Plan

Near-term work, ordered by how much each item changes daily use. Phases 2, 3
and 5 are the committed scope; phase 6 is optional. Phase 4 (event / task
switch) was dropped — the numbering below stays as-is so the phases keep the
names they were discussed under.

---

## Done

| Fix | Where |
|---|---|
| Extension icons (16/32/48/128) + generator script | `icons/`, `scripts/generate-icons.mjs`, `manifest.json` |
| `manifest.json` and `icons/` copied into `dist/` by the build | `vite.config.ts` |
| Stale-token retry: 401 → `removeCachedAuthToken` → replay once | `src/background.ts` |
| Month-view / all-day drop guard | `src/content.tsx` |
| **Phase 1** — per-item duration | `src/content.tsx`, `src/components/PoolSidebar.tsx`, `src/content.css` |
| **Capture** — "Add to pool" button in Google's event dialog | `src/background.ts`, `src/content.tsx`, `src/components/PoolSidebar.tsx` |

---

## Data model

Everything below hangs off one interface, stored in `chrome.storage.local` under
`poolItems`, keyed by `calendarId`. Array order is display order.

```ts
interface PoolItem {
  id: string;
  name: string;
  calendarId: string;

  // phase 1 (done)
  durationMin?: number;      // undefined => 60

  // capture (done) - also the start of phase 5
  description?: string;
  location?: string;
  repeat?: { freq: string; interval?: number };

  // phase 5 (remaining)
  colorId?: string;          // Google Calendar event colorId
  reminderMin?: number;      // popup reminder, minutes before

  // phase 6 (optional)
  targetPerWeek?: number;
}
```

**Migration rule:** every new field is optional, and every reader treats
`undefined` as today's behaviour. Items already in storage keep working with no
migration step. Do not add a required field to `PoolItem`.

---

## Capture — save an existing event as a block *(done)*

Clicking an event in Google Calendar opens its detail dialog; that dialog gets an
**Add to pool** button which saves the event as a reusable block. Only the
reusable parts are kept — name, calendar, description, location, length, and how
often it repeats. The date it sat on is discarded: the block is a template, not a
copy.

**Why a button and not a drag.** Dragging an event onto the sidebar was tried
first and abandoned. It depended on Google Calendar's chips being HTML5
draggables, which cannot be confirmed — Google may drive their dragging from raw
pointer events, in which case `dragstart` / `drop` never fire and the gesture
silently does nothing. A dialog is a DOM node that either appears or does not, so
the button is observable and testable.

**The dialog is only a place to put the button.** The event is identified from
the chip that was *clicked*, not from the dialog's contents: a chip's position in
its day column yields an exact date and start minute, whereas the dialog states
them as localised prose that would have to be parsed. `readChip` records the chip
on click (capture phase, so it survives Google stopping the event), and the
button is injected only into a dialog opened within 3 s of that click — which
also keeps it out of Google's settings, search and create-event dialogs without
having to recognise each one.

**Resolution avoids Google's internal ids.** `resolveEventTemplate` looks the
event up through the API by day + title + start minute rather than decoding
`data-eventid`. `scoreCandidate` requires a title match and uses start time only
to break ties between same-named events, so small pixel discrepancies are
harmless.

**Recurrence is normalised, not copied.** `readRecurrence` keeps only `FREQ` and
`INTERVAL`, dropping `BYDAY`, `UNTIL` and `COUNT`: a block should repeat from
whichever day it is later dropped on, and an inherited `UNTIL` in the past would
produce a series with no instances.

**Verified end-to-end** against the built bundle with a stubbed `chrome` API and
a synthetic calendar DOM: the button stays out of unrelated dialogs, appears
after a chip click, is not duplicated on repeated mutations, sends the right
title/day/start minute, and the resolved template reaches the sidebar with its
duration and repeat intact.

**Still unverified against the real Google Calendar** — the chip selector
(`[data-eventid], [data-eventchip]`) and the assumption that the detail popup
carries `role="dialog"`. If the button never appears, those are the two things to
check.

---

## Phase 2 — Edit and reorder items

`PoolSidebar.tsx` has only `addItem` / `deleteItem`. A typo means delete and
retype, and the pool is stuck in insertion order.

- **Rename:** double-click the name → inline input. Enter commits, Escape
  cancels, blur commits.
- **Reorder:** drag an item within its category. Array order is already the
  persisted order, so no schema change.
- **Move between calendars:** dropping on another category header reassigns
  `calendarId`. Overlaps with the existing category chips; keep both.
- **Duplicate:** copy an item with its duration and template fields — the fast
  path once phase 5 gives items real configuration.

**Watch out:** sidebar drags must not create calendar events. The document-level
`drop` listener only acts on `closest('[role="gridcell"]')`, so a sidebar drop is
already ignored — verify that still holds after adding sidebar drop zones, and
put reorder on its own dataTransfer type rather than reusing `poolItem`.

---

## Phase 3 — Shift-drop for weekly recurrence

Most pool items are routines, and creating them one week at a time is the whole
reason the sidebar exists.

- Hold **Shift** on drop → add `recurrence: ['RRULE:FREQ=WEEKLY']` to the event
  body. `events.insert` takes this directly.
- `dragover` fires continuously and carries `shiftKey`, so the tooltip can say
  "repeats weekly" live as the key is held or released mid-drag.
- Give the preview a distinct look when recurring (repeat glyph or dashed
  border) so it is never an invisible accidental commit.
- `FREQ=WEEKLY` with no `UNTIL`/`COUNT` repeats forever, which is right for a
  routine — but it raises the stakes on undo, since one stray shift-drop creates
  an infinite series. `events.delete` on the returned id removes the whole
  series.

---

## Phase 5 — Item templates

Make a pool item carry its whole configuration, not just a name, so dropping it
produces the event you would otherwise have typed by hand.

- Remaining fields: `colorId`, `reminderMin`. `description` and `location` are
  already on `PoolItem` and already sent on drop — capture put them there — but
  nothing edits them yet, which is what this phase adds.
- These map straight onto the `events.insert` body — `description`, `location`,
  `colorId`, and
  `reminders: { useDefault: false, overrides: [{ method: 'popup', minutes }] }`.
  No new scope, no new endpoint.
- UI: an expandable detail panel per item, collapsed by default. The sidebar is
  280 px wide and the pool is meant to be scannable — template fields do not go
  in the always-visible row.
- Pairs with phase 2's duplicate: configure one item well, then clone it.

---

## Phase 6 — Weekly targets *(optional add-on)*

The feature that turns the sidebar from a shortcut into a planning tool: an item
shows `2/3` for the visible week and dims once its target is met.

- `targetPerWeek` on the item, rendered as a chip on the row.
- Count via `events.list` with `timeMin`/`timeMax` for the visible week, matching
  on `summary`. Needs read access, already covered by the current
  `auth/calendar` scope.
- Derive the visible week from the datekeys present in the current view — reuse
  `findDatekey` / `datekeyToDate` in `content.tsx` rather than parsing the URL.
- Cache counts per (calendar, week) and invalidate on drop, or the sidebar
  refetches on every render.

Genuinely optional: the most product-like feature here and the most work, while
phases 2–3 are what actually improve daily use. Build it if the tool sticks.

---

## Not in this plan

Tracked so they are not silently forgotten:

- **Undo after drop** — 5-second undo in the existing toast, using the event id
  the API returns. Cheap, and it matters more once shift-drop can create an
  infinite series.
- **Keyboard path** (select item, then click a slot). Drag-only is unusable for
  some people; needed before any public launch.
- `chrome.storage.sync` so the pool follows the user between machines.
- Dark mode — the sidebar is hardcoded light while Google Calendar has a dark
  theme.
- `waitForEvent` matches on name, so two identically-named items resolve each
  other's placeholder.
- Publishing prerequisites: narrow `auth/calendar` to `calendar.events` plus
  `calendar.readonly`, pin the extension `key` so the OAuth client id survives
  upload, privacy policy, OAuth verification.
