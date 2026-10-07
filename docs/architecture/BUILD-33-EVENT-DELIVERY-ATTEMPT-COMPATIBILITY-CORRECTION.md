# BUILD-33 — Event Delivery Attempt Compatibility Correction

**Build:** BUILD-33 — Cross-Domain Business Event Architecture  
**Specification:** v1.1  
**Guardrail:** INFINICUS Master Architecture Guardrail v1.0  
**Status:** IMPLEMENTED — VALIDATION PENDING  
**Date:** 2026-10-05

## Conflict

The historical Stage-2A event schema describes
`events.event_delivery_attempts` as:

```text
Append-only: one row per attempt; never overwrite.
```

An earlier BUILD-33 repository draft implemented:

```text
INSERT status=started
→ UPDATE status=succeeded|failed|timed_out|cancelled
```

That mutates delivery-history evidence and conflicts with the Master
Architecture Guardrail requirement to preserve historical traceability.

The older Event Backbone Phase-2 planning document also contains this internal
inconsistency: it calls attempts append-only while describing started→terminal
updates. BUILD-33 v1.1 and the Master Architecture Guardrail take precedence.

## Corrected ownership model

```text
events.outbox_events
= mutable delivery/work queue state

events.event_delivery_attempts
= append-only delivery-attempt history

events.business_event_ledger
= immutable canonical business-event evidence
```

No business-domain source of truth moves to DATA.

## Corrected repository model

`EventDeliveryAttemptRepository` now records one terminal row per completed
attempt:

```text
record({
  outboxEventId,
  attemptNumber,
  status: succeeded|failed|timed_out|cancelled,
  attemptedAt,
  completedAt,
  latencyMs,
  ...
})
```

It no longer exposes BUILD-33 methods that update an existing attempt from
`started` to a terminal state.

The repository validates:

- completion is not earlier than attempt start;
- latency is finite and non-negative;
- failed attempts include controlled failure evidence.

Attempt history is read through `listForOutbox()`.

## Database compatibility

Migration 0172 remains additive.

For backward compatibility it continues accepting the historical status
vocabulary:

```text
started
succeeded
failed
timed_out
cancelled
```

This avoids invalidating any historical rows produced before BUILD-33.

BUILD-33 itself writes only terminal attempt rows.

Migration 0172 now adds a database trigger that rejects UPDATE and DELETE on
`events.event_delivery_attempts`, closing the enforcement gap between the
historical schema comment and actual database behavior.

## Retry model

A retry creates another immutable attempt row:

```text
attempt_number=1 status=failed
attempt_number=2 status=failed
attempt_number=3 status=succeeded
```

The existing unique constraint:

```text
(outbox_event_id, attempt_number)
```

prevents a retry from overwriting or duplicating one numbered attempt.

Mutable retry scheduling remains in `events.outbox_events`.

## Architecture impact

Platform domain:

```text
DATA → Event Infrastructure
```

Nine-layer decision lifecycle:

The correction serves all layers only as transport/history infrastructure and
does not acquire any layer's source-of-truth responsibility.

Approved Business Action remains the authorization boundary for business action
execution. Delivery-attempt replay/history cannot execute an action.

## Validation requirements

Before this correction is accepted:

- TypeScript build/typecheck must pass.
- Migration gate must pass.
- Static migration test must prove the mutation trigger exists.
- Live PostgreSQL test must prove one terminal row is inserted.
- Live PostgreSQL test must prove UPDATE is rejected.
- Live PostgreSQL test must prove DELETE is rejected.
- Cross-workspace attempt reads must remain denied.
- Duplicate attempt numbers must fail rather than overwrite history.
- Full Platform CI and BUILD-32 regression CI must remain green.

No BUILD-34 work is authorized by this correction.
