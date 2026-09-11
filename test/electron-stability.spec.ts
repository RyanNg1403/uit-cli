import { test, expect } from "playwright/test";
import { _electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { courses, CURRENT, LEGACY, fileTypes, key, openCourse, STORE } from "./fixtures/desktop";
import { pdfFixture } from "./fixtures/pdf";

// Linux CI uses Xvfb and software rendering, so the same 60-second soak can
// require several minutes of wall time while screenshots and PDF views settle.
test.describe.configure({ mode: "serial", retries: 0, timeout: 420_000 });

test("one hidden Electron process survives an offline navigation and PDF soak", async ({}, info) => {
  const mainPath = fileURLToPath(new URL("../desktop/main.cjs", import.meta.url));
  // Refuse to launch an older main that would put a visible window on the desktop.
  expect(await readFile(mainPath, "utf8"), "Main must support UIT_TEST_HEADLESS before this test can launch").toContain("UIT_TEST_HEADLESS");
  await mkdir(info.outputDir, { recursive: true });
  const profile = await mkdtemp(info.outputPath("stability-profile-"));
  const env: Record<string, string> = {
    HOME: profile, USERPROFILE: profile, PATH: profile,
    APPDATA: profile, LOCALAPPDATA: profile, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile,
    UIT_TEST_HEADLESS: "1", UIT_TEST_PROFILE: profile, UIT_DISABLE_CONFIG: "1",
    CODEX_HOME: join(profile, "codex"),
  };
  for (const name of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name]) env[name] = process.env[name]!;
  }

  const started = performance.now();
  const log = {
    headless: true, profile, pid: 0, durationMs: 0, soakDurationMs: 0, cycles: 0,
    failures: [] as string[], console: [] as string[], stdout: [] as string[], stderr: [] as string[],
    lifecycle: [] as { event: string; atMs: number; intentional: boolean; detail?: unknown }[],
    heartbeats: [] as { atMs: number; latencyMs: number; main: unknown; renderer: unknown }[],
    memory: [] as { phase: string; mainHeapBytes: number; rendererHeapBytes: number; workingSetBytes: number; processes: unknown }[],
    workers: [] as { event: string; url: string; atMs: number }[],
    mainDiagnostics: null as unknown, shutdown: { requested: false, completed: false },
  };
  let intentional = false;
  let stopHeartbeat = false;
  let heartbeat: Promise<void> | undefined;
  let wakeHeartbeat: (() => void) | undefined;
  let soakStarted: number | undefined;
  const activeWorkers = new Set<string>();
  const app = await _electron.launch({
    args: [mainPath, "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND",
      "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>"],
    env, timeout: 20_000,
  });
  const child = app.process();
  log.pid = child.pid!;
  const lifecycle = (event: string, detail?: unknown) => {
    log.lifecycle.push({ event, detail, intentional, atMs: performance.now() - started });
    if (!intentional) log.failures.push(`Unexpected ${event}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  };
  child.on("exit", (code, signal) => lifecycle("process-exit", { code, signal }));
  child.on("error", (error) => log.failures.push(`Process error: ${error.message}`));
  child.stdout?.on("data", (chunk) => log.stdout.push(String(chunk)));
  child.stderr?.on("data", (chunk) => log.stderr.push(String(chunk)));
  app.on("close", () => lifecycle("app-close"));
  app.on("console", (message) => log.console.push(`main ${message.type()}: ${message.text()}`));

  try {
    await app.evaluate(({ app, BrowserWindow, session }) => {
      const state = { intentional: false, events: [] as unknown[], network: [] as string[], calls: [] as unknown[] };
      (globalThis as any).__stability = state;
      const record = (event: string, detail?: unknown) => state.events.push({ event, detail, at: Date.now(), intentional: state.intentional });
      app.on("child-process-gone", (_event, details) => record("child-process-gone", details));
      app.on("render-process-gone", (_event, _contents, details) => record("render-process-gone", details));
      app.on("before-quit", () => record("before-quit"));
      process.on("uncaughtExceptionMonitor", (error) => record("uncaught-exception", String(error)));
      const watch = (window: Electron.BrowserWindow) => {
        // Hidden windows must still schedule PDF canvas rendering and UI updates.
        window.webContents.setBackgroundThrottling(false);
        window.on("show", () => record("window-shown"));
        window.on("unresponsive", () => record("unresponsive"));
        window.on("closed", () => record("window-closed"));
        if (window.isVisible()) record("window-already-visible");
      };
      const initialWindows = BrowserWindow.getAllWindows();
      let windowCount = initialWindows.length;
      initialWindows.forEach(watch);
      app.on("browser-window-created", (_event, window) => {
        if (windowCount++ > 0) record("extra-window", { title: window.getTitle(), visible: window.isVisible() });
        watch(window);
      });
      const blockNetwork = (target: Electron.Session) => {
        target.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
          state.network.push(details.url); callback({ cancel: true });
        });
        target.on("will-download", (event) => { event.preventDefault(); record("download"); });
      };
      blockNetwork(session.defaultSession);
      app.on("session-created", blockNetwork);
      globalThis.fetch = async () => { record("main-fetch"); throw new Error("Network forbidden in stability test"); };
    });
    const window = await app.firstWindow();
    window.setDefaultTimeout(5_000);
    window.on("crash", () => log.failures.push("Renderer crashed"));
    window.on("close", () => lifecycle("renderer-close"));
    window.on("pageerror", (error) => log.failures.push(error.stack || error.message));
    window.on("console", (message) => {
      log.console.push(`renderer ${message.type()}: ${message.text()}`);
      if (message.type() === "error") log.failures.push(message.text());
    });
    window.on("dialog", (dialog) => { log.failures.push(`Unexpected dialog: ${dialog.message()}`); void dialog.dismiss(); });
    window.on("download", (download) => log.failures.push(`Unexpected download: ${download.suggestedFilename()}`));
    window.on("worker", (worker) => {
      const url = worker.url();
      const id = `${log.workers.length}:${url}`;
      activeWorkers.add(id);
      log.workers.push({ event: "created", url, atMs: performance.now() - started });
      worker.on("close", () => {
        activeWorkers.delete(id);
        log.workers.push({ event: "closed", url, atMs: performance.now() - started });
      });
    });
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(profile);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(), ...(window.webContents as any).getLastWebPreferences(),
    })))).toMatchObject([{ visible: false, sandbox: true, contextIsolation: true, nodeIntegration: false }]);
    await expect(window.locator("#account-label")).toHaveText("Connect accounts");
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())).toBe(window.url());
    expect(await window.evaluate(() => globalThis.window.uit.session.status())).toMatchObject({ authenticated: false, sessions: [] });
    expect(await window.evaluate(() => ({
      require: typeof (globalThis as any).require, process: typeof (globalThis as any).process,
      ipcRenderer: typeof (globalThis as any).ipcRenderer, invoke: typeof globalThis.window.uit.invoke,
      frozen: Object.isFrozen(globalThis.window.uit) && Object.isFrozen(globalThis.window.uit.session),
    }))).toEqual({ require: "undefined", process: "undefined", ipcRenderer: "undefined", invoke: "undefined", frozen: true });

    // Exercise real preload/main authorization before replacing any course handlers.
    const denied = await window.evaluate(async ({ CURRENT, LEGACY }) => {
      const results: { operation: string; error: string }[] = [];
      for (const baseUrl of [CURRENT, LEGACY, `${LEGACY}/sdh`]) {
        const input = { courseId: 1, baseUrl, userId: 101, filename: "slide.pdf", fileUrl: `${baseUrl}/pluginfile.php/1/slide.pdf`, taskId: "unsent", message: "never sent" };
        for (const [namespace, method] of [["courses", "contents"], ["courses", "assignments"], ["courses", "announcements"], ["courses", "preview"], ["courses", "materialize"], ["courses", "open"], ["workspace", "create"], ["agent", "start"]]) {
          try { await globalThis.window.uit[namespace][method](input); results.push({ operation: method, error: "UNEXPECTED SUCCESS" }); }
          catch (error) { results.push({ operation: method, error: String(error) }); }
        }
      }
      for (const method of ["list", "refresh"]) {
        try { await globalThis.window.uit.courses[method](); results.push({ operation: method, error: "UNEXPECTED SUCCESS" }); }
        catch (error) { results.push({ operation: method, error: String(error) }); }
      }
      return results;
    }, { CURRENT, LEGACY });
    expect(denied).toHaveLength(26);
    for (const result of denied) expect(result.error, result.operation).toMatch(/Sign in|Connect a UIT course account first/);
    await window.getByRole("button", { name: "Connect UIT account", exact: true }).click();
    await expect(window.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
    await window.getByRole("button", { name: "Close accounts" }).click();
    expect(await window.evaluate(() => globalThis.window.uit.session.status())).toMatchObject({ authenticated: false, sessions: [] });
    const invalidLogins = await window.evaluate(async ({ CURRENT, LEGACY }) => {
      const results: string[] = [];
      for (const [method, baseUrl] of [["login", CURRENT], ["ssoLogin", LEGACY], ["login", "https://example.invalid"], ["login", `${CURRENT}/not-root`]]) {
        try {
          await globalThis.window.uit.session[method]({ baseUrl, username: "fixture", password: "never-sent" });
          results.push("UNEXPECTED SUCCESS");
        } catch (error) { results.push(String(error)); }
      }
      return results;
    }, { CURRENT, LEGACY });
    expect(invalidLogins[0]).toContain("requires UIT SSO");
    expect(invalidLogins[1]).toContain("current course site only");
    for (const error of invalidLogins.slice(2)) expect(error).toMatch(/official UIT|root URL/);

    const files = fileTypes.map((file) => ({
      filename: file.filename, mimetype: file.mimetype,
      data: file.data || Buffer.from(file.filename === "slide.pdf" ? pdfFixture() : file.text || "").toString("base64"),
    }));
    await app.evaluate(({ ipcMain }, { courses, files }) => {
      const state = (globalThis as any).__stability;
      const responses: Record<string, unknown> = {
        "session:status": { authenticated: true, sessions: [courses[0], courses[14]].map(({ baseUrl, userId }) => ({ baseUrl, userId, authMode: "fixture" })) },
        "courses:list": courses, "courses:refresh": courses,
        "course:assignments": [], "course:announcements": [],
        "codex:status": { installed: false, message: "Offline fixture; no Codex process" },
      };
      const forbidden = ["session:login", "session:sso-login", "session:logout", "course:materialize", "course:open", "workspace:create", "shell:open",
        "agent:start", "agent:send", "agent:fork", "agent:delete", "agent:stop", "agent:approve", "agent:disconnect"];
      for (const channel of [...Object.keys(responses), "course:contents", "course:preview", ...forbidden]) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (_event, input) => {
          state.calls.push({ channel, input });
          if (forbidden.includes(channel)) { state.events.push({ event: "forbidden-ipc", channel }); throw new Error(`Forbidden side effect: ${channel}`); }
          if (channel === "course:contents") return [{ id: 501, name: "Offline materials", section: "Week 1", files: files.map((file) => ({
            filename: file.filename, mimetype: file.mimetype, fileurl: `${input.baseUrl}/pluginfile.php/${input.courseId}/${file.filename}`,
          })) }];
          if (channel === "course:preview") {
            const file = files.find((file) => file.filename === input.filename);
            if (!file) throw new Error("Unknown fixture file");
            return { filename: file.filename, mimeType: file.mimetype, data: file.data };
          }
          return responses[channel];
        });
      }
    }, { courses, files });
    await window.addInitScript(() => {
      const stats = { created: 0, terminated: 0, live: 0, peak: 0, urls: [] as string[] };
      (globalThis as any).__stabilityWorkers = stats;
      const NativeWorker = globalThis.Worker;
      globalThis.Worker = class extends NativeWorker {
        private stopped = false;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          stats.created++; stats.live++; stats.peak = Math.max(stats.peak, stats.live); stats.urls.push(String(url));
        }
        terminate() {
          if (!this.stopped) { this.stopped = true; stats.terminated++; stats.live--; }
          super.terminate();
        }
      };
    });
    const drafts = new Map([0, 14].map((index) => [index, `Unsent draft for ${courses[index].shortname}`]));
    const threads = [0, 14].map((index) => ({
      id: `offline-${index}`, title: `Offline draft ${index}`, course: courses[index],
      owner: { baseUrl: courses[index].baseUrl, userId: courses[index].userId },
      draft: drafts.get(index)!, resources: [],
      messages: [{ role: "user", text: "Previously sent fixture prompt; no model turn was executed." }],
      prompted: true, started: true, archived: false, renamed: true,
      threadId: null, turnId: null, cwd: null, createdAt: 1, updatedAt: 1,
    }));
    await window.addInitScript(({ STORE, threads, projects }) => {
      if (sessionStorage.getItem("stability-seeded")) return;
      localStorage.setItem(STORE, JSON.stringify({ version: 1, activeId: null, projects, threads }));
      sessionStorage.setItem("stability-seeded", "true");
    }, { STORE, threads, projects: [courses[0], courses[14]] });
    await window.reload();
    await expect(window.locator(".course-row")).toHaveCount(19);
    const cdp = await window.context().newCDPSession(window);
    await cdp.send("Performance.enable");
    const sampleMemory = async (phase: string) => {
      const main = await app.evaluate(({ app }) => ({ heap: process.memoryUsage().heapUsed, processes: app.getAppMetrics() }));
      const { metrics } = await cdp.send("Performance.getMetrics");
      const heap = metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value;
      expect(heap, "Renderer heap metric must be available").toBeGreaterThan(0);
      log.memory.push({ phase, mainHeapBytes: main.heap, rendererHeapBytes: heap!,
        workingSetBytes: main.processes.reduce((total, item) => total + item.memory.workingSetSize * 1024, 0), processes: main.processes });
    };
    heartbeat = (async () => {
      while (!stopHeartbeat) {
        const tick = performance.now();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const [main, renderer] = await Promise.race([
            Promise.all([
              app.evaluate(({ BrowserWindow }) => ({ pid: process.pid, now: Date.now(), events: (globalThis as any).__stability.events,
                windows: BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), destroyed: window.isDestroyed() })) })),
              window.evaluate(() => ({ now: Date.now(), ready: document.readyState, width: innerWidth,
                sequence: (globalThis as any).__stabilityBeat = ((globalThis as any).__stabilityBeat || 0) + 1,
                workers: (globalThis as any).__stabilityWorkers })),
            ]),
            new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Main/renderer heartbeat timed out after 4 seconds")), 4_000); }),
          ]);
          log.heartbeats.push({ atMs: tick - started, latencyMs: performance.now() - tick, main, renderer });
          expect(main.pid).toBe(log.pid);
          expect(main.windows).toEqual([{ visible: false, destroyed: false }]);
          expect(main.events).toEqual([]);
        } catch (error) { log.failures.push(String(error)); return; }
        finally { clearTimeout(timeout); }
        if (!stopHeartbeat) await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          wakeHeartbeat = () => { clearTimeout(timer); resolve(); };
        });
      }
    })();
    const screenshot = async (name: string) => {
      const path = info.outputPath(`${name}.png`);
      await window.screenshot({ path });
      await info.attach(name, { path, contentType: "image/png" });
    };
    const navigation = async () => {
      if (await window.getByRole("button", { name: "Open navigation" }).isVisible()) {
        await window.getByRole("button", { name: "Open navigation" }).click();
      }
    };
    await navigation();
    await window.locator('.nav-item[data-view="agent"]').click();
    await expect(window.locator("#course-nav .project")).toHaveCount(2);
    await window.getByRole("button", { name: "New project", exact: true }).click();
    await window.locator(".project-option").filter({ hasText: courses[1].fullname }).click();
    await expect(window.getByLabel("Thread course")).toHaveAttribute("data-course-key", key(1));
    await window.getByLabel("Message Codex").fill("Temporary project draft: never send or retain this thread.");
    await navigation();
    await window.locator('.nav-item[data-view="courses"]').click();
    await window.locator('.nav-item[data-view="agent"]').click();
    await expect(window.locator("#course-nav .project")).toHaveCount(3);
    await expect(window.locator(".thread-link")).toHaveCount(2);
    await expect(window.getByLabel("Message Codex")).toHaveValue("");
    expect(await window.evaluate((STORE) => {
      const saved = JSON.parse(localStorage.getItem(STORE)!);
      return { projects: saved.projects.map((project: { shortname: string }) => project.shortname), ids: saved.threads.map((thread: { id: string }) => thread.id) };
    }, STORE)).toEqual({ projects: [courses[0].shortname, courses[14].shortname, courses[1].shortname], ids: threads.map((thread) => thread.id) });
    await sampleMemory("before-previews");
    soakStarted = performance.now();
    // Wall-clock soak, not a fixed sleep: keep interacting in the same renderer/process.
    while (performance.now() - soakStarted < 60_000 || log.cycles < 6) {
      const index = log.cycles % 2 === 0 ? 0 : 14;
      const mobile = log.cycles % 2 === 1;
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 920));
      await expect.poll(() => window.evaluate(() => innerWidth)).toBe(1440);
      await expect(window.locator("#sidebar-resize")).toBeVisible();
      await navigation();
      await openCourse(window, index);
      await window.keyboard.press("Meta+b");
      await expect(window.locator("#sidebar")).toBeHidden();
      await expect(window.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
      await window.keyboard.press("Meta+b");
      await expect(window.locator("#sidebar")).toBeVisible();
      await expect(window.getByRole("button", { name: "Close navigation", exact: true })).toBeVisible();
      if (log.cycles === 0) {
        const separator = window.getByRole("separator", { name: "Navigation width" });
        const width = Number(await separator.getAttribute("aria-valuenow"));
        const box = (await separator.boundingBox())!;
        await window.mouse.move(box.x + box.width / 2, 100);
        await window.mouse.down();
        await window.mouse.move(box.x + box.width / 2 + 20, 100, { steps: 4 });
        await window.mouse.up();
        await expect(separator).toHaveAttribute("aria-valuenow", String(width + 20));
      }
      if (log.cycles === 0) await screenshot("stability-course");
      if (mobile) {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(390, 844));
        await expect.poll(() => window.evaluate(() => innerWidth)).toBe(390);
      }
      await window.locator("#contents-panel .resource-open").filter({ hasText: "script.py" }).click();
      await expect(window.locator("#reader-body pre")).toHaveText("print('hello from memory')");
      await window.getByRole("button", { name: "Close preview" }).click();
      await expect(window.locator("#reader-body")).toBeEmpty();
      await window.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
      await expect(window.locator(".pdf-status")).toContainText("Page 1 of 2 rendered");
      await expect(window.locator(".pdf-page[data-page]")).toHaveCount(2);
      await expect(window.locator(".pdf-page[data-page] .pdf-canvas:not([hidden])")).toHaveCount(2);
      await expect(window.getByRole("button", { name: /Previous page|Next page/ })).toHaveCount(0);
      const canvases = await window.locator(".pdf-page[data-page] .pdf-canvas").elementHandles();
      try {
        const sizes = await Promise.all(canvases.map((canvas) => canvas.evaluate((element: HTMLCanvasElement) => ({ width: element.width, height: element.height }))));
        expect(sizes.reduce((total, size) => total + size.width * size.height, 0)).toBeLessThanOrEqual(4_194_304);
        for (const size of sizes) {
          expect(Math.min(size.width, size.height)).toBeGreaterThan(0);
          expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(8192);
        }
        for (const canvas of canvases) {
          const pixels = await canvas.evaluate((element: HTMLCanvasElement) => {
            const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
            let colored = 0, black = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i + 3] !== 255) continue;
              if (pixels[i] < 80 && Math.max(pixels[i + 1], pixels[i + 2]) > 100) colored++;
              if (pixels[i] < 80 && pixels[i + 1] < 80 && pixels[i + 2] < 80) black++;
            }
            return { colored, black };
          });
          expect(pixels.colored).toBeGreaterThan(1000);
          expect(pixels.black).toBeGreaterThan(100);
        }
        await expect(window.getByLabel("PDF page 1 text", { exact: true })).toContainText("UIT OFFLINE PDF PAGE 1");
        await expect(window.locator("#reader-body iframe")).toHaveCount(0);
        if (log.cycles < 2) await screenshot(mobile ? "stability-mobile-pdf" : "stability-pdf");
        await window.locator(".pdf-surface").hover();
        await window.mouse.wheel(0, 900);
        await expect(window.locator(".pdf-status")).toContainText("Page 2 of 2 rendered");
        await expect(window.locator('.pdf-page[data-page="2"] .pdf-canvas')).toBeInViewport();
        await expect(window.getByLabel("PDF page 2 text", { exact: true })).toContainText("UIT OFFLINE PDF PAGE 2");
        expect(await window.evaluate(() => (globalThis as any).__stabilityWorkers)).toMatchObject({ created: log.cycles + 1, terminated: log.cycles, live: 1, peak: 1 });
        await window.getByRole("button", { name: "Close preview" }).click();
        await expect(window.locator("#reader-body")).toBeEmpty();
        for (const canvas of canvases) expect(await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height])).toEqual([0, 0]);
      } finally { await Promise.all(canvases.map((canvas) => canvas.dispose())); }
      await expect.poll(() => window.evaluate(() => (globalThis as any).__stabilityWorkers.live)).toBe(0);
      await expect.poll(() => activeWorkers.size).toBe(0);
      expect(window.workers()).toHaveLength(0);

      await navigation();
      await window.locator('.nav-item[data-view="agent"]').click();
      await navigation();
      await window.getByRole("button", { name: `New thread in ${courses[index].shortname}`, exact: true }).click();
      await expect(window.getByLabel("Thread course")).toHaveAttribute("data-course-key", key(index));
      await window.getByLabel("Message Codex").fill(`Discard this temporary draft, cycle ${log.cycles}`);
      await navigation();
      await window.locator(".thread-link").filter({ hasText: `Offline draft ${index}` }).click();
      await expect(window.getByLabel("Thread course")).toHaveAttribute("data-course-key", key(index));
      await expect(window.getByLabel("Message Codex")).toHaveValue(drafts.get(index)!);
      drafts.set(index, `Offline unsent draft ${index}, cycle ${log.cycles}\nNo turn requested.`);
      await window.getByLabel("Message Codex").fill(drafts.get(index)!);
      await expect.poll(() => window.evaluate(({ STORE, title }) => {
        const stored = JSON.parse(localStorage.getItem(STORE) || "{}");
        return { ids: stored.threads.map((thread: { id: string }) => thread.id), draft: stored.threads.find((thread: { title: string }) => thread.title === title)?.draft };
      }, { STORE, title: `Offline draft ${index}` })).toEqual({ ids: threads.map((thread) => thread.id), draft: drafts.get(index)! });
      if (log.cycles < 2) await screenshot(mobile ? "stability-mobile-agent" : "stability-agent");
      expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await navigation();
      await window.locator("#account-button").click();
      await expect(window.getByRole("dialog", { name: "Course accounts", exact: true })).toBeVisible();
      await expect(window.locator("#session-summary .session-row")).toHaveCount(2);
      await window.getByRole("button", { name: "Close accounts" }).click();
      if (mobile) await window.locator("#close-sidebar").click();
      log.cycles++;
      if (log.cycles === 2) await sampleMemory("warm-baseline");
      expect(log.failures).toEqual([]);
    }
    log.soakDurationMs = performance.now() - soakStarted;
    await sampleMemory("after-previews");
    const baseline = log.memory.find((sample) => sample.phase === "warm-baseline")!;
    const after = log.memory.at(-1)!;
    // Allow allocator/cache warmup; catch gross sustained growth, not GC timing noise.
    for (const metric of ["mainHeapBytes", "rendererHeapBytes", "workingSetBytes"] as const) {
      expect(after[metric] - baseline[metric], `${metric} growth after warmup`).toBeLessThan(150 * 1024 * 1024);
    }
    const workers = await window.evaluate(() => (globalThis as any).__stabilityWorkers);
    expect(workers).toMatchObject({ created: log.cycles, terminated: log.cycles, live: 0, peak: 1 });
    const workerUrl = new URL("../../node_modules/pdfjs-dist/build/pdf.worker.mjs", window.url()).href;
    expect([...new Set(workers.urls)]).toEqual([workerUrl]);
    expect(log.workers.filter((event) => event.event === "created")).toHaveLength(log.cycles);
    expect(log.soakDurationMs).toBeGreaterThanOrEqual(60_000);
    expect(log.heartbeats.length).toBeGreaterThanOrEqual(15);
    await window.reload();
    await expect(window.locator(".course-row")).toHaveCount(19);
    await navigation();
    await window.locator('.nav-item[data-view="agent"]').click();
    for (const index of [0, 14]) {
      await navigation();
      await expect(window.locator("#course-nav .project")).toHaveCount(3);
      await expect(window.locator(".thread-link")).toHaveCount(2);
      await window.locator(".thread-link").filter({ hasText: `Offline draft ${index}` }).click();
      await expect(window.getByLabel("Thread course")).toHaveAttribute("data-course-key", key(index));
      await expect(window.getByLabel("Message Codex")).toHaveValue(drafts.get(index)!);
    }
    log.mainDiagnostics = await app.evaluate(() => (globalThis as any).__stability);
    const diagnostics = log.mainDiagnostics as { events: unknown[]; network: string[]; calls: { channel: string }[] };
    expect(diagnostics.events).toEqual([]);
    expect(diagnostics.network).toEqual([]);
    expect(diagnostics.calls.filter((call) => call.channel === "course:preview")).toHaveLength(log.cycles * 2);
    expect(diagnostics.calls.filter((call) => /^(agent:|workspace:|shell:|course:(materialize|open)$|session:(login|sso-login|logout)$)/.test(call.channel))).toEqual([]);
    expect(log.failures).toEqual([]);
  } finally {
    stopHeartbeat = true;
    wakeHeartbeat?.();
    await heartbeat;
    if (soakStarted !== undefined && !log.soakDurationMs) log.soakDurationMs = performance.now() - soakStarted;
    let diagnosticTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      log.mainDiagnostics = await Promise.race([
        app.evaluate(() => {
          const state = (globalThis as any).__stability;
          if (state) state.intentional = true;
          return state;
        }),
        new Promise<never>((_resolve, reject) => {
          diagnosticTimeout = setTimeout(() => reject(new Error("Main did not respond during teardown")), 3_000);
        }),
      ]);
    } catch (error) { log.failures.push(`Final diagnostics unavailable: ${error}`); }
    finally { clearTimeout(diagnosticTimeout); }
    try {
      // The only app.close call; no per-cycle windows, process restarts or hidden retries.
      intentional = true;
      log.shutdown.requested = true;
      await app.close();
      log.shutdown.completed = true;
    } finally {
      log.durationMs = performance.now() - started;
      await writeFile(info.outputPath("electron-stability.json"), JSON.stringify(log, null, 2));
      await info.attach("electron-stability.json", { body: JSON.stringify(log, null, 2), contentType: "application/json" });
    }
  }
  expect(log.shutdown).toEqual({ requested: true, completed: true });
  expect(log.lifecycle.some((event) => event.event === "process-exit" && event.intentional)).toBe(true);
  expect(log.mainDiagnostics).toMatchObject({ events: [], network: [] });
  expect(log.failures).toEqual([]);
});
