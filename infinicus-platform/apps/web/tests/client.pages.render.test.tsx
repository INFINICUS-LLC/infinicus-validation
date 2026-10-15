import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';

let routeParams: Record<string, string> = { businessId: '33333333-3333-4333-8333-333333333333' };
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useParams: () => routeParams }));

import { AuthContext, type AuthContextValue } from '../app/(client)/auth-provider';
import { AccountBar } from '../app/(client)/account-bar';
import SignInPage from '../app/(client)/sign-in/page';
import WorkspacesPage from '../app/(client)/workspaces/page';
import ConsolePage from '../app/(client)/console/page';
import BusinessesPage from '../app/(client)/businesses/page';
import WorkflowPage from '../app/(client)/businesses/[businessId]/workflow/page';
import HistoryPage from '../app/(client)/businesses/[businessId]/history/page';
import { BusinessListView, WorkflowSections, HistorySections } from '../app/(client)/businesses/sections';
import { DecisionForm } from '../app/(client)/businesses/decision-form';
import { OutcomeForm } from '../app/(client)/businesses/outcome-form';
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

const BIZ = '33333333-3333-4333-8333-333333333333';
const uid = () => crypto.randomUUID();
const view = {
  business: { id: BIZ, legalName: 'Acme Ltd', businessCode: 'ACME', status: 'active', industry: 'retail', tradingName: null, legalStructure: 'llc', businessModel: null },
  biEvidence: [{ id: uid(), packageCode: 'insight-1', status: 'published', latestVersion: 2 }],
  dtLatestSnapshot: { snapshotCode: 'snap-1', status: 'published', effectiveAt: '2026-10-15T12:00:00.000Z' },
  simulationLatestResult: { resultCode: 'res-1', status: 'published' },
  simulationRuns: [{ id: uid(), runCode: 'run-1', status: 'queued', sampleSize: 500 }],
  adiLatestRecommendation: { recommendationCode: 'rec-1', status: 'published' },
  abaLatestDecision: { decisionCode: 'dec-1', status: 'approved' },
  outcomes: [{ id: uid(), observationCode: 'obs-1', status: 'recorded' }],
};
const emptyView = { ...view, biEvidence: [], dtLatestSnapshot: null, simulationLatestResult: null, simulationRuns: [], adiLatestRecommendation: null, abaLatestDecision: null, outcomes: [] };

describe('lifecycle screens (NA-05) render every state', () => {
  it('business list: links to each business workflow, and an explained empty state', () => {
    const out = renderToString(<BusinessListView data={{ items: [{ id: BIZ, legalName: 'Acme Ltd', businessCode: 'ACME', status: 'active', industry: 'retail' }], page: 1, pageSize: 20, total: 1 }} />).replace(/<!-- -->/g, '');
    expect(out).toContain(`href="/businesses/${BIZ}/workflow"`);
    expect(out).toContain('Acme Ltd');
    expect(out).toContain('aria-label="Businesses"');
    expect(renderToString(<BusinessListView data={{ items: [], page: 1, pageSize: 20, total: 0 }} />)).toContain('No businesses found in this workspace yet.');
  });

  it('workflow sections: every stage shows its data when present and an empty-state sentence when not (same content as the old screen)', () => {
    const full = renderToString(<WorkflowSections view={view} />).replace(/<!-- -->/g, '');
    for (const text of ['Acme Ltd', 'insight-1', 'snap-1', 'res-1', 'run-1', 'rec-1', 'dec-1', 'obs-1', 'Data review', 'BI evidence', 'Digital twin state', 'Simulation execution', 'ADI recommendation', 'ABA review']) expect(full).toContain(text);
    const empty = renderToString(<WorkflowSections view={emptyView} />);
    for (const text of ['No BI evidence published', 'No published digital twin snapshot', 'No published simulation result', 'No published AI recommendation', 'No approval decision recorded yet', 'No outcome observations recorded yet']) expect(empty).toContain(text);
  });

  it('history sections: five independent lists with empty states', () => {
    const out = renderToString(<HistorySections history={{ biEvidence: [{ id: uid(), packageCode: 'p-1', status: 'published' }], simulationRuns: [], adiCases: [{ id: uid(), caseCode: 'c-1', status: 'open' }], abaReviews: [], outcomes: [] }} />);
    expect(out).toContain('p-1'); expect(out).toContain('c-1');
    expect(out).toContain('No simulation runs yet.'); expect(out).toContain('No ABA reviews yet.'); expect(out).toContain('No outcomes recorded yet.');
  });

  it('the decision and outcome forms are labelled, marked required, and offer the three decisions', () => {
    const scope = { tenantId: uid(), workspaceId: uid() };
    const d = html(readyTwo, <DecisionForm businessId={BIZ} scope={scope} onDone={() => undefined} />);
    expect(d).toContain('for="intakePackageId"'); expect(d).toContain('for="aba-summary"'); expect(d).toContain('for="decision-outcome"');
    expect(d).toContain('aria-required="true"'); expect(d).toContain('Approve with modifications'); expect(d).toContain('Reject');
    expect(d).not.toMatch(/approver|assignment|tenant|workspace/i);                       // no identity-ish inputs
    const o = html(readyTwo, <OutcomeForm businessId={BIZ} scope={scope} onDone={() => undefined} />);
    expect(o).toContain('for="monitoredActionId"'); expect(o).toContain('for="outcome-summary"'); expect(o).toContain('Record outcome');
  });

  it('the pages show a loading state first, the shared notices when not ready, and refuse an invalid business address', () => {
    expect(html(readyTwo, <BusinessesPage />)).toContain('Loading');
    expect(html(readyTwo, <WorkflowPage />)).toContain('Loading');
    expect(html(readyTwo, <HistoryPage />)).toContain('Loading');
    expect(html({ status: 'unconfigured', missing: ['NEXT_PUBLIC_API_BASE_URL'], invalid: [] }, <BusinessesPage />)).toContain('role="alert"');
    expect(html({ status: 'loading' }, <WorkflowPage />)).toContain('Loading');
    routeParams = { businessId: 'not-a-uuid' };
    try {
      for (const page of [<WorkflowPage key="w" />, <HistoryPage key="h" />]) {
        const out = html(readyTwo, page);
        expect(out).toContain('That business address is not valid.');
        expect(out).toContain('href="/businesses"');
      }
    } finally { routeParams = { businessId: BIZ }; }
  });
});
