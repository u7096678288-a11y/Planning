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
    "CSV/export core": () => Boolean(window.RadharcTools?.exportCsv || document.querySelector("#exportViewButton")),
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
    const mismatches = [];
    document.querySelectorAll('#layerToggles input[data-k]').forEach(input => {
      const key = input.dataset.k;
      const layer = layers[key];
      if (!layer) {
        mismatches.push(`${key}: layer missing`);
        return;
      }
      const expected = input.checked && !input.disabled;
      const visible = map.hasLayer(layer);
      if (expected === visible) return;
      mismatches.push(`${key}: checkbox/map mismatch corrected`);
      if (expected) layer.addTo(map);
      else map.removeLayer(layer);
    });
    return mismatches;
  }

  function reconcileLayerQueries() {
    const issues = [];
    const planningWhere = smartPlanningWhere();
    const acpWhere = smartAcpWhere();
    [["planningPoints", planningWhere], ["planningSites", planningWhere], ["acpCases", acpWhere]].forEach(([key, expected]) => {
      const layer = layers[key];
      if (!layer?.setWhere) return;
      const current = typeof layer.getWhere === "function" ? layer.getWhere() : null;
      if (current != null && String(current) !== String(expected)) issues.push(`${key}: query corrected`);
      layer.setWhere(expected);
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
    if (badge) {
      badge.textContent = report.ok ? "Integrity checked" : `${report.issues.length} sync issue${report.issues.length === 1 ? "" : "s"}`;
      badge.title = report.ok ? `Selected layers: ${report.selectedLayers.join(", ") || "none"}` : report.issues.join(" · ");
    }
  }

  async function check({ refresh = true } = {}) {
    if (running) return running;
    running = (async () => {
      const issues = [];
      const loader = window.RadharcModuleStatus || {};
      (loader.failed || []).forEach(item => issues.push(`Module failed: ${item}`));
      Object.entries(requiredModules).forEach(([label, test]) => {
        try {
          if (!test()) issues.push(`${label} unavailable`);
        } catch {
          issues.push(`${label} check failed`);
        }
      });
      issues.push(...reconcileLayerVisibility());
      issues.push(...reconcileLayerQueries());

      if (refresh && window.RadharcDashboard?.syncNow) {
        try {
          await window.RadharcDashboard.syncNow();
        } catch (error) {
          issues.push(`Dashboard refresh failed: ${error.message}`);
        }
      }

      latestReport = {
        ok: issues.length === 0,
        checkedAt: new Date(),
        selectedLayers: selectedKeys(),
        issues: [...new Set(issues)],
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
