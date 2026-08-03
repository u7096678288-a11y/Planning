"use strict";

(function enforceWeeklyHundredUnitThreshold() {
  const MIN_UNITS = 100;
  let applying = false;

  const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const numberFrom = value => {
    const match = text(value).replaceAll(",", "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
  };
  const format = value => new Intl.NumberFormat("en-IE", { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const csvCell = value => {
    let output = String(value ?? "");
    if (/^[=+\-@]/.test(output)) output = `'${output}`;
    return `"${output.replaceAll('"', '""')}"`;
  };

  function isSid(row) {
    return [...row.querySelectorAll(".tag")].some(tag => text(tag.textContent).toUpperCase() === "SID");
  }

  function rowUnits(row) {
    return numberFrom(row.querySelector("td.units")?.textContent);
  }

  function rowQualifies(row) {
    return rowUnits(row) >= MIN_UNITS || isSid(row);
  }

  function visibleRows(section) {
    return [...section.querySelectorAll("tbody tr")].filter(row => !row.hidden && rowQualifies(row));
  }

  function projectKey(row) {
    const planning = text(row.children[3]?.textContent);
    const acp = text(row.children[4]?.textContent);
    const project = row.querySelector(".project-link")?.href || text(row.children[1]?.textContent);
    return planning !== "—" && planning ? `P:${planning}` : acp !== "—" && acp ? `A:${acp}` : project;
  }

  function updateTypeFilter() {
    const select = document.querySelector("#typeFilterWeekly");
    if (!select || select.dataset.threshold100 === "1") return;
    const previous = select.value;
    select.innerHTML = `
      <option value="all">All qualifying projects</option>
      <option value="residential">Residential — 100+ units</option>
      <option value="sid">SIDs</option>
      <option value="roads">LA road developments — qualifying only</option>
      <option value="cpo-rail">CPOs and rail orders — qualifying only</option>`;
    select.value = [...select.options].some(option => option.value === previous) ? previous : "all";
    select.dataset.threshold100 = "1";
  }

  function updateSummary(sections) {
    const rows = sections.flatMap(visibleRows);
    const projects = new Map();
    const counts = new Map();
    rows.forEach(row => {
      const section = row.closest("[data-section]")?.dataset.section || "";
      counts.set(section, (counts.get(section) || 0) + 1);
      const key = projectKey(row);
      const previous = projects.get(key) || { units: 0, sid: false };
      previous.units = Math.max(previous.units, rowUnits(row));
      previous.sid = previous.sid || isSid(row);
      projects.set(key, previous);
    });
    const units = [...projects.values()].reduce((sum, project) => sum + project.units, 0);
    const sidCount = [...projects.values()].filter(project => project.sid).length;
    const count = key => counts.get(key) || 0;

    const summary = document.querySelector("#plainSummary");
    if (summary) {
      summary.innerHTML = `<strong>${format(projects.size)} qualifying projects</strong>: residential schemes reporting at least <strong>${MIN_UNITS} units</strong>, plus <strong>${format(sidCount)} identifiable SIDs</strong> retained regardless of unit count. The report contains ${format(units)} reported residential units, ${format(count("submitted"))} submissions, ${format(count("fi"))} FI movements, ${format(count("granted"))} grants, ${format(count("acp-lodged"))} ACP lodgements, ${format(count("acp-decided"))} ACP decisions and ${format(count("upcoming"))} upcoming decisions.`;
    }

    const metrics = new Map([...document.querySelectorAll("#reportMetrics .metric")].map(card => [text(card.querySelector("span")?.textContent), card]));
    const values = {
      Projects: projects.size,
      "Residential units": units,
      Submitted: count("submitted"),
      FI: count("fi"),
      Granted: count("granted"),
      "ACP movements": count("acp-lodged") + count("acp-decided"),
      ACP: count("acp-lodged") + count("acp-decided"),
      Upcoming: count("upcoming")
    };
    Object.entries(values).forEach(([label, value]) => {
      const strong = metrics.get(label)?.querySelector("strong");
      if (strong) strong.textContent = format(value);
    });

    const visible = document.querySelector("#visibleSummary");
    if (visible) visible.textContent = `${format(rows.length)} categorised row${rows.length === 1 ? "" : "s"}`;
  }

  function applyThreshold() {
    if (applying) return;
    applying = true;
    try {
      updateTypeFilter();
      const sections = [...document.querySelectorAll("#reportSections [data-section]")];
      sections.forEach(section => {
        const rows = [...section.querySelectorAll("tbody tr")];
        let rank = 0;
        rows.forEach(row => {
          row.hidden = !rowQualifies(row);
          if (!row.hidden) {
            rank += 1;
            const rankCell = row.querySelector("td.rank");
            if (rankCell) rankCell.textContent = rank;
          }
        });
        const countNode = section.querySelector(".section-head > strong");
        if (countNode) countNode.textContent = `${format(rank)} item${rank === 1 ? "" : "s"}`;
        const empty = section.querySelector(".threshold-empty");
        if (!rank && rows.length && !empty) {
          const notice = document.createElement("div");
          notice.className = "empty threshold-empty";
          notice.textContent = `No projects meet the ${MIN_UNITS}-unit threshold or SID exception in this section.`;
          section.querySelector(".table-wrap")?.append(notice);
        } else if (rank && empty) {
          empty.remove();
        }
      });
      updateSummary(sections);
    } finally {
      applying = false;
    }
  }

  function exportRows() {
    const output = [];
    document.querySelectorAll("#reportSections [data-section]").forEach(section => {
      const sectionName = text(section.querySelector("h2")?.textContent).replace(/^\d+\.\s*/, "");
      visibleRows(section).forEach(row => {
        const cells = row.children;
        output.push({
          Section: sectionName,
          Project: text(cells[1]?.textContent),
          Movement: text(cells[2]?.querySelector("strong")?.textContent),
          "Movement date": text(cells[2]?.querySelector("small")?.textContent),
          "Planning reference": text(cells[3]?.textContent).replace(/\s*↗$/, ""),
          "ACP reference": text(cells[4]?.textContent).replace(/\s*↗$/, ""),
          "Residential units": rowUnits(row) || "",
          "Planning authority": text(cells[6]?.textContent),
          Applicant: text(cells[7]?.textContent),
          Decision: text(cells[8]?.textContent),
          Qualification: isSid(row) && rowUnits(row) < MIN_UNITS ? "SID exception" : `${MIN_UNITS}+ residential units`,
          "Project URL": row.querySelector(".project-link")?.href || "",
          "Planning URL": cells[3]?.querySelector("a")?.href || "",
          "ACP URL": cells[4]?.querySelector("a")?.href || ""
        });
      });
    });
    return output;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function downloadCsv() {
    const rows = exportRows();
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const csv = [headers.map(csvCell).join(","), ...rows.map(row => headers.map(header => csvCell(row[header])).join(","))].join("\r\n");
    downloadBlob(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `radharc-weekly-update-100-plus-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function loadSheetJs() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Excel library failed to load"));
      document.head.append(script);
    });
  }

  async function downloadExcel() {
    const rows = exportRows();
    if (!rows.length) return;
    const button = document.querySelector("#exportExcel");
    const previous = button?.textContent || "Export Excel";
    if (button) { button.disabled = true; button.textContent = "Building Excel…"; }
    try {
      await loadSheetJs();
      const workbook = XLSX.utils.book_new();
      const summary = XLSX.utils.aoa_to_sheet([
        ["Radharc Pleanála Weekly Update", "100+ unit projects and SIDs"],
        ["Generated", new Date().toLocaleString("en-IE")],
        ["Residential threshold", MIN_UNITS],
        ["Exception", "Identifiable SIDs retained regardless of unit count"],
        ["Exported rows", rows.length]
      ]);
      summary["!cols"] = [{ wch: 34 }, { wch: 72 }];
      XLSX.utils.book_append_sheet(workbook, summary, "Summary");
      const sheet = XLSX.utils.json_to_sheet(rows);
      sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: Object.keys(rows[0]).length - 1 } }) };
      sheet["!cols"] = Object.keys(rows[0]).map(header => ({ wch: Math.min(46, Math.max(12, header.length + 2)) }));
      XLSX.utils.book_append_sheet(workbook, sheet, "Qualifying Movements");
      XLSX.writeFile(workbook, `radharc-weekly-update-100-plus-${new Date().toISOString().slice(0, 10)}.xlsx`, { compression: true });
    } finally {
      if (button) { button.disabled = false; button.textContent = previous; }
    }
  }

  document.addEventListener("click", event => {
    const button = event.target.closest("#exportCsv, #exportExcel");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.id === "exportCsv") downloadCsv();
    else downloadExcel();
  }, true);

  function start() {
    updateTypeFilter();
    const target = document.querySelector("#reportSections");
    if (!target) return;
    new MutationObserver(() => queueMicrotask(applyThreshold)).observe(target, { childList: true, subtree: true });
    document.querySelector("#reportSearch")?.addEventListener("input", () => setTimeout(applyThreshold, 0));
    document.querySelector("#authorityFilterWeekly")?.addEventListener("change", () => setTimeout(applyThreshold, 0));
    document.querySelector("#typeFilterWeekly")?.addEventListener("change", () => setTimeout(applyThreshold, 0));
    document.querySelector("#clearReportFilters")?.addEventListener("click", () => setTimeout(applyThreshold, 0));
    applyThreshold();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
