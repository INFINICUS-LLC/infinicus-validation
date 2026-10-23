# OM to CL-02 intake contract

The deployed OM-to-CL handoff is `OM_TO_CL_CONTRACT_VERSION` 1.0.0. Its current producer shape is an OM-09 feedback package with observation and feedback version references, findings, review actions, variance summary, evidence references, correlation, and lineage. CL-01 must first pass it through `LearningReleaseBoundary`; an unverified outcome never reaches CL-02 persistence.

CL-02 records a gated current-shape handoff as a rejected/quarantined intake with `CL02_GOVERNED_PUBLICATION_MISSING`. The rejection stores reason codes, not a copied arbitrary payload. It is not accepted learning and creates no CL-03 handoff.

The additive `governedPublication` field in the OM-to-CL contract describes the future OM-24 publication: receipt, outcome verdict, monitoring contract, confidence, reliability, scope, limitations, lessons, factors, hypotheses, and feedback categories. Malformed fields fail the handoff gate. Structurally valid fields remain quarantined with `CL02_GOVERNED_SOURCE_UNVERIFIED` until an authoritative OM-24 receipt and verdict source exists and can be checked under the tenant/business scope. Caller-supplied fields alone cannot grant acceptance.

# CL-02 to CL-03

No production CL-03 handoff is authorized by this change. A future governed implementation must release only an accepted, source-verified package with its immutable identity, validation state, confidence, reliability, correlation, and lineage.
