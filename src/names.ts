// Names as Google Calendar shows them: which name a calendar goes by, the
// name of the primary calendar in particular, and how a name in any script
// sits among the sidebar's English words.

// ── Calendar names ────────────────────────────────────────────────────────────

// An entry of calendarList.list, as much of it as the sidebar reads. The
// request has no fields mask, so summaryOverride comes back whenever the user
// has set one.
export interface CalendarListEntry {
  id: string;
  summary: string;
  // The name the user gave a calendar they subscribe to or were shared, which
  // Google's own list shows in place of the owner's summary.
  summaryOverride?: string;
  backgroundColor?: string;
  accessRole?: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  primary?: boolean;
  // Hidden from Google's list of calendars, so not on the page to be read.
  hidden?: boolean;
  timeZone?: string;
}

export function displayName(cal: CalendarListEntry): string {
  return cal.summaryOverride || cal.summary;
}

// The primary calendar's summary is the account's address until the user
// renames it, and Google's own list shows the account's name in its place
// ("Kfir Raphael Eliyahu", not "pat@example.com"). The API has that name
// only behind a profile scope this extension does not ask for, so it is read
// off the page instead (findPrimaryName). A primary calendar the user did
// rename shows that name, as Google does, and needs nothing from the page.
export function needsPageName(cal: CalendarListEntry): boolean {
  return Boolean(cal.primary) && !cal.summaryOverride &&
    cal.summary.trim().toLowerCase() === cal.id.trim().toLowerCase();
}

// ── Reading the primary calendar's name off the page ──────────────────────────
//
// Google's "My calendars" list is a checkbox per calendar, each named for
// assistive technology with the calendar's name, and it lists the primary
// calendar first. Separately, the account button in Google's top bar is named
// with the account's name and its address ("Google Account: Kfir Raphael
// Eliyahu (pat@example.com)", in the page's language). The name is taken
// only when the two agree:
//
// - The list is found by the other calendars the API returned: the checkboxes
//   named after them. If none of them is on the page, this is not the list
//   (or the list is not there yet), and nothing is read.
// - A candidate is a checkbox before the first of those, so at the head of
//   "My calendars" where the primary calendar is, whose name is not another
//   calendar's.
// - It must also appear in a label on the page that carries the primary
//   calendar's address, which is its id. Birthdays and Tasks, the other
//   entries Google puts in the list, never do.
//
// Exactly one name must survive; anything else gives null, and the sidebar
// keeps showing the address, since a wrong name is worse than the address.
// No class name of Google's is used, only roles, labels and document order.
// Whether Google keeps the list in the page while its menu is closed is not
// known, which is why watchPrimaryName looks again as the page changes.

const SIDEBAR_ID = 'weekly-life-pool-sidebar';

function outsideSidebar(el: Element): boolean {
  return !el.closest(`#${SIDEBAR_ID}`);
}

function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

// The name a screen reader would read for a checkbox, in the order the
// accessible name is worked out: aria-label, then aria-labelledby, then a
// <label> for it.
function checkboxName(box: Element): string {
  const label = squash(box.getAttribute('aria-label'));
  if (label) return label;
  const ids = squash(box.getAttribute('aria-labelledby'));
  if (ids) {
    const text = squash(ids.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
    if (text) return text;
  }
  if (box instanceof HTMLInputElement && box.labels?.length) {
    return squash(Array.from(box.labels).map((l) => l.textContent ?? '').join(' '));
  }
  return '';
}

export function findPrimaryName(address: string, otherNames: readonly string[]): string | null {
  const email = address.trim().toLowerCase();
  if (!email.includes('@')) return null;

  const accountLabels = Array.from(document.querySelectorAll('[aria-label*="@"]'))
    .filter(outsideSidebar)
    .map((el) => squash(el.getAttribute('aria-label')))
    .filter((label) => label.toLowerCase().includes(email));
  if (accountLabels.length === 0) return null;

  const others = new Set(otherNames);
  const boxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'))
    .filter(outsideSidebar);

  const candidates: string[] = [];
  let listFound = others.size === 0;
  for (const box of boxes) {
    const name = checkboxName(box);
    if (others.has(name)) { listFound = true; break; }
    if (name && accountLabels.some((label) => label.includes(name))) candidates.push(name);
  }
  if (!listFound) return null;

  // A short name inside the account's, a "Kfir" beside "Kfir Raphael
  // Eliyahu", is a part of it rather than a rival.
  const distinct = Array.from(new Set(candidates));
  const whole = distinct.filter((name) => !distinct.some((other) => other !== name && other.includes(name)));
  return whole.length === 1 ? whole[0] : null;
}

// Looks for the name now and again whenever the page changes, at most once a
// second, until it is found; Google draws its nav after the calendar, and
// draws it again when its menu button opens it. Returns a stop function.
const LOOK_AGAIN_MS = 1000;

export function watchPrimaryName(
  address: string,
  otherNames: readonly string[],
  onName: (name: string) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    observer.disconnect();
    if (timer) { clearTimeout(timer); timer = null; }
  };

  const look = () => {
    timer = null;
    if (stopped) return;
    const name = findPrimaryName(address, otherNames);
    if (name) { stop(); onName(name); }
  };

  const observer = new MutationObserver(() => {
    if (!timer && !stopped) timer = setTimeout(look, LOOK_AGAIN_MS);
  });

  look();
  if (!stopped) observer.observe(document.body, { childList: true, subtree: true });
  return stop;
}

// ── Text direction ────────────────────────────────────────────────────────────
//
// A name can be in Hebrew or Arabic while the sidebar's own words are English.
// Elements that hold only a name get dir="auto". A name inside an English
// sentence, a toast or the drop tooltip, is isolated instead, so it keeps its
// own order without turning the sentence around it.

const FIRST_STRONG = /[\p{L}]/u;
const RIGHT_TO_LEFT = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;

// The direction dir="auto" would give the text, from its first letter. For an
// element whose own layout, not only its text, should follow the name.
export function textDirection(text: string): 'ltr' | 'rtl' {
  for (const ch of text) {
    if (RIGHT_TO_LEFT.test(ch)) return 'rtl';
    if (FIRST_STRONG.test(ch)) return 'ltr';
  }
  return 'ltr';
}

// Wraps the text in FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE, the plain
// text form of <bdi>, which draw nothing themselves.
export function isolate(text: string): string {
  return `⁨${text}⁩`;
}
