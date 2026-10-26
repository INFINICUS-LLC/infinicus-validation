import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { classifyOpenApiChange, compareContracts, unresolvedRefs } from './compare-zod-api-contract.mjs';

const fixture = JSON.parse(gunzipSync(await readFile(new URL('../../../docs/architecture/reconciliation/fixtures/ci-sec-2b1-zod3-api.json.gz', import.meta.url))).toString('utf8'));

test('Zod 3 baseline covers every published path and contains no broken local references', () => {
  assert.equal(Object.keys(fixture.openapi.paths).length, 116);
  assert.equal(fixture.pathRejections.length, 102);
  assert.equal(Object.keys(fixture.schemas).length, 224);
  assert.equal(Object.keys(fixture.edgeCases).length, 11);
  assert.equal(Object.keys(fixture.responses).length, 3);
  assert.deepEqual(unresolvedRefs(fixture.openapi), []);
  const same = compareContracts(fixture, fixture);
  assert.equal(same.openApi.total, 0);
  assert.equal(same.schemaProbes.acceptance.length, 0);
  assert.equal(same.requests.length, 0);
});

test('baseline runtime and documented security boundaries are pinned together', () => {
  const strictBody = fixture.openapi.paths['/v1/auth/identity-exchange'].post.requestBody.content['application/json'].schema;
  assert.equal(strictBody.additionalProperties, false);
  assert.equal(fixture.edgeCases['auth.js:identityExchangeBodySchema:foreignAuthority'].success, false);
  assert.ok(fixture.pathRejections.every(({ status, code }) => status === 400 && code === 'validation_error'));
  assert.equal(fixture.edgeCases['products.js:createProductBodySchema:unsafeSortOrder'].success, true);
  const productBody = fixture.openapi.paths['/v1/businesses/{businessId}/products'].post.requestBody.content['application/json'].schema;
  assert.equal(productBody.properties.sortOrder.type, 'integer');
  assert.equal(productBody.properties.sortOrder.maximum, undefined);
  assert.equal(fixture.responses.registerResponseSchema.internal, undefined);
});

test('an absent additionalProperties prohibition is classified as weaker documentation', () => {
  assert.equal(classifyOpenApiChange('#/requestBody/schema/additionalProperties', false, undefined), 'weaker');
  const changed = structuredClone(fixture);
  delete changed.openapi.paths['/v1/auth/identity-exchange'].post.requestBody.content['application/json'].schema.additionalProperties;
  const diff = compareContracts(fixture, changed);
  assert.equal(diff.openApi.classes.weaker, 1);
});

test('a dangling component reference is reported independently of normal schema differences', () => {
  const changed = structuredClone(fixture);
  changed.openapi.paths['/v1/auth/identity-exchange'].post.requestBody.content['application/json'].schema.$ref = '#/components/schemas/missing';
  assert.deepEqual(unresolvedRefs(changed.openapi).map(({ ref }) => ref), ['#/components/schemas/missing']);
});

test('stricter documented bounds and changed runtime acceptance cannot be normalized away', () => {
  assert.equal(classifyOpenApiChange('#/schema/maximum', undefined, Number.MAX_SAFE_INTEGER), 'stricter');
  const changed = structuredClone(fixture);
  changed.edgeCases['products.js:createProductBodySchema:unsafeSortOrder'] = { success: false, issues: [] };
  assert.deepEqual(compareContracts(fixture, changed).edgeCases, ['products.js:createProductBodySchema:unsafeSortOrder']);
});
