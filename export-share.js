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

  const sources = [
    "export-core.js?v=20260803-1",
    "share-links.js?v=20260803-1",
    "map-files.js?v=20260803-1"
  ];
  sources.reduce((chain, src) => chain.then(() => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  })), Promise.resolve()).catch(error => console.error("Share/export tools failed to load", error));
})();