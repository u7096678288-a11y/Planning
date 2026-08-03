"use strict";

(function installDashboardBuildingControl() {
  const NBCO_API = "https://data.nbco.gov.ie/api/3/action/datastore_search_sql";
  const NBCO_RESOURCE = "0774e781-7af8-46da-b623-872e74cf541e";
  const MINIMUM_UNITS = 100;
  const CACHE_PREFIX = "radharc-building-control-kpis-v1:";
  const CACHE_TTL = 6 * 60 * 60 * 1000;
  const PLANNING_FIELDS = [
    "OBJECTID", "PlanningAuthority", "ApplicationNumber", "AppealRefNumber",
    "DevelopmentAddress", "DevelopmentDescription", "NumResidentialUnits",
    "GrantDate", "DecisionDate", "Decision", "LinkAppDetails"
  ];
  const NBCO_FIELDS = [
    "CN_Number", "CN_Planning_Permission_Number", "CN_Project_Name",
    "CN_Description_proposed_development", "CN_Commencement_Date",
    "CN_Units_for_phase", "CN_Total_Number_of_Dwelling_Units",
    "CN_Street", "CN_Town", "CN_Eircode", "CN_LAT", "CN_LNG",
    "CN_Validation_Date", "CN_Validation_Status", "CN_Not_Commenced",
    "CCC_Number", "CCC_Date_Validated", "CCC_Type_of_Completion_Certificate",
    "CCC_Units_Completed", "LocalAuthority"
  ];

  let activeController = null;
  let refreshTimer = null;
  let refreshSequence = 0;
  let currentProjectRows = [];
  let selectedLookupSequence = 0;

  const element = selector => document.querySelector(selector);
  const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const number = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : 0;
  const format = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));

  function canonicalAuthority(value) {
    const authority = text(value).toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const aliases = [
      ["DUBLIN CITY", "DUBLIN CITY COUNCIL"],
      ["CORK CITY", "CORK CITY COUNCIL"],
      ["CORK COUNTY", "CORK COUNTY COUNCIL"],
      ["DUN LAOGHAIRE RATHDOWN", "DUN LAOGHAIRE RATHDOWN COUNTY COUNCIL"],
      ["FINGAL", "FINGAL COUNTY COUNCIL"],
      ["SOUTH DUBLIN", "SOUTH DUBLIN COUNTY COUNCIL"],
      ["GALWAY CITY", "GALWAY CITY COUNCIL"],
      ["GALWAY COUNTY", "GALWAY COUNTY COUNCIL"],
      ["LIMERICK", "LIMERICK CITY AND COUNTY COUNCIL"],
      ["WATERFORD", "WATERFORD CITY AND COUNTY COUNCIL"]
    ];
    for (const [match, canonical] of aliases) if (authority.includes(match)) return canonical;
    return authority;
  }

  function normaliseReference(value) {
    return text(value).toUpperCase()
      .replace(/\b(PLANNING|PERMISSION|REFERENCE|REF|APPLICATION|APP|NO|NUMBER)\b/g, "")
      .replace(/[^A-Z0-9]/g, "");
  }

  function referenceTokens(value) {
    const raw = text(value).toUpperCase();
    const tokens = new Set();
    const full = normaliseReference(raw);
    if (full.length >= 4) tokens.add(full);
    (raw.match(/[A-Z]{0,6}[0-9][A-Z0-9\/\-.]{3,}/g) || []).forEach(candidate => {
      const token = normaliseReference(candidate);
      if (token.length >= 4) tokens.add(token);
    });
    (raw.match(/\d{6}/g) || []).forEach(token => tokens.add(token));
    return [...tokens];
  }

  function acpReference(value) {
    const matches = text(value).match(/\d{6}/g);
    return matches?.at(-1) || "";
  }

  function normaliseAddress(value) {
    return text(value).toUpperCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\b(ROAD|RD)\b/g, "RD")
      .replace(/\b(STREET|ST)\b/g, "ST")
      .replace(/\b(AVENUE|AVE)\b/g, "AVE")
      .replace(/[^A-Z0-9 ]/g, " ")
      .replace(/\b(THE|AT|AND|OF|IRELAND)\b/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  function addressSimilarity(left, right) {
    const a = new Set(normaliseAddress(left).split(" ").filter(token => token.length > 1));
    const b = new Set(normaliseAddress(right).split(" ").filter(token => token.length > 1));
    if (!a.size || !b.size) return 0;
    let common = 0;
    a.forEach(token => { if (b.has(token)) common += 1; });
    return 2 * common / (a.size + b.size);
  }

  function coordinate(value) {
    const parsed = Number(String(value ?? "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function distanceMetres(lat1, lng1, lat2, lng2) {
    if ([lat1, lng1, lat2, lng2].some(value => value == null || !Number.isFinite(Number(value)))) return null;
    const radius = 6371000;
    const radians = value => Number(value) * Math.PI / 180;
    const dLat = radians(Number(lat2) - Number(lat1));
    const dLng = radians(Number(lng2) - Number(lng1));
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * radius * Math.asin(Math.sqrt(value));
  }

  function distancePoints(distance) {
    if (distance == null) return 0;
    if (distance <= 75) return 10;
    if (distance <= 150) return 9;
    if (distance <= 300) return 7;
    if (distance <= 750) return 4;
    if (distance <= 1500) return 2;
    return 0;
  }

  function sqlText(value) {
    return String(value ?? "").replaceAll("'", "''");
  }

  function encodeBody(parameters) {
    const body = new URLSearchParams();
    Object.entries({ f: "json", ...parameters }).forEach(([key, value]) => {
      if (value == null) return;
      body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    });
    return body;
  }

  function selectedLayer(key) {
    try {
      if (window.RadharcSelectedLayerQueries?.selected) return window.RadharcSelectedLayerQueries.selected(key);
      const input = document.querySelector(`#layerToggles input[data-k="${key}"]`);
      if (input) return input.checked && !input.disabled;
      return Boolean(layers[key] && map.hasLayer(layers[key]));
    } catch {
      return false;
    }
  }

  function planningSelected() {
    return selectedLayer("planningPoints") || selectedLayer("planningSites") || selectedLayer("corkCityDirect");
  }

  function activeMinimumUnits() {
    try {
      if (window.RadharcResidentialUnits?.isActive?.()) return Math.max(MINIMUM_UNITS, Number(smartState.minUnits) || MINIMUM_UNITS);
    } catch {}
    return MINIMUM_UNITS;
  }

  function currentGeometry() {
    try { return geom(); } catch { return {}; }
  }

  function currentPlanningWhere() {
    try { return smartPlanningWhere(); } catch {
      try { return cutoff(); } catch { return "1=1"; }
    }
  }

  async function arcgisPlanningRows(where, geometry, signal) {
    const rows = [];
    for (let offset = 0; offset < 10000; offset += 2000) {
      const response = await fetch(`${S.planningPoints.url}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: encodeBody({
          where,
          outFields: PLANNING_FIELDS.join(","),
          returnGeometry: true,
          outSR: 4326,
          resultOffset: offset,
          resultRecordCount: 2000,
          orderByFields: "OBJECTID ASC",
          ...geometry
        }),
        cache: "no-store",
        credentials: "omit",
        signal
      });
      if (!response.ok) throw new Error(`Planning HTTP ${response.status}`);
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      const batch = (data.features || []).map(feature => ({
        ...(feature.attributes || {}),
        __lat: feature.geometry?.y ?? null,
        __lng: feature.geometry?.x ?? null,
        __source: "national"
      }));
      rows.push(...batch);
      if (!batch.length || (batch.length < 2000 && !data.exceededTransferLimit)) break;
    }
    return rows;
  }

  async function corkPlanningRows(geometry) {
    if (!selectedLayer("corkCityDirect") || !window.CorkCityCKAN?.allRecords) return [];
    const rows = await window.CorkCityCKAN.allRecords({ geometry, maxRows: 10000 });
    const minimum = activeMinimumUnits();
    return rows.filter(record => number(record.NumResidentialUnits) >= minimum).map(record => ({
      ...record,
      PlanningAuthority: "Cork City Council",
      NumResidentialUnits: number(record.NumResidentialUnits),
      __lat: coordinate(record.Latitude),
      __lng: coordinate(record.Longitude),
      __source: "cork"
    }));
  }

  function dedupePlanning(rows) {
    const records = new Map();
    rows.forEach((record, index) => {
      const reference = normaliseReference(record.ApplicationNumber);
      const key = `${canonicalAuthority(record.PlanningAuthority)}|${reference || record.OBJECTID || index}`;
      const previous = records.get(key);
      if (!previous || record.__source === "cork") records.set(key, record);
    });
    return [...records.values()];
  }

  function jsonp(sql, signal) {
    return new Promise((resolve, reject) => {
      const callback = `__radharcBuildingControl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");
      const url = new URL(NBCO_API);
      url.searchParams.set("sql", sql);
      url.searchParams.set("callback", callback);
      let completed = false;
      const clean = () => {
        script.remove();
        try { delete window[callback]; } catch { window[callback] = undefined; }
      };
      const finish = (handler, value) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        clean();
        handler(value);
      };
      const timeout = setTimeout(() => finish(reject, new Error("NBCO query timed out")), 30000);
      const abort = () => finish(reject, new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      window[callback] = payload => payload?.success
        ? finish(resolve, payload.result?.records || [])
        : finish(reject, new Error(payload?.error?.message || "NBCO query failed"));
      script.onerror = () => finish(reject, new Error("NBCO service unavailable"));
      script.src = url.toString();
      document.head.append(script);
    });
  }

  function selectFields() {
    return NBCO_FIELDS.map(field => `"${field}"`).join(",");
  }

  async function nbcoRowsForPlanning(planningRows, signal, onProgress = () => {}) {
    const output = [];
    for (let index = 0; index < planningRows.length; index += 16) {
      const group = planningRows.slice(index, index + 16);
      const clauses = [];
      group.forEach(record => {
        const tokens = [...referenceTokens(record.ApplicationNumber), acpReference(record.AppealRefNumber)].filter(Boolean);
        tokens.forEach(token => clauses.push(`regexp_replace(upper(COALESCE("CN_Planning_Permission_Number",'')),'[^A-Z0-9]','','g') LIKE '%${sqlText(token)}%'`));
      });
      if (!clauses.length) continue;
      const sql = `SELECT ${selectFields()} FROM "${NBCO_RESOURCE}" WHERE "CN_Number" IS NOT NULL AND (${[...new Set(clauses)].join(" OR ")}) LIMIT 30000`;
      output.push(...await jsonp(sql, signal));
      onProgress(Math.min(index + group.length, planningRows.length), planningRows.length);
    }
    return output;
  }

  function scoreCandidate(planning, row) {
    const planningTokens = referenceTokens(planning.ApplicationNumber);
    const appeal = acpReference(planning.AppealRefNumber);
    const rowTokens = referenceTokens(row.CN_Planning_Permission_Number);
    const rowNormal = normaliseReference(row.CN_Planning_Permission_Number);
    let score = 0;
    const reasons = [];
    const exact = planningTokens.some(token => rowTokens.includes(token));
    const contained = !exact && Boolean(rowNormal) && planningTokens.some(token => rowNormal.includes(token) || token.includes(rowNormal));
    const appealMatch = Boolean(appeal) && (rowTokens.includes(appeal) || rowNormal.includes(appeal));
    if (exact) { score += 75; reasons.push("exact planning reference"); }
    else if (contained) { score += 60; reasons.push("planning reference token"); }
    else if (appealMatch) { score += 55; reasons.push("ACP reference"); }

    const planningAuthority = canonicalAuthority(planning.PlanningAuthority);
    const buildingAuthority = canonicalAuthority(row.LocalAuthority);
    if (planningAuthority && buildingAuthority && planningAuthority === buildingAuthority) {
      score += 15;
      reasons.push("authority");
    } else if (planningAuthority && buildingAuthority && planningAuthority !== buildingAuthority) {
      score -= 12;
    }

    const address = addressSimilarity(
      `${planning.DevelopmentAddress} ${planning.DevelopmentDescription}`,
      `${row.CN_Project_Name} ${row.CN_Street} ${row.CN_Town} ${row.CN_Description_proposed_development}`
    );
    if (address >= 0.25) {
      score += Math.min(10, Math.round(address * 10));
      reasons.push(`address ${Math.round(address * 100)}%`);
    }

    const distance = distanceMetres(
      coordinate(planning.__lat), coordinate(planning.__lng),
      coordinate(row.CN_LAT), coordinate(row.CN_LNG)
    );
    const spatial = distancePoints(distance);
    if (spatial) {
      score += spatial;
      reasons.push(`${Math.round(distance)} m`);
    }

    return {
      score: Math.max(0, Math.min(100, score)),
      reasons: reasons.join(" · ") || "no supporting evidence",
      distance,
      exact
    };
  }

  function commencementKey(row) {
    return `${canonicalAuthority(row.LocalAuthority)}|${text(row.CN_Number)}`;
  }

  function assignRows(planningRows, nbcoRows) {
    const candidates = [];
    planningRows.forEach(planning => nbcoRows.forEach(row => {
      const scored = scoreCandidate(planning, row);
      if (scored.score >= 55) candidates.push({ planning, row, ...scored });
    }));

    const byCommencement = new Map();
    candidates.sort((left, right) => right.score - left.score).forEach(candidate => {
      const key = commencementKey(candidate.row);
      if (!byCommencement.has(key)) byCommencement.set(key, []);
      byCommencement.get(key).push(candidate);
    });

    const assigned = new Map(planningRows.map(record => [record.OBJECTID ?? `${record.PlanningAuthority}|${record.ApplicationNumber}`, []]));
    let reviewCount = 0;
    byCommencement.forEach(list => {
      list.sort((left, right) => right.score - left.score);
      const best = list[0];
      const margin = best.score - (list[1]?.score ?? 0);
      if (best.score >= 75 && margin >= 8) {
        const key = best.planning.OBJECTID ?? `${best.planning.PlanningAuthority}|${best.planning.ApplicationNumber}`;
        assigned.get(key)?.push(best);
      } else if (best.score >= 65) {
        reviewCount += 1;
      }
    });
    return { assigned, reviewCount };
  }

  function isNotCommenced(row) {
    const value = text(row.CN_Not_Commenced).toUpperCase();
    return value === "1" || value === "TRUE" || value === "YES";
  }

  function isValidatedCertificate(row) {
    return Boolean(text(row.CCC_Number)) && Boolean(row.CCC_Date_Validated);
  }

  function aggregatePlanning(planning, claims) {
    const commencementRows = new Map();
    const certificateRows = new Map();
    claims.forEach(claim => {
      const row = claim.row;
      const commencement = commencementKey(row);
      if (!commencementRows.has(commencement)) commencementRows.set(commencement, row);
      if (isValidatedCertificate(row)) {
        const certificate = `${canonicalAuthority(row.LocalAuthority)}|${text(row.CCC_Number)}`;
        if (!certificateRows.has(certificate)) certificateRows.set(certificate, row);
      }
    });

    const commencements = [...commencementRows.values()].filter(row => !isNotCommenced(row) && Boolean(row.CN_Commencement_Date));
    const phaseUnits = commencements.reduce((sum, row) => sum + Math.max(0, number(row.CN_Units_for_phase)), 0);
    const totalFallback = Math.max(0, ...commencements.map(row => number(row.CN_Total_Number_of_Dwelling_Units)));
    const unitsCommenced = phaseUnits > 0 ? phaseUnits : totalFallback;
    const certificates = [...certificateRows.values()];
    const unitsCompleted = certificates.reduce((sum, row) => sum + Math.max(0, number(row.CCC_Units_Completed)), 0);
    const approvedUnits = number(planning.NumResidentialUnits);
    const fullCertificate = certificates.some(row => /full completion|all buildings|full certificate/i.test(text(row.CCC_Type_of_Completion_Certificate)));
    const completeByUnits = approvedUnits > 0 && unitsCompleted >= approvedUnits;
    const scores = claims.map(claim => claim.score);
    const bestScore = scores.length ? Math.max(...scores) : 0;
    const methods = [...new Set(claims.map(claim => claim.reasons).filter(Boolean))];

    let status = "No building-control match";
    if (commencements.length) status = "Commenced";
    if (certificates.length) status = "Completion evidence";
    if (fullCertificate || completeByUnits) status = "Completed";

    return {
      planningRef: text(planning.ApplicationNumber),
      acpRef: acpReference(planning.AppealRefNumber),
      authority: text(planning.PlanningAuthority),
      address: text(planning.DevelopmentAddress),
      approvedUnits,
      commencementCount: commencements.length,
      commencementNumbers: commencements.map(row => text(row.CN_Number)).filter(Boolean),
      unitsCommenced,
      certificateCount: certificates.length,
      certificateNumbers: certificates.map(row => text(row.CCC_Number)).filter(Boolean),
      unitsCompleted,
      completed: fullCertificate || completeByUnits,
      completionEvidence: certificates.length > 0,
      status,
      bestScore,
      matchMethod: methods.slice(0, 3).join(" | "),
      planningUrl: planning.LinkAppDetails || ""
    };
  }

  function buildProjectRows(planningRows, assignment) {
    return planningRows.map(planning => {
      const key = planning.OBJECTID ?? `${planning.PlanningAuthority}|${planning.ApplicationNumber}`;
      return aggregatePlanning(planning, assignment.assigned.get(key) || []);
    });
  }

  function totals(rows, reviewCount = 0) {
    const matched = rows.filter(row => row.commencementCount > 0 || row.certificateCount > 0);
    return {
      planningProjects: rows.length,
      matchedProjects: matched.length,
      commencedProjects: rows.filter(row => row.commencementCount > 0).length,
      unitsCommenced: rows.reduce((sum, row) => sum + row.unitsCommenced, 0),
      completionProjects: rows.filter(row => row.completionEvidence).length,
      completedProjects: rows.filter(row => row.completed).length,
      unitsCompleted: rows.reduce((sum, row) => sum + row.unitsCompleted, 0),
      reviewCount
    };
  }

  function injectDashboard() {
    const grid = element(".metric-grid");
    if (!grid || element("#commencedProjectsCount")) return;
    const cards = [
      ["Commenced projects", "commencedProjectsCount", "commencedProjectsCoverage", "Matched 100+ unit permissions with a commencement date"],
      ["Units commenced", "commencedUnitsCount", "commencedUnitsCoverage", "Unique phase units across matched commencement notices"],
      ["Projects with completion", "completionProjectsCount", "completionProjectsCoverage", "Matched permissions with a validated completion certificate"],
      ["Units completed", "completedUnitsCount", "completedUnitsCoverage", "Unique units reported on validated completion certificates"]
    ];
    cards.forEach(([label, valueId, coverageId, note]) => {
      const card = document.createElement("article");
      card.className = "metric-card building-control-metric";
      card.innerHTML = `<span>${escapeHtml(label)}</span><strong id="${valueId}">—</strong><small id="${coverageId}">${escapeHtml(note)}</small>`;
      grid.append(card);
    });
    const note = document.createElement("p");
    note.id = "buildingControlKpiStatus";
    note.className = "data-quality-note";
    note.innerHTML = `Building-control KPIs are waiting for the live NBCO match. <a href="completions.html" target="_blank" rel="noopener">Open completion audit ↗</a>`;
    grid.after(note);
  }

  function setKpiValue(valueId, coverageId, value, coverage) {
    const valueNode = element(`#${valueId}`);
    const coverageNode = element(`#${coverageId}`);
    if (valueNode) valueNode.textContent = value;
    if (coverageNode) coverageNode.textContent = coverage;
  }

  function showLoading(message = "Matching NBCO records…") {
    ["commencedProjectsCount", "commencedUnitsCount", "completionProjectsCount", "completedUnitsCount"].forEach(id => {
      const node = element(`#${id}`);
      if (node) node.textContent = "…";
    });
    const status = element("#buildingControlKpiStatus");
    if (status) status.innerHTML = `${escapeHtml(message)} <a href="completions.html" target="_blank" rel="noopener">Open completion audit ↗</a>`;
  }

  function renderTotals(summary, source = "live") {
    setKpiValue("commencedProjectsCount", "commencedProjectsCoverage", format(summary.commencedProjects), `${format(summary.matchedProjects)} of ${format(summary.planningProjects)} qualifying planning projects matched`);
    setKpiValue("commencedUnitsCount", "commencedUnitsCoverage", format(summary.unitsCommenced), "Deduplicated commencement phase units; project total used only as fallback");
    setKpiValue("completionProjectsCount", "completionProjectsCoverage", format(summary.completionProjects), `${format(summary.completedProjects)} appear fully completed; phased completions are retained`);
    setKpiValue("completedUnitsCount", "completedUnitsCoverage", format(summary.unitsCompleted), "Deduplicated validated CCC units");
    const status = element("#buildingControlKpiStatus");
    if (status) {
      const review = summary.reviewCount ? ` · ${format(summary.reviewCount)} ambiguous commencement match${summary.reviewCount === 1 ? "" : "es"} withheld for review` : "";
      status.innerHTML = `NBCO connection ${source === "cache" ? "restored from the latest browser cache" : "updated live"} · ${format(summary.matchedProjects)} matched project${summary.matchedProjects === 1 ? "" : "s"}${review}. <button id="exportBuildingControlKpis" type="button" class="secondary-button">Export matched KPI CSV</button> <a href="completions.html" target="_blank" rel="noopener">Open full completion audit ↗</a>`;
      element("#exportBuildingControlKpis")?.addEventListener("click", exportCurrentRows, { once: true });
    }
  }

  function showNotSelected() {
    setKpiValue("commencedProjectsCount", "commencedProjectsCoverage", "Not selected", "Select a planning layer to calculate building-control KPIs");
    setKpiValue("commencedUnitsCount", "commencedUnitsCoverage", "—", "Select a planning layer to calculate commenced units");
    setKpiValue("completionProjectsCount", "completionProjectsCoverage", "Not selected", "Select a planning layer to calculate completion evidence");
    setKpiValue("completedUnitsCount", "completedUnitsCoverage", "—", "Select a planning layer to calculate completed units");
    const status = element("#buildingControlKpiStatus");
    if (status) status.innerHTML = `Building-control KPIs are paused because no planning layer is selected. <a href="completions.html" target="_blank" rel="noopener">Open completion audit ↗</a>`;
  }

  function showUnavailable(message) {
    [
      ["commencedProjectsCount", "commencedProjectsCoverage"],
      ["commencedUnitsCount", "commencedUnitsCoverage"],
      ["completionProjectsCount", "completionProjectsCoverage"],
      ["completedUnitsCount", "completedUnitsCoverage"]
    ].forEach(([valueId, coverageId]) => setKpiValue(valueId, coverageId, "Unavailable", message));
    const status = element("#buildingControlKpiStatus");
    if (status) status.innerHTML = `${escapeHtml(message)} <a href="completions.html" target="_blank" rel="noopener">Open completion audit ↗</a>`;
  }

  function simpleHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function cacheKey(planningRows) {
    const references = planningRows.map(row => `${canonicalAuthority(row.PlanningAuthority)}:${normaliseReference(row.ApplicationNumber)}`).sort().join("|");
    return `${CACHE_PREFIX}${simpleHash(references)}`;
  }

  function restoreCache(key) {
    try {
      const cached = JSON.parse(localStorage.getItem(key) || "null");
      if (!cached || Date.now() - cached.savedAt > CACHE_TTL || !Array.isArray(cached.rows)) return false;
      currentProjectRows = cached.rows;
      renderTotals(cached.summary, "cache");
      return true;
    } catch {
      return false;
    }
  }

  function saveCache(key, rows, summary) {
    try {
      localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), rows, summary }));
    } catch {}
  }

  async function loadPlanningRows(signal) {
    const geometry = currentGeometry();
    const minimum = activeMinimumUnits();
    let where = `(${currentPlanningWhere()}) AND NumResidentialUnits >= ${minimum}`;
    if (selectedLayer("corkCityDirect")) where += " AND (PlanningAuthority IS NULL OR UPPER(PlanningAuthority) NOT LIKE 'CORK CITY%')";
    const jobs = [];
    if (selectedLayer("planningPoints") || selectedLayer("planningSites")) jobs.push(arcgisPlanningRows(where, geometry, signal));
    else jobs.push(Promise.resolve([]));
    jobs.push(corkPlanningRows(geometry));
    const [national, cork] = await Promise.all(jobs);
    return dedupePlanning([...national, ...cork]);
  }

  async function refreshNow({ background = false } = {}) {
    injectDashboard();
    if (!planningSelected()) {
      activeController?.abort();
      showNotSelected();
      return;
    }
    const sequence = ++refreshSequence;
    activeController?.abort();
    activeController = new AbortController();
    if (!background) showLoading();
    try {
      const planningRows = await loadPlanningRows(activeController.signal);
      if (sequence !== refreshSequence) return;
      if (!planningRows.length) {
        currentProjectRows = [];
        renderTotals(totals([]));
        return;
      }
      const key = cacheKey(planningRows);
      const restored = restoreCache(key);
      if (!restored) showLoading(`Matching ${format(planningRows.length)} qualifying planning projects to NBCO…`);
      const nbcoRows = await nbcoRowsForPlanning(planningRows, activeController.signal, (done, total) => {
        if (sequence !== refreshSequence) return;
        const status = element("#buildingControlKpiStatus");
        if (status) status.innerHTML = `Matching NBCO references · ${format(done)} of ${format(total)} projects. <a href="completions.html" target="_blank" rel="noopener">Open completion audit ↗</a>`;
      });
      if (sequence !== refreshSequence) return;
      const assignment = assignRows(planningRows, nbcoRows);
      currentProjectRows = buildProjectRows(planningRows, assignment);
      const summary = totals(currentProjectRows, assignment.reviewCount);
      saveCache(key, currentProjectRows, summary);
      renderTotals(summary, "live");
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error("Building-control KPI refresh failed", error);
      if (!currentProjectRows.length) showUnavailable(`NBCO KPI connection failed: ${error.message}`);
      else {
        const summary = totals(currentProjectRows);
        renderTotals(summary, "cache");
      }
    }
  }

  function scheduleRefresh(delay = 900) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshNow(), delay);
  }

  function csvCell(value) {
    let output = String(value ?? "");
    if (/^[=+\-@]/.test(output)) output = `'${output}`;
    return `"${output.replaceAll('"', '""')}"`;
  }

  function exportCurrentRows() {
    if (!currentProjectRows.length) return;
    const rows = currentProjectRows.filter(row => row.commencementCount || row.certificateCount).map(row => ({
      "Planning reference": row.planningRef,
      "ACP reference": row.acpRef,
      "Planning authority": row.authority,
      Address: row.address,
      "Approved units": row.approvedUnits,
      "Commencement notices": row.commencementCount,
      "Commencement numbers": row.commencementNumbers.join("; "),
      "Units commenced": row.unitsCommenced,
      "Completion certificates": row.certificateCount,
      "Completion certificate numbers": row.certificateNumbers.join("; "),
      "Units completed": row.unitsCompleted,
      Status: row.status,
      "Best match score": row.bestScore,
      "Match method": row.matchMethod
    }));
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const csv = [headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `radharc-building-control-kpis-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function lookupSelectedRecord(properties, sequence) {
    const planning = {
      ...properties,
      __lat: coordinate(properties.Latitude),
      __lng: coordinate(properties.Longitude)
    };
    const key = `${canonicalAuthority(planning.PlanningAuthority)}|${normaliseReference(planning.ApplicationNumber)}`;
    const cached = currentProjectRows.find(row => `${canonicalAuthority(row.authority)}|${normaliseReference(row.planningRef)}` === key);
    if (cached) return cached;
    const controller = new AbortController();
    const rows = await nbcoRowsForPlanning([planning], controller.signal);
    if (sequence !== selectedLookupSequence) return null;
    const assignment = assignRows([planning], rows);
    return buildProjectRows([planning], assignment)[0] || null;
  }

  function appendSelectedBuildingControl(properties) {
    const container = element("#selectedRecord");
    if (!container || !properties?.ApplicationNumber) return;
    container.querySelector(".building-control-record")?.remove();
    const block = document.createElement("div");
    block.className = "building-control-record";
    block.innerHTML = `<hr><strong>Building control</strong><p class="muted small">Matching commencement and completion evidence…</p>`;
    container.append(block);
    const sequence = ++selectedLookupSequence;
    lookupSelectedRecord(properties, sequence).then(result => {
      if (sequence !== selectedLookupSequence || !block.isConnected) return;
      if (!result || (!result.commencementCount && !result.certificateCount)) {
        block.innerHTML = `<hr><strong>Building control</strong><p class="muted small">No high-confidence NBCO commencement or completion match found.</p><a href="completions.html" target="_blank" rel="noopener">Review in Completions Matcher ↗</a>`;
        return;
      }
      block.innerHTML = `<hr><strong>Building control</strong><dl>
        <div><dt>Status</dt><dd>${escapeHtml(result.status)}</dd></div>
        <div><dt>Commencement notices</dt><dd>${format(result.commencementCount)}</dd></div>
        <div><dt>Units commenced</dt><dd>${format(result.unitsCommenced)}</dd></div>
        <div><dt>Completion certificates</dt><dd>${format(result.certificateCount)}</dd></div>
        <div><dt>Units completed</dt><dd>${format(result.unitsCompleted)}</dd></div>
        <div><dt>Match score</dt><dd>${format(result.bestScore)}/100</dd></div>
      </dl><a href="completions.html" target="_blank" rel="noopener">Open completion audit ↗</a>`;
    }).catch(error => {
      if (sequence !== selectedLookupSequence || !block.isConnected) return;
      block.innerHTML = `<hr><strong>Building control</strong><p class="muted small">NBCO lookup unavailable: ${escapeHtml(error.message)}</p>`;
    });
  }

  function patchSelectedRecord() {
    if (typeof select !== "function" || select.__buildingControlPatched) return;
    const previous = select;
    const wrapped = function buildingControlSelectedRecord(key, feature, latlng) {
      const result = previous.apply(this, arguments);
      try {
        if (S[key]?.type === "planning") {
          const properties = feature?.properties || feature?.attributes || {};
          queueMicrotask(() => appendSelectedBuildingControl(properties));
        }
      } catch (error) {
        console.warn("Selected building-control lookup failed", error);
      }
      return result;
    };
    wrapped.__buildingControlPatched = true;
    select = wrapped;
  }

  function patchDashboardRefresh() {
    if (typeof update === "function" && !update.__buildingControlPatched) {
      const previous = update;
      const wrapped = function buildingControlDashboardUpdate() {
        return Promise.resolve(previous.apply(this, arguments)).finally(() => scheduleRefresh());
      };
      wrapped.__buildingControlPatched = true;
      update = wrapped;
    }
    if (window.RadharcDashboard?.syncNow && !window.RadharcDashboard.syncNow.__buildingControlPatched) {
      const previous = window.RadharcDashboard.syncNow;
      const wrapped = function buildingControlDashboardSync() {
        return Promise.resolve(previous.apply(this, arguments)).finally(() => scheduleRefresh());
      };
      wrapped.__buildingControlPatched = true;
      window.RadharcDashboard.syncNow = wrapped;
    }
  }

  function bindAdditionalChanges() {
    ["#dateRange", "#decisionFilter", "#authorityFilter", "#clearSmartFilters", "#applyCustomDates", "#clearCustomDates", "#layerToggles"].forEach(selector => {
      element(selector)?.addEventListener("change", () => scheduleRefresh(1100));
      element(selector)?.addEventListener("click", () => scheduleRefresh(1100));
    });
  }

  function install() {
    injectDashboard();
    patchSelectedRecord();
    patchDashboardRefresh();
    bindAdditionalChanges();
    window.RadharcBuildingControlKpis = {
      refresh: () => refreshNow(),
      currentRows: () => currentProjectRows.map(row => ({ ...row })),
      exportCsv: exportCurrentRows
    };
    scheduleRefresh(250);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
