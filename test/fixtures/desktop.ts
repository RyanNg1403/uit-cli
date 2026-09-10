import { test as base, expect, type Page } from "playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pdfFixture } from "./pdf";

export const CURRENT = "https://courses.uit.edu.vn";
export const LEGACY = "https://coursesold.uit.edu.vn";
export const STORE = "uit-studio.threads.v1";
export const semesters = [
  { id: "2026-2", label: "2026 / Semester 2", sortOrder: 20262, source: "category" },
  { id: "2026-1", label: "2026 / Semester 1", sortOrder: 20261, source: "category" },
  { id: "2025-2", label: "2025 / Semester 2", sortOrder: 20252, source: "category" },
];
export const courses = Array.from({ length: 19 }, (_, index) => ({
  id: index === 14 ? 1 : index + 1,
  baseUrl: index >= 14 ? LEGACY : CURRENT,
  userId: index >= 14 ? 202 : 101,
  shortname: index === 14 ? "LEGACY-CS01" : `CS${String(index + 1).padStart(2, "0")}`,
  fullname: index === 14 ? "Legacy algorithms" : `Computer science ${index + 1}`,
  summary: `Course description ${index + 1}`,
  semester: index < 15 ? semesters[0] : index < 17 ? semesters[1] : index === 17 ? semesters[2] : undefined,
}));
export const fileTypes = [
  { filename: "lecture.txt", mimetype: "text/plain", text: "Lecture content in memory" },
  { filename: "notes.html", mimetype: "text/html", text: '<script>window.previewExecuted=true</script><h1>Untrusted HTML</h1>' },
  { filename: "data.json", mimetype: "application/json", text: '{"lesson":42}' },
  { filename: "diagram.svg", mimetype: "image/svg+xml", text: '<svg onload="window.previewExecuted=true" />' },
  { filename: "archive.zip", mimetype: "application/zip", text: "not executable" },
  { filename: "slide.pdf", mimetype: "application/pdf", text: pdfFixture() },
  { filename: "pixel.png", mimetype: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=" },
  { filename: "fake.pdf", mimetype: "application/pdf", text: "<html>Not a PDF</html>" },
  { filename: "script.py", mimetype: "text/x-python", text: "print('hello from memory')" },
  { filename: "readme.md", mimetype: "text/markdown", text: "# Lesson notes in memory" },
  { filename: "essay.docx", mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text: "Docx content in memory" },
];
const sessions = [
  { baseUrl: CURRENT, userId: 101, authMode: "sso", label: "Current Moodle" },
  { baseUrl: LEGACY, userId: 202, authMode: "token", label: "Legacy Moodle" },
];

type BootOptions = { authenticated?: boolean; storage?: string; fail?: Record<string, string> };
type Call = { method: string; input: any };
declare global {
  interface Window { __mock: any; uit: any; previewExecuted?: boolean }
}

// Serialized by addInitScript: keep every browser-side dependency inside this function.
function installBridge(seed: { courses: typeof courses; files: typeof fileTypes; sessions: typeof sessions; options: BootOptions }) {
  const calls: Call[] = [];
  const listeners: ((event: any) => void)[] = [];
  const held = new Set<string>();
  const pending: { method: string; input: any; resolve: (value: any) => void }[] = [];
  const failures = { ...seed.options.fail };
  let connected = JSON.parse(sessionStorage.getItem("mock.sessions") || "null") || (seed.options.authenticated === false ? [] : seed.sessions);
  if (seed.options.storage !== undefined && !sessionStorage.getItem("mock.seeded")) {
    localStorage.setItem("uit-studio.threads.v1", seed.options.storage);
    sessionStorage.setItem("mock.seeded", "true");
  }
  const status = () => ({ authenticated: connected.length > 0, sessions: connected });
  const emit = (event: any) => listeners.forEach((listener) => listener(event));
  const invoke = async (method: string, input?: any): Promise<any> => {
    calls.push({ method, input: input === undefined ? null : structuredClone(input) });
    if (held.has(method)) await new Promise((resolve) => pending.push({ method, input, resolve }));
    if (failures[method]) { const message = failures[method]; delete failures[method]; throw new Error(message); }
    const save = () => { sessionStorage.setItem("mock.sessions", JSON.stringify(connected)); return status(); };
    if (method === "session.status") return status();
    if (method === "session.logout") { connected = input?.baseUrl ? connected.filter((s: any) => s.baseUrl !== input.baseUrl) : []; return save(); }
    if (method === "session.ssoLogin" || method === "session.login") {
      const userId = method === "session.ssoLogin" ? 101 : Number(input.username);
      connected = connected.filter((s: any) => s.baseUrl !== input.baseUrl);
      connected.push({ baseUrl: input.baseUrl, userId, authMode: method === "session.ssoLogin" ? "sso" : "token" });
      return save();
    }
    if (method === "codex.status") return { installed: true, version: "fixture (offline)" };
    if (method === "codex.models") return [{ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Fixture workhorse", efforts: ["low", "high"] }];
    if (method === "courses.list" || method === "courses.refresh") {
      return [...seed.courses, { ...seed.courses[14], userId: 303, shortname: "OTHER-ACCOUNT", fullname: "Other account algorithms" }];
    }
    const files = seed.files.map((file, index) => ({ ...file, fileurl: `${input?.baseUrl}/pluginfile.php/${input?.courseId}/${index}/${file.filename}` }));
    if (method === "courses.contents") return [
      { id: 501, name: "Week 1 materials", section: "Week 1", description: "Read the module introduction", files: files.slice(0, 4) },
      { id: 502, name: "Week 2 materials", section: "Week 2", description: "Second module introduction", files: files.slice(4) },
      { id: 503, name: "Class announcements", section: "Week 2", modname: "forum", description: "", files: [] },
    ];
    if (method === "courses.assignments") return Array.from({ length: 7 }, (_, i) => ({ id: 601 + i, moduleId: 701 + i, name: `Assignment ${i + 1}`, description: `Full assignment ${i + 1}: solve all exercises. <script>unsafe()</script>`, dueDate: i ? 1800000000 + i * 86400 : undefined }));
    if (method === "courses.announcements") return Array.from({ length: 6 }, (_, i) => ({ id: 801 + i, moduleId: 503, subject: `Announcement ${i + 1}`, message: `Full announcement ${i + 1}: classroom schedule and reading.`, author: `Lecturer ${i + 1}`, timestamp: 1780000000 + i * 86400 }));
    if (method === "courses.participants") return [
      { id: 101, fullname: "Alice Student", roles: ["student"], email: "alice@uit.edu.vn" },
      { id: 102, fullname: "Dr. Bob", roles: ["editingteacher"], email: "bob@uit.edu.vn" }
    ];
    if (method === "courses.grades") return [
      { item: "Course total", grade: "9.5", max: "10", percentage: "95 %", feedback: "Well done!" },
      { item: "Lab 1", grade: "10", max: "10", percentage: "100 %" }
    ];
    if (method === "courses.preview") {
      const file = seed.files.find((file) => file.filename === input.filename)!;
      // The real backend converts Word documents to plain text before preview.
      const mimeType = file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ? "text/plain" : file.mimetype;
      return { mimeType, filename: file.filename, data: file.data || btoa(file.text || "") };
    }
    if (method === "courses.submission") return { assignId: input.assignId, moduleId: input.moduleId, status: "Submitted for grading", grade: "9.0", files: [] };
    if (method === "courses.forum") return [];
    if (method === "courses.materialize") return `/fixture/downloads/${input.filename}`;
    if (method === "courses.open" || method === "agent.approve" || method === "agent.delete" || method === "agent.disconnect") return;
    if (method === "agent.start" || method === "agent.send") return { threadId: input.threadId || `thread-${input.taskId}`, turnId: `turn-${input.taskId}`, workspace: `/fixture/UIT/${input.shortname}` };
    if (method === "agent.fork") return { id: `branch-${input.threadId}` };
    if (method === "agent.stop") { emit({ method: "turn/completed", params: { threadId: input.threadId, turn: { id: input.turnId, status: "interrupted" } } }); return; }
    if (method === "agent.releaseLock" || method === "agent.openDesktop" || method === "agent.writeClipboard") return { success: true };
    if (method === "agent.lockStatus") return { locked: false };
    if (method === "agent.readRollout") return { mtime: 0, messages: [] };
    throw new Error(`Unexpected bridge call: ${method}`);
  };
  window.__mock = {
    calls, emit, pending,
    hold: (method: string) => held.add(method),
    fail: (method: string, message: string) => { failures[method] = message; },
    release: (method: string, index = 0) => {
      const item = pending.filter((item) => item.method === method)[index];
      if (!item) throw new Error(`No pending ${method} at ${index}`);
      pending.splice(pending.indexOf(item), 1); item.resolve(undefined);
    },
    unhold: (method: string) => held.delete(method),
  };
  window.uit = Object.fromEntries(Object.entries({
    session: ["status", "login", "ssoLogin", "logout"],
    courses: ["list", "refresh", "contents", "assignments", "announcements", "participants", "grades", "submission", "forum", "preview", "materialize", "open"],
    codex: ["status", "models"], agent: ["start", "send", "fork", "delete", "stop", "approve", "disconnect", "releaseLock", "lockStatus", "openDesktop", "readRollout", "writeClipboard"],
    workspace: ["create"], shell: ["open"],
  }).map(([namespace, methods]) => [namespace, Object.fromEntries(methods.map((method) => [method, (input: any) => invoke(`${namespace}.${method}`, input)]))]));
  window.uit.agent.onEvent = (listener: (event: any) => void) => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); };
}

export const test = base.extend<{ boot: (options?: BootOptions) => Promise<void>; diagnostics: void }, { rendererURL: string }>({
  rendererURL: [async ({}, use) => {
    const root = new URL("../../desktop/renderer/", import.meta.url);
    const assets: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/renderer.js": "renderer.js", "/sidebar.js": "sidebar.js", "/appearance.js": "appearance.js", "/styles.css": "styles.css", "/chevron.svg": "chevron.svg", "/pdf-preview.js": "pdf-preview.js", "/assets/uit-logo.png": "assets/uit-logo.png", "/assets/uit-dau-dau.svg": "assets/uit-dau-dau.svg" };
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url!, "http://localhost").pathname;
      if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
      const localPdfAsset = /^\/node_modules\/pdfjs-dist\/(?:build\/pdf(?:\.worker)?\.mjs|standard_fonts\/[\w.-]+|cmaps\/[\w.-]+)$/.test(pathname);
      const file = localPdfAsset ? `../..${pathname}` : assets[pathname];
      if (!file) { response.writeHead(404).end(); return; }
      try {
        response.setHeader("Content-Type", /\.m?js$/.test(file) ? "text/javascript" : file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".css") ? "text/css" : localPdfAsset ? "application/octet-stream" : "text/html");
        response.end(await readFile(fileURLToPath(new URL(file, root))));
      } catch { response.writeHead(500).end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try { await use(`http://127.0.0.1:${address.port}`); }
    finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  }, { scope: "worker" }],
  diagnostics: [async ({ page }, use, testInfo) => {
    const consoleMessages: string[] = [];
    const errors: string[] = [];
    page.on("console", (message) => { consoleMessages.push(`${message.type()}: ${message.text()}`); if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1" || url.protocol === "blob:") return route.continue();
      errors.push(`Unexpected external request: ${url.href}`);
      return route.abort();
    });
    await use();
    await testInfo.attach("browser-console", { body: consoleMessages.join("\n"), contentType: "text/plain" });
    await testInfo.attach("page-errors", { body: errors.join("\n"), contentType: "text/plain" });
    expect(errors, "Unexpected renderer errors or external requests").toEqual([]);
  }, { auto: true }],
  boot: async ({ page, rendererURL }, use) => {
    await use(async (options = {}) => {
      await page.addInitScript(installBridge, { courses, files: fileTypes, sessions, options });
      await page.goto(rendererURL);
      await expect(page.locator("#account-label")).toHaveText(options.authenticated === false ? "Connect accounts" : "Course accounts (2)");
      if (options.authenticated !== false && !options.fail?.["courses.list"]) await expect(page.locator(".course-row")).toHaveCount(19);
    });
  },
});
export { expect };
export const key = (index: number) => JSON.stringify([courses[index].baseUrl, String(courses[index].userId), courses[index].id]);
export async function calls(page: Page, method: string): Promise<Call[]> {
  return page.evaluate((method) => window.__mock.calls.filter((call: Call) => call.method === method), method);
}
export async function control(page: Page, action: "hold" | "unhold" | "release" | "fail", method: string, value?: string | number) {
  await page.evaluate(({ action, method, value }) => window.__mock[action](method, value), { action, method, value });
}
export async function emit(page: Page, method: string, params: any) {
  await page.evaluate(({ method, params }) => window.__mock.emit({ method, params }), { method, params });
}
export async function openCourse(page: Page, index = 0) {
  await page.locator('.nav-item[data-view="courses"]').click();
  await page.locator("#course-nav").getByRole("button", { name: courses[index].shortname, exact: true }).click();
  await expect(page.locator("#course-detail h1")).toHaveText(courses[index].fullname);
  await expect(page.locator('#contents-panel [data-resource-kind="file"]')).toHaveCount(fileTypes.length);
}
