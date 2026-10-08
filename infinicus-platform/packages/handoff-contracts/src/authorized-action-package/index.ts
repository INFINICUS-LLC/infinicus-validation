// AuthorizedActionPackage v1 (P0-5 Block 2): pure, serializable contract shared by ABA (issuer) and Business Operations
// (consumer). No database, no I/O, no clock; the only runtime dependency is Node's built-in crypto for SHA-256. See docs/architecture/reconciliation/P0-5_BLOCK2_CONTRACT.md.
export * from './types';
export * from './action-types';
export * from './canonical';
export * from './validator';
