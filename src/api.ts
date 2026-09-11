import { createWriteStream, mkdirSync, openAsBlob } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get } from "./config.js";
import { buildAjaxInfo, unwrapAjaxResponse } from "./ajax-helpers.js";
import type { ApiClient, MoodleRecord } from "./types.js";

declare module "./types.js" {
  interface ApiClient {
    readFile?(url: string): Promise<{ data: Uint8Array; mimeType: string }>;
  }
}

export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

function unavailableSessionMethod(error: unknown): boolean {
  const code = String((error as { errorcode?: string })?.errorcode || "");
  if (code && !/^(?:moodle_exception|webservice_exception)$/i.test(code)) {
    return /^(?:invalid_parameter_exception|invalidparameter|servicenotavailable|invalidfunction|cannotfindfunction|wsfunctionnotavailable)$/i.test(code);
  }
  return /(?:unknown method|not available for ajax|not callable via ajax|cannot find.*function|web\s*service is not available)/i.test(String(error));
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .trim();
}

function fileRecord(rawUrl: string, pageUrl: string): MoodleRecord | undefined {
  try {
    const url = new URL(rawUrl, pageUrl);
    if (url.origin !== new URL(pageUrl).origin || !/(?:token)?pluginfile\.php(?:\/|$)/i.test(url.pathname)) return undefined;
    let filename = basename(url.pathname) || "resource";
    try { filename = decodeURIComponent(filename); } catch { /* Preserve malformed Moodle filenames verbatim. */ }
    return { type: "file", filename, fileurl: url.toString(), filesize: 0 };
  } catch { return undefined; }
}

/** Public resource URLs must not carry session credentials or Moodle core_files keys. */
export function credentialFreeUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) return undefined;
    url.username = ""; url.password = ""; url.hash = "";
    const signed = /^(.*?)\/tokenpluginfile\.php(\/.*)?$/.exec(url.pathname);
    if (signed) {
      // Moodle make_pluginfile_url puts the core_files key before the context ID
      // with slash arguments, or in ?token= when using ?file= instead.
      const path = signed[2] || "";
      if (path && !/^\/[a-zA-Z0-9]+\/\d+\//.test(path)) return undefined;
      url.pathname = `${signed[1]}/pluginfile.php${path.replace(/^\/[^/]+/, "")}`;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/token|sesskey|password|auth|secret|credential|^(?:key|signature|sig|ticket|session)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return undefined; }
}

/** Follow redirects manually so credentials never leave the authenticated origin. */
export async function fetchCourseFile(baseUrl: string, fileUrl: string, headers: Record<string, string> = {}, token?: string): Promise<Response> {
  const base = new URL(baseUrl);
  const installationPath = base.pathname.replace(/\/+$/, "");
  let url = new URL(fileUrl, `${baseUrl.replace(/\/+$/, "")}/`);
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.origin !== base.origin || url.username || url.password) throw new Error("Refusing to send UIT credentials to another origin.");
    if (/\/login(?:\/|$)/i.test(url.pathname)) throw new Error("UIT session expired. Please sign in again.");
    const clean = credentialFreeUrl(url.href);
    if (!clean) throw new Error("Unsupported course file URL.");
    url = new URL(clean);
    const path = url.pathname.slice(installationPath.length);
    const pluginfile = url.pathname.startsWith(`${installationPath}/`) && /^\/(?:webservice\/)?pluginfile\.php(?:\/|$)/.test(path);
    if (token && !pluginfile) throw new Error("Unsupported token course file endpoint.");
    if (pluginfile) {
      // https://moodledev.io/docs/4.5/apis/subsystems/external/files
      // Mobile tokens use webservice/pluginfile; cookies use ordinary pluginfile.
      url.pathname = `${installationPath}${path.replace(/^\/(?:webservice\/)?pluginfile\.php/, token ? "/webservice/pluginfile.php" : "/pluginfile.php")}`;
    }
    if (token) url.searchParams.set("token", token);
    const response = await fetch(url, { headers, redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Course file redirect has no destination.");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    // Sniff the beginning even when Moodle labels its login page as a binary file.
    if (!response.body) throw new Error("Empty course file response.");
    const reader = response.body.getReader();
    const prefix: Uint8Array[] = [];
    let size = 0;
    try {
      while (size < 8192) {
        const chunk = await reader.read();
        if (chunk.done) break;
        prefix.push(chunk.value);
        size += chunk.value.byteLength;
      }
      const text = Buffer.concat(prefix).subarray(0, 8192).toString("utf8");
      if (/(?:<form\b[^>]*(?:login|signin)|name\s*=\s*["']?(?:password|logintoken)\b|id\s*=\s*["']?login(?:btn|form)\b|<title[^>]*>[^<]*(?:log\s*in|sign\s*in))/i.test(text)) {
        throw new Error("UIT returned a login page instead of a file. Please sign in again.");
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of prefix) controller.enqueue(chunk); },
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { return reader.cancel(reason); }
    }), { headers: response.headers });
  }
  throw new Error("Too many course file redirects.");
}

export async function readCourseFile(response: Response): Promise<{ data: Uint8Array; mimeType: string }> {
  if (Number(response.headers.get("content-length")) > MAX_PREVIEW_BYTES) {
    await response.body?.cancel();
    throw new Error("Preview is limited to 25 MB. Download this file explicitly instead.");
  }
  if (!response.body) throw new Error("Empty course file response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_PREVIEW_BYTES) throw new Error("Preview is limited to 25 MB. Download this file explicitly instead.");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  return { data: Buffer.concat(chunks, size), mimeType: (response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase() };
}

export async function writeCourseFile(response: Response, destPath: string, options: { atomic?: boolean } = {}): Promise<{ sha256: string }> {
  if (!response.body) throw new Error("Empty course file response.");
  const hash = createHash("sha256");
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  if (options.atomic === false) {
    await pipeline(Readable.fromWeb(response.body as any), hashingStream, createWriteStream(destPath));
    return { sha256: hash.digest("hex") };
  }
  mkdirSync(dirname(destPath) || ".", { recursive: true });
  const temporaryPath = `${destPath}.part-${randomUUID()}`;
  try {
    await pipeline(Readable.fromWeb(response.body as any), hashingStream, createWriteStream(temporaryPath, { flags: "wx" }));
    await rename(temporaryPath, destPath);
    return { sha256: hash.digest("hex") };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function appendParams(url: URL, params: Record<string, any>): void {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
}

export function createTokenApiClient(baseUrl: string, token: string): ApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const callWithToken = async <T = any>(name: string, params: Record<string, any> = {}): Promise<T> => {
    const url = new URL(`${normalizedBaseUrl}/webservice/rest/server.php`);
    appendParams(url, {
      ...params,
      wstoken: token,
      wsfunction: name,
      moodlewsrestformat: "json"
    });

    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const data = await response.json();
    if (data && typeof data === "object" && "exception" in data) {
      const error = new Error(data.message || data.error || JSON.stringify(data)) as Error & {
        errorcode?: string;
        moodleException?: string;
      };
      if (typeof data.errorcode === "string") error.errorcode = data.errorcode;
      if (typeof data.exception === "string") error.moodleException = data.exception;
      throw error;
    }
    return data as T;
  };

  const uploadWithToken = async (filepath: string): Promise<MoodleRecord> => {
    const form = new FormData();
    form.append("token", token);
    form.append("filearea", "draft");
    form.append("itemid", "0");
    form.append("file", await openAsBlob(filepath), basename(filepath));

    const response = await fetch(`${normalizedBaseUrl}/webservice/upload.php`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const data = await response.json();
    if (Array.isArray(data) && data.length > 0) return data[0];
    if (data && typeof data === "object" && "error" in data) throw new Error(String(data.error));
    return data as MoodleRecord;
  };

  const downloadWithToken = async (fileUrl: string, destPath: string, options?: { atomic?: boolean }): Promise<{ sha256: string }> => {
    return writeCourseFile(await fetchCourseFile(normalizedBaseUrl, fileUrl, {}, token), destPath, options);
  };

  return {
    call: callWithToken, uploadFile: uploadWithToken, downloadFile: downloadWithToken,
    readFile: async (fileUrl) => readCourseFile(await fetchCourseFile(normalizedBaseUrl, fileUrl, {}, token))
  };
}

export async function call<T = any>(name: string, params: Record<string, any> = {}): Promise<T> {
  return defaultApiClient.call<T>(name, params);
}

export async function uploadFile(filepath: string): Promise<MoodleRecord> {
  return defaultApiClient.uploadFile(filepath);
}

export async function downloadFile(fileUrl: string, destPath: string, options?: { atomic?: boolean }): Promise<{ sha256: string } | void> {
  return defaultApiClient.downloadFile(fileUrl, destPath, options);
}

export class NodeSessionApiClient implements ApiClient {
  constructor(
    public readonly baseUrl: string,
    public readonly sesskey: string,
    public readonly cookieHeader: string
  ) {}

  async callRaw<T = any>(name: string, params: Record<string, any> = {}): Promise<T> {
    const info = buildAjaxInfo(name, params);
    const endpoint = `${this.baseUrl}/lib/ajax/service.php?sesskey=${encodeURIComponent(this.sesskey)}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookieHeader
      },
      body: info,
      signal: AbortSignal.timeout(30_000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    return unwrapAjaxResponse(data) as T;
  }

  private async fetchHtmlPage(path: string): Promise<{ html: string; url: string }> {
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin) throw new Error("Course page belongs to another origin.");
    const res = await fetch(url, {
      headers: { Cookie: this.cookieHeader },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000)
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location") || "";
      throw new Error(/\/login(?:\/|$)/i.test(new URL(location, url).pathname)
        ? "UIT session expired. Please sign in again."
        : `Unexpected Moodle redirect (${res.status}).`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const contentType = res.headers.get("content-type") || "";
    if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType) || /attachment/i.test(res.headers.get("content-disposition") || "")) {
      await res.body?.cancel();
      throw new Error("Expected a Moodle HTML page, not a download.");
    }
    const html = await res.text();
    if (/(?:name\s*=\s*["'](?:logintoken|password)["']|class\s*=\s*["'][^"']*\b(?:notloggedin|guestuser)\b|href\s*=\s*["'][^"']*\/login\/index\.php)/i.test(html)) {
      throw new Error("UIT session expired. Please sign in again.");
    }
    if (/(?:class\s*=\s*["'][^"']*(?:errorbox|alert-danger|notifyproblem)\b|data-rel\s*=\s*["']fatalerror["'])/i.test(html)) {
      throw new Error("Moodle could not display this page.");
    }
    return { html, url: url.toString() };
  }

  private async fetchCourseContentsHtml(courseId: number): Promise<MoodleRecord[]> {
    if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new Error("Invalid course ID.");
    const { html, url: pageUrl } = await this.fetchHtmlPage(`/course/view.php?id=${courseId}`);
    const identities = [
      ...html.matchAll(/(?:class|id)\s*=\s*["'][^"']*\bcourse-(\d+)\b[^"']*["']/gi),
      ...html.matchAll(/data-courseid\s*=\s*["'](\d+)["']/gi)
    ].map((match) => Number(match[1]));
    if (!identities.length || identities.some((id) => id !== courseId)) {
      throw new Error("Moodle returned a different or unverified course.");
    }
    if (!/(?:class\s*=\s*["'][^"']*\bcourse-content\b|data-region\s*=\s*["']section["']|<li[^>]+class\s*=\s*["'][^"']*\bactivity\b)/i.test(html)) {
      throw new Error("Unable to verify accessible course contents.");
    }
    const modules: MoodleRecord[] = [];
    const blockRegex = /<li[^>]+id=["']module-(\d+)["'][\s\S]*?<\/li>/gi;
    let m: RegExpExecArray | null;
    while ((m = blockRegex.exec(html)) !== null) {
      const block = m[0];
      const id = Number(m[1]);
      const nameMatch = /data-activityname=["']([^"']+)["']/i.exec(block) || /class=["'][^"']*activityname[^"']*["'][\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(block);
      const modnameMatch = /class=["'][^"']*\bmodtype_([^\s"']+)/i.exec(block);
      const urlMatch = /href=["']([^"']*(?:\/mod\/|\/view\.php)[^"']*)["']/i.exec(block);
      const name = nameMatch ? (nameMatch[1] || nameMatch[2] || "").replace(/<[^>]+>/g, "").trim() : "Activity";
      const contents = [...block.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>/gi)]
        .map((link) => fileRecord(link[2], pageUrl)).filter(Boolean);
      modules.push({
        id,
        course: courseId,
        name: decodeHtmlText(name),
        modname: modnameMatch?.[1] || (/\/mod\/([^/]+)\//i.exec(urlMatch?.[1] || "")?.[1]) || "resource",
        url: urlMatch ? new URL(urlMatch[1].replace(/&amp;/gi, "&"), pageUrl).toString() : "",
        contents
      });
    }

    // Moodle commonly exposes resource URLs only after opening the activity.
    for (let start = 0; start < modules.length; start += 4) {
      await Promise.all(modules.slice(start, start + 4).map(async (module) => {
        if (!["resource", "folder", "url"].includes(String(module.modname))) return;
        try {
          const activityUrl = new URL(String(module.url || `/mod/${module.modname}/view.php?id=${module.id}`), pageUrl);
          if (activityUrl.origin !== new URL(this.baseUrl).origin || !activityUrl.pathname.includes(`/mod/${module.modname}/`)) {
            throw new Error("Moodle returned an invalid activity URL.");
          }
          activityUrl.searchParams.set("forceview", "1");
          const page = await this.fetchHtmlPage(activityUrl.toString());
          const found = [...page.html.matchAll(/<(?:a|object|iframe)\b[^>]*(?:href|data|src)\s*=\s*(["'])(.*?)\1[^>]*>/gi)]
            .map((link) => fileRecord(link[2], page.url)).filter(Boolean);
          const unique = new Map((module.contents || []).map((item: MoodleRecord) => [item.fileurl, item]));
          for (const item of found) if (item) unique.set(item.fileurl, item);
          module.contents = [...unique.values()];
        } catch (error) {
          module.unavailable = { contents: String(error) };
        }
      }));
    }
    return [{ id: 0, name: "General", modules }];
  }

  private async fetchAssignmentsHtml(params: Record<string, any>): Promise<MoodleRecord> {
    const courseIds = [
      ...(Array.isArray(params.courseids) ? params.courseids : []),
      ...Object.entries(params).filter(([key]) => /^courseids\[\d+\]$/.test(key)).map(([, value]) => value)
    ].map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
    if (!courseIds.length) throw new Error("Assignment fallback requires at least one valid course ID.");
    const courses = [];
    for (const courseId of [...new Set(courseIds)]) {
      const sections = await this.fetchCourseContentsHtml(courseId);
      const modules = sections.flatMap((section) => section.modules || []).filter((module) => module.modname === "assign");
      const assignments = await Promise.all(modules.map(async (module) => {
        try {
          const activityUrl = new URL(String(module.url || `/mod/assign/view.php?id=${module.id}`), this.baseUrl);
          if (activityUrl.origin !== new URL(this.baseUrl).origin || !activityUrl.pathname.includes("/mod/assign/")) {
            throw new Error("Moodle returned an invalid assignment URL.");
          }
          activityUrl.searchParams.set("forceview", "1");
          const page = await this.fetchHtmlPage(activityUrl.toString());
          const bodyType = /<body\b[^>]*id=["']page-mod-([a-z0-9_]+)-/i.exec(page.html)?.[1];
          if (bodyType && bodyType !== "assign") throw new Error("Moodle returned a different activity type.");
          const instance = Number(
            /data-assignmentid=["'](\d+)["']/i.exec(page.html)?.[1] ||
            /<input\b[^>]*name=["'](?:assignid|assignmentid)["'][^>]*value=["'](\d+)["']/i.exec(page.html)?.[1] ||
            /itemmodule=assign(?:&amp;|&)iteminstance=(\d+)/i.exec(page.html)?.[1]
          );
          const intro = /<(?:div|section)\b[^>]*(?:id=["']intro["']|class=["'][^"']*\bactivity-description\b)[^>]*>([\s\S]*?)<\/(?:div|section)>/i.exec(page.html)?.[1] || module.description || "";
          const attachments = [...page.html.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>/gi)]
            .map((link) => fileRecord(link[2], page.url)).filter(Boolean);
          const timestamp = (field: string): number | undefined => {
            const match = new RegExp(`(?:data-${field}|name=["']${field}["'][^>]*value)=["'](\\d+)["']`, "i").exec(page.html);
            const value = Number(match?.[1]);
            return Number.isSafeInteger(value) && value > 0 ? value : undefined;
          };
          return {
            ...module,
            cmid: Number(module.id),
            ...(Number.isSafeInteger(instance) && instance > 0 ? { id: instance } : { unavailable: { instance: "Assignment instance ID unavailable." } }),
            intro,
            introattachments: attachments,
            // Moodle uses zero (not omission) to represent an undated assignment.
            duedate: timestamp("duedate") || 0,
            cutoffdate: timestamp("cutoffdate"),
            allowsubmissionsfromdate: timestamp("allowsubmissionsfromdate"),
            url: page.url
          };
        } catch (error) {
          return { ...module, cmid: Number(module.id), intro: module.description, unavailable: { details: String(error), instance: "Assignment instance ID unavailable." } };
        }
      }));
      courses.push({ id: courseId, assignments });
    }
    return { courses, warnings: [] };
  }

  private async fetchCourseModuleHtml(params: Record<string, any>): Promise<MoodleRecord> {
    const cmid = Number(params.cmid);
    if (!Number.isSafeInteger(cmid) || cmid <= 0) throw new Error("Invalid course module ID.");
    const requestedCourse = Number(params.courseid);
    const courses = Number.isSafeInteger(requestedCourse) && requestedCourse > 0
      ? [{ id: requestedCourse }]
      : await this.call<MoodleRecord[]>("core_enrol_get_users_courses");
    let module: MoodleRecord | undefined;
    for (const course of courses) {
      const courseId = Number(course.id);
      if (!Number.isSafeInteger(courseId) || courseId <= 0) continue;
      const sections = await this.fetchCourseContentsHtml(courseId);
      module = sections.flatMap((section) => section.modules || []).find((item) => Number(item.id) === cmid);
      if (module) break;
    }
    if (!module) throw new Error("Course module was not found in accessible courses.");

    if (module.modname === "assign") {
      const assignments = await this.fetchAssignmentsHtml({ courseids: [Number(module.course)] });
      const assignment = assignments.courses?.flatMap((course: MoodleRecord) => course.assignments || [])
        .find((item: MoodleRecord) => Number(item.cmid) === cmid);
      if (assignment) {
        const { id: instance, ...details } = assignment;
        return { cm: { ...module, ...details, ...(instance ? { instance } : {}) }, warnings: [] };
      }
    }

    if (module.modname === "forum") {
      const activityUrl = new URL(String(module.url || `/mod/forum/view.php?id=${cmid}`), this.baseUrl);
      if (activityUrl.origin !== new URL(this.baseUrl).origin || !activityUrl.pathname.includes("/mod/forum/")) {
        throw new Error("Moodle returned an invalid forum URL.");
      }
      activityUrl.searchParams.set("forceview", "1");
      const page = await this.fetchHtmlPage(activityUrl.toString());
      const contextId = Number(/"contextInstanceId"\s*:\s*(\d+)/i.exec(page.html)?.[1]);
      const courseId = Number(/"courseId"\s*:\s*(\d+)/i.exec(page.html)?.[1]);
      if (contextId && contextId !== cmid) throw new Error("Moodle returned a different course module.");
      if (courseId && courseId !== Number(module.course)) throw new Error("Moodle returned a different course.");
      const bodyType = /<body\b[^>]*id=["']page-mod-([a-z0-9_]+)-/i.exec(page.html)?.[1];
      if (bodyType && bodyType !== "forum") throw new Error("Moodle returned a different activity type.");
      const candidates = [
        ...page.html.matchAll(/data-forumid=["'](\d+)["']/gi),
        ...page.html.matchAll(/<input\b[^>]*name=["'](?:forum|forumid)["'][^>]*value=["'](\d+)["']/gi),
        ...page.html.matchAll(/\/mod\/forum\/[^"']*(?:[?&]|&amp;)(?:f|forum|forumid)=(\d+)/gi),
        ...page.html.matchAll(/\/mod\/forum\/subscribe\.php[^"']*(?:[?&]|&amp;)id=(\d+)/gi)
      ].map((match) => Number(match[1])).filter((id) => Number.isSafeInteger(id) && id > 0);
      const instance = candidates[0];
      module = {
        ...module,
        ...(instance ? { instance } : { unavailable: { instance: "The HTML page does not expose the forum instance ID." } }),
        type: /\bforumtype-([a-z0-9_-]+)/i.exec(page.html)?.[1]
      };
    }
    return { cm: module, warnings: [] };
  }

  async call<T = any>(name: string, params: Record<string, any> = {}): Promise<T> {
    if (name === "core_enrol_get_users_courses") {
      const courseMap = new Map<number, MoodleRecord>();
      const classifications = ["allincludinghidden", "all", "inprogress", "past", "future", "hidden"];
      const primary = (async (): Promise<MoodleRecord[] | null> => {
        try {
          const entries = await this.callRaw<unknown>(name, params);
          if (!Array.isArray(entries)) throw new Error("Moodle returned an invalid course list.");
          return entries;
        } catch (error) {
          if (unavailableSessionMethod(error)) return null;
          throw error;
        }
      })();
      const timelineGroups = classifications.map(async (classification) => {
        try {
          const collected: MoodleRecord[] = [];
          let offset = 0;
          for (let page = 0; page < 1000; page += 1) {
            const res = await this.callRaw<any>("core_course_get_enrolled_courses_by_timeline_classification", { classification, limit: 100, offset });
            const entries = Array.isArray(res) ? res : res?.courses;
            if (!Array.isArray(entries)) throw new Error("Moodle returned an invalid course list.");
            collected.push(...entries);
            const cursor = res?.nextoffset;
            let next: number;
            if (cursor == null) {
              if (entries.length < 100) break;
              next = offset + entries.length;
            } else {
              next = typeof cursor === "number" || (typeof cursor === "string" && /^-?\d+$/.test(cursor)) ? Number(cursor) : NaN;
              if (next === 0 || next === -1) break;
              // Moodle can echo the requested offset on an empty terminal page.
              if (next === offset && entries.length === 0) break;
            }
            if (!Number.isSafeInteger(next) || next <= offset) throw new Error(`Invalid or non-advancing course pagination for ${classification}.`);
            if (page === 999) throw new Error(`Course pagination exceeded the safety limit for ${classification}.`);
            offset = next;
          }
          return collected;
        } catch (error) {
          if (unavailableSessionMethod(error)) return null;
          throw error;
        }
      });
      const groups = await Promise.all([primary, ...timelineGroups]);
      if (groups.every((entries) => entries === null)) {
        throw new Error("Course discovery is unavailable for this UIT session.");
      }
      // Match Studio: primary enrolment metadata wins, then timeline buckets
      // fill any courses omitted from that source.
      for (const entries of groups) {
        if (!entries) continue;
        for (const item of entries) {
          const id = Number(item?.id);
          if (Number.isSafeInteger(id) && id > 0 && !courseMap.has(id)) {
            courseMap.set(id, {
              ...item,
              id,
              categoryname: item.coursecategory || item.categoryname || ""
            });
          }
        }
      }
      return [...courseMap.values()] as T;
    }

    if (name === "core_course_get_contents") {
      try {
        return await this.callRaw<T>(name, params);
      } catch (error) {
        if (!unavailableSessionMethod(error)) throw error;
        return await this.fetchCourseContentsHtml(Number(params.courseid)) as T;
      }
    }

    if (name === "mod_assign_get_assignments") {
      try {
        return await this.callRaw<T>(name, params);
      } catch (error) {
        if (!unavailableSessionMethod(error)) throw error;
        return await this.fetchAssignmentsHtml(params) as T;
      }
    }

    if (name === "core_course_get_course_module") {
      try {
        return await this.callRaw<T>(name, params);
      } catch (error) {
        if (!unavailableSessionMethod(error)) throw error;
        return await this.fetchCourseModuleHtml(params) as T;
      }
    }

    return this.callRaw<T>(name, params);
  }

  async downloadFile(fileUrl: string, destPath: string, options?: { atomic?: boolean }): Promise<{ sha256: string }> {
    return writeCourseFile(
      await fetchCourseFile(this.baseUrl, fileUrl, { Cookie: this.cookieHeader }),
      destPath,
      options
    );
  }

  async uploadFile(_filepath: string): Promise<MoodleRecord> {
    throw new Error("File uploads are not supported through SSO session yet. Please use 'uit login --legacy' with your Student ID/password or an existing Moodle API token.");
  }

  async readFile(fileUrl: string): Promise<{ data: Uint8Array; mimeType: string }> {
    return readCourseFile(
      await fetchCourseFile(this.baseUrl, fileUrl, { Cookie: this.cookieHeader })
    );
  }
}

export function createSessionApiClient(
  baseUrl: string,
  sesskey: string,
  cookies: Array<{ name: string; value: string }> | string
): ApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const cookieHeader = typeof cookies === "string" ? cookies : cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  return new NodeSessionApiClient(normalizedBaseUrl, sesskey, cookieHeader);
}

export function getActiveApiClient(): ApiClient {
  const authType = get("authType");
  if (authType === "sso") {
    const sesskey = get("sesskey");
    const cookies = get("cookies");
    if (sesskey && cookies) {
      return createSessionApiClient(get("baseUrl"), sesskey, cookies);
    }
  }
  return createTokenApiClient(get("baseUrl"), get("token"));
}

export const defaultApiClient: ApiClient = {
  call: (name, params) => getActiveApiClient().call(name, params),
  uploadFile: (filepath) => getActiveApiClient().uploadFile(filepath),
  downloadFile: (fileUrl, destPath, options) => getActiveApiClient().downloadFile(fileUrl, destPath, options),
  readFile: (fileUrl) => getActiveApiClient().readFile!(fileUrl)
};
