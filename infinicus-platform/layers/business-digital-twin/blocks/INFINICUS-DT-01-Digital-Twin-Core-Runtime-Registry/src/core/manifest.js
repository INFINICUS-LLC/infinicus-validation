(function (global) {
  "use strict";

  const blocks = Object.freeze([
    ["DT-01", "Digital Twin Core Runtime and Registry"],
    ["DT-02", "Business Identity and Twin Instance Registry"],
    ["DT-03", "Twin Schema and Business Ontology Engine"],
    ["DT-04", "Intelligence Package Intake and Validation Engine"],
    ["DT-05", "Business Entity and Relationship Graph Engine"],
    ["DT-06", "Organizational Structure Twin Engine"],
    ["DT-07", "Financial State Twin Engine"],
    ["DT-08", "Customer and Demand Twin Engine"],
    ["DT-09", "Sales and Revenue Flow Twin Engine"],
    ["DT-10", "Marketing and Acquisition Twin Engine"],
    ["DT-11", "Operations and Process Twin Engine"],
    ["DT-12", "Inventory and Supply Network Twin Engine"],
    ["DT-13", "Workforce and Capability Twin Engine"],
    ["DT-14", "Asset, Facility and Infrastructure Twin Engine"],
    ["DT-15", "Market and Competitive Environment Twin Engine"],
    ["DT-16", "Business State Synchronization Engine"],
    ["DT-17", "State Transition and Business Event Engine"],
    ["DT-18", "Constraint, Rule and Dependency Engine"],
    ["DT-19", "Risk and Vulnerability State Engine"],
    ["DT-20", "Opportunity and Strategic Position Engine"],
    ["DT-21", "Twin Integrity, Consistency and Confidence Engine"],
    ["DT-22", "Historical State, Snapshot and Timeline Engine"],
    ["DT-23", "Scenario Baseline and Initial Conditions Engine"],
    ["DT-24", "Simulation Package Publication and Handoff Engine"]
  ].map(([blockId, name], index) => ({
    blockId,
    order: index + 1,
    name
  })));

  global.INFINICUS.DT.manifest =
    Object.freeze({
      layer: "Business Digital Twin",
      version: "1.0.0",
      blockCount: blocks.length,
      blocks
    });
})(window);
