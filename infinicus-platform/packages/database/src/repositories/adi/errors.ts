export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(entity: string, reason: string) {
    super(`${entity} conflict: ${reason}`);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends Error {
  constructor(entity: string, reasons: readonly string[]) {
    super(`${entity} invalid: ${reasons.join(', ')}`);
    this.name = 'ValidationError';
  }
}

export class InvalidTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`${entity} invalid transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class ADIIntakeValidationError extends ValidationError {}
export class ADIIntakeScopeMismatchError extends ConflictError {}
export class DecisionQuestionNotFoundError extends NotFoundError {}
export class DecisionQuestionStateConflictError extends ConflictError {}
export class DecisionCaseNotFoundError extends NotFoundError {}
export class DecisionCaseStateConflictError extends ConflictError {}
export class ReasoningRunNotFoundError extends NotFoundError {}
export class ReasoningRunStateConflictError extends ConflictError {}
export class DecisionEvidenceNotFoundError extends NotFoundError {}
export class DecisionEvidenceStateConflictError extends ConflictError {}
export class DecisionAlternativeNotFoundError extends NotFoundError {}
export class DecisionAlternativeStateConflictError extends ConflictError {}
export class DecisionRecommendationNotFoundError extends NotFoundError {}
export class DecisionRecommendationStateConflictError extends ConflictError {}
export class DecisionRecommendationImmutableError extends ConflictError {}
export class DecisionRecommendationValidationError extends ValidationError {
  constructor(reasons: readonly string[]) {
    super('DecisionRecommendationRiskValidity', reasons);
  }
}
export class DecisionPolicyNotFoundError extends NotFoundError {}
export class DecisionPolicyStateConflictError extends ConflictError {}
export class DecisionMonitoringRequirementNotFoundError extends NotFoundError {}
export class ADIPublicationStateConflictError extends ConflictError {}
export class ADIComponentRegistryNotFoundError extends NotFoundError {}
export class ADIDuplicateArtifactError extends ConflictError {}
export class ADIUnsupportedVersionError extends ValidationError {}
export class ADIPayloadTooLargeError extends ValidationError {}
export class ADICredentialContentError extends ValidationError {}
export class ADIEvidenceMissingError extends ValidationError {}
export class ADILineageInvalidError extends ValidationError {}
