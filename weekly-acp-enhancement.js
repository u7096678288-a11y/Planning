"use strict";

(() => {
  const PANEL_ID = "weeklyAcpPanel";
  const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
  let renderQueued = false;

  const $ = selector => document.querySelector(selector);
  const text = value => String(value ?? "").replace(/\s+/g, " ").replace(/\s*↗\s*$/, "").trim();
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
  const format = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 }).format(Number(value) || 0);

  function injectStyles() {
    if ($("#weeklyAcpEnhancementStyles")) return;
    const style = document.createElement("style");
    style.id = "weeklyAcpEnhancementStyles";
    style.textContent = `
      .acp-breakdown{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:9px;padding:13px 14px;border-bottom:1px solid #e0e8eb;background:#f7fafb}
      .acp-breakdown article{padding:11px;border:1px solid #d7e2e6;border-radius:8px;background:#fff}
      .acp-breakdown span{display:block;color:#607783;font-size:9px;font-weight:800;text-transform:uppercase}
      .acp-breakdown strong{display:block;margin-top:4px;color:#102f49;font-size:21px}
      .acp-panel-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
      .acp-panel-note{padding:10px 14px;color:#607783;font-size:10px;border-bottom:1px solid #e0e8eb;background:#fff}
      @media(max-width:1100px){.acp-breakdown{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:650px){.acp-breakdown{grid-template-columns:1fr 1fr}.acp-panel-actions{justify-content:flex-start}}
    `;
    document.head.append(style);
  }

  function sectionKey(section) {
    return section?.dataset.section || "";
  }

  function cellText(cells, index) {
    return text(cells[index]?.textContent);
  }

  function linkFrom(cells, index) {
    return cells[index]?.querySelector("a")?.href || "";
  }

  function parseUnits(value) {
    const number = Number(String(value || "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(number) ? number : 0;
  }

  function rowFromTable(section, tr) {
    const cells = [...tr.querySelectorAll("td")];
    if (cells.length < 9) return null;
    const key = sectionKey(section);
    const heading = text(section.querySelector("h2")?.textContent).replace(/^\d+\.\s*/, "");
    const movementStrong = cells[2]?.querySelector("strong");
    const movementDate = cells[2]?.querySelector("small");
    const projectNode = cells[1]?.querySelector("a, strong");
    const tags = [...cells[1].querySelectorAll(".tag")].map(node => text(node.textContent));
    return {
      "Section": heading,
      "Section key": key,
      "Project": text(projectNode?.textContent || cells[1].textContent),
      "Movement": text(movementStrong?.textContent || cells[2].textContent),
      "Movement date": text(movementDate?.textContent),
      "Planning reference": cellText(cells, 3) === "—" ? "" : cellText(cells, 3),
      "ACP reference": cellText(cells, 4) === "—" ? "" : cellText(cells, 4),
      "Residential units": parseUnits(cellText(cells, 5)),
      "Planning authority": cellText(cells, 6),
      "Applicant": cellText(cells, 7),
      "Decision": cellText(cells, 8) === "—" ? "" : cellText(cells, 8),
      "Qualification": tags.join("; "),
      "Project URL": linkFrom(cells, 1),
      "Planning URL": linkFrom(cells, 3),
      "ACP URL": linkFrom(cells, 4)
    };
  }

  function collectRows() {
    return [...document.querySelectorAll("#reportSections section[data-section]")].flatMap(section =>
      [...section.querySelectorAll("tbody tr")]
        .map(row => rowFromTable(section, row))
        .filter(Boolean)
    );
  }

  function collectAcpRows() {
    const seen = new Set();
    return collectRows().filter(row => ["acp-lodged", "acp-decided"].includes(row["Section key"])).filter(row => {
      const key = [row["Section key"], row["ACP reference"], row["Movement date"], row.Project].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function classifyDecision(value) {
    const decision = String(value || "").toUpperCase();
    if (/GRANT|APPROV|PERMIT|CONFIRM|CONDITIONAL/.test(decision) && !/REFUS|REJECT/.test(decision)) return "Granted / approved";
    if (/REFUS|REJECT|DISMISS/.test(decision)) return "Refused / dismissed";
    if (/WITHDRAW|INVALID/.test(decision)) return "Withdrawn / invalid";
    return "Other / not stated";
  }

  function breakdown(rows) {
    const decided = rows.filter(row => row["Section key"] === "acp-decided");
    const decisions = decided.reduce((counts, row) => {
      const key = classifyDecision(row.Decision || row.Movement);
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    return {
      total: rows.length,
      lodged: rows.filter(row => row["Section key"] === "acp-lodged").length,
      decided: decided.length,
      approved: decisions["Granted / approved"] || 0,
      refused: decisions["Refused / dismissed"] || 0,
      other: (decisions["Withdrawn / invalid"] || 0) + (decisions["Other / not stated"] || 0)
    };
  }

  function updateExistingLabels() {
    const lodged = document.querySelector('#reportSections section[data-section="acp-lodged"] h2');
    const decided = document.querySelector('#reportSections section[data-section="acp-decided"] h2');
    if (lodged && lodged.textContent !== "4. An Coimisiún Pleanála — Lodged") lodged.textContent = "4. An Coimisiún Pleanála — Lodged";
    if (decided && decided.textContent !== "5. An Coimisiún Pleanála — Decided") decided.textContent = "5. An Coimisiún Pleanála — Decided";

    const summary = $("#plainSummary");
    if (summary) {
      summary.innerHTML = summary.innerHTML
        .replace(/\bACP lodged\b/g, "An Coimisiún Pleanála lodged")
        .replace(/\bACP decided\b/g, "An Coimisiún Pleanála decided");
    }
    [...document.querySelectorAll("#reportMetrics .metric span")].forEach(label => {
      if (text(label.textContent) === "ACP movements") label.textContent = "ACP / An Coimisiún Pleanála";
    });
  }

  function acpRowHtml(row, index) {
    const project = row["Project URL"]
      ? `<a class="project-link" href="${escapeHtml(row["Project URL"])}" target="_blank" rel="noopener">${escapeHtml(row.Project)} ↗</a>`
      : `<strong>${escapeHtml(row.Project)}</strong>`;
    const planningRef = row["Planning reference"]
      ? row["Planning URL"]
        ? `<a class="record-link" href="${escapeHtml(row["Planning URL"])}" target="_blank" rel="noopener">${escapeHtml(row["Planning reference"])} ↗</a>`
        : escapeHtml(row["Planning reference"])
      : "—";
    const acpRef = row["ACP reference"]
      ? row["ACP URL"]
        ? `<a class="record-link" href="${escapeHtml(row["ACP URL"])}" target="_blank" rel="noopener">${escapeHtml(row["ACP reference"])} ↗</a>`
        : escapeHtml(row["ACP reference"])
      : "—";
    return `<tr>
      <td class="rank">${index + 1}</td>
      <td class="project-title">${project}<small>${escapeHtml(row.Qualification || "ACP-linked qualifying project")}</small></td>
      <td><strong>${escapeHtml(row.Movement)}</strong><small>${escapeHtml(row["Movement date"])}</small></td>
      <td>${acpRef}</td>
      <td>${planningRef}</td>
      <td class="units">${row["Residential units"] ? format(row["Residential units"]) : "—"}</td>
      <td>${escapeHtml(row["Planning authority"])}</td>
      <td>${escapeHtml(row.Applicant || "—")}</td>
      <td>${escapeHtml(row.Decision || "—")}</td>
    </tr>`;
  }

  function renderPanel() {
    renderQueued = false;
    updateExistingLabels();
    const rows = collectAcpRows();
    const counts = breakdown(rows);
    let panel = $(`#${PANEL_ID}`);
    if (!panel) {
      panel = document.createElement("section");
      panel.id = PANEL_ID;
      panel.className = "section";
      const sections = $("#reportSections");
      sections?.before(panel);
    }
    panel.innerHTML = `
      <header class="section-head">
        <div>
          <h2>ACP / An Coimisiún Pleanála breakdown</h2>
          <p>Combined lodged and decided movements from the qualifying 28-day report.</p>
        </div>
        <div class="acp-panel-actions">
          <strong>${format(rows.length)} update${rows.length === 1 ? "" : "s"}</strong>
          <button id="exportAcpCsv" class="button" type="button" ${rows.length ? "" : "disabled"}>Download ACP CSV</button>
        </div>
      </header>
      <div class="acp-breakdown">
        <article><span>Total movements</span><strong>${format(counts.total)}</strong></article>
        <article><span>Lodged</span><strong>${format(counts.lodged)}</strong></article>
        <article><span>Decided</span><strong>${format(counts.decided)}</strong></article>
        <article><span>Granted / approved</span><strong>${format(counts.approved)}</strong></article>
        <article><span>Refused / dismissed</span><strong>${format(counts.refused)}</strong></article>
        <article><span>Other / not stated</span><strong>${format(counts.other)}</strong></article>
      </div>
      <div class="acp-panel-note">This list follows the active search, planning-authority and project-type filters. ACP links open the official case record where a case reference is published.</div>
      <div class="table-wrap">
        ${rows.length ? `<table class="report-table"><thead><tr><th>#</th><th>Project</th><th>ACP movement / date</th><th>ACP ref</th><th>Planning ref</th><th>Units</th><th>Authority</th><th>Applicant</th><th>Decision</th></tr></thead><tbody>${rows.map(acpRowHtml).join("")}</tbody></table>` : '<div class="empty">No qualifying An Coimisiún Pleanála movements under the current filters.</div>'}
      </div>`;
    $("#exportAcpCsv")?.addEventListener("click", () => exportCsv(rows, "radharc-weekly-acp-updates"));
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderPanel);
  }

  function safeCsvCell(value) {
    let output = String(value ?? "");
    if (/^[=+\-@]/.test(output)) output = `'${output}`;
    return `"${output.replaceAll('"', '""')}"`;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function exportCsv(rows, stem = "radharc-weekly-update") {
    if (!rows.length) return;
    const cleanRows = rows.map(({ "Section key": _key, ...row }) => row);
    const headers = Object.keys(cleanRows[0]);
    const csv = [
      headers.map(safeCsvCell).join(","),
      ...cleanRows.map(row => headers.map(header => safeCsvCell(row[header])).join(","))
    ].join("\r\n");
    download(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `${stem}-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = XLSX_URL;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Excel library failed to load"));
      document.head.append(script);
    });
  }

  function addAutofilter(sheet, rows) {
    if (!rows.length) return;
    sheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: Object.keys(rows[0]).length - 1 } })
    };
  }

  async function exportExcel() {
    const allRows = collectRows();
    if (!allRows.length) return;
    const acpRows = collectAcpRows();
    const counts = breakdown(acpRows);
    const button = $("#exportExcel");
    const oldText = button?.textContent || "Download Excel";
    if (button) {
      button.disabled = true;
      button.textContent = "Building Excel…";
    }
    try {
      await loadXlsx();
      const workbook = XLSX.utils.book_new();
      const summary = XLSX.utils.aoa_to_sheet([
        ["Radharc Pleanála Weekly Update", "100+ unit schemes and SIDs"],
        ["Generated", new Date().toLocaleString("en-IE")],
        ["Reporting window", text($("#reportWindow")?.textContent)],
        ["Visible weekly rows", allRows.length],
        ["ACP / An Coimisiún Pleanála movements", counts.total],
        ["ACP lodged", counts.lodged],
        ["ACP decided", counts.decided],
        ["ACP granted / approved", counts.approved],
        ["ACP refused / dismissed", counts.refused],
        ["ACP other / not stated", counts.other]
      ]);
      summary["!cols"] = [{ wch: 38 }, { wch: 72 }];

      const weeklyRows = allRows.map(({ "Section key": _key, ...row }) => row);
      const acpExportRows = acpRows.map(({ "Section key": _key, ...row }) => row);
      const weeklySheet = XLSX.utils.json_to_sheet(weeklyRows);
      const acpSheet = acpExportRows.length ? XLSX.utils.json_to_sheet(acpExportRows) : XLSX.utils.aoa_to_sheet([["No qualifying ACP movements under the current filters"]]);
      const breakdownSheet = XLSX.utils.json_to_sheet([
        { Measure: "Total movements", Count: counts.total },
        { Measure: "Lodged", Count: counts.lodged },
        { Measure: "Decided", Count: counts.decided },
        { Measure: "Granted / approved", Count: counts.approved },
        { Measure: "Refused / dismissed", Count: counts.refused },
        { Measure: "Other / not stated", Count: counts.other }
      ]);
      addAutofilter(weeklySheet, weeklyRows);
      addAutofilter(acpSheet, acpExportRows);
      XLSX.utils.book_append_sheet(workbook, summary, "Summary");
      XLSX.utils.book_append_sheet(workbook, weeklySheet, "Weekly Update");
      XLSX.utils.book_append_sheet(workbook, acpSheet, "ACP Updates");
      XLSX.utils.book_append_sheet(workbook, breakdownSheet, "ACP Breakdown");
      XLSX.writeFile(workbook, `radharc-weekly-update-${new Date().toISOString().slice(0, 10)}.xlsx`, { compression: true });
    } catch (error) {
      const status = $("#reportStatus");
      if (status) {
        status.dataset.mode = "error";
        status.firstElementChild.textContent = `Excel export failed: ${error.message}`;
      }
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText;
      }
    }
  }

  function interceptExports() {
    document.addEventListener("click", event => {
      const button = event.target.closest("#exportExcel, #exportCsv");
      if (!button || button.disabled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (button.id === "exportExcel") exportExcel();
      else exportCsv(collectRows());
    }, true);
  }

  function install() {
    injectStyles();
    interceptExports();
    const container = $("#reportSections");
    if (container) new MutationObserver(scheduleRender).observe(container, { childList: true });
    scheduleRender();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
