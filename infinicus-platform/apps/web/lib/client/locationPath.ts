/**
 * The address the page is showing, as a small injectable source (POS-8d-2a), so the business id can be read the same way whether the counter is served
 * by a Next server or bundled as static files inside the device shell. In a static export a route like `/businesses/[businessId]/counter` is built ONCE
 * with a placeholder id and the shell serves that page for every business address, so the framework's own route parameter would be the placeholder. The
 * real address in the browser is the truth. Only the PATH is read (never the query string or fragment: guard NA-05), and the id taken from it is accepted
 * only when it is a well-formed id (`businessIdFromPath`). The id carries no authority: every request is still verified by the API.
 */
import { businessIdFromPath } from './businessTabs';

export interface LocationSource {
  /** The current address path, or '' where there is no window (server rendering). */
  pathname(): string;
  /** Calls `listener` when the user moves back or forward; returns a function that stops listening. */
  subscribe(listener: () => void): () => void;
}

export const browserLocation: LocationSource = {
  pathname: () => (typeof window === 'undefined' ? '' : window.location.pathname),
  subscribe: (listener) => {
    if (typeof window === 'undefined') return () => undefined;
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
  },
};

/** The business id in the current address, or null when the address is not a business screen or the id is malformed. */
export const currentBusinessId = (source: LocationSource = browserLocation): string | null => businessIdFromPath(source.pathname());
