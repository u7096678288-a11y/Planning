"use strict";

(function installCorkCityMapBridge() {
  const BUTTONS = new Set(["downloadMapFile", "systemShareMap", "emailShareMap"]);
  let preparing = false;
  let preparedClick = false;

  function escapeSql(value) {
    return String(value ?? "").replaceAll("'", "''");
  }

  function referenceClause(records) {
    const references = [...new Set(records.map(record => String(record.ApplicationNumber ?? "").trim()).filter(Boolean))].slice(0, 2500);
    if (!references.length) return "";
    const groups = [];
    for (let index = 0; index < references.length; index += 400) {
      groups.push(`ApplicationNumber IN (${references.slice(index, index + 400).map(value => `'${escapeSql(value)}'`).join(",")})`);
    }
    const referencesSql = groups.length === 1 ? groups[0] : `(${groups.join(" OR ")})`;
    return `(UPPER(PlanningAuthority) LIKE 'CORK CITY%' AND ${referencesSql})`;
  }

  function restoreWhenFinished(button, restore) {
    let restored = false;
    const runRestore = () => {
      if (restored) return;
      restored = true;
      restore();
    };
    let sawBusy = button.getAttribute("aria-busy") === "true";
    const observer = new MutationObserver(() => {
      if (button.getAttribute("aria-busy") === "true") sawBusy = true;
      if (sawBusy && button.getAttribute("aria-busy") !== "true") {
        observer.disconnect();
        runRestore();
      }
    });
    observer.observe(button, { attributes: true, attributeFilter: ["aria-busy"] });
    setTimeout(() => {
      observer.disconnect();
      runRestore();
    }, 90000);
  }

  async function prepareExport(button) {
    if (preparing) return;
    preparing = true;
    const directInput = document.querySelector('#layerToggles input[data-k="corkCityDirect"]');
    const pointsInput = document.querySelector('#layerToggles input[data-k="planningPoints"]');
    const sitesInput = document.querySelector('#layerToggles input[data-k="planningSites"]');
    const directSelected = Boolean(directInput?.checked && map.hasLayer(layers.corkCityDirect));
    if (!directSelected) {
      preparing = false;
      preparedClick = true;
      button.click();
      return;
    }

    const originalWhere = smartPlanningWhere;
    const directWasOnMap = map.hasLayer(layers.corkCityDirect);
    const pointsWasOnMap = map.hasLayer(layers.planningPoints);
    const sitesWasOnMap = map.hasLayer(layers.planningSites);
    const directWasChecked = Boolean(directInput?.checked);
    const pointsWasChecked = Boolean(pointsInput?.checked);
    const sitesWasChecked = Boolean(sitesInput?.checked);
    const priorText = button.textContent;

    try {
      button.disabled = true;
      button.textContent = "Matching Cork records…";
      const extentMode = document.querySelector("#shareMapExtent")?.value || "ireland";
      const geometry = extentMode === "ireland"
        ? {
            geometry: JSON.stringify({ xmin: -10.85, ymin: 51.25, xmax: -5.25, ymax: 55.65, spatialReference: { wkid: 4326 } }),
            geometryType: "esriGeometryEnvelope",
            inSR: 4326,
            spatialRel: "esriSpatialRelIntersects"
          }
        : geom();
      const records = await window.CorkCityCKAN.allRecords({ geometry, maxRows: 60000 });
      const clause = referenceClause(records);
      if (clause) {
        smartPlanningWhere = function corkExportPlanningWhere(exclude = "") {
          const base = originalWhere(exclude);
          return `((${base}) OR (${clause}))`;
        };
      }

      if (directInput) directInput.checked = false;
      if (directWasOnMap) map.removeLayer(layers.corkCityDirect);
      if (!pointsWasOnMap && !sitesWasOnMap) {
        if (pointsInput) pointsInput.checked = true;
        layers.planningPoints.addTo(map);
      }

      const restore = () => {
        smartPlanningWhere = originalWhere;
        if (directInput) directInput.checked = directWasChecked;
        if (pointsInput) pointsInput.checked = pointsWasChecked;
        if (sitesInput) sitesInput.checked = sitesWasChecked;
        if (!pointsWasOnMap && map.hasLayer(layers.planningPoints)) map.removeLayer(layers.planningPoints);
        if (!sitesWasOnMap && map.hasLayer(layers.planningSites)) map.removeLayer(layers.planningSites);
        if (directWasOnMap && !map.hasLayer(layers.corkCityDirect)) layers.corkCityDirect.addTo(map);
        button.disabled = false;
        button.textContent = priorText;
        window.CorkCityCKAN.refreshLayer().catch(() => {});
      };
      restoreWhenFinished(button, restore);
      preparedClick = true;
      button.disabled = false;
      button.textContent = priorText;
      button.click();
    } catch (error) {
      console.error("Cork map export bridge failed", error);
      if (directInput) directInput.checked = directWasChecked;
      if (pointsInput) pointsInput.checked = pointsWasChecked;
      if (sitesInput) sitesInput.checked = sitesWasChecked;
      if (!pointsWasOnMap && map.hasLayer(layers.planningPoints)) map.removeLayer(layers.planningPoints);
      if (directWasOnMap && !map.hasLayer(layers.corkCityDirect)) layers.corkCityDirect.addTo(map);
      smartPlanningWhere = originalWhere;
      button.disabled = false;
      button.textContent = priorText;
      window.RadharcTools?.showMessage?.(`Cork City map matching failed: ${window.RadharcTools?.errorMessage?.(error) || error.message}`, "error", 8000);
    } finally {
      preparing = false;
    }
  }

  document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || !BUTTONS.has(button.id)) return;
    if (preparedClick) {
      preparedClick = false;
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    prepareExport(button);
  }, true);
})();