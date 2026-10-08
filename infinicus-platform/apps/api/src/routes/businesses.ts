import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { DecisionWorkflowService, SimulationOrchestrationService } from '@infinicus/workflow';
import {
  businessListResponseSchema, businessIdParamsSchema, workflowViewResponseSchema,
  createBusinessBodySchema, createBusinessResponseSchema,
  createDecisionBodySchema, decisionResponseSchema,
  grantApproverAuthorityBodySchema, grantApproverAuthorityResponseSchema,
  approverAssignmentParamsSchema, revokeApproverAuthorityBodySchema, revokeApproverAuthorityResponseSchema,
  approverAuthorityRecordResponseSchema,
  recordOutcomeBodySchema, outcomeResponseSchema,
  startSimulationBodySchema, startSimulationResponseSchema,
  simulationRunParamsSchema, simulationRunStatusResponseSchema,
} from '../schemas/businesses.js';
import { paginationQuerySchema, errorResponseSchema } from '../schemas/common.js';

const workflow = new DecisionWorkflowService();
const simulations = new SimulationOrchestrationService();

/**
 * The workflow view aggregates BO, BI, Digital Twin, Simulation, ADI, ABA and OM state, so it requires EVERY layer's
 * read permission (P0-4 Block 3, owner ruling F2). Never reduce this to a single permission.
 */
export const WORKFLOW_VIEW_PERMISSIONS = ['bo:read', 'bi:read', 'dt:read', 'sim:read', 'adi:read', 'aba:read', 'om:read'] as const;

export default async function businessRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get('/v1/businesses', {
    schema: {
      tags: ['businesses'],
      summary: 'List businesses in the caller\'s workspace (paginated)',
      querystring: paginationQuerySchema,
      response: { 200: businessListResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read')],
  }, async (request, reply) => {
    const { page, pageSize } = request.query;
    const { items, total } = await workflow.listBusinesses(request.ctx!, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return reply.status(200).send({
      items: items.map((b) => ({ id: b.id, legalName: b.legalName, businessCode: b.businessCode, status: b.status, industry: b.industry })),
      page, pageSize, total,
    });
  });

  server.post('/v1/businesses', {
    schema: {
      tags: ['businesses'],
      summary: 'Create a business in the caller\'s workspace',
      body: createBusinessBodySchema,
      response: { 201: createBusinessResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const business = await workflow.createBusiness(request.ctx!, request.body);
    return reply.status(201).send({
      id: business.id, legalName: business.legalName, businessCode: business.businessCode,
      status: business.status, industry: business.industry,
    });
  });

  server.get('/v1/businesses/:businessId/workflow', {
    schema: {
      tags: ['businesses'],
      summary: 'Aggregate decision-workflow view for a business (BI evidence, DT state, simulation, ADI recommendation, ABA review, outcomes)',
      params: businessIdParamsSchema,
      response: { 200: workflowViewResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requireAllPermissions(WORKFLOW_VIEW_PERMISSIONS)],
  }, async (request, reply) => {
    const view = await workflow.getWorkflowView(request.ctx!, request.params.businessId);
    return reply.status(200).send({
      business: {
        id: view.business.id, legalName: view.business.legalName, businessCode: view.business.businessCode,
        status: view.business.status, industry: view.business.industry,
      },
      biEvidenceCount: view.biEvidence.length,
      dtInstanceCount: view.dtInstances.length,
      hasDtSnapshot: view.dtLatestSnapshot !== null,
      simulationRunCount: view.simulationRuns.length,
      hasSimulationResult: view.simulationLatestResult !== null,
      adiCaseCount: view.adiCases.length,
      hasAdiRecommendation: view.adiLatestRecommendation !== null,
      abaReviewCount: view.abaReviews.length,
      hasAbaDecision: view.abaLatestDecision !== null,
      outcomeCount: view.outcomes.length,
    });
  });

  server.post('/v1/businesses/:businessId/simulations', {
    schema: {
      tags: ['businesses'],
      summary: 'Start a real Data Acquisition -> Simulation -> AI Decision Intelligence run for a business idea (async: poll GET .../simulations/:runId)',
      params: businessIdParamsSchema,
      body: startSimulationBodySchema,
      response: { 202: startSimulationResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('sim:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    const { runId } = await simulations.startRun(request.ctx!, businessId, request.body);
    return reply.status(202).send({ runId, status: 'queued' });
  });

  server.get('/v1/businesses/:businessId/simulations/:runId', {
    schema: {
      tags: ['businesses'],
      summary: 'Poll a simulation run\'s status and, once completed, its published result',
      params: simulationRunParamsSchema,
      response: { 200: simulationRunStatusResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('sim:read')],
  }, async (request, reply) => {
    const { runId } = request.params;
    const status = await simulations.getRunStatus(request.ctx!, runId);
    return reply.status(200).send(status);
  });

  server.post('/v1/businesses/:businessId/approver-assignments', {
    schema: {
      tags: ['businesses'],
      summary: 'Establish approval authority for a user (requires aba:admin; separate from deciding; idempotent)',
      params: businessIdParamsSchema,
      body: grantApproverAuthorityBodySchema,
      response: { 201: grantApproverAuthorityResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('aba:admin'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    const assignment = await workflow.grantApproverAuthority(request.ctx!, businessId, {
      approverUserId: request.body.approverUserId,
      assignmentCode: request.body.assignmentCode,
      roleCode: request.body.roleCode,
      correlationId: request.correlationId,
    });
    return reply.status(201).send({ id: assignment.id, status: assignment.status, assignmentCode: assignment.assignmentCode });
  });

  server.get('/v1/businesses/:businessId/approver-assignments/:assignmentCode', {
    schema: {
      tags: ['businesses'],
      summary: 'Read an approver assignment and its append-only provenance history (requires aba:admin)',
      params: approverAssignmentParamsSchema,
      response: { 200: approverAuthorityRecordResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('aba:admin')],
  }, async (request, reply) => {
    const { businessId, assignmentCode } = request.params;
    const { assignment, provenance } = await workflow.getApproverAuthority(request.ctx!, businessId, assignmentCode);
    return reply.status(200).send({
      id: assignment.id, userId: assignment.userId, status: assignment.status, assignmentCode: assignment.assignmentCode, provenance,
    });
  });

  server.post('/v1/businesses/:businessId/approver-assignments/:assignmentCode/revoke', {
    schema: {
      tags: ['businesses'],
      summary: 'Revoke an approver assignment so the holder no longer has approval authority (requires aba:admin; idempotent)',
      params: approverAssignmentParamsSchema,
      body: revokeApproverAuthorityBodySchema,
      response: { 200: revokeApproverAuthorityResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('aba:admin'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, assignmentCode } = request.params;
    const { assignment, changed } = await workflow.revokeApproverAuthority(request.ctx!, businessId, {
      assignmentCode, reason: request.body.reason, correlationId: request.correlationId,
    });
    return reply.status(200).send({ id: assignment.id, status: assignment.status, assignmentCode: assignment.assignmentCode, changed });
  });

  server.post('/v1/businesses/:businessId/decisions', {
    schema: {
      tags: ['businesses'],
      summary: 'Start an ABA review and record a human approver\'s decision (idempotent)',
      params: businessIdParamsSchema,
      body: createDecisionBodySchema,
      response: { 201: decisionResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('aba:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    const review = await workflow.createReview(request.ctx!, businessId, {
      intakePackageId: request.body.intakePackageId,
      reviewCode: request.body.reviewCode,
      summary: request.body.summary,
    });
    const decision = await workflow.submitApprovalDecision(request.ctx!, businessId, {
      reviewPackageId: review.id,
      approverUserId: request.body.approverUserId,
      assignmentCode: request.body.assignmentCode,
      decisionCode: request.body.decisionCode,
      summary: request.body.summary,
      outcome: request.body.outcome,
      requestContext: { permissionUsed: 'aba:write', correlationId: request.correlationId },
    });
    return reply.status(201).send({ id: decision.id, status: decision.status, decisionCode: decision.decisionCode });
  });

  server.post('/v1/businesses/:businessId/outcomes', {
    schema: {
      tags: ['businesses'],
      summary: 'Record and finalize an outcome observation (idempotent, immutable once recorded)',
      params: businessIdParamsSchema,
      body: recordOutcomeBodySchema,
      response: { 201: outcomeResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('om:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    const { observation } = await workflow.recordOutcome(request.ctx!, businessId, {
      monitoredActionId: request.body.monitoredActionId,
      observationCode: request.body.observationCode,
      summary: request.body.summary,
      effectiveAt: new Date(request.body.effectiveAt),
      measurements: request.body.measurements,
      evidence: request.body.evidence,
    });
    return reply.status(201).send({ id: observation.id, status: observation.status, observationCode: observation.observationCode });
  });
}
