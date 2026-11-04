/**
 * STRIPE-SBX-01: exact Stripe signature verification over the RAW request bytes. Returns a closed failure code and never the underlying error text (which can echo
 * header material). The secret is passed in by the route (from validated configuration) and is never logged.
 */
import Stripe from 'stripe';

export type StripeVerification = { ok: true; event: Stripe.Event } | { ok: false; code: 'MISSING_SIGNATURE' | 'INVALID_SIGNATURE' | 'INVALID_PAYLOAD' };

/** Signatures older than this are refused (replay of an old captured delivery). Stripe's own default. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(rawBody: Buffer, signatureHeader: unknown, webhookSecret: string): StripeVerification {
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0 || signatureHeader.length > 2048) return { ok: false, code: 'MISSING_SIGNATURE' };
  try {
    return { ok: true, event: Stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret, STRIPE_SIGNATURE_TOLERANCE_SECONDS) };
  } catch (error) {
    // stripe-node verifies the signature first and parses the JSON second: a SyntaxError means "validly signed but not JSON".
    return { ok: false, code: error instanceof SyntaxError ? 'INVALID_PAYLOAD' : 'INVALID_SIGNATURE' };
  }
}
