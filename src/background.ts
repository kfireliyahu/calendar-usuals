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
