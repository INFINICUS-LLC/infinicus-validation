/**
 * BO-PUB-DEV-02 (aligned to the R4/D3 association model): durable publication of the inventory movement record evidence as ONE immutable association per BO publication
 * header, and the read-only reader that verifies it on every read.
 *
 * PUBLISHING (BO-owned). Reuses the BO extractor (BO-PUB-DEV-01) to build the verified artifact from the ledger and to check it against the authoritative publication
 * header, then stores it through the BO evidence repository (one transaction; the header is locked FOR UPDATE, an exact replay is returned, different content is a conflict, and the database
 * re-checks the creation state, the composite header key that pins scope and period, and the digest and id derivations).
 * It changes no header state, writes no event, touches no operational table and exposes no endpoint. AUTHORITY: the existing authorization model grants `bo:write`
 * to API callers, but nothing here is an API caller and no durable-publication permission exists, so authority cannot be established from the model. The service is
 * therefore FAIL-CLOSED: it publishes only when an explicit `PublicationAuthority` approves, and the default authority denies everything. Nothing in production passes
 * an approving authority; activation needs an owner-approved authority and route (see docs/bo-publication-evidence-durable.md).
 *
 * READING (BI readiness). `InventoryMovementEvidenceReader` is the only contract a consumer needs: given a scope and a publication header it returns the verified artifact
 * or a closed failure code. It depends on a read-only port (it cannot write), reads only the evidence tables (never the mutable ledger), and verifies EVERYTHING on read:
 * the stored canonical bytes are canonical, the stored columns agree with the body they cover, the digest and evidence id re-derive, the count agrees, and the artifact
 * passes the complete verifier. A stored artifact that was altered behind the application is reported as STORED_EVIDENCE_INTEGRITY, never returned.
 */
import {
  BoPublicationEvidenceRepository, type StoredPublicationEvidence, type TenantContext,
} from '@infinicus/database';
import {
  canonicalEvidenceBody, canonicalJson, verifyInventoryMovementEvidence, type InventoryMovementEvidence,
} from './inventoryMovementEvidence.js';
import { InventoryMovementEvidenceExtractor, type ExtractionFailureCode } from './InventoryMovementEvidenceExtractor.js';

/** Decides whether the caller may durably publish evidence for a business. Must be supplied explicitly; there is no approving default. */
export interface PublicationAuthority { mayPublish(ctx: TenantContext, businessId: string): Promise<boolean> }
/** The only authority this block ships: it denies. Durable publication stays inactive until an owner-approved authority replaces it. */
export const DisabledPublicationAuthority: PublicationAuthority = Object.freeze({ mayPublish: async () => false });

export type PublishFailureCode = ExtractionFailureCode | 'PUBLICATION_NOT_AUTHORIZED' | 'HEADER_NOT_READY' | 'EVIDENCE_CONFLICT' | 'EVIDENCE_REFUSED' | 'STORED_EVIDENCE_INTEGRITY';
export type PublishEvidenceResult =
  | { ok: true; evidence: InventoryMovementEvidence; replayed: boolean }
  | { ok: false; code: PublishFailureCode };
export interface PublishInventoryMovementEvidenceRequest {
  businessId: string;
  /** The authoritative BO publication header this evidence is published for (required: one evidence per header). */
  boPublicationPackageId: string;
  periodStart: string;
  periodEnd: string;
  correlationId: string;
}

export type ReadEvidenceFailureCode = 'EVIDENCE_NOT_FOUND' | 'STORED_EVIDENCE_INTEGRITY';
export type ReadEvidenceResult = { ok: true; evidence: InventoryMovementEvidence; storedAt: Date } | { ok: false; code: ReadEvidenceFailureCode };
/** What a consumer (Business Intelligence) is given: read-only, scope-controlled, verified. */
export interface PublishedInventoryMovementEvidenceReader { read(ctx: TenantContext, businessId: string, boPublicationPackageId: string): Promise<ReadEvidenceResult> }
/** The only repository capability the reader can use. */
export type PublicationEvidenceReadPort = Pick<BoPublicationEvidenceRepository, 'getByHeader'>;

/** Rebuilds the artifact from the stored canonical bytes and the stored columns. Returns null when the bytes are not the canonical form of what they decode to. */
function rebuild(s: StoredPublicationEvidence): InventoryMovementEvidence | null {
  let body: Record<string, unknown>;
  try { body = JSON.parse(s.canonicalBody) as Record<string, unknown>; } catch { return null; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  // the canonical bytes are the equality reference: they must be exactly the canonical serialization of what they decode to (no re-ordering, spacing or escaping drift)
  if (canonicalJson(body) !== s.canonicalBody) return null;
  return {
    ...(body as unknown as Omit<InventoryMovementEvidence, 'digest' | 'evidenceId' | 'provenance'>),
    digest: { algorithm: s.digestAlgorithm, canonicalization: s.canonicalization, value: s.digest },
    evidenceId: s.evidenceId,
    provenance: { correlationId: s.correlationId, owner: 'business_operations' },
  };
}

export class InventoryMovementEvidenceReader implements PublishedInventoryMovementEvidenceReader {
  constructor(private readonly store: PublicationEvidenceReadPort = new BoPublicationEvidenceRepository()) {}

  async read(ctx: TenantContext, businessId: string, boPublicationPackageId: string): Promise<ReadEvidenceResult> {
    const stored = await this.store.getByHeader(ctx, businessId, boPublicationPackageId);
    if (stored === null) return { ok: false, code: 'EVIDENCE_NOT_FOUND' };
    const bad: ReadEvidenceResult = { ok: false, code: 'STORED_EVIDENCE_INTEGRITY' };
    const artifact = rebuild(stored);
    if (artifact === null || !Array.isArray(artifact.records)) return bad;
    // the stored columns must agree with the body the digest covers (identity is never taken from the columns alone)
    const agrees = artifact.scope?.tenantId === stored.tenantId && artifact.scope?.workspaceId === stored.workspaceId && artifact.scope?.businessId === stored.businessId
      && artifact.source?.boPublicationPackageId === stored.publicationPackageId && artifact.source?.domain === stored.domain
      && artifact.source?.periodStart === stored.periodStart && artifact.source?.periodEnd === stored.periodEnd
      && artifact.recordSchemaVersion === stored.recordSchemaVersion && artifact.ordering === stored.ordering
      && artifact.contract?.name === stored.contractName && artifact.contract?.version === stored.contractVersion && artifact.contract?.status === stored.contractStatus
      && artifact.recordCount === stored.recordCount && artifact.records.length === stored.recordCount;
    if (!agrees) return bad;
    const verified = verifyInventoryMovementEvidence(artifact, { scope: artifact.scope, periodStart: stored.periodStart, periodEnd: stored.periodEnd, recordCount: stored.recordCount, digest: stored.digest });
    if (!verified.ok) return bad;
    return { ok: true, evidence: verified.value, storedAt: stored.createdAt };
  }
}

export class InventoryMovementEvidencePublicationService {
  constructor(
    private readonly authority: PublicationAuthority = DisabledPublicationAuthority,
    private readonly extractor: InventoryMovementEvidenceExtractor = new InventoryMovementEvidenceExtractor(),
    private readonly store: BoPublicationEvidenceRepository = new BoPublicationEvidenceRepository(),
    private readonly reader: PublishedInventoryMovementEvidenceReader = new InventoryMovementEvidenceReader(store),
  ) {}

  async publish(ctx: TenantContext, request: PublishInventoryMovementEvidenceRequest): Promise<PublishEvidenceResult> {
    // fail closed: no authority, no extraction, no read of the ledger
    // only an explicit `true` authorises (a truthy value, undefined or any other answer is a refusal); an authority that throws publishes nothing
    if ((await this.authority.mayPublish(ctx, request?.businessId)) !== true) return { ok: false, code: 'PUBLICATION_NOT_AUTHORIZED' };
    if (typeof request.boPublicationPackageId !== 'string') return { ok: false, code: 'REQUEST_INVALID' };

    const extracted = await this.extractor.extract(ctx, request);
    if (!extracted.ok) return { ok: false, code: extracted.code };
    const e = extracted.evidence;
    // the extractor verified it; verify once more at the storage boundary so only a verified artifact can ever be stored
    if (!verifyInventoryMovementEvidence(e).ok) return { ok: false, code: 'EVIDENCE_REFUSED' };

    const outcome = await this.store.append(ctx, e.scope.businessId, {
      publicationPackageId: e.source.boPublicationPackageId!, contractName: e.contract.name, contractVersion: e.contract.version, contractStatus: e.contract.status,
      recordSchemaVersion: e.recordSchemaVersion, domain: e.source.domain, periodStart: e.source.periodStart, periodEnd: e.source.periodEnd,
      ordering: e.ordering, canonicalization: e.digest.canonicalization, digestAlgorithm: e.digest.algorithm, recordCount: e.recordCount,
      digest: e.digest.value, evidenceId: e.evidenceId, canonicalBody: canonicalEvidenceBody(e), correlationId: e.provenance.correlationId,
    });
    if (outcome.outcome === 'UNKNOWN_BUSINESS') return { ok: false, code: 'BUSINESS_NOT_FOUND' };
    if (outcome.outcome === 'HEADER_NOT_FOUND') return { ok: false, code: 'HEADER_NOT_FOUND' };
    if (outcome.outcome === 'HEADER_NOT_ELIGIBLE') return { ok: false, code: 'HEADER_NOT_READY' };
    if (outcome.outcome === 'CONFLICT') return { ok: false, code: 'EVIDENCE_CONFLICT' };
    if (outcome.outcome === 'REFUSED') return { ok: false, code: 'EVIDENCE_REFUSED' };

    // read-after-write through the verifying reader: what is returned is what is durably stored and verified
    const stored = await this.reader.read(ctx, e.scope.businessId, e.source.boPublicationPackageId!);
    if (!stored.ok) return { ok: false, code: 'STORED_EVIDENCE_INTEGRITY' };
    return { ok: true, evidence: stored.evidence, replayed: outcome.outcome === 'REPLAYED' };
  }
}
