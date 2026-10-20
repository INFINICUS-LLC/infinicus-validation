import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { RegisterSessionRepository } from '@infinicus/database';
import {
  businessIdParamsSchema, sessionIdParamsSchema,
  openRegisterSessionBodySchema, closeRegisterSessionBodySchema,
  registerSessionResponseSchema, listRegisterSessionsQuerySchema,
  listRegisterSessionsResponseSchema, openRegisterSessionResponseSchema, registerSessionSummaryResponseSchema,
} from '../schemas/registerSessions.js';
import { errorResponseSchema } from '../schemas/common.js';
import { requireBusinessWorkspace } from '../guards/businessWorkspace.js';

const registerSessions = new RegisterSessionRepository();

export default async function registerSessionsRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/businesses/:businessId/register-sessions', {
    schema: {
      tags: ['operations'],
      summary: 'Open a new register session for a business',
      params: businessIdParamsSchema,
      body: openRegisterSessionBodySchema,
      response: {
        201: registerSessionResponseSchema,
        401: errorResponseSchema, 403: errorResponseSchema,
        404: errorResponseSchema, 409: errorResponseSchema,
      },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), requireBusinessWorkspace, app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId } = request.params;
    const session = await registerSessions.open(request.ctx!, { businessId, ...request.body });
    return reply.status(201).send(session);
  });

  server.get('/v1/businesses/:businessId/register-sessions/open', {
    schema: {
      tags: ['operations'],
      summary: 'Get the currently open register session for a business, if any',
      params: businessIdParamsSchema,
      response: { 200: openRegisterSessionResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read'), requireBusinessWorkspace],
  }, async (request, reply) => {
    const { businessId } = request.params;
    const session = await registerSessions.getOpen(request.ctx!, businessId);
    return reply.status(200).send({ session });
  });

  server.post('/v1/businesses/:businessId/register-sessions/:sessionId/close', {
    schema: {
      tags: ['operations'],
      summary: 'Close an open register session and reconcile cash',
      params: sessionIdParamsSchema,
      body: closeRegisterSessionBodySchema,
      response: {
        200: registerSessionResponseSchema,
        401: errorResponseSchema, 403: errorResponseSchema,
        404: errorResponseSchema, 409: errorResponseSchema,
      },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:write'), app.requireActiveSubscription(), requireBusinessWorkspace, app.requireIdempotencyKey],
  }, async (request, reply) => {
    const { businessId, sessionId } = request.params;
    const session = await registerSessions.close(request.ctx!, sessionId, request.body, businessId);
    return reply.status(200).send(session);
  });

  server.get('/v1/businesses/:businessId/register-sessions', {
    schema: {
      tags: ['operations'],
      summary: 'List recent register sessions for a business',
      params: businessIdParamsSchema,
      querystring: listRegisterSessionsQuerySchema,
      response: { 200: listRegisterSessionsResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read'), requireBusinessWorkspace],
  }, async (request, reply) => {
    const { businessId } = request.params;
    const list = await registerSessions.list(request.ctx!, businessId, request.query.limit);
    return reply.status(200).send({ sessions: list });
  });

  server.get('/v1/businesses/:businessId/register-sessions/:sessionId/summary', {
    schema: {
      tags: ['operations'],
      summary: 'Orders taken in a register session: counts by status and the completed sales total (all tender types together)',
      params: sessionIdParamsSchema,
      response: { 200: registerSessionSummaryResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('bo:read'), requireBusinessWorkspace],
  }, async (request, reply) => {
    const { businessId, sessionId } = request.params;
    const summary = await registerSessions.summary(request.ctx!, businessId, sessionId);
    return reply.status(200).send(summary);
  });
}

