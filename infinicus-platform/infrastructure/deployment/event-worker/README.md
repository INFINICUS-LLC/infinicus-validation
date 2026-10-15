# Event worker (P0-6b)

The outbox dispatcher runs as its **own process** (owner ruling O-1). The API only accepts requests; it never polls, schedules or dispatches.

**Status: built, not deployed, not enabled (as of the repository at `130bf5a`; whether it runs on the production host is not recorded in the repository and must be confirmed by the owner).** Nothing here starts by default (compose profile `event-worker`). Even a running worker acts on
nothing until all of these hold: the build registry lists the action type (`PRODUCTION_SUPPORTED_ACTION_TYPES`; it lists `inventory_reorder_policy_update@1` since P0-6e — see `boActionCapabilities.ts`), a
per-business activation exists, the global kill switch is not engaged (P0-6e), **and** the business has an `events.event_subscriptions` row
for `bo.authorized_action_intake`. No subscription row = nothing is delivered.

## What it does
`discover scopes with dispatchable rows -> per scope (own tenant context): recover abandoned claims -> claim a batch of the configured event
types -> validate against the contract registry -> append to the immutable ledger -> deliver to matching in-process subscriptions
(delivery attempt recorded) -> publish, or retry with the subscription backoff, or dead-letter`. Delivery is at-least-once; consumers are
idempotent through the inbox. It only ever claims `control_loop.action.authorized` rows; legacy outbox rows are not touched.

## Configuration (all required; the process refuses to start otherwise)
See `.env.example` (`INFINICUS_EVENT_WORKER_*`). Thresholds are owner-set deployment values, not code defaults.

## Database roles (provisioned by the operator; migrations contain no GRANT/role statements)
- `DATABASE_URL`: the normal least-privilege application role (row-level security applies to everything the worker does).
- `INFINICUS_EVENT_WORKER_DISCOVERY_DATABASE_URL`: a **separate** read-only role that can see which tenant/workspace scopes have
  dispatchable rows, nothing else, for example:

  ```sql
  CREATE ROLE infinicus_worker_discovery LOGIN BYPASSRLS PASSWORD '<from the secret store>';
  GRANT USAGE ON SCHEMA events TO infinicus_worker_discovery;
  GRANT SELECT (tenant_id, workspace_id, event_type, status, available_at, claimed_at) ON events.outbox_events TO infinicus_worker_discovery;
  ```
  The API role cannot enumerate other tenants; without this role the worker discovers nothing and does nothing.

## Run (deliberately, never by default)
See `docker-compose.event-worker.yml`. Since P0-6e/P0-6f the subscription rows are provisioned, verified and activated atomically by the audited `bo:admin` activation request (`PUT /v1/businesses/:id/execution-activations`); the manual form below is reference only (`EventSubscriptionRepository.create`
with `subscriberName: 'bo.authorized_action_intake@<workspaceId>'` (the name is unique platform-wide, so it carries the scope), `destinationType: 'in_process'`, `destinationReference: 'bo.authorized_action_intake'` (the consumer key), `eventPattern: 'control_loop.action.authorized'`,
`supportedVersions: ['1']`, and `retryPolicy` `{ "maxAttempts": 3, "backoffSeconds": [1, 5, 15] }`, ruling O-3).
