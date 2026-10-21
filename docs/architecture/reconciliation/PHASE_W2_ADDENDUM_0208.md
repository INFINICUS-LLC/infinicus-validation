# Phase W2 addendum — migration 0208 (POS-8b printer registry) (PLAN ONLY)

Status: PLANNED, NOT AUTHORISED, NOT EXECUTED. Production stays at ledger 201 until the owner names a window.

The Phase W2 window plan (`PHASE_W2_WINDOW_PLAN_0202-0206.md`) covers 0202–0207. This addendum proposes adding **0208** to the same window (one backup, one gate run, one verification) rather than a second window. Owner decision required; recommended: include.

- **What 0208 is:** one new, empty table `business_operations.printers` with RLS and an updated_at trigger. No existing table, row, function or grant changes. Nothing in the running application reads it until a later block, so it is the lowest-risk migration of the set.
- **Rollback:** `DROP TABLE business_operations.printers;` and delete its ledger row (valid while no printer rows matter; additive to Appendix A1/A2 of the window plan, which are unchanged for 0202–0207). Not yet proven from this document's text on a throwaway database the way A1/A2 were; do that in the pre-window rehearsal.
- **Verification after apply:** ledger head `0208_create_printers.sql`; discovery script verdict `fingerprint-verdict=MATCHES_REPOSITORY_0208_PG16` (hash `c2daa833c2f83c70`); `printers` present with RLS enabled and 0 rows.
- **Release SHA:** if included, the candidate release is the merge commit of the POS-8b pull request (it carries 0208 and the discovery reference); it also contains everything merged before it. The exact SHA is named in the authorisation and CI on it is re-read on the day.
- **Order:** merge POS-8b only after POS-8a/8d-1/8e decisions are settled, because the release SHA is "whatever is on main at that merge".

## 0209 (POS-8c print-job log) — same proposal
Status: PLANNED, NOT AUTHORISED, NOT EXECUTED. Proposed for the same window as 0208 (one backup, one gate, one verification for 0202–0209); owner decision.
- **What 0209 is:** one new, empty, append-only table `business_operations.print_jobs` (RLS, refuses UPDATE/DELETE/TRUNCATE through the existing `forbid_mutation()`; no new function, so the function fingerprint is unchanged). It references `platform.orders` and `business_operations.printers` (0208), so **0208 must be applied first** (the gate applies in order).
- **Rollback:** `DROP TABLE business_operations.print_jobs;` then delete its ledger row; do this BEFORE rolling back 0208 (a foreign key points at `printers`). Not yet proven from this text on a throwaway database; do it in the pre-window rehearsal.
- **Verification after apply:** ledger head `0209_create_print_jobs.sql`; discovery verdict `MATCHES_REPOSITORY_0209_PG16` (hash `325158ea2a54cde9`); `print_jobs` present, RLS on, 0 rows.
- **Compatibility:** the new counter tolerates an API/database that does not have these tables yet (routing and logging are best effort), so the release and the migration window do not have to be simultaneous for printing to keep working.
- **Release SHA:** the merge commit of the POS-8c pull request if 0209 is included.
