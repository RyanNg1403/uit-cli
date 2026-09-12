import { createWriteStream, mkdirSync, openAsBlob } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get } from "./config.js";
import { buildAjaxInfo, normalizeArgs, unwrapAjaxResponse } from "./ajax-helpers.js";
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

function parseHtmlTimestamp(fragment: string | undefined): number {
  if (!fragment) return 0;
  const attribute = /(?:data-(?:timestamp|timecreated|timemodified)|datetime)\s*=\s*["']([^"']+)["']/i.exec(fragment)?.[1];
  const value = attribute || decodeHtmlText(fragment);
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function htmlAttribute(fragment: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(fragment)?.[2];
}

/** Extract balanced elements for the small set of Moodle containers we read. */
function htmlBlocks(html: string, tag: string, predicate: (attributes: string) => boolean = () => true): string[] {
  const tokens = new RegExp(`<(/?)${tag}\\b([^>]*)>`, "gi");
  const blocks: string[] = [];
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(html)) !== null) {
    if (token[1] || !predicate(token[2])) continue;
    if (/\/\s*>$/.test(token[0])) {
      blocks.push(token[0]);
      continue;
    }
    const start = token.index;
    let depth = 1;
    let nested: RegExpExecArray | null;
    while ((nested = tokens.exec(html)) !== null) {
      if (nested[1]) depth -= 1;
      else if (!/\/\s*>$/.test(nested[0])) depth += 1;
      if (depth === 0) {
        blocks.push(html.slice(start, tokens.lastIndex));
        break;
      }
    }
  }
  return blocks;
}

function htmlText(fragment: string | undefined): string {
  return decodeHtmlText(fragment || "");
}

function htmlVisibleText(fragment: string | undefined): string {
  if (!fragment) return "";
  const hidden = /<(?:span|div|img|a|i)\b[^>]*class=["'][^"']*\b(?:userinitials|userpicture|sr-only|accesshide)\b[^"']*["'][^>]*>[\s\S]*?<\/(?:span|div|a|i)>/gi;
  return htmlText(fragment.replace(hidden, ""));
}

function courseIdsFromParams(params: Record<string, any>): number[] {
  const normalized = normalizeArgs(params);
  const values = [
    ...(Array.isArray(normalized.courseids) ? normalized.courseids : []),
    ...Object.entries(params).filter(([key]) => /^courseids\[\d+\]$/.test(key)).map(([, value]) => value)
  ];
  return [...new Set(values.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function hasSubmissionFormError(html: string): boolean {
  return /(?:class\s*=\s*["'][^"']*\b(?:form-error|validationerror|notifyproblem|alert-danger|errorbox)\b[^"']*["']|aria-invalid\s*=\s*["']true["']|data-field-error\s*=)/i.test(html);
}

function fileRecord(rawUrl: string, pageUrl: string): MoodleRecord | undefined {
  try {
    const url = new URL(rawUrl, pageUrl);
    if (url.origin !== new URL(pageUrl).origin || !/(?:token)?pluginfile\.php(?:\/|$)|\/mod_forum\/attachment(?:\/|$)/i.test(url.pathname)) return undefined;
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
    const moduleBlocks = htmlBlocks(html, "li", (attributes) => /^module-\d+$/.test(htmlAttribute(attributes, "id") || ""));
    for (const block of moduleBlocks) {
      const id = Number((htmlAttribute(block, "id") || "").replace(/^module-/, ""));
      if (!Number.isSafeInteger(id) || id <= 0 || modules.some((module) => module.id === id)) continue;
      const nameMatch = /data-activityname=["']([^"']+)["']/i.exec(block) || /class=["'][^"']*activityname[^"']*["'][\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(block);
      const modnameMatch = /class=["'][^"']*\bmodtype_([^\s"']+)/i.exec(block);
      const urlMatch = /href=["']([^"']*(?:\/mod\/|\/view\.php)[^"']*)["']/i.exec(block);
      const name = nameMatch ? htmlVisibleText(nameMatch[1] || nameMatch[2]) : "Activity";
      const contents = [...block.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>/gi)]
        .map((link) => fileRecord(link[2], pageUrl)).filter(Boolean);
      modules.push({
        id,
        course: courseId,
        name: name || "Activity",
        modname: modnameMatch?.[1] || (/\/mod\/([^/]+)\//i.exec(urlMatch?.[1] || "")?.[1]) || "resource",
        url: urlMatch ? new URL(urlMatch[1].replace(/&amp;/gi, "&"), pageUrl).toString() : "",
        description: htmlVisibleText(/class=["'][^"']*\b(?:contentwithoutlink|activity-description)\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i.exec(block)?.[1]),
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
    if (!courseIds.length) return { courses: [], warnings: [] };
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

  private async fetchForumActivityHtml(module: MoodleRecord): Promise<MoodleRecord> {
    const activityUrl = new URL(String(module.url || ("/mod/forum/view.php?id=" + module.id)), this.baseUrl);
    if (activityUrl.origin !== new URL(this.baseUrl).origin || !activityUrl.pathname.includes("/mod/forum/")) {
      throw new Error("Moodle returned an invalid forum URL.");
    }
    activityUrl.searchParams.set("forceview", "1");
    const page = await this.fetchHtmlPage(activityUrl.toString());
    const contextId = Number(/"contextInstanceId"\s*:\s*(\d+)/i.exec(page.html)?.[1] || /data-cmid\s*=\s*["'](\d+)["']/i.exec(page.html)?.[1]);
    const courseId = Number(/"courseId"\s*:\s*(\d+)/i.exec(page.html)?.[1]);
    if (contextId && contextId !== Number(module.id)) throw new Error("Moodle returned a different course module.");
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
    return {
      ...module,
      ...(instance ? { instance } : { unavailable: { instance: "The HTML page does not expose the forum instance ID." } }),
      type: /\bforumtype-([a-z0-9_-]+)/i.exec(page.html)?.[1]
    };
  }

  private async fetchForumsHtml(params: Record<string, any>): Promise<MoodleRecord[]> {
    const courseIds = courseIdsFromParams(params);
    if (!courseIds.length) return [];
    const forums: MoodleRecord[] = [];
    for (const courseId of courseIds) {
      const sections = await this.fetchCourseContentsHtml(courseId);
      const modules = sections.flatMap((section) => section.modules || []).filter((module) => module.modname === "forum");
      for (const module of modules) {
        let activity: MoodleRecord;
        try {
          activity = await this.fetchForumActivityHtml(module);
        } catch (error) {
          activity = { ...module, unavailable: { details: String(error), instance: "Forum instance ID unavailable." } };
        }
        const { id: cmid, instance, ...details } = activity;
        forums.push({ ...details, cmid, ...(instance ? { id: instance } : {}), unavailable: activity.unavailable });
      }
    }
    return forums;
  }

  private async fetchForumDiscussionsHtml(params: Record<string, any>): Promise<MoodleRecord> {
    const forumId = Number(params.forumid);
    const cmid = Number(params.cmid);
    const page = Number(params.page ?? 0);
    const perpage = Number(params.perpage ?? 100);
    const byId = params.forumid !== undefined;
    const byModule = !byId && params.cmid !== undefined;
    if (byId && !(Number.isSafeInteger(forumId) && forumId > 0)) throw new Error("Invalid forum pagination or instance ID.");
    if (byModule && !(Number.isSafeInteger(cmid) && cmid > 0)) throw new Error("Invalid forum pagination or instance ID.");
    if (!byId && !byModule) throw new Error("Invalid forum pagination or instance ID.");
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(perpage) || perpage <= 0 || perpage > 100) {
      throw new Error("Invalid forum pagination or instance ID.");
    }
    const path = byModule
      ? "/mod/forum/view.php?id=" + cmid + "&forceview=1&p=" + page + "&s=" + perpage
      : "/mod/forum/view.php?f=" + forumId + "&p=" + page + "&s=" + perpage;
    const { html, url: pageUrl } = await this.fetchHtmlPage(path);
    if (!/(?:discussion-list|forumheaderlist|forumnodiscuss|forumpost)/i.test(html)) {
      throw new Error("Unable to read forum discussions.");
    }
    if (byModule) {
      const contextId = Number(/"contextInstanceId"\s*:\s*(\d+)/i.exec(html)?.[1] || /data-cmid\s*=\s*["'](\d+)["']/i.exec(html)?.[1]);
      if (contextId && contextId !== cmid) throw new Error("Moodle returned a different course module.");
    }
    const rowPredicate = (attributes: string): boolean => {
      const classes = htmlAttribute(attributes, "class") || "";
      return /\bdiscussion\b/i.test(classes) || htmlAttribute(attributes, "data-region") === "discussion-list-item";
    };
    const rows = [
      ...htmlBlocks(html, "tr", rowPredicate),
      ...htmlBlocks(html, "li", rowPredicate),
      ...htmlBlocks(html, "article", rowPredicate),
      ...htmlBlocks(html, "div", rowPredicate)
    ];
    const discussions: MoodleRecord[] = [];
    const seen = new Set<number>();
    for (const row of rows) {
      const linkMatch = /<a\b[^>]*href\s*=\s*(["'])([^"']*(?:discuss\.php|[?&]d=)[^"']*)\1[^>]*>([\s\S]*?)<\/a>/i.exec(row);
      const rowDiscussion = Number(htmlAttribute(row, "data-discussionid"));
      let discussionUrl: URL | undefined;
      if (linkMatch) {
        try {
          const candidate = new URL(linkMatch[2].replace(/&amp;/gi, "&"), pageUrl);
          if (candidate.origin === new URL(this.baseUrl).origin && candidate.pathname.includes("/mod/forum/")) discussionUrl = candidate;
        } catch { /* Ignore malformed discussion links. */ }
      }
      const discussion = rowDiscussion || Number(discussionUrl?.searchParams.get("d"));
      if (!Number.isSafeInteger(discussion) || discussion <= 0 || seen.has(discussion)) continue;
      const rowForum = Number(htmlAttribute(row, "data-forumid"));
      if (byId && rowForum && rowForum !== forumId) throw new Error("Moodle returned a different forum.");
      seen.add(discussion);
      const title = linkMatch ? htmlAttribute(linkMatch[0], "title") : undefined;
      const times = [...row.matchAll(/<time\b[^>]*>[\s\S]*?<\/time>/gi)]
        .map((match) => parseHtmlTimestamp(match[0])).filter((value) => value > 0);
      const authorMatch = /<([a-z0-9]+)\b[^>]*data-region=["']author-name["'][^>]*>([\s\S]*?)<\/\1>/i.exec(row) ||
        /<a\b[^>]*href=["'][^"']*\/user\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(row);
      const repliesMatch = /<([a-z0-9]+)\b[^>]*class=["'][^"']*\breplies\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i.exec(row) ||
        /<td\b[^>]*class=["'][^"']*\btext-center\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i.exec(row);
      const count = Number(htmlText(repliesMatch?.[2] || repliesMatch?.[1]));
      const cleanUrl = credentialFreeUrl(discussionUrl?.toString() || new URL("/mod/forum/discuss.php?d=" + discussion, pageUrl).toString());
      discussions.push({
        discussion,
        name: htmlText(title || (linkMatch ? linkMatch[3] : "")),
        ...(cleanUrl ? { url: cleanUrl } : {}),
        userfullname: htmlText(authorMatch?.[2] || authorMatch?.[1]),
        ...(times[0] ? { created: times[0] } : {}),
        ...(times.length ? { timemodified: times[times.length - 1] } : {}),
        ...(repliesMatch && Number.isFinite(count) ? { numreplies: count } : {})
      });
    }
    for (let start = 0; start < discussions.length; start += 4) {
      await Promise.all(discussions.slice(start, start + 4).map(async (discussion) => {
        if (!discussion.url) return;
        try {
          const detail = await this.fetchHtmlPage(discussion.url);
          const firstPosts = htmlBlocks(detail.html, "div", (attributes) => {
            const classes = htmlAttribute(attributes, "class") || "";
            return /\bforumpost\b/i.test(classes) && /\b(?:firstpost|starter)\b/i.test(classes);
          });
          const posts = [
            ...firstPosts,
            ...htmlBlocks(detail.html, "article", (attributes) => htmlAttribute(attributes, "data-region") === "post"),
            ...htmlBlocks(detail.html, "div", (attributes) => /\bforumpost\b/i.test(htmlAttribute(attributes, "class") || ""))
          ];
          const post = posts[0];
          const messageMatch = post && /<([a-z0-9]+)\b[^>]*(?:data-region=["']post-content["']|class=["'][^"']*\b(?:post-content-container|posting|fullpost)\b[^"']*)[^>]*>([\s\S]*?)<\/\1>/i.exec(post);
          if (!post || !messageMatch) throw new Error("Unable to read the discussion opening post.");
          const subjectMatch = /<([a-z0-9]+)\b[^>]*(?:data-region=["']post-title["']|data-region-content=["']forum-post-core-subject["']|class=["'][^"']*\bsubject\b[^"']*)[^>]*>([\s\S]*?)<\/\1>/i.exec(post);
          const authorMatch = /<([a-z0-9]+)\b[^>]*data-region=["']author-name["'][^>]*>([\s\S]*?)<\/\1>/i.exec(post) ||
            /<a\b[^>]*href=["'][^"']*\/user\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(post);
          const created = parseHtmlTimestamp(/<time\b[^>]*>[\s\S]*?<\/time>/i.exec(post)?.[0]);
          const collectFiles = (fragment: string, includeImages = true): MoodleRecord[] => {
            const element = includeImages ? "(?:a|img|object|iframe)" : "(?:a|object|iframe)";
            return [...fragment.matchAll(new RegExp(`<${element}\\b[^>]*(?:href|src|data)\\s*=\\s*(["'])(.*?)\\1[^>]*>`, "gi"))]
              .map((match) => fileRecord(match[2].replace(/&amp;/gi, "&"), detail.url)).filter(Boolean) as MoodleRecord[];
          };
          // Moodle's modern theme marks attachments with a dedicated region,
          // while older themes render plain file links after the post body.
          // Exclude images when scanning the whole post so the author's avatar
          // is never mistaken for a downloadable attachment.
          const attachmentRegions = [
            ...htmlBlocks(post, "div", (attributes) => htmlAttribute(attributes, "data-region") === "attachment" || /\b(?:attachments|attachedimages)\b/i.test(htmlAttribute(attributes, "class") || "")),
            ...htmlBlocks(post, "ul", (attributes) => /\b(?:attachments|attachedimages)\b/i.test(htmlAttribute(attributes, "class") || ""))
          ];
          const attachmentSource = attachmentRegions.join(" ") || post.replace(messageMatch[2], "");
          Object.assign(discussion, {
            ...(subjectMatch ? { subject: htmlText(subjectMatch[2]) } : {}),
            message: messageMatch[2],
            userfullname: htmlText(authorMatch?.[2] || authorMatch?.[1] || discussion.userfullname),
            ...(created ? { created } : {}),
            attachments: collectFiles(attachmentSource, false),
            messageinlinefiles: collectFiles(messageMatch[2])
          });
        } catch (error) {
          discussion.unavailable = { message: String(error) };
        }
      }));
    }
    return { discussions, warnings: [] };
  }

  private async fetchParticipantsHtml(courseId: number): Promise<MoodleRecord[]> {
    if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new Error("Invalid course ID.");
    const { html, url: pageUrl } = await this.fetchHtmlPage("/user/index.php?id=" + courseId + "&perpage=5000");
    if (!/<table\b[^>]*(?:id=["']participants["']|class=["'][^"']*\bgeneraltable\b)[^>]*>/i.test(html)) {
      throw new Error("Unable to read course participants.");
    }
    const users: MoodleRecord[] = [];
    const seen = new Set<number>();
    for (const row of htmlBlocks(html, "tr")) {
      // Restrict identity links to Moodle's user profile route. Header and
      // sorting links also carry `id=`, but refer to the course/table itself.
      const linkMatch = /<a\b[^>]*href\s*=\s*(["'])([^"']*\/user\/view\.php[^"']*)\1[^>]*>([\s\S]*?)<\/a>/i.exec(row);
      let id = 0;
      if (linkMatch) {
        try {
          const url = new URL(linkMatch[2].replace(/&amp;/gi, "&"), pageUrl);
          if (url.origin === new URL(this.baseUrl).origin) id = Number(url.searchParams.get("id")) || 0;
        } catch { /* Ignore malformed participant links. */ }
      }
      if (!id) {
        const checkbox = /<input\b[^>]*(?:id|name)\s*=\s*(["'])[^"']*user(\d+)[^"']*\1[^>]*>/i.exec(row);
        id = Number(checkbox?.[2]) || 0;
      }
      const roleCell = /<([a-z0-9]+)\b[^>]*(?:data-cell=["']roles["']|class=["'][^"']*\b(?:c2|roles)\b[^"']*)[^>]*>([\s\S]*?)<\/\1>/i.exec(row);
      const nameCell = /<([a-z0-9]+)\b[^>]*(?:data-cell=["']username["']|class=["'][^"']*\bc1\b[^"']*)[^>]*>([\s\S]*?)<\/\1>/i.exec(row);
      const name = htmlVisibleText(linkMatch?.[3] || nameCell?.[2]);
      // Header/sort rows can have a c1 cell but no user identity. Never emit
      // a synthetic participant for those rows.
      if (!name || (!linkMatch && !id) || (id && seen.has(id))) continue;
      if (id) seen.add(id);
      const roleText = htmlText(roleCell?.[2]);
      const avatar = /<img\b[^>]*class=["'][^"']*\buserpicture\b[^"']*["'][^>]*src\s*=\s*(["'])(.*?)\1/i.exec(row)?.[2];
      const user: MoodleRecord = {
        id: id || users.length + 1,
        fullname: name,
        roles: roleText ? [{ shortname: roleText.toLowerCase(), name: roleText }] : [{ shortname: "student", name: "Học viên" }]
      };
      if (avatar) {
        try {
          const avatarUrl = credentialFreeUrl(new URL(avatar.replace(/&amp;/gi, "&"), pageUrl).toString());
          if (avatarUrl) user.profileimageurl = avatarUrl;
        } catch { /* Ignore malformed avatar URLs. */ }
      }
      const groupCell = /<([a-z0-9]+)\b[^>]*(?:data-cell=["']groups["']|class=["'][^"']*\b(?:c3|groups)\b[^"']*)[^>]*>([\s\S]*?)<\/\1>/i.exec(row);
      const groupText = htmlText(groupCell?.[2]);
      if (groupText && !/^(?:-|No groups|Không phân nhóm)$/i.test(groupText)) user.groups = [{ name: groupText }];
      const accessCell = /<([a-z0-9]+)\b[^>]*(?:data-cell=["']lastaccess["']|class=["'][^"']*\b(?:c4|lastaccess)\b[^"']*)[^>]*>([\s\S]*?)<\/\1>/i.exec(row);
      const accessText = htmlText(accessCell?.[2]);
      if (accessText) user.lastaccess = accessText;
      users.push(user);
    }
    return users;
  }

  private async fetchGradesHtml(courseId: number): Promise<MoodleRecord> {
    if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new Error("Invalid course ID.");
    const { html } = await this.fetchHtmlPage("/grade/report/user/index.php?id=" + courseId);
    if (!/<table\b[^>]*class=["'][^"']*(?:user-grade|generaltable)\b/i.test(html)) {
      throw new Error("Unable to read the grade report.");
    }
    const gradeitems: MoodleRecord[] = [];
    for (const row of htmlBlocks(html, "tr")) {
      const nameCell = /<([a-z0-9]+)\b[^>]*class=["'][^"']*\bcolumn-itemname\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i.exec(row) ||
        /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(row);
      const itemname = htmlVisibleText(nameCell?.[2] || nameCell?.[1]);
      if (!itemname) continue;
      const cell = (name: string): string => {
        const cells = htmlBlocks(row, "td", (attributes) => (htmlAttribute(attributes, "class") || "").split(/\s+/).includes(name));
        return htmlText(cells[0]);
      };
      const grade = cell("column-grade") || "-";
      const range = cell("column-range");
      const percentage = cell("column-percentage") || "-";
      const feedback = cell("column-feedback");
      gradeitems.push({
        itemname,
        gradeformatted: grade !== "-" ? grade : undefined,
        grademax: range || undefined,
        percentageformatted: percentage !== "-" ? percentage : undefined,
        feedback: feedback || undefined
      });
    }
    return { usergrades: [{ courseid: courseId, gradeitems }] };
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

    if (name === "core_enrol_get_enrolled_users") {
      try {
        return await this.callRaw<T>(name, params);
      } catch (error) {
        if (!unavailableSessionMethod(error)) throw error;
        return await this.fetchParticipantsHtml(Number(params.courseid)) as T;
      }
    }

    if (name === "gradereport_user_get_grade_items") {
      try {
        return await this.callRaw<T>(name, params);
      } catch (error) {
        if (!unavailableSessionMethod(error)) throw error;
        return await this.fetchGradesHtml(Number(params.courseid)) as T;
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

    if (name === "mod_forum_get_forums_by_courses") {
      try {
        return await this.callRaw<T>(name, params);
      } catch (error) {
        if (!unavailableSessionMethod(error)) throw error;
        return await this.fetchForumsHtml(params) as T;
      }
    }

    if (name === "mod_forum_get_forum_discussions") {
      try {
        return await this.callRaw<T>(name, params);
      } catch (error) {
        if (!unavailableSessionMethod(error)) throw error;
        return await this.fetchForumDiscussionsHtml(params) as T;
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

    if (name === "mod_assign_save_submission") {
      try {
        return await this.callRaw<T>(name, params);
      } catch (error) {
        if (!unavailableSessionMethod(error)) throw error;
        return (await this.saveSubmissionHtml(params)) as T;
      }
    }

    if (name === "mod_assign_get_submission_status") {
      try {
        return await this.callRaw<T>(name, params);
      } catch (error) {
        if (!unavailableSessionMethod(error)) throw error;
        return (await this.fetchSubmissionStatusHtml(params)) as T;
      }
    }

    return this.callRaw<T>(name, params);
  }

  private async resolveAssignmentModule(assignId: number): Promise<{ cmid: number; courseId: number; url: string }> {
    const courses = await this.call<MoodleRecord[]>("core_enrol_get_users_courses");
    for (const course of courses) {
      const courseId = Number(course.id);
      if (!Number.isSafeInteger(courseId) || courseId <= 0) continue;
      const res = await this.fetchAssignmentsHtml({ courseids: [courseId] });
      for (const c of res.courses || []) {
        for (const a of c.assignments || []) {
          if (Number(a.id) === assignId || Number(a.cmid) === assignId) {
            return { cmid: Number(a.cmid || a.id), courseId, url: String(a.url || "") };
          }
        }
      }
    }
    throw new Error(`Assignment ${assignId} was not found in accessible courses.`);
  }

  private async postHtmlForm(path: string, body: URLSearchParams): Promise<{ html: string; url: string }> {
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin) throw new Error("Course page belongs to another origin.");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Cookie: this.cookieHeader,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000)
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location") || "";
      if (/\/login(?:\/|$)/i.test(new URL(location, url).pathname)) {
        throw new Error("UIT session expired. Please sign in again.");
      }
      const destination = new URL(location, url);
      if (destination.origin !== url.origin) throw new Error("Moodle form redirected to another origin.");
      return { html: "", url: destination.toString() };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const html = await res.text();
    return { html, url: url.toString() };
  }

  private async saveSubmissionHtml(params: Record<string, any>): Promise<MoodleRecord> {
    const assignId = Number(params.assignmentid || params.assignid);
    if (!Number.isSafeInteger(assignId) || assignId <= 0) throw new Error("Invalid assignment ID.");
    const fileManagerId = params["plugindata[files_filemanager]"] ?? params.files_filemanager ?? params.itemid;
    if (!fileManagerId) throw new Error("No submission files specified.");
    const { cmid } = await this.resolveAssignmentModule(assignId);
    const editPath = `/mod/assign/view.php?id=${cmid}&action=editsubmission`;
    const { html } = await this.fetchHtmlPage(editPath);

    const body = new URLSearchParams();
    body.set("id", String(cmid));
    body.set("sesskey", this.sesskey);
    body.set("action", "savesubmission");
    body.set("submitbutton", "Save changes");
    body.set("files_filemanager", String(fileManagerId));

    const inputMatches = [...html.matchAll(/<input\b[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi)];
    for (const match of inputMatches) {
      const name = match[1];
      const val = match[2];
      if (name.startsWith("_qf__") || name === "mform_isexpanded_id_general") {
        body.set(name, val);
      }
    }

    const response = await this.postHtmlForm(`/mod/assign/view.php?id=${cmid}`, body);
    const responseUrl = new URL(response.url, `${this.baseUrl}/`);
    if (
      responseUrl.origin !== new URL(this.baseUrl).origin ||
      responseUrl.pathname !== "/mod/assign/view.php" ||
      responseUrl.searchParams.get("id") !== String(cmid)
    ) {
      throw new Error("Moodle returned an unexpected submission response.");
    }
    const responseHtml = response.html || (await this.fetchHtmlPage(responseUrl.toString())).html;
    if (hasSubmissionFormError(responseHtml)) {
      throw new Error("Moodle rejected the submission. Check the assignment requirements and try again.");
    }
    return { status: true, warnings: [] };
  }

  private async fetchSubmissionStatusHtml(params: Record<string, any>): Promise<MoodleRecord> {
    const assignId = Number(params.assignid || params.assignmentid);
    if (!Number.isSafeInteger(assignId) || assignId <= 0) throw new Error("Invalid assignment ID.");
    const { cmid } = await this.resolveAssignmentModule(assignId);
    const { html } = await this.fetchHtmlPage(`/mod/assign/view.php?id=${cmid}`);

    let status = "none";
    if (/submissionstatussubmitted|class=["'][^"']*\bsubmitted\b/i.test(html) || /Đã nộp để chấm điểm|Submitted for grading/i.test(html)) {
      status = "submitted";
    } else if (/submissionstatusdraft|class=["'][^"']*\bdraft\b/i.test(html) || /Bản nháp|Draft \(not submitted\)/i.test(html)) {
      status = "draft";
    }

    const modifiedMatch = /id=["'](?:mod_assign_submission_timemodified|submissionmodified)["'][^>]*>([\s\S]*?)<\/td>/i.exec(html);
    const gradeMatch = /id=["'](?:mod_assign_feedback_grade|feedbackgrade)["'][^>]*>([\s\S]*?)<\/td>/i.exec(html);

    return {
      lastattempt: {
        submission: {
          status,
          timemodified: parseHtmlTimestamp(modifiedMatch?.[1])
        }
      },
      feedback: {
        grade: gradeMatch ? { grade: decodeHtmlText(gradeMatch[1]) } : undefined
      },
      warnings: []
    };
  }

  async downloadFile(fileUrl: string, destPath: string, options?: { atomic?: boolean }): Promise<{ sha256: string }> {
    return writeCourseFile(
      await fetchCourseFile(this.baseUrl, fileUrl, { Cookie: this.cookieHeader }),
      destPath,
      options
    );
  }

  async uploadFile(filepath: string): Promise<MoodleRecord> {
    const filename = basename(filepath);
    const blob = await openAsBlob(filepath);
    const draftId = Math.floor(Math.random() * 899999999 + 100000000);

    const tryUpload = async (repoId: string): Promise<MoodleRecord | null> => {
      const form = new FormData();
      form.append("sesskey", this.sesskey);
      form.append("repo_id", repoId);
      form.append("itemid", String(draftId));
      form.append("repo_upload_file", blob, filename);
      form.append("title", filename);

      const response = await fetch(`${this.baseUrl}/repository/repository_ajax.php?action=upload`, {
        method: "POST",
        headers: { Cookie: this.cookieHeader },
        body: form,
        signal: AbortSignal.timeout(120_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const data = (await response.json()) as MoodleRecord;
      if (data?.errorcode === "invalidrepositoryid") return null;
      if (data?.error) throw new Error(String(data.error));
      return data;
    };

    let data = await tryUpload("5");
    if (!data) {
      const { html } = await this.fetchHtmlPage("/user/files.php");
      const match =
        /"id"\s*:\s*"(\d+)"[^}]*"type"\s*:\s*"upload"/i.exec(html) ||
        /"type"\s*:\s*"upload"[^}]*"id"\s*:\s*"(\d+)"/i.exec(html);
      const discoveredRepoId = match?.[1] || "4";
      data = await tryUpload(discoveredRepoId);
      if (!data) throw new Error("Could not find a valid Moodle upload repository.");
    }

    const itemid = Number(data.id ?? draftId);
    return {
      itemid,
      filename: data.file || filename,
      url: data.url,
      ...data
    };
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
