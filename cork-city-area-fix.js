"use strict";

(function installCorkCityAreaFix() {
  const originalQ = q;

  function containsCorkAreaStatistic(parameters) {
    if (!parameters?.outStatistics || parameters.groupByFieldsForStatistics) return false;
    try {
      const stats = typeof parameters.outStatistics === "string" ? JSON.parse(parameters.outStatistics) : parameters.outStatistics;
      return (stats || []).some(item => item.onStatisticField === "AreaofSite");
    } catch {
      return false;
    }
  }

  function encode(value) {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }

  async function arcgisQuery(url, parameters) {
    const body = new URLSearchParams();
    Object.entries({ f: "json", ...parameters }).forEach(([key, value]) => {
      if (value == null) return;
      body.set(key, encode(value));
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
    if (data.error) throw new Error(data.error.message || "ArcGIS query failed");
    return data;
  }

  function nonCorkWhere(where) {
    return `(${where || "1=1"}) AND (PlanningAuthority IS NULL OR UPPER(PlanningAuthority) NOT LIKE 'CORK CITY%')`;
  }

  function directStatistics(records, statistics) {
    const output = {};
    (statistics || []).forEach(item => {
      const requested = item.onStatisticField;
      const field = requested === "AreaofSite" ? "AreaOfSite" : requested;
      const alias = item.outStatisticFieldName || requested;
      const values = records
        .map(record => record[field])
        .filter(value => value != null && value !== "" && Number.isFinite(Number(value)))
        .map(Number);
      if (item.statisticType === "sum") output[alias] = values.reduce((sum, value) => sum + value, 0);
      if (item.statisticType === "count") output[alias] = values.length;
    });
    return output;
  }

  q = async function corkAreaAwareQuery(url, parameters = {}) {
    const planning = url === S.planningPoints.url || url === S.planningSites.url;
    if (!planning || !containsCorkAreaStatistic(parameters)) return originalQ(url, parameters);

    const statistics = typeof parameters.outStatistics === "string"
      ? JSON.parse(parameters.outStatistics)
      : parameters.outStatistics;
    const [base, records] = await Promise.all([
      arcgisQuery(url, { ...parameters, where: nonCorkWhere(parameters.where) }),
      window.CorkCityCKAN.allRecords({ geometry: parameters, maxRows: 60000 })
    ]);
    const attributes = { ...(base.features?.[0]?.attributes || {}) };
    const direct = directStatistics(records, statistics);
    Object.entries(direct).forEach(([key, value]) => {
      attributes[key] = (Number(attributes[key]) || 0) + (Number(value) || 0);
    });
    return { ...base, features: [{ attributes }] };
  };
})();
