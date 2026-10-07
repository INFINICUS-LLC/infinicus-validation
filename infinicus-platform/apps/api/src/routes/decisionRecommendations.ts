import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BusinessDecisionRecommendationService } from '@infinicus/workflow';
import { BusinessRepository } from '@infinicus/database';
import {
  businessIdParamsSchema, recommendationIdParamsSchema,
  recommendResponseSchema, choiceBodySchema, choiceResponseSchema,
  outcomeBodySchema, outcomeResponseSchema, historyResponseSchema,
} from '../schemas/decisionRecommendations.js';
import { errorResponseSchema } from '../schemas/common.js';

const businessDecisions = new BusinessDecisionRecommendationService();
const businesses = new BusinessRepository();

export default async function decisionRecommendationsRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/businesses/:businessId/decision-recommendations', {
    schema: {
      tags: ['decisions'],
      summary: 'Generate AI decision recommendations grounded in the business\'s Digital Twin',
      params: businessIdParamsSchema,
      response: { 201: recommendResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('adi:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const { decisions, evidence } = await businessDecisions.recommend(request.ctx!, businessId);
    return reply.status(201).send({ decisions, evidence });
  });

  server.post('/v1/businesses/:businessId/decision-recommendations/:recommendationId/choice', {
    schema: {
      tags: ['decisions'],
      summary: 'Record whether the business owner chose to act on a recommendation (runs it through real ABA approval)',
      params: recommendationIdParamsSchema,
      body: choiceBodySchema,
      response: { 201: choiceResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('aba:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, recommendationId } = request.params;
    const result = await businessDecisions.startChoiceReview(request.ctx!, businessId, recommendationId, request.body.chosen);
    return reply.status(201).send(result);
  });

  server.post('/v1/businesses/:businessId/decision-recommendations/outcome', {
    schema: {
      tags: ['decisions'],
      summary: 'Record the real-world outcome of a chosen decision (runs it through real OM outcome monitoring)',
      params: businessIdParamsSchema,
      body: outcomeBodySchema,
      response: { 201: outcomeResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('om:write'), app.requireActiveSubscription(), app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    const result = await businessDecisions.recordChoiceOutcome(request.ctx!, businessId, request.body.approvedActionId, request.body.outcomeNotes);
    return reply.status(201).send(result);
  });

  server.get('/v1/businesses/:businessId/decision-recommendations/history', {
    schema: {
      tags: ['decisions'],
      summary: 'List past decision recommendations for a business',
      params: businessIdParamsSchema,
      response: { 200: historyResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('adi:read')],
  }, async (request, reply) => {
    const { businessId } = request.params;
    await businesses.getById(request.ctx!, businessId);
    const decisions = await businessDecisions.getHistory(request.ctx!, businessId);
    return reply.status(200).send({ decisions });
  });
}
