-- Migration: 0193_align_execution_mutation_result_vocabulary
-- P0-6d: the shared contract `execution-evidence/1` names the "no mutation was applied" result NOT_APPLICABLE (APPLIED | NO_CHANGE |
-- NOT_APPLICABLE). Migration 0191 (merged, never applied to any live database, nothing wired) used NOT_APPLIED for the same fact. One fact
-- must have one name, so the two CHECK constraints that carry the vocabulary are replaced here; nothing else changes.
--
-- Both replacements are NOT VALID: PostgreSQL still enforces them for every new row, and rows that already exist are neither scanned,
-- rewritten nor repaired (the table is append-only, so history is never edited). No execution row exists in any real environment
-- (the engine is unwired); a development database that ran the P0-6c tests may hold NOT_APPLIED rows, which stay as they are.
-- Idempotent. No data change. No GRANT or role statements.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'authorized_action_executions_mutation_result_check'
       AND conrelid = 'business_operations.authorized_action_executions'::regclass
       AND pg_get_constraintdef(oid) LIKE '%NOT_APPLICABLE%'
  ) THEN
    ALTER TABLE business_operations.authorized_action_executions DROP CONSTRAINT IF EXISTS authorized_action_executions_mutation_result_check;
    ALTER TABLE business_operations.authorized_action_executions
      ADD CONSTRAINT authorized_action_executions_mutation_result_check
      CHECK (mutation_result IN ('APPLIED', 'NO_CHANGE', 'NOT_APPLICABLE')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'authorized_action_executions_outcome_shape'
       AND conrelid = 'business_operations.authorized_action_executions'::regclass
       AND pg_get_constraintdef(oid) LIKE '%NOT_APPLICABLE%'
  ) THEN
    ALTER TABLE business_operations.authorized_action_executions DROP CONSTRAINT IF EXISTS authorized_action_executions_outcome_shape;
    ALTER TABLE business_operations.authorized_action_executions
      ADD CONSTRAINT authorized_action_executions_outcome_shape CHECK (
        (outcome = 'SUCCEEDED' AND reason_code IS NULL AND mutation_result IN ('APPLIED', 'NO_CHANGE'))
        OR (outcome IN ('FAILED', 'REFUSED') AND reason_code IS NOT NULL AND mutation_result = 'NOT_APPLICABLE')
      ) NOT VALID;
  END IF;
END
$$;

INSERT INTO _migrations (filename) VALUES ('0193_align_execution_mutation_result_vocabulary.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
