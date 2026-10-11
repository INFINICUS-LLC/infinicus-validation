// @infinicus/onboarding — tenant onboarding orchestration: tenant/workspace/business
// creation, owner assignment, default settings, team invitations, resumable progress.

export {
  TenantNotFoundError, TenantSlugConflictError,
  WorkspaceNotFoundError, WorkspaceSlugConflictError,
  BusinessNotFoundError, BusinessCodeConflictError,
  OnboardingNotFoundError, OnboardingStepOrderError, OnboardingAlreadyTerminalError,
} from './errors.js';

export { OnboardingService } from './OnboardingService.js';
export type { BeginOnboardingInput, BeginOnboardingResult, CreateOnboardingBusinessInput } from './OnboardingService.js';

export { OwnerApproverAuthorityService, OWNER_BOOTSTRAP_AUTHORITY } from './OwnerApproverAuthorityService.js';
export type { OwnerBootstrapOutcome, OwnerBootstrapResult } from './OwnerApproverAuthorityService.js';

export {
  BusinessDeclaredCurrencyService, DECLARED_CURRENCY_AUDIT_ENTITY, DECLARED_CURRENCY_AUDIT_DECLARED, DECLARED_CURRENCY_AUDIT_CHANGED,
} from './BusinessDeclaredCurrencyService.js';
export type {
  DeclaredCurrencyRequestContext, DeclareCurrencyRequest, DeclareCurrencyResponse, BusinessDeclaredCurrencyDependencies,
} from './BusinessDeclaredCurrencyService.js';
