"use strict";

(function installFiveYearCompletions() {
  const core = window.RadharcBuildingControlCore;
  if (!core) throw new Error("Building-control matching core did not load");

  const PLANNING_POINTS = "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0";
  const CORK_API = "https://data.corkcity.ie/api/3/action/datastore_search_sql";
  const CORK_RESOURCE = "8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";
  const NBCO_API = "https://data.nbco.gov.ie/api/3/action/datastore_search_sql";
  const NBCO_RESOURCE = "0774e781-7af8-46da-b623-872e74cf541e";
  const PAGE_SIZE = 5000;
  const MAX_NBCO_ROWS = 100000;
  const MAX_PLANNING_ROWS = 80000;
  const CACHE_KEY = "radharc-completions-five-year-v1";
  const CACHE_TTL = 12 * 60 * 60 * 1000;

  const PLANNING_FIELDS = [
    "OBJECTID", "PlanningAuthority", "ApplicationNumber", "AppealRefNumber",
    "DevelopmentAddress", "DevelopmentDescription", "NumResidentialUnits",
    "ReceivedDate", "GrantDate", "DecisionDate", "Decision", "LinkAppDetails"
  ];
  const NBCO_FIELDS = [
    "IDs", "CN_Project_Name", "CN_Description_proposed_development", "CN_Project_type",
    "CN_Activity_Type", "CN_Planning_Permission_Number", "CN_Date_Granted",
    "CN_Date_Submitted_or_Received", "CN_LAT", "CN_LNG", "CN_Number",
    "CN_Commencement_Date", "CN_Units_for_phase", "CN_Phase_for_this_Notice",
    "CN_Street", "CN_Town", "CN_Eircode", "CN_County",
    "CN_Total_Number_of_Dwelling_Units", "CN_Total_Number_Multiple_Unit_Dwellings",
    "CN_Validation_Date", "CN_Total_Number_of_Phases", "CN_Not_Commenced",
    "CCC_Description", "CCC_Number", "CCC_Date_Validated",
    "CCC_Type_of_Completion_Certificate", "CCC_Units_Completed",
    "LocalAuthority", "Building_Number", "Submission_Number"
  ];

  let controller = null;
  let state = {
    projects: [],
    commencements: [],
    certificates: [],
    review: [],
    unmatched: [],
    generatedAt: null,
    startDate: null,
    minUnits: 3,
    years: 5,
    warnings: []
  };

  const element = selector => document.querySelector(selector);
  const text = core.text;
  const number = core.number;
  const format = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));

  function displayDate(value) {
    const time = core.parseTime(value);
    return time == null ? "—" : new Date(time).toLocaleDateString("en-IE", {
      day: "2-digit", month: "short", year: "numeric"
    });
  }

  function startDateForYears(years) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setFullYear(date.getFullYear() - years);
    return date;
  }

  function setStatus(message, mode = "idle", detail = "", progress = null) {
    const node = element("#matchStatus");
    if (!node) return;
    node.dataset.mode = mode;
    node.firstElementChild.textContent = message;
    element("#matchDetail").textContent = detail;
    if (progress != null) element("#progressBar").style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }

  function sqlText(value) {
    return String(value ?? "").replaceAll("'", "''");
  }

  function jsonp(api, sql, signal, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      const callback = `__radharcFiveYear_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        cleanup();
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error("Public datastore query timed out")), timeoutMs);
      const abort = () => finish(reject, new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      window[callback] = payload => payload?.success
        ? finish(resolve, payload.result?.records || [])
        : finish(reject, new Error(payload?.error?.message || "Public datastore query failed"));
      script.onerror = () => finish(reject, new Error("Public datastore could not be reached"));
      script.src = url.toString();
      document.head.append(script);
    });
  }

  function encodeBody(parameters) {
    const body = new URLSearchParams();
    Object.entries({ f: "geojson", ...parameters }).forEach(([key, value]) => {
      if (value == null) return;
      body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    });
    return body;
  }

  async function arcgisPlanningRows(minUnits, signal) {
    const output = [];
    const where = `NumResidentialUnits >= ${minUnits} AND ReceivedDate >= DATE '2014-01-01'`;
    for (let offset = 0; offset < MAX_PLANNING_ROWS; offset += 2000) {
      const response = await fetch(`${PLANNING_POINTS}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: encodeBody({
          where,
          outFields: PLANNING_FIELDS.join(","),
          returnGeometry: true,
          outSR: 4326,
          resultOffset: offset,
          resultRecordCount: 2000,
          orderByFields: "OBJECTID ASC"
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
        __source: "planningPoints"
      })));
      setStatus("Loading 3+ unit planning schemes…", "loading", `${format(output.length)} national planning records`, 7 + Math.min(18, output.length / 1800));
      if (!batch.length || batch.length < 2000) break;
    }
    if (output.length >= MAX_PLANNING_ROWS) state.warnings.push(`Planning records reached the ${format(MAX_PLANNING_ROWS)}-row safety limit.`);
    return output;
  }

  async function corkPlanningRows(minUnits, signal) {
    const fields = [
      "PlanningAuthority", "ApplicationNumber", "AppealRefNumber", "DevelopmentAddress",
      "DevelopmentDescription", "NumResidentialUnits", "ReceivedDate", "GrantDate",
      "DecisionDate", "Decision", "LinkAppDetails", "Latitude", "Longitude"
    ];
    const sql = `SELECT ${fields.map(field => `"${field}"`).join(",")} FROM "${CORK_RESOURCE}" WHERE COALESCE("NumResidentialUnits",0) >= ${minUnits} AND "ReceivedDate" >= '2014-01-01'::timestamp ORDER BY "ReceivedDate" DESC NULLS LAST LIMIT 15000`;
    try {
      const rows = await jsonp(CORK_API, sql, signal, 30000);
      return rows.map((record, index) => ({
        ...record,
        OBJECTID: `CORK-${index}-${record.ApplicationNumber || ""}`,
        PlanningAuthority: "Cork City Council",
        __lat: number(record.Latitude) || null,
        __lng: number(record.Longitude) || null,
        __source: "cork"
      }));
    } catch (error) {
      state.warnings.push(`Cork City direct planning feed unavailable: ${error.message}`);
      return [];
    }
  }

  async function nbcoRows(startDate, minUnits, signal) {
    const output = [];
    const start = startDate.toISOString().slice(0, 10);
    const unitClause = `GREATEST(COALESCE("CN_Units_for_phase",0),COALESCE("CN_Total_Number_of_Dwelling_Units",0),COALESCE("CN_Total_Number_Multiple_Unit_Dwellings",0),COALESCE("CCC_Units_Completed",0)) >= ${minUnits}`;
    const dateClause = `("CN_Date_Submitted_or_Received" >= '${start}'::timestamp OR "CN_Validation_Date" >= '${start}'::timestamp OR "CN_Commencement_Date" >= '${start}'::timestamp OR "CCC_Date_Validated" >= '${start}'::timestamp)`;
    const selected = NBCO_FIELDS.map(field => `"${field}"`).join(",");
    for (let offset = 0; offset < MAX_NBCO_ROWS; offset += PAGE_SIZE) {
      const sql = `SELECT ${selected} FROM "${NBCO_RESOURCE}" WHERE "CN_Number" IS NOT NULL AND ${unitClause} AND ${dateClause} ORDER BY COALESCE("CN_Date_Submitted_or_Received","CN_Validation_Date","CN_Commencement_Date","CCC_Date_Validated") DESC NULLS LAST LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
      const batch = await jsonp(NBCO_API, sql, signal);
      output.push(...batch);
      setStatus("Loading five years of commencement and completion notices…", "loading", `${format(output.length)} NBCO relationship rows`, 28 + Math.min(28, output.length / 1400));
      if (batch.length < PAGE_SIZE) break;
    }
    if (output.length >= MAX_NBCO_ROWS) state.warnings.push(`NBCO rows reached the ${format(MAX_NBCO_ROWS)}-row safety limit.`);
    return output;
  }

  function flattenReview(match) {
    return {
      cnNumber: text(match.commencement.CN_Number),
      firstAppearance: match.commencement.__firstAppearance,
      planningPermissionText: text(match.commencement.CN_Planning_Permission_Number),
      authority: text(match.commencement.LocalAuthority || match.commencement.CN_County),
      address: text(`${match.commencement.CN_Project_Name || ""} ${match.commencement.CN_Street || ""} ${match.commencement.CN_Town || ""}`),
      candidatePlanningRef: text(match.planning.ApplicationNumber),
      candidateAcpRef: core.acpReference(match.planning.AppealRefNumber),
      candidateAuthority: text(match.planning.PlanningAuthority),
      candidateAddress: text(match.planning.DevelopmentAddress),
      score: match.score,
      margin: match.margin,
      method: match.reasons,
      distance: match.distance,
      addressScore: match.addressScore
    };
  }

  function flattenUnmatched(item) {
    const commencement = item.commencement;
    return {
      cnNumber: text(commencement.CN_Number),
      firstAppearance: commencement.__firstAppearance,
      planningPermissionText: text(commencement.CN_Planning_Permission_Number),
      authority: text(commencement.LocalAuthority || commencement.CN_County),
      address: text(`${commencement.CN_Project_Name || ""} ${commencement.CN_Street || ""} ${commencement.CN_Town || ""}`),
      totalUnits: Math.max(
        number(commencement.CN_Units_for_phase),
        number(commencement.CN_Total_Number_of_Dwelling_Units),
        number(commencement.CN_Total_Number_Multiple_Unit_Dwellings)
      ),
      reason: item.reason,
      bestCandidate: item.candidates?.[0] ? text(item.candidates[0].planning.ApplicationNumber) : "",
      bestScore: item.candidates?.[0]?.score || 0,
      bestMethod: item.candidates?.[0]?.reasons || ""
    };
  }

  function serialiseState(aggregate, startDate, minUnits, years) {
    return {
      projects: aggregate.projects,
      commencements: aggregate.commencements,
      certificates: aggregate.certificates,
      review: aggregate.review.map(flattenReview),
      unmatched: aggregate.unmatched.map(flattenUnmatched),
      generatedAt: new Date().toISOString(),
      startDate: startDate.toISOString(),
      minUnits,
      years,
      warnings: [...state.warnings]
    };
  }

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), state }));
    } catch {}
  }

  function restoreCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (!cached || Date.now() - cached.savedAt > CACHE_TTL || !cached.state?.projects) return false;
      state = cached.state;
      populateAuthorities();
      render();
      enableExports(true);
      setStatus("Cached five-year match ready; refresh live when required.", "idle", `Generated ${new Date(state.generatedAt).toLocaleString("en-IE")}`, 100);
      return true;
    } catch {
      return false;
    }
  }

  function projectTotals() {
    const projects = state.projects;
    return {
      matchedProjects: projects.length,
      commencedProjects: projects.filter(project => project.commencementCount > 0).length,
      unitsCommenced: projects.reduce((sum, project) => sum + number(project.unitsCommenced), 0),
      completionProjects: projects.filter(project => project.completionEvidence).length,
      completedProjects: projects.filter(project => project.completed).length,
      unitsCompleted: projects.reduce((sum, project) => sum + number(project.unitsCompleted), 0),
      review: state.review.length,
      unmatched: state.unmatched.length
    };
  }

  function renderMetrics() {
    const totals = projectTotals();
    const cards = [
      ["Matched schemes", totals.matchedProjects, "Planning-linked project records"],
      ["Commenced schemes", totals.commencedProjects, "At least one commencement notice"],
      ["Units commenced", totals.unitsCommenced, "Deduplicated phase units"],
      ["Completion evidence", totals.completionProjects, `${format(totals.completedProjects)} appear fully completed`],
      ["Units completed", totals.unitsCompleted, "Validated CCC units"],
      ["Review queue", totals.review, "Plausible but not automatic"],
      ["Unmatched notices", totals.unmatched, "No defensible planning match"]
    ];
    element("#matchMetrics").innerHTML = cards.map(([label, value, note]) => `
      <article class="metric"><span>${escapeHtml(label)}</span><strong>${format(value)}</strong><small>${escapeHtml(note)}</small></article>`).join("");
  }

  function projectRows() {
    const authority = element("#authorityFilter")?.value || "all";
    const query = text(element("#matchSearch")?.value).toUpperCase();
    return state.projects.filter(project => {
      if (authority !== "all" && project.authority !== authority) return false;
      if (!query) return true;
      return [
        project.planningRef, project.acpRef, project.authority, project.address,
        project.commencementNumbers.join(" "), project.certificateNumbers.join(" "), project.status
      ].join(" ").toUpperCase().includes(query);
    });
  }

  function reviewRows() {
    const authority = element("#authorityFilter")?.value || "all";
    const query = text(element("#matchSearch")?.value).toUpperCase();
    return state.review.filter(row => {
      if (authority !== "all" && row.candidateAuthority !== authority && row.authority !== authority) return false;
      if (!query) return true;
      return Object.values(row).join(" ").toUpperCase().includes(query);
    });
  }

  function unmatchedRows() {
    const authority = element("#authorityFilter")?.value || "all";
    const query = text(element("#matchSearch")?.value).toUpperCase();
    return state.unmatched.filter(row => {
      if (authority !== "all" && row.authority !== authority) return false;
      if (!query) return true;
      return Object.values(row).join(" ").toUpperCase().includes(query);
    });
  }

  function planningLink(project) {
    if (/^https?:\/\//i.test(project.planningUrl || "")) return project.planningUrl;
    const url = new URL("record-view.html", location.href);
    url.searchParams.set("source", "planningPoints");
    url.searchParams.set("ref", project.planningRef);
    url.searchParams.set("authority", project.authority);
    return url.toString();
  }

  function renderProjects(rows) {
    if (!rows.length) return '<div class="empty">No matched schemes meet the current filters.</div>';
    return `<table class="table"><thead><tr>
      <th>First appeared ↓</th><th>Planning project</th><th>Approved</th><th>Commencements</th><th>Units commenced</th><th>First / latest commencement</th><th>Completion certificates</th><th>Units completed</th><th>First / latest completion</th><th>Status</th><th>Match</th>
    </tr></thead><tbody>${rows.map(project => `
      <tr>
        <td><strong>${displayDate(project.firstAppearance)}</strong></td>
        <td><a class="link" href="${escapeHtml(planningLink(project))}" target="_blank" rel="noopener">${escapeHtml(project.planningRef || "Planning record")} ↗</a><small>${escapeHtml(project.authority)}<br>${escapeHtml(project.address)}</small>${project.acpRef ? `<small>ACP ${escapeHtml(project.acpRef)}</small>` : ""}</td>
        <td class="units">${format(project.approvedUnits)}</td>
        <td><strong>${format(project.commencementCount)}</strong><small>${escapeHtml(project.commencementNumbers.join("; ") || "—")}</small></td>
        <td class="units">${format(project.unitsCommenced)}</td>
        <td>${displayDate(project.firstCommencement)}<small>${displayDate(project.latestCommencement)}</small></td>
        <td><strong>${format(project.certificateCount)}</strong><small>${escapeHtml(project.certificateNumbers.join("; ") || "—")}</small></td>
        <td class="units">${format(project.unitsCompleted)}</td>
        <td>${displayDate(project.firstCompletion)}<small>${displayDate(project.latestCompletion)}</small></td>
        <td><span class="tag auto">${escapeHtml(project.status)}</span></td>
        <td><strong>${format(project.minMatchScore)}–${format(project.maxMatchScore)}</strong><small>${escapeHtml(project.matchMethods.slice(0, 2).join(" | "))}</small></td>
      </tr>`).join("")}</tbody></table>`;
  }

  function renderReview(rows) {
    if (!rows.length) return '<div class="empty">No review cases meet the current filters.</div>';
    return `<table class="table"><thead><tr><th>First appeared ↓</th><th>Commencement notice</th><th>NBCO planning text</th><th>Authority / address</th><th>Best planning candidate</th><th>Score</th><th>Reason</th></tr></thead><tbody>${rows.map(row => `
      <tr><td>${displayDate(row.firstAppearance)}</td><td><strong>${escapeHtml(row.cnNumber)}</strong></td><td>${escapeHtml(row.planningPermissionText || "—")}</td><td>${escapeHtml(row.authority)}<small>${escapeHtml(row.address)}</small></td><td><strong>${escapeHtml(row.candidatePlanningRef || "—")}</strong><small>${escapeHtml(row.candidateAuthority)} · ${escapeHtml(row.candidateAddress)}</small></td><td><span class="tag review">${format(row.score)}/100</span><small>margin ${format(row.margin)}</small></td><td>${escapeHtml(row.method)}</td></tr>`).join("")}</tbody></table>`;
  }

  function renderUnmatched(rows) {
    if (!rows.length) return '<div class="empty">No unmatched notices meet the current filters.</div>';
    return `<table class="table"><thead><tr><th>First appeared ↓</th><th>Commencement notice</th><th>NBCO planning text</th><th>Authority / address</th><th>Units</th><th>Best rejected candidate</th><th>Reason</th></tr></thead><tbody>${rows.map(row => `
      <tr><td>${displayDate(row.firstAppearance)}</td><td><strong>${escapeHtml(row.cnNumber)}</strong></td><td>${escapeHtml(row.planningPermissionText || "—")}</td><td>${escapeHtml(row.authority)}<small>${escapeHtml(row.address)}</small></td><td class="units">${format(row.totalUnits)}</td><td>${escapeHtml(row.bestCandidate || "—")}<small>${row.bestScore ? `${format(row.bestScore)}/100 · ${escapeHtml(row.bestMethod)}` : ""}</small></td><td><span class="tag unmatched">${escapeHtml(row.reason)}</span></td></tr>`).join("")}</tbody></table>`;
  }

  function render() {
    renderMetrics();
    const view = element("#confidenceFilter")?.value || "matched";
    let rows;
    let title;
    let description;
    let markup;
    if (view === "review") {
      rows = reviewRows();
      title = "Review queue";
      description = "Commencement notices with a plausible candidate that did not meet the automatic matching safeguards.";
      markup = renderReview(rows);
    } else if (view === "unmatched") {
      rows = unmatchedRows();
      title = "Unmatched building-control notices";
      description = "Qualifying commencement notices for which no planning candidate reached the review threshold.";
      markup = renderUnmatched(rows);
    } else {
      rows = projectRows();
      title = "Consolidated planning, commencement and completion pipeline";
      description = "One row per planning permission, ordered by the first building-control appearance and carrying every linked commencement and completion certificate.";
      markup = renderProjects(rows);
    }
    element("#matchSectionTitle").textContent = title;
    element("#matchSectionDescription").textContent = description;
    element("#visibleCount").textContent = `${format(rows.length)} row${rows.length === 1 ? "" : "s"}`;
    element("#matchTable").innerHTML = markup;
  }

  function populateAuthorities() {
    const select = element("#authorityFilter");
    const current = select.value;
    const authorities = [...new Set([
      ...state.projects.map(row => row.authority),
      ...state.review.map(row => row.candidateAuthority || row.authority),
      ...state.unmatched.map(row => row.authority)
    ].filter(Boolean))].sort();
    select.innerHTML = '<option value="all">All authorities</option>'
      + authorities.map(authority => `<option value="${escapeHtml(authority)}">${escapeHtml(authority)}</option>`).join("");
    select.value = authorities.includes(current) ? current : "all";
  }

  function enableExports(enabled) {
    element("#exportExcel").disabled = !enabled;
    element("#exportCsv").disabled = !enabled;
  }

  async function runMatch() {
    controller?.abort();
    controller = new AbortController();
    state.warnings = [];
    const minUnits = Math.max(3, Number(element("#minUnits").value) || 3);
    const years = Math.max(1, Math.min(10, Number(element("#yearsWindow").value) || 5));
    const startDate = startDateForYears(years);
    const button = element("#runMatch");
    button.disabled = true;
    button.textContent = "Running…";
    enableExports(false);
    setStatus("Starting the five-year building-control match…", "loading", `${displayDate(startDate)} to today`, 2);

    try {
      const [planningResults, nbcoResult] = await Promise.all([
        Promise.all([arcgisPlanningRows(minUnits, controller.signal), corkPlanningRows(minUnits, controller.signal)]),
        nbcoRows(startDate, minUnits, controller.signal)
      ]);
      const planning = core.dedupePlanning([...planningResults[0], ...planningResults[1]]);
      setStatus("Consolidating duplicate commencement and completion rows…", "loading", `${format(nbcoResult.length)} source rows`, 60);
      const commencements = core.consolidateNbcoRows(nbcoResult);
      setStatus("Matching planning reference, council, address and map point…", "loading", `${format(commencements.length)} unique commencement notices`, 70);
      const matches = core.matchCommencements(planning, commencements);
      setStatus("Consolidating the planning-to-completion pipeline…", "loading", `${format(matches.automatic.length)} automatic matches`, 88);
      const aggregate = core.aggregateProjects(matches);
      state = serialiseState(aggregate, startDate, minUnits, years);
      populateAuthorities();
      render();
      saveCache();
      enableExports(true);
      const warning = state.warnings.length ? ` · ${state.warnings.join(" · ")}` : "";
      setStatus(`Match complete · ${format(state.projects.length)} consolidated schemes · ${format(state.review.length)} review cases · ${format(state.unmatched.length)} unmatched notices`, state.warnings.length ? "error" : "idle", `${displayDate(startDate)} to today${warning}`, 100);
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error(error);
        setStatus(`Match failed: ${error.message}`, "error", "Cached results remain available when present.", 100);
      }
    } finally {
      button.disabled = false;
      button.textContent = "Run live match";
    }
  }

  function csvCell(value) {
    let output = String(value ?? "");
    if (/^[=+\-@]/.test(output)) output = `'${output}`;
    return `"${output.replaceAll('"', '""')}"`;
  }

  function summaryExportRows() {
    return state.projects.map(project => ({
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
      "Match methods": project.matchMethods.join(" | "),
      "Planning URL": planningLink(project)
    }));
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function exportCsv() {
    const rows = summaryExportRows();
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const csv = [headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n");
    downloadBlob(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `radharc-commencements-completions-five-year-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function loadSheetJs() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Excel library failed to load"));
      document.head.append(script);
    });
  }

  function sheetRows(rows) {
    return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])));
  }

  async function exportExcel() {
    const button = element("#exportExcel");
    const previous = button.textContent;
    button.disabled = true;
    button.textContent = "Building workbook…";
    try {
      await loadSheetJs();
      const workbook = XLSX.utils.book_new();
      const totals = projectTotals();
      const overview = XLSX.utils.aoa_to_sheet([
        ["Radharc Pleanála", "Five-year commencement and completion pipeline"],
        ["Generated", new Date(state.generatedAt).toLocaleString("en-IE")],
        ["Building-control window", `${displayDate(state.startDate)} to today`],
        ["Minimum scheme size", `${state.minUnits} dwellings`],
        ["Matched schemes", totals.matchedProjects],
        ["Commenced schemes", totals.commencedProjects],
        ["Units commenced", totals.unitsCommenced],
        ["Schemes with completion evidence", totals.completionProjects],
        ["Units completed", totals.unitsCompleted],
        ["Review queue", totals.review],
        ["Unmatched notices", totals.unmatched],
        ["Warnings", state.warnings.join(" | ")]
      ]);
      overview["!cols"] = [{ wch: 38 }, { wch: 82 }];
      XLSX.utils.book_append_sheet(workbook, overview, "Overview");

      const projectRows = summaryExportRows();
      const projectSheet = XLSX.utils.json_to_sheet(projectRows);
      if (projectRows.length) projectSheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: projectRows.length, c: Object.keys(projectRows[0]).length - 1 } }) };
      XLSX.utils.book_append_sheet(workbook, projectSheet, "Consolidated Projects");

      const commencementSheet = XLSX.utils.json_to_sheet(sheetRows(state.commencements.map(row => ({
        "Planning reference": row.planningRef,
        "ACP reference": row.acpRef,
        "Planning authority": row.authority,
        Address: row.address,
        "Commencement number": row.cnNumber,
        "First appeared": core.isoDate(row.firstAppeared),
        Submitted: core.isoDate(row.submitted),
        Validated: core.isoDate(row.validated),
        "Commencement date": core.isoDate(row.commencementDate),
        Phase: row.phase,
        "Phase units": row.phaseUnits,
        "Total scheme units": row.totalUnits,
        "Match score": row.matchScore,
        "Match method": row.matchMethod
      }))));
      XLSX.utils.book_append_sheet(workbook, commencementSheet, "Commencements");

      const certificateSheet = XLSX.utils.json_to_sheet(sheetRows(state.certificates.map(row => ({
        "Planning reference": row.planningRef,
        "ACP reference": row.acpRef,
        "Planning authority": row.authority,
        Address: row.address,
        "Commencement number": row.cnNumber,
        "Completion certificate": row.cccNumber,
        "Validated date": core.isoDate(row.validated),
        Type: row.type,
        "Units completed": row.unitsCompleted,
        Description: row.description
      }))));
      XLSX.utils.book_append_sheet(workbook, certificateSheet, "Completion Certificates");

      const reviewSheet = XLSX.utils.json_to_sheet(state.review.map(row => ({
        "Commencement number": row.cnNumber,
        "First appeared": core.isoDate(row.firstAppearance),
        "NBCO planning text": row.planningPermissionText,
        "NBCO authority": row.authority,
        "NBCO address": row.address,
        "Candidate planning reference": row.candidatePlanningRef,
        "Candidate ACP reference": row.candidateAcpRef,
        "Candidate authority": row.candidateAuthority,
        "Candidate address": row.candidateAddress,
        Score: row.score,
        Margin: row.margin,
        "Address similarity": row.addressScore,
        "Distance metres": row.distance,
        Method: row.method
      })));
      XLSX.utils.book_append_sheet(workbook, reviewSheet, "Review Queue");

      const unmatchedSheet = XLSX.utils.json_to_sheet(state.unmatched.map(row => ({
        "Commencement number": row.cnNumber,
        "First appeared": core.isoDate(row.firstAppearance),
        "NBCO planning text": row.planningPermissionText,
        Authority: row.authority,
        Address: row.address,
        Units: row.totalUnits,
        Reason: row.reason,
        "Best rejected candidate": row.bestCandidate,
        "Best score": row.bestScore,
        "Best method": row.bestMethod
      })));
      XLSX.utils.book_append_sheet(workbook, unmatchedSheet, "Unmatched NBCO");

      XLSX.writeFile(workbook, `radharc-commencements-completions-five-year-${new Date().toISOString().slice(0, 10)}.xlsx`, { compression: true });
    } catch (error) {
      setStatus(`Excel export failed: ${error.message}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  }

  function bind() {
    element("#runMatch").addEventListener("click", runMatch);
    element("#exportCsv").addEventListener("click", exportCsv);
    element("#exportExcel").addEventListener("click", exportExcel);
    ["#confidenceFilter", "#authorityFilter"].forEach(selector => element(selector).addEventListener("change", render));
    element("#matchSearch").addEventListener("input", render);
    element("#clearMatchFilters").addEventListener("click", () => {
      element("#confidenceFilter").value = "matched";
      element("#authorityFilter").value = "all";
      element("#matchSearch").value = "";
      render();
    });
    if (!restoreCache()) {
      enableExports(false);
      setStatus("Ready to match five years of 3+ unit housing schemes.", "idle", "Press Run live match.", 0);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
