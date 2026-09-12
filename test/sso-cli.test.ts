import { mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = {
  home: ""
};

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => testState.home || actual.homedir()
  };
});

import { createProgram, main } from "../src/cli.js";
import { get, getActiveConfig, resetConfigCache, save, saveSsoSession, type SsoSessionData } from "../src/config.js";
import { NodeSessionApiClient, createSessionApiClient } from "../src/api.js";
import { defaultSsoLauncher } from "../src/sso-login.js";
import { workspacePath } from "../src/desktop-service.js";
import { executeMcpTool, resolveAvailableSession } from "../src/mcp-server.js";
import type { ApiClient } from "../src/types.js";

const originalCwd = process.cwd();
let tempDir: string;
let stdout = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function mockApi(responses: Record<string, any>): ApiClient {
  return {
    call: vi.fn(async (name: string) => {
      if (!(name in responses)) throw new Error(`unexpected call: ${name}`);
      return responses[name];
    }),
    uploadFile: vi.fn(async () => ({ itemid: 99 })),
    downloadFile: vi.fn(async () => undefined)
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "uit-sso-cli-test-"));
  testState.home = tempDir;
  process.chdir(tempDir);
  resetConfigCache();
  stdout = "";
  stdoutSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    stdout += `${args.join(" ")}\n`;
  });
  stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  process.chdir(originalCwd);
  resetConfigCache();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SSO CLI workflow and session resolution", () => {
  it("saves SSO session and updates active config", () => {
    const ssoData: SsoSessionData = {
      baseUrl: "https://courses.uit.edu.vn",
      userId: 19589,
      sesskey: "sesskey-12345",
      cookies: [{ name: "MoodleSession", value: "cookie-value-abc" }],
      savedAt: Date.now()
    };

    saveSsoSession(ssoData);

    expect(get("authType")).toBe("sso");
    expect(get("userId")).toBe(19589);
    expect(get("sesskey")).toBe("sesskey-12345");
    expect(get("cookies")).toEqual([{ name: "MoodleSession", value: "cookie-value-abc" }]);
    expect(get("token")).toBe("");
    const configDir = join(tempDir, ".uit");
    expect(readdirSync(configDir)).toEqual(["sessions.json"]);
    if (process.platform !== "win32") {
      expect(statSync(join(configDir, "sessions.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("uses environment credentials consistently when they override a saved session", () => {
    saveSsoSession({
      baseUrl: "https://courses.uit.edu.vn",
      userId: 19589,
      sesskey: "saved-sesskey",
      cookies: [{ name: "MoodleSession", value: "saved-cookie" }]
    });
    process.env.UIT_TOKEN = "environment-token";
    process.env.UIT_BASE_URL = "https://coursesold.uit.edu.vn/";
    process.env.UIT_USER_ID = "42";
    try {
      expect(getActiveConfig({ fresh: true })).toMatchObject({
        authType: "token",
        baseUrl: "https://coursesold.uit.edu.vn",
        token: "environment-token",
        userId: 42
      });
    } finally {
      delete process.env.UIT_TOKEN;
      delete process.env.UIT_BASE_URL;
      delete process.env.UIT_USER_ID;
    }
  });

  it("makes an explicit token login active when an SSO session already exists", () => {
    saveSsoSession({
      baseUrl: "https://courses.uit.edu.vn",
      userId: 19589,
      sesskey: "saved-sesskey",
      cookies: [{ name: "MoodleSession", value: "saved-cookie" }]
    });
    save("replacement-token", 42, "https://courses.uit.edu.vn");

    expect(getActiveConfig({ fresh: true })).toMatchObject({
      authType: "token",
      baseUrl: "https://courses.uit.edu.vn",
      token: "replacement-token",
      userId: 42
    });
  });

  it("binds MCP authentication to the portal and account encoded by its workspace", () => {
    save("legacy-token", 77, "https://coursesold.uit.edu.vn");
    saveSsoSession({
      baseUrl: "https://courses.uit.edu.vn",
      userId: 19589,
      sesskey: "current-sesskey",
      cookies: [{ name: "MoodleSession", value: "current-cookie" }]
    });

    expect(resolveAvailableSession(workspacePath(42, "https://coursesold.uit.edu.vn", 77))).toMatchObject({
      baseUrl: "https://coursesold.uit.edu.vn",
      userId: 77
    });
    expect(resolveAvailableSession(workspacePath(42, "https://courses.uit.edu.vn", 19589))).toMatchObject({
      baseUrl: "https://courses.uit.edu.vn",
      userId: 19589
    });
  });

  it("retains workspace-matched saved sessions when an environment token is present", () => {
    saveSsoSession({
      baseUrl: "https://courses.uit.edu.vn",
      userId: 19589,
      sesskey: "saved-sesskey",
      cookies: [{ name: "MoodleSession", value: "saved-cookie" }]
    });
    process.env.UIT_TOKEN = "environment-token";
    process.env.UIT_BASE_URL = "https://coursesold.uit.edu.vn";
    process.env.UIT_USER_ID = "42";
    try {
      expect(resolveAvailableSession(workspacePath(7, "https://courses.uit.edu.vn", 19589))).toMatchObject({
        baseUrl: "https://courses.uit.edu.vn",
        userId: 19589
      });
    } finally {
      delete process.env.UIT_TOKEN;
      delete process.env.UIT_BASE_URL;
      delete process.env.UIT_USER_ID;
    }
  });

  it("rejects cross-course MCP calls even for the same portal and account", async () => {
    save("legacy-token", 77, "https://coursesold.uit.edu.vn");
    const workspace = workspacePath(42, "https://coursesold.uit.edu.vn", 77);

    await expect(executeMcpTool("uit_course_contents", { courseId: 43 }, workspace)).rejects.toThrow(
      "scoped to course 42"
    );
  });

  it("does not load the removed .env credential format", () => {
    const configDir = join(tempDir, ".uit");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, ".env"), 'UIT_TOKEN="old-token"\nUIT_USER_ID=42\n', "utf8");

    expect(() => getActiveConfig({ fresh: true })).toThrow("No active UIT session found");
  });

  it("handles uit login --sso with mock launcher", async () => {
    const mockLauncher = vi.fn(async (baseUrl: string) => ({
      baseUrl,
      userId: 2026,
      sesskey: "sso-sess-key",
      cookies: [{ name: "MoodleSession", value: "ms-session-val" }]
    }));

    const program = createProgram(mockApi({}), { ssoLauncher: mockLauncher });
    await program.parseAsync(["node", "uit", "--json", "login", "--sso"]);

    expect(mockLauncher).toHaveBeenCalledWith("https://courses.uit.edu.vn");
    expect(JSON.parse(stdout)).toEqual({
      status: "ok",
      auth: "sso",
      user_id: 2026,
      site: "https://courses.uit.edu.vn"
    });

    const saved = JSON.parse(readFileSync(join(tempDir, ".uit", "sessions.json"), "utf8"));
    expect(saved.sso.userId).toBe(2026);
    expect(saved.sso.sesskey).toBe("sso-sess-key");
  });

  it("uses SSO when uit login has no authentication flag", async () => {
    const mockLauncher = vi.fn(async (baseUrl: string) => ({
      baseUrl,
      userId: 2027,
      sesskey: "default-sso-sess-key",
      cookies: [{ name: "MoodleSession", value: "default-sso-cookie" }]
    }));

    const program = createProgram(mockApi({}), { ssoLauncher: mockLauncher });
    await program.parseAsync(["node", "uit", "--json", "login"]);

    expect(mockLauncher).toHaveBeenCalledWith("https://courses.uit.edu.vn");
    expect(JSON.parse(stdout)).toMatchObject({ status: "ok", auth: "sso", user_id: 2027 });
  });

  it("restores uit login --legacy and persists the token from Student ID/password", async () => {
    const mockLauncher = vi.fn(async () => {
      throw new Error("SSO must not run for legacy login");
    });
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://coursesold.uit.edu.vn/login/token.php") {
        expect(init?.method).toBe("POST");
        expect((init?.body as URLSearchParams).get("username")).toBe("2026");
        expect((init?.body as URLSearchParams).get("password")).toBe("legacy-password");
        return Response.json({ token: "legacy-token-2026" });
      }

      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://coursesold.uit.edu.vn");
      expect(parsed.pathname).toBe("/webservice/rest/server.php");
      expect(parsed.searchParams.get("wstoken")).toBe("legacy-token-2026");
      return Response.json({ userid: 2026, fullname: "Legacy Student", sitename: "Legacy Moodle" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const program = createProgram(mockApi({}), { ssoLauncher: mockLauncher });
    await program.parseAsync([
      "node",
      "uit",
      "--json",
      "login",
      "--legacy",
      "--username",
      "2026",
      "--password",
      "legacy-password"
    ]);

    expect(mockLauncher).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(stdout)).toEqual({
      status: "ok",
      user: "Legacy Student",
      user_id: 2026,
      site: "Legacy Moodle"
    });
    expect(JSON.parse(readFileSync(join(tempDir, ".uit", "sessions.json"), "utf8"))).toMatchObject({
      legacy: [{ baseUrl: "https://coursesold.uit.edu.vn", userId: 2026, token: "legacy-token-2026" }],
      active: { authType: "token", baseUrl: "https://coursesold.uit.edu.vn" }
    });
  });

  it("rejects contradictory SSO and legacy login flags", async () => {
    const launcher = vi.fn();
    const program = createProgram(mockApi({}), { ssoLauncher: launcher });

    await expect(program.parseAsync(["node", "uit", "login", "--sso", "--legacy"])).rejects.toThrow(
      "Choose one login method: --sso or --legacy."
    );
    expect(launcher).not.toHaveBeenCalled();
  });

  it("triggers SSO login when running uit init --sso", async () => {
    const mockLauncher = vi.fn(async (baseUrl: string) => ({
      baseUrl,
      userId: 5555,
      sesskey: "init-sess-key",
      cookies: [{ name: "MoodleSession", value: "cookie-5555" }]
    }));

    const program = createProgram(mockApi({}), { ssoLauncher: mockLauncher });
    await program.parseAsync(["node", "uit", "--json", "init", "--sso"]);

    expect(mockLauncher).toHaveBeenCalled();
    expect(JSON.parse(stdout)).toEqual({
      status: "ok",
      auth: "sso",
      user_id: 5555,
      site: "https://courses.uit.edu.vn"
    });
  });

  it("falls back to SSO session when .env is absent and executes courses", async () => {
    const ssoData: SsoSessionData = {
      baseUrl: "https://courses.uit.edu.vn",
      userId: 3333,
      sesskey: "sso-3333",
      cookies: [{ name: "MoodleSession", value: "val-3333" }]
    };
    saveSsoSession(ssoData);

    const api = mockApi({
      core_enrol_get_users_courses: [
        { id: 404, shortname: "SE362", fullname: "Software Security", category: 10 }
      ]
    });

    const code = await main(["node", "uit", "--json", "courses"], api);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      { id: 404, short: "SE362", name: "Software Security" }
    ]);
    expect(api.call).toHaveBeenCalledWith("core_enrol_get_users_courses", { userid: 3333 });
  });

  it("NodeSessionApiClient executes calls with Cookie header and handles uploads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 456, file: "package.json", url: "https://courses.uit.edu.vn/draftfile.php/1/package.json" })
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = createSessionApiClient("https://courses.uit.edu.vn", "my-sesskey", [
        { name: "MoodleSession", value: "session-cookie-1" }
      ]);

      expect(client).toBeInstanceOf(NodeSessionApiClient);
      const testFilePath = join(tempDir, "test.txt");
      writeFileSync(testFilePath, "test content");
      const result = await client.uploadFile(testFilePath);
      expect(result.itemid).toBe(456);
      expect(result.filename).toBe("package.json");
      expect(fetchMock).toHaveBeenCalled();
      const [calledUrl, calledInit] = fetchMock.mock.calls[0];
      expect(calledUrl).toContain("/repository/repository_ajax.php?action=upload");
      expect(calledInit.headers.Cookie).toBe("MoodleSession=session-cookie-1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to edge or chromium when chrome is missing in defaultSsoLauncher", async () => {
    const launchCalls: any[] = [];
    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://courses.uit.edu.vn/my/"),
      evaluate: vi.fn().mockResolvedValue({ sesskey: "sso-key", userId: 99 }),
      isClosed: vi.fn().mockReturnValue(false)
    };
    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      cookies: vi.fn().mockResolvedValue([{ name: "MoodleSession", value: "val", domain: "courses.uit.edu.vn", path: "/" }])
    };
    const mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      isConnected: vi.fn().mockReturnValue(true),
      close: vi.fn().mockResolvedValue(undefined)
    };

    const chromiumMock = await import("playwright").then((m) => m.chromium);
    const launchSpy = vi.spyOn(chromiumMock, "launch").mockImplementation(async (opts: any) => {
      launchCalls.push(opts);
      if (opts?.channel === "chrome") throw new Error("Chrome not found");
      return mockBrowser as any;
    });

    try {
      const session = await defaultSsoLauncher("https://courses.uit.edu.vn");
      expect(session.userId).toBe(99);
      expect(session.sesskey).toBe("sso-key");
      expect(launchCalls[0]).toMatchObject({ channel: "chrome" });
      expect(launchCalls[1]).toMatchObject({ channel: "msedge" });
    } finally {
      launchSpy.mockRestore();
    }
  });
});
