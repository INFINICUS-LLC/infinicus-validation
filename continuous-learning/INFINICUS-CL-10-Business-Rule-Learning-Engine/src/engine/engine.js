(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.businessRuleLearningEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.businessRuleLearningEnginePolicyModel.create(input);
    if(!built.ok) return built;
    return store.put("policies",built.data);
  }

  /* V-06 fail-closed gate (identical in CL-07..CL-24). Nothing defaults to accepted. */
  const VERIFIED_EVIDENCE_TYPES=Object.freeze(["observed","calculated","documentary","expert_review","contextual"]);
  const UNVERIFIED_CLASSES=Object.freeze(["ASSUMPTION_BASED","BENCHMARK_BASED","ESTIMATED","FORECAST","SIMULATION"]);
  const UNVERIFIED_SOURCES=Object.freeze(["manual_entry"]);
  function unitScore(value){
    return typeof value==="number" && Number.isFinite(value) && value>=0 && value<=1 ? value : null;
  }
  function nonEmpty(value){
    if(Array.isArray(value)) return value.length>0;
    return Boolean(value) && typeof value==="object" && Object.keys(value).length>0;
  }
  function evaluateGate(upstream,input,policy){
    const reasons=[];
    const confidence=unitScore(upstream.confidence!==undefined?upstream.confidence:input.confidence);
    const reliability=unitScore(upstream.reliability!==undefined?upstream.reliability:input.reliability);
    if(confidence===null) reasons.push("confidence_missing_or_invalid");
    if(reliability===null) reasons.push("reliability_missing_or_invalid");
    const evidence=upstream.learningEvidence||input.learningEvidence||[];
    const provenance=upstream.provenance||input.provenance||[];
    const findings=input.findings||upstream.findings||[];
    if(!nonEmpty(evidence)&&!nonEmpty(findings)) reasons.push("evidence_missing");
    if(!nonEmpty(provenance)) reasons.push("provenance_missing");
    for(const item of (Array.isArray(evidence)?evidence:[])){
      const type=item&&item.evidenceType;
      const cls=item&&(item.provenanceClass||item.evidenceClass);
      const source=item&&(item.sourceSystem==="manual_entry"||item.verificationStatus==="manual_entry"||item.source==="manual_entry");
      if(!VERIFIED_EVIDENCE_TYPES.includes(type)) reasons.push("evidence_type_unverified:"+String(type));
      if(cls!==undefined&&UNVERIFIED_CLASSES.includes(cls)) reasons.push("evidence_class_unverified:"+cls);
      if(source||UNVERIFIED_SOURCES.includes(item&&item.evidenceType)) reasons.push("evidence_manual_entry");
    }
    if(!Number.isFinite(policy.data.minimumConfidence)||!Number.isFinite(policy.data.minimumReliability)) reasons.push("policy_thresholds_invalid");
    const upstreamStatus=upstream.status;
    if(upstreamStatus!==undefined&&upstreamStatus!=="ready") reasons.push("upstream_not_ready:"+String(upstreamStatus));
    let status;
    if(reasons.length>0) status="insufficient_evidence";
    else if(confidence<policy.data.minimumConfidence||reliability<policy.data.minimumReliability) status="insufficient_evidence";
    else status=policy.data.requireHumanReview ? "review_required" : "accepted";
    return {status,confidence,reliability,reasons:Array.from(new Set(reasons)),evidence,provenance};
  }

  async function process(input={}){
    const policyId=input.businessRuleLearningEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      businessRuleLearningEngineRecordId:runtime.createId("cl_record"),
      block:"CL-10",
      purpose:"Generate governed business-rule updates from validated learning.",
      sourceBlock:"CL-09",
      status,
      blockedReasons:gate.reasons,
      confidence,
      reliability,
      learningEvidence:runtime.clone(gate.evidence),
      provenance:runtime.clone(gate.provenance),
      findings:runtime.clone(input.findings||upstream.findings||[]),
      recommendations:runtime.clone(input.recommendations||[]),
      conflicts:runtime.clone(input.conflicts||[]),
      assumptions:runtime.clone(input.assumptions||[]),
      updates:runtime.clone(input.updates||[]),
      correlationId:upstream.correlationId||input.correlationId||null,
      lineage:runtime.clone(upstream.lineage||input.lineage||[]),
      createdAt:new Date().toISOString()
    };

    await store.put("records",record);

    const handoff={
      decisionPolicyLearningHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-11",
      sourceBlock:"CL-10",
      sourceRecordId:record.businessRuleLearningEngineRecordId,
      record:runtime.clone(record),
      confidence,
      reliability,
      learningEvidence:runtime.clone(gate.evidence),
      provenance:runtime.clone(gate.provenance),
      blockedReasons:gate.reasons,
      correlationId:record.correlationId,
      lineage:record.lineage.map(runtime.clone),
      status:status==="accepted" ? "ready" : (status==="review_required" ? "pending_review" : "blocked"),
      createdAt:new Date().toISOString()
    };

    await store.put("handoffs",handoff);
    await runtime.emit("cl.business_rules.learn.completed",{sourceRecordId:record.businessRuleLearningEngineRecordId,handoffId:handoff.decisionPolicyLearningHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({businessRuleLearningEngineRecordId})=>store.get("records",businessRuleLearningEngineRecordId),
    getHandoff:({decisionPolicyLearningHandoffId})=>store.get("handoffs",decisionPolicyLearningHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.business_rule_learning_engine",api,{block:"CL-10"});

  runtime.registerRoute("cl.business_rule_learning_policy.register",registerPolicy);
  runtime.registerRoute("cl.business_rules.learn",process);

  global.INFINICUS.CL.businessRuleLearningEngine=api;
})(window);
