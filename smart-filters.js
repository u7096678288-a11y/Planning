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
const smartOptionData = { decision: [], authority: [], category: [] };
const smartTools = {};
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
  summary.textContent = values.length ? `${values.length} selected` : "All included";
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
  smartRenderFilterTool(key);
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
  smartOptionData[key] = options;
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

function smartToolConfig(key) {
  if (key === "decision") return { label: "decisions", placeholder: "Find a decision" };
  if (key === "authority") return { label: "authorities", placeholder: "Find an authority" };
  return { label: "ACP categories", placeholder: "Find a category" };
}

function smartInjectIntuitiveStyles() {
  if (document.querySelector("#intuitiveFilterStyles")) return;
  const style = document.createElement("style");
  style.id = "intuitiveFilterStyles";
  style.textContent = `
    .multi-filter-select{display:none!important}
    .smart-choice-tool{border:1px solid #d5e0e5;border-radius:8px;background:#f8fbfb;overflow:hidden;margin-bottom:8px}
    .smart-choice-toolbar{display:flex;gap:7px;padding:8px;border-bottom:1px solid #dce4e8;background:#fff}
    .smart-choice-search{min-width:0;flex:1;border:1px solid #b8c8d0;border-radius:6px;padding:8px 9px;font-size:11px;color:#132538;background:#fff}
    .smart-choice-clear{border:1px solid #b8c8d0;border-radius:6px;padding:7px 9px;background:#fff;color:#132538;font-size:11px;font-weight:bold;white-space:nowrap}
    .smart-choice-clear:disabled{opacity:.42;cursor:not-allowed}
    .smart-selected-chips{display:flex;flex-wrap:wrap;gap:5px;padding:8px 8px 0}
    .smart-selected-chips:empty{display:none}
    .smart-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid #a8c9c6;background:#e9f5f3;color:#174d50;border-radius:18px;padding:5px 8px;font-size:10px;line-height:1.1}
    .smart-chip button{border:0;background:transparent;color:inherit;padding:0;font:inherit;font-weight:bold;cursor:pointer}
    .smart-all-note{margin:0;padding:8px 10px;font-size:10px;color:#546d7a;background:#f2f7f7;border-bottom:1px solid #dce4e8}
    .smart-option-list{max-height:190px;overflow:auto;padding:5px;background:#fff}
    .smart-option-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;padding:7px 8px;border-radius:6px;cursor:pointer;font-size:11px;color:#193247}
    .smart-option-row:hover{background:#eef5f5}
    .smart-option-row.is-selected{background:#e5f3f1}
    .smart-option-row input{margin:0;accent-color:#146f79}
    .smart-option-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .smart-option-count{color:#607783;background:#edf2f4;border-radius:12px;padding:2px 6px;font-size:10px;font-variant-numeric:tabular-nums}
    .smart-no-options{padding:12px;color:#687b88;font-size:11px;text-align:center}
    .selection-count{background:#eef5f5;border:1px solid #d1e2e1;color:#315d61}
    @media(max-width:700px){.smart-option-list{max-height:230px}.smart-choice-toolbar{align-items:stretch}.smart-choice-clear{padding-inline:12px}}
  `;
  document.head.append(style);
}

function smartBuildFilterTool(key) {
  const select = smartSelectForKey(key);
  if (!select || smartTools[key]) return;
  const config = smartToolConfig(key);
  const tool = document.createElement("div");
  tool.className = "smart-choice-tool";
  tool.innerHTML = `
    <div class="smart-choice-toolbar">
      <input class="smart-choice-search" type="search" placeholder="${esc(config.placeholder)}" aria-label="${esc(config.placeholder)}" />
      <button class="smart-choice-clear" type="button" disabled>Clear</button>
    </div>
    <div class="smart-selected-chips" aria-live="polite"></div>
    <p class="smart-all-note">All ${esc(config.label)} are included until you tick one or more boxes.</p>
    <div class="smart-option-list" role="group" aria-label="Choose ${esc(config.label)}"></div>
  `;
  select.before(tool);
  select.hidden = true;
  const search = tool.querySelector(".smart-choice-search");
  const clear = tool.querySelector(".smart-choice-clear");
  const list = tool.querySelector(".smart-option-list");
  const chips = tool.querySelector(".smart-selected-chips");
  const note = tool.querySelector(".smart-all-note");
  smartTools[key] = { tool, search, clear, list, chips, note };
  search.addEventListener("input", () => smartRenderFilterTool(key));
  clear.addEventListener("click", () => smartSetFilter(key, []));
  list.addEventListener("change", event => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    smartToggleFilterValue(key, input.value);
  });
  chips.addEventListener("click", event => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    smartToggleFilterValue(key, button.dataset.value);
  });
}

function smartRenderFilterTool(key) {
  const refs = smartTools[key];
  if (!refs) return;
  const selected = new Set(smartState[key]);
  const query = refs.search.value.trim().toLocaleLowerCase("en-IE");
  const options = smartOptionData[key].filter(option =>
    !query || option.label.toLocaleLowerCase("en-IE").includes(query)
  );
  refs.clear.disabled = selected.size === 0;
  refs.note.hidden = selected.size > 0;
  refs.chips.innerHTML = smartState[key].map(value => `
    <span class="smart-chip">${esc(smartFilterLabel(value))}<button type="button" data-value="${esc(value)}" aria-label="Remove ${esc(smartFilterLabel(value))}">×</button></span>
  `).join("");
  refs.list.innerHTML = options.length ? options.map(option => {
    const checked = selected.has(option.value);
    return `
      <label class="smart-option-row${checked ? " is-selected" : ""}">
        <input type="checkbox" value="${esc(option.value)}" ${checked ? "checked" : ""} />
        <span class="smart-option-label" title="${esc(option.label)}">${esc(option.label)}</span>
        <span class="smart-option-count">${fmt(option.count)}</span>
      </label>
    `;
  }).join("") : '<div class="smart-no-options">No matching options</div>';
}

function smartEnhance() {
  smartInjectIntuitiveStyles();
  ["decision", "authority", "category"].forEach(smartBuildFilterTool);
  smartBindDateControls();
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
