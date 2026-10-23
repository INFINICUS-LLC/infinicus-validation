# OM-23 to OM-24

Receives a structured learning package with lessons, factors, hypotheses, limitations, applicability scope, confidence, reliability, correlation, and lineage. The existing browser block is a prototype and its IndexedDB records are not production authority.

# Governed production source

Migration `0213_create_om_governed_publication_source.sql` adds separate, append-only measurement definitions, outcome verdicts, and OM-24 publication receipts under forced tenant/workspace RLS. `OM24AuthorityRepository.hasVerifiedPublication` checks the persisted receipt, verdict, definition, publication, feedback package, business scope, and exact governed detail digest. It never accepts a caller-supplied receipt or verdict by itself.

No measurement values are defaulted, the application role cannot write these tables, and the verdict CHECK currently permits only `OUTCOME_OBSERVED`. An OM measurement runner, attribution proof, human verification act, and receipt issuer are still required before any `OUTCOME_VERIFIED` verdict or OM-24 receipt can exist. Until then CL-02 quarantines the handoff and the learning boundary stays closed.

# OM-24 to Continuous Learning and OM-25

A future governed issuer may publish a receipt only after a scoped verified verdict exists for the feedback package's observation. The receipt and verdict identities must be re-read through the authority repository before CL-02 can validate them. This foundation does not activate learning or send a CL-03 handoff.
