# V-06 — Continuous Learning fails CLOSED

Scope: platform target copies `infinicus-platform/layers/continuous-learning/blocks/CL-07..CL-24` (engine.js + policy.js). Locked CL spec unchanged.

## Before
- `confidence`/`reliability` defaulted to `0.7` when absent, so an evidence-free package passed the 0.5 thresholds and became `accepted`.
- `requireHumanReview` defaulted to `false`.
- `review_required` produced a `ready` handoff; upstream `status` was never checked.
- Evidence and provenance were not required and were dropped between blocks.

## After (identical gate in each of the 18 engines)
`insufficient_evidence` / handoff `blocked` (with `blockedReasons`) unless ALL hold:
- confidence and reliability are finite numbers in [0,1] (no defaults, strings rejected) and meet policy minimums; policy thresholds are finite.
- non-empty evidence (`learningEvidence` or `findings`) and non-empty `provenance`.
- every evidence item has a verified type (observed, calculated, documentary, expert_review, contextual); `hypothesis`, unknown types, `manual_entry`, and provenance classes ASSUMPTION_BASED / BENCHMARK_BASED / ESTIMATED / FORECAST / SIMULATION never pass.
- any upstream `status` is `ready`.
Review: `requireHumanReview` now defaults to `true`; `review_required` yields handoff `pending_review`, never `ready`; only `accepted` yields `ready`. Evidence and provenance now propagate through every handoff.

## Not changed (owner decision needed)
- Root copies (`/continuous-learning/*`, deployed `cl-bundle.js`) are untouched and still fail open. They diverge from the platform target.
- CI does not run the layer package tests; gating `test/…/v06-fail-closed.test.mjs` needs `--filter=@infinicus/layer-continuous-learning` in ci.yml (not changed).
- CL-01..CL-06 and CL-25 unchanged; CL-02 already rejects missing confidence.

## Tests
`blocks/INFINICUS-CL-25-*/tests/v06-fail-closed.test.mjs` (vm-loaded, 18 blocks × 14 blocked cases + accepted/review paths + static guard). Mutation-proven: reintroducing the 0.7 default, removing the evidence check, or letting review_required be ready each fails the test.
Run: `cd infinicus-platform/layers/continuous-learning && npm test`.
