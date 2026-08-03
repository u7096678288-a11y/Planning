"use strict";

(function installShareLinks() {
  const T = window.RadharcTools = window.RadharcTools || {};
  const VALID_PERIODS = new Set(["7", "30", "90", "365", "1095", "all", "custom"]);
  const LIMITS = { west: -12.5, south: 50, east: -4, north: 56.5 };

  function activeLayerKeys() {
    return Object.keys(layers).filter(key => map.hasLayer(layers[key]));
  }

  function repeated(params, key, values) {
    values.forEach(value => params.append(key, value));
  }

  T.buildShareUrl = function buildShareUrl() {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    const params = url.searchParams;
    params.set("view", "1");
    const period = document.querySelector("#dateRange")?.value || "365";
    params.set("period", period);
    if (smartState.customDates?.start) params.set("from", smartState.customDates.start);
    if (smartState.customDates?.end) params.set("to", smartState.customDates.end);
    repeated(params, "decision", smartState.decision);
    repeated(params, "authority", smartState.authority);
    repeated(params, "category", smartState.category);
    const bounds = map.getBounds();
    params.set("bbox", [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map(value => value.toFixed(5)).join(","));
    params.set("layers", activeLayerKeys().join(","));
    const searchText = document.querySelector("#searchInput")?.value.trim();
    if (searchText) params.set("search", searchText);
    return url.toString();
  };

  T.shareDashboardLink = async function shareDashboardLink() {
    const url = T.buildShareUrl();
    try {
      if (navigator.share) {
        await navigator.share({ title: "Radharc Pleanála", text: `Irish planning dashboard view · ${smartSummary()}`, url });
        T.showMessage("Dashboard view shared.");
      } else {
        await T.copyText(url);
        T.showMessage("Share link copied to the clipboard.");
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        await T.copyText(url);
        T.showMessage("Share link copied to the clipboard.");
      }
    }
  };

  T.emailDashboardLink = function emailDashboardLink() {
    const url = T.buildShareUrl();
    T.openEmail("Radharc Pleanála dashboard view", `Here is a filtered Irish planning dashboard view.\n\n${smartSummary()}\n\n${url}`);
  };

  function safeBounds(value) {
    if (!value) return null;
    const numbers = value.split(",").map(Number);
    if (numbers.length !== 4 || numbers.some(number => !Number.isFinite(number))) return null;
    const [west, south, east, north] = numbers;
    if (west >= east || south >= north) return null;
    if (west < LIMITS.west || south < LIMITS.south || east > LIMITS.east || north > LIMITS.north) return null;
    return [[south, west], [north, east]];
  }

  function restoreLayers(value) {
    if (value == null) return;
    const requested = new Set(value.split(",").filter(key => Object.hasOwn(layers, key)));
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
    restoreLayers(params.get("layers"));
    const bounds = safeBounds(params.get("bbox"));
    if (bounds) map.fitBounds(bounds, { animate: false });
    smartApplyLayerFilters();
    smartUpdateSummary();
    const searchStatus = document.querySelector("#searchStatus");
    if (searchStatus) searchStatus.textContent = searchText ? "Shared search restored. Press Search to list matching records." : "Shared dashboard view restored. Press Search to list records.";
    update();
    T.showMessage("Shared dashboard view restored.");
  }

  T.onReady(restoreSharedView);
})();