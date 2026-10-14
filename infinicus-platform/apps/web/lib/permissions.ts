/** Permission codes the web workflow requires; these mirror the Stack B API routes that expose the same operations. */
export const BUSINESS_LIST_PERMISSIONS = ['bo:read'] as const;
/** The workflow view aggregates every layer, so it needs EVERY layer's read permission (same set as GET /v1/businesses/:id/workflow). */
export const WORKFLOW_VIEW_PERMISSIONS = ['bo:read', 'bi:read', 'dt:read', 'sim:read', 'adi:read', 'aba:read', 'om:read'] as const;
export const DECISION_PERMISSIONS = ['aba:write'] as const;
export const OUTCOME_PERMISSIONS = ['om:write'] as const;
