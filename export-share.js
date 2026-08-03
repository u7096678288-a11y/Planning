"use strict";

(function installExportAndShare() {
  const EXPORT_BATCH_SIZE = 500;
  const MAX_EXPORT_ROWS = 100000;
  const VALID_PERIODS = new Set(["7", "30", "90", "365", "1095", "all", "custom"]);
  const SHARED_BOUNDS_LIMITS = { west: -12.5, south: 50, east: -4, north: 56.5 };

  function showActionMessage(message, mode = "ok") {
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
    clearTimeout(showActionMessage.timer);
    showActionMessage.timer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
  }

  function injectActionStyles() {
    if (document.querySelector("#exportShareStyles")) return;
    const style = document.createElement("style");
    style.id = "exportShareStyles";
    style.textContent = `
      .action-toast{
        position:fixed;right:18px;bottom:18px;z-index:5000;
        max-width:min(390px,calc(100vw - 36px));padding:11px 14px;
        border:1px solid #aac8c5;border-radius:8px;background:#f5fbfa;
        color:#174d50;font-size:12px;line-height:1.4;box-shadow:0 8px 26px rgba(20,47,73,.18);
        opacity:0;transform:translateY(8px);pointer-events:none;transition:.18s ease
      }
      .action-toast[data-mode="error"]{border-color:#d7aaa3;background:#fff6f4;color:#7a3028}
      .action-toast.is-visible{opacity:1;transform:translateY(0)}
      #exportViewButton[aria-busy="true"],#shareViewButton[aria-busy="true"]{cursor:wait;opacity:.72}
    `;
    document.head.append(style);
  }

  function currentGeometry() {
    return geom();
  }

  async function queryObjectIds(url, where, geometry) {
    const result = await q(url, {
      where,
      returnIdsOnly: true,
      returnGeometry: false,
      ...geometry
    });
    return Array.isArray(result.objectIds) ? result.objectIds : [];
  }

  function chunks(values, size) {
    const output = [];
    for (let index = 0; index < values.length; index += size) {
      output.push(values.slice(index, index + size));
    }
    return output;
  }

  async function fetchAttributeBatches(url, objectIds, outFields, progress) {
    const batches = chunks(objectIds, EXPORT_BATCH_SIZE);
    const rows = [];
    for (let index = 0; index < batches.length; index += 1) {
      const result = await q(url, {
        where: "1=1",
        objectIds: batches[index].join(","),
        outFields,
        returnGeometry: false,
        orderByFields: "OBJECTID ASC"
      });
      rows.push(...(result.features || []).map(feature => feature.attributes || {}));
      progress(index + 1, batches.length);
    }
    return rows;
  }

  function isoDateValue(value) {
    if (value == null || value === "") return "";
    const dateValue = new Date(Number.isFinite(Number(value)) ? Number(value) : value);
    if (Number.isNaN(dateValue.getTime())) return String(value);
    return dateValue.toISOString().slice(0, 10);
  }

  function normalisePlanningRecord(attributes, filterSummary) {
    return {
      "Record type": "Planning application",
      "Reference": attributes.ApplicationNumber || "",
      "Received / lodged date": isoDateValue(attributes.ReceivedDate),
      "County / planning authority": attributes.PlanningAuthority || "",
      "Decision": attributes.Decision || "",
      "ACP category": "",
      "Address": attributes.DevelopmentAddress || "",
      "Description": attributes.DevelopmentDescription || "",
      "Residential units": attributes.NumResidentialUnits ?? "",
      "Floor area (m²)": attributes.FloorArea ?? "",
      "Site area (ha)": attributes.AreaofSite ?? "",
      "Active filters": filterSummary
    };
  }

  function normaliseAcpRecord(attributes, filterSummary) {
    return {
      "Record type": "ACP case",
      "Reference": attributes.ABPCASEID || "",
      "Received / lodged date": isoDateValue(attributes.LODGEDON),
      "County / planning authority": attributes.PLANINGATY || "",
      "Decision": attributes.DECISION || "",
      "ACP category": attributes.CATEGORY || "",
      "Address": attributes.DEVADDRESS || "",
      "Description": attributes.DEVDESC || "",
      "Residential units": "",
      "Floor area (m²)": "",
      "Site area (ha)": "",
      "Active filters": filterSummary
    };
  }

  function protectSpreadsheetFormula(value) {
    const stringValue = String(value ?? "");
    return /^[=+\-@]/.test(stringValue) ? `'${stringValue}` : stringValue;
  }

  function csvCell(value) {
    const safe = protectSpreadsheetFormula(value).replaceAll('"', '""');
    return `"${safe}"`;
  }

  function rowsToCsv(rows) {
    const headers = [
      "Record type",
      "Reference",
      "Received / lodged date",
      "County / planning authority",
      "Decision",
      "ACP category",
      "Address",
      "Description",
      "Residential units",
      "Floor area (m²)",
      "Site area (ha)",
      "Active filters"
    ];
    return [
      headers.map(csvCell).join(","),
      ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))
    ].join("\r\n");
  }

  function downloadCsv(csv, rowCount) {
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `radharc-pleanala-${stamp}-${rowCount}-records.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportCurrentView() {
    const button = document.querySelector("#exportViewButton");
    if (!button) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Preparing export…";
    status("Preparing filtered export");

    try {
      const geometry = currentGeometry();
      const planningWhere = smartPlanningWhere();
      const acpWhere = smartAcpWhere();
      const filterSummary = smartSummary();
      const [planningIds, acpIds] = await Promise.all([
        queryObjectIds(S.planningPoints.url, planningWhere, geometry),
        queryObjectIds(S.acpCases.url, acpWhere, geometry)
      ]);
      const totalRows = planningIds.length + acpIds.length;

      if (!totalRows) {
        showActionMessage("No records match the current map area and filters.", "error");
        status("Dashboard fully synced", "ok");
        return;
      }
      if (totalRows > MAX_EXPORT_ROWS) {
        showActionMessage(`The current view contains ${fmt(totalRows)} records. Narrow the map area or filters below ${fmt(MAX_EXPORT_ROWS)} records before exporting.`, "error");
        status("Export needs narrower filters", "error");
        return;
      }

      let completedBatches = 0;
      const totalBatches = Math.ceil(planningIds.length / EXPORT_BATCH_SIZE) + Math.ceil(acpIds.length / EXPORT_BATCH_SIZE);
      const progress = () => {
        completedBatches += 1;
        button.textContent = `Exporting ${Math.min(completedBatches, totalBatches)}/${totalBatches}…`;
      };

      const [planningAttributes, acpAttributes] = await Promise.all([
        fetchAttributeBatches(
          S.planningPoints.url,
          planningIds,
          "OBJECTID,ApplicationNumber,ReceivedDate,PlanningAuthority,Decision,DevelopmentAddress,DevelopmentDescription,NumResidentialUnits,FloorArea,AreaofSite",
          progress
        ),
        fetchAttributeBatches(
          S.acpCases.url,
          acpIds,
          "OBJECTID,ABPCASEID,LODGEDON,PLANINGATY,DECISION,CATEGORY,DEVADDRESS,DEVDESC",
          progress
        )
      ]);

      const rows = [
        ...planningAttributes.map(attributes => normalisePlanningRecord(attributes, filterSummary)),
        ...acpAttributes.map(attributes => normaliseAcpRecord(attributes, filterSummary))
      ].sort((left, right) => String(right["Received / lodged date"]).localeCompare(String(left["Received / lodged date"])));

      downloadCsv(rowsToCsv(rows), rows.length);
      showActionMessage(`${fmt(rows.length)} filtered records exported as CSV.`);
      status("Dashboard fully synced", "ok");
    } catch (error) {
      console.error(error);
      showActionMessage("The export could not be completed. Try a smaller map area or refresh the data.", "error");
      status("Export failed", "error");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Export CSV";
    }
  }

  function activeLayerKeys() {
    return Object.keys(layers).filter(key => map.hasLayer(layers[key]));
  }

  function addRepeatedParams(params, key, values) {
    values.forEach(value => params.append(key, value));
  }

  function buildShareUrl() {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    const params = url.searchParams;
    params.set("view", "1");

    const period = document.querySelector("#dateRange")?.value || "365";
    params.set("period", period);
    if (smartState.customDates?.start) params.set("from", smartState.customDates.start);
    if (smartState.customDates?.end) params.set("to", smartState.customDates.end);

    addRepeatedParams(params, "decision", smartState.decision);
    addRepeatedParams(params, "authority", smartState.authority);
    addRepeatedParams(params, "category", smartState.category);

    const bounds = map.getBounds();
    params.set("bbox", [
      bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()
    ].map(value => value.toFixed(5)).join(","));
    params.set("layers", activeLayerKeys().join(","));

    const searchText = document.querySelector("#searchInput")?.value.trim();
    if (searchText) params.set("search", searchText);
    return url.toString();
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  async function shareCurrentView() {
    const button = document.querySelector("#shareViewButton");
    if (!button) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    const shareUrl = buildShareUrl();

    try {
      if (navigator.share) {
        await navigator.share({
          title: "Radharc Pleanála",
          text: `Irish planning dashboard view · ${smartSummary()}`,
          url: shareUrl
        });
        showActionMessage("Dashboard view shared.");
      } else {
        await copyText(shareUrl);
        showActionMessage("Share link copied to the clipboard.");
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        console.error(error);
        try {
          await copyText(shareUrl);
          showActionMessage("Share link copied to the clipboard.");
        } catch (copyError) {
          console.error(copyError);
          showActionMessage("The share link could not be copied.", "error");
        }
      }
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  function safeSharedBounds(value) {
    if (!value) return null;
    const values = value.split(",").map(Number);
    if (values.length !== 4 || values.some(number => !Number.isFinite(number))) return null;
    const [west, south, east, north] = values;
    if (west >= east || south >= north) return null;
    if (
      west < SHARED_BOUNDS_LIMITS.west || south < SHARED_BOUNDS_LIMITS.south ||
      east > SHARED_BOUNDS_LIMITS.east || north > SHARED_BOUNDS_LIMITS.north
    ) return null;
    return [[south, west], [north, east]];
  }

  function restoreLayerState(layerParam) {
    if (layerParam == null) return;
    const requested = new Set(layerParam.split(",").filter(key => Object.hasOwn(layers, key)));
    Object.entries(layers).forEach(([key, layer]) => {
      if (requested.has(key) && !map.hasLayer(layer)) layer.addTo(map);
      if (!requested.has(key) && map.hasLayer(layer)) map.removeLayer(layer);
      const checkbox = document.querySelector(`#layerToggles input[data-k="${key}"]`);
      if (checkbox) checkbox.checked = requested.has(key);
    });
  }

  function restoreSharedView() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") !== "1") return;

    const period = VALID_PERIODS.has(params.get("period")) ? params.get("period") : "365";
    const dateRange = document.querySelector("#dateRange");
    const startDate = document.querySelector("#customStartDate");
    const endDate = document.querySelector("#customEndDate");
    const dateStatus = document.querySelector("#customDateStatus");

    if (period === "custom") {
      const start = /^\d{4}-\d{2}-\d{2}$/.test(params.get("from") || "") ? params.get("from") : "";
      const end = /^\d{4}-\d{2}-\d{2}$/.test(params.get("to") || "") ? params.get("to") : "";
      if (start || end) {
        smartState.customDates = { start, end };
        if (dateRange) dateRange.value = "custom";
        if (startDate) startDate.value = start;
        if (endDate) endDate.value = end;
        if (dateStatus) dateStatus.textContent = `Shared period: ${smartPeriodLabel()}.`;
      }
    } else {
      smartState.customDates = null;
      smartState.lastPreset = period;
      if (dateRange) dateRange.value = period;
      if (startDate) startDate.value = "";
      if (endDate) endDate.value = "";
      if (dateStatus) dateStatus.textContent = `Shared period: ${periodLabel()}.`;
    }

    smartState.decision = [...new Set(params.getAll("decision").filter(Boolean))];
    smartState.authority = [...new Set(params.getAll("authority").filter(Boolean))];
    smartState.category = [...new Set(params.getAll("category").filter(Boolean))];
    ["decision", "authority", "category"].forEach(smartSyncSelect);

    const searchText = params.get("search") || "";
    const searchInput = document.querySelector("#searchInput");
    if (searchInput) searchInput.value = searchText;

    restoreLayerState(params.get("layers"));
    const bounds = safeSharedBounds(params.get("bbox"));
    if (bounds) map.fitBounds(bounds, { animate: false });

    smartApplyLayerFilters();
    smartUpdateSummary();
    const searchStatus = document.querySelector("#searchStatus");
    if (searchStatus) {
      searchStatus.textContent = searchText
        ? "Shared search restored. Press Search to list matching records."
        : "Shared dashboard view restored. Press Search to list records.";
    }
    update();
    showActionMessage("Shared dashboard view restored.");
  }

  function bindActions() {
    injectActionStyles();
    document.querySelector("#exportViewButton")?.addEventListener("click", exportCurrentView);
    document.querySelector("#shareViewButton")?.addEventListener("click", shareCurrentView);
    restoreSharedView();
  }

  document.addEventListener("DOMContentLoaded", bindActions);
})();