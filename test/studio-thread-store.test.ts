import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStudioThreadStore, writeStudioThreadStore } from "../src/studio-thread-store.js";

describe("Studio thread store", () => {
  it("persists and restores the complete renderer-owned state atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uit-studio-thread-store-"));
    const store = {
      version: 2,
      activeId: "thread-1",
      projects: [{ id: 42, baseUrl: "https://courses.uit.edu.vn", userId: 7 }],
      threads: [{ id: "thread-1", title: "Thread 1", threadId: "codex-thread-1", prompted: true, resources: [], messages: [{ role: "user", text: "Hello" }] }],
      collapsed: ["https://courses.uit.edu.vn|7|42"]
    };
    try {
      await expect(readStudioThreadStore(directory)).resolves.toBeNull();
      await expect(writeStudioThreadStore(directory, store)).resolves.toEqual({ success: true });
      await expect(readStudioThreadStore(directory)).resolves.toEqual(store);
      await expect(stat(join(directory, "threads.json"))).resolves.toBeTruthy();
      await expect(readFile(join(directory, "threads.json.part"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed state instead of writing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uit-studio-thread-store-"));
    try {
      await expect(writeStudioThreadStore(directory, { version: 2, projects: [], threads: "not-an-array", collapsed: [] })).rejects.toThrow("invalid");
      await expect(writeStudioThreadStore(directory, { version: 1, projects: [], threads: [], collapsed: [] })).rejects.toThrow("invalid");
      await writeFile(join(directory, "threads.json"), "{invalid-json");
      await expect(readStudioThreadStore(directory)).rejects.toThrow("invalid");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
