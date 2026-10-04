export class BusinessIntakeRejectedError extends Error {
  constructor(message: string, public readonly reasons: readonly string[] = []) {
    super(message);
    this.name = 'BusinessIntakeRejectedError';
  }
}

export class UnsupportedOperationalRecordTypeError extends Error {
  constructor(public readonly recordType: string) {
    super(`Unsupported operational record type: ${recordType}`);
    this.name = 'UnsupportedOperationalRecordTypeError';
  }
}

export class OperationalMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationalMappingError';
  }
}

export class OperationalStateTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`);
    this.name = 'OperationalStateTransitionError';
  }
}
