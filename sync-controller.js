"use strict";

(function installSynchronizedDashboard() {
  let syncRun = 0;
  let updateTimer = null;
  let queuedWaiters = [];
  const queryCache = new Map();
  const queryInflight = new Map();
  const metadataCache = new Map();
  const DEFAULT_PERIOD = "365";
  const IRELAND_BOUNDS = [[51.35, -10.75], [55.55, -5.35]];
  const QUERY_TTL = 15000;
  const META_TTL = 300000;
  const MAX_CACHE_ITEMS = 350;

  function stableValue(value) {
    if (value == null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function requestKey(url, parameters) {
    const entries = Object.entries(parameters || {})
      .filter(([key]) => key !== "_ts" && key !== "cacheHint")
      .sort(([left], [right]) => left.localeCompare(right));
    return `${url}/query?${entries.map(([key, value]) => `${key}=${stableValue(value)}`).join("&")}`;
  }

  function trimCache(cache) {
    while (cache.size > MAX_CACHE_ITEMS) cache.delete(cache.keys().next().value);
  }

  async function postQuery(url, parameters = {}) {
    const body = new URLSearchParams();
    Object.entries({ f: "json", cacheHint: "true", ...parameters }).forEach(([key, value]) => {
      if (value == null) return;
      body.set(key, stableValue(value));
    });
    const response = await fetch(`${url}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
      cache: "no-store",
      credentials: "omit"
    });
    if (!response.ok) throw new Error(`ArcGIS HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) {
      const details = Array.isArray(data.error.details) ? data.error.details.filter(Boolean).join(" · ") : "";
      throw new Error([data.error.message, details].filter(Boolean).join(" · "));
    }
    return data;
  }

  q = async function cachedQuery(url, parameters = {}) {
    const key = requestKey(url, parameters);
    const now = Date.now();
    const cached = queryCache.get(key);
    if (cached && now - cached.time < QUERY_TTL) return cached.value;
    if (queryInflight.has(key)) return queryInflight.get(key);

    const request = postQuery(url, parameters)
      .then(value => {
        queryCache.set(key, { time: Date.now(), value });
        trimCache(queryCache);
        return value;
      })
      .finally(() => queryInflight.delete(key));
    queryInflight.set(key, request);
    return request;
  };

  const rawLayerInfo = layerInfo;
  layerInfo = async function cachedLayerInfo(url) {
    const cached = metadataCache.get(url);
    if (cached && Date.now() - cached.time < META_TTL) return cached.value;
    const value = await rawLayerInfo(url);
    metadataCache.set(url, { time: Date.now(), value });
    return value;
  };

  function clearDataCache() {
    queryCache.clear();
    queryInflight.clear();
    metadataCache.clear();
  }

  function selectedLayerKeys() {
    const inputs = [...document.querySelectorAll('#layerToggles input[data-k]')];
    if (inputs.length) return inputs.filter(input => input.checked && !input.disabled).map(input => input.dataset.k);
    return Object.keys(layers).filter(key => map.hasLayer(layers[key]));
  }

  function buildSnapshot() {
    const run = ++syncRun;
    const geometry = geom();
    const planningWhere = smartPlanningWhere();
    const acpWhere = smartAcpWhere();
    return {
      run,
      geometry,
      planningWhere,
      acpWhere,
      decisionWhere: smartPlanningWhere("decision"),
      authorityWhere: smartPlanningWhere("authority"),
      categoryWhere: smartAcpWhere("category"),
      summary: smartSummary(),
      selectedLayers: selectedLayerKeys(),
      zoom: map.getZoom(),
      residentialActive: Boolean(window.RadharcResidentialUnits?.isActive?.())
    };
  }

  function applySnapshotToLayers(snapshot) {
    layers.planningPoints?.setWhere(snapshot.planningWhere);
    layers.planningSites?.setWhere(snapshot.planningWhere);
    layers.acpCases?.setWhere(snapshot.acpWhere);
  }

  function setMetricText(selector, result) {
    const element = document.querySelector(selector);
    if (!element) return;
    element.textContent = result?.status === "fulfilled" ? fmt(result.value.count) : "Unavailable";
  }

  function renderChartResult(id, fallbackId, result, field, type, filterKey) {
    const fallback = document.querySelector(fallbackId);
    if (result?.status === "fulfilled") {
      smartDrawChart(id, result.value.features || [], field, type, filterKey);
      if (fallback) fallback.textContent = "";
      return;
    }
    charts[id]?.destroy();
    delete charts[id];
    if (fallback) fallback.textContent = "This chart could not be refreshed for the current filters.";
  }

  function refreshOptionResult(key, selector, result, field) {
    const select = document.querySelector(selector);
    if (!select) return;
    if (result?.status === "fulfilled") {
      smartSetOptions(select, result.value.features || [], field, smartState[key], key);
      return;
    }
    smartOptionData[key] = smartState[key].map(value => ({ value, label: smartFilterLabel(value), count: 0 }));
    smartRenderFilterTool(key);
  }

  function metricPair(results, pointKey, siteKey) {
    return smartBestMetric(results[pointKey], results[siteKey]);
  }

  function ensureLayerCoveragePanel() {
    let panel = document.querySelector("#layerCoveragePanel");
    if (panel) return panel;
    const note = document.querySelector(".data-quality-note");
    if (!note) return null;
    panel = document.createElement("section");
    panel.id = "layerCoveragePanel";
    panel.className = "panel-section layer-coverage-panel";
    panel.innerHTML = `
      <div class="section-title-row"><h2>Layer status</h2><span class="source-tag">One synced snapshot</span></div>
      <div id="layerCoverageRows" class="layer-coverage-rows"></div>
    `;
    note.after(panel);
    if (!document.querySelector("#layerCoverageStyles")) {
      const style = document.createElement("style");
      style.id = "layerCoverageStyles";
      style.textContent = `
        .layer-coverage-rows{display:grid;gap:7px}.layer-coverage-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;padding:8px;border:1px solid #dce5e9;border-radius:7px;background:#f8fbfb;font-size:11px}
        .layer-coverage-swatch{width:10px;height:10px;border-radius:50%}.layer-coverage-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.layer-coverage-value{font-weight:700;color:#315d61;text-align:right}.layer-coverage-row.is-off{opacity:.62}.layer-coverage-row.is-hidden{background:#fff8ed}
      `;
      document.head.append(style);
    }
    return panel;
  }

  function countLabel(result, fallback = "Unavailable") {
    if (!result) return fallback;
    if (result.status !== "fulfilled") return fallback;
    if (result.value?.skipped) return result.value.label || fallback;
    return fmt(result.value.count);
  }

  function updateLayerCoverage(snapshot, results) {
    ensureLayerCoveragePanel();
    const container = document.querySelector("#layerCoverageRows");
    if (!container) return;
    const selected = new Set(snapshot.selectedLayers);
    const rows = [
      { key: "planningPoints", result: results.planningCount },
      { key: "planningSites", result: results.planningSitesCount },
      { key: "acpCases", result: results.acpCount },
      { key: "freehold", result: results.freeholdCount }
    ];
    container.innerHTML = rows.map(({ key, result }) => {
      const isSelected = selected.has(key);
      const isHidden = snapshot.residentialActive && (key === "acpCases" || key === "freehold");
      const value = isHidden ? "Hidden by units filter" : countLabel(result, key === "freehold" ? "Zoom in" : "Unavailable");
      const state = isHidden ? "is-hidden" : isSelected ? "" : "is-off";
      const suffix = isSelected ? "selected" : "not selected";
      return `<div class="layer-coverage-row ${state}">
        <i class="layer-coverage-swatch" style="background:${esc(S[key].color)}"></i>
        <span class="layer-coverage-name" title="${esc(S[key].label)}">${esc(S[key].label)} · ${suffix}</span>
        <span class="layer-coverage-value">${esc(value)}</span>
      </div>`;
    }).join("");
  }

  function updateFreshness(snapshot, results) {
    const planningEdit = results.planningMeta?.status === "fulfilled" ? results.planningMeta.value.editingInfo?.dataLastEditDate : null;
    const acpEdit = results.acpMeta?.status === "fulfilled" ? results.acpMeta.value.editingInfo?.dataLastEditDate : null;
    const freshness = document.querySelector("#sourceFreshness");
    if (!freshness) return;
    freshness.textContent = [
      planningEdit ? `Planning feed edited ${dateTime(planningEdit)}` : "Planning feed edit date unavailable",
      acpEdit ? `ACP feed edited ${dateTime(acpEdit)}` : "ACP feed edit date unavailable",
      snapshot.summary
    ].join(" · ");
  }

  async function synchronizedUpdate() {
    const started = performance.now();
    const snapshot = buildSnapshot();
    smartState.sequence = snapshot.run;
    status("Synchronising dashboard");
    applySnapshotToLayers(snapshot);
    smartUpdateSummary();

    const freeholdJob = snapshot.residentialActive
      ? Promise.resolve({ skipped: true, label: "Hidden" })
      : snapshot.zoom >= 13
        ? q(S.freehold.url, { where: "1=1", returnCountOnly: true, ...snapshot.geometry })
        : Promise.resolve({ skipped: true, label: "Zoom in" });
    const emptyGroup = Promise.resolve({ features: [] });
    const acpCountJob = snapshot.residentialActive
      ? Promise.resolve({ count: 0 })
      : q(S.acpCases.url, { where: snapshot.acpWhere, returnCountOnly: true, ...snapshot.geometry });
    const categoryChartJob = snapshot.residentialActive
      ? emptyGroup
      : smartGrouped(S.acpCases.url, snapshot.acpWhere, "CATEGORY", snapshot.geometry);
    const categoryOptionsJob = snapshot.residentialActive
      ? emptyGroup
      : smartGrouped(S.acpCases.url, snapshot.categoryWhere, "CATEGORY", snapshot.geometry);

    const jobs = {
      planningCount: q(S.planningPoints.url, { where: snapshot.planningWhere, returnCountOnly: true, ...snapshot.geometry }),
      planningSitesCount: q(S.planningSites.url, { where: snapshot.planningWhere, returnCountOnly: true, ...snapshot.geometry }),
      acpCount: acpCountJob,
      freeholdCount: freeholdJob,
      decisionChart: smartGrouped(S.planningPoints.url, snapshot.planningWhere, "Decision", snapshot.geometry),
      authorityChart: smartGrouped(S.planningPoints.url, snapshot.planningWhere, "PlanningAuthority", snapshot.geometry),
      categoryChart: categoryChartJob,
      decisionOptions: smartGrouped(S.planningPoints.url, snapshot.decisionWhere, "Decision", snapshot.geometry),
      authorityOptions: smartGrouped(S.planningPoints.url, snapshot.authorityWhere, "PlanningAuthority", snapshot.geometry),
      categoryOptions: categoryOptionsJob,
      unitsPoint: smartMetric(S.planningPoints.url, "NumResidentialUnits", snapshot.planningWhere, snapshot.geometry),
      unitsSite: smartMetric(S.planningSites.url, "NumResidentialUnits", snapshot.planningWhere, snapshot.geometry),
      floorPoint: smartMetric(S.planningPoints.url, "FloorArea", snapshot.planningWhere, snapshot.geometry),
      floorSite: smartMetric(S.planningSites.url, "FloorArea", snapshot.planningWhere, snapshot.geometry),
      sitePoint: smartMetric(S.planningPoints.url, "AreaofSite", snapshot.planningWhere, snapshot.geometry),
      siteSite: smartMetric(S.planningSites.url, "AreaofSite", snapshot.planningWhere, snapshot.geometry),
      planningMeta: layerInfo(S.planningPoints.url),
      acpMeta: layerInfo(S.acpCases.url)
    };

    const names = Object.keys(jobs);
    const settled = await Promise.allSettled(Object.values(jobs));
    if (snapshot.run !== syncRun) return;
    const results = Object.fromEntries(names.map((name, index) => [name, settled[index]]));

    setMetricText("#planningCount", results.planningCount);
    setMetricText("#acpCount", results.acpCount);
    const parcel = document.querySelector("#parcelCount");
    if (parcel) {
      parcel.textContent = snapshot.residentialActive
        ? "Hidden"
        : results.freeholdCount?.status === "fulfilled" && !results.freeholdCount.value.skipped
          ? fmt(results.freeholdCount.value.count)
          : "Zoom in";
    }

    smartShowMetric("#unitCount", "#unitCoverage", metricPair(results, "unitsPoint", "unitsSite"), fmt, "Residential units");
    smartShowMetric("#floorAreaCount", "#floorCoverage", metricPair(results, "floorPoint", "floorSite"), smartWholeUp, "Floor area", "m²");
    smartShowMetric("#siteAreaCount", "#siteCoverage", metricPair(results, "sitePoint", "siteSite"), smartWholeUp, "Site area", "ha");

    renderChartResult("planningDecisionChart", "#planningDecisionFallback", results.decisionChart, "Decision", "doughnut", "decision");
    renderChartResult("authorityChart", "#authorityFallback", results.authorityChart, "PlanningAuthority", "bar", "authority");
    renderChartResult("acpCategoryChart", "#acpCategoryFallback", results.categoryChart, "CATEGORY", "doughnut", "category");
    refreshOptionResult("decision", "#decisionFilter", results.decisionOptions, "Decision");
    refreshOptionResult("authority", "#authorityFilter", results.authorityOptions, "PlanningAuthority");
    refreshOptionResult("category", "#categoryFilter", results.categoryOptions, "CATEGORY");
    updateLayerCoverage(snapshot, results);
    updateFreshness(snapshot, results);
    smartUpdateSummary();

    const elapsed = Math.max(0, performance.now() - started);
    const updated = document.querySelector("#dashboardUpdated");
    if (updated) {
      updated.textContent = `Synced ${new Date().toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ${(elapsed / 1000).toFixed(1)}s`;
    }
    const failedCount = settled.filter(result => result.status === "rejected").length;
    status(
      failedCount ? `Dashboard partly synced · ${failedCount} request${failedCount === 1 ? "" : "s"} failed` : "Dashboard fully synced",
      failedCount ? "error" : "ok"
    );
  }

  function queueUpdate({ immediate = false } = {}) {
    return new Promise((resolve, reject) => {
      queuedWaiters.push({ resolve, reject });
      clearTimeout(updateTimer);
      updateTimer = setTimeout(async () => {
        const waiters = queuedWaiters.splice(0);
        try {
          const value = await synchronizedUpdate();
          waiters.forEach(waiter => waiter.resolve(value));
        } catch (error) {
          status("Dashboard synchronisation failed", "error");
          waiters.forEach(waiter => waiter.reject(error));
        }
      }, immediate ? 0 : 90);
    });
  }

  function resetLayerVisibility() {
    Object.entries(S).forEach(([key, source]) => {
      const layer = layers[key];
      if (!layer) return;
      if (source.on && !map.hasLayer(layer)) layer.addTo(map);
      if (!source.on && map.hasLayer(layer)) map.removeLayer(layer);
      const checkbox = document.querySelector(`#layerToggles input[data-k="${key}"]`);
      if (checkbox) {
        checkbox.checked = source.on;
        checkbox.disabled = false;
      }
    });
  }

  async function resetDashboard() {
    const resetButton = document.querySelector("#resetDashboardButton");
    if (resetButton) {
      resetButton.disabled = true;
      resetButton.textContent = "Resetting…";
    }
    ++syncRun;
    clearTimeout(timer);
    clearTimeout(updateTimer);
    queuedWaiters.splice(0).forEach(waiter => waiter.resolve());
    clearDataCache();

    smartState.customDates = null;
    smartState.lastPreset = DEFAULT_PERIOD;
    smartState.decision = [];
    smartState.authority = [];
    smartState.category = [];
    smartState.residentialOnly = false;
    smartState.minUnits = null;
    delete smartState.maxUnits;
    window.RadharcResidentialUnits?.clearState?.();

    const dateRange = document.querySelector("#dateRange");
    const startDate = document.querySelector("#customStartDate");
    const endDate = document.querySelector("#customEndDate");
    const dateStatus = document.querySelector("#customDateStatus");
    const today = new Date().toLocaleDateString("en-CA");
    if (dateRange) dateRange.value = DEFAULT_PERIOD;
    if (startDate) { startDate.value = ""; startDate.max = today; }
    if (endDate) { endDate.value = ""; endDate.min = ""; endDate.max = today; }
    if (dateStatus) dateStatus.textContent = "Reset to Last 12 months.";

    ["decision", "authority", "category"].forEach(key => {
      if (smartTools[key]?.search) smartTools[key].search.value = "";
      smartSyncSelect(key);
    });
    smartUpdateSummary();

    const searchInput = document.querySelector("#searchInput");
    const searchResults = document.querySelector("#searchResults");
    const searchStatus = document.querySelector("#searchStatus");
    if (searchInput) searchInput.value = "";
    if (searchResults) searchResults.innerHTML = "";
    if (searchStatus) searchStatus.textContent = "Dashboard reset to Last 12 months. Press Search to list records.";

    selected = null;
    const selectedRecord = document.querySelector("#selectedRecord");
    const copyButton = document.querySelector("#copyBriefButton");
    if (selectedRecord) { selectedRecord.className = "empty-state"; selectedRecord.textContent = "Select a planning point, site, ACP case or parcel on the map."; }
    if (copyButton) { copyButton.disabled = true; copyButton.textContent = "Copy record brief"; }

    map.closePopup();
    resetLayerVisibility();
    map.fitBounds(IRELAND_BOUNDS, { padding: [18, 18], animate: false });
    await synchronizedUpdate();

    if (resetButton) { resetButton.disabled = false; resetButton.textContent = "Reset dashboard"; }
  }

  function bindControls() {
    const resetButton = document.querySelector("#resetDashboardButton");
    if (resetButton) resetButton.addEventListener("click", resetDashboard);
    document.querySelector("#refreshButton")?.addEventListener("click", clearDataCache, true);
    document.querySelector("#layerToggles")?.addEventListener("change", () => queueUpdate());
    ensureLayerCoveragePanel();
  }

  window.RadharcDashboard = {
    clearCache: clearDataCache,
    syncNow: () => queueUpdate({ immediate: true }),
    selectedLayerKeys
  };

  update = queueUpdate;
  document.addEventListener("DOMContentLoaded", bindControls);
})();
