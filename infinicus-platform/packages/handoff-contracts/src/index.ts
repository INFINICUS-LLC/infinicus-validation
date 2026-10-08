// @infinicus/handoff-contracts — typed LayerHandoff schemas per boundary (CLAUDE.md § 8)
export type { LayerHandoff, HandoffStatus, LineageEntry } from '@infinicus/shared-types';

// One file per adjacent layer boundary — fill in payload types as blocks are imported
export * from './dal-to-bo';
export * from './bo-to-bi';
export * from './bi-to-dt';
export * from './dt-to-sim';
export * from './sim-to-adi';
export * from './adi-to-aba';
export * from './aba-to-om';
export * from './om-to-cl';
export * from './cl-feedback';

// Authorized Action Package (P0-5): ABA -> BO authorization contract
export * from './authorized-action-package';
