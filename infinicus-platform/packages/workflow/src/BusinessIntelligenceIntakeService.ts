/**
 * BI-1 (BI-03 data-ingestion coordination): Business Intelligence takes in a Business Operations publication package.
 *
 * BI consumes only what BO has published and BO stays the operational source of truth: this service never writes an operational table and never trusts the
 * handoff on its own. It (1) validates the BO -> BI handoff against the shared contract, (2) pins it to the caller's tenant and workspace, (3) derives the BI
 * domain from the BI block the package is addressed to, and (4) lets the repository verify every claim against BO's own records and persist the intake in
 * one transaction. A package that BO did not publish for this scope is refused without a trace; one whose claims differ from BO's record is persisted as a
 * rejected intake with the reasons. Replays are idempotent. Deterministic: no clock, no randomness.
 */
import { BoToBiIntakeRepository, type TenantContext } from '@infinicus/database';
import { validateBOToBIHandoff, type BOToBIHandoff } from '@infinicus/handoff-contracts';

/** The nine values of business_intelligence.intelligence_intake_packages.domain (its CHECK constraint; parity is asserted by an integration test). */
export const BI_INTAKE_DOMAINS = [
  'financial', 'sales_revenue', 'customer', 'marketing', 'operations_productivity', 'inventory_supply', 'workforce', 'market_competitive', 'cross_domain',
] as const;
export type BiIntakeDomain = (typeof BI_INTAKE_DOMAINS)[number];

/**
 * The domain engines are BI-11..BI-18, in the same order as the first eight domains. Every other BI block (BI-01..BI-10, BI-19..BI-25) serves all domains.
 * A target that is not a BI block is not something BI can ingest.
 */
const DOMAIN_BLOCKS: Readonly<Record<number, BiIntakeDomain>> = {
  11: 'financial', 12: 'sales_revenue', 13: 'customer', 14: 'marketing', 15: 'operations_productivity', 16: 'inventory_supply', 17: 'workforce', 18: 'market_competitive',
};

export function biDomainForTargetBlock(targetBlock: string): BiIntakeDomain | null {
  const match = /^BI-(\d{2})$/.exec(targetBlock);
  if (!match) return null;
  const n = Number(match[1]);
  if (n < 1 || n > 25) return null;
  return DOMAIN_BLOCKS[n] ?? 'cross_domain';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The handoff cannot be ingested; nothing was persisted. `reasons` are stable codes (never values). */
export class BiIntakeRejectedError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`BO to BI handoff refused: ${reasons.join(', ')}`);
    this.name = 'BiIntakeRejectedError';
  }
}

export type BusinessIntelligenceIntakeResult =
  | { outcome: 'VALIDATED'; intakePackageId: string; domain: BiIntakeDomain; versionNumber: number; idempotentReplay: boolean }
  | { outcome: 'REJECTED'; intakePackageId: string; domain: BiIntakeDomain; reasons: readonly string[]; idempotentReplay: boolean };

export class BusinessIntelligenceIntakeService {
  constructor(private readonly repository: BoToBiIntakeRepository = new BoToBiIntakeRepository()) {}

  async ingest(ctx: TenantContext, handoff: unknown): Promise<BusinessIntelligenceIntakeResult> {
    const contract = validateBOToBIHandoff(handoff);
    if (!contract.valid) throw new BiIntakeRejectedError(contract.reasons);
    const h = handoff as BOToBIHandoff;
    const p = h.payload;

    const reasons: string[] = [];
    // Scope comes from the authenticated context; a handoff can only ever confirm it.
    if (p.tenantId !== ctx.tenantId) reasons.push('tenant_differs_from_caller');
    if (p.workspaceId !== ctx.workspaceId) reasons.push('workspace_differs_from_caller');
    for (const [name, value] of [['business_id', p.businessId], ['bo_publication_package_id', p.boPublicationPackageId], ['handoff_id', h.handoffId], ['correlation_id', h.correlationId]] as const) {
      if (!UUID.test(value)) reasons.push(`${name}_not_a_uuid`);
    }
    if (h.targetBlock !== p.targetBlock) reasons.push('envelope_target_block_differs_from_payload');
    if (!p.idempotencyKey.startsWith(`bo-to-bi:${p.boPublicationPackageId}:`)) reasons.push('idempotency_key_not_bound_to_the_package');
    const domain = biDomainForTargetBlock(p.targetBlock);
    if (domain === null) reasons.push('target_block_is_not_a_bi_block');
    if (reasons.length > 0 || domain === null) throw new BiIntakeRejectedError(reasons);

    const outcome = await this.repository.ingest(ctx, {
      businessId: p.businessId,
      boPublicationPackageId: p.boPublicationPackageId,
      boHandoffRecordId: h.handoffId,
      intakeCode: `bo:${p.source.packageCode}`,
      domain,
      idempotencyKey: p.idempotencyKey,
      schemaVersion: p.schemaVersion,
      claimed: {
        packageCode: p.source.packageCode,
        targetBlock: p.targetBlock,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        recordCount: p.recordCount,
        payloadReference: p.source.payloadReference,
        packageStatus: p.packageStatus,
      },
      correlationId: h.correlationId,
      handoffId: h.handoffId,
      contractVersion: p.contractVersion,
    });
    if (outcome.outcome === 'UNKNOWN_PACKAGE') throw new BiIntakeRejectedError(outcome.reasons);
    if (outcome.outcome === 'REJECTED') {
      return { outcome: 'REJECTED', intakePackageId: outcome.intakePackageId, domain, reasons: outcome.reasons, idempotentReplay: outcome.idempotentReplay };
    }
    return { outcome: 'VALIDATED', intakePackageId: outcome.intakePackageId, domain, versionNumber: outcome.versionNumber, idempotentReplay: outcome.idempotentReplay };
  }
}
