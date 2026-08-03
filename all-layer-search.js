"use strict";

(function installAllLayerSearch() {
  const LIMIT = 50;

  function selectedKeys() {
    return window.RadharcDashboard?.selectedLayerKeys?.()
      || [...document.querySelectorAll('#layerToggles input[data-k]:checked')].map(input => input.dataset.k);
  }

  function textClause(key, text) {
    const safe = smartEscapeSql(text);
    if (key === "planningPoints" || key === "planningSites") {
      return `(ApplicationNumber LIKE '%${safe}%' OR DevelopmentAddress LIKE '%${safe}%' OR DevelopmentDescription LIKE '%${safe}%')`;
    }
    if (key === "acpCases") {
      return `(ABPCASEID LIKE '%${safe}%' OR DEVADDRESS LIKE '%${safe}%' OR DEVDESC LIKE '%${safe}%')`;
    }
    return `SP_ID LIKE '%${safe}%'`;
  }

  function sourceWhere(key, raw) {
    const base = S[key].type === "planning"
      ? smartPlanningWhere()
      : S[key].type === "acp"
        ? smartAcpWhere()
        : "1=1";
    return raw ? `(${base}) AND (${textClause(key, raw)})` : base;
  }

  function queryFor(key, raw) {
    const source = S[key];
    const dateField = source.type === "planning" ? "ReceivedDate" : source.type === "acp" ? "LODGEDON" : "";
    const parameters = {
      where: sourceWhere(key, raw),
      outFields: "*",
      returnGeometry: true,
      outSR: 4326,
      resultRecordCount: LIMIT,
      f: "geojson"
    };
    if (dateField) parameters.orderByFields = `${dateField} DESC`;
    return q(source.url, parameters);
  }

  function itemDate([key, feature]) {
    const properties = feature.properties || {};
    if (S[key].type === "planning") return Number(properties.ReceivedDate || 0);
    if (S[key].type === "acp") return Number(properties.LODGEDON || 0);
    return 0;
  }

  function itemMarkup([key, feature], index) {
    const properties = feature.properties || {};
    const type = S[key].type;
    let reference = S[key].label;
    let subtitle = S[key].label;
    let detail = "";
    if (type === "planning") {
      reference = properties.ApplicationNumber || "Planning application";
      subtitle = `${S[key].label} · ${date(properties.ReceivedDate)}`;
      const authority = properties.PlanningAuthority ? ` · ${properties.PlanningAuthority}` : "";
      const units = properties.NumResidentialUnits != null ? ` · ${fmt(properties.NumResidentialUnits)} units` : "";
      detail = `${properties.DevelopmentAddress || ""}${authority}${units}`;
    } else if (type === "acp") {
      reference = properties.ABPCASEID || "ACP case";
      subtitle = `${S[key].label} · ${date(properties.LODGEDON)}`;
      detail = `${properties.DEVADDRESS || properties.DEVDESC || ""}${properties.CATEGORY ? ` · ${properties.CATEGORY}` : ""}`;
    } else {
      reference = properties.SP_ID || "Freehold parcel";
      subtitle = S[key].label;
      detail = properties.SHAPE_Area != null ? `Source area: ${properties.SHAPE_Area}` : "Cadastral parcel";
    }
    return `<button data-i="${index}"><b>${esc(reference)}</b><span>${esc(subtitle)}</span><span>${esc(String(detail).slice(0, 170))}</span></button>`;
  }

  async function searchAllLayers(event) {
    event.preventDefault();
    const raw = document.querySelector("#searchInput")?.value.trim() || "";
    const statusText = document.querySelector("#searchStatus");
    const resultsElement = document.querySelector("#searchResults");
    let keys = selectedKeys();

    const skipped = [];
    if (!raw && keys.includes("freehold") && map.getZoom() < 13) {
      keys = keys.filter(key => key !== "freehold");
      skipped.push("Freehold requires zoom level 13+ for a blank search");
    }
    if (!keys.length) {
      resultsElement.innerHTML = '<div class="empty-state">Select at least one searchable layer.</div>';
      statusText.textContent = "Select one or more layers, then search.";
      return;
    }

    statusText.textContent = `Searching ${keys.length} selected layer${keys.length === 1 ? "" : "s"} · ${smartSummary()}…`;
    const settled = await Promise.allSettled(keys.map(key => queryFor(key, raw)));
    const items = [];
    const failures = [];
    settled.forEach((result, index) => {
      const key = keys[index];
      if (result.status === "fulfilled") {
        (result.value.features || []).forEach(feature => items.push([key, feature]));
      } else failures.push(S[key]?.label || key);
    });
    items.sort((left, right) => itemDate(right) - itemDate(left));

    resultsElement.innerHTML = items.length
      ? items.map(itemMarkup).join("")
      : '<div class="empty-state">No matching records were returned from the selected layers.</div>';
    resultsElement.querySelectorAll("button[data-i]").forEach(button => {
      button.addEventListener("click", () => focus(items[Number(button.dataset.i)]));
    });

    const notes = [];
    if (failures.length) notes.push(`Unavailable: ${failures.join(", ")}`);
    notes.push(...skipped);
    const qualifier = raw ? ` matching “${raw}”` : "";
    statusText.textContent = `${items.length} result${items.length === 1 ? "" : "s"}${qualifier} from ${keys.length} layer${keys.length === 1 ? "" : "s"} · ${smartSummary()}${notes.length ? ` · ${notes.join(" · ")}` : ""}.`;
  }

  function bind() {
    const form = document.querySelector("#searchForm");
    if (form) form.onsubmit = searchAllLayers;
    const label = form?.querySelector("label[for='searchInput']");
    if (label) label.textContent = "Search references, addresses or descriptions across every selected layer. Residential-unit thresholds apply to planning layers only; ACP retains its own filters.";
  }

  window.RadharcLayerSearch = { search: searchAllLayers };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
