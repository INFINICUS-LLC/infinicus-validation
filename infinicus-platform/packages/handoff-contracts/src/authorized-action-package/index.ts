// AuthorizedActionPackage v1 (P0-5 Block 2): pure, serializable contract shared by ABA (issuer) and Business Operations
// (consumer). No database, no I/O, no clock. See docs/architecture/reconciliation/P0-5_BLOCK2_CONTRACT.md.
export * from './types';
export * from './action-types';
export * from './canonical';
export * from './validator';
export { sha256Hex, utf8Bytes } from './sha256';
