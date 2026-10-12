-- Migration: 0190_add_outbox_claimed_at
-- P0-6b (event dispatch runtime): records WHEN a dispatcher worker claimed an outbox row.
--
-- Before this migration a row moved to 'processing' carried no claim time, so a worker that crashed mid-delivery left the row
-- 'processing' forever and nothing could tell it from a delivery in flight. `claimed_at` lets the dispatcher recover rows that have been
-- 'processing' longer than a configured timeout (at-least-once delivery; consumers dedupe through the inbox).
--
-- Additive and nullable: no existing row is read, rewritten or backfilled (historic rows keep claimed_at NULL and are never treated as
-- stale). No data change. Idempotent. No GRANT or role statements (role provisioning is environment-specific).

BEGIN;

ALTER TABLE events.outbox_events
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS outbox_events_processing_claimed_idx
  ON events.outbox_events (claimed_at)
  WHERE status = 'processing';

INSERT INTO _migrations (filename) VALUES ('0190_add_outbox_claimed_at.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
