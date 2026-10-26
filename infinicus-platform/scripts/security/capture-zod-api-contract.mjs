#!/usr/bin/env node
// CI-SEC-2B.1: read-only contract fixture capture against a built local API.
// Usage: node scripts/security/capture-zod-api-contract.mjs OUTPUT [PLATFORM_ROOT]
import { readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const output = process.argv[2];
const platform = resolve(process.argv[3] ?? '.');
if (!output) throw new Error('Output path required');
const fromApi = createRequire(join(platform, 'apps/api/package.json'));
const { loadConfig } = await import(pathToFileURL(join(platform, 'packages/configuration/dist/index.js')));
const { createPool, closePool } = await import(pathToFileURL(join(platform, 'packages/database/dist/index.js')));
const { buildApp } = await import(pathToFileURL(join(platform, 'apps/api/dist/app.js')));
const { serializerCompiler } = fromApi('fastify-type-provider-zod');

function normalize(value) {
  if (value === undefined) return { $undefined: true };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, normalize(value[key])]),
  );
  return value;
}

const db = 'postgresql://contract:contract@127.0.0.1:1/contract';
createPool({ connectionString: db }); // No connection is opened by these probes.
const app = await buildApp(loadConfig({ DATABASE_URL: db, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
try {
  await app.ready();
  const openapi = normalize(app.swagger());
  const requests = [];
  const cases = [
    ['POST', '/v1/auth/identity-exchange', { accessToken: 'x'.repeat(21), tenantId: 'forged' }],
    ['POST', '/v1/auth/identity-exchange', { accessToken: 'short' }],
    ['POST', '/v1/auth/register', { email: 'invalid', password: 'secret' }],
    ['POST', '/v1/auth/login', { email: 'invalid', password: 'secret' }],
    ['POST', '/v1/auth/register', { email: 'a@example.com', password: 'secret', tenantId: 'forged' }],
    ['GET', '/v1/businesses/00000000-0000-4000-8000-000000000000/products?includeInactive=false'],
  ];
  for (const [method, url, payload] of cases) {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}), headers: { 'x-correlation-id': 'ci-sec-2b1-fixed' } });
    requests.push({ method, url, status: response.statusCode, body: normalize(response.json()) });
  }
  // Invalid UUID path parameters cannot invoke a business handler. Probe every
  // documented path with a UUID path parameter, including all HTTP methods.
  const pathRejections = [];
  for (const [path, methods] of Object.entries(openapi.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const uuidParam = (operation.parameters ?? []).find((p) => p.in === 'path' && p.schema?.format === 'uuid');
      if (!uuidParam) continue;
      const url = path.replaceAll(/\{[^}]+\}/g, 'not-a-uuid');
      const response = await app.inject({ method: method.toUpperCase(), url, headers: { 'x-correlation-id': 'ci-sec-2b1-fixed' } });
      pathRejections.push({ method, path, status: response.statusCode, code: response.json()?.error?.code ?? null });
    }
  }
  const schemas = {};
  const schemaDir = join(platform, 'apps/api/dist/schemas');
  for (const file of (await readdir(schemaDir)).filter((name) => name.endsWith('.js')).sort()) {
    const module = await import(pathToFileURL(join(schemaDir, file)));
    for (const [name, schema] of Object.entries(module).sort(([a], [b]) => a.localeCompare(b))) {
      if (!schema || typeof schema.safeParse !== 'function') continue;
      const probes = {};
      for (const [key, input] of Object.entries({ undefined, null: null, emptyObject: {}, emptyArray: [], sentinel: '__unexpected__' })) {
        const result = schema.safeParse(input);
        probes[key] = result.success
          ? { success: true, data: normalize(result.data) }
          : { success: false, issues: normalize(result.error.issues.map(({ code, path, message }) => ({ code, path, message }))) };
      }
      schemas[`${file}:${name}`] = probes;
    }
  }
  const edgeCases = {};
  const edgeInputs = [
    ['products.js', 'businessIdParamsSchema', 'legacyUuidShape', { businessId: '12345678-1234-1234-1234-123456789abc' }],
    ['products.js', 'createProductBodySchema', 'unsafeSortOrder', { name: 'Item', price: 1, sortOrder: Number.MAX_SAFE_INTEGER + 1 }],
    ['products.js', 'listProductsQuerySchema', 'falseString', { includeInactive: 'false' }],
    ['products.js', 'listProductsQuerySchema', 'default', {}],
    ['auth.js', 'identityExchangeBodySchema', 'foreignAuthority', { accessToken: 'x'.repeat(21), tenantId: 'forged' }],
    ['auth.js', 'identityExchangeBodySchema', 'valid', { accessToken: 'x'.repeat(21) }],
    ['auth.js', 'registerBodySchema', 'email', { email: 'a@example.com', password: 'secret' }],
    ['common.js', 'paginationQuerySchema', 'defaults', {}],
    ['common.js', 'paginationQuerySchema', 'numericStrings', { page: '2', pageSize: '10' }],
    ['orders.js', 'completeOrderBodySchema', 'defaults', {}],
    ['abaAuthoring.js', 'jsonValueSchema', 'recursiveValue', { nested: ['value', 1, null] }],
  ];
  for (const [file, name, caseName, input] of edgeInputs) {
    const module = await import(pathToFileURL(join(schemaDir, file)));
    const result = module[name].safeParse(input);
    edgeCases[`${file}:${name}:${caseName}`] = result.success
      ? { success: true, data: normalize(result.data) }
      : { success: false, issues: normalize(result.error.issues.map(({ code, path, message }) => ({ code, path, message }))) };
  }
  const responses = {};
  const samples = [
    ['auth.js', 'registerResponseSchema', { id: '00000000-0000-4000-8000-000000000001', email: 'a@example.com', status: 'active', internal: 'hidden' }],
    ['products.js', 'listProductsResponseSchema', { products: [{ id: '00000000-0000-4000-8000-000000000002', name: 'Item', price: 1.25, category: 'goods', icon: null, active: true, sortOrder: 1, internal: 'hidden' }] }],
    ['offlineSales.js', 'offlineSaleResponseSchema', { offlineSaleId: '00000000-0000-4000-8000-000000000003', clientSaleId: '00000000-0000-4000-8000-000000000004', outcome: 'needs_review', replayed: false, orderId: null, orderNumber: null, currencyCode: 'KWD', deviceTotalMinor: 1000, serverTotalMinor: null, differenceMinor: null, reviewReason: 'underpaid', internal: 'hidden' }],
  ];
  for (const [file, name, data] of samples) {
    const module = await import(pathToFileURL(join(schemaDir, file)));
    try { responses[name] = JSON.parse(serializerCompiler({ schema: module[name], method: 'GET', url: '/contract-probe', httpStatus: '200' })(data)); }
    catch (error) { responses[name] = { error: error.name, message: error.message }; }
  }
  const fixture = normalize({ version: 1, requests, pathRejections, schemas, edgeCases, responses, openapi });
  await writeFile(resolve(output), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(JSON.stringify({ paths: Object.keys(openapi.paths).length, pathRejections: pathRejections.length, schemas: Object.keys(schemas).length, edgeCases: Object.keys(edgeCases).length, responses: Object.keys(responses).length }));
} finally {
  await app.close();
  await closePool();
}
