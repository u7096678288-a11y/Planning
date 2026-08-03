"use strict";

(function installLeaderboardRecordView() {
  let installed = false;
  let observer = null;
  let applying = false;

  const el = selector => document.querySelector(selector);
  const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const safe = value => typeof esc === "function"
    ? esc(value)
    : String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

  function canonicalAuthority(value) {
    if (window.RadharcCrossLayerSync?.canonicalAuthority) return window.RadharcCrossLayerSync.canonicalAuthority(value) || "";
    if (window.CorkCityCKAN?.canonicalAuthority) return window.CorkCityCKAN.canonicalAuthority(value) || "";
    const authority = text(value);
    const upper = authority.toUpperCase();
    if (upper.includes("CORK CITY")) return "Cork City Council";
    if (upper.includes("CORK COUNTY")) return "Cork County Council";
    return authority;
  }

  function recordSource(record, layerKey = "") {
    if (layerKey === "corkCityDirect" || record?.DirectSource === "Cork City Council CKAN" || record?.__source === "cork") return "cork";
    if (layerKey === "planningSites" || record?.__source === "sites") return "planningSites";
    return "planningPoints";
  }

  function recordViewUrl(record, layerKey = "") {
    const reference = text(record?.ApplicationNumber);
    if (!reference) return "";
    const url = new URL("record-view.html", window.location.href);
    url.searchParams.set("source", recordSource(record, layerKey));
    url.searchParams.set("ref", reference);
    const authority = canonicalAuthority(record?.PlanningAuthority);
    if (authority) url.searchParams.set("authority", authority);
    return url.toString();
  }

  function authorityViewUrl(authority) {
    let url;
    try {
      url = new URL(window.RadharcTools?.buildShareUrl?.() || window.location.href);
    } catch {
      url = new URL(window.location.href);
    }
    const canonical = canonicalAuthority(authority);
    url.searchParams.set("view", "1");
    url.searchParams.delete("authority");
    url.searchParams.append("authority", canonical);
    url.searchParams.delete("bbox");
    url.searchParams.delete("search");
    url.searchParams.delete("category");
    url.searchParams.set("autosearch", "1");
    url.searchParams.set("layers", canonical === "Cork City Council"
      ? "planningPoints,planningSites,corkCityDirect"
      : "planningPoints,planningSites");
    return url.toString();
  }

  function link(label, url, className = "performance-record-link") {
    return url
      ? `<a class="${className}" href="${safe(url)}" target="_blank" rel="noopener noreferrer">${safe(label)} <span aria-hidden="true">↗</span></a>`
      : safe(label);
  }

  function appealUrl(recordOrReference) {
    return window.RadharcRecordLinks?.acpUrl?.(recordOrReference) || "";
  }

  function replacePlanningActions(layerKey, feature) {
    const record = feature?.properties || {};
    const type = window.RadharcSourceRegistry?.[layerKey]?.type || window.S?.[layerKey]?.type || (record.ABPCASEID ? "acp" : record.SP_ID ? "parcel" : "planning");
    if (type !== "planning") return;
    const links = [{ label: "View planning record", url: recordViewUrl(record, layerKey) }];
    const appeal = appealUrl(record.__acp || record.AppealRefNumber || record.AppealRefNum);
    if (appeal) links.push({ label: "Open ACP appeal case", url: appeal });
    const markup = window.RadharcRecordLinks?.actionsMarkup?.(links) || `<div class="record-link-actions">${links.map(item => link(item.label, item.url, "")).join("")}</div>`;

    const selected = el("#selectedRecord");
    if (selected) {
      selected.querySelectorAll(".record-link-actions").forEach(node => node.remove());
      selected.insertAdjacentHTML("beforeend", markup);
    }

    const popup = typeof map !== "undefined" ? map?._popup : null;
    if (popup) {
      const existing = String(popup.getContent?.() || "").replace(/<div class="record-link-actions[\s\S]*?<\/div>/g, "");
      popup.setContent(`${existing}${markup.replace('class="record-link-actions"', 'class="record-link-actions is-compact"')}`);
      popup.update?.();
    }
  }

  function patchSelection() {
    const original = typeof select === "function" ? select : window.select;
    if (typeof original !== "function" || original.__radharcRecordViewer) return;
    const wrapped = function recordViewerSelection(layerKey, feature, latlng) {
      const result = original.call(this, layerKey, feature, latlng);
      replacePlanningActions(layerKey, feature);
      return result;
    };
    wrapped.__radharcRecordViewer = true;
    wrapped.__original = original;
    try { select = wrapped; } catch {}
    try { window.select = wrapped; } catch {}
  }

  function planningLookup(records) {
    const lookup = new Map();
    (records || []).forEach(record => {
      const key = `${canonicalAuthority(record.PlanningAuthority).toUpperCase()}|${text(record.ApplicationNumber).toUpperCase()}`;
      if (text(record.ApplicationNumber)) lookup.set(key, record);
    });
    return lookup;
  }

  function sortOverallLeaderboard() {
    const rank = el("#performanceRank");
    const table = el("#performanceLeaderboard table");
    if (!rank || rank.value !== "overall" || !table?.tBodies?.[0]) return;
    const rows = [...table.tBodies[0].rows];
    rows.sort((left, right) => {
      const leftScore = Number.parseFloat(left.cells[2]?.textContent) || -Infinity;
      const rightScore = Number.parseFloat(right.cells[2]?.textContent) || -Infinity;
      return rightScore - leftScore;
    });
    rows.forEach((row, index) => {
      row.cells[0].textContent = String(index + 1);
      table.tBodies[0].append(row);
    });
    if (table.tHead?.rows?.[0]?.cells?.[2]) table.tHead.rows[0].cells[2].textContent = "Overall /100 ↓";
  }

  function linkLeaderboard() {
    const container = el("#performanceLeaderboard");
    if (!container) return;
    container.querySelectorAll("tbody tr").forEach(row => {
      if (row.cells.length < 2) return;
      const authority = text(row.cells[1].textContent).replace(/↗/g, "").trim();
      if (!authority) return;
      row.cells[1].innerHTML = link(authority, authorityViewUrl(authority));
      row.dataset.authorityRecordView = "true";
    });
  }

  function linkAppeals(analysis) {
    const container = el("#performanceAppeals");
    if (!container) return;
    const lookup = planningLookup(analysis?.planning);
    container.querySelectorAll("tbody tr").forEach(row => {
      if (row.cells.length < 5) return;
      const reference = text(row.cells[0].textContent).replace(/↗/g, "").trim();
      const authority = canonicalAuthority(row.cells[1].textContent);
      const record = lookup.get(`${authority.toUpperCase()}|${reference.toUpperCase()}`);
      if (!record) return;
      row.cells[0].innerHTML = link(reference, recordViewUrl(record));
      const appealReference = text(record.AppealRefNumber || record.AppealRefNum || record.__acp?.ABPCASEID || row.cells[4].textContent).replace(/↗/g, "").trim();
      const appeal = appealUrl(record.__acp || appealReference);
      if (appeal && appealReference && appealReference !== "—") row.cells[4].innerHTML = link(appealReference, appeal);
    });
  }

  function linkAcpCases(analysis) {
    const container = el("#performanceAcpCases");
    if (!container) return;
    const lookup = new Map((analysis?.acp || []).map(record => [text(record.ABPCASEID).toUpperCase(), record]));
    container.querySelectorAll("tbody tr").forEach(row => {
      if (!row.cells.length) return;
      const reference = text(row.cells[0].textContent).replace(/↗/g, "").trim();
      const record = lookup.get(reference.toUpperCase()) || { ABPCASEID: reference };
      row.cells[0].innerHTML = link(reference, appealUrl(record));
    });
  }

  function linkForecast() {
    const forecast = window.RadharcDecisionForecast?.getForecast?.();
    const container = el("#forecastTable");
    if (!forecast || !container) return;
    const lookup = planningLookup(forecast.records);
    container.querySelectorAll("tbody tr").forEach(row => {
      if (row.cells.length < 2) return;
      const reference = text(row.cells[0].textContent).replace(/↗/g, "").trim();
      const authority = canonicalAuthority(row.cells[1].textContent);
      const record = lookup.get(`${authority.toUpperCase()}|${reference.toUpperCase()}`);
      if (record) row.cells[0].innerHTML = link(reference, recordViewUrl(record));
    });
  }

  function clarifyRankControl() {
    const rank = el("#performanceRank");
    if (!rank) return;
    const overall = rank.querySelector('option[value="overall"]');
    if (overall) overall.textContent = "Overall performance — highest first";
    const grants = rank.querySelector('option[value="grantUnits"]');
    if (grants) grants.textContent = "Most units granted — highest first";
    const appeals = rank.querySelector('option[value="appealUnits"]');
    if (appeals) appeals.textContent = "Most units appealed — highest first";
    const speed = rank.querySelector('option[value="speed"]');
    if (speed) speed.textContent = "Fastest median decision — lowest days";
    const refusal = rank.querySelector('option[value="refusalRate"]');
    if (refusal) refusal.textContent = "Lowest refusal rate";
    const acp = rank.querySelector('option[value="acpSpeed"]');
    if (acp) acp.textContent = "Fastest ACP cases — lowest days";
    if (overall && !rank.dataset.radharcDefaultSet) {
      rank.dataset.radharcDefaultSet = "true";
      rank.value = "overall";
    }
  }

  function applyPerformanceChanges() {
    if (applying) return;
    const analysis = window.RadharcPerformance?.getAnalysis?.();
    if (!el("#performanceDialog")) return;
    applying = true;
    try {
      clarifyRankControl();
      sortOverallLeaderboard();
      linkLeaderboard();
      if (analysis) {
        linkAppeals(analysis);
        linkAcpCases(analysis);
      }
      linkForecast();
    } finally {
      applying = false;
    }
  }

  function observePerformance() {
    const dialog = el("#performanceDialog");
    if (!dialog || observer) return;
    observer = new MutationObserver(() => window.setTimeout(applyPerformanceChanges, 0));
    observer.observe(dialog, { childList: true, subtree: true });
    ["#performanceRank", "#performanceMinSample", "#forecastView", "#forecastSearch"].forEach(selector => {
      el(selector)?.addEventListener("change", () => window.setTimeout(applyPerformanceChanges, 0));
    });
  }

  function autoSearchAuthorityView() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("autosearch") !== "1" || !params.getAll("authority").length) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const expected = params.getAll("authority").map(canonicalAuthority);
      const current = Array.isArray(window.smartState?.authority) ? window.smartState.authority.map(canonicalAuthority) : [];
      const ready = expected.every(value => current.includes(value)) && el("#searchForm");
      if (ready || attempts > 80) {
        window.clearInterval(timer);
        if (ready) {
          window.setTimeout(() => {
            el("#searchForm")?.requestSubmit?.();
            el("#searchResults")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
          }, 450);
        }
      }
    }, 100);
  }

  function install() {
    if (installed) return;
    installed = true;
    patchSelection();
    if (window.RadharcRecordLinks) {
      window.RadharcRecordLinks.planningUrl = recordViewUrl;
      window.RadharcRecordLinks.planningSourceUrl = recordViewUrl;
      window.RadharcRecordLinks.authorityUrl = authorityViewUrl;
    }
    observePerformance();
    applyPerformanceChanges();
    autoSearchAuthorityView();
    document.addEventListener("click", event => {
      if (event.target.closest("#performanceButton")) {
        window.setTimeout(() => {
          observePerformance();
          applyPerformanceChanges();
        }, 100);
      }
    }, true);
  }

  window.RadharcPlanningRecordView = {
    recordUrl: recordViewUrl,
    authorityUrl: authorityViewUrl,
    refresh: applyPerformanceChanges
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
