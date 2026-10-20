# Phase W2 addendum — migration 0208 (POS-8b printer registry) (PLAN ONLY)

Status: PLANNED, NOT AUTHORISED, NOT EXECUTED. Production stays at ledger 201 until the owner names a window.

The Phase W2 window plan (`PHASE_W2_WINDOW_PLAN_0202-0206.md`) covers 0202–0207. This addendum proposes adding **0208** to the same window (one backup, one gate run, one verification) rather than a second window. Owner decision required; recommended: include.

- **What 0208 is:** one new, empty table `business_operations.printers` with RLS and an updated_at trigger. No existing table, row, function or grant changes. Nothing in the running application reads it until a later block, so it is the lowest-risk migration of the set.
- **Rollback:** `DROP TABLE business_operations.printers;` and delete its ledger row (valid while no printer rows matter; additive to Appendix A1/A2 of the window plan, which are unchanged for 0202–0207). Not yet proven from this document's text on a throwaway database the way A1/A2 were; do that in the pre-window rehearsal.
- **Verification after apply:** ledger head `0208_create_printers.sql`; discovery script verdict `fingerprint-verdict=MATCHES_REPOSITORY_0208_PG16` (hash `c2daa833c2f83c70`); `printers` present with RLS enabled and 0 rows.
- **Release SHA:** if included, the candidate release is the merge commit of the POS-8b pull request (it carries 0208 and the discovery reference); it also contains everything merged before it. The exact SHA is named in the authorisation and CI on it is re-read on the day.
- **Order:** merge POS-8b only after POS-8a/8d-1/8e decisions are settled, because the release SHA is "whatever is on main at that merge".
