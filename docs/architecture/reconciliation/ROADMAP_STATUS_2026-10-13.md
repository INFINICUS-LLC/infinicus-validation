# Reconciled roadmap and status (2026-10-13)

Repo `main` at `97a84f3`, migrations `0001`–`0198`, no open PRs. Replaces the stale "Implementation status (2026-10-07)" line in `ARCHITECTURE_RECONCILIATION_PLAN.md` (preserved there as historical). Historical decisions are not rewritten. Criteria references (A–M) are the Master Architecture Guardrail Section XXII; evidence is in `COMPLETION_GAP_ASSESSMENT.md`. No new implementation sequence is invented: where the evidence does not support one, this document says so.
Status words follow the assessment vocabulary: every item is, at most, implemented/tested/merged; **nothing is deployed, live-migrated, activated or production-verified.**

## 1. COMPLETED (merged to main)
| Programme item | PRs / migrations | Criterion |
|---|---|---|
| P0-1 … P0-4 approval authority, risk policy, `risk_class`/`valid_until`, audit and acceptance | earlier PRs; P0-4 #45–#48 | E, J |
| P0-5 `AuthorizedActionPackage`, ABA authoring, BO evaluator (rule set `inventory-reorder-policy/v1.0.0`), simulation NOT_APPLICABLE amendment | P0-5 PRs up to #89 (e.g. #63, #69, #74, #86–#89); 0176–0182 | C, E |
| P0-6 sequence: planning (#90), freeze (#91, 0188), ABA ports (P0-6a), authorized-action pipeline (P0-6b), BO engine (P0-6c; 0191/0192), execution evidence and OM verification (P0-6d), controlled wiring and governed activation (P0-6e; 0195), path closure (P0-6f #98, CI repair #99), stranded-claim recovery (P0-6g #100), operator recovery control (P0-6h #101) | #90–#101 (P0-6.0 #91; data-capture Block E #92 landed between them) | F, G, H, I |
| Final execution-path audit | #102 | F, J |
| F1/F3 database authority hardening | #103, 0196 | B, J |
| Data capture A (0197, #104), B (0187), C (0183), D (0198, #105), E (0189) and follow-ups (0184, 0185, 0186) | #78–#105 | A, B |
| Live-database readiness, environment and production-target discovery | #106–#108 | K |
| Read-only discovery script, migration runbook 0171–0198, canonical 0170 fingerprint | #109, #111 | K |
| Deployment hardening (build SHA in `/v1/health`, `grant-app-role.sh` in redeploy) | #110 | L |
| Off-VM backup tooling, restore-proof with expectations profile, retention doc correction | #112, #113 | L |
| Parked-items register | #114 | — |

## 2. OPEN / BLOCKED (evidence-backed)
| Item | Why open | Blocked by | Criterion |
|---|---|---|---|
| Controlled production migration 0171–0198 | production at 0170 (owner-reported, fingerprint-matched) | backup + restore proof (parked), findings A–D, runbook entry criteria E1–E14, explicit authorization | K |
| Worker role provisioning (`infinicus_worker_discovery`) | F4: documented, not provisioned | owner confirmation of conflict C-3; deployment | F, L |
| Worker deployment | worker not deployed | F4, migration | F, L |
| Production activation | OFF by design | migration, worker, backup, alerting, explicit owner activation | — |
| Backup operationalization (bucket, key, install, first backup, verification, restore proof, timer) | tooling only | parked items 1–7, 9 | L |
| AWS / GPG setup and evidence | nothing reported | owner (parked items 1–4) | L |
| External alerting | channel undecided | owner decision | L |
| Retention policy | not approved; no lifecycle rules allowed | owner | L |
| Observability for execution failures and stranded work | `infrastructure/monitoring/` is a README; no metric/alert wiring evidenced | design decision (not authorized) | L |
| Remaining audit scope (live DB, frontend, ADI/SIM/LLM internals, dependencies; performance optional) | classified in the assessment §6 | owner sequencing | J, K |
| CI diagnosability (F6) | small PR never built | not requested | — |
| Criterion A: end-to-end ingestion of the data the first action needs | not evidenced | owner decision on next block | A, M |
| Criteria C/D/M: simulation ruling (C-1), ADI recommendation producer for the first action (C-2) | owner rulings needed | owner | C, D, M |
| Criterion J scope (legacy browser surface V-04/V-05, plan item P3-A) | no completion evidence | owner scope ruling | J |
| P0-4 owner confirmation D3 | recorded as outstanding at P0-4 acceptance; closure not evidenced | confirm or record | E |
| Residual items: P0-6g/6h future extensions (bounded re-arm of gate-deferred recovery, held-claims listing), 0196 NOLOGIN owner follow-up (P3) | optional hardening | owner | — |

Older plan items (Phase 10: P1-A … P1-F, P2-A … P2-E, P3, P4) are **not re-scoped here**. Each still reads "needs its own approval" and their relation to Section XXII is only partly evidenced (e.g. P1-D, ExecutionEvidence, is done by P0-6d; P2-A, server-side CL ingestion, is outside Section XII's scope). They are listed as historical, not as a sequence.

## 3. PARKED (owner, #114 — each item exactly as registered; none started)
1. AWS: separate account, bucket (Block Public Access, ACLs disabled, Versioning, Object Lock at creation, SSE-S3, TLS-only policy, no lifecycle rules), writer and recovery IAM users.
2. GPG: generate the key off production, two protected recovery copies, revocation certificate, send the 40-hex fingerprint.
3. AWS + GPG evidence review.
4. Hetzner Cloud Console evidence: Backups enabled YES/NO, latest backup time, snapshots and times.
5. VM: install AWS CLI v2 and the public key only (dedicated `BACKUP_GNUPGHOME`), `/etc/infinicus/backup.env`.
6. Supervised `backup-offsite.sh --check`, then the first backup (`BACKUP_LABEL=first-proof`).
7. Independent verification and `restore-proof.sh` against a throwaway PostgreSQL 16 → `RESTORE_PROOF=PASS`.
8. External alerting channel (D6).
9. Enable the daily 02:30 UTC timer (only after 6 and 7 succeed).
10. Retention policy approval (no lifecycle deletion until then).
11. Pre-migration backup and restore proof, controlled migration 0171–0198, grants, deployment (worker not started), post-checks.
12. `oci` compose `GIT_SHA` build-arg parity and identifying the deployed application SHA.
Rule (unchanged): resume only on an explicit owner instruction naming the item.

## 4. The next block
**NO NEXT BLOCK AUTHORIZED.** The repository supports no single next block at ≥90% confidence.
- Reason: the guardrail's completion criteria A, C, D, J and M depend on owner rulings the repository does not contain (simulation C-1, ADI producer C-2, scope of J), and the only remaining non-parked build candidates (criterion A ingestion proof; criterion L observability for stranded work) are not selected by any document.
- Candidates, not recommendations: (i) an ADI/DAL end-to-end proof for the first action's data, if the owner rules that D and A require it; (ii) stranded-work observability, if the owner rules L requires it before activation; (iii) any parked item, on explicit instruction.
- Minimum owner decisions: (1) rule C-1 and C-2; (2) rule the scope of J; (3) say whether to resume the parked production track now or after the architecture criteria; (4) decide the live-database findings A–D when the migration track resumes.
- Must not start: any build that cannot be tied to a Section XXII criterion (Section XXVII.6), anything in Section XXIII, any parked item, any production, AWS, GPG, role or secret change, owner backfill, live migration, deployment, worker start or activation.
