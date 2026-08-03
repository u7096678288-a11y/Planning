"use strict";

(function installExportLayerSync() {
  const T = window.RadharcTools = window.RadharcTools || {};
  const MAP_ACTION_IDS = new Set(["downloadMapFile", "systemShareMap", "emailShareMap"]);

  function layerInputs() {
    return [...document.querySelectorAll('#layerToggles input[data-k]')]
      .filter(input => Object.hasOwn(layers, input.dataset.k));
  }

  function selectedKeys() {
    const inputs = layerInputs();
    if (inputs.length) return inputs.filter(input => input.checked).map(input => input.dataset.k);
    return Object.keys(layers).filter(key => map.hasLayer(layers[key]));
  }

  function selectedLabels(keys = selectedKeys()) {
    return keys.map(key => S[key]?.label || key);
  }

  function syncMapToLayerControls() {
    const inputs = layerInputs();
    inputs.forEach(input => {
      const key = input.dataset.k;
      const layer = layers[key];
      if (!layer) return;
      if (input.checked && !map.hasLayer(layer)) layer.addTo(map);
      if (!input.checked && map.hasLayer(layer)) map.removeLayer(layer);
    });
    return selectedKeys();
  }

  function ensureLayerSummary() {
    const mapSection = document.querySelector("#shareMapExtent")?.closest(".share-panel-section");
    if (!mapSection) return null;
    let summary = document.querySelector("#exportLayerSummary");
    if (!summary) {
      summary = document.createElement("p");
      summary.id = "exportLayerSummary";
      summary.className = "share-current-state export-layer-summary";
      const note = mapSection.querySelector(".share-panel-note");
      if (note) note.before(summary);
      else mapSection.append(summary);
    }
    return summary;
  }

  function updateLayerSummary() {
    const summary = ensureLayerSummary();
    if (!summary) return;
    const labels = selectedLabels();
    summary.textContent = labels.length
      ? `Layers included: ${labels.join(" · ")}`
      : "Layers included: basemap only";
  }

  function prepareSelectedLayersForExport() {
    const keys = syncMapToLayerControls();
    const extent = document.querySelector("#shareMapExtent");
    if (keys.includes("freehold") && extent?.value === "ireland") {
      extent.value = "current";
      T.showMessage?.(
        "Freehold parcels are local-scale data, so the export extent was changed to Current dashboard view.",
        "ok",
        7000
      );
    }
    updateLayerSummary();
    return keys;
  }

  document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (MAP_ACTION_IDS.has(button.id)) prepareSelectedLayersForExport();
    if (button.id === "shareViewButton") setTimeout(updateLayerSummary, 0);
  }, true);

  document.addEventListener("change", event => {
    if (event.target.matches('#layerToggles input[data-k], #shareMapExtent')) {
      updateLayerSummary();
    }
  });

  T.onReady?.(() => {
    updateLayerSummary();
    const style = document.createElement("style");
    style.id = "exportLayerSyncStyles";
    style.textContent = `
      .export-layer-summary{margin:0 0 9px;font-weight:700}
    `;
    document.head.append(style);
  });
})();