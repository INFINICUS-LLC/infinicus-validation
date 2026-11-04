export { EntitlementService } from './EntitlementService.js';
export type { SubscriptionWithPlan } from './EntitlementService.js';
export { SubscriptionSuspendedError, SubscriptionCanceledError, FeatureNotEntitledError, CapabilityNotEntitledError } from './errors.js';
export { CAPABILITIES, entitlementProfileFor, entitlementProfileFromStore, isCapability } from './capabilities.js';
export type { Capability, EntitlementProfile } from './capabilities.js';
