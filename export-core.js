"use strict";

(function installExportCore() {
  const T = window.RadharcTools = window.RadharcTools || {};
  const BATCH_SIZE = 200;
  const CONCURRENCY = 3;
  const MIN_BATCH = 12;
  const MAX_ROWS = 100000;

  T.onReady = T.onReady || (callback => {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", callback, { once: true });
    else callback();
  });

  T.showMessage = function showMessage(message, mode = "ok", duration = 4300) {
    let toast = document.querySelector("#actionToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "actionToast";
      toast.className = "action-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.append(toast);
    }
    toast.textContent = message;
    toast.dataset.mode = mode;
    toast.classList.add("is-visible");
    clearTimeout(T.showMessage.timer);
    T.showMessage.timer = setTimeout(() => toast.classList.remove("is-visible"), duration);
  };

  T.injectCommonStyles = function injectCommonStyles() {
    if (document.querySelector("#exportShareStyles")) return;
    const style = document.createElement("style");
    style.id = "exportShareStyles";
    style.textContent = `
      .action-toast{position:fixed;right:18px;bottom:18px;z-index:5000;max-width:min(440px,calc(100vw - 36px));padding:11px 14px;border:1px solid #aac8c5;border-radius:8px;background:#f5fbfa;color:#174d50;font-size:12px;line-height:1.4;box-shadow:0 8px 26px rgba(20,47,73,.18);opacity:0;transform:translateY(8px);pointer-events:none;transition:.18s ease}
      .action-toast[data-mode="error"]{border-color:#d7aaa3;background:#fff6f4;color:#7a3028}
      .action-toast.is-visible{opacity:1;transform:translateY(0)}
      #exportViewButton[aria-busy="true"],#shareViewButton[aria-busy="true"]{cursor:wait;opacity:.7}
    `;
    document.head.append(style);
  };

  T.errorMessage = error => String(error?.message || error || "Unknown error").replace(/\s+/g, " ").slice(0, 220);

  T.downloadBlob = function downloadBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  };

  T.copyText = async function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  };

  T.openEmail = function openEmail(subject, body) {
    const link = document.createElement("a");
    link.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
  };

  async function postQuery(url, parameters = {}) {
    const body = new URLSearchParams();
    const payload = { f: "json", cacheHint: "false", ...parameters, _ts: Date.now() };
    Object.entries(payload).forEach(([key, value]) => {
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
    if (data.error) {
      const details = Array.isArray(data.error.details) ? data.error.details.filter(Boolean).join(" · ") : "";
      throw new Error([data.error.message, details].filter(Boolean).join(" · "));
    }
    return data;
  }

  async function objectIds(url, where, geometry) {
    const result = await postQuery(url, { where, returnIdsOnly: true, returnGeometry: false, ...geometry });
    return [...new Set(Array.isArray(result.objectIds) ? result.objectIds : [])];
  }

  function chunks(values, size) {
    const output = [];
    for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
    return output;
  }

  async function validFields(url, requested) {
    try {
      const metadata = await layerInfo(url);
      const available = new Set((metadata.fields || []).map(field => field.name));
      const fields = requested.filter(field => available.has(field));
      return fields.length ? fields.join(",") : "*";
    } catch {
      return requested.join(",");
    }
  }

  async function fetchAdaptive(url, ids, outFields) {
    try {
      const result = await postQuery(url, { where: "1=1", objectIds: ids.join(","), outFields, returnGeometry: false });
      return (result.features || []).map(feature => feature.attributes || {});
    } catch (error) {
      if (ids.length <= MIN_BATCH) throw error;
      const middle = Math.ceil(ids.length / 2);
      const [left, right] = await Promise.all([
        fetchAdaptive(url, ids.slice(0, middle), outFields),
        fetchAdaptive(url, ids.slice(middle), outFields)
      ]);
      return [...left, ...right];
    }
  }

  async function fetchRows(url, ids, requestedFields, progress) {
    if (!ids.length) return [];
    const outFields = await validFields(url, requestedFields);
    const batches = chunks(ids, BATCH_SIZE);
    const rows = [];
    let cursor = 0;
    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= batches.length) return;
        const attributes = await fetchAdaptive(url, batches[index], outFields);
        rows.push(...attributes);
        progress(attributes.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    return rows;
  }

  function dateValue(value) {
    if (value == null || value === "") return "";
    const numeric = Number(value);
    const parsed = new Date(Number.isFinite(numeric) ? numeric : value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString().slice(0, 10);
  }

  function planningRow(a, summary) {
    return {
      "Record type": "Planning application", "Reference": a.ApplicationNumber || "",
      "Received / lodged date": dateValue(a.ReceivedDate), "County / planning authority": a.PlanningAuthority || "",
      "Decision": a.Decision || "", "ACP category": "", "Address": a.DevelopmentAddress || "",
      "Description": a.DevelopmentDescription || "", "Residential units": a.NumResidentialUnits ?? "",
      "Floor area (m²)": a.FloorArea ?? "", "Site area (ha)": a.AreaofSite ?? "", "Active filters": summary
    };
  }

  function acpRow(a, summary) {
    return {
      "Record type": "ACP case", "Reference": a.ABPCASEID || "",
      "Received / lodged date": dateValue(a.LODGEDON), "County / planning authority": a.PLANINGATY || "",
      "Decision": a.DECISION || "", "ACP category": a.CATEGORY || "", "Address": a.DEVADDRESS || "",
      "Description": a.DEVDESC || "", "Residential units": "", "Floor area (m²)": "",
      "Site area (ha)": "", "Active filters": summary
    };
  }

  function csvCell(value) {
    let text = String(value ?? "");
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }

  function csv(rows) {
    const headers = ["Record type", "Reference", "Received / lodged date", "County / planning authority", "Decision", "ACP category", "Address", "Description", "Residential units", "Floor area (m²)", "Site area (ha)", "Active filters"];
    return [headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n");
  }

  async function getSource(name, url, where, geometry) {
    try { return { name, ids: await objectIds(url, where, geometry), error: null }; }
    catch (error) { return { name, ids: [], error }; }
  }

  async function materialise(source, url, fields, normalise, summary, progress) {
    if (!source.ids.length) return { name: source.name, rows: [], error: source.error };
    try {
      const attributes = await fetchRows(url, source.ids, fields, progress);
      return { name: source.name, rows: attributes.map(row => normalise(row, summary)), error: source.error };
    } catch (error) {
      return { name: source.name, rows: [], error };
    }
  }

  async function exportCsv() {
    const button = document.querySelector("#exportViewButton");
    if (!button) return;
    const previousStatus = document.querySelector("#connectionStatus")?.textContent || "Dashboard ready";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Preparing export…";
    status("Preparing filtered export");
    try {
      const geometry = geom();
      const summary = smartSummary();
      const [planning, acp] = await Promise.all([
        getSource("Planning", S.planningPoints.url, smartPlanningWhere(), geometry),
        getSource("ACP", S.acpCases.url, smartAcpWhere(), geometry)
      ]);
      const total = planning.ids.length + acp.ids.length;
      const idFailures = [planning, acp].filter(source => source.error);
      if (!total) {
        if (idFailures.length === 2) throw new Error(`Both feeds failed: ${idFailures.map(source => `${source.name}: ${T.errorMessage(source.error)}`).join(" | ")}`);
        T.showMessage("No records match the current map area and filters.", "error");
        return;
      }
      if (total > MAX_ROWS) {
        T.showMessage(`The current view contains ${fmt(total)} records. Narrow the map area or filters below ${fmt(MAX_ROWS)} records.`, "error", 7000);
        return;
      }
      let loaded = 0;
      const progress = count => {
        loaded += count;
        button.textContent = `Exporting ${fmt(Math.min(loaded, total))}/${fmt(total)}…`;
      };
      const [planningResult, acpResult] = await Promise.all([
        materialise(planning, S.planningPoints.url, ["OBJECTID", "ApplicationNumber", "ReceivedDate", "PlanningAuthority", "Decision", "DevelopmentAddress", "DevelopmentDescription", "NumResidentialUnits", "FloorArea", "AreaofSite"], planningRow, summary, progress),
        materialise(acp, S.acpCases.url, ["OBJECTID", "ABPCASEID", "LODGEDON", "PLANINGATY", "DECISION", "CATEGORY", "DEVADDRESS", "DEVDESC"], acpRow, summary, progress)
      ]);
      const rows = [...planningResult.rows, ...acpResult.rows].sort((a, b) => String(b["Received / lodged date"]).localeCompare(String(a["Received / lodged date"])));
      const failures = [planningResult, acpResult].filter(source => source.error);
      if (!rows.length) throw new Error(failures.map(source => `${source.name}: ${T.errorMessage(source.error)}`).join(" | ") || "No rows returned");
      T.downloadBlob(new Blob([`\uFEFF${csv(rows)}`], { type: "text/csv;charset=utf-8" }), `radharc-pleanala-${new Date().toISOString().slice(0, 10)}-${rows.length}-records.csv`);
      if (failures.length) T.showMessage(`${fmt(rows.length)} records exported. ${failures.map(source => source.name).join(" and ")} could not be included.`, "error", 7000);
      else T.showMessage(`${fmt(rows.length)} filtered records exported as CSV.`);
    } catch (error) {
      console.error("Export failed", error);
      T.showMessage(`Export failed: ${T.errorMessage(error)}`, "error", 8000);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Export CSV";
      status(previousStatus, /failed|partly/i.test(previousStatus) ? "error" : "ok");
    }
  }

  T.onReady(() => {
    T.injectCommonStyles();
    document.querySelector("#exportViewButton")?.addEventListener("click", exportCsv);
  });
})();