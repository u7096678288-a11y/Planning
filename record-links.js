"use strict";

(function installRecordLinks() {
  const CORK_RESOURCE_ID = "8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";
  const CORK_API = "https://data.corkcity.ie/api/3/action/datastore_search_sql";
  const ACP_CASE_BASE = "https://www.pleanala.ie/en-ie/case/";
  let performanceObserver = null;
  let applyingPerformanceLinks = false;

  const el = selector => document.querySelector(selector);
  const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const safe = value => typeof esc === "function"
    ? esc(value)
    : String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

  function cleanUrl(value, base = document.baseURI) {
    const raw = text(value).replaceAll("&amp;", "&");
    if (!raw) return "";
    try {
      const url = new URL(raw, base);
      return /^https?:$/.test(url.protocol) ? url.toString() : "";
    } catch {
      return "";
    }
  }

  function sql(value) {
    return text(value).replaceAll("'", "''");
  }

  function canonicalAuthority(value) {
    if (window.RadharcCrossLayerSync?.canonicalAuthority) return window.RadharcCrossLayerSync.canonicalAuthority(value) || "";
    if (window.CorkCityCKAN?.canonicalAuthority) return window.CorkCityCKAN.canonicalAuthority(value) || "";
    const authority = text(value);
    const upper = authority.toUpperCase();
    if (upper.includes("CORK CITY")) return "Cork City Council";
    if (upper.includes("CORK COUNTY")) return "Cork County Council";
    return authority;
  }

  function directPlanningUrl(record) {
    const candidates = [
      record?.LinkAppDetails,
      record?.LINKAPPDETAILS,
      record?.LinkApplicationDetails,
      record?.PlanningApplicationURL,
      record?.ApplicationURL,
      record?.URL
    ];
    for (const candidate of candidates) {
      const url = cleanUrl(candidate, record?.DirectSource === "Cork City Council CKAN" ? "https://data.corkcity.ie/" : document.baseURI);
      if (url) return url;
    }
    return "";
  }

  function sourceLayerUrl(record, layerKey = "") {
    if (record?.DirectSource === "Cork City Council CKAN" || record?.__source === "cork" || canonicalAuthority(record?.PlanningAuthority) === "Cork City Council" && record?.SourceLongitude != null) {
      return "cork";
    }
    if (layerKey === "planningSites" || record?.__source === "sites") return window.S?.planningSites?.url || "";
    return window.S?.planningPoints?.url || "";
  }

  function planningSourceUrl(record, layerKey = "") {
    const reference = text(record?.ApplicationNumber);
    const authority = canonicalAuthority(record?.PlanningAuthority);
    if (!reference) return "";
    const source = sourceLayerUrl(record, layerKey);
    if (source === "cork") {
      const query = `SELECT * FROM "${CORK_RESOURCE_ID}" WHERE CAST("ApplicationNumber" AS text) = '${sql(reference)}'`;
      const url = new URL(CORK_API);
      url.searchParams.set("sql", query);
      return url.toString();
    }
    if (!source) return "";
    const clauses = [`ApplicationNumber = '${sql(reference)}'`];
    if (authority) clauses.push(`PlanningAuthority = '${sql(authority)}'`);
    const url = new URL(`${source}/query`);
    url.searchParams.set("where", clauses.join(" AND "));
    url.searchParams.set("outFields", "*");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("f", "pjson");
    return url.toString();
  }

  function planningUrl(record, layerKey = "") {
    return directPlanningUrl(record) || planningSourceUrl(record, layerKey);
  }

  function caseDigits(value) {
    const raw = text(value).toUpperCase();
    const matches = raw.match(/\d{6}/g);
    if (matches?.length) return matches[matches.length - 1];
    const digits = raw.replace(/\D/g, "");
    return digits.length >= 6 ? digits.slice(-6) : "";
  }

  function acpUrl(recordOrReference) {
    const record = typeof recordOrReference === "object" && recordOrReference !== null ? recordOrReference : {};
    const supplied = cleanUrl(record.LINKABPWEB || record.LinkABPWeb || record.ACPURL || record.URL, "https://www.pleanala.ie/");
    if (supplied) return supplied;
    const reference = typeof recordOrReference === "object"
      ? record.ABPCASEID || record.AppealRefNumber || record.AppealRefNum || record.__acp?.ABPCASEID
      : recordOrReference;
    const digits = caseDigits(reference);
    return digits ? `${ACP_CASE_BASE}${digits}` : "";
  }

  function parcelUrl(record) {
    const source = window.S?.freehold?.url;
    if (!source) return "";
    const objectId = record?.OBJECTID ?? record?.ObjectId;
    const parcel = text(record?.SP_ID);
    const where = objectId != null ? `OBJECTID = ${Number(objectId)}` : parcel ? `SP_ID = '${sql(parcel)}'` : "";
    if (!where) return source;
    const url = new URL(`${source}/query`);
    url.searchParams.set("where", where);
    url.searchParams.set("outFields", "*");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("f", "pjson");
    return url.toString();
  }

  function authorityUrl(authority) {
    const source = window.S?.planningPoints?.url;
    if (!source || !text(authority)) return "";
    const url = new URL(`${source}/query`);
    const canonical = canonicalAuthority(authority);
    const where = canonical === "Cork City Council"
      ? "UPPER(PlanningAuthority) LIKE 'CORK CITY%'"
      : canonical === "Cork County Council"
        ? "UPPER(PlanningAuthority) LIKE 'CORK COUNTY%'"
        : `PlanningAuthority = '${sql(canonical)}'`;
    url.searchParams.set("where", where);
    url.searchParams.set("outFields", "*");
    url.searchParams.set("returnGeometry", "false");
    url.searchParams.set("f", "pjson");
    return url.toString();
  }

  function recordLinks(layerKey, record) {
    const type = window.S?.[layerKey]?.type || (record?.ABPCASEID ? "acp" : record?.SP_ID ? "parcel" : "planning");
    const links = [];
    if (type === "planning") {
      const application = planningUrl(record, layerKey);
      if (application) links.push({ label: directPlanningUrl(record) ? "Open application details" : "Open planning source record", url: application });
      const appeal = acpUrl(record?.__acp || record?.AppealRefNumber || record?.AppealRefNum);
      if (appeal) links.push({ label: "Open ACP appeal case", url: appeal });
    } else if (type === "acp") {
      const caseUrl = acpUrl(record);
      if (caseUrl) links.push({ label: "Open ACP case", url: caseUrl });
    } else if (type === "parcel") {
      const sourceUrl = parcelUrl(record);
      if (sourceUrl) links.push({ label: "Open parcel source record", url: sourceUrl });
    }
    return links.filter((item, index, list) => item.url && list.findIndex(other => other.url === item.url) === index);
  }

  function linkActionsMarkup(links, compact = false) {
    if (!links.length) return "";
    return `<div class="record-link-actions${compact ? " is-compact" : ""}">${links.map(link => `<a href="${safe(link.url)}" target="_blank" rel="noopener noreferrer">${safe(link.label)} <span aria-hidden="true">↗</span></a>`).join("")}</div>`;
  }

  function injectStyles() {
    if (el("#recordLinkStyles")) return;
    const style = document.createElement("style");
    style.id = "recordLinkStyles";
    style.textContent = `
      .record-link-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:10px;padding-top:9px;border-top:1px solid #dbe5e9}.record-link-actions a{display:inline-flex;align-items:center;gap:4px;padding:6px 8px;border:1px solid #b9cbd2;border-radius:6px;background:#fff;color:#0e5970;font-size:10px;font-weight:700;text-decoration:none}.record-link-actions a:hover,.record-link-actions a:focus{border-color:#4b8792;background:#edf6f7;outline:none}.record-link-actions.is-compact{margin-top:7px;padding-top:7px}.record-link-actions.is-compact a{padding:4px 6px;font-size:9px}.performance-record-link{color:#0b6178;font-weight:700;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}.performance-record-link:hover,.performance-record-link:focus{color:#083f50}.performance-record-link span{font-size:9px;text-decoration:none}.leaflet-popup-content .record-link-actions{max-width:270px}
    `;
    document.head.append(style);
  }

  function patchMapSelection() {
    const original = typeof window.select === "function" ? window.select : (typeof select === "function" ? select : null);
    if (!original || original.__radharcRecordLinks) return;
    const linkedSelect = function linkedRecordSelection(layerKey, feature, latlng) {
      const result = original.call(this, layerKey, feature, latlng);
      const record = feature?.properties || {};
      const links = recordLinks(layerKey, record);
      if (!links.length) return result;

      const selectedRecord = el("#selectedRecord");
      if (selectedRecord) selectedRecord.insertAdjacentHTML("beforeend", linkActionsMarkup(links));

      const popup = typeof map !== "undefined" ? map?._popup : null;
      if (popup) {
        const existing = typeof popup.getContent === "function" ? popup.getContent() : "";
        popup.setContent(`${existing}${linkActionsMarkup(links, true)}`);
        popup.update?.();
      }
      return result;
    };
    linkedSelect.__radharcRecordLinks = true;
    linkedSelect.__original = original;
    try { window.select = linkedSelect; } catch {}
    try { select = linkedSelect; } catch {}
  }

  function anchorMarkup(label, url) {
    return url ? `<a class="performance-record-link" href="${safe(url)}" target="_blank" rel="noopener noreferrer">${safe(label)} <span aria-hidden="true">↗</span></a>` : safe(label);
  }

  function planningLookup(records) {
    const lookup = new Map();
    (records || []).forEach(record => {
      const key = `${canonicalAuthority(record.PlanningAuthority).toUpperCase()}|${text(record.ApplicationNumber).toUpperCase()}`;
      if (text(record.ApplicationNumber)) lookup.set(key, record);
    });
    return lookup;
  }

  function linkAppealTable(analysis) {
    const container = el("#performanceAppeals");
    if (!container) return;
    const lookup = planningLookup(analysis?.planning);
    container.querySelectorAll("tbody tr").forEach(row => {
      const cells = row.cells;
      if (cells.length < 5 || row.dataset.recordLinks === "true") return;
      const reference = text(cells[0].textContent).replace(/↗/g, "").trim();
      const authority = canonicalAuthority(cells[1].textContent);
      const record = lookup.get(`${authority.toUpperCase()}|${reference.toUpperCase()}`);
      if (!record) return;
      const application = planningUrl(record);
      if (application) cells[0].innerHTML = anchorMarkup(reference, application);
      const appealReference = text(record.AppealRefNumber || record.AppealRefNum || record.__acp?.ABPCASEID || cells[4].textContent);
      const appeal = acpUrl(record.__acp || appealReference);
      if (appeal && appealReference && appealReference !== "—") cells[4].innerHTML = anchorMarkup(appealReference, appeal);
      row.dataset.recordLinks = "true";
    });
  }

  function linkAcpTable(analysis) {
    const container = el("#performanceAcpCases");
    if (!container) return;
    const lookup = new Map((analysis?.acp || []).map(record => [text(record.ABPCASEID).toUpperCase(), record]));
    container.querySelectorAll("tbody tr").forEach(row => {
      if (row.dataset.recordLinks === "true" || !row.cells.length) return;
      const reference = text(row.cells[0].textContent).replace(/↗/g, "").trim();
      const record = lookup.get(reference.toUpperCase()) || { ABPCASEID: reference };
      const url = acpUrl(record);
      if (url) row.cells[0].innerHTML = anchorMarkup(reference, url);
      row.dataset.recordLinks = "true";
    });
  }

  function linkLeaderboard() {
    const container = el("#performanceLeaderboard");
    if (!container) return;
    container.querySelectorAll("tbody tr").forEach(row => {
      if (row.dataset.authorityLink === "true" || row.cells.length < 2) return;
      const authority = text(row.cells[1].textContent).replace(/↗/g, "").trim();
      const url = authorityUrl(authority);
      if (url) row.cells[1].innerHTML = anchorMarkup(authority, url);
      row.dataset.authorityLink = "true";
    });
  }

  function applyPerformanceLinks() {
    if (applyingPerformanceLinks) return;
    const analysis = window.RadharcPerformance?.getAnalysis?.();
    if (!analysis) return;
    applyingPerformanceLinks = true;
    try {
      linkLeaderboard();
      linkAppealTable(analysis);
      linkAcpTable(analysis);
    } finally {
      applyingPerformanceLinks = false;
    }
  }

  function observePerformance() {
    const dialog = el("#performanceDialog");
    if (!dialog || performanceObserver) return;
    performanceObserver = new MutationObserver(() => window.setTimeout(applyPerformanceLinks, 0));
    performanceObserver.observe(dialog, { childList: true, subtree: true });
    dialog.addEventListener("click", () => window.setTimeout(applyPerformanceLinks, 0));
    window.setTimeout(applyPerformanceLinks, 0);
  }

  function waitForPerformance(attempt = 0) {
    observePerformance();
    applyPerformanceLinks();
    if ((el("#performanceDialog") && window.RadharcPerformance) || attempt >= 600) return;
    window.setTimeout(() => waitForPerformance(attempt + 1), 50);
  }

  function start() {
    injectStyles();
    patchMapSelection();
    observePerformance();
    document.addEventListener("click", event => {
      if (event.target.closest("#performanceButton")) waitForPerformance();
    }, true);
  }

  window.RadharcRecordLinks = {
    cleanUrl,
    planningUrl,
    planningSourceUrl,
    acpUrl,
    parcelUrl,
    authorityUrl,
    recordLinks,
    actionsMarkup: linkActionsMarkup,
    refreshPerformance: applyPerformanceLinks
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();