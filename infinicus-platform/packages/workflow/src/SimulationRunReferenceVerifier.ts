import { SimulationRunRepository, type TenantContext } from '@infinicus/database';

/**
 * Verifies that a simulation-run REFERENCE is real: it exists in the caller's tenant and workspace (RLS-confined), belongs to the
 * business, and is in the owner's `completed` state. The Simulation layer's own public repository is the only thing read; ABA
 * never touches Simulation tables directly and keeps no copy of simulation truth.
 *
 * This proves the reference exists and finished. It does NOT prove the run evaluated this action's parameters: the only engine today
 * is a new-venture cash-flow Monte Carlo, and no persisted ADI-to-Simulation lineage exists (Block B survey). Callers must not
 * describe a verified reference as an authoritative evaluation.
 */
export type SimulationRunReferenceVerdict = { ok: true; status: 'completed' } | { ok: false; reason: string };

export interface SimulationRunReferenceVerifier {
  verify(ctx: TenantContext, scope: { businessId: string; runId: string }): Promise<SimulationRunReferenceVerdict>;
}

export class SimulationRunRepositoryReferenceVerifier implements SimulationRunReferenceVerifier {
  constructor(private readonly runs: SimulationRunRepository = new SimulationRunRepository()) {}

  async verify(ctx: TenantContext, scope: { businessId: string; runId: string }): Promise<SimulationRunReferenceVerdict> {
    let run;
    try {
      run = await this.runs.getRun(ctx, scope.runId);
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') return { ok: false, reason: 'the simulation run does not exist in this workspace' };
      throw error;
    }
    if (run.tenantId !== ctx.tenantId || run.workspaceId !== ctx.workspaceId || run.businessId !== scope.businessId) {
      return { ok: false, reason: 'the simulation run does not belong to this business' };
    }
    if (run.status !== 'completed') return { ok: false, reason: `the simulation run is "${run.status}", not completed` };
    return { ok: true, status: 'completed' };
  }
}
