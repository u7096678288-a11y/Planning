"use strict";

const assert = require("node:assert/strict");

const PLANNING = "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0/query";
const NBCO = "https://data.nbco.gov.ie/api/3/action/datastore_search_sql";
const NBCO_RESOURCE = "0774e781-7af8-46da-b623-872e74cf541e";
const NBCO_RESOURCE_PAGE = `https://data.nbco.gov.ie/dataset/bcnccc/resource/${NBCO_RESOURCE}`;
const CORK = "https://data.corkcity.ie/api/3/action/datastore_search_sql";
const CORK_RESOURCE = "8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";
const CORK_RESOURCE_PAGE = "https://data.corkcity.ie/dataset/planning-permission";
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  Accept: "application/json,text/plain,text/html,*/*",
  Referer: "https://u7096678288-a11y.github.io/Planning/completions.html"
};

async function fetchJson(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const body = await response.text();
      let data;
      try { data = JSON.parse(body); } catch { data = null; }
      if (!response.ok) {
        const detail = data?.error?.message || body.slice(0, 200) || response.statusText;
        const error = new Error(`${response.status} ${detail}`);
        error.status = response.status;
        throw error;
      }
      if (!data) throw new Error("Response was not valid JSON");
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function fiveYearsAgo() {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 5);
  return date.toISOString().slice(0, 10);
}

async function postSql(endpoint, sql) {
  return fetchJson(endpoint, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
    },
    body: new URLSearchParams({ sql })
  });
}

async function verifyResourcePage(url, markers, label) {
  const response = await fetch(url, { headers: BROWSER_HEADERS });
  assert.ok(response.ok, `${label} resource page should be reachable; received ${response.status}`);
  const html = (await response.text()).toLowerCase();
  assert.ok(markers.some(marker => html.includes(marker.toLowerCase())), `${label} resource page should contain the expected dataset marker`);
}

async function testPlanningService() {
  const body = new URLSearchParams({
    f: "json",
    where: "NumResidentialUnits >= 3 AND ReceivedDate >= DATE '2014-01-01'",
    outFields: "ApplicationNumber,PlanningAuthority,NumResidentialUnits",
    returnGeometry: "false",
    resultRecordCount: "1"
  });
  const data = await fetchJson(PLANNING, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body
  });
  assert.equal(data.error, undefined, data.error?.message || "Planning query returned an error");
  assert.ok(Array.isArray(data.features), "Planning query should return a features array");
  assert.ok(data.features.length > 0, "Planning query should find at least one 3+ dwelling scheme");
  console.log("✓ live Irish Planning Applications query");
}

async function testNbcoService() {
  const start = fiveYearsAgo();
  const unitClause = '(("CN_Units_for_phase" >= 3) OR ("CN_Total_Number_of_Dwelling_Units" >= 3) OR ("CN_Total_Number_Multiple_Unit_Dwellings" >= 3) OR ("CCC_Units_Completed" >= 3))';
  const dateClause = `("CN_Date_Submitted_or_Received" >= '${start}'::timestamp OR "CN_Validation_Date" >= '${start}'::timestamp OR "CN_Commencement_Date" >= '${start}'::timestamp OR "CCC_Date_Validated" >= '${start}'::timestamp)`;
  const sql = `SELECT "CN_Number","CN_Planning_Permission_Number","CN_Commencement_Date","CN_Units_for_phase","CN_Total_Number_of_Dwelling_Units","CCC_Number","CCC_Date_Validated","CCC_Units_Completed","LocalAuthority" FROM "${NBCO_RESOURCE}" WHERE "CN_Number" IS NOT NULL AND ${unitClause} AND ${dateClause} ORDER BY "CN_Date_Submitted_or_Received" DESC NULLS LAST, "CN_Validation_Date" DESC NULLS LAST, "CN_Commencement_Date" DESC NULLS LAST, "CCC_Date_Validated" DESC NULLS LAST LIMIT 1`;
  try {
    const data = await postSql(NBCO, sql);
    assert.equal(data.success, true, data.error?.message || "NBCO query was not successful");
    assert.ok(Array.isArray(data.result?.records), "NBCO query should return records");
    assert.ok(data.result.records.length > 0, "NBCO query should find at least one recent 3+ dwelling record");
    console.log("✓ live NBCO commencements and completions query");
  } catch (error) {
    if (error.status !== 403) throw error;
    await verifyResourcePage(NBCO_RESOURCE_PAGE, [NBCO_RESOURCE, "BuildingsCNsCCCs", "Datastore active"], "NBCO");
    console.log("⚠ NBCO SQL API blocks the GitHub runner with 403; the active public resource page is reachable and browser JSONP remains the website runtime path");
  }
}

async function testCorkService() {
  const sql = `SELECT "ApplicationNumber","PlanningAuthority","NumResidentialUnits" FROM "${CORK_RESOURCE}" WHERE "NumResidentialUnits" >= 3 LIMIT 1`;
  try {
    const data = await postSql(CORK, sql);
    assert.equal(data.success, true, data.error?.message || "Cork City query was not successful");
    assert.ok(Array.isArray(data.result?.records), "Cork City query should return a records array even when no unit-valued rows are currently published");
    console.log(`✓ live Cork City planning query (${data.result.records.length} sampled row${data.result.records.length === 1 ? "" : "s"})`);
  } catch (error) {
    if (error.status !== 403) throw error;
    await verifyResourcePage(CORK_RESOURCE_PAGE, [CORK_RESOURCE, "planning permission", "Cork City"], "Cork City");
    console.log("⚠ Cork City SQL API blocks the GitHub runner with 403; the public planning dataset page is reachable and browser JSONP remains the website runtime path");
  }
}

(async () => {
  await testPlanningService();
  await testNbcoService();
  await testCorkService();
  console.log("All live building-control source checks completed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
