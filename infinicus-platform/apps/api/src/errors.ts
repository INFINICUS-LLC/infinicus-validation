/**
 * Maps every domain error's `.name` to an HTTP status code. A name-based
 * lookup (rather than importing and instanceof-checking every error class
 * from every package this API wraps) keeps this file from needing to
 * depend on the full transitive set of error classes across
 * @infinicus/database, @infinicus/authentication, @infinicus/authorization,
 * @infinicus/onboarding, and @infinicus/workflow — new error classes added
 * to those packages later just need an entry here, nothing else changes.
 *
 * IMPORTANT: every domain's errors.ts under packages/database defines its
 * specific error classes (MembershipNotFoundError, TenantSlugConflictError,
 * etc.) as EMPTY subclasses of a shared per-domain base (NotFoundError /
 * ConflictError / ValidationError / InvalidTransitionError). The base
 * class's constructor unconditionally sets `this.name` to its own generic
 * name, and an empty subclass doesn't override it — so at runtime every one
 * of those specific-looking error names never actually appears; only the
 * generic base name does. This table keys off what's actually thrown.
 * Errors that DO set their own unique `.name` (auth/authz package errors,
 * onboarding's OnboardingStepOrderError/OnboardingAlreadyTerminalError,
 * this build's own Idempotency* errors) are listed individually below.
 *
 * Anything NOT in this table is treated as an unexpected server error:
 * logged in full server-side, but returned to the client as a generic,
 * redacted 500 — never the original error message or stack (security
 * baseline: "controlled redacted errors").
 */
export const ERROR_STATUS_CODES: Record<string, number> = {
  // Generic per-domain base errors (@infinicus/database) — see note above:
  // every specific NotFoundError/ConflictError/ValidationError subclass
  // across da/bo/bi/dt/simulation/adi/aba/om/cl/auth/onboarding reports
  // one of these names at runtime, not its own subclass name.
  NotFoundError: 404,
  ConflictError: 409,
  ValidationError: 400,
  InvalidTransitionError: 409,

  // Authentication (@infinicus/authentication)
  InvalidCredentialsError: 401,
  AccountNotActiveError: 403,
  // 429, not 401/403 — the credentials supplied may well be correct; the
  // account is rate-limited, not rejected (BUILD-18 known-limitations item,
  // closed: "No account lockout / rate limiting").
  AccountLockedError: 429,
  SessionExpiredError: 401,
  SessionRevokedError: 401,
  SessionInvalidError: 401,
  ApiKeyInvalidError: 401,
  WeakPasswordError: 400,
  VerificationTokenInvalidError: 400,

  // Authorization (@infinicus/authorization)
  PermissionDeniedError: 403,
  MembershipNotActiveError: 403,
  InvitationTokenInvalidError: 400,
  InvitationExpiredError: 400,

  // Onboarding domain errors that set their own unique name
  // (@infinicus/database/repositories/onboarding — not empty subclasses)
  OnboardingStepOrderError: 409,
  OnboardingAlreadyTerminalError: 409,
  OnboardingNotInitiatorError: 403,

  // API layer (this build) — all set their own unique name
  IdempotencyConflictError: 409,
  IdempotencyInProgressError: 409,

  // Billing and entitlements (@infinicus/database/repositories/billing,
  // @infinicus/billing — BUILD-28). PlanNotFoundError/SubscriptionNotFoundError
  // are empty NotFoundError subclasses (see note above) and already covered
  // by the generic NotFoundError entry; SubscriptionAlreadyExistsError is
  // likewise covered by the generic ConflictError entry. Only the errors
  // below set their own unique .name.
  InvalidSubscriptionTransitionError: 409,
  // 402 Payment Required — the plan's usage quota is exhausted for this
  // billing period; the caller needs to upgrade, not retry (unlike a 429
  // rate limit, which is about request pacing, not plan entitlement).
  UsageLimitExceededError: 402,
  SubscriptionSuspendedError: 402,
  SubscriptionCanceledError: 402,
  FeatureNotEntitledError: 403,

  // Incident response (@infinicus/database/repositories/incident — BUILD-29).
  // PlatformIncidentNotFoundError is an empty NotFoundError subclass (see
  // note above) and already covered by the generic NotFoundError entry.
  PlatformIncidentAlreadyResolvedError: 409,

  // Data Acquisition runtime (@infinicus/database/repositories/da — BUILD-31).
  // Unlike most other domains, these set their own unique .name rather than
  // reporting through the generic NotFoundError/ConflictError/ValidationError
  // base — see errors.ts under packages/database/src/repositories/da/.
  InvalidStateTransitionError: 409,
  DuplicateSourceCodeError: 409,
  UnsupportedConnectorError: 400,
  ProvenanceError: 400,
  CollectionLimitExceededError: 413,
  PublicationNotReadyError: 409,
  QualityThresholdError: 409,

  // Business Operations runtime (BUILD-32)
  BusinessIntakeRejectedError: 400,
  UnsupportedOperationalRecordTypeError: 400,
  OperationalMappingError: 400,
  OperationalStateTransitionError: 409,

  // Fastify / schema validation
  FST_ERR_VALIDATION: 400,
};

export interface ControlledError {
  code: string;
  message: string;
  correlationId: string;
}

export function statusCodeFor(errorName: string | undefined): number {
  if (!errorName) return 500;
  return ERROR_STATUS_CODES[errorName] ?? 500;
}
