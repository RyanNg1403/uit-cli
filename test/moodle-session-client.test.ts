import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { MoodleSessionApi, buildAjaxInfo, unwrapAjaxResponse } from "../src/moodle-session-client.js";
import { NodeSessionApiClient } from "../src/api.js";
import { clearCourseCache, listCourses, lookupCourse, resolveCourseResource } from "../src/desktop-service.js";

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Moodle session API", () => {
  it("loads independent Node SSO timeline buckets concurrently", async () => {
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      active += 1;
      peak = Math.max(peak, active);
      const [{ methodname, args }] = JSON.parse(String(init.body));
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (methodname === "core_enrol_get_users_courses") {
        return Response.json([{ data: [{ id: 807, fullname: "Thesis" }] }]);
      }
      const id = ["allincludinghidden", "all", "inprogress", "past", "future", "hidden"].indexOf(args.classification) + 1;
      return Response.json([{ data: { courses: [{ id }] } }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new NodeSessionApiClient("https://courses.uit.edu.vn", "sesskey", "MoodleSession=cookie");

    await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual([
      { id: 807, fullname: "Thesis", categoryname: "" },
      ...Array.from({ length: 6 }, (_, index) => ({ id: index + 1, categoryname: "" }))
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls.every(([, init]) => init.signal instanceof AbortSignal)).toBe(true);
    expect(peak).toBe(7);
  });

  it("paginates Node SSO timeline buckets until their cursor is exhausted", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const [{ args }] = JSON.parse(String(init.body));
      if (!args.classification) return Response.json([{ data: [] }]);
      if (args.classification !== "all") return Response.json([{ data: { courses: [], nextoffset: -1 } }]);
      if (args.offset === 0) return Response.json([{ data: {
        courses: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
        nextoffset: "100"
      } }]);
      return Response.json([{ data: { courses: [{ id: 101 }], nextoffset: "-1" } }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new NodeSessionApiClient("https://courses.uit.edu.vn", "sesskey", "MoodleSession=cookie");

    await expect(api.call<any[]>("core_enrol_get_users_courses")).resolves.toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("treats an empty Node SSO page that echoes its offset as terminal", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const [{ args }] = JSON.parse(String(init.body));
      if (!args.classification) return Response.json([{ data: [] }]);
      if (args.classification !== "all") return Response.json([{ data: { courses: [], nextoffset: -1 } }]);
      if (args.offset === 0) return Response.json([{ data: { courses: [{ id: 1 }], nextoffset: 1 } }]);
      return Response.json([{ data: { courses: [], nextoffset: 1 } }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new NodeSessionApiClient("https://courses.uit.edu.vn", "sesskey", "MoodleSession=cookie");

    await expect(api.call<any[]>("core_enrol_get_users_courses")).resolves.toEqual([{ id: 1, categoryname: "" }]);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("propagates Node SSO authentication failures instead of returning an empty course list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json([{
      error: true,
      exception: { errorcode: "invalidsesskey", message: "Session expired; web service is not available" }
    }])));
    const api = new NodeSessionApiClient("https://courses.uit.edu.vn", "expired", "MoodleSession=old");

    await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow("Session expired");
  });

  it("reports unavailable Node SSO discovery when every timeline method is unsupported", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json([{
      error: true,
      exception: { errorcode: "servicenotavailable", message: "Unavailable" }
    }])));
    const api = new NodeSessionApiClient("https://courses.uit.edu.vn", "sesskey", "MoodleSession=cookie");

    await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow("Course discovery is unavailable");
  });

  it("does not hide Node SSO contents authentication failures behind HTML fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([{
      error: true,
      exception: { errorcode: "invalidsesskey", message: "Session expired" }
    }]));
    vi.stubGlobal("fetch", fetchMock);
    const api = new NodeSessionApiClient("https://courses.uit.edu.vn", "expired", "MoodleSession=old");

    await expect(api.call("core_course_get_contents", { courseid: 42 })).rejects.toThrow("Session expired");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("validates Node SSO HTML fallback pages and enriches resource files", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/lib/ajax/")) return Response.json([{
        error: true,
        exception: "moodle_exception",
        message: "Method is not available for AJAX"
      }]);
      if (url.includes("/course/view.php")) return new Response(`
        <body class="course-42"><div class="course-content"><ul>
          <li id="module-101" class="activity modtype_resource" data-activityname="Slides">
            <a class="aalink" href="/mod/resource/view.php?id=101">Slides</a>
          </li>
        </ul></div></body>
      `, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response('<div class="resourceworkaround"><a href="/pluginfile.php/1/mod_resource/content/0/slides.pdf">Slides</a></div>', {
        headers: { "content-type": "text/html" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new NodeSessionApiClient("https://courses.uit.edu.vn", "sesskey", "MoodleSession=cookie");

    const result = await api.call<any[]>("core_course_get_contents", { courseid: 42 });
    expect(result[0].modules).toMatchObject([{
      id: 101,
      modname: "resource",
      contents: [{ type: "file", filename: "slides.pdf", fileurl: "https://courses.uit.edu.vn/pluginfile.php/1/mod_resource/content/0/slides.pdf" }]
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a login page returned by the Node SSO contents fallback", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([{ error: true, exception: { errorcode: "servicenotavailable" } }]))
      .mockResolvedValueOnce(new Response('<form id="login"><input name="logintoken"></form>', { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new NodeSessionApiClient("https://courses.uit.edu.vn", "sesskey", "MoodleSession=expired");

    await expect(api.call("core_course_get_contents", { courseid: 42 })).rejects.toThrow("session expired");
  });

  it("resolves a forum course module from verified Node SSO pages when AJAX is unsupported", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/lib/ajax/")) {
        const [{ methodname, args }] = JSON.parse(String(init?.body));
        if (methodname === "core_course_get_course_module") {
          return Response.json([{ error: true, exception: { errorcode: "servicenotavailable" } }]);
        }
        if (methodname === "core_enrol_get_users_courses") return Response.json([{ data: [{ id: 42 }] }]);
        if (args.classification) return Response.json([{ data: { courses: [], nextoffset: 0 } }]);
      }
      if (url.includes("/course/view.php")) return new Response(`
        <body class="course-42"><div class="course-content"><ul>
          <li id="module-92" class="activity modtype_forum" data-activityname="Announcements">
            <a href="/mod/forum/view.php?id=92">Announcements</a>
          </li>
        </ul></div></body>
      `, { headers: { "content-type": "text/html" } });
      if (url.includes("/mod/forum/view.php")) return new Response(`
        <body id="page-mod-forum-view" class="forumtype-news">
          <script>M.cfg = {"courseId":42,"contextInstanceId":92};</script>
          <input type="hidden" name="forum" value="702">
        </body>
      `, { headers: { "content-type": "text/html" } });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new NodeSessionApiClient("https://courses.uit.edu.vn", "sesskey", "MoodleSession=cookie");

    await expect(api.call("core_course_get_course_module", { cmid: 92 })).resolves.toMatchObject({
      cm: { id: 92, course: 42, modname: "forum", instance: 702, type: "news" }
    });
  });

  it("scrapes verified assignment metadata when Node SSO AJAX is unsupported", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/lib/ajax/")) return Response.json([{
        error: true,
        exception: { errorcode: "servicenotavailable", message: "Unavailable" }
      }]);
      if (url.includes("/course/view.php")) return new Response(`
        <body class="course-42"><div class="course-content"><ul>
          <li id="module-91" class="activity modtype_assign" data-activityname="Project">
            <a class="aalink" href="/mod/assign/view.php?id=91">Project</a>
          </li>
        </ul></div></body>
      `, { headers: { "content-type": "text/html" } });
      return new Response(`
        <body id="page-mod-assign-view">
          <div data-assignmentid="701"></div>
          <div id="intro">Build the project <a href="/pluginfile.php/1/mod_assign/introattachment/0/spec.pdf">spec</a></div>
        </body>
      `, { headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new NodeSessionApiClient("https://courses.uit.edu.vn", "sesskey", "MoodleSession=cookie");

    const result = await api.call<any>("mod_assign_get_assignments", { "courseids[0]": 42 });
    expect(result.courses[0].assignments).toMatchObject([{
      id: 701,
      cmid: 91,
      name: "Project",
      duedate: 0,
      introattachments: [{ filename: "spec.pdf" }]
    }]);
  });

  it("does not parse the participants table header as a user in the Node fallback", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/lib/ajax/")) return Response.json([{
        error: true,
        exception: { errorcode: "servicenotavailable", message: "Unavailable" }
      }]);
      return new Response(`
        <table id="participants" class="generaltable">
          <thead><tr><th class="header c1"><a href="/user/index.php?id=42">Họ</a></th></tr></thead>
          <tbody><tr>
            <td class="cell c0"><input id="user101" type="checkbox" /></td>
            <td class="cell c1"><a href="/user/view.php?id=101&course=42">Alice Student</a></td>
            <td class="cell c2">Học viên</td>
          </tr></tbody>
        </table>
      `, { headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new NodeSessionApiClient("https://courses.uit.edu.vn", "sesskey", "MoodleSession=cookie");

    await expect(api.call("core_enrol_get_enrolled_users", { courseid: 42 })).resolves.toEqual([
      { id: 101, fullname: "Alice Student", roles: [{ shortname: "học viên", name: "Học viên" }] }
    ]);
  });

  it("normalizes Moodle bracket-array arguments for AJAX", () => {
    expect(JSON.parse(buildAjaxInfo("mod_assign_get_assignments", { "courseids[0]": 42, "courseids[2]": 99 }))).toEqual([
      { index: 0, methodname: "mod_assign_get_assignments", args: { courseids: [42, null, 99] } }
    ]);
  });

  it("normalizes nested Moodle bracket paths for AJAX", () => {
    expect(JSON.parse(buildAjaxInfo("core_user_get_users", {
      "criteria[0][key]": "email",
      "criteria[0][value]": "student@uit.edu.vn",
      "preferences[2][name]": "theme"
    }))).toEqual([{
      index: 0,
      methodname: "core_user_get_users",
      args: {
        criteria: [{ key: "email", value: "student@uit.edu.vn" }],
        preferences: [null, null, { name: "theme" }]
      }
    }]);
  });

  it("unwraps Moodle AJAX errors", () => {
    expect(unwrapAjaxResponse([{ error: false, data: { ok: true } }])).toEqual({ ok: true });
    expect(() => unwrapAjaxResponse([{ error: true, exception: "required_capability_exception" }])).toThrow("required_capability_exception");
  });

  it.each([
    [{ error: true, exception: { errorcode: "servicenotavailable", message: "Localized service unavailable" } }],
    [{ error: true, errorcode: "servicenotavailable", exception: "moodle_exception", message: "Localized service unavailable" }],
    { error: "Localized service unavailable", errorcode: "servicenotavailable", exception: "moodle_exception" }
  ])("preserves Moodle error codes from nested and request-wide exceptions: %j", (response) => {
    try { unwrapAjaxResponse(response); throw new Error("Expected Moodle exception"); }
    catch (error) { expect(error).toHaveProperty("errorcode", "servicenotavailable"); }
  });

  it("evaluates the generated script to send one JSON array with Moodle's actual field shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ data: { courses: [], nextoffset: 0 } }])));
    vi.stubGlobal("fetch", fetchMock);
    const api = new MoodleSessionApi("https://moodle.example", "fixture-key", {
      execute: (script) => new Function(`return ${script}`)(), cookieHeader: vi.fn()
    });
    await api.call("core_course_get_enrolled_courses_by_timeline_classification", { classification: "all", limit: 100, offset: 0 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual([
      { index: 0, methodname: "core_course_get_enrolled_courses_by_timeline_classification", args: { classification: "all", limit: 100, offset: 0 } }
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "include", redirect: "error", headers: { "Content-Type": "application/json" } });
  });

  it("executes authenticated AJAX calls in the browser session", async () => {
    const execute = vi.fn().mockResolvedValue([{ error: false, data: [{ id: 42 }] }]);
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "sess-123", {
      execute,
      cookieHeader: vi.fn().mockResolvedValue("MoodleSession=abc")
    });
    await expect(api.call("core_course_get_contents", { courseid: 42 })).resolves.toEqual([{ id: 42 }]);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toContain("/lib/ajax/service.php?sesskey=sess-123");
    expect(execute.mock.calls[0][0]).toContain('"Content-Type":"application/json"');
    expect(execute.mock.calls[0][0]).toContain('body:JSON.stringify([{"index":0');
    expect(execute.mock.calls[0][0]).toContain("core_course_get_contents");
  });

  it("uses an AJAX-compatible course listing when the mobile-only method is unavailable", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{ error: true, exception: "invalid_parameter_exception", message: "Unknown method" }])
      .mockResolvedValueOnce([{ error: false, data: { courses: [{ id: 42, fullname: "Programming" }] } }])
      .mockResolvedValue([{ data: { courses: [] } }]);
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "sess-123", {
      execute,
      cookieHeader: vi.fn().mockResolvedValue("")
    });
    await expect(api.call("core_enrol_get_users_courses", { userid: 77 })).resolves.toEqual([{ id: 42, fullname: "Programming" }]);
    expect(execute).toHaveBeenCalledTimes(7);
    expect(execute.mock.calls[1][0]).toContain('"classification":"allincludinghidden"');
  });

  it("does not log an unsupported enrolment method as an error when timeline discovery succeeds", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{ error: true, exception: { errorcode: "servicenotavailable", message: "Unavailable" } }])
      .mockResolvedValueOnce([{ data: { courses: [{ id: 807, fullname: "Thesis" }], nextoffset: 0 } }])
      .mockResolvedValue([{ data: { courses: [], nextoffset: 0 } }]);
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "fixture-key", { execute, cookieHeader: vi.fn() });
    await expect(api.call("core_enrol_get_users_courses", { userid: 77 })).resolves.toEqual([{ id: 807, fullname: "Thesis" }]);
    expect(console.error).not.toHaveBeenCalled();
    expect(api.getCourseDiscoveryDiagnostics().sources[0]).toMatchObject({ status: "unsupported", message: "servicenotavailable: Source is not available through session AJAX." });
  });

  it("still rejects discovery when every source is unsupported", async () => {
    const execute = vi.fn().mockResolvedValue([{ error: true, exception: { errorcode: "servicenotavailable" } }]);
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "fixture-key", { execute, cookieHeader: vi.fn() });
    await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow("Course discovery is unavailable");
    expect(api.getCourseDiscoveryDiagnostics().sources).toHaveLength(7);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("continues logging and propagating real authentication failures", async () => {
    const execute = vi.fn().mockResolvedValue([{ error: true, exception: { errorcode: "invalidsesskey", message: "Session expired" } }]);
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "fixture-key", { execute, cookieHeader: vi.fn() });
    await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow("Session expired");
    expect(console.error).toHaveBeenCalledWith("[MoodleSessionApi] AJAX request failed: invalidsesskey: Session authentication failed; sign in again.");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects downloads outside the UIT site origin", async () => {
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "sess-123", {
      execute: vi.fn(),
      cookieHeader: vi.fn().mockResolvedValue("")
    });
    await expect(api.downloadFile("https://evil.example/file.pdf", "/tmp/file.pdf")).rejects.toThrow("another origin");
  });

  it("unions every timeline bucket and follows pagination", async () => {
    const execute = vi.fn(async (script: string) => {
      if (script.includes('"core_enrol_get_users_courses"') || script.includes('"classification":"allincludinghidden"')) return [{ error: true, exception: "invalid_parameter_exception" }];
      const classification = /"classification":"([^"]+)"/.exec(script)![1];
      const offset = Number(/"offset":(\d+)/.exec(script)![1]);
      const ids: Record<string, number[]> = { all: [1], inprogress: [1, 2], future: [3], past: [4], hidden: [5] };
      return [{ data: { courses: (offset ? [6] : ids[classification]).map((id) => ({ id })), nextoffset: classification === "past" && !offset ? 1 : 0 } }];
    });
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "key", { execute, cookieHeader: vi.fn() });
    const courses = await api.call("core_enrol_get_users_courses");
    expect(courses.map((course: any) => course.id).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(execute).toHaveBeenCalledTimes(8);
  });

  it.each([{}, { cmid: 0 }, { cmid: -1 }, { forumid: 0, cmid: 9 }])("rejects forum discussion reads without a usable identity: %j", async (params) => {
    const execute = vi.fn().mockResolvedValue([{ error: true, exception: "invalid_parameter_exception" }]);
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "key", { execute, cookieHeader: vi.fn() });
    await expect(api.call("mod_forum_get_forum_discussions", params)).rejects.toThrow("Invalid forum");
    // Only the AJAX probe runs; no page is fetched without an identity.
    expect(execute).toHaveBeenCalledOnce();
  });

  it("propagates permission and network errors without HTML fallback", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("permission denied"));
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "key", { execute, cookieHeader: vi.fn() });
    await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow("permission denied");
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["requireloginerror", "nopermissions", "required_capability_exception", "ex_unabletolock"])("does not fall back from course lookup on %s", async (errorcode) => {
    const execute = vi.fn().mockResolvedValue([{ error: true, exception: { errorcode, message: "webservice is not available" } }]);
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "key", { execute, cookieHeader: vi.fn() });
    await expect(api.call("core_course_get_courses_by_field", { field: "id", value: "807" })).rejects.toThrow();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("uses supported lookup AJAX metadata and still enforces course contents access", async () => {
    const execute = vi.fn().mockResolvedValueOnce([{ data: { courses: [{ id: 807, fullname: "Actual API title" }] } }])
      .mockResolvedValueOnce([{ error: true, exception: { errorcode: "nopermissions", message: "Access denied" } }]);
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "key", { execute, cookieHeader: vi.fn() });
    await expect(lookupCourse(807, api, 77)).rejects.toThrow("Access denied");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toContain('"args":{"field":"id","value":"807"}');
    expect(execute.mock.calls[1][0]).toContain('"methodname":"core_course_get_contents"');
  });

  it.each([{ field: "shortname", value: "807" }, { field: "id", value: "807&redirect=1" }, { field: "id", value: "-1" }, { field: "id", value: "9007199254740992" }])("never fetches a page for unsupported lookup parameters: %j", async (params) => {
    const execute = vi.fn().mockResolvedValue([{ error: true, exception: "servicenotavailable" }]);
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "key", { execute, cookieHeader: vi.fn() });
    await expect(api.call("core_course_get_courses_by_field", params)).rejects.toThrow();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects partial course bucket results when a required bucket fails", async () => {
    const execute = vi.fn(async (script: string) => {
      if (script.includes('"core_enrol_get_users_courses"') || script.includes('"classification":"allincludinghidden"')) return [{ error: true, exception: "invalid_parameter_exception" }];
      if (script.includes('"classification":"past"')) throw new Error("network offline");
      return [{ data: { courses: [{ id: 42 }] } }];
    });
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "key", { execute, cookieHeader: vi.fn() });
    await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow("network offline");
  });

  it("reads authenticated files and rejects credential-leaking redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("hello", { headers: { "content-type": "text/plain" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://evil.example/file" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new MoodleSessionApi("https://courses.uit.edu.vn", "key", { execute: vi.fn(), cookieHeader: vi.fn().mockResolvedValue("MoodleSession=secret") });
    const file = await api.readFile("/pluginfile.php/1/a.txt");
    expect(Buffer.from(file.data).toString()).toBe("hello");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual", headers: { Cookie: "MoodleSession=secret" } });
    await expect(api.readFile("/pluginfile.php/2/a.txt")).rejects.toThrow("another origin");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Moodle course reconciliation", () => {
  const classifications = ["allincludinghidden", "all", "inprogress", "future", "past", "hidden"];
  const unsupported = { error: true, exception: "invalid_parameter_exception" };
  const setup = (reply: (classification: string, offset: number) => any) => {
    const execute = vi.fn(async (script: string) => {
      expect(script).toContain("/lib/ajax/service.php");
      const classification = /"classification":"([^"]+)"/.exec(script)?.[1] || "primary";
      const offset = Number(/"offset":(\d+)/.exec(script)?.[1] || 0);
      return [reply(classification, offset)];
    });
    return { execute, api: new MoodleSessionApi("https://courses.uit.edu.vn", "fixture-key", { execute, cookieHeader: vi.fn() }) };
  };

  it.each(classifications.flatMap((bucket) => [false, true].map((partial) => ({ bucket, partial }))))(
    "finds a thesis only in $bucket with primary partial=$partial even when aggregates succeed",
    async ({ bucket, partial }) => {
      const primary = partial ? [{ id: 1, fullname: "Existing course" }] : [];
      const thesis = { id: 42, fullname: "Graduation thesis" };
      const { api, execute } = setup((classification) => ({ data: classification === "primary" ? primary : {
        courses: classification === bucket ? [thesis] : primary
      } }));
      await expect(api.call("core_enrol_get_users_courses", { userid: 77 })).resolves.toEqual([...primary, thesis]);
      expect(execute).toHaveBeenCalledTimes(7);
      expect(execute.mock.calls[0][0]).toContain('"userid":77');
      expect(execute.mock.calls.slice(1).map(([script]) => /"classification":"([^"]+)"/.exec(script)![1])).toEqual(classifications);
    }
  );

  it("merges metadata across sources and duplicate pages without replacing rich fields with blanks", async () => {
    const primary = { id: 42, fullname: "Graduation thesis", shortname: "", summary: null, progress: 0, visible: false, overviewfiles: [] };
    const { api } = setup((classification, offset) => {
      if (classification === "primary") return { data: [primary] };
      if (classification === "allincludinghidden") return { data: { courses: [{ id: "42", fullname: "", shortname: "THESIS", summary: "Research project", progress: null, visible: true, overviewfiles: [{ filename: "cover.png" }] }], nextoffset: 0 } };
      if (classification === "future") return { data: { courses: [{ id: 42, summary: " ", startdate: 1800000000, ...(offset ? { categoryname: "Research", overviewfiles: [] } : {}) }], nextoffset: offset ? 0 : 100 } };
      return { data: { courses: [{ id: 42, fullname: null, shortname: "", enddate: 1900000000 }] } };
    });
    await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual([{
      id: 42, fullname: "Graduation thesis", shortname: "THESIS", summary: "Research project", progress: 0,
      visible: false, overviewfiles: [{ filename: "cover.png" }], startdate: 1800000000, enddate: 1900000000, categoryname: "Research"
    }]);
    expect(primary).toEqual({ id: 42, fullname: "Graduation thesis", shortname: "", summary: null, progress: 0, visible: false, overviewfiles: [] });
  });

  it.each(["invalid_parameter_exception", "invalidparameter", "servicenotavailable", "invalidfunction", "cannotfindfunction", "wsfunctionnotavailable"])(
    "retains primary courses when timeline is unavailable (%s)", async (errorcode) => {
      const primary = [{ id: 42, fullname: "Thesis", summary: "", progress: null }];
      const { api } = setup((classification) => classification === "primary" ? { data: primary } : { error: true, exception: { errorcode, message: "Unsupported" } });
      await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual(primary);
    }
  );

  it.each(["allincludinghidden", "all", "inprogress", "future", "past", "hidden"])(
    "uses supported sources when %s is unsupported", async (missing) => {
      const { api } = setup((classification) => classification === "primary" || classification === missing ? unsupported : { data: { courses: [{ id: 42 }] } });
      await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual([{ id: 42 }]);
    }
  );

  it("replays the launch log's nested servicenotavailable error and records the successful timeline source", async () => {
    const { api } = setup((classification) => classification === "primary"
      // Same envelope/code as desktop-launch.log:13; private response fields omitted.
      ? { error: true, exception: { message: "Localized service unavailable", errorcode: "servicenotavailable" } }
      : { data: { courses: classification === "inprogress" ? [{ id: 42, fullname: "Private thesis title" }] : [], nextoffset: 0 } });
    expect(api.getCourseDiscoveryDiagnostics()).toEqual({ sources: [], total: 0, checkedAt: "" });
    await expect(api.call("core_enrol_get_users_courses")).resolves.toHaveLength(1);
    const diagnostics = api.getCourseDiscoveryDiagnostics();
    expect(diagnostics.sources).toHaveLength(7);
    expect(diagnostics.sources[0]).toEqual({ source: "core_enrol_get_users_courses", status: "unsupported", count: 0, pages: 0, message: "servicenotavailable: Source is not available through session AJAX." });
    expect(diagnostics.sources[3]).toEqual({ source: "timeline:inprogress", status: "ok", count: 1, pages: 1 });
    expect(diagnostics.total).toBe(1);
    expect(Number.isFinite(Date.parse(diagnostics.checkedAt))).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toMatch(/Private thesis|fullname|fixture-key|https:|"id"/);
    diagnostics.sources[0].message = "mutated";
    expect(api.getCourseDiscoveryDiagnostics().sources[0].message).not.toBe("mutated");
  });

  it.each([undefined, "moodle_exception", "webservice_exception"])("recognizes the English webservice-unavailable message with exception %s without swallowing explicit auth codes", async (exception) => {
    const { api } = setup((classification) => classification === "primary"
      ? { error: true, exception, message: "The webservice is not available (it doesn't exist or might be disabled)" }
      : { data: { courses: [{ id: 42 }] } });
    await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual([{ id: 42 }]);
    const auth = setup(() => ({ error: true, exception: { errorcode: "servicerequireslogin", message: "webservice is not available" } }));
    await expect(auth.api.call("core_enrol_get_users_courses")).rejects.toThrow();
    expect(auth.execute).toHaveBeenCalledOnce();
    expect(auth.api.getCourseDiscoveryDiagnostics().sources[0]).toMatchObject({ status: "error", message: "servicerequireslogin: Session authentication failed; sign in again." });
  });

  it("counts unique valid courses per source, successful pages, and the deduplicated total", async () => {
    const { api } = setup((classification, offset) => ({ data: classification === "primary" ? [{ id: 1 }] : {
      courses: [{ id: 1 }, { id: "42" }, { id: 42 }, { id: 0 }, null], nextoffset: offset ? 0 : 100
    } }));
    await api.call("core_enrol_get_users_courses");
    expect(api.getCourseDiscoveryDiagnostics()).toMatchObject({ total: 2, sources: [
      { source: "core_enrol_get_users_courses", status: "ok", count: 1, pages: 1 },
      ...classifications.map((classification) => ({ source: `timeline:${classification}`, status: "ok", count: 2, pages: 2 }))
    ] });
  });

  it("never copies raw Moodle details or unknown codes into logs or diagnostics, and resets each discovery", async () => {
    let fail = true;
    const secret = "https://private.example/course?id=999&sesskey=secret Cookie=MoodleSession=secret Private thesis";
    const { api } = setup((classification) => {
      if (classification === "hidden" && fail) return { error: true, errorcode: secret, message: secret, debuginfo: secret };
      return { data: classification === "primary" ? [{ id: 42, fullname: secret }] : { courses: [] } };
    });
    await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow();
    expect(api.getCourseDiscoveryDiagnostics()).toMatchObject({ total: 1, sources: expect.arrayContaining([{ source: "timeline:hidden", status: "error", count: 0, pages: 0, message: "requestfailed: Source could not be read; discovery may be incomplete." }]) });
    expect(JSON.stringify([api.getCourseDiscoveryDiagnostics(), vi.mocked(console.error).mock.calls])).not.toMatch(/private\.example|sesskey|Cookie|Private thesis|999/);
    fail = false;
    await api.call("core_enrol_get_users_courses");
    expect(api.getCourseDiscoveryDiagnostics().sources).toHaveLength(7);
    expect(api.getCourseDiscoveryDiagnostics().sources.every((source) => source.status === "ok" && !source.message)).toBe(true);
  });

  it("reports unavailable discovery rather than inventing courses when no method is supported", async () => {
    const { api, execute } = setup(() => unsupported);
    await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow("neither enrolment nor timeline");
    expect(execute).toHaveBeenCalledTimes(7);
    expect(api.getCourseDiscoveryDiagnostics().total).toBe(0);
    expect(api.getCourseDiscoveryDiagnostics().sources.every((source) => source.status === "unsupported")).toBe(true);
  });

  it.each([false, true])("returns a genuinely empty primary list with timeline unavailable=%s", async (missing) => {
    const { api } = setup((classification) => classification !== "primary" && missing ? unsupported : { data: classification === "primary" ? [] : { courses: [] } });
    await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual([]);
  });

  it("only returns courses with real positive safe integer IDs", async () => {
    const { api } = setup((classification) => ({ data: classification === "primary" ? [] : { courses: [
      null, {}, { fullname: "Thesis" }, ...[null, true, [], {}, "", "bad", 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1].map((id) => ({ id })), { id: "42" }
    ] } }));
    await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual([{ id: 42 }]);
  });

  it.each(["allincludinghidden", "future", "hidden"])("continues sparse empty pages with advancing cursors in %s", async (bucket) => {
    const offsets: number[] = [];
    const { api } = setup((classification, offset) => {
      if (classification === "primary") return { data: [] };
      if (classification !== bucket) return { data: { courses: [] } };
      offsets.push(offset);
      return { data: { courses: offset === 200 ? [{ id: 42, fullname: "Thesis" }] : [], nextoffset: offset < 200 ? String(offset + 100) : -1 } };
    });
    await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual([{ id: 42, fullname: "Thesis" }]);
    expect(offsets).toEqual([0, 100, 200]);
  });

  it.each(["array", "missing", "null"])("paginates full %s pages using the raw entry count, not unique IDs", async (shape) => {
    const offsets: number[] = [];
    const { api } = setup((classification, offset) => {
      if (classification === "primary") return { data: [] };
      if (classification !== "hidden") return { data: { courses: [] } };
      offsets.push(offset);
      const courses = offset === 0 ? Array.from({ length: 100 }, () => ({ id: 1 })) : [{ id: 42 }];
      return { data: shape === "array" ? courses : { courses, ...(shape === "null" ? { nextoffset: null } : {}) } };
    });
    await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual([{ id: 1 }, { id: 42 }]);
    expect(offsets).toEqual([0, 100]);
  });

  it.each([0, -1, "0", "-1"])("honors terminal cursor %s even on a full page", async (nextoffset) => {
    const { api, execute } = setup((classification) => ({ data: classification === "primary" ? [] : { courses: Array.from({ length: 100 }, () => ({ id: 42 })), nextoffset } }));
    await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual([{ id: 42 }]);
    expect(execute).toHaveBeenCalledTimes(7);
  });

  it.each([3, "3"])("retains thesis 807 when the empty final page echoes offset %s", async (terminal) => {
    const thesis = { id: 807, fullname: "Khoá luận tốt nghiệp - AI505.R11" };
    const offsets: number[] = [];
    const { api, execute } = setup((classification, offset) => {
      if (classification === "primary") return unsupported;
      if (classification !== "allincludinghidden") return { data: { courses: [], nextoffset: 0 } };
      offsets.push(offset);
      return { data: { courses: offset === 0 ? [{ id: 1 }, { id: 2 }, thesis] : [], nextoffset: offset === 0 ? 3 : terminal } };
    });
    await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual([{ id: 1 }, { id: 2 }, thesis]);
    expect(offsets).toEqual([0, 3]);
    expect(execute).toHaveBeenCalledTimes(8);
    expect(api.getCourseDiscoveryDiagnostics().sources[1]).toMatchObject({ status: "ok", count: 3, pages: 2 });
  });

  it.each([1, 100, 203])("accepts an empty final page at offset %i and still checks later buckets", async (last) => {
    const { api } = setup((classification, offset) => {
      if (classification === "primary") return { data: [] };
      if (classification === "hidden") return { data: { courses: [{ id: 807 }], nextoffset: 0 } };
      return { data: { courses: offset ? [] : [{ id: 1 }], nextoffset: last } };
    });
    await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual([{ id: 1 }, { id: 807 }]);
  });

  it.each([100, 50, -2, 100.5, "garbage", "", true, [], {}, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid or non-advancing cursor %j rather than returning partial courses", async (cursor) => {
      const { api, execute } = setup((classification, offset) => ({ data: classification === "primary" ? [{ id: 1 }] : { courses: [{ id: 42 }], nextoffset: offset ? cursor : 100 } }));
      await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow("Invalid or non-advancing course pagination");
      expect(execute).toHaveBeenCalledTimes(3);
    }
  );

  it("bounds endless advancing pagination", async () => {
    const { api, execute } = setup((classification, offset) => ({ data: classification === "primary" ? [] : { courses: [], nextoffset: offset + 100 } }));
    await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow("safety limit");
    expect(execute).toHaveBeenCalledTimes(1001);
  });

  it.each(["primary", "allincludinghidden", "hidden"])("propagates authentication errors in %s despite other successful sources", async (bucket) => {
    const { api } = setup((classification) => classification === bucket
      ? { error: true, exception: { errorcode: "requireloginerror", message: "Session expired; sign in again" } }
      : { data: classification === "primary" ? [{ id: 1 }] : { courses: [{ id: 42 }] } });
    await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow("Session expired; sign in again");
  });

  it.each(["network", "unsupported"])("handles %s failures after a successful bucket page", async (failure) => {
    const { api } = setup((classification, offset) => {
      if (classification === "primary") return { data: [{ id: 1 }] };
      if (offset) {
        if (failure === "network") throw new Error("network offline");
        return unsupported;
      }
      return { data: { courses: [{ id: 42 }], nextoffset: 100 } };
    });
    if (failure === "network") {
      await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow("Course discovery failed for allincludinghidden at offset 100");
    } else {
      await expect(api.call("core_enrol_get_users_courses")).resolves.toEqual([{ id: 1 }, { id: 42 }]);
      expect(api.getCourseDiscoveryDiagnostics().sources.slice(1)).toEqual(classifications.map((classification) => ({
        source: `timeline:${classification}`, status: "unsupported", count: 1, pages: 1,
        message: "invalid_parameter_exception: Source rejected the request parameters."
      })));
    }
  });

  it.each([null, {}, { courses: null }, { courses: "bad" }])("rejects malformed successful timeline responses: %j", async (data) => {
    const { api } = setup((classification) => ({ data: classification === "primary" ? [{ id: 1 }] : data }));
    await expect(api.call("core_enrol_get_users_courses")).rejects.toThrow("invalid course list");
  });

  it("reuses the existing service cache for concurrent and repeated discovery, and retries failed discovery", async () => {
    let offline = true;
    const { api, execute } = setup((classification) => {
      if (classification === "hidden" && offline) throw new Error("network offline");
      return { data: classification === "primary" ? [] : { courses: classification === "hidden" ? [{ id: 42, fullname: "Thesis" }] : [] } };
    });
    await expect(listCourses(api, 77)).rejects.toThrow("network offline");
    offline = false;
    const [first, concurrent] = await Promise.all([listCourses(api, 77), listCourses(api, 77)]);
    expect(first).toMatchObject([{ id: 42, fullname: "Thesis" }]);
    expect(concurrent).toEqual(first);
    await expect(listCourses(api, 77)).resolves.toEqual(first);
    expect(execute).toHaveBeenCalledTimes(14);
    clearCourseCache(api);
    await expect(listCourses(api, 77)).resolves.toEqual(first);
    expect(execute).toHaveBeenCalledTimes(21);
  });
});

describe("Moodle HTML fallbacks with real DOM parsing", () => {
  const origin = "https://courses.uit.edu.vn";
  let browser: Browser;
  let page: Page;
  let api: MoodleSessionApi;
  let pages: Record<string, string | { body: string; status?: number; headers?: Record<string, string> }>;
  let requests: { url: string; method?: string; credentials?: string; redirect?: string; timeout: number }[];

  const course = (modules: [number, string, string][]) => `<div class="course-content" data-courseid="42"><ul><li class="section"><h3 class="sectionname">Week 1</h3><ul>${modules.map(([id, type, name]) => `<li id="module-${id}" class="activity modtype_${type}" data-id="${id}"><a class="aalink" href="../mod/${type}/view.php?id=${id}"><span class="instancename">${name}<span class="accesshide"> ${type}</span></span></a><div class="activity-description">Course description</div></li>`).join("")}</ul></li></ul></div>`;
  const activity = (id: number, type: string, body: string, extra = "") => `<body id="page-mod-${type}-view" class="${extra}"><script>M.cfg = {"courseId":42,"contextid":9000,"contextInstanceId":${id}};</script><div class="page-header-headings"><h1>Activity ${id}</h1></div>${body}</body>`;

  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.route("**/*", (route) => route.abort());
    pages = {};
    requests = [];
    await page.exposeFunction("fixtureFetch", (url: string, options: any, timeout: number) => {
      requests.push({ url, method: options.method, credentials: options.credentials, redirect: options.redirect, timeout });
      const parsed = new URL(url);
      if (parsed.pathname === "/lib/ajax/service.php") {
        const [{ methodname }] = JSON.parse(options.body);
        const data = methodname === "core_course_get_enrolled_courses_by_timeline_classification"
          ? [{ data: { courses: [{ id: 42 }], nextoffset: 0 } }]
          : [{ error: true, exception: { errorcode: "servicenotavailable", message: "Not available for AJAX" } }];
        return { body: JSON.stringify(data), headers: { "content-type": "application/json" } };
      }
      const fixture = pages[parsed.pathname + parsed.search];
      if (fixture === undefined) throw new Error(`Unexpected page fetch: ${url}`);
      return typeof fixture === "string" ? { body: fixture, headers: { "content-type": "text/html; charset=utf-8" } } : fixture;
    });
    await page.evaluate(() => {
      const timeouts = new WeakMap<AbortSignal, number>();
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = (ms) => { const signal = timeout(ms); timeouts.set(signal, ms); return signal; };
      window.fetch = async (url, options) => {
        const fixture = await (window as any).fixtureFetch(String(url), options, timeouts.get(options?.signal as AbortSignal) || 0);
        return new Response(fixture.body, { status: fixture.status || 200, headers: fixture.headers });
      };
    });
    api = new MoodleSessionApi(origin, "fixture-key", { execute: (script) => page.evaluate(script), cookieHeader: vi.fn() });
  });
  afterEach(async () => { await page.close(); });

  it.each(['class="course-807"', 'id="course-807"', 'data-courseid="807"'])("verifies the exact course 807 title and content with body %s", async (identity) => {
    pages["/course/view.php?id=807"] = `<body ${identity}><div id="page-header"><h1>Khoá luận tốt nghiệp - AI505.R11</h1><ol class="breadcrumb"><li><a href="/course/view.php?id=808">Wrong breadcrumb</a></li><li><a href="/course/view.php?id=807">AI505.R11</a></li></ol></div><div class="course-content"></div><script>window.fixtureCodeExecuted=true;</script></body>`;
    await expect(lookupCourse(807, api, 77)).resolves.toMatchObject({ id: 807, fullname: "Khoá luận tốt nghiệp - AI505.R11", shortname: "AI505.R11", discoveredVia: "url" });
    const count = requests.length;
    await lookupCourse(807, api, 77);
    expect(requests).toHaveLength(count);
    expect(requests.filter((request) => !request.url.includes("/lib/ajax/")).map((request) => request.url)).toEqual([`${origin}/course/view.php?id=807`, `${origin}/course/view.php?id=807`]);
    expect(requests.every((request) => request.credentials === "include" && request.redirect === "error" && request.timeout === 30000)).toBe(true);
    expect(await page.evaluate(() => (window as any).fixtureCodeExecuted)).toBeUndefined();
  });

  it("uses actual headings for any course ID without guessing a title or shortname", async () => {
    pages["/course/view.php?id=915"] = '<body class="course-915"><div class="page-header-headings"><h1>Independent research &amp; practice</h1></div><li class="section"><li class="activity">Module</li></li></body>';
    await expect(lookupCourse(915, api, 77)).rejects.toThrow("contents");
    pages["/course/view.php?id=915"] = '<body class="course-915"><div class="page-header-headings"><h1>Independent research &amp; practice</h1></div><div data-region="section"><ul><li class="activity">Module</li></ul></div></body>';
    await expect(lookupCourse(915, api, 77)).resolves.toMatchObject({ id: 915, fullname: "Independent research & practice", shortname: "" });
  });

  it.each([
    ['mismatched body', '<body class="course-808"><div data-courseid="807"></div>', 'different or unverified'],
    ['mismatched data', '<body data-courseid="808">', 'different or unverified'],
    ['no identity', '<body>', 'different or unverified'],
    ['enrolment', '<body id="page-enrol-index" class="course-807">', 'enrolment'],
    ['enrolment form', '<body class="course-807"><form action="/enrol/index.php"></form>', 'enrolment'],
    ['guest', '<body class="course-807 guestuser">', 'not authenticated'],
    ['logged out', '<body class="course-807 notloggedin">', 'not authenticated'],
    ['guest login link', '<body class="course-807"><a href="/login/index.php">Log in</a>', 'not authenticated'],
    ['login', '<body class="course-807"><input name="logintoken">', 'session expired'],
    ['permission', '<body class="course-807"><div class="alert-danger">Denied</div>', 'denied access'],
    ['error', '<body class="course-807"><div class="errorbox">Error</div>', 'could not display']
  ])("rejects %s pages even with an exact title and apparent content", async (_name, body, error) => {
    pages["/course/view.php?id=807"] = `${body}<div id="page-header"><h1>Khoá luận tốt nghiệp - AI505.R11</h1></div><div class="course-content"></div></body>`;
    await expect(lookupCourse(807, api, 77)).rejects.toThrow(error);
    await expect(api.call("core_course_get_contents", { courseid: 807 })).rejects.toThrow(error);
  });

  it.each([
    '<title>Khoá luận tốt nghiệp - AI505.R11</title>',
    '<h1>Khoá luận tốt nghiệp - AI505.R11</h1>',
    '<div id="page-header"><h1> </h1></div>',
    '<div id="page-header"><h1>Khoá luận...</h1></div>',
    '<div class="page-header-headings"><h1>Khoá luận…</h1></div>'
  ])("rejects missing authoritative or truncated headings: %s", async (heading) => {
    pages["/course/view.php?id=807"] = `<body class="course-807">${heading}<div class="course-content"></div></body>`;
    await expect(lookupCourse(807, api, 77)).rejects.toThrow("complete course title");
  });

  it("rejects metadata-only pages without course content", async () => {
    pages["/course/view.php?id=807"] = '<body class="course-807"><div id="page-header"><h1>Khoá luận tốt nghiệp - AI505.R11</h1></div></body>';
    await expect(lookupCourse(807, api, 77)).rejects.toThrow("accessible course contents");
  });

  it.each([
    { body: "Forbidden", status: 403, headers: { "content-type": "text/html" } },
    { body: "Redirect", status: 302, headers: { location: "/login/index.php", "content-type": "text/html" } },
    { body: "PDF", headers: { "content-type": "application/pdf" } },
    { body: "HTML", headers: { "content-type": "text/html", "content-disposition": "attachment" } }
  ])("preserves pageQuery HTTP and download guards: %j", async (fixture) => {
    pages["/course/view.php?id=807"] = fixture;
    await expect(lookupCourse(807, api, 77)).rejects.toThrow();
  });

  it("keeps cmid-only assignments resolvable without substituting context or grade IDs", async () => {
    pages["/course/view.php?id=42"] = course([[91, "assign", "Essay"]]);
    pages["/mod/assign/view.php?id=91&forceview=1"] = activity(91, "assign", `<div id="intro"><p>Read the prompt</p></div><a href="/pluginfile.php/9000/mod_assign/introattachment/0/prompt.pdf">Prompt</a><a href="view.php?id=91&action=grade&userid=8">Grade</a><a href="/grade/grading/manage.php?areaid=555">Rubric</a>`);
    const result = await api.call("mod_assign_get_assignments", { "courseids[0]": 42 });
    const assignment = result.courses[0].assignments[0];
    expect(assignment).toMatchObject({ cmid: 91, course: 42, name: "Activity 91", intro: "<p>Read the prompt</p>", unavailable: { instance: expect.any(String) }, introattachments: [{ filename: "prompt.pdf" }] });
    expect(assignment).not.toHaveProperty("id");
    expect(assignment).not.toHaveProperty("duedate");
    await expect(resolveCourseResource(42, { kind: "module", id: 91 }, api)).resolves.toMatchObject({ id: 91, moduleId: 91, description: "Read the prompt", files: [{ filename: "prompt.pdf" }] });
    const info = await api.call("core_course_get_course_module", { cmid: 91 });
    expect(info.cm).toMatchObject({ id: 91, course: 42, modname: "assign" });
    expect(info.cm).not.toHaveProperty("instance");
  });

  it.each([
    ['<input type="hidden" name="assignid" value="701">', 701],
    ['<div data-assignmentid="702"></div>', 702],
    ['<a href="/grade/edit/tree/grade.php?itemmodule=assign&iteminstance=703">Grade</a>', 703],
    ['<a href="view.php?id=91&action=grader">Grade</a>', 704]
  ])("reads only real assignment IDs from HTML: %s", async (markup, id) => {
    pages["/course/view.php?id=42"] = course([[91, "assign", "Essay"]]);
    pages["/mod/assign/view.php?id=91&forceview=1"] = activity(91, "assign", `<div id="intro">Essay prompt</div>${markup}`);
    pages["/mod/assign/view.php?id=91&action=grader"] = '<div data-region="grade" data-assignmentid="704"></div>';
    const result = await api.call("mod_assign_get_assignments", { courseids: [42] });
    expect(result.courses[0].assignments[0]).toMatchObject({ id, cmid: 91 });
    expect(result.courses[0].assignments[0].unavailable).toBeUndefined();
  });

  it("discovers real module metadata from accessible courses on a cold client", async () => {
    pages["/course/view.php?id=42"] = course([[92, "forum", "Announcements"]]);
    pages["/mod/forum/view.php?id=92&forceview=1"] = activity(92, "forum", '<div id="intro">News</div><input type="hidden" name="forum" value="702">', "forumtype-news");
    await expect(api.call("core_course_get_course_module", { cmid: 92 })).resolves.toMatchObject({ cm: { id: 92, course: 42, instance: 702, modname: "forum", name: "Activity 92" } });
  });

  it.each([
    '<input type="hidden" name="forum" value="702">',
    '<a href="post.php?forum=702">Add discussion</a>',
    '<a href="subscribe.php?id=702&sesskey=not-followed">Subscribe</a>',
    '<tr data-forumid="702"></tr>',
    '<a href="view.php?f=702">Forum</a>'
  ])("reads forum IDs and news type without guessing from its name: %s", async (markup) => {
    pages["/course/view.php?id=42"] = course([[92, "forum", "Announcements"], [93, "forum", "Also Announcements"]]);
    pages["/mod/forum/view.php?id=92&forceview=1"] = activity(92, "forum", `<div id="intro">News</div><table>${markup}</table>`, "forumtype-news");
    pages["/mod/forum/view.php?id=93&forceview=1"] = activity(93, "forum", '<div id="intro">General</div><div data-forumid="703"></div>', "forumtype-general");
    const result = await api.call("mod_forum_get_forums_by_courses", { "courseids[0]": 42 });
    expect(result).toMatchObject([{ id: 702, cmid: 92, course: 42, type: "news" }, { id: 703, cmid: 93, type: "general" }]);
    expect(requests).toHaveLength(4);
  });

  it("reads discussions through the module page and rejects a different module", async () => {
    pages["/mod/forum/view.php?id=9059&forceview=1&p=0&s=100"] = '<body id="page-mod-forum-view" class="forumtype-news"><script>M.cfg = {"courseId":807,"contextInstanceId":9059};</script><table class="discussion-list"><tr class="discussion" data-discussionid="801"><td class="topic"><a href="discuss.php?d=801">Thesis notice</a></td></tr></table></body>';
    pages["/mod/forum/discuss.php?d=801"] = '<article class="forumpost firstpost"><h3 class="subject">Thesis notice</h3><div class="posting"><p>Defend in June.</p></div></article>';
    const result = await api.call("mod_forum_get_forum_discussions", { cmid: 9059 });
    expect(result.discussions).toMatchObject([{ discussion: 801, name: "Thesis notice", subject: "Thesis notice", message: "<p>Defend in June.</p>" }]);
    pages["/mod/forum/view.php?id=9059&forceview=1&p=0&s=100"] = '<body id="page-mod-forum-view"><script>M.cfg = {"courseId":807,"contextInstanceId":9999};</script><table class="discussion-list"><tr class="discussion" data-discussionid="801"><td class="topic"><a href="discuss.php?d=801">Thesis notice</a></td></tr></table></body>';
    await expect(api.call("mod_forum_get_forum_discussions", { cmid: 9059 })).rejects.toThrow("different course module");
  });

  it("reads paginated modern discussions, opening messages and attachments, not reply content", async () => {
    pages["/mod/forum/view.php?f=702&p=2&s=2"] = `<div id="discussion-list-fixture"><table class="discussion-list"><tr class="discussion" data-region="discussion-list-item" data-discussionid="801" data-forumid="702"><th class="topic"><a href="discuss.php?d=801" title="Exam &amp; notes">Exam...</a></th><td class="author"><div class="author-info"><div>Teacher</div><time data-timestamp="1700000000"></time></div></td><td><time data-timestamp="1700000100"></time></td><td class="text-center"><span>3</span></td></tr></table></div>`;
    // Moodle 4.5 forum_discussion_post.mustache, including a nested reply.
    pages["/mod/forum/discuss.php?d=801"] = `<article data-region="post" data-post-id="900"><div class="forumpost firstpost starter"><header><h3 data-region-content="forum-post-core-subject">Exam &amp; notes</h3><a href="/user/view.php?id=4">Teacher</a></header><div id="post-content-900" class="post-content-container"><p>Study chapters 1 &amp; 2.</p></div><div><a href="/pluginfile.php/9000/mod_forum/attachment/900/exam.pdf">exam.pdf</a></div></div><div data-region="replies-container"><article data-region="post"><div class="forumpost"><div class="post-content-container">A reply</div><a href="/pluginfile.php/9000/mod_forum/attachment/901/reply.pdf">Reply attachment</a></div></article></div></article>`;
    const result = await api.call("mod_forum_get_forum_discussions", { forumid: 702, page: 2, perpage: 2 });
    expect(result.discussions).toMatchObject([{ discussion: 801, name: "Exam & notes", subject: "Exam & notes", message: "<p>Study chapters 1 &amp; 2.</p>", userfullname: "Teacher", numreplies: 3, created: 1700000000, timemodified: 1700000100, attachments: [{ filename: "exam.pdf", fileurl: `${origin}/pluginfile.php/9000/mod_forum/attachment/900/exam.pdf` }] }]);
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.timeout === 30000 && request.credentials === "include" && request.redirect === "error")).toBe(true);
    expect(result.discussions[0].attachments).toHaveLength(1);
  });

  it("reads legacy discussion rows and preserves partial records if the post is unavailable", async () => {
    pages["/mod/forum/view.php?f=702&p=0&s=100"] = '<table class="forumheaderlist"><tr class="discussion"><td class="topic"><a href="discuss.php?d=802">Old notice</a></td><td class="author"><a href="/user/view.php?id=4">Tutor</a></td><td class="replies"><a href="discuss.php?d=802">0</a></td></tr></table>';
    pages["/mod/forum/discuss.php?d=802"] = { body: "Forbidden", status: 403 };
    const result = await api.call("mod_forum_get_forum_discussions", { forumid: 702 });
    expect(result.discussions).toMatchObject([{ discussion: 802, name: "Old notice", userfullname: "Tutor", numreplies: 0, unavailable: { message: expect.stringContaining("403") } }]);
    expect(result.discussions[0]).not.toHaveProperty("message");
    expect(result.discussions[0]).not.toHaveProperty("timemodified");
  });

  it("distinguishes empty forums from login and unrecognized pages", async () => {
    pages["/mod/forum/view.php?f=702&p=0&s=100"] = '<div class="forumnodiscuss">No discussions</div>';
    await expect(api.call("mod_forum_get_forum_discussions", { forumid: 702 })).resolves.toEqual({ discussions: [], warnings: [] });
    pages["/mod/forum/view.php?f=702&p=0&s=100"] = '<input name="logintoken">';
    await expect(api.call("mod_forum_get_forum_discussions", { forumid: 702 })).rejects.toThrow("session expired");
    pages["/mod/forum/view.php?f=702&p=0&s=100"] = '<h1>Something went wrong</h1>';
    await expect(api.call("mod_forum_get_forum_discussions", { forumid: 702 })).rejects.toThrow("Unable to read forum");
  });

  it("uses forceview pages only, rejects binary responses and isolates resource enrichment failures", async () => {
    pages["/course/view.php?id=42"] = course([[101, "resource", "PDF"], [102, "resource", "Binary"], [103, "folder", "Folder"], [104, "url", "Website"]]);
    pages["/mod/resource/view.php?id=101&forceview=1"] = '<div class="resourceworkaround"><a href="/pluginfile.php/1/mod_resource/content/0/slides.pdf">Slides</a></div>';
    pages["/mod/resource/view.php?id=102&forceview=1"] = { body: "%PDF-1.0", headers: { "content-type": "application/pdf" } };
    pages["/mod/folder/view.php?id=103&forceview=1"] = '<a href="/pluginfile.php/1/mod_folder/content/0/notes.txt">Notes</a>';
    pages["/mod/url/view.php?id=104&forceview=1"] = '<div class="urlworkaround"><a href="https://example.invalid/reference">Reference</a></div>';
    const result = await api.call("core_course_get_contents", { courseid: 42 });
    expect(result[0].modules).toMatchObject([
      { id: 101, name: "PDF", contents: [{ type: "file", filename: "slides.pdf" }] },
      { id: 102, contents: [], unavailable: { contents: expect.stringContaining("not a download") } },
      { id: 103, contents: [{ filename: "notes.txt" }] },
      { id: 104, contents: [{ type: "url", fileurl: "https://example.invalid/reference" }] }
    ]);
    expect(requests).toHaveLength(6);
    expect(requests.every((request) => request.url.startsWith(origin) && !request.url.includes("pluginfile.php") && !request.url.includes("redirect=0") && request.timeout === 30000)).toBe(true);
  });

  it("retains module identity when one assignment page fails", async () => {
    pages["/course/view.php?id=42"] = course([[91, "assign", "Locked"], [92, "assign", "Available"]]);
    pages["/mod/assign/view.php?id=91&forceview=1"] = { body: "Forbidden", status: 403 };
    pages["/mod/assign/view.php?id=92&forceview=1"] = activity(92, "assign", '<div id="intro">Prompt</div><div data-assignmentid="702"></div>');
    const result = await api.call("mod_assign_get_assignments", { courseids: [42] });
    expect(result.courses[0].assignments).toMatchObject([{ cmid: 91, name: "Locked", unavailable: { details: expect.stringContaining("403") } }, { cmid: 92, id: 702 }]);
    expect(result.courses[0].assignments[0]).not.toHaveProperty("id");
    await expect(api.call("core_course_get_course_module", { cmid: 91 })).resolves.toMatchObject({ cm: { id: 91, modname: "assign", name: "Locked", unavailable: { details: expect.stringContaining("403") } } });
  });

  it("never evaluates page scripts or confuses a wrong activity context with an instance", async () => {
    pages["/course/view.php?id=42"] = course([[91, "assign", "Essay"]]);
    pages["/mod/assign/view.php?id=91&forceview=1"] = activity(999, "assign", '<div data-assignmentid="701"></div><script>window.fixtureCodeExecuted=true;</script>');
    const result = await api.call("mod_assign_get_assignments", { courseids: [42] });
    expect(result.courses[0].assignments[0]).toMatchObject({ cmid: 91, unavailable: { details: expect.stringContaining("different course module") } });
    expect(result.courses[0].assignments[0]).not.toHaveProperty("id");
    expect(await page.evaluate(() => (window as any).fixtureCodeExecuted)).toBeUndefined();
  });

  it("keeps metadata when the existing grader link is inaccessible", async () => {
    pages["/course/view.php?id=42"] = course([[91, "assign", "Essay"]]);
    pages["/mod/assign/view.php?id=91&forceview=1"] = activity(91, "assign", '<div id="intro">Prompt</div><a href="view.php?id=91&action=grader&sesskey=never-replayed">Grade</a>');
    pages["/mod/assign/view.php?id=91&action=grader"] = { body: "Forbidden", status: 403 };
    const result = await api.call("mod_assign_get_assignments", { courseids: [42] });
    expect(result.courses[0].assignments[0]).toMatchObject({ cmid: 91, intro: "Prompt", unavailable: { instance: expect.any(String) } });
    expect(result.courses[0].assignments[0]).not.toHaveProperty("id");
    expect(requests.some((request) => request.url.includes("never-replayed"))).toBe(false);
  });

  it("passes abort signals that bound both AJAX and page fetches", async () => {
    await page.evaluate(() => {
      AbortSignal.timeout = () => { const controller = new AbortController(); controller.abort(new DOMException("Fixture timeout", "TimeoutError")); return controller.signal; };
      const fetch = window.fetch;
      window.fetch = (url, options) => { options?.signal?.throwIfAborted(); return fetch(url, options); };
    });
    await expect(api.call("core_course_get_contents", { courseid: 42 })).rejects.toThrow("Fixture timeout");
    expect(requests).toHaveLength(0);
    await page.evaluate(() => {
      window.fetch = async (url, options) => {
        if (String(url).includes("/lib/ajax/")) return new Response(JSON.stringify([{ error: true, exception: "servicenotavailable" }]));
        options?.signal?.throwIfAborted();
        throw new Error("Missing abort signal");
      };
    });
    await expect(api.call("core_course_get_contents", { courseid: 42 })).rejects.toThrow("Fixture timeout");
  });

  it("rejects HTML downloads before reading the response body", async () => {
    await page.evaluate(() => {
      window.fetch = async (url) => {
        if (String(url).includes("/lib/ajax/")) return new Response(JSON.stringify([{ error: true, exception: "servicenotavailable" }]));
        const response = new Response("download", { headers: { "content-type": "text/html", "content-disposition": "attachment; filename=page.html" } });
        response.text = async () => { throw new Error("Binary body was consumed"); };
        return response;
      };
    });
    await expect(api.call("core_course_get_contents", { courseid: 42 })).rejects.toThrow("not a download");
  });

  it("falls back to the participants page when core_enrol_get_enrolled_users is unavailable via AJAX", async () => {
    pages["/user/index.php?id=42&perpage=5000"] = `
      <body>
        <table id="participants" class="generaltable">
          <tbody>
            <tr>
              <td class="cell c0"><input id="user101" type="checkbox" /></td>
              <td class="cell c1"><span class="userinitials">AS</span><a href="/user/view.php?id=101&course=42">Alice Student</a></td>
              <td class="cell c2">Học viên</td>
            </tr>
            <tr>
              <td class="cell c0"><input id="user102" type="checkbox" /></td>
              <td class="cell c1"><a href="/user/view.php?id=102&course=42">Dr. Bob</a></td>
              <td class="cell c2">Giảng viên</td>
            </tr>
          </tbody>
        </table>
      </body>
    `;
    const users = await api.call("core_enrol_get_enrolled_users", { courseid: 42 });
    expect(users).toEqual([
      { id: 101, fullname: "Alice Student", roles: [{ shortname: "học viên", name: "Học viên" }] },
      { id: 102, fullname: "Dr. Bob", roles: [{ shortname: "giảng viên", name: "Giảng viên" }] }
    ]);
  });

  it("falls back to the user grade report page when gradereport_user_get_grade_items is unavailable via AJAX", async () => {
    pages["/grade/report/user/index.php?id=42"] = `
      <body>
        <table class="user-grade generaltable">
          <tbody>
            <tr>
              <th class="column-itemname"><span class="sr-only">Course</span>Course total</th>
              <td class="column-grade">9.5</td>
              <td class="column-range">0–10</td>
              <td class="column-percentage">95 %</td>
              <td class="column-feedback">Well done!</td>
            </tr>
          </tbody>
        </table>
      </body>
    `;
    const result = await api.call("gradereport_user_get_grade_items", { courseid: 42 });
    expect(result).toEqual({
      usergrades: [{
        courseid: 42,
        gradeitems: [
          {
            itemname: "Course total",
            gradeformatted: "9.5",
            grademax: "0–10",
            percentageformatted: "95 %",
            feedback: "Well done!"
          }
        ]
      }]
    });
  });
});
