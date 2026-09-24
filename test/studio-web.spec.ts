import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "playwright/test";
import { courses, fileTypes } from "./fixtures/studio";
import { startStudioWebServer, type StudioWebServer } from "../src/studio-web-server.js";

const currentSessions = [
  { baseUrl: "https://courses.uit.edu.vn", userId: 101, authMode: "sso", label: "Current Moodle", health: { state: "connected", checkedAt: Date.now() } },
  { baseUrl: "https://coursesold.uit.edu.vn", userId: 202, authMode: "session", label: "Legacy Moodle", health: { state: "connected", checkedAt: Date.now() } }
];

type WebTrace = { leases: any[]; agents: any[] };

function fakeCore(trace: WebTrace) {
  const status = () => ({
    authenticated: true,
    authMode: "multi",
    sessions: currentSessions,
    portalErrors: [],
    courseDiscovery: []
  });
  return {
    handlers: () => ({
      "session:status": status,
      "session:login": status,
      "session:sso-login": status,
      "session:logout": status,
      "notifications:counts": () => [1, 0],
      "notifications:list": () => ({ items: [{ id: 1, subject: "Moodle notification", text: "A course update", read: false, timecreated: 1788940558 }], unread: 1, nextOffset: null }),
      "inbox:list": () => ({ items: [], nextOffset: null }),
      "courses:list": () => courses,
      "courses:link": (input: any) => input,
      "courses:refresh": () => courses,
      "course:contents": (input: any) => {
        const files = fileTypes.map((file, index) => ({
          filename: file.filename,
          mimetype: file.mimetype,
          fileurl: `${input.baseUrl}/pluginfile.php/${input.courseId}/${index}/${file.filename}`
        }));
        return [
          { id: 501, name: "Week 1 materials", section: "Week 1", description: "Read the module introduction", files: files.slice(0, 4) },
          { id: 502, name: "Week 2 materials", section: "Week 2", description: "Second module introduction", files: files.slice(4) },
          { id: 503, name: "Class announcements", section: "Week 2", modname: "forum", description: "", files: [] }
        ];
      },
      "course:assignments": () => [],
      "course:announcements": () => [],
      "course:participants": () => [],
      "course:grades": () => [],
      "course:submission": () => ({ files: [] }),
      "course:forum": () => [],
      "course:materialize": (input: any) => `/fixture/${input.filename}`,
      "course:preview": (input: any) => ({ mimeType: "text/plain", filename: input.filename, data: btoa("fixture preview") }),
      "course:open": () => undefined,
      "threads:read": () => null,
      "threads:write": () => ({ success: true }),
      "studio:lease": (input: any) => { trace.leases.push(input); return { success: true, leaseMs: 5_000 }; },
      "workspace:create": (input: any) => ({ path: `/fixture/${input.courseId}` }),
      "codex:status": () => ({ state: "ready", installed: true, message: "Codex App Server is ready" }),
      "codex:models": () => [],
      "agent:start": (input: any) => { trace.agents.push({ method: "start", input }); return { threadId: `thread-${input.taskId}`, turnId: `turn-${input.taskId}`, workspace: `/fixture/${input.shortname}` }; },
      "agent:send": (input: any) => { trace.agents.push({ method: "send", input }); return { threadId: input.threadId, turnId: `turn-${input.threadId}`, workspace: input.cwd }; },
      "agent:fork": (input: any) => ({ id: `branch-${input.threadId}` }),
      "agent:delete": () => ({ success: true }),
      "agent:rename": () => ({ success: true }),
      "agent:stop": () => undefined,
      "agent:approve": () => undefined,
      "agent:disconnect": () => undefined,
      "thread:release-lock": () => ({ success: true }),
      "thread:lock-status": () => ({ locked: false }),
      "thread:reconcile": () => ({ missingThreadIds: [] }),
      "thread:open-desktop": () => ({ success: true }),
      "thread:read-rollout": () => ({ mtime: 0, messages: [] }),
      "clipboard:write": () => ({ success: true }),
      "shell:open": () => "",
      "shell:open-external": () => undefined
    }),
    shutdown: async () => undefined
  };
}

async function startFixtureServer(trace: WebTrace = { leases: [], agents: [] }): Promise<{ server: StudioWebServer; directory: string; trace: WebTrace }> {
  const directory = await mkdtemp(join(tmpdir(), "uit-studio-web-browser-"));
  const server = await startStudioWebServer({
    staticRoot: resolve("studio/renderer"),
    controlFile: join(directory, "server.json"),
    userDataPath: join(directory, "profile"),
    createCore: async (_host) => fakeCore(trace)
  });
  return { server, directory, trace };
}

test("opens the current Studio renderer through the authenticated web bridge", async ({ page }) => {
  const { server, directory } = await startFixtureServer();
  try {
    const eventStream = page.waitForResponse((response) => response.url().endsWith("/api/events") && response.request().method() === "GET");
    await page.goto(server.launchUrl());
    expect((await eventStream).status()).toBe(200);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "assets/uit-dau-dau.svg");
    await expect(page.locator("#account-label")).toHaveText("Course accounts (2)");
    await expect(page.locator(".course-row")).toHaveCount(19);

    await page.locator('.nav-item[data-view="courses"]').click();
    await page.locator("#course-nav").getByRole("button", { name: courses[0].shortname, exact: true }).click();
    await expect(page.locator("#course-detail h1")).toHaveText(courses[0].fullname);
    await expect(page.locator('#contents-panel [data-resource-kind="file"]')).toHaveCount(fileTypes.length);

    const hash = await page.evaluate(() => window.location.hash);
    expect(hash).toBe("");
  } finally {
    await page.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Notifications and Inbox load through the authenticated web bridge", async ({ page }) => {
  const { server, directory } = await startFixtureServer();
  try {
    await page.goto(server.launchUrl());
    await expect(page.locator("#account-label")).toHaveText("Course accounts (2)");
    await page.locator('[data-view="notifications"]').click();
    await expect(page.locator(".mail-notification")).toHaveCount(1);
    await expect(page.locator("#mail-list")).toContainText("Moodle notification");
    await page.locator("#mail-inbox").click();
    await expect(page.locator("#mail-list")).toContainText("No conversations");
    await expect(page.locator("#mail-error")).toBeHidden();
  } finally {
    await page.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("leases the Studio page and releases its active-turn ownership on pagehide", async ({ page }) => {
  const { server, directory, trace } = await startFixtureServer();
  try {
    await page.goto(server.launchUrl());
    await expect.poll(() => trace.leases.some((lease) => lease.state === "acquire")).toBe(true);
    await page.evaluate(() => window.uit.agent.start({ taskId: "task-1", message: "work", shortname: "CS01" }));
    expect(trace.agents[0]?.input.studioClientId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect.poll(() => trace.leases.at(-1)?.state).toBe("release");
  } finally {
    await page.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconnects the event stream and preserves buffered and live events", async ({ page }) => {
  const { server, directory } = await startFixtureServer();
  let eventAttempts = 0;
  await page.route("**/api/events", async (route) => {
    eventAttempts += 1;
    if (eventAttempts === 1) {
      // Return a valid SSE response whose connection closes after the initial
      // comment. This exercises browser-managed reconnect behavior after the
      // stream has opened, rather than a pre-response request failure.
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
        body: ": connected\n\n"
      });
      return;
    }
    await route.continue();
  });
  try {
    let eventResponses = 0;
    const reconnectResponse = page.waitForResponse((response) => response.url().endsWith("/api/events") && response.status() === 200 && ++eventResponses === 2);
    await page.goto(server.launchUrl());
    await expect(page.locator("#account-label")).toHaveText("Course accounts (2)");
    await page.evaluate(() => {
      (window as any).__sseProbe = [];
      (window as any).__removeSseProbe = window.uit.agent.onEvent((message: unknown) => (window as any).__sseProbe.push(message));
    });

    const buffered = { method: "test/reconnect", params: { sequence: 1 } };
    server.publish(buffered);
    await reconnectResponse;
    await expect.poll(() => page.evaluate(() => (window as any).__sseProbe)).toEqual([buffered]);

    const live = { method: "test/reconnect", params: { sequence: 2 } };
    server.publish(live);
    await expect.poll(() => page.evaluate(() => (window as any).__sseProbe)).toEqual([buffered, live]);
    expect(eventAttempts).toBe(2);
  } finally {
    await page.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
