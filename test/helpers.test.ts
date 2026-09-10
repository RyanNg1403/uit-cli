import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import { courseDownloadPath, requestMobileToken } from "../src/commands.js";
import { clean, extractUrls, htmlToText, idOrUrl, parseMoodleUrl, sanitize, ts } from "../src/output.js";
import { extractH5pPackage, parseZip } from "../src/unzip.js";
import { makeZip } from "./zip-fixture.js";

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

describe("course download paths", () => {
  it("keeps nested Moodle files inside the selected download directory", () => {
    const root = join(tmpdir(), "uit-download-root");
    expect(courseDownloadPath(root, "/slides/week 1/", "intro?.pdf")).toBe(
      join(root, "slides", "week 1", "intro_.pdf")
    );
  });

  it("neutralizes absolute paths, traversal segments, and Windows separators", () => {
    const root = join(tmpdir(), "uit-download-root");
    const destination = courseDownloadPath(root, "../../outside\\nested", "../secret.txt");
    expect(destination).toBe(join(root, "outside", "nested", "secret.txt"));
    expect(destination.startsWith(`${root}${sep}`)).toBe(true);
  });

  it("rejects filenames that contain no usable name", () => {
    expect(() => courseDownloadPath(join(tmpdir(), "uit-download-root"), "/", "..")).toThrow(
      "invalid filename"
    );
  });
});

describe("h5p package extraction", () => {
  it("parses stored and deflated zip entries back to their bytes", () => {
    const zip = makeZip([
      { name: "h5p.json", data: Buffer.from("{}") },
      { name: "content/content.json", data: Buffer.from('{"title":"Lesson"}'), deflate: true }
    ]);

    const entries = parseZip(zip);

    expect(entries.map((entry) => entry.name)).toEqual(["h5p.json", "content/content.json"]);
    expect(entries[0].data.toString()).toBe("{}");
    expect(entries[1].data.toString()).toBe('{"title":"Lesson"}');
  });

  it("extracts only the content/ payload from a .h5p package", () => {
    const dir = mkdtempSync(join(tmpdir(), "uit-h5p-"));
    try {
      const h5pPath = join(dir, "lesson.h5p");
      writeFileSync(
        h5pPath,
        makeZip([
          { name: "h5p.json", data: Buffer.from("manifest") },
          { name: "H5P.Video-1.6/library.json", data: Buffer.from("lib") },
          { name: "content/content.json", data: Buffer.from("slides"), deflate: true },
          { name: "content/videos/clip.mp4", data: Buffer.from("VIDEOBYTES") }
        ])
      );

      const written = extractH5pPackage(h5pPath, join(dir, "lesson"));

      expect(written.map((path) => path.replace(dir, "").replace(/\\/g, "/")).sort()).toEqual([
        "/lesson/content.json",
        "/lesson/videos/clip.mp4"
      ]);
      expect(readFileSync(join(dir, "lesson", "videos", "clip.mp4")).toString()).toBe("VIDEOBYTES");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write package entries that escape the destination directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "uit-h5p-"));
    try {
      const h5pPath = join(dir, "evil.h5p");
      writeFileSync(
        h5pPath,
        makeZip([
          { name: "content/../../escape.txt", data: Buffer.from("BAD") },
          { name: "content/..\\windows.txt", data: Buffer.from("BAD") },
          { name: "content/ok.txt", data: Buffer.from("GOOD") }
        ])
      );

      const written = extractH5pPackage(h5pPath, join(dir, "out"));

      expect(written.map((path) => path.replace(dir, "").replace(/\\/g, "/"))).toEqual(["/out/ok.txt"]);
      expect(existsSync(join(dir, "escape.txt"))).toBe(false);
      expect(existsSync(join(dir, "windows.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
