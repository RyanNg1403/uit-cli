import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import { requestMobileToken } from "../src/commands.js";
import { clean, extractUrls, htmlToText, idOrUrl, parseMoodleUrl, sanitize, ts } from "../src/output.js";
import { parseEnv } from "../src/config.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("output helpers", () => {
  it("parses integer IDs and Moodle URLs", () => {
    expect(idOrUrl("428837")).toBe(428837);
    expect(parseMoodleUrl("https://courses.uit.edu.vn/mod/assign/view.php?id=428837")).toBe(428837);
    expect(parseMoodleUrl("https://courses.uit.edu.vn/mod/forum/discuss.php?d=77900")).toBe(77900);
    expect(() => idOrUrl("not-an-id")).toThrow("expected an integer ID or Moodle URL");
  });

  it("converts Moodle HTML to readable text and extracts URLs", () => {
    const html = '<p>Intro &amp; notes</p><ul><li>Read <a href="https://example.com">this</a></li></ul>';
    expect(clean("A &amp; B")).toBe("A & B");
    expect(htmlToText(html)).toBe("Intro & notes\n  - Read this");
    expect(extractUrls(html)).toEqual(["https://example.com"]);
  });

  it("formats timestamps and sanitizes file path segments", () => {
    expect(ts(0)).toBe("");
    expect(ts(1_700_000_000)).toMatch(/^2023-11-1[45] /);
    expect(sanitize("Week/1: Intro?.pdf")).toBe("Week_1_ Intro_.pdf");
  });
});

describe("config helpers", () => {
  it("parses the supported .env shape", () => {
    expect(
      parseEnv(`
        # comment
        UIT_TOKEN="abc"
        UIT_BASE_URL='https://courses.uit.edu.vn'
        UIT_USER_ID=123
      `)
    ).toEqual({
      UIT_TOKEN: "abc",
      UIT_BASE_URL: "https://courses.uit.edu.vn",
      UIT_USER_ID: "123"
    });
  });
});

describe("Moodle token request", () => {
  it("requests a mobile web-service token with form data", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body as URLSearchParams;
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
      expect(body.get("username")).toBe("student");
      expect(body.get("password")).toBe("secret");
      expect(body.get("service")).toBe("moodle_mobile_app");
      return Response.json({ token: "mobile-token" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestMobileToken("https://courses.uit.edu.vn", "student", "secret")).resolves.toBe("mobile-token");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://courses.uit.edu.vn/login/token.php",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("surfaces Moodle login errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Invalid login" })));

    await expect(requestMobileToken("https://courses.uit.edu.vn", "student", "wrong")).rejects.toThrow("Invalid login");
  });
});
