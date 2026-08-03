"use strict";

(function installAuthorityAwareSearch() {
  const DIRECT_KEY = "corkCityDirect";

  function selectedKeys() {
    return [...document.querySelectorAll('#layerToggles input[data-k]:checked')]
      .map(input => input.dataset.k)
      .filter(key => S[key]);
  }

  function nonCorkWhere(where) {
    return `(${where || "1=1"}) AND (PlanningAuthority IS NULL OR UPPER(PlanningAuthority) NOT LIKE 'CORK CITY%')`;
  }

  function textClause(key, text) {
    const safe = smartEscapeSql(text);
    if (S[key].type === "planning") return `(ApplicationNumber LIKE '%${safe}%' OR DevelopmentAddress LIKE '%${safe}%' OR DevelopmentDescription LIKE '%${safe}%')`;
    if (S[key].type === "acp") return `(ABPCASEID LIKE '%${safe}%' OR DEVADDRESS LIKE '%${safe}%' OR DEVDESC LIKE '%${safe}%')`;
    return `SP_ID LIKE '%${safe}%'`;
  }

  async function queryLayer(key, raw, directSelected) {
    if (key === DIRECT_KEY) {
      const records = await window.CorkCityCKAN.search(raw, geom(), 50);
      return records.map(record => [key, {
        type: "Feature",
        geometry: { type: "Point", coordinates: [Number(record.Longitude), Number(record.Latitude)] },
        properties: {
          ...record,
          PlanningAuthority: "Cork City Council",
          AreaofSite: record.AreaOfSite,
          DirectSource: "Cork City Council CKAN"
        }
      }]).filter(item => item[1].geometry.coordinates.every(Number.isFinite));
    }

    if (key === "freehold" && !raw && map.getZoom() < 13) return [];
    let where = S[key].type === "planning" ? smartPlanningWhere() : S[key].type === "acp" ? smartAcpWhere() : "1=1";
    if (S[key].type === "planning" && directSelected) where = nonCorkWhere(where);
    if (raw) where = `(${where}) AND (${textClause(key, raw)})`;
    const dateField = S[key].type === "planning" ? "ReceivedDate" : S[key].type === "acp" ? "LODGEDON" : "";
    const parameters = {
      where,
      outFields: "*",
      returnGeometry: true,
      outSR: 4326,
      resultRecordCount: 50,
      f: "geojson"
    };
    if (dateField) parameters.orderByFields = `${dateField} DESC`;
    const result = await q(S[key].url, parameters);
    return (result.features || []).map(feature => [key, feature]);
  }

  function recordTime([key, feature]) {
    const properties = feature.properties || {};
    const value = S[key].type === "planning" ? properties.ReceivedDate : S[key].type === "acp" ? properties.LODGEDON : 0;
    const parsed = new Date(value || 0).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function authorityFor(key, properties) {
    if (key === DIRECT_KEY) return "Cork City Council";
    if (S[key].type === "planning") return window.CorkCityCKAN?.canonicalAuthority?.(properties.PlanningAuthority) || String(properties.PlanningAuthority || "").trim();
    if (S[key].type === "acp") return String(properties.PLANINGATY || "").trim();
    return "";
  }

  function dedupeKey(key, feature) {
    const properties = feature.properties || {};
    if (S[key].type === "planning") return `planning:${authorityFor(key, properties).toUpperCase()}:${String(properties.ApplicationNumber || "").trim()}`;
    if (S[key].type === "acp") return `acp:${String(properties.ABPCASEID || "").trim()}`;
    return `parcel:${String(properties.SP_ID || "").trim()}`;
  }

  function markup([key, feature], index) {
    const properties = feature.properties || {};
    if (S[key].type === "planning") {
      const authority = authorityFor(key, properties);
      const detail = `${properties.DevelopmentAddress || ""}${authority ? ` · ${authority}` : ""}${properties.NumResidentialUnits != null ? ` · ${fmt(properties.NumResidentialUnits)} units` : ""}`;
      return `<button data-i="${index}"><b>${esc(properties.ApplicationNumber || "Planning application")}</b><span>${esc(S[key].label)} · ${esc(date(properties.ReceivedDate))}</span><span>${esc(detail.slice(0, 180))}</span></button>`;
    }
    if (S[key].type === "acp") {
      const detail = `${properties.DEVADDRESS || properties.DEVDESC || ""}${properties.CATEGORY ? ` · ${properties.CATEGORY}` : ""}`;
      return `<button data-i="${index}"><b>${esc(properties.ABPCASEID || "ACP case")}</b><span>${esc(S[key].label)} · ${esc(date(properties.LODGEDON))}</span><span>${esc(detail.slice(0, 180))}</span></button>`;
    }
    return `<button data-i="${index}"><b>${esc(properties.SP_ID || "Freehold parcel")}</b><span>${esc(S[key].label)}</span><span>Cadastral parcel</span></button>`;
  }

  async function search(event) {
    event.preventDefault();
    const input = document.querySelector("#searchInput");
    const results = document.querySelector("#searchResults");
    const statusText = document.querySelector("#searchStatus");
    const raw = input?.value.trim() || "";
    const keys = selectedKeys();
    if (!keys.length) {
      results.innerHTML = '<div class="empty-state">Select at least one layer.</div>';
      statusText.textContent = "Select one or more layers, then search.";
      return;
    }

    statusText.textContent = `Searching ${keys.length} selected layer${keys.length === 1 ? "" : "s"} · ${smartSummary()}…`;
    const directSelected = keys.includes(DIRECT_KEY);
    const settled = await Promise.allSettled(keys.map(key => queryLayer(key, raw, directSelected)));
    const failures = [];
    const unique = new Map();
    settled.forEach((result, index) => {
      const key = keys[index];
      if (result.status !== "fulfilled") {
        failures.push(S[key].label);
        return;
      }
      result.value.forEach(item => {
        const identity = dedupeKey(item[0], item[1]);
        const previous = unique.get(identity);
        if (!previous || item[0] === DIRECT_KEY) unique.set(identity, item);
      });
    });

    const items = [...unique.values()].sort((left, right) => recordTime(right) - recordTime(left));
    results.innerHTML = items.length ? items.map(markup).join("") : '<div class="empty-state">No matching records were returned.</div>';
    results.querySelectorAll("button[data-i]").forEach(button => button.addEventListener("click", () => focus(items[Number(button.dataset.i)])));
    statusText.textContent = `${items.length} result${items.length === 1 ? "" : "s"}${raw ? ` matching “${raw}”` : ""} · ${smartSummary()}${failures.length ? ` · Unavailable: ${failures.join(", ")}` : ""}.`;
  }

  function bind() {
    const form = document.querySelector("#searchForm");
    if (form) form.onsubmit = search;
  }

  window.RadharcAuthoritySearch = { search };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
