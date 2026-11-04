export { EntitlementService } from './EntitlementService.js';
export type { SubscriptionWithPlan } from './EntitlementService.js';
export { SubscriptionSuspendedError, SubscriptionCanceledError, FeatureNotEntitledError, CapabilityNotEntitledError } from './errors.js';
export { CAPABILITIES, entitlementProfileFor, entitlementProfileFromStore, isCapability } from './capabilities.js';
export type { Capability, EntitlementProfile } from './capabilities.js';
export { ProviderBillingService } from './provider/ProviderBillingService.js';
export { PROVIDER_RESULT_CODES } from './provider/commands.js';
export type { ProviderBillingCommand, ProviderEventEnvelope, ProviderEventOutcome, ProviderResultCode, ProviderPaymentStatus, ProviderSubscriptionState } from './provider/commands.js';
