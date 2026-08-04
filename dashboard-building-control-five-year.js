"use strict";

(function installFiveYearBuildingControlDashboard() {
  const core = window.RadharcBuildingControlCore;
  if (!core) throw new Error("Building-control matching core did not load");

  const PLANNING_POINTS = "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0";
  const PLANNING_SITES = "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/1";
  const CORK_API = "https://data.corkcity.ie/api/3/action/datastore_search_sql";
  const CORK_RESOURCE = "8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";
  const NBCO_API = "https://data.nbco.gov.ie/api/3/action/datastore_search_sql";
  const NBCO_RESOURCE = "0774e781-7af8-46da-b623-872e74cf541e";
  const MIN_UNITS = 3;
  const YEARS = 5;
  const PAGE_SIZE = 5000;
  const CACHE_PREFIX = "radharc-dashboard-building-control-five-year-v1:";
  const CACHE_TTL = 6 * 60 * 60 * 1000;

  const PLANNING_FIELDS = [
    "OBJECTID", "PlanningAuthority", "ApplicationNumber", "AppealRefNumber",
    "DevelopmentAddress", "DevelopmentDescription", "NumResidentialUnits",
    "ReceivedDate", "GrantDate", "DecisionDate", "Decision", "LinkAppDetails"
  ];
  const NBCO_FIELDS = [
    "IDs", "CN_Project_Name", "CN_Description_proposed_development",
    "CN_Planning_Permission_Number", "CN_Date_Granted", "CN_Date_Submitted_or_Received",
    "CN_LAT", "CN_LNG", "CN_Number", "CN_Commencement_Date", "CN_Units_for_phase",
    "CN_Phase_for_this_Notice", "CN_Street", "CN_Town", "CN_Eircode", "CN_County",
    "CN_Total_Number_of_Dwelling_Units", "CN_Total_Number_Multiple_Unit_Dwellings",
    "CN_Validation_Date", "CN_Total_Number_of_Phases", "CN_Not_Commenced",
    "CCC_Description", "CCC_Number", "CCC_Date_Validated",
    "CCC_Type_of_Completion_Certificate", "CCC_Units_Completed",
    "LocalAuthority", "Building_Number", "Submission_Number"
  ];

  let controller = null;
  let timer = null;
  let runSequence = 0;
  let selectedSequence = 0;
  let currentProjects = [];
  let currentSummary = null;

  const element = selector => document.querySelector(selector);
  const text = core.text;
  const number = core.number;
  const format = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const percentage = (value, total) => total > 0
    ? `${new Intl.NumberFormat("en-IE", { maximumFractionDigits: 1 }).format((100 * value) / total)}%`
    : "—";
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));

  function displayDate(value) {
    const time = core.parseTime(value);
    return time == null ? "—" : new Date(time).toLocaleDateString("en-IE", {
      day: "2-digit", month: "short", year: "numeric"
    });
  }

  function startDate() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setFullYear(date.getFullYear() - YEARS);
    return date;
  }

  function selectedLayer(key) {
    const input = element(`#layerToggles input[data-k="${key}"]`);
    if (input) return input.checked && !input.disabled;
    try {
      return Boolean(typeof layers !== "undefined" && layers[key] && map.hasLayer(layers[key]));
    } catch {
      return false;
    }
  }

  function anyPlanningLayerSelected() {
    return selectedLayer("planningPoints") || selectedLayer("planningSites") || selectedLayer("corkCityDirect");
  }

  function activeGeometry() {
    try {
      return typeof geom === "function" ? geom() : null;
    } catch {
      return null;
    }
  }

  function geometryBox(geometry = activeGeometry()) {
    if (!geometry?.geometry) return null;
    try {
      const box = typeof geometry.geometry === "string" ? JSON.parse(geometry.geometry) : geometry.geometry;
      const values = [box.xmin, box.ymin, box.xmax, box.ymax].map(Number);
      if (values.some(value => !Number.isFinite(value))) return null;
      return { west: values[0], south: values[1], east: values[2], north: values[3] };
    } catch {
      return null;
    }
  }

  function smartClause(field, values) {
    if (!Array.isArray(values) || !values.length) return "";
    const parts = values.map(value => {
      if (typeof smartNull !== "undefined" && value === smartNull) return `(${field} IS NULL OR ${field} = '')`;
      return `${field} = '${String(value).replaceAll("'", "''")}'`;
    });
    return `(${parts.join(" OR ")})`;
  }

  function planningWhere() {
    const clauses = [`NumResidentialUnits >= ${MIN_UNITS}`, "ReceivedDate >= DATE '2014-01-01'"];
    try {
      const decision = smartClause("Decision", smartState.decision);
      const authority = smartClause("PlanningAuthority", smartState.authority);
      if (decision) clauses.push(decision);
      if (authority) clauses.push(authority);
    } catch {}
    return clauses.map(clause => `(${clause})`).join(" AND ");
  }

  function encodeBody(parameters) {
    const body = new URLSearchParams();
    Object.entries({ f: "geojson", ...parameters }).forEach(([key, value]) => {
      if (value == null) return;
      body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    });
    return body;
  }

  async function arcgisRows(url, where, geometry, signal, source) {
    const output = [];
    for (let offset = 0; offset < 60000; offset += 2000) {
      const response = await fetch(`${url}/query`, {
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
          ...(geometry || {})
        }),
        cache: "no-store",
        credentials: "omit",
        signal
      });
      if (!response.ok) throw new Error(`Planning service HTTP ${response.status}`);
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      const batch = data.features || [];
      output.push(...batch.map(feature => ({
        ...(feature.properties || {}),
        __lat: feature.geometry?.coordinates?.[1] ?? null,
        __lng: feature.geometry?.coordinates?.[0] ?? null,
        __source: source
      })));
      if (!batch.length || batch.length < 2000) break;
    }
    return output;
  }

  function sqlText(value) {
    return String(value ?? "").replaceAll("'", "''");
  }

  function jsonp(api, sql, signal, timeoutMs = 40000) {
    return new Promise((resolve, reject) => {
      const callback = `__radharcDashboardBC_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");
      const url = new URL(api);
      let finished = false;
      url.searchParams.set("sql", sql);
      url.searchParams.set("callback", callback);
      const cleanup = () => {
        script.remove();
        try { delete window[callback]; } catch { window[callback] = undefined; }
      };
      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        cleanup();
        fn(value);
      };
      const timeout = setTimeout(() => finish(reject, new Error("Building-control datastore timed out")), timeoutMs);
      const abort = () => finish(reject, new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      window[callback] = payload => payload?.success
        ? finish(resolve, payload.result?.records || [])
        : finish(reject, new Error(payload?.error?.message || "Building-control datastore query failed"));
      script.onerror = () => finish(reject, new Error("Building-control datastore could not be reached"));
      script.src = url.toString();
      document.head.append(script);
    });
  }

  function corkFilterSql(box) {
    const clauses = [`COALESCE("NumResidentialUnits",0) >= ${MIN_UNITS}`, `"ReceivedDate" >= '2014-01-01'::timestamp`];
    if (box) clauses.push(`"Longitude" BETWEEN ${box.west} AND ${box.east} AND "Latitude" BETWEEN ${box.south} AND ${box.north}`);
    try {
      if (smartState.authority.length && !smartState.authority.some(value => core.canonicalAuthority(value) === "CORK CITY COUNCIL")) clauses.push("FALSE");
      if (smartState.decision.length) {
        const values = smartState.decision.filter(value => value !== smartNull).map(value => `"Decision" = '${sqlText(value)}'`);
        if (smartState.decision.includes(smartNull)) values.push(`("Decision" IS NULL OR "Decision" = '')`);
        if (values.length) clauses.push(`(${values.join(" OR ")})`);
      }
    } catch {}
    return clauses.join(" AND ");
  }

  async function corkRows(box, signal) {
    if (!selectedLayer("corkCityDirect")) return [];
    const fields = [
      "PlanningAuthority", "ApplicationNumber", "AppealRefNumber", "DevelopmentAddress",
      "DevelopmentDescription", "NumResidentialUnits", "ReceivedDate", "GrantDate",
      "DecisionDate", "Decision", "LinkAppDetails", "Latitude", "Longitude"
    ];
    const sql = `SELECT ${fields.map(field => `"${field}"`).join(",")} FROM "${CORK_RESOURCE}" WHERE ${corkFilterSql(box)} ORDER BY "ReceivedDate" DESC NULLS LAST LIMIT 15000`;
    try {
      return (await jsonp(CORK_API, sql, signal, 30000)).map((record, index) => ({
        ...record,
        OBJECTID: `CORK-${index}-${record.ApplicationNumber || ""}`,
        PlanningAuthority: "Cork City Council",
        __lat: number(record.Latitude) || null,
        __lng: number(record.Longitude) || null,
        __source: "cork"
      }));
    } catch (error) {
      console.warn("Cork building-control planning query failed", error);
      return [];
    }
  }

  async function planningRows(signal) {
    const where = planningWhere();
    const geometry = activeGeometry();
    const box = geometryBox(geometry);
    const jobs = [];
    if (selectedLayer("planningPoints")) jobs.push(arcgisRows(PLANNING_POINTS, where, geometry, signal, "planningPoints"));
    if (selectedLayer("planningSites")) jobs.push(arcgisRows(PLANNING_SITES, where, geometry, signal, "planningSites"));
    jobs.push(corkRows(box, signal));
    const results = await Promise.allSettled(jobs);
    const rows = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
    return core.dedupePlanning(rows);
  }

  function fiveYearNbcoClauses() {
    const start = startDate().toISOString().slice(0, 10);
    const unitClause = `GREATEST(COALESCE("CN_Units_for_phase",0),COALESCE("CN_Total_Number_of_Dwelling_Units",0),COALESCE("CN_Total_Number_Multiple_Unit_Dwellings",0),COALESCE("CCC_Units_Completed",0)) >= ${MIN_UNITS}`;
    const dateClause = `("CN_Date_Submitted_or_Received" >= '${start}'::timestamp OR "CN_Validation_Date" >= '${start}'::timestamp OR "CN_Commencement_Date" >= '${start}'::timestamp OR "CCC_Date_Validated" >= '${start}'::timestamp)`;
    return { start, unitClause, dateClause };
  }

  function coordinateClause(box) {
    if (!box) return "";
    const latitude = `CASE WHEN "CN_LAT" ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN "CN_LAT"::numeric END`;
    const longitude = `CASE WHEN "CN_LNG" ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN "CN_LNG"::numeric END`;
    return `((${latitude}) BETWEEN ${box.south} AND ${box.north} AND (${longitude}) BETWEEN ${box.west} AND ${box.east})`;
  }

  async function nbcoRowsForPlanning(records, signal) {
    const output = [];
    const seen = new Set();
    const selected = NBCO_FIELDS.map(field => `"${field}"`).join(",");
    const { unitClause, dateClause } = fiveYearNbcoClauses();
    const box = geometryBox();

    async function collect(sql) {
      for (let offset = 0; offset < 60000; offset += PAGE_SIZE) {
        const pageSql = `${sql} LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
        const batch = await jsonp(NBCO_API, pageSql, signal);
        batch.forEach((row, index) => {
          const stable = [row.IDs, row.CN_Number, row.CCC_Number, row.Building_Number, row.Submission_Number].map(value => text(value)).join("|");
          const key = stable.replaceAll("|", "") ? stable : `${row.CN_Number || ""}|${row.CCC_Number || ""}|${index + offset}`;
          if (!seen.has(key)) {
            seen.add(key);
            output.push(row);
          }
        });
        if (batch.length < PAGE_SIZE) break;
      }
    }

    const spatial = coordinateClause(box);
    if (spatial) {
      await collect(`SELECT ${selected} FROM "${NBCO_RESOURCE}" WHERE "CN_Number" IS NOT NULL AND ${unitClause} AND ${dateClause} AND ${spatial} ORDER BY COALESCE("CN_Date_Submitted_or_Received","CN_Validation_Date","CN_Commencement_Date","CCC_Date_Validated") DESC NULLS LAST`);
    }

    for (let index = 0; index < records.length; index += 18) {
      const group = records.slice(index, index + 18);
      const clauses = [];
      group.forEach(record => {
        [...core.referenceTokens(record.ApplicationNumber), core.acpReference(record.AppealRefNumber)]
          .filter(Boolean)
          .forEach(token => clauses.push(`regexp_replace(upper(COALESCE("CN_Planning_Permission_Number",'')),'[^A-Z0-9]','','g') LIKE '%${sqlText(token)}%'`));
      });
      if (!clauses.length) continue;
      const sql = `SELECT ${selected} FROM "${NBCO_RESOURCE}" WHERE "CN_Number" IS NOT NULL AND ${unitClause} AND ${dateClause} AND (${[...new Set(clauses)].join(" OR ")}) ORDER BY COALESCE("CN_Date_Submitted_or_Received","CN_Validation_Date","CN_Commencement_Date","CCC_Date_Validated") DESC NULLS LAST`;
      await collect(sql);
      updateStatus(`Matching planning references · ${format(Math.min(index + group.length, records.length))} of ${format(records.length)} schemes`);
    }
    return output;
  }

  function injectKpis() {
    const grid = element(".metric-grid");
    if (!grid || element("#bcCommencedProjects")) return;
    const cards = [
      ["Schemes commenced", "bcCommencedProjects", "bcCommencedProjectsNote", "3+ dwelling schemes with a matched commencement"],
      ["Units commenced", "bcUnitsCommenced", "bcUnitsCommencedNote", "Deduplicated commencement phase units"],
      ["Schemes with completion", "bcCompletionProjects", "bcCompletionProjectsNote", "Validated full or phased completion evidence"],
      ["Units completed", "bcUnitsCompleted", "bcUnitsCompletedNote", "Deduplicated validated CCC units"]
    ];
    cards.forEach(([label, valueId, noteId, note]) => {
      const card = document.createElement("article");
      card.className = "metric-card building-control-metric";
      card.innerHTML = `<span>${escapeHtml(label)}</span><strong id="${valueId}">—</strong><small id="${noteId}">${escapeHtml(note)}</small>`;
      grid.append(card);
    });
    const status = document.createElement("p");
    status.id = "buildingControlFiveYearStatus";
    status.className = "data-quality-note";
    status.innerHTML = `Building-control KPIs use a fixed five-year activity window for housing schemes above two units. <a href="completions.html" target="_blank" rel="noopener">Open consolidated audit ↗</a>`;
    grid.after(status);
  }

  function setValue(valueId, noteId, value, note) {
    const valueNode = element(`#${valueId}`);
    const noteNode = element(`#${noteId}`);
    if (valueNode) valueNode.textContent = value;
    if (noteNode) noteNode.textContent = note;
  }

  function updateStatus(message) {
    const node = element("#buildingControlFiveYearStatus");
    if (!node) return;
    node.innerHTML = `${escapeHtml(message)}. <button id="exportBuildingControlFiveYear" type="button" class="secondary-button">Export matched CSV</button> <a href="completions.html" target="_blank" rel="noopener">Open consolidated audit ↗</a>`;
    element("#exportBuildingControlFiveYear")?.addEventListener("click", exportCsv, { once: true });
  }

  function summaryFor(projects, reviewCount, unmatchedCount) {
    const commencedProjects = projects.filter(project => project.commencementCount > 0).length;
    const unitsCommenced = projects.reduce((sum, project) => sum + number(project.unitsCommenced), 0);
    const completionProjects = projects.filter(project => project.completionEvidence).length;
    const completedProjects = projects.filter(project => project.completed).length;
    const unitsCompleted = projects.reduce((sum, project) => sum + number(project.unitsCompleted), 0);
    const approvedUnits = projects.reduce((sum, project) => sum + number(project.approvedUnits), 0);
    return {
      planningProjects: projects.length,
      commencedProjects,
      unitsCommenced,
      completionProjects,
      completedProjects,
      unitsCompleted,
      approvedUnits,
      reviewCount,
      unmatchedCount
    };
  }

  function renderSummary(summary, source = "live") {
    currentSummary = summary;
    setValue("bcCommencedProjects", "bcCommencedProjectsNote", format(summary.commencedProjects), `${format(summary.planningProjects)} matched 3+ dwelling planning schemes in the visible area`);
    setValue("bcUnitsCommenced", "bcUnitsCommencedNote", format(summary.unitsCommenced), `${percentage(summary.unitsCommenced, summary.approvedUnits)} of ${format(summary.approvedUnits)} approved units`);
    setValue("bcCompletionProjects", "bcCompletionProjectsNote", format(summary.completionProjects), `${format(summary.completedProjects)} appear fully completed; phased certificates remain included`);
    setValue("bcUnitsCompleted", "bcUnitsCompletedNote", format(summary.unitsCompleted), `${percentage(summary.unitsCompleted, summary.unitsCommenced)} of commenced units · ${percentage(summary.unitsCompleted, summary.approvedUnits)} of approved units`);
    const review = summary.reviewCount ? ` · ${format(summary.reviewCount)} plausible matches withheld for review` : "";
    const unmatched = summary.unmatchedCount ? ` · ${format(summary.unmatchedCount)} NBCO notices unmatched` : "";
    updateStatus(`Five-year NBCO pipeline ${source === "cache" ? "restored from cache" : "updated live"} · first appearance consolidates all linked commencement and completion notices${review}${unmatched}`);
  }

  function showLoading(message = "Loading five years of commencement and completion evidence") {
    ["bcCommencedProjects", "bcUnitsCommenced", "bcCompletionProjects", "bcUnitsCompleted"].forEach(id => {
      const node = element(`#${id}`);
      if (node) node.textContent = "…";
    });
    updateStatus(message);
  }

  function showNotSelected() {
    setValue("bcCommencedProjects", "bcCommencedProjectsNote", "Not selected", "Select a planning layer to calculate commenced schemes");
    setValue("bcUnitsCommenced", "bcUnitsCommencedNote", "—", "Select a planning layer to calculate commenced units");
    setValue("bcCompletionProjects", "bcCompletionProjectsNote", "Not selected", "Select a planning layer to calculate completion evidence");
    setValue("bcUnitsCompleted", "bcUnitsCompletedNote", "—", "Select a planning layer to calculate completed units");
    updateStatus("Building-control KPIs are paused because no planning layer is selected");
  }

  function cacheKey(records) {
    const signature = records.map(record => `${core.canonicalAuthority(record.PlanningAuthority)}:${core.normaliseReference(record.ApplicationNumber)}`).sort().join("|");
    let hash = 2166136261;
    for (let index = 0; index < signature.length; index += 1) {
      hash ^= signature.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${CACHE_PREFIX}${(hash >>> 0).toString(36)}`;
  }

  function restoreCache(key) {
    try {
      const cached = JSON.parse(localStorage.getItem(key) || "null");
      if (!cached || Date.now() - cached.savedAt > CACHE_TTL || !Array.isArray(cached.projects)) return false;
      currentProjects = cached.projects;
      renderSummary(cached.summary, "cache");
      return true;
    } catch {
      return false;
    }
  }

  function saveCache(key, projects, summary) {
    try {
      localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), projects, summary }));
    } catch {}
  }

  async function refreshNow({ background = false } = {}) {
    injectKpis();
    if (!anyPlanningLayerSelected()) {
      controller?.abort();
      showNotSelected();
      return;
    }
    const sequence = ++runSequence;
    controller?.abort();
    controller = new AbortController();
    if (!background) showLoading();
    try {
      const planning = await planningRows(controller.signal);
      if (sequence !== runSequence) return;
      if (!planning.length) {
        currentProjects = [];
        renderSummary(summaryFor([], 0, 0));
        return;
      }
      const key = cacheKey(planning);
      const restored = restoreCache(key);
      if (!restored) showLoading(`Matching ${format(planning.length)} visible 3+ dwelling schemes to NBCO`);
      const nbco = await nbcoRowsForPlanning(planning, controller.signal);
      if (sequence !== runSequence) return;
      const consolidated = core.consolidateNbcoRows(nbco);
      const matches = core.matchCommencements(planning, consolidated);
      const aggregate = core.aggregateProjects(matches);
      currentProjects = aggregate.projects;
      const summary = summaryFor(currentProjects, aggregate.review.length, aggregate.unmatched.length);
      saveCache(key, currentProjects, summary);
      renderSummary(summary, "live");
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error("Five-year building-control KPI refresh failed", error);
      if (currentSummary) renderSummary(currentSummary, "cache");
      else updateStatus(`NBCO KPI connection failed: ${error.message}`);
    }
  }

  function schedule(delay = 1200) {
    clearTimeout(timer);
    timer = setTimeout(() => refreshNow(), delay);
  }

  function csvCell(value) {
    let output = String(value ?? "");
    if (/^[=+\-@]/.test(output)) output = `'${output}`;
    return `"${output.replaceAll('"', '""')}"`;
  }

  function exportCsv() {
    if (!currentProjects.length) return;
    const rows = currentProjects.map(project => ({
      "First appeared": core.isoDate(project.firstAppearance),
      "Planning reference": project.planningRef,
      "ACP reference": project.acpRef,
      "Planning authority": project.authority,
      Address: project.address,
      "Approved units": project.approvedUnits,
      "Commencement notices": project.commencementCount,
      "Commencement numbers": project.commencementNumbers.join("; "),
      "First commencement": core.isoDate(project.firstCommencement),
      "Latest commencement": core.isoDate(project.latestCommencement),
      "Units commenced": project.unitsCommenced,
      "Completion certificates": project.certificateCount,
      "Completion certificate numbers": project.certificateNumbers.join("; "),
      "First completion": core.isoDate(project.firstCompletion),
      "Latest completion": core.isoDate(project.latestCompletion),
      "Units completed": project.unitsCompleted,
      Status: project.status,
      "Minimum match score": project.minMatchScore,
      "Maximum match score": project.maxMatchScore,
      "Match methods": project.matchMethods.join(" | ")
    }));
    const headers = Object.keys(rows[0]);
    const csv = [headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `radharc-five-year-commencements-completions-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function selectedProject(properties) {
    const key = `${core.canonicalAuthority(properties.PlanningAuthority)}|${core.normaliseReference(properties.ApplicationNumber)}`;
    const cached = currentProjects.find(project => `${core.canonicalAuthority(project.authority)}|${core.normaliseReference(project.planningRef)}` === key);
    if (cached) return cached;
    const planning = [{
      ...properties,
      __lat: properties.Latitude ?? null,
      __lng: properties.Longitude ?? null,
      __planningKey: key
    }];
    const localController = new AbortController();
    const nbco = await nbcoRowsForPlanning(planning, localController.signal);
    const matches = core.matchCommencements(planning, core.consolidateNbcoRows(nbco));
    return core.aggregateProjects(matches).projects[0] || null;
  }

  function appendSelectedRecord(properties) {
    const container = element("#selectedRecord");
    if (!container || !properties?.ApplicationNumber) return;
    container.querySelector(".building-control-five-year-record")?.remove();
    const block = document.createElement("div");
    block.className = "building-control-five-year-record";
    block.innerHTML = `<hr><strong>Commencement and completion</strong><p class="muted small">Matching the five-year NBCO pipeline…</p>`;
    container.append(block);
    const sequence = ++selectedSequence;
    selectedProject(properties).then(project => {
      if (sequence !== selectedSequence || !block.isConnected) return;
      if (!project) {
        block.innerHTML = `<hr><strong>Commencement and completion</strong><p class="muted small">No automatic five-year NBCO match found for this planning record.</p><a href="completions.html" target="_blank" rel="noopener">Open review audit ↗</a>`;
        return;
      }
      block.innerHTML = `<hr><strong>Commencement and completion</strong><dl>
        <div><dt>First appeared</dt><dd>${escapeHtml(displayDate(project.firstAppearance))}</dd></div>
        <div><dt>Status</dt><dd>${escapeHtml(project.status)}</dd></div>
        <div><dt>Commencement notices</dt><dd>${format(project.commencementCount)}</dd></div>
        <div><dt>Units commenced</dt><dd>${format(project.unitsCommenced)}</dd></div>
        <div><dt>Completion certificates</dt><dd>${format(project.certificateCount)}</dd></div>
        <div><dt>Units completed</dt><dd>${format(project.unitsCompleted)}</dd></div>
        <div><dt>Match range</dt><dd>${format(project.minMatchScore)}–${format(project.maxMatchScore)}/100</dd></div>
      </dl><a href="completions.html" target="_blank" rel="noopener">Open consolidated audit ↗</a>`;
    }).catch(error => {
      if (sequence !== selectedSequence || !block.isConnected) return;
      block.innerHTML = `<hr><strong>Commencement and completion</strong><p class="muted small">NBCO lookup unavailable: ${escapeHtml(error.message)}</p>`;
    });
  }

  function patchSelectedRecord() {
    if (typeof select !== "function" || select.__fiveYearBuildingControlPatched) return;
    const previous = select;
    const wrapped = function fiveYearBuildingControlSelected(key, feature, latlng) {
      const result = previous.apply(this, arguments);
      try {
        if (S[key]?.type === "planning") {
          const properties = feature?.properties || feature?.attributes || {};
          queueMicrotask(() => appendSelectedRecord(properties));
        }
      } catch (error) {
        console.warn("Selected five-year building-control lookup failed", error);
      }
      return result;
    };
    wrapped.__fiveYearBuildingControlPatched = true;
    select = wrapped;
  }

  function patchRefresh() {
    if (typeof update === "function" && !update.__fiveYearBuildingControlPatched) {
      const previous = update;
      const wrapped = function fiveYearBuildingControlUpdate() {
        return Promise.resolve(previous.apply(this, arguments)).finally(() => schedule());
      };
      wrapped.__fiveYearBuildingControlPatched = true;
      update = wrapped;
    }
    if (window.RadharcDashboard?.syncNow && !window.RadharcDashboard.syncNow.__fiveYearBuildingControlPatched) {
      const previous = window.RadharcDashboard.syncNow;
      const wrapped = function fiveYearBuildingControlSync() {
        return Promise.resolve(previous.apply(this, arguments)).finally(() => schedule());
      };
      wrapped.__fiveYearBuildingControlPatched = true;
      window.RadharcDashboard.syncNow = wrapped;
    }
  }

  function bindChanges() {
    ["#decisionFilter", "#authorityFilter", "#clearSmartFilters", "#layerToggles"].forEach(selector => {
      element(selector)?.addEventListener("change", () => schedule());
      element(selector)?.addEventListener("click", () => schedule());
    });
  }

  function install() {
    injectKpis();
    patchSelectedRecord();
    patchRefresh();
    bindChanges();
    window.RadharcBuildingControlKpis = {
      refresh: () => refreshNow(),
      currentRows: () => currentProjects.map(project => ({ ...project })),
      exportCsv
    };
    schedule(350);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
