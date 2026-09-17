import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const STUDIO_THREAD_STORE_VERSION = 1;
const THREAD_STORE_FILE = "threads.json";
const MAX_THREAD_STORE_BYTES = 20 * 1024 * 1024;

export type StudioThreadStore = {
  version: 1;
  activeId: string | null;
  projects: unknown[];
  threads: unknown[];
  collapsed: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateThreadStore(value: unknown): StudioThreadStore {
  if (!isRecord(value) || value.version !== STUDIO_THREAD_STORE_VERSION || !Array.isArray(value.threads)) {
    throw new Error("Saved Studio threads are invalid.");
  }
  if (value.activeId !== null && value.activeId !== undefined && typeof value.activeId !== "string") {
    throw new Error("Saved Studio threads are invalid.");
  }
  if (value.projects !== undefined && !Array.isArray(value.projects)) throw new Error("Saved Studio threads are invalid.");
  if (value.collapsed !== undefined && (!Array.isArray(value.collapsed) || !value.collapsed.every((entry) => typeof entry === "string"))) {
    throw new Error("Saved Studio threads are invalid.");
  }
  return {
    version: 1,
    activeId: value.activeId === undefined ? null : value.activeId,
    projects: value.projects || [],
    threads: value.threads,
    collapsed: value.collapsed || []
  };
}

function threadStorePath(userDataPath: string): string {
  return join(userDataPath, THREAD_STORE_FILE);
}

export async function readStudioThreadStore(userDataPath: string): Promise<StudioThreadStore | null> {
  try {
    const serialized = await readFile(threadStorePath(userDataPath), "utf8");
    return validateThreadStore(JSON.parse(serialized));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("Saved Studio threads are invalid.", { cause: error });
    throw error;
  }
}

let writeQueue = Promise.resolve();

export async function writeStudioThreadStore(userDataPath: string, value: unknown): Promise<{ success: true }> {
  const store = validateThreadStore(value);
  const serialized = JSON.stringify(store);
  if (Buffer.byteLength(serialized, "utf8") > MAX_THREAD_STORE_BYTES) throw new Error("Saved Studio threads are too large.");
  const path = threadStorePath(userDataPath);
  const temporaryPath = `${path}.part`;
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    await mkdir(userDataPath, { recursive: true });
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  });
  await writeQueue;
  return { success: true };
}
