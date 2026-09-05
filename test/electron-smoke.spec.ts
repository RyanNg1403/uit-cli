import { test as base, expect } from "playwright/test";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { courses, CURRENT, LEGACY } from "./fixtures/desktop";

const mainPath = fileURLToPath(new URL("../desktop/main.cjs", import.meta.url));
const preloadPath = fileURLToPath(new URL("../desktop/preload.cjs", import.meta.url));

const test = base.extend<{ desktop: { app: ElectronApplication; page: Page; profile: string } }>({
  desktop: async ({}, use, info) => {
    expect(await readFile(mainPath, "utf8"), "Main must support hidden test windows").toContain("UIT_TEST_HEADLESS");
    const profile = info.outputPath("profile");
    await mkdir(profile, { recursive: true });
    // No inherited account variables, CLI configuration or executable Codex on PATH.
    const env: Record<string, string> = {
      HOME: profile, USERPROFILE: profile, PATH: profile,
      UIT_TEST_PROFILE: profile, UIT_DISABLE_CONFIG: "1", UIT_TEST_HEADLESS: "1",
      CODEX_HOME: join(profile, "codex"),
    };
    for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
      if (process.env[name]) env[name] = process.env[name]!;
    }
    const app = await _electron.launch({ args: [mainPath, "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND",
      "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>"], env, timeout: 20_000 });
    const errors: string[] = [];
    const messages: string[] = [];
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
    try {
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => {
        window.webContents.setBackgroundThrottling(false);
        return window.isVisible();
      }))).toEqual([false]);
      await app.evaluate(({ session }) => {
        session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
      });
      await expect(page.locator("#account-label")).toHaveText("Connect accounts");
      await use({ app, page, profile });
      expect(errors, "Uncaught errors in the real Electron renderer").toEqual([]);
    } finally {
      if (!page.isClosed()) await page.screenshot({ path: info.outputPath("electron-window.png") });
      await info.attach("electron-console", { body: messages.join("\n"), contentType: "text/plain" });
      await info.attach("electron-page-errors", { body: errors.join("\n"), contentType: "text/plain" });
      await app.close();
    }
  },
});

test("real preload reports unauthenticated status, login forms and validation without account calls", async ({ desktop }, info) => {
  const { app, page, profile } = desktop;
  expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(profile);
  expect(await page.evaluate(() => window.uit.session.status())).toMatchObject({ authenticated: false, sessions: [] });
  await expect(page.getByRole("button", { name: "Connect UIT account", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connect UIT account", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Course accounts", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with UIT SSO" })).toBeVisible();
  await expect(page.getByLabel("Student ID", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
  const portal = page.getByRole("combobox", { name: "Portal", exact: true });
  expect(await portal.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual([LEGACY, `${LEGACY}/sdh`]);
  await page.getByRole("button", { name: "Connect legacy portal" }).click();
  expect(await page.getByLabel("Student ID", { exact: true }).evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  await page.screenshot({ path: info.outputPath("electron-login.png") });

  const rejections = await page.evaluate(async ({ CURRENT, LEGACY }) => {
    const cases = [
      ["session", "login", { baseUrl: CURRENT, username: "fixture", password: "never-sent" }],
      ["session", "ssoLogin", { baseUrl: LEGACY }],
      ...["https://example.invalid", `${CURRENT}/not-root`, `${CURRENT}?token=fixture`, `${CURRENT}:8443`, `https://user:pass@courses.uit.edu.vn`, "http://courses.uit.edu.vn", `${LEGACY}/not-sdh`].map((baseUrl) => ["session", "login", { baseUrl, username: "fixture", password: "never-sent" }]),
    ];
    return Promise.all(cases.map(async ([namespace, method, input]) => {
      try { await window.uit[namespace as string][method as string](input); return "UNEXPECTED SUCCESS"; }
      catch (error) { return String(error); }
    }));
  }, { CURRENT, LEGACY });
  expect(rejections[0]).toContain("requires UIT SSO");
  expect(rejections[1]).toContain("current course site only");
  for (const error of rejections.slice(2)) expect(error).toMatch(/official UIT|root URL|HTTPS|\/sdh/);
  expect(await page.evaluate(() => window.uit.session.status())).toMatchObject({ authenticated: false, sessions: [] });
  expect(app.windows()).toHaveLength(1);
});

test("real renderer IPC requires sign-in for preview, download, workspace and agent operations", async ({ desktop }) => {
  const { page } = desktop;
  const results = await page.evaluate(async ({ CURRENT, LEGACY }) => {
    const results: { operation: string; error: string }[] = [];
    for (const baseUrl of [CURRENT, LEGACY, `${LEGACY}/sdh`]) {
      const input = { courseId: 1, baseUrl, userId: 101, fileUrl: `${baseUrl}/pluginfile.php/1/slide.pdf`, filename: "slide.pdf", taskId: "no-real-turn", message: "never sent" };
      for (const [namespace, method] of [["courses", "contents"], ["courses", "assignments"], ["courses", "announcements"], ["courses", "preview"], ["courses", "materialize"], ["courses", "open"], ["workspace", "create"], ["agent", "start"]]) {
        try { await window.uit[namespace][method](input); results.push({ operation: `${baseUrl}:${method}`, error: "UNEXPECTED SUCCESS" }); }
        catch (error) { results.push({ operation: `${baseUrl}:${method}`, error: String(error) }); }
      }
    }
    for (const method of ["list", "refresh"]) {
      try { await window.uit.courses[method](); results.push({ operation: method, error: "UNEXPECTED SUCCESS" }); }
      catch (error) { results.push({ operation: method, error: String(error) }); }
    }
    return results;
  }, { CURRENT, LEGACY });
  expect(results).toHaveLength(26);
  for (const result of results) expect(result.error, result.operation).toMatch(/Sign in|Connect a UIT course account first/);
  expect(await page.evaluate(() => window.uit.session.status())).toMatchObject({ authenticated: false, sessions: [] });
});

test("real window is sandboxed and isolated, blocks navigation/popups and rejects a foreign preload sender", async ({ desktop }) => {
  const { app, page } = desktop;
  const settings = await app.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences());
  expect(settings).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  expect(await page.evaluate(() => ({
    require: typeof (globalThis as any).require,
    process: typeof (globalThis as any).process,
    ipcRenderer: typeof (globalThis as any).ipcRenderer,
    bridgeFrozen: Object.isFrozen(window.uit),
    statusFrozen: Object.isFrozen(window.uit.session),
    genericInvoke: typeof window.uit.invoke,
  }))).toEqual({ require: "undefined", process: "undefined", ipcRenderer: "undefined", bridgeFrozen: true, statusFrozen: true, genericInvoke: "undefined" });

  const originalUrl = page.url();
  // Round-trip through the main event loop after each renderer-initiated attempt.
  for (const url of ["https://example.invalid/blocked", "data:text/html,blocked", "file:///not-the-renderer.html"]) {
    await page.evaluate((url) => { const link = document.createElement("a"); link.href = url; document.body.append(link); link.click(); link.remove(); }, url);
    await page.evaluate(() => window.uit.session.status());
    expect(page.url()).toBe(originalUrl);
  }
  expect(await page.evaluate(() => window.open("https://example.invalid/popup") === null)).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

  const rejection = await app.evaluate(async ({ BrowserWindow }, preload) => {
    const foreign = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await foreign.loadURL("data:text/html,<title>Foreign IPC sender</title>");
      return await foreign.webContents.executeJavaScript(`window.uit.session.status().then(() => "UNEXPECTED SUCCESS", error => error.message)`);
    } finally { foreign.destroy(); }
  }, preloadPath);
  expect(rejection).toContain("untrusted renderer");
  // Aborted navigations can leave Playwright's actionability navigation wait pending.
  expect(await page.evaluate(() => document.querySelector("#account-label")?.textContent)).toBe("Connect accounts");
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())).toBe(originalUrl);
});

test("real Electron PDF preview uses fixture IPC bytes, never saves or starts a turn", async ({ desktop }, info) => {
  const { app, page } = desktop;
  // Test-runner-only IPC replacement: production main/preload/renderer stay untouched.
  const { pdfFixture } = await import("./fixtures/pdf");
  const pdf = Buffer.from(pdfFixture()).toString("base64");
  const course = courses[0];
  await app.evaluate(({ ipcMain }, { course, pdf }) => {
    const calls: { channel: string; input: unknown }[] = [];
    const responses: Record<string, unknown> = {
      "session:status": { authenticated: true, sessions: [{ baseUrl: course.baseUrl, userId: course.userId, authMode: "sso" }] },
      "courses:list": [course],
      "course:contents": [{ id: 501, name: "Offline PDF fixture", section: "Week 1", files: [{ filename: "slide.pdf", fileurl: `${course.baseUrl}/pluginfile.php/1/slide.pdf`, mimetype: "application/pdf" }] }],
      "course:assignments": [], "course:announcements": [],
      "course:preview": { filename: "slide.pdf", mimeType: "application/pdf", data: pdf },
      "codex:status": { installed: false, message: "Offline fixture: no Codex process" },
    };
    for (const channel of [...Object.keys(responses), "course:materialize", "course:open", "workspace:create", "shell:open", "agent:start", "agent:send"]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, input) => {
        calls.push({ channel, input });
        if (!(channel in responses)) throw new Error(`Forbidden side effect in PDF smoke: ${channel}`);
        return responses[channel];
      });
    }
    (globalThis as any).__smokeCalls = calls;
  }, { course, pdf });
  await page.addInitScript(() => {
    (window as any).__pdfWorkers = { created: 0, terminated: 0 };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        (window as any).__pdfWorkers.created++;
      }
      terminate() { (window as any).__pdfWorkers.terminated++; super.terminate(); }
    };
  });
  await page.reload();
  await expect(page.locator(".course-row")).toHaveCount(1);
  await page.locator(".course-row").click();
  await page.locator("#contents-panel .resource-open").filter({ hasText: "slide.pdf" }).click();
  await expect(page.getByRole("dialog", { name: "slide.pdf", exact: true })).toBeVisible();
  const canvas = page.locator('.pdf-page[data-page="1"] .pdf-canvas');
  await expect(page.locator(".pdf-status")).toContainText("Page 1 of 2 rendered");
  await expect(page.locator(".pdf-page[data-page]")).toHaveCount(2);
  await expect(page.locator(".pdf-page[data-page] .pdf-canvas:not([hidden])")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Previous page|Next page/ })).toHaveCount(0);
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > 100 && pixels[i] < 80 && pixels[i + 3] === 255) colored++;
    return colored;
  })).toBeGreaterThan(1000);
  await page.getByRole("button", { name: "Show page text" }).click();
  await expect(page.getByLabel("PDF page 1 text", { exact: true })).toContainText("UIT OFFLINE PDF PAGE 1");
  await expect(page.locator("#reader-body iframe")).toHaveCount(0);
  await expect(page.locator("#reader-status")).toBeEmpty();
  await page.screenshot({ path: info.outputPath("electron-pdf-preview.png") });
  await page.locator(".pdf-surface").hover();
  await page.mouse.wheel(0, 900);
  await expect(page.locator(".pdf-status")).toContainText("Page 2 of 2 rendered");
  await expect(page.locator('.pdf-page[data-page="2"] .pdf-canvas')).toBeInViewport();
  await expect(page.getByLabel("PDF page 2 text", { exact: true })).toContainText("UIT OFFLINE PDF PAGE 2");
  expect(await page.evaluate(() => (window as any).__pdfWorkers)).toEqual({ created: 1, terminated: 0 });
  const calls = await app.evaluate(() => (globalThis as any).__smokeCalls) as { channel: string; input: unknown }[];
  expect(calls.filter((call) => call.channel === "course:preview")).toEqual([{ channel: "course:preview", input: { courseId: course.id, baseUrl: course.baseUrl, userId: course.userId, filename: "slide.pdf", fileUrl: `${course.baseUrl}/pluginfile.php/1/slide.pdf` } }]);
  expect(calls.filter((call) => ["course:materialize", "course:open", "workspace:create", "shell:open", "agent:start", "agent:send"].includes(call.channel))).toEqual([]);
  const canvases = await page.locator(".pdf-page[data-page] .pdf-canvas").elementHandles();
  try {
    expect(canvases).toHaveLength(2);
    const areas = await Promise.all(canvases.map((canvas) => canvas.evaluate((element: HTMLCanvasElement) => element.width * element.height)));
    expect(areas.every((area) => area > 0)).toBe(true);
    expect(areas.reduce((total, area) => total + area, 0)).toBeLessThanOrEqual(4_194_304);
    await page.getByRole("button", { name: "Close preview" }).click();
    await expect(page.locator("#reader-body")).toBeEmpty();
    await expect.poll(() => page.evaluate(() => (window as any).__pdfWorkers)).toEqual({ created: 1, terminated: 1 });
    for (const canvas of canvases) expect(await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height])).toEqual([0, 0]);
  } finally { await Promise.all(canvases.map((canvas) => canvas.dispose())); }
});
