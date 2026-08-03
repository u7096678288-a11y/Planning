"use strict";

(function installCorkCityTools() {
  const T = window.RadharcTools = window.RadharcTools || {};
  const DIRECT_KEY = "corkCityDirect";
  const MAX_TOTAL_ROWS = 120000;
  const BATCH_SIZE = 200;
  const CONCURRENCY = 3;

  function selectedKeys() {
    return [...document.querySelectorAll('#layerToggles input[data-k]:checked')]
      .map(input => input.dataset.k)
      .filter(key => S[key]);
  }

  function nonCorkWhere(where) {
    return `(${where || "1=1"}) AND (PlanningAuthority IS NULL OR UPPER(PlanningAuthority) NOT LIKE 'CORK CITY%')`;
  }

  function whereFor(key, directSelected) {
    if (key === DIRECT_KEY) return "";
    if (S[key].type === "planning") {
      const where = smartPlanningWhere();
      return directSelected ? nonCorkWhere(where) : where;
    }
    if (S[key].type === "acp") return smartAcpWhere();
    return "1=1";
  }

  function encode(value) {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }

  async function postQuery(url, parameters = {}) {
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
    if (data.error) {
      const details = Array.isArray(data.error.details) ? data.error.details.filter(Boolean).join(" · ") : "";
      throw new Error([data.error.message, details].filter(Boolean).join(" · "));
    }
    return data;
  }

  async function arcgisIds(key, geometry, directSelected) {
    if (key === "freehold" && map.getZoom() < 13) {
      return { ids: [], skipped: "Zoom to level 13 or closer to export freehold parcels." };
    }
    const result = await postQuery(S[key].url, {
      where: whereFor(key, directSelected),
      returnIdsOnly: true,
      returnGeometry: false,
      ...geometry
    });
    return { ids: [...new Set(result.objectIds || [])], skipped: "" };
  }

  function chunks(values, size) {
    const output = [];
    for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
    return output;
  }

  async function arcgisRows(key, ids, progress) {
    if (!ids.length) return [];
    const batches = chunks(ids, BATCH_SIZE);
    const rows = [];
    let cursor = 0;
    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= batches.length) return;
        const result = await postQuery(S[key].url, {
          where: "1=1",
          objectIds: batches[index].join(","),
          outFields: "*",
          returnGeometry: false
        });
        const attributes = (result.features || []).map(feature => feature.attributes || {});
        rows.push(...attributes);
        progress(attributes.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    return rows;
  }

  function safeCell(value) {
    if (value == null) return "";
    if (typeof value === "string" && /^[=+\-@]/.test(value)) return `'${value}`;
    return value;
  }

  function normaliseDate(value) {
    if (value == null || value === "") return "";
    const numeric = Number(value);
    const parsed = new Date(Number.isFinite(numeric) ? numeric : value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
  }

  function exportRow(key, attributes) {
    const row = {};
    Object.entries(attributes || {}).forEach(([field, value]) => {
      if (/Date$/.test(field) || field === "LODGEDON") row[field] = safeCell(normaliseDate(value));
      else row[field] = safeCell(value);
    });
    if (key === DIRECT_KEY) {
      row.PlanningAuthority = "Cork City Council";
      if (row.AreaOfSite !== undefined && row.AreaofSite === undefined) row.AreaofSite = row.AreaOfSite;
    }
    row.ExportLayer = S[key].label;
    row.ActiveFilters = smartSummary();
    return row;
  }

  async function collectLayers(progress = () => {}) {
    const keys = selectedKeys();
    if (!keys.length) throw new Error("Select at least one data layer first.");
    const geometry = geom();
    const directSelected = keys.includes(DIRECT_KEY);
    const results = {};
    let total = 0;

    for (const key of keys) {
      try {
        if (key === DIRECT_KEY) {
          const records = await window.CorkCityCKAN.allRecords({ geometry, maxRows: 60000 });
          total += records.length;
          results[key] = { rows: records.map(record => exportRow(key, record)), error: "", skipped: "" };
          progress(records.length, total);
          continue;
        }
        const idResult = await arcgisIds(key, geometry, directSelected);
        total += idResult.ids.length;
        if (total > MAX_TOTAL_ROWS) throw new Error(`The selected layers contain more than ${fmt(MAX_TOTAL_ROWS)} records. Narrow the map or filters.`);
        if (idResult.skipped) {
          results[key] = { rows: [], error: "", skipped: idResult.skipped };
          continue;
        }
        const attributes = await arcgisRows(key, idResult.ids, count => progress(count, total));
        results[key] = { rows: attributes.map(row => exportRow(key, row)), error: "", skipped: "" };
      } catch (error) {
        results[key] = { rows: [], error: T.errorMessage?.(error) || error.message, skipped: "" };
      }
    }
    return { keys, results, geometry };
  }

  function commonRow(key, row) {
    if (key === "acpCases") {
      return {
        "Source layer": S[key].label,
        "Record type": "ACP case",
        "Reference": row.ABPCASEID || "",
        "Date": row.LODGEDON || "",
        "Authority": row.PLANINGATY || "",
        "Decision": row.DECISION || "",
        "Category": row.CATEGORY || "",
        "Address": row.DEVADDRESS || "",
        "Description": row.DEVDESC || "",
        "Residential units": "",
        "Floor area (m²)": "",
        "Site area (ha)": "",
        "Latitude": row.Latitude ?? row.LATITUDE ?? "",
        "Longitude": row.Longitude ?? row.LONGITUDE ?? "",
        "Active filters": smartSummary()
      };
    }
    if (key === "freehold") {
      return {
        "Source layer": S[key].label,
        "Record type": "Freehold parcel",
        "Reference": row.SP_ID || "",
        "Date": "",
        "Authority": "",
        "Decision": "",
        "Category": "",
        "Address": "",
        "Description": "",
        "Residential units": "",
        "Floor area (m²)": "",
        "Site area (ha)": row.SHAPE_Area ?? "",
        "Latitude": "",
        "Longitude": "",
        "Active filters": smartSummary()
      };
    }
    return {
      "Source layer": S[key].label,
      "Record type": "Planning application",
      "Reference": row.ApplicationNumber || "",
      "Date": row.ReceivedDate || "",
      "Authority": key === DIRECT_KEY ? "Cork City Council" : (row.PlanningAuthority || ""),
      "Decision": row.Decision || "",
      "Category": "",
      "Address": row.DevelopmentAddress || "",
      "Description": row.DevelopmentDescription || "",
      "Residential units": row.NumResidentialUnits ?? "",
      "Floor area (m²)": row.FloorArea ?? "",
      "Site area (ha)": row.AreaofSite ?? row.AreaOfSite ?? "",
      "Latitude": row.Latitude ?? "",
      "Longitude": row.Longitude ?? "",
      "Active filters": smartSummary()
    };
  }

  function csvCell(value) {
    let text = String(value ?? "");
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }

  function csvText(rows) {
    const headers = Object.keys(rows[0] || {});
    return [headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n");
  }

  async function exportCsv() {
    const button = document.querySelector("#exportViewButton");
    if (!button) return;
    const previous = button.textContent;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Preparing CSV…";
    try {
      let loaded = 0;
      const collected = await collectLayers(count => {
        loaded += count;
        button.textContent = `Building CSV · ${fmt(loaded)} rows…`;
      });
      const rows = [];
      collected.keys.forEach(key => {
        (collected.results[key]?.rows || []).forEach(row => rows.push(commonRow(key, row)));
      });
      if (!rows.length) throw new Error("No records match the selected layers, map area and filters.");
      rows.sort((left, right) => String(right.Date).localeCompare(String(left.Date)));
      T.downloadBlob(new Blob([`\uFEFF${csvText(rows)}`], { type: "text/csv;charset=utf-8" }), `radharc-pleanala-${new Date().toISOString().slice(0, 10)}-${rows.length}-records.csv`);
      const failed = collected.keys.filter(key => collected.results[key]?.error);
      T.showMessage?.(failed.length ? `${fmt(rows.length)} records exported. Unavailable: ${failed.map(key => S[key].label).join(", ")}.` : `${fmt(rows.length)} records exported as CSV.`, failed.length ? "error" : "ok", 8000);
    } catch (error) {
      T.showMessage?.(`CSV export failed: ${T.errorMessage?.(error) || error.message}`, "error", 9000);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = previous;
    }
  }

  function loadSheetJs() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let script = document.querySelector("#sheetJsLibrary");
      if (!script) {
        script = document.createElement("script");
        script.id = "sheetJsLibrary";
        script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
        script.async = true;
        document.head.append(script);
      }
      const finish = () => window.XLSX ? resolve() : reject(new Error("Excel library failed to initialise"));
      script.addEventListener("load", finish, { once: true });
      script.addEventListener("error", () => reject(new Error("Excel library failed to load")), { once: true });
    });
  }

  function sheetName(key) {
    const names = {
      planningPoints: "Planning Points",
      planningSites: "Planning Sites",
      corkCityDirect: "Cork City Direct",
      acpCases: "ACP Cases",
      freehold: "Freehold Parcels"
    };
    return names[key] || key.slice(0, 31);
  }

  function styleSheet(sheet, rows) {
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) };
    sheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" };
    sheet["!cols"] = headers.map(header => {
      let width = Math.max(10, header.length + 2);
      rows.slice(0, 200).forEach(row => { width = Math.max(width, String(row[header] ?? "").length + 2); });
      return { wch: Math.min(45, width) };
    });
  }

  async function exportExcel() {
    const button = document.querySelector("#exportWorkbookButton");
    if (!button) return;
    const previous = button.textContent;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Preparing Excel…";
    try {
      await loadSheetJs();
      let loaded = 0;
      const collected = await collectLayers(count => {
        loaded += count;
        button.textContent = `Building Excel · ${fmt(loaded)} rows…`;
      });
      const workbook = XLSX.utils.book_new();
      const box = JSON.parse(collected.geometry.geometry);
      const summaryRows = [
        ["Radharc Pleanála export", "Layered research workbook"],
        ["Generated", new Date().toLocaleString("en-IE")],
        ["Active filters", smartSummary()],
        ["Map extent", `${box.xmin}, ${box.ymin}, ${box.xmax}, ${box.ymax}`],
        ["Cork City direct resource", window.CorkCityCKAN.resourceId],
        [],
        ["Layer", "Selected", "Records", "Status"]
      ];
      Object.keys(S).forEach(key => {
        const result = collected.results[key];
        summaryRows.push([S[key].label, collected.keys.includes(key) ? "Yes" : "No", result?.rows?.length || 0, result?.error ? `Failed: ${result.error}` : result?.skipped || (result ? "Exported" : "Not selected")]);
      });
      const summary = XLSX.utils.aoa_to_sheet(summaryRows);
      summary["!cols"] = [{ wch: 34 }, { wch: 72 }, { wch: 14 }, { wch: 44 }];
      XLSX.utils.book_append_sheet(workbook, summary, "Summary");

      let exported = 0;
      collected.keys.forEach(key => {
        const result = collected.results[key] || { rows: [], error: "No result" };
        const rows = result.rows.length ? result.rows : [{ Status: result.error || result.skipped || "No matching records", ActiveFilters: smartSummary() }];
        exported += result.rows.length;
        const sheet = XLSX.utils.json_to_sheet(rows);
        styleSheet(sheet, rows);
        XLSX.utils.book_append_sheet(workbook, sheet, sheetName(key));
      });
      if (!exported && !collected.keys.some(key => collected.results[key]?.skipped)) throw new Error("No matching records were returned.");
      XLSX.writeFile(workbook, `radharc-pleanala-layer-export-${new Date().toISOString().slice(0, 10)}.xlsx`, { compression: true });
      const failed = collected.keys.filter(key => collected.results[key]?.error);
      T.showMessage?.(failed.length ? `${fmt(exported)} rows exported. Unavailable: ${failed.map(key => S[key].label).join(", ")}.` : `${fmt(exported)} rows exported to a layered Excel workbook.`, failed.length ? "error" : "ok", 8000);
    } catch (error) {
      T.showMessage?.(`Excel export failed: ${T.errorMessage?.(error) || error.message}`, "error", 9000);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = previous;
    }
  }

  function textClause(key, text) {
    const safe = smartEscapeSql(text);
    if (S[key].type === "planning") return `(ApplicationNumber LIKE '%${safe}%' OR DevelopmentAddress LIKE '%${safe}%' OR DevelopmentDescription LIKE '%${safe}%')`;
    if (S[key].type === "acp") return `(ABPCASEID LIKE '%${safe}%' OR DEVADDRESS LIKE '%${safe}%' OR DEVDESC LIKE '%${safe}%')`;
    return `SP_ID LIKE '%${safe}%'`;
  }

  async function searchLayer(key, raw, directSelected) {
    if (key === DIRECT_KEY) {
      const records = await window.CorkCityCKAN.search(raw, geom(), 50);
      return records.map(record => [key, window.CorkCityCKAN.features().find(feature => String(feature.properties.ApplicationNumber) === String(record.ApplicationNumber)) || {
        type: "Feature",
        geometry: { type: "Point", coordinates: [Number(record.Longitude), Number(record.Latitude)] },
        properties: { ...record, PlanningAuthority: "Cork City Council", AreaofSite: record.AreaOfSite }
      }]).filter(item => item[1].geometry.coordinates.every(Number.isFinite));
    }
    if (key === "freehold" && !raw && map.getZoom() < 13) return [];
    const base = whereFor(key, directSelected);
    const where = raw ? `(${base}) AND (${textClause(key, raw)})` : base;
    const dateField = S[key].type === "planning" ? "ReceivedDate" : S[key].type === "acp" ? "LODGEDON" : "";
    const parameters = { where, outFields: "*", returnGeometry: true, outSR: 4326, resultRecordCount: 50, f: "geojson" };
    if (dateField) parameters.orderByFields = `${dateField} DESC`;
    const result = await q(S[key].url, parameters);
    return (result.features || []).map(feature => [key, feature]);
  }

  function itemDate([key, feature]) {
    const properties = feature.properties || {};
    if (S[key].type === "planning") return new Date(properties.ReceivedDate || 0).getTime() || 0;
    if (S[key].type === "acp") return new Date(properties.LODGEDON || 0).getTime() || 0;
    return 0;
  }

  function itemMarkup([key, feature], index) {
    const properties = feature.properties || {};
    if (S[key].type === "planning") {
      return `<button data-i="${index}"><b>${esc(properties.ApplicationNumber || "Planning application")}</b><span>${esc(S[key].label)} · ${esc(date(properties.ReceivedDate))}</span><span>${esc(`${properties.DevelopmentAddress || ""}${properties.PlanningAuthority ? ` · ${properties.PlanningAuthority}` : ""}${properties.NumResidentialUnits != null ? ` · ${fmt(properties.NumResidentialUnits)} units` : ""}`.slice(0, 180))}</span></button>`;
    }
    if (S[key].type === "acp") {
      return `<button data-i="${index}"><b>${esc(properties.ABPCASEID || "ACP case")}</b><span>${esc(S[key].label)} · ${esc(date(properties.LODGEDON))}</span><span>${esc(`${properties.DEVADDRESS || properties.DEVDESC || ""}${properties.CATEGORY ? ` · ${properties.CATEGORY}` : ""}`.slice(0, 180))}</span></button>`;
    }
    return `<button data-i="${index}"><b>${esc(properties.SP_ID || "Freehold parcel")}</b><span>${esc(S[key].label)}</span><span>Cadastral parcel</span></button>`;
  }

  async function searchAll(event) {
    event.preventDefault();
    const raw = document.querySelector("#searchInput")?.value.trim() || "";
    const resultsElement = document.querySelector("#searchResults");
    const statusElement = document.querySelector("#searchStatus");
    const keys = selectedKeys();
    if (!keys.length) {
      resultsElement.innerHTML = '<div class="empty-state">Select at least one layer.</div>';
      statusElement.textContent = "Select one or more layers, then search.";
      return;
    }
    statusElement.textContent = `Searching ${keys.length} selected layers · ${smartSummary()}…`;
    const directSelected = keys.includes(DIRECT_KEY);
    const settled = await Promise.allSettled(keys.map(key => searchLayer(key, raw, directSelected)));
    const failures = [];
    const deduped = new Map();
    settled.forEach((result, index) => {
      const key = keys[index];
      if (result.status !== "fulfilled") {
        failures.push(S[key].label);
        return;
      }
      result.value.forEach(item => {
        const properties = item[1].properties || {};
        const ref = S[key].type === "planning" ? properties.ApplicationNumber : S[key].type === "acp" ? properties.ABPCASEID : properties.SP_ID;
        const dedupeKey = `${S[key].type}:${String(ref || Math.random())}`;
        const existing = deduped.get(dedupeKey);
        if (!existing || key === DIRECT_KEY) deduped.set(dedupeKey, item);
      });
    });
    const items = [...deduped.values()].sort((left, right) => itemDate(right) - itemDate(left));
    resultsElement.innerHTML = items.length ? items.map(itemMarkup).join("") : '<div class="empty-state">No matching records were returned.</div>';
    resultsElement.querySelectorAll("button[data-i]").forEach(button => button.addEventListener("click", () => focus(items[Number(button.dataset.i)])));
    statusElement.textContent = `${items.length} result${items.length === 1 ? "" : "s"}${raw ? ` matching “${raw}”` : ""} · ${smartSummary()}${failures.length ? ` · Unavailable: ${failures.join(", ")}` : ""}.`;
  }

  function replaceButton(id, handler) {
    const oldButton = document.querySelector(`#${id}`);
    if (!oldButton) return null;
    const button = oldButton.cloneNode(true);
    oldButton.replaceWith(button);
    button.addEventListener("click", handler);
    return button;
  }

  function bind() {
    replaceButton("exportViewButton", exportCsv);
    replaceButton("exportWorkbookButton", exportExcel);
    const form = document.querySelector("#searchForm");
    if (form) form.onsubmit = searchAll;
    const label = form?.querySelector("label[for='searchInput']");
    if (label) label.textContent = "Search every selected layer. Cork City uses its direct daily planning datastore; Cork County and other authorities use the national planning layers.";
  }

  window.RadharcCorkTools = { search: searchAll, exportCsv, exportExcel, collectLayers };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
