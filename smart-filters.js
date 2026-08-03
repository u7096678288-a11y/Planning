"use strict";

const smartNull = "__NOT_STATED__";
const smartState = {
  customDates: null,
  lastPreset: "7",
  decision: [],
  authority: [],
  category: [],
  sequence: 0
};
const smartWholeUp = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 })
  .format(Math.ceil(Number(value) || 0));
const smartEscapeSql = value => String(value ?? "").replaceAll("'", "''");

function smartNextDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function smartDateWhere(field) {
  if (!smartState.customDates) {
    return field === "ReceivedDate" ? cutoff() : acpCutoff();
  }
  const clauses = [];
  if (smartState.customDates.start) {
    clauses.push(`${field} >= DATE '${smartState.customDates.start}'`);
  }
  if (smartState.customDates.end) {
    clauses.push(`${field} < DATE '${smartNextDate(smartState.customDates.end)}'`);
  }
  return clauses.join(" AND ") || "1=1";
}

function smartTextClause(field, value) {
  if (!value) return "";
  if (value === smartNull) return `(${field} IS NULL OR ${field} = '')`;
  return `${field} = '${smartEscapeSql(value)}'`;
}

function smartValuesClause(field, values) {
  if (!Array.isArray(values) || !values.length) return "";
  const clauses = values.map(value => smartTextClause(field, value)).filter(Boolean);
  return clauses.length ? `(${clauses.join(" OR ")})` : "";
}

function smartPlanningWhere(exclude = "") {
  const clauses = [smartDateWhere("ReceivedDate")];
  if (exclude !== "decision") {
    const decision = smartValuesClause("Decision", smartState.decision);
    if (decision) clauses.push(decision);
  }
  if (exclude !== "authority") {
    const authority = smartValuesClause("PlanningAuthority", smartState.authority);
    if (authority) clauses.push(authority);
  }
  return clauses.map(clause => `(${clause})`).join(" AND ");
}

function smartAcpWhere(exclude = "") {
  const clauses = [smartDateWhere("LODGEDON")];
  if (exclude !== "category") {
    const category = smartValuesClause("CATEGORY", smartState.category);
    if (category) clauses.push(category);
  }
  return clauses.map(clause => `(${clause})`).join(" AND ");
}

function smartReadableDate(value) {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString("en-IE", {
    day: "2-digit", month: "short", year: "numeric"
  }) : "";
}

function smartPeriodLabel() {
  if (!smartState.customDates) return periodLabel();
  const { start, end } = smartState.customDates;
  if (start && end) return `${smartReadableDate(start)} to ${smartReadableDate(end)}`;
  if (start) return `from ${smartReadableDate(start)}`;
  return `up to ${smartReadableDate(end)}`;
}

function smartFilterLabel(value) {
  return value === smartNull ? "Not stated" : value;
}

function smartFilterListLabel(values) {
  const labels = values.map(smartFilterLabel);
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 3).join(", ")} +${labels.length - 3}`;
}

function smartSummary() {
  const parts = [`Period: ${smartPeriodLabel()}`];
  if (smartState.decision.length) parts.push(`Decisions: ${smartFilterListLabel(smartState.decision)}`);
  if (smartState.authority.length) parts.push(`Authorities: ${smartFilterListLabel(smartState.authority)}`);
  if (smartState.category.length) parts.push(`ACP categories: ${smartFilterListLabel(smartState.category)}`);
  return parts.join(" · ");
}

function smartSelectForKey(key) {
  const id = key === "decision" ? "#decisionFilter" : key === "authority" ? "#authorityFilter" : "#categoryFilter";
  return document.querySelector(id);
}

function smartSelectionSummaryForKey(key) {
  const id = key === "decision" ? "#decisionSelection" : key === "authority" ? "#authoritySelection" : "#categorySelection";
  return document.querySelector(id);
}

function smartUpdateSelectionSummary(key) {
  const values = smartState[key];
  const summary = smartSelectionSummaryForKey(key);
  if (!summary) return;
  summary.textContent = values.length ? `${values.length} selected` : "All";
  summary.title = values.length ? smartFilterListLabel(values) : "No selections: all values included";
}

function smartUpdateSummary() {
  const summary = document.querySelector("#activeFilterSummary");
  if (summary) summary.textContent = smartSummary();
  ["decision", "authority", "category"].forEach(smartUpdateSelectionSummary);
  const clearButton = document.querySelector("#clearSmartFilters");
  const hasSelections = smartState.decision.length || smartState.authority.length || smartState.category.length;
  if (clearButton) clearButton.disabled = !hasSelections;
}

function smartSyncSelect(key) {
  const select = smartSelectForKey(key);
  if (!select) return;
  const selected = new Set(smartState[key]);
  Array.from(select.options).forEach(option => {
    option.selected = selected.has(option.value);
  });
}

function smartApplyLayerFilters() {
  if (!layers.planningPoints) return;
  layers.planningPoints.setWhere(smartPlanningWhere());
  layers.planningSites.setWhere(smartPlanningWhere());
  layers.acpCases.setWhere(smartAcpWhere());
}

async function smartGrouped(url, where, field, geometry, limit = 250) {
  return q(url, {
    where,
    outStatistics: JSON.stringify([
      { statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "n" }
    ]),
    groupByFieldsForStatistics: field,
    orderByFields: "n DESC",
    resultRecordCount: limit,
    returnGeometry: false,
    ...geometry
  });
}

function smartSetOptions(select, features, field, selectedValues, key) {
  if (!select) return;
  const options = (features || []).map(feature => {
    const attributes = feature.attributes || {};
    const raw = attributes[field];
    return {
      value: raw == null || raw === "" ? smartNull : String(raw),
      label: raw == null || raw === "" ? "Not stated" : String(raw),
      count: Number(attributes.n) || 0
    };
  });
  selectedValues.forEach(selected => {
    if (!options.some(option => option.value === selected)) {
      options.unshift({ value: selected, label: smartFilterLabel(selected), count: 0 });
    }
  });
  select.innerHTML = options.length
    ? options.map(option => `<option value="${esc(option.value)}">${esc(option.label)} (${fmt(option.count)})</option>`).join("")
    : '<option disabled>No options for the current filters</option>';
  smartSyncSelect(key);
  smartUpdateSelectionSummary(key);
}

async function smartRefreshFilterOptions(geometry, sequence) {
  const results = await Promise.allSettled([
    smartGrouped(S.planningPoints.url, smartPlanningWhere("decision"), "Decision", geometry),
    smartGrouped(S.planningPoints.url, smartPlanningWhere("authority"), "PlanningAuthority", geometry),
    smartGrouped(S.acpCases.url, smartAcpWhere("category"), "CATEGORY", geometry)
  ]);
  if (sequence !== smartState.sequence) return;
  if (results[0].status === "fulfilled") {
    smartSetOptions(document.querySelector("#decisionFilter"), results[0].value.features, "Decision", smartState.decision, "decision");
  }
  if (results[1].status === "fulfilled") {
    smartSetOptions(document.querySelector("#authorityFilter"), results[1].value.features, "PlanningAuthority", smartState.authority, "authority");
  }
  if (results[2].status === "fulfilled") {
    smartSetOptions(document.querySelector("#categoryFilter"), results[2].value.features, "CATEGORY", smartState.category, "category");
  }
}

function smartSetFilter(key, values) {
  smartState[key] = [...new Set((values || []).filter(Boolean))];
  smartSyncSelect(key);
  smartApplyLayerFilters();
  smartUpdateSummary();
  const results = document.querySelector("#searchResults");
  if (results) results.innerHTML = "";
  const searchStatus = document.querySelector("#searchStatus");
  if (searchStatus) searchStatus.textContent = `Filters updated. Press Search to list records for ${smartPeriodLabel()}.`;
  update();
}

function smartToggleFilterValue(key, value) {
  const current = smartState[key];
  const values = current.includes(value)
    ? current.filter(item => item !== value)
    : [...current, value];
  smartSetFilter(key, values);
}

function smartDrawChart(id, features, field, type, filterKey) {
  const labels = (features || []).map(feature => feature.attributes?.[field] || "Not stated");
  const data = (features || []).map(feature => Number(feature.attributes?.n) || 0);
  charts[id]?.destroy();
  charts[id] = new Chart(document.getElementById(id), {
    type,
    data: { labels, datasets: [{ data }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: type === "bar" ? "y" : "x",
      plugins: { legend: { display: type !== "bar", position: "bottom" } },
      onClick: (_event, elements) => {
        if (!elements.length) return;
        const label = labels[elements[0].index];
        const value = label === "Not stated" ? smartNull : label;
        smartToggleFilterValue(filterKey, value);
      }
    }
  });
}

async function smartMetric(url, field, where, geometry) {
  const result = await q(url, {
    where,
    outStatistics: JSON.stringify([
      { statisticType: "sum", onStatisticField: field, outStatisticFieldName: "total" },
      { statisticType: "count", onStatisticField: field, outStatisticFieldName: "records" }
    ]),
    returnGeometry: false,
    ...geometry
  });
  const attributes = result.features?.[0]?.attributes || {};
  return { total: Number(attributes.total) || 0, records: Number(attributes.records) || 0 };
}

function smartBestMetric(pointResult, siteResult) {
  const candidates = [];
  if (pointResult.status === "fulfilled") candidates.push({ ...pointResult.value, source: "point layer" });
  if (siteResult.status === "fulfilled") candidates.push({ ...siteResult.value, source: "site layer" });
  candidates.sort((a, b) => (b.records - a.records) || (b.total - a.total));
  return candidates[0] || null;
}

function smartShowMetric(valueId, coverageId, metric, formatter, label, unit = "") {
  const value = document.querySelector(valueId);
  const coverage = document.querySelector(coverageId);
  if (!value || !coverage) return;
  if (!metric) {
    value.textContent = "Unavailable";
    coverage.textContent = `${label} feed could not be queried`;
    return;
  }
  const formatted = formatter(metric.total);
  value.textContent = formatted;
  coverage.textContent = `${formatted}${unit ? ` ${unit}` : ""} total from ${fmt(metric.records)} reporting records · ${metric.source}`;
}

async function smartUpdateTotals(geometry, sequence) {
  const fields = ["NumResidentialUnits", "FloorArea", "AreaofSite"];
  const results = await Promise.allSettled(fields.flatMap(field => [
    smartMetric(S.planningPoints.url, field, smartPlanningWhere(), geometry),
    smartMetric(S.planningSites.url, field, smartPlanningWhere(), geometry)
  ]));
  if (sequence !== smartState.sequence) return;
  smartShowMetric("#unitCount", "#unitCoverage", smartBestMetric(results[0], results[1]), fmt, "Residential units");
  smartShowMetric("#floorAreaCount", "#floorCoverage", smartBestMetric(results[2], results[3]), smartWholeUp, "Floor area", "m²");
  smartShowMetric("#siteAreaCount", "#siteCoverage", smartBestMetric(results[4], results[5]), smartWholeUp, "Site area", "ha");
}

async function smartUpdateCountsCharts(geometry, sequence) {
  const results = await Promise.allSettled([
    q(S.planningPoints.url, { where: smartPlanningWhere(), returnCountOnly: true, ...geometry }),
    q(S.acpCases.url, { where: smartAcpWhere(), returnCountOnly: true, ...geometry }),
    smartGrouped(S.planningPoints.url, smartPlanningWhere("decision"), "Decision", geometry),
    smartGrouped(S.planningPoints.url, smartPlanningWhere("authority"), "PlanningAuthority", geometry, 12),
    smartGrouped(S.acpCases.url, smartAcpWhere("category"), "CATEGORY", geometry, 12)
  ]);
  if (sequence !== smartState.sequence) return;
  if (results[0].status === "fulfilled") document.querySelector("#planningCount").textContent = fmt(results[0].value.count);
  if (results[1].status === "fulfilled") document.querySelector("#acpCount").textContent = fmt(results[1].value.count);
  if (results[2].status === "fulfilled") smartDrawChart("planningDecisionChart", results[2].value.features, "Decision", "doughnut", "decision");
  if (results[3].status === "fulfilled") smartDrawChart("authorityChart", results[3].value.features, "PlanningAuthority", "bar", "authority");
  if (results[4].status === "fulfilled") smartDrawChart("acpCategoryChart", results[4].value.features, "CATEGORY", "doughnut", "category");
  document.querySelector("#parcelCount").textContent = map.getZoom() >= 13 ? "Visible" : "Zoom in";
}

async function smartUpdateFreshness(sequence) {
  const results = await Promise.allSettled([layerInfo(S.planningPoints.url), layerInfo(S.acpCases.url)]);
  if (sequence !== smartState.sequence) return;
  const planningEdit = results[0].status === "fulfilled" ? results[0].value.editingInfo?.dataLastEditDate : null;
  const acpEdit = results[1].status === "fulfilled" ? results[1].value.editingInfo?.dataLastEditDate : null;
  document.querySelector("#sourceFreshness").textContent = [
    planningEdit ? `Planning feed edited ${dateTime(planningEdit)}` : "Planning feed edit date unavailable",
    acpEdit ? `ACP feed edited ${dateTime(acpEdit)}` : "ACP feed edit date unavailable",
    smartSummary()
  ].join(" · ");
}

update = async function smartDashboardUpdate() {
  const sequence = ++smartState.sequence;
  status("Checking smart filters");
  smartApplyLayerFilters();
  smartUpdateSummary();
  const geometry = geom();
  const outcomes = await Promise.allSettled([
    smartUpdateCountsCharts(geometry, sequence),
    smartUpdateTotals(geometry, sequence),
    smartRefreshFilterOptions(geometry, sequence),
    smartUpdateFreshness(sequence)
  ]);
  if (sequence !== smartState.sequence) return;
  document.querySelector("#dashboardUpdated").textContent = `Checked ${new Date().toLocaleTimeString("en-IE", {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  })}`;
  const failed = outcomes.some(outcome => outcome.status === "rejected");
  status(failed ? "Live data partly updated" : "Live data checked", failed ? "error" : "ok");
};

function smartResultMarkup(item, index) {
  const [key, feature] = item;
  const properties = feature.properties || {};
  const planning = key === "planningPoints";
  const reference = planning ? (properties.ApplicationNumber || "Planning application") : (properties.ABPCASEID || "ACP case");
  const address = planning ? properties.DevelopmentAddress : properties.DEVADDRESS;
  const received = planning ? properties.ReceivedDate : properties.LODGEDON;
  return `<button data-i="${index}"><b>${esc(reference)}</b><span>${planning ? "Planning" : "ACP"} · ${esc(date(received))}</span><span>${esc((address || "").slice(0, 120))}</span></button>`;
}

async function smartSearch(event) {
  event.preventDefault();
  const raw = document.querySelector("#searchInput").value.trim();
  const text = smartEscapeSql(raw);
  const planningText = `(ApplicationNumber LIKE '%${text}%' OR DevelopmentAddress LIKE '%${text}%' OR DevelopmentDescription LIKE '%${text}%')`;
  const acpText = `(ABPCASEID LIKE '%${text}%' OR DEVADDRESS LIKE '%${text}%' OR DEVDESC LIKE '%${text}%')`;
  const planningWhere = raw ? `(${smartPlanningWhere()}) AND ${planningText}` : smartPlanningWhere();
  const acpWhere = raw ? `(${smartAcpWhere()}) AND ${acpText}` : smartAcpWhere();
  document.querySelector("#searchStatus").textContent = `Searching ${smartSummary()}…`;
  try {
    const [planning, acp] = await Promise.all([
      q(S.planningPoints.url, { where: planningWhere, outFields: "*", returnGeometry: true, outSR: 4326, orderByFields: "ReceivedDate DESC", resultRecordCount: 50, f: "geojson" }),
      q(S.acpCases.url, { where: acpWhere, outFields: "*", returnGeometry: true, outSR: 4326, orderByFields: "LODGEDON DESC", resultRecordCount: 50, f: "geojson" })
    ]);
    const all = [
      ...(planning.features || []).map(feature => ["planningPoints", feature]),
      ...(acp.features || []).map(feature => ["acpCases", feature])
    ].sort((a, b) => recordDate(b) - recordDate(a));
    document.querySelector("#searchResults").innerHTML = all.length
      ? all.map(smartResultMarkup).join("")
      : '<div class="empty-state">No matching records were returned for these filters.</div>';
    document.querySelectorAll("#searchResults button").forEach(button => {
      button.onclick = () => focus(all[button.dataset.i]);
    });
    const qualifier = raw ? ` matching “${raw}”` : "";
    document.querySelector("#searchStatus").textContent = `${all.length} result${all.length === 1 ? "" : "s"}${qualifier} · ${smartSummary()}${all.length === 100 ? " · first 100" : ""}.`;
  } catch (error) {
    console.error(error);
    document.querySelector("#searchStatus").textContent = "Search could not be completed";
  }
}

function smartBindDateControls() {
  const dateRange = document.querySelector("#dateRange");
  const start = document.querySelector("#customStartDate");
  const end = document.querySelector("#customEndDate");
  const dateStatus = document.querySelector("#customDateStatus");
  const today = new Date().toLocaleDateString("en-CA");
  smartState.lastPreset = dateRange.value;
  start.max = today;
  end.max = today;

  dateRange.onchange = () => {
    if (dateRange.value === "custom") return;
    smartState.lastPreset = dateRange.value;
    smartState.customDates = null;
    start.value = "";
    end.value = "";
    start.max = today;
    end.min = "";
    dateStatus.textContent = `Using ${periodLabel()}.`;
    smartApplyLayerFilters();
    document.querySelector("#searchResults").innerHTML = "";
    document.querySelector("#searchStatus").textContent = `Filter changed to ${periodLabel()}. Press Search to list records.`;
    update();
  };
  start.onchange = () => { end.min = start.value || ""; };
  end.onchange = () => { start.max = end.value || today; };

  document.querySelector("#applyCustomDates").onclick = () => {
    if (!start.value && !end.value) {
      dateStatus.textContent = "Choose at least one calendar date.";
      return;
    }
    if (start.value && end.value && start.value > end.value) {
      dateStatus.textContent = "The From date must be before or equal to the To date.";
      return;
    }
    smartState.customDates = { start: start.value, end: end.value };
    dateRange.value = "custom";
    dateStatus.textContent = `Active: ${smartPeriodLabel()}.`;
    smartApplyLayerFilters();
    document.querySelector("#searchResults").innerHTML = "";
    document.querySelector("#searchStatus").textContent = `Custom period applied: ${smartPeriodLabel()}. Press Search to list records.`;
    update();
  };

  document.querySelector("#clearCustomDates").onclick = () => {
    smartState.customDates = null;
    start.value = "";
    end.value = "";
    start.max = today;
    end.min = "";
    dateRange.value = smartState.lastPreset;
    dateStatus.textContent = `Custom dates cleared. Using ${periodLabel()}.`;
    smartApplyLayerFilters();
    document.querySelector("#searchResults").innerHTML = "";
    document.querySelector("#searchStatus").textContent = `Using ${periodLabel()}. Press Search to list records.`;
    update();
  };
}

function smartBindMultiSelect(key) {
  const select = smartSelectForKey(key);
  if (!select) return;
  select.onchange = () => {
    smartSetFilter(key, Array.from(select.selectedOptions).map(option => option.value));
  };
  select.addEventListener("mousedown", event => {
    const option = event.target.closest("option");
    if (!option || option.disabled) return;
    event.preventDefault();
    option.selected = !option.selected;
    select.focus();
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function smartEnhance() {
  smartBindDateControls();
  smartBindMultiSelect("decision");
  smartBindMultiSelect("authority");
  smartBindMultiSelect("category");
  document.querySelector("#clearSmartFilters").onclick = () => {
    smartState.decision = [];
    smartState.authority = [];
    smartState.category = [];
    ["decision", "authority", "category"].forEach(smartSyncSelect);
    smartApplyLayerFilters();
    smartUpdateSummary();
    update();
  };
  document.querySelector("#searchForm").onsubmit = smartSearch;
  smartApplyLayerFilters();
  smartUpdateSummary();
  update();
}

document.addEventListener("DOMContentLoaded", smartEnhance);
