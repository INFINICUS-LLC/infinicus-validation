# OM-MEASURE-6 — conservative confounder evidence

The owner approved treating any other applied reorder-policy execution or inventory adjustment on the same item and warehouse during the baseline and measurement window as a confounder. This implementation reads BO execution and movement records under tenant scope. It excludes the execution being measured and includes adjustment, cycle-count, and write-off movements. The read is bounded and digested; missing scope, truncation, and source errors fail closed.

When a governed definition names `no_other_policy_change_or_adjustment`, a confounder produces an `OUTCOME_INCONCLUSIVE` assessment with reason `CONFOUNDED`. A clear read remains `ATTRIBUTION_UNAVAILABLE`. The existing OM attribution tables require an observation ID without defined machine-observation authority, so no attribution row or `OUTCOME_OBSERVED` verdict is produced. This block adds no metric thresholds or positive outcome authority.
