/**
 * Inbound webhook delivery, as handed to DataAcquisitionService.receiveWebhook()
 * by the (unauthenticated-by-design — see the route file) API route. The
 * route's only job is to parse the request into this shape; every actual
 * authentication and business-rule decision happens in the service.
 */
export interface WebhookDeliveryRequest {
  /** Non-secret half of the connector's bearer token, from the URL path. */
  tokenPrefix: string;
  /** Full raw token (`prefix.secret`) presented by the caller — verified against the stored hash, never persisted. */
  rawToken: string;
  /** Parsed JSON body. A single object is normalized to a one-element array by the route before this point. */
  records: unknown[];
  /** Caller-supplied delivery identifier (e.g. an `X-Event-Id`-style header), when the external system sends one — used as the idempotency key so retried deliveries are not reprocessed. */
  externalEventId?: string;
  requestId?: string;
  headers?: Record<string, unknown>;
  /** Raw request body bytes/text, used only to compute payloadHash for the receipt/idempotency ledger. */
  rawBody: string;
}

/**
 * Deliberately smaller than ManualIntakeResult (§4.5 step 14) — a webhook
 * caller is a machine acknowledging a delivery, not an authenticated human
 * browsing run detail; the IDs of the validation result, quality score, and
 * provenance records it can't act on are omitted, reachable instead through
 * the normal authenticated read endpoints once the caller has a
 * collectionRunId.
 */
export interface WebhookIntakeResult {
  collectionRunId: string;
  state: string;
  recordsReceived: number;
  recordsAccepted: number;
  recordsRejected: number;
  correlationId: string;
  /** True when this delivery's idempotency key matched an already-processed receipt — the run was not reprocessed. */
  replayed: boolean;
}
