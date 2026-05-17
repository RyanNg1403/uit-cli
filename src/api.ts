import { createWriteStream, mkdirSync, openAsBlob } from "node:fs";
import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get } from "./config.js";
import type { ApiClient, MoodleRecord } from "./types.js";

function apiUrl(): string {
  return `${get("baseUrl")}/webservice/rest/server.php`;
}

function appendParams(url: URL, params: Record<string, any>): void {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
}

export async function call<T = any>(name: string, params: Record<string, any> = {}): Promise<T> {
  const url = new URL(apiUrl());
  appendParams(url, {
    ...params,
    wstoken: get("token"),
    wsfunction: name,
    moodlewsrestformat: "json"
  });

  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const data = await response.json();
  if (data && typeof data === "object" && "exception" in data) {
    throw new Error(data.message || data.error || JSON.stringify(data));
  }
  return data as T;
}

export async function uploadFile(filepath: string): Promise<MoodleRecord> {
  const form = new FormData();
  form.append("token", get("token"));
  form.append("filearea", "draft");
  form.append("itemid", "0");
  form.append("file", await openAsBlob(filepath), basename(filepath));

  const response = await fetch(`${get("baseUrl")}/webservice/upload.php`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const data = await response.json();
  if (Array.isArray(data) && data.length > 0) return data[0];
  if (data && typeof data === "object" && "error" in data) throw new Error(String(data.error));
  return data as MoodleRecord;
}

export async function downloadFile(fileUrl: string, destPath: string): Promise<void> {
  const sep = fileUrl.includes("?") ? "&" : "?";
  const url = `${fileUrl}${sep}token=${encodeURIComponent(get("token"))}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  if (!response.body) throw new Error("empty response body");

  mkdirSync(dirname(destPath) || ".", { recursive: true });
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(destPath));
}

export const defaultApiClient: ApiClient = {
  call,
  uploadFile,
  downloadFile
};
