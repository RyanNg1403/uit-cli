import type { MoodleRecord } from "./types.js";

export function normalizeArgs(params: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(params)) {
    const match = /^(.*)\[(\d+)\]$/.exec(key);
    if (!match) {
      result[key] = value;
      continue;
    }
    const [, name, indexText] = match;
    const index = Number(indexText);
    const values = Array.isArray(result[name]) ? result[name] : [];
    values[index] = value;
    result[name] = values;
  }
  return result;
}

export function buildAjaxInfo(name: string, params: Record<string, any>): string {
  return JSON.stringify([{ index: 0, methodname: name, args: normalizeArgs(params) }]);
}

export function unwrapAjaxResponse(data: unknown): any {
  if (Array.isArray(data) && data.length === 0) throw new Error("Moodle returned an empty AJAX response");
  const first = (Array.isArray(data) ? data[0] : data) as MoodleRecord;
  if (!first || typeof first !== "object") throw new Error("Moodle returned an invalid AJAX response");
  if (first.error || first.errorcode || first.exception) {
    const exception = first.exception;
    const message = (exception && typeof exception === "object" ? exception.message : undefined) || first.message || exception;
    const error = new Error(String(message || "Moodle AJAX request failed")) as Error & { errorcode?: string };
    error.errorcode = exception?.errorcode || first.errorcode || (typeof exception === "string" ? exception : undefined);
    throw error;
  }
  if (!Array.isArray(data)) throw new Error("Moodle returned an invalid AJAX response");
  if (!("data" in first)) throw new Error("Moodle returned an AJAX response without data");
  return first.data;
}
