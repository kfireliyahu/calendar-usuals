// Traces for testing (layout shifts, the zone of each created event, where a
// drop or a click landed) that stay out of users' consoles. To see them, run
// localStorage.setItem('usualsDebug', '1') in DevTools on calendar.google.com;
// localStorage.removeItem('usualsDebug') hides them again. A content script
// shares the page's localStorage, so no rebuild is needed, and the switch is
// read on every call, so it takes effect at once (reload for the ones logged
// at load). The read can throw where site data is blocked.
function debugOn(): boolean {
  try {
    return localStorage.getItem('usualsDebug') === '1';
  } catch {
    return false;
  }
}

export function debugLog(...args: unknown[]): void {
  if (debugOn()) console.log('[Usuals]', ...args);
}
