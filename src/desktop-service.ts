import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { createTokenApiClient, credentialFreeUrl, defaultApiClient, MAX_PREVIEW_BYTES } from "./api.js";
import { get, save } from "./config.js";
import { requestMobileToken } from "./commands.js";
import type { ApiClient, MoodleRecord } from "./types.js";

export interface DesktopLoginInput {
  username: string;
  password: string;
  baseUrl?: string;
}

export const CURRENT_SITE_BASE_URL = "https://courses.uit.edu.vn";

export interface DesktopSession {
  authenticated: boolean;
  authMode?: "token" | "sso";
  baseUrl?: string;
  userId?: number | null;
}

export interface DesktopLoginResult {
  session: DesktopSession;
  api: ApiClient;
  token?: string;
}

export interface CourseSummary {
  id: number;
  shortname: string;
  fullname: string;
  summary?: string;
  progress?: number;
  startdate?: number;
  enddate?: number;
  baseUrl?: string;
  authMode?: "token" | "sso";
  siteLabel?: string;
  discoveredVia?: "url";
  category?: { id?: number; name?: string };
  semester: { id: string; label: string; sortOrder: number; source: "metadata" | "category" | "name" | "startdate" | "current" | "unknown" };
}

export interface CourseFile { filename: string; fileurl: string; filesize: number; timemodified?: number; mimetype?: string }

export interface CourseModule {
  id: number;
  name: string;
  modname: string;
  url?: string;
  description?: string;
  section: string;
  instance?: number;
  unavailable?: Record<string, string>;
  files: CourseFile[];
  urls: Array<{ name: string; url: string }>;
}

export interface WorkspaceInfo {
  path: string;
  courseId: number;
  created: boolean;
}

export interface AssignmentSummary {
  id?: number;
  resourceRef: CourseResourceReference;
  courseId: number;
  moduleId?: number;
  name: string;
  description?: string;
  dueDate?: number;
  cutoffDate?: number;
  allowsubmissionsfromdate?: number;
  files: CourseFile[];
  url?: string;
  grade?: number;
  submissionStatement?: string;
  unavailable?: Record<string, string>;
}

export interface AnnouncementSummary {
  id: number;
  subject: string;
  author: string;
  message: string;
  timestamp?: number;
  replies: number;
  courseId: number;
  moduleId?: number;
  forumId?: number;
  url?: string;
  files: CourseFile[];
  unavailable?: Record<string, string>;
}

export interface CourseParticipant {
  id: number;
  fullname: string;
  roles: string[];
  email?: string;
  groups?: string[];
  lastAccess?: string;
  avatar?: string;
}

export interface CourseGradeItem {
  item: string;
  grade?: string;
  max?: string;
  percentage?: string;
  feedback?: string;
}

const CACHE_TTL_MS = 30_000;
let courseCache = new WeakMap<ApiClient, Map<string, { expires: number; promise: Promise<any> }>>();

export function clearCourseCache(api?: ApiClient): void {
  if (api) courseCache.delete(api);
  else courseCache = new WeakMap();
}

function metadata<T>(api: ApiClient, name: string, params: Record<string, any>): Promise<T> {
  let cache = courseCache.get(api);
  if (!cache) { cache = new Map(); courseCache.set(api, cache); }
  // The default CLI client follows persisted configuration, unlike desktop session clients.
  let identity = "";
  if (api === defaultApiClient) {
    try { identity = createHash("sha256").update(`${get("baseUrl")}:${get("userId")}:${get("token")}`).digest("hex"); }
    catch { /* The API reports missing CLI configuration when the call executes. */ }
  }
  const key = JSON.stringify([identity, name, params]);
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.promise;
  const pending = { expires: Infinity, promise: Promise.resolve().then(() => api.call<T>(name, params)) };
  cache.set(key, pending);
  pending.promise.then(() => { pending.expires = Date.now() + CACHE_TTL_MS; }, () => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending.promise;
}

function filesFrom(...groups: unknown[]): CourseFile[] {
  const files = new Map<string, CourseFile>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const file of group) {
      if (!file?.fileurl || (file.type && file.type !== "file")) continue;
      const fileurl = credentialFreeUrl(file.fileurl);
      if (!fileurl) continue;
      files.set(fileurl, {
        filename: cleanHtml(file.filename || basename(fileurl.split("?")[0]) || "resource"),
        fileurl, filesize: Number(file.filesize || 0), timemodified: Number(file.timemodified) || undefined,
        mimetype: file.mimetype ? String(file.mimetype) : undefined
      });
    }
  }
  return [...files.values()];
}

function normalizeSemester(course: MoodleRecord): CourseSummary["semester"] {
  const normalize = (value: unknown): string => cleanHtml(value)
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code: string) => {
      const point = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/&(?:ndash|mdash|minus);/gi, "-")
    .replace(/&sol;/gi, "/")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-");
  const termPattern = /(?:^|[^a-z0-9])(?:hk|hoc\s*k[iy]|semester|sem|term)[\s_.:-]*(iii|ii|iv|i|0?[1-4]|he|summer)(?![a-z0-9])/gi;
  const terms: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, he: 3, summer: 3 };
  const yearPattern = /(?<![0-9])((?:19|20)\d{2})(?:\s*[-/_]\s*((?:19|20)?\d{2}))?(?![0-9])/g;
  const academicYears = (text: string) => [...text.matchAll(yearPattern)].filter((year) => year[2] || !/(?:^|[^a-z])(?:khoa|cohort)\s*[:_-]?\s*$/i.test(text.slice(0, year.index)));
  const toYear = (year: RegExpMatchArray): string => {
    const start = Number(year[1]);
    const end = year[2] ? (year[2].length === 2 ? `${year[1].slice(0, 2)}${year[2]}` : year[2]) : undefined;
    return end === undefined ? String(start) : `${start}-${end}`;
  };
  // A year or academic range without any term is an honest year group, never a
  // semester guess. This keeps year-named categories (e.g. thesis categories)
  // findable instead of dropping them into Unknown semester.
  const yearGroup = (value: unknown, source: CourseSummary["semester"]["source"]): CourseSummary["semester"] | undefined => {
    const text = normalize(value);
    if (!text || text.match(termPattern)) return undefined;
    const years = [...new Set(academicYears(text).map(toYear))];
    if (years.length !== 1) return undefined;
    const year = years[0];
    return { id: year, label: year, sortOrder: Number(year.slice(0, 4)) * 10 + 9, source };
  };
  const parse = (value: unknown, source: CourseSummary["semester"]["source"], yearContext: unknown = ""): CourseSummary["semester"] | undefined => {
    const text = normalize(value);
    const semesters = [...new Set([...text.matchAll(termPattern)].map((term) => terms[term[1].toLowerCase()] || Number(term[1])))];
    if (semesters.length !== 1) return undefined;
    let yearsFound = academicYears(text);
    if (!yearsFound.length) {
      yearsFound = academicYears(normalize(yearContext));
    }
    // Prefer academic ranges over standalone cohort years, never the first of several ranges.
    const ranges = yearsFound.filter((year) => year[2]);
    const candidates = ranges.length ? ranges : yearsFound;
    const years = [...new Set(candidates.map(toYear))];
    if (years.length !== 1) return undefined;
    const year = years[0];
    const semester = semesters[0];
    return { id: `${year}-hk${semester}`, label: `HK${semester} ${year}`, sortOrder: Number(year.slice(0, 4)) * 10 + semester, source };
  };
  const explicit = course.semester;
  if (explicit && typeof explicit === "object" && explicit.id && explicit.label) {
    return { id: String(explicit.id), label: cleanHtml(explicit.label), sortOrder: Number(explicit.sortOrder) || parse(explicit.label, "metadata")?.sortOrder || 0, source: "metadata" };
  }
  const categoryText = course.categoryname || course.coursecategory || course.category?.name || (typeof course.category === "string" ? course.category : "");
  const academicYear = course.academicyear || course.academic_year || course.year || "";
  const fields = (Array.isArray(course.customfields) ? course.customfields : []).filter((field: MoodleRecord) => /^(?:semester|term|hoc[\s_.-]*k[iy])$/i.test(normalize(field?.shortname || field?.name)));
  for (const value of [explicit, course.semestername, course.term, ...fields.map((field: MoodleRecord) => field.value)]) {
    if (!value) continue;
    const text = typeof value === "object" ? value.label || value.name || value.id : value;
    if (!text) continue;
    const term = /^0?[1-4]$/.test(cleanHtml(text)) ? `HK${cleanHtml(text)}` : text;
    const normalized = parse(term, "metadata", academicYear || categoryText);
    if (normalized) return normalized;
    if (normalize(term).match(termPattern)) continue;
    const yearOnly = yearGroup(text, "metadata");
    if (yearOnly) return yearOnly;
    if (String(text).trim()) return { id: `metadata-${String(text).trim().toLowerCase()}`, label: cleanHtml(text), sortOrder: 0, source: "metadata" };
  }
  const category = parse(categoryText, "category", academicYear);
  if (category) return category;
  const categoryYear = yearGroup(categoryText, "category");
  if (categoryYear) return categoryYear;
  const name = parse(`${course.fullname || ""} ${course.shortname || ""}`, "name");
  if (name) return name;
  const startdate = Number(course.startdate);
  if (startdate > 0 && Number.isFinite(startdate)) {
    const date = new Date(startdate * 1000);
    if (Number.isFinite(date.getTime())) {
      const year = date.getUTCFullYear();
      // Plain year ID on purpose: year-only groups from any source must merge
      // into a single section instead of rendering duplicate year headers.
      return { id: `${year}`, label: `${year}`, sortOrder: year * 10 + 9, source: "startdate" };
    }
  }
  // A yearless term or conflicting term/year hints stay unknown; a complete
  // absence of time hints files under the current year. Real evidence always
  // wins when present, so the default self-corrects on refresh.
  const seen = new Set<string>();
  let conflict = false;
  let hasTerm = false;
  const scan = (value: unknown): void => {
    if (conflict) return;
    const raw = typeof value === "object" && value !== null ? (value as MoodleRecord).label ?? (value as MoodleRecord).name ?? (value as MoodleRecord).id : value;
    if (raw === undefined || raw === null || String(raw).trim() === "") return;
    const clean = cleanHtml(raw);
    const text = /^0?[1-4]$/.test(clean) ? `HK${clean}` : normalize(raw);
    if (seen.has(text)) return;
    seen.add(text);
    const foundTerms = new Set([...text.matchAll(termPattern)].map((term) => terms[term[1].toLowerCase()] || Number(term[1])));
    const foundYears = new Set(academicYears(text).map(toYear));
    if (foundTerms.size > 1 || foundYears.size > 1) conflict = true;
    else if (foundTerms.size > 0) hasTerm = true;
  };
  scan(explicit);
  scan(course.semestername);
  scan(course.term);
  for (const field of fields) scan(field.value);
  scan(categoryText);
  scan(course.fullname);
  scan(course.shortname);
  scan(course.summary);
  if (conflict || hasTerm) return { id: "unknown", label: "Unknown semester", sortOrder: 0, source: "unknown" };
  const now = new Date().getUTCFullYear();
  return { id: `${now}`, label: `${now}`, sortOrder: now * 10 + 9, source: "current" };
}

function cleanHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>(\r?\n)?/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .trim();
}

function unavailableFrom(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim()));
  return entries.length ? Object.fromEntries(entries.map(([key, message]) => [key, cleanHtml(message)])) : undefined;
}

export function sessionStatus(): DesktopSession {
  try {
    const baseUrl = get("baseUrl").replace(/\/+$/, "");
    if (baseUrl === CURRENT_SITE_BASE_URL) {
      return { authenticated: false, authMode: "sso", baseUrl, userId: get("userId") };
    }
    return { authenticated: Boolean(get("token")), authMode: "token", baseUrl, userId: get("userId") };
  } catch {
    return { authenticated: false };
  }
}

export async function loginWithToken(input: DesktopLoginInput, persist = false): Promise<DesktopLoginResult> {
  const baseUrl = (input.baseUrl || "https://courses.uit.edu.vn").replace(/\/+$/, "");
  if (baseUrl === CURRENT_SITE_BASE_URL) {
    throw new Error("The current UIT course site requires UIT SSO. Use the SSO sign-in button.");
  }
  const token = await requestMobileToken(baseUrl, input.username, input.password);
  const url = new URL(`${baseUrl}/webservice/rest/server.php`);
  url.searchParams.set("wstoken", token);
  url.searchParams.set("wsfunction", "core_webservice_get_site_info");
  url.searchParams.set("moodlewsrestformat", "json");
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const info = (await response.json()) as MoodleRecord;
  if (info.exception) throw new Error(String(info.message || "UIT authentication failed"));
  const userId = Number(info.userid);
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("UIT did not return a valid student identity.");
  if (persist) save(token, userId, baseUrl);
  return {
    session: { authenticated: true, authMode: "token", baseUrl, userId },
    api: createTokenApiClient(baseUrl, token),
    token
  };
}

export function createLegacySession(baseUrl: string, token: string, userId: number): DesktopLoginResult {
  return {
    session: { authenticated: true, authMode: "token", baseUrl, userId },
    api: createTokenApiClient(baseUrl, token),
    token
  };
}

export async function login(input: DesktopLoginInput): Promise<DesktopSession> {
  return (await loginWithToken(input, true)).session;
}

export function configuredLegacySession(): DesktopLoginResult | undefined {
  try {
    const session = sessionStatus();
    if (!session.authenticated || session.authMode !== "token" || !session.baseUrl) return undefined;
    const token = get("token");
    return { session, api: createTokenApiClient(session.baseUrl, token), token };
  } catch {
    return undefined;
  }
}

function mapCourse(course: MoodleRecord): CourseSummary {
  return {
    id: Number(course.id),
    shortname: String(course.shortname || ""),
    fullname: cleanHtml(course.fullname),
    summary: cleanHtml(course.summary),
    progress: typeof course.progress === "number" ? course.progress : undefined,
    startdate: Number(course.startdate || 0) || undefined,
    enddate: Number(course.enddate || 0) || undefined,
    category: course.category || course.categoryid || course.categoryname || course.coursecategory ? {
      id: Number(course.categoryid || course.category?.id || course.category) || undefined,
      name: cleanHtml(course.categoryname || course.coursecategory || course.category?.name || (typeof course.category === "string" ? course.category : "")) || undefined
    } : undefined,
    semester: normalizeSemester(course)
  };
}

export async function listCourses(api: ApiClient = defaultApiClient, userId = Number(get("userId") || 0)): Promise<CourseSummary[]> {
  const records = await metadata<MoodleRecord[]>(api, "core_enrol_get_users_courses", { userid: userId });
  if (!Array.isArray(records)) throw new Error("Invalid course list response: expected an array.");
  return records.map((raw) => {
    const course = mapCourse(raw);
    if (course.semester.source === "unknown") {
      // Local diagnostics only: values are the user's own course metadata.
      const scanYears = (value: unknown): string[] => {
        const years = new Set<string>();
        for (const match of String(value ?? "").matchAll(/(?:19|20)\d{2}/g)) years.add(match[0]);
        return [...years];
      };
      console.error(`[listCourses] unknown semester id=${course.id} evidence=${JSON.stringify({
        category: String(raw.categoryname || raw.coursecategory || raw.category?.name || raw.category || "").slice(0, 120) || null,
        summaryYears: scanYears(raw.summary),
        summaryLength: String(raw.summary ?? "").length,
        customFields: Array.isArray(raw.customfields) ? raw.customfields.map((field: MoodleRecord) => field?.shortname || field?.name) : null,
        keys: Object.keys(raw)
      })}`);
    }
    return course;
  }).sort((a, b) => b.semester.sortOrder - a.semester.sortOrder || b.id - a.id);
}

export async function lookupCourse(courseId: number, api: ApiClient, userId: number): Promise<CourseSummary> {
  if (!Number.isSafeInteger(courseId) || courseId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("A valid course and account identity is required for course lookup.");
  }
  const result = await metadata<MoodleRecord>(api, "core_course_get_courses_by_field", { field: "id", value: String(courseId) });
  const records = result?.courses;
  if (!Array.isArray(records) || records.length !== 1 ||
      !["number", "string"].includes(typeof records[0]?.id) || Number(records[0].id) !== courseId) {
    throw new Error("Moodle did not return the requested course.");
  }
  const raw = records[0];
  const course = mapCourse(raw);
  if (typeof raw.fullname !== "string" || !course.fullname || /(?:\.{3}|\u2026)$/.test(course.fullname)) {
    throw new Error("Moodle did not return a complete course title.");
  }
  // Metadata can describe courses outside enrolments; contents enforce actual access.
  await getCourseContents(courseId, api);
  return { ...course, discoveredVia: "url" };
}

export async function getCourseContents(courseId: number, api: ApiClient = defaultApiClient): Promise<CourseModule[]> {
  const sections = await metadata<MoodleRecord[]>(api, "core_course_get_contents", { courseid: courseId });
  if (!Array.isArray(sections)) throw new Error("Invalid course contents response: expected an array.");
  const modules: CourseModule[] = [];
  for (const section of sections || []) {
    for (const module of section.modules || []) {
      modules.push({
        id: Number(module.id),
        name: cleanHtml(module.name),
        modname: String(module.modname || "unknown"),
        url: credentialFreeUrl(module.url),
        description: cleanHtml(module.description),
        section: cleanHtml(section.name) || "Course materials",
        instance: Number(module.instance) || undefined,
        unavailable: unavailableFrom(module.unavailable),
        files: filesFrom(module.contents, module.introfiles, module.attachments),
        urls: (module.contents || []).filter((item: MoodleRecord) => item.type === "url").flatMap((item: MoodleRecord) => {
          const url = credentialFreeUrl(item.fileurl);
          return url ? [{ name: cleanHtml(item.filename || item.name || url), url }] : [];
        })
      });
    }
  }
  if (modules.some((module) => module.modname === "assign")) {
    // Assignment intros and attachments live in mod_assign_get_assignments, not
    // the course contents. The desktop reader shows list data directly, so merge
    // them here; anything unresolved keeps its module metadata.
    try {
      const byModule = new Map((await listAssignments(courseId, api)).map((assignment) => [assignment.moduleId, assignment]));
      for (const module of modules) {
        if (module.modname !== "assign") continue;
        const assignment = byModule.get(module.id);
        if (!assignment) continue;
        if (assignment.description) module.description = assignment.description;
        module.files = filesFrom(module.files, assignment.files);
        module.unavailable = unavailableFrom({ ...module.unavailable, ...assignment.unavailable });
        if (assignment.url && !module.url) module.url = assignment.url;
      }
    } catch (error) {
      const code = (error as { errorcode?: string })?.errorcode;
      // Only missing supplemental functionality is optional, never access or transport failures.
      if (!/^(?:invalidfunction|cannotfindfunction|wsfunctionnotavailable)$/.test(code || "") &&
          (code !== undefined || !/^This UIT site does not expose mod_assign_get_assignments to the SSO session\./.test(String((error as Error)?.message)))) throw error;
    }
  }
  return modules;
}

export async function listAssignments(courseId: number, api: ApiClient = defaultApiClient): Promise<AssignmentSummary[]> {
  const result = await metadata<MoodleRecord>(api, "mod_assign_get_assignments", { "courseids[0]": courseId });
  const course = (result.courses || []).find((entry: MoodleRecord) => Number(entry.id) === courseId);
  return (course?.assignments || []).map((assignment: MoodleRecord): AssignmentSummary => {
    const instance = Number(assignment.id);
    const cmid = Number(assignment.cmid);
    const id = Number.isSafeInteger(instance) && instance > 0 ? instance : undefined;
    const moduleId = Number.isSafeInteger(cmid) && cmid > 0 ? cmid : undefined;
    if (id === undefined && moduleId === undefined) throw new Error("Assignment identity unavailable. Open the assignment on the course site for its details.");
    return {
      id,
      resourceRef: id !== undefined ? { kind: "assignment", id, moduleId } : { kind: "module", id: moduleId! },
      courseId,
      moduleId,
      name: cleanHtml(assignment.name),
      description: cleanHtml(assignment.intro),
      dueDate: Number(assignment.duedate || 0) || undefined,
      cutoffDate: Number(assignment.cutoffdate || 0) || undefined,
      allowsubmissionsfromdate: Number(assignment.allowsubmissionsfromdate || 0) || undefined,
      files: filesFrom(assignment.introattachments, assignment.introfiles, assignment.attachments),
      url: credentialFreeUrl(assignment.url),
      grade: typeof assignment.grade === "number" ? assignment.grade : undefined,
      submissionStatement: cleanHtml(assignment.submissionstatement),
      unavailable: unavailableFrom({ ...(id === undefined ? { instance: "Assignment instance unavailable. Open the assignment on the course site for its full details." } : {}), ...assignment.unavailable })
    };
  }).sort((a: AssignmentSummary, b: AssignmentSummary) => (a.dueDate || Number.POSITIVE_INFINITY) - (b.dueDate || Number.POSITIVE_INFINITY));
}

export interface AssignmentSubmission {
  assignId: number;
  moduleId?: number;
  status: string;
  grade?: string;
  files: CourseFile[];
  unavailable?: Record<string, string>;
}

export async function getAssignmentSubmission(courseId: number, reference: { assignId?: number; moduleId?: number }, api: ApiClient = defaultApiClient): Promise<AssignmentSubmission> {
  if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new Error("Invalid course reference.");
  let { assignId, moduleId } = reference;
  if ((assignId === undefined || !Number.isSafeInteger(assignId) || assignId <= 0) && moduleId !== undefined) {
    const match = (await listAssignments(courseId, api)).find((item) => item.moduleId === moduleId);
    assignId = match?.id;
    moduleId = match?.moduleId ?? moduleId;
  }
  if (assignId === undefined || !Number.isSafeInteger(assignId) || assignId <= 0) {
    throw new Error("Assignment instance unavailable. Open the assignment on the course site for submission details.");
  }
  if (moduleId === undefined) {
    moduleId = (await listAssignments(courseId, api)).find((item) => item.id === assignId)?.moduleId;
  }
  // SSO sessions without this WS function fall back to the assignment page read.
  const result = await metadata<MoodleRecord>(api, "mod_assign_get_submission_status", { assignid: assignId });
  const submission = result?.lastattempt?.submission;
  const plugins = Array.isArray(submission?.plugins) ? submission.plugins : [];
  const files = filesFrom(...plugins.filter((plugin: MoodleRecord) => plugin?.type === "file").flatMap((plugin: MoodleRecord) => (plugin.fileareas || []).map((area: MoodleRecord) => area.files)));
  return {
    assignId, moduleId,
    status: cleanHtml(submission?.status) || "unknown",
    grade: cleanHtml(result?.feedback?.gradefordisplay) || undefined,
    files,
    unavailable: unavailableFrom({ ...result?.unavailable, ...submission?.unavailable })
  };
}

export async function listAnnouncements(courseId: number, api: ApiClient = defaultApiClient): Promise<AnnouncementSummary[]> {
  const forums = await metadata<MoodleRecord[]>(api, "mod_forum_get_forums_by_courses", { "courseids[0]": courseId });
  const selectedForums = forums.filter((forum) => (!forum.course || Number(forum.course) === courseId) && (forum.type === "news" || (!forum.type && forum.unavailable)));
  // News forums often hide their instance ID from students, but the module ID
  // still opens the same discussion list, so resolve the read key per forum.
  const readers = selectedForums.map((forum) => {
    const forumId = Number(forum.id);
    const cmid = Number(forum.cmid);
    const open = `Open ${credentialFreeUrl(forum.url) || "the forum on the course site"} to read announcements.`;
    if (forum.type === "news" && Number.isSafeInteger(forumId) && forumId > 0) {
      return { forum, key: { forumid: forumId }, forumId };
    }
    if ((forum.type === "news" || !forum.type) && Number.isSafeInteger(cmid) && cmid > 0) {
      return { forum, key: { cmid }, forumId: Number.isSafeInteger(forumId) && forumId > 0 ? forumId : undefined };
    }
    throw new Error(`Announcement forum instance unavailable. ${open}`);
  });
  const groups = await Promise.all(readers.map(async ({ forum, key, forumId }) => {
    const discussions: AnnouncementSummary[] = [];
    const seen = new Set<number>();
    for (let page = 0; ; page++) {
      const result = await metadata<MoodleRecord>(api, "mod_forum_get_forum_discussions", { ...key, page, perpage: 100 });
      const entries = result.discussions || [];
      let added = 0;
      for (const discussion of entries) {
        const id = Number(discussion.discussion ?? discussion.id);
        if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        added++;
        discussions.push({
          id, courseId,
          moduleId: Number(forum.cmid) || undefined, forumId,
          subject: cleanHtml(discussion.subject || discussion.name),
          author: cleanHtml(discussion.userfullname),
          message: cleanHtml(discussion.message),
          timestamp: Number(discussion.timemodified || discussion.created || 0) || undefined,
          replies: Number(discussion.numreplies || 0),
          files: filesFrom(discussion.attachments, discussion.messageinlinefiles),
          url: credentialFreeUrl(discussion.url),
          unavailable: unavailableFrom({ ...forum.unavailable, ...discussion.unavailable })
        });
      }
      // A module-page read may repeat the first page; only new discussions advance.
      if (entries.length < 100 || added === 0) break;
      if (page >= 999) throw new Error("Announcement pagination exceeded the safety limit.");
    }
    return discussions;
  }));
  return groups.flat().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export async function listForumDiscussions(courseId: number, moduleId: number, api: ApiClient = defaultApiClient): Promise<AnnouncementSummary[]> {
  if (!Number.isSafeInteger(courseId) || courseId <= 0 || !Number.isSafeInteger(moduleId) || moduleId <= 0) throw new Error("Invalid forum reference.");
  const module = (await getCourseContents(courseId, api)).find((item) => item.id === moduleId);
  if (!module || module.modname !== "forum") throw new Error("This activity is not a forum. Open it on the course site instead.");
  const forumId = Number(module.instance);
  const read = async (key: Record<string, number>): Promise<AnnouncementSummary[]> => {
    const discussions: AnnouncementSummary[] = [];
    const seen = new Set<number>();
    for (let page = 0; ; page++) {
      const result = await metadata<MoodleRecord>(api, "mod_forum_get_forum_discussions", { ...key, page, perpage: 100 });
      const entries = result.discussions || [];
      let added = 0;
      for (const discussion of entries) {
        const id = Number(discussion.discussion ?? discussion.id);
        if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        added++;
        discussions.push({
          id, courseId,
          moduleId, forumId: Number.isSafeInteger(forumId) && forumId > 0 ? forumId : undefined,
          subject: cleanHtml(discussion.subject || discussion.name),
          author: cleanHtml(discussion.userfullname),
          message: cleanHtml(discussion.message),
          timestamp: Number(discussion.timemodified || discussion.created || 0) || undefined,
          replies: Number(discussion.numreplies || 0),
          files: filesFrom(discussion.attachments, discussion.messageinlinefiles),
          url: credentialFreeUrl(discussion.url),
          unavailable: unavailableFrom({ ...module.unavailable, ...discussion.unavailable })
        });
      }
      // A module-page read may repeat the first page; only new discussions advance.
      if (entries.length < 100 || added === 0) break;
      if (page >= 999) throw new Error("Forum pagination exceeded the safety limit.");
    }
    return discussions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  };
  try {
    return await read({ cmid: moduleId });
  } catch (error) {
    // Older Moodle releases only accept a forum instance ID, never a cmid.
    if (!Number.isSafeInteger(forumId) || forumId <= 0) throw error;
    return await read({ forumid: forumId });
  }
}

export async function listCourseParticipants(courseId: number, api: ApiClient = defaultApiClient): Promise<CourseParticipant[]> {
  const users = await metadata<MoodleRecord[]>(api, "core_enrol_get_enrolled_users", { courseid: courseId });
  if (!Array.isArray(users)) return [];
  return users
    .map((user) => {
      const participant: CourseParticipant = {
        id: Number(user.id),
        fullname: String(user.fullname || "").trim(),
        roles: Array.isArray(user.roles)
          ? user.roles.map((r: any) => String(r.shortname || r.name || r).trim()).filter(Boolean)
          : []
      };
      if (user.email) participant.email = String(user.email).trim();
      if (user.profileimageurl || user.profileimageurlsmall) {
        participant.avatar = String(user.profileimageurl || user.profileimageurlsmall).trim();
      }
      if (user.lastaccess) participant.lastAccess = String(user.lastaccess).trim();
      if (Array.isArray(user.groups) && user.groups.length) {
        participant.groups = user.groups.map((g: any) => String(g.name || g)).filter(Boolean);
      }
      return participant;
    })
    .filter((u) => u.fullname);
}

export async function getCourseGrades(courseId: number, api: ApiClient = defaultApiClient, userId = Number(get("userId") || 0)): Promise<CourseGradeItem[]> {
  const params: Record<string, any> = { courseid: courseId };
  if (userId > 0) params.userid = userId;
  const result = await metadata<MoodleRecord>(api, "gradereport_user_get_grade_items", params);
  const items = result?.usergrades?.[0]?.gradeitems || [];
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && (item.itemname || item.itemtype === "course"))
    .map((item) => ({
      item: String(item.itemname || "Course total").trim(),
      grade: item.gradeformatted != null && item.gradeformatted !== "-" ? String(item.gradeformatted).trim() : undefined,
      max: item.grademax != null ? String(item.grademax).trim() : undefined,
      percentage: item.percentageformatted != null && item.percentageformatted !== "-" ? String(item.percentageformatted).trim() : undefined,
      feedback: item.feedback ? cleanHtml(item.feedback) : undefined
    }));
}

export interface CourseResourceReference {
  kind: "module" | "file" | "assignment" | "announcement";
  id: number;
  moduleId?: number;
  fileUrl?: string;
}

export interface ResolvedCourseResource {
  kind: CourseResourceReference["kind"];
  id: number;
  moduleId?: number;
  name: string;
  description: string;
  url?: string;
  files?: CourseFile[];
  unavailable?: Record<string, string>;
}

export async function resolveCourseResource(courseId: number, reference: CourseResourceReference, api: ApiClient = defaultApiClient): Promise<ResolvedCourseResource> {
  if (!Number.isSafeInteger(courseId) || courseId <= 0 || !reference || !Number.isSafeInteger(reference.id) || reference.id <= 0 ||
      (reference.moduleId !== undefined && (!Number.isSafeInteger(reference.moduleId) || reference.moduleId <= 0))) {
    throw new Error("Invalid course resource identity.");
  }
  let resource: ResolvedCourseResource | undefined;
  const fileUrl = reference.fileUrl === undefined ? undefined : credentialFreeUrl(reference.fileUrl);
  if (reference.fileUrl !== undefined && !fileUrl) throw new Error("Invalid course file reference.");
  if (reference.kind === "assignment") {
    const assignment = (await listAssignments(courseId, api)).find((item) => item.id === reference.id);
    if (assignment) resource = { kind: reference.kind, id: reference.id, moduleId: assignment.moduleId, name: assignment.name, description: assignment.description || "", url: assignment.url, files: assignment.files, unavailable: assignment.unavailable };
  } else if (reference.kind === "announcement") {
    const announcement = (await listAnnouncements(courseId, api)).find((item) => item.id === reference.id);
    if (announcement) resource = { kind: reference.kind, id: announcement.id, moduleId: announcement.moduleId, name: announcement.subject, description: announcement.message, url: announcement.url, files: announcement.files, unavailable: announcement.unavailable };
  } else if (reference.kind === "module" || reference.kind === "file") {
    // File IDs identify their owning module; Moodle content files have no stable numeric ID.
    const moduleId = reference.moduleId ?? reference.id;
    const module = (await getCourseContents(courseId, api)).find((item) => item.id === moduleId);
    if (module && module.id === reference.id) {
      let files = module.files;
      let description = module.description || "";
      let unavailable = module.unavailable;
      if (module.modname === "assign") {
        try {
          const assignment = (await listAssignments(courseId, api)).find((item) => item.moduleId === module.id);
          if (assignment) { files = filesFrom(files, assignment.files); description = assignment.description || description; unavailable = unavailableFrom({ ...unavailable, ...assignment.unavailable }); }
        } catch (error) {
          const code = (error as { errorcode?: string })?.errorcode;
          // Only missing supplemental functionality is optional, never access or transport failures.
          if (!/^(?:invalidfunction|cannotfindfunction|wsfunctionnotavailable)$/.test(code || "") &&
              (code !== undefined || !/^This UIT site does not expose mod_assign_get_assignments to the SSO session\./.test(String((error as Error)?.message)))) throw error;
        }
      } else if (module.modname === "forum" && reference.kind === "file" && !files.some((file) => file.fileurl === fileUrl)) {
        const announcements = (await listAnnouncements(courseId, api)).filter((item) => item.moduleId === module.id);
        files = filesFrom(files, ...announcements.map((item) => item.files));
        const owner = announcements.find((item) => item.files.some((file) => file.fileurl === fileUrl));
        if (owner) { description = owner.message; unavailable = unavailableFrom({ ...unavailable, ...owner.unavailable }); }
      }
      if (reference.kind === "file") {
        const file = files.find((item) => item.fileurl === fileUrl);
        if (file) resource = { kind: "file", id: reference.id, moduleId: module.id, name: file.filename, description, url: file.fileurl, files: [file], unavailable };
      } else resource = { kind: "module", id: module.id, moduleId: module.id, name: module.name, description, url: module.url, files, unavailable };
    }
    if (!resource && reference.kind === "file" && fileUrl) {
      try {
        const assignments = await listAssignments(courseId, api);
        const match = assignments.find((a) => (a.moduleId === moduleId || a.id === reference.id || (reference.moduleId !== undefined && a.moduleId === reference.moduleId)) && a.files.some((f) => f.fileurl === fileUrl));
        if (match) {
          const file = match.files.find((f) => f.fileurl === fileUrl);
          if (file) {
            const resModuleId = match.moduleId ?? reference.moduleId ?? reference.id;
            resource = { kind: "file", id: reference.id, moduleId: resModuleId, name: file.filename, description: match.description || "", url: file.fileurl, files: [file], unavailable: match.unavailable };
          }
        }
      } catch {
        // Assignment metadata is an optional fallback for resolving this resource.
      }
      if (!resource) {
        try {
          const announcements = await listAnnouncements(courseId, api);
          const match = announcements.find((a) => (a.moduleId === moduleId || a.id === reference.id || (reference.moduleId !== undefined && a.moduleId === reference.moduleId)) && a.files.some((f) => f.fileurl === fileUrl));
          if (match) {
            const file = match.files.find((f) => f.fileurl === fileUrl);
            if (file) {
              const resModuleId = match.moduleId ?? reference.moduleId ?? reference.id;
              resource = { kind: "file", id: reference.id, moduleId: resModuleId, name: file.filename, description: match.message || "", url: file.fileurl, files: [file], unavailable: match.unavailable };
            }
          }
        } catch {
          // Announcement metadata is an optional fallback for resolving this resource.
        }
      }
    }
  }
  if (!resource || (reference.moduleId !== undefined && reference.moduleId !== resource.moduleId) ||
      (fileUrl !== undefined && !resource.files?.some((file) => file.fileurl === fileUrl))) {
    throw new Error("This resource does not belong to the selected course or is no longer available. Refresh the course and try again.");
  }
  return resource;
}

async function courseFile(courseId: number, fileUrl: string, api: ApiClient): Promise<CourseFile> {
  if (!Number.isSafeInteger(courseId) || courseId <= 0 || !fileUrl) throw new Error("Invalid course file reference.");
  const cleanUrl = credentialFreeUrl(fileUrl);
  if (!cleanUrl) throw new Error("Invalid course file reference.");
  fileUrl = cleanUrl;
  const modules = await getCourseContents(courseId, api);
  const file = modules.flatMap((module) => module.files).find((item) => item.fileurl === fileUrl);
  if (file) return file;
  if (modules.some((module) => module.modname === "assign")) {
    const attachment = (await listAssignments(courseId, api)).flatMap((assignment) => assignment.files).find((item) => item.fileurl === fileUrl);
    if (attachment) return attachment;
    // Submitted files are only listed by the submission status, never by contents.
    if (/assignsubmission|mod_assign\/submission/.test(fileUrl)) {
      for (const assignment of await listAssignments(courseId, api)) {
        if (assignment.id === undefined) continue;
        try {
          const match = (await getAssignmentSubmission(courseId, { assignId: assignment.id }, api)).files.find((item) => item.fileurl === fileUrl);
          if (match) return match;
        } catch { /* This assignment exposes no readable submission; keep looking. */ }
      }
    }
  }
  if (modules.some((module) => module.modname === "forum")) {
    const attachment = (await listAnnouncements(courseId, api)).flatMap((announcement) => announcement.files).find((item) => item.fileurl === fileUrl);
    if (attachment) return attachment;
  }
  throw new Error("This file does not belong to the selected course. Refresh the course and try again.");
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PREVIEW_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif"]);
// Only these formats preview in UIT Studio. Everything else is download-only,
// so binary formats never reach the reader and its error panel.
function previewMimeFor(filename: string, reported?: string): string {
  const ext = extname(filename).toLowerCase();
  const types: Record<string, string> = {
    ".pdf": "application/pdf", ".docx": DOCX_MIME,
    ".md": "text/markdown", ".markdown": "text/markdown", ".py": "text/x-python",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif",
  };
  return reported || types[ext] || "";
}
export function previewableMime(mimeType: string, filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return mimeType === "application/pdf" || mimeType === DOCX_MIME || PREVIEW_IMAGE_MIME.has(mimeType) ||
    mimeType === "text/markdown" || mimeType === "text/x-markdown" ||
    mimeType === "text/x-python" || mimeType === "application/x-python" ||
    // Converted documents arrive as plain text; only trust them by extension.
    (mimeType === "text/plain" && (ext === ".md" || ext === ".markdown" || ext === ".py" || ext === ".docx"));
}
export async function previewFile(courseId: number, fileUrl: string, _filename: string, api: ApiClient = defaultApiClient): Promise<{ mimeType: string; data: string; filename: string }> {
  const file = await courseFile(courseId, fileUrl, api);
  if (file.filesize > MAX_PREVIEW_BYTES) throw new Error("Preview is limited to 25 MB. Download this file explicitly instead.");
  if (!api.readFile) throw new Error("This session does not support authenticated previews. Sign in again or download the file explicitly.");
  const result = await api.readFile(file.fileurl);
  if (result.data.byteLength > MAX_PREVIEW_BYTES) throw new Error("Preview is limited to 25 MB. Download this file explicitly instead.");
  const reported = result.mimeType.split(";")[0].trim().toLowerCase();
  const mimeType = reported && reported !== "application/octet-stream"
    ? reported
    : previewMimeFor(file.filename, file.mimetype?.toLowerCase());
  if (!previewableMime(mimeType, file.filename)) {
    throw new Error(`Preview is not supported for ${mimeType || extname(file.filename) || "this format"}. Download the file explicitly to open it in another application.`);
  }
  // Word documents preview as extracted plain text, never executed content.
  if (mimeType === DOCX_MIME) {
    const { default: mammoth } = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(result.data) });
    return { mimeType: "text/plain", data: Buffer.from(value).toString("base64"), filename: file.filename };
  }
  return { mimeType, data: Buffer.from(result.data).toString("base64"), filename: file.filename };
}

export interface CourseIdentity { baseUrl: string; userId: number; shortname?: string }

export function workspacePath(courseId: number, baseUrl: string, userId: number): string {
  if (!Number.isSafeInteger(courseId) || courseId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) throw new Error("A valid course and account identity is required for the workspace.");
  const site = new URL(baseUrl);
  if (!/^https?:$/.test(site.protocol) || site.username || site.password) throw new Error("Invalid course site URL.");
  const canonical = `${site.origin}${site.pathname.replace(/\/+$/, "")}`;
  const siteKey = `${site.hostname.replace(/[^a-zA-Z0-9.-]/g, "_")}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
  return resolve(homedir(), ".uit", "courses", siteKey, `user-${userId}`, `course-${courseId}`);
}

async function ensureWorkspaceDirectories(root: string, children: string[]): Promise<void> {
  const coursesRoot = resolve(homedir(), ".uit", "courses");
  const relativeRoot = relative(coursesRoot, root);
  if (!relativeRoot || relativeRoot.startsWith("..") || resolve(coursesRoot, relativeRoot) !== root) {
    throw new Error("Invalid UIT workspace path.");
  }

  // Create and verify one component at a time. A recursive mkdir beneath a
  // hostile symlink could otherwise create files outside the UIT workspace.
  const paths = [
    resolve(homedir(), ".uit"),
    coursesRoot,
    ...relativeRoot.split(sep).reduce<string[]>((items, part) => {
      items.push(join(items.at(-1) || coursesRoot, part));
      return items;
    }, []),
    ...children.map((child) => join(root, child))
  ];
  for (const path of paths) {
    await mkdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== resolve(path)) {
      throw new Error("UIT workspace directories must not be symbolic links.");
    }
  }
}

const downloads = new Map<string, Promise<string>>();

function openFilePath(fd: number): string {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  throw new Error("Secure course downloads are currently supported on macOS and Linux.");
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function materializeFile(courseId: number, fileUrl: string, _filename: string, api: ApiClient = defaultApiClient, identity?: CourseIdentity): Promise<string> {
  const owner = identity || (api === defaultApiClient ? { baseUrl: get("baseUrl"), userId: Number(get("userId")) } : undefined);
  if (!owner) throw new Error("Site and account identity are required to download a course file.");
  const root = workspacePath(courseId, owner.baseUrl, owner.userId);
  const file = await courseFile(courseId, fileUrl, api);
  const safeName = basename(file.filename.replace(/\\/g, "/")).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180);
  if (!safeName || /^\.+$/.test(safeName)) throw new Error("Invalid course filename.");
  const url = new URL(file.fileurl, owner.baseUrl);
  if (url.origin !== new URL(owner.baseUrl).origin) throw new Error("Course file belongs to another origin.");
  // Credentials rotate independently of content; metadata revisions invalidate same-URL updates.
  url.searchParams.sort();
  const hash = createHash("sha256").update(JSON.stringify([url.href, file.filesize, file.timemodified || 0])).digest("hex");
  const destination = join(root, "materials", hash, safeName);
  const existing = downloads.get(destination);
  if (existing) return existing;
  const pending = (async () => {
    await ensureWorkspaceDirectories(root, ["materials", join("materials", hash)]);
    const directory = dirname(destination);
    try {
      const info = await lstat(destination);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("Course download destination is not a regular file.");
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // Create without following the final component, then stream through the
    // verified file descriptor. Even if an Agent swaps a parent directory after
    // validation, authenticated bytes remain pinned to this exact new inode.
    const handle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    const openedInfo = await handle.stat();
    let complete = false;
    try {
      const pathInfo = await lstat(destination);
      if (!sameFile(openedInfo, pathInfo) || await realpath(directory) !== directory) {
        throw new Error("UIT workspace directories must not be symbolic links.");
      }
      await api.downloadFile(file.fileurl, openFilePath(handle.fd), { atomic: false });
      const completedInfo = await lstat(destination).catch(() => undefined);
      if (!completedInfo || !sameFile(openedInfo, completedInfo) || await realpath(directory).catch(() => "") !== directory) {
        throw new Error("UIT workspace directories must not be symbolic links.");
      }
      complete = true;
      return destination;
    } finally {
      if (!complete) {
        await handle.truncate(0).catch(() => undefined);
        const currentInfo = await lstat(destination).catch(() => undefined);
        if (currentInfo && sameFile(openedInfo, currentInfo)) await rm(destination, { force: true }).catch(() => undefined);
      }
      await handle.close();
    }
  })();
  downloads.set(destination, pending);
  try { return await pending; }
  finally { if (downloads.get(destination) === pending) downloads.delete(destination); }
}

export async function courseWorkspace(courseId: number, _shortname: string, baseUrl = CURRENT_SITE_BASE_URL, userId = Number(get("userId"))): Promise<WorkspaceInfo> {
  const path = workspacePath(courseId, baseUrl, userId);
  let created = false;
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    created = true;
  }
  await ensureWorkspaceDirectories(path, [".uit", join(".uit", "context"), "materials", "artifacts"]);
  return { path, courseId, created };
}

export async function codexStatus(): Promise<{ installed: boolean; version?: string; path?: string; message: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const result = await promisify(execFile)("codex", ["--version"], { timeout: 5_000 });
    const version = result.stdout.trim() || result.stderr.trim();
    return { installed: true, version, path: "codex", message: "Codex CLI detected" };
  } catch {
    return { installed: false, message: "Install and authenticate Codex CLI to enable Agentic Mode" };
  }
}
