"use strict";

(function installMapFileTools() {
  const T = window.RadharcTools = window.RadharcTools || {};
  const FORMATS = {
    png: { extension: "png", mime: "image/png" },
    jpg: { extension: "jpg", mime: "image/jpeg" },
    pdf: { extension: "pdf", mime: "application/pdf" },
    svg: { extension: "svg", mime: "image/svg+xml" }
  };
  const IRELAND_EXPORT_BOUNDS = L.latLngBounds(
    [51.25, -10.85],
    [55.65, -5.25]
  );
  const NATIONAL_SIZE = { width: 1200, height: 1540 };
  const CURRENT_SIZE = { width: 1500, height: 1000 };
  const EXPORT_TIMEOUT = 22000;

  function injectStyles() {
    if (document.querySelector("#mapShareStyles")) return;
    const style = document.createElement("style");
    style.id = "mapShareStyles";
    style.textContent = `
      .share-backdrop{position:fixed;inset:0;z-index:4800;display:grid;place-items:center;padding:18px;background:rgba(13,31,46,.52)}
      .share-backdrop[hidden]{display:none}
      .share-panel{width:min(610px,100%);max-height:min(790px,calc(100vh - 36px));overflow:auto;border:1px solid #c7d5dc;border-radius:12px;background:#fff;color:#132538;box-shadow:0 22px 60px rgba(7,25,39,.32)}
      .share-panel-header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px 18px;border-bottom:1px solid #dce4e8}
      .share-panel-header h2{margin:0 0 4px;font-size:18px}.share-panel-header p{margin:0;color:#607783;font-size:11px;line-height:1.4}
      .share-panel-close{border:1px solid #bdcbd2;border-radius:6px;background:#fff;color:#132538;padding:6px 9px;font-size:17px;line-height:1}
      .share-panel-section{padding:16px 18px;border-bottom:1px solid #e1e8eb}.share-panel-section:last-child{border-bottom:0}
      .share-panel-section h3{margin:0 0 9px;font-size:13px}.share-panel-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      .share-panel button,.share-panel select{min-height:38px;border:1px solid #b8c8d0;border-radius:7px;background:#fff;color:#132538;padding:8px 10px;font-size:12px;font-weight:700}
      .share-panel button:hover:not(:disabled){background:#edf5f5}.share-panel button.primary{background:#102f49;color:#fff;border-color:#102f49}
      .share-file-options{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) auto;gap:8px;align-items:end;margin-bottom:8px}
      .share-file-options label{display:grid;gap:5px;color:#506875;font-size:10px;font-weight:700}
      .share-panel-note{margin:9px 0 0;color:#607783;font-size:10px;line-height:1.45}
      .share-current-state{margin:0;padding:9px 10px;border:1px solid #dbe5e8;border-radius:7px;background:#f5f8f9;color:#425c6c;font-size:10px;line-height:1.45;overflow-wrap:anywhere}
      .share-panel button[aria-busy="true"]{cursor:wait;opacity:.7}
      .radharc-export-stage{position:fixed;left:-24000px;top:0;z-index:-1000;overflow:hidden;background:#dfe7eb;pointer-events:none}
      .radharc-export-stage .leaflet-container{width:100%;height:100%;background:#dfe7eb}
      @media(max-width:680px){.share-panel-grid,.share-file-options{grid-template-columns:1fr}.share-panel{max-height:calc(100vh - 24px)}}
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
    if (format === "pdf") {
      await loadScript(
        "jsPdfLibrary",
        "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js",
        () => Boolean(window.jspdf?.jsPDF)
      );
    }
  }

  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  function withTimeout(promise, milliseconds, fallback) {
    return Promise.race([
      promise,
      delay(milliseconds).then(() => fallback)
    ]);
  }

  function activeExportLayerKeys(extentMode) {
    return Object.keys(layers).filter(key => {
      if (!map.hasLayer(layers[key])) return false;
      if (key === "freehold" && extentMode === "ireland") return false;
      return true;
    });
  }

  function waitForTileLayer(tileLayer) {
    return withTimeout(new Promise(resolve => {
      tileLayer.once("load", () => resolve({ ok: true }));
      tileLayer.once("tileerror", () => resolve({ ok: false, message: "Some basemap tiles did not load" }));
    }), EXPORT_TIMEOUT, { ok: false, message: "Basemap loading timed out" });
  }

  function waitForFeatureLayer(layer, label) {
    return withTimeout(new Promise(resolve => {
      layer.once("load", () => resolve({ ok: true, label }));
      layer.once("requesterror", event => resolve({
        ok: false,
        label,
        message: event?.error?.message || `${label} could not be loaded`
      }));
    }), EXPORT_TIMEOUT, { ok: false, label, message: `${label} loading timed out` });
  }

  function exportLayer(key, renderer, extentMode) {
    const national = extentMode === "ireland";
    if (key === "planningPoints") {
      return L.esri.featureLayer({
        url: S.planningPoints.url,
        where: smartPlanningWhere(),
        renderer,
        interactive: false,
        cacheLayers: false,
        pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
          renderer,
          radius: national ? 1.65 : 3,
          color: "#ffffff",
          weight: national ? 0.45 : 0.8,
          fillColor: S.planningPoints.color,
          fillOpacity: 0.9
        })
      });
    }
    if (key === "planningSites") {
      return L.esri.featureLayer({
        url: S.planningSites.url,
        where: smartPlanningWhere(),
        renderer,
        interactive: false,
        cacheLayers: false,
        style: {
          renderer,
          color: S.planningSites.color,
          weight: national ? 0.8 : 1.5,
          fillColor: S.planningSites.color,
          fillOpacity: national ? 0.1 : 0.15
        }
      });
    }
    if (key === "acpCases") {
      return L.esri.featureLayer({
        url: S.acpCases.url,
        where: smartAcpWhere(),
        renderer,
        interactive: false,
        cacheLayers: false,
        style: {
          renderer,
          color: S.acpCases.color,
          weight: national ? 1 : 1.8,
          dashArray: national ? "3 2" : "5 3",
          fillColor: S.acpCases.color,
          fillOpacity: national ? 0.08 : 0.13
        },
        pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
          renderer,
          radius: national ? 2.1 : 4,
          color: "#ffffff",
          weight: 0.7,
          fillColor: S.acpCases.color,
          fillOpacity: 0.92
        })
      });
    }
    if (key === "freehold") {
      return L.esri.featureLayer({
        url: S.freehold.url,
        renderer,
        interactive: false,
        cacheLayers: false,
        style: {
          renderer,
          color: S.freehold.color,
          weight: 0.7,
          fillColor: S.freehold.color,
          fillOpacity: 0.05
        }
      });
    }
    return null;
  }

  function selectedExtentMode() {
    return document.querySelector("#shareMapExtent")?.value || "ireland";
  }

  function exportBounds(extentMode) {
    return extentMode === "current"
      ? L.latLngBounds(map.getBounds().getSouthWest(), map.getBounds().getNorthEast())
      : IRELAND_EXPORT_BOUNDS;
  }

  function exportSize(extentMode) {
    if (extentMode === "ireland") return NATIONAL_SIZE;
    const bounds = map.getBounds();
    const westEast = Math.max(0.1, bounds.getEast() - bounds.getWest());
    const southNorth = Math.max(0.1, bounds.getNorth() - bounds.getSouth());
    return westEast / southNorth > 1.15 ? CURRENT_SIZE : NATIONAL_SIZE;
  }

  async function buildExportMap(extentMode) {
    const size = exportSize(extentMode);
    const stage = document.createElement("div");
    stage.className = "radharc-export-stage";
    stage.style.width = `${size.width}px`;
    stage.style.height = `${size.height}px`;
    const mapElement = document.createElement("div");
    mapElement.id = `radharcExportMap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    stage.append(mapElement);
    document.body.append(stage);

    const exportMap = L.map(mapElement, {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
      fadeAnimation: false,
      zoomAnimation: false,
      markerZoomAnimation: false,
      inertia: false
    });
    const renderer = L.canvas({ padding: 0.35, tolerance: 2 });
    const tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      crossOrigin: true,
      updateWhenIdle: true,
      keepBuffer: 2,
      attribution: "© OpenStreetMap contributors"
    });
    const tileReady = waitForTileLayer(tileLayer);
    tileLayer.addTo(exportMap);

    exportMap.fitBounds(exportBounds(extentMode), {
      padding: extentMode === "ireland" ? [54, 54] : [28, 28],
      animate: false,
      maxZoom: extentMode === "ireland" ? 7 : 17
    });
    exportMap.invalidateSize(false);
    await new Promise(resolve => exportMap.whenReady(resolve));
    await delay(180);

    const keys = activeExportLayerKeys(extentMode);
    const featureLayers = [];
    const layerReady = [];
    keys.forEach(key => {
      const layer = exportLayer(key, renderer, extentMode);
      if (!layer) return;
      featureLayers.push(layer);
      layerReady.push(waitForFeatureLayer(layer, S[key]?.label || key));
      layer.addTo(exportMap);
    });

    const results = await Promise.all([tileReady, ...layerReady]);
    await waitForRenderedContent(mapElement);
    await delay(350);

    return {
      stage,
      mapElement,
      exportMap,
      featureLayers,
      keys,
      size,
      extentMode,
      warnings: results.filter(result => result && result.ok === false).map(result => result.message).filter(Boolean)
    };
  }

  async function waitForRenderedContent(container, timeout = EXPORT_TIMEOUT) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const tiles = [...container.querySelectorAll("img.leaflet-tile")];
      const tileReady = tiles.length > 0 && tiles.every(tile => tile.complete && tile.naturalWidth > 0);
      const vectors = container.querySelector(".leaflet-overlay-pane canvas, .leaflet-overlay-pane svg");
      if (tileReady && vectors) return;
      if (tileReady && !activeExportLayerKeys(selectedExtentMode()).length) return;
      await delay(120);
    }
  }

  function visibleRect(rect, containerRect) {
    return rect.right > containerRect.left && rect.left < containerRect.right && rect.bottom > containerRect.top && rect.top < containerRect.bottom;
  }

  function drawElementImage(context, source, rect, containerRect) {
    if (!visibleRect(rect, containerRect)) return;
    const x = rect.left - containerRect.left;
    const y = rect.top - containerRect.top;
    if (rect.width <= 0 || rect.height <= 0) return;
    context.drawImage(source, x, y, rect.width, rect.height);
  }

  async function drawSvgElement(context, svg, containerRect) {
    const rect = svg.getBoundingClientRect();
    if (!visibleRect(rect, containerRect) || rect.width <= 0 || rect.height <= 0) return;
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(rect.width));
    clone.setAttribute("height", String(rect.height));
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const item = new Image();
        item.onload = () => resolve(item);
        item.onerror = () => reject(new Error("A vector map layer could not be rendered"));
        item.src = url;
      });
      drawElementImage(context, image, rect, containerRect);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function renderLeafletMap(mapElement, size) {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#dfe7eb";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const containerRect = mapElement.getBoundingClientRect();

    const tiles = [...mapElement.querySelectorAll(".leaflet-tile-pane img.leaflet-tile")]
      .filter(tile => tile.complete && tile.naturalWidth > 0);
    for (const tile of tiles) {
      const opacity = Number.parseFloat(getComputedStyle(tile).opacity || "1");
      context.save();
      context.globalAlpha = Number.isFinite(opacity) ? opacity : 1;
      drawElementImage(context, tile, tile.getBoundingClientRect(), containerRect);
      context.restore();
    }

    const canvases = [...mapElement.querySelectorAll(".leaflet-overlay-pane canvas, .leaflet-marker-pane canvas")];
    canvases.forEach(layerCanvas => drawElementImage(context, layerCanvas, layerCanvas.getBoundingClientRect(), containerRect));

    const svgs = [...mapElement.querySelectorAll(".leaflet-overlay-pane svg, .leaflet-marker-pane svg")];
    for (const svg of svgs) await drawSvgElement(context, svg, containerRect);

    const images = [...mapElement.querySelectorAll(".leaflet-overlay-pane img, .leaflet-marker-pane img")]
      .filter(image => image.complete && image.naturalWidth > 0);
    images.forEach(image => drawElementImage(context, image, image.getBoundingClientRect(), containerRect));
    return canvas;
  }

  function wrapText(context, text, x, y, maxWidth, lineHeight, maxLines = 2) {
    const words = String(text).split(/\s+/);
    let line = "";
    let lineNumber = 0;
    for (let index = 0; index < words.length; index += 1) {
      const test = `${line}${line ? " " : ""}${words[index]}`;
      if (context.measureText(test).width > maxWidth && line) {
        context.fillText(line, x, y + lineNumber * lineHeight);
        line = words[index];
        lineNumber += 1;
        if (lineNumber >= maxLines - 1) break;
      } else line = test;
    }
    if (lineNumber < maxLines) context.fillText(line, x, y + lineNumber * lineHeight);
  }

  function legendItems(keys) {
    return keys.map(key => ({ label: S[key]?.label || key, color: S[key]?.color || "#425c6c" }));
  }

  function composeExportCanvas(mapCanvas, keys, extentMode, warnings) {
    const header = 166;
    const footer = 84;
    const output = document.createElement("canvas");
    output.width = mapCanvas.width;
    output.height = header + mapCanvas.height + footer;
    const context = output.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, output.width, output.height);

    context.fillStyle = "#102f49";
    context.font = "700 38px Arial, sans-serif";
    context.fillText("Radharc Pleanála — Map snapshot", 28, 48);
    context.fillStyle = "#425c6c";
    context.font = "18px Arial, sans-serif";
    context.fillText(`Extent: ${extentMode === "ireland" ? "Ireland" : "Current dashboard view"}`, 28, 82);
    context.font = "15px Arial, sans-serif";
    wrapText(context, smartSummary(), 28, 112, output.width - 56, 21, 2);

    const items = legendItems(keys);
    if (items.length) {
      let x = 28;
      const y = 145;
      context.font = "13px Arial, sans-serif";
      items.forEach(item => {
        context.fillStyle = item.color;
        context.fillRect(x, y - 11, 16, 10);
        context.strokeStyle = "#ffffff";
        context.strokeRect(x, y - 11, 16, 10);
        context.fillStyle = "#425c6c";
        context.fillText(item.label, x + 22, y - 2);
        x += Math.min(330, context.measureText(item.label).width + 52);
      });
    }

    context.drawImage(mapCanvas, 0, header);
    context.strokeStyle = "#c9d5db";
    context.strokeRect(0.5, header + 0.5, mapCanvas.width - 1, mapCanvas.height - 1);

    context.fillStyle = "#506875";
    context.font = "13px Arial, sans-serif";
    const generated = new Date().toLocaleString("en-IE", { dateStyle: "medium", timeStyle: "short" });
    const warningText = warnings.length ? ` · Notes: ${warnings.join("; ")}` : "";
    wrapText(
      context,
      `Generated ${generated} · Map data © OpenStreetMap contributors · Public planning and ACP data feeds${warningText}`,
      28,
      header + mapCanvas.height + 34,
      output.width - 56,
      18,
      2
    );
    return output;
  }

  function canvasBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("The browser could not create the map file")),
      mime,
      quality
    ));
  }

  async function createExportCanvas(extentMode) {
    let built;
    try {
      built = await buildExportMap(extentMode);
      const mapCanvas = await renderLeafletMap(built.mapElement, built.size);
      return composeExportCanvas(mapCanvas, built.keys, extentMode, built.warnings);
    } finally {
      if (built?.exportMap) built.exportMap.remove();
      if (built?.stage) built.stage.remove();
    }
  }

  async function createFile(formatKey) {
    const format = FORMATS[formatKey] || FORMATS.png;
    await ensureLibraries(formatKey);
    const extentMode = selectedExtentMode();
    const canvas = await createExportCanvas(extentMode);
    let blob;
    if (formatKey === "jpg") blob = await canvasBlob(canvas, "image/jpeg", 0.93);
    else if (formatKey === "pdf") {
      const JsPDF = window.jspdf?.jsPDF;
      if (!JsPDF) throw new Error("PDF library did not load");
      const pdf = new JsPDF({
        orientation: canvas.width >= canvas.height ? "landscape" : "portrait",
        unit: "mm",
        format: "a4",
        compress: true
      });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 8;
      const scale = Math.min((pageWidth - margin * 2) / canvas.width, (pageHeight - margin * 2) / canvas.height);
      const width = canvas.width * scale;
      const height = canvas.height * scale;
      pdf.addImage(
        canvas.toDataURL("image/jpeg", 0.92),
        "JPEG",
        (pageWidth - width) / 2,
        (pageHeight - height) / 2,
        width,
        height,
        undefined,
        "FAST"
      );
      blob = pdf.output("blob");
    } else if (formatKey === "svg") {
      const png = canvas.toDataURL("image/png");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><title>Radharc Pleanála map snapshot</title><image width="${canvas.width}" height="${canvas.height}" href="${png}"/></svg>`;
      blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    } else blob = await canvasBlob(canvas, "image/png");
    const extentName = extentMode === "ireland" ? "ireland" : "current-view";
    const name = `radharc-pleanala-map-${extentName}-${new Date().toISOString().slice(0, 10)}.${format.extension}`;
    return new File([blob], name, { type: format.mime, lastModified: Date.now() });
  }

  async function busy(button, text, task) {
    const previous = button.textContent;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = text;
    try {
      return await task();
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = previous;
    }
  }

  function selectedFormat() {
    return document.querySelector("#shareMapFormat")?.value || "png";
  }

  function canShare(file) {
    try {
      return Boolean(navigator.share && navigator.canShare?.({ files: [file] }));
    } catch {
      return false;
    }
  }

  async function downloadMap(button) {
    try {
      await busy(button, "Building clean map…", async () => {
        const file = await createFile(selectedFormat());
        T.downloadBlob(file, file.name);
        T.showMessage(`${file.name} downloaded.`);
      });
    } catch (error) {
      console.error(error);
      T.showMessage(`Map export failed: ${T.errorMessage(error)}`, "error", 9000);
    }
  }

  async function shareMap(button, emailPreferred) {
    try {
      await busy(button, "Building clean map…", async () => {
        const file = await createFile(selectedFormat());
        const url = T.buildShareUrl();
        if (canShare(file)) {
          await navigator.share({
            title: "Radharc Pleanála map",
            text: `Irish planning map snapshot · ${smartSummary()}\n${url}`,
            files: [file]
          });
          T.showMessage(emailPreferred ? "Choose your email app in the share sheet." : "Map file shared.");
          return;
        }
        T.downloadBlob(file, file.name);
        if (emailPreferred) {
          T.openEmail(
            "Radharc Pleanála map",
            `The map file ${file.name} has been downloaded to this device. Please attach it to this email.\n\n${smartSummary()}\n\nDashboard link: ${url}`
          );
          T.showMessage("Map downloaded and an email draft was opened. Attach the downloaded file.", "ok", 7000);
        } else {
          T.showMessage("Direct file sharing is unavailable, so the map was downloaded instead.", "ok", 7000);
        }
      });
    } catch (error) {
      if (error?.name !== "AbortError") {
        console.error(error);
        T.showMessage(`Map sharing failed: ${T.errorMessage(error)}`, "error", 9000);
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
        <header class="share-panel-header">
          <div><h2 id="sharePanelTitle">Share or export</h2><p>Share the active dashboard state or create a correctly aligned map file.</p></div>
          <button id="closeSharePanel" class="share-panel-close" type="button" aria-label="Close">×</button>
        </header>
        <section class="share-panel-section">
          <h3>Dashboard link</h3>
          <div class="share-panel-grid">
            <button id="systemShareLink" class="primary" type="button">Share link</button>
            <button id="emailShareLink" type="button">Email link</button>
            <button id="copyShareLink" type="button">Copy link</button>
          </div>
        </section>
        <section class="share-panel-section">
          <h3>Map file</h3>
          <div class="share-file-options">
            <label>Format
              <select id="shareMapFormat" aria-label="Map file format">
                <option value="png">PNG image</option>
                <option value="jpg">JPG image</option>
                <option value="pdf">PDF document</option>
                <option value="svg">SVG image</option>
              </select>
            </label>
            <label>Export extent
              <select id="shareMapExtent" aria-label="Map export extent">
                <option value="ireland" selected>Ireland — fitted and centred</option>
                <option value="current">Current dashboard view</option>
              </select>
            </label>
            <button id="downloadMapFile" class="primary" type="button">Download map</button>
          </div>
          <div class="share-panel-grid">
            <button id="systemShareMap" type="button">Share map file</button>
            <button id="emailShareMap" type="button">Email map</button>
          </div>
          <p class="share-panel-note">Ireland is the default export extent. A separate off-screen map is rebuilt for the file, preventing Leaflet overlay shifts. Freehold parcels are omitted from national exports because they are a local-scale layer.</p>
        </section>
        <section class="share-panel-section"><p id="shareCurrentState" class="share-current-state"></p></section>
      </section>`;
    document.body.append(backdrop);

    const close = () => {
      backdrop.hidden = true;
      document.body.style.overflow = "";
      document.querySelector("#shareViewButton")?.focus();
    };
    backdrop.addEventListener("click", event => {
      if (event.target === backdrop) close();
    });
    document.querySelector("#closeSharePanel").onclick = close;
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !backdrop.hidden) close();
    });
    document.querySelector("#systemShareLink").onclick = T.shareDashboardLink;
    document.querySelector("#emailShareLink").onclick = T.emailDashboardLink;
    document.querySelector("#copyShareLink").onclick = async () => {
      await T.copyText(T.buildShareUrl());
      T.showMessage("Share link copied to the clipboard.");
    };
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