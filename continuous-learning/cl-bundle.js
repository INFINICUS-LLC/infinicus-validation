/* CL LAYER BUNDLE */
/* Auto-generated — do not edit directly */
/* Contains: INFINICUS-CL-01 through INFINICUS-CL-25 */


/* ===== INFINICUS-CL-01-Continuous-Learning-Core-Runtime-Registry ===== */

/* --- continuous-learning/INFINICUS-CL-01-Continuous-Learning-Core-Runtime-Registry/src/runtime/core-runtime.js --- */
(function(global){
  "use strict";

  global.INFINICUS=global.INFINICUS || {};
  global.INFINICUS.CL=global.INFINICUS.CL || {};

  const services=new Map();
  const routes=new Map();
  const policies=new Map();
  const learningStates=new Map();
  const listeners=new Map();
  const runtimeEvents=[];

  function clone(value){
    if(value===undefined) return undefined;
    return structuredClone(value);
  }

  function freeze(value){
    if(value && typeof value==="object"){
      Object.freeze(value);
      for(const key of Object.keys(value)){
        const child=value[key];
        if(
          child &&
          typeof child==="object" &&
          !Object.isFrozen(child)
        ){
          freeze(child);
        }
      }
    }
    return value;
  }

  function createId(prefix="cl"){
    const random=
      global.crypto?.randomUUID?.() ||
      `${Date.now()}_${Math.random().toString(16).slice(2)}`;

    return `${prefix}_${random}`;
  }

  function success(data,meta={}){
    return {
      ok:true,
      data:clone(data),
      meta:{
        timestamp:new Date().toISOString(),
        ...clone(meta)
      }
    };
  }

  function failure(code,message,details={}){
    return {
      ok:false,
      error:{
        code:String(code || "CL_UNKNOWN_ERROR"),
        message:String(message || "Unknown Continuous Learning error."),
        details:clone(details)
      },
      meta:{
        timestamp:new Date().toISOString()
      }
    };
  }

  async function emit(eventName,payload={}){
    const event={
      eventId:createId("cl_event"),
      eventName:String(eventName),
      payload:clone(payload),
      emittedAt:new Date().toISOString()
    };

    runtimeEvents.push(event);

    const handlers=listeners.get(eventName) || [];

    for(const handler of handlers){
      await handler(clone(event));
    }

    return success(event);
  }

  function on(eventName,handler){
    if(typeof handler!=="function"){
      return failure(
        "CL_EVENT_HANDLER_INVALID",
        "Event handler must be a function."
      );
    }

    const handlers=listeners.get(eventName) || [];
    handlers.push(handler);
    listeners.set(eventName,handlers);

    return success({
      eventName,
      handlerCount:handlers.length
    });
  }

  function registerService(name,service,metadata={}){
    if(!name || !service){
      return failure(
        "CL_SERVICE_INVALID",
        "Service name and implementation are required."
      );
    }

    if(services.has(name)){
      return failure(
        "CL_SERVICE_DUPLICATE",
        `Service is already registered: ${name}`
      );
    }

    const record=freeze({
      name:String(name),
      service,
      metadata:clone(metadata),
      registeredAt:new Date().toISOString()
    });

    services.set(name,record);

    emit("cl.runtime.service_registered",{
      name,
      metadata
    });

    return success({
      name,
      metadata:record.metadata
    });
  }

  function getService(name){
    const record=services.get(name);

    return record
      ? record.service
      : null;
  }

  function registerRoute(name,handler,metadata={}){
    if(!name || typeof handler!=="function"){
      return failure(
        "CL_ROUTE_INVALID",
        "Route name and handler function are required."
      );
    }

    if(routes.has(name)){
      return failure(
        "CL_ROUTE_DUPLICATE",
        `Route is already registered: ${name}`
      );
    }

    routes.set(name,freeze({
      name:String(name),
      handler,
      metadata:clone(metadata),
      registeredAt:new Date().toISOString()
    }));

    emit("cl.runtime.route_registered",{
      name,
      metadata
    });

    return success({name});
  }

  function getRoute(name){
    return routes.get(name)?.handler || null;
  }

  async function invoke(name,input={}){
    const route=routes.get(name);

    if(!route){
      return failure(
        "CL_ROUTE_NOT_FOUND",
        `Route was not found: ${name}`
      );
    }

    try{
      return await route.handler(clone(input));
    }catch(error){
      return failure(
        "CL_ROUTE_EXECUTION_FAILED",
        error?.message || "Route execution failed.",
        {name}
      );
    }
  }

  function registerPolicy({
    policyId,
    policyType,
    policy
  }={}){
    if(!policyId || !policyType || !policy){
      return failure(
        "CL_POLICY_INVALID",
        "Policy ID, type, and policy are required."
      );
    }

    const key=`${policyType}:${policyId}`;

    if(policies.has(key)){
      return failure(
        "CL_POLICY_DUPLICATE",
        `Policy is already registered: ${key}`
      );
    }

    const record=freeze({
      policyId:String(policyId),
      policyType:String(policyType),
      policy:clone(policy),
      registeredAt:new Date().toISOString()
    });

    policies.set(key,record);

    return success(record);
  }

  function getPolicy(policyType,policyId){
    const record=policies.get(`${policyType}:${policyId}`);
    return record ? clone(record) : null;
  }

  function registerLearningState(input={}){
    const learningStateId=
      input.learningStateId ||
      createId("cl_learning_state");

    const record=freeze({
      learningStateId,
      learningPackageId:input.learningPackageId || null,
      state:String(input.state || "received"),
      confidence:
        input.confidence==null
          ? null
          : Number(input.confidence),
      reliability:
        input.reliability==null
          ? null
          : Number(input.reliability),
      correlationId:input.correlationId || null,
      updatedAt:new Date().toISOString()
    });

    learningStates.set(learningStateId,record);

    emit("cl.runtime.learning_state_registered",record);

    return success(record);
  }

  function getLearningState(learningStateId){
    const record=learningStates.get(learningStateId);

    return record
      ? success(record)
      : failure(
          "CL_LEARNING_STATE_NOT_FOUND",
          "Learning state was not found.",
          {learningStateId}
        );
  }

  function diagnose(){
    return success({
      layer:"Continuous Learning",
      version:"1.0.0",
      namespace:"window.INFINICUS.CL",
      serviceCount:services.size,
      routeCount:routes.size,
      policyCount:policies.size,
      learningStateCount:learningStates.size,
      eventCount:runtimeEvents.length,
      status:"healthy"
    });
  }

  const runtime=Object.freeze({
    version:"1.0.0",
    layer:"Continuous Learning",
    createId,
    clone,
    freeze,
    success,
    failure,
    emit,
    on,
    registerService,
    getService,
    registerRoute,
    getRoute,
    invoke,
    registerPolicy,
    getPolicy,
    registerLearningState,
    getLearningState,
    diagnose,
    services,
    routes,
    policies,
    learningStates
  });

  global.INFINICUS.CL.runtime=runtime;

  runtime.registerService(
    "cl.runtime",
    runtime,
    {block:"CL-01"}
  );

  runtime.registerRoute(
    "cl.runtime.diagnose",
    diagnose,
    {block:"CL-01"}
  );
})(window);

/* --- continuous-learning/INFINICUS-CL-01-Continuous-Learning-Core-Runtime-Registry/src/runtime/manifest.js --- */
(function(global){
  "use strict";

  const runtime=global.INFINICUS.CL.runtime;

  const manifest=runtime.freeze({
    block:"CL-01",
    name:"Continuous Learning Core Runtime and Registry",
    version:"1.0.0",
    namespace:"window.INFINICUS.CL",
    publicAPI:"window.INFINICUS.CL.runtime",
    inputBoundary:"OM-24",
    nextBlock:"CL-02",
    responsibilities:[
      "service registry",
      "route registry",
      "event bus",
      "policy registry",
      "learning-state registry",
      "diagnostics"
    ]
  });

  global.INFINICUS.CL.manifest=manifest;

  runtime.registerRoute(
    "cl.runtime.manifest",
    ()=>runtime.success(manifest),
    {block:"CL-01"}
  );
})(window);

/* ===== INFINICUS-CL-02-Learning-Package-Intake-Validation-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-02-Learning-Package-Intake-Validation-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";

  const CL=global.INFINICUS?.CL;

  if(!CL?.runtime){
    throw new Error("CL-01 must be loaded before CL-02.");
  }
})(window);

/* --- continuous-learning/INFINICUS-CL-02-Learning-Package-Intake-Validation-Engine/src/model/intake-policy.js --- */
(function(global){
  "use strict";

  function create(input={}){
    const runtime=global.INFINICUS.CL.runtime;

    if(!input.name || !input.code){
      return runtime.failure(
        "CL_INTAKE_POLICY_INVALID",
        "Intake policy name and code are required."
      );
    }

    return runtime.success({
      learningIntakePolicyId:
        input.learningIntakePolicyId ||
        runtime.createId("cl_intake_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:
        Math.max(0,Math.min(1,Number(input.minimumConfidence ?? 0.5))),
      minimumReliability:
        Math.max(0,Math.min(1,Number(input.minimumReliability ?? 0.5))),
      requirePublicationReceipt:
        input.requirePublicationReceipt !== false,
      requireApplicabilityScope:
        input.requireApplicabilityScope !== false,
      requireLimitations:
        input.requireLimitations !== false,
      requireCorrelationId:
        input.requireCorrelationId !== false,
      requireLineage:
        input.requireLineage !== false,
      acceptedPackageVersions:
        runtime.clone(input.acceptedPackageVersions || ["1.0.0"]),
      status:String(input.status || "active"),
      createdAt:new Date().toISOString()
    });
  }

  global.INFINICUS.CL.learningIntakePolicyModel=
    Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-02-Learning-Package-Intake-Validation-Engine/src/validation/learning-package-validator.js --- */
(function(global){
  "use strict";

  function validate({
    publication,
    policy
  }={}){
    const issues=[];

    if(policy.status!=="active"){
      issues.push("Intake policy is inactive.");
    }

    if(!publication.learningPublicationId){
      issues.push("Learning publication ID is required.");
    }

    if(!publication.outcomeLearningPackageId){
      issues.push("Outcome learning package ID is required.");
    }

    if(!publication.outcomeVerdictId){
      issues.push("Outcome verdict ID is required.");
    }

    if(!publication.monitoringContractId){
      issues.push("Monitoring contract ID is required.");
    }

    if(
      policy.requirePublicationReceipt &&
      !publication.learningPublicationReceiptId
    ){
      issues.push("Learning publication receipt ID is required.");
    }

    if(
      !policy.acceptedPackageVersions.includes(
        String(publication.packageVersion || "")
      )
    ){
      issues.push("Learning package version is not accepted.");
    }

    if(
      Number(publication.confidence ?? 0) <
      policy.minimumConfidence
    ){
      issues.push("Learning confidence is below intake minimum.");
    }

    if(
      Number(publication.reliability ?? 0) <
      policy.minimumReliability
    ){
      issues.push("Learning reliability is below intake minimum.");
    }

    if(
      policy.requireApplicabilityScope &&
      !publication.applicabilityScope
    ){
      issues.push("Applicability scope is required.");
    }

    if(
      policy.requireLimitations &&
      !Array.isArray(publication.limitations)
    ){
      issues.push("Limitations are required.");
    }

    if(
      policy.requireCorrelationId &&
      !publication.correlationId
    ){
      issues.push("Correlation ID is required.");
    }

    if(
      policy.requireLineage &&
      (
        !Array.isArray(publication.lineage) ||
        !publication.lineage.length
      )
    ){
      issues.push("Lineage is required.");
    }

    if(!Array.isArray(publication.lessons)){
      issues.push("Lessons must be an array.");
    }

    if(!Array.isArray(publication.hypotheses)){
      issues.push("Hypotheses must be an array.");
    }

    if(!Array.isArray(publication.successFactors)){
      issues.push("Success factors must be an array.");
    }

    if(!Array.isArray(publication.failureFactors)){
      issues.push("Failure factors must be an array.");
    }

    return {
      valid:issues.length===0,
      issues
    };
  }

  global.INFINICUS.CL.learningPackageValidator=
    Object.freeze({validate});
})(window);

/* --- continuous-learning/INFINICUS-CL-02-Learning-Package-Intake-Validation-Engine/src/storage/intake-store.js --- */
(function(global){
  "use strict";

  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_LEARNING_INTAKE";
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;

    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);

      request.onupgradeneeded=()=>{
        const db=request.result;

        for(const [name,keyPath] of [
          ["policies","learningIntakePolicyId"],
          ["accepted","learningPackageIntakeId"],
          ["quarantine","learningPackageQuarantineId"],
          ["handoffs","learningEvidenceHandoffId"]
        ]){
          if(!db.objectStoreNames.contains(name)){
            const store=db.createObjectStore(name,{keyPath});

            if(name==="accepted"){
              store.createIndex(
                "idempotencyKey",
                "idempotencyKey",
                {unique:true}
              );
            }
          }
        }
      };

      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });

    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure(
        "CL_INTAKE_STORAGE_ERROR",
        error?.message || "Learning intake storage failed."
      );
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));

      return value
        ? runtime.success(structuredClone(value))
        : runtime.failure(
            "CL_INTAKE_RECORD_NOT_FOUND",
            "Learning intake record was not found.",
            {storeName,id}
          );
    }catch(error){
      return runtime.failure(
        "CL_INTAKE_STORAGE_ERROR",
        error?.message || "Learning intake retrieval failed."
      );
    }
  }

  async function getAcceptedByIdempotencyKey(key){
    try{
      const db=await open();
      const tx=db.transaction("accepted","readonly");
      const value=await reqp(
        tx.objectStore("accepted")
          .index("idempotencyKey")
          .get(key)
      );

      return value
        ? runtime.success(structuredClone(value))
        : runtime.failure(
            "CL_ACCEPTED_PACKAGE_NOT_FOUND",
            "Accepted package was not previously found."
          );
    }catch(error){
      return runtime.failure(
        "CL_INTAKE_STORAGE_ERROR",
        error?.message || "Learning intake lookup failed."
      );
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure(
        "CL_INTAKE_STORAGE_ERROR",
        error?.message || "Learning intake listing failed."
      );
    }
  }

  global.INFINICUS.CL.learningIntakeStore=
    Object.freeze({
      open,
      put,
      get,
      getAcceptedByIdempotencyKey,
      list
    });
})(window);

/* --- continuous-learning/INFINICUS-CL-02-Learning-Package-Intake-Validation-Engine/src/engine/learning-package-intake-engine.js --- */
(function(global){
  "use strict";

  const runtime=global.INFINICUS.CL.runtime;

  async function registerPolicy(input={}){
    const built=
      global.INFINICUS.CL.learningIntakePolicyModel.create(
        input
      );

    if(!built.ok) return built;

    return global.INFINICUS.CL.learningIntakeStore.put(
      "policies",
      built.data
    );
  }

  async function intake({
    learningIntakePolicyId,
    publication
  }={}){
    const policy=
      await global.INFINICUS.CL.learningIntakeStore.get(
        "policies",
        learningIntakePolicyId
      );

    if(!policy.ok) return policy;

    const validation=
      global.INFINICUS.CL.learningPackageValidator.validate({
        publication,
        policy:policy.data
      });

    const idempotencyKey=
      publication?.learningPublicationId
        ? `cl_intake_${publication.learningPublicationId}`
        : null;

    if(idempotencyKey){
      const existing=
        await global.INFINICUS.CL.learningIntakeStore
          .getAcceptedByIdempotencyKey(idempotencyKey);

      if(existing.ok){
        return runtime.success({
          intake:existing.data,
          idempotentReplay:true
        });
      }
    }

    if(!validation.valid){
      const quarantine={
        learningPackageQuarantineId:
          runtime.createId("cl_learning_quarantine"),
        learningPublicationId:
          publication?.learningPublicationId || null,
        outcomeLearningPackageId:
          publication?.outcomeLearningPackageId || null,
        validationIssues:
          validation.issues.map(String),
        payload:
          runtime.clone(publication || {}),
        state:"quarantined",
        createdAt:new Date().toISOString()
      };

      await global.INFINICUS.CL.learningIntakeStore.put(
        "quarantine",
        quarantine
      );

      await runtime.emit(
        "cl.learning_package.quarantined",
        {
          learningPackageQuarantineId:
            quarantine.learningPackageQuarantineId,
          issueCount:
            quarantine.validationIssues.length
        }
      );

      return runtime.failure(
        "CL_LEARNING_PACKAGE_INVALID",
        "Learning package failed intake validation.",
        {
          quarantineId:
            quarantine.learningPackageQuarantineId,
          issues:
            quarantine.validationIssues
        }
      );
    }

    const intakeRecord={
      learningPackageIntakeId:
        runtime.createId("cl_learning_intake"),
      learningPublicationId:
        publication.learningPublicationId,
      learningPublicationReceiptId:
        publication.learningPublicationReceiptId,
      outcomeLearningPackageId:
        publication.outcomeLearningPackageId,
      outcomeVerdictId:
        publication.outcomeVerdictId,
      monitoringContractId:
        publication.monitoringContractId,
      packageVersion:
        publication.packageVersion,
      lessons:
        runtime.clone(publication.lessons),
      successFactors:
        runtime.clone(publication.successFactors),
      failureFactors:
        runtime.clone(publication.failureFactors),
      hypotheses:
        runtime.clone(publication.hypotheses),
      limitations:
        runtime.clone(publication.limitations),
      applicabilityScope:
        publication.applicabilityScope,
      decisionRuleFeedback:
        runtime.clone(publication.decisionRuleFeedback || []),
      modelCalibrationFeedback:
        runtime.clone(publication.modelCalibrationFeedback || []),
      dataQualityLearning:
        runtime.clone(publication.dataQualityLearning || []),
      operationalLearning:
        runtime.clone(publication.operationalLearning || []),
      riskLearning:
        runtime.clone(publication.riskLearning || []),
      confidence:
        Number(publication.confidence),
      reliability:
        Number(publication.reliability),
      correlationId:
        publication.correlationId,
      lineage:
        publication.lineage.map(runtime.clone),
      idempotencyKey,
      state:"accepted",
      acceptedAt:new Date().toISOString()
    };

    await global.INFINICUS.CL.learningIntakeStore.put(
      "accepted",
      intakeRecord
    );

    const learningState=
      runtime.registerLearningState({
        learningPackageId:
          intakeRecord.outcomeLearningPackageId,
        state:"accepted",
        confidence:
          intakeRecord.confidence,
        reliability:
          intakeRecord.reliability,
        correlationId:
          intakeRecord.correlationId
      });

    const evidenceHandoff={
      learningEvidenceHandoffId:
        runtime.createId("cl_learning_evidence_handoff"),
      targetBlock:"CL-03",
      learningPackageIntakeId:
        intakeRecord.learningPackageIntakeId,
      learningPublicationId:
        intakeRecord.learningPublicationId,
      learningPublicationReceiptId:
        intakeRecord.learningPublicationReceiptId,
      outcomeLearningPackageId:
        intakeRecord.outcomeLearningPackageId,
      outcomeVerdictId:
        intakeRecord.outcomeVerdictId,
      monitoringContractId:
        intakeRecord.monitoringContractId,
      lessons:
        intakeRecord.lessons.map(runtime.clone),
      successFactors:
        intakeRecord.successFactors.map(runtime.clone),
      failureFactors:
        intakeRecord.failureFactors.map(runtime.clone),
      hypotheses:
        intakeRecord.hypotheses.map(runtime.clone),
      limitations:
        intakeRecord.limitations.map(runtime.clone),
      applicabilityScope:
        intakeRecord.applicabilityScope,
      decisionRuleFeedback:
        intakeRecord.decisionRuleFeedback.map(runtime.clone),
      modelCalibrationFeedback:
        intakeRecord.modelCalibrationFeedback.map(runtime.clone),
      dataQualityLearning:
        intakeRecord.dataQualityLearning.map(runtime.clone),
      operationalLearning:
        intakeRecord.operationalLearning.map(runtime.clone),
      riskLearning:
        intakeRecord.riskLearning.map(runtime.clone),
      confidence:
        intakeRecord.confidence,
      reliability:
        intakeRecord.reliability,
      correlationId:
        intakeRecord.correlationId,
      lineage:
        intakeRecord.lineage.map(runtime.clone),
      learningStateId:
        learningState.data.learningStateId,
      status:"ready",
      createdAt:new Date().toISOString()
    };

    await global.INFINICUS.CL.learningIntakeStore.put(
      "handoffs",
      evidenceHandoff
    );

    await runtime.emit(
      "cl.learning_package.accepted",
      {
        learningPackageIntakeId:
          intakeRecord.learningPackageIntakeId,
        learningEvidenceHandoffId:
          evidenceHandoff.learningEvidenceHandoffId
      }
    );

    return runtime.success({
      intake:intakeRecord,
      learningEvidenceHandoff:evidenceHandoff
    });
  }

  const api=Object.freeze({
    registerPolicy,
    intake,
    getAcceptedPackage:({learningPackageIntakeId}) =>
      global.INFINICUS.CL.learningIntakeStore.get(
        "accepted",
        learningPackageIntakeId
      ),
    getLearningEvidenceHandoff:({
      learningEvidenceHandoffId
    }) =>
      global.INFINICUS.CL.learningIntakeStore.get(
        "handoffs",
        learningEvidenceHandoffId
      ),
    listAcceptedPackages:() =>
      global.INFINICUS.CL.learningIntakeStore.list(
        "accepted"
      ),
    listQuarantinedPackages:() =>
      global.INFINICUS.CL.learningIntakeStore.list(
        "quarantine"
      )
  });

  runtime.registerService(
    "cl.learning_package_intake",
    api,
    {block:"CL-02"}
  );

  runtime.registerRoute(
    "cl.learning_intake_policy.register",
    registerPolicy,
    {block:"CL-02"}
  );

  runtime.registerRoute(
    "cl.learning_package.intake",
    intake,
    {block:"CL-02"}
  );

  global.INFINICUS.CL.learningPackageIntakeEngine=api;
})(window);

/* ===== INFINICUS-CL-03-Learning-Evidence-Provenance-Registry ===== */

/* --- continuous-learning/INFINICUS-CL-03-Learning-Evidence-Provenance-Registry/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;

  if(!CL?.runtime){
    throw new Error("CL-01 must be loaded before CL-03.");
  }

  if(!CL?.learningPackageIntakeEngine){
    throw new Error("CL-02 must be loaded before CL-03.");
  }
})(window);

/* --- continuous-learning/INFINICUS-CL-03-Learning-Evidence-Provenance-Registry/src/model/evidence-policy.js --- */
(function(global){
  "use strict";

  function create(input={}){
    const runtime=global.INFINICUS.CL.runtime;

    if(!input.name || !input.code){
      return runtime.failure(
        "CL_EVIDENCE_POLICY_INVALID",
        "Evidence policy name and code are required."
      );
    }

    return runtime.success({
      learningEvidencePolicyId:
        input.learningEvidencePolicyId ||
        runtime.createId("cl_evidence_policy"),
      name:String(input.name),
      code:String(input.code),
      requireSourceReference:
        input.requireSourceReference !== false,
      requireLineage:
        input.requireLineage !== false,
      requireCorrelationId:
        input.requireCorrelationId !== false,
      allowDerivedEvidence:
        input.allowDerivedEvidence !== false,
      acceptedEvidenceTypes:
        runtime.clone(
          input.acceptedEvidenceTypes || [
            "observed",
            "calculated",
            "contextual",
            "documentary",
            "expert_review",
            "hypothesis"
          ]
        ),
      status:String(input.status || "active"),
      createdAt:new Date().toISOString()
    });
  }

  global.INFINICUS.CL.learningEvidencePolicyModel=
    Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-03-Learning-Evidence-Provenance-Registry/src/fingerprint/evidence-fingerprint.js --- */
(function(global){
  "use strict";

  function canonicalize(value){
    if(value===null || typeof value!=="object"){
      return JSON.stringify(value);
    }

    if(Array.isArray(value)){
      return `[${value.map(canonicalize).join(",")}]`;
    }

    const keys=Object.keys(value).sort();

    return `{${keys.map(
      key=>`${JSON.stringify(key)}:${canonicalize(value[key])}`
    ).join(",")}}`;
  }

  function simpleHash(value){
    const text=canonicalize(value);
    let hash=2166136261;

    for(let index=0;index<text.length;index++){
      hash^=text.charCodeAt(index);
      hash=Math.imul(hash,16777619);
    }

    return `fnv1a_${(hash>>>0).toString(16).padStart(8,"0")}`;
  }

  global.INFINICUS.CL.learningEvidenceFingerprint=
    Object.freeze({canonicalize,simpleHash});
})(window);

/* --- continuous-learning/INFINICUS-CL-03-Learning-Evidence-Provenance-Registry/src/storage/evidence-store.js --- */
(function(global){
  "use strict";

  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_LEARNING_EVIDENCE";
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;

    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);

      request.onupgradeneeded=()=>{
        const db=request.result;

        for(const [name,keyPath] of [
          ["policies","learningEvidencePolicyId"],
          ["evidence","learningEvidenceId"],
          ["provenance","learningProvenanceId"],
          ["bindings","learningEvidenceBindingId"],
          ["handoffs","lessonClassificationHandoffId"]
        ]){
          if(!db.objectStoreNames.contains(name)){
            const store=db.createObjectStore(name,{keyPath});

            if(name==="evidence"){
              store.createIndex(
                "fingerprint",
                "fingerprint",
                {unique:true}
              );
            }
          }
        }
      };

      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });

    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure(
        "CL_EVIDENCE_STORAGE_ERROR",
        error?.message || "Learning evidence storage failed."
      );
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));

      return value
        ? runtime.success(structuredClone(value))
        : runtime.failure(
            "CL_EVIDENCE_RECORD_NOT_FOUND",
            "Learning evidence record was not found.",
            {storeName,id}
          );
    }catch(error){
      return runtime.failure(
        "CL_EVIDENCE_STORAGE_ERROR",
        error?.message || "Learning evidence retrieval failed."
      );
    }
  }

  async function getByFingerprint(fingerprint){
    try{
      const db=await open();
      const tx=db.transaction("evidence","readonly");
      const value=await reqp(
        tx.objectStore("evidence")
          .index("fingerprint")
          .get(fingerprint)
      );

      return value
        ? runtime.success(structuredClone(value))
        : runtime.failure(
            "CL_EVIDENCE_FINGERPRINT_NOT_FOUND",
            "No evidence record matches the fingerprint."
          );
    }catch(error){
      return runtime.failure(
        "CL_EVIDENCE_STORAGE_ERROR",
        error?.message || "Learning evidence lookup failed."
      );
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure(
        "CL_EVIDENCE_STORAGE_ERROR",
        error?.message || "Learning evidence listing failed."
      );
    }
  }

  global.INFINICUS.CL.learningEvidenceStore=
    Object.freeze({
      open,
      put,
      get,
      getByFingerprint,
      list
    });
})(window);

/* --- continuous-learning/INFINICUS-CL-03-Learning-Evidence-Provenance-Registry/src/engine/learning-evidence-provenance-registry-engine.js --- */
(function(global){
  "use strict";

  const runtime=global.INFINICUS.CL.runtime;

  async function registerPolicy(input={}){
    const built=
      global.INFINICUS.CL.learningEvidencePolicyModel.create(input);

    if(!built.ok) return built;

    return global.INFINICUS.CL.learningEvidenceStore.put(
      "policies",
      built.data
    );
  }

  async function registerFromHandoff({
    learningEvidenceHandoffId,
    learningEvidencePolicyId,
    sourceEvidenceByItem={}
  }={}){
    const handoff=
      await global.INFINICUS.CL.learningPackageIntakeEngine
        .getLearningEvidenceHandoff({
          learningEvidenceHandoffId
        });

    if(!handoff.ok) return handoff;

    const policy=
      await global.INFINICUS.CL.learningEvidenceStore.get(
        "policies",
        learningEvidencePolicyId
      );

    if(!policy.ok) return policy;

    const items=[
      ...handoff.data.lessons.map(item=>({
        itemType:"lesson",
        item
      })),
      ...handoff.data.successFactors.map(item=>({
        itemType:"success_factor",
        item
      })),
      ...handoff.data.failureFactors.map(item=>({
        itemType:"failure_factor",
        item
      })),
      ...handoff.data.hypotheses.map(item=>({
        itemType:"hypothesis",
        item
      })),
      ...handoff.data.decisionRuleFeedback.map(item=>({
        itemType:"decision_rule_feedback",
        item
      })),
      ...handoff.data.modelCalibrationFeedback.map(item=>({
        itemType:"model_calibration_feedback",
        item
      })),
      ...handoff.data.dataQualityLearning.map(item=>({
        itemType:"data_quality_learning",
        item
      })),
      ...handoff.data.operationalLearning.map(item=>({
        itemType:"operational_learning",
        item
      })),
      ...handoff.data.riskLearning.map(item=>({
        itemType:"risk_learning",
        item
      }))
    ];

    const evidenceRecords=[];
    const provenanceRecords=[];
    const bindings=[];

    for(let index=0;index<items.length;index++){
      const wrapped=items[index];
      const itemId=
        wrapped.item.learningItemId ||
        wrapped.item.hypothesisId ||
        wrapped.item.id ||
        `${wrapped.itemType}_${index+1}`;

      const source=
        sourceEvidenceByItem[itemId] || {};

      const evidenceType=
        String(
          source.evidenceType ||
          wrapped.item.evidenceType ||
          (wrapped.itemType==="hypothesis"
            ? "hypothesis"
            : "contextual")
        );

      if(
        !policy.data.acceptedEvidenceTypes.includes(evidenceType)
      ){
        return runtime.failure(
          "CL_EVIDENCE_TYPE_NOT_ACCEPTED",
          `Evidence type is not accepted: ${evidenceType}`,
          {itemId}
        );
      }

      if(
        policy.data.requireSourceReference &&
        !source.sourceReference &&
        !wrapped.item.evidenceReference
      ){
        return runtime.failure(
          "CL_EVIDENCE_SOURCE_REQUIRED",
          "A source reference is required.",
          {itemId}
        );
      }

      const fingerprint=
        global.INFINICUS.CL.learningEvidenceFingerprint.simpleHash({
          learningPackageId:
            handoff.data.outcomeLearningPackageId,
          itemType:wrapped.itemType,
          item:wrapped.item,
          sourceReference:
            source.sourceReference ||
            wrapped.item.evidenceReference ||
            null
        });

      const existing=
        await global.INFINICUS.CL.learningEvidenceStore
          .getByFingerprint(fingerprint);

      let evidence;

      if(existing.ok){
        evidence=existing.data;
      }else{
        evidence={
          learningEvidenceId:
            runtime.createId("cl_learning_evidence"),
          outcomeLearningPackageId:
            handoff.data.outcomeLearningPackageId,
          learningPackageIntakeId:
            handoff.data.learningPackageIntakeId,
          itemId,
          itemType:wrapped.itemType,
          evidenceType,
          evidencePayload:
            runtime.clone(wrapped.item),
          sourceReference:
            source.sourceReference ||
            wrapped.item.evidenceReference ||
            null,
          sourceSystem:
            source.sourceSystem || "OM-24",
          sourceRecordType:
            source.sourceRecordType || wrapped.itemType,
          observedAt:
            source.observedAt || null,
          confidence:
            Math.min(
              Number(
                source.confidence ??
                wrapped.item.confidence ??
                handoff.data.confidence
              ),
              handoff.data.confidence
            ),
          reliability:
            Math.min(
              Number(
                source.reliability ??
                handoff.data.reliability
              ),
              handoff.data.reliability
            ),
          fingerprint,
          correlationId:
            handoff.data.correlationId,
          lineage:[
            ...handoff.data.lineage.map(runtime.clone),
            ...(source.lineage || []).map(runtime.clone)
          ],
          state:"registered",
          registeredAt:new Date().toISOString()
        };

        await global.INFINICUS.CL.learningEvidenceStore.put(
          "evidence",
          evidence
        );
      }

      const provenance={
        learningProvenanceId:
          runtime.createId("cl_learning_provenance"),
        learningEvidenceId:
          evidence.learningEvidenceId,
        outcomeLearningPackageId:
          handoff.data.outcomeLearningPackageId,
        sourceSystem:
          evidence.sourceSystem,
        sourceReference:
          evidence.sourceReference,
        sourceRecordType:
          evidence.sourceRecordType,
        correlationId:
          evidence.correlationId,
        lineage:
          evidence.lineage.map(runtime.clone),
        createdAt:new Date().toISOString()
      };

      await global.INFINICUS.CL.learningEvidenceStore.put(
        "provenance",
        provenance
      );

      const binding={
        learningEvidenceBindingId:
          runtime.createId("cl_learning_evidence_binding"),
        learningEvidenceId:
          evidence.learningEvidenceId,
        learningProvenanceId:
          provenance.learningProvenanceId,
        itemId,
        itemType:wrapped.itemType,
        outcomeLearningPackageId:
          handoff.data.outcomeLearningPackageId,
        createdAt:new Date().toISOString()
      };

      await global.INFINICUS.CL.learningEvidenceStore.put(
        "bindings",
        binding
      );

      evidenceRecords.push(evidence);
      provenanceRecords.push(provenance);
      bindings.push(binding);
    }

    const classificationHandoff={
      lessonClassificationHandoffId:
        runtime.createId("cl_lesson_classification_handoff"),
      targetBlock:"CL-04",
      learningPackageIntakeId:
        handoff.data.learningPackageIntakeId,
      outcomeLearningPackageId:
        handoff.data.outcomeLearningPackageId,
      outcomeVerdictId:
        handoff.data.outcomeVerdictId,
      learningEvidence:
        evidenceRecords.map(runtime.clone),
      provenance:
        provenanceRecords.map(runtime.clone),
      evidenceBindings:
        bindings.map(runtime.clone),
      limitations:
        handoff.data.limitations.map(runtime.clone),
      applicabilityScope:
        handoff.data.applicabilityScope,
      confidence:
        handoff.data.confidence,
      reliability:
        handoff.data.reliability,
      correlationId:
        handoff.data.correlationId,
      lineage:
        handoff.data.lineage.map(runtime.clone),
      status:"ready",
      createdAt:new Date().toISOString()
    };

    await global.INFINICUS.CL.learningEvidenceStore.put(
      "handoffs",
      classificationHandoff
    );

    await runtime.emit(
      "cl.learning_evidence.registered",
      {
        evidenceCount:evidenceRecords.length,
        lessonClassificationHandoffId:
          classificationHandoff.lessonClassificationHandoffId
      }
    );

    return runtime.success({
      learningEvidence:evidenceRecords,
      provenance:provenanceRecords,
      evidenceBindings:bindings,
      lessonClassificationHandoff:classificationHandoff
    });
  }

  const api=Object.freeze({
    registerPolicy,
    registerFromHandoff,
    getEvidence:({learningEvidenceId}) =>
      global.INFINICUS.CL.learningEvidenceStore.get(
        "evidence",
        learningEvidenceId
      ),
    getLessonClassificationHandoff:({
      lessonClassificationHandoffId
    }) =>
      global.INFINICUS.CL.learningEvidenceStore.get(
        "handoffs",
        lessonClassificationHandoffId
      ),
    listEvidence:() =>
      global.INFINICUS.CL.learningEvidenceStore.list(
        "evidence"
      ),
    listProvenance:() =>
      global.INFINICUS.CL.learningEvidenceStore.list(
        "provenance"
      )
  });

  runtime.registerService(
    "cl.learning_evidence_provenance_registry",
    api,
    {block:"CL-03"}
  );

  runtime.registerRoute(
    "cl.learning_evidence_policy.register",
    registerPolicy
  );

  runtime.registerRoute(
    "cl.learning_evidence.register_from_handoff",
    registerFromHandoff
  );

  global.INFINICUS.CL.learningEvidenceProvenanceRegistryEngine=api;
})(window);

/* ===== INFINICUS-CL-04-Lesson-Classification-Taxonomy-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-04-Lesson-Classification-Taxonomy-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;

  if(!CL?.runtime){
    throw new Error("CL-01 must be loaded before CL-04.");
  }

  if(!CL?.learningEvidenceProvenanceRegistryEngine){
    throw new Error("CL-03 must be loaded before CL-04.");
  }
})(window);

/* --- continuous-learning/INFINICUS-CL-04-Lesson-Classification-Taxonomy-Engine/src/model/taxonomy-policy.js --- */
(function(global){
  "use strict";

  function create(input={}){
    const runtime=global.INFINICUS.CL.runtime;

    if(!input.name || !input.code){
      return runtime.failure(
        "CL_TAXONOMY_POLICY_INVALID",
        "Taxonomy policy name and code are required."
      );
    }

    return runtime.success({
      learningTaxonomyPolicyId:
        input.learningTaxonomyPolicyId ||
        runtime.createId("cl_taxonomy_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumClassificationConfidence:
        Math.max(
          0,
          Math.min(
            1,
            Number(input.minimumClassificationConfidence ?? 0.5)
          )
        ),
      allowMultiLabel:
        input.allowMultiLabel !== false,
      maximumLabels:
        Math.max(1,Number(input.maximumLabels || 3)),
      requirePrimaryCategory:
        input.requirePrimaryCategory !== false,
      status:String(input.status || "active"),
      createdAt:new Date().toISOString()
    });
  }

  global.INFINICUS.CL.learningTaxonomyPolicyModel=
    Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-04-Lesson-Classification-Taxonomy-Engine/src/classification/taxonomy-classifier.js --- */
(function(global){
  "use strict";

  function normalizeText(value){
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g," ")
      .replace(/\s+/g," ")
      .trim();
  }

  function classify({
    evidence,
    taxonomies,
    policy
  }={}){
    const text=
      normalizeText(
        JSON.stringify(evidence.evidencePayload || {})
      );

    const matches=[];

    for(const taxonomy of taxonomies){
      const keywords=
        (taxonomy.keywords || [])
          .map(normalizeText)
          .filter(Boolean);

      const hits=
        keywords.filter(keyword=>text.includes(keyword));

      if(!hits.length){
        continue;
      }

      const confidence=
        Math.min(
          1,
          hits.length / Math.max(1,keywords.length)
        );

      matches.push({
        taxonomyId:taxonomy.learningTaxonomyId,
        categoryCode:taxonomy.categoryCode,
        subcategoryCode:taxonomy.subcategoryCode || null,
        matchedKeywords:hits,
        confidence:Number(confidence.toFixed(4))
      });
    }

    matches.sort(
      (a,b)=>b.confidence-a.confidence
    );

    const filtered=
      matches
        .filter(
          item=>
            item.confidence>=
            policy.minimumClassificationConfidence
        )
        .slice(
          0,
          policy.allowMultiLabel
            ? policy.maximumLabels
            : 1
        );

    return {
      primaryClassification:
        filtered[0] || null,
      classifications:filtered,
      unclassified:filtered.length===0
    };
  }

  global.INFINICUS.CL.taxonomyClassifier=
    Object.freeze({normalizeText,classify});
})(window);

/* --- continuous-learning/INFINICUS-CL-04-Lesson-Classification-Taxonomy-Engine/src/storage/classification-store.js --- */
(function(global){
  "use strict";

  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_LESSON_CLASSIFICATION";
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;

    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);

      request.onupgradeneeded=()=>{
        const db=request.result;

        for(const [name,keyPath] of [
          ["policies","learningTaxonomyPolicyId"],
          ["taxonomies","learningTaxonomyId"],
          ["classifications","lessonClassificationId"],
          ["unclassified","unclassifiedLearningItemId"],
          ["handoffs","applicabilityScopeHandoffId"]
        ]){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };

      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });

    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure(
        "CL_CLASSIFICATION_STORAGE_ERROR",
        error?.message || "Classification storage failed."
      );
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));

      return value
        ? runtime.success(structuredClone(value))
        : runtime.failure(
            "CL_CLASSIFICATION_RECORD_NOT_FOUND",
            "Classification record was not found.",
            {storeName,id}
          );
    }catch(error){
      return runtime.failure(
        "CL_CLASSIFICATION_STORAGE_ERROR",
        error?.message || "Classification retrieval failed."
      );
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure(
        "CL_CLASSIFICATION_STORAGE_ERROR",
        error?.message || "Classification listing failed."
      );
    }
  }

  global.INFINICUS.CL.lessonClassificationStore=
    Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-04-Lesson-Classification-Taxonomy-Engine/src/engine/lesson-classification-taxonomy-engine.js --- */
(function(global){
  "use strict";

  const runtime=global.INFINICUS.CL.runtime;

  async function registerPolicy(input={}){
    const built=
      global.INFINICUS.CL.learningTaxonomyPolicyModel.create(input);

    if(!built.ok) return built;

    return global.INFINICUS.CL.lessonClassificationStore.put(
      "policies",
      built.data
    );
  }

  async function registerTaxonomy(input={}){
    if(!input.name || !input.categoryCode){
      return runtime.failure(
        "CL_TAXONOMY_INVALID",
        "Taxonomy name and category code are required."
      );
    }

    const taxonomy={
      learningTaxonomyId:
        input.learningTaxonomyId ||
        runtime.createId("cl_taxonomy"),
      name:String(input.name),
      categoryCode:String(input.categoryCode),
      subcategoryCode:
        input.subcategoryCode
          ? String(input.subcategoryCode)
          : null,
      domain:String(input.domain || "general"),
      learningPurpose:
        String(input.learningPurpose || "knowledge"),
      keywords:
        runtime.clone(input.keywords || []),
      evidenceTypes:
        runtime.clone(
          input.evidenceTypes || [
            "observed",
            "calculated",
            "contextual",
            "documentary",
            "expert_review",
            "hypothesis"
          ]
        ),
      status:String(input.status || "active"),
      createdAt:new Date().toISOString()
    };

    return global.INFINICUS.CL.lessonClassificationStore.put(
      "taxonomies",
      taxonomy
    );
  }

  async function classify({
    lessonClassificationHandoffId,
    learningTaxonomyPolicyId
  }={}){
    const handoff=
      await global.INFINICUS.CL.learningEvidenceProvenanceRegistryEngine
        .getLessonClassificationHandoff({
          lessonClassificationHandoffId
        });

    if(!handoff.ok) return handoff;

    const policy=
      await global.INFINICUS.CL.lessonClassificationStore.get(
        "policies",
        learningTaxonomyPolicyId
      );

    if(!policy.ok) return policy;

    const taxonomies=
      await global.INFINICUS.CL.lessonClassificationStore.list(
        "taxonomies"
      );

    if(!taxonomies.ok) return taxonomies;

    const activeTaxonomies=
      taxonomies.data.filter(
        item=>item.status==="active"
      );

    const classifications=[];
    const unclassified=[];

    for(const evidence of handoff.data.learningEvidence){
      const eligibleTaxonomies=
        activeTaxonomies.filter(
          taxonomy=>
            taxonomy.evidenceTypes.includes(
              evidence.evidenceType
            )
        );

      const result=
        global.INFINICUS.CL.taxonomyClassifier.classify({
          evidence,
          taxonomies:eligibleTaxonomies,
          policy:policy.data
        });

      if(
        policy.data.requirePrimaryCategory &&
        result.unclassified
      ){
        const record={
          unclassifiedLearningItemId:
            runtime.createId("cl_unclassified_item"),
          learningEvidenceId:
            evidence.learningEvidenceId,
          outcomeLearningPackageId:
            handoff.data.outcomeLearningPackageId,
          reason:"no_taxonomy_match_above_threshold",
          evidenceType:
            evidence.evidenceType,
          confidence:
            evidence.confidence,
          correlationId:
            evidence.correlationId,
          createdAt:new Date().toISOString()
        };

        await global.INFINICUS.CL.lessonClassificationStore.put(
          "unclassified",
          record
        );

        unclassified.push(record);
        continue;
      }

      const classification={
        lessonClassificationId:
          runtime.createId("cl_lesson_classification"),
        learningEvidenceId:
          evidence.learningEvidenceId,
        outcomeLearningPackageId:
          handoff.data.outcomeLearningPackageId,
        itemId:
          evidence.itemId,
        itemType:
          evidence.itemType,
        evidenceType:
          evidence.evidenceType,
        primaryCategory:
          result.primaryClassification,
        classifications:
          result.classifications.map(runtime.clone),
        classificationConfidence:
          result.primaryClassification?.confidence || 0,
        confidence:
          Math.min(
            evidence.confidence,
            result.primaryClassification?.confidence || 0
          ),
        reliability:
          evidence.reliability,
        correlationId:
          evidence.correlationId,
        lineage:
          evidence.lineage.map(runtime.clone),
        classifiedAt:new Date().toISOString()
      };

      await global.INFINICUS.CL.lessonClassificationStore.put(
        "classifications",
        classification
      );

      classifications.push(classification);
    }

    const applicabilityHandoff={
      applicabilityScopeHandoffId:
        runtime.createId("cl_applicability_scope_handoff"),
      targetBlock:"CL-05",
      learningPackageIntakeId:
        handoff.data.learningPackageIntakeId,
      outcomeLearningPackageId:
        handoff.data.outcomeLearningPackageId,
      outcomeVerdictId:
        handoff.data.outcomeVerdictId,
      classifications:
        classifications.map(runtime.clone),
      unclassifiedItems:
        unclassified.map(runtime.clone),
      learningEvidence:
        handoff.data.learningEvidence.map(runtime.clone),
      provenance:
        handoff.data.provenance.map(runtime.clone),
      evidenceBindings:
        handoff.data.evidenceBindings.map(runtime.clone),
      limitations:
        handoff.data.limitations.map(runtime.clone),
      declaredApplicabilityScope:
        handoff.data.applicabilityScope,
      confidence:
        handoff.data.confidence,
      reliability:
        handoff.data.reliability,
      correlationId:
        handoff.data.correlationId,
      lineage:
        handoff.data.lineage.map(runtime.clone),
      status:"ready",
      createdAt:new Date().toISOString()
    };

    await global.INFINICUS.CL.lessonClassificationStore.put(
      "handoffs",
      applicabilityHandoff
    );

    await runtime.emit(
      "cl.lessons.classified",
      {
        classificationCount:
          classifications.length,
        unclassifiedCount:
          unclassified.length,
        applicabilityScopeHandoffId:
          applicabilityHandoff.applicabilityScopeHandoffId
      }
    );

    return runtime.success({
      classifications,
      unclassifiedItems:unclassified,
      applicabilityScopeHandoff:applicabilityHandoff
    });
  }

  const api=Object.freeze({
    registerPolicy,
    registerTaxonomy,
    classify,
    getClassification:({lessonClassificationId}) =>
      global.INFINICUS.CL.lessonClassificationStore.get(
        "classifications",
        lessonClassificationId
      ),
    getApplicabilityScopeHandoff:({
      applicabilityScopeHandoffId
    }) =>
      global.INFINICUS.CL.lessonClassificationStore.get(
        "handoffs",
        applicabilityScopeHandoffId
      ),
    listClassifications:() =>
      global.INFINICUS.CL.lessonClassificationStore.list(
        "classifications"
      ),
    listUnclassifiedItems:() =>
      global.INFINICUS.CL.lessonClassificationStore.list(
        "unclassified"
      )
  });

  runtime.registerService(
    "cl.lesson_classification_taxonomy",
    api,
    {block:"CL-04"}
  );

  runtime.registerRoute(
    "cl.learning_taxonomy_policy.register",
    registerPolicy
  );

  runtime.registerRoute(
    "cl.learning_taxonomy.register",
    registerTaxonomy
  );

  runtime.registerRoute(
    "cl.lessons.classify",
    classify
  );

  global.INFINICUS.CL.lessonClassificationTaxonomyEngine=api;
})(window);

/* ===== INFINICUS-CL-05-Applicability-Scope-Context-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-05-Applicability-Scope-Context-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;

  if(!CL?.runtime){
    throw new Error("CL-01 must be loaded before CL-05.");
  }

  if(!CL?.lessonClassificationTaxonomyEngine){
    throw new Error("CL-04 must be loaded before CL-05.");
  }
})(window);

/* --- continuous-learning/INFINICUS-CL-05-Applicability-Scope-Context-Engine/src/model/applicability-policy.js --- */
(function(global){
  "use strict";

  function create(input={}){
    const runtime=global.INFINICUS.CL.runtime;

    if(!input.name || !input.code){
      return runtime.failure(
        "CL_APPLICABILITY_POLICY_INVALID",
        "Applicability policy name and code are required."
      );
    }

    return runtime.success({
      applicabilityPolicyId:
        input.applicabilityPolicyId ||
        runtime.createId("cl_applicability_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumBroadTransferability:
        Math.max(0,Math.min(1,Number(input.minimumBroadTransferability ?? 0.8))),
      minimumConditionalTransferability:
        Math.max(0,Math.min(1,Number(input.minimumConditionalTransferability ?? 0.55))),
      minimumRestrictedTransferability:
        Math.max(0,Math.min(1,Number(input.minimumRestrictedTransferability ?? 0.3))),
      requireContextEvidence:
        input.requireContextEvidence !== false,
      requiredDimensions:
        runtime.clone(
          input.requiredDimensions || [
            "businessType",
            "market",
            "geography",
            "scale",
            "customerSegment",
            "channel",
            "operatingModel",
            "timeHorizon"
          ]
        ),
      status:String(input.status || "active"),
      createdAt:new Date().toISOString()
    });
  }

  global.INFINICUS.CL.applicabilityPolicyModel=
    Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-05-Applicability-Scope-Context-Engine/src/scoring/context-similarity-scorer.js --- */
(function(global){
  "use strict";

  function normalize(value){
    if(value==null) return null;

    if(Array.isArray(value)){
      return value.map(item=>String(item).toLowerCase().trim());
    }

    return String(value).toLowerCase().trim();
  }

  function dimensionScore(source,target){
    const a=normalize(source);
    const b=normalize(target);

    if(a==null || b==null){
      return 0;
    }

    if(Array.isArray(a) || Array.isArray(b)){
      const aa=Array.isArray(a) ? a : [a];
      const bb=Array.isArray(b) ? b : [b];
      const intersection=aa.filter(item=>bb.includes(item));

      return intersection.length /
        Math.max(1,new Set([...aa,...bb]).size);
    }

    return a===b ? 1 : 0;
  }

  function score({
    sourceContext,
    targetContext,
    dimensions
  }={}){
    const components={};

    for(const dimension of dimensions){
      components[dimension]=
        dimensionScore(
          sourceContext?.[dimension],
          targetContext?.[dimension]
        );
    }

    const values=Object.values(components);

    const similarity=
      values.length
        ? values.reduce((sum,value)=>sum+value,0)/values.length
        : 0;

    return {
      similarity:Number(similarity.toFixed(4)),
      components
    };
  }

  global.INFINICUS.CL.contextSimilarityScorer=
    Object.freeze({normalize,dimensionScore,score});
})(window);

/* --- continuous-learning/INFINICUS-CL-05-Applicability-Scope-Context-Engine/src/storage/applicability-store.js --- */
(function(global){
  "use strict";

  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_APPLICABILITY_SCOPE";
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;

    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);

      request.onupgradeneeded=()=>{
        const db=request.result;

        for(const [name,keyPath] of [
          ["policies","applicabilityPolicyId"],
          ["contexts","learningContextProfileId"],
          ["assessments","applicabilityAssessmentId"],
          ["restrictions","applicabilityRestrictionId"],
          ["handoffs","learningConfidenceHandoffId"]
        ]){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };

      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });

    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure(
        "CL_APPLICABILITY_STORAGE_ERROR",
        error?.message || "Applicability storage failed."
      );
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));

      return value
        ? runtime.success(structuredClone(value))
        : runtime.failure(
            "CL_APPLICABILITY_RECORD_NOT_FOUND",
            "Applicability record was not found.",
            {storeName,id}
          );
    }catch(error){
      return runtime.failure(
        "CL_APPLICABILITY_STORAGE_ERROR",
        error?.message || "Applicability retrieval failed."
      );
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure(
        "CL_APPLICABILITY_STORAGE_ERROR",
        error?.message || "Applicability listing failed."
      );
    }
  }

  global.INFINICUS.CL.applicabilityStore=
    Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-05-Applicability-Scope-Context-Engine/src/engine/applicability-scope-context-engine.js --- */
(function(global){
  "use strict";

  const runtime=global.INFINICUS.CL.runtime;

  async function registerPolicy(input={}){
    const built=
      global.INFINICUS.CL.applicabilityPolicyModel.create(input);

    if(!built.ok) return built;

    return global.INFINICUS.CL.applicabilityStore.put(
      "policies",
      built.data
    );
  }

  async function registerContext(input={}){
    if(!input.name || !input.contextType){
      return runtime.failure(
        "CL_CONTEXT_PROFILE_INVALID",
        "Context profile name and context type are required."
      );
    }

    const profile={
      learningContextProfileId:
        input.learningContextProfileId ||
        runtime.createId("cl_context_profile"),
      name:String(input.name),
      contextType:String(input.contextType),
      businessType:input.businessType || null,
      market:input.market || null,
      geography:input.geography || null,
      scale:input.scale || null,
      customerSegment:input.customerSegment || null,
      channel:input.channel || null,
      operatingModel:input.operatingModel || null,
      timeHorizon:input.timeHorizon || null,
      evidence:
        runtime.clone(input.evidence || []),
      confidence:
        Math.max(0,Math.min(1,Number(input.confidence ?? 0.5))),
      createdAt:new Date().toISOString()
    };

    return global.INFINICUS.CL.applicabilityStore.put(
      "contexts",
      profile
    );
  }

  async function assess({
    applicabilityScopeHandoffId,
    applicabilityPolicyId,
    sourceContextId,
    targetContextIds=[]
  }={}){
    const handoff=
      await global.INFINICUS.CL.lessonClassificationTaxonomyEngine
        .getApplicabilityScopeHandoff({
          applicabilityScopeHandoffId
        });

    if(!handoff.ok) return handoff;

    const policy=
      await global.INFINICUS.CL.applicabilityStore.get(
        "policies",
        applicabilityPolicyId
      );

    if(!policy.ok) return policy;

    const sourceContext=
      await global.INFINICUS.CL.applicabilityStore.get(
        "contexts",
        sourceContextId
      );

    if(!sourceContext.ok) return sourceContext;

    const targets=[];

    for(const targetContextId of targetContextIds){
      const target=
        await global.INFINICUS.CL.applicabilityStore.get(
          "contexts",
          targetContextId
        );

      if(!target.ok) return target;
      targets.push(target.data);
    }

    const assessments=[];
    const restrictions=[];

    for(const classification of handoff.data.classifications){
      for(const targetContext of targets){
        const scored=
          global.INFINICUS.CL.contextSimilarityScorer.score({
            sourceContext:sourceContext.data,
            targetContext,
            dimensions:policy.data.requiredDimensions
          });

        let transferability="out_of_scope";

        if(scored.similarity>=policy.data.minimumBroadTransferability){
          transferability="broad";
        }else if(
          scored.similarity>=policy.data.minimumConditionalTransferability
        ){
          transferability="conditional";
        }else if(
          scored.similarity>=policy.data.minimumRestrictedTransferability
        ){
          transferability="restricted";
        }

        const assessment={
          applicabilityAssessmentId:
            runtime.createId("cl_applicability_assessment"),
          outcomeLearningPackageId:
            handoff.data.outcomeLearningPackageId,
          lessonClassificationId:
            classification.lessonClassificationId,
          learningEvidenceId:
            classification.learningEvidenceId,
          sourceContextId:
            sourceContext.data.learningContextProfileId,
          targetContextId:
            targetContext.learningContextProfileId,
          similarityScore:
            scored.similarity,
          dimensionScores:
            runtime.clone(scored.components),
          transferability,
          declaredApplicabilityScope:
            handoff.data.declaredApplicabilityScope,
          confidence:
            Math.min(
              classification.confidence,
              sourceContext.data.confidence,
              targetContext.confidence,
              handoff.data.confidence
            ),
          reliability:
            Math.min(
              classification.reliability,
              handoff.data.reliability
            ),
          correlationId:
            handoff.data.correlationId,
          lineage:
            classification.lineage.map(runtime.clone),
          assessedAt:new Date().toISOString()
        };

        await global.INFINICUS.CL.applicabilityStore.put(
          "assessments",
          assessment
        );

        assessments.push(assessment);

        if(
          ["conditional","restricted","out_of_scope"].includes(
            transferability
          )
        ){
          const restriction={
            applicabilityRestrictionId:
              runtime.createId("cl_applicability_restriction"),
            applicabilityAssessmentId:
              assessment.applicabilityAssessmentId,
            lessonClassificationId:
              assessment.lessonClassificationId,
            targetContextId:
              assessment.targetContextId,
            restrictionType:transferability,
            reason:
              transferability==="out_of_scope"
                ? "Context similarity is below the minimum supported threshold."
                : "Learning may be applied only with explicit context constraints.",
            requiredConditions:
              Object.entries(scored.components)
                .filter(([,value])=>value<1)
                .map(([dimension])=>dimension),
            createdAt:new Date().toISOString()
          };

          await global.INFINICUS.CL.applicabilityStore.put(
            "restrictions",
            restriction
          );

          restrictions.push(restriction);
        }
      }
    }

    const confidenceHandoff={
      learningConfidenceHandoffId:
        runtime.createId("cl_learning_confidence_handoff"),
      targetBlock:"CL-06",
      learningPackageIntakeId:
        handoff.data.learningPackageIntakeId,
      outcomeLearningPackageId:
        handoff.data.outcomeLearningPackageId,
      outcomeVerdictId:
        handoff.data.outcomeVerdictId,
      classifications:
        handoff.data.classifications.map(runtime.clone),
      unclassifiedItems:
        handoff.data.unclassifiedItems.map(runtime.clone),
      applicabilityAssessments:
        assessments.map(runtime.clone),
      applicabilityRestrictions:
        restrictions.map(runtime.clone),
      learningEvidence:
        handoff.data.learningEvidence.map(runtime.clone),
      provenance:
        handoff.data.provenance.map(runtime.clone),
      limitations:
        handoff.data.limitations.map(runtime.clone),
      declaredApplicabilityScope:
        handoff.data.declaredApplicabilityScope,
      confidence:
        handoff.data.confidence,
      reliability:
        handoff.data.reliability,
      correlationId:
        handoff.data.correlationId,
      lineage:
        handoff.data.lineage.map(runtime.clone),
      status:"ready",
      createdAt:new Date().toISOString()
    };

    await global.INFINICUS.CL.applicabilityStore.put(
      "handoffs",
      confidenceHandoff
    );

    await runtime.emit(
      "cl.applicability.assessed",
      {
        assessmentCount:assessments.length,
        restrictionCount:restrictions.length,
        learningConfidenceHandoffId:
          confidenceHandoff.learningConfidenceHandoffId
      }
    );

    return runtime.success({
      applicabilityAssessments:assessments,
      applicabilityRestrictions:restrictions,
      learningConfidenceHandoff:confidenceHandoff
    });
  }

  const api=Object.freeze({
    registerPolicy,
    registerContext,
    assess,
    getAssessment:({applicabilityAssessmentId}) =>
      global.INFINICUS.CL.applicabilityStore.get(
        "assessments",
        applicabilityAssessmentId
      ),
    getLearningConfidenceHandoff:({
      learningConfidenceHandoffId
    }) =>
      global.INFINICUS.CL.applicabilityStore.get(
        "handoffs",
        learningConfidenceHandoffId
      ),
    listAssessments:() =>
      global.INFINICUS.CL.applicabilityStore.list(
        "assessments"
      ),
    listRestrictions:() =>
      global.INFINICUS.CL.applicabilityStore.list(
        "restrictions"
      )
  });

  runtime.registerService(
    "cl.applicability_scope_context",
    api,
    {block:"CL-05"}
  );

  runtime.registerRoute(
    "cl.applicability_policy.register",
    registerPolicy
  );

  runtime.registerRoute(
    "cl.context_profile.register",
    registerContext
  );

  runtime.registerRoute(
    "cl.applicability.assess",
    assess
  );

  global.INFINICUS.CL.applicabilityScopeContextEngine=api;
})(window);

/* ===== INFINICUS-CL-06-Learning-Confidence-Reliability-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-06-Learning-Confidence-Reliability-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;

  if(!CL?.runtime){
    throw new Error("CL-01 must be loaded before CL-06.");
  }

  if(!CL?.applicabilityScopeContextEngine){
    throw new Error("CL-05 must be loaded before CL-06.");
  }
})(window);

/* --- continuous-learning/INFINICUS-CL-06-Learning-Confidence-Reliability-Engine/src/model/confidence-policy.js --- */
(function(global){
  "use strict";

  function create(input={}){
    const runtime=global.INFINICUS.CL.runtime;

    if(!input.name || !input.code){
      return runtime.failure(
        "CL_CONFIDENCE_POLICY_INVALID",
        "Learning confidence policy name and code are required."
      );
    }

    return runtime.success({
      learningConfidencePolicyId:
        input.learningConfidencePolicyId ||
        runtime.createId("cl_learning_confidence_policy"),
      name:String(input.name),
      code:String(input.code),
      weights:runtime.clone(input.weights || {
        evidenceConfidence:0.25,
        evidenceReliability:0.2,
        classificationConfidence:0.15,
        applicabilityConfidence:0.2,
        provenanceCompleteness:0.1,
        lineageCompleteness:0.1
      }),
      limitationPenalty:
        Math.max(0,Math.min(1,Number(input.limitationPenalty ?? 0.05))),
      restrictionPenalty:
        Math.max(0,Math.min(1,Number(input.restrictionPenalty ?? 0.15))),
      unclassifiedPenalty:
        Math.max(0,Math.min(1,Number(input.unclassifiedPenalty ?? 0.25))),
      eligibleThreshold:
        Math.max(0,Math.min(1,Number(input.eligibleThreshold ?? 0.75))),
      reviewThreshold:
        Math.max(0,Math.min(1,Number(input.reviewThreshold ?? 0.5))),
      status:String(input.status || "active"),
      createdAt:new Date().toISOString()
    });
  }

  global.INFINICUS.CL.learningConfidencePolicyModel=
    Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-06-Learning-Confidence-Reliability-Engine/src/scoring/learning-confidence-scorer.js --- */
(function(global){
  "use strict";

  const bounded=value=>
    Math.max(0,Math.min(1,Number(value || 0)));

  function score({
    dimensions,
    limitationCount=0,
    restrictionCount=0,
    unclassified=false,
    policy
  }={}){
    const totalWeight=
      Object.values(policy.weights).reduce(
        (sum,value)=>sum+Number(value || 0),
        0
      ) || 1;

    const baseConfidence=
      Object.entries(policy.weights).reduce(
        (sum,[key,weight])=>
          sum+bounded(dimensions[key])*Number(weight || 0),
        0
      ) / totalWeight;

    const penalties={
      limitations:
        Math.min(
          1,
          Number(limitationCount || 0) *
          policy.limitationPenalty
        ),
      restrictions:
        Math.min(
          1,
          Number(restrictionCount || 0) *
          policy.restrictionPenalty
        ),
      unclassified:
        unclassified ? policy.unclassifiedPenalty : 0
    };

    const totalPenalty=
      Math.min(
        1,
        penalties.limitations +
        penalties.restrictions +
        penalties.unclassified
      );

    const confidence=
      Math.max(
        0,
        Math.min(1,baseConfidence-totalPenalty)
      );

    const reliability=
      Math.max(
        0,
        Math.min(
          1,
          bounded(dimensions.evidenceReliability)*0.4 +
          bounded(dimensions.provenanceCompleteness)*0.25 +
          bounded(dimensions.lineageCompleteness)*0.2 +
          bounded(dimensions.applicabilityConfidence)*0.15 -
          penalties.restrictions*0.5
        )
      );

    let eligibility="ineligible";

    if(
      confidence>=policy.eligibleThreshold &&
      reliability>=policy.eligibleThreshold
    ){
      eligibility="eligible";
    }else if(
      confidence>=policy.reviewThreshold &&
      reliability>=policy.reviewThreshold
    ){
      eligibility="review_required";
    }

    return {
      baseConfidence:Number(baseConfidence.toFixed(4)),
      penalties,
      totalPenalty:Number(totalPenalty.toFixed(4)),
      confidenceScore:Number(confidence.toFixed(4)),
      reliabilityScore:Number(reliability.toFixed(4)),
      confidenceBand:
        confidence>=0.8
          ? "high"
          : confidence>=0.6
            ? "medium"
            : "low",
      reliabilityBand:
        reliability>=0.8
          ? "high"
          : reliability>=0.6
            ? "medium"
            : "low",
      eligibility
    };
  }

  global.INFINICUS.CL.learningConfidenceScorer=
    Object.freeze({score});
})(window);

/* --- continuous-learning/INFINICUS-CL-06-Learning-Confidence-Reliability-Engine/src/storage/confidence-store.js --- */
(function(global){
  "use strict";

  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_LEARNING_CONFIDENCE";
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;

    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);

      request.onupgradeneeded=()=>{
        const db=request.result;

        for(const [name,keyPath] of [
          ["policies","learningConfidencePolicyId"],
          ["ratings","learningConfidenceRatingId"],
          ["reliability","learningReliabilityRatingId"],
          ["handoffs","learningConflictHandoffId"]
        ]){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };

      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });

    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure(
        "CL_CONFIDENCE_STORAGE_ERROR",
        error?.message || "Learning confidence storage failed."
      );
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));

      return value
        ? runtime.success(structuredClone(value))
        : runtime.failure(
            "CL_CONFIDENCE_RECORD_NOT_FOUND",
            "Learning confidence record was not found.",
            {storeName,id}
          );
    }catch(error){
      return runtime.failure(
        "CL_CONFIDENCE_STORAGE_ERROR",
        error?.message || "Learning confidence retrieval failed."
      );
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure(
        "CL_CONFIDENCE_STORAGE_ERROR",
        error?.message || "Learning confidence listing failed."
      );
    }
  }

  global.INFINICUS.CL.learningConfidenceStore=
    Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-06-Learning-Confidence-Reliability-Engine/src/engine/learning-confidence-reliability-engine.js --- */
(function(global){
  "use strict";

  const runtime=global.INFINICUS.CL.runtime;

  async function registerPolicy(input={}){
    const built=
      global.INFINICUS.CL.learningConfidencePolicyModel.create(input);

    if(!built.ok) return built;

    return global.INFINICUS.CL.learningConfidenceStore.put(
      "policies",
      built.data
    );
  }

  async function rate({
    learningConfidenceHandoffId,
    learningConfidencePolicyId
  }={}){
    const handoff=
      await global.INFINICUS.CL.applicabilityScopeContextEngine
        .getLearningConfidenceHandoff({
          learningConfidenceHandoffId
        });

    if(!handoff.ok) return handoff;

    const policy=
      await global.INFINICUS.CL.learningConfidenceStore.get(
        "policies",
        learningConfidencePolicyId
      );

    if(!policy.ok) return policy;

    const ratings=[];
    const reliabilityRatings=[];

    for(const evidence of handoff.data.learningEvidence){
      const classification=
        handoff.data.classifications.find(
          item=>item.learningEvidenceId===evidence.learningEvidenceId
        );

      const applicability=
        handoff.data.applicabilityAssessments.filter(
          item=>item.learningEvidenceId===evidence.learningEvidenceId
        );

      const restrictions=
        handoff.data.applicabilityRestrictions.filter(
          restriction=>
            applicability.some(
              item=>
                item.applicabilityAssessmentId===
                restriction.applicabilityAssessmentId
            )
        );

      const provenance=
        handoff.data.provenance.filter(
          item=>item.learningEvidenceId===evidence.learningEvidenceId
        );

      const unclassified=
        handoff.data.unclassifiedItems.some(
          item=>item.learningEvidenceId===evidence.learningEvidenceId
        );

      const applicabilityConfidence=
        applicability.length
          ? applicability.reduce(
              (sum,item)=>sum+item.confidence,
              0
            ) / applicability.length
          : 0;

      const provenanceCompleteness=
        provenance.length>0 ? 1 : 0;

      const lineageCompleteness=
        Array.isArray(evidence.lineage) &&
        evidence.lineage.length
          ? 1
          : 0;

      const dimensions={
        evidenceConfidence:
          evidence.confidence,
        evidenceReliability:
          evidence.reliability,
        classificationConfidence:
          classification?.classificationConfidence || 0,
        applicabilityConfidence,
        provenanceCompleteness,
        lineageCompleteness
      };

      const scored=
        global.INFINICUS.CL.learningConfidenceScorer.score({
          dimensions,
          limitationCount:
            handoff.data.limitations.length,
          restrictionCount:
            restrictions.length,
          unclassified,
          policy:policy.data
        });

      const rating={
        learningConfidenceRatingId:
          runtime.createId("cl_learning_confidence"),
        outcomeLearningPackageId:
          handoff.data.outcomeLearningPackageId,
        learningEvidenceId:
          evidence.learningEvidenceId,
        lessonClassificationId:
          classification?.lessonClassificationId || null,
        dimensions:
          runtime.clone(dimensions),
        baseConfidence:
          scored.baseConfidence,
        penalties:
          runtime.clone(scored.penalties),
        totalPenalty:
          scored.totalPenalty,
        confidenceScore:
          scored.confidenceScore,
        confidenceBand:
          scored.confidenceBand,
        eligibility:
          scored.eligibility,
        correlationId:
          handoff.data.correlationId,
        lineage:
          evidence.lineage.map(runtime.clone),
        ratedAt:new Date().toISOString()
      };

      await global.INFINICUS.CL.learningConfidenceStore.put(
        "ratings",
        rating
      );

      const reliability={
        learningReliabilityRatingId:
          runtime.createId("cl_learning_reliability"),
        learningConfidenceRatingId:
          rating.learningConfidenceRatingId,
        learningEvidenceId:
          evidence.learningEvidenceId,
        reliabilityScore:
          scored.reliabilityScore,
        reliabilityBand:
          scored.reliabilityBand,
        provenanceCompleteness,
        lineageCompleteness,
        ratedAt:new Date().toISOString()
      };

      await global.INFINICUS.CL.learningConfidenceStore.put(
        "reliability",
        reliability
      );

      ratings.push(rating);
      reliabilityRatings.push(reliability);
    }

    const conflictHandoff={
      learningConflictHandoffId:
        runtime.createId("cl_learning_conflict_handoff"),
      targetBlock:"CL-07",
      learningPackageIntakeId:
        handoff.data.learningPackageIntakeId,
      outcomeLearningPackageId:
        handoff.data.outcomeLearningPackageId,
      outcomeVerdictId:
        handoff.data.outcomeVerdictId,
      learningEvidence:
        handoff.data.learningEvidence.map(runtime.clone),
      provenance:
        handoff.data.provenance.map(runtime.clone),
      classifications:
        handoff.data.classifications.map(runtime.clone),
      applicabilityAssessments:
        handoff.data.applicabilityAssessments.map(runtime.clone),
      applicabilityRestrictions:
        handoff.data.applicabilityRestrictions.map(runtime.clone),
      confidenceRatings:
        ratings.map(runtime.clone),
      reliabilityRatings:
        reliabilityRatings.map(runtime.clone),
      limitations:
        handoff.data.limitations.map(runtime.clone),
      declaredApplicabilityScope:
        handoff.data.declaredApplicabilityScope,
      confidence:
        ratings.length
          ? Number(
              (
                ratings.reduce(
                  (sum,item)=>sum+item.confidenceScore,
                  0
                ) / ratings.length
              ).toFixed(4)
            )
          : 0,
      reliability:
        reliabilityRatings.length
          ? Number(
              (
                reliabilityRatings.reduce(
                  (sum,item)=>sum+item.reliabilityScore,
                  0
                ) / reliabilityRatings.length
              ).toFixed(4)
            )
          : 0,
      correlationId:
        handoff.data.correlationId,
      lineage:
        handoff.data.lineage.map(runtime.clone),
      status:"ready",
      createdAt:new Date().toISOString()
    };

    await global.INFINICUS.CL.learningConfidenceStore.put(
      "handoffs",
      conflictHandoff
    );

    await runtime.emit(
      "cl.learning_confidence.rated",
      {
        ratingCount:ratings.length,
        learningConflictHandoffId:
          conflictHandoff.learningConflictHandoffId
      }
    );

    return runtime.success({
      confidenceRatings:ratings,
      reliabilityRatings,
      learningConflictHandoff:conflictHandoff
    });
  }

  const api=Object.freeze({
    registerPolicy,
    rate,
    getConfidenceRating:({learningConfidenceRatingId}) =>
      global.INFINICUS.CL.learningConfidenceStore.get(
        "ratings",
        learningConfidenceRatingId
      ),
    getLearningConflictHandoff:({
      learningConflictHandoffId
    }) =>
      global.INFINICUS.CL.learningConfidenceStore.get(
        "handoffs",
        learningConflictHandoffId
      ),
    listConfidenceRatings:() =>
      global.INFINICUS.CL.learningConfidenceStore.list(
        "ratings"
      ),
    listReliabilityRatings:() =>
      global.INFINICUS.CL.learningConfidenceStore.list(
        "reliability"
      )
  });

  runtime.registerService(
    "cl.learning_confidence_reliability",
    api,
    {block:"CL-06"}
  );

  runtime.registerRoute(
    "cl.learning_confidence_policy.register",
    registerPolicy
  );

  runtime.registerRoute(
    "cl.learning_confidence.rate",
    rate
  );

  global.INFINICUS.CL.learningConfidenceReliabilityEngine=api;
})(window);

/* ===== INFINICUS-CL-07-Duplicate-Conflict-Contradiction-Detection-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-07-Duplicate-Conflict-Contradiction-Detection-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-07.");
  if(!CL?.learningConfidenceReliabilityEngine) throw new Error("CL-06 must be loaded before CL-07.");
})(window);

/* --- continuous-learning/INFINICUS-CL-07-Duplicate-Conflict-Contradiction-Detection-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      duplicateConflictContradictionEnginePolicyId:input.duplicateConflictContradictionEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.duplicateConflictContradictionEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-07-Duplicate-Conflict-Contradiction-Detection-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_07";
  const schema=[["policies", "duplicateConflictContradictionEnginePolicyId"], ["records", "duplicateConflictContradictionEngineRecordId"], ["handoffs", "existingKnowledgeHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.duplicateConflictContradictionEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-07-Duplicate-Conflict-Contradiction-Detection-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.duplicateConflictContradictionEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.duplicateConflictContradictionEnginePolicyModel.create(input);
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
    const policyId=input.duplicateConflictContradictionEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      duplicateConflictContradictionEngineRecordId:runtime.createId("cl_record"),
      block:"CL-07",
      purpose:"Detect duplicate, conflicting, and contradictory learning items.",
      sourceBlock:"CL-06",
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
      existingKnowledgeHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-08",
      sourceBlock:"CL-07",
      sourceRecordId:record.duplicateConflictContradictionEngineRecordId,
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
    await runtime.emit("cl.learning_conflicts.detect.completed",{sourceRecordId:record.duplicateConflictContradictionEngineRecordId,handoffId:handoff.existingKnowledgeHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({duplicateConflictContradictionEngineRecordId})=>store.get("records",duplicateConflictContradictionEngineRecordId),
    getHandoff:({existingKnowledgeHandoffId})=>store.get("handoffs",existingKnowledgeHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.duplicate_conflict_contradiction_engine",api,{block:"CL-07"});

  runtime.registerRoute("cl.learning_conflict_policy.register",registerPolicy);
  runtime.registerRoute("cl.learning_conflicts.detect",process);

  global.INFINICUS.CL.duplicateConflictContradictionEngine=api;
})(window);

/* ===== INFINICUS-CL-08-Existing-Knowledge-Comparison-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-08-Existing-Knowledge-Comparison-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-08.");
  if(!CL?.duplicateConflictContradictionEngine) throw new Error("CL-07 must be loaded before CL-08.");
})(window);

/* --- continuous-learning/INFINICUS-CL-08-Existing-Knowledge-Comparison-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      existingKnowledgeComparisonEnginePolicyId:input.existingKnowledgeComparisonEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.existingKnowledgeComparisonEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-08-Existing-Knowledge-Comparison-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_08";
  const schema=[["policies", "existingKnowledgeComparisonEnginePolicyId"], ["records", "existingKnowledgeComparisonEngineRecordId"], ["handoffs", "assumptionValidationHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.existingKnowledgeComparisonEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-08-Existing-Knowledge-Comparison-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.existingKnowledgeComparisonEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.existingKnowledgeComparisonEnginePolicyModel.create(input);
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
    const policyId=input.existingKnowledgeComparisonEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      existingKnowledgeComparisonEngineRecordId:runtime.createId("cl_record"),
      block:"CL-08",
      purpose:"Compare governed learning against existing enterprise knowledge.",
      sourceBlock:"CL-07",
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
      assumptionValidationHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-09",
      sourceBlock:"CL-08",
      sourceRecordId:record.existingKnowledgeComparisonEngineRecordId,
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
    await runtime.emit("cl.existing_knowledge.compare.completed",{sourceRecordId:record.existingKnowledgeComparisonEngineRecordId,handoffId:handoff.assumptionValidationHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({existingKnowledgeComparisonEngineRecordId})=>store.get("records",existingKnowledgeComparisonEngineRecordId),
    getHandoff:({assumptionValidationHandoffId})=>store.get("handoffs",assumptionValidationHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.existing_knowledge_comparison_engine",api,{block:"CL-08"});

  runtime.registerRoute("cl.knowledge_comparison_policy.register",registerPolicy);
  runtime.registerRoute("cl.existing_knowledge.compare",process);

  global.INFINICUS.CL.existingKnowledgeComparisonEngine=api;
})(window);

/* ===== INFINICUS-CL-09-Assumption-Validation-Revision-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-09-Assumption-Validation-Revision-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-09.");
  if(!CL?.existingKnowledgeComparisonEngine) throw new Error("CL-08 must be loaded before CL-09.");
})(window);

/* --- continuous-learning/INFINICUS-CL-09-Assumption-Validation-Revision-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      assumptionValidationRevisionEnginePolicyId:input.assumptionValidationRevisionEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.assumptionValidationRevisionEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-09-Assumption-Validation-Revision-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_09";
  const schema=[["policies", "assumptionValidationRevisionEnginePolicyId"], ["records", "assumptionValidationRevisionEngineRecordId"], ["handoffs", "businessRuleLearningHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.assumptionValidationRevisionEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-09-Assumption-Validation-Revision-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.assumptionValidationRevisionEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.assumptionValidationRevisionEnginePolicyModel.create(input);
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
    const policyId=input.assumptionValidationRevisionEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      assumptionValidationRevisionEngineRecordId:runtime.createId("cl_record"),
      block:"CL-09",
      purpose:"Validate, confirm, challenge, and revise business assumptions.",
      sourceBlock:"CL-08",
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
      businessRuleLearningHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-10",
      sourceBlock:"CL-09",
      sourceRecordId:record.assumptionValidationRevisionEngineRecordId,
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
    await runtime.emit("cl.assumptions.validate.completed",{sourceRecordId:record.assumptionValidationRevisionEngineRecordId,handoffId:handoff.businessRuleLearningHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({assumptionValidationRevisionEngineRecordId})=>store.get("records",assumptionValidationRevisionEngineRecordId),
    getHandoff:({businessRuleLearningHandoffId})=>store.get("handoffs",businessRuleLearningHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.assumption_validation_revision_engine",api,{block:"CL-09"});

  runtime.registerRoute("cl.assumption_policy.register",registerPolicy);
  runtime.registerRoute("cl.assumptions.validate",process);

  global.INFINICUS.CL.assumptionValidationRevisionEngine=api;
})(window);

/* ===== INFINICUS-CL-10-Business-Rule-Learning-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-10-Business-Rule-Learning-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-10.");
  if(!CL?.assumptionValidationRevisionEngine) throw new Error("CL-09 must be loaded before CL-10.");
})(window);

/* --- continuous-learning/INFINICUS-CL-10-Business-Rule-Learning-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      businessRuleLearningEnginePolicyId:input.businessRuleLearningEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.businessRuleLearningEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-10-Business-Rule-Learning-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_10";
  const schema=[["policies", "businessRuleLearningEnginePolicyId"], ["records", "businessRuleLearningEngineRecordId"], ["handoffs", "decisionPolicyLearningHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.businessRuleLearningEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-10-Business-Rule-Learning-Engine/src/engine/engine.js --- */
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

/* ===== INFINICUS-CL-11-Decision-Policy-Learning-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-11-Decision-Policy-Learning-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-11.");
  if(!CL?.businessRuleLearningEngine) throw new Error("CL-10 must be loaded before CL-11.");
})(window);

/* --- continuous-learning/INFINICUS-CL-11-Decision-Policy-Learning-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      decisionPolicyLearningEnginePolicyId:input.decisionPolicyLearningEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.decisionPolicyLearningEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-11-Decision-Policy-Learning-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_11";
  const schema=[["policies", "decisionPolicyLearningEnginePolicyId"], ["records", "decisionPolicyLearningEngineRecordId"], ["handoffs", "riskModelLearningHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.decisionPolicyLearningEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-11-Decision-Policy-Learning-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.decisionPolicyLearningEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.decisionPolicyLearningEnginePolicyModel.create(input);
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
    const policyId=input.decisionPolicyLearningEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      decisionPolicyLearningEngineRecordId:runtime.createId("cl_record"),
      block:"CL-11",
      purpose:"Generate decision-policy updates from governed learning.",
      sourceBlock:"CL-10",
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
      riskModelLearningHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-12",
      sourceBlock:"CL-11",
      sourceRecordId:record.decisionPolicyLearningEngineRecordId,
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
    await runtime.emit("cl.decision_policies.learn.completed",{sourceRecordId:record.decisionPolicyLearningEngineRecordId,handoffId:handoff.riskModelLearningHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({decisionPolicyLearningEngineRecordId})=>store.get("records",decisionPolicyLearningEngineRecordId),
    getHandoff:({riskModelLearningHandoffId})=>store.get("handoffs",riskModelLearningHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.decision_policy_learning_engine",api,{block:"CL-11"});

  runtime.registerRoute("cl.decision_policy_learning_policy.register",registerPolicy);
  runtime.registerRoute("cl.decision_policies.learn",process);

  global.INFINICUS.CL.decisionPolicyLearningEngine=api;
})(window);

/* ===== INFINICUS-CL-12-Risk-Model-Learning-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-12-Risk-Model-Learning-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-12.");
  if(!CL?.decisionPolicyLearningEngine) throw new Error("CL-11 must be loaded before CL-12.");
})(window);

/* --- continuous-learning/INFINICUS-CL-12-Risk-Model-Learning-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      riskModelLearningEnginePolicyId:input.riskModelLearningEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.riskModelLearningEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-12-Risk-Model-Learning-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_12";
  const schema=[["policies", "riskModelLearningEnginePolicyId"], ["records", "riskModelLearningEngineRecordId"], ["handoffs", "forecastCalibrationHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.riskModelLearningEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-12-Risk-Model-Learning-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.riskModelLearningEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.riskModelLearningEnginePolicyModel.create(input);
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
    const policyId=input.riskModelLearningEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      riskModelLearningEngineRecordId:runtime.createId("cl_record"),
      block:"CL-12",
      purpose:"Update risk factors, weights, thresholds, and controls.",
      sourceBlock:"CL-11",
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
      forecastCalibrationHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-13",
      sourceBlock:"CL-12",
      sourceRecordId:record.riskModelLearningEngineRecordId,
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
    await runtime.emit("cl.risk_models.learn.completed",{sourceRecordId:record.riskModelLearningEngineRecordId,handoffId:handoff.forecastCalibrationHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({riskModelLearningEngineRecordId})=>store.get("records",riskModelLearningEngineRecordId),
    getHandoff:({forecastCalibrationHandoffId})=>store.get("handoffs",forecastCalibrationHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.risk_model_learning_engine",api,{block:"CL-12"});

  runtime.registerRoute("cl.risk_learning_policy.register",registerPolicy);
  runtime.registerRoute("cl.risk_models.learn",process);

  global.INFINICUS.CL.riskModelLearningEngine=api;
})(window);

/* ===== INFINICUS-CL-13-Forecast-Prediction-Calibration-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-13-Forecast-Prediction-Calibration-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-13.");
  if(!CL?.riskModelLearningEngine) throw new Error("CL-12 must be loaded before CL-13.");
})(window);

/* --- continuous-learning/INFINICUS-CL-13-Forecast-Prediction-Calibration-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      forecastPredictionCalibrationEnginePolicyId:input.forecastPredictionCalibrationEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.forecastPredictionCalibrationEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-13-Forecast-Prediction-Calibration-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_13";
  const schema=[["policies", "forecastPredictionCalibrationEnginePolicyId"], ["records", "forecastPredictionCalibrationEngineRecordId"], ["handoffs", "simulationCalibrationHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.forecastPredictionCalibrationEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-13-Forecast-Prediction-Calibration-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.forecastPredictionCalibrationEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.forecastPredictionCalibrationEnginePolicyModel.create(input);
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
    const policyId=input.forecastPredictionCalibrationEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      forecastPredictionCalibrationEngineRecordId:runtime.createId("cl_record"),
      block:"CL-13",
      purpose:"Calibrate forecast and prediction models using realized outcomes.",
      sourceBlock:"CL-12",
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
      simulationCalibrationHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-14",
      sourceBlock:"CL-13",
      sourceRecordId:record.forecastPredictionCalibrationEngineRecordId,
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
    await runtime.emit("cl.forecasts.calibrate.completed",{sourceRecordId:record.forecastPredictionCalibrationEngineRecordId,handoffId:handoff.simulationCalibrationHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({forecastPredictionCalibrationEngineRecordId})=>store.get("records",forecastPredictionCalibrationEngineRecordId),
    getHandoff:({simulationCalibrationHandoffId})=>store.get("handoffs",simulationCalibrationHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.forecast_prediction_calibration_engine",api,{block:"CL-13"});

  runtime.registerRoute("cl.forecast_calibration_policy.register",registerPolicy);
  runtime.registerRoute("cl.forecasts.calibrate",process);

  global.INFINICUS.CL.forecastPredictionCalibrationEngine=api;
})(window);

/* ===== INFINICUS-CL-14-Simulation-Model-Calibration-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-14-Simulation-Model-Calibration-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-14.");
  if(!CL?.forecastPredictionCalibrationEngine) throw new Error("CL-13 must be loaded before CL-14.");
})(window);

/* --- continuous-learning/INFINICUS-CL-14-Simulation-Model-Calibration-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      simulationModelCalibrationEnginePolicyId:input.simulationModelCalibrationEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.simulationModelCalibrationEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-14-Simulation-Model-Calibration-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_14";
  const schema=[["policies", "simulationModelCalibrationEnginePolicyId"], ["records", "simulationModelCalibrationEngineRecordId"], ["handoffs", "digitalTwinCalibrationHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.simulationModelCalibrationEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-14-Simulation-Model-Calibration-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.simulationModelCalibrationEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.simulationModelCalibrationEnginePolicyModel.create(input);
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
    const policyId=input.simulationModelCalibrationEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      simulationModelCalibrationEngineRecordId:runtime.createId("cl_record"),
      block:"CL-14",
      purpose:"Calibrate simulation parameters and distributions.",
      sourceBlock:"CL-13",
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
      digitalTwinCalibrationHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-15",
      sourceBlock:"CL-14",
      sourceRecordId:record.simulationModelCalibrationEngineRecordId,
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
    await runtime.emit("cl.simulations.calibrate.completed",{sourceRecordId:record.simulationModelCalibrationEngineRecordId,handoffId:handoff.digitalTwinCalibrationHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({simulationModelCalibrationEngineRecordId})=>store.get("records",simulationModelCalibrationEngineRecordId),
    getHandoff:({digitalTwinCalibrationHandoffId})=>store.get("handoffs",digitalTwinCalibrationHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.simulation_model_calibration_engine",api,{block:"CL-14"});

  runtime.registerRoute("cl.simulation_calibration_policy.register",registerPolicy);
  runtime.registerRoute("cl.simulations.calibrate",process);

  global.INFINICUS.CL.simulationModelCalibrationEngine=api;
})(window);

/* ===== INFINICUS-CL-15-Business-Digital-Twin-Calibration-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-15-Business-Digital-Twin-Calibration-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-15.");
  if(!CL?.simulationModelCalibrationEngine) throw new Error("CL-14 must be loaded before CL-15.");
})(window);

/* --- continuous-learning/INFINICUS-CL-15-Business-Digital-Twin-Calibration-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      businessDigitalTwinCalibrationEnginePolicyId:input.businessDigitalTwinCalibrationEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.businessDigitalTwinCalibrationEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-15-Business-Digital-Twin-Calibration-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_15";
  const schema=[["policies", "businessDigitalTwinCalibrationEnginePolicyId"], ["records", "businessDigitalTwinCalibrationEngineRecordId"], ["handoffs", "dataQualityLearningHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.businessDigitalTwinCalibrationEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-15-Business-Digital-Twin-Calibration-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.businessDigitalTwinCalibrationEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.businessDigitalTwinCalibrationEnginePolicyModel.create(input);
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
    const policyId=input.businessDigitalTwinCalibrationEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      businessDigitalTwinCalibrationEngineRecordId:runtime.createId("cl_record"),
      block:"CL-15",
      purpose:"Calibrate Business Digital Twin state and behavior models.",
      sourceBlock:"CL-14",
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
      dataQualityLearningHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-16",
      sourceBlock:"CL-15",
      sourceRecordId:record.businessDigitalTwinCalibrationEngineRecordId,
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
    await runtime.emit("cl.digital_twin.calibrate.completed",{sourceRecordId:record.businessDigitalTwinCalibrationEngineRecordId,handoffId:handoff.dataQualityLearningHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({businessDigitalTwinCalibrationEngineRecordId})=>store.get("records",businessDigitalTwinCalibrationEngineRecordId),
    getHandoff:({dataQualityLearningHandoffId})=>store.get("handoffs",dataQualityLearningHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.business_digital_twin_calibration_engine",api,{block:"CL-15"});

  runtime.registerRoute("cl.digital_twin_calibration_policy.register",registerPolicy);
  runtime.registerRoute("cl.digital_twin.calibrate",process);

  global.INFINICUS.CL.businessDigitalTwinCalibrationEngine=api;
})(window);

/* ===== INFINICUS-CL-16-Data-Quality-Observation-Learning-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-16-Data-Quality-Observation-Learning-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-16.");
  if(!CL?.businessDigitalTwinCalibrationEngine) throw new Error("CL-15 must be loaded before CL-16.");
})(window);

/* --- continuous-learning/INFINICUS-CL-16-Data-Quality-Observation-Learning-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      dataQualityObservationLearningEnginePolicyId:input.dataQualityObservationLearningEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.dataQualityObservationLearningEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-16-Data-Quality-Observation-Learning-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_16";
  const schema=[["policies", "dataQualityObservationLearningEnginePolicyId"], ["records", "dataQualityObservationLearningEngineRecordId"], ["handoffs", "operationalImprovementHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.dataQualityObservationLearningEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-16-Data-Quality-Observation-Learning-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.dataQualityObservationLearningEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.dataQualityObservationLearningEnginePolicyModel.create(input);
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
    const policyId=input.dataQualityObservationLearningEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      dataQualityObservationLearningEngineRecordId:runtime.createId("cl_record"),
      block:"CL-16",
      purpose:"Learn from observation quality, source reliability, and missing-data patterns.",
      sourceBlock:"CL-15",
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
      operationalImprovementHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-17",
      sourceBlock:"CL-16",
      sourceRecordId:record.dataQualityObservationLearningEngineRecordId,
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
    await runtime.emit("cl.data_quality.learn.completed",{sourceRecordId:record.dataQualityObservationLearningEngineRecordId,handoffId:handoff.operationalImprovementHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({dataQualityObservationLearningEngineRecordId})=>store.get("records",dataQualityObservationLearningEngineRecordId),
    getHandoff:({operationalImprovementHandoffId})=>store.get("handoffs",operationalImprovementHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.data_quality_observation_learning_engine",api,{block:"CL-16"});

  runtime.registerRoute("cl.data_quality_learning_policy.register",registerPolicy);
  runtime.registerRoute("cl.data_quality.learn",process);

  global.INFINICUS.CL.dataQualityObservationLearningEngine=api;
})(window);

/* ===== INFINICUS-CL-17-Operational-Process-Improvement-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-17-Operational-Process-Improvement-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-17.");
  if(!CL?.dataQualityObservationLearningEngine) throw new Error("CL-16 must be loaded before CL-17.");
})(window);

/* --- continuous-learning/INFINICUS-CL-17-Operational-Process-Improvement-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      operationalProcessImprovementEnginePolicyId:input.operationalProcessImprovementEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.operationalProcessImprovementEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-17-Operational-Process-Improvement-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_17";
  const schema=[["policies", "operationalProcessImprovementEnginePolicyId"], ["records", "operationalProcessImprovementEngineRecordId"], ["handoffs", "benefitAdverseLearningHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.operationalProcessImprovementEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-17-Operational-Process-Improvement-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.operationalProcessImprovementEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.operationalProcessImprovementEnginePolicyModel.create(input);
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
    const policyId=input.operationalProcessImprovementEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      operationalProcessImprovementEngineRecordId:runtime.createId("cl_record"),
      block:"CL-17",
      purpose:"Generate controlled operational process improvements.",
      sourceBlock:"CL-16",
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
      benefitAdverseLearningHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-18",
      sourceBlock:"CL-17",
      sourceRecordId:record.operationalProcessImprovementEngineRecordId,
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
    await runtime.emit("cl.operations.improve.completed",{sourceRecordId:record.operationalProcessImprovementEngineRecordId,handoffId:handoff.benefitAdverseLearningHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({operationalProcessImprovementEngineRecordId})=>store.get("records",operationalProcessImprovementEngineRecordId),
    getHandoff:({benefitAdverseLearningHandoffId})=>store.get("handoffs",benefitAdverseLearningHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.operational_process_improvement_engine",api,{block:"CL-17"});

  runtime.registerRoute("cl.operational_learning_policy.register",registerPolicy);
  runtime.registerRoute("cl.operations.improve",process);

  global.INFINICUS.CL.operationalProcessImprovementEngine=api;
})(window);

/* ===== INFINICUS-CL-18-Benefit-Adverse-Outcome-Learning-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-18-Benefit-Adverse-Outcome-Learning-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-18.");
  if(!CL?.operationalProcessImprovementEngine) throw new Error("CL-17 must be loaded before CL-18.");
})(window);

/* --- continuous-learning/INFINICUS-CL-18-Benefit-Adverse-Outcome-Learning-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      benefitAdverseOutcomeLearningEnginePolicyId:input.benefitAdverseOutcomeLearningEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.benefitAdverseOutcomeLearningEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-18-Benefit-Adverse-Outcome-Learning-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_18";
  const schema=[["policies", "benefitAdverseOutcomeLearningEnginePolicyId"], ["records", "benefitAdverseOutcomeLearningEngineRecordId"], ["handoffs", "learningRecommendationHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.benefitAdverseOutcomeLearningEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-18-Benefit-Adverse-Outcome-Learning-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.benefitAdverseOutcomeLearningEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.benefitAdverseOutcomeLearningEnginePolicyModel.create(input);
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
    const policyId=input.benefitAdverseOutcomeLearningEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      benefitAdverseOutcomeLearningEngineRecordId:runtime.createId("cl_record"),
      block:"CL-18",
      purpose:"Learn jointly from realized benefits and adverse outcomes.",
      sourceBlock:"CL-17",
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
      learningRecommendationHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-19",
      sourceBlock:"CL-18",
      sourceRecordId:record.benefitAdverseOutcomeLearningEngineRecordId,
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
    await runtime.emit("cl.benefit_adverse.learn.completed",{sourceRecordId:record.benefitAdverseOutcomeLearningEngineRecordId,handoffId:handoff.learningRecommendationHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({benefitAdverseOutcomeLearningEngineRecordId})=>store.get("records",benefitAdverseOutcomeLearningEngineRecordId),
    getHandoff:({learningRecommendationHandoffId})=>store.get("handoffs",learningRecommendationHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.benefit_adverse_outcome_learning_engine",api,{block:"CL-18"});

  runtime.registerRoute("cl.benefit_adverse_learning_policy.register",registerPolicy);
  runtime.registerRoute("cl.benefit_adverse.learn",process);

  global.INFINICUS.CL.benefitAdverseOutcomeLearningEngine=api;
})(window);

/* ===== INFINICUS-CL-19-Learning-Recommendation-Generation-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-19-Learning-Recommendation-Generation-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-19.");
  if(!CL?.benefitAdverseOutcomeLearningEngine) throw new Error("CL-18 must be loaded before CL-19.");
})(window);

/* --- continuous-learning/INFINICUS-CL-19-Learning-Recommendation-Generation-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      learningRecommendationGenerationEnginePolicyId:input.learningRecommendationGenerationEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.learningRecommendationGenerationEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-19-Learning-Recommendation-Generation-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_19";
  const schema=[["policies", "learningRecommendationGenerationEnginePolicyId"], ["records", "learningRecommendationGenerationEngineRecordId"], ["handoffs", "learningGovernanceHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.learningRecommendationGenerationEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-19-Learning-Recommendation-Generation-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.learningRecommendationGenerationEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.learningRecommendationGenerationEnginePolicyModel.create(input);
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
    const policyId=input.learningRecommendationGenerationEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      learningRecommendationGenerationEngineRecordId:runtime.createId("cl_record"),
      block:"CL-19",
      purpose:"Generate prioritized, evidence-backed learning recommendations.",
      sourceBlock:"CL-18",
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
      learningGovernanceHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-20",
      sourceBlock:"CL-19",
      sourceRecordId:record.learningRecommendationGenerationEngineRecordId,
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
    await runtime.emit("cl.learning_recommendations.generate.completed",{sourceRecordId:record.learningRecommendationGenerationEngineRecordId,handoffId:handoff.learningGovernanceHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({learningRecommendationGenerationEngineRecordId})=>store.get("records",learningRecommendationGenerationEngineRecordId),
    getHandoff:({learningGovernanceHandoffId})=>store.get("handoffs",learningGovernanceHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.learning_recommendation_generation_engine",api,{block:"CL-19"});

  runtime.registerRoute("cl.learning_recommendation_policy.register",registerPolicy);
  runtime.registerRoute("cl.learning_recommendations.generate",process);

  global.INFINICUS.CL.learningRecommendationGenerationEngine=api;
})(window);

/* ===== INFINICUS-CL-20-Learning-Governance-Approval-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-20-Learning-Governance-Approval-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-20.");
  if(!CL?.learningRecommendationGenerationEngine) throw new Error("CL-19 must be loaded before CL-20.");
})(window);

/* --- continuous-learning/INFINICUS-CL-20-Learning-Governance-Approval-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      learningGovernanceApprovalEnginePolicyId:input.learningGovernanceApprovalEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.learningGovernanceApprovalEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-20-Learning-Governance-Approval-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_20";
  const schema=[["policies", "learningGovernanceApprovalEnginePolicyId"], ["records", "learningGovernanceApprovalEngineRecordId"], ["handoffs", "controlledKnowledgeUpdateHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.learningGovernanceApprovalEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-20-Learning-Governance-Approval-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.learningGovernanceApprovalEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.learningGovernanceApprovalEnginePolicyModel.create(input);
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
    const policyId=input.learningGovernanceApprovalEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      learningGovernanceApprovalEngineRecordId:runtime.createId("cl_record"),
      block:"CL-20",
      purpose:"Govern, approve, reject, or revise proposed learning changes.",
      sourceBlock:"CL-19",
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
      controlledKnowledgeUpdateHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-21",
      sourceBlock:"CL-20",
      sourceRecordId:record.learningGovernanceApprovalEngineRecordId,
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
    await runtime.emit("cl.learning_changes.review.completed",{sourceRecordId:record.learningGovernanceApprovalEngineRecordId,handoffId:handoff.controlledKnowledgeUpdateHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({learningGovernanceApprovalEngineRecordId})=>store.get("records",learningGovernanceApprovalEngineRecordId),
    getHandoff:({controlledKnowledgeUpdateHandoffId})=>store.get("handoffs",controlledKnowledgeUpdateHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.learning_governance_approval_engine",api,{block:"CL-20"});

  runtime.registerRoute("cl.learning_governance_policy.register",registerPolicy);
  runtime.registerRoute("cl.learning_changes.review",process);

  global.INFINICUS.CL.learningGovernanceApprovalEngine=api;
})(window);

/* ===== INFINICUS-CL-21-Controlled-Knowledge-Update-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-21-Controlled-Knowledge-Update-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-21.");
  if(!CL?.learningGovernanceApprovalEngine) throw new Error("CL-20 must be loaded before CL-21.");
})(window);

/* --- continuous-learning/INFINICUS-CL-21-Controlled-Knowledge-Update-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      controlledKnowledgeUpdateEnginePolicyId:input.controlledKnowledgeUpdateEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.controlledKnowledgeUpdateEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-21-Controlled-Knowledge-Update-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_21";
  const schema=[["policies", "controlledKnowledgeUpdateEnginePolicyId"], ["records", "controlledKnowledgeUpdateEngineRecordId"], ["handoffs", "modelRuleDeploymentHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.controlledKnowledgeUpdateEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-21-Controlled-Knowledge-Update-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.controlledKnowledgeUpdateEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.controlledKnowledgeUpdateEnginePolicyModel.create(input);
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
    const policyId=input.controlledKnowledgeUpdateEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      controlledKnowledgeUpdateEngineRecordId:runtime.createId("cl_record"),
      block:"CL-21",
      purpose:"Apply approved learning changes to controlled knowledge stores.",
      sourceBlock:"CL-20",
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
      modelRuleDeploymentHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-22",
      sourceBlock:"CL-21",
      sourceRecordId:record.controlledKnowledgeUpdateEngineRecordId,
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
    await runtime.emit("cl.knowledge_updates.apply.completed",{sourceRecordId:record.controlledKnowledgeUpdateEngineRecordId,handoffId:handoff.modelRuleDeploymentHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({controlledKnowledgeUpdateEngineRecordId})=>store.get("records",controlledKnowledgeUpdateEngineRecordId),
    getHandoff:({modelRuleDeploymentHandoffId})=>store.get("handoffs",modelRuleDeploymentHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.controlled_knowledge_update_engine",api,{block:"CL-21"});

  runtime.registerRoute("cl.knowledge_update_policy.register",registerPolicy);
  runtime.registerRoute("cl.knowledge_updates.apply",process);

  global.INFINICUS.CL.controlledKnowledgeUpdateEngine=api;
})(window);

/* ===== INFINICUS-CL-22-Model-Rule-Policy-Deployment-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-22-Model-Rule-Policy-Deployment-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-22.");
  if(!CL?.controlledKnowledgeUpdateEngine) throw new Error("CL-21 must be loaded before CL-22.");
})(window);

/* --- continuous-learning/INFINICUS-CL-22-Model-Rule-Policy-Deployment-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      modelRulePolicyDeploymentEnginePolicyId:input.modelRulePolicyDeploymentEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.modelRulePolicyDeploymentEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-22-Model-Rule-Policy-Deployment-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_22";
  const schema=[["policies", "modelRulePolicyDeploymentEnginePolicyId"], ["records", "modelRulePolicyDeploymentEngineRecordId"], ["handoffs", "learningImpactVerificationHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.modelRulePolicyDeploymentEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-22-Model-Rule-Policy-Deployment-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.modelRulePolicyDeploymentEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.modelRulePolicyDeploymentEnginePolicyModel.create(input);
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
    const policyId=input.modelRulePolicyDeploymentEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      modelRulePolicyDeploymentEngineRecordId:runtime.createId("cl_record"),
      block:"CL-22",
      purpose:"Deploy approved model, rule, and policy updates.",
      sourceBlock:"CL-21",
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
      learningImpactVerificationHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-23",
      sourceBlock:"CL-22",
      sourceRecordId:record.modelRulePolicyDeploymentEngineRecordId,
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
    await runtime.emit("cl.learning_updates.deploy.completed",{sourceRecordId:record.modelRulePolicyDeploymentEngineRecordId,handoffId:handoff.learningImpactVerificationHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({modelRulePolicyDeploymentEngineRecordId})=>store.get("records",modelRulePolicyDeploymentEngineRecordId),
    getHandoff:({learningImpactVerificationHandoffId})=>store.get("handoffs",learningImpactVerificationHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.model_rule_policy_deployment_engine",api,{block:"CL-22"});

  runtime.registerRoute("cl.learning_deployment_policy.register",registerPolicy);
  runtime.registerRoute("cl.learning_updates.deploy",process);

  global.INFINICUS.CL.modelRulePolicyDeploymentEngine=api;
})(window);

/* ===== INFINICUS-CL-23-Learning-Impact-Verification-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-23-Learning-Impact-Verification-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-23.");
  if(!CL?.modelRulePolicyDeploymentEngine) throw new Error("CL-22 must be loaded before CL-23.");
})(window);

/* --- continuous-learning/INFINICUS-CL-23-Learning-Impact-Verification-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      learningImpactVerificationEnginePolicyId:input.learningImpactVerificationEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.learningImpactVerificationEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-23-Learning-Impact-Verification-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_23";
  const schema=[["policies", "learningImpactVerificationEnginePolicyId"], ["records", "learningImpactVerificationEngineRecordId"], ["handoffs", "updatedIntelligenceHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.learningImpactVerificationEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-23-Learning-Impact-Verification-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.learningImpactVerificationEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.learningImpactVerificationEnginePolicyModel.create(input);
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
    const policyId=input.learningImpactVerificationEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      learningImpactVerificationEngineRecordId:runtime.createId("cl_record"),
      block:"CL-23",
      purpose:"Verify whether deployed learning improved future performance.",
      sourceBlock:"CL-22",
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
      updatedIntelligenceHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-24",
      sourceBlock:"CL-23",
      sourceRecordId:record.learningImpactVerificationEngineRecordId,
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
    await runtime.emit("cl.learning_impact.verify.completed",{sourceRecordId:record.learningImpactVerificationEngineRecordId,handoffId:handoff.updatedIntelligenceHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({learningImpactVerificationEngineRecordId})=>store.get("records",learningImpactVerificationEngineRecordId),
    getHandoff:({updatedIntelligenceHandoffId})=>store.get("handoffs",updatedIntelligenceHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.learning_impact_verification_engine",api,{block:"CL-23"});

  runtime.registerRoute("cl.learning_impact_policy.register",registerPolicy);
  runtime.registerRoute("cl.learning_impact.verify",process);

  global.INFINICUS.CL.learningImpactVerificationEngine=api;
})(window);

/* ===== INFINICUS-CL-24-Updated-Intelligence-Publication-Handoff-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-24-Updated-Intelligence-Publication-Handoff-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-24.");
  if(!CL?.learningImpactVerificationEngine) throw new Error("CL-23 must be loaded before CL-24.");
})(window);

/* --- continuous-learning/INFINICUS-CL-24-Updated-Intelligence-Publication-Handoff-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  function create(input={}){
    if(!input.name || !input.code){
      return runtime.failure("CL_POLICY_INVALID","Policy name and code are required.");
    }
    return runtime.success({
      updatedIntelligencePublicationEnginePolicyId:input.updatedIntelligencePublicationEnginePolicyId||runtime.createId("cl_policy"),
      name:String(input.name),
      code:String(input.code),
      minimumConfidence:Math.max(0,Math.min(1,Number(input.minimumConfidence??0.5))),
      minimumReliability:Math.max(0,Math.min(1,Number(input.minimumReliability??0.5))),
      requireHumanReview:input.requireHumanReview===undefined ? true : Boolean(input.requireHumanReview),
      status:String(input.status||"active"),
      createdAt:new Date().toISOString()
    });
  }
  global.INFINICUS.CL.updatedIntelligencePublicationEnginePolicyModel=Object.freeze({create});
})(window);

/* --- continuous-learning/INFINICUS-CL-24-Updated-Intelligence-Publication-Handoff-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_24";
  const schema=[["policies", "updatedIntelligencePublicationEnginePolicyId"], ["records", "updatedIntelligencePublicationEngineRecordId"], ["handoffs", "continuousLearningAssemblyHandoffId"], ["events", "eventId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.updatedIntelligencePublicationEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-24-Updated-Intelligence-Publication-Handoff-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.updatedIntelligencePublicationEngineStore;

  async function registerPolicy(input={}){
    const built=global.INFINICUS.CL.updatedIntelligencePublicationEnginePolicyModel.create(input);
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
    const policyId=input.updatedIntelligencePublicationEnginePolicyId;
    const policy=await store.get("policies",policyId);
    if(!policy.ok) return policy;

    const upstream=input.upstreamHandoff||input.payload||{};
    const gate=evaluateGate(upstream,input,policy);
    const {status,confidence,reliability}=gate;

    const record={
      updatedIntelligencePublicationEngineRecordId:runtime.createId("cl_record"),
      block:"CL-24",
      purpose:"Publish governed updates to downstream INFINICUS intelligence layers.",
      sourceBlock:"CL-23",
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
      continuousLearningAssemblyHandoffId:runtime.createId("cl_handoff"),
      targetBlock:"CL-25",
      sourceBlock:"CL-24",
      sourceRecordId:record.updatedIntelligencePublicationEngineRecordId,
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
    await runtime.emit("cl.updated_intelligence.publish.completed",{sourceRecordId:record.updatedIntelligencePublicationEngineRecordId,handoffId:handoff.continuousLearningAssemblyHandoffId});
    return runtime.success({record,handoff});
  }


  const api=Object.freeze({registerPolicy,process,
    getRecord:({updatedIntelligencePublicationEngineRecordId})=>store.get("records",updatedIntelligencePublicationEngineRecordId),
    getHandoff:({continuousLearningAssemblyHandoffId})=>store.get("handoffs",continuousLearningAssemblyHandoffId),
    listRecords:()=>store.list("records")});
  runtime.registerService("cl.updated_intelligence_publication_engine",api,{block:"CL-24"});

  runtime.registerRoute("cl.updated_intelligence_policy.register",registerPolicy);
  runtime.registerRoute("cl.updated_intelligence.publish",process);

  global.INFINICUS.CL.updatedIntelligencePublicationEngine=api;
})(window);

/* ===== INFINICUS-CL-25-Master-Integration-Production-Assembly-Deployment-Engine ===== */

/* --- continuous-learning/INFINICUS-CL-25-Master-Integration-Production-Assembly-Deployment-Engine/src/core/runtime-guard.js --- */
(function(global){
  "use strict";
  const CL=global.INFINICUS?.CL;
  if(!CL?.runtime) throw new Error("CL-01 must be loaded before CL-25.");
  if(!CL?.updatedIntelligencePublicationEngine) throw new Error("CL-24 must be loaded before CL-25.");
})(window);

/* --- continuous-learning/INFINICUS-CL-25-Master-Integration-Production-Assembly-Deployment-Engine/src/model/policy.js --- */
(function(global){
  "use strict";
  global.INFINICUS.CL.masterIntegrationEnginePolicyModel=Object.freeze({});
})(window);

/* --- continuous-learning/INFINICUS-CL-25-Master-Integration-Production-Assembly-Deployment-Engine/src/storage/store.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const DB_NAME="INFINICUS_CL_25";
  const schema=[["records", "continuousLearningAssemblyId"], ["handoffs", "deploymentReceiptId"], ["events", "continuousLearningRollbackId"]];
  let dbPromise;

  const reqp=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        for(const [name,keyPath] of schema){
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name,{keyPath});
          }
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    return dbPromise;
  }

  async function put(storeName,record){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readwrite");
      await reqp(tx.objectStore(storeName).put(structuredClone(record)));
      return runtime.success(structuredClone(record));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Storage failed.");
    }
  }

  async function get(storeName,id){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const value=await reqp(tx.objectStore(storeName).get(id));
      return value ? runtime.success(structuredClone(value))
        : runtime.failure("CL_RECORD_NOT_FOUND","Record was not found.",{storeName,id});
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Retrieval failed.");
    }
  }

  async function list(storeName){
    try{
      const db=await open();
      const tx=db.transaction(storeName,"readonly");
      const values=await reqp(tx.objectStore(storeName).getAll());
      return runtime.success(values.map(structuredClone));
    }catch(error){
      return runtime.failure("CL_STORAGE_ERROR",error?.message||"Listing failed.");
    }
  }

  global.INFINICUS.CL.masterIntegrationEngineStore=Object.freeze({open,put,get,list});
})(window);

/* --- continuous-learning/INFINICUS-CL-25-Master-Integration-Production-Assembly-Deployment-Engine/src/engine/engine.js --- */
(function(global){
  "use strict";
  const runtime=global.INFINICUS.CL.runtime;
  const store=global.INFINICUS.CL.masterIntegrationEngineStore;


  function diagnose(){
    const required=[
      "runtime","learningPackageIntakeEngine","learningEvidenceProvenanceRegistryEngine",
      "lessonClassificationTaxonomyEngine","applicabilityScopeContextEngine",
      "learningConfidenceReliabilityEngine","duplicateConflictContradictionEngine",
      "existingKnowledgeComparisonEngine","assumptionValidationRevisionEngine",
      "businessRuleLearningEngine","decisionPolicyLearningEngine","riskModelLearningEngine",
      "forecastPredictionCalibrationEngine","simulationModelCalibrationEngine",
      "businessDigitalTwinCalibrationEngine","dataQualityObservationLearningEngine",
      "operationalProcessImprovementEngine","benefitAdverseOutcomeLearningEngine",
      "learningRecommendationGenerationEngine","learningGovernanceApprovalEngine",
      "controlledKnowledgeUpdateEngine","modelRulePolicyDeploymentEngine",
      "learningImpactVerificationEngine","updatedIntelligencePublicationEngine"
    ];
    const missing=required.filter(key=>!global.INFINICUS.CL[key]);
    return runtime.success({
      layer:"Continuous Learning",
      totalBlocks:25,
      verifiedBlocks:25-missing.length,
      missing,
      productionReady:missing.length===0
    });
  }

  async function assemble(input={}){
    const diagnostics=diagnose();
    if(!diagnostics.data.productionReady){
      return runtime.failure("CL_LAYER_NOT_READY","Continuous Learning layer is incomplete.",diagnostics.data);
    }
    const assembly={
      continuousLearningAssemblyId:runtime.createId("cl_assembly"),
      releaseVersion:String(input.releaseVersion||"1.0.0"),
      environment:String(input.environment||"staging"),
      blocks:Array.from({length:25},(_,i)=>`CL-${String(i+1).padStart(2,"0")}`),
      state:"assembled",
      createdAt:new Date().toISOString()
    };
    await store.put("records",assembly);
    return runtime.success({assembly});
  }

  async function deploy(input={}){
    const deployment={
      continuousLearningDeploymentId:runtime.createId("cl_deployment"),
      adapterType:String(input.adapterType||"manual"),
      releaseVersion:String(input.releaseVersion||"1.0.0"),
      state:"deployed",
      deploymentReference:input.deploymentReference||null,
      deployedAt:new Date().toISOString()
    };
    await store.put("handoffs",{deploymentReceiptId:runtime.createId("cl_deployment_receipt"),...deployment});
    return runtime.success({deployment});
  }

  async function recordRollback(input={}){
    const rollback={
      continuousLearningRollbackId:runtime.createId("cl_rollback"),
      reason:String(input.reason||""),
      rollbackVersion:String(input.rollbackVersion||""),
      state:"recorded",
      createdAt:new Date().toISOString()
    };
    await store.put("events",rollback);
    return runtime.success({rollback});
  }

  const api=Object.freeze({diagnose,assemble,deploy,recordRollback});
  runtime.registerService("cl.master_integration_engine",api,{block:"CL-25"});

  runtime.registerRoute("cl.master.diagnose",diagnose);
  runtime.registerRoute("cl.master.assemble",assemble);
  runtime.registerRoute("cl.master.deploy",deploy);
  runtime.registerRoute("cl.master.rollback.record",recordRollback);

  global.INFINICUS.CL.masterIntegrationEngine=api;
})(window);
