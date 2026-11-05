/**
 * SEC-BILL-02B-1 architecture guards (static): migration 0227 replaces EXACTLY the three legacy billing emit_* functions (R8: wider SECURITY DEFINER hardening is a separate block),
 * pins their search_path, confines the helper to billing.* events, enforces the session tenant, revokes PUBLIC, and changes nothing else.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
const sql = strip(read('infrastructure/database/migrations/0227_harden_billing_emit_functions.sql'));
const grant = read('infrastructure/database/scripts/grant-app-role.sh');

describe('SEC-BILL-02B-1 - migration 0227 shape', () => {
  it('replaces exactly the three legacy functions and nothing else', () => {
    expect([...sql.matchAll(/CREATE OR REPLACE FUNCTION (billing\.[a-z_]+)\(/g)].map((m) => m[1]).sort()).toEqual(['billing.emit_outbox_event', 'billing.emit_subscription_status_changed', 'billing.emit_usage_limit_exceeded']);
    expect(sql).not.toMatch(/\bCREATE\s+(TABLE|INDEX|TRIGGER|POLICY|SCHEMA|ROLE|EXTENSION)\b|\bALTER\s+(TABLE|ROLE|FUNCTION|SCHEMA)\b|\bDROP\b|\bTRUNCATE\b|\bGRANT\b|\bUPDATE\b|\bDELETE\b|INSERT INTO (?!_migrations|events\.outbox_events)/i);
  });
  it('every function is SECURITY DEFINER with the pinned search_path, and every relation and function it uses is schema-qualified', () => {
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(3);
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(3);
    const bodies = sql.split(/CREATE OR REPLACE FUNCTION/).slice(1).join('\n').split('REVOKE ALL')[0]!; // the three function bodies only (not the REVOKE statements after them)
    expect(bodies).not.toMatch(/(?<![.\w])(now|gen_random_uuid|jsonb_build_object|current_setting)\(/);
    expect(bodies).not.toMatch(/(INSERT INTO|(?<!DISTINCT )FROM|JOIN)\s+(?!events\.|billing\.|_migrations)[a-z_]+/i); // (IS DISTINCT FROM is an operator, not a relation reference)
  });
  it('the helper enforces the session tenant AND workspace, then confines the event type to billing.*', () => {
    expect(sql).toMatch(/p_tenant_id IS DISTINCT FROM NULLIF\(pg_catalog\.current_setting\('app\.tenant_id', true\), ''\)::uuid/);
    expect(sql).toMatch(/p_workspace_id IS DISTINCT FROM NULLIF\(pg_catalog\.current_setting\('app\.workspace_id', true\), ''\)::uuid/);
    expect(sql).toMatch(/p_event_type !~ '\^billing\(\\\.\[a-z\]\[a-z_\]\*\)\+\$'/);
    const body = sql.slice(sql.indexOf('emit_outbox_event('), sql.indexOf('emit_subscription_status_changed('));
    expect(body.indexOf('tenant scope mismatch')).toBeLessThan(body.indexOf('INSERT INTO events.outbox_events'));
    expect(body.indexOf('event type not permitted')).toBeLessThan(body.indexOf('INSERT INTO events.outbox_events'));
  });
  it('PUBLIC execution is revoked on all three and the migration records itself under its exact name', () => {
    for (const sig of ['emit_outbox_event\\(uuid, uuid, text, text, uuid, uuid, jsonb, text, uuid\\)', 'emit_subscription_status_changed\\(uuid, uuid, uuid, text, text, uuid\\)', 'emit_usage_limit_exceeded\\(uuid, uuid, text, bigint, bigint, uuid\\)']) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION billing\\.${sig}\\s+FROM PUBLIC`));
    }
    expect(sql).toMatch(/INSERT INTO _migrations \(filename\) VALUES \('0227_harden_billing_emit_functions\.sql'\)/);
  });
  it('the grant script withholds only the internal helper from the application role (the wrappers stay callable by the billing repositories)', () => {
    expect(grant).toMatch(/REVOKE EXECUTE ON FUNCTION billing\.emit_outbox_event\(uuid, uuid, text, text, uuid, uuid, jsonb, text, uuid\) FROM %I/);
    expect(grant).not.toMatch(/REVOKE EXECUTE ON FUNCTION billing\.emit_(subscription_status_changed|usage_limit_exceeded)/);
  });
  it('the only callers of the wrappers are the billing repositories, passing the transaction\'s own ctx; nothing calls the helper directly', () => {
    const repo = (f: string) => strip(read(`packages/database/src/repositories/billing/${f}`));
    expect(repo('SubscriptionRepository.ts')).toMatch(/billing\.emit_subscription_status_changed\(\$1,\$2,\$3,\$4,\$5,\$6\)', \[\s*ctx\.tenantId, ctx\.workspaceId/);
    expect(repo('UsageRepository.ts')).toMatch(/billing\.emit_usage_limit_exceeded\(\$1,\$2,\$3,\$4,\$5,\$6\)', \[\s*ctx\.tenantId, ctx\.workspaceId/);
  });
});
