"use strict";

(function installResidentialUnitsFilter() {
  const FIELD = "NumResidentialUnits";

  smartState.residentialOnly = Boolean(smartState.residentialOnly);
  smartState.minUnits = Number.isInteger(smartState.minUnits) ? Math.max(1, smartState.minUnits) : null;
  delete smartState.maxUnits;

  const basePlanningWhere = smartPlanningWhere;
  const baseSummary = smartSummary;
  const baseUpdateSummary = smartUpdateSummary;

  function isActive() {
    return smartState.residentialOnly || smartState.minUnits != null;
  }

  function effectiveMinimum() {
    return smartState.minUnits != null ? Math.max(1, smartState.minUnits) : (isActive() ? 1 : null);
  }

  function unitsClause() {
    if (!isActive()) return "";
    return `${FIELD} IS NOT NULL AND ${FIELD} >= ${effectiveMinimum()}`;
  }

  smartPlanningWhere = function residentialPlanningWhere(exclude = "") {
    const base = basePlanningWhere(exclude);
    const units = unitsClause();
    return units ? `(${base}) AND (${units})` : base;
  };

  function rangeLabel() {
    return isActive() ? `${fmt(effectiveMinimum())}+ residential units` : "All planning applications";
  }

  smartSummary = function residentialSummary() {
    const base = baseSummary();
    return isActive() ? `${base} · Planning units: ${rangeLabel()}` : base;
  };

  function restoreLayerControls() {
    ["acpCases", "freehold"].forEach(key => {
      const input = document.querySelector(`#layerToggles input[data-k="${key}"]`);
      if (!input) return;
      input.disabled = false;
      if (input.checked && !map.hasLayer(layers[key])) layers[key].addTo(map);
      if (!input.checked && map.hasLayer(layers[key])) map.removeLayer(layers[key]);
    });
  }

  smartUpdateSummary = function residentialUpdateSummary() {
    baseUpdateSummary();
    const clear = document.querySelector("#clearSmartFilters");
    if (clear) {
      const hasAny = smartState.decision.length || smartState.authority.length || smartState.category.length || isActive();
      clear.disabled = !hasAny;
    }
    restoreLayerControls();
    updateUi();
  };

  function integerValue(input) {
    const raw = input?.value.trim();
    if (!raw) return null;
    const number = Number(raw);
    return Number.isInteger(number) && number >= 1 ? number : NaN;
  }

  function clearResults(message) {
    const results = document.querySelector("#searchResults");
    const statusText = document.querySelector("#searchStatus");
    if (results) results.innerHTML = "";
    if (statusText) statusText.textContent = message;
    map?.closePopup();
  }

  function updateUi() {
    const checkbox = document.querySelector("#residentialOnlyFilter");
    const minimum = document.querySelector("#minimumResidentialUnits");
    const badge = document.querySelector("#residentialUnitsBadge");
    const statusText = document.querySelector("#residentialUnitsStatus");
    const clear = document.querySelector("#clearResidentialUnits");

    if (checkbox) checkbox.checked = smartState.residentialOnly;
    if (minimum && document.activeElement !== minimum) minimum.value = smartState.minUnits ?? "";
    if (badge) badge.textContent = isActive() ? rangeLabel() : "All applications";
    if (clear) clear.disabled = !isActive();
    if (statusText) {
      statusText.textContent = isActive()
        ? `Planning points and planning sites are filtered to ${rangeLabel().toLowerCase()}. Selected ACP and freehold layers remain visible and keep their own filters.`
        : "Enter a minimum threshold or use Residential only to exclude planning applications with no reported residential units.";
    }
  }

  function applyState({ residentialOnly, minimum }, source = "Units filter") {
    const min = minimum == null ? null : Number(minimum);
    if (min != null && (!Number.isInteger(min) || min < 1)) {
      throw new Error("Minimum units must be a whole number of one or more.");
    }

    smartState.residentialOnly = Boolean(residentialOnly);
    smartState.minUnits = min;
    smartApplyLayerFilters();
    restoreLayerControls();
    smartUpdateSummary();
    clearResults(`${source} applied. Press Search to list records for ${smartSummary()}.`);
    update();
  }

  function applyFromControls() {
    const checkbox = document.querySelector("#residentialOnlyFilter");
    const minimumInput = document.querySelector("#minimumResidentialUnits");
    const statusText = document.querySelector("#residentialUnitsStatus");
    const minimum = integerValue(minimumInput);

    if (Number.isNaN(minimum)) {
      if (statusText) statusText.textContent = "Use a whole minimum unit number of one or more.";
      return;
    }

    try {
      applyState({ residentialOnly: Boolean(checkbox?.checked), minimum });
    } catch (error) {
      if (statusText) statusText.textContent = error.message;
    }
  }

  function clearUnitsFilter(source = "Residential-units filter cleared") {
    smartState.residentialOnly = false;
    smartState.minUnits = null;
    smartApplyLayerFilters();
    restoreLayerControls();
    smartUpdateSummary();
    clearResults(`${source}. Press Search to list records.`);
  }

  function injectStyles() {
    if (document.querySelector("#residentialUnitsFilterStyles")) return;
    const style = document.createElement("style");
    style.id = "residentialUnitsFilterStyles";
    style.textContent = `
      .residential-filter-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px}
      .residential-filter-heading h2{margin:0}.residential-filter-badge{max-width:170px;border:1px solid #d1e2e1;border-radius:999px;background:#eef5f5;color:#315d61;padding:5px 8px;font-size:10px;font-weight:700;text-align:center}
      .residential-toggle{display:flex;align-items:center;gap:8px;margin:0 0 10px;padding:9px;border:1px solid #d5e0e5;border-radius:7px;background:#f5f9f9;color:#193247;font-size:11px;font-weight:700;cursor:pointer}
      .residential-toggle input{margin:0;accent-color:#146f79}
      .residential-unit-grid{display:grid;grid-template-columns:1fr;gap:8px}
      .residential-unit-grid label{margin:0;font-size:10px;color:#506875;font-weight:700}
      .residential-unit-grid input{width:100%;margin-top:5px;border:1px solid #b8c8d0;border-radius:6px;padding:9px;background:#fff;color:#132538;font-size:12px}
      .residential-unit-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}
      .residential-unit-actions button{border:1px solid #b8c8d0;border-radius:6px;background:#fff;color:#132538;padding:8px;font-size:11px;font-weight:700}
      .residential-unit-actions .primary{background:#102f49;color:#fff;border-color:#102f49}
      .residential-unit-actions button:disabled{opacity:.45;cursor:not-allowed}
      .residential-unit-status{min-height:30px;margin:8px 0 0;color:#607783;font-size:10px;line-height:1.45}
    `;
    document.head.append(style);
  }

  function injectPanel() {
    if (document.querySelector("#residentialUnitsPanel")) return;
    const searchSection = document.querySelector("#searchForm")?.closest(".panel-section");
    if (!searchSection) return;
    const panel = document.createElement("section");
    panel.id = "residentialUnitsPanel";
    panel.className = "panel-section";
    panel.innerHTML = `
      <div class="residential-filter-heading">
        <h2>Residential units</h2>
        <span id="residentialUnitsBadge" class="residential-filter-badge">All applications</span>
      </div>
      <label class="residential-toggle">
        <input id="residentialOnlyFilter" type="checkbox" />
        <span>Residential only — 1+ reported units</span>
      </label>
      <div class="residential-unit-grid">
        <label for="minimumResidentialUnits">Minimum residential units
          <input id="minimumResidentialUnits" type="number" min="1" step="1" inputmode="numeric" placeholder="e.g. 100, 300 or 500" />
        </label>
      </div>
      <div class="residential-unit-actions">
        <button id="applyResidentialUnits" class="primary" type="button">Apply minimum</button>
        <button id="clearResidentialUnits" type="button" disabled>Clear units</button>
      </div>
      <p id="residentialUnitsStatus" class="residential-unit-status" aria-live="polite"></p>
    `;
    searchSection.after(panel);

    panel.querySelector("#applyResidentialUnits").addEventListener("click", applyFromControls);
    panel.querySelector("#clearResidentialUnits").addEventListener("click", () => {
      clearUnitsFilter();
      update();
    });
    panel.querySelector("#residentialOnlyFilter").addEventListener("change", event => {
      const minimum = panel.querySelector("#minimumResidentialUnits");
      if (event.target.checked && !minimum.value) minimum.value = "1";
      if (!event.target.checked && minimum.value === "1") minimum.value = "";
      applyFromControls();
    });
    panel.querySelector("#minimumResidentialUnits").addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        applyFromControls();
      }
    });
    updateUi();
  }

  function clearForGlobalAction() {
    smartState.residentialOnly = false;
    smartState.minUnits = null;
    restoreLayerControls();
    updateUi();
  }

  function bindGlobalClears() {
    document.querySelector("#clearSmartFilters")?.addEventListener("click", clearForGlobalAction, true);
    document.querySelector("#resetDashboardButton")?.addEventListener("click", clearForGlobalAction, true);
  }

  function initialise() {
    injectStyles();
    injectPanel();
    bindGlobalClears();
    restoreLayerControls();
    smartApplyLayerFilters();
    smartUpdateSummary();
  }

  window.RadharcResidentialUnits = {
    isActive,
    rangeLabel,
    minimum: effectiveMinimum,
    syncUi: updateUi,
    applyState,
    clearState: clearForGlobalAction
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialise, { once: true });
  else initialise();
})();
