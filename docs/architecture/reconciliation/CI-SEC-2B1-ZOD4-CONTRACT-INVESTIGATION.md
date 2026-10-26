# CI-SEC-2B.1 — Zod 4 API contract preservation investigation

Date: 2026-10-26 (Kuwait). Baseline: fetched authoritative `main` `fb34dcd2eb288800ab269757b44b794df56f74c0`. References: CI-SEC-2A assessment `9a9aeaeecdb18c8976820397b397d0dc7547844a` and the CI-SEC-2B stop report. **Recommendation: conditional; do not implement the dependency migration yet.**

## Reproducible baseline and scope

`infinicus-platform/scripts/security/capture-zod-api-contract.mjs` builds a local application against an unreachable synthetic database URL and writes a deterministic fixture. The committed Zod 3 fixture is `fixtures/ci-sec-2b1-zod3-api.json.gz` (SHA-256 of the decompressed JSON: `36073d16c72007ccfea66b3ee336af9b8a1f61a62554b961ea72ae2a93c25cbd`). Two consecutive captures were byte-identical. It contains the complete generated OpenAPI document (116 paths), six selected public request/error results, 102 invalid-UUID path probes (all returned `400 validation_error` without invoking business handlers), five uniform parse probes for each of 224 exported API Zod schemas, 11 security/compatibility edge cases, and three representative response-serializer outputs. It captures every published route and exported schema, but five uniform values do not prove every accepted payload or all successful route responses. No production data or connection was used.

Reproduce after building the API and its workspace dependencies:

```sh
node infinicus-platform/scripts/security/capture-zod-api-contract.mjs /tmp/zod-api-current.json infinicus-platform
node infinicus-platform/scripts/security/compare-zod-api-contract.mjs \
  docs/architecture/reconciliation/fixtures/ci-sec-2b1-zod3-api.json.gz /tmp/zod-api-current.json
node --test infinicus-platform/scripts/security/compare-zod-api-contract.test.mjs
```

The comparator returns nonzero for any captured public contract change. Its negative tests prove that it reports a removed `additionalProperties: false`, dangling `$ref`, stricter bound and runtime acceptance change rather than normalizing them away.

## Provider trials

The same capture was run against separate temporary dependency trials: `fastify-type-provider-zod@6.1.0` and `@7.0.0`, each with `zod@4.6.7`. Thirteen actual one-argument API `z.record` calls were temporarily changed to explicit string keys so the trials would build. The CI-SEC-2A figure of 21 included existing two-argument calls. Both candidates compiled the API and passed isolated strict-object, default, response-stripping and OpenAPI probes; both have satisfied declared peers with the installed Fastify/Swagger versions. Temporary manifest, lockfile and source edits were restored; no dependency migration is committed.

| Differential measure | Provider 6.1.0 | Provider 7.0.0 |
| --- | ---: | ---: |
| Published paths / invalid path probes / schema exports / edge cases | 116 / 102 / 224 / 11 | 116 / 102 / 224 / 11 |
| Changed selected HTTP responses | 4 message-only; status/code unchanged | 4 message-only; status/code unchanged |
| Changed invalid path results / sampled serialized responses | 0 / 0 | 0 / 0 |
| Uniform schema probe acceptance or parsed-output changes | 0 | 0 |
| Schema issue code/path changes; message-only changes | 37; 1,021 | 37; 1,021 |
| Changed edge cases | 3 | 3 |
| OpenAPI keyword/element differences | 818 | 822 |
| Unresolved local OpenAPI references | 5 | 5 |

The 37 issue-shape changes concern Zod error issue codes/paths, not the tested success/failure decisions. The 1,021 message-only changes remain relevant because the API currently returns Fastify's validation `error.message` to callers.

Provider 7 is the better **investigation candidate**, despite four more raw OpenAPI differences: its `createJsonSchemaTransform({ zodToJsonConfig: { override } })` hook was measured to restore default object `additionalProperties: false` for both input and output in a synthetic test. Provider 6 ignored that custom override for an input object in the same probe. Provider 7 also supports a named recursive Zod registry with `jsonSchemaTransformObject`: a synthetic registered `JsonValue` produced resolvable `JsonValueInput` and `JsonValue` components. These probes do not certify application-wide semantic equivalence.

## Complete OpenAPI difference classification

The comparator walks every property and array element of the full generated document; it keeps changed values and references visible. There were no changed published path names and no observed `required` or `default` keyword differences. The counts below account for all observed differences.

| Class | 6.1.0 | 7.0.0 | Finding |
| --- | ---: | ---: | --- |
| Stricter documentation | 751 | 751 | 503 added `pattern` constraints, 130 added `maximum`, 117 added `minimum`, one added `additionalProperties: false`. These cannot be dismissed as cosmetic: UUID and integer runtime acceptance also changed. |
| Weaker documentation | 43 | 43 | 35 removed `additionalProperties: false`, four removed `format`, four removed `type` (notably date/coercion inputs). The removed unknown-field declarations are a public documentation change even though ordinary Zod objects strip unknown inputs. |
| Breaking or semantic equivalence unproven | 19 | 26 | Recursive `anyOf` changed to `$ref`/`allOf`; null/nullable/enum/type representation changed on 204 and billing responses; one object shape changed. **Five generated `$ref`s target missing `schema0`/`schema0Input` components in both candidates.** |
| Requires manual review | 5 | 2 | Remaining null-enum values changed from string `"null"` to JSON null. They may correct an old documentation defect but require explicit API contract review. |

The five dangling references occur in the authorized-action capture/boundaries request schemas using recursive `jsonValueSchema` in `apps/api/src/schemas/abaAuthoring.ts`. Neither candidate's unmodified application OpenAPI is safe to publish. Registry naming and component generation solve this in a synthetic provider-7 probe, but the resulting recursive public schema is stronger than Zod 3's fallback-to-`any` representation and needs a semantic approval check. Provider 7's null conversion is more compact in some billing schemas; compactness alone is not equivalence proof. The baseline itself contains no unresolved local references.

## Runtime validation and public error compatibility

Four selected public validation messages changed while retaining `400`, `validation_error` and the same correlation-ID envelope:

| Case | Zod 3 message | Both Zod 4 candidates |
| --- | --- | --- |
| Unexpected identity field | `body/ Unrecognized key(s) in object: 'tenantId'` | `body/ Unrecognized key: "tenantId"` |
| Short identity token | `body/accessToken String must contain at least 20 character(s)` | `body/accessToken Too small: expected string to have >=20 characters` |
| Invalid registration/login email | `body/email Invalid email` | `body/email Invalid email address` |

These messages are public because `apps/api/src/plugins/errorHandler.ts` sends `error.message` for validation errors. Provider 4 constructs Fastify validation messages from Zod 3 issues; providers 6/7 use Zod 4 issues. A compatibility formatter must work from validated issue code/path/metadata, never echo submitted values or `issue.input`, and must be tested over real route errors, not only these four examples. Exact general equivalence is **unproven** given 1,021 message changes and 37 issue-shape changes.

Two edge cases changed actual acceptance in both candidates:

1. `apps/api/src/schemas/products.ts` business UUID parameter: Zod 3 accepts `12345678-1234-1234-1234-123456789abc`; Zod 4 `.uuid()` rejects it. A synthetic Zod 4 `.guid()` accepts that sample, but parity for all previously accepted IDs and generated `format: uuid` remains to be proven. There are 213 `z.string().uuid()` call sites across API schemas.
2. `createProductBodySchema.sortOrder` accepts `9007199254740992` under Zod 3 `.number().int()` and rejects it under Zod 4. The old OpenAPI says `integer` without a maximum; Zod 4 adds a safe-integer maximum. There are 88 `.number().int()` calls in API schemas, not all of them public inputs. A replacement integer refinement must preserve the existing contract or obtain explicit approval for tightening; financial and count fields must not be weakened by a blanket helper.

The selected `z.coerce.boolean()` `"false"` behavior, default values, strict identity refusal, 102 invalid path refusals, and three sampled response outputs matched. This is limited evidence, not a complete response-serialization or tenant-authorization proof. The baseline's generic UUID `format` can already be interpreted more strictly by external tooling than Zod 3 accepts; the implementation must resolve that mismatch deliberately.

## Proposed minimum correction and gates

1. Start from provider 7 in a separate implementation branch. Add the 13 explicit-key `z.record` adaptations. Keep provider 6 as a comparison control until a full API regression shows provider 7 is no worse. No provider selection is final yet.
2. In `apps/api/src/schemas/abaAuthoring.ts` and `apps/api/src/app.ts`, investigate a stable named recursive `JsonValue` registration plus `jsonSchemaTransformObject`. Require a valid OpenAPI parser, zero unresolved references and approved semantics for recursive values before adopting it.
3. Use provider 7's controlled JSON-Schema override only when it reflects real Zod runtime behavior. Restore `additionalProperties: false` for object schemas where the Zod 3 document had it. Do not remove UUID patterns or integer bounds merely to make a diff green; first restore and test the corresponding runtime acceptance or obtain a versioned contract decision.
4. Introduce narrowly scoped compatibility schemas for legacy UUID and integer behavior where the baseline requires them. Prove edge equivalence across generated and adversarial values, especially auth, tenant scope, offline sales, amounts and versions. Explicitly decide whether unsafe integer acceptance is a contract to preserve or an owner-approved hardening change.
5. In `apps/api/src/plugins/errorHandler.ts`, consider a versioned legacy validation-message formatter that only uses safe issue metadata. Differentially test all public 400 envelopes and ensure no token, password or tenant secret reaches the client. Preserve the existing generic 500 path.
6. Run this fixture comparator, endpoint-specific valid/invalid and authorization tests, response serialization, OpenAPI parser/semantic checks, web parsers, all typechecks/builds, disposable PostgreSQL, architecture tests, and dependency scan. Add representative successful responses beyond the three sampled here. Do not merge until all public-diff cases are resolved or separately ratified.

**Residual decision:** whether generic UUID shapes and unsafe integers must remain accepted, and whether the recursive OpenAPI correction may replace the previous permissive fallback. These are contract/security decisions; this investigation does not ratify them. No dependency, application behavior, frozen specification, migration 0219, production system or security gate was changed in this block.
