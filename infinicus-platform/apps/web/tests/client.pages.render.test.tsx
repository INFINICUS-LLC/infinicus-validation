import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';
import { AccountBar } from '../app/(client)/account-bar';
import SignInPage from '../app/(client)/sign-in/page';
import WorkspacesPage from '../app/(client)/workspaces/page';
import ConsolePage from '../app/(client)/console/page';
import type { AuthState } from '../lib/client/authController';
import { membership } from './helpers/fakes';

const value = (state: AuthState): AuthContextValue => ({
  state, api: null, signIn: async () => ({ ok: true as const }), signOut: async () => undefined, selectWorkspace: () => true, retry: () => undefined,
});
const html = (state: AuthState, el: ReactElement) => renderToString(<AuthContext.Provider value={value(state)}>{el}</AuthContext.Provider>).replace(/<!-- -->/g, '');   // React's text-node separators

const a = membership('Acme'); const b = membership('Bolt');
const readyTwo: AuthState = { status: 'ready', email: 'owner@example.test', memberships: [a, b], scope: { tenantId: a.tenantId, workspaceId: a.workspaceId } };

describe('client pages render every state (server-rendered output)', () => {
  it('sign-in: labelled fields with the right autocomplete hints and a submit button; a notice is announced', () => {
    const out = html({ status: 'signed-out', notice: 'Your session has ended. Please sign in again.' }, <SignInPage />);
    expect(out).toContain('for="email"');
    expect(out).toContain('id="password"');
    expect(out).toContain('type="password"');
    expect(out).toContain('autoComplete="current-password"');
    expect(out).toContain('type="submit"');
    expect(out).toContain('role="status"');
    expect(out).toContain('Your session has ended');
  });

  it('every page shows the shared non-happy states: not configured (names only), loading, signing in, retryable error', () => {
    const unconfigured = html({ status: 'unconfigured', missing: ['NEXT_PUBLIC_API_BASE_URL'], invalid: [] }, <WorkspacesPage />);
    expect(unconfigured).toContain('role="alert"');
    expect(unconfigured).toContain('NEXT_PUBLIC_API_BASE_URL');
    expect(unconfigured).not.toContain('<form');
    expect(html({ status: 'loading' }, <ConsolePage />)).toContain('Loading');
    expect(html({ status: 'exchanging' }, <SignInPage />)).toContain('Signing you in');
    const err = html({ status: 'error', message: 'The sign-in service is temporarily unavailable. Please try again.' }, <ConsolePage />);
    expect(err).toContain('role="alert"');
    expect(err).toContain('Try again');
    expect(err).toContain('Sign out');
  });

  it('workspaces: lists the caller\'s workspaces as buttons, marks the selected one, and has an explained empty state', () => {
    const out = html(readyTwo, <WorkspacesPage />);
    expect(out).toContain('aria-label="Your workspaces"');
    expect(out).toContain('Acme Co');
    expect(out).toContain('Bolt workspace');
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    const empty = html({ status: 'ready', email: 'x@example.test', memberships: [], scope: null }, <WorkspacesPage />);
    expect(empty).toContain('not an active member of any workspace');
  });

  it('console: shows the selected workspace and the connection check', () => {
    const out = html(readyTwo, <ConsolePage />);
    expect(out).toContain('Acme Co / Acme workspace');
    expect(out).toContain('checking');
  });

  it('account bar: shows who is signed in with a sign-out control only when ready, and nothing otherwise', () => {
    const out = html(readyTwo, <AccountBar />);
    expect(out).toContain('owner@example.test');
    expect(out).toContain('Sign out');
    expect(out).toContain('Change workspace');
    expect(html({ status: 'signed-out' }, <AccountBar />)).toBe('');
    expect(html({ status: 'loading' }, <AccountBar />)).toBe('');
  });

  it('nothing rendered contains a token-like or storage-key value', () => {
    const out = html(readyTwo, <ConsolePage />) + html(readyTwo, <AccountBar />) + html(readyTwo, <WorkspacesPage />);
    expect(out).not.toMatch(/raw-|provider-|Bearer|inf_web_scope/);
  });
});
