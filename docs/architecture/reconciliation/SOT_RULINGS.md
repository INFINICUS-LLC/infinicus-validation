# SOT-05 / SOT-06 / SOT-07 — Owner rulings

Source: owner ruling, based on a live read-only inspection of Supabase project `infinicus-development` (`cvlmjwauvzcappgvylbi`). The figures below are as reported by the owner; they were not re-verified from this repository. No locked architecture is amended.

## SOT-05 — RESOLVED: canonical billing data
`billing.plans`, `billing.subscriptions`, `billing.subscription_status_history`, `billing.usage_records`.
Live: 3 plans; 46 subscriptions (23 active, 12 trialing, 5 suspended, 4 grace_period, 2 canceled).
`public.tenants.plan` and any other legacy field are NOT canonical subscription truth. (Supersedes the SOT-05 "profiles vs billing" question in SOURCE_OF_TRUTH_AUDIT C13.)

## SOT-06 — RESOLVED: ownership boundary
- `tenancy.*` owns tenant/workspace identity and scope.
- `billing.*` owns plan, subscription lifecycle, usage and payment-state metadata.
- Billing authority must not move into `public.*` or `platform.*` for convenience.

## SOT-07 — PARTIALLY RESOLVED
`platform.*` is active and populated but NOT globally canonical. `platform.businesses` (120 rows) is a major shared FK hub.
These platform tables overlap locked lifecycle layers and must NOT replace the layer schemas:

| platform table | not a replacement for |
|---|---|
| `platform.decisions` | `ai_decision_intelligence.*` |
| `platform.approved_actions` | `approved_business_action.*` |
| `platform.simulations` | `simulation.*` |
| `platform.outcomes` | `outcome_monitoring.*` |
| `platform.learning_items` | `continuous_learning.*` |

Classification: **legacy / shared compatibility or aggregation surfaces, pending final migration/classification.** Other shared operational entities in `platform.*` may stay active where consistent with BO / Business Administration ownership, but each is classified individually (not yet done).

## Stack ruling and live facts
Active data plane = Stack B structured schemas. Legacy `public.*` is not promoted to canonical.
identity.users 465 · tenancy.tenants 106 · tenancy.workspaces 106 · tenancy.memberships 209 · platform.businesses 120 · billing.subscriptions 46 · simulation.simulation_runs 24 · public.users/tenants/workspaces/businesses 0.

## Migration drift (recorded; nothing applied)
Live Supabase state ends at `0169_add_manual_json_connector_type.sql`. `main` includes `0170_add_approved_action_source_recommendation.sql` and `0171_create_da_webhook_token_lookup.sql`. Live is two migrations behind. Migrations are NOT applied automatically; a controlled deployment/reconciliation step is to be prepared later. PR #22 (migration-number conflict) remains with the owner.

## Open items these rulings do not close
- Per-table classification of the remaining `platform.*` tables (incl. BO overlap with `business_operations.*`, V-08/SOT-08).
- Legacy Stack A D1 data volume (`businesses`, `business_events`, `decision_memory`) for the SOT-02 retirement gate is still unknown. The Supabase counts above do not cover D1.
- Code paths still reading `platform.decisions/approved_actions/simulations/outcomes/learning_items` or `profiles.plan` have not been re-audited against these rulings; that is a later reconciliation step.
