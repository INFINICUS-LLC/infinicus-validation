import { createHash } from 'node:crypto';

/**
 * Managed accounts are backend identities that exist ONLY as the counterpart of an external identity provider's user
 * (today: the Supabase user behind the public site). They have no usable password: they are reachable solely through
 * AuthenticationService.startManagedSession(), which the API calls after the provider has verified a token.
 *
 * The email local part is derived from the provider's immutable user id. The derivation is the SAME one the browser used
 * before J-3 (index.html), so every existing account, tenant and business keeps resolving to the same backend user.
 * Do not change the algorithm or the label: doing so would orphan existing accounts.
 */
export const MANAGED_ACCOUNT_EMAIL_DOMAIN = 'infini-cus.local';

const EMAIL_DERIVATION_LABEL = 'infinicus-shadow-email-v2';

/** True when the address belongs to the reserved managed-account domain (domain only, trimmed, case-insensitive). */
export function isManagedAccountEmail(email: string): boolean {
  const at = email.trim().lastIndexOf('@');
  if (at < 0) return false;
  return email.trim().slice(at + 1).toLowerCase() === MANAGED_ACCOUNT_EMAIL_DOMAIN;
}

/** Deterministic managed-account email for a provider user id. Must stay identical to the legacy browser derivation. */
export function managedAccountEmailFor(providerUserId: string): string {
  const digest = createHash('sha256').update(`${EMAIL_DERIVATION_LABEL}:${providerUserId}`, 'utf8').digest('hex');
  return `shadow-${digest.slice(0, 32)}@${MANAGED_ACCOUNT_EMAIL_DOMAIN}`;
}
