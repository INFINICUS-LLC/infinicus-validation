# POS-6d — Receipt business identity

Status: implemented for owner review.

The counter now reads the selected business directly through GET /v1/businesses/:businessId instead of searching the first page of the business list. The endpoint returns the existing summary contract from the canonical BusinessRepository, protected by authentication, tenant/workspace context, bo:read permission, an explicit workspace/non-deleted predicate and existing tenant RLS. It does not aggregate workflow domains or introduce business master data.

Receipt printing waits for the validated business identity. Failed reads show retry and close actions; a response for a different business is rejected. The receipt component is keyed by tenant, workspace and business so scope changes remount its read state. Amounts, payments, currency and completed-order eligibility remain server-owned.

No migrations, production changes, H-5A changes, tax or discount policy, offline sales, branch hierarchy, or later POS work are included. The header shows the current canonical legal name, not a historical legal-name snapshot. Sales-history PR #190 was merged into its foundation branch rather than main; those changes are not incorporated here. This block starts from main 29d237a.

Validation: targeted receipt UI regressions, live API pagination/permission/tenant/workspace isolation regressions, existing checkout integration suites, web suite, production build, typecheck and lint.


The first integration run exposed that existing getById only enforces tenant RLS. A dedicated getForWorkspace read now matches listForWorkspace visibility without changing existing repository callers. Regression coverage also refuses soft-deleted businesses.
