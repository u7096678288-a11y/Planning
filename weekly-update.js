"use strict";

(function weeklyPlanningUpdate() {
  const PLANNING_POINTS = "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0";
  const PLANNING_SITES = "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/1";
  const ACP_CASES = "https://services-eu1.arcgis.com/o56BSnENmD5mYs3j/ArcGIS/rest/services/Cases_2016_Onwards/FeatureServer/3";
  const CORK_API = "https://data.corkcity.ie/api/3/action/datastore_search_sql";
  const CORK_RESOURCE = "8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";
  const EMAIL = "u7096678288@gmail.com";
  const WINDOW_DAYS = 28;
  const UPCOMING_DAYS = 28;
  const MIN_UNITS = 90;
  const PAGE_SIZE = 2000;
  const MAX_ROWS = 50000;

  const SECTION_ORDER = [
    ["submitted", "1. Submitted", "Planning applications received during the previous 28 days."],
    ["fi", "2. Further Information", "Further-information requests or responses recorded during the previous 28 days."],
    ["granted", "3. Granted", "Local-authority grants and conditional grants recorded during the previous 28 days."],
    ["acp-lodged", "4. ACP Lodged", "Appeals and cases lodged with An Coimisiún Pleanála during the previous 28 days."],
    ["acp-decided", "5. ACP Decided", "An Coimisiún Pleanála decisions recorded during the previous 28 days."],
    ["sid", "6. Strategic Infrastructure Developments", "SID and other strategic-infrastructure projects with a recent or upcoming movement."],
    ["roads", "7. Local-Authority Road Developments", "Part 8, section 179A and other identifiable local-authority road schemes."],
    ["cpo-rail", "8. CPOs and Rail Orders", "Compulsory-purchase, railway-order and related transport-order movements."],
    ["upcoming", "9. Upcoming", "Qualifying applications with a published decision due date in the next 28 days and no recorded decision."]
  ];

  const state = {
    projects: [],
    filtered: [],
    sections: new Map(),
    generatedAt: null,
    startTime: null,
    endTime: null,
    upcomingEndTime: null,
    warnings: []
  };
  let activeController = null;

  const $ = selector => document.querySelector(selector);
  const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
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
    return time == null ? "—" : new Date(time).toLocaleDateString("en-IE", {
      day: "2-digit", month: "short", year: "numeric"
    });
  }

  function addDays(time, days) {
    return time + days * 86400000;
  }

  function startOfDay(time = Date.now()) {
    const date = new Date(time);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function inWindow(value, start, end) {
    const time = parseTime(value);
    return time != null && time >= start && time <= end;
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

  function setStatus(message, mode = "idle") {
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
      setStatus(`Loading ${label}… ${format(rows.length)} records`, "loading");
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

  function planningWhere(startDate, today, upcomingEnd) {
    const recentFields = [
      "ReceivedDate", "FIRequestDate", "FIRecDate", "DecisionDate", "GrantDate",
      "AppealSubmittedDate", "AppealDecisionDate"
    ];
    const recent = recentFields.map(field => `${field} >= DATE '${startDate}'`).join(" OR ");
    const upcoming = `(DecisionDate IS NULL AND DecisionDueDate >= DATE '${today}' AND DecisionDueDate < DATE '${upcomingEnd}')`;
    return `(${recent}) OR ${upcoming}`;
  }

  function acpWhere(startDate) {
    return `(LODGEDON >= DATE '${startDate}' OR DECIDED_ON >= DATE '${startDate}')`;
  }

  async function fetchCorkRows(startDate, today, upcomingEnd, signal) {
    const recentFields = [
      "ReceivedDate", "FIRequestDate", "FIRecDate", "DecisionDate", "GrantDate",
      "AppealSubmittedDate", "AppealDecisionDate"
    ];
    const recent = recentFields.map(field => `CAST("${field}" AS timestamp) >= '${startDate}'::timestamp`);
    const upcoming = `(CAST("DecisionDate" AS timestamp) IS NULL AND CAST("DecisionDueDate" AS timestamp) >= '${today}'::timestamp AND CAST("DecisionDueDate" AS timestamp) < '${upcomingEnd}'::timestamp)`;
    const sql = `SELECT * FROM "${CORK_RESOURCE}" WHERE (${recent.join(" OR ")}) OR ${upcoming} ORDER BY COALESCE(CAST("DecisionDate" AS timestamp), CAST("ReceivedDate" AS timestamp), CAST("DecisionDueDate" AS timestamp)) DESC NULLS LAST LIMIT 12000`;
    return corkJsonp(sql, signal);
  }

  async function fetchPlanningByAppeals(references, signal) {
    const refs = [...new Set(references.map(normaliseCaseReference).filter(value => value.length === 6))];
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

  function applicant(record = {}) {
    const combined = [record.ApplicantForename, record.ApplicantSurname].map(text).filter(Boolean).join(" ");
    if (combined) return combined;
    for (const key of ["Applicant", "APPLICANT", "ApplicantName", "APPLICANT_NAME", "APPLICANTNAME", "PROMOTER", "CLIENT", "Developer", "DEVELOPER"]) {
      if (text(record[key])) return text(record[key]);
    }
    return "Not published";
  }

  function recordRichness(record) {
    return [
      "NumResidentialUnits", "DecisionDate", "Decision", "GrantDate", "AppealRefNumber",
      "AppealSubmittedDate", "AppealDecisionDate", "FIRequestDate", "FIRecDate",
      "DecisionDueDate", "LinkAppDetails", "ApplicantSurname"
    ].reduce((score, field) => score + (record[field] !== null && record[field] !== undefined && record[field] !== "" ? 1 : 0), 0);
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

  const STUDENT_PATTERN = /student accommodation|student housing|student residence|student bed(?:space)?s?|purpose[- ]built student|\bpbsa\b/i;
  const SID_PATTERN = /strategic infrastructure|section 37e|s\.\s*37e|\bsid\b/i;
  const ROAD_PATTERN = /part\s*8|section\s*179a|local authority road|road development|road scheme|road improvement|road upgrade|bypass|interchange|junction improvement|active travel scheme|cycle scheme|greenway/i;
  const CPO_RAIL_PATTERN = /compulsory purchase|\bcpo\b|railway order|rail order|transport works order|metro|dart\+?|luas|railway|rail line/i;
  const SIGNIFICANT_PATTERN = /data cent(?:re|er)|digital infrastructure|server campus|airport|runway|port development|harbour development|marine terminal|wind farm|offshore wind|solar farm|battery energy storage|energy storage|substation|electricity transmission|grid connection|gas pipeline|wastewater treatment|water treatment|reservoir|water supply scheme|sewerage scheme|hospital|medical campus|university campus|logistics park|distribution centre|industrial campus|biopharmaceutical|pharmaceutical campus|national road|motorway/i;

  function projectFlags(planning = {}, acp = {}) {
    const units = numeric(planning.NumResidentialUnits);
    const category = text(acp.CATEGORY || acp.Category || acp.CASETYPE || acp.CaseType);
    const haystack = [
      planning.ApplicationType, planning.LandUseCode, planning.DevelopmentDescription,
      planning.DevelopmentAddress, acp.DEVDESC, acp.DEVADDRESS, category
    ].map(text).join(" ");
    const student = STUDENT_PATTERN.test(haystack);
    const sid = SID_PATTERN.test(haystack) || /strategic infrastructure/i.test(category);
    const roads = ROAD_PATTERN.test(haystack) && !CPO_RAIL_PATTERN.test(haystack);
    const cpoRail = CPO_RAIL_PATTERN.test(haystack);
    const significant = sid || roads || cpoRail || SIGNIFICANT_PATTERN.test(haystack);
    return {
      residential: units >= MIN_UNITS,
      student,
      significant,
      sid,
      roads,
      cpoRail,
      units,
      eligible: units >= MIN_UNITS || student || significant
    };
  }

  function typeLabels(flags) {
    const labels = [];
    if (flags.residential) labels.push(`${format(flags.units)} residential units`);
    if (flags.student) labels.push("Student housing");
    if (flags.sid) labels.push("SID");
    if (flags.roads) labels.push("LA road development");
    if (flags.cpoRail) labels.push("CPO / rail order");
    if (flags.significant && !flags.sid && !flags.roads && !flags.cpoRail) labels.push("Significant infrastructure");
    return labels;
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

  function titleFor(planning = {}, acp = {}) {
    const address = text(planning.DevelopmentAddress || acp.DEVADDRESS);
    if (address) return address;
    const description = text(planning.DevelopmentDescription || acp.DEVDESC);
    if (description) return description.length > 135 ? `${description.slice(0, 132)}…` : description;
    return text(planning.ApplicationNumber || acp.ABPCASEID || "Planning project");
  }

  function projectKey(planning = {}, acp = {}, fallback = "") {
    const planningRef = text(planning.ApplicationNumber).toUpperCase();
    const acpRef = normaliseCaseReference(acp.ABPCASEID || planning.AppealRefNumber);
    const authority = canonicalAuthority(planning.PlanningAuthority || acp.PLANINGATY).toUpperCase();
    return planningRef ? `P|${authority}|${planningRef}` : acpRef ? `A|${acpRef}` : `F|${fallback}`;
  }

  function latestTime(values) {
    return Math.max(0, ...values.map(parseTime).filter(value => value != null));
  }

  function projectFrom(planning = {}, acp = {}, fallback = "") {
    const flags = projectFlags(planning, acp);
    const appealRef = normaliseCaseReference(planning.AppealRefNumber || acp.ABPCASEID);
    const planningReference = text(planning.ApplicationNumber);
    const acpReference = normaliseCaseReference(acp.ABPCASEID || planning.AppealRefNumber);
    const authority = canonicalAuthority(planning.PlanningAuthority || acp.PLANINGATY);
    const decision = text(planning.Decision || acp.DECISION);
    const latest = latestTime([
      planning.ReceivedDate, planning.FIRequestDate, planning.FIRecDate, planning.DecisionDate,
      planning.GrantDate, planning.AppealSubmittedDate, planning.AppealDecisionDate,
      planning.DecisionDueDate, acp.LODGEDON, acp.DECIDED_ON
    ]);
    return {
      key: projectKey(planning, acp, fallback),
      planning,
      acp,
      flags,
      title: titleFor(planning, acp),
      planningRef: planningReference,
      acpRef: acpReference || appealRef,
      authority,
      applicant: applicant(planning) !== "Not published" ? applicant(planning) : applicant(acp),
      units: flags.units,
      decision,
      category: text(acp.CATEGORY || planning.ApplicationType),
      labels: typeLabels(flags),
      planningUrl: planningReference ? planningUrl(planning) : "",
      acpUrl: acpReference || appealRef ? acpUrl(acpReference ? acp : appealRef) : "",
      latestTime: latest
    };
  }

  function caseMap(acpRows) {
    const map = new Map();
    acpRows.forEach(record => {
      const reference = normaliseCaseReference(record.ABPCASEID);
      if (reference) map.set(reference, record);
    });
    return map;
  }

  function planningMap(planningRows) {
    const map = new Map();
    planningRows.forEach(record => {
      const reference = normaliseCaseReference(record.AppealRefNumber);
      if (reference && !map.has(reference)) map.set(reference, record);
    });
    return map;
  }

  function mergeProjects(planningRows, acpRows) {
    const acpByRef = caseMap(acpRows);
    const planningByAppeal = planningMap(planningRows);
    const projects = new Map();

    planningRows.forEach((planning, index) => {
      const appealRef = normaliseCaseReference(planning.AppealRefNumber);
      const project = projectFrom(planning, acpByRef.get(appealRef) || {}, `planning-${index}`);
      if (project.flags.eligible) projects.set(project.key, project);
    });

    acpRows.forEach((acp, index) => {
      const reference = normaliseCaseReference(acp.ABPCASEID);
      const planning = planningByAppeal.get(reference) || {};
      const project = projectFrom(planning, acp, `acp-${index}`);
      if (!project.flags.eligible) return;
      const existing = projects.get(project.key);
      if (!existing || project.latestTime > existing.latestTime) projects.set(project.key, project);
    });

    return [...projects.values()];
  }

  function grantDecision(value) {
    const decision = text(value).toUpperCase();
    return /GRANT|APPROV|PERMIT|CONDITIONAL/.test(decision) && !/REFUS|INVALID|WITHDRAW/.test(decision);
  }

  function recentEvents(project) {
    const p = project.planning;
    const a = project.acp;
    const events = [];
    if (inWindow(p.ReceivedDate, state.startTime, state.endTime)) {
      events.push({ section: "submitted", date: p.ReceivedDate, detail: "Planning application submitted" });
    }
    if (inWindow(p.FIRequestDate, state.startTime, state.endTime)) {
      events.push({ section: "fi", date: p.FIRequestDate, detail: "Further Information requested" });
    }
    if (inWindow(p.FIRecDate, state.startTime, state.endTime)) {
      events.push({ section: "fi", date: p.FIRecDate, detail: "Further Information received" });
    }
    const decisionDate = p.GrantDate || p.DecisionDate;
    if ((grantDecision(p.Decision) || parseTime(p.GrantDate) != null) && inWindow(decisionDate, state.startTime, state.endTime)) {
      events.push({ section: "granted", date: decisionDate, detail: text(p.Decision) || "Granted" });
    }
    if (inWindow(a.LODGEDON || p.AppealSubmittedDate, state.startTime, state.endTime)) {
      events.push({ section: "acp-lodged", date: a.LODGEDON || p.AppealSubmittedDate, detail: "ACP case lodged" });
    }
    if (inWindow(a.DECIDED_ON || p.AppealDecisionDate, state.startTime, state.endTime)) {
      events.push({ section: "acp-decided", date: a.DECIDED_ON || p.AppealDecisionDate, detail: text(a.DECISION || p.AppealDecision) || "ACP decision" });
    }
    if (!parseTime(p.DecisionDate) && inWindow(p.DecisionDueDate, state.endTime, state.upcomingEndTime)) {
      events.push({ section: "upcoming", date: p.DecisionDueDate, detail: "Decision due — upcoming" });
    }
    return events;
  }

  function rowFrom(project, event, sectionOverride = "") {
    return {
      ...project,
      section: sectionOverride || event.section,
      eventDate: event.date,
      eventDetail: event.detail,
      eventTime: parseTime(event.date) || project.latestTime
    };
  }

  function buildSections(projects) {
    const sections = new Map(SECTION_ORDER.map(([key]) => [key, []]));
    projects.forEach(project => {
      const events = recentEvents(project);
      events.forEach(event => sections.get(event.section).push(rowFrom(project, event)));

      const recentOrUpcoming = events.length > 0;
      if (recentOrUpcoming && project.flags.sid) {
        const latest = [...events].sort((left, right) => (parseTime(right.date) || 0) - (parseTime(left.date) || 0))[0];
        sections.get("sid").push(rowFrom(project, latest, "sid"));
      }
      if (recentOrUpcoming && project.flags.roads) {
        const latest = [...events].sort((left, right) => (parseTime(right.date) || 0) - (parseTime(left.date) || 0))[0];
        sections.get("roads").push(rowFrom(project, latest, "roads"));
      }
      if (recentOrUpcoming && project.flags.cpoRail) {
        const latest = [...events].sort((left, right) => (parseTime(right.date) || 0) - (parseTime(left.date) || 0))[0];
        sections.get("cpo-rail").push(rowFrom(project, latest, "cpo-rail"));
      }
    });

    sections.forEach((rows, key) => {
      const unique = new Map();
      rows.forEach(row => {
        const identity = `${row.key}|${key}|${isoDate(row.eventDate)}|${row.eventDetail}`;
        if (!unique.has(identity)) unique.set(identity, row);
      });
      const sorted = [...unique.values()].sort((left, right) =>
        right.units - left.units || right.eventTime - left.eventTime || left.title.localeCompare(right.title)
      );
      sections.set(key, sorted);
    });
    return sections;
  }

  function currentFilters() {
    return {
      search: text($("#reportSearch")?.value).toUpperCase(),
      authority: $("#authorityFilterWeekly")?.value || "all",
      type: $("#typeFilterWeekly")?.value || "all"
    };
  }

  function matchesType(row, type) {
    if (type === "all") return true;
    if (type === "residential") return row.flags.residential;
    if (type === "student") return row.flags.student;
    if (type === "infrastructure") return row.flags.significant;
    if (type === "sid") return row.flags.sid;
    if (type === "roads") return row.flags.roads;
    if (type === "cpo-rail") return row.flags.cpoRail;
    return true;
  }

  function filteredSections() {
    const filters = currentFilters();
    const sections = new Map();
    state.sections.forEach((rows, key) => {
      sections.set(key, rows.filter(row => {
        if (filters.authority !== "all" && row.authority !== filters.authority) return false;
        if (!matchesType(row, filters.type)) return false;
        if (filters.search) {
          const haystack = [
            row.title, row.planningRef, row.acpRef, row.authority, row.applicant,
            row.decision, row.category, row.eventDetail, row.labels.join(" ")
          ].join(" ").toUpperCase();
          if (!haystack.includes(filters.search)) return false;
        }
        return true;
      }));
    });
    return sections;
  }

  function allRows(sections = state.sections) {
    return SECTION_ORDER.flatMap(([key]) => sections.get(key) || []);
  }

  function uniqueProjects(rows) {
    return new Map(rows.map(row => [row.key, row])).size;
  }

  function uniqueUnits(rows) {
    const projects = new Map();
    rows.forEach(row => projects.set(row.key, row.units));
    return [...projects.values()].reduce((sum, units) => sum + units, 0);
  }

  function metric(label, value, note) {
    return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;
  }

  function renderSummary(sections) {
    const rows = allRows(sections);
    const projectCount = uniqueProjects(rows);
    const unitCount = uniqueUnits(rows);
    const count = key => (sections.get(key) || []).length;
    $("#plainSummary").innerHTML = `<strong>${format(projectCount)} qualifying projects</strong> and <strong>${format(unitCount)} reported residential units</strong>. ${format(count("submitted"))} submitted, ${format(count("fi"))} FI movements, ${format(count("granted"))} granted, ${format(count("acp-lodged"))} ACP lodged, ${format(count("acp-decided"))} ACP decided and ${format(count("upcoming"))} upcoming decisions.`;
    $("#reportMetrics").innerHTML = [
      metric("Projects", format(projectCount), "Unique qualifying projects"),
      metric("Residential units", format(unitCount), "Unique reported units"),
      metric("Submitted", format(count("submitted")), "Previous 28 days"),
      metric("FI", format(count("fi")), "Requests and responses"),
      metric("Granted", format(count("granted")), "Local-authority grants"),
      metric("ACP movements", format(count("acp-lodged") + count("acp-decided")), "Lodged and decided"),
      metric("Upcoming", format(count("upcoming")), "Next 28 days")
    ].join("");
  }

  function referenceLink(label, url) {
    if (!label) return "—";
    return url ? `<a class="record-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a>` : escapeHtml(label);
  }

  function rowMarkup(row, index) {
    const projectLink = row.planningUrl || row.acpUrl;
    const labelMarkup = row.labels.map(label => `<span class="tag">${escapeHtml(label)}</span>`).join("");
    return `<tr>
      <td class="rank">${index + 1}</td>
      <td class="project-title">${projectLink ? `<a class="project-link" href="${escapeHtml(projectLink)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title)} ↗</a>` : `<strong>${escapeHtml(row.title)}</strong>`}<small>${labelMarkup}</small></td>
      <td><strong>${escapeHtml(row.eventDetail)}</strong><small>${displayDate(row.eventDate)}</small></td>
      <td>${referenceLink(row.planningRef, row.planningUrl)}</td>
      <td>${referenceLink(row.acpRef, row.acpUrl)}</td>
      <td class="units">${row.units ? format(row.units) : "—"}</td>
      <td>${escapeHtml(row.authority)}</td>
      <td>${escapeHtml(row.applicant)}</td>
      <td>${escapeHtml(row.decision || "—")}</td>
    </tr>`;
  }

  function sectionMarkup(key, title, description, rows) {
    return `<section class="section" data-section="${escapeHtml(key)}">
      <header class="section-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><strong>${format(rows.length)} item${rows.length === 1 ? "" : "s"}</strong></header>
      <div class="table-wrap">${rows.length ? `<table class="report-table"><thead><tr><th>#</th><th>Project</th><th>Movement / date</th><th>Planning ref</th><th>ACP ref</th><th>Units ↓</th><th>Authority</th><th>Applicant</th><th>Decision</th></tr></thead><tbody>${rows.map(rowMarkup).join("")}</tbody></table>` : '<div class="empty">No qualifying movements in this section.</div>'}</div>
    </section>`;
  }

  function render() {
    const sections = filteredSections();
    state.filtered = sections;
    renderSummary(sections);
    $("#reportSections").innerHTML = SECTION_ORDER.map(([key, title, description]) => sectionMarkup(key, title, description, sections.get(key) || [])).join("");
    const shown = allRows(sections).length;
    $("#visibleSummary").textContent = `${format(shown)} categorised row${shown === 1 ? "" : "s"}`;
  }

  function populateFilters(projects) {
    const authorities = [...new Set(projects.map(project => project.authority).filter(Boolean))].sort((left, right) => left.localeCompare(right));
    const select = $("#authorityFilterWeekly");
    select.innerHTML = '<option value="all">All authorities</option>' + authorities.map(authority => `<option value="${escapeHtml(authority)}">${escapeHtml(authority)}</option>`).join("");
  }

  function csvCell(value) {
    let output = String(value ?? "");
    if (/^[=+\-@]/.test(output)) output = `'${output}`;
    return `"${output.replaceAll('"', '""')}"`;
  }

  function exportRows(sections = state.filtered || state.sections) {
    return SECTION_ORDER.flatMap(([key, title]) => (sections.get(key) || []).map(row => ({
      Section: title.replace(/^\d+\.\s*/, ""),
      Project: row.title,
      Movement: row.eventDetail,
      "Movement date": isoDate(row.eventDate),
      "Planning reference": row.planningRef,
      "ACP reference": row.acpRef,
      "Residential units": row.units || "",
      "Planning authority": row.authority,
      Applicant: row.applicant,
      Decision: row.decision,
      Category: row.category,
      "Qualification labels": row.labels.join("; "),
      "Planning URL": row.planningUrl,
      "ACP URL": row.acpUrl
    })));
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
    const rows = exportRows();
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const csv = [headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n");
    downloadBlob(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `radharc-weekly-update-${isoDate(state.endTime)}.csv`);
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

  async function exportExcel() {
    const button = $("#exportExcel");
    const previous = button.textContent;
    button.disabled = true;
    button.textContent = "Building Excel…";
    try {
      await loadSheetJs();
      const workbook = XLSX.utils.book_new();
      const summary = [
        ["Radharc Pleanála Weekly Update", "28-day planning intelligence"],
        ["Generated", state.generatedAt.toLocaleString("en-IE")],
        ["Reporting period", `${displayDate(state.startTime)} to ${displayDate(state.endTime)}`],
        ["Upcoming period", `${displayDate(state.endTime)} to ${displayDate(state.upcomingEndTime)}`],
        ["Minimum residential threshold", MIN_UNITS],
        ["Unique qualifying projects", uniqueProjects(allRows(state.filtered))],
        ["Reported residential units", uniqueUnits(allRows(state.filtered))],
        [],
        ["Section", "Rows"]
      ];
      SECTION_ORDER.forEach(([key, title]) => summary.push([title, (state.filtered.get(key) || []).length]));
      const summarySheet = XLSX.utils.aoa_to_sheet(summary);
      summarySheet["!cols"] = [{ wch: 36 }, { wch: 70 }];
      XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");

      SECTION_ORDER.forEach(([key, title]) => {
        const rows = (state.filtered.get(key) || []).map(row => exportRows(new Map([[key, [row]]]))[0]);
        const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Status: "No qualifying movements" }]);
        if (rows.length) {
          const headers = Object.keys(rows[0]);
          sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) };
          sheet["!cols"] = headers.map(header => ({ wch: Math.min(42, Math.max(12, header.length + 2)) }));
        }
        XLSX.utils.book_append_sheet(workbook, sheet, title.replace(/^\d+\.\s*/, "").slice(0, 31));
      });
      XLSX.writeFile(workbook, `radharc-weekly-update-${isoDate(state.endTime)}.xlsx`, { compression: true });
    } catch (error) {
      setStatus(`Excel export failed: ${error.message}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  }

  function emailReport() {
    const rows = allRows(state.filtered);
    const summary = $("#plainSummary").textContent.trim();
    const subject = `Radharc Pleanála weekly update · ${displayDate(state.startTime)}–${displayDate(state.endTime)}`;
    const body = [
      "Radharc Pleanála — Weekly Planning Update",
      "",
      summary,
      "",
      `Reporting period: ${displayDate(state.startTime)} to ${displayDate(state.endTime)}`,
      `Upcoming decisions: to ${displayDate(state.upcomingEndTime)}`,
      `Categorised rows: ${rows.length}`,
      "",
      window.location.href
    ].join("\n");
    window.location.href = `mailto:${EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  async function refresh() {
    if (activeController) activeController.abort();
    activeController = new AbortController();
    state.warnings = [];
    const refreshButton = $("#refreshReport");
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing…";
    setStatus("Loading the previous 28 days and upcoming decision dates…", "loading");

    const end = Date.now();
    const today = startOfDay(end);
    const start = addDays(today, -WINDOW_DAYS);
    const upcomingEnd = addDays(today, UPCOMING_DAYS);
    state.startTime = start;
    state.endTime = end;
    state.upcomingEndTime = upcomingEnd;
    $("#reportWindow").textContent = `${displayDate(start)}–${displayDate(end)} · upcoming to ${displayDate(upcomingEnd)}`;

    const startDate = isoDate(start);
    const todayDate = isoDate(today);
    const upcomingDate = isoDate(upcomingEnd);
    try {
      const base = await Promise.allSettled([
        fetchArcgisRows(PLANNING_POINTS, planningWhere(startDate, todayDate, upcomingDate), activeController.signal, "planning points"),
        fetchArcgisRows(PLANNING_SITES, planningWhere(startDate, todayDate, upcomingDate), activeController.signal, "planning sites"),
        fetchArcgisRows(ACP_CASES, acpWhere(startDate), activeController.signal, "ACP cases"),
        fetchCorkRows(startDate, todayDate, upcomingDate, activeController.signal)
      ]);
      const pointRows = base[0].status === "fulfilled" ? base[0].value : [];
      const siteRows = base[1].status === "fulfilled" ? base[1].value : [];
      const acpRows = base[2].status === "fulfilled" ? base[2].value : [];
      const corkRows = base[3].status === "fulfilled" ? base[3].value : [];
      base.forEach((result, index) => {
        if (result.status === "rejected") state.warnings.push(["Planning points", "Planning sites", "ACP", "Cork City direct"][index] + " unavailable");
      });

      const linked = await fetchPlanningByAppeals(acpRows.map(record => record.ABPCASEID), activeController.signal).catch(error => {
        state.warnings.push(`Appeal-linked planning lookup unavailable: ${error.message}`);
        return [];
      });
      const linkedPoints = linked.filter(item => item.source === "points").map(item => item.record);
      const linkedSites = linked.filter(item => item.source === "sites").map(item => item.record);
      const planningRows = dedupePlanning([
        { source: "points", rows: [...pointRows, ...linkedPoints] },
        { source: "sites", rows: [...siteRows, ...linkedSites] },
        { source: "cork", rows: corkRows }
      ]);

      state.projects = mergeProjects(planningRows, acpRows);
      state.sections = buildSections(state.projects);
      state.generatedAt = new Date();
      populateFilters(state.projects);
      render();
      $("#exportCsv").disabled = false;
      $("#exportExcel").disabled = false;
      $("#emailReport").disabled = false;
      const totalRows = allRows(state.sections).length;
      setStatus(`Report complete · ${format(state.projects.length)} qualifying projects · ${format(totalRows)} categorised movements${state.warnings.length ? ` · ${state.warnings.join(" · ")}` : ""}`, state.warnings.length ? "error" : "idle");
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error(error);
      setStatus(`Report failed: ${error.message}`, "error");
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh report";
    }
  }

  function bind() {
    $("#refreshReport").addEventListener("click", refresh);
    $("#reportSearch").addEventListener("input", render);
    $("#authorityFilterWeekly").addEventListener("change", render);
    $("#typeFilterWeekly").addEventListener("change", render);
    $("#clearReportFilters").addEventListener("click", () => {
      $("#reportSearch").value = "";
      $("#authorityFilterWeekly").value = "all";
      $("#typeFilterWeekly").value = "all";
      render();
    });
    $("#exportCsv").addEventListener("click", exportCsv);
    $("#exportExcel").addEventListener("click", exportExcel);
    $("#emailReport").addEventListener("click", emailReport);
    refresh();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
