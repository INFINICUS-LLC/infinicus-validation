export class EventingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly metadata: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class EventLedgerValidationError extends EventingError {
  constructor(reasons: readonly string[]) {
    super('EVENT_LEDGER_VALIDATION_FAILED', 'Business event validation failed', {
      reasons: reasons.join(','),
    });
  }
}

export class EventLedgerScopeError extends EventingError {
  constructor() {
    super('EVENT_LEDGER_SCOPE_MISMATCH', 'Event tenant/workspace does not match transaction context');
  }
}

export class EventLedgerConflictError extends EventingError {
  constructor(eventId: string) {
    super('EVENT_LEDGER_CONFLICT', 'Business event conflicts with an existing immutable event', { eventId });
  }
}

export class EventLedgerNotFoundError extends EventingError {
  constructor(eventId: string) {
    super('EVENT_LEDGER_NOT_FOUND', 'Business event was not found', { eventId });
  }
}
