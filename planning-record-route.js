"use strict";

(function installPlanningRecordRoute() {
  function routeUrl(record, layerKey = "") {
    const reference = String(record?.ApplicationNumber ?? "").trim();
    if (!reference) return "";
    const source = layerKey === "corkCityDirect" || record?.DirectSource === "Cork City Council CKAN" || record?.__source === "cork"
      ? "cork"
      : layerKey === "planningSites" || record?.__source === "sites"
        ? "planningSites"
        : "planningPoints";
    const url = new URL("planning-record.html", window.location.href);
    url.searchParams.set("source", source);
    url.searchParams.set("ref", reference);
    const authority = String(record?.PlanningAuthority ?? "").replace(/\s+/g, " ").trim();
    if (authority) url.searchParams.set("authority", authority);
    return url.toString();
  }

  function rewriteAnchor(anchor) {
    if (!(anchor instanceof HTMLAnchorElement) || !anchor.href) return;
    try {
      const url = new URL(anchor.href, document.baseURI);
      if (!url.pathname.endsWith("/record-view.html")) return;
      url.pathname = url.pathname.replace(/\/record-view\.html$/, "/planning-record.html");
      anchor.href = url.toString();
    } catch {}
  }

  function rewrite(root = document) {
    if (root instanceof HTMLAnchorElement) rewriteAnchor(root);
    root.querySelectorAll?.('a[href*="record-view.html"]').forEach(rewriteAnchor);
  }

  if (window.RadharcRecordLinks) {
    window.RadharcRecordLinks.planningUrl = routeUrl;
    window.RadharcRecordLinks.planningSourceUrl = routeUrl;
  }
  if (window.RadharcPlanningRecordView) {
    window.RadharcPlanningRecordView.recordUrl = routeUrl;
  }

  rewrite();
  const observer = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE) rewrite(node);
  })));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("click", event => rewriteAnchor(event.target.closest?.("a")), true);

  window.RadharcPlanningRecordRoute = { url: routeUrl, rewrite };
})();
