"use strict";

(function installPerformanceEngine() {
  const PAGE_SIZE = 2000;
  const MAX_LAYER_ROWS = 80000;
  const CACHE_TTL = 120000;
  const cache = new Map();
  let activeController = null;
  let runId = 0;
  let initialised = false;
  let analysis = null;
  const charts = {};

  const PLANNING_FIELDS = [
    "OBJECTID", "PlanningAuthority", "ApplicationNumber", "ApplicationStatus",
    "NumResidentialUnits", "ReceivedDate", "Decision", "DecisionDate", "DecisionDueDate",
    "GrantDate", "AppealRefNumber", "AppealStatus", "AppealDecision",
    "AppealDecisionDate", "AppealSubmittedDate", "FIRequestDate", "FIRecDate"
  ];
  const ACP_FIELDS = ["OBJECTID", "ABPCASEID", "LODGEDON", "DECISION", "DECIDED_ON", "PLANINGATY", "CATEGORY", "LINKABPWEB"];

  const el = selector => document.querySelector(selector);
  const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const numeric = value => {
    if (value == null || value === "") return 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };
  const format = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const formatOne = value => Number.isFinite(value) ? new Intl.NumberFormat("en-IE", { maximumFractionDigits: 1 }).format(value) : "—";
  const percentage = value => Number.isFinite(value) ? `${formatOne(value * 100)}%` : "—";
  const safeHtml = value => typeof esc === "function" ? esc(value) : text(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

  function status(message, mode = "idle", coverage = "") {
    const container = el("#performanceStatus");
    if (!container) return;
    container.dataset.mode = mode;
    if (container.firstElementChild) container.firstElementChild.textContent = message;
    const coverageElement = el("#performanceCoverage");
    if (coverageElement) coverageElement.textContent = coverage;
  }

  function currentScope() {
    return el("#performanceScope")?.value === "map" ? "map" : "national";
  }

  function includeAcp() {
    return Boolean(el("#performanceIncludeAcp")?.checked);
  }

  function geometryForScope(scope) {
    if (scope !== "map") return null;
    return geom();
  }

  function geometryKey(geometry) {
    if (!geometry?.geometry) return "national";
    return typeof geometry.geometry === "string" ? geometry.geometry : JSON.stringify(geometry.geometry);
  }

  function performanceKey() {
    const scope = currentScope();
    const geometry = geometryForScope(scope);
    return JSON.stringify({
      scope,
      geometry: geometryKey(geometry),
      planningWhere: smartPlanningWhere(),
      acpWhere: performanceAcpWhere(),
      includeAcp: includeAcp(),
      corkDirect: Boolean(el('#layerToggles input[data-k="corkCityDirect"]')?.checked)
    });
  }

  function encodeBody(parameters) {
    const body = new URLSearchParams();
    Object.entries({ f: "json", ...parameters }).forEach(([key, value]) => {
      if (value == null) return;
      body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    });
    return body;
  }

  async function arcgisPost(url, parameters, signal) {
    const response = await fetch(`${url}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: encodeBody(parameters),
      cache: "no-store",
      credentials: "omit",
      signal
    });
    if (!response.ok) throw new Error(`ArcGIS HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) {
      const detail = Array.isArray(data.error.details) ? data.error.details.filter(Boolean).join(" · ") : "";
      throw new Error([data.error.message, detail].filter(Boolean).join(" · "));
    }
    return data;
  }

  async function fetchArcgisRows(url, where, fields, geometry, signal) {
    const rows = [];
    let offset = 0;
    let capped = false;
    while (offset < MAX_LAYER_ROWS) {
      const parameters = {
        where,
        outFields: fields.join(","),
        returnGeometry: false,
        resultOffset: offset,
        resultRecordCount: PAGE_SIZE,
        orderByFields: "OBJECTID ASC"
      };
      if (geometry) Object.assign(parameters, geometry);
      const page = await arcgisPost(url, parameters, signal);
      const attributes = (page.features || []).map(feature => feature.attributes || {});
      rows.push(...attributes);
      offset += attributes.length;
      status(`Loading planning and appeal records… ${format(rows.length)} received`, "loading", currentScope() === "national" ? "National" : "Current map");
      if (attributes.length < PAGE_SIZE && !page.exceededTransferLimit) break;
      if (!attributes.length) break;
    }
    if (rows.length >= MAX_LAYER_ROWS) capped = true;
    return { rows, capped };
  }

  function nonCorkWhere(where) {
    return `(${where || "1=1"}) AND (PlanningAuthority IS NULL OR UPPER(PlanningAuthority) NOT LIKE 'CORK CITY%')`;
  }

  function sqlValue(value) {
    return String(value ?? "").replaceAll("'", "''");
  }

  function performanceAcpWhere() {
    const base = smartAcpWhere();
    const selected = Array.isArray(smartState.authority) ? smartState.authority : [];
    if (!selected.length) return base;
    const clauses = [];
    selected.forEach(value => {
      if (value === smartNull) {
        clauses.push("(PLANINGATY IS NULL OR PLANINGATY = '')");
        return;
      }
      const authority = canonicalAuthority(value);
      if (authority === "Cork City Council") clauses.push("UPPER(PLANINGATY) LIKE 'CORK CITY%'");
      else if (authority === "Cork County Council") clauses.push("UPPER(PLANINGATY) LIKE 'CORK COUNTY%'");
      else clauses.push(`PLANINGATY = '${sqlValue(value)}'`);
    });
    return clauses.length ? `(${base}) AND (${clauses.join(" OR ")})` : base;
  }

  function canonicalAuthority(value) {
    if (window.RadharcCrossLayerSync?.canonicalAuthority) return window.RadharcCrossLayerSync.canonicalAuthority(value) || "Not stated";
    if (window.CorkCityCKAN?.canonicalAuthority) return window.CorkCityCKAN.canonicalAuthority(value) || "Not stated";
    const authority = text(value);
    const upper = authority.toUpperCase();
    if (upper.includes("CORK CITY")) return "Cork City Council";
    if (upper.includes("CORK COUNTY")) return "Cork County Council";
    return authority || "Not stated";
  }

  function normaliseCorkRecord(record) {
    return {
      ...record,
      PlanningAuthority: "Cork City Council",
      ApplicationNumber: text(record.ApplicationNumber),
      NumResidentialUnits: record.NumResidentialUnits == null || record.NumResidentialUnits === "" ? null : Number(record.NumResidentialUnits),
      AppealRefNumber: record.AppealRefNumber || record.AppealRefNum || "",
      DirectSource: "Cork City Council CKAN"
    };
  }

  function recordRichness(record) {
    return ["NumResidentialUnits", "DecisionDate", "Decision", "AppealRefNumber", "AppealSubmittedDate", "AppealDecisionDate", "FIRequestDate", "FIRecDate"]
      .reduce((score, field) => score + (record[field] != null && record[field] !== "" ? 1 : 0), 0);
  }

  function mergeRecord(left, right) {
    const primary = recordRichness(right) > recordRichness(left) ? right : left;
    const secondary = primary === left ? right : left;
    const merged = { ...secondary, ...primary };
    Object.keys(secondary).forEach(key => {
      if (merged[key] == null || merged[key] === "") merged[key] = secondary[key];
    });
    const units = [numeric(left.NumResidentialUnits), numeric(right.NumResidentialUnits)];
    if (units.some(value => value > 0)) merged.NumResidentialUnits = Math.max(...units);
    return merged;
  }

  function planningIdentity(record, source, index) {
    const authority = canonicalAuthority(record.PlanningAuthority).toUpperCase();
    const reference = text(record.ApplicationNumber).toUpperCase();
    return reference ? `${authority}|${reference}` : `${authority}|${source}|${record.OBJECTID ?? index}`;
  }

  function dedupePlanning(sources) {
    const records = new Map();
    sources.forEach(({ source, rows }) => {
      rows.forEach((record, index) => {
        const normalised = source === "cork" ? normaliseCorkRecord(record) : { ...record, PlanningAuthority: canonicalAuthority(record.PlanningAuthority) };
        normalised.__source = source;
        const key = planningIdentity(normalised, source, index);
        const existing = records.get(key);
        records.set(key, existing ? mergeRecord(existing, normalised) : normalised);
      });
    });
    return [...records.values()];
  }

  function parseTime(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    const date = new Date(Number.isFinite(number) && String(value).trim() !== "" ? number : value);
    const time = date.getTime();
    return Number.isFinite(time) ? time : null;
  }

  function dayDifference(startValue, endValue, maximum = 3650) {
    const start = parseTime(startValue);
    const end = parseTime(endValue);
    if (start == null || end == null || end < start) return null;
    const days = (end - start) / 86400000;
    return days <= maximum ? days : null;
  }

  function median(values) {
    const clean = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (!clean.length) return null;
    const middle = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
  }

  function average(values) {
    const clean = values.filter(Number.isFinite);
    return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
  }

  function decisionClass(value) {
    const upper = text(value).toUpperCase();
    if (!upper) return "other";
    const hasGrant = /GRANT|APPROV|CONDITIONAL PERMISSION|UNCONDITIONAL PERMISSION/.test(upper);
    const hasRefuse = /REFUS|REJECT|DISMISS/.test(upper);
    if (hasGrant && hasRefuse) return "mixed";
    if (hasRefuse) return "refused";
    if (hasGrant) return "granted";
    if (/WITHDRAW/.test(upper)) return "withdrawn";
    if (/INVALID|CANNOT BE CONSIDERED/.test(upper)) return "invalid";
    return "other";
  }

  function appealReference(record) {
    return text(record.AppealRefNumber || record.AppealRefNum);
  }

  function referenceKey(value) {
    const raw = text(value).toUpperCase().replace(/AN BORD PLEAN[ÁA]LA|AN COIMISI[ÚU]N PLEAN[ÁA]LA/g, "").replace(/^(ABP|ACP)[-\s]*/g, "");
    const compact = raw.replace(/[^A-Z0-9]/g, "");
    const digits = compact.replace(/\D/g, "");
    if (digits.length >= 5) return digits.replace(/^0+/, "");
    return compact;
  }

  function isAppealed(record) {
    return Boolean(appealReference(record) || text(record.AppealStatus) || parseTime(record.AppealSubmittedDate));
  }

  function enrichPlanning(records, acpRows) {
    const acpByReference = new Map();
    acpRows.forEach(record => {
      const key = referenceKey(record.ABPCASEID);
      if (key) acpByReference.set(key, record);
    });
    let matched = 0;
    const enriched = records.map(record => {
      const units = Math.max(0, numeric(record.NumResidentialUnits));
      const classification = decisionClass(record.Decision);
      const appealKey = referenceKey(appealReference(record));
      const acp = appealKey ? acpByReference.get(appealKey) : null;
      if (acp) matched += 1;
      const grossDays = dayDifference(record.ReceivedDate, record.DecisionDate);
      const fiPause = dayDifference(record.FIRequestDate, record.FIRecDate);
      const adjustedDays = grossDays == null ? null : Math.max(0, grossDays - (fiPause || 0));
      const decisionToAppealDays = dayDifference(record.DecisionDate, record.AppealSubmittedDate, 730);
      const appealDecisionDate = record.AppealDecisionDate || acp?.DECIDED_ON;
      const appealSubmittedDate = record.AppealSubmittedDate || acp?.LODGEDON;
      const appealDays = dayDifference(appealSubmittedDate, appealDecisionDate);
      const endToEndDays = dayDifference(record.ReceivedDate, appealDecisionDate);
      const dueVariance = dayDifference(record.DecisionDueDate, record.DecisionDate, 730);
      const appealDecision = record.AppealDecision || acp?.DECISION || "";
      return {
        ...record,
        PlanningAuthority: canonicalAuthority(record.PlanningAuthority),
        __units: units,
        __residential: units > 0,
        __decisionClass: classification,
        __appealed: isAppealed(record),
        __grossDays: grossDays,
        __adjustedDays: adjustedDays,
        __decisionToAppealDays: decisionToAppealDays,
        __appealDays: appealDays,
        __endToEndDays: endToEndDays,
        __late: dueVariance != null && dueVariance > 0,
        __acp: acp,
        __appealDecision: appealDecision
      };
    });
    return { records: enriched, matched };
  }

  function analyseAcp(rows) {
    return rows.map(record => ({
      ...record,
      PLANINGATY: canonicalAuthority(record.PLANINGATY),
      __days: dayDifference(record.LODGEDON, record.DECIDED_ON)
    }));
  }

  function emptyAuthority(authority) {
    return {
      authority,
      applications: 0,
      residentialApplications: 0,
      decided: 0,
      residentialDecided: 0,
      decidedUnits: 0,
      grants: 0,
      grantUnits: 0,
      refusals: 0,
      refusalUnits: 0,
      mixed: 0,
      appeals: 0,
      appealUnits: 0,
      late: 0,
      decisionDays: [],
      adjustedDays: [],
      appealDays: [],
      decisionToAppealDays: [],
      acpCases: 0,
      acpDecided: 0,
      acpDays: []
    };
  }

  function authorityStats(planning, acp) {
    const groups = new Map();
    const get = authority => {
      const key = authority || "Not stated";
      if (!groups.has(key)) groups.set(key, emptyAuthority(key));
      return groups.get(key);
    };
    planning.forEach(record => {
      const group = get(record.PlanningAuthority);
      group.applications += 1;
      if (record.__residential) group.residentialApplications += 1;
      if (record.__grossDays != null) {
        group.decided += 1;
        group.decisionDays.push(record.__grossDays);
        if (record.__late) group.late += 1;
      }
      if (record.__adjustedDays != null) group.adjustedDays.push(record.__adjustedDays);
      if (record.__residential && record.__grossDays != null) {
        group.residentialDecided += 1;
        group.decidedUnits += record.__units;
      }
      if (record.__decisionClass === "granted") {
        group.grants += 1;
        group.grantUnits += record.__units;
      }
      if (record.__decisionClass === "refused") {
        group.refusals += 1;
        group.refusalUnits += record.__units;
      }
      if (record.__decisionClass === "mixed") group.mixed += 1;
      if (record.__appealed && record.__residential) {
        group.appeals += 1;
        group.appealUnits += record.__units;
      }
      if (record.__appealDays != null) group.appealDays.push(record.__appealDays);
      if (record.__decisionToAppealDays != null) group.decisionToAppealDays.push(record.__decisionToAppealDays);
    });
    acp.forEach(record => {
      const group = get(record.PLANINGATY);
      group.acpCases += 1;
      if (record.__days != null) {
        group.acpDecided += 1;
        group.acpDays.push(record.__days);
      }
    });
    return [...groups.values()].map(group => {
      const decisionOutcomeDenominator = group.grants + group.refusals + group.mixed;
      return {
        ...group,
        medianDecisionDays: median(group.decisionDays),
        averageDecisionDays: average(group.decisionDays),
        medianAdjustedDays: median(group.adjustedDays),
        medianAppealDays: median(group.appealDays),
        medianDecisionToAppealDays: median(group.decisionToAppealDays),
        medianAcpDays: median(group.acpDays),
        refusalRate: decisionOutcomeDenominator ? group.refusals / decisionOutcomeDenominator : null,
        appealRate: group.residentialDecided ? group.appeals / group.residentialDecided : null,
        lateRate: group.decided ? group.late / group.decided : null
      };
    });
  }

  function monthKey(value) {
    const time = parseTime(value);
    if (time == null) return null;
    const date = new Date(time);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function monthlySeries(records) {
    const months = new Map();
    const get = key => {
      if (!months.has(key)) months.set(key, { month: key, granted: 0, refused: 0, appealed: 0 });
      return months.get(key);
    };
    records.filter(record => record.__residential).forEach(record => {
      const decisionMonth = monthKey(record.DecisionDate);
      if (decisionMonth && record.__decisionClass === "granted") get(decisionMonth).granted += record.__units;
      if (decisionMonth && record.__decisionClass === "refused") get(decisionMonth).refused += record.__units;
      const appealMonth = monthKey(record.AppealSubmittedDate || record.__acp?.LODGEDON);
      if (appealMonth && record.__appealed) get(appealMonth).appealed += record.__units;
    });
    return [...months.values()].sort((left, right) => left.month.localeCompare(right.month)).slice(-24);
  }

  function decisionBands(records) {
    const bands = [
      { label: "0–56 days", min: 0, max: 56, count: 0 },
      { label: "57–84 days", min: 56, max: 84, count: 0 },
      { label: "85–182 days", min: 84, max: 182, count: 0 },
      { label: "183–365 days", min: 182, max: 365, count: 0 },
      { label: "366+ days", min: 365, max: Infinity, count: 0 }
    ];
    records.forEach(record => {
      const days = record.__grossDays;
      if (days == null) return;
      const band = bands.find(item => days > item.min && days <= item.max) || (days === 0 ? bands[0] : null);
      if (band) band.count += 1;
    });
    return bands;
  }

  function summaryMetrics(planning, acp, matched) {
    const residential = planning.filter(record => record.__residential);
    const decided = planning.filter(record => record.__grossDays != null);
    const appealed = residential.filter(record => record.__appealed);
    const grants = residential.filter(record => record.__decisionClass === "granted");
    const refusals = residential.filter(record => record.__decisionClass === "refused");
    const decidedAcp = acp.filter(record => record.__days != null);
    return {
      applications: planning.length,
      residentialApplications: residential.length,
      residentialUnits: residential.reduce((sum, record) => sum + record.__units, 0),
      decided: decided.length,
      medianDecisionDays: median(decided.map(record => record.__grossDays)),
      averageDecisionDays: average(decided.map(record => record.__grossDays)),
      medianAdjustedDays: median(decided.map(record => record.__adjustedDays)),
      lateRate: decided.length ? decided.filter(record => record.__late).length / decided.length : null,
      grantApplications: grants.length,
      grantUnits: grants.reduce((sum, record) => sum + record.__units, 0),
      refusalApplications: refusals.length,
      refusalUnits: refusals.reduce((sum, record) => sum + record.__units, 0),
      refusalRate: grants.length + refusals.length ? refusals.length / (grants.length + refusals.length) : null,
      appealedApplications: appealed.length,
      appealedUnits: appealed.reduce((sum, record) => sum + record.__units, 0),
      appealRate: residential.length ? appealed.length / residential.length : null,
      medianDecisionToAppealDays: median(appealed.map(record => record.__decisionToAppealDays)),
      medianAppealDays: median(appealed.map(record => record.__appealDays)),
      medianEndToEndDays: median(appealed.map(record => record.__endToEndDays)),
      acpCases: acp.length,
      acpDecided: decidedAcp.length,
      medianAcpDays: median(decidedAcp.map(record => record.__days)),
      averageAcpDays: average(decidedAcp.map(record => record.__days)),
      matchedAppeals: matched
    };
  }

  async function loadData(signal) {
    const scope = currentScope();
    const geometry = geometryForScope(scope);
    const basePlanningWhere = smartPlanningWhere();
    const directSelected = Boolean(el('#layerToggles input[data-k="corkCityDirect"]')?.checked && window.CorkCityCKAN);
    const nationalWhere = directSelected ? nonCorkWhere(basePlanningWhere) : basePlanningWhere;
    const acpEnabled = includeAcp();

    const tasks = {
      points: fetchArcgisRows(S.planningPoints.url, nationalWhere, PLANNING_FIELDS, geometry, signal),
      sites: fetchArcgisRows(S.planningSites.url, nationalWhere, PLANNING_FIELDS, geometry, signal),
      acp: acpEnabled ? fetchArcgisRows(S.acpCases.url, performanceAcpWhere(), ACP_FIELDS, geometry, signal) : Promise.resolve({ rows: [], capped: false }),
      cork: directSelected ? window.CorkCityCKAN.allRecords({ geometry, maxRows: MAX_LAYER_ROWS }) : Promise.resolve([])
    };
    const names = Object.keys(tasks);
    const settled = await Promise.allSettled(Object.values(tasks));
    const results = Object.fromEntries(names.map((name, index) => [name, settled[index]]));
    const errors = [];
    names.forEach(name => {
      if (results[name].status === "rejected") errors.push(`${name}: ${results[name].reason?.message || results[name].reason}`);
    });

    if (results.points.status !== "fulfilled" && results.sites.status !== "fulfilled") {
      throw new Error(`Both planning layers failed. ${errors.join(" | ")}`);
    }

    let pointRows = results.points.status === "fulfilled" ? results.points.value.rows : [];
    let siteRows = results.sites.status === "fulfilled" ? results.sites.value.rows : [];
    let corkRows = results.cork.status === "fulfilled" ? results.cork.value : [];

    if (directSelected && results.cork.status === "rejected") {
      status("Cork direct feed was unavailable; retrying Cork City from the national planning layers…", "loading", scope === "national" ? "National" : "Current map");
      const fallback = await Promise.allSettled([
        fetchArcgisRows(S.planningPoints.url, basePlanningWhere, PLANNING_FIELDS, geometry, signal),
        fetchArcgisRows(S.planningSites.url, basePlanningWhere, PLANNING_FIELDS, geometry, signal)
      ]);
      if (fallback[0].status === "fulfilled") pointRows = fallback[0].value.rows;
      if (fallback[1].status === "fulfilled") siteRows = fallback[1].value.rows;
      corkRows = [];
      errors.push("Cork City direct feed unavailable; national fallback used");
    }

    return {
      planningSources: [
        { source: "points", rows: pointRows },
        { source: "sites", rows: siteRows },
        { source: "cork", rows: corkRows }
      ],
      acpRows: results.acp.status === "fulfilled" ? results.acp.value.rows : [],
      capped: [results.points, results.sites, results.acp].some(result => result.status === "fulfilled" && result.value.capped),
      errors,
      scope,
      directSelected
    };
  }

  function buildAnalysis(data) {
    const planningBase = dedupePlanning(data.planningSources);
    const acp = analyseAcp(data.acpRows);
    const enriched = enrichPlanning(planningBase, acp);
    const authorities = authorityStats(enriched.records, acp);
    return {
      ...data,
      planning: enriched.records,
      acp,
      matchedAppeals: enriched.matched,
      metrics: summaryMetrics(enriched.records, acp, enriched.matched),
      authorities,
      monthly: monthlySeries(enriched.records),
      bands: decisionBands(enriched.records),
      generatedAt: new Date(),
      filterSummary: smartSummary()
    };
  }

  function metricCard(label, value, note) {
    return `<article class="performance-metric"><span>${safeHtml(label)}</span><strong>${safeHtml(value)}</strong><small>${safeHtml(note)}</small></article>`;
  }

  function renderMetrics(result) {
    const metric = result.metrics;
    const cards = [
      metricCard("Planning applications analysed", format(metric.applications), `${format(metric.residentialApplications)} residential applications · ${format(metric.residentialUnits)} reported units`),
      metricCard("Median LA decision", metric.medianDecisionDays == null ? "—" : `${formatOne(metric.medianDecisionDays)} days`, `${format(metric.decided)} decisions · average ${formatOne(metric.averageDecisionDays)} days`),
      metricCard("FI-adjusted median", metric.medianAdjustedDays == null ? "—" : `${formatOne(metric.medianAdjustedDays)} days`, `Excludes recorded FI response pause · ${percentage(metric.lateRate)} after due date`),
      metricCard("Residential units granted", format(metric.grantUnits), `${format(metric.grantApplications)} applications classified as granted`),
      metricCard("Residential units refused", format(metric.refusalUnits), `${format(metric.refusalApplications)} refusals · ${percentage(metric.refusalRate)} refusal rate`),
      metricCard("Residential applications appealed", format(metric.appealedApplications), `${format(metric.appealedUnits)} units · ${percentage(metric.appealRate)} of residential applications`),
      metricCard("Decision to appeal", metric.medianDecisionToAppealDays == null ? "—" : `${formatOne(metric.medianDecisionToAppealDays)} days`, "Median LA decision to appeal lodging"),
      metricCard("Appeal determination", metric.medianAppealDays == null ? "—" : `${formatOne(metric.medianAppealDays)} days`, `Median appeal lodging to decision · ${format(metric.matchedAppeals)} matched ACP references`),
      metricCard("End-to-end appealed case", metric.medianEndToEndDays == null ? "—" : `${formatOne(metric.medianEndToEndDays)} days`, "Median planning receipt to final appeal decision"),
      metricCard("ACP case duration", metric.medianAcpDays == null ? "—" : `${formatOne(metric.medianAcpDays)} days`, `${format(metric.acpDecided)} decided of ${format(metric.acpCases)} selected ACP cases`)
    ];
    el("#performanceMetrics").innerHTML = cards.join("");
  }

  function destroyChart(key) {
    if (charts[key]) {
      charts[key].destroy();
      delete charts[key];
    }
  }

  function renderCharts(result) {
    if (typeof Chart !== "function") return;
    destroyChart("trend");
    destroyChart("bands");
    const trendCanvas = el("#performanceTrendChart");
    const bandCanvas = el("#performanceBandsChart");
    if (trendCanvas) {
      charts.trend = new Chart(trendCanvas, {
        type: "bar",
        data: {
          labels: result.monthly.map(item => item.month),
          datasets: [
            { label: "Units granted", data: result.monthly.map(item => item.granted) },
            { label: "Units refused", data: result.monthly.map(item => item.refused) },
            { label: "Units appealed", data: result.monthly.map(item => item.appealed) }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          scales: { x: { stacked: false }, y: { beginAtZero: true, title: { display: true, text: "Residential units" } } },
          plugins: { legend: { position: "bottom" } }
        }
      });
    }
    if (bandCanvas) {
      charts.bands = new Chart(bandCanvas, {
        type: "bar",
        data: { labels: result.bands.map(item => item.label), datasets: [{ label: "Applications", data: result.bands.map(item => item.count) }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: "y",
          scales: { x: { beginAtZero: true } },
          plugins: { legend: { display: false } }
        }
      });
    }
    el("#performanceDownloadTrend").disabled = !charts.trend;
    el("#performanceDownloadBands").disabled = !charts.bands;
  }

  function rankAuthorities(authorities) {
    const mode = el("#performanceRank")?.value || "speed";
    const minimum = Math.max(1, Number(el("#performanceMinSample")?.value) || 5);
    const eligible = authorities.filter(item => {
      if (mode === "acpSpeed") return item.acpDecided >= minimum && item.medianAcpDays != null;
      if (mode === "refusalRate") return item.grants + item.refusals + item.mixed >= minimum && item.refusalRate != null;
      return item.decided >= minimum;
    });
    eligible.sort((left, right) => {
      if (mode === "grantUnits") return right.grantUnits - left.grantUnits || (left.medianDecisionDays ?? Infinity) - (right.medianDecisionDays ?? Infinity);
      if (mode === "appealUnits") return right.appealUnits - left.appealUnits || right.appeals - left.appeals;
      if (mode === "refusalRate") return (left.refusalRate ?? Infinity) - (right.refusalRate ?? Infinity) || right.grantUnits - left.grantUnits;
      if (mode === "acpSpeed") return (left.medianAcpDays ?? Infinity) - (right.medianAcpDays ?? Infinity) || right.acpDecided - left.acpDecided;
      return (left.medianDecisionDays ?? Infinity) - (right.medianDecisionDays ?? Infinity) || right.decided - left.decided;
    });
    return eligible;
  }

  function renderLeaderboard() {
    if (!analysis) return;
    const ranked = rankAuthorities(analysis.authorities);
    const rows = ranked.map((item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${safeHtml(item.authority)}</td>
        <td>${format(item.decided)}</td>
        <td>${item.medianDecisionDays == null ? "—" : formatOne(item.medianDecisionDays)}</td>
        <td>${item.medianAdjustedDays == null ? "—" : formatOne(item.medianAdjustedDays)}</td>
        <td>${format(item.grantUnits)}</td>
        <td>${format(item.refusalUnits)}</td>
        <td>${percentage(item.refusalRate)}</td>
        <td>${format(item.appeals)}</td>
        <td>${format(item.appealUnits)}</td>
        <td>${item.medianAppealDays == null ? "—" : formatOne(item.medianAppealDays)}</td>
        <td>${format(item.acpCases)}</td>
        <td>${item.medianAcpDays == null ? "—" : formatOne(item.medianAcpDays)}</td>
      </tr>`).join("");
    el("#performanceLeaderboard").innerHTML = ranked.length ? `
      <table class="performance-table">
        <thead><tr><th>Rank</th><th>Authority</th><th>Decisions</th><th>Median days</th><th>FI-adjusted</th><th>Units granted</th><th>Units refused</th><th>Refusal rate</th><th>Appeals</th><th>Units appealed</th><th>Appeal days</th><th>ACP cases</th><th>ACP days</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="performance-empty">No authorities meet the current minimum sample.</div>';
  }

  function displayDate(value) {
    const time = parseTime(value);
    return time == null ? "—" : new Date(time).toLocaleDateString("en-IE");
  }

  function renderAppeals(result) {
    const rows = result.planning
      .filter(record => record.__residential && record.__appealed)
      .sort((left, right) => right.__units - left.__units)
      .slice(0, 40);
    el("#performanceAppeals").innerHTML = rows.length ? `
      <table class="performance-table">
        <thead><tr><th>Reference</th><th>Authority</th><th>Units</th><th>LA decision</th><th>Appeal ref</th><th>To appeal</th><th>Appeal days</th><th>Appeal outcome</th></tr></thead>
        <tbody>${rows.map(record => `<tr>
          <td>${safeHtml(record.ApplicationNumber || "—")}</td>
          <td>${safeHtml(record.PlanningAuthority)}</td>
          <td>${format(record.__units)}</td>
          <td>${safeHtml(record.Decision || "—")}</td>
          <td>${safeHtml(appealReference(record) || record.__acp?.ABPCASEID || "—")}</td>
          <td>${record.__decisionToAppealDays == null ? "—" : `${formatOne(record.__decisionToAppealDays)} d`}</td>
          <td>${record.__appealDays == null ? "—" : `${formatOne(record.__appealDays)} d`}</td>
          <td>${safeHtml(record.__appealDecision || record.AppealStatus || "Pending / not stated")}</td>
        </tr>`).join("")}</tbody>
      </table>` : '<div class="performance-empty">No residential appeals match the active filters.</div>';
  }

  function renderAcpCases(result) {
    const rows = result.acp.filter(record => record.__days != null).sort((left, right) => right.__days - left.__days).slice(0, 40);
    el("#performanceAcpCases").innerHTML = rows.length ? `
      <table class="performance-table">
        <thead><tr><th>ACP case</th><th>Authority</th><th>Category</th><th>Lodged</th><th>Decided</th><th>Days</th><th>Decision</th></tr></thead>
        <tbody>${rows.map(record => `<tr>
          <td>${safeHtml(record.ABPCASEID || "—")}</td>
          <td>${safeHtml(record.PLANINGATY || "Not stated")}</td>
          <td>${safeHtml(record.CATEGORY || "—")}</td>
          <td>${displayDate(record.LODGEDON)}</td>
          <td>${displayDate(record.DECIDED_ON)}</td>
          <td>${formatOne(record.__days)}</td>
          <td>${safeHtml(record.DECISION || "—")}</td>
        </tr>`).join("")}</tbody>
      </table>` : '<div class="performance-empty">No decided ACP cases match the current scope and filters.</div>';
  }

  function render(result) {
    analysis = result;
    renderMetrics(result);
    renderCharts(result);
    renderLeaderboard();
    renderAppeals(result);
    renderAcpCases(result);
    const scopeLabel = result.scope === "national" ? "National" : "Current map";
    const warnings = [];
    if (result.capped) warnings.push("one or more source layers reached the 80,000-row safety cap");
    if (result.errors.length) warnings.push(...result.errors);
    status(
      warnings.length ? `Analysis completed with limitations: ${warnings.join(" · ")}` : `Analysis complete · ${result.filterSummary}`,
      warnings.length ? "error" : "idle",
      `${scopeLabel} · ${format(result.planning.length)} planning records · ${format(result.acp.length)} ACP cases`
    );
    ["#performanceExportExcel", "#performanceExportCsv"].forEach(selector => { if (el(selector)) el(selector).disabled = false; });
  }

  async function refresh({ force = true } = {}) {
    const refreshButton = el("#performanceRefresh");
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = "Analysing…";
    }
    if (activeController) activeController.abort();
    activeController = new AbortController();
    const currentRun = ++runId;
    const key = performanceKey();
    status("Loading planning decisions, appeal fields and ACP cases…", "loading", currentScope() === "national" ? "National" : "Current map");
    try {
      const cached = cache.get(key);
      let result;
      if (!force && cached && Date.now() - cached.time < CACHE_TTL) {
        result = cached.value;
      } else {
        const data = await loadData(activeController.signal);
        if (currentRun !== runId) return;
        result = buildAnalysis(data);
        cache.set(key, { time: Date.now(), value: result });
        while (cache.size > 8) cache.delete(cache.keys().next().value);
      }
      if (currentRun !== runId) return;
      render(result);
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error("Performance analysis failed", error);
      status(`Performance analysis failed: ${error.message}`, "error", "No report generated");
    } finally {
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.textContent = "Run analysis";
      }
    }
  }

  function csvCell(value) {
    let output = String(value ?? "");
    if (/^[=+\-@]/.test(output)) output = `'${output}`;
    return `"${output.replaceAll('"', '""')}"`;
  }

  function leaderboardRows() {
    return rankAuthorities(analysis?.authorities || []).map((item, index) => ({
      Rank: index + 1,
      Authority: item.authority,
      Decisions: item.decided,
      "Median decision days": item.medianDecisionDays ?? "",
      "Median FI-adjusted days": item.medianAdjustedDays ?? "",
      "Units granted": item.grantUnits,
      "Units refused": item.refusalUnits,
      "Refusal rate": item.refusalRate == null ? "" : item.refusalRate,
      "Residential appeals": item.appeals,
      "Units appealed": item.appealUnits,
      "Median appeal days": item.medianAppealDays ?? "",
      "ACP cases": item.acpCases,
      "Median ACP days": item.medianAcpDays ?? ""
    }));
  }

  function downloadLeaderboardCsv() {
    if (!analysis) return;
    const rows = leaderboardRows();
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const content = [headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n");
    const blob = new Blob([`\uFEFF${content}`], { type: "text/csv;charset=utf-8" });
    if (window.RadharcTools?.downloadBlob) window.RadharcTools.downloadBlob(blob, `planning-performance-leaderboard-${new Date().toISOString().slice(0, 10)}.csv`);
    else {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `planning-performance-leaderboard-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  function loadSheetJs() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let script = document.querySelector("#sheetJsLibrary");
      if (!script) {
        script = document.createElement("script");
        script.id = "sheetJsLibrary";
        script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
        script.async = true;
        document.head.append(script);
      }
      const finish = () => window.XLSX ? resolve() : reject(new Error("Excel library failed to initialise"));
      script.addEventListener("load", finish, { once: true });
      script.addEventListener("error", () => reject(new Error("Excel library failed to load")), { once: true });
    });
  }

  function sheetLayout(sheet, rows) {
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) };
    sheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" };
    sheet["!cols"] = headers.map(header => ({ wch: Math.min(44, Math.max(header.length + 2, 12)) }));
  }

  function displayDate(value) {
    const time = parseTime(value);
    return time == null ? "—" : new Date(time).toLocaleDateString("en-IE");
  }

  function applicationExportRows() {
    return analysis.planning.map(record => ({
      Authority: record.PlanningAuthority,
      Reference: record.ApplicationNumber || "",
      Units: record.__units,
      Received: displayDate(record.ReceivedDate),
      "LA decision date": displayDate(record.DecisionDate),
      "LA decision": record.Decision || "",
      "Gross decision days": record.__grossDays ?? "",
      "FI-adjusted days": record.__adjustedDays ?? "",
      "Decision due date": displayDate(record.DecisionDueDate),
      "After due date": record.__late ? "Yes" : "No",
      Appealed: record.__appealed ? "Yes" : "No",
      "Appeal reference": appealReference(record) || record.__acp?.ABPCASEID || "",
      "Appeal submitted": displayDate(record.AppealSubmittedDate || record.__acp?.LODGEDON),
      "Appeal decision": record.__appealDecision || "",
      "Appeal decision date": displayDate(record.AppealDecisionDate || record.__acp?.DECIDED_ON),
      "Decision to appeal days": record.__decisionToAppealDays ?? "",
      "Appeal duration days": record.__appealDays ?? "",
      "End-to-end days": record.__endToEndDays ?? "",
      Source: record.DirectSource || record.__source || "National planning layer"
    }));
  }

  async function exportExcel() {
    if (!analysis) return;
    const button = el("#performanceExportExcel");
    const previous = button.textContent;
    button.disabled = true;
    button.textContent = "Building Excel…";
    try {
      await loadSheetJs();
      const workbook = XLSX.utils.book_new();
      const metric = analysis.metrics;
      const summary = [
        ["Planning performance intelligence", "Radharc Pleanála"],
        ["Generated", analysis.generatedAt.toLocaleString("en-IE")],
        ["Scope", analysis.scope === "national" ? "National" : "Current visible map area"],
        ["Filters", analysis.filterSummary],
        ["Planning records", analysis.planning.length],
        ["ACP cases", analysis.acp.length],
        ["Median LA decision days", metric.medianDecisionDays ?? ""],
        ["Median FI-adjusted days", metric.medianAdjustedDays ?? ""],
        ["Residential units granted", metric.grantUnits],
        ["Residential units refused", metric.refusalUnits],
        ["Residential applications appealed", metric.appealedApplications],
        ["Residential units appealed", metric.appealedUnits],
        ["Median appeal days", metric.medianAppealDays ?? ""],
        ["Median ACP case days", metric.medianAcpDays ?? ""],
        ["Matched planning / ACP appeal references", metric.matchedAppeals]
      ];
      const summarySheet = XLSX.utils.aoa_to_sheet(summary);
      summarySheet["!cols"] = [{ wch: 42 }, { wch: 72 }];
      XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");

      const applicationRows = applicationExportRows();
      const sheets = [
        ["Authority Leaderboard", leaderboardRows()],
        ["Planning Applications", applicationRows],
        ["Residential Appeals", applicationRows.filter(row => row.Appealed === "Yes" && Number(row.Units) > 0)],
        ["ACP Cases", analysis.acp.map(record => ({
          "ACP case": record.ABPCASEID || "",
          Authority: record.PLANINGATY || "",
          Category: record.CATEGORY || "",
          Lodged: displayDate(record.LODGEDON),
          Decided: displayDate(record.DECIDED_ON),
          "Duration days": record.__days ?? "",
          Decision: record.DECISION || "",
          Link: record.LINKABPWEB || ""
        }))]
      ];
      sheets.forEach(([name, rows]) => {
        const output = rows.length ? rows : [{ Status: "No matching records" }];
        const sheet = XLSX.utils.json_to_sheet(output);
        sheetLayout(sheet, output);
        XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31));
      });
      XLSX.writeFile(workbook, `planning-performance-${new Date().toISOString().slice(0, 10)}.xlsx`, { compression: true });
    } catch (error) {
      status(`Excel export failed: ${error.message}`, "error", "Analysis remains available");
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  }

  function downloadChart(key, filename) {
    const chart = charts[key];
    if (!chart) return;
    const link = document.createElement("a");
    link.href = chart.toBase64Image("image/png", 1);
    link.download = filename;
    link.click();
  }

  function markStale(reason = "Dashboard settings changed") {
    if (!analysis) return;
    status(`${reason}. Run the analysis again to update the performance report.`, "error", "Report is out of date");
  }

  function bind() {
    el("#performanceRefresh")?.addEventListener("click", () => refresh({ force: true }));
    el("#performanceRank")?.addEventListener("change", renderLeaderboard);
    el("#performanceMinSample")?.addEventListener("change", renderLeaderboard);
    el("#performanceExportCsv")?.addEventListener("click", downloadLeaderboardCsv);
    el("#performanceExportExcel")?.addEventListener("click", exportExcel);
    el("#performanceDownloadTrend")?.addEventListener("click", () => downloadChart("trend", `planning-performance-units-${new Date().toISOString().slice(0, 10)}.png`));
    el("#performanceDownloadBands")?.addEventListener("click", () => downloadChart("bands", `planning-performance-timescales-${new Date().toISOString().slice(0, 10)}.png`));
    el("#performanceScope")?.addEventListener("change", () => markStale("Performance scope changed"));
    el("#performanceIncludeAcp")?.addEventListener("change", () => markStale("ACP inclusion changed"));

    const staleInputs = "#dateRange, #customStartDate, #customEndDate, #decisionFilter, #authorityFilter, #categoryFilter, #minimumResidentialUnits, #residentialOnlyFilter";
    document.addEventListener("change", event => {
      if (event.target.matches(staleInputs)) markStale("Dashboard filters changed");
    });
    if (typeof map !== "undefined") map.on("moveend zoomend", () => {
      if (currentScope() === "map") markStale("Map extent changed");
    });
  }

  async function initialise() {
    if (initialised) return;
    initialised = true;
    const acpToggle = el('#layerToggles input[data-k="acpCases"]');
    if (el("#performanceIncludeAcp")) el("#performanceIncludeAcp").checked = acpToggle ? acpToggle.checked : true;
    bind();
    status(`Ready · ${smartSummary()}`, "idle", currentScope() === "national" ? "National" : "Current map");
  }

  window.RadharcPerformance = {
    initialise,
    refresh,
    hasData: () => Boolean(analysis),
    getAnalysis: () => analysis,
    markStale,
    clearCache: () => cache.clear()
  };
})();
