// functions/api/auth/_middleware.js — default-deny for the legacy authentication route family (PR-C)
//
// Applies to EVERY route under /api/auth/** (login, register, change-password and the deprecated request/verify routes).
// Unless LEGACY_AUTH_API is exactly "enabled", the request is answered 404 before any route code runs. Route code and
// contracts are untouched for a future, separately authorised review.
//
// Why: these routes keep a second user store (KV "user:<email>") with no throttling and wildcard CORS. The shipped frontend
// authenticates against Stack B / Supabase, which is the identity authority; this family must not compete with it.
// KNOWN FRONTEND IMPACT: account.html and landing.html call POST /api/auth/change-password; that call now fails with 404
// (see docs/deployment/LEGACY_ROUTE_HARDENING.md). Do NOT set LEGACY_AUTH_API until the identity-authority review is done.
import { legacyRouteGate } from '../../_shared/route.js';

async function onRequest(context) {
  return legacyRouteGate(context, { flag: 'LEGACY_AUTH_API', route: '/api/auth' }) ?? context.next();
}

export { onRequest };
