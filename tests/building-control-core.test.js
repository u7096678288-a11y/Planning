"use strict";

const assert = require("assert");
const core = require("../building-control-match-core.js");

const planning = [
  {
    OBJECTID: 1,
    PlanningAuthority: "Dublin City Council",
    ApplicationNumber: "LRD6007/23-S3",
    AppealRefNumber: "ABP-318456-23",
    DevelopmentAddress: "Example Road, Dublin 4, D04 AB12",
    DevelopmentDescription: "120 apartments",
    NumResidentialUnits: 120,
    GrantDate: "2023-09-01",
    __lat: 53.33,
    __lng: -6.23
  },
  {
    OBJECTID: 2,
    PlanningAuthority: "Dublin City Council",
    ApplicationNumber: "1234/23",
    DevelopmentAddress: "Other Street, Dublin 2",
    NumResidentialUnits: 20,
    __lat: 53.34,
    __lng: -6.25
  }
];

const nbco = [
  {
    IDs: "1",
    LocalAuthority: "Dublin City",
    CN_Number: "CN001",
    CN_Planning_Permission_Number: "LRD6007/23-S3; ABP-318456-23",
    CN_Project_Name: "Example Road Apartments",
    CN_Description_proposed_development: "120 apartments",
    CN_Street: "Example Road",
    CN_Town: "Dublin 4",
    CN_Eircode: "D04 AB12",
    CN_LAT: "53.3301",
    CN_LNG: "-6.2301",
    CN_Date_Submitted_or_Received: "2024-01-10",
    CN_Validation_Date: "2024-01-15",
    CN_Commencement_Date: "2024-02-01",
    CN_Units_for_phase: 60,
    CN_Total_Number_of_Dwelling_Units: 120,
    CCC_Number: "CCC001",
    CCC_Date_Validated: "2025-03-01",
    CCC_Type_of_Completion_Certificate: "Phased completion",
    CCC_Units_Completed: 60
  },
  {
    IDs: "2",
    LocalAuthority: "Dublin City Council",
    CN_Number: "CN001",
    CN_Planning_Permission_Number: "LRD6007/23-S3",
    CN_Project_Name: "Example Road Apartments",
    CN_Street: "Example Road",
    CN_Town: "Dublin 4",
    CN_LAT: "53.3301",
    CN_LNG: "-6.2301",
    CN_Commencement_Date: "2024-02-01",
    CN_Units_for_phase: 60,
    CCC_Number: "CCC001",
    CCC_Date_Validated: "2025-03-01",
    CCC_Type_of_Completion_Certificate: "Phased completion",
    CCC_Units_Completed: 60
  },
  {
    IDs: "3",
    LocalAuthority: "Dublin City Council",
    CN_Number: "CN002",
    CN_Planning_Permission_Number: "LRD6007/23-S3",
    CN_Project_Name: "Example Road Apartments Phase 2",
    CN_Street: "Example Road",
    CN_Town: "Dublin 4",
    CN_LAT: "53.3302",
    CN_LNG: "-6.2302",
    CN_Date_Submitted_or_Received: "2024-07-01",
    CN_Commencement_Date: "2024-08-01",
    CN_Units_for_phase: 60,
    CN_Total_Number_of_Dwelling_Units: 120,
    CCC_Number: "CCC002",
    CCC_Date_Validated: "2026-01-15",
    CCC_Type_of_Completion_Certificate: "Full completion",
    CCC_Units_Completed: 60
  }
];

assert.strictEqual(core.canonicalAuthority("Dublin City"), "DUBLIN CITY COUNCIL");
assert(core.referenceTokens("LRD6007/23-S3").includes("LRD600723S3"));
assert.strictEqual(core.acpReference("ABP-318456-23"), "318456");

const consolidated = core.consolidateNbcoRows(nbco);
assert.strictEqual(consolidated.length, 2, "duplicate flattened CN rows should consolidate");
const matches = core.matchCommencements(planning, consolidated);
assert.strictEqual(matches.automatic.length, 2, "both commencement notices should match automatically");
assert.strictEqual(matches.review.length, 0);
const aggregate = core.aggregateProjects(matches);
assert.strictEqual(aggregate.projects.length, 1);
const project = aggregate.projects[0];
assert.strictEqual(project.commencementCount, 2);
assert.strictEqual(project.certificateCount, 2);
assert.strictEqual(project.unitsCommenced, 120);
assert.strictEqual(project.unitsCompleted, 120);
assert.strictEqual(project.completed, true);
assert.strictEqual(core.isoDate(project.firstAppearance), "2024-01-10");

const ambiguousPlanning = [
  { OBJECTID: 10, PlanningAuthority: "Fingal County Council", ApplicationNumber: "F23A/0123", DevelopmentAddress: "Main Street, Swords", NumResidentialUnits: 10, __lat: 53.459, __lng: -6.22 },
  { OBJECTID: 11, PlanningAuthority: "Fingal County Council", ApplicationNumber: "F23A/0456", DevelopmentAddress: "Main Street, Swords", NumResidentialUnits: 12, __lat: 53.4591, __lng: -6.2201 }
];
const ambiguousNotice = core.consolidateNbcoRows([{
  LocalAuthority: "Fingal",
  CN_Number: "CN-X",
  CN_Planning_Permission_Number: "",
  CN_Project_Name: "Housing at Main Street",
  CN_Street: "Main Street",
  CN_Town: "Swords",
  CN_LAT: 53.45905,
  CN_LNG: -6.22005,
  CN_Commencement_Date: "2025-01-01",
  CN_Units_for_phase: 10
}]);
const ambiguous = core.matchCommencements(ambiguousPlanning, ambiguousNotice);
assert.strictEqual(ambiguous.automatic.length, 0, "location-only candidates must not auto-match without a planning or ACP reference");
assert.strictEqual(ambiguous.review.length + ambiguous.unmatched.length, 1);

console.log(JSON.stringify({
  status: "passed",
  automaticMatches: matches.automatic.length,
  consolidatedProject: {
    planningReference: project.planningRef,
    commencementNotices: project.commencementCount,
    completionCertificates: project.certificateCount,
    unitsCommenced: project.unitsCommenced,
    unitsCompleted: project.unitsCompleted,
    firstAppearance: core.isoDate(project.firstAppearance),
    status: project.status
  },
  ambiguitySafeguard: {
    automaticMatches: ambiguous.automatic.length,
    reviewOrUnmatched: ambiguous.review.length + ambiguous.unmatched.length
  }
}, null, 2));
