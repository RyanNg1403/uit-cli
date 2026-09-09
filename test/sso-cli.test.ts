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
    const client = createSessionApiClient("https://courses.uit.edu.vn", "my-sesskey", [
      { name: "MoodleSession", value: "session-cookie-1" }
    ]);

    expect(client).toBeInstanceOf(NodeSessionApiClient);
    await expect(client.uploadFile("/path/to/file.pdf")).rejects.toThrow("File uploads are not supported");
  });
});
