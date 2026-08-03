"use strict";

(function installForecastUnitRanking() {
  let installed = false;
  let observer = null;

  const el = selector => document.querySelector(selector);
  const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const format = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 }).format(number(value));
  const formatOne = value => Number.isFinite(Number(value)) ? new Intl.NumberFormat("en-IE", { maximumFractionDigits: 1 }).format(Number(value)) : "—";
  const percent = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? `${formatOne(Number(value) * 100)}%`
    : "—";
  const safe = value => typeof esc === "function"
    ? esc(value)
    : String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

  function parseTime(value) {
    if (value === null || value === undefined || value === "") return null;
    const raw = Number(value);
    const date = new Date(Number.isFinite(raw) ? raw : value);
    const time = date.getTime();
    return Number.isFinite(time) ? time : null;
  }

  function dateText(value) {
    const time = parseTime(value);
    return time == null ? "—" : new Date(time).toLocaleDateString("en-IE");
  }

  function statusClass(value) {
    return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function unitSort(left, right) {
    return number(right.__units) - number(left.__units)
      || (parseTime(left.__forecastTime) ?? Infinity) - (parseTime(right.__forecastTime) ?? Infinity)
      || text(left.PlanningAuthority).localeCompare(text(right.PlanningAuthority), "en-IE")
      || text(left.ApplicationNumber).localeCompare(text(right.ApplicationNumber), "en-IE");
  }

  function filteredRecords(result) {
    const view = el("#forecastView")?.value || "all";
    const search = text(el("#forecastSearch")?.value).toUpperCase();
    const now = Date.now();
    return (result?.records || []).filter(record => {
      const dueTime = parseTime(record.__dueTime);
      const forecastTime = parseTime(record.__forecastTime);
      if (view === "overdue" && !(number(record.__overdueDays) > 0)) return false;
      if (view === "due30" && !(dueTime != null && dueTime >= now && dueTime <= now + 30 * 86400000)) return false;
      if (view === "forecast30" && !(forecastTime != null && forecastTime >= now && forecastTime <= now + 30 * 86400000)) return false;
      if (view === "residential" && !(number(record.__units) > 0)) return false;
      if (search) {
        const haystack = [record.ApplicationNumber, record.PlanningAuthority, record.DevelopmentAddress, record.DevelopmentDescription]
          .map(text).join(" ").toUpperCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    }).sort(unitSort);
  }

  function injectStyles() {
    if (el("#forecastUnitRankingStyles")) return;
    const style = document.createElement("style");
    style.id = "forecastUnitRankingStyles";
    style.textContent = `
      .forecast-list-total{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;padding:9px 11px;border:1px solid #cddde2;border-radius:8px;background:#f4f8f9;color:#425c6c;font-size:10px;line-height:1.4}
      .forecast-list-total strong{color:#102f49;font-size:13px;white-space:nowrap}.forecast-list-total span{min-width:0}.forecast-sort-note{color:#607783;font-weight:700;white-space:nowrap}
      @media(max-width:700px){.forecast-list-total{align-items:flex-start;flex-direction:column}.forecast-sort-note{white-space:normal}}
    `;
    document.head.append(style);
  }

  function ensureTotalElement(table) {
    let total = el("#forecastListTotal");
    if (total) return total;
    total = document.createElement("div");
    total.id = "forecastListTotal";
    total.className = "forecast-list-total";
    table.before(total);
    return total;
  }

  function renderRankedList() {
    const result = window.RadharcDecisionForecast?.getForecast?.();
    const table = el("#forecastTable");
    if (!result || !table) return;

    result.records.sort(unitSort);
    const records = filteredRecords(result);
    const residentialRecords = records.filter(record => number(record.__units) > 0);
    const totalUnits = residentialRecords.reduce((sum, record) => sum + number(record.__units), 0);
    const total = ensureTotalElement(table);
    total.innerHTML = `<span><strong>${format(totalUnits)} residential units</strong> across ${format(residentialRecords.length)} residential applications in the current list · ${format(records.length)} applications overall</span><span class="forecast-sort-note">Highest unit count first</span>`;

    const visible = records.slice(0, 500);
    const rows = visible.map(record => `
      <tr>
        <td>${safe(record.ApplicationNumber || "—")}</td>
        <td>${safe(record.PlanningAuthority)}</td>
        <td><strong>${format(record.__units)}</strong></td>
        <td>${dateText(record.DecisionDueDate)}</td>
        <td>${number(record.__overdueDays) > 0 ? `${formatOne(record.__overdueDays)} d overdue` : `${formatOne(Math.max(0, -number(record.__currentOffset)))} d remaining`}</td>
        <td>${dateText(record.__forecastTime)}</td>
        <td>${dateText(record.__forecastLow)}–${dateText(record.__forecastHigh)}</td>
        <td>${percent(record.__p7)}</td>
        <td>${percent(record.__p30)}</td>
        <td>${safe(record.__confidence)}</td>
        <td><span class="forecast-pill ${statusClass(record.__status)}">${safe(record.__status)}</span></td>
        <td>${record.__fiOutstanding ? "FI outstanding" : safe(`${record.__sampleCount} ${record.__sampleLabel}`)}</td>
      </tr>`).join("");

    if (observer) observer.disconnect();
    table.innerHTML = visible.length ? `
      <table class="performance-table forecast-table"><thead><tr><th>Reference</th><th>Authority</th><th>Units ↓</th><th>Due date</th><th>Due position</th><th>Forecast date</th><th>Middle 50% range</th><th>P(7d)</th><th>P(30d)</th><th>Confidence</th><th>Signal</th><th>Basis</th></tr></thead><tbody>${rows}</tbody></table>
      ${records.length > visible.length ? `<div class="performance-empty">Showing the 500 applications with the highest residential-unit counts from ${format(records.length)} matching records. CSV and Excel exports contain every record in the same highest-units-first order.</div>` : ""}`
      : '<div class="performance-empty">No pending applications match this board view.</div>';
    observe(table);
  }

  function observe(table) {
    if (!observer) {
      observer = new MutationObserver(() => {
        window.setTimeout(renderRankedList, 0);
      });
    }
    observer.observe(table, { childList: true });
  }

  function install() {
    if (installed || !el("#performanceForecastBoard")) return false;
    installed = true;
    injectStyles();
    const table = el("#forecastTable");
    if (table) observe(table);
    el("#forecastView")?.addEventListener("change", () => window.setTimeout(renderRankedList, 0));
    el("#forecastSearch")?.addEventListener("input", () => window.setTimeout(renderRankedList, 0));
    el("#forecastRefresh")?.addEventListener("click", () => window.setTimeout(renderRankedList, 250));
    renderRankedList();
    return true;
  }

  function wait(attempt = 0) {
    if (install() || attempt >= 600) return;
    window.setTimeout(() => wait(attempt + 1), 50);
  }

  function start() {
    if (install()) return;
    document.addEventListener("click", event => {
      if (event.target.closest("#performanceButton")) wait();
    }, true);
  }

  window.RadharcForecastUnitRanking = {
    render: renderRankedList,
    sort: unitSort
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
