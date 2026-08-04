"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../building-control-match-core.js");

function planning(overrides = {}) {
  return {
    OBJECTID: 1,
    PlanningAuthority: "Dublin City Council",
    ApplicationNumber: "DCC/1234/22",
    AppealRefNumber: "ABP-312345-22",
    DevelopmentAddress: "10 Main Street, Dublin D01AB12",
    DevelopmentDescription: "Housing scheme of 6 dwellings at 10 Main Street",
    NumResidentialUnits: 6,
    GrantDate: "2021-12-20",
    DecisionDate: "2021-12-20",
    __lat: 53.3498,
    __lng: -6.2603,
    ...overrides
  };
}

function nbco(overrides = {}) {
  return {
    IDs: "ROW-1",
    LocalAuthority: "Dublin City Council",
    CN_Number: "CN-001",
    CN_Planning_Permission_Number: "DCC 1234/22; ABP-312345-22",
    CN_Project_Name: "Main Street Housing Scheme",
    CN_Description_proposed_development: "Six dwellings at 10 Main Street",
    CN_Street: "10 Main Street",
    CN_Town: "Dublin",
    CN_Eircode: "D01 AB12",
    CN_LAT: 53.3498,
    CN_LNG: -6.2603,
    CN_Date_Granted: "2021-12-20",
    CN_Date_Submitted_or_Received: "2022-01-05",
    CN_Validation_Date: "2022-01-10",
    CN_Commencement_Date: "2022-02-01",
    CN_Units_for_phase: 3,
    CN_Total_Number_of_Dwelling_Units: 6,
    CN_Phase_for_this_Notice: 1,
    ...overrides
  };
}

function testReferenceAndAuthorityNormalisation() {
  assert.equal(core.canonicalAuthority("Dublin City"), "DUBLIN CITY COUNCIL");
  assert.equal(core.canonicalAuthority("Dún Laoghaire-Rathdown County Council"), "DUN LAOGHAIRE RATHDOWN COUNTY COUNCIL");
  assert.equal(core.normaliseReference("Planning Ref: DCC/1234/22"), "DCC123422");
  assert.equal(core.acpReference("ABP-312345-22"), "312345");
}

function testConsolidationAndProjectAggregation() {
  const rows = [
    nbco(),
    nbco({
      IDs: "ROW-2",
      Building_Number: "B1",
      CCC_Number: "CCC-001",
      CCC_Date_Validated: "2023-01-10",
      CCC_Type_of_Completion_Certificate: "Phased completion",
      CCC_Units_Completed: 2
    }),
    nbco({
      IDs: "ROW-3",
      Building_Number: "B2",
      CCC_Number: "CCC-001",
      CCC_Date_Validated: "2023-01-10",
      CCC_Type_of_Completion_Certificate: "Phased completion",
      CCC_Units_Completed: 2
    }),
    nbco({
      IDs: "ROW-4",
      CN_Number: "CN-002",
      CN_Date_Submitted_or_Received: "2022-06-15",
      CN_Validation_Date: "2022-06-20",
      CN_Commencement_Date: "2022-08-01",
      CN_Units_for_phase: 2,
      CN_Phase_for_this_Notice: 2,
      CCC_Number: "CCC-002",
      CCC_Date_Validated: "2024-02-01",
      CCC_Type_of_Completion_Certificate: "Full completion",
      CCC_Units_Completed: 4
    })
  ];

  const consolidated = core.consolidateNbcoRows(rows);
  assert.equal(consolidated.length, 2, "duplicate flattened rows should consolidate to two commencement notices");
  assert.equal(consolidated[0].__certificates.length, 1, "the repeated certificate should only appear once");

  const matched = core.matchCommencements([planning()], consolidated);
  assert.equal(matched.automatic.length, 2, "both commencement notices should automatically match the planning permission");
  assert.equal(matched.review.length, 0);
  assert.equal(matched.unmatched.length, 0);

  const aggregate = core.aggregateProjects(matched);
  assert.equal(aggregate.projects.length, 1);
  const project = aggregate.projects[0];
  assert.equal(project.commencementCount, 2);
  assert.equal(project.certificateCount, 2);
  assert.equal(project.unitsCommenced, 5, "phase units should be added once per unique commencement notice");
  assert.equal(project.unitsCompleted, 6, "completed units should be added once per unique certificate");
  assert.equal(project.status, "Completed");
  assert.equal(core.isoDate(project.firstAppearance), "2022-01-05", "first appearance should use the earliest linked published date");
  assert.equal(core.isoDate(project.firstCompletion), "2023-01-10");
  assert.equal(core.isoDate(project.latestCompletion), "2024-02-01");
}

function testLocationOnlyCandidatesAreNotAutomatic() {
  const planningRows = [
    planning({ OBJECTID: 10, ApplicationNumber: "DCC/1000/22", DevelopmentAddress: "1 Harbour Road, Dublin D02XY12", __lat: 53.3400, __lng: -6.2500 }),
    planning({ OBJECTID: 11, ApplicationNumber: "DCC/1001/22", DevelopmentAddress: "2 Harbour Road, Dublin D02XY12", __lat: 53.3402, __lng: -6.2502 })
  ];
  const commencement = nbco({
    CN_Number: "CN-AMBIGUOUS",
    CN_Planning_Permission_Number: "",
    CN_Project_Name: "Harbour Road Housing",
    CN_Street: "Harbour Road",
    CN_Town: "Dublin",
    CN_Eircode: "D02 XY12",
    CN_LAT: 53.3401,
    CN_LNG: -6.2501,
    CN_Total_Number_of_Dwelling_Units: 6
  });

  const matched = core.matchCommencements(planningRows, [commencement]);
  assert.equal(matched.automatic.length, 0, "address and point proximity without a planning or ACP reference must not auto-match");
  assert.equal(matched.review.length, 1, "a plausible location-only result should be retained for review");
}

function testAuthorityConflictBlocksAutomaticMatch() {
  const commencement = nbco({ LocalAuthority: "Fingal County Council" });
  const matched = core.matchCommencements([planning()], [commencement]);
  assert.equal(matched.automatic.length, 0, "a conflicting local authority must block an automatic result");
}

function testPublishedConfiguration() {
  const root = path.resolve(__dirname, "..");
  const page = fs.readFileSync(path.join(root, "completions.html"), "utf8");
  const dashboard = fs.readFileSync(path.join(root, "dashboard-building-control-five-year.js"), "utf8");
  const loader = fs.readFileSync(path.join(root, "export-share.js"), "utf8");

  assert.match(page, /value="3"/);
  assert.match(page, /value="5"/);
  assert.match(page, /building-control-match-core\.js/);
  assert.match(page, /completions-five-year\.js/);
  assert.match(dashboard, /const MIN_UNITS = 3;/);
  assert.match(dashboard, /const YEARS = 5;/);
  assert.match(loader, /building-control-match-core\.js/);
  assert.match(loader, /dashboard-building-control-five-year\.js/);
  assert.doesNotMatch(loader, /dashboard-building-control\.js\?v=/);
}

const tests = [
  testReferenceAndAuthorityNormalisation,
  testConsolidationAndProjectAggregation,
  testLocationOnlyCandidatesAreNotAutomatic,
  testAuthorityConflictBlocksAutomaticMatch,
  testPublishedConfiguration
];

for (const test of tests) {
  test();
  console.log(`✓ ${test.name}`);
}

console.log(`All ${tests.length} building-control tests passed.`);
