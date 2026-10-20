'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { browserConnectivity, OFFLINE_NOTICE, shouldWarnBeforeLeave, watchReconnect, type ConnectivitySource } from '../../../../../lib/client/connectivity';

/** Whether the browser currently has a network connection (always true while rendering on the server). */
export function useOnline(source: ConnectivitySource = browserConnectivity): boolean {
  return useSyncExternalStore(source.subscribe, source.isOnline, () => true);
}

/** Retries an unconfirmed action once each time the connection returns. The callbacks may change every render; the latest ones are used. */
export function useReconnectRetry(retry: () => void, isRetryable: () => boolean, source: ConnectivitySource = browserConnectivity): void {
  useEffect(() => watchReconnect(source, retry, isRetryable), [source, retry, isRetryable]);
}

/** Asks the browser to confirm before the page is closed or reloaded while an action is in flight or unconfirmed. */
export function useLeaveWarning(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const handler = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);
}

export { shouldWarnBeforeLeave };

/** Shown above the counter while offline. */
export function ConnectionBanner({ online }: { online: boolean }) {
  if (online) return null;
  return <p className="notice danger connection-banner" role="status" aria-live="polite">{OFFLINE_NOTICE}</p>;
}
