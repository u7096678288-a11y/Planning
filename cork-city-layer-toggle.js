"use strict";

(function installCorkLayerToggleRefresh() {
  function bind() {
    const container = document.querySelector("#layerToggles");
    if (!container || container.dataset.corkToggleRefresh === "1") return;
    container.dataset.corkToggleRefresh = "1";
    container.addEventListener("change", event => {
      const input = event.target.closest('input[data-k="corkCityDirect"]');
      if (!input) return;
      setTimeout(() => window.CorkCityCKAN?.refreshLayer?.().catch(() => {}), 20);
    }, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
