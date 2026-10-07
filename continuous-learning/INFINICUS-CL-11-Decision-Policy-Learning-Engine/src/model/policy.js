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
