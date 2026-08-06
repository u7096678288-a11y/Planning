"use strict";

(() => {
  const ACP_QUERY_MARKER = "/Cases_2016_Onwards/FeatureServer/3/query";
  const PLANNING_POINTS = "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0";
  const PLANNING_SITES = "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/1";
  const CORK_API = "https://data.corkcity.ie/api/3/action/datastore_search_sql";
  const CORK_RESOURCE = "8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";
  const MIN_UNITS = 100;
  const WINDOW_DAYS = 28;
  const PANEL_ID = "weeklyAppealsPanel";
  const capturedCases = new Map();
  const state = {
    events: [],
    loading: false,
    loadedSignature: "",
    renderQueued: false,
    warning: ""
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    try {
      const rawUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (String(rawUrl).toLowerCase().includes(ACP_QUERY_MARKER.toLowerCase())) {
        response.clone().json().then(captureAcpResponse).catch(() => {});
      }
    } catch {}
    return response;
  };

  const $ = selector => document.querySelector(selector);
  const text = value => String(value ?? "").replace(/\s+/g, " ").replace(/\s*↗\s*$/, "").trim();
  const number = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : 0;
  const format = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
  const escapeSql = value => String(value ?? "").replaceAll("'", "''");

  function time(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    const parsed = new Date(Number.isFinite(numeric) ? numeric : value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  function date(value) {
    const parsed = time(value);
    return parsed == null ? "—" : new Date(parsed).toLocaleDateString("en-IE", {
      day: "2-digit", month: "short", year: "numeric"
    });
  }

  function iso(value) {
    const parsed = time(value);
    return parsed == null ? "" : new Date(parsed).toISOString().slice(0, 10);
  }

  function caseReference(value) {
    const source = text(value);
    const matches = source.match(/\d{6}/g);
    if (matches?.length) return matches.at(-1);
    const digits = source.replace(/\D/g, "");
    return digits.length >= 6 ? digits.slice(-6) : digits;
  }

  function authority(value) {
    const source = text(value);
    const upper = source.toUpperCase();
    if (upper.includes("CORK CITY")) return "Cork City Council";
    if (upper.includes("CORK COUNTY")) return "Cork County Council";
    return source || "Not stated";
  }

  function applicant(record = {}) {
    const name = [record.ApplicantForename, record.ApplicantSurname].map(text).filter(Boolean).join(" ");
    return name || text(record.Applicant || record.APPLICANT || record.PROMOTER) || "Not published";
  }

  function captureAcpResponse(payload) {
    const features = Array.isArray(payload?.features) ? payload.features : [];
    let changed = false;
    features.forEach(feature => {
      const record = feature?.attributes || feature?.properties || {};
      const ref = caseReference(record.ABPCASEID);
      if (!ref) return;
      const current = capturedCases.get(ref) || {};
      const merged = { ...current, ...record };
      if (JSON.stringify(current) !== JSON.stringify(merged)) changed = true;
      capturedCases.set(ref, merged);
    });
    if (changed) scheduleLoad();
  }

  function signature() {
    return [...capturedCases.values()]
      .map(record => [caseReference(record.ABPCASEID), time(record.LODGEDON) || 0, time(record.DECIDED_ON) || 0, text(record.CATEGORY)].join("|"))
      .sort()
      .join(";");
  }

  function isWithinWindow(value) {
    const parsed = time(value);
    if (parsed == null) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = today.getTime() - WINDOW_DAYS * 86400000;
    return parsed >= start && parsed <= Date.now();
  }

  function body(parameters) {
    const output = new URLSearchParams();
    Object.entries({ f: "json", ...parameters }).forEach(([key, value]) => {
      if (value == null) return;
      output.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    });
    return output;
  }

  async function queryArcgis(url, where, signal) {
    const fields = [
      "OBJECTID", "PlanningAuthority", "ApplicationNumber", "AppealRefNumber",
      "DevelopmentAddress", "DevelopmentDescription", "NumResidentialUnits",
      "Decision", "AppealDecision", "LinkAppDetails", "ApplicantForename", "ApplicantSurname"
    ];
    const rows = [];
    for (let offset = 0; offset < 10000; offset += 2000) {
      const response = await originalFetch(`${url}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: body({
          where,
          outFields: fields.join(","),
          returnGeometry: false,
          resultOffset: offset,
          resultRecordCount: 2000,
          orderByFields: "OBJECTID ASC"
        }),
        cache: "no-store",
        credentials: "omit",
        signal
      });
      if (!response.ok) throw new Error(`Planning service HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error.message);
      const batch = (payload.features || []).map(feature => ({ ...(feature.attributes || {}), __source: url === PLANNING_SITES ? "sites" : "points" }));
      rows.push(...batch);
      if (!batch.length || (batch.length < 2000 && !payload.exceededTransferLimit)) break;
    }
    return rows;
  }

  function jsonp(sql, signal, timeout = 25000) {
    return new Promise((resolve, reject) => {
      const callback = `__weeklyCorkAppeals${Date.now()}${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");
      const url = new URL(CORK_API);
      let finished = false;
      const clean = () => {
        script.remove();
        try { delete window[callback]; } catch { window[callback] = undefined; }
      };
      const finish = (handler, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        clean();
        handler(value);
      };
      const timer = setTimeout(() => finish(reject, new Error("Cork City appeal lookup timed out")), timeout);
      const abort = () => finish(reject, new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      window[callback] = payload => payload?.success
        ? finish(resolve, payload.result?.records || [])
        : finish(reject, new Error(payload?.error?.message || "Cork City appeal lookup failed"));
      script.onerror = () => finish(reject, new Error("Cork City appeal lookup unavailable"));
      url.searchParams.set("sql", sql);
      url.searchParams.set("callback", callback);
      script.src = url.toString();
      document.head.append(script);
    });
  }

  async function queryCork(refs, signal) {
    if (!refs.length) return [];
    const fields = [
      "PlanningAuthority", "ApplicationNumber", "AppealRefNumber", "DevelopmentAddress",
      "DevelopmentDescription", "NumResidentialUnits", "Decision", "LinkAppDetails",
      "ApplicantForename", "ApplicantSurname"
    ];
    const clauses = refs.map(ref => `"AppealRefNumber" ILIKE '%${escapeSql(ref)}%'`);
    const sql = `SELECT ${fields.map(field => `"${field}"`).join(",")} FROM "${CORK_RESOURCE}" WHERE (${clauses.join(" OR ")}) LIMIT 5000`;
    const rows = await jsonp(sql, signal);
    return rows.map(record => ({ ...record, PlanningAuthority: "Cork City Council", __source: "cork" }));
  }

  function dedupePlanning(rows) {
    const output = new Map();
    rows.forEach((record, index) => {
      const key = `${authority(record.PlanningAuthority).toUpperCase()}|${text(record.ApplicationNumber).toUpperCase() || index}`;
      const current = output.get(key);
      if (!current || number(record.NumResidentialUnits) > number(current.NumResidentialUnits)) output.set(key, record);
    });
    return [...output.values()];
  }

  function linkedReference(record) {
    return caseReference(record.AppealRefNumber);
  }

  function isSid(caseRecord, planningRecord = {}) {
    return /strategic infrastructure|section\s*37e|s\.\s*37e|\bsid\b/i.test([
      caseRecord.CATEGORY, caseRecord.DEVDESC, caseRecord.DEVADDRESS,
      planningRecord.DevelopmentDescription, planningRecord.DevelopmentAddress
    ].map(text).join(" "));
  }

  function planningFlags(caseRecord, planningRecord = {}) {
    const combined = [
      caseRecord.CATEGORY, caseRecord.DEVDESC, caseRecord.DEVADDRESS,
      planningRecord.DevelopmentDescription, planningRecord.DevelopmentAddress
    ].map(text).join(" ");
    const cpo = /compulsory purchase|\bcpo\b|railway order|rail order|metro|dart\+?|luas|railway|rail line/i.test(combined);
    const roads = !cpo && /part\s*8|section\s*179a|local authority road|road development|road scheme|road improvement|road upgrade|bypass|interchange|junction improvement|active travel scheme|cycle scheme|greenway/i.test(combined);
    return { sid: isSid(caseRecord, planningRecord), roads, cpo };
  }

  function planningUrl(record = {}) {
    const direct = text(record.LinkAppDetails);
    if (/^https?:\/\//i.test(direct)) return direct;
    const ref = text(record.ApplicationNumber);
    if (!ref) return "";
    const url = new URL("record-view.html", location.href);
    url.searchParams.set("source", record.__source === "cork" ? "cork" : record.__source === "sites" ? "planningSites" : "planningPoints");
    url.searchParams.set("ref", ref);
    url.searchParams.set("authority", authority(record.PlanningAuthority));
    return url.toString();
  }

  function acpUrl(caseRecord = {}) {
    const direct = text(caseRecord.LINKABPWEB);
    const ref = caseReference(caseRecord.ABPCASEID);
    if (/^https?:\/\//i.test(direct)) return direct;
    return ref ? `https://www.pleanala.ie/en-ie/case/${ref}` : "";
  }

  function bestPlanning(caseRecord, candidates) {
    const caseAuthority = authority(caseRecord.PLANINGATY);
    return [...candidates].sort((left, right) => {
      const leftAuthority = authority(left.PlanningAuthority) === caseAuthority ? 1 : 0;
      const rightAuthority = authority(right.PlanningAuthority) === caseAuthority ? 1 : 0;
      return rightAuthority - leftAuthority || number(right.NumResidentialUnits) - number(left.NumResidentialUnits);
    })[0] || {};
  }

  function buildEvents(planningRows) {
    const byReference = new Map();
    planningRows.forEach(record => {
      const ref = linkedReference(record);
      if (!ref) return;
      if (!byReference.has(ref)) byReference.set(ref, []);
      byReference.get(ref).push(record);
    });

    const events = [];
    capturedCases.forEach((caseRecord, ref) => {
      const candidates = byReference.get(ref) || [];
      const category = text(caseRecord.CATEGORY);
      const appeal = /appeal/i.test(category) || candidates.length > 0;
      if (!appeal) return;
      const planning = bestPlanning(caseRecord, candidates);
      const units = number(planning.NumResidentialUnits);
      const flags = planningFlags(caseRecord, planning);
      if (units < MIN_UNITS && !flags.sid) return;
      const planningAuthority = authority(caseRecord.PLANINGATY || planning.PlanningAuthority);
      const title = text(planning.DevelopmentAddress || caseRecord.DEVADDRESS || planning.DevelopmentDescription || caseRecord.DEVDESC || `ACP case ${ref}`);
      const base = {
        ref,
        planningRef: text(planning.ApplicationNumber),
        title: title.length > 160 ? `${title.slice(0, 157)}…` : title,
        authority: planningAuthority,
        units,
        applicant: applicant(planning),
        decision: text(caseRecord.DECISION || planning.AppealDecision || planning.Decision),
        category: category || "Planning appeal",
        planningUrl: planningUrl(planning),
        acpUrl: acpUrl(caseRecord),
        flags,
        isCork: planningAuthority === "Cork City Council"
      };
      if (isWithinWindow(caseRecord.LODGEDON)) events.push({ ...base, section: "acp-lodged", eventDate: caseRecord.LODGEDON, movement: "Planning appeal lodged" });
      if (isWithinWindow(caseRecord.DECIDED_ON)) events.push({ ...base, section: "acp-decided", eventDate: caseRecord.DECIDED_ON, movement: "Planning appeal decided" });
    });
    return events.sort((left, right) => right.units - left.units || (time(right.eventDate) || 0) - (time(left.eventDate) || 0));
  }

  async function loadAppeals() {
    const currentSignature = signature();
    if (!currentSignature || state.loading || currentSignature === state.loadedSignature) return;
    state.loading = true;
    state.warning = "";
    const controller = new AbortController();
    try {
      const refs = [...capturedCases.keys()];
      const rows = [];
      for (let index = 0; index < refs.length; index += 20) {
        const group = refs.slice(index, index + 20);
        const where = group.map(ref => `AppealRefNumber LIKE '%${escapeSql(ref)}%'`).join(" OR ");
        const results = await Promise.allSettled([
          queryArcgis(PLANNING_POINTS, where, controller.signal),
          queryArcgis(PLANNING_SITES, where, controller.signal),
          queryCork(group, controller.signal)
        ]);
        results.forEach((result, sourceIndex) => {
          if (result.status === "fulfilled") rows.push(...result.value);
          else if (sourceIndex === 2) state.warning = "Cork City direct appeal lookup was unavailable; national planning and ACP records were still used.";
        });
      }
      state.events = buildEvents(dedupePlanning(rows));
      state.loadedSignature = currentSignature;
      scheduleRender();
    } catch (error) {
      state.warning = `Appeal lookup could not be completed: ${error.message}`;
    } finally {
      state.loading = false;
      scheduleRender();
    }
  }

  function scheduleLoad() {
    setTimeout(loadAppeals, 0);
  }

  function currentFilters() {
    return {
      search: text($("#reportSearch")?.value).toUpperCase(),
      authority: $("#authorityFilterWeekly")?.value || "all",
      type: $("#typeFilterWeekly")?.value || "all"
    };
  }

  function matchesFilters(event, filters) {
    if (filters.authority !== "all" && event.authority !== filters.authority) return false;
    if (filters.type === "residential" && event.units < MIN_UNITS) return false;
    if (filters.type === "sid" && !event.flags.sid) return false;
    if (filters.type === "roads" && !event.flags.roads) return false;
    if (filters.type === "cpo-rail" && !event.flags.cpo) return false;
    if (filters.search) {
      const haystack = [event.title, event.ref, event.planningRef, event.authority, event.applicant, event.decision, event.category, event.movement].join(" ").toUpperCase();
      if (!haystack.includes(filters.search)) return false;
    }
    return true;
  }

  function ensureAuthorityOptions() {
    const select = $("#authorityFilterWeekly");
    if (!select) return;
    const authorities = [...new Set(state.events.map(event => event.authority).filter(Boolean))].sort();
    authorities.forEach(value => {
      if ([...select.options].some(option => option.value === value)) return;
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    });
  }

  function rowIdentity(section, ref) {
    return [...document.querySelectorAll(`#reportSections section[data-section="${section}"] tbody tr`)]
      .find(row => caseReference(row.querySelectorAll("td")[4]?.textContent) === ref);
  }

  function qualificationTags(event) {
    const tags = [];
    tags.push(event.flags.sid && event.units < MIN_UNITS ? "SID exception" : `${format(event.units)} residential units`);
    tags.push("Planning appeal");
    if (event.isCork) tags.push("Cork City Council");
    if (event.category && !/^planning appeal$/i.test(event.category)) tags.push(event.category);
    return tags;
  }

  function eventRowHtml(event, index) {
    const mainUrl = event.planningUrl || event.acpUrl;
    const project = mainUrl
      ? `<a class="project-link" href="${escapeHtml(mainUrl)}" target="_blank" rel="noopener">${escapeHtml(event.title)} ↗</a>`
      : `<strong>${escapeHtml(event.title)}</strong>`;
    const planningRef = event.planningRef
      ? event.planningUrl
        ? `<a class="record-link" href="${escapeHtml(event.planningUrl)}" target="_blank" rel="noopener">${escapeHtml(event.planningRef)} ↗</a>`
        : escapeHtml(event.planningRef)
      : "—";
    const acpRef = event.acpUrl
      ? `<a class="record-link" href="${escapeHtml(event.acpUrl)}" target="_blank" rel="noopener">${escapeHtml(event.ref)} ↗</a>`
      : escapeHtml(event.ref);
    return `<tr data-weekly-appeal-extra="1" data-appeal-ref="${escapeHtml(event.ref)}">
      <td class="rank">${index + 1}</td>
      <td class="project-title">${project}<small>${qualificationTags(event).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</small></td>
      <td><strong>${escapeHtml(event.movement)}</strong><small>${escapeHtml(date(event.eventDate))}</small></td>
      <td>${planningRef}</td>
      <td>${acpRef}</td>
      <td class="units">${event.units ? format(event.units) : "—"}</td>
      <td>${escapeHtml(event.authority)}</td>
      <td>${escapeHtml(event.applicant)}</td>
      <td>${escapeHtml(event.decision || "—")}</td>
    </tr>`;
  }

  function enrichExistingRow(row, event) {
    if (!row) return;
    row.dataset.appealRef = event.ref;
    const cells = row.querySelectorAll("td");
    const movement = cells[2]?.querySelector("strong");
    if (movement && movement.textContent !== event.movement) movement.textContent = event.movement;
    if (cells[6] && event.authority && text(cells[6].textContent) !== event.authority) cells[6].textContent = event.authority;
    const tagContainer = cells[1]?.querySelector("small");
    if (tagContainer) {
      const existing = new Set([...tagContainer.querySelectorAll(".tag")].map(tag => text(tag.textContent)));
      qualificationTags(event).forEach(label => {
        if (existing.has(label)) return;
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = label;
        tagContainer.append(tag);
      });
    }
  }

  function insertIntoMainSections(events) {
    ["acp-lodged", "acp-decided"].forEach(sectionKey => {
      const section = $(`#reportSections section[data-section="${sectionKey}"]`);
      if (!section) return;
      const sectionEvents = events.filter(event => event.section === sectionKey);
      sectionEvents.forEach(event => {
        const existing = rowIdentity(sectionKey, event.ref);
        if (existing) enrichExistingRow(existing, event);
      });
      const missing = sectionEvents.filter(event => !rowIdentity(sectionKey, event.ref));
      if (!missing.length) return;
      let table = section.querySelector("table.report-table");
      if (!table) {
        const wrap = section.querySelector(".table-wrap");
        if (!wrap) return;
        wrap.innerHTML = `<table class="report-table"><thead><tr><th>#</th><th>Project</th><th>Movement / date</th><th>Planning ref</th><th>ACP ref</th><th>Units ↓</th><th>Authority</th><th>Applicant</th><th>Decision</th></tr></thead><tbody></tbody></table>`;
        table = wrap.querySelector("table");
      }
      const tbody = table.querySelector("tbody");
      missing.forEach((event, index) => tbody.insertAdjacentHTML("beforeend", eventRowHtml(event, tbody.rows.length + index)));
      const count = section.querySelector(".section-head > strong");
      if (count) count.textContent = `${format(tbody.rows.length)} item${tbody.rows.length === 1 ? "" : "s"}`;
    });
  }

  function csvCell(value) {
    let output = String(value ?? "");
    if (/^[=+\-@]/.test(output)) output = `'${output}`;
    return `"${output.replaceAll('"', '""')}"`;
  }

  function downloadAppealsCsv(events) {
    if (!events.length) return;
    const rows = events.map(event => ({
      "Movement": event.movement,
      "Movement date": iso(event.eventDate),
      "Project": event.title,
      "ACP reference": event.ref,
      "Planning reference": event.planningRef,
      "Residential units": event.units || "",
      "Planning authority": event.authority,
      "Applicant": event.applicant,
      "Decision": event.decision,
      "ACP category": event.category,
      "Qualification": event.flags.sid && event.units < MIN_UNITS ? "SID exception" : "100+ residential units",
      "Planning URL": event.planningUrl,
      "ACP URL": event.acpUrl
    }));
    const headers = Object.keys(rows[0]);
    const csv = [headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `radharc-weekly-appeals-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function panelRow(event, index) {
    const project = event.planningUrl || event.acpUrl
      ? `<a class="project-link" href="${escapeHtml(event.planningUrl || event.acpUrl)}" target="_blank" rel="noopener">${escapeHtml(event.title)} ↗</a>`
      : `<strong>${escapeHtml(event.title)}</strong>`;
    const acpRef = event.acpUrl
      ? `<a class="record-link" href="${escapeHtml(event.acpUrl)}" target="_blank" rel="noopener">${escapeHtml(event.ref)} ↗</a>`
      : escapeHtml(event.ref);
    const planningRef = event.planningRef
      ? event.planningUrl
        ? `<a class="record-link" href="${escapeHtml(event.planningUrl)}" target="_blank" rel="noopener">${escapeHtml(event.planningRef)} ↗</a>`
        : escapeHtml(event.planningRef)
      : "—";
    return `<tr><td class="rank">${index + 1}</td><td class="project-title">${project}<small>${qualificationTags(event).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</small></td><td><strong>${escapeHtml(event.movement)}</strong><small>${escapeHtml(date(event.eventDate))}</small></td><td>${acpRef}</td><td>${planningRef}</td><td>${escapeHtml(event.category)}</td><td class="units">${event.units ? format(event.units) : "—"}</td><td>${escapeHtml(event.authority)}</td><td>${escapeHtml(event.decision || "—")}</td></tr>`;
  }

  function renderAppealPanel(events) {
    let panel = $(`#${PANEL_ID}`);
    if (!panel) {
      panel = document.createElement("section");
      panel.id = PANEL_ID;
      panel.className = "section";
      const acpPanel = $("#weeklyAcpPanel");
      const reportSections = $("#reportSections");
      if (acpPanel) acpPanel.before(panel);
      else reportSections?.before(panel);
    }
    const lodged = events.filter(event => event.section === "acp-lodged").length;
    const decided = events.filter(event => event.section === "acp-decided").length;
    const cork = events.filter(event => event.isCork).length;
    const uniqueCases = new Set(events.map(event => event.ref)).size;
    panel.innerHTML = `<header class="section-head"><div><h2>Planning appeals — ACP cases list</h2><p>Appeals lodged and decided in the previous 28 days, matched to qualifying 100+ unit planning schemes or SIDs. Cork City Council is included.</p></div><div class="acp-panel-actions"><strong>${format(uniqueCases)} case${uniqueCases === 1 ? "" : "s"}</strong><button id="exportWeeklyAppealsCsv" class="button" type="button" ${events.length ? "" : "disabled"}>Download appeals CSV</button></div></header><div class="acp-breakdown"><article><span>Appeals lodged</span><strong>${format(lodged)}</strong></article><article><span>Appeals decided</span><strong>${format(decided)}</strong></article><article><span>Cork City movements</span><strong>${format(cork)}</strong></article><article><span>Unique appeal cases</span><strong>${format(uniqueCases)}</strong></article><article><span>100+ unit movements</span><strong>${format(events.filter(event => event.units >= MIN_UNITS).length)}</strong></article><article><span>SID movements</span><strong>${format(events.filter(event => event.flags.sid).length)}</strong></article></div><div class="acp-panel-note">Source: An Coimisiún Pleanála Cases 2016 Onwards, matched to national planning layers and the Cork City Council planning datastore. ${escapeHtml(state.warning)}</div><div class="table-wrap">${events.length ? `<table class="report-table"><thead><tr><th>#</th><th>Project</th><th>Appeal movement / date</th><th>ACP ref</th><th>Planning ref</th><th>ACP category</th><th>Units</th><th>Authority</th><th>Decision</th></tr></thead><tbody>${events.map(panelRow).join("")}</tbody></table>` : '<div class="empty">No qualifying planning appeals under the current filters.</div>'}</div>`;
    $("#exportWeeklyAppealsCsv")?.addEventListener("click", () => downloadAppealsCsv(events), { once: true });
  }

  function render() {
    state.renderQueued = false;
    ensureAuthorityOptions();
    const filters = currentFilters();
    const events = state.events.filter(event => matchesFilters(event, filters));
    insertIntoMainSections(events);
    renderAppealPanel(events);
  }

  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(render);
  }

  function install() {
    const reportSections = $("#reportSections");
    if (reportSections) new MutationObserver(scheduleRender).observe(reportSections, { childList: true, subtree: false });
    ["#reportSearch", "#authorityFilterWeekly", "#typeFilterWeekly"].forEach(selector => {
      const node = $(selector);
      node?.addEventListener(selector === "#reportSearch" ? "input" : "change", scheduleRender);
    });
    scheduleRender();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
