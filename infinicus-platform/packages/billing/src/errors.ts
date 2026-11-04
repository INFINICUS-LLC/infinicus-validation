export class SubscriptionSuspendedError extends Error {
  constructor() {
    super('This tenant\'s subscription is suspended — the requested action is not permitted');
    this.name = 'SubscriptionSuspendedError';
  }
}

export class SubscriptionCanceledError extends Error {
  constructor() {
    super('This tenant\'s subscription is canceled — the requested action is not permitted');
    this.name = 'SubscriptionCanceledError';
  }
}

export class FeatureNotEntitledError extends Error {
  constructor(featureKey: string) {
    super(`The current plan does not include the "${featureKey}" feature`);
    this.name = 'FeatureNotEntitledError';
  }
}

export class CapabilityNotEntitledError extends Error {
  constructor(capability: string) {
    super(`This tenant is not entitled to the "${capability}" capability`);
    this.name = 'CapabilityNotEntitledError';
  }
}
