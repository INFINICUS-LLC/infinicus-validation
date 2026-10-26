#!/usr/bin/env node
// CI-SEC-2B.1: classify a candidate's generated contract against the Zod 3 fixture.
// Exit 1 for any contract change requiring review; do not normalize away semantics.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function unresolvedRefs(document) {
  const missing = [];
  function walk(value, path = '#') {
    if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${path}/${i}`));
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string' && child.startsWith('#/')) {
        const found = child.slice(2).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
          .reduce((node, part) => node?.[part], document);
        if (found === undefined) missing.push({ path: `${path}/$ref`, ref: child });
      } else walk(child, `${path}/${key}`);
    }
  }
  walk(document);
  return missing;
}

export function classifyOpenApiChange(path, before, after) {
  const key = path.split('/').at(-1);
  if (key === 'pattern' && before === undefined) return 'stricter';
  if (['minimum', 'maximum', 'minLength', 'maxLength'].includes(key) && before === undefined) return 'stricter';
  if (key === 'additionalProperties') {
    if (before === false && after === undefined) return 'weaker';
    if (before === undefined && after === false) return 'stricter';
  }
  if (['format', 'type', 'required'].includes(key) && after === undefined) return 'weaker';
  if (key === '$ref' || ['anyOf', 'allOf', 'oneOf', 'nullable', 'enum', 'type', 'required', 'properties'].includes(key)) return 'breaking-or-unproven';
  return 'review';
}

export function openApiDifferences(before, after) {
  const differences = [];
  function walk(a, b, path = '#') {
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const next = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
        if (!(key in a) || !(key in b)) differences.push({ path: next, class: classifyOpenApiChange(next, a[key], b[key]), before: a[key], after: b[key] });
        else walk(a[key], b[key], next);
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) differences.push({ path, class: 'breaking-or-unproven', before: a.length, after: b.length });
      for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${path}/${i}`);
      return;
    }
    if (!same(a, b)) differences.push({ path, class: classifyOpenApiChange(path, a, b), before: a, after: b });
  }
  walk(before, after);
  return differences;
}

export function compareContracts(baseline, candidate) {
  const schemaProbes = { acceptance: [], parsedOutput: [], issueShape: [], messageOnly: [] };
  for (const [key, probes] of Object.entries(baseline.schemas)) {
    for (const [input, old] of Object.entries(probes)) {
      const next = candidate.schemas?.[key]?.[input];
      const label = `${key}:${input}`;
      if (!next || old.success !== next.success) schemaProbes.acceptance.push(label);
      else if (old.success && !same(old.data, next.data)) schemaProbes.parsedOutput.push(label);
      else if (!old.success && !same(old.issues.map(({ code, path }) => ({ code, path })), next.issues.map(({ code, path }) => ({ code, path })))) schemaProbes.issueShape.push(label);
      else if (!same(old, next)) schemaProbes.messageOnly.push(label);
    }
  }
  const edgeCases = Object.keys(baseline.edgeCases).filter((key) => !same(baseline.edgeCases[key], candidate.edgeCases?.[key]));
  const requests = baseline.requests.map((old, i) => ({ index: i, before: old, after: candidate.requests?.[i] }))
    .filter(({ before, after }) => !same(before, after));
  const pathRejections = baseline.pathRejections.map((old, i) => ({ index: i, before: old, after: candidate.pathRejections?.[i] }))
    .filter(({ before, after }) => !same(before, after));
  const responses = Object.keys(baseline.responses).filter((key) => !same(baseline.responses[key], candidate.responses?.[key]));
  const openApi = openApiDifferences(baseline.openapi, candidate.openapi);
  const openApiClasses = Object.fromEntries([...new Set(openApi.map((item) => item.class))].map((name) => [name, openApi.filter((item) => item.class === name).length]));
  return {
    coverage: { paths: Object.keys(candidate.openapi.paths ?? {}).length, pathRejections: candidate.pathRejections?.length,
      schemas: Object.keys(candidate.schemas ?? {}).length, edgeCases: Object.keys(candidate.edgeCases ?? {}).length },
    schemaProbes, edgeCases, requests, pathRejections, responses,
    openApi: { total: openApi.length, classes: openApiClasses, differences: openApi },
    unresolvedRefs: unresolvedRefs(candidate.openapi),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [basePath, candidatePath] = process.argv.slice(2);
  if (!basePath || !candidatePath) throw new Error('Usage: compare-zod-api-contract.mjs BASELINE CANDIDATE');
  const readContract = async (path) => {
    const bytes = await readFile(path);
    return JSON.parse((path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
  };
  const baseline = await readContract(basePath);
  const candidate = await readContract(candidatePath);
  const result = compareContracts(baseline, candidate);
  const { differences, ...openApi } = result.openApi;
  console.log(JSON.stringify({ coverage: result.coverage,
    schemaProbeCounts: Object.fromEntries(Object.entries(result.schemaProbes).map(([key, list]) => [key, list.length])),
    edgeCases: result.edgeCases, requestChanges: result.requests.length, pathRejectionChanges: result.pathRejections.length,
    responseChanges: result.responses, openApi, openApiExamples: differences.slice(0, 12), unresolvedRefs: result.unresolvedRefs }, null, 2));
  if (result.openApi.total || result.requests.length || result.edgeCases.length || result.schemaProbes.acceptance.length || result.schemaProbes.parsedOutput.length || result.unresolvedRefs.length) process.exitCode = 1;
}
