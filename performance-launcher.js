"use strict";

(function installPerformanceLauncher() {
  const ENGINE_SRC = "performance-engine.js?v=20260803-1";
  let enginePromise = null;

  function injectStyles() {
    if (document.querySelector("#performanceIntelligenceStyles")) return;
    const style = document.createElement("style");
    style.id = "performanceIntelligenceStyles";
    style.textContent = `
      .performance-dialog{width:min(1420px,calc(100vw - 28px));max-width:none;height:min(900px,calc(100vh - 28px));max-height:none;padding:0;border:1px solid #b8c8d0;border-radius:12px;background:#f5f8f9;color:#132538;box-shadow:0 22px 70px rgba(12,36,55,.28)}
      .performance-dialog::backdrop{background:rgba(12,31,48,.48)}
      .performance-shell{height:100%;display:grid;grid-template-rows:auto auto minmax(0,1fr);overflow:hidden}
      .performance-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 18px;background:#102f49;color:#fff}
      .performance-header h2{margin:2px 0 4px;font-size:20px}.performance-header p{margin:0;max-width:850px;color:#d8e5ec;font-size:12px;line-height:1.45}
      .performance-close{border:1px solid rgba(255,255,255,.45);border-radius:7px;background:transparent;color:#fff;padding:8px 11px;font-weight:700;cursor:pointer}
      .performance-toolbar{display:grid;grid-template-columns:minmax(180px,1.2fr) minmax(150px,.8fr) minmax(120px,.65fr) auto auto auto;gap:9px;align-items:end;padding:12px 16px;border-bottom:1px solid #d6e0e5;background:#fff}
      .performance-toolbar label{display:grid;gap:5px;margin:0;color:#506875;font-size:10px;font-weight:700}.performance-toolbar select,.performance-toolbar input{width:100%;border:1px solid #b8c8d0;border-radius:7px;background:#fff;color:#132538;padding:9px;font-size:12px}
      .performance-check{display:flex!important;align-items:center;gap:8px;min-height:38px;padding:7px 9px;border:1px solid #d4dfe4;border-radius:7px;background:#f8fbfb;color:#193247!important;font-size:11px!important}.performance-check input{width:auto!important;margin:0;accent-color:#146f79}
      .performance-action{border:1px solid #b8c8d0;border-radius:7px;background:#fff;color:#132538;padding:9px 11px;font-size:11px;font-weight:700;white-space:nowrap;cursor:pointer}.performance-action.primary{background:#102f49;border-color:#102f49;color:#fff}.performance-action:disabled{opacity:.5;cursor:wait}
      .performance-content{overflow:auto;padding:14px 16px 24px}.performance-status{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;padding:10px 12px;border:1px solid #d8e3e7;border-radius:8px;background:#fff;font-size:11px;color:#506875}.performance-status[data-mode="error"]{border-color:#dfb8b1;background:#fff7f5;color:#7a3028}.performance-status[data-mode="loading"]{border-color:#b8d6d4;background:#f2f9f8;color:#24585b}
      .performance-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}.performance-metric{padding:12px;border:1px solid #d8e3e7;border-radius:8px;background:#fff}.performance-metric span{display:block;color:#607783;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.performance-metric strong{display:block;margin-top:5px;color:#102f49;font-size:24px;line-height:1}.performance-metric small{display:block;margin-top:6px;color:#687b88;font-size:10px;line-height:1.35}
      .performance-chart-grid{display:grid;grid-template-columns:1.35fr .85fr;gap:12px;margin-bottom:14px}.performance-section{border:1px solid #d8e3e7;border-radius:9px;background:#fff;padding:13px}.performance-section-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}.performance-section h3{margin:0;font-size:14px}.performance-section-header p{margin:3px 0 0;color:#687b88;font-size:10px;line-height:1.4}.performance-chart{height:280px;position:relative}
      .performance-table-wrap{overflow:auto;border:1px solid #d8e3e7;border-radius:8px}.performance-table{width:100%;border-collapse:collapse;font-size:10px;white-space:nowrap}.performance-table th{position:sticky;top:0;z-index:1;padding:8px;background:#eaf1f3;color:#284558;text-align:right;border-bottom:1px solid #cbd9df}.performance-table th:first-child,.performance-table th:nth-child(2){text-align:left}.performance-table td{padding:8px;border-bottom:1px solid #e6edef;text-align:right}.performance-table td:first-child,.performance-table td:nth-child(2){text-align:left}.performance-table tr:last-child td{border-bottom:0}.performance-table tbody tr:hover{background:#f4f8f9}
      .performance-two-column{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}.performance-empty{padding:22px;text-align:center;color:#687b88;font-size:11px}.performance-note{margin:12px 0 0;padding:10px 12px;border-left:3px solid #4d8b91;background:#eef6f6;color:#425c6c;font-size:10px;line-height:1.5}
      @media(max-width:1050px){.performance-toolbar{grid-template-columns:1fr 1fr 1fr}.performance-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.performance-chart-grid,.performance-two-column{grid-template-columns:1fr}}
      @media(max-width:650px){.performance-dialog{width:calc(100vw - 12px);height:calc(100vh - 12px)}.performance-header{padding:13px}.performance-toolbar{grid-template-columns:1fr 1fr;padding:10px}.performance-action{width:100%}.performance-content{padding:10px}.performance-metrics{grid-template-columns:1fr 1fr}.performance-metric strong{font-size:20px}}
    `;
    document.head.append(style);
  }

  function dialogMarkup() {
    return `
      <div class="performance-shell">
        <header class="performance-header">
          <div>
            <p class="eyebrow">PLANNING TIMESCALES · APPEALS · HOUSING OUTPUT</p>
            <h2>Performance intelligence</h2>
            <p>Decision speed, residential approvals, refusals, appeals to ACP / An Bord Pleanála and authority rankings. Data loads only while this window is open.</p>
          </div>
          <button id="performanceClose" class="performance-close" type="button">Close</button>
        </header>
        <div class="performance-toolbar">
          <label for="performanceScope">Geographic scope
            <select id="performanceScope">
              <option value="national" selected>National — ignore map extent</option>
              <option value="map">Current visible map area</option>
            </select>
          </label>
          <label for="performanceRank">Rank authorities by
            <select id="performanceRank">
              <option value="speed" selected>Fastest median decision</option>
              <option value="grantUnits">Most units granted</option>
              <option value="appealUnits">Most units appealed</option>
              <option value="refusalRate">Lowest refusal rate</option>
              <option value="acpSpeed">Fastest ACP cases</option>
            </select>
          </label>
          <label for="performanceMinSample">Minimum decisions
            <input id="performanceMinSample" type="number" min="1" max="500" step="1" value="5" />
          </label>
          <label class="performance-check" for="performanceIncludeAcp">
            <input id="performanceIncludeAcp" type="checkbox" checked />
            Include ACP cases
          </label>
          <button id="performanceRefresh" class="performance-action primary" type="button">Run analysis</button>
          <button id="performanceExportExcel" class="performance-action" type="button" disabled>Export Excel</button>
        </div>
        <div class="performance-content">
          <div id="performanceStatus" class="performance-status" data-mode="idle" aria-live="polite">
            <span>Open analysis uses the dashboard date range and active filters. National scope ignores only the map extent.</span>
            <span id="performanceCoverage">Not loaded</span>
          </div>
          <section id="performanceMetrics" class="performance-metrics" aria-label="Performance metrics">
            <article class="performance-metric"><span>LA decision time</span><strong>—</strong><small>Received to decision</small></article>
            <article class="performance-metric"><span>Residential units granted</span><strong>—</strong><small>Decisions classified as grants</small></article>
            <article class="performance-metric"><span>Residential appeals</span><strong>—</strong><small>Applications appealed to ACP</small></article>
            <article class="performance-metric"><span>ACP determination time</span><strong>—</strong><small>Lodged to decided</small></article>
          </section>
          <div class="performance-chart-grid">
            <section class="performance-section">
              <div class="performance-section-header"><div><h3>Residential units by month</h3><p>Granted, refused and appealed unit volumes.</p></div><button id="performanceDownloadTrend" class="performance-action" type="button" disabled>PNG</button></div>
              <div class="performance-chart"><canvas id="performanceTrendChart"></canvas></div>
            </section>
            <section class="performance-section">
              <div class="performance-section-header"><div><h3>Local-authority decision bands</h3><p>Gross calendar days from receipt to decision.</p></div><button id="performanceDownloadBands" class="performance-action" type="button" disabled>PNG</button></div>
              <div class="performance-chart"><canvas id="performanceBandsChart"></canvas></div>
            </section>
          </div>
          <section class="performance-section">
            <div class="performance-section-header"><div><h3>Authority leaderboard</h3><p>Transparent rankings with speed, housing volume, refusals, appeals and ACP caseload shown together.</p></div><button id="performanceExportCsv" class="performance-action" type="button" disabled>Leaderboard CSV</button></div>
            <div id="performanceLeaderboard" class="performance-table-wrap"><div class="performance-empty">Run the analysis to build the leaderboard.</div></div>
          </section>
          <div class="performance-two-column">
            <section class="performance-section">
              <div class="performance-section-header"><div><h3>Largest residential appeals</h3><p>Applications ranked by reported residential units.</p></div></div>
              <div id="performanceAppeals" class="performance-table-wrap"><div class="performance-empty">No analysis loaded.</div></div>
            </section>
            <section class="performance-section">
              <div class="performance-section-header"><div><h3>Longest ACP cases</h3><p>Decided cases ranked by lodged-to-decision duration.</p></div></div>
              <div id="performanceAcpCases" class="performance-table-wrap"><div class="performance-empty">No analysis loaded.</div></div>
            </section>
          </div>
          <p id="performanceMethod" class="performance-note">Times are calendar days. Gross local-authority time is ReceivedDate to DecisionDate; FI-adjusted time removes the period between FIRequestDate and FIRecDate where both are supplied. Appeal volumes use the planning feed’s appeal reference/status/dates and are enriched by matching ACP case numbers where possible.</p>
        </div>
      </div>`;
  }

  function injectUi() {
    if (!document.querySelector("#performanceButton")) {
      const anchor = document.querySelector("#shareViewButton") || document.querySelector("#refreshButton");
      if (anchor) {
        const button = document.createElement("button");
        button.id = "performanceButton";
        button.className = "secondary-button";
        button.type = "button";
        button.textContent = "Performance";
        anchor.after(button);
      }
    }
    if (!document.querySelector("#performanceDialog")) {
      const dialog = document.createElement("dialog");
      dialog.id = "performanceDialog";
      dialog.className = "performance-dialog";
      dialog.innerHTML = dialogMarkup();
      document.body.append(dialog);
      dialog.querySelector("#performanceClose")?.addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", event => {
        if (event.target === dialog) dialog.close();
      });
    }
  }

  function loadEngine() {
    if (window.RadharcPerformance) return Promise.resolve(window.RadharcPerformance);
    if (enginePromise) return enginePromise;
    enginePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = ENGINE_SRC;
      script.onload = () => window.RadharcPerformance ? resolve(window.RadharcPerformance) : reject(new Error("Performance engine did not initialise"));
      script.onerror = () => reject(new Error("Performance engine could not be loaded"));
      document.head.append(script);
    });
    return enginePromise;
  }

  async function openPerformance() {
    const dialog = document.querySelector("#performanceDialog");
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    const status = dialog.querySelector("#performanceStatus");
    status.dataset.mode = "loading";
    status.firstElementChild.textContent = "Loading the performance module…";
    try {
      const engine = await loadEngine();
      await engine.initialise();
      if (!engine.hasData()) await engine.refresh({ force: false });
    } catch (error) {
      status.dataset.mode = "error";
      status.firstElementChild.textContent = `Performance module failed: ${error.message}`;
    }
  }

  function bind() {
    injectStyles();
    injectUi();
    document.querySelector("#performanceButton")?.addEventListener("click", openPerformance);
  }

  window.RadharcPerformanceLauncher = { open: openPerformance, load: loadEngine };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
