import type { MoodleRecord } from "./types.js";

export function normalizeArgs(params: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(params)) {
    const root = /^([^[\]]+)/.exec(key)?.[1];
    if (!root || root.length === key.length) {
      result[key] = value;
      continue;
    }
    const suffix = key.slice(root.length);
    const brackets = [...suffix.matchAll(/\[([^[\]]+)\]/g)];
    if (!brackets.length || brackets.map((match) => match[0]).join("") !== suffix) {
      result[key] = value;
      continue;
    }
    const path: Array<string | number> = [root, ...brackets.map((match) => /^\d+$/.test(match[1]) ? Number(match[1]) : match[1])];
    if (path.some((part) => typeof part === "string" && ["__proto__", "prototype", "constructor"].includes(part))) {
      Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
      continue;
    }
    let target: any = result;
    for (let index = 0; index < path.length; index += 1) {
      const part = path[index];
      if (index === path.length - 1) {
        target[part] = value;
        break;
      }
      const container = typeof path[index + 1] === "number" ? [] : {};
      if (!target[part] || typeof target[part] !== "object") target[part] = container;
      target = target[part];
    }
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
