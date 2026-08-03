"use strict";

(function installAuthorityAutoSearchFix() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("autosearch") !== "1" || !params.getAll("authority").length) return;

  const canonical = value => {
    if (window.RadharcCrossLayerSync?.canonicalAuthority) return window.RadharcCrossLayerSync.canonicalAuthority(value) || "";
    if (window.CorkCityCKAN?.canonicalAuthority) return window.CorkCityCKAN.canonicalAuthority(value) || "";
    return String(value ?? "").replace(/\s+/g, " ").trim();
  };

  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    const expected = params.getAll("authority").map(canonical);
    const state = typeof smartState !== "undefined" ? smartState : null;
    const current = Array.isArray(state?.authority) ? state.authority.map(canonical) : [];
    const form = document.querySelector("#searchForm");
    const ready = Boolean(form && expected.every(value => current.includes(value)));
    if (!ready && attempts <= 100) return;

    window.clearInterval(timer);
    if (!ready || window.__radharcAuthorityAutoSearched) return;
    window.__radharcAuthorityAutoSearched = true;
    window.setTimeout(() => {
      form.requestSubmit?.();
      document.querySelector("#searchResults")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }, 500);
  }, 100);
})();
