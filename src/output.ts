let jsonMode = false;

export class CliError extends Error {
  readonly hint?: string;
  readonly exitCode: number;

  constructor(message: string, hint = "", exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.hint = hint || undefined;
    this.exitCode = exitCode;
  }
}

export function setJsonMode(value: boolean): void {
  jsonMode = value;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export function die(message: string, hint = ""): never {
  throw new CliError(message, hint);
}

export function writeError(error: unknown): number {
  if (error instanceof CliError) {
    const payload: Record<string, string> = { error: error.message };
    if (error.hint) payload.hint = error.hint;
    if (jsonMode) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.error(`Error: ${error.message}`);
      if (error.hint) console.error(`Hint:  ${error.hint}`);
    }
    return error.exitCode;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (jsonMode) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  return 1;
}

export function out(data: unknown): void {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (typeof data === "string") {
    console.log(data);
  } else if (Array.isArray(data)) {
    for (const row of data) console.log(row);
  } else if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(data)) console.log(`${key}: ${value}`);
  }
}

export function table(rows: Record<string, any>[], columns: [string, string, number][]): void {
  if (jsonMode) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("(no results)");
    return;
  }
  const header = columns.map(([, label, width]) => label.padEnd(width)).join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of rows) {
    const parts = columns.map(([key, , width], index) => {
      let value = String(row[key] ?? "");
      const isLast = index === columns.length - 1;
      if (!isLast && value.length > width) value = `${value.slice(0, width - 1)}…`;
      return value.padEnd(width);
    });
    console.log(parts.join("  "));
  }
}

const htmlEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " "
};

export function clean(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return htmlEntities[entity] ?? match;
  });
}

export function htmlToText(html: string): string {
  if (!html) return "";
  let text = html;
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "  - ");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = clean(text);
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function extractUrls(html: string): string[] {
  if (!html) return [];
  return Array.from(html.matchAll(/href="([^"]+)"/g), (match) => match[1]);
}

export function ts(epoch: number): string {
  if (!epoch) return "";
  const date = new Date(epoch * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function sanitize(name: string): string {
  return Array.from(name)
    .map((char) => (/^[\p{L}\p{N} ._-]$/u.test(char) ? char : "_"))
    .join("")
    .trim();
}

export function loading(message: string): void {
  if (!jsonMode) console.error(`\u001b[2m${message}\u001b[0m`);
}

export function parseMoodleUrl(value: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (parsed.pathname.includes("discuss.php")) {
    const discussion = parsed.searchParams.get("d");
    if (discussion && /^\d+$/.test(discussion)) return Number.parseInt(discussion, 10);
  }
  const id = parsed.searchParams.get("id");
  if (id && /^\d+$/.test(id)) return Number.parseInt(id, 10);
  return undefined;
}

export function idOrUrl(value: string): number {
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  const parsed = parseMoodleUrl(value);
  if (parsed !== undefined) return parsed;
  throw new Error(`expected an integer ID or Moodle URL, got: ${value}`);
}
