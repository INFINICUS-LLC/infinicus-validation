/**
 * BUILD-31 §7 freezes one error model shared by the persistence layer
 * (packages/database/src/repositories/da/errors.ts) and this runtime
 * package. Re-exporting rather than redeclaring keeps `instanceof` checks
 * valid across the package boundary — a ProvenanceError thrown inside a
 * repository and one thrown inside DataAcquisitionService must be the same
 * class, not two same-named classes that fail instanceof against each
 * other.
 */
import {
  NotFoundError,
  InvalidStateTransitionError,
  DuplicateSourceCodeError,
  // Aliased at the @infinicus/database barrel to avoid ambiguity with
  // other domains' identically-named ValidationError/ProvenanceError
  // classes — see packages/database/src/index.ts.
  DAProvenanceError as ProvenanceError,
  DAValidationError as ValidationError,
  UnsupportedConnectorError,
  CollectionLimitExceededError,
  PublicationNotReadyError,
  QualityThresholdError,
  WebhookAuthenticationError,
} from '@infinicus/database';

export {
  NotFoundError,
  InvalidStateTransitionError,
  DuplicateSourceCodeError,
  ProvenanceError,
  ValidationError,
  UnsupportedConnectorError,
  CollectionLimitExceededError,
  PublicationNotReadyError,
  QualityThresholdError,
  WebhookAuthenticationError,
};
