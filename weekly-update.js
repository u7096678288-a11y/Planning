"use strict";

(function weeklyPlanningUpdate() {
  const PLANNING_POINTS = "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0";
  const PLANNING_SITES = "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/1";
  const ACP_CASES = "https://services-eu1.arcgis.com/o56BSnENmD5mYs3j/ArcGIS/rest/services/Cases_2016_Onwards/FeatureServer/3";
  const CORK_API = "https://data.corkcity.ie/api/3/action/datastore_search_sql";
  const CORK_RESOURCE = "8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";
  const PAGE_SIZE = 2000;
  const MAX_ROWS = 50000;
  const EMAIL = "u7096678288@gmail.com";
  const state = { rows: [], filtered: [], generatedAt: null, startDate: null, endDate: null, warnings: [] };
  let activeController = null;

  const $ = selector => document.querySelector(selector);
  const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const html = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const numeric = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : 0;
  const format = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 }).format(Number(value) || 0);

  function parseTime(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    const date = new Date(Number.isFinite(number) && String(value).trim() !== "" ? number : value);
    const time = date.getTime();
    return Number.isFinite(time) ? time : null;
  }

  function isoDate(value) {
    const time = parseTime(value);
    return time == null ? "" : new Date(time).toISOString().slice(0, 10);
  }

  function displayDate(value) {
    const time = parseTime(value);
    return time == null ? "—" : new Date(time).toLocaleDateString("en-IE", { day: "2-digit", month: "short", year: "numeric" });
  }

  function canonicalAuthority(value) {
    const authority = text(value);
    const upper = authority.toUpperCase();
    if (upper.includes("CORK CITY")) return "Cork City Council";
    if (upper.includes("CORK COUNTY")) return "Cork County Council";
    return authority || "Not stated";
  }

  function normaliseCaseReference(value) {
    const raw = text(value);
    const matches = raw.match(/\d{6}/g);
    if (matches?.length) return matches.at(-1);
    const digits = raw.replace(/\D/g, "");
    return digits.length >= 6 ? digits.slice(-6) : digits;
  }

  function status(message, mode = "idle") {
    const node = $("#reportStatus");
    if (!node) return;
    node.dataset.mode = mode;
    node.firstElementChild.textContent = message;
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

  async function fetchArcgisRows(url, where, signal, label) {
    const rows = [];
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
      const page = await arcgisPost(url, {
        where,
        outFields: "*",
        returnGeometry: false,
        resultOffset: offset,
        resultRecordCount: PAGE_SIZE,
        orderByFields: "OBJECTID ASC"
      }, signal);
      const batch = (page.features || []).map(feature => feature.attributes || {});
      rows.push(...batch);
      status(`Loading ${label}… ${format(rows.length)} records`, "loading");
      if (!batch.length || (batch.length < PAGE_SIZE && !page.exceededTransferLimit)) break;
    }
    if (rows.length >= MAX_ROWS) state.warnings.push(`${label} reached the ${format(MAX_ROWS)}-record safety limit.`);
    return rows;
  }

  function corkJsonp(sql, signal) {
    return new Promise((resolve, reject) => {
      const callback = `__weeklyCork_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");
      const url = new URL(CORK_API);
      url.searchParams.set("sql", sql);
      url.searchParams.set("callback", callback);
      const cleanup = () => {
        script.remove();
        try { delete window[callback]; } catch { window[callback] = undefined; }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Cork City datastore timed out"));
      }, 25000);
      const abort = () => {
        clearTimeout(timer);
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      window[callback] = payload => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        cleanup();
        if (!payload?.success) reject(new Error(payload?.error?.message || "Cork City query failed"));
        else resolve(payload.result?.records || []);
      };
      script.onerror = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        cleanup();
        reject(new Error("Cork City datastore could not be reached"));
      };
      script.src = url.toString();
      document.head.append(script);
    });
  }

  function planningEventWhere(start) {
    return ["ReceivedDate", "DecisionDate", "GrantDate", "AppealSubmittedDate", "AppealDecisionDate"]
      .map(field => `${field} >= DATE '${start}'`).join(" OR ");
  }

  function acpEventWhere(start) {
    return `(LODGEDON >= DATE '${start}' OR DECIDED_ON >= DATE '${start}')`;
  }

  async function fetchCorkRows(start, signal) {
    const fields = ["ReceivedDate", "DecisionDate", "GrantDate", "AppealSubmittedDate", "AppealDecisionDate"];
    const clauses = fields.map(field => `CAST("${field}" AS timestamp) >= '${start}'::timestamp`);
    const sql = `SELECT * FROM "${CORK_RESOURCE}" WHERE ${clauses.join(" OR ")} ORDER BY COALESCE(CAST("DecisionDate" AS timestamp), CAST("ReceivedDate" AS timestamp)) DESC NULLS LAST LIMIT 10000`;
    return corkJsonp(sql, signal);
  }

  async function fetchPlanningByAppeals(references, signal) {
    const refs = [...new Set(references.filter(value => value && value.length === 6))];
    const output = [];
    for (let index = 0; index < refs.length; index += 18) {
      const group = refs.slice(index, index + 18);
      const where = group.map(reference => `AppealRefNumber LIKE '%${reference}%'`).join(" OR ");
      const [points, sites] = await Promise.allSettled([
        fetchArcgisRows(PLANNING_POINTS, where, signal, "appeal-linked planning points"),
        fetchArcgisRows(PLANNING_SITES, where, signal, "appeal-linked planning sites")
      ]);
      if (points.status === "fulfilled") output.push(...points.value.map(record => ({ record, source: "points" })));
      if (sites.status === "fulfilled") output.push(...sites.value.map(record => ({ record, source: "sites" })));
    }
    return output;
  }

  function applicant(record) {
    const combined = [record.ApplicantForename, record.ApplicantSurname].map(text).filter(Boolean).join(" ");
    if (combined) return combined;
    const candidates = ["Applicant", "APPLICANT", "ApplicantName", "APPLICANT_NAME", "APPLICANTNAME", "PROMOTER", "CLIENT", "Developer", "DEVELOPER"];
    for (const key of candidates) if (text(record[key])) return text(record[key]);
    return "Not published";
  }

  function recordRichness(record) {
    return ["NumResidentialUnits", "DecisionDate", "Decision", "GrantDate", "AppealRefNumber", "AppealSubmittedDate", "AppealDecisionDate", "LinkAppDetails", "ApplicantSurname"]
      .reduce((score, field) => score + (record[field] !== null && record[field] !== undefined && record[field] !== "" ? 1 : 0), 0);
  }

  function mergePlanningRecord(left, right) {
    const primary = recordRichness(right) > recordRichness(left) ? right : left;
    const secondary = primary === left ? right : left;
    const merged = { ...secondary, ...primary };
    Object.keys(secondary).forEach(key => {
      if (merged[key] == null || merged[key] === "") merged[key] = secondary[key];
    });
    merged.NumResidentialUnits = Math.max(numeric(left.NumResidentialUnits), numeric(right.NumResidentialUnits));
    return merged;
  }

  function planningKey(record, source, index) {
    const authority = canonicalAuthority(record.PlanningAuthority).toUpperCase();
    const reference = text(record.ApplicationNumber).toUpperCase();
    return reference ? `${authority}|${reference}` : `${authority}|${source}|${record.OBJECTID ?? index}`;
  }

  function dedupePlanning(sources) {
    const records = new Map();
    sources.forEach(({ source, rows }) => rows.forEach((raw, index) => {
      const record = {
        ...raw,
        PlanningAuthority: source === "cork" ? "Cork City Council" : canonicalAuthority(raw.PlanningAuthority),
        AreaofSite: raw.AreaofSite ?? raw.AreaOfSite,
        DirectSource: source === "cork" ? "Cork City Council CKAN" : raw.DirectSource,
        __source: source
      };
      const key = planningKey(record, source, index);
      records.set(key, records.has(key) ? mergePlanningRecord(records.get(key), record) : record);
    }));
    return [...records.values()];
  }

  const INFRASTRUCTURE_RULES = [
    [/strategic infrastructure|section 37e|s\.\s*37e|\bsid\b/i, "Strategic infrastructure"],
    [/data cent(?:re|er)|digital infrastructure|server campus/i, "Data-centre infrastructure"],
    [/railway|rail line|metro|dart\+?|light rail|luas/i, "Rail infrastructure"],
    [/motorway|national road|road scheme|bypass|interchange/i, "Major road infrastructure"],
    [/airport|runway|aviation/i, "Airport infrastructure"],
    [/port development|harbour development|marine terminal|shipping terminal/i, "Port or harbour infrastructure"],
    [/wind farm|offshore wind|solar farm|battery energy storage|energy storage|substation|electricity transmission|grid connection|gas pipeline/i, "Strategic energy infrastructure"],
    [/wastewater treatment|water treatment|reservoir|water supply scheme|sewerage scheme/i, "Major utility infrastructure"],
    [/hospital|medical campus|healthcare campus/i, "Major healthcare development"],
    [/university campus|third level campus|technology campus/i, "Major education or technology campus"],
    [/logistics park|distribution centre|industrial campus|biopharmaceutical|pharmaceutical campus/i, "Major employment development"]
  ];

  function planningSignificance(record) {
    const reasons = [];
    const units = numeric(record.NumResidentialUnits);
    const floor = numeric(record.FloorArea);
    const site = numeric(record.AreaofSite ?? record.AreaOfSite);
    if (units >= 100) reasons.push(`${format(units)} residential units`);
    if (floor >= 10000) reasons.push(`${format(floor)} m² floor area`);
    if (site >= 10) reasons.push(`${new Intl.NumberFormat("en-IE", { maximumFractionDigits: 1 }).format(site)} ha site`);
    const haystack = [record.ApplicationType, record.LandUseCode, record.DevelopmentDescription, record.DevelopmentAddress].map(text).join(" ");
    INFRASTRUCTURE_RULES.forEach(([pattern, label]) => { if (pattern.test(haystack) && !reasons.includes(label)) reasons.push(label); });
    return reasons;
  }

  function acpSignificance(record) {
    const reasons = [];
    const category = text(record.CATEGORY || record.Category || record.CASETYPE || record.CaseType);
    const haystack = [category, record.DEVDESC, record.DEVADDRESS, record.Description, record.Title].map(text).join(" ");
    if (/strategic infrastructure|\bsid\b|section 37e|s\.\s*37e/i.test(haystack)) reasons.push("ACP strategic infrastructure case");
    if (/strategic housing|\bshd\b|large[- ]scale residential|\blrd\b/i.test(haystack)) reasons.push("Strategic or large-scale residential case");
    INFRASTRUCTURE_RULES.forEach(([pattern, label]) => { if (pattern.test(haystack) && !reasons.includes(label)) reasons.push(label); });
    return reasons;
  }

  function inWindow(value, startTime, endTime) {
    const time = parseTime(value);
    return time != null && time >= startTime && time <= endTime;
  }

  function planningUrl(record) {
    const supplied = text(record.LinkAppDetails || record.LINKAPPDETAILS || record.ApplicationURL || record.URL);
    if (/^https?:\/\//i.test(supplied)) return supplied;
    const url = new URL("record-view.html", window.location.href);
    url.searchParams.set("source", record.__source === "cork" ? "cork" : record.__source === "sites" ? "planningSites" : "planningPoints");
    url.searchParams.set("ref", text(record.ApplicationNumber));
    url.searchParams.set("authority", canonicalAuthority(record.PlanningAuthority));
    return url.toString();
  }

  function acpUrl(recordOrReference) {
    const supplied = typeof recordOrReference === "object" ? text(recordOrReference.LINKABPWEB || recordOrReference.LinkABPWeb) : "";
    if (/^https?:\/\//i.test(supplied)) return supplied;
    const reference = normaliseCaseReference(typeof recordOrReference === "object" ? recordOrReference.ABPCASEID : recordOrReference);
    return reference.length === 6 ? `https://www.pleanala.ie/en-ie/case/${reference}` : "";
  }

  function projectTitle(planning, acp) {
    const address = text(planning?.DevelopmentAddress || acp?.DEVADDRESS);
    if (address) return address;
    const description = text(planning?.DevelopmentDescription || acp?.DEVDESC);
    if (description) return description.length > 130 ? `${description.slice(0, 127)}…` : description;
    return text(planning?.ApplicationNumber || acp?.ABPCASEID || "Planning project");
  }

  function acpKey(record) {
    return normaliseCaseReference(record?.ABPCASEID || record?.CASE_REF || record?.CaseReference);
  }

  function buildRows(planningRecords, acpRecords, startTime, endTime) {
    const acpByRef = new Map();
    acpRecords.forEach(record => {
      const key = acpKey(record);
      if (key) acpByRef.set(key, record);
    });
    const planningByAppeal = new Map();
    planningRecords.forEach(record => {
      const key = normaliseCaseReference(record.AppealRefNumber || record.AppealRefNum);
      if (key) planningByAppeal.set(key, record);
    });

    const rows = [];
    const usedAcp = new Set();
    planningRecords.forEach(planning => {
      const appealRef = normaliseCaseReference(planning.AppealRefNumber || planning.AppealRefNum);
      const acp = appealRef ? acpByRef.get(appealRef) : null;
      const reasons = planningSignificance(planning);
      const acpReasons = acp ? acpSignificance(acp) : [];
      const allReasons = [...new Set([...reasons, ...acpReasons])];
      if (!allReasons.length) return;

      const movements = [];
      if (inWindow(planning.ReceivedDate, startTime, endTime)) movements.push({ key: "planning-lodged", label: "Planning lodged", date: planning.ReceivedDate, kind: "lodgement" });
      if (inWindow(planning.DecisionDate, startTime, endTime)) movements.push({ key: "planning-decided", label: "Planning decision", date: planning.DecisionDate, kind: /refus/i.test(text(planning.Decision)) ? "refusal" : "decision" });
      if (inWindow(planning.GrantDate, startTime, endTime)) movements.push({ key: "planning-decided", label: "Grant issued", date: planning.GrantDate, kind: "decision" });
      if (inWindow(planning.AppealSubmittedDate, startTime, endTime)) movements.push({ key: "appeal", label: "Appeal lodged", date: planning.AppealSubmittedDate, kind: "appeal" });
      if (inWindow(planning.AppealDecisionDate, startTime, endTime)) movements.push({ key: "appeal", label: "Appeal decision", date: planning.AppealDecisionDate, kind: /refus|dismiss/i.test(text(planning.AppealDecision)) ? "refusal" : "appeal" });
      if (acp && inWindow(acp.LODGEDON, startTime, endTime)) movements.push({ key: "appeal", label: "ACP lodged", date: acp.LODGEDON, kind: "appeal" });
      if (acp && inWindow(acp.DECIDED_ON, startTime, endTime)) movements.push({ key: "appeal", label: "ACP decision", date: acp.DECIDED_ON, kind: /refus|dismiss/i.test(text(acp.DECISION)) ? "refusal" : "appeal" });
      if (!movements.length) return;
      if (acp) usedAcp.add(acpKey(acp));

      const latest = Math.max(...movements.map(movement => parseTime(movement.date) || 0));
      const units = numeric(planning.NumResidentialUnits);
      const planningRecordUrl = planningUrl(planning);
      rows.push({
        type: "planning",
        project: projectTitle(planning, acp),
        projectUrl: planningRecordUrl,
        planningUrl: planningRecordUrl,
        acpUrl: acp ? acpUrl(acp) : appealRef ? acpUrl(appealRef) : "",
        planningRef: text(planning.ApplicationNumber),
        acpRef: acp ? acpKey(acp) : appealRef,
        authority: canonicalAuthority(planning.PlanningAuthority || acp?.PLANINGATY),
        applicant: applicant(planning),
        units,
        receivedDate: planning.ReceivedDate,
        planningDecisionDate: planning.DecisionDate,
        grantDate: planning.GrantDate,
        appealLodgedDate: planning.AppealSubmittedDate || acp?.LODGEDON,
        acpDecisionDate: planning.AppealDecisionDate || acp?.DECIDED_ON,
        planningDecision: text(planning.Decision),
        acpDecision: text(planning.AppealDecision || acp?.DECISION),
        category: text(acp?.CATEGORY || planning.ApplicationType),
        description: text(planning.DevelopmentDescription || acp?.DEVDESC),
        reasons: allReasons,
        movements,
        latest,
        isSid: allReasons.some(reason => /strategic|infrastructure|sid/i.test(reason)) || acpReasons.length > 0,
        refused: /refus|dismiss/i.test(`${planning.Decision} ${planning.AppealDecision} ${acp?.DECISION || ""}`),
        significanceScore: units * 1000 + (allReasons.some(reason => /strategic infrastructure/i.test(reason)) ? 900000 : 0) + allReasons.length * 10000
      });
    });

    acpRecords.forEach(acp => {
      const reference = acpKey(acp);
      if (reference && usedAcp.has(reference)) return;
      const reasons = acpSignificance(acp);
      const linkedPlanning = reference ? planningByAppeal.get(reference) : null;
      const planningReasons = linkedPlanning ? planningSignificance(linkedPlanning) : [];
      const allReasons = [...new Set([...reasons, ...planningReasons])];
      if (!allReasons.length) return;
      const movements = [];
      if (inWindow(acp.LODGEDON, startTime, endTime)) movements.push({ key: "appeal", label: "ACP lodged", date: acp.LODGEDON, kind: "appeal" });
      if (inWindow(acp.DECIDED_ON, startTime, endTime)) movements.push({ key: "appeal", label: "ACP decision", date: acp.DECIDED_ON, kind: /refus|dismiss/i.test(text(acp.DECISION)) ? "refusal" : "appeal" });
      if (!movements.length) return;
      const units = numeric(linkedPlanning?.NumResidentialUnits);
      rows.push({
        type: "acp",
        project: projectTitle(linkedPlanning, acp),
        projectUrl: linkedPlanning ? planningUrl(linkedPlanning) : acpUrl(acp),
        planningUrl: linkedPlanning ? planningUrl(linkedPlanning) : "",
        acpUrl: acpUrl(acp),
        planningRef: text(linkedPlanning?.ApplicationNumber),
        acpRef: reference,
        authority: canonicalAuthority(linkedPlanning?.PlanningAuthority || acp.PLANINGATY),
        applicant: linkedPlanning ? applicant(linkedPlanning) : applicant(acp),
        units,
        receivedDate: linkedPlanning?.ReceivedDate || acp.LODGEDON,
        planningDecisionDate: linkedPlanning?.DecisionDate,
        grantDate: linkedPlanning?.GrantDate,
        appealLodgedDate: acp.LODGEDON,
        acpDecisionDate: acp.DECIDED_ON,
        planningDecision: text(linkedPlanning?.Decision),
        acpDecision: text(acp.DECISION),
        category: text(acp.CATEGORY || acp.CASETYPE),
        description: text(acp.DEVDESC || linkedPlanning?.DevelopmentDescription),
        reasons: allReasons,
        movements,
        latest: Math.max(...movements.map(movement => parseTime(movement.date) || 0)),
        isSid: true,
        refused: /refus|dismiss/i.test(text(acp.DECISION)),
        significanceScore: units * 1000 + 900000 + allReasons.length * 10000
      });
    });

    return rows.sort((left, right) => right.units - left.units || right.significanceScore - left.significanceScore || right.latest - left.latest);
  }

  function movementMarkup(movements) {
    return movements
      .sort((left, right) => (parseTime(right.date) || 0) - (parseTime(left.date) || 0))
      .map(movement => `<span class="movement ${html(movement.kind)}">${html(movement.label)}</span>`).join("");
  }

  function recordLink(reference, url) {
    if (!reference) return "—";
    return url ? `<a class="record-link" href="${html(url)}" target="_blank" rel="noopener noreferrer">${html(reference)} ↗</a>` : html(reference);
  }

  function filterRows() {
    const search = text($("#reportSearch")?.value).toUpperCase();
    const movement = $("#movementFilter")?.value || "all";
    const authority = $("#authorityFilterWeekly")?.value || "all";
    state.filtered = state.rows.filter(row => {
      if (authority !== "all" && row.authority !== authority) return false;
      if (movement === "planning-lodged" && !row.movements.some(item => item.key === "planning-lodged")) return false;
      if (movement === "planning-decided" && !row.movements.some(item => item.key === "planning-decided")) return false;
      if (movement === "appeal" && !row.movements.some(item => item.key === "appeal")) return false;
      if (movement === "sid" && !row.isSid) return false;
      if (movement === "refused" && !row.refused) return false;
      if (search) {
        const haystack = [row.project, row.planningRef, row.acpRef, row.authority, row.applicant, row.description, row.category, row.reasons.join(" ")].join(" ").toUpperCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
    render();
  }

  function metric(label, value, note) {
    return `<article class="metric"><span>${html(label)}</span><strong>${html(value)}</strong><small>${html(note)}</small></article>`;
  }

  function renderMetrics(rows) {
    const units = rows.reduce((sum, row) => sum + row.units, 0);
    const planningLodgements = rows.filter(row => row.movements.some(item => item.key === "planning-lodged")).length;
    const decisions = rows.filter(row => row.movements.some(item => item.key === "planning-decided" || item.label === "ACP decision" || item.label === "Appeal decision")).length;
    const acp = rows.filter(row => row.acpRef || row.movements.some(item => item.key === "appeal")).length;
    const refused = rows.filter(row => row.refused).length;
    const strategic = rows.filter(row => row.isSid).length;
    $("#reportMetrics").innerHTML = [
      metric("Projects / cases", format(rows.length), "Matching the current report filters"),
      metric("Residential units", format(units), "Reported units associated with these movements"),
      metric("Planning lodgements", format(planningLodgements), "New local-authority applications"),
      metric("Decisions", format(decisions), "Planning, appeal or ACP decisions"),
      metric("ACP / appeal cases", format(acp), "Projects with an ACP reference or movement"),
      metric("Refusals / dismissals", format(refused), `${format(strategic)} strategic or SID records`)
    ].join("");
  }

  function renderTable(rows) {
    const container = $("#reportTable");
    if (!rows.length) {
      container.innerHTML = '<div class="empty">No projects match the current report filters.</div>';
      return;
    }
    const body = rows.map((row, index) => `
      <tr>
        <td class="rank">${index + 1}</td>
        <td>${movementMarkup(row.movements)}<div>${displayDate(row.latest)}</div></td>
        <td class="project-title"><a class="project-link" href="${html(row.projectUrl)}" target="_blank" rel="noopener noreferrer">${html(row.project)} ↗</a><small>${html(row.description.slice(0, 180))}</small></td>
        <td class="units">${format(row.units)}</td>
        <td>${html(row.authority)}</td>
        <td>${html(row.applicant)}</td>
        <td>${recordLink(row.planningRef, row.planningUrl)}</td>
        <td>${recordLink(row.acpRef, row.acpUrl)}</td>
        <td>${displayDate(row.receivedDate)}</td>
        <td>${displayDate(row.planningDecisionDate)}</td>
        <td>${displayDate(row.appealLodgedDate)}</td>
        <td>${displayDate(row.acpDecisionDate)}</td>
        <td>${html(row.planningDecision || row.acpDecision || "—")}</td>
        <td>${html(row.category || "—")}</td>
        <td class="reason">${html(row.reasons.join(" · "))}</td>
      </tr>`).join("");
    container.innerHTML = `<table class="report-table"><thead><tr><th>Rank</th><th>Movement</th><th>Project</th><th>Units ↓</th><th>Authority</th><th>Applicant</th><th>Planning ref</th><th>ACP ref</th><th>Received / lodged</th><th>Planning decision</th><th>Appeal lodged</th><th>ACP / appeal decision</th><th>Decision</th><th>Category</th><th>Why included</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  function render() {
    renderMetrics(state.filtered);
    renderTable(state.filtered);
    const units = state.filtered.reduce((sum, row) => sum + row.units, 0);
    $("#visibleSummary").textContent = `${format(state.filtered.length)} records · ${format(units)} units`;
  }

  function populateAuthorities() {
    const select = $("#authorityFilterWeekly");
    const current = select.value;
    const authorities = [...new Set(state.rows.map(row => row.authority).filter(Boolean))].sort((left, right) => left.localeCompare(right));
    select.innerHTML = '<option value="all">All authorities</option>' + authorities.map(authority => `<option value="${html(authority)}">${html(authority)}</option>`).join("");
    if (authorities.includes(current)) select.value = current;
  }

  async function loadReport() {
    if (activeController) activeController.abort();
    activeController = new AbortController();
    state.warnings = [];
    const button = $("#refreshReport");
    button.disabled = true;
    button.textContent = "Refreshing…";
    status("Loading the last 30 days…", "loading");
    $("#exportCsv").disabled = true;
    $("#exportExcel").disabled = true;
    $("#emailReport").disabled = true;

    const end = new Date();
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 30);
    const startIso = start.toISOString().slice(0, 10);
    const endIso = end.toISOString().slice(0, 10);
    state.startDate = startIso;
    state.endDate = endIso;
    $("#reportWindow").textContent = `${start.toLocaleDateString("en-IE")}–${end.toLocaleDateString("en-IE")}`;

    try {
      const planningWhere = `(${planningEventWhere(startIso)})`;
      const acpWhere = acpEventWhere(startIso);
      const settled = await Promise.allSettled([
        fetchArcgisRows(PLANNING_POINTS, planningWhere, activeController.signal, "planning points"),
        fetchArcgisRows(PLANNING_SITES, planningWhere, activeController.signal, "planning sites"),
        fetchArcgisRows(ACP_CASES, acpWhere, activeController.signal, "ACP cases"),
        fetchCorkRows(startIso, activeController.signal)
      ]);
      if (settled[0].status !== "fulfilled" && settled[1].status !== "fulfilled") throw new Error("Both national planning layers failed.");
      const planningSources = [
        { source: "points", rows: settled[0].status === "fulfilled" ? settled[0].value : [] },
        { source: "sites", rows: settled[1].status === "fulfilled" ? settled[1].value : [] },
        { source: "cork", rows: settled[3].status === "fulfilled" ? settled[3].value : [] }
      ];
      const acpRows = settled[2].status === "fulfilled" ? settled[2].value : [];
      settled.forEach((result, index) => {
        if (result.status === "rejected" && result.reason?.name !== "AbortError") state.warnings.push(["Planning points", "Planning sites", "ACP cases", "Cork City direct"][index] + " unavailable");
      });

      const appealReferences = acpRows.map(acpKey).filter(value => value.length === 6);
      if (appealReferences.length) {
        try {
          const linked = await fetchPlanningByAppeals(appealReferences, activeController.signal);
          linked.forEach(item => {
            const source = planningSources.find(group => group.source === item.source);
            source?.rows.push(item.record);
          });
        } catch (error) {
          if (error.name !== "AbortError") state.warnings.push("Some ACP-linked planning records could not be resolved");
        }
      }

      const planningRecords = dedupePlanning(planningSources);
      state.rows = buildRows(planningRecords, acpRows, start.getTime(), end.getTime());
      state.filtered = [...state.rows];
      state.generatedAt = new Date();
      populateAuthorities();
      render();
      $("#exportCsv").disabled = false;
      $("#exportExcel").disabled = false;
      $("#emailReport").disabled = false;
      status(state.warnings.length ? `Report loaded with limitations: ${state.warnings.join(" · ")}` : `Report loaded · ${format(state.rows.length)} major movements`, state.warnings.length ? "error" : "idle");
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error(error);
      status(`Report failed: ${error.message}`, "error");
      $("#reportTable").innerHTML = '<div class="empty">The live report could not be generated.</div>';
    } finally {
      button.disabled = false;
      button.textContent = "Refresh report";
    }
  }

  function exportObject(row) {
    return {
      Rank: state.filtered.indexOf(row) + 1,
      Movement: row.movements.map(item => item.label).join("; "),
      "Latest movement date": isoDate(row.latest),
      Project: row.project,
      "Residential units": row.units,
      "Planning authority": row.authority,
      Applicant: row.applicant,
      "Planning reference": row.planningRef,
      "ACP reference": row.acpRef,
      "Received / lodged": isoDate(row.receivedDate),
      "Planning decision date": isoDate(row.planningDecisionDate),
      "Grant date": isoDate(row.grantDate),
      "Appeal lodged": isoDate(row.appealLodgedDate),
      "ACP / appeal decision date": isoDate(row.acpDecisionDate),
      "Planning decision": row.planningDecision,
      "ACP / appeal decision": row.acpDecision,
      Category: row.category,
      "Why included": row.reasons.join("; "),
      Description: row.description,
      "Planning URL": row.planningUrl,
      "ACP URL": row.acpUrl,
      "Project URL": row.projectUrl
    };
  }

  function csvCell(value) {
    let output = String(value ?? "");
    if (/^[=+\-@]/.test(output)) output = `'${output}`;
    return `"${output.replaceAll('"', '""')}"`;
  }

  function download(blob, filename) {
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
    const rows = state.filtered.map(exportObject);
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const content = [headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n");
    download(new Blob([`\uFEFF${content}`], { type: "text/csv;charset=utf-8" }), `weekly-planning-update-${state.endDate}.csv`);
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

  function styleSheet(sheet, rows) {
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) };
    sheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" };
    sheet["!cols"] = headers.map(header => ({ wch: Math.min(48, Math.max(12, header.length + 2)) }));
  }

  async function exportExcel() {
    const button = $("#exportExcel");
    button.disabled = true;
    button.textContent = "Building Excel…";
    try {
      await loadSheetJs();
      const workbook = XLSX.utils.book_new();
      const allRows = state.filtered.map(exportObject);
      const summary = [
        ["Radharc Pleanála Weekly Update", "Rolling 30-day planning intelligence"],
        ["Generated", state.generatedAt?.toLocaleString("en-IE") || ""],
        ["Window start", state.startDate],
        ["Window end", state.endDate],
        ["Projects / cases", state.filtered.length],
        ["Reported residential units", state.filtered.reduce((sum, row) => sum + row.units, 0)],
        ["Planning lodgements", state.filtered.filter(row => row.movements.some(item => item.key === "planning-lodged")).length],
        ["Decisions", state.filtered.filter(row => row.movements.some(item => item.key === "planning-decided" || item.label.includes("decision"))).length],
        ["Refusals / dismissals", state.filtered.filter(row => row.refused).length],
        ["Warnings", state.warnings.join(" · ")],
        [],
        ["Coverage", "100+ residential units; SID/strategic cases; 10,000+ m²; 10+ ha; identified national-scale transport, energy, utility, port, airport, hospital and data-centre projects."]
      ];
      const summarySheet = XLSX.utils.aoa_to_sheet(summary);
      summarySheet["!cols"] = [{ wch: 34 }, { wch: 110 }];
      XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");

      const combined = XLSX.utils.json_to_sheet(allRows.length ? allRows : [{ Status: "No matching records" }]);
      styleSheet(combined, allRows);
      XLSX.utils.book_append_sheet(workbook, combined, "Combined Ranked");

      const planningRows = state.filtered.filter(row => row.planningRef).map(exportObject);
      const planningSheet = XLSX.utils.json_to_sheet(planningRows.length ? planningRows : [{ Status: "No planning movements" }]);
      styleSheet(planningSheet, planningRows);
      XLSX.utils.book_append_sheet(workbook, planningSheet, "Planning Movements");

      const acpRows = state.filtered.filter(row => row.acpRef || row.isSid).map(exportObject);
      const acpSheet = XLSX.utils.json_to_sheet(acpRows.length ? acpRows : [{ Status: "No ACP or SID movements" }]);
      styleSheet(acpSheet, acpRows);
      XLSX.utils.book_append_sheet(workbook, acpSheet, "ACP and SID");
      XLSX.writeFile(workbook, `weekly-planning-update-${state.endDate}.xlsx`, { compression: true });
    } catch (error) {
      status(`Excel export failed: ${error.message}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Export Excel";
    }
  }

  function emailLink() {
    const subject = `Radharc Pleanála weekly update · ${state.endDate}`;
    const units = state.filtered.reduce((sum, row) => sum + row.units, 0);
    const body = [
      `Weekly Planning Update for ${state.startDate} to ${state.endDate}`,
      "",
      `${state.filtered.length} major projects/cases`,
      `${format(units)} reported residential units`,
      "",
      `Open the live report: ${window.location.href}`,
      "",
      "The report covers 100+ unit applications, SIDs and other significant infrastructure movements."
    ].join("\n");
    window.location.href = `mailto:${encodeURIComponent(EMAIL)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function bind() {
    $("#refreshReport").addEventListener("click", loadReport);
    $("#reportSearch").addEventListener("input", filterRows);
    $("#movementFilter").addEventListener("change", filterRows);
    $("#authorityFilterWeekly").addEventListener("change", filterRows);
    $("#clearReportFilters").addEventListener("click", () => {
      $("#reportSearch").value = "";
      $("#movementFilter").value = "all";
      $("#authorityFilterWeekly").value = "all";
      filterRows();
    });
    $("#exportCsv").addEventListener("click", exportCsv);
    $("#exportExcel").addEventListener("click", exportExcel);
    $("#emailReport").addEventListener("click", emailLink);
    loadReport();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
