import { realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { ApiClient } from "./types.js";

export const UIT_ASSIGNMENT_SUBMISSION_TOOL = "uit_submit_assignment";

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
  /** Managed UIT course storage root; local write tools are confined to it. */
  workspacePath?: string;
}

export interface UitToolServices {
  listCourses(api: ApiClient, userId: number): Promise<unknown>;
  getCourseContents(courseId: number, api: ApiClient): Promise<unknown>;
  listAssignments(courseId: number, api: ApiClient): Promise<unknown[]>;
  listAnnouncements(courseId: number, api: ApiClient): Promise<unknown[]>;
  listCourseParticipants(courseId: number, api: ApiClient): Promise<Array<{ roles: string[] }>>;
  getCourseGrades(courseId: number, api: ApiClient, userId: number): Promise<unknown>;
  resolveCourseResource(courseId: number, reference: Record<string, unknown>, api: ApiClient): Promise<unknown>;
  materializeCourseFile(
    courseId: number,
    moduleId: number,
    filename: string,
    api: ApiClient,
    identity: { baseUrl: string; userId: number }
  ): Promise<string>;
  submitAssignment(courseId: number, assignmentId: number, filePath: string, api: ApiClient): Promise<unknown>;
}

const courseIdInput = { type: "integer", description: "Course ID from uit_courses or the current course." };

function resourceInput(
  kind: "module" | "file" | "assignment" | "announcement",
  idDescription: string,
  includeFilename = false
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      courseId: courseIdInput,
      kind: { type: "string", enum: [kind] },
      id: { type: "integer", description: idDescription },
      ...(includeFilename ? { filename: { type: "string", description: "Exact filename from the owning module in uit_course_contents; do not provide a URL." } } : {})
    },
    required: ["courseId", "kind", "id", ...(includeFilename ? ["filename"] : [])],
    additionalProperties: false
  };
}

const resourceSchema: Record<string, unknown> = {
  oneOf: [
    resourceInput("module", "Course-module ID (cmid) from uit_course_contents."),
    resourceInput("file", "Owning course-module ID (cmid) from uit_course_contents.", true),
    resourceInput("assignment", "Assignment instance ID from uit_course_contents."),
    resourceInput("announcement", "Announcement ID from uit_course_contents.")
  ]
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
    description: "Read course modules, sections, assignments, and announcements. H5P activities are identified as h5pactivity modules and can be inspected with uit_read_resource. For downloads, reuse the returned module ID and exact filename; never reconstruct a file URL.",
    inputSchema: {
      type: "object",
      properties: { courseId: { type: "integer", description: "Course ID from uit_courses or the current course." } },
      required: ["courseId"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "uit_read_resource",
    description: "Read one current course resource. For an H5P module, this returns its ordered video, slide, and embedded-resource URLs directly. Call uit_course_contents first and reuse the resource kind and its matching ID. Files additionally require their exact filename; never provide a file URL.",
    inputSchema: resourceSchema
  },
  {
    type: "function",
    name: "uit_course_members",
    description: "List course instructors, teaching assistants, and enrolled students.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "integer", description: "Course ID from uit_courses or the current course." },
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
      properties: { courseId: { type: "integer", description: "Course ID from uit_courses or the current course." } },
      required: ["courseId"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "uit_download_material",
    description: "Download one file from a course module into its managed materials folder. Use the module ID and exact filename from uit_course_contents; the tool resolves the file URL itself.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "integer", description: "Course ID from uit_courses or the current course." },
        moduleId: { type: "integer", description: "Course-module ID (cmid) from uit_course_contents; do not use a file instance ID." },
        filename: { type: "string", description: "Exact filename from the selected module in uit_course_contents; do not provide a URL." }
      },
      required: ["courseId", "moduleId", "filename"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: UIT_ASSIGNMENT_SUBMISSION_TOOL,
    description: "Upload and submit one local file to a UIT assignment. This changes upstream course data.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "integer", description: "Course ID from uit_courses or the current course." },
        assignmentId: { type: "integer", description: "Assignment instance ID from uit_course_contents or uit_read_resource; do not use a course-module ID." },
        filePath: { type: "string", description: "Local file path inside managed UIT course storage. Use the exact file the student confirmed." }
      },
      required: ["courseId", "assignmentId", "filePath"],
      additionalProperties: false
    }
  }
];

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

function workspaceFilePath(value: unknown, context: UitToolContext): string {
  const filePath = requiredString(value, "File path");
  if (!context.workspacePath) throw new Error("Managed UIT course storage is required for assignment submission.");
  const workspace = resolve(context.workspacePath);
  const candidate = resolve(workspace, filePath);
  const candidateRelative = relative(workspace, candidate);
  if (!candidateRelative || candidateRelative === ".." || candidateRelative.startsWith(`..${sep}`)) {
    throw new Error("The submission file must be inside managed UIT course storage.");
  }
  try {
    const workspaceReal = realpathSync(workspace);
    const candidateReal = realpathSync(candidate);
    if (candidateReal !== workspaceReal && !candidateReal.startsWith(`${workspaceReal}${sep}`)) {
      throw new Error("The submission file must be inside managed UIT course storage.");
    }
    if (!statSync(candidateReal).isFile()) throw new Error("The submission path must be a regular file.");
    return candidateReal;
  } catch (error) {
    if (error instanceof Error && /managed UIT course storage|regular file/.test(error.message)) throw error;
    throw new Error("The submission file must be an existing regular file inside managed UIT course storage.", { cause: error });
  }
}

function rejectFileUrl(args: Record<string, unknown>): void {
  if (args.fileUrl !== undefined) throw new Error("File URL is not accepted. Use the course-module ID and exact filename from course contents.");
}

function resourceReference(args: Record<string, unknown>): Record<string, unknown> {
  rejectFileUrl(args);
  if (args.moduleId !== undefined) throw new Error("moduleId is not accepted. Pass the kind-specific resource ID as id.");
  const kind = requiredString(args.kind, "Resource kind");
  if (!(["module", "file", "assignment", "announcement"] as string[]).includes(kind)) throw new Error("Unknown course resource kind.");
  const reference: Record<string, unknown> = { kind, id: positiveId(args.id, "Resource ID") };
  if (kind === "file") reference.filename = requiredString(args.filename, "Filename");
  else if (args.filename !== undefined) throw new Error("filename is accepted only for file resources.");
  return reference;
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
    const args = rawArgs || {};

    switch (requestedName) {
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
        return await services.resolveCourseResource(courseId, resourceReference(args), context.api);
      }
      case "uit_course_members": {
        const courseId = courseIdFor(args, context);
        const participants = await services.listCourseParticipants(courseId, context.api);
        return filterParticipants(participants, args.role);
      }
      case "uit_course_grades":
        return await services.getCourseGrades(courseIdFor(args, context), context.api, context.userId);
      case "uit_download_material": {
        rejectFileUrl(args);
        const courseId = courseIdFor(args, context);
        const moduleId = positiveId(args.moduleId, "Module ID");
        const filename = requiredString(args.filename, "Filename");
        const path = await services.materializeCourseFile(courseId, moduleId, filename, context.api, {
          baseUrl: context.baseUrl,
          userId: context.userId
        });
        return { path };
      }
      case UIT_ASSIGNMENT_SUBMISSION_TOOL: {
        const courseId = courseIdFor(args, context);
        const assignmentId = positiveId(args.assignmentId, "Assignment ID");
        const filePath = workspaceFilePath(args.filePath, context);
        return await services.submitAssignment(courseId, assignmentId, filePath, context.api);
      }
      default:
        throw new Error(`Unknown UIT tool: ${requestedName}`);
    }
  };
}

export type UitToolExecutor = ReturnType<typeof createUitToolExecutor>;
