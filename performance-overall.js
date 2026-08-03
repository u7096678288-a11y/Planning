"use strict";

(function installOverallPerformanceIndex() {
  const WEIGHTS = {
    decisionSpeed: 25,
    onTime: 15,
    housingOutcome: 20,
    appealExposure: 15,
    acpSpeed: 15,
    coverage: 10
  };
  let installed = false;
  let timer = null;

  const el = selector => document.querySelector(selector);
  const finite = value => Number.isFinite(Number(value));
  const number = value => finite(value) ? Number(value) : null;
  const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));
  const format = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const formatOne = value => finite(value) ? new Intl.NumberFormat("en-IE", { maximumFractionDigits: 1 }).format(Number(value)) : "—";
  const percentage = value => finite(value) ? `${formatOne(Number(value) * 100)}%` : "—";
  const safe = value => typeof esc === "function"
    ? esc(value)
    : String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

  function descendingScore(value, excellent, poor) {
    const current = number(value);
    if (current == null) return null;
    if (current <= excellent) return 100;
    if (current >= poor) return 0;
    return clamp(100 * (poor - current) / (poor - excellent));
  }

  function rateScore(value, inverse = false) {
    const current = number(value);
    if (current == null) return null;
    return clamp((inverse ? 1 - current : current) * 100);
  }

  function mean(values) {
    const usable = values.filter(finite).map(Number);
    return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
  }

  function band(score) {
    const value = number(score);
    if (value == null) return "Not rated";
    if (value >= 85) return "Leading";
    if (value >= 70) return "Strong";
    if (value >= 55) return "Moderate";
    if (value >= 40) return "Constrained";
    return "Weak";
  }

  function weightedIndex(components) {
    const available = components.filter(component => finite(component.score));
    const availableWeight = available.reduce((sum, component) => sum + component.weight, 0);
    if (!availableWeight) return { score: null, availableWeight: 0, components };
    const score = available.reduce((sum, component) => sum + Number(component.score) * component.weight, 0) / availableWeight;
    return { score: clamp(score), availableWeight, components };
  }

  function coverageScore(values) {
    const usable = values.filter(value => finite(value));
    return usable.length ? clamp(mean(usable) * 100) : null;
  }

  function scopeComponents(analysis) {
    const metric = analysis.metrics || {};
    const outcomeDenominator = (Number(metric.grantUnits) || 0) + (Number(metric.refusalUnits) || 0);
    const applicationOutcomeDenominator = (Number(metric.grantApplications) || 0) + (Number(metric.refusalApplications) || 0);
    const housingOutcome = outcomeDenominator > 0
      ? (Number(metric.grantUnits) || 0) / outcomeDenominator
      : applicationOutcomeDenominator > 0
        ? (Number(metric.grantApplications) || 0) / applicationOutcomeDenominator
        : null;
    const appealDurationCount = (analysis.planning || []).filter(record => record.__residential && record.__appealed && finite(record.__appealDays)).length;
    const completion = coverageScore([
      metric.applications ? metric.decided / metric.applications : null,
      metric.residentialApplications ? applicationOutcomeDenominator / metric.residentialApplications : null,
      metric.appealedApplications ? appealDurationCount / metric.appealedApplications : null,
      metric.acpCases ? metric.acpDecided / metric.acpCases : null
    ]);
    const decisionDays = finite(metric.medianAdjustedDays) ? metric.medianAdjustedDays : metric.medianDecisionDays;

    return [
      {
        key: "decisionSpeed",
        label: "Decision speed",
        weight: WEIGHTS.decisionSpeed,
        score: descendingScore(decisionDays, 56, 365),
        evidence: finite(decisionDays) ? `${formatOne(decisionDays)} median days` : "No comparable decision duration"
      },
      {
        key: "onTime",
        label: "On-time decisions",
        weight: WEIGHTS.onTime,
        score: rateScore(metric.lateRate, true),
        evidence: finite(metric.lateRate) ? `${percentage(1 - metric.lateRate)} on or before due date` : "Decision-due coverage unavailable"
      },
      {
        key: "housingOutcome",
        label: "Residential approval outcome",
        weight: WEIGHTS.housingOutcome,
        score: rateScore(housingOutcome),
        evidence: housingOutcome == null ? "No classified residential outcomes" : `${percentage(housingOutcome)} of classified units granted`
      },
      {
        key: "appealExposure",
        label: "Low appeal exposure",
        weight: WEIGHTS.appealExposure,
        score: rateScore(metric.appealRate, true),
        evidence: finite(metric.appealRate) ? `${percentage(metric.appealRate)} of residential applications appealed` : "No residential appeal rate"
      },
      {
        key: "acpSpeed",
        label: "ACP determination speed",
        weight: WEIGHTS.acpSpeed,
        score: descendingScore(metric.medianAcpDays, 120, 730),
        evidence: finite(metric.medianAcpDays) ? `${formatOne(metric.medianAcpDays)} median days` : "ACP duration unavailable or excluded"
      },
      {
        key: "coverage",
        label: "Case completion and coverage",
        weight: WEIGHTS.coverage,
        score: completion,
        evidence: completion == null ? "Coverage could not be calculated" : `${formatOne(completion)}% completion / usable-date coverage`
      }
    ];
  }

  function authorityComponents(item) {
    const outcomeUnits = (Number(item.grantUnits) || 0) + (Number(item.refusalUnits) || 0);
    const outcomeApplications = (Number(item.grants) || 0) + (Number(item.refusals) || 0) + (Number(item.mixed) || 0);
    const housingOutcome = outcomeUnits > 0
      ? (Number(item.grantUnits) || 0) / outcomeUnits
      : outcomeApplications > 0
        ? (Number(item.grants) || 0) / outcomeApplications
        : null;
    const completion = coverageScore([
      item.applications ? item.decided / item.applications : null,
      item.residentialApplications ? outcomeApplications / item.residentialApplications : null,
      item.appeals ? (item.appealDays?.length || 0) / item.appeals : null,
      item.acpCases ? item.acpDecided / item.acpCases : null
    ]);
    const decisionDays = finite(item.medianAdjustedDays) ? item.medianAdjustedDays : item.medianDecisionDays;

    return [
      { key: "decisionSpeed", label: "Decision speed", weight: WEIGHTS.decisionSpeed, score: descendingScore(decisionDays, 56, 365) },
      { key: "onTime", label: "On-time decisions", weight: WEIGHTS.onTime, score: rateScore(item.lateRate, true) },
      { key: "housingOutcome", label: "Residential approval outcome", weight: WEIGHTS.housingOutcome, score: rateScore(housingOutcome) },
      { key: "appealExposure", label: "Low appeal exposure", weight: WEIGHTS.appealExposure, score: rateScore(item.appealRate, true) },
      { key: "acpSpeed", label: "ACP determination speed", weight: WEIGHTS.acpSpeed, score: descendingScore(item.medianAcpDays, 120, 730) },
      { key: "coverage", label: "Case completion and coverage", weight: WEIGHTS.coverage, score: completion }
    ];
  }

  function scoreAnalysis(analysis) {
    const overall = weightedIndex(scopeComponents(analysis));
    overall.band = band(overall.score);
    analysis.overall = overall;
    if (analysis.metrics) {
      analysis.metrics.overallScore = overall.score;
      analysis.metrics.overallBand = overall.band;
      analysis.metrics.overallCoverage = overall.availableWeight;
    }
    (analysis.authorities || []).forEach(item => {
      const result = weightedIndex(authorityComponents(item));
      item.overallScore = result.score;
      item.overallBand = band(result.score);
      item.overallCoverage = result.availableWeight;
      item.overallComponents = result.components;
    });
    return overall;
  }

  function injectStyles() {
    if (el("#overallPerformanceStyles")) return;
    const style = document.createElement("style");
    style.id = "overallPerformanceStyles";
    style.textContent = `
      .performance-overall{display:grid;grid-template-columns:minmax(230px,.68fr) minmax(0,1.32fr);gap:12px;margin-bottom:14px}
      .performance-overall-score{display:flex;flex-direction:column;justify-content:center;min-height:180px;padding:18px;border:1px solid #b9d2d3;border-radius:10px;background:#edf6f6}
      .performance-overall-score span{color:#526c78;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
      .performance-overall-score strong{margin-top:8px;color:#102f49;font-size:48px;line-height:.95}.performance-overall-score strong small{font-size:18px;font-weight:600}
      .performance-overall-score b{margin-top:8px;color:#315d61;font-size:16px}.performance-overall-score p{margin:8px 0 0;color:#607783;font-size:10px;line-height:1.45}
      .performance-overall-breakdown{padding:13px;border:1px solid #d8e3e7;border-radius:9px;background:#fff}.performance-overall-breakdown h3{margin:0 0 3px;font-size:14px}.performance-overall-breakdown>p{margin:0 0 10px;color:#687b88;font-size:10px;line-height:1.4}
      .performance-component{display:grid;grid-template-columns:minmax(145px,.9fr) minmax(100px,1.1fr) 46px;gap:9px;align-items:center;padding:7px 0;border-top:1px solid #edf1f3}.performance-component:first-of-type{border-top:0}
      .performance-component-label b{display:block;font-size:10px;color:#284558}.performance-component-label small{display:block;margin-top:2px;color:#748792;font-size:9px;line-height:1.3}
      .performance-component-track{height:9px;border-radius:999px;background:#e5edef;overflow:hidden}.performance-component-track i{display:block;height:100%;background:#317b82;border-radius:inherit}
      .performance-component-score{text-align:right;color:#102f49;font-size:11px;font-weight:700}
      .overall-score-pill{display:inline-block;min-width:44px;padding:4px 7px;border:1px solid #bed2d4;border-radius:999px;background:#edf6f6;color:#244f53;text-align:center;font-weight:700}
      @media(max-width:900px){.performance-overall{grid-template-columns:1fr}.performance-overall-score{min-height:0}}
      @media(max-width:520px){.performance-component{grid-template-columns:1fr 42px}.performance-component-track{grid-column:1/-1;grid-row:2}}
    `;
    document.head.append(style);
  }

  function injectInterface() {
    const metrics = el("#performanceMetrics");
    if (metrics && !el("#performanceOverall")) {
      const section = document.createElement("section");
      section.id = "performanceOverall";
      section.className = "performance-overall";
      section.innerHTML = `
        <article class="performance-overall-score">
          <span>Overall performance index</span>
          <strong id="performanceOverallValue">—<small>/100</small></strong>
          <b id="performanceOverallBand">Not rated</b>
          <p id="performanceOverallCoverage">Run the analysis to calculate the overall index.</p>
        </article>
        <article class="performance-overall-breakdown">
          <h3>Overall score breakdown</h3>
          <p>The index reweights available components; missing ACP information is not treated as zero.</p>
          <div id="performanceOverallComponents"><div class="performance-empty">No score calculated.</div></div>
        </article>`;
      metrics.before(section);
    }

    const rank = el("#performanceRank");
    if (rank && !rank.querySelector('option[value="overall"]')) {
      const option = document.createElement("option");
      option.value = "overall";
      option.textContent = "Overall performance index";
      rank.prepend(option);
      if (rank.value === "speed") rank.value = "overall";
    }

    const method = el("#performanceMethod");
    if (method && !method.dataset.overallMethod) {
      method.dataset.overallMethod = "true";
      method.textContent += " The Overall Performance Index is a comparative research measure, not a statutory judgement. It weights decision speed 25%, on-time decisions 15%, residential approval outcome 20%, low appeal exposure 15%, ACP determination speed 15%, and case completion/data coverage 10%. Available weights are renormalised when a component is unavailable.";
    }
  }

  function renderOverall(analysis) {
    if (!analysis) return;
    injectInterface();
    const result = scoreAnalysis(analysis);
    const scoreElement = el("#performanceOverallValue");
    const bandElement = el("#performanceOverallBand");
    const coverageElement = el("#performanceOverallCoverage");
    if (scoreElement) scoreElement.innerHTML = result.score == null ? "—<small>/100</small>" : `${formatOne(result.score)}<small>/100</small>`;
    if (bandElement) bandElement.textContent = result.band;
    if (coverageElement) coverageElement.textContent = `${format(result.availableWeight)}% of the index weight is supported by the current data and selected layers.`;

    const container = el("#performanceOverallComponents");
    if (container) {
      container.innerHTML = result.components.map(component => `
        <div class="performance-component">
          <div class="performance-component-label"><b>${safe(component.label)} · ${component.weight}%</b><small>${safe(component.evidence)}</small></div>
          <div class="performance-component-track"><i style="width:${finite(component.score) ? clamp(component.score) : 0}%"></i></div>
          <div class="performance-component-score">${finite(component.score) ? formatOne(component.score) : "N/A"}</div>
        </div>`).join("");
    }
    if (el("#performanceRank")?.value === "overall") renderOverallLeaderboard(analysis);
  }

  function eligibleAuthorities(analysis) {
    const minimum = Math.max(1, Number(el("#performanceMinSample")?.value) || 5);
    return (analysis.authorities || [])
      .filter(item => item.decided >= minimum && finite(item.overallScore))
      .sort((left, right) => Number(right.overallScore) - Number(left.overallScore) || Number(right.decided) - Number(left.decided));
  }

  function renderOverallLeaderboard(analysis = window.RadharcPerformance?.getAnalysis?.()) {
    if (!analysis || el("#performanceRank")?.value !== "overall") return;
    scoreAnalysis(analysis);
    const ranked = eligibleAuthorities(analysis);
    const container = el("#performanceLeaderboard");
    if (!container) return;
    const rows = ranked.map((item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${safe(item.authority)}</td>
        <td><span class="overall-score-pill">${formatOne(item.overallScore)}</span></td>
        <td>${safe(item.overallBand)}</td>
        <td>${format(item.overallCoverage)}%</td>
        <td>${format(item.decided)}</td>
        <td>${item.medianDecisionDays == null ? "—" : formatOne(item.medianDecisionDays)}</td>
        <td>${format(item.grantUnits)}</td>
        <td>${percentage(item.refusalRate)}</td>
        <td>${format(item.appealUnits)}</td>
        <td>${item.medianAcpDays == null ? "—" : formatOne(item.medianAcpDays)}</td>
      </tr>`).join("");
    container.innerHTML = ranked.length ? `
      <table class="performance-table">
        <thead><tr><th>Rank</th><th>Authority</th><th>Overall /100</th><th>Band</th><th>Index coverage</th><th>Decisions</th><th>Median days</th><th>Units granted</th><th>Refusal rate</th><th>Units appealed</th><th>ACP days</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="performance-empty">No authorities meet the current minimum sample for an overall score.</div>';
  }

  function csvCell(value) {
    let output = String(value ?? "");
    if (/^[=+\-@]/.test(output)) output = `'${output}`;
    return `"${output.replaceAll('"', '""')}"`;
  }

  function downloadOverallCsv(event) {
    if (el("#performanceRank")?.value !== "overall") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const analysis = window.RadharcPerformance?.getAnalysis?.();
    if (!analysis) return;
    scoreAnalysis(analysis);
    const rows = eligibleAuthorities(analysis).map((item, index) => ({
      Rank: index + 1,
      Authority: item.authority,
      "Overall score": item.overallScore,
      Band: item.overallBand,
      "Index coverage": item.overallCoverage / 100,
      Decisions: item.decided,
      "Median decision days": item.medianDecisionDays ?? "",
      "FI-adjusted median days": item.medianAdjustedDays ?? "",
      "Units granted": item.grantUnits,
      "Units refused": item.refusalUnits,
      "Refusal rate": item.refusalRate ?? "",
      "Residential appeals": item.appeals,
      "Units appealed": item.appealUnits,
      "Median appeal days": item.medianAppealDays ?? "",
      "ACP cases": item.acpCases,
      "Median ACP days": item.medianAcpDays ?? ""
    }));
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const content = [headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n");
    const blob = new Blob([`\uFEFF${content}`], { type: "text/csv;charset=utf-8" });
    if (window.RadharcTools?.downloadBlob) {
      window.RadharcTools.downloadBlob(blob, `planning-overall-performance-${new Date().toISOString().slice(0, 10)}.csv`);
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `planning-overall-performance-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function installAgainstEngine() {
    if (installed || !window.RadharcPerformance || !el("#performanceDialog")) return false;
    installed = true;
    clearInterval(timer);
    injectStyles();
    injectInterface();

    const performance = window.RadharcPerformance;
    const originalRefresh = performance.refresh.bind(performance);
    performance.refresh = async function overallAwareRefresh(...args) {
      const result = await originalRefresh(...args);
      renderOverall(performance.getAnalysis());
      return result;
    };

    el("#performanceRank")?.addEventListener("change", () => {
      setTimeout(() => renderOverallLeaderboard(performance.getAnalysis()), 0);
    });
    el("#performanceMinSample")?.addEventListener("change", () => {
      if (el("#performanceRank")?.value === "overall") setTimeout(() => renderOverallLeaderboard(performance.getAnalysis()), 0);
    });
    el("#performanceExportCsv")?.addEventListener("click", downloadOverallCsv, true);

    const existing = performance.getAnalysis();
    if (existing) renderOverall(existing);
    return true;
  }

  function start() {
    if (installAgainstEngine()) return;
    timer = setInterval(installAgainstEngine, 40);
    setTimeout(() => clearInterval(timer), 300000);
  }

  window.RadharcOverallPerformance = {
    weights: { ...WEIGHTS },
    scoreAnalysis,
    render: () => renderOverall(window.RadharcPerformance?.getAnalysis?.()),
    band
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
