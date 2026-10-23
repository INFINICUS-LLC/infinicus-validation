# OM-MEASURE-7 — fail-closed preparatory work

Owner decision: preparatory work only. The `NET_SALES_REVENUE_V1` model, seven-day window, OM-owned writer, append-only attribution assessment, and human approver policy are candidates, not approved sources of a positive verdict.

`assessVerificationRefusal` classifies missing or unsafe candidate facts: execution, tenant and business scope, metric and criterion approval, baseline, completed window, observation writer, evidence provenance, currency, passing attribution, approver authority and separation of duties. Its result type is always `verdictAllowed: false` and always includes `OBSERVATION_AUTHORITY_PENDING`. It has no database, verdict writer, or learning sink dependency. Supplied booleans are advisory; they confer no authority.

It reuses the existing execution verification and governed definition types and the existing OM outcome vocabulary. The database remains restricted to PENDING and INCONCLUSIVE verdicts; `learningEligibility` remains the single OM to CL gate. No migration, route, contract, permission, or production integration is added.

Before VERIFIED or FAILED may be considered, the owner must approve: the metric's qualifying sale/refund and currency semantics, calculation version and baseline equivalence; the observation writer and immutable ID/version lineage; integrity proof from governed source records; append-only attribution PASS authority; the approved success criterion and threshold; executor identity and independent human approver authority; and a separate schema and role-policy change with disposable database proof. A candidate preflight result cannot substitute for any of these decisions.
