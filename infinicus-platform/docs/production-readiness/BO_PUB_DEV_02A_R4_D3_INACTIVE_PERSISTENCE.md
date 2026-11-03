# R4/D3 inactive persistence proposal

**Status — PROPOSED_NOT_ACTIVE.** Review baseline is main at
`0bf1be87b4156c1ca0f101596fb29eec3a430478`. This document proposes
a database model and test protocol for D3. Owner decisions below are open.

## Existing boundary

Migration 0033 gives `business_operations.bo_publication_packages` a UUID
primary key, a unique business/package-code pair, and a positive period
check. Scope and period are stored on the header. Its foreign keys reference
tenant, workspace and business individually. Migration 0035 enables header
RLS using tenant and workspace settings. PR #420 forces header RLS on
disposable CI databases. The existing policy does not independently restrict
sibling businesses in the same workspace.

`OperationalPublicationService.dispatchToBusinessIntelligence` locks the
header, checks for a prior dispatch, and records the handoff, state change
and publication event in one transaction. The replay returns the existing
handoff identity when the header is dispatched. This remains the frozen
header-only path. It has no durable record-artifact association.

The proposed evidence producer and verifier define the ordered canonical
body and use SHA-256 over that body. The evidence ID is SHA-256 over
`bo-evidence-id:` + contract name + `:` + digest. The body includes scope
and source, including the package ID when bound. Correlation is outside the
hashed body. An unbound artifact is unsuitable for persistence. The merged
R4 certification review leaves durable association and publisher entitlement
open.

## Candidate relational model

Use one immutable association row containing the full verified artifact
body. A separate records table is unnecessary for this candidate. If later
approved, any materialized record projection must be written in the same
transaction and tied to the immutable body and ordinal positions.

| Field | Proposed requirement |
|---|---|
| Association row ID | Generated UUID primary key. Independent of evidence ID. |
| Header and scope | Non-null header, tenant, workspace and business UUIDs. |
| Declared period | Non-null finite timestamptz endpoints matching the header exactly. Start inclusive, end exclusive. End strictly after start. |
| Contract | Non-null contract identity, schema version, canonicalization and digest algorithm drawn from the existing verifier. |
| Artifact | Canonical body bytes, nonnegative record count, SHA-256 digest and deterministic evidence ID. Require canonical lowercase hex for both identities. |
| Creation metadata | Database creation time and approved provenance fields. First correlation, if retained, stays immutable and outside content equality. |

Use a non-deferrable unique constraint on header ID alone. This is stronger
than uniqueness on header plus period or version. A header represents a
single declared period, so a changed period or version cannot create a
second slot. Uniqueness on digest or evidence ID alone would allow different
artifacts for the same header. Separate headers with the same time bounds
remain separate associations.

Propose a composite foreign key from association
`(header_id, tenant_id, workspace_id, business_id, period_start, period_end)`
to the same header tuple with `id` first. PostgreSQL requires a corresponding
unique key on the parent tuple. Use immediate checks with restrictive delete
and update actions. This pins the referenced scope and period after association
and permits unrelated header status changes. Adding that parent key and
restricting future scope/period edits require explicit compatibility review.
An association copied from another header or scope must fail even when
the inserting role can see both headers. Confirm header scope lineage through
the trusted business membership mapping. Separate parent IDs do not establish
that lineage by themselves.

Keep digest, ID, body and extracted metadata consistent through a single
controlled writer that runs the existing verifier and compares the decoded
body against the locked header. Recheck on read before returning a recovered
artifact. A hex check only proves shape. The uniqueness and foreign key
guarantees hold in PostgreSQL independently of verifier correctness. Full
semantic integrity also depends on restricting direct inserts to the
approved write boundary. Treat canonical bytes as the equality reference.
Do not reconstruct signed or hashed bytes from JSONB serialization.

Deny UPDATE, DELETE and TRUNCATE to runtime roles. Use a non-login owner
with no runtime membership and a row trigger rejecting update/delete as
defense in depth. TRUNCATE is outside row RLS and must be denied explicitly.
Approval must cover retention, erasure, and privileged repair. The model
assumes a trusted schema administrator. It cannot make superusers unable
to alter schema or data.

## Transaction and recovery

Use READ COMMITTED with one transaction and one connection. Establish
trusted request scope with transaction-local context. Resolve visibility
before exposing state or any constraint error. Lock the header by exact
tenant, workspace, business and ID with FOR UPDATE, then inspect the
association. Use the same lock order for all candidate writers. This
serializes contenders and protects scope and period against concurrent edits
while deciding the association. The unique key is the final database backstop.

For first creation, require a visible BI-targeted, ready header and a bound
artifact that passes the existing verifier. Check exact period, count, scope,
package binding and supported contract. Compute outside the lock if useful
and revalidate those invariants under the lock. Insert the full artifact
atomically. Return success only after commit.

For replay, resolve the existing association before rejecting a header that
has since advanced to an approved replay state. Compare canonical bytes,
digest, evidence ID, scope, period and contract. Return the committed row ID
and content identity on an exact match. Ignore a new correlation for equality.
Refuse a different body or metadata even when count or digest matches.
Recovery uses the scoped header key and verifies persisted contents on a
new connection. Missing association on an already dispatched header fails
closed. Recovery never creates a row or regenerates from changed ledger data.

Use INSERT ON CONFLICT on the specific header uniqueness key with DO NOTHING.
If a contender did not insert, read the winner in a separate statement in the
same READ COMMITTED transaction and apply identical replay validation.
Do not use an upsert that mutates the winner. Treat a missing visible winner
or integrity failure as refusal. Map absent/foreign header requests to one
non-disclosing result. Return a sanitized conflict only after scoped access is
established. Roll back on mismatch, timeout or cancellation. Retry deadlock
or serialization errors by restarting the whole scoped transaction with
a bounded policy. After ambiguous commit, recover by scoped header key.

The candidate transaction changes only association state. It emits no audit,
outbox or dispatch event. Any later record publication transaction and its
entitlement require separate approval. Existing header-only behavior is
untouched by the candidate.

## RLS and inactive verification boundary

Require ENABLE and FORCE RLS on candidate storage. Require explicit read and
insert predicates covering tenant, workspace and approved business scope.
Derive context from the trusted server boundary and reject missing, malformed,
or untrusted context. Treat caller-writable session settings as insufficient
proof of identity. The candidate test role is non-owner, non-superuser,
non-BYPASSRLS and cannot assume an owner role. Prove that the proposed header
locking privilege is narrow and does not allow unrelated updates. Existing
header RLS alone is insufficient for sibling-business isolation. D3 fixture
scope tests do not establish the D4 publisher entitlement.

A separately approved future harness would create an isolated disposable
PostgreSQL cluster with a migrated baseline and synthetic headers. It would
apply fixture-only candidate DDL outside the numbered migrations, invoke
a test-only transaction adapter with the existing pure verifier, and use
separate sessions for lock and commit tests. Require harness ownership of the
cluster and no externally supplied database target. Keep the adapter outside
runtime imports, route registration, production builds and dispatch. Use
the admin connection only for setup and catalog checks. Run the assertions
under the constrained app role and inspect state using scoped queries.
Capture exact SQLSTATEs, row counts, identities, event counts and transaction
outcomes. A fixture pass would prove candidate mechanics in PostgreSQL.
Production role compatibility and active publication acceptance remain
separate gates.

## Executable acceptance matrix for the future harness

| Case | Stimulus | Required observations |
|---|---|---|
| First association | Persist valid bound evidence on a visible ready header. | One row after commit. Exact header tuple, canonical bytes, digest and ID. Header and dispatch, audit and outbox counts unchanged. |
| Identical replay | Repeat with a new correlation, then repeat after an eligible fixture header state transition. | Same row and evidence IDs. Original stored bytes and creation metadata unchanged. One row. |
| Concurrent identical | Hold the first session after insert and start the second. Release the first to commit. | Confirm observed lock wait. Both return the same committed row and ID. One row and zero dispatch effects. |
| Concurrent conflict | Use different verified content with equal count in two sessions. Then attempt a direct duplicate under a constrained fixture writer. | One winner and one sanitized conflict. Uniqueness also rejects the direct duplicate with 23505. Stored body matches the winner exactly. |
| Invalid metadata | Alter scope, period, binding, contract, digest or ID independently. Try a direct mismatched parent tuple in a visible scope. | Refusal with zero writes. Composite FK rejects mismatched tuple with 23503. Replayed body mismatch leaves the winner intact. |
| Rollback | Inject failure after insertion and before commit. Allow a waiting valid request to proceed after rollback. | First row is absent after rollback. Waiter can commit exactly one complete row. No event or partial state. |
| Recovery | Commit, discard client state before receiving success, then restart the fixture process and reconnect. Change source fixtures before recovery. | Same persisted UUID, evidence ID and bytes. No recomputation from the ledger, new row or event. Missing association on dispatched fixture header is refused. |
| Tenant isolation | Probe foreign tenant, workspace, sibling business and absent header. Exercise SELECT and INSERT with missing context as well. | Uniform non-disclosing service refusal and zero durable writes. Foreign rows invisible. Unauthorized SQL insert denied. No constraint details escape the adapter. |
| FORCE and immutability | Inspect catalog flags and role membership. Attempt cross-scope read/write, update, delete and truncate. Try moving or deleting an associated parent tuple. | RLS active with enabled and forced flags. Role cannot bypass or assume owner. Mutation denied and row unchanged. Referenced scope/period and parent deletion rejected. |
| Dispatch preservation | Run the existing header-only regression suite against baseline and fixture builds. | Equivalent header transition, handoff and event behavior. No candidate dependency in the runtime import graph. |

Use bounded barriers and statement deadlines for concurrency tests. A race
run without verified overlap does not count as concurrency proof.

## Owner decisions before implementation

1. Approve a permanent single slot per header, the composite parent key,
   period pinning and the handling of historical headers and version succession.
2. Approve canonical byte retention, provenance fields, retention and erasure
   policy, and maintenance ownership and repair responsibilities.
3. Approve the trusted scope mapping, business isolation enforcement, narrow
   header locking and insert privileges, and permitted replay states.
4. Authorize fixture-only DDL and an isolated test adapter as a separate
   development block. Decide whether the proposed test-only writer boundary
   is adequate to demonstrate the intended integrity model.
5. Require a separate decision for runtime wiring, D4 entitlement, production
   migrations, maintenance-role compatibility and activation.

Independent review should check the parent key impact and validate the
proposed scope and writer boundaries before authorizing the harness.
