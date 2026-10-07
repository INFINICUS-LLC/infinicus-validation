// V-06 parity: root Continuous Learning (browser path: continuous-learning/cl-bundle.js)
// must fail CLOSED exactly like infinicus-platform/layers/continuous-learning (CL-07..CL-24).
// 1. root engine/policy sources are byte-identical to the platform target;
// 2. the deployed bundle contains each root source verbatim;
// 3. the root engines behave fail-closed (vm-loaded, stubbed runtime/store).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT_DIR = join(REPO, 'continuous-learning');
const PLATFORM_DIR = join(REPO, 'infinicus-platform/layers/continuous-learning/blocks');
const BUNDLE = readFileSync(join(ROOT_DIR, 'cl-bundle.js'), 'utf8');
const FILES = ['src/engine/engine.js', 'src/model/policy.js'];
const dirs = readdirSync(ROOT_DIR).filter((d) => /^INFINICUS-CL-(0[7-9]|1\d|2[0-4])-/.test(d)).sort();

test('covers CL-07..CL-24', () => assert.equal(dirs.length, 18));

test('root sources equal platform sources and are contained verbatim in cl-bundle.js', () => {
  for (const d of dirs) {
    for (const f of FILES) {
      const root = readFileSync(join(ROOT_DIR, d, f), 'utf8');
      assert.equal(root, readFileSync(join(PLATFORM_DIR, d, f), 'utf8'), `${d}/${f} diverges from platform`);
      assert.ok(BUNDLE.includes(root.trim()), `cl-bundle.js is stale for ${d}/${f}`);
    }
  }
});

function load(dir) {
  const engineSrc = readFileSync(join(ROOT_DIR, dir, 'src/engine/engine.js'), 'utf8');
  const policySrc = readFileSync(join(ROOT_DIR, dir, 'src/model/policy.js'), 'utf8');
  const storeName = /INFINICUS\.CL\.(\w+Store)/.exec(engineSrc)[1];
  const policyModel = /INFINICUS\.CL\.(\w+PolicyModel)/.exec(engineSrc)[1];
  const tables = new Map();
  const store = {
    put: async (t, v) => { tables.set(t + ':' + Object.values(v)[0], v); return { ok: true, data: v }; },
    get: async (t, id) => (tables.has(t + ':' + id) ? { ok: true, data: tables.get(t + ':' + id) } : { ok: false }),
    list: async () => ({ ok: true, data: [] }),
  };
  let n = 0;
  const runtime = {
    createId: (p) => `${p}_${++n}`, clone: (v) => JSON.parse(JSON.stringify(v)),
    success: (data) => ({ ok: true, data }), failure: (code, message) => ({ ok: false, code, message }),
    emit: async () => {}, registerService: () => {}, registerRoute: () => {},
  };
  const window = { INFINICUS: { CL: { runtime, [storeName]: store } } };
  window.window = window;
  vm.runInNewContext(policySrc, { window });
  vm.runInNewContext(engineSrc, { window });
  const key = Object.keys(window.INFINICUS.CL).find((k) => window.INFINICUS.CL[k]?.process);
  return { engine: window.INFINICUS.CL[key], policyModel: window.INFINICUS.CL[policyModel] };
}

const good = (over = {}) => ({
  confidence: 0.9, reliability: 0.9, learningEvidence: [{ learningEvidenceId: 'e1', evidenceType: 'observed' }],
  provenance: [{ learningEvidenceId: 'e1' }], correlationId: 'c', lineage: [], ...over,
});
const blocked = {
  'missing confidence': { confidence: undefined }, 'missing reliability': { reliability: undefined },
  'string confidence': { confidence: '0.9' }, 'out of range': { reliability: 1.5 },
  'no evidence': { learningEvidence: [] }, 'no provenance': { provenance: [] },
  'hypothesis': { learningEvidence: [{ evidenceType: 'hypothesis' }] },
  'manual entry': { learningEvidence: [{ evidenceType: 'observed', sourceSystem: 'manual_entry' }] },
  'simulation class': { learningEvidence: [{ evidenceType: 'observed', provenanceClass: 'SIMULATION' }] },
  'upstream blocked': { status: 'blocked' }, 'below threshold': { confidence: 0.1 },
};

async function run(dir, upstream, policyOver = {}) {
  const { engine, policyModel } = load(dir);
  const built = policyModel.create({ name: 'p', code: 'p', requireHumanReview: false, ...policyOver });
  const idKey = Object.keys(built.data).find((k) => k.endsWith('PolicyId'));
  await engine.registerPolicy(built.data);
  return (await engine.process({ [idKey]: built.data[idKey], upstreamHandoff: upstream })).data;
}

test('root CL-07..CL-24 fail closed', async () => {
  for (const d of dirs) {
    const ok = await run(d, good());
    assert.equal(ok.record.status, 'accepted', d);
    assert.equal(ok.handoff.status, 'ready', d);
    const review = await run(d, good(), { requireHumanReview: true });
    assert.equal(review.handoff.status, 'pending_review', d);
    for (const [label, over] of Object.entries(blocked)) {
      const out = await run(d, good(over));
      assert.notEqual(out.record.status, 'accepted', `${d}: ${label}`);
      assert.equal(out.handoff.status, 'blocked', `${d}: ${label}`);
    }
    assert.equal((await run(d, {})).handoff.status, 'blocked', `${d}: empty upstream`);
  }
});
