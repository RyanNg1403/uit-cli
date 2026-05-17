import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram, main } from "../src/cli.js";
import { resetConfigCache } from "../src/config.js";
import type { ApiClient } from "../src/types.js";

const originalCwd = process.cwd();
let tempDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdout = "";
let stderr = "";

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
  tempDir = mkdtempSync(join(tmpdir(), "uit-cli-test-"));
  writeFileSync(
    join(tempDir, ".env"),
    'UIT_TOKEN="token-123"\nUIT_BASE_URL="https://courses.uit.edu.vn"\nUIT_USER_ID=42\n'
  );
  process.chdir(tempDir);
  resetConfigCache();
  stdout = "";
  stderr = "";
  stdoutSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    stdout += `${args.join(" ")}\n`;
  });
  stderrSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    stderr += `${args.join(" ")}\n`;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  process.chdir(originalCwd);
  resetConfigCache();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("CLI command flows", () => {
  it("shows init --token in help", async () => {
    const program = createProgram(mockApi({}));
    const initCommand = program.commands.find((command) => command.name() === "init");

    expect(initCommand?.helpInformation()).toContain("--token <token>");
  });

  it("lists courses in the same JSON shape", async () => {
    const api = mockApi({
      core_enrol_get_users_courses: [
        { id: 2, shortname: "CS102", fullname: "Algorithms &amp; Data", category: 20 },
        { id: 1, shortname: "CS101", fullname: "Intro", category: 1 }
      ]
    });

    const code = await main(["node", "uit", "--json", "courses"], api);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      { id: 2, short: "CS102", name: "Algorithms & Data" },
      { id: 1, short: "CS101", name: "Intro" }
    ]);
    expect(stderr).toBe("");
    expect(api.call).toHaveBeenCalledWith("core_enrol_get_users_courses", { userid: 42 });
  });

  it("flattens course contents in JSON mode", async () => {
    const api = mockApi({
      core_course_get_contents: [
        {
          name: "Week 1",
          modules: [
            {
              id: 428955,
              modname: "resource",
              name: "Slides &amp; notes",
              contents: [{ filename: "slides.pdf", fileurl: "https://files/slides.pdf", filesize: 2048 }]
            }
          ]
        }
      ]
    });

    const code = await main(["node", "uit", "--json", "contents", "19207"], api);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      {
        section: "Week 1",
        module_id: 428955,
        type: "resource",
        name: "Slides & notes",
        files: [{ filename: "slides.pdf", fileurl: "https://files/slides.pdf", filesize: 2048 }]
      }
    ]);
  });

  it("prints browser URLs without opening a browser in JSON mode", async () => {
    const api = mockApi({});

    const code = await main(["node", "uit", "--json", "open", "--course", "19207"], api);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ url: "https://courses.uit.edu.vn/course/view.php?id=19207", id: 19207 });
    expect(api.call).not.toHaveBeenCalled();
  });

  it("calls raw Moodle APIs with key=value parameters", async () => {
    const api = mockApi({
      core_course_get_contents: [{ id: 1 }]
    });

    const code = await main(["node", "uit", "raw", "core_course_get_contents", "courseid=19207"], api);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([{ id: 1 }]);
    expect(api.call).toHaveBeenCalledWith("core_course_get_contents", { courseid: "19207" });
  });

  it("shows assignment details from a module ID", async () => {
    const future = Math.floor(Date.now() / 1000) + 86_400;
    const api = mockApi({
      core_course_get_course_module: {
        cm: { id: 428837, modname: "assign", instance: 101617, course: 19207, name: "Exercise 1" }
      },
      mod_assign_get_assignments: {
        courses: [
          {
            assignments: [
              {
                id: 101617,
                name: "Exercise 1",
                duedate: future,
                cutoffdate: 0,
                intro: '<p>Submit report <a href="https://example.com/spec">spec</a></p>',
                introattachments: [{ filename: "brief.pdf", fileurl: "https://files/brief.pdf", filesize: 1024 }],
                configs: [
                  { plugin: "file", subtype: "assignsubmission", name: "enabled", value: "1" },
                  { plugin: "onlinetext", subtype: "assignsubmission", name: "enabled", value: "1" }
                ]
              }
            ]
          }
        ]
      },
      mod_assign_get_submission_status: {
        lastattempt: { submission: { status: "submitted", timemodified: future - 100 } }
      }
    });

    const code = await main(["node", "uit", "--json", "view", "428837"], api);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      module_id: 428837,
      assign_id: 101617,
      type: "assign",
      name: "Exercise 1",
      description: "Submit report spec",
      submission_status: "submitted",
      urls: ["https://example.com/spec"],
      attachments: [{ filename: "brief.pdf", fileurl: "https://files/brief.pdf", filesize: 1024 }],
      submission_types: ["file", "onlinetext"]
    });
  });

  it("filters past deadlines unless --all is passed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = mockApi({
      core_enrol_get_users_courses: [{ id: 19207 }],
      mod_assign_get_assignments: {
        courses: [
          {
            shortname: "CS101",
            fullname: "Intro &amp; Lab",
            assignments: [
              { id: 1, cmid: 11, name: "Past", duedate: now - 60 },
              { id: 2, cmid: 22, name: "Future", duedate: now + 60 },
              { id: 3, cmid: 33, name: "No due", duedate: 0 }
            ]
          }
        ]
      }
    });

    const code = await main(["node", "uit", "--json", "deadlines"], api);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).map((row: { id: number }) => row.id)).toEqual([2, 3]);
    expect(JSON.parse(stdout)[0]).toMatchObject({ course: "CS101", course_name: "Intro & Lab", name: "Future" });
  });
});
