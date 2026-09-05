// Background service worker - handles API calls and long-running tasks

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'LIST_CALENDARS') {
    listCalendars()
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'CREATE_EVENT') {
    createCalendarEvent(message.data)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'RESOLVE_EVENT') {
    resolveEventTemplate(message.data)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  return false;
});

async function listCalendars() {
  const response = await authedFetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList'
  );

  if (!response.ok) {
    throw new Error(`Failed to list calendars: ${await describeError(response)}`);
  }

  return response.json();
}

async function createCalendarEvent(eventData: any) {
  // calendarId is passed in the payload but must not appear in the event body
  const { calendarId = 'primary', ...eventBody } = eventData;

  const response = await authedFetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to create event: ${await describeError(response)}`);
  }

  return response.json();
}

// ── Auth ─────────────────────────────────────────────────────────────────────

// chrome.identity caches access tokens, and it hands back a cached token even
// after Google has expired or revoked it. Without this retry, one stale token
// makes every call fail until the user reloads the extension: drop the bad token
// from the cache, ask for a fresh one, and replay the request exactly once.
async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let token = await getAccessToken();
  let response = await fetch(url, withAuth(init, token));

  if (response.status === 401) {
    await removeCachedAuthToken(token);
    token = await getAccessToken();
    response = await fetch(url, withAuth(init, token));
  }

  return response;
}

function withAuth(init: RequestInit, token: string): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  };
}

// The API puts the useful part in the body; statusText alone is just "Unauthorized".
async function describeError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const message = body?.error?.message;
    if (message) return `${message} (${response.status})`;
  } catch {
    // Body was not JSON — fall through to the status line.
  }
  return response.statusText || `HTTP ${response.status}`;
}

async function getAccessToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token: any) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else if (token) {
        resolve(token);
      } else {
        reject(new Error('Failed to get auth token'));
      }
    });
  });
}

async function removeCachedAuthToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

// ── Resolving a calendar event into a reusable pool template ─────────────────

interface ResolveRequest {
  dayStartISO: string;
  dayEndISO: string;
  title: string;
  startMin: number | null; // minutes past midnight, from the chip's position
}

interface EventTemplate {
  name: string;
  calendarId: string;
  durationMin: number;
  description?: string;
  location?: string;
  repeat?: { freq: string; interval?: number };
}

// The content script can read a chip's title and roughly where it sits in the
// day column, but not its event id - Google Calendar's own DOM ids are internal
// and undocumented. So instead of reverse-engineering them, look the event up
// through the API by the things we can read reliably: which day it is on, what
// it is called, and what time it starts.
async function resolveEventTemplate(req: ResolveRequest): Promise<EventTemplate> {
  const calendars = await listCalendars();
  const ids: string[] = (calendars.items ?? []).map((c: any) => c.id);
  if (ids.length === 0) throw new Error('No calendars available');

  const perCalendar = await Promise.all(
    ids.map(async (calendarId) => {
      const url =
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events` +
        `?timeMin=${encodeURIComponent(req.dayStartISO)}` +
        `&timeMax=${encodeURIComponent(req.dayEndISO)}` +
        `&singleEvents=true&maxResults=100`;
      try {
        const response = await authedFetch(url);
        if (!response.ok) return [];
        const body = await response.json();
        return ((body.items ?? []) as any[]).map((ev) => ({ ev, calendarId }));
      } catch {
        // One unreadable calendar should not sink the whole lookup.
        return [];
      }
    })
  );

  const candidates = perCalendar.flat().filter(({ ev }) => ev.start?.dateTime);
  if (candidates.length === 0) throw new Error('No timed events found on that day');

  const wanted = normalise(req.title);
  const scored = candidates
    .map((c) => ({ ...c, score: scoreCandidate(c.ev, wanted, req.startMin) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) throw new Error(`Could not find "${req.title}" on that day`);

  const { ev, calendarId } = scored[0];
  const start = new Date(ev.start.dateTime).getTime();
  const end   = new Date(ev.end.dateTime).getTime();

  return {
    name: ev.summary ?? req.title,
    calendarId,
    durationMin: Math.max(5, Math.round((end - start) / 60_000)),
    description: ev.description || undefined,
    location: ev.location || undefined,
    repeat: await readRecurrence(calendarId, ev.recurringEventId),
  };
}

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Title match is required; the chip's start time only breaks ties, because two
// events can share a name on one day.
function scoreCandidate(ev: any, wantedTitle: string, startMin: number | null): number {
  const summary = normalise(ev.summary ?? '');
  if (!summary) return 0;

  let score = 0;
  if (summary === wantedTitle) score = 100;
  else if (summary.startsWith(wantedTitle) || wantedTitle.startsWith(summary)) score = 60;
  else return 0; // Chip text is truncated with an ellipsis, never rewritten.

  if (startMin !== null) {
    const begins = new Date(ev.start.dateTime);
    const evMin = begins.getHours() * 60 + begins.getMinutes();
    // Within a slot is a strong signal; far away is still a match, just weaker.
    score += Math.max(0, 30 - Math.abs(evMin - startMin) / 2);
  }
  return score;
}

// A pool block keeps only how often something repeats, not the source series'
// anchor. BYDAY / UNTIL / COUNT are deliberately dropped: the block should
// follow whichever day it is later dropped on, and an inherited UNTIL in the
// past would create a series with no instances.
async function readRecurrence(
  calendarId: string,
  recurringEventId?: string
): Promise<{ freq: string; interval?: number } | undefined> {
  if (!recurringEventId) return undefined;

  try {
    const response = await authedFetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}` +
      `/events/${encodeURIComponent(recurringEventId)}`
    );
    if (!response.ok) return undefined;

    const master = await response.json();
    const rule: string | undefined = (master.recurrence ?? []).find((r: string) =>
      r.startsWith('RRULE:')
    );
    if (!rule) return undefined;

    const parts = rule.slice('RRULE:'.length).split(';');
    const freq = parts.find((p) => p.startsWith('FREQ='))?.slice(5);
    if (!freq) return undefined;

    const intervalRaw = parts.find((p) => p.startsWith('INTERVAL='))?.slice(9);
    const interval = intervalRaw ? parseInt(intervalRaw, 10) : undefined;

    return { freq, interval: interval && interval > 1 ? interval : undefined };
  } catch {
    // A block that loses its repeat is better than a drag that fails outright.
    return undefined;
  }
}
