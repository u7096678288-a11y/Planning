"use strict";

(function installReloadDefaults() {
  const navigation = performance.getEntriesByType?.("navigation")?.[0];
  const isReload = navigation?.type === "reload" || performance.navigation?.type === 1;
  if (!isReload) return;

  const params = new URLSearchParams(window.location.search);
  const hasRestoredDashboardView = params.get("view") === "1"
    || ["authority", "decision", "category", "bbox", "period", "from", "to", "layers", "search", "residential", "minUnits"]
      .some(key => params.has(key));

  if (hasRestoredDashboardView || window.location.hash) {
    history.replaceState(null, "", window.location.pathname);
  }

  const range = document.querySelector("#dateRange");
  const startInput = document.querySelector("#customStartDate");
  const endInput = document.querySelector("#customEndDate");
  const dateStatus = document.querySelector("#customDateStatus");
  const searchInput = document.querySelector("#searchInput");
  const searchResults = document.querySelector("#searchResults");
  const searchStatus = document.querySelector("#searchStatus");

  if (range) range.value = "365";
  if (startInput) startInput.value = "";
  if (endInput) endInput.value = "";
  if (dateStatus) dateStatus.textContent = "Showing the last 12 months across all planning authorities.";
  if (searchInput) searchInput.value = "";
  if (searchResults) searchResults.innerHTML = "";
  if (searchStatus) searchStatus.textContent = "All planning authorities are included. Press Search to list records from the last 12 months.";

  smartState.customDates = null;
  smartState.lastPreset = "365";
  smartState.decision = [];
  smartState.authority = [];
  smartState.category = [];
  smartState.residentialOnly = false;
  smartState.minUnits = null;

  try {
    map.fitBounds([[51.2, -10.9], [55.6, -5.2]], { animate: false, padding: [8, 8] });
  } catch (error) {
    console.warn("Ireland-wide reload view could not be applied", error);
  }

  try {
    ["decision", "authority", "category"].forEach(smartSyncSelect);
    window.RadharcResidentialUnits?.syncUi?.();
    smartApplyLayerFilters();
    smartUpdateSummary();
    update();
  } catch (error) {
    console.warn("Reload defaults could not be fully applied", error);
  }

  window.RadharcReloadDefaultsApplied = true;
})();