import { createWriteStream, mkdirSync, openAsBlob } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
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

export async function writeCourseFile(response: Response, destPath: string): Promise<void> {
  if (!response.body) throw new Error("Empty course file response.");
  mkdirSync(dirname(destPath) || ".", { recursive: true });
  const temporaryPath = `${destPath}.part-${randomUUID()}`;
  try {
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(temporaryPath, { flags: "wx" }));
    await rename(temporaryPath, destPath);
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

  const downloadWithToken = async (fileUrl: string, destPath: string): Promise<void> => {
    await writeCourseFile(await fetchCourseFile(normalizedBaseUrl, fileUrl, {}, token), destPath);
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

export async function downloadFile(fileUrl: string, destPath: string): Promise<void> {
  return defaultApiClient.downloadFile(fileUrl, destPath);
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
      body: info
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    return unwrapAjaxResponse(data) as T;
  }

  private async fetchCourseContentsHtml(courseId: number): Promise<MoodleRecord[]> {
    const res = await fetch(`${this.baseUrl}/course/view.php?id=${courseId}`, {
      headers: { Cookie: this.cookieHeader },
      signal: AbortSignal.timeout(30_000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const html = await res.text();
    const modules: MoodleRecord[] = [];
    const blockRegex = /<li[^>]+id=["']module-(\d+)["'][\s\S]*?<\/li>/gi;
    let m: RegExpExecArray | null;
    while ((m = blockRegex.exec(html)) !== null) {
      const block = m[0];
      const id = Number(m[1]);
      const nameMatch = /data-activityname=["']([^"']+)["']/i.exec(block) || /class=["'][^"']*activityname[^"']*["'][\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(block);
      const modnameMatch = /class=["'][^"']*(?:modtype_|activity\s+)([^\s"']+)/i.exec(block);
      const urlMatch = /href=["']([^"']*(?:\/mod\/|\/view\.php)[^"']*)["']/i.exec(block);
      const name = nameMatch ? (nameMatch[1] || nameMatch[2] || "").replace(/<[^>]+>/g, "").trim() : "Activity";
      modules.push({
        id,
        name,
        modname: modnameMatch ? modnameMatch[1] : "resource",
        url: urlMatch ? urlMatch[1] : "",
        contents: []
      });
    }
    return [{ id: 0, name: "General", modules }];
  }

  async call<T = any>(name: string, params: Record<string, any> = {}): Promise<T> {
    if (name === "core_enrol_get_users_courses") {
      const courseMap = new Map<number, MoodleRecord>();
      const classifications = ["all", "inprogress", "past", "future", "hidden"];
      const groups = await Promise.all(classifications.map(async (classification) => {
        try {
          const res = await this.callRaw<any>("core_course_get_enrolled_courses_by_timeline_classification", {
            classification,
            limit: 100,
            offset: 0
          });
          const entries = Array.isArray(res) ? res : res?.courses;
          return Array.isArray(entries) ? entries : [];
        } catch {
          // Continue to other classifications
          return [];
        }
      }));
      // Merge in classification order so the same source keeps precedence.
      for (const entries of groups) {
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
      } catch {
        return await this.fetchCourseContentsHtml(Number(params.courseid)) as T;
      }
    }

    if (name === "mod_assign_get_assignments") {
      try {
        return await this.callRaw<T>(name, params);
      } catch {
        return { courses: [], warnings: [] } as T;
      }
    }

    return this.callRaw<T>(name, params);
  }

  async downloadFile(fileUrl: string, destPath: string): Promise<void> {
    await writeCourseFile(
      await fetchCourseFile(this.baseUrl, fileUrl, { Cookie: this.cookieHeader }),
      destPath
    );
  }

  async uploadFile(_filepath: string): Promise<MoodleRecord> {
    throw new Error("File uploads are not supported through SSO session yet. Please use 'uit login --token <token>' with a Moodle API token.");
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
  downloadFile: (fileUrl, destPath) => getActiveApiClient().downloadFile(fileUrl, destPath),
  readFile: (fileUrl) => getActiveApiClient().readFile!(fileUrl)
};
