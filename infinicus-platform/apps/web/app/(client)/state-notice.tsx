'use client';

import type { AuthState } from '../../lib/client/authController';
import { useAuth } from './auth-provider';

/** Renders the non-happy states every authenticated page shares. Returns null when the page may show its own content. */
export function StateNotice({ state }: { state: AuthState }) {
  const { signOut, retry } = useAuth();
  switch (state.status) {
    case 'unconfigured':
      return (
        <div className="card">
          <p className="notice danger" role="alert">
            This deployment is not configured for sign-in. {state.missing.length ? `Missing: ${state.missing.join(', ')}. ` : ''}
            {state.invalid.length ? `Invalid: ${state.invalid.join(', ')}.` : ''}
          </p>
        </div>
      );
    case 'loading':
    case 'exchanging':
      return <div className="card"><p role="status" aria-live="polite">{state.status === 'loading' ? 'Loading…' : 'Signing you in…'}</p></div>;
    case 'error':
      return (
        <div className="card">
          <p className="notice danger" role="alert">{state.message}</p>
          <p>
            <button type="button" onClick={retry}>Try again</button>{' '}
            <button type="button" className="secondary" onClick={() => { void signOut(); }}>Sign out</button>
          </p>
        </div>
      );
    default:
      return null;
  }
}
