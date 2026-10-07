// V-06: Continuous Learning must fail CLOSED (CL-07..CL-24 engines).
// Missing/invalid confidence, reliability, evidence, provenance, unverified
// evidence classification or an unready upstream handoff must never yield
// "accepted" or a "ready" handoff.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const blocksDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dirs = readdirSync(blocksDir).filter((d) => /^INFINICUS-CL-(0[7-9]|1\d|2[0-4])-/.test(d)).sort();
assert.equal(dirs.length, 18, "CL-07..CL-24 must all be covered");

function load(dir) {
  const engineSrc = readFileSync(join(blocksDir, dir, "src/engine/engine.js"), "utf8");
  const policySrc = readFileSync(join(blocksDir, dir, "src/model/policy.js"), "utf8");
  const storeName = /INFINICUS\.CL\.(\w+Store)/.exec(engineSrc)[1];
  const policyModel = /INFINICUS\.CL\.(\w+PolicyModel)/.exec(engineSrc)[1];
  const tables = new Map();
  const store = {
    put: async (t, v) => { tables.set(t + ":" + Object.values(v)[0], v); return { ok: true, data: v }; },
    get: async (t, id) => (tables.has(t + ":" + id) ? { ok: true, data: tables.get(t + ":" + id) } : { ok: false }),
    list: async () => ({ ok: true, data: [] }),
  };
  let n = 0;
  const services = {};
  const runtime = {
    createId: (p) => `${p}_${++n}`,
    clone: (v) => JSON.parse(JSON.stringify(v)),
    success: (data) => ({ ok: true, data }),
    failure: (code, message) => ({ ok: false, code, message }),
    emit: async () => {},
    registerService: () => {},
    registerRoute: (name, fn) => { services[name] = fn; },
  };
  const window = { INFINICUS: { CL: { runtime, [storeName]: store } } };
  window.window = window;
  vm.runInNewContext(policySrc, { window });
  vm.runInNewContext(engineSrc, { window });
  const engineKey = Object.keys(window.INFINICUS.CL).find((k) => window.INFINICUS.CL[k]?.process);
  return { engine: window.INFINICUS.CL[engineKey], policyModel: window.INFINICUS.CL[policyModel] };
}

const goodEvidence = () => [{ learningEvidenceId: "e1", evidenceType: "observed" }];
const goodUpstream = (over = {}) => ({
  confidence: 0.9, reliability: 0.9, learningEvidence: goodEvidence(),
  provenance: [{ learningEvidenceId: "e1", sourceSystem: "OM-24" }], correlationId: "c1", lineage: [], ...over,
});

async function run(dir, upstream, policyOver = {}) {
  const { engine, policyModel } = load(dir);
  const built = policyModel.create({ name: "p", code: "p", requireHumanReview: false, ...policyOver });
  assert.equal(built.ok, true);
  const idKey = Object.keys(built.data).find((k) => k.endsWith("PolicyId"));
  assert.equal((await engine.registerPolicy(built.data)).ok, true);
  const out = await engine.process({ [idKey]: built.data[idKey], upstreamHandoff: upstream });
  assert.equal(out.ok, true);
  return out.data;
}

const blockedCases = {
  "missing confidence": { confidence: undefined },
  "missing reliability": { reliability: undefined },
  "NaN confidence": { confidence: NaN },
  "string confidence": { confidence: "0.9" },
  "out-of-range reliability": { reliability: 1.5 },
  "no evidence": { learningEvidence: [] },
  "no provenance": { provenance: [] },
  "hypothesis evidence": { learningEvidence: [{ evidenceType: "hypothesis" }] },
  "unknown evidence type": { learningEvidence: [{ evidenceType: "anything" }] },
  "manual entry evidence": { learningEvidence: [{ evidenceType: "observed", sourceSystem: "manual_entry" }] },
  "simulation class evidence": { learningEvidence: [{ evidenceType: "observed", provenanceClass: "SIMULATION" }] },
  "blocked upstream": { status: "blocked" },
  "pending_review upstream": { status: "pending_review" },
  "below threshold": { confidence: 0.1 },
};

for (const dir of dirs) {
  const ok = await run(dir, goodUpstream());
  assert.equal(ok.record.status, "accepted", `${dir}: complete evidence is accepted when review not required`);
  assert.equal(ok.handoff.status, "ready", dir);
  assert.equal(ok.handoff.learningEvidence.length, 1, `${dir}: evidence must propagate`);
  assert.equal(ok.handoff.provenance.length, 1, `${dir}: provenance must propagate`);

  const review = await run(dir, goodUpstream(), { requireHumanReview: true });
  assert.equal(review.record.status, "review_required", dir);
  assert.equal(review.handoff.status, "pending_review", `${dir}: review_required is never ready`);

  for (const [label, over] of Object.entries(blockedCases)) {
    const out = await run(dir, goodUpstream(over));
    assert.notEqual(out.record.status, "accepted", `${dir}: ${label} must not be accepted`);
    assert.equal(out.handoff.status, "blocked", `${dir}: ${label} must block the handoff`);
  }

  const bare = await run(dir, {});
  assert.equal(bare.handoff.status, "blocked", `${dir}: empty upstream must block`);
  assert.ok(bare.record.blockedReasons.length >= 3, dir);

  const { policyModel } = load(dir);
  assert.equal(policyModel.create({ name: "p", code: "p" }).data.requireHumanReview, true, `${dir}: review required by default`);
}

// Static guard: no confidence/reliability fallback may be reintroduced.
for (const dir of dirs) {
  const src = readFileSync(join(blocksDir, dir, "src/engine/engine.js"), "utf8");
  assert.equal(/\?\?\s*0\.7/.test(src), false, `${dir}: confidence/reliability default reintroduced`);
  assert.equal(/status==="accepted"\|\|status==="review_required" \? "ready"/.test(src), false, `${dir}: review_required must not be ready`);
}
console.log("V-06 fail-closed tests passed for", dirs.length, "blocks.");
