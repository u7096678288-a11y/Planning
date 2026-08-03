"use strict";

(function installSyncHealthAudit() {
  let latestReport = null;
  let running = null;

  const requiredModules = {
    "Residential filter": () => Boolean(window.RadharcResidentialUnits),
    "Cross-layer synchronisation": () => Boolean(window.RadharcCrossLayerSync),
    "Dashboard controller": () => Boolean(window.RadharcDashboard?.syncNow),
    "Layer-aware queries": () => Boolean(window.RadharcSelectedLayerQueries),
    "Search": () => Boolean(window.RadharcAuthoritySearch || window.RadharcLayerSearch),
    "CSV/export core": () => Boolean(window.RadharcTools || document.querySelector("#exportViewButton")),
    "Map export": () => Boolean(document.querySelector("#shareViewButton")),
    "Workbook export": () => Boolean(window.RadharcWorkbookExport || document.querySelector("#exportWorkbookButton")),
    "Performance": () => Boolean(window.RadharcPerformanceLauncher),
    "Forecast": () => Boolean(window.RadharcDecisionForecast),
    "Planning record viewer": () => Boolean(window.RadharcPlanningRecordView)
  };

  function selectedKeys() {
    return [...document.querySelectorAll('#layerToggles input[data-k]')]
      .filter(input => input.checked && !input.disabled)
      .map(input => input.dataset.k);
  }

  function reconcileLayerVisibility() {
    const corrections = [];
    document.querySelectorAll('#layerToggles input[data-k]').forEach(input => {
      const key = input.dataset.k;
      const layer = layers[key];
      if (!layer) return;
      const expected = input.checked && !input.disabled;
      const visible = map.hasLayer(layer);
      if (expected === visible) return;
      corrections.push(`${key}: checkbox/map visibility reconciled`);
      if (expected) layer.addTo(map);
      else map.removeLayer(layer);
    });
    return corrections;
  }

  function reconcileLayerQueries() {
    const corrections = [];
    const planningWhere = smartPlanningWhere();
    const acpWhere = smartAcpWhere();
    [["planningPoints", planningWhere], ["planningSites", planningWhere], ["acpCases", acpWhere]].forEach(([key, expected]) => {
      const layer = layers[key];
      if (!layer?.setWhere) return;
      const current = typeof layer.getWhere === "function" ? layer.getWhere() : null;
      if (current != null && String(current) !== String(expected)) corrections.push(`${key}: active query reconciled`);
      layer.setWhere(expected);
    });
    return corrections;
  }

  function unresolvedLayerIssues() {
    const issues = [];
    document.querySelectorAll('#layerToggles input[data-k]').forEach(input => {
      const key = input.dataset.k;
      const layer = layers[key];
      if (!layer) {
        issues.push(`${key}: layer missing`);
        return;
      }
      const expected = input.checked && !input.disabled;
      if (map.hasLayer(layer) !== expected) issues.push(`${key}: checkbox and map remain inconsistent`);
    });
    return issues;
  }

  function unresolvedQueryIssues() {
    const issues = [];
    const planningWhere = smartPlanningWhere();
    const acpWhere = smartAcpWhere();
    [["planningPoints", planningWhere], ["planningSites", planningWhere], ["acpCases", acpWhere]].forEach(([key, expected]) => {
      const layer = layers[key];
      if (typeof layer?.getWhere !== "function") return;
      if (String(layer.getWhere()) !== String(expected)) issues.push(`${key}: active query remains inconsistent`);
    });
    return issues;
  }

  function ensureBadge() {
    const heading = document.querySelector("#layerCoveragePanel .section-title-row");
    if (!heading) return null;
    let badge = document.querySelector("#syncIntegrityStatus");
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "syncIntegrityStatus";
      badge.className = "source-tag";
      heading.append(badge);
    }
    return badge;
  }

  function render(report) {
    const badge = ensureBadge();
    if (!badge) return;
    badge.textContent = report.ok ? "Integrity checked" : `${report.issues.length} sync issue${report.issues.length === 1 ? "" : "s"}`;
    const details = report.ok
      ? [`Selected layers: ${report.selectedLayers.join(", ") || "none"}`, ...report.corrections]
      : report.issues;
    badge.title = details.join(" · ");
  }

  async function check({ refresh = true } = {}) {
    if (running) return running;
    running = (async () => {
      const issues = [];
      const corrections = [];
      const loader = window.RadharcModuleStatus || {};
      (loader.failed || []).forEach(item => issues.push(`Module failed: ${item}`));
      Object.entries(requiredModules).forEach(([label, test]) => {
        try {
          if (!test()) issues.push(`${label} unavailable`);
        } catch {
          issues.push(`${label} check failed`);
        }
      });

      corrections.push(...reconcileLayerVisibility(), ...reconcileLayerQueries());

      if (refresh && window.RadharcDashboard?.syncNow) {
        try {
          await window.RadharcDashboard.syncNow();
        } catch (error) {
          issues.push(`Dashboard refresh failed: ${error.message}`);
        }
      }

      issues.push(...unresolvedLayerIssues(), ...unresolvedQueryIssues());
      latestReport = {
        ok: issues.length === 0,
        checkedAt: new Date(),
        selectedLayers: selectedKeys(),
        issues: [...new Set(issues)],
        corrections: [...new Set(corrections)],
        modules: {
          loaded: [...(loader.loaded || [])],
          failed: [...(loader.failed || [])],
          skipped: [...(loader.skipped || [])]
        }
      };
      render(latestReport);
      return latestReport;
    })().finally(() => { running = null; });
    return running;
  }

  window.RadharcSyncHealth = {
    check,
    report: () => latestReport
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(() => check({ refresh: true }), 0), { once: true });
  } else {
    setTimeout(() => check({ refresh: true }), 0);
  }
})();
