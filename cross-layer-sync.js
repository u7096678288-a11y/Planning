"use strict";

(function installCrossLayerSync() {
  let runId = 0;
  let refreshTimer = null;
  const CORK_CITY = "Cork City Council";
  const CORK_COUNTY = "Cork County Council";

  function canonicalAuthority(value) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    const upper = text.toUpperCase();
    if (upper.includes("CORK CITY")) return CORK_CITY;
    if (upper.includes("CORK COUNTY")) return CORK_COUNTY;
    return text;
  }

  function canonicalValue(field, value) {
    if (value == null || value === "") return null;
    if (field === "PlanningAuthority") return canonicalAuthority(value);
    return String(value).replace(/\s+/g, " ").trim();
  }

  const priorTextClause = smartTextClause;
  smartTextClause = function crossLayerTextClause(field, value) {
    if (field === "PlanningAuthority" && value && value !== smartNull) {
      const authority = canonicalAuthority(value);
      if (authority === CORK_CITY) return "UPPER(PlanningAuthority) LIKE 'CORK CITY COUNCIL%'";
      if (authority === CORK_COUNTY) return "UPPER(PlanningAuthority) LIKE 'CORK COUNTY COUNCIL%'";
    }
    return priorTextClause(field, value);
  };

  function selectedLayerKeys() {
    const inputs = [...document.querySelectorAll('#layerToggles input[data-k]')];
    if (inputs.length) return inputs.filter(input => input.checked).map(input => input.dataset.k);
    return Object.keys(layers).filter(key => map.hasLayer(layers[key]));
  }

  function settledValue(result, fallback) {
    return result?.status === "fulfilled" ? result.value : fallback;
  }

  function mergeGrouped(leftResult, rightResult, field) {
    const left = settledValue(leftResult, { features: [] });
    const right = settledValue(rightResult, { features: [] });
    const values = new Map();
    [...(left.features || []), ...(right.features || [])].forEach(feature => {
      const attributes = feature.attributes || {};
      const raw = attributes[field];
      const canonical = canonicalValue(field, raw);
      const key = canonical == null ? smartNull : canonical;
      const count = Number(attributes.n) || 0;
      const previous = values.get(key);
      if (!previous || count > previous.count) values.set(key, { count, value: canonical });
    });
    return {
      features: [...values.values()]
        .sort((a, b) => b.count - a.count || String(a.value || "").localeCompare(String(b.value || "")))
        .map(item => ({ attributes: { [field]: item.value, n: item.count } }))
    };
  }

  function mergeSettled(left, right, field) {
    if (left?.status !== "fulfilled" && right?.status !== "fulfilled") {
      return { status: "rejected", reason: left?.reason || right?.reason || new Error("Both planning layers failed") };
    }
    return { status: "fulfilled", value: mergeGrouped(left, right, field) };
  }

  function countFrom(result) {
    return result?.status === "fulfilled" ? Number(result.value.count) || 0 : null;
  }

  function bestPlanningCount(pointResult, siteResult) {
    const counts = [countFrom(pointResult), countFrom(siteResult)].filter(value => value != null);
    return counts.length ? Math.max(...counts) : null;
  }

  function setCount(selector, value) {
    const element = document.querySelector(selector);
    if (element) element.textContent = value == null ? "Unavailable" : fmt(value);
  }

  function renderChart(id, fallbackSelector, result, field, type, filterKey) {
    const fallback = document.querySelector(fallbackSelector);
    if (result.status === "fulfilled") {
      smartDrawChart(id, result.value.features || [], field, type, filterKey);
      if (fallback) fallback.textContent = "";
    } else {
      charts[id]?.destroy();
      delete charts[id];
      if (fallback) fallback.textContent = "This chart could not be refreshed for the current filters.";
    }
  }

  function renderOptions(key, selector, result, field) {
    const select = document.querySelector(selector);
    if (!select) return;
    if (result.status === "fulfilled") {
      smartSetOptions(select, result.value.features || [], field, smartState[key], key);
    } else {
      smartOptionData[key] = smartState[key].map(value => ({ value, label: smartFilterLabel(value), count: 0 }));
      smartRenderFilterTool(key);
    }
  }

  function metricPair(results, pointKey, siteKey) {
    return smartBestMetric(results[pointKey], results[siteKey]);
  }

  function updateLayerStatus(snapshot, results) {
    const container = document.querySelector("#layerCoverageRows");
    if (!container) return;
    const selected = new Set(snapshot.selectedLayers);
    const rows = [
      ["planningPoints", results.planningPointsCount],
      ["planningSites", results.planningSitesCount],
      ["acpCases", results.acpCount],
      ["freehold", results.freeholdCount]
    ];
    container.innerHTML = rows.map(([key, result]) => {
      const isSelected = selected.has(key);
      let value = "Unavailable";
      if (result?.status === "fulfilled") {
        value = result.value?.skipped ? result.value.label : fmt(result.value.count);
      }
      return `<div class="layer-coverage-row ${isSelected ? "" : "is-off"}">
        <i class="layer-coverage-swatch" style="background:${esc(S[key].color)}"></i>
        <span class="layer-coverage-name" title="${esc(S[key].label)}">${esc(S[key].label)} · ${isSelected ? "selected" : "not selected"}</span>
        <span class="layer-coverage-value">${esc(value)}</span>
      </div>`;
    }).join("");
  }

  function updateFreshness(summary, results) {
    const planningEdit = results.planningMeta?.status === "fulfilled" ? results.planningMeta.value.editingInfo?.dataLastEditDate : null;
    const acpEdit = results.acpMeta?.status === "fulfilled" ? results.acpMeta.value.editingInfo?.dataLastEditDate : null;
    const element = document.querySelector("#sourceFreshness");
    if (!element) return;
    element.textContent = [
      planningEdit ? `Planning feed edited ${dateTime(planningEdit)}` : "Planning feed edit date unavailable",
      acpEdit ? `ACP feed edited ${dateTime(acpEdit)}` : "ACP feed edit date unavailable",
      summary
    ].join(" · ");
  }

  async function synchronizeNow() {
    const currentRun = ++runId;
    const started = performance.now();
    const geometry = geom();
    const planningWhere = smartPlanningWhere();
    const decisionWhere = smartPlanningWhere("decision");
    const authorityWhere = smartPlanningWhere("authority");
    const acpWhere = smartAcpWhere();
    const categoryWhere = smartAcpWhere("category");
    const summary = smartSummary();
    const selectedLayers = selectedLayerKeys();
    const zoom = map.getZoom();

    status("Synchronising all selected layers");
    layers.planningPoints?.setWhere(planningWhere);
    layers.planningSites?.setWhere(planningWhere);
    layers.acpCases?.setWhere(acpWhere);
    smartUpdateSummary();

    const freeholdJob = zoom >= 13
      ? q(S.freehold.url, { where: "1=1", returnCountOnly: true, ...geometry })
      : Promise.resolve({ skipped: true, label: "Zoom in" });

    const jobs = {
      planningPointsCount: q(S.planningPoints.url, { where: planningWhere, returnCountOnly: true, ...geometry }),
      planningSitesCount: q(S.planningSites.url, { where: planningWhere, returnCountOnly: true, ...geometry }),
      acpCount: q(S.acpCases.url, { where: acpWhere, returnCountOnly: true, ...geometry }),
      freeholdCount: freeholdJob,
      decisionPoint: smartGrouped(S.planningPoints.url, planningWhere, "Decision", geometry),
      decisionSite: smartGrouped(S.planningSites.url, planningWhere, "Decision", geometry),
      authorityPoint: smartGrouped(S.planningPoints.url, planningWhere, "PlanningAuthority", geometry),
      authoritySite: smartGrouped(S.planningSites.url, planningWhere, "PlanningAuthority", geometry),
      categoryChart: smartGrouped(S.acpCases.url, acpWhere, "CATEGORY", geometry),
      decisionOptionsPoint: smartGrouped(S.planningPoints.url, decisionWhere, "Decision", geometry),
      decisionOptionsSite: smartGrouped(S.planningSites.url, decisionWhere, "Decision", geometry),
      authorityOptionsPoint: smartGrouped(S.planningPoints.url, authorityWhere, "PlanningAuthority", geometry),
      authorityOptionsSite: smartGrouped(S.planningSites.url, authorityWhere, "PlanningAuthority", geometry),
      categoryOptions: smartGrouped(S.acpCases.url, categoryWhere, "CATEGORY", geometry),
      unitsPoint: smartMetric(S.planningPoints.url, "NumResidentialUnits", planningWhere, geometry),
      unitsSite: smartMetric(S.planningSites.url, "NumResidentialUnits", planningWhere, geometry),
      floorPoint: smartMetric(S.planningPoints.url, "FloorArea", planningWhere, geometry),
      floorSite: smartMetric(S.planningSites.url, "FloorArea", planningWhere, geometry),
      sitePoint: smartMetric(S.planningPoints.url, "AreaofSite", planningWhere, geometry),
      siteSite: smartMetric(S.planningSites.url, "AreaofSite", planningWhere, geometry),
      planningMeta: layerInfo(S.planningPoints.url),
      acpMeta: layerInfo(S.acpCases.url)
    };

    const names = Object.keys(jobs);
    const settled = await Promise.allSettled(Object.values(jobs));
    if (currentRun !== runId) return;
    const results = Object.fromEntries(names.map((name, index) => [name, settled[index]]));

    const decisionChart = mergeSettled(results.decisionPoint, results.decisionSite, "Decision");
    const authorityChart = mergeSettled(results.authorityPoint, results.authoritySite, "PlanningAuthority");
    const decisionOptions = mergeSettled(results.decisionOptionsPoint, results.decisionOptionsSite, "Decision");
    const authorityOptions = mergeSettled(results.authorityOptionsPoint, results.authorityOptionsSite, "PlanningAuthority");

    setCount("#planningCount", bestPlanningCount(results.planningPointsCount, results.planningSitesCount));
    setCount("#acpCount", countFrom(results.acpCount));
    const parcel = document.querySelector("#parcelCount");
    if (parcel) {
      parcel.textContent = results.freeholdCount.status === "fulfilled" && !results.freeholdCount.value.skipped
        ? fmt(results.freeholdCount.value.count)
        : "Zoom in";
    }

    smartShowMetric("#unitCount", "#unitCoverage", metricPair(results, "unitsPoint", "unitsSite"), fmt, "Residential units");
    smartShowMetric("#floorAreaCount", "#floorCoverage", metricPair(results, "floorPoint", "floorSite"), smartWholeUp, "Floor area", "m²");
    smartShowMetric("#siteAreaCount", "#siteCoverage", metricPair(results, "sitePoint", "siteSite"), smartWholeUp, "Site area", "ha");

    renderChart("planningDecisionChart", "#planningDecisionFallback", decisionChart, "Decision", "doughnut", "decision");
    renderChart("authorityChart", "#authorityFallback", authorityChart, "PlanningAuthority", "bar", "authority");
    renderChart("acpCategoryChart", "#acpCategoryFallback", results.categoryChart, "CATEGORY", "doughnut", "category");
    renderOptions("decision", "#decisionFilter", decisionOptions, "Decision");
    renderOptions("authority", "#authorityFilter", authorityOptions, "PlanningAuthority");
    renderOptions("category", "#categoryFilter", results.categoryOptions, "CATEGORY");

    updateLayerStatus({ selectedLayers }, results);
    updateFreshness(summary, results);
    smartUpdateSummary();

    const failed = settled.filter(result => result.status === "rejected").length;
    const elapsed = (Math.max(0, performance.now() - started) / 1000).toFixed(1);
    const updated = document.querySelector("#dashboardUpdated");
    if (updated) updated.textContent = `Synced ${new Date().toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ${elapsed}s`;
    status(failed ? `Dashboard partly synced · ${failed} request${failed === 1 ? "" : "s"} failed` : "Dashboard fully synced", failed ? "error" : "ok");
  }

  function schedule({ immediate = false } = {}) {
    clearTimeout(refreshTimer);
    return new Promise((resolve, reject) => {
      refreshTimer = setTimeout(() => synchronizeNow().then(resolve, reject), immediate ? 0 : 80);
    });
  }

  function bindLayerChanges() {
    const toggles = document.querySelector("#layerToggles");
    if (!toggles) return;
    toggles.addEventListener("change", event => {
      const input = event.target.closest('input[data-k]');
      if (!input) return;
      const key = input.dataset.k;
      const layer = layers[key];
      if (layer) {
        if (input.checked && !map.hasLayer(layer)) layer.addTo(map);
        if (!input.checked && map.hasLayer(layer)) map.removeLayer(layer);
      }
      event.stopImmediatePropagation();
      schedule();
    }, true);
  }

  function install() {
    bindLayerChanges();
    update = schedule;
    window.RadharcDashboard = {
      ...(window.RadharcDashboard || {}),
      syncNow: () => schedule({ immediate: true }),
      selectedLayerKeys
    };
    schedule({ immediate: true });
  }

  window.RadharcCrossLayerSync = { synchronizeNow, selectedLayerKeys, canonicalAuthority };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
