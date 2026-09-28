import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AuthenticationService } from '@infinicus/authentication';
import {
  registerBodySchema, registerResponseSchema,
  loginBodySchema, loginResponseSchema,
  sessionResponseSchema,
  verifyEmailBodySchema, verifyEmailResponseSchema,
} from '../schemas/auth.js';
import { errorResponseSchema } from '../schemas/common.js';

const authService = new AuthenticationService();

export default async function authRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/auth/register', {
    schema: {
      tags: ['auth'],
      summary: 'Register a new user account. Activated immediately (usable right away); a real verification email is also sent — see POST /v1/auth/verify-email.',
      body: registerBodySchema,
      response: { 201: registerResponseSchema, 400: errorResponseSchema, 409: errorResponseSchema },
    },
  }, async (request, reply) => {
    const user = await authService.register(request.body.email, request.body.password);
    return reply.status(201).send({ id: user.id, email: user.email, status: user.status });
  });

  server.post('/v1/auth/verify-email', {
    schema: {
      tags: ['auth'],
      summary: 'Confirm ownership of the registered email address via the token sent at registration. Does not affect account status (already active) — tracked independently.',
      body: verifyEmailBodySchema,
      response: { 200: verifyEmailResponseSchema, 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const user = await authService.verifyEmail(request.body.token);
    return reply.status(200).send({ id: user.id, email: user.email, emailVerifiedAt: user.emailVerifiedAt!.toISOString() });
  });

  server.post('/v1/auth/login', {
    schema: {
      tags: ['auth'],
      summary: 'Log in with email and password; returns a bearer session token. 429 after too many recent failed attempts (account lockout), independent of whether this attempt\'s password is correct.',
      body: loginBodySchema,
      response: { 200: loginResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 429: errorResponseSchema },
    },
  }, async (request, reply) => {
    const { user, session, rawSessionToken } = await authService.login(
      request.body.email, request.body.password,
      { ipAddress: request.ip, userAgent: request.headers['user-agent'] }
    );
    return reply.status(200).send({
      user: { id: user.id, email: user.email, status: user.status },
      sessionId: session.id,
      rawSessionToken,
    });
  });

  server.post('/v1/auth/logout', {
    schema: {
      tags: ['auth'],
      summary: 'Log out the current session',
      response: { 204: z.null().describe('Logged out') },
    },
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const header = request.headers.authorization;
    const token = header!.slice('Bearer '.length).trim();
    await authService.logout(token, { ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    return reply.status(204).send(null);
  });

  server.get('/v1/auth/session', {
    schema: {
      tags: ['auth'],
      summary: 'Validate the current bearer session token',
      response: { 200: sessionResponseSchema, 401: errorResponseSchema },
    },
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { user, session } = request.session!;
    return reply.status(200).send({ user: { id: user.id, email: user.email, status: user.status }, sessionId: session.id });
  });
}
