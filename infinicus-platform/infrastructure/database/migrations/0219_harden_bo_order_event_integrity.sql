-- BO-COMP-EVENT-IMMUTABILITY-1: protect recorded order lifecycle evidence.
-- Additive development migration. Existing inconsistent rows cause this migration to fail;
-- they are never rewritten or silently repaired.
BEGIN;

-- A foreign key on order_id alone cannot prevent an event from claiming a foreign scope.
ALTER TABLE platform.orders
  ADD CONSTRAINT orders_event_scope_unique UNIQUE (id, tenant_id, workspace_id, business_id);
ALTER TABLE business_operations.order_events
  ADD CONSTRAINT order_events_order_scope_fk
  FOREIGN KEY (order_id, tenant_id, workspace_id, business_id)
  REFERENCES platform.orders (id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT;

-- PostgreSQL's unique index arbitrates simultaneous completion inserts.
CREATE UNIQUE INDEX order_events_one_completion_per_order
  ON business_operations.order_events (order_id) WHERE event_type = 'completed';

CREATE TRIGGER forbid_order_event_update_delete
  BEFORE UPDATE OR DELETE ON business_operations.order_events
  FOR EACH ROW EXECUTE FUNCTION business_operations.forbid_mutation();
CREATE TRIGGER forbid_order_event_truncate
  BEFORE TRUNCATE ON business_operations.order_events
  FOR EACH STATEMENT EXECUTE FUNCTION business_operations.forbid_mutation();

INSERT INTO _migrations (filename) VALUES ('0219_harden_bo_order_event_integrity.sql')
  ON CONFLICT (filename) DO NOTHING;
COMMIT;
