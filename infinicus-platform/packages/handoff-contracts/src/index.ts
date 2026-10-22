// @infinicus/handoff-contracts — typed LayerHandoff schemas per boundary (CLAUDE.md § 8)
export type { LayerHandoff, HandoffStatus, LineageEntry } from '@infinicus/shared-types';

// One file per adjacent layer boundary — fill in payload types as blocks are imported
export * from './dal-to-bo';
export * from './bo-to-bi';
export * from './bi-to-dt';
export * from './dt-to-sim';
export * from './sim-to-adi';
export * from './adi-to-aba';
// ADI structured proposed action (AC-1): machine-readable first-action proposal carried by an ADI recommendation version.
export * from './adi-proposed-action';
export * from './aba-to-om';
export * from './om-to-cl';
// OM -> CL learning release decision (CL-BOUNDARY-1): composes the one learning gate with scope, source and linkage checks.
export * from './om-to-cl-learning-release';
export * from './cl-feedback';

// Authorized Action Package (P0-5): ABA -> BO authorization contract
export * from './authorized-action-package';

// Execution evidence (P0-6d): BO -> OM execution fact contract, reader port and OM state vocabulary / learning gate.
export * from './execution-evidence';
export * from './bi-financial';
export * from './bi-sales';
