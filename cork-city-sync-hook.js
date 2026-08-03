"use strict";

(function installCorkCitySyncHook() {
  function install() {
    if (window.__radharcCorkSyncHookInstalled) return;
    if (!window.CorkCityCKAN || !window.RadharcDashboard || typeof update !== "function") {
      setTimeout(install, 40);
      return;
    }
    window.__radharcCorkSyncHookInstalled = true;
    const dashboardUpdate = update;
    update = function corkSynchronizedUpdate(...args) {
      const dashboard = dashboardUpdate(...args);
      window.CorkCityCKAN.refreshLayer().catch(error => console.warn("Cork City layer refresh failed", error));
      return dashboard;
    };

    const originalSyncNow = window.RadharcDashboard.syncNow;
    window.RadharcDashboard.syncNow = function corkSynchronizedNow(...args) {
      const dashboard = originalSyncNow ? originalSyncNow(...args) : update(...args);
      const cork = window.CorkCityCKAN.refreshLayer().catch(error => {
        console.warn("Cork City layer refresh failed", error);
        return [];
      });
      return Promise.allSettled([Promise.resolve(dashboard), cork]);
    };

    document.querySelector("#refreshButton")?.addEventListener("click", () => {
      window.CorkCityCKAN.clearCache();
      window.CorkCityCKAN.refreshLayer().catch(() => {});
    }, true);
    document.querySelector("#resetDashboardButton")?.addEventListener("click", () => {
      setTimeout(() => window.CorkCityCKAN.refreshLayer().catch(() => {}), 80);
    }, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(install, 0), { once: true });
  else setTimeout(install, 0);
})();
