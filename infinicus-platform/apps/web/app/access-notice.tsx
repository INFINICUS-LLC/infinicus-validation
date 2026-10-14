import type { ContextFailure } from '../lib/context';

const MESSAGES: Record<ContextFailure, string> = {
  unauthenticated: 'Sign in is required. This build has no login screen yet; a valid session is needed to view this page.',
  no_workspace: 'No workspace is selected for your session.',
  forbidden: 'You do not have access to this workspace or this page.',
};

/** Deliberately uniform: no tenant, workspace or user detail is echoed back. */
export function AccessNotice({ reason }: { reason: ContextFailure }) {
  return (
    <div className="card">
      <p className="notice danger" role="alert">{MESSAGES[reason]}</p>
    </div>
  );
}
