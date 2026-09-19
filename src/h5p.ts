import { extname } from "node:path";
import { credentialFreeUrl, MAX_PREVIEW_BYTES } from "./api.js";
import { clean, htmlToText } from "./output.js";
import type { ApiClient, MoodleRecord } from "./types.js";
import { readZipEntry } from "./unzip.js";

const MAX_H5P_JSON_BYTES = 5 * 1024 * 1024;
const MAX_H5P_TEXT_ITEMS = 1_000;
const MAX_H5P_MEDIA_ITEMS = 500;
const TEXT_KEYS = /^(?:alt|answer|caption|description|heading|label|question|taskDescription|text|title)$/i;
const MEDIA_EXTENSION_KIND = new Map<string, H5pMediaKind>([
  [".aac", "audio"], [".avi", "video"], [".gif", "image"], [".jpeg", "image"], [".jpg", "image"],
  [".m4a", "audio"], [".m4v", "video"], [".mov", "video"], [".mp3", "audio"], [".mp4", "video"],
  [".oga", "audio"], [".ogg", "audio"], [".ogv", "video"], [".pdf", "slides"], [".png", "image"],
  [".ppt", "slides"], [".pptx", "slides"], [".svg", "image"], [".wav", "audio"], [".webm", "video"],
  [".webp", "image"]
]);

export interface H5pPackageFile {
  filename: string;
  fileurl: string;
  filesize: number;
  filepath: string;
}

export interface H5pActivity {
  id?: number;
  coursemodule: number;
  name: string;
  description: string;
  files: H5pPackageFile[];
}

export type H5pMediaKind = "video" | "slides" | "audio" | "image" | "embed" | "link";

export interface H5pMediaReference {
  kind: H5pMediaKind;
  provider?: string;
  url?: string;
  packagePath?: string;
}

export interface H5pEntrySummary {
  position: number;
  title: string;
  text: string[];
  media: H5pMediaReference[];
}

export interface H5pContentSummary {
  title: string;
  mainLibrary?: string;
  entries: H5pEntrySummary[];
}

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} must be a positive integer.`);
  return id;
}

function packageFiles(value: unknown): H5pPackageFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): H5pPackageFile[] => {
    if (!raw || typeof raw !== "object") return [];
    const file = raw as MoodleRecord;
    const fileurl = credentialFreeUrl(file.fileurl);
    if (!fileurl) return [];
    return [{
      filename: clean(String(file.filename || "activity.h5p")),
      fileurl,
      filesize: Number(file.filesize) || 0,
      filepath: typeof file.filepath === "string" ? file.filepath : "/"
    }];
  });
}

export async function listH5pActivities(courseId: number, api: ApiClient): Promise<Map<number, H5pActivity>> {
  courseId = positiveId(courseId, "Course ID");
  const response = await api.call<MoodleRecord>("mod_h5pactivity_get_h5pactivities_by_courses", {
    "courseids[0]": courseId
  });
  if (!response || !Array.isArray(response.h5pactivities)) {
    throw new Error("Invalid H5P activity response: expected an activity list.");
  }
  const activities = new Map<number, H5pActivity>();
  for (const raw of response.h5pactivities) {
    const coursemodule = positiveId(raw?.coursemodule, "H5P course-module ID");
    if (activities.has(coursemodule)) throw new Error(`Moodle returned duplicate H5P activity ${coursemodule}.`);
    const id = Number(raw.id);
    activities.set(coursemodule, {
      id: Number.isSafeInteger(id) && id > 0 ? id : undefined,
      coursemodule,
      name: clean(String(raw.name || "H5P activity")),
      description: htmlToText(String(raw.intro || "")),
      files: packageFiles(raw.package)
    });
  }
  return activities;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function titleFrom(value: unknown): string {
  const item = record(value);
  if (!item) return "";
  const metadata = record(item.metadata);
  const params = record(item.params);
  for (const candidate of [metadata?.title, item.title, params?.title, params?.heading]) {
    if (typeof candidate !== "string") continue;
    const title = htmlToText(candidate).trim();
    if (title) return title;
  }
  return "";
}

function providerFor(url: string): string | undefined {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  const isHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (host === "youtu.be" || isHost("youtube.com")) return "YouTube";
  if (isHost("drive.google.com") || isHost("docs.google.com")) return "Google Drive";
  if (isHost("vimeo.com")) return "Vimeo";
  return undefined;
}

function kindFromExtension(value: string): H5pMediaKind | undefined {
  let pathname = value.split(/[?#]/, 1)[0];
  try { pathname = new URL(value).pathname; }
  catch { /* Package paths are intentionally relative URLs. */ }
  return MEDIA_EXTENSION_KIND.get(extname(pathname).toLowerCase());
}

function mediaKind(library: string, title: string, value: string, provider?: string): H5pMediaKind {
  if (/\bvideo\b/i.test(library) || provider === "YouTube" || provider === "Vimeo") return "video";
  if (/\baudio\b/i.test(library)) return "audio";
  if (/\bimage\b/i.test(library)) return "image";
  const extensionKind = kindFromExtension(value);
  if (extensionKind) return extensionKind;
  if (/^slides?$/i.test(title.trim())) return "slides";
  if (/iframe|embed/i.test(library)) return "embed";
  return "link";
}

function packagePath(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!kindFromExtension(normalized) || normalized.split("/").some((segment) => segment === "..")) return undefined;
  return normalized.startsWith("content/") ? normalized : `content/${normalized}`;
}

function sectionNodes(content: Record<string, unknown>): unknown[] {
  if (Array.isArray(content.chapters) && content.chapters.length) return content.chapters;
  const presentation = record(content.presentation);
  if (Array.isArray(presentation?.slides) && presentation.slides.length) return presentation.slides;
  if (Array.isArray(content.slides) && content.slides.length) return content.slides;
  return [content];
}

function summarizeEntry(value: unknown, position: number, fallbackTitle: string): H5pEntrySummary {
  const title = titleFrom(value) || fallbackTitle;
  const text = new Set<string>();
  const media = new Map<string, H5pMediaReference>();

  const visit = (current: unknown, inheritedTitle: string, inheritedLibrary: string): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item, inheritedTitle, inheritedLibrary);
      return;
    }
    const item = record(current);
    if (!item) return;
    const localTitle = titleFrom(item) || inheritedTitle;
    const localLibrary = typeof item.library === "string" ? item.library : inheritedLibrary;
    for (const [key, child] of Object.entries(item)) {
      if (typeof child === "string") {
        const decoded = clean(child).trim();
        const url = credentialFreeUrl(decoded);
        if (url && media.size < MAX_H5P_MEDIA_ITEMS) {
          const provider = providerFor(url);
          const kind = mediaKind(localLibrary, title, url, provider);
          media.set(`${kind}\0${url}`, { kind, provider, url });
          continue;
        }
        const path = packagePath(decoded);
        if (path && media.size < MAX_H5P_MEDIA_ITEMS) {
          const kind = mediaKind(localLibrary, title, path);
          media.set(`${kind}\0${path}`, { kind, packagePath: path });
          continue;
        }
        if (TEXT_KEYS.test(key) && text.size < MAX_H5P_TEXT_ITEMS) {
          const readable = htmlToText(child);
          if (readable && readable !== localTitle) text.add(readable);
        }
      } else visit(child, localTitle, localLibrary);
    }
  };
  visit(value, title, "");
  return { position, title, text: [...text], media: [...media.values()] };
}

export function parseH5pPackage(data: Uint8Array): H5pContentSummary {
  const archive = Buffer.from(data);
  const contentEntry = readZipEntry(archive, "content/content.json", MAX_H5P_JSON_BYTES);
  if (!contentEntry) throw new Error("The H5P package does not contain content/content.json.");
  let content: unknown;
  try { content = JSON.parse(contentEntry.toString("utf8")); }
  catch (error) { throw new Error("The H5P content metadata is invalid JSON.", { cause: error }); }
  const contentRecord = record(content);
  if (!contentRecord) throw new Error("The H5P content metadata must be an object.");

  let manifest: Record<string, unknown> | undefined;
  const manifestEntry = readZipEntry(archive, "h5p.json", MAX_H5P_JSON_BYTES);
  if (manifestEntry) {
    try { manifest = record(JSON.parse(manifestEntry.toString("utf8"))); }
    catch (error) { throw new Error("The H5P package manifest is invalid JSON.", { cause: error }); }
  }
  const title = typeof manifest?.title === "string" ? htmlToText(manifest.title) : titleFrom(contentRecord) || "H5P activity";
  const mainLibrary = typeof manifest?.mainLibrary === "string" ? manifest.mainLibrary : undefined;
  return {
    title,
    mainLibrary,
    entries: sectionNodes(contentRecord).map((entry, index) => summarizeEntry(entry, index + 1, `Section ${index + 1}`))
  };
}

export async function readH5pActivity(courseId: number, moduleId: number, api: ApiClient): Promise<{
  activity: H5pActivity;
  content: H5pContentSummary;
}> {
  courseId = positiveId(courseId, "Course ID");
  moduleId = positiveId(moduleId, "Module ID");
  const activity = (await listH5pActivities(courseId, api)).get(moduleId);
  if (!activity) throw new Error(`H5P module ${moduleId} was not found in the selected course.`);
  const candidates = activity.files.filter((file) => extname(file.filename).toLowerCase() === ".h5p");
  if (candidates.length !== 1) throw new Error(`H5P module ${moduleId} must expose exactly one package.`);
  const packageFile = candidates[0];
  if (packageFile.filesize > MAX_PREVIEW_BYTES) throw new Error("H5P metadata reading is limited to 25 MB.");
  if (!api.readFile) throw new Error("This UIT session does not support authenticated H5P metadata reading.");
  const result = await api.readFile(packageFile.fileurl);
  if (result.data.byteLength > MAX_PREVIEW_BYTES) throw new Error("H5P metadata reading is limited to 25 MB.");
  return { activity, content: parseH5pPackage(result.data) };
}
