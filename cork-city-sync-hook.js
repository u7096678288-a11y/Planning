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

    function refreshAfter(value) {
      return Promise.resolve(value).finally(() => window.CorkCityCKAN.refreshLayer().catch(error => {
        console.warn("Cork City layer refresh failed", error);
      }));
    }

    update = function corkSynchronizedUpdate(...args) {
      return refreshAfter(dashboardUpdate(...args));
    };

    const originalSyncNow = window.RadharcDashboard.syncNow;
    window.RadharcDashboard.syncNow = function corkSynchronizedNow(...args) {
      const dashboard = originalSyncNow ? originalSyncNow(...args) : dashboardUpdate(...args);
      return refreshAfter(dashboard);
    };

    document.querySelector("#refreshButton")?.addEventListener("click", () => {
      window.CorkCityCKAN.clearCache();
    }, true);

    document.querySelector("#resetDashboardButton")?.addEventListener("click", () => {
      const waitForReset = () => {
        const button = document.querySelector("#resetDashboardButton");
        if (button?.disabled) {
          setTimeout(waitForReset, 80);
          return;
        }
        window.CorkCityCKAN.refreshLayer().catch(() => {});
      };
      setTimeout(waitForReset, 80);
    }, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(install, 0), { once: true });
  else setTimeout(install, 0);
})();
