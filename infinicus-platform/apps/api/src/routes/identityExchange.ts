import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AuthenticationService, managedAccountEmailFor } from '@infinicus/authentication';
import { identityExchangeBodySchema, loginResponseSchema } from '../schemas/auth.js';
import { errorResponseSchema } from '../schemas/common.js';
import type { IdentityVerifier } from '../identityVerifier.js';

export interface IdentityExchangeRouteOptions {
  verifier: IdentityVerifier;
}

const authService = new AuthenticationService();

/**
 * J-3: exchanges an identity-provider access token for a backend session.
 * Chain: provider verifies the token -> its answer (immutable user id) selects the managed account -> a session is issued.
 * Nothing the browser sends other than the token influences which account is used.
 */
export default async function identityExchangeRoutes(app: FastifyInstance, options: IdentityExchangeRouteOptions) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post('/v1/auth/identity-exchange', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['auth'],
      summary: 'Exchange a verified identity-provider access token for a backend session (managed account; no password). 503 when the exchange is not configured or the provider is unreachable.',
      body: identityExchangeBodySchema,
      response: { 200: loginResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 429: errorResponseSchema, 503: errorResponseSchema },
    },
  }, async (request, reply) => {
    const identity = await options.verifier.verify(request.body.accessToken);
    const { user, session, rawSessionToken } = await authService.startManagedSession(
      managedAccountEmailFor(identity.providerUserId),
      { ipAddress: request.ip, userAgent: request.headers['user-agent'] }
    );
    return reply.status(200).send({
      user: { id: user.id, email: user.email, status: user.status },
      sessionId: session.id,
      rawSessionToken,
    });
  });
}
