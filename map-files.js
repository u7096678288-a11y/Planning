"use strict";

(function installMapFileTools() {
  const T = window.RadharcTools = window.RadharcTools || {};
  const FORMATS = {
    png: { extension: "png", mime: "image/png" },
    jpg: { extension: "jpg", mime: "image/jpeg" },
    pdf: { extension: "pdf", mime: "application/pdf" },
    svg: { extension: "svg", mime: "image/svg+xml" }
  };

  function injectStyles() {
    if (document.querySelector("#mapShareStyles")) return;
    const style = document.createElement("style");
    style.id = "mapShareStyles";
    style.textContent = `
      .share-backdrop{position:fixed;inset:0;z-index:4800;display:grid;place-items:center;padding:18px;background:rgba(13,31,46,.52)}
      .share-backdrop[hidden]{display:none}
      .share-panel{width:min(560px,100%);max-height:min(760px,calc(100vh - 36px));overflow:auto;border:1px solid #c7d5dc;border-radius:12px;background:#fff;color:#132538;box-shadow:0 22px 60px rgba(7,25,39,.32)}
      .share-panel-header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px 18px;border-bottom:1px solid #dce4e8}
      .share-panel-header h2{margin:0 0 4px;font-size:18px}.share-panel-header p{margin:0;color:#607783;font-size:11px;line-height:1.4}
      .share-panel-close{border:1px solid #bdcbd2;border-radius:6px;background:#fff;color:#132538;padding:6px 9px;font-size:17px;line-height:1}
      .share-panel-section{padding:16px 18px;border-bottom:1px solid #e1e8eb}.share-panel-section:last-child{border-bottom:0}
      .share-panel-section h3{margin:0 0 9px;font-size:13px}.share-panel-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      .share-panel button,.share-panel select{min-height:38px;border:1px solid #b8c8d0;border-radius:7px;background:#fff;color:#132538;padding:8px 10px;font-size:12px;font-weight:700}
      .share-panel button:hover:not(:disabled){background:#edf5f5}.share-panel button.primary{background:#102f49;color:#fff;border-color:#102f49}
      .share-format-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-bottom:8px}.share-panel-note{margin:9px 0 0;color:#607783;font-size:10px;line-height:1.45}
      .share-current-state{margin:0;padding:9px 10px;border:1px solid #dbe5e8;border-radius:7px;background:#f5f8f9;color:#425c6c;font-size:10px;line-height:1.45;overflow-wrap:anywhere}
      .share-panel button[aria-busy="true"]{cursor:wait;opacity:.7}
      @media(max-width:620px){.share-panel-grid,.share-format-row{grid-template-columns:1fr}.share-panel{max-height:calc(100vh - 24px)}}
    `;
    document.head.append(style);
  }

  function loadScript(id, src, ready) {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let script = document.querySelector(`#${id}`);
      if (!script) {
        script = document.createElement("script");
        script.id = id;
        script.src = src;
        script.async = true;
        document.head.append(script);
      }
      const finish = () => ready() ? resolve() : reject(new Error(`Library failed to initialise: ${id}`));
      script.addEventListener("load", finish, { once: true });
      script.addEventListener("error", () => reject(new Error(`Library failed to load: ${id}`)), { once: true });
    });
  }

  async function ensureLibraries(format) {
    await loadScript("html2canvasLibrary", "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js", () => typeof window.html2canvas === "function");
    if (format === "pdf") await loadScript("jsPdfLibrary", "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js", () => Boolean(window.jspdf?.jsPDF));
  }

  async function waitForTiles(timeout = 6000) {
    const container = document.querySelector("#map");
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const tiles = [...container.querySelectorAll("img.leaflet-tile")];
      if (!tiles.length || tiles.every(tile => tile.complete && tile.naturalWidth > 0)) return;
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  }

  function wrapText(context, text, x, y, maxWidth, lineHeight, maxLines = 2) {
    const words = String(text).split(/\s+/);
    let line = "";
    let lineNumber = 0;
    for (let index = 0; index < words.length; index++) {
      const test = `${line}${line ? " " : ""}${words[index]}`;
      if (context.measureText(test).width > maxWidth && line) {
        context.fillText(line, x, y + lineNumber * lineHeight);
        line = words[index];
        if (++lineNumber >= maxLines - 1) break;
      } else line = test;
    }
    if (lineNumber < maxLines) context.fillText(line, x, y + lineNumber * lineHeight);
  }

  async function captureCanvas() {
    if (typeof window.html2canvas !== "function") throw new Error("Map image library did not load");
    const element = document.querySelector("#map");
    map.invalidateSize();
    await waitForTiles();
    const raw = await window.html2canvas(element, {
      useCORS: true, allowTaint: false, backgroundColor: "#dfe7eb", logging: false,
      scale: Math.min(2, Math.max(1, window.devicePixelRatio || 1)), imageTimeout: 12000,
      ignoreElements: node => node.classList?.contains("leaflet-control-zoom") || node.classList?.contains("leaflet-popup-pane")
    });
    const header = Math.round(raw.width * 0.09);
    const footer = Math.round(raw.width * 0.055);
    const output = document.createElement("canvas");
    output.width = raw.width;
    output.height = header + raw.height + footer;
    const context = output.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, output.width, output.height);
    context.fillStyle = "#102f49";
    context.font = `700 ${Math.max(18, Math.round(output.width * 0.025))}px Arial, sans-serif`;
    context.fillText("Radharc Pleanála — Map snapshot", 24, Math.round(header * 0.42));
    context.fillStyle = "#425c6c";
    context.font = `${Math.max(11, Math.round(output.width * 0.012))}px Arial, sans-serif`;
    wrapText(context, smartSummary(), 24, Math.round(header * 0.72), output.width - 48, Math.max(14, Math.round(output.width * 0.016)), 2);
    context.drawImage(raw, 0, header);
    context.fillStyle = "#506875";
    context.font = `${Math.max(9, Math.round(output.width * 0.0095))}px Arial, sans-serif`;
    const generated = new Date().toLocaleString("en-IE", { dateStyle: "medium", timeStyle: "short" });
    wrapText(context, `Generated ${generated} · Map data © OpenStreetMap contributors · Public planning and ACP data feeds`, 24, header + raw.height + Math.round(footer * 0.58), output.width - 48, 13, 2);
    return output;
  }

  function canvasBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The browser could not create the map file")), mime, quality));
  }

  async function createFile(formatKey) {
    const format = FORMATS[formatKey] || FORMATS.png;
    await ensureLibraries(formatKey);
    const canvas = await captureCanvas();
    let blob;
    if (formatKey === "jpg") blob = await canvasBlob(canvas, "image/jpeg", 0.92);
    else if (formatKey === "pdf") {
      const JsPDF = window.jspdf?.jsPDF;
      if (!JsPDF) throw new Error("PDF library did not load");
      const pdf = new JsPDF({ orientation: canvas.width >= canvas.height ? "landscape" : "portrait", unit: "mm", format: "a4", compress: true });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 8;
      const scale = Math.min((pageWidth - margin * 2) / canvas.width, (pageHeight - margin * 2) / canvas.height);
      const width = canvas.width * scale;
      const height = canvas.height * scale;
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", (pageWidth - width) / 2, (pageHeight - height) / 2, width, height, undefined, "FAST");
      blob = pdf.output("blob");
    } else if (formatKey === "svg") {
      const png = canvas.toDataURL("image/png");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><title>Radharc Pleanála map snapshot</title><image width="${canvas.width}" height="${canvas.height}" href="${png}"/></svg>`;
      blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    } else blob = await canvasBlob(canvas, "image/png");
    const name = `radharc-pleanala-map-${new Date().toISOString().slice(0, 10)}.${format.extension}`;
    return new File([blob], name, { type: format.mime, lastModified: Date.now() });
  }

  async function busy(button, text, task) {
    const previous = button.textContent;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = text;
    try { return await task(); }
    finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = previous;
    }
  }

  function format() {
    return document.querySelector("#shareMapFormat")?.value || "png";
  }

  function canShare(file) {
    try { return Boolean(navigator.share && navigator.canShare?.({ files: [file] })); }
    catch { return false; }
  }

  async function downloadMap(button) {
    try {
      await busy(button, "Creating map…", async () => {
        const file = await createFile(format());
        T.downloadBlob(file, file.name);
        T.showMessage(`${file.name} downloaded.`);
      });
    } catch (error) {
      console.error(error);
      T.showMessage(`Map export failed: ${T.errorMessage(error)}`, "error", 8000);
    }
  }

  async function shareMap(button, emailPreferred) {
    try {
      await busy(button, "Creating map…", async () => {
        const file = await createFile(format());
        const url = T.buildShareUrl();
        if (canShare(file)) {
          await navigator.share({ title: "Radharc Pleanála map", text: `Irish planning map snapshot · ${smartSummary()}\n${url}`, files: [file] });
          T.showMessage(emailPreferred ? "Choose your email app in the share sheet." : "Map file shared.");
          return;
        }
        T.downloadBlob(file, file.name);
        if (emailPreferred) {
          T.openEmail("Radharc Pleanála map", `The map file ${file.name} has been downloaded to this device. Please attach it to this email.\n\n${smartSummary()}\n\nDashboard link: ${url}`);
          T.showMessage("Map downloaded and an email draft was opened. Attach the downloaded file.", "ok", 7000);
        } else T.showMessage("Direct file sharing is unavailable, so the map was downloaded instead.", "ok", 7000);
      });
    } catch (error) {
      if (error?.name !== "AbortError") {
        console.error(error);
        T.showMessage(`Map sharing failed: ${T.errorMessage(error)}`, "error", 8000);
      }
    }
  }

  function buildPanel() {
    if (document.querySelector("#shareBackdrop")) return;
    const backdrop = document.createElement("div");
    backdrop.id = "shareBackdrop";
    backdrop.className = "share-backdrop";
    backdrop.hidden = true;
    backdrop.innerHTML = `
      <section class="share-panel" role="dialog" aria-modal="true" aria-labelledby="sharePanelTitle">
        <header class="share-panel-header"><div><h2 id="sharePanelTitle">Share or export</h2><p>Share the active dashboard state or create a map file.</p></div><button id="closeSharePanel" class="share-panel-close" type="button" aria-label="Close">×</button></header>
        <section class="share-panel-section"><h3>Dashboard link</h3><div class="share-panel-grid"><button id="systemShareLink" class="primary" type="button">Share link</button><button id="emailShareLink" type="button">Email link</button><button id="copyShareLink" type="button">Copy link</button></div></section>
        <section class="share-panel-section"><h3>Map file</h3><div class="share-format-row"><select id="shareMapFormat" aria-label="Map file format"><option value="png">PNG image</option><option value="jpg">JPG image</option><option value="pdf">PDF document</option><option value="svg">SVG image</option></select><button id="downloadMapFile" class="primary" type="button">Download map</button></div><div class="share-panel-grid"><button id="systemShareMap" type="button">Share map file</button><button id="emailShareMap" type="button">Email map</button></div><p class="share-panel-note">Direct attachment depends on browser support. Otherwise the map downloads first and the email draft asks you to attach it.</p></section>
        <section class="share-panel-section"><p id="shareCurrentState" class="share-current-state"></p></section>
      </section>`;
    document.body.append(backdrop);
    const close = () => {
      backdrop.hidden = true;
      document.body.style.overflow = "";
      document.querySelector("#shareViewButton")?.focus();
    };
    backdrop.addEventListener("click", event => { if (event.target === backdrop) close(); });
    document.querySelector("#closeSharePanel").onclick = close;
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !backdrop.hidden) close(); });
    document.querySelector("#systemShareLink").onclick = T.shareDashboardLink;
    document.querySelector("#emailShareLink").onclick = T.emailDashboardLink;
    document.querySelector("#copyShareLink").onclick = async () => { await T.copyText(T.buildShareUrl()); T.showMessage("Share link copied to the clipboard."); };
    document.querySelector("#downloadMapFile").onclick = event => downloadMap(event.currentTarget);
    document.querySelector("#systemShareMap").onclick = event => shareMap(event.currentTarget, false);
    document.querySelector("#emailShareMap").onclick = event => shareMap(event.currentTarget, true);
  }

  function openPanel() {
    document.querySelector("#shareCurrentState").textContent = smartSummary();
    const backdrop = document.querySelector("#shareBackdrop");
    backdrop.hidden = false;
    document.body.style.overflow = "hidden";
    document.querySelector("#systemShareLink")?.focus();
  }

  T.onReady(() => {
    injectStyles();
    buildPanel();
    document.querySelector("#shareViewButton")?.addEventListener("click", openPanel);
  });
})();