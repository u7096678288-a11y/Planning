"use strict";

(function installCorkCityCkan() {
  const API = "https://data.corkcity.ie/api/3/action/datastore_search_sql";
  const RESOURCE_ID = "8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";
  const SOURCE_KEY = "corkCityDirect";
  const MAX_MAP_ROWS = 5000;
  const CACHE_TTL = 15000;
  const cache = new Map();
  const inflight = new Map();
  const whereContexts = new Map();
  let currentRecords = [];
  let refreshTimer = null;
  let refreshSequence = 0;

  function sqlText(value) {
    return String(value ?? "").replaceAll("'", "''");
  }

  function canonicalAuthority(value) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
    if (text.includes("CORK CITY")) return "Cork City Council";
    if (text.includes("CORK COUNTY")) return "Cork County Council";
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function dateOnly(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
  }

  function activeDateClauses() {
    const clauses = [];
    if (smartState.customDates) {
      if (smartState.customDates.start) clauses.push(`"ReceivedDate" >= '${sqlText(smartState.customDates.start)}'::timestamp`);
      if (smartState.customDates.end) {
        const end = new Date(`${smartState.customDates.end}T00:00:00Z`);
        end.setUTCDate(end.getUTCDate() + 1);
        clauses.push(`"ReceivedDate" < '${dateOnly(end)}'::timestamp`);
      }
      return clauses;
    }
    const period = document.querySelector("#dateRange")?.value || "365";
    if (period !== "all" && period !== "custom") {
      const start = new Date();
      start.setDate(start.getDate() - Number(period));
      clauses.push(`"ReceivedDate" >= '${dateOnly(start)}'::timestamp`);
    }
    return clauses;
  }

  function stateClauses(exclude = "") {
    const clauses = activeDateClauses();
    if (exclude !== "authority" && smartState.authority.length) {
      const includesCorkCity = smartState.authority.some(value => canonicalAuthority(value) === "Cork City Council");
      if (!includesCorkCity) clauses.push("FALSE");
    }
    if (exclude !== "decision" && smartState.decision.length) {
      const values = smartState.decision.filter(value => value !== smartNull);
      const hasNull = smartState.decision.includes(smartNull);
      const parts = values.map(value => `"Decision" = '${sqlText(value)}'`);
      if (hasNull) parts.push(`("Decision" IS NULL OR "Decision" = '')`);
      if (parts.length) clauses.push(`(${parts.join(" OR ")})`);
    }
    if (window.RadharcResidentialUnits?.isActive?.()) {
      const minimum = Number(smartState.minUnits || 1);
      clauses.push(`COALESCE("NumResidentialUnits", 0) >= ${Math.max(1, minimum)}`);
    }
    return clauses;
  }

  function geometryClause(geometry) {
    if (!geometry?.geometry) return "";
    try {
      const box = typeof geometry.geometry === "string" ? JSON.parse(geometry.geometry) : geometry.geometry;
      const values = [box.xmin, box.ymin, box.xmax, box.ymax].map(Number);
      if (values.some(value => !Number.isFinite(value))) return "";
      const [west, south, east, north] = values;
      return `"Longitude" BETWEEN ${west} AND ${east} AND "Latitude" BETWEEN ${south} AND ${north}`;
    } catch {
      return "";
    }
  }

  function whereSql({ exclude = "", geometry = null, search = "" } = {}) {
    const clauses = stateClauses(exclude);
    const spatial = geometryClause(geometry);
    if (spatial) clauses.push(spatial);
    if (search) {
      const text = sqlText(search);
      clauses.push(`(CAST("ApplicationNumber" AS text) ILIKE '%${text}%' OR "DevelopmentAddress" ILIKE '%${text}%' OR "DevelopmentDescription" ILIKE '%${text}%')`);
    }
    return clauses.length ? clauses.join(" AND ") : "TRUE";
  }

  function cleanupJsonp(script, callbackName, timeoutId) {
    clearTimeout(timeoutId);
    script.remove();
    try { delete window[callbackName]; } catch { window[callbackName] = undefined; }
  }

  function jsonp(sql) {
    return new Promise((resolve, reject) => {
      const callbackName = `__radharcCork_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");
      const url = new URL(API);
      url.searchParams.set("sql", sql);
      url.searchParams.set("callback", callbackName);
      const timeoutId = setTimeout(() => {
        cleanupJsonp(script, callbackName, timeoutId);
        reject(new Error("Cork City datastore timed out"));
      }, 20000);
      window[callbackName] = payload => {
        cleanupJsonp(script, callbackName, timeoutId);
        if (!payload?.success) {
          reject(new Error(payload?.error?.message || "Cork City datastore query failed"));
          return;
        }
        resolve(payload.result?.records || []);
      };
      script.onerror = () => {
        cleanupJsonp(script, callbackName, timeoutId);
        reject(new Error("Cork City datastore could not be reached"));
      };
      script.src = url.toString();
      document.head.append(script);
    });
  }

  async function querySql(sql) {
    const now = Date.now();
    const cached = cache.get(sql);
    if (cached && now - cached.time < CACHE_TTL) return cached.value;
    if (inflight.has(sql)) return inflight.get(sql);
    const request = jsonp(sql)
      .then(value => {
        cache.set(sql, { time: Date.now(), value });
        while (cache.size > 120) cache.delete(cache.keys().next().value);
        return value;
      })
      .finally(() => inflight.delete(sql));
    inflight.set(sql, request);
    return request;
  }

  function contextFor(where) {
    const text = String(where || "");
    const exact = whereContexts.get(text);
    if (exact) return exact;
    let match = null;
    whereContexts.forEach((context, key) => {
      if (text.includes(key) && (!match || key.length > match.key.length)) match = { key, context };
    });
    return match?.context || { exclude: "" };
  }

  function recordFeature(record) {
    const latitude = Number(record.Latitude);
    const longitude = Number(record.Longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const properties = {
      ...record,
      PlanningAuthority: "Cork City Council",
      ApplicationNumber: String(record.ApplicationNumber ?? ""),
      NumResidentialUnits: record.NumResidentialUnits == null || record.NumResidentialUnits === "" ? null : Number(record.NumResidentialUnits),
      FloorArea: record.FloorArea == null || record.FloorArea === "" ? null : Number(record.FloorArea),
      AreaofSite: record.AreaOfSite == null || record.AreaOfSite === "" ? null : Number(record.AreaOfSite),
      DirectSource: "Cork City Council CKAN"
    };
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties
    };
  }

  async function records({ exclude = "", geometry = null, search = "", limit = MAX_MAP_ROWS, offset = 0, order = true } = {}) {
    const sql = [
      `SELECT * FROM "${RESOURCE_ID}"`,
      `WHERE ${whereSql({ exclude, geometry, search })}`,
      order ? `ORDER BY "ReceivedDate" DESC NULLS LAST` : "",
      `LIMIT ${Math.max(1, Math.min(10000, Number(limit) || MAX_MAP_ROWS))}`,
      `OFFSET ${Math.max(0, Number(offset) || 0)}`
    ].filter(Boolean).join(" ");
    return querySql(sql);
  }

  async function allRecords(options = {}) {
    const output = [];
    const pageSize = Math.min(5000, options.pageSize || 5000);
    for (let offset = 0; offset < (options.maxRows || 60000); offset += pageSize) {
      const page = await records({ ...options, limit: pageSize, offset });
      output.push(...page);
      if (page.length < pageSize) break;
    }
    return output;
  }

  async function count({ exclude = "", geometry = null } = {}) {
    const sql = `SELECT count(*)::integer AS count FROM "${RESOURCE_ID}" WHERE ${whereSql({ exclude, geometry })}`;
    const result = await querySql(sql);
    return Number(result[0]?.count) || 0;
  }

  async function grouped(field, { exclude = "", geometry = null, limit = 250 } = {}) {
    const allowed = new Set(["Decision", "PlanningAuthority"]);
    if (!allowed.has(field)) return [];
    if (field === "PlanningAuthority") {
      const value = await count({ exclude, geometry });
      return value ? [{ attributes: { PlanningAuthority: "Cork City Council", n: value } }] : [];
    }
    const sql = `SELECT "${field}" AS value, count(*)::integer AS n FROM "${RESOURCE_ID}" WHERE ${whereSql({ exclude, geometry })} GROUP BY "${field}" ORDER BY n DESC LIMIT ${Math.max(1, Number(limit) || 250)}`;
    const result = await querySql(sql);
    return result.map(row => ({ attributes: { [field]: row.value, n: Number(row.n) || 0 } }));
  }

  async function statistics(outStatistics, { exclude = "", geometry = null } = {}) {
    const stats = typeof outStatistics === "string" ? JSON.parse(outStatistics) : outStatistics;
    const expressions = (stats || []).map(item => {
      const field = String(item.onStatisticField || "").replaceAll('"', '');
      const alias = String(item.outStatisticFieldName || field).replaceAll('"', '');
      if (item.statisticType === "sum") return `COALESCE(sum("${field}"), 0) AS "${alias}"`;
      if (item.statisticType === "count") return `count("${field}")::integer AS "${alias}"`;
      return null;
    }).filter(Boolean);
    if (!expressions.length) return {};
    const sql = `SELECT ${expressions.join(", ")} FROM "${RESOURCE_ID}" WHERE ${whereSql({ exclude, geometry })}`;
    return (await querySql(sql))[0] || {};
  }

  function mergeGroup(base, direct, field) {
    const values = new Map();
    [...(base.features || []), ...(direct || [])].forEach(feature => {
      const attributes = feature.attributes || {};
      const raw = attributes[field];
      const key = raw == null || raw === "" ? smartNull : (field === "PlanningAuthority" ? canonicalAuthority(raw) : String(raw).trim());
      const previous = values.get(key) || { value: key === smartNull ? null : key, count: 0 };
      previous.count += Number(attributes.n) || 0;
      values.set(key, previous);
    });
    return {
      features: [...values.values()]
        .sort((a, b) => b.count - a.count)
        .map(item => ({ attributes: { [field]: item.value, n: item.count } }))
    };
  }

  function addStatistics(base, direct) {
    const attributes = { ...(base.features?.[0]?.attributes || {}) };
    Object.entries(direct || {}).forEach(([key, value]) => {
      attributes[key] = (Number(attributes[key]) || 0) + (Number(value) || 0);
    });
    return { ...base, features: [{ attributes }] };
  }

  function nonCorkWhere(where) {
    return `(${where || "1=1"}) AND (PlanningAuthority IS NULL OR UPPER(PlanningAuthority) NOT LIKE 'CORK CITY%')`;
  }

  function patchQueries() {
    const originalPlanningWhere = smartPlanningWhere;
    smartPlanningWhere = function recordedPlanningWhere(exclude = "") {
      const value = originalPlanningWhere(exclude);
      whereContexts.set(value, { exclude });
      while (whereContexts.size > 80) whereContexts.delete(whereContexts.keys().next().value);
      return value;
    };

    const originalQ = q;
    q = async function corkAwareQuery(url, parameters = {}) {
      const planningUrl = url === S.planningPoints.url || url === S.planningSites.url;
      if (!planningUrl) return originalQ(url, parameters);
      const context = contextFor(parameters.where);
      const baseParameters = { ...parameters, where: nonCorkWhere(parameters.where) };

      if (parameters.returnCountOnly) {
        const [base, direct] = await Promise.all([
          originalQ(url, baseParameters),
          count({ exclude: context.exclude, geometry: parameters })
        ]);
        return { ...base, count: (Number(base.count) || 0) + direct };
      }

      if (parameters.groupByFieldsForStatistics) {
        const field = parameters.groupByFieldsForStatistics;
        if (field === "Decision" || field === "PlanningAuthority") {
          const [base, direct] = await Promise.all([
            originalQ(url, baseParameters),
            grouped(field, { exclude: context.exclude, geometry: parameters, limit: parameters.resultRecordCount })
          ]);
          return mergeGroup(base, direct, field);
        }
      }

      if (parameters.outStatistics && !parameters.groupByFieldsForStatistics) {
        const [base, direct] = await Promise.all([
          originalQ(url, baseParameters),
          statistics(parameters.outStatistics, { exclude: context.exclude, geometry: parameters })
        ]);
        return addStatistics(base, direct);
      }

      return originalQ(url, baseParameters);
    };
  }

  function activeNationalReferences() {
    const refs = new Set();
    [layers.planningPoints, layers.planningSites].forEach(layer => {
      const add = item => {
        const reference = item?.feature?.properties?.ApplicationNumber;
        if (reference != null && reference !== "") refs.add(String(reference));
      };
      if (typeof layer?.eachActiveFeature === "function") layer.eachActiveFeature(add);
      else if (typeof layer?.eachFeature === "function") layer.eachFeature(add);
    });
    return refs;
  }

  function layerFeature(record) {
    return recordFeature(record);
  }

  function createLayer() {
    if (layers[SOURCE_KEY]) return;
    S[SOURCE_KEY] = {
      label: "Cork City planning — direct feed",
      url: API,
      resourceId: RESOURCE_ID,
      color: "#8f2d56",
      on: true,
      type: "planning",
      direct: true
    };
    layers[SOURCE_KEY] = L.geoJSON([], {
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
        radius: 4.5,
        color: "#ffffff",
        weight: 1,
        fillColor: S[SOURCE_KEY].color,
        fillOpacity: 0.92
      }),
      onEachFeature: (feature, layer) => {
        layer.on("click", event => select(SOURCE_KEY, feature, event.latlng));
      }
    });
    layers[SOURCE_KEY].addTo(map);
  }

  function createToggle() {
    const container = document.querySelector("#layerToggles");
    if (!container || container.querySelector(`[data-k="${SOURCE_KEY}"]`)) return;
    const label = document.createElement("label");
    label.className = "layer-toggle";
    label.innerHTML = `<input type="checkbox" data-k="${SOURCE_KEY}" checked><i style="background:${S[SOURCE_KEY].color}"></i><span>${S[SOURCE_KEY].label}</span>`;
    label.querySelector("input").addEventListener("change", event => {
      if (event.target.checked && !map.hasLayer(layers[SOURCE_KEY])) layers[SOURCE_KEY].addTo(map);
      if (!event.target.checked && map.hasLayer(layers[SOURCE_KEY])) map.removeLayer(layers[SOURCE_KEY]);
      scheduleRefresh(true);
    });
    container.append(label);
  }

  function updateLayerStatus(countValue, error = "") {
    const container = document.querySelector("#layerCoverageRows");
    if (!container) return;
    let row = container.querySelector(`[data-layer-status="${SOURCE_KEY}"]`);
    if (!row) {
      row = document.createElement("div");
      row.dataset.layerStatus = SOURCE_KEY;
      row.className = "layer-coverage-row";
      container.append(row);
    }
    const selected = document.querySelector(`#layerToggles input[data-k="${SOURCE_KEY}"]`)?.checked;
    row.className = `layer-coverage-row ${selected ? "" : "is-off"}`;
    row.innerHTML = `<i class="layer-coverage-swatch" style="background:${S[SOURCE_KEY].color}"></i><span class="layer-coverage-name">${esc(S[SOURCE_KEY].label)} · ${selected ? "selected" : "not selected"}</span><span class="layer-coverage-value">${error ? "Unavailable" : fmt(countValue)}</span>`;
  }

  async function refreshLayer() {
    const sequence = ++refreshSequence;
    const checkbox = document.querySelector(`#layerToggles input[data-k="${SOURCE_KEY}"]`);
    if (!checkbox?.checked) {
      layers[SOURCE_KEY]?.clearLayers();
      updateLayerStatus(0);
      return [];
    }
    try {
      const result = await records({ geometry: geom(), limit: MAX_MAP_ROWS });
      if (sequence !== refreshSequence) return [];
      currentRecords = result;
      const existing = activeNationalReferences();
      const features = result
        .filter(record => !existing.has(String(record.ApplicationNumber ?? "")))
        .map(layerFeature)
        .filter(Boolean);
      layers[SOURCE_KEY].clearLayers();
      layers[SOURCE_KEY].addData({ type: "FeatureCollection", features });
      updateLayerStatus(result.length);
      return features;
    } catch (error) {
      console.error("Cork City direct feed failed", error);
      updateLayerStatus(0, error.message);
      return [];
    }
  }

  function scheduleRefresh(immediate = false) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshLayer, immediate ? 0 : 180);
  }

  function initialise() {
    createLayer();
    createToggle();
    patchQueries();
    map.on("moveend zoomend", () => scheduleRefresh());
    document.addEventListener("change", event => {
      if (event.target.matches("#dateRange, #customStartDate, #customEndDate, #decisionFilter, #authorityFilter, #minimumResidentialUnits, #residentialOnlyFilter")) scheduleRefresh();
    });
    scheduleRefresh(true);
  }

  window.CorkCityCKAN = {
    api: API,
    resourceId: RESOURCE_ID,
    sourceKey: SOURCE_KEY,
    canonicalAuthority,
    records,
    allRecords,
    count,
    grouped,
    statistics,
    refreshLayer,
    currentRecords: () => [...currentRecords],
    features: () => currentRecords.map(recordFeature).filter(Boolean),
    search: (text, geometry, limit = 50) => records({ geometry, search: text, limit }),
    clearCache: () => { cache.clear(); inflight.clear(); }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialise, { once: true });
  else initialise();
})();
