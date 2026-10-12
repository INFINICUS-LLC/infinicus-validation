/**
 * Business Operations' implementation of the shared `ExecutionEvidenceReader` port (P0-6d): how Outcome Monitoring reads the canonical
 * execution evidence without touching a Business Operations table. Read-only: it returns the sealed document and the database times BO
 * recorded, for the exact execution in the exact scope - and null for anything else (unknown, other scope, malformed), disclosing nothing.
 * It never decides, mutates or emits.
 */
import { AuthorizedActionExecutionRepository } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import type { ExecutionEvidenceReader, ExecutionEvidenceRecord, PackageScope } from '@infinicus/handoff-contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BoExecutionEvidenceReaderDependencies {
  /** The system actor recorded in the tenant context of the read. Required: no default identity is invented. */
  actorUserId: string;
  executions?: Pick<AuthorizedActionExecutionRepository, 'getById'>;
}

export class BoExecutionEvidenceReader implements ExecutionEvidenceReader {
  private readonly executions: Pick<AuthorizedActionExecutionRepository, 'getById'>;
  private readonly actorUserId: string;

  constructor(deps: BoExecutionEvidenceReaderDependencies) {
    if (typeof deps.actorUserId !== 'string' || !UUID.test(deps.actorUserId)) throw new Error('a BO system actor user id (lowercase UUID) is required');
    this.actorUserId = deps.actorUserId;
    this.executions = deps.executions ?? new AuthorizedActionExecutionRepository();
  }

  async get(request: { executionId: string; scope: PackageScope }): Promise<ExecutionEvidenceRecord | null> {
    const s = request?.scope;
    if (typeof request?.executionId !== 'string' || !UUID.test(request.executionId) || !s || ![s.tenantId, s.workspaceId, s.businessId].every((x) => typeof x === 'string' && UUID.test(x))) return null;
    const ctx: TenantContext = { tenantId: s.tenantId, workspaceId: s.workspaceId, userId: this.actorUserId };
    const e = await this.executions.getById(ctx, request.executionId);
    if (!e || e.tenantId !== s.tenantId || e.workspaceId !== s.workspaceId || e.businessId !== s.businessId) return null;
    return { document: e.evidence, digest: e.evidenceDigest, recordedAt: e.recordedAt, executionCompletedAt: e.executionCompletedAt };
  }
}
