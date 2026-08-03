"use strict";

(function installSynchronizedDashboard() {
  let syncRun = 0;

  function buildSnapshot() {
    const run = ++syncRun;
    const geometry = geom();
    const planningWhere = smartPlanningWhere();
    const acpWhere = smartAcpWhere();
    const summary = smartSummary();

    return {
      run,
      geometry,
      planningWhere,
      acpWhere,
      decisionWhere: smartPlanningWhere("decision"),
      authorityWhere: smartPlanningWhere("authority"),
      categoryWhere: smartAcpWhere("category"),
      summary
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

    smartOptionData[key] = smartState[key].map(value => ({
      value,
      label: smartFilterLabel(value),
      count: 0
    }));
    smartRenderFilterTool(key);
  }

  function metricPair(results, pointKey, siteKey) {
    return smartBestMetric(results[pointKey], results[siteKey]);
  }

  function updateFreshness(snapshot, results) {
    const planningEdit = results.planningMeta?.status === "fulfilled"
      ? results.planningMeta.value.editingInfo?.dataLastEditDate
      : null;
    const acpEdit = results.acpMeta?.status === "fulfilled"
      ? results.acpMeta.value.editingInfo?.dataLastEditDate
      : null;

    const freshness = document.querySelector("#sourceFreshness");
    if (!freshness) return;
    freshness.textContent = [
      planningEdit ? `Planning feed edited ${dateTime(planningEdit)}` : "Planning feed edit date unavailable",
      acpEdit ? `ACP feed edited ${dateTime(acpEdit)}` : "ACP feed edit date unavailable",
      snapshot.summary
    ].join(" · ");
  }

  async function synchronizedUpdate() {
    const snapshot = buildSnapshot();
    smartState.sequence = snapshot.run;
    status("Synchronising dashboard");
    applySnapshotToLayers(snapshot);
    smartUpdateSummary();

    const jobs = {
      planningCount: q(S.planningPoints.url, {
        where: snapshot.planningWhere,
        returnCountOnly: true,
        ...snapshot.geometry
      }),
      acpCount: q(S.acpCases.url, {
        where: snapshot.acpWhere,
        returnCountOnly: true,
        ...snapshot.geometry
      }),
      decisionChart: smartGrouped(
        S.planningPoints.url,
        snapshot.planningWhere,
        "Decision",
        snapshot.geometry
      ),
      authorityChart: smartGrouped(
        S.planningPoints.url,
        snapshot.planningWhere,
        "PlanningAuthority",
        snapshot.geometry
      ),
      categoryChart: smartGrouped(
        S.acpCases.url,
        snapshot.acpWhere,
        "CATEGORY",
        snapshot.geometry
      ),
      decisionOptions: smartGrouped(
        S.planningPoints.url,
        snapshot.decisionWhere,
        "Decision",
        snapshot.geometry
      ),
      authorityOptions: smartGrouped(
        S.planningPoints.url,
        snapshot.authorityWhere,
        "PlanningAuthority",
        snapshot.geometry
      ),
      categoryOptions: smartGrouped(
        S.acpCases.url,
        snapshot.categoryWhere,
        "CATEGORY",
        snapshot.geometry
      ),
      unitsPoint: smartMetric(
        S.planningPoints.url,
        "NumResidentialUnits",
        snapshot.planningWhere,
        snapshot.geometry
      ),
      unitsSite: smartMetric(
        S.planningSites.url,
        "NumResidentialUnits",
        snapshot.planningWhere,
        snapshot.geometry
      ),
      floorPoint: smartMetric(
        S.planningPoints.url,
        "FloorArea",
        snapshot.planningWhere,
        snapshot.geometry
      ),
      floorSite: smartMetric(
        S.planningSites.url,
        "FloorArea",
        snapshot.planningWhere,
        snapshot.geometry
      ),
      sitePoint: smartMetric(
        S.planningPoints.url,
        "AreaofSite",
        snapshot.planningWhere,
        snapshot.geometry
      ),
      siteSite: smartMetric(
        S.planningSites.url,
        "AreaofSite",
        snapshot.planningWhere,
        snapshot.geometry
      ),
      planningMeta: layerInfo(S.planningPoints.url),
      acpMeta: layerInfo(S.acpCases.url)
    };

    const names = Object.keys(jobs);
    const settled = await Promise.allSettled(Object.values(jobs));
    if (snapshot.run !== syncRun) return;

    const results = Object.fromEntries(names.map((name, index) => [name, settled[index]]));

    setMetricText("#planningCount", results.planningCount);
    setMetricText("#acpCount", results.acpCount);
    document.querySelector("#parcelCount").textContent = map.getZoom() >= 13 ? "Visible" : "Zoom in";

    const units = metricPair(results, "unitsPoint", "unitsSite");
    const floorArea = metricPair(results, "floorPoint", "floorSite");
    const siteArea = metricPair(results, "sitePoint", "siteSite");
    smartShowMetric("#unitCount", "#unitCoverage", units, fmt, "Residential units");
    smartShowMetric("#floorAreaCount", "#floorCoverage", floorArea, smartWholeUp, "Floor area", "m²");
    smartShowMetric("#siteAreaCount", "#siteCoverage", siteArea, smartWholeUp, "Site area", "ha");

    renderChartResult(
      "planningDecisionChart",
      "#planningDecisionFallback",
      results.decisionChart,
      "Decision",
      "doughnut",
      "decision"
    );
    renderChartResult(
      "authorityChart",
      "#authorityFallback",
      results.authorityChart,
      "PlanningAuthority",
      "bar",
      "authority"
    );
    renderChartResult(
      "acpCategoryChart",
      "#acpCategoryFallback",
      results.categoryChart,
      "CATEGORY",
      "doughnut",
      "category"
    );

    refreshOptionResult("decision", "#decisionFilter", results.decisionOptions, "Decision");
    refreshOptionResult("authority", "#authorityFilter", results.authorityOptions, "PlanningAuthority");
    refreshOptionResult("category", "#categoryFilter", results.categoryOptions, "CATEGORY");

    updateFreshness(snapshot, results);
    smartUpdateSummary();

    const updated = document.querySelector("#dashboardUpdated");
    if (updated) {
      updated.textContent = `Synced ${new Date().toLocaleTimeString("en-IE", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })}`;
    }

    const failedCount = settled.filter(result => result.status === "rejected").length;
    status(
      failedCount ? `Dashboard partly synced · ${failedCount} feed request${failedCount === 1 ? "" : "s"} failed` : "Dashboard fully synced",
      failedCount ? "error" : "ok"
    );
  }

  update = synchronizedUpdate;
})();