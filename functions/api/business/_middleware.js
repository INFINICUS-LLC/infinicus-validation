// functions/api/business/_middleware.js — default-deny for the legacy business route family (PR-C)
//
// Applies to EVERY route under /api/business/** (including routes added later). Unless LEGACY_BUSINESS_API is exactly
// "enabled", the request is answered 404 before any route code runs. The route files and their contracts are untouched
// and remain available for a future, separately authorised compatibility review.
//
// Why: these routes identify callers by a client-supplied user_email / business_id with no authentication (any caller can read
// or write any business), they use wildcard CORS, and they are not called by the shipped frontend. Their identity model
// (email equality in a legacy KV store) is not the Stack B identity/tenancy authority and must not become one.
// Do NOT set LEGACY_BUSINESS_API until that review has happened.
//
// The handler is exported through an export list so that tooling which scans for route handlers does not mistake this
// middleware for a route.
import { legacyRouteGate } from '../../_shared/route.js';

async function onRequest(context) {
  return legacyRouteGate(context, { flag: 'LEGACY_BUSINESS_API', route: '/api/business' }) ?? context.next();
}

export { onRequest };
