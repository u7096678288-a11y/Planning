"use strict";

(function loadRadharcExportTools() {
  if (window.L?.tileLayer && !window.L.__radharcCorsTileLayer) {
    const originalTileLayer = window.L.tileLayer;
    window.L.tileLayer = function corsTileLayer(url, options = {}) {
      return originalTileLayer.call(this, url, { crossOrigin: true, ...options });
    };
    Object.assign(window.L.tileLayer, originalTileLayer);
    window.L.__radharcCorsTileLayer = true;
  }

  const moduleStatus = window.RadharcModuleStatus = {
    loaded: [],
    failed: [],
    skipped: [],
    ready: false
  };

  function loadScript(src, fallbacks = []) {
    const candidates = [src, ...fallbacks];
    return new Promise(resolve => {
      const attempt = index => {
        if (index >= candidates.length) {
          moduleStatus.failed.push(src);
          console.error(`Could not load ${src}`);
          resolve(false);
          return;
        }
        const script = document.createElement("script");
        script.src = candidates[index];
        script.onload = () => {
          moduleStatus.loaded.push(candidates[index]);
          resolve(true);
        };
        script.onerror = () => {
          script.remove();
          attempt(index + 1);
        };
        document.head.append(script);
      };
      attempt(0);
    });
  }

  function ensureCorkFallback() {
    if (window.CorkCityCKAN) return;
    window.CorkCityCKAN = {
      resourceId: "Unavailable",
      sourceKey: "corkCityDirect",
      canonicalAuthority(value) {
        const authority = String(value ?? "").replace(/\s+/g, " ").trim();
        const upper = authority.toUpperCase();
        if (upper.includes("CORK CITY")) return "Cork City Council";
        if (upper.includes("CORK COUNTY")) return "Cork County Council";
        return authority;
      },
      currentRecords: () => [],
      features: () => [],
      clearCache() {}
    };
  }

  async function load() {
    await loadScript("residential-units-filter.js?v=20260803-4");

    const projectionReady = await loadScript(
      "https://cdn.jsdelivr.net/npm/proj4@2.11.0/dist/proj4.js",
      ["https://unpkg.com/proj4@2.11.0/dist/proj4.js"]
    );

    let corkReady = false;
    if (projectionReady) {
      const coordinateReady = await loadScript("cork-city-coordinate-system.js?v=20260803-1");
      corkReady = coordinateReady && await loadScript("cork-city-ckan.js?v=20260803-2");
      if (corkReady) {
        await loadScript("cork-city-area-fix.js?v=20260803-2");
        await loadScript("cork-city-layer-toggle.js?v=20260803-1");
      }
    }
    if (!corkReady) {
      moduleStatus.skipped.push("Cork City direct map modules — optional source unavailable");
      ensureCorkFallback();
    }

    await loadScript("cross-layer-sync.js?v=20260803-2");
    if (corkReady) await loadScript("cork-city-sync-hook.js?v=20260803-2");
    await loadScript("dynamic-performance.js?v=20260803-1");
    await loadScript("selected-layer-query-sync.js?v=20260803-2");
    await loadScript("all-layer-search.js?v=20260803-2");
    await loadScript("export-core.js?v=20260803-2");
    await loadScript("share-links.js?v=20260803-5");
    await loadScript("map-files.js?v=20260803-3");
    if (corkReady) await loadScript("cork-city-map-bridge.js?v=20260803-2");
    await loadScript("export-layer-sync.js?v=20260803-2");
    await loadScript("workbook-export.js?v=20260803-3");
    await loadScript("cork-city-tools.js?v=20260803-1");
    await loadScript("cork-city-search-v2.js?v=20260803-1");
    await loadScript("source-registry-bridge.js?v=20260803-1");
    await loadScript("record-links.js?v=20260803-1");
    await loadScript("performance-launcher.js?v=20260803-1");
    await loadScript("performance-overall.js?v=20260803-2");
    await loadScript("performance-forecast.js?v=20260803-1");
    await loadScript("forecast-unit-ranking.js?v=20260803-2");
    await loadScript("leaderboard-record-view.js?v=20260803-1");
    await loadScript("planning-record-route.js?v=20260803-1");
    await loadScript("authority-autosearch-fix.js?v=20260803-1");
    await loadScript("weekly-update-launcher.js?v=20260803-3");
    await loadScript("completions-launcher.js?v=20260803-1");
    await loadScript("sync-health.js?v=20260803-2");
    await loadScript("building-control-match-core.js?v=20260804-2");
    await loadScript("building-control-core-normalise.js?v=20260804-1");
    await loadScript("dashboard-building-control-five-year.js?v=20260804-2");

    moduleStatus.ready = true;
    document.dispatchEvent(new CustomEvent("radharc:modules-ready", { detail: { ...moduleStatus, corkReady } }));
  }

  load().catch(error => {
    moduleStatus.failed.push("loader");
    console.error("Radharc modules failed to initialise", error);
  });
})();