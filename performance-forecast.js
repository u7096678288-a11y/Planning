"use strict";

(function installDecisionForecastBoard() {
  const PAGE_SIZE = 2000;
  const MAX_PENDING_ROWS = 40000;
  const CACHE_TTL = 120000;
  const cache = new Map();
  let installed = false;
  let running = null;
  let forecast = null;
  let chart = null;

  const FIELDS = [
    "OBJECTID", "PlanningAuthority", "ApplicationNumber", "ApplicationStatus",
    "NumResidentialUnits", "ReceivedDate", "Decision", "DecisionDate", "DecisionDueDate",
    "FIRequestDate", "FIRecDate", "DevelopmentAddress", "DevelopmentDescription"
  ];

  const el = selector => document.querySelector(selector);
  const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const finite = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const number = value => finite(value) ? Number(value) : null;
  const format = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const formatOne = value => finite(value) ? new Intl.NumberFormat("en-IE", { maximumFractionDigits: 1 }).format(Number(value)) : "—";
  const percent = value => finite(value) ? `${formatOne(Number(value) * 100)}%` : "—";
  const safe = value => typeof esc === "function"
    ? esc(value)
    : String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

  function parseTime(value) {
    if (!finite(value) && !text(value)) return null;
    const raw = Number(value);
    const date = new Date(Number.isFinite(raw) && text(value) !== "" ? raw : value);
    const time = date.getTime();
    return Number.isFinite(time) ? time : null;
  }

  function signedDays(startValue, endValue, maximum = 3650) {
    const start = parseTime(startValue);
    const end = parseTime(endValue);
    if (start == null || end == null) return null;
    const days = (end - start) / 86400000;
    return Math.abs(days) <= maximum ? days : null;
  }

  function dateText(value) {
    const time = parseTime(value);
    return time == null ? "—" : new Date(time).toLocaleDateString("en-IE");
  }

  function isoDate(value) {
    const time = parseTime(value);
    return time == null ? "" : new Date(time).toISOString().slice(0, 10);
  }

  function addDays(value, days) {
    const time = parseTime(value);
    return time == null || !finite(days) ? null : time + Number(days) * 86400000;
  }

  function median(values) {
    const clean = values.filter(finite).map(Number).sort((left, right) => left - right);
    if (!clean.length) return null;
    const middle = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
  }

  function quantile(values, probability) {
    const clean = values.filter(finite).map(Number).sort((left, right) => left - right);
    if (!clean.length) return null;
    const index = (clean.length - 1) * Math.max(0, Math.min(1, probability));
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return clean[lower];
    return clean[lower] + (clean[upper] - clean[lower]) * (index - lower);
  }

  function canonicalAuthority(value) {
    if (window.RadharcCrossLayerSync?.canonicalAuthority) return window.RadharcCrossLayerSync.canonicalAuthority(value) || "Not stated";
    if (window.CorkCityCKAN?.canonicalAuthority) return window.CorkCityCKAN.canonicalAuthority(value) || "Not stated";
    const authority = text(value);
    const upper = authority.toUpperCase();
    if (upper.includes("CORK CITY")) return "Cork City Council";
    if (upper.includes("CORK COUNTY")) return "Cork County Council";
    return authority || "Not stated";
  }

  function encodeBody(parameters) {
    const body = new URLSearchParams();
    Object.entries({ f: "json", ...parameters }).forEach(([key, value]) => {
      if (value == null) return;
      body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    });
    return body;
  }

  async function postQuery(url, parameters, signal) {
    const response = await fetch(`${url}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: encodeBody(parameters),
      cache: "no-store",
      credentials: "omit",
      signal
    });
    if (!response.ok) throw new Error(`ArcGIS HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) {
      const detail = Array.isArray(data.error.details) ? data.error.details.filter(Boolean).join(" · ") : "";
      throw new Error([data.error.message, detail].filter(Boolean).join(" · "));
    }
    return data;
  }

  function scopeGeometry() {
    if (el("#performanceScope")?.value !== "map") return null;
    return geom();
  }

  function pendingWhere() {
    const base = typeof smartPlanningWhere === "function" ? smartPlanningWhere("decision") : "1=1";
    return `(${base}) AND DecisionDate IS NULL AND DecisionDueDate IS NOT NULL`;
  }

  function nonCorkWhere(where) {
    return `(${where || "1=1"}) AND (PlanningAuthority IS NULL OR UPPER(PlanningAuthority) NOT LIKE 'CORK CITY%')`;
  }

  async function fetchRows(url, where, geometry, signal) {
    const rows = [];
    let offset = 0;
    while (offset < MAX_PENDING_ROWS) {
      const parameters = {
        where,
        outFields: FIELDS.join(","),
        returnGeometry: false,
        resultOffset: offset,
        resultRecordCount: PAGE_SIZE,
        orderByFields: "OBJECTID ASC"
      };
      if (geometry) Object.assign(parameters, geometry);
      const page = await postQuery(url, parameters, signal);
      const attributes = (page.features || []).map(feature => feature.attributes || {});
      rows.push(...attributes);
      offset += attributes.length;
      setStatus(`Loading undecided applications… ${format(rows.length)} records`, "loading");
      if (!attributes.length || (attributes.length < PAGE_SIZE && !page.exceededTransferLimit)) break;
    }
    return { rows, capped: rows.length >= MAX_PENDING_ROWS };
  }

  function directSelected() {
    return Boolean(el('#layerToggles input[data-k="corkCityDirect"]')?.checked && window.CorkCityCKAN);
  }

  function normaliseDirect(record) {
    return {
      ...record,
      PlanningAuthority: "Cork City Council",
      ApplicationNumber: text(record.ApplicationNumber),
      NumResidentialUnits: number(record.NumResidentialUnits),
      DecisionDueDate: record.DecisionDueDate,
      DirectSource: "Cork City Council CKAN"
    };
  }

  function richness(record) {
    return ["DecisionDueDate", "NumResidentialUnits", "FIRequestDate", "FIRecDate", "DevelopmentAddress", "DevelopmentDescription"]
      .reduce((score, field) => score + (record[field] != null && record[field] !== "" ? 1 : 0), 0);
  }

  function mergeRecord(left, right) {
    const primary = richness(right) > richness(left) ? right : left;
    const secondary = primary === left ? right : left;
    const merged = { ...secondary, ...primary };
    Object.keys(secondary).forEach(key => {
      if (merged[key] == null || merged[key] === "") merged[key] = secondary[key];
    });
    const units = [number(left.NumResidentialUnits), number(right.NumResidentialUnits)].filter(finite).map(Number);
    if (units.length) merged.NumResidentialUnits = Math.max(...units);
    return merged;
  }

  function identity(record, source, index) {
    const authority = canonicalAuthority(record.PlanningAuthority).toUpperCase();
    const reference = text(record.ApplicationNumber).toUpperCase();
    return reference ? `${authority}|${reference}` : `${authority}|${source}|${record.OBJECTID ?? index}`;
  }

  function dedupe(sources) {
    const map = new Map();
    sources.forEach(({ source, rows }) => {
      rows.forEach((row, index) => {
        const record = source === "cork" ? normaliseDirect(row) : { ...row, PlanningAuthority: canonicalAuthority(row.PlanningAuthority) };
        const key = identity(record, source, index);
        const existing = map.get(key);
        map.set(key, existing ? mergeRecord(existing, record) : { ...record, __source: source });
      });
    });
    return [...map.values()].filter(record => parseTime(record.DecisionDate) == null && parseTime(record.DecisionDueDate) != null);
  }

  function historicalModel(analysis) {
    const records = (analysis?.planning || []).filter(record => parseTime(record.DecisionDate) != null && parseTime(record.DecisionDueDate) != null);
    const national = [];
    const byAuthority = new Map();
    records.forEach(record => {
      const residual = signedDays(record.DecisionDueDate, record.DecisionDate, 1500);
      if (!finite(residual)) return;
      national.push(Number(residual));
      const authority = canonicalAuthority(record.PlanningAuthority);
      if (!byAuthority.has(authority)) byAuthority.set(authority, []);
      byAuthority.get(authority).push(Number(residual));
    });
    return { records, national, byAuthority };
  }

  function chooseSample(model, authority) {
    const local = model.byAuthority.get(authority) || [];
    if (local.length >= 15) return { values: local, label: authority, local: true };
    return { values: model.national, label: "national comparable cases", local: false };
  }

  function conditionalForecast(record, model, now) {
    const authority = canonicalAuthority(record.PlanningAuthority);
    const due = parseTime(record.DecisionDueDate);
    const sample = chooseSample(model, authority);
    const currentOffset = due == null ? null : (now - due) / 86400000;
    const survivors = currentOffset == null ? [] : sample.values.filter(value => value >= currentOffset);
    const comparison = survivors.length >= 8 ? survivors : sample.values;
    let forecastResidual = quantile(comparison, 0.5);
    if (currentOffset != null && finite(forecastResidual)) forecastResidual = Math.max(currentOffset, Number(forecastResidual));
    if (!finite(forecastResidual) && currentOffset != null) forecastResidual = Math.max(currentOffset + 21, 0);
    const q25 = quantile(comparison, 0.25);
    const q75 = quantile(comparison, 0.75);
    const lowerResidual = finite(q25) ? Math.max(currentOffset ?? -Infinity, Number(q25)) : forecastResidual;
    const upperResidual = finite(q75) ? Math.max(currentOffset ?? -Infinity, Number(q75)) : forecastResidual;
    const probability = horizon => {
      if (currentOffset == null || !sample.values.length) return null;
      const conditioned = survivors.length ? survivors : sample.values.filter(value => value >= currentOffset - 14);
      if (!conditioned.length) return null;
      return conditioned.filter(value => value <= currentOffset + horizon).length / conditioned.length;
    };
    const fiOutstanding = parseTime(record.FIRequestDate) != null && parseTime(record.FIRecDate) == null;
    const sampleCount = comparison.length;
    let confidence = sampleCount >= 40 ? "High" : sampleCount >= 15 ? "Medium" : "Low";
    if (fiOutstanding || sampleCount < 8) confidence = "Low";
    const p7 = probability(7);
    const p14 = probability(14);
    const p30 = probability(30);
    const overdueDays = currentOffset == null ? null : Math.max(0, currentOffset);
    let status = "Monitor";
    if (overdueDays > 0 && finite(p30) && p30 < 0.5) status = "High delay risk";
    else if (finite(p14) && p14 >= 0.65) status = "Likely soon";
    else if (currentOffset != null && currentOffset >= -14 && currentOffset <= 0) status = "Due soon";
    else if (overdueDays > 0) status = "Overdue";
    return {
      ...record,
      PlanningAuthority: authority,
      __units: Math.max(0, number(record.NumResidentialUnits) || 0),
      __dueTime: due,
      __currentOffset: currentOffset,
      __overdueDays: overdueDays,
      __forecastTime: addDays(due, forecastResidual),
      __forecastLow: addDays(due, lowerResidual),
      __forecastHigh: addDays(due, upperResidual),
      __p7: p7,
      __p14: p14,
      __p30: p30,
      __sampleCount: sampleCount,
      __sampleLabel: sample.label,
      __confidence: confidence,
      __fiOutstanding: fiOutstanding,
      __status: status
    };
  }

  function backtest(model) {
    const records = [...model.records].sort((left, right) => (parseTime(left.DecisionDate) || 0) - (parseTime(right.DecisionDate) || 0));
    if (records.length < 30) return { n: 0, mae: null, within14: null, within30: null };
    const split = Math.max(20, Math.floor(records.length * 0.8));
    const training = records.slice(0, split);
    const testing = records.slice(split);
    const national = [];
    const byAuthority = new Map();
    training.forEach(record => {
      const residual = signedDays(record.DecisionDueDate, record.DecisionDate, 1500);
      if (!finite(residual)) return;
      national.push(Number(residual));
      const authority = canonicalAuthority(record.PlanningAuthority);
      if (!byAuthority.has(authority)) byAuthority.set(authority, []);
      byAuthority.get(authority).push(Number(residual));
    });
    const errors = [];
    testing.forEach(record => {
      const actual = signedDays(record.DecisionDueDate, record.DecisionDate, 1500);
      if (!finite(actual)) return;
      const local = byAuthority.get(canonicalAuthority(record.PlanningAuthority)) || [];
      const sample = local.length >= 12 ? local : national;
      const predicted = median(sample);
      if (!finite(predicted)) return;
      errors.push(Math.abs(Number(actual) - Number(predicted)));
    });
    return {
      n: errors.length,
      mae: median(errors),
      within14: errors.length ? errors.filter(value => value <= 14).length / errors.length : null,
      within30: errors.length ? errors.filter(value => value <= 30).length / errors.length : null
    };
  }

  function weekKey(value) {
    const time = parseTime(value);
    if (time == null) return null;
    const date = new Date(time);
    const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = monday.getUTCDay() || 7;
    monday.setUTCDate(monday.getUTCDate() - day + 1);
    return monday.toISOString().slice(0, 10);
  }

  function pipeline(records, now) {
    const start = new Date(now);
    const day = start.getUTCDay() || 7;
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - day + 1);
    const weeks = [];
    for (let index = 0; index < 12; index += 1) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + index * 7);
      weeks.push({ week: date.toISOString().slice(0, 10), dueUnits: 0, dueCases: 0, forecastUnits: 0, forecastCases: 0 });
    }
    const lookup = new Map(weeks.map(item => [item.week, item]));
    records.forEach(record => {
      const dueWeek = weekKey(record.__dueTime);
      const forecastWeek = weekKey(record.__forecastTime);
      if (lookup.has(dueWeek)) {
        lookup.get(dueWeek).dueUnits += record.__units;
        lookup.get(dueWeek).dueCases += 1;
      }
      if (lookup.has(forecastWeek)) {
        lookup.get(forecastWeek).forecastUnits += record.__units;
        lookup.get(forecastWeek).forecastCases += 1;
      }
    });
    return weeks;
  }

  function metrics(records, validation, now) {
    const inDays = (record, days, field = "__dueTime") => {
      const time = parseTime(record[field]);
      return time != null && time >= now && time <= now + days * 86400000;
    };
    const overdue = records.filter(record => record.__overdueDays > 0);
    const due7 = records.filter(record => inDays(record, 7));
    const forecast30 = records.filter(record => inDays(record, 30, "__forecastTime"));
    return {
      pending: records.length,
      pendingUnits: records.reduce((sum, record) => sum + record.__units, 0),
      overdue: overdue.length,
      overdueUnits: overdue.reduce((sum, record) => sum + record.__units, 0),
      due7: due7.length,
      due7Units: due7.reduce((sum, record) => sum + record.__units, 0),
      forecast30: forecast30.length,
      forecast30Units: forecast30.reduce((sum, record) => sum + record.__units, 0),
      validation
    };
  }

  function forecastKey(analysis) {
    return JSON.stringify({
      scope: el("#performanceScope")?.value || "national",
      geometry: el("#performanceScope")?.value === "map" ? geom().geometry : "national",
      where: pendingWhere(),
      direct: directSelected(),
      analysisGenerated: analysis?.generatedAt?.toISOString?.() || ""
    });
  }

  async function loadPending(analysis, signal) {
    const key = forecastKey(analysis);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.time < CACHE_TTL) return cached.value;
    const geometry = scopeGeometry();
    const direct = directSelected();
    const where = direct ? nonCorkWhere(pendingWhere()) : pendingWhere();
    const tasks = [
      fetchRows(S.planningPoints.url, where, geometry, signal),
      fetchRows(S.planningSites.url, where, geometry, signal),
      direct ? window.CorkCityCKAN.allRecords({ exclude: "decision", geometry, maxRows: MAX_PENDING_ROWS }) : Promise.resolve([])
    ];
    const settled = await Promise.allSettled(tasks);
    if (settled[0].status !== "fulfilled" && settled[1].status !== "fulfilled") {
      throw new Error("Both planning layers failed while loading undecided applications.");
    }
    const pointRows = settled[0].status === "fulfilled" ? settled[0].value.rows : [];
    const siteRows = settled[1].status === "fulfilled" ? settled[1].value.rows : [];
    const corkRows = settled[2].status === "fulfilled"
      ? settled[2].value.filter(record => parseTime(record.DecisionDate) == null && parseTime(record.DecisionDueDate) != null)
      : [];
    const value = {
      records: dedupe([
        { source: "points", rows: pointRows },
        { source: "sites", rows: siteRows },
        { source: "cork", rows: corkRows }
      ]),
      capped: [settled[0], settled[1]].some(result => result.status === "fulfilled" && result.value.capped),
      errors: settled.map((result, index) => result.status === "rejected" ? ["points", "sites", "Cork direct"][index] : null).filter(Boolean)
    };
    cache.set(key, { time: Date.now(), value });
    while (cache.size > 6) cache.delete(cache.keys().next().value);
    return value;
  }

  function setStatus(message, mode = "idle") {
    const status = el("#forecastStatus");
    if (!status) return;
    status.textContent = message;
    status.dataset.mode = mode;
  }

  function injectStyles() {
    if (el("#forecastBoardStyles")) return;
    const style = document.createElement("style");
    style.id = "forecastBoardStyles";
    style.textContent = `
      .forecast-board{margin-top:14px}.forecast-summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:9px;margin-bottom:12px}.forecast-stat{padding:11px;border:1px solid #d8e3e7;border-radius:8px;background:#fff}.forecast-stat span{display:block;color:#607783;font-size:10px;font-weight:700;text-transform:uppercase}.forecast-stat strong{display:block;margin-top:5px;color:#102f49;font-size:21px}.forecast-stat small{display:block;margin-top:5px;color:#687b88;font-size:10px;line-height:1.35}.forecast-status{padding:9px 11px;border:1px solid #d8e3e7;border-radius:8px;background:#f8fbfb;color:#506875;font-size:10px;margin-bottom:10px}.forecast-status[data-mode="loading"]{border-color:#b8d6d4;color:#24585b}.forecast-status[data-mode="error"]{border-color:#dfb8b1;background:#fff7f5;color:#7a3028}.forecast-grid{display:grid;grid-template-columns:.9fr 1.1fr;gap:12px}.forecast-chart{height:270px;position:relative}.forecast-controls{display:flex;align-items:end;gap:8px;flex-wrap:wrap}.forecast-controls label{display:grid;gap:4px;color:#607783;font-size:10px;font-weight:700}.forecast-controls select,.forecast-controls input{border:1px solid #b8c8d0;border-radius:7px;padding:7px 8px;background:#fff;color:#132538;font-size:11px}.forecast-pill{display:inline-flex;border-radius:999px;padding:3px 7px;font-size:9px;font-weight:700;background:#eaf1f3;color:#284558}.forecast-pill.high-delay-risk{background:#fff0ed;color:#7a3028}.forecast-pill.likely-soon{background:#e9f5f1;color:#225b48}.forecast-pill.overdue{background:#fff7df;color:#705615}.forecast-table td:nth-child(1),.forecast-table th:nth-child(1),.forecast-table td:nth-child(2),.forecast-table th:nth-child(2){text-align:left}.forecast-note{margin-top:10px;padding:10px 12px;border-left:3px solid #4d8b91;background:#eef6f6;color:#425c6c;font-size:10px;line-height:1.5}@media(max-width:1100px){.forecast-summary{grid-template-columns:repeat(3,minmax(0,1fr))}.forecast-grid{grid-template-columns:1fr}}@media(max-width:650px){.forecast-summary{grid-template-columns:1fr 1fr}.forecast-controls{align-items:stretch}.forecast-controls label,.forecast-controls button{width:100%}}
    `;
    document.head.append(style);
  }

  function injectInterface() {
    const dialog = el("#performanceDialog");
    if (!dialog || el("#performanceForecastBoard")) return;
    injectStyles();
    const method = el("#performanceMethod");
    const section = document.createElement("section");
    section.id = "performanceForecastBoard";
    section.className = "performance-section forecast-board";
    section.innerHTML = `
      <div class="performance-section-header">
        <div><h3>Decision forecast board</h3><p>Applications with a recorded decision due date and no recorded decision. The board ignores decision-outcome filters so pending cases are not hidden.</p></div>
        <div class="forecast-controls">
          <label for="forecastView">Board view<select id="forecastView"><option value="all">All pending</option><option value="overdue">Overdue only</option><option value="due30">Due in 30 days</option><option value="forecast30">Forecast in 30 days</option><option value="residential">Residential only</option></select></label>
          <label for="forecastSearch">Search<input id="forecastSearch" type="search" placeholder="Reference, authority or address" /></label>
          <button id="forecastRefresh" class="performance-action primary" type="button">Refresh forecast</button>
          <button id="forecastCsv" class="performance-action" type="button" disabled>Forecast CSV</button>
          <button id="forecastExcel" class="performance-action" type="button" disabled>Forecast Excel</button>
        </div>
      </div>
      <div id="forecastStatus" class="forecast-status" data-mode="idle">The forecast will run after the performance analysis loads.</div>
      <div id="forecastSummary" class="forecast-summary"></div>
      <div class="forecast-grid">
        <div><div class="forecast-chart"><canvas id="forecastPipelineChart"></canvas></div><p class="forecast-note">Forecasts use a conditional empirical distribution of decision timing relative to the recorded due date. Authority-specific history is used where the sample is sufficient; otherwise the national distribution is used. FI outstanding cases are marked low confidence.</p></div>
        <div id="forecastTable" class="performance-table-wrap"><div class="performance-empty">No forecast loaded.</div></div>
      </div>`;
    if (method) method.before(section);
    else dialog.querySelector(".performance-content")?.append(section);
  }

  function stat(label, value, note) {
    return `<article class="forecast-stat"><span>${safe(label)}</span><strong>${safe(value)}</strong><small>${safe(note)}</small></article>`;
  }

  function renderSummary(result) {
    const metric = result.metrics;
    el("#forecastSummary").innerHTML = [
      stat("Pending decisions", format(metric.pending), `${format(metric.pendingUnits)} reported residential units`),
      stat("Overdue", format(metric.overdue), `${format(metric.overdueUnits)} units associated`),
      stat("Due in 7 days", format(metric.due7), `${format(metric.due7Units)} units due`),
      stat("Forecast in 30 days", format(metric.forecast30), `${format(metric.forecast30Units)} units forecast`),
      stat("Backtest median error", metric.validation.mae == null ? "—" : `${formatOne(metric.validation.mae)} days`, `${format(metric.validation.n)} holdout decisions`),
      stat("Backtest within 30 days", percent(metric.validation.within30), `Within 14 days: ${percent(metric.validation.within14)}`)
    ].join("");
  }

  function renderChart(result) {
    if (chart) chart.destroy();
    const canvas = el("#forecastPipelineChart");
    if (!canvas || typeof Chart !== "function") return;
    chart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: result.pipeline.map(item => item.week),
        datasets: [
          { label: "Units due", data: result.pipeline.map(item => item.dueUnits) },
          { label: "Units forecast", data: result.pipeline.map(item => item.forecastUnits) }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: { y: { beginAtZero: true, title: { display: true, text: "Residential units" } } },
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              afterBody(items) {
                const index = items[0]?.dataIndex;
                const row = result.pipeline[index];
                return row ? [`Due cases: ${row.dueCases}`, `Forecast cases: ${row.forecastCases}`] : [];
              }
            }
          }
        }
      }
    });
  }

  function filteredRecords(result) {
    const view = el("#forecastView")?.value || "all";
    const search = text(el("#forecastSearch")?.value).toUpperCase();
    const now = Date.now();
    return result.records.filter(record => {
      if (view === "overdue" && !(record.__overdueDays > 0)) return false;
      if (view === "due30" && !(record.__dueTime >= now && record.__dueTime <= now + 30 * 86400000)) return false;
      if (view === "forecast30" && !(record.__forecastTime >= now && record.__forecastTime <= now + 30 * 86400000)) return false;
      if (view === "residential" && !(record.__units > 0)) return false;
      if (search) {
        const haystack = [record.ApplicationNumber, record.PlanningAuthority, record.DevelopmentAddress, record.DevelopmentDescription].map(text).join(" ").toUpperCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    }).sort((left, right) => {
      const leftOverdue = left.__overdueDays > 0 ? 0 : 1;
      const rightOverdue = right.__overdueDays > 0 ? 0 : 1;
      return leftOverdue - rightOverdue || (left.__forecastTime || Infinity) - (right.__forecastTime || Infinity) || (right.__units - left.__units);
    });
  }

  function statusClass(value) {
    return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function renderTable(result) {
    const records = filteredRecords(result);
    const visible = records.slice(0, 500);
    const rows = visible.map(record => `
      <tr>
        <td>${safe(record.ApplicationNumber || "—")}</td>
        <td>${safe(record.PlanningAuthority)}</td>
        <td>${format(record.__units)}</td>
        <td>${dateText(record.DecisionDueDate)}</td>
        <td>${record.__overdueDays > 0 ? `${formatOne(record.__overdueDays)} d overdue` : `${formatOne(Math.max(0, -record.__currentOffset))} d remaining`}</td>
        <td>${dateText(record.__forecastTime)}</td>
        <td>${dateText(record.__forecastLow)}–${dateText(record.__forecastHigh)}</td>
        <td>${percent(record.__p7)}</td>
        <td>${percent(record.__p30)}</td>
        <td>${safe(record.__confidence)}</td>
        <td><span class="forecast-pill ${statusClass(record.__status)}">${safe(record.__status)}</span></td>
        <td>${record.__fiOutstanding ? "FI outstanding" : safe(`${record.__sampleCount} ${record.__sampleLabel}`)}</td>
      </tr>`).join("");
    el("#forecastTable").innerHTML = visible.length ? `
      <table class="performance-table forecast-table"><thead><tr><th>Reference</th><th>Authority</th><th>Units</th><th>Due date</th><th>Due position</th><th>Forecast date</th><th>Middle 50% range</th><th>P(7d)</th><th>P(30d)</th><th>Confidence</th><th>Signal</th><th>Basis</th></tr></thead><tbody>${rows}</tbody></table>
      ${records.length > visible.length ? `<div class="performance-empty">Showing the first ${format(visible.length)} of ${format(records.length)} matching records. Export contains all rows.</div>` : ""}` : '<div class="performance-empty">No pending applications match this board view.</div>';
  }

  function render(result) {
    forecast = result;
    renderSummary(result);
    renderChart(result);
    renderTable(result);
    el("#forecastCsv").disabled = false;
    el("#forecastExcel").disabled = false;
    const warnings = [];
    if (result.capped) warnings.push("a planning layer reached the pending-record safety cap");
    if (result.errors.length) warnings.push(`unavailable: ${result.errors.join(", ")}`);
    setStatus(warnings.length ? `Forecast completed with limitations · ${warnings.join(" · ")}` : `Forecast complete · ${format(result.records.length)} pending applications modelled`, warnings.length ? "error" : "idle");
  }

  async function refreshForecast(force = true) {
    injectInterface();
    const analysis = window.RadharcPerformance?.getAnalysis?.();
    if (!analysis) {
      setStatus("Run the Performance analysis first.", "error");
      return;
    }
    if (running) running.abort();
    running = new AbortController();
    const button = el("#forecastRefresh");
    if (button) {
      button.disabled = true;
      button.textContent = "Forecasting…";
    }
    setStatus("Loading undecided applications and calibrating forecast distributions…", "loading");
    try {
      if (force) cache.clear();
      const pending = await loadPending(analysis, running.signal);
      const model = historicalModel(analysis);
      const now = Date.now();
      const records = pending.records.map(record => conditionalForecast(record, model, now));
      const validation = backtest(model);
      render({
        records,
        metrics: metrics(records, validation, now),
        validation,
        pipeline: pipeline(records, now),
        generatedAt: new Date(),
        capped: pending.capped,
        errors: pending.errors,
        analysisGeneratedAt: analysis.generatedAt
      });
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error("Decision forecast failed", error);
      setStatus(`Forecast failed: ${error.message}`, "error");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Refresh forecast";
      }
    }
  }

  function csvCell(value) {
    let output = String(value ?? "");
    if (/^[=+\-@]/.test(output)) output = `'${output}`;
    return `"${output.replaceAll('"', '""')}"`;
  }

  function exportRows() {
    return (forecast?.records || []).map(record => ({
      Authority: record.PlanningAuthority,
      Reference: record.ApplicationNumber || "",
      Address: record.DevelopmentAddress || "",
      Description: record.DevelopmentDescription || "",
      Units: record.__units,
      Received: isoDate(record.ReceivedDate),
      "Decision due": isoDate(record.DecisionDueDate),
      "Overdue days": record.__overdueDays || 0,
      "Forecast date": isoDate(record.__forecastTime),
      "Forecast lower quartile": isoDate(record.__forecastLow),
      "Forecast upper quartile": isoDate(record.__forecastHigh),
      "Probability within 7 days": record.__p7 ?? "",
      "Probability within 14 days": record.__p14 ?? "",
      "Probability within 30 days": record.__p30 ?? "",
      Confidence: record.__confidence,
      Signal: record.__status,
      "FI outstanding": record.__fiOutstanding ? "Yes" : "No",
      "Comparable sample": record.__sampleCount,
      "Model basis": record.__sampleLabel,
      Source: record.DirectSource || record.__source || "National planning layer"
    }));
  }

  function downloadCsv() {
    const rows = exportRows();
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const content = [headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n");
    const blob = new Blob([`\uFEFF${content}`], { type: "text/csv;charset=utf-8" });
    if (window.RadharcTools?.downloadBlob) window.RadharcTools.downloadBlob(blob, `planning-decision-forecast-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function loadSheetJs() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let script = el("#sheetJsLibrary");
      if (!script) {
        script = document.createElement("script");
        script.id = "sheetJsLibrary";
        script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
        script.async = true;
        document.head.append(script);
      }
      script.addEventListener("load", () => window.XLSX ? resolve() : reject(new Error("Excel library failed to initialise")), { once: true });
      script.addEventListener("error", () => reject(new Error("Excel library failed to load")), { once: true });
    });
  }

  async function downloadExcel() {
    if (!forecast) return;
    const button = el("#forecastExcel");
    const previous = button.textContent;
    button.disabled = true;
    button.textContent = "Building Excel…";
    try {
      await loadSheetJs();
      const workbook = XLSX.utils.book_new();
      const summary = [
        ["Decision forecast board", "Radharc Pleanála"],
        ["Generated", forecast.generatedAt.toLocaleString("en-IE")],
        ["Pending applications", forecast.metrics.pending],
        ["Pending residential units", forecast.metrics.pendingUnits],
        ["Overdue applications", forecast.metrics.overdue],
        ["Overdue residential units", forecast.metrics.overdueUnits],
        ["Forecast in 30 days", forecast.metrics.forecast30],
        ["Forecast units in 30 days", forecast.metrics.forecast30Units],
        ["Backtest cases", forecast.validation.n],
        ["Backtest median absolute error (days)", forecast.validation.mae ?? ""],
        ["Backtest within 14 days", forecast.validation.within14 ?? ""],
        ["Backtest within 30 days", forecast.validation.within30 ?? ""],
        [],
        ["Method", "Conditional empirical timing distribution relative to DecisionDueDate; authority-specific where sample permits, otherwise national fallback."]
      ];
      const summarySheet = XLSX.utils.aoa_to_sheet(summary);
      summarySheet["!cols"] = [{ wch: 42 }, { wch: 90 }];
      XLSX.utils.book_append_sheet(workbook, summarySheet, "Forecast Summary");
      const rows = exportRows();
      const dataSheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Status: "No pending applications" }]);
      if (rows.length) {
        const headers = Object.keys(rows[0]);
        dataSheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) };
        dataSheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" };
        dataSheet["!cols"] = headers.map(header => ({ wch: Math.min(45, Math.max(12, header.length + 2)) }));
      }
      XLSX.utils.book_append_sheet(workbook, dataSheet, "Pending Decisions");
      const pipelineSheet = XLSX.utils.json_to_sheet(forecast.pipeline.map(item => ({
        "Week commencing": item.week,
        "Applications due": item.dueCases,
        "Units due": item.dueUnits,
        "Applications forecast": item.forecastCases,
        "Units forecast": item.forecastUnits
      })));
      XLSX.utils.book_append_sheet(workbook, pipelineSheet, "12 Week Pipeline");
      XLSX.writeFile(workbook, `planning-decision-forecast-${new Date().toISOString().slice(0, 10)}.xlsx`, { compression: true });
    } catch (error) {
      setStatus(`Forecast Excel failed: ${error.message}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  }

  function bindInterface() {
    el("#forecastRefresh")?.addEventListener("click", () => refreshForecast(true));
    el("#forecastView")?.addEventListener("change", () => forecast && renderTable(forecast));
    el("#forecastSearch")?.addEventListener("input", () => forecast && renderTable(forecast));
    el("#forecastCsv")?.addEventListener("click", downloadCsv);
    el("#forecastExcel")?.addEventListener("click", downloadExcel);
  }

  function installAgainstEngine() {
    if (installed || !window.RadharcPerformance || !el("#performanceDialog")) return false;
    installed = true;
    injectInterface();
    bindInterface();
    const performance = window.RadharcPerformance;
    const originalRefresh = performance.refresh.bind(performance);
    performance.refresh = async function forecastAwareRefresh(...args) {
      const result = await originalRefresh(...args);
      await refreshForecast(false);
      return result;
    };
    if (performance.hasData()) refreshForecast(false);
    return true;
  }

  function waitForEngine(attempt = 0) {
    if (installAgainstEngine() || attempt >= 600) return;
    setTimeout(() => waitForEngine(attempt + 1), 50);
  }

  function start() {
    if (installAgainstEngine()) return;
    document.addEventListener("click", event => {
      if (event.target.closest("#performanceButton")) waitForEngine();
    }, true);
  }

  window.RadharcDecisionForecast = {
    refresh: refreshForecast,
    getForecast: () => forecast,
    clearCache: () => cache.clear()
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
