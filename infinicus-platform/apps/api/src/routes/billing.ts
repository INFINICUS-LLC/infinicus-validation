import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { EntitlementService } from '@infinicus/billing';
import type { Subscription, Plan } from '@infinicus/database';
import { subscriptionResponseSchema, startTrialBodySchema, recordPaymentBodySchema } from '../schemas/billing.js';
import { errorResponseSchema } from '../schemas/common.js';

const entitlements = new EntitlementService();
const USAGE_METRICS = ['simulation_runs', 'reasoning_runs'] as const;

function serializeSubscription(subscription: Subscription, plan: Plan, usage: Record<string, number>) {
  return {
    id: subscription.id,
    status: subscription.status,
    trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    gracePeriodEndsAt: subscription.gracePeriodEndsAt?.toISOString() ?? null,
    paymentStatus: subscription.paymentStatus,
    plan: {
      code: plan.code, name: plan.name, priceCents: plan.priceCents, currency: plan.currency,
      billingInterval: plan.billingInterval, limits: plan.limits, features: plan.features,
    },
    usage,
  };
}

export default async function billingRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get('/v1/billing/subscription', {
    schema: {
      tags: ['billing'],
      summary: 'Current tenant\'s subscription, plan, and this billing period\'s usage',
      response: { 200: subscriptionResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('platform:admin')],
  }, async (request, reply) => {
    const { subscription, plan } = await entitlements.getSubscriptionWithPlan(request.ctx!);
    const usageEntries = await Promise.all(
      USAGE_METRICS.map(async (metric) => [metric, await entitlements.getCurrentUsage(request.ctx!, metric)] as const)
    );
    return reply.status(200).send(serializeSubscription(subscription, plan, Object.fromEntries(usageEntries)));
  });

  server.post('/v1/billing/trial', {
    schema: {
      tags: ['billing'],
      summary: 'Start the tenant\'s subscription (trialing if the plan has a trial period, active otherwise)',
      body: startTrialBodySchema,
      response: { 201: subscriptionResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 409: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('platform:admin')],
  }, async (request, reply) => {
    const { subscription, plan } = await entitlements.startSubscription(request.ctx!, request.body.planCode);
    return reply.status(201).send(serializeSubscription(subscription, plan, {}));
  });

  server.post('/v1/billing/payment-result', {
    schema: {
      tags: ['billing'],
      summary: 'Record an external payment result for the tenant\'s subscription and apply its lifecycle consequence',
      body: recordPaymentBodySchema,
      response: { 200: subscriptionResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
    preHandler: [app.authenticate, app.resolveTenantContext, app.requirePermission('platform:admin')],
  }, async (request, reply) => {
    const subscription = await entitlements.recordPaymentResult(
      request.ctx!, request.body.status, request.body.externalInvoiceReference ?? null
    );
    const { plan } = await entitlements.getSubscriptionWithPlan(request.ctx!);
    return reply.status(200).send(serializeSubscription(subscription, plan, {}));
  });
}
