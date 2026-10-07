// @infinicus/data-acquisition-runtime — public API

export * from './errors.js';
export * from './types.js';
export * from './webhook/types.js';

export { canonicalizeRecord, hashRecord, ProvenanceService } from './provenance/ProvenanceService.js';

export {
  MAX_RECORDS_PER_REQUEST,
  MAX_NESTING_DEPTH,
  MAX_KEYS_PER_OBJECT,
  MAX_STRING_LENGTH,
  MAX_ARRAY_LENGTH,
} from './validation/schemas.js';
export { ManualRecordValidator } from './validation/ManualRecordValidator.js';

export { DataQualityScoringService, DEFAULT_QUALITY_WEIGHTS } from './quality/DataQualityScoringService.js';

export {
  PublicationService,
  SUPPORTED_TARGET_LAYERS,
  MINIMUM_QUALITY_SCORE_FOR_PUBLICATION,
} from './publication/PublicationService.js';
export type { PackagePreparationInput, PublishInput } from './publication/PublicationService.js';

export { DataAcquisitionService } from './DataAcquisitionService.js';
