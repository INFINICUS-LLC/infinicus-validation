import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AbaAuthoringService } from '@infinicus/workflow';
import type { AbaAuthoringDependencies, AuthoringRequestContext } from '@infinicus/workflow';
import {
  actionTypeParamsSchema, policyParamsSchema, policyVersionParamsSchema, authorizedActionParamsSchema,
  defineActionTypeBodySchema, retireActionTypeBodySchema, actionTypeViewSchema, actionTypeListResponseSchema,
  createPolicyBodySchema, addPolicyVersionBodySchema, policyEnablementBodySchema, policyViewSchema, enablementViewSchema,
  captureBodySchema, captureViewSchema, ownerBodySchema, ownerViewSchema, boundariesBodySchema, boundariesViewSchema,
  issueBodySchema, issuedPackageViewSchema, authoringStatusViewSchema,
} from '../schemas/abaAuthoring.js';
import { errorResponseSchema } from '../schemas/common.js';

/**
 * ABA authoring and administration (P0-5). Governance-changing administration (action types, Level 2 policy) needs `aba:admin`;
 * business-scoped authoring (capture, owner, boundaries, issuance) needs `aba:write` (capture and boundaries additionally require the
 * decision's own still-active approver, checked by the service); reads need `aba:read`. Authority is the authenticated server-side
 * context only: tenant, workspace and user come from `request.ctx`; businessId / actionId are lookup keys the service verifies.
 *
 * This surface executes nothing. It does not import any Business Operations code, call BO, emit events, seal a package itself (the
 * single issuer does, inside AbaAuthoringService.issuePackage) or accept a package payload, final parameters, risk, authority or status.
 */
const rcOf = (permissionUsed: string, correlationId: string): AuthoringRequestContext => ({ permissionUsed, correlationId });
const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema };
const ADMIN = (app: FastifyInstance) => [app.authenticate, app.resolveTenantContext, app.requirePermission('aba:admin'), app.requireActiveSubscription(), app.requireIdempotencyKey];
const WRITE = (app: FastifyInstance) => [app.authenticate, app.resolveTenantContext, app.requirePermission('aba:write'), app.requireActiveSubscription(), app.requireIdempotencyKey];
const READ = (app: FastifyInstance) => [app.authenticate, app.resolveTenantContext, app.requirePermission('aba:read')];

export interface AbaAuthoringRouteOptions {
  /** Composition-root overrides (an authoritative evidence verifier, once one exists, is registered here). Production default: none. */
  dependencies?: Partial<AbaAuthoringDependencies>;
}

export default async function abaAuthoringRoutes(app: FastifyInstance, options: AbaAuthoringRouteOptions = {}) {
  const service = new AbaAuthoringService(options.dependencies);
  const server = app.withTypeProvider<ZodTypeProvider>();
  const A = 'aba:admin';
  const W = 'aba:write';

  // ── A. action-type governance ──────────────────────────────────────────────────────────────────────────────────────
  server.post('/v1/aba/action-types', {
    schema: { tags: ['aba-authoring'], summary: 'Register the CANONICAL definition of an action type in this workspace (requires aba:admin; idempotent; the caller supplies no definition)', body: defineActionTypeBodySchema, response: { 201: actionTypeViewSchema, ...errors } },
    preHandler: ADMIN(app),
  }, async (request, reply) => reply.status(201).send(await service.defineActionType(request.ctx!, rcOf(A, request.correlationId), request.body)));

  server.post('/v1/aba/action-types/:code/:schemaVersion/activate', {
    schema: { tags: ['aba-authoring'], summary: 'Activate a registered action type (requires aba:admin; idempotent)', params: actionTypeParamsSchema, response: { 200: actionTypeViewSchema, ...errors } },
    preHandler: ADMIN(app),
  }, async (request, reply) => reply.status(200).send(await service.activateActionType(request.ctx!, rcOf(A, request.correlationId), request.params.code, request.params.schemaVersion)));

  server.post('/v1/aba/action-types/:code/:schemaVersion/retire', {
    schema: { tags: ['aba-authoring'], summary: 'Retire an ACTIVE action type with a reason (requires aba:admin; idempotent)', params: actionTypeParamsSchema, body: retireActionTypeBodySchema, response: { 200: actionTypeViewSchema, ...errors } },
    preHandler: ADMIN(app),
  }, async (request, reply) => reply.status(200).send(await service.retireActionType(request.ctx!, rcOf(A, request.correlationId), request.params.code, request.params.schemaVersion, request.body.reason)));

  server.get('/v1/aba/action-types', {
    schema: { tags: ['aba-authoring'], summary: 'List the workspace\'s registered action types and their status (requires aba:read)', response: { 200: actionTypeListResponseSchema, ...errors } },
    preHandler: READ(app),
  }, async (request, reply) => reply.status(200).send({ items: await service.listActionTypes(request.ctx!) }));

  server.get('/v1/aba/action-types/:code/:schemaVersion', {
    schema: { tags: ['aba-authoring'], summary: 'Read one registered action type (requires aba:read)', params: actionTypeParamsSchema, response: { 200: actionTypeViewSchema, ...errors } },
    preHandler: READ(app),
  }, async (request, reply) => reply.status(200).send(await service.getActionType(request.ctx!, request.params.code, request.params.schemaVersion)));

  // ── B. Level 2 policy ──────────────────────────────────────────────────────────────────────────────────────────────
  server.post('/v1/aba/automation-policies', {
    schema: { tags: ['aba-authoring'], summary: 'Create a Level 2 automation policy (requires aba:admin; Level 3 and 4 are refused; idempotent)', body: createPolicyBodySchema, response: { 201: policyViewSchema, ...errors } },
    preHandler: ADMIN(app),
  }, async (request, reply) => reply.status(201).send(await service.createPolicy(request.ctx!, rcOf(A, request.correlationId), request.body)));

  server.post('/v1/aba/automation-policies/:policyCode/versions', {
    schema: { tags: ['aba-authoring'], summary: 'Add the next version of a policy (requires aba:admin; idempotent for an identical latest version)', params: policyParamsSchema, body: addPolicyVersionBodySchema, response: { 201: policyViewSchema, ...errors } },
    preHandler: ADMIN(app),
  }, async (request, reply) => reply.status(201).send(await service.addPolicyVersion(request.ctx!, rcOf(A, request.correlationId), request.params.policyCode, request.body)));

  server.post('/v1/aba/automation-policies/:policyCode/versions/:versionNumber/enable', {
    schema: { tags: ['aba-authoring'], summary: 'Enable a Level 2 policy version (requires aba:admin; only Level 2 can be enabled; idempotent)', params: policyVersionParamsSchema, body: policyEnablementBodySchema, response: { 200: policyViewSchema, ...errors } },
    preHandler: ADMIN(app),
  }, async (request, reply) => reply.status(200).send(await service.enablePolicyVersion(request.ctx!, rcOf(A, request.correlationId), request.params.policyCode, request.params.versionNumber, request.body.reason)));

  server.post('/v1/aba/automation-policies/:policyCode/versions/:versionNumber/disable', {
    schema: { tags: ['aba-authoring'], summary: 'Disable an enabled policy version (requires aba:admin; idempotent)', params: policyVersionParamsSchema, body: policyEnablementBodySchema, response: { 200: policyViewSchema, ...errors } },
    preHandler: ADMIN(app),
  }, async (request, reply) => reply.status(200).send(await service.disablePolicyVersion(request.ctx!, rcOf(A, request.correlationId), request.params.policyCode, request.params.versionNumber, request.body.reason)));

  server.get('/v1/aba/automation-policies/:policyCode', {
    schema: { tags: ['aba-authoring'], summary: 'Read a policy and its versions (requires aba:read)', params: policyParamsSchema, response: { 200: policyViewSchema, ...errors } },
    preHandler: READ(app),
  }, async (request, reply) => reply.status(200).send(await service.getPolicy(request.ctx!, request.params.policyCode)));

  server.get('/v1/aba/automation-enablement', {
    schema: { tags: ['aba-authoring'], summary: 'Read the effective (enabled) automation policy per level (requires aba:read)', response: { 200: enablementViewSchema, ...errors } },
    preHandler: READ(app),
  }, async (request, reply) => reply.status(200).send(await service.getEnablement(request.ctx!)));

  // ── C-F. business-scoped authoring ─────────────────────────────────────────────────────────────────────────────────
  const base = '/v1/businesses/:businessId/authorized-actions/:actionId';

  server.post(`${base}/capture`, {
    schema: { tags: ['aba-authoring'], summary: 'Record the structured capture after approval (requires aba:write and the decision\'s own active approver; the database re-derives the final parameters; idempotent)', params: authorizedActionParamsSchema, body: captureBodySchema, response: { 201: captureViewSchema, ...errors } },
    preHandler: WRITE(app),
  }, async (request, reply) => reply.status(201).send(await service.recordCapture(request.ctx!, rcOf(W, request.correlationId), request.params.businessId, request.params.actionId, request.body)));

  server.post(`${base}/owner`, {
    schema: { tags: ['aba-authoring'], summary: 'Assign or re-assign the accountable owner (requires aba:write; the owner must hold an ACTIVE membership in this workspace; idempotent)', params: authorizedActionParamsSchema, body: ownerBodySchema, response: { 201: ownerViewSchema, ...errors } },
    preHandler: WRITE(app),
  }, async (request, reply) => reply.status(201).send(await service.assignOwner(request.ctx!, rcOf(W, request.correlationId), request.params.businessId, request.params.actionId, request.body as never)));

  server.post(`${base}/boundaries`, {
    schema: { tags: ['aba-authoring'], summary: 'Author the next version of the execution boundaries and simulation reference (requires aba:write and the decision\'s own active approver; fail-closed applicability; idempotent)', params: authorizedActionParamsSchema, body: boundariesBodySchema, response: { 201: boundariesViewSchema, ...errors } },
    preHandler: WRITE(app),
  }, async (request, reply) => reply.status(201).send(await service.authorBoundaries(request.ctx!, rcOf(W, request.correlationId), request.params.businessId, request.params.actionId, request.body as never)));

  server.post(`${base}/package`, {
    schema: { tags: ['aba-authoring'], summary: 'Ask the ABA issuer to issue the AuthorizedActionPackage (requires aba:write; identifiers only - no body; replay returns the existing package)', params: authorizedActionParamsSchema, body: issueBodySchema, response: { 201: issuedPackageViewSchema, ...errors } },
    preHandler: WRITE(app),
  }, async (request, reply) => reply.status(201).send(await service.issuePackage(request.ctx!, rcOf(W, request.correlationId), request.params.businessId, request.params.actionId)));

  server.get(`${base}/authoring-status`, {
    schema: { tags: ['aba-authoring'], summary: 'Read which authoring steps exist and the latest package status, without the package document (requires aba:read)', params: authorizedActionParamsSchema, response: { 200: authoringStatusViewSchema, ...errors } },
    preHandler: READ(app),
  }, async (request, reply) => reply.status(200).send(await service.getAuthoringStatus(request.ctx!, request.params.businessId, request.params.actionId)));
}
