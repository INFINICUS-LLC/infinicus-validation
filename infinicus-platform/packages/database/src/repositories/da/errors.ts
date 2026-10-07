/**
 * Controlled error types for the Data Acquisition persistence layer.
 *
 * NotFoundError previously lived in DataSourceRepository.ts. It is moved here
 * so BUILD-31 transition errors can share a dedicated module without circular
 * imports. DataSourceRepository.ts must re-export NotFoundError to preserve the
 * existing public import path.
 */

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(entity + ' not found: ' + id);
    this.name = 'NotFoundError';
  }
}

export class InvalidStateTransitionError extends Error {
  readonly entity: string;
  readonly id: string;
  readonly expected: readonly string[];
  readonly actual: string;
  readonly requested: string;

  constructor(
    entity: string,
    id: string,
    expected: readonly string[],
    actual: string,
    requested: string,
  ) {
    const allowed = expected.join(', ');

    super(
      'Cannot transition ' +
        entity +
        ' ' +
        id +
        ' to "' +
        requested +
        '": expected current state one of [' +
        allowed +
        '], found "' +
        actual +
        '"',
    );

    this.name = 'InvalidStateTransitionError';
    this.entity = entity;
    this.id = id;
    this.expected = expected;
    this.actual = actual;
    this.requested = requested;
  }
}

export class DuplicateSourceCodeError extends Error {
  readonly sourceCode: string;

  constructor(sourceCode: string) {
    super(
      'A data source with code "' +
        sourceCode +
        '" already exists in this workspace',
    );

    this.name = 'DuplicateSourceCodeError';
    this.sourceCode = sourceCode;
  }
}

export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvenanceError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class UnsupportedConnectorError extends Error {
  readonly connectorType: string;

  constructor(connectorType: string) {
    super('Unsupported connector type: "' + connectorType + '"');

    this.name = 'UnsupportedConnectorError';
    this.connectorType = connectorType;
  }
}

export class CollectionLimitExceededError extends Error {
  readonly limitName: string;
  readonly limit: number;
  readonly actual: number;

  constructor(limitName: string, limit: number, actual: number) {
    super(
      'Collection limit "' + limitName + '" exceeded: max ' + limit + ', got ' + actual,
    );

    this.name = 'CollectionLimitExceededError';
    this.limitName = limitName;
    this.limit = limit;
    this.actual = actual;
  }
}

export class PublicationNotReadyError extends Error {
  readonly packageId: string;
  readonly reason: string;

  constructor(packageId: string, reason: string) {
    super('Publication package ' + packageId + ' is not ready to publish: ' + reason);

    this.name = 'PublicationNotReadyError';
    this.packageId = packageId;
    this.reason = reason;
  }
}

export class QualityThresholdError extends Error {
  readonly overallScore: number;
  readonly minimumRequired: number;

  constructor(overallScore: number, minimumRequired: number) {
    super(
      'Quality score ' + overallScore + ' is below the minimum required ' + minimumRequired +
        ' for this operation',
    );

    this.name = 'QualityThresholdError';
    this.overallScore = overallScore;
    this.minimumRequired = minimumRequired;
  }
}

/** Wrong or unknown webhook bearer token. Deliberately used for both "no such prefix" and "prefix exists, secret is wrong" — never confirms or denies that a token prefix exists. */
export class WebhookAuthenticationError extends Error {
  constructor(message = 'Invalid or missing webhook token.') {
    super(message);
    this.name = 'WebhookAuthenticationError';
  }
}
