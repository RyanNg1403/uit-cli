import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { defaultApiClient } from "../src/api.js";
import { clearCourseCache, codexStatus, getCourseContents, getCourseGrades, listAnnouncements, listAssignments, listCourseParticipants, listCourses, login, lookupCourse, sessionStatus } from "../src/desktop-service.js";
import type { ApiClient } from "../src/types.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
beforeEach(() => { vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request"))); });
afterEach(() => { clearCourseCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("desktop service", () => {
  it("reports a structured local session status", () => {
    expect(sessionStatus()).toEqual(expect.objectContaining({ authenticated: expect.any(Boolean) }));
  });

  it("detects Codex without requiring a local installation", async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => { args.at(-1)(null, { stdout: "codex-cli 1.0", stderr: "" }); return undefined as any; });
    const status = await codexStatus();
    expect(status.installed).toBe(true);
    expect(status.version).toMatch(/codex/i);
  });

  it("reports a missing Codex installation", async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => { args.at(-1)(new Error("ENOENT")); return undefined as any; });
    await expect(codexStatus()).resolves.toMatchObject({ installed: false, message: expect.stringContaining("Install") });
  });

  it("rejects password/token login for the current SSO-only site", async () => {
    await expect(login({ username: "student", password: "not-used", baseUrl: "https://courses.uit.edu.vn" })).rejects.toThrow("requires UIT SSO");
  });

  it("normalizes assignments from the Moodle response", async () => {
    const call = vi.spyOn(defaultApiClient, "call").mockResolvedValue({
      courses: [{ id: 42, assignments: [{ id: 7, cmid: 8, name: "<b>Project</b>", intro: "<p>Build it</p>", duedate: 1_800_000_000 }] }]
    });
    const assignments = await listAssignments(42);
    expect(assignments).toMatchObject([{ id: 7, courseId: 42, moduleId: 8, name: "Project", description: "Build it", dueDate: 1_800_000_000, cutoffDate: undefined, allowsubmissionsfromdate: undefined, files: [] }]);
    expect(assignments[0]).not.toHaveProperty("intro");
    expect(assignments[0]).not.toHaveProperty("raw");
    expect(call).toHaveBeenCalledWith("mod_assign_get_assignments", { "courseids[0]": 42 });
    call.mockRestore();
  });

  it("routes course reads through an injected session client", async () => {
    const api = {
      call: vi.fn().mockResolvedValue([{ id: 42, shortname: "CS101", fullname: "<b>Programming</b>" }]),
      uploadFile: vi.fn(),
      downloadFile: vi.fn()
    } as unknown as ApiClient;
    const now = new Date().getUTCFullYear();
    await expect(listCourses(api, 77)).resolves.toMatchObject([{ id: 42, shortname: "CS101", fullname: "Programming", semester: { id: `${now}`, source: "current" } }]);
    expect(api.call).toHaveBeenCalledWith("core_enrol_get_users_courses", { userid: 77 });
  });

  it.each([807, 915])("looks up course %s using documented metadata and verifies access without asserting enrolment", async (id) => {
    const record = { id: String(id), shortname: "AI505.R11", fullname: "<b>Khoá luận tốt nghiệp - AI505.R11</b>", categoryname: "HK1 2025-2026", summary: "<p>Research</p>" };
    const call = vi.fn(async (name: string) => name === "core_course_get_courses_by_field" ? { courses: [record] } : name === "core_enrol_get_users_courses" ? [] : []);
    const api = { call } as unknown as ApiClient;
    const [first, concurrent] = await Promise.all([lookupCourse(id, api, 77), lookupCourse(id, api, 77)]);
    expect(first).toMatchObject({ id, fullname: "Khoá luận tốt nghiệp - AI505.R11", shortname: "AI505.R11", summary: "Research", discoveredVia: "url", semester: { id: "2025-2026-hk1", source: "category" } });
    expect(concurrent).toEqual(first);
    await expect(lookupCourse(id, api, 77)).resolves.toEqual(first);
    await getCourseContents(id, api);
    expect(call.mock.calls).toEqual([["core_course_get_courses_by_field", { field: "id", value: String(id) }], ["core_course_get_contents", { courseid: id }]]);
    expect(first).not.toHaveProperty("enrolled");
    await expect(listCourses(api, 77)).resolves.toEqual([]);
    clearCourseCache(api);
    await lookupCourse(id, api, 77);
    expect(call).toHaveBeenCalledTimes(5);
  });

  it.each([null, {}, { courses: [] }, { courses: [{ id: 808, fullname: "Other" }] }, { courses: [{ id: [807], fullname: "Other" }] }, { courses: [{ id: 807, fullname: "Title" }, { id: 808 }] }])("rejects missing, ambiguous or mismatched course metadata: %j", async (result) => {
    const api = { call: vi.fn().mockResolvedValue(result) } as unknown as ApiClient;
    await expect(lookupCourse(807, api, 77)).rejects.toThrow("requested course");
    expect(api.call).toHaveBeenCalledOnce();
  });

  it.each([undefined, {}, "", "<b> </b>", "Khoá luận...", "Khoá luận…"])("rejects missing or truncated API titles: %j", async (fullname) => {
    const api = { call: vi.fn().mockResolvedValue({ courses: [{ id: 807, fullname }] }) } as unknown as ApiClient;
    await expect(lookupCourse(807, api, 77)).rejects.toThrow("complete course title");
    expect(api.call).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid lookup identities %s before any request", async (id) => {
    const api = { call: vi.fn() } as unknown as ApiClient;
    await expect(lookupCourse(id, api, 77)).rejects.toThrow("identity");
    await expect(lookupCourse(807, api, id)).rejects.toThrow("identity");
    expect(api.call).not.toHaveBeenCalled();
  });

  it("does not expose metadata-only courses on access failure, retries failures and isolates clients", async () => {
    const record = { courses: [{ id: 807, fullname: "Verified title" }] };
    const call = vi.fn().mockResolvedValueOnce(record).mockRejectedValueOnce(new Error("Access denied")).mockResolvedValueOnce([]);
    const api = { call } as unknown as ApiClient;
    await expect(lookupCourse(807, api, 77)).rejects.toThrow("Access denied");
    await expect(lookupCourse(807, api, 77)).resolves.toMatchObject({ id: 807 });
    expect(call).toHaveBeenCalledTimes(3);
    const other = { call: vi.fn().mockRejectedValue(new Error("Session expired")) } as unknown as ApiClient;
    await expect(lookupCourse(807, other, 88)).rejects.toThrow("Session expired");
  });

  it("revalidates lookup metadata and access after the normal cache TTL", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const api = { call: vi.fn().mockResolvedValueOnce({ courses: [{ id: 807, fullname: "Title" }] }).mockResolvedValueOnce([]) } as unknown as ApiClient;
    await lookupCourse(807, api, 77);
    now.mockReturnValue(31_001);
    vi.mocked(api.call).mockRejectedValueOnce(new Error("Session expired"));
    await expect(lookupCourse(807, api, 77)).rejects.toThrow("Session expired");
    expect(api.call).toHaveBeenCalledTimes(3);
  });

  it("files a looked-up course without time evidence under the current year", async () => {
    const now = new Date().getUTCFullYear();
    const api = { call: vi.fn(async (name: string) => {
      if (name === "core_course_get_courses_by_field") return { courses: [{ id: 807, fullname: "Khoá luận tốt nghiệp - AI505.R11", shortname: "AI505.R11", categoryid: 7, categoryname: "Khoa học Máy tính" }] };
      return [];
    }) } as unknown as ApiClient;
    const course = await lookupCourse(807, api, 77);
    expect(course.semester).toEqual({ id: `${now}`, label: `${now}`, sortOrder: now * 10 + 9, source: "current" });
    expect(course.category).toMatchObject({ id: 7 });
  });

  it.each([null, {}, { warnings: [] }])("rejects malformed successful contents responses: %j", async (contents) => {
    const api = { call: vi.fn().mockResolvedValueOnce({ courses: [{ id: 807, fullname: "Title" }] }).mockResolvedValueOnce(contents) } as unknown as ApiClient;
    await expect(lookupCourse(807, api, 77)).rejects.toThrow("Invalid course contents");
  });

  it.each([undefined, null, "invalid", 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("keeps cmid-only assignments usable without inventing an instance: %s", async (id) => {
    const api = { call: vi.fn().mockResolvedValue({ courses: [{ id: 42, assignments: [{ id, cmid: 8, name: "Project", intro: "<p>Available intro</p>", unavailable: { instance: "Instance not exposed", details: "<b>Partial details</b>" } }] }] }) } as unknown as ApiClient;
    const [assignment] = await listAssignments(42, api);
    expect(assignment).toMatchObject({ id: undefined, moduleId: 8, resourceRef: { kind: "module", id: 8 }, description: "Available intro", unavailable: { instance: "Instance not exposed", details: "Partial details" } });
    expect(JSON.stringify(assignment)).not.toContain('"id":null');
  });

  it("keeps real assignment identity distinct from its module reference", async () => {
    const api = { call: vi.fn().mockResolvedValue({ courses: [{ id: 42, assignments: [{ id: "7", cmid: "8", name: "Project" }] }] }) } as unknown as ApiClient;
    await expect(listAssignments(42, api)).resolves.toMatchObject([{ id: 7, moduleId: 8, resourceRef: { kind: "assignment", id: 7, moduleId: 8 }, unavailable: undefined }]);
  });

  it.each([undefined, null, "invalid", 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("keeps a real assignment instance usable without a valid cmid: %s", async (cmid) => {
    const api = { call: vi.fn().mockResolvedValue({ courses: [{ id: 42, assignments: [{ id: 7, cmid, name: "Project" }] }] }) } as unknown as ApiClient;
    const [assignment] = await listAssignments(42, api);
    expect(assignment.id).toBe(7);
    expect(assignment.moduleId).toBeUndefined();
    expect(JSON.parse(JSON.stringify(assignment.resourceRef))).toEqual({ kind: "assignment", id: 7 });
  });

  it("supplies an explicit unavailable reason for cmid-only assignments without upstream errors", async () => {
    const api = { call: vi.fn().mockResolvedValue({ courses: [{ id: 42, assignments: [{ cmid: "8", name: "Project" }] }] }) } as unknown as ApiClient;
    const [assignment] = await listAssignments(42, api);
    expect(assignment.resourceRef).toEqual({ kind: "module", id: 8 });
    expect(assignment.unavailable).toEqual({ instance: "Assignment instance unavailable. Open the assignment on the course site for its full details." });
    expect(JSON.parse(JSON.stringify(assignment))).not.toHaveProperty("id");
  });

  it("rejects assignments with neither a real instance nor a module identity", async () => {
    const api = { call: vi.fn().mockResolvedValue({ courses: [{ id: 42, assignments: [{ name: "Project" }] }] }) } as unknown as ApiClient;
    await expect(listAssignments(42, api)).rejects.toThrow("Assignment identity unavailable. Open");
  });

  it.each([undefined, null, "invalid", 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("reads news discussions through the module when the instance ID is hidden: %s", async (id) => {
    const api = { call: vi.fn()
      .mockResolvedValueOnce([{ id, cmid: 9, type: "news", url: "https://courses.uit.edu.vn/mod/forum/view.php?id=9&sesskey=secret", unavailable: { instance: "Instance not exposed" } }])
      .mockResolvedValue({ discussions: [{ discussion: 4, subject: "Welcome", userfullname: "Lecturer", message: "<p>Hello</p>", numreplies: 2 }] }) } as unknown as ApiClient;
    await expect(listAnnouncements(42, api)).resolves.toMatchObject([{ id: 4, subject: "Welcome", moduleId: 9, forumId: undefined, replies: 2 }]);
    expect(api.call).toHaveBeenCalledWith("mod_forum_get_forum_discussions", { cmid: 9, page: 0, perpage: 100 });
    expect(JSON.stringify(await listAnnouncements(42, api))).not.toContain("sesskey");
  });

  it("reads forums by module when their HTML details and type are unavailable", async () => {
    const api = { call: vi.fn()
      .mockResolvedValueOnce([{ cmid: 9, unavailable: { details: "Activity unreadable" } }])
      .mockResolvedValue({ discussions: [] }) } as unknown as ApiClient;
    await expect(listAnnouncements(42, api)).resolves.toEqual([]);
    expect(api.call).toHaveBeenCalledWith("mod_forum_get_forum_discussions", { cmid: 9, page: 0, perpage: 100 });
  });

  it("uses the module identity when an unresolved forum also exposes an instance", async () => {
    const api = { call: vi.fn()
      .mockResolvedValueOnce([{ id: 12, cmid: 9, unavailable: { details: "Activity unreadable" } }])
      .mockResolvedValue({ discussions: [{ discussion: 4, subject: "Welcome" }] }) } as unknown as ApiClient;
    await expect(listAnnouncements(42, api)).resolves.toMatchObject([{ id: 4, moduleId: 9, forumId: 12 }]);
    expect(api.call).toHaveBeenCalledWith("mod_forum_get_forum_discussions", { cmid: 9, page: 0, perpage: 100 });
  });

  it("ignores known general forums and other courses even when their instances are missing", async () => {
    const api = { call: vi.fn().mockResolvedValue([{ cmid: 9, type: "general", unavailable: { instance: "Missing" } }, { cmid: 10, course: 43, type: "news", unavailable: { instance: "Missing" } }]) } as unknown as ApiClient;
    await expect(listAnnouncements(42, api)).resolves.toEqual([]);
    expect(api.call).toHaveBeenCalledOnce();
  });

  it("returns announcements from news forums, not general discussion forums", async () => {
    const call = vi.spyOn(defaultApiClient, "call").mockImplementation(async (name) => {
      if (name === "mod_forum_get_forums_by_courses") return [{ id: 11, cmid: 8, type: "general" }, { id: 12, cmid: 9, type: "news" }];
      return { discussions: [{ discussion: 4, subject: "Welcome", userfullname: "Lecturer", message: "<p>Hello</p>", numreplies: 2 }] };
    });
    await expect(listAnnouncements(42)).resolves.toMatchObject([{ id: 4, subject: "Welcome", author: "Lecturer", message: "Hello", timestamp: undefined, replies: 2, moduleId: 9, forumId: 12, files: [] }]);
    expect(call).toHaveBeenCalledWith("mod_forum_get_forum_discussions", { forumid: 12, page: 0, perpage: 100 });
    call.mockRestore();
  });

  it("lists course participants and maps roles cleanly", async () => {
    const api = {
      call: vi.fn().mockResolvedValue([
        { id: 101, fullname: "Alice Student", roles: [{ shortname: "student", name: "Student" }] },
        { id: 102, fullname: "Dr. Bob", roles: [{ shortname: "editingteacher", name: "Teacher" }] }
      ])
    } as unknown as ApiClient;
    const participants = await listCourseParticipants(42, api);
    expect(participants).toEqual([
      { id: 101, fullname: "Alice Student", roles: ["student"] },
      { id: 102, fullname: "Dr. Bob", roles: ["editingteacher"] }
    ]);
    expect(api.call).toHaveBeenCalledWith("core_enrol_get_enrolled_users", { courseid: 42 });
  });

  it("retrieves grade items and cleans up feedback HTML", async () => {
    const api = {
      call: vi.fn().mockResolvedValue({
        usergrades: [{
          courseid: 42,
          gradeitems: [
            { itemname: "Lab 1", gradeformatted: "9.5", grademax: 10, percentageformatted: "95 %", feedback: "<p>Great work!</p>" },
            { itemname: null, itemtype: "course", gradeformatted: "-", grademax: 100 }
          ]
        }]
      })
    } as unknown as ApiClient;
    const grades = await getCourseGrades(42, api, 101);
    expect(grades).toEqual([
      { item: "Lab 1", grade: "9.5", max: "10", percentage: "95 %", feedback: "Great work!" },
      { item: "Course total", grade: undefined, max: "100", percentage: undefined, feedback: undefined }
    ]);
    expect(api.call).toHaveBeenCalledWith("gradereport_user_get_grade_items", { courseid: 42, userid: 101 });
  });
});
