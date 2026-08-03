"use strict";

(function installWorkbookExport() {
  const T = window.RadharcTools = window.RadharcTools || {};
  const BATCH_SIZE = 200;
  const CONCURRENCY = 3;
  const MAX_LAYER_ROWS = 60000;
  const MAX_TOTAL_ROWS = 120000;
  const SHEETS = {
    planningPoints: "Planning Points",
    planningSites: "Planning Sites",
    acpCases: "ACP Cases",
    freehold: "Freehold Parcels"
  };

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

  async function postQuery(url, parameters = {}) {
    const body = new URLSearchParams();
    Object.entries({ f: "json", ...parameters }).forEach(([key, value]) => {
      if (value == null) return;
      body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
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

  function selectedKeys() {
    const keys = window.RadharcDashboard?.selectedLayerKeys?.()
      || [...document.querySelectorAll('#layerToggles input[data-k]:checked:not(:disabled)')].map(input => input.dataset.k);
    if (window.RadharcResidentialUnits?.isActive?.()) return keys.filter(key => S[key]?.type === "planning");
    return keys;
  }

  function whereFor(key) {
    if (S[key].type === "planning") return smartPlanningWhere();
    if (S[key].type === "acp") return smartAcpWhere();
    return "1=1";
  }

  async function objectIds(key, geometry) {
    if (key === "freehold" && map.getZoom() < 13) {
      return { ids: [], skipped: "Zoom to level 13 or closer to export freehold parcels." };
    }
    const data = await postQuery(S[key].url, {
      where: whereFor(key),
      returnIdsOnly: true,
      returnGeometry: false,
      ...geometry
    });
    return { ids: [...new Set(data.objectIds || [])], skipped: "" };
  }

  function chunks(values, size) {
    const output = [];
    for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
    return output;
  }

  async function fetchRows(key, ids, progress) {
    if (!ids.length) return [];
    const batches = chunks(ids, BATCH_SIZE);
    const rows = [];
    let cursor = 0;
    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= batches.length) return;
        const data = await postQuery(S[key].url, {
          where: "1=1",
          objectIds: batches[index].join(","),
          outFields: "*",
          returnGeometry: false
        });
        const attributes = (data.features || []).map(feature => feature.attributes || {});
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

  function normaliseRow(key, attributes) {
    const row = {};
    Object.entries(attributes).forEach(([field, value]) => {
      if (field === "ReceivedDate" || field === "LODGEDON") row[field] = normaliseDate(value);
      else row[field] = safeCell(value);
    });
    row.ExportLayer = S[key].label;
    row.ActiveFilters = smartSummary();
    return row;
  }

  function setSheetLayout(sheet, rows) {
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length), c: headers.length - 1 } }) };
    sheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" };
    sheet["!cols"] = headers.map(header => {
      let width = Math.max(10, header.length + 2);
      rows.slice(0, 250).forEach(row => { width = Math.max(width, String(row[header] ?? "").length + 2); });
      return { wch: Math.min(42, width) };
    });
  }

  function summaryRows(layerResults, geometry) {
    const parsedGeometry = JSON.parse(geometry.geometry);
    const rows = [
      ["Radharc Pleanála export", "Layered research workbook"],
      ["Generated", new Date().toLocaleString("en-IE")],
      ["Active filters", smartSummary()],
      ["Map west", parsedGeometry.xmin],
      ["Map south", parsedGeometry.ymin],
      ["Map east", parsedGeometry.xmax],
      ["Map north", parsedGeometry.ymax],
      [],
      ["Layer", "Selected", "Records", "Status", "Source"]
    ];
    Object.keys(S).forEach(key => {
      const result = layerResults[key];
      rows.push([
        S[key].label,
        result ? "Yes" : "No",
        result?.rows?.length ?? 0,
        result?.error ? `Failed: ${result.error}` : result?.skipped || (result ? "Exported" : "Not selected"),
        S[key].url
      ]);
    });
    return rows;
  }

  async function exportWorkbook() {
    const button = document.querySelector("#exportWorkbookButton");
    if (!button) return;
    const previous = button.textContent;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Preparing Excel…";

    try {
      await loadSheetJs();
      const keys = selectedKeys();
      if (!keys.length) throw new Error("Select at least one data layer before exporting.");
      const geometry = geom();
      const idResults = {};
      for (const key of keys) {
        try { idResults[key] = await objectIds(key, geometry); }
        catch (error) { idResults[key] = { ids: [], skipped: "", error: T.errorMessage?.(error) || error.message }; }
      }

      const totalIds = Object.values(idResults).reduce((sum, result) => sum + (result.ids?.length || 0), 0);
      const oversized = Object.entries(idResults).find(([, result]) => (result.ids?.length || 0) > MAX_LAYER_ROWS);
      if (oversized) throw new Error(`${S[oversized[0]].label} contains ${fmt(oversized[1].ids.length)} records. Narrow the map or filters below ${fmt(MAX_LAYER_ROWS)} records for that layer.`);
      if (totalIds > MAX_TOTAL_ROWS) throw new Error(`The selected layers contain ${fmt(totalIds)} records. Narrow the map or filters below ${fmt(MAX_TOTAL_ROWS)} total records.`);

      let loaded = 0;
      const progress = count => {
        loaded += count;
        button.textContent = `Building Excel ${fmt(loaded)}/${fmt(totalIds)}…`;
      };
      const layerResults = {};
      for (const key of keys) {
        const ids = idResults[key].ids || [];
        if (idResults[key].error) {
          layerResults[key] = { rows: [], error: idResults[key].error, skipped: "" };
          continue;
        }
        if (idResults[key].skipped) {
          layerResults[key] = { rows: [], error: "", skipped: idResults[key].skipped };
          continue;
        }
        try {
          const attributes = await fetchRows(key, ids, progress);
          layerResults[key] = { rows: attributes.map(row => normaliseRow(key, row)), error: "", skipped: "" };
        } catch (error) {
          layerResults[key] = { rows: [], error: T.errorMessage?.(error) || error.message, skipped: "" };
        }
      }

      const workbook = XLSX.utils.book_new();
      const summary = XLSX.utils.aoa_to_sheet(summaryRows(layerResults, geometry));
      summary["!cols"] = [{ wch: 30 }, { wch: 60 }, { wch: 14 }, { wch: 42 }, { wch: 80 }];
      XLSX.utils.book_append_sheet(workbook, summary, "Summary");

      let exportedRows = 0;
      keys.forEach(key => {
        const result = layerResults[key];
        if (!result || (!result.rows.length && result.skipped)) return;
        const rows = result.rows.length ? result.rows : [{ Status: result.error || "No matching records", ActiveFilters: smartSummary() }];
        exportedRows += result.rows.length;
        const sheet = XLSX.utils.json_to_sheet(rows);
        setSheetLayout(sheet, rows);
        XLSX.utils.book_append_sheet(workbook, sheet, SHEETS[key]);
      });

      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(workbook, `radharc-pleanala-layer-export-${stamp}.xlsx`, { compression: true });
      const failures = Object.entries(layerResults).filter(([, result]) => result.error).map(([key]) => S[key].label);
      T.showMessage?.(
        failures.length
          ? `${fmt(exportedRows)} records exported. Unavailable layers: ${failures.join(", ")}.`
          : `${fmt(exportedRows)} records exported to a layered Excel workbook.`,
        failures.length ? "error" : "ok",
        8000
      );
    } catch (error) {
      console.error("Workbook export failed", error);
      T.showMessage?.(`Excel export failed: ${T.errorMessage?.(error) || error.message}`, "error", 9000);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = previous;
    }
  }

  function injectButton() {
    if (document.querySelector("#exportWorkbookButton")) return;
    const csv = document.querySelector("#exportViewButton");
    if (!csv) return;
    const button = document.createElement("button");
    button.id = "exportWorkbookButton";
    button.className = "secondary-button";
    button.type = "button";
    button.textContent = "Export Excel";
    csv.after(button);
    button.addEventListener("click", exportWorkbook);
  }

  window.RadharcWorkbookExport = { export: exportWorkbook };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectButton, { once: true });
  else injectButton();
})();
