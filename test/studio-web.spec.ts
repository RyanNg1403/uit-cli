import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "playwright/test";
import { courses, fileTypes } from "./fixtures/desktop";
import { startStudioWebServer, type StudioWebServer } from "../src/studio-web-server.js";

const currentSessions = [
  { baseUrl: "https://courses.uit.edu.vn", userId: 101, authMode: "sso", label: "Current Moodle" },
  { baseUrl: "https://coursesold.uit.edu.vn", userId: 202, authMode: "token", label: "Legacy Moodle" }
];

function fakeCore() {
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
      "workspace:create": (input: any) => ({ path: `/fixture/${input.courseId}` }),
      "codex:status": () => ({ state: "ready", installed: true, message: "Codex App Server is ready" }),
      "codex:models": () => [],
      "agent:start": (input: any) => ({ threadId: `thread-${input.taskId}`, turnId: `turn-${input.taskId}`, workspace: `/fixture/${input.shortname}` }),
      "agent:send": (input: any) => ({ threadId: input.threadId, turnId: `turn-${input.threadId}`, workspace: input.cwd }),
      "agent:fork": (input: any) => ({ id: `branch-${input.threadId}` }),
      "agent:delete": () => ({ success: true }),
      "agent:rename": () => ({ success: true }),
      "agent:stop": () => undefined,
      "agent:approve": () => undefined,
      "agent:disconnect": () => undefined,
      "thread:release-lock": () => ({ success: true }),
      "thread:lock-status": () => ({ locked: false }),
      "thread:open-desktop": () => ({ success: true }),
      "thread:read-rollout": () => ({ mtime: 0, messages: [] }),
      "clipboard:write": () => ({ success: true }),
      "shell:open": () => "",
      "shell:open-external": () => undefined
    }),
    shutdown: async () => undefined
  };
}

async function startFixtureServer(): Promise<{ server: StudioWebServer; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "uit-studio-web-browser-"));
  const server = await startStudioWebServer({
    staticRoot: resolve("desktop/renderer"),
    controlFile: join(directory, "server.json"),
    userDataPath: join(directory, "profile"),
    createCore: async (_host) => fakeCore()
  });
  return { server, directory };
}

test("opens the current Studio renderer through the authenticated web bridge", async ({ page }) => {
  const { server, directory } = await startFixtureServer();
  try {
    await page.goto(server.launchUrl());
    await expect(page.locator("#account-label")).toHaveText("Course accounts (2)");
    await expect(page.locator(".course-row")).toHaveCount(19);

    await page.locator('.nav-item[data-view="courses"]').click();
    await page.locator("#course-nav").getByRole("button", { name: courses[0].shortname, exact: true }).click();
    await expect(page.locator("#course-detail h1")).toHaveText(courses[0].fullname);
    await expect(page.locator('#contents-panel [data-resource-kind="file"]')).toHaveCount(fileTypes.length);

    const hash = await page.evaluate(() => window.location.hash);
    expect(hash).toBe("");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
