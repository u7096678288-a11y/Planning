"use strict";

const assert = require("node:assert/strict");

const PLANNING = "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0/query";
const NBCO = "https://data.nbco.gov.ie/api/3/action/datastore_search_sql";
const NBCO_RESOURCE = "0774e781-7af8-46da-b623-872e74cf541e";
const NBCO_RESOURCE_PAGE = `https://data.nbco.gov.ie/dataset/bcnccc/resource/${NBCO_RESOURCE}`;
const CORK = "https://data.corkcity.ie/api/3/action/datastore_search_sql";
const CORK_RESOURCE = "8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  Accept: "application/json,text/plain,text/html,*/*",
  Referer: "https://data.nbco.gov.ie/"
};

async function fetchJson(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
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
  const sql = `SELECT "CN_Number","CN_Planning_Permission_Number","CN_Commencement_Date","CN_Units_for_phase","CN_Total_Number_of_Dwelling_Units","CCC_Number","CCC_Date_Validated","CCC_Units_Completed","LocalAuthority" FROM "${NBCO_RESOURCE}" WHERE "CN_Number" IS NOT NULL AND GREATEST(COALESCE("CN_Units_for_phase",0),COALESCE("CN_Total_Number_of_Dwelling_Units",0),COALESCE("CN_Total_Number_Multiple_Unit_Dwellings",0),COALESCE("CCC_Units_Completed",0)) >= 3 AND ("CN_Date_Submitted_or_Received" >= '${start}'::timestamp OR "CN_Validation_Date" >= '${start}'::timestamp OR "CN_Commencement_Date" >= '${start}'::timestamp OR "CCC_Date_Validated" >= '${start}'::timestamp) LIMIT 1`;
  const url = new URL(NBCO);
  url.searchParams.set("sql", sql);
  try {
    const data = await fetchJson(url, { headers: BROWSER_HEADERS });
    assert.equal(data.success, true, data.error?.message || "NBCO query was not successful");
    assert.ok(Array.isArray(data.result?.records), "NBCO query should return records");
    assert.ok(data.result.records.length > 0, "NBCO query should find at least one recent 3+ dwelling record");
    console.log("✓ live NBCO commencements and completions query");
  } catch (error) {
    if (error.status !== 403) throw error;
    const response = await fetch(NBCO_RESOURCE_PAGE, { headers: BROWSER_HEADERS });
    assert.ok(response.ok, `NBCO resource page should remain available after API 403, received ${response.status}`);
    const html = await response.text();
    assert.ok(html.includes(NBCO_RESOURCE), "NBCO resource page should identify the active BuildingsCNsCCCs resource");
    console.log("⚠ NBCO SQL API returned 403 to GitHub Actions; public resource page is live and the website retains its browser JSONP connection");
  }
}

async function testCorkService() {
  const sql = `SELECT "ApplicationNumber","PlanningAuthority","NumResidentialUnits" FROM "${CORK_RESOURCE}" WHERE COALESCE("NumResidentialUnits",0) >= 3 LIMIT 1`;
  const url = new URL(CORK);
  url.searchParams.set("sql", sql);
  const data = await fetchJson(url);
  assert.equal(data.success, true, data.error?.message || "Cork City query was not successful");
  assert.ok(Array.isArray(data.result?.records), "Cork City query should return records");
  console.log("✓ live Cork City planning query");
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
