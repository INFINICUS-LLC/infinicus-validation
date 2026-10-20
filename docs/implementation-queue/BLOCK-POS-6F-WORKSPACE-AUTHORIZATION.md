# POS-6f — POS workspace authorization

Date: 2026-10-20. Owner authorization: next. Branch starts from main 34efe043c0a5d669558771b575e786601cc14c5e, after owner merges of PRs #192 and #193.

Cart mutations, catalog reads/writes and register reads/writes now check the canonical BusinessRepository.getForWorkspace in a shared preHandler before invoking their operational repository or replaying an idempotency response. This matches the workspace/non-deleted visibility already applied to business summaries and sales history. Tenant RLS remains an additional boundary; permission and subscription requirements remain intact; the new workspace guard runs before the existing idempotency handler.

The selected workspace is authenticated context, not a new branch hierarchy or role policy. No existing tenant-only repository contract is changed globally. No discounts, taxes, prices, currencies, tender allocation, sale completion, register reconciliation or operational state transitions are recalculated or redesigned.

Live Fastify/PostgreSQL regression matrices exercise all 16 POS endpoint shapes against sibling-workspace, foreign-tenant and soft-deleted-business callers. Database snapshots verify no changes to orders, products, register sessions, business events, line items, order events or payments. Previously successful tenant-scoped idempotency replays are also refused outside the current workspace or after deletion. Route-registration tests pin guard ordering for all POS routes. Positive same-workspace checkout remains usable after refused foreign requests. Existing viewer permission, idempotency, concurrency, pricing, currency, history and register tests remain in place.

No migrations, production database access, infrastructure/deployment changes, H-5A/recovery changes, locked-spec edits, new source of truth, new branch authority model, refunds, offline queue or later POS policy. No global audit of unrelated domain routes is part of this block.

Validation: scoped API integration regressions and relevant build/typecheck/lint. Stop after this block and return commit/PR for owner review; never automatically merge.
