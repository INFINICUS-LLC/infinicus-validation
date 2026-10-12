// BO-owned read port for execution evidence (P0-6d). Outcome Monitoring obtains the sealed document through THIS port - it never reads a
// Business Operations table and never writes one. Null = unknown, out of scope or unavailable: the caller rejects and nothing is disclosed.
import type { PackageScope } from '../authorized-action-package/types';
import type { ExecutionEvidenceRecord } from './types';

export interface ExecutionEvidenceReader {
  get(request: { executionId: string; scope: PackageScope }): Promise<ExecutionEvidenceRecord | null>;
}
