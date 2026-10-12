# P0-6a — ABA execution-boundary ports (unwired)

Authorised by the programme mandate (Phase 3). Planning: `P0-6_PLANNING_ABA_BO_EXECUTION_BOUNDARY.md` §3, §6, rulings O-2, O-5, O-7. **Nothing here is wired**: no event, no worker, no BO caller, no migration, registry still empty.

## Purpose
Give Business Operations an ABA-owned way to (1) ask for the authoritative status **and** authority currentness of a package, (2) pull the sealed document a notification refers to, and (3) have ABA mirror BO's claim as `CONSUMED` — without BO ever reading or writing an ABA table.

## What was added
| Piece | Where | Notes |
|---|---|---|
| `consumptionReceiptId?` on `AuthoritativePackageStatus` | `handoff-contracts` (additive) | non-null exactly when lifecycle is `CONSUMED` (O-5) |
| `validateForExecutionAfterClaim` | `handoff-contracts` | same rules and codes as `validateForExecution`; `CONSUMED` accepted only for **this claim's receipt**; pre-claim validator unchanged |
| Ports `AuthorizedActionPackageSource`, `PackageConsumptionRecorder` (+ request/result types) | `handoff-contracts/status-provider.ts` | BO depends on these types only |
| `evaluateApproverAuthority`, `evaluateExecutionAuthority`, `policyCoversActionType` | `workflow/src/executionAuthority.ts` | **one rule**: the issuer policy and the provider both use it (issuer refactored, behaviour unchanged) |
| `AbaPackageStatusProvider` | `workflow/src/abaExecutionPorts.ts` | one authoritative never-cached read; answers `null` for anything it cannot vouch for (other scope, wrong digest, unknown/malformed); rejects on infrastructure failure |
| `AbaAuthorizedActionPackageSource` | same | document + stored digest for the exact id/version/scope; read-only |
| `AbaPackageConsumptionRecorder` | same | idempotent mirror via `AuthorizedActionPackageRepository.recordConsumed`; a mirror that cannot be written is a **result** (`NOT_RECORDABLE`: NOT_FOUND / DIGEST_MISMATCH / OTHER_TERMINAL_STATE / EXPIRED / OTHER_RECEIPT), because BO's claim is canonical |
| `recordConsumed` + `consumptionReceiptId` in `getAuthoritativeStatus` | `database` repository | appends the existing `CONSUMED` lifecycle fact (needs `consumption_receipt_id`); no migration |

## Authority verdict
`CURRENT` only on positive proof. `REVOKED` when the approver assignment was revoked / is inactive, the decision is no longer approved, or the enabled Level 2 policy no longer exists or no longer names the action type (**O-7**, fail closed). `UNVERIFIABLE` when a required fact cannot be established (missing/ambiguous/mismatched approval audit, no assignment, no assignment version or no active grant at the decision). `REVOKED` outranks `UNVERIFIABLE`. Lifecycle and authority are separate facts (a package can be `ISSUED` with authority `REVOKED`). Both are stamped with the ABA database clock; the lifecycle read is last so `verifiedAt` is not earlier than any fact it vouches for.

## Deliberately not done
- No production wiring, event, worker, consumer, route, migration or activation (P0-6b and later).
- "Owner-role ownership still proven" (planning §3) is not modelled as a separate fact: approver-assignment revocation already covers it; revisit only if a ruling defines an owner-role authority.
- Reads are individual statements inside one tenant transaction (READ COMMITTED), not a single MVCC snapshot; each is current, none is cached.

## Extension
P0-6b constructs these classes at the composition root with an ABA system actor; P0-6c calls the provider under the BO row locks (O-2: 5000 ms) and `validateForExecutionAfterClaim`.
