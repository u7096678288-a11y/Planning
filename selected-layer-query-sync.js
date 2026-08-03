"use strict";

(function installSelectedLayerQuerySync() {
  const delegatedQuery = q;
  const cache = new Map();
  const inflight = new Map();
  const TTL = 15000;

  const selected = key => {
    const input = document.querySelector(`#layerToggles input[data-k="${key}"]`);
    if (input) return input.checked && !input.disabled;
    return Boolean(layers[key] && map.hasLayer(layers[key]));
  };

  function isEmptyWhere(where) {
    return String(where || "").replace(/[()\s]/g, "") === "1=0";
  }

  function statisticAliases(parameters) {
    if (!parameters?.outStatistics) return {};
    try {
      const statistics = typeof parameters.outStatistics === "string"
        ? JSON.parse(parameters.outStatistics)
        : parameters.outStatistics;
      return Object.fromEntries((statistics || []).map(item => [item.outStatisticFieldName || item.onStatisticField, 0]));
    } catch {
      return {};
    }
  }

  function emptyResponse(parameters = {}, label = "Not selected") {
    if (parameters.returnCountOnly) return { count: 0, skipped: true, label };
    if (parameters.returnIdsOnly) return { objectIdFieldName: "OBJECTID", objectIds: [] };
    if (parameters.outStatistics && !parameters.groupByFieldsForStatistics) {
      return { features: [{ attributes: statisticAliases(parameters) }], skipped: true, label };
    }
    return { features: [], skipped: true, label };
  }

  function encode(value) {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }

  function rawKey(url, parameters) {
    return `${url}|${Object.entries(parameters || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${encode(value)}`).join("&")}`;
  }

  async function rawArcgisQuery(url, parameters = {}) {
    if (isEmptyWhere(parameters.where)) return emptyResponse(parameters, "No matching records");
    const key = rawKey(url, parameters);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.time < TTL) return cached.value;
    if (inflight.has(key)) return inflight.get(key);

    const request = (async () => {
      const body = new URLSearchParams();
      const merged = parameters.f ? { ...parameters } : { f: "json", ...parameters };
      Object.entries(merged).forEach(([name, value]) => {
        if (value == null) return;
        body.set(name, encode(value));
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
      cache.set(key, { time: Date.now(), value: data });
      while (cache.size > 180) cache.delete(cache.keys().next().value);
      return data;
    })().finally(() => inflight.delete(key));

    inflight.set(key, request);
    return request;
  }

  function excludeFor(where) {
    const value = String(where || "");
    try {
      if (value === String(smartPlanningWhere("decision"))) return "decision";
      if (value === String(smartPlanningWhere("authority"))) return "authority";
    } catch {}
    return "";
  }

  function sourceField(field) {
    return field === "AreaofSite" ? "AreaOfSite" : field;
  }

  async function directStatistics(parameters, exclude) {
    const statistics = typeof parameters.outStatistics === "string"
      ? JSON.parse(parameters.outStatistics)
      : parameters.outStatistics;
    const records = await window.CorkCityCKAN.allRecords({
      exclude,
      geometry: parameters,
      maxRows: 60000
    });
    const attributes = {};
    (statistics || []).forEach(item => {
      const field = sourceField(item.onStatisticField);
      const alias = item.outStatisticFieldName || item.onStatisticField;
      const values = records
        .map(record => record[field])
        .filter(value => value != null && value !== "" && Number.isFinite(Number(value)))
        .map(Number);
      if (item.statisticType === "sum") attributes[alias] = values.reduce((sum, value) => sum + value, 0);
      else if (item.statisticType === "count") attributes[alias] = values.length;
      else attributes[alias] = 0;
    });
    return { features: [{ attributes }] };
  }

  async function directOnly(parameters = {}) {
    const api = window.CorkCityCKAN;
    if (!api) return emptyResponse(parameters, "Cork direct unavailable");
    const exclude = excludeFor(parameters.where);
    const geometry = parameters;
    if (parameters.returnCountOnly) {
      return { count: await api.count({ exclude, geometry }) };
    }
    if (parameters.groupByFieldsForStatistics) {
      const features = await api.grouped(parameters.groupByFieldsForStatistics, {
        exclude,
        geometry,
        limit: parameters.resultRecordCount || 250
      });
      return { features };
    }
    if (parameters.outStatistics && !parameters.groupByFieldsForStatistics) {
      return directStatistics(parameters, exclude);
    }
    return emptyResponse(parameters, "Cork direct summary only");
  }

  function planningState() {
    return {
      points: selected("planningPoints"),
      sites: selected("planningSites"),
      cork: selected("corkCityDirect")
    };
  }

  q = async function selectedLayerAwareQuery(url, parameters = {}) {
    if (isEmptyWhere(parameters.where)) return emptyResponse(parameters, "No matching records");

    const planningPoints = url === S.planningPoints.url;
    const planningSites = url === S.planningSites.url;
    if (planningPoints || planningSites) {
      const state = planningState();
      const baseSelected = planningPoints ? state.points : state.sites;
      const anyBaseSelected = state.points || state.sites;

      if (!baseSelected) {
        if (!anyBaseSelected && state.cork && planningPoints) return directOnly(parameters);
        return emptyResponse(parameters);
      }

      if (!state.cork) return rawArcgisQuery(url, parameters);
      return delegatedQuery(url, parameters);
    }

    if (url === S.acpCases.url && !selected("acpCases")) return emptyResponse(parameters);
    if (url === S.freehold.url && !selected("freehold")) return emptyResponse(parameters);
    return delegatedQuery(url, parameters);
  };

  const originalBestMetric = smartBestMetric;
  smartBestMetric = function selectedLayerBestMetric(pointResult, siteResult) {
    const state = planningState();
    if (!state.points && !state.sites && !state.cork) return null;
    const metric = originalBestMetric(pointResult, siteResult);
    if (!metric) return null;
    if (state.cork && !state.points && !state.sites) metric.source = "Cork City direct layer";
    else if (state.cork) metric.source = `${metric.source} + Cork City direct`;
    return metric;
  };

  function updateSelectionLabels() {
    const state = planningState();
    const planningSelected = state.points || state.sites || state.cork;
    if (!planningSelected) {
      const count = document.querySelector("#planningCount");
      if (count) count.textContent = "Not selected";
      [["#unitCount", "#unitCoverage", "Residential units"], ["#floorAreaCount", "#floorCoverage", "Floor area"], ["#siteAreaCount", "#siteCoverage", "Site area"]].forEach(([valueSelector, coverageSelector, label]) => {
        const value = document.querySelector(valueSelector);
        const coverage = document.querySelector(coverageSelector);
        if (value) value.textContent = "—";
        if (coverage) coverage.textContent = `Select a planning layer to calculate ${label.toLowerCase()}`;
      });
    }
    if (!selected("acpCases")) {
      const count = document.querySelector("#acpCount");
      if (count) count.textContent = "Not selected";
    }
    if (!selected("freehold")) {
      const count = document.querySelector("#parcelCount");
      if (count) count.textContent = "Not selected";
    }
  }

  const priorUpdate = update;
  update = function selectedLayerSynchronizedUpdate(...args) {
    return Promise.resolve(priorUpdate(...args)).finally(updateSelectionLabels);
  };

  if (window.RadharcDashboard?.syncNow) {
    const priorSyncNow = window.RadharcDashboard.syncNow;
    window.RadharcDashboard.syncNow = function selectedLayerSynchronizedNow(...args) {
      return Promise.resolve(priorSyncNow(...args)).finally(updateSelectionLabels);
    };
  }

  window.RadharcSelectedLayerQueries = {
    selected,
    clearCache() {
      cache.clear();
      inflight.clear();
    }
  };
})();
