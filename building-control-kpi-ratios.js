"use strict";

(function connectBuildingControlUnitPipeline() {
  let scheduled = false;

  const format = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const percent = (value, total) => total > 0 ? `${new Intl.NumberFormat("en-IE", { maximumFractionDigits: 1 }).format(100 * value / total)}%` : "—";

  function update() {
    scheduled = false;
    const api = window.RadharcBuildingControlKpis;
    if (!api?.currentRows) return;
    const rows = api.currentRows();
    if (!rows.length) return;
    const approved = rows.reduce((sum, row) => sum + (Number(row.approvedUnits) || 0), 0);
    const commenced = rows.reduce((sum, row) => sum + (Number(row.unitsCommenced) || 0), 0);
    const completed = rows.reduce((sum, row) => sum + (Number(row.unitsCompleted) || 0), 0);
    const commencedCoverage = document.querySelector("#commencedUnitsCoverage");
    const completedCoverage = document.querySelector("#completedUnitsCoverage");
    if (commencedCoverage) commencedCoverage.textContent = `${percent(commenced, approved)} of ${format(approved)} approved units in the qualifying planning set`;
    if (completedCoverage) completedCoverage.textContent = `${percent(completed, commenced)} of commenced units · ${percent(completed, approved)} of approved units`;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(update);
  }

  function install() {
    const status = document.querySelector("#buildingControlKpiStatus") || document.body;
    new MutationObserver(schedule).observe(status, { childList: true, subtree: true, characterData: true });
    document.addEventListener("click", event => {
      if (event.target.closest("#refreshButton, #clearSmartFilters, #applyCustomDates, #clearCustomDates")) setTimeout(schedule, 0);
    });
    schedule();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
