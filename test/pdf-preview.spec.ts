import { test, expect, calls, openCourse, control } from "./fixtures/desktop";
import { pdfFixture } from "./fixtures/pdf";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const stats = { created: 0, terminated: 0, peakPixels: 0, peakCanvases: 0, urls: [] as string[], canvases: [] as HTMLCanvasElement[] };
    (window as any).__pdfStats = stats;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        stats.created++;
        stats.urls.push(String(url));
      }
      terminate() { stats.terminated++; super.terminate(); }
    };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: any[]) {
      if (this.classList.contains("pdf-canvas") && !stats.canvases.includes(this)) stats.canvases.push(this);
      stats.peakPixels = Math.max(stats.peakPixels, stats.canvases.reduce((total, canvas) => total + canvas.width * canvas.height, 0));
      stats.peakCanvases = Math.max(stats.peakCanvases, stats.canvases.filter((canvas) => canvas.width * canvas.height > 0).length);
      return (getContext as any).apply(this, args);
    } as typeof getContext;
  });
});

test("12-page PDF scrolls forward, back and last with bounded canvases, text and no side effects", async ({ page, boot }) => {
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  page.on("dialog", (dialog) => { throw new Error(`PDF script executed: ${dialog.message()}`); });
  await boot();
  await page.evaluate((data) => {
    window.uit.courses.preview = async () => ({ mimeType: "application/pdf", data: btoa(data) });
  }, pdfFixture(612, 792, 12));
  await openCourse(page);
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  const status = page.locator(".pdf-status");
  const canvas = page.locator('.pdf-page[data-page="1"] .pdf-canvas');
  await expect(status).toContainText("Page 1 of 12 rendered");
  await expect(page.locator(".pdf-page")).toHaveCount(12);
  const pixels = await canvas.evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let green = 0, black = 0, white = 0, red = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 255) continue;
      if (data[i] < 80 && data[i + 1] > 100) green++;
      if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) black++;
      if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) white++;
      if (data[i] > 240 && data[i + 1] < 10 && data[i + 2] < 10) red++;
    }
    return { green, black, white, red, width: canvas.width };
  });
  expect(pixels.green).toBeGreaterThan(1000);
  expect(pixels.black).toBeGreaterThan(100);
  expect(pixels.white).toBeGreaterThan(1000);
  expect(pixels.red).toBeGreaterThan(1000);
  await expect(page.getByRole("button", { name: /Previous page|Next page/ })).toHaveCount(0);
  await expect(page.getByLabel("PDF page 1 text", { exact: true })).toContainText("UIT OFFLINE PDF PAGE 1");
  await expect(page.locator(".pdf-toolbar button")).toHaveCount(0);
  const toolbarTop = (await page.locator(".pdf-toolbar").boundingBox())!.y;
  await page.locator(".pdf-surface").hover();
  await page.mouse.wheel(0, 1020);
  await expect(status).toContainText("Page 2 of 12 rendered");
  await expect(page.getByLabel("PDF page 2 text", { exact: true })).toContainText("UIT OFFLINE PDF PAGE 2");
  expect((await page.locator(".pdf-toolbar").boundingBox())!.y).toBe(toolbarTop);
  await page.mouse.wheel(0, -1020);
  await expect(status).toContainText("Page 1 of 12 rendered");
  await page.locator(".pdf-surface").evaluate((surface) => { surface.scrollTop = surface.scrollHeight; });
  await expect(status).toContainText("Page 12 of 12 rendered");
  await expect(page.getByLabel("PDF page 12 text", { exact: true })).toContainText("UIT OFFLINE PDF PAGE 12");
  await expect(canvas).toHaveCount(0);
  expect(await page.locator(".pdf-canvas").count()).toBeLessThanOrEqual(5);
  await page.getByRole("spinbutton", { name: "Page number" }).fill("1");
  await page.getByRole("spinbutton", { name: "Page number" }).press("Enter");
  await expect(status).toContainText("Page 1 of 12 rendered");
  await expect(page.locator("#reader-body iframe, #reader-body a, #reader-body form, #reader-body script")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pdfStats.urls)).toEqual([new URL("/node_modules/pdfjs-dist/build/pdf.worker.mjs", page.url()).href]);
  for (const method of ["courses.materialize", "courses.open", "shell.open", "workspace.create", "agent.start"]) expect(await calls(page, method)).toHaveLength(0);
  expect(downloads).toEqual([]);
  expect(page.context().pages()).toHaveLength(1);
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect(page.locator("#reader-body")).toBeEmpty();
  await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.terminated)).toBe(1);
  expect(await page.evaluate(() => (window as any).__pdfStats.canvases.every((canvas: HTMLCanvasElement) => canvas.width === 0 && canvas.height === 0))).toBe(true);
});

test("rejects PDFs whose page count would create an unsafe placeholder DOM", async ({ page, boot }) => {
  await boot();
  await page.evaluate((data) => {
    window.uit.courses.preview = async () => ({ mimeType: "application/pdf", data: btoa(data) });
  }, pdfFixture(10, 10, 2001));
  await openCourse(page);
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  await expect(page.locator("#reader-body [role=alert]")).toContainText("Preview could not be loaded");
  await expect(page.locator(".pdf-page")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.terminated)).toBe(1);
});

test("closing during PDF.js import prevents a late worker or reader", async ({ page, boot }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const request = new Promise<void>((resolve) => { requested = resolve; });
  await page.route("**/build/pdf.mjs", async (route) => { requested(); await gate; await route.continue(); });
  await boot();
  await openCourse(page);
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  await request;
  await page.getByRole("button", { name: "Close preview" }).click();
  release();
  await page.evaluate(async () => { const url = "/node_modules/pdfjs-dist/build/pdf.mjs"; await import(url); });
  await expect(page.locator("#reader-body")).toBeEmpty();
  expect(await page.evaluate(() => (window as any).__pdfStats.created)).toBe(0);
});

test("closing during worker loading destroys the task and reopening is independent", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  // Stall worker protocol messages, not the UI event loop or a network timeout.
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker { postMessage() {} };
  });
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.created)).toBe(1);
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.terminated)).toBe(1);
  await page.evaluate(() => { window.Worker = Object.getPrototypeOf(window.Worker); });
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  await expect(page.locator(".pdf-status")).toContainText("Page 1 of 2 rendered");
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.terminated)).toBe(2);
});

test("closing before preview bytes arrive never starts the PDF engine", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await control(page, "hold", "courses.preview");
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  await page.getByRole("button", { name: "Close preview" }).click();
  await page.locator("#announcement-list .resource-open").last().click();
  await control(page, "release", "courses.preview");
  await expect(page.locator("#reader-body")).toContainText("Full announcement 6");
  expect(await page.evaluate(() => (window as any).__pdfStats.created)).toBe(0);
});

test("closing during canvas rendering cancels work and clears backing memory", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.evaluate(() => {
    (window as any).__nativeAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    const button = [...document.querySelectorAll<HTMLButtonElement>("#contents-panel .resource-open")].find((button) => button.textContent?.includes("slide.pdf"))!;
    button.click();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.canvases.length)).toBe(1);
  await page.evaluate(() => {
    (document.querySelector("#resource-reader") as HTMLDialogElement).close();
    window.requestAnimationFrame = (window as any).__nativeAnimationFrame;
  });
  await expect(page.locator("#reader-body")).toBeEmpty();
  await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.terminated)).toBe(1);
  expect(await page.evaluate(() => (window as any).__pdfStats.canvases.map((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]))).toEqual([[0, 0]]);
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  await expect(page.locator(".pdf-status")).toContainText("Page 1 of 2 rendered");
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.terminated)).toBe(2);
});

test("malformed PDF reports retry and tears down its worker", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.evaluate(() => {
    const preview = window.uit.courses.preview;
    let first = true;
    window.uit.courses.preview = async (input: unknown) => {
      const result = await preview(input);
      if (first) { first = false; result.data = btoa("%PDF-1.7\ninvalid"); }
      return result;
    };
  });
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  await expect(page.locator("#reader-body [role=alert]")).toContainText("Preview could not be loaded");
  await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.terminated)).toBe(1);
  await page.getByRole("button", { name: "Retry preview" }).click();
  await expect(page.locator(".pdf-status")).toContainText("Page 1 of 2 rendered");
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.terminated)).toBe(2);
});

test("large pages on high DPR stay within canvas limits and mobile viewport", async ({ page, boot }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await boot();
  await page.evaluate((data) => {
    Object.defineProperty(window, "devicePixelRatio", { value: 8 });
    window.uit.courses.preview = async () => ({ mimeType: "application/pdf", data: btoa(data) });
  }, pdfFixture(14400, 14400, 12));
  await page.locator(".course-row").first().click();
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  await expect(page.locator(".pdf-status")).toContainText("Page 1 of 12 rendered");
  await expect(page.locator(".pdf-toolbar button")).toHaveCount(0);
  for (const number of [6, 12, 1]) {
    await page.getByRole("spinbutton", { name: "Page number" }).fill(String(number));
    await page.getByRole("spinbutton", { name: "Page number" }).press("Enter");
    await expect(page.locator(".pdf-status")).toContainText(`Page ${number} of 12 rendered`);
    const sizes = await page.evaluate(() => (window as any).__pdfStats.canvases.map((canvas: HTMLCanvasElement) => ({ area: canvas.width * canvas.height, width: canvas.width, height: canvas.height })));
    expect(sizes.reduce((total: number, size: { area: number }) => total + size.area, 0)).toBeLessThanOrEqual(4_194_304);
    expect(sizes.filter((size: { area: number }) => size.area > 0).length).toBeLessThanOrEqual(5);
    expect(sizes.every((size: { width: number; height: number }) => Math.max(size.width, size.height) <= 8192)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => (window as any).__pdfStats.peakPixels)).toBeLessThanOrEqual(4_194_304);
  expect(await page.evaluate(() => (window as any).__pdfStats.peakCanvases)).toBeLessThanOrEqual(5);
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.terminated)).toBe(1);
});

for (const close of [false, true]) {
  test(`stale scroll renders are cancelled before ${close ? "close" : "resuming on the last page"}`, async ({ page, boot }) => {
    await boot();
    await page.evaluate((data) => {
      window.uit.courses.preview = async () => ({ mimeType: "application/pdf", data: btoa(data) });
    }, pdfFixture(612, 792, 12));
    await openCourse(page);
    await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
    await expect(page.locator(".pdf-canvas:not([hidden])")).toHaveCount(5);
    await page.evaluate(() => {
      (window as any).__nativeAnimationFrame = window.requestAnimationFrame;
      (window as any).__frames = [];
      window.requestAnimationFrame = (callback) => { (window as any).__frames.push(callback); return 0; };
    });
    await page.locator(".pdf-surface").evaluate((surface) => {
      surface.scrollTop = surface.scrollHeight;
      surface.dispatchEvent(new Event("scroll"));
    });
    // PDF.js render tasks schedule via requestAnimationFrame, so the stubbed frame
    // queue stalls the pump on the first new page: exactly one new canvas appears
    // for the jumped-to page while stale residents are evicted synchronously.
    await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.canvases.length)).toBe(6);
    expect(await page.evaluate(() => (window as any).__pdfStats.canvases[0].width)).toBe(0);
    if (close) await page.evaluate(() => { (document.querySelector("#resource-reader") as HTMLDialogElement).close(); });
    await page.evaluate(() => {
      window.requestAnimationFrame = (window as any).__nativeAnimationFrame;
      for (const callback of (window as any).__frames) window.requestAnimationFrame(callback);
    });
    if (!close) {
      await expect(page.locator(".pdf-status")).toContainText("Page 12 of 12 rendered");
      await expect(page.getByLabel("PDF page 12 text", { exact: true })).toContainText("UIT OFFLINE PDF PAGE 12");
      await expect(page.locator('.pdf-page[data-page="1"] .pdf-canvas')).toHaveCount(0);
      await page.getByRole("button", { name: "Close preview" }).click();
    }
    await expect(page.locator("#reader-body")).toBeEmpty();
    await expect.poll(() => page.evaluate(() => (window as any).__pdfStats.terminated)).toBe(1);
    expect(await page.evaluate(() => (window as any).__pdfStats.canvases.every((canvas: HTMLCanvasElement) => canvas.width === 0 && canvas.height === 0))).toBe(true);
  });
}

test("dark mode preserves white PDF pages and original image colors", async ({ page, boot }) => {
  await boot();
  await openCourse(page);
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  await expect(page.locator(".pdf-status")).toContainText("Page 1 of 2 rendered");
  const canvas = page.locator('.pdf-page[data-page="1"] .pdf-canvas');
  const light = await canvas.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".pdf-toolbar")).toHaveCSS("background-color", "rgb(21, 25, 35)");
  await expect(canvas).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(canvas).toHaveCSS("filter", "none");
  expect(await canvas.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(light);
  await page.getByRole("spinbutton", { name: "Page number" }).fill("2");
  await page.getByRole("spinbutton", { name: "Page number" }).press("Enter");
  await expect(page.locator(".pdf-status")).toContainText("Page 2 of 2 rendered");
  await expect(page.locator('.pdf-page[data-page="2"] .pdf-canvas')).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.getByRole("button", { name: "Close preview" }).click();
});

test("mixed-size page estimates settle without losing the jumped page", async ({ page, boot }) => {
  await boot();
  await page.evaluate((data) => {
    window.uit.courses.preview = async () => ({ mimeType: "application/pdf", data: btoa(data) });
  }, pdfFixture(612, 792, 12, Array.from({ length: 12 }, (_, index) => index % 2 ? [900, 1200] : [612, 792])));
  await openCourse(page);
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  await expect(page.locator(".pdf-status")).toContainText("Page 1 of 12 rendered");
  for (const number of [8, 12, 2, 1]) {
    await page.getByRole("spinbutton", { name: "Page number" }).fill(String(number));
    await page.getByRole("spinbutton", { name: "Page number" }).press("Enter");
    await expect(page.locator(".pdf-status")).toContainText(`Page ${number} of 12 rendered`);
    await expect(page.locator(".pdf-canvas:not([hidden])")).toHaveCount(5);
    await expect(page.locator(".pdf-page-count")).toHaveText(`Page ${number} of 12`);
  }
  await page.getByRole("button", { name: "Close preview" }).click();
});
