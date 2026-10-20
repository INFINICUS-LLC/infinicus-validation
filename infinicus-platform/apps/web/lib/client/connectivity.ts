/**
 * Connection awareness for the counter (POS-7a). Pure and framework-free.
 *
 * The browser's "online" flag is only a hint: `false` is reliable (there is certainly no network), `true` only means a network exists, not that the API is
 * reachable. So being offline BLOCKS actions (they could not succeed and would only produce confusing errors), while coming back online merely triggers one safe
 * retry of an action whose outcome is unknown: the retry carries the SAME Idempotency-Key, so the server replays an answer it already gave instead of repeating
 * the action. Nothing is stored in the browser (see clientBoundary.architecture.test.ts); an unconfirmed action is held in memory only, and leaving the page
 * while one exists is warned about.
 */
export interface ConnectivitySource {
  isOnline(): boolean;
  /** Calls `listener` whenever the connection state may have changed. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export const browserConnectivity: ConnectivitySource = {
  isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  subscribe: (listener) => {
    if (typeof window === 'undefined') return () => undefined;
    window.addEventListener('online', listener);
    window.addEventListener('offline', listener);
    return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener); };
  },
};

/**
 * Runs `retry` once each time the connection RETURNS (offline then online) while `isRetryable()` says an action is waiting. A flip back to offline, repeated
 * online events and a connection that was never lost do nothing. Returns the function that stops watching.
 */
export function watchReconnect(source: ConnectivitySource, retry: () => void, isRetryable: () => boolean): () => void {
  let wasOnline = source.isOnline();
  return source.subscribe(() => {
    const now = source.isOnline();
    const returned = !wasOnline && now;
    wasOnline = now;
    if (returned && isRetryable()) retry();
  });
}

/** True while something is in flight or unconfirmed: leaving the page then would lose the only copy of its Idempotency-Key. */
export function shouldWarnBeforeLeave(...states: readonly { busy: boolean; retryable: boolean }[]): boolean {
  return states.some((s) => s.busy || s.retryable);
}

export const OFFLINE_NOTICE = 'No connection. Sales and register changes cannot be recorded until it returns. Anything not yet confirmed is kept on this screen and retried safely when the connection comes back; do not close this page.';
