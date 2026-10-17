// Background service worker - handles API calls and long-running tasks

// The sidebar shows only in Week and Day view, so someone whose Calendar opens
// in Month view would install Usuals and never see it. A first install opens
// Calendar in Week view, once; an update or a Chrome update does not, and
// normal visits are never redirected (the content script's Week view pill,
// weekNudge.ts, covers those).
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== chrome.runtime.OnInstalledReason.INSTALL) return;
  chrome.tabs.create({ url: 'https://calendar.google.com/calendar/r/week' });
});

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

  if (message.type === 'DELETE_EVENT') {
    deleteCalendarEvent(message.data.calendarId, message.data.eventId)
      .then(() => sendResponse({ success: true }))
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

  // The content script needs the id to find the event Google Calendar renders
  // and to delete it again on Undo. calendarId goes back with it because the
  // payload may have left it to default to 'primary'.
  const event = await response.json();
  return { id: event.id as string, htmlLink: event.htmlLink as string, calendarId };
}

// Undo for a drop. Deleting the id of a recurring event removes the whole
// series, which is what Undo should do since the drop created all of it.
async function deleteCalendarEvent(calendarId: string, eventId: string) {
  const response = await authedFetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' }
  );

  // 410 means the event is already deleted, perhaps by hand in Google Calendar
  // during the Undo window. Either way it is gone, which is what Undo asked for.
  if (!response.ok && response.status !== 410) {
    throw new Error(`Failed to remove event: ${await describeError(response)}`);
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────
//
// There are two ways to a token. In Chrome, chrome.identity.getAuthToken uses the
// Google account the browser is signed in to, with the Chrome-extension client in
// manifest.json's oauth2. Brave, Edge, Opera and Arc have no such account, so
// getAuthToken fails there, and the token comes instead from Google's own sign-in
// page through chrome.identity.launchWebAuthFlow, with a Web application client.

// TODO(M8 U21): paste the client ID of the "Web application" OAuth client created
// in the same Google Cloud project as manifest.json's oauth2.client_id, with
// https://hkihoifbohighgoackpcinobeabpjnbp.chromiumapp.org/ as its authorized
// redirect URI. While this is empty, getAuthToken stays the only way to sign in.
const WEB_AUTH_CLIENT_ID = '';

// The web sign-in asks for exactly what Chrome's does, so both read the scopes
// from the manifest rather than keeping a second list that could drift.
const AUTH_SCOPES = chrome.runtime.getManifest().oauth2?.scopes ?? [];

type AuthPath = 'chrome' | 'web';

// Which cache a token came from travels with it, so a 401 clears that one.
type AccessToken = { token: string; path: AuthPath };

// Kept in chrome.storage.local once the web sign-in has worked after getAuthToken
// failed, so Brave does not ask getAuthToken first on every API call, or after
// every browser restart, only to fail again.
const AUTH_PATH_KEY = 'authPath';

// launchWebAuthFlow has no token cache of its own. The session area keeps the
// token out of disk storage and lets it outlive the service worker, which Chrome
// stops after half a minute idle, without outliving the browser.
const WEB_TOKEN_KEY = 'webAuthToken';
type WebToken = { token: string; expiresAt: number };

// A token this close to expiry could lapse mid-request, so it is renewed early.
const WEB_TOKEN_MARGIN_MS = 60_000;

// chrome.identity caches access tokens, and it hands back a cached token even
// after Google has expired or revoked it. Without this retry, one stale token
// makes every call fail until the user reloads the extension: drop the bad token
// from whichever cache gave it, ask for a fresh one, and replay the request
// exactly once. The web sign-in's cached token can be revoked the same way.
async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let token = await getAccessToken();
  let response = await fetch(url, withAuth(init, token.token));

  if (response.status === 401) {
    await forgetAccessToken(token);
    token = await getAccessToken();
    response = await fetch(url, withAuth(init, token.token));
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

async function getAccessToken(): Promise<AccessToken> {
  const { [AUTH_PATH_KEY]: remembered } = await chrome.storage.local.get<{ [AUTH_PATH_KEY]?: AuthPath }>(AUTH_PATH_KEY);
  if (remembered === 'web' && WEB_AUTH_CLIENT_ID) {
    return { token: await getWebAuthToken(), path: 'web' };
  }

  try {
    return { token: await getChromeAuthToken(), path: 'chrome' };
  } catch (chromeError) {
    if (!WEB_AUTH_CLIENT_ID || !shouldTryWebSignIn(chromeError)) throw chromeError;
    const token = await getWebAuthToken();
    await chrome.storage.local.set({ [AUTH_PATH_KEY]: 'web' });
    return { token, path: 'web' };
  }
}

// In Google Chrome, a getAuthToken failure that says the user closed the consent
// window is the user's answer, and Chrome behaves as it always has: no second
// sign-in page opens behind it. Anywhere else the same message can follow a
// window that never worked, such as Brave's error page, so every failure there
// moves on to the web sign-in.
function shouldTryWebSignIn(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
  return !(isGoogleChrome() && /did not approve/i.test(message));
}

// Chrome reports a "Google Chrome" brand; Brave, Edge and Opera report their own
// alongside "Chromium". Should Arc report Chrome's brand, its getAuthToken fails
// for want of a signed-in account rather than a closed window, so it still falls back.
function isGoogleChrome(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } };
  return nav.userAgentData?.brands.some((b) => b.brand === 'Google Chrome') ?? false;
}

async function forgetAccessToken({ token, path }: AccessToken): Promise<void> {
  if (path === 'chrome') {
    await removeCachedAuthToken(token);
  } else {
    await chrome.storage.session.remove(WEB_TOKEN_KEY);
  }
}

// LIST_CALENDARS and CREATE_EVENT can arrive together, and two interactive
// launchWebAuthFlow calls would open two sign-in windows. They share one request.
let webTokenRequest: Promise<string> | null = null;

function getWebAuthToken(): Promise<string> {
  webTokenRequest ??= requestWebAuthToken().finally(() => {
    webTokenRequest = null;
  });
  return webTokenRequest;
}

// The cached token first, then a silent renewal, which succeeds whenever the
// user is still signed in to Google and has already granted the scopes. Only
// when Google needs the user does a sign-in window open.
async function requestWebAuthToken(): Promise<string> {
  const { [WEB_TOKEN_KEY]: cached } = await chrome.storage.session.get<{ [WEB_TOKEN_KEY]?: WebToken }>(WEB_TOKEN_KEY);
  if (cached && cached.expiresAt - Date.now() > WEB_TOKEN_MARGIN_MS) return cached.token;

  try {
    return await launchWebSignIn(false);
  } catch {
    return await launchWebSignIn(true);
  }
}

// Implicit grant: Google redirects to the extension's chromiumapp.org URL with
// the token in the fragment, and launchWebAuthFlow hands that URL back. The
// random state proves the answer belongs to this request.
async function launchWebSignIn(interactive: boolean): Promise<string> {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: WEB_AUTH_CLIENT_ID,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: AUTH_SCOPES.join(' '),
    state,
  });
  // prompt=none makes Google redirect with an error rather than show a page,
  // which is what a silent renewal needs.
  if (!interactive) params.set('prompt', 'none');

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    interactive,
  });
  if (!responseUrl) throw new Error('Google sign-in did not return');

  // Google puts the answer in the fragment, but some errors come back in the query.
  const url = new URL(responseUrl);
  const answer = new URLSearchParams(url.hash.slice(1));
  url.searchParams.forEach((value, key) => {
    if (!answer.has(key)) answer.set(key, value);
  });

  const error = answer.get('error');
  if (error) throw new Error(`Google sign-in failed: ${error}`);
  if (answer.get('state') !== state) throw new Error('Google sign-in answered a different request');
  const token = answer.get('access_token');
  if (!token) throw new Error('Google sign-in returned no token');

  const expiresIn = Number(answer.get('expires_in')) || 3600;
  const webToken: WebToken = { token, expiresAt: Date.now() + expiresIn * 1000 };
  await chrome.storage.session.set({ [WEB_TOKEN_KEY]: webToken });
  return token;
}

async function getChromeAuthToken(): Promise<string> {
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
