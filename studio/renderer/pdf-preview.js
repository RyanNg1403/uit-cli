// No viewer, annotation layer, scripting manager, or document URLs enter this engine.
const MAX_PDF_PAGES = 2000;

export function createPdfPreview(container, bytes) {
  const root = document.createElement("section");
  root.className = "pdf-preview";
  root.setAttribute("aria-label", "PDF preview");
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar";
  toolbar.setAttribute("role", "group");
  toolbar.setAttribute("aria-label", "PDF controls");
  const status = document.createElement("p");
  status.className = "pdf-status";
  status.setAttribute("role", "status");
  status.textContent = "Loading PDF...";
  const surface = document.createElement("div");
  surface.className = "pdf-surface";
  surface.setAttribute("role", "region");
  surface.setAttribute("aria-label", "PDF pages");
  surface.tabIndex = 0;
  const jump = document.createElement("input");
  jump.className = "pdf-page-input";
  jump.type = "number";
  jump.min = "1";
  jump.setAttribute("aria-label", "Page number");
  const count = document.createElement("span");
  count.className = "pdf-page-count";
  const slots = [];
  const residents = new Map();
  const maxPages = 5, pixelsPerPage = Math.floor(4_194_304 / maxPages);
  let disposed = false, pageNumber = 1, zoom = 1, wanted = [];
  let worker, pdfWorker, loadingTask, pdf, running, destruction;

  toolbar.append(jump, count);
  root.append(toolbar, status, surface);
  container.append(root);

  function updateControls() {
    jump.disabled = disposed || !pdf;
    if (document.activeElement !== jump) jump.value = String(pageNumber);
    count.textContent = pdf ? `Page ${pageNumber} of ${pdf.numPages}` : "";
    const current = residents.get(pageNumber);
    root.setAttribute("aria-busy", String(!current?.done));
    if (!pdf) return;
    status.setAttribute("role", current?.error ? "alert" : "status");
    status.textContent = current?.error ? `PDF page could not be rendered. ${current.error}`
      : current?.done ? `Page ${pageNumber} of ${pdf.numPages} rendered. In-memory preview; no file saved.`
      : `Rendering page ${pageNumber} of ${pdf.numPages}...`;
  }

  function sizeSlot(slot) {
    slot.element.style.width = `${slot.width * zoom}px`;
    slot.element.style.height = `${slot.height * zoom}px`;
  }

  function evict(number, job) {
    job.cancelled = true;
    job.task?.cancel();
    if (job.canvas) job.canvas.width = job.canvas.height = 0;
    slots[number - 1].element.replaceChildren();
    residents.delete(number);
  }

  function refresh() {
    if (disposed || !pdf || !slots.length) return;
    // Slot offsets include corrected dimensions; binary search avoids scanning a large document.
    const top = surface.scrollTop + 9;
    let low = 0, high = slots.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (slots[mid].element.offsetTop <= top) low = mid;
      else high = mid - 1;
    }
    pageNumber = low + 1;
    wanted = [pageNumber];
    const bottom = surface.scrollTop + surface.clientHeight;
    for (let next = pageNumber + 1; next <= slots.length && wanted.length < maxPages && slots[next - 1].element.offsetTop < bottom; next++) wanted.push(next);
    for (let distance = 1; wanted.length < Math.min(maxPages, slots.length); distance++) {
      for (const number of [pageNumber + distance, pageNumber - distance]) {
        if (number > 0 && number <= slots.length && !wanted.includes(number) && wanted.length < maxPages) wanted.push(number);
      }
    }
    for (const [number, job] of residents) if (!wanted.includes(number)) evict(number, job);
    // A scroll to a new page must not wait for an obsolete prefetch render.
    for (const [number, job] of residents) if (!job.done && !job.error && number !== pageNumber) evict(number, job);
    updateControls();
    void pump();
  }

  function pump() {
    if (running || disposed) return running;
    running = (async () => {
      while (!disposed) {
        const number = wanted.find((number) => !residents.has(number));
        if (!number) break;
        const slot = slots[number - 1];
        const job = { cancelled: false, done: false, canvas: null, task: null, error: null };
        residents.set(number, job);
        let page;
        try {
          page = await pdf.getPage(number);
          if (job.cancelled || disposed) continue;
          const base = page.getViewport({ scale: 1 });
          if (![base.width, base.height].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Invalid PDF page dimensions.");
          const anchor = slots[pageNumber - 1].element.offsetTop;
          slot.width = base.width;
          slot.height = base.height;
          sizeSlot(slot);
          surface.scrollTop += slots[pageNumber - 1].element.offsetTop - anchor;
          const viewport = page.getViewport({ scale: zoom });
          const { width, height } = viewport;
          const scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(pixelsPerPage / width / height), 8192 / width, 8192 / height);
          const canvas = document.createElement("canvas");
          job.canvas = canvas;
          canvas.className = "pdf-canvas";
          canvas.setAttribute("role", "img");
          canvas.setAttribute("aria-label", `PDF page ${number}`);
          canvas.width = Math.max(1, Math.floor(width * scale));
          canvas.height = Math.max(1, Math.floor(height * scale));
          canvas.hidden = true;
          slot.element.append(canvas);
          job.task = page.render({
            canvasContext: canvas.getContext("2d", { alpha: false }), viewport,
            transform: [scale, 0, 0, scale, 0, 0], annotationMode: 0,
          });
          await job.task.promise;
          job.task = null;
          if (job.cancelled || disposed) continue;
          const content = await page.getTextContent();
          if (job.cancelled || disposed) continue;
          const text = document.createElement("pre");
          text.className = "pdf-text";
          text.setAttribute("aria-label", `PDF page ${number} text`);
          text.tabIndex = 0;
          text.textContent = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim() || "No extractable text on this page.";
          slot.element.append(text);
          canvas.hidden = false;
          job.done = true;
        } catch (error) {
          if (!disposed && !job.cancelled) {
            job.error = error.message || String(error);
            if (job.canvas) job.canvas.width = job.canvas.height = 0;
          }
        } finally {
          page?.cleanup();
          if (!disposed) updateControls();
        }
      }
    })().finally(() => { running = null; });
    return running;
  }

  function jumpToPage() {
    if (disposed || !pdf) return;
    const number = Math.max(1, Math.min(pdf.numPages, Math.round(Number(jump.value) || 1)));
    jump.value = String(number);
    surface.scrollTop = slots[number - 1].element.offsetTop - 8;
    refresh();
  }
  jump.addEventListener("change", jumpToPage);
  jump.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); jumpToPage(); } });
  surface.addEventListener("scroll", refresh);
  const observer = new ResizeObserver(refresh);
  observer.observe(surface);

  async function destroy() {
    if (disposed) return destruction;
    disposed = true;
    bytes = null;
    observer.disconnect();
    surface.removeEventListener("scroll", refresh);
    for (const [number, job] of residents) evict(number, job);
    wanted = [];
    root.remove();
    root.replaceChildren();
    surface.replaceChildren();
    destruction = (async () => {
      try { await loadingTask?.destroy(); }
      finally {
        pdfWorker?.destroy();
        // PDFWorker does not own (or terminate) a caller-supplied worker port.
        worker?.terminate();
        await running;
        slots.length = 0;
        pdf = loadingTask = pdfWorker = worker = null;
      }
    })();
    return destruction;
  }

  updateControls();
  const ready = (async () => {
    try {
      const { getDocument, PDFWorker } = await import("../../node_modules/pdfjs-dist/build/pdf.mjs");
      if (disposed) return;
      worker = new Worker(new URL("../../node_modules/pdfjs-dist/build/pdf.worker.mjs", import.meta.url), { type: "module" });
      pdfWorker = new PDFWorker({ port: worker });
      loadingTask = getDocument({
        data: bytes, worker: pdfWorker, isEvalSupported: false, enableXfa: false,
        disableFontFace: true, useSystemFonts: false,
        cMapUrl: new URL("../../node_modules/pdfjs-dist/cmaps/", import.meta.url).href,
        cMapPacked: true,
        standardFontDataUrl: new URL("../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href,
        maxImageSize: 4_194_304, canvasMaxAreaInBytes: 16_777_216,
      });
      bytes = null;
      const loaded = await loadingTask.promise;
      if (disposed) return;
      if (!Number.isSafeInteger(loaded.numPages) || loaded.numPages < 1 || loaded.numPages > MAX_PDF_PAGES) {
        throw new Error(`PDF preview supports 1 to ${MAX_PDF_PAGES} pages.`);
      }
      pdf = loaded;
      const first = await pdf.getPage(1);
      if (disposed) return;
      const { width, height } = first.getViewport({ scale: 1 });
      first.cleanup();
      if (![width, height].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Invalid PDF page dimensions.");
      const fragment = document.createDocumentFragment();
      for (let number = 1; number <= pdf.numPages; number++) {
        const element = document.createElement("section");
        element.className = "pdf-page";
        element.dataset.page = String(number);
        element.setAttribute("aria-label", `Page ${number}`);
        const slot = { element, width, height };
        slots.push(slot);
        sizeSlot(slot);
        fragment.append(element);
      }
      surface.append(fragment);
      jump.max = String(pdf.numPages);
      refresh();
      await running;
    } catch (error) {
      if (disposed) return;
      await destroy();
      throw error;
    }
  })();
  return { ready, destroy };
}
