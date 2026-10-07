-- Migration: 0170_create_da_webhook_token_lookup
-- BUILD-31 follow-up — webhook intake for 'webhook'-type connectors.
--
-- Adds a prefix+hash bearer-token pair to connectors (the same
-- generateApiKey()/hashToken() shape @infinicus/authentication already
-- uses for session tokens and API keys, reused rather than introducing a
-- new secret-storage scheme — see the deferred "external secret vault
-- implementation" item in the BUILD-31 spec's out-of-scope list, which
-- this deliberately does not attempt). The raw token is shown to the
-- caller exactly once at generation time and never persisted; only its
-- SHA-256 hash is stored, so a compromised database still yields no
-- usable token — same guarantee session tokens already have.
--
-- The genuinely new problem this migration solves: an inbound webhook
-- carries only the raw token — no tenant/workspace context, unlike every
-- other DA write, which always starts inside an authenticated,
-- tenant-scoped request. data_acquisition.connectors is RLS-protected
-- (0021_create_da_rls_policies.sql), so a plain SELECT with no
-- app.tenant_id GUC set returns zero rows by design — there is no way to
-- discover which tenant owns a given token without already knowing it.
--
-- find_connector_for_webhook() is a narrow, single-purpose SECURITY
-- DEFINER function (the same mechanism this schema's own emit_*() outbox
-- functions already use, see 0022_create_da_triggers_events.sql) that
-- resolves a token prefix to its owning connector/tenant/workspace,
-- bypassing RLS for this one read only. It returns just enough to verify
-- the token and open a real, tenant-scoped transaction from that point
-- on — never a full connector row, never another tenant's data.

BEGIN;

ALTER TABLE data_acquisition.connectors
  ADD COLUMN IF NOT EXISTS webhook_token_prefix text,
  ADD COLUMN IF NOT EXISTS webhook_token_hash   text,
  ADD CONSTRAINT connectors_webhook_token_pair_check CHECK (
    (webhook_token_prefix IS NULL) = (webhook_token_hash IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS connectors_webhook_token_prefix_unique
  ON data_acquisition.connectors (webhook_token_prefix)
  WHERE webhook_token_prefix IS NOT NULL;

CREATE OR REPLACE FUNCTION data_acquisition.find_connector_for_webhook(
  p_token_prefix text
) RETURNS TABLE (
  connector_id      uuid,
  tenant_id         uuid,
  workspace_id      uuid,
  business_id       uuid,
  data_source_id    uuid,
  connector_status  text,
  source_status     text,
  webhook_token_hash text,
  created_by        uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
    SELECT
      c.id, c.tenant_id, c.workspace_id, s.business_id, c.data_source_id,
      c.status, s.status, c.webhook_token_hash, c.created_by
    FROM data_acquisition.connectors c
    JOIN data_acquisition.data_sources s ON s.id = c.data_source_id
    WHERE c.webhook_token_prefix = p_token_prefix
      AND c.connector_type = 'webhook'
      AND c.deleted_at IS NULL
      AND s.deleted_at IS NULL;
END;
$$;

INSERT INTO _migrations (filename) VALUES ('0170_create_da_webhook_token_lookup.sql')
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
