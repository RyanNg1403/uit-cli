import type { ApiClient } from "./types.js";

export interface UitToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface UitToolContext {
  api: ApiClient;
  baseUrl: string;
  userId: number;
  /** Optional Studio hint used when a legacy caller omits courseId. */
  defaultCourseId?: number;
}

export interface UitToolServices {
  listCourses(api: ApiClient, userId: number): Promise<unknown>;
  getCourseContents(courseId: number, api: ApiClient): Promise<unknown>;
  listAssignments(courseId: number, api: ApiClient): Promise<unknown[]>;
  listAnnouncements(courseId: number, api: ApiClient): Promise<unknown[]>;
  listCourseParticipants(courseId: number, api: ApiClient): Promise<Array<{ roles: string[] }>>;
  getCourseGrades(courseId: number, api: ApiClient, userId: number): Promise<unknown>;
  resolveCourseResource(courseId: number, reference: Record<string, unknown>, api: ApiClient): Promise<unknown>;
  materializeFile(
    courseId: number,
    fileUrl: string,
    filename: string,
    api: ApiClient,
    identity: { baseUrl: string; userId: number }
  ): Promise<string>;
}

const resourceSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    courseId: { type: "integer", description: "Course ID (positive integer)" },
    kind: { type: "string", enum: ["module", "file", "assignment", "announcement"] },
    id: { type: "integer" },
    moduleId: { type: "integer" },
    fileUrl: { type: "string" }
  },
  required: ["courseId", "kind", "id"],
  additionalProperties: false
};

/** The one source of truth for the UIT tools exposed to Codex. */
export const UIT_TOOLS: UitToolSpec[] = [
  {
    type: "function",
    name: "uit_courses",
    description: "List accessible UIT courses for the authenticated student account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    type: "function",
    name: "uit_course_contents",
    description: "Read course modules, sections, assignments, and announcements for a UIT course.",
    inputSchema: {
      type: "object",
      properties: { courseId: { type: "integer", description: "Course ID (positive integer)" } },
      required: ["courseId"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "uit_read_resource",
    description: "Read a course resource's authoritative description and file references.",
    inputSchema: resourceSchema
  },
  {
    type: "function",
    name: "uit_course_members",
    description: "List course instructors, teaching assistants, and enrolled students.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "integer", description: "Course ID (positive integer)" },
        role: {
          type: "string",
          enum: ["all", "teacher", "student"],
          description: "Filter: 'teacher' for instructors, 'student' for students, or 'all'."
        }
      },
      required: ["courseId"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "uit_course_grades",
    description: "Read student grade report, scores, maximum points, and teacher feedback for a course.",
    inputSchema: {
      type: "object",
      properties: { courseId: { type: "integer", description: "Course ID (positive integer)" } },
      required: ["courseId"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "uit_download_material",
    description: "Explicitly download a course file into that course's managed materials folder. Returns the local filepath.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "integer", description: "Source course ID (positive integer)" },
        fileUrl: { type: "string", description: "Full URL of the file from course contents" },
        filename: { type: "string", description: "Optional filename to save as" }
      },
      required: ["courseId", "fileUrl"],
      additionalProperties: false
    }
  }
];

const TOOL_ALIASES: Record<string, string> = {
  uit_list_course_contents: "uit_course_contents",
  uit_download_resource: "uit_download_material",
  uit_list_participants: "uit_course_members",
  uit_get_grades: "uit_course_grades"
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} must be a positive integer.`);
  return id;
}

function courseIdFor(args: Record<string, unknown>, context: UitToolContext): number {
  if (args.courseId === undefined && context.defaultCourseId !== undefined) {
    return positiveId(context.defaultCourseId, "Course ID");
  }
  return positiveId(args.courseId, "Course ID");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function filterParticipants(
  participants: Array<{ roles: string[] }>,
  roleFilter: unknown
): Array<{ roles: string[] }> {
  const role = roleFilter === undefined ? "all" : String(roleFilter);
  if (!(new Set(["all", "teacher", "student"]).has(role))) throw new Error("Invalid role filter.");
  return participants.filter((participant) => {
    if (role === "all") return true;
    const roles = participant.roles.map((item) => item.toLowerCase());
    if (role === "teacher") return roles.some((item) => /gv|teacher|instructor|giảng|trợ/i.test(item));
    return roles.some((item) => /student|học\s*viên/i.test(item));
  });
}

export function createUitToolExecutor(services: UitToolServices) {
  return async function executeUitTool(
    requestedName: string,
    rawArgs: Record<string, unknown>,
    context: UitToolContext
  ): Promise<unknown> {
    const name = TOOL_ALIASES[requestedName] || requestedName;
    const args = rawArgs || {};

    switch (name) {
      case "uit_courses":
        return await services.listCourses(context.api, context.userId);
      case "uit_course_contents": {
        const courseId = courseIdFor(args, context);
        const results = await Promise.allSettled([
          services.getCourseContents(courseId, context.api),
          services.listAssignments(courseId, context.api),
          services.listAnnouncements(courseId, context.api)
        ]);
        return Object.fromEntries(results.map((entry, index) => [["modules", "assignments", "announcements"][index], entry.status === "fulfilled" ? entry.value : { error: errorMessage(entry.reason) }]));
      }
      case "uit_read_resource": {
        const courseId = courseIdFor(args, context);
        const reference = { ...args };
        delete reference.courseId;
        return await services.resolveCourseResource(courseId, reference, context.api);
      }
      case "uit_course_members": {
        const courseId = courseIdFor(args, context);
        const participants = await services.listCourseParticipants(courseId, context.api);
        return filterParticipants(participants, args.role);
      }
      case "uit_course_grades":
        return await services.getCourseGrades(courseIdFor(args, context), context.api, context.userId);
      case "uit_download_material": {
        const courseId = courseIdFor(args, context);
        const fileUrl = requiredString(args.fileUrl, "File URL");
        const filename = args.filename === undefined ? "material" : requiredString(args.filename, "Filename");
        const path = await services.materializeFile(courseId, fileUrl, filename, context.api, {
          baseUrl: context.baseUrl,
          userId: context.userId
        });
        return { path };
      }
      default:
        throw new Error(`Unknown UIT tool: ${requestedName}`);
    }
  };
}

export type UitToolExecutor = ReturnType<typeof createUitToolExecutor>;
