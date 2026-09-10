import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { createTokenApiClient, credentialFreeUrl, fetchCourseFile, MAX_PREVIEW_BYTES, readCourseFile } from "../src/api.js";
import { clearCourseCache, courseWorkspace, getAssignmentSubmission, getCourseContents, listAnnouncements, listAssignments, listCourses, listForumDiscussions, materializeFile, previewableMime, previewFile, resolveCourseResource } from "../src/desktop-service.js";
import type { ApiClient, MoodleRecord } from "../src/types.js";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", () => ({ homedir: () => state.home }));
vi.mock("mammoth", () => ({ default: { extractRawText: async () => ({ value: "Converted docx", messages: [] }) } }));
const site = "https://courses.uit.edu.vn";
const file = { filename: "lecture.pdf", fileurl: `${site}/pluginfile.php/1/lecture.pdf`, filesize: 8, mimetype: "application/pdf", type: "file" };
const secondFile = { ...file, fileurl: `${site}/pluginfile.php/2/lecture.pdf` };
const assignmentFile = { ...file, filename: "project.txt", fileurl: `${site}/pluginfile.php/3/project.txt`, mimetype: "text/plain" };
const announcementFile = { ...file, filename: "notice.txt", fileurl: `${site}/pluginfile.php/4/notice.txt`, mimetype: "text/plain" };

function zipEntry(contents: Buffer, expandedSize = contents.length): Buffer {
  const name = Buffer.from("word/document.xml");
  const compressed = deflateRawSync(contents);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(expandedSize, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(expandedSize, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
}

function client(overrides: Record<string, any> = {}): ApiClient {
  const responses: Record<string, any> = {
    core_course_get_contents: [{ name: "Week 1", modules: [
      { id: 10, name: "Lectures", modname: "folder", contents: [file, secondFile, { type: "url", filename: "Reading", fileurl: "https://example.org/reading" }, { type: "content", filename: "index.html" }] },
      { id: 20, name: "Project", modname: "assign" },
      { id: 30, name: "Announcements", modname: "forum" }
    ] }],
    mod_assign_get_assignments: { courses: [{ id: 42, assignments: [{ id: 200, cmid: 20, name: "Project", intro: "<p>Trusted assignment intro</p>", introattachments: [assignmentFile], introfiles: [assignmentFile], configs: [{ name: "enabled", value: 1 }], grade: 100 }] }] },
    mod_forum_get_forums_by_courses: [{ id: 300, cmid: 30, course: 42, type: "news" }, { id: 301, cmid: 31, type: "general" }],
    mod_forum_get_forum_discussions: { discussions: [{ discussion: 400, subject: "Notice", message: "<p>Trusted announcement message</p>", attachments: [announcementFile], messageinlinefiles: [announcementFile], pinned: true }] },
    ...overrides
  };
  return { call: vi.fn(async (name) => { if (!(name in responses)) throw new Error(`Unexpected method: ${name}`); return responses[name]; }), uploadFile: vi.fn(), downloadFile: vi.fn(), readFile: vi.fn().mockResolvedValue({ data: Buffer.from("%PDF-1.7"), mimeType: "application/pdf" }) };
}

beforeEach(() => { vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request"))); });

afterEach(async () => {
  clearCourseCache();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  if (state.home) await rm(state.home, { recursive: true, force: true });
  state.home = "";
});

describe("course semesters and metadata", () => {
  it.each([
    [{ semester: 2, academicyear: "2024-2025" }, "2024-2025-hk2", "metadata"],
    [{ semester: { id: "term-7", label: "Custom term", sortOrder: 7 } }, "term-7", "metadata"],
    [{ categoryid: 8, categoryname: "HK1 2025-2026" }, "2025-2026-hk1", "category"],
    [{ coursecategory: "HK2 2025-2026" }, "2025-2026-hk2", "category"],
    [{ fullname: "CS - Semester II 2023/24" }, "2023-2024-hk2", "name"],
    [{ shortname: "CS_HK1_2022-2023" }, "2022-2023-hk1", "name"],
    [{ startdate: Date.UTC(2024, 0, 1) / 1000 }, "2024", "startdate"]
  ])("normalizes semester without fabricating dates: %j", async (fields, id, source) => {
    const api = client({ core_enrol_get_users_courses: [{ id: 42, ...fields }] });
    const [course] = await listCourses(api, 7);
    expect(course.semester).toMatchObject({ id, source });
    expect(course.startdate).toBe((fields as MoodleRecord).startdate || undefined);
    expect(course.enddate).toBeUndefined();
    if (source === "startdate") expect(course.semester.label).toBe("2024");
  });

  it.each([
    { categoryname: "H\u1ecdc k\u00ec 1 2026-2027" },
    { categoryname: "H\u1ecdc k\u1ef3 1 2026-2027" },
    { categoryname: "Ho\u0323c ki\u0300 1 2026-2027" },
    { categoryname: "HK01 2026-2027" },
    { categoryname: "Kh\u00f3a 2022 - HK1 2026-2027" },
    { categoryname: "Kh\u00f3a 2022 - HK1 2026/27" },
    { categoryname: "HK1", academicyear: "2026-2027" },
    { categoryname: "Kh\u00f3a 2022 - HK1", academicyear: "2026-2027" },
    { coursecategory: "HK1", academic_year: "2026-2027" },
    { category: { id: 9, name: "HK1" }, year: "2026-2027" },
    { category: "HK1", academicyear: "2026-2027" }
  ])("normalizes category terms and academic years: %j", async (fields) => {
    const [course] = await listCourses(client({ core_enrol_get_users_courses: [{ id: 42, ...fields }] }), 7);
    expect(course.semester).toEqual({ id: "2026-2027-hk1", label: "HK1 2026-2027", sortOrder: 20261, source: "category" });
  });

  it.each(["-", "/", "_", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2212", "&ndash;", "&mdash;", "&minus;", "&#8211;", "&#x2014;", "&#45;", "&sol;"])("normalizes year separator %s", async (separator) => {
    const [course] = await listCourses(client({ core_enrol_get_users_courses: [{ id: 42, categoryname: `HK1&nbsp;2026${separator}2027` }] }), 7);
    expect(course.semester).toEqual({ id: "2026-2027-hk1", label: "HK1 2026-2027", sortOrder: 20261, source: "category" });
  });

  it.each([
    { semester: 1, academicyear: "2026-2027" },
    { semester: "01", academic_year: "2026-2027" },
    { semester: 1, categoryname: "HK1 2026-2027" },
    { semester: 1, category: { name: "Kh\u00f3a 2022 - HK1 2026-2027" } },
    { semester: 1, categoryname: "2026-2027" },
    { semester: "HK01", coursecategory: "2026-2027" },
    { semester: 1, semestername: "HK1 2026-2027" },
    { term: 1, year: "2026-2027" },
    { customfields: [{ shortname: "semester", value: 1 }], academicyear: "2026-2027" },
    { customfields: [{ name: "H\u1ecdc k\u00ec", value: "HK1 2026-2027" }] },
    { customfields: [{ shortname: "hoc_ky", value: "HK1 2026-2027" }] }
  ])("combines partial semester metadata with known context: %j", async (fields) => {
    const [course] = await listCourses(client({ core_enrol_get_users_courses: [{ id: 42, ...fields }] }), 7);
    expect(course.semester).toEqual({ id: "2026-2027-hk1", label: "HK1 2026-2027", sortOrder: 20261, source: "metadata" });
  });

  it.each([
    { semester: 1 },
    { semester: "HK1" },
    { semester: 1, categoryname: "Kh\u00f3a 2022" },
    { semester: 1, academicyear: "2025-2026 / 2026-2027" },
    { categoryname: "HK1 / HK2 2026-2027" },
    { categoryname: "HK1 2024-2025 / 2026-2027" },
    { categoryname: "HK1 2024 2026" },
    { categoryname: "Kh\u00f3a 2022 - HK1" }
  ])("keeps conflicting or yearless terms unknown: %j", async (fields) => {
    const [course] = await listCourses(client({ core_enrol_get_users_courses: [{ id: 42, ...fields }] }), 7);
    expect(course.semester).toEqual({ id: "unknown", label: "Unknown semester", sortOrder: 0, source: "unknown" });
  });

  it.each([
    { startdate: 0 },
    { fullname: "Longterm 1 2026-2027" },
    { customfields: [{ shortname: "longterm", value: "yes" }] },
    { customfields: [{ shortname: "semester_enabled", value: "yes" }] },
    { customfields: [{ shortname: "midterm", value: "HK1 2026-2027" }] },
    { fullname: "Thesis", baseUrl: site },
    { fullname: "Thesis", summary: "D\u00e0nh cho sinh vi\u00ean Kh\u00f3a 2022" },
    { categoryname: "Khoa h\u1ecdc M\u00e1y t\u00ednh" }
  ])("files courses without time evidence under the current year: %j", async (fields) => {
    const now = new Date().getUTCFullYear();
    const [course] = await listCourses(client({ core_enrol_get_users_courses: [{ id: 42, ...fields }] }), 7);
    expect(course.semester).toEqual({ id: `${now}`, label: `${now}`, sortOrder: now * 10 + 9, source: "current" });
  });

  it.each([
    [{ categoryname: "2026-2027" }, "2026-2027", "category"],
    [{ categoryname: "N\u0103m h\u1ecdc 2026" }, "2026", "category"],
    [{ categoryname: "2026-2027 - Lu\u1eadn v\u0103n t\u1ed1t nghi\u1ec7p" }, "2026-2027", "category"],
    [{ categoryname: "HK012 2026-2027" }, "2026-2027", "category"],
    [{ semester: "2026" }, "2026", "metadata"],
    [{ customfields: [{ shortname: "semester", value: "2026-2027" }] }, "2026-2027", "metadata"]
  ])("groups year-only categories and metadata as years without inventing terms: %j", async (fields, id, source) => {
    const [course] = await listCourses(client({ core_enrol_get_users_courses: [{ id: 42, ...fields }] }), 7);
    expect(course.semester).toEqual({ id, label: id, sortOrder: Number(id.slice(0, 4)) * 10 + 9, source });
  });

  it("preserves explicit identities, labels, precedence and descending semester sort", async () => {
    const courses = await listCourses(client({ core_enrol_get_users_courses: [
      { id: 99 },
      { id: 1, semester: { id: "custom", label: "<b>Custom term</b>", sortOrder: 20270 } },
      { id: 2, categoryname: "HK1 2026-2027" },
      { id: 3, semester: "HK2 2026-2027", categoryname: "HK1 2025-2026" },
      { id: 4, fullname: "HK1 2026-2027" },
      { id: 5, semester: "<b>Special term</b>" },
      { id: 6, semester: { id: "label-term", label: "HK1 2026-2027" } }
    ] }), 7);
    expect(courses.map((course) => course.id)).toEqual([1, 99, 3, 6, 4, 2, 5]);
    expect(courses[0].semester).toEqual({ id: "custom", label: "Custom term", sortOrder: 20270, source: "metadata" });
    const now = new Date().getUTCFullYear();
    expect(courses[1].semester).toEqual({ id: `${now}`, label: `${now}`, sortOrder: now * 10 + 9, source: "current" });
    expect(courses[2].semester).toEqual({ id: "2026-2027-hk2", label: "HK2 2026-2027", sortOrder: 20262, source: "metadata" });
    expect(courses[3].semester).toEqual({ id: "label-term", label: "HK1 2026-2027", sortOrder: 20261, source: "metadata" });
    expect(courses[6].semester).toEqual({ id: "metadata-<b>special term</b>", label: "Special term", sortOrder: 0, source: "metadata" });
  });

  it.each([
    ["H\u1ecdc k\u00ec II 2026-27", 2, "2026-2027"],
    ["HK02 2026-2027", 2, "2026-2027"],
    ["Semester III 2026-2027", 3, "2026-2027"],
    ["Term IV 2026-2027", 4, "2026-2027"],
    ["HK h\u00e8 2026-2027", 3, "2026-2027"],
    ["Sem summer 2026-2027", 3, "2026-2027"],
    ["HK1 2026", 1, "2026"],
    ["HK1 2026-2027 / HK I 2026/27", 1, "2026-2027"]
  ])("preserves supported term forms and duplicate context: %s", async (fullname, term, years) => {
    const [course] = await listCourses(client({ core_enrol_get_users_courses: [{ id: 42, fullname, shortname: fullname }] }), 7);
    expect(course.semester).toEqual({ id: `${years}-hk${term}`, label: `HK${term} ${years}`, sortOrder: 20260 + Number(term), source: "name" });
  });

  it.each([null, undefined, {}, { courses: [] }, "", false, 0])("rejects a malformed course list: %j", async (records) => {
    await expect(listCourses(client({ core_enrol_get_users_courses: records }), 7)).rejects.toThrow("Invalid course list response: expected an array.");
  });

  it("accepts an empty course array and propagates API failures", async () => {
    const api = client({ core_enrol_get_users_courses: [] });
    vi.mocked(api.call).mockRejectedValueOnce(new Error("Courses unavailable"));
    await expect(listCourses(api, 7)).rejects.toThrow("Courses unavailable");
    await expect(listCourses(api, 7)).resolves.toEqual([]);
    expect(api.call).toHaveBeenLastCalledWith("core_enrol_get_users_courses", { userid: 7 });
  });

  it("retains actual files and useful URLs separately", async () => {
    const [module] = await getCourseContents(42, client());
    expect(module.files).toHaveLength(2);
    expect(module.urls).toEqual([{ name: "Reading", url: "https://example.org/reading" }]);
  });

  it("deduplicates calls, isolates clients, expires and clears the cache", async () => {
    vi.useFakeTimers();
    const api = client();
    const other = client();
    await Promise.all([getCourseContents(42, api), getCourseContents(42, api), getCourseContents(42, other)]);
    expect(api.call).toHaveBeenCalledTimes(2);
    expect(other.call).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_001);
    await getCourseContents(42, api);
    expect(api.call).toHaveBeenCalledTimes(4);
    clearCourseCache(api);
    await getCourseContents(42, api);
    await getCourseContents(42, other);
    expect(api.call).toHaveBeenCalledTimes(6);
    expect(other.call).toHaveBeenCalledTimes(4);
    clearCourseCache();
    await getCourseContents(42, api);
    expect(api.call).toHaveBeenCalledTimes(8);
  });

  it("does not cache failures", async () => {
    const api = client();
    vi.mocked(api.call).mockRejectedValueOnce(new Error("offline"));
    await expect(getCourseContents(42, api)).rejects.toThrow("offline");
    expect(await getCourseContents(42, api)).toHaveLength(3);
    expect(api.call).toHaveBeenCalledTimes(3);
  });

  it("preserves assignment/announcement metadata and deduplicates attachments", async () => {
    const api = client();
    const assignment = (await listAssignments(42, api))[0];
    const announcement = (await listAnnouncements(42, api))[0];
    expect(assignment).toMatchObject({ id: 200, moduleId: 20, description: "Trusted assignment intro", grade: 100, files: [expect.objectContaining({ filename: "project.txt" })] });
    expect(announcement).toMatchObject({ id: 400, moduleId: 30, message: "Trusted announcement message", files: [expect.objectContaining({ filename: "notice.txt" })] });
    for (const record of [assignment, announcement]) {
      for (const key of ["raw", "intro", "introformat", "configs", "messageHtml", "descriptionHtml"]) expect(record).not.toHaveProperty(key);
    }
  });

  it("returns only clean URLs and text to the renderer and agent", async () => {
    const dirtyUrl = `${site}/sdh/pluginfile.php/1/a.pdf?token=secret&wstoken=secret&sesskey=secret&access_token=secret&Authorization=secret&password=secret&signature=secret&forcedownload=1#secret`;
    const dirtyFile = { ...file, fileurl: dirtyUrl };
    const html = '<p>Clean text</p><script>secret</script><img src="secret" onerror="secret">';
    const api = client({
      core_course_get_contents: [{ modules: [{ id: 10, url: dirtyUrl, description: html, contents: [dirtyFile, { type: "url", fileurl: dirtyUrl }] }] }],
      mod_assign_get_assignments: { courses: [{ id: 42, assignments: [{ id: 200, url: dirtyUrl, intro: html, introfiles: [dirtyFile], submissionstatement: html, raw: "secret", configs: [{ value: "secret" }] }] }] },
      mod_forum_get_forum_discussions: { discussions: [{ discussion: 400, url: dirtyUrl, message: html, attachments: [dirtyFile], secret: "secret" }] }
    });
    const modules = await getCourseContents(42, api);
    const assignments = await listAssignments(42, api);
    const announcements = await listAnnouncements(42, api);
    const cleanUrl = `${site}/sdh/pluginfile.php/1/a.pdf?forcedownload=1`;
    for (const record of [modules[0], assignments[0], announcements[0]]) {
      expect(record.url).toBe(cleanUrl);
      expect(record.files[0].fileurl).toBe(cleanUrl);
    }
    expect(modules[0].urls).toEqual([{ name: cleanUrl, url: cleanUrl }]);
    expect(JSON.stringify([modules, assignments, announcements])).not.toMatch(/secret|<p>|<script|onerror/);
    // safeResource's URL pass must leave the service identity unchanged.
    const rendererUrl = new URL(modules[0].files[0].fileurl);
    rendererUrl.username = ""; rendererUrl.password = "";
    for (const key of [...rendererUrl.searchParams.keys()]) if (/token|sesskey|password|auth/i.test(key)) rendererUrl.searchParams.delete(key);
    await expect(resolveCourseResource(42, { kind: "file", id: 10, fileUrl: rendererUrl.href }, api)).resolves.toMatchObject({ url: cleanUrl });
    await previewFile(42, rendererUrl.href, "ignored", api);
    expect(api.readFile).toHaveBeenCalledWith(cleanUrl);
    await expect(resolveCourseResource(42, { kind: "file", id: 10, fileUrl: dirtyUrl }, api)).resolves.toMatchObject({ url: cleanUrl });
  });

  it("paginates announcements across all news forums and surfaces failures", async () => {
    const api = client();
    const original = api.call;
    api.call = vi.fn(async (name, params) => {
      if (name !== "mod_forum_get_forum_discussions") return original(name, params);
      return { discussions: Array.from({ length: params?.page === 0 ? 100 : 1 }, (_, id) => ({ discussion: id + Number(params?.page) * 100 + 1, message: "Notice" })) } as any;
    });
    expect(await listAnnouncements(42, api)).toHaveLength(101);
    clearCourseCache(api);
    vi.mocked(api.call).mockRejectedValueOnce(new Error("permission denied"));
    await expect(listAnnouncements(42, api)).rejects.toThrow("permission denied");
  });

  it("rejects an incomplete announcement list when a later page fails and retries the failed page", async () => {
    const api = client();
    const original = api.call;
    const nextPage = vi.fn().mockRejectedValueOnce(new Error("Later announcement page unavailable"))
      .mockResolvedValue({ discussions: [] });
    api.call = vi.fn(async (name, params) => {
      if (name !== "mod_forum_get_forum_discussions") return original(name, params);
      if (params?.page === 1) return nextPage();
      return { discussions: Array.from({ length: 100 }, (_, id) => ({ discussion: id + 1, message: "Notice" })) } as any;
    });
    await expect(listAnnouncements(42, api)).rejects.toThrow("Later announcement page unavailable");
    expect(await listAnnouncements(42, api)).toHaveLength(100);
    expect(nextPage).toHaveBeenCalledTimes(2);
    expect(api.call).toHaveBeenCalledTimes(4);
  });
});

describe("trusted course resource resolution", () => {
  it("resolves cmid-only assignment references and attachments while preserving partial availability", async () => {
    const unavailable = { instance: "Instance not exposed", details: "Activity details are incomplete" };
    const api = client({
      mod_assign_get_assignments: { courses: [{ id: 42, assignments: [{ cmid: 20, name: "Project", intro: "<p>Partial intro</p>", introattachments: [assignmentFile], unavailable }] }] }
    });
    const [assignment] = await listAssignments(42, api);
    expect(assignment.id).toBeUndefined();
    expect(assignment.resourceRef).toEqual({ kind: "module", id: 20 });
    await expect(resolveCourseResource(42, assignment.resourceRef, api)).resolves.toMatchObject({ kind: "module", id: 20, description: "Partial intro", files: [expect.objectContaining({ fileurl: assignmentFile.fileurl })], unavailable });
    await expect(resolveCourseResource(42, { kind: "file", id: 20, fileUrl: assignmentFile.fileurl }, api)).resolves.toMatchObject({ unavailable });
    await expect(resolveCourseResource(42, { kind: "assignment", id: 20 }, api)).rejects.toThrow("does not belong");
    await expect(previewFile(42, assignmentFile.fileurl, "ignored", api)).resolves.toMatchObject({ mimeType: "application/pdf", filename: "project.txt" });
    expect(api.readFile).toHaveBeenCalledWith(assignmentFile.fileurl);
  });

  it("preserves resource and announcement partial errors as plain text through resolution", async () => {
    const api = client({
      core_course_get_contents: [{ modules: [{ id: 10, modname: "folder", contents: [file], unavailable: { contents: "<b>Some files unavailable</b>", raw: { secret: true } } }] }],
      mod_forum_get_forums_by_courses: [{ id: 300, cmid: 30, type: "news", unavailable: { details: "<b>Partial forum details</b>" } }],
      mod_forum_get_forum_discussions: { discussions: [{ discussion: 400, subject: "Notice", unavailable: { message: "<p>Opening post unavailable</p>" } }] }
    });
    const [module] = await getCourseContents(42, api);
    expect(module.unavailable).toEqual({ contents: "Some files unavailable" });
    await expect(resolveCourseResource(42, { kind: "module", id: 10 }, api)).resolves.toMatchObject({ unavailable: module.unavailable });
    await expect(resolveCourseResource(42, { kind: "file", id: 10, fileUrl: file.fileurl }, api)).resolves.toMatchObject({ unavailable: module.unavailable });
    const [announcement] = await listAnnouncements(42, api);
    expect(announcement).toMatchObject({ id: 400, message: "", unavailable: { details: "Partial forum details", message: "Opening post unavailable" } });
    await expect(resolveCourseResource(42, { kind: "announcement", id: 400 }, api)).resolves.toMatchObject({ unavailable: announcement.unavailable });
  });

  it("reads an unresolved announcement forum through its course-module ID", async () => {
    const api = client({
      mod_forum_get_forums_by_courses: [{ cmid: 30, course: 42, unavailable: { details: "Instance and type hidden" } }],
      mod_forum_get_forum_discussions: { discussions: [{ discussion: 400, subject: "Notice" }] }
    });
    await expect(listAnnouncements(42, api)).resolves.toMatchObject([{ id: 400, moduleId: 30 }]);
    expect(api.call).toHaveBeenCalledWith("mod_forum_get_forum_discussions", { cmid: 30, page: 0, perpage: 100 });
  });

  it.each([
    Object.assign(new Error("Unknown function"), { errorcode: "invalidfunction" }),
    new Error("This UIT site does not expose mod_assign_get_assignments to the SSO session. Open the activity on the course site for its full details.")
  ])("preserves module details when supplemental assignments are unsupported: %s", async (error) => {
    const api = client({ core_course_get_contents: [{ modules: [{ id: 20, modname: "assign", description: "<p>Available description</p>", contents: [file] }] }] });
    const original = api.call;
    api.call = vi.fn(async (name, params) => { if (name === "mod_assign_get_assignments") throw error; return original(name, params); });
    for (const reference of [{ kind: "module", id: 20 }, { kind: "file", id: 20, fileUrl: file.fileurl }] as const) {
      await expect(resolveCourseResource(42, reference, api)).resolves.toMatchObject({ description: "Available description", files: [expect.objectContaining({ fileurl: file.fileurl })], unavailable: undefined });
    }
  });

  it.each(["offline", "permission denied", "invalidparameter", "servicenotavailable", "accesscontrol", "HTTP 500"])("does not hide supplemental assignment failure: %s", async (message) => {
    const api = client();
    const original = api.call;
    api.call = vi.fn(async (name, params) => { if (name === "mod_assign_get_assignments") throw Object.assign(new Error(message), { errorcode: message }); return original(name, params); });
    await expect(resolveCourseResource(42, { kind: "module", id: 20 }, api)).rejects.toThrow(message);
  });

  it.each([
    [{ kind: "module", id: 20 }, "Trusted assignment intro"],
    [{ kind: "assignment", id: 200, moduleId: 20 }, "Trusted assignment intro"],
    [{ kind: "announcement", id: 400, moduleId: 30 }, "Trusted announcement message"],
    [{ kind: "file", id: 20, fileUrl: assignmentFile.fileurl }, "Trusted assignment intro"],
    [{ kind: "file", id: 30, fileUrl: announcementFile.fileurl }, "Trusted announcement message"]
  ] as const)("resolves %j using service-owned context", async (reference, description) => {
    await expect(resolveCourseResource(42, reference, client())).resolves.toMatchObject({ kind: reference.kind, id: reference.id, description });
  });

  it.each([
    { kind: "module", id: 999 }, { kind: "assignment", id: 200, moduleId: 10 },
    { kind: "file", id: 10, fileUrl: "https://evil.example/a.pdf" },
    { kind: "announcement", id: 400, fileUrl: file.fileurl },
    { kind: "module", id: 10, moduleId: 20 },
    { kind: "file", id: 999, moduleId: 10, fileUrl: file.fileurl }
  ] as const)("rejects forged resource %j", async (reference) => {
    await expect(resolveCourseResource(42, reference, client())).rejects.toThrow("does not belong");
  });
});

describe("in-memory preview", () => {
  it("returns base64 with the authoritative filename and never downloads", async () => {
    const api = client();
    await expect(previewFile(42, file.fileurl, "forged.exe", api)).resolves.toEqual({ mimeType: "application/pdf", data: Buffer.from("%PDF-1.7").toString("base64"), filename: "lecture.pdf" });
    expect(api.downloadFile).not.toHaveBeenCalled();
  });

  it.each(["image/png", "image/jpeg", "text/markdown", "text/x-markdown", "text/x-python"])("supports safe display of %s", async (mimeType) => {
    const api = client();
    vi.mocked(api.readFile!).mockResolvedValue({ data: Buffer.from("content"), mimeType });
    const preview = await previewFile(42, file.fileurl, file.filename, api);
    expect(preview.mimeType).toBe(mimeType);
  });

  it.each([
    ["application/pdf", "slide.pdf", true],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "essay.docx", true],
    ["text/plain", "essay.docx", true],
    ["text/markdown", "notes.md", true],
    ["text/plain", "notes.md", true],
    ["text/x-python", "script.py", true],
    ["text/plain", "script.py", true],
    ["image/png", "pixel.png", true],
    ["image/svg+xml", "diagram.svg", false],
    ["text/html", "notes.html", false],
    ["application/json", "data.json", false],
    ["text/plain", "lecture.txt", false],
    ["text/csv", "data.csv", false],
    ["application/zip", "archive.zip", false],
    ["application/octet-stream", "data.bin", false],
  ])("allowlist %s / %s previews: %s", (mimeType, filename, expected) => {
    expect(previewableMime(mimeType, filename)).toBe(expected);
  });

  it("converts word documents to plain text for preview", async () => {
    const docx = { filename: "essay.docx", fileurl: `${site}/pluginfile.php/5/essay.docx`, filesize: 8, mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", type: "file" };
    const api = client({ core_course_get_contents: [{ name: "Week 1", modules: [{ id: 10, name: "Docs", modname: "resource", contents: [docx] }] }] });
    vi.mocked(api.readFile!).mockResolvedValue({ data: zipEntry(Buffer.from("document")), mimeType: docx.mimetype });
    await expect(previewFile(42, docx.fileurl, "ignored", api)).resolves.toEqual({ mimeType: "text/plain", data: Buffer.from("Converted docx").toString("base64"), filename: "essay.docx" });
    expect(api.downloadFile).not.toHaveBeenCalled();
  });

  it("rejects DOCX archives with oversized or dishonest expansion metadata", async () => {
    const docx = { filename: "essay.docx", fileurl: `${site}/pluginfile.php/5/essay.docx`, filesize: 8, mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", type: "file" };
    const api = client({ core_course_get_contents: [{ modules: [{ id: 10, modname: "resource", contents: [docx] }] }] });
    vi.mocked(api.readFile!).mockResolvedValueOnce({ data: zipEntry(Buffer.from("tiny"), 51 * 1024 * 1024), mimeType: docx.mimetype });
    await expect(previewFile(42, docx.fileurl, docx.filename, api)).rejects.toThrow("50 MB");
    vi.mocked(api.readFile!).mockResolvedValueOnce({ data: zipEntry(Buffer.alloc(1024), 1), mimeType: docx.mimetype });
    await expect(previewFile(42, docx.fileurl, docx.filename, api)).rejects.toThrow("invalid expanded size");
  });

  it("rejects unsupported formats, oversized payloads, and foreign files", async () => {
    const api = client();
    vi.mocked(api.readFile!).mockResolvedValueOnce({ data: Buffer.from("zip"), mimeType: "application/zip" });
    await expect(previewFile(42, file.fileurl, file.filename, api)).rejects.toThrow("not supported");
    vi.mocked(api.readFile!).mockResolvedValueOnce({ data: new Uint8Array(MAX_PREVIEW_BYTES + 1), mimeType: "application/pdf" });
    await expect(previewFile(42, file.fileurl, file.filename, api)).rejects.toThrow("25 MB");
    await expect(previewFile(42, "https://evil.example/file", "file", api)).rejects.toThrow("does not belong");
    expect(api.readFile).toHaveBeenCalledTimes(2);
    expect(api.downloadFile).not.toHaveBeenCalled();
  });

  it("bounds advertised and chunked file responses", async () => {
    await expect(readCourseFile(new Response("tiny", { headers: { "content-length": String(MAX_PREVIEW_BYTES + 1) } }))).rejects.toThrow("25 MB");
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_PREVIEW_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel });
    await expect(readCourseFile(new Response(stream))).rejects.toThrow("25 MB");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("merges assignment intros and attachments into course modules", async () => {
    const [module] = (await getCourseContents(42, client())).filter((entry) => entry.modname === "assign");
    expect(module.description).toBe("Trusted assignment intro");
    expect(module.files).toEqual([expect.objectContaining({ filename: "project.txt" })]);
  });

  it("reads submission status, grade and files by assignment or module", async () => {
    const submitted = { filename: "final.pdf", fileurl: `${site}/pluginfile.php/5/assignsubmission_file/submission_files/final.pdf`, filesize: 9, mimetype: "application/pdf" };
    const api = client({ mod_assign_get_submission_status: { lastattempt: { submission: { status: "submitted", plugins: [{ type: "file", fileareas: [{ area: "submission_files", files: [submitted] }] }] } }, feedback: { gradefordisplay: "9.0" } } });
    await expect(getAssignmentSubmission(42, { assignId: 200 }, api)).resolves.toMatchObject({ assignId: 200, moduleId: 20, status: "submitted", grade: "9.0", files: [expect.objectContaining({ filename: "final.pdf" })] });
    await expect(getAssignmentSubmission(42, { moduleId: 20 }, api)).resolves.toMatchObject({ assignId: 200 });
    await expect(getAssignmentSubmission(42, { moduleId: 999 }, api)).rejects.toThrow("Assignment instance unavailable");
    await expect(getAssignmentSubmission(42, {}, api)).rejects.toThrow("Assignment instance unavailable");
    await expect(previewFile(42, submitted.fileurl, "ignored", api)).resolves.toMatchObject({ mimeType: "application/pdf", filename: "final.pdf" });
    expect(api.downloadFile).not.toHaveBeenCalled();
  });

  it("reads forum discussions by cmid and retries by instance on old releases", async () => {
    await expect(listForumDiscussions(42, 30, client())).resolves.toHaveLength(1);
    const old = client({ core_course_get_contents: [{ name: "Week 1", modules: [{ id: 30, name: "Old forum", modname: "forum", instance: 300 }] }] });
    const original = old.call;
    old.call = vi.fn(async (name: string, params?: Record<string, any>) => {
      if (name === "mod_forum_get_forum_discussions" && params?.cmid !== undefined) throw new Error("Phát hiện giá trị tham số không phù hợp");
      return (original as any)(name, params);
    });
    const discussions = await listForumDiscussions(42, 30, old);
    expect(discussions).toHaveLength(1);
    expect(discussions[0].forumId).toBe(300);
    await expect(listForumDiscussions(42, 999, client())).rejects.toThrow("not a forum");
  });

  it("checks metadata size before fetching and requires a preview-capable session", async () => {
    const api = client({ core_course_get_contents: [{ modules: [{ id: 10, contents: [{ ...file, filesize: MAX_PREVIEW_BYTES + 1 }] }] }] });
    await expect(previewFile(42, file.fileurl, file.filename, api)).rejects.toThrow("25 MB");
    expect(api.readFile).not.toHaveBeenCalled();
    const legacy = client();
    delete legacy.readFile;
    await expect(previewFile(42, file.fileurl, file.filename, legacy)).rejects.toThrow("does not support");
  });
});

describe("authenticated token files", () => {
  it.each([
    [`https://user:password@courses.uit.edu.vn/pluginfile.php/1/a.pdf?TOKEN=one&token=two&wstoken=three&sesskey=four&authkey=five&key=six&file=%2F1%2Fa.pdf`, `${site}/pluginfile.php/1/a.pdf?file=%2F1%2Fa.pdf`],
    ["javascript:alert(1)", undefined],
    ["not a URL", undefined],
    [`${site}/tokenpluginfile.php/ambiguous`, undefined]
  ])("sanitizes or rejects public URL %s", (input, expected) => {
    expect(credentialFreeUrl(input)).toBe(expected);
  });

  it("uses cleaned service metadata with each client's own token", async () => {
    const signed = `${site}/sdh/tokenpluginfile.php/signedkey/1/mod_resource/content/2/a.pdf?forcedownload=1`;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/server.php")) return Response.json([{ modules: [{ id: 10, contents: [{ ...file, fileurl: signed }] }] }]);
      return new Response("hello", { headers: { "content-type": "application/pdf" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    for (const token of ["first-mobile", "second-mobile"]) {
      const api = createTokenApiClient(`${site}/sdh`, token);
      const [module] = await getCourseContents(42, api);
      const clean = module.files[0].fileurl;
      expect(clean).toBe(`${site}/sdh/pluginfile.php/1/mod_resource/content/2/a.pdf?forcedownload=1`);
      await resolveCourseResource(42, { kind: "file", id: 10, fileUrl: clean }, api);
      await previewFile(42, clean, "ignored", api);
      const requested = new URL(fetchMock.mock.calls.at(-1)![0]);
      expect(requested.pathname).toBe("/sdh/webservice/pluginfile.php/1/mod_resource/content/2/a.pdf");
      expect(requested.searchParams.get("token")).toBe(token);
      expect(requested.href).not.toContain("signedkey");
    }
  });

  it("preserves the graduate installation and query across relative redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "?file=%2F1%2Fa.pdf&forcedownload=1" } }))
      .mockResolvedValueOnce(new Response("hello", { headers: { "content-type": "application/pdf" } }));
    vi.stubGlobal("fetch", fetchMock);
    await createTokenApiClient(`${site}/sdh`, "mobile").readFile!("pluginfile.php?file=%2F1%2Fa.pdf");
    expect(String(fetchMock.mock.calls[1][0])).toBe(`${site}/sdh/webservice/pluginfile.php?file=%2F1%2Fa.pdf&forcedownload=1&token=mobile`);
  });

  it.each([
    ["/pluginfile.php/1/mod_resource/content/2/a%20b.pdf?forcedownload=1", "/webservice/pluginfile.php/1/mod_resource/content/2/a%20b.pdf?forcedownload=1&token=mobile"],
    ["/webservice/pluginfile.php/1/a.pdf?token=old", "/webservice/pluginfile.php/1/a.pdf?token=mobile"],
    ["/pluginfile.php?file=%2F1%2Fa%20b.pdf&forcedownload=1", "/webservice/pluginfile.php?file=%2F1%2Fa+b.pdf&forcedownload=1&token=mobile"],
    ["/tokenpluginfile.php/signedkey/1/mod_resource/content/2/a.pdf?forcedownload=1", "/webservice/pluginfile.php/1/mod_resource/content/2/a.pdf?forcedownload=1&token=mobile"],
    ["/tokenpluginfile.php?file=%2F1%2Fa.pdf&token=signedkey", "/webservice/pluginfile.php?file=%2F1%2Fa.pdf&token=mobile"]
  ])("normalizes supported file endpoint %s with installation prefixes", async (input, expected) => {
    for (const prefix of ["", "/sdh"]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response("hello", { headers: { "content-type": "text/plain" } }));
      vi.stubGlobal("fetch", fetchMock);
      await createTokenApiClient(`${site}${prefix}/`, "mobile").readFile!(`${site}${prefix}${input}`);
      expect(String(fetchMock.mock.calls[0][0])).toBe(`${site}${prefix}${expected}`);
    }
  });

  it("normalizes signed URLs to credential-free URLs usable with session cookies", async () => {
    const signed = `${site}/sdh/tokenpluginfile.php/signedkey/1/mod_resource/content/2/a.pdf?token=secret&forcedownload=1`;
    const clean = credentialFreeUrl(signed)!;
    expect(clean).toBe(`${site}/sdh/pluginfile.php/1/mod_resource/content/2/a.pdf?forcedownload=1`);
    const fetchMock = vi.fn().mockImplementation(async () => new Response("hello"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchCourseFile(`${site}/sdh`, clean, { Cookie: "MoodleSession=secret" });
    await fetchCourseFile(`${site}/sdh`, `${site}/sdh/webservice/pluginfile.php/1/a.pdf?token=secret`, { Cookie: "MoodleSession=secret" });
    expect(String(fetchMock.mock.calls[0][0])).toBe(clean);
    expect(String(fetchMock.mock.calls[1][0])).toBe(`${site}/sdh/pluginfile.php/1/a.pdf`);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Cookie: "MoodleSession=secret" });
  });

  it.each(["/mod/resource/view.php?id=1", "/pluginfile.php.evil/1/a.pdf", "/other/pluginfile.php/1/a.pdf", "/tokenpluginfile.php/bad"])("does not attach mobile tokens to unsupported endpoints %s", async (path) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createTokenApiClient(`${site}/sdh`, "secret").readFile!(`${site}${path}`)).rejects.toThrow(/Unsupported/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("authenticates same-origin redirects without leaking tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/pluginfile.php/final" } }))
      .mockResolvedValueOnce(new Response("hello", { headers: { "content-type": "text/plain; charset=utf-8" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createTokenApiClient(site, "secret");
    expect(Buffer.from((await api.readFile!(file.fileurl)).data).toString()).toBe("hello");
    for (const [url, options] of fetchMock.mock.calls) {
      expect(new URL(url).searchParams.get("token")).toBe("secret");
      expect(new URL(url).pathname).toMatch(/^\/webservice\/pluginfile\.php\//);
      expect(options.redirect).toBe("manual");
    }
    await expect(api.readFile!("https://evil.example/file")).rejects.toThrow("another origin");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["text/html", "application/octet-stream"])("rejects login HTML labeled %s", async (mimeType) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('<html><form id="login"><input name="password"></form></html>', { headers: { "content-type": mimeType } })));
    await expect(createTokenApiClient(site, "secret").readFile!(file.fileurl)).rejects.toThrow("login page");
  });

  it.each(["https://evil.example/file", "/login/index.php"])("rejects redirect to %s before sending credentials", async (location) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createTokenApiClient(site, "secret").readFile!(file.fileurl)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("deterministic materialization", () => {
  async function home() {
    state.home = join(process.cwd(), `.course-resources-test-${process.pid}-${Date.now()}`);
    await mkdir(state.home, { recursive: true });
  }

  it("isolates site/account/course, ignores renames and the calendar, and single-flights downloads", async () => {
    await home();
    const api = client();
    vi.mocked(api.downloadFile).mockImplementation(async (_url, path) => { await writeFile(path, "complete"); });
    const identity = { baseUrl: site, userId: 7, shortname: "CS101" };
    const workspace = await courseWorkspace(42, "CS101", site, 7);
    expect((await courseWorkspace(42, "Renamed", `${site}/`, 7)).path).toBe(workspace.path);
    expect((await courseWorkspace(42, "CS101", `${site}/sdh`, 7)).path).not.toBe(workspace.path);
    expect((await courseWorkspace(42, "CS101", site, 8)).path).not.toBe(workspace.path);
    const [first, duplicate] = await Promise.all([materializeFile(42, file.fileurl, "bad-name", api, identity), materializeFile(42, file.fileurl, file.filename, api, identity)]);
    expect(first).toBe(duplicate);
    expect(first.startsWith(join(workspace.path, "materials"))).toBe(true);
    expect(await readFile(first, "utf8")).toBe("complete");
    expect(api.downloadFile).toHaveBeenCalledOnce();
    const second = await materializeFile(42, secondFile.fileurl, secondFile.filename, api, identity);
    expect(second).not.toBe(first);
    await materializeFile(42, file.fileurl, file.filename, api, identity);
    expect(api.downloadFile).toHaveBeenCalledTimes(2);
  });

  it("cleans failed partial downloads and allows retry", async () => {
    await home();
    const api = client();
    const identity = { baseUrl: site, userId: 7 };
    vi.mocked(api.downloadFile).mockImplementationOnce(async (_url, path) => { await writeFile(path, "partial"); throw new Error("offline"); });
    await expect(materializeFile(42, file.fileurl, file.filename, api, identity)).rejects.toThrow("offline");
    const workspace = await courseWorkspace(42, "CS", site, 7);
    const entries = await readdir(join(workspace.path, "materials"), { recursive: true });
    expect(entries.some((entry) => entry.includes(".part-") || entry.endsWith(".pdf"))).toBe(false);
    vi.mocked(api.downloadFile).mockImplementationOnce(async (_url, path) => { await writeFile(path, "complete"); });
    await expect(materializeFile(42, file.fileurl, file.filename, api, identity)).resolves.toContain("lecture.pdf");
  });

  it("rejects a material directory replaced by a symlink", async () => {
    await home();
    const api = client();
    vi.mocked(api.downloadFile).mockImplementation(async (_url, path) => { await writeFile(path, "complete"); });
    const identity = { baseUrl: site, userId: 7 };
    const first = await materializeFile(42, file.fileurl, file.filename, api, identity);
    const hashDirectory = dirname(first);
    const outside = join(state.home, "outside-course-workspace");
    await mkdir(outside);
    await rm(hashDirectory, { recursive: true });
    await symlink(outside, hashDirectory, "dir");
    vi.mocked(api.downloadFile).mockClear();

    await expect(materializeFile(42, file.fileurl, file.filename, api, identity)).rejects.toThrow("symbolic links");
    expect(api.downloadFile).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
  });

  it("redownloads a cached material that was replaced or modified", async () => {
    await home();
    const api = client();
    vi.mocked(api.downloadFile).mockImplementation(async (_url, path) => { await writeFile(path, "authenticated"); });
    const identity = { baseUrl: site, userId: 7 };
    const destination = await materializeFile(42, file.fileurl, file.filename, api, identity);
    await writeFile(destination, "workspace replacement");

    await expect(materializeFile(42, file.fileurl, file.filename, api, identity)).resolves.toBe(destination);
    expect(await readFile(destination, "utf8")).toBe("authenticated");
    expect(api.downloadFile).toHaveBeenCalledTimes(2);
  });

  it("keeps a download pinned when its verified directory is swapped mid-write", async () => {
    await home();
    const api = client();
    const identity = { baseUrl: site, userId: 7 };
    const workspace = await courseWorkspace(42, "CS", site, 7);
    const outside = join(state.home, "outside-race-target");
    await mkdir(outside);
    vi.mocked(api.downloadFile).mockImplementation(async (_url, path) => {
      const materials = join(workspace.path, "materials");
      const [hash] = await readdir(materials);
      await rename(join(materials, hash), join(state.home, "displaced-hash-directory"));
      await symlink(outside, join(materials, hash), "dir");
      await writeFile(path, "complete");
    });

    await expect(materializeFile(42, file.fileurl, file.filename, api, identity)).rejects.toThrow("symbolic links");
    expect(await readdir(outside)).toEqual([]);
  });

  it("invalidates same-URL content revisions but not credential rotation", async () => {
    await home();
    const revision = { ...file, fileurl: `${file.fileurl}?token=first`, timemodified: 100 };
    const api = client({ core_course_get_contents: [{ modules: [{ id: 10, contents: [revision] }] }] });
    vi.mocked(api.downloadFile).mockImplementation(async (_url, path) => { await writeFile(path, "complete"); });
    const identity = { baseUrl: site, userId: 7 };
    const first = await materializeFile(42, file.fileurl, file.filename, api, identity);
    revision.fileurl = `${file.fileurl}?token=second`;
    clearCourseCache(api);
    expect(await materializeFile(42, file.fileurl, file.filename, api, identity)).toBe(first);
    expect(api.downloadFile).toHaveBeenCalledOnce();
    revision.timemodified++;
    clearCourseCache(api);
    const updated = await materializeFile(42, file.fileurl, file.filename, api, identity);
    expect(updated).not.toBe(first);
    revision.filesize++;
    clearCourseCache(api);
    expect(await materializeFile(42, file.fileurl, file.filename, api, identity)).not.toBe(updated);
    expect(api.downloadFile).toHaveBeenCalledTimes(3);
    expect(api.downloadFile).toHaveBeenLastCalledWith(file.fileurl, expect.any(String), { atomic: false });
  });

  it("streams a production token-client download into the pinned destination", async () => {
    await home();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ modules: [{ id: 10, contents: [file] }] }])))
      .mockResolvedValueOnce(new Response("from-production-client")));
    const identity = { baseUrl: site, userId: 7 };
    const destination = await materializeFile(42, file.fileurl, file.filename, createTokenApiClient(site, "secret"), identity);
    expect(await readFile(destination, "utf8")).toBe("from-production-client");
  });

  it("uses the documented token endpoint for explicit downloads", async () => {
    await home();
    const fetchMock = vi.fn().mockResolvedValue(new Response("complete"));
    vi.stubGlobal("fetch", fetchMock);
    const destination = join(state.home, "download.pdf");
    await createTokenApiClient(`${site}/sdh`, "mobile").downloadFile(`${site}/sdh/pluginfile.php/1/a.pdf?forcedownload=1`, destination);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${site}/sdh/webservice/pluginfile.php/1/a.pdf?forcedownload=1&token=mobile`);
    expect(await readFile(destination, "utf8")).toBe("complete");
  });
});
